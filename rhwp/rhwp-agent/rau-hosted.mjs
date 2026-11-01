import crypto from 'node:crypto';

/**
 * 호스팅 Rau-0.1 학습 (Rau 요금제·Rau 체험). 데스크톱 main 프로세스가 계정 lease 로 서버(/v1/rau/learn)에 묻고,
 * 허브는 결과만 받는다. lease 와 공급자 키는 허브로 오지 않는다. 데스크톱이 아니면(브라우저 Studio) 쓸 수 없고 내 계정
 * 경로만 쓴다.
 *
 * 기억하는 것
 * - rau_plan_required: 계정·라이선스가 바뀌거나 REFUSAL_MS 가 지날 때까지 묻지 않는다. 업그레이드 안내는 거절마다 한 번.
 * - rau_credits_exhausted: 서버가 준 resetsAt 까지 묻지 않는다(없으면 CAP_FALLBACK_MS).
 * - no_license: 호스팅 lease 가 없으면 데스크톱이 서버에 묻지 않고 바로 답한다. 기억하지 않는다.
 * - 자격(status): 기억(계정 단계)을 턴에 실을지 정한다. 허브는 요금제를 모른다 — 데스크톱의 답만 본다.
 */
export const RAU_REFUSAL_MS = 24 * 60 * 60 * 1000;
export const RAU_CAP_FALLBACK_MS = 60 * 60 * 1000;
/** 데스크톱의 HTTP 대기(90초)보다 길게 둔다. */
export const RAU_SOURCE_TIMEOUT_MS = 100_000;
/** 자격(Rau 요금제·체험)을 다시 묻는 간격. 라이선스가 바뀌면 데스크톱이 알려 곧바로 다시 묻는다. */
export const RAU_ELIGIBILITY_TTL_MS = 60_000;
/** 턴에 기억을 싣기 전에 자격 답을 기다려 주는 시간. 넘으면 지난 답(없으면 unavailable)으로 간다. */
export const RAU_ELIGIBILITY_WAIT_MS = 1_500;

/**
 * 데스크톱 main 에 학습을 맡기는 IPC 경로. RHWP_RAU_BROKER=ipc 로 띄운 허브에서만 쓸 수 있다.
 * learn(prompt) → { text, model }, status() → RauStatus {eligible, source, reason, remainingPercent, …}.
 * 실패하면 code(와 upgradeUrl·resetsAt 등)를 단 Error.
 */
export function createIpcRauSource({ processRef = process, timeoutMs = RAU_SOURCE_TIMEOUT_MS } = {}) {
  const pending = new Map();
  const listeners = new Set();
  const available = processRef.env?.RHWP_RAU_BROKER === 'ipc' && typeof processRef.send === 'function';

  processRef.on?.('message', (message) => {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'rhwp-rau-changed') {
      for (const listener of listeners) {
        try { listener(); } catch {}
      }
      return;
    }
    if (message.type !== 'rhwp-rau-response' || typeof message.id !== 'string') return;
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.ok) {
      request.resolve(message.value ?? null);
      return;
    }
    const { type: _type, id: _id, ok: _ok, error, code, ...details } = message;
    request.reject(Object.assign(new Error(error || 'Hosted Rau failed.'), { ...details, code: code || 'RAU_SOURCE_FAILED' }));
  });

  function request(operation, fields) {
    if (!available) return Promise.reject(Object.assign(new Error('Hosted Rau needs the desktop app.'), { code: 'RAU_SOURCE_UNAVAILABLE' }));
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(Object.assign(new Error('Hosted Rau did not respond.'), { code: 'RAU_SOURCE_TIMEOUT' }));
      }, timeoutMs);
      timer.unref?.();
      pending.set(id, { resolve, reject, timer });
      processRef.send({ type: 'rhwp-rau-request', id, operation, ...fields }, (error) => {
        if (!error) return;
        if (!pending.delete(id)) return;
        clearTimeout(timer);
        reject(Object.assign(error, { code: 'RAU_SOURCE_FAILED' }));
      });
    });
  }

  return {
    available,
    learn: (prompt) => request('learn', { prompt }),
    status: () => request('status', {}),
    /** 데스크톱이 라이선스가 바뀌었다고 알릴 때 부른다. 해제 함수를 돌려준다. */
    onChange(callback) {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
  };
}

function resetsAtFrom(value) {
  if (Number.isFinite(value) && value > 0) return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

/**
 * 자격 답 → 기억의 쓸 수 있음.
 * - active: Rau 요금제·체험이고 크레딧이 남았다.
 * - exhausted: 자격은 있지만 크레딧을 다 썼다 — 기억은 싣고 배우기만 멈춘다.
 * - not_eligible: Hama·무료. 기억을 싣지 않는다.
 * - unavailable: 데스크톱이 없거나 묻지 못했다.
 */
export function availabilityFromStatus(status) {
  if (!status || typeof status !== 'object') return 'unavailable';
  if (status.eligible !== true) return 'not_eligible';
  return Number.isFinite(status.remainingPercent) && status.remainingPercent <= 0 ? 'exhausted' : 'active';
}

/**
 * 학습기가 쓰는 호스팅 경로. usable() 이 참일 때만 learn 을 부른다.
 * learn 은 던지지 않는다: { ok: true, text, model } 또는 { ok: false, code, upgrade? }.
 * upgrade 는 이 거절에서 처음일 때만 { reason, upgradeUrl } 로 온다(Studio 안내 한 번).
 * eligibility() 는 자격을 eligibilityTtlMs 동안 기억해 두고 쓸 수 있음(availabilityFromStatus)을 돌려준다.
 */
export function createHostedRau({
  source,
  now = Date.now,
  refusalMs = RAU_REFUSAL_MS,
  capFallbackMs = RAU_CAP_FALLBACK_MS,
  eligibilityTtlMs = RAU_ELIGIBILITY_TTL_MS,
  eligibilityWaitMs = RAU_ELIGIBILITY_WAIT_MS,
} = {}) {
  let refusedUntil = 0;
  let refusalAnnounced = false;
  let capUntil = 0;
  /** 마지막 자격 답 { availability, at }. 묻기 전에는 null. */
  let eligibilityCache = null;
  /** 도는 자격 묻기 — 겹쳐 묻지 않는다. */
  let eligibilityRun = null;
  /** 라이선스가 바뀔 때마다 오른다 — 그 전에 떠난 묻기의 답은 버린다. */
  let eligibilityGeneration = 0;
  const eligibilityListeners = new Set();

  function setAvailability(availability) {
    const previous = eligibilityCache?.availability ?? null;
    eligibilityCache = { availability, at: now() };
    if (previous === availability) return;
    for (const listener of eligibilityListeners) {
      try { listener(availability); } catch {}
    }
  }

  function refreshEligibility() {
    if (eligibilityRun) return eligibilityRun;
    if (!source?.available || typeof source.status !== 'function') {
      setAvailability('unavailable');
      return Promise.resolve('unavailable');
    }
    const generation = eligibilityGeneration;
    const run = Promise.resolve()
      .then(() => source.status())
      .then((status) => availabilityFromStatus(status), () => 'unavailable')
      .then((availability) => {
        if (generation !== eligibilityGeneration) return null;
        setAvailability(availability);
        return availability;
      })
      .finally(() => {
        if (eligibilityRun === run) eligibilityRun = null;
      });
    eligibilityRun = run;
    // 묻는 동안 라이선스가 바뀌었으면 새로 물은 답을 기다린다.
    return run.then((availability) => availability ?? refreshEligibility());
  }

  source?.onChange?.(() => {
    refusedUntil = 0;
    refusalAnnounced = false;
    capUntil = 0;
    eligibilityGeneration += 1;
    eligibilityRun = null;
    if (eligibilityCache) eligibilityCache = { ...eligibilityCache, at: -Infinity };
    void refreshEligibility();
  });

  function usable() {
    if (!source?.available) return false;
    const t = now();
    return t >= refusedUntil && t >= capUntil;
  }

  /** 지금 learn 을 부르지 않는 까닭. 부를 수 있으면 null. */
  function unusableCode() {
    if (!source?.available) return 'unavailable';
    const t = now();
    if (t < refusedUntil) return 'rau_plan_required';
    if (t < capUntil) return 'rau_credits_exhausted';
    return null;
  }

  /** 기억해 둔 쓸 수 있음 (동기). 아직 묻지 않았으면 unavailable. */
  function cachedEligibility() {
    return eligibilityCache?.availability ?? 'unavailable';
  }

  /**
   * 쓸 수 있음. 답이 TTL 안이면 그대로, 낡았으면 다시 묻고 waitMs 까지 기다린다. 늦으면 지난 답을 돌려주고
   * 새 답은 들어오는 대로 기억한다(onEligibilityChange 로 알린다).
   */
  async function eligibility({ waitMs = eligibilityWaitMs } = {}) {
    if (eligibilityCache && now() - eligibilityCache.at < eligibilityTtlMs) return eligibilityCache.availability;
    const run = refreshEligibility();
    let timer;
    const late = new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), Math.max(0, waitMs));
    });
    const answer = await Promise.race([run, late]).finally(() => clearTimeout(timer));
    return answer ?? cachedEligibility();
  }

  async function learn(prompt) {
    if (!usable()) return { ok: false, code: 'unavailable' };
    try {
      const value = await source.learn(prompt);
      if (typeof value?.text !== 'string') return { ok: false, code: 'server' };
      return { ok: true, text: value.text, model: typeof value.model === 'string' && value.model ? value.model : 'rau' };
    } catch (error) {
      const code = typeof error?.code === 'string' ? error.code : 'server';
      if (code === 'rau_plan_required') {
        // 하루가 지나 다시 거절되면 그것도 새 거절이 아니다. 라이선스가 바뀌어야 다시 안내한다.
        refusedUntil = now() + refusalMs;
        const upgrade = refusalAnnounced ? undefined : { reason: code, upgradeUrl: typeof error.upgradeUrl === 'string' ? error.upgradeUrl : null };
        refusalAnnounced = true;
        setAvailability('not_eligible');
        return { ok: false, code, ...(upgrade ? { upgrade } : {}) };
      }
      if (code === 'rau_credits_exhausted') {
        const resetsAt = resetsAtFrom(error.resetsAt);
        capUntil = resetsAt !== null && resetsAt > now() ? resetsAt : now() + capFallbackMs;
        setAvailability('exhausted');
      }
      return { ok: false, code };
    }
  }

  return {
    usable,
    unusableCode,
    learn,
    eligibility,
    cachedEligibility,
    /** 쓸 수 있음이 바뀔 때 부른다. 해제 함수를 돌려준다. */
    onEligibilityChange(callback) {
      eligibilityListeners.add(callback);
      return () => eligibilityListeners.delete(callback);
    },
  };
}
