/**
 * Hama 하네스의 표시 규칙 — 피커 항목(열림·잠김·숨김), 새 채팅의 기본 하네스, 사용량 게이지 계산.
 * DOM 이 없는 순수 함수만 둔다(그리는 쪽은 hama-usage.ts, 붙이는 쪽은 index.ts).
 */
import { HAMA_CAPS, hamaConnected } from '../../agent/hama-status.ts';
import type { AgentName, HamaCap, HamaStatus } from '../../agent/types.ts';

export type HamaEntry = 'open' | 'locked' | 'hidden';

/**
 * 피커의 Hama 항목. Hama 플랜이 살아 있으면 고를 수 있다. 아니면 데스크톱 앱에서는 잠긴 채 보이고(누르면 플랜
 * 안내를 연다), 웹 Studio 에서는 숨긴다. Pro·Free 같은 라이선스 등급으로 짐작하지 않는다 — availability 만 본다.
 */
export function hamaEntry(status: HamaStatus | null | undefined, desktop: boolean): HamaEntry {
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
    return choiceStorage(storage)?.getItem(HARNESS_CHOICE_STORAGE_KEY) || null;
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
 * 새 채팅을 Hama 로 열지. Hama 플랜 가입자(연결됨)만 해당한다. 마지막으로 고른 하네스가 있으면 그것이 Hama 일
 * 때만 Hama 다. 고른 기록이 없으면 저장된 채팅이 없는 사용자(처음 쓰는 사용자)만 Hama 다 — 이 기록이 생기기 전에
 * 다른 프로바이더로 대화해 온 사용자는 그대로 둔다.
 */
export function hamaIsDefault(
  status: HamaStatus | null | undefined,
  prior: { choice: string | null; hasChats: boolean },
): boolean {
  if (!hamaConnected(status)) return false;
  if (prior.choice) return prior.choice === 'hama';
  return !prior.hasChats;
}

export interface HamaGaugeWindow {
  cap: HamaCap;
  /** 0–100 정수. 막힌 창은 100. */
  percent: number;
  resetsAt: number | null;
  blocked: boolean;
}

/** 한도 창들의 사용률. 플랜이 없거나 창 정보가 없으면 빈 배열. */
export function hamaGauge(status: HamaStatus | null | undefined): HamaGaugeWindow[] {
  const caps = status?.availability === 'active' ? status.caps : null;
  if (!caps) return [];
  const out: HamaGaugeWindow[] = [];
  for (const cap of HAMA_CAPS) {
    const window = caps[cap];
    if (!window) continue;
    const blocked = status?.blocked?.cap === cap;
    const ratio = window.limitUsd > 0 ? window.usedUsd / window.limitUsd : (window.usedUsd > 0 ? 1 : 0);
    const percent = blocked ? 100 : Math.max(0, Math.min(100, Math.round(ratio * 100)));
    const resetsAt = blocked ? (status?.blocked?.resetsAt ?? window.resetsAt) : window.resetsAt;
    out.push({ cap, percent, resetsAt, blocked });
  }
  return out;
}

/** 지금 가장 빠듯한 창 — 막힌 창, 아니면 사용률이 가장 높은 창(같으면 짧은 창). */
export function bindingWindow(windows: readonly HamaGaugeWindow[]): HamaGaugeWindow | null {
  let best: HamaGaugeWindow | null = null;
  for (const window of windows) {
    if (window.blocked) return window;
    if (!best || window.percent > best.percent) best = window;
  }
  return best;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** 초기화까지 남은 시간 — 두 단위까지, 분은 올림. 지났으면 null. */
export function formatResetIn(resetsAt: number | null, now: number): string | null {
  if (resetsAt === null) return null;
  const left = resetsAt - now;
  if (left <= 0) return null;
  const minutes = Math.ceil(left / MINUTE);
  if (minutes < 60) return `${minutes}분`;
  if (left < DAY) {
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return rest ? `${hours}시간 ${rest}분` : `${hours}시간`;
  }
  const days = Math.floor(left / DAY);
  const hours = Math.floor((left % DAY) / HOUR);
  return hours ? `${days}일 ${hours}시간` : `${days}일`;
}

/** 다음 분 경계까지(최소 1초) — 카운트다운은 분 단위로만 바뀐다. */
export function msToNextMinute(now: number): number {
  return Math.max(1_000, MINUTE - (now % MINUTE));
}
