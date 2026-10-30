import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import os from 'node:os';
import test from 'node:test';

import { OwnedBrowserHost, createLastEditorWindowQuit } from '../desktop/browser-host.mjs';
import { documentEditMenuItem } from '../desktop/edit-menu.mjs';

class FakeContents extends EventEmitter {
  constructor() {
    super();
    this.destroyed = false;
    this.calls = [];
    this.sent = [];
    this.debugger = { isAttached: () => false };
    this.navigationHistory = { canGoBack: () => false, canGoForward: () => false };
  }
  isDestroyed() { return this.destroyed; }
  send(channel, ...args) { this.sent.push([channel, ...args]); }
  setWebRTCIPHandlingPolicy() {}
  getURL() { return 'https://example.com/'; }
  getTitle() { return ''; }
  isLoading() { return false; }
  getZoomFactor() { return 1; }
  setWindowOpenHandler() {}
  close() {
    this.calls.push('close');
    this.destroyed = true;
    this.emit('destroyed');
  }
  undo() { this.calls.push('undo'); }
  redo() { this.calls.push('redo'); }
  delete() { this.calls.push('delete'); }
  selectAll() { this.calls.push('selectAll'); }
}

class FakeView {
  constructor() { this.webContents = new FakeContents(); this.bounds = { x: 0, y: 0, width: 1280, height: 800 }; }
  setBounds(bounds) { this.bounds = bounds; }
  getBounds() { return this.bounds; }
  setVisible() {}
  setBorderRadius() {}
}

class FakeBaseWindow {
  constructor() { this.contentView = { addChildView() {}, removeChildView() {} }; }
  isDestroyed() { return false; }
  setOpacity() {}
  setFocusable() {}
  setIgnoreMouseEvents() {}
}

function editorWindow() {
  return { webContents: new FakeContents(), isDestroyed: () => false };
}

function clickMenu(command, window, focused) {
  documentEditMenuItem(command, command, undefined, { focusedWebContents: () => focused }).click(null, window);
}

function guestHost(platform) {
  const host = new OwnedBrowserHost({
    BrowserWindow: FakeBaseWindow, BaseWindow: FakeBaseWindow, WebContentsView: FakeView,
    electronSession: {}, dataDir: os.tmpdir(), getWindowForSession: () => null, platform,
  });
  host.owner = { connected: true };
  host.proxy = { host: '127.0.0.1', port: 1 };
  const tab = host.createNativeTab();
  tab.targetId = 'target-1';
  host.pendingTabs.delete(tab);
  host.tabs.set(tab.targetId, tab);
  return { host, tab, contents: tab.view.webContents };
}

function press(contents, input) {
  let prevented = false;
  contents.emit('before-input-event', { preventDefault: () => { prevented = true; } }, { type: 'keyDown', ...input });
  return prevented;
}

test('edit menu undo/redo/delete/select-all act on a focused browser page instead of the document behind it', () => {
  for (const [command, method] of [['undo', 'undo'], ['redo', 'redo'], ['delete', 'delete'], ['select-all', 'selectAll']]) {
    const window = editorWindow();
    const guest = new FakeContents();
    clickMenu(command, window, guest);
    assert.deepEqual(guest.calls, [method]);
    assert.deepEqual(window.webContents.sent, [], `${command} must not reach the document`);
  }
});

test('edit menu still sends document edit commands when the editor itself has focus', () => {
  for (const focused of ['self', null, 'destroyed-guest']) {
    const window = editorWindow();
    const target = focused === 'self' ? window.webContents
      : focused === 'destroyed-guest' ? Object.assign(new FakeContents(), { destroyed: true }) : null;
    clickMenu('undo', window, target);
    assert.deepEqual(window.webContents.sent, [['desktop:edit-command', 'undo']]);
  }
  // 이전 호출 방식(포커스 조회 없음)도 문서로 보낸다.
  const window = editorWindow();
  documentEditMenuItem('redo', 'Redo', 'Ctrl+Y').click(null, window);
  assert.deepEqual(window.webContents.sent, [['desktop:edit-command', 'redo']]);
});

test('Ctrl+W in a user-controlled browser page closes that tab and never reaches the editor close accelerator', () => {
  const { host, tab, contents } = guestHost('win32');
  tab.human = true;
  tab.interactive = true;
  assert.equal(press(contents, { key: 'w', control: true }), true);
  assert.deepEqual(contents.calls, ['close']);
  assert.equal(host.tabs.has('target-1'), false);
});

test('Ctrl+W in a locked browser preview is swallowed without closing the tab', () => {
  const { host, contents } = guestHost('win32');
  assert.equal(press(contents, { key: 'W', control: true }), true);
  assert.deepEqual(contents.calls, []);
  assert.equal(host.tabs.has('target-1'), true);
});

test('other keys in a user-controlled browser page pass through, and macOS uses Cmd+W', () => {
  const { tab, contents } = guestHost('win32');
  tab.human = true;
  tab.interactive = true;
  assert.equal(press(contents, { key: 'z', control: true }), false);
  assert.equal(press(contents, { key: 'w', control: true, shift: true }), false);
  assert.equal(press(contents, { key: 'w' }), false);
  assert.deepEqual(contents.calls, []);

  const mac = guestHost('darwin');
  mac.tab.human = true;
  mac.tab.interactive = true;
  assert.equal(press(mac.contents, { key: 'w', control: true }), false);
  assert.equal(press(mac.contents, { key: 'w', meta: true }), true);
  assert.deepEqual(mac.contents.calls, ['close']);
});

function quitHarness(platform, { ready = true } = {}) {
  const state = { windows: 1, ready, quits: 0 };
  const guard = createLastEditorWindowQuit({
    platform,
    canQuit: () => state.ready,
    editorWindowCount: () => state.windows,
    quit: () => { state.quits += 1; },
  });
  return { state, guard };
}

test('closing the last editor window quits on Windows even when browser windows keep the app alive', () => {
  const { state, guard } = quitHarness('win32');
  state.windows = 0;
  guard.windowClosed();
  assert.equal(state.quits, 1);
});

test('closing a window while other editor windows remain, during startup, or on macOS does not quit', () => {
  const remaining = quitHarness('win32');
  remaining.guard.windowClosed();
  assert.equal(remaining.state.quits, 0);

  const startup = quitHarness('win32', { ready: false });
  startup.state.windows = 0;
  startup.guard.windowClosed();
  assert.equal(startup.state.quits, 0);

  const mac = quitHarness('darwin');
  mac.state.windows = 0;
  mac.guard.windowClosed();
  assert.equal(mac.state.quits, 0);
});

test('a window opening when the last one closes defers quitting until that launch settles', async () => {
  const opened = quitHarness('win32');
  let finishOpen;
  const opening = opened.guard.track(new Promise((resolve) => { finishOpen = resolve; }));
  opened.state.windows = 0;
  opened.guard.windowClosed();
  assert.equal(opened.state.quits, 0);
  opened.state.windows = 1;
  finishOpen();
  await opening;
  assert.equal(opened.state.quits, 0);

  const failed = quitHarness('win32');
  let failOpen;
  const failing = failed.guard.track(new Promise((resolve) => { failOpen = resolve; }));
  failed.state.windows = 0;
  failed.guard.windowClosed();
  assert.equal(failed.state.quits, 0);
  failOpen();
  await failing;
  assert.equal(failed.state.quits, 1);
});
