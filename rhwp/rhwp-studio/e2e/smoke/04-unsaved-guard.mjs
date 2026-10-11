import assert from 'node:assert/strict';
import { clickPage, newDocument, waitFor } from './lib.mjs';

const MARK = 'UNSAVED_GUARD';
const text = (page) => page.evaluate(() => window.__wasm.getTextRange(0, 0, 0, 100));

/** 새 문서를 요청하고 미저장 확인 창이 뜨면 label 버튼을 누른다. */
async function requestNewDocument(page, label) {
  await page.evaluate(() => window.__eventBus.emit('create-new-document'));
  await waitFor(page, 'unsaved changes dialog',
    () => document.querySelector('.modal-overlay .dialog-wrap')?.textContent.includes('저장하지 않은 변경사항'));
  await page.evaluate((name) => {
    [...document.querySelectorAll('.modal-overlay .dialog-btn')]
      .find((button) => button.textContent.trim() === name).click();
  }, label);
  await waitFor(page, 'dialog closed', () => !document.querySelector('.modal-overlay'));
}

export default {
  name: 'unsaved-changes guard',
  async run({ page }) {
    await newDocument(page);
    await clickPage(page);
    await page.keyboard.type(MARK);
    await waitFor(page, 'dirty document', () => window.__documentState.isDirty());

    await requestNewDocument(page, '취소');
    assert.equal(await text(page), MARK, 'cancel keeps the edited document');
    assert.ok(await page.evaluate(() => window.__documentState.isDirty()), 'cancel keeps it dirty');

    await requestNewDocument(page, '저장 안 함');
    await waitFor(page, 'blank new document', () => window.__wasm.getTextRange(0, 0, 0, 100) === ''
      && !window.__documentState.isDirty());
  },
};
