import assert from 'node:assert/strict';
import test from 'node:test';
import type { WasmBridge } from '../src/core/wasm-bridge.ts';
import { createTestModuleServer } from './support/module-server.ts';

// snapshot.ts 는 @/ 별칭을 쓰는 비교 엔진을 불러온다. 엔진 변경 번호를 같은 모듈 인스턴스로 보도록
// engine-trap.ts 도 같은 로더로 불러온다.
const modules = await createTestModuleServer();
const {
  engineMutationEpoch,
  guardEngineCalls,
  resetEngineTrapForTests,
} = await modules.ssrLoadModule<typeof import('../src/core/engine-trap.ts')>('/src/core/engine-trap.ts');
const { VersionSnapshotCache } = await modules.ssrLoadModule<typeof import('../src/versioning/snapshot.ts')>('/src/versioning/snapshot.ts');

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
