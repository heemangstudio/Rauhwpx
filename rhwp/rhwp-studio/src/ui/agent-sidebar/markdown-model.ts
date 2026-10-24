/**
 * 마크다운 편집기의 순수 모델: 블록 단위 파싱과 결정적 직렬화.
 *
 * 파서는 블록마다 원문(src)과 앞쪽 빈 줄(before)을 함께 돌려준다.
 * joinSource(parseMarkdown(text)) 는 늘 text 와 같고, 편집기는 손대지 않은 블록의 원문을
 * 그대로 다시 쓴다. 지원하지 않는 구조(표, HTML, 각주, 참조 링크, 머리말 등)는 raw 블록으로
 * 원문 그대로 남긴다. DOM 에 의존하지 않으므로 Node 테스트에서 바로 쓴다.
 */

export type Inline =
  | { t: 'text'; text: string }
  | { t: 'strong'; delim: string; children: Inline[] }
  | { t: 'em'; delim: string; children: Inline[] }
  | { t: 'code'; text: string }
  | { t: 'link'; dest: string; children: Inline[] }
  | { t: 'raw'; text: string }
  | { t: 'br' };

export interface ListItem {
  content: Inline[];
  children: ListBlock[];
}

export interface ListBlock {
  t: 'list';
  ordered: boolean;
  /** 글머리 문자(-, *, +) 또는 번호 구분자(., )). */
  marker: string;
  start: number;
  items: ListItem[];
}

export type Block =
  | { t: 'heading'; level: number; content: Inline[] }
  | { t: 'paragraph'; content: Inline[] }
  | ListBlock
  | { t: 'quote'; children: Block[] }
  | { t: 'code'; fence: string; info: string; text: string }
  | { t: 'hr' }
  | { t: 'raw'; text: string };

export type BlockKind = Block['t'];

export interface SourceBlock {
  block: Block;
  /** 블록의 원문(줄바꿈은 \n 으로 정규화, 끝 줄바꿈 제외). */
  src: string;
  /** 앞 블록 끝(또는 문서 시작)과 이 블록 사이의 원문. */
  before: string;
}

export interface ParsedMarkdown {
  blocks: SourceBlock[];
  /** 마지막 블록 뒤의 원문. 블록이 없으면 문서 전체. */
  tail: string;
  eol: '\n' | '\r\n';
}

// ── 줄 판별 ──────────────────────────────────────────────

const BLANK = /^[ \t]*$/;
const FENCE_OPEN = /^(`{3,}|~{3,})(.*)$/;
const ATX = /^(#{1,6})(?=[ \t]|$)(.*)$/;
const HR = /^([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const HTML_START = /^<(?:[A-Za-z][A-Za-z0-9-]*(?=[\s/>]|$)|\/[A-Za-z]|!--|!\[CDATA\[|![A-Za-z]|\?)/;
const LIST_ITEM = /^([-*+]|\d{1,9}[.)])(?:([ \t]+)(.*)|$)/;
const REF_DEF = /^\[[^\]]+\]:/;
const SETEXT = /^ {0,3}(?:=+|-+)[ \t]*$/;
const TABLE_DELIM = /^[ \t]*\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;

function isBlank(line: string): boolean {
  return BLANK.test(line);
}

/** 앞 공백 열 수(탭은 4열 경계까지). */
function indentOf(line: string): number {
  let col = 0;
  for (const ch of line) {
    if (ch === ' ') col += 1;
    else if (ch === '\t') col += 4 - (col % 4);
    else break;
  }
  return col;
}

function isTableDelim(line: string): boolean {
  return TABLE_DELIM.test(line) && (line.includes('|') || line.includes('-')) && /-/.test(line);
}

/** 문단을 끊는 블록 시작인가(들여쓰기 3칸 이하에서). */
function interruptsParagraph(line: string): boolean {
  if (indentOf(line) >= 4) return false;
  const t = line.trimStart();
  if (FENCE_OPEN.test(t) && !(t.startsWith('`') && t.slice(3).includes('`'))) return true;
  if (ATX.test(t) || HR.test(t) || t.startsWith('>') || HTML_START.test(t) || t.startsWith('$$')) return true;
  const item = LIST_ITEM.exec(t);
  if (item && item[3] && item[3].trim()) {
    if (!/\d/.test(item[1])) return true;
    return parseInt(item[1], 10) === 1;
  }
  return false;
}

/** 블록 구문으로 시작하는 줄인가(목록 이어짐 줄 판별용). */
function looksLikeBlockSyntax(t: string): boolean {
  return FENCE_OPEN.test(t) || ATX.test(t) || HR.test(t) || t.startsWith('>')
    || HTML_START.test(t) || t.startsWith('$$') || REF_DEF.test(t) || t.startsWith('|');
}

// ── 블록 파서 ────────────────────────────────────────────

interface Range { start: number; end: number; block: Block }

export function parseMarkdown(input: string): ParsedMarkdown {
  const eol: '\n' | '\r\n' = input.includes('\r\n') ? '\r\n' : '\n';
  const text = eol === '\r\n' ? input.replace(/\r\n/g, '\n') : input;
  const lines = text.split('\n');
  const ranges = parseRanges(lines, true);
  if (!ranges.length) return { blocks: [], tail: text, eol };
  const blocks: SourceBlock[] = [];
  let prevEnd = 0;
  ranges.forEach((range, index) => {
    const gap = lines.slice(prevEnd, range.start).map((line) => `${line}\n`).join('');
    blocks.push({
      block: range.block,
      src: lines.slice(range.start, range.end).join('\n'),
      before: index === 0 ? gap : `\n${gap}`,
    });
    prevEnd = range.end;
  });
  const tail = prevEnd < lines.length ? `\n${lines.slice(prevEnd).join('\n')}` : '';
  return { blocks, tail, eol };
}

/** 파싱 결과를 원문 그대로 다시 잇는다. parseMarkdown 의 역함수. */
export function joinSource(doc: ParsedMarkdown): string {
  const body = doc.blocks.map((block) => block.before + block.src).join('') + doc.tail;
  return doc.eol === '\r\n' ? body.replace(/\n/g, '\r\n') : body;
}

/** 블록 목록만 필요할 때(붙여넣기, 인용 안쪽). */
export function parseBlocks(text: string): Block[] {
  return parseMarkdown(text).blocks.map((block) => block.block);
}

function raw(lines: string[], start: number, end: number): Range {
  return { start, end, block: { t: 'raw', text: lines.slice(start, end).join('\n') } };
}

function untilBlank(lines: string[], from: number): number {
  let j = from;
  while (j < lines.length && !isBlank(lines[j])) j += 1;
  return j;
}

function parseRanges(lines: string[], top: boolean): Range[] {
  const out: Range[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) { i += 1; continue; }
    const previous = out.at(-1);
    const afterList = previous?.block.t === 'list' && previous.end < i;
    const indent = indentOf(line);
    const t = line.trimStart();

    // 머리말(front matter)
    if (top && i === 0 && /^(-{3}|\+{3})[ \t]*$/.test(line)) {
      const fence = line.trim();
      let j = 1;
      while (j < lines.length && !(lines[j].trim() === fence || (fence === '---' && lines[j].trim() === '...'))) j += 1;
      if (j < lines.length) { out.push(raw(lines, 0, j + 1)); i = j + 1; continue; }
    }
    // 느슨한 목록의 이어진 들여쓴 줄: 목록 소속을 바꾸지 않도록 원문 그대로.
    if (afterList && indent >= 1) {
      const end = untilBlank(lines, i);
      out.push(raw(lines, i, end));
      i = end;
      continue;
    }
    // 들여쓴 코드
    if (indent >= 4) {
      const end = untilBlank(lines, i);
      out.push(raw(lines, i, end));
      i = end;
      continue;
    }
    // 울타리 코드
    const fenceOpen = FENCE_OPEN.exec(t);
    if (fenceOpen && !(fenceOpen[1][0] === '`' && fenceOpen[2].includes('`'))) {
      const marker = fenceOpen[1];
      let j = i + 1;
      while (j < lines.length) {
        const close = lines[j];
        const ct = close.trimStart();
        if (indentOf(close) < 4 && ct.startsWith(marker[0].repeat(marker.length))
          && new RegExp(`^\\${marker[0]}{${marker.length},}[ \\t]*$`).test(ct)) break;
        j += 1;
      }
      if (j >= lines.length || indent > 0) {
        // 닫히지 않았거나 들여쓴 울타리는 원문 보존.
        const end = j >= lines.length ? lines.length : j + 1;
        out.push(raw(lines, i, end));
        i = end;
        continue;
      }
      out.push({
        start: i,
        end: j + 1,
        block: { t: 'code', fence: marker, info: fenceOpen[2].trim(), text: lines.slice(i + 1, j).join('\n') },
      });
      i = j + 1;
      continue;
    }
    // 수식 블록
    if (t.startsWith('$$')) {
      let j = i;
      if (!(t.length > 2 && t.trimEnd().endsWith('$$') && t.trim() !== '$$')) {
        j = i + 1;
        while (j < lines.length && !lines[j].includes('$$')) j += 1;
      }
      const end = Math.min(j + 1, lines.length);
      out.push(raw(lines, i, end));
      i = end;
      continue;
    }
    const atx = ATX.exec(t);
    if (atx) {
      const content = atx[2].trim().replace(/(^|[ \t]+)#+$/, '').trim();
      out.push({ start: i, end: i + 1, block: { t: 'heading', level: atx[1].length, content: parseInline(content) } });
      i += 1;
      continue;
    }
    if (HR.test(t)) {
      out.push({ start: i, end: i + 1, block: { t: 'hr' } });
      i += 1;
      continue;
    }
    if (HTML_START.test(t)) {
      let end: number;
      if (t.startsWith('<!--')) {
        let j = i;
        while (j < lines.length && !lines[j].includes('-->')) j += 1;
        end = Math.max(untilBlank(lines, Math.min(j, lines.length - 1)), Math.min(j + 1, lines.length));
      } else end = untilBlank(lines, i);
      out.push(raw(lines, i, end));
      i = end;
      continue;
    }
    if (t.startsWith('>')) {
      out.push(parseQuote(lines, i));
      i = out.at(-1)!.end;
      continue;
    }
    if (REF_DEF.test(t) || (t.includes('|') && i + 1 < lines.length && isTableDelim(lines[i + 1]))) {
      const end = untilBlank(lines, i);
      out.push(raw(lines, i, end));
      i = end;
      continue;
    }
    if (LIST_ITEM.test(t)) {
      out.push(parseList(lines, i));
      i = out.at(-1)!.end;
      continue;
    }
    out.push(parseParagraph(lines, i));
    i = out.at(-1)!.end;
  }
  return out;
}

function parseParagraph(lines: string[], start: number): Range {
  let j = start + 1;
  while (j < lines.length && !isBlank(lines[j])) {
    if (SETEXT.test(lines[j]) || (j === start + 1 && lines[start].includes('|') && isTableDelim(lines[j]))) {
      // 밑줄 제목·표는 원문 보존.
      return raw(lines, start, untilBlank(lines, j));
    }
    if (interruptsParagraph(lines[j])) break;
    j += 1;
  }
  const content: Inline[] = [];
  lines.slice(start, j).forEach((line, index) => {
    if (index) content.push({ t: 'br' });
    content.push(...parseInline(line.replace(/^[ \t]+/, '')));
  });
  return { start, end: j, block: { t: 'paragraph', content } };
}

function parseQuote(lines: string[], start: number): Range {
  let j = start;
  while (j < lines.length && indentOf(lines[j]) < 4 && lines[j].trimStart().startsWith('>')) j += 1;
  if (j < lines.length && !isBlank(lines[j])) {
    // 게으른 이어짐 줄이 있는 인용은 원문 보존.
    return raw(lines, start, untilBlank(lines, j));
  }
  const inner = lines.slice(start, j).map((line) => line.trimStart().replace(/^> ?/, '')).join('\n');
  return { start, end: j, block: { t: 'quote', children: parseBlocks(inner) } };
}

interface OpenItem { item: ListItem; contentCol: number }

function itemInfo(marker: string): { ordered: boolean; marker: string; number: number } {
  const ordered = /\d/.test(marker);
  return ordered
    ? { ordered, marker: marker.slice(-1), number: parseInt(marker, 10) }
    : { ordered, marker, number: 1 };
}

function parseList(lines: string[], start: number): Range {
  const first = itemInfo(LIST_ITEM.exec(lines[start].trimStart())![1]);
  const root: ListBlock = { t: 'list', ordered: first.ordered, marker: first.marker, start: first.number, items: [] };
  const stack: OpenItem[] = [];
  let opaque = false;
  let j = start;
  for (; j < lines.length; j += 1) {
    const line = lines[j];
    if (isBlank(line)) break;
    const indent = indentOf(line);
    const t = line.trimStart();
    const m = LIST_ITEM.exec(t);
    const deepest = stack.at(-1);
    if (m && deepest && indent >= deepest.contentCol + 4) {
      opaque = true;
      continue;
    }
    if (m) {
      // 목록 항목 시작 줄 안의 HR(- - -)은 목록이 아니다.
      if (HR.test(t)) {
        if (!stack.length || indent < 2) break;
        opaque = true;
        continue;
      }
      const info = itemInfo(m[1]);
      const spacing = m[2] ? indentOf(m[2]) : 1;
      const contentCol = indent + m[1].length + (spacing > 4 || !m[3] ? 1 : spacing);
      const item: ListItem = { content: [], children: [] };
      const text = m[3] ?? '';
      if (text) item.content.push(...parseInline(text.trim()));
      if (looksLikeBlockSyntax(text.trim()) || spacing > 4) opaque = true;
      while (stack.length && stack.at(-1)!.contentCol > indent) stack.pop();
      const parent = stack.at(-1);
      if (!parent) {
        if (stack.length === 0 && j !== start
          && (info.ordered !== root.ordered || info.marker !== root.marker)) break;
        root.items.push(item);
      } else {
        const lists = parent.item.children;
        let list = lists.at(-1);
        if (!list || list.ordered !== info.ordered || list.marker !== info.marker) {
          list = { t: 'list', ordered: info.ordered, marker: info.marker, start: info.number, items: [] };
          lists.push(list);
        }
        list.items.push(item);
      }
      stack.push({ item, contentCol });
      continue;
    }
    // 이어짐 줄
    if (indent < 2 && interruptsParagraph(line)) break;
    if (looksLikeBlockSyntax(t)) opaque = true;
    const target = stack.at(-1)!;
    target.item.content.push({ t: 'br' }, ...parseInline(t));
  }
  if (opaque) return raw(lines, start, j);
  return { start, end: j, block: root };
}

// ── 인라인 파서 ──────────────────────────────────────────

const PUNCT = /[!-/:-@[-`{-~]/;
const AUTOLINK_OR_HTML = /^<(?:[A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>]*|[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*|\/?[A-Za-z][A-Za-z0-9-]*(?:\s[^<>]*)?\/?|!--[\s\S]*?--)>/;

function isSpace(ch: string | undefined): boolean {
  return ch === undefined || /\s/.test(ch);
}

function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && /[\p{L}\p{N}]/u.test(ch);
}

function runLength(s: string, i: number, ch: string): number {
  let j = i;
  while (s[j] === ch) j += 1;
  return j - i;
}

/** i 의 백틱 묶음과 같은 길이로 닫히는 위치. 없으면 -1. */
function codeSpanClose(s: string, i: number): number {
  const run = runLength(s, i, '`');
  let j = i + run;
  while (j < s.length) {
    if (s[j] === '`') {
      const r = runLength(s, j, '`');
      if (r === run) return j;
      j += r;
    } else j += 1;
  }
  return -1;
}

interface LinkMatch { text: string; dest: string; end: number }

function matchLink(s: string, i: number): LinkMatch | null {
  let depth = 0;
  let k = i;
  for (; k < s.length; k += 1) {
    const ch = s[k];
    if (ch === '\\') { k += 1; continue; }
    if (ch === '`') {
      const close = codeSpanClose(s, k);
      if (close >= 0) { k = close + runLength(s, close, '`') - 1; continue; }
      k += runLength(s, k, '`') - 1;
      continue;
    }
    if (ch === '[') depth += 1;
    else if (ch === ']') {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  if (k >= s.length || s[k + 1] !== '(') return null;
  let p = k + 2;
  let parens = 0;
  if (s[p] === '<') {
    const close = s.indexOf('>', p);
    if (close < 0) return null;
    p = close + 1;
  }
  for (; p < s.length; p += 1) {
    const ch = s[p];
    if (ch === '\\') { p += 1; continue; }
    if (ch === '(') parens += 1;
    else if (ch === ')') {
      if (parens === 0) break;
      parens -= 1;
    }
  }
  if (p >= s.length) return null;
  return { text: s.slice(i + 1, k), dest: s.slice(k + 2, p), end: p + 1 };
}

function canOpen(s: string, i: number, len: number, ch: string): boolean {
  const next = s[i + len];
  if (isSpace(next)) return false;
  if (ch === '_' && isWordChar(s[i - 1])) return false;
  return true;
}

function findClose(s: string, from: number, len: number, ch: string): number {
  let j = from;
  while (j < s.length) {
    const c = s[j];
    if (c === '\\') { j += 2; continue; }
    if (c === '`') {
      const close = codeSpanClose(s, j);
      j = close >= 0 ? close + runLength(s, close, '`') : j + runLength(s, j, '`');
      continue;
    }
    if (c === '[') {
      const link = matchLink(s, j);
      if (link) { j = link.end; continue; }
    }
    if (c === ch) {
      const run = runLength(s, j, ch);
      const okPrev = !isSpace(s[j - 1]) && j > from;
      const okNext = ch !== '_' || !isWordChar(s[j + run]);
      if (okPrev && okNext) {
        if (run === len) return j;
        if (run > len && len === 2) return j + run - 2;
        if (run === 3 && len === 1) return j + 2;
      }
      j += run;
      continue;
    }
    j += 1;
  }
  return -1;
}

export function parseInline(s: string): Inline[] {
  const out: Inline[] = [];
  let buf = '';
  const flush = () => {
    if (buf) out.push({ t: 'text', text: buf });
    buf = '';
  };
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length && PUNCT.test(s[i + 1])) {
      buf += s[i + 1];
      i += 2;
      continue;
    }
    if (c === '`') {
      const close = codeSpanClose(s, i);
      const run = runLength(s, i, '`');
      if (close < 0) { buf += s.slice(i, i + run); i += run; continue; }
      let code = s.slice(i + run, close);
      if (code.length > 1 && code.startsWith(' ') && code.endsWith(' ') && code.trim()) code = code.slice(1, -1);
      flush();
      out.push({ t: 'code', text: code });
      i = close + run;
      continue;
    }
    if (c === '!' && s[i + 1] === '[') {
      const link = matchLink(s, i + 1);
      if (link) {
        flush();
        out.push({ t: 'raw', text: s.slice(i, link.end) });
        i = link.end;
        continue;
      }
    }
    if (c === '[') {
      const link = matchLink(s, i);
      if (link) {
        flush();
        out.push({ t: 'link', dest: link.dest, children: parseInline(link.text) });
        i = link.end;
        continue;
      }
    }
    if (c === '<') {
      const m = AUTOLINK_OR_HTML.exec(s.slice(i));
      if (m) {
        flush();
        out.push({ t: 'raw', text: m[0] });
        i += m[0].length;
        continue;
      }
    }
    if (c === '*' || c === '_') {
      const run = runLength(s, i, c);
      if (run >= 2 && canOpen(s, i, 2, c)) {
        const close = findClose(s, i + 2, 2, c);
        if (close > i + 2) {
          flush();
          out.push({ t: 'strong', delim: c + c, children: parseInline(s.slice(i + 2, close)) });
          i = close + 2;
          continue;
        }
      }
      if (canOpen(s, i, 1, c)) {
        const close = findClose(s, i + 1, 1, c);
        if (close > i + 1) {
          flush();
          out.push({ t: 'em', delim: c, children: parseInline(s.slice(i + 1, close)) });
          i = close + 1;
          continue;
        }
      }
      buf += s.slice(i, i + run);
      i += run;
      continue;
    }
    buf += c;
    i += 1;
  }
  flush();
  return out;
}

// ── 직렬화 ───────────────────────────────────────────────

/** 비교용 정규형: 인접 글자 합치기, 빈 글자·빈 서식 제거, 겹친 같은 서식 펴기, 구분자 무시. */
export function normalizeInline(nodes: Inline[], ctx = { strong: false, em: false, link: false }): unknown[] {
  const out: unknown[] = [];
  const pushText = (text: string) => {
    if (!text) return;
    const last = out.at(-1) as { t?: string; text?: string } | undefined;
    if (last?.t === 'text') last.text += text;
    else out.push({ t: 'text', text });
  };
  const spread = (items: unknown[]) => {
    for (const item of items) {
      const node = item as { t: string; text?: string };
      if (node.t === 'text') pushText(node.text ?? '');
      else out.push(item);
    }
  };
  for (const node of nodes) {
    if (node.t === 'text') pushText(node.text);
    else if (node.t === 'strong' || node.t === 'em' || node.t === 'link') {
      const key = node.t;
      const children = normalizeInline(node.children, { ...ctx, [key]: true });
      if (ctx[key]) spread(children);
      else if (node.t === 'link') out.push({ t: 'link', dest: node.dest, children });
      else if (children.length) out.push({ t: node.t, children });
    } else if (node.t === 'code') { if (node.text) out.push({ t: 'code', text: node.text }); }
    else if (node.t === 'raw') { if (node.text) out.push({ t: 'raw', text: node.text }); }
    else out.push({ t: 'br' });
  }
  return out;
}

/** br 기준으로 줄을 나눈다. 서식이 줄을 넘으면 줄마다 같은 서식으로 쪼갠다. */
export function splitInlineLines(nodes: Inline[]): Inline[][] {
  const lines: Inline[][] = [[]];
  for (const node of nodes) {
    if (node.t === 'br') { lines.push([]); continue; }
    if (node.t === 'text' && node.text.includes('\n')) {
      node.text.split('\n').forEach((part, index) => {
        if (index) lines.push([]);
        if (part) lines.at(-1)!.push({ t: 'text', text: part });
      });
      continue;
    }
    if (node.t === 'strong' || node.t === 'em' || node.t === 'link') {
      splitInlineLines(node.children).forEach((part, index) => {
        if (index) lines.push([]);
        if (part.length) lines.at(-1)!.push({ ...node, children: part });
      });
      continue;
    }
    lines.at(-1)!.push(node);
  }
  return lines;
}

interface InlineMode { aggressive: boolean; plainDelims: boolean }
interface InlineContext { strong: boolean; em: boolean; link: boolean }

function escapeText(text: string, mode: InlineMode, next: Inline | undefined): string {
  let out = text.replace(/\\(?=[!-/:-@[-`{-~]|$)/g, '\\\\').replace(/`/g, '\\`').replace(/<(?=[A-Za-z/!?])/g, '\\<');
  if (mode.aggressive) out = out.replace(/[*_[\]]/g, (ch) => `\\${ch}`).replace(/!(?=\\\[|$)/g, '\\!');
  if (next?.t === 'link' && out.endsWith('!')) out = `${out.slice(0, -1)}\\!`;
  return out;
}

function wrapDelim(inner: string, delim: string): string {
  const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(inner)!;
  if (!m[2]) return inner;
  return `${m[1]}${delim}${m[2]}${delim}${m[3]}`;
}

function serializeCode(text: string): string {
  if (!text) return '';
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(longest + 1);
  const pad = text.startsWith('`') || text.endsWith('`') || (text.startsWith(' ') && text.endsWith(' ') && text.trim()) ? ' ' : '';
  return `${fence}${pad}${text}${pad}${fence}`;
}

function serializeInlineWith(nodes: Inline[], mode: InlineMode, ctx: InlineContext = { strong: false, em: false, link: false }): string {
  let out = '';
  nodes.forEach((node, index) => {
    const next = nodes[index + 1];
    switch (node.t) {
      case 'text': out += escapeText(node.text, mode, next); break;
      case 'br': out += '\n'; break;
      case 'raw': out += node.text; break;
      case 'code': out += serializeCode(node.text); break;
      case 'link':
        // 링크 안의 링크는 글자만 남긴다.
        out += ctx.link ? serializeInlineWith(node.children, mode, ctx)
          : `[${serializeInlineWith(node.children, mode, { ...ctx, link: true })}](${node.dest})`;
        break;
      case 'strong': {
        // 굵게 안의 굵게(브라우저가 겹쳐 만든 것)는 한 겹으로.
        if (ctx.strong) { out += serializeInlineWith(node.children, mode, ctx); break; }
        const inner = serializeInlineWith(node.children, mode, { ...ctx, strong: true });
        const delim = !mode.plainDelims && node.delim === '__' ? '__' : '**';
        out += wrapDelim(inner, delim);
        break;
      }
      case 'em': {
        if (ctx.em) { out += serializeInlineWith(node.children, mode, ctx); break; }
        const inner = serializeInlineWith(node.children, mode, { ...ctx, em: true });
        let delim = !mode.plainDelims && node.delim === '_' ? '_' : '*';
        const core = inner.trim();
        if (delim === '*' && (core.startsWith('*') || core.endsWith('*'))) delim = '_';
        out += wrapDelim(inner, delim);
        break;
      }
    }
  });
  return out;
}

/** 한 줄 인라인 직렬화. 다시 파싱해 같은 구조가 나오는 가장 덜 이스케이프한 형태를 고른다. */
export function serializeInline(nodes: Inline[]): string {
  const target = JSON.stringify(normalizeInline(nodes));
  const modes: InlineMode[] = [
    { aggressive: false, plainDelims: false },
    { aggressive: false, plainDelims: true },
    { aggressive: true, plainDelims: true },
  ];
  let last = '';
  for (const mode of modes) {
    last = serializeInlineWith(nodes, mode);
    if (JSON.stringify(normalizeInline(parseInline(last))) === target) return last;
  }
  return last;
}

/** 줄 머리가 다른 블록으로 읽히지 않게 이스케이프한다. */
function escapeLineStart(line: string, continuation: boolean): string {
  const s = line.replace(/^[ \t]+/, '');
  if (/^#{1,6}(?:[ \t]|$)/.test(s) || /^(?:`{3}|~{3})/.test(s) || /^[>|]/.test(s) || /^\$\$/.test(s)) return `\\${s}`;
  if (HR.test(s) || /^[-*+](?:[ \t]|$)/.test(s)) return `\\${s}`;
  if (continuation && /^=+[ \t]*$/.test(s)) return `\\${s}`;
  if (HTML_START.test(s) && !s.startsWith('\\')) return `\\${s}`;
  if (REF_DEF.test(s)) return `\\${s}`;
  const ordered = /^(\d{1,9})([.)])(?=[ \t]|$)/.exec(s);
  if (ordered) return `${ordered[1]}\\${s.slice(ordered[1].length)}`;
  return s;
}

function inlineLines(content: Inline[]): string[] {
  const lines = splitInlineLines(content).map((line) => serializeInline(line));
  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines.at(-1)!.trim()) lines.pop();
  return lines.map((line, index) => escapeLineStart(line, index > 0));
}

function serializeList(list: ListBlock, indent: string): string[] {
  const out: string[] = [];
  list.items.forEach((item, index) => {
    const marker = list.ordered ? `${list.start + index}${list.marker}` : list.marker;
    const pad = ' '.repeat(marker.length + 1);
    const lines = inlineLines(item.content).filter((line) => line.trim());
    out.push(`${indent}${marker}${lines[0] ? ` ${lines[0]}` : ''}`);
    for (const line of lines.slice(1)) out.push(`${indent}${pad}${line}`);
    for (const child of item.children) out.push(...serializeList(child, indent + pad));
  });
  return out;
}

/** 블록 하나의 마크다운(끝 줄바꿈 없음). 빈 블록은 ''. */
export function serializeBlock(block: Block): string {
  switch (block.t) {
    case 'heading': {
      let text = splitInlineLines(block.content).map((line) => serializeInline(line).trim()).filter(Boolean).join(' ');
      if (!text) return '';
      if (text.endsWith('#')) text = `${text.slice(0, -1)}\\#`;
      return `${'#'.repeat(block.level)} ${text}`;
    }
    case 'paragraph':
      return inlineLines(block.content).join('\n');
    case 'list':
      return block.items.length ? serializeList(block, '').join('\n') : '';
    case 'quote': {
      const inner = block.children.map(serializeBlock).filter(Boolean).join('\n\n');
      if (!inner) return '';
      return inner.split('\n').map((line) => (line ? `> ${line}` : '>')).join('\n');
    }
    case 'code': {
      const ch = block.fence[0] === '~' ? '~' : '`';
      const longest = Math.max(0, ...(block.text.match(ch === '`' ? /`+/g : /~+/g) ?? []).map((run) => run.length));
      const fence = ch.repeat(Math.max(3, block.fence.length, longest + 1));
      return block.text ? `${fence}${block.info}\n${block.text}\n${fence}` : `${fence}${block.info}\n${fence}`;
    }
    case 'hr':
      return '---';
    case 'raw':
      return block.text;
  }
}

export function serializeBlocks(blocks: Block[]): string {
  return blocks.map(serializeBlock).filter(Boolean).join('\n\n');
}

/** 링크 주소를 마크다운 목적지로. 공백·괄호가 있으면 <>로 감싼다. */
export function formatLinkDestination(url: string): string {
  const trimmed = url.trim();
  if (/[\s()<>]/.test(trimmed)) return `<${trimmed.replace(/</g, '%3C').replace(/>/g, '%3E')}>`;
  return trimmed;
}

/** 목적지 원문에서 주소만 꺼낸다(제목·<> 제거). */
export function linkHref(dest: string): string {
  const d = dest.trim();
  if (d.startsWith('<')) {
    const close = d.indexOf('>');
    return close > 0 ? d.slice(1, close) : d;
  }
  return d.split(/[ \t]+/)[0] ?? '';
}

// ── 편집 결과 조립 ───────────────────────────────────────

export interface EmittedBlock {
  /** 편집 후 블록 마크다운. */
  markdown: string;
  /** 렌더한 원래 블록 번호(없으면 새 블록). */
  origin: number | null;
  kind: BlockKind;
}

export interface OriginalBlockMeta {
  src: string;
  before: string;
  /** 렌더 직후 DOM 에서 다시 읽은 직렬화. 같으면 손대지 않은 블록이다. */
  canon: string;
  kind: BlockKind;
}

/**
 * 편집된 블록 목록을 문서로 잇는다. 손대지 않은 블록은 원문, 원래 이웃끼리는 원래 빈 줄을 쓴다.
 */
export function assembleDocument(
  emitted: EmittedBlock[],
  originals: OriginalBlockMeta[],
  tail: string,
  eol: '\n' | '\r\n',
): string {
  const consumed = new Set<number>();
  let out = '';
  let count = 0;
  let prevOrigin = -2;
  let prevSameKind = false;
  for (const block of emitted) {
    if (!block.markdown.trim()) continue;
    const meta = block.origin !== null && !consumed.has(block.origin) ? originals[block.origin] : undefined;
    const origin = meta ? block.origin! : null;
    const verbatim = Boolean(meta && block.markdown === meta.canon);
    const text = verbatim ? meta!.src : block.markdown;
    const sameKind = Boolean(meta && meta.kind === block.kind);
    let gap: string;
    if (count === 0) gap = meta && origin === 0 ? meta.before : '';
    else if (meta && origin === prevOrigin + 1 && (/\n[ \t]*\n/.test(meta.before) || (sameKind && prevSameKind))) gap = meta.before;
    else gap = '\n\n';
    out += gap + text;
    count += 1;
    if (origin !== null) consumed.add(origin);
    prevOrigin = origin ?? -2;
    prevSameKind = sameKind;
  }
  if (!count) return '';
  out += originals.length ? tail : '\n';
  return eol === '\r\n' ? out.replace(/\r?\n/g, '\r\n') : out;
}
