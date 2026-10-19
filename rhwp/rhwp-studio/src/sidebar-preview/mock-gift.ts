/**
 * 선물 크레딧 데스크톱 API 의 미리보기 대역. 서버나 데스크톱 없이 상태 네 가지를 보여 준다.
 * `?gift=unclaimed|claimed|exhausted|off` (기본 off, `event=special` 이면 unclaimed).
 * `claim=fail` 이면 받기를 서버가 거절한 것처럼 돌려준다.
 * locked 면 데스크톱처럼 라이선스를 활성화하기(unlock) 전에는 available:false 다.
 */
import type { DesktopGiftApi, DesktopGiftStatus, GiftClaimResult } from '../ui/special-event/gift.ts';

export const mockGiftModes = ['unclaimed', 'claimed', 'exhausted', 'off'] as const;
export type MockGiftMode = (typeof mockGiftModes)[number];

const AMOUNT_USD = 20;
const CLAIM_DELAY_MS = 700;

export function mockGiftMode(params: URLSearchParams): MockGiftMode {
  const value = params.get('gift');
  if (mockGiftModes.includes(value as MockGiftMode)) return value as MockGiftMode;
  return params.get('event') === 'special' ? 'unclaimed' : 'off';
}

function statusFor(mode: Exclude<MockGiftMode, 'off'>): DesktopGiftStatus {
  const claimed = mode !== 'unclaimed';
  const remainingUsd = mode === 'claimed' ? 18.4 : mode === 'exhausted' ? 0 : null;
  return {
    available: true,
    event: { id: 'special-preview', amountUsd: AMOUNT_USD, endsAt: null, active: true },
    eligible: true,
    claimed,
    remainingUsd,
    usedUsd: remainingUsd === null ? null : AMOUNT_USD - remainingUsd,
    claimedAt: claimed ? Date.now() - 86_400_000 : null,
    checkedAt: Date.now(),
    error: null,
  };
}

export interface MockGift {
  api: DesktopGiftApi;
  /** Pi 가 지금 선물을 쓰는지(받았고 남아 있다). */
  active(): boolean;
  claims(): number;
  /** 라이선스를 활성화한 뒤처럼 선물을 보이게 하고 알린다. */
  unlock(): void;
}

/** `off` 면 null — 웹이나 macOS 가 아닌 데스크톱처럼 선물 API 가 없다. */
export function createMockGift(
  mode: MockGiftMode,
  options: { failClaim?: boolean; locked?: boolean } = {},
): MockGift | null {
  if (mode === 'off') return null;
  let status = statusFor(mode);
  let locked = options.locked === true;
  const visible = (): DesktopGiftStatus => (locked
    ? { ...status, available: false, event: null, eligible: false, claimed: false, remainingUsd: null, usedUsd: null }
    : { ...status });
  let claims = 0;
  const listeners = new Set<(status: DesktopGiftStatus) => void>();
  const api: DesktopGiftApi = {
    getStatus: async () => visible(),
    claim: () => new Promise<GiftClaimResult>((resolve) => setTimeout(() => {
      claims += 1;
      if (options.failClaim) {
        resolve({ ok: false, code: 'budget_exhausted', message: '준비한 크레딧이 모두 소진되었습니다.', status: { ...status } });
        return;
      }
      if (!status.claimed) {
        status = { ...status, claimed: true, remainingUsd: AMOUNT_USD, usedUsd: 0, claimedAt: Date.now(), checkedAt: Date.now() };
        for (const listener of [...listeners]) listener({ ...status });
      }
      resolve({ ok: true, status: { ...status } });
    }, CLAIM_DELAY_MS)),
    onChange: (callback) => {
      listeners.add(callback);
      return () => { listeners.delete(callback); };
    },
  };
  return {
    api,
    active: () => status.claimed && (status.remainingUsd ?? 0) > 0,
    claims: () => claims,
    unlock: () => {
      if (!locked) return;
      locked = false;
      for (const listener of [...listeners]) listener(visible());
    },
  };
}
