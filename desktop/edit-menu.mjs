// 게스트 페이지(앱 내 브라우저)가 포커스를 가졌을 때 쓰는 Chromium 편집 명령.
const NATIVE_EDIT_METHODS = {
  undo: 'undo',
  redo: 'redo',
  delete: 'delete',
  'select-all': 'selectAll',
};

// 문서는 canvas 모델에 저장되므로 Chromium의 숨은 입력 undo 스택을 사용하지 않는다.
// 다만 포커스가 창의 다른 웹 콘텐츠(앱 내 브라우저 페이지)에 있으면 그 페이지에서 명령을 실행한다.
export function documentEditMenuItem(command, label, accelerator, { focusedWebContents = () => null } = {}) {
  return {
    label,
    ...(accelerator ? { accelerator } : {}),
    click: (_item, window) => {
      if (!window || window.isDestroyed?.()) return;
      const contents = window.webContents;
      if (!contents || contents.isDestroyed?.()) return;
      const focused = focusedWebContents();
      if (focused && focused !== contents && !focused.isDestroyed?.()) {
        const method = NATIVE_EDIT_METHODS[command];
        if (method && typeof focused[method] === 'function') focused[method]();
        return;
      }
      contents.send('desktop:edit-command', command);
    },
  };
}
