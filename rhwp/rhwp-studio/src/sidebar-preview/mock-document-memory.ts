/**
 * 미리보기의 문서 기억 — 허브 document-memory-store 를 흉내 내는 메모리 저장소.
 *
 * 문서마다 revision·항목을 들고, 허브처럼 상한(40개·8 000자), 주제 충돌(같은 주제의 add 는 고침),
 * expectedRevision 충돌을 지킨다. 쓰면 붙은 모든 모의 브리지에 document-memory-changed 를 보낸다.
 * `?memory=sample` 은 사업 제안서에 표본 네 개를, `?memory=empty` 는 빈 기억을 둔다.
 * 기록에서 배우기는 문서마다 처음 한 번 Rau-0.1 항목 하나를 배우고, 그다음부터는 배울 기록이 없다고 답한다.
 */
import type { SidebarBridge } from '../agent/bridge.ts';
import type * as T from '../agent/types.ts';

const MAX_ENTRIES = 40;
const MAX_CHARS = 8_000;
const MAX_TEXT = 300;
const KINDS: readonly T.DocumentMemoryKind[] = ['decision', 'term', 'protect', 'style', 'fact'];
const KIND_SUBJECT: Record<T.DocumentMemoryKind, string> = {
  decision: '결정', term: '용어', protect: '보호', style: '문체', fact: '사실',
};
/** 표본의 보호 항목 — 문서에서 사라진 인용으로 보고한다. */
const MISSING_QUOTE = '본 사업은 3년 차까지 자립한다';

interface Store {
  key: string;
  revision: number;
  entries: T.DocumentMemoryEntry[];
}

const stores = new Map<string, Store>();
/** 기록에서 이미 배운 문서 */
const historyLearned = new Set<string>();
const sinks = new Set<(event: T.SidebarEvent) => void>();
let sequence = 0;

function newId(): string {
  sequence += 1;
  return `mem_${(Date.now().toString(36) + sequence.toString(36)).slice(-12).padStart(12, '0')}`;
}

function sampleEntries(): T.DocumentMemoryEntry[] {
  const at = '2026-10-20T09:00:00.000Z';
  const entry = (
    kind: T.DocumentMemoryKind,
    subject: string,
    text: string,
    extra: Partial<T.DocumentMemoryEntry> = {},
  ): T.DocumentMemoryEntry => ({
    id: newId(), kind, subject, text, origin: 'explicit', evidence: 1,
    createdAt: at, updatedAt: at, confirmedAt: at, ...extra,
  });
  return [
    entry('style', '문체.종결', '본문은 한다체 사용', { origin: 'learned', evidence: 3 }),
    entry('term', '용어.고객', "'고객' 대신 '이용자'로 통일"),
    entry('decision', '결정.예산표', '예산표는 분기별로 나눔'),
    entry('protect', '보호.결론', '결론 문단 수정 금지', { anchor: { quote: MISSING_QUOTE, paraIdx: 42 } }),
  ];
}

const params = new URLSearchParams(location.search);
// `taste=sample` 의 모두 보기도 표본 기억을 연다.
const mode = params.get('taste') === 'sample' ? 'sample' : params.get('memory');

function storeFor(documentId: string): Store {
  let store = stores.get(documentId);
  if (!store) {
    const seeded = mode === 'sample' && documentId === 'preview-proposal';
    store = { key: `mem-${documentId}`, revision: seeded ? 4 : 0, entries: seeded ? sampleEntries() : [] };
    stores.set(documentId, store);
  }
  return store;
}

function snapshot(store: Store): T.DocumentMemory {
  return { key: store.key, revision: store.revision, entries: store.entries.map((entry) => ({ ...entry })) };
}

function fail(code: string, message: string): T.DocumentMemoryResult {
  return { ok: false, error: { code, message } };
}

function chars(entries: readonly T.DocumentMemoryEntry[]): number {
  return entries.reduce((sum, entry) => sum + entry.text.length, 0);
}

function changed(documentId: string, store: Store): void {
  const event: T.SidebarEvent = { type: 'document-memory-changed', documentId, key: store.key, revision: store.revision };
  // 허브처럼 응답 뒤에 알린다.
  setTimeout(() => sinks.forEach((sink) => sink(event)), 0);
}

function apply(store: Store, ops: readonly T.DocumentMemoryOp[]): T.DocumentMemoryResult {
  const entries = store.entries.map((entry) => ({ ...entry }));
  const changes: T.DocumentMemoryChange[] = [];
  const now = new Date().toISOString();
  for (const op of ops) {
    if (op.op === 'remove') {
      const index = entries.findIndex((entry) => entry.id === op.id);
      if (index < 0) return fail('MEMORY_ENTRY_NOT_FOUND', op.id);
      const [prev] = entries.splice(index, 1);
      changes.push({ op: 'remove', entryId: op.id, prev });
      continue;
    }
    const text = typeof op.text === 'string' ? op.text.trim() : undefined;
    if (text !== undefined && (!text || text.length > MAX_TEXT)) return fail('MEMORY_INVALID', 'text');
    if (op.op === 'update') {
      const index = entries.findIndex((entry) => entry.id === op.id);
      if (index < 0) return fail('MEMORY_ENTRY_NOT_FOUND', op.id);
      const prev = entries[index]!;
      const next: T.DocumentMemoryEntry = { ...prev, origin: 'user', updatedAt: now };
      if (text !== undefined) next.text = text;
      if (op.kind) next.kind = op.kind;
      if (op.subject) next.subject = op.subject;
      if (op.anchor === null) delete next.anchor;
      else if (op.anchor) next.anchor = op.anchor;
      entries[index] = next;
      changes.push({ op: 'update', entryId: next.id, entry: next, prev });
      continue;
    }
    if (!KINDS.includes(op.kind) || !text) return fail('MEMORY_INVALID', 'add');
    const subject = op.subject?.trim() || `${KIND_SUBJECT[op.kind]}.${text.slice(0, 20)}`;
    const same = entries.findIndex((entry) => entry.subject === subject);
    if (same >= 0) {
      const prev = entries[same]!;
      const next = { ...prev, kind: op.kind, text, origin: 'user' as const, evidence: prev.evidence + 1, updatedAt: now, confirmedAt: now };
      entries[same] = next;
      changes.push({ op: 'update', entryId: next.id, entry: next, prev });
      continue;
    }
    if (entries.length >= MAX_ENTRIES) return fail('MEMORY_FULL', 'entries');
    const entry: T.DocumentMemoryEntry = {
      id: newId(), kind: op.kind, subject, text, origin: 'user', evidence: 1,
      createdAt: now, updatedAt: now, confirmedAt: now,
      ...(op.anchor ? { anchor: op.anchor } : {}),
    };
    entries.push(entry);
    changes.push({ op: 'add', entryId: entry.id, entry });
  }
  if (chars(entries) > MAX_CHARS) return fail('MEMORY_FULL', 'chars');
  store.entries = entries;
  store.revision += 1;
  return { ok: true, memory: snapshot(store), changes };
}

export type MockDocumentMemory = Pick<
  SidebarBridge,
  'listDocumentMemory' | 'applyDocumentMemory' | 'revertDocumentMemory' | 'missingDocumentMemoryAnchors' | 'learnFromHistory'
>;

/** 모의 브리지 하나의 문서 기억 메서드. emit 은 이 브리지의 이벤트 구독자에게 보낸다. */
export function createMockDocumentMemory(
  emit: (event: T.SidebarEvent) => void,
  currentDocumentId: () => string | null,
): MockDocumentMemory {
  sinks.add(emit);
  const resolve = (documentId?: string | null) =>
    (documentId === undefined ? currentDocumentId() ?? 'preview-proposal' : documentId);
  const settle = <V>(value: V) => new Promise<V>((done) => setTimeout(() => done(value), 30));
  return {
    listDocumentMemory: (documentId) => {
      const id = resolve(documentId);
      return settle(id ? { ok: true, memory: snapshot(storeFor(id)) } : null);
    },
    applyDocumentMemory: (ops, options = {}) => {
      const id = resolve(options.documentId);
      if (!id) return settle(null);
      const store = storeFor(id);
      if (options.expectedRevision !== undefined && options.expectedRevision !== store.revision) {
        return settle(fail('MEMORY_REVISION_CONFLICT', `revision ${store.revision}`));
      }
      const result = apply(store, ops);
      if (result.ok) changed(id, store);
      return settle(result);
    },
    revertDocumentMemory: (changes, documentId) => {
      const id = resolve(documentId);
      if (!id) return settle(null);
      const store = storeFor(id);
      const reverted: string[] = [];
      const skipped: string[] = [];
      for (const change of [...changes].reverse()) {
        const index = store.entries.findIndex((entry) => entry.id === change.entryId);
        const current = index >= 0 ? store.entries[index] : undefined;
        if (change.op === 'add' && current && current.updatedAt === change.entry?.updatedAt) {
          store.entries.splice(index, 1);
          reverted.push(change.entryId);
        } else if (change.op === 'update' && current && change.prev && current.updatedAt === change.entry?.updatedAt) {
          store.entries[index] = { ...change.prev };
          reverted.push(change.entryId);
        } else if (change.op === 'remove' && !current && change.prev) {
          store.entries.push({ ...change.prev });
          reverted.push(change.entryId);
        } else skipped.push(change.entryId);
      }
      if (reverted.length) {
        store.revision += 1;
        changed(id, store);
      }
      return settle({ ok: true, memory: snapshot(store), reverted, skipped });
    },
    missingDocumentMemoryAnchors: (entries) =>
      entries.filter((entry) => entry.anchor?.quote === MISSING_QUOTE).map((entry) => entry.id),
    learnFromHistory: async () => {
      const id = currentDocumentId() ?? 'preview-proposal';
      // 학습기가 모델을 부르는 동안의 바쁜 표시가 보이게 잠깐 기다린다.
      await new Promise((done) => setTimeout(done, 900));
      if (historyLearned.has(id)) return { status: 'empty' as const };
      historyLearned.add(id);
      const store = storeFor(id);
      const result = apply(store, [{ op: 'add', kind: 'style', subject: '문체.보고', text: '보고 문장은 짧게 끊어 씀' }]);
      if (!result.ok || !result.changes?.length) return { status: 'failed' as const, code: result.error?.code ?? 'MEMORY_INVALID' };
      const change = result.changes[0]!;
      const entry = store.entries.find((item) => item.id === change.entryId);
      if (entry) entry.origin = 'learned';
      changed(id, store);
      const learnId = `learn-history-${sequence}`;
      const items: T.TasteLearnItem[] = [{ op: change.op, entryId: change.entryId, text: entry?.text ?? '', origin: 'learned' }];
      emit({ type: 'taste-history-learned', documentId: id, learnId, key: store.key, items, changes: result.changes });
      return {
        status: 'learned' as const,
        documentId: id,
        result: { ok: true, learnId, key: store.key, items, changes: result.changes, accepted: [0] },
      };
    },
  };
}
