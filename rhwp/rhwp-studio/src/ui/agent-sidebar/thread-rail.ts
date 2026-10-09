/**
 * 채팅 레일 머리의 도구 줄 — 검색 · 문서 필터 · 문서 열기 · 새 채팅.
 *
 * 문서 필터와 문서 열기는 도구 줄 아래로 떨어지는 같은 모양의 팝오버다.
 * 둘 다 검색 칸 하나와 화살표로 오가는 목록 하나로 이루어진다.
 * 채팅을 거르고 문서를 실제로 여는 일은 사이드바가 콜백에서 맡는다.
 */
import './thread-rail.css';
import { createIcon, type SidebarIconName } from './icons.ts';

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** 검색 비교용 — 한글 조합형과 대소문자 차이를 지운다. */
export function searchKey(text: string): string {
  return text.normalize('NFC').toLocaleLowerCase().trim();
}

function iconButton(className: string, icon: SidebarIconName, label: string): HTMLButtonElement {
  const button = el('button', `ag-threads-tool ${className}`);
  button.type = 'button';
  button.setAttribute('aria-label', label);
  button.title = label;
  button.appendChild(createIcon(icon));
  return button;
}

// ── 도구 줄 ────────────────────────────────────────────

export interface ThreadsToolbarOptions {
  onQueryChange(query: string): void;
  onOpenFilter(): void;
  onOpenDocuments(): void;
  onNewChat(): void;
  onClearFilter(): void;
  /** 검색 칸에서 ↓ — 목록 첫 채팅으로 내려간다. */
  onEnterList(): void;
}

export interface ThreadsToolbar {
  readonly root: HTMLElement;
  readonly search: HTMLInputElement;
  readonly filterButton: HTMLButtonElement;
  readonly openButton: HTMLButtonElement;
  readonly newButton: HTMLButtonElement;
  /** 필터가 걸렸을 때 도구 줄 아래에 서는 문서 칩 */
  readonly filterChip: HTMLElement;
  query(): string;
  setFilter(filter: { label: string; missing: boolean } | null): void;
}

export function createThreadsToolbar(options: ThreadsToolbarOptions): ThreadsToolbar {
  const root = el('div', 'ag-threads-toolbar');

  const field = el('label', 'ag-threads-search');
  const search = el('input', 'ag-threads-search-input');
  search.type = 'search';
  search.placeholder = '검색';
  search.autocomplete = 'off';
  search.spellcheck = false;
  search.setAttribute('aria-label', '채팅 검색');
  field.append(createIcon('search', 'ag-threads-search-icon'), search);

  const filterButton = iconButton('ag-threads-doc-filter', 'document', '문서별로 보기');
  filterButton.setAttribute('aria-haspopup', 'listbox');
  filterButton.setAttribute('aria-expanded', 'false');
  filterButton.setAttribute('aria-pressed', 'false');
  const openButton = iconButton('ag-threads-open-doc', 'documentAdd', '문서 열기');
  openButton.setAttribute('aria-haspopup', 'dialog');
  openButton.setAttribute('aria-expanded', 'false');
  const newButton = iconButton('ag-threads-new', 'compose', '새 채팅');
  root.append(field, filterButton, openButton, newButton);

  const filterChip = el('div', 'ag-threads-filter');
  filterChip.hidden = true;
  const chipIcon = createIcon('document', 'ag-threads-filter-icon');
  const chipLabel = el('span', 'ag-threads-filter-label');
  const chipClear = el('button', 'ag-threads-filter-clear');
  chipClear.type = 'button';
  chipClear.setAttribute('aria-label', '문서 필터 해제');
  chipClear.title = '문서 필터 해제';
  chipClear.appendChild(createIcon('close'));
  filterChip.append(chipIcon, chipLabel, chipClear);

  search.addEventListener('input', () => options.onQueryChange(search.value));
  search.addEventListener('keydown', (event) => {
    if (event.isComposing) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      options.onEnterList();
    } else if (event.key === 'Escape' && search.value) {
      // 검색어부터 지운다. 빈 칸의 Esc 는 레일·집중 모드 닫기로 넘어간다.
      event.preventDefault();
      event.stopPropagation();
      search.value = '';
      options.onQueryChange('');
    }
  });
  filterButton.addEventListener('click', (event) => {
    event.stopPropagation();
    options.onOpenFilter();
  });
  openButton.addEventListener('click', (event) => {
    event.stopPropagation();
    options.onOpenDocuments();
  });
  newButton.addEventListener('click', () => options.onNewChat());
  chipClear.addEventListener('click', () => {
    options.onClearFilter();
    filterButton.focus();
  });

  return {
    root,
    search,
    filterButton,
    openButton,
    newButton,
    filterChip,
    query: () => search.value,
    setFilter(filter) {
      filterButton.setAttribute('aria-pressed', filter ? 'true' : 'false');
      filterButton.classList.toggle('ag-active', Boolean(filter));
      filterButton.title = filter ? `문서별로 보기 · ${filter.label}` : '문서별로 보기';
      filterChip.hidden = !filter;
      chipLabel.textContent = filter?.label ?? '';
      chipLabel.title = filter?.label ?? '';
      chipIcon.classList.toggle('ag-doc-missing', Boolean(filter?.missing));
    },
  };
}

// ── 떠 있는 면 ─────────────────────────────────────────

interface FloatingSurface {
  close(restoreFocus?: boolean): void;
}

let openSurface: FloatingSurface | null = null;

/** 지금 떠 있는 팝오버를 닫는다(레일이 접히거나 화면이 바뀔 때). */
export function closeThreadRailSurfaces(): void {
  openSurface?.close(false);
}

export function threadRailSurfaceOpen(): boolean {
  return openSurface !== null;
}

/**
 * position: fixed 의 기준 상자. 사이드바 루트는 contain 으로 고정 배치의
 * 기준이 되므로, 창 좌표를 그 상자 기준으로 옮겨야 한다.
 */
function fixedOrigin(host: HTMLElement): { x: number; y: number } {
  const probe = el('div', 'ag-rail-probe');
  host.appendChild(probe);
  const rect = probe.getBoundingClientRect();
  probe.remove();
  return { x: rect.left, y: rect.top };
}

function mountSurface(
  host: HTMLElement,
  surface: HTMLElement,
  trigger: HTMLElement,
): FloatingSurface {
  openSurface?.close(false);
  let closed = false;
  const onPointerDown = (event: PointerEvent) => {
    const target = event.target as Node;
    if (surface.contains(target) || trigger.contains(target)) return;
    handle.close(false);
  };
  const onResize = () => handle.close(false);
  const handle: FloatingSurface = {
    close(restoreFocus = true) {
      if (closed) return;
      closed = true;
      const hadFocus = surface.contains(document.activeElement);
      document.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('resize', onResize);
      surface.remove();
      trigger.setAttribute('aria-expanded', 'false');
      if (openSurface === handle) openSurface = null;
      if (restoreFocus && hadFocus) trigger.focus({ preventScroll: true });
    },
  };
  host.appendChild(surface);
  trigger.setAttribute('aria-expanded', 'true');
  document.addEventListener('pointerdown', onPointerDown, true);
  window.addEventListener('resize', onResize);
  openSurface = handle;
  return handle;
}

// ── 검색 목록(두 면이 같이 쓴다) ──────────────────────────

interface ListOption {
  id: string;
  label: string;
  icon: SidebarIconName;
  /** 문서 없이 시작한 채팅처럼 점선으로 그리는 아이콘 */
  missingIcon?: boolean;
  /** 오른쪽 끝의 짧은 숫자·글자 */
  trail?: string;
  checked?: boolean;
  section?: string;
  /** 검색어와 상관없이 늘 남는 줄 */
  pinned?: boolean;
  /** 우클릭·더 보기 버튼 */
  onMenu?: (anchor: { x: number; y: number }) => void;
}

interface SearchList {
  readonly field: HTMLElement;
  readonly input: HTMLInputElement;
  readonly list: HTMLElement;
  setOptions(options: ListOption[]): void;
}

let listSeq = 0;

function createSearchList(config: {
  placeholder: string;
  label: string;
  emptyText: string;
  onChoose(id: string): void;
  onEscape(): void;
}): SearchList {
  const listId = `ag-rail-list-${++listSeq}`;
  const field = el('label', 'ag-rail-field');
  const input = el('input', 'ag-rail-input');
  input.type = 'text';
  input.placeholder = config.placeholder;
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-expanded', 'true');
  input.setAttribute('aria-controls', listId);
  input.setAttribute('aria-autocomplete', 'list');
  field.append(createIcon('search', 'ag-rail-field-icon'), input);

  const list = el('div', 'ag-rail-options');
  list.id = listId;
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-label', config.label);

  let all: ListOption[] = [];
  let visible: ListOption[] = [];
  let rows: HTMLElement[] = [];
  let active = 0;

  const setActive = (index: number, scroll: boolean): void => {
    if (rows.length === 0) {
      input.removeAttribute('aria-activedescendant');
      return;
    }
    active = Math.max(0, Math.min(rows.length - 1, index));
    rows.forEach((row, i) => row.classList.toggle('ag-active', i === active));
    input.setAttribute('aria-activedescendant', rows[active]!.id);
    if (scroll) rows[active]!.scrollIntoView({ block: 'nearest' });
  };

  const render = (): void => {
    const query = searchKey(input.value);
    const activeId = visible[active]?.id;
    visible = all.filter((option) => option.pinned || !query || searchKey(option.label).includes(query));
    rows = [];
    list.replaceChildren();
    let section: string | undefined;
    visible.forEach((option, index) => {
      if (option.section && option.section !== section) {
        section = option.section;
        list.appendChild(el('div', 'ag-rail-section', option.section));
      }
      const row = el('div', 'ag-rail-option');
      row.id = `${listId}-${index}`;
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', option.checked ? 'true' : 'false');
      const icon = createIcon(option.icon, 'ag-rail-option-icon');
      if (option.missingIcon) icon.classList.add('ag-doc-missing');
      const label = el('span', 'ag-rail-option-label', option.label);
      label.title = option.label;
      row.append(icon, label);
      if (option.trail) row.appendChild(el('span', 'ag-rail-option-trail', option.trail));
      if (option.checked) row.appendChild(createIcon('check', 'ag-rail-option-check'));
      if (option.onMenu) {
        const more = el('button', 'ag-rail-option-more');
        more.type = 'button';
        more.tabIndex = -1;
        more.setAttribute('aria-hidden', 'true');
        more.title = '문서 메뉴';
        more.appendChild(createIcon('more'));
        more.addEventListener('click', (event) => {
          event.stopPropagation();
          const rect = more.getBoundingClientRect();
          option.onMenu?.({ x: rect.left, y: rect.bottom + 2 });
        });
        row.appendChild(more);
        row.addEventListener('contextmenu', (event) => {
          event.preventDefault();
          event.stopPropagation();
          const rect = row.getBoundingClientRect();
          option.onMenu?.(event.clientX || event.clientY
            ? { x: event.clientX, y: event.clientY }
            : { x: rect.left + 12, y: rect.bottom });
        });
      }
      row.addEventListener('pointermove', () => {
        if (active !== index) setActive(index, false);
      });
      row.addEventListener('click', () => config.onChoose(option.id));
      rows.push(row);
      list.appendChild(row);
    });
    if (query && !visible.some((option) => !option.pinned)) {
      list.appendChild(el('div', 'ag-rail-empty', config.emptyText));
    }
    const keep = activeId ? visible.findIndex((option) => option.id === activeId) : -1;
    setActive(keep >= 0 ? keep : Math.max(0, visible.findIndex((option) => option.checked)), false);
  };

  input.addEventListener('input', () => {
    active = 0;
    // 검색어가 바뀌면 맨 위 결과에서 다시 시작한다.
    visible = [];
    render();
  });
  input.addEventListener('keydown', (event) => {
    if (event.isComposing) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setActive(active + (event.key === 'ArrowDown' ? 1 : -1), true);
    } else if (event.key === 'Home' && !input.value) {
      event.preventDefault();
      setActive(0, true);
    } else if (event.key === 'End' && !input.value) {
      event.preventDefault();
      setActive(rows.length - 1, true);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const option = visible[active];
      if (option) config.onChoose(option.id);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      config.onEscape();
    } else if ((event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) && visible[active]?.onMenu) {
      event.preventDefault();
      const rect = rows[active]!.getBoundingClientRect();
      visible[active]!.onMenu!({ x: rect.left + 12, y: rect.bottom });
    }
  });

  return {
    field,
    input,
    list,
    setOptions(options) {
      all = options;
      render();
    },
  };
}

// ── 도구 줄 아래로 떨어지는 팝오버 ──────────────────────

/** 도구 줄 왼쪽 끝에 맞춰 트리거 아래에 세운다. */
function placeUnderToolbar(
  surface: HTMLElement,
  host: HTMLElement,
  trigger: HTMLElement,
  alignTo: HTMLElement,
): void {
  const origin = fixedOrigin(host);
  const align = alignTo.getBoundingClientRect();
  const anchor = trigger.getBoundingClientRect();
  const width = Math.max(240, Math.min(320, align.width));
  const left = Math.max(8, Math.min(align.left, window.innerWidth - width - 8));
  const top = anchor.bottom + 6;
  surface.style.width = `${width}px`;
  surface.style.left = `${left - origin.x}px`;
  surface.style.top = `${top - origin.y}px`;
  surface.style.maxHeight = `${Math.max(180, Math.min(420, window.innerHeight - top - 12))}px`;
}

// ── 문서 필터 ─────────────────────────────────────────

export interface DocumentFilterOption {
  key: string;
  label: string;
  /** 문서 없이 시작한 채팅 묶음 */
  missing: boolean;
  chatCount: number;
}

const ALL_DOCUMENTS = '__all__';

export function showDocumentFilter(config: {
  host: HTMLElement;
  trigger: HTMLElement;
  /** 팝오버 왼쪽 끝을 맞출 상자(도구 줄) */
  alignTo: HTMLElement;
  selectedKey: string | null;
  documents: DocumentFilterOption[];
  onSelect(key: string | null): void;
  onDocumentMenu?(option: DocumentFilterOption, anchor: { x: number; y: number }): void;
}): void {
  const surface = el('div', 'ag-rail-popover');
  surface.setAttribute('role', 'dialog');
  surface.setAttribute('aria-label', '문서별로 보기');
  const handle = mountSurface(config.host, surface, config.trigger);
  const searchList = createSearchList({
    placeholder: '문서 검색',
    label: '문서',
    emptyText: '일치하는 문서가 없습니다',
    onChoose(id) {
      handle.close();
      config.onSelect(id === ALL_DOCUMENTS ? null : id);
    },
    onEscape: () => handle.close(),
  });
  surface.append(searchList.field, searchList.list);
  searchList.setOptions([
    {
      id: ALL_DOCUMENTS,
      label: '모든 문서',
      icon: 'document',
      checked: config.selectedKey === null,
      pinned: true,
    },
    ...config.documents.map((doc): ListOption => ({
      id: doc.key,
      label: doc.label,
      icon: 'document',
      missingIcon: doc.missing,
      trail: String(doc.chatCount),
      checked: config.selectedKey === doc.key,
      onMenu: config.onDocumentMenu
        ? (anchor) => {
            handle.close(false);
            config.onDocumentMenu?.(doc, anchor);
          }
        : undefined,
    })),
  ]);
  placeUnderToolbar(surface, config.host, config.trigger, config.alignTo);
  searchList.input.focus({ preventScroll: true });
}

// ── 문서 열기 ─────────────────────────────────────────

export interface PaletteRecentDocument {
  documentId: string;
  fileName: string;
  sourceFormat: string;
  openedAt: number;
}

const NEW_DOCUMENT = '__new__';
const OPEN_FILE = '__open__';

/** 짧은 경과 표시 — 목록 끝에 붙는 "3분" "6시간" "2일". */
export function formatShortAge(ts: number, now = Date.now()): string {
  const diff = Math.max(0, now - ts);
  const minute = 60_000;
  const hour = 3_600_000;
  const day = 86_400_000;
  if (diff < minute) return '방금';
  if (diff < hour) return `${Math.floor(diff / minute)}분`;
  if (diff < day) return `${Math.floor(diff / hour)}시간`;
  if (diff < day * 7) return `${Math.floor(diff / day)}일`;
  if (diff < day * 30) return `${Math.floor(diff / (day * 7))}주`;
  if (diff < day * 365) return `${Math.floor(diff / (day * 30))}개월`;
  return `${Math.floor(diff / (day * 365))}년`;
}

export function showDocumentPalette(config: {
  host: HTMLElement;
  trigger: HTMLElement;
  alignTo: HTMLElement;
  recents: Promise<PaletteRecentDocument[]>;
  /** 빠진 동작은 줄을 만들지 않는다. */
  onCreate?: () => void;
  onOpenFile?: () => void;
  onOpenRecent?: (document: PaletteRecentDocument) => void;
}): void {
  const surface = el('div', 'ag-rail-popover');
  surface.setAttribute('role', 'dialog');
  surface.setAttribute('aria-label', '문서 열기');
  let recents: PaletteRecentDocument[] = [];
  const handle = mountSurface(config.host, surface, config.trigger);
  const searchList = createSearchList({
    placeholder: '문서 검색',
    label: '문서 열기',
    emptyText: '일치하는 문서가 없습니다',
    onChoose(id) {
      handle.close(false);
      if (id === NEW_DOCUMENT) config.onCreate?.();
      else if (id === OPEN_FILE) config.onOpenFile?.();
      else {
        const target = recents.find((doc) => doc.documentId === id);
        if (target) config.onOpenRecent?.(target);
      }
    },
    onEscape: () => handle.close(),
  });
  surface.append(searchList.field, searchList.list);

  const options = (): ListOption[] => [
    ...(config.onCreate ? [{ id: NEW_DOCUMENT, label: '새 문서', icon: 'documentAdd', pinned: true } as const] : []),
    ...(config.onOpenFile ? [{ id: OPEN_FILE, label: '파일 열기…', icon: 'external', pinned: true } as const] : []),
    ...(config.onOpenRecent ? recents : []).map((doc): ListOption => ({
      id: doc.documentId,
      label: doc.fileName,
      icon: 'document',
      trail: formatShortAge(doc.openedAt),
      section: '최근 문서',
    })),
  ];
  searchList.setOptions(options());
  placeUnderToolbar(surface, config.host, config.trigger, config.alignTo);
  searchList.input.focus({ preventScroll: true });

  void config.recents.then((list) => {
    if (!surface.isConnected || list.length === 0) return;
    recents = list;
    searchList.setOptions(options());
  }).catch(() => { /* 최근 문서가 없으면 열기 줄만 남는다 */ });
}
