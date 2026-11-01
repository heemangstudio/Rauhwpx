import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createAccountClient } from '../desktop/account-client.mjs';
import { createAccountManager } from '../desktop/account-manager.mjs';
import {
  CHECKOUT_FAST_POLL_MS, CHECKOUT_FAST_WINDOW_MS, CHECKOUT_SLOW_POLL_MS,
  createPlanManager, PLAN_CACHE_MS, PLAN_SKUS,
} from '../desktop/plan-manager.mjs';
import { PLAN_CHECKOUT } from '../desktop/plan-config.mjs';
import { createMockAccountServer, DEV_PUBLIC_KEYS } from './fixtures/account-mock-server.mjs';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const T0 = Date.UTC(2026, 9, 30, 0, 0, 0);
const quiet = { warn() {}, info() {} };
const CONFIG = {
  hamaMonthly: { url: 'https://groble.im/products/hama-monthly', priceKrw: 3900 },
  hamaYearly: { url: 'http://groble.im/products/hama-yearly', priceKrw: 39000 },
  rauMonthly: { url: '', priceKrw: null },
  rauYearly: { url: 'https://example.com/rau-yearly', priceKrw: 149000 },
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

/** 로그인과 lease tier 만 정해 주는 계정 관리자. redeem 은 받은 키를 적고 정해 둔 답을 준다. */
function fakeAccount(entitlement = { signedIn: true, accountId: 'acct_1', tier: 'free' }) {
  const holder = { entitlement, redeemed: [], answer: { ok: true }, tierAfterRedeem: 'hama' };
  const manager = {
    entitlement: async () => holder.entitlement,
    async redeem(key) {
      holder.redeemed.push(key);
      if (holder.answer.ok) holder.entitlement = { ...holder.entitlement, tier: holder.tierAfterRedeem };
      return holder.answer;
    },
  };
  return { holder, manager };
}

async function setup(t, { entitlement } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'hama-plan-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const clock = { t: T0 };
  const account = fakeAccount(entitlement);
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
    accountManager: account.manager,
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
  return { dir, clock, account, byRef, opened, changes, timers, make };
}

const refOf = (url) => new URL(url).searchParams.get('ref');

test('the tier follows the account lease and signed out is free', async (t) => {
  const { account, make } = await setup(t, { entitlement: { signedIn: false, accountId: null, tier: null } });
  const plan = make();
  let status = await plan.getStatus();
  assert.deepEqual([status.tier, status.signedIn, status.agentUnlocked, status.source, status.cachedUntil], ['free', false, false, 'none', null]);
  assert.deepEqual(status.checkout, {
    hamaMonthly: { available: true, priceKrw: 3900 },
    hamaYearly: { available: false, priceKrw: 39000 },
    rauMonthly: { available: false, priceKrw: null },
    rauYearly: { available: false, priceKrw: 149000 },
  });

  account.holder.entitlement = { signedIn: true, accountId: 'acct_1', tier: 'free' };
  status = await plan.getStatus();
  assert.deepEqual([status.tier, status.signedIn, status.agentUnlocked, status.source], ['free', true, false, 'live']);
  for (const tier of ['hama', 'rau']) {
    account.holder.entitlement = { signedIn: true, accountId: 'acct_1', tier };
    status = await plan.getStatus();
    assert.deepEqual([status.tier, status.agentUnlocked, status.source], [tier, true, 'live'], tier);
  }
});

test('a v1 cache moves to v2: Basic, Pro and legacy become Hama, the old hosted Hama becomes Rau, and so do pending checkouts', async (t) => {
  const cases = [
    ['basic', 'basicMonthly', 'hama', 'hamaMonthly'],
    ['pro', 'proYearly', 'hama', 'hamaYearly'],
    ['legacy', 'basicYearly', 'hama', 'hamaYearly'],
    ['hama', 'hamaMonthly', 'rau', 'rauMonthly'],
    ['hama', 'hamaYearly', 'rau', 'rauYearly'],
  ];
  for (const [oldTier, oldSku, tier, sku] of cases) {
    const { dir, account, make } = await setup(t, { entitlement: { signedIn: true, accountId: 'acct_1', tier: null } });
    const ref = `hama-${T0.toString(36)}-${'a'.repeat(32)}`;
    await writeFile(join(dir, 'plan.json'), JSON.stringify({
      v: 1, tier: oldTier, accountId: 'acct_1', verifiedAt: T0 - HOUR, pendingCheckout: { sku: oldSku, ref, startedAt: T0 - 1000 },
    }));
    const status = await make().getStatus();
    assert.deepEqual([status.tier, status.source, status.pendingCheckout?.sku], [tier, 'cached', sku], `${oldTier}/${oldSku}`);
    const saved = JSON.parse(await readFile(join(dir, 'plan.json'), 'utf8'));
    assert.deepEqual([saved.v, saved.tier, saved.pendingCheckout.sku, saved.pendingCheckout.ref], [2, tier, sku, ref]);
    // v2 는 다시 옮기지 않는다: 저장한 hama 는 그대로 Hama 다.
    account.holder.entitlement = { signedIn: true, accountId: 'acct_1', tier: null };
    assert.equal((await make().getStatus()).tier, tier);
  }
  // 모르는 판(v3)이나 모르는 이름은 버린다.
  const { dir, make } = await setup(t, { entitlement: { signedIn: true, accountId: 'acct_1', tier: null } });
  await writeFile(join(dir, 'plan.json'), JSON.stringify({ v: 2, tier: 'basic', accountId: 'acct_1', verifiedAt: T0 - HOUR, pendingCheckout: { sku: 'basicMonthly', ref: 'hama-x', startedAt: T0 } }));
  const unknown = await make().getStatus();
  assert.deepEqual([unknown.tier, unknown.pendingCheckout], ['free', null]);
});

test('the cached tier lasts 7 days for the same account while the lease is unverifiable and survives a restart', async (t) => {
  const { dir, clock, account, make } = await setup(t, { entitlement: { signedIn: true, accountId: 'acct_1', tier: 'hama' } });
  assert.equal((await make().getStatus()).source, 'live');
  assert.equal(JSON.parse(await readFile(join(dir, 'plan.json'), 'utf8')).accountId, 'acct_1');

  account.holder.entitlement = { signedIn: true, accountId: 'acct_1', tier: null };
  clock.t = T0 + 6 * DAY;
  let status = await make().getStatus();
  assert.deepEqual([status.tier, status.agentUnlocked, status.source, status.cachedUntil], ['hama', true, 'cached', T0 + PLAN_CACHE_MS]);

  clock.t = T0 + PLAN_CACHE_MS;
  status = await make().getStatus();
  assert.deepEqual([status.tier, status.agentUnlocked, status.source], ['free', false, 'none']);
  assert.equal(JSON.parse(await readFile(join(dir, 'plan.json'), 'utf8')).tier, null);
});

test('the cache belongs to one account: another account, sign-out or a free lease drops it, and a rolled-back clock never uses it', async (t) => {
  const { dir, clock, account, make } = await setup(t, { entitlement: { signedIn: true, accountId: 'acct_1', tier: 'rau' } });
  const plan = make();
  assert.equal((await plan.getStatus()).tier, 'rau');
  account.holder.entitlement = { signedIn: true, accountId: 'acct_2', tier: null };
  assert.equal((await plan.getStatus()).tier, 'free', 'another account on this device');
  account.holder.entitlement = { signedIn: true, accountId: 'acct_1', tier: null };
  assert.equal((await plan.getStatus()).tier, 'free', 'the cache is gone, not just hidden');

  account.holder.entitlement = { signedIn: true, accountId: 'acct_1', tier: 'hama' };
  await plan.getStatus();
  account.holder.entitlement = { signedIn: false, accountId: null, tier: null };
  assert.equal((await plan.getStatus()).tier, 'free');
  account.holder.entitlement = { signedIn: true, accountId: 'acct_1', tier: null };
  assert.equal((await plan.getStatus()).tier, 'free', 'sign-out cleared the cache');

  account.holder.entitlement = { signedIn: true, accountId: 'acct_1', tier: 'hama' };
  await plan.getStatus();
  account.holder.entitlement = { signedIn: true, accountId: 'acct_1', tier: 'free' };
  assert.equal((await plan.getStatus()).source, 'live');
  account.holder.entitlement = { signedIn: true, accountId: 'acct_1', tier: null };
  assert.equal((await plan.getStatus()).tier, 'free', 'a free lease cleared the cache');

  clock.t = T0 + DAY;
  account.holder.entitlement = { signedIn: true, accountId: 'acct_1', tier: 'hama' };
  assert.equal((await plan.getStatus()).source, 'live');
  clock.t = T0;
  account.holder.entitlement = { signedIn: true, accountId: 'acct_1', tier: null };
  assert.equal((await plan.getStatus()).tier, 'free');

  // 계정 id 가 없는 예전 캐시(라이선스로 정한 요금제)는 쓰지 않는다.
  await writeFile(join(dir, 'plan.json'), JSON.stringify({ v: 1, tier: 'basic', verifiedAt: T0 - HOUR, pendingCheckout: null }));
  assert.equal((await make().getStatus()).tier, 'free');
});

test('an unset or non-https checkout link is not available and opens nothing', async (t) => {
  const { opened, byRef, timers, make } = await setup(t);
  const plan = make();
  for (const sku of ['rauMonthly', 'rauYearly', 'hamaYearly', 'basicMonthly', 'hama', 'unknown']) {
    const result = await plan.startCheckout(sku);
    assert.deepEqual([result.ok, result.code, result.status.pendingCheckout], [false, 'not_available', null], sku);
  }
  assert.deepEqual([opened.length, byRef.calls.length, timers.next], [0, 0, null]);
});

test('checkout asks to sign in first and opens nothing while signed out', async (t) => {
  const { account, opened, timers, make } = await setup(t, { entitlement: { signedIn: false, accountId: null, tier: null } });
  const plan = make({ config: PLAN_CHECKOUT });
  const result = await plan.startCheckout('hamaMonthly');
  assert.deepEqual([result.ok, result.code, result.status.signedIn, result.status.pendingCheckout], [false, 'sign_in_required', false, null]);
  assert.deepEqual([opened.length, timers.next], [0, null]);
  account.holder.entitlement = { signedIn: true, accountId: 'acct_1', tier: 'free' };
  assert.equal((await plan.startCheckout('hamaMonthly')).ok, true);
});

test('a checkout polls its ref with backoff, links the issued key to the account and never shows the key, ref or link', async (t) => {
  const { clock, account, byRef, opened, changes, timers, make } = await setup(t);
  const plan = make();
  await plan.start();
  const started = await plan.startCheckout('hamaMonthly');
  assert.equal(started.ok, true);
  assert.deepEqual(started.status.pendingCheckout, { sku: 'hamaMonthly', startedAt: T0 });
  assert.equal(opened.length, 1);
  const ref = refOf(opened[0]);
  assert.match(ref, /^hama-[0-9a-z]+-[0-9a-f]{32}$/);
  assert.ok(opened[0].startsWith('https://groble.im/products/hama-monthly?ref='));
  assert.equal((await plan.startCheckout('hamaYearly')).code, 'not_available');
  assert.equal((await plan.startCheckout('hamaMonthly')).code, 'busy');

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

  // 계정 연결이 잠깐 실패하면(네트워크·로그아웃) 결제를 끝내지 않고 다시 묻는다.
  const key = 'HAMA-AAAAA-BBBBB-CCCCC-DDDDD-EEEEE';
  byRef.answers.set(ref, { status: 'issued', key, edition: 'hama', plan: 'monthly' });
  account.holder.answer = { ok: false, code: 'network' };
  await timers.fire();
  assert.equal((await plan.getStatus()).pendingCheckout?.sku, 'hamaMonthly');
  account.holder.answer = { ok: false, code: 'sign_in_required' };
  await timers.fire();
  assert.equal(timers.next.ms, CHECKOUT_SLOW_POLL_MS);

  account.holder.answer = { ok: true };
  await timers.fire();
  assert.deepEqual(account.holder.redeemed, [key, key, key]);
  const status = await plan.getStatus();
  assert.deepEqual([status.tier, status.pendingCheckout, status.lastCheckout], ['hama', null, { ok: true, sku: 'hamaMonthly' }]);
  assert.equal(timers.next, null);

  for (const shown of [started.status, status, ...changes]) {
    const text = JSON.stringify(shown);
    assert.ok(!text.includes(ref) && !text.includes(key) && !text.includes('groble') && !text.includes('keys.test'), text);
  }
});

test('a key that cannot join this account ends the checkout with its code', async (t) => {
  const { account, byRef, opened, timers, make } = await setup(t);
  const plan = make();
  await plan.start();
  await plan.startCheckout('hamaMonthly');
  byRef.answers.set(refOf(opened[0]), { status: 'issued', key: 'HAMA-AAAAA-BBBBB-CCCCC-DDDDD-EEEEE' });
  account.holder.answer = { ok: false, code: 'key_linked_elsewhere' };
  await timers.fire();
  const status = await plan.getStatus();
  assert.deepEqual([status.tier, status.pendingCheckout, status.lastCheckout, timers.next], ['free', null, { ok: false, sku: 'hamaMonthly', code: 'key_linked_elsewhere' }, null]);
});

test('the shipped links open each product\'s real buyer page with the ref', async (t) => {
  const { opened, make } = await setup(t);
  const expected = { hamaMonthly: 'SfYBy5', hamaYearly: 'vdw3HN', rauMonthly: 'R3n8zG', rauYearly: 'atqjpJ' };
  const prices = { hamaMonthly: 3900, hamaYearly: 39000, rauMonthly: 14900, rauYearly: 149000 };
  assert.deepEqual([...PLAN_SKUS], Object.keys(expected));
  for (const [index, [sku, id]] of Object.entries(expected).entries()) {
    const plan = make({ config: PLAN_CHECKOUT });
    const started = await plan.startCheckout(sku);
    assert.equal(started.ok, true, sku);
    assert.deepEqual(started.status.checkout[sku], { available: true, priceKrw: prices[sku] });
    const url = new URL(opened[index]);
    assert.equal(`${url.origin}${url.pathname}`, `https://groble.im/payment/${id}`);
    assert.match(url.searchParams.get('ref'), /^hama-[a-z0-9]+-[0-9a-f]{32}$/);
    await plan.cancelCheckout();
  }
});

test('a Rau purchase redeemed into a real signed-in account ends in the Rau tier and stays cached offline', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hama-plan-account-'));
  const clock = { t: T0 };
  const server = createMockAccountServer({ now: () => clock.t });
  const opened = [];
  const account = createAccountManager({
    statePath: join(dir, 'account.json'),
    client: createAccountClient({ baseUrl: 'https://accounts.test', fetchImpl: server.fetch }),
    publicKeys: DEV_PUBLIC_KEYS,
    now: () => clock.t,
    openExternal: async (url) => { opened.push(url); },
    log: quiet,
  });
  t.after(async () => {
    account.stop();
    await rm(dir, { recursive: true, force: true });
  });
  const timers = fakeTimers();
  const plan = createPlanManager({
    accountManager: account,
    fetchImpl: server.fetch,
    apiBase: 'https://accounts.test',
    userDataDir: dir,
    now: () => clock.t,
    config: PLAN_CHECKOUT,
    openExternal: async (url) => { opened.push(url); },
    timers,
    log: quiet,
  });
  await plan.start();
  assert.equal((await plan.startCheckout('rauYearly')).code, 'sign_in_required');

  await account.signIn('google');
  const authorize = await server.fetch(opened.at(-1));
  await (await fetch(authorize.headers.get('location'))).text();
  await plan.accountChanged();
  const started = await plan.startCheckout('rauYearly');
  assert.deepEqual([started.ok, started.status.signedIn, started.status.pendingCheckout], [true, true, { sku: 'rauYearly', startedAt: T0 }]);
  await timers.fire();
  assert.equal(server.completeCheckouts({ edition: 'rau', plan: 'annual' }), 1);
  await timers.fire();
  const status = await plan.getStatus();
  assert.deepEqual([status.tier, status.agentUnlocked, status.source, status.lastCheckout], ['rau', true, 'live', { ok: true, sku: 'rauYearly' }]);
  const accountStatus = await account.getStatus();
  assert.deepEqual([accountStatus.plan.tier, accountStatus.plan.edition, accountStatus.plan.rau.eligible, accountStatus.plan.rau.source], ['rau', 'rau', true, 'plan']);

  // 오프라인으로 lease 가 끝나도 마지막 확인에서 7일까지는 그 요금제를 보여 준다.
  server.setOffline(true);
  clock.t = T0 + 6 * DAY;
  assert.equal((await plan.accountChanged()).source, 'live');
  clock.t = T0 + 7 * DAY + HOUR;
  assert.equal(await account.currentLease(), null);
  const cached = await plan.accountChanged();
  assert.deepEqual([cached.tier, cached.agentUnlocked, cached.source, cached.cachedUntil], ['rau', true, 'cached', T0 + 6 * DAY + PLAN_CACHE_MS]);
  clock.t = T0 + 6 * DAY + PLAN_CACHE_MS;
  assert.equal((await plan.accountChanged()).tier, 'free');
});

test('a revoked ref ends the checkout, and cancel stops polling', async (t) => {
  const { byRef, opened, timers, make } = await setup(t);
  const plan = make();
  await plan.start();
  await plan.startCheckout('hamaMonthly');
  byRef.answers.set(refOf(opened[0]), { status: 'revoked' });
  await timers.fire();
  let status = await plan.getStatus();
  assert.deepEqual([status.pendingCheckout, status.lastCheckout], [null, { ok: false, sku: 'hamaMonthly', code: 'revoked' }]);

  await plan.startCheckout('hamaMonthly');
  status = await plan.cancelCheckout();
  assert.deepEqual([status.pendingCheckout, timers.next], [null, null]);
});

test('a pending checkout resumes after a restart, times out after five minutes, and permits retry', async (t) => {
  const { clock, account, byRef, opened, timers, make } = await setup(t);
  const first = make();
  await first.start();
  await first.startCheckout('hamaMonthly');
  first.stop();
  assert.equal(timers.next, null);

  // 다시 실행: 남은 결제를 바로 이어서 묻는다.
  clock.t = T0 + CHECKOUT_FAST_POLL_MS;
  const second = make();
  await second.start();
  assert.deepEqual((await second.getStatus()).pendingCheckout, { sku: 'hamaMonthly', startedAt: T0 });
  assert.equal(timers.next.ms, 0);
  byRef.answers.set(refOf(opened[0]), { status: 'issued', key: 'HAMA-AAAAA-BBBBB-CCCCC-DDDDD-EEEEE' });
  await timers.fire();
  assert.equal(account.holder.redeemed.length, 1);
  assert.deepEqual((await second.getStatus()).lastCheckout, { ok: true, sku: 'hamaMonthly' });

  await second.startCheckout('hamaMonthly');
  clock.t += 5 * 60 * 1000;
  await timers.fire();
  const status = await second.getStatus();
  assert.deepEqual([status.pendingCheckout, status.lastCheckout, timers.next], [null, { ok: false, sku: 'hamaMonthly', code: 'timed_out' }, null]);
  assert.equal((await second.startCheckout('hamaMonthly')).ok, true);
  assert.equal((await second.getStatus()).lastCheckout, null);
});
