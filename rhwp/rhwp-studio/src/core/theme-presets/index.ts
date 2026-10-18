/**
 * 테마 프리셋 목록. 프리셋마다 메타데이터 한 파일(<id>.ts)과 팔레트 한 파일
 * (styles/themes/<id>.css)이 있고, 여기서 둘을 이름으로 묶는다. 순서는 설정 화면의 타일 순서다.
 */
import { THEME_PRESET_IDS, type ThemePresetId } from '../user-settings.ts';
import type { ThemePreset, ThemePresetScheme, ThemeScheme } from './types.ts';
import defaultPreset from './default.ts';
import catppuccin from './catppuccin.ts';
import hancom from './hancom.ts';
import hacker from './hacker.ts';
import absolutely from './absolutely.ts';
import reset from './reset.ts';

export type { ThemePreset, ThemePresetScheme, ThemeScheme } from './types.ts';

export const THEME_PRESETS: Readonly<Record<ThemePresetId, ThemePreset>> = {
  default: defaultPreset,
  catppuccin,
  hancom,
  hacker,
  absolutely,
  reset,
};

export const THEME_PRESET_LIST: readonly ThemePreset[] = THEME_PRESET_IDS.map((id) => THEME_PRESETS[id]);

export function getThemePreset(id: ThemePresetId): ThemePreset {
  return THEME_PRESETS[id] ?? defaultPreset;
}

/** 한 가지 색 구성만 가진 프리셋이면 그 구성, 아니면 null(모드를 따른다). */
export function lockedScheme(preset: ThemePreset): ThemeScheme | null {
  return preset.schemes.length === 1 ? preset.schemes[0] : null;
}

/** 요청한 색 구성이 프리셋에 없으면 프리셋이 가진 구성으로 바꾼다. */
export function resolvePresetScheme(preset: ThemePreset, requested: ThemeScheme): ThemeScheme {
  return preset.schemes.includes(requested) ? requested : preset.schemes[0] ?? requested;
}

/** 색 구성의 메타데이터. 빠졌으면 프리셋이 가진 다른 구성, 그것도 없으면 기본 프리셋 값을 쓴다. */
export function presetScheme(preset: ThemePreset, scheme: ThemeScheme): ThemePresetScheme {
  return preset[resolvePresetScheme(preset, scheme)]
    ?? preset.light ?? preset.dark
    ?? defaultPreset[scheme] as ThemePresetScheme;
}
