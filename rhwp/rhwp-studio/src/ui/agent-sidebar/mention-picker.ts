/**
 * 입력칸의 `@` 멘션 선택기. 슬래시 메뉴와 같은 목록 모양·키 동작을 쓰고,
 * 고른 항목은 글자로 넣지 않고 onPick 으로 돌려준다 — 입력기는 그 항목을
 * 첨부 줄의 칩으로 보여 주고 메시지에 `mentions:[itemId]` 로 실어 보낸다.
 *
 * 한글 조합 중에는 목록을 바꾸지 않는다. 조합이 끝난 input 에서 다시 거른다.
 */

import './mention-picker.css';
import type { ProjectItem } from '../../agent/types.ts';
import { fuzzyTemplateScore } from './template-fuzzy.ts';
import { itemIconName, projectIcon } from './project/project-ui.ts';

export interface MentionPickerOptions {
  textarea: HTMLTextAreaElement;
  /** 지금 프로젝트의 항목 (휴지통 제외). 열 때마다 다시 읽는다. */
  getItems: () => readonly ProjectItem[];
  /** 열 id → 열 이름. 없으면 열을 표시하지 않는다. */
  columnName?: (columnId: string) => string | null;
  onPick: (item: ProjectItem) => void;
  /** 목록을 붙일 곳. 기본은 입력기(.ag-composer) — 슬래시 메뉴와 같은 자리다. */
  mount?: HTMLElement;
}

export interface MentionPicker {
  readonly element: HTMLElement;
  isOpen(): boolean;
  close(): void;
  /** 항목이 바뀌었을 때 열린 목록을 다시 거른다. */
  refresh(): void;
  destroy(): void;
}

interface Trigger {
  /** `@` 위치. */
  start: number;
  /** 커서 위치. */
  end: number;
  query: string;
}

const MAX_QUERY = 40;
const MAX_OPTIONS = 50;
let pickerCount = 0;

/** 커서 바로 앞의 `@검색어` 를 찾는다. `@` 는 줄 처음이나 공백·여는 괄호 뒤에만 온다. */
export function mentionTrigger(value: string, caret: number): Trigger | null {
  let index = caret - 1;
  while (index >= 0 && caret - index <= MAX_QUERY + 1) {
    const ch = value[index]!;
    if (ch === '@') {
      const before = value[index - 1];
      if (before !== undefined && !/[\s([{"'“‘]/u.test(before)) return null;
      return { start: index, end: caret, query: value.slice(index + 1, caret) };
    }
    if (/\s/u.test(ch)) return null;
    index -= 1;
  }
  return null;
}

/** 제목과 태그로 거른다. 제목 일치가 태그 일치보다 앞선다. */
export function rankMentionItems(items: readonly ProjectItem[], query: string): ProjectItem[] {
  const live = items.filter((item) => !item.trashedAt);
  if (!query.trim()) {
    // 검색어가 없으면 고정한 항목, 그다음 최근에 바뀐 항목 순이다.
    return [...live]
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt)
      .slice(0, MAX_OPTIONS);
  }
  return live
    .map((item) => {
      const title = fuzzyTemplateScore(item.title, query);
      const tag = item.tags.reduce<number | null>((best, name) => {
        const score = fuzzyTemplateScore(name, query);
        return score === null ? best : Math.max(best ?? -Infinity, score - 5_000);
      }, null);
      const score = title === null ? tag : tag === null ? title : Math.max(title, tag);
      return { item, score };
    })
    .filter((row): row is { item: ProjectItem; score: number } => row.score !== null)
    .sort((a, b) => b.score - a.score
      || Number(b.item.pinned) - Number(a.item.pinned)
      || b.item.updatedAt - a.item.updatedAt
      || a.item.title.localeCompare(b.item.title, 'ko'))
    .slice(0, MAX_OPTIONS)
    .map((row) => row.item);
}

export function createMentionPicker(options: MentionPickerOptions): MentionPicker {
  const { textarea } = options;
  const id = `ag-mention-menu-${++pickerCount}`;
  const menu = document.createElement('div');
  menu.className = 'ag-slash-menu ag-mention-menu';
  menu.id = id;
  menu.hidden = true;
  menu.setAttribute('role', 'listbox');
  menu.setAttribute('aria-label', '프로젝트 항목');
  const mount = options.mount ?? textarea.closest<HTMLElement>('.ag-composer') ?? textarea.parentElement;
  mount?.append(menu);

  let trigger: Trigger | null = null;
  let rows: ProjectItem[] = [];
  let active = 0;
  let composing = false;
  /** Esc 로 닫은 `@` 위치. 같은 자리에서는 다시 열지 않는다. */
  let dismissedAt: number | null = null;

  function setOpen(open: boolean): void {
    menu.hidden = !open;
    const controls = new Set((textarea.getAttribute('aria-controls') ?? '').split(/\s+/u).filter(Boolean));
    if (open) {
      controls.add(id);
      textarea.setAttribute('aria-expanded', 'true');
      textarea.setAttribute('aria-activedescendant', `${id}-${active}`);
    } else {
      controls.delete(id);
      if (textarea.getAttribute('aria-activedescendant')?.startsWith(id)) {
        textarea.removeAttribute('aria-activedescendant');
        textarea.setAttribute('aria-expanded', 'false');
      }
    }
    if (controls.size) textarea.setAttribute('aria-controls', [...controls].join(' '));
    else textarea.removeAttribute('aria-controls');
  }

  function render(): void {
    menu.replaceChildren();
    rows.forEach((item, index) => {
      const row = document.createElement('button');
      row.type = 'button';
      row.id = `${id}-${index}`;
      row.className = 'ag-slash-option ag-mention-option';
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', index === active ? 'true' : 'false');
      row.classList.toggle('ag-active', index === active);
      const icon = document.createElement('span');
      icon.className = 'ag-mention-icon';
      icon.append(projectIcon(itemIconName(item)));
      const name = document.createElement('strong');
      name.className = 'ag-slash-name';
      name.textContent = item.title;
      const detail = document.createElement('span');
      detail.className = 'ag-slash-detail';
      detail.textContent = item.column ? options.columnName?.(item.column) ?? '' : '';
      row.append(icon, name, detail);
      row.title = item.title;
      // 입력칸의 포커스를 지킨다.
      row.addEventListener('mousedown', (event) => {
        event.preventDefault();
        pick(index);
      });
      menu.append(row);
    });
    setOpen(rows.length > 0);
    menu.querySelector<HTMLElement>('.ag-active')?.scrollIntoView({ block: 'nearest' });
  }

  function update(): void {
    if (composing) return;
    const caret = textarea.selectionStart;
    const next = textarea.selectionStart === textarea.selectionEnd ? mentionTrigger(textarea.value, caret) : null;
    if (!next || next.start === dismissedAt) {
      if (!next) dismissedAt = null;
      close();
      return;
    }
    if (!trigger || trigger.query !== next.query || trigger.start !== next.start) active = 0;
    trigger = next;
    rows = rankMentionItems(options.getItems(), next.query);
    active = Math.min(active, Math.max(0, rows.length - 1));
    render();
  }

  function close(): void {
    trigger = null;
    rows = [];
    menu.replaceChildren();
    setOpen(false);
  }

  function pick(index: number): void {
    const item = rows[index];
    const range = trigger;
    if (!item || !range) return;
    close();
    // `@검색어` 를 지우고 입력기가 높이·보내기 상태를 다시 맞추도록 input 을 알린다.
    textarea.setRangeText('', range.start, range.end, 'end');
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    options.onPick(item);
  }

  function onKeydown(event: KeyboardEvent): void {
    if (menu.hidden || !rows.length || event.isComposing || composing) return;
    const handled = () => {
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      handled();
      active = (active + (event.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length;
      render();
    } else if ((event.key === 'Enter' && !event.shiftKey) || (event.key === 'Tab' && !event.shiftKey)) {
      handled();
      pick(active);
    } else if (event.key === 'Escape') {
      handled();
      dismissedAt = trigger?.start ?? null;
      close();
    }
  }

  const onInput = (event: Event) => {
    if ((event as InputEvent).isComposing) return;
    update();
  };
  const onCompositionStart = () => { composing = true; };
  const onCompositionEnd = () => {
    composing = false;
    update();
  };
  const onSelect = () => {
    if (!menu.hidden) update();
  };
  const onBlur = () => close();

  // 입력기의 Enter(보내기)·화살표보다 먼저 받도록 캡처 단계에 건다.
  textarea.addEventListener('keydown', onKeydown, true);
  textarea.addEventListener('input', onInput);
  textarea.addEventListener('compositionstart', onCompositionStart);
  textarea.addEventListener('compositionend', onCompositionEnd);
  textarea.addEventListener('click', onSelect);
  textarea.addEventListener('blur', onBlur);

  return {
    element: menu,
    isOpen: () => !menu.hidden,
    close,
    refresh() {
      if (!menu.hidden) update();
    },
    destroy() {
      close();
      textarea.removeEventListener('keydown', onKeydown, true);
      textarea.removeEventListener('input', onInput);
      textarea.removeEventListener('compositionstart', onCompositionStart);
      textarea.removeEventListener('compositionend', onCompositionEnd);
      textarea.removeEventListener('click', onSelect);
      textarea.removeEventListener('blur', onBlur);
      menu.remove();
    },
  };
}

/** 사용자 말풍선과 첨부 줄의 멘션 칩. 클릭 동작은 부르는 쪽이 단다. */
export function renderMentionPill(item: ProjectItem | { id: string; title: string }): HTMLButtonElement {
  const pill = document.createElement('button');
  pill.type = 'button';
  pill.className = 'ag-msg-attachment ag-mention-pill';
  pill.dataset.mentionId = item.id;
  pill.title = item.title;
  const name = document.createElement('span');
  name.className = 'ag-msg-attachment-name';
  name.textContent = item.title;
  // 저장된 대화에는 id·제목만 남을 수 있다.
  const icon = projectIcon('kind' in item ? itemIconName(item) : 'file');
  pill.append(icon, name);
  return pill;
}
