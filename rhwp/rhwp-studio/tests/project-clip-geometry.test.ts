import test from 'node:test';
import assert from 'node:assert/strict';

import {
  adjustClipRect,
  clipThumbKey,
  normalizeClipRect,
  pdfPagePixels,
  pixelBoxToRect,
  rectFromPoints,
  rectToPixelBox,
} from '../src/agent/clip-geometry.ts';
import { planImageCrop } from '../src/agent/image-crop.ts';

test('a normalized rect maps to a source pixel box that covers the whole region', () => {
  // A4 쪽(96dpi 794x1123)의 가운데 절반.
  const page = pdfPagePixels(595.28, 841.89);
  assert.deepEqual(page, { width: 794, height: 1123 });
  const box = rectToPixelBox([0.25, 0.25, 0.5, 0.5], page.width, page.height);
  assert.deepEqual(box, { x: 198, y: 280, width: 398, height: 563 });
  // 다시 비율로 옮기면 원래 영역을 덮는다.
  const back = pixelBoxToRect(box, page.width, page.height);
  assert.ok(back[0] <= 0.25 && back[1] <= 0.25);
  assert.ok(back[0] + back[2] >= 0.75 && back[1] + back[3] >= 0.75);
  // 오른쪽 아래 끝 영역도 원본 밖으로 나가지 않는다.
  assert.deepEqual(rectToPixelBox([0.99, 0.99, 0.01, 0.01], 100, 100), { x: 99, y: 99, width: 1, height: 1 });
});

test('PDF crops for agents stay within the vision pixel cap and print crops keep the region', () => {
  const page = pdfPagePixels(595.28, 841.89);
  // 쪽 전체를 1.15MP 안으로 읽는다 — A4 96dpi 는 그대로 들어간다.
  const full = planImageCrop(page.width, page.height, undefined, 1, 1_150_000);
  assert.equal(full.scale, 1);
  assert.equal(full.outWidth * full.outHeight <= 1_150_000, true);
  // 작은 영역을 4배로 키워도 상한에 걸리면 배율을 낮춘다.
  const box = rectToPixelBox([0.1, 0.1, 0.8, 0.5], page.width, page.height);
  const zoomed = planImageCrop(page.width, page.height, box, 4, 1_150_000);
  assert.ok(zoomed.scale < 4);
  assert.ok(zoomed.outWidth * zoomed.outHeight <= 1_150_000);
  // 인쇄(200dpi) 영역은 16.7MP 안에서 원래 비율을 지킨다.
  const print = planImageCrop(page.width, page.height, box, 200 / 96, 16_777_216);
  assert.equal(print.scale, Math.round((200 / 96) * 1000) / 1000);
  assert.ok(Math.abs(print.outWidth / print.outHeight - box.width / box.height) < 0.01);
});

test('dragging out a rect normalizes direction, clamps to the page, and ignores tiny drags', () => {
  assert.deepEqual(rectFromPoints({ x: 0.8, y: 0.6 }, { x: 0.2, y: 0.1 }), [0.2, 0.1, 0.6, 0.5]);
  assert.deepEqual(rectFromPoints({ x: 0.5, y: 0.5 }, { x: 1.4, y: -0.2 }), [0.5, 0, 0.5, 0.5]);
  assert.equal(rectFromPoints({ x: 0.5, y: 0.5 }, { x: 0.505, y: 0.9 }), null);
  assert.deepEqual(normalizeClipRect([0.123456, 0.5, 0.2, 0.3]), [0.1235, 0.5, 0.2, 0.3]);
  assert.equal(normalizeClipRect([0, 0, Number.NaN, 0.2]), null);
});

test('moving and resizing a clip keeps it on the page with a minimum size', () => {
  const rect: [number, number, number, number] = [0.1, 0.1, 0.3, 0.2];
  // 옮기기는 쪽 밖으로 나가지 않고 크기를 지킨다.
  assert.deepEqual(adjustClipRect(rect, 'move', 0.9, -0.5), [0.7, 0, 0.3, 0.2]);
  // 남동 모서리를 끌면 왼쪽 위는 그대로다.
  assert.deepEqual(adjustClipRect(rect, 'se', 0.1, 0.1), [0.1, 0.1, 0.4, 0.3]);
  // 북서 모서리를 반대편 너머로 끌어도 최소 크기에서 멈춘다.
  assert.deepEqual(adjustClipRect(rect, 'nw', 0.9, 0.9), [0.39, 0.29, 0.01, 0.01]);
});

test('thumbnail cache keys change with the source file, page, region and size only', () => {
  const base = { fileId: 'ref-1', page: 2, rect: [0.1, 0.2, 0.3, 0.4], size: 360 };
  const key = clipThumbKey(base);
  assert.equal(clipThumbKey({ ...base, rect: [0.10001, 0.2, 0.3, 0.4] }), key);
  for (const changed of [
    { ...base, fileId: 'ref-2' },
    { ...base, page: 3 },
    { ...base, rect: [0.1, 0.2, 0.3, 0.41] },
    { ...base, size: 72 },
  ]) {
    assert.notEqual(clipThumbKey(changed), key);
  }
});
