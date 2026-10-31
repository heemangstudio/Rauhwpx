import crypto from 'node:crypto';

/**
 * 호스팅 Rau-0.1 (Basic). 데스크톱 main 프로세스가 라이선스 lease 로 서버(/v1/rau/learn)에 묻고, 허브는 결과만 받는다.
 * lease 와 공급자 키는 허브로 오지 않는다. 데스크톱이 아니면(브라우저 Studio) 쓸 수 없고 내 계정 경로만 쓴다.
 *
 * 기억하는 것
 * - rau_requires_basic(예전 이름 rau_requires_pro): 라이선스가 바뀌거나 REFUSAL_MS 가 지날 때까지 묻지 않는다. 업그레이드 안내는 거절마다 한 번.
 * - rau_cap_reached: 서버가 준 resetsAt 까지 묻지 않는다(없으면 CAP_FALLBACK_MS).
 * - no_license: 키가 없으면 데스크톱이 서버에 묻지 않고 바로 답한다. 기억하지 않는다.
 */
export const RAU_REFUSAL_MS = 24 * 60 * 60 * 1000;
export const RAU_CAP_FALLBACK_MS = 60 * 60 * 1000;
/** 데스크톱의 HTTP 대기(90초)보다 길게 둔다. */
export const RAU_SOURCE_TIMEOUT_MS = 100_000;

/**
 * 데스크톱 main 에 학습을 맡기는 IPC 경로. RHWP_RAU_BROKER=ipc 로 띄운 허브에서만 쓸 수 있다.
 * learn(prompt) → { text, model }. 실패하면 code(와 upgradeUrl·resetsAt 등)를 단 Error.
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

  function learn(prompt) {
    if (!available) return Promise.reject(Object.assign(new Error('Hosted Rau needs the desktop app.'), { code: 'RAU_SOURCE_UNAVAILABLE' }));
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(Object.assign(new Error('Hosted Rau did not respond.'), { code: 'RAU_SOURCE_TIMEOUT' }));
      }, timeoutMs);
      timer.unref?.();
      pending.set(id, { resolve, reject, timer });
      processRef.send({ type: 'rhwp-rau-request', id, operation: 'learn', prompt }, (error) => {
        if (!error) return;
        if (!pending.delete(id)) return;
        clearTimeout(timer);
        reject(Object.assign(error, { code: 'RAU_SOURCE_FAILED' }));
      });
    });
  }

  return {
    available,
    learn,
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
 * 학습기가 쓰는 호스팅 경로. usable() 이 참일 때만 learn 을 부른다.
 * learn 은 던지지 않는다: { ok: true, text, model } 또는 { ok: false, code }.
 */
export function createHostedRau({ source, now = Date.now, refusalMs = RAU_REFUSAL_MS, capFallbackMs = RAU_CAP_FALLBACK_MS } = {}) {
  let refusedUntil = 0;
  let capUntil = 0;

  source?.onChange?.(() => {
    refusedUntil = 0;
    capUntil = 0;
  });

  function usable() {
    if (!source?.available) return false;
    const t = now();
    return t >= refusedUntil && t >= capUntil;
  }

  async function learn(prompt) {
    if (!usable()) return { ok: false, code: 'unavailable' };
    try {
      const value = await source.learn(prompt);
      if (typeof value?.text !== 'string') return { ok: false, code: 'server' };
      return { ok: true, text: value.text, model: typeof value.model === 'string' && value.model ? value.model : 'rau' };
    } catch (error) {
      const raw = typeof error?.code === 'string' ? error.code : 'server';
      const code = raw === 'rau_requires_pro' ? 'rau_requires_basic' : raw;
      if (code === 'rau_requires_basic') {
        // 하루 동안 다시 묻지 않는다. 라이선스가 바뀌면 바로 다시 묻는다.
        refusedUntil = now() + refusalMs;
        return { ok: false, code };
      }
      if (code === 'rau_cap_reached') {
        const resetsAt = resetsAtFrom(error.resetsAt);
        capUntil = resetsAt !== null && resetsAt > now() ? resetsAt : now() + capFallbackMs;
      }
      return { ok: false, code };
    }
  }

  return { usable, learn };
}
