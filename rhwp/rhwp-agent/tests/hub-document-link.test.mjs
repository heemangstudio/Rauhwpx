// 실제 허브로 문서 없는 채팅의 문서 연결(chat-link-document, open_document·create_document)과 자료함 저장 게이트를 확인한다.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ProjectStore } from '../project-store.mjs';
import { createReferenceCatalog } from '../reference-catalog.mjs';
import { registerHubSession } from '../../../desktop/agent-hub.mjs';
import { HUB_TOKEN, connect, startLiveHub } from './live-hub-fixture.mjs';

const NO_DOCUMENT = { documentName: null };
const LAUNCH_ID = 'live-hub-launch';

function tempDir(t, prefix) {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** 문서 없는 채팅을 시작하고 턴을 붙잡아 둔 뒤 그 턴의 MCP 호출 도우미를 돌려준다. */
async function noDocumentTurn(t, { hubOptions = {}, selection = {} } = {}) {
  const hub = await startLiveHub(t, { documentId: null, ...hubOptions });
  const started = await hub.start({ ...NO_DOCUMENT, ...selection });
  hub.message('HOLD');
  await hub.studio.next((frame) => frame.type === 'agent-event' && frame.event.text === 'HOLD_READY');
  const mcp = await connect(`ws://127.0.0.1:${hub.port}/mcp?token=${HUB_TOKEN}&sessionId=${hub.sessionId}&agent=pi`);
  t.after(() => mcp.socket.close());
  let id = 0;
  const call = async (tool, args, extra = {}) => {
    const callId = ++id;
    mcp.send({ type: 'tool-call', id: callId, tool, args, workflow: started.workflow, capabilityEpoch: started.capabilityEpoch, ...extra });
    return mcp.next((frame) => frame.type === 'tool-result' && frame.id === callId);
  };
  return { hub, started, call };
}

async function piToolNames(hub) {
  const url = `http://127.0.0.1:${hub.port}/pi/tool-definitions?token=${HUB_TOKEN}&sessionId=${hub.sessionId}&role=chat`;
  const response = await fetch(url, { headers: { Origin: 'http://127.0.0.1:7700' } });
  assert.equal(response.status, 200);
  return (await response.json()).map((definition) => definition.name);
}

/** Studio 처럼 문서를 열어 연결한 뒤 도구에 답한다 — 연결 프레임이 응답보다 먼저 간다. */
async function answerLink(hub, tool, { documentId, documentName, revision = 1, createdByThread = false }) {
  const request = await hub.studio.next((frame) => frame.type === 'tool-request' && frame.tool === tool);
  hub.studio.send({ type: 'chat-link-document', documentId, documentName, ...(createdByThread ? { createdByThread } : {}) });
  hub.studio.send({ type: 'tool-response', id: request.id, ok: true, result: { documentId, name: documentName, revision, linked: true } });
  return request;
}

function respondPermission(hub, request, decision, responseId) {
  hub.studio.send({
    type: 'chat-permission-response', requestId: request.requestId, responseId,
    threadId: request.threadId, documentId: request.documentId, decision,
  });
}

test('a no-document chat has no project and links a document mid-turn without a provider restart', { timeout: 60_000 }, async (t) => {
  const hub = await startLiveHub(t, { documentId: null });
  const started = await hub.start(NO_DOCUMENT);
  assert.equal(started.documentId, null);
  assert.equal(started.projectId, null, 'no implicit 채팅 자료 project');
  assert.ok((await piToolNames(hub)).includes('open_document'));
  const first = await hub.promptOf('안녕');
  assert.match(first, /No document is linked to this chat/);

  hub.message('HOLD');
  await hub.studio.next((frame) => frame.type === 'agent-event' && frame.event.text === 'HOLD_READY');
  const mcp = await connect(`ws://127.0.0.1:${hub.port}/mcp?token=${HUB_TOKEN}&sessionId=${hub.sessionId}&agent=pi`);
  t.after(() => mcp.socket.close());
  let id = 0;
  const call = async (tool, args) => {
    const callId = ++id;
    mcp.send({ type: 'tool-call', id: callId, tool, args, workflow: started.workflow, capabilityEpoch: started.capabilityEpoch });
    return mcp.next((frame) => frame.type === 'tool-result' && frame.id === callId);
  };
  assert.equal((await call('project_read', { view: 'summary' })).result.project, null);

  hub.studio.send({ type: 'chat-link-document', documentId: 'doc-linked', documentName: '연결.hwpx' });
  const linked = await hub.studio.next((frame) => frame.type === 'chat-document-linked');
  assert.equal(linked.documentId, 'doc-linked');
  assert.equal(linked.documentName, '연결.hwpx');
  assert.equal(linked.threadId, started.threadId);
  assert.match(linked.projectId, /^p/);
  assert.equal((await hub.studio.next((frame) => frame.type === 'project-bound')).projectId, linked.projectId);

  // 같은 공급자 MCP 연결이 그대로 통하고, 문서 정보에는 연결한 문서가 찍힌다.
  const info = call('get_document_info', {});
  const request = await hub.studio.next((frame) => frame.type === 'tool-request' && frame.tool === 'get_document_info');
  hub.studio.send({ type: 'tool-response', id: request.id, ok: true, result: { revision: 4, digest: 'd', sourceFormat: 'hwpx', dirty: false } });
  const infoResult = await info;
  assert.equal(infoResult.ok, true, JSON.stringify(infoResult));
  assert.equal(infoResult.result.documentId, 'doc-linked');
  assert.equal((await call('project_read', { view: 'summary' })).result.id, linked.projectId);
  assert.ok(!(await piToolNames(hub)).includes('open_document'), 'link tools are gone after a link');

  // 연결은 영구적이다. 같은 문서를 다시 보내면 같은 답을 한다.
  hub.studio.send({ type: 'chat-link-document', requestId: 'again', documentId: 'doc-other', documentName: '다른.hwpx' });
  const refused = await hub.studio.next((frame) => frame.type === 'chat-error' && frame.requestId === 'again');
  assert.equal(refused.code, 'THREAD_ALREADY_LINKED');
  assert.equal(refused.linkedDocumentId, 'doc-linked');
  hub.studio.send({ type: 'chat-link-document', documentId: 'doc-linked', documentName: '연결.hwpx' });
  assert.equal((await hub.studio.next((frame) => frame.type === 'chat-document-linked')).projectId, linked.projectId);
  assert.equal((await call('open_document', { documentId: 'doc-other' })).error.code, 'THREAD_ALREADY_LINKED');

  hub.studio.send({ type: 'chat-interrupt' });
  await hub.studio.next((frame) => frame.type === 'agent-event' && frame.event.type === 'turn-end');
  const next = await hub.promptOf('이어서', { documentId: 'doc-linked' });
  assert.match(next, /"documentId":"doc-linked","documentName":"연결.hwpx"/);
  assert.doesNotMatch(next, /No document is linked/);
});

test('each link asks once, is never kept as a chat grant, and expires', { timeout: 60_000 }, async (t) => {
  const home = tempDir(t, 'rhwp-link-home-');
  const folder = path.join(home, '보고서');
  mkdirSync(folder);
  writeFileSync(path.join(home, 'legacy.hwpml'), '<HWPML/>');
  const { hub, started, call } = await noDocumentTurn(t, {
    hubOptions: { env: { RHWP_HOME_ACCESS: '1', HOME: home, RHWP_DOCUMENT_LINK_CONSENT_TIMEOUT_MS: '1500' } },
  });

  // 하위 작업은 연결하지 못하고, 다시 저장할 수 없는 형식·홈 밖 폴더는 묻기 전에 거절된다.
  assert.equal((await call('open_document', { documentId: 'doc-a' }, { parentTaskId: 'task-1' })).error.code, 'ROOT_INTERACTION_REQUIRED');
  assert.equal((await call('open_document', { path: path.join(home, 'legacy.hwpml') })).error.code, 'PATH_REJECTED');
  assert.equal((await call('create_document', { name: '보고서', folder: os.tmpdir() })).error.code, 'PATH_REJECTED');
  assert.equal((await call('create_document', { name: '../보고서' })).error.code, 'INVALID_ARGS');
  assert.equal(hub.studio.frames.some((frame) => frame.type === 'chat-permission-requested'), false);

  const denied = call('open_document', { documentId: 'doc-a' });
  const deniedRequest = (await hub.studio.next((frame) => frame.type === 'chat-permission-requested')).request;
  assert.equal(deniedRequest.capability, 'document-link');
  assert.equal(deniedRequest.kind, 'open');
  assert.equal(deniedRequest.linkDocumentId, 'doc-a');
  assert.equal(deniedRequest.documentId, null);
  respondPermission(hub, deniedRequest, 'deny', 'deny-a');
  assert.equal((await hub.studio.next((frame) => frame.type === 'chat-permission-response-result')).ok, true);
  assert.equal((await denied).error.code, 'PERMISSION_DENIED');

  const expired = call('open_document', { documentId: 'doc-b' });
  await hub.studio.next((frame) => frame.type === 'chat-permission-requested');
  const resolved = await hub.studio.next((frame) => frame.type === 'chat-permission-resolved' && frame.outcome.status === 'expired');
  assert.equal(resolved.outcome.reason, 'timeout');
  const expiredError = (await expired).error;
  assert.equal(expiredError.code, 'PERMISSION_DENIED');
  assert.match(expiredError.message, /expired/);

  const created = call('create_document', { name: '분기 보고서.hwpx', folder });
  const createRequest = (await hub.studio.next((frame) => frame.type === 'chat-permission-requested')).request;
  assert.equal(createRequest.kind, 'create');
  assert.equal(createRequest.documentName, '분기 보고서.hwpx');
  assert.equal(createRequest.path, folder);
  respondPermission(hub, createRequest, 'grant', 'grant-create');
  assert.equal((await hub.studio.next((frame) => frame.type === 'chat-permission-response-result')).ok, true);
  const granted = await hub.studio.next((frame) => frame.type === 'chat-permission-resolved' && frame.requestId === createRequest.requestId);
  assert.equal(granted.outcome.status, 'granted');
  assert.deepEqual(granted.grants, [], 'a document link is never a chat-wide grant');
  const forwarded = await answerLink(hub, 'create_document', { documentId: 'doc-new', documentName: '분기 보고서.hwpx', revision: 9, createdByThread: true });
  assert.deepEqual(forwarded.args, { name: '분기 보고서', folder });
  const result = await created;
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.result, { documentId: 'doc-new', name: '분기 보고서.hwpx', revision: 9, linked: true });
  assert.equal((await hub.studio.next((frame) => frame.type === 'chat-document-linked')).documentId, 'doc-new');
  assert.equal((await call('create_document', { name: '하나 더' })).error.code, 'THREAD_ALREADY_LINKED');
  assert.equal(started.documentId, null);
});

test('create_document without a folder shows the default folder but lets the desktop make it', { timeout: 60_000 }, async (t) => {
  // 처음 쓰는 컴퓨터: 문서 폴더 아래 HamaEditor 가 아직 없다.
  const home = tempDir(t, 'rhwp-link-fresh-home-');
  const documents = path.join(home, '문서');
  const { hub, call } = await noDocumentTurn(t, {
    hubOptions: { env: { RHWP_HOME_ACCESS: '1', HOME: home, RHWP_DOCUMENTS_DIR: documents } },
  });
  const created = call('create_document', { name: '회의록' });
  const request = (await hub.studio.next((frame) => frame.type === 'chat-permission-requested')).request;
  assert.equal(request.path, path.join(documents, 'HamaEditor'), 'the pill shows where the desktop writes');
  respondPermission(hub, request, 'grant', 'grant-default');
  const forwarded = await answerLink(hub, 'create_document', { documentId: 'doc-minutes', documentName: '회의록.hwpx', createdByThread: true });
  assert.deepEqual(forwarded.args, { name: '회의록' }, 'no folder goes to the desktop, which creates its default folder');
  assert.equal((await created).ok, true);
});

test('linking a document with version history binds the repository project, like chat-start', { timeout: 60_000 }, async (t) => {
  const hub = await startLiveHub(t, { documentId: null });
  const repository = {
    repositoryId: 'repo-link',
    worktrees: [
      { id: 'wt-main', branch: 'main', primary: true, documentId: 'doc-main' },
      { id: 'wt-variant', branch: '요약본', primary: false, documentId: 'doc-variant' },
    ],
  };
  const repositoryChat = await hub.start({
    threadId: 'thread-repository', documentId: 'doc-main', documentName: 'main.hwpx',
    ...repository, worktree: { id: 'wt-main', branch: 'main', primary: true },
  });
  assert.match(repositoryChat.projectId, /^p/);
  await hub.start(NO_DOCUMENT);
  hub.studio.send({
    type: 'chat-link-document', documentId: 'doc-variant', documentName: '요약본.hwpx',
    ...repository, worktree: { id: 'wt-variant', branch: '요약본', primary: false },
  });
  const linked = await hub.studio.next((frame) => frame.type === 'chat-document-linked');
  assert.equal(linked.projectId, repositoryChat.projectId, 'the variant joins its repository project, not a new per-document one');
});

test('a chat linked in one window cannot be linked to another document from a second window', { timeout: 60_000 }, async (t) => {
  const hub = await startLiveHub(t, { documentId: null });
  await hub.start(NO_DOCUMENT);
  const sessionId = 'live-hub-second';
  const capabilities = await registerHubSession({ port: hub.port, token: HUB_TOKEN, launchId: LAUNCH_ID, sessionId });
  const second = await connect(
    `ws://127.0.0.1:${hub.port}/studio?token=${capabilities.studio}&sessionId=${sessionId}&instance=second-window`,
    { origin: 'http://127.0.0.1:7700' },
  );
  t.after(() => second.socket.close());
  await hub.start(NO_DOCUMENT, second);

  hub.studio.send({ type: 'chat-link-document', documentId: 'doc-first', documentName: '첫 창.hwpx' });
  assert.equal((await hub.studio.next((frame) => frame.type === 'chat-document-linked')).documentId, 'doc-first');
  second.send({ type: 'chat-link-document', requestId: 'second-link', documentId: 'doc-second', documentName: '둘째 창.hwpx' });
  const refused = await second.next((frame) => frame.requestId === 'second-link');
  assert.equal(refused.type, 'chat-error', JSON.stringify(refused));
  assert.equal(refused.code, 'THREAD_ALREADY_LINKED');
  assert.equal(refused.linkedDocumentId, 'doc-first');
});

test('the project save gate needs a document; 전체 links without asking and then saves', { timeout: 60_000 }, async (t) => {
  const { hub, call } = await noDocumentTurn(t, { selection: { permissionProfile: 'unrestricted' } });
  const note = { ops: [{ op: 'note', name: '근거', body: '예산 근거 메모' }] };

  const blocked = (await call('project_edit', note)).error;
  assert.equal(blocked.code, 'DOCUMENT_REQUIRED');
  assert.match(blocked.message, /create_document or link one with open_document/);
  assert.deepEqual(
    (({ type, tool, reason }) => ({ type, tool, reason }))(await hub.studio.next((frame) => frame.type === 'document-required')),
    { type: 'document-required', tool: 'project_edit', reason: 'project-save' },
  );
  assert.equal((await call('project_import', { text: '자료', name: '자료.txt' })).error.code, 'DOCUMENT_REQUIRED');
  assert.equal((await hub.studio.next((frame) => frame.type === 'document-required')).tool, 'project_import');

  const opened = call('open_document', { documentId: 'doc-full' });
  const request = await answerLink(hub, 'open_document', { documentId: 'doc-full', documentName: '전체.hwpx', revision: 3 });
  assert.deepEqual(request.args, { documentId: 'doc-full' });
  assert.equal((await opened).ok, true);
  assert.equal(hub.studio.frames.some((frame) => frame.type === 'chat-permission-requested'), false, '전체 skips the link question');

  const saved = await call('project_edit', note);
  assert.equal(saved.ok, true, JSON.stringify(saved));
  const linked = await hub.studio.next((frame) => frame.type === 'chat-document-linked');
  assert.equal((await call('project_read', { view: 'summary' })).result.id, linked.projectId);
});

test('an existing thread project stays bound and merges into the linked document project', { timeout: 60_000 }, async (t) => {
  // 예전 빌드가 만든 문서 없는 채팅의 "채팅 자료" 프로젝트를 심는다.
  const storage = tempDir(t, 'rhwp-link-projects-');
  const referencesRoot = path.join(storage, 'references');
  const projectsRoot = path.join(storage, 'projects');
  const referenceStore = await createReferenceCatalog({ referencesRoot, projectsRoot }).init();
  const seed = await new ProjectStore({ root: projectsRoot, referenceStore }).init();
  const legacyId = (await seed.createProject({ name: '채팅 자료' })).id;
  await seed.applyOps(legacyId, { actor: { kind: 'user' }, ops: [{ op: 'note', name: '옛 메모', body: '문서 없을 때 모은 근거' }] });
  const projectFile = path.join(projectsRoot, legacyId, 'project.json');
  writeFileSync(projectFile, JSON.stringify({ ...JSON.parse(readFileSync(projectFile, 'utf8')), implicit: true, nameSource: 'default' }));
  const indexFile = path.join(projectsRoot, 'index.json');
  const index = JSON.parse(readFileSync(indexFile, 'utf8'));
  index.projects[legacyId].implicit = true;
  index.threadProjects['thread-live'] = legacyId;
  writeFileSync(indexFile, JSON.stringify(index));

  const { hub, started, call } = await noDocumentTurn(t, {
    hubOptions: { env: { RHWP_REFERENCES_DIR: referencesRoot, RHWP_PROJECTS_DIR: projectsRoot } },
  });
  assert.equal(started.projectId, legacyId, 'the old thread project stays readable');
  assert.equal((await call('project_read', { view: 'summary' })).result.counts.notes, 1);
  assert.equal((await call('project_edit', { ops: [{ op: 'note', name: '새 메모', body: '본문' }] })).error.code, 'DOCUMENT_REQUIRED');
  // 받은 파일함으로의 다운로드는 열려 있다 — 예전 스레드 프로젝트로 들어가지 않으니 문서를 요구하지 않고 주소 검사까지 간다.
  const download = await call('download_file', { url: 'http://127.0.0.1/private.txt' });
  assert.equal(download.error?.code, 'DOWNLOAD_ADDRESS_BLOCKED', JSON.stringify(download));

  hub.studio.send({ type: 'chat-link-document', documentId: 'doc-adopt', documentName: '정리.hwpx' });
  const linked = await hub.studio.next((frame) => frame.type === 'chat-document-linked');
  assert.notEqual(linked.projectId, legacyId);
  const summary = (await call('project_read', { view: 'summary' })).result;
  assert.equal(summary.id, linked.projectId);
  assert.equal(summary.counts.notes, 1, 'the thread project merged into the document project');
  assert.deepEqual(summary.documents.map((entry) => entry.name), ['정리.hwpx']);
});
