/**
 * 제목 막대(또는 집중 모드 머리)의 문서 이름 아래에 펼치는 열린 문서 목록.
 * 키보드: ↑/↓ 이동, Return 실행, Esc 닫기.
 */
import { stepIndex, switcherRows } from './model.ts';
import { pickRow, rowKey, SwitcherList, type DocumentSwitcherHost } from './view.ts';

interface OpenDropdown {
  anchor: HTMLElement;
  close: () => void;
}

let current: OpenDropdown | null = null;

export function isDocumentDropdownOpen(): boolean {
  return current !== null;
}

export function closeDocumentDropdown(): void {
  current?.close();
}

/** 앵커 아래에 목록을 연다. 같은 앵커에서 이미 열려 있으면 닫는다. */
export function toggleDocumentDropdown(anchor: HTMLElement, host: DocumentSwitcherHost): void {
  if (current) {
    const same = current.anchor === anchor;
    current.close();
    if (same) return;
  }
  openDocumentDropdown(anchor, host);
}

function openDocumentDropdown(anchor: HTMLElement, host: DocumentSwitcherHost): void {
  const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const panel = document.createElement('div');
  panel.className = 'ds-panel ds-dropdown';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', '열린 문서');
  panel.tabIndex = -1;

  const pick = (row: Parameters<typeof pickRow>[1]) => {
    close();
    pickRow(host, row);
  };
  const list = new SwitcherList('editor-document-dropdown', {
    sections: false,
    onPick: pick,
    onClose: (documentId) => host.close(documentId),
  });
  panel.append(list.root);

  const render = () => {
    const key = list.selectedRow ? rowKey(list.selectedRow) : null;
    const rows = switcherRows({ open: host.openRows() });
    const kept = list.indexOfKey(key);
    list.render(rows, kept >= 0 ? kept : Math.max(0, rows.findIndex((row) => row.kind === 'open' && row.current)));
  };
  render();
  document.body.append(panel);
  place();

  function place(): void {
    const rect = anchor.getBoundingClientRect();
    const width = panel.offsetWidth;
    const left = Math.min(Math.max(8, rect.left + rect.width / 2 - width / 2), window.innerWidth - width - 8);
    panel.style.left = `${Math.round(left)}px`;
    panel.style.top = `${Math.round(rect.bottom + 6)}px`;
  }

  const onKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      event.stopPropagation();
      list.select(stepIndex(list.selectedIndex, event.key === 'ArrowDown' ? 1 : -1, list.items.length));
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      event.stopPropagation();
      const row = list.selectedRow;
      if (row) pick(row);
    }
  };
  const onOutside = (event: MouseEvent) => {
    const target = event.target as Node | null;
    if (target && (panel.contains(target) || anchor.contains(target))) return;
    close();
  };
  const unsubscribe = host.subscribe(render);
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('mousedown', onOutside, true);
  window.addEventListener('resize', close);
  window.addEventListener('blur', close);
  anchor.setAttribute('aria-expanded', 'true');
  panel.focus({ preventScroll: true });

  function close(): void {
    if (current?.close !== close) return;
    current = null;
    unsubscribe();
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('mousedown', onOutside, true);
    window.removeEventListener('resize', close);
    window.removeEventListener('blur', close);
    anchor.setAttribute('aria-expanded', 'false');
    const hadFocus = panel.contains(document.activeElement);
    panel.remove();
    if (hadFocus && returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
  }
  current = { anchor, close };
}
