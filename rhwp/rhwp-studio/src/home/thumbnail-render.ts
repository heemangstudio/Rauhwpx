/**
 * 문서 첫 쪽을 작은 그림으로 만든다. 열린 문서는 그 엔진으로 바로 그리고, 닫힌 문서는 따로
 * 띄운 일꾼(thumbnail.worker.ts)의 엔진에서 SVG 로 받아 여기서 그림으로 옮긴다. 일꾼의 엔진이
 * 멈춰도 열린 문서와는 상관없고, 일꾼만 새로 띄운다.
 */
import type { WasmBridge } from '../core/wasm-bridge.ts';
import type { ThumbnailWorkerRequest, ThumbnailWorkerResponse } from './thumbnail.worker.ts';

/** 카드 폭(약 190 CSS px)의 두 배. 레티나에서도 글줄이 뭉개지지 않는다. */
const THUMBNAIL_WIDTH = 380;
/** 이보다 큰 파일은 미리보기를 위해 열지 않는다. */
export const THUMBNAIL_SOURCE_MAX_BYTES = 24 * 1024 * 1024;
/** 한 문서를 이보다 오래 붙잡으면 일꾼을 내리고 그 문서는 자리표시로 둔다. */
const THUMBNAIL_TIMEOUT_MS = 15_000;

type PageRenderer = Pick<WasmBridge, 'renderPageToCanvas' | 'getPageInfo'>;

function canvasBlob(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/webp', 0.82));
}

/** 엔진에 열린 문서의 첫 쪽을 그린다. 그릴 수 없으면 null. */
export async function renderFirstPage(source: PageRenderer): Promise<Blob | null> {
  const page = source.getPageInfo(0);
  if (!page?.width || !page.height) return null;
  const canvas = document.createElement('canvas');
  try {
    source.renderPageToCanvas(0, canvas, THUMBNAIL_WIDTH / page.width);
    if (!canvas.width || !canvas.height) return null;
    return await canvasBlob(canvas);
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}

/** 일꾼이 보낸 첫 쪽 SVG 를 카드 크기 그림으로 옮긴다. */
async function rasterizeSvg(svg: string, width: number, height: number): Promise<Blob | null> {
  if (!width || !height) return null;
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  const canvas = document.createElement('canvas');
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    canvas.width = THUMBNAIL_WIDTH;
    canvas.height = Math.round(THUMBNAIL_WIDTH * (height / width));
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) return null;
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return await canvasBlob(canvas);
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
    canvas.width = 0;
    canvas.height = 0;
  }
}

let worker: Worker | null = null;
let sequence = 0;
let chain: Promise<unknown> = Promise.resolve();

function thumbnailWorker(): Worker {
  worker ??= new Worker(new URL('./thumbnail.worker.ts', import.meta.url), { type: 'module', name: 'rhwp-document-home-thumbnails' });
  return worker;
}

/** 일꾼을 내려 그 엔진의 메모리를 돌려준다. 홈을 닫을 때와 엔진이 멈췄을 때 부른다. */
export function releaseThumbnailWorker(): void {
  worker?.terminate();
  worker = null;
}

function renderInWorker(bytes: Uint8Array): Promise<ThumbnailWorkerResponse | null> {
  return new Promise((resolve) => {
    const target = thumbnailWorker();
    const id = ++sequence;
    let settled = false;
    const finish = (response: ThumbnailWorkerResponse | null, restart: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      target.removeEventListener('message', onMessage);
      target.removeEventListener('error', onError);
      if (restart && worker === target) releaseThumbnailWorker();
      resolve(response);
    };
    const onMessage = (event: MessageEvent<ThumbnailWorkerResponse>) => {
      if (event.data?.id !== id) return;
      finish(event.data, !event.data.ok && event.data.reason === 'trap');
    };
    const onError = () => finish(null, true);
    const timer = setTimeout(() => finish(null, true), THUMBNAIL_TIMEOUT_MS);
    target.addEventListener('message', onMessage);
    target.addEventListener('error', onError);
    const copy = bytes.slice();
    target.postMessage({ id, bytes: copy } satisfies ThumbnailWorkerRequest, [copy.buffer]);
  });
}

/**
 * 닫힌 문서의 바이트에서 첫 쪽을 그린다. 읽지 못하거나 엔진이 멈추면 null 이다 — 미리보기를
 * 못 그린 것은 문서가 망가졌다는 증거가 아니므로 목록은 그대로 둔다. 차례로 하나씩 처리한다.
 */
export function renderThumbnailFromBytes(bytes: Uint8Array): Promise<Blob | null> {
  const run = chain.then(async () => {
    if (bytes.byteLength > THUMBNAIL_SOURCE_MAX_BYTES) return null;
    const response = await renderInWorker(bytes);
    if (!response?.ok) return null;
    return rasterizeSvg(response.svg, response.width, response.height);
  });
  chain = run.catch(() => {});
  return run;
}
