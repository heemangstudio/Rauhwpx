import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveBrowserUploadFiles } from '../browser-upload-sources.mjs';

const actor = { threadId: 'chat-a', agentId: 'chat-a:root', projectId: 'project-a' };

async function context(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hama-upload-sources-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const snapshotRoot = path.join(dir, 'snapshots', 'chat-a');
  await mkdir(path.join(snapshotRoot, 'allocation'), { recursive: true });
  await writeFile(path.join(snapshotRoot, 'allocation', '보고서.hwpx'), 'PK\x03\x04document');
  await writeFile(path.join(dir, 'secret.txt'), 'private home file');
  await symlink(path.join(dir, 'secret.txt'), path.join(snapshotRoot, 'allocation', 'link.hwpx'));
  await writeFile(path.join(dir, 'blob'), 'project bytes');
  const artifacts = new Map([['art-own', { owner: { threadId: 'chat-a' }, size: 3, fileName: 'out.hwpx', mime: 'application/vnd.hancom.hwpx+zip', bytes: Buffer.from('own') }],
    ['art-other', { owner: { threadId: 'chat-b' }, size: 5, fileName: 'other.hwpx', mime: 'x', bytes: Buffer.from('other') }]]);
  return {
    dir,
    actor,
    snapshotRoot,
    artifactStore: { describe: async (id) => { const entry = artifacts.get(id); if (!entry) throw new Error('missing'); return entry; }, read: async (id) => artifacts.get(id) },
    downloads: {
      get: async ({ downloadId, actor: who }) => { if (downloadId !== 'bd_own' || who.agentId !== actor.agentId) throw new Error('missing'); return { size: 4 }; },
      readBytes: async () => ({ bytes: Buffer.from('page'), mimeType: 'application/pdf', filename: 'paper.pdf' }),
    },
    projectStore: { getItem: async (projectId, itemId) => { if (projectId !== 'project-a' || itemId !== 'item-1') throw new Error('missing'); return { kind: 'file', fileId: 'file-1', scope: 'project', originalName: 'notes.pdf' }; } },
    referenceStore: { openBlob: async ({ fileId, scopes }) => { assert.deepEqual(scopes, [{ scope: 'project', scopeId: 'project-a' }]); assert.equal(fileId, 'file-1'); return { path: path.join(dir, 'blob'), size: 13, mimeType: 'application/pdf', name: 'blob' }; } },
  };
}

test('upload sources resolve only files this chat owns', async (t) => {
  const c = await context(t);
  const files = await resolveBrowserUploadFiles([
    { artifactId: 'art-own' }, { downloadId: 'bd_own' }, { projectItemId: 'item-1' },
    { snapshotPath: path.join(c.snapshotRoot, 'allocation', '보고서.hwpx') },
  ], c);
  assert.deepEqual(files.map(({ name, mimeType, buffer }) => [name, mimeType, buffer.toString()]), [
    ['out.hwpx', 'application/vnd.hancom.hwpx+zip', 'own'], ['paper.pdf', 'application/pdf', 'page'],
    ['notes.pdf', 'application/pdf', 'project bytes'], ['보고서.hwpx', 'application/vnd.hancom.hwpx+zip', 'PK\x03\x04document'],
  ]);
  for (const source of [{ artifactId: 'art-other' }, { downloadId: 'bd_other' }, { projectItemId: 'item-2' },
    { snapshotPath: path.join(c.dir, 'secret.txt') }, { snapshotPath: path.join(c.snapshotRoot, 'allocation', '..', '..', '..', 'secret.txt') },
    { snapshotPath: path.join(c.snapshotRoot, 'allocation', 'link.hwpx') }]) {
    await assert.rejects(resolveBrowserUploadFiles([source], c), { code: 'BROWSER_UPLOAD_SOURCE_NOT_FOUND' }, JSON.stringify(source));
  }
  await assert.rejects(resolveBrowserUploadFiles([{ projectItemId: 'item-1' }], { ...c, actor: { ...actor, projectId: null } }), { code: 'BROWSER_UPLOAD_SOURCE_NOT_FOUND' });
  await assert.rejects(resolveBrowserUploadFiles([{}], c), { code: 'BROWSER_UPLOAD_INVALID' });
  await assert.rejects(resolveBrowserUploadFiles(Array.from({ length: 6 }, () => ({ artifactId: 'art-own' })), c), { code: 'BROWSER_UPLOAD_LIMIT' });
});

test('upload sources keep the 20 MB per-file and 40 MB total limits', async (t) => {
  const c = await context(t);
  const big = (size) => ({ owner: { threadId: 'chat-a' }, size, fileName: 'big.pdf', mime: 'application/pdf', bytes: Buffer.alloc(size) });
  const store = (size) => ({ describe: async () => big(size), read: async () => big(size) });
  await assert.rejects(resolveBrowserUploadFiles([{ artifactId: 'a' }], { ...c, artifactStore: store(20 * 1024 * 1024 + 1) }), { code: 'BROWSER_UPLOAD_LIMIT' });
  await assert.rejects(resolveBrowserUploadFiles([{ artifactId: 'a' }, { artifactId: 'b' }, { artifactId: 'c' }], { ...c, artifactStore: store(15 * 1024 * 1024) }), { code: 'BROWSER_UPLOAD_LIMIT' });
});
