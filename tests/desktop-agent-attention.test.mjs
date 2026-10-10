import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { APP_ID, PRODUCT_NAME } from '../desktop/app-identity.mjs';
import {
  AgentAttention,
  applyAppUserModelId,
  normalizeAttentionCount,
  normalizeAttentionNotice,
} from '../desktop/native-shell.mjs';

function fakeWindow(id, { focused = false, minimized = false } = {}) {
  const calls = [];
  let destroyed = false;
  const window = {
    id,
    calls,
    focusedNow: focused,
    minimizedNow: minimized,
    isDestroyed: () => destroyed,
    destroy() { destroyed = true; },
    isFocused: () => window.focusedNow,
    isMinimized: () => window.minimizedNow,
    restore: () => { calls.push(['restore']); window.minimizedNow = false; },
    show: () => calls.push(['show']),
    focus: () => calls.push(['focus']),
    flashFrame: (on) => calls.push(['flashFrame', on]),
    setOverlayIcon: (icon, description) => calls.push(['setOverlayIcon', icon ? 'dot' : null, description]),
    webContents: {
      isDestroyed: () => destroyed,
      send: (channel, payload) => calls.push(['send', channel, payload]),
    },
  };
  return window;
}

function setup(platform, { supported = true, now = () => 0 } = {}) {
  const shown = [];
  const badges = [];
  const bounces = [];
  const bitmaps = [];
  class FakeNotification {
    static isSupported() { return supported; }
    constructor(options) {
      this.options = options;
      this.handlers = new Map();
      shown.push(this);
    }
    on(event, handler) { this.handlers.set(event, handler); }
    show() { this.shown = true; }
    emit(event) { this.handlers.get(event)?.(); }
  }
  const app = {
    setBadgeCount: (count) => { badges.push(count); return true; },
    dock: { bounce: (type) => bounces.push(type) },
  };
  const nativeImage = {
    createFromBitmap: (buffer, size) => {
      bitmaps.push({ length: buffer.length, ...size });
      return { overlay: true };
    },
  };
  const attention = new AgentAttention({ app, Notification: FakeNotification, nativeImage, platform, now });
  return { attention, shown, badges, bounces, bitmaps };
}

test('a focused window gets no notification, and malformed notices are dropped', () => {
  const { attention, shown, bounces } = setup('darwin');
  const window = fakeWindow(1, { focused: true });
  attention.notify(window, { threadId: 'thread-1', title: '표 정리', body: '작업을 마쳤습니다' });
  attention.notify(fakeWindow(2), { threadId: '../../etc', title: 'x', body: 'y' });
  attention.notify(fakeWindow(3), { title: 'no thread' });
  assert.equal(shown.length, 0);
  assert.equal(bounces.length, 0);
});

test('clicking a notification restores and focuses its window and opens the chat', () => {
  const { attention, shown, bounces } = setup('darwin');
  const window = fakeWindow(1, { minimized: true });
  // 렌더러는 기본으로 채팅 제목과 문서 이름 없이 앱 이름과 문구만 보낸다.
  attention.notify(window, { threadId: 'thread-1', title: 'HamaEditor', body: '검토할 변경이 있습니다' });
  assert.deepEqual(bounces, ['informational']);
  assert.equal(shown.length, 1);
  assert.deepEqual(shown[0].options, { title: 'HamaEditor', body: '검토할 변경이 있습니다', silent: false });
  assert.equal(shown[0].shown, true);
  shown[0].emit('click');
  assert.deepEqual(window.calls, [
    ['restore'],
    ['show'],
    ['focus'],
    ['send', 'desktop:open-agent-chat', { threadId: 'thread-1' }],
  ]);
});

test('a click after the window closed does nothing', () => {
  const { attention, shown } = setup('linux');
  const window = fakeWindow(1);
  attention.notify(window, { threadId: 'thread-1', title: 't', body: 'b' });
  window.destroy();
  shown[0].emit('click');
  assert.deepEqual(window.calls.filter(([name]) => name !== 'flashFrame'), []);
});

test('counts from every window sum into the app badge on macOS and Linux', () => {
  for (const platform of ['darwin', 'linux']) {
    const { attention, badges } = setup(platform);
    const first = fakeWindow(1);
    const second = fakeWindow(2);
    attention.setCount(first, 2);
    attention.setCount(second, 3);
    attention.setCount(first, 0);
    attention.forget(2);
    assert.deepEqual(badges, [2, 5, 3, 0], platform);
    assert.equal(first.calls.length, 0, 'no taskbar overlay outside Windows');
  }
});

test('Windows shows a per-window overlay dot and flashes until the window is focused', () => {
  const { attention, badges, bitmaps, shown } = setup('win32');
  const first = fakeWindow(1);
  const second = fakeWindow(2);
  attention.setCount(first, 2);
  attention.setCount(second, 1);
  attention.setCount(first, 0);
  assert.deepEqual(first.calls, [
    ['setOverlayIcon', 'dot', '확인할 채팅 2개'],
    ['setOverlayIcon', null, ''],
  ]);
  assert.deepEqual(second.calls, [['setOverlayIcon', 'dot', '확인할 채팅 1개']]);
  assert.deepEqual(bitmaps, [{ length: 16 * 16 * 4, width: 16, height: 16 }], 'the dot is drawn once');
  assert.deepEqual(badges, [], 'Windows has no app badge count');

  attention.notify(second, { threadId: 'thread-2', title: 't', body: 'b' });
  assert.deepEqual(second.calls.at(-1), ['flashFrame', true]);
  assert.equal(shown.length, 1);
  attention.focused(second);
  assert.deepEqual(second.calls.at(-1), ['flashFrame', false]);
});

test('without notification support the window still flashes or bounces, without throwing', () => {
  const mac = setup('darwin', { supported: false });
  mac.attention.notify(fakeWindow(1), { threadId: 'thread-1', title: 't', body: 'b' });
  assert.deepEqual(mac.bounces, ['informational']);
  assert.equal(mac.shown.length, 0);
  const windows = setup('win32', { supported: false });
  const window = fakeWindow(1);
  windows.attention.notify(window, { threadId: 'thread-1', title: 't', body: 'b' });
  assert.deepEqual(window.calls, [['flashFrame', true]]);
});

test('notice text and counts are bounded', () => {
  const long = 'ㄱ'.repeat(500);
  assert.deepEqual(normalizeAttentionNotice({ threadId: 'a-1:b.c_d', title: long, body: long }), {
    threadId: 'a-1:b.c_d', title: 'ㄱ'.repeat(200), body: 'ㄱ'.repeat(200),
  });
  assert.equal(normalizeAttentionNotice({ threadId: 'x'.repeat(129) }), null);
  // 제목이 비면 사용자가 보는 제품 이름을 쓴다(내부 앱 이름이 아니다).
  assert.equal(normalizeAttentionNotice({ threadId: 'ok', title: '' }).title, PRODUCT_NAME);
  assert.equal(normalizeAttentionCount(-3), 0);
  assert.equal(normalizeAttentionCount('7'), 7);
  assert.equal(normalizeAttentionCount(Number.NaN), 0);
  assert.equal(normalizeAttentionCount(123456), 9999);
});

test('a window raises at most one notification per chat per 10 s and six per minute; extras are dropped silently', () => {
  for (const platform of ['darwin', 'win32', 'linux']) {
    let clock = 1_000_000;
    const { attention, shown, bounces } = setup(platform, { now: () => clock });
    const window = fakeWindow(1);
    const other = fakeWindow(2);
    const flashes = () => window.calls.filter(([name, on]) => name === 'flashFrame' && on === true).length;
    const notify = (target, threadId) => attention.notify(target, { threadId, title: 'HamaEditor', body: '작업을 마쳤습니다' });

    notify(window, 'thread-a');
    notify(window, 'thread-a');
    clock += 9_999;
    notify(window, 'thread-a');
    assert.equal(shown.length, 1, `${platform}: the same chat within 10 s is dropped`);
    clock += 1;
    notify(window, 'thread-a');
    assert.equal(shown.length, 2, `${platform}: after 10 s the chat may notify again`);

    for (let index = 0; index < 10; index += 1) notify(window, `burst-${index}`);
    assert.equal(shown.length, 6, `${platform}: six per minute per window`);
    notify(other, 'thread-a');
    assert.equal(shown.length, 7, `${platform}: another window has its own budget`);
    const bouncedOrFlashed = platform === 'darwin' ? bounces.length : flashes() + other.calls.filter(([name]) => name === 'flashFrame').length;
    assert.equal(bouncedOrFlashed, 7, `${platform}: a dropped notice neither bounces nor flashes`);

    clock += 60_000;
    notify(window, 'burst-9');
    assert.equal(shown.length, 8, `${platform}: the minute window slides`);

    // 닫힌 창의 기록은 잊는다 — 같은 id 의 새 창은 처음부터 센다.
    for (let index = 0; index < 6; index += 1) notify(window, `late-${index}`);
    attention.forget(1);
    notify(fakeWindow(1), 'late-0');
    assert.equal(shown.length, 14, `${platform}: a closed window's budget is forgotten`);
  }
});

test('Windows notifications use the installer app id when packaged and the executable path in development', () => {
  const calls = [];
  const fakeApp = (isPackaged) => ({ isPackaged, setAppUserModelId: (id) => calls.push(id) });
  assert.equal(applyAppUserModelId({ app: fakeApp(true), platform: 'win32', execPath: 'C:\\HamaEditor\\HamaEditor.exe' }), APP_ID);
  assert.equal(
    applyAppUserModelId({ app: fakeApp(false), platform: 'win32', execPath: 'C:\\dev\\electron.exe' }),
    'C:\\dev\\electron.exe',
    'an unpackaged run does not claim the installed app id',
  );
  assert.equal(applyAppUserModelId({ app: fakeApp(true), platform: 'darwin' }), null);
  assert.equal(applyAppUserModelId({ app: fakeApp(false), platform: 'linux' }), null);
  assert.deepEqual(calls, [APP_ID, 'C:\\dev\\electron.exe']);
  // 설치 바로가기의 id 는 electron-builder 의 build.appId 다. 리브랜드 뒤에도 내부 id 는 그대로다.
  const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(APP_ID, packageJson.build.appId);
});
