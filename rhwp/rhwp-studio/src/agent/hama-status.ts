/**
 * 허브 `hama-status` 프레임을 믿지 않고 다시 읽는다. 모양이 틀리면 unavailable 스냅샷이다.
 * 모델은 Haiku 5.5 하나만 Claude 로 받는다 — 허브가 무엇을 보내도 Sonnet·Opus 는 고를 수 없다.
 */
import type { HamaAvailability, HamaCap, HamaCapWindow, HamaStatus, PiModelConfig } from './types.ts';

export const HAMA_CLAUDE_MODEL = 'anthropic/claude-haiku-5.5';
export const HAMA_CAPS: readonly HamaCap[] = ['cap_5h', 'cap_week', 'cap_month'];
const EFFORTS = new Set(['low', 'medium', 'high']);

function time(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function usd(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function isHamaCap(value: unknown): value is HamaCap {
  return typeof value === 'string' && (HAMA_CAPS as readonly string[]).includes(value);
}

function capWindow(value: unknown): HamaCapWindow | null {
  if (!value || typeof value !== 'object') return null;
  const src = value as Record<string, unknown>;
  const usedUsd = usd(src['usedUsd']);
  const limitUsd = usd(src['limitUsd']);
  if (usedUsd === null || limitUsd === null) return null;
  return { usedUsd, limitUsd, resetsAt: time(src['resetsAt']) };
}

function model(value: unknown): PiModelConfig | null {
  if (!value || typeof value !== 'object') return null;
  const src = value as Record<string, unknown>;
  const id = src['id'];
  const name = src['name'];
  if (typeof id !== 'string' || !id || typeof name !== 'string' || !name) return null;
  if (id.startsWith('anthropic/') && id !== HAMA_CLAUDE_MODEL) return null;
  const reasoning = src['reasoning'] === true;
  const efforts = reasoning && Array.isArray(src['efforts'])
    ? src['efforts'].filter((effort): effort is string => typeof effort === 'string' && EFFORTS.has(effort))
    : [];
  const pricing = (src['pricing'] ?? {}) as Record<string, unknown>;
  return {
    id,
    name,
    reasoning,
    supportsImages: src['supportsImages'] === true,
    efforts,
    defaultEffort: typeof src['defaultEffort'] === 'string' && efforts.includes(src['defaultEffort']) ? src['defaultEffort'] : (efforts[0] ?? ''),
    contextLength: typeof src['contextLength'] === 'number' && Number.isFinite(src['contextLength']) ? src['contextLength'] : 0,
    pricing: { prompt: usd(pricing['prompt']) ?? 0, completion: usd(pricing['completion']) ?? 0 },
  };
}

/** 쓸 수 없는 Hama — 브라우저 Studio, 옛 허브, 플랜이 아닌 라이선스. */
export function inactiveHamaStatus(availability: Exclude<HamaAvailability, 'active'> = 'unavailable'): HamaStatus {
  return {
    availability, plan: null, caps: null, blocked: null, models: [], defaultModelId: HAMA_CLAUDE_MODEL, cheapModelIds: [], ready: false,
  };
}

export function readHamaStatus(value: unknown): HamaStatus {
  if (!value || typeof value !== 'object') return inactiveHamaStatus();
  const src = value as Record<string, unknown>;
  if (src['availability'] === 'not_enrolled') return inactiveHamaStatus('not_enrolled');
  const plan = (src['plan'] ?? null) as Record<string, unknown> | null;
  if (src['availability'] !== 'active' || !plan || typeof plan !== 'object' || plan['status'] !== 'active') {
    return inactiveHamaStatus();
  }
  const rawCaps = (src['caps'] ?? {}) as Record<string, unknown>;
  const caps = Object.fromEntries(HAMA_CAPS.map((cap) => [cap, capWindow(rawCaps[cap])])) as Record<HamaCap, HamaCapWindow | null>;
  const rawBlocked = (src['blocked'] ?? null) as Record<string, unknown> | null;
  const blocked = rawBlocked && isHamaCap(rawBlocked['cap'])
    ? {
      cap: rawBlocked['cap'],
      resetsAt: time(rawBlocked['resetsAt']),
      cheapAvailable: rawBlocked['cap'] !== 'cap_month' && rawBlocked['cheapAvailable'] === true,
    }
    : null;
  const models: PiModelConfig[] = [];
  for (const raw of Array.isArray(src['models']) ? src['models'] : []) {
    const entry = model(raw);
    if (entry && !models.some((existing) => existing.id === entry.id)) models.push(entry);
  }
  const ids = new Set(models.map((entry) => entry.id));
  const cheapModelIds = (Array.isArray(src['cheapModelIds']) ? src['cheapModelIds'] : [])
    .filter((id): id is string => typeof id === 'string' && ids.has(id) && !id.startsWith('anthropic/'));
  const requestedDefault = src['defaultModelId'];
  return {
    availability: 'active',
    plan: {
      status: 'active',
      allowanceUsd: usd(plan['allowanceUsd']),
      periodStart: time(plan['periodStart']),
      periodEnd: time(plan['periodEnd']),
    },
    caps,
    blocked,
    models,
    defaultModelId: typeof requestedDefault === 'string' && ids.has(requestedDefault)
      ? requestedDefault
      : (models[0]?.id ?? HAMA_CLAUDE_MODEL),
    cheapModelIds,
    ready: src['ready'] === true,
  };
}

/** Hama 를 지금 채팅에 쓸 수 있다: 플랜이 살아 있고 Pi 런타임이 있다. 라이선스 등급으로 짐작하지 않는다. */
export function hamaConnected(status: HamaStatus | null | undefined): boolean {
  return status?.availability === 'active' && status.ready && status.models.length > 0;
}
