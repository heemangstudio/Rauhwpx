import assert from 'node:assert/strict';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createProjectHttpHandler } from '../project-http.mjs';
import { ProjectSettingsStore } from '../project-settings.mjs';
import { ProjectStore } from '../project-store.mjs';
import { createReferenceCatalog } from '../reference-catalog.mjs';

const ORIGIN = 'http://127.0.0.1:7700';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');

async function fixture(t) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-project-http-'));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const referenceStore = await createReferenceCatalog({
    referencesRoot: path.join(parent, 'references'),
    projectsRoot: path.join(parent, 'projects'),
  }).init();
  const settingsStore = new ProjectSettingsStore({ root: path.join(parent, 'projects') });
  await settingsStore.load();
  const projectStore = await new ProjectStore({
    root: path.join(parent, 'projects'),
    referenceStore,
    settings: () => settingsStore.get(),
  }).init();
  const boundProjectId = await projectStore.projectForDocument('doc-a', { name: '보고서.hwpx' });
  const otherProjectId = await projectStore.projectForDocument('doc-b', { name: '다른 문서.hwp' });
  const session = { projectId: boundProjectId, documentId: 'doc-a', documentName: '보고서.hwpx' };
  const rebinds = [];
  const handler = createProjectHttpHandler({
    projectStore,
    referenceStore,
    settingsStore,
    tokens: ['session-secret'],
    session,
    homeAccess: false,
    platform: 'darwin',
    onBindingChanged: (projectId) => { rebinds.push(projectId); },
  });
  const server = http.createServer((req, res) => {
    void handler(req, res, new URL(req.url ?? '/', 'http://127.0.0.1')).then((handled) => {
      if (!handled && !res.writableEnded) { res.statusCode = 404; res.end(); }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (route, { method = 'GET', body, headers = {} } = {}) => fetch(`${base}${route}`, {
    method,
    headers: {
      Authorization: 'Bearer session-secret',
      Origin: ORIGIN,
      ...(body !== undefined && !(body instanceof Buffer) ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    ...(body !== undefined ? { body: body instanceof Buffer ? body : JSON.stringify(body) } : {}),
  });
  return { projectStore, referenceStore, settingsStore, boundProjectId, otherProjectId, call, rebinds, base };
}

test('project API needs the session bearer and only opens the session\'s own project', async (t) => {
  const { boundProjectId, otherProjectId, call, base } = await fixture(t);
  assert.equal((await fetch(`${base}/projects/current`)).status, 401);
  assert.equal((await fetch(`${base}/projects/current`, {
    headers: { Authorization: 'Bearer session-secret', Origin: 'https://evil.example' },
  })).status, 403);

  const current = await call('/projects/current');
  assert.equal(current.status, 200);
  assert.equal(current.headers.get('access-control-allow-origin'), ORIGIN);
  assert.equal((await current.json()).project.id, boundProjectId);

  const listed = await (await call('/projects')).json();
  assert.deepEqual(listed.projects.map((project) => project.id).sort(), [boundProjectId, otherProjectId].sort());

  for (const route of [`/projects/${otherProjectId}`, `/projects/${otherProjectId}/activity`]) {
    const denied = await call(route);
    assert.equal(denied.status, 403, route);
    assert.equal((await denied.json()).error.code, 'PROJECT_FORBIDDEN');
  }
  const deniedOps = await call(`/projects/${otherProjectId}/ops`, { method: 'POST', body: { ops: [{ op: 'goal', body: 'x' }] } });
  assert.equal(deniedOps.status, 403);
  const foreignJoin = await call(`/projects/${otherProjectId}/join`, { method: 'POST', body: { documentId: 'doc-b' } });
  assert.equal(foreignJoin.status, 403);
});

test('uploads become items, blobs stream with safe headers, and user ops are undoable', async (t) => {
  const { boundProjectId, call, projectStore } = await fixture(t);
  const upload = await call(`/projects/${boundProjectId}/files?column=key`, {
    method: 'POST',
    body: Buffer.from('조사 결과 본문입니다. 예산 3억 원.'),
    headers: { 'Content-Type': 'text/plain', 'X-File-Name': encodeURIComponent('조사 결과.txt') },
  });
  assert.equal(upload.status, 201);
  const { item } = await upload.json();
  assert.equal(item.column, 'key');
  assert.equal(item.source.kind, 'upload');

  const blob = await call(`/projects/${boundProjectId}/files/${item.id}/blob`);
  assert.equal(blob.status, 200);
  assert.equal(blob.headers.get('x-content-type-options'), 'nosniff');
  assert.match(blob.headers.get('content-disposition'), /^attachment;/);
  assert.equal(await blob.text(), '조사 결과 본문입니다. 예산 3억 원.');

  const image = await call(`/projects/${boundProjectId}/files`, {
    method: 'POST', body: PNG, headers: { 'Content-Type': 'image/png', 'X-File-Name': 'shot.png' },
  });
  const imageItem = (await image.json()).item;
  const imageBlob = await call(`/projects/${boundProjectId}/files/${imageItem.id}/blob`);
  assert.match(imageBlob.headers.get('content-disposition'), /^inline;/);
  assert.equal(imageBlob.headers.get('content-type'), 'image/png');

  const chunk = await (await call(`/projects/${boundProjectId}/files/${item.id}/chunks/c0`)).json();
  assert.equal(chunk.chunkId, 'c0');
  assert.match(chunk.text, /예산 3억 원/);
  const page = await (await call(`/projects/${boundProjectId}/files/${item.id}/text`)).json();
  assert.equal(page.text, chunk.text);
  assert.deepEqual(page.chunks, [{ id: 'c0', start: 0, end: chunk.text.length }]);

  const edited = await call(`/projects/${boundProjectId}/ops`, {
    method: 'POST', body: { ops: [{ op: 'rename', id: item.id, name: '예산 근거.txt' }, { op: 'graph-pin', id: item.id, x: 10, y: -4 }] },
  });
  assert.equal(edited.status, 200);
  const result = await edited.json();
  assert.equal(result.applied, 2);
  const undo = await call(`/projects/${boundProjectId}/undo`, { method: 'POST', body: { activityId: result.activityId } });
  assert.equal(undo.status, 200);
  const snapshot = await projectStore.get(boundProjectId);
  assert.equal(snapshot.items.find((entry) => entry.id === item.id).title, '조사 결과.txt');
  assert.deepEqual(snapshot.graph.pinned, {});

  const invalid = await call(`/projects/${boundProjectId}/ops`, { method: 'POST', body: { ops: [{ op: 'move', id: item.id, column: 'nope' }] } });
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).error.code, 'PROJECT_OP_INVALID');
});

test('settings validate strictly and join moves only the session document', async (t) => {
  const { boundProjectId, otherProjectId, call, projectStore, rebinds } = await fixture(t);
  const settings = await (await call('/project-settings')).json();
  assert.equal(settings.settings.agent.chatMayEdit, true);
  assert.deepEqual(settings.capabilities, { homeAccess: false, platform: 'darwin' });
  const bad = await call('/project-settings', { method: 'PUT', body: { settings: { librarian: { concurrency: 9 } } } });
  assert.equal(bad.status, 400);
  const saved = await call('/project-settings', { method: 'PUT', body: { settings: { agent: { chatMayEdit: false } } } });
  assert.equal((await saved.json()).settings.agent.chatMayEdit, false);

  const created = await call('/projects', { method: 'POST', body: { name: '공동 조사', documentId: 'doc-a' } });
  assert.equal(created.status, 201);
  const project = (await created.json()).project;
  assert.equal(projectStore.projectIdForDocument('doc-a'), project.id);
  assert.equal(projectStore.hasProject(boundProjectId), false);
  assert.deepEqual(rebinds, [project.id]);

  const deleted = await call(`/projects/${otherProjectId}`, { method: 'DELETE' });
  assert.equal(deleted.status, 200);
  assert.equal(projectStore.hasProject(otherProjectId), false);
});
