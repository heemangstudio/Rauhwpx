/**
 * 문제 보고 스크린숏. 메인이 창 전체를 찍고, 여기서 창 전체를 글자를 알아볼 수 없게 흐린다. 화면마다 문서와
 * 프로젝트 내용이 놓이는 곳(편집 용지, 문서 홈, 프로젝트 보드의 카드, 채팅)이 달라 고른 영역만 흐리면 어딘가
 * 새어 나간다. 화면에 걸친 문서 쪽(편집 용지, 문서 홈의 미리보기)은 확대해도 글자가 살아나지 않게 쪽 폭에
 * 맞춘 더 큰 칸으로 한 번 더 흐린다. 흐리지 않은 원본은 메모리에만 두고 '블러 해제' 때만 보낸다.
 */
export interface CssRect {
  x: number;
  y: number;
  width: number;
  height: number;
  /** 흐림 한 칸의 CSS 크기. 쪽 폭에 맞춰 키워 확대해도 글자가 살아나지 않는다. */
  block: number;
}

/** 쪽 폭을 이만큼의 칸으로 나눈다. 한 줄의 글자 수보다 적어 글자 하나가 한 칸을 넘지 못한다. */
const BLOCKS_PER_PAGE_WIDTH = 32;
const MIN_BLOCK_CSS_PX = 12;
/** 창 전체 흐림의 칸. 화면 글자(12~20px)를 지우면서 창의 배치(패널, 대화상자, 알림 띠)는 알아볼 만큼 남긴다. */
const BLOCKS_PER_WINDOW_WIDTH = 120;
const SCREENSHOT_MAX_BYTES = 4 * 1024 * 1024 - 64 * 1024;

function shown(el: Element): boolean {
  const style = getComputedStyle(el);
  return style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) > 0;
}

function clipTo(
  rect: DOMRect,
  view: { left: number; top: number; right: number; bottom: number },
): { left: number; top: number; right: number; bottom: number } | null {
  const left = Math.max(rect.left, view.left);
  const top = Math.max(rect.top, view.top);
  const right = Math.min(rect.right, view.right);
  const bottom = Math.min(rect.bottom, view.bottom);
  return right - left >= 1 && bottom - top >= 1 ? { left, top, right, bottom } : null;
}

function blockFor(pageWidth: number): number {
  return Math.max(MIN_BLOCK_CSS_PX, Math.round(pageWidth / BLOCKS_PER_PAGE_WIDTH));
}

/**
 * 화면에 걸친 문서 쪽 영역(CSS px, 창 기준). 대화상자·홈이 덮고 있어도 흐린다 — 더 흐리는 편이 낫다.
 * 찍는 사이 스크롤로 어긋나도 글자가 드러나지 않게 흐림 한 칸만큼 넓힌다.
 */
export function visibleDocumentRects(root: Document = document): CssRect[] {
  const viewport = { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
  const rects: CssRect[] = [];
  const add = (el: Element, clip: typeof viewport) => {
    const box = el.getBoundingClientRect();
    if (box.width < 1 || box.height < 1 || !shown(el)) return;
    const block = blockFor(box.width);
    const area = clipTo(new DOMRect(box.x - block, box.y - block, box.width + 2 * block, box.height + 2 * block), clip);
    if (!area) return;
    rects.push({
      x: area.left,
      y: area.top,
      width: area.right - area.left,
      height: area.bottom - area.top,
      block,
    });
  };

  const container = root.getElementById('scroll-container');
  if (container && shown(container)) {
    const clip = clipTo(container.getBoundingClientRect(), viewport);
    if (clip) {
      for (const page of container.querySelectorAll('#scroll-content > canvas')) add(page, clip);
    }
  }
  for (const thumb of root.querySelectorAll('.document-home .dh-thumb')) add(thumb, viewport);
  return rects;
}

/**
 * 흐림을 켰을 때 가릴 곳(CSS px, 창 기준): 창 전체와, 그 위에 더 큰 칸으로 문서 쪽. 어느 화면이든 창 밖으로
 * 새는 곳이 없다. 나중 영역이 원본에서 다시 흐리므로 문서 쪽은 창 전체보다 거친 칸이 이긴다.
 */
export function reportBlurRects(root: Document = document): CssRect[] {
  const width = window.innerWidth;
  const height = window.innerHeight;
  const rects: CssRect[] = [];
  if (width >= 1 && height >= 1) {
    rects.push({ x: 0, y: 0, width, height, block: Math.max(MIN_BLOCK_CSS_PX, Math.round(width / BLOCKS_PER_WINDOW_WIDTH)) });
  }
  rects.push(...visibleDocumentRects(root));
  return rects;
}

/** 칸마다 평균을 낸 뒤 부드럽게 늘린다 — 모자이크보다 덜 거슬리고 글자는 남지 않는다. */
function obscure(ctx: CanvasRenderingContext2D, source: CanvasImageSource, rect: CssRect, scale: number, limit: { w: number; h: number }): void {
  const x = Math.max(0, Math.floor(rect.x * scale));
  const y = Math.max(0, Math.floor(rect.y * scale));
  const right = Math.min(limit.w, Math.ceil((rect.x + rect.width) * scale));
  const bottom = Math.min(limit.h, Math.ceil((rect.y + rect.height) * scale));
  const w = right - x;
  const h = bottom - y;
  if (w < 1 || h < 1) return;
  const block = Math.max(2, rect.block * scale);
  const small = document.createElement('canvas');
  small.width = Math.max(1, Math.ceil(w / block));
  small.height = Math.max(1, Math.ceil(h / block));
  const sctx = small.getContext('2d');
  if (!sctx) return;
  sctx.imageSmoothingEnabled = true;
  sctx.imageSmoothingQuality = 'high';
  sctx.drawImage(source, x, y, w, h, 0, 0, small.width, small.height);
  ctx.save();
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(small, 0, 0, small.width, small.height, x, y, w, h);
  ctx.restore();
  small.width = 0;
  small.height = 0;
}

export interface PreparedScreenshot {
  /** 메인이 찍은 PNG 그대로. */
  sharp: Blob;
  /** 흐린 PNG. 흐릴 곳이 없으면 sharp 와 같다. */
  blurred: Blob;
  /** 흐린 곳이 있었는지 — 없으면 '블러 해제'를 보이지 않는다. */
  hasBlur: boolean;
  width: number;
  height: number;
}

function canvasBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('screenshot encode failed'))), type, quality);
  });
}

export async function prepareScreenshot(
  png: Uint8Array,
  rects: readonly CssRect[],
  cssWidth: number,
): Promise<PreparedScreenshot> {
  const sharp = new Blob([png as BlobPart], { type: 'image/png' });
  const bitmap = await createImageBitmap(sharp);
  try {
    const { width, height } = bitmap;
    if (rects.length === 0) return { sharp, blurred: sharp, hasBlur: false, width, height };
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2d context unavailable');
    ctx.drawImage(bitmap, 0, 0);
    // 찍힌 그림은 물리 픽셀이다. 창의 CSS 폭과 견주어 배율을 정한다.
    const scale = cssWidth > 0 ? width / cssWidth : window.devicePixelRatio || 1;
    for (const rect of rects) obscure(ctx, bitmap, rect, scale, { w: width, h: height });
    const blurred = await canvasBlob(canvas, 'image/png');
    canvas.width = 0;
    canvas.height = 0;
    return { sharp, blurred, hasBlur: true, width, height };
  } finally {
    bitmap.close();
  }
}

/** 보낼 크기(4 MiB 아래)에 맞춘다. PNG 가 크면 JPEG 으로, 그래도 크면 줄여서 다시 담는다. */
export async function screenshotForUpload(blob: Blob): Promise<{ mime: 'image/png' | 'image/jpeg'; bytes: Uint8Array }> {
  if (blob.size <= SCREENSHOT_MAX_BYTES && blob.type === 'image/png') {
    return { mime: 'image/png', bytes: new Uint8Array(await blob.arrayBuffer()) };
  }
  const bitmap = await createImageBitmap(blob);
  try {
    for (const factor of [1, 0.75, 0.5, 0.35]) {
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(bitmap.width * factor));
      canvas.height = Math.max(1, Math.round(bitmap.height * factor));
      const ctx = canvas.getContext('2d');
      if (!ctx) break;
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const jpeg = await canvasBlob(canvas, 'image/jpeg', 0.85);
      canvas.width = 0;
      canvas.height = 0;
      if (jpeg.size <= SCREENSHOT_MAX_BYTES) return { mime: 'image/jpeg', bytes: new Uint8Array(await jpeg.arrayBuffer()) };
    }
  } finally {
    bitmap.close();
  }
  throw new Error('screenshot too large');
}
