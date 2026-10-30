/**
 * 데스크톱 호스팅 Rau API 의 미리보기 대역. `?rau=free|pro|upgrade` (기본 off).
 * free 는 Pro 가 아닌 라이선스(설정의 Pro 줄에 업그레이드 단추), pro 는 쓸 수 있는 상태,
 * upgrade 는 free 에 더해 허브가 거절을 받은 것처럼 입력창 위 업그레이드 칩을 띄운다.
 * 업그레이드 페이지는 열지 않고 보고만 한다.
 */
import type { DesktopRauApi, RauStatus } from '../ui/agent-sidebar/rau-upgrade.ts';

export const mockRauModes = ['free', 'pro', 'upgrade', 'off'] as const;
export type MockRauMode = (typeof mockRauModes)[number];
export const MOCK_RAU_UPGRADE_URL = 'https://heemangstudios.com/pricing.html';

export function mockRauMode(params: URLSearchParams): MockRauMode {
  const value = params.get('rau');
  return mockRauModes.includes(value as MockRauMode) ? (value as MockRauMode) : 'off';
}

export function createMockRau(mode: MockRauMode, report: (message: string) => void): DesktopRauApi | null {
  if (mode === 'off') return null;
  const status: RauStatus = mode === 'pro'
    ? { ok: true, eligible: true, reason: null, upgradeUrl: MOCK_RAU_UPGRADE_URL, capUsd: 3, usedUsd: 0.4, remainingUsd: 2.6, resetsAt: null }
    : { ok: true, eligible: false, reason: 'rau_requires_pro', upgradeUrl: MOCK_RAU_UPGRADE_URL };
  return {
    getStatus: async () => status,
    openUpgrade: async (url) => { report(`Upgrade page placeholder (${url ?? MOCK_RAU_UPGRADE_URL})`); },
  };
}
