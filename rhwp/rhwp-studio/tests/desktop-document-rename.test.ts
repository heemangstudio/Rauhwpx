import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { NativeFileHandleRegistry } from '../../../desktop/native-file-handles.mjs';
import { DocumentLeaseManager } from '../../../desktop/document-leases.mjs';

test('열린 문서 파일의 이름을 바꾸면 같은 핸들로 새 경로를 읽고 북마크와 점유가 따라온다', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rhwp-rename-'));
  try {
    const original = join(dir, '보고서.hwp');
    writeFileSync(original, Buffer.from([1, 2, 3]));
    writeFileSync(join(dir, '다른.hwp'), Buffer.from([9]));
    const registry = new NativeFileHandleRegistry();
    const created = await registry.create('window-1', original);
    assert.equal(created.ok, true);
    const handleId = created.descriptor.handleId;
    registry.rememberDocument('doc-1', 'window-1', handleId, undefined);
    const ownershipPath = registry.pathForSender('window-1', handleId);
    const leases = new DocumentLeaseManager();
    const reserved = leases.reserve('window-1', { documentId: 'doc-1', sourceDigest: null }, ownershipPath);
    leases.commit('window-1', reserved.reservationId);

    const renamed = await registry.renameHandle('window-1', handleId, '최종 보고서.hwp');
    assert.equal(renamed.descriptor.handleId, handleId);
    assert.equal(renamed.descriptor.name, '최종 보고서.hwp');
    assert.equal(existsSync(original), false);
    assert.deepEqual([...readFileSync(renamed.canonicalPath)], [1, 2, 3]);
    assert.equal(registry.bookmarkPathFor('doc-1'), renamed.canonicalPath);
    const read = await registry.read('window-1', handleId);
    assert.deepEqual([...read.bytes], [1, 2, 3]);

    // 점유는 경로의 소유 키로 잡는다 (실제 앱과 같은 형식).
    assert.equal(leases.renamePath('window-1', renamed.previousOwnershipPath, renamed.ownershipPath), true);
    assert.equal(leases.ownerForPath(renamed.ownershipPath), 'window-1');
    assert.equal(leases.ownerForPath(renamed.previousOwnershipPath), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('이미 있는 이름·다른 확장자·경로가 든 이름으로는 바꾸지 않고 파일을 그대로 둔다', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rhwp-rename-'));
  try {
    const original = join(dir, '보고서.hwp');
    writeFileSync(original, Buffer.from([1, 2, 3]));
    writeFileSync(join(dir, '다른.hwp'), Buffer.from([9]));
    const registry = new NativeFileHandleRegistry();
    const created = await registry.create('window-1', original);
    const handleId = created.descriptor.handleId;

    await assert.rejects(registry.renameHandle('window-1', handleId, '다른.hwp'), (error) => error.renameRefusal === 'exists');
    await assert.rejects(registry.renameHandle('window-1', handleId, '보고서.hwpx'), (error) => error.renameRefusal === 'extension');
    await assert.rejects(registry.renameHandle('window-1', handleId, '../밖.hwp'), (error) => error.renameRefusal === 'invalid');
    await assert.rejects(registry.renameHandle('window-2', handleId, '새 이름.hwp'));
    assert.equal(existsSync(original), true);
    assert.deepEqual([...readFileSync(join(dir, '다른.hwp'))], [9]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
