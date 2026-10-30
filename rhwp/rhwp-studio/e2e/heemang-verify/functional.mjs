/**
 * 기능 비교 — 같은 사용자 시나리오를 기준선(구 엔진)과 후보(HeemangEngine)에서 실제 문서로 돌리고
 * 단계별 성공 여부, 저장 후 다시 연 문서 내용, 입력 지연(키 → 화면 갱신), 첫 그리기 시간, 되돌리기
 * 정확성을 비교한다. 후보는 구 엔진(rhwp_bg.wasm, rhwp.js) 요청과 EngineNotSupportedError 를 따로 센다.
 *
 * 실행: node rhwp/rhwp-studio/e2e/heemang-verify/functional.mjs [문서 이름 일부]
 * 결과: e2e/heemang-verify/out/functional/summary.json, parity.md, 실패 화면 PNG
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import * as L from './lib.mjs';

const CORPUS = path.join(L.candidateRoot, '..', '..', 'heemang-cleanroom/parity-corpus/docs');
const SAMPLES = path.join(L.candidateRoot, 'rhwp/samples');
const DOCS = [
  { file: path.join(CORPUS, 'd-05-mixed-korean-latin-108b1ff845b3.hwpx') },
  { file: path.join(CORPUS, 'd-01-table-border-styles-6a0712c9dd15.hwpx'), cellQuery: 'thin neighbor' },
  { file: path.join(CORPUS, 'd-156467175-press-release-head-4d0ec3e99bf4.hwp') },
  { file: path.join(SAMPLES, 'footnote-01.hwp') },
  { file: path.join(CORPUS, 'd-1341000-research-report-foot-cd72258675b5.hwp') },
].filter((doc) => !process.argv[2] || doc.file.includes(process.argv[2]));

const MARK = 'HV검증 Hello';
const CELL_MARK = '셀HV';
const REPLACEMENT = '교체HV';
const out = L.ensureOut('functional');
for (const file of fs.readdirSync(out)) fs.rmSync(path.join(out, file), { recursive: true });

/** 엔진에 상관없이 쓰는 페이지 도우미. 엔진별 API 차이는 여기서만 다룬다. */
function installHelpers() {
  window.__hvToasts = [];
  const observe = () => new MutationObserver((records) => {
    for (const record of records) for (const node of record.addedNodes) {
      if (node.nodeType !== 1) continue;
      const toast = node.matches?.('.rhwp-toast') ? node : node.querySelector?.('.rhwp-toast');
      if (toast) window.__hvToasts.push(toast.textContent.trim().slice(0, 300));
    }
  }).observe(document.documentElement, { childList: true, subtree: true });
  if (document.documentElement) observe(); else document.addEventListener('DOMContentLoaded', observe);
  window.__hv = {
    heemang: () => window.__wasm?.engineKind === 'heemang',
    text() {
      const w = window.__wasm;
      const sections = Math.max(1, w.getSectionCount());
      const parts = [];
      for (let s = 0; s < sections; s += 1) {
        const n = w.getParagraphCount(s);
        for (let p = 0; p < n; p += 1) parts.push(this.heemang() ? w.getParagraphText(s, p) : w.getTextRange(s, p, 0, 100000));
      }
      return parts.join('\n');
    },
    count(query) {
      const w = window.__wasm;
      if (this.heemang()) return w.search(query, true).matches.length;
      return w.searchAllText(query, true, true).length;
    },
    /** 클릭한 쪽 전체의 해시 — 가운데 정렬된 셀의 글자는 클릭 지점과 멀리 그려질 수 있다. */
    pageHash(y) {
      let hash = 0;
      for (const canvas of document.querySelectorAll('#scroll-content canvas')) {
        const rect = canvas.getBoundingClientRect();
        if (rect.bottom < y - 60 || rect.top > y + 60 || !canvas.width) continue;
        const height = canvas.height;
        if (height <= 0) continue;
        const copy = document.createElement('canvas');
        copy.width = canvas.width; copy.height = height;
        const ctx = copy.getContext('2d');
        ctx.drawImage(canvas, 0, 0);
        const { data } = ctx.getImageData(0, 0, copy.width, copy.height);
        // 검은 글자가 투명 바탕에 그려지면 RGB는 그대로이고 alpha만 바뀐다.
        for (let i = 0; i < data.length; i += 8) {
          const rgba = data[i] | (data[i + 1] << 8) | (data[i + 2] << 16) | (data[i + 3] << 24);
          hash = (hash * 31 + rgba) | 0;
        }
      }
      return hash;
    },
    /** 다음 입력 이벤트부터 쪽 내용이 다시 그려진 프레임까지의 ms. */
    armLatency(y, timeout = 1500) {
      const before = this.pageHash(y);
      return new Promise((resolve) => {
        let start = null;
        const onInput = (event) => { start ??= event.timeStamp; };
        window.addEventListener('keydown', onInput, true);
        window.addEventListener('beforeinput', onInput, true);
        const limit = performance.now() + timeout;
        const tick = (now) => {
          if (start !== null && this.pageHash(y) !== before) {
            window.removeEventListener('keydown', onInput, true);
            window.removeEventListener('beforeinput', onInput, true);
            resolve(Math.max(0, now - start));
            return;
          }
          if (now > limit) {
            window.removeEventListener('keydown', onInput, true);
            window.removeEventListener('beforeinput', onInput, true);
            resolve(null); return;
          }
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
    },
    /** 첫 쪽에서 가장 위 글줄의 왼쪽 끝(화면 좌표). */
    firstInk() {
      const canvas = [...document.querySelectorAll('#scroll-content canvas')].find((c) => c.width && c.getBoundingClientRect().height > 200);
      if (!canvas) return null;
      const rect = canvas.getBoundingClientRect();
      const copy = document.createElement('canvas');
      copy.width = canvas.width; copy.height = canvas.height;
      const ctx = copy.getContext('2d');
      ctx.drawImage(canvas, 0, 0);
      const { data, width, height } = ctx.getImageData(0, 0, copy.width, copy.height);
      const dark = (x, y) => { const i = (y * width + x) * 4; return data[i + 3] > 128 && data[i] + data[i + 1] + data[i + 2] < 300; };
      for (let y = Math.round(height * 0.04); y < height; y += 1) {
        let count = 0, minX = width;
        for (let x = Math.round(width * 0.05); x < width * 0.95; x += 1) if (dark(x, y)) { count += 1; minX = Math.min(minX, x); }
        if (count >= 3) {
          // 같은 줄의 아래쪽 끝까지 내려가 줄 가운데를 고른다.
          let bottom = y;
          while (bottom < height - 1 && bottom - y < 60) {
            let any = false;
            for (let x = minX; x < width * 0.95; x += 2) if (dark(x, bottom + 1)) { any = true; break; }
            if (!any) break;
            bottom += 1;
          }
          const scale = rect.width / width;
          return { x: rect.left + (minX + 2) * scale, y: rect.top + ((y + bottom) / 2) * scale };
        }
      }
      return null;
    },
  };
}

async function step(result, name, fn) {
  const t0 = Date.now();
  try {
    const detail = await fn();
    result.steps[name] = { ok: detail?.ok ?? true, ms: Date.now() - t0, ...(detail && typeof detail === 'object' ? detail : {}) };
  } catch (error) {
    result.steps[name] = { ok: false, ms: Date.now() - t0, error: String(error?.message || error).slice(0, 400) };
  }
  return result.steps[name];
}

const dispatch = (page, id) => page.evaluate((cmd) => {
  try { return window.__dispatcher.dispatch(cmd); } catch (error) { return `throw: ${error?.message}`; }
}, id);
const text = (page) => page.evaluate(() => window.__hv.text());
const count = (page, query) => page.evaluate((q) => window.__hv.count(q), query);

async function closeFind(page) {
  await page.keyboard.press('Escape');
  await page.evaluate(() => document.querySelectorAll('.find-dialog .dialog-close').forEach((el) => { if (el.getClientRects().length) el.click(); }));
}

/** 찾기 대화상자로 query 로 간다(사용자가 셀·문단으로 가는 방법). */
async function gotoByFind(page, query) {
  const opened = await dispatch(page, 'edit:find');
  await L.waitFor(page, 'find dialog', () => [...document.querySelectorAll('.find-dialog input')].some((el) => el.getClientRects().length), { timeout: 4000 });
  await page.evaluate((q) => {
    const input = [...document.querySelectorAll('.find-dialog input')].find((el) => el.getClientRects().length && el.type !== 'checkbox');
    input.focus(); input.value = q; input.dispatchEvent(new Event('input', { bubbles: true }));
  }, query);
  await page.evaluate(() => {
    const next = [...document.querySelectorAll('.find-dialog button')].find((b) => b.textContent.trim().startsWith('다음 찾기') || b.textContent.trim() === '찾기');
    next?.click();
  });
  await L.sleep(250);
  await closeFind(page);
  return opened;
}

async function saveCapture(page) {
  await page.evaluate(() => {
    window.__hvSaved = null;
    window.showSaveFilePicker = async (options) => {
      const name = options?.suggestedName ?? 'saved';
      return {
        kind: 'file', name,
        async getFile() { return new File([window.__hvSaved ?? ''], name); },
        async createWritable() { return { async write(blob) { window.__hvSaved = blob instanceof Blob ? blob : new Blob([blob]); }, async close() {} }; },
        async queryPermission() { return 'granted'; }, async requestPermission() { return 'granted'; },
      };
    };
  });
  const dispatched = await dispatch(page, 'file:save');
  await L.waitFor(page, 'saved bytes', () => window.__hvSaved, { timeout: 15000 });
  const bytes = await page.evaluate(async () => Array.from(new Uint8Array(await window.__hvSaved.arrayBuffer())));
  return { dispatched, bytes: Buffer.from(bytes) };
}

/** HWPX 저장본에서 표식이 든 글자 모양이 굵은지 본다. HWP 는 null. */
function hwpxBold(bytes, mark) {
  if (bytes[0] !== 0x50) return null;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hv-hwpx-'));
  try {
    fs.writeFileSync(path.join(dir, 'doc.hwpx'), bytes);
    execFileSync('unzip', ['-q', '-o', 'doc.hwpx', '-d', 'x'], { cwd: dir });
    const header = fs.readFileSync(path.join(dir, 'x/Contents/header.xml'), 'utf8');
    const sections = fs.readdirSync(path.join(dir, 'x/Contents')).filter((f) => f.startsWith('section'));
    const word = mark.split(' ')[0];
    for (const file of sections) {
      const xml = fs.readFileSync(path.join(dir, 'x/Contents', file), 'utf8');
      const run = new RegExp(`<hp:run charPrIDRef="(\\d+)"[^>]*>(?:(?!</hp:run>).)*?${word}`, 's').exec(xml);
      if (!run) continue;
      const charPr = new RegExp(`<hh:charPr id="${run[1]}"[^>]*>((?:(?!</hh:charPr>).)*)</hh:charPr>`, 's').exec(header);
      return Boolean(charPr && /<hh:bold\b/.test(charPr[1]));
    }
    return 'mark not found';
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function shot(page, name) {
  const file = path.join(out, `${name}.png`);
  await page.screenshot({ path: file }).catch(() => {});
  return file;
}

async function runDoc(engine, page, doc) {
  const docName = path.basename(doc.file);
  const result = { engine, doc: docName, steps: {}, metrics: {} };
  await page.evaluate(() => { window.__hvToasts = []; });

  const open = await step(result, 'open', async () => ({ firstPaintMs: await L.openDocumentFile(page, doc.file) }));
  if (!open.ok) { result.screenshot = await shot(page, `${engine}-${docName}-open`); return result; }
  result.metrics.firstPaintMs = open.firstPaintMs;
  result.metrics.pages = await page.evaluate(() => window.__wasm.pageCount);

  await step(result, 'scroll-all-pages', async () => {
    const t0 = Date.now();
    const stats = await page.evaluate(async () => {
      const box = document.getElementById('scroll-container');
      const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      let steps = 0;
      while (box.scrollTop + box.clientHeight < box.scrollHeight - 2 && steps < 400) {
        box.scrollTop += box.clientHeight; steps += 1; await frame();
      }
      await frame();
      const atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 2;
      const inkAtBottom = [...document.querySelectorAll('#scroll-content canvas')].filter((c) => {
        const r = c.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight && c.width > 0;
      }).length;
      box.scrollTop = 0; await frame();
      return { steps, atBottom, visibleCanvasesAtBottom: inkAtBottom };
    });
    return { ok: stats.atBottom && stats.visibleCanvasesAtBottom > 0, ...stats, scrollMs: Date.now() - t0 };
  });

  const before = await text(page).catch(() => null);
  result.metrics.textLength = before?.length ?? null;
  let target = null;
  await step(result, 'click-text', async () => {
    target = await page.evaluate(() => window.__hv.firstInk());
    if (!target) return { ok: false, error: 'no ink on first page' };
    await page.mouse.click(target.x, target.y);
    await L.sleep(150);
    const focused = await page.evaluate(() => {
      const el = document.activeElement;
      return el?.tagName === 'TEXTAREA' || el?.id === 'scroll-container' || Boolean(el?.closest?.('#editor-area'));
    });
    return { ok: focused, target };
  });

  await step(result, 'ctrl-home', async () => {
    // Ctrl+Home 뒤 Shift+→ 로 무언가 골라지는지(문서 처음으로 갔는지) 본다.
    const toasts = await page.evaluate(() => window.__hvToasts.length);
    await page.keyboard.down('Control'); await page.keyboard.press('Home'); await page.keyboard.up('Control');
    await page.keyboard.down('Shift'); await page.keyboard.press('ArrowRight'); await page.keyboard.up('Shift');
    await L.sleep(150);
    const copied = await page.evaluate(() => {
      const data = new DataTransfer();
      document.activeElement.dispatchEvent(new ClipboardEvent('copy', { clipboardData: data, bubbles: true, cancelable: true }));
      return data.getData('text/plain');
    });
    const newToasts = await page.evaluate((n) => window.__hvToasts.slice(n), toasts);
    // 이후 단계가 같은 자리에서 시작하도록 원래 줄을 다시 누른다.
    if (target) await page.mouse.click(target.x, target.y);
    await L.sleep(100);
    // 문서 처음에는 개체가 올 수 있어 첫 글자는 비교하지 않는다. 선택이 생기고 오류가 없으면 통과.
    return { ok: copied.length > 0 && newToasts.length === 0, copied: copied.slice(0, 12), toasts: newToasts };
  });

  const latencies = [];
  await step(result, 'type-ko-en', async () => {
    if (!target) return { ok: false, error: 'no caret target' };
    for (const ch of MARK) {
      // 공백 입력은 글자를 그리지 않을 수 있으므로 내용만 확인하고 paint 표본에서는 뺀다.
      if (!ch.trim()) { await page.keyboard.type(ch); continue; }
      // 이벤트 관찰자가 설치된 뒤 입력한다. evaluate와 CDP 키 입력을 경합시키지 않는다.
      await page.evaluate((y) => { window.__hvPaintWaiter = window.__hv.armLatency(y); }, target.y);
      await page.keyboard.type(ch);
      latencies.push(await page.evaluate(() => window.__hvPaintWaiter));
    }
    await L.sleep(150);
    const after = await text(page);
    const n = await count(page, MARK);
    return { ok: n === 1, markCount: n, bodyChanged: after !== before, missedPaints: latencies.filter((v) => v === null).length };
  });
  const measured = latencies.filter((v) => v !== null).sort((a, b) => a - b);
  result.metrics.typingRawMs = latencies.map((v) => (v === null ? null : Math.round(v)));
  result.metrics.typingLatencyMs = measured.length ? {
    n: measured.length, p50: Math.round(measured[Math.floor(measured.length / 2)]), p95: Math.round(measured[Math.floor(measured.length * 0.95)] ?? measured.at(-1)), max: Math.round(measured.at(-1)),
  } : null;
  const typed = await text(page).catch(() => null);

  await step(result, 'undo-redo', async () => {
    if (before === null || typed === null) return { ok: false, error: 'text unavailable' };
    let undos = 0;
    while ((await text(page)) !== before && undos < 40) { await dispatch(page, 'edit:undo'); undos += 1; await L.sleep(30); }
    const undoneToOriginal = (await text(page)) === before;
    let redos = 0;
    while (redos < undos) { await dispatch(page, 'edit:redo'); redos += 1; await L.sleep(30); }
    const redoneToEdited = (await text(page)) === typed;
    return { ok: undoneToOriginal && redoneToEdited, undos, redos, undoneToOriginal, redoneToEdited, typedChanged: typed !== before };
  });

  await step(result, 'select+bold', async () => {
    // 찾기로 표식을 고른다(엔진과 무관하게 같은 범위가 선택된다).
    await gotoByFind(page, MARK);
    await L.sleep(100);
    const focus = await page.evaluate(() => {
      const el = document.activeElement;
      return `${el?.tagName?.toLowerCase()}${el?.id ? `#${el.id}` : ''}${el?.dataset?.heemangInput ? '[heemang-input]' : ''}`;
    });
    const dispatched = await dispatch(page, 'format:bold');
    await L.sleep(250);
    // 굵게가 바로 적용되지 않고 대화상자를 띄우면 기록하고 적용을 눌러 흐름을 잇는다.
    const dialog = await page.evaluate(() => {
      const overlay = [...document.querySelectorAll('.modal-overlay')].find((el) => el.getClientRects().length);
      if (!overlay) return null;
      const title = overlay.querySelector('.dialog-title, h2, h3')?.textContent.trim() ?? overlay.textContent.trim().slice(0, 40);
      const apply = [...overlay.querySelectorAll('button')].find((b) => /적용|확인|설정/.test(b.textContent));
      apply?.click();
      return title;
    });
    await L.sleep(200);
    const toolbarBold = await page.evaluate(() => document.getElementById('btn-bold')?.classList.contains('active') ?? null);
    return { ok: dispatched === true && toolbarBold === true && !dialog, dispatched, toolbarBold, opensDialog: dialog, focus };
  });

  await step(result, 'copy-paste', async () => {
    // 실제 copy/paste 이벤트를 편집 입력에 보낸다(앱의 클립보드 처리기를 그대로 탄다).
    const types = await page.evaluate(() => {
      window.__hvFocus = document.activeElement?.tagName;
      const data = new DataTransfer();
      document.activeElement.dispatchEvent(new ClipboardEvent('copy', { clipboardData: data, bubbles: true, cancelable: true }));
      window.__hvClip = [...data.types].map((type) => [type, data.getData(type)]);
      return window.__hvClip.map(([type, value]) => `${type}:${value.length}`);
    });
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('End');
    await L.sleep(50);
    await page.evaluate(() => {
      const data = new DataTransfer();
      for (const [type, value] of window.__hvClip ?? []) data.setData(type, value);
      document.activeElement.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    });
    await L.sleep(400);
    const n = await count(page, MARK);
    return { ok: n === 2, clipboardTypes: types, markCount: n };
  });

  // 자주 나오는 2글자 이상 낱말을 바꾼다(문서마다 같은 규칙, 엔진과 무관).
  const word = ((await text(page).catch(() => null)) ?? '').split(/[^0-9A-Za-z가-힣]+/).filter((w) => w.length >= 2 && !/HV|Hello|검증/.test(w))
    .reduce((acc, w) => acc.set(w, (acc.get(w) ?? 0) + 1), new Map());
  const findWord = [...word.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];
  await step(result, 'find-replace-all', async () => {
    if (!findWord) return { ok: false, error: 'no word to replace' };
    const n0 = await count(page, findWord);
    const opened = await dispatch(page, 'edit:find-replace');
    await L.waitFor(page, 'replace dialog', () => [...document.querySelectorAll('.find-dialog input')].filter((el) => el.getClientRects().length && el.type !== 'checkbox').length >= 2, { timeout: 4000 });
    await page.evaluate((q, r) => {
      const inputs = [...document.querySelectorAll('.find-dialog input')].filter((el) => el.getClientRects().length && el.type !== 'checkbox');
      for (const [input, value] of [[inputs[0], q], [inputs[1], r]]) { input.focus(); input.value = value; input.dispatchEvent(new Event('input', { bubbles: true })); }
      [...document.querySelectorAll('.find-dialog button')].find((b) => b.textContent.trim().startsWith('모두 바꾸기'))?.click();
    }, findWord, REPLACEMENT);
    await L.sleep(500);
    await closeFind(page);
    const n1 = await count(page, findWord);
    const r1 = await count(page, REPLACEMENT);
    return { ok: n0 > 0 && n1 === 0 && r1 === n0, opened, word: findWord, before: n0, remaining: n1, replaced: r1 };
  });

  if (doc.cellQuery) {
    await step(result, 'table-cell-edit', async () => {
      await gotoByFind(page, doc.cellQuery);
      await page.keyboard.press('End');
      await page.keyboard.type(CELL_MARK);
      await L.sleep(200);
      const n = await count(page, CELL_MARK);
      const inCell = await count(page, `${doc.cellQuery}${CELL_MARK}`);
      return { ok: n === 1 && inCell === 1, cellMarkCount: n, appendedToCell: inCell };
    });
  }

  const preSave = await text(page).catch(() => null);
  const expected = {
    mark: await count(page, MARK).catch(() => null),
    replacement: await count(page, REPLACEMENT).catch(() => null),
    cell: doc.cellQuery ? await count(page, CELL_MARK).catch(() => null) : undefined,
  };
  let saved = null;
  await step(result, 'save-same-format', async () => {
    const { dispatched, bytes } = await saveCapture(page);
    saved = bytes;
    const ext = path.extname(doc.file).slice(1);
    const magicOk = ext === 'hwpx' ? bytes[0] === 0x50 && bytes[1] === 0x4b : bytes[0] === 0xd0 && bytes[1] === 0xcf;
    const file = path.join(out, `${engine}-${docName}`);
    fs.writeFileSync(file, bytes);
    const clean = await page.evaluate(() => !window.__documentState?.isDirty?.());
    return { ok: dispatched === true && magicOk, bytes: bytes.length, magicOk, cleanAfterSave: clean, file };
  });
  result.savedFile = saved ? path.join(out, `${engine}-${docName}`) : null;
  result.metrics.boldInSavedHwpx = saved ? hwpxBold(saved, MARK) : null;

  await step(result, 'reopen-verify', async () => {
    if (!saved) return { ok: false, error: 'nothing saved' };
    await L.openDocumentFile(page, result.savedFile);
    const reopened = await text(page);
    const got = {
      mark: await count(page, MARK),
      replacement: await count(page, REPLACEMENT),
      cell: doc.cellQuery ? await count(page, CELL_MARK) : undefined,
    };
    const sameText = reopened === preSave;
    return { ok: sameText && JSON.stringify(got) === JSON.stringify(expected), sameText, expected, got, reopenedTextLength: reopened.length, preSaveTextLength: preSave?.length };
  });
  result.reopenedText = preSave;

  await step(result, 'pdf-export', async () => {
    const enabled = await page.evaluate(() => ({
      printToPdf: window.__dispatcher.isEnabled('file:print-to-pdf'),
      print: window.__dispatcher.isEnabled('file:print'),
    }));
    return { ok: enabled.printToPdf === true, ...enabled };
  });

  result.toasts = await page.evaluate(() => window.__hvToasts.slice(0, 20));
  if (Object.values(result.steps).some((s) => !s.ok)) result.screenshot = await shot(page, `${engine}-${docName}`);
  return result;
}

/** 후보가 저장한 파일을 기준선(구 엔진)으로 열어 같은 표식이 보이는지. */
async function crossCheck(page, file, doc) {
  try {
    await L.openDocumentFile(page, file);
    return {
      ok: true,
      mark: await count(page, MARK),
      replacement: await count(page, REPLACEMENT),
      cell: doc.cellQuery ? await count(page, CELL_MARK) : undefined,
    };
  } catch (error) {
    return { ok: false, error: String(error?.message || error).slice(0, 300) };
  }
}

function verdict(b, c) {
  if (!b && !c) return 'n/a';
  if (b?.ok && c?.ok) return 'parity';
  if (b?.ok && !c?.ok) return 'CANDIDATE FAILS';
  if (!b?.ok && c?.ok) return 'candidate better';
  return 'both fail';
}

const started = Date.now();
const apps = {};
let browser;
const report = { docs: [], candidateQuery: L.CANDIDATE_QUERY, engineChecks: {} };
try {
  [apps.baseline, apps.candidate, browser] = await Promise.all([
    L.startApp('baseline', L.baselineRoot, 6600),
    L.startApp('candidate', L.candidateRoot, 6700),
    L.launchBrowser(),
  ]);
  const sessions = {};
  for (const name of ['baseline', 'candidate']) {
    sessions[name] = await L.newPage(browser);
    const origin = new URL(apps[name].url).origin;
    await sessions[name].context.overridePermissions(origin, ['clipboard-read', 'clipboard-write', 'clipboard-sanitized-write']);
    await sessions[name].page.evaluateOnNewDocument(installHelpers);
  }
  const boot = {};
  await Promise.all(['baseline', 'candidate'].map(async (name) => { boot[name] = await L.loadApp(sessions[name].page, apps[name].url); }));
  report.bootMs = boot;

  for (const doc of DOCS) {
    const [b, c] = await Promise.all([
      runDoc('baseline', sessions.baseline.page, doc),
      runDoc('candidate', sessions.candidate.page, doc),
    ]);
    if (c.savedFile) c.crossCheckInBaseline = await crossCheck(sessions.baseline.page, c.savedFile, doc);
    report.docs.push({ doc: b.doc, baseline: b, candidate: c });
    const failed = Object.entries(c.steps).filter(([, s]) => !s.ok).map(([k]) => k);
    console.log(`${b.doc}: candidate failed [${failed.join(', ')}] baseline failed [${Object.entries(b.steps).filter(([, s]) => !s.ok).map(([k]) => k).join(', ')}]`);
  }

  for (const [name, session] of Object.entries(sessions)) {
    const notSupported = [...session.log.console, ...session.log.pageErrors].filter((l) => /EngineNotSupported|지원하지 않는 기능/.test(l));
    report.engineChecks[name] = {
      rhwpEngineRequests: L.rhwpEngineRequests(session.log),
      pageErrors: session.log.pageErrors,
      engineNotSupportedConsole: notSupported,
      toastsNotSupported: report.docs.flatMap((d) => (d[name].toasts ?? []).filter((t) => /지원하지 않는/.test(t))),
      consoleErrors: session.log.console.filter((l) => l.startsWith('error')).slice(0, 30),
    };
  }
} finally {
  await browser?.close().catch(() => {});
  await Promise.all(Object.values(apps).map((app) => app.stop().catch(() => {})));
}

// ─── parity 표 ───
const rows = [];
const stepNames = [...new Set(report.docs.flatMap((d) => [...Object.keys(d.baseline.steps), ...Object.keys(d.candidate.steps)]))];
const brief = (s) => {
  if (!s) return '—';
  const keys = Object.entries(s).filter(([k]) => !['ok', 'ms', 'file', 'target', 'expected', 'got'].includes(k));
  const extra = keys.map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' ').slice(0, 140);
  return `${s.ok ? 'ok' : 'FAIL'} ${extra}`.trim();
};
for (const name of stepNames) {
  for (const d of report.docs) {
    const b = d.baseline.steps[name]; const c = d.candidate.steps[name];
    rows.push({ feature: name, doc: d.doc, baseline: brief(b), candidate: brief(c), verdict: verdict(b, c) });
  }
}
const metric = (d, key) => [d.baseline.metrics[key], d.candidate.metrics[key]];
for (const d of report.docs) {
  const [bp, cp] = metric(d, 'firstPaintMs');
  rows.push({ feature: 'first paint ms', doc: d.doc, baseline: bp ?? '—', candidate: cp ?? '—', verdict: bp && cp ? (cp <= bp * 1.2 ? 'parity/better' : 'CANDIDATE SLOWER') : 'n/a' });
  const [bl, cl] = metric(d, 'typingLatencyMs');
  rows.push({ feature: 'typing latency p50/p95 ms', doc: d.doc, baseline: bl ? `${bl.p50}/${bl.p95}` : '—', candidate: cl ? `${cl.p50}/${cl.p95}` : '—', verdict: bl && cl ? (cl.p95 <= bl.p95 * 1.2 + 4 ? 'parity/better' : 'CANDIDATE SLOWER') : 'n/a' });
  const [bb, cb] = metric(d, 'boldInSavedHwpx');
  if (bb !== null || cb !== null) rows.push({ feature: 'bold persisted (hwpx)', doc: d.doc, baseline: String(bb), candidate: String(cb), verdict: bb === true && cb !== true ? 'CANDIDATE FAILS' : bb === cb ? 'parity' : 'differs' });
  if (d.candidate.crossCheckInBaseline) rows.push({ feature: 'candidate file opened by old engine', doc: d.doc, baseline: '—', candidate: JSON.stringify(d.candidate.crossCheckInBaseline), verdict: d.candidate.crossCheckInBaseline.ok ? 'info' : 'CANDIDATE FAILS' });
}
report.parity = rows;
report.seconds = Math.round((Date.now() - started) / 100) / 10;
const md = ['| feature | doc | baseline | candidate | verdict |', '|---|---|---|---|---|',
  ...rows.map((r) => `| ${r.feature} | ${r.doc.slice(0, 28)} | ${String(r.baseline).replace(/\|/g, '/')} | ${String(r.candidate).replace(/\|/g, '/')} | ${r.verdict} |`)].join('\n');
fs.writeFileSync(path.join(out, 'parity.md'), `${md}\n`);
fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(report, (k, v) => (k === 'reopenedText' ? undefined : v), 2));
const fails = rows.filter((r) => /FAIL|SLOWER/.test(r.verdict));
console.log(`\n${fails.length} candidate regressions in ${rows.length} rows (${report.seconds} s)`);
console.log(`candidate old-engine requests: ${report.engineChecks.candidate?.rhwpEngineRequests.length ?? '?'}; EngineNotSupported toasts: ${report.engineChecks.candidate?.toastsNotSupported.length ?? '?'}; page errors: ${report.engineChecks.candidate?.pageErrors.length ?? '?'}`);
console.log(`→ ${path.join(out, 'parity.md')}`);
process.exit(0);
