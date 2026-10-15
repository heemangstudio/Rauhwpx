// 체험·라이선스 상태. 메인 프로세스가 하나 만들어 저장 IPC 를 막고 설정 화면에 상태를 준다.
//
// 규칙
// - 체험: 처음 실행한 때부터 48시간 또는 문서 저장 3번 가운데 먼저 끝나는 때까지 편집·저장할 수 있다.
// - 키를 활성화하면 서버가 이 기기용 lease(7일)를 준다. 실행할 때와 24시간마다 다시 확인해 lease 를 늘린다.
// - 인터넷이 없으면 가진 lease 가 끝날 때까지(최대 7일) 그대로 쓴다.
// - 환불 등으로 키가 해지되면(revoked) 읽기 전용이 된다. 체험 시간이 남아 있어도 마찬가지다.
// - 읽기 전용: 문서는 열고 볼 수 있지만 저장(native 파일 쓰기)은 거절한다.
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
  productionPublicKeysProvisioned,
  verifyLease,
} from './license-lease.mjs';
import { LicenseServerError } from './license-client.mjs';

export const LICENSE_STATE_FILE = 'license.json';
export const TRIAL_DURATION_MS = 48 * 60 * 60 * 1000;
export const TRIAL_SAVE_LIMIT = 3;
export const LICENSE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** 잠자기에서 깬 뒤 등 24시간이 지났는지 이 간격으로 본다. */
const SCHEDULE_TICK_MS = 60 * 1000;
export const PRICING_URL = 'https://heemangstudios.com/pricing';
const DEVICE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export class LicenseReadOnlyError extends Error {
  constructor(state) {
    super(state === 'revoked'
      ? 'LICENSE_READ_ONLY: 라이선스가 해지되어 읽기 전용이에요. 새 라이선스 키를 넣으면 다시 저장할 수 있어요.'
      : state === 'lease_expired' || state === 'needs_activation'
        ? 'LICENSE_READ_ONLY: 라이선스를 확인하지 못해 읽기 전용이에요. 인터넷에 연결하거나 키를 다시 활성화해 주세요.'
        : 'LICENSE_READ_ONLY: 체험이 끝나 읽기 전용이에요. 라이선스 키를 넣으면 다시 저장할 수 있어요.');
    this.name = 'LicenseReadOnlyError';
    this.code = 'LICENSE_READ_ONLY';
    this.licenseState = state;
  }
}

const ERROR_MESSAGES = {
  invalid_key: '라이선스 키를 찾을 수 없어요. 키를 다시 확인해 주세요.',
  revoked: '해지된 라이선스 키예요. 환불된 주문의 키는 쓸 수 없어요.',
  device_limit: '이 키는 이미 Mac 2대에서 쓰고 있어요. 다른 Mac의 설정에서 ‘이 기기 비활성화’를 누른 뒤 다시 시도해 주세요.',
  not_activated: '이 Mac에서는 아직 활성화되지 않은 키예요. 키를 다시 넣어 주세요.',
  network: '라이선스 서버에 연결하지 못했어요. 인터넷 연결을 확인해 주세요.',
  server: '라이선스 서버가 잠시 응답하지 않아요. 조금 뒤 다시 시도해 주세요.',
  bad_lease: '라이선스 서버의 응답을 확인하지 못했어요. 앱을 최신 버전으로 업데이트해 주세요.',
  invalid_format: '라이선스 키 형식이 아니에요. 결제 완료 페이지의 키를 그대로 붙여 넣어 주세요.',
  not_configured: '이 빌드에는 라이선스 확인 키가 들어 있지 않아요.',
};

export function licenseErrorMessage(code) {
  return ERROR_MESSAGES[code] ?? ERROR_MESSAGES.server;
}

function emptyState() {
  return { v: 1, deviceId: randomUUID(), maxSeenAt: 0, trial: null, license: null };
}

function sanitizeState(raw) {
  const base = emptyState();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.v !== 1) return base;
  const state = { ...base };
  if (typeof raw.deviceId === 'string' && DEVICE_ID_RE.test(raw.deviceId)) state.deviceId = raw.deviceId;
  if (Number.isSafeInteger(raw.maxSeenAt) && raw.maxSeenAt > 0) state.maxSeenAt = raw.maxSeenAt;
  if (raw.trial && Number.isSafeInteger(raw.trial.startedAt) && raw.trial.startedAt > 0) {
    state.trial = {
      startedAt: raw.trial.startedAt,
      saves: Number.isSafeInteger(raw.trial.saves) && raw.trial.saves >= 0 ? raw.trial.saves : 0,
    };
  }
  const key = normalizeLicenseKey(raw.license?.key);
  if (key) {
    state.license = {
      key,
      keyId: typeof raw.license.keyId === 'string' ? raw.license.keyId : undefined,
      lease: typeof raw.license.lease === 'string' ? raw.license.lease : null,
      lastCheckAt: Number.isSafeInteger(raw.license.lastCheckAt) ? raw.license.lastCheckAt : 0,
      revokedAt: Number.isSafeInteger(raw.license.revokedAt) ? raw.license.revokedAt : null,
      lastErrorCode: typeof raw.license.lastErrorCode === 'string' ? raw.license.lastErrorCode : null,
    };
  }
  return state;
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
  trialDurationMs = TRIAL_DURATION_MS,
  trialSaveLimit = TRIAL_SAVE_LIMIT,
  checkIntervalMs = LICENSE_CHECK_INTERVAL_MS,
  fs = { mkdir, readFile, rename, rm, writeFile },
  onChange = () => {},
  log = console,
} = {}) {
  let state = null;
  let queue = Promise.resolve();
  let timer = null;
  let lastNetworkError = null;
  let lastGrandfatherAttempt = 0;
  const keysProvisioned = productionPublicKeysProvisioned(publicKeys);

  function serialize(task) {
    const next = queue.then(task);
    queue = next.catch(() => {});
    return next;
  }

  /** 시계를 되돌려 체험이나 lease 를 늘리지 못하게, 본 적 있는 가장 늦은 시각을 쓴다. */
  function clock() {
    const t = now();
    if (state && t > state.maxSeenAt) state.maxSeenAt = t;
    return Math.max(t, state?.maxSeenAt ?? 0);
  }

  async function persist() {
    const body = `${JSON.stringify(state, null, 2)}\n`;
    const temp = `${statePath}.${process.pid}.${randomUUID()}.tmp`;
    await fs.mkdir(dirname(statePath), { recursive: true });
    try {
      await fs.writeFile(temp, body, { mode: 0o600 });
      await fs.rename(temp, statePath);
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
    const t = clock();
    if (!state.trial) state.trial = { startedAt: t, saves: 0 };
    await persist();
  }

  function leaseCheck(t) {
    const license = state.license;
    if (!license?.lease) return { ok: false, reason: 'missing' };
    return verifyLease(license.lease, { publicKeys, deviceId: state.deviceId, key: license.key, keyId: license.keyId, now: t });
  }

  function trialInfo(t) {
    const startedAt = state.trial.startedAt;
    const endsAt = startedAt + trialDurationMs;
    const savesUsed = Math.min(state.trial.saves, trialSaveLimit);
    const active = t < endsAt && state.trial.saves < trialSaveLimit;
    return { startedAt, endsAt, savesUsed, savesLeft: trialSaveLimit - savesUsed, saveLimit: trialSaveLimit, active };
  }

  function computeStatus() {
    const t = clock();
    const trial = trialInfo(t);
    const license = state.license;
    const lease = leaseCheck(t);
    let value;
    if (!enforce) value = 'unenforced';
    else if (license?.revokedAt) value = 'revoked';
    else if (lease.ok) value = 'licensed';
    else if (license && lease.reason === 'expired') value = 'lease_expired';
    else if (license) value = 'needs_activation';
    else if (trial.active) value = 'trial';
    else value = 'trial_expired';
    const canEdit = value === 'unenforced' || value === 'licensed' || value === 'trial';
    return {
      state: value,
      canEdit,
      readOnly: !canEdit,
      deviceId: state.deviceId,
      trial,
      license: license ? {
        maskedKey: maskLicenseKey(license.key),
        leaseExpiresAt: lease.ok || lease.reason === 'expired' ? lease.payload.expiresAt : null,
        lastCheckAt: license.lastCheckAt || null,
        nextCheckAt: license.lastCheckAt ? license.lastCheckAt + checkIntervalMs : null,
        revokedAt: license.revokedAt,
        lastError: license.lastErrorCode ? licenseErrorMessage(license.lastErrorCode) : null,
      } : null,
      offline: lastNetworkError !== null,
      activationAvailable: keysProvisioned,
      pricingUrl: PRICING_URL,
    };
  }

  function changed() {
    try { onChange(computeStatus()); } catch (error) { log.warn?.('[license] change listener failed:', error); }
  }

  /** 서버 응답 lease 를 검증하고 저장한다. 실패하면 bad_lease. */
  function acceptLease(key, { lease, keyId }, t) {
    const result = verifyLease(lease, { publicKeys, deviceId: state.deviceId, key, keyId, now: t });
    if (!result.ok) {
      log.warn?.('[license] server lease rejected:', result.reason);
      throw new LicenseServerError('bad_lease');
    }
    state.license = { key, keyId, lease, lastCheckAt: t, revokedAt: null, lastErrorCode: null };
  }

  async function check({ force = false } = {}) {
    return serialize(async () => {
      await load();
      const license = state.license;
      if (!enforce) return computeStatus();
      if (!license) {
        if (keysProvisioned && (force || !lastGrandfatherAttempt || clock() - lastGrandfatherAttempt >= checkIntervalMs)) {
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
        await persist();
        changed();
        return computeStatus();
      }
      const t = clock();
      if (!force && license.lastCheckAt && t - license.lastCheckAt < checkIntervalMs && leaseCheck(t).ok) {
        return computeStatus();
      }
      try {
        const lease = await client.validate({ key: license.key, deviceId: state.deviceId });
        acceptLease(license.key, lease, clock());
        lastNetworkError = null;
      } catch (error) {
        const code = error instanceof LicenseServerError ? error.code : 'network';
        if (code === 'revoked') {
          license.revokedAt = clock();
          license.lease = null;
          license.lastErrorCode = 'revoked';
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
      await persist();
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
      if (!keysProvisioned) return { ok: false, code: 'not_configured', message: licenseErrorMessage('not_configured'), status: computeStatus() };
      try {
        await checkServerPublicKey();
        const lease = await client.activate({ key, deviceId: state.deviceId, appVersion, platform });
        acceptLease(key, lease, clock());
        lastNetworkError = null;
      } catch (error) {
        const code = error instanceof LicenseServerError ? error.code : 'network';
        return { ok: false, code, message: licenseErrorMessage(code), status: computeStatus() };
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
      state.trial.saves = trialSaveLimit;
      await persist();
      changed();
      return { ok: true, status: computeStatus() };
    });
  }

  async function assertCanSave() {
    await load();
    const status = computeStatus();
    if (!status.canEdit) throw new LicenseReadOnlyError(status.state);
    return status;
  }

  /** 문서를 저장(native 파일 쓰기)한 뒤 부른다. 체험 중일 때만 횟수를 센다. */
  async function recordSave() {
    return serialize(async () => {
      await load();
      const before = computeStatus();
      if (before.state !== 'trial') return before;
      state.trial.saves += 1;
      await persist();
      const after = computeStatus();
      changed();
      return after;
    });
  }

  function start({ setIntervalImpl = setInterval, clearIntervalImpl = clearInterval } = {}) {
    stop.clear = clearIntervalImpl;
    void check({ force: true }).catch((error) => log.warn?.('[license] launch check failed:', error));
    timer = setIntervalImpl(() => {
      void check().then(() => {
        // 체험 48시간이 지나면 서버 확인 없이도 상태가 바뀐다.
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
    activate,
    deactivate,
    assertCanSave,
    recordSave,
    start,
    stop,
  };
}
