/**
 * 문서 첫 쪽을 작은 그림으로 만든다. 열린 문서는 그 엔진으로 바로 그리고, 닫힌 문서는
 * 보조 엔진 하나에 잠깐 열었다가 바로 내린다. 한 번에 한 문서만 연다.
 */
import type { WasmBridge } from '../core/wasm-bridge.ts';

/** 카드 폭(약 190 CSS px)의 두 배. 레티나에서도 글줄이 뭉개지지 않는다. */
const THUMBNAIL_WIDTH = 380;
/** 이보다 큰 파일은 미리보기를 위해 열지 않는다. */
export const THUMBNAIL_SOURCE_MAX_BYTES = 24 * 1024 * 1024;

/** 바이트를 엔진이 읽지 못했다. 파일이 손상되었거나 지원하지 않는 형식이다. */
export class ThumbnailParseError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = 'ThumbnailParseError';
  }
}

type PageRenderer = Pick<WasmBridge, 'renderPageToCanvas' | 'getPageInfo'>;

/** 엔진에 열린 문서의 첫 쪽을 그린다. 그릴 수 없으면 null. */
export async function renderFirstPage(source: PageRenderer): Promise<Blob | null> {
  const page = source.getPageInfo(0);
  if (!page?.width || !page.height) return null;
  const canvas = document.createElement('canvas');
  try {
    source.renderPageToCanvas(0, canvas, THUMBNAIL_WIDTH / page.width);
    if (!canvas.width || !canvas.height) return null;
    return await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/webp', 0.82));
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}

let renderer: Promise<WasmBridge> | null = null;
let chain: Promise<unknown> = Promise.resolve();

function auxiliaryBridge(): Promise<WasmBridge> {
  renderer ??= import('../core/wasm-bridge.ts').then(async ({ WasmBridge }) => {
    const bridge = new WasmBridge();
    await bridge.initialize();
    return bridge;
  });
  return renderer;
}

/**
 * 닫힌 문서의 바이트에서 첫 쪽을 그린다. 엔진이 읽지 못하면 ThumbnailParseError 를 던진다.
 * 호출은 차례로 처리하므로 동시에 여러 문서가 메모리에 올라가지 않는다.
 */
export function renderThumbnailFromBytes(bytes: Uint8Array, fileName: string): Promise<Blob | null> {
  const run = chain.then(async () => {
    const bridge = await auxiliaryBridge();
    try {
      try {
        bridge.loadDocument(bytes, fileName);
      } catch (error) {
        throw new ThumbnailParseError(error);
      }
      return await renderFirstPage(bridge);
    } finally {
      bridge.releaseDocument();
    }
  });
  chain = run.catch(() => {});
  return run;
}
