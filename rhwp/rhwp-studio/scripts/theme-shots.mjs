#!/usr/bin/env node
/**
 * 테마 프리셋 화면 찍기 — 프리셋·색 구성·강조색 하나로 편집기와 사이드바를 headless Chrome 으로 찍는다.
 *
 *   node scripts/theme-shots.mjs --serve --preset hacker --scheme dark --out /tmp/theme-shots/hacker-dark
 *   node scripts/theme-shots.mjs --studio http://127.0.0.1:7781 --sidebar http://127.0.0.1:7791 \
 *     --preset catppuccin --scheme light --accent '#8839ef' --out /tmp/theme-shots/catppuccin-light
 *
 * --serve 는 Studio(허브 없음)와 사이드바 미리보기를 빈 포트에 직접 띄우고 끝나면 내린다. 둘 다
 * 임시 Vite 캐시를 써서 같은 작업 트리의 다른 서버와 부딪히지 않는다. --studio/--sidebar 를 주면
 * 이미 떠 있는 서버를 쓰고, 둘 중 하나만 주면 그쪽만 찍는다.
 *
 * 찍는 화면: editor(샘플 문서와 리본), menu(보기 메뉴), dialog(글자 모양), find(찾기), home(문서 홈),
 * sidebar-chat(샘플 대화), sidebar-theme(설정 → 테마). 결과 경로와 실제로 적용된 상태를 JSON 으로 찍는다.
 * --only editor,menu 로 일부만 찍고, --css <파일> 로 시험 중인 스타일시트를 모든 페이지에 덧붙인다.
 * Chrome 은 CHROME_PATH 또는 PUPPETEER_EXECUTABLE_PATH, 없으면 설치된 Chrome 을 찾는다.
 */
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import puppeteer from 'puppeteer-core';
import { browserLaunchArgs, findBrowserExecutable } from '../tests/browser-support.ts';

const studioRoot = resolve(import.meta.dirname, '..');
const { values: args } = parseArgs({
  options: {
    studio: { type: 'string' },
    sidebar: { type: 'string' },
    serve: { type: 'boolean', default: false },
    preset: { type: 'string', default: 'default' },
    scheme: { type: 'string', default: 'light' },
    accent: { type: 'string' },
    out: { type: 'string' },
    doc: { type: 'string', default: 'biz_plan.hwp' },
    width: { type: 'string', default: '1440' },
    height: { type: 'string', default: '900' },
    only: { type: 'string' },
    css: { type: 'string' },
  },
});

function fail(message) {
  console.error(`theme-shots: ${message}`);
  process.exit(2);
}

if (!args.out) fail('--out <dir> 가 필요합니다 (/tmp 아래를 권합니다).');
if (!['light', 'dark', 'system'].includes(args.scheme)) fail('--scheme 은 light, dark, system 중 하나입니다.');
if (args.accent && !/^#[0-9a-f]{6}$/i.test(args.accent)) fail('--accent 는 #rrggbb 형식입니다.');
if (!args.serve && !args.studio && !args.sidebar) fail('--serve 또는 --studio/--sidebar 중 하나가 필요합니다.');
const executablePath = findBrowserExecutable();
if (!executablePath) fail('CHROME_PATH 에 Chrome 또는 Chromium 경로를 지정하세요.');

const outDir = resolve(args.out);
const only = args.only ? new Set(args.only.split(',')) : null;
const wants = (name) => !only || only.has(name);
const viewport = { width: Number(args.width) || 1440, height: Number(args.height) || 900, deviceScaleFactor: 1 };
const theme = { mode: args.scheme, preset: args.preset, accent: args.accent ?? null };
const extraCss = args.css ? await readFile(resolve(args.css), 'utf8') : null;
const servers = [];
const cacheDirs = [];

/** Vite JS API 로 서버 하나를 빈 포트에 띄운다. 캐시는 임시 폴더라 다른 서버와 공유하지 않는다. */
async function serve(configFile, env = {}) {
  Object.assign(process.env, env);
  const { createServer } = await import('vite');
  const cacheDir = await mkdtemp(resolve(tmpdir(), 'rhwp-theme-shots-vite-'));
  cacheDirs.push(cacheDir);
  const server = await createServer({
    cacheDir,
    configFile: resolve(studioRoot, configFile),
    server: { host: '127.0.0.1', port: 0, strictPort: false, open: false, hmr: false },
    logLevel: 'error',
  });
  await server.listen();
  servers.push(server);
  return `http://127.0.0.1:${server.httpServer.address().port}`;
}

/** 첫 실행 마법사를 끝난 것으로 두고 테마 설정을 미리 심는다. 모든 문서 로드 전에 돈다. */
function seedStorage(seed) {
  try {
    localStorage.setItem('rhwp-initial-setup', JSON.stringify({
      version: 2, completed: true, completedAt: new Date(0).toISOString(), deferred: false,
      themeStep: 'done', providerStep: 'configured', fontStep: 'skipped',
    }));
    const current = JSON.parse(localStorage.getItem('rhwp-settings') || '{}');
    localStorage.setItem('rhwp-settings', JSON.stringify({ ...current, version: 2, theme: seed }));
  } catch { /* 저장소가 없으면 URL·__theme 으로만 맞춘다 */ }
}

/** 화면에 실제로 걸린 테마 상태. 어긋나면 결과 JSON 에서 바로 보인다. */
function themeState(page) {
  return page.evaluate(() => {
    const root = document.documentElement;
    return {
      mode: root.dataset.themeMode ?? null,
      effective: root.dataset.themeEffective ?? null,
      preset: root.dataset.themePreset ?? null,
      accent: root.style.getPropertyValue('--theme-accent').trim() || null,
    };
  });
}

async function settle(page) {
  await page.evaluate(async () => {
    await document.fonts?.ready;
    await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
  });
}

/** 테마 API 가 있으면(새 빌드) 심은 값과 같게 한 번 더 건다. 예전 빌드에서는 모드만 건다. */
async function applyThemeApi(page) {
  await page.evaluate(async (seed) => {
    const api = window.__theme;
    if (!api) return;
    api.setPreset?.(seed.preset);
    api.setAccent?.(seed.accent);
    api.setThemeMode?.(seed.mode);
  }, theme);
}

async function newPage(browser) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.setViewport(viewport);
  const prefersDark = args.scheme === 'dark' ? 'dark' : 'light';
  await page.emulateMediaFeatures([
    { name: 'prefers-reduced-motion', value: 'reduce' },
    { name: 'prefers-color-scheme', value: prefersDark },
  ]);
  await page.evaluateOnNewDocument(seedStorage, theme);
  if (extraCss) {
    await page.evaluateOnNewDocument((css) => {
      document.addEventListener('DOMContentLoaded', () => {
        const style = document.createElement('style');
        style.dataset.themeShots = '';
        style.textContent = css;
        document.head.appendChild(style);
      });
    }, extraCss);
  }
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('dialog', (dialog) => void dialog.dismiss());
  return { context, page, errors };
}

async function shoot(page, name, shots, clip) {
  const path = resolve(outDir, `${name}.png`);
  await settle(page);
  await page.screenshot({ path, ...(clip ? { clip } : {}) });
  shots[name] = path;
}

async function studioShots(browser, origin, result) {
  const { context, page, errors } = await newPage(browser);
  try {
    await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForFunction(() => window.__wasm && window.__canvasView && window.__eventBus, { timeout: 60000 });
    await applyThemeApi(page);
    if (wants('home')) {
      // 홈은 나타날 때 투명도를 전이한다. 다 보일 때까지 기다린다.
      await page.waitForFunction(() => {
        const home = document.querySelector('.document-home.is-shown');
        return home && getComputedStyle(home).opacity === '1';
      }, { timeout: 15000 })
        .then(() => shoot(page, 'home', result.shots))
        .catch(() => result.skipped.push('home: 문서 홈이 열리지 않았습니다'));
    }
    await page.evaluate(async (fileName) => {
      const response = await fetch(`/samples/${fileName.split('/').map(encodeURIComponent).join('/')}`);
      if (!response.ok) throw new Error(`sample ${fileName}: HTTP ${response.status}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      const requestId = `theme-shots-${Date.now()}`;
      await new Promise((done, reject) => {
        const off = window.__eventBus.on('open-document-bytes:done', (payload) => {
          if (payload?.requestId !== requestId) return;
          off();
          if (payload.ok) done(); else reject(new Error(payload.error || 'open failed'));
        });
        window.__eventBus.emit('open-document-bytes', {
          bytes, fileName, requestId, suppressDialogs: true, skipUnsavedGuard: true,
        });
      });
    }, args.doc);
    await page.waitForFunction(() => window.__wasm.pageCount > 0 && document.querySelector('#scroll-content canvas')
      && !document.documentElement.classList.contains('document-home-open'), { timeout: 30000 });
    // 첫 쪽이 실제로 그려질 때까지(글자 픽셀) 기다린다.
    await page.waitForFunction(() => {
      const canvas = document.querySelector('#scroll-content canvas');
      if (!canvas?.width) return false;
      const copy = document.createElement('canvas');
      copy.width = canvas.width;
      copy.height = canvas.height;
      const ctx = copy.getContext('2d');
      ctx.drawImage(canvas, 0, 0);
      const { data } = ctx.getImageData(0, 0, copy.width, copy.height);
      let ink = 0;
      for (let i = 0; i < data.length; i += 4) if (data[i + 3] > 128 && data[i] + data[i + 1] + data[i + 2] < 384) ink += 1;
      return ink > 2000;
    }, { timeout: 30000, polling: 250 });
    // 깜박이는 캐럿이 비교를 흔들지 않게 숨긴다.
    await page.addStyleTag({ content: '.caret, .caret-composition { visibility: hidden !important; }' });
    result.studioTheme = await themeState(page);
    if (wants('editor')) await shoot(page, 'editor', result.shots);

    if (wants('menu')) {
      await page.evaluate(() => {
        const item = document.querySelector('#menu-bar .menu-item[data-menu="view"] .menu-title');
        item?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      });
      await page.waitForSelector('#menu-bar .menu-item.open', { timeout: 5000 });
      await shoot(page, 'menu', result.shots);
      await page.keyboard.press('Escape');
      await page.evaluate(() => document.querySelector('#menu-bar .menu-item.open')?.classList.remove('open'));
    }

    if (wants('dialog')) {
      // 글자 모양은 선택 범위가 있어야 열린다. 첫 쪽 본문을 눌러 캐럿을 두고 한 글자를 고른다.
      const box = await (await page.$('#scroll-content canvas')).boundingBox();
      await page.mouse.click(box.x + box.width / 2, box.y + Math.min(220, box.height / 3));
      await page.waitForFunction(() => document.activeElement === window.__inputHandler?.textarea, { timeout: 5000 }).catch(() => {});
      await page.keyboard.down('Shift');
      await page.keyboard.press('ArrowRight');
      await page.keyboard.up('Shift');
      const opened = await page.evaluate(() => {
        window.__dispatcher?.dispatch('format:char-shape');
        return Boolean(document.querySelector('.modal-overlay .dialog-wrap'));
      });
      if (opened) {
        await page.waitForSelector('.modal-overlay .dialog-wrap', { visible: true, timeout: 5000 });
        await shoot(page, 'dialog', result.shots);
        await page.keyboard.press('Escape');
        await page.waitForFunction(() => !document.querySelector('.modal-overlay .dialog-wrap'), { timeout: 5000 }).catch(() => {});
      } else {
        result.skipped.push('dialog: format:char-shape 명령을 실행하지 못했습니다');
      }
    }

    if (wants('find')) {
      const opened = await page.evaluate(() => {
        window.__dispatcher?.dispatch('edit:find');
        return Boolean(document.querySelector('.find-dialog'));
      });
      if (opened) {
        await page.waitForSelector('.find-dialog', { visible: true, timeout: 5000 });
        await shoot(page, 'find', result.shots);
        await page.keyboard.press('Escape');
      } else {
        result.skipped.push('find: edit:find 명령을 실행하지 못했습니다');
      }
    }
    if (errors.length) result.errors.push(...errors.map((message) => `studio: ${message}`));
  } finally {
    await context.close();
  }
}

async function sidebarShots(browser, origin, result) {
  const { context, page, errors } = await newPage(browser);
  const query = (extra) => {
    const params = new URLSearchParams({ theme: args.scheme, preset: args.preset, controls: '0', width: '480', ...extra });
    if (args.accent) params.set('accent', args.accent);
    return `${origin}/?${params}`;
  };
  try {
    if (wants('sidebar-chat')) {
      await page.goto(query({ reset: '1', chats: 'sample', scenario: 'chat' }), { waitUntil: 'networkidle0', timeout: 60000 });
      await page.waitForFunction(() => window.sidebarPreview
        && document.querySelector('#agent-sidebar')?.dataset.composerReady === 'true', { timeout: 30000 });
      await applyThemeApi(page);
      const sent = await page.evaluate(() => {
        const before = document.querySelectorAll('.ag-msg-assistant').length;
        const input = document.querySelector('.ag-input');
        input.value = '이 문서의 핵심 내용을 검토하고 개선해 주세요.';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.form?.requestSubmit();
        return before;
      });
      // 보낸 턴이 끝나고 답이 하나 더 그려질 때까지 기다린다.
      await page.waitForFunction((before) => !window.sidebarPreview.bridge.isTurnRunning()
        && document.querySelectorAll('.ag-msg-assistant').length > before, { timeout: 30000 }, sent);
      await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
      result.sidebarTheme = await themeState(page);
      await shoot(page, 'sidebar-chat', result.shots);
    }
    if (wants('sidebar-theme')) {
      await page.goto(query({ page: 'settings', destination: 'theme' }), { waitUntil: 'networkidle0', timeout: 60000 });
      await page.waitForFunction(() => window.sidebarPreview
        && document.querySelector('#ag-settings-panel')?.getAttribute('aria-hidden') === 'false', { timeout: 30000 });
      await applyThemeApi(page);
      result.sidebarTheme ??= await themeState(page);
      await shoot(page, 'sidebar-theme', result.shots);
    }
    if (errors.length) result.errors.push(...errors.map((message) => `sidebar: ${message}`));
  } finally {
    await context.close();
  }
}

const result = { preset: args.preset, scheme: args.scheme, accent: args.accent ?? null, outDir, shots: {}, skipped: [], errors: [] };
let browser;
try {
  await mkdir(outDir, { recursive: true });
  let studio = args.studio?.replace(/\/$/, '');
  let sidebar = args.sidebar?.replace(/\/$/, '');
  if (args.serve) {
    // 허브는 띄우지 않고, 허브 주소도 닫힌 포트로 둔다(사용자의 실제 허브에 붙지 않는다).
    studio ??= await serve('vite.config.ts', { RHWP_SKIP_AGENT_HUB: '1', RHWP_AGENT_PORT: '9' });
    sidebar ??= await serve('vite.sidebar.config.ts');
  }
  browser = await puppeteer.launch({ executablePath, headless: true, args: browserLaunchArgs() });
  if (studio && ['home', 'editor', 'menu', 'dialog', 'find'].some(wants)) await studioShots(browser, studio, result);
  if (sidebar && ['sidebar-chat', 'sidebar-theme'].some(wants)) await sidebarShots(browser, sidebar, result);
} finally {
  await browser?.close().catch(() => {});
  for (const server of servers) await server.close().catch(() => {});
  for (const dir of cacheDirs) await rm(dir, { recursive: true, force: true }).catch(() => {});
}
console.log(JSON.stringify(result, null, 2));
process.exit(result.errors.length ? 1 : 0);
