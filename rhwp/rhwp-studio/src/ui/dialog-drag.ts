export interface DialogDragOptions {
  ignoreSelector?: string;
}

/** 끌어 놓은 대화상자를 창 안에 둔다. 창이 대화상자보다 작으면 왼쪽 위(제목 막대)를 남긴다. */
function clampToViewport(dialog: HTMLElement, left: number, top: number): void {
  const maxLeft = Math.max(0, window.innerWidth - dialog.offsetWidth);
  const maxTop = Math.max(0, window.innerHeight - dialog.offsetHeight);
  dialog.style.left = `${Math.min(Math.max(left, 0), maxLeft)}px`;
  dialog.style.top = `${Math.min(Math.max(top, 0), maxTop)}px`;
}

export function enableDialogDrag(
  dialog: HTMLElement,
  titleEl: HTMLElement,
  options: DialogDragOptions = {},
): () => void {
  const ignoreSelector = options.ignoreSelector ?? '.dialog-close';
  let offsetX = 0;
  let offsetY = 0;
  let dragging = false;

  const stopDrag = () => {
    dragging = false;
    document.removeEventListener('mousemove', move);
    document.removeEventListener('mouseup', stopDrag);
  };

  const move = (e: MouseEvent) => {
    if (!dragging) return;
    clampToViewport(dialog, e.clientX - offsetX, e.clientY - offsetY);
  };

  // 끌어 둔 대화상자는 창이 줄어도 창 밖으로 밀려나지 않아야 닫기 단추를 누를 수 있다.
  const keepInView = () => {
    if (!dialog.isConnected || !dialog.style.left) return;
    clampToViewport(dialog, parseFloat(dialog.style.left), parseFloat(dialog.style.top));
  };

  const startDrag = (e: MouseEvent) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement | null;
    if (target?.closest(ignoreSelector)) return;

    const rect = dialog.getBoundingClientRect();
    offsetX = e.clientX - rect.left;
    offsetY = e.clientY - rect.top;

    dialog.style.position = 'fixed';
    dialog.style.left = `${rect.left}px`;
    dialog.style.top = `${rect.top}px`;
    dialog.style.margin = '0';
    dialog.style.transform = 'none';
    window.addEventListener('resize', keepInView);

    dragging = true;
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', stopDrag);
    e.preventDefault();
  };

  titleEl.addEventListener('mousedown', startDrag);

  return () => {
    titleEl.removeEventListener('mousedown', startDrag);
    window.removeEventListener('resize', keepInView);
    stopDrag();
  };
}
