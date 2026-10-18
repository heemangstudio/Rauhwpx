import type { ThemePreset } from './types.ts';

/* 한컴 — 강조는 한/글 아이콘(hwp.icns)의 파랑, 면은 한컴오피스 한/글의 밝은·어두운 크롬. 값의 출처는 styles/themes/hancom.css 머리말. */
const preset: ThemePreset = {
  id: 'hancom',
  label: '한컴',
  schemes: ['light', 'dark'],
  light: { accent: '#006dcc', chrome: '#f6f6f6', desk: '#e4e4e4', sidebar: '#efefef', text: '#222222' },
  dark: { accent: '#42adff', chrome: '#333333', desk: '#1e1e1e', sidebar: '#2b2b2b', text: '#e6e6e6' },
};

export default preset;
