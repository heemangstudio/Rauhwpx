import test from 'node:test';
import assert from 'node:assert/strict';
import { planPageDetail } from '../src/view/page-detail.ts';

// A4 at 300% on a dpr-2 screen: the detail layer renders at scale 6.
const a4 = { pageWidth: 794, pageHeight: 1123, zoom: 3, scale: 6 };

test('detail region covers the visible part plus a margin and spans whole CSS pixels', () => {
  const plan = planPageDetail({
    ...a4,
    pageLeft: 100,
    pageTop: 10,
    viewport: { left: 400.25, top: 1500.5, width: 1440, height: 900 },
  });
  assert.ok(plan);
  // Visible CSS span inside the page: x 300.25..1740.25, y 1490.5..2390.5 (device = css × 2).
  assert.deepEqual(plan.visible, { x: 600, y: 2981, width: 2881, height: 1800 });
  // 192 CSS px margin; an odd device size would display at a half CSS pixel and the browser
  // would resample it, so the region spans whole CSS pixels.
  assert.deepEqual(plan.region, { x: 216, y: 2597, width: 3650, height: 2568 });
});

test('detail region stops at the scaled page edge the engine clips to', () => {
  const plan = planPageDetail({
    ...a4,
    pageLeft: 0,
    pageTop: 0,
    viewport: { left: -50, top: 3000, width: 3000, height: 900 },
  });
  assert.ok(plan);
  assert.equal(plan.region.x, 0);
  assert.equal(plan.region.x + plan.region.width, Math.floor(794 * 6));
  assert.equal(plan.region.y + plan.region.height, Math.floor(1123 * 6));
});

test('pages outside the viewport get no detail layer', () => {
  assert.equal(planPageDetail({
    ...a4,
    pageLeft: 0,
    pageTop: 5000,
    viewport: { left: 0, top: 0, width: 1440, height: 900 },
  }), null);
});
