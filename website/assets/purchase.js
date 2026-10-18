/* HamaEditor 구매 흐름. pricing.html 과 success.html 이 같이 써요.
   설정은 아래 CONFIG 한 곳만 바꾸면 돼요. */
(function (root) {
  'use strict';

  var CONFIG = {
    // 파는 상품. 'annual' = GLJFC9 (연 ₩9,900, 12개월마다 자동 갱신), 'onetime' = uRshdR (예전 한 번 결제, 평생 키).
    // 이 한 줄이 결제 링크와 pricing.html 의 가격 문구를 함께 정해요. 되돌릴 때만 'onetime' 으로 바꿔요.
    PLAN: 'annual',
    // Groble 상품 결제 링크. 구매 버튼이 여기에 ?ref=<무작위 값> 을 붙여 보내요.
    CHECKOUT_URLS: {
      onetime: 'https://groble.im/payment/uRshdR',
      annual: 'https://groble.im/payment/GLJFC9'
    },
    // 라이선스 서버. success.html 이 GET {API_BASE}/v1/license/by-ref?ref= 를 물어봐요.
    API_BASE: 'https://rau-credits-production.up.railway.app',
    // 맥 설치 파일. 공개 배포 저장소의 최신 릴리스를 가리키므로 버전마다 바꿀 필요가 없어요.
    MAC_DMG_URL: 'https://github.com/heemangstudio/hamaeditor-releases/releases/latest/download/HamaEditor-mac-arm64.dmg',
    RELEASES_URL: 'https://github.com/heemangstudio/hamaeditor-releases/releases/latest',
    POLL_INTERVAL_MS: 3000,
    POLL_TIMEOUT_MS: 180000,
    MAX_CONSECUTIVE_ERRORS: 5
  };

  CONFIG.GROBLE_CHECKOUT_URL = CONFIG.CHECKOUT_URLS[CONFIG.PLAN] || CONFIG.CHECKOUT_URLS.onetime;
  // CSS 가 <html data-plan> 으로 상품별 문구를 골라요. 이 파일은 <head> 에서 읽어 첫 화면부터 맞는 문구가 보여요.
  if (root && root.document && root.document.documentElement) {
    root.document.documentElement.setAttribute('data-plan', CONFIG.PLAN);
  }

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

  // 내려받기를 셉니다. 플랫폼과 버전만 보내고 쿠키·식별값은 없어요. 내려받기를 막거나 늦추지 않아요.
  function trackDownload(platform, version, nav, fetchImpl) {
    var n = nav || (root && root.navigator);
    var f = fetchImpl || (root && root.fetch);
    var url = CONFIG.API_BASE.replace(/\/+$/, '') + '/v1/downloads';
    var body = JSON.stringify({ platform: platform, version: version || 'latest' });
    try {
      // text/plain 이라 다른 origin 이어도 preflight 가 없어요.
      if (n && typeof n.sendBeacon === 'function' && n.sendBeacon(url, new Blob([body], { type: 'text/plain;charset=UTF-8' }))) return true;
      if (typeof f === 'function') {
        f(url, { method: 'POST', body: body, keepalive: true, mode: 'no-cors', credentials: 'omit', headers: { 'Content-Type': 'text/plain;charset=UTF-8' } })
          .catch(function () {});
        return true;
      }
    } catch (_) { /* 세지 못해도 내려받기는 그대로 가요 */ }
    return false;
  }

  // 연간 키의 갱신 안내. 서버가 한국 시간 하루 끝까지로 정한 만료(epoch ms)를 받아요. 평생 키(null)는 빈 문자열.
  function renewalText(licenseExpiresAt) {
    if (typeof licenseExpiresAt !== 'number' || !isFinite(licenseExpiresAt)) return '';
    var date = new Intl.DateTimeFormat('ko-KR', { dateStyle: 'long', timeZone: 'Asia/Seoul' }).format(new Date(licenseExpiresAt));
    return '매년 자동으로 갱신돼요. 다음 갱신일은 ' + date + '이에요. 언제든 Groble에서 해지할 수 있어요.';
  }

  /* 키가 나올 때까지 물어봐요.
     onUpdate({state:'pending'|'issued'|'error'|'timeout', key?, licenseExpiresAt?, attempts})
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
            done({ state: 'issued', key: body.key, licenseExpiresAt: typeof body.licenseExpiresAt === 'number' ? body.licenseExpiresAt : null, attempts: attempts });
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
    renewalText: renewalText,
    trackDownload: trackDownload,
    pollLicense: pollLicense
  };

  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.HamaPurchase = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null));
