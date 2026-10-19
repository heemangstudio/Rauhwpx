/**
 * 데스크톱 라이선스 API 의 미리보기 대역. 처음 설정의 라이선스 장을 데스크톱 없이 보여 준다.
 * `?license=trial|expired|licensed|off` (기본 off). 키가 HAMA-로 시작하면 활성화하고, HAMA-FAIL… 이면
 * 서버가 거절한 것처럼 돌려준다. 구매 단추는 보고만 한다.
 */
import type { DesktopLicenseApi, LicenseStatus } from '../ui/agent-sidebar/settings-license.ts';

export const mockLicenseModes = ['trial', 'expired', 'licensed', 'off'] as const;
export type MockLicenseMode = (typeof mockLicenseModes)[number];

const ACTIVATE_DELAY_MS = 800;
const TRIAL_MS = 72 * 60 * 60 * 1000;

export function mockLicenseMode(params: URLSearchParams): MockLicenseMode {
  const value = params.get('license');
  return mockLicenseModes.includes(value as MockLicenseMode) ? (value as MockLicenseMode) : 'off';
}

function trialStatus(expired: boolean): LicenseStatus {
  const now = Date.now();
  const startedAt = expired ? now - TRIAL_MS - 60_000 : now - 5 * 60_000;
  return {
    state: expired ? 'trial_expired' : 'trial',
    canEdit: !expired,
    readOnly: expired,
    trial: { startedAt, endsAt: startedAt + TRIAL_MS, active: !expired },
    license: null,
    offline: false,
  };
}

function licensedStatus(from: LicenseStatus, key: string): LicenseStatus {
  const tail = key.replace(/[^0-9A-Z]/gi, '').slice(-4).toUpperCase();
  return {
    ...from,
    state: 'licensed',
    canEdit: true,
    readOnly: false,
    license: {
      maskedKey: `HAMA-…${tail.padStart(4, '0')}`,
      tier: 'paid',
      leaseExpiresAt: Date.now() + 7 * 86_400_000,
      lastCheckAt: Date.now(),
      lastError: null,
      licenseExpiresAt: Date.now() + 365 * 86_400_000,
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
  let status = mode === 'licensed' ? licensedStatus(trialStatus(false), 'HAMA-PREVIEW') : trialStatus(mode === 'expired');
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
      status = licensedStatus(status, normalized);
      report('License activated (sample)');
      for (const listener of [...listeners]) listener(status);
      for (const listener of [...licensedListeners]) listener();
      resolve({ ok: true, status });
    }, ACTIVATE_DELAY_MS)),
    deactivate: async () => ({ ok: false, message: '미리보기에서는 비활성화하지 않아요.', status }),
    openActivation: async () => { report('Activation window placeholder'); return true; },
    openPricing: async () => { report('Pricing page placeholder'); },
    onChange: (callback) => {
      listeners.add(callback);
      return () => { listeners.delete(callback); };
    },
  };
  return { api, onLicensed: (listener) => { licensedListeners.add(listener); } };
}
