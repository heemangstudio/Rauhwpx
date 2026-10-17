import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  HUB_TEST_TOKEN as TOKEN,
  closeClient,
  openClient,
  sendFrame,
  startHub,
} from './hub-harness.mjs';
import { key as tlsKey, cert as tlsCert } from './fixtures/owned-browser-tls.mjs';
import { inspectOwnedBrowserRuntime } from '../owned-browser-runtime.mjs';

const THREAD = 'request-cards-thread';
const DOCUMENT = 'request-cards-doc';
const HANDOFF_ORIGIN = 'https://login.example.com';

/** Pi 대역: 받은 프롬프트를 한 줄씩 기록하고, complete-pi 파일이 생기면 턴을 끝낸다. */
function recordingPi({ workRoot }) {
  const prompts = path.join(workRoot, 'pi-prompts.jsonl');
  const complete = path.join(workRoot, 'complete-pi');
  return `
    if (process.argv.includes('--version')) { console.log('0.0.0-test'); process.exit(0); }
    const fs = require('node:fs');
    let input = '';
    process.stdin.on('data', (chunk) => { input += chunk; });
    process.stdin.on('end', () => { fs.appendFileSync(${JSON.stringify(prompts)}, JSON.stringify(input) + '\\n'); });
    const timer = setInterval(() => {
      if (!fs.existsSync(${JSON.stringify(complete)})) return;
      clearInterval(timer);
      fs.unlinkSync(${JSON.stringify(complete)});
      console.log(JSON.stringify({ type: 'agent_settled' }));
    }, 20);
  `;
}

/** 허브가 읽을 탭 기록을 미리 만든다. 사용자에게 넘길 탭은 이 채팅의 루트 에이전트 탭이다. */
async function prepareHandoffTab({ workRoot }) {
  const { ProjectStore } = await import('../project-store.mjs');
  const { createReferenceCatalog } = await import('../reference-catalog.mjs');
  const referenceStore = await createReferenceCatalog({ referencesRoot: path.join(workRoot, 'references'), projectsRoot: path.join(workRoot, 'projects') }).init();
  const store = await new ProjectStore({ root: path.join(workRoot, 'projects'), referenceStore }).init();
  const projectId = await store.projectForDocument(DOCUMENT);
  const browserDir = path.join(workRoot, 'browser', 'browser');
  mkdirSync(browserDir, { recursive: true });
  writeFileSync(path.join(browserDir, 'tabs.json'), JSON.stringify({ version: 1, tabs: [
    { tabId: 'handoff-tab', agentId: `${THREAD}:root`, threadId: THREAD, projectId, documentId: DOCUMENT, url: 'about:blank' },
  ] }));
}

async function startRequestHub(t, options = {}) {
  const hub = await startHub(t, { prefix: 'rhwp-hub-chat-requests-', fakePi: recordingPi, prepare: prepareHandoffTab, ...options });
  const prompts = path.join(hub.workRoot, 'pi-prompts.jsonl');
  return {
    ...hub,
    completeTurn: () => writeFileSync(path.join(hub.workRoot, 'complete-pi'), ''),
    prompts: () => existsSync(prompts) ? readFileSync(prompts, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [],
    async waitForPrompt(predicate, timeoutMs = 10_000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const found = this.prompts().find(predicate);
        if (found) return found;
        if (Date.now() > deadline) throw new Error(`No matching provider prompt: ${JSON.stringify(this.prompts())}`);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    },
  };
}

function urls(port, sessionId, instance) {
  return {
    studio: `ws://127.0.0.1:${port}/studio?token=${TOKEN}&sessionId=${sessionId}&instance=${instance}`,
    mcp: `ws://127.0.0.1:${port}/mcp?token=${TOKEN}&sessionId=${sessionId}&agent=pi&role=chat`,
  };
}

async function startChat(studio, extra = {}) {
  sendFrame(studio, { type: 'chat-start', agent: 'pi', threadId: THREAD, documentId: DOCUMENT, ...extra });
  return studio.next((frame) => frame.type === 'chat-started');
}

async function userTurn(studio, text, ids = { threadId: THREAD, documentId: DOCUMENT }) {
  sendFrame(studio, { type: 'chat-user-message', text, ...ids });
  await studio.next((frame) => frame.type === 'agent-event' && frame.event?.type === 'turn-start');
}

let callId = 1;
async function call(mcp, tool, args) {
  const id = callId++;
  sendFrame(mcp, { type: 'tool-call', id, tool, args });
  return mcp.next((frame) => frame.type === 'tool-result' && frame.id === id);
}

async function browserRequest(studio, action, args = {}) {
  const requestId = `browser-${callId++}`;
  sendFrame(studio, { type: 'browser-request', requestId, action, args });
  return studio.next((frame) => frame.type === 'browser-response' && frame.requestId === requestId);
}

const handoffArgs = { tabId: 'handoff-tab', origin: HANDOFF_ORIGIN, label: 'Example', reason: 'The site sent a verification code.', kind: 'code' };
const secretArgs = (origin) => ({ label: 'Example API key', origins: [origin], kind: 'api-key', reason: 'The dashboard asks for the API key.' });

test('every pending request of a chat is in the snapshot, replays on reconnect and ends once on a new user message', { timeout: 60_000 }, async (t) => {
  const hub = await startRequestHub(t);
  const { studio: studioUrl, mcp: mcpUrl } = urls(hub.port, 'request-snapshot', 'snapshot-page');
  let studio = await openClient(studioUrl);
  t.after(() => closeClient(studio));
  await studio.next((frame) => frame.type === 'welcome');
  await startChat(studio);
  await userTurn(studio, 'Sign in and fetch the dashboard.');
  const mcp = await openClient(mcpUrl);
  t.after(() => closeClient(mcp));

  assert.equal((await call(mcp, 'request_permission', { capability: 'project-edit', reason: 'Save the research note.' })).result.status, 'pending');
  assert.equal((await call(mcp, 'browser_request_account', handoffArgs)).result.pending, true);
  const secret = await call(mcp, 'request_secret', secretArgs('https://api.example.com'));
  assert.equal(secret.result.pending, true, JSON.stringify(secret));
  const requested = [];
  for (let index = 0; index < 3; index++) requested.push((await studio.next((frame) => frame.type === 'chat-permission-requested')).request);
  assert.deepEqual(requested.map((request) => request.kind ?? 'generic'), ['generic', 'browser-code', 'secret-save']);
  assert.deepEqual(requested[2].scopes, ['chat'], 'without a vault the card offers only this chat');
  assert.equal(JSON.stringify(requested[2]).includes('value'), false);

  await closeClient(studio);
  studio = await openClient(studioUrl);
  const welcome = await studio.next((frame) => frame.type === 'welcome');
  assert.deepEqual(welcome.session.pendingChatPermissionRequests.map((request) => request.requestId), requested.map((request) => request.requestId));
  assert.equal(welcome.session.pendingChatPermissionRequest.requestId, requested[0].requestId);
  for (const request of requested) {
    const replayed = await studio.next((frame) => frame.type === 'chat-permission-requested' && frame.request.requestId === request.requestId);
    assert.equal(replayed.replayed, true);
  }

  hub.completeTurn();
  await studio.next((frame) => frame.type === 'agent-event' && frame.event?.type === 'turn-end');
  const restarted = await startChat(studio);
  assert.equal(restarted.pendingChatPermissionRequests.length, 3, 'chat-started carries the same pending list');

  await userTurn(studio, 'Never mind, summarize instead.');
  for (const request of requested) {
    const resolved = await studio.next((frame) => frame.type === 'chat-permission-resolved' && frame.requestId === request.requestId);
    assert.deepEqual(resolved.outcome, { status: 'expired', reason: 'user-message' });
  }
  const completeAfterExpiry = await browserRequest(studio, 'accounts.complete', { requestId: requested[1].requestId });
  assert.ok(completeAfterExpiry.error, 'an expired handoff cannot be completed');
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(studio.frames().filter((frame) => frame.type === 'chat-permission-resolved').length, 3, 'each request resolves exactly once');
});

test('deny and grant both resume the agent, deny releases the handed-off tab, and always grants carry into new chats', { timeout: 60_000 }, async (t) => {
  const hub = await startRequestHub(t);
  const { studio: studioUrl, mcp: mcpUrl } = urls(hub.port, 'request-answers', 'answers-page');
  const studio = await openClient(studioUrl);
  t.after(() => closeClient(studio));
  await studio.next((frame) => frame.type === 'welcome');
  await startChat(studio);
  await userTurn(studio, 'Sign in for me.');
  let mcp = await openClient(mcpUrl);
  assert.equal((await call(mcp, 'browser_request_account', handoffArgs)).result.pending, true);
  const handoff = (await studio.next((frame) => frame.type === 'chat-permission-requested')).request;
  // 사용자가 탭을 넘겨받았다.
  const held = await browserRequest(studio, 'control', { tabId: 'handoff-tab', owner: 'human' });
  assert.equal(held.result?.tab?.controller?.held, true, JSON.stringify(held));
  hub.completeTurn();
  await studio.next((frame) => frame.type === 'agent-event' && frame.event?.type === 'turn-end');
  await closeClient(mcp);

  sendFrame(studio, { type: 'chat-permission-response', requestId: handoff.requestId, responseId: 'deny-handoff', threadId: THREAD, documentId: DOCUMENT, decision: 'deny' });
  assert.equal((await studio.next((frame) => frame.type === 'chat-permission-response-result' && frame.responseId === 'deny-handoff')).ok, true);
  const denied = await studio.next((frame) => frame.type === 'chat-permission-resolved' && frame.requestId === handoff.requestId);
  assert.deepEqual(denied.outcome, { status: 'denied', reason: 'user-denied' });
  await studio.next((frame) => frame.type === 'agent-event' && frame.event?.type === 'turn-start');
  await hub.waitForPrompt((prompt) => prompt.includes(`The user declined the browser handoff on ${HANDOFF_ORIGIN}`) && prompt.includes('do not ask for it again'));
  const status = await browserRequest(studio, 'status');
  assert.notEqual(status.result.tabs.find((tab) => tab.tabId === 'handoff-tab').controller.held, true, 'deny returns the tab to the agent');

  mcp = await openClient(mcpUrl);
  assert.equal((await call(mcp, 'request_permission', { capability: 'project-edit', reason: 'Save the research note.' })).result.status, 'pending');
  const permission = (await studio.next((frame) => frame.type === 'chat-permission-requested')).request;
  assert.deepEqual(permission.scopes, ['chat', 'always']);
  hub.completeTurn();
  await studio.next((frame) => frame.type === 'agent-event' && frame.event?.type === 'turn-end');
  await closeClient(mcp);
  sendFrame(studio, { type: 'chat-permission-response', requestId: permission.requestId, responseId: 'grant-always', threadId: THREAD, documentId: DOCUMENT, decision: 'grant', scope: 'always' });
  assert.equal((await studio.next((frame) => frame.type === 'chat-permission-response-result' && frame.responseId === 'grant-always')).ok, true);
  const granted = await studio.next((frame) => frame.type === 'chat-permission-resolved' && frame.requestId === permission.requestId);
  assert.equal(granted.outcome.status, 'granted');
  assert.deepEqual(granted.alwaysGrants, ['project-edit']);
  await studio.next((frame) => frame.type === 'agent-event' && frame.event?.type === 'turn-start');
  await hub.waitForPrompt((prompt) => prompt.includes('The user granted project-edit for this chat; continue.'));
  const policyFile = path.join(hub.workRoot, 'chat-permission-policy.json');
  assert.deepEqual(JSON.parse(readFileSync(policyFile, 'utf8')).always, ['project-edit']);
  if (process.platform !== 'win32') assert.equal(statSync(policyFile).mode & 0o777, 0o600);
  hub.completeTurn();
  await studio.next((frame) => frame.type === 'agent-event' && frame.event?.type === 'turn-end');

  const nextChat = await startChat(studio, { threadId: 'request-cards-next', force: true });
  assert.deepEqual(nextChat.chatPermissionGrants, ['project-edit'], 'always grants apply to a new chat');
  assert.deepEqual((await browserRequest(studio, 'permissions.list')).result.always, ['project-edit']);
  assert.deepEqual((await browserRequest(studio, 'permissions.revoke', { capability: 'project-edit' })).result.always, []);
  const revokedChat = await startChat(studio, { threadId: 'request-cards-third', force: true });
  assert.deepEqual(revokedChat.chatPermissionGrants, []);
});

const SAVED_ACCOUNT_ID = '0b0c3f6e-6f47-4c2a-9c1d-5d2f7a1e9b10';

/** 이 사이트의 저장된 계정 하나(세션만 남은 계정)를 허브 계정 기록에 미리 둔다. */
async function prepareSavedAccount({ workRoot }) {
  await prepareHandoffTab({ workRoot });
  const browserRoot = path.join(workRoot, 'browser');
  mkdirSync(browserRoot, { recursive: true });
  writeFileSync(path.join(browserRoot, 'browser-accounts.json'), JSON.stringify({
    schema: 1, sessions: [],
    configuration: { profileId: 'default', downloads: { directory: 'managed', maxFileBytes: 1024 * 1024, autoImport: true }, preview: { mode: 'docked', reducedMotion: false } },
    accounts: [{ id: SAVED_ACCOUNT_ID, origin: 'https://www.shop.example', origins: ['https://www.shop.example'], label: 'andy@shop.example', stableIdentity: SAVED_ACCOUNT_ID, profileId: 'default', hasPassword: false, sessionStatus: 'session-retained', version: 1, updatedAt: new Date().toISOString() }],
  }));
}

test('a site with a saved account gets the site access card instead of the save form, and its scope decides where the grant lives', { timeout: 60_000 }, async (t) => {
  const hub = await startRequestHub(t, { prepare: prepareSavedAccount });
  const { studio: studioUrl, mcp: mcpUrl } = urls(hub.port, 'request-site', 'site-page');
  const studio = await openClient(studioUrl);
  t.after(() => closeClient(studio));
  await studio.next((frame) => frame.type === 'welcome');
  await startChat(studio);
  await userTurn(studio, 'Check my orders on the shop.');
  let mcp = await openClient(mcpUrl);
  const ask = (origin, extra = {}) => call(mcp, 'browser_request_account', { tabId: 'handoff-tab', origin, label: 'Shop', reason: 'Check the order history.', ...extra });

  // 계정이 없는 사이트만 저장 양식을 받는다. 계정이 있으면 www 짝 출처라도 사이트 사용 카드가 된다.
  assert.equal((await ask('https://news.example')).result.kind, 'account');
  const saveCard = (await studio.next((frame) => frame.type === 'chat-permission-requested')).request;
  assert.equal(saveCard.kind, 'browser-save-account');
  const routed = await ask('https://shop.example');
  assert.equal(routed.result.kind, 'site', JSON.stringify(routed));
  let card = (await studio.next((frame) => frame.type === 'chat-permission-requested')).request;
  assert.equal(card.kind, 'browser-site-access');
  assert.equal(card.accountId, SAVED_ACCOUNT_ID);
  assert.equal(card.accountLabel, 'andy@shop.example');
  assert.deepEqual(card.origins, ['https://shop.example', 'https://www.shop.example']);
  assert.deepEqual(card.scopes, ['chat', 'always']);
  hub.completeTurn();
  await studio.next((frame) => frame.type === 'agent-event' && frame.event?.type === 'turn-end');
  await closeClient(mcp);

  sendFrame(studio, { type: 'chat-permission-response', requestId: saveCard.requestId, responseId: 'deny-save', threadId: THREAD, documentId: DOCUMENT, decision: 'deny' });
  await studio.next((frame) => frame.type === 'chat-permission-resolved' && frame.requestId === saveCard.requestId);
  // 거절은 아무것도 허용하지 않는다.
  sendFrame(studio, { type: 'chat-permission-response', requestId: card.requestId, responseId: 'deny-site', threadId: THREAD, documentId: DOCUMENT, decision: 'deny' });
  assert.equal((await studio.next((frame) => frame.type === 'chat-permission-resolved' && frame.requestId === card.requestId)).outcome.status, 'denied');
  await studio.next((frame) => frame.type === 'agent-event' && frame.event?.type === 'turn-start');
  await hub.waitForPrompt((prompt) => prompt.includes('The user declined access to https://shop.example'));
  assert.ok((await browserRequest(studio, 'sites.approve', { requestId: card.requestId })).error, 'a denied card cannot be approved later');
  const sitesAfterDeny = (await browserRequest(studio, 'policy.list')).result.sites;
  assert.equal(sitesAfterDeny.some((site) => site.origin.includes('shop.example')), false);
  assert.equal((await browserRequest(studio, 'accounts.list')).result.accounts[0].agentReuseApproved, false);

  // 이 채팅 승인: 이 채팅의 에이전트만 계정을 쓸 수 있고 저장되는 정책은 없다.
  mcp = await openClient(mcpUrl);
  await ask('https://shop.example');
  card = (await studio.next((frame) => frame.type === 'chat-permission-requested')).request;
  hub.completeTurn();
  await studio.next((frame) => frame.type === 'agent-event' && frame.event?.type === 'turn-end');
  await closeClient(mcp);
  const chatGrant = await browserRequest(studio, 'sites.approve', { requestId: card.requestId, scope: 'chat' });
  assert.deepEqual(chatGrant.result, { approved: true, scope: 'chat', origins: ['https://shop.example', 'https://www.shop.example'], accountId: SAVED_ACCOUNT_ID }, JSON.stringify(chatGrant));
  assert.equal((await studio.next((frame) => frame.type === 'chat-permission-resolved' && frame.requestId === card.requestId)).outcome.status, 'granted');
  await studio.next((frame) => frame.type === 'agent-event' && frame.event?.type === 'turn-start');
  await hub.waitForPrompt((prompt) => prompt.includes('The user allowed https://shop.example for this chat') && prompt.includes(`accountId ${SAVED_ACCOUNT_ID}`) && prompt.includes('browser_fill_account'));
  mcp = await openClient(mcpUrl);
  const status = await call(mcp, 'browser_status', {});
  assert.equal(status.result.accounts.find((account) => account.id === SAVED_ACCOUNT_ID).agentReuseApproved, true, 'this chat sees the account as approved');
  assert.equal((await browserRequest(studio, 'accounts.list')).result.accounts[0].agentReuseApproved, false, 'the saved approval is unchanged');
  assert.equal((await browserRequest(studio, 'policy.list')).result.sites.some((site) => site.origin.includes('shop.example')), false);

  // 항상 승인: 사이트 정책과 계정 승인이 저장된다.
  await ask('https://shop.example');
  card = (await studio.next((frame) => frame.type === 'chat-permission-requested')).request;
  hub.completeTurn();
  await studio.next((frame) => frame.type === 'agent-event' && frame.event?.type === 'turn-end');
  await closeClient(mcp);
  assert.equal((await browserRequest(studio, 'sites.approve', { requestId: card.requestId, scope: 'always' })).result.scope, 'always');
  const saved = (await browserRequest(studio, 'policy.list')).result.sites.filter((site) => site.origin.includes('shop.example'));
  assert.deepEqual(saved.map((site) => site.origin).sort(), ['https://shop.example', 'https://www.shop.example']);
  for (const site of saved) assert.ok(site.allowedActions.includes('website-change'), JSON.stringify(site));
  assert.equal((await browserRequest(studio, 'accounts.list')).result.accounts[0].agentReuseApproved, true);
  await hub.waitForPrompt((prompt) => prompt.includes('The user allowed https://shop.example in every chat'));
});

test('requests from one turn resume the agent once, after the last of them is answered', { timeout: 60_000 }, async (t) => {
  const hub = await startRequestHub(t);
  const { studio: studioUrl, mcp: mcpUrl } = urls(hub.port, 'request-batch', 'batch-page');
  const studio = await openClient(studioUrl);
  t.after(() => closeClient(studio));
  await studio.next((frame) => frame.type === 'welcome');
  await startChat(studio);
  await userTurn(studio, 'Save the note and use my API key.');
  const mcp = await openClient(mcpUrl);
  await call(mcp, 'request_permission', { capability: 'project-edit', reason: 'Save the research note.' });
  await call(mcp, 'request_secret', secretArgs('https://api.example.com'));
  const permission = (await studio.next((frame) => frame.type === 'chat-permission-requested')).request;
  const secretCard = (await studio.next((frame) => frame.type === 'chat-permission-requested')).request;
  hub.completeTurn();
  await studio.next((frame) => frame.type === 'agent-event' && frame.event?.type === 'turn-end');
  await closeClient(mcp);

  sendFrame(studio, { type: 'secret-submit', responseId: 'batch-secret', requestId: secretCard.requestId, threadId: THREAD, documentId: DOCUMENT, value: 'sk-batch-fixture', scope: 'chat' });
  assert.equal((await studio.next((frame) => frame.type === 'secret-submit-result' && frame.responseId === 'batch-secret')).ok, true);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(studio.frames().filter((frame) => frame.type === 'agent-event' && frame.event?.type === 'turn-start').length, 1, 'the agent waits for the other answer');
  sendFrame(studio, { type: 'chat-permission-response', requestId: permission.requestId, responseId: 'batch-grant', threadId: THREAD, documentId: DOCUMENT, decision: 'grant' });
  assert.equal((await studio.next((frame) => frame.type === 'chat-permission-response-result' && frame.responseId === 'batch-grant')).ok, true);
  await studio.next((frame) => frame.type === 'agent-event' && frame.event?.type === 'turn-start');
  const prompt = await hub.waitForPrompt((entry) => entry.includes('granted project-edit'));
  assert.match(prompt, /saved the secret "Example API key"/, 'both answers arrive in one turn');
});

test('stopping a turn expires its requests and a later completion cannot resume the chat', { timeout: 60_000 }, async (t) => {
  const hub = await startRequestHub(t);
  const { studio: studioUrl, mcp: mcpUrl } = urls(hub.port, 'request-stop', 'stop-page');
  let studio = await openClient(studioUrl);
  t.after(() => closeClient(studio));
  await studio.next((frame) => frame.type === 'welcome');
  await startChat(studio);
  await userTurn(studio, 'Sign in for me.');
  const mcp = await openClient(mcpUrl);
  t.after(() => closeClient(mcp));
  await call(mcp, 'browser_request_account', handoffArgs);
  const handoff = (await studio.next((frame) => frame.type === 'chat-permission-requested')).request;
  sendFrame(studio, { type: 'chat-interrupt' });
  const expired = await studio.next((frame) => frame.type === 'chat-permission-resolved' && frame.requestId === handoff.requestId);
  assert.deepEqual(expired.outcome, { status: 'expired', reason: 'user-stop' });
  await closeClient(studio);
  studio = await openClient(studioUrl);
  const welcome = await studio.next((frame) => frame.type === 'welcome');
  assert.deepEqual(welcome.session.pendingChatPermissionRequests, []);
  assert.ok((await browserRequest(studio, 'accounts.complete', { requestId: handoff.requestId })).error);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(studio.frames().some((frame) => frame.type === 'agent-event' && frame.event?.type === 'turn-start'), false, 'no stale continuation turn');
});

test('a saved secret asks again after revoke, approval resumes the agent, and deletion ends its use', { timeout: 60_000 }, async (t) => {
  const hub = await startRequestHub(t);
  const { studio: studioUrl, mcp: mcpUrl } = urls(hub.port, 'request-secret-use', 'secret-use-page');
  const studio = await openClient(studioUrl);
  t.after(() => closeClient(studio));
  await studio.next((frame) => frame.type === 'welcome');
  await startChat(studio);
  await userTurn(studio, 'Use my API key.');
  let mcp = await openClient(mcpUrl);
  const origin = 'https://api.example.com';
  await call(mcp, 'request_secret', secretArgs(origin));
  const saveCard = (await studio.next((frame) => frame.type === 'chat-permission-requested')).request;
  // 비밀 값은 일반 브라우저 요청으로는 받지 않는다.
  const blocked = await browserRequest(studio, 'secrets.approve', { requestId: saveCard.requestId, secret: 'sk-wrong-channel' });
  assert.equal(blocked.error.code, 'BROWSER_SECURE_CHANNEL_REQUIRED');
  hub.completeTurn();
  await studio.next((frame) => frame.type === 'agent-event' && frame.event?.type === 'turn-end');
  await closeClient(mcp);
  sendFrame(studio, { type: 'secret-submit', responseId: 'save', requestId: saveCard.requestId, threadId: THREAD, documentId: DOCUMENT, value: 'sk-use-fixture', scope: 'always' });
  assert.equal((await studio.next((frame) => frame.type === 'secret-submit-result' && frame.responseId === 'save')).code, 'SECRET_SCOPE_INVALID', 'always needs a vault');
  sendFrame(studio, { type: 'secret-submit', responseId: 'save-chat', requestId: saveCard.requestId, threadId: THREAD, documentId: DOCUMENT, value: 'sk-use-fixture', scope: 'chat' });
  const { secret } = await studio.next((frame) => frame.type === 'secret-submit-result' && frame.responseId === 'save-chat');
  assert.equal(secret.label, 'Example API key');
  await studio.next((frame) => frame.type === 'agent-event' && frame.event?.type === 'turn-start');
  hub.completeTurn();
  await studio.next((frame) => frame.type === 'agent-event' && frame.event?.type === 'turn-end');

  assert.deepEqual((await browserRequest(studio, 'secrets.list')).result.secrets.map((entry) => [entry.id, entry.scope, entry.approved]), [[secret.id, 'chat', true]]);
  assert.equal((await browserRequest(studio, 'secrets.revoke', { secretId: secret.id })).result.secret.approved, false);
  await userTurn(studio, 'Try the key again.');
  mcp = await openClient(mcpUrl);
  const unapproved = await call(mcp, 'browser_fill_secret', { tabId: 'handoff-tab', snapshotId: 'none', ref: 'e1', secretId: secret.id, navigationEpoch: 0, controllerEpoch: 0 });
  assert.equal(unapproved.error.code, 'SECRET_APPROVAL_REQUIRED');
  assert.equal((await call(mcp, 'request_secret', { ...secretArgs(origin), secretId: secret.id })).result.pending, true);
  const useCard = (await studio.next((frame) => frame.type === 'chat-permission-requested')).request;
  assert.equal(useCard.kind, 'secret-use');
  assert.equal(useCard.secretId, secret.id);
  assert.deepEqual(useCard.scopes, ['chat'], 'a chat-only secret cannot be approved for every chat');
  hub.completeTurn();
  await studio.next((frame) => frame.type === 'agent-event' && frame.event?.type === 'turn-end');
  await closeClient(mcp);
  const approved = await browserRequest(studio, 'secrets.approve', { requestId: useCard.requestId, secretId: secret.id, scope: 'chat' });
  assert.equal(approved.result.secret.approved, true);
  assert.equal((await studio.next((frame) => frame.type === 'chat-permission-resolved' && frame.requestId === useCard.requestId)).outcome.status, 'granted');
  await studio.next((frame) => frame.type === 'agent-event' && frame.event?.type === 'turn-start');
  await hub.waitForPrompt((prompt) => prompt.includes(`approved the secret "Example API key" (secretId ${secret.id})`));

  mcp = await openClient(mcpUrl);
  assert.deepEqual((await call(mcp, 'request_secret', { ...secretArgs(origin), secretId: secret.id })).result, { status: 'granted', secretId: secret.id, label: 'Example API key', origins: [origin] });
  await browserRequest(studio, 'secrets.delete', { secretId: secret.id });
  assert.equal((await call(mcp, 'request_secret', { ...secretArgs(origin), secretId: secret.id })).error.code, 'SECRET_NOT_FOUND');
  assert.equal(JSON.stringify([studio.frames(), mcp.frames(), hub.prompts()]).includes('sk-use-fixture'), false);
});

async function needsBrowser(t) {
  if ((await inspectOwnedBrowserRuntime()).installed) return true;
  t.skip('Install the pinned managed Chromium browser to run the real-page secret fill.');
  return false;
}

/** 관리형 Chromium 이 이 테스트의 자체 서명 인증서를 받게 한다. 허브 코드는 그대로 쓴다. */
function certificatePreload(t) {
  const workRoot = mkdtempSync(path.join(os.tmpdir(), 'rhwp-hub-tls-preload-'));
  t.after(() => rmSync(workRoot, { recursive: true, force: true }));
  const runtimeUrl = new URL('../owned-browser-runtime.mjs', import.meta.url).href;
  const real = `${runtimeUrl}?real-runtime`;
  writeFileSync(path.join(workRoot, 'tls-loader.mjs'), `
    export async function load(url, context, nextLoad) {
      if (url !== ${JSON.stringify(runtimeUrl)}) return nextLoad(url, context);
      return { format: 'module', shortCircuit: true, source: ${JSON.stringify(`
        export * from ${JSON.stringify(real)};
        import { startOwnedBrowserRuntime as start } from ${JSON.stringify(real)};
        export async function startOwnedBrowserRuntime(options) {
          const runtime = await start(options);
          const newPage = runtime.context.newPage.bind(runtime.context);
          runtime.context.newPage = async () => {
            const page = await newPage();
            const session = await runtime.context.newCDPSession(page);
            await session.send('Security.setIgnoreCertificateErrors', { ignore: true });
            return page;
          };
          return runtime;
        }
      `)} };
    }
  `);
  const preload = path.join(workRoot, 'tls-preload.mjs');
  writeFileSync(preload, "import { register } from 'node:module'; register(new URL('./tls-loader.mjs', import.meta.url));\n");
  return preload;
}

test('a secret typed into its card fills a real page and never reaches the agent, observations, frames or logs', { timeout: 90_000 }, async (t) => {
  if (!await needsBrowser(t)) return;
  const value = `sk-fixture-${crypto.randomUUID()}`;
  let posted = null;
  const server = https.createServer({ key: tlsKey, cert: tlsCert }, (request, response) => {
    response.setHeader('content-type', 'text/html');
    if (request.method === 'POST') {
      let body = '';
      request.on('data', (chunk) => { body += chunk; });
      request.on('end', () => { posted = new URLSearchParams(body).get('key'); response.end('<title>Saved</title><h1>Key saved</h1>'); });
      return;
    }
    response.end(`<title>Dashboard</title><form action="/save" method="post"><label>API key <input name="key" type="password"></label>
      <button>Save key</button></form><p id="echo"></p>
      <script>document.querySelector('input').addEventListener('input', (event) => { document.getElementById('echo').textContent = 'typed:' + event.target.value; });</script>`);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `https://127.0.0.1:${server.address().port}`;
  const hub = await startRequestHub(t, {
    nodeArgs: ['--import', certificatePreload(t)],
    env: { RHWP_BROWSER_WORKSPACE_TARGETS: JSON.stringify([origin]) },
  });
  const { studio: studioUrl, mcp: mcpUrl } = urls(hub.port, 'request-secret', 'secret-page');
  const studio = await openClient(studioUrl);
  t.after(() => closeClient(studio));
  await studio.next((frame) => frame.type === 'welcome');
  await startChat(studio);
  await userTurn(studio, 'Add my API key to the dashboard.');
  let mcp = await openClient(mcpUrl);
  const opened = await call(mcp, 'browser_open', { url: origin });
  assert.equal(opened.ok, true, JSON.stringify(opened));
  const pending = await call(mcp, 'request_secret', secretArgs(origin));
  assert.equal(pending.result.pending, true);
  const card = (await studio.next((frame) => frame.type === 'chat-permission-requested')).request;
  assert.equal(card.kind, 'secret-save');
  assert.deepEqual(card.origins, [origin]);
  hub.completeTurn();
  await studio.next((frame) => frame.type === 'agent-event' && frame.event?.type === 'turn-end');
  await closeClient(mcp);

  sendFrame(studio, { type: 'secret-submit', responseId: 'save-secret', requestId: card.requestId, threadId: THREAD, documentId: DOCUMENT, label: 'Dashboard key', value, scope: 'chat' });
  const saved = await studio.next((frame) => frame.type === 'secret-submit-result' && frame.responseId === 'save-secret');
  assert.equal(saved.ok, true, JSON.stringify(saved));
  assert.equal(saved.secret.label, 'Dashboard key');
  assert.equal(saved.secret.scope, 'chat');
  assert.equal((await studio.next((frame) => frame.type === 'chat-permission-resolved' && frame.requestId === card.requestId)).outcome.status, 'granted');
  await studio.next((frame) => frame.type === 'agent-event' && frame.event?.type === 'turn-start');
  await hub.waitForPrompt((prompt) => prompt.includes(`secretId ${saved.secret.id}`) && prompt.includes('browser_fill_secret'));

  mcp = await openClient(mcpUrl);
  const status = await call(mcp, 'browser_status', {});
  assert.deepEqual(status.result.secrets, [{ id: saved.secret.id, label: 'Dashboard key', kind: 'api-key', origins: [origin], approved: true }]);
  const tabId = opened.result.tab.tabId;
  const target = async () => {
    const { snapshot } = (await call(mcp, 'browser_snapshot', { tabId })).result;
    const ref = snapshot.outline.match(/textbox "API key" \[ref=([^\]]+)\]/)?.[1];
    assert.ok(ref, snapshot.outline);
    return { tabId, snapshotId: snapshot.snapshotId, ref, navigationEpoch: snapshot.navigationEpoch, controllerEpoch: snapshot.controllerEpoch };
  };
  const fill = await call(mcp, 'browser_fill_secret', { ...await target(), secretId: saved.secret.id });
  assert.equal(fill.ok, true, JSON.stringify(fill));
  const after = await call(mcp, 'browser_snapshot', { tabId, find: 'typed' });
  assert.match(after.result.snapshot.outline, /typed:\[masked\]/);
  const capture = await call(mcp, 'browser_capture', { tabId });
  assert.ok(capture.result?.capture?.screenshotError || capture.error, 'a page holding the secret is not captured as an image');
  // 사용자가 쓰기를 허용한 사이트라야 제출까지 할 수 있다.
  await browserRequest(studio, 'policy.update', { operation: 'set-site', origin, allowedActions: ['browse', 'read', 'website-change'] });
  const submitted = await call(mcp, 'browser_fill_secret', { ...await target(), secretId: saved.secret.id, submit: true });
  assert.equal(submitted.ok, true, JSON.stringify(submitted));
  const deadline = Date.now() + 5_000;
  while (posted === null && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(posted, value, 'the real page received the secret');

  hub.completeTurn();
  await studio.next((frame) => frame.type === 'agent-event' && frame.event?.type === 'turn-end');
  const leaks = [
    ['studio frames', JSON.stringify(studio.frames())],
    ['tool results', JSON.stringify(mcp.frames())],
    ['provider prompts', JSON.stringify(hub.prompts())],
    ['hub log', hub.stderr()],
    ['browser data', existsSync(path.join(hub.workRoot, 'browser', 'user-secrets.json')) ? readFileSync(path.join(hub.workRoot, 'browser', 'user-secrets.json'), 'utf8') : ''],
  ].filter(([, text]) => text.includes(value) || text.includes(encodeURIComponent(value)) || text.includes(Buffer.from(value).toString('base64')));
  assert.deepEqual(leaks.map(([name]) => name), []);
});
