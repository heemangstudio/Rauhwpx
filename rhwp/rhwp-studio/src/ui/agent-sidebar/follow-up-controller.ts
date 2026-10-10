/**
 * 대기 메시지의 런타임 — 사이드바 하나가 지금 보이는 채팅의 대기열을 언제 보내고 언제 붙잡는지
 * 정한다. 순수 전이는 agent/follow-ups.ts, 그리기는 follow-up-strip.ts 가 맡고, 이 모듈은
 * 둘을 사이드바의 사건(turn-start·turn-end·허브 거절·채팅 전환)에 잇는다.
 *
 * 런타임 상태(지금 보내기·중지 요청·보낸 메시지)는 사이드바 메모리에만 산다. 저장되는 것은
 * 스레드의 대기열과 붙잡음뿐이고, 다시 열린 대기열은 언제나 붙잡힌 채로 돌아온다.
 *
 * 이 모듈은 브리지(agent/bridge.ts)를 싣지 않는다 — 사이드바 미리보기가 같은 코드를 쓴다.
 */
import {
  createFollowUpId,
  decideAfterTurn,
  edit as editItem,
  enqueue as enqueueItem,
  hold as holdQueue,
  isStranded,
  moveToHead,
  release as releaseQueue,
  remove as removeItem,
  requeueHead,
  storedFollowUps,
  followUpTurnOutcome,
  type FollowUpDecision,
  type FollowUpHold,
  type FollowUpHoldReason,
  type FollowUpItem,
  type FollowUpTurnOutcome,
  type ThreadFollowUps,
} from '../../agent/follow-ups.ts';
import type { ProductSkillIcon } from '../../agent/types.ts';
import type { FollowUpStrip } from './follow-up-strip.ts';

/**
 * 사용자 메시지가 어디서 나갔나 — 입력기, 대기열, 끊긴 작업 이어 가기(S3), 문서 위 인라인 프롬프트,
 * 실패 알림의 다시 시도·리셋 후 이어서(U5).
 */
export type ComposedMessageOrigin = 'composer' | 'queue' | 'resume' | 'inline' | 'retry';

/** 입력기·대기열·이어 가기·인라인 프롬프트가 함께 쓰는 보내기 한 건(sendComposedMessage 의 인자). */
export interface ComposedMessageSpec<Staged = never, Selection = never> {
  /** 기록·말풍선에 남을 본문. 템플릿 머리말은 보내는 순간에 붙는다. */
  text: string;
  skillName?: string;
  skillIcon?: ProductSkillIcon;
  /** 이 메시지에 붙여 보낼, 준비가 끝난 첨부. */
  staged?: readonly Staged[];
  origin: ComposedMessageOrigin;
  /** 허브의 거절을 이 메시지와 짝지을 receipt id 를 받는다. */
  requireReceipt?: boolean;
  /** 첨부와 함께 보내는 계획 수정 피드백 — 이 계획 머리말을 붙인다. */
  revisionPlanId?: string | null;
  /**
   * 이미 만든 요청문을 그대로 보낸다 — 템플릿·스킬·계획 머리말을 다시 만들지 않는다. 기록에는
   * displayText 가 남는다. 인라인 프롬프트(선택 맥락 블록)와 U5 의 다시 보내기가 쓴다.
   */
  wire?: { displayText: string; requestText: string };
  /** 기록에 붙는 문서 선택(인라인 프롬프트). */
  selection?: Selection;
  /** 취소되면 브리지가 아직 내보내지 않은 메시지를 버리고 sent 가 null 로 끝난다. */
  signal?: AbortSignal;
}

export interface ComposedMessageResult<Message, Bubble> {
  message: Message;
  bubble: Bubble;
  /** 브리지가 프레임을 내보내면 receipt id(또는 null 이 아닌 값), 버리면 null. */
  sent: Promise<string | null>;
}

export const FOLLOW_UP_HINTS = {
  full: '대기 메시지는 10개까지 둘 수 있어요',
  attachment: '첨부가 있는 메시지는 작업이 끝난 뒤 보낼 수 있어요',
  template: '템플릿은 작업이 끝난 뒤 고를 수 있어요',
} as const;
export type FollowUpHintKind = keyof typeof FOLLOW_UP_HINTS;

const QUEUED_ANNOUNCEMENT = '대기열에 넣었어요. 작업이 끝나면 보냅니다.';

export interface FollowUpControllerDeps<Message, Bubble> {
  strip: FollowUpStrip;
  /** 지금 보이는 채팅 스레드 — 대기열이 붙어 산다. */
  thread(): { followUps?: ThreadFollowUps };
  persist(): void;
  /** 대기 메시지 하나를 보낸다(sendComposedMessage, origin 'queue', receipt 필요). */
  send(item: FollowUpItem): ComposedMessageResult<Message, Bubble>;
  /** 허브가 받지 않은 메시지를 기록과 대화에서 걷는다. */
  unsend(message: Message, bubble: Bubble): void;
  interrupt(): void;
  isTurnRunning(): boolean;
  /** 턴이 돌거나, 보낸 메시지가 턴을 기다린다(turnRunning || replyPending). */
  isWorking(): boolean;
  /** 지금 보낼 수 없는 이유(단추 제목). null 이면 보낼 수 있다. */
  sendBlockedReason(): string | null;
  /** 다른 문서 채팅 열람처럼 대기열을 고칠 수 없다. */
  readOnly(): boolean;
  turnContext(): { planAwaitingApproval: boolean; engineTrapped: boolean; mergeLocked: boolean };
  /** Enter·Esc 로 편집을 마치면 입력기로 돌아간다. */
  focusComposer(): void;
  /** 대기열 모양이 바뀌었다 — 입력기 표시와 쌓인 높이를 다시 잰다. */
  onChange(): void;
  /**
   * 이 턴에 error 이벤트가 있었는가 — 사이드바가 턴 접힘(turnOutcomeFor)과 함께 쓰는 하나의 플래그.
   * 주지 않으면 agentError() 로 모은 이 컨트롤러의 플래그를 쓴다.
   */
  errorSeen?(): boolean;
  now?(): number;
}

interface Flight<Message, Bubble> {
  item: FollowUpItem;
  message: Message;
  bubble: Bubble;
  messageId: string | null;
  /** 브리지가 프레임을 내보냈다. */
  dispatched: boolean;
  sawTurnStart: boolean;
}

export interface FollowUpQueueInput {
  text: string;
  skillName?: string;
  skillIcon?: ProductSkillIcon;
}

export function createFollowUpController<Message, Bubble>(deps: FollowUpControllerDeps<Message, Bubble>) {
  const now = deps.now ?? (() => Date.now());
  /** 지금 보내기로 걸어 둔 항목. */
  let sendNowId: string | null = null;
  /** 이 턴의 중지는 사용자가 눌렀다. */
  let userStopRequested = false;
  /** 이 턴에 error 이벤트가 있었다(U4 의 errorSeen 과 같은 플래그). */
  let errorSeen = false;
  /** S2 가 새로고침 뒤 다시 잡은, 아직 도는 이 채팅의 턴 — 그 끝은 이 사이드바가 본다. */
  let liveTurnAdopted = false;
  let inFlight: Flight<Message, Bubble> | null = null;
  let editingId: string | null = null;
  /** 편집 중이라 미룬 보내기 차례. */
  let drainDeferred = false;

  function queue(): ThreadFollowUps | undefined {
    return deps.thread().followUps;
  }

  function items(): FollowUpItem[] {
    return queue()?.items ?? [];
  }

  function render(): void {
    const current = queue();
    deps.strip.render({
      items: current?.items ?? [],
      hold: current?.hold ?? null,
      readOnly: deps.readOnly(),
      sendBlockedTitle: deps.sendBlockedReason(),
      editingId,
    });
  }

  function commit(next: ThreadFollowUps): void {
    const thread = deps.thread();
    thread.followUps = storedFollowUps(next);
    const ids = new Set(next.items.map((item) => item.id));
    if (sendNowId !== null && !ids.has(sendNowId)) sendNowId = null;
    if (editingId !== null && !ids.has(editingId)) editingId = null;
    deps.persist();
    render();
    deps.onChange();
  }

  function holdWith(reason: FollowUpHoldReason, extra?: { detail?: string; code?: string }): void {
    if (items().length === 0) return;
    commit(holdQueue(queue(), reason, extra, now()));
  }

  function dispatch(id: string): void {
    const item = items().find((entry) => entry.id === id);
    if (!item) return;
    sendNowId = null;
    drainDeferred = false;
    // 보내는 것은 사용자의 보내기이거나 규칙이 허락한 정상 종료다 — 붙잡음도 걷는다.
    commit(releaseQueue(removeItem(queue(), id)));
    let result: ComposedMessageResult<Message, Bubble>;
    try {
      result = deps.send(item);
    } catch (error) {
      // 보내지 못했다 — 글을 잃지 않게 맨 앞으로 되돌려 붙잡는다.
      console.warn('[follow-ups] 대기 메시지를 보내지 못했습니다:', error);
      commit(holdQueue(requeueHead(queue(), item), 'failed', undefined, now()));
      return;
    }
    const flight: Flight<Message, Bubble> = {
      item,
      message: result.message,
      bubble: result.bubble,
      messageId: null,
      dispatched: false,
      sawTurnStart: false,
    };
    inFlight = flight;
    void result.sent.then((messageId) => {
      if (inFlight !== flight) return;
      if (messageId) {
        flight.messageId = messageId;
        flight.dispatched = true;
        return;
      }
      // 브리지가 버렸다(중지·채팅 시작 실패·취소) — 보낸 적 없는 것으로 되돌린다.
      bounce(flight, 'interrupted');
    });
  }

  /** 받지 않은 메시지를 대화에서 걷고 대기열 맨 앞에 되돌린 뒤 붙잡는다. */
  function bounce(flight: Flight<Message, Bubble>, reason: FollowUpHoldReason, code?: string): void {
    if (inFlight === flight) inFlight = null;
    deps.unsend(flight.message, flight.bubble);
    commit(holdQueue(requeueHead(queue(), flight.item), reason, code ? { code } : undefined, now()));
  }

  function apply(decision: FollowUpDecision): void {
    switch (decision.kind) {
      case 'dispatch':
        dispatch(decision.itemId);
        break;
      case 'hold':
        holdWith(decision.reason, decision.detail ? { detail: decision.detail } : undefined);
        break;
      case 'defer':
        drainDeferred = true;
        break;
      case 'none':
        break;
    }
  }

  function decide(outcome: FollowUpTurnOutcome): void {
    apply(decideAfterTurn(queue(), outcome, { ...deps.turnContext(), sendNowId, editingId }));
  }

  /**
   * 정착 지점(턴 끝·채팅 멈춤·연결·허브 오류)마다 부른다. 아무것도 이 대기열을 비우지 않을
   * 상태면 붙잡아 보이게 한다 — Studio 가 보지 못한 턴 끝 뒤에는 절대 저절로 보내지 않는다.
   */
  function settle(): void {
    const working = deps.isWorking();
    if (!working) {
      // 프레임까지 나간 메시지의 턴이 이제 돌지 않는다 — 끝났거나 사라졌다.
      if (inFlight?.dispatched) inFlight = null;
      // 걸어 둔 지금 보내기의 턴 끝을 보지 못했다. 항목은 이미 맨 앞에 있다.
      if (sendNowId !== null && !inFlight) sendNowId = null;
    }
    if (isStranded(queue(), { inFlight: inFlight !== null, sendNowId, working, drainDeferred })) {
      holdWith('interrupted');
      return;
    }
    render();
  }

  function afterEdit(): void {
    if (drainDeferred && !deps.isWorking() && inFlight === null) {
      drainDeferred = false;
      decide('normal');
    }
    settle();
  }

  function resetRuntime(): void {
    sendNowId = null;
    userStopRequested = false;
    errorSeen = false;
    liveTurnAdopted = false;
    inFlight = null;
    editingId = null;
    drainDeferred = false;
  }

  function sendNow(id: string): void {
    if (deps.readOnly() || !items().some((item) => item.id === id)) return;
    if (deps.isTurnRunning()) {
      if (deps.sendBlockedReason() !== null) return;
      commit(moveToHead(queue(), id));
      sendNowId = id;
      // 이 중지는 사용자가 보내려고 고른 것이다. 걸어 둔 항목이 사라지면 '멈춤'으로 남는다.
      userStopRequested = true;
      deps.interrupt();
      return;
    }
    if (deps.isWorking()) {
      // 보냈지만 턴이 아직 열리지 않았다 — 열리지 않은 턴을 멈추면 turn-end 가 오지 않는다.
      // 그 턴이 어떻게 끝나든 끝나면 이 항목을 보낸다.
      commit(moveToHead(queue(), id));
      sendNowId = id;
      return;
    }
    if (deps.sendBlockedReason() !== null) return;
    dispatch(id);
  }

  return {
    render,
    hasItems: () => items().length > 0,
    isEditing: () => editingId !== null,

    /** 입력기의 Enter(일하는 중) — 대기열 끝(atHead 면 맨 앞)에 넣는다. 가득 찼으면 null. */
    enqueue(input: FollowUpQueueInput, opts?: { atHead?: boolean }): FollowUpItem | null {
      const item: FollowUpItem = {
        id: createFollowUpId(),
        text: input.text,
        ...(input.skillName ? { skillName: input.skillName } : {}),
        ...(input.skillName && input.skillIcon ? { skillIcon: input.skillIcon } : {}),
        createdAt: now(),
      };
      const next = enqueueItem(queue(), item, opts);
      if (next === 'full') {
        deps.strip.showHint(FOLLOW_UP_HINTS.full);
        return null;
      }
      deps.strip.clearHint();
      commit(next);
      deps.strip.announce(QUEUED_ANNOUNCEMENT);
      return item;
    },
    sendNow,
    /** Ctrl/Cmd+Enter 에 빈 입력기 — 맨 앞 항목을 지금 보낸다. 대기열이 비었으면 false. */
    sendNowHead(): boolean {
      const head = items()[0];
      if (!head) return false;
      sendNow(head.id);
      return true;
    },
    /** 붙잡음 줄의 보내기. */
    resume(): void {
      const head = items()[0];
      if (head) sendNow(head.id);
    },
    removeItem(id: string): void {
      if (deps.readOnly()) return;
      if (editingId === id) editingId = null;
      commit(removeItem(queue(), id));
      settle();
    },
    startEdit(id: string): void {
      if (deps.readOnly() || !items().some((item) => item.id === id)) return;
      editingId = id;
      render();
    },
    commitEdit(id: string, text: string, viaKey: boolean): void {
      if (editingId !== id) return;
      editingId = null;
      commit(editItem(queue(), id, text));
      if (viaKey) deps.focusComposer();
      afterEdit();
    },
    cancelEdit(id: string): void {
      if (editingId !== id) return;
      editingId = null;
      render();
      deps.focusComposer();
      afterEdit();
    },
    hint(kind: FollowUpHintKind): void {
      deps.strip.showHint(FOLLOW_UP_HINTS[kind]);
    },
    clearHint(): void {
      deps.strip.clearHint();
    },

    /** 중지(입력기 단추·질문 카드). 나중의 뜻이 이긴다 — 걸어 둔 지금 보내기는 취소된다. */
    noteUserStop(): void {
      userStopRequested = true;
      sendNowId = null;
    },
    turnStarted(): void {
      if (inFlight) inFlight.sawTurnStart = true;
      userStopRequested = false;
      errorSeen = false;
    },
    /** 턴이 도는 동안의 error 이벤트 — deps.errorSeen 이 없을 때만 쓰인다. */
    agentError(): void {
      errorSeen = true;
    },
    /**
     * 턴이 끝났다. ownerIsCurrent 는 그 턴이 지금 보이는 채팅의 것인지다 — 다른 채팅의 턴 끝은
     * 이 대기열을 움직이지 않는다.
     */
    turnEnded(
      event: { stopReason?: unknown; errorMessage?: unknown },
      ownerIsCurrent: boolean,
      interruptionReason?: string | null,
    ): void {
      inFlight = null;
      const outcome: FollowUpTurnOutcome = followUpTurnOutcome(event, {
        errorSeen: deps.errorSeen ? deps.errorSeen() : errorSeen,
        userStopRequested,
        sendNowId,
        interruptionReason,
      });
      const owned = ownerIsCurrent || liveTurnAdopted;
      userStopRequested = false;
      errorSeen = false;
      liveTurnAdopted = false;
      if (owned) decide(outcome);
      settle();
    },
    /** 허브 오류. 보낸 대기 메시지의 거절이면 되돌리고 true — 일반 오류 줄은 띄우지 않는다. */
    hubError(error: { code: string; messageId?: string }): boolean {
      const flight = inFlight;
      if (!flight) return false;
      const matches = error.messageId
        ? error.messageId === flight.messageId
        // 예전 허브는 id 를 돌려주지 않는다 — 턴이 열리기 전의 AGENT_BUSY 만 이 메시지로 본다.
        : error.code === 'AGENT_BUSY' && !flight.sawTurnStart;
      if (!matches) return false;
      bounce(flight, error.code === 'AGENT_BUSY' ? 'busy' : 'rejected', error.code === 'AGENT_BUSY' ? undefined : error.code);
      return true;
    },
    /** 채팅이 멈췄다 — 보낸 메시지는 받아들여졌거나 채팅과 함께 버려졌다. */
    chatStopped(): void {
      inFlight = null;
      settle();
    },
    settle,

    /**
     * 채팅을 떠나기 전(전환·새 채팅·닫기). 떠나는 전환은 턴을 멈추므로 'stopped' 로 붙잡는다.
     * 사이드바를 닫을 때(창 닫기·새로고침)는 'interrupted' — 다시 열면 끊긴 작업으로 보인다.
     */
    detach(reason: 'stopped' | 'interrupted' = 'stopped'): void {
      // 브리지가 아직 내보내지 않은 대기 메시지는 채팅과 함께 버려진다 — 대기열로 되돌린다.
      if (inFlight && !inFlight.dispatched) {
        const flight = inFlight;
        inFlight = null;
        deps.unsend(flight.message, flight.bubble);
        commit(requeueHead(queue(), flight.item));
      }
      if (editingId !== null) {
        const text = deps.strip.editingText();
        const id = editingId;
        editingId = null;
        if (text !== null) commit(editItem(queue(), id, text));
      }
      const current = queue();
      resetRuntime();
      if (current?.items.length && !current.hold) holdWith(reason);
      else render();
      deps.strip.clearHint();
    },
    /** 다른 채팅을 열었다. 보지 못한 턴 끝 뒤이므로 대기열은 붙잡힌 채로 돌아온다. */
    attach(): void {
      resetRuntime();
      deps.strip.clearHint();
      const current = queue();
      if (current?.items.length && !current.hold) holdWith('interrupted');
      else render();
      deps.onChange();
    },

    // ── S3·U5 계약 ────────────────────────────────────────
    /**
     * 붙잡는다(이유 문구를 더한다). 비었으면 아무것도 하지 않는다. 이미 붙잡혀 있으면 이유를
     * 바꾼다 — 나중의 더 구체적인 설명이 이긴다. 바로 저장한다.
     */
    hold(reason: 'interrupted' | 'failed', detail?: string): void {
      holdWith(reason, detail ? { detail } : undefined);
    },
    /**
     * 보내지 않고 붙잡음만 푼다. 다음 정상 종료가 맨 앞을 보낸다. 이어 가기 메시지를
     * sendComposedMessage({ origin: 'resume' }) 로 보낸 바로 뒤, 같은 틱에 부른다.
     * 아무것도 보내지 않은 채 풀면 다음 정착 지점에서 다시 붙잡힌다.
     */
    release(): void {
      const current = queue();
      if (!current?.hold) return;
      commit(releaseQueue(current));
    },
    /**
     * 새로고침 뒤 S2 가 아직 도는 이 채팅의 턴을 다시 잡았다. 그 턴의 끝은 이 사이드바가 보므로
     * attach() 가 건 붙잡음을 풀고, 끝나면 보통 규칙대로 보내거나 붙잡는다.
     */
    adoptLiveTurn(): void {
      liveTurnAdopted = true;
      const current = queue();
      if (current?.hold) commit(releaseQueue(current));
    },
    snapshot(): { count: number; hold: FollowUpHold | null } {
      const current = queue();
      return { count: current?.items.length ?? 0, hold: current?.hold ?? null };
    },
  };
}

export type FollowUpController = ReturnType<typeof createFollowUpController>;
