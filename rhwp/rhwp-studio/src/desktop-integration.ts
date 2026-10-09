/**
 * 로컬 에이전트 허브 기동.
 *
 * Electron 은 preload IPC 로 메인 프로세스가 허브를 띄운다.
 * Vite 개발 서버는 `/__rhwp/ensure-agent-hub` 가 같은 일을 한다.
 * 패키지된 PWA/브라우저는 Node 를 띄울 수 없어 no-op 이다.
 */

import type { SystemFontIndex } from './core/desktop-fonts.ts';
import type {
  FileSystemFileHandleLike,
  FileSystemWritableFileStreamLike,
  SaveFilePickerOptionsLike,
} from './command/file-system-access.ts';
import { FALLBACK_DOCUMENT_FILE_NAME } from './core/document-names.ts';
import {
  EXACT_LOCAL_DOCUMENT_MAX_BYTES,
  MIB,
  PORTABLE_HISTORY_MAX_BYTES,
  cancelResponseBody,
  readBlobBytesWithLimit,
} from './core/document-input-limits.ts';

export const DEV_AGENT_HUB_ENSURE_PATH = '/__rhwp/ensure-agent-hub';
export const DEV_AGENT_HUB_RELEASE_PATH = '/__rhwp/release-agent-hub-session';

export interface RendererSessionContext {
  launchId: string;
  sessionId: string;
  hubUrl: string;
  hubToken: string;
  referenceToken: string;
  templateToken: string;
}

/**
 * 백그라운드 문서의 에이전트가 쓰는 추가 허브 세션. 창 세션과 따로 등록되고,
 * 문서를 닫을 때 release 로 허브에서 닫아야 provider 프로세스가 끝난다.
 */
export interface AgentHubSessionLease {
  sessionId: string;
  /** 허브에 (재)등록하고 브리지가 쓸 문맥을 돌려준다. 실패하거나 해제됐으면 null. */
  resolveContext(): Promise<RendererSessionContext | null>;
  /** 여러 번 불러도 한 번만 닫는다. 실패해도 던지지 않는다. */
  release(): Promise<void>;
}

export interface NativeFileHandleDescriptor {
  kind: 'file';
  handleId: string;
  name: string;
  saveTargetCreated?: boolean;
  verifiedDocumentId?: string;
  legacyPortableHistoryFolder?: true;
}

export interface DocumentOwnershipIdentity {
  documentId: string;
  sourceDigest: string | null;
  useSourceDigest?: boolean;
}

interface NativeFileReadResult {
  name: string;
  bytes: Uint8Array;
}

export interface RhwpDesktopApi {
  ensureAgentHub?: () => Promise<{ started?: boolean; ready?: boolean } | boolean>;
  getSessionContext?: () => Promise<RendererSessionContext>;
  createAgentSession?: () => Promise<{ sessionId: string }>;
  getAgentSessionContext?: (sessionId: string) => Promise<RendererSessionContext>;
  releaseAgentSession?: (sessionId: string) => Promise<boolean>;
  getUniqueInstalls?: () => Promise<{
    uniqueInstalls: number | null;
    publicUrl?: string | null;
    recorded?: boolean;
  } | null>;
  getLaunchFiles?: () => Promise<NativeFileHandleDescriptor[]>;
  getLaunchGeneratedDocument?: () => Promise<{
    launchDocumentId: string;
    fileName: string;
    bytes: Uint8Array;
    readOnly?: boolean;
  } | null>;
  openGeneratedDocumentWindow?: (payload: {
    fileName: string;
    downloadUrl: string;
    readOnly?: boolean;
  }) => Promise<boolean>;
  pickNativeOpenFile?: (options?: {
    suggestedName?: string;
    documentId?: string;
  }) => Promise<NativeFileHandleDescriptor | { owned: true } | null>;
  pickLegacyHistoryFolder?: () => Promise<NativeFileHandleDescriptor | { owned: true } | null>;
  claimNativeDroppedFile?: (
    file: File,
  ) => Promise<NativeFileHandleDescriptor | { owned: true } | null> | null;
  pickNativeSaveFile?: (options: {
    suggestedName: string;
    extension: 'hwp' | 'hwpx' | 'hml' | 'rhwpx';
  }) => Promise<NativeFileHandleDescriptor | { owned: true } | null>;
  releaseNativeFile?: (handleId: string) => Promise<void>;
  renameNativeFile?: (
    handleId: string,
    nextName: string,
  ) => Promise<{ ok: true; descriptor: NativeFileHandleDescriptor } | { ok: false; reason: string }>;
  readNativeFile?: (handleId: string) => Promise<NativeFileReadResult>;
  getNativeFileSourcePath?: (handleId: string) => Promise<string | null>;
  validateNativeSave?: (
    handleId: string,
    identity: DocumentOwnershipIdentity,
  ) => Promise<void>;
  writeNativeFile?: (
    handleId: string,
    bytes: Uint8Array,
    identity: DocumentOwnershipIdentity,
  ) => Promise<{ name: string; byteLength: number }>;
  /** 한쪽 핸들을 이미 놓았으면 null (비교할 수 없음) */
  isSameNativeFile?: (firstHandleId: string, secondHandleId: string) => Promise<boolean | null>;
  adoptNativeFileContent?: (handleId: string, digest: string) => Promise<boolean>;
  rememberNativeDocument?: (
    documentId: string,
    handleId: string,
    digest?: string | null,
  ) => Promise<void>;
  reopenNativeDocument?: (
    documentId: string,
  ) => Promise<NativeFileHandleDescriptor | { owned: true } | null>;
  searchNearbyNativeDocument?: (
    documentId: string,
    options?: { basenameHint?: string },
  ) => Promise<ReadonlyArray<{ probeId: string; fileName: string }>>;
  readNativeProbe?: (probeId: string) => Promise<NativeFileReadResult>;
  claimNativeProbe?: (
    probeId: string,
  ) => Promise<NativeFileHandleDescriptor | { owned: true } | null>;
  verifyNativePick?: (documentId: string, handleId: string) => Promise<boolean>;
  /** slotId 를 생략하면 창의 기본 문서 자리다. 한 창이 문서마다 다른 자리를 쓴다. */
  reserveDocument?: (
    identity: DocumentOwnershipIdentity,
    nativeHandleId?: string,
    slotId?: string,
  ) => Promise<{ ok: true; reservationId: string } | { ok: false; reason: 'owned' }>;
  commitDocument?: (reservationId: string, slotId?: string) => Promise<void>;
  cancelDocument?: (reservationId: string, slotId?: string) => Promise<void>;
  releaseDocument?: (slotId?: string) => Promise<void>;
  respondToCloseRequest?: (requestId: string, allowClose: boolean) => Promise<boolean>;
  onCloseRequested?: (callback: (request: {
    requestId: string;
    reason: 'close' | 'quit';
  }) => void) => void;
  platform?: string;
  isFullScreen?: () => Promise<boolean>;
  /** 네이티브 인쇄 대화상자를 호출 창의 내용으로 연다 (Electron 데스크톱 전용). */
  printCurrentWindow?: () => Promise<void>;
  /** PDF 저장 위치를 고른다. 경로 대신 한 번 쓰는 토큰을 돌려준다. */
  pickPdfExportPath?: (options: { suggestedName: string }) => Promise<{ token: string; fileName: string } | null>;
  /** 호출 창(숨은 PDF surface)의 내용을 토큰의 위치에 PDF 로 저장한다. */
  exportPdf?: (token: string) => Promise<{ exportId: string; fileName: string; byteLength: number }>;
  /** 내보낸 PDF 를 Finder/탐색기에서 보여준다. */
  revealPdfExport?: (exportId: string) => Promise<void>;
  onFullScreenChange?: (callback: (fullscreen: boolean) => void) => void;
  onOpenFiles?: (callback: (files: NativeFileHandleDescriptor[]) => void) => void;
  onOpenGeneratedDocument?: (callback: (payload: {
    launchDocumentId: string;
    fileName: string;
    bytes: Uint8Array;
    readOnly?: boolean;
  }) => void) => void;
  onEditCommand?: (callback: (command: string) => void) => void;
  onPastePlainText?: (callback: (text: string) => void) => void;
  /** 시스템·사용자·한컴 오피스 글꼴 색인. 권한 요청 없이 이미 설치된 글꼴만 다룬다. */
  listSystemFonts?: (options?: { refresh?: boolean }) => Promise<SystemFontIndex>;
  /** face 주소의 앞부분. TTC face는 단독 SFNT로 추출되고, 파일이 바뀌었으면 409로 응답한다. */
  systemFontBaseUrl?: () => Promise<string>;
  /** macOS 프록시 아이콘과 미저장 점. 경로는 메인이 핸들로 찾는다. */
  setDocumentState?: (state: { edited: boolean }) => void;
  notifyAgentTurnFinished?: (payload: { title: string; body: string }) => void;
  setPendingReviewCount?: (count: number) => void;
  showContextMenu?: (items: NativeContextMenuItem[]) => Promise<string | null>;
  /** 저장 확인을 창에 붙은 네이티브 시트로 묻는다. */
  showUnsavedChangesSheet?: (payload: { fileName: string }) => Promise<'save' | 'discard' | 'cancel'>;
}

export type NativeContextMenuItem =
  | { id: string; label: string; enabled?: boolean; checked?: boolean; danger?: boolean }
  | { type: 'separator' };

export interface DesktopHost {
  rhwpDesktop?: RhwpDesktopApi;
  navigator?: {
    serviceWorker?: {
      getRegistrations: () => Promise<ReadonlyArray<{ unregister: () => Promise<boolean> }>>;
      addEventListener: (type: string, listener: () => void) => void;
    };
  };
}

export interface PublishedDocumentLink {
  readonly downloadUrl: string;
  readonly fileName: string;
  readonly readOnly?: boolean;
}

/** Only hub-issued localhost artifact URLs become in-app document actions. */
export function parsePublishedDocumentLink(raw: string): PublishedDocumentLink | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost' && url.hostname !== '[::1]') return null;
  const match = url.pathname.match(/^\/artifacts\/[A-Za-z0-9_-]{16,128}\/([^/]+)$/u);
  if (!match) return null;
  let fileName;
  try {
    fileName = decodeURIComponent(match[1]);
  } catch {
    return null;
  }
  if (!/\.(?:hwp|hwpx)$/iu.test(fileName) || fileName.includes('\0')) return null;
  return {
    downloadUrl: url.href,
    fileName,
    ...(url.searchParams.get('templatePreview') === '1' ? { readOnly: true } : {}),
  };
}

export async function openPublishedDocumentInNewWindow(
  artifact: PublishedDocumentLink,
  win?: DesktopHost,
  options: { readOnly?: boolean } = {},
): Promise<void> {
  const host = desktopHost(win);
  const openNative = host?.rhwpDesktop?.openGeneratedDocumentWindow;
  if (openNative) {
    if (!await openNative({
      fileName: artifact.fileName,
      downloadUrl: artifact.downloadUrl,
      ...(options.readOnly ? { readOnly: true } : {}),
    })) {
      throw new Error('새 문서 창을 열지 못했습니다.');
    }
    return;
  }

  const browserWindow = (win ?? globalThis) as DesktopHost & {
    location?: { href: string };
    open?: (url?: string | URL, target?: string, features?: string) => unknown;
  };
  if (!browserWindow.location?.href || !browserWindow.open) {
    throw new Error('새 문서 창을 열 수 없습니다.');
  }
  const editorUrl = new URL(browserWindow.location.href);
  editorUrl.search = '';
  editorUrl.hash = '';
  editorUrl.searchParams.set('url', artifact.downloadUrl);
  editorUrl.searchParams.set('filename', artifact.fileName);
  if (options.readOnly) editorUrl.searchParams.set('templatePreview', '1');
  browserWindow.open(editorUrl.href, '_blank', 'noopener');
}

let inflight: Promise<boolean> | null = null;
let sessionContextInflight: Promise<RendererSessionContext | null> | null = null;
type DevHubContext = Pick<
  RendererSessionContext,
  'launchId' | 'hubUrl' | 'hubToken' | 'referenceToken' | 'templateToken'
>;
let devHubContext: DevHubContext | null = null;
const nativeHandleMetadata = new WeakMap<FileSystemFileHandleLike, {
  api: RhwpDesktopApi;
  handleId: string;
  identity: DocumentOwnershipIdentity | null;
  readonly verifiedDocumentId: string | null;
  readonly legacyPortableHistoryFolder: boolean;
}>();
const browserLaunchId = createSessionId('launch');
const BROWSER_SESSION_ID_KEY = 'rhwp-renderer-session-id-v1';

/** A browser tab must reclaim the same hub session after reload. sessionStorage
 * is tab-scoped, survives reload, and does not make unrelated tabs contend for
 * the same root interaction. Electron remains authoritative through preload. */
export function stableBrowserSessionId(
  storage: Pick<Storage, 'getItem' | 'setItem'> | undefined = globalThis.sessionStorage,
): string {
  try {
    const existing = storage?.getItem(BROWSER_SESSION_ID_KEY) ?? '';
    if (/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(existing)) return existing;
  } catch {}
  const created = createSessionId('session');
  try { storage?.setItem(BROWSER_SESSION_ID_KEY, created); } catch {}
  return created;
}

const browserSessionId = stableBrowserSessionId();

function createSessionId(prefix: string): string {
  return globalThis.crypto?.randomUUID?.() ?? `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function validSessionContext(value: unknown): value is RendererSessionContext {
  if (!value || typeof value !== 'object') return false;
  const context = value as Record<string, unknown>;
  return ['launchId', 'sessionId', 'hubUrl', 'hubToken', 'referenceToken', 'templateToken']
    .every((key) => typeof context[key] === 'string' && context[key].length > 0);
}

function desktopHost(win?: DesktopHost): DesktopHost | undefined {
  return win ?? (typeof globalThis !== 'undefined' ? (globalThis as DesktopHost) : undefined);
}

function isDevBuild(): boolean {
  return Boolean((import.meta as ImportMeta & { env?: { DEV?: boolean } }).env?.DEV);
}

export function isDesktopApp(win?: DesktopHost): boolean {
  const api = desktopHost(win)?.rhwpDesktop;
  if (typeof api?.ensureAgentHub === 'function' || typeof api?.getSessionContext === 'function') return true;
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  return /Electron/i.test(ua);
}

/** Vite 개발 서버에 허브 기동과 sessionId 등록을 요청한다. */
async function ensureDevHubSession(
  sessionId: string,
  fetchImpl: typeof fetch,
): Promise<{ ready: boolean; context: DevHubContext | null }> {
  if (typeof fetchImpl !== 'function') return { ready: false, context: null };
  try {
    const path = `${DEV_AGENT_HUB_ENSURE_PATH}?sessionId=${encodeURIComponent(sessionId)}`;
    const response = await fetchImpl(path, { method: 'POST' });
    if (!response.ok) {
      await cancelResponseBody(response, `HTTP ${response.status}`);
      return { ready: false, context: null };
    }
    const body = await response.json();
    const context = (
      body?.ready === true
      && typeof body.launchId === 'string'
      && typeof body.hubUrl === 'string'
      && typeof body.hubToken === 'string'
      && typeof body.referenceToken === 'string'
      && typeof body.templateToken === 'string'
    ) ? {
        launchId: body.launchId,
        hubUrl: body.hubUrl,
        hubToken: body.hubToken,
        referenceToken: body.referenceToken,
        templateToken: body.templateToken,
      } : null;
    return { ready: body?.ready === true, context };
  } catch (error) {
    console.warn('[rhwp-desktop] 개발 서버 허브 기동 실패:', error);
    return { ready: false, context: null };
  }
}

export async function requestDevAgentHub(
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<boolean> {
  const result = await ensureDevHubSession(browserSessionId, fetchImpl);
  if (result.context) devHubContext = result.context;
  return result.ready;
}

function devHubReleaseRequest(
  sessionId: string,
  fetchImpl: typeof fetch,
  init: RequestInit = {},
): Promise<Response> {
  const path = `${DEV_AGENT_HUB_RELEASE_PATH}?sessionId=${encodeURIComponent(sessionId)}`;
  return fetchImpl(path, { ...init, method: 'POST' });
}

// 새로고침·탭 닫기로 페이지가 사라지면 그 페이지의 추가 세션은 다시 찾을 수 없다.
// 남겨 두면 provider 프로세스가 허브가 끝날 때까지 살아 있으므로 pagehide 에서 닫는다.
const liveDevAgentSessions = new Map<string, typeof fetch>();
let devPagehideInstalled = false;

function trackDevAgentSession(sessionId: string, fetchImpl: typeof fetch) {
  liveDevAgentSessions.set(sessionId, fetchImpl);
  if (devPagehideInstalled || typeof globalThis.addEventListener !== 'function') return;
  devPagehideInstalled = true;
  globalThis.addEventListener('pagehide', (event) => {
    // bfcache 로 돌아올 수 있는 페이지는 세션을 그대로 둔다.
    if ((event as PageTransitionEvent).persisted) return;
    for (const [sessionId, fetchImpl] of liveDevAgentSessions) {
      void devHubReleaseRequest(sessionId, fetchImpl, { keepalive: true }).catch(() => {});
    }
    liveDevAgentSessions.clear();
  });
}

function onceAsync(run: () => Promise<void>): () => Promise<void> {
  let pending: Promise<void> | null = null;
  return () => {
    pending ??= run();
    return pending;
  };
}

/**
 * 창 세션과 별개인 허브 세션을 하나 만든다. 문서마다 에이전트를 따로 돌릴 때 쓴다.
 * Electron 은 메인 프로세스가 이 창 소유로 등록하고, 창이 닫히거나 렌더러가 죽거나
 * 새로고침되면 함께 닫는다. Vite 개발 서버는 같은 출처 라우트로 등록·해제한다.
 * 허브를 등록할 수 없는 환경(일반 웹 빌드, 이전 preload)에서는 null 이다.
 */
/** 이 환경에서 허브 세션을 더 받을 수 있는지 (데스크톱 앱, 또는 개발 서버). */
export function supportsExtraAgentHubSessions(win?: DesktopHost): boolean {
  const host = desktopHost(win);
  if (isDesktopApp(host)) {
    const api = host?.rhwpDesktop;
    return Boolean(api?.createAgentSession && api.getAgentSessionContext && api.releaseAgentSession);
  }
  return isDevBuild() && typeof globalThis.fetch === 'function';
}

export async function createAgentHubSession(
  win?: DesktopHost,
  { fetchImpl = globalThis.fetch, dev = isDevBuild() }: {
    fetchImpl?: typeof fetch;
    dev?: boolean;
  } = {},
): Promise<AgentHubSessionLease | null> {
  const host = desktopHost(win);
  if (isDesktopApp(host)) {
    const api = host?.rhwpDesktop;
    if (!api?.createAgentSession || !api.getAgentSessionContext || !api.releaseAgentSession) {
      return null;
    }
    let sessionId: string;
    try {
      const created = await api.createAgentSession();
      if (typeof created?.sessionId !== 'string' || !created.sessionId) {
        throw new Error('Desktop returned an invalid agent session');
      }
      sessionId = created.sessionId;
    } catch (error) {
      console.warn('[rhwp-desktop] 추가 에이전트 세션 생성 실패:', error);
      return null;
    }
    let released = false;
    return {
      sessionId,
      async resolveContext() {
        if (released) return null;
        try {
          const context = await api.getAgentSessionContext!(sessionId);
          if (!validSessionContext(context) || context.sessionId !== sessionId) {
            console.warn('[rhwp-desktop] 추가 에이전트 세션 구성이 올바르지 않습니다.');
            return null;
          }
          return released ? null : context;
        } catch (error) {
          if (!released) console.warn('[rhwp-desktop] 추가 에이전트 세션 구성 조회 실패:', error);
          return null;
        }
      },
      release: onceAsync(async () => {
        released = true;
        await api.releaseAgentSession!(sessionId).then(
          () => {},
          (error) => console.warn('[rhwp-desktop] 추가 에이전트 세션 해제 실패:', error),
        );
      }),
    };
  }

  if (!dev || typeof fetchImpl !== 'function') return null;
  const sessionId = createSessionId('session');
  let released = false;
  const release = onceAsync(async () => {
    released = true;
    liveDevAgentSessions.delete(sessionId);
    try {
      const response = await devHubReleaseRequest(sessionId, fetchImpl);
      await cancelResponseBody(response, 'released');
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
    } catch (error) {
      console.warn('[rhwp-desktop] 개발 서버 추가 세션 해제 실패:', error);
    }
  });
  trackDevAgentSession(sessionId, fetchImpl);
  return {
    sessionId,
    async resolveContext() {
      if (released) return null;
      const { context } = await ensureDevHubSession(sessionId, fetchImpl);
      if (released) {
        // 해제와 엇갈린 등록이 세션을 되살렸으면 다시 닫는다.
        void devHubReleaseRequest(sessionId, fetchImpl)
          .then((response) => cancelResponseBody(response, 'released'))
          .catch(() => {});
        return null;
      }
      return context ? { ...context, sessionId } : null;
    },
    release,
  };
}

function readEnsureResult(result: { ready?: boolean } | boolean | undefined): boolean {
  if (result && typeof result === 'object') return result.ready !== false;
  return Boolean(result);
}

export function websocketHubUrl(hubUrl: string) {
  const url = new URL(hubUrl);
  if (url.protocol === 'http:') url.protocol = 'ws:';
  else if (url.protocol === 'https:') url.protocol = 'wss:';
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    throw new Error(`Unsupported agent hub protocol: ${url.protocol}`);
  }
  url.pathname = url.pathname.replace(/\/$/, '');
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

export function httpHubUrl(hubUrl: string) {
  const url = new URL(hubUrl);
  if (url.protocol === 'ws:') url.protocol = 'http:';
  else if (url.protocol === 'wss:') url.protocol = 'https:';
  return url.toString().replace(/\/$/, '');
}

export interface BrowserSessionContextOptions {
  hubUrl?: string;
  hubToken?: string;
  referenceToken?: string;
  templateToken?: string;
  launchId?: string;
  sessionId?: string;
}

/**
 * Electron configuration is authoritative and must come from preload. Browser and
 * Vite runs keep their explicit environment/dev fallback.
 */
export async function resolveRendererSessionContext(
  win?: DesktopHost,
  browser: BrowserSessionContextOptions = {},
): Promise<RendererSessionContext | null> {
  const host = desktopHost(win);
  if (isDesktopApp(host)) {
    const getSessionContext = host?.rhwpDesktop?.getSessionContext;
    if (typeof getSessionContext !== 'function') {
      console.warn('[rhwp-desktop] preload 세션 구성이 없습니다.');
      return null;
    }
    try {
      const context = await getSessionContext();
      if (!validSessionContext(context)) {
        console.warn('[rhwp-desktop] preload 세션 구성이 올바르지 않습니다.');
        return null;
      }
      return context;
    } catch (error) {
      console.warn('[rhwp-desktop] preload 세션 구성 조회 실패:', error);
      return null;
    }
  }

  const env = (import.meta as ImportMeta & { env?: ImportMetaEnv }).env;
  if (isDevBuild() && !browser.hubUrl) await requestDevAgentHub();
  const hubToken = browser.hubToken ?? devHubContext?.hubToken ?? env?.VITE_RHWP_AGENT_TOKEN ?? 'dev';
  return {
    launchId: browser.launchId ?? devHubContext?.launchId ?? browserLaunchId,
    sessionId: browser.sessionId ?? browserSessionId,
    hubUrl: browser.hubUrl ?? devHubContext?.hubUrl ?? env?.VITE_RHWP_AGENT_URL ?? 'ws://127.0.0.1:5175',
    hubToken,
    referenceToken: browser.referenceToken ?? devHubContext?.referenceToken ?? hubToken,
    templateToken: browser.templateToken ?? devHubContext?.templateToken ?? hubToken,
  };
}

/** 같은 renderer 안의 autosave와 AgentBridge가 동일한 window session을 공유한다. */
export function getRendererSessionContext(): Promise<RendererSessionContext | null> {
  if (!sessionContextInflight) {
    sessionContextInflight = resolveRendererSessionContext();
  }
  return sessionContextInflight;
}

export function installDesktopCloseHandling(
  onCloseRequest: (reason: 'close' | 'quit') => Promise<boolean>,
  win?: DesktopHost,
) {
  const api = desktopHost(win)?.rhwpDesktop;
  if (!api?.onCloseRequested || !api.respondToCloseRequest) return false;
  api.onCloseRequested((request) => {
    void onCloseRequest(request.reason).then(
      (allowClose) => api.respondToCloseRequest!(request.requestId, allowClose),
      () => api.respondToCloseRequest!(request.requestId, false),
    );
  });
  return true;
}

export async function ensureDesktopAgentHub(win?: DesktopHost): Promise<boolean> {
  if (inflight) return inflight;
  const ensure = desktopHost(win)?.rhwpDesktop?.ensureAgentHub;
  const run = (async () => {
    try {
      if (typeof ensure === 'function') return readEnsureResult(await ensure());
      if (isDevBuild()) return requestDevAgentHub();
      return false;
    } catch (error) {
      console.warn('[rhwp-desktop] 허브 기동 요청 실패:', error);
      return false;
    }
  })();
  inflight = run;
  void run.finally(() => {
    if (inflight === run) inflight = null;
  });
  return run;
}

function validNativeDescriptor(value: unknown): value is NativeFileHandleDescriptor {
  if (!value || typeof value !== 'object') return false;
  const descriptor = value as Record<string, unknown>;
  return descriptor.kind === 'file'
    && typeof descriptor.handleId === 'string'
    && descriptor.handleId.length > 0
    && typeof descriptor.name === 'string'
    && descriptor.name.length > 0
    && (
      descriptor.legacyPortableHistoryFolder === undefined
      || descriptor.legacyPortableHistoryFolder === true
    )
    && (
      descriptor.verifiedDocumentId === undefined
      || (
        typeof descriptor.verifiedDocumentId === 'string'
        && descriptor.verifiedDocumentId.length > 0
        && descriptor.verifiedDocumentId === descriptor.verifiedDocumentId.trim()
        && !descriptor.verifiedDocumentId.includes('\0')
      )
    );
}

function checkedNativeFileReadResult(value: unknown): NativeFileReadResult {
  if (!value || typeof value !== 'object') throw new Error('Native file read returned an invalid result');
  // 이미 놓은 핸들(닫은 문서·지난 실행의 최근 문서). 호출부는 기억해 둔 위치로 다시 연다.
  if ((value as { stale?: unknown }).stale === true) {
    throw new DOMException('파일을 더 이상 이 핸들로 읽을 수 없습니다.', 'NotFoundError');
  }
  const result = value as Partial<NativeFileReadResult>;
  if (
    typeof result.name !== 'string'
    || !result.name
    || !(result.bytes instanceof Uint8Array)
    || result.bytes.byteLength > nativeFileMaxBytes(result.name)
  ) throw new Error('Native file read returned invalid or oversized data');
  return { name: result.name, bytes: result.bytes };
}

function nativeFileMaxBytes(fileName: string): number {
  return fileName.toLowerCase().endsWith('.rhwpx')
    ? PORTABLE_HISTORY_MAX_BYTES
    : EXACT_LOCAL_DOCUMENT_MAX_BYTES;
}

function nativeWriteSizeError(maxBytes: number): Error {
  return new Error(`저장 파일 크기는 ${Math.floor(maxBytes / MIB)} MiB를 초과할 수 없습니다.`);
}

export function createNativeFileHandle(
  descriptor: NativeFileHandleDescriptor,
  api: RhwpDesktopApi,
  { saveTarget = false } = {},
): FileSystemFileHandleLike {
  if (!validNativeDescriptor(descriptor) || !api.readNativeFile || !api.writeNativeFile) {
    throw new Error('Invalid native file handle descriptor');
  }

  const maxBytes = nativeFileMaxBytes(descriptor.name);
  let unusedSaveTarget = saveTarget;
  const handle: FileSystemFileHandleLike = {
    kind: 'file',
    name: descriptor.name,
    identityKind: 'native-path',
    async getFile() {
      const result = checkedNativeFileReadResult(await api.readNativeFile!(descriptor.handleId));
      return new File([result.bytes as BlobPart], result.name);
    },
    async releaseUnusedSaveTarget() {
      if (!unusedSaveTarget || !api.releaseNativeFile) return;
      unusedSaveTarget = false;
      await api.releaseNativeFile(descriptor.handleId);
    },
    adoptSaveTarget() {
      unusedSaveTarget = false;
    },
    async validateSaveTarget() {
      const metadata = nativeHandleMetadata.get(handle);
      if (!metadata?.identity) throw new Error('Native save target has no active document ownership');
      if (!api.validateNativeSave) throw new Error('Native save ownership validation is unavailable');
      await api.validateNativeSave(descriptor.handleId, metadata.identity);
    },
    async createWritable(): Promise<FileSystemWritableFileStreamLike> {
      const chunks: Blob[] = [];
      let totalBytes = 0;
      let closed = false;
      let closePromise: Promise<void> | null = null;
      return {
        async write(data) {
          if (closed) throw new Error('Native file stream is closed');
          if (
            !data
            || !Number.isSafeInteger(data.size)
            || data.size < 0
            || data.size > maxBytes - totalBytes
          ) {
            closed = true;
            chunks.length = 0;
            totalBytes = 0;
            throw nativeWriteSizeError(maxBytes);
          }
          chunks.push(data);
          totalBytes += data.size;
        },
        close() {
          if (closePromise) return closePromise;
          if (closed) return Promise.resolve();
          const metadata = nativeHandleMetadata.get(handle);
          if (!metadata?.identity) {
            return Promise.reject(new Error('Native save target has no active document ownership'));
          }
          const identity = metadata.identity;
          closed = true;
          const payload = chunks.length === 1 ? chunks[0]! : new Blob(chunks);
          chunks.length = 0;
          closePromise = (async () => {
            const bytes = await readBlobBytesWithLimit(
              payload,
              maxBytes,
              '저장 파일',
            );
            if (bytes.byteLength !== totalBytes) {
              throw new Error('저장 파일을 읽는 동안 크기가 변경되었습니다.');
            }
            totalBytes = 0;
            await api.writeNativeFile!(descriptor.handleId, bytes, identity);
          })();
          return closePromise;
        },
        async abort() {
          closed = true;
          chunks.length = 0;
          totalBytes = 0;
        },
      };
    },
    async isSameEntry(other) {
      if (other === handle) return true;
      const otherMetadata = nativeHandleMetadata.get(other);
      if (!otherMetadata || otherMetadata.api !== api || !api.isSameNativeFile) {
        throw new DOMException('Handle kinds cannot be compared', 'NotSupportedError');
      }
      const same = await api.isSameNativeFile(descriptor.handleId, otherMetadata.handleId);
      // 놓은 핸들은 "다른 파일"이 아니라 "비교할 수 없음"이다. 호출부는 다른 근거로 판단한다.
      if (same === null) throw new DOMException('비교할 파일 핸들이 더 이상 없습니다.', 'NotFoundError');
      return same;
    },
    async queryPermission() {
      return 'granted';
    },
    async requestPermission() {
      return 'granted';
    },
  };
  nativeHandleMetadata.set(handle, {
    api,
    handleId: descriptor.handleId,
    identity: null,
    verifiedDocumentId: descriptor.verifiedDocumentId ?? null,
    legacyPortableHistoryFolder: descriptor.legacyPortableHistoryFolder === true,
  });
  return handle;
}

/** Main-issued identity derived from the exact canonical path bookmark. */
export function getNativeFileHandleVerifiedDocumentId(
  handle: FileSystemFileHandleLike | null | undefined,
): string | null {
  return handle ? nativeHandleMetadata.get(handle)?.verifiedDocumentId ?? null : null;
}

/** Legacy folder handles are readable once for migration but can never become save targets. */
export function isLegacyPortableHistoryFolderHandle(
  handle: FileSystemFileHandleLike | null | undefined,
): boolean {
  return handle ? nativeHandleMetadata.get(handle)?.legacyPortableHistoryFolder === true : false;
}

/** 파일 이름 바꾸기를 데스크톱이 거절했다. reason 은 exists·open·saving·invalid·extension. */
export class NativeRenameRefusedError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(`Native rename refused: ${reason}`);
    this.reason = reason;
    this.name = 'NativeRenameRefusedError';
  }
}

/** 이 핸들이 데스크톱에서 이름을 바꿀 수 있는 파일인지 */
export function canRenameNativeFile(handle: FileSystemFileHandleLike | null | undefined): boolean {
  const metadata = handle ? nativeHandleMetadata.get(handle) : null;
  return Boolean(metadata?.api.renameNativeFile);
}

/**
 * 열린 네이티브 문서 파일의 이름을 같은 폴더 안에서 바꾼다. 같은 파일을 가리키는 새 이름의
 * 핸들을 돌려준다 (문서 점유와 정체성은 그대로 이어진다).
 */
export async function renameNativeDocumentFile(
  handle: FileSystemFileHandleLike,
  nextName: string,
): Promise<FileSystemFileHandleLike> {
  const metadata = nativeHandleMetadata.get(handle);
  if (!metadata?.api.renameNativeFile) throw new Error('이 파일은 이름을 바꿀 수 없습니다.');
  const result = await metadata.api.renameNativeFile(metadata.handleId, nextName);
  // 이름이 이미 있는 등 고칠 수 있는 거절은 이유 코드로 온다 (exists·open·saving·invalid·extension).
  if (!result.ok) throw new NativeRenameRefusedError(result.reason);
  const renamed = createNativeFileHandle(result.descriptor, metadata.api);
  renamed.adoptSaveTarget?.();
  const renamedMetadata = nativeHandleMetadata.get(renamed);
  if (renamedMetadata && metadata.identity) renamedMetadata.identity = { ...metadata.identity };
  return renamed;
}

export function bindNativeFileHandleIdentity(
  handle: FileSystemFileHandleLike | null,
  identity: DocumentOwnershipIdentity,
) {
  const metadata = handle ? nativeHandleMetadata.get(handle) : null;
  if (metadata) metadata.identity = { ...identity };
}

/** Resolve only the exact desktop path represented by this opaque, sender-owned handle. */
export async function getNativeFileSourcePath(
  handle: FileSystemFileHandleLike | null | undefined,
): Promise<string | null> {
  const metadata = handle ? nativeHandleMetadata.get(handle) : null;
  if (!metadata?.api.getNativeFileSourcePath) return null;
  const sourcePath = await metadata.api.getNativeFileSourcePath(metadata.handleId);
  return typeof sourcePath === 'string' && sourcePath.trim() && !sourcePath.includes('\0')
    ? sourcePath
    : null;
}

export function captureDesktopNativeDroppedFile(
  file: File,
  win?: DesktopHost,
): Promise<FileSystemFileHandleLike | null | undefined> {
  const api = desktopHost(win)?.rhwpDesktop;
  if (!api?.claimNativeDroppedFile) return Promise.resolve(undefined);
  // The preload call reaches webUtils synchronously while Chromium still owns the drop File.
  const pending = api.claimNativeDroppedFile(file);
  return Promise.resolve(pending).then((result) => {
    if (!result) return undefined;
    if ('owned' in result) throw new Error('다른 창에서 이미 열려 있는 문서입니다.');
    if (!validNativeDescriptor(result)) throw new Error('Desktop drop returned an invalid handle');
    return createNativeFileHandle(result, api, { saveTarget: result.saveTargetCreated !== false });
  });
}

export async function pickDesktopNativeProjectFile(
  options: { suggestedName: string; documentId: string },
  win?: DesktopHost,
): Promise<FileSystemFileHandleLike | 'owned' | null | undefined> {
  const api = desktopHost(win)?.rhwpDesktop;
  if (!api?.pickNativeOpenFile) return undefined;
  const result = await api.pickNativeOpenFile(options);
  if (!result) return null;
  if ('owned' in result) return 'owned';
  if (!validNativeDescriptor(result)) throw new Error('Desktop open picker returned an invalid handle');
  return createNativeFileHandle(result, api, { saveTarget: result.saveTargetCreated !== false });
}

export async function pickDesktopNativeOpenFile(
  win?: DesktopHost,
  options?: { suggestedName?: string; documentId?: string },
): Promise<FileSystemFileHandleLike | null | undefined> {
  const api = desktopHost(win)?.rhwpDesktop;
  if (!api?.pickNativeOpenFile) return undefined;
  const result = await api.pickNativeOpenFile(options);
  if (!result || 'owned' in result) return null;
  if (!validNativeDescriptor(result)) throw new Error('Desktop open picker returned an invalid handle');
  return createNativeFileHandle(result, api, { saveTarget: result.saveTargetCreated !== false });
}

export async function pickDesktopLegacyHistoryFolder(
  win?: DesktopHost,
): Promise<FileSystemFileHandleLike | null | undefined> {
  const api = desktopHost(win)?.rhwpDesktop;
  if (!api?.pickLegacyHistoryFolder) return undefined;
  const result = await api.pickLegacyHistoryFolder();
  if (!result) return null;
  if ('owned' in result) throw new Error('다른 창에서 이미 가져오고 있는 기록 폴더입니다.');
  if (!validNativeDescriptor(result) || result.legacyPortableHistoryFolder !== true) {
    throw new Error('Desktop legacy history picker returned an invalid handle');
  }
  return createNativeFileHandle(result, api, { saveTarget: result.saveTargetCreated !== false });
}

export async function pickDesktopNativeSaveFile(
  options: SaveFilePickerOptionsLike,
  win?: DesktopHost,
): Promise<FileSystemFileHandleLike | null | undefined> {
  const api = desktopHost(win)?.rhwpDesktop;
  if (!api?.pickNativeSaveFile) return undefined;
  const suggestedName = options.suggestedName ?? FALLBACK_DOCUMENT_FILE_NAME;
  const match = suggestedName.match(/\.(hwp|hwpx|hml)$/i);
  if (!match) throw new Error('Save target format is unavailable');
  const result = await api.pickNativeSaveFile({
    suggestedName,
    extension: match[1]!.toLowerCase() as 'hwp' | 'hwpx' | 'hml',
  });
  if (!result) return null;
  if ('owned' in result) throw new Error('다른 창에서 이미 열려 있는 문서입니다.');
  if (!validNativeDescriptor(result)) throw new Error('Desktop save picker returned an invalid handle');
  return createNativeFileHandle(result, api, { saveTarget: result.saveTargetCreated !== false });
}

export async function pickDesktopPortableHistorySaveFile(
  archive: { fileName: string; bytes: Uint8Array },
  win?: DesktopHost,
): Promise<FileSystemFileHandleLike | null | undefined> {
  const api = desktopHost(win)?.rhwpDesktop;
  if (!api?.pickNativeSaveFile) return undefined;
  const result = await api.pickNativeSaveFile({
    suggestedName: archive.fileName,
    extension: 'rhwpx',
  });
  if (!result) return null;
  if ('owned' in result) throw new Error('다른 창에서 이미 열려 있는 기록 파일입니다.');
  if (!validNativeDescriptor(result)) throw new Error('Desktop history save picker returned an invalid handle');
  return createNativeFileHandle(result, api, { saveTarget: result.saveTargetCreated !== false });
}

/**
 * 네이티브 핸들로 읽은 바이트를 문서로 연 뒤 호출한다. 이 창이 이미 가진 경로를 다시 열면
 * 데스크톱은 기존 핸들을 재사용하므로, 디스크 기준이 처음 연 버전에 머물러 외부에서 바뀐 파일을
 * 다시 연 뒤에도 저장마다 충돌이 난다. 디스크가 방금 연 바이트와 같을 때만 기준을 옮긴다.
 */
export async function adoptLoadedNativeFileContent(
  handle: FileSystemFileHandleLike | null | undefined,
  bytes: Uint8Array,
): Promise<boolean> {
  const metadata = handle ? nativeHandleMetadata.get(handle) : null;
  if (!metadata?.api.adoptNativeFileContent) return false;
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', copy.buffer));
  const hex = [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return await metadata.api.adoptNativeFileContent(metadata.handleId, `sha256:${hex}`) === true;
}

export async function rememberNativeDocument(
  documentId: string | null | undefined,
  handle: FileSystemFileHandleLike | null | undefined,
  digest?: string | null,
): Promise<void> {
  const metadata = handle ? nativeHandleMetadata.get(handle) : null;
  if (!documentId || !metadata?.api.rememberNativeDocument) return;
  await metadata.api.rememberNativeDocument(documentId, metadata.handleId, digest);
}

export async function restoreNativeDocument(
  documentId: string | null | undefined,
  win?: DesktopHost,
): Promise<FileSystemFileHandleLike | 'owned' | null> {
  const api = desktopHost(win)?.rhwpDesktop;
  if (!api?.reopenNativeDocument || !documentId) return null;
  try {
    const result = await api.reopenNativeDocument(documentId);
    if (!result) return null;
    if ('owned' in result) return 'owned';
    if (!validNativeDescriptor(result)) return null;
    return createNativeFileHandle(result, api, { saveTarget: result.saveTargetCreated !== false });
  } catch (error) {
    console.warn('[desktop] native document reopen failed:', error);
    return null;
  }
}

export interface NativeProbeRef {
  readonly probeId: string;
  readonly fileName: string;
}

export async function searchNearbyNativeDocuments(
  documentId: string,
  options: { basenameHint?: string } = {},
  win?: DesktopHost,
): Promise<readonly NativeProbeRef[] | null> {
  const api = desktopHost(win)?.rhwpDesktop;
  if (!api?.searchNearbyNativeDocument || !documentId) return null;
  try {
    const result = await api.searchNearbyNativeDocument(documentId, options);
    if (!Array.isArray(result)) return null;
    return result.flatMap((item) => {
      if (!item || typeof item !== 'object') return [];
      const probe = item as Record<string, unknown>;
      if (typeof probe.probeId !== 'string' || !probe.probeId) return [];
      if (typeof probe.fileName !== 'string' || !probe.fileName) return [];
      return [{ probeId: probe.probeId, fileName: probe.fileName }];
    });
  } catch (error) {
    console.warn('[desktop] native nearby search failed:', error);
    return null;
  }
}

export async function readNativeProbe(
  probeId: string,
  win?: DesktopHost,
): Promise<{ bytes: Uint8Array; fileName: string } | null> {
  const api = desktopHost(win)?.rhwpDesktop;
  if (!api?.readNativeProbe || !probeId) return null;
  const result = checkedNativeFileReadResult(await api.readNativeProbe(probeId));
  return { bytes: result.bytes, fileName: result.name };
}

export async function claimNativeProbe(
  probeId: string,
  win?: DesktopHost,
): Promise<FileSystemFileHandleLike | 'owned' | null> {
  const api = desktopHost(win)?.rhwpDesktop;
  if (!api?.claimNativeProbe || !probeId) return null;
  const result = await api.claimNativeProbe(probeId);
  if (!result) return null;
  if ('owned' in result) return 'owned';
  if (!validNativeDescriptor(result)) return null;
  return createNativeFileHandle(result, api, { saveTarget: result.saveTargetCreated !== false });
}

export async function verifyNativePick(
  documentId: string,
  handle: FileSystemFileHandleLike | null | undefined,
  win?: DesktopHost,
): Promise<boolean> {
  const api = desktopHost(win)?.rhwpDesktop ?? (handle ? nativeHandleMetadata.get(handle)?.api : undefined);
  const handleId = handle ? nativeHandleMetadata.get(handle)?.handleId : undefined;
  if (!api?.verifyNativePick || !documentId || !handleId) return false;
  try {
    return await api.verifyNativePick(documentId, handleId) === true;
  } catch {
    return false;
  }
}

export async function releaseReplacedNativeFileHandle(
  previous: FileSystemFileHandleLike | null,
  next: FileSystemFileHandleLike | null,
) {
  const previousMetadata = previous ? nativeHandleMetadata.get(previous) : null;
  const nextMetadata = next ? nativeHandleMetadata.get(next) : null;
  if (!previousMetadata?.api.releaseNativeFile) return;
  if (
    nextMetadata
    && nextMetadata.api === previousMetadata.api
    && nextMetadata.handleId === previousMetadata.handleId
  ) return;
  const previousDocumentId = previousMetadata.identity?.documentId;
  if (previousDocumentId && previousMetadata.api.rememberNativeDocument) {
    await previousMetadata.api.rememberNativeDocument(
      previousDocumentId,
      previousMetadata.handleId,
    ).catch((error) => console.warn('[desktop] native document bookmark failed:', error));
  }
  await previousMetadata.api.releaseNativeFile(previousMetadata.handleId);
}

/**
 * 문서 소유권 예약. slotId 는 한 창이 여러 문서를 동시에 열 때 문서마다 다르게 준다
 * (생략하면 기본 자리). 같은 창의 다른 자리가 이미 가진 문서도 null(소유됨)이다.
 */
export async function reserveDesktopDocument(
  identity: DocumentOwnershipIdentity,
  handle: FileSystemFileHandleLike | null,
  win?: DesktopHost,
  slotId?: string,
): Promise<string | null | undefined> {
  const api = desktopHost(win)?.rhwpDesktop;
  if (!api?.reserveDocument) return undefined;
  const nativeHandleId = handle ? nativeHandleMetadata.get(handle)?.handleId : undefined;
  const result = await api.reserveDocument(identity, nativeHandleId, slotId);
  return result.ok ? result.reservationId : null;
}

/** 예약을 그 자리의 문서로 확정하고, 같은 자리의 이전 문서 소유권을 놓는다. */
export async function commitDesktopDocument(
  reservationId: string | null | undefined,
  win?: DesktopHost,
  slotId?: string,
) {
  if (reservationId) await desktopHost(win)?.rhwpDesktop?.commitDocument?.(reservationId, slotId);
}

export async function cancelDesktopDocument(
  reservationId: string | null | undefined,
  win?: DesktopHost,
  slotId?: string,
) {
  if (reservationId) await desktopHost(win)?.rhwpDesktop?.cancelDocument?.(reservationId, slotId);
}

/** 한 자리의 문서 소유권과 그 자리의 대기 예약을 놓는다. 다른 자리는 그대로다. */
export async function releaseDesktopDocument(win?: DesktopHost, slotId?: string) {
  await desktopHost(win)?.rhwpDesktop?.releaseDocument?.(slotId);
}

export function installDesktopFileHandling(
  openHandles: (handles: FileSystemFileHandleLike[]) => void,
  win?: DesktopHost,
) {
  const api = desktopHost(win)?.rhwpDesktop;
  if (!api?.readNativeFile || !api.writeNativeFile) return;
  const seen = new Set<string>();
  const receive = (descriptors: NativeFileHandleDescriptor[]) => {
    const handles = descriptors
      .filter(validNativeDescriptor)
      .filter((descriptor) => {
        if (seen.has(descriptor.handleId)) return false;
        seen.add(descriptor.handleId);
        return true;
      })
      .map((descriptor) => createNativeFileHandle(descriptor, api, { saveTarget: true }));
    if (handles.length > 0) openHandles(handles);
  };
  api.onOpenFiles?.(receive);
  void api.getLaunchFiles?.().then(receive).catch((error) => {
    console.warn('[rhwp-desktop] 시작 파일 조회 실패:', error);
  });
}

export function installDesktopGeneratedDocumentHandling(
  openDocument: (payload: {
    bytes: Uint8Array;
    fileName: string;
    readOnly: boolean;
  }) => void,
  win?: DesktopHost,
) {
  const api = desktopHost(win)?.rhwpDesktop;
  if (!api?.onOpenGeneratedDocument) return false;
  const seen = new Set<string>();
  const receive = (payload: {
    launchDocumentId?: string;
    bytes?: Uint8Array;
    fileName?: string;
    readOnly?: boolean;
  } | null) => {
    const launchDocumentId = typeof payload?.launchDocumentId === 'string'
      ? payload.launchDocumentId
      : '';
    const fileName = typeof payload?.fileName === 'string' ? payload.fileName : '';
    const bytes = payload?.bytes instanceof Uint8Array ? payload.bytes : null;
    if (!launchDocumentId || seen.has(launchDocumentId) || !bytes || !/\.(?:hwp|hwpx)$/iu.test(fileName)) return;
    seen.add(launchDocumentId);
    openDocument({
      bytes,
      fileName,
      readOnly: payload?.readOnly === true,
    });
  };
  api.onOpenGeneratedDocument(receive);
  void api.getLaunchGeneratedDocument?.().then(receive).catch((error) => {
    console.warn('[rhwp-desktop] 생성 문서 시작 데이터 조회 실패:', error);
  });
  return true;
}

export function installDesktopEditCommandHandling(
  dispatch: (command: 'undo' | 'redo' | 'select-all' | 'delete') => void,
  win?: DesktopHost,
): boolean {
  const api = desktopHost(win)?.rhwpDesktop;
  if (!api?.onEditCommand) return false;
  api.onEditCommand((command) => {
    if (command === 'undo' || command === 'redo' || command === 'select-all' || command === 'delete') {
      dispatch(command);
    }
  });
  return true;
}

export function installDesktopPlainTextPasteHandling(
  paste: (text: string) => void,
  win?: DesktopHost,
): boolean {
  const api = desktopHost(win)?.rhwpDesktop;
  if (!api?.onPastePlainText) return false;
  api.onPastePlainText((text) => {
    if (typeof text === 'string' && text.length > 0) paste(text);
  });
  return true;
}

/**
 * macOS Electron 창 크롬 연동.
 *
 * 셸이 titleBarStyle: 'hidden' 으로 뜨므로 메뉴바가 창 최상단을 차지한다.
 * `desktop-mac` 클래스로 신호등 버튼 자리(왼쪽 여백)와 드래그 영역을 켜고,
 * 전체 화면에서는 신호등이 사라지므로 `desktop-fullscreen` 으로 여백을 되돌린다.
 */
export function installDesktopWindowChrome(win?: DesktopHost): void {
  if (!isDesktopApp(win) || typeof document === 'undefined') return;
  const api = desktopHost(win)?.rhwpDesktop;
  const platform = api?.platform
    ?? (typeof navigator !== 'undefined' && /Macintosh|Mac OS X/i.test(navigator.userAgent)
      ? 'darwin'
      : '');
  if (platform !== 'darwin') return;
  const root = document.documentElement;
  root.classList.add('desktop-mac');
  const setFullscreen = (fullscreen: boolean) => {
    root.classList.toggle('desktop-fullscreen', fullscreen);
  };
  api?.onFullScreenChange?.(setFullscreen);
  void api?.isFullScreen?.().then(setFullscreen).catch(() => {
    /* IPC 미지원 셸에서는 기본(비전체화면) 상태 유지 */
  });
}

/**
 * macOS 닫기 버튼의 미저장 점을 문서 상태에 맞춘다.
 * 이벤트가 몰려도 마이크로태스크 하나로 합치고, 같은 값은 다시 보내지 않는다.
 */
export function installDesktopDocumentState(
  source: {
    subscribe: (update: () => void) => void;
    hasDocument: () => boolean;
    isDirty: () => boolean;
  },
  win?: DesktopHost,
): void {
  const api = desktopHost(win)?.rhwpDesktop;
  if (api?.platform !== 'darwin' || !api.setDocumentState) return;
  const setDocumentState = api.setDocumentState;
  let lastSent: boolean | null = null;
  let queued = false;

  const flush = () => {
    queued = false;
    const edited = source.hasDocument() && source.isDirty();
    if (edited === lastSent) return;
    lastSent = edited;
    setDocumentState({ edited });
  };

  source.subscribe(() => {
    if (queued) return;
    queued = true;
    queueMicrotask(flush);
  });
  flush();
}

/**
 * macOS 에이전트 턴 완료 알림과 Dock 배지.
 * 창이 포커스 중인지는 메인 프로세스가 판단하고, 여기서는 성공한 턴만 알린다.
 */
export function installDesktopAgentAttention(
  source: {
    onEvent: (cb: (event: { type: string; event?: unknown }) => void) => () => void;
    onPendingChange: (cb: () => void) => () => void;
    pendingReviewCount: () => number;
    documentTitle: () => string;
  },
  win?: DesktopHost,
): () => void {
  const api = desktopHost(win)?.rhwpDesktop;
  if (api?.platform !== 'darwin') return () => {};
  if (!api.notifyAgentTurnFinished && !api.setPendingReviewCount) return () => {};
  let turnFailed = false;
  let lastCount = -1;
  const syncCount = () => {
    const count = Math.max(0, Math.floor(source.pendingReviewCount()));
    if (count === lastCount) return;
    lastCount = count;
    api.setPendingReviewCount?.(count);
  };
  const offEvent = source.onEvent((sidebarEvent) => {
    if (sidebarEvent.type !== 'agent') return;
    const event = sidebarEvent.event as { type?: string; stopReason?: string; errorMessage?: string };
    if (event?.type === 'turn-start') turnFailed = false;
    else if (event?.type === 'error') turnFailed = true;
    else if (event?.type === 'turn-end') {
      const succeeded = !turnFailed && !event.errorMessage
        && (event.stopReason === 'end_turn'
          || event.stopReason === 'completed'
          || event.stopReason === 'success');
      turnFailed = false;
      syncCount();
      if (succeeded) {
        api.notifyAgentTurnFinished?.({
          title: source.documentTitle() || 'HamaEditor',
          body: lastCount > 0 ? '검토할 변경이 있습니다' : '작업 완료',
        });
      }
    }
  });
  const offPending = source.onPendingChange(syncCount);
  syncCount();
  return () => {
    offEvent();
    offPending();
    if (lastCount > 0) api.setPendingReviewCount?.(0);
  };
}

type ServiceWorkerLike = NonNullable<NonNullable<DesktopHost['navigator']>['serviceWorker']>;

function serviceWorkerContainer(win?: DesktopHost): ServiceWorkerLike | undefined {
  const host = desktopHost(win);
  return host?.navigator?.serviceWorker
    ?? (typeof navigator !== 'undefined'
      ? navigator.serviceWorker as unknown as ServiceWorkerLike
      : undefined);
}

/** Electron 셸에서는 PWA SW가 IndexedDB 할당량 정리로 최근문서/자동저장 open을 멈출 수 있다. */
export async function suppressDesktopServiceWorker(win?: DesktopHost): Promise<void> {
  if (!isDesktopApp(win)) return;
  const sw = serviceWorkerContainer(win);
  if (!sw?.getRegistrations) return;
  const unregisterAll = async () => {
    try {
      const regs = await sw.getRegistrations();
      await Promise.all(regs.map((reg) => reg.unregister()));
    } catch {
      /* ignore */
    }
  };
  await unregisterAll();
  sw.addEventListener?.('controllerchange', () => {
    void unregisterAll();
  });
}

/** 브라우저 PWA만 등록하고, Electron 은 기존 SW를 끈다. */
export function installWebAppShell(win?: DesktopHost): void {
  if (isDesktopApp(win)) {
    void suppressDesktopServiceWorker(win);
    return;
  }
  void import('virtual:pwa-register')
    .then(({ registerSW }) => {
      registerSW({ immediate: true });
    })
    .catch(() => {
      /* 테스트·개발 번들에는 virtual module이 없을 수 있다 */
    });
}
