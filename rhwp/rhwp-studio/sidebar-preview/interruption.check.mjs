// 끊긴 턴(S3)을 실제 사이드바와 가짜 브리지로 본다 — 허브 재시작으로 끊긴 턴의 줄과 이어서 진행,
// 그 메시지에 실린 <turn_interrupted> 블록, 만료된 질문 카드의 이유, 대기열 붙잡음, 저장된 끊긴 턴의 복원.
// 혼자 돌릴 때: node sidebar-preview/interruption.check.mjs (CHROME_PATH 필요, standalone.mjs 가 자기 Vite 서버를 띄운다).
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { isMainModule, runStandalone } from './standalone.mjs';

const HUB_NOTICE = '에이전트 허브가 다시 시작되어 작업이 중단됐어요';
const RESUME_TEXT = '이어서 진행해 주세요.';

async function openPreview(page, origin, query) {
  await page.goto(`${origin}/?theme=light&width=480&${query}`, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => window.sidebarPreview
    && document.querySelector('#agent-sidebar')?.dataset.composerReady === 'true');
}

function state(page) {
  return page.evaluate(() => {
    const row = document.querySelector('.ag-turn-interrupted');
    const button = row?.querySelector('.ag-turn-interrupted-resume');
    const snapshot = window.sidebarPreview.snapshot();
    const strip = document.querySelector('.ag-followups');
    const threadId = window.sidebarPreview.sidebar.currentThreadId();
    return {
      threadId,
      rows: document.querySelectorAll('.ag-turn-interrupted').length,
      rowText: row?.querySelector('.ag-turn-interrupted-text')?.textContent ?? null,
      queueLine: row?.querySelector('.ag-turn-interrupted-queue:not([hidden])')?.textContent ?? null,
      button: button && !button.hidden ? {
        disabled: button.getAttribute('aria-disabled') === 'true',
        title: button.title,
      } : null,
      cards: [...document.querySelectorAll('.ag-question-history .ag-question-history-status')].map((node) => node.textContent),
      systemLines: [...document.querySelectorAll('.ag-msg-system:not(.ag-turn-interrupted)')].map((node) => node.textContent),
      failureNotices: document.querySelectorAll('.ag-failure-notice').length,
      folds: [...document.querySelectorAll('.ag-messages > .ag-turn-fold:not([hidden]) .ag-turn-fold-toggle')]
        .map((node) => node.getAttribute('title') ?? node.textContent),
      messageTexts: snapshot.messageTexts,
      chatStarts: snapshot.chatStarts.length,
      running: snapshot.running,
      userBubbles: [...document.querySelectorAll('.ag-msg-user')].map((node) => node.textContent.trim()),
      hold: strip?.dataset.hold ?? null,
      holdText: document.querySelector('.ag-followups-hold:not([hidden]) .ag-followups-hold-text')?.textContent ?? null,
      queued: [...document.querySelectorAll('.ag-followup')].length,
    };
  });
}

async function waitFor(page, predicate, arg, message) {
  try {
    await page.waitForFunction(predicate, { timeout: 8000 }, arg);
  } catch (error) {
    throw new Error(`${message}: ${JSON.stringify(await state(page))}`, { cause: error });
  }
}

const storedMarker = (page) => page.evaluate(() => {
  const id = window.sidebarPreview.sidebar.currentThreadId();
  const thread = window.sidebarPreview.threadStore.getThread(id);
  const markers = thread?.messages.filter((message) => message.kind === 'turn') ?? [];
  return markers.at(-1) ?? null;
});

/** 채팅 목록 행의 실행 상태 점(완료·작업 중 등)과 짧은 이유 — 점이 없으면 status 는 null. */
async function railStatus(page, threadId) {
  await page.click('.ag-header .ag-threads-btn');
  await page.waitForSelector(`.ag-threads-item[data-thread-id="${threadId}"]`);
  const status = await page.$eval(`.ag-threads-item[data-thread-id="${threadId}"]`, (item) => {
    const dot = item.querySelector('.ag-thread-status');
    return {
      status: dot ? [...dot.classList].find((name) => name.startsWith('ag-thread-status-'))?.slice('ag-thread-status-'.length) ?? null : null,
      label: item.querySelector('.ag-threads-item-when-label')?.textContent ?? null,
    };
  });
  await page.evaluate(() => document.querySelector('.ag-threads-close')?.click());
  await page.waitForFunction(() => !document.querySelector('.ag-root')?.classList.contains('ag-threads-open'));
  return status;
}

export async function checkInterruptionPreview(page, origin, artifacts) {
  const screenshot = async (name) => {
    const sidebar = await page.$('.ag-root');
    await sidebar.screenshot({ path: resolve(artifacts, `${name}.png`) });
  };

  // 1. 허브 재시작으로 끊긴 턴: 그 자리의 줄, 만료됨 · 허브 재시작 카드, 대기열 붙잡음.
  await openPreview(page, origin, 'reset=1&scenario=interrupted&hold=1');
  await page.click('#play');
  await waitFor(page, () => window.sidebarPreview.snapshot().running && document.querySelector('.ag-messages .ag-activity'),
    undefined, 'the turn did not start');
  // 가짜 프로바이더가 문서를 읽고 답을 쓰기 시작할 때까지(400ms) 기다린다.
  await new Promise((done) => setTimeout(done, 600));
  await page.focus('.ag-input');
  await page.type('.ag-input', '표 머리글도 굵게 해 주세요');
  await page.keyboard.press('Enter');
  await waitFor(page, () => document.querySelectorAll('.ag-followup').length === 1, undefined, 'the follow-up was not queued');
  await page.evaluate(() => window.sidebarPreview.askQuestion());
  await page.evaluate(() => window.sidebarPreview.restartHub());
  await waitFor(page, () => document.querySelector('.ag-turn-interrupted'), undefined, 'no interruption row');
  let s = await state(page);
  assert.equal(s.rows, 1, 'one row for the cut-off turn');
  assert.equal(s.rowText, HUB_NOTICE);
  assert.deepEqual(s.button, { disabled: false, title: '' }, '이어서 진행 is offered');
  assert.equal(s.queueLine, '대기 메시지 1개는 이어서 진행한 뒤 보내요');
  assert.deepEqual(s.cards, ['만료됨 · 허브 재시작'], 'the question card says why it expired');
  assert.ok(!s.systemLines.some((text) => text.includes('작업이 중단됐습니다')), `no old hub line: ${JSON.stringify(s.systemLines)}`);
  assert.equal(s.failureNotices, 0, 'a hub restart is not a provider failure notice');
  assert.equal(s.hold, 'interrupted');
  assert.equal(s.holdText, '허브 재시작 · 작업이 끊겨 대기 메시지를 보내지 않았어요');
  assert.ok(s.folds.length === 1 && s.folds[0].startsWith('중단됨'), `the fold reads 중단됨: ${JSON.stringify(s.folds)}`);
  const cut = await storedMarker(page);
  assert.equal(cut.outcome, 'interrupted');
  assert.equal(cut.interruption?.reason, 'hub-restart');
  assert.equal(cut.owner?.window, 'preview-window');
  assert.match(cut.hubTurnId ?? '', /^turn-\d+$/, 'the hub turn id is stored with the marker');
  await screenshot('interrupted-live');

  // 이어서 진행: 말풍선은 이어서 진행해 주세요. 만, 에이전트에게는 끊긴 턴 블록이 간다. 세션이 없으니 채팅부터 연다.
  const startsBefore = s.chatStarts;
  // 이어 간 턴부터는 가짜 프로바이더가 보통으로 답하고 끝낸다.
  await page.evaluate(() => window.sidebarPreview.setHold(false));
  await page.click('.ag-turn-interrupted-resume');
  await waitFor(page, () => window.sidebarPreview.snapshot().messageTexts.length === 2, undefined, 'the resume message was not sent');
  s = await state(page);
  const sent = s.messageTexts.at(-1);
  assert.ok(sent.startsWith(`${RESUME_TEXT}\n\n<turn_interrupted reason="hub-restart">`), sent);
  assert.ok(sent.trimEnd().endsWith('</turn_interrupted>'), sent);
  assert.match(sent, /question to the user expired unanswered/);
  assert.equal(s.userBubbles.at(-1), RESUME_TEXT, 'the bubble shows only the resume text');
  assert.equal(s.chatStarts, startsBefore + 1, 'a new chat session is started before the message');
  assert.equal(s.button, null, 'the row keeps only its reason after resuming');
  // 이어 간 턴이 정상으로 끝나면 붙잡혔던 대기 메시지가 나간다.
  await waitFor(page, () => window.sidebarPreview.snapshot().messageTexts.includes('표 머리글도 굵게 해 주세요'),
    undefined, 'the held follow-up was not sent after the resumed turn');
  const resumedCut = await page.evaluate((id) => {
    const thread = window.sidebarPreview.threadStore.getThread(window.sidebarPreview.sidebar.currentThreadId());
    return thread.messages.find((message) => message.kind === 'turn' && message.messageId === id) ?? null;
  }, cut.messageId);
  assert.equal(resumedCut?.interruption?.resolution, 'resumed');
  const followUpText = (await state(page)).messageTexts.at(-1);
  assert.equal(followUpText, '표 머리글도 굵게 해 주세요', 'only the first message after the interruption carries the block');
  await waitFor(page, () => !window.sidebarPreview.snapshot().running, undefined, 'the follow-up turn did not end');

  // 2. 단추 대신 직접 보낸 메시지도 블록을 싣고(superseded), 그다음 메시지는 싣지 않는다.
  await openPreview(page, origin, 'reset=1&scenario=interrupted');
  await page.click('#play');
  await waitFor(page, () => document.querySelector('.ag-turn-interrupted .ag-turn-interrupted-resume:not([hidden])'),
    undefined, 'no row after the automatic hub restart');
  await page.focus('.ag-input');
  await page.type('.ag-input', '처음부터 다시 봐 주세요');
  await page.keyboard.press('Enter');
  await waitFor(page, () => window.sidebarPreview.snapshot().messageTexts.length === 2, undefined, 'the typed message was not sent');
  s = await state(page);
  assert.ok(s.messageTexts[1].startsWith('처음부터 다시 봐 주세요\n\n<turn_interrupted reason="hub-restart">'), s.messageTexts[1]);
  assert.equal(s.button, null);
  assert.equal(s.rowText, HUB_NOTICE, 'the reason stays where the turn stopped');
  await waitFor(page, () => !window.sidebarPreview.snapshot().running
    && document.querySelector('#agent-sidebar')?.dataset.composerReady === 'true', undefined, 'the typed turn did not end');
  await page.type('.ag-input', '고마워요');
  await page.keyboard.press('Enter');
  await waitFor(page, () => window.sidebarPreview.snapshot().messageTexts.length === 3, undefined, 'the second message was not sent');
  assert.equal((await state(page)).messageTexts[2], '고마워요');

  // 3. 사용자가 멈춘 턴은 끊김 줄이 없다. 멈추며 거둔 질문은 '중단됨'이다.
  await openPreview(page, origin, 'reset=1&scenario=chat&hold=1');
  await page.click('#play');
  await waitFor(page, () => window.sidebarPreview.snapshot().running, undefined, 'the held turn did not start');
  await page.evaluate(() => window.sidebarPreview.askQuestion());
  await waitFor(page, () => window.sidebarPreview.bridge.getPendingUserQuestion() !== null, undefined, 'no question');
  await page.evaluate(() => window.sidebarPreview.bridge.interrupt());
  await waitFor(page, () => !window.sidebarPreview.snapshot().running, undefined, 'stop did not end the turn');
  s = await state(page);
  assert.equal(s.rows, 0, 'a user stop is not an interruption');
  assert.deepEqual(s.cards, ['중단됨'], 'a question withdrawn by a stop reads 중단됨');
  // 끊김 이유 없이 만료된 질문(연결이 끊긴 실패 턴)은 이유 없이 '만료됨'이다.
  await page.evaluate(() => window.sidebarPreview.askQuestion());
  await waitFor(page, () => window.sidebarPreview.bridge.getPendingUserQuestion() !== null, undefined, 'no second question');
  await page.select('#connection', 'disconnected');
  await waitFor(page, () => document.querySelectorAll('.ag-question-history').length === 2, undefined, 'the second card did not settle');
  s = await state(page);
  assert.deepEqual(s.cards, ['중단됨', '만료됨']);
  assert.equal(s.rows, 0, 'a failed turn is not an interruption');
  await page.select('#connection', 'connected');

  // 4. 저장된 끊긴 턴(앱 재시작): 열면 이유·이어서 진행·만료 카드·붙잡힌 대기열이 그대로 보인다.
  await openPreview(page, origin, 'reset=1&chats=sample');
  await page.evaluate(() => window.sidebarPreview.sidebar.openThreadById('preview-chat-interrupted'));
  await waitFor(page, () => document.querySelector('.ag-turn-interrupted'), undefined, 'the stored interruption has no row');
  s = await state(page);
  assert.equal(s.rowText, '앱이 다시 시작되어 작업이 중단됐어요');
  assert.deepEqual(s.cards, ['만료됨 · 앱 재시작']);
  assert.deepEqual(s.button, { disabled: false, title: '' });
  assert.equal(s.queueLine, '대기 메시지 1개는 이어서 진행한 뒤 보내요');
  assert.equal(s.holdText, '앱 재시작 · 작업이 끊겨 대기 메시지를 보내지 않았어요');
  assert.deepEqual(s.folds, ['중단됨 · 1분 12초 · 표 1개 읽음 · 문서 읽음']);
  await screenshot('interrupted-restored');
  // 연결이 끊기면 단추는 막히고 이유를 말한다(보이는 상태는 400ms 뒤에 바뀐다).
  await page.select('#connection', 'disconnected');
  await waitFor(page, () => document.querySelector('.ag-turn-interrupted-resume')?.getAttribute('aria-disabled') === 'true',
    undefined, 'the resume button is not blocked while disconnected');
  s = await state(page);
  assert.equal(s.button.title, '허브에 연결되면 이어서 진행할 수 있어요');
  await page.click('.ag-turn-interrupted-resume');
  assert.equal((await state(page)).messageTexts.length, 0, 'a blocked resume sends nothing');
  await page.select('#connection', 'connected');
  await waitFor(page, () => document.querySelector('.ag-turn-interrupted-resume')?.getAttribute('aria-disabled') !== 'true',
    undefined, 'the resume button stays blocked after reconnecting');

  // 5. 새로고침에 사라진 이 창의 턴: 시작 정리가 끊긴 턴(새로고침)으로 정착하고 질문 초안은 만료 카드가 된다.
  await openPreview(page, origin, 'reset=1&chats=sample&reload=lost');
  await waitFor(page, () => window.sidebarPreview.sidebar.currentThreadId() === 'preview-chat-schedule'
    && document.querySelector('.ag-turn-interrupted'), undefined, 'the lost turn has no row after startup');
  s = await state(page);
  assert.equal(s.rowText, '페이지를 새로 고쳐 작업이 중단됐어요');
  assert.deepEqual(s.cards, ['만료됨 · 새로고침']);
  assert.deepEqual(s.button, { disabled: false, title: '' });
  const lost = await storedMarker(page);
  assert.deepEqual([lost.outcome, lost.interruption?.reason], ['interrupted', 'reload']);
  assert.equal(await page.evaluate(() => window.sidebarPreview.threadStore.getThread('preview-chat-schedule').pendingUserQuestion ?? null), null);
  await screenshot('interrupted-reload');
  // 같은 새로고침인데 그 채팅의 문서가 열려 있지 않다 — 보지 않은 채 정착한 채팅은 목록에 '중단됨'으로 선다(U3).
  await openPreview(page, origin, 'reset=1&chats=sample&reload=lost&document=empty');
  await page.evaluate(() => window.sidebarPreview.sidebar.startupChatSettled());
  assert.notEqual(await page.evaluate(() => window.sidebarPreview.sidebar.currentThreadId()), 'preview-chat-schedule');
  assert.deepEqual(await railStatus(page, 'preview-chat-schedule'), { status: 'failed', label: '중단됨' },
    'the chat cut off by the reload reads 중단됨 in the list');

  // 6. 엔진 멈춤으로 끊긴 채팅(S7 복구 뒤): 이유와 이어서 진행.
  await openPreview(page, origin, 'reset=1&chats=engine-trap');
  await waitFor(page, () => document.querySelector('.ag-turn-interrupted'), undefined, 'the engine-trap chat has no row');
  s = await state(page);
  assert.equal(s.rowText, '문서 엔진이 멈춰 작업이 중단됐어요');
  assert.deepEqual(s.button, { disabled: false, title: '' });
}

if (isMainModule(import.meta)) {
  await runStandalone('interruption', checkInterruptionPreview);
}
