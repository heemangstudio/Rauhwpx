import assert from 'node:assert/strict';
import test from 'node:test';

import { createRauClient, RAU_PROMPT_MAX_BYTES, RAU_UPGRADE_URL, RauServerError } from '../desktop/rau-client.mjs';
import { handleRauRequest, installRauHost } from '../desktop/rau-host.mjs';

const LEASE = 'eyJ2IjoyfQ.c2lnbmF0dXJl';
const RESETS_AT = '2026-11-01T00:00:00.000Z';

/** 요청을 적고 정해 둔 답을 돌려주는 fetch. */
function fakeFetch(answer) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const [status, body] = typeof answer === 'function' ? answer(url, init) : answer;
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  };
  return { calls, fetchImpl };
}

test('learn posts the prompt with the lease as a bearer token and returns the text and credits', async () => {
  const { calls, fetchImpl } = fakeFetch([200, { ok: true, text: '{"ops":[]}', model: 'rau-0.1', usage: { allowanceUsd: 8, usedUsd: 0.2, remainingUsd: 7.8, resetsAt: RESETS_AT } }]);
  const client = createRauClient({ baseUrl: 'https://keys.test/', fetchImpl });
  const result = await client.learn(LEASE, 'prompt');
  assert.deepEqual([result.text, result.model, result.usage], ['{"ops":[]}', 'rau-0.1', { allowanceUsd: 8, usedUsd: 0.2, remainingUsd: 7.8, resetsAt: Date.parse(RESETS_AT) }]);
  assert.equal(calls[0].url, 'https://keys.test/v1/rau/learn');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${LEASE}`);
  assert.equal(Object.keys(calls[0].init.headers).some((name) => /plan-names/i.test(name)), false);
  assert.deepEqual(JSON.parse(calls[0].init.body), { prompt: 'prompt' });
});

test('every contract error maps to its code with the details the hub needs', async () => {
  const cases = [
    [401, { ok: false, error: 'unauthorized' }, (e) => e.code === 'unauthorized'],
    [403, { ok: false, error: 'rau_plan_required', upgradeUrl: 'https://heemangstudios.com/pricing.html#rau' },
      (e) => e.code === 'rau_plan_required' && e.upgradeUrl === 'https://heemangstudios.com/pricing.html#rau'],
    [403, { ok: false, error: 'rau_plan_required', upgradeUrl: 'https://evil.example/pay' },
      (e) => e.code === 'rau_plan_required' && e.upgradeUrl === RAU_UPGRADE_URL],
    // 예전 서버의 이름은 더 받지 않는다.
    [403, { ok: false, error: 'rau_requires_basic' }, (e) => e.code === 'server'],
    [402, { ok: false, error: 'rau_credits_exhausted', allowanceUsd: 8, usedUsd: 8.01, resetsAt: RESETS_AT },
      (e) => e.code === 'rau_credits_exhausted' && e.allowanceUsd === 8 && e.usedUsd === 8.01 && e.resetsAt === Date.parse(RESETS_AT)],
    [429, { ok: false, error: 'rate_limited' }, (e) => e.code === 'rate_limited'],
    [502, { ok: false, error: 'upstream_unavailable' }, (e) => e.code === 'upstream_unavailable'],
    [503, { ok: false, error: 'rau_not_configured' }, (e) => e.code === 'rau_not_configured'],
    [500, { ok: false, error: 'something_else' }, (e) => e.code === 'server'],
    [200, { ok: true }, (e) => e.code === 'server'],
  ];
  for (const [status, body, check] of cases) {
    const client = createRauClient({ fetchImpl: fakeFetch([status, body]).fetchImpl });
    await assert.rejects(client.learn(LEASE, 'p'), (error) => error instanceof RauServerError && check(error), `${status} ${body.error}`);
  }
  const offline = createRauClient({ fetchImpl: async () => { throw new Error('offline'); } });
  await assert.rejects(offline.learn(LEASE, 'p'), (error) => error.code === 'network');
});

test('an oversized prompt or a missing lease never reaches the server', async () => {
  const { calls, fetchImpl } = fakeFetch([200, { ok: true, text: '' }]);
  const client = createRauClient({ fetchImpl });
  await assert.rejects(client.learn(LEASE, 'x'.repeat(RAU_PROMPT_MAX_BYTES + 1)), (error) => error.code === 'too_large');
  await assert.rejects(client.learn('', 'p'), (error) => error.code === 'unauthorized');
  assert.equal(calls.length, 0);
});

test('the hub gets the result or the error code, never the lease, and nothing is asked without a hosted lease', async () => {
  const { calls, fetchImpl } = fakeFetch((url, init) => (JSON.parse(init.body).prompt === 'refuse'
    ? [403, { ok: false, error: 'rau_plan_required', upgradeUrl: 'https://heemangstudios.com/pricing.html#rau' }]
    : JSON.parse(init.body).prompt === 'spent'
      ? [402, { ok: false, error: 'rau_credits_exhausted', allowanceUsd: 2, usedUsd: 2, resetsAt: RESETS_AT }]
      : [200, { ok: true, text: 'learned', model: 'rau-0.1' }]));
  const client = createRauClient({ fetchImpl });
  const licensed = { client, currentLease: async () => LEASE };

  const ok = await handleRauRequest(licensed, { type: 'rhwp-rau-request', id: 'r1', operation: 'learn', prompt: 'p' });
  assert.deepEqual(ok, { type: 'rhwp-rau-response', id: 'r1', ok: true, value: { text: 'learned', model: 'rau-0.1' } });
  const refused = await handleRauRequest(licensed, { type: 'rhwp-rau-request', id: 'r2', operation: 'learn', prompt: 'refuse' });
  assert.deepEqual([refused.ok, refused.code, refused.upgradeUrl], [false, 'rau_plan_required', 'https://heemangstudios.com/pricing.html#rau']);
  const spent = await handleRauRequest(licensed, { type: 'rhwp-rau-request', id: 'r3', operation: 'learn', prompt: 'spent' });
  assert.deepEqual([spent.ok, spent.code, spent.allowanceUsd, spent.resetsAt], [false, 'rau_credits_exhausted', 2, Date.parse(RESETS_AT)]);
  for (const response of [ok, refused, spent]) assert.equal(JSON.stringify(response).includes(LEASE), false);

  const before = calls.length;
  const free = await handleRauRequest({ client, currentLease: async () => null }, { type: 'rhwp-rau-request', id: 'r4', operation: 'learn', prompt: 'p' });
  assert.deepEqual([free.ok, free.code], [false, 'no_license']);
  assert.equal(calls.length, before, 'no HTTP call without a lease');
  assert.equal(await handleRauRequest(licensed, { type: 'rhwp-gift-request', id: 'g' }), null);
});

test('Studio gets eligibility and credits without the agent route, and opens only our upgrade pages', async () => {
  const handlers = new Map();
  const opened = [];
  const answers = [
    [200, { ok: true, eligible: false, source: null, reason: 'rau_plan_required', upgradeUrl: 'https://groble.im/rau', allowanceUsd: null, usedUsd: null, remainingUsd: null, resetsAt: null, agent: { baseUrl: '/v1/rau/agent', model: 'rau' } }],
    [200, { ok: true, eligible: true, source: 'trial', reason: null, upgradeUrl: RAU_UPGRADE_URL, allowanceUsd: 2, usedUsd: 0.5, remainingUsd: 1.5, resetsAt: RESETS_AT, agent: { baseUrl: '/v1/rau/agent', model: 'rau', contextWindow: 200000, maxOutputTokens: 16000 } }],
    [403, { ok: false, error: 'rau_plan_required', upgradeUrl: 'https://heemangstudios.com/pricing.html#rau' }],
  ];
  const { calls, fetchImpl } = fakeFetch(() => answers.shift());
  let lease = null;
  installRauHost({
    ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
    shell: { openExternal: async (url) => { opened.push(url); } },
    client: createRauClient({ fetchImpl }),
    currentLease: async () => lease,
    isTrustedStudioEvent: (event) => event.trusted === true,
  });
  const trusted = { trusted: true };
  const noUsage = { allowanceUsd: null, usedUsd: null, remainingUsd: null, resetsAt: null };
  assert.deepEqual(await handlers.get('rau:status')(trusted), { ok: true, eligible: false, source: null, reason: 'no_license', upgradeUrl: RAU_UPGRADE_URL, ...noUsage });
  assert.equal(calls.length, 0);
  lease = LEASE;
  assert.deepEqual(await handlers.get('rau:status')(trusted), { ok: true, eligible: false, source: null, reason: 'rau_plan_required', upgradeUrl: 'https://groble.im/rau', ...noUsage });
  const trial = await handlers.get('rau:status')(trusted);
  assert.deepEqual(trial, { ok: true, eligible: true, source: 'trial', reason: null, upgradeUrl: RAU_UPGRADE_URL, allowanceUsd: 2, usedUsd: 0.5, remainingUsd: 1.5, resetsAt: Date.parse(RESETS_AT) });
  assert.equal((await handlers.get('rau:status')(trusted)).reason, 'rau_plan_required');
  assert.equal(JSON.stringify(trial).includes(LEASE), false);

  await handlers.get('rau:open-upgrade')(trusted, 'file:///etc/passwd');
  await handlers.get('rau:open-upgrade')(trusted, 'https://heemangstudios.com/pricing.html#rau');
  assert.deepEqual(opened, [RAU_UPGRADE_URL, 'https://heemangstudios.com/pricing.html#rau']);
  assert.throws(() => handlers.get('rau:status')({}), /Untrusted Rau IPC sender/);
});
