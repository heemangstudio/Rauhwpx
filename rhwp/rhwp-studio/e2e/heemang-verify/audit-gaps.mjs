/**
 * 감사에서 찾은 세 차이(머리말·주석 확장 서식, 다각형·호 도형, 번호 붙인 표 캡션 글)를 실제 UI 로 만들고
 * HWP·HWPX 로 저장해 다시 연다. 기준선(구 엔진)과 후보를 같은 순서로 돌려 값을 비교한다.
 * 공급자는 쓰지 않는다. 표 캡션 글은 에이전트 엔진 편집 경로가 부르는 브리지 메서드를 앱 안에서 부른다.
 *
 * HV_APPS=candidate,baseline (기본 둘 다)
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import * as L from './lib.mjs';

process.env.HV_CANDIDATE_VITE_PORT ||= '7734';
process.env.HV_BASELINE_VITE_PORT ||= '7744';
const out = L.ensureOut('audit-gaps');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'heemang-audit-gaps-'));
const SOURCES = ['rhwp/template/blank-batang.hwp', 'rhwp/samples/hwpx/blank_hwpx.hwpx'];
const dispatch = (page, id, params) => page.evaluate((id, params) => window.__dispatcher.dispatch(id, params), id, params);

async function setControl(page, selector, value) {
  await page.evaluate((selector, value) => {
    const el = document.querySelector(selector);
    if (!el) throw new Error(`no ${selector}`);
    el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, selector, value);
}

async function clickButton(page, root, text) {
  await page.evaluate((root, text) => {
    const button = [...document.querySelectorAll(`${root} button`)].find(b => b.textContent.trim() === text);
    if (!button) throw new Error(`no button ${text}`);
    button.click();
  }, root, text);
}

/** 문단 모양 대화상자에서 고정 줄 간격과 오른쪽 여백(pt)을 고른다. */
async function paraDialog(page, { fixedPt, rightPt }) {
  await dispatch(page, 'format:para-shape');
  await page.waitForSelector('.ps-dialog');
  await page.evaluate((fixedPt, rightPt) => {
    const dialog = document.querySelector('.ps-dialog');
    const select = [...dialog.querySelectorAll('select')].find(s => [...s.options].some(o => o.value === 'Fixed'));
    select.value = 'Fixed';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    const row = select.parentElement;
    const input = row.querySelector('input[type=number]');
    input.value = String(fixedPt);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    if (rightPt !== undefined) {
      const label = [...dialog.querySelectorAll('*')].find(e => e.childElementCount === 0 && e.textContent.trim() === '오른쪽(O):');
      const margin = label.parentElement.querySelector('input[type=number]');
      margin.value = String(rightPt);
      margin.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }, fixedPt, rightPt);
  await clickButton(page, '.ps-dialog', '설정(D)');
  await page.waitForSelector('.ps-dialog', { hidden: true });
}

/** 글자 모양 대화상자 확장 탭에서 밑줄 위치·모양·색을 고른다. */
async function underlineDialog(page) {
  await dispatch(page, 'format:char-shape');
  await page.waitForSelector('.cs-dialog');
  await page.click('#cs-tab-1');
  await page.evaluate(() => {
    const panel = document.querySelector('#cs-panel-1');
    const fieldset = [...panel.querySelectorAll('fieldset')].find(f => f.querySelector('legend')?.textContent.includes('밑줄'));
    const [position, shape] = fieldset.querySelectorAll('select');
    position.value = 'Bottom'; position.dispatchEvent(new Event('change', { bubbles: true }));
    shape.value = '3'; shape.dispatchEvent(new Event('change', { bubbles: true }));
    const color = fieldset.querySelector('input[type=color]');
    color.value = '#ff0000'; color.dispatchEvent(new Event('input', { bubbles: true })); color.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await clickButton(page, '.cs-dialog', '설정(D)');
  await page.waitForSelector('.cs-dialog', { hidden: true });
}

/** 방금 친 글을 선택한다. 머리말의 Home/End 는 두 앱 모두 커서 오류를 내므로 화살표로 고른다. */
async function selectTyped(page, text) {
  await page.keyboard.down('Shift');
  for (let i = 0; i < [...text].length; i++) await page.keyboard.press('ArrowLeft');
  await page.keyboard.up('Shift');
}

/** 첫 쪽 화면 좌표(문서 px) → 뷰포트 좌표. */
async function pagePoint(page, x, y) {
  return page.evaluate((x, y) => {
    const canvas = document.querySelector('#scroll-content canvas');
    const rect = canvas.getBoundingClientRect();
    const zoom = window.__viewportManager?.getZoom?.() ?? rect.width / 793.7;
    return { x: rect.left + x * zoom, y: rect.top + y * zoom };
  }, x, y);
}

async function pickShape(page, label) {
  await dispatch(page, 'insert:shape');
  await page.evaluate(label => {
    const items = [...document.querySelectorAll('button, [role=menuitem]')].filter(b => b.textContent.trim() === label || b.getAttribute('aria-label') === label || b.title === label);
    if (!items.length) throw new Error(`no shape ${label}`);
    items[0].click();
  }, label);
}

async function drawShapes(page) {
  await pickShape(page, '호');
  const a = await pagePoint(page, 150, 300), b = await pagePoint(page, 250, 380);
  await page.mouse.move(a.x, a.y); await page.mouse.down();
  await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 4 }); await page.mouse.move(b.x, b.y, { steps: 4 });
  await page.mouse.up();
  await page.keyboard.press('Escape');
  await pickShape(page, '다각형');
  const points = [[350, 300], [470, 300], [410, 400]];
  for (const [x, y] of points) {
    const p = await pagePoint(page, x, y);
    await page.mouse.click(p.x, p.y);
  }
  const first = await pagePoint(page, points[0][0], points[0][1]);
  await page.mouse.click(first.x, first.y);
  await page.keyboard.press('Escape');
}

const shapes = page => page.evaluate(() => window.__wasm.getPageControlLayout(0).controls
  .filter(c => c.type === 'shape').map(c => ({ w: Math.round(c.w * 10) / 10, h: Math.round(c.h * 10) / 10 })));

/** 앱 안의 현재 문서에서 세 기능의 결과를 읽는다. */
async function readBack(page) {
  return page.evaluate(() => {
    const w = window.__wasm;
    const hfChar0 = w.getCharPropertiesInHf(0, true, 0, 0, 0);
    const hfPara = w.getParaPropertiesInHf(0, true, 0, 0);
    const controls = JSON.parse(w.getPageControlLayout ? JSON.stringify(w.getPageControlLayout(0)) : '{}').controls ?? [];
    const noteHost = (() => {
      for (let p = 0; p < 3; p++) for (let c = 0; c < 6; c++) {
        try { const info = w.getFootnoteInfo(0, p, c); if (info?.ok !== false && info?.paraCount) return { p, c }; } catch { /* 다음 */ }
      }
      return null;
    })();
    const noteChar = noteHost ? w.getCharPropertiesInFootnote(0, noteHost.p, noteHost.c, 0, 0) : null;
    const notePara = noteHost ? w.getParaPropertiesInFootnote(0, noteHost.p, noteHost.c, 0) : null;
    return {
      header: { text: JSON.parse(w.getHeaderFooter(0, true, 0)).text, underline: hfChar0.underline, underlineColor: hfChar0.underlineColor, underlineShape: hfChar0.underlineShape,
        emboss: hfChar0.emboss, lineSpacingType: hfPara.lineSpacingType, lineSpacing: hfPara.lineSpacing, marginRight: Math.round(hfPara.marginRight * 10) / 10 },
      footnote: noteHost && { emboss: noteChar.emboss, lineSpacingType: notePara.lineSpacingType, lineSpacing: notePara.lineSpacing },
      shapes: controls.filter(c => c.type === 'shape').length,
    };
  });
}

async function saveAs(page, format) {
  await page.evaluate(() => {
    window.__agSaved = null;
    window.showSaveFilePicker = async o => ({ kind: 'file', name: o?.suggestedName ?? 'saved', async getFile() { return new File([window.__agSaved ?? ''], o?.suggestedName ?? 'saved'); },
      async createWritable() { return { async write(blob) { window.__agSaved = blob instanceof Blob ? blob : new Blob([blob]); }, async close() {} }; },
      async queryPermission() { return 'granted'; }, async requestPermission() { return 'granted'; } });
  });
  await dispatch(page, `file:save-as-${format}`);
  await L.waitFor(page, `${format} bytes`, () => window.__agSaved, { timeout: 20000 });
  return Buffer.from(await page.evaluate(async () => [...new Uint8Array(await window.__agSaved.arrayBuffer())]));
}

async function runApp(name, root) {
  const app = await L.startApp(name, root, name === 'candidate' ? 9734 : 9744);
  const browser = await L.launchBrowser();
  const runs = [];
  try {
    const { page, context, log } = await L.newPage(browser);
    await L.loadApp(page, app.url);
    for (const source of SOURCES) {
      const tag = `${name}-${path.extname(source).slice(1)}`;
      const run = { source, steps: {} };
      runs.push(run);
      const step = async (label, fn) => {
        try { run.steps[label] = { ok: true, ...(await fn() ?? {}) }; } catch (error) {
          run.steps[label] = { ok: false, error: String(error?.message || error).slice(0, 400) };
          await page.screenshot({ path: path.join(out, `${tag}-${label}-fail.png`) }).catch(() => {});
        }
      };
      await L.openDocumentFile(page, path.join(root, source), { minInk: 0 });
      await page.evaluate(() => window.__inputHandler.focus());
      // 머리말 안에서는 두 앱 모두 글자 모양 대화상자가 열리지 않는다(선택을 본문 선택으로 묻는다).
      // 양각은 도구 모음 명령, 문단 서식은 대화상자, 밑줄 색·모양은 에이전트 엔진 편집이 부르는 브리지로 준다.
      await step('header', async () => {
        await dispatch(page, 'page:header-create');
        await page.keyboard.type('머리말 서식');
        await selectTyped(page, '머리말 서식');
        await dispatch(page, 'format:emboss');
        await paraDialog(page, { fixedPt: 15, rightPt: 5 });
        await page.evaluate(() => window.__wasm.applyCharFormatInHeaderFooter(0, true, 0, 0, 0, 0, 3,
          JSON.stringify({ underline: true, underlineColor: '#ff0000', underlineShape: 3 })));
        await page.evaluate(() => window.__eventBus.emit('document-changed'));
        await page.screenshot({ path: path.join(out, `${tag}-header.png`) });
        await dispatch(page, 'page:headerfooter-close');
      });
      // 각주 안에서는 두 앱 모두 도구 모음 글자 서식을 막는다. 양각은 브리지로, 고정 줄 간격은 대화상자로 준다.
      await step('footnote', async () => {
        await page.evaluate(() => window.__inputHandler.focus());
        await page.keyboard.down('Control'); await page.keyboard.press('Home'); await page.keyboard.up('Control');
        await page.keyboard.type('본문');
        await dispatch(page, 'insert:footnote');
        await page.keyboard.type('각주 서식');
        await paraDialog(page, { fixedPt: 12 });
        await page.evaluate(() => {
          const w = window.__wasm;
          for (let p = 0; p < 3; p++) for (let c = 0; c < 6; c++) {
            try { if (w.getFootnoteInfo(0, p, c)?.paraCount) { w.applyCharFormatInFootnote(0, p, c, 0, 0, 2, JSON.stringify({ emboss: true })); return; } } catch { /* 다음 */ }
          }
          throw new Error('no footnote');
        });
        await page.evaluate(() => window.__eventBus.emit('document-changed'));
        await page.screenshot({ path: path.join(out, `${tag}-footnote.png`) });
        await page.keyboard.press('Escape');
      });
      await step('shapes', async () => {
        await drawShapes(page);
        await page.screenshot({ path: path.join(out, `${tag}-shapes.png`) });
        return { shapes: await shapes(page) };
      });
      await step('caption', async () => page.evaluate(() => {
        const w = window.__wasm;
        const table = w.createTableEx({ sectionIdx: 0, paraIdx: 0, charOffset: 0, rowCount: 1, colCount: 1 });
        return { captionText: w.setTableCaptionText(0, table.paraIdx, table.controlIdx, ' 설명', true).captionText };
      }));
      // 기록용: 본문에 고정 줄 간격 15pt 를 주고 대화상자를 다시 열었을 때 보이는 값.
      await step('bodyFixedDisplay', async () => {
        await page.evaluate(() => window.__inputHandler.focus());
        await page.keyboard.down('Control'); await page.keyboard.press('End'); await page.keyboard.up('Control');
        await paraDialog(page, { fixedPt: 15 });
        await dispatch(page, 'format:para-shape');
        await page.waitForSelector('.ps-dialog');
        const shown = await page.evaluate(() => {
          const select = [...document.querySelectorAll('.ps-dialog select')].find(s => [...s.options].some(o => o.value === 'Fixed'));
          return { type: select.value, value: select.parentElement.querySelector('input[type=number]').value };
        });
        await clickButton(page, '.ps-dialog', '취소');
        return shown;
      });
      run.live = await readBack(page).catch(error => ({ error: String(error).slice(0, 300) }));
      await page.screenshot({ path: path.join(out, `${tag}-edited.png`) });
      run.reopened = {};
      const saved = {};
      for (const format of ['hwp', 'hwpx']) {
        try {
          const bytes = await saveAs(page, format);
          saved[format] = path.join(out, `${tag}-saved.${format}`);
          fs.writeFileSync(saved[format], bytes);
        } catch (error) {
          run.reopened[format] = { error: String(error?.message || error).slice(0, 400) };
        }
      }
      for (const [format, file] of Object.entries(saved)) {
        try {
          await L.openDocumentFile(page, file, { minInk: 0 });
          run.reopened[format] = { bytes: fs.statSync(file).size, ...(await readBack(page)), shapeBoxes: await shapes(page) };
          await page.screenshot({ path: path.join(out, `${tag}-reopened-${format}.png`) });
        } catch (error) {
          run.reopened[format] = { error: String(error?.message || error).slice(0, 400) };
        }
      }
    }
    runs.push({ pageErrors: log.pageErrors, engineErrors: log.console.filter(m => m.includes('ENGINE_NOT_SUPPORTED') || m.includes('지원하지 않는')) });
    await context.close();
  } finally {
    await browser.close();
    await app.stop();
  }
  return { url: app.url, runs };
}

const apps = (process.env.HV_APPS || 'candidate,baseline').split(',');
const summary = { fixtureProvider: 'none (no agent turns)', apps: {} };
try {
  for (const name of apps) summary.apps[name] = await runApp(name, name === 'candidate' ? L.candidateRoot : L.baselineRoot);
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
if (summary.apps.candidate) {
  for (const run of summary.apps.candidate.runs.filter(r => r.source)) {
    for (const [label, s] of Object.entries(run.steps)) assert.ok(s.ok, `${run.source} ${label}: ${s.error}`);
  }
}
