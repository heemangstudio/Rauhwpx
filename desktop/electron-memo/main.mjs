/**
 * Electron memo layer — main-process side. Load it in development builds only.
 * Source of truth: ~/.agents/skills/electron-memo-loop/assets/memo-layer (projects keep a copy).
 *
 * The user presses Ctrl+G in the app, clicks an element and writes a memo. This module
 * stores each memo as its own JSON file next to a window screenshot, an element close-up,
 * the page's recent console warnings/errors and build info. An agent reads the store,
 * makes the change, and marks the memo resolved with scripts/memo.mjs; the app sees the
 * change immediately through a directory watcher.
 *
 * Store layout (storeDir):
 *   memos/<id>.json     one memo (schema "electron-memo/1")
 *   shots/<id>.png      full window when the memo was saved
 *   shots/<id>-crop.png the element plus a margin
 *   draft.json          the memo being typed, so a reload or crash does not lose it
 */

import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { watch } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { BrowserWindow, webContents as webContentsModule } from 'electron';

export const MEMO_SCHEMA = 'electron-memo/1';
const run = promisify(execFile);
const MAX_COMMENT_LENGTH = 4000;
const CROP_MARGIN = 48;
const CONSOLE_LIMIT = 40;
const WATCH_DEBOUNCE_MS = 120;
const LEVELS = ['verbose', 'info', 'warning', 'error'];

function memoId(now) {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  return `${stamp}-${randomBytes(2).toString('hex')}`;
}

function clip(text, max) {
  const value = String(text ?? '');
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/**
 * @param {object} options
 * @param {import('electron').App} options.app
 * @param {import('electron').Session} options.session  session the app windows use
 * @param {import('electron').IpcMain} options.ipcMain
 * @param {string} options.storeDir                      e.g. <repo>/.electron-memos
 * @param {(url: string) => boolean} options.isTrustedUrl renderer URLs allowed to talk to the layer
 * @param {'en'|'ko'} [options.locale]
 * @param {string} [options.repoRoot]                    adds git branch/commit to each memo
 */
export async function installMemoLayer({
  app, session, ipcMain, storeDir, isTrustedUrl, locale = 'en', repoRoot = null, logger = console,
}) {
  const memosDir = join(storeDir, 'memos');
  const shotsDir = join(storeDir, 'shots');
  const draftFile = join(storeDir, 'draft.json');
  await mkdir(memosDir, { recursive: true });
  await mkdir(shotsDir, { recursive: true });

  // One write at a time inside this process. The agent CLI writes whole files atomically too.
  let queue = Promise.resolve();
  const serial = (task) => {
    const next = queue.then(task, task);
    queue = next.catch(() => {});
    return next;
  };

  async function writeJson(file, value) {
    const temp = `${file}.${process.pid}.tmp`;
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`);
    await rename(temp, file);
  }

  async function readMemos() {
    const names = (await readdir(memosDir)).filter((name) => name.endsWith('.json'));
    const memos = [];
    for (const name of names) {
      try {
        const memo = JSON.parse(await readFile(join(memosDir, name), 'utf8'));
        if (memo?.id) memos.push(memo);
      } catch (error) {
        if (error?.code !== 'ENOENT') logger.warn?.(`[memo] skipped ${name}: ${error.message}`);
      }
    }
    return memos.sort((a, b) => (a.number ?? 0) - (b.number ?? 0));
  }

  async function readDraft() {
    try {
      return JSON.parse(await readFile(draftFile, 'utf8'));
    } catch {
      return null;
    }
  }

  async function buildInfo() {
    if (!repoRoot) return null;
    const git = async (...args) => (await run('git', ['-C', repoRoot, ...args], { timeout: 3000 })).stdout.trim();
    try {
      const [branch, commit, status] = await Promise.all([
        git('rev-parse', '--abbrev-ref', 'HEAD'),
        git('rev-parse', '--short', 'HEAD'),
        git('status', '--porcelain', '--untracked-files=no'),
      ]);
      return { checkout: repoRoot, branch, commit, uncommittedFiles: status ? status.split('\n').length : 0 };
    } catch {
      return { checkout: repoRoot };
    }
  }

  // ── Console capture: the last warnings/errors of each renderer travel with its memos.
  const consoleLogs = new Map();
  const record = (contents, entry) => {
    const list = consoleLogs.get(contents.id) ?? [];
    list.push({ at: new Date().toISOString(), ...entry, message: clip(entry.message, 1200) });
    if (list.length > CONSOLE_LIMIT) list.splice(0, list.length - CONSOLE_LIMIT);
    consoleLogs.set(contents.id, list);
  };
  const observe = (contents) => {
    contents.on('console-message', (event, legacyLevel, legacyMessage, legacyLine, legacySource) => {
      // Electron ≥ 35 passes one event object; older versions pass positional arguments.
      const level = typeof event?.level === 'string' ? event.level : LEVELS[legacyLevel] ?? 'info';
      if (level !== 'warning' && level !== 'error') return;
      record(contents, {
        level,
        message: event?.message ?? legacyMessage,
        source: event?.sourceId ?? legacySource ?? null,
        line: event?.lineNumber ?? legacyLine ?? null,
      });
    });
    contents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
      if (isMainFrame) record(contents, { level: 'error', message: `did-fail-load ${code} ${description} ${url}` });
    });
    contents.on('render-process-gone', (_event, details) => record(contents, { level: 'error', message: `render-process-gone ${details.reason}` }));
    contents.on('preload-error', (_event, path, error) => record(contents, { level: 'error', message: `preload-error ${path}: ${error?.message ?? error}` }));
    contents.once('destroyed', () => consoleLogs.delete(contents.id));
  };
  webContentsModule.getAllWebContents().forEach(observe);
  app.on('web-contents-created', (_event, contents) => observe(contents));

  async function capture(contents, id, rect) {
    const screenshot = `shots/${id}.png`;
    await writeFile(join(storeDir, screenshot), (await contents.capturePage()).toPNG());
    if (!rect) return { screenshot, crop: null };
    // capturePage takes device-independent pixels; the renderer reports CSS pixels.
    const zoom = contents.getZoomFactor();
    const [viewWidth, viewHeight] = BrowserWindow.fromWebContents(contents)?.getContentSize() ?? [Infinity, Infinity];
    const x = Math.max(0, Math.floor((rect.x - CROP_MARGIN) * zoom));
    const y = Math.max(0, Math.floor((rect.y - CROP_MARGIN) * zoom));
    const width = Math.min(viewWidth - x, Math.ceil((rect.width + CROP_MARGIN * 2) * zoom));
    const height = Math.min(viewHeight - y, Math.ceil((rect.height + CROP_MARGIN * 2) * zoom));
    if (width <= 0 || height <= 0) return { screenshot, crop: null };
    const crop = `shots/${id}-crop.png`;
    await writeFile(join(storeDir, crop), (await contents.capturePage({ x, y, width, height })).toPNG());
    return { screenshot, crop };
  }

  const senderUrl = (event) => event.senderFrame?.url || event.sender.getURL();
  const guard = (handler) => (event, ...args) => {
    if (!isTrustedUrl(senderUrl(event))) throw new Error('Untrusted renderer');
    return handler(event, ...args);
  };

  async function updateMemo(id, change) {
    const file = join(memosDir, `${id}.json`);
    const memo = JSON.parse(await readFile(file, 'utf8'));
    const next = change(memo);
    next.updatedAt = new Date().toISOString();
    await writeJson(file, next);
    return next;
  }

  ipcMain.handle('memo:config', guard(async () => ({ locale, memos: await readMemos(), draft: await readDraft() })));
  ipcMain.handle('memo:list', guard(() => readMemos()));

  ipcMain.handle('memo:add', guard((event, payload) => serial(async () => {
    const comment = String(payload?.comment ?? '').trim().slice(0, MAX_COMMENT_LENGTH);
    if (!comment) throw new Error('Empty memo');
    const now = new Date();
    const id = memoId(now);
    const memos = await readMemos();
    const number = memos.reduce((max, memo) => Math.max(max, memo.number ?? 0), 0) + 1;
    const shots = await capture(event.sender, id, payload.target?.rect ?? null);
    const memo = {
      schema: MEMO_SCHEMA,
      id,
      number,
      status: 'open',
      priority: payload.priority === 'now' ? 'now' : 'queued',
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      comment,
      ...shots,
      target: payload.target ?? null,
      view: payload.view ?? null,
      console: [...(consoleLogs.get(event.sender.id) ?? [])],
      build: await buildInfo(),
      resolution: null,
      history: [{ at: now.toISOString(), by: 'user', status: 'open', note: payload.priority === 'now' ? 'fix now' : null }],
    };
    await writeJson(join(memosDir, `${id}.json`), memo);
    await rm(draftFile, { force: true });
    return memo;
  })));

  ipcMain.handle('memo:set-priority', guard((_event, id, priority) => serial(() => updateMemo(id, (memo) => ({
    ...memo,
    priority: priority === 'now' ? 'now' : 'queued',
    history: [...(memo.history ?? []), { at: new Date().toISOString(), by: 'user', status: memo.status, note: priority === 'now' ? 'fix now' : 'queued' }],
  })))));

  ipcMain.handle('memo:remove', guard((_event, id) => serial(async () => {
    const file = join(memosDir, `${id}.json`);
    let memo;
    try {
      memo = JSON.parse(await readFile(file, 'utf8'));
    } catch {
      return false;
    }
    await rm(file, { force: true });
    await Promise.all([memo.screenshot, memo.crop].filter(Boolean).map((path) => rm(join(storeDir, path), { force: true })));
    return true;
  })));

  ipcMain.handle('memo:draft', guard((_event, draft) => serial(async () => {
    if (!draft || !String(draft.text ?? '').trim()) await rm(draftFile, { force: true });
    else await writeJson(draftFile, { ...draft, savedAt: new Date().toISOString() });
    return true;
  })));

  // ── Push: any change in memos/ (from the app or the agent CLI) reaches every trusted window.
  let lastStatus = new Map();
  let pushTimer = null;
  const push = async () => {
    pushTimer = null;
    const memos = await readMemos();
    const events = [];
    for (const memo of memos) {
      const before = lastStatus.get(memo.id);
      if (before && before !== memo.status) events.push({ id: memo.id, number: memo.number, status: memo.status, note: memo.resolution?.note ?? null });
    }
    lastStatus = new Map(memos.map((memo) => [memo.id, memo.status]));
    for (const window of BrowserWindow.getAllWindows()) {
      const contents = window.webContents;
      if (!contents.isDestroyed() && isTrustedUrl(contents.getURL())) contents.send('memo:changed', { memos, events });
    }
  };
  lastStatus = new Map((await readMemos()).map((memo) => [memo.id, memo.status]));
  const watcher = watch(memosDir, () => {
    if (pushTimer) clearTimeout(pushTimer);
    pushTimer = setTimeout(() => void push().catch((error) => logger.warn?.(`[memo] push failed: ${error.message}`)), WATCH_DEBOUNCE_MS);
  });
  app.once('will-quit', () => watcher.close());

  const preloadPath = join(dirname(fileURLToPath(import.meta.url)), 'preload.cjs');
  if (typeof session.registerPreloadScript === 'function') {
    session.registerPreloadScript({ type: 'frame', id: 'electron-memo-layer', filePath: preloadPath });
  } else {
    session.setPreloads([...session.getPreloads(), preloadPath]);
  }
  logger.log?.(`[memo] Ctrl+G to leave a memo, Ctrl+Shift+G for the list · store ${storeDir}`);
  return { storeDir };
}
