/* HamaEditor 구매 흐름. pricing.html 과 success.html 이 같이 써요.
   설정은 아래 CONFIG 한 곳만 바꾸면 돼요. */
(function (root) {
  'use strict';

  var CONFIG = {
    // Groble 상품 결제 링크. 구매 버튼이 여기에 ?ref=<무작위 값> 을 붙여 보내요.
    GROBLE_CHECKOUT_URL: 'https://groble.im/payment/uRshdR',
    // 라이선스 서버. success.html 이 GET {API_BASE}/v1/license/by-ref?ref= 를 물어봐요.
    API_BASE: 'https://rau-credits-production.up.railway.app',
    // 맥 설치 파일. 유료 빌드를 낼 때마다 버전을 바꿔 주세요. index/pricing/success 의 data-dmg 링크가 모두 이 값을 써요.
    MAC_DMG_URL: 'https://github.com/heemangstudio/Rauhwpx/releases/download/v3.0.0/HamaEditor-3.0.0-arm64.dmg',
    RELEASES_URL: 'https://github.com/heemangstudio/Rauhwpx/releases/latest',
    POLL_INTERVAL_MS: 3000,
    POLL_TIMEOUT_MS: 180000,
    MAX_CONSECUTIVE_ERRORS: 5
  };

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

  // 예: hama-1739a2c4-5f0e3b... (영숫자와 - 만 써서 Groble ref 규칙을 지켜요)
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
    } catch (_) { /* 시크릿 모드 등: 주소의 ref 로 대신해요 */ }
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

  // 결제 완료 페이지에서 쓸 ref: 주소의 ?ref= 가 먼저, 없으면 이 브라우저에 저장한 값.
  function resolveRef(search, storage) {
    var m = /[?&]ref=([^&#]*)/.exec(search || '');
    if (m) {
      var fromUrl = '';
      try { fromUrl = decodeURIComponent(m[1]); } catch (_) { fromUrl = ''; }
      if (isValidRef(fromUrl)) return fromUrl;
    }
    return storage ? loadRef(storage) : null;
  }

  /* 키가 나올 때까지 물어봐요.
     onUpdate({state:'pending'|'issued'|'error'|'timeout', key?, attempts})
     반환한 함수를 부르면 멈춰요. */
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
          // 404 는 웹훅이 아직 안 온 것으로 봐요.
          if (res.status === 404) return { status: 'pending' };
          if (!res.ok) throw new Error('HTTP ' + res.status);
          return res.json();
        })
        .then(function (body) {
          if (stopped) return;
          errors = 0;
          if (body && body.status === 'issued' && typeof body.key === 'string' && body.key) {
            done({ state: 'issued', key: body.key, attempts: attempts });
            return;
          }
          if (body && body.status === 'pending') {
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
    pollLicense: pollLicense
  };

  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.HamaPurchase = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null));
