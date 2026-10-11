import { createIcon } from './icons.ts';

export type BrowserPresentationMode = 'dock' | 'float' | 'popout';
export interface NativeBrowserApi {
  passwords?: { armSave(args: { tabId: string; enabled: boolean }): Promise<{ enabled: boolean; navigationEpoch: number }> };
  attach(args: { tabId: string; expectedTargetId?: string; bounds: { x: number; y: number; width: number; height: number }; mode: BrowserPresentationMode; interactive: boolean }): Promise<unknown>;
  detach(args: { tabId: string }): Promise<unknown>;
  getState(args: { tabId: string; expectedTargetId?: string; checkPaint?: boolean }): Promise<unknown>;
  reload?(args: { tabId: string; expectedTargetId?: string; navigationEpoch?: number; recovery?: boolean }): Promise<unknown>;
  zoom?(args: { tabId: string; factor: number }): Promise<unknown>;
  onEvent?(callback: (event: Record<string, unknown>) => void): () => void;
}
export function nativeBrowserApi(): NativeBrowserApi | undefined {
  return (globalThis as { rhwpDesktop?: { browser?: NativeBrowserApi } }).rhwpDesktop?.browser;
}

/** 한 DOM을 옮기며 페이지·입력·의견 상태를 유지한다. */
export function createBrowserPresentation(element: HTMLElement, onChange: (mode: BrowserPresentationMode | null) => void, onLayout?: () => void, onDock?: () => void, navigation?: HTMLElement, captureButton?: HTMLElement, onClose?: () => void) {
  let dock: HTMLElement | null = null;
  let mode: BrowserPresentationMode | null = null;
  let popup: Window | null = null;
  let returnFocus: HTMLElement | null = null;
  const captureHome = captureButton?.parentElement;
  const navigationHome = navigation?.parentElement;
  const navigationNext = navigation?.nextSibling ?? null;
  const restoreNavigation = () => { if (captureButton && captureHome) captureHome.append(captureButton); if (navigation && navigationHome) navigationHome.insertBefore(navigation, navigationNext); };
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
      for (const name of ['class', 'data-theme', 'data-theme-mode', 'data-theme-effective', 'data-color-scheme']) {
        const value = document.documentElement.getAttribute(name); if (value === null) popup.document.documentElement.removeAttribute(name); else popup.document.documentElement.setAttribute(name, value);
      }
      popup.document.body.className = document.body.className;
    }
  }
  const themeObserver = new MutationObserver(syncTheme);
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme', 'data-theme-mode', 'data-theme-effective', 'data-color-scheme', 'style'] });
  themeObserver.observe(document.body, { attributes: true, attributeFilter: ['class', 'data-theme', 'data-theme-mode', 'data-theme-effective', 'data-color-scheme', 'style'] });
  const moveHandle = document.createElement('button');
  moveHandle.className = 'ag-browser-move';
  moveHandle.type = 'button';
  moveHandle.setAttribute('aria-label', '브라우저 이동');
  moveHandle.title = '드래그 또는 방향키로 이동. Shift + 방향키로 크기 조절';
  const resize = document.createElement('button');
  resize.type = 'button'; resize.className = 'ag-browser-resize'; resize.append(createIcon('browserResize'));
  resize.setAttribute('aria-label', '브라우저 크기 조절');
  const chrome = document.createElement('header'); chrome.className = 'ag-browser-floating-chrome';
  const dockButton = document.createElement('button'); dockButton.type = 'button'; dockButton.className = 'ag-browser-floating-dock';
  dockButton.setAttribute('aria-label', '작업 칸에 붙이기'); dockButton.title = '작업 칸에 붙이기'; dockButton.append(createIcon('browserDock'));
  dockButton.addEventListener('click', () => { present('dock'); onDock?.(); });
  const close = document.createElement('button'); close.type = 'button'; close.className = 'ag-browser-floating-close';
  close.setAttribute('aria-label', '브라우저 보기 닫기'); close.title = '브라우저 보기 닫기'; close.append(createIcon('close')); close.addEventListener('click', () => { hide(); onClose?.(); });
  chrome.append(moveHandle, dockButton, close); floating.append(chrome, resize); document.body.append(floating);
  let cancelGesture: (() => void) | null = null;
  const clamp = () => {
    if (floating.hidden) return;
    const rect = floating.getBoundingClientRect();
    floating.style.left = `${Math.max(0, Math.min(rect.left, innerWidth - Math.min(rect.width, innerWidth)))}px`;
    floating.style.top = `${Math.max(0, Math.min(rect.top, innerHeight - Math.min(rect.height, innerHeight)))}px`;
    floating.style.width = `${Math.min(rect.width, innerWidth)}px`;
    floating.style.height = `${Math.min(rect.height, innerHeight)}px`;
    onLayout?.();
  };
  const remember = () => { try { localStorage.setItem('rhwp.browser.float', JSON.stringify({ left: floating.offsetLeft, top: floating.offsetTop, width: floating.offsetWidth, height: floating.offsetHeight })); } catch { /* 저장 실패는 보기를 막지 않는다. */ } };
  try {
    const saved = JSON.parse(localStorage.getItem('rhwp.browser.float') ?? 'null');
    if (saved) for (const key of ['left', 'top', 'width', 'height']) if (Number.isFinite(saved[key])) floating.style.setProperty(key, `${saved[key]}px`);
  } catch { /* 이전 위치가 없으면 기본 위치를 쓴다. */ }
  function set(next: BrowserPresentationMode | null): void {
    mode = next; element.dataset.presentation = next ?? 'hidden'; onChange(next);
  }
  function present(next: BrowserPresentationMode): void {
    cancelGesture?.(); syncTheme();
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
    if (next === 'float') { if (captureButton) chrome.insertBefore(captureButton, dockButton); if (navigation) chrome.insertBefore(navigation, dockButton); floating.insertBefore(element, resize); clamp(); }
    else dock?.append(element);
    element.hidden = false; set(next);
  }
  function hide(): void {
    cancelGesture?.();
    restoreNavigation();
    if (dock) dock.append(element);
    if (popup) { const old = popup; popup = null; old.close(); }
    floating.hidden = true; element.hidden = true; set(null);
    returnFocus?.focus({ preventScroll: true }); returnFocus = null;
  }
  function keyboard(event: KeyboardEvent, size = false): void {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (cancelGesture) cancelGesture(); else hide(); return; }
    if (!event.key.startsWith('Arrow')) return;
    event.preventDefault(); const rect = floating.getBoundingClientRect(); const amount = event.altKey ? 1 : 20;
    const dx = event.key === 'ArrowRight' ? amount : event.key === 'ArrowLeft' ? -amount : 0;
    const dy = event.key === 'ArrowDown' ? amount : event.key === 'ArrowUp' ? -amount : 0;
    if (size || event.shiftKey) { floating.style.width = `${Math.max(320, rect.width + dx)}px`; floating.style.height = `${Math.max(280, rect.height + dy)}px`; }
    else { floating.style.left = `${rect.left + dx}px`; floating.style.top = `${rect.top + dy}px`; }
    clamp(); remember();
  }
  floating.addEventListener('keydown', event => { if (event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); event.stopPropagation(); if (cancelGesture) cancelGesture(); else hide(); } });
  moveHandle.addEventListener('keydown', event => keyboard(event)); resize.addEventListener('keydown', event => keyboard(event, true));
  for (const handle of [moveHandle, resize]) handle.addEventListener('pointerdown', event => {
    if (event.button !== 0 || innerWidth < 640) return;
    cancelGesture?.(); event.preventDefault(); handle.focus({ preventScroll: true });
    const rect = floating.getBoundingClientRect(); const x = event.clientX; const y = event.clientY; const id = event.pointerId;
    handle.setPointerCapture(id);
    let frame: number | null = null; let latest = { dx: 0, dy: 0 };
    floating.dataset.gesture = handle === resize ? 'resize' : 'move';
    const flush = () => {
      if (frame !== null) cancelAnimationFrame(frame); frame = null;
      const width = handle === resize ? Math.min(innerWidth, Math.max(320, rect.width + latest.dx)) : rect.width;
      const height = handle === resize ? Math.min(innerHeight, Math.max(280, rect.height + latest.dy)) : rect.height;
      const left = Math.max(0, Math.min(rect.left + (handle === resize ? 0 : latest.dx), innerWidth - width));
      const top = Math.max(0, Math.min(rect.top + (handle === resize ? 0 : latest.dy), innerHeight - height));
      floating.style.left = `${left}px`; floating.style.top = `${top}px`;
      floating.style.width = `${width}px`; floating.style.height = `${height}px`;
      onLayout?.();
    };
    const move = (next: PointerEvent) => {
      if (next.pointerId !== id) return;
      latest = { dx: next.clientX - x, dy: next.clientY - y };
      if (frame === null) frame = requestAnimationFrame(flush);
    };
    const stop = () => {
      handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', finish); handle.removeEventListener('pointercancel', cancel); handle.removeEventListener('lostpointercapture', cancel);
      if (frame !== null) cancelAnimationFrame(frame); frame = null; delete floating.dataset.gesture;
      cancelGesture = null; if (handle.hasPointerCapture(id)) handle.releasePointerCapture(id); remember();
    };
    const cancel = (next?: PointerEvent) => { if (next && next.pointerId !== id) return; floating.style.left = `${rect.left}px`; floating.style.top = `${rect.top}px`; floating.style.width = `${rect.width}px`; floating.style.height = `${rect.height}px`; clamp(); stop(); };
    const finish = (next: PointerEvent) => { if (next.pointerId === id) { if (frame !== null) flush(); stop(); } };
    cancelGesture = cancel;
    handle.addEventListener('pointermove', move); handle.addEventListener('pointerup', finish); handle.addEventListener('pointercancel', cancel); handle.addEventListener('lostpointercapture', cancel);
  });
  window.addEventListener('resize', clamp);
  return { position(x: number, y: number) { floating.style.left = `${x}px`; floating.style.top = `${y}px`; clamp(); }, mount(host: HTMLElement) { dock = host; syncTheme(); if (mode !== 'float' && mode !== 'popout') host.append(element); }, present, hide, current: () => mode,
    setNativeFloating(native: boolean, bounds?: { left: number; top: number; width: number; height: number }) {
      floating.dataset.nativeFloating = String(native);
      if (!native || !bounds || mode !== 'float') return;
      const rect = floating.getBoundingClientRect();
      if (rect.left === bounds.left && rect.top === bounds.top && rect.width === bounds.width && rect.height === bounds.height) return;
      for (const key of ['left', 'top', 'width', 'height'] as const) floating.style.setProperty(key, `${bounds[key]}px`);
      remember(); onLayout?.();
    },
    setAgentControlled(controlled: boolean) { floating.dataset.agentControlled = String(controlled); floating.inert = controlled; floating.setAttribute('aria-label', controlled ? '에이전트가 사용 중인 브라우저 미리보기' : '떠 있는 브라우저'); },
    dispose() { hide(); themeObserver.disconnect(); window.removeEventListener('resize', clamp); floating.remove(); element.remove(); }, };
}
