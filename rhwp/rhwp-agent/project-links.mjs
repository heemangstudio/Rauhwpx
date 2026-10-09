/**
 * 연구 프로젝트 인용 표기 `[[id]]` 파서. Studio src/ui/agent-sidebar/wikilinks.ts 와 같은 문법이며,
 * 두 구현은 tests/fixtures/wikilinks-cases.json 을 함께 통과해야 한다.
 *
 * 문법
 * - `[[id]]`, `[[id|라벨]]`, `[[id#cN]]`, `[[id#cN|그대로 옮긴 인용]]`, `[[id#pN]]`, `[[id#pN|라벨]]`
 * - id = `[fnd][a-z2-7]{6}` (파일·노트·문서 노드). 대문자·공백이 섞이면 표기가 아니다.
 * - N 은 1~6자리 십진수. 라벨에는 `[`·`]`·줄바꿈이 없고, 앞뒤 공백을 지운 길이가
 *   80자(UTF-16) 이하여야 한다. 지운 결과가 비면 label 은 null 이다.
 * - 홀수 개의 백슬래시가 앞선 `[[` 는 표기가 아니다.
 * - 인라인 코드(같은 길이의 백틱 줄로 닫히는 구간, 빈 줄을 넘지 않음)와
 *   펜스 코드(``` 또는 ~~~ 로 열고 같은 종류로 닫음, 닫지 않으면 끝까지) 안은 읽지 않는다.
 */

export const WIKILINK_LABEL_MAX = 80;
export const PROJECT_ITEM_ID_PATTERN = /^[fnd][a-z2-7]{6}$/;

const RE_WIKILINK = /\[\[([fnd][a-z2-7]{6})(?:#([cp])(\d{1,6}))?(?:\|([^[\]\n]*))?\]\]/y;
const RE_FENCE_MARK = /^ {0,3}(```|~~~)/u;

function oddBackslashes(src, index) {
  let count = 0;
  for (let i = index - 1; i >= 0 && src[i] === '\\'; i -= 1) count += 1;
  return count % 2 === 1;
}

/** index 에서 시작하는 인용 표기 하나를 읽는다. 코드 구간 판단은 호출한 쪽이 한다. */
export function readWikilinkAt(src, index) {
  if (src[index] !== '[' || src[index + 1] !== '[' || oddBackslashes(src, index)) return null;
  RE_WIKILINK.lastIndex = index;
  const match = RE_WIKILINK.exec(src);
  if (!match) return null;
  const label = match[4]?.trim() || null;
  if (label && label.length > WIKILINK_LABEL_MAX) return null;
  return {
    start: index,
    end: index + match[0].length,
    id: match[1],
    anchor: match[2] ? { kind: match[2] === 'c' ? 'chunk' : 'page', n: Number(match[3]) } : null,
    label,
  };
}

function backtickRun(src, index) {
  let end = index;
  while (src[end] === '`') end += 1;
  return end - index;
}

/** index 의 백틱 줄이 여는 인라인 코드의 끝(닫는 줄 다음 위치). 닫히지 않으면 -1. */
function codeSpanEnd(src, index, limit) {
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

/**
 * 본문에서 인용 표기를 모두 찾는다. 코드 안의 표기는 건너뛴다.
 * @param {string} text
 * @returns {{start: number, end: number, id: string, anchor: {kind: 'chunk'|'page', n: number}|null, label: string|null}[]}
 */
export function parseWikilinks(text) {
  const source = String(text ?? '');
  const links = [];
  const segments = [];
  let fence = null;
  let segmentStart = 0;
  let lineStart = 0;
  while (lineStart <= source.length) {
    const newline = source.indexOf('\n', lineStart);
    const lineEnd = newline < 0 ? source.length : newline;
    const mark = RE_FENCE_MARK.exec(source.slice(lineStart, lineEnd))?.[1];
    if (mark) {
      if (fence === null) {
        segments.push([segmentStart, lineStart]);
        fence = mark;
      } else if (fence === mark) {
        fence = null;
        segmentStart = newline < 0 ? source.length : newline + 1;
      }
    }
    if (newline < 0) break;
    lineStart = newline + 1;
  }
  if (fence === null) segments.push([segmentStart, source.length]);

  for (const [from, to] of segments) {
    let i = from;
    while (i < to) {
      const ch = source[i];
      if (ch === '`' && !oddBackslashes(source, i)) {
        const end = codeSpanEnd(source, i, to);
        if (end > 0) {
          i = end;
          continue;
        }
        i += backtickRun(source, i);
        continue;
      }
      if (ch === '[') {
        const link = readWikilinkAt(source, i);
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
export function formatWikilinkAnchor(anchor) {
  return anchor ? `${anchor.kind === 'chunk' ? 'c' : 'p'}${anchor.n}` : null;
}

/** 링크 양끝에 붙는 앵커 문자열 검사 — 'c12' 또는 'p4'. */
export function isProjectAnchor(value) {
  return typeof value === 'string' && /^[cp]\d{1,6}$/.test(value);
}
