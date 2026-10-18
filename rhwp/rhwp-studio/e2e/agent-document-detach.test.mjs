/**
 * E2E: 채팅을 문서에서 떼고 다른 문서를 붙인다 — 실제 허브와 Vite 개발 서버, 가짜 Pi, 가짜 MCP 공급자로 본다.
 *
 * 0. 사용자가 분리 단추로 뗀다. 허브는 공급자를 다시 띄우지 않고(chat-start·chat-stop 없음, 같은 프로바이더 세션)
 *    새 사이드바가 그 채팅을 잇는다. 쓰던 글과 초점은 그대로고 머리에는 채팅 이름만 남는다.
 *
 * 1. 새 문서에 붙은 채팅의 턴에서 공급자가 detach_document 를 부른다. 채팅은 빈 종이 자리로 옮기고 머리에서
 *    문서 이름이 사라진다. 같은 허브 세션·프로바이더 턴이 그대로 돈다(chat-start·chat-stop·chat-interrupt 없음).
 *    도구 결과는 옮긴 채팅의 새 브리지가 붙은 뒤에 온다. 저장된 채팅은 문서가 없고, 바뀌지 않은 문서는 닫힌다.
 * 2. 같은 턴에서 create_document 가 묻지 않고 그 자리에 새 문서를 열어 붙인다.
 * 3. 그 문서에 쓴 뒤 다시 떼면 저장 창이 뜬다. 취소하면 채팅은 그 문서에 남고(CANCELLED), 저장하면 문서가
 *    저장되고 닫힌다 — 저장하지 않은 문서가 탭으로 남지 않는다.
 *
 * 실행: CHROME_PATH=... node e2e/agent-document-detach.test.mjs --mode=headless
 *       (RHWP_AGENT_PORT / VITE_PORT 로 시작 포트를 바꾼다)
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { registerHubSession } from '../../../desktop/agent-hub.mjs';
import {
  ensureChromePath, findAvailablePort, removeTempDir, startHub, startVite, stopServer, writeFakePi,
} from './agent-bench-harness.mjs';

const HUB_TOKEN = 'document-detach-e2e';
const PROMPT = 'Detach from this document, then make a new one.';
/** 옮긴 채팅이 턴을 다시 시작하거나 멈추면 보내는 프레임. 떼기는 이 중 어느 것도 보내지 않는다. */
const RESTART_FRAMES = ['chat-start', 'chat-stop', 'chat-interrupt'];

ensureChromePath();
const hubPort = await findAvailablePort(Number(process.env.RHWP_AGENT_PORT || 7970), 5);
const vitePort = await findAvailablePort(Number(process.env.VITE_PORT || 7975), 5);
const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rhwp-document-detach-e2e-'));
// 턴 끝 파일이 있으면 가짜 Pi 의 턴은 바로 끝나고, 없으면 열린 채로 남는다 — 사용자의 떼기는 쉬는 채팅에서, 에이전트의
// 떼기는 도는 턴에서 본다.
const { piRoot, finishTurnPath } = writeFakePi(fixtureRoot);

let hub = null;
let vite = null;
let provider = null;

/** 가짜 MCP 공급자 — 허브의 MCP 소켓으로 루트 대화의 도구를 부른다. */
function connectProvider(token, sessionId) {
  const ws = new WebSocket(
    `ws://127.0.0.1:${hubPort}/mcp?token=${encodeURIComponent(token)}&sessionId=${encodeURIComponent(sessionId)}&agent=pi&role=chat`,
  );
  let nextId = 1;
  const inflight = new Map();
  ws.addEventListener('message', (event) => {
    let message;
    try { message = JSON.parse(String(event.data)); } catch { return; }
    if (message?.type !== 'tool-result') return;
    inflight.get(message.id)?.(message);
    inflight.delete(message.id);
  });
  ws.addEventListener('close', () => {
    for (const resolve of inflight.values()) resolve({ ok: false, error: { code: 'SOCKET_CLOSED' } });
    inflight.clear();
  });
  const opened = new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('mock provider socket failed')), { once: true });
  });
  return {
    ws,
    opened,
    call(tool, args) {
      const id = nextId++;
      return new Promise((resolve) => {
        inflight.set(id, resolve);
        ws.send(JSON.stringify({ v: 5, type: 'tool-call', id, tool, args }));
      });
    },
  };
}

try {
  hub = await startHub({ hubPort, token: HUB_TOKEN, fixtureRoot, env: { RHWP_PI_DIR: piRoot }, logName: 'agent-document-detach-hub.log' });
  vite = await startVite({ vitePort, hubPort, token: HUB_TOKEN, logName: 'agent-document-detach-vite.log' });
  process.env.VITE_URL = `http://127.0.0.1:${vitePort}`;
  for (const entry of ['/', '/src/main.ts']) {
    await fetch(`${process.env.VITE_URL}${entry}`).then((response) => response.text()).catch(() => {});
  }
  const { runTest, assert, screenshot, createNewDocument, waitForState } = await import('./helpers.mjs');
  const step = (label) => console.log(`  [step] ${label}`);

  /** 보이는 채팅 — 붙은 문서 세션과 그 활성 채팅. */
  const shown = (page) => page.evaluate(() => {
    const session = window.__documentSessions.attached();
    const sidebar = session.activeChat.sidebar;
    return {
      hasDocument: session.wasm.hasLoadedDocument(),
      fileName: session.wasm.hasLoadedDocument() ? session.wasm.fileName : null,
      threadId: sidebar.currentThreadId(),
      unlinked: sidebar.isUnlinkedChat(),
      header: sidebar.root.querySelector('.ag-document-name')?.textContent ?? '',
      running: window.__agentBridge?.isTurnRunning?.() === true,
      stop: Boolean(sidebar.root.querySelector('.ag-send.ag-stop')),
      loadedSessions: window.__documentSessions.list().filter((entry) => entry.wasm.hasLoadedDocument()).length,
    };
  });

  const storedThread = (page, threadId) => page.evaluate(async (id) => {
    const { getThread } = await import('/src/agent/threads.ts');
    const thread = getThread(id);
    return thread ? { documentId: thread.documentId, docKey: thread.docKey, detachedFrom: thread.documentDetachedFrom ?? null } : null;
  }, threadId);

  async function hubSession(page) {
    const sessionId = await page.evaluate(() => window.__agentBridge?.getHubFontAccess?.()?.sessionId ?? null);
    const health = await (await fetch(`http://127.0.0.1:${hubPort}/healthz?token=${HUB_TOKEN}`)).json();
    const record = (health.sessions ?? []).find((entry) => entry.sessionId === sessionId) ?? null;
    return { launchId: health.launchId, sessionId, session: record?.session ?? null };
  }

  const recordSentFrames = (page) => page.evaluateOnNewDocument(() => {
    window.__sentFrameTypes = [];
    const send = WebSocket.prototype.send;
    WebSocket.prototype.send = function sendAndRecord(data) {
      if (typeof data === 'string') {
        try { window.__sentFrameTypes.push(JSON.parse(data)?.type ?? null); } catch { /* JSON 이 아닌 프레임 */ }
      }
      return send.call(this, data);
    };
  });

  fs.writeFileSync(finishTurnPath, '1');
  await runTest('The user detaches in place: same provider session, the composer stays as it was', async ({ page }) => {
    await recordSentFrames(page);
    await page.evaluate(() => localStorage.setItem('rhwp-agent-prefs', JSON.stringify({
      defaultAgent: 'pi', defaultModel: 'mock-model', defaultEffort: '', defaultMode: 'agent',
    })));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForState(page, 'app ready', () => Boolean(window.__wasm && window.__canvasView));
    await createNewDocument(page);
    await page.waitForFunction(() => window.__agentBridge?.getConnectionState?.() === 'connected', { timeout: 30_000 });
    await page.waitForFunction(() => [...document.querySelectorAll('.ag-root')].some((root) => root.dataset.composerReady === 'true'), { timeout: 20_000 });
    await page.type('.ag-input', PROMPT);
    await page.click('.ag-send');
    await page.waitForFunction(() => window.__agentBridge?.getActiveAgent?.() === 'pi' && !window.__agentBridge.isTurnRunning()
      && [...document.querySelectorAll('.ag-root')].some((root) => root.dataset.composerReady === 'true'), { timeout: 30_000 });
    const before = await shown(page);
    const hubBefore = await hubSession(page);

    step('type a draft, then press the detach toggle');
    await page.type('.ag-input', '보내지 않은 글');
    await page.waitForFunction(() => {
      const toggle = document.querySelector('.ag-doc-link-toggle');
      return toggle && !toggle.hidden && toggle.getAttribute('aria-disabled') !== 'true' && toggle.getAttribute('aria-busy') !== 'true';
    }, { timeout: 15_000 });
    const framesBefore = await page.evaluate(() => window.__sentFrameTypes.length);
    await page.click('.ag-doc-link-toggle');
    await page.waitForFunction(() => !window.__documentSessions.attached().wasm.hasLoadedDocument()
      && window.__documentSessions.attached().activeChat.sidebar.isUnlinkedChat(), { timeout: 15_000 });
    await page.waitForFunction(() => [...document.querySelectorAll('.ag-root')].some((root) => root.dataset.composerReady === 'true'), { timeout: 15_000 });
    const after = await shown(page);
    assert(after.threadId === before.threadId, 'The same chat continues beside an empty paper');
    const sent = await page.evaluate((from) => window.__sentFrameTypes.slice(from), framesBefore);
    assert(sent.includes('chat-detach-document'), 'The chat told the hub it detached');
    const restarts = sent.filter((type) => RESTART_FRAMES.includes(type));
    assert(restarts.length === 0, `Detaching restarts nothing (${restarts.join(', ') || 'none'})`);
    const hubAfter = await hubSession(page);
    assert(hubAfter.session?.sessionId === hubBefore.session?.sessionId && hubAfter.session?.documentId === null,
      'The hub keeps the same provider session, now without a document');
    const composer = await page.evaluate(() => ({
      text: document.querySelector('.ag-input')?.value,
      focus: document.activeElement?.classList.contains('ag-doc-link-toggle'),
      headerEmpty: document.querySelector('.ag-document-context')?.classList.contains('ag-doc-name-none'),
    }));
    assert(composer.text === '보내지 않은 글', 'The typed draft stays in the composer');
    assert(composer.focus === true, 'Focus stays on the link toggle');
    assert(composer.headerEmpty === true, 'The header keeps only the chat name');
    await screenshot(page, 'user-detached-in-place');
  });
  fs.rmSync(finishTurnPath, { force: true });

  await runTest('The agent detaches its chat mid-turn and attaches a new document without asking', async ({ page }) => {
    page.on('pageerror', (error) => console.log(`  [browser:pageerror] ${error.stack ?? error.message}`));
    await recordSentFrames(page);
    await page.evaluate(() => localStorage.setItem('rhwp-agent-prefs', JSON.stringify({
      defaultAgent: 'pi', defaultModel: 'mock-model', defaultEffort: '', defaultMode: 'agent',
    })));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForState(page, 'app ready', () => Boolean(window.__wasm && window.__canvasView));
    await createNewDocument(page);
    await page.waitForFunction(() => window.__agentBridge?.getConnectionState?.() === 'connected', { timeout: 30_000 });

    step('start a turn in the document chat');
    await page.waitForFunction(() => [...document.querySelectorAll('.ag-root')].some((root) => root.dataset.composerReady === 'true'), { timeout: 20_000 });
    await page.type('.ag-input', PROMPT);
    await page.click('.ag-send');
    await page.waitForFunction(() => window.__agentBridge?.getActiveAgent?.() === 'pi'
      && window.__agentBridge?.isTurnRunning?.() === true, { timeout: 30_000 });
    const before = await shown(page);
    const hubBefore = await hubSession(page);
    assert(before.hasDocument && !before.unlinked && Boolean(before.threadId), `The chat starts attached to ${before.fileName}`);
    assert(hubBefore.session?.status === 'running' && Boolean(hubBefore.session.documentId), 'The hub runs the turn on that document');
    const capabilities = await registerHubSession({ port: hubPort, token: HUB_TOKEN, launchId: hubBefore.launchId, sessionId: hubBefore.sessionId });
    provider = connectProvider(capabilities.mcp, hubBefore.sessionId);
    await provider.opened;
    const framesBefore = await page.evaluate(() => window.__sentFrameTypes.length);

    step('the agent calls detach_document');
    const detached = await provider.call('detach_document', {});
    assert(detached.ok === true, `detach_document succeeds (${JSON.stringify(detached.error ?? detached.result)})`);
    assert(detached.result?.documentName === before.fileName, 'The result names the detached document');
    const after = await shown(page);
    assert(!after.hasDocument && after.unlinked, 'The chat now sits beside an empty paper');
    assert(after.threadId === before.threadId, 'The same chat continues');
    assert(!after.header.includes(before.fileName), `The header no longer names the document (${after.header})`);
    assert(after.running && after.stop, 'The turn keeps running with Stop shown');
    assert(after.loadedSessions === 0, 'The unchanged document was closed');
    const hubAfter = await hubSession(page);
    assert(hubAfter.sessionId === hubBefore.sessionId && hubAfter.session?.sessionId === hubBefore.session.sessionId
      && hubAfter.session?.turnId === hubBefore.session.turnId && hubAfter.session?.status === 'running',
    'The same hub session, provider session and turn keep running');
    assert(hubAfter.session?.documentId === null, 'The hub session has no document');
    const sent = await page.evaluate((from) => window.__sentFrameTypes.slice(from), framesBefore);
    const restarts = sent.filter((type) => RESTART_FRAMES.includes(type));
    assert(restarts.length === 0, `Detaching sends no restart or stop (${restarts.join(', ') || 'none'})`);
    assert(sent.includes('chat-detach-document'), 'The old bridge told the hub before moving');
    const stored = await storedThread(page, before.threadId);
    assert(stored?.documentId === null && stored.docKey === null && stored.detachedFrom === null,
      `The stored chat has no document and nothing to compact (${JSON.stringify(stored)})`);
    await screenshot(page, 'agent-detached-mid-turn');

    step('the agent creates a new document in the same turn');
    const created = await provider.call('create_document', { name: '분리 뒤 문서' });
    assert(created.ok === true, `create_document attaches without asking (${JSON.stringify(created.error ?? created.result)})`);
    await page.waitForFunction(() => !window.__documentSessions.attached().activeChat.sidebar.isUnlinkedChat(), { timeout: 15_000 });
    const relinked = await shown(page);
    assert(relinked.hasDocument && relinked.threadId === before.threadId && relinked.running, 'The same running chat now has the new document');
    assert((await storedThread(page, before.threadId))?.documentId === created.result?.documentId, 'The stored chat follows the new document');
    assert(!(await page.$('.ag-permission-pill')), 'No permission pill was shown');
    await screenshot(page, 'agent-attached-after-detach');

    step('the agent writes to its new document, then detaches; the user cancels the save dialog');
    const written = await provider.call('insert_text', { expectedRevision: created.result.revision, sectionIdx: 0, paraIdx: 0, text: '저장할 글' });
    assert(written.ok === true, `The agent writes to the document it created (${JSON.stringify(written.error ?? '')})`);
    await page.waitForFunction(() => window.__documentSessions.attached().documentState.isDirty(), { timeout: 10_000 });
    await page.evaluate(() => {
      window.__savePickerCalls = 0;
      window.showSaveFilePicker = async () => {
        window.__savePickerCalls += 1;
        throw new DOMException('The user aborted a request.', 'AbortError');
      };
    });
    const refused = await provider.call('detach_document', {});
    assert(refused.ok === false && refused.error?.code === 'CANCELLED', `Cancelling the save keeps the chat attached (${JSON.stringify(refused.error)})`);
    assert(await page.evaluate(() => window.__savePickerCalls) === 1, 'Detaching a changed, never-saved document opens the save dialog');
    const kept = await shown(page);
    assert(kept.hasDocument && !kept.unlinked && kept.running, 'The chat stays on its document and keeps working');

    step('the user saves this time');
    await page.evaluate(() => {
      window.__savedBytes = 0;
      window.showSaveFilePicker = async () => ({
        name: '분리 뒤 문서.hwpx',
        kind: 'file',
        async getFile() { return new File([], this.name); },
        async isSameEntry() { return false; },
        async queryPermission() { return 'granted'; },
        async requestPermission() { return 'granted'; },
        async createWritable() {
          return { async write(blob) { window.__savedBytes = blob.size ?? blob.byteLength ?? 0; }, async close() {} };
        },
      });
    });
    const saved = await provider.call('detach_document', {});
    assert(saved.ok === true, `Detaching after saving succeeds (${JSON.stringify(saved.error ?? saved.result)})`);
    assert(await page.evaluate(() => window.__savedBytes) > 0, 'The document was written before it closed');
    const closed = await shown(page);
    assert(!closed.hasDocument && closed.unlinked && closed.running, 'The chat continues beside an empty paper');
    assert(closed.loadedSessions === 0, 'No unsaved document is left open in another tab');
    await screenshot(page, 'agent-detached-after-save');
  });
} finally {
  provider?.ws.close();
  if (vite) await stopServer(vite);
  if (hub) await stopServer(hub);
  await removeTempDir(fixtureRoot);
}
