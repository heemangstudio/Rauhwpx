export type SpecialSpaceOriginKind = 'Literal' | 'NbSpace' | 'FwSpace';
export interface SpecialSpaceOrigin { charIndex: number; origin: SpecialSpaceOriginKind }
export interface TextContent { text: string; specialSpaceOrigins?: SpecialSpaceOrigin[] }
export interface TextRemoval { removedStart: number; removedCount: number; removedContent: TextContent }

/** scalar 좌표의 명시적 출처. 빈 목록은 구형/미상이며 Unicode로 추정하지 않는다. */
export function validateTextContent(value: unknown): asserts value is TextContent {
  const content = value as Partial<TextContent> | null;
  if (!content || typeof content.text !== 'string' || (content.specialSpaceOrigins !== undefined && !Array.isArray(content.specialSpaceOrigins))) {
    throw new Error('잘못된 텍스트 콘텐츠');
  }
  const chars = [...content.text];
  let previous = -1;
  for (const record of content.specialSpaceOrigins ?? []) {
    if (!record || !Number.isSafeInteger(record.charIndex) || record.charIndex <= previous) {
      throw new Error('잘못된 빈칸 출처 인덱스');
    }
    const char = chars[record.charIndex];
    if ((record.origin === 'Literal' && char !== '\u00a0' && char !== '\u2007') ||
        (record.origin === 'NbSpace' && char !== '\u00a0') ||
        (record.origin === 'FwSpace' && char !== '\u2007') ||
        !['Literal', 'NbSpace', 'FwSpace'].includes(record.origin)) {
      throw new Error('빈칸 출처와 문자가 일치하지 않습니다');
    }
    previous = record.charIndex;
  }
}

export function parseTextRemoval(value: unknown): Partial<TextRemoval> {
  if (!value || typeof value !== 'object') throw new Error('잘못된 텍스트 삭제 결과');
  const result = value as Partial<TextRemoval>;
  const present = ['removedStart', 'removedCount', 'removedContent'].map(key => Object.hasOwn(value, key));
  if (!present.some(Boolean)) return {};
  if (!present.every(Boolean) || !Number.isSafeInteger(result.removedStart) || result.removedStart! < 0 ||
      !Number.isSafeInteger(result.removedCount) || result.removedCount! < 0) {
    throw new Error('불완전한 텍스트 삭제 콘텐츠');
  }
  validateTextContent(result.removedContent);
  if ([...result.removedContent.text].length !== result.removedCount) throw new Error('삭제 문자 수 불일치');
  return { removedStart: result.removedStart, removedCount: result.removedCount, removedContent: result.removedContent };
}

/** 삭제 병합은 실제 삭제된 콘텐츠의 scalar 수로 오른쪽 출처를 이동한다. */
export function concatTextContent(left: TextContent, right: TextContent): TextContent {
  validateTextContent(left); validateTextContent(right);
  const offset = [...left.text].length;
  return {
    text: left.text + right.text,
    specialSpaceOrigins: [...(left.specialSpaceOrigins ?? []).map(record => ({ ...record })),
      ...(right.specialSpaceOrigins ?? []).map(record => ({ ...record, charIndex: record.charIndex + offset }))],
  };
}

export interface LocalBodyTextReplaceResult extends Partial<TextRemoval> {
  ok: true;
  charOffset: number;
  documentPaginationPending: boolean;
  flowChanged: boolean;
}

export function parseLocalBodyTextReplaceResult(
  raw: string,
): LocalBodyTextReplaceResult {
  const parsed = JSON.parse(raw) as Partial<LocalBodyTextReplaceResult>;
  if (
    parsed.ok !== true ||
    !Number.isInteger(parsed.charOffset) ||
    typeof parsed.documentPaginationPending !== 'boolean' ||
    typeof parsed.flowChanged !== 'boolean' ||
    (parsed.flowChanged && parsed.documentPaginationPending)
  ) {
    throw new Error('잘못된 local body text replace 결과');
  }
  parseTextRemoval(parsed);
  return parsed as LocalBodyTextReplaceResult;
}
