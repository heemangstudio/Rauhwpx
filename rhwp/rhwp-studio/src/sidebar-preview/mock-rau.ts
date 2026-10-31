/**
 * 데스크톱 호스팅 Rau API(rhwpDesktop.rau)의 미리보기 대역. `?rau=free|rau|trial|exhausted|upgrade` (기본 off).
 * free 는 Rau 요금제가 아닌 상태, rau 는 요금제 크레딧이 남은 상태,
 * trial 은 7일 체험 중, exhausted 는 이번 달 크레딧을 다 쓴 상태다. upgrade 는 free 에 더해 허브가 거절을 받은 것처럼
 * 입력창 위 업그레이드 칩을 띄운다. 업그레이드 페이지는 열지 않고 보고만 한다.
 */
import type { DesktopRauApi, RauStatus } from '../ui/agent-sidebar/rau-upgrade.ts';

export const mockRauModes = ['free', 'rau', 'trial', 'exhausted', 'upgrade', 'off'] as const;
export type MockRauMode = (typeof mockRauModes)[number];
export const MOCK_RAU_UPGRADE_URL = 'https://heemangstudios.com/pricing.html#rau';

const DAY_MS = 86_400_000;

export function mockRauMode(params: URLSearchParams): MockRauMode {
  const value = params.get('rau');
  return mockRauModes.includes(value as MockRauMode) ? (value as MockRauMode) : 'off';
}

export function mockRauStatus(mode: Exclude<MockRauMode, 'off'>, now = Date.now()): RauStatus {
  const base = { ok: true, reason: null, upgradeUrl: MOCK_RAU_UPGRADE_URL } as const;
  if (mode === 'rau') return { ...base, eligible: true, source: 'plan', allowanceUsd: 8, usedUsd: 2.8, remainingUsd: 5.2, resetsAt: now + 18 * DAY_MS };
  if (mode === 'trial') return { ...base, eligible: true, source: 'trial', allowanceUsd: 2, usedUsd: 0.65, remainingUsd: 1.35, resetsAt: now + 5 * DAY_MS };
  if (mode === 'exhausted') return { ...base, eligible: true, source: 'plan', allowanceUsd: 8, usedUsd: 8, remainingUsd: 0, resetsAt: now + 9 * DAY_MS };
  return {
    ok: true, eligible: false, source: null, reason: 'rau_plan_required', upgradeUrl: MOCK_RAU_UPGRADE_URL,
    allowanceUsd: null, usedUsd: null, remainingUsd: null, resetsAt: null,
  };
}

export function createMockRau(mode: MockRauMode, report: (message: string) => void): DesktopRauApi | null {
  if (mode === 'off') return null;
  const status = mockRauStatus(mode);
  return {
    getStatus: async () => status,
    openUpgrade: async (url) => { report(`Upgrade page placeholder (${url ?? MOCK_RAU_UPGRADE_URL})`); },
  };
}
