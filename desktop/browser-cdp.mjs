import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../rhwp/rhwp-agent/package.json', import.meta.url));
const { WebSocketServer, WebSocket } = require('ws');
const MAX_CDP_MESSAGE_BYTES = 8 * 1024 * 1024;
const PASSWORD_SAFE_COMMANDS = new Set([
  'Log.enable', 'Log.disable',
  'Runtime.enable', 'Runtime.disable', 'Runtime.runIfWaitingForDebugger', 'Runtime.releaseObject', 'Runtime.releaseObjectGroup',
  'Page.enable', 'Page.disable', 'Page.getFrameTree', 'Page.navigate', 'Page.navigateToHistoryEntry', 'Page.getNavigationHistory', 'Page.stopLoading', 'Page.handleJavaScriptDialog', 'Page.setLifecycleEventsEnabled', 'Page.bringToFront',
  'Network.enable', 'Network.disable', 'Network.setCacheDisabled', 'Network.setBypassServiceWorker',
  'Fetch.enable', 'Fetch.disable', 'Fetch.continueRequest', 'Fetch.continueResponse', 'Fetch.continueWithAuth', 'Fetch.failRequest',
  'Emulation.setDeviceMetricsOverride', 'Emulation.clearDeviceMetricsOverride', 'Emulation.setFocusEmulationEnabled', 'Emulation.setEmulatedMedia', 'Emulation.setTouchEmulationEnabled', 'Emulation.setUserAgentOverride',
  'Target.getTargetInfo', 'Target.getTargets', 'Target.attachToTarget', 'Target.detachFromTarget', 'Target.setAutoAttach',
  'Input.dispatchKeyEvent', 'Input.dispatchMouseEvent', 'Input.insertText', 'Input.dispatchTouchEvent', 'Input.cancelDragging',
]);
const PASSWORD_SAFE_EVENTS = /^(Page\.(frame|lifecycleEvent|domContentEventFired|loadEventFired|javascriptDialog)|Network\.(requestWillBeSent|responseReceived|loadingFinished|loadingFailed)|Fetch\.(requestPaused|authRequired)|Runtime\.(executionContextCreated|executionContextDestroyed|executionContextsCleared)|Target\.(attachedToTarget|detachedFromTarget))/;
const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
const RESOURCE_TYPES = new Set(['Document', 'Stylesheet', 'Image', 'Media', 'Font', 'Script', 'TextTrack', 'XHR', 'Fetch', 'EventSource', 'WebSocket', 'Manifest', 'Other']);
const UTILITY_WORLD = /^__playwright_utility_world_page@[0-9a-f]{32}$/;
function safePasswordSetup(tab, method, params) {
  if (method === 'Page.addScriptToEvaluateOnNewDocument' && params.source === '' && UTILITY_WORLD.test(params.worldName) && Object.keys(params).every((key) => ['source', 'worldName'].includes(key))) {
    tab.passwordUtilityWorlds ??= new Set();
    if (tab.passwordUtilityWorlds.size >= 16 && !tab.passwordUtilityWorlds.has(params.worldName)) return false;
    tab.passwordUtilityWorlds.add(params.worldName); return true;
  }
  return method === 'Page.createIsolatedWorld' && tab.passwordUtilityWorlds?.has(params.worldName) && /^[0-9A-Fa-f]{32}$/.test(params.frameId) && params.grantUniveralAccess === true && Object.keys(params).every((key) => ['frameId', 'worldName', 'grantUniveralAccess'].includes(key));
}
function protectedUrl(tab, value) {
  try { const origin = new URL(value).origin; return tab.passwordAllowedOrigins?.has(origin) ? `${origin}/` : 'about:blank'; } catch { return 'about:blank'; }
}
/** Website strings can encode a password. Project protocol metadata instead of forwarding them. */
function passwordEvent(tab, method, params) {
  const result = {};
  for (const key of ['requestId', 'loaderId', 'frameId', 'networkId', 'sessionId']) if (typeof params[key] === 'string') result[key] = params[key];
  for (const key of ['timestamp', 'wallTime', 'encodedDataLength', 'responseStatusCode']) if (Number.isFinite(params[key])) result[key] = params[key];
  if (RESOURCE_TYPES.has(params.type)) result.type = params.type;
  if (RESOURCE_TYPES.has(params.resourceType)) result.resourceType = params.resourceType;
  if (params.request) result.request = { url: protectedUrl(tab, params.request.url), method: METHODS.has(params.request.method) ? params.request.method : 'GET', headers: {}, hasPostData: !!params.request.hasPostData };
  if (params.response) result.response = { url: protectedUrl(tab, params.response.url), status: Number(params.response.status) || 0, statusText: '', headers: {}, mimeType: '', protocol: 'http/1.1', securityState: 'secure' };
  if ('documentURL' in params) result.documentURL = protectedUrl(tab, params.documentURL);
  if ('responseHeaders' in params) result.responseHeaders = [];
  if ('url' in params) result.url = protectedUrl(tab, params.url);
  if (params.frame) result.frame = { id: params.frame.id, parentId: params.frame.parentId, loaderId: params.frame.loaderId, url: protectedUrl(tab, params.frame.url), securityOrigin: protectedUrl(tab, params.frame.url).replace(/\/$/, ''), name: '', mimeType: 'text/html' };
  if (method === 'Page.lifecycleEvent' && ['init', 'DOMContentLoaded', 'load', 'networkAlmostIdle', 'networkIdle', 'firstContentfulPaint'].includes(params.name)) result.name = params.name;
  if (method === 'Page.javascriptDialogOpening') { result.type = ['alert', 'confirm', 'prompt', 'beforeunload'].includes(params.type) ? params.type : 'alert'; result.message = ''; result.defaultPrompt = ''; result.hasBrowserHandler = !!params.hasBrowserHandler; }
  if (method === 'Page.javascriptDialogClosed') result.result = !!params.result;
  if (method === 'Network.loadingFailed') { result.canceled = !!params.canceled; result.errorText = 'Protected browser request failed'; }
  if (method === 'Runtime.executionContextCreated') result.context = { id: params.context?.id, origin: '', name: tab.passwordUtilityWorlds?.has(params.context?.name) ? params.context.name : '', uniqueId: params.context?.uniqueId, auxData: { isDefault: !!params.context?.auxData?.isDefault, type: 'default', frameId: params.context?.auxData?.frameId } };
  if (method === 'Runtime.executionContextDestroyed') { result.executionContextId = params.executionContextId; result.executionContextUniqueId = params.executionContextUniqueId; }
  if (method === 'Target.attachedToTarget') { result.waitingForDebugger = !!params.waitingForDebugger; result.targetInfo = { targetId: params.targetInfo?.targetId, type: 'iframe', title: '', url: protectedUrl(tab, params.targetInfo?.url), attached: true }; }
  return result;
}

// The relay never opens Chromium's app-wide remote debugging port. It lends one
// debugger per owned guest to one authenticated hub process at a time.
export class PrivateBrowserCdp {
  constructor({ host, chromeVersion = process.versions.chrome ?? '0.0.0.0' }) {
    this.host = host;
    this.chromeVersion = chromeVersion;
    this.tabs = new Map();
    this.sessions = new Map();
    this.autoAttach = false;
    this.client = null;
    this.server = null;
    this.wsServer = null;
    this.path = null;
  }

  async listen() {
    if (this.server) return this.endpointURL;
    this.path = `/browser/${randomBytes(32).toString('base64url')}`;
    this.server = createServer((_request, response) => {
      response.writeHead(404, { 'cache-control': 'no-store' });
      response.end();
    });
    this.wsServer = new WebSocketServer({ noServer: true, maxPayload: MAX_CDP_MESSAGE_BYTES });
    this.server.on('upgrade', (request, socket, head) => {
      const checks = { pathMatches: request.url === this.path, originAbsent: !request.headers.origin,
        loopback: request.socket.remoteAddress === '127.0.0.1',
        hostMatches: request.headers.host === `127.0.0.1:${this.server.address().port}`, ownerAvailable: !this.client };
      if (!Object.values(checks).every(Boolean)) {
        console.warn('[owned-browser-cdp] rejected upgrade', JSON.stringify(checks));
        socket.destroy(); return;
      }
      this.wsServer.handleUpgrade(request, socket, head, (client) => this.connect(client));
    });
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', resolve);
    });
    this.endpointURL = `ws://127.0.0.1:${this.server.address().port}${this.path}`;
    return this.endpointURL;
  }

  connect(client) {
    this.client = client;
    this.autoAttach = false;
    this.sessions.clear();
    for (const tab of this.tabs.values()) tab.cdpSessionId = null;
    for (const tab of this.tabs.values()) tab.passwordUtilityWorlds = new Set();
    client.on('message', (bytes) => {
      let message;
      try { message = JSON.parse(String(bytes)); } catch { client.close(1003); return; }
      if (!Number.isSafeInteger(message.id) || typeof message.method !== 'string') {
        client.close(1003); return;
      }
      void this.command(message).then(
        (result) => this.send({ id: message.id, ...(message.sessionId ? { sessionId: message.sessionId } : {}), result: result ?? {} }, client),
        (error) => this.send({ id: message.id, ...(message.sessionId ? { sessionId: message.sessionId } : {}), error: { code: -32000, message: error.message } }, client),
      );
    });
    client.once('close', () => {
      if (this.client !== client) return;
      this.client = null;
      this.autoAttach = false;
      this.sessions.clear();
      for (const tab of this.tabs.values()) tab.cdpSessionId = null;
      this.host.onAutomationDisconnected?.();
    });
    client.on('error', () => {});
  }

  send(message, client = this.client) {
    if (this.host.passwords) for (const tab of this.tabs.values()) message = this.host.passwords.redact(tab, message);
    if (client && this.client === client && client.readyState === WebSocket.OPEN) client.send(JSON.stringify(message));
  }

  async add(tab) {
    const previousTargetId = tab.targetId;
    const debuggerApi = tab.view.webContents.debugger;
    if (debuggerApi.isAttached()) throw new Error('Browser guest debugger is already owned');
    debuggerApi.attach('1.3');
    const { targetInfo } = await debuggerApi.sendCommand('Target.getTargetInfo');
    tab.targetId = targetInfo.targetId;
    tab.targetInfo = { ...targetInfo, type: 'page', attached: true, browserContextId: 'owned-profile' };
    if (tab.openerTargetId) tab.targetInfo.openerId = tab.openerTargetId;
    tab.childSessions = new Set();
    tab.debuggerMessage = (_event, method, params, nativeSessionId) => {
      if (method === 'Target.attachedToTarget' && params?.sessionId) {
        tab.childSessions.add(params.sessionId);
        this.sessions.set(params.sessionId, { tab, nativeSessionId: params.sessionId });
      } else if (method === 'Target.detachedFromTarget' && params?.sessionId) {
        tab.childSessions.delete(params.sessionId);
        this.sessions.delete(params.sessionId);
      }
      if (tab.cdpSessionId) {
        // A website's console, exception or websocket payload can copy or encode
        // filled passwords. The hub receives lifecycle events, never these values.
        if (tab.passwordShield && !PASSWORD_SAFE_EVENTS.test(method)) return;
        if (tab.passwordShield) params = passwordEvent(tab, method, params);
        if (this.host.passwords) params = this.host.passwords.redact(tab, params);
        this.send({ method, params, sessionId: nativeSessionId || tab.cdpSessionId });
      }
    };
    tab.debuggerDetach = (_event, reason) => {
      this.remove(tab.targetId);
      this.host.onDebuggerDetached?.(tab, reason);
    };
    debuggerApi.on('message', tab.debuggerMessage);
    debuggerApi.on('detach', tab.debuggerDetach);
    this.tabs.set(tab.targetId, tab);
    // CDP 타깃 알림 직후 허브가 바인딩할 수 있으므로 먼저 호스트에 등록한다.
    this.host.registerTarget?.(tab, previousTargetId);
    if (this.autoAttach) this.attach(tab);
    return tab.targetId;
  }

  attach(tab, manual = false, parentSessionId = undefined) {
    if (tab.cdpSessionId && !manual) return tab.cdpSessionId;
    const sessionId = `owned-${randomUUID()}`;
    this.sessions.set(sessionId, { tab, nativeSessionId: undefined, manual, parentSessionId });
    if (!manual) tab.cdpSessionId = sessionId;
    this.send({ ...(parentSessionId ? { sessionId: parentSessionId } : {}), method: 'Target.attachedToTarget', params: {
      sessionId, targetInfo: this.targetInfo(tab), waitingForDebugger: false,
    } });
    return sessionId;
  }

  targetInfo(tab) {
    const metadata = { ...tab.targetInfo, url: tab.view.webContents.getURL(), title: tab.view.webContents.getTitle(), attached: true };
    if (tab.passwordShield) { metadata.url = protectedUrl(tab, metadata.url); metadata.title = ''; }
    return this.host.passwords ? this.host.passwords.redact(tab, metadata) : metadata;
  }

  remove(targetId) {
    const tab = this.tabs.get(targetId);
    if (!tab) return;
    this.tabs.delete(targetId);
    for (const [sessionId, entry] of this.sessions) {
      if (entry.tab !== tab) continue;
      this.sessions.delete(sessionId);
      this.send({ method: 'Target.detachedFromTarget', params: { sessionId, targetId } });
    }
    tab.cdpSessionId = null;
    const contents = tab.view.webContents;
    if (contents && !contents.isDestroyed()) {
      const debuggerApi = contents.debugger;
      debuggerApi.off('message', tab.debuggerMessage);
      debuggerApi.off('detach', tab.debuggerDetach);
      if (debuggerApi.isAttached()) debuggerApi.detach();
    }
    this.send({ method: 'Target.targetDestroyed', params: { targetId } });
  }

  async command({ method, params = {}, sessionId }) {
    const entry = sessionId ? this.sessions.get(sessionId) : null;
    if (sessionId && !entry) throw new Error('Browser debugger session is stale');
    if (entry?.tab?.closing || entry?.tab?.view.webContents.isDestroyed?.()) throw new Error('Browser debugger target was closed');
    const shield = entry?.tab?.passwordShield;
    const safeSetup = entry?.tab && safePasswordSetup(entry.tab, method, params);
    if (shield && !PASSWORD_SAFE_COMMANDS.has(method) && !safeSetup) {
      throw new Error('Native saved passwords protect this page. Use the native semantic snapshot and input tools.');
    }
    if (shield && (method === 'Fetch.continueRequest' && ['url', 'method', 'headers', 'postData'].some((key) => params[key] !== undefined)
      || method === 'Fetch.continueResponse' && ['responseHeaders', 'binaryResponseHeaders', 'responsePhrase'].some((key) => params[key] !== undefined)
      || method === 'Page.handleJavaScriptDialog' && params.promptText !== undefined)) throw new Error('Native saved passwords prohibit modifying protected browser requests.');
    if (shield && method === 'Page.navigate') {
      let url; try { url = new URL(params.url); } catch {}
      if (!url || url.href !== 'about:blank' && (url.protocol !== 'https:' || url.username || url.password)) throw new Error('Native saved passwords permit only HTTPS navigation and about:blank.');
    }
    const browserCommand = !sessionId || entry.browser;
    if (browserCommand && method === 'Storage.getCookies' && [...this.tabs.values()].some((tab) => tab.passwordShield)) throw new Error('Native saved passwords protect browser storage.');
    if (method === 'Target.getTargetInfo') {
      const tab = params.targetId ? this.tabs.get(params.targetId) : entry?.tab;
      return { targetInfo: tab ? this.targetInfo(tab) : { targetId: 'owned-browser', type: 'browser', title: '', url: '', attached: true } };
    }
    if (method === 'Target.attachToTarget') {
      const tab = this.tabs.get(params.targetId);
      if (!tab) throw new Error('Browser tab is unavailable');
      return { sessionId: this.attach(tab, true, sessionId) };
    }
    if (method === 'Target.detachFromTarget') {
      const attached = this.sessions.get(params.sessionId);
      if (attached?.manual) {
        this.sessions.delete(params.sessionId);
        this.send({ ...(attached.parentSessionId ? { sessionId: attached.parentSessionId } : {}), method: 'Target.detachedFromTarget', params: { sessionId: params.sessionId, targetId: attached.tab.targetId } });
        return {};
      }
      if (attached?.nativeSessionId) return attached.tab.view.webContents.debugger.sendCommand(method, params);
      return {};
    }
    if (browserCommand) {
      switch (method) {
        case 'Browser.getVersion': return {
          protocolVersion: '1.3', product: `Chrome/${this.chromeVersion}`,
          userAgent: this.host.session?.getUserAgent?.() ?? `Chrome/${this.chromeVersion}`, revision: '', jsVersion: process.versions.v8,
        };
        case 'Target.setAutoAttach':
          this.autoAttach = params.autoAttach === true;
          if (this.autoAttach) for (const tab of this.tabs.values()) this.attach(tab);
          return {};
        case 'Target.setDiscoverTargets': return {};
        case 'Target.getTargets': return { targetInfos: [...this.tabs.values()].map((tab) => this.targetInfo(tab)) };
        case 'Target.getBrowserContexts': return { browserContextIds: [] };
        case 'Target.attachToBrowserTarget': {
          const id = `owned-browser-${randomUUID()}`;
          this.sessions.set(id, { browser: true });
          return { sessionId: id };
        }
        case 'Target.createTarget': {
          if (params.browserContextId) throw new Error('Native browser uses its owned shared profile');
          const tab = await this.host.createTab({ url: params.url ?? 'about:blank' });
          if (this.autoAttach) this.attach(tab);
          return { targetId: tab.targetId };
        }
        case 'Target.closeTarget': return { success: this.host.closeTab(params.targetId) };
        case 'Browser.close':
          // Playwright disconnect must never close the editor or surviving tabs.
          { const client = this.client; queueMicrotask(() => client?.close(1000)); }
          return {};
        case 'Browser.setDownloadBehavior': return this.host.setDownloadBehavior(params);
        case 'Browser.cancelDownload': return this.host.cancelDownload(params.guid);
        case 'Browser.getWindowForTarget': return { windowId: 1, bounds: { left: 0, top: 0, width: 1280, height: 800, windowState: 'normal' } };
        case 'Browser.getWindowBounds': return { bounds: { left: 0, top: 0, width: 1280, height: 800, windowState: 'normal' } };
        case 'Browser.setWindowBounds': return {};
        case 'Browser.setPermission':
        case 'Browser.grantPermissions':
        case 'Browser.resetPermissions': throw new Error('Native website permissions require human approval');
        case 'Storage.getCookies': return { cookies: await this.host.getCookies() };
        case 'Storage.setCookies': return this.host.setCookies(params.cookies ?? []);
        case 'Storage.clearCookies': return this.host.clearCookies();
        default: throw new Error(`Unsupported owned browser command: ${method}`);
      }
    }
    if (!method.startsWith('Input.')) {
      let result;
      try { result = await entry.tab.view.webContents.debugger.sendCommand(method, params, entry.nativeSessionId); }
      catch (error) { if (entry.tab.passwordShield || entry.tab.closing || entry.tab.view.webContents.isDestroyed?.()) throw new Error('Native browser command failed'); throw error; }
      if (entry.tab.closing || entry.tab.view.webContents.isDestroyed?.()) throw new Error('Browser debugger target was closed');
      // A read that started before the vault fill must not return after protection began.
      if (entry.tab.passwordShield && !PASSWORD_SAFE_COMMANDS.has(method) && !safeSetup) throw new Error('Native saved passwords protect this page. Use the native semantic snapshot and input tools.');
      if (entry.tab.passwordShield && method === 'Page.getFrameTree') {
        const project = (tree) => ({ frame: passwordEvent(entry.tab, 'Page.frameNavigated', { frame: tree.frame }).frame, ...(tree.childFrames ? { childFrames: tree.childFrames.map(project) } : {}) });
        return result.frameTree ? { frameTree: project(result.frameTree) } : {};
      }
      if (entry.tab.passwordShield && method === 'Page.getNavigationHistory') return { currentIndex: result.currentIndex, entries: (result.entries ?? []).map((history) => ({ id: history.id, url: protectedUrl(entry.tab, history.url), userTypedURL: '', title: '', transitionType: 'other' })) };
      if (method === 'Emulation.setDeviceMetricsOverride') entry.tab.viewport = { width: params.width, height: params.height };
      if (method === 'Emulation.clearDeviceMetricsOverride') entry.tab.viewport = null;
      return this.host.passwords ? this.host.passwords.redact(entry.tab, result) : result;
    }
    entry.tab.automationInputDepth = (entry.tab.automationInputDepth ?? 0) + 1;
    try { return await entry.tab.view.webContents.debugger.sendCommand(method, params, entry.nativeSessionId); }
    finally { entry.tab.automationInputDepth -= 1; }
  }

  async disconnect() {
    const client = this.client;
    this.client = null;
    this.autoAttach = false;
    this.sessions.clear();
    for (const tab of this.tabs.values()) {
      tab.cdpSessionId = null;
      // A failed hub must not leave requests indefinitely paused by Fetch.
      await tab.view.webContents.debugger.sendCommand('Fetch.disable').catch(() => {});
      await tab.view.webContents.debugger.sendCommand('Input.cancelDragging').catch(() => {});
      for (const method of ['Runtime.disable', 'Page.disable', 'Network.disable', 'Log.disable']) {
        await tab.view.webContents.debugger.sendCommand(method).catch(() => {});
      }
      await tab.view.webContents.debugger.sendCommand('Target.setAutoAttach', { autoAttach: false, waitForDebuggerOnStart: false, flatten: true }).catch(() => {});
    }
    client?.terminate();
  }

  async close() {
    await this.disconnect();
    const server = this.server;
    const wsServer = this.wsServer;
    this.server = null;
    this.wsServer = null;
    if (wsServer) await new Promise((resolve) => wsServer.close(resolve));
    if (server) await new Promise((resolve) => server.close(resolve));
  }
}
