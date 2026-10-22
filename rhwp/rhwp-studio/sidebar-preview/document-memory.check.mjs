// 문서 기억 시트: 고치기·지우기·더하기가 허브(모의 저장소)에 닿고 목록이 따라오는지,
// 문서에서 사라진 인용이 표시되는지, 다른 곳의 기록이 고치던 줄을 덮지 않는지.
import assert from 'node:assert/strict';

const DOCUMENT = 'preview-proposal';

const rowTexts = (page) => page.$$eval('.ag-memory-row', (rows) => rows.map((row) => ({
  kind: row.closest('.ag-memory-group')?.dataset.kind,
  text: row.querySelector('.ag-memory-text')?.textContent ?? row.querySelector('textarea')?.value,
  stale: row.dataset.stale === 'true',
})));

const stored = (page) => page.evaluate(async (documentId) => {
  const result = await window.sidebarPreview.bridge.listDocumentMemory(documentId);
  return result.memory.entries.map((entry) => ({ kind: entry.kind, text: entry.text, origin: entry.origin }));
}, DOCUMENT);

async function rowHandle(page, text) {
  const handle = await page.evaluateHandle((wanted) => [...document.querySelectorAll('.ag-memory-row')]
    .find((row) => row.querySelector('.ag-memory-text')?.textContent === wanted), text);
  const row = handle.asElement();
  assert(row, `row “${text}” is listed`);
  return row;
}

async function waitForRows(page, predicate, label) {
  await page.waitForFunction(predicate, { timeout: 5_000 }).catch(async () => {
    throw new Error(`${label}: ${JSON.stringify(await rowTexts(page))}`);
  });
}

export async function checkDocumentMemory({ page, open, screenshot }) {
  await open('reset=1&memory=sample');
  await page.waitForSelector('.ag-memory-sheet', { visible: true });
  await page.waitForFunction(() => !document.querySelector('.ag-memory-sheet').dataset.loading);
  const initial = await rowTexts(page);
  assert.deepEqual(initial.map((row) => row.kind), ['style', 'term', 'decision', 'protect'], 'groups follow 문체, 용어, 결정, 보호');
  assert.deepEqual(initial.filter((row) => row.stale).map((row) => row.text), ['결론 문단 수정 금지'],
    'only the entry whose quote left the document is marked');
  if (screenshot) await screenshot('document-memory-sheet');

  // 고치기: 눌러서 열고 Enter 로 저장한다. 허브에는 사용자가 고친 기억으로 남는다.
  await (await rowHandle(page, '본문은 한다체 사용')).$eval('.ag-memory-text', (node) => node.click());
  await page.waitForSelector('.ag-memory-edit');
  await page.$eval('.ag-memory-edit', (area) => area.select());
  await page.keyboard.type('본문은 합니다체 사용');
  await page.keyboard.press('Enter');
  await waitForRows(page, () => [...document.querySelectorAll('.ag-memory-text')]
    .some((node) => node.textContent === '본문은 합니다체 사용') && !document.querySelector('.ag-memory-row[data-pending]'), 'edit saved');
  assert.deepEqual((await stored(page)).find((entry) => entry.kind === 'style'),
    { kind: 'style', text: '본문은 합니다체 사용', origin: 'user' });

  // Esc 는 고치기만 거둔다 — 시트는 그대로다.
  await (await rowHandle(page, '예산표는 분기별로 나눔')).$eval('.ag-memory-text', (node) => node.click());
  await page.waitForSelector('.ag-memory-edit');
  await page.keyboard.type(' 버릴 글');
  await page.keyboard.press('Escape');
  assert.equal(await page.$('.ag-memory-edit'), null, 'Esc cancels the edit');
  assert(await page.$('.ag-memory-sheet'), 'Esc during an edit keeps the sheet open');
  assert((await stored(page)).some((entry) => entry.text === '예산표는 분기별로 나눔'), 'a cancelled edit is not saved');

  // 지우기: 한 번 누르면 묻지 않고 지운다.
  await (await rowHandle(page, "'고객' 대신 '이용자'로 통일")).$eval('.ag-memory-remove', (node) => node.click());
  await waitForRows(page, () => document.querySelectorAll('.ag-memory-row').length === 3
    && !document.querySelector('.ag-memory-group[data-kind="term"]'), 'entry removed');
  assert(!(await stored(page)).some((entry) => entry.kind === 'term'), 'the hub no longer has the entry');

  // 더하기: 종류를 고르고 Enter.
  await page.click('.ag-memory-kind-btn');
  const factItem = await page.waitForFunction(() => [...document.querySelectorAll('.context-menu .md-item')]
    .find((item) => item.textContent?.includes('사실')));
  await factItem.asElement().click();
  await page.waitForFunction(() => document.activeElement?.classList.contains('ag-memory-add-input'));
  await page.keyboard.type('제출 마감은 11월 3일');
  await page.keyboard.press('Enter');
  await waitForRows(page, () => [...document.querySelectorAll('.ag-memory-group[data-kind="fact"] .ag-memory-text')]
    .some((node) => node.textContent === '제출 마감은 11월 3일'), 'entry added');
  assert.equal(await page.$eval('.ag-memory-add-input', (input) => input.value), '', 'the add field clears');

  // 다른 곳(에이전트 도구)의 기록은 고치던 줄을 덮지 않고, 고치기가 끝나면 목록에 들어온다.
  await (await rowHandle(page, '결론 문단 수정 금지')).$eval('.ag-memory-text', (node) => node.click());
  await page.waitForSelector('.ag-memory-edit');
  await page.keyboard.type(' 유지');
  await page.evaluate((documentId) => window.sidebarPreview.bridge.applyDocumentMemory(
    [{ op: 'add', kind: 'term', subject: '', text: "'사업' 대신 '과제'" }], { documentId }), DOCUMENT);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(await page.$eval('.ag-memory-edit', (area) => area.value), '결론 문단 수정 금지 유지', 'the draft survives');
  await page.keyboard.press('Enter');
  await waitForRows(page, () => {
    const texts = [...document.querySelectorAll('.ag-memory-text')].map((node) => node.textContent);
    return texts.includes("'사업' 대신 '과제'") && texts.includes('결론 문단 수정 금지 유지')
      && !document.querySelector('.ag-memory-row[data-pending]');
  }, 'outside write merged after the edit');
  assert((await stored(page)).some((entry) => entry.text === '결론 문단 수정 금지 유지'),
    'the edit saved over the newer revision');

  // 고치는 사이 다른 곳에서 같은 항목을 고쳤으면 덮지 않는다 — 초안은 남기고 알린다.
  await (await rowHandle(page, '제출 마감은 11월 3일')).$eval('.ag-memory-text', (node) => node.click());
  await page.waitForSelector('.ag-memory-edit');
  await page.keyboard.type(' 오후 6시');
  await page.evaluate(async (documentId) => {
    const { bridge } = window.sidebarPreview;
    const { memory } = await bridge.listDocumentMemory(documentId);
    const target = memory.entries.find((entry) => entry.text === '제출 마감은 11월 3일');
    await bridge.applyDocumentMemory([{ op: 'update', id: target.id, text: '제출 마감은 11월 5일' }], { documentId });
  }, DOCUMENT);
  await new Promise((resolve) => setTimeout(resolve, 200));
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => !document.querySelector('.ag-memory-error').hidden, { timeout: 5_000 });
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(await page.$eval('.ag-memory-edit', (area) => area.value), '제출 마감은 11월 3일 오후 6시', 'the draft is kept');
  const facts = (await stored(page)).filter((entry) => entry.kind === 'fact').map((entry) => entry.text);
  assert.deepEqual(facts, ['제출 마감은 11월 5일'], 'the concurrent edit is not overwritten');
  await page.keyboard.press('Escape');

  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('.ag-memory-sheet'));

  // 머리의 문서 이름 우클릭 메뉴로 다시 연다 — 닫혀 있던 동안의 기록도 보인다.
  await page.click('.ag-document-name', { button: 'right' });
  const menuItem = await page.waitForFunction(() => [...document.querySelectorAll('.context-menu .md-item')]
    .find((item) => item.textContent?.includes('문서 기억')));
  await menuItem.asElement().click();
  await page.waitForSelector('.ag-memory-sheet', { visible: true });
  await waitForRows(page, () => document.querySelectorAll('.ag-memory-row').length === 5, 'reopened sheet lists every entry');
}
