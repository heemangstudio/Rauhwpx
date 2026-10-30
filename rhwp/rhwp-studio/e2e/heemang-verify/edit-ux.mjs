/**
 * 편집 UX 비교 — 기준선(옛 엔진 Studio)과 후보(HeemangEngine)에서 같은 키 입력·클릭·IME·클립보드·되돌리기
 * 흐름을 실행하고 문서 내용·캐럿·선택·오류를 나란히 기록한다. 서로 다른 관찰만 출력한다.
 *
 *   node e2e/heemang-verify/edit-ux.mjs [시나리오 이름 일부 ...]
 *
 * HV_ONLY=candidate 이면 후보만 실행한다. 결과: out/edit-ux/result.json
 */
import fs from 'node:fs';
import path from 'node:path';
import * as L from './lib.mjs';
import { newDocument, clickPage, openDocument } from '../smoke/lib.mjs';

const out = L.ensureOut('edit-ux');
const only = process.env.HV_ONLY;
const wanted = process.argv.slice(2);
const LONG = 'The quick brown fox jumps over the lazy dog and keeps running through the long field until the line wraps twice across the page width here.';

async function press(page, combo, times = 1) {
  const parts = combo.split('+');
  const key = parts.pop();
  for (let i = 0; i < times; i++) {
    for (const m of parts) await page.keyboard.down(m);
    await page.keyboard.press(key);
    for (const m of parts.slice().reverse()) await page.keyboard.up(m);
  }
  await new Promise((r) => setTimeout(r, 30));
}

async function typeLines(page, lines) {
  for (let i = 0; i < lines.length; i++) {
    if (i) await page.keyboard.press('Enter');
    await page.keyboard.type(lines[i]);
  }
}

/** 실제 Chrome IME 경로: 음절마다 조합을 갱신하고 확정한다. */
async function compose(page, syllables) {
  const cdp = await page.createCDPSession();
  for (const steps of syllables) {
    for (const s of steps) await cdp.send('Input.imeSetComposition', { text: s, selectionStart: s.length, selectionEnd: s.length });
    await cdp.send('Input.insertText', { text: steps.at(-1) });
  }
  await cdp.detach();
  await new Promise((r) => setTimeout(r, 50));
}

const clip = (page, type, data) => page.evaluate((kind, payload) => {
  const dt = new DataTransfer();
  if (payload) for (const [k, v] of Object.entries(payload)) dt.setData(k, v);
  window.__inputHandler.textarea.dispatchEvent(new ClipboardEvent(kind, { clipboardData: dt, bubbles: true, cancelable: true }));
  return { 'text/plain': dt.getData('text/plain'), 'text/html': dt.getData('text/html') };
}, type, data);

/** 본문 문단마다 [글자, 컨트롤 수]. */
const body = (page) => page.evaluate(() => {
  const w = window.__wasm;
  return Array.from({ length: w.getParagraphCount(0) }, (_, p) => [w.getTextRange(0, p, 0, 100000), w.getControlTextPositions(0, p).length]);
});

/** 캐럿이 있는 영역(머리말·각주·셀·글상자·본문)의 문단 글자. */
const area = (page) => page.evaluate(() => {
  const c = window.__inputHandler.cursor, w = window.__wasm;
  try {
    if (c.headerFooterMode !== 'none') {
      const isHeader = c.headerFooterMode === 'header';
      const n = JSON.parse(w.getHeaderFooterParaInfo(c.hfSectionIdx, isHeader, c.hfApplyTo, 0)).paraCount;
      return Array.from({ length: n }, (_, i) => JSON.parse(w.getHeaderFooterParaInfo(c.hfSectionIdx, isHeader, c.hfApplyTo, i)).text);
    }
    if (c.isInFootnote()) return w.getFootnoteInfo(c.fnSectionIdx, c.fnParaIdx, c.fnControlIdx).texts;
    const p = c.getPosition();
    if (p.parentParaIndex !== undefined) {
      const n = w.getCellParagraphCount(p.sectionIndex, p.parentParaIndex, p.controlIndex, p.cellIndex);
      return Array.from({ length: n }, (_, i) => w.getTextInCell(p.sectionIndex, p.parentParaIndex, p.controlIndex, p.cellIndex, i, 0, 100000));
    }
    return Array.from({ length: w.getParagraphCount(0) }, (_, i) => w.getTextRange(0, i, 0, 100000));
  } catch (error) {
    return `ERR ${error.message}`;
  }
});

/** 캐럿과 선택을 영역에 맞는 짧은 꼴로. */
const caret = (page) => page.evaluate(() => {
  const c = window.__inputHandler.cursor;
  if (c.headerFooterMode !== 'none') {
    const s = c.hasHeaderFooterSelection() ? c.getHeaderFooterSelectionOrdered() : null;
    return ['hf', c.hfParaIdx, c.hfCharOffset, ...(s ? ['sel', s.start.paraIdx, s.start.charOffset, s.end.paraIdx, s.end.charOffset] : [])];
  }
  if (c.isInFootnote()) {
    const s = c.getFootnoteSelectionOrdered();
    return ['fn', c.fnInnerParaIdx, c.fnCharOffset, ...(s ? ['sel', s.start.fnParaIdx, s.start.charOffset, s.end.fnParaIdx, s.end.charOffset] : [])];
  }
  const at = (p) => [p.parentParaIndex === undefined ? 'b' : `${p.isTextBox ? 'tb' : 'c'}${p.parentParaIndex}.${p.controlIndex}.${p.cellIndex}`,
    p.cellParaIndex ?? p.paragraphIndex, p.charOffset];
  const s = c.hasSelection() ? c.getSelectionOrdered() : null;
  return [...at(c.getPosition()), ...(s ? ['sel', ...at(s.start), ...at(s.end)] : [])];
});

async function walk(page, keys) {
  const steps = [];
  for (const key of keys) {
    await press(page, key);
    steps.push(`${key} ${JSON.stringify(await caret(page))}`);
  }
  return steps;
}

async function fresh(page, lines = []) {
  await newDocument(page);
  await clickPage(page);
  await typeLines(page, lines);
}

/** 본문·셀·글상자·머리말·각주 중 하나에 캐럿을 두고 lines 를 친다. */
async function inArea(page, kind, lines = []) {
  await fresh(page, ['body before']);
  if (kind === 'cell') await page.evaluate(() => {
    const ih = window.__inputHandler, p = ih.cursor.getPosition();
    ih.executeOperation({ kind: 'snapshot', operationType: 'createTable', operation: (wasm) => {
      const r = wasm.createTable(p.sectionIndex, p.paragraphIndex, p.charOffset, 2, 2);
      return { sectionIndex: p.sectionIndex, paragraphIndex: 0, charOffset: 0, parentParaIndex: r.paraIdx, controlIndex: r.controlIdx, cellIndex: 0, cellParaIndex: 0,
        cellPath: [{ controlIndex: r.controlIdx, cellIndex: 0, cellParaIndex: 0 }] };
    } });
  });
  if (kind === 'textbox') await page.evaluate(() => {
    const ih = window.__inputHandler, w = window.__wasm, p = ih.cursor.getPosition();
    const r = w.createShapeControl({ sectionIdx: 0, paraIdx: p.paragraphIndex, charOffset: p.charOffset, width: 30000, height: 12000,
      horzOffset: 2000, vertOffset: 2000, shapeType: 'textbox', lineFlipX: false, lineFlipY: false, treatAsChar: false, textWrap: 'InFrontOfText' });
    window.__eventBus.emit('document-changed');
    ih.enterInlineEditing(0, r.paraIdx, r.controlIdx);
  });
  if (kind === 'header') await page.evaluate(() => window.__dispatcher.dispatch('page:header-create'));
  if (kind === 'footnote') await page.evaluate(() => window.__dispatcher.dispatch('insert:footnote'));
  await page.evaluate(() => window.__inputHandler.focus?.());
  await typeLines(page, lines);
}

async function tableDocument(page) {
  await fresh(page, ['before table']);
  await page.evaluate(() => {
    const ih = window.__inputHandler, p = ih.cursor.getPosition();
    ih.executeOperation({ kind: 'snapshot', operationType: 'createTable', operation: (wasm) => {
      const r = wasm.createTable(p.sectionIndex, p.paragraphIndex, p.charOffset, 2, 2);
      return { sectionIndex: p.sectionIndex, paragraphIndex: 0, charOffset: 0, parentParaIndex: r.paraIdx, controlIndex: r.controlIdx, cellIndex: 0, cellParaIndex: 0,
        cellPath: [{ controlIndex: r.controlIdx, cellIndex: 0, cellParaIndex: 0 }] };
    } });
  });
  await page.keyboard.type('cell');
  await press(page, 'Meta+ArrowDown');
  await page.keyboard.type('after');
}

const AREA_KEYS = ['ArrowUp', 'ArrowUp', 'ArrowUp', 'End', 'Alt+ArrowLeft', 'Alt+ArrowLeft', 'Alt+ArrowRight', 'Home', 'Meta+ArrowRight', 'Meta+ArrowLeft',
  'ArrowDown', 'ArrowDown', 'Shift+ArrowDown', 'Shift+End', 'Shift+Alt+ArrowLeft', 'ArrowLeft', 'Shift+Home', 'ArrowRight', 'Shift+ArrowUp', 'ArrowDown',
  'Shift+Meta+ArrowRight', 'ArrowUp', 'ArrowUp', 'Meta+ArrowDown', 'Meta+ArrowUp'];
const AREA_KEYS_OTHER = ['Control+ArrowUp', 'Control+ArrowUp', 'Control+ArrowRight', 'Control+ArrowRight', 'Control+ArrowLeft', 'Control+ArrowDown',
  'Shift+Control+ArrowRight', 'Shift+Control+ArrowDown', 'Control+Home', 'Control+End', 'Shift+Control+Home'];
const HAN = [['ㅎ', '하', '한'], ['ㄱ', '그', '글']];

const scenarios = {};
for (const kind of ['body', 'cell', 'textbox', 'header', 'footnote']) {
  scenarios[`nav-${kind}`] = async (page) => {
    await inArea(page, kind, ['alpha beta gamma', 'delta epsilon', LONG]);
    return { steps: await walk(page, AREA_KEYS), text: await area(page) };
  };
  // Windows/Linux 배치: Ctrl+화살표 단어·문단 이동.
  scenarios[`nav-${kind}-other`] = async (page) => {
    await page.evaluate(() => { globalThis.__rhwpTestPlatformKind = 'other'; });
    try {
      await inArea(page, kind, ['alpha beta gamma', 'delta epsilon', LONG]);
      return { steps: await walk(page, AREA_KEYS_OTHER) };
    } finally {
      await page.evaluate(() => { delete globalThis.__rhwpTestPlatformKind; });
    }
  };
  scenarios[`ime-${kind}`] = async (page) => {
    await inArea(page, kind, ['abc def']);
    const r = [];
    const snap = async (k) => r.push([k, await area(page), await caret(page)]);
    await compose(page, HAN); await snap('end');
    await press(page, 'Home'); await compose(page, HAN); await snap('start');
    await press(page, 'ArrowRight', 4); await compose(page, [['ㅁ', '마']]); await snap('middle');
    await press(page, 'Shift+ArrowRight', 3); await compose(page, [['ㅂ', '바']]); await snap('replace-selection');
    await press(page, 'Meta+KeyZ'); await snap('undo');
    await press(page, 'Meta+Shift+KeyZ'); await snap('redo');
    return r;
  };
  scenarios[`line-break-${kind}`] = async (page) => {
    await inArea(page, kind, ['xy']);
    await press(page, 'Shift+Enter');
    await page.keyboard.type('z');
    const typed = await area(page);
    await press(page, 'ArrowLeft', 2);
    await press(page, 'Backspace');
    const removed = await area(page);
    await press(page, 'Meta+KeyZ');
    return { typed, removed, undone: await area(page) };
  };
  scenarios[`undo-typing-${kind}`] = async (page) => {
    await inArea(page, kind, []);
    await page.keyboard.type('abc');
    await new Promise((r) => setTimeout(r, 1000));
    await page.keyboard.type(' def');
    await compose(page, HAN);
    const typed = await area(page);
    await press(page, 'Meta+KeyZ');
    return { typed, afterOneUndo: await area(page) };
  };
}

Object.assign(scenarios, {
  async 'keys-body'(page) {
    await fresh(page, ['hello world', 'second']);
    const r = [];
    const st = async (k) => r.push([k, await body(page), await caret(page)]);
    await press(page, 'ArrowUp'); await press(page, 'End');
    await press(page, 'Delete'); await st('Delete at paragraph end');
    await press(page, 'Backspace'); await st('Backspace');
    await press(page, 'Home'); await press(page, 'Control+Enter'); await st('Ctrl+Enter');
    await press(page, 'Backspace'); await st('Backspace after page break');
    await press(page, 'Tab'); await st('Tab');
    await press(page, 'Alt+ArrowRight'); await press(page, 'Alt+Backspace'); await st('Alt+Backspace');
    return r;
  },
  async 'click-right-of-short-line'(page) {
    await fresh(page, ['short', LONG]);
    const target = await page.evaluate(() => {
      const w = window.__wasm, canvas = document.querySelector('#scroll-content canvas').getBoundingClientRect();
      const short = w.getCursorRect(0, 0, 0), long = w.getCursorRect(0, 1, 60);
      const zoom = canvas.width / w.getPageInfo(0).width;
      return { x: canvas.left + long.x * zoom, y: canvas.top + (short.y + short.height / 2) * zoom };
    });
    await page.mouse.click(target.x, target.y);
    return caret(page);
  },
  async 'up-over-empty-paragraph'(page) {
    await fresh(page, ['long text here', '', 'long text here']);
    return walk(page, ['ArrowUp', 'ArrowUp', 'Meta+ArrowUp', 'End', 'ArrowDown', 'ArrowDown']);
  },
  async 'table-arrows-and-selection'(page) {
    await tableDocument(page);
    await press(page, 'Meta+ArrowUp');
    const steps = await walk(page, ['End', 'ArrowDown', 'ArrowDown', 'ArrowDown', 'ArrowUp', 'ArrowUp', 'ArrowUp', 'End',
      'Shift+ArrowDown', 'Shift+ArrowDown', 'Shift+ArrowDown']);
    await page.keyboard.type('X');
    return { steps, typedOver: await body(page) };
  },
  async 'table-clipboard'(page) {
    await tableDocument(page);
    await press(page, 'Meta+KeyA');
    const cut = await clip(page, 'cut');
    const afterCut = await body(page);
    await clip(page, 'paste', cut);
    return { plain: cut['text/plain'], afterCut, afterPaste: await body(page) };
  },
  async 'body-clipboard'(page) {
    await fresh(page, ['first line']);
    await press(page, 'Shift+Enter'); await page.keyboard.type('after break');
    await press(page, 'Enter'); await page.keyboard.type('tab'); await press(page, 'Alt+Tab'); await page.keyboard.type('here');
    await press(page, 'Meta+KeyA');
    const copied = await clip(page, 'copy');
    await press(page, 'Meta+ArrowDown');
    await press(page, 'Enter');
    await clip(page, 'paste', copied);
    return { plain: copied['text/plain'], after: await body(page) };
  },
  async 'cross-section-selection'(page) {
    await openDocument(page, 'basic/interview.hwp');
    await clickPage(page);
    await press(page, 'Meta+ArrowUp');
    await press(page, 'Shift+Meta+ArrowDown');
    const plain = (await clip(page, 'copy'))['text/plain'];
    await press(page, 'Meta+KeyB');
    await page.keyboard.type('X');
    const typed = await body(page);
    await press(page, 'Meta+KeyZ');
    await press(page, 'Meta+KeyZ');
    return { plainLength: plain.length, typed: typed.slice(0, 2), restoredParagraphs: (await body(page)).length };
  },
  async 'object-clipboard'(page) {
    const r = [];
    for (const file of ['draw-group.hwp', 'textbox-under-image.hwp', 'atop-equation-01.hwp']) {
      await openDocument(page, file);
      await clickPage(page);
      const count = () => page.evaluate(() => {
        const w = window.__wasm; let n = 0;
        for (let s = 0; s < w.getSectionCount(); s++) for (let p = 0; p < w.getParagraphCount(s); p++) n += w.getControlTextPositions(s, p).length;
        return n;
      });
      const objects = await page.evaluate(() => window.__wasm.getPageControlLayout(0).controls
        .filter((c) => c.type !== 'table' && c.cellIdx === undefined).slice(0, 2)
        .map((c) => ({ type: c.type, sec: c.secIdx ?? 0, para: c.paraIdx, control: c.controlIdx })));
      for (const o of objects) {
        const before = await count();
        await page.evaluate((o) => window.__inputHandler.cursor.enterPictureObjectSelectionDirect(o.sec, o.para, o.control, o.type), o);
        const data = await clip(page, 'copy');
        await page.evaluate(() => window.__inputHandler.cursor.exitPictureObjectSelection());
        await press(page, 'Meta+ArrowDown');
        await clip(page, 'paste', data);
        await new Promise((res) => setTimeout(res, 200));
        const pasted = (await count()) - before;
        await press(page, 'Meta+KeyZ');
        r.push([file, o.type, 'pasted', pasted, 'undone', (await count()) - before]);
      }
    }
    return r;
  },
});

async function runApp(name, root) {
  const app = await L.startApp(name, root, name === 'baseline' ? 8400 : 8500);
  const browser = await L.launchBrowser();
  const session = await L.newPage(browser);
  await L.loadApp(session.page, app.url);
  return { app, browser, session };
}

const results = {};
const runs = {};
try {
  const names = only ? [only] : ['baseline', 'candidate'];
  for (const name of names) runs[name] = await runApp(name, name === 'baseline' ? L.baselineRoot : L.candidateRoot);
  for (const [id, fn] of Object.entries(scenarios)) {
    if (wanted.length && !wanted.some((w) => id.includes(w))) continue;
    results[id] = {};
    for (const name of names) {
      const { page, log } = runs[name].session;
      const errorsBefore = log.pageErrors.length;
      try {
        results[id][name] = { result: await fn(page) };
      } catch (error) {
        results[id][name] = { failed: String(error?.message || error).slice(0, 400) };
      }
      const errors = log.pageErrors.slice(errorsBefore).map((e) => e.split('\n')[0].replace(/127\.0\.0\.1:\d+/g, 'host'));
      if (errors.length) results[id][name].pageErrors = errors;
    }
  }
} finally {
  for (const r of Object.values(runs)) {
    await r.session.context.close().catch(() => {});
    await r.browser.close().catch(() => {});
    await r.app.stop().catch(() => {});
  }
}
fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(results, null, 2));

/** 두 앱의 관찰이 다른 곳만 출력한다. */
function diff(a, b, at = '') {
  if (JSON.stringify(a) === JSON.stringify(b)) return [];
  if (Array.isArray(a) && Array.isArray(b) && a.length === b.length) return a.flatMap((x, i) => diff(x, b[i], `${at}[${i}]`));
  if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
    return [...new Set([...Object.keys(a), ...Object.keys(b)])].flatMap((k) => diff(a[k], b[k], `${at}.${k}`));
  }
  return [`${at}: baseline=${JSON.stringify(a)} candidate=${JSON.stringify(b)}`];
}
for (const [id, r] of Object.entries(results)) {
  if (only) { console.log(id, JSON.stringify(r[only]).slice(0, 4000)); continue; }
  const d = diff(r.baseline, r.candidate);
  console.log(`${d.length ? 'DIFF' : 'SAME'} ${id}`);
  for (const line of d.slice(0, 40)) console.log('   ', line.slice(0, 400));
}
