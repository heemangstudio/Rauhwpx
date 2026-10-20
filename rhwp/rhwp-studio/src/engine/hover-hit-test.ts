/**
 * hover 한 프레임 안에서 하이퍼링크 판정과 표 경계선 판정이 같은 점을 묻는다.
 * 그 프레임 동안만 결과를 기억해 wasm hitTest 를 한 번만 부른다(빽빽한 쪽에서 한 번에 0.5~1 ms).
 */
export function runHoverFrame(self: any, frame: () => void): void {
  self.hoverFrameHits = new Map<string, unknown>();
  try {
    frame();
  } finally {
    self.hoverFrameHits = null;
  }
}

/** hover 프레임 밖에서는 그대로 hitTest 를 부른다. 실패는 기억하지 않는다. */
export function hoverHitTest(self: any, page: number, x: number, y: number): any {
  const hits = self.hoverFrameHits as Map<string, unknown> | null | undefined;
  if (!hits) return self.wasm.hitTest(page, x, y);
  const key = `${page}|${x}|${y}`;
  if (hits.has(key)) return hits.get(key);
  const hit = self.wasm.hitTest(page, x, y);
  hits.set(key, hit);
  return hit;
}
