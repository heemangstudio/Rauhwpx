import { assertBase64EncodedImageDecodeDimensions } from './canvaskit/image-header.ts';

/** UTF-8 바이트 기준 base64 (Rust base64::STANDARD 과 동일 산출). */
function utf8ToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

/**
 * rawSvg 조각을 `src/renderer/svg_fragment.rs::wrap_svg_fragment`와
 * 바이트 동일하게 감싼 SVG data URL로 변환한다.
 */
function rawSvgFragmentToDataUrl(
  fragment: string,
  x: number,
  y: number,
  width: number,
  height: number,
): string {
  const f = (value: number): string => value.toFixed(3);
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" '
    + `width="${f(width)}" height="${f(height)}" viewBox="${f(x)} ${f(y)} ${f(width)} ${f(height)}">\n`
    + `${fragment}\n</svg>`;
  return `data:image/svg+xml;base64,${utf8ToBase64(svg)}`;
}

// Prefetch is only a decode hint; the renderer still paints the source tree.
// Keep malformed or unusually large pages from allocating several copies of a
// multi-megabyte SVG or of their entire image payload while building data URLs.
const MAX_RAW_SVG_FRAGMENT_CHARS = 1_048_576;
export const MAX_PREFETCH_IMAGES_PER_PAGE = 256;
export const MAX_PREFETCH_DATA_URL_CHARS = 16 * 1024 * 1024;

/**
 * 엔진(web_canvas)이 image crate 로 동기 디코드해 첫 paint 에 바로 그리는 형식
 * (Cargo.toml `image` features: bmp, jpeg, png, tiff).
 */
const ENGINE_SYNC_IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/bmp', 'image/tiff']);
/** 엔진이 HtmlImageElement 로 비동기 로드하고, 같은 data URL 로 미리 디코드할 수 있는 형식. */
const PREFETCHABLE_ASYNC_IMAGE_MIMES = new Set(['image/gif', 'image/webp', 'image/svg+xml']);

const EMBEDDED_RASTER_RE = /data:(image\/[A-Za-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)/g;
const SINGLE_RASTER_DATA_URL_RE = /^data:(image\/[A-Za-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/;

/**
 * 첫 paint 이후 그림 재렌더 계획.
 * - `none`: 비동기로 로드되는 그림이 없다. 첫 paint 가 이미 완전하다.
 * - `decoded`: 비동기 그림을 모두 같은 data URL 로 미리 디코드할 수 있다. 디코드 뒤 한 번 다시 그린다.
 * - `wait`: 미리 디코드할 수 없는 비동기 그림(WMF, 한도 초과, 해석 불가)이 있다. 조기/fallback 타이머에 맡긴다.
 */
export type LayerImagePrefetchPlan =
  | { kind: 'none' }
  | { kind: 'decoded'; urls: string[] }
  | { kind: 'wait' };

function hasValidRasterDimensions(base64: string): boolean {
  try {
    assertBase64EncodedImageDecodeDimensions(base64, '문서 그림');
    return true;
  } catch {
    return false;
  }
}

/** svg_fragment.rs::find_svg_attr_value 와 같은 규칙 — 공백 뒤의 `name="` 만 속성으로 본다. */
function findSvgAttrValue(fragment: string, name: string): string | null {
  const needle = `${name}="`;
  let from = 0;
  for (;;) {
    const pos = fragment.indexOf(needle, from);
    if (pos < 0) return null;
    if (pos > 0 && ' \t\n\r'.includes(fragment[pos - 1])) {
      const start = pos + needle.length;
      const end = fragment.indexOf('"', start);
      return end < 0 ? null : fragment.slice(start, end);
    }
    from = pos + needle.length;
  }
}

/** svg_fragment.rs::try_parse_single_image_data_url 미러 — 엔진이 조각을 감싸지 않고 바로 그리는 경우. */
function singleImageDataUrl(fragment: string): string | null {
  const s = fragment.trim();
  if (!s.startsWith('<image') || !s.endsWith('/>')) return null;
  if (s.split('<').length !== 2) return null;
  const href = findSvgAttrValue(s, 'xlink:href') ?? findSvgAttrValue(s, 'href');
  return href?.startsWith('data:') ? href : null;
}

function finiteBbox(value: unknown): { x: number; y: number; width: number; height: number } | null {
  if (!value || typeof value !== 'object') return null;
  const { x, y, width, height } = value as Record<string, unknown>;
  return typeof x === 'number' && typeof y === 'number'
    && typeof width === 'number' && typeof height === 'number'
    ? { x, y, width, height }
    : null;
}

/**
 * getPageLayerTree 트리에서 첫 paint 뒤 비동기로 나타날 그림을 모아 재렌더 계획을 세운다.
 *
 * 엔진 draw_image 는 png/jpeg/bmp/tiff 를 동기 디코드하고, 나머지는 HtmlImageElement 가 로드를
 * 마친 뒤에만 그린다. 비동기 그림은 엔진이 만드는 것과 같은 data URL 을 미리 디코드해 재렌더
 * 시점을 잡는다. 같은 URL 을 만들 수 없는 그림(엔진이 SVG 로 바꾸는 WMF 등)이나 한도를 넘는
 * 그림이 하나라도 있으면 `wait` 로 둔다.
 *
 * `getPageLayerTree`의 bbox 계약은 `x/y/width/height`다. 구형 `getPageRenderTree` JSON의
 * `w/h`와 혼동하지 않는다.
 */
export function collectLayerImagePrefetch(tree: unknown): LayerImagePrefetchPlan {
  const urls: string[] = [];
  const seen = new Set<string>();
  let urlChars = 0;

  /** false 면 미리 디코드할 수 없는 비동기 그림이다. */
  const enqueue = (dataUrl: string): boolean => {
    if (seen.has(dataUrl)) return true;
    if (
      seen.size >= MAX_PREFETCH_IMAGES_PER_PAGE
      || urlChars + dataUrl.length > MAX_PREFETCH_DATA_URL_CHARS
    ) {
      return false;
    }
    seen.add(dataUrl);
    urls.push(dataUrl);
    urlChars += dataUrl.length;
    return true;
  };

  const visitImage = (op: Record<string, unknown>): boolean => {
    const { mime, base64 } = op;
    // 데이터 없는 그림(외부 경로)은 엔진이 자리표시만 동기로 그린다.
    if (typeof base64 !== 'string' || base64.length === 0) return true;
    if (typeof mime !== 'string') return false;
    // 한도를 넘는 raster 는 엔진 동기 디코드도 실패해 비동기 경로로 떨어질 수 있다.
    if (ENGINE_SYNC_IMAGE_MIMES.has(mime)) return hasValidRasterDimensions(base64);
    return PREFETCHABLE_ASYNC_IMAGE_MIMES.has(mime)
      && hasValidRasterDimensions(base64)
      && enqueue(`data:${mime};base64,${base64}`);
  };

  const visitRawSvg = (op: Record<string, unknown>): boolean => {
    const svg = op.svg;
    if (typeof svg !== 'string') return true;
    const single = singleImageDataUrl(svg);
    if (single !== null) {
      const match = SINGLE_RASTER_DATA_URL_RE.exec(single);
      return !!match && hasValidRasterDimensions(match[2]) && enqueue(single);
    }
    const bbox = finiteBbox(op.bbox);
    if (!bbox || svg.length > MAX_RAW_SVG_FRAGMENT_CHARS) return false;
    // 감싼 SVG 는 품은 raster 까지 디코드한다. 그 raster 가 한도를 넘으면 미리 디코드하지 않는다.
    for (const embedded of svg.matchAll(EMBEDDED_RASTER_RE)) {
      if (!hasValidRasterDimensions(embedded[2])) return false;
    }
    return enqueue(rawSvgFragmentToDataUrl(svg, bbox.x, bbox.y, bbox.width, bbox.height));
  };

  // PageLayerTree 구조(ops/children/child)만 따라간다 — 쪽 요약(collectLayerPlaneSummary)이
  // 세는 그림과 같은 집합이다. 깊은 그룹 중첩에도 스택이 넘치지 않게 반복으로 돈다.
  const root = tree && typeof tree === 'object' && 'root' in tree
    ? (tree as { root: unknown }).root
    : tree;
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const node = stack.pop() as Record<string, unknown> | null | undefined;
    if (!node || typeof node !== 'object') continue;
    if (Array.isArray(node.ops)) {
      for (const op of node.ops) {
        if (!op || typeof op !== 'object') continue;
        const record = op as Record<string, unknown>;
        const prefetchable = record.type === 'image'
          ? visitImage(record)
          : record.type === 'rawSvg'
            ? visitRawSvg(record)
            : true;
        // 하나라도 기다려야 하면 결과는 정해졌다 — 남은 URL 을 만들지 않는다.
        if (!prefetchable) return { kind: 'wait' };
      }
    }
    if (Array.isArray(node.children)) {
      for (let i = node.children.length - 1; i >= 0; i -= 1) stack.push(node.children[i]);
    }
    if (node.child) stack.push(node.child);
  }

  return urls.length > 0 ? { kind: 'decoded', urls } : { kind: 'none' };
}
