import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import test, { type TestContext } from 'node:test';

import { createTestModuleServer } from './support/module-server.ts';

// 실제 예약/취소 메서드를 가짜 clock으로 실행한다. WASM/GPU 속도와 무관한 작업 예산 계약.
const studioRoot = fileURLToPath(new URL('../', import.meta.url));
const vite = await createTestModuleServer(studioRoot);
const { CanvasView } = await vite.ssrLoadModule('/src/view/canvas-view.ts') as typeof import('../src/view/canvas-view.ts');
test.after(() => vite.close());

function fixture(t: TestContext) {
  const idle = new Map<number, () => void>();
  const timers = new Map<number, () => void>();
  const renders: number[] = [];
  const active = new Set<number>();
  let id = 0;
  let now = 0;
  const window = {
    requestIdleCallback(callback: () => void) { idle.set(++id, callback); return id; },
    cancelIdleCallback(id: number) { idle.delete(id); },
    setTimeout(callback: () => void) { timers.set(++id, callback); return id; },
  };
  const g = globalThis as Record<string, unknown>;
  const saved = { window: g.window, performance: g.performance, clearTimeout: g.clearTimeout };
  g.window = window;
  Object.defineProperty(globalThis, 'performance', { value: { now: () => now }, configurable: true, writable: true });
  g.clearTimeout = (id: number) => timers.delete(id);
  t.after(() => {
    g.window = saved.window;
    Object.defineProperty(globalThis, 'performance', { value: saved.performance, configurable: true, writable: true });
    g.clearTimeout = saved.clearTimeout;
  });
  const view = Object.assign(Object.create(CanvasView.prototype), {
    pendingPrefetchPages: new Set<number>(), deferredPrefetchTask: null,
    disposed: false, lastMutationTime: -Infinity,
    canvasPool: { has: (page: number) => active.has(page) },
    renderPage(page: number) { renders.push(page); active.add(page); },
  });
  const run = (jobs: Map<number, () => void>) => {
    const callbacks = [...jobs.values()]; jobs.clear(); callbacks.forEach(callback => callback());
  };
  return { view, idle, timers, renders, active, time(value: number) { now = value; },
    idleFrame: () => run(idle), timer: () => run(timers) };
}

test('offscreen work renders at most one page per idle callback', (t) => {
  const f = fixture(t);
  f.view.schedulePrefetchPages([1, 2, 3, 4]);
  f.idleFrame();
  assert.deepEqual(f.renders, [1]);
  assert.equal(f.idle.size, 1);
  f.idleFrame();
  assert.deepEqual(f.renders, [1, 2]);
});

test('a continuous edit burst defers prefetch until editing is quiet', (t) => {
  const f = fixture(t);
  f.view.lastMutationTime = 0;
  f.view.schedulePrefetchPages([1, 2]);
  f.idleFrame();
  for (let i = 1; i <= 20; i++) {
    f.time(i * 150); f.view.lastMutationTime = i * 150;
    f.timer();
  }
  assert.deepEqual(f.renders, []);
  assert.equal(f.timers.size, 1);
  f.time(3_200); f.timer();
  assert.deepEqual(f.renders, [1]);
  f.idleFrame();
  assert.deepEqual(f.renders, [1, 2]);
});

test('scroll replacement drops obsolete queued pages and cancellation stops resumed work', (t) => {
  const f = fixture(t);
  f.view.schedulePrefetchPages([1, 2, 3]);
  f.view.schedulePrefetchPages([8, 9]);
  f.idleFrame();
  assert.deepEqual(f.renders, [8]);
  f.view.cancelPendingPrefetch();
  f.idleFrame();
  assert.deepEqual(f.renders, [8]);
  f.view.lastMutationTime = 0;
  f.view.schedulePrefetchPages([10]); f.idleFrame();
  f.view.cancelPendingPrefetch(); f.time(1_000); f.timer();
  assert.deepEqual(f.renders, [8]);
});
