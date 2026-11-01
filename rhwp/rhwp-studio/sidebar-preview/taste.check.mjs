// Rau-0.1 구분선: 접힌 이름, 펼치기, 항목 되돌리기(허브 요청·저장), 그새 바뀐 항목, 같은 턴의 늦은 학습,
// 다른 채팅으로 온 학습, 모두 보기(문서 기억 시트의 이름표). 줄 표(새로·고침·물러남)와 강도는 item.change 에서 온다.
// 계정 기억 줄·표 이름·모두 보기가 설정 → Rau 로 가는 길은 rau-tab.check.mjs 가 본다.
// 기록에서 배운 구분선: 보이는 채팅의 끝, 다른 문서는 그 문서의 최근 채팅, 채팅 없는 문서는 아무 데도, 턴이 돌면 그 뒤.
import assert from 'node:assert/strict';

const CHAT = 'preview-chat-taste';
const TURN = 'preview-taste-turn';

const rows = (page) => page.$$eval('.ag-taste .ag-taste-row', (nodes) => nodes.map((row) => ({
  id: row.dataset.entryId,
  state: row.dataset.state ?? null,
  undo: row.querySelector('.ag-taste-undo') ? (row.querySelector('.ag-taste-undo').disabled ? 'disabled' : 'enabled') : 'none',
})));

const storedMarkers = (page, threadId) => page.evaluate((id) => window.sidebarPreview.threadStore.getThread(id)?.messages
  .filter((message) => message.kind === 'marker' && message.marker === 'taste')
  .map((marker) => ({ learnIds: [marker.learnId, ...(marker.learnIds ?? [])], items: marker.items.length, undone: marker.undone ?? [], stale: marker.stale ?? [] })), threadId);

export async function checkTaste({ page, open, screenshot }) {
  // 지금 채팅(표본)과 다른 채팅(chats=sample 의 회의록)이 함께 있다.
  await open('reset=1&taste=sample&chats=sample');
  await page.waitForFunction((id) => document.querySelector('.ag-taste') && window.sidebarPreview.sidebar.root
    .querySelector('.ag-taste')?.closest('#agent-sidebar') && window.sidebarPreview.threadStore.getThread(id), {}, CHAT);
  const toggle = await page.$('.ag-marker-taste');
  assert.equal(await toggle.evaluate((node) => node.getAttribute('aria-label')), 'Rau-0.1 4가지 배움');
  assert.equal(await toggle.evaluate((node) => node.getAttribute('aria-expanded')), 'false');
  assert.equal(await page.$eval('.ag-taste-body', (node) => node.checkVisibility()), false, 'collapsed by default');
  // 구분선은 그 턴의 답 뒤에 놓인다.
  assert.equal(await page.$eval('.ag-taste', (node) => node.previousElementSibling?.classList.contains('ag-msg-assistant')), true);
  if (screenshot) await screenshot('taste-collapsed');

  await toggle.click();
  assert.equal(await toggle.evaluate((node) => node.getAttribute('aria-expanded')), 'true');
  assert.deepEqual(await rows(page), [
    { id: 'mem_taste000001', state: null, undo: 'enabled' },
    { id: 'mem_taste000002', state: 'undone', undo: 'none' },
    { id: 'mem_taste000003', state: 'stale', undo: 'disabled' },
    { id: 'mem_taste000004', state: null, undo: 'enabled' },
  ]);
  // 줄 표는 item.change 에서 온다. 사라진 항목은 물러남, 바뀐 항목은 고침, 강도는 처음 → 나중.
  assert.deepEqual(await page.$$eval('.ag-taste-row', (nodes) => nodes.map((row) => row.querySelector('.ag-taste-tag')?.textContent)),
    ['NEW', 'NEW', '고침', 'EXIT']);
  assert.deepEqual(await page.$$eval('.ag-taste-row', (nodes) => nodes.map((row) => row.querySelector('.ag-strength')?.getAttribute('aria-label') ?? null)),
    ['새 기억, 강도 1/5', null, '강도 2/5', '강도 1/5에서 물러남'], 'strength from → to (none on the undone row)');
  // 이 구분선에는 계정 줄이 없으니 모두 보기 하나뿐이다(지시에 추가 제안은 없다).
  assert.deepEqual(await page.$$eval('.ag-taste-action', (nodes) => nodes.filter((node) => node.checkVisibility()).map((node) => node.textContent)), ['모두 보기']);
  if (screenshot) await screenshot('taste-expanded');

  // 되돌리기: 허브에 그 항목과 구분선의 변경 목록을 보내고, 되돌린 줄로 남아 저장된다.
  await page.click('.ag-taste-row[data-entry-id="mem_taste000001"] .ag-taste-undo');
  await page.waitForSelector('.ag-taste-row[data-entry-id="mem_taste000001"][data-state="undone"]');
  assert.deepEqual(await page.evaluate(() => window.sidebarPreview.taste.undos.map((call) => ({ ...call }))), [
    { learnId: 'learn_preview1', learnIds: ['learn_preview1'], documentId: 'preview-proposal', key: 'mem-preview-proposal', entryId: 'mem_taste000001', changes: 4 },
  ]);
  // 허브가 그새 바뀌었다고 답한 항목은 되돌릴 수 없는 줄이 된다.
  await page.evaluate(() => window.sidebarPreview.taste.skipUndo('mem_taste000004'));
  await page.click('.ag-taste-row[data-entry-id="mem_taste000004"] .ag-taste-undo');
  await page.waitForSelector('.ag-taste-row[data-entry-id="mem_taste000004"][data-state="stale"] .ag-taste-undo:disabled');
  await page.waitForFunction(async (id) => {
    const stored = window.sidebarPreview.threadStore.getThread(id)?.messages.find((message) => message.marker === 'taste');
    return stored?.undone?.includes('mem_taste000001') && stored?.stale?.includes('mem_taste000004');
  }, {}, CHAT);

  // 같은 턴의 늦은 학습은 그 구분선에 더해지고, 다른 채팅의 학습은 그 채팅에만 남는다.
  await page.evaluate((turnId) => {
    const base = { documentId: 'preview-proposal', key: 'mem-preview-proposal', changes: [{ op: 'add', entryId: 'mem_live' }] };
    window.sidebarPreview.emitTasteLearned({ ...base, threadId: 'preview-chat-taste', turnId, learnId: 'learn_live',
      items: [{ op: 'add', entryId: 'mem_live', text: '숫자는 천 단위 쉼표', origin: 'learned' }] });
    window.sidebarPreview.emitTasteLearned({ ...base, threadId: 'preview-chat-minutes', turnId: null, learnId: 'learn_other',
      items: [{ op: 'add', entryId: 'mem_other', text: '회의록은 개조식', origin: 'learned' }] });
  }, TURN);
  await page.waitForFunction(() => document.querySelector('.ag-marker-taste')?.getAttribute('aria-label') === 'Rau-0.1 5가지 배움');
  assert.equal(await page.$$eval('.ag-taste', (nodes) => nodes.length), 1, 'the open chat still has one divider');
  assert.deepEqual(await storedMarkers(page, CHAT), [{
    learnIds: ['learn_preview1', 'learn_live'], items: 5, undone: ['mem_taste000002', 'mem_taste000001'], stale: ['mem_taste000003', 'mem_taste000004'],
  }]);
  assert.deepEqual(await storedMarkers(page, 'preview-chat-minutes'), [{ learnIds: ['learn_other'], items: 1, undone: [], stale: [] }]);

  // 모두 보기: 문서 기억 시트. 자동 학습이 남긴 기억에만 Rau-0.1 이름표가 붙는다.
  await page.click('.ag-taste-action');
  await page.waitForSelector('.ag-memory-sheet', { visible: true });
  await page.waitForFunction(() => !document.querySelector('.ag-memory-sheet').dataset.loading);
  const badges = await page.$$eval('.ag-memory-row', (nodes) => nodes.map((row) => [
    row.querySelector('.ag-memory-text')?.textContent, row.querySelector('.ag-memory-origin')?.textContent ?? null,
  ]));
  assert.deepEqual(badges.filter(([, badge]) => badge).map(([text]) => text), ['본문 종결은 한다체로 쓴다']);
  assert(badges.every(([, badge]) => badge === null || badge === 'Rau-0.1'));
  if (screenshot) await screenshot('taste-memory-sheet');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('.ag-memory-sheet'));

  // 허브가 change 를 싣지 않은 예전 학습은 op 로 표를 정한다: add → 새로, update → 고침, remove → 물러남.
  await page.evaluate((turnId) => {
    window.sidebarPreview.emitTasteLearned({ threadId: 'preview-chat-taste', turnId, documentId: 'preview-proposal', key: 'mem-preview-proposal',
      learnId: 'learn_legacy', changes: [{ op: 'update', entryId: 'mem_leg1' }, { op: 'remove', entryId: 'mem_leg2' }],
      items: [
        { op: 'update', entryId: 'mem_leg1', text: '문단 끝은 마침표', prevText: '문단 끝은 쉼표', origin: 'learned' },
        { op: 'remove', entryId: 'mem_leg2', text: '제목은 굵게', origin: 'explicit' },
      ] });
  }, TURN);
  await page.waitForFunction(() => document.querySelector('.ag-marker-taste')?.getAttribute('aria-label') === 'Rau-0.1 7가지 배움');
  assert.equal(await page.$$eval('.ag-taste', (nodes) => nodes.length), 1);
  await page.waitForSelector('.ag-taste-row[data-entry-id="mem_leg1"]');
  assert.deepEqual(await page.$$eval('.ag-taste-row[data-entry-id^="mem_leg"]', (nodes) => nodes.map((row) => row.querySelector('.ag-taste-tag')?.textContent)),
    ['고침', 'EXIT']);
}

const historyLearned = (documentId, learnId, text) => ({
  documentId, key: `mem-${documentId}`, learnId, changes: [{ op: 'add', entryId: `mem_${learnId}` }],
  items: [{ op: 'add', entryId: `mem_${learnId}`, text, origin: 'learned' }],
});

export async function checkTasteHistory({ page, open, screenshot }) {
  await open('reset=1&taste=sample&chats=sample');
  await page.waitForFunction((id) => window.sidebarPreview.sidebar.currentThreadId() === id && document.querySelector('.ag-taste'), {}, CHAT);
  const stored = (threadId) => storedMarkers(page, threadId);
  const threadCount = () => page.evaluate(() => window.sidebarPreview.threadStore.listThreads().length);
  const emit = (learned) => page.evaluate((value) => window.sidebarPreview.emitTasteHistoryLearned(value), learned);

  // 보이는 채팅이 그 문서의 것이면 그 채팅의 끝에 놓인다 (턴에 묶이지 않는다). 같은 학습은 한 번만.
  // 들어오는 순간 압축·전환 구분선처럼 움직인다 (ag-marker-live 는 애니메이션이 끝나면 빠진다).
  await page.evaluate(() => {
    window.__liveDividers = [];
    new MutationObserver((records) => records.flatMap((record) => [...record.addedNodes])
      .filter((node) => node instanceof HTMLElement && node.matches('.ag-taste'))
      .forEach((node) => window.__liveDividers.push([node.dataset.learnId, node.querySelector('.ag-marker-taste').classList.contains('ag-marker-live')])))
      .observe(document.body, { childList: true, subtree: true });
  });
  await emit(historyLearned('preview-proposal', 'learn_history_visible', '보고 문장은 짧게 끊어 씀'));
  await emit(historyLearned('preview-proposal', 'learn_history_visible', '보고 문장은 짧게 끊어 씀'));
  const divider = await page.waitForSelector('.ag-taste[data-learn-id="learn_history_visible"]');
  assert.equal(await page.$$eval('.ag-taste', (nodes) => nodes.length), 2);
  assert.deepEqual(await page.evaluate(() => window.__liveDividers), [['learn_history_visible', true]], 'animates in once');
  assert.equal(await divider.evaluate((node) => { let next = node.nextElementSibling; while (next && !next.matches('.ag-msg')) next = next.nextElementSibling; return next === null; }), true, 'at the end');
  assert.deepEqual((await stored(CHAT)).at(-1), { learnIds: ['learn_history_visible'], items: 1, undone: [], stale: [] });
  assert.equal(await page.evaluate((id) => window.sidebarPreview.threadStore.getThread(id).messages.at(-1).turnId, CHAT), null);
  if (screenshot) await screenshot('taste-history-collapsed');
  await divider.evaluate((node) => node.querySelector('.ag-marker-taste').click());
  if (screenshot) await screenshot('taste-history-expanded');
  await divider.evaluate((node) => node.querySelector('.ag-taste-undo').click());
  await page.waitForSelector('.ag-taste[data-learn-id="learn_history_visible"] .ag-taste-row[data-state="undone"]');
  assert.deepEqual(await page.evaluate(() => ({ ...window.sidebarPreview.taste.undos.at(-1) })), {
    learnId: 'learn_history_visible', learnIds: ['learn_history_visible'], documentId: 'preview-proposal',
    key: 'mem-preview-proposal', entryId: 'mem_learn_history_visible', changes: 1,
  });
  assert.equal(await page.$$eval('.rhwp-toast-message', (nodes) => nodes.some((node) => node.textContent?.startsWith('Rau-0.1'))), false, 'no toast');

  // 뒤에 있는 문서의 학습은 그 문서의 최근 채팅에만 남는다 — 보이는 채팅(다른 문서)에는 오지 않는다.
  await emit(historyLearned('preview-notes', 'learn_history_notes', '회의록은 개조식'));
  await page.waitForFunction(() => window.sidebarPreview.threadStore.getThread('preview-chat-minutes')?.messages.at(-1)?.learnId === 'learn_history_notes');
  assert.equal(await page.$('.ag-taste[data-learn-id="learn_history_notes"]'), null);
  assert.deepEqual(await stored('preview-chat-attendees'), []);

  // 채팅이 없는 문서는 구분선도 채팅도 만들지 않는다.
  const before = await threadCount();
  await emit(historyLearned('preview-orphan', 'learn_history_orphan', '표는 가운데 정렬'));
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(await threadCount(), before);
  assert.equal(await page.$('.ag-taste[data-learn-id="learn_history_orphan"]'), null);

  // 턴이 도는 동안 온 학습은 그 턴의 출력을 가르지 않고 턴이 끝난 뒤 끝에 놓인다.
  await page.evaluate(() => window.sidebarPreview.setHold(true));
  await page.focus('.ag-input');
  await page.type('.ag-input', '결론 문단도 한다체로 바꿔 주세요.');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.sidebarPreview.snapshot().running);
  await emit(historyLearned('preview-proposal', 'learn_history_turn', '결론은 두 문장 안'));
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(await page.$('.ag-taste[data-learn-id="learn_history_turn"]'), null, 'held while the turn runs');
  assert.equal((await stored(CHAT)).some((marker) => marker.learnIds.includes('learn_history_turn')), false);
  await page.evaluate(() => window.sidebarPreview.finishTurn());
  const late = await page.waitForSelector('.ag-taste[data-learn-id="learn_history_turn"]');
  assert.equal(await late.evaluate((node) => { let next = node.nextElementSibling; while (next && !next.matches('.ag-msg')) next = next.nextElementSibling; return next === null; }), true, 'after the turn');
  const order = await page.evaluate((id) => window.sidebarPreview.threadStore.getThread(id).messages.map((message) => message.role === 'user' ? 'user' : message.marker ?? message.kind ?? message.role), CHAT);
  assert(order.lastIndexOf('taste') > order.lastIndexOf('user'), `stored after the turn: ${order.join(',')}`);
  assert.equal(order.at(-1), 'taste');
}
