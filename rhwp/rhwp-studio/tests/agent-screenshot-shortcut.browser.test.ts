import assert from 'node:assert/strict';
import test from 'node:test';
import puppeteer from 'puppeteer-core';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { browserExecutable, browserLaunchArgs } from './browser-support.ts';

const HARNESS = `<html><head><meta charset="utf-8"></head><body class="ag-sidebar-open" style="margin:0">
<div id="scroll-container" style="position:absolute;left:0;top:0;width:800px;height:600px;overflow:auto">
  <div id="scroll-content" style="position:relative;width:800px;height:1200px"></div>
</div>
<textarea aria-label="문서 편집 입력" style="position:absolute;left:4px;top:4px;width:20px;height:20px"></textarea>
</body></html>`;

/** 실제 인라인 프롬프트와 영역 캡처를 쓰고 엔진·허브만 대체한다. 키는 CDP로 브라우저 입력처럼 보낸다. */
test('Ctrl 두 번 뒤 S는 한글 IME와 키 반복에서도 화면 캡처를 열고 문서 입력에 글자를 남기지 않는다', { timeout: 30_000 }, async () => {
  const server = await createServer({ root: fileURLToPath(new URL('../', import.meta.url)), configFile: false, logLevel: 'silent', server: { host: '127.0.0.1', port: 0 },
    plugins: [{ name: 'screenshot-shortcut-harness', configureServer(vite) {
      vite.middlewares.use((request, response, next) => {
        if (request.url !== '/screenshot-shortcut-harness') return next();
        response.setHeader('Content-Type', 'text/html; charset=utf-8');
        response.end(HARNESS);
      });
    } }],
  });
  let browser: Awaited<ReturnType<typeof puppeteer.launch>> | undefined;
  try {
    await server.listen(); const location = server.httpServer!.address(); assert.ok(location && typeof location !== 'string');
    browser = await puppeteer.launch({ executablePath: browserExecutable(), headless: true, args: browserLaunchArgs() });
    const page = await browser.newPage(); await page.setViewport({ width: 1000, height: 700 });
    await page.goto(`http://127.0.0.1:${location.port}/screenshot-shortcut-harness`);
    await page.evaluate(async () => {
      const editor = document.querySelector('textarea')!;
      const typed: string[] = [];
      for (const type of ['compositionstart', 'input']) editor.addEventListener(type, () => typed.push(`${type}:${editor.value}`));
      const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
      const eventBus = {
        on(name: string, fn: (...args: unknown[]) => void) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name)!.add(fn); return () => listeners.get(name)!.delete(fn); },
        emit(name: string, ...args: unknown[]) { for (const fn of listeners.get(name) ?? []) fn(...args); },
      };
      const wasm = { pageCount: 1, hasLoadedDocument: () => true, getPageInfo: () => ({ width: 600, height: 800 }), getPageLineLayout: () => ({ lines: [] }) };
      const canvasView = { getVirtualScroll: () => ({ getPageLeftResolved: () => 100, getPageOffset: () => 0, getPageWidth: () => 600, getPageHeight: () => 800 }) };
      const inputHandler = {
        isInPictureObjectSelection: () => false, isInTableObjectSelection: () => false, isInCellSelectionMode: () => false,
        getSelection: () => null, isUserEditingLocked: () => false, focus: () => editor.focus(),
      };
      const { createDocumentRegionCapture } = await import('/src/agent/document-region-capture.ts');
      const { initInlinePrompt } = await import('/src/agent/inline-prompt.ts');
      const capture = createDocumentRegionCapture({
        wasm: wasm as any, canvasView: canvasView as any, eventBus: eventBus as any,
        getIdentity: () => ({ documentId: 'doc', revision: 1 }), getDocumentName: () => 'fixture.hwp', onCapture() {},
      });
      initInlinePrompt({
        wasm: wasm as any, eventBus: eventBus as any, inputHandler: inputHandler as any, canvasView: canvasView as any,
        bridge: { onEvent: () => () => {} } as any, submit: (() => ({ ok: true })) as any, startScreenshot: () => capture.startCapture(),
      });
      Object.assign(window, { shortcutTest: { editor, typed, capture } });
      editor.focus();
    });
    const cdp = await page.createCDPSession();
    const key = (type: 'rawKeyDown' | 'keyDown' | 'keyUp', init: Record<string, unknown>) => cdp.send('Input.dispatchKeyEvent', { type, ...init });
    const control = { key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17 };
    const sKeyUp = { key: 's', code: 'KeyS', windowsVirtualKeyCode: 83 };
    const arm = async () => {
      await page.evaluate(() => (window as any).shortcutTest.editor.focus());
      for (let i = 0; i < 2; i++) { await key('rawKeyDown', control); await key('keyUp', control); }
      await page.waitForSelector('.ag-inline-armed-frame:not(.ag-leaving)');
    };
    const state = () => page.evaluate(() => {
      const fixture = (window as any).shortcutTest;
      const layer = document.querySelector<HTMLElement>('.ag-region-capture')!;
      return { open: !layer.hidden, layerFocused: document.activeElement === layer, editorFocused: document.activeElement === fixture.editor, value: fixture.editor.value, typed: [...fixture.typed] };
    });
    const close = async () => {
      await key('rawKeyDown', { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); await key('keyUp', { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      return state();
    };

    // Windows 한글 IME: S는 keyCode 229 'Process'로 오고 바로 ㄴ 조합이 뒤따른다.
    await arm();
    await key('rawKeyDown', { key: 'Process', code: 'KeyS', windowsVirtualKeyCode: 229, nativeVirtualKeyCode: 229 });
    await cdp.send('Input.imeSetComposition', { text: 'ㄴ', selectionStart: 1, selectionEnd: 1 });
    await key('keyUp', sKeyUp);
    let current = await state();
    assert.equal(current.open, true, 'S under the Korean IME opens the region capture');
    assert.equal(current.layerFocused, true, 'the capture layer takes focus from the document input');
    assert.deepEqual([current.value, current.typed], ['', []], 'the IME composition does not reach the document input');
    current = await close();
    assert.equal(current.open, false);
    assert.equal(current.editorFocused, true, 'Escape returns focus to the document input');

    // 준비한 뒤 한/영 키로 입력 모드를 바꿔도 준비 상태가 남아 S로 캡처한다.
    await arm();
    await key('rawKeyDown', { key: 'HangulMode', code: 'Lang1', windowsVirtualKeyCode: 21 }); await key('keyUp', { key: 'HangulMode', code: 'Lang1', windowsVirtualKeyCode: 21 });
    await key('keyDown', { ...sKeyUp, text: 's' }); await key('keyUp', sKeyUp);
    current = await state();
    assert.equal(current.open, true, 'switching the input mode keeps the armed state');
    await close();

    // 영문 S를 길게 눌러 반복 키가 와도 캡처가 유지되고 문서에 s가 쌓이지 않는다.
    await arm();
    await key('keyDown', { ...sKeyUp, text: 's' });
    for (let i = 0; i < 3; i++) await key('keyDown', { ...sKeyUp, text: 's', autoRepeat: true });
    await key('keyUp', sKeyUp);
    current = await state();
    assert.equal(current.open, true, 'auto-repeated S keeps the capture open');
    assert.deepEqual([current.value, current.typed], ['', []], 'auto-repeated S does not type into the document input');
    await close();
  } finally { await browser?.close(); await server.close(); }
});
