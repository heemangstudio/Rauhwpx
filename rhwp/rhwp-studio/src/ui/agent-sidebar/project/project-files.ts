/**
 * 프로젝트 파일 목록 — 걸러 보기, 이름 바꾸기, 여러 개 휴지통으로.
 * 그래프를 볼 수 없는 사용자에게도 같은 항목과 연결 수를 전한다.
 * 영역 조각은 원본 파일 바로 아래에 들여 쓴다.
 */
import { itemColumnId, matchesOriginFilter, projectShowsWorktrees } from '../../../agent/project-service.ts';
import type { ProjectOriginFilter, ProjectService, ProjectStore } from '../../../agent/project-service.ts';
import type { ProjectClipItem, ProjectItem, ProjectSnapshot, ProjectWorktreeContext } from '../../../agent/types.ts';
import { projectClipThumb } from './clip-thumbs.ts';
import {
  button,
  createProjectMenu,
  el,
  errorText,
  itemFailed,
  itemIconName,
  itemMeta,
  itemOrganizing,
  ORIGIN_FILTERS,
  projectIcon,
  tagColor,
  worktreeChip,
  worktreeLabelActions,
} from './project-ui.ts';

export interface ProjectFilesDeps {
  store: ProjectStore;
  /** 영역 조각 썸네일의 원본을 받는다. 없으면 아이콘만 둔다. */
  service?: Pick<ProjectService, 'fileBlob'> | null;
  openPreview(itemId: string): void;
  announce(message: string, tone?: 'error'): void;
  /** 이 채팅 문서의 작업 공간. 둘 이상일 때만 표시·거르기를 보인다. */
  worktrees?: () => ProjectWorktreeContext | null;
}

export interface ProjectFiles {
  element: HTMLElement;
  update(project: ProjectSnapshot | null): void;
  focusSearch(): void;
  dispose(): void;
}

type KindFilter = 'all' | 'pdf' | 'doc' | 'note' | 'image' | 'clip' | 'sheet' | 'web';

const KIND_FILTERS: ReadonlyArray<{ id: KindFilter; label: string }> = [
  { id: 'all', label: '모든 종류' },
  { id: 'pdf', label: 'PDF' },
  { id: 'doc', label: '문서' },
  { id: 'note', label: '노트' },
  { id: 'image', label: '이미지' },
  { id: 'clip', label: '영역' },
  { id: 'sheet', label: '표·슬라이드' },
  { id: 'web', label: '웹' },
];

function matchesKind(item: ProjectItem, filter: KindFilter, project: ProjectSnapshot): boolean {
  if (filter === 'all') return true;
  if (item.kind === 'note') return filter === 'note';
  if (item.kind === 'clip') {
    // 영역은 영역 거르기와, 원본이 걸리는 종류(PDF·이미지)에 함께 나온다.
    const source = project.items.find((entry) => entry.id === item.sourceId);
    return filter === 'clip' || (source !== undefined && source.kind === 'file' && matchesKind(source, filter, project));
  }
  if (filter === 'clip') return false;
  switch (filter) {
    case 'pdf': return item.fileKind === 'pdf';
    case 'doc': return ['docx', 'hwp', 'text', 'other'].includes(item.fileKind);
    case 'image': return item.fileKind === 'image';
    case 'sheet': return item.fileKind === 'xlsx' || item.fileKind === 'pptx';
    case 'web': return item.fileKind === 'html' || item.source.kind === 'web';
    default: return false;
  }
}

function normalize(text: string): string {
  return text.normalize('NFC').toLocaleLowerCase('ko-KR');
}

export function createProjectFiles(deps: ProjectFilesDeps): ProjectFiles {
  const { store, openPreview, announce } = deps;
  let project: ProjectSnapshot | null = null;
  let kindFilter: KindFilter = 'all';
  let tagFilter = '';
  let originFilter: ProjectOriginFilter = 'all';
  const worktrees = () => deps.worktrees?.() ?? null;
  let query = '';
  let renaming: string | null = null;
  let anchor: string | null = null;
  const selected = new Set<string>();

  const element = el('div', 'ag-pfiles');
  const toolbar = el('div', 'ag-pfiles-toolbar');
  const searchWrap = el('label', 'ag-pfiles-search');
  searchWrap.append(projectIcon('search'));
  const search = el('input', 'ag-pfiles-search-input');
  search.type = 'search';
  search.placeholder = '이름·태그 검색';
  search.setAttribute('aria-label', '파일 이름과 태그 검색');
  searchWrap.append(search);
  const kind = el('select', 'ag-pfiles-select');
  kind.setAttribute('aria-label', '종류');
  for (const option of KIND_FILTERS) kind.add(new Option(option.label, option.id));
  const tag = el('select', 'ag-pfiles-select');
  tag.setAttribute('aria-label', '태그');
  const origin = el('select', 'ag-pfiles-select');
  origin.setAttribute('aria-label', '작업 공간');
  for (const option of ORIGIN_FILTERS) origin.add(new Option(option.id === 'all' ? '모든 작업 공간' : option.label, option.id));
  origin.hidden = true;
  toolbar.append(searchWrap, kind, tag, origin);

  const selectionBar = el('div', 'ag-pfiles-selection');
  selectionBar.hidden = true;
  const selectAll = el('input', 'ag-pfiles-check');
  selectAll.type = 'checkbox';
  selectAll.setAttribute('aria-label', '보이는 항목 모두 선택');
  const selectionCount = el('span', 'ag-pfiles-selection-count');
  const trashSelected = el('button', 'ag-pfiles-action', '휴지통으로');
  trashSelected.type = 'button';
  const clearSelection = el('button', 'ag-pfiles-action ag-pfiles-action-quiet', '선택 해제');
  clearSelection.type = 'button';
  selectionBar.append(selectAll, selectionCount, clearSelection, trashSelected);

  const list = el('ul', 'ag-pfiles-list');
  list.setAttribute('aria-label', '프로젝트 파일');
  const empty = el('p', 'ag-pfiles-empty');
  empty.hidden = true;
  element.append(toolbar, selectionBar, list, empty);
  const menu = createProjectMenu(element);

  /** 걸러진 항목. 영역은 원본이 목록에 있으면 그 바로 아래(쪽·위치 순)에 온다. */
  function visibleItems(): ProjectItem[] {
    if (!project) return [];
    const snapshot = project;
    const needle = normalize(query.trim());
    const context = worktrees();
    const byOrigin = projectShowsWorktrees(context) ? originFilter : 'all';
    const matching = snapshot.items
      .filter((item) => !item.trashedAt)
      .filter((item) => matchesOriginFilter(item, byOrigin, context))
      .filter((item) => matchesKind(item, kindFilter, snapshot))
      .filter((item) => !tagFilter || item.tags.includes(tagFilter))
      .filter((item) => {
        if (!needle) return true;
        const haystack = [item.title, item.kind === 'file' ? item.originalName : '', ...item.tags].join(' ');
        return normalize(haystack).includes(needle);
      })
      .sort((a, b) => b.updatedAt - a.updatedAt || a.title.localeCompare(b.title, 'ko'));
    const clipsBySource = new Map<string, ProjectClipItem[]>();
    for (const item of matching) {
      if (item.kind !== 'clip') continue;
      const list = clipsBySource.get(item.sourceId) ?? [];
      list.push(item);
      clipsBySource.set(item.sourceId, list);
    }
    const ordered: ProjectItem[] = [];
    const placed = new Set<string>();
    for (const item of matching) {
      if (item.kind === 'clip') continue;
      ordered.push(item);
      const clips = (clipsBySource.get(item.id) ?? [])
        .sort((a, b) => a.page - b.page || a.rect[1] - b.rect[1] || a.rect[0] - b.rect[0]);
      for (const clip of clips) {
        ordered.push(clip);
        placed.add(clip.id);
      }
    }
    for (const item of matching) if (item.kind === 'clip' && !placed.has(item.id)) ordered.push(item);
    return ordered;
  }

  function linkCounts(): Map<string, number> {
    const counts = new Map<string, number>();
    for (const link of project?.links ?? []) {
      counts.set(link.from, (counts.get(link.from) ?? 0) + 1);
      counts.set(link.to, (counts.get(link.to) ?? 0) + 1);
    }
    return counts;
  }

  function renderTagOptions(): void {
    const previous = tag.value;
    tag.replaceChildren(new Option('모든 태그', ''));
    for (const entry of project?.tags ?? []) tag.add(new Option(entry.name, entry.name));
    tag.value = [...tag.options].some((option) => option.value === previous) ? previous : '';
    tagFilter = tag.value;
  }

  function renderSelection(visible: ProjectItem[]): void {
    for (const id of [...selected]) if (!project?.items.some((item) => item.id === id)) selected.delete(id);
    selectionBar.hidden = selected.size === 0;
    selectionCount.textContent = `${selected.size}개 선택`;
    const visibleSelected = visible.filter((item) => selected.has(item.id)).length;
    selectAll.checked = visible.length > 0 && visibleSelected === visible.length;
    selectAll.indeterminate = visibleSelected > 0 && visibleSelected < visible.length;
  }

  function renderRow(item: ProjectItem, links: Map<string, number>, listed: ReadonlySet<string>): HTMLElement {
    const row = el('li', 'ag-pfile');
    row.dataset.item = item.id;
    row.tabIndex = -1;
    row.classList.toggle('ag-selected', selected.has(item.id));
    const check = el('input', 'ag-pfiles-check');
    check.type = 'checkbox';
    check.checked = selected.has(item.id);
    check.setAttribute('aria-label', `${item.title} 선택`);
    row.classList.toggle('ag-pfile-clip', item.kind === 'clip' && listed.has(item.sourceId));
    const icon = (item.kind === 'clip' && project && projectClipThumb(project, item, 'chip', deps.service?.fileBlob, 'ag-pfile-thumb'))
      || projectIcon(itemIconName(item), 'ag-pfile-icon');
    const copy = el('div', 'ag-pfile-copy');
    const title = el('span', 'ag-pfile-title', item.title);
    const column = project?.columns.find((entry) => entry.id === itemColumnId(project!, item))?.name;
    const metaParts = [column, itemMeta(item)];
    const count = links.get(item.id) ?? 0;
    if (count) metaParts.push(`연결 ${count}`);
    const meta = el('span', 'ag-pfile-meta', metaParts.filter(Boolean).join(' · '));
    copy.append(title, meta);
    const tags = el('span', 'ag-pfile-tags');
    for (const name of item.tags.slice(0, 3)) {
      const chip = el('span', 'ag-pcard-tag', name);
      const color = project ? tagColor(project, name) : null;
      if (color) chip.style.setProperty('--ag-ptag-color', color);
      tags.append(chip);
    }
    const branch = worktreeChip(item.origin, worktrees());
    if (branch) tags.append(branch);
    if (itemOrganizing(item)) tags.append(el('span', 'ag-pcard-state', '정리 중'));
    else if (itemFailed(item)) tags.append(el('span', 'ag-pcard-state ag-pcard-state-failed', '실패'));
    const rename = button('ag-pfile-rename', `${item.title} 이름 바꾸기`, { icon: 'pencil' });
    row.append(check, icon, copy, tags, rename);
    if (renaming === item.id) beginRename(row, item, title);
    return row;
  }

  function render(): void {
    const focusedId = document.activeElement instanceof HTMLElement && list.contains(document.activeElement)
      ? document.activeElement.closest<HTMLElement>('.ag-pfile')?.dataset.item ?? null
      : null;
    const visible = visibleItems();
    const links = linkCounts();
    const listed = new Set(visible.map((item) => item.id));
    list.replaceChildren(...visible.map((item) => renderRow(item, links, listed)));
    const total = project?.items.filter((item) => !item.trashedAt).length ?? 0;
    empty.hidden = visible.length > 0;
    empty.textContent = total === 0 ? '항목이 없습니다.' : '조건에 맞는 항목이 없습니다.';
    renderSelection(visible);
    const rows = [...list.querySelectorAll<HTMLElement>('.ag-pfile')];
    const restore = rows.find((row) => row.dataset.item === focusedId) ?? null;
    (restore ?? rows[0])?.setAttribute('tabindex', '0');
    if (restore && renaming === null) restore.focus({ preventScroll: true });
  }

  function beginRename(row: HTMLElement, item: ProjectItem, title: HTMLElement): void {
    renaming = item.id;
    const input = el('input', 'ag-pfile-rename-input');
    input.value = item.title;
    input.maxLength = 200;
    input.setAttribute('aria-label', '새 이름');
    title.replaceWith(input);
    requestAnimationFrame(() => {
      input.focus();
      const dot = item.kind === 'file' ? input.value.lastIndexOf('.') : -1;
      input.setSelectionRange(0, dot > 0 ? dot : input.value.length);
    });
    let done = false;
    const finish = async (save: boolean) => {
      if (done) return;
      done = true;
      renaming = null;
      const name = input.value.trim();
      if (save && name && name !== item.title) {
        try {
          await store.edit([{ op: 'rename', id: item.id, name }]);
          announce(`이름을 “${name}”(으)로 바꿨습니다.`);
        } catch (error) {
          announce(errorText(error), 'error');
        }
      }
      render();
      list.querySelector<HTMLElement>(`[data-item="${CSS.escape(item.id)}"]`)?.focus();
    };
    input.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if (event.key === 'Enter' && !event.isComposing) {
        event.preventDefault();
        void finish(true);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        void finish(false);
      }
    });
    input.addEventListener('blur', () => void finish(true));
    input.addEventListener('click', (event) => event.stopPropagation());
    input.addEventListener('pointerdown', (event) => event.stopPropagation());
    void row;
  }

  function startRename(itemId: string): void {
    const row = list.querySelector<HTMLElement>(`[data-item="${CSS.escape(itemId)}"]`);
    const item = project?.items.find((entry) => entry.id === itemId);
    const title = row?.querySelector<HTMLElement>('.ag-pfile-title');
    if (row && item && title) beginRename(row, item, title);
  }

  function toggle(itemId: string, value: boolean, range: boolean): void {
    if (range && anchor) {
      const ids = visibleItems().map((item) => item.id);
      const from = ids.indexOf(anchor);
      const to = ids.indexOf(itemId);
      if (from >= 0 && to >= 0) {
        for (const id of ids.slice(Math.min(from, to), Math.max(from, to) + 1)) {
          if (value) selected.add(id);
          else selected.delete(id);
        }
      }
    } else if (value) selected.add(itemId);
    else selected.delete(itemId);
    anchor = itemId;
    render();
  }

  list.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    const row = target.closest<HTMLElement>('.ag-pfile');
    const itemId = row?.dataset.item;
    if (!row || !itemId) return;
    if (target.closest('.ag-pfiles-check')) {
      const check = target as HTMLInputElement;
      toggle(itemId, check.checked, (event as MouseEvent).shiftKey);
      return;
    }
    if (target.closest('.ag-pfile-rename')) {
      startRename(itemId);
      return;
    }
    if (target.closest('input')) return;
    openPreview(itemId);
  });

  list.addEventListener('contextmenu', (event) => {
    const row = (event.target as HTMLElement).closest<HTMLElement>('.ag-pfile');
    const item = row?.dataset.item ? project?.items.find((entry) => entry.id === row.dataset.item) : null;
    if (!row || !item || (event.target as HTMLElement).tagName === 'INPUT') return;
    const actions = worktreeLabelActions(item, worktrees());
    if (!actions.length) return;
    event.preventDefault();
    const rect = row.getBoundingClientRect();
    menu.open(actions.map((action) => ({
      label: action.label,
      run: () => {
        void store.edit([{ op: 'label', id: item.id, origin: action.origin }])
          .then(() => announce(action.done), (error: unknown) => announce(errorText(error), 'error'));
      },
    })), event.clientX || rect.left + 40, event.clientY || rect.top + rect.height / 2, row);
  });
  list.addEventListener('scroll', () => menu.close(), { passive: true });

  list.addEventListener('dblclick', (event) => {
    const target = event.target as HTMLElement;
    if (!target.closest('.ag-pfile-title')) return;
    const itemId = target.closest<HTMLElement>('.ag-pfile')?.dataset.item;
    if (itemId) startRename(itemId);
  });

  list.addEventListener('keydown', (event) => {
    const row = (event.target as HTMLElement).closest<HTMLElement>('.ag-pfile');
    const itemId = row?.dataset.item;
    if (!row || !itemId || (event.target as HTMLElement).tagName === 'INPUT') return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      const next = (event.key === 'ArrowDown' ? row.nextElementSibling : row.previousElementSibling) as HTMLElement | null;
      if (!next) return;
      event.preventDefault();
      row.tabIndex = -1;
      next.tabIndex = 0;
      next.focus();
      if (event.shiftKey) toggle(next.dataset.item!, true, false);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      openPreview(itemId);
    } else if (event.key === ' ') {
      event.preventDefault();
      toggle(itemId, !selected.has(itemId), event.shiftKey);
    } else if (event.key === 'F2') {
      event.preventDefault();
      startRename(itemId);
    } else if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      if (!selected.size) selected.add(itemId);
      void trash();
    }
  });

  async function trash(): Promise<void> {
    const ids = [...selected];
    if (!ids.length) return;
    try {
      await store.edit(ids.map((id) => ({ op: 'trash' as const, id })));
      selected.clear();
      announce(`${ids.length}개 항목을 휴지통으로 옮겼습니다.`);
    } catch (error) {
      announce(errorText(error), 'error');
    }
    render();
  }

  search.addEventListener('input', () => {
    query = search.value;
    render();
  });
  kind.addEventListener('change', () => {
    kindFilter = kind.value as KindFilter;
    render();
  });
  tag.addEventListener('change', () => {
    tagFilter = tag.value;
    render();
  });
  origin.addEventListener('change', () => {
    originFilter = origin.value as ProjectOriginFilter;
    render();
  });
  selectAll.addEventListener('change', () => {
    for (const item of visibleItems()) {
      if (selectAll.checked) selected.add(item.id);
      else selected.delete(item.id);
    }
    render();
  });
  clearSelection.addEventListener('click', () => {
    selected.clear();
    render();
  });
  trashSelected.addEventListener('click', () => void trash());

  return {
    element,
    update(next) {
      project = next;
      renderTagOptions();
      const shown = projectShowsWorktrees(worktrees());
      origin.hidden = !shown;
      if (!shown) originFilter = 'all';
      origin.value = originFilter;
      if (renaming === null) render();
    },
    focusSearch() {
      search.focus();
    },
    dispose() {
      menu.dispose();
      element.remove();
    },
  };
}
