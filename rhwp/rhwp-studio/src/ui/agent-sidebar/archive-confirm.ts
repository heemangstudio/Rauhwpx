/**
 * 채팅 보관 확인 — "다시 보지 않기"와 "5시간 동안 묻지 않기"를 localStorage 한 칸에 둔다.
 */

const STORAGE_KEY = 'rhwp-archive-confirm';
export const ARCHIVE_CONFIRM_PAUSE_MS = 5 * 60 * 60 * 1000;

export type ArchiveConfirmChoice = 'never' | 'pause';

export interface ArchiveConfirmStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function resolveStorage(storage?: ArchiveConfirmStorage | null): ArchiveConfirmStorage | null {
  if (storage) return storage;
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

/** 보관하기 전에 확인 시트를 띄워야 하는지. */
export function shouldConfirmArchive(now = Date.now(), storage?: ArchiveConfirmStorage | null): boolean {
  const store = resolveStorage(storage);
  if (!store) return true;
  try {
    const saved = JSON.parse(store.getItem(STORAGE_KEY) ?? 'null') as unknown;
    if (!saved || typeof saved !== 'object') return true;
    const record = saved as Record<string, unknown>;
    if (record['never'] === true) return false;
    const until = record['pausedUntil'];
    return !(typeof until === 'number' && Number.isFinite(until) && until > now);
  } catch {
    return true;
  }
}

/** 확인 시트에서 고른 선택지를 저장한다. */
export function saveArchiveConfirmChoice(
  choice: ArchiveConfirmChoice,
  now = Date.now(),
  storage?: ArchiveConfirmStorage | null,
): void {
  const store = resolveStorage(storage);
  if (!store) return;
  const value = choice === 'never' ? { never: true } : { pausedUntil: now + ARCHIVE_CONFIRM_PAUSE_MS };
  try {
    store.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch (err) {
    console.warn('[archive-confirm] localStorage 저장 실패:', err);
  }
}

/** 설정의 "보관 전에 묻기" 스위치. 켜면 일시 중지와 "다시 보지 않기"가 풀린다. */
export function setArchiveConfirmEnabled(enabled: boolean, storage?: ArchiveConfirmStorage | null): void {
  const store = resolveStorage(storage);
  if (!store) return;
  try {
    store.setItem(STORAGE_KEY, JSON.stringify(enabled ? {} : { never: true }));
  } catch (err) {
    console.warn('[archive-confirm] localStorage 저장 실패:', err);
  }
}
