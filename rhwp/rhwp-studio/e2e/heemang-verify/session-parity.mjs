/** 세션 번호와 마지막 쪽 바탕쪽을 실제 편집기에서 기준선과 비교한다. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import * as L from './lib.mjs';
process.env.HV_CANDIDATE_VITE_PORT ||= '7724';
const out = L.ensureOut('session-parity');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'heemang-session-'));
const blank = path.join(L.candidateRoot, 'rhwp/rhwp-studio/src/core/hm/blank.hwpx');
const master = process.env.HV_MASTER_FIXTURE || path.join(L.candidateRoot, 'rhwp/rhwp-studio/tests/fixtures/heemang-last-page-master.hwpx');
const results = [];
let browser, app;
async function heads(page, baseline) {
  return page.evaluate(baseline => {
    if (baseline) {
      const strings = (v, out = []) => { if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { if (k === 'text' && typeof x === 'string') out.push(x); else strings(x, out); } return out; };
      return strings(JSON.parse(window.__wasm.doc.getPageRenderTree(0))).filter(s => /^\d+\.$/.test(s));
    }
    const lines = new Map();
    for (const op of window.__wasm.viewer.page(0).ops) {
      if (op.op !== 'glyphs' || !op.glyphs.every(g => window.__digitGlyphs[`${op.face}:${g[0]}`])) continue;
      if (!lines.has(op.baseline)) lines.set(op.baseline, []);
      for (const g of op.glyphs) lines.get(op.baseline).push([g[1], window.__digitGlyphs[`${op.face}:${g[0]}`]]);
    }
    return [...lines].sort((a, b) => a[0] - b[0]).map(([, glyphs]) => glyphs.sort((a, b) => a[0] - b[0]).map(g => g[1]).join('')).filter(s => /^\d+\.$/.test(s));
  }, baseline);
}
async function save(page, name, format) {
  await page.evaluate(() => {
    window.__sessionSaved = null;
    window.showSaveFilePicker = async o => ({ kind: 'file', name: o.suggestedName, async getFile() { return new File([window.__sessionSaved ?? ''], o.suggestedName); }, async createWritable() { return { async write(b) { window.__sessionSaved = b; }, async close() {} }; }, async queryPermission() { return 'granted'; }, async requestPermission() { return 'granted'; } });
  });
  await page.evaluate(format => window.__dispatcher.dispatch(format ? `file:save-as-${format}` : 'file:save'), format);
  await L.waitFor(page, 'saved output', () => window.__sessionSaved, { timeout: 15000 });
  const bytes = await page.evaluate(async () => [...new Uint8Array(await window.__sessionSaved.arrayBuffer())]);
  const target = path.join(temp, name); fs.writeFileSync(target, Buffer.from(bytes)); return target;
}
try {
  browser = await L.launchBrowser();
  for (const baseline of (process.env.HV_SIDE === 'candidate' ? [false] : [true, false])) {
    app = await L.startApp(baseline ? 'baseline' : 'candidate', baseline ? L.baselineRoot : L.candidateRoot, baseline ? 9730 : 9724);
    const { page, context, log } = await L.newPage(browser);
    await L.loadApp(page, app.url);
    for (const kind of ['Outline', 'None', 'Number']) {
      await L.openDocumentFile(page, blank, { minInk: 0 });
      await page.evaluate(() => window.__inputHandler.focus());
      await page.keyboard.type('First\nSecond\nPlain\nThird');
      await page.evaluate((kind, baseline) => {
        const w = window.__wasm, id = w.ensureDefaultNumbering();
        for (let p = 0; p < 4; p++) w.applyParaFormat(0, p, JSON.stringify({ headType: p === 2 ? 'None' : kind, numberingId: id, paraLevel: 0 }));
        w.setNumberingRestart(0, 1, 2, 7);
        if (kind === 'None') w.applyParaFormat(0, 1, JSON.stringify({ headType: 'Number', numberingId: id }));
        if (!baseline) {
          const d = w.viewer.hmEngine().create(w.exportHwpx());
          const a = JSON.parse(d.query('{"kind":"paragraphs","list":{"section":0},"count":1}'))[0].caret[0];
          d.transact(JSON.stringify({ops:[{op:'setList',from:{section:0,para:0,offset:a},to:{section:0,para:0,offset:a},list:null},{op:'insertText',at:{section:0,para:0,offset:a},text:'0123456789.'}]}));
          window.__probeDoc = d;
        }
        window.__eventBus.emit('document-changed');
      }, kind, baseline);
      if (!baseline) await page.evaluate(async () => {
        const { decodePacket } = await import('/src/view/heemang-player.ts');
        const d = window.__probeDoc;
        const run = decodePacket(d.page(0)).ops.find(o => o.op === 'glyphs' && o.glyphs.length >= 11);
        window.__digitGlyphs = Object.fromEntries(run.glyphs.slice(0, 11).map((g, i) => [`${run.face}:${g[0]}`, '0123456789.'[i]]));
        d.free();
      });
      const expected = kind === 'None' ? ['7.'] : ['1.', '7.', '8.'];
      const visible = await heads(page, baseline);
      if (JSON.stringify(visible) !== JSON.stringify(expected)) console.log(JSON.stringify({ baseline, kind, visible, debug: await page.evaluate(() => ({ map: window.__digitGlyphs, ops: window.__wasm.viewer.page?.(0)?.ops, props: window.__wasm.getParaPropertiesAt(0, 1) })) }));
      assert.deepEqual(visible, expected);
      assert.equal(await page.evaluate(() => window.__inputHandler.moveCursorTo({ sectionIndex: 0, paragraphIndex: 1, charOffset: 0 })), true);
      assert.equal(await page.evaluate(() => window.__inputHandler.getCursorPosition().paragraphIndex), 1);
      if (!baseline) {
        await page.evaluate(() => window.__dispatcher.dispatch('format:para-num-shape'));
        await page.waitForSelector('input[name="nd-restart-mode"][value="2"]:checked');
        await page.keyboard.press('Escape');
        assert.deepEqual(await heads(page, baseline), expected);
      }
      await page.screenshot({ path: path.join(out, `${baseline ? 'baseline' : 'candidate'}-${kind}.png`) });
      const saved = await save(page, `${baseline ? 'baseline' : 'candidate'}-${kind}.hwpx`);
      await L.openDocumentFile(page, saved);
      const reopened = kind === 'None' ? ['1.'] : ['1.', '2.', '3.'];
      assert.deepEqual(await heads(page, baseline), reopened);
      results.push({ baseline, kind, visible: expected, reopened });
    }
    await L.openDocumentFile(page, master);
    if (baseline) assert.deepEqual(await page.evaluate(() => [0, 1].map(p => window.__wasm.doc.getPageRenderTree(p).includes('LAST_MASTER_PROBE'))), [false, true]);
    else await page.evaluate(async () => {
      const w = window.__wasm, d = w.viewer.hmEngine().create(w.exportHwpx());
      const a = JSON.parse(d.query('{"kind":"paragraphs","list":{"section":0},"count":1}'))[0].caret[0];
      d.transact(JSON.stringify({ops:[{op:'insertText',at:{section:0,para:0,offset:a},text:'ABCDEFGHIJKLMNOPQRSTUVWXYZ_'}]}));
      const { decodePacket } = await import('/src/view/heemang-player.ts');
      const run = decodePacket(d.page(0)).ops.find(o => o.op === 'glyphs' && o.glyphs.length >= 27);
      window.__masterGlyphs = Object.fromEntries(run.glyphs.slice(0, 27).map((g, i) => [`${run.face}:${g[0]}`, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ_'[i]]));
      d.free();
    });
    const masterVisible = () => page.evaluate(baseline => [0, 1].map(p => baseline
      ? window.__wasm.doc.getPageRenderTree(p).includes('LAST_MASTER_PROBE')
      : window.__wasm.viewer.page(p).ops.filter(o => o.op === 'glyphs').some(o => o.glyphs.map(g => window.__masterGlyphs[`${o.face}:${g[0]}`] ?? '?').join('').includes('LAST_MASTER_PROBE'))), baseline);
    assert.deepEqual(await masterVisible(), [false, true]);
    await page.screenshot({ path: path.join(out, `${baseline ? 'baseline' : 'candidate'}-master.png`) });
    for (const format of ['hwp', 'hwpx']) {
      const saved = await save(page, `${baseline ? 'baseline' : 'candidate'}-master.${format}`, format);
      await L.openDocumentFile(page, saved);
      assert.deepEqual(await masterVisible(), [false, true]);
    }
    assert.deepEqual(log.pageErrors, []);
    results.push({ baseline, masterSavedReopened: true, formats: ['hwp', 'hwpx'], pageErrors: log.pageErrors });
    await context.close(); await app.stop(); app = null;
  }
  fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify({ results, candidateUrl: 'http://127.0.0.1:7724', fixtureProvider: true }, null, 2));
  console.log(JSON.stringify(results));
} finally { await browser?.close(); await app?.stop(); fs.rmSync(temp, { recursive: true, force: true }); }
