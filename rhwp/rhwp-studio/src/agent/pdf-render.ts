/**
 * pdf.js 공용 자리: 불러오기, 문서 열기 인자, 짧게 붙들어 두는 문서 캐시, 쪽 영역 그리기.
 *
 * - 미리보기(pdf-viewer.ts), 영역 썸네일, 에이전트 도구(read_reference_image·insert_image)가 함께 쓴다.
 * - 허브(reference-extractor.mjs)와 같은 4.10.38 이며 eval 을 쓰지 않는다. 워커·CMap·표준 글꼴은
 *   vite-plugin-pdfjs-assets.mjs 가 같은 출처로 내놓는다.
 * - 영역 계산은 clip-geometry.ts·image-crop.ts 의 순수 함수가 맡는다. PDF 의 원본 픽셀은 96dpi 다.
 */
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { pdfPagePixels, pixelBoxToRect, rectToPixelBox, thumbnailZoom, PDF_PX_PER_PT } from './clip-geometry.ts';
import {
  createCanvas,
  encodeCanvas,
  planImageCrop,
  type CroppedImage,
  type ImageCropPlan,
  type PixelBox,
} from './image-crop.ts';
import { AgentToolError, type ProjectClipRect } from './types.ts';

type Pdfjs = typeof import('pdfjs-dist');
type RenderCanvas = HTMLCanvasElement | OffscreenCanvas;

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

/** getDocument 인자. 한국어 글꼴(CMap)과 표준 글꼴은 앱이 내놓은 사본을 쓴다. */
export function pdfDocumentParams(data: Uint8Array) {
  const base = import.meta.env?.BASE_URL ?? '/';
  return {
    data,
    isEvalSupported: false,
    cMapUrl: `${base}pdfjs/cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${base}pdfjs/standard_fonts/`,
    enableXfa: false,
  };
}

/* ── 문서 캐시 ─────────────────────────────────────────────
 * 썸네일 여러 장과 도구 호출이 같은 PDF 를 연달아 연다. 쓰는 중인 문서는 닫지 않고,
 * 쉬는 문서는 최근 둘만 1분 동안 남긴다 (스캔 PDF 는 수십 MB 라 오래 붙들지 않는다). */

interface CachedPdf {
  promise: Promise<PDFDocumentProxy>;
  destroy: () => void;
  users: number;
  lastUsed: number;
}

const MAX_IDLE_DOCUMENTS = 2;
const IDLE_MS = 60_000;
const documents = new Map<string, CachedPdf>();
let sweepTimer: ReturnType<typeof setTimeout> | null = null;

function sweepDocuments(): void {
  sweepTimer = null;
  const now = Date.now();
  const idle = [...documents.entries()]
    .filter(([, entry]) => entry.users === 0)
    .sort((a, b) => b[1].lastUsed - a[1].lastUsed);
  idle.forEach(([key, entry], index) => {
    if (index < MAX_IDLE_DOCUMENTS && now - entry.lastUsed < IDLE_MS) return;
    documents.delete(key);
    entry.destroy();
  });
  if ([...documents.values()].some((entry) => entry.users === 0)) {
    sweepTimer = setTimeout(sweepDocuments, IDLE_MS);
  }
}

/**
 * key(보통 참고 자료 fileId)로 PDF 를 열어 run 에 빌려준다. 같은 key 는 한 번만 받고 연다.
 * 열기에 실패하면 캐시에 남기지 않는다.
 */
export async function withPdf<T>(
  key: string,
  load: () => Promise<Uint8Array>,
  run: (doc: PDFDocumentProxy) => Promise<T>,
): Promise<T> {
  let entry = documents.get(key);
  if (!entry) {
    let destroyTask: (() => void) | null = null;
    const created: CachedPdf = {
      users: 0,
      lastUsed: Date.now(),
      destroy: () => destroyTask?.(),
      promise: (async () => {
        const [data, pdfjs] = await Promise.all([load(), loadPdfjs()]);
        const task = pdfjs.getDocument(pdfDocumentParams(data));
        destroyTask = () => { void task.destroy().catch(() => {}); };
        return task.promise;
      })(),
    };
    created.promise.catch(() => {
      if (documents.get(key) === created) documents.delete(key);
    });
    documents.set(key, created);
    entry = created;
  }
  entry.users += 1;
  try {
    return await run(await entry.promise);
  } finally {
    entry.users -= 1;
    entry.lastUsed = Date.now();
    if (sweepTimer) clearTimeout(sweepTimer);
    sweepTimer = setTimeout(sweepDocuments, 0);
  }
}

/* ── 쪽 영역 그리기 ─────────────────────────────────────── */

export interface PdfRegionRequest {
  /** 1부터 센다. */
  page: number;
  /** 쪽 비율 영역. cropPx 보다 먼저 본다. */
  rect?: readonly number[];
  /** 96dpi 쪽 픽셀 상자. */
  cropPx?: PixelBox;
  /** 96dpi 기준 배율. maxPixels 에 걸리면 줄어든다. */
  zoom?: number;
  /** 긴 변을 이 픽셀에 맞춘다 (썸네일). 주면 zoom 대신 쓴다. */
  fit?: number;
  maxPixels?: number;
}

export interface PdfRegionCanvas {
  canvas: RenderCanvas;
  plan: ImageCropPlan;
  /** 96dpi 쪽 크기. */
  pagePx: { width: number; height: number };
  pageCount: number;
}

/** 쪽 하나의 영역을 흰 바탕 캔버스에 그린다. 영역 밖은 그리지 않는다. */
export async function renderPdfRegion(doc: PDFDocumentProxy, request: PdfRegionRequest): Promise<PdfRegionCanvas> {
  if (!Number.isSafeInteger(request.page) || request.page < 1 || request.page > doc.numPages) {
    throw new AgentToolError('INVALID_ARGS', `page ${request.page} is outside 1..${doc.numPages}`);
  }
  const page = await doc.getPage(request.page);
  try {
    const unit = page.getViewport({ scale: 1 });
    const pagePx = pdfPagePixels(unit.width, unit.height);
    const box = request.rect ? rectToPixelBox(request.rect, pagePx.width, pagePx.height) : request.cropPx;
    const zoom = request.fit
      ? thumbnailZoom(box ?? { x: 0, y: 0, width: pagePx.width, height: pagePx.height }, request.fit)
      : request.zoom ?? 1;
    const plan = planImageCrop(pagePx.width, pagePx.height, box, zoom, request.maxPixels);
    const canvas = createCanvas(plan.outWidth, plan.outHeight);
    const context = canvas.getContext('2d', { alpha: false }) as CanvasRenderingContext2D | null;
    if (!context) throw new AgentToolError('RENDER_UNAVAILABLE', 'Canvas 2D context is unavailable');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, plan.outWidth, plan.outHeight);
    // 쪽 전체 배율로 그리되 영역의 왼쪽 위가 캔버스 원점에 오도록 옮긴다.
    const viewport = page.getViewport({ scale: PDF_PX_PER_PT * plan.scale });
    await page.render({
      canvasContext: context,
      viewport,
      transform: [1, 0, 0, 1, -plan.crop.x * plan.scale, -plan.crop.y * plan.scale],
    }).promise;
    return { canvas, plan, pagePx, pageCount: doc.numPages };
  } finally {
    page.cleanup();
  }
}

/**
 * 캔버스를 바이트 상한 안으로 인코딩한다: 원하는 형식 → JPEG → 줄인 JPEG.
 * 스캔 쪽은 PNG 가 크게 나오므로 삽입 경로가 쓴다.
 */
export async function encodeWithinBytes(
  canvas: RenderCanvas,
  maxBytes: number,
  preferred: CroppedImage['mimeType'],
): Promise<{ bytes: Uint8Array; mimeType: CroppedImage['mimeType']; width: number; height: number }> {
  let source = canvas;
  let bytes = await encodeCanvas(source, preferred);
  if (bytes.length <= maxBytes) return { bytes, mimeType: preferred, width: source.width, height: source.height };
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (attempt > 0 || preferred === 'image/jpeg') {
      const factor = Math.max(0.25, Math.sqrt(maxBytes / bytes.length) * 0.92);
      const smaller = createCanvas(Math.max(1, Math.floor(source.width * factor)), Math.max(1, Math.floor(source.height * factor)));
      const context = smaller.getContext('2d') as CanvasRenderingContext2D | null;
      if (!context) break;
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = 'high';
      context.drawImage(source, 0, 0, smaller.width, smaller.height);
      source = smaller;
    }
    bytes = await encodeCanvas(source, 'image/jpeg');
    if (bytes.length <= maxBytes) return { bytes, mimeType: 'image/jpeg', width: source.width, height: source.height };
  }
  throw new AgentToolError('INVALID_ARGS', 'the rendered region is too large; choose a smaller region');
}

/* ── 에이전트 도구용 ────────────────────────────────────── */

export interface PdfImageRequest {
  /** 허브가 정한 원본: 세션 프로젝트의 파일 항목. 바이트는 load 로 받는다. */
  fileId: string;
  page: number;
  rect?: readonly number[];
  cropPx?: PixelBox;
  zoom?: number;
  maxPixels: number;
  /** 인코딩 결과 상한 (삽입 경로). 없으면 PNG 그대로. */
  maxBytes?: number;
}

export interface PdfImage extends CroppedImage {
  pagePx: { width: number; height: number };
  /** 실제로 그린 영역 (쪽 비율). */
  rect: ProjectClipRect;
  pageCount: number;
}

export type PdfImageRenderer = (request: PdfImageRequest, load: () => Promise<Uint8Array>) => Promise<PdfImage>;

/** 프로젝트 PDF 의 쪽 영역을 PNG(넘치면 JPEG)로 그린다. */
export const renderPdfImage: PdfImageRenderer = (request, load) => withPdf(request.fileId, load, async (doc) => {
  const region = await renderPdfRegion(doc, request);
  try {
    const encoded = request.maxBytes
      ? await encodeWithinBytes(region.canvas, request.maxBytes, 'image/png')
      : { bytes: await encodeCanvas(region.canvas, 'image/png'), mimeType: 'image/png' as const, width: region.canvas.width, height: region.canvas.height };
    return {
      bytes: encoded.bytes,
      mimeType: encoded.mimeType,
      widthPx: encoded.width,
      heightPx: encoded.height,
      crop: region.plan.crop,
      scale: Math.round((encoded.width / region.plan.crop.width) * 1000) / 1000,
      pagePx: region.pagePx,
      rect: pixelBoxToRect(region.plan.crop, region.pagePx.width, region.pagePx.height),
      pageCount: region.pageCount,
    };
  } finally {
    region.canvas.width = 0;
    region.canvas.height = 0;
  }
});
