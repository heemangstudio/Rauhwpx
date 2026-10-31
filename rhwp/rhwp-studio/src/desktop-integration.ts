/**
 * 로컬 에이전트 허브 기동.
 *
 * Electron 은 preload IPC 로 메인 프로세스가 허브를 띄운다.
 * Vite 개발 서버는 `/__rhwp/ensure-agent-hub` 가 같은 일을 한다.
 * 그 밖의 브라우저는 Node 를 띄울 수 없어 no-op 이다.
 */

import type { DesktopFontHostApi, SystemFontIndex } from './core/desktop-fonts.ts';
import type { ChatAttentionLedger } from './agent/chat-attention.ts';
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

/* ── 앱 업데이트 (rhwpDesktop.updates) ─────────────────────────
   메인이 확인·다운로드·재시작을 맡고, 문서 홈의 하마가 상태를 팻말로 보인다. */

export type DesktopUpdateStatus = 'disabled' | 'idle' | 'checking' | 'up-to-date' | 'available'
  | 'downloading' | 'downloaded' | 'restarting' | 'error';

export interface DesktopUpdateState {
  status: DesktopUpdateStatus;
  currentVersion: string;
  /** available·downloading·downloaded·restarting·error 의 대상 버전. */
  version: string | null;
  /** downloading 동안 0..100. */
  percent: number | null;
  /** external 이면(리눅스 deb) download() 가 릴리스 페이지를 연다. */
  install: 'in-app' | 'external';
  /**
   * error 상태는 버전이 있는 다운로드·설치 실패에만 쓴다. 백그라운드 확인 실패는 idle 로 남고,
   * 직접 누른 확인이 실패하면 idle + { context: 'check' } 이다.
   */
  error: { context: 'check' | 'download' | 'install'; message: string } | null;
  /** 마지막 확인을 사용자가 메뉴에서 눌렀다. */
  manual: boolean;
  /** 모든 창이 알린 실행 중인 채팅 수의 합. */
  runningChats: number;
}

export interface UpdateRestartSlice {
  ok: boolean;
  documents: Array<{
    documentId: string;
    /** 이 창의 네이티브 파일 핸들 id. 한 번도 저장하지 않은 새 문서면 null. */
    handleId: string | null;
    fileName: string;
    /** 창에 붙어 보이는 문서. */
    active: boolean;
  }>;
  /** 다시 켠 뒤 이어서 진행할, 실행 중이던 채팅. */
  continueThreadIds: string[];
}

export interface UpdateRestoreSlice {
  documents: Array<{
    documentId: string;
    /** 새 창 세션에 메인이 다시 만든 핸들. */
    file: NativeFileHandleDescriptor | null;
    fileName: string;
    active: boolean;
  }>;
  continueThreadIds: string[];
  /** 다시 켠 모든 창의 문서 ID. 다른 창이 다시 여는 문서의 복구본은 복구 제안에 넣지 않는다. */
  restoredDocumentIds: string[];
}

export interface UpdateAllItem {
  id: 'app' | 'claude' | 'codex';
  fromVersion: string | null;
  targetVersion: string;
  installedVersion?: string;
  status: 'available' | 'manual' | 'queued' | 'waiting' | 'running' | 'ready' | 'done' | 'failed';
  message: string | null;
}

export interface UpdateAllState {
  runId: string | null;
  phase: 'idle' | 'checking' | 'updating' | 'waiting' | 'countdown' | 'deferred' | 'restarting' | 'complete' | 'failed';
  items: UpdateAllItem[];
  restartAt: number | null;
  appPercent?: number | null;
  error?: string | null;
}

export interface DesktopUpdatesApi {
  getAllState?(): Promise<UpdateAllState | null>;
  onAllState?(callback: (state: UpdateAllState) => void): () => void;
  refreshAll?(): Promise<UpdateAllState | null>;
  updateAll?(): Promise<UpdateAllState | null>;
  later?(): Promise<void>;
  getState(): Promise<DesktopUpdateState>;
  /** 채널 'desktop:update-state'. 해제 함수를 돌려준다. */
  onState(callback: (state: DesktopUpdateState) => void): () => void;
  /** 직접 누른 확인. */
  check(): Promise<void>;
  download(): Promise<void>;
  /** 사용자가 경고 팻말에서 재시작을 눌렀다. */
  restart(): Promise<{ ok: boolean }>;
  /** 창마다 보낸다. 응답을 기다리지 않는다. */
  setRunningChatCount(count: number): void;
  /**
   * 업데이트 재시작 전에 메인이 모든 창에 준비를 부탁한다. 처리기는 저장할 것을 정리하고 필요하면 묻되,
   * 닫기 확인은 아직 풀지 않는다. ok:false 면 재시작을 멈추고 상태는 downloaded 로 돌아간다.
   */
  onPrepareRestart(handler: () => Promise<UpdateRestartSlice>): () => void;
  /**
   * 모든 창이 준비에 응한 뒤 메인이 확정을 부탁한다. 처리기는 그 사이의 편집까지 남기고 닫기 확인을 푼 뒤
   * 이 창의 몫을 돌려준다. 메인은 이 몫으로 다시 열 창을 기록한다.
   */
  onCommitRestart(handler: () => Promise<UpdateRestartSlice>): () => void;
  /** 다시 켠 창마다 한 번만 준다. 그 밖에는 null. */
  getRestore(): Promise<UpdateRestoreSlice | null>;
}

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

export type NativeAgentDocumentOpenFailure =
  | 'DOC_OPEN_ELSEWHERE'
  | 'NOT_FOUND'
  | 'UNREADABLE'
  | 'TOO_LARGE'
  | 'INVALID_PATH';
export type NativeAgentDocumentCreateFailure =
  | 'INVALID_NAME'
  | 'INVALID_FOLDER'
  | 'WRITE_FAILED';

type NativeAgentDocumentIpcResult<Code extends string> =
  | (NativeFileHandleDescriptor & { ok: true; path: string; bytes?: Uint8Array })
  | { ok: false; code: Code };

/**
 * 에이전트가 경로로 열거나 새로 만든 데스크톱 문서. handle·bytes·name 은 열기 대화상자로 고른
 * 파일과 같다 — `open-document-bytes` 의 fileHandle·bytes·fileName 으로 넘기면 같은 흐름(문서 id·
 * 문서 점유·북마크·같은 경로로 저장)을 탄다.
 */
export type NativeAgentDocument<Code extends string> =
  | { ok: true; handle: FileSystemFileHandleLike; bytes: Uint8Array; name: string; path: string }
  | { ok: false; code: Code };

export interface DocumentOwnershipIdentity {
  documentId: string;
  sourceDigest: string | null;
  useSourceDigest?: boolean;
}

interface NativeFileReadResult {
  name: string;
  bytes: Uint8Array;
}

/**
 * missing: 문서를 연 뒤 파일이 지워졌거나 찾을 수 없는 곳으로 옮겨졌다.
 * unavailable: 문서가 있는 드라이브나 네트워크 폴더에 닿지 않는다(빼낸 USB, 끊긴 공유 폴더).
 */
export interface NativeFileLocation {
  name: string;
  state: 'present' | 'missing' | 'unavailable';
}

export interface NativeFileMovedEvent {
  handleId: string;
  name: string;
  previousName: string;
}

export interface RhwpDesktopApi {
  license?: import('./ui/agent-sidebar/settings-license.ts').DesktopLicenseApi;
  /** 호스팅 Rau(Rau 요금제·체험) 자격과 크레딧, 업그레이드 페이지. 서버 호출과 lease 는 main 이 가진다. */
  rau?: import('./ui/agent-sidebar/rau-upgrade.ts').DesktopRauApi;
  /** 앱 요금제(무료·Hama·Rau)와 결제. 결제 주소와 ref 는 main 만 안다. */
  plan?: import('./ui/plan/plan-types.ts').DesktopPlanApi;
  /** 특별 이벤트 선물 크레딧. macOS 에서만 쓴다(desktopGiftApi). */
  gift?: import('./ui/special-event/gift.ts').DesktopGiftApi;
  /** 앱 업데이트 확인·다운로드·재시작. */
  updates?: DesktopUpdatesApi;
  ensureAgentHub?: () => Promise<{ started?: boolean; ready?: boolean } | boolean>;
  getSessionContext?: () => Promise<RendererSessionContext>;
  createAgentSession?: () => Promise<{ sessionId: string }>;
  getAgentSessionContext?: (sessionId: string) => Promise<RendererSessionContext>;
  releaseAgentSession?: (sessionId: string) => Promise<boolean>;
  /** 문제 보고. 메인이 창을 찍고 진단 기록을 붙여 site-api 로 보낸다. */
  issueReport?: import('./ui/issue-report/types.ts').DesktopIssueReportApi;
  /** 자동 수정. 메인이 숨은 코딩 에이전트로 앱 환경을 고치고 오류 보고를 보낸다. */
  autofix?: import('./ui/autofix/autofix.ts').DesktopAutofixApi;
  /** 렌더러 오류를 메인의 진단 기록에 남긴다. */
  logDiagnostics?: (entries: Array<{ level: 'error' | 'warn'; text: string }>) => void;
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
  /** 에이전트 open_document({path}). 다른 창이 쥔 문서는 그 창을 앞으로 가져오지 않고 코드로 알린다. */
  openNativeDocumentAtPath?: (path: string) => Promise<NativeAgentDocumentIpcResult<NativeAgentDocumentOpenFailure>>;
  /** 에이전트 create_document. <folder 또는 ~/Documents/HamaEditor>/<name>.hwpx 를 새로 만든다. */
  createNamedNativeDocument?: (payload: {
    name: string;
    folder?: string;
    bytes: Uint8Array;
  }) => Promise<NativeAgentDocumentIpcResult<NativeAgentDocumentCreateFailure>>;
  claimNativeDroppedFile?: (
    file: File,
  ) => Promise<NativeFileHandleDescriptor | { owned: true } | null> | null;
  pickNativeSaveFile?: (options: {
    suggestedName: string;
    extension: 'hwp' | 'hwpx' | 'hml' | 'rhwpx';
    /** 대화상자를 이 핸들의 문서가 있는 폴더에서 연다. */
    handleId?: string;
  }) => Promise<NativeFileHandleDescriptor | { owned: true } | null>;
  releaseNativeFile?: (handleId: string) => Promise<void>;
  renameNativeFile?: (
    handleId: string,
    nextName: string,
  ) => Promise<{ ok: true; descriptor: NativeFileHandleDescriptor } | { ok: false; reason: string }>;
  readNativeFile?: (handleId: string) => Promise<NativeFileReadResult>;
  /** 탐색기에서 바뀐 이름·옮긴 폴더를 메인이 따라간 뒤 지금 이름. 놓은 핸들이면 null. */
  locateNativeFile?: (handleId: string) => Promise<NativeFileLocation | null>;
  /** 메인이 바깥에서 이름이 바뀌거나 옮겨진 문서 파일을 따라갔다. 해제 함수를 돌려준다. */
  onNativeFileMoved?: (callback: (event: NativeFileMovedEvent) => void) => (() => void) | void;
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
  /** 문서 홈: 기억한 위치의 파일 상태. 핸들을 만들지 않는다. */
  inspectNativeDocuments?: (documentIds: string[]) => Promise<ReadonlyArray<NativeDocumentPresence & { documentId: string }>>;
  relocateNativeDocument?: (documentId: string) => Promise<{ fileName: string } | null>;
  /** detailed 면 못 읽은 이유를 { ok:false, reason } 로 돌려준다. 아니면 못 읽을 때 null. */
  readRememberedNativeDocument?: (
    documentId: string,
    options?: { detailed: true },
  ) => Promise<NativeFileReadResult | { ok: false; reason?: unknown } | null>;
  revealNativeDocument?: (documentId: string) => Promise<boolean>;
  openNativeDocumentWindow?: (documentId: string) => Promise<boolean>;
  /** 이 창이 앱의 첫 창이라 자동 저장본 복구를 물어도 되는지. */
  offersAutosaveRecovery?: () => Promise<boolean>;
  /** 저장하지 않은 새 문서. 창마다 자기 목록을 알리고 모든 창의 목록을 받는다. */
  setUnsavedDocuments?: (documents: UnsavedDocumentReport[]) => void;
  listUnsavedDocuments?: () => Promise<DesktopUnsavedDocument[]>;
  onUnsavedDocumentsChanged?: (callback: (documents: DesktopUnsavedDocument[]) => void) => (() => void) | void;
  /** 다른 창의 새 문서를 그 창에서 열거나 저장한다. 그 창이 없으면 false. */
  runUnsavedDocumentAction?: (documentId: string, action: UnsavedDocumentAction) => Promise<boolean>;
  onUnsavedDocumentAction?: (callback: (documentId: string, action: UnsavedDocumentAction) => void) => (() => void) | void;
  /** 문서 홈 카드를 파일로 끌어 내기. 준비한 끌기의 token 으로 시작하고 끝낸다. */
  prepareFileDrag?: (items: DesktopFileDragItem[]) => Promise<{ token: string | null; failed: string[] }>;
  /** true 로 풀리면 끌기가 끝났다(Windows 는 놓은 뒤에 풀린다). false 면 운영체제가 아직 끄는 중이다. */
  startFileDrag?: (token: string, iconDataUrl: string) => Promise<boolean>;
  /** dropped: 끌기를 시작했다(받는 앱이 사본을 읽을 수 있다). false 면 사본을 바로 지운다. */
  endFileDrag?: (token: string, dropped: boolean) => void;
  onDragExportRequest?: (callback: (documentId: string) => DesktopDragExport | Promise<DesktopDragExport>) => (() => void) | void;
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
  setWindowChromeTheme?: (dark: boolean) => void;
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
  systemFontNameTables?: DesktopFontHostApi['systemFontNameTables'];
  fontFolders?: DesktopFontHostApi['fontFolders'];
  onFontsChanged?: DesktopFontHostApi['onFontsChanged'];
  /** macOS 프록시 아이콘과 미저장 점. 경로는 메인이 핸들로 찾는다. */
  setDocumentState?: (state: { edited: boolean }) => void;
  /** 창 배경색(#rrggbb). 내용이 그려지기 전과 크기를 바꾸는 동안 보이는 색이다. */
  setWindowBackground?: (color: string) => void;
  /** 보지 않는 채팅의 알림 — 창에 초점이 없을 때만 메인이 OS 알림으로 띄운다. */
  notifyAgentAttention?: (payload: { threadId: string; title: string; body: string }) => void;
  /** 알렸지만 아직 보지 않은 채팅 수 — 앱 아이콘 배지(macOS·Linux)와 작업 표시줄 표시(Windows). */
  setAgentAttentionCount?: (count: number) => void;
  /** 알림을 누르면 그 채팅을 연다. 해제 함수를 돌려준다. */
  onOpenAgentChat?: (callback: (threadId: string) => void) => (() => void) | void;
  showContextMenu?: (items: NativeContextMenuItem[]) => Promise<string | null>;
  /** 저장 확인을 창에 붙은 네이티브 시트로 묻는다. */
  showUnsavedChangesSheet?: (payload: { fileName: string }) => Promise<'save' | 'discard' | 'cancel'>;
}

export interface UnsavedDocumentReport {
  documentId: string;
  fileName: string;
  edited: boolean;
  createdAt: number;
}

export interface DesktopUnsavedDocument extends UnsavedDocumentReport {
  /** 이 창의 문서. */
  local: boolean;
}

export type UnsavedDocumentAction = 'open' | 'save';

/** 끌어 낼 문서. recent·unsaved 는 데스크톱이 찾고(다른 창이면 그 창에 묻는다), bytes 는 이 창이 내보낸 것이다. */
export type DesktopFileDragItem =
  | { kind: 'recent' | 'unsaved'; documentId: string; fileName: string }
  | { kind: 'bytes'; fileName: string; bytes: Uint8Array };

/** 다른 창의 물음에 대한 답: 바뀐 내용, 저장된 파일 그대로(clean), 또는 없음. */
export type DesktopDragExport = { fileName: string; bytes: Uint8Array } | 'clean' | null;

export type DesktopFileDragApi = Required<Pick<RhwpDesktopApi,
  'prepareFileDrag' | 'startFileDrag' | 'endFileDrag' | 'onDragExportRequest'>>;

export function desktopFileDragApi(win?: DesktopHost): DesktopFileDragApi | null {
  const api = desktopHost(win)?.rhwpDesktop;
  if (!api?.prepareFileDrag || !api.startFileDrag || !api.endFileDrag || !api.onDragExportRequest) return null;
  return {
    prepareFileDrag: api.prepareFileDrag,
    startFileDrag: api.startFileDrag,
    endFileDrag: api.endFileDrag,
    onDragExportRequest: api.onDragExportRequest,
  };
}

export function desktopUnsavedDocumentsApi(win?: DesktopHost): Required<Pick<RhwpDesktopApi,
  'setUnsavedDocuments' | 'listUnsavedDocuments' | 'onUnsavedDocumentsChanged'
  | 'runUnsavedDocumentAction' | 'onUnsavedDocumentAction'>> | null {
  const api = desktopHost(win)?.rhwpDesktop;
  if (!api?.setUnsavedDocuments || !api.listUnsavedDocuments || !api.onUnsavedDocumentsChanged
    || !api.runUnsavedDocumentAction || !api.onUnsavedDocumentAction) return null;
  return {
    setUnsavedDocuments: api.setUnsavedDocuments,
    listUnsavedDocuments: api.listUnsavedDocuments,
    onUnsavedDocumentsChanged: api.onUnsavedDocumentsChanged,
    runUnsavedDocumentAction: api.runUnsavedDocumentAction,
    onUnsavedDocumentAction: api.onUnsavedDocumentAction,
  };
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
  /** 대화에 남는 안정된 참조. 열 때마다 허브에 새 다운로드 주소를 받는다. */
  readonly artifactId: string;
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
  const match = url.pathname.match(/^\/artifacts\/([A-Za-z0-9_-]{16,128})\/([^/]+)$/u);
  if (!match) return null;
  let fileName;
  try {
    fileName = decodeURIComponent(match[2]);
  } catch {
    return null;
  }
  if (!/\.(?:hwp|hwpx)$/iu.test(fileName) || fileName.includes('\0')) return null;
  return {
    artifactId: match[1],
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
  if (!openNative) throw new Error('새 문서 창을 열 수 없습니다.');
  if (!await openNative({
    fileName: artifact.fileName,
    downloadUrl: artifact.downloadUrl,
    ...(options.readOnly ? { readOnly: true } : {}),
  })) {
    throw new Error('새 문서 창을 열지 못했습니다.');
  }
}

let inflight: Promise<boolean> | null = null;
let sessionContextInflight: Promise<RendererSessionContext | null> | null = null;
type DevHubContext = Pick<
  RendererSessionContext,
  'launchId' | 'hubUrl' | 'hubToken' | 'referenceToken' | 'templateToken'
>;
let devHubContext: DevHubContext | null = null;
/** 메인 핸들 하나를 가리키는 렌더러 쪽 핸들 객체들. 파일 이름이 바뀌면 모두 새 이름을 보인다. */
const nativeHandlesById = new Map<string, Set<WeakRef<FileSystemFileHandleLike>>>();
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

/** 문제 보고(데스크톱). 없으면 null — 웹·확장에서는 문제 보고 명령을 두지 않는다. */
export function desktopIssueReportApi(win?: DesktopHost): import('./ui/issue-report/types.ts').DesktopIssueReportApi | null {
  const api = desktopHost(win)?.rhwpDesktop?.issueReport;
  return api && typeof api.prepare === 'function' && typeof api.submit === 'function' ? api : null;
}

/** 렌더러 오류를 메인의 진단 기록으로 보내는 함수. 데스크톱이 아니면 undefined. */
export function desktopDiagnosticsLogger(win?: DesktopHost): RhwpDesktopApi['logDiagnostics'] {
  const api = desktopHost(win)?.rhwpDesktop;
  const log = api?.logDiagnostics;
  return typeof log === 'function' ? (entries) => log(entries) : undefined;
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

/** 마지막 허브 기동 요청의 결과. 아직 묻지 않았으면 null. */
let lastAgentHubReady: boolean | null = null;

/** 앱이 띄우는 허브가 마지막 요청에서 준비되지 않았다(기동 실패·시간 초과). */
export function agentHubLaunchFailed(): boolean {
  return lastAgentHubReady === false;
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
  void run.then((ready) => { lastAgentHubReady = ready; }).finally(() => {
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
            const written = await api.writeNativeFile!(descriptor.handleId, bytes, identity);
            // 탐색기에서 이름이 바뀐 문서는 메인이 그 파일을 따라가 저장한다. 저장 결과가 새 이름을 쓰게 한다.
            if (typeof written?.name === 'string') applyNativeHandleName(descriptor.handleId, written.name);
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
  let wrappers = nativeHandlesById.get(descriptor.handleId);
  if (!wrappers) {
    wrappers = new Set();
    nativeHandlesById.set(descriptor.handleId, wrappers);
  }
  for (const ref of wrappers) if (!ref.deref()) wrappers.delete(ref);
  wrappers.add(new WeakRef(handle));
  return handle;
}

/**
 * 메인 핸들 하나를 가리키는 모든 핸들 객체의 이름을 바꾼다. 같은 파일의 같은 확장자 이름만
 * 받는다(저장 형식은 이름의 확장자로 정한다). 이름이 바뀌었으면 true.
 */
function applyNativeHandleName(handleId: string, name: string): boolean {
  const wrappers = nativeHandlesById.get(handleId);
  if (!wrappers || !name || name !== name.trim() || /[\\/\0]/.test(name)) return false;
  const extension = (value: string) => value.match(/\.[^.]+$/)?.[0]?.toLowerCase() ?? '';
  let changed = false;
  for (const ref of wrappers) {
    const handle = ref.deref();
    if (!handle) {
      wrappers.delete(ref);
      continue;
    }
    if (handle.name === name || extension(handle.name) !== extension(name)) continue;
    handle.name = name;
    changed = true;
  }
  if (wrappers.size === 0) nativeHandlesById.delete(handleId);
  return changed;
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
  // 이름이 이미 있는 등 고칠 수 있는 거절은 이유 코드로 온다 (exists·open·saving·invalid·extension·missing·in-use·denied).
  if (!result.ok) throw new NativeRenameRefusedError(result.reason);
  if (!validNativeDescriptor(result.descriptor) || result.descriptor.handleId !== metadata.handleId) {
    throw new Error('Desktop rename returned an invalid handle');
  }
  // 같은 핸들 객체가 새 이름을 쓴다. 새 객체를 만들면 그 객체에 붙은 표시(HML 변환 저장 등)와
  // 문서 점유가 끊기고, 이름을 바꾸는 동안 끝난 저장이 옛 이름을 되살린다.
  applyNativeHandleName(metadata.handleId, result.descriptor.name);
  handle.adoptSaveTarget?.();
  return handle;
}

/**
 * 창이 다시 앞으로 왔을 때 부른다. 탐색기에서 문서 파일의 이름이 바뀌었거나 다른 폴더로 옮겨졌으면
 * 메인이 그 파일을 따라가고 핸들이 새 이름을 쓴다. 네이티브 핸들이 아니거나 물을 수 없으면 null.
 */
export async function locateNativeDocumentFile(
  handle: FileSystemFileHandleLike | null | undefined,
): Promise<NativeFileLocation | null> {
  const metadata = handle ? nativeHandleMetadata.get(handle) : null;
  if (!metadata?.api.locateNativeFile || metadata.legacyPortableHistoryFolder) return null;
  const location = await metadata.api.locateNativeFile(metadata.handleId);
  if (!location || typeof location.name !== 'string') return null;
  applyNativeHandleName(metadata.handleId, location.name);
  const state = location.state === 'missing' || location.state === 'unavailable' ? location.state : 'present';
  return { name: location.name, state };
}

/**
 * 메인이 바깥에서 이름이 바뀌거나 옮겨진 문서 파일을 따라갔다는 알림을 받는다. 콜백 전에 그 파일의
 * 핸들 객체들이 새 이름을 쓰게 한다. 해제 함수를 돌려준다.
 */
export function subscribeNativeFileMoves(
  callback: (event: NativeFileMovedEvent) => void,
  win?: DesktopHost,
): () => void {
  const api = desktopHost(win)?.rhwpDesktop;
  if (!api?.onNativeFileMoved) return () => {};
  const dispose = api.onNativeFileMoved((event) => {
    if (typeof event?.handleId !== 'string' || typeof event.name !== 'string') return;
    applyNativeHandleName(event.handleId, event.name);
    callback({ handleId: event.handleId, name: event.name, previousName: event.previousName ?? '' });
  });
  return typeof dispose === 'function' ? dispose : () => {};
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

const AGENT_OPEN_FAILURES: ReadonlySet<unknown> = new Set<NativeAgentDocumentOpenFailure>([
  'DOC_OPEN_ELSEWHERE', 'NOT_FOUND', 'UNREADABLE', 'TOO_LARGE', 'INVALID_PATH',
]);
const AGENT_CREATE_FAILURES: ReadonlySet<unknown> = new Set<NativeAgentDocumentCreateFailure>([
  'INVALID_NAME', 'INVALID_FOLDER', 'WRITE_FAILED',
]);

function nativeAgentDocumentResult<Code extends string>(
  result: unknown,
  api: RhwpDesktopApi,
  failures: ReadonlySet<unknown>,
  fallback: Code,
  writtenBytes?: Uint8Array,
): NativeAgentDocument<Code> {
  const value = result as Record<string, unknown> | null;
  if (!value || value.ok !== true) {
    const code = failures.has(value?.code) ? value!.code as Code : fallback;
    return { ok: false, code };
  }
  if (!validNativeDescriptor(value) || typeof value.path !== 'string' || !value.path) {
    return { ok: false, code: fallback };
  }
  const descriptor: NativeFileHandleDescriptor = {
    kind: 'file',
    handleId: value.handleId,
    name: value.name,
    saveTargetCreated: value.saveTargetCreated !== false,
    ...(value.verifiedDocumentId ? { verifiedDocumentId: value.verifiedDocumentId } : {}),
  };
  const read = writtenBytes
    ? { name: descriptor.name, bytes: writtenBytes }
    : checkedNativeFileReadResult({ name: value.name, bytes: value.bytes });
  const handle = createNativeFileHandle(descriptor, api, { saveTarget: descriptor.saveTargetCreated !== false });
  return { ok: true, handle, bytes: read.bytes, name: read.name, path: value.path };
}

/**
 * 에이전트 open_document({path}) — 절대 경로의 hwp/hwpx/hml 을 이 창에서 열 수 있게 잡고 읽는다.
 * 데스크톱이 아니면 null. 성공 결과는 열기 대화상자로 고른 파일과 같다({@link NativeAgentDocument}).
 * 실패하면 핸들이 남지 않는다. 열기를 그만두면 handle.releaseUnusedSaveTarget() 으로 놓는다.
 */
export async function openNativeDocumentAtPath(
  path: string,
  win?: DesktopHost,
): Promise<NativeAgentDocument<NativeAgentDocumentOpenFailure> | null> {
  const api = desktopHost(win)?.rhwpDesktop;
  if (!api?.openNativeDocumentAtPath) return null;
  try {
    const result = await api.openNativeDocumentAtPath(path);
    return nativeAgentDocumentResult(result, api, AGENT_OPEN_FAILURES, 'UNREADABLE');
  } catch (error) {
    console.warn('[desktop] open document at path failed:', error);
    return { ok: false, code: 'UNREADABLE' };
  }
}

/**
 * 에이전트 create_document — bytes(빈 HWPX)를 <folder>/<name>.hwpx 로 새로 쓴다. folder 가 없으면
 * ~/Documents/HamaEditor. 이름이 겹치면 "<name> (2).hwpx" … 로 비켜 가고 덮어쓰지 않는다.
 * 데스크톱이 아니면 null. 성공 결과의 path 는 실제로 만든 파일이다.
 */
export async function createNamedNativeDocument(
  options: { name: string; folder?: string; bytes: Uint8Array },
  win?: DesktopHost,
): Promise<NativeAgentDocument<NativeAgentDocumentCreateFailure> | null> {
  const api = desktopHost(win)?.rhwpDesktop;
  if (!api?.createNamedNativeDocument) return null;
  try {
    const result = await api.createNamedNativeDocument({
      name: options.name,
      ...(options.folder ? { folder: options.folder } : {}),
      bytes: options.bytes,
    });
    return nativeAgentDocumentResult(result, api, AGENT_CREATE_FAILURES, 'WRITE_FAILED', options.bytes);
  } catch (error) {
    console.warn('[desktop] create named document failed:', error);
    return { ok: false, code: 'WRITE_FAILED' };
  }
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
  /** 대화상자를 이 문서 파일이 있는 폴더에서 연다. */
  nearHandle?: FileSystemFileHandleLike | null,
): Promise<FileSystemFileHandleLike | null | undefined> {
  const api = desktopHost(win)?.rhwpDesktop;
  if (!api?.pickNativeSaveFile) return undefined;
  const suggestedName = options.suggestedName ?? FALLBACK_DOCUMENT_FILE_NAME;
  const match = suggestedName.match(/\.(hwp|hwpx|hml)$/i);
  if (!match) throw new Error('Save target format is unavailable');
  const nearHandleId = nativeFileHandleId(nearHandle);
  const result = await api.pickNativeSaveFile({
    suggestedName,
    extension: match[1]!.toLowerCase() as 'hwp' | 'hwpx' | 'hml',
    ...(nearHandleId ? { handleId: nearHandleId } : {}),
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

/** 앱 업데이트 API. 데스크톱이 아니거나 이를 모르는 preload 면 null. */
export function desktopUpdatesApi(win?: DesktopHost): DesktopUpdatesApi | null {
  return desktopHost(win)?.rhwpDesktop?.updates ?? null;
}

/** 이 창 세션에서 핸들의 메인 쪽 id. 업데이트 재시작이 경로로 바꿔 남긴다. 네이티브 핸들이 아니면 null. */
export function nativeFileHandleId(handle: FileSystemFileHandleLike | null | undefined): string | null {
  return handle ? nativeHandleMetadata.get(handle)?.handleId ?? null : null;
}

/** 업데이트로 다시 켠 창에 메인이 다시 만든 파일 핸들. 쓰지 않으면 releaseUnusedSaveTarget 으로 놓는다. */
export function restoredNativeFileHandle(
  descriptor: NativeFileHandleDescriptor,
  win?: DesktopHost,
): FileSystemFileHandleLike | null {
  const api = desktopHost(win)?.rhwpDesktop;
  if (!api?.readNativeFile || !api.writeNativeFile || !validNativeDescriptor(descriptor)) return null;
  return createNativeFileHandle(descriptor, api, { saveTarget: descriptor.saveTargetCreated !== false });
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

/** 기억한 위치의 파일 상태. missing 은 폴더는 남고 파일만 없을 때, unavailable 은 폴더째 닿지 않을 때다. */
export type NativeDocumentPresence =
  | { state: 'present'; fileName: string; size: number; modifiedAt: number }
  | { state: 'missing' | 'unavailable' | 'unknown' };

/** 데스크톱이 아니면 null. 응답에 없는 문서는 unknown 으로 친다. */
export async function inspectNativeDocuments(
  documentIds: readonly string[],
  win?: DesktopHost,
): Promise<Map<string, NativeDocumentPresence> | null> {
  const api = desktopHost(win)?.rhwpDesktop;
  if (!api?.inspectNativeDocuments) return null;
  const result = new Map<string, NativeDocumentPresence>();
  if (!documentIds.length) return result;
  try {
    for (const item of await api.inspectNativeDocuments([...documentIds])) {
      if (!item || typeof item.documentId !== 'string') continue;
      if (item.state === 'present') {
        if (typeof item.fileName !== 'string' || !item.fileName) continue;
        result.set(item.documentId, {
          state: 'present',
          fileName: item.fileName,
          size: Number(item.size) || 0,
          modifiedAt: Number(item.modifiedAt) || 0,
        });
      } else if (item.state === 'missing' || item.state === 'unavailable') {
        result.set(item.documentId, { state: item.state });
      }
    }
  } catch (error) {
    console.warn('[desktop] native document inspect failed:', error);
    return null;
  }
  return result;
}

/**
 * 옮겨진 문서를 근처 폴더에서 찾아 새 위치로 기억시킨다. 크기와 내용 해시를 맞추는 일은 메인이
 * 한다. 찾았으면 새 파일 이름을 돌려준다.
 */
export async function relocateNativeDocument(
  documentId: string,
  win?: DesktopHost,
): Promise<string | null> {
  const api = desktopHost(win)?.rhwpDesktop;
  if (!api?.relocateNativeDocument) return null;
  const result = await api.relocateNativeDocument(documentId);
  return result && typeof result.fileName === 'string' && result.fileName ? result.fileName : null;
}

export async function readRememberedNativeDocument(
  documentId: string,
  win?: DesktopHost,
): Promise<{ bytes: Uint8Array; fileName: string } | null> {
  const api = desktopHost(win)?.rhwpDesktop;
  if (!api?.readRememberedNativeDocument) return null;
  const result = await api.readRememberedNativeDocument(documentId);
  if (!result || 'ok' in result) return null;
  const checked = checkedNativeFileReadResult(result);
  return { bytes: checked.bytes, fileName: checked.name };
}

/** 기억한 문서를 읽은 결과 — 못 읽었으면 그 이유. */
export type RememberedNativeDocumentRead =
  | { ok: true; bytes: Uint8Array; fileName: string }
  | { ok: false; reason: 'owned' | 'missing' | 'too-large' | 'unreadable'; size?: number };

type RememberedReadFailure = Extract<RememberedNativeDocumentRead, { ok: false }>['reason'];
const REMEMBERED_READ_FAILURES: ReadonlySet<unknown> = new Set<RememberedReadFailure>(['owned', 'missing', 'too-large', 'unreadable']);

/**
 * 다른 문서 읽기용 — {@link readRememberedNativeDocument} 와 같이 읽되 못 읽은 이유(다른 창이 쥠·없음·
 * 너무 큼·잠깐 못 읽음)를 돌려준다. 데스크톱이 아니면 null.
 */
export async function readRememberedNativeDocumentResult(
  documentId: string,
  win?: DesktopHost,
): Promise<RememberedNativeDocumentRead | null> {
  const api = desktopHost(win)?.rhwpDesktop;
  if (!api?.readRememberedNativeDocument) return null;
  const result = await api.readRememberedNativeDocument(documentId, { detailed: true });
  if (!result) return { ok: false, reason: 'unreadable' };
  if ('ok' in result && result.ok === false) {
    const reason = REMEMBERED_READ_FAILURES.has(result.reason) ? result.reason as RememberedReadFailure : 'unreadable';
    const size = (result as { size?: unknown }).size;
    return { ok: false, reason, ...(typeof size === 'number' && Number.isSafeInteger(size) ? { size } : {}) };
  }
  const checked = checkedNativeFileReadResult(result);
  return { ok: true, bytes: checked.bytes, fileName: checked.name };
}

export function canRevealNativeDocument(win?: DesktopHost): boolean {
  return typeof desktopHost(win)?.rhwpDesktop?.revealNativeDocument === 'function';
}

export async function revealNativeDocument(documentId: string, win?: DesktopHost): Promise<boolean> {
  const api = desktopHost(win)?.rhwpDesktop;
  if (!api?.revealNativeDocument) return false;
  return await api.revealNativeDocument(documentId) === true;
}

/**
 * 자동 저장본 복구는 앱의 첫 창만 묻는다. 다른 창에서 띄운 창은 묻지 않고 바로 문서를 연다.
 * 데스크톱이 아니면(웹·확장) 늘 묻는다.
 */
export async function offersAutosaveRecovery(win?: DesktopHost): Promise<boolean> {
  const api = desktopHost(win)?.rhwpDesktop;
  if (!api?.offersAutosaveRecovery) return true;
  try {
    return await api.offersAutosaveRecovery() === true;
  } catch {
    return true;
  }
}

export function canOpenNativeDocumentWindow(win?: DesktopHost): boolean {
  return typeof desktopHost(win)?.rhwpDesktop?.openNativeDocumentWindow === 'function';
}

export async function openNativeDocumentWindow(documentId: string, win?: DesktopHost): Promise<boolean> {
  const api = desktopHost(win)?.rhwpDesktop;
  if (!api?.openNativeDocumentWindow) return false;
  return await api.openNativeDocumentWindow(documentId) === true;
}

/** 파일 관리자 이름. macOS 는 Finder, Windows 는 탐색기. */
export function desktopFileManagerName(win?: DesktopHost): string {
  const platform = desktopHost(win)?.rhwpDesktop?.platform;
  if (platform === 'darwin') return 'Finder';
  if (platform === 'win32') return '탐색기';
  return '파일 관리자';
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

/**
 * 이 페이지가 받은 시작 파일(handleId)과 생성 문서(launchDocumentId). 데스크톱은 페이지를 다시
 * 불러올 때마다 같은 것을 다시 보내므로, 엔진 trap 복구가 다시 여는 페이지는 이미 받은 것을
 * 건너뛴다 — 그러지 않으면 시작 파일이 복구한 문서 위에 다시 열린다.
 */
const deliveredLaunchHandles = new Set<string>();
const deliveredGeneratedDocuments = new Set<string>();

export function deliveredLaunchHandleIds(): string[] {
  return [...deliveredLaunchHandles];
}

export function deliveredGeneratedDocumentIds(): string[] {
  return [...deliveredGeneratedDocuments];
}

export function installDesktopFileHandling(
  openHandles: (handles: FileSystemFileHandleLike[]) => void,
  win?: DesktopHost,
  { skipHandleIds = [] }: { skipHandleIds?: readonly string[] } = {},
) {
  const api = desktopHost(win)?.rhwpDesktop;
  if (!api?.readNativeFile || !api.writeNativeFile) return;
  const seen = new Set<string>(skipHandleIds);
  for (const handleId of skipHandleIds) deliveredLaunchHandles.add(handleId);
  const receive = (descriptors: NativeFileHandleDescriptor[]) => {
    const handles = descriptors
      .filter(validNativeDescriptor)
      .filter((descriptor) => {
        if (seen.has(descriptor.handleId)) return false;
        seen.add(descriptor.handleId);
        deliveredLaunchHandles.add(descriptor.handleId);
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
  { skipLaunchDocumentIds = [] }: { skipLaunchDocumentIds?: readonly string[] } = {},
) {
  const api = desktopHost(win)?.rhwpDesktop;
  if (!api?.onOpenGeneratedDocument) return false;
  const seen = new Set<string>(skipLaunchDocumentIds);
  for (const id of skipLaunchDocumentIds) deliveredGeneratedDocuments.add(id);
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
    deliveredGeneratedDocuments.add(launchDocumentId);
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
 * macOS·Windows Electron 통합 제목 막대 연동.
 *
 * 셸이 titleBarStyle: 'hidden' 으로 뜨므로 메뉴바가 창 최상단을 차지한다.
 * 플랫폼 클래스로 네이티브 창 단추 자리와 드래그 영역을 켜고,
 * 전체 화면에서는 `desktop-fullscreen` 으로 창 단추 여백을 되돌린다.
 */
export function installDesktopWindowChrome(win?: DesktopHost): void {
  if (!isDesktopApp(win) || typeof document === 'undefined') return;
  const api = desktopHost(win)?.rhwpDesktop;
  const platform = api?.platform
    ?? (typeof navigator !== 'undefined' && /Macintosh|Mac OS X/i.test(navigator.userAgent)
      ? 'darwin'
      : '');
  if (platform !== 'darwin' && platform !== 'win32') return;
  const root = document.documentElement;
  root.classList.add(platform === 'darwin' ? 'desktop-mac' : 'desktop-windows');
  if (platform === 'win32') {
    const syncTheme = () => api?.setWindowChromeTheme?.(root.dataset.themeEffective === 'dark');
    new MutationObserver(syncTheme).observe(root, { attributes: true, attributeFilter: ['data-theme-effective'] });
    syncTheme();
  }
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

let lastWindowBackground: string | null = null;

/**
 * 창 배경을 테마의 앱 바탕색에 맞춘다. CSS 색(rgb()·#hex)을 받아 #rrggbb 로 보내고,
 * 같은 값은 다시 보내지 않는다. 읽을 수 없는 색(투명 등)은 건너뛴다.
 */
export function syncDesktopWindowBackground(cssColor: string, win?: DesktopHost): void {
  const setWindowBackground = desktopHost(win)?.rhwpDesktop?.setWindowBackground;
  if (!setWindowBackground) return;
  const rgb = /^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)\s*(?:[,/]\s*([\d.]+%?))?\s*\)$/.exec(cssColor.trim());
  const hex = /^#[0-9a-f]{6}$/i.test(cssColor.trim()) ? cssColor.trim().toLowerCase() : null;
  if (rgb && rgb[4] !== undefined && Number.parseFloat(rgb[4]) < (rgb[4].endsWith('%') ? 100 : 1)) return;
  const color = hex ?? (rgb ? `#${rgb.slice(1, 4).map((value) => Number(value).toString(16).padStart(2, '0')).join('')}` : null);
  if (!color || color === lastWindowBackground) return;
  lastWindowBackground = color;
  setWindowBackground(color);
}

/**
 * 데스크톱의 백그라운드 채팅 알림 — 장부(agent/chat-attention)의 시스템 알림을 메인에 넘기고,
 * 알렸지만 아직 보지 않은 채팅 수를 앱 아이콘 배지로 보낸다. 무엇을 보일지(Dock·작업 표시줄·
 * 런처 배지)는 메인이 플랫폼에 맞게 고른다. 알림을 누르면 openThread 로 그 채팅을 연다.
 * 설치할 때와 해제할 때 0 을 보내 새로고침이 남긴 배지를 지운다.
 */
export function installDesktopAgentAttention(
  ledger: Pick<ChatAttentionLedger, 'subscribe' | 'count'>,
  openThread: (threadId: string) => void,
  win?: DesktopHost,
): () => void {
  const api = desktopHost(win)?.rhwpDesktop;
  if (!api || (!api.notifyAgentAttention && !api.setAgentAttentionCount)) return () => {};
  let lastCount = -1;
  const sendCount = (value: number) => {
    const count = Math.max(0, Math.min(9999, Math.floor(value) || 0));
    if (count === lastCount) return;
    lastCount = count;
    api.setAgentAttentionCount?.(count);
  };
  sendCount(0);
  sendCount(ledger.count());
  const off = ledger.subscribe({
    notice(notice) {
      if (notice.channel !== 'system') return;
      api.notifyAgentAttention?.({ threadId: notice.threadId, title: notice.title, body: notice.body });
    },
    count: sendCount,
  });
  const offOpen = api.onOpenAgentChat?.((threadId) => {
    if (typeof threadId === 'string' && threadId) openThread(threadId);
  });
  return () => {
    off();
    if (typeof offOpen === 'function') offOpen();
    sendCount(0);
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

/** 예전 설치본이 남긴 서비스 워커는 IndexedDB 할당량 정리로 최근문서/자동저장 open을 멈출 수 있어 Electron 셸에서 해제한다. */
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
