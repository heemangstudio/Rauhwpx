/**
 * 열린 문서 목록의 행과 목록. 제목 막대 목록과 Ctrl+Tab 전환 창이 같은 행을 쓴다.
 */
import type {
  OpenDocumentRow,
  RecentDocumentRow,
  SwitcherAction,
  SwitcherRow,
} from './model.ts';
import { openModalCount } from '../modal-stack.ts';

/**
 * 이 목록 말고 다른 모달(확인 시트·대화상자)이 떠 있는가. 그때는 그쪽이 키와 초점을 받는다.
 * own 은 이 목록의 판이다 — 그 안의 요소는 세지 않는다.
 */
export function anotherModalOpen(own: Element | null): boolean {
  if (openModalCount() > 0) return true;
  for (const el of document.querySelectorAll('[aria-modal="true"]')) {
    if (el === own || own?.contains(el) || el.getClientRects().length === 0) continue;
    return true;
  }
  return false;
}

/** 화면 쪽(main.ts)이 채운다. 목록은 열 때마다 새로 읽는다. */
export interface DocumentSwitcherHost {
  /** 이 창에 열린 문서, 연 순서. */
  openRows(): OpenDocumentRow[];
  /** 최근 문서, 최근에 연 순서. */
  recentRows(): Promise<RecentDocumentRow[]>;
  switchTo(documentId: string): void;
  openRecent(row: RecentDocumentRow): void;
  close(documentId: string): void;
  runAction(action: SwitcherAction): void;
  /** 열린 문서·상태가 바뀌면 부른다. 해제 함수를 돌려준다. */
  subscribe(listener: () => void): () => void;
}

const DOC_ICON = '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"><path d="M4 1.75h5.25L12.5 5v9.25h-8.5z"/><path d="M9 1.75V5.25h3.5"/></svg>';
const ACTION_ICONS: Record<SwitcherAction, string> = {
  new: '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><path d="M8 3.5v9M3.5 8h9"/></svg>',
  open: '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"><path d="M1.75 4.25V12.5h12.5V5.75H7.5L6 4.25z"/></svg>',
  home: '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"><path d="M2.25 7 8 2.5 13.75 7v6.5h-3.75V9.75H6v3.75H2.25z"/></svg>',
};
const CLOSE_ICON = '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="m4.5 4.5 7 7M11.5 4.5l-7 7"/></svg>';

const STATUS_LABEL = { working: '에이전트 작업 중', attention: '확인할 것이 있음' } as const;

export function rowKey(row: SwitcherRow): string {
  return row.kind === 'action' ? `action:${row.action}` : `${row.kind}:${row.documentId}`;
}

function rowElement(
  row: SwitcherRow,
  id: string,
  onClose: ((documentId: string) => void) | null,
): HTMLElement {
  const el = document.createElement('div');
  el.className = `ds-row ds-row--${row.kind}`;
  el.id = id;
  el.setAttribute('role', 'option');
  el.dataset.key = rowKey(row);

  const icon = document.createElement('span');
  icon.className = 'ds-icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.innerHTML = row.kind === 'action' ? ACTION_ICONS[row.action] : DOC_ICON;
  el.append(icon);

  const name = document.createElement('span');
  name.className = 'ds-name';
  name.textContent = row.kind === 'action' ? row.label : row.name;
  if (row.kind !== 'action') name.title = row.name;
  el.append(name);

  if (row.kind === 'open') {
    if (row.current) el.classList.add('ds-row--current');
    const meta = document.createElement('span');
    meta.className = 'ds-meta';
    if (row.status) {
      const status = document.createElement('span');
      status.className = `ds-status ds-status--${row.status}`;
      status.title = STATUS_LABEL[row.status];
      status.setAttribute('aria-label', STATUS_LABEL[row.status]);
      meta.append(status);
    }
    if (row.dirty) {
      const dirty = document.createElement('span');
      dirty.className = 'ds-dirty';
      dirty.title = '저장하지 않은 변경';
      dirty.setAttribute('aria-label', '저장하지 않은 변경');
      meta.append(dirty);
    }
    el.append(meta);
    if (onClose) {
      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'ds-close';
      close.tabIndex = -1;
      close.setAttribute('aria-label', `${row.name} 닫기`);
      close.title = '닫기';
      close.innerHTML = CLOSE_ICON;
      close.addEventListener('mousedown', (event) => {
        event.preventDefault();
        event.stopPropagation();
      });
      close.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        onClose(row.documentId);
      });
      el.append(close);
    }
  } else if (row.kind === 'recent' && row.format) {
    const format = document.createElement('span');
    format.className = 'ds-format';
    format.textContent = row.format.toUpperCase();
    el.append(format);
  }
  return el;
}

const SECTION_LABEL: Partial<Record<SwitcherRow['kind'], string>> = { open: '열린 문서', recent: '최근 문서' };

interface SwitcherListOptions {
  /** 열린 문서·최근 문서 앞에 머리글을 단다. */
  sections: boolean;
  onPick: (row: SwitcherRow) => void;
  onClose: (documentId: string) => void;
  onSelect?: (index: number) => void;
}

/**
 * 행 목록을 그린다. 고른 행과 마우스·닫기 단추를 묶는다. 다시 그려도 같은 행을 계속 고른다.
 */
export class SwitcherList {
  readonly root: HTMLDivElement;
  private rows: SwitcherRow[] = [];
  private elements: HTMLElement[] = [];
  private selected = -1;
  private readonly idPrefix: string;
  private readonly options: SwitcherListOptions;

  constructor(idPrefix: string, options: SwitcherListOptions) {
    this.idPrefix = idPrefix;
    this.options = options;
    this.root = document.createElement('div');
    this.root.className = 'ds-list';
    this.root.id = `${idPrefix}-list`;
    this.root.setAttribute('role', 'listbox');
  }

  get items(): readonly SwitcherRow[] { return this.rows; }
  get selectedIndex(): number { return this.selected; }
  get selectedRow(): SwitcherRow | null { return this.rows[this.selected] ?? null; }

  render(rows: SwitcherRow[], selected: number): void {
    this.rows = rows;
    this.elements = [];
    this.root.replaceChildren();
    if (rows.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'ds-empty';
      empty.textContent = '맞는 문서 없음';
      this.root.append(empty);
      this.select(-1);
      return;
    }
    let previousKind: SwitcherRow['kind'] | null = null;
    rows.forEach((row, index) => {
      if (row.kind !== previousKind) {
        if (previousKind !== null) {
          const sep = document.createElement('div');
          sep.className = 'ds-sep';
          sep.setAttribute('role', 'separator');
          this.root.append(sep);
        }
        const label = this.options.sections ? SECTION_LABEL[row.kind] : undefined;
        if (label) {
          const heading = document.createElement('div');
          heading.className = 'ds-heading';
          heading.textContent = label;
          heading.setAttribute('aria-hidden', 'true');
          this.root.append(heading);
        }
        previousKind = row.kind;
      }
      const el = rowElement(row, `${this.idPrefix}-option-${index}`, this.options.onClose);
      el.addEventListener('mousedown', (event) => {
        event.preventDefault();
        this.select(index);
        this.options.onPick(row);
      });
      el.addEventListener('mousemove', () => {
        if (this.selected !== index) this.select(index);
      });
      this.elements.push(el);
      this.root.append(el);
    });
    this.select(Math.min(selected, rows.length - 1));
  }

  select(index: number): void {
    this.selected = index;
    this.elements.forEach((el, i) => {
      el.classList.toggle('ds-row--selected', i === index);
      el.setAttribute('aria-selected', String(i === index));
    });
    this.elements[index]?.scrollIntoView({ block: 'nearest' });
    this.options.onSelect?.(index);
  }
}

/** 고른 행을 실행한다. */
export function pickRow(host: DocumentSwitcherHost, row: SwitcherRow): void {
  // 지금 문서를 골라도 넘긴다 — 문서 홈이 덮고 있으면 걷어야 한다.
  if (row.kind === 'open') host.switchTo(row.documentId);
  else if (row.kind === 'recent') host.openRecent(row);
  else host.runAction(row.action);
}
