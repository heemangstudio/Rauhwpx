/**
 * 대기 편집 오버레이는 그려질 쪽에 걸친 편집만 잰다. 화면 밖 쪽의 편집은 그 쪽이 화면에 들어오는
 * 사영에서 바로 재고 그린다 — 스크롤로 닿은 쪽의 표시가 한 프레임 늦게 나타나지 않는다.
 */
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

registerHooks({
  load(url, context, next) {
    return url.endsWith('.css')
      ? { format: 'module', source: 'export default {};', shortCircuit: true }
      : next(url, context);
  },
});

/** 오버레이가 쓰는 만큼만 흉내 낸 DOM 요소. */
class FakeElement {
  children: FakeElement[] = [];
  parentElement: FakeElement | null = null;
  className = '';
  hidden = false;
  textContent = '';
  clientWidth = 800;
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  classList = { add() {}, remove() {}, contains: () => false };
  setAttribute() {}
  addEventListener() {}
  removeEventListener() {}
  querySelector() { return null; }
  getBoundingClientRect() { return { left: 0, top: 0 }; }
  append(...nodes: FakeElement[]) { for (const node of nodes) this.appendChild(node); }
  appendChild(node: FakeElement) {
    node.remove();
    node.parentElement = this;
    this.children.push(node);
    return node;
  }
  remove() {
    const parent = this.parentElement;
    if (!parent) return;
    parent.children = parent.children.filter((child) => child !== this);
    this.parentElement = null;
  }
}

const scrollContent = new FakeElement();
Object.defineProperty(globalThis, 'document', {
  configurable: true,
  value: {
    createElement: () => new FakeElement(),
    createElementNS: () => new FakeElement(),
    getElementById: (id: string) => (id === 'scroll-content' ? scrollContent : null),
    addEventListener() {},
    removeEventListener() {},
  },
});

const { PendingOverlayRenderer } = await import('../src/agent/pending-overlay.ts');
const { EventBus } = await import('../src/core/event-bus.ts');

const PAGE_HEIGHT = 1000;
const PAGE_COUNT = 60;

/** 문단 i 는 쪽 i 에 있다. 범위를 잰 횟수를 문단마다 센다. */
function fixture() {
  const probes = new Map<number, number>();
  const wasm = {
    getParagraphPages: (_sec: number, para: number) => [para],
    getParagraphLength: () => 10,
    getTextRange: (_sec: number, _para: number, _start: number, count: number) => 'x'.repeat(count),
    textToLogicalOffset: (_sec: number, _para: number, offset: number) => offset,
    getSelectionRects: (_sec: number, startPara: number) => {
      probes.set(startPara, (probes.get(startPara) ?? 0) + 1);
      return [{ pageIndex: startPara, x: 10, y: 20, width: 30, height: 12 }];
    },
    getCursorRect: (_sec: number, para: number) => ({ pageIndex: para, x: 40, y: 20, height: 12 }),
  };
  let scrollY = 0;
  const canvasView = {
    getViewportManager: () => ({
      getZoom: () => 1,
      getViewportSize: () => ({ width: 800, height: 600 }),
      getScrollX: () => 0,
      getScrollY: () => scrollY,
    }),
    getVirtualScroll: () => ({
      pageCount: PAGE_COUNT,
      getPageLeft: () => 0,
      getPageWidth: () => 800,
      getPageOffset: (page: number) => page * PAGE_HEIGHT,
      getPageWindow: (y: number) => ({ prefetch: [Math.floor(y / PAGE_HEIGHT)] }),
    }),
  };
  const eventBus = new EventBus();
  const overlay = new PendingOverlayRenderer({
    canvasView: canvasView as never,
    wasm: wasm as never,
    eventBus,
    getCaretPosition: () => null,
  });
  const insertAt = (para: number) => ({
    kind: 'insert' as const,
    agent: 'claude' as const,
    opId: `op-${para}`,
    range: { sectionIdx: 0, startParaIdx: para, startCharOffset: 0, endParaIdx: para, endCharOffset: 4 },
  });
  /** 화면에 그려진 표시의 문서 y 좌표. */
  const painted = () => scrollContent.children
    .flatMap((layer) => layer.children)
    .filter((node) => node.className.includes('ag-pending-marker'))
    .map((node) => Number.parseFloat(node.style.top));
  const scrollTo = (page: number) => {
    scrollY = page * PAGE_HEIGHT;
    eventBus.emit('viewport-scroll');
  };
  return { overlay, eventBus, probes, insertAt, painted, scrollTo };
}

test('pending edits on offscreen pages are measured and drawn in the projection that scrolls them into view', () => {
  const f = fixture();
  try {
    f.overlay.setOps([f.insertAt(0), f.insertAt(50)]);
    assert.deepEqual(f.painted(), [20], 'the first page shows its highlight');
    assert.equal(f.probes.get(50) ?? 0, 0, 'the edit 50 pages away is not measured while offscreen');

    f.scrollTo(50);
    assert.deepEqual(f.painted(), [50 * PAGE_HEIGHT + 20], 'the far page shows its highlight in the same projection');
    assert.equal(f.probes.get(50), 1);

    // 문서가 바뀌면 지금 그려질 쪽의 편집만 다시 잰다.
    const before = f.probes.get(0) ?? 0;
    f.eventBus.emit('document-changed');
    assert.deepEqual(f.painted(), [50 * PAGE_HEIGHT + 20]);
    assert.equal(f.probes.get(50), 2);
    assert.equal(f.probes.get(0) ?? 0, before, 'the offscreen first page is not re-measured');

    f.scrollTo(0);
    assert.deepEqual(f.painted(), [20], 'scrolling back draws the first page from a fresh measurement');
  } finally {
    f.overlay.dispose();
  }
});
