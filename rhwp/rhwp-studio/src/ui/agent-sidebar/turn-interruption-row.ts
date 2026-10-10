/**
 * 끊긴 턴의 한 줄 — 턴이 멈춘 자리(그 턴의 마지막 내용 뒤)에 왜 멈췄는지 말하고, 그 채팅의 마지막
 * 턴이면 이어서 진행 단추 하나를 둔다. 시스템 줄 집안(.ag-msg-system)이라 턴 접힘에 들지 않고
 * 흐름에 남는다. 스스로 초점을 가져가지 않는다 — 단추는 Tab 으로 닿는다.
 *
 * 그리기만 한다. 언제 단추를 보이고 막을지는 사이드바(index.ts)가 정해 update 로 넘긴다.
 */
import {
  INTERRUPTION_NOTICE,
  type TurnInterruptionReason,
} from '../../agent/turn-interruption-reason.ts';

export const RESUME_BUTTON_LABEL = '이어서 진행';
export const RESUME_BLOCKED_TITLE = '허브에 연결되면 이어서 진행할 수 있어요';

export interface TurnInterruptionRowState {
  reason: TurnInterruptionReason;
  /** 이어서 진행 단추를 둔다 — 채팅의 마지막 끊김이고 아직 아무도 이어 가지 않았으며 고칠 수 있는 채팅. */
  actionable: boolean;
  /** 단추를 지금 누를 수 없는 이유(제목). null 이면 누를 수 있다. */
  blockedReason: string | null;
  /** 붙잡힌 대기 메시지 수 — 있으면 이어서 진행한 뒤 보낸다고 알린다. */
  queued: number;
}

export interface TurnInterruptionRow {
  readonly root: HTMLElement;
  readonly markerId: string;
  update(state: TurnInterruptionRowState): void;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function queuedFollowUpsText(count: number): string {
  return `대기 메시지 ${count}개는 이어서 진행한 뒤 보내요`;
}

export function createTurnInterruptionRow(
  markerId: string,
  opts: { onResume(): void },
): TurnInterruptionRow {
  const root = el('div', 'ag-msg ag-msg-system ag-turn-interrupted');
  root.setAttribute('role', 'group');
  root.setAttribute('aria-label', '중단된 작업');
  root.dataset.turnId = markerId;
  const text = el('span', 'ag-turn-interrupted-text');
  const queue = el('span', 'ag-turn-interrupted-queue');
  queue.hidden = true;
  const resume = el('button', 'ag-turn-interrupted-resume', RESUME_BUTTON_LABEL);
  resume.type = 'button';
  resume.hidden = true;
  // 막힌 단추도 초점은 받는다(aria-disabled) — 실제로 보낼 수 있는지는 누를 때 사이드바가 다시 본다.
  resume.addEventListener('click', () => {
    if (resume.getAttribute('aria-disabled') === 'true') return;
    opts.onResume();
  });
  root.append(text, queue, resume);
  return {
    root,
    markerId,
    update(state) {
      root.dataset.reason = state.reason;
      if (text.textContent !== INTERRUPTION_NOTICE[state.reason]) text.textContent = INTERRUPTION_NOTICE[state.reason];
      const showQueue = state.actionable && state.queued > 0;
      queue.hidden = !showQueue;
      if (showQueue) queue.textContent = queuedFollowUpsText(state.queued);
      resume.hidden = !state.actionable;
      if (!state.actionable) {
        resume.removeAttribute('aria-disabled');
        resume.removeAttribute('title');
        return;
      }
      if (state.blockedReason) {
        resume.setAttribute('aria-disabled', 'true');
        resume.title = state.blockedReason;
      } else {
        resume.removeAttribute('aria-disabled');
        resume.removeAttribute('title');
      }
    },
  };
}
