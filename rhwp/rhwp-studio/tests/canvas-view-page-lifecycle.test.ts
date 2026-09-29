import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';

import { ViewportManager } from '../src/view/viewport-manager.ts';

// 쪽 canvas 수명과 화면 좌표가 문서 변화·렌더 실패·엔진 trap 뒤에도 어긋나지 않는 계약.

const source = readFileSync(new URL('../src/view/canvas-view.ts', import.meta.url), 'utf8');
const rulerSource = readFileSync(new URL('../src/view/ruler.ts', import.meta.url), 'utf8');

/** `  private name(` 또는 `  name(` 으로 시작하는 메서드 본문을 다음 메서드 직전까지 자른다. */
function methodBody(src: string, signature: string): string {
  const start = src.indexOf(signature);
  assert.notEqual(start, -1, `${signature} 를 찾지 못했다`);
  const rest = src.slice(start + signature.length);
  const next = rest.search(/\n {2}(?:\/\*\*|(?:private |public |async )*[a-zA-Z]\w*\()/);
  return next === -1 ? src.slice(start) : src.slice(start, start + signature.length + next);
}

test('렌더에 실패한 canvas 는 지연 재렌더를 끊은 뒤에만 pool 로 돌아간다', () => {
  // 실패한 쪽 P 의 이전 재렌더 작업이 canvas 를 붙잡은 채 pool 로 돌아가면, 그 canvas 를
  // 재사용한 쪽 Q 자리에 P 를 덧그린다.
  const start = source.indexOf('  /** 단일 페이지를 렌더링한다 */');
  const end = source.indexOf('  /** 기존 canvas를 유지한 채 페이지 내용을 다시 그린다. */');
  assert.ok(start >= 0 && end > start);
  const methods = stripTypeScriptTypes(`class View {\n${source.slice(start, end)}\n}`);
  const View = new Function(`${methods}\nreturn View;`)();
  const calls: string[] = [];
  const canvas = { parentElement: null };
  const view = Object.assign(new View(), {
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

test('canvas 를 pool 로 돌려주는 모든 경로가 대기 작업을 먼저 끊는다', () => {
  const bareReleases = [...source.matchAll(/this\.canvasPool\.release\(/g)].map((match) => {
    const before = source.slice(0, match.index);
    return before.slice(before.lastIndexOf('\n  private ')).split('(')[0].trim();
  });
  assert.deepEqual(bareReleases, ['private releaseRenderedPage', 'private releaseFailedRender']);
  const releaseAll = methodBody(source, '  private releaseAllRenderedPages(): void {');
  assert.ok(
    releaseAll.indexOf('this.pageRenderer.cancelAll()') >= 0
      && releaseAll.indexOf('this.pageRenderer.cancelAll()') < releaseAll.indexOf('this.canvasPool.releaseAll()'),
    'releaseAllRenderedPages 는 canvas 를 돌려주기 전에 재렌더를 모두 끊는다',
  );
});

test('엔진 trap 뒤에는 예약된 쪽 작업이 엔진을 부르지 않는다', () => {
  assert.match(
    source,
    /onEngineTrap\(\(\) => \{\s*this\.pageRenderer\.cancelAll\(\);\s*this\.cancelPendingPrefetch\(\);\s*this\.cancelTextEditStaticLayerVerification\(\);\s*this\.cancelAutoRendererReselection\(\);\s*\}\)/,
  );
  // 눈금자도 스크롤 프레임마다 pageCount/getPageInfo 를 부른다. 크기 동기(비트맵 지우기) 전에 멈춘다.
  const update = methodBody(rulerSource, '  update(): void {');
  const guard = update.indexOf('if (engineTrap()) return;');
  assert.ok(guard >= 0 && guard < update.indexOf('this.syncCanvasSize(dpr)'));
});

test('문서 높이가 줄면 새 끝 좌표로 쪽 창을 계산한다', () => {
  const refresh = methodBody(source, '  refreshPages(): void {');
  const layout = refresh.indexOf('this.recalcLayout();');
  const clamp = refresh.indexOf('this.viewportManager.clampScrollToContent(');
  const visible = refresh.indexOf('this.updateVisiblePages();');
  assert.ok(layout >= 0 && clamp > layout && visible > clamp,
    'recalcLayout → clampScrollToContent → updateVisiblePages 순서여야 한다');
  assert.match(
    refresh,
    /clampScrollToContent\(\s*this\.virtualScroll\.getTotalWidth\(\),\s*this\.virtualScroll\.getTotalHeight\(\),\s*\)/,
  );

  const load = methodBody(source, '  async loadDocument(): Promise<void> {');
  assert.match(load, /this\.viewportManager\.setScrollTop\(0\);\s*this\.updateVisiblePages\(\);/);
  assert.doesNotMatch(load, /this\.container\.scrollTop\s*=/,
    '직접 대입하면 캐시 좌표가 이전 문서 위치로 남는다');
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

test('머리말/꼬리말 대표 preview 는 전체 갱신마다 한 번 다시 그린다', () => {
  // HF 편집은 쪽 단위 경로를 타지 않고 refreshPages 로 온다. 키에 문서 세대가 없으면
  // 불투명 preview canvas 가 편집 전 모습으로 본문을 덮는다.
  const overlays = methodBody(source, '  private renderHeaderFooterEditOverlays(force = false): void {');
  assert.match(overlays, /const overlayKey = \[[^\]]*this\.documentRenderGeneration,\s*\]\.join\(':'\);/);
  const refresh = methodBody(source, '  refreshPages(): void {');
  const bump = refresh.indexOf('this.documentRenderGeneration += 1;');
  assert.ok(bump >= 0 && bump < refresh.indexOf('this.updateVisiblePages();'));
});
