import type { DiffItem } from '../../compare/types.ts';

export type DiffPiece = { text: string; changed: boolean };
export type DiffParts = { before: DiffPiece[]; after: DiffPiece[] };

function splitWords(text: string): string[] {
  return text.match(/\s+|[^\s]+/gu) ?? [];
}

function coalesce(tokens: string[], changed: boolean): DiffPiece[] {
  return tokens.length ? [{ text: tokens.join(''), changed }] : [];
}

export function inlineParts(before: string, after: string): DiffParts {
  if (before === after) return { before: coalesce([before], false), after: coalesce([after], false) };
  const left = splitWords(before);
  const right = splitWords(after);
  let prefix = 0;
  while (prefix < left.length && prefix < right.length && left[prefix] === right[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < left.length - prefix && suffix < right.length - prefix
    && left[left.length - suffix - 1] === right[right.length - suffix - 1]) suffix += 1;

  const leftMiddle = left.slice(prefix, left.length - suffix);
  const rightMiddle = right.slice(prefix, right.length - suffix);
  const beforePieces: DiffPiece[] = coalesce(left.slice(0, prefix), false);
  const afterPieces: DiffPiece[] = coalesce(right.slice(0, prefix), false);

  // Large paragraphs stay responsive. Prefix/suffix still mark the exact changed span.
  if (leftMiddle.length * rightMiddle.length > 40_000) {
    beforePieces.push(...coalesce(leftMiddle, true));
    afterPieces.push(...coalesce(rightMiddle, true));
  } else {
    const rows = leftMiddle.length + 1;
    const cols = rightMiddle.length + 1;
    const table = new Uint16Array(rows * cols);
    for (let i = leftMiddle.length - 1; i >= 0; i -= 1) {
      for (let j = rightMiddle.length - 1; j >= 0; j -= 1) {
        table[i * cols + j] = leftMiddle[i] === rightMiddle[j]
          ? table[(i + 1) * cols + j + 1] + 1
          : Math.max(table[(i + 1) * cols + j], table[i * cols + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    const append = (list: DiffPiece[], token: string, changed: boolean): void => {
      const last = list[list.length - 1];
      if (last?.changed === changed) last.text += token;
      else list.push({ text: token, changed });
    };
    while (i < leftMiddle.length || j < rightMiddle.length) {
      if (i < leftMiddle.length && j < rightMiddle.length && leftMiddle[i] === rightMiddle[j]) {
        append(beforePieces, leftMiddle[i], false);
        append(afterPieces, rightMiddle[j], false);
        i += 1;
        j += 1;
      } else if (i < leftMiddle.length && (j === rightMiddle.length || table[(i + 1) * cols + j] >= table[i * cols + j + 1])) {
        append(beforePieces, leftMiddle[i], true);
        i += 1;
      } else {
        append(afterPieces, rightMiddle[j], true);
        j += 1;
      }
    }
  }
  beforePieces.push(...coalesce(left.slice(left.length - suffix), false));
  afterPieces.push(...coalesce(right.slice(right.length - suffix), false));
  return { before: beforePieces, after: afterPieces };
}

/** 문단 안 글자 범위 [start, end). */
export interface DiffTextRange { start: number; end: number }

/**
 * '+' 줄에 표시한 바뀐 조각들의, 지금 문단 기준 글자 범위. 지우기만 했으면 지운 자리의
 * 빈 범위 하나다. 본문 문단의 텍스트 변경이 아니면 null.
 */
export function changedTextRanges(item: DiffItem): DiffTextRange[] | null {
  if (item.kind !== 'text' || item.path.paragraph === undefined) return null;
  if (item.severity === 'added') return item.rightPreview ? [{ start: 0, end: item.rightPreview.length }] : null;
  if (item.severity !== 'modified') return null;
  const { before, after } = inlineParts(item.leftPreview, item.rightPreview);
  const ranges: DiffTextRange[] = [];
  let offset = 0;
  for (const piece of after) {
    const end = offset + piece.text.length;
    const last = ranges[ranges.length - 1];
    // 공백만 사이에 둔 바뀐 조각은 한 자리로 짚는다.
    if (piece.changed && last && !item.rightPreview.slice(last.end, offset).trim()) last.end = end;
    else if (piece.changed) ranges.push({ start: offset, end });
    offset = end;
  }
  if (ranges.length) return ranges;
  // 바뀌지 않은 조각은 양쪽이 같으니, 지운 조각 앞까지의 글자 수가 지금 문단의 자리다.
  let kept = 0;
  for (const piece of before) {
    if (piece.changed) return [{ start: kept, end: kept }];
    kept += piece.text.length;
  }
  return null;
}
