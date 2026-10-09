import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

import {
  resolveRendererSessionContext,
  websocketHubUrl,
} from '../src/desktop-integration.ts';


// bridge.ts 는 오버레이 css 를 함께 들여온다 — node 테스트에서는 빈 모듈로 대체한다.
registerHooks({
  load(url, context, nextLoad) {
    if (/\.css$/.test(url)) return { format: 'module', source: 'export default {};', shortCircuit: true };
    return nextLoad(url, context);
  },
});
const { AgentBridgeImpl } = await import('../src/agent/bridge.ts');

test('Electron renderer session context is loaded asynchronously from preload', async () => {
  const expected = {
    launchId: 'launch-desktop',
    sessionId: 'window-2',
    hubUrl: 'http://127.0.0.1:6123',
    hubToken: 'desktop-secret',
    referenceToken: 'desktop-reference',
    templateToken: 'desktop-template',
  };
  let calls = 0;
  const context = await resolveRendererSessionContext({
    rhwpDesktop: {
      ensureAgentHub: async () => true,
      async getSessionContext() {
        calls += 1;
        return expected;
      },
    },
  }, {
    hubUrl: 'ws://127.0.0.1:5175',
    hubToken: 'dev',
  });

  assert.deepEqual(context, expected);
  assert.equal(calls, 1);
});

test('Electron never falls back to the packaged dev hub when preload context is missing', async () => {
  assert.equal(await resolveRendererSessionContext({
    rhwpDesktop: { ensureAgentHub: async () => true },
  }), null);
});

test('browser/dev context keeps explicit overrides and HTTP hub URLs become WebSockets', async () => {
  const context = await resolveRendererSessionContext({}, {
    launchId: 'browser-launch',
    sessionId: 'browser-window',
    hubUrl: 'https://hub.example.test/base/',
    hubToken: 'browser-token',
    referenceToken: 'browser-token',
    templateToken: 'browser-token',
  });
  assert.deepEqual(context, {
    launchId: 'browser-launch',
    sessionId: 'browser-window',
    hubUrl: 'https://hub.example.test/base/',
    hubToken: 'browser-token',
    referenceToken: 'browser-token',
    templateToken: 'browser-token',
  });
  assert.equal(websocketHubUrl(context!.hubUrl), 'wss://hub.example.test/base');
});

test('AgentBridge carries the renderer session on WebSocket and HTTP hub requests', () => {
  const opened: string[] = [];
  const realWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = class {
    constructor(url: string) { opened.push(url); }
    close() {}
  } as unknown as typeof WebSocket;
  let bridge: any;
  try {
    bridge = Object.create(AgentBridgeImpl.prototype) as any;
    Object.assign(bridge, {
      disposed: false,
      url: 'ws://127.0.0.1:6123/',
      token: 'desktop-secret',
      sessionId: 'window 2',
      httpBaseUrl: 'http://127.0.0.1:6123',
      ws: null,
      listeners: new Set(),
      clearConnectTimer: () => {},
      abortSocket: () => {},
      setState: () => {},
    });
    bridge.connect();
    const ws = new URL(opened[0]!);
    assert.equal(ws.pathname, '/studio');
    assert.equal(ws.searchParams.get('token'), 'desktop-secret');
    assert.equal(ws.searchParams.get('sessionId'), 'window 2');
    const http = new URL(bridge.referenceUrl('/references', { scope: 'chat' }));
    assert.equal(http.searchParams.get('sessionId'), 'window 2');
    assert.equal(http.searchParams.get('scope'), 'chat');
  } finally {
    clearTimeout(bridge?.connectTimer);
    globalThis.WebSocket = realWebSocket;
  }
});

test('stopping a chat drops full access so the next chat starts in the safe profile', () => {
  const bridge = Object.create(AgentBridgeImpl.prototype) as any;
  Object.assign(bridge, {
    state: 'disconnected',
    turnRunning: false,
    queuedMessages: [],
    activeToolRequestControllers: new Map(),
    turnSnapshots: null,
    pendingUserQuestion: null,
    permissionProfile: 'unrestricted',
    listeners: new Set(),
    syncEditingLease: () => {},
    resetWorkflowState: () => {},
  });
  assert.equal(bridge.getPermissionProfile(), 'unrestricted');
  bridge.stopChat();
  assert.equal(bridge.getPermissionProfile(), 'safe');
});
