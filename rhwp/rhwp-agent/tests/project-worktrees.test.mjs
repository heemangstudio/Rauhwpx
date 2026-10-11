// 문서의 작업 공간(워크트리)들이 한 연구 프로젝트를 함께 쓰는 계약: 저장소로 묶기, 예전에 따로
// 생긴 작업 공간 프로젝트 합치기(멈췄다 다시 떠도 같은 결과), 작업 공간 표시와 프롬프트의 wt.
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ProjectStore, originLabels, normalizeRepository } from '../project-store.mjs';
import { DEFAULT_PROJECT_SETTINGS } from '../project-settings.mjs';
import { projectPromptContext } from '../project-context.mjs';
import { createReferenceCatalog } from '../reference-catalog.mjs';

async function fixture(t) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-project-worktrees-'));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const open = async () => {
    const referenceStore = await createReferenceCatalog({
      referencesRoot: path.join(parent, 'references'),
      projectsRoot: path.join(parent, 'projects'),
    }).init();
    const store = await new ProjectStore({
      root: path.join(parent, 'projects'),
      referenceStore,
      settings: () => DEFAULT_PROJECT_SETTINGS,
    }).init();
    return { referenceStore, store };
  };
  return { parent, open, ...(await open()) };
}

async function addText(referenceStore, store, projectId, name, text, extra = {}) {
  const file = await referenceStore.addBuffer({ scope: 'project', scopeId: projectId, name, bytes: Buffer.from(text) });
  return store.addFileItem(projectId, { fileId: file.id, scope: 'project', source: { kind: 'upload' }, addedBy: { kind: 'user' }, ...extra });
}

const user = { kind: 'user' };
const agent = { kind: 'agent', threadId: 'chat-variant', agent: 'claude' };

function repository(current, { renamed = null } = {}) {
  const worktrees = [
    { id: 'wt-main', branch: 'main', primary: true, documentId: 'doc-main' },
    { id: 'wt-variant', branch: renamed ?? '요약본', primary: false, documentId: 'doc-variant' },
  ];
  const worktree = worktrees.find((entry) => entry.id === current);
  return { id: 'repo-1', worktree, worktrees };
}

/** 고치기 전처럼 작업 공간 문서가 따로 받은 암묵 프로젝트에 자료·메모·연결·활동을 쌓는다. */
async function strayWorktreeProject(referenceStore, store) {
  const strayId = await store.projectForDocument('doc-variant', { name: '보고서.hwpx' });
  const file = await addText(referenceStore, store, strayId, 'variant.txt', '요약본에서 모은 근거');
  const edited = await store.applyOps(strayId, {
    actor: agent,
    ops: [
      { op: 'note', name: '요약 방향', body: `[[${file.id}]] 를 줄여 쓴다.` },
      { op: 'tag', id: file.id, tags: ['요약'] },
    ],
  });
  return { strayId, file, noteId: edited.created[0] };
}

test('every worktree of a repository binds to the primary project and absorbs a stray worktree project once', async (t) => {
  const { referenceStore, store } = await fixture(t);
  const projectId = await store.projectForDocument('doc-main', { name: '보고서.hwpx' });
  const mainFile = await addText(referenceStore, store, projectId, 'main.txt', '본문 근거');
  const { strayId, file, noteId } = await strayWorktreeProject(referenceStore, store);

  const bound = await store.bindSession({ threadId: 'chat-variant', documentId: 'doc-variant', documentName: '보고서.hwpx', repository: repository('wt-variant') });
  assert.equal(bound, projectId, 'the primary document project wins');
  assert.equal(store.projectIdForDocument('doc-variant'), projectId);
  assert.equal(store.hasProject(strayId), false);
  const merged = await store.get(projectId);
  // 항목 id 그대로, 메모의 연결도 새 프로젝트에서 이어진다.
  assert.deepEqual(new Set(merged.items.map((item) => item.id)), new Set([mainFile.id, file.id, noteId]));
  assert.equal((await store.readNote(projectId, noteId)).body, `[[${file.id}]] 를 줄여 쓴다.`);
  assert.ok(merged.links.some((link) => link.from === noteId && link.to === file.id && link.origin === 'note'));
  assert.deepEqual((await store.getItem(projectId, file.id)).tags, ['요약']);
  assert.deepEqual(merged.members.map((member) => member.documentId), ['doc-main'], 'worktree documents are not graph members');
  assert.equal(referenceStore.getFile(file.fileId).scopeId, projectId);
  const activity = await store.listActivity(projectId, { limit: 50 });
  assert.equal(activity.filter((entry) => entry.mergedFrom === strayId && entry.actor.kind === 'agent').length, 1, 'the stray project history moves along');

  // 다시 묶어도(다른 작업 공간에서도) 같은 프로젝트, 같은 항목이다.
  assert.equal(await store.bindSession({ documentId: 'doc-main', repository: repository('wt-main') }), projectId);
  assert.equal(await store.bindSession({ documentId: 'doc-variant', repository: repository('wt-variant', { renamed: '짧은 판' }) }), projectId);
  assert.equal((await store.get(projectId)).items.length, 3);
  assert.equal(store.worktreeBranch('wt-variant'), '짧은 판', 'the latest branch name is remembered for labels');

  // 버전 저장소가 없는 문서는 예전처럼 문서마다 묶인다.
  const plain = await store.bindSession({ documentId: 'doc-plain', documentName: '메모.hwpx' });
  assert.notEqual(plain, projectId);
  assert.equal(await store.bindSession({ documentId: 'doc-unknown', create: false }), null, 'project-bind never creates a project');
});

test('a merge that stopped midway resumes on the next boot without duplicating items or history', async (t) => {
  const { parent, open, referenceStore, store } = await fixture(t);
  const projectId = await store.projectForDocument('doc-main', { name: '보고서.hwpx' });
  await addText(referenceStore, store, projectId, 'main.txt', '본문 근거');
  const { strayId, file, noteId } = await strayWorktreeProject(referenceStore, store);
  const projectsRoot = path.join(parent, 'projects');
  const strayBackup = path.join(parent, 'stray-backup');
  await fs.cp(path.join(projectsRoot, strayId), strayBackup, { recursive: true });
  const indexBefore = JSON.parse(await fs.readFile(path.join(projectsRoot, 'index.json'), 'utf8'));

  await store.bindSession({ documentId: 'doc-variant', repository: repository('wt-variant') });
  const after = await store.get(projectId);
  const activityAfter = await store.listActivity(projectId, { limit: 200 });

  // 대상 project.json 과 파일 이동은 끝났지만 원본을 지우기 전에 멈춘 상태를 만든다.
  await fs.cp(strayBackup, path.join(projectsRoot, strayId), { recursive: true });
  const journal = JSON.parse(await fs.readFile(path.join(projectsRoot, 'index.json'), 'utf8'));
  await fs.writeFile(path.join(projectsRoot, 'index.json'), JSON.stringify({
    ...indexBefore,
    pendingMerges: { [strayId]: { into: projectId, memberNode: after.members[0].nodeId } },
  }));

  const reopened = await open();
  assert.equal(reopened.store.hasProject(strayId), true);
  await reopened.store.repairReferences();
  assert.equal(reopened.store.hasProject(strayId), false);
  const resumed = await reopened.store.get(projectId);
  assert.deepEqual(resumed.items.map((item) => item.id).sort(), after.items.map((item) => item.id).sort());
  assert.equal(resumed.links.length, after.links.length);
  assert.equal((await reopened.store.listActivity(projectId, { limit: 200 })).length, activityAfter.length + 0);
  assert.equal((await reopened.store.readNote(projectId, noteId)).body, `[[${file.id}]] 를 줄여 쓴다.`);
  assert.equal(reopened.store.projectIdForDocument('doc-variant'), projectId);
  assert.ok(journal.repositoryProjects['repo-1'] === projectId);
  assert.equal(await reopened.store.bindSession({ documentId: 'doc-variant', repository: repository('wt-variant') }), projectId);
  assert.equal((await reopened.store.get(projectId)).items.length, after.items.length);
});

test('new items are labeled by worktree, label ops relabel and undo, and the librarian never touches labels', async (t) => {
  const { referenceStore, store } = await fixture(t);
  const projectId = await store.bindSession({ documentId: 'doc-main', documentName: '보고서.hwpx', repository: repository('wt-main') });
  const variant = normalizeRepository(repository('wt-variant'));
  const main = normalizeRepository(repository('wt-main'));
  const lonePrimary = normalizeRepository({ id: 'repo-2', worktree: { id: 'wt-solo', branch: 'main', primary: true }, worktrees: [] });
  assert.deepEqual(originLabels(lonePrimary).auto, null, 'a single primary worktree labels nothing');
  assert.deepEqual(originLabels(main).auto, { worktreeId: 'wt-main', branch: 'main' }, 'the primary labels once a variant exists');

  const file = await addText(referenceStore, store, projectId, 'variant.txt', '요약 근거', { origin: originLabels(variant).auto });
  assert.deepEqual(file.origin, { worktreeId: 'wt-variant', branch: '요약본' });
  const created = await store.applyOps(projectId, {
    actor: agent,
    labels: originLabels(variant),
    ops: [{ op: 'note', name: '요약 메모', body: '짧게' }, { op: 'link', from: file.id, to: (await store.get(projectId)).members[0].nodeId, label: '근거' }],
  });
  const noteId = created.created[0];
  const linkId = created.created[1];
  assert.deepEqual((await store.getItem(projectId, noteId)).origin, { worktreeId: 'wt-variant', branch: '요약본' });
  assert.deepEqual((await store.get(projectId)).links.find((link) => link.id === linkId).worktreeOrigin, { worktreeId: 'wt-variant', branch: '요약본' });

  // 공통으로 돌리고, 기본 작업 공간 채팅이 'current' 로 다시 붙이고, 되돌리면 원래 표시가 돌아온다.
  await store.applyOps(projectId, { actor: user, labels: originLabels(main), ops: [{ op: 'label', id: noteId, origin: 'shared' }] });
  assert.equal((await store.getItem(projectId, noteId)).origin, undefined);
  const relabeled = await store.applyOps(projectId, { actor: user, labels: originLabels(main), ops: [{ op: 'label', id: file.id, origin: 'current' }] });
  assert.deepEqual((await store.getItem(projectId, file.id)).origin, { worktreeId: 'wt-main', branch: 'main' });
  await store.undo(projectId, { activityId: relabeled.activityId });
  assert.deepEqual((await store.getItem(projectId, file.id)).origin, { worktreeId: 'wt-variant', branch: '요약본' });
  await store.applyOps(projectId, { actor: user, labels: originLabels(main), ops: [{ op: 'label', id: linkId, origin: 'shared' }] });
  assert.equal((await store.get(projectId)).links.find((link) => link.id === linkId).worktreeOrigin, undefined);
  await assert.rejects(
    store.applyOps(projectId, { actor: user, ops: [{ op: 'label', id: file.id, origin: 'current' }] }),
    (error) => error.code === 'PROJECT_OP_INVALID',
    'a chat without a worktree cannot label current',
  );
  await assert.rejects(
    store.applyOps(projectId, { actor: { kind: 'librarian' }, ops: [{ op: 'label', id: file.id, origin: 'shared' }] }),
    (error) => error.code === 'PROJECT_OP_INVALID',
  );
  // 정리 도우미가 만든 연결은 표시를 받지 않는다.
  await store.applyOps(projectId, { actor: { kind: 'librarian' }, labels: originLabels(variant), ops: [{ op: 'link', from: file.id, to: noteId, label: '관련' }] });
  assert.equal((await store.get(projectId)).links.find((link) => link.label === '관련').worktreeOrigin, undefined);
});

test('the prompt context names the current worktree and marks items gathered in another one', async (t) => {
  const { referenceStore, store } = await fixture(t);
  const projectId = await store.bindSession({ documentId: 'doc-main', repository: repository('wt-main') });
  await store.bindSession({ documentId: 'doc-variant', repository: repository('wt-variant', { renamed: '짧은 판' }) });
  const variant = normalizeRepository(repository('wt-variant'));
  const main = normalizeRepository(repository('wt-main'));
  const fromVariant = await addText(referenceStore, store, projectId, 'variant.txt', '요약 근거', { origin: originLabels(variant).auto });
  const fromMain = await addText(referenceStore, store, projectId, 'main.txt', '본문 근거', { origin: originLabels(main).auto });
  const shared = await addText(referenceStore, store, projectId, 'shared.txt', '공통 근거');

  const read = async (repo) => {
    const block = await projectPromptContext({
      projectStore: store,
      referenceStore,
      projectId,
      scopes: [{ scope: 'project', scopeId: projectId }],
      query: '근거',
      mentions: [fromVariant.id],
      settings: DEFAULT_PROJECT_SETTINGS,
      worktree: repo.worktree,
      worktreeCount: repo.worktrees.length,
      worktreeBranch: (id) => store.worktreeBranch(id),
    });
    return JSON.parse(/<research_project trust="untrusted-data">\n(.*)\n<\/research_project>/s.exec(block)[1]);
  };
  const fromMainView = await read(main);
  assert.deepEqual(fromMainView.worktree, { branch: 'main', primary: true });
  const top = fromMainView.project.board.flatMap((column) => column.top ?? []);
  // 다른 작업 공간 항목만 wt 를 싣고, 이름은 지금 브랜치 이름을 따른다.
  assert.equal(top.find((entry) => entry.id === fromVariant.id).wt, '짧은 판');
  assert.equal(top.find((entry) => entry.id === fromMain.id).wt, undefined);
  assert.equal(top.find((entry) => entry.id === shared.id).wt, undefined);
  assert.equal(fromMainView.mentioned[0].wt, '짧은 판');
  assert.equal(fromMainView.excerpts.find((entry) => entry.itemId === fromVariant.id)?.wt, '짧은 판');

  const fromVariantView = await read(variant);
  assert.deepEqual(fromVariantView.worktree, { branch: '요약본', primary: false });
  const variantTop = fromVariantView.project.board.flatMap((column) => column.top ?? []);
  assert.equal(variantTop.find((entry) => entry.id === fromMain.id).wt, 'main');
  assert.equal(variantTop.find((entry) => entry.id === fromVariant.id).wt, undefined);
});
