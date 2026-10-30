/** 실제 HML 열기·키보드 편집·저장 형식 선택·재열기 검증. 로컬 가짜 공급자 허브만 사용한다. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as L from './lib.mjs';

const out = L.ensureOut('hml');
const app = await L.startApp('candidate', L.candidateRoot, 5721);
let browser, page, log;
const report = { url: app.url, provider: 'fixture-backed local hub; no provider calls', steps: [], errors: [] };
try {
  browser = await L.launchBrowser();
  ({ page, log } = await L.newPage(browser));
  await L.loadApp(page, app.url);
  const open = async file => {
    await L.openDocumentFile(page, file);
    await page.evaluate(() => { for (const toast of document.querySelectorAll('.rhwp-toast')) { if (toast.textContent.includes('HML')) [...toast.querySelectorAll('button')].find(b => b.textContent.trim() === '확인')?.click(); } });
    await page.waitForFunction(() => ![...document.querySelectorAll('.rhwp-toast')].some(e => e.textContent.includes('HML') && e.getClientRects().length));
  };
  await open(path.join(L.candidateRoot, 'rhwp/samples/hml/formatting_table.hml'));
  const text = () => page.evaluate(() => {
    const doc = window.__wasm.viewer.hmDoc();
    const listText = list => JSON.parse(doc.query(JSON.stringify({ kind: 'paragraphs', list }))).flatMap(p => [p.text, ...p.controls.flatMap(c => Array.from({ length: c.lists }, (_, i) => listText({ ...list, steps: [...(list.steps ?? []), { para: p.index, control: c.index, index: i }] })).flat())]);
    return listText({ section: 0 }).join('\n');
  });
  const before = await text();
  assert.equal(await page.evaluate(() => window.__wasm.getSourceFormat()), 'hml');
  await page.screenshot({ path: path.join(out, 'before.png') });
  const target = await page.evaluate(() => {
    const canvas = [...document.querySelectorAll('#scroll-content canvas')].find(c => c.width && c.getBoundingClientRect().height > 200);
    if (!canvas) throw new Error('no document canvas');
    const rect = canvas.getBoundingClientRect();
    const ctx = canvas.getContext('2d');
    const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    for (let y = 20; y < height; y++) for (let x = Math.round(width * .05); x < width * .95; x++) {
      const i = (y * width + x) * 4;
      if (data[i + 3] > 128 && data[i] + data[i + 1] + data[i + 2] < 300) return { x: rect.left + (x + 2) * rect.width / width, y: rect.top + (y + 4) * rect.height / height };
    }
    throw new Error('no visible text');
  });
  await page.mouse.click(target.x, target.y);
  await page.keyboard.type('HML검증😀');
  await page.waitForFunction(() => window.__wasm.viewer.search('HML검증😀', true).matches.length === 1);
  const edited = await text();
  assert.notEqual(edited, before);
  report.steps.push('Opened real HML and inserted Korean/emoji through keyboard input.');
  await page.screenshot({ path: path.join(out, 'after-edit.png') });
  await page.evaluate(() => {
    window.__hmlSaved = null;
    window.showSaveFilePicker = async options => ({
      kind: 'file', name: options.suggestedName,
      async getFile() { return new File([window.__hmlSaved?.blob ?? ''], options.suggestedName); },
      async createWritable() { return { async write(blob) { window.__hmlSaved = { name: options.suggestedName, blob: blob instanceof Blob ? blob : new Blob([blob]) }; }, async close() {} }; },
      async queryPermission() { return 'granted'; }, async requestPermission() { return 'granted'; },
    });
  });
  const dispatch = id => page.evaluate(id => window.__dispatcher.dispatch(id), id);
  const saved = async () => {
    await page.waitForFunction(() => window.__hmlSaved, { timeout: 15000 });
    const result = await page.evaluate(async () => ({ name: window.__hmlSaved.name, bytes: [...new Uint8Array(await window.__hmlSaved.blob.arrayBuffer())] }));
    const file = path.join(out, result.name); fs.writeFileSync(file, Buffer.from(result.bytes)); return file;
  };
  await dispatch('file:save');
  await page.waitForFunction(() => window.__hmlSaved || [...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'HML로 저장' && b.getClientRects().length));
  if (!await page.evaluate(() => Boolean(window.__hmlSaved))) await page.evaluate(() => [...document.querySelectorAll('.dialog-footer button')].find(b => b.textContent.trim() === 'HML로 저장')?.click());
  const same = await saved();
  assert.match(same, /\.hml$/);
  await open(same);
  assert.equal(await text(), edited);
  report.steps.push('Saved HML through the file command and reopened the written bytes with identical edited text.');
  await page.evaluate(() => { window.__hmlSaved = null; });
  await dispatch('file:save-as');
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'HML로 저장' && b.getClientRects().length));
  await page.screenshot({ path: path.join(out, 'format-dialog.png') });
  await page.evaluate(() => [...document.querySelectorAll('.dialog-footer button')].find(b => b.textContent.trim() === '취소')?.click());
  await page.waitForFunction(() => ![...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'HML로 저장' && b.getClientRects().length));
  assert.equal(await page.evaluate(() => window.__hmlSaved), null);
  assert.equal(await text(), edited);
  report.steps.push('Canceled the HML save-format dialog; no output was written and text stayed unchanged.');
  for (const [format, label] of [['hml', 'HML로 저장'], ['hwp', 'HWP 5.0으로 저장'], ['hwpx', 'HWPX로 저장']]) {
    await open(same);
    await page.evaluate(() => { window.__hmlSaved = null; });
    await dispatch('file:save-as');
    await page.waitForFunction(label => [...document.querySelectorAll('button')].some(b => b.textContent.trim() === label && b.getClientRects().length), {}, label);
    await page.evaluate(label => [...document.querySelectorAll('.dialog-footer button')].find(b => b.textContent.trim() === label)?.click(), label);
    const file = await saved(); assert.match(file, new RegExp(`\\.${format}$`));
    await open(file);
    assert.equal(await text(), edited);
    report.steps.push(`Selected ${format} in the real save-format dialog and reopened the output with identical text.`);
  }
  await open(same);
  const failed = await page.evaluate(async () => {
    const requestId = crypto.randomUUID();
    return new Promise(resolve => {
      const off = window.__eventBus.on('open-document-bytes:done', payload => { if (payload.requestId === requestId) { off(); resolve(payload.ok); } });
      window.__eventBus.emit('open-document-bytes', { requestId, bytes: new TextEncoder().encode('<HWPML><HEAD></BODY>'), fileName: 'broken.hml', suppressDialogs: true, skipUnsavedGuard: true });
    });
  });
  assert.equal(failed, false); assert.equal(await text(), edited);
  report.steps.push('Rejected malformed HML while preserving the current edited document.');
  report.errors = log.pageErrors;
  assert.deepEqual(report.errors, []);
  assert.deepEqual(L.rhwpEngineRequests(log), []);
  await page.screenshot({ path: path.join(out, 'after-reopen.png') });
  report.ok = true;
} catch (error) {
  report.ok = false; report.failure = String(error.stack ?? error); process.exitCode = 1;
  report.diagnostics = await page?.evaluate(() => ({ dialogs: [...document.querySelectorAll('[role="dialog"], .rhwp-toast')].filter(e => e.getClientRects().length).map(e => e.textContent), source: window.__wasm?.getSourceFormat(), capabilities: window.__wasm?.getHmlSaveState() })).catch(() => null);
  report.console = log?.console;
  await page?.screenshot({ path: path.join(out, 'failure.png') }).catch(() => {});
} finally {
  await browser?.close(); await app.stop();
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}
