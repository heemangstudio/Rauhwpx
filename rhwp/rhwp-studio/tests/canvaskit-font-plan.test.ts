import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveCanvasKitFontPlan } from '../src/core/font-loader.ts';

test('CanvasKit font plan groups document aliases that share one bundled face', () => {
  const plan = resolveCanvasKitFontPlan(['HY그래픽', 'Noto Sans KR']);

  assert.deepEqual(plan.unavailableFonts, []);
  assert.equal(plan.sources.length, 1);
  assert.equal(plan.sources[0].url, 'fonts/NotoSansKR-Regular.woff2');
  assert.ok(plan.sources[0].aliases.includes('HY그래픽'));
  assert.ok(plan.sources[0].aliases.includes('Noto Sans KR'));
});

test('CanvasKit font plan fails closed for unavailable surface fonts', () => {
  const offline = resolveCanvasKitFontPlan(
    ['함초롬바탕', 'Times New Roman'],
    { disableExternalWebFonts: true },
  );
  assert.deepEqual(offline.sources, []);
  assert.deepEqual(offline.unavailableFonts, ['함초롬바탕', 'Times New Roman']);
});
