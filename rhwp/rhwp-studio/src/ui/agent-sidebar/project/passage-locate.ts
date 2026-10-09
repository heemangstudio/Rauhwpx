/**
 * 인용 조각을 PDF 텍스트 층 범위로 옮긴다. DOM 없이 도는 순수 함수다.
 *
 * 허브(reference-extractor.mjs collectPdfPages + chunkReferenceText)는 쪽마다
 * pdfjs item 을 놓인 자리대로 잇고(createPdfTextJoiner), 쪽 전체를 NFKC 로
 * 정규화한 뒤 앞뒤 공백을 지운 문자열에서 1200자 조각의 {start,end} 를 잰다.
 * 여기서는 같은 규칙으로 같은 문자열을 다시 만들면서 글자마다 (item, item 안
 * 위치) 를 기억해, 조각 위치를 텍스트 층 스팬의 범위로 되돌린다. 위치가 맞지
 * 않으면 공백을 무시한 검색으로 찾는다.
 */

export interface PassageChunk {
  start: number;
  end: number;
  text: string;
}

export interface PassageCitation {
  chunk?: PassageChunk | null;
  /** 그대로 옮긴 인용. 조각 안에서 찾으면 강조를 이 구절로 좁힌다. */
  quote?: string | null;
}

/** pdfjs TextItem 중 잇기에 쓰는 값. 문자열만 주면 자리 정보 없는 item 으로 본다. */
export interface PdfTextItem {
  str: string;
  transform?: readonly number[];
  width?: number;
  height?: number;
  dir?: string;
  hasEOL?: boolean;
}

export type PageItem = string | PdfTextItem;

/** 텍스트 층 items[item] 문자열 안의 [start, end) — 원래 item.str 기준이다. */
export interface ItemRange {
  item: number;
  start: number;
  end: number;
}

export interface TextMatch {
  start: number;
  end: number;
  /** 강조가 인용 구절로 좁혀졌는지, 조각 전체인지. */
  matched: 'quote' | 'chunk';
  /** 허브가 준 위치가 그대로 맞았는지. false 면 검색으로 찾았다. */
  exact: boolean;
}

export interface PassageMatch extends TextMatch {
  ranges: ItemRange[];
}

export interface PageText {
  /** 허브와 같은 쪽 문자열. */
  text: string;
  /** text[i] 를 만든 item 번호. 잇는 공백은 -1. */
  item: Int32Array;
  /** text[i] 를 만든 원문 구간 [from, to). */
  from: Int32Array;
  to: Int32Array;
}

/* ── item 잇기 — 허브 createPdfTextJoiner 와 한 글자도 다르면 안 된다 ── */
// rhwp-agent/tests/fixtures/pdf-join-cases.json 을 양쪽 테스트가 함께 확인한다.

const PDF_SAME_LINE_FACTOR = 0.5;
const PDF_WORD_GAP_FACTOR = 0.2;
const PDF_SAME_AXIS_COS = 0.985;

interface ItemGeometry {
  x: number;
  y: number;
  ux: number;
  uy: number;
  size: number;
  advance: number;
}

function pdfItemGeometry(item: PdfTextItem): ItemGeometry | null {
  const t = item.transform;
  if (!Array.isArray(t) || t.length < 6 || !t.slice(0, 6).every(Number.isFinite)) return null;
  const vertical = item.dir === 'ttb';
  const axis = vertical ? Math.hypot(t[2]!, t[3]!) : Math.hypot(t[0]!, t[1]!);
  if (!(axis > 0)) return null;
  const ux = vertical ? -t[2]! / axis : t[0]! / axis;
  const uy = vertical ? -t[3]! / axis : t[1]! / axis;
  const size = (vertical ? Math.hypot(t[0]!, t[1]!) : Math.hypot(t[2]!, t[3]!))
    || Number(vertical ? item.width : item.height);
  if (!(size > 0)) return null;
  const advance = Number(vertical ? item.height : item.width);
  return { x: t[4]!, y: t[5]!, ux, uy, size, advance: advance > 0 ? advance : 0 };
}

function pdfGeometrySeparator(a: ItemGeometry | null, b: ItemGeometry | null): string {
  if (!a || !b) return ' ';
  const size = Math.max(a.size, b.size);
  if (a.ux * b.ux + a.uy * b.uy < PDF_SAME_AXIS_COS) return '\n';
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (Math.abs(dy * a.ux - dx * a.uy) > PDF_SAME_LINE_FACTOR * size) return '\n';
  const along = dx * a.ux + dy * a.uy;
  let gap = 0;
  if (along >= a.advance) gap = along - a.advance;
  else if (along + b.advance <= 0) gap = -(along + b.advance);
  return gap > PDF_WORD_GAP_FACTOR * size ? ' ' : '';
}

/**
 * item 을 차례로 받아 그 앞에 넣을 구분자를 돌려준다. 글자를 보태지 않는 item 은 null.
 * 공백뿐인 item 은 낱말 사이만 표시하고, hasEOL 이나 기준선이 바뀌면 '\n',
 * 같은 줄에서 0.2em 넘게 떨어지면 ' ', 붙어 있으면 '' 이다. 자리 정보가 없으면 ' '.
 */
export function createPdfTextJoiner(): (item: PdfTextItem) => string | null {
  let prev: { geometry: ItemGeometry | null; str: string } | null = null;
  let pendingBreak = false;
  let pendingSpace = false;
  return (item) => {
    const str = typeof item?.str === 'string' ? item.str : '';
    if (!str.trim()) {
      if (prev) {
        if (str) pendingSpace = true;
        if (item?.hasEOL) pendingBreak = true;
      }
      return null;
    }
    const geometry = pdfItemGeometry(item);
    let separator = '';
    if (prev) {
      separator = pendingBreak ? '\n' : pdfGeometrySeparator(prev.geometry, geometry);
      if (separator === '' && pendingSpace) separator = ' ';
      if (separator === ' ' && (/\s$/u.test(prev.str) || /^\s/u.test(str))) separator = '';
    }
    prev = { geometry, str };
    pendingBreak = Boolean(item.hasEOL);
    pendingSpace = false;
    return separator;
  };
}

/* ── 쪽 문자열과 글자별 출처 표 ─────────────────────────── */

/** 결합 문자와 한글 중·종성 자모를 앞 글자에 붙여, 정규화가 서로 영향을 주는 단위로 나눈다. */
const RE_NORMALIZATION_UNIT = /[\s\S][\p{M}ᅠ-ᇿힰ-퟿]*/gu;

interface Unit {
  from: number;
  to: number;
  text: string;
}

/** 원문 [from, to) 를 NFKC 로 정규화해도 서로 섞이지 않는 단위로 나눈다. */
function normalizationUnits(source: string): Unit[] {
  const units: Unit[] = [];
  for (const match of source.matchAll(RE_NORMALIZATION_UNIT)) {
    const from = match.index ?? 0;
    const to = from + match[0].length;
    const last = units[units.length - 1];
    const text = match[0].normalize('NFKC');
    // 이웃 단위와 합쳐 정규화한 결과가 다르면 한 단위로 묶는다.
    if (last && source.slice(last.from, to).normalize('NFKC') !== last.text + text) {
      last.to = to;
      last.text = source.slice(last.from, to).normalize('NFKC');
    } else {
      units.push({ from, to, text });
    }
  }
  if (units.map((unit) => unit.text).join('') !== source.normalize('NFKC')) {
    return [{ from: 0, to: source.length, text: source.normalize('NFKC') }];
  }
  return units;
}

function itemText(item: PageItem): PdfTextItem {
  return typeof item === 'string' ? { str: item } : item;
}

/** 허브와 같은 쪽 문자열과 글자별 출처 표를 만든다. */
export function buildPageText(items: readonly PageItem[]): PageText {
  // 허브처럼 먼저 원문을 잇고, 원문 글자마다 (item, item 안 위치) 를 적는다.
  const join = createPdfTextJoiner();
  let raw = '';
  const rawItem: number[] = [];
  const rawOffset: number[] = [];
  items.forEach((entry, index) => {
    const item = itemText(entry);
    const separator = join(item);
    if (separator === null) return;
    for (let k = 0; k < separator.length; k += 1) {
      rawItem.push(-1);
      rawOffset.push(0);
    }
    raw += separator + item.str;
    for (let k = 0; k < item.str.length; k += 1) {
      rawItem.push(index);
      rawOffset.push(k);
    }
  });
  // 쪽 전체를 정규화한다. 단위가 item 을 넘으면 첫 item 에 붙인다.
  let out = '';
  const item: number[] = [];
  const from: number[] = [];
  const to: number[] = [];
  for (const unit of normalizationUnits(raw)) {
    const owner = rawItem[unit.from] ?? -1;
    let last = unit.from;
    while (last + 1 < unit.to && rawItem[last + 1] === owner) last += 1;
    const start = owner < 0 ? 0 : rawOffset[unit.from]!;
    const end = owner < 0 ? 0 : rawOffset[last]! + 1;
    out += unit.text;
    for (let k = 0; k < unit.text.length; k += 1) {
      item.push(owner);
      from.push(start);
      to.push(end);
    }
  }
  const lead = out.length - out.trimStart().length;
  const text = out.trim();
  return {
    text,
    item: Int32Array.from(item.slice(lead, lead + text.length)),
    from: Int32Array.from(from.slice(lead, lead + text.length)),
    to: Int32Array.from(to.slice(lead, lead + text.length)),
  };
}

/* ── 공백을 무시한 검색 ─────────────────────────────────── */

interface Compact {
  text: string;
  /** compact 글자 → 원문 위치. */
  index: number[];
}

function compact(source: string, start = 0, end = source.length): Compact {
  let text = '';
  const index: number[] = [];
  for (let i = start; i < end; i += 1) {
    const ch = source[i]!;
    if (/\s/u.test(ch)) continue;
    const lowered = ch.toLowerCase();
    // 소문자로 바꿔 길이가 달라지는 글자는 그대로 둔다 — 위치 표가 어긋나지 않게.
    text += lowered.length === 1 ? lowered : ch;
    index.push(i);
  }
  return { text, index };
}

function prepareNeedle(value: string): string {
  return compact(value.normalize('NFKC')).text;
}

/** hint 에 가장 가까운 등장 위치. */
function nearestOccurrence(haystack: string, needle: string, hint: number, from = 0, to = haystack.length): number {
  if (!needle) return -1;
  let best = -1;
  let cursor = haystack.indexOf(needle, from);
  while (cursor >= 0 && cursor + needle.length <= to) {
    if (best < 0 || Math.abs(cursor - hint) < Math.abs(best - hint)) best = cursor;
    if (cursor > hint && best >= 0 && cursor - hint > Math.abs(best - hint)) break;
    cursor = haystack.indexOf(needle, cursor + 1);
  }
  return best;
}

function compactPosition(page: Compact, offset: number): number {
  // offset 이상인 첫 compact 글자. 이진 탐색.
  let lo = 0;
  let hi = page.index.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (page.index[mid]! < offset) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** compact 범위 [cs, ce) 를 원문 범위로. */
function expand(page: Compact, cs: number, ce: number): { start: number; end: number } {
  return { start: page.index[cs]!, end: page.index[ce - 1]! + 1 };
}

const ANCHOR_CHARS = 48;

/** 조각이 놓인 원문 범위를 찾는다. 허브 위치가 맞으면 그대로, 아니면 검색한다. */
function locateChunk(text: string, page: Compact, chunk: PassageChunk): { start: number; end: number; exact: boolean } | null {
  const target = chunk.text.normalize('NFKC').trim();
  if (!target) return null;
  const start = Math.max(0, Math.min(text.length, chunk.start));
  const end = Math.max(start, Math.min(text.length, chunk.end));
  const slice = text.slice(start, end);
  if (slice.trim() === target) {
    const lead = slice.length - slice.trimStart().length;
    return { start: start + lead, end: start + lead + target.length, exact: true };
  }
  const needle = prepareNeedle(target);
  if (!needle) return null;
  const hint = compactPosition(page, start);
  const whole = nearestOccurrence(page.text, needle, hint);
  if (whole >= 0) return { ...expand(page, whole, whole + needle.length), exact: false };
  // 글자 몇 개가 달라도 앞뒤 머리로 범위를 잡는다.
  const span = Math.min(ANCHOR_CHARS, needle.length);
  const head = nearestOccurrence(page.text, needle.slice(0, span), hint);
  const window = Math.ceil(needle.length * 1.25) + 64;
  if (head >= 0) {
    const tailNeedle = needle.slice(-span);
    const tail = nearestOccurrence(page.text, tailNeedle, head + needle.length - span, head, Math.min(page.text.length, head + window));
    const ce = tail >= 0 ? tail + span : Math.min(page.text.length, head + needle.length);
    return { ...expand(page, head, ce), exact: false };
  }
  const tail = nearestOccurrence(page.text, needle.slice(-span), hint + needle.length - span);
  if (tail >= 0) {
    const cs = Math.max(0, tail + span - needle.length);
    return { ...expand(page, cs, tail + span), exact: false };
  }
  return null;
}

/**
 * 허브 쪽 문자열(또는 읽기 보기 본문)에서 인용 범위를 찾는다.
 * 조각이 있으면 조각 안에서 인용 구절로 좁히고, 구절을 찾지 못하면 조각 전체를 돌려준다.
 * 조각 없이 인용만 있으면 쪽 전체에서 구절을 찾는다.
 */
export function locateInText(text: string, citation: PassageCitation): TextMatch | null {
  const page = compact(text);
  const quote = citation.quote ? prepareNeedle(citation.quote) : '';
  if (citation.chunk) {
    const found = locateChunk(text, page, citation.chunk);
    if (!found) return null;
    if (quote) {
      const cs = compactPosition(page, found.start);
      const ce = compactPosition(page, found.end);
      const at = nearestOccurrence(page.text, quote, cs, cs, ce);
      if (at >= 0) return { ...expand(page, at, at + quote.length), matched: 'quote', exact: found.exact };
    }
    return { start: found.start, end: found.end, matched: 'chunk', exact: found.exact };
  }
  if (!quote) return null;
  const at = nearestOccurrence(page.text, quote, 0);
  return at >= 0 ? { ...expand(page, at, at + quote.length), matched: 'quote', exact: false } : null;
}

/** 쪽 문자열 범위를 item 별 범위로 바꾼다. */
export function rangesForPageSpan(page: PageText, start: number, end: number): ItemRange[] {
  const ranges: ItemRange[] = [];
  let current: ItemRange | null = null;
  for (let i = Math.max(0, start); i < Math.min(end, page.text.length); i += 1) {
    const item = page.item[i]!;
    if (item < 0) continue;
    if (current && current.item === item) {
      current.start = Math.min(current.start, page.from[i]!);
      current.end = Math.max(current.end, page.to[i]!);
      continue;
    }
    current = { item, start: page.from[i]!, end: page.to[i]! };
    ranges.push(current);
  }
  return ranges;
}

/** 텍스트 층 item 문자열과 인용으로 강조할 스팬 범위를 구한다. 찾지 못하면 null. */
export function locatePassage(items: readonly PageItem[], citation: PassageCitation): PassageMatch | null {
  const page = buildPageText(items);
  const match = locateInText(page.text, citation);
  if (!match) return null;
  const ranges = rangesForPageSpan(page, match.start, match.end);
  return ranges.length ? { ...match, ranges } : null;
}
