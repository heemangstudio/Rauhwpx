import type { ThemePresetId } from '../user-settings.ts';

export type ThemeScheme = 'light' | 'dark';

/** 프리셋의 색 구성 하나(밝게 또는 어둡게). 팔레트 전체는 styles/themes/<id>.css 에 있다. */
export interface ThemePresetScheme {
  /** 프리셋 강조색(#rrggbb). 리본 아이콘·눈금자 표식·선택 행·열린 메뉴에 쓴다. 사용자가 고른 강조색이 대신할 수 있다. */
  accent: string;
  /** 강조색 위에 얹는 글자색. 없으면 대비가 큰 쪽(흰색 또는 짙은 잉크)을 고른다. */
  onAccent?: string;
  /** 설정 타일 견본: 메뉴·리본 면 */
  chrome: string;
  /** 설정 타일 견본: 문서 책상(용지 둘레) */
  desk: string;
  /** 설정 타일 견본: 사이드바 면 */
  sidebar: string;
  /** 설정 타일 견본: 글자 */
  text: string;
}

/**
 * 프리셋 메타데이터. schemes 가 ['dark'] 처럼 하나뿐이면 그 색 구성만 쓰고,
 * 모드(시스템·밝게·어둡게) 선택은 잠긴다.
 */
export interface ThemePreset {
  id: ThemePresetId;
  label: string;
  schemes: readonly ThemeScheme[];
  light?: ThemePresetScheme;
  dark?: ThemePresetScheme;
}
