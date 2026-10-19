import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createFakeUpdater, createUpdateController } from '../desktop/update-controller.mjs';
import { createUpdateLifecycle } from '../desktop/update-lifecycle.mjs';
import {
  UPDATE_RESTART_MAX_AGE_MS,
  buildRestartManifest,
  consumeRestartManifest,
  createRestartPrepareBroker,
  restoreSliceFor,
  updateWasApplied,
} from '../desktop/update-restart.mjs';

const tick = () => new Promise((resolve) => setImmediate(resolve));
const quiet = { warn: () => {} };
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function event() {
  return { prevented: false, preventDefault() { this.prevented = true; } };
}

// ── quit → cleanup → install handoff ─────────────────────────────────────

function lifecycleFixture({ platform = 'darwin', cleanup, install } = {}) {
  const calls = [];
  const updater = new EventEmitter();
  const nativeUpdater = new EventEmitter();
  const app = new EventEmitter();
  let windows = 1;
  app.exit = (code) => calls.push(`exit:${code}`);
  app.relaunch = () => calls.push('relaunch');
  app.quit = () => {
    const before = event();
    app.emit('before-quit', before);
    if (before.prevented) { calls.push('quit-blocked'); return; }
    // Update restarts let every window close without a renderer prompt.
    if (windows > 0) { windows = 0; calls.push('windows-closed'); }
    const will = event();
    app.emit('will-quit', will);
    if (!will.prevented) calls.push('native-quit');
  };
  updater.quitAndInstall = (...args) => {
    calls.push(['install', ...args]);
    return install?.({ updater, nativeUpdater, app });
  };
  const lifecycle = createUpdateLifecycle({
    app, updater, nativeUpdater, platform,
    cleanup: cleanup ?? (() => calls.push('cleanup')),
    onQuitRequested: () => {},
    onTeardown: () => calls.push('teardown'),
    logger: { warn: (...args) => calls.push(['warning', ...args]) },
  });
  lifecycle.start();
  lifecycle.configureUpdates();
  return { app, updater, nativeUpdater, lifecycle, calls };
}
const installs = (f) => f.calls.filter((call) => Array.isArray(call) && call[0] === 'install');

test('update install waits for cleanup, then hands off to the native updater exactly once', async () => {
  const cleanup = deferred();
  const f = lifecycleFixture({ cleanup: () => cleanup.promise });
  assert.equal(f.updater.autoInstallOnAppQuit, false);
  assert.equal(f.updater.autoDownload, false);
  assert.equal(f.lifecycle.requestInstall(), true);
  assert.equal(installs(f).length, 0);
  cleanup.resolve();
  await tick();
  assert.deepEqual(installs(f), [['install', false, true]]);
  f.app.quit();
  assert.equal(f.calls.filter((call) => call === 'native-quit').length, 0, 'plain quit cannot interrupt Squirrel staging');
  f.nativeUpdater.emit('before-quit-for-update');
  f.app.quit();
  assert.ok(f.calls.includes('native-quit'));
  assert.equal(f.lifecycle.requestInstall(), false);
  assert.equal(installs(f).length, 1);
});

for (const platform of ['win32', 'linux']) {
  test(`${platform} installs ${platform === 'win32' ? 'silently ' : ''}after windows close and cleanup`, async () => {
    const f = lifecycleFixture({ platform });
    f.lifecycle.requestInstall();
    await tick();
    assert.deepEqual(f.calls, ['windows-closed', 'teardown', 'cleanup', ['install', platform === 'win32', true]]);
  });
}

test('an ordinary quit or a cancelled install exits without installing', async () => {
  const plain = lifecycleFixture();
  plain.app.quit();
  await tick();
  assert.deepEqual(plain.calls.slice(-2), ['cleanup', 'exit:0']);
  assert.equal(installs(plain).length, 0);

  // A renderer that cancels its close prompt also cancels the pending install.
  const cancelled = lifecycleFixture();
  cancelled.app.quit = () => {};
  cancelled.lifecycle.requestInstall();
  cancelled.lifecycle.cancelQuit();
  cancelled.app.emit('will-quit', event());
  await tick();
  assert.ok(cancelled.calls.includes('exit:0'));
  assert.equal(installs(cancelled).length, 0);
});

test('a cleanup failure is logged and installation still proceeds', async () => {
  const f = lifecycleFixture({ cleanup: async () => { throw new Error('hub cleanup failed'); } });
  f.lifecycle.requestInstall();
  await tick();
  assert.equal(installs(f).length, 1);
  assert.equal(f.calls.filter((call) => Array.isArray(call) && call[0] === 'warning').length, 1);
});

test('the development seam relaunches without touching the installer', async () => {
  const f = lifecycleFixture();
  f.lifecycle.requestInstall({ relaunchOnly: true });
  await tick();
  assert.deepEqual(f.calls.slice(-2), ['relaunch', 'exit:0']);
  assert.equal(installs(f).length, 0);
});

for (const failure of ['throw', 'reject', 'native error']) {
  test(`install ${failure} relaunches a fresh process once without a second handoff`, async () => {
    const error = new Error('install failed');
    const f = lifecycleFixture({ install: failure === 'throw' ? () => { throw error; }
      : failure === 'reject' ? () => Promise.reject(error) : undefined });
    f.lifecycle.requestInstall();
    await tick();
    if (failure === 'native error') f.updater.emit('error', error);
    f.updater.emit('error', error);
    await tick();
    assert.deepEqual(f.calls.filter((call) => call === 'relaunch' || call === 'exit:1'), ['relaunch', 'exit:1']);
    assert.equal(f.lifecycle.requestInstall(), false);
    assert.equal(installs(f).length, 1);
  });
}

test('updater errors before the handoff are only logged', async () => {
  const f = lifecycleFixture();
  f.updater.emit('error', new Error('offline'));
  await tick();
  assert.equal(f.calls.includes('relaunch'), false);
  assert.equal(f.calls.some((call) => typeof call === 'string' && call.startsWith('exit:')), false);
});

// ── update state ─────────────────────────────────────────────────────────

function fakeUpdater({ check, download } = {}) {
  const updater = new EventEmitter();
  updater.checks = 0;
  updater.downloads = 0;
  updater.checkForUpdates = async () => {
    updater.checks += 1;
    if (check) return check(updater);
    updater.emit('update-available', { version: '3.0.3' });
    return {};
  };
  updater.downloadUpdate = async () => {
    updater.downloads += 1;
    if (download) return download(updater);
    for (const percent of [0.4, 12.2, 12.9, 50, 99.99]) updater.emit('download-progress', { percent });
    updater.emit('update-downloaded', { version: '3.0.3' });
    return [];
  };
  return updater;
}

function controllerFixture({ mode = 'in-app', updater = fakeUpdater(), ...options } = {}) {
  const states = [];
  const controller = createUpdateController({
    currentVersion: '3.0.2',
    mode,
    updater: mode === 'in-app' ? updater : null,
    broadcast: (state) => states.push(state),
    logger: quiet,
    ...options,
  });
  return { controller, updater, states, statuses: () => states.map((state) => state.status) };
}

test('a background check finds an update without a checking state or a manual flag', async () => {
  const f = controllerFixture();
  assert.equal(f.controller.state().status, 'idle');
  await f.controller.check();
  assert.deepEqual(f.statuses(), ['available']);
  assert.equal(f.controller.state().version, '3.0.3');
  assert.equal(f.controller.state().manual, false);
  assert.equal(f.controller.state().install, 'in-app');
});

test('a manual check reports checking, then up to date', async () => {
  const f = controllerFixture({ updater: fakeUpdater({ check: (u) => { u.emit('update-not-available', {}); } }) });
  await f.controller.check({ manual: true });
  assert.deepEqual(f.statuses(), ['checking', 'up-to-date']);
  assert.equal(f.controller.state().manual, true);
});

test('a failed background check stays idle; a failed manual check reports the error', async () => {
  const failing = fakeUpdater({ check: () => { throw new Error('offline'); } });
  const f = controllerFixture({ updater: failing });
  await f.controller.check();
  assert.deepEqual(f.states, []);
  await f.controller.check({ manual: true });
  assert.equal(f.controller.state().status, 'idle');
  assert.deepEqual(f.controller.state().error, { context: 'check', message: 'offline' });
  assert.equal(f.controller.state().manual, true);
});

test('download reports whole-percent progress and ends downloaded', async () => {
  const f = controllerFixture();
  await f.controller.download();
  assert.equal(f.updater.downloads, 0, 'nothing to download before an update is available');
  await f.controller.check();
  await f.controller.download();
  const downloading = f.states.filter((state) => state.status === 'downloading').map((state) => state.percent);
  assert.deepEqual(downloading, [0, 12, 50, 99]);
  assert.equal(f.controller.state().status, 'downloaded');
  assert.equal(f.controller.state().percent, null);
});

test('a failed download can be retried', async () => {
  let fail = true;
  const updater = fakeUpdater({ download: (u) => {
    if (fail) throw new Error('connection reset');
    u.emit('update-downloaded', { version: '3.0.3' });
  } });
  const f = controllerFixture({ updater });
  await f.controller.check();
  await f.controller.download();
  assert.equal(f.controller.state().status, 'error');
  assert.deepEqual(f.controller.state().error, { context: 'download', message: 'connection reset' });
  assert.equal(f.controller.state().version, '3.0.3');
  fail = false;
  await f.controller.download();
  assert.equal(f.controller.state().status, 'downloaded');
});

test('a native updater error while downloading is a download error', async () => {
  const updater = fakeUpdater({ download: (u) => { u.emit('error', new Error('staging failed')); } });
  const f = controllerFixture({ updater });
  await f.controller.check();
  await f.controller.download();
  assert.equal(f.controller.state().status, 'error');
  assert.equal(f.controller.state().error.context, 'download');
});

test('checks are skipped while downloading, downloaded or restarting', async () => {
  const gate = deferred();
  const updater = fakeUpdater({ download: async (u) => {
    await gate.promise;
    u.emit('update-downloaded', { version: '3.0.3' });
  } });
  const f = controllerFixture({ updater, restartApp: () => new Promise(() => {}) });
  await f.controller.check();
  const download = f.controller.download();
  await tick();
  await f.controller.check();
  gate.resolve();
  await download;
  await f.controller.check();
  void f.controller.restart();
  await f.controller.check();
  assert.equal(updater.checks, 1);
  assert.equal(f.controller.state().status, 'restarting');
  await f.controller.check({ manual: true });
  assert.equal(updater.checks, 1);
  assert.equal(f.controller.state().manual, true);
});

test('restart is single-flight and an aborted restart returns to downloaded', async () => {
  const answers = [false, Promise.reject(new Error('disk full')), true];
  let calls = 0;
  const f = controllerFixture({ restartApp: () => answers[calls++] });
  assert.deepEqual(await f.controller.restart(), { ok: false }, 'nothing downloaded yet');
  await f.controller.check();
  await f.controller.download();
  assert.deepEqual(await f.controller.restart(), { ok: false });
  assert.equal(f.controller.state().status, 'downloaded');
  assert.equal(f.controller.state().error?.context, 'install');
  assert.deepEqual(await f.controller.restart(), { ok: false });
  assert.deepEqual(f.controller.state().error, { context: 'install', message: 'disk full' });
  const first = f.controller.restart();
  assert.equal(f.controller.state().error, null, 'retrying clears the error');
  const second = f.controller.restart();
  assert.equal(first, second);
  assert.deepEqual(await first, { ok: true });
  assert.equal(f.controller.state().status, 'restarting');
  await f.controller.restart();
  assert.equal(calls, 3);
});

test('running chats are summed across windows and forgotten per window', () => {
  const f = controllerFixture();
  f.controller.setRunningChats('a', 2);
  f.controller.setRunningChats('b', 1);
  assert.equal(f.controller.state().runningChats, 3);
  f.controller.setRunningChats('a', 1);
  f.controller.forgetRunningChats('b');
  f.controller.setRunningChats('c', -4);
  f.controller.setRunningChats('d', 'many');
  assert.equal(f.controller.state().runningChats, 1);
});

test('Debian builds offer the release download page instead of installing', async () => {
  const opened = [];
  const f = controllerFixture({
    mode: 'external',
    checkExternal: async () => ({ version: '3.0.3', url: 'https://github.com/org/repo/amd64.deb' }),
    openExternal: async (url) => { opened.push(url); },
  });
  await f.controller.check();
  assert.equal(f.controller.state().status, 'available');
  assert.equal(f.controller.state().install, 'external');
  await f.controller.download();
  assert.deepEqual(opened, ['https://github.com/org/repo/amd64.deb']);
  assert.equal(f.controller.state().status, 'available');
});

test('an update that did not apply is offered again with an install error', async () => {
  const updater = fakeUpdater({ check: (u) => { u.emit('update-available', { version: '3.0.3' }); } });
  const f = controllerFixture({ updater });
  f.controller.markNotApplied('3.0.3');
  assert.equal(f.controller.state().status, 'available');
  assert.equal(f.controller.state().error.context, 'install');
  // The relaunched updater has no update info, so download checks first.
  await f.controller.download();
  assert.equal(updater.checks, 1);
  assert.equal(f.controller.state().status, 'downloaded');
});

test('a disabled updater never checks', async () => {
  const f = controllerFixture({ mode: 'disabled', updater: null });
  f.controller.start({ setTimeoutImpl: () => assert.fail('scheduled a check') });
  await f.controller.check({ manual: true });
  assert.equal(f.controller.state().status, 'disabled');
  assert.deepEqual(f.states, []);
});

test('checks run after the launch delay and then on every interval', async () => {
  const timeouts = [];
  const intervals = [];
  const f = controllerFixture({ updater: fakeUpdater({ check: (u) => { u.emit('update-not-available', {}); } }) });
  f.controller.start({
    setTimeoutImpl: (fn, ms) => { timeouts.push(ms); fn(); },
    setIntervalImpl: (fn, ms) => { intervals.push([fn, ms]); },
  });
  await tick();
  assert.deepEqual(timeouts, [4000]);
  assert.equal(intervals[0][1], 60 * 60 * 1000);
  intervals[0][0]();
  await tick();
  assert.equal(f.updater.checks, 2);
});

test('the development fake offers, downloads over time and is up to date after a restart', async () => {
  const fake = createFakeUpdater({ version: '3.0.3', durationMs: 20, setTimeoutImpl: (fn) => setImmediate(fn) });
  const f = controllerFixture({ updater: fake });
  await f.controller.check();
  await f.controller.download();
  assert.equal(f.controller.state().status, 'downloaded');
  assert.ok(f.states.filter((state) => state.status === 'downloading').length > 3);
  const relaunched = controllerFixture({
    updater: createFakeUpdater({ version: '3.0.3', applied: true, setTimeoutImpl: (fn) => setImmediate(fn) }),
  });
  await relaunched.controller.check();
  assert.equal(relaunched.controller.state().status, 'up-to-date');
});

// ── restart prepare and manifest ─────────────────────────────────────────

const slice = (documents = [], continueThreadIds = []) => ({ ok: true, documents, continueThreadIds });

function brokerFixture() {
  const timers = [];
  let ids = 0;
  const broker = createRestartPrepareBroker({
    createId: () => `request-${++ids}`,
    setTimeoutImpl: (fn) => { timers.push(fn); return timers.length; },
    clearTimeoutImpl: () => {},
  });
  const sent = [];
  const closed = new Set();
  const target = (windowId) => ({
    windowId,
    isOpen: () => !closed.has(windowId),
    send: (phase, requestId) => sent.push([phase, windowId, requestId]),
  });
  const requestsFor = (phase) => sent.filter((entry) => entry[0] === phase);
  return { broker, sent, closed, target, requestsFor, fireTimeouts: () => timers.splice(0).forEach((fn) => fn()) };
}

test('windows commit only after every window prepared, and the commit answers are what restores', async () => {
  const f = brokerFixture();
  const result = f.broker.handOff([f.target('a'), f.target('b'), f.target('c')]);
  assert.equal(f.broker.respond('b', 'request-1', slice()), false, 'another window cannot answer');
  f.broker.respond('a', 'request-1', slice());
  await tick();
  assert.deepEqual(f.requestsFor('commit'), [], 'no commit while a window is still preparing');
  f.broker.respond('b', 'request-2', slice());
  f.broker.drop('c');
  await tick();
  assert.deepEqual(f.requestsFor('commit').map(([, windowId]) => windowId), ['a', 'b']);
  f.broker.respond('a', 'request-4', slice([{ documentId: 'doc-1', handleId: 'h1', fileName: '보고서.hwp', active: true }], ['thread-1']));
  f.broker.respond('b', 'request-5', slice());
  const handedOff = await result;
  assert.equal(handedOff.ok, true);
  assert.deepEqual([...handedOff.slices.keys()], ['a', 'b']);
  assert.deepEqual(handedOff.slices.get('a').continueThreadIds, ['thread-1']);
});

test('a window that closed after preparing is not asked to commit', async () => {
  const f = brokerFixture();
  const result = f.broker.handOff([f.target('a'), f.target('b')]);
  f.broker.respond('a', 'request-1', slice());
  f.broker.respond('b', 'request-2', slice());
  f.closed.add('b');
  await tick();
  assert.deepEqual(f.requestsFor('commit').map(([, windowId]) => windowId), ['a']);
  f.broker.respond('a', 'request-3', slice());
  assert.deepEqual([...(await result).slices.keys()], ['a']);
});

for (const failure of ['ok:false', 'malformed', 'timeout']) {
  test(`a prepare ${failure} aborts the restart before any window commits`, async () => {
    const f = brokerFixture();
    const result = f.broker.handOff([f.target('a'), f.target('b')]);
    f.broker.respond('a', 'request-1', slice());
    if (failure === 'ok:false') f.broker.respond('b', 'request-2', { ok: false });
    if (failure === 'malformed') f.broker.respond('b', 'request-2', { ok: true, documents: [{ handleId: 'h' }], continueThreadIds: [] });
    if (failure === 'timeout') f.fireTimeouts();
    assert.equal((await result).ok, false);
    assert.deepEqual(f.requestsFor('commit'), []);
  });
}

test('a refused commit aborts the restart', async () => {
  const f = brokerFixture();
  const result = f.broker.handOff([f.target('a'), f.target('b')]);
  f.broker.respond('a', 'request-1', slice());
  f.broker.respond('b', 'request-2', slice());
  await tick();
  f.broker.respond('a', 'request-3', slice());
  f.broker.respond('b', 'request-4', { ok: false });
  assert.deepEqual(await result, { ok: false, reason: 'commit refused' });
});

test('a window refusing the hand-off leaves the update downloaded with an install error and no manifest', async () => {
  const f = brokerFixture();
  const manifests = [];
  // main.mjs restartForUpdate: hand off, and only then write the manifest and install.
  const c = controllerFixture({
    restartApp: async () => {
      const handedOff = await f.broker.handOff([f.target('a'), f.target('b')]);
      if (!handedOff.ok) throw new Error(`The windows did not hand over (${handedOff.reason}).`);
      manifests.push([...handedOff.slices.keys()]);
      return true;
    },
  });
  await c.controller.check();
  await c.controller.download();
  const restart = c.controller.restart();
  await tick();
  f.broker.respond('a', 'request-1', slice());
  f.broker.respond('b', 'request-2', { ok: false });
  assert.deepEqual(await restart, { ok: false });
  assert.deepEqual(manifests, []);
  assert.deepEqual(f.requestsFor('commit'), []);
  assert.equal(c.controller.state().status, 'downloaded');
  assert.equal(c.controller.state().error?.context, 'install');
});

test('the manifest maps handles to paths and survives a stale handle', () => {
  const manifest = buildRestartManifest({
    fromVersion: '3.0.2', targetVersion: '3.0.3', createdAt: 1000, logger: quiet,
    windows: [{
      bounds: { x: 10, y: 20, width: 1200, height: 800 },
      maximized: false,
      slice: slice([
        { documentId: 'doc-1', handleId: 'h1', fileName: 'a.hwp', active: false },
        { documentId: 'doc-2', handleId: 'stale', fileName: 'b.hwpx', active: true },
        { documentId: 'doc-3', handleId: null, fileName: '새 문서', active: false },
      ], ['thread-1']),
      pathForHandle: (handleId) => {
        if (handleId === 'stale') throw new Error('stale handle');
        return '/docs/a.hwp';
      },
    }],
  });
  assert.deepEqual(manifest.windows[0].documents.map((document) => document.path), ['/docs/a.hwp', null, null]);
  assert.deepEqual(manifest.windows[0].continueThreadIds, ['thread-1']);
  assert.equal(manifest.fake, undefined);
});

test('the manifest is consumed once and only while it is recent', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hama-update-restart-'));
  try {
    const file = join(dir, 'update-restart.json');
    const writeManifest = () => writeFile(file, JSON.stringify(manifest));
    const manifest = {
      fromVersion: '3.0.2', targetVersion: '3.0.3', createdAt: 10_000,
      windows: [{
        bounds: { x: 0, y: 0, width: 1000, height: 700 },
        maximized: true,
        documents: [{ documentId: 'doc-1', path: '/docs/a.hwp', fileName: 'a.hwp', active: true }],
        continueThreadIds: ['thread-1'],
      }],
    };
    await writeManifest();
    const consumed = await consumeRestartManifest(file, { now: 10_000 + 60_000, logger: quiet });
    assert.deepEqual(consumed, { ...manifest, fake: false });
    await assert.rejects(stat(file), { code: 'ENOENT' });
    assert.equal(await consumeRestartManifest(file, { now: 10_000, logger: quiet }), null);

    await writeManifest();
    assert.equal(await consumeRestartManifest(file, { now: 10_000 + UPDATE_RESTART_MAX_AGE_MS + 1, logger: quiet }), null);
    await assert.rejects(stat(file), { code: 'ENOENT' }, 'an expired manifest is removed too');

    await writeFile(file, '{not json');
    assert.equal(await consumeRestartManifest(file, { now: 10_000, logger: quiet }), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the relaunch tells an applied update from one that did not install', () => {
  const manifest = { fromVersion: '3.0.2', targetVersion: '3.0.3' };
  assert.equal(updateWasApplied(manifest, '3.0.3'), true);
  assert.equal(updateWasApplied(manifest, '3.0.2'), false);
  assert.equal(updateWasApplied({ ...manifest, fake: true }, '3.0.2'), true);
});

test('a restored window keeps documents whose file is gone, detached from the file', async () => {
  const restored = await restoreSliceFor({
    documents: [
      { documentId: 'doc-1', path: '/docs/a.hwp', fileName: 'a.hwp', active: true },
      { documentId: 'doc-2', path: '/docs/gone.hwp', fileName: 'gone.hwp', active: false },
      { documentId: 'doc-3', path: null, fileName: '새 문서', active: false },
    ],
    continueThreadIds: ['thread-1'],
  }, {
    logger: quiet,
    restoredDocumentIds: ['doc-1', 'doc-2', 'doc-3', 'doc-other-window'],
    register: async (path) => {
      if (path.endsWith('gone.hwp')) throw new Error('missing');
      return { kind: 'file', handleId: 'new-handle', name: 'a.hwp' };
    },
  });
  assert.deepEqual(restored.documents.map((document) => document.file?.handleId ?? null), ['new-handle', null, null]);
  assert.deepEqual(restored.documents.map((document) => document.documentId), ['doc-1', 'doc-2', 'doc-3']);
  assert.deepEqual(restored.continueThreadIds, ['thread-1']);
  assert.deepEqual(restored.restoredDocumentIds, ['doc-1', 'doc-2', 'doc-3', 'doc-other-window']);
});
