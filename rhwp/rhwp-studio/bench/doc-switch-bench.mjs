// 문서 전환 시간을 잰다: 격리된 Electron 데스크톱(자기 Vite·허브·프로필)에서 사이드바 문서 열기
// 팔레트로 A → B → A … 를 오가며 전환마다 벽시계 시간, 단계별 시간, 메모리를 적는다.
//
// 사용 (rhwp/rhwp-studio 에서):
//   node bench/doc-switch-bench.mjs [--docs=k-water-rfp.hwp,exam_kor.hwp] [--switches=10]
//     [--edit] [--profile] [--label=baseline] [--out=<json>] [--wasm-dir=<pkg 폴더>] [--keep]
//
// --edit    전환 전에 글자 하나를 넣어 저장·커밋 경로까지 잰다.
// --profile 전환마다 CPU 프로파일을 받아 자체 시간 상위 함수를 적는다 (시간이 조금 늘어난다).
// --wasm-dir 이 폴더의 rhwp.js/rhwp_bg.wasm 을 쓴다. rhwp/pkg 를 바꾸지 않고 엔진 변경을 잰다.
// 결과는 <repo>/.run/doc-switch-bench/<label>-<시각>.json 에 남는다.
//
// 사용자의 앱·Vite 와 겹치지 않게 Vite 는 빈 포트와 따로 만든 최적화 캐시를 쓰고, Electron 은
// 임시 사용자 데이터 폴더와 자기 허브(포트 0)를 쓴다. 문서는 임시 폴더에 복사해 저장해도 samples 가
// 바뀌지 않는다.
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';

import {
  findAvailablePort,
  removeTempDir,
  repoRoot,
  spawnLogged,
  stats,
  stopServer,
  studioRoot,
  waitForHttp,
} from '../e2e/agent-bench-harness.mjs';

function arg(name, fallback) {
  const hit = process.argv.find((value) => value.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}
const flag = (name) => process.argv.includes(`--${name}`);

const DOCS = arg('docs', 'k-water-rfp.hwp,exam_kor.hwp').split(',').filter(Boolean);
const SWITCHES = Number(arg('switches', '10'));
const EDIT = flag('edit');
const PROFILE = flag('profile');
const LABEL = arg('label', 'run');
const KEEP = flag('keep');
const WASM_DIR = arg('wasm-dir', '');
const workspaceRoot = path.resolve(repoRoot, '..');
const outDir = path.join(workspaceRoot, '.run', 'doc-switch-bench');
const OUT = arg('out', path.join(outDir, `${LABEL}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`));
const MiB = 1024 * 1024;
const mib = (bytes) => (bytes == null ? null : +(bytes / MiB).toFixed(1));

const requireRoot = createRequire(path.join(workspaceRoot, 'package.json'));
const requireStudio = createRequire(path.join(studioRoot, 'package.json'));
const electronPath = requireRoot('electron');
const puppeteer = requireStudio('puppeteer-core');

// ── Vite: 사용자의 개발 서버와 캐시를 나누는 감싼 설정 ─────────────────
function writeViteConfig() {
  const dir = path.join(studioRoot, '.run', 'doc-switch-bench');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'vite.config.mts');
  const wasmDir = WASM_DIR ? path.resolve(WASM_DIR) : '';
  fs.writeFileSync(file, `
import base from '../../vite.config.ts';
const wasmDir = ${JSON.stringify(wasmDir)};
const config = { ...base, cacheDir: ${JSON.stringify(path.join(dir, 'vite-cache'))} };
if (wasmDir) {
  const alias = { ...(base.resolve?.alias ?? {}) };
  alias['@wasm/rhwp.js'] = wasmDir + '/rhwp.js';
  alias['@wasm'] = wasmDir;
  config.resolve = { ...base.resolve, alias };
  config.server = { ...base.server, fs: { ...base.server?.fs, allow: [...(base.server?.fs?.allow ?? []), wasmDir] } };
}
export default config;
`);
  return file;
}

// ── 페이지 계측: 프로토타입 메서드를 감싸 시작·끝을 적는다 ──────────────
async function installInstrumentation() {
  if (window.__benchLog) return;
  const log = window.__benchLog = [];
  const STACKED = new Set(['wasm.exportHwp', 'wasm.exportHwpx', 'wasm.refreshLayout', 'versions.refresh', 'input.deactivate']);
  const wrap = (proto, name, label) => {
    const orig = proto?.[name];
    if (typeof orig !== 'function' || orig.__bench) return;
    const wrapped = function (...args) {
      const s = performance.now();
      let result;
      try {
        result = orig.apply(this, args);
      } catch (error) {
        log.push({ label, s, e: performance.now(), err: true });
        throw error;
      }
      const stack = STACKED.has(label) ? new Error().stack.split('\n').slice(2, 14).map((line) => line.trim().replace(/https?:\/\/[^/]+\/(src\/)?/, '').replace(/\?[^:]*/, '')) : undefined;
      if (result && typeof result.then === 'function') {
        return result.then(
          (v) => { log.push({ label, s, e: performance.now(), async: true, stack }); return v; },
          (err) => { log.push({ label, s, e: performance.now(), async: true, err: true }); throw err; },
        );
      }
      log.push({ label, s, e: performance.now(), stack });
      return result;
    };
    wrapped.__bench = true;
    proto[name] = wrapped;
  };
  const session = window.__documentSessions.attached();
  const wasmProto = Object.getPrototypeOf(session.wasm);
  for (const name of ['loadDocument', 'loadTrustedLocalFileOnce', 'adoptPreparedDocument', 'releaseDocument',
    'exportHwp', 'exportHwpx', 'refreshLayout', 'getDocumentInfo', 'renderPageToCanvas', 'renderPageToCanvasFiltered', 'getPageLayerTree',
    'getPageLayerTreeObject', 'getAllPageInfo', 'getValidationWarnings', 'beginDeferredPagination',
    'flushDeferredPagination', 'stepDeferredPagination']) {
    wrap(wasmProto, name, `wasm.${name}`);
  }
  if (session.versions) {
    const vp = Object.getPrototypeOf(session.versions);
    for (const name of ['documentLoaded', 'checkpoint', 'persistWorktree', 'whenIdle', 'refresh', 'dispose']) wrap(vp, name, `versions.${name}`);
  }
  const ap = Object.getPrototypeOf(session.autosave);
  for (const name of ['flushNow', 'flushAndWait', 'saveForRecovery', 'endDocument', 'discardCurrentDraft']) wrap(ap, name, `autosave.${name}`);
  if (window.__canvasView) {
    const cp = Object.getPrototypeOf(window.__canvasView);
    for (const name of ['loadDocument', 'prepareDocumentLoad', 'refreshPages', 'captureViewState']) wrap(cp, name, `canvas.${name}`);
  }
  if (window.__inputHandler) {
    const ip = Object.getPrototypeOf(window.__inputHandler);
    for (const name of ['activateWithCaretPosition', 'deactivate', 'detachDocumentState', 'attachDocumentState']) wrap(ip, name, `input.${name}`);
  }
  // 내부 모듈 함수 (Vite 개발 서버는 /src 경로를 앱과 같은 모듈 인스턴스로 준다)
  window.__benchWrap = wrap;
  window.__benchStacked = STACKED;
  window.__benchMark = (label) => log.push({ label, s: performance.now(), e: performance.now(), mark: true });
}

/** 문서를 연 뒤에 엔진 쓰기 메서드를 감싼다 (버전 지문 캐시를 무효로 만드는 호출을 본다). */
async function installEngineWriteProbe() {
  const session = window.__documentSessions.attached();
  const docProto = session.wasm.doc ? Object.getPrototypeOf(session.wasm.doc) : null;
  if (!docProto) return 0;
  const { isEngineReadCall } = await import('/src/core/engine-trap.ts');
  let count = 0;
  for (const name of Object.getOwnPropertyNames(docProto)) {
    if (name === 'constructor' || name === 'free' || isEngineReadCall?.(name)) continue;
    const d = Object.getOwnPropertyDescriptor(docProto, name);
    if (typeof d?.value !== 'function') continue;
    window.__benchStacked.add(`engine.${name}`);
    window.__benchWrap(docProto, name, `engine.${name}`);
    count += 1;
  }
  return count;
}

async function wasmMemoryBytes(page) {
  return page.evaluate(async () => {
    const entry = performance.getEntriesByType('resource').map((e) => e.name).find((n) => /\/rhwp\.js(\?|$)/.test(n));
    let rhwp = null;
    if (entry) {
      try {
        const mod = await import(/* @vite-ignore */ new URL(entry).pathname + new URL(entry).search);
        const exports = await mod.default();
        rhwp = exports.memory?.buffer?.byteLength ?? null;
      } catch { rhwp = null; }
    }
    let canvaskit = null;
    try {
      const ck = window.CanvasKit ?? window.__canvasKit;
      canvaskit = ck?.HEAPU8?.buffer?.byteLength ?? null;
    } catch { /* 없음 */ }
    return { rhwp, canvaskit };
  });
}

function processTreeBytes(rootPid) {
  if (process.platform !== 'win32') return null;
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-Command',
      'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,PrivatePageCount,WorkingSetSize | ConvertTo-Json -Compress'],
    { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * MiB });
    const rows = JSON.parse(out);
    const children = new Map();
    for (const row of rows) {
      if (!children.has(row.ParentProcessId)) children.set(row.ParentProcessId, []);
      children.get(row.ParentProcessId).push(row);
    }
    let priv = 0; let ws = 0; let count = 0; let renderer = 0;
    const queue = [rootPid];
    const seen = new Set();
    while (queue.length) {
      const pid = queue.shift();
      for (const row of children.get(pid) ?? []) {
        if (seen.has(row.ProcessId)) continue;
        seen.add(row.ProcessId);
        queue.push(row.ProcessId);
        if (!/electron/i.test(row.Name)) continue;
        priv += Number(row.PrivatePageCount); ws += Number(row.WorkingSetSize); count += 1;
        renderer = Math.max(renderer, Number(row.PrivatePageCount));
      }
    }
    const root = rows.find((row) => row.ProcessId === rootPid);
    if (root) { priv += Number(root.PrivatePageCount); ws += Number(root.WorkingSetSize); count += 1; }
    return { privateBytes: priv, workingSet: ws, processes: count, largestPrivate: renderer };
  } catch {
    return null;
  }
}

async function memorySnapshot(page, cdp, electronPid) {
  await cdp.send('HeapProfiler.collectGarbage');
  await cdp.send('HeapProfiler.collectGarbage');
  const heap = await cdp.send('Runtime.getHeapUsage');
  const wasm = await wasmMemoryBytes(page);
  const proc = processTreeBytes(electronPid);
  return {
    jsHeapUsed: heap.usedSize,
    jsHeapTotal: heap.totalSize,
    wasmRhwp: wasm.rhwp,
    wasmCanvasKit: wasm.canvaskit,
    processPrivate: proc?.privateBytes ?? null,
    processLargestPrivate: proc?.largestPrivate ?? null,
  };
}

// ── 문서 열기(설정 단계): 데스크톱 경로로 열어 최근 문서와 네이티브 북마크에 남긴다 ─────────
async function openNativePath(page, filePath) {
  return page.evaluate(async (target) => {
    const desktop = await import('/src/desktop-integration.ts');
    const opened = await desktop.openNativeDocumentAtPath(target);
    if (!opened?.ok) throw new Error(`open failed: ${JSON.stringify(opened)}`);
    const requestId = `bench-${Date.now()}`;
    await new Promise((resolve, reject) => {
      const off = window.__eventBus.on('open-document-bytes:done', (payload) => {
        if (payload?.requestId !== requestId) return;
        off();
        if (payload.ok) resolve(); else reject(new Error(payload.error || 'open failed'));
      });
      window.__eventBus.emit('open-document-bytes', {
        bytes: opened.bytes, fileName: opened.name, fileHandle: opened.handle, requestId,
        suppressDialogs: true, skipUnsavedGuard: true,
      });
    });
    return { documentId: window.__documentSessions.attached().documentId, fileName: window.__wasm.fileName };
  }, filePath);
}

/** 사이드바 문서 팔레트에서 문서를 고른다 — 사용자가 다른 문서로 옮기는 것과 같은 길이다. */
async function chooseFromPalette(page, fileName) {
  await page.evaluate(() => {
    const button = [...document.querySelectorAll('.ag-threads-open-doc')].find((el) => el.offsetParent !== null);
    if (!button) throw new Error('문서 열기 단추를 찾지 못했습니다');
    button.click();
  });
  const option = await page.waitForFunction((name) => {
    const surface = document.querySelector('.ag-rail-popover[aria-label="문서 열기"]');
    if (!surface) return null;
    return [...surface.querySelectorAll('[role="option"]')].find((el) => el.textContent?.includes(name)) ?? null;
  }, { timeout: 10000, polling: 16 }, fileName);
  const t0 = await page.evaluate((el) => {
    const t = performance.now();
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    el.click();
    return t;
  }, option);
  return t0;
}

async function waitSwitched(page, fileName, t0) {
  // 화면에 새 문서가 보이고, 로드 진행 문구가 사라지고, 버전 기록 준비(initializeDocument 의 끝)가 끝날 때까지.
  await page.waitForFunction((name, start) => {
    if (window.__wasm?.fileName !== name) return false;
    const msg = document.getElementById('sb-message')?.textContent ?? '';
    if (msg.includes('파일 로딩')) return false;
    return window.__benchLog.some((row) => row.label === 'versions.documentLoaded' && row.s > start && row.e > row.s);
  }, { timeout: 60000, polling: 'raf' }, fileName, t0);
  return page.evaluate(() => performance.now());
}

async function typeEdit(page) {
  await page.evaluate(() => {
    window.__inputHandler?.focus?.();
  });
  await page.keyboard.type('가');
  await page.waitForFunction(() => window.__documentState?.isDirty?.() === true, { timeout: 5000 }).catch(() => {});
}

function summarizePhases(rows, t0, tEnd) {
  const inWindow = rows.filter((row) => row.s >= t0 - 1 && row.s <= tEnd);
  const byLabel = {};
  for (const row of inWindow) {
    const d = row.e - row.s;
    const slot = byLabel[row.label] ??= { count: 0, total: 0, firstStart: Infinity, lastEnd: 0 };
    slot.count += 1;
    slot.total += d;
    slot.firstStart = Math.min(slot.firstStart, row.s - t0);
    slot.lastEnd = Math.max(slot.lastEnd, row.e - t0);
  }
  for (const value of Object.values(byLabel)) {
    value.total = +value.total.toFixed(1);
    value.firstStart = +value.firstStart.toFixed(1);
    value.lastEnd = +value.lastEnd.toFixed(1);
  }
  return byLabel;
}

function profileTop(profile, limit = 25) {
  const self = new Map();
  const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
  const dt = profile.timeDeltas;
  for (let i = 0; i < profile.samples.length; i += 1) {
    const node = nodes.get(profile.samples[i]);
    const cf = node.callFrame;
    const key = `${cf.functionName || '(anon)'} ${cf.url.replace(/^.*\/(src|pkg|node_modules)\//, '$1/')}:${cf.lineNumber + 1}`;
    self.set(key, (self.get(key) ?? 0) + (dt[i] ?? 0) / 1000);
  }
  return [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([k, v]) => [k, +v.toFixed(1)]);
}

async function main() {
  fs.mkdirSync(outDir, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rhwp-doc-switch-'));
  const docsDir = path.join(tmp, 'docs');
  fs.mkdirSync(docsDir);
  const docPaths = DOCS.map((name) => {
    const target = path.join(docsDir, name);
    fs.copyFileSync(path.join(repoRoot, 'samples', name), target);
    return target;
  });

  const vitePort = await findAvailablePort(7820);
  const debugPort = await findAvailablePort(9520);
  const viteUrl = `http://127.0.0.1:${vitePort}`;
  const configFile = writeViteConfig();
  console.log(`[bench] vite ${viteUrl}, debug ${debugPort}, tmp ${tmp}`);
  const vite = spawnLogged(process.execPath, [path.join(studioRoot, 'node_modules', 'vite', 'bin', 'vite.js'), '--config', configFile, '--host', '127.0.0.1', '--port', String(vitePort), '--strictPort'],
    studioRoot, { BROWSER: 'none' }, path.join(outDir, 'vite.log'));
  let electron = null;
  let browser = null;
  try {
    await waitForHttp(viteUrl, 'vite', vite, 90000);
    const env = { ...process.env, RHWP_DEV_URL: viteUrl, RHWP_DESKTOP_USER_DATA: path.join(tmp, 'user-data') };
    delete env.ELECTRON_RUN_AS_NODE;
    const electronLog = fs.openSync(path.join(outDir, 'electron.log'), 'w');
    electron = spawn(electronPath, [path.join(workspaceRoot, 'desktop', 'main.mjs'), `--remote-debugging-port=${debugPort}`, '--use-mock-keychain'],
      { cwd: workspaceRoot, env, stdio: ['ignore', electronLog, electronLog], windowsHide: true });
    const deadline = Date.now() + 60000;
    while (!browser && Date.now() < deadline) {
      try {
        browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${debugPort}`, defaultViewport: null, protocolTimeout: 180000 });
      } catch { await delay(200); }
    }
    if (!browser) throw new Error('Electron 에 붙지 못했습니다');
    const target = await browser.waitForTarget((t) => t.type() === 'page' && t.url().startsWith(viteUrl), { timeout: 90000 });
    const page = await target.page();
    page.on('pageerror', (error) => console.warn('[page error]', error.message));
    const ready = () => page.waitForFunction(() => window.__documentSessions?.attached?.()?.versions && window.__wasm,
      { timeout: 120000 });
    await ready();
    await page.evaluate(() => localStorage.setItem('rhwp-initial-setup', JSON.stringify({ version: 2, completed: true })));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await ready();
    await delay(1500);
    await page.evaluate(installInstrumentation);
    const cdp = await page.createCDPSession();
    await cdp.send('HeapProfiler.enable');

    const opened = [];
    for (const docPath of docPaths) {
      opened.push(await openNativePath(page, docPath));
      await delay(800);
    }
    console.log('[bench] opened', opened.map((doc) => doc.fileName).join(', '));
    console.log('[bench] engine write methods wrapped:', await page.evaluate(installEngineWriteProbe));
    await delay(2000);
    const baselineMemory = await memorySnapshot(page, cdp, electron.pid);
    if (PROFILE) await cdp.send('Profiler.enable');

    const results = [];
    let current = opened.length - 1;
    for (let i = 0; i < SWITCHES; i += 1) {
      const next = (current + 1) % opened.length;
      const name = opened[next].fileName;
      if (EDIT) await typeEdit(page);
      await page.evaluate(() => { window.__benchLog.length = 0; });
      if (PROFILE) await cdp.send('Profiler.start');
      const t0 = await chooseFromPalette(page, name);
      const tEnd = await waitSwitched(page, name, t0);
      const profile = PROFILE ? (await cdp.send('Profiler.stop')).profile : null;
      if (profile) {
        fs.mkdirSync(path.join(outDir, 'profiles'), { recursive: true });
        fs.writeFileSync(path.join(outDir, 'profiles', `${LABEL}-${i}.cpuprofile`), JSON.stringify(profile));
      }
      const rows = await page.evaluate(() => window.__benchLog.slice());
      const parse = rows.find((row) => /wasm\.(loadDocument|loadTrustedLocalFileOnce)/.test(row.label) && row.s > t0);
      // 새 문서의 첫 쪽을 그린 때 — 파싱 뒤 첫 쪽 렌더(레이어 트리 또는 캔버스 그리기)의 끝.
      const firstPaint = parse
        ? rows.filter((row) => /wasm\.(renderPageToCanvas|renderPageToCanvasFiltered|getPageLayerTree)$/.test(row.label) && row.s > parse.e)
          .map((row) => row.e - t0)[0] ?? null
        : null;
      await delay(1500); // 뒤따르는 작업(지연 글꼴·썸네일 등)이 가라앉게
      const memory = await memorySnapshot(page, cdp, electron.pid);
      const result = {
        index: i,
        from: opened[current].fileName,
        to: name,
        totalMs: +(tEnd - t0).toFixed(1),
        parseStartMs: parse ? +(parse.s - t0).toFixed(1) : null,
        parseMs: parse ? +(parse.e - parse.s).toFixed(1) : null,
        firstCanvasPaintMs: firstPaint === null ? null : +firstPaint.toFixed(1),
        phases: summarizePhases(rows, t0, tEnd),
        stacks: rows.filter((row) => row.stack && row.s >= t0).map((row) => ({ label: row.label, at: +(row.s - t0).toFixed(1), ms: +(row.e - row.s).toFixed(1), stack: row.stack })),
        memory,
        ...(profile ? { profileTop: profileTop(profile) } : {}),
      };
      results.push(result);
      console.log(`[bench] #${i} ${result.from} → ${result.to}: ${result.totalMs}ms (parse@${result.parseStartMs} +${result.parseMs}, paint@${result.firstCanvasPaintMs}) heap ${mib(memory.jsHeapUsed)}MiB wasm ${mib(memory.wasmRhwp)}MiB proc ${mib(memory.processPrivate)}MiB`);
      current = next;
    }

    const totals = results.map((r) => r.totalMs);
    const sorted = [...totals].sort((a, b) => a - b);
    const p90 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))];
    const last = results.at(-1)?.memory;
    const peak = (key) => Math.max(...results.map((r) => r.memory[key] ?? 0));
    const median = (values) => {
      const v = [...values].filter((x) => x != null).sort((a, b) => a - b);
      if (!v.length) return null;
      return v.length % 2 ? v[(v.length - 1) / 2] : +((v[v.length / 2 - 1] + v[v.length / 2]) / 2).toFixed(1);
    };
    const byTarget = {};
    for (const name of new Set(results.map((r) => r.to))) {
      const mine = results.filter((r) => r.to === name);
      byTarget[name] = { medianTotalMs: median(mine.map((r) => r.totalMs)), medianFirstPaintMs: median(mine.map((r) => r.firstCanvasPaintMs)), n: mine.length };
    }
    const summary = {
      label: LABEL, docs: DOCS, switches: SWITCHES, edit: EDIT,
      total: { ...stats(totals), p90, median: median(totals) },
      firstPaint: { median: median(results.map((r) => r.firstCanvasPaintMs)) },
      byTarget,
      memoryBaseline: baselineMemory,
      memoryAfter: last,
      memoryPeak: { jsHeapUsed: peak('jsHeapUsed'), wasmRhwp: peak('wasmRhwp'), processPrivate: peak('processPrivate') },
    };
    console.log('[bench] byTarget', JSON.stringify(byTarget));
    console.log('[bench] summary', JSON.stringify({
      ...summary.total, firstPaintMedian: summary.firstPaint.median,
      heapAfterMiB: mib(last?.jsHeapUsed), wasmAfterMiB: mib(last?.wasmRhwp), procAfterMiB: mib(last?.processPrivate),
      heapPeakMiB: mib(summary.memoryPeak.jsHeapUsed), wasmPeakMiB: mib(summary.memoryPeak.wasmRhwp), procPeakMiB: mib(summary.memoryPeak.processPrivate),
    }));
    fs.writeFileSync(OUT, JSON.stringify({ summary, results }, null, 2));
    console.log(`[bench] wrote ${OUT}`);
    if (KEEP) {
      console.log('[bench] --keep: Ctrl-C 로 끝냅니다');
      await new Promise(() => {});
    }
  } finally {
    try { await browser?.disconnect(); } catch { /* 끊김 */ }
    if (electron && electron.exitCode === null) {
      try { execFileSync('taskkill', ['/PID', String(electron.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch { /* 이미 끝남 */ }
    }
    await stopServer(vite);
    await delay(500);
    removeTempDir(tmp);
  }
}

await main();
