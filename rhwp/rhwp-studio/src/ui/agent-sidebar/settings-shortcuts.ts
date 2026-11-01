/**
 * 설정 → 단축키. 명령마다 키를 보이고, 칩이나 + 를 눌러 새 키를 기록한다.
 *
 * 초안 없이 기록하는 즉시 저장한다(키맵에는 미리보기가 없다). 다른 명령이 쓰는 키는 저장 전에
 * 그 명령의 이름을 보이고 바꾸기·취소를 묻는다. 기록 중의 키는 window 캡처 단계에서 먼저 받아
 * 명령 팔레트(Ctrl+/), 설정 검색(/), 설정 닫기(Esc) 같은 처리기보다 앞선다.
 */
import './settings-shortcuts.css';
import { confirmSheet } from './sheet.ts';
import { createIcon } from './icons.ts';
import {
  bindingFromKeyboardEvent,
  bindingIdFromLabel,
  formatBindingLabel,
  SHORTCUT_CATEGORY_LABELS,
  type BindingId,
  type RecordResult,
  type ShortcutCategory,
  type ShortcutCommandInfo,
} from '../../command/shortcut-bindings.ts';
import { trackShortcutRecording, type SaveResult, type ShortcutService } from '../../command/effective-shortcuts.ts';
import { detectPlatformKind, formatShortcutLabel, type PlatformKind } from '../../engine/navigation-keymap.ts';

export interface ShortcutSettingsDeps {
  service: ShortcutService;
  /** 보일 명령 목록. 앱은 명령 레지스트리에서, 미리보기는 표본에서 만든다. */
  catalog(): ShortcutCommandInfo[];
  platform?: PlatformKind;
}

export interface ShortcutSettingsController {
  element: HTMLElement;
  /** 탭을 열 때마다 검색과 거르기를 비운다 — 설정 검색이 숨은 줄로 가지 않게. */
  open(): void;
  /** 탭을 떠날 때 기록을 멈추고 거르기를 푼다. */
  close(): void;
  dispose(): void;
}

const CATEGORY_ORDER: readonly ShortcutCategory[] = ['file', 'edit', 'view', 'insert', 'format', 'page', 'table', 'tool', 'help'];

const COPY = {
  title: '단축키',
  description: '명령마다 키를 지정합니다. 한글 입력 상태에서도 같은 자리의 키로 동작합니다.',
  searchPlaceholder: '명령 이름이나 키로 찾기',
  searchLabel: '단축키 검색',
  keySearch: '키로 찾기',
  keySearchPlaceholder: '찾을 키를 누르세요 · Esc 끝내기',
  filterAll: '전체',
  filterCustom: (n: number) => `사용자 지정 ${n}`,
  filterGroup: '표시할 명령',
  resetAll: '모두 기본값으로',
  none: '없음',
  changed: '변경됨',
  locked: '고정',
  overlap: '겹침',
  reset: '기본값',
  capturePlaceholder: '키를 누르세요',
  captureHint: 'Esc 취소 · Backspace 지우기',
  fixedTitle: '연속 키 단축키는 바꿀 수 없습니다.',
  replace: '바꾸기',
  cancel: '취소',
  readOnly: '새 버전에서 저장한 단축키 설정이라 이 버전에서는 바꿀 수 없습니다.',
  footnote: '화살표·Home·Esc 같은 이동 키, 복사·붙이기, 연속 키(Ctrl+K,H 등)는 바꿀 수 없습니다.',
  noMatch: (q: string) => `‘${q}’에 맞는 명령이 없습니다.`,
  addLabel: (name: string) => `‘${name}’에 단축키 추가`,
  chipLabel: (name: string, key: string) => `‘${name}’ 단축키 ${key} 바꾸기`,
  removeLabel: (key: string) => `${key} 지우기`,
  resetLabel: (name: string) => `‘${name}’ 단축키를 기본값으로`,
  captureLabel: (name: string) => `‘${name}’의 새 단축키`,
  lockedOwner: (key: string, owner: string) => `${key}는 ‘${owner}’의 고정 단축키입니다.`,
  conflict: (key: string, owner: string) => `${key}는 ‘${owner}’에 지정되어 있습니다.`,
  assigned: (name: string, key: string) => `‘${name}’에 ${key}를 지정했습니다.`,
  taken: (owner: string, key: string) => `‘${owner}’에서 ${key}를 빼고 여기에 지정했습니다.`,
  removed: (key: string) => `${key}를 지웠습니다.`,
  resetOne: (name: string) => `‘${name}’ 단축키를 기본값으로 되돌렸습니다.`,
  resetAllDone: '모든 단축키를 기본값으로 되돌렸습니다.',
  resetAllTitle: '단축키를 모두 기본값으로',
  resetAllMessage: (n: number) => `직접 지정한 단축키 ${n}개를 지우고 기본 단축키로 되돌립니다.`,
  resetAllConfirm: '되돌리기',
  external: '다른 창에서 단축키가 바뀌었습니다.',
} as const;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(className: string, text?: string): HTMLButtonElement {
  const node = el('button', className, text);
  node.type = 'button';
  return node;
}

/** 메뉴용 표기(찾기(F), 줄/칸 추가하기(I)...)에서 메뉴 글쇠와 말줄임을 걷어 목록 이름으로 쓴다. */
function displayName(label: string): string {
  return label.replace(/\s*\([A-Z0-9]\)/g, '').replace(/\s*(\.\.\.|…)$/, '').trim() || label;
}

/** 검색어와 견줄 꼴 — 소문자, 공백과 + 를 뺀다. ctrl+b·ctrlb·Ctrl B 가 같다. */
function normalizeQuery(text: string): string {
  return text.toLowerCase().replace(/[\s+]/g, '');
}

interface RowView {
  info: ShortcutCommandInfo;
  name: string;
  root: HTMLElement;
  changed: HTMLElement;
  overlap: HTMLElement;
  keys: HTMLElement;
  add: HTMLButtonElement | null;
  reset: HTMLButtonElement;
  message: HTMLElement;
  /** 이름·ID·키 표기를 모은 검색용 글 */
  haystack: string;
  /** 이름·ID 만 모은 검색용 글 (키 표기로 찾을 때 이름도 함께 본다) */
  nameHaystack: string;
  /** 이 줄이 보이는 키 — 바꿀 수 있는 키와 고정 칩(연속 키는 첫 키) */
  keyIds: Set<BindingId>;
}

interface Capture {
  row: RowView;
  /** 바꾸는 키. + 로 더할 때는 null. */
  replace: BindingId | null;
  /** 기록하는 동안 숨겨 두는 칩 묶음이나 + */
  anchor: HTMLElement;
  /** 취소하면 초점을 돌려줄 단추 */
  focusTarget: HTMLElement;
  input: HTMLInputElement;
  hint: HTMLElement;
  /** 다른 명령의 키를 눌러 바꾸기·취소를 묻는 중 */
  prompt: { id: BindingId; owner: string } | null;
}

let idSeq = 0;

export function createShortcutsSettings(deps: ShortcutSettingsDeps): ShortcutSettingsController {
  const { service } = deps;
  const paneId = ++idSeq;
  const platform = deps.platform ?? detectPlatformKind();
  const keyLabel = (id: BindingId) => formatShortcutLabel(formatBindingLabel(id), platform);

  const element = el('div', 'ag-settings-destination-content ag-shortcuts-content');

  // ── 머리: 제목, 검색, 거르기, 모두 되돌리기 ──
  const header = el('section', 'ag-settings-group ag-shortcuts-header');
  const heading = el('div', 'ag-settings-group-heading');
  heading.append(
    el('h2', 'ag-settings-group-title', COPY.title),
    el('p', 'ag-settings-group-description', COPY.description),
  );
  const toolbar = el('div', 'ag-shortcuts-toolbar');
  const searchInput = el('input', 'ag-settings-input ag-shortcuts-search');
  searchInput.type = 'search';
  searchInput.placeholder = COPY.searchPlaceholder;
  searchInput.setAttribute('aria-label', COPY.searchLabel);
  searchInput.autocomplete = 'off';
  searchInput.spellcheck = false;
  const keySearchButton = button('ag-settings-btn ag-shortcuts-keysearch', COPY.keySearch);
  keySearchButton.setAttribute('aria-pressed', 'false');
  const filter = el('div', 'ag-settings-segmented ag-shortcuts-filter');
  filter.setAttribute('role', 'radiogroup');
  filter.setAttribute('aria-label', COPY.filterGroup);
  const filterAll = button('ag-settings-segment', COPY.filterAll);
  const filterCustom = button('ag-settings-segment', COPY.filterCustom(0));
  for (const choice of [filterAll, filterCustom]) choice.setAttribute('role', 'radio');
  filter.append(filterAll, filterCustom);
  const resetAllButton = button('ag-settings-btn ag-shortcuts-reset-all', COPY.resetAll);
  toolbar.append(searchInput, keySearchButton, filter, resetAllButton);
  const status = el('p', 'ag-shortcuts-status');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  const readOnlyBanner = el('div', 'ag-settings-conflict ag-shortcuts-readonly');
  readOnlyBanner.append(el('span', 'ag-settings-conflict-copy', COPY.readOnly));
  readOnlyBanner.hidden = true;
  header.append(heading, readOnlyBanner, toolbar, status);

  const groupsHost = el('div', 'ag-shortcuts-groups');
  const empty = el('p', 'ag-settings-note ag-shortcuts-empty');
  empty.hidden = true;
  const footnote = el('p', 'ag-settings-note ag-shortcuts-footnote', COPY.footnote);
  element.append(header, groupsHost, empty, footnote);

  // ── 상태 ──
  let catalogSignature = '';
  const rows = new Map<string, RowView>();
  const names = new Map<string, string>();
  const groups = new Map<ShortcutCategory, HTMLElement>();
  let query = '';
  let keyFilter: BindingId | null = null;
  let customOnly = false;
  let capture: Capture | null = null;
  let keySearching = false;
  let listening = false;
  let stopTracking: (() => void) | null = null;

  const nameOf = (commandId: string) => names.get(commandId) ?? commandId;

  function setStatus(text: string): void {
    status.textContent = text;
  }

  function setRowMessage(row: RowView, text: string): void {
    row.message.replaceChildren();
    row.message.classList.remove('ag-shortcuts-row-prompt');
    if (text) row.message.textContent = text;
    row.message.hidden = !text;
  }

  // ── 목록 짓기 ──
  function buildRows(catalog: ShortcutCommandInfo[]): void {
    rows.clear();
    names.clear();
    groups.clear();
    groupsHost.replaceChildren();
    const byCategory = new Map<ShortcutCategory, ShortcutCommandInfo[]>();
    for (const info of catalog) {
      names.set(info.id, displayName(info.label));
      const list = byCategory.get(info.category) ?? [];
      list.push(info);
      byCategory.set(info.category, list);
    }
    for (const category of CATEGORY_ORDER) {
      const list = byCategory.get(category);
      if (!list?.length) continue;
      const group = el('section', 'ag-settings-group ag-shortcuts-group');
      group.dataset.category = category;
      const groupHeading = el('div', 'ag-settings-group-heading');
      const title = el('h2', 'ag-settings-group-title', SHORTCUT_CATEGORY_LABELS[category]);
      title.id = `ag-shortcuts-${paneId}-${category}`;
      groupHeading.append(title);
      const body = el('div', 'ag-settings-group-body ag-shortcuts-list');
      body.setAttribute('role', 'list');
      body.setAttribute('aria-labelledby', title.id);
      for (const info of list) {
        const row = buildRow(info);
        rows.set(info.id, row);
        body.append(row.root);
      }
      group.append(groupHeading, body);
      groupsHost.append(group);
      groups.set(category, group);
    }
  }

  function buildRow(info: ShortcutCommandInfo): RowView {
    const name = displayName(info.label);
    const root = el('div', 'ag-settings-control-row ag-shortcuts-row');
    root.setAttribute('role', 'listitem');
    root.dataset.command = info.id;
    if (info.locked) root.dataset.locked = 'true';
    const copy = el('div', 'ag-settings-control-copy');
    const line = el('div', 'ag-shortcuts-name');
    const label = el('span', 'ag-settings-control-label', name);
    const changed = el('span', 'ag-shortcuts-badge ag-shortcuts-badge-changed', COPY.changed);
    changed.hidden = true;
    const overlap = el('span', 'ag-shortcuts-badge ag-shortcuts-badge-overlap', COPY.overlap);
    overlap.hidden = true;
    const reset = button('ag-settings-btn ag-shortcuts-reset', COPY.reset);
    reset.setAttribute('aria-label', COPY.resetLabel(name));
    reset.hidden = true;
    line.append(label, changed, overlap, reset);
    if (info.locked) line.append(el('span', 'ag-shortcuts-badge', COPY.locked));
    copy.append(line);
    if (info.locked) copy.append(el('span', 'ag-settings-control-description', info.locked));
    const keys = el('div', 'ag-shortcuts-keys');
    const message = el('div', 'ag-shortcuts-row-message');
    message.setAttribute('role', 'alert');
    message.hidden = true;
    root.append(copy, keys, message);
    const row: RowView = {
      info, name, root, changed, overlap, keys, add: null, reset, message,
      haystack: '', nameHaystack: '', keyIds: new Set(),
    };
    reset.addEventListener('click', () => resetCommand(row));
    return row;
  }

  function syncCatalog(): void {
    const catalog = deps.catalog();
    const signature = catalog.map((info) => `${info.id}\u0001${info.label}\u0001${info.locked ?? ''}\u0001${info.fixed.join(',')}`).join('\u0002');
    if (signature === catalogSignature) return;
    catalogSignature = signature;
    if (capture) endCapture(false);
    buildRows(catalog);
  }

  // ── 그리기 ──
  function renderRow(row: RowView, overlaps: Map<BindingId, string[]>): void {
    const { info, name } = row;
    const locked = Boolean(info.locked);
    const readOnly = service.readOnly();
    const bindings = service.bindings(info.id);
    const customized = !locked && service.isCustomized(info.id);
    row.changed.hidden = !customized;
    row.root.classList.toggle('ag-shortcuts-row-customized', customized);
    row.reset.hidden = !customized;
    row.reset.disabled = readOnly;
    row.overlap.hidden = !bindings.some((binding) => (overlaps.get(binding.id)?.length ?? 0) > 1
      && overlaps.get(binding.id)!.includes(info.id));

    const parts: string[] = [info.label, name, info.id];
    const nameHaystack = parts.map(normalizeQuery).join('\u0000');
    const keyIds = new Set<BindingId>();
    row.keys.replaceChildren();
    for (const binding of bindings) {
      keyIds.add(binding.id);
      const label = keyLabel(binding.id);
      parts.push(binding.id, formatBindingLabel(binding.id), formatShortcutLabel(formatBindingLabel(binding.id), 'mac'));
      if (locked) {
        const chip = el('span', 'ag-shortcut-chip ag-shortcut-chip-static', label);
        chip.title = info.locked!;
        row.keys.append(chip);
        continue;
      }
      const wrap = el('span', 'ag-shortcut-binding');
      wrap.dataset.binding = binding.id;
      wrap.dataset.source = binding.source;
      const chip = button('ag-shortcut-chip', label);
      chip.setAttribute('aria-label', COPY.chipLabel(name, label));
      chip.disabled = readOnly;
      const remove = button('ag-shortcut-remove');
      remove.setAttribute('aria-label', COPY.removeLabel(label));
      remove.title = COPY.removeLabel(label);
      remove.append(createIcon('close'));
      remove.disabled = readOnly;
      chip.addEventListener('click', () => startCapture(row, binding.id, wrap, chip));
      remove.addEventListener('click', () => removeBinding(row, binding.id));
      wrap.append(chip, remove);
      row.keys.append(wrap);
    }
    for (const fixed of info.fixed) {
      // 'Ctrl+K,H' 는 첫 키 Ctrl+K 로 찾는다. `+` 뒤의 쉼표는 쉼표 키라 자르지 않는다.
      const fixedId = bindingIdFromLabel(fixed.split(/(?<!\+),/)[0] ?? '');
      if (fixedId) keyIds.add(fixedId);
      parts.push(fixed, formatShortcutLabel(fixed, 'mac'));
      const chip = el('span', 'ag-shortcut-chip ag-shortcut-chip-fixed', formatShortcutLabel(fixed, platform));
      chip.title = locked ? info.locked! : COPY.fixedTitle;
      row.keys.append(chip);
    }
    if (bindings.length === 0 && info.fixed.length === 0) row.keys.append(el('span', 'ag-shortcuts-none', COPY.none));
    row.add = null;
    if (!locked) {
      const add = button('ag-shortcut-add');
      add.setAttribute('aria-label', COPY.addLabel(name));
      add.title = COPY.addLabel(name);
      add.append(createIcon('insert'));
      add.disabled = readOnly;
      add.addEventListener('click', () => startCapture(row, null, add, add));
      row.keys.append(add);
      row.add = add;
    }
    row.haystack = parts.map(normalizeQuery).join('\u0000');
    row.nameHaystack = nameHaystack;
    row.keyIds = keyIds;
  }

  function renderAll(): void {
    const overlaps = service.conflicts();
    for (const row of rows.values()) renderRow(row, overlaps);
    const readOnly = service.readOnly();
    const count = service.customizedCount();
    if (count === 0) customOnly = false;
    filterCustom.textContent = COPY.filterCustom(count);
    filterCustom.disabled = count === 0;
    resetAllButton.disabled = count === 0 || readOnly;
    readOnlyBanner.hidden = !readOnly;
    renderFilter();
  }

  function renderFilter(): void {
    filterAll.classList.toggle('ag-active', !customOnly);
    filterAll.setAttribute('aria-checked', String(!customOnly));
    filterCustom.classList.toggle('ag-active', customOnly);
    filterCustom.setAttribute('aria-checked', String(customOnly));
    filterAll.tabIndex = customOnly ? -1 : 0;
    filterCustom.tabIndex = customOnly ? 0 : -1;
    const q = normalizeQuery(query);
    // 'ctrl+s' 처럼 온전한 키 표기면 그 키를 가진 줄만 보인다 — 'ctrls' 가 'ctrlshift…' 의 앞부분이라
    // 글자 일부로 견주면 Ctrl+Shift 줄이 모두 걸린다. 덜 적은 표기('ctrl+sh')는 글자 일부로 견준다.
    const typedKey = keyFilter ? null : bindingIdFromLabel(query);
    let shown = 0;
    const groupShown = new Map<ShortcutCategory, boolean>();
    for (const row of rows.values()) {
      let visible = !customOnly || service.isCustomized(row.info.id);
      if (visible && keyFilter) visible = row.keyIds.has(keyFilter);
      else if (visible && typedKey) visible = row.keyIds.has(typedKey) || row.nameHaystack.includes(q);
      else if (visible && q) visible = row.haystack.includes(q);
      row.root.hidden = !visible;
      if (visible) {
        shown += 1;
        groupShown.set(row.info.category, true);
      }
    }
    for (const [category, group] of groups) group.hidden = !groupShown.get(category);
    const asked = keyFilter ? keyLabel(keyFilter) : query.trim();
    empty.hidden = shown > 0 || !asked;
    empty.textContent = empty.hidden ? '' : COPY.noMatch(asked);
  }

  // ── 키 받기 (window 캡처 단계) ──
  function syncListener(): void {
    const want = capture !== null || keySearching;
    if (want === listening) return;
    listening = want;
    stopTracking?.();
    stopTracking = null;
    if (want) {
      stopTracking = trackShortcutRecording(() => element.isConnected);
      window.addEventListener('keydown', onCaptureKeyDown, true);
    } else {
      window.removeEventListener('keydown', onCaptureKeyDown, true);
    }
  }

  /** 기록·키로 찾기를 모두 접는다. 초점은 옮기지 않는다. */
  function stopReceiving(): void {
    if (capture) cancelCapture(false);
    if (keySearching) endKeySearch(false);
  }

  function onCaptureKeyDown(event: KeyboardEvent): void {
    // 문서 탭을 바꿔 설정 화면이 떨어져 나갔으면 키를 가로채지 않고 기록을 접는다.
    if (!element.isConnected) {
      stopReceiving();
      return;
    }
    // 바꾸기·취소를 묻는 동안은 Esc 만 가로채고 나머지(Tab·Enter)는 단추로 보낸다.
    if (capture?.prompt) {
      if (event.key === 'Escape' && !event.isComposing) {
        // 초점이 설정 밖(문서 등)으로 나갔으면 묻기만 접고 Esc 는 그쪽에 보낸다.
        const focused = document.activeElement;
        if (focused && focused !== document.body && !element.contains(focused)) {
          cancelCapture(false);
          return;
        }
        event.preventDefault();
        event.stopImmediatePropagation();
        cancelCapture(true);
      }
      return;
    }
    // Tab 은 기록을 멈추고 초점을 그대로 옮긴다.
    if (event.key === 'Tab' && !event.ctrlKey && !event.altKey && !event.metaKey) {
      if (capture) cancelCapture(true);
      else if (keySearching) endKeySearch(false);
      return;
    }
    if (event.isComposing) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.repeat) return;
    const result = bindingFromKeyboardEvent(event, platform);
    if (capture) handleCaptureKey(capture, result);
    else if (keySearching) handleKeySearchKey(result);
  }

  function startCapture(row: RowView, replace: BindingId | null, anchor: HTMLElement, focusTarget: HTMLElement): void {
    if (service.readOnly()) return;
    if (capture) cancelCapture(false);
    if (keySearching) endKeySearch(false);
    setRowMessage(row, '');
    const input = el('input', 'ag-shortcut-capture');
    input.type = 'text';
    input.readOnly = true;
    input.inputMode = 'none';
    input.autocomplete = 'off';
    input.placeholder = COPY.capturePlaceholder;
    input.setAttribute('aria-label', COPY.captureLabel(row.name));
    const hint = el('span', 'ag-shortcut-capture-hint', COPY.captureHint);
    hint.id = `ag-shortcut-capture-hint-${++idSeq}`;
    input.setAttribute('aria-describedby', hint.id);
    anchor.before(input, hint);
    anchor.hidden = true;
    const next: Capture = { row, replace, anchor, focusTarget, input, hint, prompt: null };
    capture = next;
    row.root.classList.add('ag-shortcuts-row-recording');
    input.addEventListener('blur', () => {
      // 바꾸기·취소를 묻는 중에는 초점이 그 단추로 옮겨 간다.
      if (capture === next && !next.prompt) cancelCapture(false);
    });
    syncListener();
    input.focus();
  }

  /** 기록을 끝내고 숨긴 칩·+ 를 되살린다. 줄 메시지는 그대로 둔다. */
  function endCapture(focus: boolean): void {
    const current = capture;
    if (!current) return;
    // 먼저 비운다 — 입력칸을 떼면서 오는 blur 가 다시 들어오지 않게.
    capture = null;
    syncListener();
    current.input.remove();
    current.hint.remove();
    current.anchor.hidden = false;
    current.row.root.classList.remove('ag-shortcuts-row-recording');
    if (current.prompt) setRowMessage(current.row, '');
    if (focus && current.focusTarget.isConnected) current.focusTarget.focus();
  }

  function cancelCapture(focus: boolean): void {
    const row = capture?.row;
    endCapture(focus);
    if (row) setRowMessage(row, '');
  }

  function handleCaptureKey(current: Capture, result: RecordResult): void {
    switch (result.kind) {
      case 'ignore':
        return;
      case 'pending':
        current.input.value = result.preview;
        return;
      case 'cancel':
        cancelCapture(true);
        return;
      case 'clear':
        if (current.replace) removeBinding(current.row, current.replace);
        else cancelCapture(true);
        return;
      case 'error':
        current.input.value = '';
        setRowMessage(current.row, result.message);
        return;
      case 'binding':
        tryAssign(current, result.id);
        return;
    }
  }

  function tryAssign(current: Capture, id: BindingId): void {
    const { row } = current;
    const label = keyLabel(id);
    const check = service.check(row.info.id, id, platform);
    switch (check.kind) {
      case 'reserved':
        current.input.value = '';
        setRowMessage(row, check.reason);
        return;
      case 'locked':
        current.input.value = '';
        setRowMessage(row, COPY.lockedOwner(label, nameOf(check.owner)));
        return;
      case 'conflict':
        openPrompt(current, id, check.owner);
        return;
      case 'same':
        // 이미 이 명령의 키다. 바꾸던 칩이 아니면 그 칩을 지우고 남는 키로 모은다.
        if (!current.replace || current.replace === id) {
          cancelCapture(false);
          focusChip(row, id);
          return;
        }
        break;
      case 'ok':
        break;
    }
    const result = service.assign(row.info.id, id, current.replace ? { replace: current.replace } : {});
    finishSave(row, result, id, COPY.assigned(row.name, label));
  }

  function openPrompt(current: Capture, id: BindingId, owner: string): void {
    const { row } = current;
    const label = keyLabel(id);
    current.prompt = { id, owner };
    current.input.value = label;
    row.message.replaceChildren();
    row.message.classList.add('ag-shortcuts-row-prompt');
    const text = el('span', 'ag-shortcuts-row-prompt-copy', COPY.conflict(label, nameOf(owner)));
    const actions = el('span', 'ag-settings-actions ag-shortcuts-row-actions');
    const replace = button('ag-settings-primary ag-shortcuts-replace', COPY.replace);
    const cancel = button('ag-settings-btn ag-shortcuts-cancel', COPY.cancel);
    actions.append(replace, cancel);
    row.message.append(text, actions);
    row.message.hidden = false;
    // 초점이 이 줄 밖의 다른 곳으로 옮겨 가면 묻기를 접는다. relatedTarget 이 없는 경우(초점을 받지 않는
    // 곳을 누름, Safari 의 단추 누르기)는 그대로 두고, Esc 처리에서 초점 위치를 다시 본다.
    actions.addEventListener('focusout', (event) => {
      const next = event.relatedTarget;
      if (capture === current && next instanceof Node && !row.root.contains(next)) cancelCapture(false);
    });
    replace.addEventListener('click', () => {
      if (capture !== current) return;
      const result = service.assign(row.info.id, id, {
        ...(current.replace ? { replace: current.replace } : {}),
        takeFrom: owner,
      });
      if (!result.ok) {
        // 실패하면 묻기를 접고 같은 칸에서 다시 받는다.
        current.prompt = null;
        current.input.value = '';
        setRowMessage(row, result.error);
        current.input.focus();
        return;
      }
      finishSave(row, result, id, COPY.taken(nameOf(owner), label));
    });
    cancel.addEventListener('click', () => {
      if (capture === current) cancelCapture(true);
    });
    replace.focus();
  }

  function finishSave(row: RowView, result: SaveResult, id: BindingId, message: string): void {
    if (!result.ok) {
      if (capture?.row === row) capture.input.value = '';
      setRowMessage(row, result.error);
      return;
    }
    // 저장하면 구독이 기록을 끝내고 다시 그린다.
    setRowMessage(row, '');
    setStatus(message);
    focusChip(row, id);
  }

  function focusChip(row: RowView, id: BindingId): void {
    for (const wrap of row.keys.querySelectorAll<HTMLElement>('.ag-shortcut-binding')) {
      if (wrap.dataset.binding === id) {
        wrap.querySelector<HTMLButtonElement>('.ag-shortcut-chip')?.focus();
        return;
      }
    }
    row.add?.focus();
  }

  function removeBinding(row: RowView, id: BindingId): void {
    const label = keyLabel(id);
    const result = service.remove(row.info.id, id);
    if (!result.ok) {
      if (capture?.row === row) capture.input.value = '';
      setRowMessage(row, result.error);
      return;
    }
    setRowMessage(row, '');
    setStatus(COPY.removed(label));
    row.add?.focus();
  }

  function resetCommand(row: RowView): void {
    if (capture) cancelCapture(false);
    const result = service.resetCommand(row.info.id);
    if (!result.ok) {
      setRowMessage(row, result.error);
      return;
    }
    setRowMessage(row, '');
    setStatus(COPY.resetOne(row.name));
    if (!row.root.hidden) row.add?.focus();
  }

  // ── 키로 찾기 ──
  function startKeySearch(): void {
    if (capture) cancelCapture(false);
    keySearching = true;
    keySearchButton.setAttribute('aria-pressed', 'true');
    searchInput.readOnly = true;
    searchInput.inputMode = 'none';
    searchInput.placeholder = COPY.keySearchPlaceholder;
    searchInput.value = '';
    query = '';
    keyFilter = null;
    syncListener();
    searchInput.focus();
    renderFilter();
  }

  /** clear 면 찾은 키도 지운다. 아니면 찾은 키 이름이 검색 글로 남아 같은 줄을 보인다. */
  function endKeySearch(clear: boolean): void {
    if (!keySearching) return;
    keySearching = false;
    keySearchButton.setAttribute('aria-pressed', 'false');
    searchInput.readOnly = false;
    searchInput.removeAttribute('inputmode');
    searchInput.placeholder = COPY.searchPlaceholder;
    if (clear) {
      keyFilter = null;
      query = '';
      searchInput.value = '';
    }
    syncListener();
    renderFilter();
  }

  function handleKeySearchKey(result: RecordResult): void {
    switch (result.kind) {
      case 'ignore':
        return;
      case 'pending':
        searchInput.value = result.preview;
        return;
      case 'cancel':
        endKeySearch(true);
        searchInput.focus();
        return;
      case 'clear':
        // 찾은 키의 이름(query)도 함께 비운다 — 빈 칸 옆에 예전 키로 거른 목록이 남지 않게.
        keyFilter = null;
        query = '';
        searchInput.value = '';
        renderFilter();
        return;
      case 'error':
        keyFilter = null;
        query = '';
        searchInput.value = '';
        setStatus(result.message);
        renderFilter();
        return;
      case 'binding':
        keyFilter = result.id;
        query = keyLabel(result.id);
        searchInput.value = query;
        setStatus('');
        renderFilter();
        return;
    }
  }

  keySearchButton.addEventListener('click', () => {
    if (keySearching) {
      endKeySearch(true);
      searchInput.focus();
    } else {
      startKeySearch();
    }
  });
  searchInput.addEventListener('blur', (event) => {
    // 키로 찾기 단추를 누르면 그 단추가 끝낸다.
    if (keySearching && event.relatedTarget !== keySearchButton) endKeySearch(false);
  });
  searchInput.addEventListener('input', () => {
    if (keySearching) return;
    query = searchInput.value;
    keyFilter = null;
    renderFilter();
  });
  filterAll.addEventListener('click', () => {
    customOnly = false;
    renderFilter();
  });
  filterCustom.addEventListener('click', () => {
    if (service.customizedCount() === 0) return;
    customOnly = true;
    renderFilter();
  });
  filter.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault();
    const next = customOnly ? filterAll : filterCustom;
    if (next.disabled) return;
    next.click();
    next.focus();
  });
  resetAllButton.addEventListener('click', () => void (async () => {
    const count = service.customizedCount();
    if (count === 0) return;
    if (capture) cancelCapture(false);
    const confirmed = await confirmSheet(resetAllButton, COPY.resetAllTitle, COPY.resetAllMessage(count), {
      confirmLabel: COPY.resetAllConfirm,
      destructive: true,
    });
    if (!confirmed) return;
    const result = service.resetAll();
    setStatus(result.ok ? COPY.resetAllDone : result.error);
  })());

  /** 다시 그리기 전에 목록 안의 초점 자리를 적어 둔다 (어느 줄의 어느 단추인지). */
  interface FocusSpot { command: string; kind: 'chip' | 'remove' | 'add' | 'reset'; binding?: BindingId }
  function focusSpot(): FocusSpot | null {
    if (capture) {
      return capture.replace
        ? { command: capture.row.info.id, kind: 'chip', binding: capture.replace }
        : { command: capture.row.info.id, kind: 'add' };
    }
    const active = document.activeElement;
    if (!(active instanceof HTMLElement) || !groupsHost.contains(active)) return null;
    const command = active.closest<HTMLElement>('.ag-shortcuts-row')?.dataset.command;
    if (!command) return null;
    const binding = active.closest<HTMLElement>('.ag-shortcut-binding')?.dataset.binding;
    if (binding) return { command, kind: active.classList.contains('ag-shortcut-remove') ? 'remove' : 'chip', binding };
    return { command, kind: active.classList.contains('ag-shortcuts-reset') ? 'reset' : 'add' };
  }

  /** 다시 그리며 초점 단추가 사라졌으면 같은 자리(없으면 그 줄의 +, 줄이 숨었으면 검색 칸)로 돌려놓는다. */
  function restoreFocus(spot: FocusSpot | null): void {
    if (!spot) return;
    const active = document.activeElement;
    if (active && active !== document.body && active.isConnected) return;
    const row = rows.get(spot.command);
    let target: HTMLElement | null = null;
    if (row && !row.root.hidden) {
      if (spot.binding) {
        const wrap = [...row.keys.querySelectorAll<HTMLElement>('.ag-shortcut-binding')]
          .find((node) => node.dataset.binding === spot.binding);
        target = wrap?.querySelector<HTMLElement>(spot.kind === 'remove' ? '.ag-shortcut-remove' : '.ag-shortcut-chip') ?? null;
      } else if (spot.kind === 'reset' && !row.reset.hidden) {
        target = row.reset;
      }
      target ??= row.add;
    }
    if (target && !(target as HTMLButtonElement).disabled) target.focus();
    else if (element.isConnected) searchInput.focus();
  }

  const unsubscribe = service.subscribe((source) => {
    // 이 창의 저장은 저장한 자리(finishSave·removeBinding)가 초점을 옮긴다. 다른 창의 변경만 여기서 지킨다.
    const spot = source === 'external' ? focusSpot() : null;
    const wasCapturing = capture !== null;
    if (capture) endCapture(false);
    if (source === 'external' && wasCapturing) setStatus(COPY.external);
    renderAll();
    restoreFocus(spot);
  });

  syncCatalog();
  renderAll();

  return {
    element,
    open(): void {
      syncCatalog();
      if (capture) cancelCapture(false);
      endKeySearch(true);
      query = '';
      keyFilter = null;
      customOnly = false;
      searchInput.value = '';
      setStatus('');
      for (const row of rows.values()) setRowMessage(row, '');
      renderAll();
    },
    close(): void {
      if (capture) cancelCapture(false);
      endKeySearch(true);
      query = '';
      keyFilter = null;
      customOnly = false;
      searchInput.value = '';
      renderFilter();
    },
    dispose(): void {
      unsubscribe();
      capture = null;
      keySearching = false;
      syncListener();
    },
  };
}
