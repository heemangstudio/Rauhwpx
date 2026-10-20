import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureDocumentRegion, createAgentContextStore, installAgentContextStore } from '../desktop/agent-context-store.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1kAAAAASUVORK5CYII=', 'base64');
function payload(documentId = 'document-a') {
  return { document: { id: documentId, name: '문서.hwpx', revision: 7 }, comment: '여기 수정',
    selection: { label: '스크린샷 1개', excerpt: '여기 수정', contextBlock: 'PNG region.png; JSON capture-record.json', items: [{
      kind: 'screenshot', captureId: '', comment: '여기 수정', attachmentName: 'region.png', recordAttachmentName: 'capture-record.json',
      pageRegions: [{ pageIndex: 0, pageWidth: 800, pageHeight: 1000, x: 30, y: 40, width: 100, height: 50 }],
    }] }, files: [{ name: 'region.png', bytes: png }] };
}
async function temporary(t) { const root = await mkdtemp(join(tmpdir(), 'rhwp-captures-')); t.after(() => rm(root, { recursive: true, force: true })); return root; }

test('capture PNG and JSON survive reload, consumption and discard', async (t) => {
  const root = await temporary(t); const store = createAgentContextStore({ rootDir: root });
  const first = await store.save(payload()); const second = await store.save(payload());
  const reopened = createAgentContextStore({ rootDir: root });
  assert.equal((await reopened.list('document-a')).length, 2);
  assert.equal((await reopened.list('document-b')).length, 0);
  assert.equal(first.selection.items[0].captureId, first.id);
  assert.ok(first.selection.contextBlock.includes(`capture-${first.id}.json`));
  assert.deepEqual(Buffer.from((await reopened.readFiles(first.id))[0].bytes), png);
  await reopened.setState([first.id], 'consumed'); await reopened.setState([second.id], 'discarded');
  assert.deepEqual(await reopened.list('document-a'), []);
  // 끝난 기록은 원본을 archive/ 에 남기고 다시 읽을 수 있다.
  assert.equal(JSON.parse(await readFile(join(root, 'archive', first.id, 'record.json'), 'utf8')).state, 'consumed');
  assert.equal(JSON.parse(await readFile(join(root, 'archive', second.id, 'record.json'), 'utf8')).comment, '여기 수정');
  assert.deepEqual(await readFile(join(root, 'archive', second.id, 'region.png')), png);
  assert.deepEqual(Buffer.from((await reopened.readFiles(second.id))[0].bytes), png);
  await reopened.setState([first.id, second.id], 'discarded');
  assert.equal(JSON.parse(await readFile(join(root, 'archive', first.id, 'record.json'), 'utf8')).state, 'consumed');
});
test('finished captures leave the scanned root so lists and saves stay bounded by queued drafts', async (t) => {
  const root = await temporary(t); const store = createAgentContextStore({ rootDir: root });
  const queued = await store.save(payload());
  for (let index = 0; index < 30; index += 1) {
    const record = await store.save(payload(index % 2 ? 'document-a' : 'document-b'));
    await store.setState([record.id], index % 3 ? 'consumed' : 'discarded');
  }
  const scanned = (await readdir(root)).filter((name) => name !== 'archive');
  assert.deepEqual(scanned, [queued.id]);
  assert.equal((await readdir(join(root, 'archive'))).length, 30);
  // 지난 기록은 대기 한도에 세지 않는다.
  for (let index = 0; index < 19; index += 1) await store.save(payload());
  await assert.rejects(store.save(payload()), /저장된 메모가 많습니다/);
  assert.equal((await store.list('document-a')).length, 20);
});
test('captures finished by an older version move out of the root on the next list', async (t) => {
  const root = await temporary(t); const store = createAgentContextStore({ rootDir: root });
  const kept = await store.save(payload()); const old = await store.save(payload());
  await store.setState([old.id], 'consumed');
  // 이전 버전은 끝난 기록을 rootDir 에 그대로 두었다.
  await rename(join(root, 'archive', old.id), join(root, old.id));
  const reopened = createAgentContextStore({ rootDir: root });
  assert.deepEqual((await reopened.list('document-a')).map((record) => record.id), [kept.id]);
  await reopened.save(payload('document-b'));
  assert.ok(!(await readdir(root)).includes(old.id));
  assert.equal(JSON.parse(await readFile(join(root, 'archive', old.id, 'record.json'), 'utf8')).state, 'consumed');
  assert.deepEqual(Buffer.from((await reopened.readFiles(old.id))[0].bytes), png);
});
test('an older capture that cannot move out of the root does not hold up later saves', async (t) => {
  const root = await temporary(t); const seed = createAgentContextStore({ rootDir: root, platform: 'win32' });
  const old = await seed.save(payload()); await seed.setState([old.id], 'consumed');
  await rename(join(root, 'archive', old.id), join(root, old.id));
  // 같은 이름의 보관 폴더가 있으면 옮기기가 계속 실패한다(잠긴 폴더와 같은 경우).
  await mkdir(join(root, 'archive', old.id)); await writeFile(join(root, 'archive', old.id, 'keep'), 'x');
  const store = createAgentContextStore({ rootDir: root, platform: 'win32' });
  for (let index = 0; index < 4; index += 1) assert.deepEqual(await store.list('document-a'), []);
  const started = performance.now();
  const saved = await store.save(payload());
  assert.ok(performance.now() - started < 1000, 'saves do not wait on lock retries for older captures');
  assert.deepEqual((await store.list('document-a')).map((record) => record.id), [saved.id]);
  assert.deepEqual(Buffer.from((await store.readFiles(old.id))[0].bytes), png);
});
test('capture storage rejects paths, invalid geometry and oversized PNGs without saving', async (t) => {
  const root = await temporary(t); const store = createAgentContextStore({ rootDir: root });
  const path = payload(); path.files[0].name = '../region.png';
  await assert.rejects(store.save(path), /image name/);
  const outside = payload(); outside.selection.items[0].pageRegions[0].x = 790;
  await assert.rejects(store.save(outside), /geometry/);
  const huge = payload(); huge.files[0].bytes = Buffer.from(png); huge.files[0].bytes.writeUInt32BE(9000, 16);
  await assert.rejects(store.save(huge), /pixel limit/);
  await assert.rejects(store.readFiles('../../outside'), /capture id/);
  assert.deepEqual(await readdir(root), []);
});
test('capture reads skip corrupt records while keeping valid drafts', async (t) => {
  const root = await temporary(t); const store = createAgentContextStore({ rootDir: root });
  const valid = await store.save(payload()); const corrupt = await store.save(payload());
  await writeFile(join(root, corrupt.id, 'record.json'), '{broken');
  assert.deepEqual((await store.list('document-a')).map((record) => record.id), [valid.id]);
});
test('capture reads reject directory and image symlinks', async (t) => {
  const root = await temporary(t); const outside = await temporary(t); const store = createAgentContextStore({ rootDir: root });
  const valid = await store.save(payload());
  const linkId = '12345678-1234-1234-1234-123456789abc';
  try {
    await symlink(outside, join(root, linkId), 'dir');
  } catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error.code)) {
      t.skip('Windows requires symbolic-link privileges');
      return;
    }
    throw error;
  }
  assert.deepEqual((await store.list('document-a')).map((record) => record.id), [valid.id]);
  await assert.rejects(store.readFiles(linkId), /directory/);
  await rm(join(root, valid.id, 'region.png')); await writeFile(join(outside, 'secret.png'), png);
  await symlink(join(outside, 'secret.png'), join(root, valid.id, 'region.png'));
  await assert.rejects(store.readFiles(valid.id), /capture file/);
});
test('trusted IPC callers are checked and parallel saves obey the queued limit', async (t) => {
  const root = await temporary(t); const handlers = new Map();
  const trusted = {};
  installAgentContextStore({ rootDir: root, ipcMain: { handle(name, handler) { handlers.set(name, handler); } }, sessionForEvent(event) { if (event !== trusted) throw new Error('untrusted'); } });
  assert.throws(() => handlers.get('desktop:agent-context-list')({}, 'document-a'), /untrusted/);
  const outcomes = await Promise.allSettled(Array.from({ length: 21 }, () => handlers.get('desktop:agent-context-save')(trusted, payload())));
  assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 20);
  assert.equal((await handlers.get('desktop:agent-context-list')(trusted, 'document-a')).length, 20);
});
test('native capture accepts only bounded sender-window pixels and limits DPR allocation', async () => {
  const calls = [];
  const webContents = { getZoomFactor: () => 1, async capturePage(rect) { calls.push(rect); return { toPNG: () => png }; } };
  const bounds = { width: 1000, height: 800, scaleFactor: 2 };
  const result = await captureDocumentRegion({ webContents, bounds, rect: { x: 100, y: 70, width: 200, height: 100, path: '/outside' } });
  assert.deepEqual(Buffer.from(result.bytes), png);
  assert.deepEqual(calls, [{ x: 100, y: 70, width: 200, height: 100 }]);
  for (const rect of [
    { x: -1, y: 0, width: 10, height: 10 }, { x: 999, y: 0, width: 2, height: 10 },
    { x: 0.5, y: 0, width: 10, height: 10 }, { x: 0, y: 0, width: 1000, height: 900 },
  ]) await assert.rejects(captureDocumentRegion({ webContents, bounds, rect }), /bounds/);
  await assert.rejects(captureDocumentRegion({ webContents, bounds: { width: 5000, height: 5000, scaleFactor: 2 }, rect: { x: 0, y: 0, width: 3000, height: 3000 } }), /pixel limit/);
  assert.equal(calls.length, 1);
});
