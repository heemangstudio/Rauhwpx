import { clickPage, newDocument, shortcut, waitFor } from './lib.mjs';

const textIs = (page, label, expected) => waitFor(page, `${label} → ${JSON.stringify(expected)}`,
  (value) => window.__wasm.getTextRange(0, 0, 0, 100) === value, expected);

export default {
  name: 'type, undo, redo',
  async run({ page }) {
    await newDocument(page);
    await clickPage(page);
    // 300ms 타이핑 병합 창에 기대지 않고 한 번의 undo/redo 동작을 확인한다.
    await page.keyboard.type('H');
    await textIs(page, 'typing', 'H');
    await waitFor(page, 'undo history', () => window.__inputHandler.canUndo());
    await shortcut(page, 'KeyZ');
    await textIs(page, 'undo', '');
    await waitFor(page, 'redo history', () => window.__inputHandler.canRedo());
    await shortcut(page, 'KeyZ', { shift: true });
    await textIs(page, 'redo', 'H');
    // 되돌린 뒤 새로 입력하면 다시 실행할 기록이 사라진다.
    await waitFor(page, 'second undo history', () => window.__inputHandler.canUndo());
    await shortcut(page, 'KeyZ');
    await textIs(page, 'second undo', '');
    await page.keyboard.type('N');
    await textIs(page, 'new typing', 'N');
    await waitFor(page, 'new edit history', () =>
      window.__inputHandler.canUndo() && !window.__inputHandler.canRedo());
    await shortcut(page, 'KeyZ', { shift: true });
    await page.evaluate(() => new Promise(requestAnimationFrame));
    await textIs(page, 'redo after new edit', 'N');
  },
};
