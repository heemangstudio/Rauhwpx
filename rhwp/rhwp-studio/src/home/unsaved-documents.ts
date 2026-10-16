/**
 * 저장하지 않은 새 문서. 이 창의 문서와, 데스크톱이면 다른 창의 문서까지 모아 문서 홈에 보인다.
 * 다른 창의 문서는 그 창을 앞으로 불러 그 창에서 열고 저장한다.
 */
import {
  desktopUnsavedDocumentsApi,
  type DesktopUnsavedDocument,
  type UnsavedDocumentAction,
  type UnsavedDocumentReport,
} from '../desktop-integration.ts';

export type UnsavedDocument = DesktopUnsavedDocument;
export type { UnsavedDocumentAction, UnsavedDocumentReport };

export interface UnsavedDocumentSource {
  /** 이 창에 열린, 아직 경로가 없는 새 문서. */
  local(): UnsavedDocumentReport[];
  run(documentId: string, action: UnsavedDocumentAction): Promise<void>;
}

export interface UnsavedDocuments {
  /** 새것부터. 부를 때마다 이 창의 문서를 다시 센다. */
  list(): readonly UnsavedDocument[];
  subscribe(listener: () => void): () => void;
  /** 이 창의 새 문서가 바뀌었을 수 있다. 같은 틱의 알림은 한 번으로 모은다. */
  invalidate(): void;
  run(document: UnsavedDocument, action: UnsavedDocumentAction): Promise<void>;
}

export function createUnsavedDocuments(source: UnsavedDocumentSource): UnsavedDocuments {
  const desktop = desktopUnsavedDocumentsApi();
  const listeners = new Set<() => void>();
  let localKey = '';
  let local: UnsavedDocumentReport[] = [];
  let remote: UnsavedDocument[] = [];
  let merged: UnsavedDocument[] = [];
  let queued = false;

  /** 바뀌었으면 true. 이 창의 목록이 바뀌면 다른 창에도 알린다. */
  function refresh(): boolean {
    const next = source.local();
    const key = JSON.stringify(next);
    if (key !== localKey) {
      localKey = key;
      local = next;
      desktop?.setUnsavedDocuments(next);
    }
    const combined = [...local.map((doc) => ({ ...doc, local: true })), ...remote]
      .sort((a, b) => b.createdAt - a.createdAt);
    if (JSON.stringify(combined) === JSON.stringify(merged)) return false;
    merged = combined;
    return true;
  }

  function notify(): void {
    for (const listener of [...listeners]) listener();
  }

  // 자기 창의 문서는 메인을 거치지 않고 바로 센다.
  function acceptRemote(documents: DesktopUnsavedDocument[]): void {
    remote = documents.filter((doc) => !doc.local && typeof doc.documentId === 'string');
    if (refresh()) notify();
  }

  if (desktop) {
    desktop.onUnsavedDocumentsChanged(acceptRemote);
    void desktop.listUnsavedDocuments().then(acceptRemote).catch(() => {});
    desktop.onUnsavedDocumentAction((documentId, action) => { void source.run(documentId, action); });
  }

  return {
    list() {
      refresh();
      return merged;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    invalidate() {
      if (queued) return;
      queued = true;
      queueMicrotask(() => {
        queued = false;
        if (refresh()) notify();
      });
    },
    async run(document, action) {
      if (document.local) await source.run(document.documentId, action);
      else await desktop?.runUnsavedDocumentAction(document.documentId, action);
    },
  };
}
