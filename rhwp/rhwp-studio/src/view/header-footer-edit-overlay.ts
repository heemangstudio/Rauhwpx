import type { CanvasDeviceRect, PageInfo } from '@/core/types';
import { wholeCssPixelStep } from './render-backend.ts';

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

/** HF 편집 안내 꺾쇠 — 본문 page-margin-guides 와 같은 시각 계약(Rauhwpx 인라인). */
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

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * 머리말/꼬리말 밴드 네 모서리에 한컴형 바깥 꺾쇠를 그린다. 쪽 크기 canvas 대신 벡터로
 * 그려 확대 배율과 무관하게 비트맵 메모리를 쓰지 않는다.
 * Rauhwpx 에는 page-margin-guides 모듈이 없으므로 HF 오버레이 전용으로 둔다.
 */
export function createHeaderFooterGuideCorners(
  rect: HeaderFooterBandBox,
  page: Pick<PageInfo, 'width' | 'height'>,
  zoom: number,
): SVGSVGElement {
  const left = rect.x;
  const top = rect.y;
  const right = rect.x + rect.width;
  const bottom = rect.y + rect.height;
  const L = HF_GUIDE_LENGTH;

  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'hf-edit-guide');
  svg.setAttribute('viewBox', `0 0 ${page.width} ${page.height}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.style.width = `${page.width * zoom}px`;
  svg.style.height = `${page.height * zoom}px`;
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', [
    `M${left} ${top - L}V${top}H${left - L}`,
    `M${right + L} ${top}H${right}V${top - L}`,
    `M${left - L} ${bottom}H${left}V${bottom + L}`,
    `M${right} ${bottom + L}V${bottom}H${right + L}`,
  ].join(''));
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', HF_GUIDE_COLOR);
  path.setAttribute('stroke-width', String(resolveHeaderFooterGuideLineWidth(zoom)));
  svg.appendChild(path);
  return svg;
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

  // 구 WASM / Rauhwpx: bodyLeft·bodyRight 가 없으면 PageDef 여백으로 재구성한다.
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

/**
 * 대표 preview canvas 가 덮을 밴드 영역. 장치 픽셀 영역은 밴드를 바깥쪽으로 반올림하고 크기를
 * CSS px 정수로 맞춘 것이고, clip-path 는 그 canvas 상자 기준으로 밴드 밖을 잘라 낸다.
 */
export function headerFooterPreviewRegion(
  band: HeaderFooterBandBox,
  zoom: number,
  scale: number,
): { region: CanvasDeviceRect; clipPath: string } {
  const cssPerDevice = zoom / scale;
  const step = wholeCssPixelStep(cssPerDevice);
  const x = Math.floor(band.x * scale);
  const y = Math.floor(band.y * scale);
  const extent = (start: number, end: number) =>
    Math.max(step, Math.ceil((Math.ceil(end * scale) - start) / step) * step);
  const region = {
    x,
    y,
    width: extent(x, band.x + band.width),
    height: extent(y, band.y + band.height),
  };
  const inset = [
    band.y * zoom - region.y * cssPerDevice,
    (region.x + region.width) * cssPerDevice - (band.x + band.width) * zoom,
    (region.y + region.height) * cssPerDevice - (band.y + band.height) * zoom,
    band.x * zoom - region.x * cssPerDevice,
  ].map((value) => `${Math.max(0, value)}px`);
  return { region, clipPath: `inset(${inset.join(' ')})` };
}
