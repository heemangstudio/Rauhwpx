// 한 채팅 창(허브 세션 기록)의 대기 중인 사용자 요청 — 일반 권한, 브라우저 계정·넘겨받기, 비밀.
// 모든 요청은 한 곳에서 끝나며 정확히 한 번 chat-permission-resolved 를 낸다.

export const CHAT_REQUEST_TTL_MS = 30 * 60 * 1000;
export const MAX_PENDING_CHAT_REQUESTS = 16;
// 사용자가 끝낸 요청으로 이어지는 턴은 이 시간 안에만 열린다(다른 채팅으로 갔다 돌아온 경우).
export const CHAT_CONTINUATION_TTL_MS = 10 * 60 * 1000;
const MAX_CONTINUATIONS = 8;

/**
 * @typedef {{ status: 'granted' } | { status: 'denied' | 'expired', reason?: string }} ChatRequestOutcome
 * @typedef {{ request: Record<string, any>, kind: 'generic' | 'browser' | 'secret', threadId: string, documentId: string | null } & Record<string, any>} ChatRequestEntry
 */

export class ChatRequestRegistry {
  /** @type {Map<string, ChatRequestEntry & { timer?: NodeJS.Timeout }>} */
  #entries = new Map();
  #publish;
  #finish;

  /**
   * @param {{ publish: (request: Record<string, any>) => boolean, finish: (entry: ChatRequestEntry, outcome: ChatRequestOutcome, options: Record<string, any>) => void }} hooks
   */
  constructor({ publish, finish }) {
    this.#publish = publish;
    this.#finish = finish;
  }

  get size() { return this.#entries.size; }

  /**
   * 새 요청을 등록하고 Studio 에 알린다. ttlMs 가 지나면 expired(timeout) 로 끝난다.
   * requireDelivery 가 거짓이면 Studio 가 잠시 끊겨 있어도 남겨 두고, 다시 붙을 때 스냅샷으로 보낸다.
   */
  add(entry, ttlMs = CHAT_REQUEST_TTL_MS, { requireDelivery = true } = {}) {
    if (this.#entries.size >= MAX_PENDING_CHAT_REQUESTS) {
      throw Object.assign(new Error('Too many requests are waiting for the user'), { code: 'INTERACTION_LIMIT' });
    }
    const requestId = entry.request.requestId;
    const stored = { ...entry };
    stored.timer = setTimeout(() => this.settle(requestId, { status: 'expired', reason: 'timeout' }), Math.max(1, ttlMs));
    stored.timer.unref?.();
    this.#entries.set(requestId, stored);
    if (!this.#publish(structuredClone(entry.request)) && requireDelivery) {
      this.settle(requestId, { status: 'expired', reason: 'studio-disconnected' });
      throw Object.assign(new Error('Studio disconnected before the request could be presented'), { code: 'NO_STUDIO' });
    }
    return stored;
  }

  get(requestId) { return typeof requestId === 'string' ? this.#entries.get(requestId) ?? null : null; }

  find(predicate) {
    for (const entry of this.#entries.values()) if (predicate(entry)) return entry;
    return null;
  }

  /** 생성 순서대로의 요청 사본 — 스냅샷과 재연결 재생이 같은 목록을 쓴다. */
  snapshot() {
    return [...this.#entries.values()]
      .map((entry) => entry.request)
      .sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)))
      .map((request) => structuredClone(request));
  }

  /** 요청을 끝낸다. 이미 끝난 요청이면 아무것도 하지 않고 null 을 돌려준다. */
  settle(requestId, outcome, options = {}) {
    const entry = this.#entries.get(requestId);
    if (!entry) return null;
    this.#entries.delete(requestId);
    clearTimeout(entry.timer);
    delete entry.timer;
    try { this.#finish(entry, outcome, options); } catch {}
    return entry;
  }

  /** 조건에 맞는 모든 요청을 expired 로 끝낸다. */
  expire(reason, predicate = () => true) {
    const settled = [];
    for (const entry of [...this.#entries.values()]) {
      if (!predicate(entry)) continue;
      if (this.settle(entry.request.requestId, { status: 'expired', reason })) settled.push(entry);
    }
    return settled;
  }
}

/** 사용자가 끝낸 요청 뒤에 에이전트를 이어 실행할 문장. 같은 채팅의 항목은 한 턴으로 묶는다. */
export class ChatContinuationQueue {
  #entries = [];
  #now;

  constructor({ now = Date.now } = {}) { this.#now = now; }

  get size() { return this.#entries.length; }

  push({ requestId, threadId, turnId = null, text }) {
    this.#entries = this.#entries
      .filter((entry) => entry.requestId !== requestId)
      .concat({ requestId, threadId, turnId, text, expiresAt: this.#now() + CHAT_CONTINUATION_TTL_MS })
      .slice(-MAX_CONTINUATIONS);
  }

  has(threadId) { return this.#entries.some((entry) => entry.threadId === threadId); }

  /** threadId 의 항목을 꺼낸다. held 가 참인 항목과 다른 채팅의 항목은 그대로 둔다. */
  take(threadId, { held = () => false } = {}) {
    const now = this.#now();
    this.#entries = this.#entries.filter((entry) => entry.expiresAt > now);
    const taken = this.#entries.filter((entry) => entry.threadId === threadId && !held(entry));
    if (!taken.length) return null;
    this.#entries = this.#entries.filter((entry) => !taken.includes(entry));
    return { entries: taken, requestIds: taken.map((entry) => entry.requestId), text: taken.map((entry) => entry.text).join('\n') };
  }

  /** 보내지 못한 항목을 앞에 되돌린다. */
  restore(taken) {
    if (!taken) return;
    this.#entries = taken.entries.concat(this.#entries).slice(-MAX_CONTINUATIONS);
  }

  drop(threadId) { this.#entries = this.#entries.filter((entry) => entry.threadId !== threadId); }

  clear() { this.#entries = []; }
}
