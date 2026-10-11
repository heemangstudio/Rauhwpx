/** 문서 입력과 별도 폼/사이드바 입력의 단축키 소유권을 구분한다. */
export function isEditorInput(target: Element | null): boolean {
  return !!target?.closest('[data-rhwp-editor-input]');
}

export function ownsTextInput(target: Element | null): boolean {
  return !!target?.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]');
}

export function allowsDocumentShortcut(target: Element | null): boolean {
  if (isEditorInput(target)) return true;
  return !ownsTextInput(target)
    // 문서 홈은 가린 문서를 대신한다. 홈에서 누른 키가 보이지 않는 문서를 고치지 않는다.
    && !target?.closest('dialog, [role="dialog"], [aria-modal="true"], #agent-sidebar, #document-home');
}
