import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createTestModuleServer } from './support/module-server.ts';
import test from 'node:test';

import { EventBus } from '../src/core/event-bus.ts';
import { CanvasPool } from '../src/view/canvas-pool.ts';
import { RendererSession } from '../src/view/renderer-session.ts';
import { VirtualScroll } from '../src/view/virtual-scroll.ts';

const modules = await createTestModuleServer(fileURLToPath(new URL('../', import.meta.url)));
const { CanvasView } = await modules.ssrLoadModule('/src/view/canvas-view.ts');
const { reportEngineTrap, resetEngineTrapForTests } = await modules.ssrLoadModule('/src/core/engine-trap.ts');
await modules.close();

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function fixture() {
  const previousWindow = (globalThis as any).window;
  const previousDocument = (globalThis as any).document;
  (globalThis as any).window = { innerWidth: 1440 };
  (globalThis as any).document = {
    createElement() { return { parentElement: null, width: 0, height: 0 }; },
  };
  const state = { trapped: false, loaded: true, document: 'A', count: 20, reads: [] as string[] };
  const started = deferred<void>();
  const rendererGate = deferred<any>();
  const renderer = {
    resetDocumentResources() {}, cancelDocumentPreparation() {}, dispose() {},
  };
  const session = new RendererSession(
    { backend: 'canvaskit', source: 'url', requested: 'canvaskit' },
    { mode: 'default', source: 'default' },
    { preference: 'auto', requested: 'auto' },
    'screen',
    () => { started.resolve(); return rendererGate.promise; },
  );
  const children: any[] = [];
  const scroll = { x: 0, y: 0 };
  const scrollContent = {
    style: {} as Record<string, string>,
    classList: { toggle() {} },
    appendChild(canvas: any) { canvas.parentElement = scrollContent; children.push(canvas); },
    removeChild(canvas: any) { canvas.parentElement = null; children.splice(children.indexOf(canvas), 1); },
    replaceChildren() { for (const canvas of children.splice(0)) canvas.parentElement = null; },
  };
  const pool = new CanvasPool();
  const bus = new EventBus();
  const pending: Promise<void>[] = [];
  const paints: Array<{ document: string; page: number; canvas: any }> = [];
  const view = Object.assign(Object.create(CanvasView.prototype), {
    disposed: false, pages: [], currentVisiblePages: [], pendingPrefetchPages: new Set(),
    rendererSelectionEpoch: 0, rendererFallbackScheduled: false, documentLoadPrepared: false,
    activeRendererDecisionKey: null, documentRenderGeneration: 0, editingPageIndex: null,
    activePageSnapshot: null, layoutViewportSize: { width: 940, height: 1100 },
    container: { clientWidth: 940 }, scrollContent, canvasPool: pool,
    virtualScroll: new VirtualScroll(), rendererSession: session, eventBus: bus,
    subsecondRevisionWatcher: { stop() {} }, unsubscribers: [],
    wasm: {
      get documentDigest() { return state.document; },
      hasLoadedDocument() { return state.loaded; },
      get pageCount() { state.reads.push(state.document); return state.count; },
      getAllPageInfo() {
        state.reads.push(state.document);
        return Array.from({ length: state.count }, (_, pageIndex) => ({
          pageIndex, width: 1028, height: 1489, sectionIndex: 0,
        }));
      },
    },
    viewportManager: {
      getZoom() { return 1; }, getScrollX() { return scroll.x; }, getScrollY() { return scroll.y; },
      getViewportSize() { return { width: 940, height: 1100 }; }, detach() {},
      setScrollTop(value: number) { scroll.y = value; },
      setScrollLeft(value: number) { scroll.x = value; },
      clampScrollToContent(width: number, height: number) {
        scroll.x = Math.max(0, Math.min(scroll.x, width - 940));
        scroll.y = Math.max(0, Math.min(scroll.y, height - 1100));
      },
    },
    pageRenderer: {
      backend: 'canvas2d',
      configure(backend: string) { const changed = this.backend !== backend; this.backend = backend; return changed; },
      invalidateDocumentRevision() {}, noteDocumentContentChanged() {}, cancelAll() {}, dispose() {},
    },
    cancelAutoRendererReselection() {}, cancelScheduledMutationRefresh() {},
    cancelTextEditStaticLayerVerification() {}, cancelPendingPrefetch() {},
    releaseAllRenderedPages() { pool.releaseAll(); },
    releaseRenderedPage(page: number) { pool.release(page); },
    releaseFailedRender(page: number) { pool.release(page); },
    renderCanvas(page: number, canvas: any) {
      canvas.width = 1028; canvas.height = 1489;
      paints.push({ document: state.document, page, canvas }); return true;
    },
    schedulePrefetchPages() {}, updateActivePageSnapshot() {},
    renderHeaderFooterEditOverlays() {}, syncPageDetails() {},
  });
  const refresh = view.refreshPagesForRevision.bind(view);
  view.refreshPagesForRevision = () => { const promise = refresh(); pending.push(promise); return promise; };
  bus.on('document-view-changed', () => { void view.refreshPagesForRevision(); });
  return {
    view, state, bus, pool, paints, pending, started: started.promise,
    release() { rendererGate.resolve(renderer); },
    close() {
      session.dispose();
      resetEngineTrapForTests();
      (globalThis as any).window = previousWindow;
      (globalThis as any).document = previousDocument;
    },
  };
}

function assertInitialized(f: ReturnType<typeof fixture>, count: number, document: string) {
  assert.equal(f.view.pages.length, count);
  assert.equal(f.view.virtualScroll.pageCount, count);
  assert.ok(f.pool.activePages.length > 0, '현재 문서의 보이는 쪽 canvas 를 만들어야 한다');
  assert.ok(f.paints.length > 0, '쪽 paint 끝점까지 도달해야 한다');
  assert.ok(f.paints.every((p) => p.document === document));
}

test('같은 문서의 글꼴 뷰 revision 이 초기 선택을 대체해도 쪽과 paint 를 초기화한다', async () => {
  const f = fixture();
  try {
    const opening = f.view.loadDocument();
    await f.started;
    f.bus.emit('document-view-changed');
    f.release();
    await Promise.all([opening, ...f.pending]);
    assertInitialized(f, 20, 'A');
    assert.equal(f.view.pageRenderer.backend, 'canvaskit');
    assert.equal(f.view.rendererSession.diagnostics()?.documentRevision, 2);
  } finally { f.close(); }
});

test('이미 초기화한 문서의 뷰 revision 은 기존 canvas 를 재사용한다', async () => {
  const f = fixture();
  try {
    const opening = f.view.loadDocument(); await f.started; f.release(); await opening;
    assertInitialized(f, 20, 'A');
    const canvas = f.pool.getCanvas(0);
    f.bus.emit('document-view-changed'); await Promise.all(f.pending);
    assertInitialized(f, 20, 'A');
    assert.equal(f.pool.getCanvas(0), canvas);
  } finally { f.close(); }
});

test('선택 대기 중 문서를 교체하면 이전 문서의 load 와 뷰 revision 은 paint 하지 않는다', async () => {
  const f = fixture();
  try {
    const opening = f.view.loadDocument(); await f.started;
    f.bus.emit('document-view-changed');
    f.state.document = 'B'; f.state.count = 4; f.view.prepareDocumentLoad();
    f.release(); await Promise.all([opening, ...f.pending]);
    assert.equal(f.view.pages.length, 0);
    assert.equal(f.view.virtualScroll.pageCount, 0);
    assert.equal(f.paints.length, 0);
    assert.deepEqual(f.state.reads, [], '대체된 문서의 비동기 선택은 새 문서도 읽지 않는다');
    await f.view.loadDocument(); assertInitialized(f, 4, 'B');
  } finally { f.close(); }
});

test('선택 대기 중 폐기하면 load 와 뷰 revision 이 쪽을 되살리지 않는다', async () => {
  const f = fixture();
  try {
    const opening = f.view.loadDocument(); await f.started;
    f.bus.emit('document-view-changed');
    f.view.dispose(); f.release();
    await Promise.all([opening, ...f.pending]);
    assert.equal(f.view.pages.length, 0); assert.equal(f.paints.length, 0);
    assert.deepEqual(f.state.reads, []);
  } finally { f.close(); }
});

test('문서 미로드·폐기·trap 상태에서는 빈 쪽 갱신이 엔진을 부르지 않는다', () => {
  for (const blocked of ['unloaded', 'disposed', 'trap']) {
    const f = fixture();
    try {
      if (blocked === 'unloaded') f.state.loaded = false;
      if (blocked === 'disposed') f.view.disposed = true;
      if (blocked === 'trap') reportEngineTrap(new WebAssembly.RuntimeError('unreachable'));
      f.view.refreshPages();
      assert.deepEqual(f.state.reads, [], blocked);
      assert.equal(f.paints.length, 0);
    } finally { f.close(); }
  }
});

// 이전 문서의 실제 virtual 배치와 viewport를 보존한 뒤 새 문서 로드를 시작한다.
function setPreviousViewport(f: ReturnType<typeof fixture>, mobile = false) {
  const width = mobile ? 640 : 940;
  const height = mobile ? 900 : 1100;
  let zoom = mobile ? 2 : 1;
  let x = 300;
  let y = 5000;
  const manager = f.view.viewportManager;
  manager.getZoom = () => zoom;
  manager.setZoom = (value: number) => { zoom = value; };
  manager.getScrollX = () => x;
  manager.getScrollY = () => y;
  manager.setScrollLeft = (value: number) => { x = value; };
  manager.setScrollTop = (value: number) => { y = value; };
  manager.getViewportSize = () => ({ width, height });
  manager.clampScrollToContent = (w: number, h: number) => {
    x = Math.max(0, Math.min(x, w - width));
    y = Math.max(0, Math.min(y, h - height));
  };
  f.view.container.clientWidth = width;
  f.view.layoutViewportSize = { width, height };
  (globalThis as any).window.innerWidth = mobile ? 700 : 1440;
  f.view.virtualScroll.setPageDimensions(
    Array.from({ length: 30 }, (_, pageIndex) => ({
      pageIndex, width: 1800, height: 2000, sectionIndex: 0,
    })), zoom, width, undefined, 'vertical', height,
  );
  return {
    get zoom() { return zoom; }, get x() { return x; }, get y() { return y; },
    expectedZoom: mobile ? (width - 20) / 1028 : 1,
    expectedCenter: () => f.view.virtualScroll.getCenteredScrollLeft(width),
  };
}

for (const race of [false, true]) {
  test(`새 문서 ${race ? 'revision 경합' : '일반 로드'}는 이전 문서 스크롤을 초기화한다`, async () => {
    const f = fixture();
    try {
      const viewport = setPreviousViewport(f);
      const opening = f.view.loadDocument(); await f.started;
      if (race) f.bus.emit('document-view-changed');
      f.release(); await Promise.all([opening, ...f.pending]);
      assertInitialized(f, 20, 'A');
      assert.equal(viewport.y, 0, '새 문서는 이전 문서의 세로 스크롤을 유지하면 안 된다');
      assert.equal(viewport.x, viewport.expectedCenter(), '새 문서는 가로 가운데에서 시작해야 한다');
      assert.ok(f.pool.has(0), '새 문서 첫 쪽을 실제 보이는 쪽으로 만든다');
    } finally { f.close(); }
  });

  test(`되살린 문서 ${race ? 'revision 경합' : '일반 로드'}는 저장한 스크롤과 배율을 적용한다`, async () => {
    const f = fixture();
    try {
      const viewport = setPreviousViewport(f, true);
      const opening = f.view.loadDocument({ scrollTop: 900, scrollLeft: 80, zoom: 1.25 });
      await f.started;
      if (race) f.bus.emit('document-view-changed');
      f.release(); await Promise.all([opening, ...f.pending]);
      assertInitialized(f, 20, 'A');
      assert.deepEqual({ x: viewport.x, y: viewport.y, zoom: viewport.zoom }, { x: 80, y: 900, zoom: 1.25 });
    } finally { f.close(); }
  });

  test(`모바일 새 문서 ${race ? 'revision 경합' : '일반 로드'}는 폭 맞춤을 적용한다`, async () => {
    const f = fixture();
    try {
      const viewport = setPreviousViewport(f, true);
      const opening = f.view.loadDocument(); await f.started;
      if (race) f.bus.emit('document-view-changed');
      f.release(); await Promise.all([opening, ...f.pending]);
      assertInitialized(f, 20, 'A');
      assert.equal(viewport.zoom, viewport.expectedZoom, '모바일 첫 배치는 새 용지 폭으로 맞춰야 한다');
      assert.equal(viewport.y, 0);
      assert.equal(viewport.x, viewport.expectedCenter());
    } finally { f.close(); }
  });
}


test('초기화된 문서의 일반 뷰 revision 은 scroll 과 zoom 을 유지한다', async () => {
  const f = fixture();
  try {
    const viewport = setPreviousViewport(f);
    const opening = f.view.loadDocument(); await f.started; f.release(); await opening;
    f.view.viewportManager.setScrollLeft(100);
    f.view.viewportManager.setScrollTop(5000);
    f.view.updateVisiblePages();
    const before = { x: viewport.x, y: viewport.y, zoom: viewport.zoom };
    f.bus.emit('document-view-changed'); await Promise.all(f.pending);
    assertInitialized(f, 20, 'A');
    assert.deepEqual({ x: viewport.x, y: viewport.y, zoom: viewport.zoom }, before);
  } finally { f.close(); }
});
