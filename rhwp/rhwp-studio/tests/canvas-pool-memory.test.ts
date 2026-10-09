import test from 'node:test';
import assert from 'node:assert/strict';
import { CanvasPool } from '../src/view/canvas-pool.ts';

class FakeCanvas {
  width = 300;
  height = 150;
  parentElement: { removeChild: (canvas: FakeCanvas) => void } | null = null;
}

function installFakeDocument() {
  const hadDocument = 'document' in globalThis;
  const previous = globalThis.document;
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      createElement(tag: string) {
        assert.equal(tag, 'canvas');
        return new FakeCanvas();
      },
    },
  });
  return () => {
    if (!hadDocument) {
      Reflect.deleteProperty(globalThis, 'document');
      return;
    }
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: previous,
    });
  };
}

test('released canvases are reused without keeping their backing stores', () => {
  const restore = installFakeDocument();
  try {
    const pool = new CanvasPool();
    const canvases = Array.from({ length: 3 }, (_, page) => {
      const canvas = pool.acquire(page) as unknown as FakeCanvas;
      canvas.width = 2400;
      canvas.height = 3400;
      return canvas;
    });

    for (let page = 0; page < canvases.length; page++) pool.release(page);
    assert.equal(pool.totalCount, 3);
    assert.equal(pool.retainedBackingBytes, 0);
    assert.ok(canvases.every((canvas) => canvas.width === 0 && canvas.height === 0));

    const reused = pool.acquire(9) as unknown as FakeCanvas;
    assert.ok(canvases.includes(reused), 'a released canvas element should be reused');
  } finally {
    restore();
  }
});

test('CanvasKit replacement releases the detached original backing store', () => {
  const restore = installFakeDocument();
  try {
    const pool = new CanvasPool();
    const current = pool.acquire(2) as unknown as FakeCanvas;
    current.width = 1200;
    current.height = 1600;
    let removed = false;
    current.parentElement = {
      removeChild(canvas) {
        assert.equal(canvas, current);
        removed = true;
        current.parentElement = null;
      },
    };
    const replacement = new FakeCanvas();

    pool.replace(
      2,
      current as unknown as HTMLCanvasElement,
      replacement as unknown as HTMLCanvasElement,
    );
    assert.equal(removed, true);
    assert.equal(current.width, 0);
    assert.equal(current.height, 0);
    assert.equal(pool.getCanvas(2), replacement);
  } finally {
    restore();
  }
});

test('long documents do not retain one canvas element per page', () => {
  const restore = installFakeDocument();
  try {
    const pool = new CanvasPool();
    for (let page = 0; page < 100; page++) pool.acquire(page);
    for (let page = 0; page < 100; page++) pool.release(page);
    assert.ok(pool.totalCount <= 8, `warm canvas pool grew to ${pool.totalCount}`);
    assert.equal(pool.retainedBackingBytes, 0);
  } finally {
    restore();
  }
});
