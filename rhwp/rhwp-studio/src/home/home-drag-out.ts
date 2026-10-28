/**
 * 문서 홈 카드를 파일로 다른 앱에 끌어 놓기 (데스크톱). Cmd/Ctrl 로 카드를 고르고 Shift 로 범위를 고른다.
 * 누른 채 몇 픽셀 움직이면 고른 카드(누른 카드가 고른 묶음 밖이면 그 카드만)를 파일로 준비하고, 준비가
 * 끝났을 때 아직 누르고 있으면 운영체제 끌기를 시작한다. 그 사이에 놓으면 끌기는 없던 일이 된다.
 *
 * 끌 수 있는 카드는 data-drag-key 를 단다. 그 밖의 카드는 고르거나 끌지 않는다.
 */

/** 끌 수 있는 카드에 다는 열쇠. 최근 문서는 recent:<기록 id>, 새 문서는 unsaved:<문서 id>. */
export const DRAG_KEY_ATTRIBUTE = 'data-drag-key';
const DRAG_KEY_SELECTOR = `[${DRAG_KEY_ATTRIBUTE}]`;
/** 누른 뒤 이만큼 움직여야 끌기다. 그보다 짧으면 누르기로 둔다. */
export const DRAG_THRESHOLD_PX = 5;

export interface PreparedFileDrag {
  token: string | null;
  /** 준비하지 못한 문서의 이름. */
  failed: readonly string[];
}

export interface HomeDragOutDeps {
  /** 카드 격자. 카드는 이 안에 있다. */
  grid: HTMLElement;
  prepare(keys: readonly string[]): Promise<PreparedFileDrag>;
  start(token: string, iconDataUrl: string): void;
  end(token: string, dropped: boolean): void;
  iconFor(keys: readonly string[]): string;
  onFailed(names: readonly string[]): void;
}

export interface HomeDragOut {
  readonly selected: ReadonlySet<string>;
  /** 이 창에서 시작한 끌기가 아직 끝나지 않았다. 홈에 다시 놓은 파일은 열지 않는다. */
  readonly outbound: boolean;
  /** 카드에 고름 표시를 다시 단다. 지금 격자에 없는 카드는 고름에서 뺀다. */
  paint(): void;
  clearSelection(): boolean;
  /** 홈에 놓인 끌기가 우리 것이면 끝내고 true. 그 끌기는 열지 않는다. */
  consumeDrop(): boolean;
  dispose(): void;
}

/** 화면 순서의 열쇠들에서 anchor 부터 target 까지. anchor 가 없으면 target 하나. */
export function rangeKeys(order: readonly string[], anchor: string | null, target: string): string[] {
  const end = order.indexOf(target);
  if (end < 0) return [];
  const start = anchor ? order.indexOf(anchor) : -1;
  if (start < 0) return [target];
  return order.slice(Math.min(start, end), Math.max(start, end) + 1);
}

/** 끌 카드들: 누른 카드가 고른 묶음 안이면 묶음 전체를 화면 순서로, 아니면 그 카드만. */
export function keysToDrag(order: readonly string[], selected: ReadonlySet<string>, pressed: string): string[] {
  if (!selected.has(pressed)) return [pressed];
  return order.filter((key) => selected.has(key));
}

/** 바꿔 고르기 키. macOS 는 Cmd, 그 밖은 Ctrl. */
function isToggleClick(event: MouseEvent): boolean {
  return event.metaKey || event.ctrlKey;
}

type Phase =
  | { kind: 'idle' }
  | { kind: 'pressed'; key: string; x: number; y: number; pointerId: number }
  | { kind: 'preparing'; released: boolean }
  | { kind: 'dragging'; token: string };

export function createHomeDragOut(deps: HomeDragOutDeps): HomeDragOut {
  const { grid } = deps;
  const selected = new Set<string>();
  let anchor: string | null = null;
  let phase: Phase = { kind: 'idle' };
  /** 끌기를 시작한 누름 뒤의 click 은 카드를 펼치거나 열지 않는다. */
  let swallowClick = false;

  const keyOf = (target: EventTarget | null): string | null => (
    target instanceof Element ? target.closest<HTMLElement>(DRAG_KEY_SELECTOR)?.getAttribute(DRAG_KEY_ATTRIBUTE) ?? null : null
  );
  const order = (): string[] => [...grid.querySelectorAll<HTMLElement>(DRAG_KEY_SELECTOR)]
    .map((card) => card.getAttribute(DRAG_KEY_ATTRIBUTE)!);

  function paint(): void {
    const present = new Set(order());
    for (const key of [...selected]) if (!present.has(key)) selected.delete(key);
    if (anchor && !present.has(anchor)) anchor = null;
    for (const card of grid.querySelectorAll<HTMLElement>(DRAG_KEY_SELECTOR)) {
      card.classList.toggle('is-selected', selected.has(card.getAttribute(DRAG_KEY_ATTRIBUTE)!));
    }
  }

  function clearSelection(): boolean {
    if (!selected.size) return false;
    selected.clear();
    anchor = null;
    paint();
    return true;
  }

  function finishDrag(): void {
    if (phase.kind !== 'dragging') return;
    deps.end(phase.token, true);
    phase = { kind: 'idle' };
  }

  async function begin(key: string): Promise<void> {
    const keys = keysToDrag(order(), selected, key);
    phase = { kind: 'preparing', released: false };
    const preparing = phase;
    swallowClick = true;
    grid.classList.add('is-drag-preparing');
    let prepared: PreparedFileDrag;
    try {
      prepared = await deps.prepare(keys);
    } catch {
      prepared = { token: null, failed: [] };
    } finally {
      grid.classList.remove('is-drag-preparing');
    }
    if (prepared.failed.length) deps.onFailed(prepared.failed);
    if (phase !== preparing) {
      if (prepared.token) deps.end(prepared.token, false);
      return;
    }
    if (!prepared.token || preparing.released) {
      if (prepared.token) deps.end(prepared.token, false);
      phase = { kind: 'idle' };
      return;
    }
    phase = { kind: 'dragging', token: prepared.token };
    deps.start(prepared.token, deps.iconFor(keys));
  }

  // 고르기는 카드의 click 보다 먼저 받는다. 바꿔 고르기·범위 고르기는 카드를 펼치거나 열지 않는다.
  const onClick = (event: MouseEvent) => {
    if (swallowClick) {
      swallowClick = false;
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    const key = keyOf(event.target);
    if (key && (isToggleClick(event) || event.shiftKey)) {
      event.preventDefault();
      event.stopPropagation();
      if (event.shiftKey) {
        for (const entry of rangeKeys(order(), anchor, key)) selected.add(entry);
        anchor ??= key;
      } else {
        if (selected.has(key)) selected.delete(key);
        else selected.add(key);
        anchor = key;
      }
      paint();
      return;
    }
    // 그냥 누르면 고름을 푼다. 누른 카드는 하던 대로 펼치거나 연다.
    clearSelection();
  };

  const onPointerDown = (event: PointerEvent) => {
    // 앞선 끌기가 끝났다는 신호이기도 하다.
    finishDrag();
    swallowClick = false;
    if (event.button !== 0 || !event.isPrimary || isToggleClick(event) || event.shiftKey) return;
    const key = keyOf(event.target);
    if (!key || (event.target instanceof Element && event.target.closest('input, textarea, [contenteditable="true"]'))) return;
    phase = { kind: 'pressed', key, x: event.clientX, y: event.clientY, pointerId: event.pointerId };
  };

  const onPointerMove = (event: PointerEvent) => {
    if (phase.kind === 'dragging') {
      // 운영체제 끌기 동안에는 포인터 이동이 오지 않는다. 단추를 놓은 뒤의 첫 이동이 끝이다.
      if (event.buttons === 0) finishDrag();
      return;
    }
    if (phase.kind !== 'pressed' || event.pointerId !== phase.pointerId) return;
    if ((event.buttons & 1) === 0) {
      phase = { kind: 'idle' };
      return;
    }
    if (Math.hypot(event.clientX - phase.x, event.clientY - phase.y) < DRAG_THRESHOLD_PX) return;
    // 글자 고르기 끌기가 시작되지 않게 한다.
    window.getSelection()?.removeAllRanges();
    void begin(phase.key);
  };

  const onPointerUp = () => {
    if (phase.kind === 'pressed') phase = { kind: 'idle' };
    else if (phase.kind === 'preparing') phase.released = true;
  };

  // 카드 안의 글자·그림이 브라우저 끌기를 시작하지 않는다. 끌기는 위에서 운영체제로 넘긴다.
  const onDragStart = (event: DragEvent) => {
    if (keyOf(event.target)) event.preventDefault();
  };

  grid.addEventListener('click', onClick, true);
  grid.addEventListener('pointerdown', onPointerDown);
  grid.addEventListener('dragstart', onDragStart);
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointercancel', onPointerUp);

  return {
    selected,
    get outbound() { return phase.kind === 'dragging'; },
    paint,
    clearSelection,
    consumeDrop() {
      if (phase.kind !== 'dragging') return false;
      finishDrag();
      return true;
    },
    dispose() {
      finishDrag();
      grid.removeEventListener('click', onClick, true);
      grid.removeEventListener('pointerdown', onPointerDown);
      grid.removeEventListener('dragstart', onDragStart);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);
    },
  };
}

/** 끌 때 커서를 따라가는 그림. 첫 카드의 첫 쪽 그림, 없으면 형식 이름을 쓴 종이. 여럿이면 수를 단다. */
export function dragIconDataUrl(options: {
  image: HTMLImageElement | null;
  format: string;
  count: number;
}): string {
  const width = 64;
  const height = 80;
  const canvas = document.createElement('canvas');
  canvas.width = width + 12;
  canvas.height = height + 12;
  const context = canvas.getContext('2d');
  if (!context) return '';
  const left = 2;
  const top = 10;
  if (options.count > 1) {
    context.fillStyle = '#ffffff';
    context.strokeStyle = 'rgba(0, 0, 0, 0.25)';
    context.fillRect(left + 4, top - 4, width, height);
    context.strokeRect(left + 4.5, top - 3.5, width - 1, height - 1);
  }
  context.fillStyle = '#ffffff';
  context.fillRect(left, top, width, height);
  const image = options.image;
  if (image?.complete && image.naturalWidth > 0) {
    // 카드처럼 첫 쪽의 윗부분을 폭에 맞춰 보인다.
    const scale = width / image.naturalWidth;
    const sourceHeight = Math.min(image.naturalHeight, height / scale);
    context.drawImage(image, 0, 0, image.naturalWidth, sourceHeight, left, top, width, sourceHeight * scale);
  } else {
    context.fillStyle = '#9aa3ae';
    context.font = '600 12px system-ui, sans-serif';
    context.textAlign = 'center';
    context.fillText(options.format.toUpperCase().slice(0, 5), left + width / 2, top + height / 2 + 4);
  }
  context.strokeStyle = 'rgba(0, 0, 0, 0.3)';
  context.strokeRect(left + 0.5, top + 0.5, width - 1, height - 1);
  if (options.count > 1) {
    const label = String(options.count);
    context.font = '700 11px system-ui, sans-serif';
    const badge = Math.max(18, context.measureText(label).width + 10);
    const x = canvas.width - badge - 1;
    context.fillStyle = '#e5484d';
    context.beginPath();
    context.roundRect(x, 1, badge, 18, 9);
    context.fill();
    context.fillStyle = '#ffffff';
    context.textAlign = 'center';
    context.fillText(label, x + badge / 2, 14);
  }
  return canvas.toDataURL('image/png');
}
