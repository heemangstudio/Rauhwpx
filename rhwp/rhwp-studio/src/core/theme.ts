import { userSettings, type ThemeMode, type ThemePresetId, type ThemeSettings } from './user-settings.ts';
import { getThemePreset, lockedScheme, presetScheme, type ThemeScheme } from './theme-presets/index.ts';

export type EffectiveTheme = ThemeScheme;

/** 화면에 실제로 걸린 테마. 설정값(mode·preset·accent)과 그 결과(effective)를 함께 담는다. */
export interface AppliedTheme extends ThemeSettings {
  effective: EffectiveTheme;
}

const THEME_QUERY = '(prefers-color-scheme: dark)';
const THEME_COLOR_META_SELECTOR = 'meta[name="theme-color"]';
const COLOR_SCHEME_META_SELECTOR = 'meta[name="color-scheme"]';

/**
 * 강조색 계열. 프리셋 강조색과 사용자 강조색은 html 의 인라인 변수로 걸고, 나머지 단계는
 * styles/themes/index.css 의 --theme-derived-* 가 색 구성마다 color-mix 로 만든다.
 */
const ACCENT_SHADES = ['strong', 'light', 'hover', 'subtle', 'soft'] as const;
const ACCENT_PROPERTIES = [
  '--theme-accent',
  '--theme-on-accent',
  ...ACCENT_SHADES.map((shade) => `--theme-accent-${shade}`),
  '--theme-ribbon-accent',
  '--theme-ribbon-accent-soft',
] as const;

function prefersDark(): boolean {
  return window.matchMedia?.(THEME_QUERY).matches ?? false;
}

function syncThemeColorMeta(root: HTMLElement): void {
  const meta = document.querySelector<HTMLMetaElement>(THEME_COLOR_META_SELECTOR);
  if (!meta) return;
  const themeColor = getComputedStyle(document.getElementById('studio-header') ?? root)
    .getPropertyValue('--ui-bg-light').trim() || '#ffffff';
  meta.content = themeColor;
}

function syncBrowserColorScheme(root: HTMLElement, effective: EffectiveTheme): void {
  const scheme = `only ${effective}`;
  root.style.colorScheme = scheme;
  const meta = document.querySelector<HTMLMetaElement>(COLOR_SCHEME_META_SELECTOR);
  if (meta) meta.content = scheme;
}

function channels(hex: string): [number, number, number] {
  return [1, 3, 5].map((index) => parseInt(hex.slice(index, index + 2), 16)) as [number, number, number];
}

function relativeLuminance(hex: string): number {
  const [r, g, b] = channels(hex).map((value) => {
    const c = value / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 대비. 두 색 모두 #rrggbb. */
function contrastRatio(first: string, second: string): number {
  const [light, dark] = [relativeLuminance(first), relativeLuminance(second)].sort((a, b) => b - a);
  return (light + 0.05) / (dark + 0.05);
}

/**
 * 강조색 위 글자색. 흰색이 4.5:1 을 넘으면 흰색, 아니면 강조색을 검게 누른 잉크와 흰색 중
 * 대비가 큰 쪽을 쓴다. CSS contrast-color() 를 쓸 수 없어 여기서 계산한다.
 */
function readableOnAccent(accent: string): string {
  const white = '#ffffff';
  if (contrastRatio(accent, white) >= 4.5) return white;
  const ink = `#${channels(accent).map((value) => Math.round(value * 0.18).toString(16).padStart(2, '0')).join('')}`;
  return contrastRatio(accent, ink) >= contrastRatio(accent, white) ? ink : white;
}

export function getThemeSettings(): ThemeSettings {
  return { ...userSettings.getThemeSettings() };
}

export function getThemeMode(): ThemeMode {
  return userSettings.getThemeSettings().mode;
}

/** 프리셋이 한 가지 색 구성만 가지면 그 구성. 이때 모드 선택은 잠긴다. */
export function getLockedScheme(preset: ThemePresetId = userSettings.getThemeSettings().preset): EffectiveTheme | null {
  return lockedScheme(getThemePreset(preset));
}

function toSettings(theme: ThemeSettings | ThemeMode | undefined): ThemeSettings {
  if (theme === undefined) return getThemeSettings();
  if (typeof theme === 'string') return { ...getThemeSettings(), mode: theme };
  return theme;
}

export function getEffectiveTheme(theme?: ThemeSettings | ThemeMode): EffectiveTheme {
  const settings = toSettings(theme);
  const locked = getLockedScheme(settings.preset);
  if (locked) return locked;
  if (settings.mode === 'dark') return 'dark';
  if (settings.mode === 'light') return 'light';
  return prefersDark() ? 'dark' : 'light';
}

let switchFrame = 0;

/**
 * 테마가 실제로 바뀌는 순간 한 프레임 동안 전환을 끈다(html.theme-switching).
 * 면마다 다른 transition 시간으로 색이 번지지 않고 한 번에 바뀐다.
 * 첫 프레임에 새 색이 칠해진 뒤 다음 프레임에 클래스를 뗀다.
 */
function suppressTransitionsForSwitch(root: HTMLElement): void {
  root.classList.add('theme-switching');
  cancelAnimationFrame(switchFrame);
  switchFrame = requestAnimationFrame(() => {
    switchFrame = requestAnimationFrame(() => {
      switchFrame = 0;
      root.classList.remove('theme-switching');
    });
  });
}

/** html 에 걸 강조색 인라인 변수. 기본 프리셋에 사용자 강조색이 없으면 비어 있다(스타일시트 값 그대로). */
function accentProperties(settings: ThemeSettings, effective: EffectiveTheme): Map<string, string> {
  const properties = new Map<string, string>();
  const preset = getThemePreset(settings.preset);
  const presetColors = preset.id === 'default' ? null : presetScheme(preset, effective);
  const accent = settings.accent ?? presetColors?.accent ?? null;
  if (!accent) return properties;
  properties.set('--theme-accent', accent);
  properties.set('--theme-on-accent', settings.accent ? readableOnAccent(accent) : presetColors?.onAccent ?? readableOnAccent(accent));
  if (settings.accent) {
    // 사용자 강조색은 프리셋이 손으로 정한 단계 색까지 대신한다.
    for (const shade of ACCENT_SHADES) properties.set(`--theme-accent-${shade}`, `var(--theme-derived-accent-${shade})`);
    properties.set('--theme-ribbon-accent', 'var(--theme-accent)');
    properties.set('--theme-ribbon-accent-soft', 'var(--theme-derived-accent-soft)');
  }
  return properties;
}

function syncAccentProperties(root: HTMLElement, properties: Map<string, string>): void {
  for (const name of ACCENT_PROPERTIES) {
    const next = properties.get(name);
    if (next === undefined) {
      if (root.style.getPropertyValue(name)) root.style.removeProperty(name);
    } else if (root.style.getPropertyValue(name).trim() !== next) {
      root.style.setProperty(name, next);
    }
  }
}

const appliedListeners = new Set<(theme: AppliedTheme) => void>();
let current: AppliedTheme | null = null;

/** 테마가 화면에 걸릴 때마다(미리보기 포함) 부른다. 해제 함수를 돌려준다. */
export function onThemeApplied(listener: (theme: AppliedTheme) => void): () => void {
  appliedListeners.add(listener);
  return () => appliedListeners.delete(listener);
}

/**
 * 테마를 저장하지 않고 화면에 건다. 인자가 없으면 저장된 설정을 건다.
 * 설정 화면의 미리보기와 다른 창에서 바뀐 설정 반영이 모두 이 길을 지난다.
 */
export function applyTheme(theme?: ThemeSettings | ThemeMode): EffectiveTheme {
  const settings = toSettings(theme);
  const effective = getEffectiveTheme(settings);
  const root = document.documentElement;
  const next: AppliedTheme = { mode: settings.mode, preset: settings.preset, accent: settings.accent, effective };
  const changed = !current || current.mode !== next.mode || current.preset !== next.preset
    || current.accent !== next.accent || current.effective !== next.effective;
  const colorsChanged = current && (current.effective !== effective || current.preset !== next.preset || current.accent !== next.accent);
  if (colorsChanged || (!current && root.dataset.themeEffective && root.dataset.themeEffective !== effective)) {
    suppressTransitionsForSwitch(root);
  }
  root.dataset.themeMode = settings.mode;
  root.dataset.themeEffective = effective;
  root.dataset.themePreset = settings.preset;
  const accent = accentProperties(settings, effective);
  syncAccentProperties(root, accent);
  // 강조색이 걸렸다는 표시. 체크 상자·라디오와 화면 글자 선택이 이 표시가 있을 때만 강조색을 따른다(base.css).
  root.toggleAttribute('data-theme-accent', accent.has('--theme-accent'));
  syncBrowserColorScheme(root, effective);
  syncThemeColorMeta(root);
  current = next;
  syncThemeMenu(settings.mode, settings.preset);
  if (changed) for (const listener of [...appliedListeners]) listener({ ...next });
  return effective;
}

export function setThemeMode(mode: ThemeMode): EffectiveTheme {
  userSettings.setThemeMode(mode);
  return applyTheme();
}

export function setThemePreset(preset: ThemePresetId): EffectiveTheme {
  userSettings.setThemePreset(preset);
  return applyTheme();
}

/** 강조색을 고른다. null 이면 프리셋 강조색으로 돌아간다. */
export function setThemeAccent(accent: string | null): EffectiveTheme {
  userSettings.setThemeAccent(accent);
  return applyTheme();
}

/**
 * 보기 → 테마 메뉴의 체크 표시. 한 가지 색 구성만 가진 프리셋이면 그 구성에 체크하고
 * 나머지는 끈다(명령 활성 상태는 view.ts 의 canExecute 가 같은 판단을 쓴다).
 */
export function syncThemeMenu(
  mode: ThemeMode = getThemeMode(),
  preset: ThemePresetId = userSettings.getThemeSettings().preset,
): void {
  const locked = getLockedScheme(preset);
  const shown = locked ?? mode;
  for (const item of document.querySelectorAll<HTMLElement>('[data-theme-mode-choice]')) {
    const active = item.dataset.themeModeChoice === shown;
    item.classList.toggle('active', active);
    item.setAttribute('aria-checked', String(active));
  }
}

/**
 * 저장된 테마를 걸고, 시스템 색 구성과 다른 창의 설정 변경을 따라간다.
 * onChange 는 테마가 화면에 걸릴 때마다(미리보기 포함) 불린다.
 */
export function initThemeSync(onChange?: (theme: AppliedTheme) => void): () => void {
  const unsubscribeApplied = onChange ? onThemeApplied(onChange) : () => {};
  current = null;
  applyTheme();

  // 다른 창이 테마를 바꿨을 때만 다시 건다. 글꼴 같은 다른 설정이 바뀔 때마다 걸면 테마 탭의 미리보기가 지워진다.
  let saved = { ...userSettings.getThemeSettings() };
  const unsubscribeSettings = userSettings.subscribe((settings, source) => {
    const previous = saved;
    saved = { ...settings.theme };
    if (source !== 'external') return;
    if (previous.mode === saved.mode && previous.preset === saved.preset && previous.accent === saved.accent) return;
    applyTheme();
  });

  const media = window.matchMedia?.(THEME_QUERY);
  // 미리보기 중이면 미리보기 값을, 아니면 저장된 값을 다시 건다.
  const onMediaChange = () => {
    if ((current?.mode ?? getThemeMode()) === 'system') applyTheme(current ?? undefined);
  };
  let unsubscribeMedia = () => {};
  if (media && typeof media.addEventListener === 'function') {
    media.addEventListener('change', onMediaChange);
    unsubscribeMedia = () => media.removeEventListener('change', onMediaChange);
  } else if (media) {
    media.addListener(onMediaChange);
    unsubscribeMedia = () => media.removeListener(onMediaChange);
  }
  return () => {
    unsubscribeApplied();
    unsubscribeSettings();
    unsubscribeMedia();
  };
}
