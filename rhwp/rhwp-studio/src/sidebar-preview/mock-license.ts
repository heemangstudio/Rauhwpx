/**
 * 데스크톱 라이선스 API 의 미리보기 대역. 처음 설정의 라이선스 장을 데스크톱 없이 보여 준다.
 * `?license=free|expired|licensed|off` (기본 off). `trial` 은 예전 주소라 free 로 읽는다. 키가 HAMA-로
 * 시작하면 활성화하고, HAMA-FAIL… 이면 서버가 거절한 것처럼 돌려준다. 구매 단추는 보고만 한다.
 */
import type { DesktopLicenseApi, LicenseStatus } from '../ui/agent-sidebar/settings-license.ts';

export const mockLicenseModes = ['free', 'expired', 'licensed', 'off'] as const;
export type MockLicenseMode = (typeof mockLicenseModes)[number];

const ACTIVATE_DELAY_MS = 800;
const DAY_MS = 86_400_000;

export function mockLicenseMode(params: URLSearchParams): MockLicenseMode {
  const value = params.get('license');
  if (value === 'trial') return 'free';
  return mockLicenseModes.includes(value as MockLicenseMode) ? (value as MockLicenseMode) : 'off';
}

function freeStatus(): LicenseStatus {
  return { state: 'free', paid: false, edition: null, plan: null, rau: { eligible: false }, license: null, offline: false };
}

/** 기간이 끝난 연간 키. 편집은 되고 Basic 만 꺼진다. */
function expiredStatus(): LicenseStatus {
  return {
    ...freeStatus(),
    state: 'expired',
    license: {
      maskedKey: 'HAMA-…PREV',
      tier: 'paid',
      leaseExpiresAt: null,
      lastCheckAt: Date.now() - DAY_MS,
      lastError: null,
      licenseExpiresAt: Date.now() - 3 * DAY_MS,
      autoRenew: true,
    },
  };
}

function licensedStatus(key: string): LicenseStatus {
  const tail = key.replace(/[^0-9A-Z]/gi, '').slice(-4).toUpperCase();
  return {
    state: 'licensed',
    paid: true,
    edition: 'basic',
    plan: 'annual',
    rau: { eligible: true },
    offline: false,
    license: {
      maskedKey: `HAMA-…${tail.padStart(4, '0')}`,
      tier: 'paid',
      leaseExpiresAt: Date.now() + 7 * DAY_MS,
      lastCheckAt: Date.now(),
      lastError: null,
      licenseExpiresAt: Date.now() + 365 * DAY_MS,
      autoRenew: true,
    },
  };
}

export interface MockLicense {
  api: DesktopLicenseApi;
  onLicensed(listener: () => void): void;
}

/** `off` 면 null — 웹 빌드처럼 라이선스 API 가 없다. */
export function createMockLicense(mode: MockLicenseMode, report: (message: string) => void): MockLicense | null {
  if (mode === 'off') return null;
  let status = mode === 'licensed' ? licensedStatus('HAMA-PREVIEW') : mode === 'expired' ? expiredStatus() : freeStatus();
  const listeners = new Set<(status: LicenseStatus) => void>();
  const licensedListeners = new Set<() => void>();
  const api: DesktopLicenseApi = {
    getStatus: async () => status,
    checkNow: async () => status,
    activate: (key) => new Promise((resolve) => setTimeout(() => {
      const normalized = key.trim().toUpperCase();
      if (!normalized.startsWith('HAMA-') || normalized.startsWith('HAMA-FAIL')) {
        resolve({ ok: false, code: 'invalid_key', message: '등록되지 않은 키예요. 다시 확인해 주세요.', status });
        return;
      }
      status = licensedStatus(normalized);
      report('License activated (sample)');
      for (const listener of [...listeners]) listener(status);
      for (const listener of [...licensedListeners]) listener();
      resolve({ ok: true, status });
    }, ACTIVATE_DELAY_MS)),
    deactivate: async () => ({ ok: false, message: '미리보기에서는 비활성화하지 않아요.', status }),
    openActivation: async () => { report('Activation window placeholder'); return true; },
    openPricing: async () => { report('Pricing page placeholder'); },
    copyKey: async () => { report('License key copied (sample)'); return status.license !== null; },
    onChange: (callback) => {
      listeners.add(callback);
      return () => { listeners.delete(callback); };
    },
  };
  return { api, onLicensed: (listener) => { licensedListeners.add(listener); } };
}
