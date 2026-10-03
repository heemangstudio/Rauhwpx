import { CloudError } from './protocol.mjs';

const MAX_TIMELINE_BYTES = 100 * 1024 * 1024;
const archivedDocuments = new WeakMap();

export async function archiveDocumentBoundary({ lease, sessionStore, blobStore, sessionId, boundary }) {
  if (!lease?.enabled || !['operation', 'turn'].includes(boundary.kind)) return;
  const session = sessionStore.getSessionRow(sessionId);
  const existing = sessionStore.database.prepare(`
    SELECT 1 FROM session_checkpoints WHERE session_id = ? AND operation_id = ?
  `).get(sessionId, boundary.operationId);
  if (!existing) {
    const turn = session.current_turn_id ? sessionStore.database.prepare(`
      SELECT turn_number AS turnNumber FROM session_turns WHERE id = ? AND session_id = ?
    `).get(session.current_turn_id, sessionId) : null;
    const expectedTurn = turn?.turnNumber ?? (boundary.kind === 'operation' ? session.turns_used : session.turns_used + 1);
    if (boundary.turnNumber !== expectedTurn
      || (session.protocol_version === 2 && boundary.kind === 'turn' && !turn)) {
      throw new CloudError('TURN_IDENTITY_CONFLICT', 'Cloud boundary does not belong to the current turn', 409);
    }
    const latest = sessionStore.database.prepare(`
      SELECT MAX(revision) AS revision FROM session_checkpoints WHERE session_id = ?
    `).get(sessionId);
    if (latest.revision !== null && boundary.revision <= latest.revision) {
      throw new CloudError('BOUNDARY_REVISION_CONFLICT', 'Cloud boundary revision must advance the document', 409);
    }
  }
  const { blob, stream } = blobStore.openReadStream(boundary.timeline.blobId);
  if (blob.size > MAX_TIMELINE_BYTES) {
    stream.destroy();
    throw new CloudError('TIMELINE_TOO_LARGE', 'Cloud timeline exceeds 100 MiB', 413);
  }
  const parts = [];
  let size = 0;
  for await (const part of stream) {
    size += part.length;
    if (size > MAX_TIMELINE_BYTES) throw new CloudError('TIMELINE_TOO_LARGE', 'Cloud timeline exceeds 100 MiB', 413);
    parts.push(part);
  }
  let timeline;
  try { timeline = JSON.parse(Buffer.concat(parts, size).toString('utf8')); } catch {
    throw new CloudError('TIMELINE_INVALID', 'Cloud timeline is invalid', 400);
  }
  const cloudStartId = timeline?.thread?.cloudStartId;
  if (!session.client_document_id || !session.client_thread_id
    || timeline?.thread?.id !== session.client_thread_id
    || typeof cloudStartId !== 'string' || !/^[A-Za-z0-9._:-]{1,160}$/.test(cloudStartId)) {
    throw new CloudError('CLOUD_START_IDENTITY_REQUIRED', 'Cloud document and start identity are required to retain this turn', 409);
  }
  const previous = archivedDocuments.get(lease)?.get(sessionId);
  if (boundary.kind === 'operation' && previous?.sha256 === boundary.checkpoint.blobId
    && previous.size === boundary.checkpoint.size && previous.documentId === session.client_document_id
    && previous.threadId === session.client_thread_id && previous.cloudStartId === cloudStartId
    && previous.expiresAt > Date.now() + 60_000) {
    return { complete: true, mergeRequest: previous, reused: true };
  }
  const document = blobStore.openReadStream(boundary.checkpoint.blobId);
  const receipt = await lease.archiveMergeRequest({
    sessionId,
    documentId: session.client_document_id,
    threadId: session.client_thread_id,
    cloudStartId,
    operationId: boundary.operationId,
    revision: boundary.revision,
    turn: boundary.turnNumber,
    kind: boundary.kind,
    fileName: session.origin_name,
    sha256: boundary.checkpoint.blobId,
    size: boundary.checkpoint.size,
  }, document.stream);
  const retained = receipt?.mergeRequest;
  if (receipt?.complete === true && retained?.id && retained.sessionId === sessionId
    && retained.documentId === session.client_document_id && retained.threadId === session.client_thread_id
    && retained.cloudStartId === cloudStartId && retained.kind === boundary.kind
    && retained.operationId === boundary.operationId && retained.sha256 === boundary.checkpoint.blobId
    && retained.size === boundary.checkpoint.size && Number.isSafeInteger(retained.expiresAt)
    && retained.expiresAt > Date.now() + 60_000) {
    let sessions = archivedDocuments.get(lease);
    if (!sessions) {
      sessions = new Map();
      archivedDocuments.set(lease, sessions);
    }
    sessions.set(sessionId, retained);
  }
  return receipt;
}
