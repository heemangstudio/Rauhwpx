/* 장치 픽셀 맞춤. 보기(용지 배치)와 사이드바 모션이 함께 쓴다. */

/** 장치 픽셀 비율을 믿을 수 있는 범위(0.5–8)로 묶는다. 잘못된 값은 1 이다. */
export function sanitizeDpr(dpr: number | undefined): number {
  if (dpr === undefined || !(dpr > 0) || !Number.isFinite(dpr)) return 1;
  return Math.min(8, Math.max(0.5, dpr));
}

/** CSS px 값을 가장 가까운 장치 픽셀 경계로 맞춘다. */
export function snapToDevicePixel(value: number, dpr?: number): number {
  if (!Number.isFinite(value)) return 0;
  const ratio = sanitizeDpr(dpr);
  const snapped = Math.round(value * ratio) / ratio;
  // -0 을 남기지 않는다.
  return snapped === 0 ? 0 : snapped;
}

/** 반 장치 픽셀(CSS px). 이보다 작은 움직임은 화면에 보이지 않는다. */
export function halfDevicePixel(dpr?: number): number {
  return 0.5 / sanitizeDpr(dpr);
}
