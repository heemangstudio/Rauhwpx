/** 서식 틀 블록 이식 뒤 사용자의 복사·붙여넣기와 두 파일 저장을 검사한다. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import * as L from './lib.mjs';
process.env.HV_CANDIDATE_VITE_PORT ||= '7724';
const out = L.ensureOut('template-clipboard');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'heemang-template-clipboard-'));
const blank = path.join(L.candidateRoot, 'rhwp/rhwp-studio/src/core/hm/blank.hwpx');
const oldRoot = path.join(L.baselineRoot, 'rhwp/pkg');
const old = await import(pathToFileURL(path.join(oldRoot, 'rhwp.js')));
old.initSync({ module: fs.readFileSync(path.join(oldRoot, 'rhwp_bg.wasm')) });
const fixture = new old.HwpDocument(fs.readFileSync(blank));
fixture.insertText(0, 0, 0, 'TEMPLATE');
const source = [...fixture.exportHwpx()]; fixture.free();
const results = [];
let app, browser;
const text = page => page.evaluate(() => window.__wasm.getTextRange(0, 0, 0, window.__wasm.getParagraphLength(0, 0), true));
async function save(page, format) {
  await page.evaluate(() => {
    window.__templateSaved = null;
    window.showSaveFilePicker = async o => ({ kind: 'file', name: o.suggestedName, async getFile() { return new File([window.__templateSaved ?? ''], o.suggestedName); }, async createWritable() { return { async write(b) { window.__templateSaved = b; }, async close() {} }; }, async queryPermission() { return 'granted'; }, async requestPermission() { return 'granted'; } });
  });
  await page.evaluate(format => window.__dispatcher.dispatch(`file:save-as-${format}`), format);
  await L.waitFor(page, 'saved output', () => window.__templateSaved, { timeout: 15000 });
  const bytes = await page.evaluate(async () => [...new Uint8Array(await window.__templateSaved.arrayBuffer())]);
  const file = path.join(temp, `saved.${format}`); fs.writeFileSync(file, Buffer.from(bytes)); return file;
}
try {
  browser = await L.launchBrowser();
  for (const baseline of [true, false]) {
    app = await L.startApp(baseline ? 'baseline' : 'candidate', baseline ? L.baselineRoot : L.candidateRoot, baseline ? 9730 : 9724);
    const { page, context, log } = await L.newPage(browser);
    await context.overridePermissions(app.url, ['clipboard-read', 'clipboard-write']);
    await L.loadApp(page, app.url);
    await L.openDocumentFile(page, blank, { minInk: 0 });
    await page.evaluate(() => window.__inputHandler.focus());
    await page.keyboard.type('A');
    await page.keyboard.down('Shift'); await page.keyboard.press('ArrowLeft'); await page.keyboard.up('Shift');
    await page.evaluate(() => window.__dispatcher.dispatch('edit:copy'));
    await L.waitFor(page, 'copied A', () => window.__wasm.getClipboardText() === 'A', { timeout: 10000 });
    await page.evaluate(source => {
      window.__wasm.pasteDocumentBlock(new Uint8Array(source), 0, 0, 0, 0, 0, 1);
      window.__wasm.refreshLayout();
      window.__eventBus.emit('document-changed');
    }, source);
    assert.equal(await text(page), 'ATEMPLATE');
    assert.equal(await page.evaluate(source => {
      try { window.__wasm.pasteDocumentBlock(new Uint8Array(source), 0, 99, 99, 0, 0, 1); return false; }
      catch { return window.__wasm.getClipboardText() === 'A'; }
    }, source), true);
    await page.evaluate(() => {
      window.__inputHandler.moveCursorTo({ sectionIndex: 0, paragraphIndex: 0, charOffset: window.__wasm.getParagraphLength(0, 0) });
      const clipboardData = new DataTransfer(); clipboardData.setData('text/plain', 'A');
      document.activeElement.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
    });
    await L.waitFor(page, 'pasted original A', () => window.__wasm.getTextRange(0, 0, 0, window.__wasm.getParagraphLength(0, 0), true) === 'ATEMPLATEA', { timeout: 10000 });
    for (const format of ['hwp', 'hwpx']) { await L.openDocumentFile(page, await save(page, format)); assert.equal(await text(page), 'ATEMPLATEA'); }
    await page.screenshot({ path: path.join(out, `${baseline ? 'baseline' : 'candidate'}.png`) });
    assert.deepEqual(log.pageErrors, []);
    results.push({ baseline, clipboard: 'A', pasted: 'ATEMPLATEA', failedImportPreservedClipboard: true, reopened: ['hwp', 'hwpx'], pageErrors: log.pageErrors });
    await context.close(); await app.stop(); app = null;
  }
  fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify({ candidateUrl: 'http://127.0.0.1:7724', fixtureProvider: true, results }, null, 2));
  console.log(JSON.stringify(results));
} finally { await browser?.close(); await app?.stop(); fs.rmSync(temp, { recursive: true, force: true }); }
