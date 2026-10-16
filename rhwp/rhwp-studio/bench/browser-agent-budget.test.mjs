import test from 'node:test';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { startBudgetProxy, reconcileBudgetLedger, jointContextReservation } from './browser-agent-budget.mjs';

const model = (pricing = { prompt: '0.004', completion: '0.1' }, context = 1000) => ({ id: 'test/model', architecture: { output_modalities: ['text'] }, context_length: context, pricing, endpoints: [{ context_length: context, max_completion_tokens: 10, pricing }] });
async function fixture(t, options = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'browser-budget-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const seen = [];
  let reply = options.reply || { usage: { cost: 0.2 }, choices: [] };
  const upstream = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    seen.push({ url: req.url, headers: req.headers, rawBody: raw, body: JSON.parse(raw || '{}') });
    if (typeof reply === 'function') return reply(req, res);
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(reply));
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => { upstream.closeAllConnections(); upstream.close(); });
  const config = { ledgerFile: path.join(dir, 'ledger.json'), key: 'secret-test-key', models: ['test/model'],
    upstreamUrl: `http://127.0.0.1:${upstream.address().port}/api/v1`, catalog: [options.model || model()], ...options.proxyOptions };
  let proxy = await startBudgetProxy(config);
  t.after(async () => { await proxy.stop(); });
  return { config, seen, get proxy() { return proxy; }, setReply(value) { reply = value; },
    async restart() { await proxy.stop(); proxy = await startBudgetProxy(config); },
    async request(body = {}, endpoint = '/chat/completions', token = proxy.token) {
      const response = await fetch(`${proxy.url}${endpoint}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'test/model', messages: [{ role: 'user', content: 'hello' }], ...body }) });
      const text = await response.text(); return { status: response.status, text };
    } };
}

test('authoritative cost settles reservation, key stays upstream, output and routing bounded', async t => {
  const f = await fixture(t);
  assert.equal((await f.request({ max_tokens: 10 })).status, 200);
  assert.equal(f.proxy.snapshot().spentUsd, 0.2);
  assert.equal(f.seen[0].body.max_tokens, 10);
  assert.equal(f.seen[0].body.provider.allow_fallbacks, false);
  assert.equal(f.seen[0].body.provider.require_parameters, true);
  assert.equal(f.seen[0].body.provider.max_price.prompt, 4000);
  assert.equal(f.seen[0].headers.authorization, 'Bearer secret-test-key');
  assert.notEqual(f.proxy.token, 'secret-test-key');
  assert.ok(!(await fs.readFile(f.config.ledgerFile, 'utf8')).includes('secret-test-key'));
});

test('missing usage reservations exhaust $10, including after restart', async t => {
  const f = await fixture(t, { reply: { choices: [] } });
  assert.equal((await f.request()).status, 200);
  assert.equal(f.proxy.snapshot().spentUsd, 4.96);
  await f.restart();
  assert.equal((await f.request()).status, 200);
  assert.equal((await f.request()).status, 402);
  assert.equal(f.seen.length, 2);
  assert.equal(f.proxy.snapshot().spentUsd, 9.92);
});

test('concurrent requests stop behind the first unsettled reservation', async t => {
  const f = await fixture(t, { reply: { choices: [] } });
  const responses = await Promise.all([f.request(), f.request(), f.request()]);
  assert.deepEqual(responses.map(r => r.status).sort(), [200, 402, 402]);
  assert.equal(f.seen.length, 1);
  assert.equal(f.proxy.snapshot().requests.length, 1);
  for (const response of responses.filter(r => r.status === 402)) assert.match(response.text, /BUDGET_HOLD_UNSETTLED_REQUEST/);
});

test('tier maximum and full context are reserved; cache writes are conservative', async t => {
  const f = await fixture(t, { reply: { choices: [] }, model: model({ prompt: '0.001', completion: '0.01', input_cache_write: '0.001', overrides: [{ min_prompt_tokens: 500, prompt: '0.004', completion: '0.1' }] }) });
  assert.equal((await f.request()).status, 200);
  assert.equal(f.proxy.snapshot().spentUsd, 5.95);
  assert.equal((await f.request()).status, 402);
});

test('streaming final usage reconciles even when SSE arrives split', async t => {
  const f = await fixture(t, { reply(req, res) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.write('data: {"choices":[]}\r\n\r\n');
    res.write('data: {"usage":{"co');
    res.end('st":0.125}}\n\ndata: [DONE]\n\n');
  } });
  assert.equal((await f.request({ stream: true })).status, 200);
  assert.equal(f.proxy.snapshot().spentUsd, 0.125);
});

test('an authoritative cost above reservation permanently blocks new paid calls', async t => {
  const f = await fixture(t, { reply: { usage: { cost: 5.1 } } });
  assert.equal((await f.request()).status, 200);
  assert.equal(f.proxy.snapshot().blocked, true);
  await f.restart();
  assert.equal((await f.request()).status, 503);
  assert.equal(f.seen.length, 1);
});

test('reject endpoint, unknown model, images, paid native tools and request plugins before upstream', async t => {
  const f = await fixture(t);
  for (const body of [
    { model: 'unknown' },
    { messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.test/image' } }] }] },
    { tools: [{ type: 'web_search' }] }, { plugins: [{ id: 'web' }] }, { n: 2 },
  ]) assert.equal((await f.request(body)).status, 400);
  assert.equal((await f.request({}, '/responses')).status, 404);
  assert.equal((await f.request({}, '/chat/completions', 'wrong-token')).status, 401);
  assert.equal(f.seen.length, 0);
});

test('unknown, negative, missing and unrecognized tier prices fail closed', async t => {
  const f = await fixture(t);
  await f.proxy.stop();
  for (const pricing of [null, { prompt: '0.1' }, { prompt: '-1', completion: '0' }, { prompt: '0', completion: '0', unknown_charge: '1' }, { prompt: '0', completion: '0', overrides: [{ condition: 'unknown', prompt: '1' }] }]) {
    await assert.rejects(startBudgetProxy({ ...f.config, catalog: [model(pricing)] }));
  }
  assert.equal(f.seen.length, 0);
});

test('a second proxy cannot acquire the ledger across processes', async t => {
  const f = await fixture(t);
  const child = spawn(process.execPath, ['--input-type=module', '-e', `import { startBudgetProxy, reconcileBudgetLedger, jointContextReservation } from ${JSON.stringify(new URL('./browser-agent-budget.mjs', import.meta.url).href)}; try { await startBudgetProxy(${JSON.stringify(f.config)}); process.exit(1); } catch { process.exit(0); }`], { stdio: 'ignore' });
  const [code] = await once(child, 'exit');
  assert.equal(code, 0);
});

test('crashed owner releases kernel lock and reservation remains on disk', async t => {
  const f = await fixture(t);
  await f.proxy.stop();
  const child = spawn(process.execPath, ['--input-type=module', '-e', `import { startBudgetProxy, reconcileBudgetLedger, jointContextReservation } from ${JSON.stringify(new URL('./browser-agent-budget.mjs', import.meta.url).href)}; const p=await startBudgetProxy(${JSON.stringify(f.config)}); process.stdout.write(JSON.stringify({url:p.url,token:p.token})+'\\n');`], { stdio: ['ignore', 'pipe', 'inherit'] });
  const [chunk] = await once(child.stdout, 'data');
  const proxy = JSON.parse(String(chunk));
  f.setReply({ choices: [] });
  const response = await fetch(`${proxy.url}/chat/completions`, { method: 'POST', headers: { Authorization: `Bearer ${proxy.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'test/model', messages: [{ role: 'user', content: 'hi' }] }) });
  await response.text();
  child.kill('SIGKILL'); await once(child, 'exit');
  // The lock helper receives EOF asynchronously; bounded retries only acquire locks.
  let reopened;
  for (let i = 0; i < 20; i++) {
    try { reopened = await startBudgetProxy(f.config); break; } catch (error) { if (!/already locked/.test(error.message)) throw error; await new Promise(resolve => setTimeout(resolve, 20)); }
  }
  assert.ok(reopened);
  assert.equal(reopened.snapshot().spentUsd, 4.96);
  await reopened.stop();
});

test('corrupt or altered cap ledger cannot reset the budget', async t => {
  const f = await fixture(t);
  await f.proxy.stop();
  await fs.writeFile(f.config.ledgerFile, '{"version":1,"cap":"20000000000000","blocked":false,"requests":[]}');
  await assert.rejects(startBudgetProxy(f.config), /Invalid budget ledger/);
  assert.equal(f.seen.length, 0);
});

test('catalog with unknown context or image outputs cannot start', async t => {
  const f = await fixture(t);
  await f.proxy.stop();
  for (const raw of [{ ...model(), context_length: null }, { ...model(), architecture: { output_modalities: ['text', 'image'] } }]) {
    await assert.rejects(startBudgetProxy({ ...f.config, catalog: [raw] }));
  }
});

test('transport failure and invalid usage retain full reservation', async t => {
  const f = await fixture(t, { reply: { usage: { cost: -0.1 } } });
  await f.request();
  assert.equal(f.proxy.snapshot().spentUsd, 4.96);
  assert.equal((await f.request()).status, 402);
  await f.restart();
  f.setReply((req, res) => res.destroy());
  assert.equal((await f.request()).status, 502);
  assert.equal(f.proxy.snapshot().spentUsd, 9.92);
  assert.equal((await f.request()).status, 402);
});

test('model-level and UTC time-tier maxima apply even when endpoints omit them', async t => {
  const raw = model({ prompt: '0.001', completion: '0.01' });
  raw.pricing = { ...raw.pricing, overrides: [{ min_prompt_tokens: 500, prompt: '0.003' }, { utc_start: 100, utc_end: 400, utc_days: ['monday'], prompt: '0.004', completion: '0.1' }] };
  const f = await fixture(t, { model: raw, reply: { choices: [] } });
  assert.equal((await f.request()).status, 200);
  assert.equal(f.proxy.snapshot().spentUsd, 4.96);
});

test('reservation includes finite catalog completion ceiling beyond request max_tokens', async t => {
  const raw = model(); raw.endpoints[0].max_completion_tokens = 60;
  const f = await fixture(t, { model: raw, reply: { choices: [] } });
  assert.equal(f.proxy.budgets[0].reservedOutputTokens, 60);
  assert.equal((await f.request({ max_tokens: 10 })).status, 200);
  assert.equal(f.proxy.snapshot().spentUsd, 9.76);
  assert.equal(f.seen[0].body.max_tokens, 10);
  assert.equal((await f.request()).status, 402);
});


test('Pi store:false is accepted and omitted; unsupported diagnostics contain names only', async t => {
  const f = await fixture(t);
  assert.equal((await f.request({ store: false })).status, 200);
  assert.equal(Object.hasOwn(f.seen[0].body, 'store'), false);
  assert.equal((await f.request({ store: true })).status, 400);
  const rejected = await f.request({ metadata: { secret: 'PRIVATE-METADATA-VALUE' }, service_tier: 'PRIVATE-TIER-VALUE' });
  assert.equal(rejected.status, 400);
  assert.match(rejected.text, /metadata, service_tier/);
  assert.ok(!rejected.text.includes('PRIVATE-'));
  assert.equal(f.seen.length, 1);
});


test('generation ID is durable before the rest of its SSE response arrives', async t => {
  let finish;
  const f = await fixture(t, { reply(req, res) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: {"id":"gen-durable","choices":[]}\n\n');
    finish = () => res.end('data: {"id":"gen-durable","usage":{"cost":0.1}}\n\ndata: [DONE]\n\n');
  } });
  const request = f.request({ stream: true });
  let entry;
  for (let i = 0; i < 100; i++) {
    entry = JSON.parse(await fs.readFile(f.config.ledgerFile, 'utf8')).requests[0];
    if (entry?.generationId) break;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal(entry.generationId, 'gen-durable');
  assert.equal(entry.state, 'pending');
  finish();
  assert.equal((await request).status, 200);
  assert.equal(f.proxy.snapshot().spentUsd, 0.1);
});

test('missing streaming usage settles only through authenticated matching generation GET', async t => {
  const f = await fixture(t, { reply(req, res) {
    if (req.method === 'GET') {
      assert.equal(req.url, '/api/v1/generation?id=gen-lookup');
      assert.equal(req.headers.authorization, 'Bearer secret-test-key');
      res.end(JSON.stringify({ data: { id: 'gen-lookup', model: 'test/model', total_cost: 0.123, finish_reason: 'stop', generation_time: 200 } }));
    } else {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end('data: {"id":"gen-lookup","choices":[]}\n\ndata: [DONE]\n\n');
    }
  } });
  assert.equal((await f.request({ stream: true })).status, 200);
  assert.equal(f.proxy.snapshot().spentUsd, 0.123);
  assert.equal(f.proxy.snapshot().requests[0].costSource, 'generation.total_cost');
  assert.equal(f.seen.length, 2);
});

test('stream:true JSON error responses keep status and use their generation ID for lookup', async t => {
  const f = await fixture(t, { reply(req, res) {
    if (req.method === 'GET') return res.end(JSON.stringify({ data: { id: 'gen-error', model: 'test/model', total_cost: 0, finish_reason: 'error', generation_time: 0 } }));
    res.writeHead(429, { 'Content-Type': 'application/json', 'x-request-id': 'req-fixture' });
    res.end(JSON.stringify({ id: 'gen-error', error: { code: 429, message: 'Fake provider throttled' } }));
  } });
  const result = await f.request({ stream: true });
  assert.equal(result.status, 429);
  assert.equal(JSON.parse(result.text).error.code, 429);
  const entry = f.proxy.snapshot().requests[0];
  assert.equal(entry.generationId, 'gen-error');
  assert.equal(entry.upstreamStatus, 429);
  assert.equal(entry.upstreamErrorCode, 429);
  assert.equal(entry.upstreamRequestId, 'req-fixture');
  assert.equal(entry.actual, '0');
  assert.equal((await f.request({ stream: true })).status, 429, 'an authoritative zero-cost error does not hold later requests');
  assert.equal(f.proxy.snapshot().requests.length, 2);
});

test('mismatched, unfinished, absent and invalid authoritative generation costs retain reservation', async t => {
  const valid = { id: 'gen-unresolved', model: 'test/model', total_cost: 0.1, finish_reason: 'stop', generation_time: 5 };
  for (const data of [{ ...valid, id: 'gen-other' }, { ...valid, model: 'wrong/model' }, { ...valid, finish_reason: null }, { ...valid, generation_time: null }, { ...valid, total_cost: null }, { ...valid, total_cost: -1 }]) {
    const f = await fixture(t, { reply(req, res) { res.end(JSON.stringify(req.method === 'GET' ? { data } : { id: 'gen-unresolved', choices: [] })); } });
    assert.equal((await f.request()).status, 200);
    assert.equal(f.proxy.snapshot().spentUsd, 4.96);
    assert.equal(f.proxy.snapshot().requests[0].state, 'pending');
    await f.proxy.stop();
  }
});

test('offline reconciliation makes GETs only and preserves all entries without generation IDs', async t => {
  const f = await fixture(t, { reply: { choices: [] } });
  await f.request();
  await f.proxy.stop();
  const before = await fs.readFile(f.config.ledgerFile, 'utf8');
  const unresolved = await reconcileBudgetLedger({ ...f.config, fetchImpl() { assert.fail('An internal request UUID cannot be queried as a generation ID'); } });
  assert.equal(unresolved.pending, 1);
  assert.equal(unresolved.outcomes[0].status, 'no-generation-id');
  assert.equal(await fs.readFile(f.config.ledgerFile, 'utf8'), before);

  const ledger = JSON.parse(before);
  ledger.requests.push({ id: 'known-request', keyFingerprint: ledger.requests[0].keyFingerprint, model: 'test/model', state: 'pending', reserved: '5000000000000', generationId: 'gen-offline', startedAt: new Date().toISOString() });
  await fs.writeFile(f.config.ledgerFile, JSON.stringify(ledger));
  const reconciled = await reconcileBudgetLedger({ ...f.config, fetchImpl(url, options) {
    assert.equal(options.method, 'GET');
    assert.match(url, /generation\?id=gen-offline$/);
    return Promise.resolve(new Response(JSON.stringify({ data: { id: 'gen-offline', model: 'test/model', total_cost: 0.05, finish_reason: 'stop', generation_time: 5 } })));
  } });
  assert.equal(reconciled.pending, 1);
  assert.equal(reconciled.spentUsd, 5.01);
  const persisted = JSON.parse(await fs.readFile(f.config.ledgerFile, 'utf8'));
  assert.equal(persisted.requests[0].state, 'pending');
  assert.equal(persisted.requests[1].state, 'settled');
  assert.equal(persisted.requests[1].finishedAt, undefined, 'recovery cannot invent a legacy request end time');
  assert.ok(Number.isFinite(Date.parse(persisted.requests[1].settledAt)));
});


test('unavailable generation keeps reservation until explicit reconciliation; overrun blocks', async t => {
  const f = await fixture(t, { reply(req, res) {
    if (req.method === 'GET') { res.writeHead(404); return res.end('{}'); }
    res.end(JSON.stringify({ id: 'gen-delayed', choices: [] }));
  } });
  await f.request();
  assert.equal(f.proxy.snapshot().requests[0].state, 'pending');
  f.setReply((req, res) => {
    assert.equal(req.method, 'GET');
    res.end(JSON.stringify({ data: { id: 'gen-delayed', model: 'test/model', total_cost: 6, finish_reason: 'stop', generation_time: 5 } }));
  });
  assert.equal((await f.proxy.reconcilePending())[0].status, 'settled');
  assert.equal(f.proxy.snapshot().spentUsd, 6);
  assert.equal(f.proxy.snapshot().blocked, true);
  assert.equal((await f.request()).status, 503);
});


test('generation recovery never queries a different key or unbound legacy request', async t => {
  const f = await fixture(t, { reply(req, res) {
    if (req.method === 'GET') { res.writeHead(404); return res.end('{}'); }
    res.end(JSON.stringify({ id: 'gen-key-bound', choices: [] }));
  } });
  await f.request();
  assert.match(f.proxy.snapshot().requests[0].keyFingerprint, /^[a-f0-9]{64}$/);
  assert.ok(!f.proxy.snapshot().requests[0].keyFingerprint.includes('secret-test-key'));
  await f.proxy.stop();
  const before = await fs.readFile(f.config.ledgerFile, 'utf8');
  const different = await reconcileBudgetLedger({ ...f.config, key: 'different-test-key', fetchImpl() { assert.fail('Wrong key must not be used for lookup'); } });
  assert.equal(different.outcomes[0].status, 'key-fingerprint-mismatch');
  assert.equal(await fs.readFile(f.config.ledgerFile, 'utf8'), before);
  const legacy = JSON.parse(before);
  delete legacy.requests[0].keyFingerprint;
  await fs.writeFile(f.config.ledgerFile, JSON.stringify(legacy));
  const unbound = await reconcileBudgetLedger({ ...f.config, fetchImpl() { assert.fail('Legacy request requires explicit key binding'); } });
  assert.equal(unbound.outcomes[0].status, 'missing-key-fingerprint');
  assert.equal(unbound.pending, 1);
});

test('request digest hashes exact forwarded bytes and JSON errors persist terminal time without cost', async t => {
  const f = await fixture(t, { reply(req, res) {
    res.writeHead(429, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 429, message: 'Fake throttle without generation ID or cost' } }));
  } });
  const before = Date.now();
  assert.equal((await f.request({ stream: true, store: false, max_tokens: 10, messages: [{ role: 'user', content: 'PRIVATE-REQUEST-CONTENT' }] })).status, 429);
  const entry = f.proxy.snapshot().requests[0];
  assert.equal(entry.requestDigest, createHash('sha256').update(f.seen[0].rawBody, 'utf8').digest('hex'));
  assert.equal(f.seen[0].body.max_tokens, 10);
  assert.equal(Object.hasOwn(f.seen[0].body, 'store'), false);
  assert.ok(Date.parse(entry.finishedAt) >= before && Date.parse(entry.finishedAt) <= Date.now());
  assert.equal(entry.state, 'pending');
  assert.equal(entry.actual, undefined);
  assert.equal(f.proxy.snapshot().spentUsd, 4.96);
  const persisted = await fs.readFile(f.config.ledgerFile, 'utf8');
  assert.ok(!persisted.includes('PRIVATE-REQUEST-CONTENT'));
  assert.ok(!persisted.includes('secret-test-key'));
  assert.equal(JSON.parse(persisted).requests[0].requestDigest, entry.requestDigest);
  assert.equal(JSON.parse(persisted).requests[0].finishedAt, entry.finishedAt);
});

test('joint context formula equals exhaustive maxima across input/output constraints', () => {
  for (let c = 1; c <= 15; c++) for (let o = 0; o < 20; o++) for (const [i, p] of [[0, 0], [1, 0], [0, 1], [2, 5], [5, 2]]) {
    let maximum = 0;
    for (let x = 0; x <= c; x++) for (let y = 0; y <= Math.min(o, c - x); y++) maximum = Math.max(maximum, i * x + p * y + 3);
    assert.equal(jointContextReservation({ contextLength: c, outputTokens: o, inputPrice: BigInt(i), outputPrice: BigInt(p), requestPrice: 3n }), BigInt(maximum));
  }
  assert.equal(jointContextReservation({ contextLength: 1048576, outputTokens: 943718, inputPrice: 325000n, outputPrice: 1800000n }), 1732771250000n);
  assert.throws(() => jointContextReservation({ contextLength: 10, outputTokens: 5, inputPrice: -1n, outputPrice: 1n }));
});

test('sub-picodollar prices round upward before joint maximization and never underreserve', async t => {
  const f = await fixture(t, { model: model({ prompt: '0.0000000000001', completion: '0.0000000000002', request: '0.0000000000001' }, 3), reply: { choices: [] } });
  await f.request();
  // True maximum is 3*.2 + .1 = .7 picodollars; independent ceiling
  // of rates/fixed yields 3*1 + 1 = 4 picodollars, safely above ceil(.7).
  assert.equal(f.proxy.snapshot().requests[0].reserved, '4');
  assert.ok(BigInt(f.proxy.snapshot().requests[0].reserved) >= 1n);
});

test('explicit configured cap applies to new and resumed ledgers without changing request bounds', async t => {
  const f = await fixture(t, { reply: { choices: [] }, proxyOptions: { maxUsd: 20 } });
  assert.equal(f.proxy.snapshot().capUsd, 20);
  for (let i = 0; i < 4; i++) { assert.equal((await f.request()).status, 200); await f.restart(); }
  assert.equal((await f.request()).status, 402);
  assert.equal(f.proxy.snapshot().spentUsd, 19.84);
  await f.restart();
  assert.equal(f.proxy.snapshot().capUsd, 20);
  assert.equal((await f.request()).status, 402);
  assert.equal(f.seen.length, 4);
});

test('explicit default-cap raise preserves all liabilities and blocked state with private exact backup', async t => {
  const f = await fixture(t, { reply: { choices: [] } });
  await f.request();
  await f.proxy.stop();
  const original = JSON.parse(await fs.readFile(f.config.ledgerFile));
  original.blocked = true;
  await fs.writeFile(f.config.ledgerFile, JSON.stringify(original));
  const bytes = await fs.readFile(f.config.ledgerFile);
  f.config.maxUsd = 20;
  await assert.rejects(f.restart(), /explicit reviewed default-cap raise/);
  assert.deepEqual(await fs.readFile(f.config.ledgerFile), bytes);
  f.config.capAuthorization = 'Explicit operator --budget-usd=20';
  await f.restart();
  const snapshot = f.proxy.snapshot();
  assert.equal(snapshot.capUsd, 20);
  assert.equal(snapshot.blocked, true);
  assert.deepEqual(snapshot.requests, original.requests);
  assert.equal(snapshot.requests[0].state, 'pending');
  assert.equal(Object.hasOwn(snapshot.requests[0], 'actual'), false);
  assert.equal(snapshot.capHistory.length, 1);
  assert.equal(snapshot.capHistory[0].from, '10000000000000');
  assert.equal(snapshot.capHistory[0].to, '20000000000000');
  assert.deepEqual(await fs.readFile(snapshot.capHistory[0].backupFile), bytes);
  assert.equal((await fs.stat(snapshot.capHistory[0].backupFile)).mode & 0o777, 0o600);
  assert.equal((await f.request()).status, 503);
  await f.restart();
  assert.equal(f.proxy.snapshot().capHistory.length, 1);
  delete f.config.maxUsd;
  await assert.rejects(f.restart(), /cap differs/);
});

test('invalid configured caps fail before any upstream or ledger mutation', async t => {
  const f = await fixture(t);
  const before = await fs.readFile(f.config.ledgerFile);
  for (const maxUsd of [0, -1, NaN, Infinity, 1e-13, '20', null, true, Number.MAX_SAFE_INTEGER]) {
    await assert.rejects(startBudgetProxy({ ...f.config, maxUsd }), /Budget cap/);
  }
  assert.deepEqual(await fs.readFile(f.config.ledgerFile), before);
  assert.equal(f.seen.length, 0);
});

test('production output fields, reasoning effort and routing sort pass unchanged while reservations use published ceilings', async t => {
  const f = await fixture(t);
  const reasoning = { effort: 'medium' };
  assert.equal((await f.request({ max_completion_tokens: 7, reasoning, provider: { sort: 'throughput' } })).status, 200);
  assert.equal(f.seen[0].body.max_completion_tokens, 7);
  assert.equal(Object.hasOwn(f.seen[0].body, 'max_tokens'), false);
  assert.deepEqual(f.seen[0].body.reasoning, reasoning);
  assert.equal(f.seen[0].body.provider.sort, 'throughput');
  assert.equal(f.seen[0].body.provider.require_parameters, true);
  assert.equal(f.seen[0].body.provider.allow_fallbacks, false);
  assert.equal(f.proxy.snapshot().requests[0].reserved, '4960000000000');
  assert.deepEqual(f.proxy.snapshot().requests[0].requestedLimits, { maxTokens: null, maxCompletionTokens: 7, reasoningMaxTokens: null });
  assert.equal((await f.request({ max_tokens: 8, reasoning: { max_tokens: 6, exclude: false } })).status, 200);
  assert.equal(f.seen[1].body.max_tokens, 8);
  assert.deepEqual(f.seen[1].body.reasoning, { max_tokens: 6, exclude: false });
  assert.equal((await f.request()).status, 200);
  assert.equal(Object.hasOwn(f.seen[2].body, 'max_tokens'), false);
  assert.equal(Object.hasOwn(f.seen[2].body, 'max_completion_tokens'), false);
});

test('invalid or conflicting output bounds fail before reservation instead of being rewritten', async t => {
  const f = await fixture(t);
  for (const body of [
    { max_tokens: 11 }, { max_completion_tokens: 11 }, { max_tokens: 0 }, { max_tokens: -1 },
    { max_tokens: 1.5 }, { max_completion_tokens: '7' }, { max_tokens: 7, max_completion_tokens: 7 },
    { reasoning: { max_tokens: 11 } }, { reasoning: { max_tokens: -1 } }, { reasoning: { unknown: true } },
    { reasoning: [] }, { provider: { sort: 'unknown' } }, { provider: 'throughput' },
  ]) assert.equal((await f.request(body)).status, 400);
  assert.equal(f.proxy.snapshot().requests.length, 0);
  assert.equal(f.seen.length, 0);
});

test('generation header agrees with body and is retained with settled cost', async t => {
  const f = await fixture(t, { reply(req, res) {
    res.setHeader('X-Generation-Id', 'gen-header-agrees');
    res.end(JSON.stringify({ id: 'gen-header-agrees', usage: { cost: 0.2 }, choices: [] }));
  } });
  assert.equal((await f.request()).status, 200);
  const entry = f.proxy.snapshot().requests[0];
  assert.equal(entry.headerGenerationId, 'gen-header-agrees');
  assert.equal(entry.generationId, 'gen-header-agrees');
  assert.equal(entry.state, 'settled');
  assert.equal(f.seen.length, 1);
});

test('conflicting generation header and body block reconciliation and preserve reservation', async t => {
  const f = await fixture(t, { reply(req, res) {
    res.setHeader('X-Generation-Id', 'gen-header-conflict');
    res.end(JSON.stringify({ id: 'gen-body-conflict', usage: { cost: 0 }, choices: [] }));
  } });
  await f.request().catch(() => {});
  const snapshot = f.proxy.snapshot(), entry = snapshot.requests[0];
  assert.equal(entry.generationConflict, true);
  assert.equal(snapshot.blocked, true);
  assert.equal(entry.state, 'pending');
  assert.equal(Object.hasOwn(entry, 'actual'), false);
  assert.equal(f.seen.length, 1, 'conflict cannot select either ID for billing lookup');
});

test('out-of-pattern generation header is ignored without fabricating an ID or cost', async t => {
  const f = await fixture(t, { reply(req, res) {
    res.setHeader('X-Generation-Id', 'not-a-generation-id');
    res.end(JSON.stringify({ choices: [] }));
  } });
  assert.equal((await f.request()).status, 200);
  const entry = f.proxy.snapshot().requests[0];
  assert.equal(Object.hasOwn(entry, 'headerGenerationId'), false);
  assert.equal(Object.hasOwn(entry, 'generationId'), false);
  assert.equal(entry.state, 'pending');
  assert.equal(f.seen.length, 1);
});

test('generation header is durable before first body chunk and enables exact lookup after disconnect', async t => {
  let f, headerPersistedBeforeBody = false;
  f = await fixture(t, { reply: async (req, res) => {
    if (req.method === 'GET') return res.end(JSON.stringify({ data: { id: 'gen-header-disconnect', model: 'test/model', total_cost: 0.123, finish_reason: 'stop', generation_time: 100 } }));
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'X-Generation-Id': 'gen-header-disconnect' });
    res.flushHeaders();
    for (let attempt = 0; attempt < 200; attempt++) {
      const ledger = JSON.parse(await fs.readFile(f.config.ledgerFile));
      if (ledger.requests[0]?.generationId === 'gen-header-disconnect') { headerPersistedBeforeBody = true; break; }
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    res.destroy();
  } });
  await f.request({ stream: true }).catch(() => {});
  await f.proxy.flush();
  assert.equal(headerPersistedBeforeBody, true);
  const entry = f.proxy.snapshot().requests[0];
  assert.equal(entry.generationId, 'gen-header-disconnect');
  assert.equal(entry.state, 'settled');
  assert.equal(entry.costSource, 'generation.total_cost');
  assert.equal(entry.actual, '123000000000');
  assert.equal(f.seen[1].url, '/api/v1/generation?id=gen-header-disconnect');
  await f.request({ stream: true }).catch(() => {});
  await f.proxy.flush();
  assert.equal(f.proxy.snapshot().requests.length, 2, 'settled disconnect does not hold the next request');
});

test('unsettled 429 holds queued requests and SDK-style retries before any new reservation or POST', async t => {
  const f = await fixture(t, { model: model({ prompt: '0.0001', completion: '0.001' }), reply(req, res) {
    if (req.method === 'GET') { res.writeHead(404); return res.end('{}'); }
    res.writeHead(429, { 'Content-Type': 'application/json', 'X-Generation-Id': 'gen-hold-throttle' });
    res.end(JSON.stringify({ error: { code: 429, message: 'Fixture shared pool throttled' } }));
  } });
  const first = f.request({ stream: true }), queued = f.request();
  assert.equal((await first).status, 429);
  const held = await queued, retry = await f.request();
  for (const response of [held, retry]) {
    assert.equal(response.status, 402);
    assert.match(response.text, /BUDGET_HOLD_UNSETTLED_REQUEST/);
    assert.ok(response.text.includes(f.proxy.snapshot().requests[0].id));
  }
  assert.equal(f.seen.filter(r => r.url.endsWith('/chat/completions')).length, 1);
  assert.equal(f.seen.filter(r => r.url.includes('/generation?')).length, 1);
  const snapshot = f.proxy.snapshot();
  assert.equal(snapshot.requests.length, 1); assert.equal(snapshot.requests[0].state, 'pending');
  assert.equal(snapshot.requests[0].actual, undefined); assert.equal(snapshot.blocked, false);
  assert.equal(snapshot.capUsd, 10);
});

test('disconnect and malformed JSON without authoritative cost each hold further forwarded requests', async t => {
  for (const reply of [(req, res) => res.destroy(), (req, res) => res.end('{malformed')]) {
    const f = await fixture(t, { reply });
    await f.request().catch(() => {}); await f.proxy.flush();
    const held = await f.request();
    assert.equal(held.status, 402); assert.match(held.text, /BUDGET_HOLD_UNSETTLED_REQUEST/);
    assert.equal(f.proxy.snapshot().requests.length, 1); assert.equal(f.seen.length, 1);
    await f.proxy.stop();
  }
});

test('header-only disconnect with unavailable exact generation lookup retains reservation and holds', async t => {
  let f;
  f = await fixture(t, { reply: async (req, res) => {
    if (req.method === 'GET') { res.writeHead(404); return res.end('{}'); }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'X-Generation-Id': 'gen-hold-disconnect' }); res.flushHeaders();
    for (let i = 0; i < 100; i++) {
      if (f.proxy.snapshot().requests[0]?.generationId) break;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    res.destroy();
  } });
  await f.request({ stream: true }).catch(() => {}); await f.proxy.flush();
  assert.equal((await f.request()).status, 402);
  const snapshot = f.proxy.snapshot();
  assert.equal(snapshot.requests.length, 1); assert.equal(snapshot.requests[0].generationId, 'gen-hold-disconnect');
  assert.equal(snapshot.requests[0].state, 'pending'); assert.equal(snapshot.requests[0].actual, undefined);
  assert.equal(f.seen.filter(r => r.url.endsWith('/chat/completions')).length, 1);
});

test('downstream client disconnect cannot bypass the unsettled hold', async t => {
  let finish;
  const f = await fixture(t, { reply(req, res) {
    if (req.method === 'GET') { res.writeHead(404); return res.end('{}'); }
    finish = () => res.end(JSON.stringify({ id: 'gen-client-disconnect', choices: [] }));
  } });
  const client = http.request(`${f.proxy.url}/chat/completions`, { method: 'POST', headers: {
    Authorization: `Bearer ${f.proxy.token}`, 'Content-Type': 'application/json',
  } });
  client.on('error', () => {});
  client.end(JSON.stringify({ model: 'test/model', messages: [{ role: 'user', content: 'fixture' }] }));
  for (let i = 0; i < 100 && !finish; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(finish); client.destroy(); finish(); await f.proxy.flush();
  const held = await f.request();
  assert.equal(held.status, 402); assert.match(held.text, /BUDGET_HOLD_UNSETTLED_REQUEST/);
  assert.equal(f.proxy.snapshot().requests.length, 1);
  assert.equal(f.seen.filter(r => r.url.endsWith('/chat/completions')).length, 1);
});

test('explicit settlement cannot clear an instance hold, and restart preserves old pending liability', async t => {
  const f = await fixture(t, { reply(req, res) {
    if (req.method === 'GET') { res.writeHead(404); return res.end('{}'); }
    res.end(JSON.stringify({ id: 'gen-sticky-hold', choices: [] }));
  } });
  await f.request();
  const original = f.proxy.snapshot().requests[0];
  assert.equal((await f.request()).status, 402);
  await f.restart();
  assert.equal(f.proxy.snapshot().spentUsd, 4.96);
  assert.deepEqual(f.proxy.snapshot().requests[0], original);
  assert.equal((await f.request()).status, 200);
  assert.equal(f.proxy.snapshot().requests.length, 2);
  assert.equal(f.proxy.snapshot().spentUsd, 9.92);
  f.setReply((req, res) => res.end(JSON.stringify({ data: { id: 'gen-sticky-hold', model: 'test/model', total_cost: 0, finish_reason: 'error', generation_time: 0 } })));
  await f.proxy.reconcilePending();
  assert.equal(f.proxy.snapshot().spentUsd, 0);
  assert.equal((await f.request()).status, 402, 'a latched hold requires an explicit restart even after later reconciliation');
  assert.equal(f.proxy.snapshot().requests.length, 2);
});
