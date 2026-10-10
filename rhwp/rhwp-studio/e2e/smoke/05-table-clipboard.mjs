import assert from 'node:assert/strict';
import { clickPage, newDocument, runMenuCommand, shortcut, waitFor } from './lib.mjs';

/** 커서가 있는 표의 네 칸 텍스트가 expected 가 될 때까지 기다린다. */
const cellsAre = (page, label, expected) => waitFor(page, `${label} → ${JSON.stringify(expected)}`, (want) => {
  const { parentParaIndex, controlIndex } = window.__inputHandler.getCursorPosition();
  return [0, 1, 2, 3].every((cell, i) => window.__wasm.getTextInCell(0, parentParaIndex, controlIndex, cell, 0, 0, 100) === want[i]);
}, expected);

/** 편집 입력에 실제 copy/paste 이벤트를 보낸다(앱의 클립보드 처리기를 그대로 탄다). */
const clipboard = (page, type, text) => page.evaluate((kind, payload) => {
  const data = new DataTransfer();
  if (payload !== null) data.setData('text/plain', payload);
  window.__inputHandler.textarea.dispatchEvent(new ClipboardEvent(kind, { clipboardData: data, bubbles: true, cancelable: true }));
  return data.getData('text/plain');
}, type, text);

export default {
  name: 'table edit and clipboard',
  async run({ page }) {
    await newDocument(page);
    await clickPage(page);
    // 표 메뉴의 그리드에서 2×2 표를 고른다.
    await runMenuCommand(page, '표', 'table:create');
    await waitFor(page, 'table grid picker', () => document.querySelector('.table-create-grid'));
    const box = await (await page.$('.table-create-cell[data-row="1"][data-col="1"]')).boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await waitFor(page, 'caret in the first cell', () => window.__inputHandler.getCursorPosition().cellIndex === 0);

    await page.keyboard.type('Alpha');
    await cellsAre(page, 'typing in a cell', ['Alpha', '', '', '']);
    await page.keyboard.down('Shift');
    await page.keyboard.press('Home');
    await page.keyboard.up('Shift');
    assert.equal(await clipboard(page, 'copy', null), 'Alpha', 'copy takes the selected cell text');

    await page.keyboard.press('Tab');
    await waitFor(page, 'caret in the second cell', () => window.__inputHandler.getCursorPosition().cellIndex === 1);
    await clipboard(page, 'paste', 'Alpha');
    await cellsAre(page, 'paste into the next cell', ['Alpha', 'Alpha', '', '']);
    await shortcut(page, 'KeyZ');
    await cellsAre(page, 'undo paste', ['Alpha', '', '', '']);
  },
};
