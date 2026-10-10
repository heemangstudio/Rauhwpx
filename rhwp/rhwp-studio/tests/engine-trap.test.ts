import assert from 'node:assert/strict';
import test from 'node:test';
import {
  EngineTrappedError,
  engineTrap,
  guardEngineCalls,
  isEngineTrap,
  onEngineTrap,
  reportEngineTrap,
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

test('a stack overflow escaping an engine call is a trap, but still allows recovery exports', () => {
  resetEngineTrapForTests();
  const notices: string[] = [];
  onEngineTrap((info) => notices.push(info.message));
  let calls = 0;
  class DeepDocument {
    layout(): never {
      calls += 1;
      throw new RangeError('Maximum call stack size exceeded');
    }
    pageCount(): number {
      calls += 1;
      return 1;
    }
    exportHwp(): Uint8Array {
      return new Uint8Array([7]);
    }
    exportHwpx(): Uint8Array {
      return new Uint8Array([8]);
    }
  }
  guardEngineCalls(DeepDocument.prototype);
  const doc = new DeepDocument();

  let overflow: unknown;
  try {
    doc.layout();
  } catch (error) {
    overflow = error;
  }
  assert.ok(overflow instanceof RangeError);
  assert.equal(isEngineTrap(overflow), true, 'callers such as the agent executor see it as a trap');
  assert.deepEqual(notices, ['Maximum call stack size exceeded']);

  const before = calls;
  assert.throws(() => doc.pageCount(), EngineTrappedError);
  assert.equal(calls, before);
  assert.deepEqual([...doc.exportHwp()], [7]);
  assert.deepEqual([...doc.exportHwpx()], [8]);
  assert.equal(notices.length, 1);
});

test('a JavaScript stack overflow outside the engine does not stop it', () => {
  resetEngineTrapForTests();
  const { doc } = fakeEngine();
  const overflow = new RangeError('Maximum call stack size exceeded');
  assert.equal(isEngineTrap(overflow), false);
  assert.equal(reportEngineTrap(overflow), false);
  assert.equal(engineTrap(), null);
  assert.equal(doc.pageCount(), 3);
});

test('ordinary engine errors do not stop the engine', () => {
  resetEngineTrapForTests();
  const { doc } = fakeEngine();
  assert.throws(() => doc.invalidArgs(), /범위 초과/);
  assert.equal(engineTrap(), null);
  assert.equal(doc.pageCount(), 3);
});

test('after a trap, HML export and the source format still answer so every document can leave a recovery copy', () => {
  resetEngineTrapForTests();
  let entered = 0;
  class HmlDocument {
    getCursorRect(): never {
      throw new WebAssembly.RuntimeError('unreachable');
    }
    pageCount(): number {
      entered += 1;
      return 2;
    }
    getSourceFormat(): string {
      entered += 1;
      return 'hml';
    }
    exportHml(): Uint8Array {
      entered += 1;
      return new Uint8Array([0x3c]);
    }
  }
  guardEngineCalls(HmlDocument.prototype);
  const doc = new HmlDocument();

  assert.throws(() => doc.getCursorRect(), WebAssembly.RuntimeError);
  assert.equal(doc.getSourceFormat(), 'hml');
  assert.deepEqual([...doc.exportHml()], [0x3c]);
  assert.equal(entered, 2);
  assert.throws(() => doc.pageCount(), EngineTrappedError);
  assert.equal(entered, 2, 'other reads are still refused');
});
