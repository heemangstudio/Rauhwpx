/// <reference lib="webworker" />
/**
 * 다른 문서 미리 읽기 일꾼. 에이전트가 닫힌 문서를 읽기 전에, 창의 공유 엔진이 하는 그대로 문서를
 * 읽고 조판한 뒤 바로 내린다. 자기 엔진(wasm 인스턴스)을 따로 가져서 이 문서가 엔진을 멈춰도
 * 열린 문서와 상관이 없다 — 일꾼만 새로 띄운다.
 */
import init, { Engine } from '../../vendor/hm-wasm/hm_wasm.js';

export interface DocumentPreflightRequest {
  id: number;
  bytes: Uint8Array;
}

/**
 * stage:'ready' — 엔진 준비를 마치고 이 문서를 읽기 시작한다 (창은 이때부터 시간을 잰다).
 * unavailable — 엔진을 준비하지 못했다. 문서 탓이 아니므로 다음 요청이 다시 준비한다.
 */
export type DocumentPreflightResponse =
  | { id: number; stage: 'ready' }
  | { id: number; ok: true }
  | { id: number; ok: false; reason: 'trap' | 'unreadable' | 'unavailable' };

const scope = self as unknown as DedicatedWorkerGlobalScope;

let ready: Promise<Engine> | null = null;

scope.onmessage = async (event: MessageEvent<DocumentPreflightRequest>) => {
  const { id, bytes } = event.data;
  let engine: Engine;
  try {
    ready ??= init().then(() => new Engine());
    engine = await ready;
  } catch {
    ready = null;
    scope.postMessage({ id, ok: false, reason: 'unavailable' } satisfies DocumentPreflightResponse);
    return;
  }
  scope.postMessage({ id, stage: 'ready' } satisfies DocumentPreflightResponse);
  let doc: ReturnType<Engine['open']> | null = null;
  try {
    // WasmBridge.loadDocument 와 같은 순서 — 공유 엔진이 이 문서에서 밟을 길을 먼저 밟아 본다.
    doc = engine.open(bytes);
    doc.fontRequests();
    JSON.parse(doc.state());
    scope.postMessage({ id, ok: true } satisfies DocumentPreflightResponse);
  } catch (error) {
    const trap = error instanceof WebAssembly.RuntimeError
      || (error instanceof Error && /unreachable|memory access out of bounds|recursive use of an object|Maximum call stack/.test(error.message));
    scope.postMessage({ id, ok: false, reason: trap ? 'trap' : 'unreadable' } satisfies DocumentPreflightResponse);
  } finally {
    try { doc?.close(); doc?.free(); } catch { /* trap 뒤에는 일꾼을 새로 띄운다 */ }
  }
};
