import type { WasmBridge } from '@/core/wasm-bridge';
import type { LayerRenderProfile, PageInfo } from '@/core/types';
import { inheritedReplayLayer, layerPaintOpReplayPlane } from './canvaskit/replay-plane';
import type { CanvasKitLayerRenderer, CanvasKitRenderDiagnostics } from './canvaskit-renderer';
import { collectLayerImagePrefetch } from './raw-svg-prefetch';
import { ImagePrefetcher } from './image-prefetch';
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
  rawSvgCount: number;  // OLE/차트 rawSvg op 수 — 비동기 디코드 재렌더 트리거용(image 와 의미 분리, #1456)
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
  retrySignature: string;
  reuseStaticFlow: boolean;
  reuseStaticOverlay: boolean;
}

interface LayerSummaryCacheEntry {
  key: string;
  summary: LayerPlaneSummary;
}

interface ReRenderJob {
  prefetchAbort: AbortController;
  fallbackTimer: ReturnType<typeof setTimeout>;
  earlyRawSvgTimers: ReturnType<typeof setTimeout>[];
  completed: boolean;
}

/**
 * 쪽별 지연 재렌더 상태. 같은 key(그림 수·서명)는 한 번만 끝까지 다시 그리면 된다.
 * settled 는 재렌더가 실제로 끝났을 때만 true — 디코드 도중 취소된 key 는 다시 걸어야 한다.
 */
interface ImageRetryState {
  key: string;
  settled: boolean;
}

interface AppliedOverlays {
  layers: LayerPlaneSummary;
  /** 본문 그림을 DOM `<img>` 층으로 실제로 띄웠는가 (flow canvas 에는 그림이 없다). */
  domFlowImages: boolean;
}

type LayerImagePrefetchResult = 'decoded' | 'none' | 'wait';

const IMAGE_RE_RENDER_FALLBACK_DELAY_MS = 1500;
// 순수 SVG 차트/OLE는 prefetch 대상 data URL이 없을 수 있다. 첫 paint가 시작한
// 이미지 decode를 빠르게 반영하되, 일반 이미지처럼 전역 반복 재렌더는 피한다.
const RAW_SVG_EARLY_RE_RENDER_DELAYS_MS = [0, 32, 96, 240] as const;
const HWP_UNITS_PER_CSS_PIXEL = 75;

export class PageRenderer {
  private readonly imagePrefetcher = new ImagePrefetcher();
  private reRenderJobs = new Map<number, ReRenderJob>();
  private imageRetryStates = new Map<number, ImageRetryState>();
  private layerSummaryCache = new Map<number, LayerSummaryCacheEntry>();
  private canvaskitDiagnosticsByPage = new Map<number, CanvasKitRenderDiagnostics>();
  private pageInfoByPage = new Map<number, PageInfo>();
  private flowSplitSupported: boolean | null = null;

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
      this.wasm.renderPageToCanvasFiltered(pageIdx, canvas, renderScale, 'flow', this.renderProfile);
      this.drawMarginGuides(pageIdx, canvas, renderScale);
      overlays = this.applyOverlays(pageIdx, canvas, renderScale, dpr, context, layers, false, []);
    }
    this.rememberLayerPlaneSummary(pageIdx, canvas, renderScale, layers);
    const summary = overlays.layers;
    // rawSvg(차트/OLE)도 web_canvas draw_image 비동기 디코드 경로를 타므로
    // image 와 함께 재렌더 트리거 카운트에 합산한다(#1456). DOM `<img>` 가 맡은 본문
    // 그림만 빼고, canvas 가 그리는 앞/뒤 층 그림은 계속 센다.
    const canvasImageCount = overlays.domFlowImages
      ? Math.max(0, summary.imageCount - summary.flowImageCount)
      : summary.imageCount;
    this.scheduleReRender(
      pageIdx,
      canvas,
      renderScale,
      canvasImageCount + summary.rawSvgCount,
      summary.rawSvgCount,
      {
        retrySignature: summary.signature,
        reuseStaticFlow,
        reuseStaticOverlay: context.reason === 'text-edit' && context.allowStaticOverlayReuse === true,
      },
    );
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
      this.imageRetryStates.delete(pageIdx);
      return renderedCanvas;
    } catch (error) {
      this.canvaskitRenderer.recordRenderFailure(error, !renderStarted);
      this.canvaskitDiagnosticsByPage.set(pageIdx, this.canvaskitRenderer.diagnostics());
      console.error(`[PageRenderer] CanvasKit 페이지 렌더링 실패 (page=${pageIdx}):`, error);
      this.cancelReRender(pageIdx);
      this.imageRetryStates.delete(pageIdx);
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
        // 엔진 flow-static canvas 로 그린다. 첫 Canvas2D 렌더가 이미지 디코드를 시작해야 지연
        // 재렌더에서 보인다.
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

    reusableLayer?.remove();
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
    if (renderImmediately) {
      this.wasm.renderPageToCanvasFiltered(
        pageIdx,
        layer,
        renderScale,
        layerKind,
        this.renderProfile,
      );
    }
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
    ).forEach((el) => el.remove());
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
    this.findOverlayLayer(parent, pageIdx, layerKind)?.remove();
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
    ).forEach((el) => el.remove());
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
    this.wasm.renderPageToCanvasFiltered(pageIdx, canvas, scale, 'flow', this.renderProfile);
    this.drawMarginGuides(pageIdx, canvas, scale);
    this.scheduleReRender(pageIdx, canvas, scale, 0, 0, {
      retrySignature: 'flow-only',
      reuseStaticFlow: false,
      reuseStaticOverlay: false,
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
      this.wasm.renderPageToCanvasFiltered(pageIdx, canvas, renderScale, 'flow', this.renderProfile);
      return false;
    }
    try {
      this.wasm.renderPageToCanvasFiltered(
        pageIdx,
        canvas,
        renderScale,
        'flow-dynamic',
        this.renderProfile,
      );
      this.flowSplitSupported = true;
      return true;
    } catch (error) {
      this.flowSplitSupported = false;
      console.warn('[PageRenderer] flow-dynamic 렌더 미지원, 기존 flow 렌더로 fallback:', error);
      this.wasm.renderPageToCanvasFiltered(pageIdx, canvas, renderScale, 'flow', this.renderProfile);
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

  /** 편집 용지 여백 가이드라인을 캔버스에 그린다 (4모서리 L자 표시) */
  private drawMarginGuides(pageIdx: number, canvas: HTMLCanvasElement, scale: number): void {
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
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
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

  /**
   * 비동기 이미지 로드 대응: data URL 이미지가 첫 렌더링 시
   * 아직 디코딩되지 않았을 수 있으므로 점진적 재렌더링한다.
   *
   * decode 완료 후 한 번 다시 그린다. 미리 디코드할 수 없는 그림은 fallback 시점에
   * 한 번만 다시 그려 이미지 누락 안전망을 유지하고, 비동기 그림이 없으면 다시 그리지 않는다.
   */
  private scheduleReRender(
    pageIdx: number,
    canvas: HTMLCanvasElement,
    renderScale: number,
    imageCount: number,
    rawSvgCount: number,
    policy: ReRenderPolicy,
  ): void {
    if (imageCount <= 0) {
      this.cancelReRender(pageIdx);
      this.imageRetryStates.delete(pageIdx);
      return;
    }
    const retryKey = `${imageCount}:${rawSvgCount}:${policy.retrySignature}`;
    const previous = this.imageRetryStates.get(pageIdx);
    if (previous?.key === retryKey) {
      // 같은 내용은 이미 다시 그렸거나 진행 중인 작업이 맡고 있다.
      if (previous.settled || this.reRenderJobs.has(pageIdx)) return;
      // 디코드 도중 취소된 같은 내용(편집·새로고침·스크롤)은 그림이 아직 비어 있을 수 있다.
      // 트리를 다시 읽고 디코드를 새로 거는 대신 fallback 한 번만 다시 건다 — 에이전트
      // 연속 편집마다 수 MB 트리를 다시 읽지 않는다.
      this.startReRenderJob(pageIdx, canvas, renderScale, policy, previous, {
        rawSvgCount: 0,
        prefetch: false,
      });
      return;
    }

    this.cancelReRender(pageIdx);
    const state: ImageRetryState = { key: retryKey, settled: false };
    this.imageRetryStates.set(pageIdx, state);
    this.startReRenderJob(pageIdx, canvas, renderScale, policy, state, {
      rawSvgCount,
      prefetch: true,
    });
  }

  private startReRenderJob(
    pageIdx: number,
    canvas: HTMLCanvasElement,
    renderScale: number,
    policy: ReRenderPolicy,
    state: ImageRetryState,
    options: { rawSvgCount: number; prefetch: boolean },
  ): void {
    const job: ReRenderJob = {
      prefetchAbort: new AbortController(),
      fallbackTimer: 0 as unknown as ReturnType<typeof setTimeout>,
      earlyRawSvgTimers: [],
      completed: false,
    };
    const isCurrent = () => !job.completed && this.reRenderJobs.get(pageIdx) === job;
    /** 작업을 끝낸다. 이 key 는 다시 그릴 필요가 없다. */
    const settle = (): boolean => {
      if (!isCurrent()) return false;
      job.completed = true;
      job.prefetchAbort.abort();
      clearTimeout(job.fallbackTimer);
      for (const timer of job.earlyRawSvgTimers) clearTimeout(timer);
      this.reRenderJobs.delete(pageIdx);
      state.settled = true;
      return true;
    };
    const finish = () => {
      // trap 한 엔진으로 다시 그리면 마지막으로 그린 쪽만 지운다. 작업은 onEngineTrap 이 끊는다.
      if (engineTrap() || !settle()) return;
      if (canvas.parentElement) this.reRenderPageCanvases(pageIdx, canvas, renderScale, policy);
    };
    job.fallbackTimer = setTimeout(finish, IMAGE_RE_RENDER_FALLBACK_DELAY_MS);
    this.reRenderJobs.set(pageIdx, job);
    if (!options.prefetch) return;

    if (options.rawSvgCount > 0) {
      for (const delay of RAW_SVG_EARLY_RE_RENDER_DELAYS_MS) {
        const timer = setTimeout(() => {
          if (!isCurrent() || engineTrap()) return;
          if (canvas.parentElement) {
            this.reRenderPageCanvases(pageIdx, canvas, renderScale, policy);
          }
        }, delay);
        job.earlyRawSvgTimers.push(timer);
      }
    }

    // 자체 prefetch로 실제 decode를 마친 경우에만 fallback보다 먼저 다시 그린다.
    queueMicrotask(() => {
      if (!isCurrent()) return;
      this.prefetchLayerImages(pageIdx, job.prefetchAbort.signal)
        .then((result) => {
          if (result === 'decoded') finish();
          // 첫 paint 가 이미 완전하다 — fallback 재렌더도 필요 없다.
          else if (result === 'none') settle();
        })
        .catch(() => {});
    });
  }

  private reRenderPageCanvases(
    pageIdx: number,
    flowCanvas: HTMLCanvasElement,
    renderScale: number,
    policy: ReRenderPolicy,
  ): void {
    const parent = flowCanvas.parentElement;
    if (!parent || engineTrap()) return;

    // canvas 크기는 엔진이 렌더에 성공한 뒤 스스로 맞춘다. 여기서 먼저 width 를 대입하면
    // 실패한 호출(trap 등)이 멀쩡한 층을 빈 비트맵으로 남긴다.
    try {
      let renderedStaticFlow = false;
      if (policy.reuseStaticFlow) {
        const flowStatic = this.findOverlayLayer(parent, pageIdx, 'flow-static');
        if (flowStatic) {
          try {
            this.wasm.renderPageToCanvasFiltered(
              pageIdx,
              flowStatic,
              renderScale,
              'flow-static',
              this.renderProfile,
            );
            renderedStaticFlow = true;
          } catch (error) {
            if (reportEngineTrap(error)) return;
            this.flowSplitSupported = false;
            flowStatic.remove();
            console.warn('[PageRenderer] flow-static 지연 재렌더 실패, 기존 flow 재렌더로 fallback:', error);
          }
        } else if (this.findFlowImageLayer(parent, pageIdx)) {
          // 본문 그림은 DOM `<img>` 가 그린다. flow-dynamic canvas 에는 비동기 그림이 없으므로
          // 다시 그리지 않는다 — 'flow' 로 덮으면 불투명 용지가 `<img>` 층을 가린다.
          renderedStaticFlow = true;
        }
      }

      if (!renderedStaticFlow) {
        this.wasm.renderPageToCanvasFiltered(
          pageIdx,
          flowCanvas,
          renderScale,
          'flow',
          this.renderProfile,
        );
        this.drawMarginGuides(pageIdx, flowCanvas, renderScale);
      }

      if (policy.reuseStaticOverlay) return;

      parent.querySelectorAll<HTMLCanvasElement>(
        `[data-rhwp-overlay-page="${pageIdx}"][data-rhwp-layer-kind]`,
      ).forEach((layerCanvas) => {
        const kind = layerCanvas.dataset.rhwpLayerKind;
        if (kind === 'background' || kind === 'behind' || kind === 'front') {
          this.wasm.renderPageToCanvasFiltered(
            pageIdx,
            layerCanvas,
            renderScale,
            kind,
            this.renderProfile,
          );
        }
      });
    } catch (error) {
      if (reportEngineTrap(error)) return;
      // 타이머에서 도는 보조 재렌더라 받을 호출자가 없다. 다음 편집/스크롤 렌더가 다시 그린다.
      console.error(`[PageRenderer] 페이지 ${pageIdx} 지연 재렌더 실패:`, error);
    }
  }

  /**
   * 페이지의 image base64 데이터를
   * 자체 prefetch 하여 모든 이미지가 브라우저에 디코드 완료될 때까지 대기.
   * Task #1154 — IMAGE_CACHE 의 비동기 디코드 누락 안전망.
   */
  private async prefetchLayerImages(
    pageIdx: number,
    signal: AbortSignal,
  ): Promise<LayerImagePrefetchResult> {
    if (signal.aborted) return 'wait';
    let plan: ReturnType<typeof collectLayerImagePrefetch>;
    try {
      // 트리 JSON 의 op 는 bbox 가 mime 앞에 온다 — 정규식이 아니라 구조를 따라 읽는다.
      plan = collectLayerImagePrefetch(JSON.parse(this.wasm.getPageLayerTree(pageIdx)));
    } catch {
      // 트리를 못 읽으면 무엇이 비었는지 모른다. 조기/fallback 타이머에 맡긴다.
      return 'wait';
    }
    // 미리 디코드할 URL 을 못 모은 비동기 그림(WMF, 한도 초과 등)과 순수 rawSvg 는
    // upstream 의 조기 재렌더 + fallback 경로를 그대로 쓴다.
    if (plan.kind !== 'decoded') return plan.kind;
    await this.imagePrefetcher.prefetch(plan.urls, signal);
    return signal.aborted ? 'wait' : 'decoded';
  }

  /**
   * 특정 페이지의 지연 재렌더링을 취소한다. retry key 는 settled=false 로 남아, 같은 내용을
   * 다시 그릴 때 fallback 재렌더를 다시 건다.
   */
  cancelReRender(pageIdx: number): void {
    const job = this.reRenderJobs.get(pageIdx);
    if (job) {
      job.completed = true;
      job.prefetchAbort.abort();
      clearTimeout(job.fallbackTimer);
      for (const timer of job.earlyRawSvgTimers) clearTimeout(timer);
      this.reRenderJobs.delete(pageIdx);
    }
  }

  /** 모든 지연 재렌더링을 취소한다 */
  cancelAll(): void {
    // 모든 요청을 먼저 취소해 다른 오래된 페이지의 대기 디코드를 시작하지 않는다.
    for (const job of this.reRenderJobs.values()) job.completed = true;
    this.imagePrefetcher.cancelAll();
    for (const pageIdx of this.reRenderJobs.keys()) this.cancelReRender(pageIdx);
  }

  resetImageRetryState(): void {
    this.imageRetryStates.clear();
    this.layerSummaryCache.clear();
    this.canvaskitDiagnosticsByPage.clear();
    this.pageInfoByPage.clear();
  }

  dispose(): void {
    this.cancelAll();
    this.layerSummaryCache.clear();
    this.canvaskitDiagnosticsByPage.clear();
    this.pageInfoByPage.clear();
    this.canvaskitRenderer = null;
  }
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
        // 차트/OLE 미리보기. web_canvas draw_image 비동기 디코드 경로를 타므로
        // image 와 동일하게 재렌더 트리거 대상에 포함한다(#1456).
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
