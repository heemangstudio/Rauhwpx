// node --test website/purchase.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const webcrypto = require('node:crypto').webcrypto;
const P = require('./assets/purchase.js');

function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) };
}

test('config points at the live Groble product and the default API base', () => {
  assert.equal(P.CONFIG.GROBLE_CHECKOUT_URL, 'https://groble.im/payment/uRshdR');
  assert.equal(P.CONFIG.API_BASE, 'https://rau-credits-production.up.railway.app');
  assert.match(P.CONFIG.MAC_DMG_URL, /arm64\.dmg$/);
  assert.match(P.CONFIG.WIN_EXE_URL, /win-x64\.exe$/);
});

test('refs match the Groble sellerReference rule and are unique', () => {
  const seen = new Set();
  for (let i = 0; i < 500; i++) {
    const ref = P.newRef(webcrypto);
    assert.match(ref, /^[A-Za-z0-9\-_.:=~]{1,128}$/);
    assert.ok(!seen.has(ref));
    seen.add(ref);
  }
  assert.equal(P.isValidRef('a'.repeat(129)), false);
  assert.equal(P.isValidRef('has space'), false);
  assert.equal(P.isValidRef(''), false);
});

test('checkout URL appends ?ref=', () => {
  assert.equal(P.checkoutUrl('hama-abc'), 'https://groble.im/payment/uRshdR?ref=hama-abc');
  assert.equal(P.checkoutUrl('x', 'https://e.test/p?a=1'), 'https://e.test/p?a=1&ref=x');
  assert.throws(() => P.checkoutUrl('bad ref'));
});

test('ref round-trips through storage and the URL wins', () => {
  const s = memoryStorage();
  P.saveRef(s, 'hama-stored');
  assert.equal(P.loadRef(s), 'hama-stored');
  assert.equal(P.resolveRef('', s), 'hama-stored');
  assert.equal(P.resolveRef('?ref=hama-url', s), 'hama-url');
  assert.equal(P.resolveRef('?ref=bad%20ref', s), 'hama-stored');
  assert.equal(P.resolveRef('', memoryStorage()), null);
});

test('by-ref URL is built from API_BASE', () => {
  assert.equal(P.byRefUrl('r1'), 'https://rau-credits-production.up.railway.app/v1/license/by-ref?ref=r1');
  assert.equal(P.byRefUrl('r1', 'https://x.test/'), 'https://x.test/v1/license/by-ref?ref=r1');
});

function fakeClock() {
  let t = 0; const q = [];
  return {
    now: () => t,
    setTimeout: (fn, ms) => { q.push({ at: t + ms, fn }); return q.length; },
    clearTimeout: () => {},
    async run() {
      for (let i = 0; i < 1000 && q.length; i++) {
        q.sort((a, b) => a.at - b.at);
        const job = q.shift(); t = job.at; job.fn();
        await new Promise((r) => setImmediate(r));
      }
    },
  };
}
const json = (status, body) => Promise.resolve({ status, ok: status >= 200 && status < 300, json: () => Promise.resolve(body) });

async function poll(responses, extra = {}) {
  const clock = fakeClock();
  const updates = [];
  let i = 0;
  P.pollLicense({
    ref: 'r', apiBase: 'https://api.test', intervalMs: 1000, timeoutMs: 10000, maxErrors: 3,
    now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    fetch: () => { const r = responses[Math.min(i, responses.length - 1)]; i++; return typeof r === 'function' ? r() : r; },
    onUpdate: (u) => updates.push(u), ...extra,
  });
  await new Promise((r) => setImmediate(r));
  await clock.run();
  return updates;
}

test('pending then issued shows the key', async () => {
  const u = await poll([json(200, { status: 'pending' }), json(404, {}), json(200, { status: 'issued', key: 'HAMA-1234' })]);
  assert.deepEqual(u.map((x) => x.state), ['pending', 'pending', 'issued']);
  assert.equal(u.at(-1).key, 'HAMA-1234');
});

test('stays pending until the timeout', async () => {
  const u = await poll([json(200, { status: 'pending' })]);
  assert.equal(u.at(-1).state, 'timeout');
});

test('repeated errors end in error; a single blip does not', async () => {
  const fail = () => Promise.reject(new Error('offline'));
  const u = await poll([fail, fail, fail]);
  assert.equal(u.at(-1).state, 'error');
  const v = await poll([fail, json(500, {}), json(200, { status: 'issued', key: 'K' })]);
  assert.equal(v.at(-1).state, 'issued');
});
