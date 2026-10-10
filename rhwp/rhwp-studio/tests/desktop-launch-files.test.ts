import test from 'node:test';
import assert from 'node:assert/strict';

import {
  deliveredGeneratedDocumentIds,
  deliveredLaunchHandleIds,
  installDesktopFileHandling,
  installDesktopGeneratedDocumentHandling,
  type NativeFileHandleDescriptor,
} from '../src/desktop-integration.ts';

function launchFile(handleId: string, name: string): NativeFileHandleDescriptor {
  return { kind: 'file', handleId, name };
}

/** 데스크톱이 페이지를 다시 불러올 때처럼 시작 파일을 시작 조회와 이벤트로 함께 보낸다. */
function fakeDesktop(launchFiles: NativeFileHandleDescriptor[]) {
  let listener: ((files: NativeFileHandleDescriptor[]) => void) | undefined;
  const win = {
    rhwpDesktop: {
      readNativeFile: async () => ({ name: 'unused.hwp', bytes: new Uint8Array() }),
      writeNativeFile: async () => ({ ok: true }),
      onOpenFiles: (callback: (files: NativeFileHandleDescriptor[]) => void) => { listener = callback; },
      getLaunchFiles: async () => launchFiles,
    },
  };
  return { win: win as never, send: (files: NativeFileHandleDescriptor[]) => listener?.(files) };
}

async function settle(): Promise<void> {
  for (let index = 0; index < 4; index += 1) await Promise.resolve();
}

test('a page reopened by engine-trap recovery does not open the launch file over the recovered document', async () => {
  const desktop = fakeDesktop([launchFile('launch-1', '보고서.hwp')]);
  const opened: string[] = [];
  installDesktopFileHandling(
    (handles) => opened.push(...handles.map((handle) => handle.name)),
    desktop.win,
    { skipHandleIds: ['launch-1'] },
  );
  await settle();
  desktop.send([launchFile('launch-1', '보고서.hwp')]);
  assert.deepEqual(opened, [], 'the file the trapped page already handled stays closed');

  desktop.send([launchFile('launch-2', '새 파일.hwp')]);
  assert.deepEqual(opened, ['새 파일.hwp'], 'a file opened afterwards still opens');
  assert.ok(deliveredLaunchHandleIds().includes('launch-1'), 'the next recovery keeps skipping it');
  assert.ok(deliveredLaunchHandleIds().includes('launch-2'));
});

test('without a recovery list the launch file opens once, as before', async () => {
  const desktop = fakeDesktop([launchFile('launch-3', '계획서.hwpx')]);
  const opened: string[] = [];
  installDesktopFileHandling((handles) => opened.push(...handles.map((handle) => handle.name)), desktop.win);
  await settle();
  desktop.send([launchFile('launch-3', '계획서.hwpx')]);
  assert.deepEqual(opened, ['계획서.hwpx']);
});

test('a generated document the trapped page already opened is not opened again after recovery', async () => {
  const payload = {
    launchDocumentId: 'generated-1',
    fileName: '생성.hwpx',
    bytes: new Uint8Array([0x50, 0x4b, 0x03, 0x04]),
    readOnly: false,
  };
  let listener: ((value: typeof payload) => void) | undefined;
  const opened: string[] = [];
  installDesktopGeneratedDocumentHandling(
    ({ fileName }) => opened.push(fileName),
    {
      rhwpDesktop: {
        onOpenGeneratedDocument: (callback: (value: typeof payload) => void) => { listener = callback; },
        getLaunchGeneratedDocument: async () => payload,
      },
    } as never,
    { skipLaunchDocumentIds: ['generated-1'] },
  );
  await settle();
  listener?.(payload);
  assert.deepEqual(opened, []);
  listener?.({ ...payload, launchDocumentId: 'generated-2' });
  assert.deepEqual(opened, ['생성.hwpx']);
  assert.deepEqual(
    deliveredGeneratedDocumentIds().filter((id) => id.startsWith('generated-')).sort(),
    ['generated-1', 'generated-2'],
  );
});
