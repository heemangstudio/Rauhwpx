import type { InlineScreenshotPageRegion } from './inline-prompt-context.ts';

export interface CaptureRect { x: number; y: number; width: number; height: number }
export interface CapturePage {
  pageIndex: number;
  pageWidth: number;
  pageHeight: number;
  rect: CaptureRect;
}

export const DOCUMENT_CAPTURE_MAX_BYTES = 16 * 1024 * 1024;
export const DOCUMENT_CAPTURE_MAX_PIXELS = 16_000_000;
export const DOCUMENT_CAPTURE_MAX_DIMENSION = 8192;

export function intersectCaptureRects(a: CaptureRect, b: CaptureRect): CaptureRect | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const width = Math.min(a.x + a.width, b.x + b.width) - x;
  const height = Math.min(a.y + a.height, b.y + b.height) - y;
  return width > 0 && height > 0 ? { x, y, width, height } : null;
}

/** 드래그를 viewport와 페이지에 자르고, CSS 좌표를 각 페이지의 문서 좌표로 바꾼다. */
export function planDocumentRegion(
  start: { x: number; y: number },
  end: { x: number; y: number },
  viewport: CaptureRect,
  pages: CapturePage[],
): { rect: CaptureRect; parts: Array<{ rect: CaptureRect; pageRegion: InlineScreenshotPageRegion }> } | null {
  if (![start.x, start.y, end.x, end.y, viewport.x, viewport.y, viewport.width, viewport.height].every(Number.isFinite)
    || viewport.width <= 0 || viewport.height <= 0) return null;
  const drag = intersectCaptureRects({
    x: Math.min(start.x, end.x), y: Math.min(start.y, end.y),
    width: Math.abs(end.x - start.x), height: Math.abs(end.y - start.y),
  }, viewport);
  if (!drag) return null;
  const parts = pages.flatMap((page) => {
    if (!Number.isSafeInteger(page.pageIndex) || page.pageIndex < 0
      || ![page.pageWidth, page.pageHeight, page.rect.x, page.rect.y, page.rect.width, page.rect.height].every(Number.isFinite)
      || page.pageWidth <= 0 || page.pageHeight <= 0) return [];
    const rect = intersectCaptureRects(drag, page.rect);
    if (!rect || page.rect.width <= 0 || page.rect.height <= 0) return [];
    return [{ rect, pageRegion: {
      pageIndex: page.pageIndex, pageWidth: page.pageWidth, pageHeight: page.pageHeight,
      x: (rect.x - page.rect.x) / page.rect.width * page.pageWidth,
      y: (rect.y - page.rect.y) / page.rect.height * page.pageHeight,
      width: rect.width / page.rect.width * page.pageWidth,
      height: rect.height / page.rect.height * page.pageHeight,
    } }];
  });
  if (!parts.length) return null;
  const x = Math.min(...parts.map((part) => part.rect.x));
  const y = Math.min(...parts.map((part) => part.rect.y));
  return { rect: {
    x, y,
    width: Math.max(...parts.map((part) => part.rect.x + part.rect.width)) - x,
    height: Math.max(...parts.map((part) => part.rect.y + part.rect.height)) - y,
  }, parts };
}

/** 메모리 한도를 넘기 전에 출력 배율을 낮춘다. */
export function documentCaptureSize(rect: CaptureRect, requestedScale = 2): { width: number; height: number; scale: number } {
  if (!(rect.width > 0 && rect.height > 0) || ![rect.width, rect.height].every(Number.isFinite)) throw new Error('캡처 영역이 비어 있습니다.');
  const scale = Math.min(Number.isFinite(requestedScale) && requestedScale > 0 ? requestedScale : 1,
    DOCUMENT_CAPTURE_MAX_DIMENSION / rect.width, DOCUMENT_CAPTURE_MAX_DIMENSION / rect.height,
    Math.sqrt(DOCUMENT_CAPTURE_MAX_PIXELS / (rect.width * rect.height)));
  return { width: Math.max(1, Math.floor(rect.width * scale)), height: Math.max(1, Math.floor(rect.height * scale)), scale };
}
