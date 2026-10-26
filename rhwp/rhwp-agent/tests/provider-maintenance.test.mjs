import assert from 'node:assert/strict';
import test from 'node:test';
import { createProviderMaintenance } from '../provider-maintenance.mjs';

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
