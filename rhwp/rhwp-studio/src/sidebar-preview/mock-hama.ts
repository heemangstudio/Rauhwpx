/**
 * Hama 플랜 상태의 미리보기 대역 (허브 `hama-status` 프레임). 서버나 데스크톱 없이 상태를 보여 준다.
 * `?hama=active|cap5h|capweek|capmonth|notenrolled|off` (기본 off = unavailable). cap* 는 그 한도에 막힌
 * 상태이고, 그 상태에서 Hama 로 보내면 한도 실패 알림이 뜬다(mock-bridge). notenrolled 는 Hama 플랜이 아닌 라이선스다.
 */
import { inactiveHamaStatus } from '../agent/hama-status.ts';
import type { HamaCap, HamaStatus, PiModelConfig } from '../agent/types.ts';

export const mockHamaModes = ['active', 'cap5h', 'capweek', 'capmonth', 'notenrolled', 'off'] as const;
export type MockHamaMode = (typeof mockHamaModes)[number];

const HOUR = 3_600_000;

export function mockHamaMode(params: URLSearchParams): MockHamaMode {
  const value = params.get('hama');
  return mockHamaModes.includes(value as MockHamaMode) ? (value as MockHamaMode) : 'off';
}

const model = (id: string, name: string, reasoning: boolean, completion: number): PiModelConfig => ({
  id,
  name,
  reasoning,
  supportsImages: reasoning,
  efforts: id.startsWith('anthropic/') ? ['low', 'medium', 'high', 'xhigh'] : ['low', 'high', 'max'],
  defaultEffort: id.startsWith('anthropic/') ? 'medium' : 'high',
  contextLength: reasoning ? 200_000 : 128_000,
  pricing: { prompt: completion / 5, completion },
});

export const MOCK_HAMA_MODELS: readonly PiModelConfig[] = [
  model('anthropic/claude-haiku-5.5', 'Haiku 5.5', true, 0.0000005),
  model('deepseek/deepseek-v4.1-flash', 'DeepSeek V4.1 Flash', true, 0.0000004),
];

const CAP_OF: Partial<Record<MockHamaMode, HamaCap>> = { cap5h: 'cap_5h', capweek: 'cap_week', capmonth: 'cap_month' };

/** 지금 막힌 한도의 리셋 시각 (미리보기 기준 시각에서). */
function resetFor(cap: HamaCap, now: number): number {
  if (cap === 'cap_5h') return now + 3 * HOUR + 12 * 60_000;
  if (cap === 'cap_week') return now + 2 * 24 * HOUR + 5 * HOUR;
  return now + 9 * 24 * HOUR;
}

export function mockHamaStatus(mode: MockHamaMode, now = Date.now()): HamaStatus {
  if (mode === 'off') return inactiveHamaStatus('unavailable');
  if (mode === 'notenrolled') return inactiveHamaStatus('not_enrolled');
  const cap = CAP_OF[mode] ?? null;
  const periodStart = now - 21 * 24 * HOUR;
  const periodEnd = now + 9 * 24 * HOUR;
  const used = (limit: number, blocked: boolean, share: number) => (blocked ? limit : Math.round(limit * share * 100) / 100);
  return {
    availability: 'active',
    plan: { status: 'active', allowanceUsd: 15, periodStart, periodEnd },
    caps: {
      cap_5h: { usedUsd: used(3, cap === 'cap_5h', 0.13), limitUsd: 3, resetsAt: cap === 'cap_5h' ? resetFor('cap_5h', now) : null },
      cap_week: { usedUsd: used(7.5, cap === 'cap_week', 0.16), limitUsd: 7.5, resetsAt: cap === 'cap_week' ? resetFor('cap_week', now) : null },
      cap_month: { usedUsd: used(15, cap === 'cap_month', 0.13), limitUsd: 15, resetsAt: periodEnd },
    },
    blocked: cap ? { cap, resetsAt: resetFor(cap, now), cheapAvailable: cap !== 'cap_month' } : null,
    models: MOCK_HAMA_MODELS.map((entry) => ({ ...entry, efforts: [...entry.efforts], pricing: { ...entry.pricing } })),
    defaultModelId: MOCK_HAMA_MODELS[0]!.id,
    cheapModelIds: MOCK_HAMA_MODELS.slice(1).map((entry) => entry.id),
    ready: true,
  };
}
