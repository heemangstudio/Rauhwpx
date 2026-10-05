import type { BorderLineProps, PageBorderFillSettings } from '@/core/types';

/** 쪽 테두리/배경 대화상자가 확인 시점에 읽은 값 (HWPUNIT 환산 완료) */
export interface PageBorderForm {
  basis: 'paper' | 'page';
  spacingLeft: number;
  spacingRight: number;
  spacingTop: number;
  spacingBottom: number;
  borderLeft: BorderLineProps;
  borderRight: BorderLineProps;
  borderTop: BorderLineProps;
  borderBottom: BorderLineProps;
  fillType: 'solid' | 'none';
  fillColor: string;
  patternColor: string;
  patternType: number;
  fillArea: 'paper' | 'page' | 'border';
  hideBorder: boolean;
  hideFill: boolean;
  applyPage: 'all' | 'exceptFirst';
}

/** 배경 채우기를 정하는 키 — 엔진은 fillType 이 있으면 기존 채우기를 통째로 바꾼다. */
const FILL_KEYS = ['fillType', 'fillColor', 'patternColor', 'patternType', 'fillAlpha'] as const;

/** 그러데이션/그림 배경 키 — 엔진의 무손실 재적용 전용이고 대화상자는 편집하지 않는다. */
const REFERENCE_FILL_KEYS = [
  'gradientType', 'gradientAngle', 'gradientCenterX', 'gradientCenterY', 'gradientBlur',
  'gradientStepCenter', 'gradientColors', 'gradientPositions',
  'imageFillMode', 'imageBrightness', 'imageContrast', 'imageEffect', 'imageBinDataId',
] as const;

/**
 * 쪽 테두리/배경 적용 JSON 을 만든다.
 *
 * 대화상자는 그림·그러데이션 배경을 '없음'으로 보여 주고 편집하지 못한다. 배경 칸을
 * 건드리지 않았는데 보이는 값(fillType 'none')을 그대로 보내면 엔진이 기존 채우기를
 * 기본값으로 바꿔 배경 그림이 사라진다. 배경을 건드리지 않았으면 채우기 키를 빼서,
 * 엔진이 현재 borderFillId 를 복제하고 테두리만 덮어쓰게 한다(투명도·무늬도 보존).
 */
export function buildPageBorderPatch(
  settings: PageBorderFillSettings,
  form: PageBorderForm,
  fillTouched: boolean,
): Record<string, unknown> {
  const patch: Record<string, unknown> = { ...settings, ...form };
  for (const key of REFERENCE_FILL_KEYS) delete patch[key];
  if (!fillTouched) {
    for (const key of FILL_KEYS) delete patch[key];
  }
  return patch;
}
