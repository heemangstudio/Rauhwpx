import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { ViewportManager } from '../src/view/viewport-manager.ts';
import { createTestModuleServer } from './support/module-server.ts';

// 쪽 canvas 수명과 화면 좌표가 문서 변화·렌더 실패 뒤에도 어긋나지 않는 계약.

test('렌더에 실패한 canvas 는 지연 재렌더를 끊은 뒤에만 pool 로 돌아간다', async () => {
  // 실패한 쪽 P 의 이전 재렌더 작업이 canvas 를 붙잡은 채 pool 로 돌아가면, 그 canvas 를
  // 재사용한 쪽 Q 자리에 P 를 덧그린다.
  const vite = await createTestModuleServer(fileURLToPath(new URL('../', import.meta.url)));
  const { CanvasView } = await vite.ssrLoadModule('/src/view/canvas-view.ts') as typeof import('../src/view/canvas-view.ts');
  await vite.close();
  const calls: string[] = [];
  const canvas = { parentElement: null };
  const view = Object.assign(Object.create(CanvasView.prototype), {
    scrollContent: { appendChild() { calls.push('append'); } },
    canvasPool: {
      acquire() { return canvas; },
      release(page: number) { calls.push(`release:${page}`); },
    },
    pageRenderer: { cancelReRender(page: number) { calls.push(`cancelReRender:${page}`); } },
    cancelTextEditStaticLayerVerification(page: number) { calls.push(`cancelVerify:${page}`); },
    renderCanvas() { calls.push('render'); return false; },
  });
  view.renderPage(4);
  assert.deepEqual(calls, ['append', 'render', 'cancelVerify:4', 'cancelReRender:4', 'release:4']);
});

test('ViewportManager.clampScrollToContent 는 옛 쪽이 남아 늘어난 스크롤 영역 대신 새 내용 끝을 쓴다', () => {
  const previous = (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
  try {
    // absolute 로 남은 옛 쪽 canvas 때문에 브라우저는 scrollTop 을 아직 당기지 않았다.
    const container = {
      scrollTop: 38_848,
      scrollLeft: 40,
      clientWidth: 900,
      clientHeight: 800,
      addEventListener() {},
      removeEventListener() {},
    };
    const manager = new ViewportManager({ emit() {} } as never);
    manager.attachTo(container as unknown as HTMLElement);
    manager.setScrollTop(38_848);
    manager.clampScrollToContent(900, 1_142.5);
    assert.equal(manager.getScrollY(), 342.5);
    assert.equal(container.scrollTop, 342.5);
    assert.equal(manager.getScrollX(), 0);

    // 내용 안쪽 좌표는 건드리지 않고 최신 값만 읽는다.
    container.scrollTop = 200;
    manager.clampScrollToContent(900, 5_000);
    assert.equal(container.scrollTop, 200);
    assert.equal(manager.getScrollY(), 200);

    // observer 가 아직 못 본 좁아진 뷰포트: 캐시 폭(900)이 아니라 실제 폭으로 끝을 잰다.
    container.clientWidth = 700;
    container.scrollLeft = 300;
    manager.clampScrollToContent(1_000, 5_000);
    assert.equal(container.scrollLeft, 300);
    manager.detach();
  } finally {
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = previous;
  }
});
