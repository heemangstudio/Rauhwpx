import assert from 'node:assert/strict';
import test from 'node:test';

import { PRICING_URL } from '../desktop/license-manager.mjs';
import { createRauClient, RAU_PROMPT_MAX_BYTES, RauServerError } from '../desktop/rau-client.mjs';
import { handleRauRequest, installRauHost } from '../desktop/rau-host.mjs';

const LEASE = 'eyJ2IjoxfQ.c2lnbmF0dXJl';

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

test('learn posts the prompt with the lease as a bearer token and returns the text', async () => {
  const { calls, fetchImpl } = fakeFetch([200, { ok: true, text: '{"ops":[]}', model: 'rau-0.1', usage: { usedUsd: 0.2, capUsd: 3, remainingUsd: 2.8, resetsAt: '2026-11-01T00:00:00Z' } }]);
  const client = createRauClient({ baseUrl: 'https://keys.test/', fetchImpl });
  const result = await client.learn(LEASE, 'prompt');
  assert.deepEqual([result.text, result.model, result.usage.remainingUsd, result.usage.resetsAt], ['{"ops":[]}', 'rau-0.1', 2.8, Date.parse('2026-11-01T00:00:00Z')]);
  assert.equal(calls[0].url, 'https://keys.test/v1/rau/learn');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${LEASE}`);
  assert.equal(calls[0].init.headers['X-Hama-Plan-Names'], 'basic');
  assert.deepEqual(JSON.parse(calls[0].init.body), { prompt: 'prompt' });
});

test('every contract error maps to its code with the details the hub needs', async () => {
  const cases = [
    [401, { ok: false, error: 'unauthorized' }, (e) => e.code === 'unauthorized'],
    [403, { ok: false, error: 'rau_requires_basic', upgradeUrl: 'https://heemangstudios.com/pricing.html#basic' },
      (e) => e.code === 'rau_requires_basic' && e.upgradeUrl === 'https://heemangstudios.com/pricing.html#basic'],
    // 머리글을 모르는 예전 서버의 이름도 같은 거절이다.
    [403, { ok: false, error: 'rau_requires_pro', upgradeUrl: 'https://evil.example/pay' },
      (e) => e.code === 'rau_requires_basic' && e.upgradeUrl === PRICING_URL],
    [402, { ok: false, error: 'rau_cap_reached', capUsd: 3, usedUsd: 3.01, resetsAt: 1_800_000_000_000 },
      (e) => e.code === 'rau_cap_reached' && e.capUsd === 3 && e.usedUsd === 3.01 && e.resetsAt === 1_800_000_000_000],
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

test('the hub gets the result or the error code, never the lease, and nothing is asked without a license', async () => {
  const { calls, fetchImpl } = fakeFetch((url, init) => (JSON.parse(init.body).prompt === 'refuse'
    ? [403, { ok: false, error: 'rau_requires_pro', upgradeUrl: 'https://heemangstudios.com/pricing.html' }]
    : [200, { ok: true, text: 'learned', model: 'rau-0.1' }]));
  const client = createRauClient({ fetchImpl });
  const licensed = { client, currentLease: async () => LEASE };

  const ok = await handleRauRequest(licensed, { type: 'rhwp-rau-request', id: 'r1', operation: 'learn', prompt: 'p' });
  assert.deepEqual(ok, { type: 'rhwp-rau-response', id: 'r1', ok: true, value: { text: 'learned', model: 'rau-0.1' } });
  const refused = await handleRauRequest(licensed, { type: 'rhwp-rau-request', id: 'r2', operation: 'learn', prompt: 'refuse' });
  assert.deepEqual([refused.ok, refused.code, refused.upgradeUrl], [false, 'rau_requires_basic', 'https://heemangstudios.com/pricing.html']);
  for (const response of [ok, refused]) assert.equal(JSON.stringify(response).includes(LEASE), false);

  const before = calls.length;
  const free = await handleRauRequest({ client, currentLease: async () => null }, { type: 'rhwp-rau-request', id: 'r3', operation: 'learn', prompt: 'p' });
  assert.deepEqual([free.ok, free.code], [false, 'no_license']);
  assert.equal(calls.length, before, 'no HTTP call without a lease');
  assert.equal(await handleRauRequest(licensed, { type: 'rhwp-gift-request', id: 'g' }), null);
});

test('Studio asks for eligibility and opens only our upgrade pages, from trusted windows only', async () => {
  const handlers = new Map();
  const opened = [];
  const { calls, fetchImpl } = fakeFetch([200, { ok: true, eligible: false, reason: 'rau_requires_pro', upgradeUrl: 'https://groble.im/basic', capUsd: 3, usedUsd: 0, remainingUsd: 3, resetsAt: null }]);
  let lease = null;
  installRauHost({
    ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
    shell: { openExternal: async (url) => { opened.push(url); } },
    client: createRauClient({ fetchImpl }),
    currentLease: async () => lease,
    isTrustedStudioEvent: (event) => event.trusted === true,
  });
  const trusted = { trusted: true };
  assert.deepEqual(await handlers.get('rau:status')(trusted), { ok: true, eligible: false, reason: 'no_license', upgradeUrl: PRICING_URL });
  assert.equal(calls.length, 0);
  lease = LEASE;
  const status = await handlers.get('rau:status')(trusted);
  assert.deepEqual([status.eligible, status.reason, status.upgradeUrl], [false, 'rau_requires_basic', 'https://groble.im/basic']);
  assert.equal(JSON.stringify(status).includes(LEASE), false);

  await handlers.get('rau:open-upgrade')(trusted, 'file:///etc/passwd');
  await handlers.get('rau:open-upgrade')(trusted, 'https://heemangstudios.com/pricing.html#basic');
  assert.deepEqual(opened, [PRICING_URL, 'https://heemangstudios.com/pricing.html#basic']);
  assert.throws(() => handlers.get('rau:status')({}), /Untrusted Rau IPC sender/);
});
