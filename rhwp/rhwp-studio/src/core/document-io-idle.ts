/**
 * 문서 저장과 문서 열기가 둘 다 쉬는 순간까지 기다린다.
 *
 * 화면에 붙은 문서를 바꾸기 전에 쓴다. 저장을 기다리는 동안 열기가, 열기를 기다리는 동안 저장이
 * 시작될 수 있다. 저장 도중 문서를 바꾸면 그 저장의 마무리(현재 파일·이름·dirty 표시·북마크)가
 * 새로 붙은 문서에 닿아, 그 문서가 다른 문서의 파일을 가리키게 된다.
 */
export interface DocumentIoIdleDeps {
  whenSavesIdle(): Promise<void>;
  isSaving(): boolean;
  pendingLoads(): number;
  whenLoadsIdle(): Promise<void>;
}

export async function waitForDocumentIoIdle(deps: DocumentIoIdleDeps): Promise<void> {
  for (;;) {
    await deps.whenSavesIdle();
    while (deps.pendingLoads() > 0) await deps.whenLoadsIdle();
    if (!deps.isSaving() && deps.pendingLoads() === 0) return;
  }
}
