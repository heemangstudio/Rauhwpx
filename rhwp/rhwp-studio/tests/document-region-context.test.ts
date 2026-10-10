import test from 'node:test';
import assert from 'node:assert/strict';
import { planDocumentRegion, documentCaptureSize } from '../src/agent/document-region-context.ts';

test('drag clipping maps zoomed pages into document coordinates and excludes chrome', () => {
  const result = planDocumentRegion({ x: 700, y: 800 }, { x: 0, y: 0 }, { x: 100, y: 80, width: 500, height: 650 }, [
    { pageIndex: 3, pageWidth: 800, pageHeight: 1000, rect: { x: 150, y: 100, width: 400, height: 500 } },
    { pageIndex: 4, pageWidth: 800, pageHeight: 1000, rect: { x: 150, y: 620, width: 400, height: 500 } },
  ]);
  assert.deepEqual(result?.rect, { x: 150, y: 100, width: 400, height: 630 });
  assert.deepEqual(result?.parts.map((part) => part.pageRegion), [
    { pageIndex: 3, pageWidth: 800, pageHeight: 1000, x: 0, y: 0, width: 800, height: 1000 },
    { pageIndex: 4, pageWidth: 800, pageHeight: 1000, x: 0, y: 0, width: 800, height: 220 },
  ]);
});
test('a drag over page gaps or invalid geometry produces no capture', () => {
  const page = { pageIndex: 0, pageWidth: 100, pageHeight: 100, rect: { x: 30, y: 30, width: 50, height: 50 } };
  assert.equal(planDocumentRegion({ x: 0, y: 0 }, { x: 20, y: 20 }, { x: 0, y: 0, width: 100, height: 100 }, [page]), null);
  assert.equal(planDocumentRegion({ x: NaN, y: 0 }, { x: 50, y: 50 }, page.rect, [page]), null);
});
test('capture dimensions honor DPR and bound wide, tall and large-page memory', () => {
  assert.deepEqual(documentCaptureSize({ x: 0, y: 0, width: 100, height: 50 }, 2), { width: 200, height: 100, scale: 2 });
  for (const [width, height] of [[100_000, 100], [100, 100_000], [10_000, 10_000]]) {
    const size = documentCaptureSize({ x: 0, y: 0, width, height }, 4);
    assert.ok(size.width <= 8192 && size.height <= 8192 && size.width * size.height <= 16_000_000);
  }
  assert.equal(documentCaptureSize({ x: 0, y: 0, width: 100, height: 100 }, NaN).scale, 1);
});
