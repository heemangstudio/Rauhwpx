import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { downloadFilterLists, FILTER_CONFIG } from './browser-adblock-lists.mjs';

const require = createRequire(import.meta.url);
const INJECT = '@ghostery/adblocker/inject-cosmetic-filters';
const OBSERVE = '@ghostery/adblocker/is-mutation-observer-enabled';
const BUNDLE = new URL('./adblock/', import.meta.url);
function hostname(value) {
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.hostname : ''; } catch { return ''; }
}

/** 기존 보안 요청 핸들러 뒤에서 Ghostery를 호출하는 네이티브 브라우저 연결부. */
export class BrowserAdblock {
  constructor({ host, ipcMain, fetcher = fetch }) {
    this.host = host; this.ipcMain = ipcMain; this.fetcher = fetcher;
    this.directory = join(host.dataDir, 'adblock');
    this.settings = { enabled: true, pausedSites: [] };
    this.sessions = new Map();
    host.adblock = this;
    ipcMain.handle(INJECT, (event, url, message) => this.inject(event, url, message));
    ipcMain.handle(OBSERVE, event => !!this.guest(event) && this.active(event.sender.getURL()));
  }

  async load() {
    this.loading ??= (async () => {
      // ElectronBlocker는 공식 Electron 요청 변환과 cosmetic 구현을 제공한다.
      const previousWarningSetting = process.env.ELECTRON_DISABLE_SECURITY_WARNINGS;
      const { ElectronBlocker } = await import('@ghostery/adblocker-electron');
      if (previousWarningSetting === undefined) delete process.env.ELECTRON_DISABLE_SECURITY_WARNINGS;
      else process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = previousWarningSetting;
      this.Blocker = ElectronBlocker;
      try {
        const saved = JSON.parse(await readFile(join(this.directory, 'settings.json'), 'utf8'));
        this.settings = this.validate(saved);
      } catch {}
      const bundledMetadata = JSON.parse(await readFile(new URL('metadata.json', BUNDLE), 'utf8'));
      try {
        const cached = JSON.parse(await readFile(join(this.directory, 'filters.json'), 'utf8'));
        if (typeof cached.updatedAt !== 'string' || !Number.isFinite(Date.parse(cached.updatedAt)) || cached.updatedAt < bundledMetadata.updatedAt) throw new Error('Old cache');
        this.engine = ElectronBlocker.deserialize(Buffer.from(cached.engine, 'base64'));
        this.updatedAt = cached.updatedAt;
      } catch {
        this.engine = ElectronBlocker.deserialize(await readFile(new URL('engine.bin', BUNDLE)));
        this.updatedAt = bundledMetadata.updatedAt;
      }
    })();
    return this.loading;
  }

  async attach(session) {
    await this.load();
    if (this.sessions.has(session)) return;
    this.sessions.set(session, session.registerPreloadScript({ type: 'frame', filePath: require.resolve('@ghostery/adblocker-electron-preload') }));
    session.webRequest.onHeadersReceived((details, callback) => {
      try {
        if (this.shouldFilter(details)) this.engine.onHeadersReceived(details, callback);
        else callback({});
      } catch { callback({}); }
    });
  }

  active(url) { return this.settings.enabled && !!hostname(url) && !this.settings.pausedSites.includes(hostname(url)); }
  shouldFilter(details) {
    // 첫 탐색과 서비스 워커 요청도 referrer로 판정하고, 페이지 전체의 일시 중지는 최상위 사이트에 적용한다.
    const source = details.resourceType === 'mainFrame' ? details.url : details.webContents?.getURL() || details.referrer || details.url;
    return !!this.engine && this.active(source);
  }
  beforeRequest(details, callback) {
    if (!this.shouldFilter(details)) return callback({});
    this.engine.onBeforeRequest(details, callback);
  }
  guest(event) {
    if (event.sender?.isDestroyed() || !this.sessions.has(event.sender?.session) || event.senderFrame !== event.sender.mainFrame) return null;
    return [...this.host.tabs.values(), ...this.host.pendingTabs].find(tab => !tab.closing && tab.view.webContents === event.sender);
  }
  async inject(event, url, message) {
    if (!this.guest(event) || event.senderFrame.url !== url || !this.active(url) || !this.engine) return;
    // Ghostery의 preload와 cosmetic 주입을 그대로 사용한다. 설정 변경은 다음 탐색에 반영한다.
    const contents = event.sender;
    await this.engine.onInjectCosmeticFilters({ sender: {
      insertCSS: (...args) => contents.insertCSS(...args).catch(() => ''),
      executeJavaScript: (...args) => contents.executeJavaScript(...args).catch(() => {}),
    }, frameId: event.frameId, processId: event.processId }, url, message);
  }

  validate(value) {
    if (typeof value.enabled !== 'boolean' || !Array.isArray(value.pausedSites) || value.pausedSites.length > 256) throw new Error('Invalid ad blocking settings');
    const pausedSites = [...new Set(value.pausedSites.map(site => {
      if (typeof site !== 'string' || site.length > 253 || hostname(`https://${site}`) !== site) throw new Error('Invalid paused site');
      return site;
    }))];
    return { enabled: value.enabled, pausedSites };
  }
  async state() {
    await this.load();
    return { ...this.settings, pausedSites: [...this.settings.pausedSites], updatedAt: this.updatedAt,
      sites: [...new Set([...this.host.tabs.values()].filter(tab => !tab.closing && !tab.view.webContents?.isDestroyed()).map(tab => hostname(tab.view.webContents?.getURL())).filter(Boolean))] };
  }
  async configure(value) {
    await this.load();
    const settings = this.validate(value);
    const saving = (this.saving ?? Promise.resolve()).then(async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      await writeFile(join(this.directory, 'settings.json.tmp'), JSON.stringify(settings), { mode: 0o600 });
      await rename(join(this.directory, 'settings.json.tmp'), join(this.directory, 'settings.json'));
      this.settings = settings;
      return this.state();
    });
    this.saving = saving.catch(() => {});
    return saving;
  }
  async update() {
    if (this.updating) return this.updating;
    this.updating = (async () => {
      await this.load();
      const lists = await downloadFilterLists(this.fetcher);
      const engine = this.Blocker.parse(lists.join('\n'), FILTER_CONFIG);
      const updatedAt = new Date().toISOString();
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      await writeFile(join(this.directory, 'filters.json.tmp'), JSON.stringify({ updatedAt, engine: Buffer.from(engine.serialize()).toString('base64') }), { mode: 0o600 });
      await rename(join(this.directory, 'filters.json.tmp'), join(this.directory, 'filters.json'));
      this.engine = engine; this.updatedAt = updatedAt;
      return this.state();
    })().finally(() => { this.updating = null; });
    return this.updating;
  }
  dispose() {
    this.ipcMain.removeHandler(INJECT); this.ipcMain.removeHandler(OBSERVE);
    for (const [session, preloadId] of this.sessions) session.unregisterPreloadScript(preloadId);
    this.sessions.clear();
  }
}

export function registerBrowserAdblockIpc({ ipcMain, adblock, browserWindowForEvent }) {
  for (const [action, invoke] of Object.entries({ get: () => adblock.state(), configure: value => adblock.configure(value), update: () => adblock.update() })) {
    ipcMain.handle(`desktop:browser-adblock-${action}`, (event, value) => { browserWindowForEvent(event); return invoke(value); });
  }
}
