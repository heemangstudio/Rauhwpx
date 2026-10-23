import type { Located, Motion, Rect } from '../../vendor/hm-wasm/hm_wasm';
import type { StudioEngine } from '../core/wasm-bridge';
import type { CanvasView } from './canvas-view';
import type { EventBus } from '../core/event-bus';
import { EngineNotSupportedError } from '../core/engine-support';

/** wire 주소를 구 엔진의 논리 오프셋으로 해석하지 않는 읽기 전용 입력 경로. */
export function installHeemangReader(container: HTMLElement, engine: StudioEngine, bus: EventBus, view: CanvasView, report: (error: Error) => void): void {
  let caret: Located | null = null;
  let anchor: Located | null = null;
  let rectangles: Rect[] = [];
  let dragging = false;
  let preferredX: number | undefined;
  let frame = 0;
  let documentInstance = engine.documentInstance;
  const overlays = new Set<HTMLElement>();
  const active = () => engine.engineKind === 'heemang' && engine.hasLoadedDocument();
  container.tabIndex = 0;

  function draw() {
    for (const overlay of overlays) overlay.remove();
    overlays.clear();
    if (documentInstance !== engine.documentInstance) {
      documentInstance = engine.documentInstance;
      caret = anchor = null;
      rectangles = [];
      dragging = false;
    }
    if (!active()) return;
    const pages = container.querySelectorAll<HTMLCanvasElement>('canvas[data-heemang-page]');
    for (const canvas of pages) {
      const page = Number(canvas.dataset.heemangPage);
      const info = engine.getPageInfo(page);
      const zoom = canvas.getBoundingClientRect().width / info.width;
      const overlay = document.createElement('div');
      overlay.dataset.heemangOverlay = String(page);
      Object.assign(overlay.style, {
        position: 'absolute', pointerEvents: 'none', zIndex: '3',
        top: canvas.style.top, left: canvas.style.left, transform: canvas.style.transform,
        width: canvas.style.width, height: canvas.style.height,
      });
      const box = (x: number, y: number, width: number, height: number, color: string) => {
        const rect = document.createElement('div');
        Object.assign(rect.style, { position: 'absolute', left: `${x / 75 * zoom}px`, top: `${y / 75 * zoom}px`, width: `${width / 75 * zoom}px`, height: `${height / 75 * zoom}px`, background: color });
        overlay.append(rect);
        return rect;
      };
      for (const rect of rectangles) if (rect.page === page) box(rect.x, rect.y, rect.width, rect.height, '#3b82f640');
      if (caret?.caret.page === page) {
        const c = caret.caret;
        box(c.x, c.y, 100 / zoom, c.height, '#111').dataset.heemangCaret = 'true';
      }
      canvas.parentElement?.append(overlay);
      overlays.add(overlay);
    }
  }
  function scheduleDraw() {
    if (frame) return;
    frame = requestAnimationFrame(() => { frame = 0; draw(); });
  }
  function updateSelection() {
    if (!caret) return;
    rectangles = anchor ? engine.viewer!.select({ from: anchor.position, to: caret.position }) : [];
    bus.emit('cursor-rect-updated', { pageIndex: caret.caret.page, x: caret.caret.x / 75, y: caret.caret.y / 75, height: caret.caret.height / 75 });
    draw();
  }
  function attempt(action: () => void) {
    try { action(); }
    catch (error) { dragging = false; rectangles = []; anchor = null; draw(); report(error instanceof Error ? error : new Error(String(error))); }
  }
  function point(ev: PointerEvent): Located | null {
    const canvas = document.elementFromPoint(ev.clientX, ev.clientY)?.closest<HTMLCanvasElement>('canvas[data-heemang-page]');
    if (!canvas || !container.contains(canvas)) return null;
    const page = Number(canvas.dataset.heemangPage);
    const bounds = canvas.getBoundingClientRect();
    const info = engine.getPageInfo(page);
    return engine.viewer!.locate({ kind: 'point', page, x: Math.round((ev.clientX - bounds.left) * info.width / bounds.width * 75), y: Math.round((ev.clientY - bounds.top) * info.height / bounds.height * 75) }) as Located | null;
  }
  container.addEventListener('pointerdown', ev => {
    if (!active() || ev.button !== 0) return;
    attempt(() => {
      const hit = point(ev);
      if (!hit) return;
      ev.preventDefault();
      ev.stopImmediatePropagation();
      container.focus({ preventScroll: true });
      anchor = ev.shiftKey && caret ? anchor ?? caret : hit;
      caret = hit;
      preferredX = undefined;
      dragging = true;
      updateSelection();
    });
  }, true);
  window.addEventListener('pointermove', ev => {
    if (!active() || !dragging) return;
    attempt(() => {
      const hit = point(ev);
      if (!hit) return;
      caret = hit;
      updateSelection();
    });
  });
  window.addEventListener('pointerup', () => { dragging = false; });
  for (const name of ['mousedown', 'dblclick', 'contextmenu'] as const) {
    container.addEventListener(name, ev => {
      if (!active()) return;
      ev.preventDefault();
      ev.stopImmediatePropagation();
      if (name === 'dblclick' || name === 'contextmenu') report(new EngineNotSupportedError(name));
    }, true);
  }
  container.addEventListener('keydown', ev => {
    if (!active() || ev.target !== container) return;
    ev.stopImmediatePropagation();
    const motions: Record<string, Motion> = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down', Home: 'lineStart', End: 'lineEnd' };
    const motion = motions[ev.key];
    if (!motion || !caret) {
      if (ev.key.length === 1 || ['Enter', 'Backspace', 'Delete'].includes(ev.key)) {
        ev.preventDefault();
        report(new EngineNotSupportedError('편집·클립보드'));
      }
      return;
    }
    ev.preventDefault();
    attempt(() => {
      if (ev.altKey || ev.metaKey || ev.ctrlKey) throw new EngineNotSupportedError('단어·문서 단위 이동');
      const previous = caret!;
      if (motion === 'up' || motion === 'down') preferredX ??= previous.caret.x;
      else preferredX = undefined;
      const next = engine.viewer!.navigate({ position: previous.position, affinity: previous.affinity, motion, preferredX, page: previous.caret.page });
      if (!next) return;
      anchor = ev.shiftKey ? anchor ?? previous : null;
      caret = next;
      updateSelection();
      const zoom = view.getViewportManager().getZoom();
      const top = view.getVirtualScroll().getPageOffset(next.caret.page) + next.caret.y / 75 * zoom;
      const bottom = top + next.caret.height / 75 * zoom;
      if (top < container.scrollTop) container.scrollTop = top;
      else if (bottom > container.scrollTop + container.clientHeight) container.scrollTop = bottom - container.clientHeight;
      scheduleDraw();
    });
  }, true);
  new MutationObserver(records => {
    if (records.some(r => (r.target instanceof HTMLCanvasElement) || [...r.addedNodes, ...r.removedNodes].some(n => n instanceof HTMLCanvasElement))) scheduleDraw();
  }).observe(container, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'data-heemang-page'] });
  bus.on('document-context-changed', () => {
    if (!active() || documentInstance !== engine.documentInstance) scheduleDraw();
  });
  bus.on('document-swapped', () => { caret = anchor = null; rectangles = []; scheduleDraw(); });
  bus.on('zoom-level-display', scheduleDraw);
}
