import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createGiftClient, GiftServerError } from '../desktop/gift-client.mjs';
import { createGiftManager } from '../desktop/gift-manager.mjs';
import { handleGiftRequest } from '../desktop/gift-host.mjs';
import { createLicenseClient } from '../desktop/license-client.mjs';
import { createLicenseManager } from '../desktop/license-manager.mjs';
import { createMockLicenseServer, DEV_PUBLIC_KEYS } from './fixtures/license-mock-server.mjs';

const T0 = Date.UTC(2026, 9, 18, 0, 0, 0);
const BASE = 'https://keys.test';
const quiet = { warn() {} };

/** 키 서버 목, 라이선스 관리자, 선물 관리자를 한 시계로 묶는다. */
async function setup(t, { devicePlatform = 'darwin', appPlatform = 'darwin', gift = {}, activate = true } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'hama-gift-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const clock = { t: T0 };
  const server = createMockLicenseServer({ now: () => clock.t, gift });
  const license = createLicenseManager({
    statePath: join(dir, 'license.json'),
    client: createLicenseClient({ baseUrl: BASE, fetchImpl: server.fetch }),
    publicKeys: DEV_PUBLIC_KEYS,
    platform: devicePlatform,
    now: () => clock.t,
    log: quiet,
  });
  const key = server.issueKey({ tier: 'beta' });
  if (activate) assert.equal((await license.activate(key)).ok, true);
  const changes = [];
  const manager = createGiftManager({
    client: createGiftClient({ baseUrl: BASE, fetchImpl: server.fetch }),
    currentLease: () => license.currentLease(),
    platform: appPlatform,
    now: () => clock.t,
    onChange: (status) => changes.push(status),
    log: quiet,
  });
  const giftCalls = () => server.calls.filter((call) => call.path.startsWith('/v1/gift/')).length;
  return { clock, server, license, key, manager, changes, giftCalls };
}

async function leaseFor(server, key, { platform = 'darwin', deviceId = 'device-mac-1' } = {}) {
  const client = createLicenseClient({ baseUrl: BASE, fetchImpl: server.fetch });
  return (await client.activate({ key, deviceId, appVersion: '1', platform })).lease;
}

test('gift client maps server errors, bad bodies, network failures and timeouts', async () => {
  const server = createMockLicenseServer({ now: () => T0, gift: { totalBudgetUsd: 20 } });
  const client = createGiftClient({ baseUrl: `${BASE}/`, fetchImpl: server.fetch });
  const rejectsWith = (promise, code, status) => assert.rejects(promise, (error) => {
    assert.ok(error instanceof GiftServerError);
    assert.equal(error.code, code);
    if (status !== undefined) assert.equal(error.status, status);
    return true;
  });

  await rejectsWith(client.status('not-a-lease'), 'unauthorized', 401);
  const before = server.calls.length;
  await rejectsWith(client.claim(null), 'unauthorized');
  assert.equal(server.calls.length, before, 'no request without a lease');

  const mac = await leaseFor(server, server.issueKey({ tier: 'beta' }));
  const linux = await leaseFor(server, server.issueKey({ tier: 'beta' }), { platform: 'linux', deviceId: 'device-linux-1' });
  const status = await client.status(mac);
  assert.deepEqual(status, {
    event: { id: 'special-2026-10', amountUsd: 20, endsAt: null, active: true },
    eligible: true, claimed: false, remainingUsd: null, usedUsd: null, claimedAt: null,
  });
  assert.equal((await client.status(linux)).eligible, false);
  const paid = await leaseFor(server, server.issueKey(), { deviceId: 'device-mac-paid' });
  assert.equal((await client.status(paid)).eligible, false, 'paid keys get no gift');
  await rejectsWith(client.claim(paid), 'not_eligible', 403);
  await rejectsWith(client.claim(linux), 'not_eligible', 403);
  assert.equal((await client.claim(mac)).created, true);
  assert.equal((await client.claim(mac)).created, false, 'claiming twice is idempotent');
  await rejectsWith(client.claim(await leaseFor(server, server.issueKey({ tier: 'beta' }), { deviceId: 'device-mac-2' })), 'budget_exhausted', 409);
  server.setGiftActive(false);
  await rejectsWith(client.claim(mac), 'event_inactive', 410);

  server.setOffline(true);
  await rejectsWith(client.status(mac), 'network');

  const reply = (status, text) => createGiftClient({ fetchImpl: async () => new Response(text, { status }) });
  await rejectsWith(reply(502, JSON.stringify({ ok: false, error: 'upstream_unavailable' })).claim('lease'), 'upstream_unavailable', 502);
  await rejectsWith(reply(500, '<html>oops</html>').status('lease'), 'server', 500);
  await rejectsWith(reply(401, '').status('lease'), 'unauthorized', 401);
  await rejectsWith(reply(200, 'not json').status('lease'), 'server');
  await rejectsWith(reply(200, JSON.stringify({ ok: true, eligible: 'yes' })).status('lease'), 'server');
  await rejectsWith(reply(200, JSON.stringify({ ok: true, claimed: true })).claim('lease'), 'server');

  // AbortSignal.timeout 타이머는 unref 라서, 실제 소켓처럼 이벤트 루프를 붙잡는 핸들이 없으면 중단 전에 루프가 끝난다.
  const hanging = createGiftClient({
    timeoutMs: 20,
    fetchImpl: (_url, init) => new Promise((_resolve, reject) => {
      const socket = setInterval(() => {}, 1_000);
      init.signal.addEventListener('abort', () => {
        clearInterval(socket);
        reject(init.signal.reason);
      }, { once: true });
    }),
  });
  await rejectsWith(hanging.status('lease'), 'network');
});

test('Windows apps get the gift like macOS', async (t) => {
  const { manager } = await setup(t, { appPlatform: 'win32', devicePlatform: 'win32' });
  const status = await manager.status();
  assert.deepEqual([status.available, status.eligible], [true, true]);
  assert.equal((await manager.claim()).ok, true);
  assert.equal((await manager.credentials()).active, true);
});

test('Linux apps and licenses without a lease never ask the gift server', async (t) => {
  const linux = await setup(t, { appPlatform: 'linux' });
  let leaseReads = 0;
  const spy = createGiftManager({
    client: createGiftClient({ baseUrl: BASE, fetchImpl: linux.server.fetch }),
    currentLease: () => { leaseReads += 1; return linux.license.currentLease(); },
    platform: 'linux',
  });
  for (const manager of [linux.manager, spy]) {
    assert.equal((await manager.status({ refresh: true })).available, false);
    assert.equal((await manager.claim()).ok, false);
    assert.deepEqual(await manager.credentials({ refresh: true }), {
      available: false, active: false, lease: null, baseUrl: null, eventId: null, amountUsd: null, remainingUsd: null, claimed: false,
    });
    await manager.licenseChanged();
  }
  assert.equal(linux.giftCalls(), 0);
  assert.equal(leaseReads, 0);

  const trial = await setup(t, { activate: false });
  assert.equal(await trial.license.currentLease(), null);
  const status = await trial.manager.status({ refresh: true });
  assert.equal(status.available, false);
  const claim = await trial.manager.claim();
  assert.equal(claim.code, 'not_eligible');
  assert.equal(claim.message, '이 라이선스로는 받을 수 없습니다.');
  assert.equal(trial.giftCalls(), 0);
});

test('status is cached, refreshes on demand and on a new lease, and survives an outage', async (t) => {
  const { manager, server, clock, license, giftCalls } = await setup(t);
  const first = await manager.status();
  assert.equal(first.available, true);
  assert.equal(first.eligible, true);
  assert.equal(first.checkedAt, T0);
  assert.equal(giftCalls(), 1);
  await manager.status();
  await manager.licenseChanged();
  assert.equal(giftCalls(), 1, 'cached answer and an unchanged lease make no request');
  await manager.status({ refresh: true });
  assert.equal(giftCalls(), 2);
  clock.t += 61_000;
  await manager.status();
  assert.equal(giftCalls(), 3, 'the cache expires');

  clock.t += 1000;
  await license.check({ force: true });
  await manager.licenseChanged();
  assert.equal(giftCalls(), 4, 'a refreshed lease asks again');

  server.setOffline(true);
  const offline = await manager.status({ refresh: true });
  assert.equal(offline.available, true, 'keeps the last good answer');
  assert.equal(offline.eligible, true);
  assert.equal(offline.error, 'network');
  assert.equal(offline.checkedAt, T0 + 62_000);
  const calls = giftCalls();
  await manager.status();
  assert.equal(giftCalls(), calls, 'a failed attempt is not retried until the cache expires');
});

test('claiming updates status and credentials, and running out deactivates them', async (t) => {
  const { manager, server, license, key, changes } = await setup(t);
  const unclaimed = await manager.credentials();
  assert.equal(unclaimed.available, true);
  assert.equal(unclaimed.active, false);
  assert.equal(unclaimed.lease, null);
  assert.equal(unclaimed.baseUrl, `${BASE}/v1/gift/openrouter`);
  assert.equal(changes.length, 1);

  const result = await manager.claim();
  assert.equal(result.ok, true);
  assert.equal(result.status.claimed, true);
  assert.equal(result.status.remainingUsd, 20);
  assert.equal(result.status.usedUsd, 0);
  assert.equal(changes.at(-1).claimed, true);
  assert.equal(server.giftState(key).claimed, true);

  const active = await manager.credentials();
  assert.deepEqual(active, {
    available: true, active: true, lease: await license.currentLease(), baseUrl: `${BASE}/v1/gift/openrouter`,
    eventId: 'special-2026-10', amountUsd: 20, remainingUsd: 20, claimed: true,
  });

  server.setGiftUsage(key, 20);
  const spent = await manager.credentials({ refresh: true });
  assert.equal(spent.active, false);
  assert.equal(spent.lease, null);
  assert.equal(spent.remainingUsd, 0);
  assert.equal(changes.at(-1).remainingUsd, 0);

  server.setGiftUsage(key, 5);
  await manager.status({ refresh: true });
  server.setGiftActive(false);
  const ended = await manager.credentials({ refresh: true });
  assert.equal(ended.active, false);
  assert.equal(changes.at(-1).event.active, false);
});

test('claim failures come back as short Korean messages', async (t) => {
  const inactive = await setup(t, { gift: { active: false } });
  const ended = await inactive.manager.claim();
  assert.deepEqual([ended.ok, ended.code, ended.message], [false, 'event_inactive', '이벤트가 끝났습니다.']);
  assert.equal(ended.status.event.active, false);

  const budget = await setup(t, { gift: { totalBudgetUsd: 10 } });
  const gone = await budget.manager.claim();
  assert.deepEqual([gone.code, gone.message], ['budget_exhausted', '준비한 크레딧이 모두 소진되었습니다.']);

  const offline = await setup(t);
  await offline.manager.status();
  offline.server.setOffline(true);
  const failed = await offline.manager.claim();
  assert.deepEqual([failed.code, failed.message], ['network', '받지 못했습니다. 잠시 뒤 다시 시도해 주세요.']);
  assert.equal(failed.status.claimed, false);
});

test('a Linux device is not eligible even if the app asks as macOS', async (t) => {
  const { manager, server, license, key } = await setup(t, { devicePlatform: 'linux' });
  const status = await manager.status();
  assert.equal(status.available, true);
  assert.equal(status.eligible, false);
  const claim = await manager.claim();
  assert.deepEqual([claim.ok, claim.code, claim.message], [false, 'not_eligible', '이 라이선스로는 받을 수 없습니다.']);
  assert.equal(server.giftState(key).claimed, false);

  // 다른 기기에서 받은 선물도 Linux 기기의 프록시 요청에는 쓰지 못한다.
  await createGiftClient({ baseUrl: BASE, fetchImpl: server.fetch }).claim(await leaseFor(server, key));
  const response = await server.fetch(`${BASE}/v1/gift/openrouter/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${await license.currentLease()}` },
    body: JSON.stringify({ model: 'anthropic/claude-sonnet-5.5', messages: [{ role: 'user', content: '안녕' }] }),
  });
  assert.equal(response.status, 403);
});

test('a revoked license loses the gift on the server and then locally', async (t) => {
  const { manager, server, license, key } = await setup(t);
  assert.equal((await manager.claim()).ok, true);
  server.revoke(key);
  const status = await manager.status({ refresh: true });
  assert.equal(status.available, false);
  assert.equal(status.error, 'unauthorized');
  assert.equal((await manager.credentials()).lease, null);

  await license.check({ force: true });
  assert.equal(await license.currentLease(), null);
  const calls = server.calls.length;
  assert.equal((await manager.status({ refresh: true })).available, false);
  assert.equal(server.calls.length, calls, 'no request once the license is revoked locally');
});

test('the hub gets credentials over child IPC in the broker response shape', async (t) => {
  const { manager, license } = await setup(t);
  await manager.claim();
  const response = await handleGiftRequest(manager, { type: 'rhwp-gift-request', id: 'r1', operation: 'credentials', refresh: true });
  assert.equal(response.type, 'rhwp-gift-response');
  assert.equal(response.id, 'r1');
  assert.equal(response.ok, true);
  assert.equal(response.value.lease, await license.currentLease());
  const bad = await handleGiftRequest(manager, { type: 'rhwp-gift-request', id: 'r2', operation: 'steal' });
  assert.deepEqual([bad.ok, bad.code], [false, 'GIFT_UNSUPPORTED']);
  assert.equal(await handleGiftRequest(manager, { type: 'rhwp-secret-request', id: 'r3' }), null);
});

test('the mock gift proxy streams OpenAI chunks, meters usage and enforces its gates', async (t) => {
  const { manager, server, license, key } = await setup(t);
  const lease = await license.currentLease();
  const proxy = (path, init = {}) => server.fetch(`${BASE}/v1/gift/openrouter${path}`, {
    ...init, headers: { Authorization: `Bearer ${lease}`, 'Content-Type': 'application/json' },
  });
  const chat = (body) => proxy('/chat/completions', { method: 'POST', body: JSON.stringify({ messages: [{ role: 'user', content: '안녕' }], ...body }) });

  assert.deepEqual(await (await proxy('/models')).json(), { error: { code: 403, message: 'gift_not_claimed' } });
  await manager.claim();
  const models = (await (await proxy('/models')).json()).data;
  assert.ok(models.length > 0 && models.every((model) => model.id.startsWith('anthropic/')));
  assert.ok(models[0].supported_parameters.includes('tools'));
  assert.equal((await chat({ model: 'openai/gpt-5' })).status, 400);

  const streamed = await chat({
    model: 'anthropic/claude-sonnet-5.5', stream: true, stream_options: { include_usage: true },
    tools: [{ type: 'function', function: { name: 'noop', parameters: { type: 'object' } } }],
    reasoning: { effort: 'low' }, provider: { sort: 'throughput' }, max_tokens: 1000,
  });
  assert.equal(streamed.headers.get('content-type'), 'text/event-stream');
  const events = (await streamed.text()).split('\n\n').filter(Boolean).map((line) => line.replace(/^data: /, ''));
  assert.equal(events.at(-1), '[DONE]');
  const chunks = events.slice(0, -1).map((data) => JSON.parse(data));
  assert.match(chunks.map((chunk) => chunk.choices[0].delta.content ?? '').join(''), /[가-힣]/);
  assert.equal(chunks.at(-1).choices[0].finish_reason, 'stop');
  assert.equal(chunks.at(-1).usage.cost, 0.05);
  assert.equal(server.giftState(key).usageUsd, 0.05);
  assert.equal((await (await proxy('/auth/key')).json()).data.limit_remaining, 19.95);

  server.setGiftUsage(key, 20);
  const broke = await chat({ model: 'anthropic/claude-sonnet-5.5' });
  assert.equal(broke.status, 402);
  assert.match((await broke.json()).error.message, /Insufficient credits/);
});

test('a status answer that arrives after the license is removed does not bring the gift back', async () => {
  let lease = 'lease-before-deactivation';
  let entered;
  const asked = new Promise((resolve) => { entered = resolve; });
  let answer;
  const late = new Promise((resolve) => { answer = resolve; });
  const changes = [];
  const manager = createGiftManager({
    client: createGiftClient({ baseUrl: BASE, fetchImpl: async () => { entered(); return late; } }),
    currentLease: async () => lease,
    platform: 'darwin',
    onChange: (status) => changes.push(status.available),
    log: quiet,
  });
  const pending = manager.status({ refresh: true });
  await asked;
  lease = null;
  assert.equal((await manager.licenseChanged()).available, false);
  answer(new Response(JSON.stringify({
    ok: true, event: { id: 'gift', active: true, amountUsd: 5 }, eligible: true, claimed: true,
    remainingUsd: 5, usedUsd: 0, claimedAt: null,
  }), { status: 200 }));
  const stale = await pending;
  assert.equal(stale.available, false);
  assert.equal(changes.includes(true), false);
});
