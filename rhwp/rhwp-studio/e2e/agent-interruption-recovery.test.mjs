/**
 * E2E: 끊긴 턴(S3) — 실제 허브와 Vite 개발 서버, 가짜 Pi(턴을 끝내지 않는다)로 본다.
 *
 * a. 질문을 기다리며 도는 턴에서 허브 프로세스를 죽이고(띄운 프로세스의 PID 로 SIGTERM) 같은 포트·토큰으로
 *    다시 띄운다. 그 자리에 "에이전트 허브가 다시 시작되어 작업이 중단됐어요" 줄과 이어서 진행이 서고, 질문
 *    카드는 "만료됨 · 허브 재시작"이다. 실패 알림과 옛 "~습니다" 줄은 없다. 이어서 진행은 chat-start 다음
 *    chat-user-message 로 가고, 그 본문은 <turn_interrupted reason="hub-restart"> 블록으로 끝난다.
 * c. 그 탭을 닫고 허브를 한 번 더 다시 띄운 뒤 새 탭(다른 창 세션)을 연다 — 저장된 턴이 허브 재시작으로
 *    끊긴 것으로 보인다(시작 정리).
 * b. 같은 문서의 두 번째 채팅(개발 서버의 추가 허브 세션)이 일하는 중에 새로고침한다 — 창의 채팅은 다시
 *    이어 붙고, 두 번째 채팅을 열면 "페이지를 새로 고쳐 작업이 중단됐어요"다.
 * 앱 재시작은 데스크톱의 앱 실행 id 가 있어야 해 단위 테스트(agent-turn-interruption)가 맡는다.
 *
 * 실행: CHROME_PATH=... node e2e/agent-interruption-recovery.test.mjs --mode=headless
 *       (RHWP_AGENT_PORT / VITE_PORT 로 시작 포트를 바꾼다)
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { registerHubSession } from '../../../desktop/agent-hub.mjs';
import {
  ensureChromePath, findAvailablePort, removeTempDir, startHub, startVite, stopServer,
} from './agent-bench-harness.mjs';
import { prepareFakePi, seedFakePiPrefs } from './fake-pi.mjs';

const HUB_TOKEN = 'interruption-recovery-e2e';
const HUB_NOTICE = '에이전트 허브가 다시 시작되어 작업이 중단됐어요';
const RELOAD_NOTICE = '페이지를 새로 고쳐 작업이 중단됐어요';
const RESUME_TEXT = '이어서 진행해 주세요.';

ensureChromePath();
const hubPort = await findAvailablePort(Number(process.env.RHWP_AGENT_PORT || 7950), 5);
const vitePort = await findAvailablePort(Number(process.env.VITE_PORT || 7955), 5);
const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rhwp-interruption-e2e-'));
const piRoot = prepareFakePi('rhwp-interruption-pi-');

let hub = null;
let hubStarts = 0;
let vite = null;
let provider = null;

async function launchHub() {
  hubStarts += 1;
  hub = await startHub({
    hubPort,
    token: HUB_TOKEN,
    fixtureRoot,
    env: { RHWP_PI_DIR: piRoot },
    logName: `agent-interruption-hub-${hubStarts}.log`,
  });
  console.log(`  [hub] started pid=${hub.pid} port=${hubPort}`);
}

/** 띄운 허브 프로세스를 그 PID 로 끝내고, 같은 포트·토큰으로 다시 띄운다. */
async function restartHub() {
  const previous = hub;
  // 띄운 허브 프로세스를 그 PID 로 끝낸다 — 하니스가 그 프로세스 그룹에 SIGTERM 을 보내고(허브는 세션을
  // 정리하며 Studio 에 hub-shutdown 을 알린다), 그룹 밖으로 나간 프로바이더까지 거둔다.
  console.log(`  [hub] SIGTERM pid=${previous.pid}`);
  await stopServer(previous);
  await launchHub();
}

async function hubHealth() {
  return (await fetch(`http://127.0.0.1:${hubPort}/healthz?token=${HUB_TOKEN}`)).json();
}

/** 가짜 MCP 공급자 — 허브의 MCP 소켓으로 도구를 부른다(ask_user_question 은 답이 올 때까지 막힌다). */
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
    const pending = inflight.get(message.id);
    if (!pending) return;
    inflight.delete(message.id);
    pending.resolve(message);
  });
  ws.addEventListener('close', () => {
    for (const [, pending] of inflight) pending.resolve({ ok: false, error: { code: 'SOCKET_CLOSED' } });
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
        inflight.set(id, { resolve });
        ws.send(JSON.stringify({ v: 5, type: 'tool-call', id, tool, args }));
      });
    },
  };
}

try {
  await launchHub();
  vite = await startVite({ vitePort, hubPort, token: HUB_TOKEN, logName: 'agent-interruption-vite.log' });
  process.env.VITE_URL = `http://127.0.0.1:${vitePort}`;
  // 첫 방문의 변환·의존성 최적화를 미리 돌려 둔다 — 갓 띄운 개발 서버의 첫 로드가 앱 준비 대기를 넘기지 않게.
  for (const entry of ['/', '/src/main.ts']) {
    await fetch(`${process.env.VITE_URL}${entry}`).then((response) => response.text()).catch(() => {});
  }
  const { runTest, assert, screenshot, loadApp } = await import('./helpers.mjs');

  const step = (label) => console.log(`  [step] ${label}`);

  function watchConsole(page) {
    page.on('console', (message) => {
      if (message.type() === 'error' || message.type() === 'warn') console.log(`  [browser:${message.type()}] ${message.text()}`);
    });
    page.on('pageerror', (error) => console.log(`  [browser:pageerror] ${error.stack ?? error.message}`));
  }

  const connected = (page) => page.waitForFunction(
    () => window.__agentBridge?.getConnectionState?.() === 'connected', { timeout: 30_000 },
  );

  /** 보이는 사이드바 — 붙은 문서 세션의 활성 채팅. */
  const shownState = (page) => page.evaluate(() => {
    const sidebar = window.__documentSessions.attached().activeChat.sidebar;
    const root = sidebar.root;
    // 끊긴 턴이 여럿이면 마지막 줄(그 채팅의 마지막 끊김)만 이어서 진행을 가진다.
    const row = [...root.querySelectorAll('.ag-turn-interrupted')].at(-1) ?? null;
    const button = row?.querySelector('.ag-turn-interrupted-resume');
    return {
      threadId: sidebar.currentThreadId(),
      rowText: row?.querySelector('.ag-turn-interrupted-text')?.textContent ?? null,
      button: button && !button.hidden ? { blocked: button.getAttribute('aria-disabled') === 'true' } : null,
      cards: [...root.querySelectorAll('.ag-question-history-status')].map((node) => node.textContent),
      systemLines: [...root.querySelectorAll('.ag-msg-system:not(.ag-turn-interrupted)')].map((node) => node.textContent),
      failureNotices: root.querySelectorAll('.ag-failure-notice').length,
      userBubbles: [...root.querySelectorAll('.ag-msg-user')].map((node) => node.textContent.trim()),
    };
  });

  async function storedMarker(page, threadId) {
    return page.evaluate(async (id) => {
      const { getThread } = await import('/src/agent/threads.ts');
      const markers = getThread(id)?.messages.filter((message) => message.kind === 'turn') ?? [];
      return markers.at(-1) ?? null;
    }, threadId);
  }

  async function sendFromComposer(page, text) {
    await page.waitForFunction(() => document.querySelector('#agent-sidebar')?.dataset.composerReady === 'true'
      || [...document.querySelectorAll('.ag-root')].some((root) => root.dataset.composerReady === 'true'), { timeout: 20_000 });
    await page.type('.ag-input', text);
    await page.click('.ag-send');
  }

  await runTest('A hub restart mid-turn leaves a resumable interruption; a new tab after another restart shows it too', async ({ page, browser }) => {
    watchConsole(page);
    await seedFakePiPrefs(page);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await connected(page);
    step('send the first message');
    await sendFromComposer(page, 'Begin the turn the hub will lose.');
    await page.waitForFunction(() => window.__agentBridge?.getActiveAgent?.() === 'pi'
      && window.__agentBridge?.isTurnRunning?.() === true, { timeout: 30_000 });

    step('the turn runs');
    // 공급자가 질문을 남긴 채 턴이 돈다.
    const health = await hubHealth();
    const sessionId = health.sessions?.[0]?.sessionId;
    assert(Boolean(sessionId), 'The window session is registered with the hub');
    const capabilities = await registerHubSession({ port: hubPort, token: HUB_TOKEN, launchId: health.launchId, sessionId });
    provider = connectProvider(capabilities.mcp, sessionId);
    await provider.opened;
    void provider.call('ask_user_question', {
      questions: [{
        id: 'range', header: 'Range', question: 'Which period should be split into quarters?',
        options: [{ label: 'All', description: 'Every date in the schedule.' }, { label: 'Next year', description: 'Only 2027.' }],
      }],
    });
    await page.waitForFunction(() => window.__agentBridge?.getPendingUserQuestion?.() !== null, { timeout: 15_000 });
    const threadId = (await shownState(page)).threadId;
    assert(Boolean(threadId), 'The turn belongs to a stored chat');
    const running = await storedMarker(page, threadId);
    assert(running?.endedAt === null && typeof running.owner?.hub === 'string' && typeof running.hubTurnId === 'string',
      `The open turn marker records its window, hub process and hub turn (${JSON.stringify(running?.owner)})`);

    await page.evaluate(() => {
      window.__frames = [];
      const bridge = window.__agentBridge;
      const sendJson = bridge.sendJson.bind(bridge);
      bridge.sendJson = (frame) => {
        window.__frames.push(frame);
        return sendJson(frame);
      };
    });

    step('restart the hub');
    await restartHub();
    await page.waitForFunction(() => document.querySelector('.ag-turn-interrupted .ag-turn-interrupted-resume:not([hidden]):not([aria-disabled="true"])'),
      { timeout: 45_000 });
    const cut = await shownState(page);
    assert(cut.rowText === HUB_NOTICE, `The row says the hub restarted (${cut.rowText})`);
    assert(cut.button?.blocked === false, '이어서 진행 is offered once the hub answers again');
    assert(cut.cards.length === 1 && cut.cards[0] === '만료됨 · 허브 재시작', `The question card says why it expired (${JSON.stringify(cut.cards)})`);
    assert(cut.failureNotices === 0, 'No provider failure notice for a hub restart');
    assert(!cut.systemLines.some((text) => text.includes('작업이 중단됐습니다')), `No old hub text line (${JSON.stringify(cut.systemLines)})`);
    const settled = await storedMarker(page, threadId);
    assert(settled?.outcome === 'interrupted' && settled.interruption?.reason === 'hub-restart',
      `The stored turn is interrupted by a hub restart (${JSON.stringify(settled?.interruption)})`);
    await screenshot(page, 'hub-restart-live');

    await page.click('.ag-turn-interrupted-resume');
    await page.waitForFunction(() => window.__frames.some((frame) => frame.type === 'chat-user-message'), { timeout: 20_000 });
    const frames = await page.evaluate(() => window.__frames.map((frame) => ({ type: frame.type, text: frame.text ?? null })));
    const start = frames.findIndex((frame) => frame.type === 'chat-start');
    const message = frames.findIndex((frame) => frame.type === 'chat-user-message');
    assert(start >= 0 && start < message, `The resume starts a new chat session first (${frames.map((frame) => frame.type).join(', ')})`);
    const text = frames[message].text;
    assert(text.startsWith(RESUME_TEXT) && text.includes('<turn_interrupted reason="hub-restart">')
      && text.trimEnd().endsWith('</turn_interrupted>'), `The agent is told why its turn stopped (${text.slice(0, 160)}…)`);
    assert(text.includes('question to the user expired'), 'The block says the question expired');
    const resumed = await shownState(page);
    assert(resumed.userBubbles.at(-1) === RESUME_TEXT, `The bubble reads only the resume text (${resumed.userBubbles.at(-1)})`);
    assert(resumed.button === null && resumed.rowText === HUB_NOTICE, 'The row keeps its reason without the button');
    await page.waitForFunction(() => window.__agentBridge?.isTurnRunning?.() === true, { timeout: 30_000 });
    assert((await storedMarker(page, threadId))?.endedAt === null, 'The resumed turn runs with its own marker');

    // c. 탭을 닫고(그 페이지의 작업 신호가 꺼진다) 허브를 다시 띄운 뒤, 새 탭이 저장된 채팅을 연다.
    provider?.ws?.close();
    provider = null;
    await page.close();
    await restartHub();
    const fresh = await browser.newPage();
    await fresh.setViewport({ width: 1280, height: 900 });
    watchConsole(fresh);
    await loadApp(fresh);
    await connected(fresh);
    await fresh.waitForFunction((id) => window.__documentSessions.attached().activeChat.sidebar.currentThreadId() === id
      && document.querySelector('.ag-turn-interrupted'), { timeout: 30_000 }, threadId);
    const reopened = await shownState(fresh);
    assert(reopened.rowText === HUB_NOTICE, `A new tab shows the turn cut off by the hub restart (${reopened.rowText})`);
    assert(reopened.button !== null, '이어서 진행 is offered in the new tab');
    const after = await storedMarker(fresh, threadId);
    assert(after?.interruption?.reason === 'hub-restart', `The marker settled with the hub restart (${JSON.stringify(after?.interruption)})`);
    await screenshot(fresh, 'hub-restart-new-tab');
  });

  await runTest('A reload cuts off a second chat that was working; the window chat is re-adopted', async ({ page }) => {
    watchConsole(page);
    await seedFakePiPrefs(page);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await connected(page);
    // 문서 없이 첫 채팅(창의 허브 세션)을 돌린다 — 웹 빌드는 새로고침 뒤 문서를 다시 열지 않으므로,
    // 문서 없는 채팅이어야 새로고침 뒤 곧바로 다시 이어 붙는다.
    await sendFromComposer(page, 'First chat keeps working.');
    await page.waitForFunction(() => window.__documentSessions.attached().chats[0].bridge.isTurnRunning(), { timeout: 30_000 });
    const windowThread = await page.evaluate(() => window.__documentSessions.attached().chats[0].sidebar.currentThreadId());

    // 일하는 동안 새 채팅은 옆 채팅(개발 서버의 추가 허브 세션)으로 열린다.
    await page.evaluate(() => document.querySelector('.ag-threads-new')?.click());
    await page.waitForFunction(() => window.__documentSessions.attached().chats.length === 2
      && window.__documentSessions.attached().activeChat === window.__documentSessions.attached().chats[1], { timeout: 15_000 });
    await delay(600);
    await sendFromComposer(page, 'Second chat works too.');
    await page.waitForFunction(() => window.__documentSessions.attached().chats[1].bridge.isTurnRunning(), { timeout: 30_000 });
    const secondThread = await page.evaluate(() => window.__documentSessions.attached().chats[1].sidebar.currentThreadId());
    assert(Boolean(secondThread) && secondThread !== windowThread, 'The second chat has its own thread');
    const marker = await storedMarker(page, secondThread);
    assert(marker?.endedAt === null, 'The second chat has an open turn before the reload');

    step('reload with two chats working');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => Boolean(window.__documentSessions), { timeout: 60_000 });
    await connected(page);
    // 창의 채팅은 다시 이어 붙는다(멈추지 않는다).
    await page.waitForFunction((id) => window.__documentSessions.attached().activeChat?.sidebar.currentThreadId() === id
      && window.__agentBridge.isTurnRunning(), { timeout: 30_000 }, windowThread);
    step('the window chat is re-adopted');
    // 두 번째 채팅의 턴은 시작 정리가 새로고침으로 끊긴 것으로 정착했다.
    try {
      await page.waitForFunction(async (id) => {
        const { getThread } = await import('/src/agent/threads.ts');
        const markers = getThread(id)?.messages.filter((message) => message.kind === 'turn') ?? [];
        return markers.at(-1)?.interruption?.reason === 'reload';
      }, { timeout: 15_000 }, secondThread);
    } catch (error) {
      const stored = await page.evaluate(async (id) => {
        const { getThread } = await import('/src/agent/threads.ts');
        return getThread(id)?.messages.slice(-4) ?? null;
      }, secondThread);
      throw new Error(`${error.message}; second chat=${JSON.stringify(stored)}`);
    }

    // 목록에서 두 번째 채팅을 연다.
    await page.click('.ag-header .ag-threads-btn');
    await page.waitForSelector(`.ag-threads-item[data-thread-id="${secondThread}"]`, { timeout: 10_000 });
    await page.click(`.ag-threads-item[data-thread-id="${secondThread}"]`);
    await page.waitForFunction((id) => window.__documentSessions.attached().activeChat?.sidebar.currentThreadId() === id
      && window.__documentSessions.attached().activeChat.sidebar.root.querySelector('.ag-turn-interrupted'),
    { timeout: 20_000 }, secondThread);
    const opened = await shownState(page);
    assert(opened.rowText === RELOAD_NOTICE, `The second chat says the reload cut it off (${opened.rowText})`);
    assert(opened.button !== null, '이어서 진행 is offered for the second chat');
    await screenshot(page, 'reload-background-chat');
    const windowStill = await page.evaluate(() => window.__documentSessions.list()[0].chats[0].bridge.isTurnRunning());
    assert(windowStill, 'The window chat keeps running');
  });
} finally {
  provider?.ws?.close();
  await stopServer(vite);
  await stopServer(hub);
  removeTempDir(fixtureRoot);
  removeTempDir(piRoot);
}
