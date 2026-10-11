import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { NativeFileHandleRegistry } from '../desktop/native-file-handles.mjs';

function scratch() {
  return mkdtempSync(join(tmpdir(), 'rhwp-home-'));
}

/** 창 window-1 에서 파일을 열고 문서 doc-1 의 위치로 기억한 뒤 핸들을 놓는다(닫은 문서). */
async function remembered(dir, name, bytes = [1, 2, 3], documentId = 'doc-1') {
  const path = join(dir, name);
  writeFileSync(path, Buffer.from(bytes));
  const registry = new NativeFileHandleRegistry();
  await rememberIn(registry, path, documentId);
  return { registry, path };
}

async function rememberIn(registry, path, documentId) {
  const created = await registry.create('window-1', path);
  assert.equal(created.ok, true);
  registry.rememberDocument(documentId, 'window-1', created.descriptor.handleId, undefined);
  registry.releaseHandle('window-1', created.descriptor.handleId);
}

test('문서 홈 확인은 있음·지워짐·폴더째 닿지 않음·기억 없음을 가른다', async () => {
  const dir = scratch();
  try {
    const folder = join(dir, '보관');
    mkdirSync(folder);
    const { registry, path } = await remembered(folder, '보고서.hwp');

    const present = await registry.inspectDocument('doc-1');
    assert.equal(present.state, 'present');
    assert.equal(present.fileName, '보고서.hwp');
    assert.equal(present.size, 3);
    assert.equal((await registry.inspectDocument('없는-문서')).state, 'unknown');

    unlinkSync(path);
    assert.equal((await registry.inspectDocument('doc-1')).state, 'missing');

    // 외장 디스크를 꺼낸 것처럼 폴더째 사라지면 지운 것으로 보지 않는다.
    renameSync(folder, join(dir, '다른 곳'));
    assert.equal((await registry.inspectDocument('doc-1')).state, 'unavailable');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('옮겨진 문서는 크기와 내용이 같은 근처 파일로만 따라가고, 남이 쥐거나 기억한 파일은 건드리지 않는다', async () => {
  const dir = scratch();
  try {
    const { registry, path } = await remembered(dir, '보고서.hwp', [1, 2, 3]);
    // 다른 문서가 기억하는 같은 내용의 사본, 저장 중 남은 복구 파일, 크기만 같은 다른 내용
    const otherCopy = join(dir, '보고서 사본.hwp');
    writeFileSync(otherCopy, Buffer.from([1, 2, 3]));
    await rememberIn(registry, otherCopy, 'doc-2');
    writeFileSync(join(dir, '보고서.rauhwpx-recovery-1-x.hwp'), Buffer.from([1, 2, 3]));
    writeFileSync(join(dir, '같은 크기.hwp'), Buffer.from([9, 9, 9]));

    unlinkSync(path);
    assert.equal(await registry.relocateDocument('window-1', 'doc-1'), null, '맞는 후보가 없으면 옮기지 않는다');
    assert.match(registry.bookmarkPathFor('doc-2'), /보고서 사본\.hwp$/, '다른 문서의 북마크는 그대로다');

    // 다른 창이 쥔 파일은 후보가 아니다.
    const held = join(dir, '열린 문서.hwp');
    writeFileSync(held, Buffer.from([1, 2, 3]));
    const owned = await registry.create('window-2', held);
    assert.equal(owned.ok, true);
    assert.equal(await registry.relocateDocument('window-1', 'doc-1'), null);
    registry.releaseHandle('window-2', owned.descriptor.handleId);

    const relocated = await registry.relocateDocument('window-1', 'doc-1');
    assert.equal(relocated?.fileName, '열린 문서.hwp');
    assert.equal((await registry.inspectDocument('doc-1')).state, 'present');
    assert.equal(await registry.ownerForPath(held), null, '위치만 옮기고 경로를 점유하지 않는다');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('내용 표시는 북마크 저장소를 거쳐도 남아 다음 실행에도 옮겨진 파일을 알아본다', async () => {
  const dir = scratch();
  try {
    const { registry, path } = await remembered(dir, '보고서.hwp', [4, 5, 6, 7]);
    const restored = new NativeFileHandleRegistry();
    restored.loadBookmarks(JSON.parse(JSON.stringify(registry.dumpBookmarks())), { strict: true });
    renameSync(path, join(dir, '옮긴 보고서.hwp'));
    assert.equal((await restored.relocateDocument('window-1', 'doc-1'))?.fileName, '옮긴 보고서.hwp');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('미리보기 읽기는 다른 창이 쥔 파일, 큰 파일, 심볼릭 링크로 바뀐 경로를 읽지 않는다', async () => {
  const dir = scratch();
  try {
    const { registry, path } = await remembered(dir, '보고서.hwp', [1, 2, 3]);
    const read = await registry.readRememberedDocument('window-1', 'doc-1', { maxBytes: 10 });
    assert.deepEqual([...read.bytes], [1, 2, 3]);
    assert.equal(await registry.readRememberedDocument('window-1', 'doc-1', { maxBytes: 2 }), null);

    const owned = await registry.create('window-2', path);
    assert.equal(await registry.readRememberedDocument('window-1', 'doc-1', { maxBytes: 10 }), null);
    registry.releaseHandle('window-2', owned.descriptor.handleId);

    if (process.platform !== 'win32') {
      const secret = join(dir, 'secret.txt');
      writeFileSync(secret, 'secret');
      unlinkSync(path);
      symlinkSync(secret, path);
      assert.equal(await registry.readRememberedDocument('window-1', 'doc-1', { maxBytes: 100 }), null);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('이 창에 열린 문서는 새 창 열기 대상이 아니다', async () => {
  const dir = scratch();
  try {
    const { registry, path } = await remembered(dir, '보고서.hwp');
    assert.equal(registry.ownsDocumentPath('window-1', 'doc-1'), false);
    const created = await registry.create('window-1', path);
    assert.equal(registry.ownsDocumentPath('window-1', 'doc-1'), true);
    assert.equal(registry.ownsDocumentPath('window-2', 'doc-1'), false);
    registry.releaseHandle('window-1', created.descriptor.handleId);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
