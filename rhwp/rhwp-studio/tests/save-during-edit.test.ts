import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

import { SaveSession, type SaveOutcome } from '../src/command/save-session.ts';
import { DocumentDirtyState } from '../src/core/document-dirty-state.ts';
import { EventBus } from '../src/core/event-bus.ts';
import { AutosaveManager } from '../src/recovery/autosave-manager.ts';
import { createTestModuleServer } from './support/module-server.ts';

const rootDir = fileURLToPath(new URL('..', import.meta.url));

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function tick(ms = 0): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('SaveSession은 겹친 저장 요청 20개를 한 번의 실행과 최대 한 번의 후속 실행으로 합친다', async () => {
  const session = new SaveSession();
  let dirty = true;
  let edits = 0;
  let running = 0;
  let maxRunning = 0;
  let runs = 0;
  const gates: Array<ReturnType<typeof deferred>> = [];
  const run = async (): Promise<SaveOutcome> => {
    runs += 1;
    running += 1;
    maxRunning = Math.max(maxRunning, running);
    const token = edits;
    const gate = deferred();
    gates.push(gate);
    await gate.promise;
    running -= 1;
    if (edits === token) dirty = false;
    return 'saved';
  };

  const requests = Array.from({ length: 20 }, () => session.save(run, () => dirty));
  assert.equal(await session.exclusive(async () => 'saved'), 'busy', '진행 중에는 다른 이름 저장을 받지 않는다');
  await tick();
  assert.equal(runs, 1);
  // 저장이 파일을 쓰는 동안 편집이 들어왔다.
  edits += 1;
  gates[0].resolve();
  await tick();
  assert.equal(runs, 2, '편집이 남았으면 후속 저장을 한 번 더 실행한다');
  gates[1].resolve();
  assert.deepEqual(new Set(await Promise.all(requests)), new Set(['saved']));
  assert.equal(maxRunning, 1);
  assert.equal(runs, 2);

  // 끝난 뒤 문서가 clean 이면 후속 저장 없이 결과만 공유한다.
  const again = [session.save(run, () => dirty), session.save(run, () => dirty)];
  await tick();
  gates[2].resolve();
  assert.deepEqual(await Promise.all(again), ['saved', 'saved']);
  assert.equal(runs, 3);
});

test('SaveSession은 취소·실패한 저장을 반복하지 않고 예외 뒤에도 잠기지 않는다', async () => {
  const session = new SaveSession();
  let runs = 0;
  const gate = deferred();
  const cancelled = session.save(async () => {
    runs += 1;
    await gate.promise;
    return 'cancelled';
  }, () => true);
  const waiter = session.save(async () => {
    runs += 1;
    return 'saved';
  }, () => true);
  gate.resolve();
  assert.equal(await cancelled, 'cancelled');
  assert.equal(await waiter, 'cancelled', '취소된 저장 대화상자를 곧바로 다시 띄우지 않는다');
  assert.equal(runs, 1);

  const originalError = console.error;
  console.error = () => {};
  try {
    assert.equal(await session.save(() => { throw new Error('boom'); }, () => true), 'failed');
  } finally {
    console.error = originalError;
  }
  assert.equal(await session.exclusive(async () => 'saved'), 'saved', '예외 뒤에도 다음 저장을 받는다');
});

type FileCommandsModule = typeof import('../src/command/commands/file.ts');

function createSaveHarness() {
  const eventBus = new EventBus();
  const documentState = new DocumentDirtyState(eventBus);
  const writes: Array<{ version: number; gate: ReturnType<typeof deferred> }> = [];
  let exportedVersion = 0;
  let activeWrites = 0;
  let maxActiveWrites = 0;
  let documentVersion = 1;
  const handle = {
    kind: 'file' as const,
    name: 'doc.hwpx',
    async getFile() {
      return new File(['fixture'], 'doc.hwpx');
    },
    async createWritable() {
      let version = -1;
      return {
        async write(blob: Blob) {
          const bytes = new Uint8Array(await blob.arrayBuffer());
          version = bytes[4];
        },
        async close() {
          activeWrites += 1;
          maxActiveWrites = Math.max(maxActiveWrites, activeWrites);
          const gate = deferred();
          writes.push({ version, gate });
          await gate.promise;
          activeWrites -= 1;
        },
      };
    },
  };
  const services = {
    eventBus,
    documentState,
    wasm: {
      fileName: 'doc.hwpx',
      currentFileHandle: handle,
      isNewDocument: false,
      getSourceFormat: () => 'hwpx',
      exportHwpx: () => {
        exportedVersion = documentVersion;
        // HWPX(ZIP) 시그니처 뒤에 문서 버전을 넣어 어떤 바이트가 기록됐는지 확인한다.
        return new Uint8Array([0x50, 0x4b, 0x03, 0x04, documentVersion]);
      },
      exportHwp: () => new Uint8Array(),
      exportHml: () => new Uint8Array(),
    },
    getContext: () => ({ hasDocument: true, isDirty: documentState.isDirty() }),
    getInputHandler: () => null,
  };
  const edit = (reason: string) => {
    documentVersion += 1;
    documentState.markDirty(reason);
    eventBus.emit('document-changed', reason);
  };
  return {
    eventBus,
    documentState,
    services,
    writes,
    edit,
    get exportedVersion() { return exportedVersion; },
    get maxActiveWrites() { return maxActiveWrites; },
  };
}

async function withFileCommands(run: (mod: FileCommandsModule) => Promise<void>) {
  const previousWindow = (globalThis as { window?: unknown }).window;
  (globalThis as { window?: unknown }).window = { addEventListener() {}, removeEventListener() {} };
  const vite = await createTestModuleServer(rootDir);
  try {
    await run(await vite.ssrLoadModule('/src/command/commands/file.ts') as FileCommandsModule);
  } finally {
    await vite.close();
    (globalThis as { window?: unknown }).window = previousWindow;
  }
}

test('저장이 파일을 쓰는 동안 들어온 편집은 dirty·자동 저장 draft로 남는다', async () => {
  await withFileCommands(async ({ saveCurrentDocument }) => {
    const harness = createSaveHarness();
    const deleted: string[] = [];
    const drafts: number[] = [];
    const autosave = new AutosaveManager({
      exportBytes: () => new Uint8Array([harness.exportedVersion]),
      debounceMs: 5,
      minSaveIntervalMs: 60_000,
      idFactory: () => 'draft-1',
      store: {
        async saveDraft(draft) { drafts.push(draft.savedAt); },
        async deleteDraft(id) { deleted.push(id); },
      },
      logger: { debug() {}, warn() {} },
    });
    const disconnect = autosave.connect(harness.eventBus);
    try {
      await autosave.beginDocument({ fileName: 'doc.hwpx', sourceFormat: 'hwpx' });
      harness.edit('typing');
      const saving = saveCurrentDocument(harness.services as never);
      await tick();
      assert.equal(harness.writes.length, 1, '첫 저장이 파일을 쓰는 중');

      // Ctrl+S 직후 이어서 입력한 글자.
      harness.edit('typing-after-save');
      const draftsBefore = drafts.length;
      harness.writes[0].gate.resolve();
      assert.equal(await saving, 'saved');

      assert.equal(harness.documentState.isDirty(), true, '파일에 없는 편집이 있으면 dirty를 유지한다');
      assert.deepEqual(deleted, [], '자동 저장 draft를 지우면 안 된다');
      await tick(30);
      assert.ok(drafts.length > draftsBefore, '예약된 자동 저장이 취소되지 않아야 한다');
    } finally {
      disconnect();
    }
  });
});

test('겹친 Ctrl+S는 쓰기를 겹치지 않고 마지막 기록이 최신 문서다', async () => {
  await withFileCommands(async ({ saveCurrentDocument }) => {
    const harness = createSaveHarness();
    harness.edit('typing');
    const first = saveCurrentDocument(harness.services as never);
    await tick();
    harness.edit('typing-during-save');
    const repeats = Array.from({ length: 5 }, () => saveCurrentDocument(harness.services as never));
    await tick();
    assert.equal(harness.writes.length, 1, '진행 중인 저장과 겹쳐 쓰지 않는다');

    harness.writes[0].gate.resolve();
    await tick();
    assert.equal(harness.writes.length, 2, '편집이 남았으므로 후속 저장이 한 번 실행된다');
    harness.writes[1].gate.resolve();

    assert.deepEqual(await Promise.all([first, ...repeats]), Array(6).fill('saved'));
    assert.equal(harness.maxActiveWrites, 1);
    assert.deepEqual(harness.writes.map((write) => write.version), [2, 3]);
    assert.equal(harness.documentState.isDirty(), false);
  });
});
