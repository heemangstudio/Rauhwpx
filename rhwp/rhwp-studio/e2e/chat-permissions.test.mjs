/**
 * 실제 Studio + 허브 + WASM에서 채팅별 권한과 편집 검토 경계를 확인한다.
 * Pi는 추론 없이 턴 시작/종료만 제어하는 fixture이고 도구·인증·UI는 제품 경로다.
 * 실행: node e2e/chat-permissions.test.mjs --mode=headless
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer } from 'vite';
import { registerHubSession } from '../../../desktop/agent-hub.mjs';
import {
  ensureChromePath, findAvailablePort, repoRoot, startHub, stopServer, studioRoot, writeFakePi,
} from './agent-bench-harness.mjs';

ensureChromePath();
const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rhwp-chat-permission-e2e-'));
const evidenceDir = process.env.RHWP_PERMISSION_EVIDENCE_DIR
  || path.join(repoRoot, 'output', 'e2e', 'chat-permissions');
fs.mkdirSync(evidenceDir, { recursive: true });
const { piRoot, finishTurnPath } = writeFakePi(fixtureRoot);
fs.mkdirSync(path.join(fixtureRoot, 'projects'), { recursive: true });
fs.writeFileSync(path.join(fixtureRoot, 'projects', 'settings.json'), JSON.stringify({
  librarian: { enabled: false }, agent: { chatMayEdit: false },
}));
const hubPort = await findAvailablePort(5840);
const vitePort = await findAvailablePort(7840);
const token = randomUUID();
let hub;
let vite;
let provider;

async function health() {
  const response = await fetch(`http://127.0.0.1:${hubPort}/healthz`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(response.status, 200);
  return response.json();
}

async function attachProvider(page) {
  const snapshot = await health();
  const sessionId = await page.evaluate(() => window.__agentBridge.getHubFontAccess()?.sessionId);
  const record = snapshot.sessions.find((row) => row.sessionId === sessionId);
  assert.ok(record?.sessionId, 'the real editor has an authenticated hub session');
  const capabilities = await registerHubSession({
    port: hubPort, token, launchId: snapshot.launchId, sessionId: record.sessionId,
  });
  provider?.socket.close();
  const socket = new WebSocket(
    `ws://127.0.0.1:${hubPort}/mcp?token=${encodeURIComponent(capabilities.mcp)}`
      + `&sessionId=${encodeURIComponent(record.sessionId)}&agent=pi&role=chat`,
  );
  const calls = new Map();
  let sequence = 0;
  socket.addEventListener('message', (event) => {
    const frame = JSON.parse(String(event.data));
    if (frame.type !== 'tool-result') return;
    const pending = calls.get(frame.id);
    if (!pending) return;
    calls.delete(frame.id);
    clearTimeout(pending.timer);
    pending.resolve(frame);
  });
  socket.addEventListener('close', () => {
    for (const pending of calls.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('The fixture MCP turn closed before its tool result'));
    }
    calls.clear();
  });
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error('The authenticated MCP connection failed')), { once: true });
  });
  provider = {
    socket,
    call(tool, args) {
      const id = ++sequence;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          calls.delete(id);
          reject(new Error(`Tool result timeout: ${tool}`));
        }, 30_000);
        calls.set(id, { resolve, reject, timer });
        socket.send(JSON.stringify({
          v: 5, type: 'tool-call', id, tool, args,
          workflow: 'question', capabilityEpoch: record.session.capabilityEpoch,
        }));
      });
    },
  };
  return record.session;
}

function must(frame, label) {
  assert.equal(frame.ok, true, `${label}: ${frame.error?.code} ${frame.error?.message}`);
  return frame.result;
}

try {
  hub = await startHub({
    hubPort, token, fixtureRoot, env: { RHWP_PI_DIR: piRoot },
    logName: 'chat-permissions-e2e-hub.log',
  });
  process.env.VITE_RHWP_AGENT_URL = `ws://127.0.0.1:${hubPort}`;
  process.env.RHWP_AGENT_TOKEN = token;
  process.env.RHWP_AGENT_PORT = String(hubPort);
  vite = await createServer({
    configFile: path.join(studioRoot, 'vite.config.ts'),
    cacheDir: path.join(fixtureRoot, 'vite-cache'),
    server: {
      host: '127.0.0.1', port: vitePort, strictPort: true, open: false,
      fs: { allow: [studioRoot, fs.realpathSync(path.join(studioRoot, '..', 'pkg')),
        path.join(studioRoot, '..', 'samples'), path.join(studioRoot, '..', 'npm', 'editor')] },
    },
    logLevel: 'warn',
  });
  await vite.listen();
  process.env.VITE_URL = `http://127.0.0.1:${vitePort}`;
  const { runTest, createNewDocument, waitForState, setTestCase } = await import('./helpers.mjs');

  await runTest('채팅별 권한 허용 및 실제 문서 편집 검토', async ({ page }) => {
    const errors = [];
    const evidence = { runtime: process.env.VITE_URL, provider: 'controlled Pi fixture', scenarios: [] };
    page.on('pageerror', (error) => errors.push(error.message));
    await page.setViewport({ width: 1440, height: 1000 });
    await page.evaluate(() => localStorage.setItem('rhwp-agent-prefs', JSON.stringify({
      defaultAgent: 'pi', defaultModel: 'mock-model', defaultEffort: '', defaultMode: 'chat',
    })));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForState(page, 'real editor and hub ready', () => Boolean(window.__wasm)
      && window.__agentBridge?.getConnectionState() === 'connected');
    await createNewDocument(page);
    const prefs = await page.evaluate(() => localStorage.getItem('rhwp-agent-prefs'));
    const takeScreenshot = async (name) => {
      await page.screenshot({ path: path.join(evidenceDir, `${name}.png`) });
    };
    const grants = () => page.evaluate(() => window.__agentBridge.getChatPermissionGrants());
    const session = async () => {
      const sessionId = await page.evaluate(() => window.__agentBridge.getHubFontAccess()?.sessionId);
      return (await health()).sessions.find((row) => row.sessionId === sessionId)?.session;
    };
    const startTurn = async (text) => {
      fs.rmSync(finishTurnPath, { force: true });
      await waitForState(page, 'enabled composer', () => {
        const input = document.querySelector('.ag-input');
        return input && !input.disabled;
      });
      await page.type('.ag-input', text);
      await page.click('.ag-send');
      await waitForState(page, 'fixture provider turn', () => window.__agentBridge.getActiveAgent() === 'pi'
        && window.__agentBridge.isTurnRunning());
      return attachProvider(page);
    };
    const finishTurn = async () => {
      fs.writeFileSync(finishTurnPath, '');
      await waitForState(page, 'completed fixture turn', () => !window.__agentBridge.isTurnRunning());
      fs.rmSync(finishTurnPath, { force: true });
    };
    const hasMarker = (text) => page.evaluate((query) => {
      const matches = window.__wasm.searchAllText(query, false, true);
      return (typeof matches === 'string' ? JSON.parse(matches) : matches).length > 0;
    }, text);
    const request = async (capability, reason) => {
      const result = must(await provider.call('request_permission', { capability, reason }), 'request_permission');
      assert.equal(result.status, 'pending');
      const selector = `.ag-permission-pill[data-request-id="${result.requestId}"]`;
      await page.waitForSelector(`${selector} .ag-permission-grant`);
      return { ...result, selector };
    };
    const grant = async (pending) => {
      await page.click(`${pending.selector} .ag-permission-grant`);
      await waitForState(page, 'authenticated chat grant', (id) => document.querySelector(
        `.ag-permission-pill[data-request-id="${id}"]`,
      )?.dataset.status === 'granted', pending.requestId);
    };
    const assertChatMode = async () => {
      const state = await session();
      assert.equal(state.workflow, 'question');
      assert.equal(state.permissionProfile, 'safe');
      assert.equal(await page.evaluate(() => localStorage.getItem('rhwp-agent-prefs')), prefs,
        'chat grants never change the personal mode preference');
    };

    setTestCase('허용 전 쓰기 차단 및 바쁜 턴의 허용 거절');
    const first = await startTurn('Ask for permission to edit this document.');
    assert.equal(first.workflow, 'question');
    assert.deepEqual(first.chatPermissionGrants, []);
    const structure = must(await provider.call('get_structure', { format: 'json' }), 'get_structure');
    const edit = { expectedRevision: structure.revision, sectionIdx: 0, paraIdx: 0, charOffset: 0,
      text: 'Permission review marker' };
    const deniedWrite = await provider.call('insert_text', edit);
    assert.equal(deniedWrite.ok, false);
    assert.equal(deniedWrite.error.code, 'QUESTION_WRITE_BLOCKED');
    assert.equal(await hasMarker(edit.text), false);
    const docRequest = await request('document-edit', 'Apply the requested paragraph edit and keep its review.');
    await takeScreenshot('permission-request');
    await page.click(`${docRequest.selector} .ag-permission-grant`);
    await page.waitForSelector(`${docRequest.selector} .ag-permission-error`);
    assert.deepEqual(await grants(), []);
    assert.deepEqual((await session()).chatPermissionGrants, []);
    assert.equal(await page.$eval(docRequest.selector, (node) => node.dataset.status), 'pending');
    await finishTurn();

    setTestCase('실제 pill 허용 후 다음 턴의 WASM 편집은 검토 대기');
    await grant(docRequest);
    assert.deepEqual((await session()).chatPermissionGrants, ['document-edit']);
    assert.equal(await page.evaluate(() => window.__agentBridge.isTurnRunning()), false,
      'granting a permission does not send another user message');
    await assertChatMode();
    await startTurn('Apply the paragraph edit now.');
    const current = must(await provider.call('get_structure', { format: 'json' }), 'get_structure');
    must(await provider.call('insert_text', { ...edit, expectedRevision: current.revision }), 'granted document edit');
    assert.equal(await hasMarker(edit.text), true, 'the real WASM document shows the staged edit');
    await finishTurn();
    await waitForState(page, 'safe pending edit review', () => window.__agentBridge.pendingEdits.getChangeSets()
      .some((set) => set.ops.length > 0));
    await page.waitForSelector('.ag-review-card .ag-reject');
    await takeScreenshot('permission-granted-review');
    await page.click('.ag-review-card .ag-reject');
    await waitForState(page, 'review rejection rolled back', () => !window.__agentBridge.pendingEdits.hasPending());
    assert.equal(await hasMarker(edit.text), false, 'UI rejection restores the actual document');
    await assertChatMode();
    evidence.scenarios.push({ name: 'document edit', blockedBeforeGrant: true, busyGrantRejected: true,
      authenticatedGrants: (await session()).chatPermissionGrants, heldForReview: true, rejectedRestoresWasm: true });

    setTestCase('프로젝트 편집과 로컬 실행은 각각 이 채팅에서 허용');
    await startTurn('Ask to update the research project.');
    const projectWrite = await provider.call('project_edit', { ops: [{ op: 'note', name: 'Permission fixture', body: 'Scoped note.' }] });
    assert.equal(projectWrite.ok, false, 'the isolated project chat-write setting denies project edits before approval');
    assert.equal(projectWrite.error.code, 'PROJECT_CHAT_EDIT_DISABLED');
    const projectRequest = await request('project-edit', 'Add a note to this chat research project.');
    await finishTurn();
    await grant(projectRequest);
    await startTurn('Add the requested research note.');
    must(await provider.call('project_edit', { ops: [{ op: 'note', name: 'Permission fixture', body: 'Scoped note.' }] }),
      'granted project edit');
    const projectState = must(await provider.call('project_read', { view: 'items' }), 'project_read');
    assert.ok(JSON.stringify(projectState).includes('Permission fixture'), 'the real project store contains the granted note');
    const localRequest = await request('local-execution', 'Read local files and run the requested command.');
    await finishTurn();
    await grant(localRequest);
    assert.deepEqual((await session()).chatPermissionGrants, ['document-edit', 'project-edit', 'local-execution']);
    await assertChatMode();
    await takeScreenshot('permission-chat-grants');
    evidence.scenarios.push({ name: 'project and local execution', projectWriteBeforeGrantBlocked: true,
      projectNoteStored: true, authenticatedGrants: (await session()).chatPermissionGrants });

    setTestCase('거절과 중지는 권한을 부여하지 않는다');
    await startTurn('Ask for a download permission that will be declined.');
    const downloadRequest = await request('downloads', 'Download the requested source.');
    await page.click(`${downloadRequest.selector} .ag-permission-deny`);
    await waitForState(page, 'denied permission', (id) => document.querySelector(
      `.ag-permission-pill[data-request-id="${id}"]`,
    )?.dataset.status === 'denied', downloadRequest.requestId);
    assert.equal((await grants()).includes('downloads'), false);
    const browserRequest = await request('browser', 'Open the requested source page.');
    await page.click('.ag-stop');
    await waitForState(page, 'cancelled permission', (id) => document.querySelector(
      `.ag-permission-pill[data-request-id="${id}"]`,
    )?.dataset.status === 'expired', browserRequest.requestId);
    assert.equal((await grants()).includes('browser'), false);

    setTestCase('새 채팅은 이전 채팅의 요청과 권한을 가져오지 않는다');
    await startTurn('Ask for a new browser permission before switching chat.');
    const staleRequest = await request('browser', 'Open a page only after approval.');
    await finishTurn();
    const previousThreadId = (await session()).threadId;
    const previousHubSessionId = await page.evaluate(() => window.__agentBridge.getHubFontAccess().sessionId);
    await page.evaluate((id) => {
      window.__oldPermissionGrant = document.querySelector(`.ag-permission-pill[data-request-id="${id}"] .ag-permission-grant`);
    }, staleRequest.requestId);
    await page.click('button[aria-label="채팅 목록"]');
    await page.click('.ag-threads-new');
    await waitForState(page, 'new chat has no old request', () => !window.__agentBridge.getPendingChatPermissionRequest());
    await page.evaluate(() => window.__oldPermissionGrant?.click());
    await startTurn('Start a fresh read-only chat.');
    const fresh = await session();
    assert.notEqual(fresh.threadId, previousThreadId);
    assert.deepEqual(fresh.chatPermissionGrants, []);
    assert.equal(fresh.pendingChatPermissionRequest, null);
    const background = (await health()).sessions.find((row) => row.sessionId === previousHubSessionId);
    assert.equal(background.session.chatPermissionGrants.includes('browser'), false,
      'a detached old pill cannot grant a permission to the background chat');
    const freshStructure = must(await provider.call('get_structure', { format: 'json' }), 'fresh get_structure');
    const freshWrite = await provider.call('insert_text', { ...edit, expectedRevision: freshStructure.revision });
    assert.equal(freshWrite.error?.code, 'QUESTION_WRITE_BLOCKED');
    assert.equal(await hasMarker(edit.text), false);
    const freshDocRequest = await request('document-edit', 'Check that an idle chat grant is also reset.');
    await finishTurn();
    await grant(freshDocRequest);
    const freshHubSessionId = await page.evaluate(() => window.__agentBridge.getHubFontAccess().sessionId);
    await page.click('button[aria-label="채팅 목록"]');
    await page.click('.ag-threads-new');
    await startTurn('Start another chat after the previous grant.');
    const idleReset = await session();
    assert.notEqual(idleReset.threadId, fresh.threadId);
    assert.equal(await page.evaluate(() => window.__agentBridge.getHubFontAccess().sessionId), freshHubSessionId,
      'an idle new chat reuses the Studio hub session');
    assert.deepEqual(idleReset.chatPermissionGrants, [], 'an idle new chat clears the previous chat grant');
    const idleStructure = must(await provider.call('get_structure', { format: 'json' }), 'idle-reset get_structure');
    assert.equal((await provider.call('insert_text', { ...edit, expectedRevision: idleStructure.revision })).error?.code,
      'QUESTION_WRITE_BLOCKED');
    await finishTurn();
    await assertChatMode();
    await takeScreenshot('permission-new-chat-reset');
    evidence.scenarios.push({ name: 'deny, stop and new chat', deniedDownload: true, stoppedBrowser: true,
      oldButtonInvalid: true, newChatGrants: fresh.chatPermissionGrants, newChatWriteBlocked: true,
      idleChatResetGrants: idleReset.chatPermissionGrants, personalModeUnchanged: true });
    assert.deepEqual(errors, [], 'the real editor raises no page errors');
    fs.writeFileSync(path.join(evidenceDir, 'results.json'), JSON.stringify(evidence, null, 2) + '\n');
    console.log(`  Permission evidence: ${evidenceDir}`);
  });
} finally {
  provider?.socket.close();
  await vite?.close();
  await stopServer(hub);
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
}
