import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createServer } from 'vite';
import puppeteer from 'puppeteer-core';
import { browserLaunchArgs, findBrowserExecutable } from './browser-support.ts';

// Fixture-backed reader integration: real DOM events and reader, fake native/service boundaries.
const studio = resolve(import.meta.dirname, '..');
const executablePath = findBrowserExecutable();
assert(executablePath, 'Set CHROME_PATH to a Chrome/Chromium executable.');
const cacheDir = await mkdtemp(resolve(tmpdir(), 'rauhwpx-heemang-reader-'));
const server = await createServer({
  cacheDir,
  configFile: resolve(studio, 'vite.sidebar.config.ts'),
  server: { port: 0, open: false, hmr: false },
  logLevel: 'error',
});
let browser;

async function fixture(origin) {
  const page = await browser.newPage();
  page.setDefaultTimeout(5000);
  await page.setRequestInterception(true);
  page.on('request', request => {
    if (request.isNavigationRequest() && request.url() === `${origin}/`) {
      void request.respond({ contentType: 'text/html', body: '<!doctype html><html><body></body></html>' });
    } else void request.continue();
  });
  await page.goto(origin);
  await page.evaluate(async () => {
    const { installHeemangReader } = await import('/src/view/heemang-reader.ts');
    const { EngineNotSupportedError } = await import('/src/core/engine-support.ts');
    document.body.style.margin = '0';
    const container = document.createElement('div');
    container.style.cssText = 'position:relative;width:400px;height:200px;overflow:auto';
    const canvas = document.createElement('canvas');
    canvas.dataset.heemangPage = '0';
    canvas.style.cssText = 'position:absolute;top:0;left:0;width:400px;height:200px';
    container.append(canvas);
    document.body.append(container);
    const log = { edits: [], copies: [], selections: [], errors: [], changed: 0, epoch: 0, text: 'original' };
    const listeners = new Map();
    const bus = {
      on(name, callback) {
        const callbacks = listeners.get(name) ?? [];
        callbacks.push(callback);
        listeners.set(name, callbacks);
        return () => callbacks.splice(callbacks.indexOf(callback), 1);
      },
      emit(name, payload) {
        if (name === 'document-changed') log.changed++;
        for (const callback of listeners.get(name) ?? []) callback(payload);
      },
    };
    const located = position => ({ position, affinity: 'downstream', caret: {
      page: 0, x: position.offset * 750, y: 750, height: 1000,
    } });
    const edit = (kind, range, extra) => {
      log.edits.push(structuredClone({ kind, range, ...extra }));
      log.epoch++;
      log.text = kind;
      return { caret: located(range.to), receipt: { contentEpoch: log.epoch } };
    };
    const viewer = {
      state: () => ({ contentEpoch: log.epoch }),
      locate(request) {
        if (request.kind === 'caret') return located(request.position).caret;
        const x = request.x / 75;
        return located({ section: 0, steps: [{ para: 0, control: 0, index: x < 200 ? 0 : 1 }],
          para: 0, offset: Math.floor(x / 10) % 20 });
      },
      navigate: request => located({ ...request.position,
        offset: request.position.offset + (request.motion === 'left' ? -1 : 1) }),
      select(range) {
        log.selections.push(structuredClone(range));
        if (range.from.steps[0].index !== range.to.steps[0].index) {
          throw new EngineNotSupportedError('서로 다른 문단 목록 사이의 선택');
        }
        return [{ page: 0, x: 750, y: 750, width: 1500, height: 1000 }];
      },
      // Native search compares match starts strictly; an exhausted direction wraps.
      search(query, caseSensitive, from, backward = false) {
        const text = 'qZqZ';
        const haystack = caseSensitive ? text : text.toLowerCase();
        const needle = caseSensitive ? query : query.toLowerCase();
        const matches = [];
        if (needle) for (let offset = 0; offset <= text.length - needle.length; offset++) {
          if (haystack.slice(offset, offset + needle.length) !== needle) continue;
          const address = offset => ({ section: 0, steps: [{ para: 0, control: 0, index: 0 }], para: 0, offset });
          matches.push({ from: address(offset), to: address(offset + needle.length) });
        }
        const candidates = from ? matches.filter(match => backward
          ? match.from.offset < from.offset : match.from.offset > from.offset) : matches;
        return { matches: candidates.length ? candidates : matches, contentEpoch: log.epoch };
      },
      copyText(range) {
        log.copies.push(structuredClone(range));
        return { text: 'copied', html: '<b>copied</b>' };
      },
      cutText: range => ({ edit: edit('cut', range) }),
      replaceText: (range, text) => edit('replace', range, { text }),
      pasteText: (range, text, internal) => edit('paste', range, { text, internal }),
      formatCharacters: (range, patch) => edit('format', range, { patch }),
    };
    const engine = { engineKind: 'heemang', documentInstance: 1, readOnly: false,
      hasLoadedDocument: () => true, getPageInfo: () => ({ width: 400, height: 200 }), viewer };
    const view = { getViewportManager: () => ({ getZoom: () => 1 }),
      getVirtualScroll: () => ({ getPageOffset: () => 0 }) };
    const f = { log, bus, engine, canEdit: true, writeStarted: false, resolveWrite: null };
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      write: () => new Promise(resolve => { f.writeStarted = true; f.resolveWrite = resolve; }),
    } });
    installHeemangReader(container, engine, bus, view,
      error => log.errors.push({ name: error.name, message: error.message }), () => f.canEdit);
    window.__readerFixture = f;
  });
  return page;
}

async function selectText(page) {
  await page.mouse.move(30, 30);
  await page.mouse.down();
  await page.mouse.move(60, 30);
  await page.mouse.up();
}

try {
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await puppeteer.launch({ executablePath, headless: true, args: browserLaunchArgs() });
  for (const movement of ['pointer', 'arrow', 'unchanged']) {
    const page = await fixture(origin);
    try {
      await selectText(page);
      await page.evaluate(() => window.__readerFixture.bus.emit('heemang-command', { id: 'edit:cut' }));
      await page.waitForFunction(() => window.__readerFixture.writeStarted);
      if (movement === 'pointer') await page.mouse.click(100, 30);
      else if (movement === 'arrow') await page.keyboard.press('ArrowRight');
      await page.evaluate(() => window.__readerFixture.resolveWrite());
      await page.waitForFunction(() => {
        const log = window.__readerFixture.log;
        return log.errors.length > 0 || log.edits.length > 0;
      });
      const log = await page.evaluate(() => window.__readerFixture.log);
      assert.equal(log.copies.length, 1, 'Cut reached the asynchronous system clipboard write');
      if (movement === 'unchanged') {
        assert.equal(log.edits.length, 1, 'Cut still works when the selection remains current');
        assert.equal(log.edits[0].kind, 'cut');
        assert.deepEqual(log.edits[0].range, log.copies[0]);
        assert.equal(log.changed, 1);
        assert.equal(log.epoch, 1);
        assert.deepEqual(log.errors, []);
        continue;
      }
      assert.deepEqual(log.edits, [], `Cut must not mutate after ${movement} moves the selection`);
      assert.equal(log.changed, 0);
      assert.equal(log.epoch, 0);
      assert.equal(log.text, 'original');
      assert.equal(log.errors.length, 1);
    } finally { await page.close(); }
  }
  console.log('PASS Fixture-backed menu Cut rejects changed pointer and keyboard selections after clipboard write');

  {
    const page = await fixture(origin);
    try {
      await selectText(page);
      await page.evaluate(() => window.__readerFixture.bus.emit('heemang-command', { id: 'edit:cut' }));
      await page.waitForFunction(() => window.__readerFixture.writeStarted);
      await page.evaluate(() => {
        const f = window.__readerFixture;
        f.resolveCutWrite = f.resolveWrite;
      });
      await page.mouse.click(100, 30);
      await page.evaluate(() => window.__readerFixture.bus.emit('heemang-command', { id: 'edit:copy' }));
      await page.evaluate(() => window.__readerFixture.resolveWrite());
      await selectText(page);
      const before = await page.evaluate(() => window.__readerFixture.log);
      assert.equal(before.copies.length, 2, 'A subsequent menu Copy replaced the native clipboard fragment');
      assert.notDeepEqual(before.copies[0], before.copies[1]);
      const restored = before.selections.at(-1);
      assert.deepEqual(restored.from, before.copies[0].from);
      assert.deepEqual(restored.to, before.copies[0].to);
      assert.equal(before.epoch, 0, 'The document and original selection are current again');
      await page.evaluate(() => window.__readerFixture.resolveCutWrite());
      await page.waitForFunction(() => window.__readerFixture.log.errors.length > 0
        || window.__readerFixture.log.edits.length > 0);
      const log = await page.evaluate(() => window.__readerFixture.log);
      assert.deepEqual(log.edits, [], 'A replaced clipboard token invalidates Cut even after restoring the selection');
      assert.equal(log.changed, 0);
      assert.equal(log.epoch, 0);
      assert.equal(log.text, 'original');
      assert.equal(log.errors.length, 1);
    } finally { await page.close(); }
  }
  console.log('PASS Fixture-backed pending Cut rejects a newer Copy after restoring its original selection');

  {
    const page = await fixture(origin);
    try {
      await page.mouse.click(5, 30); // Collapsed native caret at the first match start.
      await page.evaluate(() => window.__readerFixture.bus.emit('heemang-command', { id: 'edit:find' }));
      await page.type('.find-dialog-input', 'qZ');
      const selectedOffsets = () => page.evaluate(() => {
        const range = window.__readerFixture.log.selections.at(-1);
        return [range.from.offset, range.to.offset];
      });
      await page.locator('::-p-text(다음 찾기)').click();
      assert.deepEqual(await selectedOffsets(), [0, 2], 'Next includes a match starting exactly at a collapsed caret');
      await page.locator('::-p-text(다음 찾기)').click();
      assert.deepEqual(await selectedOffsets(), [2, 4], 'Next finds the adjacent match rather than skipping it');
      await page.locator('::-p-text(이전 찾기)').click();
      assert.deepEqual(await selectedOffsets(), [0, 2], 'Previous returns to the adjacent earlier match');
      await page.locator('::-p-text(이전 찾기)').click();
      assert.deepEqual(await selectedOffsets(), [2, 4], 'Previous wraps from the first match to the last');
      const log = await page.evaluate(() => window.__readerFixture.log);
      assert.deepEqual(log.edits, [], 'Finding only changes the live selection');
      assert.equal(log.changed, 0);
      assert.deepEqual(log.errors, []);
    } finally { await page.close(); }
  }
  console.log('PASS Fixture-backed find dialog includes the caret match, advances adjacent matches, and wraps backward');

  {
    const page = await fixture(origin);
    try {
      await page.mouse.move(30, 30);
      await page.mouse.down();
      await page.mouse.move(60, 30);
      await page.mouse.move(250, 30);
      await page.mouse.up();
      await page.keyboard.type('Z');
      const log = await page.evaluate(() => window.__readerFixture.log);
      assert.equal(log.errors.length, 1, 'The native boundary rejects the cross-cell drag');
      assert.equal(log.errors[0].name, 'EngineNotSupportedError');
      assert(log.selections.some(range => range.from.steps[0].index !== range.to.steps[0].index));
      assert.equal(log.edits.length, 1);
      assert.equal(log.edits[0].kind, 'replace');
      assert.equal(log.edits[0].text, 'Z');
      assert.deepEqual(log.edits[0].range.from, { section: 0, steps: [{ para: 0, control: 0, index: 0 }], para: 0, offset: 3 });
      assert.deepEqual(log.edits[0].range.to, { section: 0, steps: [{ para: 0, control: 0, index: 0 }], para: 0, offset: 6 });
      assert.equal(log.changed, 1, 'Typing uses the last valid same-cell selection');
    } finally { await page.close(); }
  }
  console.log('PASS Fixture-backed cross-cell drag preserves the last valid edit range');

  {
    const page = await fixture(origin);
    try {
      await selectText(page);
      for (const kind of ['image', 'html']) {
        const result = await page.evaluate(kind => {
          const data = new DataTransfer();
          if (kind === 'image') data.items.add(new File(['image'], 'image.png', { type: 'image/png' }));
          else { data.setData('text/plain', 'external'); data.setData('text/html', '<b>external</b>'); }
          const event = new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true });
          document.querySelector('[data-heemang-input]').dispatchEvent(event);
          return { prevented: event.defaultPrevented, log: window.__readerFixture.log };
        }, kind);
        assert(result.prevented, 'Unsupported clipboard data must not reach browser default insertion');
        assert.deepEqual(result.log.edits, [], `${kind} paste must be rejected before pasteText`);
        assert.equal(result.log.changed, 0);
        assert.equal(result.log.text, 'original');
      }
      assert.deepEqual(await page.evaluate(() => window.__readerFixture.log.errors.map(error => error.name)),
        ['EngineNotSupportedError', 'EngineNotSupportedError']);
      await page.evaluate(() => {
        const data = new DataTransfer();
        data.setData('text/plain', 'plain');
        document.querySelector('[data-heemang-input]').dispatchEvent(new ClipboardEvent('paste', {
          clipboardData: data, bubbles: true, cancelable: true,
        }));
      });
      const log = await page.evaluate(() => window.__readerFixture.log);
      assert.equal(log.edits.length, 1, 'A later supported paste still works');
      assert.equal(log.edits[0].text, 'plain');
      assert.equal(log.edits[0].internal, false);
      assert.equal(log.changed, 1);
    } finally { await page.close(); }
  }
  console.log('PASS Fixture-backed image and external HTML paste reject before mutation; plain text remains usable');

  {
    const page = await fixture(origin);
    try {
      await selectText(page);
      for (const guard of ['readOnly', 'canEdit']) {
        await page.evaluate(guard => {
          const f = window.__readerFixture;
          f.engine.readOnly = guard === 'readOnly';
          f.canEdit = guard !== 'canEdit';
          f.bus.emit('format-char', { fontSize: 1200 });
        }, guard);
        const log = await page.evaluate(() => window.__readerFixture.log);
        assert.deepEqual(log.edits, [], `${guard} must block formatting`);
        assert.equal(log.changed, 0);
      }
      await page.evaluate(() => {
        const f = window.__readerFixture;
        f.engine.readOnly = false;
        f.canEdit = true;
        f.bus.emit('format-char', { fontSize: 1200 });
      });
      let log = await page.evaluate(() => window.__readerFixture.log);
      assert.equal(log.edits.length, 1);
      assert.deepEqual(log.edits[0].patch, { size: 1200 });
      assert.equal(log.changed, 1, 'One supported format command emits one document change');
      await page.keyboard.type('A');
      log = await page.evaluate(() => window.__readerFixture.log);
      assert.equal(log.edits.length, 2);
      assert.equal(log.edits[1].kind, 'replace');
      assert.equal(log.edits[1].text, 'A');
      assert.equal(log.changed, 2, 'One supported text input emits one additional document change');
      assert.deepEqual(log.errors, []);
    } finally { await page.close(); }
  }
  console.log('PASS Fixture-backed format guards and supported input emit exactly one change per edit');
} finally {
  await browser?.close();
  await server.close();
  await rm(cacheDir, { recursive: true, force: true });
}
