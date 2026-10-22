/**
 * CSV·TSV 글자를 표로 푼다. DOM 없이 도는 순수 함수다.
 *
 * - RFC 4180 따옴표: `""` 는 따옴표 하나, 따옴표 안의 구분자·줄바꿈은 글자로 둔다.
 * - 줄 끝은 CRLF·LF·CR 을 모두 받는다. 앞의 BOM 과 빈 줄은 건너뛴다.
 * - 닫히지 않은 따옴표나 닫는 따옴표 뒤에 글자가 이어지는 칸은 그 칸을 따옴표 없이 글자 그대로 읽는다.
 * - 정규식 없이 한 번 훑고, 닫는 따옴표는 마지막 따옴표 앞에서만 찾으므로 입력 길이에 비례한다.
 * - 행·열·글자 수에 상한을 두고, 넘거나 `partial`(앞부분만 읽은 입력)이면 truncated 로 알린다.
 *   앞부분만 읽은 입력의 끊긴 마지막 행은 버린다.
 */

export type CsvDelimiter = ',' | ';' | '\t' | '|';

export interface CsvCell {
  text: string;
  /** 원문에서 이 칸이 차지한 [start, end). 따옴표를 포함한다. 채운 빈 칸은 행 끝의 빈 범위다. */
  start: number;
  end: number;
}

export interface CsvTable {
  delimiter: CsvDelimiter;
  /** 모든 행을 columns 칸으로 채웠다. */
  rows: CsvCell[][];
  columns: number;
  /** 첫 행이 머리글로 보이는지. */
  header: boolean;
  /** 열마다 숫자 열인지 (머리글 제외). */
  numeric: boolean[];
  /** 상한에 걸렸거나 앞부분만 읽어 뒤에 행이 더 있다. */
  truncated: boolean;
  /** 표로 그릴 만한지. 열이 하나뿐이거나 행마다 칸 수가 들쭉날쭉하면 false. */
  tabular: boolean;
}

export interface CsvOptions {
  /** 없으면 앞부분으로 고른다. */
  delimiter?: CsvDelimiter;
  maxRows?: number;
  maxColumns?: number;
  maxChars?: number;
  /** 입력이 더 긴 파일의 앞부분이다. */
  partial?: boolean;
}

const DELIMITERS: readonly CsvDelimiter[] = [',', '\t', ';', '|'];
const QUOTE = 0x22;
const LF = 0x0a;
const CR = 0x0d;
const SNIFF_ROWS = 30;
const SNIFF_CHARS = 64 * 1024;

interface Scan {
  rows: CsvCell[][];
  /** 열 상한으로 자르기 전 행마다 칸 수. */
  widths: number[];
  truncated: boolean;
}

function scan(text: string, delimiter: CsvDelimiter, maxRows: number, maxColumns: number, maxChars: number, partial: boolean): Scan {
  const limit = Math.min(text.length, maxChars);
  // 읽는 범위 뒤로 글자가 더 있으면 마지막 행이 끊겼을 수 있다.
  const cut = partial || limit < text.length;
  const delim = delimiter.charCodeAt(0);
  const at = (index: number) => (index < limit ? text.charCodeAt(index) : -1);
  const ends = (code: number) => code === -1 || code === delim || code === LF || code === CR;
  const rows: CsvCell[][] = [];
  const widths: number[] = [];
  let truncated = cut;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  // 마지막 따옴표 뒤에서는 닫는 따옴표를 찾지 않는다. 그래서 indexOf 가 끝까지 헛도는 일이 없다.
  const lastQuote = limit > 0 ? text.lastIndexOf('"', limit - 1) : -1;

  /** i 에서 칸 하나를 읽고 i 를 칸 끝(구분자·줄 끝 앞)으로 옮긴다. 끊긴 앞부분이면 null. */
  const field = (): CsvCell | null => {
    const start = i;
    if (at(start) === QUOTE) {
      let value = '';
      let from = start + 1;
      for (;;) {
        const q = from <= lastQuote ? text.indexOf('"', from) : -1;
        if (q === -1) {
          if (cut) return null;
          break;
        }
        if (at(q + 1) === QUOTE) {
          value += text.slice(from, q + 1);
          from = q + 2;
          continue;
        }
        if (!ends(at(q + 1))) break;
        i = q + 1;
        return { text: value + text.slice(from, q), start, end: i };
      }
    }
    let k = start;
    while (!ends(at(k))) k += 1;
    i = k;
    return { text: text.slice(start, k), start, end: k };
  };

  while (i < limit) {
    if (rows.length >= maxRows) {
      truncated = true;
      break;
    }
    const row: CsvCell[] = [];
    let width = 0;
    let complete = true;
    for (;;) {
      const cell = field();
      if (!cell) {
        complete = false;
        break;
      }
      if (width < maxColumns) row.push(cell);
      else truncated = true;
      width += 1;
      const code = at(i);
      if (code === delim) {
        i += 1;
        continue;
      }
      if (code === CR) {
        i += 1;
        if (at(i) === LF) i += 1;
      } else if (code === LF) {
        i += 1;
      } else {
        complete = !cut;
      }
      break;
    }
    if (!complete) break;
    // 빈 줄은 행이 아니다.
    if (width === 1 && row[0].start === row[0].end) continue;
    rows.push(row);
    widths.push(width);
  }
  return { rows, widths, truncated };
}

/** 가장 흔한 칸 수와 그 칸 수인 행의 비율. */
function consistency(widths: readonly number[]): { mode: number; share: number } {
  if (!widths.length) return { mode: 0, share: 0 };
  const counts = new Map<number, number>();
  let mode = 0;
  let best = 0;
  for (const width of widths) {
    const count = (counts.get(width) ?? 0) + 1;
    counts.set(width, count);
    if (count > best || (count === best && width > mode)) {
      best = count;
      mode = width;
    }
  }
  return { mode, share: best / widths.length };
}

/** 앞쪽 행들을 후보 구분자마다 따옴표를 지키며 읽고, 칸 수가 가장 고른 것을 고른다. */
export function sniffDelimiter(text: string): CsvDelimiter {
  let chosen: CsvDelimiter = ',';
  let bestShare = 0;
  let bestMode = 0;
  for (const delimiter of DELIMITERS) {
    const { widths } = scan(text, delimiter, SNIFF_ROWS, Number.MAX_SAFE_INTEGER, SNIFF_CHARS, false);
    const { mode, share } = consistency(widths);
    if (mode < 2) continue;
    if (share > bestShare || (share === bestShare && mode > bestMode)) {
      chosen = delimiter;
      bestShare = share;
      bestMode = mode;
    }
  }
  return chosen;
}

const NUMBER = /^[-+]?[₩$€¥£]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?%?(?:\s?[₩$€¥£])?$|^[-+]?\.\d+%?$/u;
/** `;` 로 나눈 유럽식 파일: 천 단위 마침표, 소수 쉼표. */
const DECIMAL_COMMA_NUMBER = /^[-+]?[₩$€¥£]?(?:\d{1,3}(?:\.\d{3})+|\d+)(?:,\d+)?%?(?:\s?[₩$€¥£])?$|^[-+]?,\d+%?$/u;

/** 천 단위 구분, 통화 기호, 백분율을 허용한 숫자. decimalComma 면 소수점이 쉼표다. */
export function isNumericCell(value: string, decimalComma = false): boolean {
  const text = value.trim();
  if (!text || text.length > 32) return false;
  return NUMBER.test(text) || (decimalComma && DECIMAL_COMMA_NUMBER.test(text));
}

function numericColumns(rows: readonly CsvCell[][], columns: number, from: number, decimalComma: boolean): boolean[] {
  const filled = new Uint32Array(columns);
  const numbers = new Uint32Array(columns);
  for (let r = from; r < rows.length; r += 1) {
    const row = rows[r];
    for (let c = 0; c < row.length; c += 1) {
      if (!row[c].text.trim()) continue;
      filled[c] += 1;
      if (isNumericCell(row[c].text, decimalComma)) numbers[c] += 1;
    }
  }
  return Array.from(filled, (count, c) => numbers[c] > 0 && numbers[c] >= count * 0.8);
}

/**
 * 첫 행이 머리글인지 짐작한다. 숫자 열의 첫 칸이 숫자가 아니면 머리글 쪽, 숫자면 자료 쪽으로 센다.
 * 숫자 열이 없으면 첫 행이 비지 않고 겹치지 않는 짧은 이름들일 때 머리글로 본다.
 */
function guessHeader(rows: readonly CsvCell[][], columns: number, decimalComma: boolean): boolean {
  if (rows.length < 2) return false;
  const first = rows[0];
  const body = numericColumns(rows, columns, 1, decimalComma);
  let votes = 0;
  for (let c = 0; c < columns; c += 1) {
    if (!body[c]) continue;
    votes += isNumericCell(first[c]?.text ?? '', decimalComma) ? -1 : 1;
  }
  if (votes !== 0) return votes > 0;
  const names = first.slice(0, columns).map((cell) => cell.text.trim());
  return names.every((name) => name.length > 0 && name.length <= 64) && new Set(names).size === names.length;
}

export function parseCsv(text: string, options: CsvOptions = {}): CsvTable {
  const delimiter = options.delimiter ?? sniffDelimiter(text);
  const maxColumns = Math.max(1, options.maxColumns ?? 200);
  const scanned = scan(
    text,
    delimiter,
    Math.max(1, options.maxRows ?? 5_000),
    maxColumns,
    Math.max(1, options.maxChars ?? 2_000_000),
    options.partial ?? false,
  );
  let columns = 0;
  for (const row of scanned.rows) columns = Math.max(columns, row.length);
  for (const row of scanned.rows) {
    const end = row[row.length - 1].end;
    while (row.length < columns) row.push({ text: '', start: end, end });
  }
  const decimalComma = delimiter === ';';
  const header = guessHeader(scanned.rows, columns, decimalComma);
  const { mode, share } = consistency(scanned.widths);
  return {
    delimiter,
    rows: scanned.rows,
    columns,
    header,
    numeric: numericColumns(scanned.rows, columns, header ? 1 : 0, decimalComma),
    truncated: scanned.truncated,
    tabular: Math.min(mode, maxColumns) >= 2 && share >= 0.5,
  };
}

/** 원문 범위 [start, end) 와 겹치는 칸들. 행·열 번호로 돌려준다. */
export function cellsInRange(table: CsvTable, start: number, end: number): Array<{ row: number; column: number }> {
  const hits: Array<{ row: number; column: number }> = [];
  for (let r = 0; r < table.rows.length; r += 1) {
    const row = table.rows[r];
    if (row[0].start >= end) break;
    for (let c = 0; c < row.length; c += 1) {
      const cell = row[c];
      if (cell.start < end && cell.end > start) hits.push({ row: r, column: c });
    }
  }
  return hits;
}
