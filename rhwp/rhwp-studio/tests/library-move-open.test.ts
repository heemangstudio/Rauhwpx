import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

import { EventBus } from '../src/core/event-bus.ts';
import { DocumentDirtyState } from '../src/core/document-dirty-state.ts';
import { documentSourceDigest } from '../src/recent/document-preflight.ts';
import { createTestModuleServer } from './support/module-server.ts';

/**
 * 채팅을 따라 다른 문서로 옮길 때(runLibraryMove) 대상 문서를 실제로 연다.
 * 찾은 파일을 열지 않고 'moved' 를 돌려주면 사이드바는 문서가 바뀌기를 끝없이 기다린다.
 */

const rootDir = fileURLToPath(new URL('..', import.meta.url));

type FileCommandsModule = typeof import('../src/command/commands/file.ts');
type RecentStoreModule = typeof import('../src/recent/recent-store.ts');

async function withModules(run: (file: FileCommandsModule, recents: RecentStoreModule) => Promise<void>) {
  const scope = globalThis as { window?: unknown; BroadcastChannel?: unknown };
  const previousWindow = scope.window;
  const previousChannel = scope.BroadcastChannel;
  scope.window = { addEventListener() {}, removeEventListener() {} };
  // 최근 기록의 창 사이 알림 채널은 테스트 프로세스를 끝나지 않게 붙든다.
  scope.BroadcastChannel = undefined;
  const vite = await createTestModuleServer(rootDir);
  try {
    await run(
      await vite.ssrLoadModule('/src/command/commands/file.ts') as FileCommandsModule,
      await vite.ssrLoadModule('/src/recent/recent-store.ts') as RecentStoreModule,
    );
  } finally {
    await vite.close();
    scope.window = previousWindow;
    scope.BroadcastChannel = previousChannel;
  }
}

function fileHandle(name: string, bytes: Uint8Array) {
  return {
    kind: 'file' as const,
    name,
    async getFile() { return new File([bytes], name); },
    async queryPermission() { return 'granted' as const; },
  };
}

/** 깨끗한 현재 문서. 열기 요청은 기록하고, 편집기처럼 open-document-bytes:done 으로 답한다. */
function services(reply: { ok: boolean; cancelled?: boolean }) {
  const eventBus = new EventBus();
  const opened: Array<{ fileName: string; skipUnsavedGuard?: boolean; grant?: unknown }> = [];
  eventBus.on('open-document-bytes', (payload) => {
    const data = payload as { fileName: string; requestId: string; skipUnsavedGuard?: boolean; grant?: unknown };
    opened.push({ fileName: data.fileName, skipUnsavedGuard: data.skipUnsavedGuard, grant: data.grant });
    queueMicrotask(() => eventBus.emit('open-document-bytes:done', { requestId: data.requestId, ...reply }));
  });
  return {
    opened,
    services: {
      eventBus,
      documentState: new DocumentDirtyState(eventBus),
      wasm: { fileName: '지금.hwpx' },
      getContext: () => ({ hasDocument: true, isDirty: false }),
      getInputHandler: () => null,
    },
  };
}

test('다른 문서로 옮기면 최근 기록에서 찾은 파일을 그 문서로 연다', async () => {
  await withModules(async ({ runLibraryMove }, { addRecentDoc, clearRecentDocs }) => {
    await clearRecentDocs();
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const row = await addRecentDoc({
      fileName: '대상.hwpx',
      sourceFormat: 'hwpx',
      sourceDigest: documentSourceDigest(bytes),
      handle: fileHandle('대상.hwpx', bytes) as never,
    });
    const harness = services({ ok: true });

    const result = await runLibraryMove(
      harness.services as never,
      { documentId: row.documentId, fileName: '대상.hwpx' },
      () => 'current-doc',
    );

    assert.equal(result, 'moved');
    assert.deepEqual(harness.opened, [{
      fileName: '대상.hwpx',
      skipUnsavedGuard: true,
      grant: { kind: 'verified', documentId: row.documentId },
    }]);
  });
});

test('찾은 파일을 열지 못하면 옮긴 것으로 치지 않는다', async () => {
  await withModules(async ({ runLibraryMove }, { addRecentDoc, clearRecentDocs }) => {
    for (const [reply, expected] of [
      [{ ok: false, cancelled: true }, 'cancelled'],
      [{ ok: false }, 'failed'],
    ] as const) {
      await clearRecentDocs();
      const bytes = new Uint8Array([5, 6, 7, expected.length]);
      const row = await addRecentDoc({
        fileName: '대상.hwpx',
        sourceFormat: 'hwpx',
        sourceDigest: documentSourceDigest(bytes),
        handle: fileHandle('대상.hwpx', bytes) as never,
      });
      const harness = services(reply);
      const result = await runLibraryMove(
        harness.services as never,
        { documentId: row.documentId, fileName: '대상.hwpx' },
        () => 'current-doc',
      );
      assert.equal(harness.opened.length, 1);
      assert.equal(result, expected);
    }
  });
});
