import crypto from 'node:crypto';

import { isGiftPlatform } from './gift-platforms.mjs';

/**
 * 선물 크레딧 자격(GiftCredentials)을 데스크톱 main 프로세스에서 받아 온다.
 * 리스(서명된 라이선스 임대)는 데스크톱이 들고 있고, 허브는 Pi 를 띄울 때마다 여기서 새로 받는다.
 * 선물은 macOS·Windows 데스크톱(GIFT_PLATFORMS)에서만 쓰고, 다른 플랫폼에서는 언제나 unavailable 이다.
 *
 * @typedef {Object} GiftCredentials
 * @property {boolean} available
 * @property {boolean} active  available && event.active && claimed && remainingUsd > 0
 * @property {string|null} lease  active 일 때만 들어 있다
 * @property {string|null} baseUrl  `${apiBase}/v1/gift/openrouter`
 * @property {string|null} eventId
 * @property {number|null} amountUsd
 * @property {number|null} remainingUsd
 * @property {boolean} claimed
 */

export function createIpcGiftSource({
  processRef = process,
  timeoutMs = 10_000,
  platform = process.platform,
} = {}) {
  const pending = new Map();
  const listeners = new Set();
  const available = isGiftPlatform(platform)
    && processRef.env?.RHWP_GIFT_BROKER === 'ipc'
    && typeof processRef.send === 'function';

  processRef.on?.('message', (message) => {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'rhwp-gift-changed') {
      if (!available) return;
      for (const listener of listeners) {
        try { listener(); } catch {}
      }
      return;
    }
    if (message.type !== 'rhwp-gift-response' || typeof message.id !== 'string') return;
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.ok) request.resolve(message.value ?? null);
    else request.reject(Object.assign(new Error(message.error || 'Gift credentials failed.'), {
      code: message.code || 'GIFT_SOURCE_FAILED',
    }));
  });

  function credentials({ refresh = false } = {}) {
    if (!available) {
      return Promise.reject(Object.assign(new Error('Gift credits require the macOS or Windows desktop app.'), {
        code: 'GIFT_SOURCE_UNAVAILABLE',
      }));
    }
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(Object.assign(new Error('Gift credentials did not respond.'), { code: 'GIFT_SOURCE_TIMEOUT' }));
      }, timeoutMs);
      timer.unref?.();
      pending.set(id, { resolve, reject, timer });
      processRef.send({
        type: 'rhwp-gift-request', id, operation: 'credentials', ...(refresh ? { refresh: true } : {}),
      }, (error) => {
        if (!error) return;
        const current = pending.get(id);
        if (!current) return;
        pending.delete(id);
        clearTimeout(timer);
        reject(Object.assign(error, { code: 'GIFT_SOURCE_FAILED' }));
      });
    });
  }

  return {
    available,
    credentials,
    /** 데스크톱이 선물 상태가 바뀌었다고 알릴 때 부른다. 해제 함수를 돌려준다. */
    onChange(callback) {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
  };
}

/**
 * 테스트용 고정 자격. value 가 함수면 부를 때마다 값을 새로 만든다. set() 은 값을 바꾸고 onChange 를 울린다.
 *
 * @param {GiftCredentials | (() => GiftCredentials | Promise<GiftCredentials>) | null} value
 * @param {{ available?: boolean }} [options]
 */
export function createStaticGiftSource(value, { available = true } = {}) {
  let current = value;
  const listeners = new Set();
  const calls = [];
  return {
    available,
    calls,
    async credentials(options = {}) {
      calls.push({ refresh: options.refresh === true });
      return typeof current === 'function' ? current() : current;
    },
    onChange(callback) {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
    set(next) {
      current = next;
      for (const listener of listeners) listener();
    },
  };
}
