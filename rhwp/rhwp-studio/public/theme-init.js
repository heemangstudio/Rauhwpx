// 다크테마 FOUC(Flash of Unstyled Content) 방지 — 페이지 렌더 전에 테마를 즉시 적용한다.
//
// 브라우저 확장 CSP(`script-src 'self' 'wasm-unsafe-eval'`)는 인라인 스크립트를 금지하므로,
// 이 로직은 인라인이 아니라 외부 파일로 두고 index.html <head> 최상단에서
// `<script src="/theme-init.js">`(동기)로 로드한다 (#1444). module/defer 를 쓰면 번들 이후
// 실행되어 FOUC 방지 효과를 잃으므로 동기 로드를 유지한다.
(() => {
  const root = document.documentElement;
  const isThemeMode = (value) => value === 'system' || value === 'light' || value === 'dark';
  // 프리셋 이름과 어두운 구성만 가진 프리셋. src/core/user-settings.ts 의 THEME_PRESET_IDS,
  // src/core/theme-presets/*.ts 의 schemes 와 같아야 한다. 강조색은 번들의 theme.ts 가 건다.
  const PRESETS = ['default', 'catppuccin', 'hancom', 'hacker', 'absolutely', 'reset'];
  const DARK_ONLY = ['hacker'];
  let mode = 'system';
  let preset = 'default';
  try {
    const settings = JSON.parse(localStorage.getItem('rhwp-settings') || '{}');
    const storedMode = settings && settings.theme && settings.theme.mode;
    if (isThemeMode(storedMode)) mode = storedMode;
    const storedPreset = settings && settings.theme && settings.theme.preset;
    if (PRESETS.includes(storedPreset)) preset = storedPreset;
  } catch {
    mode = 'system';
  }
  const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  const effective = DARK_ONLY.includes(preset) || mode === 'dark' || (mode === 'system' && prefersDark) ? 'dark' : 'light';
  const scheme = `only ${effective}`;
  root.dataset.themeMode = mode;
  root.dataset.themeEffective = effective;
  root.dataset.themePreset = preset;
  root.style.colorScheme = scheme;
  const colorSchemeMeta = document.querySelector('meta[name="color-scheme"]');
  if (colorSchemeMeta) colorSchemeMeta.setAttribute('content', scheme);
  const themeColorMeta = document.querySelector('meta[name="theme-color"]');
  if (themeColorMeta) themeColorMeta.setAttribute('content', effective === 'dark' ? '#000000' : '#ffffff');
})();
