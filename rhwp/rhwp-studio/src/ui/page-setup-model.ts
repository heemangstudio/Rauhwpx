import type { PageDef } from '@/core/types';

const HWPUNIT_PER_MM = 7200 / 25.4; // ≈283.46

export const PAGE_MARGIN_KEYS = [
  'marginTop', 'marginBottom', 'marginLeft', 'marginRight',
  'marginHeader', 'marginFooter', 'marginGutter',
] as const;

export type PageMarginKey = typeof PAGE_MARGIN_KEYS[number];

/** 편집 용지 칸의 표시 서식 (mm, 소수 1자리) */
export function formatPageMm(hu: number): string {
  return (Math.round(hu * 25.4 / 7200 * 10) / 10).toFixed(1);
}

function mmTextToHwpunit(text: string): number {
  return Math.round((parseFloat(text) || 0) * HWPUNIT_PER_MM);
}

/** 대화상자 칸의 값 — 폭/길이는 화면 방향(가로면 교환된) 기준 */
export interface PageSetupFields {
  width: string;
  height: string;
  margins: Record<PageMarginKey, string>;
}

export interface PageSetupForm extends PageSetupFields {
  landscape: boolean;
  binding: number;
}

export type PageSetupResult =
  | { ok: true; pageDef: PageDef }
  | { ok: false; error: string };

/**
 * 편집 용지 칸에서 PageDef 를 만든다.
 *
 * 칸은 0.1mm 로 표시되므로(약 28 HWPUNIT) 되돌려 쓰면 값이 조금씩 흘러간다.
 * 표시값 그대로인 칸은 원래 HWPUNIT 를 쓴다(방향을 바꿔 폭/길이 칸이 서로
 * 바뀐 경우 포함). 빈 크기나 용지를 넘는 여백은 오류로 돌려준다.
 */
export function buildPageDefFromForm(
  original: PageDef,
  shown: PageSetupFields,
  form: PageSetupForm,
): PageSetupResult {
  const shownRawWidth = original.landscape ? original.height : original.width;
  const shownRawHeight = original.landscape ? original.width : original.height;
  const resolveSize = (text: string, ownShown: string, ownRaw: number, otherShown: string, otherRaw: number) => {
    if (text === ownShown) return ownRaw;
    if (text === otherShown) return otherRaw;
    return mmTextToHwpunit(text);
  };
  const width = resolveSize(form.width, shown.width, shownRawWidth, shown.height, shownRawHeight);
  const height = resolveSize(form.height, shown.height, shownRawHeight, shown.width, shownRawWidth);
  if (!(width > 0) || !(height > 0)) {
    return { ok: false, error: '용지 폭과 길이를 입력하세요.' };
  }

  const margins = {} as Record<PageMarginKey, number>;
  for (const key of PAGE_MARGIN_KEYS) {
    const text = form.margins[key];
    margins[key] = text === shown.margins[key] ? original[key] : Math.max(0, mmTextToHwpunit(text));
  }
  if (margins.marginLeft + margins.marginRight + margins.marginGutter >= width) {
    return { ok: false, error: '왼쪽·오른쪽·제본 여백의 합이 용지 폭보다 작아야 합니다.' };
  }
  if (margins.marginTop + margins.marginBottom + margins.marginHeader + margins.marginFooter >= height) {
    return { ok: false, error: '위쪽·아래쪽·머리말·꼬리말 여백의 합이 용지 길이보다 작아야 합니다.' };
  }

  // landscape 는 PageDef 에 원래(세로) 크기로 저장한다.
  const [storedWidth, storedHeight] = form.landscape ? [height, width] : [width, height];
  return {
    ok: true,
    pageDef: {
      width: storedWidth,
      height: storedHeight,
      ...margins,
      landscape: form.landscape,
      binding: form.binding,
    },
  };
}
