/**
 * 계획 문서용 Markdown 직렬화 + 안전 렌더러.
 *
 * 의존성이 없고 innerHTML 을 쓰지 않는다. 모든 텍스트는 createTextNode /
 * textContent 로만 들어가므로 원문에 섞인 HTML 은 그대로 글자로 남는다.
 * 링크는 기본적으로 표시 문자열만 남기며, 채팅 렌더러가 허용한 안전한
 * 프로토콜만 선택적으로 클릭 대상으로 만든다.
 */

import type { StructuredPlan, StructuredPlanStep } from '../../agent/types.ts';
import { readWikilinkAt, type WikilinkAnchor } from './wikilinks.ts';

/* ── DOM 최소 계약 ─────────────────────────────────────────
   실제 Document·HTMLElement 가 구조적으로 이 형태를 만족한다.
   테스트는 같은 모양의 가짜 노드를 넘겨 DOM 없이 검증한다. */
export interface MarkdownNode {
  textContent: string | null;
  appendChild(child: never): unknown;
  setAttribute?(name: string, value: string): void;
  className?: string;
}

export interface MarkdownHost {
  createElement(tag: string): MarkdownNode;
  createTextNode(text: string): MarkdownNode;
  createDocumentFragment(): MarkdownNode;
}

export interface MarkdownRenderOptions {
  /** 채팅에서만 안전한 http(s)·mailto 링크를 실제 링크로 만든다. */
  links?: boolean;
  /** 수식 노드를 외부 렌더러(KaTeX 등)에 맡긴다. false면 원문을 보존한다. */
  renderMath?: (node: MarkdownNode, source: string, displayMode: boolean, raw: string) => boolean;
  /** 파일 경로처럼 보이는 인라인 코드에 확장자 배지를 붙인다. */
  fileChips?: boolean;
  /** 인용 표기 `[[id…]]` 를 칩으로 그린다. 없거나 null 을 돌려주면 원문 그대로 둔다. */
  citation?: (token: WikilinkToken) => MarkdownNode | null;
}

/* ── 한계값 ────────────────────────────────────────────────
   비정상적으로 큰 입력에서도 렌더 시간이 선형에 머물도록 자른다. */
export const MD_LIMITS = {
  maxChars: 120_000,
  maxLines: 4_000,
  maxBlocks: 1_200,
  maxListItems: 400,
  maxInlineSpans: 600,
  maxQuoteDepth: 2,
  maxTableRows: 200,
  maxTableColumns: 20,
  maxMathChars: 8_000,
} as const;

/* ── 토큰 ──────────────────────────────────────────────── */
export type InlineToken =
  | { kind: 'text'; text: string }
  | { kind: 'break' }
  | { kind: 'code'; text: string }
  | { kind: 'strong'; text: string }
  | { kind: 'em'; text: string }
  | { kind: 'del'; text: string }
  | { kind: 'link'; text: string; href: string }
  | { kind: 'math'; source: string; raw: string }
  | WikilinkToken;

/** 연구 프로젝트 인용. 문법은 wikilinks.ts 한 곳에서 정한다. */
export interface WikilinkToken {
  kind: 'wikilink';
  raw: string;
  id: string;
  anchor: WikilinkAnchor | null;
  label: string | null;
}

export interface ListItem {
  /** 항목 첫 줄. */
  text: string;
  /** 이어지는 들여쓴 줄들 (설명, 파일 목록 등). */
  notes: string[];
  depth: number;
  task: 'none' | 'todo' | 'done';
}

export type TableAlign = 'left' | 'center' | 'right' | null;

export type Block =
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'list'; ordered: boolean; start: number; items: ListItem[] }
  | { kind: 'quote'; blocks: Block[] }
  | { kind: 'code'; lang: string; code: string }
  | { kind: 'math'; source: string; raw: string }
  | { kind: 'table'; header: string[]; align: TableAlign[]; rows: string[][] }
  | { kind: 'hr' };

const RE_HR = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const RE_HEADING = /^ {0,3}(#{1,6})[ \t]+(.*)$/;
const RE_FENCE = /^ {0,3}(```|~~~)[ \t]*([A-Za-z0-9_+-]{0,20})[ \t]*$/;
const RE_ITEM = /^(\s*)(?:([-*+])|(\d{1,9})[.)])[ \t]+(.*)$/;
const RE_DISPLAY_MATH_OPEN = /^ {0,3}(\$\$|\\\[|₩\[|￦\[)(.*)$/;

function normalize(src: string, fromChar = 0, fromLine = 0): string[] {
  let clipped = src.slice(fromChar, MD_LIMITS.maxChars);
  const finalCodeUnit = clipped.charCodeAt(clipped.length - 1);
  if (finalCodeUnit >= 0xD800 && finalCodeUnit <= 0xDBFF) clipped = clipped.slice(0, -1);
  const lines = clipped.replace(/\r\n?/g, '\n').replace(/\t/g, '  ').split('\n');
  const remainingLines = MD_LIMITS.maxLines - fromLine;
  return lines.length > remainingLines ? lines.slice(0, remainingLines) : lines;
}

function joinParagraphLines(lines: readonly string[]): string {
  let out = '';
  lines.forEach((line, index) => {
    const hardBreak = /(?: {2,}|\\)$/.test(line);
    const content = hardBreak ? line.replace(/(?: {2,}|\\)$/, '') : line.trim();
    out += content;
    if (index < lines.length - 1) out += hardBreak ? '\n' : ' ';
  });
  return out.trim();
}

function splitTableRow(line: string): string[] {
  let body = line.trim();
  if (body.startsWith('|')) body = body.slice(1);
  if (body.endsWith('|') && !body.endsWith('\\|')) body = body.slice(0, -1);
  const cells: string[] = [];
  let cell = '';
  let escaped = false;
  let inCode = false;
  for (const ch of body) {
    if (escaped) {
      cell += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      cell += ch;
      continue;
    }
    if (ch === '`') inCode = !inCode;
    if (ch === '|' && !inCode) {
      cells.push(cell.trim());
      cell = '';
    } else {
      cell += ch;
    }
  }
  if (escaped) cell += '\\';
  cells.push(cell.trim());
  return cells.slice(0, MD_LIMITS.maxTableColumns);
}

function parseTableAlign(line: string): TableAlign[] | null {
  if (!line.includes('|')) return null;
  const cells = splitTableRow(line);
  if (cells.length === 0 || cells.some((cell) => !/^:?-{3,}:?$/.test(cell))) return null;
  return cells.map((cell) => {
    const left = cell.startsWith(':');
    const right = cell.endsWith(':');
    if (left && right) return 'center';
    if (right) return 'right';
    if (left) return 'left';
    return null;
  });
}

function readDisplayMath(lines: readonly string[], start: number) {
  const match = RE_DISPLAY_MATH_OPEN.exec(lines[start] ?? '');
  if (!match) return null;
  const opener = match[1] ?? '$$';
  const closer = opener === '$$' ? '$$' : opener.slice(0, 1) === '\\' ? '\\]' : `${opener.slice(0, 1)}]`;
  const first = match[2] ?? '';
  if (first.trimEnd().endsWith(closer)) {
    const source = first.trimEnd().slice(0, -closer.length).trim();
    return source ? { source, raw: `${opener}${first}`, next: start + 1 } : null;
  }
  const body: string[] = [];
  if (first) body.push(first);
  let i = start + 1;
  while (i < lines.length) {
    const current = lines[i] ?? '';
    if (current.trim() === closer) {
      const source = body.join('\n').trim();
      return source ? {
        source,
        raw: [opener + first, ...lines.slice(start + 1, i), closer].join('\n'),
        next: i + 1,
      } : null;
    }
    body.push(current);
    if (body.join('\n').length > MD_LIMITS.maxMathChars) return null;
    i += 1;
  }
  // 스트리밍 도중 닫히지 않은 수식은 일반 텍스트로 남긴다.
  return null;
}

/** Markdown 부분집합을 블록 목록으로 바꾼다. 순수 함수. */
export function tokenizeMarkdown(src: string, quoteDepth = 0): Block[] {
  return tokenizeLines(normalize(src), quoteDepth);
}

function tokenizeLines(
  lines: readonly string[],
  quoteDepth: number,
  maxBlocks: number = MD_LIMITS.maxBlocks,
  onBlock?: (line: number) => void,
  onPendingMath?: (line: number) => void,
): Block[] {
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  let paragraphStart = 0;

  const pushBlock = (block: Block, line: number): void => {
    blocks.push(block);
    onBlock?.(line);
  };

  const flushParagraph = (): void => {
    if (paragraph.length === 0) return;
    if (blocks.length < maxBlocks) {
      pushBlock({ kind: 'paragraph', text: joinParagraphLines(paragraph) }, paragraphStart);
    }
    paragraph = [];
  };

  let i = 0;
  while (i < lines.length && blocks.length < maxBlocks) {
    const line = lines[i] ?? '';
    const blockStart = i;

    const displayMath = readDisplayMath(lines, i);
    if (displayMath) {
      flushParagraph();
      pushBlock({ kind: 'math', source: displayMath.source, raw: displayMath.raw }, blockStart);
      i = displayMath.next;
      continue;
    }
    if (RE_DISPLAY_MATH_OPEN.test(line)) onPendingMath?.(i);

    const tableAlign = parseTableAlign(lines[i + 1] ?? '');
    if (line.includes('|') && tableAlign) {
      flushParagraph();
      const header = splitTableRow(line);
      const columns = Math.min(header.length, tableAlign.length, MD_LIMITS.maxTableColumns);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && rows.length < MD_LIMITS.maxTableRows) {
        const row = lines[i] ?? '';
        if (!row.trim() || !row.includes('|')) break;
        rows.push(splitTableRow(row).slice(0, columns));
        i += 1;
      }
      pushBlock({
        kind: 'table',
        header: header.slice(0, columns),
        align: tableAlign.slice(0, columns),
        rows,
      }, blockStart);
      continue;
    }

    const fence = RE_FENCE.exec(line);
    if (fence) {
      flushParagraph();
      const marker = fence[1] ?? '```';
      const body: string[] = [];
      i += 1;
      while (i < lines.length) {
        const current = lines[i] ?? '';
        if (current.trimStart().startsWith(marker)) {
          i += 1;
          break;
        }
        body.push(current);
        i += 1;
      }
      pushBlock({ kind: 'code', lang: fence[2] ?? '', code: body.join('\n') }, blockStart);
      continue;
    }

    if (line.trim() === '') {
      flushParagraph();
      i += 1;
      continue;
    }

    if (RE_HR.test(line)) {
      flushParagraph();
      pushBlock({ kind: 'hr' }, blockStart);
      i += 1;
      continue;
    }

    const heading = RE_HEADING.exec(line);
    if (heading) {
      flushParagraph();
      const text = (heading[2] ?? '').replace(/[ \t]+#+[ \t]*$/, '').trim();
      pushBlock({ kind: 'heading', level: (heading[1] ?? '#').length, text }, blockStart);
      i += 1;
      continue;
    }

    if (/^ {0,3}>/.test(line)) {
      flushParagraph();
      const body: string[] = [];
      while (i < lines.length && /^ {0,3}>/.test(lines[i] ?? '')) {
        body.push((lines[i] ?? '').replace(/^ {0,3}>[ \t]?/, ''));
        i += 1;
      }
      const inner = quoteDepth >= MD_LIMITS.maxQuoteDepth
        ? [{ kind: 'paragraph' as const, text: body.join(' ').trim() }]
        : tokenizeMarkdown(body.join('\n'), quoteDepth + 1);
      pushBlock({ kind: 'quote', blocks: inner }, blockStart);
      continue;
    }

    const first = RE_ITEM.exec(line);
    if (first) {
      flushParagraph();
      const ordered = first[3] !== undefined;
      const start = ordered ? Math.max(1, Number(first[3])) : 1;
      const items: ListItem[] = [];
      while (i < lines.length && items.length < MD_LIMITS.maxListItems) {
        const match = RE_ITEM.exec(lines[i] ?? '');
        if (!match) break;
        if ((match[3] !== undefined) !== ordered) break;
        const indent = (match[1] ?? '').length;
        items.push({ ...readItem(match[4] ?? ''), depth: Math.min(2, Math.floor(indent / 2)), notes: [] });
        const item = items[items.length - 1]!;
        i += 1;
        // 이어지는 들여쓴 줄은 같은 항목의 보조 설명으로 붙인다.
        while (i < lines.length) {
          const next = lines[i] ?? '';
          if (next.trim() === '' || RE_ITEM.test(next)) break;
          if (next.search(/\S/) <= indent) break;
          if (item.notes.length < 8) item.notes.push(next.trim());
          i += 1;
        }
        if ((lines[i] ?? '').trim() === '' && RE_ITEM.test(lines[i + 1] ?? '')) i += 1;
      }
      pushBlock({ kind: 'list', ordered, start, items }, blockStart);
      continue;
    }

    if (paragraph.length === 0) paragraphStart = i;
    paragraph.push(line.trimStart());
    i += 1;
  }
  flushParagraph();
  return blocks;
}

/**
 * 완성된 앞부분은 재사용하고, 이어 쓰기로 달라질 수 있는 끝부분만 다시 읽는다.
 * 돌려준 배열은 다음 tokenize 호출 전까지만 유효하다 — 앞부분을 매번 복사하지 않는다.
 */
export class MarkdownTokenCache {
  private source = '';
  /** 앞 prefixLength 개는 확정된 블록, 그 뒤는 지난번에 다시 읽은 끝부분. */
  private blocks: Block[] = [];
  private prefixLength = 0;
  private tailLine = 0;
  private tailChar = 0;

  tokenize(source: string): Block[] {
    if (!source.startsWith(this.source)) {
      this.prefixLength = 0;
      this.tailLine = 0;
      this.tailChar = 0;
    } else if (source.length === this.source.length && this.blocks.length > 0) {
      return this.blocks;
    }
    this.source = source;
    const starts: number[] = [];
    let pendingMath = Infinity;
    const tail = tokenizeLines(
      normalize(source, this.tailChar, this.tailLine),
      0,
      MD_LIMITS.maxBlocks - this.prefixLength,
      (line) => starts.push(line),
      (line) => { pendingMath = Math.min(pendingMath, line); },
    );
    const blocks = this.blocks;
    blocks.length = this.prefixLength;
    for (const block of tail) blocks.push(block);
    // 마지막 줄이 목록 항목·표 구분자로 완성되면 직전 블록과 합쳐질 수 있다.
    let retained = Math.max(0, tail.length - 2);
    // 닫는 구분자가 늦게 오면 앞의 일반 문단들도 하나의 수식으로 바뀔 수 있다.
    while (retained > 0 && starts[retained]! > pendingMath) retained -= 1;
    if (retained > 0) {
      this.prefixLength += retained;
      const retainedLines = starts[retained]!;
      const breaks = /\r\n?|\n/gu;
      breaks.lastIndex = this.tailChar;
      for (let line = 0; line < retainedLines; line += 1) {
        const match = breaks.exec(source)!;
        this.tailChar = match.index + match[0].length;
      }
      this.tailLine += retainedLines;
    }
    return blocks;
  }
}

function readItem(raw: string): { text: string; task: ListItem['task'] } {
  const task = /^\[([ xX])\][ \t]+/.exec(raw);
  if (!task) return { text: raw.trim(), task: 'none' };
  return {
    text: raw.slice(task[0].length).trim(),
    task: (task[1] ?? ' ').toLowerCase() === 'x' ? 'done' : 'todo',
  };
}

/** 인라인 마크업을 토큰으로 나눈다. 순수 함수. */
const RE_WORD_CHAR = /[\p{L}\p{N}\p{M}]/u;
const WON_SLASHES = new Set(['₩', '￦']);

function isEscaped(src: string, index: number): boolean {
  let slashes = 0;
  for (let i = index - 1; i >= 0 && src[i] === '\\'; i -= 1) slashes += 1;
  return slashes % 2 === 1;
}

function findMarker(src: string, marker: string, from: number, underscoreBoundary: boolean): number {
  let cursor = from;
  while (cursor < src.length) {
    const found = src.indexOf(marker, cursor);
    if (found < 0) return -1;
    const before = src[found - 1] ?? ' ';
    const after = src[found + marker.length] ?? ' ';
    if (
      !isEscaped(src, found)
      && !/\s/u.test(before)
      && (!underscoreBoundary || !RE_WORD_CHAR.test(after))
    ) return found;
    cursor = found + marker.length;
  }
  return -1;
}

function readInlineMath(src: string, start: number) {
  const ch = src[start] ?? '';
  const next = src[start + 1] ?? '';
  if ((ch === '\\' || WON_SLASHES.has(ch)) && next === '(' && !isEscaped(src, start)) {
    const closer = `${ch})`;
    const end = src.indexOf(closer, start + 2);
    if (end > start + 2 && end - start <= MD_LIMITS.maxMathChars) {
      return {
        source: src.slice(start + 2, end),
        raw: src.slice(start, end + closer.length),
        next: end + closer.length,
      };
    }
  }
  if (ch !== '$' || next === '$' || /\s/u.test(next) || isEscaped(src, start)) return null;
  let end = start + 1;
  while (end < src.length && end - start <= MD_LIMITS.maxMathChars) {
    end = src.indexOf('$', end);
    if (end < 0) return null;
    const before = src[end - 1] ?? ' ';
    const after = src[end + 1] ?? ' ';
    if (!isEscaped(src, end) && !/\s/u.test(before) && !/[\d$]/u.test(after)) {
      return {
        source: src.slice(start + 1, end),
        raw: src.slice(start, end + 1),
        next: end + 1,
      };
    }
    end += 1;
  }
  return null;
}

function readInlineLink(src: string, start: number): {
  text: string;
  href: string;
  next: number;
} | null {
  const image = src[start] === '!' && src[start + 1] === '[';
  const labelStart = start + (image ? 2 : 1);
  if ((!image && src[start] !== '[') || labelStart >= src.length) return null;

  let labelEnd = labelStart;
  while (labelEnd - labelStart <= 300) {
    labelEnd = src.indexOf(']', labelEnd);
    if (labelEnd < 0 || src.slice(labelStart, labelEnd).includes('\n')) return null;
    if (!isEscaped(src, labelEnd)) break;
    labelEnd += 1;
  }
  if (labelEnd - labelStart > 300 || src[labelEnd + 1] !== '(') return null;

  const destinationStart = labelEnd + 2;
  let cursor = destinationStart;
  let depth = 0;
  while (cursor < src.length && cursor - destinationStart <= 4_000) {
    const ch = src[cursor]!;
    if (ch === '\n') return null;
    if (ch === '\\' && cursor + 1 < src.length) {
      cursor += 2;
      continue;
    }
    if (ch === '(') {
      depth += 1;
      if (depth > 32) return null;
      cursor += 1;
      continue;
    }
    if (ch === ')') {
      if (depth === 0) {
        return {
          text: src.slice(labelStart, labelEnd),
          href: src.slice(destinationStart, cursor),
          next: cursor + 1,
        };
      }
      depth -= 1;
      cursor += 1;
      continue;
    }
    if (/[ \t]/u.test(ch) && depth === 0) {
      const hrefEnd = cursor;
      let titleCursor = cursor;
      let titleDepth = 0;
      while (titleCursor < src.length && titleCursor - cursor <= 200) {
        const titleCh = src[titleCursor]!;
        if (titleCh === '\n') return null;
        if (titleCh === '\\' && titleCursor + 1 < src.length) {
          titleCursor += 2;
          continue;
        }
        if (titleCh === '(') titleDepth += 1;
        else if (titleCh === ')') {
          if (titleDepth === 0) {
            return {
              text: src.slice(labelStart, labelEnd),
              href: src.slice(destinationStart, hrefEnd),
              next: titleCursor + 1,
            };
          }
          titleDepth -= 1;
        }
        titleCursor += 1;
      }
      return null;
    }
    if (/\s/u.test(ch)) return null;
    cursor += 1;
  }
  return null;
}

export function tokenizeInline(src: string): InlineToken[] {
  const tokens: InlineToken[] = [];
  let buffer = '';
  const push = (token: InlineToken): void => {
    if (buffer) {
      tokens.push({ kind: 'text', text: buffer });
      buffer = '';
    }
    tokens.push(token);
  };
  let i = 0;
  while (i < src.length) {
    if (tokens.length >= MD_LIMITS.maxInlineSpans) {
      buffer += src.slice(i);
      break;
    }
    const ch = src[i]!;
    if (ch === '\n') {
      push({ kind: 'break' });
      i += 1;
      continue;
    }
    const math = readInlineMath(src, i);
    if (math) {
      push({ kind: 'math', source: math.source, raw: math.raw });
      i = math.next;
      continue;
    }
    if (ch === '\\' && i + 1 < src.length) {
      const escaped = src[i + 1] ?? '';
      if (/^[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]$/u.test(escaped)) {
        buffer += escaped;
        i += 2;
        continue;
      }
    }
    if (ch === '`') {
      const marker = src[i + 1] === '`' ? '``' : '`';
      const end = src.indexOf(marker, i + marker.length);
      if (end > i + marker.length) {
        push({ kind: 'code', text: src.slice(i + marker.length, end) });
        i = end + marker.length;
        continue;
      }
    }
    if (ch === '[' && src[i + 1] === '[') {
      const cite = readWikilinkAt(src, i);
      if (cite) {
        push({ kind: 'wikilink', raw: src.slice(cite.start, cite.end), id: cite.id, anchor: cite.anchor, label: cite.label });
        i = cite.end;
        continue;
      }
    }
    if (ch === '[' || (ch === '!' && src[i + 1] === '[')) {
      const link = readInlineLink(src, i);
      if (link) {
        push({ kind: 'link', text: link.text, href: link.href });
        i = link.next;
        continue;
      }
    }
    if (ch === '~' && src[i + 1] === '~') {
      const end = findMarker(src, '~~', i + 2, false);
      if (end > i + 2) {
        push({ kind: 'del', text: src.slice(i + 2, end) });
        i = end + 2;
        continue;
      }
    }
    if ((ch === '*' || ch === '_') && src[i + 1] === ch) {
      const underscore = ch === '_';
      const before = src[i - 1] ?? ' ';
      if (!underscore || !RE_WORD_CHAR.test(before)) {
        const end = findMarker(src, ch + ch, i + 2, underscore);
        if (end > i + 2) {
          push({ kind: 'strong', text: src.slice(i + 2, end) });
          i = end + 2;
          continue;
        }
      }
    }
    if (ch === '*' || ch === '_') {
      const underscore = ch === '_';
      const before = src[i - 1] ?? ' ';
      const after = src[i + 1] ?? ' ';
      if ((!underscore || !RE_WORD_CHAR.test(before)) && !/\s/u.test(after)) {
        const end = findMarker(src, ch, i + 1, underscore);
        if (end > i + 1) {
          push({ kind: 'em', text: src.slice(i + 1, end) });
          i = end + 1;
          continue;
        }
      }
    }
    buffer += ch;
    i += 1;
  }
  if (buffer) tokens.push({ kind: 'text', text: buffer });
  return tokens;
}

function resolveHost(host?: MarkdownHost): MarkdownHost {
  if (host) return host;
  const doc = (globalThis as { document?: MarkdownHost }).document;
  if (!doc) throw new Error('Markdown 렌더러에 document 가 필요합니다.');
  return doc;
}

function add(parent: MarkdownNode, child: MarkdownNode): MarkdownNode {
  (parent.appendChild as (node: MarkdownNode) => unknown)(child);
  return child;
}

function element(host: MarkdownHost, tag: string, className?: string): MarkdownNode {
  const node = host.createElement(tag);
  if (className) node.className = className;
  return node;
}

export function safeMarkdownHref(raw: string): string | null {
  const href = raw.trim();
  if (/^[\u0000-\u001f\u007f]/u.test(href)) return null;
  return /^(?:https?:\/\/|mailto:)/iu.test(href) ? href : null;
}

function appendMath(
  host: MarkdownHost,
  parent: MarkdownNode,
  source: string,
  raw: string,
  displayMode: boolean,
  options: MarkdownRenderOptions,
): void {
  const node = element(
    host,
    displayMode ? 'div' : 'span',
    `ag-md-math ag-md-math-${displayMode ? 'display' : 'inline'}`,
  );
  const rendered = options.renderMath?.(node, source, displayMode, raw) ?? false;
  if (!rendered) node.textContent = raw;
  add(parent, node);
}

const FILE_BADGES: Readonly<Record<string, string>> = {
  ts: 'TS', tsx: 'TS', mts: 'TS', cts: 'TS', js: 'JS', jsx: 'JS', mjs: 'JS', cjs: 'JS',
  rs: 'RS', py: 'PY', json: 'JSON', css: 'CSS', html: 'HTML', md: 'MD', toml: 'TOML',
  yml: 'YML', yaml: 'YML', sh: 'SH', go: 'GO', swift: 'SWIFT', kt: 'KT', java: 'JAVA',
  c: 'C', h: 'H', cpp: 'C++', hpp: 'C++', sql: 'SQL', txt: 'TXT', csv: 'CSV', xml: 'XML',
  svg: 'SVG', png: 'PNG', jpg: 'JPG', jpeg: 'JPG', gif: 'GIF', webp: 'WEBP', pdf: 'PDF',
  hwp: 'HWP', hwpx: 'HWPX', hml: 'HML', docx: 'DOCX', xlsx: 'XLSX', pptx: 'PPTX',
};
const RE_FILE_PATH = /^\/?(?:[\p{L}\p{N}_@.~-]+\/)*[\p{L}\p{N}_@-][\p{L}\p{N}_@.-]*\.([A-Za-z0-9+]{1,5})(?::\d+(?::\d+)?)?$/u;

/** 파일 경로로 보이는 인라인 코드면 확장자 배지 문자열을 돌려준다. */
export function fileBadgeFor(code: string): string | null {
  const match = RE_FILE_PATH.exec(code.trim());
  return match ? FILE_BADGES[(match[1] ?? '').toLowerCase()] ?? null : null;
}

/** 굵게·기울임 안의 코드처럼 한 겹 중첩된 인라인 마크업까지만 푼다. */
const MAX_INLINE_DEPTH = 3;

function appendInline(
  host: MarkdownHost,
  parent: MarkdownNode,
  text: string,
  options: MarkdownRenderOptions,
  depth = 0,
): void {
  for (const token of tokenizeInline(text)) {
    if (token.kind === 'text') {
      add(parent, host.createTextNode(token.text));
      continue;
    }
    if (token.kind === 'break') {
      add(parent, element(host, 'br', 'ag-md-break'));
      continue;
    }
    if (token.kind === 'math') {
      appendMath(host, parent, token.source, token.raw, false, options);
      continue;
    }
    if (token.kind === 'wikilink') {
      add(parent, options.citation?.(token) ?? host.createTextNode(token.raw));
      continue;
    }
    if (token.kind === 'link') {
      const href = options.links ? safeMarkdownHref(token.href) : null;
      if (!href) {
        add(parent, host.createTextNode(token.text));
        continue;
      }
      const link = element(host, 'a', 'ag-md-link');
      link.textContent = token.text;
      link.setAttribute?.('href', href);
      link.setAttribute?.('target', '_blank');
      link.setAttribute?.('rel', 'noopener noreferrer');
      add(parent, link);
      continue;
    }
    if (token.kind === 'code') {
      const badge = options.fileChips ? fileBadgeFor(token.text) : null;
      const node = element(host, 'code', badge ? 'ag-md-code ag-md-file' : 'ag-md-code');
      if (badge) {
        const mark = element(host, 'span', 'ag-md-file-badge');
        mark.textContent = badge;
        mark.setAttribute?.('aria-hidden', 'true');
        add(node, mark);
        add(node, host.createTextNode(token.text));
      } else {
        node.textContent = token.text;
      }
      add(parent, node);
      continue;
    }
    const tag = token.kind === 'strong' ? 'strong' : token.kind === 'del' ? 'del' : 'em';
    const node = element(host, tag, `ag-md-${token.kind}`);
    if (depth < MAX_INLINE_DEPTH) appendInline(host, node, token.text, options, depth + 1);
    else node.textContent = token.text;
    add(parent, node);
  }
}

function appendTable(
  host: MarkdownHost,
  parent: MarkdownNode,
  block: Extract<Block, { kind: 'table' }>,
  options: MarkdownRenderOptions,
): void {
  const wrap = element(host, 'div', 'ag-md-table-wrap');
  const table = element(host, 'table', 'ag-md-table');
  const head = element(host, 'thead');
  const headRow = element(host, 'tr');
  block.header.forEach((text, index) => {
    const align = block.align[index];
    const cell = element(host, 'th', align ? `ag-md-align-${align}` : undefined);
    appendInline(host, cell, text, options);
    add(headRow, cell);
  });
  add(head, headRow);
  add(table, head);
  if (block.rows.length > 0) {
    const body = element(host, 'tbody');
    for (const row of block.rows) {
      const tr = element(host, 'tr');
      block.header.forEach((_, index) => {
        const align = block.align[index];
        const cell = element(host, 'td', align ? `ag-md-align-${align}` : undefined);
        appendInline(host, cell, row[index] ?? '', options);
        add(tr, cell);
      });
      add(body, tr);
    }
    add(table, body);
  }
  add(wrap, table);
  add(parent, wrap);
}

function appendBlocks(
  host: MarkdownHost,
  parent: MarkdownNode,
  blocks: readonly Block[],
  options: MarkdownRenderOptions,
): void {
  for (const block of blocks) {
    switch (block.kind) {
      case 'heading': {
        const level = Math.min(6, Math.max(1, block.level));
        const node = element(host, `h${level + 2 > 6 ? 6 : level + 2}`, `ag-md-h ag-md-h${level}`);
        appendInline(host, node, block.text, options);
        add(parent, node);
        break;
      }
      case 'paragraph': {
        const node = element(host, 'p', 'ag-md-p');
        appendInline(host, node, block.text, options);
        add(parent, node);
        break;
      }
      case 'hr':
        add(parent, element(host, 'hr', 'ag-md-hr'));
        break;
      case 'code': {
        const pre = element(host, 'pre', 'ag-md-pre');
        const code = element(host, 'code', 'ag-md-block-code');
        if (block.lang) code.setAttribute?.('data-lang', block.lang);
        code.textContent = block.code;
        add(pre, code);
        add(parent, pre);
        break;
      }
      case 'math':
        appendMath(host, parent, block.source, block.raw, true, options);
        break;
      case 'table':
        appendTable(host, parent, block, options);
        break;
      case 'quote': {
        const node = element(host, 'blockquote', 'ag-md-quote');
        appendBlocks(host, node, block.blocks, options);
        add(parent, node);
        break;
      }
      case 'list':
        appendList(host, parent, block, options);
        break;
    }
  }
}

function appendList(
  host: MarkdownHost,
  parent: MarkdownNode,
  block: Extract<Block, { kind: 'list' }>,
  options: MarkdownRenderOptions,
): void {
  const root = element(host, block.ordered ? 'ol' : 'ul', 'ag-md-list');
  if (block.ordered && block.start !== 1) root.setAttribute?.('start', String(block.start));
  add(parent, root);
  // depth 0/1/2 만 지원한다 — 더 깊은 들여쓰기는 마지막 단계로 접힌다.
  const stack: MarkdownNode[] = [root];
  let lastItem: MarkdownNode | null = null;
  for (const item of block.items) {
    const depth = Math.min(item.depth, stack.length - 1 + 1);
    while (stack.length - 1 > depth) stack.pop();
    if (depth > stack.length - 1 && lastItem) {
      const nested = element(host, block.ordered ? 'ol' : 'ul', 'ag-md-list ag-md-list-nested');
      add(lastItem, nested);
      stack.push(nested);
    }
    const parentList = stack[stack.length - 1]!;
    const li = element(host, 'li', item.task === 'none' ? 'ag-md-li' : `ag-md-li ag-md-task ag-md-task-${item.task}`);
    if (item.task !== 'none') {
      const mark = element(host, 'span', 'ag-md-checkbox');
      mark.setAttribute?.('aria-hidden', 'true');
      add(li, mark);
    }
    const line = element(host, 'span', 'ag-md-li-text');
    appendInline(host, line, item.text, options);
    add(li, line);
    for (const note of item.notes) {
      const noteNode = element(host, 'span', 'ag-md-li-note');
      appendInline(host, noteNode, note, options);
      add(li, noteNode);
    }
    add(parentList, li);
    lastItem = li;
  }
}

/** 이미 나눈 블록을 target 에 붙인다. 블록마다 최상위 노드가 정확히 하나 생긴다. */
export function appendMarkdownBlocks(
  target: MarkdownNode,
  blocks: readonly Block[],
  host?: MarkdownHost,
  options: MarkdownRenderOptions = {},
): void {
  appendBlocks(resolveHost(host), target, blocks, options);
}

/** Markdown 을 안전한 DOM 노드로 그려 target 에 붙인다. */
export function appendMarkdown(
  target: MarkdownNode,
  src: string,
  host?: MarkdownHost,
  options: MarkdownRenderOptions = {},
): void {
  const resolved = resolveHost(host);
  appendBlocks(resolved, target, tokenizeMarkdown(src), options);
}

/** 렌더 결과를 fragment 로 돌려준다. */
export function renderMarkdown(
  src: string,
  host?: MarkdownHost,
  options: MarkdownRenderOptions = {},
): MarkdownNode {
  const resolved = resolveHost(host);
  const fragment = resolved.createDocumentFragment();
  appendBlocks(resolved, fragment, tokenizeMarkdown(src), options);
  return fragment;
}

/* ── 계획을 Markdown 으로 ─────────────────────────────── */

/** 계획 본문 글자를 Markdown 문법으로 재해석되지 않게 막는다. */
export function escapeMarkdown(text: string): string {
  return text
    .replace(/[\\`*_[\]<>#|~$]/g, (ch) => `\\${ch}`)
    .replace(/^([ \t]*)(\d{1,9})([.)])/gm, '$1$2\\$3')
    .replace(/^([ \t]*)([-+])(\s)/gm, '$1\\$2$3');
}

function clean(text: string): string {
  return escapeMarkdown(text.trim()).replace(/\n+/g, ' ');
}

function listSection(
  title: string,
  items: readonly string[] | undefined,
  options: { code?: boolean; tasks?: boolean } = {},
): string[] {
  const rows = (items ?? []).map((item) => item.trim()).filter(Boolean);
  if (rows.length === 0) return [];
  const prefix = options.tasks ? '- [ ] ' : '- ';
  const body = rows.map((item) => (
    options.code
      ? `${prefix}\`${item.replace(/`/g, '')}\``
      : `${prefix}${clean(item)}`
  ));
  return [`## ${clean(title)}`, ...body, ''];
}

function stepLines(step: StructuredPlanStep, index: number): string[] {
  const lines = [`${index + 1}. **${clean(step.title || '단계')}**`];
  const details = (step.details ?? '').trim();
  if (details) lines.push(`   ${clean(details)}`);
  const files = (step.files ?? []).map((file) => file.trim()).filter(Boolean);
  if (files.length > 0) lines.push(`   파일 ${files.map((file) => `\`${file.replace(/`/g, '')}\``).join(', ')}`);
  return lines;
}

/**
 * 구조화된 계획을 문서용 Markdown 으로 바꾼다.
 * 제목·목표는 뷰어 머리말이 맡으므로 본문에는 넣지 않는다.
 */
export function planToMarkdown(plan: StructuredPlan): string {
  const out: string[] = [];
  const summary = (plan.summary || '').trim();
  if (summary) out.push('## 개요', clean(summary), '');

  const steps = plan.steps ?? [];
  if (steps.length > 0) {
    out.push('## 단계');
    steps.forEach((step, index) => out.push(...stepLines(step, index)));
    out.push('');
  }

  out.push(...listSection('예상 파일', plan.files, { code: true }));
  out.push(...listSection('검증', plan.validation, { tasks: true }));
  out.push(...listSection('위험', plan.risks));
  out.push(...listSection('가정', plan.assumptions));
  out.push(...listSection('결정', plan.decisions));
  out.push(...listSection('제외', plan.exclusions));

  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
