// 새로고침 뒤 허브의 채팅을 이 화면에 다시 붙이는 길(S2)에서 턴의 끝을 잃거나 엉뚱한 채팅에 붙이지 않는지
// 실제 사이드바와 가짜 브리지로 본다 — welcome 앞에 다시 보낸 턴의 끝, 붙이기 전에 온 이벤트, 다시 보내지
// 않은 끝, 다시 잡은 턴의 늦은 끝.
// 혼자 돌릴 때: node sidebar-preview/adoption.check.mjs (CHROME_PATH 필요, standalone.mjs 가 자기 Vite 서버를 띄운다).
import assert from 'node:assert/strict';
import { isMainModule, runStandalone } from './standalone.mjs';

const WORKING_CHAT = 'preview-chat-schedule';
const MARKER = `${WORKING_CHAT}-turn-1`;

async function open(page, origin, query) {
  await page.goto(`${origin}/?reset=1&theme=light&width=480&${query}`, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => window.sidebarPreview);
  await page.evaluate(() => window.sidebarPreview.sidebar.startupChatSettled());
}

const state = (page) => page.evaluate(() => {
  const preview = window.sidebarPreview;
  const threadId = preview.sidebar.currentThreadId();
  const thread = threadId ? preview.threadStore.getThread(threadId) : null;
  return {
    threadId,
    markers: (thread?.messages ?? []).filter((message) => message.kind === 'turn')
      .map((marker) => ({ id: marker.messageId, outcome: marker.outcome, ended: marker.endedAt !== null, interruption: marker.interruption ?? null })),
    notices: [...document.querySelectorAll('.ag-failure-notice .ag-failure-title')].map((node) => node.textContent),
    rows: [...document.querySelectorAll('.ag-turn-interrupted-text')].map((node) => node.textContent),
    folds: [...document.querySelectorAll('.ag-messages > .ag-turn-fold:not([hidden]) .ag-turn-fold-toggle')]
      .map((node) => node.getAttribute('title') ?? node.textContent),
    toolRows: document.querySelectorAll('.ag-messages .ag-tool-row, .ag-messages .ag-tool').length,
    messagesText: document.querySelector('.ag-messages')?.textContent ?? '',
  };
});

async function waitFor(page, predicate, arg, message) {
  try {
    await page.waitForFunction(predicate, { timeout: 8000 }, arg);
  } catch (error) {
    throw new Error(`${message}: ${JSON.stringify(await state(page))}`, { cause: error });
  }
}

export async function checkAdoptionPreview(page, origin) {
  // 1. 새로고침 사이에 실패로 끝난 턴: 허브가 welcome 앞에 다시 보낸 끝이 빈 시작 초안에 그려지지 않고, 다시
  //    붙인 채팅에서 실패로 정착하며 실패 알림도 그 채팅에 남는다.
  await open(page, origin, 'chats=sample&reload=failed');
  await waitFor(page, (id) => window.sidebarPreview.sidebar.currentThreadId() === id, WORKING_CHAT,
    'the chat whose turn failed during the reload was not restored');
  await waitFor(page, () => document.querySelector('.ag-failure-notice'), undefined, 'no failure notice in the restored chat');
  let s = await state(page);
  assert.deepEqual(s.markers.find((marker) => marker.id === MARKER), { id: MARKER, outcome: 'failed', ended: true, interruption: null });
  assert.equal(s.notices.length, 1, `one failure notice: ${JSON.stringify(s.notices)}`);
  assert.deepEqual(s.rows, [], 'a failed turn is not an interruption');

  // 2. 새로고침 사이에 끝까지 간 턴: 끊긴 턴이 아니라 끝난 턴으로 정착하고 접힌다.
  await open(page, origin, 'chats=sample&reload=ended');
  await waitFor(page, (id) => window.sidebarPreview.sidebar.currentThreadId() === id
    && document.querySelector('.ag-messages > .ag-turn-fold:not([hidden])'), WORKING_CHAT, 'the ended turn was not folded');
  s = await state(page);
  assert.deepEqual(s.markers.find((marker) => marker.id === MARKER), { id: MARKER, outcome: 'completed', ended: true, interruption: null });
  assert.deepEqual(s.rows, []);
  assert.ok(s.folds.length === 1 && s.folds[0].startsWith('작업'), `the turn folds as completed: ${JSON.stringify(s.folds)}`);

  // 3. 문서가 열리기 전에 온 이벤트: 초안에는 그리지 않고, 그 채팅을 붙이면 빠짐없이 그린다.
  await open(page, origin, 'chats=sample&reload=running&document=empty');
  await page.evaluate(() => {
    const stream = window.sidebarPreview.streamEvent;
    stream({ type: 'tool-call', agent: 'claude', callId: 'gap-1', tool: 'mcp__rhwp__get_structure', argsJson: '{}' });
    stream({ type: 'tool-result', agent: 'claude', callId: 'gap-1', ok: true, resultPreview: '구역 1개 · 문단 42개' });
    stream({ type: 'text-delta', agent: 'claude', text: '틈에 쓴 답의 첫 문장입니다. ' });
    stream({ type: 'text-delta', agent: 'claude', text: '이어지는 문장입니다.\n\n' });
  });
  s = await state(page);
  assert.equal(s.threadId, null, 'the draft stays empty while the chat waits for its document');
  assert.ok(!s.messagesText.includes('틈에 쓴 답'), 'nothing from the unbound chat is drawn on the draft');
  await page.select('#document', 'proposal');
  await waitFor(page, (id) => window.sidebarPreview.sidebar.currentThreadId() === id, WORKING_CHAT, 'the chat was not adopted when its document opened');
  await waitFor(page, () => document.querySelector('.ag-messages')?.textContent.includes('틈에 쓴 답의 첫 문장입니다. 이어지는 문장입니다.'),
    undefined, 'the answer streamed before the adoption is missing');
  await page.evaluate(() => window.sidebarPreview.finishTurn());
  await waitFor(page, () => document.querySelector('.ag-messages > .ag-turn-fold:not([hidden])'), undefined, 'the adopted turn did not fold');
  const tools = await page.evaluate((id) => window.sidebarPreview.threadStore.getThread(id).messages
    .filter((message) => message.kind === 'activity').flatMap((message) => message.tools.map((tool) => tool.callId)), WORKING_CHAT);
  assert.ok(tools.includes('gap-1'), `the tool call made before the adoption is recorded: ${JSON.stringify(tools)}`);

  // 4. 끊긴 사이에 끝났는데 허브가 그 끝을 다시 보내지 않은 턴: 다시 붙으면 열린 표식을 중단으로 정착한다.
  await open(page, origin, 'scenario=chat&hold=1');
  await page.click('#play');
  await waitFor(page, () => window.sidebarPreview.snapshot().running && document.querySelector('.ag-messages .ag-activity'),
    undefined, 'the held turn did not start');
  await page.evaluate(() => window.sidebarPreview.loseTurnEnd());
  await waitFor(page, () => {
    const id = window.sidebarPreview.sidebar.currentThreadId();
    const markers = window.sidebarPreview.threadStore.getThread(id).messages.filter((message) => message.kind === 'turn');
    return markers.at(-1)?.endedAt !== null;
  }, undefined, 'the turn whose end was lost stayed open');
  s = await state(page);
  assert.equal(s.markers.at(-1).outcome, 'interrupted');

  // 5. 다시 잡은 턴(T)의 늦은 끝은 그 뒤에 연 다른 채팅(X)의 열린 표식을 정착하지 않는다.
  await open(page, origin, 'chats=sample&reload=running');
  await waitFor(page, (id) => window.sidebarPreview.sidebar.currentThreadId() === id
    && window.sidebarPreview.bridge.isTurnRunning(), WORKING_CHAT, 'the running chat was not adopted');
  await page.evaluate(() => {
    const preview = window.sidebarPreview;
    preview.setLateTurnEnd(true);
    const base = preview.threadStore.getThread('preview-chat-overview');
    const now = Date.now();
    preview.threadStore.upsertThread({
      ...base,
      id: 'preview-chat-x',
      title: '다른 창에서 도는 채팅',
      messages: [
        { role: 'user', text: '다른 창에서 보낸 요청' },
        { role: 'system', kind: 'turn', messageId: 'x-marker', startedAt: now - 5_000, endedAt: null, outcome: null, text: '', hubTurnId: 'x-turn' },
      ],
    });
    // 다른 창이 그 채팅의 턴을 돌리고 있다(심장박동) — 열 때 끊긴 것으로 보지 않는다.
    preview.chatStatus.markChatWorking('preview-chat-x');
    preview.sidebar.openThreadById('preview-chat-x');
  });
  await waitFor(page, () => window.sidebarPreview.sidebar.currentThreadId() === 'preview-chat-x'
    && document.querySelector('#agent-sidebar')?.dataset.composerReady === 'true', undefined, 'X did not open');
  await page.evaluate(() => window.sidebarPreview.streamEvent({
    type: 'turn-end', agent: 'claude', turnId: 'preview-turn', stopReason: 'interrupted',
  }));
  await new Promise((done) => setTimeout(done, 200));
  const after = await page.evaluate(() => {
    const store = window.sidebarPreview.threadStore;
    const marker = (id, markerId) => store.getThread(id).messages.find((message) => message.kind === 'turn' && message.messageId === markerId);
    return { x: marker('preview-chat-x', 'x-marker'), t: marker('preview-chat-schedule', 'preview-chat-schedule-turn-1') };
  });
  assert.equal(after.x.endedAt, null, 'the late end of T does not settle X');
  assert.equal(after.t.outcome, 'interrupted', 'T settled when it was stopped');
}

if (isMainModule(import.meta)) {
  await runStandalone('adoption', checkAdoptionPreview);
}
