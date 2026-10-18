import type { ThemePreset } from './types.ts';

// claude.ai 의 따뜻한 아이보리·차콜 면과 Claude 공식 주황(#d97757) 강조색. 견본 색은 styles/themes/absolutely.css 와 같다.
// 주황 위 흰 글자는 4.5:1 에 못 미치므로 두 색 구성 모두 강조색 위 글자는 어두운 잉크다.
const preset: ThemePreset = {
  id: 'absolutely',
  label: 'Absolutely',
  schemes: ['light', 'dark'],
  light: { accent: '#d97757', onAccent: '#141413', chrome: '#faf9f5', desk: '#e8e6dc', sidebar: '#faf9f5', text: '#141413' },
  dark: { accent: '#d97757', onAccent: '#1f1e1d', chrome: '#262624', desk: '#1f1e1d', sidebar: '#262624', text: '#faf9f5' },
};

export default preset;
