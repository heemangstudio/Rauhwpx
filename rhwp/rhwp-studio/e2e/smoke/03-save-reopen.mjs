import assert from 'node:assert/strict';
import { bodyText, clickPage, newDocument, openDocument, runMenuCommand, waitFor } from './lib.mjs';

const MARK = 'SMOKE_SAVED ';

export default {
  name: 'save HWPX and reopen',
  async run({ page }) {
    await openDocument(page, 'hwpx/footnote-01.hwpx');
    const pages = await page.evaluate(() => window.__wasm.pageCount);
    await clickPage(page);
    await page.keyboard.down('Control');
    await page.keyboard.press('Home');
    await page.keyboard.up('Control');
    await page.keyboard.type(MARK);
    await waitFor(page, 'marker typed', (mark) => window.__wasm.getTextRange(0, 0, 0, 100).startsWith(mark), MARK);
    await waitFor(page, 'dirty document', () => window.__documentState.isDirty());

    // 저장 위치 선택창 대신 쓰기 핸들을 넘겨 실제로 기록된 바이트를 받는다.
    await page.evaluate(() => {
      window.__smokeSaved = null;
      window.showSaveFilePicker = async (options) => {
        const name = options?.suggestedName ?? 'saved.hwpx';
        return {
          kind: 'file',
          name,
          async getFile() { return new File([window.__smokeSaved ?? ''], name); },
          async createWritable() {
            return { async write(blob) { window.__smokeSaved = blob; }, async close() {} };
          },
        };
      };
    });
    await runMenuCommand(page, '파일', 'file:save');
    await waitFor(page, 'saved file', () => window.__smokeSaved && !window.__documentState.isDirty());
    const saved = await page.evaluate(async () => Array.from(new Uint8Array(await window.__smokeSaved.arrayBuffer())));
    assert.deepEqual(saved.slice(0, 4), [0x50, 0x4b, 0x03, 0x04], 'HWPX is a ZIP container');

    await newDocument(page);
    await openDocument(page, saved, 'reopened.hwpx');
    assert.ok((await bodyText(page)).startsWith(MARK), 'reopened file keeps the typed text');
    assert.equal(await page.evaluate(() => window.__wasm.pageCount), pages);
    assert.equal(await page.evaluate(() => window.__wasm.getSourceFormat()), 'hwpx');
  },
};
