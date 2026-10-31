// 선물 크레딧 상태. 메인 프로세스가 하나 만들어 Studio(IPC)와 허브(자식 IPC)에 준다.
//
// 규칙
// - macOS·Windows 에서만 쓴다. 다른 OS 에서는 서버에 묻지 않고 늘 available:false 다.
// - 지금 유효한 lease(계정 lease, 무료가 아닌 것)가 있어야 묻는다. 없으면(로그아웃, 무료, 만료) available:false.
// - 서버 답은 cacheMs 동안 재사용한다. 네트워크·서버 오류면 같은 라이선스의 마지막 답을 지키고 error 만 남긴다.
// - 서버가 lease 를 거절하면(unauthorized) 답을 버린다.
// - 허브에 주는 자격 증명의 lease 는 선물을 쓸 수 있을 때(active)만 넣는다.
import { decodeLeaseUnverified } from './license-lease.mjs';
import { GiftServerError } from './gift-client.mjs';

export const GIFT_CACHE_MS = 60_000;
/** 선물 크레딧을 쓰는 데스크톱 플랫폼. */
export const GIFT_PLATFORMS = new Set(['darwin', 'win32']);

const CLAIM_MESSAGES = {
  not_eligible: '이 라이선스로는 받을 수 없습니다.',
  event_inactive: '이벤트가 끝났습니다.',
  budget_exhausted: '준비한 크레딧이 모두 소진되었습니다.',
};
const CLAIM_FALLBACK_MESSAGE = '받지 못했습니다. 잠시 뒤 다시 시도해 주세요.';

export function giftClaimMessage(code) {
  return CLAIM_MESSAGES[code] ?? CLAIM_FALLBACK_MESSAGE;
}

/** 답을 지킬지 정하는 lease 의 주인. 계정 lease(v2)는 계정과 대표 키, 예전 lease 는 키. */
function keyIdOf(lease) {
  const payload = decodeLeaseUnverified(lease);
  if (payload?.v === 2) return typeof payload.accountId === 'string' ? `${payload.accountId}:${payload.keyId ?? ''}` : null;
  return typeof payload?.keyId === 'string' ? payload.keyId : null;
}

/** onChange 를 부를 만큼 바뀌었는지 비교할 값. */
function fingerprint(status) {
  return JSON.stringify([
    status.available, status.event?.id ?? null, status.event?.active ?? null,
    status.eligible, status.claimed, status.remainingUsd,
  ]);
}

export function createGiftManager({
  client,
  currentLease = async () => null,
  platform = process.platform,
  now = Date.now,
  cacheMs = GIFT_CACHE_MS,
  onChange = () => {},
  log = console,
} = {}) {
  const supported = GIFT_PLATFORMS.has(platform);
  /** 마지막으로 받은 서버 답과 그때의 lease. */
  let answer = null;
  let answerLease = null;
  let checkedAt = null;
  let lastError = null;
  /** 마지막으로 본 lease(없음 포함). undefined 는 아직 보지 않음. */
  let seenLease;
  /** 마지막으로 서버에 물은 시각과 lease. 실패도 cacheMs 동안은 다시 묻지 않는다. */
  let attemptedAt = null;
  let attemptLease = null;
  let inflight = null;
  let inflightLease = null;
  let lastFingerprint = JSON.stringify([fingerprint(build()), null]);

  function build() {
    if (!answer) {
      return {
        available: false, event: null, eligible: false, claimed: false,
        remainingUsd: null, usedUsd: null, claimedAt: null, checkedAt: null, error: lastError,
      };
    }
    return { available: true, ...answer, event: answer.event ? { ...answer.event } : null, checkedAt, error: lastError };
  }

  function notify() {
    const status = build();
    // lease 가 바뀌어도 알린다. 허브는 스폰마다 이 알림으로 받은 lease 를 쓴다(24시간마다 갱신).
    const next = JSON.stringify([fingerprint(status), seenLease ?? null]);
    if (next === lastFingerprint) return status;
    lastFingerprint = next;
    try { onChange(status); } catch (error) { log.warn?.('[gift] change listener failed:', error); }
    return status;
  }

  async function readLease() {
    if (!supported) return null;
    try {
      const lease = await currentLease();
      return typeof lease === 'string' && lease ? lease : null;
    } catch {
      return null;
    }
  }

  function forget(error = null) {
    answer = null;
    answerLease = null;
    checkedAt = null;
    lastError = error;
  }

  async function fetchStatus(lease) {
    attemptedAt = now();
    attemptLease = lease;
    try {
      const result = await client.status(lease);
      // 묻는 사이 라이선스가 바뀌었으면(해제 등) 늦게 온 답으로 크레딧을 되살리지 않는다.
      if (seenLease !== lease) return;
      answer = result;
      answerLease = lease;
      checkedAt = now();
      lastError = null;
    } catch (error) {
      if (seenLease !== lease) return;
      const code = error instanceof GiftServerError ? error.code : 'network';
      if (code === 'unauthorized' || (answer && keyIdOf(answerLease) !== keyIdOf(lease))) forget(code);
      else lastError = code;
      if (code !== 'unauthorized') log.warn?.('[gift] status check failed:', code);
    }
  }

  async function status({ refresh = false } = {}) {
    const lease = await readLease();
    seenLease = lease;
    if (!lease) {
      forget(null);
      return notify();
    }
    const fresh = attemptLease === lease && attemptedAt !== null && now() - attemptedAt < cacheMs;
    if (!refresh && fresh) return build();
    // 같은 lease 로 이미 묻는 중이면 그 답을 같이 쓴다.
    while (inflight && inflightLease !== lease) await inflight;
    if (!inflight) {
      inflightLease = lease;
      inflight = fetchStatus(lease).finally(() => { inflight = null; inflightLease = null; });
    }
    await inflight;
    return notify();
  }

  async function claim() {
    const lease = await readLease();
    if (!lease) {
      return { ok: false, code: 'not_eligible', message: giftClaimMessage('not_eligible'), status: await status() };
    }
    try {
      const result = await client.claim(lease);
      if (answer) answer = { ...answer, claimed: true, remainingUsd: result.remainingUsd, usedUsd: answer.usedUsd ?? 0, claimedAt: result.claimedAt };
    } catch (error) {
      const code = error instanceof GiftServerError ? error.code : 'network';
      // 자격이나 이벤트 상태가 바뀌었을 수 있으니 팝업이 바로 알도록 다시 묻는다.
      if (code !== 'network') await status({ refresh: true });
      return { ok: false, code, message: giftClaimMessage(code), status: build() };
    }
    return { ok: true, status: await status({ refresh: true }) };
  }

  async function credentials({ refresh = false } = {}) {
    const current = await status({ refresh });
    const active = Boolean(current.available && current.event?.active && current.claimed && (current.remainingUsd ?? 0) > 0);
    return {
      available: current.available,
      active,
      lease: active ? seenLease : null,
      baseUrl: current.available ? client.proxyBaseUrl : null,
      eventId: current.event?.id ?? null,
      amountUsd: current.event?.amountUsd ?? null,
      remainingUsd: current.remainingUsd,
      claimed: current.claimed,
    };
  }

  /** 라이선스 상태가 바뀌면 부른다. lease 가 바뀌었을 때만 서버에 다시 묻는다. */
  async function licenseChanged() {
    if (!supported) return build();
    const lease = await readLease();
    if (lease === seenLease) return build();
    return status({ refresh: true });
  }

  return { status, claim, credentials, licenseChanged, platform, supported };
}
