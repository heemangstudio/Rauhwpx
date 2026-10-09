// 저장 경로의 데이터 손실 방지 계약.
//
// 실제 file 명령 모듈을 Vite SSR 로 불러오고, 엔진·파일 handle·입력 처리기만 가짜로 둔다.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

import { DocumentDirtyState } from '../src/core/document-dirty-state.ts';
import { EventBus } from '../src/core/event-bus.ts';
import { createTestModuleServer } from './support/module-server.ts';

type FileCommandsModule = typeof import('../src/command/commands/file.ts');

const rootDir = fileURLToPath(new URL('..', import.meta.url));
let vite: Awaited<ReturnType<typeof createTestModuleServer>>;
let fileCommands: FileCommandsModule;
const savedGlobals: Record<string, unknown> = {};

/** 어떤 속성·호출도 받아 주는 느슨한 DOM 값. 저장 완료 토스트를 조용히 흘려보낸다. */
function anything(): any {
  return new Proxy(function noop() {}, {
    get: (_target, key) => {
      if (key === 'then') return undefined;
      if (key === Symbol.toPrimitive) return () => '';
      if (key === Symbol.iterator) return function* empty() {};
      if (key === 'length') return 0;
      return anything();
    },
    set: () => true,
    apply: () => anything(),
    construct: () => anything(),
  });
}

before(async () => {
  const g = globalThis as Record<string, unknown>;
  for (const key of ['window', 'document', 'alert', 'requestAnimationFrame']) savedGlobals[key] = g[key];
  g.window = { addEventListener() {}, removeEventListener() {}, innerWidth: 1024 };
  g.document = new Proxy({}, {
    get: (_target, key) => (key === 'getElementById' || key === 'querySelector' ? () => null : anything()),
  });
  g.alert = () => {};
  g.requestAnimationFrame = () => 0;
  vite = await createTestModuleServer(rootDir);
  fileCommands = await vite.ssrLoadModule('/src/command/commands/file.ts') as FileCommandsModule;
});

after(async () => {
  await vite?.close();
  const g = globalThis as Record<string, unknown>;
  for (const [key, value] of Object.entries(savedGlobals)) g[key] = value;
});

/** 같은 handle 에 저장하는 열린 문서. 쓰기와 export 순서를 기록한다. */
function saveHarness(inputHandler: unknown, fileName = 'doc.hwpx', failClose = false, withHandle = true) {
  const events: string[] = [];
  const eventBus = new EventBus();
  const documentState = new DocumentDirtyState(eventBus);
  documentState.markDirty('typing');
  const handle = {
    kind: 'file' as const,
    name: fileName,
    async getFile() { return new File(['fixture'], fileName); },
    async createWritable() {
      return {
        async write(blob: Blob) { events.push(`write:${(await blob.arrayBuffer()).byteLength}`); },
        async close() {
          events.push('close');
          if (failClose) throw new Error('disk full');
        },
        async abort() { events.push('abort'); },
      };
    },
  };
  const services = {
    eventBus,
    documentState,
    wasm: {
      fileName,
      currentFileHandle: withHandle ? handle : null,
      isNewDocument: false,
      getSourceFormat: () => 'hwpx',
      exportHwpx: () => {
        events.push('export');
        return new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
      },
      exportHwp: () => new Uint8Array(),
      exportHml: () => new Uint8Array(),
    },
    getContext: () => ({ hasDocument: true, isDirty: documentState.isDirty() }),
    getInputHandler: () => inputHandler,
    createPortableHistoryBundle: async () => {
      events.push('bundle');
      return { bytes: new Uint8Array(7), fileName };
    },
  };
  eventBus.on('document-saved', () => events.push('document-saved'));
  eventBus.on('document-file-handle-saved', (saved) => {
    events.push((saved as { fileHandle: unknown }).fileHandle === handle ? 'handle-saved' : 'handle-saved:other');
  });
  return { events, services, documentState };
}

test('저장은 지연된 페이지네이션을 마감한 뒤에만 문서를 내보낸다', async () => {
  let pending = true;
  const h = saveHarness({
    flushDeferredPaginationIfNeeded(reason: string) {
      h.events.push(`flush:${reason}`);
      pending = false;
    },
    hasDeferredPaginationPending: () => pending,
  });

  assert.equal(await fileCommands.saveCurrentDocument(h.services as never), 'saved');
  assert.deepEqual(h.events, ['flush:save', 'export', 'write:4', 'close', 'document-saved', 'handle-saved']);
  assert.equal(h.documentState.isDirty(), false);
});

test('페이지네이션이 끝나지 않으면 저장을 중단하고 파일을 건드리지 않는다', async () => {
  const h = saveHarness({
    flushDeferredPaginationIfNeeded(reason: string) { h.events.push(`flush:${reason}`); },
    hasDeferredPaginationPending: () => true,
  });
  const originalError = console.error;
  console.error = () => {};
  try {
    assert.equal(await fileCommands.saveCurrentDocument(h.services as never), 'failed');
  } finally {
    console.error = originalError;
  }
  assert.deepEqual(h.events, ['flush:save']);
  assert.equal(h.documentState.isDirty(), true, '저장되지 않은 편집은 dirty 로 남는다');
});

const idleInput = { flushDeferredPaginationIfNeeded() {}, hasDeferredPaginationPending: () => false };

test('.rhwpx 문서 저장은 전체 기록 묶음을 같은 파일에 다 쓴 뒤에만 저장 완료로 표시한다', async () => {
  const ok = saveHarness(idleInput, 'doc.rhwpx');
  assert.equal(await fileCommands.saveCurrentDocument(ok.services as never), 'saved');
  assert.deepEqual(ok.events, ['bundle', 'write:7', 'close', 'document-saved', 'handle-saved']);
  assert.equal(ok.documentState.isDirty(), false);

  const failed = saveHarness(idleInput, 'doc.rhwpx', true);
  const originalError = console.error;
  console.error = () => {};
  try {
    assert.equal(await fileCommands.saveCurrentDocument(failed.services as never), 'failed');
  } finally {
    console.error = originalError;
  }
  assert.equal(failed.events.includes('document-saved'), false);
  assert.equal(failed.documentState.isDirty(), true, '쓰기에 실패한 기록 파일은 dirty 로 남는다');
});

/** 다운로드 대체 경로가 만든 object URL 을 센다. */
async function countDownloads(run: () => Promise<unknown>): Promise<number> {
  const originalCreate = URL.createObjectURL;
  const originalError = console.error;
  let downloads = 0;
  URL.createObjectURL = () => { downloads += 1; return 'blob:test'; };
  console.error = () => {};
  try {
    await run();
  } finally {
    URL.createObjectURL = originalCreate;
    console.error = originalError;
  }
  return downloads;
}

test('같은 파일 쓰기가 실패하면 다운로드로 바꾸지 않고 실패와 dirty 로 남긴다', async () => {
  const h = saveHarness(idleInput, 'doc.hwpx', true);
  let result: unknown;
  const downloads = await countDownloads(async () => {
    result = await fileCommands.saveCurrentDocument(h.services as never);
  });
  assert.equal(result, 'failed');
  assert.equal(downloads, 0);
  assert.equal(h.events.includes('document-saved'), false);
  assert.equal(h.documentState.isDirty(), true);
});

test('파일 handle 로 저장한 경우에만 그 handle 을 문서와 연결한다', async () => {
  const withHandle = saveHarness(idleInput);
  assert.equal(await fileCommands.saveCurrentDocument(withHandle.services as never), 'saved');
  assert.ok(withHandle.events.includes('handle-saved'));

  const download = saveHarness(idleInput, 'doc.hwpx', false, false);
  let result: unknown;
  const downloads = await countDownloads(async () => {
    result = await fileCommands.saveCurrentDocument(download.services as never);
  });
  assert.equal(result, 'saved');
  assert.equal(downloads, 1);
  assert.equal(download.events.some((event) => event.startsWith('handle-saved')), false);
});
