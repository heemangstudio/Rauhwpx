/** 실제 편집 입력·대화상자·머리말 마당과 두 형식 저장을 검사한다. 공급자 응답은 로컬 fixture 다. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import * as L from './lib.mjs';

process.env.HV_CANDIDATE_VITE_PORT ||= '7724';
const out = L.ensureOut('conditional-features');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'heemang-conditional-'));
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO/bS5kAAAAASUVORK5CYII=';
const results = [];
let app, browser;
const dispatch = (page, id, params) => page.evaluate((id, params) => window.__dispatcher.dispatch(id, params), id, params);
const records = page => page.evaluate(() => JSON.parse(window.__wasm.viewer.hmDoc().query(JSON.stringify({ kind: 'controls' }))));
async function paste(page, html, text = '') {
  await page.evaluate((html, text) => {
    window.__inputHandler.focus();
    const data = new DataTransfer(); data.setData('text/html', html); data.setData('text/plain', text);
    document.activeElement.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, html, text);
}
try {
  app = await L.startApp('candidate', L.candidateRoot, 9724);
  browser = await L.launchBrowser();
  const { page, context, log } = await L.newPage(browser);
  await L.loadApp(page, app.url);
  for (const name of ['biz_plan.hwp', '표-텍스트.hwpx']) {
    await L.openDocumentFile(page, path.join(L.candidateRoot, 'rhwp/samples', name));
    await page.evaluate(() => window.__inputHandler.focus());
    await page.keyboard.down('Control'); await page.keyboard.press('Home'); await page.keyboard.up('Control'); await page.keyboard.type('BorderLive');
    await page.keyboard.down('Shift'); for (let i = 0; i < 10; i++) await page.keyboard.press('ArrowLeft'); await page.keyboard.up('Shift');
    await dispatch(page, 'format:char-shape');
    await page.waitForSelector('.cs-dialog');
    await page.click('#cs-tab-2'); await page.click('.cs-dialog button[title="상자형"]');
    await page.evaluate(() => {
      const button = [...document.querySelectorAll('.cs-dialog button')].find(b => b.textContent.trim() === '설정(D)'); button.click();
    });
    await page.waitForSelector('.cs-dialog', { hidden: true });
    assert.equal(await page.evaluate(() => window.__wasm.getCharPropertiesAt(0, 0, 1).borderLeft?.type), 1);
    await dispatch(page, 'format:char-shape'); await page.waitForSelector('.cs-dialog');
    await page.keyboard.press('Escape'); await page.waitForSelector('.cs-dialog', { hidden: true });
    await page.keyboard.press('ArrowRight');
    const before = (await records(page)).filter(r => r.kind === 'table').length;
    await paste(page, `<table><tr><th colspan="2"><b>LiveClipboard</b></th></tr><tr><td style="background:#ffff00;border:1px solid #ff0000;padding:4px;text-align:right">FirstCell</td><td>SecondCell</td></tr></table><img width="32" height="16" src="data:image/png;base64,${png}">`, 'LiveClipboard');
    await L.waitFor(page, 'HTML table', expected => JSON.parse(window.__wasm.viewer.hmDoc().query('{"kind":"controls"}')).filter(r => r.kind === 'table').length > expected, { timeout: 10000, args: [before] });
    const all = await records(page);
    assert.ok(all.filter(r => r.kind === 'table').length > before);
    const added = all.find(r => r.kind === 'table');
    assert.ok(added);
    const info = await page.evaluate(table => JSON.parse(window.__wasm.viewer.hmDoc().query(JSON.stringify({ kind: 'table', table }))), added.target);
    assert.equal(info.columns, 2); assert.ok(info.cells.some(c => c.columnSpan === 2));
    const cellProps = await page.evaluate(table => JSON.parse(window.__wasm.viewer.hmDoc().query(JSON.stringify({ kind: 'cellProperties', table, row: 1, column: 0 }))), added.target);
    assert.equal(cellProps.borderFill.fill.solid.background, 65535); assert.equal(cellProps.padding[0], 300);
    await dispatch(page, 'page:apply-hf-template', { isHeader: 'true', applyTo: '1', templateId: '9' });
    await dispatch(page, 'page:insert-field-totalpage');
    const furniture = await records(page);
    assert.ok(furniture.some(r => r.fieldKind === 'fileName'));
    assert.ok(furniture.some(r => r.fieldKind === 'pageCount'));
    await page.screenshot({ path: path.join(out, `${path.parse(name).name}-edited.png`) });
    await dispatch(page, 'page:headerfooter-close');
    await page.evaluate(() => {
      window.__savedConditional = null;
      window.showSaveFilePicker = async o => ({ kind: 'file', name: o.suggestedName, async getFile() { return new File([window.__savedConditional ?? ''], o.suggestedName); }, async createWritable() { return { async write(blob) { window.__savedConditional = blob; }, async close() {} }; }, async queryPermission() { return 'granted'; }, async requestPermission() { return 'granted'; } });
    });
    await dispatch(page, 'file:save');
    await L.waitFor(page, 'saved file', () => window.__savedConditional, { timeout: 15000 }).catch(async error => { console.log(JSON.stringify({ console: log.console, errors: log.pageErrors, dialogs: await page.evaluate(() => [...document.querySelectorAll('[role=dialog]')].map(d => d.textContent.slice(0, 1000))) })); throw error; });
    const bytes = await page.evaluate(async () => [...new Uint8Array(await window.__savedConditional.arrayBuffer())]);
    const saved = path.join(temp, name); fs.writeFileSync(saved, Buffer.from(bytes));
    await L.openDocumentFile(page, saved);
    const reopened = await records(page);
    assert.ok(reopened.some(r => r.fieldKind === 'pageCount'));
    assert.ok(reopened.some(r => r.fieldKind === 'fileName'));
    assert.ok(reopened.filter(r => r.kind === 'table').length > before);
    results.push({ file: name, tableCells: info.cells.length, savedBytes: bytes.length, fieldsRetained: true });
  }
  assert.deepEqual(log.pageErrors, []);
  assert.ok(!log.console.some(message => message.includes('CursorState') || message.includes('ENGINE_NOT_SUPPORTED')));
  fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify({ url: app.url, fixtureProvider: true, results, pageErrors: log.pageErrors }, null, 2));
  console.log(JSON.stringify({ results, pageErrors: log.pageErrors }));
  await context.close();
} finally {
  await browser?.close(); await app?.stop(); fs.rmSync(temp, { recursive: true, force: true });
}
