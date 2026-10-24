/// <reference lib="webworker" />
/**
 * 문서 홈의 첫 쪽 미리보기 일꾼. 자기 엔진(wasm 인스턴스)을 따로 가져서 열린 문서와 메모리·
 * trap 상태를 나누지 않는다. 문서를 읽어 첫 쪽을 SVG 로 내보내고 바로 내린다.
 *
 * 글자는 SVG 윤곽선으로 나가므로 일꾼 엔진에도 글꼴이 있어야 한다. 문서가 쓰는 글꼴을 번들 웹
 * 글꼴에서 골라 한 번씩 등록한다 (편집기와 같은 대응표).
 */
import init, { Engine, brotliDecompress } from '../../vendor/hm-wasm/hm_wasm.js';
import { resolveCanvasKitFontPlan } from '../core/font-loader.ts';
import { decodeWebFont, streamWebFontDecoders } from '../../../rhwp-shared/fonts/font-index-core.mjs';

export interface ThumbnailWorkerRequest {
  id: number;
  bytes: Uint8Array;
  /** 글꼴 상대 경로를 풀 앱 주소. */
  baseUrl?: string;
}

export type ThumbnailWorkerResponse =
  | { id: number; ok: true; svg: string; width: number; height: number }
  | { id: number; ok: false; reason: 'trap' | 'unreadable' };

const scope = self as unknown as DedicatedWorkerGlobalScope;
const FONT_MAX_BYTES = 32 * 1024 * 1024;
/** 문서 글꼴을 번들에서 찾지 못할 때 쓰는 기본 글꼴. */
const DEFAULT_FAMILIES = ['Noto Sans KR', 'Noto Serif KR'];

let engine: Promise<Engine> | null = null;
const fonts = new Map<string, Promise<Uint8Array | null>>();
const registered = new Set<string>();

function fontBytes(url: string): Promise<Uint8Array | null> {
  let pending = fonts.get(url);
  if (!pending) {
    pending = (async () => {
      const response = await fetch(url);
      if (!response.ok) return null;
      const bytes = new Uint8Array(await response.arrayBuffer());
      const decompress = { brotli: (data: Uint8Array, outLength: number) => brotliDecompress(data, outLength), ...streamWebFontDecoders() };
      return decodeWebFont(bytes, { decompress, maxBytes: FONT_MAX_BYTES });
    })().catch(() => null);
    fonts.set(url, pending);
  }
  return pending;
}

async function registerFonts(target: Engine, names: string[], baseUrl: string): Promise<void> {
  const plan = resolveCanvasKitFontPlan([...names, ...DEFAULT_FAMILIES]);
  await Promise.all(plan.sources.map(async source => {
    const url = new URL(source.url, baseUrl).href;
    if (registered.has(url)) return;
    const bytes = await fontBytes(url);
    if (!bytes || registered.has(url)) return;
    target.addFont(url, bytes);
    registered.add(url);
  }));
  // 앞서 등록한 글꼴에 이 문서의 글자 윤곽선이 없으면 다시 채운다.
  const refill = JSON.parse(target.outlineRequests()) as string[];
  await Promise.all(refill.map(async url => {
    const bytes = await fontBytes(url);
    if (bytes) target.addFont(url, bytes);
  }));
}

scope.onmessage = async (event: MessageEvent<ThumbnailWorkerRequest>) => {
  const { id, bytes, baseUrl = scope.location.href } = event.data;
  let doc: ReturnType<Engine['open']> | null = null;
  try {
    engine ??= init().then(() => new Engine());
    const target = await engine;
    doc = target.open(bytes);
    const requests = JSON.parse(doc.fontRequests()) as { faces: { name: string; candidates: string[] }[]; classDefaults: string[][] };
    const names = [...new Set([
      ...requests.faces.flatMap(face => [face.name, ...face.candidates]),
      ...(requests.classDefaults[0] ?? []),
    ])];
    await registerFonts(target, names, baseUrl);
    const page = JSON.parse(doc.pageInfo(0)) as { width: number; height: number };
    const svg = doc.pageSvg(0, 96);
    scope.postMessage({ id, ok: true, svg, width: page.width / 75, height: page.height / 75 } satisfies ThumbnailWorkerResponse);
  } catch (error) {
    const trap = error instanceof WebAssembly.RuntimeError
      || (error instanceof Error && /unreachable|memory access out of bounds|recursive use of an object/.test(error.message));
    scope.postMessage({ id, ok: false, reason: trap ? 'trap' : 'unreadable' } satisfies ThumbnailWorkerResponse);
  } finally {
    try { doc?.close(); doc?.free(); } catch { /* trap 뒤에는 일꾼을 새로 띄운다 */ }
  }
};
