/**
 * 다른 문서 읽기 — 창 하나의 모든 채팅이 함께 쓰는 문서 엔진 묶음.
 *
 * 에이전트가 documentId 로 채팅의 문서가 아닌 문서(닫힌 최근 문서, 활성 서식 틀)를 읽으면 그 문서를
 * 담을 엔진을 여기서 빌린다. 같은 문서를 읽는 두 채팅은 엔진 하나를 같이 쓴다. 엔진은
 * {@link FOREIGN_DOCUMENT_ENGINE_LIMIT}개까지만 두고, 아무도 쥐지 않은 엔진만 오래된 것부터 내린다.
 * 마지막으로 쓴 뒤 {@link FOREIGN_DOCUMENT_IDLE_MS} 동안 쉬면 놓는다.
 *
 * 엔진은 창의 wasm 모듈을 같이 쓰므로 한 문서의 trap 이 열린 문서까지 멈춘다. 앱 밖에서 온 바이트
 * (untrusted)는 공유 엔진에 올리기 전에 따로 띄운 일꾼(document-preflight.worker.ts)이 먼저 읽고
 * 조판해 본다. 그래도 공유 엔진이 멈추면 sessionStorage 표식이 남아, 다시 연 창은 그 문서를 읽지 않는다.
 * 표식은 그 문서의 wasm 호출(동기)이 도는 동안에만 둔다 — PNG 만들기 같은 비동기 작업 중에 창을
 * 새로 고치거나 다른 문서가 멈춰도 이 문서 탓이 되지 않는다.
 */
import type { WasmBridge } from '../core/wasm-bridge.ts';
import { isEngineTrap } from '../core/engine-trap.ts';
import { ByteLimitError, ERROR_RESPONSE_MAX_BYTES, MIB, cancelResponseBody, readResponseBytesWithLimit } from '../core/document-input-limits.ts';
import { documentSourceDigest } from '../recent/document-preflight.ts';
import type { RecentDoc } from '../recent/recent-store.ts';
import type { DocumentPresence } from '../home/home-data.ts';
import type { RememberedNativeDocumentRead } from '../desktop-integration.ts';
import { AgentToolError } from './types.ts';
import type { DocumentPreflightRequest, DocumentPreflightResponse } from './document-preflight.worker.ts';

/** 한 창이 다른 문서용으로 함께 쥐는 엔진 수. wasm 메모리는 줄지 않으므로 높은 물 자국을 묶는다. */
export const FOREIGN_DOCUMENT_ENGINE_LIMIT = 2;
/** 마지막으로 쓴 뒤 이만큼 쉬면 엔진을 놓는다. 다음 읽기가 다시 연다. */
export const FOREIGN_DOCUMENT_IDLE_MS = 60_000;
/** 닫힌 문서를 읽을 때의 크기 상한 — 데스크톱 북마크 읽기와 같다. */
export const FOREIGN_DOCUMENT_MAX_BYTES = 24 * MIB;
/**
 * 일꾼이 준비(wasm 컴파일)를 마친 뒤 문서 하나를 미리 읽는 시간. 넘으면 일꾼을 내리고 이번 읽기만
 * 거절한다 — 바쁜 기계에서 느렸을 뿐일 수 있어 기억하지 않는다.
 */
const PREFLIGHT_TIMEOUT_MS = 15_000;
/** 일꾼이 뜨고 wasm 을 준비하기까지 기다리는 시간. 넘으면 일꾼을 쓸 수 없는 것으로 본다. */
const PREFLIGHT_STARTUP_TIMEOUT_MS = 60_000;
/** 미리 읽기 일꾼이 이만큼 쉬면 내린다 — 자기 wasm 메모리를 돌려준다. */
const PREFLIGHT_WORKER_IDLE_MS = 60_000;
const PREFLIGHT_CACHE_LIMIT = 64;
/** 읽기를 거절한 문서 기록 상한 (sessionStorage 와 메모리). */
const DENIED_LIMIT = 64;
/** 공유 엔진에 문제없이 올라온 digest 기록 상한 */
const LOADED_DIGEST_LIMIT = 64;
const MARKER_PREFIX = 'rhwp.foreignDocument.loading:';
const DENIED_KEY = 'rhwp.foreignDocument.denied';

export type PreflightVerdict =
  | { ok: true }
  | { ok: false; reason: 'trap' | 'unreadable' | 'timeout' | 'unavailable' };

export interface ForeignDocumentBytes {
  bytes: Uint8Array;
  fileName: string;
}

export interface ForeignUseOptions {
  /** 원본 바이트를 엔진과 함께 둔다 — 서식 틀 이식 도구가 원본 그대로를 붙여 넣는다. */
  keepBytes?: boolean;
  /** 앱 밖에서 온 바이트 — 미리 읽기를 거치고, 공유 엔진에서 쓰는 동안 crash 표식을 남긴다. */
  untrusted?: boolean;
  /** 같은 문서의 다른 판을 묶는 이름 — 새 판을 올리면 쉬는 옛 판을 내린다. */
  family?: string;
}

export interface ForeignLease {
  readonly wasm: WasmBridge;
  /** keepBytes 로 연 문서의 원본 바이트. 아니면 null. */
  readonly bytes: Uint8Array | null;
  /** 엔진에 올린 바이트의 digest (blake3:…) */
  readonly digest: string;
}

/** 이 창에 열린 다른 문서 — 그 세션의 엔진을 그대로 읽어 저장하지 않은 편집까지 보인다. */
export interface LiveForeignDocument {
  wasm: WasmBridge;
  name: string;
  dirty: boolean;
  /** 에이전트 편집이 검토를 기다린다 — 읽은 내용에 아직 승인하지 않은 편집이 들어 있다. */
  pendingReview: boolean;
}

/** 닫힌 문서 — stamp 가 같으면 엔진을 다시 쓰고, read 는 엔진이 없을 때만 부른다. */
export interface ForeignDocumentSource {
  stamp: string;
  name: string;
  read: () => Promise<ForeignDocumentBytes>;
}

/** 실행기가 다른 문서를 읽을 때 쓰는 창 단위 접근. 채팅마다 resolveLiveDocument 만 다르다. */
export interface ForeignDocumentAccess {
  pool: ForeignDocumentPool;
  /** 이 창에 열린 문서 (부른 채팅의 문서는 뺀다). 없으면 null. */
  resolveLiveDocument?: (documentId: string) => LiveForeignDocument | null;
  /** 닫힌 문서의 원본. 찾지 못하면 AgentToolError(SOURCE_*) 를 던진다. */
  resolveClosedDocument?: (documentId: string) => Promise<ForeignDocumentSource>;
  /** list_documents 의 재료 — 이 창에 열린 문서(채팅의 문서 포함)와 최근 문서. */
  listDocuments?: () => Promise<KnownDocumentSources>;
  /**
   * 이 채팅 문서의 어느 채팅이든 검토를 기다리는 편집이 있는가 — 다른 창이 이 문서를 읽을 때
   * pendingReview 로 싣는다. 없으면 이 채팅의 대기 편집만 본다.
   */
  ownPendingReview?: () => boolean;
}

type CrashMarkerStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'>;

export interface ForeignDocumentPoolOptions {
  /** 문서 하나를 담을 새 엔진. 기본은 창의 wasm 모듈을 쓰는 WasmBridge. */
  createEngine?: () => Promise<WasmBridge>;
  preflight?: Pick<DocumentPreflight, 'check'>;
  /** 이 창에 이미 문제없이 올라온 바이트인가 (열린 문서의 digest) — 맞으면 미리 읽기를 건너뛴다. */
  isLoadedDigest?: (digest: string) => boolean;
  /** crash 표식 저장소. 기본은 sessionStorage, null 이면 표식을 남기지 않는다. */
  storage?: CrashMarkerStorage | null;
  limit?: number;
  idleMs?: number;
}

interface PoolEntry {
  key: string;
  family: string | null;
  wasm: WasmBridge;
  bytes: Uint8Array | null;
  digest: string;
  uses: number;
  lastUsed: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
}

export function sourceNotFoundError(documentId: string, detail = 'is not open and has no readable file in this app'): AgentToolError {
  return new AgentToolError(
    'SOURCE_NOT_FOUND',
    `Document ${documentId} ${detail}. Use a documentId from an @mention or the document list, or ask the user to open it.`,
  );
}

export function sourceUnreadableError(name: string): AgentToolError {
  return new AgentToolError(
    'SOURCE_UNREADABLE',
    `"${name}" could not be read safely (damaged or unsupported). Do not retry; tell the user it could not be read.`,
  );
}

/** 문서 탓이 아닌 잠깐의 실패(검사 시간 초과, 잠긴 파일, 내려받지 않은 클라우드 파일) — 기억하지 않는다. */
export function sourceTemporarilyUnreadableError(name: string, detail = 'could not be read right now'): AgentToolError {
  return new AgentToolError(
    'SOURCE_UNREADABLE',
    `"${name}" ${detail}. Try again later, or ask the user to open it.`,
  );
}

/** 경로로 고른 파일이 확인과 받기 사이에 바뀌었다 — 다시 읽으면 새 판을 받는다. */
export function sourceChangedError(name: string): AgentToolError {
  return new AgentToolError('SOURCE_UNREADABLE', `"${name}" changed while it was being read; read it again.`);
}

export function sourceTooLargeError(name: string, size: number): AgentToolError {
  return new AgentToolError(
    'SOURCE_TOO_LARGE',
    `"${name}" is ${(size / MIB).toFixed(1)} MiB; documents up to ${FOREIGN_DOCUMENT_MAX_BYTES / MIB} MiB can be read without opening them. Ask the user to open it.`,
  );
}

function defaultStorage(): CrashMarkerStorage | null {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

async function createWindowEngine(): Promise<WasmBridge> {
  const { WasmBridge } = await import('../core/wasm-bridge.ts');
  const wasm = new WasmBridge();
  await wasm.initialize();
  return wasm;
}

export class ForeignDocumentPool {
  private readonly entries = new Map<string, PoolEntry>();
  private readonly loading = new Map<string, Promise<PoolEntry>>();
  /** 엔진을 기다리는 사용 수 — 기다리는 동안에도 그 키의 엔진은 내리지 않는다. */
  private readonly waiting = new Map<string, number>();
  /** 미리 읽기나 공유 엔진 읽기에 실패한 키 — 같은 stamp 면 바이트를 다시 읽지 않고 거절한다. */
  private readonly unreadableKeys = new Map<string, AgentToolError>();
  /** 이 창의 공유 엔진에 문제없이 올라온 digest — 최근 {@link LOADED_DIGEST_LIMIT}개 */
  private readonly loadedDigests = new Set<string>();
  /** untrusted 엔진을 감싼 것 — wasm 호출 동안에만 crash 표식을 둔다. */
  private readonly guardedEngines = new WeakMap<PoolEntry, WasmBridge>();
  private readonly denied: Set<string>;
  private readonly inFlight = new Map<string, number>();
  /** 지금 sessionStorage 에 표식을 둔 digest */
  private readonly marked = new Set<string>();
  private readonly createEngine: () => Promise<WasmBridge>;
  private readonly preflight: Pick<DocumentPreflight, 'check'>;
  private readonly isLoadedDigest: (digest: string) => boolean;
  private readonly storage: CrashMarkerStorage | null;
  private readonly limit: number;
  private readonly idleMs: number;
  private clock = 0;

  constructor(options: ForeignDocumentPoolOptions = {}) {
    this.createEngine = options.createEngine ?? createWindowEngine;
    this.preflight = options.preflight ?? sharedDocumentPreflight();
    this.isLoadedDigest = options.isLoadedDigest ?? (() => false);
    this.storage = options.storage === undefined ? defaultStorage() : options.storage;
    this.limit = Math.max(1, options.limit ?? FOREIGN_DOCUMENT_ENGINE_LIMIT);
    this.idleMs = options.idleMs ?? FOREIGN_DOCUMENT_IDLE_MS;
    this.denied = this.restoreDenied();
  }

  /** 지금 엔진에 올라 있는 키 수 */
  get size(): number {
    return this.entries.size;
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  /** 이 digest 의 문서를 지난 crash 때문에 읽지 않는가 */
  isDenied(digest: string): boolean {
    return this.denied.has(digest);
  }

  /**
   * key 의 엔진을 쥐고 run 을 부른다. 엔진이 없을 때만 load 로 바이트를 받는다 — 키에 stamp 를
   * 넣으면 바뀌지 않은 문서는 바이트를 다시 읽지 않는다. run 이 끝날 때까지 엔진을 내리지 않는다.
   */
  async use<T>(
    key: string,
    load: () => Promise<ForeignDocumentBytes>,
    run: (lease: ForeignLease) => T | Promise<T>,
    options: ForeignUseOptions = {},
  ): Promise<T> {
    const entry = await this.acquire(key, load, options);
    try {
      const wasm = options.untrusted ? this.guardedEngine(entry) : entry.wasm;
      return await run({ wasm, bytes: entry.bytes, digest: entry.digest });
    } finally {
      this.unhold(entry);
    }
  }

  /** 모든 엔진을 놓는다. 쥔 채로 도는 읽기는 끝난 뒤 제 엔진을 놓는다. */
  dispose(): void {
    for (const entry of [...this.entries.values()]) this.evict(entry);
  }

  private async acquire(key: string, load: () => Promise<ForeignDocumentBytes>, options: ForeignUseOptions): Promise<PoolEntry> {
    this.waiting.set(key, (this.waiting.get(key) ?? 0) + 1);
    try {
      let entry = this.entries.get(key);
      if (!entry) {
        const failed = this.unreadableKeys.get(key);
        if (failed) throw failed;
        let pending = this.loading.get(key);
        if (!pending) {
          pending = this.loadEntry(key, load, options).finally(() => this.loading.delete(key));
          this.loading.set(key, pending);
        }
        entry = await pending;
      }
      entry.uses += 1;
      entry.lastUsed = ++this.clock;
      if (entry.idleTimer !== null) clearTimeout(entry.idleTimer);
      entry.idleTimer = null;
      return entry;
    } finally {
      const left = (this.waiting.get(key) ?? 1) - 1;
      if (left > 0) this.waiting.set(key, left);
      else this.waiting.delete(key);
    }
  }

  private async loadEntry(key: string, load: () => Promise<ForeignDocumentBytes>, options: ForeignUseOptions): Promise<PoolEntry> {
    const source = await load();
    const bytes = source.bytes;
    const digest = documentSourceDigest(bytes);
    if (options.untrusted) {
      const refuse = (): never => this.refuseKey(key, sourceUnreadableError(source.fileName));
      if (this.denied.has(digest)) refuse();
      if (!this.loadedDigests.has(digest) && !this.isLoadedDigest(digest)) {
        const verdict = await this.preflight.check(bytes, digest);
        if (!verdict.ok) {
          // 일꾼을 띄울 수 없었거나 시간이 모자랐던 것은 문서 탓이 아니다 — 이번만 거절하고 기억하지 않는다.
          if (verdict.reason === 'unavailable') throw sourceTemporarilyUnreadableError(source.fileName, 'could not be checked right now');
          if (verdict.reason === 'timeout') throw sourceTemporarilyUnreadableError(source.fileName, 'took too long to check');
          refuse();
        }
      }
    }
    const kept = options.keepBytes ? bytes.slice() : null;
    const wasm = await this.createEngine();
    // 새 문서를 올리기 전에 자리를 비운다 — 바뀐 문서의 옛 판부터, 그다음 오래 쉰 엔진. 엔진 메모리의
    // 높은 물 자국이 한도를 넘지 않게 한다.
    if (options.family) {
      for (const stale of [...this.entries.values()]) {
        if (stale.family === options.family && stale.uses === 0 && !this.waiting.has(stale.key)) this.evict(stale);
      }
    }
    this.makeRoom(this.limit - 1);
    const loadIntoEngine = () => { wasm.loadDocument(bytes, source.fileName); };
    try {
      if (options.untrusted) this.guard(digest, loadIntoEngine);
      else loadIntoEngine();
    } catch (error) {
      try { wasm.releaseDocument(); } catch { /* trap 뒤에는 놓을 것도 없다 */ }
      if (options.untrusted && !isEngineTrap(error)) this.refuseKey(key, sourceUnreadableError(source.fileName));
      throw error;
    }
    this.loadedDigests.delete(digest);
    this.loadedDigests.add(digest);
    while (this.loadedDigests.size > LOADED_DIGEST_LIMIT) this.loadedDigests.delete(this.loadedDigests.values().next().value!);
    const entry: PoolEntry = {
      key, family: options.family ?? null, wasm, bytes: kept, digest, uses: 0, lastUsed: ++this.clock, idleTimer: null,
    };
    this.entries.set(key, entry);
    return entry;
  }

  private unhold(entry: PoolEntry): void {
    entry.uses = Math.max(0, entry.uses - 1);
    entry.lastUsed = ++this.clock;
    if (entry.uses > 0 || this.entries.get(entry.key) !== entry) return;
    entry.idleTimer = setTimeout(() => this.evict(entry), this.idleMs);
    // 모두 쥐고 있어 한도를 넘겨 열었던 엔진은 놓이는 대로 줄인다.
    this.makeRoom(this.limit);
  }

  /** 쉬는 엔진을 오래된 것부터 내려 엔진 수를 max 이하로 맞춘다. 쥔 엔진은 건드리지 않는다. */
  private makeRoom(max: number): void {
    while (this.entries.size > max) {
      let oldest: PoolEntry | null = null;
      for (const entry of this.entries.values()) {
        if (entry.uses > 0 || this.waiting.has(entry.key)) continue;
        if (!oldest || entry.lastUsed < oldest.lastUsed) oldest = entry;
      }
      if (!oldest) return;
      this.evict(oldest);
    }
  }

  private evict(entry: PoolEntry): void {
    if (entry.idleTimer !== null) clearTimeout(entry.idleTimer);
    entry.idleTimer = null;
    if (this.entries.get(entry.key) !== entry) return;
    this.entries.delete(entry.key);
    try {
      entry.wasm.releaseDocument();
    } catch {
      /* trap 뒤의 엔진은 놓을 수 없다 — 창이 다시 열린다 */
    }
    entry.bytes = null;
  }

  private refuseKey(key: string, error: AgentToolError): never {
    this.unreadableKeys.delete(key);
    this.unreadableKeys.set(key, error);
    while (this.unreadableKeys.size > PREFLIGHT_CACHE_LIMIT) {
      this.unreadableKeys.delete(this.unreadableKeys.keys().next().value!);
    }
    throw error;
  }

  /**
   * untrusted 엔진의 메서드 호출과 속성 읽기를 하나하나 {@link guard} 로 감싼다. 메서드 안의 this 도
   * 감싼 엔진이라 비동기 메서드가 await 뒤에 부르는 엔진 호출도 그때그때 표식을 둔다.
   */
  private guardedEngine(entry: PoolEntry): WasmBridge {
    const cached = this.guardedEngines.get(entry);
    if (cached) return cached;
    const wrapped = new Map<PropertyKey, unknown>();
    const proxy: WasmBridge = new Proxy(entry.wasm, {
      get: (target, property) => {
        const value = this.guard(entry.digest, () => Reflect.get(target, property, proxy));
        if (typeof value !== 'function') return value;
        let method = wrapped.get(property);
        if (!method) {
          method = (...args: unknown[]) => this.guard(entry.digest, () => Reflect.apply(value, proxy, args));
          wrapped.set(property, method);
        }
        return method;
      },
    });
    this.guardedEngines.set(entry, proxy);
    return proxy;
  }

  /**
   * 공유 엔진이 untrusted 문서로 동기 wasm 호출을 하는 동안 sessionStorage 에 표식을 둔다. 돌려받은
   * Promise 를 기다리지 않는다 — 그동안의 엔진 호출은 다시 이 함수를 지난다. 표식은 호출이 끝난 뒤
   * 마이크로태스크에서 지운다: 한 번에 이어지는 호출 수천 개가 저장소를 한 번만 쓰고, await 로 쉬는
   * 동안(창을 새로 고칠 수 있는 때)에는 표식이 없다. trap 이면 표식을 남기고 이 창에서도 그 문서를
   * 거절한다 — 엔진 trap 복구로 다시 연 창은 시작할 때 표식을 거절 목록으로 옮긴다.
   */
  private guard<T>(digest: string, run: () => T): T {
    const count = this.inFlight.get(digest) ?? 0;
    this.inFlight.set(digest, count + 1);
    if (count === 0 && !this.marked.has(digest)) {
      this.marked.add(digest);
      this.writeStorage(() => this.storage?.setItem(`${MARKER_PREFIX}${digest}`, '1'));
    }
    try {
      return run();
    } catch (error) {
      if (isEngineTrap(error)) this.deny(digest);
      throw error;
    } finally {
      const left = (this.inFlight.get(digest) ?? 1) - 1;
      if (left > 0) this.inFlight.set(digest, left);
      else {
        this.inFlight.delete(digest);
        queueMicrotask(() => this.clearMarker(digest));
      }
    }
  }

  private clearMarker(digest: string): void {
    if (this.inFlight.has(digest) || !this.marked.has(digest) || this.denied.has(digest)) return;
    this.marked.delete(digest);
    this.writeStorage(() => this.storage?.removeItem(`${MARKER_PREFIX}${digest}`));
  }

  private deny(digest: string): void {
    this.denied.delete(digest);
    this.denied.add(digest);
    while (this.denied.size > DENIED_LIMIT) this.denied.delete(this.denied.values().next().value!);
    this.writeStorage(() => this.storage?.setItem(DENIED_KEY, JSON.stringify([...this.denied])));
  }

  /** 지난 창이 남긴 표식을 거절 목록으로 옮긴다. 표식이 남았다면 그 문서를 읽다가 창이 멈춘 것이다. */
  private restoreDenied(): Set<string> {
    const denied = new Set<string>();
    const storage = this.storage;
    if (!storage) return denied;
    try {
      const saved: unknown = JSON.parse(storage.getItem(DENIED_KEY) ?? '[]');
      if (Array.isArray(saved)) for (const digest of saved) if (typeof digest === 'string') denied.add(digest);
      const markers: string[] = [];
      for (let i = 0; i < storage.length; i++) {
        const key = storage.key(i);
        if (key?.startsWith(MARKER_PREFIX)) markers.push(key);
      }
      for (const key of markers) {
        denied.delete(key.slice(MARKER_PREFIX.length));
        denied.add(key.slice(MARKER_PREFIX.length));
        storage.removeItem(key);
      }
      while (denied.size > DENIED_LIMIT) denied.delete(denied.values().next().value!);
      if (markers.length > 0) storage.setItem(DENIED_KEY, JSON.stringify([...denied]));
    } catch {
      /* 저장소를 못 쓰면 표식 없이 간다 */
    }
    return denied;
  }

  private writeStorage(write: () => void): void {
    try {
      write();
    } catch {
      /* 저장소가 가득 찼거나 막혔다 — 읽기는 계속한다 */
    }
  }
}

// ─── 미리 읽기 ──────────────────────────────────────────

export type PreflightRunner = (bytes: Uint8Array) => Promise<PreflightVerdict>;

export interface DocumentPreflightOptions {
  /** 바이트를 따로 띄운 엔진에서 읽어 본다. 기본은 document-preflight.worker.ts. */
  run?: PreflightRunner;
  wasmVersion?: () => string | Promise<string>;
  limit?: number;
}

/**
 * 같은 엔진 판(wasmVersion)과 같은 바이트(digest)는 한 번만 미리 읽는다. 문서 탓인 실패(trap·
 * unreadable)도 기억한다 — 같은 바이트는 같은 엔진에서 다시 실패한다. 일꾼을 띄울 수 없었거나 시간이
 * 모자랐던 경우는 기억하지 않는다.
 */
export class DocumentPreflight {
  private readonly cache = new Map<string, PreflightVerdict>();
  private readonly running = new Map<string, Promise<PreflightVerdict>>();
  private readonly run: PreflightRunner;
  private readonly wasmVersion: () => string | Promise<string>;
  private readonly limit: number;

  constructor(options: DocumentPreflightOptions = {}) {
    this.run = options.run ?? runPreflightInWorker;
    this.wasmVersion = options.wasmVersion ?? windowWasmVersion;
    this.limit = Math.max(1, options.limit ?? PREFLIGHT_CACHE_LIMIT);
  }

  async check(bytes: Uint8Array, digest: string): Promise<PreflightVerdict> {
    const key = `${await this.wasmVersion()}:${digest}`;
    const cached = this.cache.get(key);
    if (cached) {
      this.cache.delete(key);
      this.cache.set(key, cached);
      return cached;
    }
    let running = this.running.get(key);
    if (!running) {
      running = Promise.resolve()
        .then(() => this.run(bytes))
        .catch((): PreflightVerdict => ({ ok: false, reason: 'unavailable' }))
        .then((verdict) => {
          if (verdict.ok || verdict.reason === 'trap' || verdict.reason === 'unreadable') this.remember(key, verdict);
          return verdict;
        })
        .finally(() => this.running.delete(key));
      this.running.set(key, running);
    }
    return running;
  }

  private remember(key: string, verdict: PreflightVerdict): void {
    this.cache.set(key, verdict);
    while (this.cache.size > this.limit) this.cache.delete(this.cache.keys().next().value!);
  }
}

let windowVersion: Promise<string> | null = null;

/** 창의 wasm 판. 일꾼도 같은 빌드를 띄우므로 미리 읽기 결과의 열쇠가 된다. */
function windowWasmVersion(): Promise<string> {
  windowVersion ??= import('@wasm/rhwp.js')
    .then((module) => String(module.version()))
    .catch(() => 'unknown');
  return windowVersion;
}

let sharedPreflight: DocumentPreflight | null = null;

function sharedDocumentPreflight(): DocumentPreflight {
  sharedPreflight ??= new DocumentPreflight();
  return sharedPreflight;
}

let preflightWorker: Worker | null = null;
let preflightIdleTimer: ReturnType<typeof setTimeout> | null = null;
let preflightSequence = 0;
let preflightChain: Promise<unknown> = Promise.resolve();

/** 미리 읽기 일꾼을 내려 그 엔진의 메모리를 돌려준다. */
export function releasePreflightWorker(): void {
  if (preflightIdleTimer !== null) clearTimeout(preflightIdleTimer);
  preflightIdleTimer = null;
  preflightWorker?.terminate();
  preflightWorker = null;
}

function preflightOnce(bytes: Uint8Array): Promise<PreflightVerdict> {
  return new Promise((resolve) => {
    if (preflightIdleTimer !== null) clearTimeout(preflightIdleTimer);
    preflightIdleTimer = null;
    let target: Worker;
    try {
      preflightWorker ??= new Worker(new URL('./document-preflight.worker.ts', import.meta.url), {
        type: 'module',
        name: 'rhwp-document-preflight',
      });
      target = preflightWorker;
    } catch {
      resolve({ ok: false, reason: 'unavailable' });
      return;
    }
    const id = ++preflightSequence;
    let settled = false;
    const finish = (verdict: PreflightVerdict, restart: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      target.removeEventListener('message', onMessage);
      target.removeEventListener('error', onError);
      // trap·시간 초과·준비 실패 뒤의 일꾼 엔진은 믿을 수 없다 — 다음 문서는 새 일꾼이 읽는다.
      if (restart) {
        if (preflightWorker === target) releasePreflightWorker();
      } else if (preflightWorker === target) {
        preflightIdleTimer = setTimeout(releasePreflightWorker, PREFLIGHT_WORKER_IDLE_MS);
      }
      resolve(verdict);
    };
    const onMessage = (event: MessageEvent<DocumentPreflightResponse>) => {
      const data = event.data;
      if (data?.id !== id) return;
      // 일꾼이 엔진 준비를 마쳤다 — 일꾼 시작과 wasm 컴파일은 문서의 시간에 넣지 않는다.
      if ('stage' in data) {
        clearTimeout(timer);
        timer = setTimeout(() => finish({ ok: false, reason: 'timeout' }, true), PREFLIGHT_TIMEOUT_MS);
        return;
      }
      finish(data.ok ? { ok: true } : { ok: false, reason: data.reason }, !data.ok && data.reason !== 'unreadable');
    };
    // 일꾼 자체가 뜨지 못했다(스크립트·wasm 로드 실패) — 문서 탓으로 기억하지 않는다.
    const onError = () => finish({ ok: false, reason: 'unavailable' }, true);
    let timer = setTimeout(() => finish({ ok: false, reason: 'unavailable' }, true), PREFLIGHT_STARTUP_TIMEOUT_MS);
    target.addEventListener('message', onMessage);
    target.addEventListener('error', onError);
    const copy = bytes.slice();
    target.postMessage({ id, bytes: copy } satisfies DocumentPreflightRequest, [copy.buffer]);
  });
}

/** 일꾼 하나가 한 번에 문서 하나를 읽는다. */
function runPreflightInWorker(bytes: Uint8Array): Promise<PreflightVerdict> {
  const run = preflightChain.then(() => preflightOnce(bytes));
  preflightChain = run.catch(() => {});
  return run;
}

// ─── 닫힌 최근 문서 ────────────────────────────────────

export interface RecentDocumentIo {
  listRecent: () => Promise<readonly RecentDoc[]>;
  /** 문서 홈과 같은 확인 — 데스크톱은 기억한 경로를 stat 하고, 브라우저는 허락된 핸들만 연다. */
  inspect: (rows: readonly RecentDoc[]) => Promise<Map<string, DocumentPresence>>;
  /** 데스크톱이 documentId 로 기억한 파일, 못 읽었으면 그 이유. 데스크톱이 아니면 null. */
  readNative: (documentId: string) => Promise<RememberedNativeDocumentRead | null>;
}

const defaultRecentIo: RecentDocumentIo = {
  listRecent: async () => (await import('../recent/recent-store.ts')).listRecentDocs(),
  inspect: async (rows) => (await import('../home/home-data.ts')).inspectRecentDocuments(rows),
  readNative: async (documentId) => (await import('../desktop-integration.ts')).readRememberedNativeDocumentResult(documentId),
};

function stampSize(stamp: string): number | null {
  const size = Number(stamp.split(':')[0]);
  return Number.isSafeInteger(size) && size >= 0 ? size : null;
}

/**
 * 최근 문서 기록에서 닫힌 문서의 원본을 찾는다. stamp 만 먼저 보고(stat), 바이트는 엔진이 없을 때
 * read 가 읽는다. 브라우저 파일 핸들은 이미 허락된 경우에만 쓰고 권한 창을 띄우지 않는다.
 * 최근 문서 기록에 없는 문서(프로젝트 구성원 등)도 데스크톱은 documentId 로 기억한 위치에서 읽는다.
 */
export function createRecentDocumentResolver(overrides: Partial<RecentDocumentIo> = {}): (documentId: string) => Promise<ForeignDocumentSource> {
  const io: RecentDocumentIo = { ...defaultRecentIo, ...overrides };
  return async (documentId) => {
    const recent = [...await io.listRecent()]
      .filter((item) => item.documentId === documentId)
      .sort((a, b) => b.openedAt - a.openedAt)[0];
    const row: RecentDoc = recent ?? {
      id: `document:${documentId}`, documentId, sourceDigest: '', fileName: '', sourceFormat: '', openedAt: 0,
    };
    const presence = (await io.inspect([row])).get(row.id);
    if (presence?.state === 'present') {
      const name = presence.fileName || row.fileName;
      const size = stampSize(presence.stamp);
      if (size !== null && size > FOREIGN_DOCUMENT_MAX_BYTES) throw sourceTooLargeError(name, size);
      const checked = (read: ForeignDocumentBytes): ForeignDocumentBytes => {
        if (read.bytes.byteLength > FOREIGN_DOCUMENT_MAX_BYTES) throw sourceTooLargeError(name, read.bytes.byteLength);
        return read;
      };
      if (presence.source === 'desktop') {
        return {
          stamp: presence.stamp,
          name,
          read: async () => {
            const read = await io.readNative(documentId);
            if (read?.ok) return checked({ bytes: read.bytes, fileName: read.fileName });
            switch (read?.reason) {
              // 다른 창이 그 파일을 열어 쥐고 있다 — 허브가 그 창으로 한 번 다시 보낸다.
              case 'owned':
                throw new AgentToolError(
                  'DOCUMENT_OPEN_ELSEWHERE',
                  `"${name}" is open in another window; its saved file cannot be read from here.`,
                );
              case 'missing': throw sourceNotFoundError(documentId, 'was moved or deleted');
              case 'too-large': throw sourceTooLargeError(name, read.size ?? FOREIGN_DOCUMENT_MAX_BYTES + 1);
              // 잠긴 파일, 내려받지 않은 클라우드 파일 — 문서 탓이 아니고 엔진 묶음도 기억하지 않는다.
              default:
                throw sourceTemporarilyUnreadableError(name, 'could not be read right now (it may be locked, offline or not downloaded yet)');
            }
          },
        };
      }
      const handle = row.handle;
      if (!handle) throw sourceNotFoundError(documentId);
      return {
        stamp: presence.stamp,
        name,
        read: async () => {
          const file = await handle.getFile();
          if (file.size > FOREIGN_DOCUMENT_MAX_BYTES) throw sourceTooLargeError(name, file.size);
          return checked({ bytes: new Uint8Array(await file.arrayBuffer()), fileName: file.name });
        },
      };
    }
    if (presence?.state === 'missing') throw sourceNotFoundError(documentId, 'was moved or deleted');
    if (presence?.state === 'unavailable') throw sourceNotFoundError(documentId, 'is on a location that cannot be reached now');
    if (!recent) throw sourceNotFoundError(documentId, 'is not available on this device');
    // 확인할 수 없었다 — 브라우저 핸들이면 권한을 아직 받지 못한 것이다. 권한 창은 띄우지 않는다.
    const handle = row.handle;
    if (handle && handle.identityKind !== 'native-path' && typeof handle.queryPermission === 'function') {
      const permission = await handle.queryPermission({ mode: 'read' }).catch(() => 'denied');
      if (permission !== 'granted') {
        throw new AgentToolError(
          'SOURCE_PERMISSION_REQUIRED',
          `"${row.fileName}" needs the user's file permission before it can be read. Ask the user to open it once in the editor.`,
        );
      }
    }
    throw sourceNotFoundError(documentId);
  };
}

// ─── 경로로 고른 파일 (file: 핸들) ─────────────────────

/**
 * list_documents({path}) 가 발급한 파일 — 허브가 핸들을 다시 확인(stat)해 tool-request 의 source 로
 * 싣는다. 크기·수정 시각이 같으면 엔진을 다시 쓰고, 바뀌면 바이트를 새로 받는다.
 */
export interface FileDocumentSource {
  kind: 'file';
  handle: string;
  name: string;
  size: number;
  mtimeMs: number;
}

export const FILE_DOCUMENT_ID_PREFIX = 'file:';

export function fileSourceKey(source: FileDocumentSource): string {
  return `file:${source.handle}:${source.size}:${source.mtimeMs}`;
}

export function fileSourceNotFoundError(documentId: string): AgentToolError {
  return new AgentToolError(
    'SOURCE_NOT_FOUND',
    `${documentId} is no longer available. Run list_documents with the path again for a fresh handle.`,
  );
}

/**
 * 허브의 /document-sources/:handle/content 응답을 바이트로 — 404 는 SOURCE_NOT_FOUND, 409 는
 * SOURCE_UNREADABLE, 한도를 넘으면(413) SOURCE_TOO_LARGE 다. 허브가 오류 코드를 실어 보내면 그 코드를 쓴다.
 */
export async function readFileSourceResponse(source: FileDocumentSource, response: Response): Promise<ForeignDocumentBytes> {
  const documentId = `${FILE_DOCUMENT_ID_PREFIX}${source.handle}`;
  if (!response.ok) {
    let code: string | null = null;
    let message: string | null = null;
    try {
      const body = JSON.parse(new TextDecoder().decode(
        await readResponseBytesWithLimit(response, ERROR_RESPONSE_MAX_BYTES, '문서 오류 응답'),
      )) as { error?: { code?: unknown; message?: unknown }; code?: unknown; message?: unknown };
      const error = body.error ?? body;
      code = typeof error.code === 'string' && /^[A-Z][A-Z0-9_]{2,63}$/u.test(error.code) ? error.code : null;
      message = typeof error.message === 'string' ? error.message.slice(0, 500) : null;
    } catch {
      await cancelResponseBody(response, `HTTP ${response.status}`);
    }
    if (response.status === 404 || code === 'SOURCE_NOT_FOUND') throw fileSourceNotFoundError(documentId);
    if (response.status === 413 || code === 'SOURCE_TOO_LARGE') throw sourceTooLargeError(source.name, source.size);
    if (response.status === 409 || code === 'SOURCE_UNREADABLE') throw sourceUnreadableError(source.name);
    throw new AgentToolError(code ?? 'RPC_ERROR', message ?? `"${source.name}" could not be fetched (HTTP ${response.status}).`);
  }
  try {
    const bytes = await readResponseBytesWithLimit(response, FOREIGN_DOCUMENT_MAX_BYTES, source.name);
    // 허브가 확인한 뒤 파일이 바뀌었다 — 새 바이트를 옛 크기·수정 시각 열쇠로 담지 않고 거절한다.
    // 엔진 묶음은 받기 실패를 기억하지 않으므로 다음 읽기는 새로 확인한 열쇠로 받는다.
    const mtime = response.headers.get('X-Document-Mtime');
    if ((mtime !== null && Number(mtime) !== source.mtimeMs) || bytes.byteLength !== source.size) {
      throw sourceChangedError(source.name);
    }
    return { bytes, fileName: source.name };
  } catch (error) {
    if (error instanceof ByteLimitError) throw sourceTooLargeError(source.name, Math.max(source.size, FOREIGN_DOCUMENT_MAX_BYTES + 1));
    throw error;
  }
}

// ─── 문서 목록 (list_documents) ────────────────────────

/** list_documents 가 돌려주는 문서 하나. */
export interface KnownDocument {
  documentId: string;
  name: string;
  format: string;
  openedAt: number;
  /** 이 창에 열린 문서만 — 저장하지 않은 편집이 있다. */
  dirty?: boolean;
  state: 'open' | 'closed';
}

/** 문서 목록의 재료 — 이 창에 열린 문서와 최근 문서 기록. */
export interface KnownDocumentSources {
  open: readonly KnownDocument[];
  recent: readonly KnownDocument[];
}

export const KNOWN_DOCUMENT_LIST_LIMIT = 50;

function foldName(text: string): string {
  return text.normalize('NFC').toLocaleLowerCase();
}

/**
 * 열린 문서를 먼저, 그다음 최근 문서를 최근에 연 순서로 — documentId 가 같으면 앞의 것만 남긴다.
 * query 는 이름의 부분 문자열(NFC, 대소문자 무시)로 거른다.
 */
export function mergeKnownDocuments(
  sources: KnownDocumentSources,
  query?: string,
  limit = KNOWN_DOCUMENT_LIST_LIMIT,
): { documents: KnownDocument[]; truncated: boolean } {
  const needle = foldName(query?.trim() ?? '');
  const seen = new Set<string>();
  const documents: KnownDocument[] = [];
  const byRecent = (a: KnownDocument, b: KnownDocument) => b.openedAt - a.openedAt;
  const rows = [
    ...[...sources.open].sort(byRecent).map((row) => ({ ...row, state: 'open' as const, dirty: row.dirty === true })),
    ...[...sources.recent].sort(byRecent).map(({ dirty: _dirty, ...row }) => ({ ...row, state: 'closed' as const })),
  ];
  let truncated = false;
  for (const row of rows) {
    if (!row.documentId || seen.has(row.documentId)) continue;
    seen.add(row.documentId);
    if (needle && !foldName(row.name).includes(needle)) continue;
    if (documents.length >= limit) {
      truncated = true;
      break;
    }
    documents.push(row);
  }
  return { documents, truncated };
}
