// 취향 학습용 검토 신호 버퍼 — Studio 의 chat-review-signal 프레임을 검증해 문서별로 메모리에 쌓는다.
//
// 신호는 사용자가 에이전트의 글을 받아들이고(accepted), 거절하고(rejected), 고쳐 쓰고(rewritten),
// 되돌린(undone) 흔적이다. 학습기(PR 3)가 takeSignals 로 꺼내 가고, onReviewSignals 로 새 신호를
// 듣고 학습을 예약한다. 파일에 남기지 않는다 — 허브가 다시 뜨면 사라진다.
//
// 지금은 documentId 로 묶는다. 문서 기억 키(repositoryId 등)로 옮기는 일은 학습기가 맡는다.

export const REVIEW_SIGNAL_KINDS = Object.freeze(['accepted', 'rejected', 'rewritten', 'undone', 'history']);
export const MAX_SIGNALS_PER_FRAME = 20;
export const MAX_SIGNAL_TEXT = 600;
export const MAX_SIGNALS_PER_DOCUMENT = 100;
const MAX_DOCUMENTS = 200;
const MAX_ID_LENGTH = 200;
const MAX_AT_LENGTH = 40;

const KIND_SET = new Set(REVIEW_SIGNAL_KINDS);

function normalizeId(value) {
  if (typeof value !== 'string') return null;
  const id = value.trim();
  return id && id.length <= MAX_ID_LENGTH ? id : null;
}

/** 코드 포인트 단위로 자른다. 문자열이 아니거나 비었으면 undefined. */
function normalizeText(value) {
  if (typeof value !== 'string' || !value) return undefined;
  const chars = [...value];
  return chars.length <= MAX_SIGNAL_TEXT ? value : chars.slice(0, MAX_SIGNAL_TEXT).join('');
}

/** 신호 하나를 검증한다. 모르는 종류·잘못된 형식은 null (버린다). */
export function normalizeReviewSignal(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (!KIND_SET.has(raw.kind)) return null;
  if (typeof raw.at !== 'string' || raw.at.length > MAX_AT_LENGTH || !Number.isFinite(Date.parse(raw.at))) return null;
  for (const field of ['before', 'after', 'userText']) {
    if (raw[field] !== undefined && typeof raw[field] !== 'string') return null;
  }
  if (raw.paraIdx !== undefined && !(Number.isSafeInteger(raw.paraIdx) && raw.paraIdx >= 0)) return null;
  if (raw.turnId !== undefined && normalizeId(raw.turnId) === null) return null;
  const signal = { kind: raw.kind, at: new Date(Date.parse(raw.at)).toISOString() };
  const before = normalizeText(raw.before);
  const after = normalizeText(raw.after);
  const userText = normalizeText(raw.userText);
  if (before !== undefined) signal.before = before;
  if (after !== undefined) signal.after = after;
  if (userText !== undefined) signal.userText = userText;
  if (raw.paraIdx !== undefined) signal.paraIdx = raw.paraIdx;
  if (raw.turnId !== undefined) signal.turnId = normalizeId(raw.turnId);
  // 종류마다 학습에 쓸 글이 있어야 한다. 되돌림은 글 없이도 그 사실이 신호다.
  if ((signal.kind === 'accepted' || signal.kind === 'rejected') && !signal.before && !signal.after) return null;
  if ((signal.kind === 'rewritten' || signal.kind === 'history') && (!signal.after || !signal.userText)) return null;
  return signal;
}

/**
 * chat-review-signal 프레임을 검증한다. 틀이 틀렸으면(아이디·배열·상한) null, 신호는 하나씩 걸러
 * 남은 것이 없어도 프레임은 돌려준다.
 */
export function normalizeReviewSignalFrame(msg) {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return null;
  const threadId = normalizeId(msg.threadId);
  const documentId = normalizeId(msg.documentId);
  if (!threadId || !documentId) return null;
  if (msg.turnId !== undefined && msg.turnId !== null && normalizeId(msg.turnId) === null) return null;
  if (!Array.isArray(msg.signals) || msg.signals.length === 0 || msg.signals.length > MAX_SIGNALS_PER_FRAME) return null;
  const turnId = normalizeId(msg.turnId);
  const signals = msg.signals.map(normalizeReviewSignal).filter(Boolean)
    .map((signal) => (signal.turnId || !turnId ? signal : { ...signal, turnId }));
  return { threadId, documentId, ...(turnId ? { turnId } : {}), signals };
}

/**
 * 문서별 신호 버퍼. 문서마다 최근 perDocument 개만 남기고(오래된 것부터 버린다), 문서 수도
 * maxDocuments 로 묶는다(가장 오래 신호가 없던 문서부터 버린다).
 */
export function createTasteSignalBuffer({ perDocument = MAX_SIGNALS_PER_DOCUMENT, maxDocuments = MAX_DOCUMENTS } = {}) {
  /** documentId → [{ ...signal, threadId }] (Map 순서 = 최근에 신호가 온 순서) */
  const buffers = new Map();
  const listeners = new Set();

  function ingest(msg) {
    const frame = normalizeReviewSignalFrame(msg);
    if (!frame) return { ok: false, documentId: null, accepted: 0, dropped: 0 };
    const dropped = msg.signals.length - frame.signals.length;
    if (frame.signals.length === 0) return { ok: true, documentId: frame.documentId, accepted: 0, dropped };
    const buffer = buffers.get(frame.documentId) ?? [];
    buffers.delete(frame.documentId);
    buffer.push(...frame.signals.map((signal) => ({ ...signal, threadId: frame.threadId })));
    if (buffer.length > perDocument) buffer.splice(0, buffer.length - perDocument);
    buffers.set(frame.documentId, buffer);
    while (buffers.size > maxDocuments) buffers.delete(buffers.keys().next().value);
    const info = {
      threadId: frame.threadId,
      ...(frame.turnId ? { turnId: frame.turnId } : {}),
      count: frame.signals.length,
      kinds: [...new Set(frame.signals.map((signal) => signal.kind))],
      buffered: buffer.length,
    };
    for (const listener of [...listeners]) {
      try {
        listener(frame.documentId, info);
      } catch {
        // 듣는 쪽의 오류가 Studio 프레임 처리를 막지 않는다.
      }
    }
    return { ok: true, documentId: frame.documentId, accepted: frame.signals.length, dropped };
  }

  return {
    ingest,
    /** 쌓인 신호를 꺼내고 비운다 (오래된 것부터). */
    takeSignals(documentId) {
      const buffer = buffers.get(documentId);
      buffers.delete(documentId);
      return buffer ? buffer.map((signal) => ({ ...signal })) : [];
    },
    /** 쌓인 신호를 비우지 않고 본다. */
    peekSignals(documentId) {
      return (buffers.get(documentId) ?? []).map((signal) => ({ ...signal }));
    },
    /** 새 신호가 쌓일 때마다 listener(documentId, info) 를 부른다. 해지 함수를 돌려준다. */
    onReviewSignals(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** 문서 하나(또는 전부)의 신호를 버린다. */
    clear(documentId) {
      if (documentId === undefined) buffers.clear();
      else buffers.delete(documentId);
    },
  };
}
