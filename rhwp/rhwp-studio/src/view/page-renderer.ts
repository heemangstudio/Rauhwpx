import type { WasmBridge } from '@/core/wasm-bridge';
import type { CanvasDeviceRect, LayerRenderProfile, PageInfo } from '@/core/types';
import { inheritedReplayLayer, layerPaintOpReplayPlane } from './canvaskit/replay-plane';
import type { CanvasKitLayerRenderer, CanvasKitRenderDiagnostics } from './canvaskit-renderer';
import {
  collectFlowImagePaintOps,
  isDomDisplayableFlowImage,
  planFlowImageClip,
  type FlowImagePaintOp,
} from './flow-image-clip';
import type { RenderBackend } from './render-backend';
// 브라우저 테스트가 이 모듈을 alias 없는 Vite 로 읽으므로 상대 경로로 가져온다.
import { engineTrap, reportEngineTrap } from '../core/engine-trap.ts';

interface LayerPlaneSummary {
  hasBehind: boolean;
  hasFront: boolean;
  imageCount: number;
  rawSvgCount: number;  // OLE/차트 rawSvg op 수 (image 와 의미 분리, #1456)
  flowImageCount: number;
  flowRawSvgCount: number;
  flowStaticCount: number;
  /**
   * 본문 그림을 flow canvas 아래 정적 layer 로 분리해도 그리기 순서가 유지되는지.
   * 그림보다 먼저 그려지는 채우기·글자가 그림과 겹치면 분리 합성이 그림을 가리므로 false.
   */
  flowStaticSplitSafe: boolean;
  signature: string;
}

export interface PageRenderContext {
  reason?: 'text-edit' | 'unknown';
  allowStaticOverlayReuse?: boolean;
}

export interface PageRenderResult {
  needsTextEditStaticLayerVerification: boolean;
  renderedCanvas?: HTMLCanvasElement;
}

type OverlayLayerKind = 'background' | 'behind' | 'front';
type StaticCanvasLayerKind = OverlayLayerKind | 'flow-static';

interface ReRenderPolicy {
  reuseStaticFlow: boolean;
  reuseStaticOverlay: boolean;
}

interface LayerSummaryCacheEntry {
  key: string;
  summary: LayerPlaneSummary;
}

/** 엔진이 그림 디코드를 기다리며 그린 쪽. 디코드가 끝나면 이 상태로 다시 그린다. */
interface PictureRepaintJob {
  canvas: HTMLCanvasElement;
  renderScale: number;
  policy: ReRenderPolicy;
  fallbackTimer: ReturnType<typeof setTimeout> | null;
}

interface AppliedOverlays {
  layers: LayerPlaneSummary;
  /** 본문 그림을 DOM `<img>` 층으로 실제로 띄웠는가 (flow canvas 에는 그림이 없다). */
  domFlowImages: boolean;
}

/** 엔진 디코드 알림을 놓쳐도 이 시간 뒤 한 번은 다시 그린다. */
const IMAGE_RE_RENDER_FALLBACK_DELAY_MS = 1500;
/** 디코드가 이어지는 동안에도 끝난 그림을 이 간격으로 보여 준다. */
const PICTURE_PROGRESS_REPAINT_MS = 120;
const HWP_UNITS_PER_CSS_PIXEL = 75;

export class PageRenderer {
  private pictureJobs = new Map<number, PictureRepaintJob>();
  private stopPictureListener: (() => void) | null = null;
  private pictureFlushFrame: number | null = null;
  private pictureProgressTimer: ReturnType<typeof setTimeout> | null = null;
  /** 지금 그리는 쪽에서 엔진이 디코드를 기다리는 그림 수 */
  private renderPendingPictures = 0;
  /** detail 영역을 그릴 때 디코드를 기다리던 그림이 있는 쪽 */
  private detailPicturePages = new Set<number>();
  private layerSummaryCache = new Map<number, LayerSummaryCacheEntry>();
  private canvaskitDiagnosticsByPage = new Map<number, CanvasKitRenderDiagnostics>();
  private pageInfoByPage = new Map<number, PageInfo>();
  private flowSplitSupported: boolean | null = null;
  private pageRepaintListener: ((pageIdx: number) => void) | null = null;

  constructor(
    private wasm: WasmBridge,
    private backend: RenderBackend = 'canvas2d',
    private renderProfile: LayerRenderProfile = 'screen',
    private canvaskitRenderer: CanvasKitLayerRenderer | null = null,
  ) {}

  configure(
    backend: RenderBackend,
    renderProfile: LayerRenderProfile,
    canvaskitRenderer: CanvasKitLayerRenderer | null,
    preserveCanvasKitDiagnostics = false,
  ): boolean {
    const changed =
      this.backend !== backend
      || this.renderProfile !== renderProfile
      || this.canvaskitRenderer !== canvaskitRenderer;
    if (!changed) return false;

    this.cancelAll();
    if (!preserveCanvasKitDiagnostics) this.releaseAllPageDiagnostics();
    this.layerSummaryCache.clear();
    this.pageInfoByPage.clear();
    this.backend = backend;
    this.renderProfile = renderProfile;
    this.canvaskitRenderer = canvaskitRenderer;
    return true;
  }

  invalidateDocumentRevision(): void {
    this.cancelAll();
    this.releaseAllPageDiagnostics();
    this.layerSummaryCache.clear();
    this.pageInfoByPage.clear();
  }

  /** 페이지를 Canvas에 렌더링한다 (renderScale = zoom × DPR) */
  renderPage(
    pageIdx: number,
    canvas: HTMLCanvasElement,
    renderScale: number,
    _displayScale: number,
    dpr: number,
    context: PageRenderContext = {},
    pageInfo?: PageInfo,
  ): PageRenderResult {
    if (pageInfo) this.pageInfoByPage.set(pageIdx, pageInfo);
    if (this.backend === 'canvaskit') {
      this.layerSummaryCache.delete(pageIdx);
      const renderedCanvas = this.renderPageCanvasKit(pageIdx, canvas, renderScale);
      return { needsTextEditStaticLayerVerification: false, renderedCanvas };
    }

    this.renderPendingPictures = 0;
    const layers = this.getLayerPlaneSummary(pageIdx, canvas, renderScale, context);
    const preferStaticFlow = this.shouldSplitStaticFlow(layers);
    let reuseStaticFlow = this.renderFlowCanvas(pageIdx, canvas, renderScale, preferStaticFlow);
    const flowImages = reuseStaticFlow && layers.flowImageCount > 0
      ? this.getFlowImagePaintOps(pageIdx)
      : [];
    const usesDomFlowImages =
      reuseStaticFlow &&
      layers.flowRawSvgCount === 0 &&
      flowImages.length === layers.flowImageCount &&
      flowImages.length > 0;

    // 다층 layer 모드.
    // 1) 본문 Canvas 는 'flow' 필터로 BehindText/InFrontOfText plane 제외
    // 2) behind/front plane 은 같은 부모 컨테이너에 별도 canvas layer 로 합성
    this.drawMarginGuides(pageIdx, canvas, renderScale);
    let overlays: AppliedOverlays;
    try {
      overlays = this.applyOverlays(
        pageIdx,
        canvas,
        renderScale,
        dpr,
        context,
        layers,
        reuseStaticFlow,
        usesDomFlowImages ? flowImages : [],
      );
    } catch (error) {
      if (!reuseStaticFlow) throw error;
      this.flowSplitSupported = false;
      canvas.parentElement && this.removeOverlayLayer(canvas.parentElement, pageIdx, 'flow-static');
      reuseStaticFlow = false;
      this.renderPendingPictures = 0;
      this.renderLayer(pageIdx, canvas, renderScale, 'flow');
      this.drawMarginGuides(pageIdx, canvas, renderScale);
      overlays = this.applyOverlays(pageIdx, canvas, renderScale, dpr, context, layers, false, []);
    }
    this.rememberLayerPlaneSummary(pageIdx, canvas, renderScale, layers);
    this.scheduleReRender(pageIdx, canvas, renderScale, this.renderPendingPictures, {
      reuseStaticFlow,
      reuseStaticOverlay: context.reason === 'text-edit' && context.allowStaticOverlayReuse === true,
    });
    return {
      needsTextEditStaticLayerVerification:
        context.reason === 'text-edit' &&
        context.allowStaticOverlayReuse === true &&
        ((reuseStaticFlow && !overlays.domFlowImages) || layers.hasBehind || layers.hasFront),
    };
  }

  getBackend(): RenderBackend {
    return this.backend;
  }

  /** 지연 그림 재렌더가 쪽 canvas 를 다시 그린 뒤 알린다. page-detail 층이 따라 그린다. */
  setPageRepaintListener(listener: ((pageIdx: number) => void) | null): void {
    this.pageRepaintListener = listener;
  }

  /**
   * 쪽의 모든 층을 합친 모습을 일부 영역만 그린다 (Canvas2D, 편집 여백 표시 포함). 디코드를
   * 기다리는 그림이 있으면 디코드가 끝날 때 쪽 다시 그리기 알림으로 detail 층을 다시 그리게 한다.
   */
  renderPageRegion(
    pageIdx: number,
    canvas: HTMLCanvasElement,
    scale: number,
    region: CanvasDeviceRect,
  ): void {
    const pending = this.wasm.renderPageRegionToCanvas(
      pageIdx, canvas, scale, region, 'all', this.renderProfile,
    );
    this.drawMarginGuides(pageIdx, canvas, scale, region.x, region.y);
    if (pending > 0) {
      this.detailPicturePages.add(pageIdx);
      this.listenForPictures();
    } else {
      this.detailPicturePages.delete(pageIdx);
    }
  }

  getCanvasKitRenderDiagnostics(pageIdx: number): CanvasKitRenderDiagnostics | null {
    const diagnostics = this.canvaskitDiagnosticsByPage.get(pageIdx);
    if (!diagnostics) return null;
    return {
      ...diagnostics,
      lastUnsupportedOps: [...diagnostics.lastUnsupportedOps],
      lastExpectedUnsupportedOps: [...diagnostics.lastExpectedUnsupportedOps],
      lastUnexpectedUnsupportedOps: [...diagnostics.lastUnexpectedUnsupportedOps],
      readinessBlockers: [...diagnostics.readinessBlockers],
    };
  }

  /** DEV baseline용 renderer-global counter의 최신 snapshot을 반환한다. */
  getCurrentCanvasKitRenderDiagnostics(): CanvasKitRenderDiagnostics | null {
    if (!this.canvaskitRenderer) return null;
    const diagnostics = this.canvaskitRenderer.diagnostics();
    return {
      ...diagnostics,
      lastUnsupportedOps: [...diagnostics.lastUnsupportedOps],
      lastExpectedUnsupportedOps: [...diagnostics.lastExpectedUnsupportedOps],
      lastUnexpectedUnsupportedOps: [...diagnostics.lastUnexpectedUnsupportedOps],
      readinessBlockers: [...diagnostics.readinessBlockers],
    };
  }

  releasePageDiagnostics(pageIdx: number): void {
    this.canvaskitDiagnosticsByPage.delete(pageIdx);
    this.pageInfoByPage.delete(pageIdx);
  }

  releaseAllPageDiagnostics(): void {
    this.canvaskitDiagnosticsByPage.clear();
    this.pageInfoByPage.clear();
  }

  private renderPageCanvasKit(
    pageIdx: number,
    canvas: HTMLCanvasElement,
    renderScale: number,
  ): HTMLCanvasElement {
    this.canvaskitDiagnosticsByPage.delete(pageIdx);
    if (!this.canvaskitRenderer) {
      throw new Error('CanvasKit renderer가 초기화되지 않았습니다');
    }

    const parent = canvas.parentElement;
    const canvasChildIndex = parent
      ? Array.prototype.indexOf.call(parent.children, canvas)
      : -1;
    if (parent) {
      this.removePageLayers(parent, pageIdx);
    }

    let renderStarted = false;
    try {
      const pageInfo = this.pageInfoByPage.get(pageIdx) ?? this.wasm.getPageInfo(pageIdx);
      canvas.width = Math.max(1, Math.floor(pageInfo.width * renderScale));
      canvas.height = Math.max(1, Math.floor(pageInfo.height * renderScale));
      const tree = this.wasm.getPageLayerTreeObject(pageIdx, this.renderProfile);
      renderStarted = true;
      const renderedCanvas = this.canvaskitRenderer.renderPage(tree, canvas, renderScale, pageInfo);
      this.canvaskitDiagnosticsByPage.set(pageIdx, this.canvaskitRenderer.diagnostics());
      this.cancelReRender(pageIdx);
      return renderedCanvas;
    } catch (error) {
      this.canvaskitRenderer.recordRenderFailure(error, !renderStarted);
      this.canvaskitDiagnosticsByPage.set(pageIdx, this.canvaskitRenderer.diagnostics());
      console.error(`[PageRenderer] CanvasKit 페이지 렌더링 실패 (page=${pageIdx}):`, error);
      this.cancelReRender(pageIdx);
      if (!renderStarted) throw error;
      const replacement = parent && canvasChildIndex >= 0
        ? parent.children.item(canvasChildIndex)
        : null;
      if (canvas.parentElement !== parent && replacement instanceof HTMLCanvasElement) {
        return replacement;
      }
      return canvas;
    }
  }

  /**
   * Canvas 의 부모 컨테이너에 BehindText / InFrontOfText plane canvas 를 추가.
   *
   * - BehindText: flow Canvas 뒤
   * - InFrontOfText: flow Canvas 앞
   * - image/table/shape PaintOp 를 같은 PageLayerTree layer metadata 로 분류
   * - pointer-events: none — hit-test 는 flow Canvas 가 받음
   */
  private applyOverlays(
    pageIdx: number,
    canvas: HTMLCanvasElement,
    renderScale: number,
    dpr: number,
    context: PageRenderContext,
    layers: LayerPlaneSummary,
    reuseStaticFlow: boolean,
    flowImages: readonly FlowImagePaintOp[],
  ): AppliedOverlays {
    const parent = canvas.parentElement;
    if (!parent) return { layers: emptyLayerPlaneSummary(), domFlowImages: false };

    const allowReuse =
      context.reason === 'text-edit' && context.allowStaticOverlayReuse === true;

    if (!allowReuse) {
      // 페이지 단위 overlay 컨테이너를 Canvas 의 sibling 으로 관리.
      // data-rhwp-overlay-page 속성으로 식별, 페이지 재렌더링 시 갱신.
      this.removePageLayers(parent, pageIdx);
    }

    const safeDpr = dpr > 0 && Number.isFinite(dpr) ? dpr : 1;
    const cssWidth = canvas.width / safeDpr;
    const cssHeight = canvas.height / safeDpr;
    const top = canvas.style.top;
    const left = canvas.style.left;
    const transform = canvas.style.transform;

    let domFlowImages = false;
    if (reuseStaticFlow) {
      const flowImageLayer = flowImages.length > 0
        ? this.createOrReuseFlowImageLayer(
          pageIdx,
          canvas,
          renderScale / safeDpr,
          layers,
          allowReuse,
          flowImages,
        )
        : null;
      if (flowImageLayer) {
        domFlowImages = true;
        this.removeOverlayLayer(parent, pageIdx, 'flow-static');
        this.applyPageLayerBox(flowImageLayer, top, left, transform, cssWidth, cssHeight);
        flowImageLayer.style.zIndex = '0';
        parent.insertBefore(flowImageLayer, canvas);
      } else {
        this.removeFlowImageLayer(parent, pageIdx);
        // RawSvg 차트/OLE, 그리고 브라우저 `<img>` 가 못 그리는 그림(WMF, 한도 초과 raster)은
        // 엔진 flow-static canvas 로 그린다. 첫 Canvas2D 렌더가 디코드를 걸고, 끝나면 다시 그린다.
        const flowStatic = this.createOrReuseFilteredCanvasLayer(
          pageIdx,
          canvas,
          renderScale,
          'flow-static',
          layers,
          allowReuse,
        );
        this.applyPageLayerBox(flowStatic, top, left, transform, cssWidth, cssHeight);
        flowStatic.style.zIndex = '0';
        flowStatic.style.background = 'var(--doc-paper)';
        parent.insertBefore(flowStatic, canvas);
      }
      canvas.style.background = 'transparent';
      canvas.style.zIndex = layers.hasFront ? '1' : '1';
    } else {
      this.removeOverlayLayer(parent, pageIdx, 'flow-static');
      this.removeFlowImageLayer(parent, pageIdx);
    }

    if (!layers.hasBehind && !layers.hasFront) {
      if (reuseStaticFlow) return { layers, domFlowImages };
      this.removePageLayers(parent, pageIdx);
      canvas.style.background = '';
      canvas.style.zIndex = '';
      return { layers, domFlowImages };
    }

    // BehindText 가 있는 페이지는 flow Canvas 를 투명 배경으로 두고,
    // 실제 pageBackground layer → BehindText → flow Canvas 순서로 합성한다.
    // Canvas 내부의 흰 배경은 WASM flow 렌더에서 생략된다.
    if (layers.hasBehind) {
      canvas.style.background = 'transparent';
      canvas.style.zIndex = '2';

      const background = this.createOrReuseFilteredCanvasLayer(
        pageIdx,
        canvas,
        renderScale,
        'background',
        layers,
        allowReuse,
      );
      this.applyPageLayerBox(background, top, left, transform, cssWidth, cssHeight);
      background.style.zIndex = '0';
      parent.insertBefore(background, canvas);
    } else {
      this.removeOverlayLayer(parent, pageIdx, 'background');
      this.removeOverlayLayer(parent, pageIdx, 'behind');
      canvas.style.background = reuseStaticFlow ? 'transparent' : '';
      canvas.style.zIndex = layers.hasFront || reuseStaticFlow ? '1' : '';
    }

    // BehindText overlay (Canvas 뒤). 이미지뿐 아니라 표/도형 PaintOp도 포함한다.
    if (layers.hasBehind) {
      const layer = this.createOrReuseFilteredCanvasLayer(
        pageIdx,
        canvas,
        renderScale,
        'behind',
        layers,
        allowReuse,
      );
      this.applyPageLayerBox(layer, top, left, transform, cssWidth, cssHeight);
      layer.style.zIndex = '1';
      // Canvas 보다 먼저 들어가도록 prepend
      parent.insertBefore(layer, canvas);
    }

    // InFrontOfText overlay (Canvas 앞). 이미지뿐 아니라 글상자/도형 PaintOp도 포함한다.
    if (layers.hasFront) {
      const layer = this.createOrReuseFilteredCanvasLayer(
        pageIdx,
        canvas,
        renderScale,
        'front',
        layers,
        allowReuse,
      );
      this.applyPageLayerBox(layer, top, left, transform, cssWidth, cssHeight);
      layer.style.zIndex = layers.hasBehind ? '3' : '2';  // Canvas 보다 앞
      parent.appendChild(layer);
    } else {
      this.removeOverlayLayer(parent, pageIdx, 'front');
    }
    return { layers, domFlowImages };
  }

  private createOrReuseFlowImageLayer(
    pageIdx: number,
    sourceCanvas: HTMLCanvasElement,
    displayScale: number,
    summary: LayerPlaneSummary,
    allowReuse: boolean,
    images: readonly FlowImagePaintOp[],
  ): HTMLElement | null {
    const key = this.buildStaticOverlayKey(pageIdx, sourceCanvas, displayScale, 'flow-static', summary);
    const existing = this.findFlowImageLayer(sourceCanvas.parentElement, pageIdx);
    if (allowReuse && existing?.dataset.rhwpStaticOverlayKey === key) return existing;

    existing?.remove();
    // flow canvas 는 이미 본문 그림을 뺀 채 그려졌다. `<img>` 가 못 그리는 그림이 하나라도
    // 있으면 이 층을 만들지 않고, 호출자가 엔진 flow-static canvas 로 쪽 전체를 그리게 한다.
    // 헤더 검사는 층을 새로 만들 때만 한다 — 같은 key 로 재사용한 층은 이미 통과했다.
    if (!images.every(isDomDisplayableFlowImage)) return null;
    const layer = document.createElement('div');
    layer.dataset.rhwpOverlay = `flow-images-${pageIdx}`;
    layer.dataset.rhwpOverlayPage = String(pageIdx);
    layer.dataset.rhwpFlowImagePage = String(pageIdx);
    layer.dataset.rhwpStaticOverlayKey = key;
    layer.style.pointerEvents = 'none';
    layer.style.background = 'var(--doc-paper)';

    for (const image of images) {
      // clip이 실제 그림보다 작을 때만 별도 wrapper를 둔다. 일반 그림은 기존 DOM
      // 경로를 그대로 사용해 정적 이미지 분리의 비용 이점을 유지한다.
      // 회전한 그림은 미회전 bbox 가 아니라 회전 후 AABB 로 판단한다 — bbox 로 자르면
      // 회전으로 밀려난 모서리가 잘려 canvas/PDF 경로와 결과가 갈라진다.
      const plan = planFlowImageClip(image);
      if (!plan) continue;
      const hostBbox = plan.host;
      const needsClipWrapper = plan.needsWrapper;
      const clipHost = needsClipWrapper ? document.createElement('div') : layer;
      if (needsClipWrapper) {
        clipHost.style.position = 'absolute';
        clipHost.style.left = `${hostBbox.x * displayScale}px`;
        clipHost.style.top = `${hostBbox.y * displayScale}px`;
        clipHost.style.width = `${hostBbox.width * displayScale}px`;
        clipHost.style.height = `${hostBbox.height * displayScale}px`;
        clipHost.style.overflow = 'hidden';
        clipHost.style.pointerEvents = 'none';
      }

      const frame = document.createElement('div');
      frame.style.position = 'absolute';
      frame.style.left = `${(image.bbox.x - (needsClipWrapper ? hostBbox.x : 0)) * displayScale}px`;
      frame.style.top = `${(image.bbox.y - (needsClipWrapper ? hostBbox.y : 0)) * displayScale}px`;
      frame.style.width = `${image.bbox.width * displayScale}px`;
      frame.style.height = `${image.bbox.height * displayScale}px`;
      frame.style.overflow = 'hidden';
      frame.style.pointerEvents = 'none';
      const scaleX = image.horzFlip ? -1 : 1;
      const scaleY = image.vertFlip ? -1 : 1;
      frame.style.transform = `rotate(${image.rotation}deg) scale(${scaleX}, ${scaleY})`;
      frame.style.transformOrigin = 'center';

      const element = new Image();
      element.alt = '';
      element.src = `data:${image.mime};base64,${image.base64}`;
      element.style.position = 'absolute';
      element.style.pointerEvents = 'none';
      // 그림 효과(회색조/흑백/밝기/명암) — WASM canvas 경로(render_image)와 달리
      // DOM flow-image 경로는 필터가 누락돼 원본 컬러로 렌더되던 문제를 고친다.
      if (image.filter) element.style.filter = image.filter;
      const applyCrop = () => applyFlowImageCrop(element, image, displayScale);
      element.addEventListener('load', applyCrop, { once: true });
      applyCrop();
      frame.appendChild(element);
      clipHost.appendChild(frame);
      if (needsClipWrapper) layer.appendChild(clipHost);
    }
    return layer;
  }

  private createOrReuseFilteredCanvasLayer(
    pageIdx: number,
    sourceCanvas: HTMLCanvasElement,
    renderScale: number,
    layerKind: StaticCanvasLayerKind,
    summary: LayerPlaneSummary,
    allowReuse: boolean,
    renderImmediately = true,
  ): HTMLCanvasElement {
    const key = this.buildStaticOverlayKey(pageIdx, sourceCanvas, renderScale, layerKind, summary);
    const reusableLayer = this.findOverlayLayer(sourceCanvas.parentElement, pageIdx, layerKind);
    if (
      allowReuse &&
      reusableLayer?.dataset.rhwpStaticOverlayKey === key &&
      reusableLayer.width === sourceCanvas.width &&
      reusableLayer.height === sourceCanvas.height
    ) {
      return reusableLayer;
    }

    if (reusableLayer) discardPageLayer(reusableLayer);
    const layer = this.createFilteredCanvasLayer(
      pageIdx,
      sourceCanvas,
      renderScale,
      layerKind,
      renderImmediately,
    );
    layer.dataset.rhwpOverlay = `${layerKind}-${pageIdx}`;
    layer.dataset.rhwpOverlayPage = String(pageIdx);
    layer.dataset.rhwpStaticOverlayKey = key;
    return layer;
  }

  private createFilteredCanvasLayer(
    pageIdx: number,
    sourceCanvas: HTMLCanvasElement,
    renderScale: number,
    layerKind: StaticCanvasLayerKind,
    renderImmediately = true,
  ): HTMLCanvasElement {
    const layer = document.createElement('canvas');
    layer.width = sourceCanvas.width;
    layer.height = sourceCanvas.height;
    layer.dataset.rhwpLayerKind = layerKind;
    layer.style.pointerEvents = 'none';
    // Overlay canvas elements inherit #scroll-content canvas background unless
    // this is explicit. A front layer with an opaque page background hides all
    // lower background/behind layers.
    layer.style.background = 'transparent';
    if (renderImmediately) this.renderLayer(pageIdx, layer, renderScale, layerKind);
    return layer;
  }

  private applyPageLayerBox(
    layer: HTMLElement,
    top: string,
    left: string,
    transform: string,
    cssWidth: number,
    cssHeight: number,
  ): void {
    layer.style.position = 'absolute';
    layer.style.top = top;
    layer.style.left = left;
    layer.style.transform = transform;
    layer.style.width = `${cssWidth}px`;
    layer.style.height = `${cssHeight}px`;
    layer.style.overflow = 'hidden';
    layer.style.pointerEvents = 'none';
  }

  removePageLayers(parent: HTMLElement, pageIdx: number): void {
    this.layerSummaryCache.delete(pageIdx);
    parent.querySelectorAll(
      `[data-rhwp-overlay-page="${pageIdx}"],` +
      `[data-rhwp-overlay="background-${pageIdx}"],` +
      `[data-rhwp-overlay="behind-${pageIdx}"],` +
      `[data-rhwp-overlay="front-${pageIdx}"]`,
    ).forEach(discardPageLayer);
  }

  private findOverlayLayer(
    parent: HTMLElement | null,
    pageIdx: number,
    layerKind: StaticCanvasLayerKind,
  ): HTMLCanvasElement | null {
    return parent?.querySelector<HTMLCanvasElement>(
      `[data-rhwp-overlay-page="${pageIdx}"][data-rhwp-layer-kind="${layerKind}"]`,
    ) ?? null;
  }

  private removeOverlayLayer(parent: HTMLElement, pageIdx: number, layerKind: StaticCanvasLayerKind): void {
    const layer = this.findOverlayLayer(parent, pageIdx, layerKind);
    if (layer) discardPageLayer(layer);
  }

  private findFlowImageLayer(parent: HTMLElement | null, pageIdx: number): HTMLElement | null {
    return parent?.querySelector<HTMLElement>(`[data-rhwp-flow-image-page="${pageIdx}"]`) ?? null;
  }

  private removeFlowImageLayer(parent: HTMLElement, pageIdx: number): void {
    this.findFlowImageLayer(parent, pageIdx)?.remove();
  }

  private buildStaticOverlayKey(
    pageIdx: number,
    sourceCanvas: HTMLCanvasElement,
    renderScale: number,
    layerKind: StaticCanvasLayerKind,
    summary: LayerPlaneSummary,
  ): string {
    return [
      `page=${pageIdx}`,
      `scale=${renderScale}`,
      `width=${sourceCanvas.width}`,
      `height=${sourceCanvas.height}`,
      `layer=${layerKind}`,
      `profile=${this.renderProfile}`,
      `backend=${this.backend}`,
      `summary=${summary.signature}`,
    ].join('|');
  }

  removeAllPageLayers(parent: HTMLElement): void {
    this.layerSummaryCache.clear();
    parent.querySelectorAll(
      '[data-rhwp-overlay-page],' +
      '[data-rhwp-overlay^="background-"],' +
      '[data-rhwp-overlay^="behind-"],' +
      '[data-rhwp-overlay^="front-"]',
    ).forEach(discardPageLayer);
  }

  /**
   * 페이지를 본문 layer (flow) 만 Canvas 에 렌더링한다 (Task #516, Stage 5.2).
   * BehindText / InFrontOfText plane 은 제외 — overlay canvas 로 별도 표시.
   */
  renderPageFlow(
    pageIdx: number,
    canvas: HTMLCanvasElement,
    scale: number,
    pageInfo?: PageInfo,
  ): void {
    if (pageInfo) this.pageInfoByPage.set(pageIdx, pageInfo);
    this.renderPendingPictures = 0;
    this.renderLayer(pageIdx, canvas, scale, 'flow');
    this.drawMarginGuides(pageIdx, canvas, scale);
    this.scheduleReRender(pageIdx, canvas, scale, this.renderPendingPictures, {
      reuseStaticFlow: false,
      reuseStaticOverlay: true,
    });
  }

  private shouldSplitStaticFlow(layers: LayerPlaneSummary): boolean {
    return (
      !layers.hasBehind &&
      layers.flowStaticCount > 0 &&
      layers.flowStaticSplitSafe &&
      this.flowSplitSupported !== false
    );
  }

  private getFlowImagePaintOps(pageIdx: number): FlowImagePaintOp[] {
    let json: string;
    try {
      json = this.wasm.getPageLayerTree(pageIdx);
    } catch {
      return [];
    }
    try {
      const root = JSON.parse(json)?.root;
      return collectFlowImagePaintOps(
        root,
        (op, layer) => op.type === 'image' && layerReplayPlane(op, layer) === 'flow',
      );
    } catch {
      return [];
    }
  }

  private renderFlowCanvas(
    pageIdx: number,
    canvas: HTMLCanvasElement,
    renderScale: number,
    preferStaticFlow: boolean,
  ): boolean {
    if (!preferStaticFlow) {
      this.renderLayer(pageIdx, canvas, renderScale, 'flow');
      return false;
    }
    try {
      this.renderLayer(pageIdx, canvas, renderScale, 'flow-dynamic');
      this.flowSplitSupported = true;
      return true;
    } catch (error) {
      this.flowSplitSupported = false;
      console.warn('[PageRenderer] flow-dynamic 렌더 미지원, 기존 flow 렌더로 fallback:', error);
      this.renderLayer(pageIdx, canvas, renderScale, 'flow');
      return false;
    }
  }

  private getLayerPlaneSummary(
    pageIdx: number,
    canvas: HTMLCanvasElement,
    renderScale: number,
    context: PageRenderContext,
  ): LayerPlaneSummary {
    const cacheKey = this.buildLayerSummaryCacheKey(pageIdx, canvas, renderScale);
    if (context.reason === 'text-edit' && context.allowStaticOverlayReuse === true) {
      const cached = this.layerSummaryCache.get(pageIdx);
      if (cached?.key === cacheKey) return { ...cached.summary };
    }

    const overlaySummary = this.getLayerPlaneSummaryFromOverlayImages(pageIdx);
    if (overlaySummary) {
      this.layerSummaryCache.set(pageIdx, { key: cacheKey, summary: overlaySummary });
      return overlaySummary;
    }
    const treeSummary = this.getLayerPlaneSummaryFromTree(pageIdx);
    this.layerSummaryCache.set(pageIdx, { key: cacheKey, summary: treeSummary });
    return treeSummary;
  }

  private rememberLayerPlaneSummary(
    pageIdx: number,
    canvas: HTMLCanvasElement,
    renderScale: number,
    summary: LayerPlaneSummary,
  ): void {
    this.layerSummaryCache.set(pageIdx, {
      key: this.buildLayerSummaryCacheKey(pageIdx, canvas, renderScale),
      summary: { ...summary },
    });
  }

  private buildLayerSummaryCacheKey(
    pageIdx: number,
    canvas: HTMLCanvasElement,
    renderScale: number,
  ): string {
    return [
      `page=${pageIdx}`,
      `scale=${renderScale}`,
      `width=${canvas.width}`,
      `height=${canvas.height}`,
      `profile=${this.renderProfile}`,
      `backend=${this.backend}`,
    ].join('|');
  }

  private getLayerPlaneSummaryFromOverlayImages(pageIdx: number): LayerPlaneSummary | null {
    let json: string;
    try {
      json = this.wasm.getPageOverlayImages(pageIdx);
    } catch {
      return null;
    }
    if (!json || json.trim()[0] !== '{') return null;
    try {
      const wrapper = JSON.parse(json);
      if (typeof wrapper?.hasBehind !== 'boolean' || typeof wrapper?.hasFront !== 'boolean') {
        return null;
      }
      const behind = Array.isArray(wrapper.behind) ? wrapper.behind : [];
      const front = Array.isArray(wrapper.front) ? wrapper.front : [];
      const imageCount = finiteCount(wrapper.imageCount);
      const rawSvgCount = finiteCount(wrapper.rawSvgCount);
      const flowImageCount =
        wrapper.flowImageCount === undefined
          ? Math.max(0, imageCount - behind.length - front.length)
          : finiteCount(wrapper.flowImageCount);
      const flowRawSvgCount =
        wrapper.flowRawSvgCount === undefined
          ? rawSvgCount
          : finiteCount(wrapper.flowRawSvgCount);
      const flowStaticCount = flowImageCount + flowRawSvgCount;
      // 판정 필드가 없는 엔진은 순서 보존을 확인할 수 없으므로 분리하지 않는다.
      const flowStaticSplitSafe = wrapper.flowStaticSplitSafe === true;
      return {
        hasBehind: wrapper.hasBehind,
        hasFront: wrapper.hasFront,
        imageCount,
        rawSvgCount,
        flowImageCount,
        flowRawSvgCount,
        flowStaticCount,
        flowStaticSplitSafe,
        signature: `overlay:${wrapper.hasBehind ? 1 : 0}:${wrapper.hasFront ? 1 : 0}:${imageCount}:${rawSvgCount}:${flowImageCount}:${flowRawSvgCount}:${flowStaticSplitSafe ? 1 : 0}:${json.length}`,
      };
    } catch (e) {
      console.warn('[PageRenderer] OverlayImageSummary JSON parse 실패:', e);
      return null;
    }
  }

  private getLayerPlaneSummaryFromTree(pageIdx: number): LayerPlaneSummary {
    const summary: LayerPlaneSummary = emptyLayerPlaneSummary();
    let json: string;
    try {
      json = this.wasm.getPageLayerTree(pageIdx);
    } catch (e) {
      console.warn('[PageRenderer] PageLayerTree JSON 조회 실패:', e);
      return summary;
    }
    try {
      const wrapper = JSON.parse(json);
      const root = wrapper?.root;
      if (root) {
        collectLayerPlaneSummary(root, summary, null);
        summary.flowStaticCount = summary.flowImageCount + summary.flowRawSvgCount;
        summary.signature = `tree:${summary.hasBehind ? 1 : 0}:${summary.hasFront ? 1 : 0}:${summary.imageCount}:${summary.rawSvgCount}:${summary.flowImageCount}:${summary.flowRawSvgCount}`;
      }
    } catch (e) {
      console.warn('[PageRenderer] PageLayerTree JSON parse 실패:', e);
    }
    return summary;
  }

  /**
   * 편집 용지 여백 가이드라인을 캔버스에 그린다 (4모서리 L자 표시). `originX`·`originY` 는
   * 쪽 일부 영역 canvas 의 원점(배율 적용 쪽 좌표의 장치 픽셀)이다.
   */
  private drawMarginGuides(
    pageIdx: number,
    canvas: HTMLCanvasElement,
    scale: number,
    originX = 0,
    originY = 0,
  ): void {
    const pageInfo = this.pageInfoByPage.get(pageIdx) ?? this.wasm.getPageInfo(pageIdx);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const { width, height, marginLeft, marginRight, marginTop, marginBottom, marginHeader, marginFooter } = pageInfo;
    const left = marginLeft;
    // 한컴 HWP 기준: 본문 시작 = marginHeader + marginTop
    const top = marginHeader + marginTop;
    const right = width - marginRight;
    // 한컴 HWP 기준: 본문 끝 = height - marginFooter - marginBottom
    const bottom = height - marginFooter - marginBottom;
    const L = 15;

    ctx.save();
    // WASM 렌더링 후 ctx transform 상태가 불확실하므로 명시적으로 설정
    ctx.setTransform(scale, 0, 0, scale, -originX, -originY);
    ctx.strokeStyle = '#C0C0C0';
    ctx.lineWidth = 0.3;
    ctx.beginPath();

    // 좌상 코너
    ctx.moveTo(left, top - L);
    ctx.lineTo(left, top);
    ctx.lineTo(left - L, top);

    // 우상 코너
    ctx.moveTo(right + L, top);
    ctx.lineTo(right, top);
    ctx.lineTo(right, top - L);

    // 좌하 코너
    ctx.moveTo(left - L, bottom);
    ctx.lineTo(left, bottom);
    ctx.lineTo(left, bottom + L);

    // 우하 코너
    ctx.moveTo(right, bottom + L);
    ctx.lineTo(right, bottom);
    ctx.lineTo(right + L, bottom);

    ctx.stroke();
    ctx.restore();
  }

  /** 엔진 Canvas2D 렌더. 디코드를 기다리는 그림 수를 지금 그리는 쪽의 합계에 더한다. */
  private renderLayer(
    pageIdx: number,
    canvas: HTMLCanvasElement,
    renderScale: number,
    layerKind: StaticCanvasLayerKind | 'flow' | 'flow-dynamic',
  ): void {
    const pending = this.wasm.renderPageToCanvasFiltered(
      pageIdx,
      canvas,
      renderScale,
      layerKind,
      this.renderProfile,
    );
    this.renderPendingPictures += Number(pending) || 0;
  }

  /**
   * 엔진은 그림을 비동기로 디코드한다. 디코드를 기다리느라 빼거나 작은 단계로 그린 그림이
   * 있으면 엔진의 디코드 완료 알림을 받아 그 쪽을 다시 그린다. 알림을 놓쳐도 fallback 시점에
   * 한 번은 다시 그린다.
   */
  private scheduleReRender(
    pageIdx: number,
    canvas: HTMLCanvasElement,
    renderScale: number,
    pendingPictures: number,
    policy: ReRenderPolicy,
  ): void {
    const previous = this.pictureJobs.get(pageIdx);
    // 다시 쓴 정적 층은 이번에 그리지 않았다. 그 층이 기다리던 그림은 이전 작업이 계속 맡는다.
    const carried = previous !== undefined && policy.reuseStaticOverlay;
    if (pendingPictures <= 0 && !carried) {
      this.cancelReRender(pageIdx);
      return;
    }
    if (previous?.fallbackTimer) clearTimeout(previous.fallbackTimer);
    const job: PictureRepaintJob = {
      canvas,
      renderScale,
      policy: carried ? { ...policy, reuseStaticOverlay: previous.policy.reuseStaticOverlay } : policy,
      fallbackTimer: null,
    };
    job.fallbackTimer = setTimeout(() => {
      job.fallbackTimer = null;
      this.repaintPictures(pageIdx, job);
    }, IMAGE_RE_RENDER_FALLBACK_DELAY_MS);
    this.pictureJobs.set(pageIdx, job);
    this.listenForPictures();
  }

  private listenForPictures(): void {
    this.stopPictureListener ??= this.wasm.onPictureDecoded?.(
      (pendingDecodes) => this.onPictureDecoded(pendingDecodes),
    ) ?? null;
  }

  private onPictureDecoded(pendingDecodes: number): void {
    if (this.pictureJobs.size === 0 && this.detailPicturePages.size === 0) return;
    if (pendingDecodes === 0) {
      if (this.pictureProgressTimer !== null) clearTimeout(this.pictureProgressTimer);
      this.pictureProgressTimer = null;
      this.requestPictureFlush();
    } else if (this.pictureProgressTimer === null) {
      this.pictureProgressTimer = setTimeout(() => {
        this.pictureProgressTimer = null;
        this.requestPictureFlush();
      }, PICTURE_PROGRESS_REPAINT_MS);
    }
  }

  private requestPictureFlush(): void {
    if (this.pictureFlushFrame !== null) return;
    this.pictureFlushFrame = requestAnimationFrame(() => {
      this.pictureFlushFrame = null;
      for (const [pageIdx, job] of [...this.pictureJobs]) this.repaintPictures(pageIdx, job);
      const detailPages = [...this.detailPicturePages];
      this.detailPicturePages.clear();
      for (const pageIdx of detailPages) this.pageRepaintListener?.(pageIdx);
    });
  }

  private repaintPictures(pageIdx: number, job: PictureRepaintJob): void {
    if (this.pictureJobs.get(pageIdx) !== job) return;
    // trap 한 엔진으로 다시 그리면 마지막으로 그린 쪽만 지운다.
    if (engineTrap() || !job.canvas.isConnected) {
      this.cancelReRender(pageIdx);
      return;
    }
    const pending = this.reRenderPageCanvases(pageIdx, job.canvas, job.renderScale, job.policy);
    if (pending > 0 && this.pictureJobs.get(pageIdx) === job) return;
    if (this.pictureJobs.get(pageIdx) === job) this.cancelReRender(pageIdx);
  }

  /** 쪽의 엔진 canvas 층을 다시 그리고, 아직 디코드를 기다리는 그림 수를 돌려준다. */
  private reRenderPageCanvases(
    pageIdx: number,
    flowCanvas: HTMLCanvasElement,
    renderScale: number,
    policy: ReRenderPolicy,
  ): number {
    const parent = flowCanvas.parentElement;
    if (!parent || engineTrap()) return 0;
    this.renderPendingPictures = 0;

    // canvas 크기는 엔진이 렌더에 성공한 뒤 스스로 맞춘다. 여기서 먼저 width 를 대입하면
    // 실패한 호출(trap 등)이 멀쩡한 층을 빈 비트맵으로 남긴다.
    try {
      let renderedStaticFlow = false;
      if (policy.reuseStaticFlow) {
        const flowStatic = this.findOverlayLayer(parent, pageIdx, 'flow-static');
        if (flowStatic) {
          try {
            this.renderLayer(pageIdx, flowStatic, renderScale, 'flow-static');
            renderedStaticFlow = true;
          } catch (error) {
            if (reportEngineTrap(error)) return 0;
            this.flowSplitSupported = false;
            discardPageLayer(flowStatic);
            console.warn('[PageRenderer] flow-static 지연 재렌더 실패, 기존 flow 재렌더로 fallback:', error);
          }
        } else if (this.findFlowImageLayer(parent, pageIdx)) {
          // 본문 그림은 DOM `<img>` 가 그린다. flow-dynamic canvas 에는 비동기 그림이 없으므로
          // 다시 그리지 않는다 — 'flow' 로 덮으면 불투명 용지가 `<img>` 층을 가린다.
          renderedStaticFlow = true;
        }
      }

      if (!renderedStaticFlow) {
        this.renderLayer(pageIdx, flowCanvas, renderScale, 'flow');
        this.drawMarginGuides(pageIdx, flowCanvas, renderScale);
      }

      if (policy.reuseStaticOverlay) {
        this.pageRepaintListener?.(pageIdx);
        return this.renderPendingPictures;
      }

      parent.querySelectorAll<HTMLCanvasElement>(
        `[data-rhwp-overlay-page="${pageIdx}"][data-rhwp-layer-kind]`,
      ).forEach((layerCanvas) => {
        const kind = layerCanvas.dataset.rhwpLayerKind;
        if (kind === 'background' || kind === 'behind' || kind === 'front') {
          this.renderLayer(pageIdx, layerCanvas, renderScale, kind);
        }
      });
      this.pageRepaintListener?.(pageIdx);
      return this.renderPendingPictures;
    } catch (error) {
      if (reportEngineTrap(error)) return 0;
      // 알림·타이머에서 도는 보조 재렌더라 받을 호출자가 없다. 다음 편집/스크롤 렌더가 다시 그린다.
      console.error(`[PageRenderer] 페이지 ${pageIdx} 지연 재렌더 실패:`, error);
      return 0;
    }
  }

  /** 특정 페이지의 지연 재렌더링을 취소한다. */
  cancelReRender(pageIdx: number): void {
    const job = this.pictureJobs.get(pageIdx);
    if (!job) return;
    if (job.fallbackTimer) clearTimeout(job.fallbackTimer);
    this.pictureJobs.delete(pageIdx);
  }

  /** 모든 지연 재렌더링을 취소한다 */
  cancelAll(): void {
    for (const pageIdx of [...this.pictureJobs.keys()]) this.cancelReRender(pageIdx);
    this.detailPicturePages.clear();
    if (this.pictureFlushFrame !== null) cancelAnimationFrame(this.pictureFlushFrame);
    this.pictureFlushFrame = null;
    if (this.pictureProgressTimer !== null) clearTimeout(this.pictureProgressTimer);
    this.pictureProgressTimer = null;
  }

  resetImageRetryState(): void {
    this.layerSummaryCache.clear();
    this.canvaskitDiagnosticsByPage.clear();
    this.pageInfoByPage.clear();
  }

  dispose(): void {
    this.cancelAll();
    this.stopPictureListener?.();
    this.stopPictureListener = null;
    this.layerSummaryCache.clear();
    this.canvaskitDiagnosticsByPage.clear();
    this.pageInfoByPage.clear();
    this.canvaskitRenderer = null;
  }
}

/** 쪽 층을 떼어 낸다. canvas 는 크기를 0으로 비워 GC 전에도 backing store 를 돌려준다. */
function discardPageLayer(layer: Element): void {
  if (layer instanceof HTMLCanvasElement) {
    layer.width = 0;
    layer.height = 0;
  }
  layer.remove();
}

function emptyLayerPlaneSummary(): LayerPlaneSummary {
  return {
    hasBehind: false,
    hasFront: false,
    imageCount: 0,
    rawSvgCount: 0,
    flowImageCount: 0,
    flowRawSvgCount: 0,
    flowStaticCount: 0,
    // 트리 fallback 경로는 순서 보존을 판정하지 않는다 — 분리하지 않는 쪽이 항상 정확하다.
    flowStaticSplitSafe: false,
    signature: 'empty',
  };
}

function finiteCount(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

function collectLayerPlaneSummary(
  node: any,
  summary: LayerPlaneSummary,
  inheritedLayer: any,
): void {
  if (!node || typeof node !== 'object') return;
  const activeLayer = inheritedReplayLayer(node.layer, inheritedLayer);
  if (Array.isArray(node.ops)) {
    for (const op of node.ops) {
      if (!op || typeof op !== 'object') continue;
      const plane = layerReplayPlane(op, activeLayer);
      if (op.type === 'image') {
        summary.imageCount += 1;
        if (plane === 'flow') {
          summary.flowImageCount += 1;
        }
      } else if (op.type === 'rawSvg') {
        // 차트/OLE 미리보기(#1456). 본문 정적 층 분리 판단에 image 와 함께 센다.
        summary.rawSvgCount += 1;
        if (plane === 'flow') {
          summary.flowRawSvgCount += 1;
        }
      }
      if (plane === 'behindText') {
        summary.hasBehind = true;
      } else if (plane === 'inFrontOfText') {
        summary.hasFront = true;
      }
    }
  }
  if (Array.isArray(node.children)) {
    for (const child of node.children) {
      collectLayerPlaneSummary(child, summary, activeLayer);
    }
  }
  if (node.child) {
    collectLayerPlaneSummary(node.child, summary, activeLayer);
  }
}

// #2318: 로컬 중복 구현을 제거하고 공유 분류기(replay-plane.ts)로 통일 —
// masterPage provenance cap 을 포함한 단일 진실 원천.
function layerReplayPlane(op: any, layer: any): 'background' | 'behindText' | 'flow' | 'inFrontOfText' {
  return layerPaintOpReplayPlane(op, layer);
}

function applyFlowImageCrop(
  element: HTMLImageElement,
  image: FlowImagePaintOp,
  displayScale: number,
): void {
  const crop = image.crop;
  if (!crop || element.naturalWidth <= 0 || element.naturalHeight <= 0) {
    element.style.left = '0';
    element.style.top = '0';
    element.style.width = '100%';
    element.style.height = '100%';
    return;
  }

  const scaleXHu = image.originalSizeHu
    ? image.originalSizeHu[0] / element.naturalWidth
    : HWP_UNITS_PER_CSS_PIXEL;
  const scaleYHu = image.originalSizeHu
    ? image.originalSizeHu[1] / element.naturalHeight
    : HWP_UNITS_PER_CSS_PIXEL;
  const sourceLeft = crop.left / scaleXHu;
  const sourceTop = crop.top / scaleYHu;
  const sourceWidth = (crop.right - crop.left) / scaleXHu;
  const sourceHeight = (crop.bottom - crop.top) / scaleYHu;
  if (sourceWidth <= 0 || sourceHeight <= 0) return;

  const scaleX = (image.bbox.width * displayScale) / sourceWidth;
  const scaleY = (image.bbox.height * displayScale) / sourceHeight;
  element.style.left = `${-sourceLeft * scaleX}px`;
  element.style.top = `${-sourceTop * scaleY}px`;
  element.style.width = `${element.naturalWidth * scaleX}px`;
  element.style.height = `${element.naturalHeight * scaleY}px`;
}
