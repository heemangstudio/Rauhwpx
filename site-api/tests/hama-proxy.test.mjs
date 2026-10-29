import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { generateLeaseKeyPair } from '../license-lease.mjs';
import { createSiteServer } from '../server.mjs';
import { createFakeAnthropic, createFakeOpenRouter } from './fixtures/fake-hama-upstreams.mjs';

const ADMIN = 'admin-token-for-hama-proxy-tests';
const PAIR = generateLeaseKeyPair();
// Placeholders built at runtime: never a real key, never key-shaped.
const ANTHROPIC_KEY = ['test', 'anthropic', 'placeholder'].join('-');
const OPENROUTER_KEY = ['test', 'openrouter', 'placeholder'].join('-');
const HAIKU = 'anthropic/claude-haiku-5.5';
const DEEPSEEK = 'deepseek/deepseek-v4.1-flash';
// ANTHROPIC_USAGE at list price: 1000 in, 2000 cache read, 500 cache write (5 m), 300 out.
const HAPPY_COST = 0.0003325;

async function setup(t, { anthropic = true, openrouter = true } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'site-api-hama-proxy-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true, maxRetries: 5 }));
  const fakeAnthropic = createFakeAnthropic();
  const fakeOpenRouter = createFakeOpenRouter();
  const anthropicBase = await fakeAnthropic.listen();
  const openrouterBase = await fakeOpenRouter.listen('/api/v1');
  t.after(() => fakeAnthropic.close());
  t.after(() => fakeOpenRouter.close());
  const logs = [];
  const server = createSiteServer({
    RAU_SITE_DATA: directory,
    LICENSE_SIGNING_PRIVATE_KEY: PAIR.privateKeyDerBase64,
    ADMIN_TOKEN: ADMIN,
    HAMA_ENABLED: 'true',
    ANTHROPIC_API_BASE: anthropicBase,
    OPENROUTER_API_BASE: openrouterBase,
    ...(anthropic ? { ANTHROPIC_API_KEY: ANTHROPIC_KEY } : {}),
    ...(openrouter ? { HAMA_OPENROUTER_KEY: OPENROUTER_KEY } : {}),
  }, { log: (line) => logs.push(line), emailProvider: null });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections?.(); return new Promise((resolve) => server.close(resolve)); });
  const origin = `http://127.0.0.1:${server.address().port}`;

  const post = (route, body, headers = {}, init = {}) => fetch(`${origin}${route}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), ...init,
  });
  const admin = (route, body) => post(route, body, { Authorization: `Bearer ${ADMIN}` }).then((r) => r.json());
  /** An active license with an activated device; enrolled in Hama unless `enroll` is false. */
  async function member({ enroll = true, allowanceUsd, edition } = {}) {
    const { license } = await admin('/v1/admin/licenses/issue', { note: 'hama proxy test' });
    if (edition) {
      const file = path.join(directory, 'licenses.json');
      const state = JSON.parse(await fs.readFile(file, 'utf8'));
      state.licenses[license.keyId].edition = edition;
      await fs.writeFile(file, `${JSON.stringify(state, null, 2)}\n`);
    }
    const res = await post('/v1/license/activate', { key: license.key, deviceId: 'device-mac-aaaaaaaa', appVersion: '2.1.0', platform: 'darwin' });
    const { lease } = await res.json();
    if (enroll) await admin('/v1/admin/hama/enroll', { keyId: license.keyId, ...(allowanceUsd ? { allowanceUsd } : {}) });
    return { keyId: license.keyId, lease };
  }
  const claude = (lease, body, headers = {}, init) => post('/v1/hama/anthropic/v1/messages', body,
    { 'x-api-key': lease, 'anthropic-version': '2023-06-01', ...headers }, init);
  const cheap = (lease, body, headers = {}) => post('/v1/hama/openrouter/chat/completions', body, { Authorization: `Bearer ${lease}`, ...headers });
  const usage = async (keyId) => (await fetch(`${origin}/v1/admin/hama/usage?keyId=${keyId}`, { headers: { Authorization: `Bearer ${ADMIN}` } })).json();
  /** Billing runs right after the response ends; wait for the n-th entry. */
  async function billed(keyId, n) {
    for (let i = 0; i < 200; i += 1) {
      const result = await usage(keyId);
      if (result.entries.length >= n) return result;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`usage for ${keyId} never reached ${n}`);
  }
  return { origin, fakeAnthropic, fakeOpenRouter, logs, member, claude, cheap, usage, billed };
}

const ask = (text, extra = {}) => ({ model: HAIKU, max_tokens: 64000, stream: true, system: 'You edit documents.', messages: [{ role: 'user', content: text }], ...extra });
const chat = (text, extra = {}) => ({ model: DEEPSEEK, stream: true, messages: [{ role: 'system', content: 'You edit documents.' }, { role: 'user', content: text }], ...extra });

test('Claude goes to Anthropic with the owner key, Haiku id and clamped output, and is billed from its usage', async (t) => {
  const s = await setup(t);
  const m = await s.member();

  const res = await s.claude(m.lease, ask('hello'), { 'anthropic-beta': 'fine-grained-tool-streaming-2025-05-14', authorization: 'Bearer leaked' });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-hama-provider'), 'anthropic');
  const text = await res.text();
  assert.match(text, /event: message_start/);
  assert.match(text, /event: message_stop/);

  const [call] = s.fakeAnthropic.calls;
  assert.equal(call.body.model, 'claude-haiku-5-5');
  assert.equal(call.body.max_tokens, 16000);
  assert.equal(call.body.session_id, undefined);
  assert.equal(call.headers['x-api-key'], ANTHROPIC_KEY);
  assert.equal(call.headers['anthropic-version'], '2023-06-01');
  assert.equal(call.headers['anthropic-beta'], 'fine-grained-tool-streaming-2025-05-14');
  assert.equal(call.headers.authorization, undefined);
  assert.ok(!JSON.stringify(call.headers).includes(m.lease));
  assert.equal(s.fakeOpenRouter.calls.length, 0);

  const { entries } = await s.billed(m.keyId, 1);
  assert.deepEqual(entries[0], {
    at: entries[0].at, id: 'msg_anthropic_1', route: 'anthropic', provider: 'anthropic', model: 'claude-haiku-5-5',
    inputTokens: 1000, outputTokens: 300, cacheReadTokens: 2000, cacheWriteTokens: 500, costUsd: HAPPY_COST, costSource: 'price_table',
  });

  // Not streamed, no max_tokens: the cap is set, and the JSON reply is billed too.
  const plain = await s.claude(m.lease, { model: 'claude-haiku-5-5', messages: [{ role: 'user', content: 'plain' }] });
  assert.equal(plain.status, 200);
  assert.equal((await plain.json()).id, 'msg_anthropic_2');
  assert.equal(s.fakeAnthropic.calls[1].body.max_tokens, 16000);
  const after = await s.billed(m.keyId, 2);
  assert.equal(after.plan.caps.cap_5h.usedUsd, 2 * HAPPY_COST);
});

test('Claude fails over to OpenRouter on 529, 500, 429, network errors, billing 400, 401 and a 200 overloaded stream', async (t) => {
  const s = await setup(t);
  const m = await s.member();
  const failures = [
    ['529', { status: 529, json: { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } } }],
    ['500', { status: 500, json: { type: 'error', error: { type: 'api_error', message: 'Internal' } } }],
    ['429', { status: 429, json: { type: 'error', error: { type: 'rate_limit_error', message: 'Slow down' } } }],
    ['network', { network: true }],
    ['billing', { status: 400, json: { type: 'error', error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API.' } } }],
    ['401', { status: 401, json: { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } } }],
    ['stream', { errorEvent: 'overloaded_error' }],
  ];
  for (const [index, [name, failure]] of failures.entries()) {
    s.fakeAnthropic.next(failure);
    const res = await s.claude(m.lease, ask(`failover ${name}`)); // a new conversation each time
    assert.equal(res.status, 200, name);
    assert.equal(res.headers.get('x-hama-provider'), 'openrouter', name);
    assert.match(await res.text(), /message_stop/);
    const call = s.fakeOpenRouter.calls[index];
    assert.equal(call.path, '/api/v1/messages');
    assert.equal(call.body.model, HAIKU);
    assert.equal(call.body.max_tokens, 16000);
    assert.equal(typeof call.body.session_id, 'string');
    assert.equal(call.headers.authorization, `Bearer ${OPENROUTER_KEY}`);
    assert.equal(call.headers['x-api-key'], undefined);
  }
  const { entries } = await s.billed(m.keyId, failures.length);
  assert.ok(entries.every((e) => e.provider === 'openrouter:Anthropic' && e.costSource === 'upstream' && e.costUsd === 0.0004));

  // A plain 400 is the client's own mistake: passed through, no backup, nothing billed.
  const before = s.fakeOpenRouter.calls.length;
  const invalid = { type: 'error', error: { type: 'invalid_request_error', message: 'messages.0: field required' } };
  s.fakeAnthropic.next({ status: 400, json: invalid });
  const res = await s.claude(m.lease, ask('bad request'));
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), invalid);
  assert.equal(s.fakeOpenRouter.calls.length, before);
  assert.equal((await s.usage(m.keyId)).entries.length, failures.length);
});

test('a session that failed over stays on OpenRouter instead of flip-flopping', async (t) => {
  const s = await setup(t);
  const m = await s.member();
  s.fakeAnthropic.next({ status: 529, json: { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } } });
  await (await s.claude(m.lease, ask('long task'))).text();
  assert.equal(s.fakeAnthropic.calls.length, 1);
  // Same conversation start → same session; Pi's x-session-id groups turns explicitly.
  const second = await s.claude(m.lease, ask('long task', { messages: [{ role: 'user', content: 'long task' }, { role: 'assistant', content: 'ok' }, { role: 'user', content: 'go on' }] }));
  await second.text();
  assert.equal(second.headers.get('x-hama-provider'), 'openrouter');
  assert.equal(s.fakeAnthropic.calls.length, 1);
  assert.equal(s.fakeOpenRouter.calls[1].body.session_id, s.fakeOpenRouter.calls[0].body.session_id);
  // Another conversation still starts on Anthropic.
  await (await s.claude(m.lease, ask('other task'))).text();
  assert.equal(s.fakeAnthropic.calls.length, 2);
});

test('no failover once bytes reached the client; a cut stream is billed by estimate', async (t) => {
  const s = await setup(t);
  const m = await s.member();
  s.fakeAnthropic.next({ cutAfter: 3 }); // message_start, block start, "Hello", then the connection drops
  const res = await s.claude(m.lease, ask('cut'));
  assert.equal(res.status, 200);
  await assert.rejects(res.text());
  assert.equal(s.fakeOpenRouter.calls.length, 0);
  const { entries } = await s.billed(m.keyId, 1);
  assert.equal(entries[0].id, 'msg_anthropic_1');
  assert.equal(entries[0].costSource, 'estimate');
  assert.equal(entries[0].inputTokens, 1000);
  assert.equal(entries[0].outputTokens, 2); // "Hello": 5 bytes at ~3 bytes per token, rounded up
});

test('a client that disconnects mid-stream aborts upstream and is still billed', async (t) => {
  const s = await setup(t);
  const m = await s.member();
  s.fakeAnthropic.next({ hold: true });
  const abort = new AbortController();
  const res = await s.claude(m.lease, ask('cancel me'), {}, { signal: abort.signal });
  const reader = res.body.getReader();
  let seen = '';
  while (!seen.includes(' there')) seen += new TextDecoder().decode((await reader.read()).value);
  abort.abort();
  for (let i = 0; i < 200 && !s.fakeAnthropic.calls[0].closed; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(s.fakeAnthropic.calls[0].closed, true);
  const { entries } = await s.billed(m.keyId, 1);
  assert.equal(entries[0].id, 'msg_anthropic_1');
  assert.equal(entries[0].costSource, 'estimate');
  assert.equal(entries[0].outputTokens, 4); // "Hello there"
});

test('only Haiku 5.5 is hosted: Sonnet and Opus ids are refused on both routes, Claude ids on the OpenAI route', async (t) => {
  const s = await setup(t);
  const m = await s.member();
  const refused = ['anthropic/claude-sonnet-5.5', 'claude-sonnet-5-5', 'anthropic/claude-opus-5.5', 'claude-opus-5-5'];
  for (const model of refused) {
    const res = await s.claude(m.lease, ask('x', { model }));
    assert.equal(res.status, 400, model);
    assert.equal((await res.json()).error.type, 'model_not_allowed');
  }
  for (const model of [...refused, HAIKU, 'claude-haiku-5-5']) {
    const res = await s.cheap(m.lease, chat('x', { model }));
    assert.equal(res.status, 400, model);
    assert.equal((await res.json()).error.code, 'model_not_allowed');
  }
  const fallbackList = await s.cheap(m.lease, chat('x', { models: [DEEPSEEK, 'anthropic/claude-opus-5.5'] }));
  assert.equal(fallbackList.status, 400);
  const serverTool = await s.claude(m.lease, ask('x', { tools: [{ type: 'web_search_20260209', name: 'web_search' }] }));
  assert.equal((await serverTool.json()).error.type, 'tool_not_allowed');
  assert.equal(s.fakeAnthropic.calls.length + s.fakeOpenRouter.calls.length, 0);

  const models = await (await fetch(`${s.origin}/v1/hama/openrouter/models`, { headers: { Authorization: `Bearer ${m.lease}` } })).json();
  assert.deepEqual(models.data.map((x) => x.id), [DEEPSEEK, 'qwen/qwen3.8-flash']);
});

test('caps: Claude gets the 429 quota shape at cap_5h while a cheap model still runs, until cap_month', async (t) => {
  const s = await setup(t);
  // $0.01 a month → cap_5h $0.002, cap_week $0.005, cap_month $0.01.
  const m = await s.member({ allowanceUsd: 0.01 });
  s.fakeOpenRouter.next({ cost: 0.003 });
  await (await s.cheap(m.lease, chat('spend'))).text();
  await s.billed(m.keyId, 1);

  const refused = await s.claude(m.lease, ask('more'));
  assert.equal(refused.status, 429);
  const resetsAt = refused.headers.get('x-hama-resets-at');
  assert.equal(refused.headers.get('x-hama-cap'), 'cap_5h');
  const retryAfter = Number(refused.headers.get('retry-after'));
  assert.ok(retryAfter > 4 * 3600 && retryAfter <= 5 * 3600 + 60, String(retryAfter));
  const body = await refused.json();
  assert.equal(body.type, 'error');
  assert.equal(body.error.type, 'cap_5h');
  assert.equal(body.error.resetsAt, resetsAt);
  assert.ok(body.error.message.includes('quota exceeded'));
  assert.ok(body.error.message.includes(`[hama-cap:cap_5h:${resetsAt}]`));
  assert.equal(s.fakeAnthropic.calls.length, 0);

  // The cheap model is the escape hatch: allowed at cap_5h, refused once the month is spent.
  s.fakeOpenRouter.next({ cost: 0.008 });
  const allowed = await s.cheap(m.lease, chat('keep working'));
  assert.equal(allowed.status, 200);
  await allowed.text();
  await s.billed(m.keyId, 2);
  const month = await s.cheap(m.lease, chat('again'));
  assert.equal(month.status, 429);
  assert.equal(month.headers.get('x-hama-cap'), 'cap_month');
  const monthBody = await month.json();
  assert.equal(monthBody.error.code, 'cap_month');
  assert.match(monthBody.error.message, /quota exceeded \(cap_month\).*\[hama-cap:cap_month:/);
});

test('cheap route forces low reasoning, clamps output, asks for usage, and pins the serving provider per session', async (t) => {
  const s = await setup(t);
  const m = await s.member();
  const first = await s.cheap(m.lease, chat('cheap task', { max_completion_tokens: 99999, reasoning_effort: 'high', reasoning: { effort: 'xhigh' } }));
  assert.equal(first.status, 200);
  await first.text();
  const [call] = s.fakeOpenRouter.calls;
  assert.equal(call.path, '/api/v1/chat/completions');
  assert.equal(call.headers.authorization, `Bearer ${OPENROUTER_KEY}`);
  assert.deepEqual(call.body.reasoning, { effort: 'low' });
  assert.equal(call.body.reasoning_effort, undefined);
  assert.equal(call.body.max_completion_tokens, 16000);
  assert.deepEqual(call.body.usage, { include: true });
  assert.equal(call.body.stream_options.include_usage, true);
  assert.equal(call.body.provider, undefined);
  const { entries } = await s.billed(m.keyId, 1);
  assert.equal(entries[0].costUsd, 0.00002);
  assert.equal(entries[0].costSource, 'upstream');
  assert.equal(entries[0].provider, 'openrouter:DeepInfra');

  // Second call of the same session: the provider that served the first one goes first.
  await (await s.cheap(m.lease, { ...chat('cheap task'), messages: [...chat('cheap task').messages, { role: 'assistant', content: 'Hi you' }, { role: 'user', content: 'next' }] })).text();
  assert.deepEqual(s.fakeOpenRouter.calls[1].body.provider, { order: ['deepinfra'], allow_fallbacks: true });
  assert.equal(s.fakeOpenRouter.calls[1].body.session_id, call.body.session_id);
});

test('the same generation id is billed once', async (t) => {
  const s = await setup(t);
  const m = await s.member();
  s.fakeOpenRouter.next({ id: 'gen-same' }, { id: 'gen-same' });
  await (await s.cheap(m.lease, chat('one'))).text();
  await (await s.cheap(m.lease, chat('two'))).text();
  await (await s.cheap(m.lease, chat('three'))).text();
  const result = await s.billed(m.keyId, 2);
  await new Promise((resolve) => setTimeout(resolve, 50));
  const final = await s.usage(m.keyId);
  assert.deepEqual(final.entries.map((e) => e.id), ['gen-cheap-3', 'gen-same']);
  assert.equal(final.plan.calls, 2);
  assert.equal(result.plan.totalUsd, 0.00004);
});

test('Hama eligibility is enrollment only: an active lease that is not enrolled, also a Pro license, gets 403 everywhere', async (t) => {
  const s = await setup(t);
  for (const options of [{ enroll: false }, { enroll: false, edition: 'pro' }]) {
    const m = await s.member(options);
    const status = await fetch(`${s.origin}/v1/hama/status`, { headers: { 'x-api-key': m.lease } });
    assert.equal(status.status, 403);
    assert.deepEqual(await status.json(), { ok: false, error: 'hama_not_enrolled' });
    const claude = await s.claude(m.lease, ask('x'));
    assert.equal(claude.status, 403);
    assert.equal((await claude.json()).error.type, 'hama_not_enrolled');
    const cheap = await s.cheap(m.lease, chat('x'));
    assert.equal(cheap.status, 403);
    assert.equal((await cheap.json()).error.code, 'hama_not_enrolled');
  }
  const bad = await s.claude('not-a-lease', ask('x'));
  assert.equal(bad.status, 401);
  assert.equal((await bad.json()).error.type, 'unauthorized');
  assert.equal(s.fakeAnthropic.calls.length + s.fakeOpenRouter.calls.length, 0);
});
