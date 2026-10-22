/**
 * CSV·TSV 읽기 보기. csv-parse.ts 로 푼 표를 머리글이 붙어 있는 표로 그린다.
 * 표로 볼 수 없는 글자이거나 인용 위치가 그린 범위 밖이면 null 을 돌려 글자 보기에 맡긴다.
 */

import { cellsInRange, parseCsv, type CsvDelimiter } from './csv-parse.ts';
import { el } from './project-ui.ts';

const MAX_ROWS = 1_000;
const MAX_COLUMNS = 100;
/** 한 번에 그리는 칸 수. 열이 많으면 행을 줄인다. */
const MAX_CELLS = 40_000;
/** 칸 글자가 이보다 길면 잘린 것으로 보고 title 로 전부 보여 준다. */
const TITLE_FROM = 24;
const TITLE_MAX = 2_000;

export interface CsvTableView {
  element: HTMLElement;
  /** 그린 자료 행 수 (머리글 제외). */
  rows: number;
  /** 뒤에 행이 더 있다. */
  truncated: boolean;
  /** 강조한 첫 칸. */
  hit: HTMLElement | null;
}

export function renderCsvTable(
  source: string,
  { delimiter, match, partial }: { delimiter?: CsvDelimiter; match?: { start: number; end: number } | null; partial?: boolean },
): CsvTableView | null {
  const table = parseCsv(source, { delimiter, partial, maxRows: MAX_ROWS, maxColumns: MAX_COLUMNS });
  if (!table.tabular) return null;
  const limit = Math.min(table.rows.length, Math.max(2, Math.floor(MAX_CELLS / table.columns)));
  const hits = match ? cellsInRange(table, match.start, match.end).filter((cell) => cell.row < limit) : [];
  if (match && !hits.length) return null;
  const hitKeys = new Set(hits.map((cell) => cell.row * table.columns + cell.column));

  const wrap = el('div', 'ag-pp-csv');
  const grid = el('table', 'ag-pp-csv-table');
  let firstHit: HTMLElement | null = null;
  const cell = (tag: 'th' | 'td', row: number, column: number) => {
    const value = table.rows[row][column].text;
    const node = el(tag, table.numeric[column] ? 'ag-pp-csv-num' : '', value);
    if (value.length > TITLE_FROM || value.includes('\n')) node.title = value.slice(0, TITLE_MAX);
    if (hitKeys.has(row * table.columns + column)) {
      node.classList.add('ag-pp-csv-hit');
      firstHit ??= node;
    }
    return node;
  };
  if (table.header) {
    const head = el('thead');
    const line = el('tr');
    for (let column = 0; column < table.columns; column += 1) {
      const th = cell('th', 0, column);
      th.scope = 'col';
      line.append(th);
    }
    head.append(line);
    grid.append(head);
  }
  const body = el('tbody');
  for (let row = table.header ? 1 : 0; row < limit; row += 1) {
    const line = el('tr');
    for (let column = 0; column < table.columns; column += 1) line.append(cell('td', row, column));
    body.append(line);
  }
  grid.append(body);
  wrap.append(grid);
  return {
    element: wrap,
    rows: limit - (table.header ? 1 : 0),
    truncated: table.truncated || limit < table.rows.length,
    hit: firstHit,
  };
}

/** 강조한 칸을 표 스크롤 안에서 위쪽 1/3 쯤으로 옮긴다. 바깥 면은 움직이지 않는다. */
export function revealCsvCell(view: CsvTableView): void {
  const { hit, element } = view;
  if (!hit) return;
  const head = element.querySelector('thead')?.getBoundingClientRect().height ?? 0;
  // 첫 열은 왼쪽에 붙어 있으므로 그 너비만큼은 칸이 가려진다.
  const pinned = hit.previousElementSibling ? hit.parentElement?.firstElementChild?.getBoundingClientRect().width ?? 0 : 0;
  const box = element.getBoundingClientRect();
  const cell = hit.getBoundingClientRect();
  element.scrollTop += cell.top - box.top - head - Math.max(0, (element.clientHeight - head) / 3);
  // 옆으로는 칸이 보일 만큼만 옮긴다.
  const left = box.left + pinned;
  if (cell.right > box.right) element.scrollLeft += Math.min(cell.right - box.right, cell.left - left);
  else if (cell.left < left) element.scrollLeft += cell.left - left;
}
