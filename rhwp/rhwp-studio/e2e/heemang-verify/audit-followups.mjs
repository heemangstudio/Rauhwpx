/**
 * 감사 후속 차이(고정 줄 간격 표시, 각주·미주 표시 장식, 표 만들기 위치, 캡션 글 간격, 개체 상자 반올림)를
 * 실제 UI 로 만들고 HWP·HWPX 로 저장해 다시 연다. 기준선(구 엔진)과 후보를 같은 순서로 돌리고,
 * 후보 저장본을 기준선 앱에서도 열어 값을 읽는다. 공급자는 쓰지 않는다.
 * 캡션 글은 에이전트 엔진 편집이 부르는 브리지 메서드를 앱 안에서 부른다.
 */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as L from './lib.mjs';

process.env.HV_CANDIDATE_VITE_PORT ||= '7734';
process.env.HV_BASELINE_VITE_PORT ||= '7744';
const out = L.ensureOut('audit-followups');
const SOURCES = ['rhwp/template/blank-batang.hwp', 'rhwp/samples/hwpx/blank_hwpx.hwpx'];
const dispatch = (page, id, params) => page.evaluate((id, params) => window.__dispatcher.dispatch(id, params), id, params);
const key = async (page, mod, k) => { await page.keyboard.down(mod); await page.keyboard.press(k); await page.keyboard.up(mod); };

async function openParaDialog(page) {
  await dispatch(page, 'format:para-shape');
  await page.waitForSelector('.ps-dialog');
}
const lineSpacingField = () => {
  const select = [...document.querySelectorAll('.ps-dialog select')].find(s => [...s.options].some(o => o.value === 'Fixed'));
  return { select, input: select.parentElement.querySelector('input[type=number]') };
};
async function clickDialogButton(page, text) {
  await page.evaluate(text => [...document.querySelectorAll('.ps-dialog button')].find(b => b.textContent.trim() === text).click(), text);
  await page.waitForSelector('.ps-dialog', { hidden: true });
}
async function setFixed(page, pt) {
  await openParaDialog(page);
  await page.evaluate((field, pt) => {
    const { select, input } = eval(`(${field})`)();
    select.value = 'Fixed'; select.dispatchEvent(new Event('change', { bubbles: true }));
    input.value = String(pt); input.dispatchEvent(new Event('input', { bubbles: true }));
  }, lineSpacingField.toString(), pt);
  await clickDialogButton(page, '설정(D)');
}
/** 첫 문단에서 문단 모양 대화상자를 열어 줄 간격 칸을 읽는다. */
async function shownLineSpacing(page) {
  await page.evaluate(() => window.__inputHandler.focus());
  await key(page, 'Control', 'Home');
  await openParaDialog(page);
  const shown = await page.evaluate(field => { const { select, input } = eval(`(${field})`)(); return `${select.value} ${input.value}`; }, lineSpacingField.toString());
  await clickDialogButton(page, '취소');
  return shown;
}

async function createTableFromGrid(page) {
  await dispatch(page, 'table:create');
  const cell = await page.waitForSelector('.table-create-cell[data-row="1"][data-col="1"]');
  const box = await cell.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

/** 문서 구조와 에이전트에게도 보이는 값을 읽는다. */
const snapshot = page => page.evaluate(() => {
  const w = window.__wasm;
  const layout = w.getPageControlLayout(0).controls ?? JSON.parse(w.getPageControlLayout(0)).controls;
  const tables = new Set(layout.filter(c => c.type === 'table').map(c => c.paraIdx));
  const paragraphs = Array.from({ length: w.getParagraphCount(0) }, (_, p) =>
    (tables.has(p) ? '[표]' : '') + w.getTextRange(0, p, 0, w.getParagraphLength(0, p)));
  const table = layout.find(c => c.type === 'table');
  const parse = v => typeof v === 'string' ? JSON.parse(v) : v;
  const props = table ? parse(w.getTableProperties(0, table.paraIdx, table.controlIdx)) : null;
  const cell = table ? parse(w.getCellProperties(0, table.paraIdx, table.controlIdx, 0)) : null;
  const doc = w.viewer?.hmDoc?.();
  const marks = doc ? JSON.parse(doc.query('{"kind":"controls"}')).filter(c => c.kind === 'footnote' || c.kind === 'endnote').map(c => `${c.kind}:${String.fromCharCode(c.suffix || 0)}`).sort() : null;
  return {
    paragraphs,
    layout: layout.map(c => ({ type: c.type, x: c.x, y: c.y, w: c.w, h: c.h, wrap: c.wrap, rowCount: c.rowCount, colCount: c.colCount })),
    table: props && { treatAsChar: props.treatAsChar, textWrap: props.textWrap, vertRelTo: props.vertRelTo, horzRelTo: props.horzRelTo, outer: [props.outerLeft, props.outerTop],
      padding: [props.paddingLeft, props.paddingTop], pageBreak: props.pageBreak, border: props.borderLeft, cellHeight: cell.height, cellVertAlign: cell.verticalAlign },
    marks,
  };
});

async function saveAs(page, format) {
  await page.evaluate(() => {
    window.__afSaved = null;
    window.showSaveFilePicker = async o => ({ kind: 'file', name: o?.suggestedName ?? 'saved', async getFile() { return new File([window.__afSaved ?? ''], o?.suggestedName ?? 'saved'); },
      async createWritable() { return { async write(blob) { window.__afSaved = blob instanceof Blob ? blob : new Blob([blob]); }, async close() {} }; },
      async queryPermission() { return 'granted'; }, async requestPermission() { return 'granted'; } });
  });
  await dispatch(page, `file:save-as-${format}`);
  await L.waitFor(page, `${format} bytes`, () => window.__afSaved, { timeout: 20000 });
  return Buffer.from(await page.evaluate(async () => [...new Uint8Array(await window.__afSaved.arrayBuffer())]));
}

async function withApp(name, run) {
  const root = name === 'candidate' ? L.candidateRoot : L.baselineRoot;
  const app = await L.startApp(name, root, name === 'candidate' ? 9734 : 9744);
  const browser = await L.launchBrowser();
  try {
    const { page, context, log } = await L.newPage(browser);
    await L.loadApp(page, app.url);
    const result = await run(page, root);
    await context.close();
    return { url: app.url, ...result, pageErrors: log.pageErrors };
  } finally {
    await browser.close();
    await app.stop();
  }
}

async function edit(name) {
  return withApp(name, async (page, root) => {
    const runs = [];
    for (const source of SOURCES) {
      const tag = `${name}-${path.extname(source).slice(1)}`;
      const run = { source };
      runs.push(run);
      await L.openDocumentFile(page, path.join(root, source), { minInk: 0 });
      await page.evaluate(() => window.__inputHandler.focus());
      await page.keyboard.type('앞글');
      await setFixed(page, 15);
      run.shownLive = await shownLineSpacing(page);
      await key(page, 'Control', 'End');
      await createTableFromGrid(page);
      await page.evaluate(() => window.__inputHandler.focus());
      await key(page, 'Control', 'Home');
      await page.keyboard.press('End');
      await dispatch(page, 'insert:footnote');
      await page.keyboard.type('각주');
      await page.keyboard.press('Escape');
      await page.evaluate(() => window.__inputHandler.focus());
      await key(page, 'Control', 'Home');
      await page.keyboard.press('End');
      await dispatch(page, 'insert:endnote');
      await page.keyboard.type('미주');
      await page.keyboard.press('Escape');
      run.captionText = await page.evaluate(() => {
        const w = window.__wasm;
        const table = (w.getPageControlLayout(0).controls ?? JSON.parse(w.getPageControlLayout(0)).controls).find(c => c.type === 'table');
        const result = w.setTableCaptionText(0, table.paraIdx, table.controlIdx, '설명', true);
        return (typeof result === 'string' ? JSON.parse(result) : result).captionText;
      });
      await page.evaluate(() => window.__eventBus.emit('document-changed'));
      run.live = await snapshot(page);
      await page.screenshot({ path: path.join(out, `${tag}-edited.png`) });
      run.saved = {};
      for (const format of ['hwp', 'hwpx']) {
        const file = path.join(out, `${tag}-saved.${format}`);
        fs.writeFileSync(file, await saveAs(page, format));
        run.saved[format] = file;
      }
      run.reopened = {};
      for (const [format, file] of Object.entries(run.saved)) {
        await L.openDocumentFile(page, file, { minInk: 0 });
        run.reopened[format] = { shown: await shownLineSpacing(page), ...(await snapshot(page)) };
        await page.screenshot({ path: path.join(out, `${tag}-reopened-${format}.png`) });
      }
    }
    return { runs };
  });
}

/** 후보 저장본을 구 엔진 앱에서 연다. */
async function crossOpen(files) {
  return withApp('baseline', async page => {
    const read = {};
    for (const file of files) {
      await L.openDocumentFile(page, file, { minInk: 0 });
      read[path.basename(file)] = { shown: await shownLineSpacing(page), ...(await snapshot(page)) };
      await page.screenshot({ path: path.join(out, `cross-${path.basename(file)}.png`) });
    }
    return { read };
  });
}

/** HWPX 저장본에 기록된 각주·미주 표시 장식과 고정 줄 간격(HWPUNIT). */
function storedInHwpx(file) {
  const section = execFileSync('unzip', ['-p', file, 'Contents/section0.xml']).toString();
  const header = execFileSync('unzip', ['-p', file, 'Contents/header.xml']).toString();
  return {
    marks: [...section.matchAll(/<hp:(footNote|endNote) [^>]*suffixChar="(\d+)"/g)].map(m => `${m[1]}:${String.fromCharCode(Number(m[2]))}`).sort(),
    fixed: [...header.matchAll(/<hh:lineSpacing type="FIXED" value="(\d+)"/g)].map(m => Number(m[1])),
  };
}

const summary = { fixtureProvider: 'none (no agent turns)' };
summary.candidate = await edit('candidate');
summary.baseline = await edit('baseline');
for (const side of [summary.candidate, summary.baseline]) for (const run of side.runs) run.storedHwpx = storedInHwpx(run.saved.hwpx);
summary.candidateFilesInOldEngine = await crossOpen(summary.candidate.runs.flatMap(r => Object.values(r.saved)));
fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
for (const run of summary.candidate.runs) {
  assert.equal(run.shownLive, 'Fixed 15.0');
  for (const r of Object.values(run.reopened)) assert.equal(r.shown, 'Fixed 15.0');
}
