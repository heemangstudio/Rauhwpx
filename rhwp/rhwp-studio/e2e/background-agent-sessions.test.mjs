/**
 * E2E: 에이전트가 일하는 문서를 두고 다른 문서로 옮겨도 작업이 이어진다.
 *
 * 실제 허브와 Vite 개발 서버를 띄우고, 가짜 Pi 프로세스로 문서 A 의 턴을 열어 둔다.
 * 문서 B 를 열면 A 는 화면에서 떨어진 세션으로 남아야 한다. 그 사이 가짜 MCP 공급자가
 * A 의 허브 세션으로 실제 도구를 불러 A 에 쓴다. 채팅 목록에서 A 의 채팅을 누르면 A 가
 * 다시 읽지 않고 그대로 돌아오고, 에이전트가 화면 밖에서 쓴 변경이 검토 대기로 남아 있어야 한다.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { registerHubSession } from '../../../desktop/agent-hub.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const studioRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(studioRoot, '..');
const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const HUB_TOKEN = 'background-sessions-e2e';
const DOC_A = 'para-001.hwp';
const DOC_B = 'text-align-2.hwp';
const DOC_C = 'form-02.hwp';
const MARKER = '[화면 밖 에이전트 편집]';

async function availablePort(start) {
  for (let port = start; port < start + 30; port += 1) {
    const open = await new Promise((resolve) => {
      const server = net.createServer();
      server.once('error', () => resolve(false));
      server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
    });
    if (open) return port;
  }
  throw new Error(`No available port from ${start}`);
}

async function waitForHttp(url, label, child, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child && (child.exitCode !== null || child.signalCode)) {
      throw new Error(`${label} exited before becoming ready`);
    }
    try {
      if ((await fetch(url)).ok) return;
    } catch {}
    await delay(300);
  }
  throw new Error(`${label} readiness timeout`);
}

function spawnLogged(command, args, cwd, env, logPath) {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const log = fs.openSync(logPath, 'w');
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ['ignore', log, log],
  });
  child._log = log;
  return child;
}

async function stop(child) {
  if (!child) return;
  if (child.exitCode === null && !child.signalCode) {
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGTERM');
    await Promise.race([exited, delay(4_000)]);
    if (child.exitCode === null && !child.signalCode) child.kill('SIGKILL');
  }
  if (child._log !== undefined) fs.closeSync(child._log);
}

/** 턴을 끝내지 않고 살아만 있는 Pi. 허브의 턴이 열린 채로 남는다. */
function prepareFakePi() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rhwp-bg-sessions-pi-'));
  const packageDir = path.join(root, 'prefix', 'node_modules', '@earendil-works', 'pi-coding-agent');
  const binDir = path.join(root, 'prefix', 'node_modules', '.bin');
  fs.mkdirSync(packageDir, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({ version: '0.0.0-e2e' }));
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
    version: 1,
    installedVersion: '0.0.0-e2e',
    keyTail: null,
    models: [{
      id: 'mock-model', name: 'Mock model', reasoning: false, supportsImages: false,
      efforts: [], defaultEffort: null, contextLength: 8_192,
      pricing: { prompt: 0, completion: 0 },
    }],
    defaultModelId: 'mock-model',
    setupComplete: true,
  }));
  const agentDir = path.join(root, 'agent');
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, 'models.json'), JSON.stringify({
    providers: { openrouter: { apiKey: 'e2e-placeholder-key' } },
  }));
  const fake = path.join(binDir, process.platform === 'win32' ? 'pi.cmd' : 'pi');
  if (process.platform === 'win32') {
    fs.writeFileSync(fake, '@echo off\r\nnode -e "setInterval(() =^> {}, 1000)"\r\n');
  } else {
    fs.writeFileSync(fake, `#!/bin/sh\nexec "${process.execPath}" -e 'setInterval(() => {}, 1000)'\n`, { mode: 0o755 });
  }
  return root;
}

/** 허브 /mcp 에 공급자로 붙어 실제 도구를 부른다 (실제 MCP 심과 같은 프레임). */
function connectProvider(hubPort, token, sessionId) {
  const ws = new WebSocket(
    `ws://127.0.0.1:${hubPort}/mcp?token=${encodeURIComponent(token)}`
      + `&sessionId=${encodeURIComponent(sessionId)}&agent=pi&role=chat`,
  );
  let nextId = 1;
  const inflight = new Map();
  ws.addEventListener('message', (event) => {
    let message;
    try { message = JSON.parse(String(event.data)); } catch { return; }
    if (message?.type !== 'tool-result') return;
    const pending = inflight.get(message.id);
    if (!pending) return;
    inflight.delete(message.id);
    clearTimeout(pending.timer);
    pending.resolve(message);
  });
  const opened = new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('mock provider socket failed')), { once: true });
  });
  return {
    ws,
    opened,
    call(tool, args, context = {}) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          inflight.delete(id);
          reject(new Error(`provider call timed out: ${tool}`));
        }, 30_000);
        inflight.set(id, { resolve, timer });
        ws.send(JSON.stringify({ v: 5, type: 'tool-call', id, tool, args, ...context }));
      });
    },
  };
}

async function hubSessions(hubPort) {
  const health = await (await fetch(`http://127.0.0.1:${hubPort}/healthz?token=${HUB_TOKEN}`)).json();
  return { launchId: health.launchId, sessions: health.sessions ?? [] };
}

if (!process.env.CHROME_PATH && !process.env.PUPPETEER_EXECUTABLE_PATH) {
  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  if (fs.existsSync(chrome)) process.env.CHROME_PATH = chrome;
}

const hubPort = await availablePort(Number(process.env.RHWP_AGENT_PORT || 5821));
const vitePort = await availablePort(Number(process.env.VITE_PORT || 7821));
const viteUrl = `http://127.0.0.1:${vitePort}`;
const piRoot = prepareFakePi();
const targetDir = path.join(repoRoot, 'target', 'background-sessions-e2e');
fs.mkdirSync(targetDir, { recursive: true });

// 허브는 참고 자료·프로젝트를 앱 데이터에 두고 부팅 때 옮겨 쓴다 — 테스트는 늘 임시 폴더를 쓴다.
fs.mkdirSync(path.join(repoRoot, 'target'), { recursive: true });
const hubDataRoot = fs.mkdtempSync(path.join(repoRoot, 'target', 'rhwp-e2e-data-'));
const hubDataEnv = {
  RHWP_REFERENCES_DIR: path.join(hubDataRoot, 'references'),
  RHWP_PROJECTS_DIR: path.join(hubDataRoot, 'projects'),
  RHWP_ARTIFACTS_DIR: path.join(hubDataRoot, 'artifacts'),
};
const hub = spawnLogged(
  process.execPath,
  [path.join(repoRoot, 'rhwp-agent', 'server.mjs')],
  path.join(repoRoot, 'rhwp-agent'),
  { RHWP_AGENT_PORT: String(hubPort), RHWP_AGENT_TOKEN: HUB_TOKEN, RHWP_PI_DIR: piRoot, ...hubDataEnv },
  path.join(targetDir, 'hub.log'),
);
let vite;
let provider;
try {
  await waitForHttp(`http://127.0.0.1:${hubPort}/healthz?token=${HUB_TOKEN}`, 'hub', hub);
  vite = spawnLogged(
    npmCmd,
    ['run', 'dev', '--', '--host', '127.0.0.1', '--port', String(vitePort), '--strictPort'],
    studioRoot,
    {
      BROWSER: 'none',
      VITE_RHWP_AGENT_URL: `ws://127.0.0.1:${hubPort}`,
      RHWP_AGENT_TOKEN: HUB_TOKEN,
    },
    path.join(targetDir, 'vite.log'),
  );
  await waitForHttp(viteUrl, 'Vite', vite);
  process.env.VITE_URL = viteUrl;
  const { runTest, assert, screenshot, sampleFetchPath } = await import('./helpers.mjs');

  /** 실제 열기 경로(open-document-bytes)로 샘플을 열고 끝날 때까지 기다린다. */
  async function openSample(page, fileName) {
    const done = await page.evaluate(async ({ fileName, url }) => {
      const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
      const requestId = `e2e-open-${fileName}-${Date.now()}`;
      return new Promise((resolve) => {
        const off = window.__eventBus.on('open-document-bytes:done', (payload) => {
          if (payload?.requestId !== requestId) return;
          off();
          resolve(payload);
        });
        window.__eventBus.emit('open-document-bytes', { bytes, fileName, requestId });
      });
    }, { fileName, url: sampleFetchPath(fileName) });
    assert(done.ok === true, `${fileName} opened through the real open path (${done.error ?? 'ok'})`);
  }

  const sessionSnapshot = (page) => page.evaluate(() => {
    const sessions = window.__documentSessions.list();
    const attached = window.__documentSessions.attached();
    return {
      count: sessions.length,
      attached: attached.wasm.fileName,
      files: sessions.map((session) => session.wasm.fileName),
      running: sessions.map((session) => session.bridge?.isTurnRunning?.() ?? false),
      sidebarRoots: document.querySelectorAll('.ag-root').length,
      visibleFile: window.__wasm.fileName,
    };
  });

  await runTest('agent keeps working on a document that is no longer shown', async ({ page }) => {
    page.on('console', (message) => {
      if (message.type() === 'error' || message.type() === 'warn') {
        console.log(`  [browser:${message.type()}] ${message.text()}`);
      }
    });
    page.on('pageerror', (error) => console.log(`  [browser:pageerror] ${error.message}`));
    // 새 채팅은 첫 메시지를 보낼 때 사이드바의 선택으로 시작한다. 가짜 Pi 를 기본으로 둔다.
    await page.evaluate(() => localStorage.setItem('rhwp-agent-prefs', JSON.stringify({
      defaultAgent: 'pi', defaultModel: 'mock-model', defaultEffort: '', defaultMode: 'agent',
    })));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__agentBridge?.getConnectionState?.() === 'connected', { timeout: 20_000 });

    // 1. 문서 A 를 열고 그 문서에서 에이전트 턴을 연다.
    await openSample(page, DOC_A);
    await delay(800);
    await page.type('.ag-input', 'A 문서 첫 문단 앞에 표시를 넣어 주세요.');
    await page.click('.ag-send');
    await page.waitForFunction(() => window.__agentBridge?.isTurnRunning?.() === true
      && window.__agentBridge.getActiveAgent() === 'pi', { timeout: 20_000 });
    const before = await hubSessions(hubPort);
    assert(before.sessions.length === 1, 'One hub session serves the first document');
    const sessionA = before.sessions[0].sessionId;
    await screenshot(page, 'bg-sessions-1-agent-running-on-a');

    // 2. 문서 B 를 연다. A 의 에이전트는 멈추지 않고 A 는 화면 밖 세션으로 남는다.
    await openSample(page, DOC_B);
    await page.waitForFunction(() => window.__documentSessions.list().length === 2, { timeout: 10_000 });
    const opened = await sessionSnapshot(page);
    assert(opened.attached === DOC_B && opened.visibleFile === DOC_B, `Editor shows ${DOC_B} (${JSON.stringify(opened)})`);
    assert(opened.running[0] === true, 'The agent on the first document is still running');
    assert(opened.sidebarRoots === 1, 'Only the shown document has a sidebar in the page');
    await page.waitForFunction(async (port, token) => {
      const health = await (await fetch(`http://127.0.0.1:${port}/healthz?token=${token}`)).json();
      return (health.sessions ?? []).length === 2;
    }, { timeout: 15_000 }, hubPort, HUB_TOKEN);
    const bTextBefore = await page.evaluate(() => window.__wasm.getTextRange(0, 0, 0, 200));
    await delay(900);
    await screenshot(page, 'bg-sessions-2-b-shown');

    // 3. A 의 에이전트가 화면 밖에서 실제 도구로 A 에 쓴다.
    const capabilities = await registerHubSession({
      port: hubPort, token: HUB_TOKEN, launchId: before.launchId, sessionId: sessionA,
    });
    provider = connectProvider(hubPort, capabilities.mcp, sessionA);
    await provider.opened;
    const info = await provider.call('get_document_info', {});
    assert(info.ok === true, `Background read succeeded (${JSON.stringify(info.error ?? null)})`);
    const infoText = JSON.stringify(info.result);
    assert(infoText.includes(DOC_A.replace('.hwp', '')), `The tool read the first document, not the shown one (${infoText.slice(0, 200)})`);
    const write = await provider.call('insert_text', {
      expectedRevision: info.result.revision,
      sectionIdx: 0,
      paraIdx: 0,
      charOffset: 0,
      text: MARKER,
    });
    assert(write.ok === true, `Background write succeeded (${JSON.stringify(write.error ?? null)})`);
    const readBack = await provider.call('get_text_range', { sectionIdx: 0, paraIdx: 0 });
    assert(readBack.ok === true && JSON.stringify(readBack.result).includes(MARKER), 'The agent reads its own write back from the hidden document');

    const afterWrite = await page.evaluate((marker) => {
      const [a] = window.__documentSessions.list();
      return {
        aHasMarker: a.wasm.getTextRange(0, 0, 0, 200).includes(marker),
        shownHasMarker: window.__wasm.getTextRange(0, 0, 0, 200).includes(marker),
        shownText: window.__wasm.getTextRange(0, 0, 0, 200),
        aPendingOps: a.bridge.pendingEdits.getChangeSets().reduce((sum, set) => sum + set.ops.length, 0),
        shownOverlay: document.querySelectorAll('[class*="pending"]').length,
      };
    }, MARKER);
    assert(afterWrite.aHasMarker, 'The hidden document received the edit');
    assert(!afterWrite.shownHasMarker && afterWrite.shownText === bTextBefore, 'The shown document is untouched');
    assert(afterWrite.aPendingOps > 0, 'The edit waits for review on the hidden document');

    // 4. 채팅 목록에서 A 의 채팅을 눌러 돌아간다.
    await page.evaluate(() => document.querySelector('.ag-threads-btn')?.click());
    await page.waitForFunction((doc) => [...document.querySelectorAll('.ag-threads-item')]
      .some((row) => row.querySelector('.ag-threads-item-doc')?.textContent?.includes(doc.replace('.hwp', ''))),
    { timeout: 10_000 }, DOC_A);
    const railStatus = await page.evaluate((doc) => {
      const row = [...document.querySelectorAll('.ag-threads-item')]
        .find((item) => item.querySelector('.ag-threads-item-doc')?.textContent?.includes(doc.replace('.hwp', '')));
      return row?.querySelector('.ag-threads-item-when')?.dataset.status ?? null;
    }, DOC_A);
    assert(railStatus === 'working', `The first document's chat shows as working in the list (${railStatus})`);
    await delay(900);
    await screenshot(page, 'bg-sessions-3-rail-shows-working');

    // 3b. 다른 문서를 여는 중에 A 의 채팅을 눌러도 열기가 A 에 닿지 않는다.
    const aDocumentId = await page.evaluate(() => window.__documentSessions.list()[0].documentId);
    const raced = await page.evaluate(async ({ fileName, url, doc }) => {
      const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
      const requestId = `e2e-race-${Date.now()}`;
      const done = new Promise((resolve) => {
        const off = window.__eventBus.on('open-document-bytes:done', (payload) => {
          if (payload?.requestId !== requestId) return;
          off();
          resolve(payload);
        });
      });
      window.__eventBus.emit('open-document-bytes', { bytes, fileName, requestId });
      [...document.querySelectorAll('.ag-threads-item')]
        .find((item) => item.querySelector('.ag-threads-item-doc')?.textContent?.includes(doc.replace('.hwp', '')))
        ?.click();
      return done;
    }, { fileName: DOC_C, url: sampleFetchPath(DOC_C), doc: DOC_A });
    assert(raced.ok === true, 'The racing open finished');
    await delay(1500);
    const afterRace = await page.evaluate((marker) => {
      const sessions = window.__documentSessions.list();
      const a = sessions.find((session) => session.wasm.fileName === 'para-001.hwp');
      return {
        files: sessions.map((session) => session.wasm.fileName),
        attached: window.__wasm.fileName,
        aDocumentId: a?.documentId ?? null,
        aMarkers: a ? a.wasm.getTextRange(0, 0, 0, 200).split(marker).length - 1 : -1,
        aRunning: a?.bridge?.isTurnRunning?.() ?? false,
      };
    }, MARKER);
    assert(afterRace.aDocumentId === aDocumentId && afterRace.aMarkers === 1 && afterRace.aRunning,
      `The busy document is untouched by the racing open (${JSON.stringify(afterRace)})`);
    assert(afterRace.files.length === 2 && afterRace.files.includes(DOC_C),
      `The idle document was replaced in place, with no stray session (${JSON.stringify(afterRace.files)})`);
    if (!(await page.$('.ag-threads-item'))) {
      await page.evaluate(() => document.querySelector('.ag-threads-btn')?.click());
    }
    await page.waitForFunction((doc) => [...document.querySelectorAll('.ag-threads-item')]
      .some((row) => row.querySelector('.ag-threads-item-doc')?.textContent?.includes(doc.replace('.hwp', ''))),
    { timeout: 10_000 }, DOC_A);
    await page.evaluate((doc) => {
      const row = [...document.querySelectorAll('.ag-threads-item')]
        .find((item) => item.querySelector('.ag-threads-item-doc')?.textContent?.includes(doc.replace('.hwp', '')));
      row?.click();
    }, DOC_A);
    await page.waitForFunction((doc) => window.__wasm.fileName === doc, { timeout: 15_000 }, DOC_A);
    await page.waitForFunction(() => window.__documentSessions.list().length === 1, { timeout: 15_000 });

    const back = await page.evaluate((marker) => ({
      ...{
        count: window.__documentSessions.list().length,
        running: window.__agentBridge.isTurnRunning(),
        shownHasMarker: window.__wasm.getTextRange(0, 0, 0, 200).includes(marker),
        pendingOps: window.__agentBridge.pendingEdits.getChangeSets().reduce((sum, set) => sum + set.ops.length, 0),
        transcript: document.querySelector('.ag-messages')?.textContent ?? '',
        sidebarRoots: document.querySelectorAll('.ag-root').length,
      },
    }), MARKER);
    assert(back.running, 'The agent turn is still running after switching back');
    assert(back.shownHasMarker, 'The editor shows the edit the agent made while hidden');
    assert(back.pendingOps > 0, 'The hidden edit is still waiting for review');
    assert(back.transcript.includes('표시를 넣어'), 'The chat transcript came back intact');
    assert(back.sidebarRoots === 1, 'One sidebar after switching back');
    await page.waitForFunction(async (port, token) => {
      const health = await (await fetch(`http://127.0.0.1:${port}/healthz?token=${token}`)).json();
      return (health.sessions ?? []).length === 1;
    }, { timeout: 20_000 }, hubPort, HUB_TOKEN);
    assert(true, 'The idle second document closed and released its hub session');
    await delay(900);
    await screenshot(page, 'bg-sessions-4-back-on-a');

    // 5. 화면 밖에서 쓴 변경을 승인하면 하나의 실행 취소 단계가 되고, 되돌리면 표시가 사라진다.
    await page.evaluate(() => {
      const pending = window.__agentBridge.pendingEdits;
      for (const set of pending.getChangeSets()) if (set.ops.length > 0) pending.approve(set.id);
    });
    await page.waitForFunction(() => window.__inputHandler?.canUndo?.() === true, { timeout: 5_000 });
    await page.evaluate(() => window.__inputHandler.performUndo());
    const undone = await page.evaluate((marker) => window.__wasm.getTextRange(0, 0, 0, 200).includes(marker), MARKER);
    assert(!undone, 'Undo on the returned document removes the agent edit');

    // 5b. 같은 문서에서 새 채팅을 눌러도 일하는 에이전트는 멈추지 않는다. 새 채팅은 포커스 화면의
    //     초안으로 열리고, 첫 메시지를 보낼 때까지 채팅이 생기지 않으며, 채팅 모드만 쓸 수 있다.
    const threadsBefore = await page.evaluate(async () => {
      const { listThreads } = await import('/src/agent/threads.ts');
      return listThreads().length;
    });
    await page.evaluate(() => document.querySelector('.ag-threads-new')?.click());
    await page.waitForFunction(() => window.__documentSessions.attached().chats.length === 2
      && window.__documentSessions.attached().activeChat === window.__documentSessions.attached().chats[1],
    { timeout: 15_000 });
    await delay(600);
    const draft = await page.evaluate(async () => {
      const { listThreads } = await import('/src/agent/threads.ts');
      const doc = window.__documentSessions.attached();
      return {
        writerRunning: doc.chats[0].bridge.isTurnRunning(),
        focusMode: document.body.classList.contains('ag-fullscreen-open'),
        threads: listThreads().length,
        draftThread: doc.chats[1].sidebar.currentThreadId(),
        draftHasChat: doc.chats[1].bridge.getActiveAgent() !== null,
      };
    });
    assert(draft.writerRunning, 'New chat leaves the running agent working');
    assert(draft.focusMode, 'New chat opens the focus view');
    assert(draft.threads === threadsBefore && draft.draftThread === null && !draft.draftHasChat,
      `The draft is only UI until the first message (${JSON.stringify(draft)})`);
    await delay(900);
    await screenshot(page, 'bg-sessions-5-parallel-draft');

    await page.type('.ag-input', 'A 문서의 첫 문단을 요약해 주세요.');
    await page.click('.ag-send');
    await page.waitForFunction(() => {
      const chat = window.__documentSessions.attached().chats[1];
      return chat.bridge.isTurnRunning() && chat.bridge.getActiveAgent() === 'pi';
    }, { timeout: 20_000 });
    const parallel = await page.evaluate(async () => {
      const { listThreads } = await import('/src/agent/threads.ts');
      const doc = window.__documentSessions.attached();
      return {
        workflow: doc.chats[1].bridge.getWorkflowState().workflow,
        writerRunning: doc.chats[0].bridge.isTurnRunning(),
        threads: listThreads().length,
        readerSession: doc.chats[1].hubSession?.sessionId ?? null,
      };
    });
    assert(parallel.workflow === 'question', `The parallel chat runs in chat mode only (${parallel.workflow})`);
    assert(parallel.writerRunning, 'Both agents run at once');
    assert(parallel.threads === threadsBefore + 1, 'The first message created exactly one chat');

    // 격리: 채팅 모드 에이전트는 문서를 고칠 수 없고, 편집하는 에이전트는 계속 고칠 수 있다.
    const readerCapabilities = await registerHubSession({
      port: hubPort, token: HUB_TOKEN, launchId: before.launchId, sessionId: parallel.readerSession,
    });
    const reader = connectProvider(hubPort, readerCapabilities.mcp, parallel.readerSession);
    await reader.opened;
    // 읽기 전용 채팅의 공급자는 실제 MCP 심처럼 지금 워크플로의 epoch 를 함께 보낸다.
    const readerState = await page.evaluate(() => window.__documentSessions.attached().chats[1].bridge.getWorkflowState());
    const readerContext = { workflow: readerState.workflow, capabilityEpoch: readerState.capabilityEpoch };
    const readerInfo = await reader.call('get_document_info', {}, readerContext);
    assert(readerInfo.ok === true, `The chat-mode agent can read the shared document (${JSON.stringify(readerInfo.error ?? null).slice(0, 300)})`);
    const readerWrite = await reader.call('insert_text', {
      expectedRevision: readerInfo.result.revision, sectionIdx: 0, paraIdx: 0, charOffset: 0, text: '[읽기 전용 채팅]',
    }, readerContext);
    assert(readerWrite.ok !== true, `The chat-mode agent cannot write (${JSON.stringify(readerWrite.error ?? null).slice(0, 160)})`);
    reader.ws.close();
    const writerInfo = await provider.call('get_document_info', {});
    const writerWrite = await provider.call('insert_text', {
      expectedRevision: writerInfo.result.revision, sectionIdx: 0, paraIdx: 0, charOffset: 0, text: '[편집 채팅]',
    });
    assert(writerWrite.ok === true, `The editing agent still writes while the chat runs (${JSON.stringify(writerWrite.error ?? null)})`);
    const shownText = await page.evaluate(() => window.__wasm.getTextRange(0, 0, 0, 200));
    assert(shownText.includes('[편집 채팅]') && !shownText.includes('[읽기 전용 채팅]'), 'Only the editing agent changed the document');

    // 레일에서 편집 채팅을 누르면 그 채팅이 보이고, 두 채팅 모두 계속 돈다.
    await page.evaluate(() => {
      const writerThread = window.__documentSessions.attached().chats[0].sidebar.currentThreadId();
      document.querySelector(`.ag-threads-item[data-thread-id="${writerThread}"]`)?.click();
    });
    await page.waitForFunction(() => window.__documentSessions.attached().activeChat
      === window.__documentSessions.attached().chats[0], { timeout: 10_000 });
    const both = await page.evaluate(() => window.__documentSessions.attached().chats.map((chat) => chat.bridge.isTurnRunning()));
    assert(both.length === 2 && both.every(Boolean), `Switching chats stops neither agent (${JSON.stringify(both)})`);
    await delay(900);
    await screenshot(page, 'bg-sessions-6-back-to-writer');

    // 6. 에이전트가 일하는 동안에도 메뉴의 새 문서가 막히지 않고 따로 열린다.
    assert(await page.evaluate(() => window.__agentBridge.isTurnRunning()), 'The agent is still working before the menu command');
    await page.evaluate(() => window.__dispatcher.dispatch('file:new-doc'));
    await page.waitForFunction(() => window.__documentSessions.list().length === 2
      && window.__documentSessions.attached().wasm.hasLoadedDocument()
      && window.__documentSessions.attached() !== window.__documentSessions.list()[0], { timeout: 20_000 });
    const created = await page.evaluate(() => ({
      aRunning: window.__documentSessions.list()[0].chats.every((chat) => chat.bridge.isTurnRunning()),
      shownIsNew: window.__wasm.fileName !== 'para-001.hwp',
    }));
    assert(created.aRunning && created.shownIsNew, 'New Document opens beside the working agent instead of being blocked');
  });
} finally {
  provider?.ws.close();
  await stop(vite);
  await stop(hub);
  fs.rmSync(piRoot, { recursive: true, force: true });
  fs.rmSync(hubDataRoot, { recursive: true, force: true });
}
