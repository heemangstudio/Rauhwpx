import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
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
  assert.equal(JSON.parse(await readFile(join(root, first.id, 'record.json'), 'utf8')).state, 'consumed');
  assert.equal(JSON.parse(await readFile(join(root, second.id, 'record.json'), 'utf8')).comment, '여기 수정');
  assert.deepEqual(await readFile(join(root, second.id, 'region.png')), png);
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
