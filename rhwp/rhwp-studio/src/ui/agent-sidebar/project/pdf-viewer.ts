/**
 * 프로젝트 미리보기의 PDF 보기. pdfjs-dist 는 처음 열 때만 불러온다.
 *
 * - 허브(reference-extractor.mjs)와 같은 4.10.38 이며 eval 을 쓰지 않는다.
 * - 워커·CMap·표준 글꼴은 모두 같은 출처에서 받는다 (vite-plugin-pdfjs-assets.mjs).
 * - 보이는 쪽과 앞뒤 한 쪽만 그리고, 멀어진 쪽의 캔버스는 비운다.
 * - 텍스트 층은 허브와 같은 기본값의 page.getTextContent() 로 채우고, 같은 item
 *   (글자와 자리)을 passage-locate.ts 에 넘겨 허브 조각 위치를 스팬 범위로 옮긴다.
 */

import './pdf-viewer.css';
import type { PDFDocumentLoadingTask, PDFDocumentProxy, RenderTask, TextLayer } from 'pdfjs-dist';
import { locatePassage, type PassageCitation, type PassageMatch, type PdfTextItem } from './passage-locate.ts';

type Pdfjs = typeof import('pdfjs-dist');

let pdfjsLoad: Promise<Pdfjs> | null = null;

/** pdfjs 와 워커 주소를 한 번만 불러온다. 실패하면 다음 요청에서 다시 시도한다. */
export function loadPdfjs(): Promise<Pdfjs> {
  pdfjsLoad ??= Promise.all([
    import('pdfjs-dist'),
    import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
  ]).then(([pdfjs, worker]) => {
    pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
    return pdfjs;
  }).catch((error: unknown) => {
    pdfjsLoad = null;
    throw error;
  });
  return pdfjsLoad;
}

const PAGE_GAP = 12;
const SIDE_PAD = 16;
/** 캔버스 한 장의 최대 픽셀 수. 큰 쪽을 확대해도 메모리가 튀지 않게 한다. */
const MAX_CANVAS_PIXELS = 16_777_216;
const ZOOM_STEPS = [0.5, 0.67, 0.8, 1, 1.25, 1.5, 2, 3, 4] as const;

interface PageSlot {
  number: number;
  element: HTMLDivElement;
  canvas: HTMLCanvasElement | null;
  text: HTMLDivElement;
  /** 그려진 배율. 아직 그리지 않았으면 0. */
  scale: number;
  width: number;
  height: number;
  sized: boolean;
  render: RenderTask | null;
  textLayer: TextLayer | null;
  /** 텍스트 층 스팬과 같은 순서의 item. divs[i] 가 items[i] 를 그린다. */
  items: PdfTextItem[] | null;
  divs: HTMLElement[];
  generation: number;
}

interface PendingHighlight {
  page: number;
  citation: PassageCitation;
  resolve: (match: PassageMatch | null) => void;
}

export interface PdfViewerOptions {
  /** 가운데에 걸친 쪽이 바뀔 때. */
  onPageChange?: (page: number, total: number) => void;
  onZoomChange?: (zoom: number) => void;
}

export interface PdfViewer {
  readonly element: HTMLElement;
  /** PDF 바이트를 연다. 이전 문서는 닫는다. */
  load(data: Uint8Array): Promise<{ pageCount: number }>;
  /** 쪽으로 이동한다. 1부터 센다. */
  showPage(page: number): void;
  /**
   * 쪽으로 이동해 인용 구절을 강조한다. 텍스트 층이 준비되면 찾은 범위를 돌려준다.
   * 찾지 못하면 쪽만 보여 주고 null.
   */
  highlight(page: number, citation: PassageCitation): Promise<PassageMatch | null>;
  clearHighlight(): void;
  zoomIn(): void;
  zoomOut(): void;
  /** 1 = 폭 맞춤. */
  readonly zoom: number;
  readonly pageCount: number;
  destroy(): void;
}

export function createPdfViewer(options: PdfViewerOptions = {}): PdfViewer {
  const scroller = document.createElement('div');
  scroller.className = 'ag-pdf';
  scroller.tabIndex = 0;
  scroller.setAttribute('role', 'document');
  const pagesEl = document.createElement('div');
  pagesEl.className = 'ag-pdf-pages';
  scroller.append(pagesEl);

  let pdfjs: Pdfjs | null = null;
  let loading: PDFDocumentLoadingTask | null = null;
  let doc: PDFDocumentProxy | null = null;
  let slots: PageSlot[] = [];
  let baseWidth = 612;
  let baseHeight = 792;
  let zoom = 1;
  let scale = 1;
  let destroyed = false;
  let docGeneration = 0;
  const visible = new Set<number>();
  let pending: PendingHighlight | null = null;
  let active: { page: number; citation: PassageCitation; match: PassageMatch | null } | null = null;
  let currentPage = 0;

  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const page = Number((entry.target as HTMLElement).dataset.page);
      if (entry.isIntersecting) visible.add(page);
      else visible.delete(page);
    }
    scheduleWindow();
  }, { root: scroller, rootMargin: '50% 0px' });

  let windowFrame = 0;
  function scheduleWindow(): void {
    if (windowFrame) return;
    windowFrame = requestAnimationFrame(() => {
      windowFrame = 0;
      updateWindow();
    });
  }

  /** 보이는 쪽 ±1 을 그리고, ±3 밖은 비운다. */
  function updateWindow(): void {
    if (!doc || visible.size === 0) return;
    const min = Math.min(...visible);
    const max = Math.max(...visible);
    for (const slot of slots) {
      if (slot.number >= min - 1 && slot.number <= max + 1) {
        if (slot.scale !== scale) void renderSlot(slot);
      } else if (slot.number < min - 3 || slot.number > max + 3) {
        releaseSlot(slot);
      }
    }
  }

  function availableWidth(): number {
    return Math.max(120, scroller.clientWidth - SIDE_PAD * 2);
  }

  function computeScale(): number {
    return (availableWidth() / baseWidth) * zoom;
  }

  function sizeSlot(slot: PageSlot): void {
    const width = slot.sized ? slot.width : baseWidth;
    const height = slot.sized ? slot.height : baseHeight;
    slot.element.style.width = `${Math.floor(width * scale)}px`;
    slot.element.style.height = `${Math.floor(height * scale)}px`;
    slot.element.style.setProperty('--scale-factor', String(scale));
  }

  function releaseSlot(slot: PageSlot): void {
    slot.generation += 1;
    slot.render?.cancel();
    slot.render = null;
    slot.textLayer?.cancel();
    slot.textLayer = null;
    if (slot.canvas) {
      // 캔버스 메모리를 바로 돌려준다.
      slot.canvas.width = 0;
      slot.canvas.height = 0;
      slot.canvas.remove();
      slot.canvas = null;
    }
    slot.text.replaceChildren();
    slot.items = null;
    slot.divs = [];
    slot.scale = 0;
  }

  async function renderSlot(slot: PageSlot): Promise<void> {
    if (!doc || !pdfjs) return;
    const generation = ++slot.generation;
    const targetScale = scale;
    slot.render?.cancel();
    slot.textLayer?.cancel();
    const current = doc;
    try {
      const page = await current.getPage(slot.number);
      if (generation !== slot.generation || current !== doc) return;
      const unit = page.getViewport({ scale: 1 });
      slot.width = unit.width;
      slot.height = unit.height;
      slot.sized = true;
      sizeSlot(slot);
      const viewport = page.getViewport({ scale: targetScale });
      const ratio = window.devicePixelRatio || 1;
      const pixels = viewport.width * viewport.height * ratio * ratio;
      const outputScale = pixels > MAX_CANVAS_PIXELS ? Math.sqrt(MAX_CANVAS_PIXELS / (viewport.width * viewport.height)) : ratio;
      const canvas = document.createElement('canvas');
      canvas.className = 'ag-pdf-canvas';
      canvas.width = Math.floor(viewport.width * outputScale);
      canvas.height = Math.floor(viewport.height * outputScale);
      canvas.setAttribute('aria-hidden', 'true');
      const context = canvas.getContext('2d', { alpha: false });
      if (!context) return;
      const task = page.render({
        canvasContext: context,
        viewport,
        transform: outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : undefined,
      });
      slot.render = task;
      await task.promise;
      if (generation !== slot.generation) {
        canvas.width = 0;
        return;
      }
      slot.render = null;
      // 새 캔버스를 다 그린 뒤 바꿔 끼워, 확대 중에 쪽이 하얗게 비지 않게 한다.
      if (slot.canvas) {
        slot.canvas.width = 0;
        slot.canvas.replaceWith(canvas);
      } else {
        slot.element.prepend(canvas);
      }
      slot.canvas = canvas;
      slot.scale = targetScale;

      const text = document.createElement('div');
      text.className = 'textLayer ag-pdf-text';
      // 허브 collectPdfPages 와 같은 기본값이어야 조각 위치가 맞는다.
      const content = await page.getTextContent();
      if (generation !== slot.generation) return;
      const layer = new pdfjs.TextLayer({ textContentSource: content, container: text, viewport });
      slot.textLayer = layer;
      await layer.render();
      if (generation !== slot.generation) return;
      slot.textLayer = null;
      slot.text.replaceWith(text);
      slot.text = text;
      // TextLayer 는 str 이 있는 item 마다 스팬을 하나씩 만든다.
      const items = content.items.filter((item) => 'str' in item) as PdfTextItem[];
      slot.divs = [...layer.textDivs];
      slot.items = items.slice(0, slot.divs.length);
      if (pending?.page === slot.number) applyPending();
      else if (active?.page === slot.number) applyHighlight(slot, active.citation);
    } catch (error) {
      if (generation !== slot.generation) return;
      if ((error as { name?: string })?.name === 'RenderingCancelledException') return;
      if ((error as { name?: string })?.name === 'AbortException') return;
      slot.element.dataset.failed = 'true';
    }
  }

  function clearMarks(): void {
    for (const mark of pagesEl.querySelectorAll<HTMLElement>('.ag-pdf-hit')) {
      const div = mark.parentElement;
      if (!div) continue;
      // 텍스트 층 스팬을 원래 글자 하나로 되돌린다.
      div.textContent = div.textContent;
    }
  }

  function applyHighlight(slot: PageSlot, citation: PassageCitation): PassageMatch | null {
    clearMarks();
    if (!slot.items) return null;
    const match = locatePassage(slot.items, citation);
    if (!match) return null;
    match.ranges.forEach((range, index) => {
      const div = slot.divs[range.item];
      const source = slot.items![range.item]?.str ?? '';
      if (!div || !div.isConnected) return;
      const before = source.slice(0, range.start);
      const hit = source.slice(range.start, range.end);
      const after = source.slice(range.end);
      const mark = document.createElement('span');
      mark.className = 'ag-pdf-hit';
      if (index === 0) mark.classList.add('ag-pdf-hit-first');
      mark.textContent = hit;
      div.replaceChildren(
        ...(before ? [document.createTextNode(before)] : []),
        mark,
        ...(after ? [document.createTextNode(after)] : []),
      );
    });
    return match;
  }

  function applyPending(): void {
    if (!pending) return;
    const slot = slots[pending.page - 1];
    if (!slot?.items) return;
    const { citation, resolve, page } = pending;
    pending = null;
    const match = applyHighlight(slot, citation);
    active = { page, citation, match };
    const first = slot.element.querySelector<HTMLElement>('.ag-pdf-hit-first');
    if (first) scrollIntoCenter(first);
    resolve(match);
  }

  function scrollIntoCenter(target: HTMLElement): void {
    const box = target.getBoundingClientRect();
    const frame = scroller.getBoundingClientRect();
    const delta = box.top - frame.top - frame.height / 3;
    scroller.scrollTop += delta;
  }

  function scrollToSlot(slot: PageSlot): void {
    scroller.scrollTop = slot.element.offsetTop - PAGE_GAP;
  }

  let scrollFrame = 0;
  function trackCurrentPage(): void {
    if (scrollFrame) return;
    scrollFrame = requestAnimationFrame(() => {
      scrollFrame = 0;
      if (!slots.length) return;
      const middle = scroller.scrollTop + scroller.clientHeight / 2;
      let page = 1;
      for (const slot of slots) {
        if (slot.element.offsetTop <= middle) page = slot.number;
        else break;
      }
      if (page !== currentPage) {
        currentPage = page;
        options.onPageChange?.(page, slots.length);
      }
    });
  }
  scroller.addEventListener('scroll', trackCurrentPage, { passive: true });

  /** 배율이 바뀌면 지금 보던 자리를 쪽 기준으로 지키며 다시 배치한다. */
  function relayout(): void {
    if (!doc || !slots.length) return;
    const next = computeScale();
    if (Math.abs(next - scale) < 0.001) return;
    const anchor = slots.find((slot) => slot.element.offsetTop + slot.element.offsetHeight > scroller.scrollTop) ?? slots[0]!;
    const within = (scroller.scrollTop - anchor.element.offsetTop) / Math.max(1, anchor.element.offsetHeight);
    scale = next;
    for (const slot of slots) sizeSlot(slot);
    scroller.scrollTop = anchor.element.offsetTop + within * anchor.element.offsetHeight;
    scheduleWindow();
  }

  let resizeTimer = 0;
  let lastWidth = 0;
  const resizeObserver = new ResizeObserver(() => {
    const width = scroller.clientWidth;
    if (Math.abs(width - lastWidth) < 1) return;
    lastWidth = width;
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(relayout, 120);
  });
  resizeObserver.observe(scroller);

  function setZoom(next: number): void {
    const clamped = Math.min(ZOOM_STEPS[ZOOM_STEPS.length - 1]!, Math.max(ZOOM_STEPS[0]!, next));
    if (clamped === zoom) return;
    zoom = clamped;
    relayout();
    options.onZoomChange?.(zoom);
  }

  function closeDocument(): void {
    docGeneration += 1;
    for (const slot of slots) {
      releaseSlot(slot);
      observer.unobserve(slot.element);
    }
    slots = [];
    visible.clear();
    pagesEl.replaceChildren();
    pending?.resolve(null);
    pending = null;
    active = null;
    currentPage = 0;
    const closing = loading;
    loading = null;
    doc = null;
    void closing?.destroy().catch(() => {});
  }

  async function load(data: Uint8Array): Promise<{ pageCount: number }> {
    closeDocument();
    const generation = docGeneration;
    pdfjs = await loadPdfjs();
    if (destroyed || generation !== docGeneration) throw new Error('closed');
    const base = import.meta.env.BASE_URL ?? '/';
    const task = pdfjs.getDocument({
      data,
      isEvalSupported: false,
      cMapUrl: `${base}pdfjs/cmaps/`,
      cMapPacked: true,
      standardFontDataUrl: `${base}pdfjs/standard_fonts/`,
      enableXfa: false,
    });
    loading = task;
    const opened = await task.promise;
    if (destroyed || generation !== docGeneration) {
      void task.destroy().catch(() => {});
      throw new Error('closed');
    }
    doc = opened;
    const first = await opened.getPage(1);
    const unit = first.getViewport({ scale: 1 });
    baseWidth = unit.width;
    baseHeight = unit.height;
    lastWidth = scroller.clientWidth;
    scale = computeScale();
    slots = Array.from({ length: opened.numPages }, (_, index) => {
      const element = document.createElement('div');
      element.className = 'ag-pdf-page';
      element.dataset.page = String(index + 1);
      element.setAttribute('aria-label', `${index + 1}쪽`);
      const text = document.createElement('div');
      text.className = 'textLayer ag-pdf-text';
      element.append(text);
      const slot: PageSlot = {
        number: index + 1, element, canvas: null, text, scale: 0,
        width: baseWidth, height: baseHeight, sized: false,
        render: null, textLayer: null, items: null, divs: [], generation: 0,
      };
      sizeSlot(slot);
      return slot;
    });
    pagesEl.replaceChildren(...slots.map((slot) => slot.element));
    for (const slot of slots) observer.observe(slot.element);
    currentPage = 1;
    options.onPageChange?.(1, slots.length);
    return { pageCount: opened.numPages };
  }

  function clampPage(page: number): PageSlot | null {
    if (!slots.length) return null;
    return slots[Math.min(slots.length, Math.max(1, Math.round(page))) - 1] ?? null;
  }

  return {
    element: scroller,
    load,
    showPage(page) {
      const slot = clampPage(page);
      if (slot) scrollToSlot(slot);
    },
    highlight(page, citation) {
      const slot = clampPage(page);
      if (!slot) return Promise.resolve(null);
      pending?.resolve(null);
      scrollToSlot(slot);
      return new Promise<PassageMatch | null>((resolve) => {
        pending = { page: slot.number, citation, resolve };
        if (slot.items && slot.scale === scale) applyPending();
        else scheduleWindow();
      });
    },
    clearHighlight() {
      active = null;
      clearMarks();
    },
    zoomIn() {
      setZoom(ZOOM_STEPS.find((step) => step > zoom + 0.001) ?? zoom);
    },
    zoomOut() {
      setZoom([...ZOOM_STEPS].reverse().find((step) => step < zoom - 0.001) ?? zoom);
    },
    get zoom() {
      return zoom;
    },
    get pageCount() {
      return slots.length;
    },
    destroy() {
      destroyed = true;
      closeDocument();
      observer.disconnect();
      resizeObserver.disconnect();
      window.clearTimeout(resizeTimer);
      if (windowFrame) cancelAnimationFrame(windowFrame);
      if (scrollFrame) cancelAnimationFrame(scrollFrame);
    },
  };
}
