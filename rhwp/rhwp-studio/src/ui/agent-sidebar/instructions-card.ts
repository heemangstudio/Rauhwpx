/**
 * 지시(AGENTS.md) 변경안 카드 — 에이전트가 update_agent_instructions 로 만든 초안을 대화 흐름에서 바로
 * 승인·거절한다. 브라우저 요청 카드(request-card.ts)와 같은 면을 쓰고, 정착하면 한 줄로 접힌다.
 * 설정 → 지시의 변경안 카드와 같은 초안이다. 어느 쪽에서 답해도 허브의 cleared 알림으로 둘 다 정착한다.
 */
import type { AgentInstructionsDraft } from '../../agent/types.ts';
import './request-card.css';
import { createIcon } from './icons.ts';

export type InstructionsDraftOutcome = 'confirmed' | 'rejected' | 'expired' | 'replaced' | 'stale';

export interface InstructionsCardOptions {
  draft: AgentInstructionsDraft;
  /** 지금 AGENTS.md. 모르면 null — 초안의 줄을 모두 새 줄로 보인다. */
  current: string | null;
  confirm(draft: AgentInstructionsDraft): Promise<boolean>;
  reject(draft: AgentInstructionsDraft): Promise<boolean>;
}

export interface InstructionsCard {
  root: HTMLElement;
  settle(outcome: InstructionsDraftOutcome): void;
}

const OUTCOME_LABEL: Record<InstructionsDraftOutcome, string> = {
  confirmed: '승인됨',
  rejected: '거절됨',
  expired: '만료됨',
  replaced: '새 제안으로 바뀜',
  stale: '지시가 바뀌어 취소됨',
};

const MAX_LINES = 6;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** 더한 줄과 뺀 줄. 빈 줄은 세지 않는다. */
export function instructionLineChanges(current: string, next: string): { added: string[]; removed: string[] } {
  const lines = (text: string) => text.split('\n').map((line) => line.trim()).filter(Boolean);
  const before = lines(current);
  const after = lines(next);
  const had = new Set(before);
  const has = new Set(after);
  return {
    added: after.filter((line) => !had.has(line)),
    removed: before.filter((line) => !has.has(line)),
  };
}

export function createInstructionsCard(options: InstructionsCardOptions): InstructionsCard {
  const { draft } = options;
  const root = el('section', 'ag-request-card');
  root.dataset.kind = 'instructions';
  let busy = false;
  let error = '';
  let outcome: InstructionsDraftOutcome | null = null;

  function changeList(): HTMLElement {
    const { added, removed } = instructionLineChanges(options.current ?? '', draft.content);
    const rows = [
      ...added.map((text) => ({ text, icon: 'insert' as const })),
      ...removed.map((text) => ({ text, icon: 'delete' as const })),
    ];
    const list = el('ul', 'ag-request-items');
    for (const row of rows.slice(0, MAX_LINES)) {
      const item = el('li', 'ag-request-item');
      if (row.icon === 'delete') item.dataset.blocked = 'true';
      item.append(createIcon(row.icon), el('span', 'ag-request-item-label', row.text));
      list.append(item);
    }
    if (rows.length > MAX_LINES) list.append(el('li', 'ag-request-item ag-request-item-more', `외 ${rows.length - MAX_LINES}줄`));
    return list;
  }

  async function answer(approve: boolean): Promise<void> {
    if (busy || outcome) return;
    busy = true;
    error = '';
    render();
    const ok = await (approve ? options.confirm(draft) : options.reject(draft)).catch(() => false);
    busy = false;
    // 성공하면 허브의 cleared 알림이 settle 을 부른다.
    if (!ok && !outcome) error = approve ? '지시를 저장하지 못했습니다.' : '변경안을 거절하지 못했습니다.';
    render();
  }

  function render(): void {
    if (outcome) {
      root.dataset.settled = 'true';
      const mark = el('span', 'ag-request-mark ag-request-mark-small');
      mark.append(createIcon(outcome === 'confirmed' ? 'check' : 'close'));
      root.setAttribute('aria-label', `지시 변경 ${OUTCOME_LABEL[outcome]}`);
      root.replaceChildren(mark, el('span', 'ag-request-done-label', '지시 변경'), el('span', 'ag-request-done-status', OUTCOME_LABEL[outcome]));
      return;
    }
    const head = el('div', 'ag-request-head');
    const mark = el('span', 'ag-request-mark');
    mark.append(createIcon('book'));
    head.append(mark, el('span', 'ag-request-host', 'AGENTS.md'));
    const title = el('h4', 'ag-request-title', '지시를 바꾸려고 합니다');
    if (draft.reason) title.title = draft.reason;
    const nodes: HTMLElement[] = [head, title, changeList()];
    if (error) {
      const row = el('div', 'ag-request-error');
      row.append(createIcon('warning'), el('span', 'ag-request-error-text', error));
      nodes.push(row);
    }
    const actions = el('div', 'ag-request-actions');
    const reject = el('button', 'ag-request-secondary');
    reject.type = 'button';
    reject.append(el('span', '', '거절'));
    reject.setAttribute('aria-label', '지시 변경 거절');
    reject.disabled = busy;
    reject.addEventListener('click', () => void answer(false));
    const approve = el('button', 'ag-request-primary');
    approve.type = 'button';
    approve.append(el('span', '', '승인'));
    approve.setAttribute('aria-label', '지시 변경 승인');
    approve.disabled = busy;
    if (busy) {
      approve.dataset.busy = 'true';
      approve.prepend(el('span', 'ag-request-spinner'));
    }
    approve.addEventListener('click', () => void answer(true));
    actions.append(reject, approve);
    nodes.push(actions);
    delete root.dataset.settled;
    root.setAttribute('aria-label', '지시를 바꾸려고 합니다');
    root.replaceChildren(...nodes);
  }

  render();
  return {
    root,
    settle(next) {
      if (outcome) return;
      outcome = next;
      busy = false;
      render();
    },
  };
}
