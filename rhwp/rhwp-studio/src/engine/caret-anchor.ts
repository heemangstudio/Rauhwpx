import type { WasmBridge } from '@/core/wasm-bridge';
import type { DocumentPosition } from '@/core/types';
import { cellAxisPath } from './command';
import { clampCaretPosition, withoutHitRect } from './caret-position-clamp';

/** 앵커가 기억하는 캐럿 앞뒤 문맥 길이(글자). */
const CONTEXT_CHARS = 24;

/**
 * 대화상자가 열린 동안 문서가 바뀌어도(조판 완료, 백그라운드 에이전트 편집 등) 삽입 지점을
 * 다시 찾기 위한 캐럿 기록. 캐럿 문단에서 캐럿 앞뒤 글자를 함께 기억한다.
 */
export interface CaretAnchor {
  position: DocumentPosition;
  /** 캐럿의 텍스트 오프셋 (인라인 개체를 세지 않는다) */
  textOffset: number;
  /** 같은 텍스트 위치의 인라인 개체 중 캐럿 앞에 있는 개체 수 */
  objectsBefore: number;
  before: string;
  after: string;
}

/** 본문 구역 하나 또는 셀·글상자 하나의 문단들. 오프셋은 모두 코드 포인트 단위다. */
interface ParagraphList {
  /** 앵커 문단의 인덱스 */
  home: number;
  count: number;
  text(index: number): string;
  /** 캐럿 길이 (인라인 개체 1칸) */
  length(index: number): number;
  toLogical(index: number, textOffset: number): number;
  toText(index: number, logicalOffset: number): number;
  at(index: number, charOffset: number): DocumentPosition;
}

interface Needle {
  text: string;
  /** text 안에서 캐럿이 놓이는 글자 수 */
  caret: number;
}

function memo<T>(read: (index: number) => T): (index: number) => T {
  const cache = new Map<number, T>();
  return (index) => {
    if (!cache.has(index)) cache.set(index, read(index));
    return cache.get(index)!;
  };
}

function bodyParagraphs(wasm: WasmBridge, position: DocumentPosition): ParagraphList {
  const sec = position.sectionIndex;
  return {
    home: position.paragraphIndex,
    count: wasm.getParagraphCount(sec),
    text: memo((i) => wasm.getTextRange(sec, i, 0, wasm.getParagraphLength(sec, i))),
    length: (i) => wasm.getLogicalLength(sec, i),
    toLogical: (i, offset) => wasm.textToLogicalOffset(sec, i, offset),
    toText: (i, offset) => wasm.logicalToTextOffset(sec, i, offset),
    at: (i, charOffset) => ({ sectionIndex: sec, paragraphIndex: i, charOffset }),
  };
}

/**
 * 셀·글상자 문단들. 그 자리에 셀이 없으면 throw 한다. parentParaIndex·controlIndex 는
 * 표나 글상자가 놓인 본문 문단과 그 문단 안 컨트롤 인덱스다.
 */
function cellParagraphs(
  wasm: WasmBridge,
  position: DocumentPosition,
  parentParaIndex: number,
  controlIndex: number,
): ParagraphList {
  const sec = position.sectionIndex;
  const path = cellAxisPath(position).map((entry, depth) => (depth === 0 ? { ...entry, controlIndex } : entry));
  const last = path.length - 1;
  const pathAt = (i: number) => path.map((entry, depth) => (depth === last ? { ...entry, cellParaIndex: i } : entry));
  const json = memo((i) => JSON.stringify(pathAt(i)));
  return {
    home: path[last].cellParaIndex,
    count: wasm.getCellParagraphCountByPath(sec, parentParaIndex, JSON.stringify(path)),
    text: memo((i) => wasm.getTextInCellByPath(
      sec, parentParaIndex, json(i), 0, wasm.getCellParagraphLengthByPath(sec, parentParaIndex, json(i)),
    )),
    length: (i) => wasm.getCellLogicalLengthByPath(sec, parentParaIndex, json(i)),
    toLogical: (i, offset) => wasm.textToLogicalOffsetInCellByPath(sec, parentParaIndex, json(i), offset),
    toText: (i, offset) => wasm.logicalToTextOffsetInCellByPath(sec, parentParaIndex, json(i), offset),
    at: (i, charOffset) => ({
      ...withoutHitRect(position),
      parentParaIndex,
      controlIndex,
      paragraphIndex: i,
      cellParaIndex: i,
      charOffset,
      ...(position.cellPath?.length ? { cellPath: pathAt(i) } : {}),
    }),
  };
}

/** 앵커가 있던 구역이나 셀·글상자. 셀·글상자가 그 자리에 없으면 null. */
function homeParagraphs(wasm: WasmBridge, position: DocumentPosition): ParagraphList | null {
  if (position.parentParaIndex === undefined) return bodyParagraphs(wasm, position);
  try {
    return cellParagraphs(wasm, position, position.parentParaIndex, cellAxisPath(position)[0].controlIndex);
  } catch {
    return null;
  }
}

/** home 부터 가까운 순서의 인덱스 (home, home+1, home-1, ...). */
function* nearestFirst(home: number, count: number): Generator<number> {
  if (count <= 0) return;
  const start = Math.min(Math.max(home, 0), count - 1);
  for (let distance = 0; start - distance >= 0 || start + distance < count; distance++) {
    if (start + distance < count) yield start + distance;
    if (distance > 0 && start - distance >= 0) yield start - distance;
  }
}

/**
 * 셀·글상자가 놓인 본문 문단이나 문단 안 컨트롤 순서가 바뀌었을 때의 후보. 가까운 본문
 * 문단·컨트롤부터 같은 셀 경로를 찾는다. 처음 훑은 후보는 기억해 두고 다음 바늘부터 다시 쓴다.
 */
function movedCells(wasm: WasmBridge, position: DocumentPosition): Iterable<ParagraphList> {
  const seen: ParagraphList[] = [];
  const source = (function* () {
    const sec = position.sectionIndex;
    const homeParent = position.parentParaIndex!;
    const homeControl = cellAxisPath(position)[0].controlIndex;
    for (const parent of nearestFirst(homeParent, wasm.getParagraphCount(sec))) {
      for (const control of nearestFirst(homeControl, wasm.getControlTextPositions(sec, parent).length)) {
        if (parent === homeParent && control === homeControl) continue;
        let list: ParagraphList;
        try {
          list = cellParagraphs(wasm, position, parent, control);
        } catch {
          continue;
        }
        yield list;
      }
    }
  })();
  return {
    *[Symbol.iterator]() {
      yield* seen;
      for (let next = source.next(); !next.done; next = source.next()) {
        seen.push(next.value);
        yield next.value;
      }
    },
  };
}

function codePoints(text: string): number {
  return [...text].length;
}

/** text 안 needle 위치 중 caret 에 가장 가까운 캐럿 텍스트 오프셋. */
function nearestOccurrence(text: string, needle: Needle, caret: number): number | null {
  let best: number | null = null;
  for (let at = text.indexOf(needle.text); at >= 0; at = text.indexOf(needle.text, at + 1)) {
    const offset = codePoints(text.slice(0, at)) + needle.caret;
    if (best === null || Math.abs(offset - caret) < Math.abs(best - caret)) best = offset;
  }
  return best;
}

/** 텍스트 오프셋을 캐럿 좌표로 바꾼다. 같은 위치 개체의 캐럿 앞/뒤는 앵커를 따른다. */
function caretAt(list: ParagraphList, index: number, textOffset: number, objectsBefore: number): DocumentPosition {
  const base = list.toLogical(index, textOffset);
  const length = list.length(index);
  for (let k = objectsBefore; k > 0; k--) {
    if (base + k <= length && list.toText(index, base + k) === textOffset) return list.at(index, base + k);
  }
  return list.at(index, base);
}

export function captureCaretAnchor(wasm: WasmBridge, position: DocumentPosition): CaretAnchor {
  try {
    const list = homeParagraphs(wasm, position);
    if (list) {
      const textOffset = list.toText(list.home, position.charOffset);
      const chars = [...list.text(list.home)];
      return {
        position,
        textOffset,
        objectsBefore: position.charOffset - list.toLogical(list.home, textOffset),
        before: chars.slice(Math.max(0, textOffset - CONTEXT_CHARS), textOffset).join(''),
        after: chars.slice(textOffset, textOffset + CONTEXT_CHARS).join(''),
      };
    }
  } catch {
    // 읽을 수 없는 위치 — 문맥 없이 원래 좌표만 기억한다.
  }
  return { position, textOffset: position.charOffset, objectsBefore: 0, before: '', after: '' };
}

/**
 * 지금 문서에서 앵커 자리를 찾는다. 앞뒤 문맥이 모두 맞는 곳, 앞 문맥만, 뒤 문맥만 맞는 곳
 * 순으로 원래 문단과 오프셋에 가장 가까운 곳을 고른다. 앵커가 있던 구역·셀 안이 먼저이고,
 * 셀·글상자가 옮겨 갔을 때만 다른 셀을 본다 — 양식의 같은 글이 든 다른 표로 가지 않게.
 * 문서가 그대로면 원래 캐럿이 나온다. 아무 데도 맞지 않으면 원래 좌표를 문서 범위 안으로 당긴다.
 */
export function resolveCaretAnchor(wasm: WasmBridge, anchor: CaretAnchor): DocumentPosition {
  const needles: Needle[] = [
    { text: anchor.before + anchor.after, caret: codePoints(anchor.before) },
    { text: anchor.before, caret: codePoints(anchor.before) },
    { text: anchor.after, caret: 0 },
  ].filter((needle, i, all) => needle.text && all.findIndex((other) => other.text === needle.text) === i);
  const find = (list: ParagraphList, needle: Needle): DocumentPosition | null => {
    for (const index of nearestFirst(list.home, list.count)) {
      const offset = nearestOccurrence(list.text(index), needle, anchor.textOffset);
      if (offset !== null) return caretAt(list, index, offset, anchor.objectsBefore);
    }
    return null;
  };
  try {
    const home = homeParagraphs(wasm, anchor.position);
    if (home) {
      for (const needle of needles) {
        const hit = find(home, needle);
        if (hit) return hit;
      }
    }
    if (anchor.position.parentParaIndex !== undefined) {
      const lists = movedCells(wasm, anchor.position);
      for (const needle of needles) {
        for (const list of lists) {
          const hit = find(list, needle);
          if (hit) return hit;
        }
      }
    }
  } catch {
    // 조회 실패 — 아래에서 원래 좌표를 문서 범위 안으로 당긴다.
  }
  return clampCaretPosition(wasm, anchor.position);
}
