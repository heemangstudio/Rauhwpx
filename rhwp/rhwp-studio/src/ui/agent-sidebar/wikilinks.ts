/**
 * 연구 프로젝트 인용 표기 `[[id]]` 파서. 허브 project-links.mjs 와 같은 문법이며,
 * 두 구현은 rhwp-agent/tests/fixtures/wikilinks-cases.json 을 함께 통과해야 한다.
 *
 * 문법
 * - `[[id]]`, `[[id|라벨]]`, `[[id#cN]]`, `[[id#cN|그대로 옮긴 인용]]`, `[[id#pN]]`, `[[id#pN|라벨]]`
 * - id = `[fndr][a-z2-7]{6}` (파일·노트·문서 노드·영역 조각). 대문자·공백이 섞이면 표기가 아니다.
 * - N 은 1~6자리 십진수. 라벨에는 `[`·`]`·줄바꿈이 없고, 앞뒤 공백을 지운 길이가
 *   80자(UTF-16) 이하여야 한다. 지운 결과가 비면 label 은 null 이다.
 * - 홀수 개의 백슬래시가 앞선 `[[` 는 표기가 아니다.
 * - 인라인 코드(같은 길이의 백틱 줄로 닫히는 구간, 빈 줄을 넘지 않음)와
 *   펜스 코드(``` 또는 ~~~ 로 열고 같은 종류로 닫음, 닫지 않으면 끝까지) 안은 읽지 않는다.
 */

import type { ProjectClipItem, ProjectFileItem, ProjectSnapshot } from '../../agent/types.ts';

export interface WikilinkAnchor {
  kind: 'chunk' | 'page';
  n: number;
}

export interface Wikilink {
  /** 원문에서 `[[` 의 위치. */
  start: number;
  /** 원문에서 `]]` 다음 위치. */
  end: number;
  id: string;
  anchor: WikilinkAnchor | null;
  label: string | null;
}

export const WIKILINK_LABEL_MAX = 80;

const RE_WIKILINK = /\[\[([fndr][a-z2-7]{6})(?:#([cp])(\d{1,6}))?(?:\|([^[\]\n]*))?\]\]/y;
const RE_FENCE_MARK = /^ {0,3}(```|~~~)/u;

function oddBackslashes(src: string, index: number): boolean {
  let count = 0;
  for (let i = index - 1; i >= 0 && src[i] === '\\'; i -= 1) count += 1;
  return count % 2 === 1;
}

/** index 에서 시작하는 인용 표기 하나를 읽는다. 코드 구간 판단은 호출한 쪽이 한다. */
export function readWikilinkAt(src: string, index: number): Wikilink | null {
  if (src[index] !== '[' || src[index + 1] !== '[' || oddBackslashes(src, index)) return null;
  RE_WIKILINK.lastIndex = index;
  const match = RE_WIKILINK.exec(src);
  if (!match) return null;
  const label = match[4]?.trim() || null;
  if (label && label.length > WIKILINK_LABEL_MAX) return null;
  return {
    start: index,
    end: index + match[0].length,
    id: match[1]!,
    anchor: match[2] ? { kind: match[2] === 'c' ? 'chunk' : 'page', n: Number(match[3]) } : null,
    label,
  };
}

/** 백틱 줄 길이. */
function backtickRun(src: string, index: number): number {
  let end = index;
  while (src[end] === '`') end += 1;
  return end - index;
}

/** index 의 백틱 줄이 여는 인라인 코드의 끝(닫는 줄 다음 위치). 닫히지 않으면 -1. */
function codeSpanEnd(src: string, index: number, limit: number): number {
  const run = backtickRun(src, index);
  let cursor = index + run;
  while (cursor < limit) {
    const next = src.indexOf('`', cursor);
    if (next < 0 || next >= limit) return -1;
    // 빈 줄을 넘는 코드 구간은 없다.
    if (/\n[ \t]*\n/u.test(src.slice(cursor, next))) return -1;
    const length = backtickRun(src, next);
    if (length === run) return next + length;
    cursor = next + length;
  }
  return -1;
}

/** 본문에서 인용 표기를 모두 찾는다. 코드 안의 표기는 건너뛴다. */
export function parseWikilinks(text: string): Wikilink[] {
  const links: Wikilink[] = [];
  // 펜스 밖 구간을 [start, end) 로 나눈다.
  const segments: Array<[number, number]> = [];
  let fence: string | null = null;
  let segmentStart = 0;
  let lineStart = 0;
  while (lineStart <= text.length) {
    const newline = text.indexOf('\n', lineStart);
    const lineEnd = newline < 0 ? text.length : newline;
    const mark = RE_FENCE_MARK.exec(text.slice(lineStart, lineEnd))?.[1];
    if (mark) {
      if (fence === null) {
        segments.push([segmentStart, lineStart]);
        fence = mark;
      } else if (fence === mark) {
        fence = null;
        segmentStart = newline < 0 ? text.length : newline + 1;
      }
    }
    if (newline < 0) break;
    lineStart = newline + 1;
  }
  if (fence === null) segments.push([segmentStart, text.length]);

  for (const [from, to] of segments) {
    let i = from;
    while (i < to) {
      const ch = text[i];
      if (ch === '`' && !oddBackslashes(text, i)) {
        const end = codeSpanEnd(text, i, to);
        if (end > 0) {
          i = end;
          continue;
        }
        i += backtickRun(text, i);
        continue;
      }
      if (ch === '[') {
        const link = readWikilinkAt(text, i);
        if (link && link.end <= to) {
          links.push(link);
          i = link.end;
          continue;
        }
      }
      i += 1;
    }
  }
  return links;
}

/** 앵커를 `c12`·`p4` 꼴로 적는다. */
export function formatWikilinkAnchor(anchor: WikilinkAnchor | null): string | null {
  return anchor ? `${anchor.kind === 'chunk' ? 'c' : 'p'}${anchor.n}` : null;
}

/* ── 인용 칩 계약 (chat-markdown.ts 가 그린다) ─────────────── */

/** 칩 아이콘 종류. 보드 카드(project-ui.ts itemIconName)와 같은 갈래다. */
export type CitationKind = 'file' | 'pdf' | 'image' | 'note' | 'document' | 'web' | 'table' | 'slides' | 'clip';

export interface CitationTarget {
  title: string;
  kind: CitationKind;
  /** 칩에 붙일 쪽 번호. 모르면 비운다. */
  page?: number | null;
  /** 영역 조각이면 그 조각 — 칩이 작은 썸네일을 붙인다. */
  clip?: { item: ProjectClipItem; source: ProjectFileItem };
}

export interface CitationRequest {
  id: string;
  anchor: WikilinkAnchor | null;
  /** 조각 인용의 라벨(그대로 옮긴 인용). 강조를 이 구절로 좁힌다. */
  quote: string | null;
}

/**
 * 칩이 쓰는 주입 함수. 사이드바마다 한 벌을 두고 같은 객체를 계속 넘긴다 —
 * 이미 그린 칩은 처음 받은 객체로 클릭을 처리한다.
 */
export interface CitationHooks {
  /** 현재 프로젝트 스냅샷에서 항목을 찾는다. 없으면 null — 흐린 원문으로 남는다. */
  resolveItem(id: string, anchor: WikilinkAnchor | null): CitationTarget | null;
  openCitation(request: CitationRequest): void;
  /** 조각 인용의 쪽 번호. 캐시해 두고, 아직 모르면 Promise 로 알려 준다. */
  chunkPage?(id: string, chunk: number): number | null | Promise<number | null>;
  /** 영역 조각 칩의 썸네일. 없으면 아이콘만 둔다. */
  clipThumb?(clip: ProjectClipItem, source: ProjectFileItem): HTMLElement | null;
}

function fileCitationKind(item: ProjectFileItem): CitationKind {
  if (item.source.kind === 'web' || item.fileKind === 'html') return 'web';
  switch (item.fileKind) {
    case 'pdf': return 'pdf';
    case 'image': return 'image';
    case 'xlsx': return 'table';
    case 'pptx': return 'slides';
    default: return 'file';
  }
}

/** 프로젝트 스냅샷에서 인용 대상을 찾는다. 휴지통 항목과 모르는 id 는 null. */
export function projectCitationTarget(project: ProjectSnapshot | null | undefined, id: string): CitationTarget | null {
  if (!project) return null;
  if (id.startsWith('d')) {
    const member = project.members.find((row) => row.nodeId === id);
    return member ? { title: member.name, kind: 'document' } : null;
  }
  const item = project.items.find((row) => row.id === id);
  if (!item || item.trashedAt) return null;
  if (item.kind === 'note') return { title: item.title, kind: 'note' };
  if (item.kind === 'clip') {
    const source = project.items.find((row) => row.id === item.sourceId);
    if (!source || source.kind !== 'file' || source.trashedAt) return null;
    return { title: item.title, kind: 'clip', page: source.fileKind === 'pdf' ? item.page : null, clip: { item, source } };
  }
  return { title: item.title, kind: fileCitationKind(item) };
}
