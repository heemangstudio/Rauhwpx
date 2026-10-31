// Rau 에이전트 자격: 데스크톱이 계정 lease 로 GET /v1/rau/status 를 묻고, Rau 를 쓸 수 있을 때만 허브에 lease 를 준다.
// 계정 모의 서버 → 계정 관리자 → rau-agent-host → 허브의 Rau 하네스까지 실제 코드로 잇는다.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createAccountClient } from '../desktop/account-client.mjs';
import { createAccountManager } from '../desktop/account-manager.mjs';
import { createRauClient } from '../desktop/rau-client.mjs';
import { handleRauAgentRequest, staleRauAgentResponse } from '../desktop/rau-agent-host.mjs';
import { createRauAgentHarness, createStaticRauAgentSource } from '../rhwp/rhwp-agent/rau-agent-hosted.mjs';
import { createMockAccountServer, DEV_PUBLIC_KEYS } from './fixtures/account-mock-server.mjs';

const T0 = Date.UTC(2026, 10, 1, 0, 0, 0);
const BASE = 'https://accounts.test';
const quiet = { warn() {}, info() {} };

async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), 'rau-agent-desktop-'));
  const clock = { t: T0 };
  const server = createMockAccountServer({ now: () => clock.t, baseUrl: BASE });
  const opened = [];
  const account = createAccountManager({
    statePath: join(dir, 'account.json'),
    client: createAccountClient({ baseUrl: BASE, fetchImpl: server.fetch }),
    publicKeys: DEV_PUBLIC_KEYS,
    now: () => clock.t,
    openExternal: async (url) => { opened.push(url); },
    log: quiet,
  });
  t.after(async () => {
    account.stop();
    await rm(dir, { recursive: true, force: true });
  });
  const deps = { client: createRauClient({ baseUrl: BASE, fetchImpl: server.fetch }), currentLease: () => account.currentLease() };
  let seq = 0;
  const ask = () => handleRauAgentRequest(deps, { type: 'rhwp-rau-agent-request', id: `r${(seq += 1)}`, operation: 'status' });
  const signIn = async () => {
    await account.signIn('google');
    const authorize = await server.fetch(opened.at(-1));
    await (await fetch(authorize.headers.get('location'))).text();
  };
  return { dir, clock, server, account, ask, signIn };
}

const statusCalls = (server) => server.rauCalls.filter((call) => call.path === '/v1/rau/status');

test('signed out or on the free tier, the hub gets no lease and the server is never asked', async (t) => {
  const { server, ask, signIn } = await setup(t);
  const signedOut = await ask();
  assert.deepEqual([signedOut.type, signedOut.ok, signedOut.value], ['rhwp-rau-agent-response', true, { availability: 'unavailable', reason: 'no_license' }]);
  await signIn();
  assert.deepEqual((await ask()).value, { availability: 'unavailable', reason: 'no_license' });
  assert.equal(statusCalls(server).length, 0, 'a free lease never leaves the main process');
});

test('a Hama plan asks the server and is not eligible, with no lease for the hub', async (t) => {
  const { server, account, ask, signIn } = await setup(t);
  await signIn();
  await account.redeem(server.issueKey({ edition: 'hama', plan: 'monthly' }));
  const lease = await account.currentLease();
  assert.ok(lease, 'Hama gets a hosted lease for the server to judge');
  const answer = await ask();
  assert.deepEqual(answer.value, { availability: 'not_eligible', reason: 'rau_plan_required' });
  assert.equal(JSON.stringify(answer).includes(lease), false);
  assert.equal(statusCalls(server).length, 1);
});

test('a Rau trial hands the lease and the status to the hub, which writes the Rau home', async (t) => {
  const { server, account, ask, signIn } = await setup(t);
  await signIn();
  assert.equal((await account.startRauTrial()).ok, true);
  const answer = await ask();
  const lease = await account.currentLease();
  assert.deepEqual([answer.value.availability, answer.value.lease, answer.value.apiBase], ['active', lease, BASE]);
  assert.deepEqual(answer.value.status, {
    ok: true, eligible: true, source: 'trial', allowanceUsd: 2, usedUsd: 0, remainingUsd: 2, resetsAt: T0 + 7 * 24 * 3600 * 1000,
    agent: { baseUrl: '/v1/rau/agent', model: 'rau', contextWindow: 200000, maxOutputTokens: 16000 },
  });

  // 허브 쪽: 같은 답으로 Rau 하네스가 열리고 홈을 쓴다.
  const piRoot = await mkdtemp(join(tmpdir(), 'rau-agent-hub-'));
  t.after(() => rm(piRoot, { recursive: true, force: true }));
  const harness = createRauAgentHarness({ piRoot, source: createStaticRauAgentSource(answer.value), isPiInstalled: () => true, platform: 'darwin' });
  const snapshot = await harness.refresh();
  assert.deepEqual([snapshot.availability, snapshot.source, snapshot.credits.remainingUsd, snapshot.ready], ['active', 'trial', 2, true]);
  assert.deepEqual(harness.resolveSpawn(), { mode: 'rau', key: lease, agentDir: join(piRoot, 'agent-rau'), model: 'rau', reasoning: true, fallback: 'none' });
  const models = JSON.parse(await readFile(join(piRoot, 'agent-rau', 'models.json'), 'utf8'));
  assert.equal(models.providers.openrouter.models[0].baseUrl, `${BASE}/v1/rau/agent`);

  // 체험 크레딧을 다 쓰면 체험이 끝나 무료로 돌아가고, 허브는 lease 를 받지 못한다.
  server.setRauUsage('tester@example.com', 2);
  await account.refresh();
  assert.equal((await account.getStatus()).plan.tier, 'free', 'a spent trial is over');
  assert.deepEqual((await ask()).value, { availability: 'unavailable', reason: 'no_license' });
});

test('a paid Rau plan with spent credits stays active and exhausted, and a server without Rau is unavailable', async (t) => {
  const { server, account, ask, signIn } = await setup(t);
  await signIn();
  await account.redeem(server.issueKey({ edition: 'rau', plan: 'annual' }));
  server.setRauUsage('tester@example.com', 8);
  const answer = await ask();
  assert.deepEqual([answer.value.availability, answer.value.status.source, answer.value.status.remainingUsd], ['active', 'plan', 0]);
  const piRoot = await mkdtemp(join(tmpdir(), 'rau-agent-hub-'));
  t.after(() => rm(piRoot, { recursive: true, force: true }));
  const harness = createRauAgentHarness({ piRoot, source: createStaticRauAgentSource(answer.value), platform: 'darwin' });
  assert.equal((await harness.refresh()).exhausted, true);

  server.setRauConfigured(false);
  assert.deepEqual((await ask()).value, { availability: 'unavailable', reason: 'rau_not_configured' });
  server.setRauConfigured(true);
  server.setOffline(true);
  assert.deepEqual((await ask()).value, { availability: 'unavailable', reason: 'network' });
});

test('other messages are ignored and a stopping owner answers stale', async (t) => {
  const { ask } = await setup(t);
  const deps = { client: createRauClient({ fetchImpl: async () => assert.fail('no request') }), currentLease: async () => 'lease' };
  assert.equal(await handleRauAgentRequest(deps, { type: 'rhwp-rau-request', id: 'x' }), null);
  assert.equal((await handleRauAgentRequest(deps, { type: 'rhwp-rau-agent-request', id: 'x', operation: 'learn' })).code, 'RAU_AGENT_UNSUPPORTED');
  assert.deepEqual(staleRauAgentResponse({ id: 'y' }), { type: 'rhwp-rau-agent-response', id: 'y', ok: false, error: 'stale', code: 'RAU_AGENT_OWNER_STALE' });
  assert.equal((await ask()).ok, true);
});
