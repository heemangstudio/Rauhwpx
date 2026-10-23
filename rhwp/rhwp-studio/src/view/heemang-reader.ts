import type { Located, Motion, Rect, TextSelection, EditResult } from '../core/heemang-adapter';
import type { StudioEngine } from '../core/wasm-bridge';
import type { CanvasView } from './canvas-view';
import type { EventBus } from '../core/event-bus';
import { EngineNotSupportedError } from '../core/engine-support';

/** Heemang 세션의 wire 주소를 유지하는 입력·선택 경로. */
export function installHeemangReader(container: HTMLElement, engine: StudioEngine, bus: EventBus, view: CanvasView, report: (error: Error) => void, canEdit: () => boolean = () => true): void {
  let caret: Located | null = null;
  let anchor: Located | null = null;
  let rectangles: Rect[] = [];
  let dragging = false;
  let preferredX: number | undefined;
  let frame = 0;
  let documentInstance = engine.documentInstance;
  const overlays = new Set<HTMLElement>();
  const active = () => engine.engineKind === 'heemang' && engine.hasLoadedDocument();
  let composition: { selection: TextSelection; text: string } | null = null;
  const input = document.createElement('textarea');
  input.dataset.heemangInput = 'true';
  input.dataset.rhwpEditorInput = 'true';
  input.setAttribute('aria-label', '문서 텍스트 입력');
  input.autocomplete = 'off';
  input.spellcheck = false;
  Object.assign(input.style, {
    position: 'fixed', width: '1px', height: '1px', opacity: '0',
    padding: '0', border: '0', resize: 'none', zIndex: '4', pointerEvents: 'none',
  });
  container.append(input);
  container.tabIndex = 0;
  const selection = (): TextSelection | null => caret ? {
    from: anchor?.position ?? caret.position, to: caret.position,
    fromAffinity: anchor?.affinity ?? caret.affinity, toAffinity: caret.affinity,
  } : null;
  const writable = () => active() && !engine.readOnly && canEdit();
  function focusInput() {
    if (writable()) input.focus({ preventScroll: true });
    else container.focus({ preventScroll: true });
  }
  function cancelComposition() {
    composition = null;
    input.value = '';
    draw();
  }
  function applyEdit(action: () => EditResult | null) {
    const result = action();
    if (!result) return;
    caret = result.caret;
    anchor = result.anchor ?? null;
    preferredX = undefined;
    input.value = '';
    // 논리 변경은 한 번만 발행하며 renderer와 dirty/revision 구독자가 함께 받는다.
    bus.emit('document-changed');
    bus.emit('command-state-changed');
    updateSelection();
    revealCaret();
  }
  function replace(text: string) {
    const range = selection();
    if (!range || !writable()) return;
    applyEdit(() => engine.viewer!.replaceText(range, text));
  }
  function revealCaret() {
    if (!caret || !active()) return;
    const zoom = view.getViewportManager().getZoom();
    const top = view.getVirtualScroll().getPageOffset(caret.caret.page) + caret.caret.y / 75 * zoom;
    const bottom = top + caret.caret.height / 75 * zoom;
    if (top < container.scrollTop) container.scrollTop = top;
    else if (bottom > container.scrollTop + container.clientHeight) container.scrollTop = bottom - container.clientHeight;
    scheduleDraw();
  }

  function draw() {
    for (const overlay of overlays) overlay.remove();
    overlays.clear();
    if (documentInstance !== engine.documentInstance) {
      documentInstance = engine.documentInstance;
      caret = anchor = null;
      rectangles = [];
      dragging = false;
      composition = null;
      input.value = '';
    }
    input.disabled = !writable();
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
        const bounds = canvas.getBoundingClientRect();
        input.style.left = `${bounds.left + c.x / 75 * zoom}px`;
        input.style.top = `${bounds.top + c.y / 75 * zoom}px`;
        input.style.height = `${c.height / 75 * zoom}px`;
        if (composition?.text) {
          const preview = box(c.x, c.y, 0, c.height, '#fff');
          preview.dataset.heemangComposition = 'true';
          Object.assign(preview.style, { width: 'max-content', color: '#111', fontSize: `${c.height / 75 * zoom}px`, lineHeight: '1', borderBottom: '1px solid #111' });
          preview.textContent = composition.text;
        }
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
    catch (error) {
      dragging = false;
      cancelComposition();
      const message = typeof error === 'object' && error !== null && 'message' in error ? String(error.message) : String(error);
      report(error instanceof Error ? error : new Error(message));
    }
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
      if (hit.object) throw new EngineNotSupportedError('개체 편집');
      ev.preventDefault();
      ev.stopImmediatePropagation();
      cancelComposition();
      focusInput();
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
    if (!active() || (ev.target !== container && ev.target !== input)) return;
    // 메뉴 저장 단축키는 기존 dispatcher로 전달한다.
    if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === 's') return;
    ev.stopImmediatePropagation();
    if (ev.key === 'Escape' && composition) {
      ev.preventDefault();
      cancelComposition();
      return;
    }
    if (composition || ev.isComposing || ev.keyCode === 229) return;
    if ((ev.metaKey || ev.ctrlKey) && ['z', 'y'].includes(ev.key.toLowerCase())) {
      ev.preventDefault();
      if (writable()) attempt(() => applyEdit(() => ev.key.toLowerCase() === 'y' || ev.shiftKey ? engine.viewer!.redoEdit() : engine.viewer!.undoEdit()));
      return;
    }
    const motions: Record<string, Motion> = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down', Home: 'lineStart', End: 'lineEnd' };
    const motion = motions[ev.key];
    if (motion && caret) {
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
        revealCaret();
      });
      return;
    }
    if (['Enter', 'Backspace', 'Delete', 'Tab'].includes(ev.key)) {
      ev.preventDefault();
      const range = selection();
      if (!range || !writable()) return;
      attempt(() => {
        if (ev.key === 'Enter') applyEdit(() => engine.viewer!.split(range));
        else if (ev.key === 'Tab') replace('\t');
        else applyEdit(() => ev.key === 'Backspace' ? engine.viewer!.deleteBackward(range) : engine.viewer!.deleteForward(range));
      });
    } else if (ev.target === container && ev.key.length === 1 && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
      ev.preventDefault();
      attempt(() => replace(ev.key));
      focusInput();
    }
  }, true);
  input.addEventListener('compositionstart', () => {
    const range = selection();
    if (range && writable()) composition = { selection: structuredClone(range), text: '' };
  });
  input.addEventListener('compositionupdate', ev => {
    if (!composition) return;
    composition.text = ev.data;
    draw();
  });
  input.addEventListener('compositionend', ev => {
    const pending = composition;
    composition = null;
    input.value = '';
    if (!pending) return;
    if (ev.data && writable()) attempt(() => applyEdit(() => engine.viewer!.replaceText(pending.selection, ev.data)));
    else draw();
  });
  input.addEventListener('beforeinput', ev => {
    ev.stopImmediatePropagation();
    if (composition || ev.isComposing || ['insertCompositionText', 'insertFromComposition'].includes(ev.inputType)) return;
    ev.preventDefault();
    if (!writable()) return;
    attempt(() => {
      if (ev.inputType === 'insertText' && ev.data) replace(ev.data);
      else if (ev.inputType === 'insertParagraph' || ev.inputType === 'insertLineBreak') {
        const range = selection();
        if (range) applyEdit(() => engine.viewer!.split(range));
      } else if (ev.inputType === 'deleteContentBackward' || ev.inputType === 'deleteContentForward') {
        const range = selection();
        if (range) applyEdit(() => ev.inputType === 'deleteContentBackward' ? engine.viewer!.deleteBackward(range) : engine.viewer!.deleteForward(range));
      } else if (ev.inputType === 'historyUndo' || ev.inputType === 'historyRedo') {
        applyEdit(() => ev.inputType === 'historyUndo' ? engine.viewer!.undoEdit() : engine.viewer!.redoEdit());
      } else throw new EngineNotSupportedError(ev.inputType);
    });
  });
  input.addEventListener('input', ev => {
    ev.stopImmediatePropagation();
    if (!composition) input.value = '';
  });
  input.addEventListener('blur', cancelComposition);
  input.addEventListener('paste', ev => { ev.preventDefault(); report(new EngineNotSupportedError('클립보드 붙여넣기')); });
  bus.on('heemang-history-action', action => {
    if (!writable()) return;
    cancelComposition();
    attempt(() => applyEdit(() => action === 'redo' ? engine.viewer!.redoEdit() : engine.viewer!.undoEdit()));
    focusInput();
  });
  new MutationObserver(records => {
    if (records.some(r => (r.target instanceof HTMLCanvasElement) || [...r.addedNodes, ...r.removedNodes].some(n => n instanceof HTMLCanvasElement))) scheduleDraw();
  }).observe(container, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'data-heemang-page'] });
  bus.on('document-context-changed', () => {
    if (!active() || documentInstance !== engine.documentInstance) scheduleDraw();
  });
  bus.on('document-swapped', () => { caret = anchor = null; rectangles = []; scheduleDraw(); });
  bus.on('zoom-level-display', scheduleDraw);
  bus.on('document-layout-refreshed', revealCaret);
  container.addEventListener('scroll', scheduleDraw, { passive: true });
}
