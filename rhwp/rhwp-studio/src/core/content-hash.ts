/**
 * 문서 바이트의 BLAKE3 해시 (소문자 hex).
 *
 * 문서 digest·버전 지문·리소스 키가 모두 이 값을 쓴다. 문서를 바꿀 때 수 MB 바이트를 여러 번
 * 해시하므로, WASM 이 준비되면 엔진의 BLAKE3 로 계산한다 (JS 구현보다 훨씬 빠르다). 엔진이
 * 없거나(Node 테스트·워커) 멈췄으면 같은 결과를 내는 JS 구현을 쓴다.
 */
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { engineTrap, reportEngineTrap } from './engine-trap.ts';

export interface Blake3HasherLike {
  update(bytes: Uint8Array): void;
  finalizeHex(): string;
  free(): void;
}

/** 한 번에 WASM 메모리로 복사하는 조각 크기. 큰 문서도 엔진 메모리를 늘리지 않는다. */
const WASM_CHUNK_BYTES = 1 << 20;

let createWasmHasher: (() => Blake3HasherLike) | null = null;

/** WASM 초기화 때 엔진의 BLAKE3 해셔를 연결한다. null 이면 JS 구현으로 돌아간다. */
export function setBlake3WasmApi(create: (() => Blake3HasherLike) | null): void {
  createWasmHasher = create;
}

function wasmBlake3Hex(bytes: Uint8Array): string | null {
  if (!createWasmHasher || engineTrap()) return null;
  let hasher: Blake3HasherLike | null = null;
  try {
    hasher = createWasmHasher();
    for (let offset = 0; offset < bytes.byteLength; offset += WASM_CHUNK_BYTES) {
      hasher.update(bytes.subarray(offset, Math.min(bytes.byteLength, offset + WASM_CHUNK_BYTES)));
    }
    return hasher.finalizeHex();
  } catch (error) {
    // trap 이면 엔진을 멈춘 상태로 알린다 — 그 뒤의 wasm 호출은 믿을 수 없다. 해시는 JS 로 마저 낸다.
    if (!reportEngineTrap(error)) console.warn('[hash] WASM BLAKE3 실패, JS 구현으로 계산합니다:', error);
    return null;
  } finally {
    try { hasher?.free(); } catch { /* 이미 해제됨 */ }
  }
}

export function blake3Hex(bytes: Uint8Array): string {
  return wasmBlake3Hex(bytes) ?? bytesToHex(blake3(bytes));
}
