/**
 * 백그라운드 채팅 알림 설정 — 설정 → AI 의 '백그라운드 채팅 알림' 한 칸.
 * localStorage 한 칸에 JSON 으로 살고, 다른 창의 변경은 storage 이벤트로 따라간다.
 * 기본은 켜짐이다. 꺼도 레일 점과 확인 필요 칩·숫자는 그대로다.
 */

const STORAGE_KEY = 'rhwp-agent-attention';

export interface AttentionPrefs {
  /** 알림·토스트·앱 아이콘 배지 */
  notifications: boolean;
}

/** localStorage 최소 계약 — 테스트가 자기 저장소를 넣을 수 있게 뺐다. */
export interface AttentionPrefsStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const listeners = new Set<(prefs: AttentionPrefs) => void>();
let storageListening = false;

function resolveStorage(storage?: AttentionPrefsStorage | null): AttentionPrefsStorage | null {
  if (storage) return storage;
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

export function defaultAttentionPrefs(): AttentionPrefs {
  return { notifications: true };
}

function parse(raw: string | null): AttentionPrefs {
  const prefs = defaultAttentionPrefs();
  if (!raw) return prefs;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && typeof (parsed as Record<string, unknown>).notifications === 'boolean') {
      prefs.notifications = (parsed as { notifications: boolean }).notifications;
    }
  } catch {
    /* 깨진 값은 기본값으로 읽는다 */
  }
  return prefs;
}

export function loadAttentionPrefs(storage?: AttentionPrefsStorage | null): AttentionPrefs {
  const store = resolveStorage(storage);
  try {
    return parse(store?.getItem(STORAGE_KEY) ?? null);
  } catch {
    return defaultAttentionPrefs();
  }
}

function emit(prefs: AttentionPrefs): void {
  for (const listener of [...listeners]) listener({ ...prefs });
}

export function saveAttentionPrefs(
  partial: Partial<AttentionPrefs>,
  storage?: AttentionPrefsStorage | null,
): AttentionPrefs {
  const next = { ...loadAttentionPrefs(storage), ...partial };
  try {
    resolveStorage(storage)?.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* 저장하지 못해도 이 창에서는 바로 적용한다 */
  }
  emit(next);
  return next;
}

/** 이 창과 다른 창의 변경을 듣는다. */
export function subscribeAttentionPrefs(listener: (prefs: AttentionPrefs) => void): () => void {
  listeners.add(listener);
  if (!storageListening && typeof window !== 'undefined') {
    storageListening = true;
    window.addEventListener('storage', (event) => {
      if (event.key === STORAGE_KEY) emit(parse(event.newValue));
    });
  }
  return () => { listeners.delete(listener); };
}
