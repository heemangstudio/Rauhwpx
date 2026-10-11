import { clickPage, newDocument, shortcut, waitFor } from './lib.mjs';

const textIs = (page, label, expected) => waitFor(page, `${label} → ${JSON.stringify(expected)}`,
  (value) => window.__wasm.getTextRange(0, 0, 0, 100) === value, expected);

export default {
  name: 'type, undo, redo',
  async run({ page }) {
    await newDocument(page);
    await clickPage(page);
    await page.keyboard.type('Hello smoke');
    await textIs(page, 'typing', 'Hello smoke');
    await shortcut(page, 'KeyZ');
    await textIs(page, 'undo', '');
    await shortcut(page, 'KeyZ', { shift: true });
    await textIs(page, 'redo', 'Hello smoke');
    // 되돌린 뒤 새로 입력하면 다시 실행할 기록이 사라진다.
    await shortcut(page, 'KeyZ');
    await textIs(page, 'second undo', '');
    await page.keyboard.type('New');
    await textIs(page, 'new typing', 'New');
    await shortcut(page, 'KeyZ', { shift: true });
    await page.evaluate(() => new Promise(requestAnimationFrame));
    await textIs(page, 'redo after new edit', 'New');
  },
};
