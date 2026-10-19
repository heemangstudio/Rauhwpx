/**
 * 앱 업데이트 재시작 — 창을 닫기 전에 문서마다 다시 여는 법을 적고, 다시 켠 창이 그 기록을 한 번 읽는다.
 *
 * 메인은 창마다 문서(문서 ID·파일·이름·보던 문서)와 이어서 진행할 채팅을 기억해 다시 켠 창에 한 번 준다.
 * 렌더러만 아는 것 — 바뀐 문서인지, 그 복구본, 보던 채팅 — 은 여기서 문서마다 localStorage 에 둔다. 여러
 * 창이 함께 쓰므로 문서 ID 마다 열쇠를 나눈다. 화면·엔진을 모르는 순수 함수만 둔다.
 */

export const UPDATE_RESTART_KEY_PREFIX = 'rhwp-update-restart-v1:';
/** 메인의 재시작 기록과 같은 유효 시간. 더 오래된 기록은 쓰지 않는다. */
export const UPDATE_RESTART_TTL_MS = 30 * 60_000;

export type UpdateRestartKind =
  /** 깨끗한 파일 문서. 그 파일에서 다시 연다. */
  | 'file'
  /** 바뀐 문서. 복구본을 원래 문서에 dirty 로 얹는다. */
  | 'draft'
  /** 깨끗하지만 파일이 없는 문서(편집하지 않은 새 문서 등). 복구본을 깨끗하게 연다. */
  | 'copy'
  /** 버전 기록의 작업 공간 문서. 작업 공간에서 다시 연다. */
  | 'worktree';

export interface UpdateRestartRecord {
  kind: UpdateRestartKind;
  /** draft·copy 가 여는 복구본. worktree 면 작업 공간에서 다시 연 뒤 지울 자동 저장본. */
  draftId: string | null;
  /** 그 문서에서 보이던 채팅 */
  activeThreadId: string | null;
  /** 검토하지 않은 에이전트 변경 수. 다시 열면 문서 내용이 된다. */
  pendingAgentOps: number;
  /** 파일에 연결된 문서였다. 아니면 원본을 찾지 않고, 연결하지 않고 연 것을 알리지 않는다. */
  hasFile: boolean;
  /** 읽기 전용으로 보던 창(생성 문서 미리보기 등) */
  readOnly: boolean;
  savedAt: number;
}

export type UpdateRestartStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'>;

/** dirty 에는 검토 대기 편집도 넣는다 — 문서 내용에 들어 있고 검토 상태는 재시작을 넘지 못한다. */
export function updateRestartKind(document: {
  managedWorktree: boolean;
  dirty: boolean;
  hasFile: boolean;
}): UpdateRestartKind {
  if (document.managedWorktree) return 'worktree';
  if (document.dirty) return 'draft';
  return document.hasFile ? 'file' : 'copy';
}

/** 지난 기록을 걷고 문서마다 기록을 쓴다. 하나라도 쓰지 못하면 false. */
export function writeUpdateRestartRecords(
  storage: UpdateRestartStorage | null,
  records: ReadonlyMap<string, UpdateRestartRecord>,
  now: number,
): boolean {
  if (!storage) return false;
  try {
    const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index))
      .filter((key): key is string => key?.startsWith(UPDATE_RESTART_KEY_PREFIX) === true);
    for (const key of keys) {
      if (!parseRecord(storage.getItem(key), now)) storage.removeItem(key);
    }
    for (const [documentId, record] of records) {
      storage.setItem(`${UPDATE_RESTART_KEY_PREFIX}${documentId}`, JSON.stringify(record));
    }
    return true;
  } catch {
    return false;
  }
}

/** 문서의 기록을 읽고 곧바로 지운다. 다시 켠 창이 한 번만 쓴다. 없거나 낡았으면 null. */
export function takeUpdateRestartRecord(
  storage: UpdateRestartStorage | null,
  documentId: string,
  now: number,
): UpdateRestartRecord | null {
  if (!storage) return null;
  const key = `${UPDATE_RESTART_KEY_PREFIX}${documentId}`;
  try {
    const raw = storage.getItem(key);
    storage.removeItem(key);
    return parseRecord(raw, now);
  } catch {
    return null;
  }
}

const KINDS: ReadonlySet<unknown> = new Set<UpdateRestartKind>(['file', 'draft', 'copy', 'worktree']);

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function parseRecord(raw: string | null, now: number): UpdateRestartRecord | null {
  if (raw === null) return null;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (!KINDS.has(value.kind) || typeof value.savedAt !== 'number') return null;
    if (now - value.savedAt > UPDATE_RESTART_TTL_MS) return null;
    return {
      kind: value.kind as UpdateRestartKind,
      draftId: stringOrNull(value.draftId),
      activeThreadId: stringOrNull(value.activeThreadId),
      pendingAgentOps: typeof value.pendingAgentOps === 'number' ? Math.max(0, Math.floor(value.pendingAgentOps)) : 0,
      hasFile: value.hasFile === true,
      readOnly: value.readOnly === true,
      savedAt: value.savedAt,
    };
  } catch {
    return null;
  }
}

/**
 * 다시 여는 순서. 작업 공간 문서는 버전 기록이 새 세션을 열어 쓰므로 뒤로 미루고, 보던 문서는 같은 묶음의
 * 끝에 연다 — 마지막에 연 문서가 화면에 남아 다시 붙일 일이 줄고, 병합 화면은 그 문서만 연다.
 */
export function orderUpdateRestore<T extends { active: boolean; kind: UpdateRestartKind }>(entries: readonly T[]): T[] {
  const rank = (entry: T) => (entry.kind === 'worktree' ? 2 : 0) + (entry.active ? 1 : 0);
  return [...entries].sort((a, b) => rank(a) - rank(b));
}
