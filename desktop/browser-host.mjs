import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrivateBrowserCdp } from './browser-cdp.mjs';

const GUEST_PRELOAD = fileURLToPath(new URL('./browser-guest-preload.cjs', import.meta.url));
const POPOUT_PRELOAD = fileURLToPath(new URL('./browser-popout-preload.cjs', import.meta.url));
const POPOUT_URL = new URL('./browser-popout.html', import.meta.url).href;
const MAX_NATIVE_TABS = 64;
const ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,159}$/;

export function browserNavigationUrl(value) {
  if (value === 'about:blank') return value;
  const url = new URL(String(value));
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Browser navigation requires an HTTP or HTTPS URL without credentials');
  }
  return url.href;
}

export function browserViewBounds(bounds, window) {
  const area = window.getContentBounds();
  if (!bounds || !['x', 'y', 'width', 'height'].every((key) => Number.isFinite(bounds[key]))) {
    throw new Error('Browser presentation bounds are invalid');
  }
  const x = Math.max(0, Math.min(area.width, Math.round(bounds.x)));
  const y = Math.max(0, Math.min(area.height, Math.round(bounds.y)));
  return { x, y, width: Math.max(0, Math.min(area.width - x, Math.round(bounds.width))), height: Math.max(0, Math.min(area.height - y, Math.round(bounds.height))) };
}

async function privateDirectory(dir) {
  const absolute = resolve(dir);
  await mkdir(absolute, { recursive: true, mode: 0o700 });
  const info = await lstat(absolute);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Browser profile must be a private regular directory');
  if (process.platform !== 'win32') await chmod(absolute, 0o700);
  return realpath(absolute);
}

export class OwnedBrowserHost {
  constructor({ BrowserWindow, WebContentsView, electronSession, dataDir, getWindowForSession, onEvent = () => {} }) {
    this.BrowserWindow = BrowserWindow;
    this.WebContentsView = WebContentsView;
    this.electronSession = electronSession;
    this.dataDir = resolve(dataDir);
    this.getWindowForSession = getWindowForSession;
    this.onEvent = onEvent;
    this.tabs = new Map();
    this.aliases = new Map();
    this.popouts = new Map();
    this.downloads = new Map();
    this.downloadBehavior = 'deny';
    this.downloadPath = null;
    this.owner = null;
    this.lastOwner = null;
    this.proxy = null;
    this.session = null;
    this.startPromise = null;
    this.releasePromise = null;
    this.resetPromise = null;
    this.generation = randomUUID();
    this.cdp = new PrivateBrowserCdp({ host: this });
  }

  async start({ profileDir, proxy }, owner) {
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.startOwned({ profileDir, proxy }, owner);
    try { return await this.startPromise; } finally { this.startPromise = null; }
  }

  async startOwned({ profileDir, proxy }, owner) {
    await this.releasePromise;
    await this.resetPromise;
    const expected = join(this.dataDir, 'browser', 'native-profile');
    if (profileDir && resolve(profileDir) !== expected) throw new Error('Browser runtime requested a profile outside its owned directory');
    if (!proxy || typeof proxy.server !== 'string' || !proxy.username || !proxy.password) {
      throw new Error('Native browser requires its guarded authenticated proxy');
    }
    const proxyUrl = new URL(proxy.server);
    if (proxyUrl.protocol !== 'http:' || proxyUrl.hostname !== '127.0.0.1' || !proxyUrl.port || proxyUrl.username || proxyUrl.password) {
      throw new Error('Native browser proxy must be an owned loopback HTTP endpoint');
    }
    await privateDirectory(this.dataDir);
    const canonicalProfile = await privateDirectory(expected);
    if (!this.session) {
      this.session = this.electronSession.fromPath(canonicalProfile);
      this.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
      this.session.setPermissionCheckHandler(() => false);
      this.session.webRequest.onBeforeRequest((details, callback) => {
        try {
          const protocol = new URL(details.url).protocol;
          callback({ cancel: !this.proxy || !['http:', 'https:', 'ws:', 'wss:', 'blob:'].includes(protocol) });
        } catch { callback({ cancel: true }); }
      });
      this.session.on('will-download', (event, item, contents) => this.willDownload(event, item, contents));
    }
    if (this.owner && this.owner !== owner) await this.cdp.close();
    this.owner = owner;
    this.lastOwner = owner;
    this.proxy = { ...proxy, host: proxyUrl.hostname, port: Number(proxyUrl.port) };
    await this.session.setProxy({ proxyRules: proxy.server, proxyBypassRules: '<-loopback>' });
    await this.session.closeAllConnections();
    for (const tab of this.tabs.values()) {
      if (!this.cdp.tabs.has(tab.targetId) && !tab.view.webContents.isDestroyed()) {
        await this.cdp.add(tab);
        await this.viewport(tab, tab.viewport ?? { width: 1280, height: 800 });
      }
    }
    const endpointURL = await this.cdp.listen();
    return { endpointURL, native: true, generation: this.generation, signInSupport: 'full-browser-required' };
  }

  async createTab({ url = 'about:blank', parent = null } = {}) {
    if (!this.owner || !this.proxy) throw new Error('Native browser runtime is disconnected');
    if (this.tabs.size >= MAX_NATIVE_TABS) throw new Error('Native browser tab limit reached');
    const destination = browserNavigationUrl(url);
    const view = new this.WebContentsView({ webPreferences: {
      session: this.session, preload: GUEST_PRELOAD, sandbox: true,
      contextIsolation: true, nodeIntegration: false, webSecurity: true,
      webviewTag: false, allowRunningInsecureContent: false, devTools: false,
    } });
    view.setBounds({ x: 0, y: 0, width: 1280, height: 800 });
    view.setVisible(false);
    const contents = view.webContents;
    contents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
    const tab = { view, targetId: null, tabId: null, sessionId: null, chatId: null, windowId: null,
      placement: null, human: false, interactive: false, navigationEpoch: 0,
      frameId: null, lastError: null, crashed: false, openerTargetId: parent?.targetId };
    contents.setWindowOpenHandler(({ url: popupUrl }) => {
      try {
        const popup = browserNavigationUrl(popupUrl);
        void this.createTab({ url: popup, parent: tab }).catch(() => {});
      } catch {}
      return { action: 'deny' };
    });
    contents.on('will-navigate', (event, rawUrl) => {
      try { browserNavigationUrl(rawUrl); } catch { event.preventDefault(); }
    });
    contents.on('will-redirect', (event, rawUrl) => {
      try { browserNavigationUrl(rawUrl); } catch { event.preventDefault(); }
    });
    contents.on('login', (event, _details, auth, callback) => {
      event.preventDefault();
      if (auth.isProxy && this.proxy && auth.host === this.proxy.host && auth.port === this.proxy.port) {
        callback(this.proxy.username, this.proxy.password);
      } else callback();
    });
    const blockHumanInput = (event) => {
      if ((!tab.human || !tab.interactive) && !tab.automationInputDepth) event.preventDefault();
    };
    contents.on('before-input-event', blockHumanInput);
    contents.on('before-mouse-event', blockHumanInput);
    contents.on('devtools-opened', () => {
      // DevTools takes the same debugger. Close it rather than silently hand
      // automation to a different session or expose other app contents.
      contents.closeDevTools();
      this.emit(tab, 'debugger-conflict', { message: 'Close browser automation before opening developer tools.' });
    });
    for (const event of ['did-start-loading', 'did-stop-loading', 'page-title-updated']) contents.on(event, () => this.emit(tab, 'state'));
    contents.on('did-navigate', () => { tab.navigationEpoch += 1; tab.lastError = null; this.emit(tab, 'navigation'); });
    contents.on('did-navigate-in-page', (_event, _url, isMainFrame) => { if (isMainFrame) { tab.navigationEpoch += 1; this.emit(tab, 'navigation'); } });
    contents.on('did-fail-load', (_event, code, description, _url, mainFrame) => {
      if (mainFrame && code !== -3) { tab.lastError = description; this.emit(tab, 'load-failed'); }
    });
    contents.on('render-process-gone', (_event, details) => { tab.crashed = true; this.emit(tab, 'crashed', { reason: details.reason }); });
    contents.once('destroyed', () => { this.cdp.remove(tab.targetId); this.tabs.delete(tab.targetId); if (tab.tabId) this.aliases.delete(tab.tabId); this.emit(tab, 'closed'); });
    try {
      await contents.loadURL('about:blank');
      await this.cdp.add(tab);
      this.tabs.set(tab.targetId, tab);
      await this.viewport(tab, { width: 1280, height: 800 });
      const tree = await contents.debugger.sendCommand('Page.getFrameTree');
      tab.frameId = tree.frameTree.frame.id;
      contents.debugger.on('message', (_event, method, params) => {
        if (method === 'Page.frameNavigated' && !params.frame?.parentId) tab.frameId = params.frame.id;
      });
      if (parent?.tabId) this.emit(parent, 'popup', { nativeTargetId: tab.targetId });
      if (destination !== 'about:blank') void contents.loadURL(destination).catch(() => {});
      return tab;
    } catch (error) {
      if (!contents.isDestroyed()) contents.close();
      throw error;
    }
  }

  tab(id) {
    const tab = this.tabs.get(id) ?? this.tabs.get(this.aliases.get(id));
    if (!tab?.view.webContents || tab.view.webContents.isDestroyed()) throw new Error('Native browser tab is unavailable');
    return tab;
  }

  bind({ targetId, tabId, sessionId, chatId }) {
    if (!ID_RE.test(String(tabId)) || !ID_RE.test(String(sessionId))) throw new Error('Native browser binding is invalid');
    const window = this.getWindowForSession(sessionId);
    if (!window || window.isDestroyed()) throw new Error('Native browser binding has no owning editor window');
    const tab = this.tab(targetId);
    const occupied = this.aliases.get(tabId);
    if (occupied && occupied !== targetId) throw new Error('Native browser tab binding is already owned');
    if (tab.windowId && tab.windowId !== window.id) throw new Error('Native browser tab belongs to another editor window');
    if (tab.tabId && tab.tabId !== tabId) this.aliases.delete(tab.tabId);
    Object.assign(tab, { tabId, sessionId, chatId, windowId: window.id });
    this.aliases.set(tabId, targetId);
    this.emit(tab, 'bound');
    return this.state(tab);
  }

  ownedTab(id, window) {
    const tab = this.tab(id);
    if (!tab.tabId || tab.windowId !== window.id) throw new Error('Native browser tab belongs to another editor window');
    return tab;
  }

  async viewport(tab, { width, height }) {
    if (width <= 0 || height <= 0) return;
    if (tab.viewport?.width === width && tab.viewport?.height === height) return;
    // Unparented native views otherwise report a zero viewport. Keep a useful
    // page size while hidden, then match the actual projection when attached.
    await tab.view.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride', {
      width, height, deviceScaleFactor: 0, mobile: false,
    });
    tab.viewport = { width, height };
  }

  state(tab) {
    const contents = tab.view.webContents;
    const alive = contents && !contents.isDestroyed();
    return { tabId: tab.tabId, nativeTargetId: tab.targetId, native: true,
      generation: this.generation, navigationEpoch: tab.navigationEpoch,
      url: alive ? contents.getURL() : '', title: alive ? contents.getTitle() : '',
      loading: !!alive && contents.isLoading(),
      canGoBack: !!alive && contents.navigationHistory.canGoBack(),
      canGoForward: !!alive && contents.navigationHistory.canGoForward(),
      controller: tab.human ? 'human' : 'agent', mode: tab.placement?.mode ?? 'hidden',
      crashed: tab.crashed, error: tab.lastError,
    };
  }

  emit(tab, type, extra = {}) {
    if (!tab?.targetId) return;
    const payload = { type, ...this.state(tab), ...extra };
    this.onEvent(payload);
    const window = tab.sessionId && this.getWindowForSession(tab.sessionId);
    if (window && !window.isDestroyed()) window.webContents.send('desktop:browser-event', payload);
    const popout = this.popouts.get(tab.targetId);
    if (popout && !popout.isDestroyed()) popout.webContents.send('desktop:browser-popout-state', payload);
  }

  attach(window, { tabId, bounds, mode = 'dock', interactive = false, navigationEpoch }) {
    const tab = this.ownedTab(tabId, window);
    if (navigationEpoch !== undefined && navigationEpoch !== tab.navigationEpoch) throw new Error('Native browser presentation navigation is stale');
    if (!['dock', 'float', 'popout'].includes(mode)) throw new Error('Native browser presentation mode is invalid');
    if (mode === 'popout') return this.popout(window, tab);
    const rect = browserViewBounds(bounds, window);
    const placementChanged = tab.placement?.window !== window || tab.placement?.mode !== mode;
    const nextInteractive = interactive === true && tab.human;
    const inputChanged = tab.interactive !== nextInteractive;
    if (placementChanged) {
      this.unplace(tab);
      window.contentView.addChildView(tab.view);
    }
    tab.interactive = nextInteractive;
    tab.view.setBounds(rect);
    void this.viewport(tab, rect).catch(() => {});
    tab.view.setVisible(rect.width > 0 && rect.height > 0);
    tab.placement = { window, mode };
    if (placementChanged || inputChanged) this.emit(tab, 'presentation');
    return this.state(tab);
  }

  unplace(tab) {
    const placement = tab.placement;
    if (placement && !placement.window.isDestroyed()) placement.window.contentView.removeChildView(tab.view);
    tab.view.setVisible(false);
    tab.placement = null;
    tab.interactive = false;
  }

  detach(window, { tabId }) {
    const tab = this.ownedTab(tabId, window);
    this.unplace(tab);
    const popout = this.popouts.get(tab.targetId);
    if (popout && !popout.isDestroyed()) popout.hide();
    this.emit(tab, 'presentation');
    return this.state(tab);
  }

  popout(ownerWindow, tab) {
    this.unplace(tab);
    let popout = this.popouts.get(tab.targetId);
    if (!popout || popout.isDestroyed()) {
      popout = new this.BrowserWindow({ width: 1000, height: 760, minWidth: 420, minHeight: 320, title: 'Browser', show: false,
        webPreferences: { preload: POPOUT_PRELOAD, sandbox: true, nodeIntegration: false, contextIsolation: true, webviewTag: false } });
      this.popouts.set(tab.targetId, popout);
      popout.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      popout.webContents.on('will-navigate', (event) => event.preventDefault());
      popout.on('resize', () => this.layoutPopout(tab, popout));
      popout.on('close', (event) => {
        if (this.disposing) return;
        event.preventDefault();
        this.unplace(tab); popout.hide(); this.emit(tab, 'presentation');
      });
      popout.webContents.once('did-finish-load', () => this.emit(tab, 'state'));
      void popout.loadURL(POPOUT_URL);
    }
    popout.contentView.addChildView(tab.view);
    tab.placement = { window: popout, ownerWindow, mode: 'popout' };
    tab.interactive = tab.human;
    tab.view.setVisible(true);
    this.layoutPopout(tab, popout);
    popout.show();
    this.emit(tab, 'presentation');
    return this.state(tab);
  }

  layoutPopout(tab, popout) {
    if (tab.placement?.window !== popout) return;
    const { width, height } = popout.getContentBounds();
    const bounds = { x: 0, y: 76, width, height: Math.max(0, height - 76) };
    tab.view.setBounds(bounds);
    void this.viewport(tab, bounds).catch(() => {});
  }

  async navigate(window, { tabId, url }) {
    const tab = this.ownedTab(tabId, window);
    if (!tab.human) throw new Error('Take control before navigating the native browser');
    await tab.view.webContents.loadURL(browserNavigationUrl(url));
    return this.state(tab);
  }

  navigation(window, { tabId }, command) {
    const tab = this.ownedTab(tabId, window);
    if (!tab.human) throw new Error('Take control before navigating the native browser');
    const contents = tab.view.webContents;
    if (command === 'back' && contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack();
    else if (command === 'forward' && contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward();
    else if (command === 'reload') { tab.crashed = false; contents.reload(); }
    else if (command === 'stop') contents.stop();
    return this.state(tab);
  }

  control({ targetId, tabId, human, owner }) {
    const tab = this.tab(targetId ?? tabId);
    tab.human = human === true || owner === 'human';
    tab.interactive = tab.human && !!tab.placement;
    this.emit(tab, 'controller');
    return this.state(tab);
  }

  popoutCommand(sender, { command, url } = {}) {
    const pair = [...this.popouts].find(([, window]) => window.webContents === sender && !window.isDestroyed());
    if (!pair) throw new Error('Browser popout sender is not owned');
    const tab = this.tab(pair[0]);
    const ownerWindow = this.getWindowForSession(tab.sessionId);
    if (!ownerWindow) throw new Error('Browser popout owner is unavailable');
    if (command === 'close') return this.detach(ownerWindow, { tabId: tab.tabId });
    if (['dock', 'take-control', 'return-agent', 'annotate', 'capture', 'downloads'].includes(command)) {
      if (command === 'dock') this.detach(ownerWindow, { tabId: tab.tabId });
      this.emit(tab, 'presentation-command', { command });
      return { queued: true };
    }
    if (command === 'navigate') return this.navigate(ownerWindow, { tabId: tab.tabId, url });
    if (['back', 'forward', 'reload', 'stop'].includes(command)) return this.navigation(ownerWindow, { tabId: tab.tabId }, command);
    throw new Error('Unsupported browser popout command');
  }

  closeTab(targetId) {
    const tab = this.tabs.get(targetId);
    if (!tab) return false;
    this.unplace(tab);
    this.cdp.remove(targetId);
    const popout = this.popouts.get(targetId);
    if (popout && !popout.isDestroyed()) popout.destroy();
    this.popouts.delete(targetId);
    if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close({ waitForBeforeUnload: false });
    return true;
  }

  detachWindow(window) {
    for (const tab of this.tabs.values()) {
      if (tab.windowId !== window.id) continue;
      this.unplace(tab);
      const popout = this.popouts.get(tab.targetId);
      if (popout && !popout.isDestroyed()) popout.hide();
    }
  }

  async setDownloadBehavior({ behavior, downloadPath }) {
    if (!['allow', 'allowAndName', 'deny', 'default'].includes(behavior)) throw new Error('Native download behavior is invalid');
    if (behavior === 'allow' || behavior === 'allowAndName') {
      if (!isAbsolute(String(downloadPath ?? ''))) throw new Error('Native download path must be absolute');
      // This path is supplied only over the private owner CDP connection.
      this.downloadPath = await privateDirectory(downloadPath);
    }
    this.downloadBehavior = behavior;
    return {};
  }

  willDownload(event, item, contents) {
    const tab = [...this.tabs.values()].find((value) => value.view.webContents === contents);
    if (!tab || !this.owner || !this.downloadPath || !['allow', 'allowAndName'].includes(this.downloadBehavior)) { event.preventDefault(); return; }
    const guid = randomUUID();
    item.setSavePath(join(this.downloadPath, guid));
    this.downloads.set(guid, item);
    this.cdp.send({ method: 'Browser.downloadWillBegin', params: { guid, frameId: tab.frameId,
      url: item.getURL(), suggestedFilename: item.getFilename() } });
    const progress = (state) => this.cdp.send({ method: 'Browser.downloadProgress', params: {
      guid, totalBytes: item.getTotalBytes(), receivedBytes: item.getReceivedBytes(), state,
      ...(state === 'completed' ? { filePath: item.getSavePath() } : {}),
    } });
    item.on('updated', () => progress('inProgress'));
    item.once('done', (_event, state) => { progress(state === 'completed' ? 'completed' : 'canceled'); this.downloads.delete(guid); });
  }

  cancelDownload(guid) { this.downloads.get(guid)?.cancel(); return {}; }
  async getCookies() {
    const cookies = await this.session.cookies.get({});
    return cookies.map((cookie) => ({ ...cookie, expires: cookie.session ? -1 : cookie.expirationDate,
      sameSite: { unspecified: 'Lax', no_restriction: 'None', lax: 'Lax', strict: 'Strict' }[cookie.sameSite] ?? 'Lax' }));
  }
  async setCookies(cookies) {
    for (const cookie of cookies) {
      const url = cookie.url ?? `${cookie.secure ? 'https' : 'http'}://${String(cookie.domain).replace(/^\./, '')}${cookie.path || '/'}`;
      await this.session.cookies.set({ ...cookie, url,
        ...(cookie.expires >= 0 ? { expirationDate: cookie.expires } : {}),
        sameSite: { None: 'no_restriction', Lax: 'lax', Strict: 'strict' }[cookie.sameSite] ?? 'unspecified' });
    }
    await this.session.cookies.flushStore();
    return {};
  }
  async clearCookies() { await this.session.clearStorageData({ storages: ['cookies'] }); return {}; }

  onDebuggerDetached(tab, reason) {
    const contents = tab.view.webContents;
    if (!contents.isDestroyed()) contents.closeDevTools();
    this.emit(tab, 'debugger-disconnected', { reason, recovery: 'reconnect' });
  }
  onAutomationDisconnected() { for (const tab of this.tabs.values()) { tab.human = false; tab.interactive = false; this.emit(tab, 'runtime-disconnected'); } }

  async release(owner) {
    if (this.owner !== owner) return false;
    if (this.releasePromise) return this.releasePromise;
    this.owner = null;
    this.proxy = null;
    this.releasePromise = (async () => {
      for (const item of this.downloads.values()) item.cancel();
      await this.cdp.close();
      this.onAutomationDisconnected();
      await this.session?.closeAllConnections();
      return true;
    })();
    try { return await this.releasePromise; } finally { this.releasePromise = null; }
  }

  async reset(owner) {
    if (this.owner && this.owner !== owner) throw new Error('Native browser reset owner is stale');
    if (this.lastOwner && this.lastOwner !== owner && this.lastOwner.connected !== false) {
      throw new Error('Native browser reset owner is stale');
    }
    if (this.resetPromise) return this.resetPromise;
    this.lastOwner = owner;
    this.resetPromise = (async () => {
      await this.releasePromise;
      this.owner = null;
      this.proxy = null;
      this.onAutomationDisconnected();
      for (const item of this.downloads.values()) item.cancel();
      this.downloads.clear();
      await this.cdp.close();
      const guests = [...this.tabs.values()];
      const closed = guests.map((tab) => new Promise((resolveClosed) => {
        const contents = tab.view.webContents;
        if (!contents || contents.isDestroyed()) resolveClosed();
        else contents.once('destroyed', resolveClosed);
      }));
      for (const tab of guests) this.closeTab(tab.targetId);
      await Promise.all(closed);
      this.tabs.clear();
      this.aliases.clear();
      this.popouts.clear();
      // Electron caches sessions by path. Clear both memory and disk before the
      // hub removes this profile, so a later session cannot revive old login data.
      if (this.session) {
        await this.session.closeAllConnections();
        await this.session.clearData();
        await this.session.clearAuthCache();
        await this.session.clearHostResolverCache();
        this.session.flushStorageData();
        await this.session.cookies.flushStore();
        await this.session.closeAllConnections();
      }
      this.downloadPath = null;
      this.downloadBehavior = 'deny';
      this.generation = randomUUID();
      return { tabsClosed: guests.length, generation: this.generation };
    })();
    try { return await this.resetPromise; } finally { this.resetPromise = null; }
  }

  async handleRequest(message, owner) {
    if (!message || message.type !== 'rhwp-browser-request' || typeof message.id !== 'string') return null;
    const response = { type: 'rhwp-browser-response', id: message.id };
    try {
      const params = message.params ?? {};
      if (message.operation === 'start') response.value = await this.start(params, owner);
      else if (message.operation === 'reset') response.value = await this.reset(owner);
      else {
        if (this.owner !== owner) throw new Error('Native browser request owner is stale');
        if (message.operation === 'bind') response.value = this.bind(params);
        else if (message.operation === 'control') response.value = this.control(params);
        else if (message.operation === 'release') response.value = await this.release(owner);
        else if (message.operation === 'inventory') response.value = [...this.tabs.values()].map((tab) => this.state(tab));
        else throw new Error('Unsupported native browser operation');
      }
      response.ok = true;
    } catch (error) { response.ok = false; response.error = { message: error.message, code: 'NATIVE_BROWSER_FAILED' }; }
    return response;
  }

  async dispose() {
    this.disposing = true;
    await this.cdp.close();
    if (this.session) { this.session.flushStorageData(); await this.session.cookies.flushStore(); }
    for (const targetId of [...this.tabs.keys()]) this.closeTab(targetId);
    this.owner = null;
    this.lastOwner = null;
    this.proxy = null;
  }
}
