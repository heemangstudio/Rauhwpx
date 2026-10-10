/**
 * 브라우저 글꼴 폴더 연결.
 *
 * 사용자가 고른 글꼴 폴더(한컴 Shared·TTF 폴더, Windows Fonts 사본 등)를 Worker에서 색인해
 * 데스크톱 앱과 같은 매칭·등록 경로(desktop-fonts.ts)의 host로 쓴다.
 *   - Chromium: showDirectoryPicker 핸들을 IndexedDB에 보관한다. 다음 방문에 권한이 'granted'면
 *     조용히 다시 연결하고, 'prompt'면 사용자 클릭 한 번(reconnectFontFolder)으로 다시 연결한다.
 *   - 그 밖의 브라우저: <input webkitdirectory>로 고른 파일을 이번 세션에만 쓴다.
 * 글꼴 바이트는 저장하지 않는다. 파싱 결과만 (상대 경로, 크기, 수정 시각) 단위로 캐시한다.
 */
import { setSystemFontHost, type SystemFontHost, type SystemFontIndex } from './desktop-fonts.ts';
import {
  createFontFolderIndexer,
  type FolderDirectoryHandleLike,
  type FontFolderIndexer,
  type FontFolderInput,
} from './font-folder-index.ts';
import {
  clearStoredFolderHandle,
  indexedDbFontFolderCache,
  loadStoredFolderHandle,
  saveStoredFolderHandle,
} from './font-folder-store.ts';

// ─── Worker 계약 ───────────────────────────────────────────────

type FontFolderWorkerCall =
  | { type: 'index'; input: FontFolderInput; refresh?: boolean }
  | { type: 'read'; faceId: string };

export type FontFolderWorkerRequest = FontFolderWorkerCall & { id: number };

export type FontFolderWorkerResponse =
  | { id: number; ok: true; index?: SystemFontIndex; bytes?: Uint8Array }
  | { id: number; ok: false; error: string };

/** 색인 실행 위치. 기본은 Worker이고, Worker를 쓸 수 없으면 메인 스레드에서 돈다. */
export type FontFolderBackend = FontFolderIndexer;

function workerBackend(): FontFolderBackend | null {
  if (typeof Worker === 'undefined' || typeof window === 'undefined') return null;
  let worker: Worker;
  try {
    worker = new Worker(new URL('./font-folder.worker.ts', import.meta.url), { type: 'module', name: 'rhwp-font-folder' });
  } catch {
    return null;
  }
  let nextId = 0;
  let fallback: FontFolderBackend | null = null;
  const pending = new Map<number, { resolve: (value: FontFolderWorkerResponse) => void; reject: (error: Error) => void }>();
  worker.onmessage = (event: MessageEvent<FontFolderWorkerResponse>) => {
    const entry = pending.get(event.data.id);
    if (!entry) return;
    pending.delete(event.data.id);
    entry.resolve(event.data);
  };
  worker.onerror = (event) => {
    // 모듈을 불러오지 못한 Worker는 메인 스레드 색인으로 바꾼다.
    event.preventDefault?.();
    fallback ??= createFontFolderIndexer({ cache: indexedDbFontFolderCache() });
    for (const entry of pending.values()) entry.reject(new Error('font folder worker failed'));
    pending.clear();
    worker.terminate();
  };
  const call = async (request: FontFolderWorkerCall): Promise<Extract<FontFolderWorkerResponse, { ok: true }>> => {
    const id = ++nextId;
    const response = await new Promise<FontFolderWorkerResponse>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      try {
        worker.postMessage({ ...request, id });
      } catch (error) {
        // 복제할 수 없는 폴더 원본(합성 핸들 등)은 메인 스레드에서 색인한다.
        pending.delete(id);
        fallback ??= createFontFolderIndexer({ cache: indexedDbFontFolderCache() });
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
    if (!response.ok) {
      throw Object.assign(new Error(response.error), /stale/i.test(response.error) ? { code: 'stale' } : {});
    }
    return response;
  };
  // onerror가 비동기로 채우므로 좁혀진 타입 대신 매번 읽는다.
  const recovered = (): FontFolderBackend | null => fallback;
  return {
    async index(input, options = {}) {
      const direct = recovered();
      if (direct) return direct.index(input, options);
      try {
        return (await call({ type: 'index', input, refresh: options.refresh })).index!;
      } catch (error) {
        const retry = recovered();
        if (!retry) throw error;
        return retry.index(input, options);
      }
    },
    async read(id) {
      const direct = recovered();
      if (direct) return direct.read(id);
      return (await call({ type: 'read', faceId: id })).bytes!;
    },
  };
}

// ─── 상태 ─────────────────────────────────────────────────────

export type FontFolderStatus = 'none' | 'connecting' | 'connected' | 'needs-permission' | 'error';

export interface FontFolderState {
  status: FontFolderStatus;
  /** 선택한 폴더 이름 */
  name: string | null;
  /** 다음 방문에도 이어지는 연결인지 (Chromium 폴더 핸들) */
  persistent: boolean;
  faces: number;
  error: string | null;
}

interface PickerWindow {
  showDirectoryPicker?: (options?: { id?: string; mode?: 'read' | 'readwrite' }) => Promise<FolderDirectoryHandleLike>;
}

interface FolderStore {
  load(): Promise<FolderDirectoryHandleLike | null>;
  save(handle: FolderDirectoryHandleLike): Promise<void>;
  clear(): Promise<void>;
}

interface FontFolderConfig {
  backend?: () => FontFolderBackend;
  store?: FolderStore;
}

const defaultStore: FolderStore = {
  load: () => loadStoredFolderHandle<FolderDirectoryHandleLike>(),
  save: (handle) => saveStoredFolderHandle(handle),
  async clear() {
    await clearStoredFolderHandle();
    await indexedDbFontFolderCache().clear();
  },
};

let config: FontFolderConfig = {};
let state: FontFolderState = { status: 'none', name: null, persistent: false, faces: 0, error: null };
let backend: FontFolderBackend | null = null;
let activeHost: SystemFontHost | null = null;
/** 권한을 다시 받아야 하는 저장된 핸들 */
let pendingHandle: FolderDirectoryHandleLike | null = null;
const listeners = new Set<(state: FontFolderState) => void>();

export function configureFontFolder(next: FontFolderConfig): void {
  config = { ...config, ...next };
}

function store(): FolderStore {
  return config.store ?? defaultStore;
}

function getBackend(): FontFolderBackend {
  backend ??= config.backend?.() ?? workerBackend() ?? createFontFolderIndexer({ cache: indexedDbFontFolderCache() });
  return backend;
}

function setState(next: Partial<FontFolderState>): void {
  state = { ...state, ...next };
  for (const listener of listeners) {
    try {
      listener(state);
    } catch (error) {
      console.warn('[FontFolder] 상태 알림 실패:', error);
    }
  }
}

export function getFontFolderState(): FontFolderState {
  return state;
}

export function onFontFolderStateChange(listener: (state: FontFolderState) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function pickerWindow(): PickerWindow | null {
  return typeof window === 'undefined' ? null : window as unknown as PickerWindow;
}

/** 폴더 핸들을 보관해 다음 방문에도 이어 쓸 수 있는지 (Chromium) */
export function canPersistFontFolder(): boolean {
  return typeof pickerWindow()?.showDirectoryPicker === 'function';
}

export function isFontFolderSupported(): boolean {
  if (canPersistFontFolder()) return true;
  return typeof HTMLInputElement !== 'undefined' && 'webkitdirectory' in HTMLInputElement.prototype;
}

// ─── 연결 ─────────────────────────────────────────────────────

function activate(input: FontFolderInput, persistent: boolean): Promise<SystemFontIndex> {
  const name = input.kind === 'handle' ? input.handle.name : input.name;
  const indexer = getBackend();
  let indexed: Promise<SystemFontIndex> | null = null;
  const host: SystemFontHost = {
    kind: 'browser-folder',
    coversSystem: false,
    list(options = {}) {
      if (!indexed || options.refresh) {
        const run = indexer.index(input, { refresh: options.refresh === true });
        indexed = run;
        run.catch(() => {
          if (indexed === run) indexed = null;
        });
      }
      return indexed;
    },
    read: (id) => indexer.read(id),
  };
  activeHost = host;
  pendingHandle = null;
  setSystemFontHost(host);
  setState({ status: 'connecting', name, persistent, faces: 0, error: null });
  const first = host.list();
  first.then(
    (index) => {
      if (activeHost !== host) return;
      setState({ status: 'connected', faces: index.faces.length });
      console.info(`[FontFolder] ${name}: face ${index.faces.length}개 · ${index.durationMs}ms${index.fromCache ? ' (캐시)' : ''}`);
    },
    (error) => {
      if (activeHost !== host) return;
      setState({ status: 'error', error: error instanceof Error ? error.message : String(error) });
    },
  );
  return first;
}

/**
 * 폴더 선택 창을 연다. 사용자 클릭 처리 안에서 다른 await 없이 바로 불러야 한다.
 * 취소하면 null.
 */
export function pickFontFolder(): Promise<FontFolderInput | null> {
  const picker = pickerWindow()?.showDirectoryPicker;
  if (picker) {
    return picker.call(window, { id: 'rhwp-fonts', mode: 'read' }).then(
      (handle) => ({ kind: 'handle' as const, handle }),
      (error: unknown) => {
        if ((error as { name?: string })?.name === 'AbortError') return null;
        throw error;
      },
    );
  }
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    (input as HTMLInputElement & { webkitdirectory: boolean }).webkitdirectory = true;
    input.hidden = true;
    const finish = (value: FontFolderInput | null) => {
      input.remove();
      resolve(value);
    };
    input.addEventListener('change', () => {
      const files = Array.from(input.files ?? []);
      if (!files.length) return finish(null);
      const first = (files[0] as File & { webkitRelativePath?: string }).webkitRelativePath ?? '';
      finish({ kind: 'files', name: first.split('/')[0] || '글꼴 폴더', files });
    }, { once: true });
    input.addEventListener('cancel', () => finish(null), { once: true });
    document.body.appendChild(input);
    input.click();
  });
}

/** 고른 폴더를 연결한다. Chromium 핸들은 다음 방문을 위해 보관한다. */
export async function connectFontFolder(input: FontFolderInput): Promise<SystemFontIndex> {
  let persistent = false;
  if (input.kind === 'handle') {
    try {
      await store().save(input.handle);
      persistent = true;
    } catch (error) {
      console.warn('[FontFolder] 폴더 핸들을 보관하지 못했습니다. 이번 세션에만 연결합니다:', error);
    }
  }
  return activate(input, persistent);
}

/** 폴더를 고르고 연결한다. 클릭 처리 안에서 바로 부른다. 취소하면 null. */
export async function chooseFontFolder(): Promise<SystemFontIndex | null> {
  const input = await pickFontFolder();
  return input ? connectFontFolder(input) : null;
}

/**
 * 저장된 폴더를 다시 연결한다. 권한이 남아 있으면 바로 연결하고, 아니면 'needs-permission'
 * 상태로 두고 사용자 클릭을 기다린다.
 */
export async function restoreFontFolder(): Promise<FontFolderState> {
  if (activeHost || !canPersistFontFolder()) return state;
  let handle: FolderDirectoryHandleLike | null = null;
  try {
    handle = await store().load();
  } catch {
    handle = null;
  }
  if (!handle || activeHost) return state;
  let permission: PermissionState = 'granted';
  try {
    permission = await handle.queryPermission?.({ mode: 'read' }) ?? 'granted';
  } catch {
    permission = 'prompt';
  }
  if (activeHost) return state;
  if (permission === 'granted') {
    void activate({ kind: 'handle', handle }, true).catch(() => {});
    return state;
  }
  pendingHandle = handle;
  setState({ status: 'needs-permission', name: handle.name, persistent: true, faces: 0, error: null });
  return state;
}

/** 'needs-permission' 상태에서 권한을 다시 받는다. 클릭 처리 안에서 바로 부른다. */
export async function reconnectFontFolder(): Promise<SystemFontIndex | null> {
  const handle = pendingHandle;
  if (!handle) return null;
  const permission = await (handle.requestPermission?.({ mode: 'read' }) ?? Promise.resolve<PermissionState>('granted'));
  if (permission !== 'granted') {
    setState({ status: 'needs-permission' });
    return null;
  }
  return activate({ kind: 'handle', handle }, true);
}

/** 연결을 끊고 보관한 핸들과 색인 캐시를 지운다. 이미 올린 글꼴은 이번 세션 동안 남는다. */
export async function disconnectFontFolder(): Promise<void> {
  activeHost = null;
  pendingHandle = null;
  setSystemFontHost(null);
  setState({ status: 'none', name: null, persistent: false, faces: 0, error: null });
  try {
    await store().clear();
  } catch (error) {
    console.warn('[FontFolder] 보관한 폴더 정보를 지우지 못했습니다:', error);
  }
}

/** 테스트 전용 */
export function resetFontFolderForTests(): void {
  config = {};
  state = { status: 'none', name: null, persistent: false, faces: 0, error: null };
  backend = null;
  activeHost = null;
  pendingHandle = null;
  listeners.clear();
  setSystemFontHost(null);
}
