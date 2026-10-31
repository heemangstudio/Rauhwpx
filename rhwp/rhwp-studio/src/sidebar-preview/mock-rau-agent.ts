/**
 * 호스팅 Rau 상태의 미리보기 대역 (허브 `rau-agent-status` 프레임). 서버나 데스크톱 없이 상태를 보여 준다.
 * `?rauAgent=active|trial|low|exhausted|noteligible|off` (주지 않으면 웹 Studio 라 Rau 항목이 없다).
 * active 는 Rau 플랜, trial 은 7일 체험, low 는 크레딧이 조금 남은 플랜, exhausted 는 다 쓴 플랜이고 그 상태에서
 * Rau 로 보내면 크레딧 알림이 뜬다(mock-bridge). noteligible 은 무료·Hama 요금제, off 는 서버를 못 닿은 경우다.
 */
import { inactiveRauAgentStatus, RAU_MODEL_ID, RAU_MODEL_NAME } from '../agent/rau-agent-status.ts';
import type { PiModelConfig, RauAgentStatus } from '../agent/types.ts';

export const mockRauAgentModes = ['active', 'trial', 'low', 'exhausted', 'noteligible', 'off'] as const;
export type MockRauAgentMode = (typeof mockRauAgentModes)[number];

const DAY = 86_400_000;

export function mockRauAgentMode(params: URLSearchParams): MockRauAgentMode {
  const value = params.get('rauAgent');
  return mockRauAgentModes.includes(value as MockRauAgentMode) ? (value as MockRauAgentMode) : 'off';
}

export const MOCK_RAU_MODEL: PiModelConfig = {
  id: RAU_MODEL_ID,
  name: RAU_MODEL_NAME,
  reasoning: true,
  supportsImages: true,
  efforts: ['low', 'medium', 'high'],
  defaultEffort: 'medium',
  contextLength: 200_000,
  pricing: { prompt: 0, completion: 0 },
};

export function mockRauAgentStatus(mode: MockRauAgentMode, now = Date.now()): RauAgentStatus {
  if (mode === 'off') return inactiveRauAgentStatus('unavailable');
  if (mode === 'noteligible') return inactiveRauAgentStatus('not_eligible');
  const trial = mode === 'trial';
  const allowanceUsd = trial ? 2 : 8;
  const usedUsd = mode === 'exhausted' ? 8 : mode === 'low' ? 7.35 : trial ? 0.62 : 2.8;
  return {
    availability: 'active',
    source: trial ? 'trial' : 'plan',
    credits: {
      allowanceUsd,
      usedUsd,
      remainingUsd: Math.max(0, Math.round((allowanceUsd - usedUsd) * 100) / 100),
      resetsAt: now + (trial ? 5 : 12) * DAY,
    },
    exhausted: mode === 'exhausted',
    models: [{ ...MOCK_RAU_MODEL, efforts: [...MOCK_RAU_MODEL.efforts], pricing: { ...MOCK_RAU_MODEL.pricing } }],
    defaultModelId: RAU_MODEL_ID,
    ready: true,
  };
}
