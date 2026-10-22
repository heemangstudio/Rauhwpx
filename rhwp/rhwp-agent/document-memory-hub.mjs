/**
 * 문서 기억의 허브 연결 — 기억 키 고르기, 턴에 싣는 <document_memory> 블록, Studio 시트 요청, MCP 도구.
 *
 * 저장은 document-memory-store.mjs 가 맡는다. 여기서는 허브 기록(record)·공급자 세션(session)에
 * 묶인 상태만 다룬다:
 * - record.documentSources: documentId → Studio 가 알린 원본 digest·파일 이름 (파일에서 연 문서만. 처음 보는 id 에
 *   같은 파일의 기억을 복사해 준다).
 * - session.documentMemory: 이 공급자 세션이 받은 기억. 블록은 세션·리비전·빠진 앵커가 바뀔 때만 싣고,
 *   성공한 턴이 끝나야 받은 것으로 친다. 압축·재개 실패 뒤에는 다시 싣는다.
 * - 글에 매인 항목은 Studio 가 그 문서·그 리비전에서 인용을 확인했다고 알린 뒤에만 싣는다. 확인하지 못한
 *   (문서를 막 바꾼 뒤의 첫 메시지 등) 항목은 문서에서 사라졌을 수 있어 빼 둔다.
 */
import { documentMemoryPromptBlock } from './document-memory-store.mjs';
import { normalizeStableScopeId } from './reference-session.mjs';

const MEMORY_ID_PATTERN = /^mem_[a-z0-9]{12}$/;
const MAX_DOCUMENT_SOURCES = 64;

/** 새 공급자 세션의 문서 기억 상태. delivered 는 성공한 턴이 실어 간 것, pending 은 지금 턴이 싣는 것. */
export function newSessionDocumentMemory() {
  return { documentId: null, key: null, delivered: null, pending: null, anchorReport: null, anchorCheck: null };
}

/**
 * 이 기억의 앵커 상태. Studio 가 알린 확인(anchorReport)이 지금 리비전의 것이면 항목별 인용으로 굳혀 둔다
 * (anchorCheck) — 뒤에 다른 항목이 바뀌어 리비전이 올라도, 인용이 그대로인 항목은 확인된 것으로 친다.
 * @returns {{ missing: Set<string>, unchecked: Set<string> }}
 */
function anchorStatus(state, documentId, memory) {
  const report = state.anchorReport;
  if (report && report.documentId === documentId && report.revision === memory.revision) {
    const quotes = new Map(memory.entries.filter((entry) => entry.anchor).map((entry) => [entry.id, entry.anchor.quote]));
    state.anchorCheck = { documentId, quotes, missing: new Set(report.missing.filter((id) => quotes.has(id))) };
    state.anchorReport = null;
  }
  const check = state.anchorCheck?.documentId === documentId ? state.anchorCheck : null;
  const missing = new Set();
  const unchecked = new Set();
  for (const entry of memory.entries) {
    if (!entry.anchor) continue;
    if (!check || check.quotes.get(entry.id) !== entry.anchor.quote) unchecked.add(entry.id);
    else if (check.missing.has(entry.id)) missing.add(entry.id);
  }
  return { missing, unchecked };
}

function memoryError(code, message) {
  return Object.assign(new Error(message), { code });
}

/**
 * @param {{
 *   store: import('./document-memory-store.mjs').DocumentMemoryStore,
 *   log?: (message: string) => void,
 *   broadcast?: (frame: object) => void,
 *   onWrite?: (write: { documentId: string, key: string, threadId?: string, turnId?: string, changes: object[] }) => void,
 * }} deps broadcast 는 모든 Studio 창에 프레임을 보낸다. onWrite 는 에이전트 도구의 쓰기를 알린다 (턴의 배움 표시에 모은다).
 */
export function createDocumentMemoryHub({ store, log = () => {}, broadcast = () => {}, onWrite = () => {} }) {
  /** Studio 가 알린 문서 원본의 digest·파일 이름을 기억해 둔다. */
  function noteSource(record, documentId, { digest, fileName } = {}) {
    if (typeof documentId !== 'string' || !documentId) return;
    const known = record.documentSources.get(documentId) ?? {};
    const next = {
      digest: typeof digest === 'string' && digest.length <= 200 ? digest : known.digest,
      fileName: typeof fileName === 'string' && fileName.length <= 500 ? fileName : known.fileName,
    };
    if (!next.digest && !next.fileName) return;
    record.documentSources.delete(documentId);
    record.documentSources.set(documentId, next);
    while (record.documentSources.size > MAX_DOCUMENT_SOURCES) {
      record.documentSources.delete(record.documentSources.keys().next().value);
    }
  }

  /** 문서의 기억 키 — 버전 저장소가 있으면 그 저장소, 없으면 documentId (digest 로 다시 묶을 수 있다). */
  function keyFor(record, documentId, { repositoryId } = {}) {
    const binding = record.projectRepository;
    const source = record.documentSources.get(documentId);
    return store.resolveKey({
      documentId,
      repositoryId: repositoryId ?? (binding?.documentId === documentId ? binding.repository.id : undefined),
      digest: source?.digest,
      fileName: source?.fileName,
    });
  }

  /** 세션 문서의 기억을 읽어 둔다 — 허브가 여는 턴은 이 사본을 동기로 싣는다. 실패해도 턴은 막지 않는다. */
  async function prepare(record, session) {
    const state = session?.documentMemory;
    if (!state) return;
    const documentId = session.documentId ?? null;
    if (!documentId) {
      state.documentId = null;
      state.key = null;
      return;
    }
    try {
      const key = await keyFor(record, documentId);
      await store.read(key);
      if (session.documentId === documentId) {
        state.documentId = documentId;
        state.key = key;
      }
    } catch (error) {
      log(`document memory unavailable: ${error?.message ?? error}`);
    }
  }

  /**
   * 이번 턴에 실을 블록. 이 공급자 세션이 같은 기억(리비전·빠진 앵커)을 이미 받았으면 ''.
   * force 는 새 공급자 세션이 받을 글(재개 실패 대체·세션 교체)이다.
   */
  function takeBlock(session, { force = false } = {}) {
    const state = session?.documentMemory;
    const documentId = session?.documentId ?? null;
    if (!state || !documentId || state.documentId !== documentId || !state.key) return '';
    const memory = store.peek(state.key);
    if (!memory) return '';
    const { missing, unchecked } = anchorStatus(state, documentId, memory);
    const excludeIds = [...missing].sort();
    const skipIds = [...unchecked].sort();
    const signature = `${state.key}#${memory.revision}#${excludeIds.join(',')}#${skipIds.join(',')}`;
    const sent = memory.entries.length - excludeIds.length - skipIds.length;
    state.pending = { signature, notes: sent > 0 };
    if (!force && state.delivered?.signature === signature) return '';
    const block = documentMemoryPromptBlock(
      { ...memory, entries: memory.entries.filter((entry) => !unchecked.has(entry.id)) },
      { excludeIds, emptied: !force && state.delivered?.notes === true },
    );
    if (block) {
      log(`document memory r${memory.revision} sent to ${session.agent} (${sent} notes, ${excludeIds.length} anchors missing, ${skipIds.length} unchecked)`);
    }
    return block;
  }

  /** 턴이 끝났다 — 성공한 턴이 실어 간 기억만 받은 것으로 친다. */
  function settleDelivery(session, succeeded) {
    const state = session?.documentMemory;
    if (!state) return;
    if (succeeded && state.pending) state.delivered = state.pending;
    state.pending = null;
  }

  /** 압축·재개 실패로 공급자가 앞서 받은 기억을 잃었을 수 있다 — 다음 턴에 다시 싣는다. */
  function forgetDelivery(session) {
    const state = session?.documentMemory;
    if (!state) return;
    state.delivered = null;
    state.pending = null;
  }

  /**
   * 사용자 메시지에 실린 앵커 확인 — Studio 가 documentId 문서에서 기억 리비전 revision 의 인용을 찾았고
   * missing 은 사라진 항목이다. 허브가 여는 다음 턴들도 이 확인을 쓴다. 확인이 없는 메시지(Studio 가 아직
   * 그 문서의 기억을 읽지 못했다)는 앞선 확인도 지운다 — 그 사이 문서가 바뀌었을 수 있다.
   */
  function noteMissingAnchors(session, value, { documentId, revision } = {}) {
    const state = session?.documentMemory;
    if (!state) return;
    state.anchorCheck = null;
    state.anchorReport = typeof documentId === 'string' && documentId && Number.isSafeInteger(revision) && revision >= 0
      ? {
        documentId,
        revision,
        missing: Array.isArray(value)
          ? [...new Set(value.filter((id) => typeof id === 'string' && MEMORY_ID_PATTERN.test(id)))].slice(0, 40)
          : [],
      }
      : null;
  }

  function changed(documentId, key, revision) {
    broadcast({ v: 1, type: 'document-memory-changed', documentId, key, revision });
  }

  /** Studio 의 문서 기억 시트 요청(list · apply · revert). 답 프레임의 몸통을 돌려준다. */
  async function studioRequest(record, msg) {
    try {
      const documentId = normalizeStableScopeId(msg.documentId, 'documentId');
      noteSource(record, documentId, { digest: msg.documentDigest, fileName: msg.documentFileName });
      const repositoryId = typeof msg.repositoryId === 'string' && msg.repositoryId ? msg.repositoryId : undefined;
      const key = await keyFor(record, documentId, { repositoryId });
      if (msg.op === 'list') return { ok: true, memory: await store.read(key) };
      if (msg.op === 'apply') {
        // 시트의 쓰기는 사용자가 고친 것이다.
        const result = await store.apply(key, msg.ops, {
          expectedRevision: Number.isSafeInteger(msg.expectedRevision) ? msg.expectedRevision : undefined,
          origin: 'user',
        });
        if (result.changes.length) changed(documentId, key, result.revision);
        return { ok: true, memory: await store.read(key), changes: result.changes };
      }
      if (msg.op === 'revert') {
        const result = await store.revert(key, msg.changes);
        if (result.reverted.length) changed(documentId, key, result.revision);
        return { ok: true, memory: await store.read(key), reverted: result.reverted, skipped: result.skipped };
      }
      throw memoryError('MEMORY_INVALID', 'op must be list, apply or revert');
    } catch (error) {
      return { ok: false, error: { code: error?.code ?? 'DOCUMENT_MEMORY_FAILED', message: String(error?.message ?? error) } };
    }
  }

  /** read_document_memory · update_document_memory. 에이전트의 쓰기는 사용자 요청에 따른 explicit 이다. */
  async function runTool(record, session, tool, args) {
    if (!session?.documentId) {
      throw memoryError('DOCUMENT_REQUIRED', 'No document is linked to this chat; document memory belongs to a document.');
    }
    const { documentId, threadId, turnId } = session;
    const key = await keyFor(record, documentId);
    if (tool === 'read_document_memory') {
      const memory = await store.read(key);
      const missing = session.documentMemory ? anchorStatus(session.documentMemory, documentId, memory).missing : new Set();
      return {
        revision: memory.revision,
        entries: memory.entries.map((entry) => ({
          id: entry.id,
          kind: entry.kind,
          subject: entry.subject,
          text: entry.text,
          ...(entry.anchor ? { anchor: entry.anchor } : {}),
          ...(missing.has(entry.id) ? { anchorMissing: true } : {}),
        })),
      };
    }
    const result = await store.apply(key, args.ops, {
      expectedRevision: args.expectedRevision,
      origin: 'explicit',
      source: { threadId, ...(turnId ? { turnId } : {}), kind: 'turn' },
    });
    if (result.changes.length) {
      changed(documentId, key, result.revision);
      try {
        onWrite({ documentId, key, threadId, ...(turnId ? { turnId } : {}), changes: result.changes });
      } catch (error) {
        log(`document memory write listener failed: ${error?.message ?? error}`);
      }
    }
    return {
      revision: result.revision,
      changes: result.changes.map((change) => ({
        op: change.op,
        id: change.entryId,
        ...(change.entry ? { subject: change.entry.subject, text: change.entry.text } : {}),
      })),
    };
  }

  return { store, noteSource, keyFor, prepare, takeBlock, settleDelivery, forgetDelivery, noteMissingAnchors, changed, studioRequest, runTool };
}
