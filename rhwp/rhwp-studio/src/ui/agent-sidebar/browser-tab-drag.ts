/** 탭을 작업 공간 밖으로 끌면 원본 페이지를 떠 있는 창으로 옮긴다. */
export function installBrowserTabDrag(button: HTMLElement, bounds: () => DOMRect, detach: (point: { x: number; y: number }) => void): void {
  button.style.touchAction = 'none';
  button.addEventListener('pointerdown', start => {
    if (start.button !== 0) return;
    const box = bounds(); const id = start.pointerId;
    let ghost: HTMLElement | null = null, frame: number | null = null;
    let point = { x: start.clientX, y: start.clientY }; let dragged = false;
    const outside = () => point.x < box.left - 12 || point.x > box.right + 12 || point.y < box.top - 12 || point.y > box.bottom + 12;
    const render = () => { frame = null; if (!ghost) return; ghost.style.transform = `translate3d(${point.x + 12}px,${point.y + 12}px,0)`; ghost.dataset.detached = String(outside()); };
    const move = (event: PointerEvent) => {
      if (event.pointerId !== id) return;
      point = { x: event.clientX, y: event.clientY };
      if (!dragged && Math.hypot(point.x - start.clientX, point.y - start.clientY) < 8) return;
      if (!ghost) { dragged = true; ghost = document.createElement('div'); ghost.className = 'ag-browser-tab-drag'; ghost.textContent = button.textContent; ghost.setAttribute('aria-hidden', 'true'); document.body.append(ghost); }
      if (frame === null) frame = requestAnimationFrame(render);
    };
    const cleanup = () => {
      if (frame !== null) cancelAnimationFrame(frame); ghost?.remove();
      button.removeEventListener('pointermove', move); button.removeEventListener('pointerup', finish); button.removeEventListener('pointercancel', cancel); button.removeEventListener('lostpointercapture', cancel);
      if (button.hasPointerCapture(id)) button.releasePointerCapture(id);
    };
    const cancel = () => cleanup();
    const finish = (event: PointerEvent) => { if (event.pointerId !== id) return; point = { x: event.clientX, y: event.clientY }; const detached = dragged && outside(); cleanup(); if (detached) detach({ x: point.x - 32, y: point.y - 16 }); };
    button.addEventListener('click', event => { if (dragged) { event.preventDefault(); event.stopImmediatePropagation(); } }, { capture: true, once: true });
    button.setPointerCapture(id); button.addEventListener('pointermove', move); button.addEventListener('pointerup', finish); button.addEventListener('pointercancel', cancel); button.addEventListener('lostpointercapture', cancel);
  });
}
