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
    const log = { edits: [], copies: [], selections: [], errors: [], changed: 0, changedReceipts: [], epoch: 0, text: 'original' };
    const listeners = new Map();
    const bus = {
      on(name, callback) {
        const callbacks = listeners.get(name) ?? [];
        callbacks.push(callback);
        listeners.set(name, callbacks);
        return () => callbacks.splice(callbacks.indexOf(callback), 1);
      },
      emit(name, payload) {
        if (name === 'document-changed') { log.changed++; log.changedReceipts.push(structuredClone(payload)); }
        for (const callback of listeners.get(name) ?? []) callback(payload);
      },
    };
    const located = position => ({ position, affinity: log.affinity ?? 'downstream', caret: {
      page: 0, x: position.offset * 750, y: 750, height: 1000,
    } });
    const edit = (kind, range, extra) => {
      log.edits.push(structuredClone({ kind, range, ...extra }));
      log.epoch++;
      log.text = kind;
      const cellRange = range.kind === 'cells';
      const focus = cellRange ? { section: range.table.section,
        steps: [...(range.table.steps ?? []), { para: range.table.para, control: range.table.control, index: 1 }],
        para: 0, offset: 0 } : range.to;
      return { caret: { ...located(focus), affinity: range.toAffinity ?? 'downstream' },
        ...(kind === 'format' ? { selection: range, anchor: cellRange ? null
          : { ...located(range.from), affinity: range.fromAffinity ?? 'downstream' } } : {}),
        receipt: { contentEpoch: log.epoch, changedPages: [0] } };
    };
    const viewer = {
      hasInternalClipboard: () => log.richFragment ?? true,
      state: () => ({ contentEpoch: log.epoch }),
      locate(request) {
        if (request.kind === 'caret') return located(request.position).caret;
        const x = request.x / 75;
        if (request.y / 75 > 100 || x >= 350) return located({ section: x >= 350 ? 1 : 0, para: 1, offset: Math.floor(x / 10) });
        return { ...located({ section: 0, steps: [{ para: 0, control: 0, index: x < 200 ? 0 : 1 }],
          para: 0, offset: Math.floor(x / 10) % 20 }),
          object: { section: 0, para: 0, control: 0, kind: log.objectKind ?? 'table', layer: 'text',
            page: 0, x: 0, y: 0, width: 30000, height: 7500 } };

      },
      navigate: request => located({ ...request.position,
        offset: request.position.offset + (request.motion === 'left' ? -1 : 1) }),
      selectRange(request) {
        log.selections.push(structuredClone(request));
        let range;
        if (request.kind === 'cells') range = { ...request, cells: [] };
        else {
          if (request.from.section !== request.to.section) throw new EngineNotSupportedError('서로 다른 구역 사이의 선택');
          const a = request.from.steps?.[0], b = request.to.steps?.[0];
          if (a && b && a.index !== b.index) range = { kind: 'cells',
            table: { section: 0, para: 0, control: 0 }, from: { row: 0, column: 0 }, to: { row: 0, column: 1 }, cells: [] };
          else if (!!a !== !!b) range = { kind: 'text', from: { section: 0, para: 0, offset: 16 },
            to: a ? request.to : request.from };
          else {
            const reverse = request.from.para > request.to.para || request.from.offset > request.to.offset;
            range = { kind: 'text', from: reverse ? request.to : request.from, to: reverse ? request.from : request.to };
          }
        }
        return { range, rects: [{ page: 0, x: 750, y: 750, width: 1500, height: 1000 }] };
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
        return log.copyContent ?? { text: 'copied', html: '<b>copied</b>' };
      },
      cutText: range => ({ edit: edit('cut', range) }),
      replaceText: (range, text) => edit('replace', range, { text }),
      pasteText: (range, text, internal) => edit('paste', range, { text, internal }),
      formatCharacters: (range, patch) => edit('format', range, { patch }),
      formatParagraphs: (range, patch) => edit('format', range, { patch }),
      deleteForward: range => edit('delete', range),
      deleteBackward: range => edit('delete', range),
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
      await page.mouse.move(370, 30);
      await page.mouse.up();
      await page.keyboard.type('Z');
      const log = await page.evaluate(() => window.__readerFixture.log);
      assert.equal(log.errors.length, 1, 'The native boundary rejects the cross-section drag');
      assert.equal(log.errors[0].name, 'EngineNotSupportedError');
      assert(log.selections.some(range => range.from.section !== range.to.section));
      assert.equal(log.edits.length, 1);
      assert.equal(log.edits[0].kind, 'replace');
      assert.equal(log.edits[0].text, 'Z');
      assert.deepEqual(log.edits[0].range.from, { section: 0, steps: [{ para: 0, control: 0, index: 0 }], para: 0, offset: 3 });
      assert.deepEqual(log.edits[0].range.to, { section: 0, steps: [{ para: 0, control: 0, index: 0 }], para: 0, offset: 6 });
      assert.equal(log.changed, 1, 'Typing uses the last valid same-cell selection');
    } finally { await page.close(); }
  }
  console.log('PASS Fixture-backed cross-section drag preserves the last valid edit range');

  {
    const page = await fixture(origin);
    try {
      await page.evaluate(() => { window.__readerFixture.log.objectKind = 'picture'; });
      await page.mouse.click(30, 30);
      await page.keyboard.type('Z');
      const log = await page.evaluate(() => window.__readerFixture.log);
      assert.deepEqual(log.edits, [], 'Floating image hits remain unsupported');
      assert.equal(log.errors[0].name, 'EngineNotSupportedError');
    } finally { await page.close(); }
  }
  console.log('PASS Fixture-backed object guard still rejects image editing');

  for (const reverse of [false, true]) {
    const page = await fixture(origin);
    try {
      await page.mouse.move(reverse ? 250 : 30, 30);
      await page.mouse.down();
      await page.mouse.move(reverse ? 30 : 250, 30);
      await page.mouse.up();
      const copied = await page.evaluate(() => {
        const data = new DataTransfer();
        document.querySelector('[data-heemang-input]').dispatchEvent(new ClipboardEvent('copy', { clipboardData: data, bubbles: true }));
        window.__readerFixture.bus.emit('format-char', { fontSize: 1200 });
        return { text: data.getData('text/plain'), log: window.__readerFixture.log };
      });
      const cells = { kind: 'cells', table: { section: 0, para: 0, control: 0 },
        from: { row: 0, column: 0 }, to: { row: 0, column: 1 } };
      assert.equal(copied.text, 'copied');
      assert.deepEqual(copied.log.copies[0], cells, 'Copy consumes the engine-normalized tagged cell block');
      assert.deepEqual(copied.log.edits[0].range, cells, 'Formatting consumes the same cell block');
      await page.keyboard.press('Delete');
      const log = await page.evaluate(() => window.__readerFixture.log);
      assert.deepEqual(log.edits[1].range, cells, 'Formatting preserves the block for the next Delete');
      assert.equal(log.edits[1].kind, 'delete');
      assert.equal(log.changed, 2);
      assert.deepEqual(log.errors, []);
    } finally { await page.close(); }
  }
  console.log('PASS Fixture-backed forward/reverse cell drag routes tagged blocks through copy, format and delete');

  for (const cancellation of ['pointercancel', 'blur', 'released']) {
    const page = await fixture(origin);
    try {
      await page.mouse.move(30, 30);
      await page.mouse.down();
      await page.mouse.move(250, 30);
      await page.evaluate(cancellation => {
        const container = document.querySelector('canvas').parentElement;
        if (cancellation !== 'released') window.dispatchEvent(new Event(cancellation));
        container.dispatchEvent(new PointerEvent('pointermove', {
          clientX: 60, clientY: 30, buttons: cancellation === 'released' ? 0 : 1, bubbles: true,
        }));
        container.dispatchEvent(new PointerEvent('pointermove', {
          clientX: 70, clientY: 30, buttons: 1, bubbles: true,
        }));
        const data = new DataTransfer();
        document.querySelector('[data-heemang-input]').dispatchEvent(new ClipboardEvent('copy', {
          clipboardData: data, bubbles: true,
        }));
      }, cancellation);
      const log = await page.evaluate(() => window.__readerFixture.log);
      assert.equal(log.copies[0].kind, 'cells', `${cancellation} keeps the last valid cell block`);
      assert.deepEqual(log.errors, []);
    } finally { await page.mouse.up(); await page.close(); }
  }
  console.log('PASS Fixture-backed cancelled or released drags preserve their cell block');

  for (const reverse of [false, true]) {
    const page = await fixture(origin);
    try {
      await page.evaluate(() => { window.__readerFixture.log.affinity = 'upstream'; });
      await page.mouse.move(30, reverse ? 150 : 30);
      await page.mouse.down();
      await page.evaluate(() => { window.__readerFixture.log.affinity = 'downstream'; });
      await page.mouse.move(60, reverse ? 30 : 150);
      await page.mouse.up();
      await page.evaluate(() => window.__readerFixture.bus.emit('format-char', { fontSize: 1200 }));
      await page.keyboard.press('Delete');
      const log = await page.evaluate(() => window.__readerFixture.log);
      const range = log.edits[0].range;
      assert.equal(!!range.from.steps?.length, !reverse, 'The original anchor list is preserved');
      assert.equal(!!range.to.steps?.length, reverse, 'The original focus list is preserved');
      assert.equal(range.fromAffinity, 'upstream');
      assert.equal(range.toAffinity, 'downstream');
      assert.deepEqual(log.edits[1].range, range, 'Native format receipts retain direction and affinity');
      assert.equal(log.changed, 2);
      assert.deepEqual(log.errors, []);
    } finally { await page.close(); }
  }
  console.log('PASS Fixture-backed body/table selection preserves directed endpoints and affinities for engine normalization');

  {
    const page = await fixture(origin);
    try {
      await page.mouse.move(30, 30);
      await page.mouse.down();
      await page.mouse.move(250, 30);
      await page.mouse.up();
      await page.evaluate(() => window.__readerFixture.bus.emit('heemang-command', { id: 'edit:cut' }));
      await page.waitForFunction(() => window.__readerFixture.writeStarted);
      await page.mouse.click(30, 30);
      await page.evaluate(() => window.__readerFixture.resolveWrite());
      await page.waitForFunction(() => window.__readerFixture.log.errors.length > 0);
      const log = await page.evaluate(() => window.__readerFixture.log);
      assert.equal(log.copies[0].kind, 'cells');
      assert.deepEqual(log.edits, [], 'Changing a cell block into a caret cancels the pending Cut');
      assert.equal(log.changed, 0);
    } finally { await page.close(); }
  }
  console.log('PASS Fixture-backed pending cell-block Cut rejects a changed selection kind');

  for (const richFragment of [false, true]) {
    for (const marker of ['token', 'html']) {
      const page = await fixture(origin);
      try {
        const copiedText = richFragment ? 'copied' : 'first\tsecond\nthird\tfourth\n';
        await page.mouse.move(30, 30);
        await page.mouse.down();
        await page.mouse.move(richFragment ? 60 : 250, 30);
        await page.mouse.up();
        await page.evaluate(({ richFragment, copiedText }) => {
          const f = window.__readerFixture;
          f.log.richFragment = richFragment;
          f.log.copyContent = { text: copiedText, html: '<table><tr><td>first</td><td>second</td></tr></table>' };
          const data = new DataTransfer();
          document.querySelector('[data-heemang-input]').dispatchEvent(new ClipboardEvent('copy', {
            clipboardData: data, bubbles: true, cancelable: true,
          }));
          f.copiedData = Object.fromEntries(data.types.map(type => [type, data.getData(type)]));
        }, { richFragment, copiedText });
        await page.mouse.click(60, 150);
        const paste = async (text, stale = false) => page.evaluate(({ marker, text, stale }) => {
          const data = new DataTransfer();
          const copied = window.__readerFixture.copiedData;
          data.setData('text/plain', text);
          data.setData('text/html', marker === 'html'
            ? (stale ? copied['text/html'].replace('heemang:', 'heemang:stale-') : copied['text/html'])
            : '<b>copied</b>');
          if (marker === 'token') data.setData('application/x-heemang-fragment',
            stale ? 'stale' : copied['application/x-heemang-fragment']);
          document.querySelector('[data-heemang-input]').dispatchEvent(new ClipboardEvent('paste', {
            clipboardData: data, bubbles: true, cancelable: true,
          }));
        }, { marker, text, stale });
        await paste(copiedText, true);
        await paste('changed text');
        let log = await page.evaluate(() => window.__readerFixture.log);
        assert.deepEqual(log.edits, [], 'Stale tokens and mismatched text cannot authorize HTML');
        assert.equal(log.errors.length, 2);
        await paste(copiedText);
        log = await page.evaluate(() => window.__readerFixture.log);
        assert.equal(log.edits.length, 1);
        assert.equal(log.edits[0].internal, richFragment,
          'Own-copy trust is independent of native fragment availability');
        assert.equal(log.edits[0].text, copiedText);
        assert.deepEqual(log.edits[0].range.from, log.edits[0].range.to, 'Paste targets an ordinary caret');
        assert.equal(log.changed, 1, 'One paste emits one logical edit');
      } finally { await page.close(); }
    }
  }
  console.log('PASS Fixture-backed own token/HTML copy uses rich fragments only when available and rejects stale/mismatched copies');

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
      assert.deepEqual(log.changedReceipts, [
        { contentEpoch: 1, changedPages: [0] }, { contentEpoch: 2, changedPages: [0] },
      ], 'Each change carries the native repaint receipt');
      assert.deepEqual(log.errors, []);
    } finally { await page.close(); }
  }
  console.log('PASS Fixture-backed format guards and supported input emit exactly one change per edit');
} finally {
  await browser?.close();
  await server.close();
  await rm(cacheDir, { recursive: true, force: true });
}
