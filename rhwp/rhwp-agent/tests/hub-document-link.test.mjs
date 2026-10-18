// 실제 허브로 채팅의 문서 붙이기·떼기(chat-link-document·chat-detach-document, open_document·create_document·detach_document)와
// 자료함 저장 게이트를 확인한다.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ProjectStore } from '../project-store.mjs';
import { createReferenceCatalog } from '../reference-catalog.mjs';
import { registerHubSession } from '../../../desktop/agent-hub.mjs';
import { once } from 'node:events';
import { HUB_TOKEN, connect, startLiveHub } from './live-hub-fixture.mjs';

const PI_MODULE_URL = new URL('../agents/pi.mjs', import.meta.url).href;

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

test('a no-document chat has no project and links a document mid-turn without a provider restart', { timeout: 60_000 }, async (t) => {
  const hub = await startLiveHub(t, { documentId: null });
  const started = await hub.start(NO_DOCUMENT);
  assert.equal(started.documentId, null);
  assert.equal(started.projectId, null, 'no implicit 채팅 자료 project');
  assert.ok((await piToolNames(hub)).includes('open_document'));
  const first = await hub.promptOf('안녕');
  assert.match(first, /No document is linked to this chat/);
  assert.match(first, /one document at a time; detach_document or the user can detach it later/);
  assert.doesNotMatch(first, /for good|permanent/);

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
  assert.ok((await piToolNames(hub)).includes('detach_document'), 'an attached chat can detach itself');

  // 연결된 채팅은 다른 문서로 바꾸지 못한다(먼저 뗀다). 같은 문서를 다시 보내면 같은 답을 한다.
  hub.studio.send({ type: 'chat-link-document', requestId: 'again', documentId: 'doc-other', documentName: '다른.hwpx' });
  const refused = await hub.studio.next((frame) => frame.type === 'chat-error' && frame.requestId === 'again');
  assert.equal(refused.code, 'THREAD_ALREADY_LINKED');
  assert.equal(refused.linkedDocumentId, 'doc-linked');
  hub.studio.send({ type: 'chat-link-document', documentId: 'doc-linked', documentName: '연결.hwpx' });
  assert.equal((await hub.studio.next((frame) => frame.type === 'chat-document-linked')).projectId, linked.projectId);
  const switching = (await call('open_document', { documentId: 'doc-other' })).error;
  assert.equal(switching.code, 'THREAD_ALREADY_LINKED');
  assert.match(switching.message, /call detach_document first/);

  hub.studio.send({ type: 'chat-interrupt' });
  await hub.studio.next((frame) => frame.type === 'agent-event' && frame.event.type === 'turn-end');
  const next = await hub.promptOf('이어서', { documentId: 'doc-linked' });
  assert.match(next, /"documentId":"doc-linked","documentName":"연결.hwpx"/);
  assert.doesNotMatch(next, /No document is linked/);
  // 연결은 다음 사용자 턴에 한 번 알린다 (다시 보낸 같은 문서 연결은 쌓지 않는다).
  assert.equal(next.split('This chat is now attached to the document "연결.hwpx" (documentId doc-linked)').length, 2, next);
  assert.doesNotMatch(await hub.promptOf('또', { documentId: 'doc-linked' }), /<document_change/);
});

test('the agent detaches mid-turn; the hub answers once the moved chat\'s new bridge connects', { timeout: 60_000 }, async (t) => {
  const hub = await startLiveHub(t, { documentId: 'doc-old' });
  const started = await hub.start({ documentName: '옛 문서.hwpx' });
  assert.match(started.projectId, /^p/);
  hub.message('HOLD', { documentId: 'doc-old' });
  await hub.studio.next((frame) => frame.type === 'agent-event' && frame.event.text === 'HOLD_READY');
  const mcp = await connect(`ws://127.0.0.1:${hub.port}/mcp?token=${HUB_TOKEN}&sessionId=${hub.sessionId}&agent=pi`);
  t.after(() => mcp.socket.close());
  let id = 0;
  const call = (tool, args) => {
    const callId = ++id;
    mcp.send({ type: 'tool-call', id: callId, tool, args, workflow: started.workflow, capabilityEpoch: started.capabilityEpoch });
    return mcp.next((frame) => frame.type === 'tool-result' && frame.id === callId);
  };

  // Studio 가 채팅을 빈 문서 자리로 옮기기 직전에 떼기를 알린다. 허브는 세션의 문서를 비우고 호출을 맡는다.
  const detaching = call('detach_document', {});
  const request = await hub.studio.next((frame) => frame.type === 'tool-request' && frame.tool === 'detach_document');
  hub.studio.send({ type: 'chat-detach-document', requestId: 'detach', threadId: hub.threadId, documentId: 'doc-old', callId: request.id });
  assert.deepEqual(
    (({ type, threadId, documentId }) => ({ type, threadId, documentId }))(await hub.studio.next((frame) => frame.requestId === 'detach')),
    { type: 'chat-document-detached', threadId: hub.threadId, documentId: 'doc-old' },
  );
  await hub.studio.next((frame) => frame.type === 'project-bound' && frame.projectId === null);
  let answered = false;
  void detaching.then(() => { answered = true; });

  // 옛 브리지가 닫히고 같은 페이지의 새 브리지가 같은 허브 세션에 붙는다 — 그 뒤에야 공급자가 결과를 받는다.
  hub.studio.socket.close();
  await once(hub.studio.socket, 'close');
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(answered, false, 'the provider waits until the new bridge is attached');
  const bridge = await connect(hub.studioUrl, { origin: 'http://127.0.0.1:7700' });
  t.after(() => bridge.socket.close());
  const welcome = await bridge.next((frame) => frame.type === 'welcome');
  assert.deepEqual(
    (({ status, documentId, documentName }) => ({ status, documentId, documentName }))(welcome.session),
    { status: 'running', documentId: null, documentName: null },
  );
  const result = await detaching;
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.result, { detached: true, documentId: 'doc-old', documentName: '옛 문서.hwpx' });

  // 같은 턴에서 다른 문서를 붙인다. 문서 없는 채팅의 일이라 떼기를 다시 부르면 거절된다.
  assert.equal((await call('detach_document', {})).error.code, 'NO_DOCUMENT');
  const opened = call('open_document', { documentId: 'doc-next' });
  const linkRequest = await bridge.next((frame) => frame.type === 'tool-request' && frame.tool === 'open_document');
  bridge.send({ type: 'chat-link-document', documentId: 'doc-next', documentName: '다음.hwpx' });
  bridge.send({ type: 'tool-response', id: linkRequest.id, ok: true, result: { documentId: 'doc-next', name: '다음.hwpx', revision: 2, linked: true } });
  assert.equal((await opened).ok, true);
  const attached = await bridge.next((frame) => frame.type === 'chat-document-linked');
  assert.notEqual(attached.projectId, started.projectId);

  bridge.send({ type: 'chat-interrupt' });
  await bridge.next((frame) => frame.type === 'agent-event' && frame.event.type === 'turn-end');
  hub.message('이어서', { documentId: 'doc-next' }, bridge);
  const delta = await bridge.next((frame) => frame.type === 'agent-event' && frame.event.type === 'text-delta');
  const prompt = JSON.parse(delta.event.text).prompt;
  assert.doesNotMatch(prompt, /The user detached/, 'the agent detached by itself; only the attach is news');
  assert.match(prompt, /This chat is now attached to the document "다음.hwpx" \(documentId doc-next\)\./);
});

test('the root conversation attaches without asking; unopenable paths are refused first', { timeout: 60_000 }, async (t) => {
  const home = tempDir(t, 'rhwp-link-home-');
  const folder = path.join(home, '보고서');
  mkdirSync(folder);
  writeFileSync(path.join(home, 'legacy.hwpml'), '<HWPML/>');
  const { hub, started, call } = await noDocumentTurn(t, {
    hubOptions: { env: { RHWP_HOME_ACCESS: '1', HOME: home } },
  });

  // 하위 작업은 붙이거나 떼지 못하고, 다시 저장할 수 없는 형식·홈 밖 폴더는 Studio 에 가기 전에 거절된다.
  assert.equal((await call('open_document', { documentId: 'doc-a' }, { parentTaskId: 'task-1' })).error.code, 'ROOT_INTERACTION_REQUIRED');
  assert.equal((await call('detach_document', {})).error.code, 'NO_DOCUMENT');
  assert.equal((await call('open_document', { path: path.join(home, 'legacy.hwpml') })).error.code, 'PATH_REJECTED');
  assert.equal((await call('create_document', { name: '보고서', folder: os.tmpdir() })).error.code, 'PATH_REJECTED');
  assert.equal((await call('create_document', { name: '../보고서' })).error.code, 'INVALID_ARGS');

  const created = call('create_document', { name: '분기 보고서.hwpx', folder });
  const forwarded = await answerLink(hub, 'create_document', { documentId: 'doc-new', documentName: '분기 보고서.hwpx', revision: 9, createdByThread: true });
  assert.deepEqual(forwarded.args, { name: '분기 보고서', folder });
  const result = await created;
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.result, { documentId: 'doc-new', name: '분기 보고서.hwpx', revision: 9, linked: true });
  assert.equal((await hub.studio.next((frame) => frame.type === 'chat-document-linked')).documentId, 'doc-new');
  assert.equal(hub.studio.frames.some((frame) => frame.type === 'chat-permission-requested'), false, 'linking never asks');
  assert.equal((await call('create_document', { name: '하나 더' })).error.code, 'THREAD_ALREADY_LINKED');
  assert.equal(started.documentId, null);
});

test('create_document without a folder lets the desktop pick its default folder', { timeout: 60_000 }, async (t) => {
  const home = tempDir(t, 'rhwp-link-fresh-home-');
  const { hub, call } = await noDocumentTurn(t, {
    hubOptions: { env: { RHWP_HOME_ACCESS: '1', HOME: home, RHWP_DOCUMENTS_DIR: path.join(home, '문서') } },
  });
  const created = call('create_document', { name: '회의록' });
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

test('the project save gate needs a document; linking it then saves', { timeout: 60_000 }, async (t) => {
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

/** 수동 압축을 받는 Pi — 받은 compact() 인자를 글로 되돌려 주고 턴을 닫는다. 나머지는 실제 Pi 어댑터다. */
function compactingPiArgs(t) {
  const dir = tempDir(t, 'rhwp-compacting-pi-');
  const realUrl = `${PI_MODULE_URL}?compacting-real`;
  const source = `
    export * from ${JSON.stringify(realUrl)};
    import { createPiSession as createRealPiSession } from ${JSON.stringify(realUrl)};
    export function createPiSession(opts, ...rest) {
      const session = createRealPiSession(opts, ...rest);
      session.compactionSupport = 'manual';
      session.compact = (options) => setTimeout(() => {
        opts.onEvent({ type: 'turn-start', agent: 'pi' });
        opts.onEvent({ type: 'text-delta', agent: 'pi', text: JSON.stringify({ compact: options ?? null }) });
        opts.onEvent({ type: 'turn-end', agent: 'pi', stopReason: 'completed' });
      }, 0);
      return session;
    }
  `;
  writeFileSync(path.join(dir, 'loader.mjs'), `
    export async function load(url, context, nextLoad) {
      if (url === ${JSON.stringify(PI_MODULE_URL)}) return { format: 'module', shortCircuit: true, source: ${JSON.stringify(source)} };
      return nextLoad(url, context);
    }
  `);
  const preload = path.join(dir, 'preload.mjs');
  writeFileSync(preload, "import { register } from 'node:module'; register(new URL('./loader.mjs', import.meta.url));\n");
  return ['--import', preload];
}

const DETACHED = { documentId: null, documentName: null, detachedFrom: { documentId: 'doc-old', documentName: '옛 문서.hwpx' } };
const DETACH_LINE = 'The user detached this chat from the document "옛 문서.hwpx" (documentId doc-old).';
const occurrences = (text, needle) => text.split(needle).length - 1;

test('a detached chat hears about it once, compacts with detach instructions and gets the link tools back', { timeout: 60_000 }, async (t) => {
  const hub = await startLiveHub(t, { documentId: 'doc-old', nodeArgs: compactingPiArgs(t) });
  await hub.start({ documentName: '옛 문서.hwpx' });
  assert.ok((await piToolNames(hub)).includes('detach_document'));

  // 떼어 낸 채팅은 문서 없이 다시 시작한다. 재연결로 같은 chat-start 가 다시 와도 알림은 하나다.
  const detached = await hub.start(DETACHED);
  assert.equal(detached.documentId, null);
  assert.equal(detached.compaction, 'manual');
  await hub.start(DETACHED);
  assert.ok((await piToolNames(hub)).includes('open_document'), 'a detached chat can attach again');
  const first = await hub.promptOf('계속', { documentId: null });
  assert.equal(occurrences(first, '<document_change'), 1, first);
  assert.equal(occurrences(first, DETACH_LINE), 1);
  assert.match(first, /No document is linked now\. When the user wants to write or save, suggest attaching one with open_document or create_document\./);
  assert.match(first, /No document is linked to this chat/);
  // 이미 전한 떼어 냄은 다시 온 chat-start 로 되살아나지 않는다.
  await hub.start(DETACHED);
  assert.doesNotMatch(await hub.promptOf('다음', { documentId: null }), /<document_change/);

  const compact = async (requestId, extra) => {
    hub.studio.send({ type: 'chat-compact', requestId, threadId: hub.threadId, ...extra });
    assert.equal((await hub.studio.next((frame) => frame.requestId === requestId)).type, 'chat-compact-accepted');
    const delta = await hub.studio.next((frame) => frame.type === 'agent-event' && frame.event.type === 'text-delta');
    await hub.studio.next((frame) => frame.type === 'agent-event' && frame.event.type === 'turn-end');
    return JSON.parse(delta.event.text).compact;
  };
  assert.deepEqual(await compact('detach-compact', { reason: 'document-detached' }), {
    instructions: 'This chat was just detached from the document "옛 문서.hwpx" (documentId doc-old). Keep what the user and assistant discussed, decided and learned about it, since the user may need that context later; drop raw tool output. The chat can no longer edit that document or use its project files.',
  });
  assert.equal(await compact('plain-compact', {}), null, 'a plain compaction carries no instructions');
});

test('a malformed or linked detachedFrom is ignored', { timeout: 60_000 }, async (t) => {
  const hub = await startLiveHub(t, { documentId: null });
  await hub.start({ ...NO_DOCUMENT, detachedFrom: { documentId: 42 } });
  assert.doesNotMatch(await hub.promptOf('하나'), /<document_change/);
  await hub.start({ documentId: 'doc-now', documentName: '지금.hwpx', detachedFrom: DETACHED.detachedFrom });
  assert.doesNotMatch(await hub.promptOf('둘', { documentId: 'doc-now' }), /<document_change/);
});

test('attaching after a detach merges both into one note on the next user turn', { timeout: 60_000 }, async (t) => {
  const hub = await startLiveHub(t, { documentId: null });
  await hub.start(DETACHED);
  hub.studio.send({ type: 'chat-link-document', documentId: 'doc-new', documentName: '새 문서.hwpx' });
  assert.equal((await hub.studio.next((frame) => frame.type === 'chat-document-linked')).documentId, 'doc-new');
  const prompt = await hub.promptOf('붙였어', { documentId: 'doc-new' });
  assert.equal(occurrences(prompt, '<document_change'), 1, prompt);
  const block = prompt.slice(prompt.indexOf('<document_change'), prompt.indexOf('</document_change>'));
  assert.ok(block.indexOf(DETACH_LINE) >= 0 && block.indexOf(DETACH_LINE) < block.indexOf('This chat is now attached to the document "새 문서.hwpx" (documentId doc-new).'), block);
  assert.doesNotMatch(block, /No document is linked now/);
  assert.doesNotMatch(await hub.promptOf('그리고', { documentId: 'doc-new' }), /<document_change/);
});

// 실제 Pi 처럼 --session-dir 에 세션 파일을 남겨 같은 기록에서 이어 받을 수 있게 하고, 받은 프롬프트를 되돌려 준다.
const PERSISTING_PI_SCRIPT = `
  if (process.argv.includes('--version')) { console.log('0.0.0-test'); process.exit(0); }
  const fs = require('node:fs');
  const path = require('node:path');
  const args = process.argv;
  const prompt = fs.readFileSync(0, 'utf8').trim();
  const sessionDir = args[args.indexOf('--session-dir') + 1];
  const session = args[args.indexOf('--session-id') + 1];
  const header = JSON.stringify({ type: 'session', version: 3, id: session, cwd: process.cwd() });
  fs.mkdirSync(sessionDir, { recursive: true });
  if (!fs.readdirSync(sessionDir).some((name) => name.endsWith('_' + session + '.jsonl'))) {
    fs.writeFileSync(path.join(sessionDir, Date.now() + '_' + session + '.jsonl'), header + '\\n');
  }
  console.log(header);
  console.log(JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: JSON.stringify({ prompt }) } }));
  console.log(JSON.stringify({ type: 'agent_settled' }));
`;

test('detaching on the same hub session resumes the provider, unbinds the document and attaches to another', { timeout: 60_000 }, async (t) => {
  const hub = await startLiveHub(t, { documentId: 'doc-old', piScript: PERSISTING_PI_SCRIPT, nodeArgs: compactingPiArgs(t) });
  const linked = await hub.start({ documentName: '옛 문서.hwpx' });
  assert.match(linked.projectId, /^p/);
  hub.message('첫 턴');
  const firstEnd = await hub.studio.next((frame) => frame.type === 'agent-event' && frame.event.type === 'turn-end');
  const providerSessionId = firstEnd.event.providerSessionId;
  assert.ok(providerSessionId);

  // 옛 브리지가 닫히고 새 브리지가 같은 허브 세션에 붙는다 — 기록과 공급자 세션은 그대로다.
  hub.studio.socket.close();
  await once(hub.studio.socket, 'close');
  const bridge = await connect(hub.studioUrl.replace('instance=live-hub-test', 'instance=detached-bridge'), { origin: 'http://127.0.0.1:7700' });
  t.after(() => bridge.socket.close());
  assert.equal((await bridge.next((frame) => frame.type === 'welcome')).hubSessionId, hub.sessionId);

  const detached = await hub.start({ ...DETACHED, providerSessionId }, bridge);
  assert.equal(detached.resumed, true, 'the native provider session resumes on the same record');
  assert.equal(detached.documentId, null);
  assert.equal(detached.documentName, null);
  assert.equal(detached.projectId, null);
  assert.deepEqual(
    (({ projectId, project }) => ({ projectId, project }))(await bridge.next((frame) => frame.type === 'project-bound')),
    { projectId: null, project: null },
  );
  assert.ok((await piToolNames(hub)).includes('open_document'));

  bridge.send({ type: 'chat-compact', requestId: 'detach', threadId: hub.threadId, reason: 'document-detached' });
  assert.equal((await bridge.next((frame) => frame.requestId === 'detach')).type, 'chat-compact-accepted');
  const compactDelta = await bridge.next((frame) => frame.type === 'agent-event' && frame.event.type === 'text-delta');
  assert.match(JSON.parse(compactDelta.event.text).compact.instructions, /^This chat was just detached from the document "옛 문서.hwpx" \(documentId doc-old\)\./);
  await bridge.next((frame) => frame.type === 'agent-event' && frame.event.type === 'turn-end');

  bridge.send({ type: 'chat-link-document', requestId: 'attach', documentId: 'doc-new', documentName: '새 문서.hwpx' });
  const attached = await bridge.next((frame) => frame.requestId === 'attach');
  assert.equal(attached.type, 'chat-document-linked', JSON.stringify(attached));
  assert.match(attached.projectId, /^p/);
  assert.notEqual(attached.projectId, linked.projectId);

  hub.message('붙였어', { documentId: 'doc-new' }, bridge);
  const delta = await bridge.next((frame) => frame.type === 'agent-event' && frame.event.type === 'text-delta');
  const prompt = JSON.parse(delta.event.text).prompt;
  assert.equal(occurrences(prompt, '<document_change'), 1, prompt);
  assert.match(prompt, /The user detached this chat from the document "옛 문서.hwpx" \(documentId doc-old\)\.[^<]*This chat is now attached to the document "새 문서.hwpx" \(documentId doc-new\)\./);
  assert.match(prompt, /"documentId":"doc-new","documentName":"새 문서.hwpx"/);
});
