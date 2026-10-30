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
import { createSiteServer } from '../server.mjs';
import { createFakeOpenRouter } from './fixtures/fake-openrouter.mjs';
import { PRO_ENV, PRO_YEARLY_ID, proPaid, signedGroblePost } from './fixtures/groble-pro.mjs';

const ADMIN = 'admin-token-for-rau-tests';
const SECRET = 'whsec_test_rau';
const PROVISIONING = 'pk-test-rau-provisioning';
const PAIR = generateLeaseKeyPair();
const T0 = Date.parse('2026-10-20T14:22:11+09:00');
const UPGRADE = 'https://heemangstudios.com/pricing.html#pro';
const PINNED = 'deepseek/deepseek-v4.1-flash';
const CLI = fileURLToPath(new URL('../scripts/license-admin.mjs', import.meta.url));
// Rau-0.1 answers JSON-ish text; the server returns it as is.
const REPLY = '```json\n{"ops":[{"op":"add","text":"표는 가운데 정렬"}]}\n```';

async function setup(t, env = {}, { dir, clock = { now: T0 } } = {}) {
  const directory = dir ?? await fs.mkdtemp(path.join(os.tmpdir(), 'site-api-rau-'));
  if (!dir) t.after(() => fs.rm(directory, { recursive: true, force: true, maxRetries: 5 }));
  const upstream = createFakeOpenRouter({ provisioningKey: PROVISIONING });
  const apiBase = await upstream.listen();
  t.after(() => upstream.close());
  upstream.setChatReply(REPLY);
  upstream.setChatSpend({ credit: 0.0003 });
  const server = createSiteServer({
    RAU_SITE_DATA: directory,
    GROBLE_WEBHOOK_SECRET: SECRET,
    LICENSE_SIGNING_PRIVATE_KEY: PAIR.privateKeyDerBase64,
    ADMIN_TOKEN: ADMIN,
    OPENROUTER_PROVISIONING_KEY: PROVISIONING,
    OPENROUTER_API_BASE: apiBase,
    ...PRO_ENV,
    ...env,
  }, { log: () => {}, emailProvider: null, alertProvider: null, now: () => clock.now });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections?.(); return new Promise((resolve) => server.close(resolve)); });
  const origin = `http://127.0.0.1:${server.address().port}`;

  const post = (route, body, headers = {}) => fetch(`${origin}${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  const admin = (route, body) => post(route, body, { Authorization: `Bearer ${ADMIN}` }).then((r) => r.json());
  const licensesFile = path.join(directory, 'licenses.json');
  /** Activate `key` on a device; the lease to use as the bearer. */
  async function activate(key, deviceId = `mac-${Math.random().toString(36).slice(2, 10)}`) {
    const res = await (await post('/v1/license/activate', { key, deviceId, platform: 'darwin' })).json();
    assert.equal(res.ok, true, JSON.stringify(res));
    return { lease: res.lease, deviceId, keyId: res.keyId, key };
  }
  async function pro({ n = 1, contentId } = {}) {
    const event = proPaid({ merchantUid: `pro_${n}`, ref: `hama-pro-${n}`, email: `pro${n}@example.com`, ...(contentId ? { contentId } : {}) });
    assert.equal((await (await signedGroblePost(origin, SECRET, event)).json()).action, 'issued');
    const { key } = await (await fetch(`${origin}/v1/license/by-ref?ref=hama-pro-${n}`)).json();
    return activate(key);
  }
  const auth = (lease) => ({ Authorization: `Bearer ${lease}` });
  const learn = (lease, body = { prompt: 'Rau-0.1 prompt' }) => post('/v1/rau/learn', body, auth(lease));
  const status = (lease) => fetch(`${origin}/v1/rau/status`, { headers: auth(lease) });
  const chats = () => upstream.calls.filter((c) => c.path === '/api/v1/chat/completions');
  const creates = () => upstream.calls.filter((c) => c.method === 'POST' && c.path === '/api/v1/keys');
  const patches = () => upstream.calls.filter((c) => c.method === 'PATCH');
  return { origin, directory, upstream, clock, post, admin, licensesFile, activate, pro, auth, learn, status, chats, creates, patches };
}

test('config: pinned model and reasoning effort by default, overrides honored, aliases and bad efforts refused at startup', () => {
  const defaults = resolveRauConfig({});
  assert.deepEqual([defaults.model, defaults.reasoningEffort, defaults.maxOutputTokens, defaults.monthlyCapUsd, defaults.enabled], [PINNED, 'low', 2000, 1, true]);
  const custom = resolveRauConfig({ RAU_MODEL: 'deepseek/deepseek-v4.2-flash', RAU_REASONING_EFFORT: 'Minimal', RAU_MONTHLY_CAP_USD: '2.5', RAU_ENABLED: 'false' });
  assert.deepEqual([custom.model, custom.reasoningEffort, custom.monthlyCapUsd, custom.enabled], ['deepseek/deepseek-v4.2-flash', 'minimal', 2.5, false]);
  assert.throws(() => resolveRauConfig({ RAU_MODEL: '~deepseek/deepseek-flash-latest' }), /pinned/);
  assert.throws(() => resolveRauConfig({ RAU_REASONING_EFFORT: 'max' }), /RAU_REASONING_EFFORT must be one of/);
  assert.throws(() => resolveRauConfig({ RAU_ENABLED: 'maybe' }), /RAU_ENABLED/);
  assert.throws(() => resolveRauConfig({ RAU_MONTHLY_CAP_USD: '0' }), /positive/);
});

test('a Pro key learns through the server: one capped monthly key, the pinned model with low reasoning, text verbatim, the key never sent', async (t) => {
  const s = await setup(t);
  const { lease, keyId } = await s.pro();
  assert.deepEqual(await (await s.status(lease)).json(), {
    ok: true, eligible: true, reason: null, upgradeUrl: UPGRADE, capUsd: 1, usedUsd: 0, remainingUsd: 1, resetsAt: '2026-11-01T00:00:00.000Z',
  });
  assert.equal(s.creates().length, 0, 'status never creates a key');

  const res = await s.learn(lease, { prompt: '문서 기억 프롬프트' });
  const text = await res.text();
  assert.equal(res.status, 200, text);
  assert.deepEqual(JSON.parse(text), {
    ok: true, text: REPLY, model: PINNED,
    usage: { usedUsd: 0.0003, capUsd: 1, remainingUsd: 0.9997, resetsAt: '2026-11-01T00:00:00.000Z' },
  });
  assert.deepEqual(s.creates().map((c) => c.body), [{ name: `hama-rau-${keyId}`, limit: 1, limit_reset: 'monthly', include_byok_in_limit: true }]);
  const [stored] = [...s.upstream.keys.values()];
  const [chat] = s.chats();
  assert.equal(chat.auth, `Bearer ${stored.key}`, 'the per-license key, not the management key');
  assert.deepEqual([chat.body.model, chat.body.reasoning, chat.body.max_tokens, chat.body.stream, chat.body.messages], [PINNED, { effort: 'low' }, 2000, false, [{ role: 'user', content: '문서 기억 프롬프트' }]]);

  await s.learn(lease);
  assert.equal(s.creates().length, 1, 'one key per license');
  const statusText = await (await s.status(lease)).text();
  const adminText = await (await fetch(`${s.origin}/v1/admin/rau`, { headers: { Authorization: `Bearer ${ADMIN}` } })).text();
  for (const body of [text, statusText, adminText]) assert.ok(!body.includes(stored.key));
  assert.ok(!adminText.includes(PROVISIONING) && !text.includes(PROVISIONING));
  const listed = JSON.parse(adminText);
  assert.deepEqual([listed.count, listed.allowances[0].keyId, listed.allowances[0].usedUsd, listed.allowances[0].capUsd, listed.allowances[0].openrouterKey], [1, keyId, 0.0006, 1, undefined]);
  const file = JSON.parse(await fs.readFile(path.join(s.directory, 'rau.json'), 'utf8'));
  assert.equal(file.allowances[keyId].openrouterKey, stored.key, 'the key stays in rau.json');
  assert.deepEqual(file.allowances[keyId].ledger, { '2026-10': 0.0006 });

  const cli = await promisify(execFile)(process.execPath, [CLI, 'rau'], { env: { ...process.env, SITE_API_BASE: s.origin, ADMIN_TOKEN: ADMIN } });
  assert.match(cli.stdout, new RegExp(`${keyId} active · \\$0.0006 / \\$1\n$`));
  assert.ok(!cli.stdout.includes(stored.key));
});

test('RAU_MODEL and RAU_REASONING_EFFORT reach the upstream body', async (t) => {
  const s = await setup(t, { RAU_MODEL: 'deepseek/deepseek-v4.2-flash', RAU_REASONING_EFFORT: 'medium', RAU_MAX_OUTPUT_TOKENS: '800' });
  const { lease } = await s.pro();
  assert.equal((await s.learn(lease)).status, 200);
  const [chat] = s.chats();
  assert.deepEqual([chat.body.model, chat.body.reasoning, chat.body.max_tokens], ['deepseek/deepseek-v4.2-flash', { effort: 'medium' }, 800]);
});

test('every key that is not an active Pro key gets rau_requires_pro with the upgrade page, and nothing reaches OpenRouter', async (t) => {
  const s = await setup(t);
  const kinds = {};
  // GLJFC9 ₩9,900/yr subscription.
  const annual = proPaid({ merchantUid: 'gl_1', ref: 'hama-sub-1', contentId: 'GLJFC9', price: 9900, cycle: 12 });
  await signedGroblePost(s.origin, SECRET, annual);
  kinds.annual = (await (await fetch(`${s.origin}/v1/license/by-ref?ref=hama-sub-1`)).json()).key;
  kinds.lifetime = (await s.admin('/v1/admin/licenses/issue', {})).license.key;
  kinds.signature = (await s.admin('/v1/admin/licenses/issue', { edition: 'signature' })).license.key;
  kinds.beta = (await s.admin('/v1/admin/licenses/issue-beta', { name: 'Beta tester' })).license.key;
  kinds.manual = (await s.admin('/v1/admin/licenses/issue', { years: 1 })).license.key;
  const grandfathered = await s.admin('/v1/admin/licenses/issue', {});
  const state = JSON.parse(await fs.readFile(s.licensesFile, 'utf8'));
  Object.assign(state.licenses[grandfathered.license.keyId], { source: 'grandfather', amount: 0 });
  await fs.writeFile(s.licensesFile, JSON.stringify(state));
  kinds.grandfathered = grandfathered.license.key;

  const leases = {};
  for (const [kind, key] of Object.entries(kinds)) leases[kind] = (await s.activate(key)).lease;
  // A Pro key revoked by an admin, while its lease is still valid.
  const revoked = await s.pro({ n: 2 });
  await s.admin('/v1/admin/licenses/revoke', { key: revoked.key, reason: 'test' });
  leases.revokedPro = revoked.lease;
  const check = async (kind, lease) => {
    const res = await s.learn(lease);
    assert.equal(res.status, 403, kind);
    assert.deepEqual(await res.json(), { ok: false, error: 'rau_requires_pro', upgradeUrl: UPGRADE }, kind);
    const st = await (await s.status(lease)).json();
    assert.deepEqual([st.eligible, st.reason, st.upgradeUrl, st.usedUsd], [false, 'rau_requires_pro', UPGRADE, null], kind);
  };
  for (const [kind, lease] of Object.entries(leases)) await check(kind, lease);

  // A Pro key past its expiry (no payment grace) with a lease from two days before.
  const lapsed = await s.pro({ n: 3 });
  s.clock.now = Date.parse('2026-11-19T12:00:00+09:00');
  const lapsedLease = (await (await s.post('/v1/license/validate', { key: lapsed.key, deviceId: lapsed.deviceId })).json()).lease;
  s.clock.now = Date.parse('2026-11-21T12:00:00+09:00');
  await check('expiredPro', lapsedLease);
  assert.equal(s.upstream.calls.length, 0);

  // Not a lease at all.
  const bad = await s.learn('not-a-lease');
  assert.deepEqual([bad.status, await bad.json()], [401, { ok: false, error: 'unauthorized' }]);
});

test('the cap is enforced from our own ledger even when OpenRouter undercounts, without calling upstream', async (t) => {
  const s = await setup(t);
  const { lease } = await s.pro();
  s.upstream.setChatSpend({ credit: 0.6 });
  assert.equal((await (await s.learn(lease)).json()).usage.usedUsd, 0.6);
  // OpenRouter reports nothing spent (a lagging count); the ledger alone says 0.6, still under $1.
  const [stored] = [...s.upstream.keys.values()];
  const undercount = () => { stored.usage = 0; stored.byokUsage = 0; };
  undercount();
  s.clock.now += 20 * 1000;
  const second = await (await s.learn(lease)).json();
  assert.deepEqual([second.usage.usedUsd, second.usage.remainingUsd], [1.2, 0]);
  undercount();
  s.clock.now += 20 * 1000;
  const before = s.chats().length;
  const refused = await s.learn(lease);
  assert.equal(refused.status, 402);
  assert.deepEqual(await refused.json(), { ok: false, error: 'rau_cap_reached', capUsd: 1, usedUsd: 1.2, resetsAt: '2026-11-01T00:00:00.000Z' });
  assert.equal(s.chats().length, before, 'refused before upstream');
  const st = await (await s.status(lease)).json();
  assert.deepEqual([st.eligible, st.usedUsd, st.remainingUsd], [true, 1.2, 0]);
});

test('the cap is enforced from OpenRouter usage, and an upstream key-limit refusal answers rau_cap_reached', async (t) => {
  const s = await setup(t);
  const { lease } = await s.pro();
  assert.equal((await s.learn(lease)).status, 200);
  // Usage OpenRouter counted that our ledger missed (e.g. a call that timed out after it was billed).
  const [stored] = [...s.upstream.keys.values()];
  stored.usage = 1.05;
  s.clock.now += 20 * 1000; // past the 15 s balance cache
  const before = s.chats().length;
  const refused = await s.learn(lease);
  assert.equal(refused.status, 402);
  assert.equal((await refused.json()).usedUsd, 1.05);
  assert.equal(s.chats().length, before, 'refused before upstream');

  const other = await s.pro({ n: 2 });
  assert.equal((await s.learn(other.lease)).status, 200);
  s.upstream.failNextChat(403, { error: { code: 403, message: 'Key limit exceeded (monthly limit).', metadata: { limit_source: 'openrouter_key_limit' } } });
  const limited = await s.learn(other.lease);
  assert.equal(limited.status, 402);
  assert.equal((await limited.json()).error, 'rau_cap_reached');
  const chatsAfter = s.chats().length;
  assert.equal((await s.learn(other.lease)).status, 402, 'the next call stops before upstream');
  assert.equal(s.chats().length, chatsAfter);

  s.upstream.failNextChat(500, { error: { code: 500, message: 'boom' } });
  const third = await s.pro({ n: 3 });
  const failed = await s.learn(third.lease);
  assert.deepEqual([failed.status, await failed.json()], [502, { ok: false, error: 'upstream_unavailable' }]);
});

test('a new month sets the key limit again exactly once and starts a fresh ledger', async (t) => {
  const s = await setup(t);
  const first = await s.pro();
  s.upstream.setChatSpend({ credit: 0.6 });
  await s.learn(first.lease);
  await s.learn(first.lease);
  assert.equal((await s.learn(first.lease)).status, 402);
  assert.equal(s.patches().length, 0);

  // November: OpenRouter's monthly reset clears the key's usage; our ledger starts a new period.
  s.clock.now = Date.parse('2026-11-02T09:00:00Z');
  const [stored] = [...s.upstream.keys.values()];
  stored.usage = 0;
  stored.byokUsage = 0;
  const { lease } = await (await s.post('/v1/license/validate', { key: first.key, deviceId: first.deviceId })).json();
  // Two at once each see an empty month, so both run; the third stops at the cap.
  const results = await Promise.all([s.learn(lease), s.learn(lease)].map(async (p) => (await p).json()));
  assert.deepEqual(results.map((r) => r.ok), [true, true]);
  assert.equal((await s.learn(lease)).status, 402);
  assert.deepEqual(s.patches().map((c) => c.body), [{ limit: 1, limit_reset: 'monthly', include_byok_in_limit: true }]);
  const st = await (await s.status(lease)).json();
  assert.deepEqual([st.resetsAt, st.usedUsd], ['2026-12-01T00:00:00.000Z', 1.2]);
  const file = JSON.parse(await fs.readFile(path.join(s.directory, 'rau.json'), 'utf8'));
  assert.deepEqual(file.allowances[first.keyId].ledger, { '2026-10': 1.2, '2026-11': 1.2 });
  assert.equal(file.allowances[first.keyId].period, '2026-11');
});

test('RAU_MONTHLY_CAP_USD sets new keys and re-limits existing ones once after a restart', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'site-api-rau-cap-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true, maxRetries: 5 }));
  const clock = { now: T0 };
  const before = await setup(t, {}, { dir, clock });
  const { key, deviceId, lease } = await before.pro({ contentId: PRO_YEARLY_ID });
  assert.equal((await before.learn(lease)).status, 200);
  const keyHash = [...before.upstream.keys.keys()][0];

  // Same data, new cap. The restarted server talks to a fresh fake, so seed it with the existing key.
  const after = await setup(t, { RAU_MONTHLY_CAP_USD: '2.5' }, { dir, clock });
  after.upstream.keys.set(keyHash, { ...before.upstream.keys.get(keyHash) });
  const fresh = (await (await after.post('/v1/license/validate', { key, deviceId })).json()).lease;
  assert.equal((await (await after.status(fresh)).json()).capUsd, 2.5);
  const res = await (await after.learn(fresh)).json();
  assert.equal(res.usage.capUsd, 2.5);
  await after.learn(fresh);
  assert.deepEqual(after.patches().map((c) => [c.path, c.body.limit]), [[`/api/v1/keys/${keyHash}`, 2.5]]);
  assert.equal(after.creates().length, 0);

  const other = await after.pro({ n: 2 });
  await after.learn(other.lease);
  assert.equal(after.creates()[0].body.limit, 2.5);
});

test('prompt limits: at most 48 KB of UTF-8, a non-empty string, a JSON object; none reaches upstream', async (t) => {
  const s = await setup(t);
  const { lease } = await s.pro();
  const korean = '가'.repeat(MAX_RAU_PROMPT_BYTES / 3 - 1); // 3 bytes each, just under the cap
  assert.equal((await s.learn(lease, { prompt: `${korean}abc` })).status, 200, 'exactly 48 KB is fine');
  const calls = s.chats().length;
  for (const body of [{ prompt: `${korean}abcd` }, { prompt: '' }, { prompt: 42 }, {}, { prompt: 'x'.repeat(400 * 1024) }]) {
    const res = await s.learn(lease, body);
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { ok: false, error: 'invalid', field: 'prompt' });
  }
  const notJson = await s.learn(lease, 'not json');
  assert.deepEqual([notJson.status, await notJson.json()], [400, { ok: false, error: 'invalid', field: 'body' }]);
  assert.equal(s.chats().length, calls);
});

test('per-license rate limit answers 429 rate_limited with Retry-After', async (t) => {
  const s = await setup(t);
  const { lease } = await s.pro();
  for (let i = 0; i < 20; i += 1) assert.equal((await s.learn(lease)).status, 200);
  const limited = await s.learn(lease);
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('retry-after'), '60');
  assert.deepEqual(await limited.json(), { ok: false, error: 'rate_limited' });
});

test('rau_not_configured without the management key or with RAU_ENABLED=false', async (t) => {
  for (const env of [{ OPENROUTER_PROVISIONING_KEY: '' }, { RAU_ENABLED: 'false' }]) {
    const s = await setup(t, env);
    const { lease } = await s.pro();
    for (const res of [await s.learn(lease), await s.status(lease)]) {
      assert.deepEqual([res.status, await res.json()], [503, { ok: false, error: 'rau_not_configured' }]);
    }
  }
});

test('gift grants never expose their OpenRouter key in admin or app answers', async (t) => {
  const s = await setup(t, { GIFT_EVENT_ID: 'special-test' });
  const beta = await s.admin('/v1/admin/licenses/issue-beta', { name: 'Beta tester' });
  const { lease } = await s.activate(beta.license.key);
  const claimed = await (await s.post('/v1/gift/claim', {}, s.auth(lease))).text();
  const [stored] = [...s.upstream.keys.values()];
  const answers = [
    claimed,
    await (await fetch(`${s.origin}/v1/gift/status`, { headers: s.auth(lease) })).text(),
    await (await fetch(`${s.origin}/v1/gift/openrouter/key`, { headers: s.auth(lease) })).text(),
    await (await fetch(`${s.origin}/v1/admin/gifts`, { headers: { Authorization: `Bearer ${ADMIN}` } })).text(),
    await (await fetch(`${s.origin}/v1/admin/licenses/betas`, { headers: { Authorization: `Bearer ${ADMIN}` } })).text(),
    JSON.stringify(await s.admin('/v1/admin/gifts/amount', { keyId: beta.license.keyId, amountUsd: 5 })),
    JSON.stringify(await s.admin('/v1/admin/gifts/disable', { keyId: beta.license.keyId, reason: 'test' })),
  ];
  for (const text of answers) assert.ok(!text.includes(stored.key), text.slice(0, 120));
});
