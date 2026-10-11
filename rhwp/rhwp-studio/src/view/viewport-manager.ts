import type { EventBus } from '@/core/event-bus';
import {
  CENTER_ZOOM_ANCHOR,
  normalizeZoomAnchor,
  type ZoomAnchor,
} from './zoom-anchor.ts';

export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 5.0;
const ZOOM_SETTLE_EPSILON = 0.001;
const ZOOM_SMOOTHING_TIME_MS = 16;
const WHEEL_ZOOM_SENSITIVITY = 0.00625;
const MAX_WHEEL_DELTA_PX = 120;

export class ViewportManager {
  private scrollY = 0;
  private scrollX = 0;
  private viewportWidth = 0;
  private viewportHeight = 0;
  private zoom = 1.0;
  private container: HTMLElement | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private scrollAnimationFrame: number | null = null;
  private zoomAnimationFrame: number | null = null;
  private zoomAnimationTimestamp: number | null = null;
  private zoomAnimating = false;
  private zoomTarget = 1.0;
  private zoomAnchor: ZoomAnchor = CENTER_ZOOM_ANCHOR;
  private onScrollBound: () => void;
  private onWheelBound: (e: WheelEvent) => void;
  private onZoomAnimationFrameBound: (timestamp: number) => void;
  private eventBus: EventBus;

  constructor(eventBus: EventBus) {
    this.eventBus = eventBus;
    this.onScrollBound = this.onScroll.bind(this);
    this.onWheelBound = this.onWheel.bind(this);
    this.onZoomAnimationFrameBound = this.onZoomAnimationFrame.bind(this);
  }

  /** 스크롤 컨테이너에 연결한다 */
  attachTo(container: HTMLElement): void {
    this.detach();
    this.container = container;
    container.addEventListener('scroll', this.onScrollBound, { passive: true });
    container.addEventListener('wheel', this.onWheelBound, { passive: false });

    this.resizeObserver = new ResizeObserver(() => {
      this.updateViewportSize();
      this.eventBus.emit('viewport-resize', this.viewportWidth, this.viewportHeight);
    });
    this.resizeObserver.observe(container);
    this.updateViewportSize();
  }

  /** 연결을 해제한다 */
  detach(): void {
    if (this.container) {
      this.container.removeEventListener('scroll', this.onScrollBound);
      this.container.removeEventListener('wheel', this.onWheelBound);
    }
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    if (this.scrollAnimationFrame !== null) {
      cancelAnimationFrame(this.scrollAnimationFrame);
      this.scrollAnimationFrame = null;
    }
    this.cancelZoomAnimation();
    this.container = null;
  }

  private onScroll(): void {
    if (!this.container) return;
    this.scrollY = this.container.scrollTop;
    this.scrollX = this.container.scrollLeft;
    if (this.scrollAnimationFrame !== null) return;

    // 스크롤 중에는 최신 좌표만 다음 프레임에 반영해 렌더가 입력 이벤트를 막지 않게 한다.
    this.scrollAnimationFrame = requestAnimationFrame(() => {
      this.scrollAnimationFrame = null;
      this.eventBus.emit('viewport-scroll', this.scrollY, this.scrollX);
    });
  }

  /** Ctrl+휠: 브라우저 줌 대신 문서 줌. 일반 휠은 두 축을 함께 이동한다. */
  private onWheel(e: WheelEvent): void {
    const deltaX = this.wheelDeltaPixels(e.deltaX, e.deltaMode);
    const deltaY = this.wheelDeltaPixels(e.deltaY, e.deltaMode);

    if (!e.ctrlKey && !e.metaKey) {
      // 확대된 문서는 트랙패드의 두 축을 함께 반영해 대각선으로 이동한다.
      if (this.container && !e.shiftKey && this.isHorizontallyScrollable()) {
        e.preventDefault();
        if (deltaY !== 0) this.setScrollTop(this.container.scrollTop + deltaY);
        if (deltaX !== 0) this.setScrollLeft(this.container.scrollLeft + deltaX);
      }
      return;
    }
    e.preventDefault();

    const boundedDelta = Math.max(
      -MAX_WHEEL_DELTA_PX,
      Math.min(MAX_WHEEL_DELTA_PX, deltaY),
    );
    if (boundedDelta === 0) return;

    const rect = this.container?.getBoundingClientRect();
    const anchor = rect && rect.width > 0 && rect.height > 0
      ? normalizeZoomAnchor({
        x: (e.clientX - rect.left) / rect.width,
        y: (e.clientY - rect.top) / rect.height,
      })
      : CENTER_ZOOM_ANCHOR;

    this.smoothZoomTo(
      this.zoomTarget * Math.exp(-boundedDelta * WHEEL_ZOOM_SENSITIVITY),
      anchor,
    );
  }

  /** 확대로 용지가 뷰포트보다 넓어져 가로 스크롤이 생긴 상태인가 */
  private isHorizontallyScrollable(): boolean {
    const container = this.container;
    return !!container && container.scrollWidth > container.clientWidth + 1;
  }

  private wheelDeltaPixels(delta: number, deltaMode: number): number {
    return deltaMode === 1
      ? delta * 16
      : deltaMode === 2
        ? delta * Math.max(this.viewportHeight, 1)
        : delta;
  }

  private updateViewportSize(): void {
    if (!this.container) return;
    this.viewportWidth = this.container.clientWidth;
    this.viewportHeight = this.container.clientHeight;
  }

  /** ResizeObserver 없이도 컨테이너 client size 를 다시 읽는다. */
  syncViewportSize(): void {
    this.updateViewportSize();
  }

  /**
   * 문서가 짧아진 직후 스크롤 좌표를 새 내용 끝 안으로 당긴다.
   *
   * 옛 쪽 canvas 는 absolute 로 아직 DOM 에 남아 스크롤 영역을 붙잡고 있어, 브라우저는 그것을
   * 치우기 전까지 scrollTop 을 당기지 않는다. 캐시 좌표로 쪽 창을 계산하면 문서 끝 너머를 보고
   * 모든 쪽을 해제해, 늦게 오는 scroll 이벤트 전까지 화면이 빈다.
   */
  clampScrollToContent(contentWidth: number, contentHeight: number): void {
    if (!this.container) return;
    // ResizeObserver 캐시는 한 프레임 늦을 수 있다(사이드바 폭 변화 등). 캐시 폭이 실제보다
    // 크면 끝에 붙은 스크롤을 잘못 당기므로 client 크기를 직접 읽는다 (캐시는 observer 몫).
    const maxTop = Math.max(0, contentHeight - this.container.clientHeight);
    const maxLeft = Math.max(0, contentWidth - this.container.clientWidth);
    if (this.container.scrollTop > maxTop) this.setScrollTop(maxTop);
    else this.scrollY = this.container.scrollTop;
    if (this.container.scrollLeft > maxLeft) this.setScrollLeft(maxLeft);
    else this.scrollX = this.container.scrollLeft;
  }

  getScrollY(): number {
    return this.scrollY;
  }

  getScrollX(): number {
    return this.scrollX;
  }

  getViewportSize(): { width: number; height: number } {
    return { width: this.viewportWidth, height: this.viewportHeight };
  }

  getZoom(): number {
    return this.zoom;
  }

  setZoom(zoom: number, anchor: ZoomAnchor = CENTER_ZOOM_ANCHOR): void {
    this.cancelZoomAnimation();
    this.zoomAnchor = normalizeZoomAnchor(anchor);
    this.zoom = this.clampZoom(zoom);
    this.zoomTarget = this.zoom;
    this.eventBus.emit('zoom-changed', this.zoom, this.zoomAnchor);
  }

  smoothZoomBy(delta: number, anchor: ZoomAnchor = CENTER_ZOOM_ANCHOR): void {
    this.smoothZoomTo(this.zoomTarget + delta, anchor);
  }

  smoothZoomTo(zoom: number, anchor: ZoomAnchor = CENTER_ZOOM_ANCHOR): void {
    this.zoomAnchor = normalizeZoomAnchor(anchor);
    this.zoomTarget = this.clampZoom(zoom);
    if (Math.abs(this.zoomTarget - this.zoom) <= ZOOM_SETTLE_EPSILON) {
      this.setZoom(this.zoomTarget, this.zoomAnchor);
      return;
    }
    this.zoomAnimating = true;
    if (this.zoomAnimationFrame === null) {
      this.zoomAnimationFrame = requestAnimationFrame(this.onZoomAnimationFrameBound);
    }
  }

  isZoomAnimating(): boolean {
    return this.zoomAnimating;
  }

  private onZoomAnimationFrame(timestamp: number): void {
    this.zoomAnimationFrame = null;
    const elapsed = this.zoomAnimationTimestamp === null
      ? 16
      : Math.max(1, Math.min(timestamp - this.zoomAnimationTimestamp, 50));
    this.zoomAnimationTimestamp = timestamp;

    const progress = 1 - Math.exp(-elapsed / ZOOM_SMOOTHING_TIME_MS);
    const nextZoom = this.zoom + (this.zoomTarget - this.zoom) * progress;
    const settled = Math.abs(this.zoomTarget - nextZoom) <= ZOOM_SETTLE_EPSILON;
    this.zoom = settled ? this.zoomTarget : nextZoom;
    if (settled) {
      this.zoomAnimating = false;
      this.zoomAnimationTimestamp = null;
    }
    this.eventBus.emit('zoom-changed', this.zoom, this.zoomAnchor);

    if (!settled) {
      this.zoomAnimationFrame = requestAnimationFrame(this.onZoomAnimationFrameBound);
    }
  }

  private cancelZoomAnimation(): void {
    if (this.zoomAnimationFrame !== null) {
      cancelAnimationFrame(this.zoomAnimationFrame);
      this.zoomAnimationFrame = null;
    }
    this.zoomAnimationTimestamp = null;
    this.zoomAnimating = false;
    this.zoomTarget = this.zoom;
  }

  private clampZoom(zoom: number): number {
    return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom));
  }

  setScrollTop(y: number): void {
    if (this.container) {
      this.container.scrollTop = y;
      this.scrollY = this.container.scrollTop;
    }
  }

  setScrollLeft(x: number): void {
    if (this.container) {
      this.container.scrollLeft = x;
      this.scrollX = this.container.scrollLeft;
    }
  }
}
