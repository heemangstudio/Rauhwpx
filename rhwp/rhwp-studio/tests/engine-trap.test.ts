import assert from 'node:assert/strict';
import test from 'node:test';
import {
  EngineTrappedError,
  engineTrap,
  guardEngineCalls,
  onEngineTrap,
  resetEngineTrapForTests,
} from '../src/core/engine-trap.ts';

function fakeEngine() {
  let calls = 0;
  class FakeDocument {
    pageCount(): number {
      calls += 1;
      return 3;
    }
    getCursorRect(): string {
      calls += 1;
      throw new WebAssembly.RuntimeError('unreachable');
    }
    exportHwpx(): Uint8Array {
      return new Uint8Array([1, 2, 3]);
    }
    invalidArgs(): never {
      throw new Error('paraIdx 99 범위 초과');
    }
  }
  guardEngineCalls(FakeDocument.prototype);
  return { doc: new FakeDocument(), calls: () => calls };
}

test('a wasm trap stops later engine calls but still allows exporting a copy', () => {
  resetEngineTrapForTests();
  const notices: string[] = [];
  onEngineTrap((info) => notices.push(info.message));
  const { doc, calls } = fakeEngine();

  assert.equal(doc.pageCount(), 3);
  assert.throws(() => doc.getCursorRect(), WebAssembly.RuntimeError);
  assert.deepEqual(notices, ['unreachable']);
  assert.equal(engineTrap()?.message, 'unreachable');

  const before = calls();
  assert.throws(() => doc.pageCount(), EngineTrappedError);
  assert.equal(calls(), before, 'the trapped instance is not entered again');
  assert.deepEqual([...doc.exportHwpx()], [1, 2, 3]);
  assert.equal(notices.length, 1, 'the trap is announced once');
});

test('ordinary engine errors do not stop the engine', () => {
  resetEngineTrapForTests();
  const { doc } = fakeEngine();
  assert.throws(() => doc.invalidArgs(), /범위 초과/);
  assert.equal(engineTrap(), null);
  assert.equal(doc.pageCount(), 3);
});
