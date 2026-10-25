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
  assert.equal(P.CONFIG.PLAN, 'annual', 'the yearly subscription is on sale');
  assert.equal(P.CONFIG.GROBLE_CHECKOUT_URL, 'https://groble.im/payment/GLJFC9');
  assert.equal(P.CONFIG.CHECKOUT_URLS.onetime, 'https://groble.im/payment/uRshdR');
  assert.equal(P.CONFIG.CHECKOUT_URLS.signature, 'https://groble.im/payment/8Xy27f');
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
  assert.equal(P.checkoutUrl('hama-abc'), 'https://groble.im/payment/GLJFC9?ref=hama-abc');
  assert.equal(P.checkoutUrl('hama-sig', P.CONFIG.CHECKOUT_URLS.signature), 'https://groble.im/payment/8Xy27f?ref=hama-sig');
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
  assert.equal(u.at(-1).licenseExpiresAt, null);
  const annual = await poll([json(200, { status: 'issued', key: 'HAMA-1234', licenseExpiresAt: 1823957999999 })]);
  assert.equal(annual.at(-1).licenseExpiresAt, 1823957999999);
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

test('annual keys get the renewal line on the success page; lifetime keys get none', () => {
  assert.equal(P.renewalText(Date.parse('2027-10-20T23:59:59.999+09:00')), '매년 자동으로 갱신돼요. 다음 갱신일은 2027년 10월 20일이에요. 언제든 Groble에서 해지할 수 있어요.');
  assert.equal(P.renewalText(null), '');
  assert.equal(P.renewalText(undefined), '');
});

test('download tracking sends platform and version by sendBeacon, falls back to keepalive fetch, never throws', () => {
  const beacons = [];
  const nav = { sendBeacon: (url, blob) => { beacons.push({ url, type: blob.type }); return true; } };
  assert.equal(P.trackDownload('mac-arm64', 'latest', nav), true);
  assert.deepEqual(beacons, [{ url: 'https://rau-credits-production.up.railway.app/v1/downloads', type: 'text/plain;charset=utf-8' }]);
  const fetches = [];
  const fetchImpl = (url, init) => { fetches.push({ url, init }); return Promise.resolve(); };
  assert.equal(P.trackDownload('mac-arm64', 'latest', { sendBeacon: () => false }, fetchImpl), true);
  assert.equal(fetches[0].init.keepalive, true);
  assert.equal(fetches[0].init.credentials, 'omit');
  assert.deepEqual(JSON.parse(fetches[0].init.body), { platform: 'mac-arm64', version: 'latest' });
  assert.equal(P.trackDownload('mac-arm64', 'latest', { sendBeacon() { throw new Error('blocked'); } }, () => { throw new Error('x'); }), false);
});

test('switching PLAN back to onetime checks out on uRshdR; an unknown plan falls back to it too', () => {
  const fs = require('node:fs');
  const vm = require('node:vm');
  const source = fs.readFileSync(require.resolve('./assets/purchase.js'), 'utf8');
  const load = (plan) => {
    const sandbox = {};
    vm.runInNewContext(source.replace("PLAN: 'annual'", `PLAN: '${plan}'`), { window: sandbox });
    return sandbox.HamaPurchase.CONFIG.GROBLE_CHECKOUT_URL;
  };
  assert.equal(load('annual'), 'https://groble.im/payment/GLJFC9');
  assert.equal(load('onetime'), 'https://groble.im/payment/uRshdR');
  assert.equal(load('typo'), 'https://groble.im/payment/uRshdR');
});

test('the download page counts each file once per tab, so the fallback link after the automatic download is not counted again', () => {
  const sent = [];
  const nav = { sendBeacon: (url, blob) => { sent.push(blob); return true; } };
  const storage = memoryStorage();
  const t = Date.parse('2026-10-20T10:00:00Z');
  assert.equal(P.trackDownloadOnce('mac-arm64', storage, t, nav), true, 'automatic download');
  assert.equal(P.trackDownloadOnce('mac-arm64', storage, t + 5000, nav), false, 'manual fallback click');
  assert.equal(P.trackDownloadOnce('win-x64', storage, t + 6000, nav), true, 'the other OS is its own download');
  assert.equal(P.trackDownloadOnce('mac-arm64', storage, t + 11 * 60 * 1000, nav), true, 'a later visit counts again');
  assert.equal(sent.length, 3);
  const blocked = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
  assert.equal(P.trackDownloadOnce('mac-arm64', blocked, t, nav), true, 'blocked storage still counts');
});

test('each buy button checks out its own product after that card agrees', () => {
  function article(sku) {
    const consent = {
      checked: false,
      listeners: {},
      addEventListener(type, fn) { this.listeners[type] = fn; },
      focus() { this.focused = true; },
    };
    const note = { textContent: '' };
    const buy = {
      sku,
      attrs: { 'aria-disabled': 'true' },
      listeners: {},
      getAttribute(name) { return name === 'data-buy-sku' ? sku : null; },
      setAttribute(name, value) { this.attrs[name] = value; },
      addEventListener(type, fn) { this.listeners[type] = fn; },
      closest() { return card; },
    };
    const card = {
      querySelector(sel) {
        if (sel === '[data-consent]') return consent;
        if (sel === '[data-buy-note]') return note;
        return null;
      },
    };
    return { buy, consent, note };
  }
  const yearly = article('annual');
  const signature = article('signature');
  const unknown = article('mystery');
  const storage = memoryStorage();
  const location = { href: '' };
  const doc = {
    defaultView: { localStorage: storage, location },
    querySelectorAll(sel) {
      return sel === '[data-buy]' ? [yearly.buy, signature.buy, unknown.buy] : [];
    },
  };
  P.bindBuyButtons(doc);
  signature.buy.listeners.click({ preventDefault() {} });
  assert.equal(signature.note.textContent, '동의에 체크하면 결제할 수 있어요.');
  assert.equal(location.href, '');
  assert.equal(signature.consent.focused, true);
  yearly.consent.checked = true;
  signature.buy.listeners.click({ preventDefault() {} });
  assert.equal(location.href, '', 'the other card consent does not unlock this one');
  signature.consent.checked = true;
  signature.buy.listeners.click({ preventDefault() {} });
  assert.match(location.href, /^https:\/\/groble\.im\/payment\/8Xy27f\?ref=/);
  yearly.buy.listeners.click({ preventDefault() {} });
  assert.match(location.href, /^https:\/\/groble\.im\/payment\/GLJFC9\?ref=/);
  unknown.consent.checked = true;
  unknown.buy.listeners.click({ preventDefault() {} });
  assert.match(location.href, /^https:\/\/groble\.im\/payment\/GLJFC9\?ref=/);
  assert.doesNotMatch(location.href, /uRshdR/);
});

test('yearly stays on sale, and only the pricing page sells Signature', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const pages = fs.readdirSync(__dirname).filter((f) => f.endsWith('.html'));
  for (const page of pages) {
    const html = fs.readFileSync(path.join(__dirname, page), 'utf8');
    assert.doesNotMatch(html, /평생/, `${page} says 평생`);
    assert.doesNotMatch(html, /9,900원에 구매/, `${page} has a price without 연`);
    if (page !== 'pricing.html') {
      assert.doesNotMatch(html, /일회성|8Xy27f|₩29,000/, `${page} sells Signature`);
    }
    // 네이버 검수는 자바스크립트 없이 바닥글을 봐요.
    assert.match(html, /운영자 하태욱/, `${page} names the operator`);
    assert.match(html, /010-8512-1201/, `${page} shows the operator phone`);
  }
  const pricing = fs.readFileSync(path.join(__dirname, 'pricing.html'), 'utf8');
  const { resolveLicenseConfig } = await import('../site-api/config.mjs');
  const byKind = Object.fromEntries(resolveLicenseConfig({}).products.map((product) => [product.kind, product]));
  assert.equal(P.CONFIG.CHECKOUT_URLS.signature, `https://groble.im/payment/${byKind.signature.id}`);
  assert.equal(P.CONFIG.CHECKOUT_URLS.annual, `https://groble.im/payment/${byKind.subscription.id}`);
  assert.equal(byKind.signature.id, '8Xy27f');
  assert.equal(byKind.subscription.id, 'GLJFC9');
  assert.equal(byKind.signature.expectedPrice, 29000);
  assert.equal(byKind.subscription.expectedPrice, 9900);
  assert.match(pricing, /₩29,000/);
  assert.match(pricing, /연 ₩9,900/);
  assert.match(pricing, /자동 갱신, 언제든 해지/);
  assert.match(pricing, /data-buy-sku="signature"/);
  assert.match(pricing, /data-buy-sku="annual"/);
  assert.match(pricing, /Groble에서 연 ₩9,900 결제하기/);
  assert.match(pricing, /Groble에서 Signature 결제하기/);
  assert.match(pricing, /일회성/);
  assert.match(pricing, /최소 3년/);
  assert.match(pricing, /기기 두 대/);
  assert.match(pricing, /Mac, Windows/);
  assert.match(pricing, /href="trial\.html"/);
  assert.match(pricing, /체험판 안내/);
  assert.doesNotMatch(pricing, /무료 체험/);
  assert.doesNotMatch(pricing, /buy-pair|card--navy|perch|buy__badge/);
  assert.match(pricing, /bindBuyButtons/);
});
