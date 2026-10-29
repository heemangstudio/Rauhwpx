import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createLicenseClient } from '../desktop/license-client.mjs';
import { createLicenseManager } from '../desktop/license-manager.mjs';
import {
  CHECKOUT_FAST_POLL_MS, CHECKOUT_FAST_WINDOW_MS, CHECKOUT_GIVE_UP_MS, CHECKOUT_SLOW_POLL_MS,
  createPlanManager, PLAN_CACHE_MS,
} from '../desktop/plan-manager.mjs';
import { createMockLicenseServer, DEV_PUBLIC_KEYS } from './fixtures/license-mock-server.mjs';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const T0 = Date.UTC(2026, 9, 30, 0, 0, 0);
const quiet = { warn() {}, info() {} };
const CONFIG = {
  proMonthly: { url: 'https://groble.im/products/pro-monthly', priceKrw: 3900 },
  proYearly: { url: 'http://groble.im/products/pro-yearly', priceKrw: 39000 },
  hama: { url: '', priceKrw: null },
};

/** 마지막으로 건 setTimeout 을 손으로 부르는 타이머. */
function fakeTimers() {
  const pending = new Map();
  let id = 0;
  return {
    setTimeout(fn, ms) { pending.set(++id, { fn, ms }); return id; },
    clearTimeout(handle) { pending.delete(handle); },
    setInterval() { return null; },
    clearInterval() {},
    get next() { return [...pending.values()].at(-1) ?? null; },
    async fire() {
      const [handle, timer] = [...pending.entries()].at(-1);
      pending.delete(handle);
      await timer.fn();
    },
  };
}

async function setup(t, { enforce = true } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'hama-plan-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const clock = { t: T0 };
  const server = createMockLicenseServer({ now: () => clock.t });
  const license = createLicenseManager({
    statePath: join(dir, 'license.json'),
    client: createLicenseClient({ baseUrl: 'https://keys.test', fetchImpl: server.fetch }),
    publicKeys: DEV_PUBLIC_KEYS,
    enforce,
    now: () => clock.t,
    log: quiet,
  });
  // GET /v1/license/by-ref 의 가짜. ref 마다 답을 정해 둔다.
  const byRef = { answers: new Map(), calls: [], offline: false };
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    assert.equal(`${parsed.origin}${parsed.pathname}`, 'https://keys.test/v1/license/by-ref');
    const ref = parsed.searchParams.get('ref');
    byRef.calls.push(ref);
    if (byRef.offline) throw new Error('offline');
    const answer = byRef.answers.get(ref) ?? { status: 'pending' };
    return { ok: true, status: 200, json: async () => answer };
  };
  const opened = [];
  const changes = [];
  const timers = fakeTimers();
  const make = (overrides = {}) => createPlanManager({
    licenseManager: license,
    fetchImpl,
    apiBase: 'https://keys.test/',
    userDataDir: dir,
    now: () => clock.t,
    config: CONFIG,
    openExternal: async (url) => { opened.push(url); },
    onChange: (status) => changes.push(status),
    timers,
    log: quiet,
    ...overrides,
  });
  return { dir, clock, server, license, byRef, opened, changes, timers, make };
}

/** 상태만 정해 주는 라이선스 관리자. 캐시 규칙을 라이선스 서버 없이 본다. */
function fakeLicense(initial) {
  const holder = { status: initial };
  return { holder, manager: { status: async () => holder.status, activate: async () => ({ ok: false, code: 'network' }) } };
}

const refOf = (url) => new URL(url).searchParams.get('ref');

test('the tier follows the signed lease: free, pro, legacy keys, beta keys and the Hama hook', async (t) => {
  const { server, license, make } = await setup(t);
  let hama = null;
  const plan = make({ hamaActive: () => hama });
  let status = await plan.getStatus();
  assert.deepEqual([status.tier, status.agentUnlocked, status.source, status.cachedUntil], ['free', false, 'none', null]);
  assert.deepEqual(status.checkout, {
    proMonthly: { available: true, priceKrw: 3900 },
    proYearly: { available: false, priceKrw: 39000 },
    hama: { available: false, priceKrw: null },
  });

  await license.activate(server.issueKey({ plan: 'monthly' }));
  status = await plan.getStatus();
  assert.deepEqual([status.tier, status.agentUnlocked, status.source], ['pro', true, 'live']);
  // 연간·평생·베타 키는 Pro 판이 아니다. 내 계정으로 에이전트를 쓴다.
  await license.activate(server.issueKey({ licenseExpiresAt: T0 + 300 * DAY }));
  assert.equal((await plan.getStatus()).tier, 'legacy');
  await license.activate(server.issueKey({ tier: 'beta' }));
  assert.equal((await plan.getStatus()).tier, 'legacy');
  hama = true;
  assert.equal((await plan.getStatus()).tier, 'hama');
});

test('dev builds that do not enforce the license unlock the agent on the free tier', async (t) => {
  const { make } = await setup(t, { enforce: false });
  const status = await make().getStatus();
  assert.deepEqual([status.tier, status.agentUnlocked], ['free', true]);
});

test('the cached tier lasts 7 days while the lease is unverifiable and survives a restart', async (t) => {
  const { dir, clock, make } = await setup(t);
  const { holder, manager } = fakeLicense({ state: 'licensed', paid: true, edition: 'pro' });
  assert.equal((await make({ licenseManager: manager }).getStatus()).source, 'live');

  holder.status = { state: 'lease_expired', paid: false, edition: null };
  clock.t = T0 + 6 * DAY;
  let status = await make({ licenseManager: manager }).getStatus();
  assert.deepEqual([status.tier, status.agentUnlocked, status.source, status.cachedUntil], ['pro', true, 'cached', T0 + PLAN_CACHE_MS]);

  clock.t = T0 + PLAN_CACHE_MS;
  status = await make({ licenseManager: manager }).getStatus();
  assert.deepEqual([status.tier, status.agentUnlocked, status.source], ['free', false, 'none']);
  assert.equal(JSON.parse(await readFile(join(dir, 'plan.json'), 'utf8')).tier, null);
});

test('a revoked key drops the cache at once, and a rolled-back clock never uses it', async (t) => {
  const { clock, make } = await setup(t);
  const { holder, manager } = fakeLicense({ state: 'licensed', paid: true, edition: null });
  const plan = make({ licenseManager: manager });
  assert.equal((await plan.getStatus()).tier, 'legacy');
  holder.status = { state: 'revoked', paid: false, edition: null };
  assert.equal((await plan.getStatus()).tier, 'free');
  holder.status = { state: 'lease_expired', paid: false, edition: null };
  assert.equal((await plan.getStatus()).tier, 'free', 'the cache is gone, not just hidden');

  clock.t = T0 + DAY;
  holder.status = { state: 'licensed', paid: true, edition: null };
  assert.equal((await plan.getStatus()).source, 'live');
  clock.t = T0;
  holder.status = { state: 'needs_activation', paid: false, edition: null };
  assert.equal((await plan.getStatus()).tier, 'free');
});

test('an unset or non-https checkout link is not available and opens nothing', async (t) => {
  const { opened, byRef, timers, make } = await setup(t);
  const plan = make();
  for (const sku of ['hama', 'proYearly', 'unknown']) {
    const result = await plan.startCheckout(sku);
    assert.deepEqual([result.ok, result.code, result.status.pendingCheckout], [false, 'not_available', null], sku);
  }
  assert.deepEqual([opened.length, byRef.calls.length, timers.next], [0, 0, null]);
});

test('a checkout polls its ref with backoff, activates the issued key and never shows the key, ref or link', async (t) => {
  const { clock, server, license, byRef, opened, changes, timers, make } = await setup(t);
  const plan = make();
  await plan.start();
  const started = await plan.startCheckout('proMonthly');
  assert.equal(started.ok, true);
  assert.deepEqual(started.status.pendingCheckout, { sku: 'proMonthly', startedAt: T0 });
  assert.equal(opened.length, 1);
  const ref = refOf(opened[0]);
  assert.match(ref, /^hama-[0-9a-z]+-[0-9a-f]{32}$/);
  assert.ok(opened[0].startsWith('https://groble.im/products/pro-monthly?ref='));
  assert.equal((await plan.startCheckout('proYearly')).code, 'not_available');
  assert.equal((await plan.startCheckout('proMonthly')).code, 'busy');

  // 결제 전과 네트워크 오류는 5초 뒤 다시 묻는다. 10분이 지나면 30초마다.
  assert.equal(timers.next.ms, CHECKOUT_FAST_POLL_MS);
  clock.t += CHECKOUT_FAST_POLL_MS;
  await timers.fire();
  byRef.offline = true;
  await timers.fire();
  assert.equal(timers.next.ms, CHECKOUT_FAST_POLL_MS);
  byRef.offline = false;
  clock.t = T0 + CHECKOUT_FAST_WINDOW_MS;
  await timers.fire();
  assert.equal(timers.next.ms, CHECKOUT_SLOW_POLL_MS);
  assert.deepEqual(new Set(byRef.calls), new Set([ref]));

  const key = server.issueKey({ plan: 'monthly' });
  byRef.answers.set(ref, { status: 'issued', key, licenseExpiresAt: T0 + 31 * DAY, edition: 'pro', plan: 'monthly' });
  await timers.fire();
  assert.equal((await license.status()).paid, true);
  const status = await plan.getStatus();
  assert.deepEqual([status.tier, status.pendingCheckout, status.lastCheckout], ['pro', null, { ok: true, sku: 'proMonthly' }]);
  assert.equal(timers.next, null);

  for (const shown of [started.status, status, ...changes]) {
    const text = JSON.stringify(shown);
    assert.ok(!text.includes(ref) && !text.includes(key) && !text.includes('groble') && !text.includes('keys.test'), text);
  }
});

test('a revoked ref ends the checkout, and cancel stops polling', async (t) => {
  const { byRef, opened, timers, make } = await setup(t);
  const plan = make();
  await plan.start();
  await plan.startCheckout('proMonthly');
  byRef.answers.set(refOf(opened[0]), { status: 'revoked' });
  await timers.fire();
  let status = await plan.getStatus();
  assert.deepEqual([status.pendingCheckout, status.lastCheckout], [null, { ok: false, sku: 'proMonthly', code: 'revoked' }]);

  await plan.startCheckout('proMonthly');
  status = await plan.cancelCheckout();
  assert.deepEqual([status.pendingCheckout, timers.next], [null, null]);
});

test('a pending checkout resumes after a restart and gives up after 24 hours', async (t) => {
  const { clock, server, license, byRef, opened, timers, make } = await setup(t);
  const first = make();
  await first.start();
  await first.startCheckout('proMonthly');
  first.stop();
  assert.equal(timers.next, null);

  // 다시 실행: 남은 결제를 바로 이어서 묻는다.
  clock.t = T0 + HOUR;
  const second = make();
  await second.start();
  assert.deepEqual((await second.getStatus()).pendingCheckout, { sku: 'proMonthly', startedAt: T0 });
  assert.equal(timers.next.ms, 0);
  byRef.answers.set(refOf(opened[0]), { status: 'issued', key: server.issueKey({ plan: 'annual' }) });
  await timers.fire();
  assert.equal((await license.status()).paid, true);
  assert.deepEqual((await second.getStatus()).lastCheckout, { ok: true, sku: 'proMonthly' });

  await second.startCheckout('proMonthly');
  clock.t += CHECKOUT_GIVE_UP_MS;
  await timers.fire();
  const status = await second.getStatus();
  assert.deepEqual([status.pendingCheckout, status.lastCheckout, timers.next], [null, { ok: false, sku: 'proMonthly', code: 'timed_out' }, null]);
});
