/**
 * E2E: 새로고침 뒤 다시 이어 붙기(S2)와 끊긴 턴(S3) — 실제 허브와 Vite 개발 서버, 가짜 Pi(턴을 끝내지
 * 않는다)로 본다.
 *
 * 0. 턴이 도는 중에, 그리고 공급자가 질문을 남긴 채 기다리는 중에 새로고침한다. 같은 채팅이 허브의 같은
 *    프로바이더 세션·턴에 다시 붙고(chat-start·chat-stop·chat-interrupt 를 보내지 않는다) Stop 이 서고
 *    AGENT_BUSY 줄이 없다. 질문은 만료되지 않고 그 단계와 입력하던 답으로 돌아오며, 제출한 답은 질문을
 *    보낸 원래 공급자 호출이 받는다.
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
  ensureChromePath, findAvailablePort, removeTempDir, startHub, startVite, stopServer, writeFakePi,
} from './agent-bench-harness.mjs';

const HUB_TOKEN = 'interruption-recovery-e2e';
const HUB_NOTICE = '에이전트 허브가 다시 시작되어 작업이 중단됐어요';
const RELOAD_NOTICE = '페이지를 새로 고쳐 작업이 중단됐어요';
const RESUME_TEXT = '이어서 진행해 주세요.';
const ADOPT_PROMPT = 'Begin the turn a reload must not restart.';
const QUESTION_DRAFT = 'Keep my reload\ndraft';
/** 새로고침이 채팅을 다시 시작하거나 멈추면 보내는 프레임. 다시 이어 붙기는 이 중 어느 것도 보내지 않는다. */
const RESTART_FRAMES = ['chat-start', 'chat-stop', 'chat-interrupt', 'chat-user-message'];

ensureChromePath();
const hubPort = await findAvailablePort(Number(process.env.RHWP_AGENT_PORT || 7950), 5);
const vitePort = await findAvailablePort(Number(process.env.VITE_PORT || 7955), 5);
const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rhwp-interruption-e2e-'));
// 턴을 끝낼 파일을 만들지 않으므로 가짜 Pi 의 턴은 열린 채로 남는다.
const { piRoot } = writeFakePi(fixtureRoot);

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

/** 이 창이 붙은 허브 세션의 기록. 앞 시나리오의 닫힌 창 세션이 허브에 남아 있어도 이 창의 것을 고른다. */
async function windowHubRecord(page) {
  const sessionId = await page.evaluate(() => window.__agentBridge?.getHubFontAccess?.()?.sessionId ?? null);
  const health = await hubHealth();
  const record = (health.sessions ?? []).find((entry) => entry.sessionId === sessionId) ?? null;
  return { launchId: health.launchId, sessionId, record };
}

/** 새 채팅이 이 가짜 Pi 로 시작하도록 사이드바의 개인 기본값을 심는다. 다시 불러온 뒤부터 적용된다. */
function seedFakePiPrefs(page) {
  return page.evaluate(() => localStorage.setItem('rhwp-agent-prefs', JSON.stringify({
    defaultAgent: 'pi', defaultModel: 'mock-model', defaultEffort: '', defaultMode: 'agent',
  })));
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

  /** 새로고침 뒤 이 페이지가 허브로 보낸 채팅 프레임 종류를 모은다 (문서마다 새로 비운다). */
  async function recordSentFrames(page) {
    await page.evaluateOnNewDocument(() => {
      window.__sentFrameTypes = [];
      const send = WebSocket.prototype.send;
      WebSocket.prototype.send = function sendAndRecord(data) {
        if (typeof data === 'string') {
          try { window.__sentFrameTypes.push(JSON.parse(data)?.type ?? null); } catch { /* JSON 이 아닌 프레임 */ }
        }
        return send.call(this, data);
      };
    });
  }

  /** 새로고침한 사이드바가 시작 채팅을 고를 때까지 — 다시 시작하는 결정이 있었다면 이미 내려졌다. */
  const startupSettled = (page) => page.waitForFunction(
    () => window.__documentSessions?.attached()?.activeChat?.sidebar?.startupChatSettled?.().then(() => true),
    { timeout: 30_000, polling: 100 },
  );

  const withTimeout = (promise, ms, label) => Promise.race([
    promise,
    delay(ms, undefined, { ref: false }).then(() => { throw new Error(`${label}: no answer within ${ms} ms`); }),
  ]);

  /** 저장된 채팅(IndexedDB)에 질문 답 초안이 들어갈 때까지 기다린다 — 새로고침이 읽는 것은 저장본이다. */
  const storedQuestionDraft = (page, threadId, draft) => page.waitForFunction(async (id, text) => {
    const { openThreadsDatabase, THREADS_STORE } = await import('/src/agent/threads-db.ts');
    const db = await openThreadsDatabase();
    if (!db) return false;
    try {
      const stored = await new Promise((resolve, reject) => {
        const request = db.transaction(THREADS_STORE).objectStore(THREADS_STORE).get(id);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const pending = stored?.pendingUserQuestion;
      return pending?.activeQuestionIndex === 1 && pending.otherTextByQuestionId?.detail === text;
    } finally {
      db.close();
    }
  }, { timeout: 10_000, polling: 100 }, threadId, draft);

  await runTest('Reloading while the agent works or waits on a question keeps that chat on the same provider turn', async ({ page }) => {
    watchConsole(page);
    await recordSentFrames(page);
    await seedFakePiPrefs(page);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await connected(page);
    step('send the first message');
    await sendFromComposer(page, ADOPT_PROMPT);
    await page.waitForFunction(() => window.__agentBridge?.getActiveAgent?.() === 'pi'
      && window.__agentBridge?.isTurnRunning?.() === true, { timeout: 30_000 });
    const { launchId, sessionId, record: before } = await windowHubRecord(page);
    assert(before?.session?.status === 'running' && Boolean(before.session.turnId),
      `The hub runs the turn before the reload (${JSON.stringify(before?.session ?? null)})`);
    const threadId = (await shownState(page)).threadId;
    assert(Boolean(threadId), 'The turn belongs to a stored chat');
    const capabilities = await registerHubSession({ port: hubPort, token: HUB_TOKEN, launchId, sessionId });
    provider = connectProvider(capabilities.mcp, sessionId);
    await provider.opened;

    // 채팅을 다시 시작하면(chat-start force·chat-stop) 허브가 프로바이더를 내려 세션 id 가 바뀌고 턴이 끝난다.
    async function assertAdopted(label) {
      const { sessionId: after, record } = await windowHubRecord(page);
      assert(after === sessionId, `${label}: the window keeps its hub session`);
      assert(record?.session?.sessionId === before.session.sessionId && record.session.turnId === before.session.turnId
        && record.session.status === 'running',
      `${label}: the same provider session and turn keep running (${JSON.stringify(record?.session ?? null)})`);
      const sent = await page.evaluate(() => window.__sentFrameTypes ?? []);
      const restarts = sent.filter((type) => RESTART_FRAMES.includes(type));
      assert(restarts.length === 0, `${label}: the reloaded page sends no restart, stop or message (${restarts.join(', ') || 'none'})`);
      const shown = await shownState(page);
      assert(shown.threadId === threadId, `${label}: the sidebar shows the same chat`);
      assert(shown.rowText === null, `${label}: the chat is not marked as cut off (${shown.rowText})`);
      assert(!shown.systemLines.some((text) => text.includes('AGENT_BUSY')), `${label}: no AGENT_BUSY line`);
      assert((await storedMarker(page, threadId))?.endedAt === null, `${label}: the stored turn stays open`);
    }

    step('reload while the turn runs');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await connected(page);
    await startupSettled(page);
    await page.waitForFunction((text) => window.__agentBridge?.isTurnRunning?.() === true
      && Boolean(document.querySelector('.ag-send.ag-stop'))
      && [...document.querySelectorAll('.ag-msg-user')].some((node) => node.textContent?.includes(text)),
    { timeout: 15_000 }, ADOPT_PROMPT);
    await assertAdopted('Reload during a running turn');
    await screenshot(page, 'reload-adopt-running');

    step('the agent asks a question; answer part of it');
    const answered = provider.call('ask_user_question', {
      questions: [
        {
          id: 'surface', header: 'Surface', multiSelect: true,
          question: 'Which surfaces should be verified together?',
          options: [
            { label: 'Question', description: 'Verify the inline transcript question card.' },
            { label: 'History', description: 'Verify the resolved history card.' },
            { label: 'Reconnect', description: 'Verify reload reconstruction.' },
          ],
        },
        {
          id: 'detail', header: 'Details', allowOther: true,
          question: 'Choose the follow-up.',
          options: [
            { label: 'Accessibility', description: 'Inspect keyboard order and the live region.' },
            { label: 'Persistence', description: 'Inspect draft restoration in the same blocked provider turn.' },
          ],
        },
      ],
    });
    await page.waitForSelector('.ag-user-question[data-inactive="false"] .ag-question-option', { timeout: 15_000 });
    // 카드가 열리면 질문이 초점을 받아 숫자 키로 고른다.
    await page.keyboard.press('1');
    await page.keyboard.press('2');
    await page.click('.ag-question-next');
    await page.waitForFunction(() => document.querySelector('.ag-question-step')?.textContent === '2/2', { timeout: 10_000 });
    await page.click('.ag-question-other');
    const [firstLine, secondLine] = QUESTION_DRAFT.split('\n');
    await page.type('.ag-input', firstLine);
    await page.keyboard.down('Shift');
    await page.keyboard.press('Enter');
    await page.keyboard.up('Shift');
    await page.type('.ag-input', secondLine);
    await storedQuestionDraft(page, threadId, QUESTION_DRAFT);

    step('reload while the question waits');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await connected(page);
    await startupSettled(page);
    await page.waitForFunction(
      () => document.querySelector('.ag-user-question[data-inactive="false"] .ag-question-step')?.textContent === '2/2',
      { timeout: 30_000 },
    );
    assert(await page.$eval('.ag-input', (input) => input.value) === QUESTION_DRAFT,
      'The typed answer and its Shift+Enter newline come back after the reload');
    assert(await page.$eval('.ag-user-question[data-inactive="false"]', (node) => node.nextElementSibling?.classList.contains('ag-composer')),
      'The question is live above the composer again');
    assert(!(await shownState(page)).cards.some((text) => text.includes('만료')), 'The question did not expire');
    await assertAdopted('Reload with a question pending');
    await page.click('.ag-question-back');
    const selected = await page.$$eval('.ag-user-question[data-inactive="false"] .ag-question-option[data-selected="true"]',
      (nodes) => nodes.map((node) => node.querySelector('.ag-question-option-label')?.textContent));
    assert(selected.join(',') === 'Question,History', `The earlier card's choices come back (${selected.join(',')})`);
    await page.click('.ag-question-next');
    await page.waitForFunction(() => document.querySelector('.ag-question-step')?.textContent === '2/2', { timeout: 10_000 });
    await screenshot(page, 'reload-adopt-question');

    step('submit the answer');
    await page.click('.ag-input');
    await page.keyboard.press('Enter');
    const response = await withTimeout(answered, 30_000, 'ask_user_question');
    assert(response.ok === true && response.result?.status === 'answered',
      `The provider call that asked before the reload receives the answer (${JSON.stringify(response.error ?? response.result?.status ?? null)})`);
    assert(response.result?.answers?.surface?.selected?.join(',') === 'Question,History'
      && response.result?.answers?.detail?.otherText === QUESTION_DRAFT,
    'The provider receives the choices and the typed answer');
    await page.waitForFunction(() => !document.querySelector('.ag-user-question[data-inactive="false"]')
      && document.querySelector('.ag-messages .ag-question-history'), { timeout: 10_000 });
    assert(await page.evaluate(() => window.__agentBridge?.isTurnRunning?.() === true), 'The turn keeps running after the answer');
    provider.ws.close();
    provider = null;
  });

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
    const { launchId, sessionId, record } = await windowHubRecord(page);
    assert(Boolean(sessionId) && record !== null, 'The window session is registered with the hub');
    const capabilities = await registerHubSession({ port: hubPort, token: HUB_TOKEN, launchId, sessionId });
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
}
