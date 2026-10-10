/**
 * 채팅별 실행 상태 공유 — 탭마다 독립적으로 돌아가는 채팅 세션의
 * 표시 신호만 localStorage 로 나눠 갖는다. 어떤 탭의 스레드 목록에서든
 * 지금 일하는 채팅(노란 불), 답을 기다리는 채팅(빨간 점), 검토를 기다리는 채팅,
 * 오류로 멈춘 채팅(빨간 고리), 보지 않은 채 끝난 채팅(초록 점)이 보인다.
 *
 * 세션 자체에는 손대지 않는다. 여기 담기는 것은 표시용 신호뿐이라
 * 잃어버려도 대화에는 아무 영향이 없다. 저장소는 실제 상태만 담는다 —
 * 늦춰 보이는 일(U7 의 '작업 중' 지연)은 그리는 쪽의 몫이다.
 */

export type ChatRunStatus = 'working' | 'needs-input' | 'needs-review' | 'failed' | 'finished';

const STATUSES: ReadonlySet<string> = new Set<ChatRunStatus>([
  'working', 'needs-input', 'needs-review', 'failed', 'finished',
]);
/** 살아 있는 상태(작업·입력·검토)는 그 상태를 쓴 페이지가 사라지면 함께 꺼진다. */
const LIVE_STATUSES: ReadonlySet<ChatRunStatus> = new Set<ChatRunStatus>(['working', 'needs-input', 'needs-review']);
/** 사용자가 봐야 하는 상태 — 확인 필요 칩·머리 숫자·알림이 센다. */
export const ATTENTION_STATUSES: ReadonlySet<ChatRunStatus> = new Set<ChatRunStatus>([
  'needs-input', 'needs-review', 'failed', 'finished',
]);

const STORAGE_KEY = 'rhwp-agent-chat-status';
const CHANNEL_NAME = 'rhwp-agent-chat-status';
/** 작업 신호는 심장박동이 이 시간 넘게 끊기면(탭 크래시 등) 무효다. */
const WORKING_STALE_MS = 25_000;
const HEARTBEAT_MS = 10_000;
/** 작업이 아닌 점은 이 시간이 지나면 정리한다 — 옛 채팅까지 점이 남지 않게. */
const FINISHED_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_ENTRIES = 80;
/** 오류 이유는 짧은 이름이다. 더 길면 자르고 말줄임표를 붙인다. */
export const CHAT_STATUS_LABEL_MAX = 40;
/** 무효 전환(심장박동 끊김·TTL 만료)을 구독자에게 알리는 점검 주기. */
const SWEEP_MS = 5_000;

interface StatusEntry {
  status: ChatRunStatus;
  updatedAt: number;
  /** 작업을 시작한 시각 — 목록의 "작업 중 2분" 경과 표시. */
  startedAt?: number;
  /** failed 의 짧은 이유('중단됨', '로그인 필요' …). 없으면 '오류'. */
  label?: string;
}

/** 지금 유효한 한 스레드의 상태. */
export interface ChatStatusView {
  status: ChatRunStatus;
  label: string | null;
}

const listeners = new Set<() => void>();
/**
 * 이 페이지가 마지막으로 살아 있는 상태를 쓴 스레드 — 심장박동과 페이지 종료 정리는
 * 이 목록만 만진다. 다른 페이지가 쓴 점은 건드리지 않는다.
 */
const ownedLive = new Set<string>();
const memoryMap = new Map<string, StatusEntry>();
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let sweepTimer: ReturnType<typeof setInterval> | null = null;
let channel: BroadcastChannel | null = null;
let lastSnapshot = '';

function canUseStorage(): boolean {
  try {
    return typeof localStorage !== 'undefined';
  } catch {
    return false;
  }
}

function isStatusEntry(v: unknown): v is StatusEntry {
  if (!v || typeof v !== 'object') return false;
  const entry = v as Record<string, unknown>;
  return typeof entry.status === 'string' && STATUSES.has(entry.status)
    && Number.isFinite(Number(entry.updatedAt));
}

function isLive(status: ChatRunStatus): boolean {
  return LIVE_STATUSES.has(status);
}

/** 이유 글자를 한 줄로 다듬는다. 비면 null. */
export function normalizeChatStatusLabel(label: unknown): string | null {
  if (typeof label !== 'string') return null;
  const text = label.replace(/\s+/g, ' ').trim();
  if (!text) return null;
  const chars = [...text];
  return chars.length > CHAT_STATUS_LABEL_MAX
    ? `${chars.slice(0, CHAT_STATUS_LABEL_MAX - 1).join('')}…`
    : text;
}

function readMap(): Map<string, StatusEntry> {
  if (!canUseStorage()) return new Map(memoryMap);
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return new Map();
    const map = new Map<string, StatusEntry>();
    for (const [id, entry] of Object.entries(parsed)) {
      if (isStatusEntry(entry)) map.set(id, entry);
    }
    return map;
  } catch {
    return new Map();
  }
}

function writeMap(map: Map<string, StatusEntry>): void {
  const trimmed = [...map.entries()]
    .sort((a, b) => b[1].updatedAt - a[1].updatedAt)
    .slice(0, MAX_ENTRIES);
  if (!canUseStorage()) {
    memoryMap.clear();
    for (const [id, entry] of trimmed) memoryMap.set(id, entry);
    return;
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(trimmed)));
  } catch {
    /* 저장 실패는 표시 신호만 잃는다 */
  }
}

function liveStatus(entry: StatusEntry, now: number): ChatRunStatus | null {
  if (entry.status === 'working') {
    return now - entry.updatedAt <= WORKING_STALE_MS ? 'working' : null;
  }
  // 나머지 점은 심장박동 없이 남고 TTL 로만 정리한다 — 가려진 창의 타이머가 늦어져도
  // 입력·검토 대기 점이 깜빡이지 않는다. 그 점을 쓴 페이지가 닫히면 페이지가 직접 지운다.
  return now - entry.updatedAt <= FINISHED_TTL_MS ? entry.status : null;
}

function entryLabel(entry: StatusEntry): string | null {
  return entry.status === 'failed' ? normalizeChatStatusLabel(entry.label) : null;
}

function currentSnapshot(): string {
  const now = Date.now();
  return [...readMap().entries()]
    .map(([id, entry]) => [id, liveStatus(entry, now), entryLabel(entry)] as const)
    .filter(([, status]) => status !== null)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, status, label]) => `${id}:${status}${label ? `:${label}` : ''}`)
    .join('|');
}

/** 실질 상태(id→상태·이유)가 바뀌었을 때만 알린다 — 심장박동만으로는 조용하다. */
function emitIfChanged(): void {
  const snapshot = currentSnapshot();
  if (snapshot === lastSnapshot) return;
  lastSnapshot = snapshot;
  for (const listener of [...listeners]) listener();
}

function notifyPeers(): void {
  channel?.postMessage({ key: STORAGE_KEY });
}

function mutate(fn: (map: Map<string, StatusEntry>) => void): void {
  const map = readMap();
  fn(map);
  writeMap(map);
  notifyPeers();
  emitIfChanged();
}

function syncHeartbeat(): void {
  if (ownedLive.size === 0) {
    if (heartbeatTimer !== null) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    return;
  }
  if (heartbeatTimer !== null) return;
  heartbeatTimer = setInterval(() => {
    mutate((map) => {
      const now = Date.now();
      // 살아 있는 상태는 모두 시각을 새로 한다 — 몇 시간 열어 둔 질문도 TTL 에 걸리지 않는다.
      for (const id of ownedLive) {
        const entry = map.get(id);
        if (entry && isLive(entry.status)) map.set(id, { ...entry, updatedAt: now });
      }
    });
  }, HEARTBEAT_MS);
  (heartbeatTimer as { unref?: () => void }).unref?.();
}

function syncSweep(): void {
  if (listeners.size === 0) {
    if (sweepTimer !== null) {
      clearInterval(sweepTimer);
      sweepTimer = null;
    }
    return;
  }
  if (sweepTimer !== null) return;
  sweepTimer = setInterval(emitIfChanged, SWEEP_MS);
  (sweepTimer as { unref?: () => void }).unref?.();
}

if (typeof window !== 'undefined') {
  if (typeof BroadcastChannel !== 'undefined') {
    channel = new BroadcastChannel(CHANNEL_NAME);
    channel.addEventListener('message', emitIfChanged);
  }
  // BroadcastChannel 이 없어도 다른 탭의 저장은 storage 이벤트로 도착한다.
  window.addEventListener('storage', (event) => {
    if (event.key === STORAGE_KEY) emitIfChanged();
  });
  // 탭이 닫히면 이 탭의 살아 있는 신호도 같이 꺼진다 — 죽은 불과 점을 남기지 않는다.
  // 결과 점(완료·오류)은 남는다. 새로고침 뒤 다시 잡은 채팅은 그 사이드바가 다시 그린다.
  window.addEventListener('pagehide', () => releaseOwnedLiveStatuses());
}

/**
 * 한 스레드의 상태를 쓴다. null 이면 지운다. 같은 상태·이유가 이미 유효하면 쓰지 않는다.
 * working 은 앞의 시작 시각을 잇고, 살아 있는 상태는 이 페이지의 것으로 심장박동을 받는다.
 */
export function setChatStatus(
  threadId: string,
  status: ChatRunStatus | null,
  meta?: { label?: string | null },
): void {
  if (!threadId) return;
  const now = Date.now();
  const label = status === 'failed' ? normalizeChatStatusLabel(meta?.label) : null;
  const previous = readMap().get(threadId);
  if (status === null) {
    ownedLive.delete(threadId);
    syncHeartbeat();
    if (previous) mutate((map) => map.delete(threadId));
    return;
  }
  if (isLive(status)) ownedLive.add(threadId);
  else ownedLive.delete(threadId);
  syncHeartbeat();
  if (
    previous
    && previous.status === status
    && entryLabel(previous) === label
    && liveStatus(previous, now) === status
  ) return;
  mutate((map) => {
    const current = map.get(threadId);
    const entry: StatusEntry = { status, updatedAt: now };
    if (status === 'working') {
      // 이미 일하는 채팅이면 시작 시각을 그대로 둔다 — 경과 시간이 되돌아가지 않는다.
      entry.startedAt = current?.status === 'working' && current.startedAt && liveStatus(current, now)
        ? current.startedAt
        : now;
    }
    if (label) entry.label = label;
    map.set(threadId, entry);
  });
}

/**
 * 이 페이지가 쓴 살아 있는 상태(작업·입력·검토)를 지운다. threadIds 를 주면 그중에서만.
 * pagehide 와 사이드바 dispose 가 부른다. 결과 점과 다른 페이지가 쓴 점은 남는다.
 */
export function releaseOwnedLiveStatuses(threadIds?: Iterable<string>): void {
  const ids = threadIds ? [...threadIds].filter((id) => ownedLive.has(id)) : [...ownedLive];
  if (ids.length === 0) return;
  for (const id of ids) ownedLive.delete(id);
  syncHeartbeat();
  const map = readMap();
  const live = ids.filter((id) => {
    const entry = map.get(id);
    return entry !== undefined && isLive(entry.status);
  });
  if (live.length === 0) return;
  mutate((next) => {
    for (const id of live) {
      const entry = next.get(id);
      if (entry && isLive(entry.status)) next.delete(id);
    }
  });
}

/**
 * 사이드바가 아는 사실에서 상태 하나를 고른다.
 * 우선순위: 입력 대기 > 작업 중 > 검토 대기 > 보지 않은 결과(오류·완료).
 */
export function deriveChatRunStatus(input: {
  needsInput: boolean;
  working: boolean;
  reviewPending: boolean;
  unreadOutcome: 'failed' | 'finished' | null;
}): ChatRunStatus | null {
  if (input.needsInput) return 'needs-input';
  if (input.working) return 'working';
  if (input.reviewPending) return 'needs-review';
  return input.unreadOutcome;
}

/** 살아 있는 상태인가 — 그 상태를 쓴 페이지가 사라지면 꺼지는 것. */
export function isLiveChatStatus(status: ChatRunStatus | null): boolean {
  return status !== null && isLive(status);
}

/** 턴 시작 — 이 채팅에 노란 불이 켜지고 심장박동이 시작된다. */
export function markChatWorking(threadId: string): void {
  setChatStatus(threadId, 'working');
}

/** 턴 완료 — 노란 불이 초록 점으로 바뀐다. 채팅을 열면 점이 걷힌다. */
export function markChatFinished(threadId: string): void {
  setChatStatus(threadId, 'finished');
}

/** 사용자 응답 대기(계획 승인 또는 질문) — 빨간 점. 응답이 있어야 걷힌다. */
export function markChatNeedsInput(threadId: string): void {
  setChatStatus(threadId, 'needs-input');
}

/** 검토를 기다리는 편집 — 검토가 끝나야 걷힌다. */
export function markChatNeedsReview(threadId: string): void {
  setChatStatus(threadId, 'needs-review');
}

/**
 * 오류로 멈췄거나 바깥 사정으로 끊긴 턴 — 빨간 고리와 짧은 이유('중단됨' …).
 * 저장소만 고친다. 알림은 사이드바가 턴 끝에서 장부(chat-attention)에 알릴 때만 간다 —
 * 시작할 때 저장된 채팅을 정리하는 쪽(S3)은 이것만 부른다.
 */
export function markChatFailed(threadId: string, opts?: { label?: string | null }): void {
  setChatStatus(threadId, 'failed', { label: opts?.label ?? null });
}

/** 중단·열람 — 신호를 지운다. */
export function clearChatStatus(threadId: string): void {
  setChatStatus(threadId, null);
}

export function getChatStatus(threadId: string): ChatRunStatus | null {
  const entry = readMap().get(threadId);
  return entry ? liveStatus(entry, Date.now()) : null;
}

/** failed 의 이유. 다른 상태이거나 이유가 없으면 null. */
export function getChatStatusLabel(threadId: string): string | null {
  const entry = readMap().get(threadId);
  if (!entry || liveStatus(entry, Date.now()) !== 'failed') return null;
  return entryLabel(entry);
}

/** 지금 유효한 모든 상태 — 목록·칩·머리 숫자가 한 번에 읽는다. */
export function readChatStatuses(): Map<string, ChatStatusView> {
  const now = Date.now();
  const out = new Map<string, ChatStatusView>();
  for (const [id, entry] of readMap()) {
    const status = liveStatus(entry, now);
    if (status) out.set(id, { status, label: entryLabel(entry) });
  }
  return out;
}

/** 지금 일하는 채팅이 작업을 시작한 시각. 일하지 않으면 null. */
export function getChatWorkingSince(threadId: string): number | null {
  const entry = readMap().get(threadId);
  if (!entry || liveStatus(entry, Date.now()) !== 'working') return null;
  return entry.startedAt ?? entry.updatedAt;
}

export function subscribeChatStatus(listener: () => void): () => void {
  listeners.add(listener);
  lastSnapshot = currentSnapshot();
  syncSweep();
  return () => {
    listeners.delete(listener);
    syncSweep();
  };
}
