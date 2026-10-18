import type { ThemePreset } from './types.ts';

// Latte(밝게)·Mocha(어둡게) 공식 값. 강조색은 Catppuccin 공식 포트들의 기본 강조색인 Mauve,
// 강조색 위 글자는 스타일 가이드의 "On Accent = Base" 를 따른다.
const preset: ThemePreset = {
  id: 'catppuccin',
  label: 'Catppuccin',
  schemes: ['light', 'dark'],
  light: { accent: '#8839ef', onAccent: '#eff1f5', chrome: '#e6e9ef', desk: '#dce0e8', sidebar: '#e6e9ef', text: '#4c4f69' },
  dark: { accent: '#cba6f7', onAccent: '#1e1e2e', chrome: '#181825', desk: '#11111b', sidebar: '#181825', text: '#cdd6f4' },
};

export default preset;
