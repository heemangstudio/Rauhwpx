/**
 * 기억(계정 단계)의 허브 연결 — 쓸 수 있음(Rau 요금제), 턴에 싣는 <user_memory> 블록, Studio 요청, 도구 결과.
 *
 * 저장은 user-memory-store.mjs 가 맡는다. 허브는 요금제를 모른다 — 호스팅 Rau 의 자격 답(rau-hosted.mjs
 * eligibility)만 본다. Rau 요금제·체험(active, 크레딧을 다 쓴 exhausted 포함)일 때만 기억을 싣고 도구에 돌려준다.
 * Hama·무료(not_eligible)나 데스크톱이 없을 때(unavailable)는 아무것도 싣지 않는다.
 *
 * session.userMemory: 이 공급자 세션이 받은 기억. 문서 기억(document-memory-hub.mjs)처럼 리비전·쓸 수 있음이 바뀔 때만
 * 싣고, 성공한 턴이 끝나야 받은 것으로 친다. 세션 교체·압축·재개 실패 뒤에는 다시 싣는다. 실었던 규칙이 사라지면
 * (모두 지웠거나 쓸 수 없게 됐으면) 비었다고 한 번 알린다.
 */
import { userMemoryPromptBlock } from './user-memory-store.mjs';

/** 새 공급자 세션의 기억 상태. delivered 는 성공한 턴이 실어 간 것, pending 은 지금 턴이 싣는 것. */
export function newSessionUserMemory() {
  return { delivered: null, pending: null };
}

/** 기억을 싣고 돌려주는 쓸 수 있음 — 크레딧을 다 써도 기억은 그대로 쓴다(배우기만 멈춘다). */
export function memoryEligible(availability) {
  return availability === 'active' || availability === 'exhausted';
}

function hubError(code, message) {
  return Object.assign(new Error(message), { code });
}

/**
 * 규칙으로 접혔던 문서 메모({key, entry})를 문서 기억에 되살린다. 그 사이 같은 주제가 다시 생겼으면 건너뛴다.
 * changed(documentId, key, revision) 로 그 문서를 연 창에 알린다.
 * @returns {Promise<string[]>} 되살린 항목 id
 */
export async function restoreFoldedEntries(documentStore, folded, { changed = () => {}, log = () => {} } = {}) {
  const byKey = new Map();
  for (const item of Array.isArray(folded) ? folded : []) {
    if (typeof item?.key !== 'string' || !item.entry || typeof item.entry.id !== 'string') continue;
    byKey.set(item.key, [...(byKey.get(item.key) ?? []), item.entry]);
  }
  const restored = [];
  for (const [key, entries] of byKey) {
    try {
      const result = await documentStore.revert(key, entries.map((entry) => ({ op: 'remove', entryId: entry.id, prev: entry })));
      restored.push(...result.reverted);
      if (result.reverted.length > 0) {
        const info = await documentStore.describe(key);
        for (const documentId of info.documentIds) changed(documentId, key, result.revision);
      }
    } catch (error) {
      log(`user memory: folded notes in ${key} were not restored: ${error?.code ?? error?.message ?? error}`);
    }
  }
  return restored;
}

/**
 * @param {{
 *   store: import('./user-memory-store.mjs').UserMemoryStore,
 *   hosted?: { cachedEligibility?: () => string, eligibility?: (options?: object) => Promise<string>, onEligibilityChange?: (callback: () => void) => unknown },
 *   documentStore?: import('./document-memory-store.mjs').DocumentMemoryStore,
 *   legacy?: () => Promise<{ files: number } | null> | { files: number } | null,
 *   changed?: (documentId: string, key: string, revision: number) => void,
 *   broadcast?: (frame: object) => void,
 *   log?: (message: string) => void,
 * }} deps broadcast 는 모든 Studio 창에 보낸다. changed 는 되살린 문서 메모를 알린다.
 */
export function createUserMemoryHub({
  store,
  hosted = null,
  documentStore = null,
  legacy = () => null,
  changed = () => {},
  broadcast = () => {},
  log = () => {},
}) {
  function availability() {
    try { return hosted?.cachedEligibility?.() ?? 'unavailable'; } catch { return 'unavailable'; }
  }

  /** 턴을 열기 전에 — 자격을 (길어야 잠깐) 확인하고 기억을 읽어 둔다. 실패해도 턴은 막지 않는다. */
  async function prepare() {
    await Promise.all([
      Promise.resolve(hosted?.eligibility?.()).catch(() => {}),
      store.read().catch((error) => log(`user memory unavailable: ${error?.message ?? error}`)),
    ]);
  }

  /**
   * 이번 턴에 실을 블록. 이 공급자 세션이 같은 기억(리비전·쓸 수 있음)을 이미 받았으면 ''.
   * force 는 새 공급자 세션이 받을 글(재개 실패 대체·세션 교체)이다.
   */
  function takeBlock(session, { force = false } = {}) {
    if (!session) return '';
    const state = session.userMemory ?? (session.userMemory = newSessionUserMemory());
    const memory = store.peek();
    if (!memory) return '';
    const eligible = memoryEligible(availability());
    const rules = eligible ? memory.rules : [];
    const signature = eligible ? `r${memory.revision}` : 'off';
    state.pending = { signature, rules: rules.length > 0 };
    if (!force && state.delivered?.signature === signature) return '';
    const block = userMemoryPromptBlock(
      { revision: memory.revision, rules },
      { emptied: !force && state.delivered?.rules === true },
    );
    if (block) log(`user memory r${memory.revision} sent to ${session.agent} (${rules.length} rules${eligible ? '' : ', not eligible'})`);
    return block;
  }

  /** 턴이 끝났다 — 성공한 턴이 실어 간 기억만 받은 것으로 친다. */
  function settleDelivery(session, succeeded) {
    const state = session?.userMemory;
    if (!state) return;
    if (succeeded && state.pending) state.delivered = state.pending;
    state.pending = null;
  }

  /** 압축·재개 실패로 공급자가 앞서 받은 기억을 잃었을 수 있다 — 다음 턴에 다시 싣는다. */
  function forgetDelivery(session) {
    const state = session?.userMemory;
    if (!state) return;
    state.delivered = null;
    state.pending = null;
  }

  /** 문체 규칙이 있고 쓸 수 있으면 참 — 한글 다듬기 트리거가 개인 문체를 함께 가리킨다. */
  function personalProfile() {
    if (!memoryEligible(availability())) return false;
    return (store.peek()?.rules ?? []).some((rule) => rule.kind === 'style');
  }

  /** Studio 에 보내는 모양 (UserMemorySnapshot). */
  async function snapshot() {
    const [base, legacyState] = await Promise.all([
      store.snapshot(),
      Promise.resolve().then(() => legacy()).catch(() => null),
    ]);
    const now = availability();
    return {
      ...base,
      available: memoryEligible(now),
      availability: now,
      legacy: legacyState && Number.isSafeInteger(legacyState.files) && legacyState.files > 0 ? { files: legacyState.files } : null,
    };
  }

  /** 모든 창에 지금 기억을 알린다. */
  async function publish() {
    try {
      broadcast({ v: 1, type: 'user-memory', memory: await snapshot() });
    } catch (error) {
      log(`user memory broadcast failed: ${error?.message ?? error}`);
    }
  }

  hosted?.onEligibilityChange?.(() => { void publish(); });

  /** Studio 의 Rau 탭 요청. 답 프레임의 몸통을 돌려준다. 바뀌었으면 모든 창에 알린다. */
  async function studioRequest(msg) {
    try {
      const op = msg?.op;
      if (op === 'list') return { ok: true, memory: await snapshot() };
      if (op === 'add') {
        await store.addUserRule({ kind: msg.rule?.kind, text: msg.rule?.text });
      } else if (op === 'edit') {
        await store.editRule(msg.id, { text: msg.text, ...(msg.kind !== undefined ? { kind: msg.kind } : {}) });
      } else if (op === 'delete') {
        await store.deleteRule(msg.id);
      } else if (op === 'restore') {
        await store.restore(msg.id);
      } else if (op === 'undo') {
        const result = await store.undo(msg.eventId);
        if (!result.undone) throw hubError('USER_MEMORY_UNDO_STALE', 'That change can no longer be undone.');
        if (documentStore && result.folded.length > 0) await restoreFoldedEntries(documentStore, result.folded, { changed, log });
      } else {
        throw hubError('USER_MEMORY_INVALID', 'op must be list, add, edit, delete, restore or undo');
      }
      const memory = await snapshot();
      broadcast({ v: 1, type: 'user-memory', memory });
      return { ok: true, memory };
    } catch (error) {
      return { ok: false, error: { code: error?.code ?? 'USER_MEMORY_FAILED', message: String(error?.message ?? error) } };
    }
  }

  /** read_document_memory 의 account 칸. 쓸 수 없으면 null — Hama·무료에는 규칙을 돌려주지 않는다. */
  async function toolAccount() {
    if (!memoryEligible(availability())) return null;
    const state = await store.snapshot();
    return {
      revision: state.revision,
      rules: state.rules.map(({ id, kind, subject, text, strength }) => ({ id, kind, subject, text, strength })),
    };
  }

  return {
    store,
    availability,
    prepare,
    takeBlock,
    settleDelivery,
    forgetDelivery,
    personalProfile,
    snapshot,
    publish,
    studioRequest,
    toolAccount,
  };
}
