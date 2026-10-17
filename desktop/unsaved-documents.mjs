/**
 * Unsaved new documents across windows. Each window reports its own list and
 * every window's document home shows all of them, so a new document left in a
 * window behind the current one can still be found and saved.
 */
const MAX_DOCUMENTS_PER_WINDOW = 64;
const DOCUMENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function normalizeUnsavedDocuments(input) {
  if (!Array.isArray(input)) return [];
  const seen = new Set();
  const documents = [];
  for (const item of input.slice(0, MAX_DOCUMENTS_PER_WINDOW)) {
    const documentId = item?.documentId;
    if (typeof documentId !== 'string' || !DOCUMENT_ID_PATTERN.test(documentId) || seen.has(documentId)) continue;
    seen.add(documentId);
    documents.push({
      documentId,
      fileName: typeof item.fileName === 'string' ? item.fileName.slice(0, 255) : '',
      edited: item.edited === true,
      createdAt: Number.isFinite(item.createdAt) ? Number(item.createdAt) : 0,
    });
  }
  return documents;
}

export class UnsavedDocumentRegistry {
  // sessionId -> that window's unsaved documents
  #bySession = new Map();

  /** Replace a window's list. True when it changed. */
  set(sessionId, input) {
    const next = normalizeUnsavedDocuments(input);
    const previous = this.#bySession.get(sessionId) ?? [];
    if (JSON.stringify(previous) === JSON.stringify(next)) return false;
    if (next.length) this.#bySession.set(sessionId, next);
    else this.#bySession.delete(sessionId);
    return true;
  }

  /** Drop a closed, crashed or reloaded window's list. True when it had one. */
  forget(sessionId) {
    return this.#bySession.delete(sessionId);
  }

  ownerOf(documentId) {
    for (const [sessionId, documents] of this.#bySession) {
      if (documents.some((document) => document.documentId === documentId)) return sessionId;
    }
    return null;
  }

  /** Every window's documents as seen from one window: its own are `local`. */
  listFor(viewerSessionId) {
    return [...this.#bySession].flatMap(([sessionId, documents]) => (
      documents.map((document) => ({ ...document, local: sessionId === viewerSessionId }))
    ));
  }
}
