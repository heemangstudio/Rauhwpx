/**
 * 타이핑 지연 벤치마크 — 키 입력 한 번이 화면에 그려지기까지 걸리는 시간.
 *
 * 한 키 입력 = 브라우저가 실제로 보내는 이벤트 묶음(keydown → composition·input)을
 * 한 태스크에서 동기로 보낸 뒤, 그 프레임의 렌더가 끝날 때까지(rAF → macrotask) 잰다.
 * wasm 호출·이벤트 리스너·캔버스 갱신은 래핑해 키 입력당 누적 시간으로 나눈다.
 *
 * 시나리오: 빈 문서 본문 / 중간 크기 문서 본문 / 표 셀 / 쪽 바닥 두 줄 안 / 대형 문서,
 * 각각 한글(IME 조합)과 영문.
 *
 * 사전 조건: WASM 빌드(pkg/) + Vite dev server
 * 실행: node e2e/typing-latency-bench.mjs --mode=headless [--json=out.json] [--only=body-mid]
 *       [--profile=dir]  시나리오별 CPU 프로파일(.cpuprofile) 저장
 *       [--connect=http://127.0.0.1:9333]  떠 있는 앱(예: --remote-debugging-port 로 띄운 dev Electron)에 붙어 잰다
 */
import { writeFileSync } from 'node:fs';
import { runTest, createNewDocument, loadHwpFile } from './helpers.mjs';

const args = new Map(process.argv.slice(2).map((arg) => {
  const [key, value = 'true'] = arg.replace(/^--/, '').split('=');
  return [key, value];
}));
const ONLY = args.get('only')?.split(',') ?? null;
const JSON_OUT = args.get('json');
const PROFILE_DIR = args.get('profile');
const CONNECT = args.get('connect');

const MID_DOC = 'kps-ai.hwp';
const TABLE_DOC = '복학원서.hwpx';
const NESTED_DOC = 'basic/issue2007_nested_cell_pagination_42065.hwp';
const GIANT_DOC = 'issue1949_giant_cell_nested_tables_perf.hwpx';

const KOREAN = '빠르게 입력하는 한글 문장이 밀리지 않는지 확인합니다';
const ENGLISH = 'The quick brown fox jumps over the lazy dog again';

// ─── 한글 자모 분해: 한 음절을 키 입력 단계별 preedit 로 푼다 ───
const CHO = 'ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ';
function syllableStages(ch) {
  const code = ch.charCodeAt(0) - 0xac00;
  if (code < 0 || code > 11171) return [ch];
  const cho = Math.floor(code / 588);
  const jung = Math.floor((code % 588) / 28);
  const jong = code % 28;
  const stages = [CHO[cho], String.fromCharCode(0xac00 + cho * 588 + jung * 28)];
  if (jong) stages.push(ch);
  return stages;
}

/** 브라우저가 한 키 입력마다 보내는 이벤트 묶음 목록. */
function koreanKeystrokes(text) {
  const strokes = [];
  let composing = null;
  for (const ch of text) {
    if (ch === ' ') {
      strokes.push({ kind: 'space', commit: composing });
      composing = null;
      continue;
    }
    syllableStages(ch).forEach((stage, index) => {
      if (index === 0) {
        strokes.push({ kind: 'start', commit: composing, preedit: stage });
      } else {
        strokes.push({ kind: 'update', preedit: stage });
      }
    });
    composing = ch;
  }
  strokes.push({ kind: 'end', commit: composing });
  return strokes;
}

function englishKeystrokes(text) {
  return [...text].map((ch) => ({ kind: 'char', ch }));
}

// ─── 페이지 쪽 계측기 ───
async function installProbe(page) {
  await page.evaluate(() => {
    if (window.__tl) return;
    const tl = { buckets: new Map(), depth: 0 };
    window.__tl = tl;
    const add = (key, ms) => {
      const entry = tl.buckets.get(key) ?? { ms: 0, calls: 0 };
      entry.ms += ms;
      entry.calls += 1;
      tl.buckets.set(key, entry);
    };
    tl.add = add;
    const wrap = (target, name, key) => {
      const original = target[name];
      if (typeof original !== 'function' || original.__tlWrapped) return;
      const wrapped = function (...a) {
        const t0 = performance.now();
        try {
          return original.apply(this, a);
        } finally {
          add(key, performance.now() - t0);
        }
      };
      wrapped.__tlWrapped = true;
      target[name] = wrapped;
    };
    // wasm bridge 메서드 (getter 제외)
    const wasm = window.__wasm;
    for (let proto = Object.getPrototypeOf(wasm); proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
      for (const name of Object.getOwnPropertyNames(proto)) {
        if (name === 'constructor') continue;
        const desc = Object.getOwnPropertyDescriptor(proto, name);
        if (desc && typeof desc.value === 'function') wrap(wasm, name, `wasm.${name}`);
      }
    }
    // 이벤트 리스너 (포함 시간)
    const bus = window.__eventBus;
    const emit = bus.emit;
    bus.emit = function (event, ...a) {
      const t0 = performance.now();
      try {
        return emit.call(this, event, ...a);
      } finally {
        add(`emit.${event}`, performance.now() - t0);
      }
    };
    const view = window.__canvasView;
    for (const name of ['refreshPages', 'refreshInvalidatedPageNow', 'renderPage', 'renderCanvas']) {
      wrap(view, name, `view.${name}`);
    }
    if (view.pageRenderer) wrap(view.pageRenderer, 'renderPage', 'pageRenderer.renderPage');
    const handler = window.__inputHandler;
    for (const name of ['updateCaret', 'afterEdit', 'afterPageLocalEdit', 'executeOperation']) {
      wrap(handler, name, `input.${name}`);
    }
  });
}

/** 한 키 입력을 보내고 동기 처리 시간과 다음 페인트까지의 시간을 잰다. */
async function runKeystrokes(page, strokes, { settleMs = 0, skipTail = false } = {}) {
  return page.evaluate(async (list, settle, noTail) => {
    const handler = window.__inputHandler;
    const ta = handler.textarea;
    const tl = window.__tl;
    const samples = [];
    const nextPaint = () => new Promise((resolve) => {
      requestAnimationFrame(() => setTimeout(resolve, 0));
    });
    const fire = (type, init) => {
      if (type.startsWith('composition')) {
        ta.dispatchEvent(new CompositionEvent(type, { bubbles: true, ...init }));
      } else if (type === 'input') {
        ta.dispatchEvent(new InputEvent('input', { bubbles: true, ...init }));
      } else {
        ta.dispatchEvent(new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init }));
      }
    };
    // 조합 시작 시점의 value 길이 — 조합 중 value = 확정분 + preedit (Chrome 누적 의미론)
    let compositionBase = ta.value.length;
    const setPreedit = (preedit) => {
      ta.value = ta.value.slice(0, compositionBase) + preedit;
    };
    const commit = (text) => {
      setPreedit(text);
      fire('compositionend', { data: text });
      fire('input', { data: text, inputType: 'insertFromComposition', isComposing: false });
      compositionBase = ta.value.length;
    };
    const perform = (s) => {
      if (s.kind === 'char') {
        fire('keydown', { key: s.ch, code: `Key${s.ch.toUpperCase()}` });
        ta.value += s.ch;
        fire('input', { data: s.ch, inputType: 'insertText', isComposing: false });
        fire('keyup', { key: s.ch });
        return;
      }
      fire('keydown', { key: 'Process', keyCode: 229, isComposing: s.kind !== 'start' || !!s.commit });
      if (s.kind === 'space') {
        if (s.commit) commit(s.commit);
        ta.value += ' ';
        fire('input', { data: ' ', inputType: 'insertText', isComposing: false });
        compositionBase = ta.value.length;
        return;
      }
      if (s.kind === 'end') {
        if (s.commit) commit(s.commit);
        return;
      }
      if (s.kind === 'start') {
        if (s.commit) commit(s.commit);
        compositionBase = ta.value.length;
        fire('compositionstart', { data: '' });
      }
      setPreedit(s.preedit);
      fire('compositionupdate', { data: s.preedit });
      fire('input', { data: s.preedit, inputType: 'insertCompositionText', isComposing: true });
    };

    tl.buckets.clear();
    for (const s of list) {
      // 입력 전에 건 rAF 는 같은 프레임에서 앱의 rAF 보다 먼저 돈다 → 프레임 안 작업량 측정 기준.
      let frameStart = 0;
      requestAnimationFrame(() => { frameStart = performance.now(); });
      const t0 = performance.now();
      perform(s);
      const tSync = performance.now();
      let frameEnd = 0;
      await new Promise((resolve) => {
        requestAnimationFrame(() => { frameEnd = performance.now(); setTimeout(resolve, 0); });
      });
      const tPaint = performance.now();
      samples.push({ sync: tSync - t0, paint: tPaint - t0, work: (tSync - t0) + Math.max(0, frameEnd - frameStart) });
      if (settle) await new Promise((r) => setTimeout(r, settle));
    }
    // idle flush(지연 pagination) 까지 포함한 꼬리 시간
    const tailStart = performance.now();
    if (!noTail) await new Promise((r) => setTimeout(r, 400));
    await nextPaint();
    const buckets = [...tl.buckets.entries()]
      .map(([key, v]) => ({ key, ms: v.ms, calls: v.calls }))
      .sort((a, b) => b.ms - a.ms);
    return { samples, buckets, tailMs: performance.now() - tailStart };
  }, strokes, settleMs, skipTail);
}

function stats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const pick = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  const mean = sorted.reduce((a, b) => a + b, 0) / Math.max(1, sorted.length);
  return { mean, p50: pick(0.5), p95: pick(0.95), max: sorted[sorted.length - 1] };
}

// ─── 커서 배치 ───
async function placeBodyCaret(page, { nearPageBottom = false } = {}) {
  const where = await page.evaluate((nearBottom) => {
    const wasm = window.__wasm;
    const handler = window.__inputHandler;
    const count = wasm.getParagraphCount(0);
    let best = null;
    for (let para = 0; para < count; para += 1) {
      const len = wasm.getParagraphLength(0, para);
      if (len < (nearBottom ? 12 : 40)) continue;
      try {
        const start = wasm.getCursorRect(0, para, 0);
        const tail = wasm.getCursorRect(0, para, len);
        if (start.pageIndex !== tail.pageIndex) continue;
        if (!nearBottom) {
          best = { para, offset: 20, page: tail.pageIndex, len };
          break;
        }
        // 쪽 바닥까지 남은 줄 수가 가장 적은 문단
        const info = wasm.getPageInfo(tail.pageIndex);
        const lines = (info.height - info.marginBottom - tail.y - tail.height) / tail.height;
        if (!best || lines < best.lines) best = { para, offset: len - 3, page: tail.pageIndex, len, lines };
      } catch { /* 다음 문단 */ }
    }
    if (!best) return null;
    handler.cursor.moveTo({ sectionIndex: 0, paragraphIndex: best.para, charOffset: best.offset });
    handler.updateCaret();
    handler.textarea.focus();
    return best;
  }, nearPageBottom);
  if (!where || !nearPageBottom) return where;
  // 꼬리 줄이 쪽 바닥 두 줄 안으로 내려오거나 다음 쪽으로 넘어갈 때까지 채운다 (종전 경계 flush 판정 조건).
  for (let i = 0; i < 240; i += 1) {
    const near = await page.evaluate(() => {
      const wasm = window.__wasm;
      const handler = window.__inputHandler;
      const pos = handler.cursor.getPosition();
      const len = wasm.getParagraphLength(pos.sectionIndex, pos.paragraphIndex);
      const tail = wasm.getCursorRect(pos.sectionIndex, pos.paragraphIndex, len);
      if (tail.pageIndex !== handler.cursor.getRect()?.pageIndex) return true;
      const info = wasm.getPageInfo(tail.pageIndex);
      return tail.y + tail.height * 2 >= info.height - info.marginBottom;
    });
    if (near) return { ...where, filled: i };
    await runKeystrokes(page, englishKeystrokes('x'), { settleMs: 0, skipTail: true });
  }
  return null;
}

async function placeCellCaret(page, { nested = false } = {}) {
  return page.evaluate((wantNested) => {
    const wasm = window.__wasm;
    const handler = window.__inputHandler;
    const pages = Math.min(wasm.pageCount, 6);
    for (let p = 0; p < pages; p += 1) {
      const info = wasm.getPageInfo(p);
      for (let y = info.marginTop ?? 40; y < info.height - 40; y += 12) {
        for (let x = 80; x < info.width - 80; x += 40) {
          let hit;
          try { hit = wasm.hitTest(p, x, y); } catch { continue; }
          if (hit?.parentParaIndex === undefined) continue;
          const depth = hit.cellPath?.length ?? 1;
          if (wantNested ? depth < 2 : depth > 1) continue;
          const len = depth > 1
            ? wasm.getCellParagraphLengthByPath(hit.sectionIndex, hit.parentParaIndex, JSON.stringify(hit.cellPath))
            : wasm.getCellParagraphLength(hit.sectionIndex, hit.parentParaIndex, hit.controlIndex, hit.cellIndex, hit.cellParaIndex);
          if (len < 2) continue;
          handler.cursor.moveTo({ ...hit, charOffset: Math.min(len, Math.floor(len / 2)) });
          handler.updateCaret();
          handler.textarea.focus();
          return { page: p, x, y, depth, len, pos: { ...hit } };
        }
      }
    }
    return null;
  }, nested);
}

async function resetTextarea(page) {
  await page.evaluate(() => {
    const handler = window.__inputHandler;
    handler.resetTextareaBuffer();
    handler.textarea.focus();
  });
}

const results = [];

async function scenario(page, name, place, strokes) {
  if (ONLY && !ONLY.includes(name)) return;
  const where = await place();
  if (!where) {
    console.log(`  [skip] ${name}: 위치를 찾지 못함`);
    return;
  }
  await resetTextarea(page);
  // 워밍업 한 글자
  await runKeystrokes(page, strokes.slice(0, 2));
  const cdp = PROFILE_DIR ? await page.createCDPSession() : null;
  if (cdp) {
    await cdp.send('Profiler.enable');
    await cdp.send('Profiler.setSamplingInterval', { interval: 100 });
    await cdp.send('Profiler.start');
  }
  const run = await runKeystrokes(page, strokes);
  if (cdp) {
    const { profile } = await cdp.send('Profiler.stop');
    writeFileSync(`${PROFILE_DIR}/${name}.cpuprofile`, JSON.stringify(profile));
    await cdp.detach();
  }
  const paint = stats(run.samples.map((s) => s.paint));
  const sync = stats(run.samples.map((s) => s.sync));
  const work = stats(run.samples.map((s) => s.work));
  const perKey = run.samples.length;
  const top = run.buckets.slice(0, 14).map((b) => ({
    key: b.key, msPerKey: b.ms / perKey, callsPerKey: b.calls / perKey,
  }));
  results.push({ name, where, keys: perKey, paint, sync, work, tailMs: run.tailMs, top });
  console.log(`\n■ ${name} (${perKey} keys) at ${JSON.stringify(where.pos ?? where)}`);
  console.log(`  input→paint  mean ${paint.mean.toFixed(1)}  p50 ${paint.p50.toFixed(1)}  p95 ${paint.p95.toFixed(1)}  max ${paint.max.toFixed(1)} ms`);
  console.log(`  main-thread  mean ${work.mean.toFixed(1)}  p50 ${work.p50.toFixed(1)}  p95 ${work.p95.toFixed(1)}  max ${work.max.toFixed(1)} ms`);
  console.log(`  sync handler mean ${sync.mean.toFixed(1)}  p50 ${sync.p50.toFixed(1)}  p95 ${sync.p95.toFixed(1)}  max ${sync.max.toFixed(1)} ms`);
  for (const b of top) {
    console.log(`    ${b.key.padEnd(48)} ${b.msPerKey.toFixed(2).padStart(7)} ms/key  ${b.callsPerKey.toFixed(1).padStart(5)} calls/key`);
  }
}

async function withPage(fn) {
  if (!CONNECT) {
    await runTest('타이핑 지연 벤치마크', async ({ page }) => {
      await page.setViewport({ width: 1400, height: 1000 });
      await fn(page);
    });
    return;
  }
  const { default: puppeteer } = await import('puppeteer-core');
  const browser = await puppeteer.connect({ browserURL: CONNECT, defaultViewport: null });
  const page = (await browser.pages()).find((p) => /^https?:\/\/(127\.0\.0\.1|localhost)/.test(p.url()));
  try {
    await fn(page);
  } finally {
    await browser.disconnect();
  }
}

await withPage(async (page) => {

  await createNewDocument(page);
  await installProbe(page);
  await page.evaluate(() => {
    const h = window.__inputHandler;
    h.cursor.moveTo({ sectionIndex: 0, paragraphIndex: 0, charOffset: 0 });
    h.textarea.focus();
  });
  // 빈 문서: 몇 줄을 채운 뒤 문단 중간에서 잰다
  const filler = englishKeystrokes('Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. ');
  await runKeystrokes(page, filler);
  const placeEmpty = () => page.evaluate(() => {
    const h = window.__inputHandler;
    h.cursor.moveTo({ sectionIndex: 0, paragraphIndex: 0, charOffset: 30 });
    h.updateCaret();
    h.textarea.focus();
    return { para: 0, offset: 30 };
  });
  await scenario(page, 'empty-ko', placeEmpty, koreanKeystrokes(KOREAN));
  await scenario(page, 'empty-en', placeEmpty, englishKeystrokes(ENGLISH));

  const mid = await loadHwpFile(page, MID_DOC);
  console.log(`\n${MID_DOC}: ${mid.pageCount} pages`);
  await installProbe(page);
  await scenario(page, 'body-mid-ko', () => placeBodyCaret(page), koreanKeystrokes(KOREAN));
  await scenario(page, 'body-mid-en', () => placeBodyCaret(page), englishKeystrokes(ENGLISH));
  await scenario(page, 'page-bottom-ko', () => placeBodyCaret(page, { nearPageBottom: true }), koreanKeystrokes(KOREAN));
  await scenario(page, 'page-bottom-en', () => placeBodyCaret(page, { nearPageBottom: true }), englishKeystrokes(ENGLISH));

  const table = await loadHwpFile(page, TABLE_DOC);
  console.log(`\n${TABLE_DOC}: ${table.pageCount} pages`);
  await installProbe(page);
  await scenario(page, 'cell-ko', () => placeCellCaret(page), koreanKeystrokes(KOREAN));
  await scenario(page, 'cell-en', () => placeCellCaret(page), englishKeystrokes(ENGLISH));

  const nested = await loadHwpFile(page, NESTED_DOC);
  console.log(`\n${NESTED_DOC}: ${nested.pageCount} pages`);
  await installProbe(page);
  await scenario(page, 'nested-cell-ko', () => placeCellCaret(page, { nested: true }), koreanKeystrokes(KOREAN));
  await scenario(page, 'nested-cell-en', () => placeCellCaret(page, { nested: true }), englishKeystrokes(ENGLISH));

  const giant = await loadHwpFile(page, GIANT_DOC);
  console.log(`\n${GIANT_DOC}: ${giant.pageCount} pages`);
  await installProbe(page);
  await scenario(page, 'giant-cell-ko', () => placeCellCaret(page), koreanKeystrokes(KOREAN));

  if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify(results, null, 2));
});
