/**
 * 첫 실행 마법사 진행 상태.
 *
 * 설정 탭·문체 보정과 별개인 한 칸. 한 번 끝내거나 건너뛰면
 * 다음 실행부터는 뜨지 않는다. 미리보기는 `?initial-setup=1`.
 * 첫 실행이 문서를 열면서 시작되면 deferred 로 미뤄 두고 사이드바 칩이 이어받는다.
 * public/boot-screen.js 도 completed·deferred 를 읽어 부트 애니메이션을 정한다.
 */
export const INITIAL_SETUP_STORAGE_KEY = 'rhwp-initial-setup';

export type InitialSetupStepState = 'pending' | 'configured' | 'skipped' | 'done';

export interface InitialSetupRecord {
  version: 2;
  completed: boolean;
  completedAt: string | null;
  /** 파일과 함께 처음 켜져 설정을 미뤘다. 칩에서 마치거나 닫으면 completed 가 된다. */
  deferred: boolean;
  themeStep: Exclude<InitialSetupStepState, 'configured'>;
  providerStep: Exclude<InitialSetupStepState, 'done'>;
  fontStep: Exclude<InitialSetupStepState, 'configured'>;
  calibrationStep: Exclude<InitialSetupStepState, 'configured'>;
}

export interface InitialSetupStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function resolveStorage(storage?: InitialSetupStorage | null): InitialSetupStorage | null {
  if (storage) return storage;
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

export function defaultInitialSetup(): InitialSetupRecord {
  return {
    version: 2,
    completed: false,
    completedAt: null,
    deferred: false,
    themeStep: 'pending',
    providerStep: 'pending',
    fontStep: 'pending',
    calibrationStep: 'pending',
  };
}

function asStep<T extends InitialSetupStepState>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

export function normalizeInitialSetup(raw: unknown): InitialSetupRecord {
  const src = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const visualStep = ['pending', 'done', 'skipped'] as const;
  return {
    version: 2,
    completed: src['completed'] === true,
    completedAt: typeof src['completedAt'] === 'string' ? src['completedAt'] : null,
    deferred: src['deferred'] === true,
    themeStep: asStep(src['themeStep'], visualStep, 'pending'),
    providerStep: asStep(src['providerStep'], ['pending', 'configured', 'skipped'] as const, 'pending'),
    fontStep: asStep(src['fontStep'], visualStep, 'pending'),
    calibrationStep: asStep(src['calibrationStep'], visualStep, 'pending'),
  };
}

export function loadInitialSetup(storage?: InitialSetupStorage | null): InitialSetupRecord {
  const store = resolveStorage(storage);
  if (!store) return defaultInitialSetup();
  try {
    const raw = store.getItem(INITIAL_SETUP_STORAGE_KEY);
    if (!raw) return defaultInitialSetup();
    return normalizeInitialSetup(JSON.parse(raw));
  } catch {
    return defaultInitialSetup();
  }
}

export function saveInitialSetup(
  partial: Partial<InitialSetupRecord>,
  storage?: InitialSetupStorage | null,
): InitialSetupRecord {
  const store = resolveStorage(storage);
  const next = normalizeInitialSetup({ ...loadInitialSetup(store), ...partial });
  if (!store) return next;
  try {
    store.setItem(INITIAL_SETUP_STORAGE_KEY, JSON.stringify(next));
  } catch (err) {
    console.warn('[initial-setup] localStorage 저장 실패:', err);
  }
  return next;
}

export function completeInitialSetup(
  partial: Partial<Omit<InitialSetupRecord, 'version' | 'completed' | 'completedAt'>>,
  storage?: InitialSetupStorage | null,
  now = () => new Date().toISOString(),
): InitialSetupRecord {
  return saveInitialSetup({
    ...partial,
    deferred: false,
    completed: true,
    completedAt: now(),
  }, storage);
}

export function isInitialSetupComplete(storage?: InitialSetupStorage | null): boolean {
  return loadInitialSetup(storage).completed === true;
}

/** `?initial-setup=1` (또는 값 없는 플래그) 이면 끝난 뒤에도 다시 연다. */
export function shouldForceInitialSetup(search?: string): boolean {
  const raw = search ?? (typeof location !== 'undefined' ? location.search : '');
  try {
    const params = new URLSearchParams(raw.startsWith('?') ? raw.slice(1) : raw);
    if (!params.has('initial-setup')) return false;
    const value = params.get('initial-setup');
    return value === null || value === '' || value === '1' || value === 'true';
  } catch {
    return false;
  }
}

/** 자동화된 브라우저·임베드 프레임에서는 편집 화면을 가리지 않는다. */
export function shouldSuppressInitialSetup(): boolean {
  try {
    if (typeof navigator !== 'undefined' && navigator.webdriver === true) return true;
  } catch {
    // 접근 불가면 아래 프레임 검사로 넘어간다.
  }
  try {
    return typeof window !== 'undefined' && window.parent !== window;
  } catch {
    return true;
  }
}

export function shouldShowInitialSetup(storage?: InitialSetupStorage | null, search?: string): boolean {
  if (shouldForceInitialSetup(search)) return true;
  if (shouldSuppressInitialSetup()) return false;
  const record = loadInitialSetup(storage);
  return !record.completed && !record.deferred;
}

/** 미뤄 둔 설정을 사이드바 칩으로 권할지. */
export function isInitialSetupDeferred(storage?: InitialSetupStorage | null): boolean {
  const record = loadInitialSetup(storage);
  return record.deferred && !record.completed;
}
