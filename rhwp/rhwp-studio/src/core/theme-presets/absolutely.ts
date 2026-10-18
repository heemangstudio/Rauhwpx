import type { ThemePreset } from './types.ts';

// claude.ai 의 클레이 강조색과 따뜻한 아이보리·차콜 면. 견본 색은 styles/themes/absolutely.css 와 같다.
// 밝게의 강조색은 claude.ai 의 #c6613f 를 조금 눌러 메뉴·선택 행의 흰 글자가 4.5:1 을 넘게 했다(4.05 → 4.64).
const preset: ThemePreset = {
  id: 'absolutely',
  label: 'Absolutely',
  schemes: ['light', 'dark'],
  light: { accent: '#bb5735', onAccent: '#ffffff', chrome: '#faf9f5', desk: '#e8e6dc', sidebar: '#faf9f5', text: '#141413' },
  dark: { accent: '#d97757', onAccent: '#1f1e1d', chrome: '#262624', desk: '#1f1e1d', sidebar: '#262624', text: '#faf9f5' },
};

export default preset;
