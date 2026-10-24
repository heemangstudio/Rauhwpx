// Rau-0.1 구분선: 접힌 이름, 펼치기, 항목 되돌리기(허브 요청·저장), 그새 바뀐 항목, 같은 턴의 늦은 학습,
// 다른 채팅으로 온 학습, 모두 보기(문서 기억 시트의 이름표), 지시에 추가 제안, 설정의 대화에서 배우기와 학습기 공급자.
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
  const actions = () => page.$$eval('.ag-taste-action', (nodes) => nodes.filter((node) => node.checkVisibility()).map((node) => node.textContent));
  await page.waitForFunction(() => document.querySelectorAll('.ag-taste-action:not([hidden])').length === 2);
  assert.deepEqual(await actions(), ['모두 보기', '지시에 추가 제안']);
  if (screenshot) await screenshot('taste-expanded');

  // 되돌리기: 허브에 그 항목과 구분선의 변경 목록을 보내고, 되돌린 줄로 남아 저장된다.
  await page.click('.ag-taste-row[data-entry-id="mem_taste000001"] .ag-taste-undo');
  await page.waitForSelector('.ag-taste-row[data-entry-id="mem_taste000001"][data-state="undone"]');
  assert.deepEqual(await page.evaluate(() => window.sidebarPreview.taste.undos.map((call) => ({ ...call }))), [
    { learnId: 'learn_preview1', documentId: 'preview-proposal', key: 'mem-preview-proposal', entryId: 'mem_taste000001', changes: 4 },
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
  assert.deepEqual(badges.filter(([, badge]) => badge).map(([text]) => text), ['본문은 한다체 사용']);
  assert(badges.every(([, badge]) => badge === null || badge === 'Rau-0.1'));
  if (screenshot) await screenshot('taste-memory-sheet');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('.ag-memory-sheet'));

  // 지시에 추가 제안: 설정 → AI 의 변경안 카드. 적용하면 제안 줄이 사라진다.
  await page.click('.ag-taste-action:not([hidden]) + .ag-taste-action');
  await page.waitForSelector('.ag-settings-instructions-proposal:not([hidden])', { visible: true });
  const tasteToggle = await page.waitForFunction(() => [...document.querySelectorAll('.ag-settings-section')]
    .find((section) => section.querySelector('.ag-settings-section-title')?.textContent === 'Rau-0.1')
    ?.querySelector('input[role="switch"]:not(:disabled)'));
  assert.equal(await tasteToggle.evaluate((input) => input.checked), true, 'learning is on by default');
  if (screenshot) await screenshot('taste-settings');
  await tasteToggle.evaluate((input) => input.click());
  await page.waitForFunction((input) => !input.disabled && !input.checked, {}, tasteToggle);
  const tasteSettings = () => page.evaluate(() => window.sidebarPreview.bridge.requestTasteSettings());
  assert.deepEqual(await tasteSettings(), { enabled: false, provider: 'auto', model: null, effort: null });
  const field = (name) => `.ag-taste-settings [data-taste-field="${name}"]`;
  assert.equal(await page.$eval(`${field('provider')} select`, (node) => node.disabled), true, 'the provider is locked while learning is off');
  await tasteToggle.evaluate((input) => input.click());
  await page.waitForFunction((selector) => document.querySelector(selector)?.disabled === false, {}, `${field('provider')} select`);
  assert.equal(await page.$eval(field('model'), (node) => node.hidden), true, 'auto has no model choice');

  // OpenRouter 는 내 키로만 돈다 — 키가 없으면 키 칸이 보이고, Pi 설정과 같은 길로 저장된다.
  await page.evaluate(() => window.sidebarPreview.setPiOwnKey(false));
  await page.select(`${field('provider')} select`, 'pi');
  await page.waitForSelector('.ag-taste-key-row:not([hidden])');
  await page.waitForFunction((selector) => document.querySelector(selector)?.value === 'deepseek/deepseek-v4.1-flash', {}, `${field('model')} select`);
  assert.deepEqual(await tasteSettings(), { enabled: true, provider: 'pi', model: null, effort: null });
  assert.equal(await page.$eval(`${field('effort')} select`, (node) => node.value), 'max');
  if (screenshot) await screenshot('taste-settings-openrouter-key');
  await page.type('.ag-taste-key-row input', 'sk-or-v1-preview');
  await page.click('.ag-taste-key-row button');
  await page.waitForSelector('.ag-taste-key-row', { hidden: true });
  assert.equal((await page.evaluate(() => window.sidebarPreview.bridge.requestPiStatus())).keyConfigured, true);
  await page.select(`${field('model')} select`, 'openai/gpt-5.2');
  await page.waitForFunction(() => window.sidebarPreview.bridge.requestTasteSettings().then((value) => value.model === 'openai/gpt-5.2'));
  // 공급자를 바꾸면 모델·추론은 그 공급자의 기본값으로 돌아간다.
  await page.select(`${field('provider')} select`, 'claude');
  await page.waitForFunction((selector) => document.querySelector(selector)?.disabled === false, {}, `${field('provider')} select`);
  assert.deepEqual(await tasteSettings(), { enabled: true, provider: 'claude', model: null, effort: null });
  assert.equal(await page.$eval('.ag-taste-key-row', (node) => node.hidden), true);
  await page.select(`${field('provider')} select`, 'auto');
  await page.waitForFunction((selector) => document.querySelector(selector)?.hidden === true, {}, field('model'));
  await page.click('.ag-settings-instructions-proposal .ag-settings-primary');
  await page.waitForSelector('.ag-settings-instructions-proposal', { hidden: true });
  assert.equal(await page.$eval('.ag-taste-action + .ag-taste-action', (node) => node.hidden), true);

  // 허브는 변경안을 먼저 보내고 그 학습을 뒤에 보낸다. 이미 있는 구분선에 합쳐져도 제안이 보인다.
  await page.evaluate((turnId) => {
    window.sidebarPreview.emitTasteDraft('preview-taste-draft-2');
    window.sidebarPreview.emitTasteLearned({ threadId: 'preview-chat-taste', turnId, documentId: 'preview-proposal', key: 'mem-preview-proposal',
      learnId: 'learn_live2', changes: [{ op: 'add', entryId: 'mem_live2' }], proposal: { draftId: 'preview-taste-draft-2' },
      items: [{ op: 'add', entryId: 'mem_live2', text: '문단 끝은 마침표', origin: 'learned' }] });
  }, TURN);
  await page.waitForFunction(() => document.querySelector('.ag-marker-taste')?.getAttribute('aria-label') === 'Rau-0.1 6가지 배움');
  assert.equal(await page.$$eval('.ag-taste', (nodes) => nodes.length), 1);
  assert.equal(await page.$eval('.ag-taste-action + .ag-taste-action', (node) => node.hidden), false, 'the merged divider offers the new proposal');
}
