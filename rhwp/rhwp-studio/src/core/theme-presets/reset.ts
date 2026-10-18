import type { ThemePreset } from './types.ts';

const preset: ThemePreset = {
  id: 'reset',
  label: 'Reset',
  schemes: ['light', 'dark'],
  light: { accent: '#0169cc', chrome: '#ffffff', desk: '#efefef', sidebar: '#f9f9f9', text: '#1a1c1f' },
  dark: { accent: '#339cff', onAccent: '#0d0d0d', chrome: '#181818', desk: '#111111', sidebar: '#141414', text: '#dfdfdf' },
};

export default preset;
