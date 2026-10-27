import { createIcon } from './icons.ts';
import { FLOAT_EDGE_GAP, FLOAT_INSET, clampFloatPosition, fitFloatFrame, projectFloatRelease, resizeFloatFrame, rubberBandFloatPosition, stepFloatSpring, type FloatArea, type FloatFrame, type FloatInset, type FloatPoint, type FloatResizeEdge, type FloatSpring } from './browser-float-geometry.ts';

export type BrowserPresentationMode = 'dock' | 'float' | 'popout';
export interface NativeBrowserApi {
  passwords?: { armSave(args: { tabId: string; enabled: boolean }): Promise<{ enabled: boolean; navigationEpoch: number }> };
  attach(args: { tabId: string; expectedTargetId?: string; bounds: { x: number; y: number; width: number; height: number }; mode: BrowserPresentationMode; interactive: boolean; focus?: boolean; bare?: boolean; title?: string }): Promise<unknown>;
  detach(args: { tabId: string }): Promise<unknown>;
  getState(args: { tabId: string; expectedTargetId?: string; checkPaint?: boolean }): Promise<unknown>;
  reload?(args: { tabId: string; expectedTargetId?: string; navigationEpoch?: number; recovery?: boolean }): Promise<unknown>;
  zoom?(args: { tabId: string; factor: number }): Promise<unknown>;
  /** 에이전트 커서를 게스트 위 표시 계층에 그린다. x·y는 페이지 CSS px다. */
  pointer?(args: { tabId: string; expectedTargetId?: string; x: number; y: number; phase: 'move' | 'down' | 'up' | 'click'; durationMs: number }): Promise<unknown>;
  onEvent?(callback: (event: Record<string, unknown>) => void): () => void;
  /** Chrome 로그인 진행 상태를 띄운 창들에 알리거나, 한 탭의 Chrome 로그인 제안을 숨긴다. */
  chromeSignIn?(args: { site?: string | null; dismissTabId?: string }): Promise<unknown>;
}
export function nativeBrowserApi(): NativeBrowserApi | undefined {
  return (globalThis as { rhwpDesktop?: { browser?: NativeBrowserApi } }).rhwpDesktop?.browser;
}

export interface BrowserPresentationOptions {
  onLayout?(): void;
  onDock?(): void;
  onClose?(): void;
  /** 떠 있는 동안 머리줄로 옮길 주소 영역. */
  navigation?: HTMLElement;
  captureButton?: HTMLElement;
  /** 직접 조작 단추. 에이전트 미리보기로 잠긴 동안에도 누를 수 있다. */
  controlButton?: HTMLElement;
}

/** macOS 숨은 제목 막대(신호등·창 드래그 영역) 아래로 프레임을 내린다. 다른 가장자리는 12px이다. */
function floatInset(): FloatInset {
  const titlebar = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--desktop-titlebar-height'));
  return Number.isFinite(titlebar) && titlebar > 0 ? { ...FLOAT_INSET, top: titlebar + FLOAT_EDGE_GAP } : FLOAT_INSET;
}

/** 한 DOM을 옮기며 페이지·입력·의견 상태를 유지한다. */
export function createBrowserPresentation(element: HTMLElement, onChange: (mode: BrowserPresentationMode | null) => void, options: BrowserPresentationOptions = {}) {
  const { onLayout, onDock, onClose, navigation, captureButton, controlButton } = options;
  let dock: HTMLElement | null = null;
  let mode: BrowserPresentationMode | null = null;
  let popup: Window | null = null;
  let returnFocus: HTMLElement | null = null;
  // 머리줄로 옮긴 노드는 원래 자리로 돌려놓는다. 뒤 이웃부터 돌려놓아 이웃끼리 옮겨진 경우에도 순서를 지킨다.
  const borrowed = [navigation, controlButton, captureButton].filter((node): node is HTMLElement => !!node).map(node => ({ node, home: node.parentElement, next: node.nextSibling }));
  const restoreNavigation = () => {
    for (const { node, home, next } of [...borrowed].reverse()) if (home && node.parentElement !== home) home.insertBefore(node, next?.parentNode === home ? next : null);
  };
  const address = navigation?.querySelector<HTMLInputElement>('.ag-browser-address') ?? null;
  const floating = document.createElement('section');
  floating.className = 'ag-browser-floating';
  floating.setAttribute('aria-label', '떠 있는 브라우저');
  floating.hidden = true;
  function syncTheme(): void {
    const source = getComputedStyle(dock ?? document.documentElement);
    for (let index = 0; index < source.length; index++) {
      const name = source.item(index); if (!name.startsWith('--ag-') && !name.startsWith('--n-') && name !== '--focus-ring') continue;
      const value = source.getPropertyValue(name); if (!value.trim()) continue;
      floating.style.setProperty(name, value); element.style.setProperty(name, value);
      popup?.document.documentElement.style.setProperty(name, value);
    }
    if (popup) {
      for (const name of ['class', 'data-theme', 'data-theme-mode', 'data-theme-effective', 'data-theme-preset', 'data-color-scheme']) {
        const value = document.documentElement.getAttribute(name); if (value === null) popup.document.documentElement.removeAttribute(name); else popup.document.documentElement.setAttribute(name, value);
      }
      popup.document.body.className = document.body.className;
    }
  }
  const themeObserver = new MutationObserver(syncTheme);
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme', 'data-theme-mode', 'data-theme-effective', 'data-theme-preset', 'data-color-scheme', 'style'] });
  themeObserver.observe(document.body, { attributes: true, attributeFilter: ['class', 'data-theme', 'data-theme-mode', 'data-theme-effective', 'data-theme-preset', 'data-color-scheme', 'style'] });
  const moveHandle = document.createElement('button');
  moveHandle.className = 'ag-browser-move';
  moveHandle.type = 'button';
  moveHandle.setAttribute('aria-label', '브라우저 이동');
  moveHandle.title = '드래그 또는 방향키로 이동. Shift + 방향키로 크기 조절';
  const chrome = document.createElement('header'); chrome.className = 'ag-browser-floating-chrome';
  const dockButton = document.createElement('button'); dockButton.type = 'button'; dockButton.className = 'ag-browser-floating-dock';
  dockButton.setAttribute('aria-label', '작업 칸에 붙이기'); dockButton.title = '작업 칸에 붙이기'; dockButton.append(createIcon('browserDock'));
  dockButton.addEventListener('click', () => { present('dock'); onDock?.(); });
  const close = document.createElement('button'); close.type = 'button'; close.className = 'ag-browser-floating-close';
  close.setAttribute('aria-label', '브라우저 보기 닫기'); close.title = '브라우저 보기 닫기'; close.append(createIcon('close')); close.addEventListener('click', () => { hide(); onClose?.(); });
  // 보이지 않는 가장자리 잡기 영역. 커서만 표시하고 네이티브 페이지가 덮지 않도록 테두리 밖에 둔다.
  const edges = (['n', 's', 'e', 'w', 'nw', 'ne', 'sw', 'se'] as const).map(edge => {
    const zone = document.createElement('div'); zone.className = 'ag-browser-float-edge'; zone.dataset.edge = edge; zone.setAttribute('aria-hidden', 'true');
    zone.addEventListener('pointerdown', event => gesture(event, zone, edge)); return zone;
  });
  chrome.append(moveHandle, dockButton, close); floating.append(chrome, ...edges); document.body.append(floating);
  let cancelGesture: (() => void) | null = null;
  const area = (): FloatArea => ({ width: innerWidth, height: innerHeight });
  let inset = floatInset();
  // stored는 사용자가 고른 프레임이고, 화면에는 매번 현재 창에 맞춘 값만 그린다.
  let stored: FloatFrame | null = null;
  let rendered: FloatFrame | null = null;
  try {
    const saved = JSON.parse(localStorage.getItem('rhwp.browser.float') ?? 'null');
    if (saved && ['left', 'top', 'width', 'height'].every(key => Number.isFinite(saved[key]))) stored = { left: saved.left, top: saved.top, width: saved.width, height: saved.height };
  } catch { /* 이전 위치가 없으면 기본 위치를 쓴다. */ }
  const remember = (frame: FloatFrame) => { stored = frame; try { localStorage.setItem('rhwp.browser.float', JSON.stringify(frame)); } catch { /* 저장 실패는 보기를 막지 않는다. */ } };
  // 네이티브 페이지가 표면 사각형을 따르므로 transform 없이 left/top/width/height만 쓴다.
  const render = (frame: FloatFrame) => {
    rendered = frame;
    for (const key of ['left', 'top', 'width', 'height'] as const) floating.style.setProperty(key, `${frame[key]}px`);
    onLayout?.();
  };
  let motion: { frame: number; last: number } | null = null;
  const stopMotion = () => { if (!motion) return; cancelAnimationFrame(motion.frame); motion = null; delete floating.dataset.gesture; };
  const fit = () => { if (floating.hidden || cancelGesture) return; stopMotion(); inset = floatInset(); render(fitFloatFrame(stored, area(), inset)); };
  let resizeFrame: number | null = null;
  const onResize = () => { if (resizeFrame === null) resizeFrame = requestAnimationFrame(() => { resizeFrame = null; fit(); }); };
  const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  /** 놓은 자리에서 목표까지 스프링으로 내려앉는다. 매 프레임 onLayout으로 네이티브 페이지가 따라온다. */
  function settle(from: FloatFrame, velocity: FloatPoint, target: FloatFrame): void {
    if (reducedMotion() || from.left === target.left && from.top === target.top && !velocity.x && !velocity.y) { render(target); return; }
    const spring: FloatSpring = { position: { x: from.left, y: from.top }, velocity };
    const tick = (now: number) => {
      if (!motion) return;
      const dt = (now - motion.last) / 1000; motion.last = now;
      const done = stepFloatSpring(spring, { x: target.left, y: target.top }, dt);
      const bounds = area();
      // 작게 넘치는 반동도 제목 막대 영역에는 들어가지 않는다.
      render({ left: Math.round(Math.min(Math.max(spring.position.x, 0), bounds.width - target.width)), top: Math.round(Math.min(Math.max(spring.position.y, inset.top - FLOAT_EDGE_GAP), bounds.height - target.height)), width: target.width, height: target.height });
      if (done) { motion = null; delete floating.dataset.gesture; } else motion.frame = requestAnimationFrame(tick);
    };
    floating.dataset.gesture = 'settle';
    motion = { frame: requestAnimationFrame(tick), last: performance.now() };
  }
  /** 머리줄 이동과 가장자리 크기 조절. 포인터를 1:1로 따르고 프레임마다 한 번만 그린다. */
  function gesture(event: PointerEvent, owner: HTMLElement, edge: FloatResizeEdge | null): void {
    if (event.button !== 0 || innerWidth < 640 || floating.hidden) return;
    stopMotion(); cancelGesture?.(); event.preventDefault(); moveHandle.focus({ preventScroll: true });
    const start = rendered ?? fitFloatFrame(stored, area(), inset); const x = event.clientX; const y = event.clientY; const id = event.pointerId;
    owner.setPointerCapture(id);
    let frame: number | null = null; let latest = { x: 0, y: 0 };
    const samples = [{ t: event.timeStamp, x, y }];
    floating.dataset.gesture = edge ? 'resize' : 'move';
    const flush = () => {
      if (frame !== null) cancelAnimationFrame(frame); frame = null;
      if (edge) { render(resizeFloatFrame(start, edge, latest, area(), inset)); return; }
      const point = rubberBandFloatPosition({ x: start.left + latest.x, y: start.top + latest.y }, start, area(), inset);
      render({ ...start, left: Math.round(point.x), top: Math.round(point.y) });
    };
    const move = (next: PointerEvent) => {
      if (next.pointerId !== id) return;
      latest = { x: next.clientX - x, y: next.clientY - y };
      samples.push({ t: next.timeStamp, x: next.clientX, y: next.clientY });
      while (samples.length > 2 && next.timeStamp - samples[0].t > 100) samples.shift();
      if (frame === null) frame = requestAnimationFrame(flush);
    };
    const stop = () => {
      owner.removeEventListener('pointermove', move); owner.removeEventListener('pointerup', finish); owner.removeEventListener('pointercancel', interrupt); owner.removeEventListener('lostpointercapture', interrupt); window.removeEventListener('blur', interrupt);
      if (frame !== null) cancelAnimationFrame(frame); frame = null; delete floating.dataset.gesture;
      cancelGesture = null; if (owner.hasPointerCapture(id)) owner.releasePointerCapture(id);
    };
    // 캡처나 창 초점을 잃어도 마지막 크기를 유지한다. Escape 만 명시적으로 되돌린다.
    const interrupt = (next: Event) => {
      if (next instanceof PointerEvent && next.pointerId !== id) return;
      flush(); stop(); const current = fitFloatFrame(rendered ?? start, area(), inset); remember(current); render(current);
    };
    const cancel = () => { stop(); const original = fitFloatFrame(start, area(), inset); remember(original); render(original); };
    const finish = (next: PointerEvent) => {
      if (next.pointerId !== id) return;
      latest = { x: next.clientX - x, y: next.clientY - y };
      flush(); stop();
      if (!latest.x && !latest.y) return;
      const current = rendered ?? start;
      if (edge) { const fitted = fitFloatFrame(current, area(), inset); remember(fitted); render(fitted); return; }
      const bounds = area(); const raw = { x: start.left + latest.x, y: start.top + latest.y };
      const first = samples[0]; const last = samples[samples.length - 1]; const span = last.t - first.t;
      // 멈췄다가 놓으면 던지지 않는다. 고무줄 구간의 축은 속도를 버리고 제자리로 돌아온다.
      const fresh = next.timeStamp - last.t < 60 && span >= 8 && !reducedMotion();
      const clamped = clampFloatPosition({ x: current.left, y: current.top }, current, bounds, inset);
      const speed = (delta: number, pinned: boolean) => fresh && !pinned ? Math.max(-4000, Math.min(4000, delta / span * 1000)) : 0;
      const velocity = { x: speed(last.x - first.x, clamped.left !== current.left), y: speed(last.y - first.y, clamped.top !== current.top) };
      const target = { ...current, ...projectFloatRelease(raw, velocity, current, bounds, inset) };
      remember(target); settle(current, velocity, target);
    };
    cancelGesture = cancel;
    owner.addEventListener('pointermove', move); owner.addEventListener('pointerup', finish); owner.addEventListener('pointercancel', interrupt); owner.addEventListener('lostpointercapture', interrupt); window.addEventListener('blur', interrupt);
  }
  chrome.addEventListener('pointerdown', event => {
    const control = (event.target as Element).closest('button, input, textarea, select, a, summary, label, [role="button"], [contenteditable]');
    if (!control || control === moveHandle) gesture(event, chrome, null);
    else if (control === address && document.activeElement !== address) addressGesture(event, address);
  });
  /** 포커스 없는 주소 칸도 잡아 끌 수 있다. 4px 넘게 움직이면 이동, 그대로 놓으면 주소를 선택한다. */
  function addressGesture(down: PointerEvent, field: HTMLInputElement): void {
    if (down.button !== 0 || floating.hidden) return;
    // 판정 전에는 포인터를 붙잡지 않는다. 주소 칸의 캡처 해제 이벤트가 머리줄 이동을 바로 취소하기 때문이다.
    down.preventDefault(); cancelGesture?.();
    const id = down.pointerId;
    const stop = () => { removeEventListener('pointermove', move, true); removeEventListener('pointerup', up, true); removeEventListener('pointercancel', cancel, true); };
    const move = (next: PointerEvent) => {
      if (next.pointerId !== id || Math.hypot(next.clientX - down.clientX, next.clientY - down.clientY) <= 4) return;
      stop(); gesture(down, chrome, null);
    };
    const up = (next: PointerEvent) => { if (next.pointerId !== id) return; stop(); field.focus({ preventScroll: true }); field.select(); };
    const cancel = (next: PointerEvent) => { if (next.pointerId === id) stop(); };
    addEventListener('pointermove', move, true); addEventListener('pointerup', up, true); addEventListener('pointercancel', cancel, true);
  }
  function set(next: BrowserPresentationMode | null): void {
    mode = next; element.dataset.presentation = next ?? 'hidden'; onChange(next);
  }
  function present(next: BrowserPresentationMode): void {
    cancelGesture?.(); stopMotion(); syncTheme();
    restoreNavigation();
    if (!returnFocus && document.activeElement instanceof HTMLElement) returnFocus = document.activeElement;
    if (next === 'popout') {
      popup = window.open('', 'rhwp-owned-browser', 'popup,width=1024,height=780');
      if (!popup) { present('float'); return; }
      popup.document.title = 'HamaEditor 브라우저';
      popup.document.documentElement.lang = 'ko';
      popup.document.body.className = document.body.className;
      for (const style of document.querySelectorAll('style,link[rel="stylesheet"]')) popup.document.head.append(style.cloneNode(true));
      popup.document.body.append(element); syncTheme();
      popup.addEventListener('pagehide', () => { popup = null; if (mode === 'popout') present('dock'); }, { once: true });
      floating.hidden = true; set(next); return;
    }
    if (popup) { const old = popup; popup = null; if (dock) dock.append(element); old.close(); }
    floating.hidden = next !== 'float';
    if (next === 'float') { for (const node of [captureButton, navigation, controlButton]) if (node) chrome.insertBefore(node, dockButton); floating.insertBefore(element, edges[0]); fit(); }
    else dock?.append(element);
    element.hidden = false; set(next);
  }
  function hide(): void {
    cancelGesture?.(); stopMotion();
    restoreNavigation();
    if (dock) dock.append(element);
    if (popup) { const old = popup; popup = null; old.close(); }
    floating.hidden = true; element.hidden = true; set(null);
    returnFocus?.focus({ preventScroll: true }); returnFocus = null;
  }
  function keyboard(event: KeyboardEvent): void {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (cancelGesture) cancelGesture(); else hide(); return; }
    if (!event.key.startsWith('Arrow') || floating.hidden) return;
    event.preventDefault(); stopMotion();
    const frame = rendered ?? fitFloatFrame(stored, area(), inset); const amount = event.altKey ? 1 : 20;
    const dx = event.key === 'ArrowRight' ? amount : event.key === 'ArrowLeft' ? -amount : 0;
    const dy = event.key === 'ArrowDown' ? amount : event.key === 'ArrowUp' ? -amount : 0;
    const next = event.shiftKey ? resizeFloatFrame(frame, 'se', { x: dx, y: dy }, area(), inset) : fitFloatFrame({ ...frame, left: frame.left + dx, top: frame.top + dy }, area(), inset);
    remember(next); render(next);
  }
  floating.addEventListener('keydown', event => { if (event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); event.stopPropagation(); if (cancelGesture) cancelGesture(); else hide(); } });
  moveHandle.addEventListener('keydown', keyboard);
  window.addEventListener('resize', onResize);
  return {
    position(x: number, y: number) { stopMotion(); inset = floatInset(); const next = fitFloatFrame({ ...(rendered ?? fitFloatFrame(stored, area(), inset)), left: x, top: y }, area(), inset); remember(next); if (!floating.hidden) render(next); },
    mount(host: HTMLElement) { dock = host; syncTheme(); if (mode !== 'float' && mode !== 'popout') host.append(element); }, present, hide, current: () => mode,
    /** locked: 에이전트가 조작 중이라 페이지와 머리줄 조작을 막는다. 이동 손잡이와 직접 조작 단추는 남긴다. live: 문서 홈에서도 보인다. */
    setPreviewLock(next: boolean, live = next) {
      floating.dataset.agentControlled = String(next); floating.dataset.agentSession = String(live);
      for (const child of [...chrome.children] as HTMLElement[]) child.inert = next && child !== moveHandle && child !== controlButton;
      floating.setAttribute('aria-label', next ? '에이전트가 사용 중인 브라우저 미리보기' : '떠 있는 브라우저');
    },
    dispose() { hide(); themeObserver.disconnect(); window.removeEventListener('resize', onResize); if (resizeFrame !== null) cancelAnimationFrame(resizeFrame); floating.remove(); element.remove(); },
  };
}
