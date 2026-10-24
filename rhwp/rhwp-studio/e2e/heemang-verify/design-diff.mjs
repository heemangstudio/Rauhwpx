/**
 * 디자인 비교 — 기준선(heemangstudio/main, 구 엔진)과 후보(HeemangEngine)를 같은 뷰포트로 나란히 열고
 * 같은 UI 상태를 찍어 앱 크롬만 픽셀 비교한다. 문서 쪽 내용(#scroll-content 의 자손)은 엔진마다 다르게
 * 그려지므로 숨기고 비교한다.
 *
 * 실행: node rhwp/rhwp-studio/e2e/heemang-verify/design-diff.mjs [상태 이름 일부]
 * 결과: e2e/heemang-verify/out/design/<state>.{baseline,candidate,diff}.png, summary.json
 */
import fs from 'node:fs';
import path from 'node:path';

import * as L from './lib.mjs';

const DOC = process.env.HV_DESIGN_DOC
  || path.join(L.candidateRoot, '..', '..', 'heemang-cleanroom/parity-corpus/docs/d-05-mixed-korean-latin-108b1ff845b3.hwpx');
const filter = process.argv[2] ?? '';
const out = L.ensureOut('design');
for (const file of fs.readdirSync(out)) fs.rmSync(path.join(out, file));

const FREEZE_CSS = `
*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; }
#scroll-content * { visibility: hidden !important; }
`;

async function freeze(page) {
  await page.evaluate((css) => {
    let style = document.getElementById('hv-freeze');
    if (!style) { style = document.createElement('style'); style.id = 'hv-freeze'; document.head.append(style); }
    style.textContent = css;
    document.activeElement?.blur?.();
  }, FREEZE_CSS);
}

async function pressEscape(page, times = 2) {
  for (let i = 0; i < times; i += 1) { await page.keyboard.press('Escape'); await L.sleep(60); }
}

/** 메뉴·대화상자를 닫는다. Escape 로 닫히지 않은 모달 덮개는 지운다(다음 상태가 깨끗하게 시작하도록). */
async function reset(page) {
  await pressEscape(page);
  await page.evaluate(() => {
    document.querySelectorAll('.find-dialog .dialog-close').forEach((el) => { if (el.getClientRects().length) el.click(); });
    document.querySelectorAll('#rhwp-toast-container > *').forEach((el) => el.remove());
    document.querySelectorAll('#menu-bar .menu-item.open, #menu-bar .menu-item.active').forEach((el) => el.classList.remove('open', 'active'));
    document.querySelectorAll('.modal-overlay').forEach((el) => el.remove());
  });
  await page.mouse.move(5, 895);
}

async function openMenu(page, name) {
  await page.evaluate((menu) => {
    const item = document.querySelector(`#menu-bar .menu-item[data-menu="${menu}"] .menu-title`);
    item.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  }, name);
}

async function dispatch(page, cmd) {
  return page.evaluate((id) => {
    try { return window.__dispatcher.dispatch(id); } catch (error) { return `throw: ${error?.message}`; }
  }, cmd);
}

async function clickSelector(page, selector) {
  const ok = await page.evaluate((sel) => {
    const el = [...document.querySelectorAll(sel)].find((node) => {
      const r = node.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && r.right > 0 && r.left < innerWidth && getComputedStyle(node).visibility !== 'hidden';
    });
    if (!el) return false;
    el.click();
    return true;
  }, selector);
  return ok;
}

async function chooseMode(page, mode) {
  if (!(await clickSelector(page, '.ag-mode-btn'))) return 'no mode chip';
  await L.sleep(150);
  const ok = await page.evaluate((m) => {
    const items = [...document.querySelectorAll('#ag-mode-menu .ag-mode-item')];
    const labels = { chat: '채팅', plan: '플랜', agent: '에이전트', full: '전체' };
    const item = items.find((el) => el.textContent.trim().startsWith(labels[m]));
    if (!item) return false;
    item.click();
    return true;
  }, mode);
  await L.sleep(250);
  return ok ? true : 'mode item missing';
}

const MENUS = ['file', 'edit', 'view', 'insert', 'format', 'page', 'table', 'tool'];
const DIALOGS = [
  ['find-replace', 'edit:find-replace'],
  ['char-shape', 'format:char-shape'],
  ['para-shape', 'format:para-shape'],
  ['table-create', 'table:create'],
  ['page-setup', 'file:page-setup'],
  ['save-as', 'file:save-as'],
];

/** 상태 목록. run 은 상태를 만들고 메모(문자열)나 true 를 돌려준다. */
const STATES = [
  { id: 'home', before: 'home', run: async () => true },
  { id: 'settings', before: 'home', run: async (page) => {
    if (!(await clickSelector(page, '.dh-settings'))) return 'no home settings button (.dh-settings)';
    await L.sleep(600);
    return true;
  }, after: async (page) => { await pressEscape(page); await clickSelector(page, '.ag-settings-close'); } },
  { id: 'editor', run: async (page) => {
    // 첫 줄을 눌러 캐럿을 둔다.
    await page.mouse.click(300, 321);
    return true;
  } },
  ...MENUS.map((name) => ({ id: `menu-${name}`, run: async (page) => { await openMenu(page, name); await L.sleep(150); return true; } })),
  ...DIALOGS.map(([id, cmd]) => ({ id: `dialog-${id}`, run: async (page) => {
    // 첫 줄 글자 몇 개를 고른다(글자·문단 모양은 선택이 있어야 열린다).
    await page.mouse.click(300, 321);
    await L.sleep(100);
    for (let i = 0; i < 4; i += 1) await page.keyboard.press('ArrowRight', { delay: 0 }).catch(() => {});
    await page.keyboard.down('Shift');
    for (let i = 0; i < 4; i += 1) await page.keyboard.press('ArrowRight');
    await page.keyboard.up('Shift');
    const result = await dispatch(page, cmd);
    await L.sleep(400);
    const open = await page.evaluate(() => [...document.querySelectorAll('.modal-overlay, .find-dialog, [role="dialog"]')].filter((el) => el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden').length);
    return result === true && open ? true : `dispatch=${result}, dialogs=${open}`;
  } })),
  { id: 'sidebar-mode-menu', run: async (page) => {
    const ok = await clickSelector(page, '.ag-mode-btn');
    await L.sleep(200);
    return ok || 'no mode chip';
  } },
  ...['chat', 'plan', 'agent', 'full'].map((mode) => ({ id: `sidebar-${mode}`, run: async (page) => chooseMode(page, mode) })),
  { id: 'versions-changes', run: async (page) => {
    if (!(await clickSelector(page, '.ag-versions-btn'))) return 'no versions button (.ag-versions-btn hidden)';
    await L.sleep(400);
    // 변경 탭이 있으면 연다.
    await page.evaluate(() => {
      const tab = [...document.querySelectorAll('button')].find((b) => b.offsetParent && /^변경/.test(b.textContent.trim()));
      tab?.click();
    });
    await L.sleep(300);
    return true;
  }, after: async (page) => { await clickSelector(page, '.ag-versions-close'); } },
];

/** 차이 픽셀을 40px 격자로 묶어 덩어리 상자를 만든다. */
function diffRegions(mask, width, height, cell = 40) {
  const cols = Math.ceil(width / cell); const rows = Math.ceil(height / cell);
  const grid = new Uint8Array(cols * rows);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    if (mask[y * width + x]) grid[Math.floor(y / cell) * cols + Math.floor(x / cell)] = 1;
  }
  const seen = new Uint8Array(grid.length); const regions = [];
  for (let i = 0; i < grid.length; i += 1) {
    if (!grid[i] || seen[i]) continue;
    let minX = cols, minY = rows, maxX = 0, maxY = 0; const stack = [i]; seen[i] = 1;
    while (stack.length) {
      const j = stack.pop(); const cx = j % cols, cy = Math.floor(j / cols);
      minX = Math.min(minX, cx); maxX = Math.max(maxX, cx); minY = Math.min(minY, cy); maxY = Math.max(maxY, cy);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = cx + dx, ny = cy + dy; const k = ny * cols + nx;
        if (nx >= 0 && ny >= 0 && nx < cols && ny < rows && grid[k] && !seen[k]) { seen[k] = 1; stack.push(k); }
      }
    }
    regions.push({ x: minX * cell, y: minY * cell, w: (maxX - minX + 1) * cell, h: (maxY - minY + 1) * cell });
  }
  return regions.sort((a, b) => b.w * b.h - a.w * a.h).slice(0, 8);
}

/** 상자 안 가장 깊은 요소들을 사람이 읽을 셀렉터로 — 어느 모듈인지 찾는 단서. */
async function describeRegion(page, region) {
  return page.evaluate(({ x, y, w, h }) => {
    const describe = (el) => {
      if (!el) return null;
      const parts = [];
      for (let node = el; node && node !== document.body && parts.length < 3; node = node.parentElement) {
        parts.unshift(`${node.tagName.toLowerCase()}${node.id ? `#${node.id}` : ''}${[...node.classList].slice(0, 2).map((c) => `.${c}`).join('')}`);
      }
      return parts.join(' > ');
    };
    const seen = new Set();
    for (const [px, py] of [[x + w / 2, y + h / 2], [x + 8, y + 8], [x + w - 8, y + h - 8]]) {
      const d = describe(document.elementFromPoint(Math.min(px, innerWidth - 1), Math.min(py, innerHeight - 1)));
      if (d) seen.add(d);
    }
    return [...seen];
  }, region);
}

function readPng(file) { return L.PNG.sync.read(fs.readFileSync(file)); }

async function compare(id, pages, notes) {
  const files = {};
  for (const [name, page] of Object.entries(pages)) {
    await freeze(page);
    files[name] = path.join(out, `${id}.${name}.png`);
    await page.screenshot({ path: files[name] });
  }
  const a = readPng(files.baseline); const b = readPng(files.candidate);
  const { width, height } = a;
  const diff = new L.PNG({ width, height });
  const count = L.pixelmatch(a.data, b.data, diff.data, width, height, { threshold: 0.1, includeAA: false, alpha: 0.25 });
  const mask = new Uint8Array(width * height);
  for (let i = 0; i < mask.length; i += 1) {
    if (diff.data[i * 4] === 255 && diff.data[i * 4 + 1] === 0 && diff.data[i * 4 + 2] === 0) mask[i] = 1;
  }
  let regions = [];
  if (count > 0) {
    files.diff = path.join(out, `${id}.diff.png`);
    fs.writeFileSync(files.diff, L.PNG.sync.write(diff));
    // 기준선 | 후보 | 차이 를 한 장으로
    const sbs = new L.PNG({ width: width * 3, height });
    for (const [index, image] of [a, b, diff].entries()) L.PNG.bitblt(image, sbs, 0, 0, width, height, width * index, 0);
    files.sideBySide = path.join(out, `${id}.sbs.png`);
    fs.writeFileSync(files.sideBySide, L.PNG.sync.write(sbs));
    regions = diffRegions(mask, width, height);
    for (const region of regions) {
      region.baselineAt = await describeRegion(pages.baseline, region);
      region.candidateAt = await describeRegion(pages.candidate, region);
    }
  } else {
    fs.rmSync(files.baseline); fs.rmSync(files.candidate);
  }
  // 다음 상태가 문서를 다시 보도록 숨김을 풀어 둔다.
  for (const page of Object.values(pages)) await page.evaluate(() => { document.getElementById('hv-freeze')?.remove(); });
  const ratio = count / (width * height);
  return { state: id, diffPixels: count, ratio: Number(ratio.toFixed(5)), match: count === 0, notes, regions, files: count ? files : undefined };
}

const started = Date.now();
const apps = {};
let browser;
const summary = { doc: DOC, viewport: L.VIEWPORT, candidateQuery: L.CANDIDATE_QUERY, states: [], logs: {} };
try {
  if (!L.pkgStatus(L.candidateRoot)) console.warn('warning: candidate has no rhwp/pkg — Studio still imports @wasm/rhwp.js and will not boot');
  [apps.baseline, apps.candidate, browser] = await Promise.all([
    L.startApp('baseline', L.baselineRoot, 6400),
    L.startApp('candidate', L.candidateRoot, 6500),
    L.launchBrowser(),
  ]);
  const sessions = {};
  for (const name of ['baseline', 'candidate']) sessions[name] = await L.newPage(browser);
  const pages = { baseline: sessions.baseline.page, candidate: sessions.candidate.page };
  await Promise.all(Object.entries(pages).map(([name, page]) => L.loadApp(page, apps[name].url)));
  // 부팅 화면이 사라질 때까지
  await Promise.all(Object.values(pages).map((page) => L.waitFor(page, 'boot screen gone', () => {
    const boot = document.getElementById('boot-screen');
    return !boot || boot.hidden || getComputedStyle(boot).display === 'none' || getComputedStyle(boot).opacity === '0';
  }).catch(() => {})));
  await L.sleep(500);

  let docOpened = false;
  for (const state of STATES) {
    if (state.before !== 'home' && !docOpened) {
      await Promise.all(Object.values(pages).map((page) => L.openDocumentFile(page, DOC)));
      await L.sleep(600);
      docOpened = true;
    }
    if (filter && !state.id.includes(filter)) continue;
    const notes = {};
    for (const [name, page] of Object.entries(pages)) {
      try { const r = await state.run(page); if (r !== true) notes[name] = r; } catch (error) { notes[name] = `error: ${error.message}`; }
    }
    await L.sleep(200);
    const row = await compare(state.id, pages, notes);
    summary.states.push(row);
    console.log(`${row.match ? 'same' : 'DIFF'}  ${state.id.padEnd(22)} ${String(row.diffPixels).padStart(7)} px ${Object.keys(notes).length ? JSON.stringify(notes) : ''}`);
    for (const page of Object.values(pages)) {
      try { await state.after?.(page); } catch { /* 다음 reset 이 정리 */ }
      await reset(page);
    }
  }
  for (const [name, session] of Object.entries(sessions)) {
    summary.logs[name] = { pageErrors: session.log.pageErrors, console: session.log.console.slice(0, 40), rhwpEngineRequests: L.rhwpEngineRequests(session.log) };
  }
} finally {
  await browser?.close().catch(() => {});
  await Promise.all(Object.values(apps).map((app) => app.stop().catch(() => {})));
}
summary.seconds = Math.round((Date.now() - started) / 100) / 10;
summary.differing = summary.states.filter((s) => !s.match).map((s) => s.state);
fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(`\n${summary.differing.length}/${summary.states.length} states differ (${summary.seconds} s) → ${path.join(out, 'summary.json')}`);
process.exit(0);
