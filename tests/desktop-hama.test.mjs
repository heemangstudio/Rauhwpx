import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createHamaClient } from '../desktop/hama-client.mjs';
import { handleHamaRequest } from '../desktop/hama-host.mjs';
import { createLicenseClient } from '../desktop/license-client.mjs';
import { createLicenseManager } from '../desktop/license-manager.mjs';
import { createMockLicenseServer, DEV_PUBLIC_KEYS } from './fixtures/license-mock-server.mjs';

const T0 = Date.UTC(2026, 9, 30, 0, 0, 0);
const BASE = 'https://keys.test';
const quiet = { warn() {} };

async function setup(t, { tier = 'paid', enroll = false, activate = true } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'hama-desktop-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const clock = { t: T0 };
  const server = createMockLicenseServer({ now: () => clock.t });
  const license = createLicenseManager({
    statePath: join(dir, 'license.json'),
    client: createLicenseClient({ baseUrl: BASE, fetchImpl: server.fetch }),
    publicKeys: DEV_PUBLIC_KEYS,
    platform: 'darwin',
    now: () => clock.t,
    log: quiet,
  });
  const key = server.issueKey({ tier });
  if (activate) assert.equal((await license.activate(key)).ok, true);
  if (enroll) server.enrollHama(key);
  const deps = { client: createHamaClient({ baseUrl: BASE, fetchImpl: server.fetch }), currentLease: () => license.currentLease() };
  const ask = (id = 'h1') => handleHamaRequest(deps, { type: 'rhwp-hama-request', id, operation: 'status' });
  return { server, license, ask, key };
}

test('an enrolled license gets its plan status and the lease the Hama harness needs', async (t) => {
  const { ask, license } = await setup(t, { enroll: true });
  const response = await ask();
  assert.deepEqual([response.type, response.id, response.ok], ['rhwp-hama-response', 'h1', true]);
  assert.equal(response.value.availability, 'active');
  assert.equal(response.value.lease, await license.currentLease());
  assert.equal(response.value.apiBase, BASE);
  assert.equal(response.value.status.plan.status, 'active');
  assert.deepEqual(response.value.status.models.claude, ['anthropic/claude-haiku-5.5']);
});

test('a Pro or Free license is not enrolled and never hands the lease to the hub', async (t) => {
  for (const tier of ['paid', 'beta']) {
    const { ask } = await setup(t, { tier });
    const { value } = await ask();
    assert.deepEqual(value, { availability: 'not_enrolled', reason: 'hama_not_enrolled' });
  }
});

test('no license, a server without Hama and a network failure all read as unavailable', async (t) => {
  const trial = await setup(t, { activate: false });
  assert.deepEqual((await trial.ask()).value, { availability: 'unavailable', reason: 'no_license' });

  const off = await setup(t, { enroll: true });
  const offDeps = {
    client: createHamaClient({ baseUrl: BASE, fetchImpl: async () => new Response('{}', { status: 404 }) }),
    currentLease: () => off.license.currentLease(),
  };
  const offAnswer = await handleHamaRequest(offDeps, { type: 'rhwp-hama-request', id: 'h2', operation: 'status' });
  assert.deepEqual(offAnswer.value, { availability: 'unavailable', reason: 'not_configured' });

  const downDeps = {
    client: createHamaClient({ baseUrl: BASE, fetchImpl: async () => { throw new TypeError('fetch failed'); } }),
    currentLease: () => off.license.currentLease(),
  };
  const down = await handleHamaRequest(downDeps, { type: 'rhwp-hama-request', id: 'h3', operation: 'status' });
  assert.deepEqual(down.value, { availability: 'unavailable', reason: 'network' });
  assert.equal(await handleHamaRequest(downDeps, { type: 'rhwp-gift-request', id: 'h4' }), null);
});
