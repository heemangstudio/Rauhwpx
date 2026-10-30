import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { generateLeaseKeyPair, signLease } from '../license-lease.mjs';
import { createSiteServer } from '../server.mjs';
import { createFakeOpenRouter } from './fixtures/fake-openrouter.mjs';

const ADMIN = 'admin-token-for-gift-tests';
const PROVISIONING = 'pk-test-provisioning';
const PAIR = generateLeaseKeyPair();
const OTHER_PAIR = generateLeaseKeyPair();
const MAC_A = 'device-mac-aaaaaaaa';
const MAC_B = 'device-mac-bbbbbbbb';
const WIN = 'device-win-cccccccc';
const SONNET = 'anthropic/claude-sonnet-5.5';

async function setup(t, env = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'site-api-gifts-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true, maxRetries: 5 }));
  const upstream = createFakeOpenRouter({ provisioningKey: PROVISIONING });
  const apiBase = await upstream.listen();
  t.after(() => upstream.close());
  const logs = [];
  const server = createSiteServer({
    RAU_SITE_DATA: directory,
    LICENSE_SIGNING_PRIVATE_KEY: PAIR.privateKeyDerBase64,
    ADMIN_TOKEN: ADMIN,
    OPENROUTER_PROVISIONING_KEY: PROVISIONING,
    OPENROUTER_API_BASE: apiBase,
    GIFT_EVENT_ID: 'special-test',
    GIFT_AMOUNT_USD: '20',
    ...env,
  }, { log: (line) => logs.push(line), emailProvider: null });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections?.(); return new Promise((resolve) => server.close(resolve)); });
  const origin = `http://127.0.0.1:${server.address().port}`;

  const post = (route, body, headers = {}) => fetch(`${origin}${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const admin = (route, body) => post(route, body, { Authorization: `Bearer ${ADMIN}` }).then((r) => r.json());
  const licensesFile = path.join(directory, 'licenses.json');
  async function setTier(keyId, tier) {
    const state = JSON.parse(await fs.readFile(licensesFile, 'utf8'));
    const record = state.licenses[keyId];
    if (tier === 'beta') Object.assign(record, { tier: 'beta', source: 'beta', deviceLimit: 3, name: 'Beta tester' });
    else delete record.tier;
    await fs.writeFile(licensesFile, `${JSON.stringify(state, null, 2)}\n`);
  }
  // Beta keys are seeded straight into the license state; `tier: 'paid'` leaves the issued record as is.
  async function license({ tier = 'beta' } = {}) {
    const { license: issued } = await admin('/v1/admin/licenses/issue', { note: 'gift test' });
    if (tier === 'beta') await setTier(issued.keyId, 'beta');
    const activate = async (deviceId, platform = 'darwin') => {
      const res = await post('/v1/license/activate', { key: issued.key, deviceId, appVersion: '2.1.0', platform });
      return (await res.json()).lease;
    };
    return { ...issued, activate };
  }
  const auth = (lease) => ({ Authorization: `Bearer ${lease}` });
  const status = (lease) => fetch(`${origin}/v1/gift/status`, { headers: auth(lease) });
  const claim = (lease) => post('/v1/gift/claim', {}, auth(lease));
  const chat = (lease, body, init = {}) => post('/v1/gift/openrouter/chat/completions', body, { ...auth(lease), ...init.headers });
  return { origin, upstream, logs, directory, admin, license, setTier, auth, status, claim, chat };
}

const creates = (upstream) => upstream.calls.filter((c) => c.method === 'POST' && c.path === '/api/v1/keys');

test('claim is idempotent across parallel calls and both devices, and the key stays server-side', async (t) => {
  const s = await setup(t);
  const lic = await s.license();
  const leaseA = await lic.activate(MAC_A);
  const leaseB = await lic.activate(MAC_B);

  const before = await (await s.status(leaseA)).json();
  assert.deepEqual(before, {
    ok: true,
    event: { id: 'special-test', amountUsd: 20, endsAt: null, active: true },
    eligible: true,
    claimed: false,
    remainingUsd: null,
    usedUsd: null,
    claimedAt: null,
  });

  const results = await Promise.all([s.claim(leaseA), s.claim(leaseA), s.claim(leaseB)].map(async (p) => {
    const res = await p;
    return { status: res.status, text: await res.text() };
  }));
  assert.equal(creates(s.upstream).length, 1);
  assert.deepEqual(creates(s.upstream)[0].body, {
    name: `hama-gift-special-test-${lic.keyId}`, limit: 20, limit_reset: null, include_byok_in_limit: true,
  });
  const [stored] = [...s.upstream.keys.values()];
  for (const r of results) {
    assert.equal(r.status, 200);
    assert.equal(JSON.parse(r.text).claimed, true);
    assert.ok(!r.text.includes(stored.key));
  }

  const again = await (await s.claim(leaseB)).json();
  assert.equal(again.created, false);
  assert.equal(creates(s.upstream).length, 1);
  const after = await (await s.status(leaseB)).json();
  assert.equal(after.claimed, true);
  assert.equal(after.remainingUsd, 20);
  assert.equal(after.usedUsd, 0);

  const file = JSON.parse(await fs.readFile(path.join(s.directory, 'gifts.json'), 'utf8'));
  assert.equal(file.events['special-test'].grants[lic.keyId].openrouterKey, stored.key);
  const listed = await fetch(`${s.origin}/v1/admin/gifts`, { headers: { Authorization: `Bearer ${ADMIN}` } }).then((r) => r.text());
  assert.ok(!listed.includes(stored.key));
  assert.equal(JSON.parse(listed).committedUsd, 20);
});

test('only an active beta key on an activated macOS or Windows device is eligible', async (t) => {
  const s = await setup(t);
  const lic = await s.license();
  const mac = await lic.activate(MAC_A);
  const win = await lic.activate(WIN, 'win32');
  const linux = await lic.activate('device-lin-dddddddd', 'linux');

  for (const lease of ['', 'not-a-lease', `${mac.split('.')[0]}.${'A'.repeat(86)}`]) {
    const res = await s.claim(lease);
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { ok: false, error: 'unauthorized' });
  }
  const foreign = signLease({ keyId: lic.keyId, key: lic.key, deviceId: MAC_A }, OTHER_PAIR.privateKeyPem).lease;
  assert.equal((await s.status(foreign)).status, 401);
  const expired = signLease({ keyId: lic.keyId, key: lic.key, deviceId: MAC_A, now: Date.now() - 8 * 86400000 }, PAIR.privateKeyPem).lease;
  assert.equal((await s.status(expired)).status, 401);

  // Windows shares the key's gift; Linux is authenticated but never eligible.
  assert.equal((await (await s.status(win)).json()).eligible, true);
  const linuxStatus = await (await s.status(linux)).json();
  assert.equal(linuxStatus.eligible, false);
  const linuxClaim = await s.claim(linux);
  assert.equal(linuxClaim.status, 403);
  assert.equal((await linuxClaim.json()).error, 'not_eligible');
  assert.equal((await s.claim(mac)).status, 200);
  const linuxChat = await s.chat(linux, { model: SONNET, messages: [] });
  assert.equal(linuxChat.status, 403);
  assert.deepEqual(await linuxChat.json(), { error: { code: 403, message: 'not_eligible' } });
  assert.equal((await (await s.status(win)).json()).claimed, true);

  // Deactivated device, then a revoked license.
  const deactivate = await fetch(`${s.origin}/v1/license/deactivate`, {
    method: 'POST', body: JSON.stringify({ key: lic.key, deviceId: WIN }),
  });
  assert.equal(deactivate.status, 200);
  assert.equal((await s.status(win)).status, 401);
  await s.admin('/v1/admin/licenses/revoke', { keyId: lic.keyId, reason: 'test' });
  assert.equal((await s.status(mac)).status, 401);
  assert.equal((await s.chat(mac, { model: SONNET, messages: [] })).status, 401);
});

test('paid keys are not eligible, and a claimed gift stops working once the key is no longer beta', async (t) => {
  const s = await setup(t);
  const paid = await (await s.license({ tier: 'paid' })).activate(MAC_A);
  assert.equal((await (await s.status(paid)).json()).eligible, false);
  const refused = await s.claim(paid);
  assert.equal(refused.status, 403);
  assert.equal((await refused.json()).error, 'not_eligible');
  const paidChat = await s.chat(paid, { model: SONNET, messages: [] });
  assert.equal(paidChat.status, 403);
  assert.deepEqual(await paidChat.json(), { error: { code: 403, message: 'not_eligible' } });
  assert.equal(creates(s.upstream).length, 0);

  const lic = await s.license();
  const lease = await lic.activate(MAC_A);
  assert.equal((await (await s.status(lease)).json()).eligible, true);
  assert.equal((await s.claim(lease)).status, 200);
  assert.equal((await s.chat(lease, { model: SONNET, messages: [] })).status, 200);

  await s.setTier(lic.keyId, 'paid');
  assert.equal((await (await s.status(lease)).json()).eligible, false);
  assert.equal((await s.claim(lease)).status, 403);
  const chat = await s.chat(lease, { model: SONNET, messages: [] });
  assert.equal(chat.status, 403);
  assert.deepEqual(await chat.json(), { error: { code: 403, message: 'not_eligible' } });
  const models = await fetch(`${s.origin}/v1/gift/openrouter/models`, { headers: s.auth(lease) });
  assert.equal(models.status, 403);
  assert.equal(s.upstream.chats.length, 1);
});

test('the global budget stops new gifts and an inactive event refuses claims', async (t) => {
  const s = await setup(t, { GIFT_TOTAL_BUDGET_USD: '30' });
  const first = await (await s.license()).activate(MAC_A);
  const second = await (await s.license()).activate(MAC_A);
  assert.equal((await s.claim(first)).status, 200);
  const blocked = await s.claim(second);
  assert.equal(blocked.status, 409);
  assert.equal((await blocked.json()).error, 'budget_exhausted');
  assert.equal(creates(s.upstream).length, 1);

  const off = await setup(t, { OPENROUTER_PROVISIONING_KEY: '' });
  const lease = await (await off.license()).activate(MAC_A);
  assert.equal((await (await off.status(lease)).json()).event.active, false);
  assert.equal((await off.claim(lease)).status, 410);

  const ended = await setup(t, { GIFT_ENDS_AT: '2020-01-01T00:00:00Z' });
  const late = await (await ended.license()).activate(MAC_A);
  assert.equal((await (await ended.status(late)).json()).event.active, false);
  const refused = await ended.claim(late);
  assert.equal(refused.status, 410);
  assert.equal((await refused.json()).error, 'event_inactive');
  assert.equal(creates(ended.upstream).length, 0);
});

test('a key created by a claim that failed mid-way is cleaned up before the retry', async (t) => {
  const s = await setup(t);
  const lic = await s.license();
  const lease = await lic.activate(MAC_A);
  s.upstream.failNextCreate(500, { createAnyway: true });
  const failed = await s.claim(lease);
  assert.equal(failed.status, 502);
  assert.equal((await failed.json()).error, 'upstream_unavailable');
  assert.equal(s.upstream.keys.size, 1); // orphan whose secret we never stored

  assert.equal((await s.claim(lease)).status, 200);
  assert.equal(s.upstream.keys.size, 1);
  const [live] = [...s.upstream.keys.values()];
  const file = JSON.parse(await fs.readFile(path.join(s.directory, 'gifts.json'), 'utf8'));
  assert.equal(file.events['special-test'].grants[lic.keyId].openrouterKey, live.key);

  // A definite 4xx frees the reservation without leaving anything behind.
  const other = await (await s.license()).activate(MAC_A);
  s.upstream.failNextCreate(400);
  assert.equal((await s.claim(other)).status, 502);
  assert.equal((await s.claim(other)).status, 200);
  assert.equal(s.upstream.keys.size, 2);
});

test('streaming chat passes through chunk by chunk with the stored key and capped tokens', async (t) => {
  const s = await setup(t);
  const lease = await (await s.license()).activate(MAC_A);
  const notClaimed = await s.chat(lease, { model: SONNET, messages: [] });
  assert.equal(notClaimed.status, 403);
  assert.deepEqual(await notClaimed.json(), { error: { code: 403, message: 'gift_not_claimed' } });
  await s.claim(lease);

  const res = await s.chat(lease, { model: SONNET, stream: true, max_tokens: 100000, messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/event-stream/);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const seen = [];
  for (let i = 0; i < 3; i += 1) {
    const { value } = await reader.read(); // arrives while upstream still holds the next chunk
    seen.push(decoder.decode(value));
    s.upstream.release();
  }
  let rest = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    rest += decoder.decode(value);
  }
  assert.deepEqual(seen.map((c) => JSON.parse(c.slice(6)).choices[0].delta.content), ['Hel', 'lo', ' there']);
  assert.equal(rest, 'data: [DONE]\n\n');

  const forwarded = s.upstream.calls.find((c) => c.path === '/api/v1/chat/completions');
  const [stored] = [...s.upstream.keys.values()];
  assert.equal(forwarded.auth, `Bearer ${stored.key}`);
  assert.equal(forwarded.body.max_tokens, 32000);
  assert.ok(!s.logs.join('\n').includes(lease) && !s.logs.join('\n').includes(stored.key));

  const plain = await s.chat(lease, { model: SONNET, messages: [] });
  assert.equal(plain.status, 200);
  assert.equal(s.upstream.chats.at(-1).body.max_tokens, 32000);
});

test('a client disconnect aborts the upstream stream and frees its concurrency slot', async (t) => {
  const s = await setup(t);
  const lease = await (await s.license()).activate(MAC_A);
  await s.claim(lease);
  const open = [];
  for (let i = 0; i < 4; i += 1) {
    const controller = new AbortController();
    const res = await fetch(`${s.origin}/v1/gift/openrouter/chat/completions`, {
      method: 'POST', signal: controller.signal, headers: s.auth(lease),
      body: JSON.stringify({ model: SONNET, stream: true, messages: [] }),
    });
    await res.body.getReader().read();
    open.push(controller);
  }
  const fifth = await s.chat(lease, { model: SONNET, stream: true, messages: [] });
  assert.equal(fifth.status, 429);

  open[0].abort();
  const deadline = Date.now() + 2000;
  while (!s.upstream.chats[0].closed && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
  assert.equal(s.upstream.chats[0].closed, true);
  let after = await s.chat(lease, { model: SONNET, messages: [] });
  while (after.status === 429 && Date.now() < deadline) after = await s.chat(lease, { model: SONNET, messages: [] });
  assert.equal(after.status, 200);
  open.slice(1).forEach((c) => c.abort());
});

test('non-Claude models are refused and the catalog lists only allowed models', async (t) => {
  const s = await setup(t);
  const lease = await (await s.license()).activate(MAC_A);
  await s.claim(lease);
  for (const body of [{ model: 'openai/gpt-6' }, { model: 'openrouter/auto' }, { model: SONNET, models: [SONNET, 'openai/gpt-6'] }, {}]) {
    const res = await s.chat(lease, { ...body, messages: [] });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error.message, /not available with the gift credit/);
  }
  assert.equal(s.upstream.chats.length, 0);
  const models = await fetch(`${s.origin}/v1/gift/openrouter/models`, { headers: s.auth(lease) }).then((r) => r.json());
  assert.deepEqual(models.data.map((m) => m.id), [SONNET, 'anthropic/claude-opus-5.5']);
});

test('BYOK spend counts toward the gift, and an exhausted or disabled gift answers 402', async (t) => {
  const s = await setup(t);
  const lic = await s.license();
  const lease = await lic.activate(MAC_A);
  await s.claim(lease);
  const [hash, stored] = [...s.upstream.keys.entries()][0];
  assert.equal((await s.chat(lease, { model: SONNET, messages: [] })).status, 200);
  const partly = await (await s.status(lease)).json();
  assert.equal(partly.usedUsd, 0.2625); // $0.25 on the Anthropic key + $0.0125 BYOK fee
  assert.equal(partly.remainingUsd, 19.7375);

  // Spent entirely through the owner's Anthropic key: OpenRouter credit usage stays tiny.
  stored.usage = 1;
  stored.byokUsage = 19;

  const exhausted = await s.chat(lease, { model: SONNET, messages: [] });
  assert.equal(exhausted.status, 402);
  const body = await exhausted.json();
  assert.equal(body.error.code, 402);
  assert.match(body.error.message, /insufficient credits/i);
  const key = await fetch(`${s.origin}/v1/gift/openrouter/auth/key`, { headers: s.auth(lease) }).then((r) => r.json());
  assert.deepEqual(key, { data: { label: 'HamaEditor gift', limit: 20, usage: 20, limit_remaining: 0, limit_reset: null, is_free_tier: false } });
  const credits = await fetch(`${s.origin}/v1/gift/openrouter/credits`, { headers: s.auth(lease) }).then((r) => r.json());
  assert.deepEqual(credits, { data: { total_credits: 20, total_usage: 20 } });

  const disabled = await s.admin('/v1/admin/gifts/disable', { keyId: lic.keyId, reason: 'abuse' });
  assert.equal(disabled.changed, true);
  assert.equal(disabled.gift.status, 'revoked');
  assert.equal(disabled.gift.openrouterKey, undefined);
  assert.equal(s.upstream.keys.get(hash).disabled, true);
  assert.equal(s.upstream.calls.find((c) => c.method === 'PATCH').path, `/api/v1/keys/${hash}`);
  assert.equal((await s.chat(lease, { model: SONNET, messages: [] })).status, 402);
  const after = await (await s.status(lease)).json();
  assert.equal(after.claimed, true);
  assert.equal(after.remainingUsd, 0);
});

test('a 402 for the owner\'s OpenRouter balance passes through and does not read as a used-up gift', async (t) => {
  const s = await setup(t);
  const lease = await (await s.license()).activate(MAC_A);
  await s.claim(lease);
  const owner = { error: { code: 402, message: 'Insufficient credits. Add more using https://openrouter.ai/credits', metadata: { limit_source: 'openrouter_credits' } } };
  s.upstream.failNextChat(402, owner);
  const res = await s.chat(lease, { model: SONNET, messages: [] });
  assert.equal(res.status, 402);
  assert.deepEqual(await res.json(), owner);
});

test('per-license amounts: an allocation sets the claimed limit, 0 blocks the claim, and status reports the license amount', async (t) => {
  const s = await setup(t);
  const amount = (keyId, amountUsd, token = ADMIN) => fetch(`${s.origin}/v1/admin/gifts/amount`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ keyId, amountUsd }),
  }).then(async (r) => ({ status: r.status, body: await r.json() }));
  const small = await s.license();
  const plain = await s.license();
  const none = await s.license();

  for (const token of ['', 'wrong']) {
    assert.deepEqual(await amount(small.keyId, 5, token), { status: 403, body: { ok: false, error: 'forbidden' } });
  }
  for (const bad of [-1, 1000.01, 'abc', null, '']) {
    assert.deepEqual(await amount(small.keyId, bad), { status: 400, body: { ok: false, error: 'amount_invalid' } }, String(bad));
  }
  const paid = await s.license({ tier: 'paid' });
  assert.equal((await amount(paid.keyId, 5)).body.error, 'invalid_key');
  assert.equal((await amount('lic_nope', 5)).status, 404);

  const set = await amount(small.keyId, '4.999');
  assert.equal(set.status, 200);
  assert.deepEqual(set.body.gift, { amountUsd: 5, status: 'unclaimed', limitUsd: null, usedUsd: null, remainingUsd: null, claimedAt: null });
  assert.equal((await amount(none.keyId, 0)).status, 200);

  const smallLease = await small.activate(MAC_A);
  const before = await (await s.status(smallLease)).json();
  assert.equal(before.event.amountUsd, 5);
  assert.equal(before.eligible, true);
  const claimed = await (await s.claim(smallLease)).json();
  assert.equal(claimed.remainingUsd, 5);
  assert.equal(creates(s.upstream)[0].body.limit, 5);
  assert.equal((await (await s.status(smallLease)).json()).remainingUsd, 5);

  const plainLease = await plain.activate(MAC_A);
  assert.equal((await (await s.status(plainLease)).json()).event.amountUsd, 20);

  const noneLease = await none.activate(MAC_A);
  const noGift = await (await s.status(noneLease)).json();
  assert.equal(noGift.event.amountUsd, 0);
  assert.equal(noGift.eligible, false);
  const refused = await s.claim(noneLease);
  assert.equal(refused.status, 403);
  assert.equal((await refused.json()).error, 'not_eligible');
  assert.equal(creates(s.upstream).length, 1);

  const betas = await fetch(`${s.origin}/v1/admin/licenses/betas`, { headers: { Authorization: `Bearer ${ADMIN}` } }).then((r) => r.json());
  const byId = Object.fromEntries(betas.betas.map((b) => [b.keyId, b.gift]));
  assert.equal(betas.giftEvent.amountUsd, 20);
  assert.deepEqual({ ...byId[small.keyId], claimedAt: null }, { amountUsd: 5, status: 'active', limitUsd: 5, usedUsd: 0, remainingUsd: 5, claimedAt: null });
  assert.equal(byId[plain.keyId].status, 'unclaimed');
  assert.equal(byId[plain.keyId].amountUsd, 20);
  assert.equal(byId[none.keyId].amountUsd, 0);
});

test('changing an active gift PATCHes the OpenRouter limit within the budget, and a failed PATCH changes nothing', async (t) => {
  const s = await setup(t, { GIFT_TOTAL_BUDGET_USD: '30' });
  const amount = (keyId, amountUsd) => fetch(`${s.origin}/v1/admin/gifts/amount`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ADMIN}` },
    body: JSON.stringify({ keyId, amountUsd }),
  }).then(async (r) => ({ status: r.status, body: await r.json() }));
  const patches = () => s.upstream.calls.filter((c) => c.method === 'PATCH');
  const a = await s.license();
  const b = await s.license();
  const leaseA = await a.activate(MAC_A);
  const leaseB = await b.activate(MAC_A);
  await amount(b.keyId, 5);
  await s.claim(leaseA);
  await s.claim(leaseB);
  const [[hashA, keyA]] = [...s.upstream.keys.entries()];
  assert.equal((await (await s.status(leaseA)).json()).remainingUsd, 20); // fills the balance cache

  const over = await amount(a.keyId, 26); // 5 + 26 > 30
  assert.deepEqual(over, { status: 409, body: { ok: false, error: 'budget_exhausted' } });
  assert.equal(patches().length, 0);

  const raised = await amount(a.keyId, 25);
  assert.equal(raised.status, 200);
  assert.equal(raised.body.gift.limitUsd, 25);
  assert.deepEqual(patches().map((c) => [c.path, c.body]), [[`/api/v1/keys/${hashA}`, { limit: 25 }]]);
  assert.equal(keyA.limit, 25);
  const after = await (await s.status(leaseA)).json();
  assert.equal(after.event.amountUsd, 25);
  assert.equal(after.remainingUsd, 25);

  // Lowering below what is already spent leaves the gift used up.
  assert.equal((await s.chat(leaseA, { model: SONNET, messages: [] })).status, 200);
  assert.equal((await amount(a.keyId, 0.25)).status, 200);
  assert.equal((await (await s.status(leaseA)).json()).remainingUsd, 0);
  assert.equal((await s.chat(leaseA, { model: SONNET, messages: [] })).status, 402);

  // $0 is refused by the proxy itself, whatever OpenRouter makes of a zero limit.
  assert.equal((await amount(a.keyId, 0)).status, 200);
  const chats = s.upstream.chats.length;
  assert.equal((await s.chat(leaseA, { model: SONNET, messages: [] })).status, 402);
  assert.equal(s.upstream.chats.length, chats);
  const zero = await (await s.status(leaseA)).json();
  assert.deepEqual([zero.claimed, zero.eligible, zero.event.amountUsd, zero.remainingUsd], [true, true, 0, 0]);

  for (const failure of [400, 500]) {
    s.upstream.failNextPatch(failure);
    assert.deepEqual(await amount(a.keyId, 10), { status: 502, body: { ok: false, error: 'upstream_unavailable' } });
    const file = JSON.parse(await fs.readFile(path.join(s.directory, 'gifts.json'), 'utf8'));
    const grant = file.events['special-test'].grants[a.keyId];
    assert.equal(grant.limitUsd, 0);
    // After a 5xx the new limit may be live on OpenRouter, so it stays counted against the budget.
    assert.equal(grant.pendingLimitUsd, failure === 500 ? 10 : undefined);
  }
  const listed = await fetch(`${s.origin}/v1/admin/gifts`, { headers: { Authorization: `Bearer ${ADMIN}` } }).then((r) => r.json());
  assert.equal(listed.committedUsd, 15);
  assert.equal((await amount(a.keyId, 10)).status, 200);
  assert.equal(JSON.parse(await fs.readFile(path.join(s.directory, 'gifts.json'), 'utf8')).events['special-test'].grants[a.keyId].pendingLimitUsd, undefined);

  // A revoked gift only stores the amount.
  await s.admin('/v1/admin/gifts/disable', { keyId: b.keyId });
  const count = patches().length;
  const revoked = await amount(b.keyId, 8);
  assert.equal(revoked.status, 200);
  assert.equal(revoked.body.gift.status, 'revoked');
  assert.equal(patches().length, count);
});

test('overlapping limit changes for one gift finish in order, so a late reply cannot undercount the budget', async (t) => {
  const s = await setup(t, { GIFT_TOTAL_BUDGET_USD: '30' });
  const amount = (keyId, amountUsd) => fetch(`${s.origin}/v1/admin/gifts/amount`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ADMIN}` },
    body: JSON.stringify({ keyId, amountUsd }),
  }).then(async (r) => ({ status: r.status, body: await r.json() }));
  const a = await s.license();
  const b = await s.license();
  await s.claim(await a.activate(MAC_A));
  const [[, keyA]] = [...s.upstream.keys.entries()];

  // Two admin tabs: the first lowers to $5 and its reply is slow, the second raises to $25.
  const resume = s.upstream.holdNextPatch();
  const lowering = amount(a.keyId, 5);
  while (keyA.limit !== 5) await new Promise((resolve) => setTimeout(resolve, 5));
  const raising = amount(a.keyId, 25);
  await new Promise((resolve) => setTimeout(resolve, 50));
  resume();
  assert.equal((await lowering).status, 200);
  assert.equal((await raising).status, 200);

  const listed = await fetch(`${s.origin}/v1/admin/gifts`, { headers: { Authorization: `Bearer ${ADMIN}` } }).then((r) => r.json());
  assert.equal(keyA.limit, 25);
  assert.equal(listed.grants.find((g) => g.keyId === a.keyId).limitUsd, 25);
  assert.equal(listed.committedUsd, 25);
  // $25 + another $20 gift would exceed the $30 budget at OpenRouter.
  assert.equal((await s.claim(await b.activate(MAC_B))).status, 409);
});

test('issue-beta takes giftUsd, checked before the key is created', async (t) => {
  const s = await setup(t);
  const listBetas = () => fetch(`${s.origin}/v1/admin/licenses/betas`, { headers: { Authorization: `Bearer ${ADMIN}` } }).then((r) => r.json());
  const bad = await fetch(`${s.origin}/v1/admin/licenses/issue-beta`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ADMIN}` },
    body: JSON.stringify({ name: 'Tester', giftUsd: 5000 }),
  });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error, 'amount_invalid');
  assert.equal((await listBetas()).count, 0);

  const issued = await s.admin('/v1/admin/licenses/issue-beta', { name: 'Tester', giftUsd: 7.5 });
  assert.equal(issued.gift.amountUsd, 7.5);
  const [beta] = (await listBetas()).betas;
  assert.equal(beta.gift.amountUsd, 7.5);

  const off = await setup(t, { OPENROUTER_PROVISIONING_KEY: '' });
  const refused = await off.admin('/v1/admin/licenses/issue-beta', { name: 'Tester', giftUsd: 7.5 });
  assert.equal(refused.error, 'event_inactive');
  const offBetas = await fetch(`${off.origin}/v1/admin/licenses/betas`, { headers: { Authorization: `Bearer ${ADMIN}` } }).then((r) => r.json());
  assert.deepEqual([offBetas.count, offBetas.giftEvent], [0, null]);
});
