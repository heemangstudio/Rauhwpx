/**
 * 열린 문서 목록(제목 막대 목록·Ctrl+Tab 전환 창)이 보이는 행. 화면 없이 행을 고르고 거른다.
 */

/** 열린 문서의 에이전트 상태. working 은 일하는 중, attention 은 검토·답을 기다린다. */
export type DocumentRowStatus = 'working' | 'attention' | null;

export interface OpenDocumentRow {
  kind: 'open';
  documentId: string;
  name: string;
  dirty: boolean;
  status: DocumentRowStatus;
  /** 지금 화면에 붙은 문서. */
  current: boolean;
}

export interface RecentDocumentRow {
  kind: 'recent';
  documentId: string;
  name: string;
  format: string | null;
  openedAt: number;
}

export type SwitcherAction = 'new' | 'open' | 'home';

export interface ActionRow {
  kind: 'action';
  action: SwitcherAction;
  label: string;
}

export type SwitcherRow = OpenDocumentRow | RecentDocumentRow | ActionRow;

export const SWITCHER_ACTIONS: readonly ActionRow[] = [
  { kind: 'action', action: 'new', label: '새 문서' },
  { kind: 'action', action: 'open', label: '파일 열기…' },
  { kind: 'action', action: 'home', label: '문서 홈' },
];

/** 검색어 없이 보이는 최근 문서 수. 검색하면 맞는 것을 모두 보인다. */
export const RECENT_PREVIEW_LIMIT = 5;

function fold(text: string): string {
  return text.normalize('NFC').toLocaleLowerCase();
}

/** 이름에 검색어가 들어 있는가. 빈 검색어는 모두 맞는다. */
export function matchesQuery(name: string, query: string): boolean {
  const q = fold(query.trim());
  return q === '' || fold(name).includes(q);
}

/**
 * 보일 행을 순서대로 만든다: 열린 문서(연 순서), 최근 문서(열린 것은 뺀다), 동작.
 * 최근 문서는 recent 가 있을 때만 넣는다 — 제목 막대 목록은 열린 문서와 동작만 보인다.
 */
export function switcherRows(input: {
  open: readonly OpenDocumentRow[];
  recent?: readonly RecentDocumentRow[];
  query?: string;
}): SwitcherRow[] {
  const query = input.query ?? '';
  const open = input.open.filter((row) => matchesQuery(row.name, query));
  const openIds = new Set(input.open.map((row) => row.documentId));
  const recentMatches = (input.recent ?? [])
    .filter((row) => !openIds.has(row.documentId) && matchesQuery(row.name, query));
  const recent = query.trim() ? recentMatches : recentMatches.slice(0, RECENT_PREVIEW_LIMIT);
  const actions = SWITCHER_ACTIONS.filter((row) => matchesQuery(row.label, query));
  return [...open, ...recent, ...actions];
}

/** Ctrl+Tab 이 처음 고를 열린 문서: 지금 문서의 다음(뒤로 가면 앞). 열린 문서가 없으면 -1. */
export function initialSwitchIndex(rows: readonly SwitcherRow[], delta: 1 | -1): number {
  const open = openIndexes(rows);
  if (open.length === 0) return -1;
  const current = open.findIndex((index) => (rows[index] as OpenDocumentRow).current);
  if (current < 0) return open[delta > 0 ? 0 : open.length - 1];
  return open[(current + delta + open.length) % open.length];
}

/** Ctrl 을 누른 채 Tab 으로 열린 문서 사이만 돈다. 열린 문서가 아닌 행에 있으면 가까운 열린 문서로 간다. */
export function stepOpenIndex(rows: readonly SwitcherRow[], index: number, delta: 1 | -1): number {
  const open = openIndexes(rows);
  if (open.length === 0) return -1;
  const at = open.indexOf(index);
  if (at < 0) return open[delta > 0 ? 0 : open.length - 1];
  return open[(at + delta + open.length) % open.length];
}

/** 화살표는 모든 행을 돌며 끝에서 처음으로 넘어간다. */
export function stepIndex(index: number, delta: 1 | -1, count: number): number {
  if (count <= 0) return -1;
  if (index < 0) return delta > 0 ? 0 : count - 1;
  return (index + delta + count) % count;
}

function openIndexes(rows: readonly SwitcherRow[]): number[] {
  const indexes: number[] = [];
  rows.forEach((row, index) => { if (row.kind === 'open') indexes.push(index); });
  return indexes;
}
