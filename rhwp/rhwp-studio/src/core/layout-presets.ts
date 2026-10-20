/**
 * 용지·쪽 여백·문단 간격 프리셋 — 메뉴(쪽 › 쪽 여백, 서식 › 문단 간격), 편집 용지
 * 대화상자, 에이전트 set_page_layout 이 함께 쓰는 단일 표.
 * 허브(rhwp-agent/tools.mjs)는 id·이름 목록만 갖는다.
 */
import type { PageDef } from './types.ts';

const HU_PER_MM = 7200 / 25.4;

/** mm → HWPUNIT */
export function mmToHwpunit(mm: number): number {
  return Math.round(mm * HU_PER_MM);
}

/**
 * 용지 크기(세로 기준 폭·길이, HWPUNIT) — 한컴 용지 목록(IDS_PAPER_*)의 값.
 * 가로 용지도 이 크기로 저장하고 landscape 로 돌린다(엔진이 폭/길이를 바꿔 그린다).
 */
export const PAPER_SIZES: readonly (readonly [name: string, width: number, height: number])[] = [
  ['A4', 59527, 84188],
  ['A3', 84188, 119052],
  ['B4', 72852, 103180],
  ['B5', 51592, 72852],
  ['Letter', 61200, 79200],
  ['Legal', 61200, 100800],
];

export interface PageMarginsMm {
  top: number;
  bottom: number;
  left: number;
  right: number;
  header: number;
  footer: number;
}

export interface PageMarginPreset {
  id: string;
  label: string;
  margins: PageMarginsMm;
}

/** 한컴 Mac 12 의 쪽 여백 목록(IDS_TBOX_PAGE_MARGIN_01..06)과 같은 순서·값(mm). */
export const PAGE_MARGIN_PRESETS: readonly PageMarginPreset[] = [
  { id: 'default', label: '기본', margins: { top: 20, bottom: 15, left: 30, right: 30, header: 15, footer: 15 } },
  { id: 'narrow1-hf', label: '좁게1(머리말/꼬리말 여백 포함)', margins: { top: 10, bottom: 10, left: 20, right: 20, header: 15, footer: 15 } },
  { id: 'narrow2-hf', label: '좁게2(머리말/꼬리말 여백 포함)', margins: { top: 5, bottom: 5, left: 10, right: 10, header: 10, footer: 10 } },
  { id: 'wide-hf', label: '넓게(머리말/꼬리말 여백 포함)', margins: { top: 35, bottom: 35, left: 40, right: 40, header: 10, footer: 10 } },
  { id: 'narrow', label: '좁게', margins: { top: 10, bottom: 10, left: 10, right: 10, header: 0, footer: 0 } },
  { id: 'wide', label: '넓게', margins: { top: 35, bottom: 35, left: 40, right: 40, header: 0, footer: 0 } },
];

export const PAGE_MARGIN_PRESET_IDS: readonly string[] = PAGE_MARGIN_PRESETS.map(p => p.id);

export function findPageMarginPreset(id: string): PageMarginPreset | undefined {
  return PAGE_MARGIN_PRESETS.find(p => p.id === id);
}

/** 여백 6칸(mm)만 바꾼 PageDef. 용지·방향·제본 여백은 그대로다. */
export function withPageMarginsMm(def: PageDef, margins: Partial<PageMarginsMm>): PageDef {
  const next = { ...def };
  if (margins.top !== undefined) next.marginTop = mmToHwpunit(margins.top);
  if (margins.bottom !== undefined) next.marginBottom = mmToHwpunit(margins.bottom);
  if (margins.left !== undefined) next.marginLeft = mmToHwpunit(margins.left);
  if (margins.right !== undefined) next.marginRight = mmToHwpunit(margins.right);
  if (margins.header !== undefined) next.marginHeader = mmToHwpunit(margins.header);
  if (margins.footer !== undefined) next.marginFooter = mmToHwpunit(margins.footer);
  return next;
}

/** 0.1mm 안팎(28 HWPUNIT)은 같은 여백으로 본다 — 대화상자 표시 단위와 같다. */
const MARGIN_TOLERANCE_HU = 28;

/** 모든 구역이 같은 프리셋 여백이면 그 id, 아니면 null. */
export function matchPageMarginPreset(defs: readonly PageDef[]): string | null {
  if (defs.length === 0) return null;
  for (const preset of PAGE_MARGIN_PRESETS) {
    const want = withPageMarginsMm(defs[0], preset.margins);
    const same = defs.every(def => (
      ['marginTop', 'marginBottom', 'marginLeft', 'marginRight', 'marginHeader', 'marginFooter'] as const
    ).every(key => Math.abs(def[key] - want[key]) <= MARGIN_TOLERANCE_HU));
    if (same) return preset.id;
  }
  return null;
}

/**
 * 용지를 넘는 여백이면 오류 문구를 돌려준다(편집 용지 대화상자와 같은 규칙).
 * 가로 용지는 엔진이 폭/길이를 바꿔 그리므로 화면 기준 폭/길이로 따진다.
 */
export function pageMarginsError(def: PageDef): string | null {
  const width = def.landscape ? def.height : def.width;
  const height = def.landscape ? def.width : def.height;
  if (def.marginLeft + def.marginRight + def.marginGutter >= width) {
    return '왼쪽·오른쪽·제본 여백의 합이 용지 폭보다 작아야 합니다.';
  }
  if (def.marginTop + def.marginBottom + def.marginHeader + def.marginFooter >= height) {
    return '위쪽·아래쪽·머리말·꼬리말 여백의 합이 용지 길이보다 작아야 합니다.';
  }
  return null;
}

export interface ParaSpacingPreset {
  id: 'narrow' | 'default' | 'wide';
  label: string;
  /** 줄 간격 (글자에 따라, %) */
  lineSpacing: number;
  spacingBeforePt: number;
  spacingAfterPt: number;
}

/**
 * 문단 간격 프리셋. 한컴에는 없는 묶음이라 Word 의 문단 간격 묶음을 한컴 단위로
 * 옮겼다. 기본은 한컴 바탕글 기본값(160%)이다.
 */
export const PARA_SPACING_PRESETS: readonly ParaSpacingPreset[] = [
  { id: 'narrow', label: '좁게', lineSpacing: 130, spacingBeforePt: 0, spacingAfterPt: 0 },
  { id: 'default', label: '기본', lineSpacing: 160, spacingBeforePt: 0, spacingAfterPt: 0 },
  { id: 'wide', label: '넓게', lineSpacing: 200, spacingBeforePt: 0, spacingAfterPt: 6 },
];

/** 문단 모양 원시값 — 문단 간격은 HWPUNIT 의 2배로 저장된다(para-shape-model 의 ptToRaw2x). */
export function paraSpacingRaw(preset: ParaSpacingPreset): {
  lineSpacing: number; spacingBefore: number; spacingAfter: number;
} {
  return {
    lineSpacing: preset.lineSpacing,
    spacingBefore: Math.round(preset.spacingBeforePt * 200),
    spacingAfter: Math.round(preset.spacingAfterPt * 200),
  };
}

/** 엔진 getDocumentParaSpacing 결과 — 값이 섞였으면 null */
export interface DocumentParaSpacing {
  count: number;
  lineSpacing: number | null;
  spacingBefore: number | null;
  spacingAfter: number | null;
}

/** 대상 문단 전부가 같은 프리셋 값이면 그 id, 아니면 null. */
export function matchParaSpacingPreset(summary: DocumentParaSpacing): ParaSpacingPreset['id'] | null {
  if (summary.count === 0) return null;
  for (const preset of PARA_SPACING_PRESETS) {
    const raw = paraSpacingRaw(preset);
    if (summary.lineSpacing === raw.lineSpacing
      && summary.spacingBefore === raw.spacingBefore
      && summary.spacingAfter === raw.spacingAfter) return preset.id;
  }
  return null;
}
