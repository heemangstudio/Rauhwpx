/**
 * 사용자 메시지(요청)의 "이 작업 전으로 되돌리기" 동작.
 *
 * 그 요청이 시작한 턴이 문서에 남긴 것이 있으면 말풍선 왼쪽에 작은 되돌리기 버튼이 붙는다
 * (호버·키보드 포커스 때 보인다). 되돌릴 수 없는 까닭이 있으면 버튼은 흐리게 남고 누르면 그
 * 까닭을 알린다. 상태 판단과 실제 되돌리기는 편집기가 넘긴 TurnRestoreControl 이 한다.
 */
import { createIcon } from './icons.ts';
import { confirmSheet } from './sheet.ts';
import { showToast } from '../toast.ts';
import type {
  TurnRestoreControl,
  TurnRestoreRefusal,
} from '../../agent/turn-checkpoints.ts';

export const TURN_RESTORE_LABEL = '이 작업 전으로 되돌리기';

const TOAST_MS = 3600;

const REFUSAL_TEXT: Record<Exclude<TurnRestoreRefusal, 'failed'>, string> = {
  running: '에이전트가 작업하는 동안에는 되돌릴 수 없어요. 작업이 끝난 뒤 다시 시도하세요.',
  'review-pending': '검토 대기 중인 변경이 있어요. 먼저 수락하거나 거절해 주세요.',
  'read-only': '읽기 전용 문서라 되돌릴 수 없어요.',
  engine: '문서 엔진이 멈춰 되돌릴 수 없어요.',
  hidden: '이 문서가 화면에 열려 있을 때만 되돌릴 수 있어요.',
  unavailable: '이 요청에는 되돌릴 작업이 남아 있지 않아요.',
  evicted: '오래된 작업이라 되돌릴 시점이 남아 있지 않아요. 버전 기록에서 이전 버전을 확인해 보세요.',
  'document-replaced': '문서를 다시 열어서 이 작업 전 상태가 남아 있지 않아요.',
  superseded: '이 작업이 시작될 때 검토 중이던 변경을 나중에 거절해서, 이 시점으로는 되돌릴 수 없어요.',
  'capture-failed': '이 작업 전 상태를 저장하지 못해 되돌릴 수 없어요.',
};

/** 되돌리기를 거절한 까닭을 사용자에게 보일 문장으로. */
export function turnRestoreRefusalText(reason: TurnRestoreRefusal, error?: string): string {
  if (reason === 'failed') return `되돌리지 못했습니다: ${error ?? '알 수 없는 오류'}`;
  return REFUSAL_TEXT[reason];
}

export interface TurnRestoreActionsOptions {
  control: TurnRestoreControl;
  /** 지금 보이는 대화의 스레드 */
  threadId(): string;
  /** 병합 검토처럼 누름을 아예 무시해야 하는가 (작업 중·검토 대기는 까닭을 알린다) */
  locked(): boolean;
  /** 되돌린 뒤 — 알림, 입력칸 채우기, 다음 요청의 안내를 사이드바가 한다. */
  restored(messageKey: string): void;
}

export interface TurnRestoreActions {
  /** 말풍선 하나의 버튼을 상태에 맞춘다 (말풍선에 data-turn-key 가 있을 때). */
  sync(bubble: HTMLElement): void;
  /** 대화에 그려진 모든 사용자 말풍선을 맞춘다. */
  syncAll(container: ParentNode): void;
}

export function createTurnRestoreActions(options: TurnRestoreActionsOptions): TurnRestoreActions {
  const buttons = new WeakMap<HTMLElement, HTMLButtonElement>();
  let confirming = false;

  function buttonFor(bubble: HTMLElement): HTMLButtonElement {
    const existing = buttons.get(bubble);
    if (existing) return existing;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'ag-msg-restore';
    button.setAttribute('aria-label', TURN_RESTORE_LABEL);
    button.appendChild(createIcon('undo'));
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      void activate(bubble, button);
    });
    buttons.set(bubble, button);
    return button;
  }

  function sync(bubble: HTMLElement): void {
    const key = bubble.dataset.turnKey;
    const status = key ? options.control.status(options.threadId(), key) : { kind: 'none' as const };
    const existing = buttons.get(bubble);
    if (status.kind === 'none') {
      existing?.remove();
      return;
    }
    const button = existing ?? buttonFor(bubble);
    const blocked = status.kind === 'blocked';
    const title = blocked ? turnRestoreRefusalText(status.reason) : TURN_RESTORE_LABEL;
    button.title = title;
    button.setAttribute('aria-label', blocked ? `${TURN_RESTORE_LABEL}: ${title}` : TURN_RESTORE_LABEL);
    if (blocked) button.setAttribute('aria-disabled', 'true');
    else button.removeAttribute('aria-disabled');
    if (button.parentElement !== bubble) bubble.appendChild(button);
  }

  async function activate(bubble: HTMLElement, button: HTMLButtonElement): Promise<void> {
    const key = bubble.dataset.turnKey;
    if (!key || confirming || options.locked()) return;
    const threadId = options.threadId();
    const status = options.control.status(threadId, key);
    if (status.kind === 'none') {
      sync(bubble);
      return;
    }
    if (status.kind === 'blocked') {
      showToast({ message: turnRestoreRefusalText(status.reason), durationMs: TOAST_MS });
      return;
    }
    if (status.alreadyRestored) {
      showToast({ message: '이미 이 작업 전 상태입니다.', durationMs: TOAST_MS });
      return;
    }
    // 작업 중·검토 대기처럼 지금 할 수 없으면 확인을 묻기 전에 까닭부터 알린다.
    const precheck = options.control.check(threadId, key);
    if (!precheck.ok) {
      showToast({ message: turnRestoreRefusalText(precheck.reason, precheck.error), durationMs: TOAST_MS });
      return;
    }
    if (status.laterEdits) {
      confirming = true;
      let confirmed = false;
      try {
        confirmed = await confirmSheet(
          button,
          '이 작업 전으로 되돌릴까요?',
          '이 작업 뒤에 바뀐 내용도 함께 사라집니다. 직접 고친 내용과 다른 채팅의 변경도 포함됩니다.',
          { confirmLabel: '되돌리기', destructive: true },
        );
      } finally {
        confirming = false;
      }
      // 확인하는 사이 다른 대화로 옮겼으면 하지 않는다. 그사이 시작된 작업은 restore 가 다시 거절한다.
      if (!confirmed || options.locked() || options.threadId() !== threadId) return;
    }
    const result = options.control.restore(threadId, key);
    if (!result.ok) {
      showToast({ message: turnRestoreRefusalText(result.reason, result.error), durationMs: TOAST_MS });
      return;
    }
    options.restored(key);
  }

  return {
    sync,
    syncAll(container) {
      for (const bubble of container.querySelectorAll<HTMLElement>('.ag-msg-user[data-turn-key]')) sync(bubble);
    },
  };
}
