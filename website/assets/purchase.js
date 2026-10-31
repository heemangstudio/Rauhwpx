/* HamaEditor purchase flow, shared by pricing.html, success.html and download.html.
   Change only CONFIG below to adjust settings. */
(function (root) {
  'use strict';

  var CONFIG = {
    // Product selected by PLAN. 'annual' = GLJFC9 (₩9,900/year, auto-renews every 12 months), 'onetime' = uRshdR (the paused one-time product).
    // This one line selects the default checkout link. Use 'onetime' only to roll back, and then change the site's price copy too.
    // Signature is a separate button. PLAN does not select it.
    PLAN: 'annual',
    // Groble product checkout links. Each buy button appends ?ref=<random value> to its own link.
    // An empty link keeps that buy button disabled as '곧 출시'.
    CHECKOUT_URLS: {
      onetime: 'https://groble.im/payment/uRshdR',
      annual: 'https://groble.im/payment/GLJFC9',
      signature: 'https://groble.im/payment/8Xy27f',
      // PLACEHOLDER: the Groble Basic products don't exist yet. Paste each checkout link here to open sales.
      basicMonthly: '',
      basicYearly: ''
    },
    // Prices in won, VAT included. pricing.html fills every [data-price] from here, and
    // purchase.test.cjs fails when the page's static fallback text drifts from these numbers.
    // null means the price isn't set yet.
    PRICES: {
      basicMonthly: 3900,
      basicYearly: 39000,
      hama: null
    },
    // License server. success.html queries GET {API_BASE}/v1/license/by-ref?ref= .
    API_BASE: 'https://rau-credits-production.up.railway.app',
    // Mac installer. Points at the latest release of the public distribution repo, so it needs no change per version.
    MAC_DMG_URL: 'https://github.com/heemangstudio/hamaeditor-releases/releases/latest/download/HamaEditor-mac-arm64.dmg',
    // Windows installer. Published in the same release as the Mac file.
    WIN_EXE_URL: 'https://github.com/heemangstudio/hamaeditor-releases/releases/latest/download/HamaEditor-win-x64.exe',
    RELEASES_URL: 'https://github.com/heemangstudio/hamaeditor-releases/releases/latest',
    POLL_INTERVAL_MS: 3000,
    POLL_TIMEOUT_MS: 180000,
    MAX_CONSECUTIVE_ERRORS: 5
  };

  CONFIG.GROBLE_CHECKOUT_URL = CONFIG.CHECKOUT_URLS[CONFIG.PLAN] || CONFIG.CHECKOUT_URLS.onetime;

  var REF_RE = /^[A-Za-z0-9\-_.:=~]{1,128}$/;
  var STORAGE_KEY = 'hamaeditor.purchase.ref';

  function randomHex(bytes, cryptoImpl) {
    var c = cryptoImpl || (root && root.crypto);
    var buf = new Uint8Array(bytes);
    if (c && typeof c.getRandomValues === 'function') {
      c.getRandomValues(buf);
    } else {
      for (var i = 0; i < bytes; i++) buf[i] = Math.floor(Math.random() * 256);
    }
    var out = '';
    for (var j = 0; j < buf.length; j++) out += (buf[j] < 16 ? '0' : '') + buf[j].toString(16);
    return out;
  }

  // e.g. hama-1739a2c4-5f0e3b... (only alphanumerics and -, to follow Groble's ref rules)
  function newRef(cryptoImpl) {
    return 'hama-' + Date.now().toString(36) + '-' + randomHex(16, cryptoImpl);
  }

  function isValidRef(ref) {
    return typeof ref === 'string' && REF_RE.test(ref);
  }

  function checkoutUrl(ref, base) {
    if (!isValidRef(ref)) throw new Error('invalid ref');
    var url = base || CONFIG.GROBLE_CHECKOUT_URL;
    return url + (url.indexOf('?') === -1 ? '?' : '&') + 'ref=' + encodeURIComponent(ref);
  }

  function byRefUrl(ref, apiBase) {
    return (apiBase || CONFIG.API_BASE).replace(/\/+$/, '') + '/v1/license/by-ref?ref=' + encodeURIComponent(ref);
  }

  function saveRef(storage, ref) {
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify({ ref: ref, createdAt: Date.now() }));
    } catch (_) { /* Private mode etc.: fall back to the ref in the URL */ }
  }

  function loadRef(storage) {
    try {
      var raw = storage.getItem(STORAGE_KEY);
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      return parsed && isValidRef(parsed.ref) ? parsed.ref : null;
    } catch (_) {
      return null;
    }
  }

  // ref for the checkout-complete page: ?ref= in the URL first, otherwise the value stored in this browser.
  function resolveRef(search, storage) {
    var m = /[?&]ref=([^&#]*)/.exec(search || '');
    if (m) {
      var fromUrl = '';
      try { fromUrl = decodeURIComponent(m[1]); } catch (_) { fromUrl = ''; }
      if (isValidRef(fromUrl)) return fromUrl;
    }
    return storage ? loadRef(storage) : null;
  }

  // Counts downloads. Sends only platform and version, with no cookies or identifiers. Never blocks or delays the download.
  function trackDownload(platform, version, nav, fetchImpl) {
    var n = nav || (root && root.navigator);
    var f = fetchImpl || (root && root.fetch);
    var url = CONFIG.API_BASE.replace(/\/+$/, '') + '/v1/downloads';
    var body = JSON.stringify({ platform: platform, version: version || 'latest' });
    try {
      // text/plain means no preflight even for a different origin.
      if (n && typeof n.sendBeacon === 'function' && n.sendBeacon(url, new Blob([body], { type: 'text/plain;charset=UTF-8' }))) return true;
      if (typeof f === 'function') {
        f(url, { method: 'POST', body: body, keepalive: true, mode: 'no-cors', credentials: 'omit', headers: { 'Content-Type': 'text/plain;charset=UTF-8' } })
          .catch(function () {});
        return true;
      }
    } catch (_) { /* The download proceeds even if counting fails */ }
    return false;
  }

  // In the same tab, the same file is counted once per 10 minutes. Clicking the 'click' link after the automatic download, or refreshing, still counts once.
  var COUNTED_KEY = 'hamaeditor.download.counted.';
  var COUNT_WINDOW_MS = 600000;
  function trackDownloadOnce(platform, storage, now, nav, fetchImpl) {
    var t = typeof now === 'number' ? now : Date.now();
    var last = 0;
    try { last = +(storage && storage.getItem(COUNTED_KEY + platform)) || 0; } catch (_) { last = 0; }
    if (t - last < COUNT_WINDOW_MS) return false;
    try { if (storage) storage.setItem(COUNTED_KEY + platform, String(t)); } catch (_) { /* Count even if storage is blocked */ }
    return trackDownload(platform, 'latest', nav, fetchImpl);
  }

  // Renewal notice for subscription keys. Takes the expiry (epoch ms) the server sets to the end of the day in Korea time,
  // and the key's plan from by-ref ('monthly' for Basic monthly; anything else renews yearly). Keys without a term (null) give an empty string.
  function renewalText(licenseExpiresAt, plan) {
    if (typeof licenseExpiresAt !== 'number' || !isFinite(licenseExpiresAt)) return '';
    var date = new Intl.DateTimeFormat('ko-KR', { dateStyle: 'long', timeZone: 'Asia/Seoul' }).format(new Date(licenseExpiresAt));
    return (plan === 'monthly' ? '매달' : '매년') + ' 자동으로 갱신돼요. 다음 갱신일은 ' + date + '이에요. 언제든 Groble에서 해지할 수 있어요.';
  }

  /* Polls until the key is issued.
     onUpdate({state:'pending'|'issued'|'revoked'|'error'|'timeout', key?, licenseExpiresAt?, plan?, attempts})
     Calling the returned function stops it. */
  function pollLicense(opts) {
    var fetchImpl = opts.fetch;
    var setTimer = opts.setTimeout || setTimeout;
    var clearTimer = opts.clearTimeout || clearTimeout;
    var now = opts.now || Date.now;
    var interval = opts.intervalMs || CONFIG.POLL_INTERVAL_MS;
    var timeout = opts.timeoutMs || CONFIG.POLL_TIMEOUT_MS;
    var maxErrors = opts.maxErrors || CONFIG.MAX_CONSECUTIVE_ERRORS;
    var url = byRefUrl(opts.ref, opts.apiBase);
    var started = now();
    var errors = 0;
    var attempts = 0;
    var stopped = false;
    var timer = null;

    function done(update) { stopped = true; opts.onUpdate(update); }
    function next() {
      if (stopped) return;
      if (now() - started >= timeout) { done({ state: 'timeout', attempts: attempts }); return; }
      timer = setTimer(tick, interval);
    }
    function tick() {
      if (stopped) return;
      attempts++;
      fetchImpl(url, { headers: { Accept: 'application/json' }, cache: 'no-store' })
        .then(function (res) {
          // Treat 404 as the webhook not having arrived yet.
          if (res.status === 404) return { status: 'pending' };
          if (!res.ok) throw new Error('HTTP ' + res.status);
          return res.json();
        })
        .then(function (body) {
          if (stopped) return;
          if (body && body.status === 'issued' && typeof body.key === 'string' && body.key) {
            done({ state: 'issued', key: body.key, licenseExpiresAt: typeof body.licenseExpiresAt === 'number' ? body.licenseExpiresAt : null, plan: typeof body.plan === 'string' ? body.plan : null, attempts: attempts });
            return;
          }
          if (body && body.status === 'revoked') {
            done({ state: 'revoked', attempts: attempts });
            return;
          }
          if (body && body.status === 'pending') {
            errors = 0;
            opts.onUpdate({ state: 'pending', attempts: attempts });
            next();
            return;
          }
          throw new Error('unexpected response');
        })
        .catch(function (err) {
          if (stopped) return;
          errors++;
          if (errors >= maxErrors) { done({ state: 'error', error: String(err && err.message || err), attempts: attempts }); return; }
          opts.onUpdate({ state: 'pending', attempts: attempts, transientError: true });
          next();
        });
    }
    tick();
    return function stop() { stopped = true; if (timer !== null) clearTimer(timer); };
  }

  function formatWon(amount) {
    return '₩' + String(amount).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  // Text for each [data-price] key. Unknown keys give null and leave the element alone.
  function priceText(key, prices) {
    var p = prices || CONFIG.PRICES;
    var monthly = p.basicMonthly, yearly = p.basicYearly;
    switch (key) {
      case 'basicMonthly': return formatWon(monthly);
      case 'basicYearly': return formatWon(yearly);
      case 'basicYearlyPerMonth': return formatWon(Math.round(yearly / 12));
      case 'basicYearlySaving': return formatWon(monthly * 12 - yearly);
      case 'hama': return typeof p.hama === 'number' ? formatWon(p.hama) : '미정';
      default: return null;
    }
  }

  function renderPrices(doc, prices) {
    var scope = doc && typeof doc.querySelectorAll === 'function' ? doc : (root && root.document);
    if (!scope) return;
    Array.prototype.forEach.call(scope.querySelectorAll('[data-price]'), function (el) {
      var text = priceText(el.getAttribute('data-price'), prices);
      if (text !== null) el.textContent = text;
    });
  }

  // Each [data-buy] uses the consent and note inside its own article, then opens that sku's checkout.
  // A sku without a checkout link stays a disabled '곧 출시' button, and its consent box stays hidden.
  function bindBuyButtons(doc) {
    var scope = doc && typeof doc.querySelectorAll === 'function' ? doc : (root && root.document);
    if (!scope || typeof scope.querySelectorAll !== 'function') return;
    var buttons = scope.querySelectorAll('[data-buy]');
    Array.prototype.forEach.call(buttons, function (buy) {
      var article = typeof buy.closest === 'function' ? buy.closest('article') : null;
      var consent = article && article.querySelector('[data-consent]');
      var note = article && article.querySelector('[data-buy-note]');
      if (!consent) return;
      var sku = buy.getAttribute('data-buy-sku');
      if (!CONFIG.CHECKOUT_URLS[sku]) {
        buy.setAttribute('aria-disabled', 'true');
        buy.textContent = '곧 출시';
        buy.addEventListener('click', function (event) {
          if (event && typeof event.preventDefault === 'function') event.preventDefault();
        });
        return;
      }
      var label = buy.getAttribute('data-buy-label');
      if (label) buy.textContent = label;
      consent.hidden = false;
      var consentBox = typeof consent.closest === 'function' ? consent.closest('label') : null;
      if (consentBox) consentBox.hidden = false;
      function sync() {
        buy.setAttribute('aria-disabled', consent.checked ? 'false' : 'true');
      }
      consent.addEventListener('change', sync);
      sync();
      buy.addEventListener('click', function (event) {
        if (event && typeof event.preventDefault === 'function') event.preventDefault();
        if (!consent.checked) {
          if (note) note.textContent = '동의에 체크하면 결제할 수 있어요.';
          if (typeof consent.focus === 'function') consent.focus();
          return;
        }
        var ref = newRef();
        var view = scope.defaultView || root;
        var storage = null;
        try { storage = view && view.localStorage; } catch (_) {}
        if (storage) saveRef(storage, ref);
        if (view && view.location) view.location.href = checkoutUrl(ref, CONFIG.CHECKOUT_URLS[sku]);
      });
    });
  }

  var api = {
    CONFIG: CONFIG,
    REF_RE: REF_RE,
    STORAGE_KEY: STORAGE_KEY,
    newRef: newRef,
    isValidRef: isValidRef,
    checkoutUrl: checkoutUrl,
    byRefUrl: byRefUrl,
    saveRef: saveRef,
    loadRef: loadRef,
    resolveRef: resolveRef,
    renewalText: renewalText,
    formatWon: formatWon,
    priceText: priceText,
    renderPrices: renderPrices,
    trackDownload: trackDownload,
    trackDownloadOnce: trackDownloadOnce,
    pollLicense: pollLicense,
    bindBuyButtons: bindBuyButtons
  };

  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.HamaPurchase = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null));
