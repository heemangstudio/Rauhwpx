/**
 * 대기 메시지 띠 — 입력기 바로 위에 대기열을 한 줄씩 보이고, 붙잡힌 이유와 보내기 동작을 둔다.
 * DOM 만 맡는다. 브리지나 스레드는 모르고, 사용자의 손길은 콜백으로만 알린다.
 */
import type { FollowUpHold, FollowUpItem } from '../../agent/follow-ups.ts';
import { createIcon } from './icons.ts';
import { skillGlyphForSkill } from './skill-presentation.ts';

export interface FollowUpStripView {
  items: readonly FollowUpItem[];
  hold: FollowUpHold | null;
  /** 다른 문서 채팅 열람처럼 대기열을 고칠 수 없다 — 모든 단추를 잠근다. */
  readOnly: boolean;
  /** 보내기·지금 보내기를 막는 이유(단추 제목). null 이면 보낼 수 있다. */
  sendBlockedTitle: string | null;
  /** 고치고 있는 항목. */
  editingId: string | null;
  /**
   * 계획이 지금 승인을 기다린다. 아니면(승인·실행·수정으로 넘어갔다) 'plan-approval' 붙잡음은 계획을
   * 다듬는 동안 쓴 메시지라는 중립 문구로 보인다 — 저절로 풀지 않는다(계획에 대한 의견이었다).
   * 주지 않으면 기다리는 것으로 본다.
   */
  planAwaitingApproval?: boolean;
}

export interface FollowUpStripOptions {
  isMac: boolean;
  skillDisplayName(name: string): string;
  /** 붙잡음 줄의 보내기 — 맨 앞 항목을 지금 보낸다. */
  onResume(): void;
  onSendNow(id: string): void;
  onRemove(id: string): void;
  onEditStart(id: string): void;
  /** 편집을 마쳤다. 빈 본문은 지우라는 뜻이다. viaKey 는 Enter 로 마쳤는지. */
  onEditCommit(id: string, text: string, viaKey: boolean): void;
  onEditCancel(id: string): void;
}

export interface FollowUpStrip {
  root: HTMLElement;
  render(view: FollowUpStripView): void;
  /** 화면 읽기 프로그램에 알린다. */
  announce(message: string): void;
  /** 다음 입력까지 보이는 한 줄 안내(대기열에 넣지 못한 이유). */
  showHint(message: string): void;
  clearHint(): void;
  /** 열린 편집기의 지금 본문(없으면 null). */
  editingText(): string | null;
}

/**
 * 붙잡힌 이유 문구. detail 이 있으면 앞에 붙인다. planAwaitingApproval 이 거짓이면 계획 승인 붙잡음은
 * 더 기다리는 것이 없으므로 그 메시지가 언제 쓰였는지만 말한다.
 */
export function followUpHoldCopy(hold: FollowUpHold, opts: { planAwaitingApproval?: boolean } = {}): string {
  const prefix = hold.detail ? `${hold.detail} · ` : '';
  switch (hold.reason) {
    case 'stopped': return `${prefix}작업을 멈춰서 대기 메시지를 보내지 않았어요`;
    case 'failed': return `${prefix}작업이 오류로 끝나 대기 메시지를 보내지 않았어요`;
    case 'interrupted': return `${prefix}작업이 끊겨 대기 메시지를 보내지 않았어요`;
    case 'plan-approval':
      return opts.planAwaitingApproval === false
        ? `${prefix}계획을 다듬는 동안 쓴 메시지라 저절로 보내지 않았어요`
        : `${prefix}계획 승인을 기다리고 있어 대기 메시지를 보내지 않았어요`;
    case 'blocked': return `${prefix}병합 검토 중이라 대기 메시지를 보내지 않았어요`;
    case 'busy': return '에이전트가 다른 작업을 먼저 시작했어요. 끝나면 보낼게요';
    case 'rejected': return `${prefix}허브가 메시지를 받지 않았어요${hold.code ? ` (${hold.code})` : ''}`;
  }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** 같은 글이면 건드리지 않는다 — 입력기를 갱신할 때마다 그리므로 쓸데없는 변경을 만들지 않는다. */
function setText(node: HTMLElement, text: string): void {
  if (node.textContent !== text) node.textContent = text;
}

function iconButton(className: string, label: string, icon: Parameters<typeof createIcon>[0]): HTMLButtonElement {
  const button = el('button', `ag-followup-action ${className}`);
  button.type = 'button';
  button.setAttribute('aria-label', label);
  button.title = label;
  button.appendChild(createIcon(icon));
  return button;
}

interface RowRefs {
  li: HTMLLIElement;
  index: HTMLSpanElement;
  skill: HTMLSpanElement;
  skillName: string | null;
  text: HTMLSpanElement;
  sendNow: HTMLButtonElement;
  edit: HTMLButtonElement;
  remove: HTMLButtonElement;
  editor: HTMLTextAreaElement | null;
}

let stripSeq = 0;

export function createFollowUpStrip(options: FollowUpStripOptions): FollowUpStrip {
  const prefix = `ag-followups-${++stripSeq}`;
  const root = el('section', 'ag-followups');
  root.hidden = true;

  const holdLine = el('p', 'ag-followups-hold');
  holdLine.setAttribute('role', 'status');
  holdLine.hidden = true;
  const holdIcon = el('span', 'ag-followups-hold-icon');
  holdIcon.setAttribute('aria-hidden', 'true');
  holdIcon.appendChild(createIcon('pause'));
  const holdText = el('span', 'ag-followups-hold-text');
  const resume = el('button', 'ag-followups-resume', '보내기');
  resume.type = 'button';
  resume.addEventListener('click', () => options.onResume());
  holdLine.append(holdIcon, holdText, resume);

  const hint = el('p', 'ag-followups-hint');
  hint.hidden = true;

  const list = el('ol', 'ag-followups-list');
  const live = el('span', 'ag-sr-only');
  live.setAttribute('aria-live', 'polite');
  live.setAttribute('aria-atomic', 'true');
  root.append(holdLine, hint, list, live);

  const rows = new Map<string, RowRefs>();
  let view: FollowUpStripView = { items: [], hold: null, readOnly: false, sendBlockedTitle: null, editingId: null };
  const sendNowTitle = `지금 보내기 (${options.isMac ? '⌘⏎' : 'Ctrl+Enter'})`;

  function syncHidden(): void {
    root.hidden = view.items.length === 0 && hint.hidden;
  }

  function openEditor(row: RowRefs, item: FollowUpItem): void {
    if (row.editor) return;
    const editor = el('textarea', 'ag-followup-edit');
    editor.setAttribute('aria-label', '대기 메시지 수정');
    editor.rows = 1;
    editor.value = item.text;
    let closed = false;
    const close = (commit: boolean, viaKey: boolean): void => {
      if (closed) return;
      closed = true;
      if (commit) options.onEditCommit(item.id, editor.value, viaKey);
      else options.onEditCancel(item.id);
    };
    editor.addEventListener('keydown', (event) => {
      // 한글 조합 중의 Enter 는 글자를 확정할 뿐이다.
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        close(true, true);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        close(false, true);
      }
    });
    editor.addEventListener('blur', () => close(true, false));
    const fit = (): void => {
      editor.style.height = 'auto';
      editor.style.height = `${editor.scrollHeight}px`;
    };
    editor.addEventListener('input', fit);
    row.editor = editor;
    row.text.replaceWith(editor);
    row.li.classList.add('ag-editing');
    fit();
    editor.focus({ preventScroll: true });
    editor.setSelectionRange(editor.value.length, editor.value.length);
  }

  function closeEditor(row: RowRefs): void {
    if (!row.editor) return;
    const editor = row.editor;
    row.editor = null;
    row.li.classList.remove('ag-editing');
    editor.replaceWith(row.text);
  }

  function createRow(item: FollowUpItem): RowRefs {
    const li = el('li', 'ag-followup');
    li.dataset.followUpId = item.id;
    const index = el('span', 'ag-followup-index');
    index.setAttribute('aria-hidden', 'true');
    const skill = el('span', 'ag-skill-token ag-followup-skill');
    skill.hidden = true;
    const text = el('span', 'ag-followup-text');
    text.id = `${prefix}-${rows.size}-${item.id}`;
    const sendNow = iconButton('ag-followup-send-now', '지금 보내기', 'send');
    sendNow.title = sendNowTitle;
    const edit = iconButton('ag-followup-edit-btn', '수정', 'pencil');
    const remove = iconButton('ag-followup-remove', '삭제', 'close');
    for (const button of [sendNow, edit, remove]) button.setAttribute('aria-describedby', text.id);
    const id = item.id;
    sendNow.addEventListener('click', () => options.onSendNow(id));
    edit.addEventListener('click', () => options.onEditStart(id));
    remove.addEventListener('click', () => options.onRemove(id));
    li.append(index, skill, text, sendNow, edit, remove);
    return { li, index, skill, skillName: null, text, sendNow, edit, remove, editor: null };
  }

  function updateRow(row: RowRefs, item: FollowUpItem, position: number): void {
    setText(row.index, String(position + 1));
    if (row.skillName !== (item.skillName ?? null)) {
      row.skillName = item.skillName ?? null;
      row.skill.replaceChildren();
      row.skill.hidden = !item.skillName;
      if (item.skillName) {
        const icon = el('span', 'ag-skill-token-icon');
        icon.appendChild(createIcon(skillGlyphForSkill({ name: item.skillName, icon: item.skillIcon })));
        row.skill.append(icon, el('span', 'ag-skill-token-name', options.skillDisplayName(item.skillName)));
        row.skill.title = `/${item.skillName}`;
      }
    }
    // 줄바꿈은 한 줄 미리보기에서 칸 하나로 접는다. 전체 본문은 제목으로 남긴다.
    setText(row.text, item.text.replace(/\s*\n+\s*/g, ' '));
    if (row.text.title !== item.text) row.text.title = item.text;
    const locked = view.readOnly;
    const sendBlocked = locked || view.sendBlockedTitle !== null;
    row.sendNow.disabled = sendBlocked;
    row.sendNow.title = !locked && view.sendBlockedTitle ? view.sendBlockedTitle : sendNowTitle;
    row.edit.disabled = locked;
    row.remove.disabled = locked;
    if (view.editingId === item.id && !locked) openEditor(row, item);
    else closeEditor(row);
  }

  function render(next: FollowUpStripView): void {
    view = next;
    const ids = new Set(next.items.map((item) => item.id));
    for (const [id, row] of rows) {
      if (ids.has(id)) continue;
      closeEditor(row);
      row.li.remove();
      rows.delete(id);
    }
    next.items.forEach((item, position) => {
      let row = rows.get(item.id);
      if (!row) {
        row = createRow(item);
        rows.set(item.id, row);
      }
      // 제자리에 있는 행은 옮기지 않는다 — 편집 중인 입력칸이 초점을 잃지 않게.
      const expected = list.children[position] ?? null;
      if (expected !== row.li) list.insertBefore(row.li, expected);
      updateRow(row, item, position);
    });
    const label = `대기 중인 메시지 ${next.items.length}개`;
    if (root.getAttribute('aria-label') !== label) root.setAttribute('aria-label', label);
    if (next.hold && next.items.length > 0) {
      holdLine.hidden = false;
      holdLine.dataset.reason = next.hold.reason;
      setText(holdText, followUpHoldCopy(next.hold, { planAwaitingApproval: next.planAwaitingApproval }));
      resume.disabled = next.readOnly || next.sendBlockedTitle !== null;
      resume.title = !next.readOnly && next.sendBlockedTitle ? next.sendBlockedTitle : '대기 메시지 보내기';
      root.dataset.hold = next.hold.reason;
    } else {
      holdLine.hidden = true;
      delete holdLine.dataset.reason;
      delete root.dataset.hold;
    }
    syncHidden();
  }

  function announce(message: string): void {
    live.textContent = '';
    queueMicrotask(() => { live.textContent = message; });
  }

  return {
    root,
    render,
    announce,
    showHint(message: string): void {
      hint.textContent = message;
      hint.hidden = false;
      syncHidden();
      announce(message);
    },
    clearHint(): void {
      if (hint.hidden) return;
      hint.hidden = true;
      hint.textContent = '';
      syncHidden();
    },
    editingText(): string | null {
      for (const row of rows.values()) if (row.editor) return row.editor.value;
      return null;
    },
  };
}
