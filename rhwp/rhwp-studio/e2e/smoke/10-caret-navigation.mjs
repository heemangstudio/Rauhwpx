import assert from 'node:assert/strict';
import { clickPage, newDocument, shortcut, waitFor } from './lib.mjs';

const LONG = 'The quick brown fox jumps over the lazy dog and keeps running through the long field until the line wraps twice across the page width here.';

async function press(page, combo) {
  const parts = combo.split('+');
  const key = parts.pop();
  for (const m of parts) await page.keyboard.down(m);
  await page.keyboard.press(key);
  for (const m of parts.reverse()) await page.keyboard.up(m);
}

async function typeLines(page, lines) {
  for (const [i, line] of lines.entries()) {
    if (i) await page.keyboard.press('Enter');
    await page.keyboard.type(line);
  }
}

/** 머리말·각주·글상자·셀·본문 중 캐럿이 있는 곳의 [문단, 오프셋]. */
const caret = (page) => page.evaluate(() => {
  const c = window.__inputHandler.cursor;
  if (c.headerFooterMode !== 'none') return [c.hfParaIdx, c.hfCharOffset];
  if (c.isInFootnote()) return [c.fnInnerParaIdx, c.fnCharOffset];
  const p = c.getPosition();
  return [p.cellParaIndex ?? p.paragraphIndex, p.charOffset];
});

/** 캐럿이 있는 영역(머리말·각주·셀·글상자·본문)의 문단 글자. */
const areaText = (page) => page.evaluate(() => {
  const c = window.__inputHandler.cursor, w = window.__wasm;
  if (c.headerFooterMode !== 'none') {
    const isHeader = c.headerFooterMode === 'header';
    const n = JSON.parse(w.getHeaderFooterParaInfo(c.hfSectionIdx, isHeader, c.hfApplyTo, 0)).paraCount;
    return Array.from({ length: n }, (_, i) => JSON.parse(w.getHeaderFooterParaInfo(c.hfSectionIdx, isHeader, c.hfApplyTo, i)).text);
  }
  if (c.isInFootnote()) return w.getFootnoteInfo(c.fnSectionIdx, c.fnParaIdx, c.fnControlIdx).texts;
  return Array.from({ length: w.getParagraphCount(0) }, (_, p) => w.getTextRange(0, p, 0, 1000));
});

/** 키 열을 누르고 키마다 캐럿을 기대값과 맞춘다. 오프셋이 null 이면 문단만 본다(위아래 이동의 x 맞춤). */
async function walk(page, label, steps) {
  for (const [key, expected] of steps) {
    await press(page, key);
    const at = await caret(page);
    assert.deepEqual(expected[1] === null ? [at[0], null] : at, expected, `${label}: ${key} → ${JSON.stringify(at)}`);
  }
}

/** 세 문단(둘째 줄까지 넘치는 긴 문단 포함)을 쓰고 단어·줄·문단·위아래·처음끝 이동을 확인한다. */
async function checkArea(page, label) {
  await typeLines(page, ['alpha beta gamma', 'delta epsilon', LONG]);
  await walk(page, label, [
    ['Meta+ArrowUp', [0, 0]],
    ['Alt+ArrowRight', [0, 6]],
    ['End', [0, 16]],
    ['Alt+ArrowLeft', [0, 11]],
    ['Home', [0, 0]],
    // 각주 첫 문단은 번호 뒤에서 시작하므로 다음 문단의 같은 x 는 처음이 아닐 수 있다.
    ['ArrowDown', [1, null]],
    ['Meta+ArrowRight', [1, 13]],
    ['ArrowDown', [2, null]],
    ['ArrowUp', [1, null]],
    ['ArrowUp', [0, null]],
    ['Meta+ArrowDown', [2, LONG.length]],
  ]);
  // Shift 는 같은 영역 안 선택을 넓히고, 선택한 글자를 지우면 그 글자만 사라진다.
  await press(page, 'Shift+Alt+ArrowLeft');
  await page.keyboard.press('Backspace');
  // 끝의 마침표가 한 낱말이다.
  assert.deepEqual(await caret(page), [2, LONG.length - 1], `${label}: shift-extended word delete`);
  assert.equal((await areaText(page))[2], LONG.slice(0, -1), `${label}: the selected word is deleted`);
  // Shift+Enter 는 이 영역에서도 문단을 나누지 않고 줄만 바꾼다.
  await press(page, 'Shift+Enter');
  await page.keyboard.type('z');
  assert.deepEqual((await areaText(page)).slice(2), [`${LONG.slice(0, -1)}\nz`], `${label}: Shift+Enter`);
}

export default {
  name: 'caret navigation and line breaks',
  async run({ page }) {
    // 아래 키는 macOS 기준이다. Linux CI 에서도 같은 키로 움직이게 플랫폼을 고정한다.
    await page.evaluate(() => { globalThis.__rhwpTestPlatformKind = 'mac'; });
    // Shift+Enter 는 문단을 나누지 않고 강제 줄바꿈을 넣으며, 지웠다 되돌려도 줄바꿈으로 돌아온다.
    await newDocument(page);
    await clickPage(page);
    await page.keyboard.type('ab');
    await press(page, 'Shift+Enter');
    await page.keyboard.type('cd');
    const body = () => page.evaluate(() => {
      const w = window.__wasm;
      return Array.from({ length: w.getParagraphCount(0) }, (_, p) => w.getTextRange(0, p, 0, 100));
    });
    assert.deepEqual(await body(), ['ab\ncd']);
    await press(page, 'ArrowLeft'); await press(page, 'ArrowLeft');
    await page.keyboard.press('Backspace');
    assert.deepEqual(await body(), ['abcd']);
    await shortcut(page, 'KeyZ');
    await waitFor(page, 'undo restores the line break', () => window.__wasm.getTextRange(0, 0, 0, 100) === 'ab\ncd');
    assert.equal(await page.evaluate(() => window.__wasm.getParagraphCount(0)), 1);

    // 오른쪽 빈자리를 누르면 그 줄 끝에 캐럿이 선다. 아래 긴 줄로 가지 않는다.
    await newDocument(page);
    await clickPage(page);
    await typeLines(page, ['short', LONG]);
    const target = await page.evaluate(() => {
      const w = window.__wasm, canvas = document.querySelector('#scroll-content canvas').getBoundingClientRect();
      const short = w.getCursorRect(0, 0, 0), long = w.getCursorRect(0, 1, 60);
      const zoom = canvas.width / w.getPageInfo(0).width;
      return { x: canvas.left + long.x * zoom, y: canvas.top + (short.y + short.height / 2) * zoom };
    });
    await page.mouse.click(target.x, target.y);
    assert.deepEqual(await caret(page), [0, 5], 'click right of a short line');

    // 표 위 문단에서 ↓ 는 표의 첫 셀로 들어간다.
    await newDocument(page);
    await clickPage(page);
    await page.keyboard.type('above');
    await page.evaluate(() => {
      const ih = window.__inputHandler, p = ih.cursor.getPosition();
      ih.executeOperation({ kind: 'snapshot', operationType: 'createTable', operation: (wasm) => {
        const r = wasm.createTable(p.sectionIndex, p.paragraphIndex, p.charOffset, 2, 2);
        return { ...p, parentParaIndex: r.paraIdx, controlIndex: r.controlIdx, cellIndex: 0, cellParaIndex: 0,
          cellPath: [{ controlIndex: r.controlIdx, cellIndex: 0, cellParaIndex: 0 }] };
      } });
    });
    await press(page, 'Meta+ArrowUp');
    await press(page, 'ArrowDown');
    assert.equal(await page.evaluate(() => window.__inputHandler.cursor.getPosition().cellIndex), 0, 'down into the table');
    // Shift+↓ 로 표를 지나 선택하면 표 전체가 선택에 들고, 그 위에 친 글자가 표를 바꾼다.
    await press(page, 'Meta+ArrowUp');
    await press(page, 'End');
    await press(page, 'Shift+ArrowDown');
    await press(page, 'Shift+ArrowDown');
    await page.keyboard.type('X');
    assert.equal((await body())[0], 'aboveX', 'typing over a selection across the table');
    assert.equal(await page.evaluate(() => window.__wasm.getPageControlLayout(0).controls.filter((c) => c.type === 'table').length), 0,
      'the selected table is replaced');

    // 머리말·각주·글상자 안에서도 본문과 같은 키로 움직인다.
    await newDocument(page);
    await clickPage(page);
    await page.evaluate(() => window.__dispatcher.dispatch('page:header-create'));
    await waitFor(page, 'header editing', () => window.__inputHandler.cursor.headerFooterMode === 'header');
    await checkArea(page, 'header');
    // 머리말 선택을 한글 조합으로 바꾼 뒤 되돌리고 다시 실행하면 조합한 글자까지 돌아온다.
    await press(page, 'Meta+ArrowUp');
    await press(page, 'Shift+Alt+ArrowRight');
    const cdp = await page.createCDPSession();
    for (const text of ['ㅂ', '바']) await cdp.send('Input.imeSetComposition', { text, selectionStart: 1, selectionEnd: 1 });
    await cdp.send('Input.insertText', { text: '바' });
    await cdp.detach();
    const replaced = (await areaText(page))[0];
    assert.equal(replaced, '바beta gamma', 'header selection replaced by composition');
    await shortcut(page, 'KeyZ');
    await waitFor(page, 'undo restores the header selection', () => window.__inputHandler.cursor.headerFooterMode === 'header');
    assert.equal((await areaText(page))[0], 'alpha beta gamma');
    await shortcut(page, 'KeyZ', { shift: true });
    assert.equal((await areaText(page))[0], replaced, 'redo keeps the composed syllable');

    await newDocument(page);
    await clickPage(page);
    await page.evaluate(() => window.__dispatcher.dispatch('insert:footnote'));
    await waitFor(page, 'footnote editing', () => window.__inputHandler.cursor.isInFootnote());
    await checkArea(page, 'footnote');

    await newDocument(page);
    await clickPage(page);
    await page.evaluate(() => {
      const ih = window.__inputHandler, w = window.__wasm;
      const r = w.createShapeControl({ sectionIdx: 0, paraIdx: 0, charOffset: 0, width: 30000, height: 12000, horzOffset: 2000,
        vertOffset: 2000, shapeType: 'textbox', lineFlipX: false, lineFlipY: false, treatAsChar: false, textWrap: 'InFrontOfText' });
      window.__eventBus.emit('document-changed');
      ih.enterInlineEditing(0, r.paraIdx, r.controlIdx);
    });
    await typeLines(page, ['alpha beta gamma', 'delta epsilon']);
    await walk(page, 'text box', [
      ['Alt+ArrowLeft', [1, 6]],
      ['Alt+ArrowLeft', [1, 0]],
      ['Alt+ArrowLeft', [0, 16]],
      ['Alt+ArrowLeft', [0, 11]],
    ]);
  },
};
