/**
 * 문서 기억 — 허브 프레임 읽기와 앵커 확인.
 *
 * 정본은 허브(rhwp-agent/document-memory-store.mjs)에 있다. Studio 는 지금 문서의 기억을 한 벌 들고
 * 있다가, 사용자 메시지를 보내기 직전에 글에 매인 항목의 인용이 문서에 남아 있는지 엔진 검색으로
 * 확인해 사라진 항목 id 를 함께 보낸다(memoryMissingAnchors). 허브는 그 항목을 프롬프트에서 뺀다.
 */
import type {
  DocumentMemory,
  DocumentMemoryChange,
  DocumentMemoryEntry,
  DocumentMemoryKind,
  DocumentMemoryResult,
} from './types.ts';

export const DOCUMENT_MEMORY_KINDS: readonly DocumentMemoryKind[] = ['decision', 'term', 'protect', 'style', 'fact'];
/** 한 번의 메시지에서 확인하는 앵커 수의 상한 — 문서당 항목 상한과 같다. */
export const MAX_ANCHOR_CHECKS = 40;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readEntry(value: unknown): DocumentMemoryEntry | null {
  if (!isRecord(value)) return null;
  const { id, kind, subject, text, origin, evidence, createdAt, updatedAt, confirmedAt } = value;
  if (typeof id !== 'string' || !id || typeof subject !== 'string' || typeof text !== 'string') return null;
  if (!DOCUMENT_MEMORY_KINDS.includes(kind as DocumentMemoryKind)) return null;
  if (origin !== 'explicit' && origin !== 'learned' && origin !== 'user') return null;
  const entry: DocumentMemoryEntry = {
    id,
    kind: kind as DocumentMemoryKind,
    subject,
    text,
    origin,
    evidence: typeof evidence === 'number' && Number.isFinite(evidence) ? evidence : 1,
    createdAt: typeof createdAt === 'string' ? createdAt : '',
    updatedAt: typeof updatedAt === 'string' ? updatedAt : '',
    confirmedAt: typeof confirmedAt === 'string' ? confirmedAt : '',
  };
  if (isRecord(value.anchor) && typeof value.anchor.quote === 'string' && value.anchor.quote) {
    entry.anchor = {
      quote: value.anchor.quote,
      ...(Number.isSafeInteger(value.anchor.paraIdx) ? { paraIdx: value.anchor.paraIdx as number } : {}),
    };
  }
  if (isRecord(value.source)) {
    const source: NonNullable<DocumentMemoryEntry['source']> = {};
    if (typeof value.source.threadId === 'string') source.threadId = value.source.threadId;
    if (typeof value.source.turnId === 'string') source.turnId = value.source.turnId;
    if (value.source.kind === 'turn' || value.source.kind === 'signal' || value.source.kind === 'history' || value.source.kind === 'copy') {
      source.kind = value.source.kind;
    }
    entry.source = source;
  }
  if (value.userCandidate === true) entry.userCandidate = true;
  if (value.promoted === true) entry.promoted = true;
  return entry;
}

export function readDocumentMemory(value: unknown): DocumentMemory | null {
  if (!isRecord(value) || typeof value.key !== 'string' || !Number.isSafeInteger(value.revision)) return null;
  const entries = Array.isArray(value.entries)
    ? value.entries.map(readEntry).filter((entry): entry is DocumentMemoryEntry => entry !== null)
    : [];
  return { key: value.key, revision: value.revision as number, entries };
}

function readChange(value: unknown): DocumentMemoryChange | null {
  if (!isRecord(value) || typeof value.entryId !== 'string') return null;
  if (value.op !== 'add' && value.op !== 'update' && value.op !== 'remove') return null;
  const entry = readEntry(value.entry);
  const prev = readEntry(value.prev);
  return { op: value.op, entryId: value.entryId, ...(entry ? { entry } : {}), ...(prev ? { prev } : {}) };
}

/** document-memory-result 프레임을 결과로 읽는다. */
export function readDocumentMemoryResult(msg: Record<string, unknown>): DocumentMemoryResult {
  const memory = readDocumentMemory(msg.memory);
  const changes = Array.isArray(msg.changes)
    ? msg.changes.map(readChange).filter((change): change is DocumentMemoryChange => change !== null)
    : undefined;
  const ids = (value: unknown): string[] | undefined => (
    Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : undefined
  );
  const reverted = ids(msg.reverted);
  const skipped = ids(msg.skipped);
  const error = isRecord(msg.error)
    ? {
      code: typeof msg.error.code === 'string' ? msg.error.code : 'DOCUMENT_MEMORY_FAILED',
      message: typeof msg.error.message === 'string' ? msg.error.message : '문서 기억을 처리하지 못했습니다.',
    }
    : undefined;
  return {
    ok: msg.ok === true,
    ...(memory ? { memory } : {}),
    ...(changes ? { changes } : {}),
    ...(reverted ? { reverted } : {}),
    ...(skipped ? { skipped } : {}),
    ...(error ? { error } : {}),
  };
}

/**
 * 글에 매인 항목 가운데 인용이 문서에서 사라진 것의 id. 앵커가 없는 기억은 검색하지 않는다.
 * found 는 문서 전체(표 칸 포함)에 그 글이 있는지 답한다. 검색이 실패하면 남아 있다고 본다.
 */
export function missingAnchorIds(
  entries: readonly DocumentMemoryEntry[],
  found: (quote: string) => boolean,
  limit = MAX_ANCHOR_CHECKS,
): string[] {
  const missing: string[] = [];
  let checked = 0;
  for (const entry of entries) {
    const quote = entry.anchor?.quote;
    if (!quote) continue;
    if (checked >= limit) break;
    checked += 1;
    let present = true;
    try {
      present = found(quote);
    } catch {
      present = true;
    }
    if (!present) missing.push(entry.id);
  }
  return missing;
}
