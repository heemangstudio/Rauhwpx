import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { OwnedBrowserHost } from '../desktop/browser-host.mjs';
import { PrivateBrowserCdp } from '../desktop/browser-cdp.mjs';

function captureHost(platform = 'win32') {
  class Window {
    constructor() { this.visible = false; this.shows = 0; this.contentView = { addChildView() {} }; }
    isDestroyed() { return this.destroyed === true; }
    setOpacity(value) { this.opacity = value; }
    setFocusable(value) { this.focusable = value; }
    setIgnoreMouseEvents(value) { this.ignoreMouse = value; }
    showInactive() {
      assert.equal(this.opacity, 0);
      assert.equal(this.focusable, false);
      assert.equal(this.ignoreMouse, true);
      this.visible = true; this.shows++;
    }
    hide() { this.visible = false; }
  }
  const host = new OwnedBrowserHost({ BaseWindow: Window, dataDir: '/unused-native-profile', platform });
  const tab = { view: { webContents: { isDestroyed: () => false }, setVisible() {} } };
  host.parkGuest(tab);
  return { host, tab, window: host.parkingWindow };
}

test('overlapping Windows captures keep a transparent surface only until the final lease settles', async () => {
  const { host, tab, window } = captureHost();
  let finishFirst, failSecond;
  const first = host.withCaptureSurface(tab, () => new Promise(resolve => { finishFirst = resolve; }));
  const second = host.withCaptureSurface(tab, () => new Promise((_, reject) => { failSecond = reject; }));
  await Promise.resolve();
  assert.equal(window.shows, 1);
  finishFirst('first image');
  assert.equal(await first, 'first image');
  assert.equal(window.visible, true);
  failSecond(new Error('fixture capture failed'));
  await assert.rejects(second, /fixture capture failed/);
  assert.equal(window.visible, false);
  assert.equal(host.captureSurfaces.has(window), false);
});

test('a stalled Windows capture releases its native surface at the deadline', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { host, tab, window } = captureHost();
  const capture = host.withCaptureSurface(tab, () => new Promise(() => {}));
  const rejected = assert.rejects(capture, /Native browser capture timed out/);
  t.mock.timers.tick(15_000);
  await rejected;
  assert.equal(window.visible, false);
});

test('capture surfaces do not map non-Windows or presented guests and tolerate native teardown', async () => {
  const other = captureHost('darwin');
  assert.equal(await other.host.withCaptureSurface(other.tab, () => 'mac image'), 'mac image');
  assert.equal(other.window.shows, 0);
  const { host, tab, window } = captureHost();
  tab.parkingWindow = null;
  assert.equal(await host.withCaptureSurface(tab, () => 'visible image'), 'visible image');
  assert.equal(window.shows, 0);
  tab.parkingWindow = window;
  await host.withCaptureSurface(tab, () => { window.destroyed = true; return 'last image'; });
  assert.equal(host.captureSurfaces.has(window), false);
});

test('in-flight CDP replies never reach a replacement hub connection', async () => {
  const relay = new PrivateBrowserCdp({ host: {} });
  const makeClient = () => Object.assign(new EventEmitter(), { readyState: 1, replies: [], send(value) { this.replies.push(JSON.parse(value)); } });
  const first = makeClient(); const second = makeClient();
  let complete;
  relay.command = () => new Promise((resolve) => { complete = resolve; });
  relay.connect(first);
  first.emit('message', JSON.stringify({ id: 1, method: 'Runtime.evaluate' }));
  first.emit('close');
  relay.connect(second);
  complete({ value: 'private result from the previous owner' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(first.replies, []);
  assert.deepEqual(second.replies, []);
  relay.command = async () => ({ value: 'current owner' });
  second.emit('message', JSON.stringify({ id: 1, method: 'Runtime.evaluate' }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(second.replies[0].result.value, 'current owner');
});

test('target announcements resolve immediately and reattachment keeps aliases and window ownership', async () => {
  const first = { id: 1, isDestroyed: () => false, webContents: { send() {} } };
  const second = { id: 2, isDestroyed: () => false, webContents: { send() {} } };
  const host = new OwnedBrowserHost({ dataDir: '/tmp/unused-native-profile', getWindowForSession: (id) => id === 'one' ? first : second });
  let targetId = 'native-first'; let attached = false;
  const debuggerApi = Object.assign(new EventEmitter(), {
    isAttached: () => attached, attach: () => { attached = true; }, detach: () => { attached = false; },
    sendCommand: async () => ({ targetInfo: { targetId } }),
  });
  const contents = { debugger: debuggerApi, isDestroyed: () => false, getURL: () => 'https://example.org/', getTitle: () => 'Retained page', getZoomFactor: () => 1, isLoading: () => false, navigationHistory: { canGoBack: () => false, canGoForward: () => false } };
  const tab = { view: { webContents: contents }, targetId: null, navigationEpoch: 7, human: false };
  host.cdp.autoAttach = true;
  host.cdp.send = (message) => {
    if (message.method === 'Target.attachedToTarget') assert.equal(host.tab(message.params.targetInfo.targetId), tab);
  };
  await host.cdp.add(tab);
  host.bind({ targetId, tabId: 'logical-tab', sessionId: 'one', chatId: 'chat' });
  assert.throws(() => host.ownedTab('logical-tab', second), /another editor window/);
  host.cdp.remove(targetId);
  targetId = 'native-reconnected';
  await host.cdp.add(tab);
  assert.equal(host.tab('logical-tab'), tab);
  assert.equal(host.tabs.has('native-first'), false);
  assert.equal(host.ownedTab('logical-tab', first).navigationEpoch, 7);
  assert.equal(host.state(tab).controller, 'agent');
  assert.throws(() => host.attach(first, { tabId: 'logical-tab', expectedTargetId: 'native-first' }), /target is stale/);
  assert.throws(() => host.bind({ targetId, tabId: 'logical-tab', sessionId: 'two', chatId: 'chat' }), /another editor window/);
});
