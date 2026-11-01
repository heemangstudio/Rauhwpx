import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { resolveRauConfig } from '../config.mjs';
import { generateLeaseKeyPair } from '../license-lease.mjs';
import { MAX_RAU_PROMPT_BYTES } from '../rau.mjs';
import {
  RAU_PRICES,
  addSpend,
  billingPeriod,
  normalizeLedger,
  periodOf,
  periodUsed,
  recordCall,
  spendReport,
  weekOf,
} from '../rau-ledger.mjs';
import { billCall, createRauUpstream, meterReply } from '../rau-upstream.mjs';
import { createSiteServer } from '../server.mjs';
import { HAIKU_CALL_USD, createFakeAnthropic, createFakeOpenRouter } from './fixtures/fake-rau-upstreams.mjs';
import { planPaid, signedGroblePost } from './fixtures/groble-plans.mjs';

const ADMIN = 'admin-token-for-rau-tests';
const SECRET = 'whsec_test_rau';
const PAIR = generateLeaseKeyPair();
// Placeholders built at runtime: never a real key, never key-shaped.
const ANTHROPIC_KEY = ['test', 'anthropic', 'placeholder'].join('-');
const OPENROUTER_KEY = ['test', 'openrouter', 'placeholder'].join('-');
const T0 = Date.parse('2026-10-20T14:22:11+09:00');
// A Rau key bought at T0 bills monthly from its first payment.
const PERIOD_START = '2026-10-20T05:22:11.000Z';
const PERIOD_END = '2026-11-20T05:22:11.000Z';
const UPGRADE = 'https://heemangstudios.com/pricing.html#rau';
const HAIKU_OR = 'anthropic/claude-haiku-4.5';
const HAIKU_API = 'claude-haiku-4-5';
const DEEPSEEK = 'deepseek/deepseek-v4.1-flash';
const CLI = fileURLToPath(new URL('../scripts/license-admin.mjs', import.meta.url));

async function setup(t, env = {}, { clock = { now: T0 }, seed } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'site-api-rau-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true, maxRetries: 5 }));
  if (seed) for (const [file, value] of Object.entries(seed)) await fs.writeFile(path.join(directory, file), JSON.stringify(value));
  const anthropic = createFakeAnthropic();
  const openrouter = createFakeOpenRouter();
  const anthropicBase = await anthropic.listen();
  const openrouterBase = await openrouter.listen('/api/v1');
  t.after(() => anthropic.close());
  t.after(() => openrouter.close());
  const logs = [];
  const server = createSiteServer({
    RAU_SITE_DATA: directory,
    GROBLE_WEBHOOK_SECRET: SECRET,
    LICENSE_SIGNING_PRIVATE_KEY: PAIR.privateKeyDerBase64,
    ADMIN_TOKEN: ADMIN,
    ANTHROPIC_API_BASE: anthropicBase,
    OPENROUTER_API_BASE: openrouterBase,
    ANTHROPIC_API_KEY: ANTHROPIC_KEY,
    RAU_OPENROUTER_KEY: OPENROUTER_KEY,
    ...env,
  }, { log: (line) => logs.push(line), emailProvider: null, alertProvider: null, now: () => clock.now });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections?.(); return new Promise((resolve) => server.close(resolve)); });
  const origin = `http://127.0.0.1:${server.address().port}`;

  const post = (route, body, headers = {}, init = {}) => fetch(`${origin}${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
    ...init,
  });
  const admin = (route, body) => post(route, body, { Authorization: `Bearer ${ADMIN}` }).then((r) => r.json());
  const adminGet = (route) => fetch(`${origin}${route}`, { headers: { Authorization: `Bearer ${ADMIN}` } }).then((r) => r.json());
  async function activate(key) {
    const deviceId = `mac-${Math.random().toString(36).slice(2, 10)}`;
    const res = await (await post('/v1/license/activate', { key, deviceId, platform: 'darwin' })).json();
    assert.equal(res.ok, true, JSON.stringify(res));
    return { lease: res.lease, keyId: res.keyId, key, deviceId, answer: res };
  }
  /** A fresh lease for an activated key (leases last 7 days). */
  async function renew({ key, deviceId }) {
    const res = await (await post('/v1/license/validate', { key, deviceId })).json();
    assert.equal(res.ok, true, JSON.stringify(res));
    return res.lease;
  }
  /** Buys `sku` through the signed webhook and activates the key. */
  async function buy(sku = 'rauMonthly', n = 1) {
    const event = planPaid({ sku, merchantUid: `m_${sku}_${n}`, ref: `ref-${sku}-${n}`, email: `buyer${n}@example.com` });
    assert.equal((await (await signedGroblePost(origin, SECRET, event)).json()).action, 'issued');
    const { key } = await (await fetch(`${origin}/v1/license/by-ref?ref=ref-${sku}-${n}`)).json();
    return activate(key);
  }
  const status = async (lease) => {
    const res = await fetch(`${origin}/v1/rau/status`, { headers: { Authorization: `Bearer ${lease}` } });
    return { status: res.status, body: await res.json() };
  };
  const learn = (lease, body = { prompt: 'Rau-0.1 prompt' }) => post('/v1/rau/learn', body, { Authorization: `Bearer ${lease}` });
  const ledgerOf = async (principalId) => (await adminGet('/v1/admin/rau')).ledgers.find((l) => l.principalId === principalId);
  /** A learn call is billed before it answers: the ledger already has `calls` calls. */
  async function billed(principalId, calls) {
    const ledger = await ledgerOf(principalId);
    assert.equal(ledger?.calls ?? 0, calls, `ledger of ${principalId}`);
    return ledger;
  }
  const rauFile = path.join(directory, 'rau.json');
  /** Sets the current period's spend of a plan ledger on disk. */
  async function seedSpend(principalId, usedUsd, { start = PERIOD_START, end = PERIOD_END, source = 'plan' } = {}) {
    const state = JSON.parse(await fs.readFile(rauFile, 'utf8').catch(() => '{}'));
    state.ledgers ??= {};
    state.ledgers[principalId] = { source, period: { start, end, usedUsd, calls: 1 }, ids: {}, totalUsd: usedUsd, calls: 1, lastCallAt: start };
    await fs.writeFile(rauFile, JSON.stringify(state));
  }
  return { origin, directory, clock, logs, anthropic, openrouter, post, admin, adminGet, activate, renew, buy, status, learn, ledgerOf, billed, rauFile, seedSpend };
}

test('config: RAU_MODEL lists haiku and deepseek in order; an old model id warns; a typo fails startup', () => {
  const defaults = resolveRauConfig({});
  assert.deepEqual([defaults.models, defaults.allowanceUsd, defaults.deepseekProvider, defaults.enabled, defaults.openrouterKey, defaults.warnings], [['haiku'], 8, 'deepinfra', true, '', []]);
  assert.deepEqual(resolveRauConfig({ RAU_MODEL: 'Deepseek' }).models, ['deepseek']);
  assert.deepEqual(resolveRauConfig({ RAU_MODEL: 'haiku, deepseek, haiku' }).models, ['haiku', 'deepseek']);
  const old = resolveRauConfig({ RAU_MODEL: 'deepseek/deepseek-v4.1-flash' });
  assert.deepEqual([old.models, old.warnings.length], [['haiku'], 1]);
  for (const bad of ['sonnet', 'haiku,gpt', ',']) assert.throws(() => resolveRauConfig({ RAU_MODEL: bad }), /RAU_MODEL must be/, bad);
  assert.equal(resolveRauConfig({ RAU_DEEPSEEK_PROVIDER: 'Novita' }).deepseekProvider, 'novita');
  assert.throws(() => resolveRauConfig({ RAU_DEEPSEEK_PROVIDER: 'two words' }), /RAU_DEEPSEEK_PROVIDER/);
  assert.equal(resolveRauConfig({ RAU_MONTHLY_ALLOWANCE_USD: '12.5' }).allowanceUsd, 12.5);
  assert.throws(() => resolveRauConfig({ RAU_MONTHLY_ALLOWANCE_USD: '0' }), /positive/);
  assert.throws(() => resolveRauConfig({ RAU_ENABLED: 'maybe' }), /RAU_ENABLED/);
  assert.equal(resolveRauConfig({ HAMA_OPENROUTER_KEY: 'old' }).openrouterKey, 'old');
  assert.equal(resolveRauConfig({ HAMA_OPENROUTER_KEY: 'old', RAU_OPENROUTER_KEY: 'new' }).openrouterKey, 'new');
});

test('ledger: monthly periods follow the anchor day, a trial is one period, a call id bills once, a new period starts at zero', () => {
  const at = (iso) => Date.parse(iso);
  assert.deepEqual(billingPeriod('2026-01-31T10:00:00Z', at('2026-02-15T00:00:00Z')), { start: at('2026-01-31T10:00:00Z'), end: at('2026-02-28T10:00:00Z') });
  assert.deepEqual(billingPeriod('2026-01-31T10:00:00Z', at('2026-03-01T00:00:00Z')), { start: at('2026-02-28T10:00:00Z'), end: at('2026-03-31T10:00:00Z') });
  assert.deepEqual(billingPeriod('2027-12-29T00:00:00Z', at('2028-02-29T12:00:00Z')), { start: at('2028-02-29T00:00:00Z'), end: at('2028-03-29T00:00:00Z') });
  const trial = { source: 'trial', startedAt: '2026-10-31T00:00:00.000Z', endsAt: '2026-11-07T00:00:00.000Z' };
  assert.deepEqual(periodOf(trial, at('2026-11-03T00:00:00Z')), { start: at(trial.startedAt), end: at(trial.endsAt) });

  const ledger = normalizeLedger({});
  const october = billingPeriod(PERIOD_START, T0);
  assert.equal(recordCall(ledger, { id: 'msg_1', costUsd: 0.5, at: T0, source: 'plan' }, october).duplicate, false);
  assert.deepEqual(recordCall(ledger, { id: 'msg_1', costUsd: 0.5, at: T0 + 1000 }, october), { duplicate: true });
  recordCall(ledger, { id: 'msg_2', costUsd: 0.25, at: T0 + 2000 }, october);
  assert.equal(periodUsed(ledger, october), 0.75);
  const november = billingPeriod(PERIOD_START, at(PERIOD_END));
  assert.equal(periodUsed(ledger, november), 0, 'nothing spent yet in the new period');
  recordCall(ledger, { id: 'msg_3', costUsd: 0.1, at: at(PERIOD_END) + 1 }, november);
  // A call admitted in October that finishes after November started counts toward the totals only.
  recordCall(ledger, { id: 'msg_4', costUsd: 0.2, at: at(PERIOD_END) + 2 }, october);
  assert.deepEqual([periodUsed(ledger, november), ledger.totalUsd, ledger.calls, ledger.source], [0.1, 1.05, 4, 'plan']);
});

test('weekly spend groups calls by UTC week, model and route, and the report lists empty weeks and totals', () => {
  assert.equal(weekOf(Date.parse('2026-11-01T23:00:00Z')), '2026-10-26', 'a Sunday belongs to the Monday before');
  assert.equal(weekOf(Date.parse('2026-10-26T00:00:00Z')), '2026-10-26');
  const spend = {};
  const now = Date.parse('2026-11-04T12:00:00Z');
  addSpend(spend, { at: now, model: 'haiku', route: 'openrouter', costUsd: 0.01, inputTokens: 100, outputTokens: 10, cacheReadTokens: 5, cacheWriteTokens: 1 });
  addSpend(spend, { at: now, model: 'haiku', route: 'anthropic', costUsd: 0.02, inputTokens: 100 });
  addSpend(spend, { at: now - 14 * 86400000, model: 'deepseek', route: 'openrouter', costUsd: 0.001, outputTokens: 7 });
  const report = spendReport(spend, { weeks: 3, now });
  assert.deepEqual(report.weeks.map((w) => [w.week, w.usd, w.calls]), [['2026-11-02', 0.03, 2], ['2026-10-26', 0, 0], ['2026-10-19', 0.001, 1]]);
  assert.deepEqual(report.weeks[0].models.haiku, { usd: 0.03, calls: 2, inputTokens: 200, outputTokens: 10, cacheReadTokens: 5, cacheWriteTokens: 1, routes: { openrouter: 0.01, anthropic: 0.02 } });
  assert.deepEqual([report.totals.usd, report.totals.calls, Object.keys(report.totals.models).sort()], [0.031, 3, ['deepseek', 'haiku']]);
  for (let week = 0; week < 40; week += 1) addSpend(spend, { at: now + week * 7 * 86400000, model: 'haiku', costUsd: 0 });
  assert.equal(Object.keys(spend).length, 26, 'only the newest 26 weeks are kept');
});

test('billing: Haiku at its list price on both routes, DeepSeek by OpenRouter\'s reported cost or its price row, a reply without usage estimated high', () => {
  const upstream = createRauUpstream({ config: { models: ['haiku', 'deepseek'], openrouterKey: 'k', anthropicKey: 'a', deepseekProvider: 'novita' } });
  assert.deepEqual(upstream.routes.map((r) => r.id), ['openrouter-haiku', 'anthropic-haiku', 'openrouter-deepseek']);
  const [orHaiku, apiHaiku, deepseek] = upstream.routes;
  const finished = (cost) => meterReply({ type: 'message', id: 'msg', content: [], usage: { input_tokens: 1000, output_tokens: 300, cache_read_input_tokens: 2000, cache_creation_input_tokens: 500, ...(cost !== undefined ? { cost } : {}) } });
  assert.deepEqual([billCall(orHaiku, finished(0.0004), 10).costUsd, billCall(orHaiku, finished(0.0004), 10).costSource], [HAIKU_CALL_USD, 'price_table']);
  assert.equal(billCall(apiHaiku, finished(), 10).costUsd, HAIKU_CALL_USD);
  assert.deepEqual([billCall(deepseek, finished(0.0004), 10).costUsd, billCall(deepseek, finished(0.0004), 10).costSource], [0.0004, 'upstream']);
  const p = RAU_PRICES.deepseek;
  assert.equal(billCall(deepseek, finished(), 10).costUsd, Math.round((1000 * p.inputPerMTok + 300 * p.outputPerMTok + 2000 * p.cacheReadPerMTok + 500 * p.cacheWrite5mPerMTok) * 1e3) / 1e9);
  // 30 bytes of text and no usage: ~3 request bytes a token of input, ~3 text bytes a token of output.
  const cut = billCall(orHaiku, meterReply({ type: 'message', id: 'msg', content: [{ type: 'text', text: 'x'.repeat(30) }] }), 3000);
  assert.deepEqual([cut.inputTokens, cut.outputTokens, cut.costSource], [1000, 10, 'estimate']);
});

test('a Rau key learns on OpenRouter Haiku first, with the owner\'s key and never the lease, billed at Haiku prices', async (t) => {
  const s = await setup(t);
  const rau = await s.buy('rauMonthly');
  assert.deepEqual(await s.status(rau.lease), { status: 200, body: {
    ok: true, eligible: true, source: 'plan', reason: null, upgradeUrl: UPGRADE,
    remainingPercent: 100, resetsAt: PERIOD_END,
  } });

  assert.equal((await s.learn(rau.lease)).status, 200);
  const [call] = s.openrouter.calls;
  assert.deepEqual([call.path, call.body.model, call.body.max_tokens, call.body.stream], ['/api/v1/messages', HAIKU_OR, 2000, false]);
  assert.equal(call.headers.authorization, `Bearer ${OPENROUTER_KEY}`);
  assert.equal(call.headers['x-api-key'], undefined);
  assert.ok(!JSON.stringify(call.headers).includes(rau.lease));
  assert.equal(s.anthropic.calls.length, 0);
  // OpenRouter reported $0.0004; Haiku bills at its own list price.
  assert.equal((await s.billed(rau.keyId, 1)).usedUsd, HAIKU_CALL_USD);
  assert.equal((await s.status(rau.lease)).body.remainingPercent, 100, 'rounds up while credit is left');
});

test('without Rau, hosted Rau refuses before any upstream call, and the old agent and Hama routes are gone', async (t) => {
  const s = await setup(t);
  const hama = await s.buy('hamaMonthly');
  assert.deepEqual(await s.status(hama.lease), { status: 200, body: {
    ok: true, eligible: false, source: null, reason: 'rau_plan_required', upgradeUrl: UPGRADE,
    remainingPercent: null, resetsAt: null,
  } });
  const learned = await s.learn(hama.lease);
  assert.deepEqual([learned.status, await learned.json()], [403, { ok: false, error: 'rau_plan_required', upgradeUrl: UPGRADE }]);
  const bad = await s.learn('not-a-lease');
  assert.deepEqual([bad.status, (await bad.json()).error], [401, 'unauthorized']);
  assert.equal(s.openrouter.calls.length + s.anthropic.calls.length, 0);

  const rau = await s.buy('rauMonthly', 2);
  const message = { model: 'rau', max_tokens: 10, messages: [{ role: 'user', content: 'x' }] };
  assert.equal((await s.post('/v1/rau/agent/v1/messages', message, { 'x-api-key': rau.lease })).status, 404);
  assert.equal((await fetch(`${s.origin}/v1/hama/status`, { headers: { 'x-api-key': rau.lease } })).status, 404);
  assert.equal((await s.post('/v1/hama/anthropic/v1/messages', message, { 'x-api-key': rau.lease })).status, 404);
  assert.equal((await fetch(`${s.origin}/v1/admin/hama`, { headers: { Authorization: `Bearer ${ADMIN}` } })).status, 404);
  assert.equal(s.openrouter.calls.length + s.anthropic.calls.length, 0);
});

test('Haiku fails over to Anthropic on outages, rate limits, credentials, billing or an empty answer, but not on a plain 400', async (t) => {
  const s = await setup(t);
  const rau = await s.buy('rauMonthly');
  const failures = [
    ['network', { network: true }],
    ['408', { status: 408, json: { error: { code: 408, message: 'Timeout' } } }],
    ['429', { status: 429, json: { error: { code: 429, message: 'Rate limited' } } }],
    ['500', { status: 500, json: { error: { code: 500, message: 'Internal' } } }],
    ['529', { status: 529, json: { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } } }],
    ['401', { status: 401, json: { error: { code: 401, message: 'No auth' } } }],
    ['402', { status: 402, json: { error: { code: 402, message: 'Insufficient credits' } } }],
    ['billing', { status: 400, json: { type: 'error', error: { type: 'invalid_request_error', message: 'Your credit balance is too low.' } } }],
    ['no message', { status: 200, json: {} }],
  ];
  for (const [index, [name, failure]] of failures.entries()) {
    s.openrouter.next(failure);
    const res = await s.learn(rau.lease, { prompt: `failover ${name}` });
    assert.deepEqual([res.status, (await res.json()).text], [200, 'Hello there!'], name);
    const call = s.anthropic.calls[index];
    assert.deepEqual([call.body.model, call.body.max_tokens], [HAIKU_API, 2000], name);
    assert.equal(call.headers['x-api-key'], ANTHROPIC_KEY, name);
    assert.equal(call.headers.authorization, undefined, name);
  }
  assert.equal((await s.billed(rau.keyId, failures.length)).usedUsd, Math.round(failures.length * HAIKU_CALL_USD * 1e9) / 1e9);

  // A plain 400 is not the route's fault: no backup, nothing billed.
  s.openrouter.next({ status: 400, json: { type: 'error', error: { type: 'invalid_request_error', message: `messages.0: field required (${OPENROUTER_KEY})` } } });
  const mistake = await s.learn(rau.lease, { prompt: 'bad request' });
  assert.deepEqual([mistake.status, await mistake.json()], [502, { ok: false, error: 'upstream_unavailable' }]);
  assert.equal(s.anthropic.calls.length, failures.length);
  // Both routes refusing the owner's credentials.
  s.openrouter.next({ status: 401, json: {} });
  s.anthropic.next({ status: 401, json: {} });
  const down = await s.learn(rau.lease, { prompt: 'both down' });
  assert.deepEqual([down.status, await down.json()], [502, { ok: false, error: 'upstream_unavailable' }]);
  await s.billed(rau.keyId, failures.length);
  for (const line of s.logs) for (const secret of [OPENROUTER_KEY, ANTHROPIC_KEY, rau.lease]) assert.ok(!line.includes(secret), line);
});

test('the same message id is billed once', async (t) => {
  const s = await setup(t);
  const rau = await s.buy('rauMonthly');
  s.openrouter.next({ id: 'gen-same' }, { id: 'gen-same' });
  for (const prompt of ['one', 'two', 'three']) assert.equal((await s.learn(rau.lease, { prompt })).status, 200);
  const ledger = await s.billed(rau.keyId, 2);
  assert.equal(ledger.usedUsd, 2 * HAIKU_CALL_USD);
});

test('RAU_MODEL=deepseek runs DeepSeek on OpenRouter pinned to one provider and bills its reported cost', async (t) => {
  const s = await setup(t, { RAU_MODEL: 'deepseek' });
  const rau = await s.buy('rauMonthly');
  assert.equal((await s.learn(rau.lease)).status, 200);
  const [call] = s.openrouter.calls;
  assert.deepEqual([call.path, call.body.model, call.body.provider], ['/api/v1/messages', DEEPSEEK, { only: ['deepinfra'], allow_fallbacks: false }]);
  assert.equal(s.anthropic.calls.length, 0, 'Haiku is not in the chain');
  assert.equal((await s.billed(rau.keyId, 1)).usedUsd, 0.0004);
  s.openrouter.next({ status: 503, json: {} });
  const alone = await s.learn(rau.lease, { prompt: 'no backup' });
  assert.deepEqual([alone.status, await alone.json()], [502, { ok: false, error: 'upstream_unavailable' }], 'DeepSeek alone has no backup');
  const spend = await s.adminGet('/v1/admin/rau/spend?weeks=1');
  assert.deepEqual(spend.weeks[0].models.deepseek.routes, { openrouter: 0.0004 });
});

test('RAU_MODEL=haiku,deepseek keeps DeepSeek as the last fallback after both Haiku routes', async (t) => {
  const s = await setup(t, { RAU_MODEL: 'haiku,deepseek' });
  const rau = await s.buy('rauMonthly');
  s.openrouter.next({ status: 500, json: {} });
  s.anthropic.next({ status: 529, json: { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } } });
  assert.equal((await s.learn(rau.lease, { prompt: 'everything busy' })).status, 200);
  assert.deepEqual(s.openrouter.calls.map((c) => c.body.model), [HAIKU_OR, DEEPSEEK]);
  assert.deepEqual(s.openrouter.calls[1].body.provider, { only: ['deepinfra'], allow_fallbacks: false });
  assert.equal(s.anthropic.calls.length, 1);
  assert.equal((await s.billed(rau.keyId, 1)).usedUsd, 0.0004);
});

test('credits: a call is refused before upstream once the month is spent, and the month resets on the anchor day', async (t) => {
  const clock = { now: T0 };
  const s = await setup(t, { RAU_MONTHLY_ALLOWANCE_USD: '0.005' }, { clock });
  const rau = await s.buy('rauMonthly');
  for (const prompt of ['one', 'two']) assert.equal((await s.learn(rau.lease, { prompt })).status, 200);
  // The second call was admitted under the allowance and overshot it by its own cost.
  await s.billed(rau.keyId, 2);
  const calls = s.openrouter.calls.length;
  const learned = await s.learn(rau.lease, { prompt: 'three' });
  assert.deepEqual([learned.status, await learned.json()], [402, { ok: false, error: 'rau_credits_exhausted', resetsAt: PERIOD_END }]);
  assert.equal(s.openrouter.calls.length, calls, 'nothing reached upstream');
  assert.equal((await s.status(rau.lease)).body.remainingPercent, 0);

  clock.now = Date.parse(PERIOD_END);
  const lease = await s.renew(rau);
  const next = (await s.status(lease)).body;
  assert.deepEqual([next.remainingPercent, next.resetsAt], [100, '2026-12-20T05:22:11.000Z']);
  assert.equal((await s.learn(lease, { prompt: 'new month' })).status, 200);
});

test('a plan gets $8 a month by default: spend just under it is admitted, at it refused', async (t) => {
  const s = await setup(t);
  const rau = await s.buy('rauMonthly');
  await s.seedSpend(rau.keyId, 7.99);
  assert.equal((await s.learn(rau.lease, { prompt: 'under' })).status, 200);
  assert.equal((await s.billed(rau.keyId, 2)).usedUsd, 7.993325);
  await s.seedSpend(rau.keyId, 8);
  assert.equal((await s.learn(rau.lease, { prompt: 'at' })).status, 402);
  assert.equal((await s.status(rau.lease)).body.remainingPercent, 0);
});

test('Rau-0.1 learns with one user message, 2000 tokens, no thinking, and answers the joined text and its credits', async (t) => {
  const s = await setup(t);
  const rau = await s.buy('rauMonthly');
  const res = await s.learn(rau.lease, { prompt: '문서 기억 프롬프트' });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    ok: true, text: 'Hello there!', model: 'rau-0.1',
    usage: { remainingPercent: 100, resetsAt: PERIOD_END },
  });
  const [call] = s.openrouter.calls;
  assert.deepEqual(call.body, { max_tokens: 2000, messages: [{ role: 'user', content: '문서 기억 프롬프트' }], stream: false, model: HAIKU_OR });
  // A failing first route moves the call to the backup.
  s.openrouter.next({ status: 502, json: {} });
  const backup = await s.learn(rau.lease);
  assert.equal(backup.status, 200);
  assert.equal(s.anthropic.calls[0].body.model, HAIKU_API);
  // Both failing is 502 upstream_unavailable.
  s.openrouter.next({ network: true });
  s.anthropic.next({ status: 500, json: {} });
  const failed = await s.learn(rau.lease);
  assert.deepEqual([failed.status, await failed.json()], [502, { ok: false, error: 'upstream_unavailable' }]);
  assert.equal((await s.billed(rau.keyId, 2)).calls, 2);
});

test('prompt limits: at most 48 KB of UTF-8, a non-empty string, a JSON object; none reaches upstream; 20 a minute', async (t) => {
  const s = await setup(t);
  const { lease } = await s.buy('rauMonthly');
  const korean = '가'.repeat(MAX_RAU_PROMPT_BYTES / 3 - 1); // 3 bytes each, just under the cap
  assert.equal((await s.learn(lease, { prompt: `${korean}abc` })).status, 200, 'exactly 48 KB is fine');
  const calls = s.openrouter.calls.length;
  for (const body of [{ prompt: `${korean}abcd` }, { prompt: '' }, { prompt: 42 }, {}, { prompt: 'x'.repeat(400 * 1024) }]) {
    const res = await s.learn(lease, body);
    assert.deepEqual([res.status, await res.json()], [400, { ok: false, error: 'invalid', field: 'prompt' }]);
  }
  const notJson = await s.learn(lease, 'not json');
  assert.deepEqual([notJson.status, await notJson.json()], [400, { ok: false, error: 'invalid', field: 'body' }]);
  assert.equal(s.openrouter.calls.length, calls);
  for (let i = 0; i < 19; i += 1) assert.equal((await s.learn(lease)).status, 200);
  const limited = await s.learn(lease);
  assert.deepEqual([limited.status, limited.headers.get('retry-after'), await limited.json()], [429, '60', { ok: false, error: 'rate_limited' }]);
});

test('hosted Rau answers rau_not_configured with RAU_ENABLED=false or without an upstream key for its models', async (t) => {
  for (const env of [{ RAU_ENABLED: 'false' }, { RAU_OPENROUTER_KEY: '', ANTHROPIC_API_KEY: '' }, { RAU_MODEL: 'deepseek', RAU_OPENROUTER_KEY: '' }]) {
    const s = await setup(t, env);
    const { lease } = await s.buy('rauMonthly');
    const status = await s.status(lease);
    const learned = await s.learn(lease);
    assert.deepEqual([status.status, status.body], [503, { ok: false, error: 'rau_not_configured' }], JSON.stringify(env));
    assert.deepEqual([learned.status, await learned.json()], [503, { ok: false, error: 'rau_not_configured' }]);
  }
  // HAMA_OPENROUTER_KEY alone still configures the OpenRouter route.
  const s = await setup(t, { RAU_OPENROUTER_KEY: '', ANTHROPIC_API_KEY: '', HAMA_OPENROUTER_KEY: OPENROUTER_KEY });
  const { lease } = await s.buy('rauMonthly');
  assert.equal((await s.status(lease)).status, 200);
});

test('a key with an active plan in the frozen hama.json keeps Rau; the file is never written', async (t) => {
  const s = await setup(t);
  const enrolled = (await s.admin('/v1/admin/licenses/issue', {})).license;
  const disabled = (await s.admin('/v1/admin/licenses/issue', {})).license;
  const hamaFile = path.join(s.directory, 'hama.json');
  const legacy = {
    plans: {
      [enrolled.keyId]: { status: 'active', allowanceUsd: null, periodAnchor: '2026-09-05T00:00:00.000Z', enrolledAt: '2026-09-05T00:00:00.000Z' },
      [disabled.keyId]: { status: 'disabled', disabledReason: 'admin', periodAnchor: '2026-09-05T00:00:00.000Z' },
    },
    ledgers: { [enrolled.keyId]: { period: { start: '2026-10-05T00:00:00.000Z', usedUsd: 3, calls: 2 } } },
  };
  await fs.writeFile(hamaFile, JSON.stringify(legacy));
  const on = await s.activate(enrolled.key);
  const off = await s.activate(disabled.key);
  assert.deepEqual([on.answer.rau, off.answer.rau], [{ eligible: true }, { eligible: false }]);
  assert.deepEqual([(await s.status(on.lease)).body.eligible, (await s.status(off.lease)).body.eligible], [true, false]);
  assert.equal((await s.learn(on.lease, { prompt: 'legacy' })).status, 200);
  await s.billed(enrolled.keyId, 1);
  assert.deepEqual(JSON.parse(await fs.readFile(hamaFile, 'utf8')), legacy);
});

test('admin: ledgers and weekly spend without keys or emails, an old allowances field left alone, and the CLI tables', async (t) => {
  const OLD_KEY = ['sk', 'or', 'old', 'placeholder'].join('-');
  const s = await setup(t, {}, { seed: { 'rau.json': { allowances: { lic_old: { status: 'active', openrouterKey: OLD_KEY, capUsd: 2 } } } } });
  const rau = await s.buy('rauMonthly');
  assert.equal((await s.learn(rau.lease, { prompt: 'one' })).status, 200);
  s.openrouter.next({ status: 500, json: {} });
  assert.equal((await s.learn(rau.lease, { prompt: 'two' })).status, 200);
  await s.billed(rau.keyId, 2);

  const list = await s.adminGet('/v1/admin/rau');
  assert.deepEqual([list.configured, list.allowanceUsd, list.trialAllowanceUsd, list.count], [true, 8, 2, 1]);
  assert.deepEqual(list.models.map((m) => m.id), ['openrouter-haiku', 'anthropic-haiku']);
  assert.deepEqual(list.ledgers[0], {
    principalId: rau.keyId, source: 'plan', allowanceUsd: 8, usedUsd: 2 * HAIKU_CALL_USD, remainingUsd: 8 - 2 * HAIKU_CALL_USD,
    periodCalls: 2, periodEnd: PERIOD_END, totalUsd: 2 * HAIKU_CALL_USD, calls: 2, lastCallAt: new Date(T0).toISOString(),
  });
  const spend = await s.adminGet('/v1/admin/rau/spend?weeks=2');
  assert.deepEqual(spend.weeks.map((w) => w.week), [weekOf(T0), weekOf(T0 - 7 * 86400000)]);
  assert.deepEqual(spend.weeks[0].models.haiku, {
    usd: 2 * HAIKU_CALL_USD, calls: 2, inputTokens: 2000, outputTokens: 600, cacheReadTokens: 4000, cacheWriteTokens: 1000,
    routes: { openrouter: HAIKU_CALL_USD, anthropic: HAIKU_CALL_USD },
  });
  assert.deepEqual([spend.totals.usd, spend.totals.calls], [2 * HAIKU_CALL_USD, 2]);
  assert.equal((await s.adminGet('/v1/admin/rau/spend?weeks=0')).error, 'weeks_invalid');
  assert.equal((await fetch(`${s.origin}/v1/admin/rau`)).status, 403);
  const stored = JSON.parse(await fs.readFile(s.rauFile, 'utf8'));
  assert.equal(stored.allowances.lic_old.openrouterKey, OLD_KEY, 'the old field is never touched');

  const run = (...args) => promisify(execFile)(process.execPath, [CLI, ...args], { env: { ...process.env, SITE_API_BASE: s.origin, ADMIN_TOKEN: ADMIN } });
  const ledgers = (await run('rau')).stdout;
  const money = (usd) => `\\$${usd.toFixed(4).replace('.', '\\.')}`;
  const two = money(2 * HAIKU_CALL_USD);
  assert.match(ledgers, new RegExp(`${rau.keyId}\\s+plan\\s+${two}\\s+\\$8\\s+${money(8 - 2 * HAIKU_CALL_USD)}\\s+2026-11-20\\s+2\\s+${two}`));
  const weekly = (await run('rau-spend', '--weeks', '2')).stdout;
  assert.match(weekly, new RegExp(`${weekOf(T0)}\\s+haiku\\s+2\\s+${two}\\s+2000\\s+600\\s+4000\\s+1000\\s+openrouter ${money(HAIKU_CALL_USD)}, anthropic ${money(HAIKU_CALL_USD)}`));
  assert.match(weekly, new RegExp(`2 weeks · 2 calls · ${two}`));
  for (const text of [JSON.stringify(list), JSON.stringify(spend), ledgers, weekly]) {
    for (const secret of [OLD_KEY, OPENROUTER_KEY, ANTHROPIC_KEY, rau.lease, 'buyer1@example.com', rau.key]) assert.ok(!text.includes(secret), secret);
  }
});
