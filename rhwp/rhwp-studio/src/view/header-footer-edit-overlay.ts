import type { PageInfo } from '@/core/types';

export interface HeaderFooterBandBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface HeaderFooterBadgeMetrics {
  fontSizePx: number;
  gapPx: number;
}

const HEADER_FOOTER_BADGE_BASE_FONT_SIZE_PX = 10;
const HEADER_FOOTER_BADGE_BASE_GAP_PX = 4;
const HEADER_FOOTER_BADGE_MAX_SCALE = 2;

/** HF 편집 안내 꺾쇠 — 본문 page-margin-guides 와 같은 시각 계약(HamaEditor 인라인). */
const HF_GUIDE_COLOR = '#C0C0C0';
const HF_GUIDE_LINE_WIDTH = 1;
const HF_GUIDE_MIN_SCREEN_LINE_WIDTH = 0.8;
const HF_GUIDE_MAX_SCREEN_LINE_WIDTH = 1.5;
const HF_GUIDE_LENGTH = 22;

function resolveHeaderFooterGuideLineWidth(displayScale: number): number {
  const safeDisplayScale = Number.isFinite(displayScale) && displayScale > 0
    ? displayScale
    : 1;
  const screenLineWidth = Math.min(
    HF_GUIDE_MAX_SCREEN_LINE_WIDTH,
    Math.max(
      HF_GUIDE_MIN_SCREEN_LINE_WIDTH,
      HF_GUIDE_LINE_WIDTH * safeDisplayScale,
    ),
  );
  return screenLineWidth / safeDisplayScale;
}

/**
 * 머리말/꼬리말 밴드 네 모서리에 한컴형 바깥 꺾쇠를 그린다.
 * HamaEditor 에는 page-margin-guides 모듈이 없으므로 HF 오버레이 전용으로 둔다.
 */
export function drawHeaderFooterGuideCorners(
  rect: HeaderFooterBandBox,
  canvas: HTMLCanvasElement,
  scale: number,
  displayScale = 1,
  originX = 0,
  originY = 0,
): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const left = rect.x;
  const top = rect.y;
  const right = rect.x + rect.width;
  const bottom = rect.y + rect.height;
  const L = HF_GUIDE_LENGTH;

  ctx.save();
  ctx.setTransform(scale, 0, 0, scale, -originX, -originY);
  ctx.strokeStyle = HF_GUIDE_COLOR;
  ctx.lineWidth = resolveHeaderFooterGuideLineWidth(displayScale);
  ctx.beginPath();

  ctx.moveTo(left, top - L);
  ctx.lineTo(left, top);
  ctx.lineTo(left - L, top);

  ctx.moveTo(right + L, top);
  ctx.lineTo(right, top);
  ctx.lineTo(right, top - L);

  ctx.moveTo(left - L, bottom);
  ctx.lineTo(left, bottom);
  ctx.lineTo(left, bottom + L);

  ctx.moveTo(right, bottom + L);
  ctx.lineTo(right, bottom);
  ctx.lineTo(right + L, bottom);

  ctx.stroke();
  ctx.restore();
}

/**
 * 안내 꺾쇠 canvas 를 쪽 전체가 아니라 꺾쇠가 닿는 밴드 둘레만 덮게 만든다. 쪽 전체 canvas 와
 * 같은 장치 픽셀 격자(정수 offset)에 놓아 꺾쇠 픽셀은 같고, 편집 중 쪽 크기 비트맵을 두지 않는다.
 * `dpr` 은 renderScale / zoom (CSS px 당 장치 픽셀).
 */
export function createHeaderFooterGuideCanvas(
  page: Pick<PageInfo, 'width' | 'height'>,
  band: HeaderFooterBandBox,
  renderScale: number,
  dpr: number,
  zoom: number,
): HTMLCanvasElement {
  const pageWidth = Math.max(1, Math.round(page.width * renderScale));
  const pageHeight = Math.max(1, Math.round(page.height * renderScale));
  // 선 두께 절반과 안티앨리어싱 여유.
  const pad = Math.ceil((resolveHeaderFooterGuideLineWidth(zoom) * renderScale) / 2) + 2;
  const clampX = (value: number) => Math.min(pageWidth, Math.max(0, value));
  const clampY = (value: number) => Math.min(pageHeight, Math.max(0, value));
  const left = clampX(Math.floor((band.x - HF_GUIDE_LENGTH) * renderScale) - pad);
  const top = clampY(Math.floor((band.y - HF_GUIDE_LENGTH) * renderScale) - pad);
  const right = clampX(Math.ceil((band.x + band.width + HF_GUIDE_LENGTH) * renderScale) + pad);
  const bottom = clampY(Math.ceil((band.y + band.height + HF_GUIDE_LENGTH) * renderScale) + pad);

  const canvas = document.createElement('canvas');
  canvas.className = 'hf-edit-guide-canvas';
  canvas.width = Math.max(1, right - left);
  canvas.height = Math.max(1, bottom - top);
  canvas.style.left = `${left / dpr}px`;
  canvas.style.top = `${top / dpr}px`;
  canvas.style.width = `${canvas.width / dpr}px`;
  canvas.style.height = `${canvas.height / dpr}px`;
  drawHeaderFooterGuideCorners(band, canvas, renderScale, zoom, left, top);
  return canvas;
}

/**
 * HF 안내 라벨은 화면 UI이므로 문서와 똑같이 확대하지 않는다.
 * 100% 이하는 읽을 수 있는 최소 크기를 유지하고, 고배율에서는 제곱근만큼
 * 완만하게 키우되 2배에서 멈춰 문서 내용을 가리지 않게 한다.
 */
export function resolveHeaderFooterBadgeMetrics(zoom: number): HeaderFooterBadgeMetrics {
  const safeZoom = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  const scale = Math.min(
    HEADER_FOOTER_BADGE_MAX_SCALE,
    Math.max(1, Math.sqrt(safeZoom)),
  );
  return {
    fontSizePx: HEADER_FOOTER_BADGE_BASE_FONT_SIZE_PX * scale,
    gapPx: HEADER_FOOTER_BADGE_BASE_GAP_PX * scale,
  };
}

/**
 * 렌더러의 HF hit-test와 같은 영역을 쓴다.
 *
 * 새 WASM은 PageAreas의 결과를 직접 내보내고, 구 WASM에서만 PageDef
 * 여백으로 동일한 공식을 재구성한다.
 */
export function resolveHeaderFooterBandBox(
  page: PageInfo,
  isHeader: boolean,
): HeaderFooterBandBox {
  const exact = isHeader ? page.headerArea : page.footerArea;
  if (exact) return exact;

  // 구 WASM / HamaEditor: bodyLeft·bodyRight 가 없으면 PageDef 여백으로 재구성한다.
  const x = page.bodyLeft ?? page.marginLeft;
  const right = page.bodyRight ?? (page.width - page.marginRight);
  const width = Math.max(0, right - x);
  if (isHeader) {
    return {
      x,
      y: page.marginTop,
      width,
      height: Math.max(0, page.marginHeader),
    };
  }
  return {
    x,
    y: Math.max(0, page.height - page.marginFooter - page.marginBottom),
    width,
    height: Math.max(0, page.marginBottom),
  };
}

export function headerFooterClipPath(
  page: PageInfo,
  band: HeaderFooterBandBox,
  zoom: number,
): string {
  const top = Math.max(0, band.y * zoom);
  const right = Math.max(0, (page.width - band.x - band.width) * zoom);
  const bottom = Math.max(0, (page.height - band.y - band.height) * zoom);
  const left = Math.max(0, band.x * zoom);
  return `inset(${top}px ${right}px ${bottom}px ${left}px)`;
}
