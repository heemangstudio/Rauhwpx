// @ 의 '문서' 묶음: 프로젝트가 없는 채팅에서도 열린·최근 문서를 고르고, 보낸 메시지가 documentMentions 를 싣는다.
import assert from 'node:assert/strict';

async function pickDocument(page, query) {
  await page.type('.ag-input', `@${query}`);
  await page.waitForSelector('.ag-mention-option[data-mention-kind="document"]', { visible: true });
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => !document.querySelector('.ag-mention-menu:not([hidden])'));
}

export async function checkDocumentMentions({ page, open, screenshot }) {
  await open('reset=1&scenario=chat&theme=light&width=480');
  // 프로젝트가 없는 채팅 — 프로젝트 항목은 없고 문서 묶음만 남는다.
  await page.evaluate(() => window.sidebarPreview.bridge.projects.store.replace(null));
  await page.focus('.ag-input');
  await page.type('.ag-input', '@');
  await page.waitForSelector('.ag-mention-option[data-mention-kind="document"]', { visible: true });
  const menu = await page.$eval('.ag-mention-menu', (node) => ({
    group: node.querySelector('.ag-mention-group')?.textContent ?? null,
    items: node.querySelectorAll('.ag-mention-option:not([data-mention-kind])').length,
    documents: [...node.querySelectorAll('.ag-mention-option[data-mention-kind="document"] .ag-slash-name')].map((name) => name.textContent),
  }));
  assert.equal(menu.group, '문서');
  assert.equal(menu.items, 0);
  assert.ok(menu.documents.length >= 2, `documents listed: ${menu.documents}`);
  assert.ok(!menu.documents.includes('사업 제안서.hwpx'), 'the chat document is not offered');
  if (screenshot) await screenshot('document-mentions-picker');
  await page.keyboard.press('Escape');
  await page.$eval('.ag-input', (input) => { input.value = ''; input.dispatchEvent(new Event('input', { bubbles: true })); });

  await pickDocument(page, '회의록');
  await pickDocument(page, '예산');
  assert.equal(await page.$$eval('.ag-mention-draft', (chips) => chips.length), 2);
  await page.type('.ag-input', '두 문서를 비교해 줘');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.ag-msg-user .ag-mention-pill[data-mention-kind="document"]');
  const sent = await page.evaluate(() => window.sidebarPreview.snapshot().sentDocumentMentions.at(-1));
  assert.deepEqual(sent, [
    { documentId: 'preview-notes', title: '회의록.hwpx' },
    { documentId: 'preview-budget', title: '2027 예산 계획.hwp' },
  ]);
  if (screenshot) await screenshot('document-mentions-sent');
}
