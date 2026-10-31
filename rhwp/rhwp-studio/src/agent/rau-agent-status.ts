/**
 * 허브 `rau-agent-status` 프레임을 믿지 않고 다시 읽는다. 모양이 틀리면 unavailable 스냅샷이다.
 * 모델은 'rau' 하나만 받고 이름은 언제나 'Rau' 다 — 허브가 무엇을 보내도 다른 모델은 고를 수 없다.
 */
import type { PiModelConfig, RauAgentAvailability, RauAgentStatus, RauCredits } from './types.ts';

export const RAU_MODEL_ID = 'rau';
export const RAU_MODEL_NAME = 'Rau';
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

/** epoch ms 나 ISO 문자열을 ms 로. */
function time(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : null;
  if (typeof value === 'string' && value) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
}

function usd(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function credits(value: unknown): RauCredits | null {
  if (!value || typeof value !== 'object') return null;
  const src = value as Record<string, unknown>;
  const allowanceUsd = usd(src['allowanceUsd']);
  const usedUsd = usd(src['usedUsd']);
  if (allowanceUsd === null || usedUsd === null) return null;
  const remainingUsd = usd(src['remainingUsd']) ?? Math.max(0, allowanceUsd - usedUsd);
  return { allowanceUsd, usedUsd, remainingUsd, resetsAt: time(src['resetsAt']) };
}

/** 허브가 준 모델 가운데 'rau' 하나. 이름은 고정한다. */
function rauModel(value: unknown): PiModelConfig | null {
  if (!value || typeof value !== 'object') return null;
  const src = value as Record<string, unknown>;
  if (src['id'] !== RAU_MODEL_ID) return null;
  const reasoning = src['reasoning'] === true;
  const efforts = reasoning && Array.isArray(src['efforts'])
    ? src['efforts'].filter((effort): effort is string => typeof effort === 'string' && EFFORTS.has(effort))
    : [];
  return {
    id: RAU_MODEL_ID,
    name: RAU_MODEL_NAME,
    reasoning,
    supportsImages: src['supportsImages'] === true,
    efforts,
    defaultEffort: typeof src['defaultEffort'] === 'string' && efforts.includes(src['defaultEffort']) ? src['defaultEffort'] : (efforts[0] ?? ''),
    contextLength: typeof src['contextLength'] === 'number' && Number.isFinite(src['contextLength']) ? src['contextLength'] : 0,
    // 크레딧으로 쓰므로 토큰 값은 보이지 않는다.
    pricing: { prompt: 0, completion: 0 },
  };
}

/** 쓸 수 없는 Rau — 브라우저 Studio, 옛 허브, Rau 가 아닌 요금제. */
export function inactiveRauAgentStatus(availability: Exclude<RauAgentAvailability, 'active'> = 'unavailable'): RauAgentStatus {
  return { availability, source: null, credits: null, exhausted: false, models: [], defaultModelId: RAU_MODEL_ID, ready: false };
}

export function readRauAgentStatus(value: unknown): RauAgentStatus {
  if (!value || typeof value !== 'object') return inactiveRauAgentStatus();
  const src = value as Record<string, unknown>;
  if (src['availability'] === 'not_eligible') return inactiveRauAgentStatus('not_eligible');
  if (src['availability'] !== 'active') return inactiveRauAgentStatus();
  let model: PiModelConfig | null = null;
  for (const raw of Array.isArray(src['models']) ? src['models'] : []) {
    model = rauModel(raw);
    if (model) break;
  }
  const current = credits(src['credits']);
  return {
    availability: 'active',
    source: src['source'] === 'trial' ? 'trial' : src['source'] === 'plan' ? 'plan' : null,
    credits: current,
    exhausted: src['exhausted'] === true || (current !== null && current.allowanceUsd > 0 && current.remainingUsd <= 0),
    models: model ? [model] : [],
    defaultModelId: RAU_MODEL_ID,
    ready: src['ready'] === true,
  };
}

/** Rau 를 지금 채팅에 쓸 수 있다: 자격이 살아 있고 Pi 런타임이 있다. 요금제 등급으로 짐작하지 않는다. */
export function rauConnected(status: RauAgentStatus | null | undefined): boolean {
  return status?.availability === 'active' && status.ready && status.models.length > 0;
}
