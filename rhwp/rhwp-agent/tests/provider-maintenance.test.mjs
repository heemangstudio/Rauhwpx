import assert from 'node:assert/strict';
import test from 'node:test';
import { createProviderMaintenance, runHarnessUpdateRound } from '../provider-maintenance.mjs';

test('maintenance waits for proven process release, fences new launches, and unlocks on failure', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const calls = [];
  const maintenance = createProviderMaintenance({
    busy: () => false,
    releaseIdle: async () => { calls.push('release'); await gate; },
    install: async () => { calls.push('install'); throw new Error('network'); },
    refresh: async () => { calls.push('refresh'); },
  });
  const run = maintenance.run('claude');
  assert.equal(maintenance.active(), true);
  await assert.rejects(maintenance.run('codex'), { status: 409 });
  let launch = false;
  const waiting = maintenance.wait().then(() => { launch = true; });
  await Promise.resolve();
  assert.equal(launch, false);
  assert.deepEqual(calls, ['release']);
  release();
  await assert.rejects(run, /network/);
  await waiting;
  assert.equal(maintenance.active(), false);
  assert.deepEqual(calls, ['release', 'install']);
});

test('active work and unproven release prevent installation', async () => {
  let busy = true;
  let installs = 0;
  const maintenance = createProviderMaintenance({ busy: () => busy,
    releaseIdle: async () => { throw new Error('cleanup unproven'); },
    install: async () => { installs++; }, refresh: async () => ({}) });
  await assert.rejects(maintenance.run('codex'), { status: 409 });
  busy = false;
  await assert.rejects(maintenance.run('codex'), /cleanup unproven/);
  assert.equal(installs, 0);
  assert.equal(maintenance.active(), false);
});

test('slow model refresh runs after the barrier so new chats are not held behind it', async () => {
  let finishModels;
  const modelsGate = new Promise((resolve) => { finishModels = resolve; });
  const background = [];
  let modelsDone = false;
  const maintenance = createProviderMaintenance({
    busy: () => false,
    releaseIdle: async () => {},
    install: async () => {},
    refresh: async () => ({ statuses: 'fresh' }),
    afterRelease: async (agent) => {
      background.push(agent);
      await modelsGate;
      modelsDone = true;
    },
  });
  assert.deepEqual(await maintenance.run('codex'), { statuses: 'fresh' });
  assert.equal(maintenance.active(), false);
  await maintenance.wait();
  // Let the detached follow-up start; it must still be running.
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(background, ['codex']);
  assert.equal(modelsDone, false);
  // A second update is not refused while models load for the first.
  assert.deepEqual(await maintenance.run('claude'), { statuses: 'fresh' });
  finishModels();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(modelsDone, true);
});

test('a failed install skips the follow-up and a failing follow-up stays contained', async () => {
  const background = [];
  let fail = true;
  const maintenance = createProviderMaintenance({
    busy: () => false,
    releaseIdle: async () => {},
    install: async () => { if (fail) throw new Error('network'); },
    refresh: async () => ({}),
    afterRelease: async (agent) => { background.push(agent); throw new Error('discovery failed'); },
  });
  await assert.rejects(maintenance.run('codex'), /network/);
  fail = false;
  await maintenance.run('codex');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(background, ['codex']);
});

test('an open chat defers only the Pi prefix swap, never the Claude and Codex registry check', async () => {
  const calls = [];
  const round = (options) => runHarnessUpdateRound({
    checkRegistry: async () => { calls.push('registry'); },
    updatePi: async () => { calls.push('pi'); },
    ...options,
  });
  assert.deepEqual(await round({ canActivate: () => false }), { piDeferred: true });
  assert.deepEqual(calls, ['registry']);
  // The retry only revisits Pi.
  assert.deepEqual(await round({ piOnly: true, canActivate: () => true }), { piDeferred: false });
  assert.deepEqual(calls, ['registry', 'pi']);
  assert.deepEqual(await round({ canActivate: () => true }), { piDeferred: false });
  assert.deepEqual(calls, ['registry', 'pi', 'registry', 'pi']);
});

test('live maintenance routes require owner credentials and refuse to replace binaries during a turn', { timeout: 30_000 }, async (t) => {
  const { startLiveHub, HUB_TOKEN } = await import('./live-hub-fixture.mjs');
  const { requestProviderMaintenance } = await import('../../../desktop/agent-hub.mjs');
  const h = await startLiveHub(t);
  const owner = { port: h.port, token: HUB_TOKEN, launchId: 'live-hub-launch' };
  await assert.rejects(requestProviderMaintenance({ ...owner, token: 'wrong' }));
  const status = await requestProviderMaintenance(owner);
  assert.ok(status.statuses.claude);
  assert.ok(status.statuses.codex);
  await h.start();
  h.message('HOLD');
  await h.studio.next((frame) => frame.type === 'agent-event' && frame.event.text?.includes('HOLD_READY'));
  assert.equal((await requestProviderMaintenance(owner)).busy, true);
  await assert.rejects(requestProviderMaintenance({ ...owner, agent: 'codex' }), { status: 409 });
});
