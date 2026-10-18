import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { requireWasmPackage } from './browser-support.ts';
import { blake3Hex, setBlake3WasmApi } from '../src/core/content-hash.ts';
import { documentSourceDigest } from '../src/recent/document-preflight.ts';

const pkg = process.env.RHWP_WASM_PACKAGE_DIR
  ? pathToFileURL(`${process.env.RHWP_WASM_PACKAGE_DIR.replace(/[\\/]$/, '')}/`)
  : new URL('../../pkg/', import.meta.url);
requireWasmPackage(fileURLToPath(pkg));
const engine = await import(new URL('rhwp.js', pkg).href) as typeof import('../../pkg/rhwp.js');
engine.initSync({ module: readFileSync(new URL('rhwp_bg.wasm', pkg)) });

function sample(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  let state = 0x9e3779b9;
  for (let index = 0; index < length; index += 1) {
    state = (state * 1664525 + 1013904223) >>> 0;
    bytes[index] = state >>> 24;
  }
  return bytes;
}

// 문서 digest·버전 지문은 IndexedDB 와 최근 문서에 남는다. 엔진 해시가 기존 JS 해시와 한 글자라도
// 다르면 열어 둔 문서가 다른 문서로 보이고 버전 기록이 끊긴다.
test('engine BLAKE3 matches the stored JS digests across chunk boundaries', () => {
  assert.equal(typeof engine.Blake3Hasher, 'function', 'pkg 에 Blake3Hasher 가 없습니다 — npm run build:wasm');
  let created = 0;
  setBlake3WasmApi(() => {
    created += 1;
    return new engine.Blake3Hasher();
  });
  try {
    const whole = sample((3 << 20) + 17);
    for (const length of [0, 1, 1023, 1024, 1025, (1 << 20) - 1, 1 << 20, (1 << 20) + 1, whole.length]) {
      const bytes = whole.subarray(0, length);
      assert.equal(blake3Hex(bytes), bytesToHex(blake3(bytes)), `length ${length}`);
    }
    // 다른 버퍼 안의 조각(오프셋이 있는 view)도 그 조각만 해시한다.
    const view = whole.subarray(12345, 12345 + (2 << 20));
    assert.equal(documentSourceDigest(view), `blake3:${bytesToHex(blake3(view))}`);
    assert.ok(created > 0, '엔진 해셔를 쓰지 않았습니다');
  } finally {
    setBlake3WasmApi(null);
  }
});

test('falls back to the JS digest when the engine hasher fails', () => {
  const bytes = sample(4096);
  setBlake3WasmApi(() => { throw new Error('unavailable'); });
  const warn = console.warn;
  console.warn = () => {};
  try {
    assert.equal(blake3Hex(bytes), bytesToHex(blake3(bytes)));
  } finally {
    console.warn = warn;
    setBlake3WasmApi(null);
  }
});
