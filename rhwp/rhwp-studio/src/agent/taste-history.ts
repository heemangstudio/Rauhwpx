/**
 * 기록에서 배우기(Rau-0.1) — 에이전트가 쓴 글을 사용자가 나중에(다른 세션에서도) 고친 짝을 찾아
 * 허브의 취향 학습기에 보낸다 (taste-history-learn).
 *
 * 출처 기록: 에이전트가 쓴 문단(승인한 검토 편집, 전체 모드의 바로 반영)을 문서마다 IndexedDB 에 남긴다.
 * taste-signals.ts 가 고쳐 쓰기 지켜보기를 시작할 때 같은 문단을 알려 준다(AgentWriteObserver). 대화에서
 * 배우기가 꺼져 있으면 남기지 않고, 꺼지는 것을 보면 모두 지운다. 기록은 90일이 지나면 버린다.
 * 에이전트가 뒤에 같은 문단을 다시 고치면(글 없는 지우기·전체 모드 쓰기 포함) 그 기록의 기준을 고친 뒤 글로
 * 옮긴다 — 에이전트 자신의 고침을 사용자 고침으로 보내지 않는다.
 *
 * 문서를 다시 열면 문단을 다시 찾는다. 같은 글이 칸에 하나뿐이면 그 자리, 여럿이면 앞·뒤 문단이 맞는 하나만.
 * 글이 바뀌었으면 taste-rewrites.ts 의 규칙(앞뒤 문단·문단 수)으로, 세션을 건너 번호가 많이 밀렸으면 앞·뒤
 * 문단이 모두 그대로이고 꽤 닮은 문단이 하나뿐일 때만 받아들인다. 빈 문단은 증거로 치지 않는다 — 이웃이 없으면
 * 문단 수가 그대로인 제자리 고침만 받는다. 못 찾으면
 * 짝 없이 기록을 버린다.
 *
 * 짝을 고르는 규칙은 고쳐 쓰기 신호와 같다 (classifyRewrite: 공백·한 글자는 사소함, 통째로 바꾼 글·
 * 되돌린 글은 짝이 아니다). 같은 문단을 에이전트가 뒤에 다시 쓴 기록이 있으면 앞 기록은 사용자 편집이
 * 아니라 버린다. 허브가 받았다고 답한 짝만 minedText 로 남겨 같은 고침을 다시 보내지 않는다 — 그 뒤 또
 * 고치면 다시 짝이 된다. 같은 문서의 어느 채팅에든 검토를 기다리는 변경이 있으면 돌지 않는다 — 미리보기로
 * 문서에 들어간 에이전트 글을 사용자 고침으로 읽게 된다.
 *
 * 버전 커밋은 짝의 출처로 쓰지 않는다 — 엔진이 문단 고유 id 를 내기 전에는 커밋 사이 문단을 맞출 수 없다.
 *
 * node --test 가 그대로 읽도록 상대 경로 import 와 타입 import 만 쓴다.
 */
import { openIndexedDatabase, requestResult, transactionDone, withDatabase } from '../core/idb-open.ts';
import {
  classifyRewrite,
  locateParagraph,
  normalizeSpace,
  paragraphKey,
  settleAnchor,
  shiftSpans,
  similarity,
  containerKey,
  type LocatedParagraph,
  type ParagraphAnchor,
  type ParagraphContainer,
  type ParagraphReader,
  type ParagraphRef,
  type RewriteHandle,
  type RewriteSource,
  type TrackedParagraph,
} from './taste-rewrites.ts';
import { focusPair, type AgentEditedParagraph, type AgentWriteObserver } from './taste-signals.ts';
import { readTasteLearnItem } from './taste.ts';
import type { ReviewSignal, TasteHistoryResult, TasteLearnItem } from './types.ts';

/** 한 번에 보내는 짝 수 상한 — 허브와 학습기 프롬프트도 같은 수만 받는다. */
export const HISTORY_PAIR_LIMIT = 20;
/** 문서 하나에 남기는 출처 기록 수 — 넘으면 오래된 것부터 버린다. */
export const PROVENANCE_PER_DOCUMENT = 300;
/** 출처 기록을 남기는 문서 수 — 넘으면 가장 오래 쓰지 않은 문서부터 버린다. */
export const PROVENANCE_DOCUMENTS = 50;
/** 출처 기록을 두는 기간 */
export const PROVENANCE_TTL_MS = 90 * 24 * 60 * 60_000;
/** 다른 세션에서 번호가 많이 밀린 문단을 받아들이는 닮음 */
const RELOCATE_SIMILARITY = 0.5;
/** 한 조각에 읽는 문단 수 — 조각 사이에 페이지에 차례를 넘긴다 */
const READ_CHUNK = 400;
/** 한 번 돌 때 읽는 문단 수 상한 — 넘는 칸의 기록은 이번에 건드리지 않는다 */
const READ_BUDGET = 60_000;
/** 읽는 사이 문서가 바뀌면 처음부터 다시 읽는 횟수 */
const READ_ATTEMPTS = 3;

export interface ProvenanceRecord {
  /** 'prv_' + 무작위 */
  id: string;
  documentId: string;
  threadId?: string;
  turnId?: string;
  /** 에이전트가 쓴 때 (ISO) */
  at: string;
  /** 에이전트가 쓴 문단 전체 글 */
  agentText: string;
  /** 에이전트가 바꾸기 전 문단 글 (알 때만) */
  beforeText?: string;
  /** 기준 글(minedText ?? agentText) 안에서 에이전트가 쓴 구간. null = 문단 전체 */
  spans: Array<[number, number]> | null;
  /** 문단 자리(paraIdx 는 힌트)와 앞뒤 문단 — 다시 찾을 때 쓴다 */
  ref: ParagraphRef;
  lastText: string;
  prevText: string | null;
  nextText: string | null;
  count: number;
  /** 기준 글 — 학습에 넘긴 고침, 사소한 고침, 에이전트가 뒤에 다시 고친 글. 다음 짝은 이 글과 견준다 */
  minedText?: string;
  minedAt?: string;
}

export interface ProvenanceDocument {
  documentId: string;
  updatedAt: number;
  records: ProvenanceRecord[];
}

// ── 저장 ──────────────────────────────────────────────────

export interface ProvenanceBackend {
  get(documentId: string): Promise<ProvenanceDocument | null>;
  put(document: ProvenanceDocument): Promise<void>;
  delete(documentId: string): Promise<void>;
  /** 기록이 있는 문서 수 */
  count(): Promise<number>;
  /** 문서마다 마지막으로 쓴 때 (상한을 넘었을 때만 부른다) */
  list(): Promise<Array<{ documentId: string; updatedAt: number }>>;
  clear(): Promise<void>;
}

export function memoryProvenanceBackend(): ProvenanceBackend {
  const rows = new Map<string, ProvenanceDocument>();
  return {
    async get(documentId) {
      const row = rows.get(documentId);
      return row ? structuredClone(row) : null;
    },
    async put(document) {
      rows.set(document.documentId, structuredClone(document));
    },
    async delete(documentId) {
      rows.delete(documentId);
    },
    async count() {
      return rows.size;
    },
    async list() {
      return [...rows.values()].map(({ documentId, updatedAt }) => ({ documentId, updatedAt }));
    },
    async clear() {
      rows.clear();
    },
  };
}

const DB_NAME = 'rhwpTasteProvenance';
const DB_VERSION = 2;
const STORE = 'documents';
/** 문서마다 { documentId, updatedAt } — 상한 정리가 기록 전체를 읽지 않게 따로 둔다 */
const META_STORE = 'meta';

/** IndexedDB 를 못 열면 이 세션 동안 메모리에 둔다. */
export function idbProvenanceBackend(): ProvenanceBackend {
  const fallback = memoryProvenanceBackend();
  const open = () => openIndexedDatabase(DB_NAME, DB_VERSION, (db) => {
    if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'documentId' });
    if (!db.objectStoreNames.contains(META_STORE)) db.createObjectStore(META_STORE, { keyPath: 'documentId' });
  });
  const run = <T>(operation: (db: IDBDatabase) => Promise<T>, otherwise: () => Promise<T>) =>
    withDatabase(open, DB_NAME, operation, otherwise);
  return {
    get: (documentId) => run(
      async (db) => (await requestResult(db.transaction(STORE, 'readonly').objectStore(STORE).get(documentId) as IDBRequest<ProvenanceDocument | undefined>)) ?? null,
      () => fallback.get(documentId),
    ),
    put: (document) => run(async (db) => {
      const tx = db.transaction([STORE, META_STORE], 'readwrite');
      tx.objectStore(STORE).put(document);
      tx.objectStore(META_STORE).put({ documentId: document.documentId, updatedAt: document.updatedAt });
      await transactionDone(tx);
    }, () => fallback.put(document)),
    delete: (documentId) => run(async (db) => {
      const tx = db.transaction([STORE, META_STORE], 'readwrite');
      tx.objectStore(STORE).delete(documentId);
      tx.objectStore(META_STORE).delete(documentId);
      await transactionDone(tx);
    }, () => fallback.delete(documentId)),
    count: () => run(
      (db) => requestResult(db.transaction(META_STORE, 'readonly').objectStore(META_STORE).count()),
      () => fallback.count(),
    ),
    list: () => run(
      (db) => requestResult(db.transaction(META_STORE, 'readonly').objectStore(META_STORE).getAll() as IDBRequest<Array<{ documentId: string; updatedAt: number }>>),
      () => fallback.list(),
    ),
    clear: () => run(async (db) => {
      const tx = db.transaction([STORE, META_STORE], 'readwrite');
      tx.objectStore(STORE).clear();
      tx.objectStore(META_STORE).clear();
      await transactionDone(tx);
    }, () => fallback.clear()),
  };
}

function emptyDocument(documentId: string, now: number): ProvenanceDocument {
  return { documentId, updatedAt: now, records: [] };
}

/** 문서별 출처 기록. 읽고 고치는 일은 창 안에서 하나씩 한다 (같은 문서의 채팅 여럿이 함께 쓴다). */
export class ProvenanceLog {
  private readonly backend: ProvenanceBackend;
  private readonly perDocument: number;
  private readonly documents: number;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(backend: ProvenanceBackend, options: { perDocument?: number; documents?: number; ttlMs?: number; now?: () => number } = {}) {
    this.backend = backend;
    this.perDocument = options.perDocument ?? PROVENANCE_PER_DOCUMENT;
    this.documents = options.documents ?? PROVENANCE_DOCUMENTS;
    this.ttlMs = options.ttlMs ?? PROVENANCE_TTL_MS;
    this.now = options.now ?? Date.now;
  }

  read(documentId: string): Promise<ProvenanceDocument> {
    return this.serial(async () => {
      const document = (await this.backend.get(documentId)) ?? emptyDocument(documentId, this.now());
      this.dropExpired(document);
      return document;
    });
  }

  /**
   * 기록을 고친다. change 가 false 를 돌려주면 (기간이 지난 기록을 버린 것 말고는) 쓰지 않는다. 상한을 넘은
   * 기록은 여기서 버리고, 문서 수가 상한을 넘었을 때만 오래된 문서를 찾아 지운다.
   */
  update<T>(documentId: string, change: (document: ProvenanceDocument) => T | false): Promise<T | false> {
    return this.serial(async () => {
      const stored = await this.backend.get(documentId);
      const document = stored ?? emptyDocument(documentId, this.now());
      const expired = this.dropExpired(document);
      const result = change(document);
      if (result === false && !expired) return false;
      document.records.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
      if (document.records.length > this.perDocument) document.records.splice(0, document.records.length - this.perDocument);
      if (document.records.length === 0) {
        if (stored) await this.backend.delete(documentId);
        return result;
      }
      document.updatedAt = this.now();
      await this.backend.put(document);
      if (await this.backend.count() > this.documents) {
        const rows = await this.backend.list();
        const stale = rows.filter((row) => row.documentId !== documentId).sort((a, b) => a.updatedAt - b.updatedAt);
        for (const row of stale.slice(0, rows.length - this.documents)) await this.backend.delete(row.documentId);
      }
      return result;
    });
  }

  /** 모든 문서의 기록을 지운다 (대화에서 배우기를 껐다). */
  clear(): Promise<void> {
    return this.serial(() => this.backend.clear());
  }

  private dropExpired(document: ProvenanceDocument): boolean {
    const cutoff = this.now() - this.ttlMs;
    const before = document.records.length;
    document.records = document.records.filter((record) => Date.parse(record.at) >= cutoff);
    return document.records.length !== before;
  }

  private serial<T>(run: () => Promise<T>): Promise<T> {
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }
}

function newRecordId(): string {
  const random = globalThis.crypto?.randomUUID?.().replace(/-/g, '') ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  return `prv_${random.slice(0, 16)}`;
}

/** 지켜보기를 시작한 문단 → 출처 기록. */
export function provenanceRecord(documentId: string, paragraph: TrackedParagraph, at: string, id = newRecordId()): ProvenanceRecord {
  return {
    id,
    documentId,
    ...(paragraph.threadId ? { threadId: paragraph.threadId } : {}),
    ...(paragraph.turnId ? { turnId: paragraph.turnId } : {}),
    at,
    agentText: paragraph.agentText,
    ...(paragraph.beforeText !== undefined ? { beforeText: paragraph.beforeText } : {}),
    spans: paragraph.spans,
    ref: paragraph.ref,
    lastText: paragraph.lastText,
    prevText: paragraph.prevText,
    nextText: paragraph.nextText,
    count: paragraph.count,
  };
}

/** 새 기록을 더한다. 에이전트가 고쳐 쓴 문단의 앞 기록(바꾸기 전 글이 그 기록의 글)은 버린다. */
export function addProvenance(document: ProvenanceDocument, records: readonly ProvenanceRecord[]): void {
  for (const record of records) {
    if (record.beforeText !== undefined) {
      const before = record.beforeText;
      const container = containerKey(record.ref);
      document.records = document.records.filter((old) => containerKey(old.ref) !== container
        || (old.lastText !== before && (old.minedText ?? old.agentText) !== before));
    }
    document.records.push(record);
  }
}

const blank = (text: string | null | undefined): boolean => text === null || text === undefined || !text.trim();

/**
 * 에이전트가 고친 문단의 기록을 지금 글로 다시 잡는다. 고치기 전 글이 기록의 글이면 그 기록, 모르면 그 자리로
 * 다시 찾아지는 기록이다. 에이전트가 문단을 비웠으면 기록을 버린다. 바꿨으면 true.
 */
export function rebaseProvenance(
  document: ProvenanceDocument,
  edits: readonly AgentEditedParagraph[],
  reader: ParagraphReader,
): boolean {
  let changed = false;
  for (const edit of edits) {
    const container = containerKey(edit.ref);
    const sameContainer = document.records.filter((record) => containerKey(record.ref) === container);
    let hits = edit.before === undefined
      ? []
      : sameContainer.filter((record) => record.lastText === edit.before || (record.minedText ?? record.agentText) === edit.before);
    if (hits.length === 0) {
      hits = sameContainer.filter((record) => {
        const base = record.minedText ?? record.agentText;
        if (record.lastText === edit.text && base === edit.text) return false;
        const found = locateParagraph(record, reader);
        return found !== null && (found.paraIdx === edit.ref.paraIdx || (found.joined === true && found.paraIdx + 1 === edit.ref.paraIdx));
      });
    }
    for (const record of hits) {
      if (blank(edit.text)) {
        document.records = document.records.filter((item) => item !== record);
        changed = true;
        continue;
      }
      const text = edit.text!;
      const base = record.minedText ?? record.agentText;
      if (base === text && record.lastText === text && record.ref.paraIdx === edit.ref.paraIdx) continue;
      if (record.spans) record.spans = shiftSpans(record.spans, base, text);
      record.minedText = text;
      settleAnchor(record, reader, edit.ref.paraIdx, text);
      changed = true;
    }
  }
  return changed;
}

export interface ProvenanceObserverOptions {
  /** 에이전트가 고친 문단을 지금 글로 읽는다 */
  reader: ParagraphReader;
  /** 대화에서 배우기가 켜져 있다 — 꺼져 있으면 새 기록을 남기지 않는다 */
  recording(): boolean;
  now?(): number;
}

/** 출처 기록을 쓰는 AgentWriteObserver — 브리지가 지금 문서 id 와 함께 만든다. */
export function provenanceObserver(log: ProvenanceLog, documentId: () => string | null, options: ProvenanceObserverOptions): AgentWriteObserver {
  const owners = new WeakMap<RewriteHandle, { documentId: string; id: string }>();
  const now = options.now ?? Date.now;
  return {
    written(paragraphs) {
      const id = documentId();
      if (!id || paragraphs.length === 0 || !options.recording()) return;
      const at = new Date(now()).toISOString();
      const records = paragraphs.map((paragraph) => {
        const record = provenanceRecord(id, paragraph, at);
        owners.set(paragraph.handle, { documentId: id, id: record.id });
        return record;
      });
      void log.update(id, (document) => addProvenance(document, records)).catch(warn);
    },
    edited(paragraphs) {
      const id = documentId();
      if (!id || paragraphs.length === 0) return;
      void log.update(id, (document) => (rebaseProvenance(document, paragraphs, options.reader) ? undefined : false)).catch(warn);
    },
    rewritten(source: RewriteSource) {
      // 고쳐 쓰기 신호가 이 고침을 이미 학습기로 보냈다 — 다음 짝은 지금 글과 견준다.
      const owner = owners.get(source.handle);
      if (!owner) return;
      const at = new Date(now()).toISOString();
      void log.update(owner.documentId, (document) => {
        const record = document.records.find((item) => item.id === owner.id);
        if (!record) return false;
        if (record.spans) record.spans = shiftSpans(record.spans, record.minedText ?? record.agentText, source.userText);
        record.minedText = source.userText;
        record.minedAt = at;
        record.lastText = source.userText;
      }).catch(warn);
    },
    undone(handles) {
      const byDocument = new Map<string, Set<string>>();
      for (const handle of handles) {
        const owner = owners.get(handle);
        if (!owner) continue;
        byDocument.set(owner.documentId, (byDocument.get(owner.documentId) ?? new Set()).add(owner.id));
      }
      for (const [id, ids] of byDocument) {
        void log.update(id, (document) => {
          const before = document.records.length;
          document.records = document.records.filter((record) => !ids.has(record.id));
          return document.records.length !== before ? undefined : false;
        }).catch(warn);
      }
    },
  };
}

function warn(error: unknown): void {
  console.warn('[taste-history] provenance write failed:', error);
}

// ── 짝 찾기 ───────────────────────────────────────────────

/** 보낼 짝과, 허브가 받으면 남길 '이미 보냄' 표시. joined 면 나누거나 합친 문단이라 받은 뒤 기록을 놓는다. */
export interface HistoryPair {
  signal: ReviewSignal;
  mark: { id: string; text: string; joined?: boolean };
}

/** 문단 글을 필요할 때 한 번씩 읽어 두는 읽개 — 같은 글이 칸 어디에 있는지도 찾는다. */
export interface HistoryReader extends ParagraphReader {
  /** 칸에서 이 글인 문단 번호 (칸 전체를 읽는다) */
  indexesOf(container: ParagraphContainer, text: string): number[];
  /**
   * 칸들을 조각으로 미리 읽는다. 조각 사이에 pause 로 차례를 넘기고, stale 이 true 면 멈추고 null.
   * 예산을 넘어 읽지 못한 칸의 키를 돌려준다.
   */
  prefetch(containers: readonly ParagraphContainer[], options: { pause(): Promise<void>; stale(): boolean; budget?: number; chunk?: number }): Promise<Set<string> | null>;
}

export function cachedReader(reader: ParagraphReader): HistoryReader {
  const counts = new Map<string, number>();
  const texts = new Map<string, Map<number, string | null>>();
  const indexes = new Map<string, Map<string, number[]>>();
  const count = (container: ParagraphContainer): number => {
    const key = containerKey(container);
    let value = counts.get(key);
    if (value === undefined) {
      try { value = reader.count(container); } catch { value = 0; }
      counts.set(key, value);
    }
    return value;
  };
  const text = (ref: ParagraphRef): string | null => {
    const key = containerKey(ref);
    let list = texts.get(key);
    if (!list) texts.set(key, list = new Map());
    if (!list.has(ref.paraIdx)) {
      let value: string | null = null;
      if (ref.paraIdx >= 0 && ref.paraIdx < count(ref)) {
        try { value = reader.text(ref); } catch { value = null; }
      }
      list.set(ref.paraIdx, value);
    }
    return list.get(ref.paraIdx) ?? null;
  };
  return {
    count,
    text,
    indexesOf(container, value) {
      const key = containerKey(container);
      let index = indexes.get(key);
      if (!index) {
        index = new Map();
        const total = count(container);
        for (let paraIdx = 0; paraIdx < total; paraIdx++) {
          const own = text({ ...container, paraIdx });
          if (own === null) continue;
          const list = index.get(own);
          if (list) list.push(paraIdx);
          else index.set(own, [paraIdx]);
        }
        indexes.set(key, index);
      }
      return index.get(value) ?? [];
    },
    async prefetch(containers, options) {
      const chunk = options.chunk ?? READ_CHUNK;
      let budget = options.budget ?? READ_BUDGET;
      const skipped = new Set<string>();
      const seen = new Set<string>();
      for (const container of containers) {
        const key = containerKey(container);
        if (seen.has(key)) continue;
        seen.add(key);
        const total = count(container);
        if (total > budget) {
          skipped.add(key);
          continue;
        }
        budget -= total;
        for (let from = 0; from < total; from += chunk) {
          for (let paraIdx = from; paraIdx < Math.min(total, from + chunk); paraIdx++) text({ ...container, paraIdx });
          if (from + chunk < total) {
            await options.pause();
            if (options.stale()) return null;
          }
        }
      }
      return skipped;
    },
  };
}

/** 앞이나 뒤 문단이 기준 그대로인가 — 빈 문단·칸의 처음과 끝은 증거가 아니다. */
function neighbourEvidence(anchor: ParagraphAnchor, reader: HistoryReader, first: number, last = first): boolean {
  const prev = first > 0 ? reader.text({ ...anchor.ref, paraIdx: first - 1 }) : null;
  const next = last + 1 < reader.count(anchor.ref) ? reader.text({ ...anchor.ref, paraIdx: last + 1 }) : null;
  return (!blank(anchor.prevText) && prev === anchor.prevText) || (!blank(anchor.nextText) && next === anchor.nextText);
}

/**
 * 출처 기록의 문단을 지금 문서에서 찾는다. 같은 글은 칸에 하나뿐이거나 앞뒤 문단이 맞는 하나일 때, 바뀐 글은
 * 고쳐 쓰기와 같은 규칙에 빈 문단이 아닌 앞뒤 문단이 맞을 때(이웃이 없으면 문단 수가 그대로인 제자리에서 꽤 닮았을 때), 번호가 많이 밀렸으면 앞·뒤 문단이 모두 그대로이고
 * 닮은 문단이 하나뿐일 때만 받아들인다. 아니면 null (짝 없이 버린다).
 */
export function relocate(anchor: ParagraphAnchor, reader: HistoryReader): LocatedParagraph | null {
  const at = (paraIdx: number): LocatedParagraph => ({ paraIdx, text: reader.text({ ...anchor.ref, paraIdx }) ?? '' });
  const exact = [...new Set([...reader.indexesOf(anchor.ref, anchor.lastText), ...reader.indexesOf(anchor.ref, anchor.agentText)])];
  if (exact.length === 1) return at(exact[0]!);
  if (exact.length > 1) {
    const backed = exact.filter((paraIdx) => neighbourEvidence(anchor, reader, paraIdx));
    return backed.length === 1 ? at(backed[0]!) : null;
  }
  const found = locateParagraph(anchor, reader);
  if (found) {
    if (neighbourEvidence(anchor, reader, found.paraIdx, found.joined ? found.paraIdx + 1 : found.paraIdx)) return found;
    // 이웃이 비었거나 칸의 처음·끝이다 — 문단 수가 그대로인 제자리에서 꽤 닮았을 때만 (한 문단뿐인 문서 등).
    if (!found.joined && found.paraIdx === anchor.ref.paraIdx && reader.count(anchor.ref) === anchor.count
      && Math.max(similarity(found.text, anchor.lastText), similarity(found.text, anchor.agentText)) >= RELOCATE_SIMILARITY) return found;
  }
  if (blank(anchor.prevText) || blank(anchor.nextText)) return null;
  const candidates = reader.indexesOf(anchor.ref, anchor.prevText!)
    .map((prevIdx) => prevIdx + 1)
    .filter((paraIdx) => {
      const text = reader.text({ ...anchor.ref, paraIdx });
      if (blank(text) || reader.text({ ...anchor.ref, paraIdx: paraIdx + 1 }) !== anchor.nextText) return false;
      return Math.max(similarity(text!, anchor.lastText), similarity(text!, anchor.agentText)) >= RELOCATE_SIMILARITY;
    });
  return candidates.length === 1 ? at(candidates[0]!) : null;
}

function historySignal(agentText: string, userText: string, at: string, paraIdx?: number, turnId?: string): ReviewSignal {
  const [after, user] = focusPair(agentText, userText);
  return {
    kind: 'history',
    at,
    after,
    userText: user,
    ...(paraIdx !== undefined ? { paraIdx } : {}),
    ...(turnId ? { turnId } : {}),
  };
}

/**
 * 출처 기록을 지금 문서와 견준다. 기록은 그 자리에서 고친다(다시 잡은 자리, 사소한 고침의 기준 옮기기,
 * 지웠거나 덮인 기록 버리기). 짝이 될 고침은 minedText 를 바꾸지 않고 짝으로만 낸다. skip 에 든 칸의 기록은
 * 이번에 건드리지 않는다.
 * @returns 짝과, 기록을 바꿨는지
 */
export function mineProvenance(
  document: ProvenanceDocument,
  reader: HistoryReader,
  options: { skip?: ReadonlySet<string> } = {},
): { pairs: HistoryPair[]; changed: boolean } {
  const pairs: HistoryPair[] = [];
  let changed = false;
  const claimed = new Set<string>();
  const newerAgentTexts = new Set<string>();
  const keep: ProvenanceRecord[] = [];
  const newestFirst = [...document.records].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  for (const record of newestFirst) {
    if (options.skip?.has(containerKey(record.ref))) {
      keep.push(record);
      continue;
    }
    const found = relocate(record, reader);
    const at = found ? { ...record.ref, paraIdx: found.paraIdx } : null;
    // 지웠다, 또는 같은 문단을 에이전트가 뒤에 다시 썼다 — 사용자 편집이 아니다.
    if (!found || !at || claimed.has(paragraphKey(at)) || newerAgentTexts.has(normalizeSpace(found.text))) {
      changed = true;
      continue;
    }
    claimed.add(paragraphKey(at));
    newerAgentTexts.add(normalizeSpace(record.agentText));
    const base = record.minedText ?? record.agentText;
    const verdict = classifyRewrite(base, found.text, {
      ...(record.minedText === undefined && record.beforeText !== undefined ? { beforeText: record.beforeText } : {}),
      spans: record.spans,
    });
    if (verdict === 'reverted' || verdict === 'replaced') {
      changed = true;
      continue;
    }
    if (verdict === 'rewrite') {
      pairs.push({
        signal: historySignal(record.agentText, found.text, record.at, record.ref.cell ? undefined : found.paraIdx, record.turnId),
        mark: { id: record.id, text: found.text, ...(found.joined ? { joined: true } : {}) },
      });
    }
    if (found.joined) {
      // 나누거나 합친 문단 — 고친 짝은 허브가 받을 때까지 그대로 두고(다시 보낼 수 있게), 아니면 놓는다.
      if (verdict === 'rewrite') keep.push(record);
      else changed = true;
      continue;
    }
    if (verdict !== 'same' && verdict !== 'rewrite') {
      // 사소한 고침·에이전트 글 밖의 고침 — 기준을 지금 글로 옮긴다.
      if (record.spans) record.spans = shiftSpans(record.spans, base, found.text);
      record.minedText = found.text;
      changed = true;
    }
    const moved = record.ref.paraIdx !== found.paraIdx || record.lastText !== found.text;
    const before = [record.prevText, record.nextText, record.count];
    settleAnchor(record, reader, found.paraIdx, found.text);
    if (moved || before[0] !== record.prevText || before[1] !== record.nextText || before[2] !== record.count) changed = true;
    keep.push(record);
  }
  if (changed) document.records = keep;
  return { pairs, changed };
}

/** 짝을 고른다 — 같은 짝은 한 번, 새것부터, 상한까지. */
export function selectPairs(pairs: readonly HistoryPair[]): HistoryPair[] {
  const seen = new Set<string>();
  const out: HistoryPair[] = [];
  const all = [...pairs].sort((a, b) => Date.parse(b.signal.at) - Date.parse(a.signal.at));
  for (const pair of all) {
    const key = `${normalizeSpace(pair.signal.after ?? '')}\u0000${normalizeSpace(pair.signal.userText ?? '')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(pair);
    if (out.length >= HISTORY_PAIR_LIMIT) break;
  }
  return out;
}

/** 허브가 받은 짝에 '이미 보냄'을 남긴다. 나누거나 합친 문단의 기록은 놓는다. */
export function markMined(document: ProvenanceDocument, pairs: readonly HistoryPair[], at: string): void {
  for (const { mark } of pairs) {
    const record = document.records.find((item) => item.id === mark.id);
    if (!record) continue;
    if (mark.joined) {
      document.records = document.records.filter((item) => item !== record);
      continue;
    }
    if (record.spans) record.spans = shiftSpans(record.spans, record.minedText ?? record.agentText, mark.text);
    record.minedText = mark.text;
    record.minedAt = at;
  }
}

/** taste-history-result 프레임. */
export function readTasteHistoryResult(msg: Record<string, unknown>): TasteHistoryResult {
  const error = typeof msg.error === 'object' && msg.error !== null && !Array.isArray(msg.error)
    ? msg.error as Record<string, unknown>
    : null;
  const items = Array.isArray(msg.items)
    ? msg.items.map(readTasteLearnItem).filter((item): item is TasteLearnItem => item !== null)
    : [];
  return {
    ok: msg.ok === true,
    learnId: typeof msg.learnId === 'string' ? msg.learnId : '',
    key: typeof msg.key === 'string' ? msg.key : '',
    items,
    changes: Array.isArray(msg.changes) ? msg.changes : [],
    accepted: Array.isArray(msg.accepted) ? msg.accepted.filter((index): index is number => Number.isSafeInteger(index) && index >= 0) : [],
    ...(error ? { error: { code: typeof error.code === 'string' ? error.code : 'TASTE_HISTORY_FAILED', message: typeof error.message === 'string' ? error.message : '' } } : {}),
  };
}

// ── 돌리기 ────────────────────────────────────────────────

export type TasteHistoryOutcome =
  | { status: 'empty' }
  | { status: 'busy' }
  /** 같은 문서의 어느 채팅에든 검토를 기다리는 변경이 있다 */
  | { status: 'review' }
  | { status: 'failed'; code: string }
  | { status: 'learned'; documentId: string; result: TasteHistoryResult };

/** 같은 문서의 일 — 검토를 기다리는 변경, 에이전트 턴. 없으면 null */
export type HistoryBlocker = 'review' | 'turn' | null;

/** 기록에서 배우기가 함께 싣는 채팅 턴 — 사용자 요청과 그 턴 에이전트의 마지막 답. */
export interface HistoryChatTurn {
  userText: string;
  answer: string;
}

/** 한 번에 싣는 채팅 턴 수 — 허브도 같은 수로 자른다. */
export const MAX_HISTORY_CHATS = 40;

export interface TasteHistoryMinerDeps {
  log: ProvenanceLog;
  reader: ParagraphReader;
  documentId(): string | null;
  /** 짝과 채팅을 허브에 보낸다. 연결이 없으면 null. */
  send(documentId: string, pairs: ReviewSignal[], options: { auto: boolean; chats: HistoryChatTurn[] }): Promise<TasteHistoryResult | null>;
  /** 이 문서의 지난 채팅 턴 (오래된 것부터). 사용자가 누른 실행만 싣는다. */
  chats?(documentId: string): HistoryChatTurn[];
  /** 같은 문서의 모든 채팅을 본다. 검토 대기면 언제나, 턴 중이면 자동 실행만 멈춘다. */
  blocked?(): HistoryBlocker;
  /** 문서가 바뀔 때마다 오르는 값 — 조각으로 읽는 사이 바뀌었으면 다시 읽는다. */
  revision?(): number;
  /** 조각 사이에 차례를 넘긴다 (테스트는 바로 돈다) */
  pause?(): Promise<void>;
  now?(): number;
}

type Collected = { documentId: string; pairs: HistoryPair[] } | { status: 'review' | 'busy' } | null;

export class TasteHistoryMiner {
  private readonly deps: TasteHistoryMinerDeps;
  private running: Promise<TasteHistoryOutcome> | null = null;

  constructor(deps: TasteHistoryMinerDeps) {
    this.deps = deps;
  }

  get busy(): boolean {
    return this.running !== null;
  }

  /** 짝을 찾아 보낸다. 앞선 실행이 돌고 있으면 끝난 뒤에 돈다 (그사이 배운 고침은 다시 보내지 않는다). */
  run(options: { auto: boolean }): Promise<TasteHistoryOutcome> {
    const previous = this.running;
    const running = (async () => {
      if (previous) await previous.catch(() => undefined);
      return this.runOnce(options);
    })();
    this.running = running;
    const clear = () => {
      if (this.running === running) this.running = null;
    };
    running.then(clear, clear);
    return running;
  }

  /** 지금 보낼 짝 (보내지 않는다 — 기록의 자리 다시 잡기는 남긴다). */
  async collect(options: { auto: boolean } = { auto: false }): Promise<Collected> {
    const documentId = this.deps.documentId();
    if (!documentId) return null;
    for (let attempt = 0; attempt < READ_ATTEMPTS; attempt++) {
      const gate = this.gate(options);
      if (gate) return gate;
      const stored = await this.deps.log.read(documentId);
      if (stored.records.length === 0) return { documentId, pairs: [] };
      const reader = cachedReader(this.deps.reader);
      const revision = this.deps.revision?.();
      const stale = () => this.deps.documentId() !== documentId
        || this.gate(options) !== null
        || (revision !== undefined && this.deps.revision?.() !== revision);
      const skipped = await reader.prefetch(stored.records.map((record) => record.ref), {
        pause: this.deps.pause ?? (() => new Promise((resolve) => setTimeout(resolve, 0))),
        stale,
      });
      if (!skipped) continue;
      let pairs: HistoryPair[] = [];
      let aborted = false;
      // 다시 잡은 자리·버린 기록은 바로 남긴다. 짝의 '이미 보냄'은 허브가 받은 뒤에 남긴다.
      await this.deps.log.update(documentId, (document) => {
        if (stale()) {
          aborted = true;
          return false;
        }
        const mined = mineProvenance(document, reader, { skip: skipped });
        pairs = mined.pairs;
        return mined.changed ? undefined : false;
      });
      if (aborted) continue;
      if (this.deps.documentId() !== documentId) return null;
      return { documentId, pairs: selectPairs(pairs) };
    }
    return this.gate(options) ?? { status: 'busy' };
  }

  private gate(options: { auto: boolean }): { status: 'review' | 'busy' } | null {
    const blocker = this.deps.blocked?.() ?? null;
    if (blocker === 'review') return { status: 'review' };
    if (blocker === 'turn' && options.auto) return { status: 'busy' };
    return null;
  }

  private async runOnce(options: { auto: boolean }): Promise<TasteHistoryOutcome> {
    const collected = await this.collect(options);
    if (!collected) return { status: 'empty' };
    if ('status' in collected) return collected;
    const { documentId, pairs } = collected;
    // 문서를 열 때 저절로 도는 실행은 고친 글만 본다 — 열 때마다 지난 대화를 다시 배우지 않게.
    const chats = options.auto ? [] : (this.deps.chats?.(documentId) ?? []).slice(-MAX_HISTORY_CHATS);
    if (pairs.length === 0 && chats.length === 0) return { status: 'empty' };
    const gate = this.gate(options);
    if (gate) return gate;
    const result = await this.deps.send(documentId, pairs.map((pair) => pair.signal), { ...options, chats });
    if (!result) return { status: 'failed', code: 'OFFLINE' };
    if (!result.ok) return { status: 'failed', code: result.error?.code ?? 'TASTE_HISTORY_FAILED' };
    // 허브가 학습기에 넘긴 짝만 남긴다 — 걸러 낸 짝은 다음에 다시 보낸다.
    const accepted = result.accepted.map((index) => pairs[index]).filter((pair): pair is HistoryPair => pair !== undefined);
    const at = new Date(this.deps.now?.() ?? Date.now()).toISOString();
    if (accepted.length > 0) await this.deps.log.update(documentId, (document) => markMined(document, accepted, at));
    return { status: 'learned', documentId, result };
  }
}

// ── 자동 실행 ─────────────────────────────────────────────

type TimerHandle = ReturnType<typeof setTimeout>;

/** 문서를 연 뒤 한 번만 — 창 안의 모든 채팅이 함께 본다. */
const autoClaimed = new Set<string>();

export interface AutoHistoryDeps {
  /** 지금 문서의 이번 열기를 가리키는 키 (documentId + 문서 인스턴스). 문서가 없으면 null */
  openKey(): string | null;
  /** 허브에 연결되어 문서를 다 읽었다 */
  ready(): boolean;
  /** 같은 문서의 어느 채팅에서든 에이전트 턴이 돌거나 검토를 기다리는 변경이 있다 */
  blocked(): boolean;
  /** 대화에서 배우기 (Rau-0.1) 켜짐 */
  enabled(): Promise<boolean>;
  run(): Promise<TasteHistoryOutcome['status'] | void>;
  /** 페이지가 한가할 때 run 을 부른다. 취소 함수를 돌려준다 */
  whenIdle?(run: () => void): () => void;
  setTimer?(run: () => void, ms: number): TimerHandle;
  clearTimer?(handle: TimerHandle): void;
  /** 문서를 열고 기다리는 시간 */
  settleMs?: number;
  /** 열기 키를 함께 보는 집합 (테스트는 따로 둔다) */
  claimed?: Set<string>;
}

function defaultWhenIdle(run: () => void): () => void {
  const idle = (globalThis as { requestIdleCallback?: (cb: () => void, options?: { timeout: number }) => number }).requestIdleCallback;
  if (typeof idle === 'function') {
    const handle = idle(run, { timeout: 10_000 });
    return () => (globalThis as { cancelIdleCallback?: (handle: number) => void }).cancelIdleCallback?.(handle);
  }
  const timer = setTimeout(run, 0);
  return () => clearTimeout(timer);
}

/**
 * 문서를 연 뒤 한 번, 문서가 자리를 잡고 페이지가 한가할 때 기록에서 배운다. 같은 문서의 에이전트 턴·검토
 * 대기 중에는 미루고 턴이 끝나거나 검토가 끝나면 다시 본다. 도는 사이 턴이 시작돼 보내지 못했으면 다시 걸어
 * 둔다. 대화에서 배우기가 꺼져 있으면 이번 열기에는 더 보지 않는다.
 */
export class AutoHistoryTrigger {
  private readonly deps: AutoHistoryDeps;
  private readonly claimed: Set<string>;
  private timer: TimerHandle | null = null;
  private cancelIdle: (() => void) | null = null;
  /** 기다리는 중인 열기 (타이머·한가함 콜백이 끝나면 null) */
  private waitingKey: string | null = null;
  private disposed = false;

  constructor(deps: AutoHistoryDeps) {
    this.deps = deps;
    this.claimed = deps.claimed ?? autoClaimed;
  }

  /** 문서를 열었거나 연결됐다 — 아직 보지 않은 열기면 잠시 뒤 본다. */
  noteDocument(): void {
    const key = this.deps.openKey();
    if (this.disposed || !key || this.claimed.has(key)) return;
    if (this.waitingKey === key) return;
    this.cancel();
    this.waitingKey = key;
    const set = this.deps.setTimer ?? ((run, ms) => setTimeout(run, ms));
    this.timer = set(() => {
      this.timer = null;
      const cancel = (this.deps.whenIdle ?? defaultWhenIdle)(() => {
        if (this.waitingKey !== key) return;
        this.waitingKey = null;
        this.cancelIdle = null;
        void this.attempt(key);
      });
      // 한가함 콜백이 곧바로 돌았으면 취소할 것이 없다.
      if (this.waitingKey === key) this.cancelIdle = cancel;
    }, this.deps.settleMs ?? 4_000);
  }

  /** 턴이 끝났거나 검토가 끝났다 — 그 때문에 미룬 열기를 다시 본다. */
  noteTurnEnded(): void {
    this.noteDocument();
  }

  dispose(): void {
    this.disposed = true;
    this.cancel();
  }

  private cancel(): void {
    if (this.timer !== null) (this.deps.clearTimer ?? clearTimeout)(this.timer);
    this.timer = null;
    this.cancelIdle?.();
    this.cancelIdle = null;
    this.waitingKey = null;
  }

  private async attempt(key: string): Promise<void> {
    if (this.disposed || this.deps.openKey() !== key || this.claimed.has(key)) return;
    // 연결 전이면 연결 때, 턴·검토 중이면 그것이 끝날 때 다시 부른다.
    if (!this.deps.ready() || this.deps.blocked()) return;
    this.claimed.add(key);
    let enabled = false;
    try {
      enabled = await this.deps.enabled();
    } catch {
      enabled = false;
    }
    if (!enabled || this.disposed || this.deps.openKey() !== key) return;
    const status = this.deps.blocked()
      ? 'busy'
      : await this.deps.run().catch((error) => {
        console.warn('[taste-history] automatic run failed:', error);
        return undefined;
      });
    // 도는 사이 턴이 시작됐거나 검토할 변경이 생겼다 — 그것이 끝나면 다시 본다.
    if (status === 'busy' || status === 'review') this.claimed.delete(key);
  }
}
