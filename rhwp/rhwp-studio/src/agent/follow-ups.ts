/**
 * 대기 메시지 — 에이전트가 일하는 동안 Enter 로 쌓아 둔 후속 요청.
 *
 * 대기열은 채팅 스레드(ChatThread.followUps)에 함께 저장된다. 턴이 정상으로 끝나면 맨 앞
 * 하나를 보내고, 미심쩍은 끝(중지·오류·끊김·계획 승인 대기·병합 검토·허브 거절)에는
 * 사용자가 다시 보낼 때까지 붙잡아 둔다. 브리지의 전송 대기열(소켓·채팅 시작 공백 동안
 * 이미 보낸 메시지)과는 다르다 — 여기 있는 것은 사용자가 일부러 미룬 메시지다.
 *
 * 이 모듈은 상태 전이만 담은 순수 함수다. 같은 입력에는 같은 새 값을 돌려주고 받은 값을
 * 고치지 않는다. node 테스트가 바로 읽도록 상대 경로만 들여온다.
 */
import { turnOutcomeFor, type TurnEndFacts } from './turn-outcome.ts';
import type { ProductSkillIcon } from './types.ts';

/** 한 채팅에 쌓아 둘 수 있는 대기 메시지 수. */
export const FOLLOW_UP_LIMIT = 10;
/** 허브의 메시지 길이 상한(server.mjs MAX_CHAT_MESSAGE_CHARS)과 같다. */
export const FOLLOW_UP_MAX_CHARS = 128_000;

/**
 * 대기열을 붙잡은 이유. busy 만 스스로 풀리고(다음 정상 종료에 보낸다), 나머지는 사용자가
 * 보내기·지금 보내기를 누르거나 S3/U5 가 release() 할 때까지 남는다.
 */
export type FollowUpHoldReason =
  | 'stopped'
  | 'failed'
  | 'interrupted'
  | 'plan-approval'
  | 'blocked'
  | 'rejected'
  | 'busy';

export interface FollowUpItem {
  id: string;
  /** 사용자가 친 본문(앞뒤 공백 제거, '//x' 는 이미 '/x' 로 풀었다). */
  text: string;
  /** 넣을 때의 입력기 스킬 토큰. */
  skillName?: string;
  skillIcon?: ProductSkillIcon;
  createdAt: number;
}

export interface FollowUpHold {
  reason: FollowUpHoldReason;
  /** 이유를 좁히는 말 — 예: '허브 재시작', '문서 엔진 오류'. */
  detail?: string;
  /** 허브가 거절한 오류 코드(rejected). */
  code?: string;
  at: number;
}

export interface ThreadFollowUps {
  items: FollowUpItem[];
  hold?: FollowUpHold;
}

/** 턴이 끝난 모양 — 사이드바가 turn-end 와 사용자의 의도로 가른다. */
export type FollowUpTurnOutcome = 'normal' | 'send-now' | 'stopped' | 'failed' | 'interrupted';

export interface FollowUpTurnContext {
  /** 지금 보내기로 걸어 둔 항목. */
  sendNowId?: string | null;
  planAwaitingApproval: boolean;
  engineTrapped: boolean;
  mergeLocked: boolean;
  /** 고치고 있는 항목 — 편집이 닫힐 때까지 보내지 않는다. */
  editingId: string | null;
}

export type FollowUpDecision =
  | { kind: 'none' }
  | { kind: 'dispatch'; itemId: string }
  | { kind: 'hold'; reason: FollowUpHoldReason; detail?: string }
  | { kind: 'defer' };

const EMPTY: ThreadFollowUps = Object.freeze({ items: [] }) as ThreadFollowUps;

export function createFollowUpId(): string {
  const random = globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2);
  return `fu-${random}`;
}

/** 사용자가 손대야 풀리는 붙잡음인가. busy 는 다음 정상 종료에 스스로 풀린다. */
export function holdNeedsUser(hold: FollowUpHold | undefined | null): boolean {
  return Boolean(hold && hold.reason !== 'busy');
}

function itemsOf(q: ThreadFollowUps | undefined): FollowUpItem[] {
  return q?.items ?? EMPTY.items;
}

/** 항목이 없으면 붙잡음도 없다. */
function make(items: FollowUpItem[], hold: FollowUpHold | undefined): ThreadFollowUps {
  return items.length > 0 && hold ? { items, hold } : { items };
}

/** 끝에(atHead 면 맨 앞에) 넣는다. 가득 찼으면 'full'. */
export function enqueue(
  q: ThreadFollowUps | undefined,
  item: FollowUpItem,
  opts?: { atHead?: boolean },
): ThreadFollowUps | 'full' {
  const items = itemsOf(q);
  if (items.length >= FOLLOW_UP_LIMIT) return 'full';
  const next = opts?.atHead ? [item, ...items] : [...items, item];
  return make(next, q?.hold);
}

/** 본문을 고친다. 빈 본문은 항목을 지운다 — 스킬만 부르는 항목은 본문 없이도 남는다. */
export function edit(q: ThreadFollowUps | undefined, id: string, text: string): ThreadFollowUps {
  const trimmed = text.trim();
  const items = itemsOf(q);
  const target = items.find((item) => item.id === id);
  if (!target) return make(items, q?.hold);
  if (!trimmed && !target.skillName) return remove(q, id);
  return make(items.map((item) => (item.id === id ? { ...item, text: trimmed } : item)), q?.hold);
}

/** 지운다. 마지막 항목을 지우면 붙잡음도 걷힌다. */
export function remove(q: ThreadFollowUps | undefined, id: string): ThreadFollowUps {
  return make(itemsOf(q).filter((item) => item.id !== id), q?.hold);
}

export function moveToHead(q: ThreadFollowUps | undefined, id: string): ThreadFollowUps {
  const items = itemsOf(q);
  const target = items.find((item) => item.id === id);
  if (!target) return make(items, q?.hold);
  return make([target, ...items.filter((item) => item !== target)], q?.hold);
}

/**
 * 붙잡는다. 비었으면 그대로다. 이미 붙잡혀 있으면 나중 것이 이유를 바꾼다(더 구체적인
 * 설명이 뒤에 온다). 다만 busy 는 사용자가 풀어야 하는 붙잡음을 덮지 않는다.
 */
export function hold(
  q: ThreadFollowUps | undefined,
  reason: FollowUpHoldReason,
  extra?: { detail?: string; code?: string },
  now = Date.now(),
): ThreadFollowUps {
  const items = itemsOf(q);
  if (items.length === 0) return { items };
  if (reason === 'busy' && holdNeedsUser(q?.hold)) return make(items, q?.hold);
  return make(items, {
    reason,
    ...(extra?.detail ? { detail: extra.detail } : {}),
    ...(extra?.code ? { code: extra.code } : {}),
    at: now,
  });
}

export function release(q: ThreadFollowUps | undefined): ThreadFollowUps {
  return make(itemsOf(q), undefined);
}

/** 허브가 받지 않은 항목을 맨 앞으로 되돌린다. 같은 항목이 남아 있으면 겹치지 않는다. */
export function requeueHead(q: ThreadFollowUps | undefined, item: FollowUpItem): ThreadFollowUps {
  const rest = itemsOf(q).filter((entry) => entry.id !== item.id);
  return make([item, ...rest], q?.hold);
}

/**
 * 이 채팅의 턴이 끝났을 때 할 일. 먼저 맞는 규칙이 이긴다.
 * 1. 비었다 → 없음
 * 2. 지금 보내기 → 그 항목을 보낸다(붙잡혀 있어도 — 사용자가 시켰다)
 * 3. 사용자가 풀어야 하는 붙잡음 → 없음
 * 4. 중지·오류·끊김 → 그 이유로 붙잡는다
 * 5. 문서 엔진 trap → 오류로 붙잡는다
 * 6. 계획 승인 대기 → 붙잡는다
 * 7. 병합 검토 잠금 → 붙잡는다
 * 8. 항목을 고치는 중 → 편집이 닫힐 때로 미룬다
 * 9. 그 밖 → 맨 앞을 보낸다(busy 붙잡음도 여기서 풀린다)
 */
export function decideAfterTurn(
  q: ThreadFollowUps | undefined,
  outcome: FollowUpTurnOutcome,
  ctx: FollowUpTurnContext,
): FollowUpDecision {
  const items = itemsOf(q);
  if (items.length === 0) return { kind: 'none' };
  if (outcome === 'send-now') {
    const id = ctx.sendNowId ?? null;
    if (id !== null && items.some((item) => item.id === id)) return { kind: 'dispatch', itemId: id };
    // 걸어 둔 항목이 사라졌다 — 턴을 멈춘 것은 사용자였다.
    outcome = 'stopped';
  }
  if (holdNeedsUser(q?.hold)) return { kind: 'none' };
  if (outcome === 'stopped' || outcome === 'failed' || outcome === 'interrupted') {
    return { kind: 'hold', reason: outcome };
  }
  if (ctx.engineTrapped) return { kind: 'hold', reason: 'failed', detail: '문서 엔진 오류' };
  if (ctx.planAwaitingApproval) return { kind: 'hold', reason: 'plan-approval' };
  if (ctx.mergeLocked) return { kind: 'hold', reason: 'blocked' };
  if (ctx.editingId !== null) return { kind: 'defer' };
  return { kind: 'dispatch', itemId: items[0]!.id };
}

export interface FollowUpRuntimeView {
  /** 보낸 대기 메시지의 턴이 아직 끝나지 않았다. */
  inFlight: boolean;
  sendNowId: string | null;
  /** 턴이 돌거나, 보낸 메시지가 턴을 기다린다. */
  working: boolean;
  /** 편집이 닫히면 보낼 차례가 남아 있다. */
  drainDeferred: boolean;
}

/** 항목은 있는데 아무것도 이 대기열을 비우지 않을 상태 — 붙잡아서 보이게 해야 한다. */
export function isStranded(q: ThreadFollowUps | undefined, runtime: FollowUpRuntimeView): boolean {
  return itemsOf(q).length > 0
    && !q?.hold
    && !runtime.inFlight
    && runtime.sendNowId === null
    && !runtime.working
    && !runtime.drainDeferred;
}

export interface FollowUpTurnEndContext {
  /** 이 턴에 error 이벤트가 있었다(사이드바의 errorSeen). */
  errorSeen: boolean;
  /** 이 턴의 중지는 사용자가 눌렀다. */
  userStopRequested: boolean;
  /** 지금 보내기로 걸어 둔 항목. */
  sendNowId: string | null;
  /** Studio 가 붙인 끊김 이유(S3 의 허브 재시작 등). 있으면 끊긴 턴이다. */
  interruptionReason?: string | null;
}

/**
 * turn-end 하나를 대기열이 보는 결과로 가른다 — 보낼지(normal·send-now), 붙잡을지(나머지).
 * 턴의 성패는 UI 의 한 분류기(U4 turnOutcomeFor)와 같은 규칙이다: 사용자 중단과 Studio 가 붙인
 * 끊김은 interrupted, exited·failed·errorMessage·error 이벤트는 failed, 그 밖(max_tokens 같은
 * 모르는 이유 포함)은 completed. 편집 검토용 turnEndDisposition 과는 다르다.
 */
export function followUpTurnOutcome(
  event: TurnEndFacts,
  ctx: FollowUpTurnEndContext,
): FollowUpTurnOutcome {
  if (ctx.sendNowId !== null) return 'send-now';
  // 사용자가 누른 중지는 턴이 어떻게 끝났든 '멈춤'이다 — 허브가 중지보다 먼저 정상 종료를 보냈어도
  // 사용자는 멈추라고 했으므로 대기열을 보내지 않는다. Studio 가 붙인 끊김(허브 재시작)은 그 이유가 이긴다.
  if (ctx.userStopRequested && !ctx.interruptionReason) return 'stopped';
  // 성패는 UI 의 한 분류기가 정한다.
  const outcome = turnOutcomeFor(event, { errorSeen: ctx.errorSeen, interruptionReason: ctx.interruptionReason });
  if (outcome === 'interrupted') return 'interrupted';
  return outcome === 'failed' ? 'failed' : 'normal';
}

const HOLD_REASONS: ReadonlySet<string> = new Set<FollowUpHoldReason>([
  'stopped', 'failed', 'interrupted', 'plan-approval', 'blocked', 'rejected', 'busy',
]);

const SKILL_ICONS: ReadonlySet<string> = new Set<ProductSkillIcon>([
  'pencil', 'bot', 'system', 'sparkles', 'book', 'target', 'chart', 'lightbulb',
  'calendar', 'code', 'check', 'heart', 'bolt', 'shield',
]);

function normalizeItem(raw: unknown): FollowUpItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.id !== 'string' || !value.id || typeof value.text !== 'string') return null;
  const skillName = typeof value.skillName === 'string' && /^[a-z0-9-]+$/.test(value.skillName)
    ? value.skillName
    : undefined;
  const text = value.text.trim().slice(0, FOLLOW_UP_MAX_CHARS);
  if (!text && !skillName) return null;
  const skillIcon = typeof value.skillIcon === 'string' && SKILL_ICONS.has(value.skillIcon)
    ? value.skillIcon as ProductSkillIcon
    : undefined;
  const createdAt = typeof value.createdAt === 'number' && Number.isFinite(value.createdAt) ? value.createdAt : 0;
  return {
    id: value.id,
    text,
    ...(skillName ? { skillName } : {}),
    ...(skillName && skillIcon ? { skillIcon } : {}),
    createdAt,
  };
}

function normalizeHold(raw: unknown): FollowUpHold | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const value = raw as Record<string, unknown>;
  if (typeof value.reason !== 'string' || !HOLD_REASONS.has(value.reason)) return undefined;
  return {
    reason: value.reason as FollowUpHoldReason,
    ...(typeof value.detail === 'string' && value.detail ? { detail: value.detail } : {}),
    ...(typeof value.code === 'string' && value.code ? { code: value.code } : {}),
    at: typeof value.at === 'number' && Number.isFinite(value.at) ? value.at : 0,
  };
}

/** 저장본을 읽는다. 망가진 항목은 버리고, 항목이 없으면 대기열도 없다(undefined). */
export function normalizeFollowUps(raw: unknown): ThreadFollowUps | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const value = raw as Record<string, unknown>;
  const seen = new Set<string>();
  const items = (Array.isArray(value.items) ? value.items : []).flatMap((entry) => {
    const item = normalizeItem(entry);
    if (!item || seen.has(item.id)) return [];
    seen.add(item.id);
    return [item];
  }).slice(0, FOLLOW_UP_LIMIT);
  if (items.length === 0) return undefined;
  return make(items, normalizeHold(value.hold));
}

/** 저장할 모양 — 빈 대기열은 필드째 없앤다. */
export function storedFollowUps(q: ThreadFollowUps | undefined): ThreadFollowUps | undefined {
  return q && q.items.length > 0 ? q : undefined;
}

/**
 * 어느 사이드바에도 열려 있지 않은 저장된 스레드의 대기열을 붙잡는다(S3 부팅 검사용).
 * 바뀌었으면 true — 호출자가 upsertThread 로 저장한다. 사이드바의 currentThread 에는 쓰지
 * 않는다(그 사본이 다음 저장 때 덮는다).
 */
export function holdFollowUps(
  thread: { followUps?: ThreadFollowUps },
  reason: FollowUpHoldReason,
  detail?: string,
  now = Date.now(),
): boolean {
  if (!thread.followUps?.items.length) return false;
  thread.followUps = hold(thread.followUps, reason, detail ? { detail } : undefined, now);
  return true;
}

/** 저장된 스레드의 붙잡음을 푼다. 바뀌었으면 true. */
export function releaseFollowUps(thread: { followUps?: ThreadFollowUps }): boolean {
  if (!thread.followUps?.hold) return false;
  thread.followUps = release(thread.followUps);
  return true;
}
