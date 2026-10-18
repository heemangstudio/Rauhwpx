import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';
import type { WasmBridge } from '../src/core/wasm-bridge.ts';
import { createTestModuleServer } from './support/module-server.ts';

// snapshot.ts 는 @/ 별칭을 쓰는 비교 엔진을 불러온다. 엔진 변경 번호를 같은 모듈 인스턴스로 보도록
// engine-trap.ts 도 같은 로더로 불러온다.
const modules = await createTestModuleServer();
const {
  ENGINE_MUTATING_READ_NAMES,
  ENGINE_READ_NAMES,
  engineMutationEpoch,
  guardEngineCalls,
  isEngineReadCall,
  resetEngineTrapForTests,
} = await modules.ssrLoadModule<typeof import('../src/core/engine-trap.ts')>('/src/core/engine-trap.ts');
const { VersionSnapshotCache } = await modules.ssrLoadModule<typeof import('../src/versioning/snapshot.ts')>('/src/versioning/snapshot.ts');

/** wasm_api.rs·wasm_api/ 의 엔진 메서드를 JS 이름과 receiver(`&self`/`&mut self`)로 모은다. */
function engineMethods(): { reads: string[]; writes: string[] } {
  const dir = new URL('../../src/wasm_api/', import.meta.url);
  const source = [
    readFileSync(new URL('../../src/wasm_api.rs', import.meta.url), 'utf8'),
    ...readdirSync(dir).filter((name) => name.endsWith('.rs') && !name.endsWith('tests.rs'))
      .map((name) => readFileSync(new URL(name, dir), 'utf8')),
  ].join('\n');
  // 속성 줄(#[...])이 붙은 것도, #[wasm_bindgen] impl 안의 맨 메서드도 모두 잡는다.
  const pattern = /((?:[ \t]*#\[[^\n]*\]\s*\n)*)[ \t]*pub fn (\w+)\s*(?:<[^>]*>)?\(\s*(&mut self|&self)/g;
  const camel = (name: string) => name.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
  const reads: string[] = [];
  const writes: string[] = [];
  for (const match of source.matchAll(pattern)) {
    const jsName = /js_name\s*=\s*"?(\w+)"?/.exec(match[1] ?? '')?.[1] ?? camel(match[2]!);
    (match[3] === '&mut self' ? writes : reads).push(jsName);
  }
  return { reads, writes };
}

// 버전 지문 캐시는 읽기 호출만 있었으면 다시 내보내지 않는다. `&mut self` 엔진 메서드를 읽기로 잘못
// 보면 편집 뒤에도 옛 바이트로 비교·커밋하게 된다.
test('every engine method treated as a read takes &self in wasm_api.rs', () => {
  const { reads, writes } = engineMethods();
  assert.ok(writes.length > 50 && reads.length > 50, 'wasm_api.rs 메서드를 읽지 못했습니다');
  assert.ok(writes.includes('insertText') && writes.includes('setFileName') && reads.includes('exportHwp'));
  assert.deepEqual(writes.filter((name) => isEngineReadCall(name)), []);
  for (const name of ENGINE_READ_NAMES) assert.ok(reads.includes(name) && !writes.includes(name), `${name} 은 &self 가 아닙니다`);
  for (const name of ENGINE_MUTATING_READ_NAMES) assert.ok(writes.includes(name), `${name} 은 더 이상 &mut self 가 아닙니다`);
  assert.ok(isEngineReadCall('exportHwp') && isEngineReadCall('getPageInfo') && !isEngineReadCall('insertText'));
});

function fakeBridge() {
  let content = 1;
  let exports = 0;
  class FakeDocument {
    exportHwp(): Uint8Array {
      exports += 1;
      return new Uint8Array([0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1, content]);
    }
    getPageInfo(): string { return '{}'; }
    insertText(): void { content += 1; }
    setFileName(): void {}
  }
  guardEngineCalls(FakeDocument.prototype);
  const doc = new FakeDocument();
  const wasm = {
    fileName: 'a.hwp',
    currentFileHandle: null,
    getSourceFormat: () => 'hwp',
    exportHwp: () => doc.exportHwp(),
  } as unknown as WasmBridge;
  return { doc, wasm, exports: () => exports };
}

test('re-checking the working tree exports again only after an engine write', () => {
  resetEngineTrapForTests();
  const { doc, wasm, exports } = fakeBridge();
  const cache = new VersionSnapshotCache();
  try {
    const loaded = cache.content(wasm, 'doc', 0);
    doc.getPageInfo();
    assert.equal(cache.reexport(wasm, 'doc', 0), loaded, '읽기만 있었으면 같은 내용을 쓴다');
    assert.equal(exports(), 1);

    // 이벤트 없이(같은 revision) 엔진이 바뀌어도 다시 내보내 새 내용을 본다.
    const before = engineMutationEpoch();
    doc.insertText();
    assert.ok(engineMutationEpoch() > before);
    const changed = cache.reexport(wasm, 'doc', 0);
    assert.equal(exports(), 2);
    assert.notEqual(changed.fingerprint, loaded.fingerprint);
    assert.equal(cache.fingerprint(wasm, 'doc', 0), changed.fingerprint);

    // 다른 문서의 쓰기도 보수적으로 다시 내보내게 한다.
    doc.setFileName();
    cache.reexport(wasm, 'doc', 0);
    assert.equal(exports(), 3);
  } finally {
    cache.clear();
  }
});
