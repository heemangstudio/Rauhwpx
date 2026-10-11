/// <reference lib="webworker" />
/**
 * 문서 홈의 첫 쪽 미리보기 일꾼. 자기 엔진(wasm 인스턴스)을 따로 가져서 열린 문서와 메모리·
 * trap 상태를 나누지 않는다. 문서를 읽어 첫 쪽을 SVG 로 내보내고 바로 내린다.
 */
import init, { HwpDocument } from '@wasm/rhwp.js';
import { DEFAULT_FONT_METRICS_POLICY } from '../core/font-metrics-policy.ts';

export interface ThumbnailWorkerRequest {
  id: number;
  bytes: Uint8Array;
}

export type ThumbnailWorkerResponse =
  | { id: number; ok: true; svg: string; width: number; height: number }
  | { id: number; ok: false; reason: 'trap' | 'unreadable' };

const scope = self as unknown as DedicatedWorkerGlobalScope;
// 수식 글꼴 측정은 편집기 창에만 있다. 없다고 알리면 엔진이 기본 진행폭을 쓴다.
const globals = scope as unknown as Record<string, unknown>;
globals.measureEquationTextMetrics ??= () => null;
globals.resolveEquationFontFamily ??= () => null;
globals.resolveEquationLiteralFont ??= () => null;

let ready: Promise<unknown> | null = null;

scope.onmessage = async (event: MessageEvent<ThumbnailWorkerRequest>) => {
  const { id, bytes } = event.data;
  let doc: HwpDocument | null = null;
  try {
    ready ??= init();
    await ready;
    doc = HwpDocument.fromBytesWithFontMetrics(bytes, DEFAULT_FONT_METRICS_POLICY);
    const page = JSON.parse(doc.getPageInfo(0)) as { width?: number; height?: number };
    const svg = doc.renderPageSvg(0);
    scope.postMessage({ id, ok: true, svg, width: page.width ?? 0, height: page.height ?? 0 } satisfies ThumbnailWorkerResponse);
  } catch (error) {
    const trap = error instanceof WebAssembly.RuntimeError
      || (error instanceof Error && /unreachable|memory access out of bounds|recursive use of an object/.test(error.message));
    scope.postMessage({ id, ok: false, reason: trap ? 'trap' : 'unreadable' } satisfies ThumbnailWorkerResponse);
  } finally {
    try { doc?.free(); } catch { /* trap 뒤에는 일꾼을 새로 띄운다 */ }
  }
};
