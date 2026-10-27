import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrivateBrowserCdp, protectedUrl } from './browser-cdp.mjs';
import { AgentCursorOverlay, readAgentPointer } from './browser-agent-cursor.mjs';

const GUEST_PRELOAD = fileURLToPath(new URL('./browser-guest-preload.cjs', import.meta.url));
// 이 로그인 페이지에서는 앱 브라우저 대신 Google Chrome 로그인을 권한다. Google은 내장 브라우저를 거절할 수 있고 Apple 패스키는 iCloud 키체인이 필요하다.
const CHROME_SIGN_IN_HOSTS = new Set(['accounts.google.com', 'appleid.apple.com']);
const CHROME_SIGN_IN_BAR = 36;
const POPOUT_PRELOAD = fileURLToPath(new URL('./browser-popout-preload.cjs', import.meta.url));
const POPOUT_URL = new URL('./browser-popout.html', import.meta.url).href;
const MAX_NATIVE_TABS = 64;
const CAPTURE_SURFACE_TIMEOUT_MS = 15_000;
const ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,159}$/;
// 페이지가 선언한 아이콘 주소만 허브로 넘긴다. 허브가 다시 검사하고 쿠키 없이 받아 온다.
const faviconList = (value) => (Array.isArray(value) ? value : []).filter((entry) => typeof entry === 'string'
  && (/^https?:\/\//i.test(entry) ? entry.length <= 2048 : /^data:image\//i.test(entry) && entry.length <= 90_000)).slice(0, 8);
// 작성 중인 입력이나 재생 중인 미디어가 있으면 true. 값은 밖으로 보내지 않는다.
const PAGE_STATE_SCRIPT = `(() => {
  const protectedFrame = win => {
    try {
      const doc = win.document;
      if ([...doc.querySelectorAll('input,textarea,select,[contenteditable="true"]')].some(el =>
        el.isContentEditable ? el.textContent.trim() : el.tagName === 'SELECT' ? [...el.options].some(option => option.selected !== option.defaultSelected)
          : ['checkbox','radio'].includes(el.type) ? el.checked !== el.defaultChecked
            : !['hidden','submit','button','reset'].includes(el.type) && !!el.value)) return true;
      if ([...doc.querySelectorAll('audio,video')].some(media => !media.paused && !media.ended)) return true;
      return Array.from({ length: win.frames.length }, (_, index) => win.frames[index]).some(protectedFrame);
    } catch { return true; }
  };
  return protectedFrame(window);
})()`;

export function browserNavigationUrl(value) {
  if (value === 'about:blank') return value;
  const url = new URL(String(value));
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Browser navigation requires an HTTP or HTTPS URL without credentials');
  }
  return url.href;
}

/**
 * 페이지가 스스로 일으킨 이동(링크·리디렉션·window.open)에 쓰는 검사. 주소창·에이전트가 넘긴
 * 주소는 browserNavigationUrl 만 쓴다. 웹 페이지가 만든 blob: 주소는 그 페이지의 출처를
 * 이어받으므로 허용한다 — 막으면 다운로드 단추·PDF 보기·이미지 열기 클릭이 아무 일도 하지 않는다.
 */
export function pageNavigationUrl(value) {
  const text = String(value);
  if (text === 'about:blank' || text === 'about:srcdoc') return text;
  const url = new URL(text);
  if (url.protocol === 'blob:') {
    if (!/^https?:\/\//.test(url.origin)) throw new Error('Browser navigation allows blob URLs from web pages only');
    return url.href;
  }
  return browserNavigationUrl(text);
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

// 파일 칸의 accept 를 파일 창 확장자 목록으로 옮긴다. 옮기지 못하는 형식이 하나라도 있으면 거르지 않는다.
const ACCEPT_EXTENSIONS = {
  'image/*': ['png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'bmp', 'svg', 'avif'], 'video/*': ['mp4', 'mov', 'webm', 'm4v'], 'audio/*': ['mp3', 'm4a', 'wav', 'aac', 'ogg', 'flac'],
  'text/plain': ['txt'], 'text/csv': ['csv'], 'application/pdf': ['pdf'], 'application/zip': ['zip'], 'application/json': ['json'],
  'image/png': ['png'], 'image/jpeg': ['jpg', 'jpeg'], 'image/gif': ['gif'], 'image/webp': ['webp'],
  'application/msword': ['doc'], 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['docx'],
  'application/vnd.ms-excel': ['xls'], 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['xlsx'],
  'application/vnd.ms-powerpoint': ['ppt'], 'application/vnd.openxmlformats-officedocument.presentationml.presentation': ['pptx'],
  'application/x-hwp': ['hwp'], 'application/haansofthwp': ['hwp'], 'application/vnd.hancom.hwpx+zip': ['hwpx'], 'application/hwp+zip': ['hwpx'],
};
export function fileChooserFilters(accept) {
  const tokens = String(accept ?? '').split(',').map((token) => token.trim().toLowerCase()).filter(Boolean);
  const extensions = new Set();
  for (const token of tokens) {
    if (/^\.[a-z0-9]{1,16}$/.test(token)) extensions.add(token.slice(1));
    else if (ACCEPT_EXTENSIONS[token]) for (const extension of ACCEPT_EXTENSIONS[token]) extensions.add(extension);
    else return null;
  }
  return extensions.size ? [{ name: '파일', extensions: [...extensions] }] : null;
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
  constructor({ BrowserWindow, BaseWindow = BrowserWindow, WebContentsView, electronSession, dialog, dataDir, getWindowForSession, onEvent = () => {}, platform = process.platform }) {
    this.platform = platform;
    this.dialog = dialog;
    this.BrowserWindow = BrowserWindow;
    this.BaseWindow = BaseWindow;
    this.WebContentsView = WebContentsView;
    this.electronSession = electronSession;
    this.dataDir = resolve(dataDir);
    this.getWindowForSession = getWindowForSession;
    this.onEvent = onEvent;
    this.tabs = new Map();
    this.pendingTabs = new Set();
    this.parkingWindow = null;
    this.captureSurfaces = new WeakMap();
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

  async start({ profileDir, downloadsPath, proxy }, owner) {
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.startOwned({ profileDir, downloadsPath, proxy }, owner);
    try { return await this.startPromise; } finally { this.startPromise = null; }
  }

  async startOwned({ profileDir, downloadsPath, proxy }, owner) {
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
    // 패스키 설정은 실행할 때 첫 창과 나란히 끝난다. 브라우저 세션과 상태는 그 결과를 따른다.
    await this.webAuthn?.configure?.();
    if (!this.session) {
      this.session = this.electronSession.fromPath(canonicalProfile);
      this.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
      this.session.setPermissionCheckHandler(() => false);
      this.webAuthn?.attachSession(this.session);
      await this.adblock?.attach(this.session);
      this.session.webRequest.onBeforeRequest((details, callback) => {
        try {
          const protocol = new URL(details.url).protocol;
          const protectedSession = [...this.tabs.values()].some((tab) => tab.passwordShield);
          // WSS stays TLS-encrypted through the guarded pinned CONNECT tunnel;
          // native guests never install Playwright's plaintext WebSocket route.
          const cancel = !this.proxy || !['http:', 'https:', 'ws:', 'wss:', 'blob:'].includes(protocol) || protectedSession && protocol === 'ws:';
          if (cancel) callback({ cancel: true });
          else if (this.adblock) this.adblock.beforeRequest(details, callback);
          else callback({ cancel: false });
        } catch { callback({ cancel: true }); }
      });
      this.session.on('will-download', (event, item, contents) => this.willDownload(event, item, contents));
    }
    if (this.owner && this.owner !== owner) {
      await Promise.all([...this.tabs.values()].map((tab) => this.clearActivity(tab)));
      await this.cdp.close();
    }
    this.owner = owner;
    this.lastOwner = owner;
    this.proxy = { ...proxy, host: proxyUrl.hostname, port: Number(proxyUrl.port) };
    await this.session.setProxy({ proxyRules: proxy.server, proxyBypassRules: '<-loopback>' });
    await this.session.closeAllConnections();
    for (const tab of this.tabs.values()) {
      if (!tab.closing && !this.cdp.tabs.has(tab.targetId) && tab.view.webContents && !tab.view.webContents.isDestroyed()) {
        await this.cdp.add(tab);
        await this.clearActivity(tab);
        const viewport = tab.viewport ?? { width: 1280, height: 800 };
        tab.viewport = null;
        await this.viewport(tab, viewport);
      }
    }
    const transfers = join(this.dataDir, 'browser', 'transfers');
    if (downloadsPath && resolve(downloadsPath) !== transfers) throw new Error('Native download directory is outside its owned directory');
    await this.setDownloadBehavior({ behavior: 'allowAndName', downloadPath: transfers });
    // 다시 시작한 뒤 에이전트가 보기 전에 최근 입력한 비밀번호를 가릴 준비를 한다. 관찰은 이 작업을 기다린다.
    void this.passwords?.loadProtectedValues?.();
    const endpointURL = await this.cdp.listen();
    return { endpointURL, native: true, generation: this.generation, signInSupport: 'full-browser-required', authentication: { passkeys: this.webAuthn?.metadata() } };
  }

  async createTab({ url = 'about:blank', parent = null, disposition = null } = {}) {
    const destination = browserNavigationUrl(url);
    const tab = this.createNativeTab({ parent, disposition });
    await this.initializeTab(tab, { loadBlank: true });
    if (destination !== 'about:blank') void tab.view.webContents.loadURL(destination).catch(() => {});
    return tab;
  }

  guestPreferences() {
    return { session: this.session, preload: GUEST_PRELOAD, sandbox: true,
      contextIsolation: true, nodeIntegration: false, webSecurity: true,
      webviewTag: false, allowRunningInsecureContent: false, devTools: false };
  }

  createNativeTab({ parent = null, disposition = null, options = {} } = {}) {
    if (!this.owner || !this.proxy) throw new Error('Native browser runtime is disconnected');
    if (this.tabs.size + this.pendingTabs.size >= MAX_NATIVE_TABS) throw new Error('Native browser tab limit reached');
    const view = new this.WebContentsView({ ...(options.webContents ? { webContents: options.webContents } : {}),
      webPreferences: { ...options.webPreferences, ...this.guestPreferences() } });
    view.setBounds({ x: 0, y: 0, width: 1280, height: 800 });
    view.setVisible(false);
    const contents = view.webContents;
    contents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
    const tab = { view, targetId: null, tabId: null, sessionId: parent?.sessionId ?? null, chatId: parent?.chatId ?? null, windowId: parent?.windowId ?? null,
      lastHiddenAt: Date.now(), placement: null, human: false, interactive: false, navigationEpoch: 0,
      frameId: null, lastError: null, crashed: false, openerTab: parent, openerTargetId: parent?.targetId, disposition };
    // 실제 opener를 읽을 수 있는 자식도 부모와 같은 비밀 보호 범위를 갖는다.
    if (parent?.passwordShield) Object.assign(tab, { passwordShield: true,
      protectedPasswords: new Set(parent.protectedPasswords ?? []), passwordSnapshot: null });
    this.parkGuest(tab);
    this.pendingTabs.add(tab);
    contents.setWindowOpenHandler((details) => {
      try {
        const destination = pageNavigationUrl(details.url);
        if (!tab.tabId || tab.closing || !this.owner || !this.proxy || this.tabs.size + this.pendingTabs.size >= MAX_NATIVE_TABS) return { action: 'deny' };
        // 팝업 창이 다시 연 팝업은 막는다. 로그인 팝업은 한 단계면 충분하고 연쇄 팝업은 가로채기에 쓰인다.
        if (tab.openerTab && tab.disposition === 'new-window') return { action: 'deny' };
        return { action: 'allow', overrideBrowserWindowOptions: { webPreferences: this.guestPreferences() },
          createWindow: (options) => {
            // Chromium's guest carries the actual WindowProxy, opener and POST navigation.
            // Adopting it preserves OAuth messaging without exposing a new BrowserWindow.
            const popup = this.createNativeTab({ parent: tab, disposition: details.disposition, options });
            // Attaching a debugger inside Electron's guest-creation callback can crash
            // Chromium during a nonblank initial navigation. Wait for the native call to return.
            void new Promise(resolveReady => setImmediate(resolveReady)).then(() => this.initializeTab(popup, { loadBlank: !options.webContents })).then(() => {
              // Browser-process link opens can defer guest creation and navigation.
              // Ctrl·Shift 클릭처럼 Chromium 이 게스트를 만들지 않은 경우 blob: 도 여기서 연다.
              // 열지 않으면 빈 탭만 남는다. about:srcdoc 은 브라우저 프로세스가 열 수 없다.
              if (!options.webContents && /^(https?|blob):/.test(destination)) {
                const postBody = destination.startsWith('blob:') ? null : details.postBody;
                void popup.view.webContents.loadURL(destination, { httpReferrer: details.referrer,
                  ...(postBody ? { postData: postBody.data, extraHeaders: `content-type: ${postBody.contentType}${postBody.boundary ? `; boundary=${postBody.boundary}` : ''}` } : {}) }).catch(() => {});
              }
            }).catch(() => {});
            return popup.view.webContents;
          } };
      } catch { return { action: 'deny' }; }
    });
    contents.on('will-navigate', (event, rawUrl) => {
      try { pageNavigationUrl(rawUrl); } catch { event.preventDefault(); }
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
    const blockHumanInput = (event, input) => {
      if (tab.automationInputDepth) return;
      // 물리 입력은 조작권과 렌더러의 배치 요청(미리보기 잠금)을 따른다. 사용자가 잡은 탭의 에이전트 입력은 허브와 CDP가 거부한다.
      if (!tab.human || !tab.interactive) { event.preventDefault(); return; }
      // 전달된 입력은 허브에 알려 이어지는 페이지 요청(로그인 제출 등)을 사용자의 것으로 본다.
      if (['mouseDown', 'keyDown'].includes(input?.type)) this.emit(tab, 'human-input');
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
    contents.on('did-navigate', () => { tab.faviconCandidates = null; });
    contents.on('did-navigate', (_event, rawUrl) => this.trackChromeSignIn(tab, rawUrl));
    contents.on('page-favicon-updated', (_event, favicons) => { tab.faviconCandidates = faviconList(favicons); this.forwardFavicons(tab); });
    contents.on('dom-ready', () => this.passwords?.restoreManualSave?.(tab));
    contents.on('did-navigate', () => { this.clearActivity(tab); tab.navigationEpoch += 1; tab.lastError = null; this.emit(tab, 'navigation'); });
    contents.on('did-navigate-in-page', (_event, _url, isMainFrame) => { if (isMainFrame) { this.clearActivity(tab); tab.navigationEpoch += 1; this.emit(tab, 'navigation'); this.passwords?.restoreManualSave?.(tab); } });
    contents.on('did-fail-load', (_event, code, description, _url, mainFrame) => {
      if (mainFrame && code !== -3) { tab.lastError = description; this.emit(tab, 'load-failed'); }
    });
    contents.on('render-process-gone', (_event, details) => { tab.crashed = true; this.emit(tab, 'crashed', { reason: details.reason }); });
    contents.once('destroyed', () => {
      tab.closing = true; void this.clearActivity(tab); this.passwords?.forgetTab(tab); this.webAuthn?.cancelTab(tab); this.pendingTabs.delete(tab); this.unplace(tab);
      this.cdp.remove(tab.targetId); this.tabs.delete(tab.targetId);
      if (tab.tabId && this.aliases.get(tab.tabId) === tab.targetId) this.aliases.delete(tab.tabId);
      const popout = this.popouts.get(tab.targetId);
      if (popout && !popout.isDestroyed()) popout.destroy();
      this.popouts.delete(tab.targetId); this.emit(tab, 'closed');
    });
    return tab;
  }

  async initializeTab(tab, { loadBlank = false } = {}) {
    const contents = tab.view.webContents;
    if (!contents || contents.isDestroyed() || tab.closing) { this.pendingTabs.delete(tab); return tab; }
    if (!this.owner || !this.proxy) { this.closeGuest(tab); return tab; }
    try {
      if (loadBlank) await contents.loadURL('about:blank');
      await this.cdp.add(tab);
      await this.viewport(tab, { width: 1280, height: 800 });
      const tree = await contents.debugger.sendCommand('Page.getFrameTree');
      tab.frameId = tree.frameTree.frame.id;
      contents.debugger.on('message', (_event, method, params) => {
        if (method === 'Page.frameNavigated' && !params.frame?.parentId) tab.frameId = params.frame.id;
      });
      const parent = this.tabs.get(tab.openerTargetId);
      if (parent?.tabId) this.emit(parent, 'popup', { nativeTargetId: tab.targetId });
      return tab;
    } catch (error) {
      if (!contents.isDestroyed()) contents.close();
      throw error;
    } finally { this.pendingTabs.delete(tab); }
  }

  tab(id) {
    const tab = this.tabs.get(id) ?? this.tabs.get(this.aliases.get(id));
    if (tab?.closing || !tab?.view.webContents || tab.view.webContents.isDestroyed()) throw new Error('Native browser tab is unavailable');
    return tab;
  }

  registerTarget(tab, previousTargetId) {
    this.pendingTabs.delete(tab);
    // 재연결은 같은 게스트를 유지한다. 대상 ID가 바뀌어도 논리 탭과 창 소유권은 유지한다.
    if (previousTargetId && previousTargetId !== tab.targetId) {
      this.tabs.delete(previousTargetId);
      const popout = this.popouts.get(previousTargetId);
      if (popout) { this.popouts.delete(previousTargetId); this.popouts.set(tab.targetId, popout); }
    }
    this.tabs.set(tab.targetId, tab);
    for (const child of new Set([...this.tabs.values(), ...this.pendingTabs])) if (child.openerTab === tab) {
      child.openerTargetId = tab.targetId;
      if (child.targetInfo) child.targetInfo.openerId = tab.targetId;
    }
    if (tab.tabId) this.aliases.set(tab.tabId, tab.targetId);
  }

  bind({ targetId, tabId, sessionId, chatId, global = false }) {
    if (!ID_RE.test(String(tabId)) || !ID_RE.test(String(sessionId))) throw new Error('Native browser binding is invalid');
    const window = this.getWindowForSession(sessionId);
    if (!window || window.isDestroyed()) throw new Error('Native browser binding has no owning editor window');
    const tab = this.tab(targetId);
    if (tab.openerTargetId && tab.chatId !== chatId) throw new Error('Native browser popup belongs to another chat');
    const occupied = this.aliases.get(tabId);
    if (occupied && occupied !== targetId) throw new Error('Native browser tab binding is already owned');
    if (tab.windowId && tab.windowId !== window.id) {
      if (!global || !tab.global) throw new Error('Native browser tab belongs to another editor window');
      this.unplace(tab); this.popouts.get(tab.targetId)?.hide();
    }
    if (tab.tabId && (tab.tabId !== tabId || tab.sessionId !== sessionId || tab.chatId !== chatId)) { tab.passwordSnapshot = null; this.webAuthn?.cancelTab(tab); }
    if (tab.tabId && tab.tabId !== tabId) this.aliases.delete(tab.tabId);
    if (tab.tabId !== tabId || tab.sessionId !== sessionId || tab.chatId !== chatId) this.clearActivity(tab);
    Object.assign(tab, { tabId, sessionId, chatId, windowId: window.id, global });
    this.aliases.set(tabId, targetId);
    this.emit(tab, 'bound');
    // 팝업은 탭 ID를 받기 전에 첫 페이지(Google 로그인 등)를 연다. 묶인 뒤 다시 본다.
    if (!tab.chromeSignIn && !tab.view.webContents.isDestroyed()) this.trackChromeSignIn(tab, tab.view.webContents.getURL());
    this.forwardFavicons(tab);
    return this.state(tab);
  }

  // Only the private hub operation scope can temporarily wake a hidden guest.
  async activity({ targetId, tabId, sessionId, chatId, generation, token, active, renew = false }) {
    const tab = this.tab(targetId);
    const currentScope = generation === this.generation && tab.targetId === targetId && tab.tabId === tabId && tab.sessionId === sessionId && tab.chatId === chatId;
    if (active === false) {
      if (!currentScope) return { active: false };
      const timer = tab.activityLeases?.get(token);
      if (!timer) return { active: false };
      clearTimeout(timer); tab.activityLeases.delete(token);
      await this.syncActivity(tab);
      return { active: false };
    }
    if (active !== true || !currentScope || typeof token !== 'string' || !ID_RE.test(token)) throw new Error('Native activity scope is stale');
    tab.activityLeases ??= new Map();
    const existing = tab.activityLeases.get(token);
    if (existing && renew !== true) throw new Error('Native activity token is already active');
    // 허브가 긴 작업 동안 같은 임대를 갱신한다. 허브가 멈추면 30초 뒤 만료된다.
    clearTimeout(existing);
    const timer = setTimeout(() => {
      tab.activityLeases.delete(token);
      void this.syncActivity(tab).catch(() => {});
    }, 30_000);
    timer.unref?.();
    tab.activityLeases.set(token, timer);
    if (existing) return { active: true };
    try { await this.syncActivity(tab); }
    catch (error) { clearTimeout(timer); tab.activityLeases.delete(token); await this.syncActivity(tab).catch(() => {}); throw error; }
    return { active: true };
  }

  syncActivity(tab) {
    tab.activityQueue = (tab.activityQueue ?? Promise.resolve()).catch(() => {}).then(async () => {
      const contents = tab.view.webContents;
      if (!contents || contents.isDestroyed() || !contents.debugger.isAttached()) return;
      // 열린 페이지 대화상자는 렌더러를 멈춰 이 명령이 돌아오지 않는다. 에이전트가 대화상자에 답할 수 있게 닫힐 때까지 미룬다.
      if (tab.dialogOpen) { tab.activitySyncDeferred = true; return; }
      // 허브가 숨은 탭을 다루는 동안에는 타이머·애니메이션 제한을 풀어 페이지가 제 속도로 뜨게 한다.
      contents.setBackgroundThrottling(!tab.activityLeases?.size);
      await contents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: !!tab.activityLeases?.size });
    });
    return tab.activityQueue;
  }

  clearActivity(tab) {
    for (const timer of tab.activityLeases?.values() ?? []) clearTimeout(timer);
    tab.activityLeases?.clear();
    return this.syncActivity(tab).catch(() => {});
  }

  ownedTab(id, window) {
    const tab = this.tab(id);
    if (!tab.tabId || tab.windowId !== window.id) throw new Error('Native browser tab belongs to another editor window');
    return tab;
  }

  async viewport(tab, { width, height }) {
    if (width <= 0 || height <= 0 || tab.closing) return;
    tab.pendingViewport = { width, height };
    if (tab.viewportTask) return tab.viewportTask;
    tab.viewportTask = (async () => {
      await Promise.resolve();
      while (tab.pendingViewport && !tab.closing && !tab.view.webContents.isDestroyed()) {
        const next = tab.pendingViewport; tab.pendingViewport = null;
        if (tab.placement) {
          if (tab.viewport) { await tab.view.webContents.debugger.sendCommand('Emulation.clearDeviceMetricsOverride'); tab.viewport = null; }
        } else if (tab.viewport?.width !== next.width || tab.viewport?.height !== next.height) {
          // 숨긴 게스트만 유효한 뷰포트를 유지한다. 보이는 페이지는 네이티브 크기 변경을 따른다.
          await tab.view.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride', { ...next, deviceScaleFactor: 0, mobile: false });
          tab.viewport = next;
        }
      }
    })();
    try { await tab.viewportTask; } finally { tab.viewportTask = null; }
  }

  state(tab) {
    const contents = tab.view.webContents;
    const alive = contents && !contents.isDestroyed();
    const state = { tabId: tab.tabId, nativeTargetId: tab.targetId, openerTargetId: tab.openerTargetId ?? null, native: true,
      generation: this.generation, navigationEpoch: tab.navigationEpoch, disposition: tab.disposition, passwordProtected: !!tab.passwordShield,
      url: alive ? contents.getURL() : '', title: alive ? contents.getTitle() : '',
      loading: !!alive && contents.isLoading(),
      zoomFactor: alive ? contents.getZoomFactor() : 1,
      canGoBack: !!alive && contents.navigationHistory.canGoBack(),
      canGoForward: !!alive && contents.navigationHistory.canGoForward(),
      controller: tab.human ? 'human' : 'agent', held: tab.held === true, interactive: tab.interactive === true, mode: tab.placement?.mode ?? 'hidden',
      crashed: tab.crashed, error: tab.lastError,
      chromeSignIn: this.chromeSignInOffer(tab), chromeSignInActive: this.chromeSignInActiveSite ?? null, bare: !!tab.popoutBare,
    };
    if (tab.passwordShield) { state.url = protectedUrl(state.url); state.title = ''; state.error = null; }
    return this.passwords ? this.passwords.redact(tab, state) : state;
  }

  /** Site icon candidates go only to the hub owner. Password-shielded tabs never report them. */
  forwardFavicons(tab) {
    const contents = tab.view.webContents;
    if (!tab.faviconCandidates?.length || !tab.tabId || tab.passwordShield || !contents || contents.isDestroyed()
      || !this.owner?.connected || typeof this.owner.send !== 'function') return;
    try {
      this.owner.send({ type: 'rhwp-browser-event', event: { tabId: tab.tabId, targetId: tab.targetId, generation: this.generation,
        reason: 'favicon', pageUrl: contents.getURL(), favicons: tab.faviconCandidates } }, () => {});
    } catch {}
  }

  emit(tab, type, extra = {}) {
    if (!tab?.targetId) return;
    const payload = { type, ...this.state(tab), ...extra };
    this.onEvent(payload);
    if ((['zoom', 'download-progress', 'sign-in'].includes(type) || type === 'human-input') && tab.tabId && this.owner?.connected && typeof this.owner.send === 'function') {
      try {
        this.owner.send({ type: 'rhwp-browser-event', event: { tabId: tab.tabId, targetId: tab.targetId,
          generation: this.generation, reason: type, ...(type === 'zoom' ? { zoomFactor: payload.zoomFactor } : extra) } }, () => {});
      } catch {}
    }
    const window = tab.sessionId && this.getWindowForSession(tab.sessionId);
    if (window && !window.isDestroyed()) window.webContents.send('desktop:browser-event', payload);
    const popout = this.popouts.get(tab.targetId);
    if (popout && !popout.isDestroyed()) popout.webContents.send('desktop:browser-popout-state', payload);
  }

  attach(window, { tabId, bounds, mode = 'dock', interactive = false, focus = false, bare = false, title, navigationEpoch, expectedTargetId }) {
    const tab = this.ownedTab(tabId, window);
    if (expectedTargetId !== undefined && expectedTargetId !== tab.targetId) throw new Error('Native browser presentation target is stale');
    if (navigationEpoch !== undefined && navigationEpoch !== tab.navigationEpoch) throw new Error('Native browser presentation navigation is stale');
    if (!['dock', 'float', 'popout'].includes(mode)) throw new Error('Native browser presentation mode is invalid');
    if (mode === 'popout') return this.popout(window, tab, bare === true, typeof title === 'string' && title ? title.slice(0, 80) : null);
    const rect = browserViewBounds(bounds, window);
    // 띄우기도 고정과 같이 편집기 창 안의 뷰다. 화면 틀은 렌더러가 그리고 호스트는 영역만 따른다.
    const windowChanged = tab.placement?.window !== window;
    const placementChanged = windowChanged || tab.placement?.mode !== mode;
    // 렌더러가 원한 입력 허용을 기억한다. 조작권 전환이 미리보기 잠금을 풀지 않게 한다.
    tab.requestedInteractive = interactive === true;
    const nextInteractive = interactive === true && tab.human;
    const inputChanged = tab.interactive !== nextInteractive;
    if (windowChanged) {
      this.unplace(tab);
      this.placeGuest(tab, window);
    }
    tab.interactive = nextInteractive;
    tab.placement = { window, mode };
    // 같은 창 안의 모드 전환은 뷰를 떼지 않는다. 다시 붙이면 페이지의 키보드 포커스가 풀린다.
    if (mode === 'float') this.raiseFloat(tab);
    this.setViewRadius(tab, mode === 'float' ? 10 : 0);
    const previous = tab.view.getBounds();
    if (previous.x !== rect.x || previous.y !== rect.y || previous.width !== rect.width || previous.height !== rect.height) tab.view.setBounds(rect);
    void this.viewport(tab, rect).catch(() => {});
    // 이미 보이는 뷰를 다시 표시하면 macOS가 페이지의 키보드 포커스를 해제한다.
    const visible = rect.width > 0 && rect.height > 0;
    if (tab.view.getVisible() !== visible) tab.view.setVisible(visible);
    // 직접 조작을 가져온 순간 키 입력이 바로 페이지로 가도록 한다.
    if (focus === true && tab.interactive && visible && !tab.view.webContents.isFocused()) tab.view.webContents.focus();
    if (placementChanged || inputChanged) this.emit(tab, 'presentation');
    return this.state(tab);
  }

  // 에이전트 커서는 지금 보이는 게스트 위에만 그린다. 숨은 탭이나 다른 대상이면 그리지 않는다.
  pointer(window, { tabId, expectedTargetId, ...payload } = {}) {
    const tab = this.ownedTab(tabId, window);
    const pointer = readAgentPointer(payload);
    const host = tab.placement?.window;
    if (!pointer || (expectedTargetId !== undefined && expectedTargetId !== tab.targetId) || !host || host.isDestroyed()
      || host.isVisible?.() === false || !tab.view.getVisible() || tab.view.webContents.isDestroyed()) return { shown: false };
    this.agentCursor ??= new AgentCursorOverlay({ WebContentsView: this.WebContentsView });
    return { shown: this.agentCursor.show({ window: host, tab, bounds: tab.view.getBounds(), zoomFactor: tab.view.webContents.getZoomFactor(), ...pointer }) };
  }

  // 띄운 페이지는 같은 창의 다른 게스트(사이드바) 위에 있어야 한다.
  raiseFloat(tab) {
    const content = tab.placement?.window.contentView;
    if (!content || content.children.at(-1) === tab.view) return;
    // 이미 붙은 뷰를 다시 추가하면 Electron은 순서만 맨 위로 바꾼다.
    content.addChildView(tab.view);
  }

  setViewRadius(tab, radius) {
    if ((tab.viewRadius ?? 0) === radius) return;
    tab.view.setBorderRadius(radius);
    tab.viewRadius = radius;
  }

  async presentationState(window, { tabId, expectedTargetId }) {
    const tab = this.ownedTab(tabId, window);
    if (expectedTargetId !== undefined && expectedTargetId !== tab.targetId) throw new Error('Native browser presentation target is stale');
    const contents = tab.view.webContents;
    const placement = tab.placement; const epoch = tab.navigationEpoch; const generation = this.generation;
    const current = () => this.generation === generation && tab.navigationEpoch === epoch && this.tabs.get(tab.targetId) === tab && (tab.placement?.window === window || tab.placement?.ownerWindow === window) && tab.placement?.window === placement?.window && tab.placement?.mode === placement?.mode && window.isVisible?.() !== false && placement.window.isVisible?.() !== false && !contents.isDestroyed();
    const result = (health, extra = {}) => ({ ...this.state(tab), presentationHealth: health, ...extra });
    if (!current()) return result('unavailable');
    if (tab.crashed || tab.lastError) return result('failed');
    if (contents.isLoadingMainFrame()) return result('loading');
    // 비밀 보호 페이지는 캡처 경로를 열지 않는다. 픽셀이나 본문은 반환하지 않는다.
    if (tab.passwordShield || contents.getURL() === 'about:blank') return result('ready');
    let accepting = true;
    const within = (promise, ms, fallback = null) => { let timer; return Promise.race([promise, new Promise(resolve => { timer = setTimeout(() => resolve(fallback), ms); })]).finally(() => clearTimeout(timer)); };
    const whiteFrame = image => {
      if (!image || image.isEmpty()) return false;
      const bitmap = image.toBitmap();
      if (!bitmap.length) return false;
      for (let offset = 0; offset < bitmap.length; offset += 4) {
        if (bitmap[offset] < 248 || bitmap[offset + 1] < 248 || bitmap[offset + 2] < 248 || !bitmap[offset + 3]) return false;
      }
      return true;
    };
    const capture = async () => {
      if (!accepting || !current() || tab.passwordShield) return null;
      try { return await contents.capturePage({}, { stayAwake: true }); } catch { return null; }
    };
    // 다시 그려도 비어 있으면 입력·제출 결과가 없는 페이지만 자동으로 다시 열 수 있다.
    const stalled = async () => {
      let reloadSafe = false;
      try {
        const history = await within(contents.debugger.sendCommand('Page.getNavigationHistory'), 500);
        reloadSafe = !!history && history.entries?.[history.currentIndex]?.transitionType !== 'form_submit'
          && await within(contents.executeJavaScript(PAGE_STATE_SCRIPT), 500, true) === false;
      } catch {}
      return current() ? result('paint-timeout', { presentationReloadSafe: reloadSafe && !tab.passwordShield }) : result('unavailable');
    };
    try {
      const paint = async () => {
        await this.viewport(tab, tab.view.getBounds());
        let image = await capture();
        if ((!image || image.isEmpty() || whiteFrame(image)) && accepting && current() && !tab.passwordShield) {
          // 첫 부착 프레임은 아직 비어 있을 수 있다. 다시 열기 전에 다시 그리고 합성을 기다린다.
          contents.invalidate();
          await contents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
          image = await capture();
        }
        return image;
      };
      let image = await within(paint(), 1500);
      if (!image || image.isEmpty()) {
        accepting = current() && !tab.passwordShield;
        if (accepting) { contents.invalidate(); image = await within(capture(), 1000); }
      }
      accepting = false;
      if (!current()) return result('unavailable');
      if (tab.passwordShield) return result('ready');
      if (!image || image.isEmpty()) return stalled();
      if (!whiteFrame(image)) return result('ready');
      // 흰 화면만으로 정상 빈 문서를 다시 열지 않는다. 예상되는 가시 콘텐츠 유무만 확인한다.
      if (!current() || tab.passwordShield) return result(tab.passwordShield ? 'ready' : 'unavailable');
      const expectedPaint = await within(contents.executeJavaScript(`(() => {
          const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
          let node = document.body;
          for (let count = 0; node && count < 200; count++, node = walker.nextNode()) {
            const el = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
            const rect = el.getBoundingClientRect(); const style = getComputedStyle(el);
            const visible = rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth
              && style.visibility === 'visible' && style.display !== 'none' && Number(style.opacity) > 0;
            if (visible && (/^(IMG|VIDEO|CANVAS|INPUT|BUTTON)$/.test(el.tagName)
              || (node.nodeType === Node.TEXT_NODE && !!node.nodeValue.trim() && !/rgba?\\(255, 255, 255/.test(style.color)))) return true;
          }
          return false;
        })()`), 500, false);
      if (!current()) return result('unavailable');
      return !tab.passwordShield && expectedPaint ? stalled() : result('ready');
    } catch { return !current() ? result('unavailable') : tab.passwordShield ? result('ready') : stalled(); }
    finally { accepting = false; }
  }

  setQuitRequested(requested) { this.quitRequested = requested === true; }

  placeGuest(tab, window) {
    if (tab.parkingWindow && !tab.parkingWindow.isDestroyed()) tab.parkingWindow.contentView.removeChildView(tab.view);
    tab.parkingWindow = null;
    tab.dialogParking = null;
    window.contentView.addChildView(tab.view);
    for (const other of this.tabs.values()) if (other !== tab && other.placement?.window === window && other.placement.mode === 'float') this.raiseFloat(other);
  }

  parkGuest(tab) {
    if (this.disposing || tab.closing || tab.view.webContents.isDestroyed()) return;
    // An ownerless guest makes Electron's website alert app-modal on macOS.
    // A BaseWindow keeps native dialogs asynchronous without another renderer.
    if (!this.parkingWindow || this.parkingWindow.isDestroyed()) {
      this.parkingWindow = new this.BaseWindow({ show: false, skipTaskbar: true, title: 'Hama 브라우저' });
      if (this.platform === 'win32') {
        this.parkingWindow.setOpacity(0);
        this.parkingWindow.setFocusable(false);
        this.parkingWindow.setIgnoreMouseEvents(true);
      }
    }
    this.parkingWindow.contentView.addChildView(tab.view);
    // Keep the guest hidden at rest and retain its native parent for capture.
    tab.view.setVisible(true);
    tab.parkingWindow = this.parkingWindow;
  }

  async withCaptureSurface(tab, capture) {
    const window = this.parkingWindow;
    if (this.platform !== 'win32' || !window || window.isDestroyed() || tab.parkingWindow !== window) return capture();
    const leases = this.captureSurfaces.get(window) ?? 0;
    this.captureSurfaces.set(window, leases + 1);
    let timer;
    try {
      // Windows requires a mapped surface; keep it transparent and non-activating.
      if (!leases) window.showInactive();
      return await Promise.race([
        Promise.resolve().then(capture),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Native browser capture timed out')), CAPTURE_SURFACE_TIMEOUT_MS); }),
      ]);
    } finally {
      clearTimeout(timer);
      const remaining = this.captureSurfaces.get(window) - 1;
      if (remaining) this.captureSurfaces.set(window, remaining);
      else {
        this.captureSurfaces.delete(window);
        if (!window.isDestroyed()) window.hide();
      }
    }
  }

  onJavaScriptDialog(tab, method) {
    if (tab.closing || tab.view.webContents.isDestroyed() || this.tabs.get(tab.targetId) !== tab) return;
    if (method === 'Page.javascriptDialogOpening') {
      tab.dialogOpen = true;
      if (tab.placement || !tab.sessionId) return;
      const window = this.getWindowForSession(tab.sessionId);
      if (!window || window.isDestroyed() || window.id !== tab.windowId) return;
      // CDP announces the dialog before Electron selects its native parent.
      // Keep the guest hidden while the user's editor displays the async sheet.
      this.placeGuest(tab, window);
      tab.view.setVisible(false);
      tab.parkingWindow = window;
      tab.dialogParking = { window, targetId: tab.targetId, generation: this.generation };
    } else if (method === 'Page.javascriptDialogClosed') {
      tab.dialogOpen = false;
      // 대화상자가 열린 동안 미룬 포커스 흉내를 지금 맞춘다.
      if (tab.activitySyncDeferred) { tab.activitySyncDeferred = false; void this.syncActivity(tab).catch(() => {}); }
      const parking = tab.dialogParking;
      tab.dialogParking = null;
      if (!parking || tab.placement || tab.parkingWindow !== parking.window
        || parking.targetId !== tab.targetId || parking.generation !== this.generation) return;
      this.unplace(tab);
    }
  }

  unplace(tab) {
    tab.lastHiddenAt = Date.now();
    this.agentCursor?.hideTab(tab);
    const placement = tab.placement;
    if (placement && !placement.window.isDestroyed()) placement.window.contentView.removeChildView(tab.view);
    if (tab.parkingWindow && !tab.parkingWindow.isDestroyed()) tab.parkingWindow.contentView.removeChildView(tab.view);
    tab.parkingWindow = null;
    tab.dialogParking = null;
    tab.view.setVisible(false);
    tab.placement = null;
    tab.interactive = false;
    if (tab.view.webContents && !tab.view.webContents.isDestroyed()) this.setViewRadius(tab, 0);
    this.parkGuest(tab);
    if (!tab.closing && !tab.view.webContents.isDestroyed()) void this.viewport(tab, tab.view.getBounds()).catch(() => {});
  }

  async sleep({ targetId, tabId, idleMs, manual = false, discard = false }) {
    const tab = this.tab(targetId); const contents = tab.view.webContents;
    const safe = () => tab.tabId === tabId && (manual || !tab.placement) && !tab.activityLeases?.size
      && !tab.openerTargetId && ![...this.tabs.values()].some(child => child.openerTargetId === tab.targetId)
      && !tab.closing && (manual || !tab.passwordShield) && !contents.isDestroyed() && !contents.isLoading()
      && !contents.isCurrentlyAudible() && this.downloads.size === 0
      && (manual || Date.now() - (tab.lastHiddenAt ?? Date.now()) >= idleMs)
      && (manual || !this.popouts.get(tab.targetId)?.isVisible());
    if (!safe()) return { sleeping: false };
    // 입력 값은 밖으로 보내지 않고 작성 중인 폼과 재생 중인 미디어는 유지한다.
    let protectedPage = true;
    try {
      protectedPage = await contents.executeJavaScript(PAGE_STATE_SCRIPT);
    } catch {}
    if (!safe()) return { sleeping: false, reason: 'busy' };
    if ((protectedPage || tab.passwordShield) && !(manual && discard)) return { sleeping: false, reason: 'protected' };
    this.closeGuest(tab);
    return { sleeping: true };
  }

  detach(window, { tabId }) {
    const tab = this.ownedTab(tabId, window);
    this.unplace(tab);
    const popout = this.popouts.get(tab.targetId);
    if (popout && !popout.isDestroyed()) popout.hide();
    this.emit(tab, 'presentation');
    return this.state(tab);
  }

  popout(ownerWindow, tab, bare = false, title = null) {
    this.unplace(tab);
    // 로그인 전용 창은 도구 막대 없이 페이지만 창 전체에 보이고, 제목은 서비스 이름이다.
    tab.popoutBare = bare;
    tab.popoutTitle = title;
    let popout = this.popouts.get(tab.targetId);
    if (!popout || popout.isDestroyed()) {
      popout = new this.BrowserWindow({ width: 1000, height: 760, minWidth: 420, minHeight: 320, title: 'Browser', show: false,
        webPreferences: { preload: POPOUT_PRELOAD, sandbox: true, nodeIntegration: false, contextIsolation: true, webviewTag: false } });
      this.popouts.set(tab.targetId, popout);
      popout.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      popout.webContents.on('will-navigate', (event) => event.preventDefault());
      popout.on('resize', () => this.layoutPopout(tab, popout));
      popout.on('page-title-updated', (event) => { if (tab.popoutTitle) event.preventDefault(); });
      popout.on('close', (event) => {
        if (this.disposing) return;
        if (this.quitRequested) {
          this.unplace(tab);
          this.popouts.delete(tab.targetId);
          return;
        }
        event.preventDefault();
        this.unplace(tab); popout.hide(); this.emit(tab, 'presentation');
      });
      popout.webContents.once('did-finish-load', () => this.emit(tab, 'state'));
      void popout.loadURL(POPOUT_URL);
    }
    popout.setTitle(tab.popoutTitle || popout.webContents.getTitle() || 'Browser');
    this.placeGuest(tab, popout);
    tab.placement = { window: popout, ownerWindow, mode: 'popout' };
    tab.interactive = tab.human;
    tab.view.setVisible(true);
    this.layoutPopout(tab, popout);
    popout.show();
    this.emit(tab, 'presentation');
    return this.state(tab);
  }

  /** 이 탭에서 Chrome 로그인을 권할 사이트. 숨겼으면 null이다. */
  chromeSignInOffer(tab) {
    const offer = tab.chromeSignIn;
    return offer && !offer.dismissed ? { siteUrl: offer.siteUrl, host: new URL(offer.siteUrl).hostname, reason: offer.reason } : null;
  }

  /** 로그인할 사이트 주소. 로그인 제공자 페이지면 그 페이지를 연 사이트(팝업의 부모나 직전 사이트)다. */
  chromeSignInSite(tab, rawUrl) {
    let url; try { url = new URL(rawUrl); } catch { return null; }
    if (url.protocol !== 'https:') return null;
    if (!CHROME_SIGN_IN_HOSTS.has(url.hostname)) return url.href;
    const opener = tab.openerTargetId && this.tabs.get(tab.openerTargetId);
    const openerUrl = opener && !opener.view.webContents.isDestroyed() ? opener.view.webContents.getURL() : null;
    return [openerUrl, tab.lastSiteUrl].find((candidate) => { try { const parsed = new URL(candidate); return parsed.protocol === 'https:' && !CHROME_SIGN_IN_HOSTS.has(parsed.hostname); } catch { return false; } }) ?? null;
  }

  offerChromeSignIn(tab, reason) {
    if (process.platform !== 'darwin' || !tab.tabId || tab.closing || tab.view.webContents.isDestroyed()) return;
    const siteUrl = this.chromeSignInSite(tab, tab.view.webContents.getURL());
    if (!siteUrl) return;
    const host = new URL(siteUrl).hostname;
    // 같은 사이트에서 숨긴 제안은 다시 띄우지 않는다.
    if (tab.chromeSignIn && new URL(tab.chromeSignIn.siteUrl).hostname === host && (tab.chromeSignIn.dismissed || tab.chromeSignIn.siteUrl === siteUrl)) return;
    tab.chromeSignIn = { siteUrl, reason, dismissed: false };
    this.refreshChromeSignIn(tab);
  }

  dismissChromeSignIn(tab) {
    if (!tab.chromeSignIn || tab.chromeSignIn.dismissed) return;
    tab.chromeSignIn.dismissed = true;
    this.refreshChromeSignIn(tab);
  }

  trackChromeSignIn(tab, rawUrl) {
    let url; try { url = new URL(rawUrl); } catch { return; }
    if (CHROME_SIGN_IN_HOSTS.has(url.hostname)) { this.offerChromeSignIn(tab, 'identity-provider'); return; }
    if (url.protocol === 'https:') tab.lastSiteUrl = url.href;
    // 다른 사이트로 옮기면 이전 사이트의 제안을 지운다.
    if (tab.chromeSignIn && new URL(tab.chromeSignIn.siteUrl).hostname !== url.hostname) { tab.chromeSignIn = null; this.refreshChromeSignIn(tab); }
  }

  /** 편집기가 알린 Chrome 로그인 상태. 모든 띄운 창이 진행 중임을 보이고 페이지 영역을 맞춘다. */
  setChromeSignInState({ site = null } = {}) {
    const next = typeof site === 'string' && site ? site.slice(0, 253) : null;
    if (next === (this.chromeSignInActiveSite ?? null)) return { site: next };
    this.chromeSignInActiveSite = next;
    for (const tab of this.tabs.values()) if (tab.tabId && (this.popouts.has(tab.targetId) || tab.chromeSignIn)) this.refreshChromeSignIn(tab);
    return { site: next };
  }

  refreshChromeSignIn(tab) {
    const popout = this.popouts.get(tab.targetId);
    if (popout && !popout.isDestroyed()) this.layoutPopout(tab, popout);
    this.emit(tab, 'chrome-sign-in');
  }

  layoutPopout(tab, popout) {
    if (tab.placement?.window !== popout) return;
    const { width, height } = popout.getContentBounds();
    const top = (tab.popoutBare ? 0 : 76) + (this.chromeSignInOffer(tab) || this.chromeSignInActiveSite ? CHROME_SIGN_IN_BAR : 0);
    const bounds = { x: 0, y: top, width, height: Math.max(0, height - top) };
    tab.view.setBounds(bounds);
    void this.viewport(tab, bounds).catch(() => {});
  }

  zoom(window, { tabId, factor }) {
    const tab = this.ownedTab(tabId, window);
    if (!Number.isFinite(factor)) throw new Error('Native browser zoom factor is invalid');
    const previous = new Map([...this.tabs.values()].map((entry) => [entry, this.state(entry).zoomFactor]));
    tab.view.webContents.setZoomFactor(Math.max(0.25, Math.min(3, factor)));
    // Chromium shares website zoom across guests with the same origin.
    const changed = [...previous].filter(([entry, before]) => Math.abs(this.state(entry).zoomFactor - before) > 0.000001).map(([entry]) => entry);
    for (const entry of changed) {
      entry.passwordSnapshot = null;
      entry.passwordControlEpoch = (entry.passwordControlEpoch ?? 0) + 1;
    }
    for (const entry of changed) this.emit(entry, 'zoom');
    return this.state(tab);
  }

  async navigate(window, { tabId, url }) {
    const tab = this.ownedTab(tabId, window);
    if (!tab.human) throw new Error('Take control before navigating the native browser');
    await tab.view.webContents.loadURL(browserNavigationUrl(url));
    return this.state(tab);
  }

  navigation(window, { tabId, expectedTargetId, navigationEpoch, recovery }, command) {
    const tab = this.ownedTab(tabId, window);
    if (!tab.human) throw new Error('Take control before navigating the native browser');
    if (expectedTargetId !== undefined && expectedTargetId !== tab.targetId) throw new Error('Native browser presentation target is stale');
    if (navigationEpoch !== undefined && navigationEpoch !== tab.navigationEpoch) throw new Error('Native browser presentation navigation is stale');
    const contents = tab.view.webContents;
    if (command === 'reload' && recovery === true && tab.crashed) {
      this.closeGuest(tab);
      return { restoreRequired: true };
    }
    if (command === 'back' && contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack();
    else if (command === 'forward' && contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward();
    else if (command === 'reload') { tab.crashed = false; tab.lastError = null; if (recovery === true) void contents.loadURL(browserNavigationUrl(contents.getURL())).catch(() => {}); else contents.reload(); }
    else if (command === 'stop') contents.stop();
    return this.state(tab);
  }

  control({ targetId, tabId, human, owner, held }) {
    const tab = this.tab(targetId ?? tabId);
    void this.clearActivity(tab);
    tab.passwordControlEpoch = (tab.passwordControlEpoch ?? 0) + 1;
    tab.passwordSnapshot = null;
    this.webAuthn?.cancelTab(tab);
    tab.human = human === true || owner === 'human';
    // held를 주지 않으면 사용자 점유를 유지한다. 에이전트에게 넘긴 탭은 점유가 없다.
    tab.held = tab.human && (typeof held === 'boolean' ? held : tab.held === true);
    // 물리 입력은 조작권과 렌더러의 배치 요청을 함께 따른다. 에이전트 미리보기 중에는 잠긴 채로 둔다.
    tab.interactive = tab.human && !!tab.placement && (tab.placement.mode === 'popout' || tab.requestedInteractive === true);
    this.emit(tab, 'controller');
    return this.state(tab);
  }

  /**
   * 사용자가 직접 누른 웹사이트 파일 칸에 운영체제 파일 창을 연다. 허브는 고른 경로를 그 칸에 넣는다.
   * 사용자가 조작하는 화면에 놓인 탭만 연다. 에이전트 미리보기와 숨은 탭은 거절한다.
   */
  async chooseFiles({ targetId, tabId, multiple, accept }) {
    const tab = this.tab(targetId ?? tabId);
    const window = tab.placement?.window;
    if (!this.dialog || !tab.human || !tab.interactive || tab.automationInputDepth || !window || window.isDestroyed()) throw new Error('The user is not controlling this browser tab');
    const filters = fileChooserFilters(accept);
    const result = await this.dialog.showOpenDialog(window, { properties: ['openFile', ...(multiple === true ? ['multiSelections'] : [])], ...(filters ? { filters } : {}) });
    if (result.canceled || tab.closing || tab.view.webContents.isDestroyed()) return { paths: [] };
    return { paths: multiple === true ? result.filePaths : result.filePaths.slice(0, 1) };
  }

  popoutCommand(sender, { command, url, factor } = {}) {
    const pair = [...this.popouts].find(([, window]) => window.webContents === sender && !window.isDestroyed());
    if (!pair) throw new Error('Browser popout sender is not owned');
    const tab = this.tab(pair[0]);
    const ownerWindow = this.getWindowForSession(tab.sessionId);
    if (!ownerWindow) throw new Error('Browser popout owner is unavailable');
    if (command === 'zoom') return this.zoom(ownerWindow, { tabId: tab.tabId, factor });
    if (command === 'close') return this.detach(ownerWindow, { tabId: tab.tabId });
    if (command === 'chrome-sign-in-dismiss') { this.dismissChromeSignIn(tab); return { dismissed: true }; }
    if (['chrome-sign-in', 'chrome-sign-in-finish', 'chrome-sign-in-cancel'].includes(command)) {
      // 허브 요청은 편집기 창이 보낸다. 창은 같은 명령을 받아 Chrome 로그인을 시작하거나 끝낸다.
      this.emit(tab, 'presentation-command', { command, ...(command === 'chrome-sign-in' ? { url: this.chromeSignInOffer(tab)?.siteUrl ?? null } : {}) });
      return { queued: true };
    }
    if (['dock', 'take-control', 'return-agent', 'annotate', 'capture', 'downloads', 'navigate'].includes(command)) {
      if (command === 'dock') this.detach(ownerWindow, { tabId: tab.tabId });
      this.emit(tab, 'presentation-command', { command, ...(command === 'navigate' ? { url } : {}) });
      return { queued: true };
    }
    if (command === 'navigate') return this.navigate(ownerWindow, { tabId: tab.tabId, url });
    if (['back', 'forward', 'reload', 'stop'].includes(command)) return this.navigation(ownerWindow, { tabId: tab.tabId }, command);
    throw new Error('Unsupported browser popout command');
  }

  closeTab(targetId) {
    const tab = this.tabs.get(targetId);
    if (!tab) return false;
    return this.closeGuest(tab);
  }

  closeGuest(tab) {
    void this.clearActivity(tab);
    tab.closing = true;
    this.tabs.delete(tab.targetId);
    if (tab.tabId && this.aliases.get(tab.tabId) === tab.targetId) this.aliases.delete(tab.tabId);
    this.webAuthn?.cancelTab(tab);
    this.unplace(tab);
    this.cdp.remove(tab.targetId);
    const popout = this.popouts.get(tab.targetId);
    if (popout && !popout.isDestroyed()) popout.destroy();
    this.popouts.delete(tab.targetId);
    const contents = tab.view.webContents;
    if (contents && !contents.isDestroyed()) contents.close({ waitForBeforeUnload: false });
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
      url: tab.passwordShield ? this.state(tab).url : item.getURL(), suggestedFilename: tab.passwordShield ? 'download' : item.getFilename() } });
    const progress = (state) => this.cdp.send({ method: 'Browser.downloadProgress', params: {
      guid, totalBytes: item.getTotalBytes(), receivedBytes: item.getReceivedBytes(), state,
      ...(state === 'completed' ? { filePath: item.getSavePath() } : {}),
    } });
    item.on('updated', () => { progress('inProgress'); this.emit(tab, 'download-progress', { filename: tab.passwordShield ? 'download' : item.getFilename(), receivedBytes: item.getReceivedBytes(), totalBytes: item.getTotalBytes() }); });
    item.once('done', (_event, state) => { progress(state === 'completed' ? 'completed' : 'canceled'); this.downloads.delete(guid); });
  }

  async revealDownload({ filePath }) {
    const root = await realpath(join(os.homedir(), 'Downloads'));
    const file = await realpath(filePath);
    const within = relative(root, file), info = await lstat(filePath);
    if (!within || within === '..' || within.startsWith('..' + sep) || isAbsolute(within) || !info.isFile() || info.isSymbolicLink()) throw new Error('Download file is unavailable');
    const { shell } = await import('electron'); shell.showItemInFolder(file); return { revealed: true };
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
      const details = { ...cookie, url,
        ...(cookie.expires >= 0 ? { expirationDate: cookie.expires } : {}),
        sameSite: { None: 'no_restriction', Lax: 'lax', Strict: 'strict' }[cookie.sameSite] ?? 'unspecified' };
      // Chromium 체크포인트의 점 없는 domain은 host-only다. domain을 넘기면
      // Electron이 도메인 쿠키로 바꾸어 유효한 __Host- 인증 쿠키도 거부한다.
      if (cookie.hostOnly === true || cookie.domain && !cookie.domain.startsWith('.')) delete details.domain;
      await this.session.cookies.set(details);
    }
    await this.session.cookies.flushStore();
    return {};
  }
  async clearCookies() { await this.session.clearStorageData({ storages: ['cookies'] }); return {}; }

  async importSession({ origins, state, clear = false, reload = false }) {
    if (!Array.isArray(origins) || !origins.length || origins.length > 32 || !state || !Array.isArray(state.cookies) || !Array.isArray(state.origins) || state.cookies.length > 2048) throw new Error('Native session import is invalid');
    const approved = new Set(origins.map((value) => {
      const url = new URL(value);
      if (url.protocol !== 'https:' || url.username || url.password || url.origin !== value) throw new Error('Native session import requires approved exact HTTPS origins');
      return value;
    }));
    if (clear) return this.clearSession({ origins: [...approved] });
    const hosts = [...approved].map((origin) => new URL(origin).hostname);
    const matches = (cookie) => {
      const domain = String(cookie.domain ?? '').replace(/^\./, '').toLowerCase();
      return !!domain && hosts.some((host) => host === domain || domain.includes('.') && host.endsWith(`.${domain}`));
    };
    if (state.cookies.some((cookie) => !matches(cookie) || typeof cookie.name !== 'string' || typeof cookie.value !== 'string')) throw new Error('Native session cookies exceed the approved account origins');
    const storage = state.origins.map((entry) => {
      if (!approved.has(entry.origin) || !Array.isArray(entry.localStorage) || entry.localStorage.length > 2048 || entry.localStorage.some((item) => typeof item.name !== 'string' || typeof item.value !== 'string')) throw new Error('Native session storage exceeds the approved account origins');
      if (entry.indexedDB?.length) throw Object.assign(new Error('This sign-in session requires IndexedDB storage that native handoff cannot import.'), { code: 'BROWSER_NATIVE_SESSION_STORAGE_UNSUPPORTED' });
      const tab = [...this.tabs.values()].find((candidate) => !candidate.closing && !candidate.view.webContents.isDestroyed() && new URL(candidate.view.webContents.getURL()).origin === entry.origin);
      if (!tab && entry.localStorage.length) throw Object.assign(new Error('Open the approved account website in a native tab before importing this session.'), { code: 'BROWSER_NATIVE_SESSION_STORAGE_UNSUPPORTED' });
      return { entry, tab };
    });
    if (Buffer.byteLength(JSON.stringify(state)) > 16 * 1024 * 1024) throw new Error('Native session import exceeds its size limit');
    const applyStorage = async (tab, origin, entries) => {
      const code = `(${((origin, entries) => {
        if (location.origin !== origin) return false;
        const previous = Object.entries(localStorage).map(([name, value]) => ({ name, value }));
        if (entries) { localStorage.clear(); for (const entry of entries) localStorage.setItem(entry.name, entry.value); }
        return previous;
      }).toString()})(${JSON.stringify(origin)},${JSON.stringify(entries)})`;
      return tab.view.webContents.executeJavaScriptInIsolatedWorld(1007, [{ code }]);
    };
    const previousStorage = [];
    for (const { entry, tab } of storage) if (tab) {
      const previous = await applyStorage(tab, entry.origin, null);
      if (previous === false) throw new Error('The native sign-in page changed before session import');
      previousStorage.push({ tab, origin: entry.origin, previous });
    }
    const previousCookies = (await this.getCookies()).filter(matches);
    const removeScopedCookies = async () => {
      for (const cookie of (await this.getCookies()).filter(matches)) await this.session.cookies.remove(`${cookie.secure ? 'https' : 'http'}://${cookie.domain.replace(/^\./, '')}${cookie.path || '/'}`, cookie.name);
    };
    try {
      await removeScopedCookies(); await this.setCookies(state.cookies);
      for (const { entry, tab } of storage) if (tab && await applyStorage(tab, entry.origin, entry.localStorage) === false) throw new Error('The native sign-in page changed during session import');
      // 승인된 탭을 함께 다시 연다. 전체 기한은 허브 IPC 제한(20초)보다 짧다.
      const reloads = !reload ? [] : [...this.tabs.values()].filter((tab) => {
        if (tab.closing || tab.view.webContents.isDestroyed()) return false;
        try { return approved.has(new URL(tab.view.webContents.getURL()).origin); } catch { return false; }
      }).map((tab) => tab.view.webContents);
      const deadline = Date.now() + 10_000;
      await Promise.all(reloads.map((contents) => new Promise((resolve, reject) => {
        const finish = (error) => { clearTimeout(timer); contents.off('did-finish-load', done); contents.off('did-fail-load', failed); contents.off('destroyed', closed); error ? reject(error) : resolve(); };
        const done = () => finish();
        const failed = (_event, _code, _description, _url, mainFrame) => { if (mainFrame) finish(new Error('Native session reload failed')); };
        const closed = () => finish(new Error('Native session tab closed'));
        const timer = setTimeout(() => finish(new Error('Native session reload timed out')), Math.max(1, deadline - Date.now()));
        contents.once('did-finish-load', done); contents.on('did-fail-load', failed); contents.once('destroyed', closed);
        contents.reload();
      })));
      return { imported: true, cookies: state.cookies.length, origins: storage.filter((item) => item.tab).length, reloaded: reloads.length };
    } catch {
      await removeScopedCookies(); await this.setCookies(previousCookies);
      for (const { tab, origin, previous } of previousStorage) if (!tab.view.webContents.isDestroyed()) await applyStorage(tab, origin, previous).catch(() => {});
      throw new Error('The native account session could not be imported. The prior session was restored.');
    }
  }

  async clearSession({ origins }) {
    if (!Array.isArray(origins) || !origins.length || origins.length > 32) throw new Error('Native session clearing requires approved exact HTTPS origins');
    const normalized = origins.map((origin) => { const url = new URL(origin); if (url.protocol !== 'https:' || url.origin !== origin || url.username || url.password) throw new Error('Native session clearing requires approved exact HTTPS origins'); return url.origin; });
    for (const tab of this.tabs.values()) { tab.passwordSnapshot = null; tab.passwordControlEpoch = (tab.passwordControlEpoch ?? 0) + 1; }
    await this.session.clearData({ origins: normalized, dataTypes: ['cookies', 'localStorage', 'indexedDB', 'serviceWorkers', 'cache'] });
    return { clearedOrigins: normalized, clearedDomains: normalized.map((origin) => new URL(origin).hostname) };
  }

  onDebuggerDetached(tab, reason) {
    void this.clearActivity(tab);
    const contents = tab.view.webContents;
    if (!contents || contents.isDestroyed() || tab.closing) return;
    contents.closeDevTools();
    this.emit(tab, 'debugger-disconnected', { reason, recovery: 'reconnect' });
  }
  onAutomationDisconnected() { for (const tab of this.tabs.values()) { void this.clearActivity(tab); tab.passwordSnapshot = null; tab.passwordControlEpoch = (tab.passwordControlEpoch ?? 0) + 1; this.webAuthn?.cancelTab(tab); tab.human = false; tab.held = false; tab.interactive = false; this.emit(tab, 'runtime-disconnected'); } }

  async release(owner) {
    if (this.owner !== owner) return false;
    if (this.releasePromise) return this.releasePromise;
    this.owner = null;
    this.proxy = null;
    this.releasePromise = (async () => {
      for (const tab of this.pendingTabs) this.closeGuest(tab);
      for (const item of this.downloads.values()) item.cancel();
      await Promise.all([...this.tabs.values()].map((tab) => this.clearActivity(tab)));
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
    this.passwords?.importer.beginReset(); this.passwords?.cookies?.beginReset();
    this.lastOwner = owner;
    this.resetPromise = (async () => {
      await this.releasePromise;
      this.owner = null;
      this.proxy = null;
      this.onAutomationDisconnected();
      for (const item of this.downloads.values()) item.cancel();
      this.downloads.clear();
      await this.cdp.close();
      const guests = [...new Set([...this.tabs.values(), ...this.pendingTabs])];
      const closed = guests.map((tab) => new Promise((resolveClosed) => {
        const contents = tab.view.webContents;
        if (!contents || contents.isDestroyed()) resolveClosed();
        else contents.once('destroyed', resolveClosed);
      }));
      for (const tab of guests) this.closeGuest(tab);
      await Promise.all(closed);
      this.tabs.clear();
      this.aliases.clear();
      this.popouts.clear();
      await this.passwords?.vault.clear();
      this.passwords?.clearProtectedValues();
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
      return { tabsClosed: guests.length, generation: this.generation, nativeStorageCleared: !!this.session };
    })();
    try { return await this.resetPromise; } finally { this.resetPromise = null; this.passwords?.importer.endReset(); this.passwords?.cookies?.endReset(); }
  }

  async handleRequest(message, owner) {
    if (!message || message.type !== 'rhwp-browser-request' || typeof message.id !== 'string') return null;
    const response = { type: 'rhwp-browser-response', id: message.id };
    try {
      const params = message.params ?? {};
      if (message.operation === 'start') response.value = await this.start(params, owner);
      else if (message.operation === 'reset') response.value = await this.reset(owner);
      else if (message.operation === 'password-accounts') response.value = this.passwords ? await this.passwords.vault.list() : { accounts: [] };
      else {
        if (this.owner !== owner) throw new Error('Native browser request owner is stale');
        if (message.operation === 'reveal-download') response.value = await this.revealDownload(params);
        else if (message.operation === 'bind') response.value = this.bind(params);
        else if (message.operation === 'sleep') response.value = await this.sleep(params);
        else if (message.operation === 'activity') response.value = await this.activity(params);
        else if (message.operation === 'control') response.value = this.control(params);
        else if (message.operation === 'choose-files') response.value = await this.chooseFiles(params);
        else if (message.operation === 'release') response.value = await this.release(owner);
        else if (message.operation === 'inventory') response.value = [...this.tabs.values()].map((tab) => this.state(tab));
        else if (message.operation === 'password-accounts') response.value = this.passwords ? await this.passwords.vault.list() : { accounts: [] };
        else if (message.operation === 'password-snapshot') response.value = this.passwords ? await this.passwords.snapshot(params) : { available: false };
        else if (message.operation === 'password-viewport') response.value = this.passwords ? await this.passwords.snapshot(params, { viewportOnly: true }) : { available: false };
        else if (message.operation === 'password-capture') response.value = this.passwords ? await this.passwords.capture(params) : { available: false };
        else if (message.operation === 'password-fill') {
          if (!this.passwords) throw new Error('Native password storage is unavailable');
          response.value = await this.passwords.fill(params);
        }
        else if (message.operation === 'password-action') {
          if (!this.passwords) throw new Error('Native password input is unavailable');
          response.value = await this.passwords.action(params);
        }
        else if (message.operation === 'password-block') {
          if (!this.passwords) throw new Error('Native password storage is unavailable');
          // 허브는 사용자의 설정 변경이나 차단 해제 카드에만 이 동작을 보낸다.
          response.value = await this.passwords.vault.setAgentBlocked(params.accountId, params.blocked);
        }
        else if (message.operation === 'password-save') {
          if (!this.passwords) throw new Error('Native password storage is unavailable');
          // 사용자가 계정 저장 카드에 입력한 로그인이다. 응답에는 비밀번호 없이 계정 정보만 돌려준다.
          response.value = await this.passwords.save(params);
        }
        else if (message.operation === 'password-storage-state') response.value = this.passwords ? await this.passwords.storageState() : null;
        else if (message.operation === 'import-session') response.value = await this.importSession(params);
        else if (message.operation === 'password-clear-session') response.value = await this.clearSession(params);
        else throw new Error('Unsupported native browser operation');
      }
      response.ok = true;
    } catch (error) { response.ok = false; response.error = { message: error.message, code: error.code ?? 'NATIVE_BROWSER_FAILED' }; }
    return response;
  }

  async dispose() {
    this.disposing = true;
    await Promise.all([...this.tabs.values()].map((tab) => this.clearActivity(tab)));
    this.webAuthn?.dispose();
    this.adblock?.dispose();
    await this.cdp.close();
    if (this.session) { this.session.flushStorageData(); await this.session.cookies.flushStore(); }
    for (const tab of new Set([...this.tabs.values(), ...this.pendingTabs])) this.closeGuest(tab);
    this.agentCursor?.dispose();
    if (this.parkingWindow && !this.parkingWindow.isDestroyed()) this.parkingWindow.destroy();
    this.parkingWindow = null;
    this.owner = null;
    this.lastOwner = null;
    this.proxy = null;
  }
}
