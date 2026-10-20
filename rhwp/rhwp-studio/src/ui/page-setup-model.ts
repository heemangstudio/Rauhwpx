import type { PageDef, DocumentPosition } from '@/core/types';
import { pageMarginsError } from '../core/layout-presets.ts';

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

  // landscape 는 PageDef 에 원래(세로) 크기로 저장한다.
  const [storedWidth, storedHeight] = form.landscape ? [height, width] : [width, height];
  const pageDef: PageDef = {
    width: storedWidth,
    height: storedHeight,
    ...margins,
    landscape: form.landscape,
    binding: form.binding,
  };
  const error = pageMarginsError(pageDef);
  return error ? { ok: false, error } : { ok: true, pageDef };
}

export interface PageDefApplyTarget {
  wasm: {
    setPageDef(sectionIdx: number, def: PageDef): { ok: boolean };
    setPageDefAll(patch: Partial<PageDef>): { ok: boolean };
  };
  inputHandler?: {
    executeOperation(desc: {
      kind: 'snapshot';
      operationType: string;
      operation: () => DocumentPosition;
    }): void;
    getCursorPosition(): DocumentPosition;
  } | null;
  eventBus: { emit(event: string): void };
}

/**
 * 쪽 정의를 한 번의 되돌리기 단위로 적용한다(편집 용지·쪽 여백 프리셋 공용).
 * `scope` 가 'all' 이면 모든 구역에 같은 키만 덮어쓰고 재조판은 한 번만 한다.
 * 입력 처리기가 없으면(구 호출부) 기록 없이 바로 적용하고 문서 변경만 알린다.
 */
export function applyPageDefs(
  target: PageDefApplyTarget,
  scope: 'all' | number,
  patch: PageDef | Partial<PageDef>,
): void {
  const apply = (): boolean => scope === 'all'
    ? target.wasm.setPageDefAll(patch).ok
    : target.wasm.setPageDef(scope, patch as PageDef).ok;
  const ih = target.inputHandler;
  if (ih) {
    ih.executeOperation({
      kind: 'snapshot',
      operationType: 'pageSetup',
      operation: () => { apply(); return ih.getCursorPosition(); },
    });
  } else if (apply()) {
    target.eventBus.emit('document-changed');
  }
}
