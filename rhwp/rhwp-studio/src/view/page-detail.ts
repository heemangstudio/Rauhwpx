import type { CanvasDeviceRect } from '@/core/types';
import { MAX_CANVAS_DIMENSION, wholeCssPixelStep } from './render-backend.ts';

// 고배율 page-detail 층 (PDF.js detail view 방식).
//
// 쪽 canvas 와 그 위아래 층은 MAX_RENDER_PIXELS 상한 배율로 그려 CSS 로 늘어난다. 요청 배율이
// 상한을 넘으면 화면에 보이는 쪽 영역(+여백)만 원래 배율로, 모든 층을 합친 모습('all')으로 한
// canvas 에 다시 그려 쪽 층 위에 덮는다. 선택·캐럿·조합 중 글자·검토 표시 같은 편집 표시는
// 이 층보다 위(z-index 4 이상)에 있고, 층은 pointer-events 를 받지 않는다.

/** 화면 밖으로 미리 그려 두는 폭 (CSS px). 이 안에서 스크롤하면 다시 그리지 않는다. */
const PAGE_DETAIL_MARGIN_CSS_PX = 192;

export interface PageDetailPlan {
  /** 영역 렌더 배율 (장치 픽셀 / 문서 px) */
  scale: number;
  zoom: number;
  /** 그릴 영역 — 보이는 영역에 여백을 더해 쪽 안으로 자른 것 */
  region: CanvasDeviceRect;
  /** 지금 화면에 보이는 영역 */
  visible: CanvasDeviceRect;
}

export interface PageDetailGeometry {
  /** 쪽 크기 (문서 px) */
  pageWidth: number;
  pageHeight: number;
  /** 쪽 왼쪽 위 (스크롤 내용 좌표, CSS px) */
  pageLeft: number;
  pageTop: number;
  zoom: number;
  scale: number;
  /** 화면 (스크롤 내용 좌표, CSS px) */
  viewport: { left: number; top: number; width: number; height: number };
}

/**
 * 쪽과 화면이 겹치는 영역을 detail 배율의 장치 픽셀로 바꾼다. 쪽 범위는 엔진
 * clip_canvas_region 과 같이 배율 적용 쪽 크기를 버린 값이다. 겹치지 않으면 null.
 */
export function planPageDetail(geometry: PageDetailGeometry): PageDetailPlan | null {
  const { pageWidth, pageHeight, pageLeft, pageTop, zoom, scale, viewport } = geometry;
  if (!(zoom > 0) || !(scale > 0) || !(pageWidth > 0) || !(pageHeight > 0)) return null;
  const left = Math.max(0, viewport.left - pageLeft);
  const right = Math.min(pageWidth * zoom, viewport.left + viewport.width - pageLeft);
  const top = Math.max(0, viewport.top - pageTop);
  const bottom = Math.min(pageHeight * zoom, viewport.top + viewport.height - pageTop);
  if (!(right > left) || !(bottom > top)) return null;

  const devicePerCss = scale / zoom;
  const limitX = Math.max(1, Math.floor(pageWidth * scale));
  const limitY = Math.max(1, Math.floor(pageHeight * scale));
  const span = (start: number, end: number, limit: number, step: number): [number, number] => {
    let lo = Math.min(limit, Math.max(0, Math.floor(start * devicePerCss)));
    const hi = Math.min(limit, Math.max(lo, Math.ceil(end * devicePerCss)));
    let size = Math.min(
      Math.ceil((hi - lo) / step) * step,
      Math.floor(MAX_CANVAS_DIMENSION / step) * step,
    );
    if (lo + size > limit) lo = Math.max(0, limit - size);
    size = Math.min(size, limit - lo);
    return [lo, size];
  };
  const rect = (x0: number, x1: number, y0: number, y1: number, step = 1): CanvasDeviceRect => {
    const [x, width] = span(x0, x1, limitX, step);
    const [y, height] = span(y0, y1, limitY, step);
    return { x, y, width, height };
  };
  const visible = rect(left, right, top, bottom);
  // canvas 표시 크기가 CSS px 정수가 아니면 브라우저가 비트맵을 다시 샘플링해 흐려진다.
  const margin = PAGE_DETAIL_MARGIN_CSS_PX;
  const region = rect(
    left - margin,
    right + margin,
    top - margin,
    bottom + margin,
    wholeCssPixelStep(zoom / scale),
  );
  if (region.width < 1 || region.height < 1) return null;
  return { scale, zoom, region, visible };
}

function containsRect(outer: CanvasDeviceRect, inner: CanvasDeviceRect): boolean {
  return inner.x >= outer.x
    && inner.y >= outer.y
    && inner.x + inner.width <= outer.x + outer.width
    && inner.y + inner.height <= outer.y + outer.height;
}

interface PageDetailEntry {
  layer: HTMLDivElement;
  canvas: HTMLCanvasElement;
  plan: PageDetailPlan;
}

/** 쪽마다 detail canvas 하나를 두고 쪽 canvas 와 같은 상자에 놓는다. */
export class PageDetailLayers {
  private entries = new Map<number, PageDetailEntry>();
  private readonly host: HTMLElement;

  constructor(host: HTMLElement) {
    this.host = host;
  }

  get pages(): number[] {
    return Array.from(this.entries.keys());
  }

  has(pageIdx: number): boolean {
    return this.entries.has(pageIdx);
  }

  /** 같은 배율로 지금 보이는 영역을 이미 덮고 있는가. */
  covers(pageIdx: number, plan: PageDetailPlan): boolean {
    const current = this.entries.get(pageIdx)?.plan;
    return !!current
      && current.scale === plan.scale
      && current.zoom === plan.zoom
      && containsRect(current.region, plan.visible);
  }

  /**
   * `draw` 로 detail canvas 를 그린 뒤 `pageCanvas` 와 같은 상자에 놓는다. `draw` 가 던지면
   * 층을 지우고 그대로 던진다 — 그리다 만 canvas 가 쪽을 덮지 않게 한다.
   */
  show(
    pageIdx: number,
    plan: PageDetailPlan,
    pageCanvas: HTMLCanvasElement,
    draw: (canvas: HTMLCanvasElement) => void,
  ): void {
    const entry = this.entries.get(pageIdx) ?? this.create(pageIdx, plan);
    // 같은 z-index 인 글 앞 개체 층은 쪽을 다시 그릴 때마다 맨 뒤로 다시 붙는다. 그 위에 오도록
    // detail 층도 맨 뒤로 옮긴다. 문서에 붙은 canvas 는 문서 lang 으로 글꼴을 고르므로 그리기
    // 전에 붙여 쪽 canvas 와 같은 글리프를 쓴다.
    if (entry.layer !== this.host.lastElementChild) this.host.appendChild(entry.layer);
    try {
      draw(entry.canvas);
    } catch (error) {
      this.remove(pageIdx);
      throw error;
    }
    entry.plan = plan;

    const { layer, canvas } = entry;
    layer.style.top = pageCanvas.style.top;
    layer.style.left = pageCanvas.style.left;
    layer.style.transform = pageCanvas.style.transform;
    layer.style.transformOrigin = pageCanvas.style.transformOrigin;
    layer.style.width = pageCanvas.style.width;
    layer.style.height = pageCanvas.style.height;
    const cssPerDevice = plan.zoom / plan.scale;
    canvas.style.left = `${plan.region.x * cssPerDevice}px`;
    canvas.style.top = `${plan.region.y * cssPerDevice}px`;
    canvas.style.width = `${canvas.width * cssPerDevice}px`;
    canvas.style.height = `${canvas.height * cssPerDevice}px`;
  }

  remove(pageIdx: number): void {
    const entry = this.entries.get(pageIdx);
    if (!entry) return;
    this.entries.delete(pageIdx);
    entry.canvas.width = 0;
    entry.canvas.height = 0;
    entry.layer.remove();
  }

  removeAll(): void {
    for (const pageIdx of this.pages) this.remove(pageIdx);
  }

  private create(pageIdx: number, plan: PageDetailPlan): PageDetailEntry {
    const layer = document.createElement('div');
    layer.className = 'page-detail-layer';
    layer.dataset.rhwpDetailPage = String(pageIdx);
    layer.setAttribute('aria-hidden', 'true');
    const canvas = document.createElement('canvas');
    layer.appendChild(canvas);
    const entry = { layer, canvas, plan };
    this.entries.set(pageIdx, entry);
    return entry;
  }
}
