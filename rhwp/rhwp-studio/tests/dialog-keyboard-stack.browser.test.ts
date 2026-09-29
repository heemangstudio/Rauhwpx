import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import puppeteer, { type Browser, type Page } from 'puppeteer-core';
import { createServer, type ViteDevServer } from 'vite';
import { browserExecutable, browserLaunchArgs } from './browser-support.ts';

// 실제 대화상자 클래스를 빈 문서 페이지에 띄워 키 처리·적용 경로를 확인한다(엔진은 가짜).
const studioRoot = fileURLToPath(new URL('../', import.meta.url));
let server: ViteDevServer | null = null;
let browser: Browser | null = null;
let baseUrl = '';

test.before(async () => {
  server = await createServer({
    root: studioRoot,
    configFile: false,
    cacheDir: resolve(studioRoot, 'node_modules/.vite-dialog-keyboard-test'),
    logLevel: 'silent',
    resolve: { alias: { '@': resolve(studioRoot, 'src') } },
    server: { host: '127.0.0.1', port: 0, hmr: false },
    plugins: [{
      name: 'dialog-harness',
      configureServer(vite) {
        vite.middlewares.use((request, response, next) => {
          if (request.url !== '/dialog-harness') return next();
          response.setHeader('Content-Type', 'text/html');
          response.end('<!doctype html><html><head><meta charset="UTF-8"></head><body><textarea id="editor"></textarea></body></html>');
        });
      },
    }],
  });
  await server.listen();
  const address = server.httpServer?.address();
  assert.ok(address && typeof address !== 'string');
  baseUrl = `http://127.0.0.1:${address.port}`;
  browser = await puppeteer.launch({ executablePath: browserExecutable(), headless: true, args: browserLaunchArgs() });
});

test.after(async () => {
  await browser?.close();
  await server?.close();
});

async function harness(): Promise<Page> {
  assert.ok(browser);
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  (page as Page & { pageErrors: string[] }).pageErrors = errors;
  await page.goto(`${baseUrl}/dialog-harness`);
  return page;
}

function pageErrors(page: Page): string[] {
  return (page as Page & { pageErrors: string[] }).pageErrors;
}

test('Enter and Escape reach only the top dialog when 스타일 편집 is open over 스타일', { timeout: 60_000 }, async () => {
  const page = await harness();
  try {
    await page.evaluate(async () => {
      const [{ StyleDialog }, { StyleEditDialog }] = await Promise.all([
        import('/src/ui/style-dialog.ts'),
        import('/src/ui/style-edit-dialog.ts'),
      ]);
      const log: string[] = [];
      const styles = [{ id: 0, name: '바탕글', englishName: 'Normal', type: 0, nextStyleId: 0 }];
      const wasm = {
        getStyleList: () => styles,
        getStyleDetail: () => ({
          charProps: { fontSize: 1000, fontFamilies: Array(7).fill('함초롬바탕'), ratios: Array(7).fill(100) },
          paraProps: { alignment: 'justify', marginLeft: 0, marginRight: 0, indent: 0, lineSpacing: 160 },
        }),
        updateStyle: () => log.push('updateStyle'),
        updateStyleShapes: () => log.push('updateStyleShapes'),
      };
      const eventBus = { on: () => () => undefined, emit: () => undefined };
      const inputHandler = {
        executeOperation: (desc: { operation: (w: unknown) => unknown }) => { desc.operation(wasm); },
        getPosition: () => ({ sectionIndex: 0, paragraphIndex: 0, charOffset: 0 }),
        getCurrentStyleId: () => 0,
      };
      const services = { getInputHandler: () => inputHandler };
      const manager = new StyleDialog(wasm as never, eventBus as never, services as never);
      manager.onApply = () => log.push('applyStyle');
      manager.show();
      const edit = new StyleEditDialog(wasm as never, eventBus as never, 'edit', styles[0], undefined, services as never);
      edit.onSave = () => log.push('save');
      edit.show();
      Object.assign(window, { dialogLog: log, openEdit: () => edit.show() });
    });

    assert.equal(await page.$$eval('.modal-overlay', (overlays) => overlays.length), 2);
    await page.keyboard.press('Enter');
    assert.deepEqual(await page.evaluate(() => (window as unknown as { dialogLog: string[] }).dialogLog), ['updateStyle', 'save'],
      'Enter saves the edit dialog and must not apply a style to the document');
    assert.equal(await page.$$eval('.modal-overlay', (overlays) => overlays.length), 1, 'the style manager stays open');

    await page.evaluate(() => (window as unknown as { openEdit: () => void }).openEdit());
    await page.keyboard.press('Escape');
    assert.equal(await page.$$eval('.modal-overlay', (overlays) => overlays.length), 1, 'Escape closes only the edit dialog');

    await page.evaluate(() => (window as unknown as { openEdit: () => void }).openEdit());
    const charButton = await page.evaluateHandle(() => [...document.querySelectorAll('button')]
      .find((button) => button.textContent?.startsWith('글자 모양'))!);
    await (charButton as unknown as { click: () => Promise<void> }).click();
    assert.equal(await page.$$eval('.cs-dialog', (dialogs) => dialogs.length), 1, 'the 글자 모양 dialog opened');
    await page.keyboard.press('Escape');
    assert.equal(await page.$$eval('.cs-dialog', (dialogs) => dialogs.length), 0, 'Escape closes the 글자 모양 dialog');
    assert.equal(await page.$$eval('.modal-overlay', (overlays) => overlays.length), 2,
      'the edit dialog and the style manager underneath stay open');
    assert.deepEqual(pageErrors(page), []);
  } finally {
    await page.close();
  }
});

test('a failing 확인 keeps the dialog open and reports the error', { timeout: 30_000 }, async () => {
  const page = await harness();
  try {
    await page.evaluate(async () => {
      const { ModalDialog } = await import('/src/ui/dialog.ts');
      class FailingDialog extends ModalDialog {
        constructor() { super('실패 확인', 300); }
        createBody() { return document.createElement('div'); }
        onConfirm(): void { throw new Error('엔진 거부'); }
      }
      new FailingDialog().show();
    });
    await page.click('.dialog-btn-primary');
    assert.equal(await page.$$eval('.modal-overlay', (overlays) => overlays.length), 1);
    const toast = await page.$eval('#rhwp-toast-container', (element) => element.textContent ?? '');
    assert.match(toast, /엔진 거부/);
    assert.deepEqual(pageErrors(page), []);
  } finally {
    await page.close();
  }
});

test('글자 모양 OK sends only what was edited and keeps per-language values', { timeout: 30_000 }, async () => {
  const page = await harness();
  try {
    const result = await page.evaluate(async () => {
      const { CharShapeDialog } = await import('/src/ui/char-shape-dialog.ts');
      const props = {
        fontSize: 1025,
        fontFamilies: ['가', '나', '다', '라', '마', '바', '사'],
        ratios: [100, 95, 100, 100, 100, 100, 100],
        spacings: [0, -3, 0, 0, 0, 0, 0],
        relativeSizes: [100, 100, 100, 100, 100, 100, 100],
        charOffsets: [0, 0, 0, 0, 0, 0, 0],
        textColor: '#000000',
        shadeColor: '#ffffff',
        shadowType: 1,
        shadowOffsetX: 0,
        shadowOffsetY: 0,
      };
      const run = (edit: (dialog: HTMLElement) => void) => {
        const dialog = new CharShapeDialog({} as never, {} as never);
        let applied: Record<string, unknown> | null = null;
        dialog.onApply = (mods) => { applied = mods as Record<string, unknown>; };
        dialog.show(structuredClone(props));
        const root = document.querySelector<HTMLElement>('.cs-dialog')!;
        edit(root);
        [...root.querySelectorAll('button')].find((button) => button.textContent === '설정(D)')!.click();
        return applied;
      };
      const selects = (root: HTMLElement) => [...root.querySelectorAll('select')];
      const setLanguage = (root: HTMLElement, value: string) => {
        const lang = selects(root)[0];
        lang.value = value;
        lang.dispatchEvent(new Event('change'));
      };
      const numberInputs = (root: HTMLElement) => [...root.querySelectorAll<HTMLInputElement>('input[type="number"]')];

      const boldOnly = run((root) => root.querySelector<HTMLButtonElement>('button[title="굵게"]')!.click());
      const englishRatio = run((root) => {
        setLanguage(root, '2');
        // 순서: 기준 크기, 상대 크기, 장평, 글자 위치, 자간
        numberInputs(root)[2].value = '80';
      });
      const representativeRatio = run((root) => { numberInputs(root)[2].value = '90'; });
      const englishFont = run((root) => {
        setLanguage(root, '2');
        const font = selects(root)[1];
        font.value = '가';
        font.dispatchEvent(new Event('change'));
      });
      return { boldOnly, englishRatio, representativeRatio, englishFont };
    });

    assert.deepEqual(result.boldOnly, { bold: true },
      'toggling bold must not flatten ratios/spacings, rewrite the 10.25pt size, or stamp shadow offsets');
    assert.deepEqual(result.englishRatio, { ratios: [100, 80, 100, 100, 100, 100, 100] });
    assert.deepEqual(result.representativeRatio, { ratios: [90, 90, 90, 90, 90, 90, 90] });
    assert.deepEqual(result.englishFont, { fontNames: ['가', '가', '다', '라', '마', '바', '사'] },
      'a 영문 font change keeps the 한글 and other language fonts');
    assert.deepEqual(pageErrors(page), []);
  } finally {
    await page.close();
  }
});

test('문단 모양 OK after changing only the alignment sends only the alignment', { timeout: 30_000 }, async () => {
  const page = await harness();
  try {
    const mods = await page.evaluate(async () => {
      const { ParaShapeDialog } = await import('/src/ui/para-shape-dialog.ts');
      const dialog = new ParaShapeDialog({} as never, {} as never);
      let applied: Record<string, unknown> | null = null;
      dialog.onApply = (next) => { applied = next as Record<string, unknown>; };
      // 엔진 보고값: 10pt 왼쪽 여백(2000) → 13.3px, 10pt 문단 위(1000) → 13.3px, 들여쓰기 5pt
      dialog.show({
        alignment: 'justify', marginLeft: 13.3, marginRight: 6.7, indent: 6.7,
        lineSpacing: 21.3, lineSpacingType: 'Fixed', spacingBefore: 13.3, spacingAfter: 2.7,
        borderSpacing: [100, 57, 283, 1], tabStops: [],
      });
      document.querySelector<HTMLButtonElement>('button[title="가운데 정렬"]')!.click();
      [...document.querySelectorAll('button')].find((button) => button.textContent === '설정(D)')!.click();
      return applied;
    });
    assert.deepEqual(mods, { alignment: 'center' });
    assert.deepEqual(pageErrors(page), []);
  } finally {
    await page.close();
  }
});

test('the find dialog leaves Enter/Escape outside it alone and re-checks a stale hit before replacing', { timeout: 30_000 }, async () => {
  const page = await harness();
  try {
    await page.evaluate(async () => {
      const { FindDialog } = await import('/src/ui/find-dialog.ts');
      const calls: string[] = [];
      const state = {
        hits: [{ sec: 0, para: 0, charOffset: 3, length: 3 }],
        selection: null as null | { start: object; end: object },
      };
      const wasm = {
        searchText: () => { calls.push('searchText'); return { found: true, sec: 0, para: 0, charOffset: 3, length: 3 }; },
        searchAllText: () => state.hits,
        replaceText: () => { calls.push('replaceText'); return { ok: true }; },
      };
      const inputHandler = {
        getCursorPosition: () => ({ sectionIndex: 0, paragraphIndex: 0, charOffset: 0 }),
        moveCursorTo: () => true,
        cursor: { setAnchor: () => undefined, moveTo: () => undefined },
        getSelection: () => state.selection,
        executeOperation: (desc: { operation: (w: unknown) => unknown }) => { desc.operation(wasm); },
      };
      const services = {
        wasm,
        eventBus: { on: () => () => undefined, emit: () => undefined },
        getInputHandler: () => inputHandler,
      };
      const dialog = new FindDialog(services as never, 'replace');
      dialog.show();
      const editor = document.getElementById('editor')!;
      editor.addEventListener('keydown', (event) => calls.push(`editor:${event.key}:${event.defaultPrevented}`));
      Object.assign(window, { findCalls: calls, findState: state, findDialog: dialog });
    });

    await page.focus('#editor');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Escape');
    const afterEditorKeys = await page.evaluate(() => ({
      calls: (window as unknown as { findCalls: string[] }).findCalls.slice(),
      open: (window as unknown as { findDialog: { isOpen(): boolean } }).findDialog.isOpen(),
      focused: document.activeElement?.id,
    }));
    assert.deepEqual(afterEditorKeys, {
      calls: ['editor:Enter:false', 'editor:Escape:false'],
      open: true,
      focused: 'editor',
    });

    await page.focus('.find-dialog-input');
    await page.keyboard.type('abc');
    await page.keyboard.press('Enter');
    const replaceButton = await page.evaluateHandle(() => [...document.querySelectorAll('.find-dialog button')]
      .find((button) => button.textContent === '바꾸기')!);

    // 검색 뒤 앞쪽에 글자가 들어가 결과가 밀렸다 → 쓰지 않고 다시 찾는다.
    await page.evaluate(() => {
      const state = (window as unknown as { findState: { hits: unknown[]; selection: unknown } }).findState;
      state.hits = [{ sec: 0, para: 0, charOffset: 5, length: 3 }];
      state.selection = { start: { sectionIndex: 0, paragraphIndex: 0, charOffset: 3 }, end: { sectionIndex: 0, paragraphIndex: 0, charOffset: 6 } };
    });
    await (replaceButton as unknown as { click: () => Promise<void> }).click();
    let calls = await page.evaluate(() => (window as unknown as { findCalls: string[] }).findCalls.slice(2));
    assert.deepEqual(calls, ['searchText', 'searchText'], 'a stale hit is searched again, not replaced');

    // 결과와 선택이 그대로면 바꾼다.
    await page.evaluate(() => {
      const state = (window as unknown as { findState: { hits: unknown[] } }).findState;
      state.hits = [{ sec: 0, para: 0, charOffset: 3, length: 3 }];
    });
    await (replaceButton as unknown as { click: () => Promise<void> }).click();
    calls = await page.evaluate(() => (window as unknown as { findCalls: string[] }).findCalls.slice(4));
    assert.deepEqual(calls, ['replaceText', 'searchText']);
    assert.deepEqual(pageErrors(page), []);
  } finally {
    await page.close();
  }
});

test('table dialogs refuse a nested table before touching the engine', { timeout: 30_000 }, async () => {
  const page = await harness();
  try {
    const result = await page.evaluate(async () => {
      const [{ TableCellPropsDialog }, { CellBorderBgDialog }] = await Promise.all([
        import('/src/ui/table-cell-props-dialog.ts'),
        import('/src/ui/cell-border-bg-dialog.ts'),
      ]);
      const touched: string[] = [];
      const wasm = new Proxy({}, { get: (_target, key) => { touched.push(String(key)); return () => ({}); } });
      const tableCtx = {
        sec: 0, ppi: 2, ci: 0,
        cellPath: [{ controlIndex: 0, cellIndex: 1, cellParaIndex: 0 }, { controlIndex: 0, cellIndex: 0, cellParaIndex: 0 }],
      };
      new TableCellPropsDialog(wasm as never, {} as never, tableCtx, 1, 'cell').show();
      new CellBorderBgDialog(wasm as never, {} as never, tableCtx, 1, 'each').show();
      return {
        touched,
        overlays: document.querySelectorAll('.modal-overlay').length,
        toast: document.getElementById('rhwp-toast-container')?.textContent ?? '',
      };
    });
    assert.deepEqual(result.touched, []);
    assert.equal(result.overlays, 0);
    assert.match(result.toast, /중첩된 표/);
  } finally {
    await page.close();
  }
});

test('책갈피 넣기 inside a table cell refuses instead of writing into a body paragraph', { timeout: 30_000 }, async () => {
  const page = await harness();
  try {
    const result = await page.evaluate(async () => {
      const { BookmarkDialog } = await import('/src/ui/bookmark-dialog.ts');
      const operations: string[] = [];
      let position: Record<string, unknown> = {
        sectionIndex: 0, paragraphIndex: 0, charOffset: 2, parentParaIndex: 3, controlIndex: 0, cellIndex: 1,
        cellPath: [{ controlIndex: 0, cellIndex: 1, cellParaIndex: 0 }],
      };
      let failWith: string | null = null;
      const inputHandler = {
        getCursorPosition: () => position,
        focus: () => undefined,
        executeOperation: () => {
          operations.push('addBookmark');
          if (failWith) throw new Error(failWith);
        },
      };
      const services = { wasm: { getBookmarks: () => [] }, getInputHandler: () => inputHandler };
      const dialog = new BookmarkDialog(services as never);
      const add = () => [...document.querySelectorAll('.bm-dialog button')].find((b) => b.textContent === '넣기(D)') as HTMLButtonElement;
      const status = () => document.querySelector('.bm-dialog .bm-status, .bm-dialog [class*="status"]')?.textContent ?? '';
      dialog.show();
      add().click();
      const inCell = { operations: operations.slice(), status: status(), open: dialog.isOpen() };
      position = { sectionIndex: 0, paragraphIndex: 0, charOffset: 2 };
      failWith = '엔진 오류';
      add().click();
      return { inCell, failed: { operations: operations.slice(), status: status(), open: dialog.isOpen() } };
    });
    assert.deepEqual(result.inCell.operations, [], 'nothing is written for a cell caret');
    assert.match(result.inCell.status, /본문/);
    assert.equal(result.inCell.open, true);
    assert.deepEqual(result.failed.operations, ['addBookmark']);
    assert.match(result.failed.status, /엔진 오류/, 'an engine error is shown in the dialog');
    assert.equal(result.failed.open, true);
    assert.deepEqual(pageErrors(page), []);
  } finally {
    await page.close();
  }
});

test('편집 용지 edits the caret section, validates sizes, and applies 문서 전체 in one step', { timeout: 30_000 }, async () => {
  const page = await harness();
  try {
    const result = await page.evaluate(async () => {
      const { PageSetupDialog } = await import('/src/ui/page-setup-dialog.ts');
      const defs = [
        { width: 59528, height: 84188, marginLeft: 8504, marginRight: 8504, marginTop: 5669, marginBottom: 4252, marginHeader: 4252, marginFooter: 4252, marginGutter: 0, landscape: false, binding: 0 },
        { width: 59531, height: 84190, marginLeft: 8513, marginRight: 8500, marginTop: 5671, marginBottom: 4250, marginHeader: 4251, marginFooter: 4253, marginGutter: 7, landscape: true, binding: 0 },
      ];
      const writes: Array<[number, unknown]> = [];
      const operations: string[] = [];
      const wasm = {
        getPageDef: (index: number) => structuredClone(defs[index]),
        getSectionCount: () => defs.length,
        setPageDef: (index: number, def: unknown) => { writes.push([index, def]); return { ok: true, pageCount: 1 }; },
      };
      const inputHandler = {
        executeOperation: (desc: { operationType: string; operation: (w: unknown) => unknown }) => {
          operations.push(desc.operationType);
          desc.operation(wasm);
        },
        getCursorPosition: () => ({ sectionIndex: 1, paragraphIndex: 0, charOffset: 0 }),
      };
      const dialog = new PageSetupDialog(wasm as never, {} as never, 1, { getInputHandler: () => inputHandler } as never);
      dialog.show();
      const inputs = [...document.querySelectorAll<HTMLInputElement>('.modal-overlay input[type="number"]')];
      const scope = [...document.querySelectorAll<HTMLSelectElement>('.modal-overlay select')].at(-1)!;
      const confirm = document.querySelector<HTMLButtonElement>('.modal-overlay .dialog-btn-primary')!;
      const shownWidth = inputs[0].value;
      const defaultScope = scope.value;

      inputs[0].disabled = false;
      inputs[0].value = '';
      confirm.click();
      const afterEmpty = {
        writes: writes.length,
        open: document.querySelectorAll('.modal-overlay').length,
        error: document.querySelector('.modal-overlay [role="alert"]')?.textContent ?? '',
      };

      inputs[0].value = shownWidth;
      scope.value = 'all';
      confirm.click();
      return { defaultScope, afterEmpty, operations, writes, open: document.querySelectorAll('.modal-overlay').length, section1: defs[1] };
    });
    assert.equal(result.defaultScope, 'current');
    assert.deepEqual(result.afterEmpty.writes, 0);
    assert.equal(result.afterEmpty.open, 1, 'an empty width keeps the dialog open');
    assert.match(result.afterEmpty.error, /폭/);
    assert.deepEqual(result.operations, ['pageSetup'], 'all sections change inside one undo step');
    assert.deepEqual(result.writes.map(([index]) => index), [0, 1]);
    assert.deepEqual(result.writes[0][1], result.section1, 'untouched fields keep section 1\'s exact values');
    assert.equal(result.open, 0);
    assert.deepEqual(pageErrors(page), []);
  } finally {
    await page.close();
  }
});

test('쪽 테두리/배경 OK without touching the background leaves an image background out of the payload', { timeout: 30_000 }, async () => {
  const page = await harness();
  try {
    const payload = await page.evaluate(async () => {
      const { PageBorderDialog } = await import('/src/ui/page-border-dialog.ts');
      const none = { type: 0, width: 0, color: '#000000' };
      const settings = {
        attr: 0, basis: 'paper', spacingLeft: 1417, spacingRight: 1417, spacingTop: 1417, spacingBottom: 1417,
        borderFillId: 4, headerInside: false, footerInside: false, fillArea: 'paper', hideBorder: false, hideFill: false,
        borderLeft: none, borderRight: none, borderTop: none, borderBottom: none,
        fillType: 'image', fillColor: '#ffffff', patternColor: '#000000', patternType: 0, fillAlpha: 0,
        imageFillMode: 'total', imageBrightness: 0, imageContrast: 0, imageEffect: 0, imageBinDataId: 1,
      };
      let sent: Record<string, unknown> | null = null;
      const wasm = {
        getPageBorderFill: () => structuredClone(settings),
        setPageBorderFill: (_section: number, next: Record<string, unknown>) => { sent = next; return { ok: true, pageCount: 1 }; },
      };
      const inputHandler = {
        executeOperation: (desc: { operation: (w: unknown) => unknown }) => { desc.operation(wasm); },
        getCursorPosition: () => ({ sectionIndex: 0, paragraphIndex: 0, charOffset: 0 }),
      };
      new PageBorderDialog(wasm as never, {} as never, 0, { getInputHandler: () => inputHandler } as never).show();
      document.querySelector<HTMLButtonElement>('.modal-overlay .dialog-btn-primary')!.click();
      return sent as Record<string, unknown> | null;
    });
    assert.ok(payload);
    for (const key of ['fillType', 'fillColor', 'fillAlpha', 'imageFillMode', 'imageBinDataId']) {
      assert.equal(key in payload, false, `${key} is not sent`);
    }
    assert.equal(payload.borderFillId, 4);
    assert.equal(payload.spacingLeft, 1417, 'untouched spacing keeps its exact HWPUNIT value');
    assert.deepEqual(pageErrors(page), []);
  } finally {
    await page.close();
  }
});
