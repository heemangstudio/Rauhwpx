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
const RESOURCE_TYPES = new Set(['Document', 'Stylesheet', 'Image', 'Media', 'Font', 'Script', 'TextTrack', 'XHR', 'Fetch', 'Prefetch', 'EventSource', 'WebSocket', 'Manifest', 'SignedExchange', 'Ping', 'CSPViolationReport', 'Preflight', 'FedCM', 'Other']);
const INITIATOR_TYPES = new Set(['parser', 'script', 'preload', 'SignedExchange', 'preflight', 'FedCM', 'other']);
const UTILITY_WORLD = /^__playwright_utility_world_page@[0-9a-f]{32}$/;
const REDIRECTED_BODY_LIMIT = 64;
const TEARDOWN_COMMAND_TIMEOUT_MS = 500;
/** 결과·실패와 상관없이 늦어도 ms 뒤에는 끝난다. 정리 명령에만 쓴다. */
function settleWithin(promise, ms) {
  let timer;
  return Promise.race([
    promise.catch(() => {}),
    new Promise((resolve) => { timer = setTimeout(resolve, ms); }),
  ]).finally(() => clearTimeout(timer));
}
function safePasswordSetup(tab, method, params) {
  // 일반 새로고침은 값을 읽지 않는다. 재로딩 시 실행할 스크립트는 허용하지 않는다.
  if (method === 'Page.reload') return Object.keys(params).every(key => key === 'ignoreCache') && (params.ignoreCache === undefined || typeof params.ignoreCache === 'boolean');
  if (method === 'Page.addScriptToEvaluateOnNewDocument' && params.source === '' && UTILITY_WORLD.test(params.worldName) && Object.keys(params).every((key) => ['source', 'worldName'].includes(key))) {
    tab.passwordUtilityWorlds ??= new Set();
    if (tab.passwordUtilityWorlds.size >= 16 && !tab.passwordUtilityWorlds.has(params.worldName)) return false;
    tab.passwordUtilityWorlds.add(params.worldName); return true;
  }
  return method === 'Page.createIsolatedWorld' && tab.passwordUtilityWorlds?.has(params.worldName) && /^[0-9A-Fa-f]{32}$/.test(params.frameId) && params.grantUniveralAccess === true && Object.keys(params).every((key) => ['frameId', 'worldName', 'grantUniveralAccess'].includes(key));
}
/**
 * 보호된 탭의 주소는 출처만 남긴다. 경로·쿼리는 비밀번호를 담을 수 있다. 출처는 네이티브 스냅샷도 이미 알려 주고,
 * 허브가 이 출처로 사이트 판정을 하므로 가리지 않는다. 웹 주소가 아니면 about:blank 다.
 */
export function protectedUrl(value) {
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) ? `${url.origin}/` : 'about:blank'; } catch { return 'about:blank'; }
}
/** Website strings can encode a password. Project protocol metadata instead of forwarding them. */
function passwordEvent(tab, method, params) {
  const result = {};
  for (const key of ['requestId', 'loaderId', 'frameId', 'networkId', 'sessionId']) if (typeof params[key] === 'string') result[key] = params[key];
  for (const key of ['timestamp', 'wallTime', 'encodedDataLength', 'responseStatusCode']) if (Number.isFinite(params[key])) result[key] = params[key];
  if (RESOURCE_TYPES.has(params.type)) result.type = params.type;
  if (RESOURCE_TYPES.has(params.resourceType)) result.resourceType = params.resourceType;
  if (params.request) result.request = { url: protectedUrl(params.request.url), method: METHODS.has(params.request.method) ? params.request.method : 'GET', headers: {}, hasPostData: !!params.request.hasPostData };
  const response = (value) => ({ url: protectedUrl(value.url), status: Number(value.status) || 0, statusText: '', headers: {}, mimeType: '', protocol: 'http/1.1', securityState: 'secure' });
  if (params.response) result.response = response(params.response);
  // Playwright 는 리디렉션을 redirectResponse 로 잇고, 가로챈 사전 요청을 initiator.type 으로 알아본다. 둘 다 웹사이트 문자열 없이 넘긴다.
  if (params.redirectResponse) result.redirectResponse = response(params.redirectResponse);
  if (params.initiator) result.initiator = { type: INITIATOR_TYPES.has(params.initiator.type) ? params.initiator.type : 'other' };
  if ('documentURL' in params) result.documentURL = protectedUrl(params.documentURL);
  if ('responseHeaders' in params) result.responseHeaders = [];
  if ('url' in params) result.url = protectedUrl(params.url);
  if (params.frame) result.frame = { id: params.frame.id, parentId: params.frame.parentId, loaderId: params.frame.loaderId, url: protectedUrl(params.frame.url), securityOrigin: protectedUrl(params.frame.url).replace(/\/$/, ''), name: '', mimeType: 'text/html' };
  if (method === 'Page.lifecycleEvent' && ['init', 'DOMContentLoaded', 'load', 'networkAlmostIdle', 'networkIdle', 'firstContentfulPaint'].includes(params.name)) result.name = params.name;
  if (method === 'Page.javascriptDialogOpening') { result.type = ['alert', 'confirm', 'prompt', 'beforeunload'].includes(params.type) ? params.type : 'alert'; result.message = ''; result.defaultPrompt = ''; result.hasBrowserHandler = !!params.hasBrowserHandler; }
  if (method === 'Page.javascriptDialogClosed') result.result = !!params.result;
  if (method === 'Network.loadingFailed') { result.canceled = !!params.canceled; result.errorText = 'Protected browser request failed'; }
  if (method === 'Runtime.executionContextCreated') result.context = { id: params.context?.id, origin: '', name: tab.passwordUtilityWorlds?.has(params.context?.name) ? params.context.name : '', uniqueId: params.context?.uniqueId, auxData: { isDefault: !!params.context?.auxData?.isDefault, type: 'default', frameId: params.context?.auxData?.frameId } };
  if (method === 'Runtime.executionContextDestroyed') { result.executionContextId = params.executionContextId; result.executionContextUniqueId = params.executionContextUniqueId; }
  if (method === 'Target.attachedToTarget') { result.waitingForDebugger = !!params.waitingForDebugger; result.targetInfo = { targetId: params.targetInfo?.targetId, type: 'iframe', title: '', url: protectedUrl(params.targetInfo?.url), attached: true }; }
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
    if (this.host.passwords) message = this.host.passwords.redact(null, message);
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
      // Electron 은 가로챈 307·308 리디렉션(본문을 다시 보내는 요청)을 그대로 이으면 ERR_INVALID_ARGUMENT 로 끊는다.
      // 같은 주소를 명시해 이으면 본문과 함께 진행되므로, 허브가 그 요청을 이을 때 데스크톱이 원래 주소를 붙인다.
      if (method === 'Fetch.requestPaused' && params?.redirectedRequestId && !['GET', 'HEAD'].includes(params.request?.method)) {
        tab.redirectedBodies ??= new Map();
        tab.redirectedBodies.set(`${nativeSessionId ?? ''}\n${params.requestId}`, params.request.url);
        if (tab.redirectedBodies.size > REDIRECTED_BODY_LIMIT) tab.redirectedBodies.delete(tab.redirectedBodies.keys().next().value);
      }
      if (method === 'Page.javascriptDialogOpening' || method === 'Page.javascriptDialogClosed') this.host.onJavaScriptDialog?.(tab, method);
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
    if (tab.passwordShield) { metadata.url = protectedUrl(metadata.url); metadata.title = ''; }
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
      if (['Fetch.continueRequest', 'Fetch.failRequest', 'Fetch.fulfillRequest'].includes(method) && entry.tab.redirectedBodies?.size) {
        const key = `${entry.nativeSessionId ?? ''}\n${params.requestId}`;
        const url = entry.tab.redirectedBodies.get(key);
        entry.tab.redirectedBodies.delete(key);
        if (url && method === 'Fetch.continueRequest' && params.url === undefined) params = { ...params, url };
      }
      let result;
      try {
        const send = () => entry.tab.view.webContents.debugger.sendCommand(method, params, entry.nativeSessionId);
        result = method === 'Page.captureScreenshot' && this.host.withCaptureSurface
          ? await this.host.withCaptureSurface(entry.tab, send) : await send();
      } catch (error) {
        if (entry.tab.closing || entry.tab.view.webContents.isDestroyed?.()) throw new Error('Browser debugger target was closed');
        // 보호된 페이지의 오류 문구는 내보내지 않고 명령 이름만 남긴다.
        if (entry.tab.passwordShield) throw new Error(`Native browser command ${method} failed`);
        throw error;
      }
      if (entry.tab.closing || entry.tab.view.webContents.isDestroyed?.()) throw new Error('Browser debugger target was closed');
      // A read that started before the vault fill must not return after protection began.
      if (entry.tab.passwordShield && !PASSWORD_SAFE_COMMANDS.has(method) && !safeSetup) throw new Error('Native saved passwords protect this page. Use the native semantic snapshot and input tools.');
      if (entry.tab.passwordShield && method === 'Page.getFrameTree') {
        const project = (tree) => ({ frame: passwordEvent(entry.tab, 'Page.frameNavigated', { frame: tree.frame }).frame, ...(tree.childFrames ? { childFrames: tree.childFrames.map(project) } : {}) });
        return result.frameTree ? { frameTree: project(result.frameTree) } : {};
      }
      if (entry.tab.passwordShield && method === 'Page.getNavigationHistory') return { currentIndex: result.currentIndex, entries: (result.entries ?? []).map((history) => ({ id: history.id, url: protectedUrl(history.url), userTypedURL: '', title: '', transitionType: 'other' })) };
      if (method === 'Emulation.setDeviceMetricsOverride') entry.tab.viewport = { width: params.width, height: params.height };
      if (method === 'Emulation.clearDeviceMetricsOverride') entry.tab.viewport = null;
      return this.host.passwords ? this.host.passwords.redact(entry.tab, result) : result;
    }
    // 사용자가 잡은 탭에는 자동화 입력을 보내지 않는다.
    if (entry.tab.held) throw new Error('The user controls this browser tab');
    entry.tab.automationInputDepth = (entry.tab.automationInputDepth ?? 0) + 1;
    try { return await entry.tab.view.webContents.debugger.sendCommand(method, params, entry.nativeSessionId); }
    finally { entry.tab.automationInputDepth -= 1; }
  }

  async disconnect() {
    const client = this.client;
    this.client = null;
    this.autoAttach = false;
    this.sessions.clear();
    // 열린 alert/confirm 은 렌더러를 막아 Runtime·Page 명령이 끝나지 않는다. 정리 명령마다 시간을 두고
    // 탭끼리는 함께 돌려 허브 재시작·앱 종료가 대화상자에 묶이지 않게 한다.
    await Promise.all([...this.tabs.values()].map(async (tab) => {
      tab.cdpSessionId = null;
      const send = (method, params) => settleWithin(
        Promise.resolve().then(() => tab.view.webContents.debugger.sendCommand(method, params)),
        TEARDOWN_COMMAND_TIMEOUT_MS,
      );
      // A failed hub must not leave requests indefinitely paused by Fetch.
      await send('Fetch.disable');
      await send('Input.cancelDragging');
      if (!tab.dialogOpen) {
        for (const method of ['Runtime.disable', 'Page.disable', 'Network.disable', 'Log.disable']) await send(method);
      }
      await send('Target.setAutoAttach', { autoAttach: false, waitForDebuggerOnStart: false, flatten: true });
    }));
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
