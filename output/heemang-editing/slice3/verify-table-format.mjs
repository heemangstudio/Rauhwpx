import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import puppeteer from '../../../rhwp/rhwp-studio/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js';
import { ensureChromePath } from '../../../rhwp/rhwp-studio/e2e/agent-bench-harness.mjs';

const out = path.join(import.meta.dirname, 'table-format');
const url = 'http://127.0.0.1:7700/?engine=heemang';
await fs.mkdir(out, { recursive: true });
const copy = path.join(out, 'fdi_q1.hwpx');
await fs.rm(copy, { force: true });
await fs.copyFile('/Users/pyu/projects/hobbies/Rau/heemang-cleanroom/parity/docs/fdi_q1.hwpx', copy);
ensureChromePath();
const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH, headless: true });
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 1200, deviceScaleFactor: 1 });
const result = { url, sourceCopy: copy, errors: [], boundary: 'Production file input, mouse and format dialog; native read-only inspection.' };
result.engineCommit = (await fs.readFile(path.resolve(import.meta.dirname, '../../../rhwp/rhwp-studio/vendor/hm-wasm/README.md'), 'utf8')).match(/commit\s*\n`([a-f0-9]{40})`/)[1];
page.on('pageerror', e => result.errors.push(e.stack));
const settle = () => page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
async function click(at, shift = false) {
  const caret = await page.evaluate(at => window.__wasm.viewer.locate({ kind: 'caret', position: at }), at);
  assert.ok(caret);
  await page.evaluate(c => document.getElementById('scroll-container').scrollTop = window.__canvasView.getVirtualScroll().getPageOffset(c.page) + c.y / 75 - 160, caret);
  await page.waitForFunction(p => document.querySelector(`canvas[data-heemang-page="${p}"]`)?.width > 0, {}, caret.page);
  await settle();
  const point = await page.evaluate(c => {
    const b = document.querySelector(`canvas[data-heemang-page="${c.page}"]`).getBoundingClientRect();
    const p = window.__wasm.viewer.page(c.page);
    return { x: b.left + c.x / p.width * b.width, y: b.top + (c.y + c.height / 2) / p.height * b.height };
  }, caret);
  if (shift) await page.keyboard.down('Shift');
  try { await page.mouse.click(point.x, point.y); }
  finally { if (shift) await page.keyboard.up('Shift'); }
}
async function shortcut(key) {
  await page.keyboard.down('Meta');
  try { await page.keyboard.press(key); } finally { await page.keyboard.up('Meta'); }
  await settle();
}
try {
  await page.goto(url, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => window.__wasm?.viewer);
  await (await page.$('#file-input')).uploadFile(copy);
  await page.waitForFunction(() => window.__wasm?.hasLoadedDocument() && document.querySelector('canvas[data-heemang-page="0"]')?.width > 0, { timeout: 120000 });
  result.target = await page.evaluate(() => {
    const v = window.__wasm.viewer;
    for (let section = 0; section < v.getSectionCount(); section++) for (const para of v.paragraphs(section)) {
      const table = para.controls.find(c => c.kind === 'table');
      if (!table) continue;
      for (let index = 0; index < table.lists; index++) {
        const steps = [{ para: para.index, control: table.index, index }];
        for (const cell of v.paragraphs(section, steps)) {
          if (!cell.text || cell.controls.length) continue;
          const from = { section, steps, para: cell.index, offset: cell.caret[0] };
          const to = { ...from, offset: cell.caret[1] };
          const body = { section, para: para.index, offset: table.offset + 8 };
          if (body.offset > para.caret[1]) { body.para++; body.offset = v.paragraphs(section, [], body.para, 1)[0]?.caret[0] ?? -1; }
          if (body.offset < 0 || !v.locate({ kind: 'caret', position: body }) || !v.locate({ kind: 'caret', position: from })) continue;
          return { body, cell: from, cellRange: { from, to }, beforeHtml: v.copyText({ from, to }).html, before: v.state() };
        }
      }
    }
    throw Error('No body/table target');
  });
  await click(result.target.body);
  await click(result.target.cell, true);
  await settle();
  result.highlights = await page.$$eval('[data-heemang-overlay] > div', els => els.length);
  assert.ok(result.highlights > 1);
  await page.screenshot({ path: path.join(out, 'whole-table-selected.png') });
  await page.click('[data-menu="format"] > .menu-title');
  await page.click('[data-menu="format"] .md-item[data-cmd="format:char-shape"]');
  await page.waitForSelector('[role="dialog"][aria-label="글자 모양"]', { visible: true });
  const size = await page.evaluate(() => [...document.querySelectorAll('[role="dialog"] label')].find(l => l.textContent === '크기 (pt)').htmlFor);
  await page.click(`#${size}`);
  await shortcut('a');
  await page.keyboard.type('17');
  for (const b of await page.$$('[role="dialog"] button')) if (await b.evaluate(e => e.textContent === '적용')) { await b.click(); break; }
  await page.waitForSelector('.modal-overlay', { hidden: true });
  await settle();
  result.formatted = await page.evaluate(range => ({ state: window.__wasm.viewer.state(), html: window.__wasm.viewer.copyText(range).html }), result.target.cellRange);
  assert.match(result.formatted.html, /font-size:17pt/);
  assert.equal(result.formatted.state.undo, result.target.before.undo + 1);
  await page.screenshot({ path: path.join(out, 'whole-table-formatted.png') });
  await shortcut('z');
  result.undone = await page.evaluate(range => ({ state: window.__wasm.viewer.state(), html: window.__wasm.viewer.copyText(range).html }), result.target.cellRange);
  assert.equal(result.undone.html, result.target.beforeHtml);
  assert.equal(result.undone.state.dirty, false);
  await page.keyboard.down('Meta'); await page.keyboard.down('Shift');
  try { await page.keyboard.press('z'); } finally { await page.keyboard.up('Shift'); await page.keyboard.up('Meta'); }
  await settle();
  result.redone = await page.evaluate(range => ({ state: window.__wasm.viewer.state(), html: window.__wasm.viewer.copyText(range).html }), result.target.cellRange);
  assert.equal(result.redone.html, result.formatted.html);
  assert.deepEqual(result.errors, []);
  result.status = 'passed';
} catch (e) { result.status = 'failed'; result.failure = e.stack; await page.screenshot({ path: path.join(out, 'failure.png') }); process.exitCode = 1; }
finally { await fs.writeFile(path.join(out, 'results.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2)); await browser.close(); }
