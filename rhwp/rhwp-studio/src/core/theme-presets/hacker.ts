import type { ThemePreset } from './types.ts';

/** 어두운 색 구성만 있다. 켜져 있는 동안 모드 선택은 어둡게로 잠긴다. */
const preset: ThemePreset = {
  id: 'hacker',
  label: 'Hacker',
  schemes: ['dark'],
  dark: { accent: '#ff5566', onAccent: '#2a0507', chrome: '#050a07', desk: '#020503', sidebar: '#040805', text: '#a4dfa6' },
};

export default preset;
