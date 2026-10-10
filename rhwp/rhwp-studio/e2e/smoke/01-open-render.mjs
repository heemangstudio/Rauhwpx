import assert from 'node:assert/strict';
import { bodyText, openDocument, waitForInk } from './lib.mjs';

export default {
  name: 'open and render a sample document',
  async run({ page }) {
    await openDocument(page, 'biz_plan.hwp');
    const state = await page.evaluate(() => ({ fileName: window.__wasm.fileName, pages: window.__wasm.pageCount }));
    assert.equal(state.fileName, 'biz_plan.hwp');
    assert.ok(state.pages > 1, `multi-page document (${state.pages})`);
    const text = await bodyText(page);
    assert.match(text, /주식회사 OOO소O트/);
    assert.match(text, /사업목적/);
    // 첫 쪽 캔버스에 표지 글자와 목차 선이 실제로 그려진다.
    await waitForInk(page, 5000);
  },
};
