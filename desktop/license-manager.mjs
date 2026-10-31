// 라이선스 상태. 메인 프로세스가 하나 만들어 설정 화면과 Pro 기능(호스팅 Rau 등)에 상태를 준다.
//
// 규칙
// - 편집기는 무료다. 키가 없거나, 해지·만료·확인 기한 지남·재활성화 필요여도 문서를 열고 편집하고 저장한다.
//   이런 상태는 설정과 활성화 창에 문제로만 보인다.
// - Pro 기능은 서명한 lease 로만 연다(paid). 키를 활성화하면 서버가 이 기기용 lease(7일, 베타 키는 3일)를 준다.
//   실행할 때와 24시간마다 다시 확인해 lease 를 늘린다. 인터넷이 없으면 가진 lease 가 끝날 때까지 그대로 쓴다.
// - 서버 응답의 edition('pro' | 'hama')·plan('monthly' | 'annual' | 'lifetime')·rau.eligible 은 표시와 안내에만 쓴다.
//   예전 서버는 보내지 않으므로 없으면 null 이다.
// - 환불이나 베타 종료로 키가 해지되면(revoked) Pro 기능이 닫힌다.
// - 구독 키는 서명한 lease 에 키의 만료 시각(licenseExpiresAt)이 들어 있다. 만료가 지나면 expired 다.
//   서버가 만료라고 답하면 바로, 서버에 닿지 못하면 만료 뒤 최대 7일(SUBSCRIPTION_OFFLINE_GRACE_MS, 가진 lease 가
//   끝나면 그 전)까지 Pro 를 쓴다. 서버에서 갱신되면 다음 확인에서 새 만료와 함께 다시 열린다. 만료 뒤에는 1시간마다 다시 확인한다.
// - 갱신 결제가 실패하면 lease 에 결제 유예 끝(paymentGraceEndsAt)이 들어온다. 그때까지는 만료가 지나도
//   Pro 를 그대로 쓰고(payment_failed), 상태에 Groble 결제 수단 페이지(paymentFixUrl)를 함께 준다.
// - 키 종류(tier: paid | beta)는 서버 응답에서 받아 표시에만 쓴다. 예전 상태 파일에 없으면 paid 다.
// - 시계를 되돌려 lease 를 늘리지 못하게 본 적 있는 가장 늦은 시각(maxSeenAt)을 쓴다.
// - 예전 상태 파일의 체험 기록(trial)은 읽지 않는다.
//
// 상태 파일은 userData/license.json. 라이선스 키는 비밀 저장소(secret-vault)에 두지 않는다.
// 비밀 저장소의 "AI 제공자 초기화"가 키까지 지우고, 실행할 때마다 키체인 확인을 부르기 때문이다.
// 키 자체는 lease 없이는 쓸모가 없고, lease 는 서명이 있어 고쳐 쓸 수 없다.
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  PRODUCTION_LICENSE_PUBLIC_KEYS,
  maskLicenseKey,
  normalizeLicenseKey,
  verifyLease,
} from './license-lease.mjs';
import { LicenseServerError } from './license-client.mjs';

export const LICENSE_STATE_FILE = 'license.json';
export const LICENSE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** 연간 키의 만료가 지났는데 서버에 닿지 못할 때 더 쓸 수 있는 기간. */
export const SUBSCRIPTION_OFFLINE_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
/** 만료가 지난 연간 키를 서버에 다시 확인하는 간격. 갱신 결제가 늦게 들어와도 이 안에 풀린다. */
export const EXPIRED_RECHECK_MS = 60 * 60 * 1000;
/** 잠자기에서 깬 뒤 등 24시간이 지났는지 이 간격으로 본다. */
const SCHEDULE_TICK_MS = 60 * 1000;
/** 매분 확인에서 시계 기록(maxSeenAt)만 바뀌었으면 이 간격으로만 상태 파일에 쓴다. */
const MAX_SEEN_PERSIST_MS = 60 * 60 * 1000;
/** 서버가 이 기기에 lease 를 주지 않겠다고 답한 코드. 해지(revoked)는 revokedAt 으로 따로 본다. */
const SERVER_LEASELESS_CODES = new Set(['invalid_key', 'not_activated', 'device_limit']);
export const PRICING_URL = 'https://heemangstudios.com/pricing.html';
/** 결제가 실패한 구매자가 결제 수단을 바꾸는 Groble 주문조회. 서버가 paymentFixUrl 로 다른 주소를 주면 그것을 쓴다. */
export const DEFAULT_PAYMENT_FIX_URL = 'https://groble.im/manage/purchase';
/** 사용자가 스스로 풀 수 없는 라이선스 문제의 문의처. 활성화 창과 설정이 메일 앱으로 연다. */
export const SUPPORT_EMAIL = 'management@heemangstudios.com';
export const SUPPORT_MAILTO = `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent('HamaEditor 라이선스 문의')}`;

/** 서버가 준 주소는 groble.im 의 https 페이지일 때만 쓴다. */
export function paymentFixUrlFrom(value) {
  return typeof value === 'string' && /^https:\/\/(?:www\.)?groble\.im\/[^\s]*$/.test(value) ? value : DEFAULT_PAYMENT_FIX_URL;
}
const DEVICE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const BETA_REVOKED_MESSAGE = '베타 테스트 기간이 끝나 키가 해지되었어요.';

const ERROR_MESSAGES = {
  invalid_key: `라이선스 키를 찾을 수 없어요. 키를 다시 확인하고, 결제한 키가 맞다면 ${SUPPORT_EMAIL}으로 문의해 주세요.`,
  revoked: `해지된 라이선스 키예요. 환불된 주문의 키는 쓸 수 없어요. 환불하지 않았다면 ${SUPPORT_EMAIL}으로 문의해 주세요.`,
  expired: '기간이 끝난 라이선스 키예요. 구독을 갱신하면 다시 쓸 수 있어요.',
  device_limit: `이 키를 쓸 수 있는 기기 수를 모두 채웠어요. 다른 기기의 설정에서 ‘이 기기 비활성화’를 누른 뒤 다시 시도해 주세요. 그 기기를 쓸 수 없다면 ${SUPPORT_EMAIL}으로 문의해 주세요.`,
  not_activated: '이 기기에서는 아직 활성화되지 않은 키예요. 키를 다시 넣어 주세요.',
  network: '라이선스 서버에 연결하지 못했어요. 인터넷 연결을 확인해 주세요.',
  server: '라이선스 서버가 잠시 응답하지 않아요. 조금 뒤 다시 시도해 주세요.',
  bad_lease: '라이선스 서버의 응답을 확인하지 못했어요. 앱을 최신 버전으로 업데이트해 주세요.',
  invalid_format: '라이선스 키 형식이 아니에요. 결제 완료 페이지의 키를 그대로 붙여 넣어 주세요.',
};

export function licenseErrorMessage(code, tier = 'paid') {
  if (code === 'revoked' && tier === 'beta') return BETA_REVOKED_MESSAGE;
  return ERROR_MESSAGES[code] ?? ERROR_MESSAGES.server;
}

function emptyState() {
  return { v: 1, deviceId: randomUUID(), maxSeenAt: 0, license: null };
}

function sanitizeState(raw) {
  const base = emptyState();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.v !== 1) return base;
  const state = { ...base };
  if (typeof raw.deviceId === 'string' && DEVICE_ID_RE.test(raw.deviceId)) state.deviceId = raw.deviceId;
  if (Number.isSafeInteger(raw.maxSeenAt) && raw.maxSeenAt > 0) state.maxSeenAt = raw.maxSeenAt;
  const key = normalizeLicenseKey(raw.license?.key);
  if (key) {
    state.license = {
      key,
      keyId: typeof raw.license.keyId === 'string' ? raw.license.keyId : undefined,
      tier: raw.license.tier === 'beta' ? 'beta' : 'paid',
      lease: typeof raw.license.lease === 'string' ? raw.license.lease : null,
      lastCheckAt: Number.isSafeInteger(raw.license.lastCheckAt) ? raw.license.lastCheckAt : 0,
      revokedAt: Number.isSafeInteger(raw.license.revokedAt) ? raw.license.revokedAt : null,
      lastErrorCode: typeof raw.license.lastErrorCode === 'string' ? raw.license.lastErrorCode : null,
      licenseExpiresAt: Number.isSafeInteger(raw.license.licenseExpiresAt) ? raw.license.licenseExpiresAt : null,
      autoRenew: typeof raw.license.autoRenew === 'boolean' ? raw.license.autoRenew : null,
      expiredAt: Number.isSafeInteger(raw.license.expiredAt) ? raw.license.expiredAt : null,
      paymentFixUrl: paymentFixUrlFrom(raw.license.paymentFixUrl),
      ...editionFrom(raw.license),
    };
  }
  return state;
}

const PLANS = new Set(['monthly', 'annual', 'lifetime']);

/** 클라이언트가 읽은 서버 응답(또는 상태 파일)의 Pro·Hama 표시 값. 없거나 모르는 값은 null. */
function editionFrom(value) {
  return {
    edition: value?.edition === 'pro' || value?.edition === 'hama' ? value.edition : null,
    plan: PLANS.has(value?.plan) ? value.plan : null,
    rauEligible: typeof value?.rauEligible === 'boolean' ? value.rauEligible : null,
  };
}

export function licenseStatePath(userDataDir) {
  return join(String(userDataDir), LICENSE_STATE_FILE);
}

export function createLicenseManager({
  statePath,
  client,
  publicKeys = PRODUCTION_LICENSE_PUBLIC_KEYS,
  appVersion = '0.0.0',
  platform = process.platform,
  existingInstallId = async () => null,
  enforce = true,
  now = Date.now,
  checkIntervalMs = LICENSE_CHECK_INTERVAL_MS,
  offlineGraceMs = SUBSCRIPTION_OFFLINE_GRACE_MS,
  expiredRecheckMs = EXPIRED_RECHECK_MS,
  fs = { mkdir, readFile, rename, rm, writeFile },
  onChange = () => {},
  log = console,
} = {}) {
  let state = null;
  let queue = Promise.resolve();
  let timer = null;
  let lastNetworkError = null;
  let lastGrandfatherAttempt = 0;
  /** 마지막으로 알린 상태. 같은 상태는 다시 알리지 않는다. */
  let notifiedStatus = null;
  /** 상태 파일에 마지막으로 쓴 maxSeenAt 과, 그것을 뺀 나머지 내용. */
  let persistedMaxSeenAt = 0;
  let persistedBody = null;
  /** 이 실행에서 마지막으로 서버에 lease 를 물은 시각. */
  let lastValidateAt = 0;

  function serialize(task) {
    const next = queue.then(task);
    queue = next.catch(() => {});
    return next;
  }

  /** 시계를 되돌려 lease 를 늘리지 못하게, 본 적 있는 가장 늦은 시각을 쓴다. */
  function clock() {
    const t = now();
    if (state && t > state.maxSeenAt) state.maxSeenAt = t;
    return Math.max(t, state?.maxSeenAt ?? 0);
  }

  function bodyWithoutClock() {
    const { maxSeenAt: _maxSeenAt, ...rest } = state;
    return JSON.stringify(rest);
  }

  async function persist() {
    const maxSeenAt = state.maxSeenAt;
    const withoutClock = bodyWithoutClock();
    const body = `${JSON.stringify(state, null, 2)}\n`;
    const temp = `${statePath}.${process.pid}.${randomUUID()}.tmp`;
    await fs.mkdir(dirname(statePath), { recursive: true });
    try {
      await fs.writeFile(temp, body, { mode: 0o600 });
      await fs.rename(temp, statePath);
      persistedMaxSeenAt = maxSeenAt;
      persistedBody = withoutClock;
    } catch (error) {
      await fs.rm(temp, { force: true }).catch(() => {});
      throw error;
    }
  }

  async function load() {
    if (state) return;
    let raw = null;
    try {
      raw = JSON.parse(await fs.readFile(statePath, 'utf8'));
    } catch (error) {
      if (error?.code !== 'ENOENT') log.warn?.('[license] state unreadable, starting fresh:', error?.message ?? error);
    }
    state = sanitizeState(raw);
    clock();
    await persist();
  }

  function leaseCheck(t) {
    const license = state.license;
    if (!license?.lease) return { ok: false, reason: 'missing' };
    return verifyLease(license.lease, { publicKeys, deviceId: state.deviceId, key: license.key, keyId: license.keyId, now: t });
  }

  /** 결제 실패 유예의 끝. 서명한 lease 에만 있다. */
  function paymentGraceEnd(lease) {
    return lease.ok && Number.isSafeInteger(lease.payload.paymentGraceEndsAt) ? lease.payload.paymentGraceEndsAt : null;
  }

  /** 키의 만료 시각. lease 가 맞으면 서명한 값을, 아니면 마지막으로 받은 값을 쓴다. 평생 키는 null. */
  function licenseExpiry(lease) {
    if (lease.ok) return Number.isSafeInteger(lease.payload.licenseExpiresAt) ? lease.payload.licenseExpiresAt : null;
    return state.license?.licenseExpiresAt ?? null;
  }

  function computeStatus() {
    const t = clock();
    const license = state.license;
    const lease = leaseCheck(t);
    const expiresAt = license ? licenseExpiry(lease) : null;
    const paymentGraceEndsAt = license ? paymentGraceEnd(lease) : null;
    // 쓸 수 있는 끝: 결제 유예가 있으면 그 끝까지, 아니면 만료까지.
    const accessEndsAt = expiresAt === null ? null : Math.max(expiresAt, paymentGraceEndsAt ?? 0);
    const pastExpiry = accessEndsAt !== null && t >= accessEndsAt;
    // 그 끝을 지나 서버에 닿지 못하는 동안: 7일과 가진 lease 중 먼저 끝나는 때까지.
    const graceEndsAt = pastExpiry && lease.ok ? Math.min(accessEndsAt + offlineGraceMs, lease.payload.expiresAt) : null;
    let value;
    if (!license) value = 'free';
    else if (license.revokedAt) value = 'revoked';
    else if (license.expiredAt) value = 'expired';
    else if (lease.ok) value = graceEndsAt !== null && t >= graceEndsAt ? 'expired' : 'licensed';
    else if (pastExpiry) value = 'expired';
    else if (lease.reason === 'expired') value = 'lease_expired';
    else value = 'needs_activation';
    // Pro 는 서명한 lease 로만 정한다. 라이선스를 보지 않는 개발 빌드(unenforced)도 같다.
    // edition 은 서버가 'pro'·'hama' 라고 답한 키만 그 값이다. 예전 키(GLJFC9·평생·Signature·베타 등)는 null 이다.
    const paid = value === 'licensed';
    return {
      state: enforce ? value : 'unenforced',
      paid,
      edition: paid ? license.edition : null,
      plan: paid ? license.plan ?? null : null,
      rau: { eligible: paid ? license.rauEligible ?? null : false },
      deviceId: state.deviceId,
      license: license ? {
        maskedKey: maskLicenseKey(license.key),
        tier: license.tier,
        leaseExpiresAt: lease.ok || lease.reason === 'expired' ? lease.payload.expiresAt : null,
        lastCheckAt: license.lastCheckAt || null,
        nextCheckAt: license.lastCheckAt ? license.lastCheckAt + checkIntervalMs : null,
        revokedAt: license.revokedAt,
        lastError: license.lastErrorCode ? licenseErrorMessage(license.lastErrorCode, license.tier) : null,
        licenseExpiresAt: expiresAt,
        autoRenew: expiresAt === null ? null : license.autoRenew !== false,
        graceEndsAt: value === 'licensed' ? graceEndsAt : null,
        // 갱신 결제가 실패해 Groble 이 다시 시도하는 동안. 편집은 그대로 되고 결제 수단을 바꾸라고 알린다.
        paymentFailed: value === 'licensed' && paymentGraceEndsAt !== null && t < paymentGraceEndsAt,
        paymentGraceEndsAt: value === 'licensed' ? paymentGraceEndsAt : null,
        paymentFixUrl: expiresAt === null ? null : license.paymentFixUrl ?? DEFAULT_PAYMENT_FIX_URL,
      } : null,
      offline: lastNetworkError !== null,
      pricingUrl: PRICING_URL,
    };
  }

  /**
   * 매분 확인에서 바뀐 것이 시계 기록(maxSeenAt)뿐이면 쓰지 않는다. 되감기 방지에는 한 시간 단위로
   * 남기면 충분하다. 그 밖의 내용이 바뀌면 바로 쓴다.
   */
  async function persistIfChanged() {
    if (bodyWithoutClock() === persistedBody && state.maxSeenAt - persistedMaxSeenAt < MAX_SEEN_PERSIST_MS) return;
    await persist();
  }

  function changed() {
    const status = computeStatus();
    const fingerprint = JSON.stringify(status);
    if (fingerprint === notifiedStatus) return;
    notifiedStatus = fingerprint;
    try { onChange(status); } catch (error) { log.warn?.('[license] change listener failed:', error); }
  }

  /** 서버 응답 lease 를 검증하고 저장한다. 실패하면 bad_lease. */
  function acceptLease(key, { lease, keyId, tier, autoRenew, paymentFixUrl, edition, plan, rauEligible }, t) {
    const result = verifyLease(lease, { publicKeys, deviceId: state.deviceId, key, keyId, now: t });
    if (!result.ok) {
      log.warn?.('[license] server lease rejected:', result.reason);
      throw new LicenseServerError('bad_lease');
    }
    const licenseExpiresAt = Number.isSafeInteger(result.payload.licenseExpiresAt) ? result.payload.licenseExpiresAt : null;
    state.license = {
      key,
      keyId,
      tier: tier === 'beta' ? 'beta' : 'paid',
      lease,
      lastCheckAt: t,
      revokedAt: null,
      lastErrorCode: null,
      licenseExpiresAt,
      autoRenew: licenseExpiresAt === null ? null : autoRenew !== false,
      expiredAt: null,
      paymentFixUrl: paymentFixUrlFrom(paymentFixUrl),
      ...editionFrom({ edition, plan, rauEligible }),
    };
  }

  async function check({ force = false } = {}) {
    return serialize(async () => {
      await load();
      const license = state.license;
      if (!enforce) return computeStatus();
      if (!license) {
        if ((force || !lastGrandfatherAttempt || clock() - lastGrandfatherAttempt >= checkIntervalMs)) {
          lastGrandfatherAttempt = clock();
          try {
            const installId = await existingInstallId();
            if (installId) {
              const result = await client.grandfather(installId);
              const key = normalizeLicenseKey(result.key);
              if (key) {
                await checkServerPublicKey();
                acceptLease(key, await client.activate({ key, deviceId: state.deviceId, appVersion, platform }), clock());
                await persist();
              }
            }
          } catch (error) { lastNetworkError = error.code ?? 'network'; }
        }
        await persistIfChanged();
        changed();
        return computeStatus();
      }
      const t = clock();
      const lease = leaseCheck(t);
      const expiresAt = licenseExpiry(lease);
      // 만료가 지난 연간 키(결제 유예 중 포함)는 갱신을 놓치지 않게 더 자주 묻는다.
      const lapsed = Boolean(license.expiredAt) || (expiresAt !== null && t >= expiresAt) || paymentGraceEnd(lease) !== null;
      const interval = lapsed ? Math.min(checkIntervalMs, expiredRecheckMs) : checkIntervalMs;
      if (!force && license.lastCheckAt && t - license.lastCheckAt < interval && (lease.ok || license.expiredAt)) {
        return computeStatus();
      }
      // 서버가 lease 를 주지 않겠다고 답한 키(해지·키 없음·기기 초과·재활성화 필요)는 매분 묻지 않고
      // 한 시간마다 묻는다. 서버에 닿지 못한 경우는 연결되자마자 풀리도록 그대로 매분 묻는다.
      // 사용자의 '다시 확인'(force)은 바로 묻는다.
      if (!force && !lease.ok && (license.revokedAt || SERVER_LEASELESS_CODES.has(license.lastErrorCode))
        && lastValidateAt && t - lastValidateAt < Math.min(checkIntervalMs, expiredRecheckMs)) {
        return computeStatus();
      }
      lastValidateAt = t;
      try {
        const lease = await client.validate({ key: license.key, deviceId: state.deviceId });
        acceptLease(license.key, lease, clock());
        lastNetworkError = null;
      } catch (error) {
        const code = error instanceof LicenseServerError ? error.code : 'network';
        if (code === 'revoked') {
          if (error.tier === 'beta') license.tier = 'beta';
          license.revokedAt = clock();
          license.lease = null;
          license.lastErrorCode = 'revoked';
        } else if (code === 'expired') {
          // 서버가 만료라고 하면 유예 없이 끝난다. 키는 남겨 두어 갱신 뒤 다음 확인에서 다시 받는다.
          license.expiredAt = clock();
          license.lease = null;
          if (Number.isSafeInteger(error.licenseExpiresAt)) license.licenseExpiresAt = error.licenseExpiresAt;
          if (error.paymentFixUrl) license.paymentFixUrl = paymentFixUrlFrom(error.paymentFixUrl);
          license.lastErrorCode = 'expired';
          license.lastCheckAt = clock();
          lastNetworkError = null;
        } else if (code === 'invalid_key' || code === 'not_activated' || code === 'device_limit') {
          // 서버가 이 기기의 활성화를 모른다. lease 를 버리고 키는 남겨 다시 활성화하게 한다.
          license.lease = null;
          license.lastErrorCode = code;
          license.lastCheckAt = clock();
        } else {
          // 오프라인·서버 오류: 가진 lease 로 유예 기간까지 버틴다.
          lastNetworkError = code;
          license.lastErrorCode = code;
        }
      }
      // 오프라인이면 매분 같은 실패를 받는다. 내용이 그대로면 다시 쓰지 않는다.
      await persistIfChanged();
      changed();
      return computeStatus();
    });
  }

  async function checkServerPublicKey() {
    const info = await client.publicKey();
    // 공개 endpoint는 비교에만 쓴다. 내려받은 키를 신뢰 목록에 추가하지 않는다.
    if (info.alg !== 'Ed25519' || !Object.hasOwn(publicKeys, info.kid) || publicKeys[info.kid] !== info.rawBase64) {
      throw new LicenseServerError('bad_lease');
    }
  }

  async function activate(rawKey) {
    return serialize(async () => {
      await load();
      const key = normalizeLicenseKey(rawKey);
      if (!key) return { ok: false, code: 'invalid_format', message: licenseErrorMessage('invalid_format'), status: computeStatus() };
      try {
        await checkServerPublicKey();
        const lease = await client.activate({ key, deviceId: state.deviceId, appVersion, platform });
        acceptLease(key, lease, clock());
        lastNetworkError = null;
      } catch (error) {
        const code = error instanceof LicenseServerError ? error.code : 'network';
        return { ok: false, code, message: licenseErrorMessage(code, error?.tier ?? 'paid'), status: computeStatus() };
      }
      await persist();
      changed();
      return { ok: true, status: computeStatus() };
    });
  }

  async function deactivate() {
    return serialize(async () => {
      await load();
      const license = state.license;
      if (!license) return { ok: true, status: computeStatus() };
      try {
        await client.deactivate({ key: license.key, deviceId: state.deviceId });
      } catch (error) {
        const code = error instanceof LicenseServerError ? error.code : 'network';
        // 서버가 이미 모르는 키·기기면 로컬만 지우면 된다. 오프라인이면 자리를 비우지 못하므로 그대로 둔다.
        if (!['invalid_key', 'revoked', 'not_activated'].includes(code)) {
          return { ok: false, code, message: licenseErrorMessage(code), status: computeStatus() };
        }
      }
      state.license = null;
      await persist();
      changed();
      return { ok: true, status: computeStatus() };
    });
  }

  function start({ setIntervalImpl = setInterval, clearIntervalImpl = clearInterval } = {}) {
    stop.clear = clearIntervalImpl;
    void check({ force: true }).catch((error) => log.warn?.('[license] launch check failed:', error));
    timer = setIntervalImpl(() => {
      void check().then(() => {
        // lease 끝처럼 서버 확인 없이도 상태가 바뀐다. 바뀐 때만 알린다.
        changed();
      }).catch((error) => log.warn?.('[license] scheduled check failed:', error));
    }, SCHEDULE_TICK_MS);
    timer?.unref?.();
  }

  function stop() {
    if (timer !== null) (stop.clear ?? clearInterval)(timer);
    timer = null;
  }

  return {
    load: () => serialize(load),
    status: async () => { await serialize(load); return computeStatus(); },
    check,
    /**
     * 지금 검증되는(서명·기기·만료) 저장된 lease. 해지됐거나 없으면 null. enforce 와 상관없다.
     * 선물 크레딧이 서버 인증에 쓴다. 상태를 이미 읽었으면 진행 중인 서버 확인을 기다리지 않는다.
     */
    async currentLease() {
      if (!state) await serialize(load);
      if (!state.license?.lease || state.license.revokedAt || state.license.expiredAt) return null;
      return leaseCheck(clock()).ok ? state.license.lease : null;
    },
    /** 이 기기에 넣은 라이선스 키. 없으면 null. 설정의 키 복사가 쓴다. */
    async licenseKey() {
      await serialize(load);
      return state.license?.key ?? null;
    },
    activate,
    deactivate,
    start,
    stop,
  };
}
