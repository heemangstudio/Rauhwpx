import type { DocumentDirtyState } from '../core/document-dirty-state.ts';

export interface HostSaveDeps {
  documentState: Pick<DocumentDirtyState, 'isDirty' | 'captureRevision' | 'markCleanIfUnchanged'>;
  setFileName: (fileName: string) => void;
  /** document-context-changed 와 document-saved 를 알린다. clean 여부와 관계없이 부른다. */
  emitSaved: () => void;
  discardDraft: (reason: string) => Promise<void>;
}

/**
 * 호스트 저장 완료 통지 (#2660).
 *
 * 호스트는 export → 업로드 → notifySaved 순서로 부른다. 업로드하는 동안 입력한 내용은 호스트가
 * 저장한 바이트에 없으므로, 마지막 export 이후 편집이 있으면 dirty 와 자동 저장 draft 를 남긴다.
 * RPC 로 export 하지 않는 호스트(팝업 통합 등)는 통지 시점의 문서를 저장한 것으로 본다.
 */
export class HostSaveTracker {
  private readonly deps: HostSaveDeps;
  private exportRevision: number | null = null;

  constructor(deps: HostSaveDeps) {
    this.deps = deps;
  }

  /** 호스트가 RPC 로 문서 바이트를 받아 갈 때 부른다. */
  recordExport(): void {
    this.exportRevision = this.deps.documentState.captureRevision();
  }

  /** 다른 문서를 열면 이전 문서의 export 기록은 의미가 없다. */
  reset(): void {
    this.exportRevision = null;
  }

  /**
   * draft 삭제 "완료"까지 await하므로, resolve 이후 팝업을 닫아도 IndexedDB
   * 삭제가 잘리지 않는다. export 시점에는 호출하지 않는다(실패 시 백업 보존).
   */
  async complete(fileName?: string): Promise<{ ok: true; wasDirty: boolean }> {
    const { documentState } = this.deps;
    const wasDirty = documentState.isDirty();
    if (fileName) this.deps.setFileName(fileName);
    const cleaned = documentState.markCleanIfUnchanged(
      this.exportRevision ?? documentState.captureRevision(),
      'host-save',
    );
    this.deps.emitSaved();
    if (cleaned) await this.deps.discardDraft('host-save');
    return { ok: true, wasDirty };
  }
}
