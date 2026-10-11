import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../rhwp/rhwp-agent/package.json', import.meta.url));
const { WebSocketServer, WebSocket } = require('ws');
const MAX_CDP_MESSAGE_BYTES = 8 * 1024 * 1024;

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
      const valid = request.url === this.path
        && !request.headers.origin
        && request.socket.remoteAddress === '127.0.0.1'
        && request.headers.host === `127.0.0.1:${this.server.address().port}`
        && !this.client;
      if (!valid) { socket.destroy(); return; }
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
    client.on('message', (bytes) => {
      let message;
      try { message = JSON.parse(String(bytes)); } catch { client.close(1003); return; }
      if (!Number.isSafeInteger(message.id) || typeof message.method !== 'string') {
        client.close(1003); return;
      }
      void this.command(message).then(
        (result) => this.send({ id: message.id, ...(message.sessionId ? { sessionId: message.sessionId } : {}), result: result ?? {} }),
        (error) => this.send({ id: message.id, ...(message.sessionId ? { sessionId: message.sessionId } : {}), error: { code: -32000, message: error.message } }),
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

  send(message) {
    if (this.client?.readyState === WebSocket.OPEN) this.client.send(JSON.stringify(message));
  }

  async add(tab) {
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
      if (tab.cdpSessionId) this.send({ method, params, sessionId: nativeSessionId || tab.cdpSessionId });
    };
    tab.debuggerDetach = (_event, reason) => {
      this.remove(tab.targetId);
      this.host.onDebuggerDetached?.(tab, reason);
    };
    debuggerApi.on('message', tab.debuggerMessage);
    debuggerApi.on('detach', tab.debuggerDetach);
    this.tabs.set(tab.targetId, tab);
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
    return { ...tab.targetInfo, url: tab.view.webContents.getURL(), title: tab.view.webContents.getTitle(), attached: true };
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
    const browserCommand = !sessionId || entry.browser;
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
          queueMicrotask(() => this.client?.close(1000));
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
    if (!method.startsWith('Input.')) return entry.tab.view.webContents.debugger.sendCommand(method, params, entry.nativeSessionId);
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
