import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ProjectStore, documentNodeId } from '../project-store.mjs';
import { DEFAULT_PROJECT_SETTINGS } from '../project-settings.mjs';
import { executeProjectTool } from '../project-tools.mjs';
import { createReferenceCatalog } from '../reference-catalog.mjs';
import { ReferenceStore } from '../reference-store.mjs';
import { pagedPdf } from './fixtures/paged-pdf.mjs';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');

async function fixture(t, { settings = DEFAULT_PROJECT_SETTINGS, now = () => Date.now() } = {}) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-project-store-'));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const referenceStore = await createReferenceCatalog({
    referencesRoot: path.join(parent, 'references'),
    projectsRoot: path.join(parent, 'projects'),
  }).init();
  const store = await new ProjectStore({
    root: path.join(parent, 'projects'),
    referenceStore,
    settings: () => settings,
    now,
  }).init();
  return { parent, referenceStore, store };
}

async function addText(referenceStore, store, projectId, name, text, extra = {}) {
  const file = await referenceStore.addBuffer({ scope: 'project', scopeId: projectId, name, bytes: Buffer.from(text) });
  return store.addFileItem(projectId, { fileId: file.id, scope: 'project', source: { kind: 'upload' }, addedBy: { kind: 'user' }, ...extra });
}

async function addBytes(referenceStore, store, projectId, name, bytes) {
  const file = await referenceStore.addBuffer({ scope: 'project', scopeId: projectId, name, bytes });
  return store.addFileItem(projectId, { fileId: file.id, scope: 'project', source: { kind: 'upload' }, addedBy: { kind: 'user' } });
}

const user = { kind: 'user' };

function rejectsOp(store, projectId, op, pattern, code = 'PROJECT_OP_INVALID') {
  return assert.rejects(
    store.applyOps(projectId, { actor: user, ops: [op] }),
    (error) => error.code === code && pattern.test(error.message),
    JSON.stringify(op),
  );
}

test('agent edits lock fields, the librarian skips them, and a bad op rejects the whole batch', async (t) => {
  const { referenceStore, store } = await fixture(t);
  const projectId = await store.projectForDocument('doc-a', { name: '보고서.hwpx' });
  const item = await addText(referenceStore, store, projectId, 'budget.txt', '예산은 3억 원으로 편성한다.');
  assert.equal(item.librarian.status, 'queued');
  assert.equal(item.column, 'inbox');

  const agent = { kind: 'agent', threadId: 'chat-1', agent: 'claude' };
  const edited = await store.applyOps(projectId, {
    actor: agent,
    ops: [
      { op: 'rename', id: item.id, name: '2026 예산.txt' },
      { op: 'tag', id: item.id, tags: ['예산'] },
      { op: 'move', id: item.id, column: 'key' },
    ],
  });
  assert.equal(edited.applied, 3);
  let snapshot = await store.get(projectId);
  const locked = snapshot.items.find((entry) => entry.id === item.id);
  assert.deepEqual(locked.locked, { title: true, tags: true, column: true });

  const librarian = await store.applyOps(projectId, {
    actor: { kind: 'librarian' },
    ops: [
      { op: 'rename', id: item.id, name: 'other.txt' },
      { op: 'summary', id: item.id, summary: '예산 개요' },
    ],
  });
  assert.equal(librarian.applied, 1);
  assert.deepEqual(librarian.skipped.map((entry) => entry.reason), ['locked']);
  snapshot = await store.get(projectId);
  assert.equal(snapshot.items[0].title, '2026 예산.txt');
  assert.equal(snapshot.items[0].summary, '예산 개요');

  const before = snapshot.revision;
  await assert.rejects(
    store.applyOps(projectId, {
      actor: agent,
      ops: [{ op: 'pin', id: item.id, pinned: true }, { op: 'move', id: item.id, column: 'missing' }],
    }),
    (error) => error.code === 'PROJECT_OP_INVALID',
  );
  snapshot = await store.get(projectId);
  assert.equal(snapshot.revision, before);
  assert.equal(snapshot.items[0].pinned, false);
  await assert.rejects(
    store.applyOps(projectId, { actor: agent, expectedRevision: before - 1, ops: [{ op: 'pin', id: item.id, pinned: true }] }),
    (error) => error.code === 'PROJECT_REVISION_MISMATCH',
  );
});

test('undo restores a batch and skips ops whose field changed since', async (t) => {
  const { referenceStore, store } = await fixture(t);
  const projectId = await store.projectForThread('chat-undo');
  const a = await addText(referenceStore, store, projectId, 'a.txt', 'alpha source');
  const b = await addText(referenceStore, store, projectId, 'b.txt', 'beta source');
  const batch = await store.applyOps(projectId, {
    actor: { kind: 'agent' },
    ops: [
      { op: 'rename', id: a.id, name: 'A 문서.txt' },
      { op: 'rename', id: b.id, name: 'B 문서.txt' },
      { op: 'goal', body: '사업 계획서 근거 수집' },
    ],
  });
  await store.applyOps(projectId, { actor: { kind: 'user' }, ops: [{ op: 'rename', id: b.id, name: '사용자 이름.txt' }] });

  const undone = await store.undo(projectId, { activityId: batch.activityId, actor: { kind: 'user' } });
  assert.equal(undone.applied, 2);
  assert.deepEqual(undone.skipped.map((entry) => [entry.op, entry.reason]), [['rename', 'changed']]);
  const snapshot = await store.get(projectId);
  assert.equal(snapshot.items.find((item) => item.id === a.id).title, 'a.txt');
  assert.equal(snapshot.items.find((item) => item.id === b.id).title, '사용자 이름.txt');
  assert.equal(snapshot.goal, '');

  const entries = await store.listActivity(projectId, { limit: 1 });
  assert.equal(entries[0].undoOf, batch.activityId);
  // 되돌리기 자체도 되돌릴 수 있다.
  await store.undo(projectId, { activityId: entries[0].id });
  assert.equal((await store.get(projectId)).goal, '사업 계획서 근거 수집');
});

test('notes regenerate [[…]] links and report unknown targets', async (t) => {
  const { referenceStore, store } = await fixture(t);
  const projectId = await store.projectForDocument('doc-notes', { name: '계획.hwp' });
  const file = await addText(referenceStore, store, projectId, 'guide.txt', '지침 본문');
  const nodeId = documentNodeId(projectId, 'doc-notes');
  const created = await store.applyOps(projectId, {
    actor: { kind: 'agent' },
    ops: [{ op: 'note', name: '근거 메모', body: `[[${file.id}#c0|지침 본문]] 과 [[${nodeId}]] 그리고 [[fzzzzzz]]` }],
  });
  const noteId = created.created[0];
  assert.match(noteId, /^n[a-z2-7]{6}$/);
  assert.deepEqual(created.unresolvedLinks, ['fzzzzzz']);
  let snapshot = await store.get(projectId);
  const noteLinks = snapshot.links.filter((link) => link.origin === 'note');
  assert.deepEqual(noteLinks.map((link) => [link.from, link.to, link.toAnchor ?? null]).sort(), [
    [noteId, file.id, 'c0'],
    [noteId, nodeId, null],
  ].sort());
  assert.equal((await store.readNote(projectId, noteId)).body.startsWith(`[[${file.id}#c0`), true);

  await assert.rejects(
    store.applyOps(projectId, { actor: { kind: 'agent' }, ops: [{ op: 'unlink', id: noteLinks[0].id }] }),
    (error) => error.code === 'PROJECT_OP_INVALID',
  );
  await store.applyOps(projectId, { actor: { kind: 'agent' }, ops: [{ op: 'note', id: noteId, body: '연결 없음' }] });
  snapshot = await store.get(projectId);
  assert.equal(snapshot.links.filter((link) => link.origin === 'note').length, 0);

  const hits = await store.searchNotes(projectId, '연결');
  assert.equal(hits[0].itemId, noteId);
});

test('trash hides items, restores them, and purging removes unshared reference records', async (t) => {
  let clock = Date.parse('2026-10-01T00:00:00Z');
  const settings = structuredClone(DEFAULT_PROJECT_SETTINGS);
  settings.board.trashDays = 7;
  const { referenceStore, store } = await fixture(t, { settings, now: () => clock });
  const projectId = await store.projectForThread('chat-trash');
  const keep = await addText(referenceStore, store, projectId, 'keep.txt', 'keep me');
  const drop = await addText(referenceStore, store, projectId, 'drop.txt', 'drop me');
  const linked = await store.applyOps(projectId, {
    actor: { kind: 'user' },
    ops: [{ op: 'link', from: keep.id, to: drop.id, label: '반박' }, { op: 'trash', id: drop.id }],
  });
  let snapshot = await store.get(projectId);
  assert.deepEqual(snapshot.items.map((item) => item.id), [keep.id]);
  assert.equal(snapshot.links.length, 0);
  assert.equal((await store.get(projectId, { trash: true })).links[0].id, linked.created[0]);

  await store.applyOps(projectId, { actor: { kind: 'user' }, ops: [{ op: 'restore', id: drop.id }, { op: 'trash', id: drop.id }] });
  clock += 3 * 24 * 60 * 60 * 1000;
  assert.equal(await store.purgeExpired(), 0);
  clock += 5 * 24 * 60 * 60 * 1000;
  assert.equal(await store.purgeExpired(), 1);
  snapshot = await store.get(projectId, { trash: true });
  assert.deepEqual(snapshot.items.map((item) => item.id), [keep.id]);
  assert.equal(snapshot.links.length, 0);
  assert.deepEqual(referenceStore.list({ scope: 'project', scopeId: projectId }).map((file) => file.id), [keep.fileId]);
});

test('joining a project merges the document\'s implicit project; leaving gives a fresh one', async (t) => {
  const { referenceStore, store } = await fixture(t);
  const implicitId = await store.projectForDocument('doc-join', { name: '초안.hwpx' });
  const item = await addText(referenceStore, store, implicitId, 'shared.txt', 'shared evidence');
  const project = await store.createProject({ name: '연구 묶음' });
  const other = await addText(referenceStore, store, project.id, 'shared.txt', 'shared evidence');

  const joined = await store.join(project.id, 'doc-join', { name: '초안.hwpx' });
  assert.equal(joined.merged.from, implicitId);
  assert.equal(store.projectIdForDocument('doc-join'), project.id);
  assert.equal(store.hasProject(implicitId), false);
  const snapshot = await store.get(project.id);
  // 같은 내용의 파일은 하나로 합쳐지고, 옛 항목 id 는 별칭으로 남는다.
  assert.equal(snapshot.items.filter((entry) => entry.kind === 'file').length, 1);
  assert.equal((await store.getItem(project.id, item.id)).id, other.id);
  assert.deepEqual(snapshot.members.map((member) => member.documentId), ['doc-join']);
  assert.equal(referenceStore.getFile(item.fileId).id, other.fileId);

  const left = await store.leave(project.id, 'doc-join');
  assert.notEqual(left.projectId, project.id);
  assert.equal(store.projectIdForDocument('doc-join'), left.projectId);
  assert.equal((await store.get(left.projectId)).items.length, 0);
  assert.equal((await store.get(project.id)).members.length, 0);
});

test('a corrupt index is rebuilt from project folders and never sweeps live project files', async (t) => {
  const { parent, referenceStore, store } = await fixture(t);
  const projectId = await store.projectForDocument('doc-index', { name: '색인.hwpx' });
  const item = await addText(referenceStore, store, projectId, 'kept.txt', 'kept evidence');
  const deleted = await store.createProject({ name: '지울 프로젝트' });
  await addText(referenceStore, store, deleted.id, 'gone.txt', 'gone evidence');
  await store.deleteProject(deleted.id);
  await fs.writeFile(path.join(parent, 'projects', 'index.json'), '{ not json');

  const reopened = await new ProjectStore({ root: path.join(parent, 'projects'), referenceStore }).init();
  assert.equal(reopened.projectIdForDocument('doc-index'), projectId);
  assert.equal(await reopened.repairReferences(), 0);
  assert.equal(referenceStore.getFile(item.fileId).scopeId, projectId);
  assert.deepEqual(referenceStore.list({ scope: 'project', scopeId: deleted.id }), []);
});

test('clips need a live PDF or image source, a page in range, and a rect inside it', async (t) => {
  const { referenceStore, store } = await fixture(t);
  const projectId = await store.projectForThread('chat-clips');
  const pdf = await addBytes(referenceStore, store, projectId, 'report.pdf', pagedPdf([null, 'Budget overview for the year 2026', null]));
  const image = await addBytes(referenceStore, store, projectId, 'photo.png', PNG);
  const text = await addText(referenceStore, store, projectId, 'notes.txt', '본문');
  assert.equal(pdf.pageCount, 3);

  const created = await store.applyOps(projectId, {
    actor: user,
    ops: [
      { op: 'clip', source: pdf.id, page: 2, rect: [0.6, 0.25, 0.40008, 0.5], tags: ['도표'] },
      { op: 'clip', source: image.id, rect: [0, 0, 1, 1], column: 'key' },
    ],
  });
  const [pdfClipId, imageClipId] = [created.created[0], created.created[1]];
  assert.match(pdfClipId, /^r[a-z2-7]{6}$/);
  const pdfClip = await store.getItem(projectId, pdfClipId);
  assert.equal(pdfClip.kind, 'clip');
  assert.equal(pdfClip.title, 'report p.2 영역');
  assert.equal(pdfClip.sourceId, pdf.id);
  assert.equal(pdfClip.column, 'inbox');
  // 한 단위 넘친 폭은 크기를 지키고 자리를 당긴다.
  assert.deepEqual(pdfClip.rect, [0.5999, 0.25, 0.4001, 0.5]);
  const imageClip = await store.getItem(projectId, imageClipId);
  assert.equal(imageClip.title, 'photo 영역');
  assert.equal(imageClip.page, 1);
  assert.equal(imageClip.column, 'key');

  const rect = [0.1, 0.1, 0.2, 0.2];
  await rejectsOp(store, projectId, { op: 'clip', source: text.id, page: 1, rect }, /not a PDF or image/);
  await rejectsOp(store, projectId, { op: 'clip', source: pdf.id, page: 4, rect }, /page must be an integer from 1 to 3/);
  await rejectsOp(store, projectId, { op: 'clip', source: pdf.id, rect }, /page must be/);
  await rejectsOp(store, projectId, { op: 'clip', source: image.id, page: 2, rect }, /image clip is always on page 1/);
  await rejectsOp(store, projectId, { op: 'clip', source: pdf.id, page: 1, rect: [0.5, 0.5, 0.6, 0.1] }, /inside the page/);
  await rejectsOp(store, projectId, { op: 'clip', source: pdf.id, page: 1, rect: [0.1, 0.1, 0.005, 0.2] }, /at least 0.01/);
  await rejectsOp(store, projectId, { op: 'clip', source: pdf.id, page: 1, rect: [-0.1, 0, 0.2, 0.2] }, /at least 0/);
  await rejectsOp(store, projectId, { op: 'clip', source: pdf.id, page: 1, rect: [0, 0, 0.2] }, /four finite numbers/);
  await rejectsOp(store, projectId, { op: 'clip', id: pdfClipId, source: image.id, rect }, /cannot move to another file/);
  await rejectsOp(store, projectId, { op: 'clip', id: pdf.id, rect }, /is not a clip/);

  // 바꾸기는 한 활동이고, 되돌리면 쪽·영역·이름이 함께 돌아온다.
  const moved = await store.applyOps(projectId, {
    actor: user,
    ops: [{ op: 'clip', id: pdfClipId, source: pdf.id, page: 3, rect: [0.1, 0.1, 0.3, 0.3], name: '그림 3' }],
  });
  let clip = await store.getItem(projectId, pdfClipId);
  assert.deepEqual([clip.page, clip.rect, clip.title], [3, [0.1, 0.1, 0.3, 0.3], '그림 3']);
  const unchanged = await store.applyOps(projectId, { actor: user, ops: [{ op: 'clip', id: pdfClipId, page: 3 }] });
  assert.equal(unchanged.applied, 0);
  await store.undo(projectId, { activityId: moved.activityId });
  clip = await store.getItem(projectId, pdfClipId);
  assert.deepEqual([clip.page, clip.rect, clip.title], [2, [0.5999, 0.25, 0.4001, 0.5], 'report p.2 영역']);

  await store.applyOps(projectId, { actor: user, ops: [{ op: 'trash', id: image.id }] });
  await rejectsOp(store, projectId, { op: 'clip', source: image.id, rect }, /in the trash/);
});

test('trashing a file trashes its clips, restoring brings back only those, and undo follows both ways', async (t) => {
  const { referenceStore, store } = await fixture(t);
  const projectId = await store.projectForThread('chat-clip-trash');
  const pdf = await addBytes(referenceStore, store, projectId, 'scan.pdf', pagedPdf([null, null]));
  const { created } = await store.applyOps(projectId, {
    actor: user,
    ops: [
      { op: 'clip', source: pdf.id, page: 1, rect: [0, 0, 0.5, 0.5] },
      { op: 'clip', source: pdf.id, page: 2, rect: [0, 0, 0.5, 0.5] },
    ],
  });
  const [kept, alone] = [created[0], created[1]];
  await store.applyOps(projectId, { actor: user, ops: [{ op: 'trash', id: alone }] });
  const liveIds = async () => (await store.get(projectId)).items.map((item) => item.id).sort();

  const trashed = await store.applyOps(projectId, { actor: user, ops: [{ op: 'trash', id: pdf.id }] });
  assert.deepEqual(await liveIds(), []);
  const inTrash = (await store.get(projectId, { trash: true })).items;
  assert.ok(inTrash.every((item) => !('trashedWith' in item)));
  await rejectsOp(store, projectId, { op: 'restore', id: kept }, /restore its source first/);

  const undone = await store.undo(projectId, { activityId: trashed.activityId });
  assert.deepEqual(await liveIds(), [pdf.id, kept].sort());
  await store.undo(projectId, { activityId: undone.activityId });
  assert.deepEqual(await liveIds(), []);

  await store.applyOps(projectId, { actor: user, ops: [{ op: 'restore', id: pdf.id }] });
  assert.deepEqual(await liveIds(), [pdf.id, kept].sort());

  // 같은 파일을 다시 올려 휴지통에서 꺼낼 때도 영역이 함께 나온다.
  await store.applyOps(projectId, { actor: user, ops: [{ op: 'trash', id: pdf.id }] });
  await store.addFileItem(projectId, { fileId: pdf.fileId, scope: 'project', source: { kind: 'upload' } });
  assert.deepEqual(await liveIds(), [pdf.id, kept].sort());
});

test('clip links come from the snapshot, cannot be unlinked, and purging the source drops its clips', async (t) => {
  const { referenceStore, store } = await fixture(t);
  const projectId = await store.projectForThread('chat-clip-links');
  const pdf = await addBytes(referenceStore, store, projectId, 'figure.pdf', pagedPdf(['Figure one caption text']));
  const other = await addText(referenceStore, store, projectId, 'other.txt', '다른 자료');
  const { created } = await store.applyOps(projectId, {
    actor: user,
    ops: [{ op: 'clip', source: pdf.id, page: 1, rect: [0.1, 0.1, 0.5, 0.5] }],
  });
  const clipId = created[0];
  const noted = await store.applyOps(projectId, {
    actor: user,
    ops: [
      { op: 'note', body: `그래프는 [[${clipId}|그림 1]] 에 있다.` },
      { op: 'link', from: other.id, to: clipId },
      { op: 'graph-pin', id: clipId, x: 10, y: 20 },
    ],
  });
  assert.deepEqual(noted.unresolvedLinks, []);
  let snapshot = await store.get(projectId);
  const derived = snapshot.links.filter((link) => link.origin === 'clip');
  assert.deepEqual(derived.map(({ from, to }) => [from, to]), [[clipId, pdf.id]]);
  assert.match(derived[0].id, /^l[a-z2-7]{8}$/);
  assert.equal(snapshot.links.filter((link) => link.to === clipId).length, 2);
  await rejectsOp(store, projectId, { op: 'unlink', id: derived[0].id }, /trash the clip instead/);

  await store.applyOps(projectId, { actor: user, ops: [{ op: 'trash', id: pdf.id }] });
  snapshot = await store.get(projectId);
  assert.ok(!snapshot.links.some((link) => link.from === clipId || link.to === clipId));
  assert.equal((await store.emptyTrash(projectId)).purged, 2);
  snapshot = await store.get(projectId, { trash: true });
  assert.deepEqual(snapshot.items.map((item) => item.kind).sort(), ['file', 'note']);
  assert.ok(!snapshot.links.some((link) => link.from === clipId || link.to === clipId));
  assert.equal(snapshot.graph.pinned[clipId], undefined);
});

test('merging a project points copied clips at the merged source file', async (t) => {
  const { referenceStore, store } = await fixture(t);
  const implicitId = await store.projectForDocument('doc-clip-merge', { name: '초안.hwpx' });
  const pdfBytes = pagedPdf(['Shared figure page']);
  const pdf = await addBytes(referenceStore, store, implicitId, 'shared.pdf', pdfBytes);
  const { created } = await store.applyOps(implicitId, {
    actor: user,
    ops: [{ op: 'clip', source: pdf.id, page: 1, rect: [0.2, 0.2, 0.3, 0.3] }],
  });
  const project = await store.createProject({ name: '연구 묶음' });
  const target = await addBytes(referenceStore, store, project.id, 'shared.pdf', pdfBytes);
  assert.notEqual(target.id, pdf.id);

  await store.join(project.id, 'doc-clip-merge', { name: '초안.hwpx' });
  const clip = await store.getItem(project.id, created[0]);
  assert.equal(clip.kind, 'clip');
  assert.equal(clip.sourceId, target.id);
  const snapshot = await store.get(project.id);
  assert.ok(snapshot.links.some((link) => link.origin === 'clip' && link.from === clip.id && link.to === target.id));
});

test('project_read shows clips and text-less pages on a PDF and the source on a clip', async (t) => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-project-read-clips-'));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const referenceStore = await new ReferenceStore({ format: 'project', root: path.join(parent, 'files') }).init();
  const store = await new ProjectStore({ root: path.join(parent, 'projects'), referenceStore }).init();
  const projectId = await store.projectForThread('chat-read-clips');
  const pdf = await addBytes(referenceStore, store, projectId, 'mixed.pdf', pagedPdf([null, 'Budget overview for the year 2026', null]));
  const { created } = await store.applyOps(projectId, {
    actor: user,
    ops: [{ op: 'clip', source: pdf.id, page: 1, rect: [0.1, 0.2, 0.3, 0.4], name: '표지 그림' }],
  });
  const clipId = created[0];
  const read = async (args) => (await executeProjectTool({
    tool: 'project_read', args, session: { projectId }, projectStore: store,
  })).result;

  const fileView = await read({ view: 'item', id: pdf.id });
  assert.deepEqual(fileView.clips, [{ id: clipId, title: '표지 그림', page: 1, rect: [0.1, 0.2, 0.3, 0.4] }]);
  assert.deepEqual(fileView.textlessPages, [1, 3]);
  assert.equal(fileView.textlessTotal, undefined);

  const clipView = await read({ view: 'item', id: clipId });
  assert.deepEqual(clipView.source, { id: pdf.id, title: 'mixed.pdf', fileKind: 'pdf', pageCount: 3 });
  assert.deepEqual([clipView.page, clipView.rect], [1, [0.1, 0.2, 0.3, 0.4]]);
  assert.ok(clipView.links.some((link) => link.origin === 'clip' && link.to === pdf.id));

  const rows = await read({ view: 'items', kind: 'clip' });
  assert.deepEqual(rows.items, [{ id: clipId, kind: 'clip', title: '표지 그림', column: 'inbox', source: pdf.id, page: 1 }]);
  assert.equal((await read({ view: 'summary' })).counts.clips, 1);
});
