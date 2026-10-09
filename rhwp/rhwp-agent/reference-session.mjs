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
  return {
    threadId: threadId === undefined || threadId === null
      ? (!force && existing?.threadId ? existing.threadId : createThreadId())
      : normalizeStableScopeId(threadId, 'threadId'),
    documentId: documentId === undefined
      ? (!force ? (existing?.documentId ?? null) : null)
      : normalizeStableScopeId(documentId, 'documentId', { optional: true }),
    documentName: documentName === undefined
      ? (!force ? (existing?.documentName ?? null) : null)
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

/** Add stable identity to the live document-info result returned by Studio. */
export function attachActiveDocumentIdentity(result, identity) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return result;
  return { ...result, ...activeDocumentIdentity(identity) };
}

/** Give every agent turn exact open-document identity without filename search. */
export function addActiveDocumentContext(activeSession, prompt) {
  const identity = activeDocumentIdentity(activeSession);
  const block = [
    '<active_document_identity trust="application-state">',
    JSON.stringify(identity),
    'This is the exact Studio document bound to this chat. All rhwp document tools target this documentId.',
    'Use documentId—not documentName, title matching, recent-file lists, or filesystem search—to decide which open document the user means. Call get_document_info for its digest, source format, dirty state, and exact sourcePath when the desktop app has one.',
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
