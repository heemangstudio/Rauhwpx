import type { ThemePreset } from './types.ts';

/**
 * 기본 — 지금의 앱 색. 팔레트는 각 스타일시트의 fallback 값 그대로라 styles/themes/ 에 파일이 없다.
 * 강조색도 화면 곳곳의 기존 값(리본 파랑·크롬 남색·어두운 테마 빨강)을 그대로 두므로
 * 여기 accent 는 설정 화면의 견본으로만 쓴다.
 */
const preset: ThemePreset = {
  id: 'default',
  label: '기본',
  schemes: ['light', 'dark'],
  light: { accent: '#2f69b0', onAccent: '#ffffff', chrome: '#f2f3f5', desk: '#e8eaee', sidebar: '#f2f3f5', text: '#171b22' },
  dark: { accent: '#ef6a62', onAccent: '#2a0e0c', chrome: '#0f0f0f', desk: '#191919', sidebar: '#0c0c0c', text: '#e6e6e6' },
};

export default preset;
