/**
 * 제목 막대(또는 집중 모드 머리)의 문서 이름 아래에 펼치는 열린 문서 목록.
 * 키보드: ↑/↓ 이동, Return 실행, Esc 닫기.
 */
import { stepIndex, switcherRows } from './model.ts';
import { anotherModalOpen, pickRow, rowKey, SwitcherList, type DocumentSwitcherHost } from './view.ts';

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
    // 앵커가 사라졌다 — 집중 모드 머리는 채팅마다 따로라 다른 문서로 넘어가면 숨는다.
    if (!anchor.isConnected || anchor.getClientRects().length === 0) {
      close();
      return;
    }
    const key = list.selectedRow ? rowKey(list.selectedRow) : null;
    const rows = switcherRows({ open: host.openRows() });
    // 다시 그린 행에서 같은 행을 찾는다. 고른 문서가 닫혔으면 지금 문서로 간다.
    const kept = key === null ? -1 : rows.findIndex((row) => rowKey(row) === key);
    list.render(rows, kept >= 0 ? kept : Math.max(0, rows.findIndex((row) => row.kind === 'open' && row.current)));
    // 지금 문서가 바뀌면 제목 너비도 바뀐다.
    if (panel.isConnected) place();
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
    if (anotherModalOpen(null)) return;
    if (event.key === 'Tab') {
      close();
      return;
    }
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
  // 목록이 떠 있는 동안 초점은 목록에 둔다. 닫은 탭 대신 붙은 문서가 편집 칸에 초점을 주면 Return·화살표가
  // 목록과 편집 칸 둘 다에 닿는다. 바깥 누르기는 onOutside 가 먼저 닫는다.
  const onFocusIn = (event: FocusEvent) => {
    const target = event.target as Node | null;
    if (target && (panel.contains(target) || anchor.contains(target))) return;
    if (anotherModalOpen(null)) return;
    panel.focus({ preventScroll: true });
  };
  const unsubscribe = host.subscribe(render);
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('focusin', onFocusIn, true);
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
    document.removeEventListener('focusin', onFocusIn, true);
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
