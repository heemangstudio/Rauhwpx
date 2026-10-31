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

test('a revoked license ends polling without retrying', async () => {
  const updates = await poll([json(200, { status: 'revoked' })]);
  assert.deepEqual(updates, [{ state: 'revoked', attempts: 1 }]);
});

test('malformed responses count as consecutive errors, and valid pending resets them', async () => {
  const malformed = json(200, { status: 'issued' });
  const updates = await poll([malformed]);
  assert.equal(updates.at(-1).state, 'error');
  assert.equal(updates.at(-1).attempts, 3);
  const recovered = await poll([
    malformed, malformed, json(200, { status: 'pending' }), malformed, malformed,
    json(200, { status: 'issued', key: 'K' }),
  ]);
  assert.equal(recovered.at(-1).state, 'issued');
  assert.equal(recovered.at(-1).attempts, 6);
});

test('annual keys get the renewal line on the success page; lifetime keys get none', () => {
  assert.equal(P.renewalText(Date.parse('2027-10-20T23:59:59.999+09:00')), '매년 자동으로 갱신돼요. 다음 갱신일은 2027년 10월 20일이에요. 언제든 Groble에서 해지할 수 있어요.');
  assert.equal(P.renewalText(null), '');
  assert.equal(P.renewalText(undefined), '');
  assert.equal(P.renewalText(Date.parse('2026-11-30T23:59:59.999+09:00'), 'monthly'), '매달 자동으로 갱신돼요. 다음 갱신일은 2026년 11월 30일이에요. 언제든 Groble에서 해지할 수 있어요.');
  assert.match(P.renewalText(Date.parse('2027-10-20T23:59:59.999+09:00'), 'annual'), /^매년/);
});

test('the success page passes the key plan from by-ref through to the renewal line', async () => {
  const clock = fakeClock();
  const updates = [];
  P.pollLicense({
    ref: 'r', fetch: () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ status: 'issued', key: 'K', licenseExpiresAt: 1, plan: 'monthly' }) }),
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, now: clock.now, onUpdate: (u) => updates.push(u),
  });
  await new Promise((r) => setImmediate(r));
  assert.equal(updates.at(-1).plan, 'monthly');
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

test('buy buttons check their own consent and product, and tolerate blocked storage', () => {
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
  Object.defineProperty(doc.defaultView, 'localStorage', { get() { throw new Error('blocked'); } });
  location.href = '';
  yearly.buy.listeners.click({ preventDefault() {} });
  assert.match(location.href, /^https:\/\/groble\.im\/payment\/GLJFC9\?ref=/);
});

test('the site sells no retired product and every page names the operator', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const pages = fs.readdirSync(__dirname).filter((f) => f.endsWith('.html'));
  for (const page of pages) {
    const html = fs.readFileSync(path.join(__dirname, page), 'utf8');
    assert.doesNotMatch(html, /평생/, `${page} says 평생`);
    assert.doesNotMatch(html, /9,900원에 구매/, `${page} has a price without 연`);
    assert.doesNotMatch(html, /data-buy-sku="(signature|annual|onetime)"/, `${page} sells a retired product`);
    if (page !== 'tos.html') assert.doesNotMatch(html, /일회성|8Xy27f|₩29,000/, `${page} sells Signature`);
    // 네이버 검수는 자바스크립트 없이 바닥글을 봐요.
    assert.match(html, /운영자 하태욱/, `${page} names the operator`);
    assert.match(html, /010-8512-1201/, `${page} shows the operator phone`);
  }
  // Existing GLJFC9 and Signature keys still renew and validate against these products.
  const { resolveLicenseConfig } = await import('../site-api/config.mjs');
  const byKind = Object.fromEntries(resolveLicenseConfig({}).products.map((product) => [product.kind, product]));
  assert.equal(P.CONFIG.CHECKOUT_URLS.signature, `https://groble.im/payment/${byKind.signature.id}`);
  assert.equal(P.CONFIG.CHECKOUT_URLS.annual, `https://groble.im/payment/${byKind.subscription.id}`);
});

test('pricing page prices come from CONFIG.PRICES, so the no-JS text cannot drift from the config', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const pricing = fs.readFileSync(path.join(__dirname, 'pricing.html'), 'utf8');
  const tagged = [...pricing.matchAll(/data-price="([^"]+)"[^>]*>([^<]*)</g)];
  assert.ok(tagged.length >= 5);
  for (const [, key, text] of tagged) assert.equal(text, P.priceText(key), `data-price="${key}"`);
  assert.equal(P.priceText('proYearlySaving', { proMonthly: 3900, proYearly: 39000 }), '₩7,800');
  assert.equal(P.priceText('proYearlyPerMonth', { proMonthly: 3900, proYearly: 39000 }), '₩3,250');
  assert.equal(P.priceText('hama', { hama: null }), '미정');
  assert.equal(P.priceText('hama', { hama: 12900 }), '₩12,900');
  assert.equal(P.formatWon(1234567), '₩1,234,567');
  // The license server's PRO_UPGRADE_URL points at pricing.html#pro.
  assert.match(pricing, /id="pro"/);
  for (const [, sku] of pricing.matchAll(/data-buy-sku="([^"]+)"/g)) assert.ok(sku in P.CONFIG.CHECKOUT_URLS, sku);
  const hama = pricing.slice(pricing.indexOf('id="hama"'), pricing.indexOf('</article>', pricing.indexOf('id="hama"')));
  assert.doesNotMatch(hama, /data-buy/, 'Hama has no buy button');
  assert.match(pricing, /renderPrices/);
  assert.match(pricing, /bindBuyButtons/);
});

test('a Pro buy button without a Groble link stays a disabled 곧 출시 button and never navigates', () => {
  const urls = P.CONFIG.CHECKOUT_URLS;
  const saved = urls.proMonthly;
  const label = { hidden: true };
  const consent = { checked: true, hidden: true, addEventListener() {}, closest: () => label };
  const card = { querySelector: (sel) => (sel === '[data-consent]' ? consent : null) };
  const make = () => ({
    textContent: '곧 출시', attrs: { 'aria-disabled': 'true' }, listeners: {},
    getAttribute(name) { return name === 'data-buy-sku' ? 'proMonthly' : name === 'data-buy-label' ? 'Groble에서 월간 결제하기' : null; },
    setAttribute(name, value) { this.attrs[name] = value; },
    addEventListener(type, fn) { this.listeners[type] = fn; },
    closest: () => card,
  });
  const location = { href: '' };
  const docWith = (buy) => ({ defaultView: { localStorage: memoryStorage(), location }, querySelectorAll: (sel) => (sel === '[data-buy]' ? [buy] : []) });
  try {
    urls.proMonthly = '';
    const soon = make();
    P.bindBuyButtons(docWith(soon));
    let prevented = false;
    soon.listeners.click({ preventDefault() { prevented = true; } });
    assert.equal(prevented, true);
    assert.equal(location.href, '');
    assert.equal(soon.textContent, '곧 출시');
    assert.equal(soon.attrs['aria-disabled'], 'true');
    assert.equal(label.hidden, true, 'no consent box for a product that is not on sale');

    urls.proMonthly = 'https://groble.im/payment/PRO-M';
    const live = make();
    P.bindBuyButtons(docWith(live));
    assert.equal(live.textContent, 'Groble에서 월간 결제하기');
    assert.equal(live.attrs['aria-disabled'], 'false');
    assert.equal(label.hidden, false);
    live.listeners.click({ preventDefault() {} });
    assert.match(location.href, /^https:\/\/groble\.im\/payment\/PRO-M\?ref=hama-/);
  } finally {
    urls.proMonthly = saved;
  }
});
