/**
 * 프로젝트 보드 — 가로로 흐르는 열과 카드.
 *
 * 카드는 포인터로 끌어 옮기고(마우스·터치 공용), 운영체제 파일은 HTML5 drop 으로 열에
 * 바로 올린다. 키보드는 Alt+←/→ 로 옆 열, Alt+↑/↓ 로 같은 열 안에서 옮긴다.
 * 끄는 동안 들어온 스냅샷은 놓은 뒤 한 번에 그린다.
 */
import { confirmSheet } from '../sheet.ts';
import { columnItems } from '../../../agent/project-service.ts';
import type { ProjectService, ProjectStore } from '../../../agent/project-service.ts';
import type { ProjectItem, ProjectOp, ProjectSnapshot } from '../../../agent/types.ts';
import {
  addColumnOp,
  dropIndexFor,
  keyboardMoveOp,
  moveOpFor,
  removeColumnOp,
  renameColumnOp,
  shiftColumnOp,
  type BoardDirection,
} from './board-model.ts';
import { projectClipThumb } from './clip-thumbs.ts';
import {
  button,
  columnColor,
  el,
  errorText,
  itemFailed,
  itemIconName,
  itemOrganizing,
  projectIcon,
  tagColor,
} from './project-ui.ts';

export interface ProjectBoardDeps {
  store: ProjectStore;
  /** 파일을 끌어 놓아 올릴 때 쓴다. 없으면 파일 놓기를 받지 않는다. */
  service?: ProjectService | null;
  openPreview(itemId: string): void;
  /** 짧은 상태 알림 (role=status). */
  announce(message: string, tone?: 'error'): void;
}

export interface ProjectBoard {
  element: HTMLElement;
  update(project: ProjectSnapshot | null): void;
  focusItem(itemId: string): void;
  dispose(): void;
}

const DRAG_THRESHOLD_PX = 4;
const EDGE_SCROLL_PX = 48;
const MAX_CARD_TAGS = 3;

interface ColumnView {
  root: HTMLElement;
  dot: HTMLElement;
  name: HTMLButtonElement;
  count: HTMLElement;
  remove: HTMLButtonElement;
  list: HTMLElement;
}

interface DragState {
  itemId: string;
  card: HTMLElement;
  pointerId: number;
  startX: number;
  startY: number;
  offsetX: number;
  offsetY: number;
  active: boolean;
  ghost: HTMLElement | null;
  slot: HTMLElement | null;
  target: { columnId: string; index: number } | null;
  scrollFrame: number;
  lastX: number;
  lastY: number;
}

export function createProjectBoard(deps: ProjectBoardDeps): ProjectBoard {
  const { store, openPreview, announce } = deps;
  let project: ProjectSnapshot | null = null;
  let deferred: ProjectSnapshot | null | undefined;
  let drag: DragState | null = null;
  let focusAfterRender: string | null = null;
  let editingColumn: string | null = null;
  const columnViews = new Map<string, ColumnView>();
  const cards = new Map<string, HTMLElement>();
  const uploads = new Map<string, HTMLElement[]>();

  const element = el('div', 'ag-pboard');
  element.setAttribute('role', 'group');
  element.setAttribute('aria-label', '보드');
  element.setAttribute('aria-roledescription', '보드');
  const track = el('div', 'ag-pboard-track');
  const addColumn = el('button', 'ag-pboard-add-column');
  addColumn.type = 'button';
  addColumn.append(projectIcon('plus'), el('span', '', '열 추가'));
  track.append(addColumn);
  element.append(track);

  // ── 열 ────────────────────────────────────────────────

  function createColumnView(columnId: string): ColumnView {
    const root = el('section', 'ag-pboard-col');
    root.dataset.column = columnId;
    const head = el('div', 'ag-pboard-col-head');
    const dot = el('span', 'ag-pboard-col-dot');
    dot.setAttribute('aria-hidden', 'true');
    const name = el('button', 'ag-pboard-col-name');
    name.type = 'button';
    name.id = `ag-pboard-col-${columnId}`;
    const count = el('span', 'ag-pboard-col-count');
    const remove = button('ag-pboard-icon-btn ag-pboard-col-remove', '열 삭제', { icon: 'trash' });
    head.append(dot, name, count, remove);
    const list = el('ul', 'ag-pboard-cards');
    list.setAttribute('aria-labelledby', name.id);
    root.setAttribute('aria-labelledby', name.id);
    root.append(head, list);

    name.addEventListener('click', () => beginColumnRename(columnId));
    name.addEventListener('keydown', (event) => {
      if (!event.altKey || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') || !project) return;
      event.preventDefault();
      const op = shiftColumnOp(project, columnId, event.key === 'ArrowLeft' ? -1 : 1);
      if (op) {
        focusAfterRender = `column:${columnId}`;
        void commit([op], '열 순서를 바꿨습니다.');
      }
    });
    remove.addEventListener('click', () => void deleteColumn(columnId));
    return { root, dot, name, count, remove, list };
  }

  function beginColumnRename(columnId: string): void {
    const view = columnViews.get(columnId);
    const column = project?.columns.find((entry) => entry.id === columnId);
    if (!view || !column) return;
    editingColumn = columnId;
    const input = el('input', 'ag-pboard-col-input');
    input.value = column.name;
    input.maxLength = 40;
    input.setAttribute('aria-label', '열 이름');
    view.name.hidden = true;
    view.name.after(input);
    input.focus();
    input.select();
    let done = false;
    const finish = (save: boolean) => {
      if (done) return;
      done = true;
      editingColumn = null;
      const value = input.value;
      input.remove();
      view.name.hidden = false;
      if (save && project) {
        const op = renameColumnOp(project, columnId, value);
        if (op) void commit([op], '열 이름을 바꿨습니다.');
      }
      view.name.focus({ preventScroll: true });
      if (deferred !== undefined) flushDeferred();
    };
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.isComposing) {
        event.preventDefault();
        finish(true);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        finish(false);
      }
    });
    input.addEventListener('blur', () => finish(true));
  }

  async function deleteColumn(columnId: string): Promise<void> {
    if (!project) return;
    const column = project.columns.find((entry) => entry.id === columnId);
    const op = removeColumnOp(project, columnId);
    if (!column || !op) return;
    const count = columnItems(project, columnId).length;
    const first = project.columns.find((entry) => entry.id !== columnId);
    if (count > 0 && !await confirmSheet(
      element,
      `“${column.name}” 열 삭제`,
      `항목 ${count}개는 ${first?.name ?? '첫 열'}(으)로 옮깁니다.`,
      { confirmLabel: '삭제', destructive: true },
    )) return;
    void commit([op], `“${column.name}” 열을 삭제했습니다.`);
  }

  addColumn.addEventListener('click', () => {
    const input = el('input', 'ag-pboard-col-input ag-pboard-new-column');
    input.placeholder = '열 이름';
    input.maxLength = 40;
    input.setAttribute('aria-label', '새 열 이름');
    addColumn.hidden = true;
    addColumn.before(input);
    input.focus();
    let done = false;
    const finish = (save: boolean) => {
      if (done) return;
      done = true;
      const value = input.value;
      input.remove();
      addColumn.hidden = false;
      if (save && project) {
        const op = addColumnOp(project, value);
        if (op) void commit([op], '열을 추가했습니다.');
      }
      addColumn.focus({ preventScroll: true });
    };
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.isComposing) {
        event.preventDefault();
        finish(true);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        finish(false);
      }
    });
    input.addEventListener('blur', () => finish(true));
  });

  // ── 카드 ──────────────────────────────────────────────

  function renderCard(card: HTMLElement, item: ProjectItem, snapshot: ProjectSnapshot): void {
    card.replaceChildren();
    card.dataset.item = item.id;
    card.dataset.kind = item.kind === 'file' ? item.fileKind : item.kind;
    const organizing = itemOrganizing(item);
    const failed = itemFailed(item);
    card.classList.toggle('ag-organizing', organizing);
    card.classList.toggle('ag-failed', failed);
    card.classList.toggle('ag-pinned', item.pinned);
    const head = el('div', 'ag-pcard-head');
    const icon = projectIcon(itemIconName(item), 'ag-pcard-icon');
    const title = el('span', 'ag-pcard-title', item.title);
    head.append(icon, title);
    if (item.pinned) head.append(projectIcon('pin', 'ag-pcard-pin'));
    const thumb = item.kind === 'clip' ? projectClipThumb(snapshot, item, 'card', deps.service?.fileBlob, 'ag-pcard-thumb') : null;
    if (thumb) card.append(thumb);
    card.append(head);
    const foot = el('div', 'ag-pcard-foot');
    const visibleTags = item.tags.slice(0, MAX_CARD_TAGS);
    for (const tag of visibleTags) {
      const chip = el('span', 'ag-pcard-tag', tag);
      const color = tagColor(snapshot, tag);
      if (color) chip.style.setProperty('--ag-ptag-color', color);
      foot.append(chip);
    }
    if (item.tags.length > MAX_CARD_TAGS) foot.append(el('span', 'ag-pcard-more', `+${item.tags.length - MAX_CARD_TAGS}`));
    if (organizing) foot.append(el('span', 'ag-pcard-state', '정리 중'));
    else if (failed) foot.append(el('span', 'ag-pcard-state ag-pcard-state-failed', item.kind === 'file' && item.status === 'failed' ? '읽기 실패' : '정리 실패'));
    if (foot.childElementCount) card.append(foot);
    const where = snapshot.columns.find((column) => column.id === item.column)?.name ?? '';
    card.setAttribute('aria-label', [item.title, where, organizing ? '정리 중' : ''].filter(Boolean).join(', '));
  }

  function cardFor(item: ProjectItem): HTMLElement {
    let card = cards.get(item.id);
    if (!card) {
      card = el('li', 'ag-pcard');
      card.tabIndex = -1;
      card.setAttribute('role', 'button');
      card.setAttribute('aria-roledescription', '카드');
      cards.set(item.id, card);
    }
    return card;
  }

  // ── 그리기 ────────────────────────────────────────────

  function render(): void {
    const snapshot = project;
    const activeId = document.activeElement instanceof HTMLElement && element.contains(document.activeElement)
      ? document.activeElement.closest<HTMLElement>('.ag-pcard')?.dataset.item ?? null
      : null;
    if (!snapshot) {
      for (const view of columnViews.values()) view.root.remove();
      columnViews.clear();
      cards.clear();
      return;
    }
    const seenColumns = new Set<string>();
    const seenCards = new Set<string>();
    let firstCard: HTMLElement | null = null;
    for (const column of snapshot.columns) {
      seenColumns.add(column.id);
      let view = columnViews.get(column.id);
      if (!view) {
        view = createColumnView(column.id);
        columnViews.set(column.id, view);
      }
      track.insertBefore(view.root, addColumn);
      view.root.style.setProperty('--ag-pcol-color', columnColor(snapshot, column.id));
      if (editingColumn !== column.id) view.name.textContent = column.name;
      view.name.title = '이름 바꾸기';
      const items = columnItems(snapshot, column.id);
      view.count.textContent = String(items.length);
      view.remove.hidden = snapshot.columns.length <= 1;
      view.remove.setAttribute('aria-label', `${column.name} 열 삭제`);
      // 이미 제자리인 카드는 옮기지 않는다. DOM 에서 옮기면 초점이 풀린다.
      let previous: Element | null = null;
      for (const item of items) {
        seenCards.add(item.id);
        const card = cardFor(item);
        renderCard(card, item, snapshot);
        const expectedNext: Element | null = previous ? previous.nextElementSibling : view.list.firstElementChild;
        if (card.parentElement !== view.list || expectedNext !== card) {
          view.list.insertBefore(card, expectedNext);
        }
        previous = card;
        firstCard ??= card;
      }
      for (const pending of uploads.get(column.id) ?? []) view.list.append(pending);
    }
    for (const [id, view] of columnViews) {
      if (!seenColumns.has(id)) {
        view.root.remove();
        columnViews.delete(id);
      }
    }
    for (const [id, card] of cards) {
      if (!seenCards.has(id)) {
        card.remove();
        cards.delete(id);
      }
    }
    // 보드 안 Tab 정지는 하나 — 마지막으로 머문 카드 또는 첫 카드.
    const rovingId = focusAfterRender && !focusAfterRender.startsWith('column:') ? focusAfterRender : activeId;
    const roving = (rovingId && cards.get(rovingId)) || firstCard;
    for (const card of cards.values()) card.tabIndex = card === roving ? 0 : -1;
    if (!focusAfterRender && activeId && !element.contains(document.activeElement)) {
      cards.get(activeId)?.focus({ preventScroll: true });
    }
    if (focusAfterRender) {
      const target = focusAfterRender.startsWith('column:')
        ? columnViews.get(focusAfterRender.slice(7))?.name
        : cards.get(focusAfterRender);
      focusAfterRender = null;
      target?.focus({ preventScroll: false });
      target?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  }

  function flushDeferred(): void {
    if (deferred === undefined) return;
    project = deferred;
    deferred = undefined;
    render();
  }

  async function commit(ops: ProjectOp[], success?: string): Promise<boolean> {
    try {
      await store.edit(ops);
      if (success) announce(success);
      return true;
    } catch (error) {
      announce(errorText(error), 'error');
      return false;
    }
  }

  function moveAnnouncement(op: Extract<ProjectOp, { op: 'move' }>): string {
    const snapshot = store.get();
    const item = snapshot?.items.find((entry) => entry.id === op.id);
    const column = snapshot?.columns.find((entry) => entry.id === op.column);
    return item && column ? `“${item.title}”을 ${column.name} ${(op.index ?? 0) + 1}번째로 옮겼습니다.` : '옮겼습니다.';
  }

  // ── 키보드 ────────────────────────────────────────────

  function neighborCard(itemId: string, direction: BoardDirection): HTMLElement | null {
    if (!project) return null;
    const item = project.items.find((entry) => entry.id === itemId);
    if (!item) return null;
    const columnIndex = project.columns.findIndex((column) => column.id === (item.column ?? project!.columns[0]?.id));
    const column = project.columns[columnIndex];
    if (!column) return null;
    const list = columnItems(project, column.id);
    const index = list.findIndex((entry) => entry.id === itemId);
    if (direction === 'up' || direction === 'down') {
      const next = list[index + (direction === 'up' ? -1 : 1)];
      return next ? cards.get(next.id) ?? null : null;
    }
    for (let step = 1; ; step++) {
      const target = project.columns[columnIndex + (direction === 'left' ? -step : step)];
      if (!target) return null;
      const targetList = columnItems(project, target.id);
      if (targetList.length) return cards.get(targetList[Math.min(index, targetList.length - 1)].id) ?? null;
    }
  }

  const ARROWS: Record<string, BoardDirection> = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' };

  track.addEventListener('keydown', (event) => {
    const card = (event.target as HTMLElement).closest<HTMLElement>('.ag-pcard');
    const itemId = card?.dataset.item;
    if (!card || !itemId || !project || drag) return;
    const direction = ARROWS[event.key];
    if (direction && event.altKey) {
      event.preventDefault();
      const op = keyboardMoveOp(store.get() ?? project, itemId, direction);
      if (!op) return;
      focusAfterRender = itemId;
      void commit([op]).then((ok) => { if (ok) announce(moveAnnouncement(op)); });
      return;
    }
    if (direction && !event.metaKey && !event.ctrlKey && !event.shiftKey) {
      const next = neighborCard(itemId, direction);
      if (!next) return;
      event.preventDefault();
      card.tabIndex = -1;
      next.tabIndex = 0;
      next.focus();
      next.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      openPreview(itemId);
      return;
    }
    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      const item = project.items.find((entry) => entry.id === itemId);
      const next = neighborCard(itemId, 'down') ?? neighborCard(itemId, 'up');
      if (next) focusAfterRender = next.dataset.item ?? null;
      void commit([{ op: 'trash', id: itemId }], item ? `“${item.title}”을 휴지통으로 옮겼습니다.` : undefined);
    }
  });

  track.addEventListener('focusin', (event) => {
    const card = (event.target as HTMLElement).closest<HTMLElement>('.ag-pcard');
    if (!card) return;
    for (const other of cards.values()) other.tabIndex = other === card ? 0 : -1;
  });

  // ── 포인터 끌기 ───────────────────────────────────────

  function columnAt(x: number, y: number): HTMLElement | null {
    const hit = document.elementFromPoint(x, y);
    const column = hit instanceof Element ? hit.closest<HTMLElement>('.ag-pboard-col') : null;
    if (column && element.contains(column)) return column;
    // 열 사이 틈이나 열 아래 빈 곳: 가로 위치가 겹치는 열을 고른다.
    for (const view of columnViews.values()) {
      const rect = view.root.getBoundingClientRect();
      if (x >= rect.left && x <= rect.right) return view.root;
    }
    return null;
  }

  function updateDropTarget(state: DragState, x: number, y: number): void {
    const column = columnAt(x, y);
    const columnId = column?.dataset.column ?? null;
    const view = columnId ? columnViews.get(columnId) : null;
    if (!view || !columnId) return;
    const others = [...view.list.querySelectorAll<HTMLElement>('.ag-pcard:not(.ag-pcard-source)')];
    const centers = others.map((card) => {
      const rect = card.getBoundingClientRect();
      return rect.top + rect.height / 2;
    });
    const index = dropIndexFor(y, centers);
    if (state.target?.columnId === columnId && state.target.index === index) return;
    state.target = { columnId, index };
    const slot = state.slot!;
    const before = others[index] ?? null;
    if (before) view.list.insertBefore(slot, before);
    else view.list.append(slot);
    for (const other of columnViews.values()) other.root.classList.toggle('ag-drop-target', other === view);
  }

  function edgeScroll(state: DragState): void {
    state.scrollFrame = 0;
    if (!state.active) return;
    const rect = element.getBoundingClientRect();
    let dx = 0;
    if (state.lastX < rect.left + EDGE_SCROLL_PX) dx = -Math.ceil((rect.left + EDGE_SCROLL_PX - state.lastX) / 4);
    else if (state.lastX > rect.right - EDGE_SCROLL_PX) dx = Math.ceil((state.lastX - (rect.right - EDGE_SCROLL_PX)) / 4);
    let scrolled = false;
    if (dx) {
      const before = element.scrollLeft;
      element.scrollLeft += dx;
      scrolled = element.scrollLeft !== before;
    }
    const target = state.target ? columnViews.get(state.target.columnId)?.list : null;
    if (target) {
      const listRect = target.getBoundingClientRect();
      let dy = 0;
      if (state.lastY < listRect.top + EDGE_SCROLL_PX) dy = -Math.ceil((listRect.top + EDGE_SCROLL_PX - state.lastY) / 4);
      else if (state.lastY > listRect.bottom - EDGE_SCROLL_PX) dy = Math.ceil((state.lastY - (listRect.bottom - EDGE_SCROLL_PX)) / 4);
      if (dy) {
        const before = target.scrollTop;
        target.scrollTop += dy;
        scrolled ||= target.scrollTop !== before;
      }
    }
    if (scrolled) updateDropTarget(state, state.lastX, state.lastY);
    if (dx || scrolled) state.scrollFrame = requestAnimationFrame(() => edgeScroll(state));
  }

  function startDrag(state: DragState): void {
    state.active = true;
    const rect = state.card.getBoundingClientRect();
    const ghost = state.card.cloneNode(true) as HTMLElement;
    ghost.classList.add('ag-pcard-ghost');
    ghost.removeAttribute('tabindex');
    ghost.setAttribute('aria-hidden', 'true');
    ghost.style.width = `${rect.width}px`;
    ghost.style.left = `${rect.left}px`;
    ghost.style.top = `${rect.top}px`;
    // 사이드바 root 의 글자·색 변수를 그대로 쓰도록 보드 안에 띄운다 (position: fixed).
    // 조상에 transform 이 있으면 fixed 기준이 바뀌므로 실제 자리와의 차이를 한 번 보정한다.
    element.append(ghost);
    const placed = ghost.getBoundingClientRect();
    ghost.style.left = `${rect.left * 2 - placed.left}px`;
    ghost.style.top = `${rect.top * 2 - placed.top}px`;
    const slot = el('li', 'ag-pcard-slot');
    slot.style.height = `${rect.height}px`;
    slot.setAttribute('aria-hidden', 'true');
    state.ghost = ghost;
    state.slot = slot;
    state.card.classList.add('ag-pcard-source');
    element.classList.add('ag-dragging');
    state.card.after(slot);
    const columnId = state.card.closest<HTMLElement>('.ag-pboard-col')?.dataset.column ?? null;
    const view = columnId ? columnViews.get(columnId) : null;
    const index = view ? [...view.list.querySelectorAll('.ag-pcard:not(.ag-pcard-source)')].indexOf(slot.nextElementSibling as Element) : -1;
    state.target = columnId ? { columnId, index: index < 0 ? Number.MAX_SAFE_INTEGER : index } : null;
  }

  function endDrag(commitMove: boolean): void {
    const state = drag;
    drag = null;
    if (!state) return;
    if (state.scrollFrame) cancelAnimationFrame(state.scrollFrame);
    if (state.card.hasPointerCapture(state.pointerId)) state.card.releasePointerCapture(state.pointerId);
    if (!state.active) return;
    state.ghost?.remove();
    state.slot?.remove();
    state.card.classList.remove('ag-pcard-source');
    element.classList.remove('ag-dragging');
    for (const view of columnViews.values()) view.root.classList.remove('ag-drop-target');
    const snapshot = store.get();
    const op = commitMove && state.target && snapshot
      ? moveOpFor(snapshot, state.itemId, state.target.columnId, state.target.index)
      : null;
    if (op) {
      focusAfterRender = state.itemId;
      // 서버 응답 전에 낙관 스냅샷으로 바로 그린다.
      if (deferred !== undefined) {
        deferred = undefined;
      }
      void commit([op]).then((ok) => { if (ok) announce(moveAnnouncement(op)); });
      project = store.get();
      render();
    } else {
      flushDeferred();
      render();
    }
  }

  track.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || drag) return;
    const target = event.target as HTMLElement;
    const card = target.closest<HTMLElement>('.ag-pcard');
    const itemId = card?.dataset.item;
    if (!card || !itemId || target.closest('button, input, a')) return;
    const rect = card.getBoundingClientRect();
    drag = {
      itemId,
      card,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
      active: false,
      ghost: null,
      slot: null,
      target: null,
      scrollFrame: 0,
      lastX: event.clientX,
      lastY: event.clientY,
    };
    card.setPointerCapture(event.pointerId);
  });

  track.addEventListener('pointermove', (event) => {
    const state = drag;
    if (!state || event.pointerId !== state.pointerId) return;
    state.lastX = event.clientX;
    state.lastY = event.clientY;
    if (!state.active) {
      if (Math.hypot(event.clientX - state.startX, event.clientY - state.startY) < DRAG_THRESHOLD_PX) return;
      startDrag(state);
    }
    event.preventDefault();
    state.ghost!.style.transform = `translate(${event.clientX - state.startX}px, ${event.clientY - state.startY}px) rotate(1.5deg)`;
    updateDropTarget(state, event.clientX, event.clientY);
    if (!state.scrollFrame) state.scrollFrame = requestAnimationFrame(() => edgeScroll(state));
  });

  track.addEventListener('pointerup', (event) => {
    const state = drag;
    if (!state || event.pointerId !== state.pointerId) return;
    if (!state.active) {
      endDrag(false);
      state.card.focus({ preventScroll: true });
      openPreview(state.itemId);
      return;
    }
    endDrag(true);
  });

  track.addEventListener('pointercancel', (event) => {
    if (drag && event.pointerId === drag.pointerId) endDrag(false);
  });

  const onKeyDownCapture = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && drag?.active) {
      event.preventDefault();
      event.stopPropagation();
      endDrag(false);
    }
  };
  document.addEventListener('keydown', onKeyDownCapture, true);

  // ── 파일 놓기 ─────────────────────────────────────────

  const hasFiles = (event: DragEvent) => [...(event.dataTransfer?.types ?? [])].includes('Files');

  function uploadInto(columnId: string, files: File[]): void {
    const service = deps.service;
    const projectId = store.projectId();
    if (!service || !projectId || !files.length) return;
    const pending = uploads.get(columnId) ?? [];
    uploads.set(columnId, pending);
    for (const file of files) {
      const placeholder = el('li', 'ag-pcard ag-pcard-uploading');
      placeholder.setAttribute('aria-hidden', 'true');
      const head = el('div', 'ag-pcard-head');
      head.append(projectIcon('upload', 'ag-pcard-icon'), el('span', 'ag-pcard-title', file.name));
      const foot = el('div', 'ag-pcard-foot');
      foot.append(el('span', 'ag-pcard-state', '올리는 중'));
      placeholder.append(head, foot);
      pending.push(placeholder);
      columnViews.get(columnId)?.list.append(placeholder);
      void service.uploadFile(projectId, file, { column: columnId })
        .then(() => {
          announce(`${file.name}을 올렸습니다.`);
          return store.refresh();
        })
        .catch((error: unknown) => announce(`${file.name}: ${errorText(error)}`, 'error'))
        .finally(() => {
          placeholder.remove();
          const list = uploads.get(columnId);
          if (list) list.splice(list.indexOf(placeholder), 1);
        });
    }
  }

  element.addEventListener('dragover', (event) => {
    if (!hasFiles(event) || !deps.service) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    const column = columnAt(event.clientX, event.clientY);
    for (const view of columnViews.values()) view.root.classList.toggle('ag-drop-target', view.root === column);
  });
  element.addEventListener('dragleave', (event) => {
    if (event.relatedTarget instanceof Node && element.contains(event.relatedTarget)) return;
    for (const view of columnViews.values()) view.root.classList.remove('ag-drop-target');
  });
  element.addEventListener('drop', (event) => {
    if (!hasFiles(event) || !deps.service) return;
    event.preventDefault();
    event.stopPropagation();
    for (const view of columnViews.values()) view.root.classList.remove('ag-drop-target');
    const column = columnAt(event.clientX, event.clientY);
    const columnId = column?.dataset.column ?? project?.columns[0]?.id;
    if (columnId) uploadInto(columnId, [...(event.dataTransfer?.files ?? [])]);
  });

  return {
    element,
    update(next) {
      if (drag?.active || editingColumn) {
        deferred = next;
        return;
      }
      project = next;
      render();
    },
    focusItem(itemId) {
      const card = cards.get(itemId);
      if (!card) return;
      for (const other of cards.values()) other.tabIndex = other === card ? 0 : -1;
      card.focus();
      card.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    },
    dispose() {
      endDrag(false);
      document.removeEventListener('keydown', onKeyDownCapture, true);
      element.remove();
    },
  };
}
