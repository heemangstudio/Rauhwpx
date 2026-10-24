/**
 * 설정 → 테마. 프리셋 타일, 모드(시스템·밝게·어둡게), 강조색을 한 초안으로 고르고
 * 바꿀 때마다 저장 없이 화면에 미리 건다. 적용하면 저장하고, 취소하면 저장된 테마로 되돌린다.
 */
import './settings-theme.css';
import {
  userSettings,
  type ThemeMode,
  type ThemePresetId,
  type ThemeSettings,
} from '../../core/user-settings.ts';
import { applyTheme, getEffectiveTheme, getLockedScheme } from '../../core/theme.ts';
import { THEME_PRESET_LIST, getThemePreset, presetScheme } from '../../core/theme-presets/index.ts';
import { createIcon } from './icons.ts';

const MODES: ReadonlyArray<{ mode: ThemeMode; label: string }> = [
  { mode: 'system', label: '시스템' },
  { mode: 'light', label: '라이트' },
  { mode: 'dark', label: '다크' },
];

const ARROW_STEPS: Readonly<Record<string, number>> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };

/** 밝은 면과 어두운 면 모두에서 읽히는 중간 밝기의 강조색. */
export const ACCENT_SWATCHES: ReadonlyArray<{ color: string; label: string }> = [
  { color: '#3a6fd8', label: '파랑' },
  { color: '#7c5cff', label: '보라' },
  { color: '#d6457a', label: '분홍' },
  { color: '#e5534b', label: '빨강' },
  { color: '#e8761a', label: '주황' },
  { color: '#2f9e5a', label: '초록' },
  { color: '#0e9aa7', label: '청록' },
  { color: '#6e7681', label: '회색' },
];

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(className: string, text?: string): HTMLButtonElement {
  const node = el('button', className, text);
  node.type = 'button';
  return node;
}

function sameTheme(left: ThemeSettings, right: ThemeSettings): boolean {
  return left.mode === right.mode && left.preset === right.preset && left.accent === right.accent;
}

export interface ThemeSettingsController {
  element: HTMLElement;
  open(): void;
  isDirty(): boolean;
  apply(): boolean;
  cancel(): void;
  dispose(): void;
}

export function createThemeSettings(options: {
  onDirtyChange: (dirty: boolean) => void;
}): ThemeSettingsController {
  const { onDirtyChange } = options;
  let baseline: ThemeSettings = { ...userSettings.getThemeSettings() };
  let draft: ThemeSettings = { ...baseline };
  let conflictSnapshot: ThemeSettings | null = null;
  let saving = false;

  const element = el('div', 'ag-settings-destination-content ag-settings-theme-content');
  const conflict = el('div', 'ag-settings-conflict');
  conflict.hidden = true;
  conflict.setAttribute('role', 'status');
  const conflictActions = el('span', 'ag-settings-actions');
  const conflictReload = button('ag-settings-btn', '다시 불러오기');
  const conflictKeep = button('ag-settings-btn', '내 변경 유지');
  conflictActions.append(conflictReload, conflictKeep);
  conflict.append(el('span', 'ag-settings-conflict-copy', '테마가 다른 곳에서 변경됐습니다.'), conflictActions);

  // ── 프리셋 타일 ──
  const presetGroup = el('section', 'ag-settings-group');
  const presetBody = el('div', 'ag-settings-group-body ag-theme-preset-body');
  const presetGrid = el('div', 'ag-theme-presets');
  presetGrid.setAttribute('role', 'radiogroup');
  presetGrid.setAttribute('aria-label', '테마');
  const tiles = new Map<ThemePresetId, { root: HTMLButtonElement; preview: HTMLElement }>();
  for (const preset of THEME_PRESET_LIST) {
    const tile = button('ag-theme-tile');
    tile.dataset.preset = preset.id;
    tile.setAttribute('role', 'radio');
    const preview = el('span', 'ag-theme-tile-preview');
    preview.setAttribute('aria-hidden', 'true');
    const bar = el('span', 'ag-theme-tile-bar');
    bar.append(el('span', 'ag-theme-tile-mark'), el('span', 'ag-theme-tile-line'));
    const desk = el('span', 'ag-theme-tile-desk');
    desk.append(el('span', 'ag-theme-tile-paper'));
    const side = el('span', 'ag-theme-tile-side');
    side.append(el('span', 'ag-theme-tile-line'), el('span', 'ag-theme-tile-line ag-theme-tile-line-short'));
    preview.append(bar, desk, side);
    const check = el('span', 'ag-theme-tile-check');
    check.appendChild(createIcon('check'));
    tile.append(preview, el('span', 'ag-theme-tile-label', preset.label), check);
    tile.addEventListener('click', () => {
      draft = { ...draft, preset: preset.id };
      previewDraft();
    });
    presetGrid.appendChild(tile);
    tiles.set(preset.id, { root: tile, preview });
  }
  // 라디오 묶음처럼 방향키로 고른다. 탭 순서에는 고른 타일 하나만 둔다.
  presetGrid.addEventListener('keydown', (event) => {
    const step = ARROW_STEPS[event.key];
    if (!step) return;
    event.preventDefault();
    const index = THEME_PRESET_LIST.findIndex((preset) => preset.id === draft.preset);
    const next = THEME_PRESET_LIST[(index + step + THEME_PRESET_LIST.length) % THEME_PRESET_LIST.length];
    draft = { ...draft, preset: next.id };
    previewDraft();
    tiles.get(next.id)?.root.focus();
  });
  presetBody.appendChild(presetGrid);
  presetGroup.appendChild(presetBody);

  // ── 모드와 강조색 ──
  const colorGroup = el('section', 'ag-settings-group');
  const colorBody = el('div', 'ag-settings-group-body');

  const modeRow = el('div', 'ag-settings-control-row ag-theme-row');
  const modeCopy = el('span', 'ag-settings-control-copy');
  modeCopy.append(el('span', 'ag-settings-control-label', '모드'));
  const modeChoices = el('div', 'ag-settings-segmented ag-theme-modes');
  modeChoices.setAttribute('role', 'radiogroup');
  modeChoices.setAttribute('aria-label', '모드');
  const modeButtons = new Map<ThemeMode, HTMLButtonElement>();
  for (const { mode, label } of MODES) {
    const choice = button('ag-settings-segment', label);
    choice.dataset.value = mode;
    choice.setAttribute('role', 'radio');
    choice.addEventListener('click', () => {
      draft = { ...draft, mode };
      previewDraft();
    });
    modeChoices.appendChild(choice);
    modeButtons.set(mode, choice);
  }
  modeRow.append(modeCopy, modeChoices);

  const accentRow = el('div', 'ag-settings-control-row ag-theme-row');
  const accentCopy = el('span', 'ag-settings-control-copy');
  accentCopy.append(el('span', 'ag-settings-control-label', '악센트'));
  const accentChoices = el('div', 'ag-theme-accents');
  accentChoices.setAttribute('role', 'radiogroup');
  accentChoices.setAttribute('aria-label', '악센트');
  const presetAccent = button('ag-theme-swatch');
  presetAccent.setAttribute('role', 'radio');
  presetAccent.setAttribute('aria-label', '테마 기본색');
  presetAccent.title = '테마 기본색';
  presetAccent.addEventListener('click', () => {
    draft = { ...draft, accent: null };
    previewDraft();
  });
  accentChoices.appendChild(presetAccent);
  const swatches = new Map<string, HTMLButtonElement>();
  for (const swatch of ACCENT_SWATCHES) {
    const choice = button('ag-theme-swatch');
    choice.setAttribute('role', 'radio');
    choice.setAttribute('aria-label', swatch.label);
    choice.title = swatch.label;
    choice.style.setProperty('--swatch', swatch.color);
    choice.addEventListener('click', () => {
      draft = { ...draft, accent: swatch.color };
      previewDraft();
    });
    accentChoices.appendChild(choice);
    swatches.set(swatch.color, choice);
  }
  accentRow.append(accentCopy, accentChoices);

  colorBody.append(modeRow, accentRow);
  colorGroup.appendChild(colorBody);

  const status = el('p', 'ag-settings-apply-status');
  status.hidden = true;
  status.setAttribute('role', 'status');
  const footer = el('div', 'ag-settings-apply-footer');
  const cancel = button('ag-settings-btn', '취소');
  const apply = button('ag-settings-primary', '적용');
  footer.append(status, cancel, apply);

  element.append(conflict, presetGroup, colorGroup, footer);

  function isDirty(): boolean {
    return !sameTheme(draft, baseline);
  }

  function renderDirty(): void {
    const dirty = isDirty();
    apply.disabled = !dirty;
    cancel.disabled = !dirty;
    onDirtyChange(dirty);
  }

  function render(): void {
    const locked = getLockedScheme(draft.preset);
    const effective = getEffectiveTheme(draft);
    for (const [mode, choice] of modeButtons) {
      const selected = (locked ?? draft.mode) === mode;
      choice.classList.toggle('ag-active', selected);
      choice.setAttribute('aria-checked', String(selected));
      choice.disabled = locked !== null;
    }
    for (const [id, tile] of tiles) {
      const selected = draft.preset === id;
      tile.root.setAttribute('aria-checked', String(selected));
      tile.root.tabIndex = selected ? 0 : -1;
      const preset = getThemePreset(id);
      const colors = presetScheme(preset, getEffectiveTheme({ ...draft, preset: id }));
      tile.preview.style.setProperty('--tile-chrome', colors.chrome);
      tile.preview.style.setProperty('--tile-desk', colors.desk);
      tile.preview.style.setProperty('--tile-sidebar', colors.sidebar);
      tile.preview.style.setProperty('--tile-text', colors.text);
      tile.preview.style.setProperty('--tile-accent', colors.accent);
    }
    const presetColor = presetScheme(getThemePreset(draft.preset), effective).accent;
    presetAccent.style.setProperty('--swatch', presetColor);
    presetAccent.setAttribute('aria-checked', String(draft.accent === null));
    for (const [color, choice] of swatches) choice.setAttribute('aria-checked', String(draft.accent === color));
    renderDirty();
  }

  function previewDraft(): void {
    status.hidden = true;
    applyTheme(draft);
    render();
  }

  function applyDraft(): boolean {
    saving = true;
    const result = userSettings.tryApplyThemeSettings(draft);
    saving = false;
    if (!result.ok) {
      status.textContent = `테마를 저장하지 못했습니다. ${result.error}`;
      status.hidden = false;
      return false;
    }
    baseline = { ...result.value };
    draft = { ...result.value };
    conflictSnapshot = null;
    conflict.hidden = true;
    status.textContent = '테마를 적용했습니다.';
    status.hidden = false;
    applyTheme(baseline);
    render();
    return true;
  }

  function cancelDraft(): void {
    draft = { ...baseline };
    conflictSnapshot = null;
    conflict.hidden = true;
    status.hidden = true;
    applyTheme(baseline);
    render();
  }

  apply.addEventListener('click', applyDraft);
  cancel.addEventListener('click', cancelDraft);
  conflictReload.addEventListener('click', () => {
    if (!conflictSnapshot) return;
    baseline = { ...conflictSnapshot };
    draft = { ...conflictSnapshot };
    conflictSnapshot = null;
    conflict.hidden = true;
    applyTheme(baseline);
    render();
  });
  conflictKeep.addEventListener('click', () => {
    if (!conflictSnapshot) return;
    baseline = { ...conflictSnapshot };
    conflictSnapshot = null;
    conflict.hidden = true;
    applyTheme(draft);
    render();
  });

  // 다른 창이나 보기 메뉴가 테마를 바꾸면 초안이 없을 때는 따라가고, 있으면 묻는다.
  const unsubscribe = userSettings.subscribe(() => {
    if (saving) return;
    const saved = { ...userSettings.getThemeSettings() };
    if (sameTheme(saved, baseline)) return;
    if (isDirty()) {
      conflictSnapshot = saved;
      conflict.hidden = false;
      applyTheme(draft);
      return;
    }
    baseline = { ...saved };
    draft = { ...saved };
    render();
  });

  render();

  return {
    element,
    open(): void {
      if (!isDirty()) {
        baseline = { ...userSettings.getThemeSettings() };
        draft = { ...baseline };
      }
      render();
    },
    isDirty,
    apply: applyDraft,
    cancel: cancelDraft,
    dispose(): void {
      unsubscribe();
      // 적용하지 않은 미리보기를 화면에 남기지 않는다.
      if (isDirty()) applyTheme();
    },
  };
}
