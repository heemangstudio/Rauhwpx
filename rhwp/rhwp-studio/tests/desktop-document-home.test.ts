import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { NativeFileHandleRegistry } from '../../../desktop/native-file-handles.mjs';

async function remembered(dir: string, name: string) {
  const path = join(dir, name);
  writeFileSync(path, Buffer.from([1, 2, 3]));
  const registry = new NativeFileHandleRegistry();
  const created = await registry.create('window-1', path);
  assert.equal(created.ok, true);
  registry.rememberDocument('doc-1', 'window-1', created.descriptor.handleId, undefined);
  registry.releaseHandle('window-1', created.descriptor.handleId);
  return { registry, path };
}

test('문서 홈 확인은 기억한 파일이 있는지, 지워졌는지, 폴더째 닿지 않는지를 가른다', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rhwp-home-'));
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

test('옮겨진 문서는 근처 후보로 새 위치를 기억하고 핸들을 점유하지 않는다', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rhwp-home-'));
  try {
    const { registry, path } = await remembered(dir, '보고서.hwp');
    const moved = join(dir, '보고서 최종.hwp');
    renameSync(path, moved);
    assert.equal((await registry.inspectDocument('doc-1')).state, 'missing');

    const probes = await registry.searchNearby('window-1', 'doc-1', { basenameHint: '보고서.hwp' });
    const probe = probes.find((entry: { fileName: string }) => entry.fileName === '보고서 최종.hwp');
    assert.ok(probe);
    const relocated = await registry.relocateDocument('window-1', 'doc-1', probe.probeId);
    assert.equal(relocated?.fileName, '보고서 최종.hwp');
    assert.equal((await registry.inspectDocument('doc-1')).state, 'present');
    assert.equal(await registry.ownerForPath(moved), null, '위치만 옮기고 경로를 점유하지 않는다');
    await assert.rejects(registry.relocateDocument('window-2', 'doc-1', probe.probeId), '다른 창의 후보는 쓰지 못한다');

    const read = await registry.readRememberedDocument('doc-1', { maxBytes: 10 });
    assert.deepEqual([...read!.bytes], [1, 2, 3]);
    assert.equal(await registry.readRememberedDocument('doc-1', { maxBytes: 2 }), null, '큰 파일은 미리보기로 읽지 않는다');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
