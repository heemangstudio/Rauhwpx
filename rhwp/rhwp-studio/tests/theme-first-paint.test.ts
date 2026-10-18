import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

import { THEME_PRESET_LIST, lockedScheme } from '../src/core/theme-presets/index.ts';

const source = readFileSync(new URL('../public/theme-init.js', import.meta.url), 'utf8');

/** 번들보다 먼저 도는 public/theme-init.js 를 저장된 테마 하나로 돌려 html 에 건 값을 돌려준다. */
function firstPaint(theme: unknown, prefersDark: boolean): Record<string, string> {
  const root = { dataset: {} as Record<string, string>, style: {} as Record<string, string> };
  vm.runInNewContext(source, {
    document: { documentElement: root, querySelector: () => null },
    localStorage: { getItem: () => JSON.stringify({ version: 2, theme }) },
    window: { matchMedia: () => ({ matches: prefersDark }) },
  });
  return root.dataset;
}

test('첫 화면은 모든 프리셋에서 앱이 걸 색 구성으로 칠해진다', () => {
  for (const preset of THEME_PRESET_LIST) {
    for (const mode of ['system', 'light', 'dark'] as const) {
      for (const prefersDark of [false, true]) {
        const expected = lockedScheme(preset) ?? (mode === 'system' ? (prefersDark ? 'dark' : 'light') : mode);
        const painted = firstPaint({ mode, preset: preset.id }, prefersDark);
        assert.equal(painted.themePreset, preset.id);
        assert.equal(painted.themeEffective, expected, `${preset.id} · ${mode} · 시스템 ${prefersDark ? '어둡게' : '밝게'}`);
      }
    }
  }
  assert.equal(firstPaint({ mode: 'dark', preset: 'solarized' }, false).themePreset, 'default');
});
