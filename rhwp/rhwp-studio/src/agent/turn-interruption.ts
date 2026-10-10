/**
 * 끊긴 턴 — 허브 재시작, 앱 재시작, 새로고침, 사라진 채팅 세션, 엔진 멈춤으로 끝을 듣지 못한 턴.
 *
 * 따로 표식을 두지 않는다. U4 의 턴 표식(kind:'turn')이 턴 시작에 저장되고 끝에 정착한다 —
 * 아무 살아 있는 세션도 붙들지 않은 정착 전 표식이 끊긴 턴이다. 이 모듈은
 * - 그런 표식을 찾아(부팅·채팅 열기) 이유와 함께 정착하고,
 * - 사용자가 이어서 진행하면 에이전트에게 보낼 블록(<turn_interrupted>)을 만들고,
 * - 다시 붙은 살아 있는 턴이면 끊김 기록을 되돌린다.
 *
 * 저장소를 직접 고치는 것은 markThreadInterrupted 하나뿐이고, 나머지는 받은 스레드 사본만 바꾸는
 * 순수 함수다. node 테스트가 바로 읽도록 상대 경로만 들여온다.
 */
import {
  createTurnMarker,
  estimateTurnEnd,
  expirePendingUserQuestion,
  getThread,
  isTurnMarker,
  latestTurnMarker,
  settleTurnMarker,
  threadActivityAt,
  unsettledTurnMarkers,
  upsertThread,
  type ChatThread,
  type ThreadMessage,
  type ThreadTurnMessage,
  type TurnOwner,
} from './threads.ts';
import { holdFollowUps } from './follow-ups.ts';
import {
  INTERRUPTION_CAUSE,
  INTERRUPTION_LABEL,
  type TurnInterruptionReason,
} from './turn-interruption-reason.ts';

export {
  INTERRUPTION_CAUSE,
  INTERRUPTION_LABEL,
  INTERRUPTION_NOTICE,
  TURN_INTERRUPTION_REASONS,
  isTurnInterruptionReason,
  lostSessionReason,
  type TurnInterruptionReason,
} from './turn-interruption-reason.ts';

/** 이어서 진행 단추가 보내는 사용자 메시지 — 말풍선과 기록에는 이것만 보인다. */
export const RESUME_MESSAGE_TEXT = '이어서 진행해 주세요.';

/**
 * 페이지가 아는 자기 정체성. windowSessionId 는 새로고침을 넘어 같은 창 세션, appLaunchId 는
 * 데스크톱 앱 실행 id(웹에서는 페이지마다 바뀌므로 null).
 */
export interface InterruptionScope {
  windowSessionId: string | null;
  appLaunchId: string | null;
}

/** 지금 이 페이지·앱·허브 — 턴 시작에 표식의 owner 로 남고, 부팅 때 남은 표식과 견준다. */
export function currentTurnOwner(scope: InterruptionScope | null, hubInstanceId: string | null): TurnOwner {
  return {
    window: scope?.windowSessionId ?? null,
    app: scope?.appLaunchId ?? null,
    hub: hubInstanceId,
  };
}

function differs(before: string | null | undefined, now: string | null | undefined): boolean {
  return Boolean(before && now && before !== now);
}

/**
 * 끝을 듣지 못한 턴이 왜 끊겼나. 데스크톱의 앱 실행이 바뀌었으면 앱 재시작, 허브 프로세스가
 * 바뀌었으면 허브 재시작, 둘 다 같거나 모르면 새로고침이다.
 */
export function reasonFor(owner: Partial<TurnOwner> | null | undefined, now: TurnOwner): TurnInterruptionReason {
  if (differs(owner?.app, now.app)) return 'app-restart';
  if (differs(owner?.hub, now.hub)) return 'hub-restart';
  return 'reload';
}

/** 이 창의 허브 세션이 아직 붙들고 있는 채팅의 턴 — 끊긴 것이 아니다. */
export interface LiveHubTurn {
  threadId: string;
  /** 허브의 턴 id. 모르면 null. */
  turnId: string | null;
}

export interface InterruptedMarkerDecision {
  threadId: string;
  markerId: string;
  reason: TurnInterruptionReason;
}

/** 살아 있는 턴이 이 표식의 턴인가 — 둘 다 아는데 다르면 아니다. */
function liveTurnOwnsMarker(marker: ThreadTurnMessage, live: LiveHubTurn): boolean {
  return !(marker.hubTurnId && live.turnId && marker.hubTurnId !== live.turnId);
}

export interface StartupReconcileContext {
  now: TurnOwner;
  /**
   * 허브의 첫 답에서 이 창이 이어 붙이거나(adopt) 그 문서를 기다리는(await-document) 바쁜 채팅.
   * 그 채팅의 마지막 표식은 살아 있다. 멈출 채팅(stopLive)이나 쉬는 세션이면 null.
   */
  live: LiveHubTurn | null;
}

/**
 * 부팅 정리 — 창의 기본 사이드바가 시작 채팅을 고르기 직전에 한 번 부른다. 저장된 모든 채팅의
 * 정착 전 표식을 보고 끊긴 턴을 가린다.
 * - 이 창이 잇는 채팅의 마지막 표식: 살아 있다(남긴다).
 * - 같은 채팅의 더 오래된 정착 전 표식: 한 채팅은 한 턴만 돌리므로 끊겼다.
 * - 이 창이 돌린 턴: 새로고침을 넘는 것은 창의 채팅 하나뿐이고 그것은 위에서 남겼다 — 끊겼다.
 * - 다른 앱 실행·허브 프로세스의 턴: 그 세션은 모두 사라졌다 — 끊겼다.
 * - 주인을 모르거나 같은 허브의 다른 창 턴: 모른다 — 채팅을 열 때(reconcileThreadOnOpen) 본다.
 */
export function reconcileInterruptedTurns(
  threads: readonly ChatThread[],
  ctx: StartupReconcileContext,
): InterruptedMarkerDecision[] {
  const decisions: InterruptedMarkerDecision[] = [];
  for (const thread of threads) {
    const latest = latestTurnMarker(thread.messages);
    for (const marker of unsettledTurnMarkers(thread.messages)) {
      const dead = (reason: TurnInterruptionReason) => decisions.push({ threadId: thread.id, markerId: marker.messageId, reason });
      if (ctx.live && ctx.live.threadId === thread.id) {
        if (marker === latest && liveTurnOwnsMarker(marker, ctx.live)) continue;
        dead(reasonFor(marker.owner, ctx.now));
        continue;
      }
      if (marker !== latest) {
        dead(reasonFor(marker.owner, ctx.now));
        continue;
      }
      const owner = marker.owner;
      if (!owner) continue;
      const ownWindow = Boolean(owner.window && owner.window === ctx.now.window);
      if (ownWindow || differs(owner.app, ctx.now.app) || differs(owner.hub, ctx.now.hub)) {
        dead(reasonFor(owner, ctx.now));
      }
    }
  }
  return decisions;
}

export interface OpenReconcileContext {
  now: TurnOwner;
  /** 이 브리지가 허브에서 붙들고 있는 채팅의 턴. */
  live: LiveHubTurn | null;
  /** 채팅 목록 상태 — working·needs-input 이면 다른 창·탭·채팅이 아직 돌린다. */
  status: string | null;
}

/**
 * 채팅을 열 때의 정리. 이 브리지가 붙든 턴도 아니고, 일하는 신호(심장박동)나 응답 대기 신호도
 * 없는 정착 전 표식은 끊긴 턴이다. 마지막 표식이 아닌 정착 전 표식은 언제나 끊겼다.
 */
export function reconcileThreadOnOpen(thread: ChatThread, ctx: OpenReconcileContext): InterruptedMarkerDecision[] {
  const latest = latestTurnMarker(thread.messages);
  const decisions: InterruptedMarkerDecision[] = [];
  for (const marker of unsettledTurnMarkers(thread.messages)) {
    if (marker === latest) {
      if (ctx.live && ctx.live.threadId === thread.id && liveTurnOwnsMarker(marker, ctx.live)) continue;
      if (ctx.status === 'working' || ctx.status === 'needs-input') continue;
    }
    decisions.push({ threadId: thread.id, markerId: marker.messageId, reason: reasonFor(marker.owner, ctx.now) });
  }
  return decisions;
}

/** 정착할 때 접힘 제목(옛 빌드가 한 줄로 보인다)을 만드는 함수 — 사이드바의 settledTurnText. */
export type TurnFoldText = (messages: readonly ThreadMessage[], marker: ThreadTurnMessage, endedAt: number) => string;

export interface InterruptTurnOptions {
  foldText?: TurnFoldText;
  /** 끝 시각. 없으면 그 턴의 마지막 기록과 채팅이 마지막으로 움직인 시각으로 잡는다. */
  endedAt?: number;
}

export interface InterruptTurnResult {
  marker: ThreadTurnMessage;
  /** 이 턴의 질문 초안을 만료로 보관했다(그 턴 자리에 카드가 남는다). */
  questionExpired: boolean;
  /** 대기 메시지를 붙잡았다. */
  followUpsHeld: boolean;
}

/**
 * 끝을 듣지 못한 표식 하나를 끊긴 턴으로 정착한다 — 받은 스레드 사본을 바꾸고 저장은 부른 쪽이 한다.
 * 1. 끝 시각은 그 턴의 마지막 기록과 채팅이 마지막으로 움직인 시각 중 늦은 쪽(지금보다 늦지 않게) —
 *    내려가 있던 시간을 턴 길이에 넣지 않는다.
 * 2. outcome 은 interrupted, interruption 에 이유와 감지 시각을 남긴다.
 * 3. 이 표식이 채팅의 마지막 턴이면 남은 질문 초안은 답할 곳이 없다 — 만료로 보관한다.
 * 4. 대기 메시지를 이유와 함께 붙잡는다(사용자가 이어서 진행하거나 보낼 때까지).
 */
export function interruptTurn(
  thread: ChatThread,
  marker: ThreadTurnMessage,
  reason: TurnInterruptionReason,
  now: number,
  opts: InterruptTurnOptions = {},
): InterruptTurnResult {
  const endedAt = opts.endedAt ?? Math.max(
    estimateTurnEnd(thread.messages, marker),
    Math.min(threadActivityAt(thread), now),
  );
  const latest = latestTurnMarker(thread.messages) === marker;
  settleTurnMarker(marker, {
    endedAt,
    outcome: 'interrupted',
    reason,
    interruption: { reason, at: now },
    // 옛 빌드는 표식을 이 문구의 한 줄로 보인다. 접힘 제목을 만들 수 없으면 '중단됨'만 남긴다.
    text: opts.foldText ? opts.foldText(thread.messages, marker, Math.max(marker.startedAt, endedAt)) : marker.text || '중단됨',
  });
  const questionExpired = latest && thread.pendingUserQuestion
    ? expirePendingUserQuestion(thread, 'request-invalidated') !== null
    : false;
  const followUpsHeld = latest ? holdFollowUps(thread, 'interrupted', INTERRUPTION_LABEL[reason], now) : false;
  return { marker, questionExpired, followUpsHeld };
}

/**
 * 채팅의 마지막 턴을 이 이유로 끊는다 — 엔진 멈춤 복구(S7)처럼 바깥이 이유를 알 때.
 * - 정착 전 표식이면 정착한다.
 * - 이미 끊긴 것으로 정착했지만 아직 아무도 이어 가지 않았으면 이유를 바꾼다 — 더 구체적인 이유가
 *   이긴다(부팅 정리의 '새로고침' 뒤에 오는 '문서 엔진 멈춤', 사용자 중지로 정착한 턴).
 * - 표식이 없으면(표식을 남기기 전의 턴) 마지막 요청 바로 뒤에 끊긴 표식을 만든다.
 * - 끝까지 갔거나 오류로 끝났거나 이미 이어 간 턴은 그대로 둔다(null).
 */
export function interruptLatestTurn(
  thread: ChatThread,
  reason: TurnInterruptionReason,
  now: number,
  opts: InterruptTurnOptions = {},
): ThreadTurnMessage | null {
  let marker = latestTurnMarker(thread.messages);
  if (!marker) {
    if (thread.messages.length === 0) return null;
    const lastUser = thread.messages.map((message) => message.role).lastIndexOf('user');
    const startedAt = Math.min(threadActivityAt(thread), now);
    marker = createTurnMarker(startedAt);
    thread.messages.splice(lastUser + 1, 0, marker);
    interruptTurn(thread, marker, reason, now, { ...opts, endedAt: startedAt });
    return marker;
  }
  if (marker.endedAt === null) {
    interruptTurn(thread, marker, reason, now, opts);
    return marker;
  }
  if (marker.outcome !== 'interrupted' || marker.interruption?.resolution) return null;
  marker.reason = reason;
  marker.interruption = { reason, at: now };
  if (thread.pendingUserQuestion) expirePendingUserQuestion(thread, 'request-invalidated');
  holdFollowUps(thread, 'interrupted', INTERRUPTION_LABEL[reason], now);
  return marker;
}

/**
 * 저장된 채팅의 마지막 턴을 끊는다(interruptLatestTurn 을 저장소 사본에 적용하고 저장한다).
 * 그 채팅을 화면에 연 사이드바가 있으면 그 사이드바의 markInterrupted 를 부른다 — 사이드바는
 * 다음 저장 때 자기 사본으로 이 기록을 덮는다. 바꿨으면 true.
 */
export function markThreadInterrupted(
  threadId: string,
  reason: TurnInterruptionReason,
  opts: InterruptTurnOptions & { now?: number } = {},
): boolean {
  const thread = getThread(threadId);
  if (!thread) return false;
  const marker = interruptLatestTurn(thread, reason, opts.now ?? Date.now(), opts);
  if (!marker) return false;
  upsertThread(thread);
  return true;
}

/**
 * 끊김 기록을 되돌린다 — 새로고침 뒤 S2 가 이 채팅의 살아 있는 턴을 다시 잡았는데, 부팅 정리나
 * 다른 탭이 먼저 그 턴을 끊긴 것으로 정착했을 때. 마지막 표식이 아직 이어 가지 않은 끊김이고
 * 허브 턴 id 가 같거나(모르면 같다고 본다) 하면 정착 전으로 돌린다. 되돌린 표식, 아니면 null.
 * 엔진 멈춤으로 끊은 턴은 되돌리지 않는다 — 복구가 끝난 턴으로 정했고, 허브가 아직 돌리면 다시 연
 * 페이지가 첫 welcome 에서 멈춘다(S7). 그 멈춤이 사용자의 멈춤으로 이유를 덮지 않게 한다.
 */
export function reviveInterruptedTurn(thread: ChatThread, liveTurnId: string | null): ThreadTurnMessage | null {
  const marker = latestTurnMarker(thread.messages);
  if (!marker?.interruption || marker.interruption.resolution) return null;
  if (marker.interruption.reason === 'engine-trap') return null;
  if (marker.hubTurnId && liveTurnId && marker.hubTurnId !== liveTurnId) return null;
  marker.endedAt = null;
  marker.outcome = null;
  marker.text = '';
  delete marker.reason;
  delete marker.interruption;
  return marker;
}

/** 마지막 턴이 끊긴 채 아직 아무도 이어 가지 않았으면 그 표식과 이유. */
export function unresolvedInterruption(
  thread: Pick<ChatThread, 'messages'>,
): { marker: ThreadTurnMessage; reason: TurnInterruptionReason } | null {
  const marker = latestTurnMarker(thread.messages);
  if (!marker || marker.outcome !== 'interrupted' || !marker.interruption || marker.interruption.resolution) return null;
  return { marker, reason: marker.interruption.reason };
}

/** 이 표식의 턴 자리 — 표식 뒤부터 다음 사용자 메시지나 표식 전까지의 순번. */
export function turnSegmentIndexes(messages: readonly ThreadMessage[], markerId: string): number[] {
  const start = messages.findIndex((message) => isTurnMarker(message) && message.messageId === markerId);
  if (start < 0) return [];
  const indexes: number[] = [];
  for (let i = start + 1; i < messages.length; i += 1) {
    const message = messages[i];
    if (message.role === 'user' || isTurnMarker(message)) break;
    indexes.push(i);
  }
  return indexes;
}

/** 이 턴 자리에 만료된 질문 카드가 있는가. */
export function segmentHasExpiredQuestion(messages: readonly ThreadMessage[], markerId: string): boolean {
  return turnSegmentIndexes(messages, markerId).some((index) => {
    const message = messages[index];
    return message.kind === 'user-question' && message.outcome.status === 'expired';
  });
}

export interface ContinuationContext {
  /** 끊기기 전에 스테이징한 편집이 아직 검토를 기다린다(문서에 미리보기로 남아 있다). */
  stagedAwaitingReview: boolean;
  /** 그 턴의 질문이 답을 받지 못하고 만료됐다. */
  questionExpired: boolean;
}

/**
 * 끊긴 뒤 처음 나가는 사용자 메시지 끝에 붙는 블록 — 에이전트가 끊겼다는 것과 편집 상태를 알고,
 * 다시 편집하기 전에 문서를 다시 읽게 한다. 모델이 읽는 영어다(말풍선에는 보이지 않는다).
 */
export function continuationBlock(reason: TurnInterruptionReason, ctx: ContinuationContext): string {
  return [
    `<turn_interrupted reason="${reason}">`,
    `Your previous turn in this chat was cut off before it finished because ${INTERRUPTION_CAUSE[reason]}. `
      + 'Tool calls that were in flight may or may not have taken effect.',
    ctx.stagedAwaitingReview
      ? 'Edits you staged before the interruption are still shown to the user as a preview and are waiting for their review; '
        + 'they are part of the document you will read.'
      : "Edits you had not finished, or that were still waiting for the user's review, may no longer be in the document.",
    ...(ctx.questionExpired ? ['Your question to the user expired unanswered; ask again if you still need the answer.'] : []),
    'Re-read the parts of the document you were working on before editing again, and do not repeat edits that are '
      + "already there. Then continue the user's last request from where you stopped.",
    '</turn_interrupted>',
  ].join('\n');
}

/** 요청문 끝에 블록을 붙인다 — 앞의 복원 안내(U6) 등 다른 꾸밈과 겹쳐도 순서가 바뀌지 않는다. */
export function appendContinuationBlock(requestText: string, reason: TurnInterruptionReason, ctx: ContinuationContext): string {
  return `${requestText}\n\n${continuationBlock(reason, ctx)}`;
}

/**
 * 이어서 진행 메시지 한 건의 기록용 본문과 보낼 요청문 — sendComposedMessage({ wire }) 에 그대로
 * 넣는다. U5 의 다시 시도가 턴 도중 끝난 에이전트 프로세스(process_exited)의 턴을, 원래 요청을
 * 다시 보내는 대신 이어 가게 할 때 쓴다('agent-exit').
 */
export function continuationWire(
  reason: TurnInterruptionReason,
  ctx: ContinuationContext,
): { displayText: string; requestText: string } {
  return { displayText: RESUME_MESSAGE_TEXT, requestText: appendContinuationBlock(RESUME_MESSAGE_TEXT, reason, ctx) };
}

/**
 * Studio 가 허브를 잃고 합성한 turn-end 인가(S3 의 interruption 필드). U5 의 실패 수집은 이 끝을
 * 실패로 세지 않는다 — 끊김 줄 하나만 보인다.
 */
export function isInterruptionTurnEnd(event: { type?: unknown; interruption?: unknown }): boolean {
  return (event.type === undefined || event.type === 'turn-end') && typeof event.interruption === 'string'
    && event.interruption.length > 0;
}
