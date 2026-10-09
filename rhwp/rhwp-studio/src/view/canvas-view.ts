import { WasmBridge } from '@/core/wasm-bridge';
import { EventBus } from '@/core/event-bus';
import type { PageInfo } from '@/core/types';
import { VirtualScroll } from './virtual-scroll';
import { CanvasPool } from './canvas-pool';
import { MutationRefreshQueue, type MutationRefreshBatch } from './mutation-refresh-queue';
import { PageRenderer, type PageRenderContext, type PageRenderResult } from './page-renderer';
import { MAX_ZOOM, MIN_ZOOM, ViewportManager } from './viewport-manager';
import { CoordinateSystem } from './coordinate-system';
import type { CanvasKitRenderDiagnostics } from './canvaskit-renderer';
import { clampRenderScale, regionRenderScale, type RenderBackend } from './render-backend';
import { PageDetailLayers, planPageDetail, type PageDetailPlan } from './page-detail';
import {
  RendererSession,
  type RendererSessionDiagnostics,
  type RendererSessionSelection,
} from './renderer-session';
import { applyGridOverlayBox, createGridClipCornerOverlay, createGridOverlay } from './grid-overlay';
import { getGridViewSettings } from './grid-settings';
import {
  calculateAnchoredScroll,
  CENTER_ZOOM_ANCHOR,
  normalizeZoomAnchor,
  type ZoomAnchor,
  type ZoomPageBox,
} from './zoom-anchor.ts';
import {
  resolveActivePage,
  type ActivePageSnapshot,
} from './active-page.ts';
import { SubsecondRevisionWatcher } from '@/core/subsecond-runtime';
import { engineTrap, onEngineTrap, reportEngineTrap } from '@/core/engine-trap';
import {
  headerFooterApplyToLabel,
  parseHeaderFooterModeChanged,
  type HeaderFooterModeState,
} from '@/engine/header-footer-mode.ts';
import {
  createHeaderFooterGuideCorners,
  headerFooterPreviewRegion,
  resolveHeaderFooterBadgeMetrics,
  resolveHeaderFooterBandBox,
} from './header-footer-edit-overlay.ts';

const TEXT_EDIT_STATIC_LAYER_VERIFY_DELAY_MS = 800;
const AUTO_RENDERER_RESELECTION_DELAY_MS = 300;
/** 스크롤이 멎은 뒤 화면을 벗어난 detail 영역을 다시 그리기까지의 대기. */
const PAGE_DETAIL_SCROLL_IDLE_MS = 120;
/** 쪽 canvas 보다 이만큼 이상 선명해질 때만 detail 층을 쓴다. */
const PAGE_DETAIL_MIN_GAIN = 1.01;

type DeferredPrefetchTask =
  | { kind: 'idle'; id: number }
  | { kind: 'timeout'; id: number };

type IdleCallbackWindow = Window & {
  requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
  cancelIdleCallback?: (id: number) => void;
};

export class CanvasView {
  private virtualScroll: VirtualScroll;
  private canvasPool: CanvasPool;
  private pageRenderer: PageRenderer;
  private viewportManager: ViewportManager;
  private coordinateSystem: CoordinateSystem;
  private subsecondRevisionWatcher: SubsecondRevisionWatcher;

  private scrollContent: HTMLElement;
  private pages: PageInfo[] = [];
  private currentVisiblePages: number[] = [];
  private editingPageIndex: number | null = null;
  private activePageSnapshot: ActivePageSnapshot | null = null;
  /** viewport-scroll 에서 호출된 updateVisiblePages 인가 (current-page-changed 중복 억제용) */
  private scrollDrivenVisibleUpdate = false;
  /** 마지막으로 발행한 current-page-changed 의 `쪽|전체 쪽 수` */
  private lastCurrentPageKey = '';
  private headerFooterEditState: HeaderFooterModeState | null = null;
  private gridOverlaysByPage = new Map<number, HTMLElement[]>();
  private pageDetails: PageDetailLayers;
  private pageDetailTimer: ReturnType<typeof setTimeout> | null = null;
  private pageDetailRepaintFrame: number | null = null;
  private pageDetailRepaintPages = new Set<number>();
  private unsubscribers: (() => void)[] = [];
  private textEditStaticLayerVerifyTimers = new Map<number, ReturnType<typeof setTimeout>>();
  private pendingPrefetchPages = new Set<number>();
  private lastMutationTime = -Infinity;
  private deferredPrefetchTask: DeferredPrefetchTask | null = null;
  private rendererSelectionEpoch = 0;
  private rendererFallbackScheduled = false;
  private activeRendererDecisionKey: string | null = null;
  private autoRendererReselectionTimer: ReturnType<typeof setTimeout> | null = null;
  private mutationRefreshQueue = new MutationRefreshQueue(
    (batch, isCurrent) => this.refreshMutationBatch(batch, isCurrent),
    error => console.error('[CanvasView] 문서 갱신 실패:', error),
  );
  private documentLoadPrepared = false;
  private layoutViewportSize = { width: 0, height: 0 };
  /** 전체 refresh 마다 증가 — 머리말/꼬리말 대표 preview 재사용 키에 들어간다. */
  private documentRenderGeneration = 0;
  private disposed = false;

  constructor(
    private container: HTMLElement,
    private wasm: WasmBridge,
    private eventBus: EventBus,
    private rendererSession: RendererSession,
  ) {
    this.virtualScroll = new VirtualScroll();
    this.canvasPool = new CanvasPool();
    this.pageRenderer = new PageRenderer(wasm);
    this.viewportManager = new ViewportManager(eventBus);
    this.coordinateSystem = new CoordinateSystem(this.virtualScroll);
    this.subsecondRevisionWatcher = new SubsecondRevisionWatcher(
      wasm,
      () => eventBus.emit('document-view-changed', 'subsecond-renderer'),
    );
    this.subsecondRevisionWatcher.start();

    this.scrollContent = container.querySelector('#scroll-content')!;
    this.pageDetails = new PageDetailLayers(this.scrollContent);
    this.pageRenderer.setPageRepaintListener((pageIdx) => this.queuePageDetailRepaint(pageIdx));
    this.viewportManager.attachTo(container);
    this.unsubscribers.push(this.watchDevicePixelRatio(), this.watchCanvasContextRestore());
    // trap 뒤에는 어떤 예약 작업도 엔진을 부를 수 없다. 대기 중인 이미지 재렌더·선렌더·검증
    // 타이머가 마지막으로 그린 쪽을 지우지 않도록 모두 끊는다.
    this.unsubscribers.push(onEngineTrap(() => {
      this.pageRenderer.cancelAll();
      this.cancelPendingPrefetch();
      this.cancelTextEditStaticLayerVerification();
      this.cancelAutoRendererReselection();
    }));
    // trap 뒤에는 detail 층을 다시 그릴 수 없다. 쪽 canvas 만 남겨 하나의 상태를 보여 준다.
    this.unsubscribers.push(onEngineTrap(() => this.clearPageDetails()));

    this.unsubscribers.push(
      eventBus.on('viewport-scroll', () => {
        if (this.viewportManager.isZoomAnimating()) return;
        // 순수 스크롤 프레임에서는 쪽이 실제로 바뀔 때만 상태 표시줄을 갱신한다.
        this.scrollDrivenVisibleUpdate = true;
        try {
          this.updateVisiblePages();
        } finally {
          this.scrollDrivenVisibleUpdate = false;
        }
      }),
      eventBus.on('viewport-resize', () => this.onViewportResize()),
      eventBus.on('viewport-inset-changed', () => this.recenterHorizontally()),
      eventBus.on('zoom-changed', (zoom, anchor) => {
        this.onZoomChanged(
          zoom as number,
          normalizeZoomAnchor(anchor as Partial<ZoomAnchor> | undefined),
        );
      }),
      eventBus.on('headerFooterModeChanged', (payload) => {
        this.handleHeaderFooterModeChanged(payload);
      }),
      eventBus.on('document-page-invalidated', (payload) => {
        this.lastMutationTime = performance.now();
        const pageIndex = this.pageIndexFromPayload(payload);
        if (pageIndex === null) {
          this.scheduleMutationRefresh();
          return;
        }
        const textOnly = typeof payload === 'object' && payload !== null
          && 'reason' in payload && payload.reason === 'text-edit';
        this.mutationRefreshQueue.invalidatePage(pageIndex, textOnly);
      }),
      eventBus.on('document-changed', () => this.scheduleMutationRefresh()),
      eventBus.on('document-view-changed', (source) => {
        if (source === 'subsecond-renderer') {
          this.refreshPages();
          return;
        }
        void this.refreshPagesForRevision();
      }),
      eventBus.on('grid-view-changed', () => this.refreshGridOverlays()),
      eventBus.on('cursor-rect-updated', (payload) => {
        const pageIndex = this.pageIndexFromPayload(payload);
        if (pageIndex !== null) this.setEditingPageIndex(pageIndex);
      }),
      eventBus.on('editing-page-changed', (payload) => {
        this.setEditingPageIndex(this.pageIndexFromPayload(payload));
      }),
      eventBus.on('picture-object-selection-changed', (selected) => {
        if (selected === false) this.setEditingPageIndex(null);
      }),
      eventBus.on('table-object-selection-changed', (selected) => {
        if (selected === false) this.setEditingPageIndex(null);
      }),
    );
  }

  /** 문서 로드 후 호출 — 페이지 정보 수집 및 가상 스크롤 초기화 */
  async loadDocument(): Promise<void> {
    if (this.disposed) return;
    if (!this.documentLoadPrepared) this.prepareDocumentLoad();
    const epoch = this.rendererSelectionEpoch;
    this.documentLoadPrepared = false;
    if (this.disposed) return;
    const selection = await this.rendererSession.resolve(this.wasm);
    if (
      this.disposed
      || epoch !== this.rendererSelectionEpoch
      || !this.rendererSession.isCurrent(selection)
    ) return;
    this.applyRendererSelection(selection);

    const pageCount = this.wasm.pageCount;
    this.pages = this.collectPageInfo(pageCount) ?? [];

    if (this.pages.length === 0) {
      console.error('[CanvasView] 로드된 페이지가 없습니다');
      return;
    }

    // 모바일: 문서 로드 시 폭 맞춤 줌 자동 적용
    if (window.innerWidth < 1024 && this.pages.length > 0) {
      const containerWidth = this.container.clientWidth - 20;
      const pageWidth = this.pages[0].width;
      if (pageWidth > 0 && containerWidth > 0) {
        const fitZoom = containerWidth / pageWidth;
        this.viewportManager.setZoom(Math.max(MIN_ZOOM, Math.min(fitZoom, MAX_ZOOM)));
      }
    }

    this.recalcLayout();
    this.viewportManager.setScrollLeft(
      this.virtualScroll.getCenteredScrollLeft(this.layoutViewportSize.width),
    );

    // 캐시 좌표도 함께 0 으로 맞춘다 — 직접 대입하면 첫 쪽 창이 이전 문서의 위치로 계산된다.
    this.viewportManager.setScrollTop(0);
    this.updateVisiblePages();
    // 초기 replay가 예약한 document fallback을 load 완료 전에 확정한다.
    await Promise.resolve();

    console.log(`[CanvasView] ${this.pages.length}/${pageCount}페이지 로드, 총 높이: ${this.virtualScroll.getTotalHeight()}px`);
  }

  /** 엔진이 trap 했으면 null — 호출자는 지금 배치를 그대로 둔다. */
  private collectPageInfo(pageCount: number): PageInfo[] | null {
    try {
      const pages = this.wasm.getAllPageInfo();
      if (pages.length === pageCount) return pages;
      console.warn(`[CanvasView] 전체 페이지 정보 개수 불일치: ${pages.length}/${pageCount}`);
    } catch (error) {
      if (reportEngineTrap(error)) return null;
      console.warn('[CanvasView] 전체 페이지 정보 조회 실패, 개별 조회로 대체:', error);
    }

    const pages: PageInfo[] = [];
    for (let page = 0; page < pageCount; page++) {
      try {
        pages.push(this.wasm.getPageInfo(page));
      } catch (error) {
        if (reportEngineTrap(error)) return null;
        console.error(`[CanvasView] 페이지 ${page} 정보 조회 실패:`, error);
      }
    }
    return pages;
  }

  /** WASM 문서 교체 직후 호출하여 이전 문서의 renderer와 canvas를 동기적으로 분리한다. */
  prepareDocumentLoad(): void {
    if (this.disposed) return;
    this.rendererSelectionEpoch += 1;
    this.documentLoadPrepared = true;
    this.cancelAutoRendererReselection();
    this.rendererFallbackScheduled = false;
    this.rendererSession.beginDocument(this.wasm.documentDigest);
    this.activeRendererDecisionKey = null;
    this.reset();
  }

  resetRendererDiagnostics(): void {
    this.pageRenderer.releaseAllPageDiagnostics();
  }

  /** 전체/쪽별 무효화를 같은 프레임의 renderer 선택 한 번으로 합친다. */
  private scheduleMutationRefresh(): void {
    if (this.disposed) return;
    this.lastMutationTime = performance.now();
    this.mutationRefreshQueue.invalidateAll();
  }

  private cancelScheduledMutationRefresh(): void {
    this.mutationRefreshQueue.cancel();
  }

  private async refreshPagesForRevision(): Promise<void> {
    const selected = await this.selectNextDocumentRevision(false);
    if (!selected) return;
    this.refreshPages();
  }

  private async refreshMutationBatch(
    batch: MutationRefreshBatch,
    isCurrent: () => boolean,
  ): Promise<void> {
    if (engineTrap()) return;
    const selected = await this.selectMutationRevision();
    if (!isCurrent() || !selected || !this.rendererSession.isCurrent(selected.selection)) return;
    const full = batch.full || selected.backendChanged
      || this.wasm.pageCount !== this.pages.length
      || Array.from(batch.pages.keys()).some(page => page >= this.pages.length);
    if (full) {
      this.refreshPages();
      // 새 page offset을 사용하는 캐럿 reveal의 완료 경계.
      this.eventBus.emit('document-layout-refreshed', { source: 'mutation' });
      return;
    }
    for (const [pageIndex, textOnly] of batch.pages) {

      this.cancelTextEditStaticLayerVerification(pageIndex);
      this.refreshInvalidatedPageNow(pageIndex, {
        reason: textOnly ? 'text-edit' : 'unknown',
        allowStaticOverlayReuse: textOnly,
      });
    }
  }

  private async selectMutationRevision(): Promise<{
    selection: RendererSessionSelection;
    backendChanged: boolean;
  } | null> {
    if (this.disposed) return null;
    const pinned = this.rendererSession.pinAutoMutationRevision();
    if (!pinned) return this.selectNextDocumentRevision();

    this.rendererSelectionEpoch += 1;
    const selected = {
      selection: pinned,
      backendChanged: this.applyRendererSelection(pinned),
    };
    this.scheduleAutoRendererReselection();
    return selected;
  }

  private scheduleAutoRendererReselection(): void {
    this.cancelAutoRendererReselection();
    this.autoRendererReselectionTimer = setTimeout(() => {
      this.autoRendererReselectionTimer = null;
      void this.selectNextDocumentRevision().then((selected) => {
        if (!selected || this.disposed) return;
        if (selected.backendChanged) this.refreshPages();
      });
    }, AUTO_RENDERER_RESELECTION_DELAY_MS);
  }

  private cancelAutoRendererReselection(): void {
    if (this.autoRendererReselectionTimer === null) return;
    clearTimeout(this.autoRendererReselectionTimer);
    this.autoRendererReselectionTimer = null;
  }

  private async selectNextDocumentRevision(resetResources = true): Promise<{
    selection: RendererSessionSelection;
    backendChanged: boolean;
  } | null> {
    if (this.disposed) return null;
    const epoch = ++this.rendererSelectionEpoch;
    this.rendererSession.invalidateDocument({ resetResources });
    await Promise.resolve();
    if (this.disposed || epoch !== this.rendererSelectionEpoch) return null;

    const selection = await this.rendererSession.resolve(this.wasm);
    if (
      this.disposed
      || epoch !== this.rendererSelectionEpoch
      || !this.rendererSession.isCurrent(selection)
    ) return null;
    return {
      selection,
      backendChanged: this.applyRendererSelection(selection),
    };
  }

  private applyRendererSelection(selection: RendererSessionSelection): boolean {
    const decisionChanged = this.activeRendererDecisionKey !== selection.diagnostics.decisionKey;
    const changed = this.pageRenderer.configure(
      selection.backend,
      selection.diagnostics.renderProfile,
      selection.canvaskitRenderer,
      selection.backend === 'canvas2d'
        && (
          selection.diagnostics.fallbackReason === 'canvaskitResourcePreparationFailed'
          || selection.diagnostics.fallbackReason === 'canvaskitRuntimeFailed'
        ),
    );
    if (decisionChanged && !changed) this.pageRenderer.invalidateDocumentRevision();
    this.activeRendererDecisionKey = selection.diagnostics.decisionKey;
    this.eventBus.emit('renderer-selection-changed', selection.diagnostics);
    return changed;
  }

  /** DEV baseline이 pool 소유권을 바꾸지 않고 현재 페이지를 즉시 다시 그린다. */
  rerenderPageForDiagnostics(pageIdx: number): boolean {
    const canvas = this.canvasPool.getCanvas(pageIdx);
    return canvas ? this.renderCanvas(pageIdx, canvas) : false;
  }

  /** 레이아웃을 재계산한다 (줌/리사이즈 공통) */
  private recalcLayout(): void {
    const zoom = this.viewportManager.getZoom();
    const viewport = this.viewportManager.getViewportSize();
    // 쪽 이동/맞쪽 배치는 아직 이식하지 않아 세로는 항상 vertical 이다.
    // viewport.height 는 가로 줄 레이아웃 슬롯을 채워 둔다.
    this.virtualScroll.setPageDimensions(
      this.pages,
      zoom,
      viewport.width,
      undefined,
      'vertical',
      viewport.height,
    );
    this.scrollContent.style.height = `${this.virtualScroll.getTotalHeight()}px`;
    this.scrollContent.style.width = `${this.virtualScroll.getTotalWidth()}px`;
    this.layoutViewportSize = viewport;

    // 그리드 모드 CSS 클래스 토글
    this.scrollContent.classList.toggle('grid-mode', this.virtualScroll.isGridMode());

    // 가상 스크롤 페이지 배치가 확정된 뒤에만 화면 좌표가 유효하다 — 문서 변이
    // 직후(비동기 refresh 이전)에 그린 오버레이가 여기서 재배치된다.
    this.eventBus.emit('page-layout-changed');
  }

  /** 스크롤/리사이즈 시 보이는 페이지를 갱신한다 */
  private updateVisiblePages(): void {
    // 멈춘 엔진으로는 새 쪽을 그릴 수 없다. 이미 그린 쪽을 해제하지 않고 그대로 둔다.
    if (engineTrap()) return;
    const scrollY = this.viewportManager.getScrollY();
    const scrollX = this.viewportManager.getScrollX();
    const { width: vpWidth, height: vpHeight } = this.viewportManager.getViewportSize();

    const pageWindow = this.virtualScroll.getPageWindow(scrollY, vpHeight, scrollX, vpWidth);
    const prefetchPages = pageWindow.prefetch;
    const visiblePages = pageWindow.visible;
    const visibleSet = new Set(visiblePages);

    // 벗어난 페이지 해제
    const prefetchSet = new Set(prefetchPages);
    for (const pageIdx of this.canvasPool.activePages) {
      if (!prefetchSet.has(pageIdx)) {
        this.releaseRenderedPage(pageIdx);
      }
    }

    // 현재 보이는 페이지는 즉시 렌더한다. 인접 페이지는 스크롤 입력 뒤에 처리한다.
    for (const pageIdx of visiblePages) {
      this.pendingPrefetchPages.delete(pageIdx);
      if (!this.canvasPool.has(pageIdx)) {
        this.renderPage(pageIdx);
      }
    }
    this.schedulePrefetchPages(prefetchPages.filter((pageIdx) => !visibleSet.has(pageIdx)));

    this.currentVisiblePages = visiblePages;
    this.updateActivePageSnapshot();
    this.renderHeaderFooterEditOverlays();
    this.syncPageDetails();
  }

  private pageIndexFromPayload(payload: unknown): number | null {
    const value = typeof payload === 'object' && payload !== null && 'pageIndex' in payload
      ? (payload as { pageIndex?: unknown }).pageIndex
      : payload;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) return null;
    return value;
  }

  private setEditingPageIndex(pageIndex: number | null): void {
    if (this.editingPageIndex === pageIndex) return;
    this.editingPageIndex = pageIndex;
    this.updateActivePageSnapshot();
    // 눈금자는 순수 스크롤의 viewport fallback이 아니라 마지막 편집 focus를 따른다.
    // current-page-changed와 렌더 가시성은 위 active snapshot 계약을 계속 사용한다.
    this.eventBus.emit('focused-page-changed', pageIndex);
  }

  /** 캐럿·개체 선택과 스크롤이 공유하는 활성 페이지 판정·발행 관문. */
  private updateActivePageSnapshot(): void {
    const viewport = this.viewportManager.getViewportSize();
    const viewportCenterX = this.viewportManager.getScrollX() + viewport.width / 2;
    const viewportCenterY = this.viewportManager.getScrollY() + viewport.height / 2;
    const viewportPageIndex = this.currentVisiblePages.length > 0
      ? this.virtualScroll.getPageAtPoint(viewportCenterX, viewportCenterY)
      : null;
    const next = resolveActivePage({
      pageCount: this.virtualScroll.pageCount,
      visiblePages: this.currentVisiblePages,
      editingPageIndex: this.editingPageIndex,
      viewportPageIndex,
    });
    const snapshotChanged = !(
      next?.pageIndex === this.activePageSnapshot?.pageIndex
      && next?.source === this.activePageSnapshot?.source
    );

    this.activePageSnapshot = next;
    if (snapshotChanged) this.eventBus.emit('active-page-changed', next);
    // 전체 쪽 수·구역 쪽번호가 pagination으로 바뀔 수 있으므로 스크롤 외 갱신에서는
    // snapshot이 같아도 상태 표시줄 이벤트를 유지한다. 순수 스크롤 프레임은 쪽·쪽 수가
    // 그대로면 생략해 매 프레임 getPageInfo·DOM 쓰기를 피한다.
    if (next) {
      const pageCount = this.virtualScroll.pageCount;
      const key = `${next.pageIndex}|${pageCount}`;
      if (!this.scrollDrivenVisibleUpdate || key !== this.lastCurrentPageKey) {
        this.lastCurrentPageKey = key;
        this.eventBus.emit('current-page-changed', next.pageIndex, pageCount);
      }
    }
  }

  /** HF 타겟을 구역 첫 페이지에 가상 투영하고 실제 적용 쪽을 함께 표시한다. */
  private handleHeaderFooterModeChanged(payload: unknown): void {
    const state = parseHeaderFooterModeChanged(payload);
    if (state === 'none') {
      this.headerFooterEditState = null;
      this.removeHeaderFooterEditOverlays();
      return;
    }

    this.headerFooterEditState = state;
    if (!this.currentVisiblePages.includes(state.previewPage)) {
      const pageTop = this.virtualScroll.getPageOffset(state.previewPage);
      this.viewportManager.setScrollTop(Math.max(0, pageTop - this.virtualScroll.gap));
      this.updateVisiblePages();
      return;
    }
    this.renderHeaderFooterEditOverlays();
  }

  private renderHeaderFooterEditOverlays(force = false): void {
    const state = this.headerFooterEditState;
    if (!state || this.pages.length === 0) {
      this.removeHeaderFooterEditOverlays();
      return;
    }

    const desiredPages = new Set<number>();
    for (const pageIdx of this.canvasPool.activePages) {
      const page = this.pages[pageIdx];
      if (!page) continue;
      const isPreview = pageIdx === state.previewPage;
      let isAppliedPage = false;
      try {
        const target = this.wasm.getHeaderFooterEditTarget(pageIdx, state.mode === 'header');
        isAppliedPage = target.sectionIndex === state.sectionIdx && target.applyTo === state.applyTo;
      } catch {
        // 현재 렌더된 HF가 없는 쪽은 연관 표시 대상에서 뺀다.
      }
      if (!isPreview && !isAppliedPage) continue;
      desiredPages.add(pageIdx);

      const zoom = this.viewportManager.getZoom();
      // 문서 세대를 넣어 전체 갱신마다 대표 preview 를 한 번 다시 그린다 (스크롤은 재사용).
      const overlayKey = [
        state.mode,
        state.sectionIdx,
        state.applyTo,
        isPreview ? 'representative' : 'related',
        zoom,
        this.documentRenderGeneration,
      ].join(':');
      const selector = `[data-rhwp-hf-edit-page="${pageIdx}"]`;
      const existing = this.scrollContent.querySelector<HTMLElement>(selector);
      if (!force && existing?.dataset.hfOverlayKey === overlayKey) {
        this.applyPageBox(existing, pageIdx);
        continue;
      }
      if (existing) discardHeaderFooterEditOverlay(existing);

      const layer = document.createElement('div');
      layer.className = `hf-edit-surface-layer ${isPreview ? 'is-representative' : 'is-related'}`;
      layer.dataset.rhwpHfEditPage = String(pageIdx);
      layer.dataset.hfApplyTo = String(state.applyTo);
      layer.dataset.hfMode = state.mode;
      layer.dataset.hfOverlayKey = overlayKey;
      layer.setAttribute('aria-hidden', 'true');
      layer.style.width = `${page.width * zoom}px`;
      layer.style.height = `${page.height * zoom}px`;
      this.applyPageBox(layer, pageIdx);

      const band = resolveHeaderFooterBandBox(page, state.mode === 'header');
      if (isPreview) {
        // 밴드만 덮는 canvas 를 화면 배율 그대로 그린다 — 쪽 canvas 배율 상한과 무관하게 선명하다.
        const scale = regionRenderScale(zoom * (window.devicePixelRatio || 1));
        const { region, clipPath } = headerFooterPreviewRegion(band, zoom, scale);
        const previewCanvas = document.createElement('canvas');
        previewCanvas.className = 'hf-edit-preview-canvas';
        try {
          this.wasm.renderHeaderFooterEditPreviewRegionToCanvas(
            pageIdx,
            state.sectionIdx,
            state.mode === 'header',
            state.applyTo,
            previewCanvas,
            scale,
            region,
          );
          const cssPerDevice = zoom / scale;
          previewCanvas.style.left = `${region.x * cssPerDevice}px`;
          previewCanvas.style.top = `${region.y * cssPerDevice}px`;
          previewCanvas.style.width = `${previewCanvas.width * cssPerDevice}px`;
          previewCanvas.style.height = `${previewCanvas.height * cssPerDevice}px`;
          previewCanvas.style.clipPath = clipPath;
          layer.appendChild(previewCanvas);
        } catch (error) {
          console.error('[CanvasView] HF 대표 편집 preview 렌더링 실패:', error);
        }
      }

      layer.appendChild(createHeaderFooterGuideCorners(band, page, zoom));

      const region = document.createElement('div');
      region.className = `hf-edit-region ${isPreview ? 'is-representative' : 'is-related'}`;
      region.style.left = `${band.x * zoom}px`;
      region.style.top = `${band.y * zoom}px`;
      region.style.width = `${band.width * zoom}px`;
      region.style.height = `${band.height * zoom}px`;
      layer.appendChild(region);

      if (isPreview) {
        const kind = state.mode === 'header' ? '머리말' : '꼬리말';
        const badgeMetrics = resolveHeaderFooterBadgeMetrics(zoom);
        const badge = document.createElement('span');
        badge.className = 'hf-edit-badge';
        badge.textContent = `${kind}(${headerFooterApplyToLabel(state.applyTo)})`;
        badge.style.left = `${band.x * zoom}px`;
        badge.style.top = `${band.y * zoom}px`;
        badge.style.fontSize = `${badgeMetrics.fontSizePx}px`;
        badge.style.setProperty('--hf-edit-badge-gap', `${badgeMetrics.gapPx}px`);
        layer.appendChild(badge);
      }

      this.scrollContent.appendChild(layer);
    }
    this.scrollContent.querySelectorAll<HTMLElement>('[data-rhwp-hf-edit-page]')
      .forEach((element) => {
        const pageIdx = Number(element.dataset.rhwpHfEditPage);
        if (!desiredPages.has(pageIdx)) discardHeaderFooterEditOverlay(element);
      });
  }

  private removeHeaderFooterEditOverlays(): void {
    this.scrollContent.querySelectorAll<HTMLElement>('[data-rhwp-hf-edit-page]')
      .forEach(discardHeaderFooterEditOverlay);
  }

  /** 스크롤 중에는 다음 페이지의 선렌더를 idle time으로 미룬다. */
  private schedulePrefetchPages(pageIndices: readonly number[]): void {
    const candidateSet = new Set(pageIndices);
    for (const pageIdx of this.pendingPrefetchPages) {
      if (!candidateSet.has(pageIdx)) this.pendingPrefetchPages.delete(pageIdx);
    }
    for (const pageIdx of pageIndices) {
      if (!this.canvasPool.has(pageIdx)) this.pendingPrefetchPages.add(pageIdx);
    }
    if (this.pendingPrefetchPages.size === 0 || this.deferredPrefetchTask !== null) return;

    const run = () => {
      this.deferredPrefetchTask = null;
      if (this.disposed || this.pendingPrefetchPages.size === 0) return;
      // 편집 중에는 곧 무효화될 화면 밖 canvas를 만들지 않는다.
      if (performance.now() - this.lastMutationTime < 150) {
        this.deferredPrefetchTask = { kind: 'timeout', id: window.setTimeout(run, 150) };
        return;
      }
      // 한 callback에 한 쪽만 그려 다음 입력/paint가 실행될 기회를 준다.
      const pageIdx = this.pendingPrefetchPages.values().next().value;
      if (pageIdx !== undefined) {
        this.pendingPrefetchPages.delete(pageIdx);
        if (!this.canvasPool.has(pageIdx)) this.renderPage(pageIdx);
      }
      this.schedulePrefetchPages(Array.from(this.pendingPrefetchPages));
    };
    const idleWindow = window as IdleCallbackWindow;
    if (typeof idleWindow.requestIdleCallback === 'function') {
      this.deferredPrefetchTask = {
        kind: 'idle',
        id: idleWindow.requestIdleCallback(run, { timeout: 1000 }),
      };
      return;
    }
    this.deferredPrefetchTask = {
      kind: 'timeout',
      id: window.setTimeout(run, 250),
    };
  }

  private cancelPendingPrefetch(): void {
    const task = this.deferredPrefetchTask;
    this.deferredPrefetchTask = null;
    this.pendingPrefetchPages.clear();
    if (!task) return;

    if (task.kind === 'idle') {
      (window as IdleCallbackWindow).cancelIdleCallback?.(task.id);
    } else {
      clearTimeout(task.id);
    }
  }

  /** 렌더된 페이지 하나의 canvas/overlay/타이머를 모두 해제한다. */
  private releaseRenderedPage(pageIdx: number): void {

    this.cancelTextEditStaticLayerVerification(pageIdx);
    this.pageRenderer.cancelReRender(pageIdx);
    this.pageRenderer.removePageLayers(this.scrollContent, pageIdx);
    this.pageRenderer.releasePageDiagnostics(pageIdx);
    const headerFooterOverlay = this.scrollContent.querySelector<HTMLElement>(
      `[data-rhwp-hf-edit-page="${pageIdx}"]`,
    );
    if (headerFooterOverlay) discardHeaderFooterEditOverlay(headerFooterOverlay);
    this.removeGridOverlay(pageIdx);
    this.removePageDetail(pageIdx);
    this.canvasPool.release(pageIdx);
  }

  /** 단일 페이지를 렌더링한다 */
  private renderPage(pageIdx: number): void {
    const canvas = this.canvasPool.acquire(pageIdx);
    if (!canvas.parentElement) {
      this.scrollContent.appendChild(canvas);
    }
    if (!this.renderCanvas(pageIdx, canvas)) {
      this.releaseFailedRender(pageIdx);
    }
  }

  /**
   * 렌더에 실패한 쪽의 canvas 를 pool 에 돌려준다. 이전 렌더가 건 지연 재렌더/검증 타이머가
   * 그 canvas 를 붙잡고 있으므로 먼저 끊는다 — 그대로 두면 다른 쪽이 재사용한 같은 canvas
   * 에 이 쪽을 덧그린다.
   */
  private releaseFailedRender(pageIdx: number): void {
    this.cancelTextEditStaticLayerVerification(pageIdx);
    this.pageRenderer.cancelReRender(pageIdx);
    this.canvasPool.release(pageIdx);
  }

  /** 기존 canvas를 유지한 채 페이지 내용을 다시 그린다. */
  private renderCanvas(
    pageIdx: number,
    canvas: HTMLCanvasElement,
    renderContext: PageRenderContext = {},
  ): boolean {
    const zoom = this.viewportManager.getZoom();
    const rawDpr = window.devicePixelRatio || 1;

    const pageInfo = this.pages[pageIdx];
    if (!pageInfo) {
      console.error(`[CanvasView] 페이지 ${pageIdx} 정보가 없습니다`);
      return false;
    }
    // iOS/WebKit과 GPU surface가 감당하기 어려운 물리 픽셀 수를 중앙 정책으로 제한한다.
    const renderScale = clampRenderScale(pageInfo, zoom * rawDpr);
    const dpr = renderScale / (zoom > 0 ? zoom : 1);

    // Canvas를 DOM에 추가하고 위치를 설정한다
    canvas.style.top = `${this.virtualScroll.getPageOffset(pageIdx)}px`;

    // 그리드 모드: 고정 left 좌표, 단일 열: CSS 중앙 정렬
    const pageLeft = this.virtualScroll.getPageLeft(pageIdx);
    if (pageLeft >= 0) {
      canvas.style.left = `${pageLeft}px`;
      canvas.style.transform = 'none';
    } else {
      canvas.style.left = '50%';
      canvas.style.transform = 'translateX(-50%)';
    }
    canvas.style.transformOrigin = '';

    // WASM이 Canvas 크기를 자동 설정한다 (물리 픽셀 = 페이지크기 × zoom × DPR)
    let renderResult: PageRenderResult = { needsTextEditStaticLayerVerification: false };
    let renderedCanvas = canvas;
    const rendererDecisionKey = this.activeRendererDecisionKey;
    try {
      renderResult = this.pageRenderer.renderPage(
        pageIdx,
        canvas,
        renderScale,
        zoom,
        dpr,
        renderContext,
        pageInfo,
      );
      if (renderResult.renderedCanvas && renderResult.renderedCanvas !== canvas) {
        renderedCanvas = renderResult.renderedCanvas;
        this.canvasPool.replace(pageIdx, canvas, renderedCanvas);
      }
      const canvaskitDiagnostics = this.pageRenderer.getBackend() === 'canvaskit'
        ? this.pageRenderer.getCanvasKitRenderDiagnostics(pageIdx)
        : null;
      if (
        canvaskitDiagnostics
        && !canvaskitDiagnostics.passesRuntimeReadinessGate
        && rendererDecisionKey
        && this.rendererSession.isAutoRequest()
      ) {
        const details = [
          `blockers=${canvaskitDiagnostics.readinessBlockers.join(',') || 'unknown'}`,
          canvaskitDiagnostics.lastRenderError
            ? `error=${canvaskitDiagnostics.lastRenderError}`
            : null,
          canvaskitDiagnostics.lastUnexpectedUnsupportedOps.length > 0
            ? `unexpectedOps=${canvaskitDiagnostics.lastUnexpectedUnsupportedOps.join(',')}`
            : null,
        ].filter((detail): detail is string => detail !== null).join('; ');
        this.pageRenderer.removePageLayers(this.scrollContent, pageIdx);
        this.removeGridOverlay(pageIdx);
        this.removePageDetail(pageIdx);
        this.scheduleCanvasKitFallback(
          new Error(`CanvasKit runtime readiness gate failed (${details})`),
          rendererDecisionKey,
          'runtime',
        );
        return false;
      }
    } catch (e) {
      // trap 이면 이 쪽을 마지막으로 그린 canvas 를 지운 채로 두지 않는다.
      if (reportEngineTrap(e)) return canvas.dataset.rhwpPageIndex === String(pageIdx);
      console.error(`[CanvasView] 페이지 ${pageIdx} 렌더링 실패:`, e);
      this.pageRenderer.removePageLayers(this.scrollContent, pageIdx);
      this.removeGridOverlay(pageIdx);
      this.removePageDetail(pageIdx);
      if (this.pageRenderer.getBackend() === 'canvaskit' && rendererDecisionKey) {
        this.scheduleCanvasKitFallback(e, rendererDecisionKey, 'resource');
      }
      return false;
    }

    // CSS 표시 크기 = 물리 픽셀 / DPR (= 페이지크기 × zoom)
    renderedCanvas.style.width = `${renderedCanvas.width / dpr}px`;
    renderedCanvas.style.height = `${renderedCanvas.height / dpr}px`;
    renderedCanvas.style.transformOrigin = '';
    renderedCanvas.dataset.rhwpRenderedZoom = String(zoom);
    renderedCanvas.dataset.rhwpPageIndex = String(pageIdx);
    this.renderGridOverlay(pageIdx, renderedCanvas);
    // detail 층은 쪽을 덮으므로 쪽을 그린 같은 작업 안에서 함께 다시 그린다. 스크롤로 새로
    // 들어온 쪽은 스크롤이 멎은 뒤 syncPageDetails 가 그린다.
    if (this.pageDetails.has(pageIdx) || !this.scrollDrivenVisibleUpdate) {
      this.renderPageDetail(pageIdx, renderedCanvas);
    }
    if (renderResult.needsTextEditStaticLayerVerification) {
      this.scheduleTextEditStaticLayerVerification(pageIdx);
    } else if (renderContext.reason !== 'text-edit') {
      this.cancelTextEditStaticLayerVerification(pageIdx);
    }
    return true;
  }

  private scheduleCanvasKitFallback(
    error: unknown,
    expectedDecisionKey: string,
    kind: 'resource' | 'runtime',
  ): void {
    if (this.rendererFallbackScheduled) return;
    const selection = kind === 'resource'
      ? this.rendererSession.fallbackFromResourceFailure(error, expectedDecisionKey)
      : this.rendererSession.fallbackFromRuntimeFailure(error, expectedDecisionKey);
    if (!selection) return;
    this.rendererFallbackScheduled = true;
    queueMicrotask(() => {
      this.rendererFallbackScheduled = false;
      if (this.disposed || !this.rendererSession.isCurrent(selection)) return;
      this.applyRendererSelection(selection);

      this.cancelTextEditStaticLayerVerification();
      this.releaseAllRenderedPages();
      this.pageRenderer.cancelAll();
      this.updateVisiblePages();
    });
  }

  /**
   * 창이 다른 배율의 화면으로 옮겨 가면(크기 변화 없이) 쪽 배치를 새 장치 픽셀에 다시 맞춘다.
   * resolution 미디어 쿼리는 현재 배율에서 벗어날 때 한 번 바뀌므로 매번 새 배율로 다시 건다.
   */
  private watchDevicePixelRatio(): () => void {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {};
    let query: MediaQueryList | null = null;
    const onChange = (): void => {
      arm();
      if (!this.disposed) this.onViewportResize();
    };
    const arm = (): void => {
      query?.removeEventListener('change', onChange);
      query = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
      query.addEventListener('change', onChange);
    };
    arm();
    return () => {
      query?.removeEventListener('change', onChange);
      query = null;
    };
  }

  /**
   * GPU 프로세스가 재시작하거나 GPU 메모리를 회수하면 Chromium 은 2D 컨텍스트를 잃었다가
   * 빈 비트맵으로 되살린다. pool 에 남은 쪽은 다시 그려지지 않으므로 복원된 쪽을 한 프레임에
   * 모아 다시 그린다. contextrestored 는 버블링하지 않아 캡처 단계에서 받는다.
   */
  private watchCanvasContextRestore(): () => void {
    const restoredPages = new Set<number>();
    let frame: number | null = null;
    const flush = (): void => {
      frame = null;
      // trap 한 엔진은 다시 그릴 수 없다. 마지막으로 그린 쪽은 engine-trap 경로가 지킨다.
      if (this.disposed || engineTrap()) return;
      const pages = Array.from(restoredPages);
      restoredPages.clear();
      for (const pageIdx of pages) {
        if (!this.canvasPool.has(pageIdx)) continue;
        this.refreshInvalidatedPageNow(pageIdx, { reason: 'unknown', allowStaticOverlayReuse: false });
      }
      // 머리말/꼬리말 편집 미리보기 캔버스도 같은 순간에 비워진다.
      this.renderHeaderFooterEditOverlays(true);
    };
    const onRestored = (event: Event): void => {
      const canvas = event.target;
      if (this.disposed || !(canvas instanceof HTMLCanvasElement)) return;
      // 쪽 캔버스와 그 위 개체 레이어 캔버스는 쪽 단위로 함께 다시 그린다.
      const owner = canvas.closest<HTMLElement>(
        '[data-rhwp-page-index], [data-rhwp-overlay-page], [data-rhwp-detail-page]',
      );
      const pageIdx = Number(
        owner?.dataset.rhwpPageIndex ?? owner?.dataset.rhwpOverlayPage ?? owner?.dataset.rhwpDetailPage,
      );
      if (Number.isInteger(pageIdx) && this.canvasPool.has(pageIdx)) restoredPages.add(pageIdx);
      frame ??= requestAnimationFrame(flush);
    };
    this.scrollContent.addEventListener('contextrestored', onRestored, true);
    return () => {
      this.scrollContent.removeEventListener('contextrestored', onRestored, true);
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null;
      restoredPages.clear();
    };
  }

  /** 뷰포트 리사이즈 처리 */
  private onViewportResize(): void {
    // 접기/펼치기 전이 프레임은 inset rAF 루프가 맡는다. ResizeObserver 와
    // 겹치면 같은 프레임에 레이아웃을 두 번 탄다.
    if (
      document.body.classList.contains('ag-sidebar-animating')
      && !document.body.classList.contains('ag-sidebar-resizing')
    ) {
      return;
    }
    if (this.sidebarInsetIsMoving()) {
      this.recenterHorizontally();
      return;
    }
    const nextViewport = this.viewportManager.getViewportSize();
    if (this.pages.length === 0) {
      this.layoutViewportSize = nextViewport;
      this.updateVisiblePages();
      return;
    }

    const previousViewport = this.layoutViewportSize;
    const canPreserveCenter = previousViewport.width > 0 && previousViewport.height > 0;
    const scrollLeft = this.viewportManager.getScrollX();
    const scrollTop = this.viewportManager.getScrollY();
    // pan-space 가 viewport 폭 함수라서 폭이 바뀌면 pageLeft 도 함께 변한다.
    // 사이드바 inset 애니메이션 중이거나 이전에 가운데였으면 X 를 강제 재중앙 정렬한다.
    const forceCenterX = document.body.classList.contains('ag-sidebar-animating');
    const prevCenteredScrollLeft = canPreserveCenter
      ? this.virtualScroll.getCenteredScrollLeft(previousViewport.width)
      : 0;
    const wasHorizontallyCentered = canPreserveCenter
      && Math.abs(scrollLeft - prevCenteredScrollLeft) <= 2;
    const focusPage = canPreserveCenter
      ? this.virtualScroll.getPageAtPoint(
        scrollLeft + previousViewport.width / 2,
        scrollTop + previousViewport.height / 2,
      )
      : 0;
    const oldBox = canPreserveCenter
      ? this.getZoomPageBox(focusPage, previousViewport.width)
      : null;

    // 그리드 모드에서 열 수가 바뀔 수 있으므로 레이아웃 재계산
    const wasGrid = this.virtualScroll.isGridMode();
    this.recalcLayout();
    const isGrid = this.virtualScroll.isGridMode();

    if (oldBox) {
      const newBox = this.getZoomPageBox(focusPage, nextViewport.width);
      const nextScroll = calculateAnchoredScroll(
        oldBox,
        newBox,
        {
          width: previousViewport.width,
          height: previousViewport.height,
          scrollLeft,
          scrollTop,
        },
        CENTER_ZOOM_ANCHOR,
        nextViewport,
      );
      this.viewportManager.setScrollLeft(
        forceCenterX || wasHorizontallyCentered
          ? this.virtualScroll.getCenteredScrollLeft(nextViewport.width)
          : nextScroll.scrollLeft,
      );
      this.viewportManager.setScrollTop(nextScroll.scrollTop);
    } else {
      this.viewportManager.setScrollLeft(
        this.virtualScroll.getCenteredScrollLeft(nextViewport.width),
      );
    }

    // 이미 pool 에 있는 canvas 는 renderPage 를 다시 타지 않으므로
    // pageLeft 변경을 style.left 에 직접 반영해야 한다 (사이드바 close 시 핵심).
    this.repositionRenderedPages();

    if (wasGrid || isGrid) {
      // 그리드 관련 변경 시 전체 재렌더링

      this.cancelTextEditStaticLayerVerification();
      this.releaseAllRenderedPages();
      this.pageRenderer.cancelAll();
    }
    this.updateVisiblePages();
  }

  /** 에이전트 사이드바 inset 전환 직후 용지를 남은 폭 기준으로 가운데 정렬한다. */
  recenterHorizontally(): void {
    if (this.pages.length === 0) return;
    this.viewportManager.syncViewportSize();
    this.recalcLayout();
    const { width } = this.viewportManager.getViewportSize();
    if (width <= 0) return;
    this.viewportManager.setScrollLeft(this.virtualScroll.getCenteredScrollLeft(width));
    this.repositionRenderedPages();
    // 드래그/전이 중에는 페이지 재렌더·프리페치를 미룬다.
    if (!this.sidebarInsetIsMoving()) this.updateVisiblePages();
  }

  private sidebarInsetIsMoving(): boolean {
    const { classList } = document.body;
    return classList.contains('ag-sidebar-resizing') || classList.contains('ag-sidebar-animating');
  }

  /**
   * 가상 스크롤 좌표가 바뀐 뒤, 이미 렌더된 페이지/오버레이의 DOM 위치를 갱신한다.
   * updateVisiblePages 는 pool hit 시 style.left 를 건드리지 않는다.
   */
  private repositionRenderedPages(): void {
    for (const pageIdx of this.canvasPool.activePages) {
      const canvas = this.canvasPool.getCanvas(pageIdx);
      if (canvas) this.applyPageBox(canvas, pageIdx);
    }
    this.forEachRenderedPageOverlay((element, pageIdx) => this.applyPageBox(element, pageIdx));
  }

  private forEachRenderedPageOverlay(
    callback: (element: HTMLElement, pageIdx: number) => void,
  ): void {
    this.scrollContent
      .querySelectorAll<HTMLElement>(
        '[data-rhwp-overlay-page], [data-rhwp-grid-page], [data-rhwp-hf-edit-page], [data-rhwp-detail-page]',
      )
      .forEach((element) => {
        const rawPage = element.dataset.rhwpOverlayPage
          ?? element.dataset.rhwpGridPage
          ?? element.dataset.rhwpHfEditPage
          ?? element.dataset.rhwpDetailPage;
        const pageIdx = Number(rawPage);
        if (Number.isInteger(pageIdx) && this.canvasPool.has(pageIdx)) {
          callback(element, pageIdx);
        }
      });
  }

  private applyPageBox(element: HTMLElement, pageIdx: number): void {
    element.style.top = `${this.virtualScroll.getPageOffset(pageIdx)}px`;
    const pageLeft = this.virtualScroll.getPageLeft(pageIdx);
    const zoomPreview = element.style.transformOrigin === 'top left';
    if (pageLeft >= 0) {
      element.style.left = `${pageLeft}px`;
      if (!zoomPreview) {
        element.style.transform = 'none';
        element.style.transformOrigin = '';
      }
    } else {
      element.style.left = '50%';
      if (!zoomPreview) {
        element.style.transform = 'translateX(-50%)';
        element.style.transformOrigin = '';
      }
    }
  }

  private getZoomPageBox(pageIdx: number, viewportWidth: number): ZoomPageBox {
    const layoutWidth = Math.max(viewportWidth, this.virtualScroll.getTotalWidth());
    return {
      left: this.virtualScroll.getPageLeftResolved(pageIdx, layoutWidth),
      top: this.virtualScroll.getPageOffset(pageIdx),
      width: this.virtualScroll.getPageWidth(pageIdx),
      height: this.virtualScroll.getPageHeight(pageIdx),
    };
  }

  /** 줌 변경 처리 */
  private onZoomChanged(zoom: number, anchor: ZoomAnchor): void {
    if (this.pages.length === 0) return;

    const scrollTop = this.viewportManager.getScrollY();
    const scrollLeft = this.viewportManager.getScrollX();
    const { width: vpWidth, height: vpHeight } = this.viewportManager.getViewportSize();
    const anchorDocumentX = scrollLeft + vpWidth * anchor.x;
    const anchorDocumentY = scrollTop + vpHeight * anchor.y;
    const focusPage = this.virtualScroll.getPageAtPoint(anchorDocumentX, anchorDocumentY);
    const oldBox = this.getZoomPageBox(focusPage, vpWidth);

    this.recalcLayout();

    const newBox = this.getZoomPageBox(focusPage, vpWidth);
    const nextScroll = calculateAnchoredScroll(
      oldBox,
      newBox,
      {
        width: vpWidth,
        height: vpHeight,
        scrollLeft,
        scrollTop,
      },
      anchor,
    );
    this.viewportManager.setScrollLeft(nextScroll.scrollLeft);
    this.viewportManager.setScrollTop(nextScroll.scrollTop);

    this.eventBus.emit('zoom-level-display', zoom);

    if (this.viewportManager.isZoomAnimating()) {

      this.cancelTextEditStaticLayerVerification();
      this.cancelPendingPrefetch();
      this.updateRenderedPageZoomPreview();
      return;
    }

    // 모든 Canvas 재렌더링

    this.cancelTextEditStaticLayerVerification();
    this.releaseAllRenderedPages();
    this.pageRenderer.cancelAll();
    this.updateVisiblePages();
  }

  private updateRenderedPageZoomPreview(): void {
    const zoom = this.viewportManager.getZoom();
    const scaleByPage = new Map<number, number>();
    for (const pageIdx of this.canvasPool.activePages) {
      const canvas = this.canvasPool.getCanvas(pageIdx);
      if (!canvas) continue;
      const renderedZoom = Number(canvas.dataset.rhwpRenderedZoom);
      const scale = Number.isFinite(renderedZoom) && renderedZoom > 0
        ? zoom / renderedZoom
        : 1;
      scaleByPage.set(pageIdx, scale);
      this.applyZoomPreviewBox(canvas, pageIdx, scale);
    }
    this.forEachRenderedPageOverlay((element, pageIdx) => {
      const scale = scaleByPage.get(pageIdx);
      if (scale !== undefined) this.applyZoomPreviewBox(element, pageIdx, scale);
    });
  }

  private applyZoomPreviewBox(element: HTMLElement, pageIdx: number, scale: number): void {
    element.style.top = `${this.virtualScroll.getPageOffset(pageIdx)}px`;
    const pageLeft = this.virtualScroll.getPageLeft(pageIdx);
    if (pageLeft >= 0) {
      element.style.left = `${pageLeft}px`;
      element.style.transform = `scale(${scale})`;
      element.style.transformOrigin = 'top left';
    } else {
      element.style.left = '50%';
      element.style.transform = `translateX(-50%) scale(${scale})`;
      element.style.transformOrigin = 'top center';
    }
  }

  /** 편집 후 보이는 페이지를 재렌더링한다 */
  refreshPages(): void {
    if (this.pages.length === 0 || engineTrap()) return;

    // 페이지 정보 재수집 (페이지 수/크기가 변경될 수 있음)
    let pages: PageInfo[] | null;
    try {
      pages = this.collectPageInfo(this.wasm.pageCount);
    } catch (error) {
      if (!reportEngineTrap(error)) throw error;
      pages = null;
    }
    if (!pages) return;
    this.pages = pages;
    this.documentRenderGeneration += 1;

    // 용지 폭이 바뀌어 좌우 여백(pan 공간)이 생기거나 사라지면 전체 폭과 쪽 left 가 함께
    // 움직인다. 가운데 보던 화면은 새 폭에서도 가운데로 옮긴다 — 그대로 두면 뷰포트보다
    // 넓어진 용지가 통째로 오른쪽 화면 밖으로 밀려 문서가 사라진 것처럼 보인다.
    const previousTotalWidth = this.virtualScroll.getTotalWidth();
    const wasHorizontallyCentered = Math.abs(
      this.viewportManager.getScrollX()
        - this.virtualScroll.getCenteredScrollLeft(this.layoutViewportSize.width),
    ) <= 2;

    this.recalcLayout();
    // 문서가 짧아졌으면 스크롤을 새 끝 안으로 먼저 당긴다. 그대로 두면 아래 쪽 창 계산이
    // 끝 너머를 보고 모든 쪽을 해제해, scroll 이벤트가 올 때까지 화면이 빈다.
    this.viewportManager.clampScrollToContent(
      this.virtualScroll.getTotalWidth(),
      this.virtualScroll.getTotalHeight(),
    );
    if (wasHorizontallyCentered && this.virtualScroll.getTotalWidth() !== previousTotalWidth) {
      this.viewportManager.setScrollLeft(
        this.virtualScroll.getCenteredScrollLeft(this.layoutViewportSize.width),
      );
    }

    this.cancelTextEditStaticLayerVerification();
    this.pageRenderer.cancelAll();

    // 이전 문서 상태로 그려진 페이지들. canvas 를 버리지 않고 제자리에서 다시
    // 그린다 — DOM 교체로 인한 깜빡임과 이미지 재디코드 재렌더 사이클을 피한다.
    const stalePages = new Set(this.canvasPool.activePages);
    for (const pageIdx of stalePages) {
      if (pageIdx >= this.pages.length) {
        // 문서가 짧아져 사라진 페이지
        this.releaseRenderedPage(pageIdx);
        stalePages.delete(pageIdx);
      }
    }

    // 화면에 새로 들어온 페이지를 채우고, 범위를 벗어난 페이지를 해제한다.
    this.updateVisiblePages();

    const visibleSet = new Set(this.currentVisiblePages);
    for (const pageIdx of stalePages) {
      if (!this.canvasPool.has(pageIdx)) continue; // updateVisiblePages 가 이미 해제
      if (visibleSet.has(pageIdx)) {
        const canvas = this.canvasPool.getCanvas(pageIdx)!;
        if (!this.renderCanvas(pageIdx, canvas)) {
          this.releaseFailedRender(pageIdx);
        }
      } else {
        // 화면 밖 선렌더 페이지는 지금 다시 그리지 않는다 — idle 프리페치가 다시 채운다.
        this.releaseRenderedPage(pageIdx);
      }
    }

    const scrollY = this.viewportManager.getScrollY();
    const { height: vpHeight } = this.viewportManager.getViewportSize();
    this.schedulePrefetchPages(
      this.virtualScroll
        .getPrefetchPages(scrollY, vpHeight)
        .filter((pageIdx) => !visibleSet.has(pageIdx)),
    );
  }

  private refreshInvalidatedPageNow(pageIndex: number, renderContext: PageRenderContext): void {
    if (this.pages.length === 0 || engineTrap()) return;

    let pageCount: number;
    try {
      pageCount = this.wasm.pageCount;
    } catch (error) {
      if (reportEngineTrap(error)) return;
      throw error;
    }
    if (pageCount !== this.pages.length || pageIndex >= pageCount) {
      this.refreshPages();
      return;
    }

    const canvas = this.canvasPool.getCanvas(pageIndex);
    if (!canvas) {
      this.updateVisiblePages();
      return;
    }

    if (!this.renderCanvas(pageIndex, canvas, renderContext)) {
      this.releaseFailedRender(pageIndex);
      this.updateVisiblePages();
      return;
    }
    this.renderHeaderFooterEditOverlays(true);
  }

  private scheduleTextEditStaticLayerVerification(pageIndex: number): void {
    this.cancelTextEditStaticLayerVerification(pageIndex);
    const timer = setTimeout(() => {
      this.textEditStaticLayerVerifyTimers.delete(pageIndex);
      this.refreshInvalidatedPageNow(pageIndex, { reason: 'unknown', allowStaticOverlayReuse: false });
    }, TEXT_EDIT_STATIC_LAYER_VERIFY_DELAY_MS);
    this.textEditStaticLayerVerifyTimers.set(pageIndex, timer);
  }

  private cancelTextEditStaticLayerVerification(pageIndex?: number): void {
    if (typeof pageIndex === 'number') {
      const timer = this.textEditStaticLayerVerifyTimers.get(pageIndex);
      if (timer) clearTimeout(timer);
      this.textEditStaticLayerVerifyTimers.delete(pageIndex);
      return;
    }

    for (const timer of this.textEditStaticLayerVerifyTimers.values()) {
      clearTimeout(timer);
    }
    this.textEditStaticLayerVerifyTimers.clear();
  }

  /** 리소스를 정리한다 */
  private reset(): void {
    const hadActivePage = this.activePageSnapshot !== null;
    const hadFocusedPage = this.editingPageIndex !== null;
    this.cancelScheduledMutationRefresh();

    this.cancelTextEditStaticLayerVerification();
    this.cancelPendingPrefetch();
    this.pageRenderer.cancelAll();
    this.releaseAllRenderedPages();
    this.currentVisiblePages = [];
    this.editingPageIndex = null;
    this.activePageSnapshot = null;
    if (hadActivePage) this.eventBus.emit('active-page-changed', null);
    if (hadFocusedPage) this.eventBus.emit('focused-page-changed', null);
    this.headerFooterEditState = null;
    this.pages = [];
    this.scrollContent.replaceChildren();
  }

  private releaseAllRenderedPages(): void {
    // pool 로 돌아가는 canvas 를 붙잡은 지연 재렌더가 남지 않게 먼저 모두 끊는다.
    this.pageRenderer.cancelAll();
    this.pageRenderer.resetImageRetryState();
    this.pageRenderer.removeAllPageLayers(this.scrollContent);
    this.removeHeaderFooterEditOverlays();
    this.removeAllGridOverlays();
    this.clearPageDetails();
    this.canvasPool.releaseAll();
  }

  /**
   * 요청 배율이 쪽 canvas 배율 상한을 넘으면 detail 배율을, 아니면 null 을 돌려준다.
   * Canvas2D 와 영역 렌더를 지원하는 엔진에서만 쓴다.
   */
  private pageDetailScale(pageIdx: number): number | null {
    const page = this.pages[pageIdx];
    if (
      !page
      || engineTrap()
      || this.pageRenderer.getBackend() !== 'canvas2d'
      || !this.wasm.supportsPageRegionRender
    ) {
      return null;
    }
    const requested = this.viewportManager.getZoom() * (window.devicePixelRatio || 1);
    const scale = regionRenderScale(requested);
    return scale > clampRenderScale(page, requested) * PAGE_DETAIL_MIN_GAIN ? scale : null;
  }

  private pageDetailPlan(pageIdx: number): PageDetailPlan | null {
    const scale = this.pageDetailScale(pageIdx);
    const page = this.pages[pageIdx];
    if (scale === null || !page) return null;
    const { width, height } = this.viewportManager.getViewportSize();
    return planPageDetail({
      pageWidth: page.width,
      pageHeight: page.height,
      pageLeft: this.virtualScroll.getPageLeftResolved(pageIdx, this.virtualScroll.getTotalWidth()),
      pageTop: this.virtualScroll.getPageOffset(pageIdx),
      zoom: this.viewportManager.getZoom(),
      scale,
      viewport: {
        left: this.viewportManager.getScrollX(),
        top: this.viewportManager.getScrollY(),
        width,
        height,
      },
    });
  }

  /** 쪽 canvas 를 덮는 detail 층을 지금 화면에 맞춰 다시 그린다. 필요 없으면 지운다. */
  private renderPageDetail(pageIdx: number, pageCanvas: HTMLCanvasElement): void {
    const plan = this.pageDetailPlan(pageIdx);
    if (!plan) {
      this.removePageDetail(pageIdx);
      return;
    }
    try {
      this.pageDetails.show(pageIdx, plan, pageCanvas, (canvas) => {
        this.pageRenderer.renderPageRegion(pageIdx, canvas, plan.scale, plan.region);
      });
    } catch (error) {
      if (!reportEngineTrap(error)) {
        console.error(`[CanvasView] 페이지 ${pageIdx} 확대 영역 렌더링 실패:`, error);
      }
    }
  }

  /**
   * 화면을 벗어난 쪽의 detail 층은 바로 지우고, 보이는 영역을 덮지 못한 쪽은 스크롤이 멎은 뒤
   * 다시 그린다. 그 사이에는 배율 상한으로 그린 쪽 canvas 가 보인다.
   */
  private syncPageDetails(): void {
    if (this.viewportManager.isZoomAnimating()) return;
    const visible = new Set(this.currentVisiblePages);
    for (const pageIdx of this.pageDetails.pages) {
      if (!visible.has(pageIdx) || !this.pageDetailPlan(pageIdx)) this.removePageDetail(pageIdx);
    }
    const stale = this.currentVisiblePages.some((pageIdx) => this.pageDetailIsStale(pageIdx));
    if (!stale) return;
    if (this.pageDetailTimer !== null) clearTimeout(this.pageDetailTimer);
    this.pageDetailTimer = setTimeout(() => {
      this.pageDetailTimer = null;
      if (this.disposed || this.viewportManager.isZoomAnimating()) return;
      for (const pageIdx of this.currentVisiblePages) {
        const canvas = this.canvasPool.getCanvas(pageIdx);
        if (!canvas || !this.pageDetailIsStale(pageIdx)) continue;
        this.renderPageDetail(pageIdx, canvas);
      }
    }, PAGE_DETAIL_SCROLL_IDLE_MS);
  }

  private pageDetailIsStale(pageIdx: number): boolean {
    if (!this.canvasPool.has(pageIdx)) return false;
    const plan = this.pageDetailPlan(pageIdx);
    return plan !== null && !this.pageDetails.covers(pageIdx, plan);
  }

  /** 지연 그림 재렌더가 쪽 층을 다시 그렸다. 그 쪽의 detail 층도 다음 그리기 전에 따라 그린다. */
  private queuePageDetailRepaint(pageIdx: number): void {
    if (!this.pageDetails.has(pageIdx)) return;
    this.pageDetailRepaintPages.add(pageIdx);
    this.pageDetailRepaintFrame ??= requestAnimationFrame(() => {
      this.pageDetailRepaintFrame = null;
      const pages = Array.from(this.pageDetailRepaintPages);
      this.pageDetailRepaintPages.clear();
      // 확대 전환 중에는 쪽 층이 이전 배율 미리보기다. 전환이 끝나면 모두 다시 그린다.
      if (this.viewportManager.isZoomAnimating()) return;
      for (const page of pages) {
        const canvas = this.canvasPool.getCanvas(page);
        if (canvas && this.pageDetails.has(page) && !engineTrap()) this.renderPageDetail(page, canvas);
      }
    });
  }

  private removePageDetail(pageIdx: number): void {
    this.pageDetailRepaintPages.delete(pageIdx);
    this.pageDetails.remove(pageIdx);
  }

  private clearPageDetails(): void {
    if (this.pageDetailTimer !== null) clearTimeout(this.pageDetailTimer);
    this.pageDetailTimer = null;
    if (this.pageDetailRepaintFrame !== null) cancelAnimationFrame(this.pageDetailRepaintFrame);
    this.pageDetailRepaintFrame = null;
    this.pageDetailRepaintPages.clear();
    this.pageDetails.removeAll();
  }

  private refreshGridOverlays(): void {
    this.removeAllGridOverlays();
    for (const pageIdx of this.canvasPool.activePages) {
      const canvas = this.canvasPool.getCanvas(pageIdx);
      if (canvas) this.renderGridOverlay(pageIdx, canvas);
    }
  }

  private renderGridOverlay(pageIdx: number, canvas: HTMLCanvasElement): void {
    this.removeGridOverlay(pageIdx);
    const settings = getGridViewSettings();
    if (!settings.visible) return;

    const pageInfo = this.pages[pageIdx];
    if (!pageInfo) return;

    // detail 층이 쪽을 덮는 배율에서는 글 뒤 격자도 그 위에 둔다.
    const aboveDetail = this.pageDetailScale(pageIdx) !== null;
    const overlay = createGridOverlay(
      pageIdx,
      pageInfo,
      this.viewportManager.getZoom(),
      settings,
      aboveDetail,
    );
    applyGridOverlayBox(overlay, canvas);
    this.scrollContent.appendChild(overlay);
    const elements = [overlay];

    const clipCorners = createGridClipCornerOverlay(
      pageIdx,
      pageInfo,
      this.viewportManager.getZoom(),
      settings,
      aboveDetail,
    );
    if (clipCorners) {
      applyGridOverlayBox(clipCorners, canvas);
      this.scrollContent.appendChild(clipCorners);
      elements.push(clipCorners);
    }
    this.gridOverlaysByPage.set(pageIdx, elements);
  }

  private removeGridOverlay(pageIdx: number): void {
    for (const element of this.gridOverlaysByPage.get(pageIdx) ?? []) {
      element.remove();
    }
    this.gridOverlaysByPage.delete(pageIdx);
  }

  private removeAllGridOverlays(): void {
    for (const elements of this.gridOverlaysByPage.values()) {
      for (const element of elements) element.remove();
    }
    this.gridOverlaysByPage.clear();
  }

  /** 전체 정리 */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.subsecondRevisionWatcher.stop();
    this.rendererSelectionEpoch += 1;
    this.documentLoadPrepared = false;
    this.cancelAutoRendererReselection();
    this.reset();
    this.pageRenderer.dispose();
    this.rendererSession.dispose();
    this.viewportManager.detach();
    for (const unsub of this.unsubscribers) {
      unsub();
    }
    this.unsubscribers = [];
  }

  getVirtualScroll(): VirtualScroll {
    return this.virtualScroll;
  }

  getViewportManager(): ViewportManager {
    return this.viewportManager;
  }

  getRenderBackend(): RenderBackend {
    return this.pageRenderer.getBackend();
  }

  getRendererSessionDiagnostics(): RendererSessionDiagnostics | null {
    return this.rendererSession.diagnostics();
  }

  getCanvasKitRenderDiagnostics(pageIndex: number): CanvasKitRenderDiagnostics | null {
    return this.pageRenderer.getCanvasKitRenderDiagnostics(pageIndex);
  }

  getCurrentCanvasKitRenderDiagnostics(): CanvasKitRenderDiagnostics | null {
    return this.pageRenderer.getCurrentCanvasKitRenderDiagnostics();
  }

  getCoordinateSystem(): CoordinateSystem {
    return this.coordinateSystem;
  }
}

/** 머리말/꼬리말 편집 overlay 를 떼어 낸다. preview canvas 는 크기를 0으로 비운다. */
function discardHeaderFooterEditOverlay(element: HTMLElement): void {
  element.querySelectorAll('canvas').forEach((canvas) => {
    canvas.width = 0;
    canvas.height = 0;
  });
  element.remove();
}
