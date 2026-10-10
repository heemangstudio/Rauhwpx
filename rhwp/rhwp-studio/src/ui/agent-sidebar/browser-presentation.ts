import { createIcon } from './icons.ts';

export type BrowserPresentationMode = 'dock' | 'float' | 'popout';
export interface NativeBrowserApi {
  attach(args: { tabId: string; bounds: { x: number; y: number; width: number; height: number }; mode: BrowserPresentationMode; interactive: boolean }): Promise<unknown>;
  detach(args: { tabId: string }): Promise<unknown>;
  getState(args: { tabId: string }): Promise<unknown>;
  onEvent?(callback: (event: Record<string, unknown>) => void): () => void;
}
export function nativeBrowserApi(): NativeBrowserApi | undefined {
  return (globalThis as { rhwpDesktop?: { browser?: NativeBrowserApi } }).rhwpDesktop?.browser;
}

/** 한 DOM을 옮기며 페이지·입력·의견 상태를 유지한다. */
export function createBrowserPresentation(element: HTMLElement, onChange: (mode: BrowserPresentationMode | null) => void, onLayout?: () => void) {
  let dock: HTMLElement | null = null;
  let mode: BrowserPresentationMode | null = null;
  let popup: Window | null = null;
  let returnFocus: HTMLElement | null = null;
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
  floating.append(moveHandle, resize); document.body.append(floating);
  const clamp = () => {
    if (window.innerWidth < 640) return;
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
    syncTheme();
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
    if (next === 'float') { floating.insertBefore(element, resize); clamp(); }
    else dock?.append(element);
    element.hidden = false; set(next);
  }
  function hide(): void {
    if (dock) dock.append(element);
    if (popup) { const old = popup; popup = null; old.close(); }
    floating.hidden = true; element.hidden = true; set(null);
    returnFocus?.focus({ preventScroll: true }); returnFocus = null;
  }
  function keyboard(event: KeyboardEvent, size = false): void {
    if (!event.key.startsWith('Arrow')) return;
    event.preventDefault(); const rect = floating.getBoundingClientRect(); const amount = event.altKey ? 1 : 20;
    const dx = event.key === 'ArrowRight' ? amount : event.key === 'ArrowLeft' ? -amount : 0;
    const dy = event.key === 'ArrowDown' ? amount : event.key === 'ArrowUp' ? -amount : 0;
    if (size || event.shiftKey) { floating.style.width = `${Math.max(320, rect.width + dx)}px`; floating.style.height = `${Math.max(280, rect.height + dy)}px`; }
    else { floating.style.left = `${rect.left + dx}px`; floating.style.top = `${rect.top + dy}px`; }
    clamp(); remember();
  }
  moveHandle.addEventListener('keydown', event => keyboard(event)); resize.addEventListener('keydown', event => keyboard(event, true));
  for (const handle of [moveHandle, resize]) handle.addEventListener('pointerdown', event => {
    if (event.button !== 0 || innerWidth < 640) return;
    const rect = floating.getBoundingClientRect(); const x = event.clientX; const y = event.clientY;
    handle.setPointerCapture(event.pointerId);
    const move = (next: PointerEvent) => {
      const dx = next.clientX - x; const dy = next.clientY - y;
      if (handle === resize) { floating.style.width = `${Math.max(320, rect.width + dx)}px`; floating.style.height = `${Math.max(280, rect.height + dy)}px`; }
      else { floating.style.left = `${rect.left + dx}px`; floating.style.top = `${rect.top + dy}px`; }
      clamp();
    };
    const stop = () => { handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', stop); handle.removeEventListener('pointercancel', stop); remember(); };
    handle.addEventListener('pointermove', move); handle.addEventListener('pointerup', stop); handle.addEventListener('pointercancel', stop);
  });
  window.addEventListener('resize', clamp);
  return { mount(host: HTMLElement) { dock = host; syncTheme(); if (mode !== 'float' && mode !== 'popout') host.append(element); }, present, hide, current: () => mode,
    dispose() { hide(); themeObserver.disconnect(); window.removeEventListener('resize', clamp); floating.remove(); element.remove(); }, };
}
