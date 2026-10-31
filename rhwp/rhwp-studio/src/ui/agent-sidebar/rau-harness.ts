/**
 * 호스팅 Rau 하네스의 표시 규칙 — 피커 항목(열림·잠김·숨김), 새 채팅의 기본 하네스, 크레딧 계산.
 * DOM 이 없는 순수 함수만 둔다(붙이는 쪽은 index.ts, 사용량 카드는 provider-quota.ts).
 */
import { rauConnected } from '../../agent/rau-agent-status.ts';
import type { AgentName, RauAgentStatus } from '../../agent/types.ts';

export type RauEntry = 'open' | 'locked' | 'hidden';

/**
 * 피커의 Rau 항목. Rau 플랜이나 체험이 살아 있으면 고를 수 있다. 데스크톱 앱에서 그 밖(무료·Hama 요금제, 서버 꺼짐·
 * 오프라인)은 잠긴 채 보이고 누르면 요금제 카드의 Rau 칸을 연다. 웹 Studio 에서는 숨긴다.
 * 요금제 등급으로 짐작하지 않는다 — availability 만 본다.
 */
export function rauEntry(status: RauAgentStatus | null | undefined, desktop: boolean): RauEntry {
  if (status?.availability === 'active') return 'open';
  return desktop ? 'locked' : 'hidden';
}

/** 사용자가 마지막으로 직접 고르거나(피커) 써 본(보낸 턴) 하네스. 기본 하네스 판단에만 쓴다. */
export const HARNESS_CHOICE_STORAGE_KEY = 'rhwp-agent-harness-choice';

interface ChoiceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function choiceStorage(storage?: ChoiceStorage | null): ChoiceStorage | null {
  if (storage) return storage;
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

export function readHarnessChoice(storage?: ChoiceStorage | null): string | null {
  try {
    const choice = choiceStorage(storage)?.getItem(HARNESS_CHOICE_STORAGE_KEY) || null;
    // 예전 이름 'hama'(호스팅 하네스)는 'rau' 로 읽는다.
    return choice === 'hama' ? 'rau' : choice;
  } catch {
    return null;
  }
}

export function recordHarnessChoice(agent: AgentName, storage?: ChoiceStorage | null): void {
  const store = choiceStorage(storage);
  try {
    if (store && store.getItem(HARNESS_CHOICE_STORAGE_KEY) !== agent) store.setItem(HARNESS_CHOICE_STORAGE_KEY, agent);
  } catch {
    /* 저장하지 못하면 다음 판단이 채팅 기록으로 대신한다. */
  }
}

/**
 * 새 채팅을 Rau 로 열지. Rau 를 쓸 수 있는 사용자(연결됨)만 해당한다. 마지막으로 고른 하네스가 있으면 그것이 Rau 일
 * 때만 Rau 다. 고른 기록이 없으면 저장된 채팅이 없는 사용자(처음 쓰는 사용자)만 Rau 다 — 이 기록이 생기기 전에
 * 다른 프로바이더로 대화해 온 사용자는 그대로 둔다.
 */
export function rauIsDefault(
  status: RauAgentStatus | null | undefined,
  prior: { choice: string | null; hasChats: boolean },
): boolean {
  if (!rauConnected(status)) return false;
  if (prior.choice) return prior.choice === 'rau';
  return !prior.hasChats;
}

export interface RauCreditGauge {
  /** 남은 크레딧 비율, 0–100 정수. 다 썼으면 0. */
  percent: number;
  remainingUsd: number;
  allowanceUsd: number;
  resetsAt: number | null;
  exhausted: boolean;
  trial: boolean;
}

/** 이번 기간의 남은 크레딧. 쓸 수 없거나 크레딧 정보가 없으면 null. */
export function rauCreditGauge(status: RauAgentStatus | null | undefined): RauCreditGauge | null {
  const credits = status?.availability === 'active' ? status.credits : null;
  if (!credits) return null;
  const exhausted = status!.exhausted || (credits.allowanceUsd > 0 && credits.remainingUsd <= 0);
  const ratio = credits.allowanceUsd > 0 ? credits.remainingUsd / credits.allowanceUsd : 0;
  return {
    percent: exhausted ? 0 : Math.max(0, Math.min(100, Math.round(ratio * 100))),
    remainingUsd: exhausted ? 0 : credits.remainingUsd,
    allowanceUsd: credits.allowanceUsd,
    resetsAt: credits.resetsAt,
    exhausted,
    trial: status!.source === 'trial',
  };
}

/** $1.50 처럼 센트까지. */
export function formatRauUsd(value: number): string {
  return `$${(Math.round(Math.max(0, value) * 100) / 100).toFixed(2)}`;
}

/** 11월 30일 */
export function formatRauDate(ms: number, timeZone?: string): string {
  return new Intl.DateTimeFormat('ko-KR', { month: 'long', day: 'numeric', ...(timeZone ? { timeZone } : {}) }).format(new Date(ms));
}
