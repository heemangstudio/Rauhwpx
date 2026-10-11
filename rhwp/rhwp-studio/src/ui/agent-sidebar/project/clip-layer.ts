/**
 * 미리보기 위의 영역 조각 층. PDF 쪽(또는 이미지) 하나마다 투명한 층을 덮고,
 * 그 쪽의 조각을 테두리로 그린다.
 *
 * - 영역 도구를 켜면 층이 포인터를 받아 네모를 끌어 그린다. 놓으면 조각이 생기고
 *   바로 이름을 고칠 수 있다. Esc 는 그리던 네모를, 그다음에는 도구를 끈다.
 * - 테두리를 누르면 고르고, 끌면 옮기고, 모서리를 끌면 크기를 바꾼다. 고른 조각은
 *   휴지통 단추나 Delete 로 버린다. 두 번 누르면 이름을 고친다.
 * - 이름표를 끌어 입력창에 놓으면 그 조각을 멘션한다. 테두리 안을 끄는 것은 옮기기다.
 * - 좌표는 모두 쪽 비율(0..1)이라 확대·축소에도 층은 다시 그릴 필요가 없다.
 */
import './clip-layer.css';
import {
  adjustClipRect,
  rectFromPoints,
  sameClipRect,
  type ClipHandle,
  type NormalizedPoint,
} from '../../../agent/clip-geometry.ts';
import type { ProjectClipItem, ProjectClipRect } from '../../../agent/types.ts';
import { button, el, reducedMotion } from './project-ui.ts';
import { makeProjectItemDraggable } from './project-drag.ts';

export interface ClipLayerDeps {
  /** 이름표를 입력창으로 끌 때 싣는 프로젝트 id. */
  projectId: string;
  /** 이 원본의 살아 있는 조각. 부를 때마다 지금 스냅샷에서 읽는다. */
  clips(): ProjectClipItem[];
  /** 새 조각을 만들고 그 id 를 돌려준다. */
  create(page: number, rect: ProjectClipRect): Promise<string | null>;
  update(clipId: string, rect: ProjectClipRect): Promise<void>;
  rename(clipId: string, name: string): Promise<void>;
  remove(clipId: string): Promise<void>;
  /** 영역 도구가 켜지거나 꺼질 때. */
  onDrawingChange?(drawing: boolean): void;
}

export interface ClipLayer {
  /** 쪽 요소 위에 층을 붙인다. 쪽 요소는 position 이 있는 상자여야 한다. */
  attach(page: number, host: HTMLElement): void;
  /** 스냅샷이 바뀐 뒤 테두리를 다시 맞춘다. */
  refresh(): void;
  setDrawing(on: boolean): void;
  readonly drawing: boolean;
  select(clipId: string | null): void;
  /** 조각을 고르고 잠깐 눈에 띄게 한다. 그 쪽 층이 있으면 테두리 요소를 돌려준다. */
  reveal(clipId: string): HTMLElement | null;
  /** Esc 를 먼저 받는다. 처리했으면 true. */
  escape(): boolean;
  destroy(): void;
}

const HANDLES: readonly ClipHandle[] = ['nw', 'ne', 'sw', 'se'];
/** 이보다 작게 끈 네모(화면 px)는 누름으로 본다. */
const MIN_DRAW_PX = 6;
const DRAG_THRESHOLD_PX = 3;

interface PageLayer {
  page: number;
  host: HTMLElement;
  layer: HTMLElement;
  boxes: Map<string, HTMLElement>;
}

interface Gesture {
  pointerId: number;
  page: PageLayer;
  startX: number;
  startY: number;
  /** draw = 새 네모, 그 밖은 기존 조각 옮기기·크기 바꾸기. */
  mode: 'draw' | ClipHandle;
  clipId: string | null;
  startRect: ProjectClipRect | null;
  rect: ProjectClipRect | null;
  moved: boolean;
  draft: HTMLElement | null;
}

function placeBox(box: HTMLElement, rect: readonly number[]): void {
  box.style.left = `${rect[0]! * 100}%`;
  box.style.top = `${rect[1]! * 100}%`;
  box.style.width = `${rect[2]! * 100}%`;
  box.style.height = `${rect[3]! * 100}%`;
}

export function createClipLayer(deps: ClipLayerDeps): ClipLayer {
  const pages = new Map<number, PageLayer>();
  let drawing = false;
  let selected: string | null = null;
  let gesture: Gesture | null = null;
  /** 만들고 나서 이름을 고칠 조각. 스냅샷에 나타나면 입력란을 연다. */
  let renameWhenShown: string | null = null;
  let renaming: { clipId: string; input: HTMLInputElement } | null = null;
  /** 끌어 바꾼 뒤 스냅샷이 따라오기 전까지 보여 줄 자리. */
  const pendingRects = new Map<string, ProjectClipRect>();
  let destroyed = false;

  function pointIn(page: PageLayer, event: PointerEvent): NormalizedPoint {
    const box = page.host.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (event.clientX - box.left) / Math.max(1, box.width))),
      y: Math.min(1, Math.max(0, (event.clientY - box.top) / Math.max(1, box.height))),
    };
  }

  function clipById(clipId: string): ProjectClipItem | null {
    return deps.clips().find((clip) => clip.id === clipId) ?? null;
  }

  function rectOf(clip: ProjectClipItem): ProjectClipRect {
    const pending = pendingRects.get(clip.id);
    if (pending && sameClipRect(pending, clip.rect)) pendingRects.delete(clip.id);
    return pendingRects.get(clip.id) ?? clip.rect;
  }

  // ── 테두리 ────────────────────────────────────────────

  function makeBox(page: PageLayer, clip: ProjectClipItem): HTMLElement {
    const box = el('div', 'ag-clip-box');
    box.dataset.clip = clip.id;
    box.tabIndex = 0;
    box.setAttribute('role', 'button');
    const label = el('span', 'ag-clip-label');
    // 이름표는 끌기 손잡이다. 옮기기 제스처를 시작하지 않고 고르기만 한다.
    label.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || gesture) return;
      event.stopPropagation();
      select(box.dataset.clip!);
      box.focus({ preventScroll: true });
    });
    makeProjectItemDraggable(label, () => {
      const current = clipById(box.dataset.clip!);
      return current && !current.id.startsWith('tmp-')
        ? { projectId: deps.projectId, itemId: current.id, title: current.title }
        : null;
    });
    box.append(label);
    for (const handle of HANDLES) {
      const grip = el('span', 'ag-clip-handle');
      grip.dataset.handle = handle;
      box.append(grip);
    }
    const trash = button('ag-clip-delete', '영역 삭제', { icon: 'trash' });
    trash.addEventListener('pointerdown', (event) => event.stopPropagation());
    trash.addEventListener('click', (event) => {
      event.stopPropagation();
      void removeClip(clip.id);
    });
    box.append(trash);
    box.addEventListener('pointerdown', (event) => beginEdit(event, page, box));
    box.addEventListener('dblclick', (event) => {
      event.stopPropagation();
      startRename(box.dataset.clip!);
    });
    box.addEventListener('keydown', (event) => {
      if (event.isComposing || renaming) return;
      const clipId = box.dataset.clip!;
      if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault();
        event.stopPropagation();
        void removeClip(clipId);
      } else if (event.key === 'Enter' || event.key === 'F2') {
        event.preventDefault();
        event.stopPropagation();
        select(clipId);
        startRename(clipId);
      }
    });
    box.addEventListener('focus', () => select(box.dataset.clip!));
    return box;
  }

  function renderPage(page: PageLayer): void {
    const clips = deps.clips().filter((clip) => clip.page === page.page);
    const seen = new Set<string>();
    for (const clip of clips) {
      seen.add(clip.id);
      let box = page.boxes.get(clip.id);
      if (!box) {
        box = makeBox(page, clip);
        page.boxes.set(clip.id, box);
        page.layer.append(box);
      }
      if (gesture?.clipId !== clip.id) placeBox(box, rectOf(clip));
      box.classList.toggle('ag-clip-selected', clip.id === selected);
      box.setAttribute('aria-label', `${clip.title} 영역`);
      box.querySelector('.ag-clip-label')!.textContent = clip.title;
      if (renameWhenShown === clip.id && !clip.id.startsWith('tmp-')) {
        renameWhenShown = null;
        select(clip.id);
        startRename(clip.id);
      }
    }
    for (const [clipId, box] of page.boxes) {
      if (seen.has(clipId) || renaming?.clipId === clipId) continue;
      box.remove();
      page.boxes.delete(clipId);
    }
  }

  function refresh(): void {
    if (destroyed) return;
    for (const page of pages.values()) renderPage(page);
    if (selected && !clipById(selected)) selected = null;
  }

  function select(clipId: string | null): void {
    selected = clipId;
    for (const page of pages.values()) {
      for (const [id, box] of page.boxes) box.classList.toggle('ag-clip-selected', id === clipId);
    }
  }

  function boxFor(clipId: string): HTMLElement | null {
    for (const page of pages.values()) {
      const box = page.boxes.get(clipId);
      if (box) return box;
    }
    return null;
  }

  // ── 그리기·옮기기·크기 바꾸기 ─────────────────────────

  function beginDraw(event: PointerEvent, page: PageLayer): void {
    if (!drawing || event.button !== 0 || gesture) return;
    event.preventDefault();
    event.stopPropagation();
    page.layer.setPointerCapture(event.pointerId);
    const draft = el('div', 'ag-clip-box ag-clip-draft');
    draft.hidden = true;
    page.layer.append(draft);
    const start = pointIn(page, event);
    gesture = {
      pointerId: event.pointerId, page, startX: event.clientX, startY: event.clientY, mode: 'draw',
      clipId: null, startRect: [start.x, start.y, 0, 0], rect: null, moved: false, draft,
    };
    select(null);
  }

  function beginEdit(event: PointerEvent, page: PageLayer, box: HTMLElement): void {
    if (event.button !== 0 || gesture || renaming?.clipId === box.dataset.clip) return;
    const clip = clipById(box.dataset.clip!);
    if (!clip) return;
    event.preventDefault();
    event.stopPropagation();
    select(clip.id);
    box.focus({ preventScroll: true });
    const handle = (event.target as HTMLElement).closest<HTMLElement>('.ag-clip-handle')?.dataset.handle as ClipHandle | undefined;
    box.setPointerCapture(event.pointerId);
    gesture = {
      pointerId: event.pointerId, page, startX: event.clientX, startY: event.clientY, mode: handle ?? 'move',
      clipId: clip.id, startRect: rectOf(clip), rect: null, moved: false, draft: null,
    };
  }

  function onMove(event: PointerEvent): void {
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    const dxPx = event.clientX - gesture.startX;
    const dyPx = event.clientY - gesture.startY;
    if (!gesture.moved && Math.hypot(dxPx, dyPx) < DRAG_THRESHOLD_PX) return;
    gesture.moved = true;
    const host = gesture.page.host.getBoundingClientRect();
    if (gesture.mode === 'draw') {
      const start = { x: gesture.startRect![0], y: gesture.startRect![1] };
      gesture.rect = rectFromPoints(start, pointIn(gesture.page, event));
      gesture.draft!.hidden = !gesture.rect;
      if (gesture.rect) placeBox(gesture.draft!, gesture.rect);
      return;
    }
    const dx = dxPx / Math.max(1, host.width);
    const dy = dyPx / Math.max(1, host.height);
    gesture.rect = adjustClipRect(gesture.startRect!, gesture.mode, dx, dy);
    const box = gesture.page.boxes.get(gesture.clipId!);
    if (box) placeBox(box, gesture.rect);
  }

  async function onUp(event: PointerEvent): Promise<void> {
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    const done = gesture;
    gesture = null;
    done.draft?.remove();
    if (done.mode === 'draw') {
      const host = done.page.host.getBoundingClientRect();
      const rect = done.rect;
      if (!done.moved || !rect || rect[2] * host.width < MIN_DRAW_PX || rect[3] * host.height < MIN_DRAW_PX) return;
      setDrawing(false);
      try {
        const clipId = await deps.create(done.page.page, rect);
        if (clipId) {
          renameWhenShown = clipId;
          refresh();
        }
      } catch {
        // 만들지 못했으면 도구를 다시 켜 둔다 — 알림은 미리보기가 맡는다.
        setDrawing(true);
      }
      return;
    }
    if (!done.moved || !done.rect || !done.clipId || sameClipRect(done.rect, done.startRect!)) return;
    pendingRects.set(done.clipId, done.rect);
    try {
      await deps.update(done.clipId, done.rect);
    } catch {
      pendingRects.delete(done.clipId);
    }
    refresh();
  }

  function cancelGesture(): boolean {
    if (!gesture) return false;
    const done = gesture;
    gesture = null;
    done.draft?.remove();
    if (done.clipId) {
      const box = done.page.boxes.get(done.clipId);
      if (box && done.startRect) placeBox(box, done.startRect);
    }
    return true;
  }

  async function removeClip(clipId: string): Promise<void> {
    if (selected === clipId) selected = null;
    const box = boxFor(clipId);
    box?.classList.add('ag-clip-removing');
    try {
      await deps.remove(clipId);
    } catch {
      box?.classList.remove('ag-clip-removing');
    }
    refresh();
  }

  // ── 이름 고치기 ───────────────────────────────────────

  function startRename(clipId: string): void {
    const clip = clipById(clipId);
    const box = boxFor(clipId);
    if (!clip || !box || renaming) return;
    const input = el('input', 'ag-clip-title-input');
    input.value = clip.title;
    input.maxLength = 200;
    input.setAttribute('aria-label', '영역 이름');
    box.classList.add('ag-clip-renaming');
    box.append(input);
    renaming = { clipId, input };
    requestAnimationFrame(() => {
      input.focus();
      input.select();
    });
    let finished = false;
    const finish = async (save: boolean) => {
      if (finished) return;
      finished = true;
      renaming = null;
      input.remove();
      box.classList.remove('ag-clip-renaming');
      const name = input.value.trim();
      const current = clipById(clipId);
      if (save && current && name && name !== current.title) {
        try {
          await deps.rename(clipId, name);
        } catch {
          // 이름은 그대로 둔다.
        }
      }
      refresh();
      if (box.isConnected) box.focus({ preventScroll: true });
    };
    input.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if (event.isComposing) return;
      if (event.key === 'Enter') {
        event.preventDefault();
        void finish(true);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        void finish(false);
      }
    });
    input.addEventListener('pointerdown', (event) => event.stopPropagation());
    input.addEventListener('dblclick', (event) => event.stopPropagation());
    input.addEventListener('blur', () => void finish(true));
  }

  // ── 도구 ─────────────────────────────────────────────

  function setDrawing(on: boolean): void {
    if (drawing === on) return;
    drawing = on;
    if (!on) cancelGesture();
    for (const page of pages.values()) page.layer.classList.toggle('ag-clip-drawing', on);
    deps.onDrawingChange?.(on);
  }

  function attach(pageNumber: number, host: HTMLElement): void {
    if (pages.has(pageNumber)) return;
    const layer = el('div', 'ag-clip-layer');
    layer.classList.toggle('ag-clip-drawing', drawing);
    layer.addEventListener('pointerdown', (event) => beginDraw(event, page));
    layer.addEventListener('pointermove', onMove);
    layer.addEventListener('pointerup', (event) => void onUp(event));
    layer.addEventListener('pointercancel', () => cancelGesture());
    // 쪽의 빈 곳을 누르면 고른 조각을 놓는다.
    host.addEventListener('pointerdown', (event) => {
      if (!(event.target as HTMLElement).closest('.ag-clip-box')) select(null);
    }, { capture: true });
    host.append(layer);
    const page: PageLayer = { page: pageNumber, host, layer, boxes: new Map() };
    pages.set(pageNumber, page);
    renderPage(page);
  }

  return {
    attach,
    refresh,
    setDrawing,
    get drawing() {
      return drawing;
    },
    select,
    reveal(clipId) {
      select(clipId);
      const box = boxFor(clipId);
      if (!box) return null;
      if (!reducedMotion()) {
        box.classList.remove('ag-clip-flash');
        void box.offsetWidth;
        box.classList.add('ag-clip-flash');
      }
      return box;
    },
    escape() {
      if (cancelGesture()) return true;
      if (drawing) {
        setDrawing(false);
        return true;
      }
      if (selected) {
        select(null);
        return true;
      }
      return false;
    },
    destroy() {
      destroyed = true;
      cancelGesture();
      for (const page of pages.values()) page.layer.remove();
      pages.clear();
    },
  };
}
