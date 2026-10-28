/**
 * Ctrl+Tab 문서 전환 창. 명령 검색과 같은 면이다.
 *
 * - Ctrl+Tab 으로 열면 지금 문서의 다음 문서를 고른다 (Ctrl+Shift+Tab 은 앞 문서).
 * - Ctrl 을 누른 채 Tab 을 더 누르면 열린 문서 사이를 돌고, Ctrl 을 놓으면 그 문서로 간다.
 * - 한 번만 누르고 놓으면 창이 남는다. Tab 은 열린 문서만, 화살표는 최근 문서·동작까지 옮긴다. 입력하면 찾는다. Return 실행, Esc 닫기.
 */
import {
  initialSwitchIndex,
  stepIndex,
  stepOpenIndex,
  switcherRows,
  type RecentDocumentRow,
  type SwitcherRow,
} from './model.ts';
import { pickRow, rowKey, SwitcherList, type DocumentSwitcherHost } from './view.ts';

export class DocumentSwitcherPopup {
  private overlay: HTMLDivElement | null = null;
  private input: HTMLInputElement | null = null;
  private list: SwitcherList | null = null;
  private recent: RecentDocumentRow[] = [];
  /** Ctrl 을 누른 채 Tab 을 더 눌렀다 — Ctrl 을 놓으면 고른 문서로 간다. */
  private cycling = false;
  private returnFocus: HTMLElement | null = null;
  private cleanup: Array<() => void> = [];
  private readonly host: DocumentSwitcherHost;

  constructor(host: DocumentSwitcherHost) {
    this.host = host;
  }

  isOpen(): boolean {
    return this.overlay !== null;
  }

  /** Ctrl+Tab / Ctrl+Shift+Tab. 열려 있으면 고른 문서를 옮긴다. */
  step(delta: 1 | -1): void {
    if (!this.overlay || !this.list) {
      this.open(delta);
      return;
    }
    this.cycling = true;
    this.list.select(stepOpenIndex(this.list.items, this.list.selectedIndex, delta));
  }

  close(): void {
    if (!this.overlay) return;
    for (const dispose of this.cleanup.splice(0)) dispose();
    this.overlay.remove();
    this.overlay = null;
    this.input = null;
    this.list = null;
    this.cycling = false;
    if (this.returnFocus?.isConnected) this.returnFocus.focus({ preventScroll: true });
    this.returnFocus = null;
  }

  private open(delta: 1 | -1): void {
    this.returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    this.cycling = false;

    const overlay = document.createElement('div');
    overlay.className = 'cp-overlay ds-overlay';
    const panel = document.createElement('div');
    panel.className = 'cp-panel ds-panel ds-popup';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.setAttribute('aria-label', '문서 전환');

    const inputWrap = document.createElement('div');
    inputWrap.className = 'cp-input-wrap';
    const glyph = document.createElement('span');
    glyph.className = 'cp-slash';
    glyph.setAttribute('aria-hidden', 'true');
    glyph.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4" stroke-linecap="round"/></svg>';
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'cp-input';
    input.placeholder = '문서 검색';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.setAttribute('aria-label', '문서 검색');
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('aria-expanded', 'true');
    input.setAttribute('aria-controls', 'editor-document-switcher-list');
    const hint = document.createElement('kbd');
    hint.className = 'ds-hint';
    hint.textContent = 'Ctrl+Tab';
    inputWrap.append(glyph, input, hint);

    const list = new SwitcherList('editor-document-switcher', {
      sections: true,
      onPick: (row) => this.pick(row),
      onClose: (documentId) => this.host.close(documentId),
      onSelect: (index) => {
        if (index >= 0) input.setAttribute('aria-activedescendant', `editor-document-switcher-option-${index}`);
        else input.removeAttribute('aria-activedescendant');
      },
    });
    panel.append(inputWrap, list.root);
    overlay.append(panel);
    document.body.append(overlay);
    this.overlay = overlay;
    this.input = input;
    this.list = list;

    const rows = this.rows();
    list.render(rows, initialSwitchIndex(rows, delta));
    void this.host.recentRows().then((recent) => {
      if (this.list !== list) return;
      this.recent = recent;
      this.refresh();
    }).catch(() => {});

    input.addEventListener('input', () => {
      this.cycling = false;
      list.render(this.rows(), 0);
    });
    overlay.addEventListener('mousedown', (event) => {
      if (event.target === overlay) this.close();
    });

    const onKeyDown = (event: KeyboardEvent) => this.handleKeyDown(event);
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key !== 'Control' || !this.cycling) return;
      const row = this.list?.selectedRow;
      if (row) this.pick(row);
      else this.close();
    };
    const onBlur = () => this.close();
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('keyup', onKeyUp, true);
    window.addEventListener('blur', onBlur);
    const unsubscribe = this.host.subscribe(() => this.refresh());
    this.cleanup.push(
      () => document.removeEventListener('keydown', onKeyDown, true),
      () => document.removeEventListener('keyup', onKeyUp, true),
      () => window.removeEventListener('blur', onBlur),
      unsubscribe,
    );
    input.focus();
  }

  private rows(): SwitcherRow[] {
    return switcherRows({ open: this.host.openRows(), recent: this.recent, query: this.input?.value ?? '' });
  }

  private selectedKey(): string | null {
    const row = this.list?.selectedRow;
    return row ? rowKey(row) : null;
  }

  private refresh(): void {
    if (!this.list) return;
    const key = this.selectedKey();
    const previous = this.list.selectedIndex;
    const rows = this.rows();
    // 같은 행이 다시 그린 목록에 있으면 그 행을, 없으면 같은 자리를 고른다.
    const kept = rows.findIndex((row) => rowKey(row) === key);
    this.list.render(rows, kept >= 0 ? kept : Math.max(0, previous));
  }

  private handleKeyDown(event: KeyboardEvent): void {
    const list = this.list;
    if (!list) return;
    if (event.key === 'Tab') {
      event.preventDefault();
      event.stopPropagation();
      // Tab 은 열린 문서 사이만 돈다. 최근 문서와 동작으로는 화살표로 간다.
      const delta = event.shiftKey ? -1 : 1;
      if (event.ctrlKey) this.step(delta);
      else list.select(stepOpenIndex(list.items, list.selectedIndex, delta));
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      this.close();
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      event.stopPropagation();
      this.cycling = false;
      list.select(stepIndex(list.selectedIndex, event.key === 'ArrowDown' ? 1 : -1, list.items.length));
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      event.stopPropagation();
      const row = list.selectedRow;
      if (row) this.pick(row);
      return;
    }
    // 나머지 키는 검색 칸으로 — 편집 영역에는 닿지 않게 한다.
    event.stopPropagation();
  }

  private pick(row: SwitcherRow): void {
    // 다른 문서로 가면 그 문서의 편집 칸이 초점을 받는다. 닫힌 창의 앞 초점으로 돌리지 않는다.
    if (!(row.kind === 'open' && row.current)) this.returnFocus = null;
    this.close();
    pickRow(this.host, row);
  }
}
