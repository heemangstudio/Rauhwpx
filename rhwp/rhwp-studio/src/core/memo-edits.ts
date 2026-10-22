/**
 * 메모 쓰기 — 화면(오버레이)·명령·테스트가 같은 경로를 쓴다. 모두 편집 라우터의
 * snapshot 연산이라 실행 취소·다시 실행·수정 표시가 일반 편집과 같다.
 */
import type { DocumentPosition, MemoNotePath } from './types';
import type { WasmBridge } from './wasm-bridge';

/** executeOperation 을 가진 편집 호스트 (InputHandler). */
export interface MemoEditHost {
  executeOperation(desc: {
    kind: 'snapshot';
    operationType: string;
    operation: (wasm: WasmBridge) => DocumentPosition;
  }): void;
  getCursorPosition(): DocumentPosition;
}

/** 새 메모를 넣는다. 빈 내용이면 아무것도 하지 않는다. 새 fieldId 또는 null. */
export function commitMemoInsert(
  host: MemoEditHost,
  path: MemoNotePath,
  start: number,
  end: number,
  text: string,
  author?: string,
): number | null {
  if (text.trim() === '') return null;
  let fieldId: number | null = null;
  host.executeOperation({
    kind: 'snapshot',
    operationType: 'insertMemoNote',
    operation: (wasm) => {
      fieldId = wasm.insertMemoNote(path, start, end, text, author || undefined);
      return host.getCursorPosition();
    },
  });
  return fieldId;
}

/** 메모 본문을 바꾼다. 같은 글이면 기록하지 않는다. */
export function commitMemoEdit(host: MemoEditHost, wasm: WasmBridge, fieldId: number, text: string): boolean {
  const current = wasm.getMemoNoteList().find((memo) => memo.fieldId === fieldId);
  if (!current || current.text === text) return false;
  let changed = false;
  host.executeOperation({
    kind: 'snapshot',
    operationType: 'editMemoNote',
    operation: (bridge) => {
      changed = bridge.setMemoNoteText(fieldId, text);
      return host.getCursorPosition();
    },
  });
  return changed;
}

/** 메모 하나를 지운다 (앵커 글자는 남는다). */
export function commitMemoDelete(host: MemoEditHost, fieldId: number): void {
  host.executeOperation({
    kind: 'snapshot',
    operationType: 'deleteMemoNote',
    operation: (wasm) => {
      wasm.deleteMemoNote(fieldId);
      return host.getCursorPosition();
    },
  });
}

/** 모든 메모를 지운다. 지운 수를 돌려준다. */
export function commitMemoDeleteAll(host: MemoEditHost): number {
  let removed = 0;
  host.executeOperation({
    kind: 'snapshot',
    operationType: 'deleteAllMemoNotes',
    operation: (wasm) => {
      removed = wasm.deleteAllMemoNotes();
      return host.getCursorPosition();
    },
  });
  return removed;
}
