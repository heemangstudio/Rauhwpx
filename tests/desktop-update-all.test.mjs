import assert from 'node:assert/strict';
import test from 'node:test';
import { createUpdateAllController } from '../desktop/update-all.mjs';

const tick = () => new Promise((resolve) => setImmediate(resolve));
function deferred() { let resolve; const promise = new Promise((yes) => { resolve = yes; }); return { promise, resolve }; }
function fixture(options = {}) {
  const app = { status: 'available', currentVersion: '1.0.0', version: '2.0.0', install: 'in-app', runningChats: 0 };
  const statuses = Object.fromEntries(['claude', 'codex'].map((id) => [id,
    { installed: true, version: '1.0.0', latestVersion: '2.0.0', updateRequired: true }]));
  const calls = [];
  const saved = [];
  let active = 0;
  const controller = createUpdateAllController({
    appState: () => app,
    checkApp: async () => {},
    downloadApp: async () => { calls.push('download'); await tick(); app.status = 'downloaded'; },
    restartApp: async () => { calls.push('restart'); return { ok: true }; },
    providerStatus: async () => ({ statuses, busy: false }),
    installProvider: async (id) => {
      assert.equal(active++, 0, 'provider installations must be sequential');
      calls.push(id);
      await tick(); active--;
      Object.assign(statuses[id], { version: '2.0.0', updateRequired: false });
      return { statuses };
    },
    sleep: async () => {},
    persist: async (state) => saved.push(structuredClone(state)),
    ...options,
  });
  return { controller, app, statuses, calls, saved };
}

test('one run downloads the app, installs providers sequentially and persists before restarting', async () => {
  const { controller, calls, saved } = fixture();
  const run = controller.start();
  assert.equal(controller.start(), run, 'another window joins the same run');
  await run;
  assert.deepEqual(calls, ['download', 'claude', 'codex', 'restart']);
  assert.equal(saved.at(-1).phase, 'restarting');
  assert.deepEqual(saved.at(-1).items.map((item) => item.status), ['ready', 'done', 'done']);
});

test('provider-only updates finish without downloading or restarting', async () => {
  const { controller, app, calls } = fixture();
  app.status = 'up-to-date'; app.version = null;
  await controller.start();
  assert.deepEqual(calls, ['claude', 'codex']);
  assert.equal(controller.state().phase, 'complete');
});

test('waits for active work, continues after one provider fails and retries only failures', async () => {
  let busy = true;
  let fail = true;
  const attempts = [];
  const f = fixture({
    providerStatus: async () => ({ statuses: f.statuses, busy }),
    sleep: async () => { busy = false; },
    installProvider: async (id) => {
      assert.equal(busy, false);
      attempts.push(id);
      if (id === 'claude' && fail) throw new Error('network unavailable');
      Object.assign(f.statuses[id], { version: '2.0.0', updateRequired: false });
      return { statuses: f.statuses };
    },
  });
  await f.controller.start();
  assert.deepEqual(attempts, ['claude', 'codex']);
  assert.equal(f.controller.state().phase, 'failed');
  assert.ok(!f.calls.includes('restart'));
  fail = false;
  await f.controller.start();
  assert.deepEqual(attempts, ['claude', 'codex', 'claude']);
  assert.equal(f.calls.filter((call) => call === 'download').length, 1);
  assert.ok(f.calls.includes('restart'));
});

test('an unchanged binary cannot be reported as updated', async () => {
  const f = fixture({ installProvider: async () => ({ statuses: f.statuses }) });
  await f.controller.start();
  assert.equal(f.controller.state().phase, 'failed');
  assert.ok(f.controller.state().items.filter((item) => item.id !== 'app').every((item) => item.status === 'failed'));
  assert.ok(!f.calls.includes('restart'));
});

test('Later cancels countdown, and the same action later restarts without reinstalling', async () => {
  const countdown = deferred();
  const f = fixture({ sleep: () => countdown.promise });
  const run = f.controller.start();
  while (f.controller.state().phase !== 'countdown') await tick();
  f.controller.later(); countdown.resolve(); await run;
  assert.equal(f.controller.state().phase, 'deferred');
  assert.ok(!f.calls.includes('restart'));
  await f.controller.start();
  assert.deepEqual(f.calls, ['download', 'claude', 'codex', 'restart']);
});

test('document handoff cancellation leaves the downloaded application available for retry', async () => {
  const f = fixture({ restartApp: async () => ({ ok: false }) });
  await f.controller.start();
  assert.equal(f.app.status, 'downloaded');
  assert.equal(f.controller.state().phase, 'failed');
  assert.equal(f.controller.state().items.find((item) => item.id === 'app').status, 'failed');
});

test('after relaunch, actual installed version proves success; interrupted work stays retryable', async () => {
  const f = fixture();
  const saved = { runId: 'restored-run', phase: 'restarting', items: [
    { id: 'app', targetVersion: '2.0.0', status: 'ready' },
    { id: 'claude', targetVersion: '2.0.0', status: 'running' },
  ] };
  f.app.currentVersion = '2.0.0';
  f.controller.restore(saved);
  assert.deepEqual(f.controller.state().items.map((item) => item.status), ['done', 'failed']);
  f.app.currentVersion = '1.0.0';
  f.controller.restore(saved);
  assert.deepEqual(f.controller.state().items.map((item) => item.status), ['failed', 'failed']);
});

test('joins an app download already in progress instead of reporting a false failure', async () => {
  const f = fixture({
    downloadApp: async () => {},
    sleep: async () => { f.app.status = 'downloaded'; },
  });
  f.app.status = 'downloading';
  await f.controller.start();
  assert.ok(f.calls.includes('restart'));
  assert.ok(!f.controller.state().items.some((item) => item.status === 'failed'));
});

test('retry does not install a newly offered provider that was already successful', async () => {
  let fail = true;
  const calls = [];
  const f = fixture({ installProvider: async (id) => {
    calls.push(id);
    if (id === 'claude' && fail) throw new Error('offline');
    Object.assign(f.statuses[id], { version: f.statuses[id].latestVersion, updateRequired: false });
    return { statuses: f.statuses };
  } });
  await f.controller.start();
  Object.assign(f.statuses.codex, { latestVersion: '3.0.0', updateRequired: true });
  fail = false;
  await f.controller.start();
  assert.deepEqual(calls, ['claude', 'codex', 'claude']);
});

test('a fresh status resolves an earlier failure when another action already installed that version', async () => {
  const f = fixture();
  f.app.status = 'disabled'; f.app.version = null;
  f.controller.restore({ phase: 'failed', items: [{ id: 'claude', targetVersion: '2.0.0', status: 'failed' }] });
  Object.assign(f.statuses.claude, { version: '2.0.0', updateRequired: false });
  await f.controller.refresh();
  assert.equal(f.controller.state().items.find((item) => item.id === 'claude').status, 'done');
});

test('a package-manager app update stays manual while provider updates run', async () => {
  const f = fixture();
  f.app.install = 'external';
  await f.controller.start();
  assert.deepEqual(f.calls, ['claude', 'codex']);
  assert.equal(f.controller.state().items.find((item) => item.id === 'app').status, 'manual');
});
