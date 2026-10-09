/**
 * 프로젝트 화면 공용 조각: 요소 만들기, 종류 아이콘, 글자 형식.
 * 아이콘은 icons.ts 와 같은 규약(12 그리드, currentColor, 1.25 스트로크)을 따른다.
 */
import { otherWorktreeBranch, projectShowsWorktrees, type ProjectOriginFilter } from '../../../agent/project-service.ts';
import type {
  ProjectActor,
  ProjectItem,
  ProjectOrigin,
  ProjectSnapshot,
  ProjectWorktreeContext,
} from '../../../agent/types.ts';

const NS = 'http://www.w3.org/2000/svg';

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = '',
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function button(className: string, label: string, options: { text?: string; icon?: ProjectIconName } = {}): HTMLButtonElement {
  const node = el('button', className);
  node.type = 'button';
  node.setAttribute('aria-label', label);
  node.title = label;
  if (options.icon) node.append(projectIcon(options.icon));
  if (options.text !== undefined) node.append(el('span', '', options.text));
  return node;
}

const PATHS = {
  file: 'M3 2.2h3.8L9 4.4v5.4H3zM6.8 2.2v2.2H9',
  note: 'M3 2.2h6v7.6H3zM4.4 4.4h3.2M4.4 6h3.2M4.4 7.6h1.8',
  image: 'M2.4 2.7h7.2v6.6H2.4zM3.5 7.8l1.7-1.7 1.2 1.2 1-1 1.1 1.5M7.8 4.5h.1',
  web: 'M6 1.8a4.2 4.2 0 1 0 0 8.4 4.2 4.2 0 0 0 0-8.4M1.8 6h8.4M6 1.8C7.3 3 7.9 4.4 7.9 6S7.3 9 6 10.2M6 1.8C4.7 3 4.1 4.4 4.1 6S4.7 9 6 10.2',
  table: 'M2.2 2.6h7.6v6.8H2.2zM2.2 5h7.6M2.2 7.2h7.6M5 2.6v6.8',
  slides: 'M2 2.6h8v5.4H2zM6 8v1.8M4.2 9.8h3.6',
  documentNode: 'M3.6 1.8h3.6l2 2v6.4H3.6zM7.2 1.8v2h2M2.4 3.4v7.4h5.2',
  trash: 'M2.6 3.4h6.8M4.8 3.4V2.4h2.4v1M3.4 3.4l.4 6.2h4.4l.4-6.2',
  board: 'M2.2 2.4h2.2v7.2H2.2zM5 2.4h2v4.4H5zM7.6 2.4h2.2v5.6H7.6z',
  graph: 'M2 3.4a1 1 0 1 0 2 0a1 1 0 1 0-2 0M8 4.4a1 1 0 1 0 2 0a1 1 0 1 0-2 0M4.4 8.8a1 1 0 1 0 2 0a1 1 0 1 0-2 0M4 3.6l4 .7M3.4 4.3l1.7 3.6M8.4 5.2 6.2 8.2',
  list: 'M4.4 3.2h5.2M4.4 6h5.2M4.4 8.8h5.2M2.4 3.2h.1M2.4 6h.1M2.4 8.8h.1',
  pause: 'M4.5 3.2v5.6M7.5 3.2v5.6',
  play: 'M4.2 2.9v6.2L9 6z',
  history: 'M6 1.8a4.2 4.2 0 1 0 0 8.4 4.2 4.2 0 0 0 0-8.4M6 3.8V6l1.6 1',
  plus: 'M6 2.6v6.8M2.6 6h6.8',
  close: 'M3.2 3.2l5.6 5.6M8.8 3.2l-5.6 5.6',
  back: 'M7.2 2.8 4 6l3.2 3.2',
  fit: 'M2.4 4.4v-2h2M7.6 2.4h2v2M9.6 7.6v2h-2M4.4 9.6h-2v-2',
  undo: 'M4.3 2.8 2.3 4.8l2 2M2.5 4.8h4.4a2.6 2.6 0 0 1 0 5.2H5.2',
  restore: 'M4.3 2.8 2.3 4.8l2 2M2.5 4.8h4.4a2.6 2.6 0 0 1 0 5.2H5.2',
  more: 'M2.4 6a.6.6 0 1 0 1.2 0a.6.6 0 1 0-1.2 0M5.4 6a.6.6 0 1 0 1.2 0a.6.6 0 1 0-1.2 0M8.4 6a.6.6 0 1 0 1.2 0a.6.6 0 1 0-1.2 0',
  search: 'M5.3 2.5a2.8 2.8 0 1 0 0 5.6 2.8 2.8 0 0 0 0-5.6M7.3 7.3l2.2 2.2',
  pin: 'M4.3 1.9h3.4M4.9 1.9v2.4L3.3 6.3h5.4L7.1 4.3V1.9M6 6.3v3.8',
  refresh: 'M9.3 6a3.3 3.3 0 1 1-1.05-2.4M9.5 2.1v1.9H7.6',
  check: 'M2.5 6.4 5 8.9l4.5-5.4',
  upload: 'M6 8.6V2.8M3.6 5.2 6 2.8l2.4 2.4M2.6 9.6h6.8',
  pencil: 'M2.1 9.9l.7-2.5 5-5 1.9 1.9-5 5zM7.1 3.1 9 5M2.8 7.4l1.9 1.9',
  clip: 'M3.6 1.8v6.6h6.6M1.8 3.6h6.6v6.6',
  sliders: 'M2.2 4h7.6M2.2 8h7.6M4.4 2.6v2.8M7.6 6.6v2.8',
} as const;

export type ProjectIconName = keyof typeof PATHS;

export function projectIcon(name: ProjectIconName, className = ''): SVGSVGElement {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', className ? `ag-icon ${className}` : 'ag-icon');
  svg.setAttribute('viewBox', '0 0 12 12');
  svg.setAttribute('width', '12');
  svg.setAttribute('height', '12');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', PATHS[name]);
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.25');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  svg.appendChild(path);
  return svg;
}

export function itemIconName(item: ProjectItem): ProjectIconName {
  if (item.kind === 'note') return 'note';
  if (item.kind === 'clip') return 'clip';
  if (item.source.kind === 'web' || item.fileKind === 'html') return 'web';
  switch (item.fileKind) {
    case 'image': return 'image';
    case 'xlsx': return 'table';
    case 'pptx': return 'slides';
    default: return 'file';
  }
}

const KIND_LABEL: Record<string, string> = {
  text: '텍스트', pdf: 'PDF', docx: 'Word', hwp: '한글', pptx: '슬라이드', xlsx: '표', html: '웹', image: '이미지', other: '파일',
};

export function itemKindLabel(item: ProjectItem): string {
  if (item.kind === 'note') return '노트';
  if (item.kind === 'clip') return '영역';
  return KIND_LABEL[item.fileKind] ?? '파일';
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function formatRelative(at: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 45) return '방금';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}분 전`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}시간 전`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}일 전`;
  return new Date(at).toLocaleDateString('ko-KR', { month: 'short', day: 'numeric' });
}

export function actorLabel(actor: ProjectActor): string {
  if (actor.kind === 'user') return '나';
  if (actor.kind === 'librarian') return '정리 도우미';
  return actor.agent ? `${actor.agent}` : '에이전트';
}

/** 항목 메타 한 줄: 종류 · 쪽수 · 크기. */
export function itemMeta(item: ProjectItem): string {
  const parts = [itemKindLabel(item)];
  if (item.kind === 'clip') parts.push(`p.${item.page}`);
  if (item.kind === 'file') {
    if (item.pageCount) parts.push(`${item.pageCount}쪽`);
    parts.push(formatBytes(item.size));
  }
  return parts.join(' · ');
}

/** 정리 도우미가 이 항목을 다루는 중인가. */
export function itemOrganizing(item: ProjectItem): boolean {
  return item.kind === 'file' && (item.librarian.status === 'queued' || item.librarian.status === 'running');
}

export function itemFailed(item: ProjectItem): boolean {
  return item.kind === 'file' && (item.status === 'failed' || item.librarian.status === 'failed');
}

/** 열·가지 색. 버전 그래프의 가지 색과 같은 여섯 색을 돌려 쓴다. */
export const PROJECT_COLUMN_COLORS = ['#379cff', '#e7ae45', '#cb79d7', '#53bdab', '#8e9dff', '#ed8592'] as const;

export function columnColor(project: Pick<ProjectSnapshot, 'columns'>, columnId: string | null): string {
  const index = Math.max(0, project.columns.findIndex((column) => column.id === columnId));
  return PROJECT_COLUMN_COLORS[index % PROJECT_COLUMN_COLORS.length];
}

export function tagColor(project: Pick<ProjectSnapshot, 'tags'>, name: string): string | null {
  return project.tags.find((tag) => tag.name === name)?.color ?? null;
}

export function reducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/** 잠깐 보이는 짧은 상태 글. role=status 한 곳에 모은다. */
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ── 작업 공간 ───────────────────────────────────────────

export const ORIGIN_FILTERS: ReadonlyArray<{ id: ProjectOriginFilter; label: string }> = [
  { id: 'all', label: '모두' },
  { id: 'current', label: '이 작업 공간' },
  { id: 'shared', label: '공통' },
];

/**
 * 다른 작업 공간에서 모은 항목의 브랜치 이름 칩. 공통·이 작업 공간이면 null. 병합으로 사라진
 * 작업 공간의 표시도 남은 이름으로 보인다 — 공통으로 돌릴 수 있게.
 */
export function worktreeChip(
  origin: ProjectOrigin | null | undefined,
  context: ProjectWorktreeContext | null,
  className = 'ag-pcard-tag ag-pworktree-chip',
): HTMLElement | null {
  if (!context) return null;
  const branch = otherWorktreeBranch(origin, context);
  if (!branch) return null;
  const chip = el('span', className, branch);
  chip.title = `작업 공간: ${branch}`;
  return chip;
}

export interface WorktreeLabelAction {
  label: string;
  origin: 'shared' | 'current';
  done: string;
}

/** 항목 메뉴의 작업 공간 표시 바꾸기. 작업 공간이 하나뿐이고 표시도 없으면 비어 있다. */
export function worktreeLabelActions(
  item: { origin?: ProjectOrigin | null },
  context: ProjectWorktreeContext | null,
): WorktreeLabelAction[] {
  if (!context || (!projectShowsWorktrees(context) && !item.origin)) return [];
  const actions: WorktreeLabelAction[] = [];
  if (item.origin) actions.push({ label: '공통으로 표시', origin: 'shared', done: '공통으로 표시했습니다.' });
  if (item.origin?.worktreeId !== context.current.id) {
    actions.push({ label: '이 작업 공간으로 표시', origin: 'current', done: '이 작업 공간으로 표시했습니다.' });
  }
  return actions;
}

export interface WorktreeColorEntry {
  key: string;
  label: string;
  color: string;
}

/**
 * 그래프의 작업 공간 색: 이 작업 공간은 첫 색, 다른 작업 공간은 그다음 색을 차례로, 공통은 흐린 색.
 * 목록에 없는(지워진) 작업 공간의 표시는 항목에 붙은 이름으로 뒤에 잇는다.
 */
export function worktreeColors(
  context: ProjectWorktreeContext,
  items: readonly Pick<ProjectItem, 'origin' | 'trashedAt'>[],
  shared: string,
): { byId: Map<string, string>; legend: WorktreeColorEntry[] } {
  const byId = new Map<string, string>();
  const legend: WorktreeColorEntry[] = [];
  const add = (id: string, label: string) => {
    if (byId.has(id)) return;
    const color = PROJECT_COLUMN_COLORS[byId.size % PROJECT_COLUMN_COLORS.length];
    byId.set(id, color);
    legend.push({ key: id, label, color });
  };
  add(context.current.id, `${context.current.branch} (이 작업 공간)`);
  for (const worktree of context.worktrees) add(worktree.id, worktree.branch);
  for (const item of items) if (item.origin && !item.trashedAt) add(item.origin.worktreeId, item.origin.branch);
  legend.push({ key: '', label: '공통', color: shared });
  return { byId, legend };
}

/** 항목 오른쪽 클릭 메뉴. host 는 position 이 있는 상자여야 한다. */
export interface ProjectMenu {
  open(entries: ReadonlyArray<{ label: string; run(): void }>, clientX: number, clientY: number, returnFocus?: HTMLElement | null): void;
  close(): void;
  dispose(): void;
}

export function createProjectMenu(host: HTMLElement): ProjectMenu {
  const menu = el('div', 'ag-pgraph-menu ag-pmenu');
  menu.setAttribute('role', 'menu');
  menu.hidden = true;
  host.append(menu);
  let returnTo: HTMLElement | null = null;

  function close(restore = false): void {
    if (menu.hidden) return;
    menu.hidden = true;
    menu.replaceChildren();
    if (restore) returnTo?.focus({ preventScroll: true });
    returnTo = null;
  }

  menu.addEventListener('keydown', (event) => {
    const rows = [...menu.querySelectorAll<HTMLButtonElement>('button')];
    const index = rows.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === 'Escape') close(true);
    else if (event.key === 'ArrowDown') rows[(index + 1) % rows.length]?.focus();
    else if (event.key === 'ArrowUp') rows[(index - 1 + rows.length) % rows.length]?.focus();
    else return;
    event.preventDefault();
    event.stopPropagation();
  });
  const onOutside = (event: PointerEvent) => {
    if (!menu.hidden && !menu.contains(event.target as Node | null)) close();
  };
  document.addEventListener('pointerdown', onOutside, true);

  return {
    open(entries, clientX, clientY, returnFocus = null) {
      menu.replaceChildren();
      returnTo = returnFocus;
      for (const entry of entries) {
        const row = el('button', 'ag-pgraph-menu-item', entry.label);
        row.type = 'button';
        row.setAttribute('role', 'menuitem');
        row.addEventListener('click', () => {
          close(true);
          entry.run();
        });
        menu.append(row);
      }
      menu.hidden = false;
      const bounds = host.getBoundingClientRect();
      const box = menu.getBoundingClientRect();
      menu.style.left = `${Math.max(4, Math.min(clientX - bounds.left, bounds.width - box.width - 8))}px`;
      menu.style.top = `${Math.max(4, Math.min(clientY - bounds.top, bounds.height - box.height - 8))}px`;
      menu.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true });
    },
    close: () => close(),
    dispose() {
      document.removeEventListener('pointerdown', onOutside, true);
      menu.remove();
    },
  };
}
