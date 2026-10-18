import crypto from 'node:crypto';

import { scopesForReferenceSession } from './reference-store.mjs';

function sessionError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function normalizeStableScopeId(value, label, { optional = false } = {}) {
  if ((value === undefined || value === null) && optional) return null;
  if (typeof value !== 'string') throw sessionError('INVALID_REQUEST', `${label} must be a string`);
  const normalized = value.normalize('NFKC').trim();
  if (!normalized || normalized.length > 256 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw sessionError('INVALID_REQUEST', `${label} is invalid`);
  }
  return normalized;
}

export function normalizeDocumentName(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw sessionError('INVALID_REQUEST', 'documentName must be a string');
  const normalized = value.normalize('NFKC').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!normalized || normalized.length > 500) throw sessionError('INVALID_REQUEST', 'documentName is invalid');
  return normalized;
}

/** Resolve stable scope fields while retaining compatibility with old Studio clients. */
export function resolveSessionIdentity({
  threadId,
  documentId,
  documentName,
  existing = null,
  force = false,
  createThreadId = () => crypto.randomUUID(),
} = {}) {
  const resolvedDocumentId = documentId === undefined
    ? (!force ? (existing?.documentId ?? null) : null)
    : normalizeStableScopeId(documentId, 'documentId', { optional: true });
  return {
    threadId: threadId === undefined || threadId === null
      ? (!force && existing?.threadId ? existing.threadId : createThreadId())
      : normalizeStableScopeId(threadId, 'threadId'),
    documentId: resolvedDocumentId,
    // A name belongs to its document: switching documents (e.g. detaching to none) never inherits it.
    documentName: documentName === undefined
      ? (!force && (existing?.documentId ?? null) === resolvedDocumentId ? (existing?.documentName ?? null) : null)
      : normalizeDocumentName(documentName),
  };
}

/** Fail stale queued messages before they can retrieve or leak another scope. */
export function assertMessageScope(activeSession, message) {
  if (Object.prototype.hasOwnProperty.call(message, 'threadId')) {
    const received = normalizeStableScopeId(message.threadId, 'threadId');
    if (received !== activeSession.threadId) {
      throw sessionError('STALE_CHAT_SCOPE', 'Message threadId does not match the active chat');
    }
  }
  if (Object.prototype.hasOwnProperty.call(message, 'documentId')) {
    const received = normalizeStableScopeId(message.documentId, 'documentId', { optional: true });
    if (received !== activeSession.documentId) {
      throw sessionError('STALE_DOCUMENT_SCOPE', 'Message documentId does not match the active document');
    }
  }
  return true;
}

export function referenceScopesForSession(activeSession) {
  return scopesForReferenceSession({
    threadId: activeSession?.threadId,
    documentId: activeSession?.documentId,
    projectId: activeSession?.projectId,
  });
}

/** Exact Studio document identity bound to this chat; names are display-only. */
export function activeDocumentIdentity(activeSession) {
  return {
    documentId: typeof activeSession?.documentId === 'string' ? activeSession.documentId : null,
    documentName: typeof activeSession?.documentName === 'string' ? activeSession.documentName : null,
  };
}

/**
 * A chat with no document: neither a stable documentId nor a legacy document name (threads from
 * before document ids carry only the name and still have their document).
 */
export function sessionHasNoDocument(activeSession) {
  return !activeSession?.documentId && !activeSession?.documentName;
}

/** Add stable identity to the live document-info result returned by Studio. */
export function attachActiveDocumentIdentity(result, identity) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return result;
  return { ...result, ...activeDocumentIdentity(identity) };
}

/** A chat without a document until open_document/create_document attaches one. */
const NO_DOCUMENT_LINES = Object.freeze([
  'No document is linked to this chat. Read tools still read other documents by documentId; list_documents finds them.',
  'When the task needs a document to work in, open_document attaches an existing one and create_document (에이전트, 전체 or an approved plan) makes a new one. A chat has one document at a time; detach_document or the user can detach it later. Saving to the project (project_edit, project_import, project downloads) needs a linked document.',
]);

/**
 * chat-start 의 detachedFrom: 사용자가 이 채팅을 떼어 낸 문서. 모양이 어긋나면 버린다(null).
 * 문서 이름은 표시용이라 이름만 잘못됐으면 이름 없이 남긴다.
 */
export function normalizeDetachedFrom(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  let documentId;
  try {
    documentId = normalizeStableScopeId(value.documentId, 'detachedFrom.documentId');
  } catch {
    return null;
  }
  let documentName = null;
  try {
    documentName = normalizeDocumentName(value.documentName);
  } catch {}
  return { documentId, documentName };
}

function documentLabel({ documentId, documentName }) {
  return documentName ? `the document ${JSON.stringify(documentName)} (documentId ${documentId})` : `the document with documentId ${documentId}`;
}

/** 떼어 낸 직후의 네이티브 압축 지시 — 한 줄. */
export function detachCompactionInstructions(detachedFrom) {
  return `This chat was just detached from ${documentLabel(detachedFrom)}. Keep what the user and assistant discussed, decided and learned about it, since the user may need that context later; drop raw tool output. The chat can no longer edit that document or use its project files.`;
}

/**
 * 문서 연결이 바뀐 것을 다음 사용자 턴에 한 번 알리는 블록. note: { detach?, attach? } —
 * 둘 다 있으면 "A 에서 떼어 냈고 지금은 B 에 연결됐다" 한 덩이로 쓴다.
 */
export function documentChangeBlock(note) {
  const attach = note?.attach ?? null;
  // 떼어 낸 문서를 다시 붙였으면 연결만 알린다.
  const detach = note?.detach && note.detach.documentId !== attach?.documentId ? note.detach : null;
  const lines = [];
  if (detach) {
    lines.push(`The user detached this chat from ${documentLabel(detach)}. It can still read that document read-only by its documentId, but cannot edit it or use its project or reference files.`);
    if (!attach) lines.push('No document is linked now. When the user wants to write or save, suggest attaching one with open_document or create_document.');
  }
  if (attach) {
    lines.push(`This chat is now attached to ${documentLabel(attach)}. Document writes target it, and its project panel and reference files are available through project_read, search_reference_files and the other project tools.`);
  }
  if (lines.length === 0) return '';
  return ['<document_change trust="application-state">', ...lines, '</document_change>'].join('\n');
}

/** Give every agent turn exact open-document identity without filename search. */
export function addActiveDocumentContext(activeSession, prompt) {
  const identity = activeDocumentIdentity(activeSession);
  const block = [
    '<active_document_identity trust="application-state">',
    JSON.stringify(identity),
    ...(sessionHasNoDocument(activeSession) ? NO_DOCUMENT_LINES : [
      'This is the exact Studio document bound to this chat; detach_document or the user can detach it, and this block always names the current one. Writes and default reads target this documentId; read tools accept another documentId (read-only). To work in another document, detach_document first, then open_document or create_document.',
      'Use documentId—not documentName, title matching, recent-file lists, or filesystem search—to decide which open document the user means. Call get_document_info for its digest, source format, dirty state, and exact sourcePath when the desktop app has one.',
    ]),
    '</active_document_identity>',
  ].join('\n');
  return `${block}\n\n${prompt}`;
}

/** Studio caps its snapshot text at 8,000 chars; anything far beyond that is not a snapshot. */
const LIVE_DOCUMENT_MAX_CHARS = 12_000;

/**
 * Studio's optional read of the open document, sent with a user message.
 * Returns the one valid form or null; a malformed snapshot never rejects the message.
 */
export function normalizeDocumentSnapshot(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { revision, text, unchanged } = value;
  if (!Number.isSafeInteger(revision) || revision < 0) return null;
  if (unchanged !== undefined) {
    return unchanged === true && text === undefined ? { revision, unchanged: true } : null;
  }
  if (typeof text !== 'string' || text.length === 0 || text.length > LIVE_DOCUMENT_MAX_CHARS) return null;
  return { revision, text };
}

/**
 * The prompt block that puts Studio's get_structure read in front of the
 * user's request, so the turn does not spend its first model request on
 * reading. Empty when there is no valid snapshot. Document text is untrusted
 * data like a tool result: it must not be able to close the block.
 */
export function liveDocumentBlock(snapshot) {
  const live = normalizeDocumentSnapshot(snapshot);
  if (!live) return '';
  if (live.unchanged) return `<live_document revision="${live.revision}" unchanged="true"/>`;
  const text = live.text.replace(/<(\s*)\/(\s*live_document)/gi, '<$1\\/$2');
  return `<live_document revision="${live.revision}" trust="untrusted-data">\n${text}\n</live_document>`;
}
