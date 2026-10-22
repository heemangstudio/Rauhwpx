/**
 * CSV·TSV 읽기 보기. csv-parse.ts 로 푼 표를 머리글이 붙어 있는 표로 그린다.
 * 표로 볼 수 없는 글자이거나 인용 위치가 그린 범위 밖이면 null 을 돌려 글자 보기에 맡긴다.
 * 칸을 끌어 범위를 고르고, 고른 범위를 다시 끌어 입력창에 놓으면 그 범위만 담은 파일로 첨부된다.
 */

import { cellsInRange, parseCsv, type CsvDelimiter, type CsvTable } from './csv-parse.ts';
import { CSV_RANGE_MIME, type CsvRangeDrag } from './project-drag.ts';
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
  /** 두 방향으로 스크롤하는 표 상자. */
  scroller: HTMLElement;
  /** 그린 자료 행 수 (머리글 제외). */
  rows: number;
  /** 뒤에 행이 더 있다. */
  truncated: boolean;
  /** 강조한 첫 칸. */
  hit: HTMLElement | null;
}

export function renderCsvTable(
  source: string,
  { delimiter, match, partial, name }: {
    delimiter?: CsvDelimiter;
    match?: { start: number; end: number } | null;
    partial?: boolean;
    /** 원본 자료 이름. 끌어 낸 범위의 첨부 이름에 쓴다. */
    name?: string;
  },
): CsvTableView | null {
  const table = parseCsv(source, { delimiter, partial, maxRows: MAX_ROWS, maxColumns: MAX_COLUMNS });
  if (!table.tabular) return null;
  const limit = Math.min(table.rows.length, Math.max(2, Math.floor(MAX_CELLS / table.columns)));
  const hits = match ? cellsInRange(table, match.start, match.end).filter((cell) => cell.row < limit) : [];
  if (match && !hits.length) return null;
  const hitKeys = new Set(hits.map((cell) => cell.row * table.columns + cell.column));

  const frame = el('div', 'ag-pp-csv-frame');
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
  frame.append(wrap);
  attachRangeSelection({ frame, wrap, grid, table, limit, name: name ?? '' });
  return {
    element: frame,
    scroller: wrap,
    rows: limit - (table.header ? 1 : 0),
    truncated: table.truncated || limit < table.rows.length,
    hit: firstHit,
  };
}

/** 강조한 칸을 표 스크롤 안에서 위쪽 1/3 쯤으로 옮긴다. 바깥 면은 움직이지 않는다. */
export function revealCsvCell(view: CsvTableView): void {
  const { hit, scroller: element } = view;
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

interface CellPoint { row: number; column: number }
interface CellRange { top: number; bottom: number; left: number; right: number }

/** 0부터 센 열 번호를 A, B, …, Z, AA 처럼 쓴다. */
function columnName(column: number): string {
  let name = '';
  for (let n = column + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
}

function quoteField(value: string, delimiter: string): string {
  return value.includes(delimiter) || /["\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** 범위를 원문 형식으로 다시 쓴다. 머리글 행이 범위 밖이면 고른 열의 머리글을 맨 위에 붙인다. */
function rangeText(table: CsvTable, range: CellRange, delimiter: ',' | '\t'): string {
  const rows: number[] = [];
  if (table.header && range.top > 0) rows.push(0);
  for (let row = range.top; row <= range.bottom; row += 1) rows.push(row);
  return rows.map((row) => {
    const fields: string[] = [];
    for (let column = range.left; column <= range.right; column += 1) {
      fields.push(quoteField(table.rows[row][column].text, delimiter));
    }
    return fields.join(delimiter);
  }).join('\n') + '\n';
}

/**
 * 칸 끌기로 직사각형 범위를 고른다. 머리글에서 시작하면 열 전체를 고른다.
 * 고른 범위 안에서 다시 누르면 브라우저 끌기로 넘겨 범위를 싣는다. ⌘C·Ctrl+C 는 범위를 복사한다.
 */
function attachRangeSelection({ frame, wrap, grid, table, limit, name }: {
  frame: HTMLElement;
  wrap: HTMLElement;
  grid: HTMLTableElement;
  table: CsvTable;
  limit: number;
  name: string;
}): void {
  const delimiter: ',' | '\t' = table.delimiter === '\t' ? '\t' : ',';
  const lastRow = limit - 1;
  const chip = el('div', 'ag-pp-csv-range');
  chip.hidden = true;
  chip.draggable = true;
  chip.title = '입력창으로 끌어 첨부';
  frame.append(chip);
  wrap.tabIndex = 0;

  let anchor: CellPoint | null = null;
  let range: CellRange | null = null;
  let selecting: number | null = null;
  let wholeColumns = false;

  const cellAt = (target: EventTarget | null): CellPoint | null => {
    const cell = target instanceof Element ? target.closest('td, th') : null;
    if (!(cell instanceof HTMLTableCellElement) || !grid.contains(cell)) return null;
    const line = cell.parentElement as HTMLTableRowElement;
    const head = line.parentElement?.tagName === 'THEAD';
    return { row: head ? 0 : line.sectionRowIndex + (table.header ? 1 : 0), column: cell.cellIndex };
  };
  const cellNode = (row: number, column: number): HTMLTableCellElement | undefined => {
    const line = table.header && row === 0 ? grid.tHead?.rows[0] : grid.tBodies[0]?.rows[row - (table.header ? 1 : 0)];
    return line?.cells[column];
  };
  const inRange = (point: CellPoint, area: CellRange | null) => Boolean(area)
    && point.row >= area!.top && point.row <= area!.bottom && point.column >= area!.left && point.column <= area!.right;
  const paint = (area: CellRange | null, on: boolean) => {
    if (!area) return;
    for (let row = area.top; row <= area.bottom; row += 1) {
      for (let column = area.left; column <= area.right; column += 1) cellNode(row, column)?.classList.toggle('ag-pp-csv-sel', on);
    }
  };
  const label = (area: CellRange) => {
    const rows = area.bottom - area.top + 1;
    const columns = area.right - area.left + 1;
    return `${columnName(area.left)}${area.top + 1}:${columnName(area.right)}${area.bottom + 1} · ${rows.toLocaleString('ko-KR')}×${columns}`;
  };
  const select = (next: CellRange | null) => {
    // 바뀐 칸만 고치려고 이전 범위를 지운 뒤 새 범위를 칠한다. 둘 다 그린 행 안에 있다.
    paint(range, false);
    range = next;
    paint(range, true);
    chip.hidden = !range;
    if (range) chip.textContent = label(range);
  };
  const extend = (focus: CellPoint) => {
    if (!anchor) return;
    select({
      top: wholeColumns ? (table.header ? 1 : 0) : Math.min(anchor.row, focus.row),
      bottom: wholeColumns ? lastRow : Math.max(anchor.row, focus.row),
      left: Math.min(anchor.column, focus.column),
      right: Math.max(anchor.column, focus.column),
    });
  };
  const payload = (): CsvRangeDrag | null => {
    if (!range) return null;
    const base = name.replace(/\.(csv|tsv|txt)$/i, '') || '표';
    const ref = `${columnName(range.left)}${range.top + 1}-${columnName(range.right)}${range.bottom + 1}`;
    return { name: `${base} ${ref}.${delimiter === '\t' ? 'tsv' : 'csv'}`, text: rangeText(table, range, delimiter), delimiter };
  };

  wrap.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    const point = cellAt(event.target);
    // 고른 범위를 누르면 끌기로 넘긴다. 그 밖을 누르면 새로 고른다.
    wrap.draggable = Boolean(point && range && inRange(point, range));
    if (!point || wrap.draggable) return;
    event.preventDefault();
    wrap.focus({ preventScroll: true });
    wholeColumns = table.header && point.row === 0;
    if (event.shiftKey && anchor) extend(point);
    else {
      anchor = point;
      extend(point);
    }
    selecting = event.pointerId;
    wrap.setPointerCapture(event.pointerId);
  });
  wrap.addEventListener('pointermove', (event) => {
    if (selecting !== event.pointerId) return;
    const point = cellAt(document.elementFromPoint(event.clientX, event.clientY));
    if (point) extend(wholeColumns ? { ...point, row: 0 } : point);
  });
  const stop = (event: PointerEvent) => {
    if (selecting !== event.pointerId) return;
    selecting = null;
    if (wrap.hasPointerCapture(event.pointerId)) wrap.releasePointerCapture(event.pointerId);
  };
  wrap.addEventListener('pointerup', stop);
  wrap.addEventListener('pointercancel', stop);

  const startDrag = (event: DragEvent) => {
    const data = event.dataTransfer;
    const item = payload();
    if (!data || !item) {
      event.preventDefault();
      return;
    }
    event.stopPropagation();
    data.clearData();
    data.setData(CSV_RANGE_MIME, JSON.stringify(item));
    data.setData('text/plain', item.text);
    data.effectAllowed = 'copy';
    // 표 전체가 끌기 그림이 되지 않도록 범위 이름표를 그림으로 쓴다.
    if (event.currentTarget !== chip) data.setDragImage(chip, 12, 12);
  };
  wrap.addEventListener('dragstart', startDrag);
  chip.addEventListener('dragstart', startDrag);
  wrap.addEventListener('dragend', () => { wrap.draggable = false; });

  wrap.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && range) {
      event.stopPropagation();
      anchor = null;
      select(null);
    }
  });
  wrap.addEventListener('copy', (event) => {
    const item = payload();
    if (!item || !event.clipboardData) return;
    event.preventDefault();
    // 다른 표 앱에 붙여 넣기 좋게 탭으로 나눈다.
    event.clipboardData.setData('text/plain', range ? rangeText(table, range, '\t') : item.text);
  });
}
