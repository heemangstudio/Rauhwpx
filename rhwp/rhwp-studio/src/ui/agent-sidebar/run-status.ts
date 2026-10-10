/**
 * 사이드바 하나의 레일 상태 — 이 사이드바가 아는 사실(도는 턴, 질문, 승인 대기 계획,
 * 검토 대기 편집, 보지 않은 턴 결과)에서 채팅마다 상태 하나를 골라 공유 저장소
 * (agent/chat-status)에 쓰고, 바뀐 상태를 알림 장부(agent/chat-attention)에 알린다.
 *
 * - 사이드바는 사실이 바뀌는 곳마다 sync() 를 부른다. 쓰기는 값이 같으면 건너뛴다.
 * - 결과(완료·오류)는 그 채팅을 보지 않은 채 턴이 끝났을 때만 남고, 보면 걷힌다.
 *   사용자가 멈춘 턴과 대기열이 곧바로 다음 메시지를 보낸 턴은 아무것도 남기지 않는다.
 * - 장부에는 한 마이크로태스크 뒤에 알린다 — turn-end 바로 뒤에 같은 흐름으로 도착하는
 *   실패 이유(U5 의 turn-failure, S3 의 중단)가 먼저 붙는다.
 *
 * DOM 을 모른다 — 사실은 주입받는다.
 */
import {
  deriveChatRunStatus,
  getChatStatus,
  getChatStatusLabel,
  isLiveChatStatus,
  normalizeChatStatusLabel,
  releaseOwnedLiveStatuses,
  setChatStatus,
  type ChatRunStatus,
} from '../../agent/chat-status.ts';
import type { AttentionReason, ChatAttentionLedger } from '../../agent/chat-attention.ts';
import type { TurnOutcome } from '../../agent/turn-outcome.ts';

export interface RunStatusControllerDeps {
  attention: ChatAttentionLedger;
  turnRunning(): boolean;
  /** 브리지가 붙잡고 있는 사용자 질문. */
  pendingQuestion(): { threadId: string; interactionId: string } | null;
  /** 승인을 기다리는 계획 — 그 턴이 끝난 뒤에만 준다. */
  awaitingPlan(): { threadId: string; planId: string } | null;
  /** 검토를 기다리는 편집 묶음이 있는가. */
  reviewAwaiting(): boolean;
  /** 지금 보고 있는 채팅(보이고 창에 초점). 없으면 null. */
  seenThreadId(): string | null;
  /** 알림 문구용 채팅 제목과 문서 이름. */
  describe(threadId: string): { title: string; documentName: string | null };
  /** 알림 열쇠의 턴 부분을 새로 짓는다 — U4 표식 id 가 없을 때. */
  createTurnId(): string;
  /** 장부 알림을 미룬다. 기본은 마이크로태스크. */
  defer?(fn: () => void): void;
}

interface UnreadOutcome {
  threadId: string;
  state: 'failed' | 'finished';
  label: string | null;
  /** 알림 문구 — 실패 알림의 제목('Claude 사용 한도에 도달했어요 · 리셋 오후 3:00'). */
  summary: string | null;
  reason: AttentionReason | null;
  turnId: string;
}

export interface TurnFailureNote {
  /** 레일의 짧은 이유('로그인 필요', '사용 한도' …). */
  label?: string | null;
  /** 알림에 쓸 한 줄 — 없으면 이유나 '오류로 멈췄습니다'. */
  summary?: string | null;
  /** 바깥 사정으로 끊겼다(허브 재시작 등). 이유가 없으면 '중단됨'. */
  interrupted?: boolean;
}

export function createRunStatusController(deps: RunStatusControllerDeps) {
  const defer = deps.defer ?? ((fn: () => void) => queueMicrotask(fn));
  /** 도는 턴의 채팅. */
  let runThreadId: string | null = null;
  /** 알림 열쇠의 턴 부분 — 도는(또는 방금 끝난) 턴. */
  let noticeTurnId: string | null = null;
  /** 검토 대기 편집을 만든 채팅과 턴. */
  let review: { threadId: string; turnId: string } | null = null;
  /** 보지 않은 채 끝난 턴의 결과. 보면, 그리고 그 채팅의 다음 턴이 시작되면 걷힌다. */
  let outcome: UnreadOutcome | null = null;
  /** 방금 끝난 턴 — turn-end 뒤에 닿는 실패 이유가 여기 붙는다. */
  let ended: { threadId: string; turnId: string; seen: boolean } | null = null;
  /** 이 사이드바가 마지막으로 쓴 상태. 떠난 채팅의 살아 있는 상태를 걷는 데 쓴다. */
  const written = new Map<string, { status: ChatRunStatus; label: string | null; input: string | null }>();
  /** 채팅마다 끝 상태(검토·오류·완료)를 남긴 턴 — 알림 열쇠 `{턴}:end`. */
  const endTurnIds = new Map<string, string>();
  const reportQueue = new Set<string>();
  let flushQueued = false;
  let disposed = false;

  function currentTurnId(): string {
    noticeTurnId ??= deps.createTurnId();
    return noticeTurnId;
  }

  /** 남이(다른 창의 열람 등) 결과 점을 걷었으면 이 사이드바도 그 결과를 놓는다. */
  function dropOutcomeClearedElsewhere(): void {
    if (!outcome) return;
    const mine = written.get(outcome.threadId);
    if (mine?.status !== outcome.state || getChatStatus(outcome.threadId) === outcome.state) return;
    written.delete(outcome.threadId);
    outcome = null;
  }

  function sync(): void {
    if (disposed) return;
    dropOutcomeClearedElsewhere();
    if (review && !deps.reviewAwaiting()) review = null;
    const question = deps.pendingQuestion();
    const plan = deps.awaitingPlan();
    const running = deps.turnRunning();
    const ids = new Set(written.keys());
    for (const id of [runThreadId, review?.threadId, outcome?.threadId, question?.threadId, plan?.threadId]) {
      if (id) ids.add(id);
    }
    for (const id of ids) {
      const status = deriveChatRunStatus({
        needsInput: question?.threadId === id || plan?.threadId === id,
        working: running && runThreadId === id,
        reviewPending: review?.threadId === id,
        unreadOutcome: outcome?.threadId === id ? outcome.state : null,
      });
      const label = status === 'failed' && outcome?.threadId === id ? outcome.label : null;
      // 입력 대기의 까닭 — 질문이 계획 승인으로 바뀌면 같은 상태라도 다시 알린다.
      const input = status !== 'needs-input' ? null
        : question?.threadId === id ? `question:${question.interactionId}`
          : plan?.threadId === id ? `plan:${plan.planId}` : null;
      const previous = written.get(id) ?? null;
      if (status) {
        setChatStatus(id, status, { label });
        written.set(id, { status, label, input });
      } else {
        // 이 사이드바가 쓴 살아 있는 상태만 걷는다. 결과 점과 남이 쓴 점(S3 의 중단 등)은 남긴다.
        if (previous && isLiveChatStatus(previous.status) && getChatStatus(id) === previous.status) {
          setChatStatus(id, null);
        }
        written.delete(id);
      }
      if (
        (previous?.status ?? null) !== status
        || (previous?.label ?? null) !== label
        || (previous?.input ?? null) !== input
      ) queueReport(id);
    }
  }

  function queueReport(threadId: string): void {
    reportQueue.add(threadId);
    if (flushQueued) return;
    flushQueued = true;
    defer(flushReports);
  }

  function reportKey(
    threadId: string,
    status: ChatRunStatus | null,
  ): { key: string; reason: AttentionReason | null; summary?: string | null } {
    switch (status) {
      case 'needs-input': {
        const question = deps.pendingQuestion();
        if (question?.threadId === threadId) {
          return { key: `${currentTurnId()}:input:${question.interactionId}`, reason: 'question' };
        }
        const plan = deps.awaitingPlan();
        if (plan?.threadId === threadId) {
          return { key: `${currentTurnId()}:input:plan:${plan.planId}`, reason: 'plan' };
        }
        return { key: '', reason: null };
      }
      case 'needs-review':
        // 검토와 그 턴의 결과는 열쇠 하나 — 검토가 끝나 결과로 돌아가도 다시 알리지 않는다.
        return { key: `${endTurnIds.get(threadId) ?? currentTurnId()}:end`, reason: null };
      case 'failed':
      case 'finished': {
        const mine = outcome?.threadId === threadId ? outcome : null;
        const turnId = mine?.turnId ?? endTurnIds.get(threadId) ?? currentTurnId();
        return {
          key: `${turnId}:end`,
          reason: mine?.reason ?? (status === 'failed' ? 'error' : null),
          summary: status === 'failed' ? mine?.summary ?? null : null,
        };
      }
      default:
        return { key: '', reason: null };
    }
  }

  /** 미뤄 둔 알림 — 사이드바가 그사이 닫혔어도(보이지 않는 채팅이 끝나 닫힘) 보낸다. */
  function flushReports(): void {
    flushQueued = false;
    const ids = [...reportQueue];
    reportQueue.clear();
    const seenId = disposed ? null : deps.seenThreadId();
    for (const threadId of ids) {
      const status = getChatStatus(threadId);
      const { key, reason, summary } = reportKey(threadId, status);
      const { title, documentName } = deps.describe(threadId);
      deps.attention.report({
        threadId,
        status,
        key,
        seen: threadId === seenId,
        title,
        documentName,
        reason,
        label: status === 'failed' ? getChatStatusLabel(threadId) : null,
        summary: summary ?? null,
      });
    }
  }

  return {
    sync,

    /** turn-start — 이 채팅의 턴이 돈다. turnId 는 U4 턴 표식 id(없으면 새로 짓는다). */
    turnStarted(threadId: string, turnId: string | null): void {
      runThreadId = threadId;
      noticeTurnId = turnId ?? deps.createTurnId();
      ended = null;
      endTurnIds.delete(threadId);
      if (outcome?.threadId === threadId) outcome = null;
      sync();
    },

    /** 이미 도는 턴을 이 채팅에 다시 잇는다(새로고침 뒤 다시 붙이기, 질문으로 알게 된 턴). */
    adoptTurn(threadId: string, turnId?: string | null): void {
      runThreadId = threadId;
      if (turnId) noticeTurnId = turnId;
      sync();
    },

    /**
     * turn-end — 결과를 기록한다. 보던 채팅, 사용자가 멈춘 턴, 대기열이 다음 메시지를
     * 곧바로 보낸 턴(drained)은 결과를 남기지 않는다. 도는 턴을 닫았으면 true.
     */
    turnEnded(result: TurnOutcome, opts: { drained: boolean }): boolean {
      const threadId = runThreadId;
      runThreadId = null;
      if (threadId === null) {
        sync();
        return false;
      }
      const turnId = currentTurnId();
      const seen = deps.seenThreadId() === threadId;
      ended = { threadId, turnId, seen };
      endTurnIds.set(threadId, turnId);
      if (outcome?.threadId === threadId) outcome = null;
      const state = result === 'completed' ? 'finished' : result === 'failed' ? 'failed' : null;
      if (state && !seen && !opts.drained) {
        outcome = { threadId, state, label: null, summary: null, reason: state === 'failed' ? 'error' : null, turnId };
      }
      sync();
      return true;
    },

    /**
     * 방금 끝난 턴이 실패했거나 바깥 사정으로 끊겼다 — turn-end 와 같은 흐름에서 그 뒤에 부른다
     * (U5 turn-failure 의 이유, S3 의 중단). 알림은 아직 미뤄져 있으므로 이 이유를 싣는다.
     * 그 턴을 보고 있었으면 아무것도 남기지 않는다.
     */
    noteTurnFailure(note: TurnFailureNote = {}): void {
      if (disposed || !ended || ended.seen) return;
      const label = normalizeChatStatusLabel(note.label) ?? (note.interrupted ? '중단됨' : null);
      outcome = {
        threadId: ended.threadId,
        state: 'failed',
        label,
        summary: note.summary?.trim() || null,
        reason: note.interrupted ? 'interrupted' : 'error',
        turnId: ended.turnId,
      };
      sync();
    },

    /** 검토 대기 편집이 생겼다(set-finalized) — 그 턴을 돌린 채팅의 것이다. */
    reviewFinalized(threadId: string): void {
      review = { threadId, turnId: currentTurnId() };
      endTurnIds.set(threadId, review.turnId);
      sync();
    },

    /** 턴이 turn-end 없이 꺼졌다(중지·재연결·오류) — 노란 불을 걷는다. */
    settleIdle(): void {
      if (!deps.turnRunning()) runThreadId = null;
      sync();
    },

    /** 지금 보고 있는 채팅의 완료·오류 점을 걷고 배지에서 뺀다. 입력·검토 대기는 답해야 걷힌다. */
    markSeen(): void {
      if (disposed) return;
      const id = deps.seenThreadId();
      if (!id) return;
      if (ended?.threadId === id) ended.seen = true;
      const hadOutcome = outcome?.threadId === id;
      if (hadOutcome) outcome = null;
      const status = getChatStatus(id);
      if (status === 'finished' || status === 'failed') {
        setChatStatus(id, null);
        written.delete(id);
      }
      deps.attention.seen(id);
      if (hadOutcome) sync();
    },

    /** 공유 저장소가 바뀌었다 — 남이 걷은 결과를 놓는다. 쓰지는 않는다. */
    storeChanged(): void {
      dropOutcomeClearedElsewhere();
    },

    /**
     * 사이드바를 닫는다. 이 사이드바가 쓴 살아 있는 상태(작업·입력·검토)를 걷는다 — 바쁜 채로
     * 문서와 함께 닫힌 채팅의 점이 6시간 남지 않게. 미뤄 둔 알림은 그대로 나간다.
     */
    dispose(): void {
      if (disposed) return;
      disposed = true;
      const live = [...written]
        .filter(([id, mine]) => isLiveChatStatus(mine.status) && getChatStatus(id) === mine.status)
        .map(([id]) => id);
      releaseOwnedLiveStatuses(live);
    },
  };
}

export type RunStatusController = ReturnType<typeof createRunStatusController>;
