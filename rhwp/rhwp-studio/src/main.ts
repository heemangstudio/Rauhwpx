import { WasmBridge, installDeclaredFontAvailabilityProbe, type PreparedWasmDocument } from '@/core/wasm-bridge';
import { installDocumentTitle } from '@/ui/document-title';
import { FALLBACK_DOCUMENT_FILE_NAME } from '@/core/document-names';
import type { DocumentInfo } from '@/core/types';
import { AttachableEventBus } from '@/core/event-bus';
import { createAttachableFacade } from '@/core/attachable-facade';
import { assertRemoteDocumentBytes } from '@/core/document-signature';
import { consumeExactLocalFileRead } from '@/core/local-file-grant';
import {
  EXACT_LOCAL_DOCUMENT_MAX_BYTES,
  INSERTED_IMAGE_MAX_BYTES,
  UNTRUSTED_DOCUMENT_MAX_BYTES,
  cancelResponseBody,
  readBlobBytesWithLimit,
  readResponseBytesWithLimit,
} from '@/core/document-input-limits';
import { RemoteDocumentUrlError, validateRemoteDocumentUrl } from '@/core/remote-document-url';
import { ExtensionRemoteProxyUnavailableError } from '@/core/extension-file-transfer';
import { CanvasView } from '@/view/canvas-view';
import {
  assertEncodedImageDecodeDimensions,
  assertImageDecodeDimensions,
} from '@/view/canvaskit/image-header';
import { InputHandler } from '@/engine/input-handler';
import { Toolbar } from '@/ui/toolbar';
import { EditorToolbarOverflow } from '@/ui/editor-toolbar-overflow';
import { setupTableRibbonMenus, type TableRibbonMenusController } from '@/ui/table-ribbon-menu';
import { EditorStyleOverflow } from '@/ui/editor-style-overflow';
import { setupStatusZoomSlider } from '@/ui/status-zoom';
import { describePaperSize } from '@/ui/status-paper-size';
import { StatusCharacterCounter } from '@/ui/status-character-count';
import { MenuBar } from '@/ui/menu-bar';
import { installDesktopNativeMenu } from '@/desktop-native-menu';
import { loadWebFonts, resolveCanvasKitFontPlan } from '@/core/font-loader';
import { withCanvasKitSurfaceBlockers } from '@/core/canvaskit-document-preflight';
import { loadExtensionViewerSettings, type ExtensionViewerSettings } from '@/core/extension-settings';
import { CommandRegistry } from '@/command/registry';
import { CommandDispatcher } from '@/command/dispatcher';
import { defaultShortcuts, matchShortcut } from '@/command/shortcut-map';
import { detectPlatformKind } from '@/engine/navigation-keymap';
import { allowsDocumentShortcut, isEditorInput, ownsTextInput } from '@/command/shortcut-target';
import type { EditorContext, CommandServices, EditorEditMode } from '@/command/types';
import {
  confirmSaveBeforeReplacingDocument,
  fileCommands,
  locateRecoveryOriginal,
  runLibraryMove,
  runSaveBeforeLeaving,
  whenSavesIdle,
  saveCurrentDocument,
} from '@/command/commands/file';
import { editCommands, openClassicDocumentHistory } from '@/command/commands/edit';
import {
  setBasicToolboxExpanded,
  syncClipMenu,
  syncTextMarkMenu,
  viewCommands,
} from '@/command/commands/view';
import { formatCommands } from '@/command/commands/format';
import { insertCommands } from '@/command/commands/insert';
import { tableCommands } from '@/command/commands/table';
import { pageCommands } from '@/command/commands/page';
import { toolCommands } from '@/command/commands/tool';
import { installPwaFileHandling, type FileHandlingWindowLike } from '@/command/pwa-file-handling';
import {
  captureDroppedFileHandle,
  isSupportedDocumentFileName,
  readFileFromHandle,
  type FileSystemFileHandleLike,
} from '@/command/file-system-access';
import { fileNameForFormat, forgetConvertedHmlSaveHandle } from '@/command/save-target';
import { EngineTrappedError, engineTrap, onEngineTrap, reportEngineTrap } from '@/core/engine-trap';
import { ContextMenu } from '@/ui/context-menu';
import { CommandPalette } from '@/ui/command-palette';
import { showHmlImportWarning } from '@/ui/hml-import-warning';
import { showLocalFontsModalIfNeeded } from '@/ui/local-fonts-modal';
import { showToast } from '@/ui/toast';
import {
  documentSourceDigest,
  resolveDocumentPreflight,
  type DocumentPreflightIdentity,
  type OpenDocumentBytesEvent,
  type VerifiedDocumentGrant,
} from '@/recent/document-preflight';
import { addRecentDoc, listRecentDocs } from '@/recent/recent-store';
import { showDropConfirmDialog } from '@/ui/drop-confirm-dialog';
import { showConfirm } from '@/ui/confirm-dialog';
import type { LibraryDocumentTarget, LibraryMoveResult } from '@/library/move-to-document';
import { initRhwpDev } from '@/core/rhwp-dev';
import type { DocumentDirtyState } from '@/core/document-dirty-state';
import {
  applyTheme,
  getEffectiveTheme,
  getThemeMode,
  initThemeSync,
  setThemeMode,
  syncThemeMenu,
} from '@/core/theme';
import { initWindowActivity } from '@/core/window-activity';
import { analyzeDocumentFonts } from '@/core/document-font-status';
import { createHubFontHost } from '@/core/hub-fonts';
import { configureFontDetection, detectAllFonts, fontDetectionMessage } from '@/core/font-detection';
import { showDocumentFontsDialog } from '@/ui/document-fonts-dialog';
import {
  configureDesktopFonts,
  finalizeDesktopFontReport,
  fontReportsChangedLayout,
  hasSystemFontHost,
  setHubFontHost,
  isDesktopFontIndexReady,
  isDesktopFontsSupported,
  loadDesktopFontIndex,
  prepareDesktopFontsForDocument,
  prepareLocalFontAccessMetrics,
  prepareSystemFontsForDocument,
  settleWithin,
  syncImportedFontMetrics,
  unattemptedDesktopFonts,
  type DesktopFontReport,
} from '@/core/desktop-fonts';
import { takeHftOutlineChange } from '@/core/hft-glyphs';
import {
  chooseFontFolder,
  getFontFolderState,
  isFontFolderSupported,
  onFontFolderStateChange,
  reconnectFontFolder,
  restoreFontFolder,
  type FontFolderState,
} from '@/core/font-folder';
import {
  getLocalFonts, importLocalFontFiles, localFontImportMessage, loadStoredLocalFonts,
  repairLocalFontFacesFor, resolveLocalFont, setActiveDocumentFonts,
} from '@/core/local-fonts';
import { userSettings, type EditorScalarSettings } from '@/core/user-settings';
import type {
  AutosaveBaseInput,
  AutosaveManager,
  AutosaveScheduleSettings,
  AutosaveStatus,
} from '@/recovery/autosave-manager';
import {
  clearRecoverableAutosaveDrafts,
  defaultAutosaveLocks,
  deleteAutosaveDraft,
  getAutosaveDraft,
  getAutosaveDraftBase,
  listAutosaveDrafts,
  listRecoverableAutosaveDrafts,
  markAutosaveDraftsOffered,
  type AutosaveDraft,
  type AutosaveDraftSummary,
} from '@/recovery/autosave-store';
import type { HostSaveTracker } from '@/recovery/host-save';
import {
  MAX_PARALLEL_CHATS,
  chatHoldsDocumentWrites,
  createDocumentSessionCore,
  createDocumentSessionSlotId,
  documentEditingLease,
  isDocumentSessionBusy,
  type ChatSession,
  type DocumentSession,
} from './document-session.ts';
import {
  BLOCKED_RESTORE_MESSAGE,
  offerAutosaveRecovery,
  restoreAutosaveDraft,
  type DraftRestoreOptions,
  type DraftRestoreOutcome,
  type FoundOriginal,
  type MergeExternalResult,
  type OpenDraftOutcome,
  type OpenDraftTarget,
} from '@/recovery/recovery-flow';
import { showAutosaveRecoveryDialog } from '@/recovery/recovery-ui';
import { isPinnedDocumentEnabled, startPinnedDocument } from '@/recovery/pinned-document';
import {
  createTrapRecoveryRun,
  describeTrapOutcome,
  planTrapEntry,
  runTrapRecovery,
  takeTrapManifest,
  type TrapEntryPlan,
  type TrapManifestEntry,
  type TrapOpenResult,
  type TrapRecoveryManifest,
  type TrapRecoveryRun,
} from '@/recovery/trap-recovery';
import { TrapRecoveryPage, presentTrapRecoveryReport } from '@/recovery/trap-recovery-page';
import { holdDocumentLoadingCommands } from '@/recovery/trap-command-guard';
import { markThreadInterruptedByEngineTrap } from '@/recovery/trap-chat-notice';
import { claimForExplorerGroup } from '@/project-file/claim';
import { CellSelectionRenderer } from '@/engine/cell-selection-renderer';
import { TableObjectRenderer } from '@/engine/table-object-renderer';
import { TableResizeRenderer } from '@/engine/table-resize-renderer';
import { Ruler } from '@/view/ruler';
import {
  headerFooterApplyToLabel,
  parseHeaderFooterModeChanged,
} from '@/engine/header-footer-mode';
import { RendererSession, type RendererSessionDiagnostics } from '@/view/renderer-session';
import {
  resolveCanvasKitRenderModeRequest,
  resolveCanvasKitSurfaceRequest,
  resolveRenderBackendRequest,
  resolveRenderProfile,
  type RenderBackendFallbackReason,
} from '@/view/render-backend';
import { calculateFitPageZoom, calculateFitWidthZoom } from '@/view/zoom-fit';
import { installEmbedRuntime } from '@/embed/runtime';
import {
  adoptLoadedNativeFileContent,
  bindNativeFileHandleIdentity,
  cancelDesktopDocument,
  captureDesktopNativeDroppedFile,
  commitDesktopDocument,
  getNativeFileHandleVerifiedDocumentId,
  getRendererSessionContext,
  installDesktopAgentAttention,
  installDesktopCloseHandling,
  installDesktopDocumentState,
  installDesktopFileHandling,
  installDesktopGeneratedDocumentHandling,
  installDesktopPlainTextPasteHandling,
  installDesktopEditCommandHandling,
  installDesktopWindowChrome,
  installWebAppShell,
  isLegacyPortableHistoryFolderHandle,
  pickDesktopNativeOpenFile,
  pickDesktopNativeSaveFile,
  releaseDesktopDocument,
  createAgentHubSession,
  deliveredGeneratedDocumentIds,
  deliveredLaunchHandleIds,
  supportsExtraAgentHubSessions,
  canRenameNativeFile,
  renameNativeDocumentFile,
  NativeRenameRefusedError,
  type AgentHubSessionLease,
  releaseReplacedNativeFileHandle,
  rememberNativeDocument,
  restoreNativeDocument,
  reserveDesktopDocument,
} from '@/desktop-integration';
import { initAgentBridge, type AgentBridge } from './agent/bridge.ts';
import { claimDocumentWriter, syncDocumentWriter } from './agent/document-writer.ts';
import { checkTurnRestore, restoreTurn, type TurnRestoreGates } from './agent/turn-checkpoints.ts';
import { renameThreadsDocument } from './agent/threads.ts';
import { initAgentSidebar } from './ui/agent-sidebar/index.ts';
import { showEditingSettingsFallback } from './ui/agent-sidebar/settings-editing-fallback.ts';
import { AGENT_LABEL } from './ui/agent-sidebar/providers.ts';
import { initInlinePrompt } from './agent/inline-prompt.ts';
import { DocumentVersionController, persistActiveBranch, type VersionAgentView } from './versioning/controller.ts';
import { WorktreeOwnership } from './versioning/worktree-ownership.ts';
import type { VersionWorktree } from './versioning/types.ts';
import {
  VersionGraphStore,
  documentId as versionDocumentId,
  isPortableHistoryBytes,
  isPortableHistoryFileName,
  openPortableHistoryBundle,
  versionErrorCode,
} from './versioning/index.ts';
import type { AgentEditingLease } from './agent/types.ts';
import type { EmbedRendererRuntimeRequestV1 } from '@/embed/rpc-router';
import {
  contextualEditingToolbarMode,
  contextualObjectCommandEnabled,
  type ContextualEditingToolbarMode,
} from '@/ui/contextual-editing-toolbar';
import {
  canGroupTopLevelBodyObjects,
  canUngroupTopLevelBodyObject,
  isTopLevelBodyObject,
  isTopLevelLayerOrderTarget,
  objectAddressScope,
} from '@/core/object-address';

const rendererSessionContextPromise = getRendererSessionContext();

// ─── 문서 세션 ─────────────────────────────
// 열린 문서마다 세션 하나. 화면은 attachedSession 하나에만 붙고, 아래 퍼사드는 그 세션을 가리킨다.
// 에이전트가 일하는 문서는 화면에서 떨어져도 세션째 살아 있어 작업을 이어 간다.
function createSessionCore(slotId?: string): DocumentSession {
  const session = createDocumentSessionCore({
    slotId,
    isReadOnly: () => sessionReadOnly(session),
    autosave: {
      schedule: autosaveScheduleFromUserSettings(),
      locks: defaultAutosaveLocks(),
      onStatus: (session, status) => {
        if (session === attachedSession) handleAutosaveStatus(status);
      },
      owner: rendererSessionContextPromise,
    },
    onDirtyChanged: () => desktopDocumentStateUpdate?.(),
  });
  return session;
}

let desktopDocumentStateUpdate: (() => void) | null = null;
const firstSession = createSessionCore();
const liveSessions: DocumentSession[] = [firstSession];
let attachedSession: DocumentSession = firstSession;
const worktreeStore = new VersionGraphStore();
const worktreeOwnership = new WorktreeOwnership<DocumentSession>(navigator.locks ?? null);
const deniedWorktreeSessions = new WeakSet<DocumentSession>();
const mutatingWorktreeSessions = new WeakSet<DocumentSession>();
const loadingWorktreeSessions = new WeakSet<DocumentSession>();
const openWorktreeDocuments = new Set<string>();
const worktreeWindows = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('rhwp-worktree-windows');
worktreeWindows?.addEventListener('message', () => refreshWorktreeSessions(false));
window.addEventListener('focus', () => refreshWorktreeSessions(false));

function isManagedWorktree(session = attachedSession): boolean {
  return Boolean(session.worktree && !session.worktree.primary);
}

function sessionReadOnly(session = attachedSession): boolean {
  return documentReadOnly || mutatingWorktreeSessions.has(session) || Boolean(session.worktree && !session.worktreeWritable);
}

async function withWorktreeMutation<T>(session: DocumentSession, run: () => Promise<T>): Promise<T> {
  if (mutatingWorktreeSessions.has(session)) throw new Error('워크트리 작업이 끝난 뒤 다시 시도하세요.');
  mutatingWorktreeSessions.add(session);
  if (session === attachedSession) setDocumentReadOnly(documentReadOnly);
  try { return await run(); }
  finally {
    mutatingWorktreeSessions.delete(session);
    if (session === attachedSession) setDocumentReadOnly(documentReadOnly);
  }
}

const wasmFacade = createAttachableFacade<WasmBridge>(firstSession.wasm, {
  stickyKeys: ['onFileNameChanged', 'onExternalImagesInjected'],
});
const wasm = wasmFacade.facade;
installDocumentTitle(wasm, { rename: (name) => renameAttachedDocument(name) });
const eventBus = new AttachableEventBus(firstSession.bus);
const documentStateFacade = createAttachableFacade<DocumentDirtyState>(firstSession.documentState);
const documentState = documentStateFacade.facade;
let disposeAgentSidebar = (): void => {};
const autosaveFacade = createAttachableFacade<AutosaveManager>(firstSession.autosave);
const autosaveManager = autosaveFacade.facade;
/**
 * 엔진 trap 복구는 페이지를 다시 불러와 문서를 모두 다시 연다. 문서를 호스트가 쥐는 고정 문서와
 * 다른 페이지에 들어간 임베드는 다시 불러오면 호스트와의 연결을 잃으므로 예전처럼 사본만 받는다.
 */
function trapRecoveryAvailable(): boolean {
  return !isPinnedDocumentEnabled() && window.parent === window;
}

function sessionStorageOrNull(): Storage | null {
  try { return window.sessionStorage; } catch { return null; }
}

/** 멈춘 페이지가 남긴 다시 열 문서 목록. 읽자마자 지워 복구가 스스로 되풀이되지 않는다. */
const trapManifestToRecover: TrapRecoveryManifest | null = (() => {
  const manifest = takeTrapManifest(sessionStorageOrNull());
  return manifest && trapRecoveryAvailable() ? manifest : null;
})();
/**
 * 다시 연 페이지의 복구 진행. 다시 여는 도중(또는 시작하기 전에) 또 멈추면 다음 목록이 이것을
 * 이어받아, 아직 열지 못한 문서를 잃지 않는다.
 */
const trapRecoveryRun: TrapRecoveryRun<DocumentSession> | null = trapManifestToRecover
  ? createTrapRecoveryRun<DocumentSession>(trapManifestToRecover)
  : null;
/**
 * 멈추기 전 페이지가 멈추려 한 채팅의 스레드. 연결이 끊겨 멈춤이 허브에 닿지 않았으면 다시 불러와도
 * 남는 기본 허브 세션이 그 턴을 계속 돈다 — 그 세션을 받는 첫 채팅이 첫 welcome 에서 멈춘다.
 */
let trapInterruptedThreadIds: string[] = trapManifestToRecover
  ? [...new Set(trapManifestToRecover.entries.flatMap((entry) => entry.interruptedThreadIds))]
  : [];
const trapRecoveryPage = new TrapRecoveryPage({
  sessions: () => liveSessions,
  attached: () => attachedSession,
  saveCopy: saveTrappedDocumentCopy,
  run: () => trapRecoveryRun,
  readOnly: () => documentReadOnly,
  deliveredLaunchHandleIds,
  deliveredGeneratedDocumentIds,
  storage: sessionStorageOrNull,
  reload: () => window.location.reload(),
});

function showTrapRecoveryToast(): void {
  showToast({
    message: '문서 엔진이 멈췄습니다. 열린 문서를 모두 다시 열어 복구할 수 있습니다.',
    durationMs: 0,
    action: { label: '문서 복구', onClick: () => void openTrapRecoveryDialog() },
  });
}

async function openTrapRecoveryDialog(): Promise<void> {
  // 닫으면 페이지를 그대로 두고(읽기만 된다) 안내를 다시 띄운다.
  if (await trapRecoveryPage.openDialog() === 'closed') showTrapRecoveryToast();
}

/**
 * 엔진이 멈춘 창에서 문서를 열거나 만들려고 하면 엔진을 건드리지 않고 문서 복구로 안내한다.
 * 멈춘 엔진에 문서를 올리면 지금 문서를 먼저 해제한 뒤 실패하고 그 복구본까지 지워, 그 문서가
 * 문서 복구에서 빠진다. 멈췄으면 true.
 */
let refusedOpenNoticeUntil = 0;
function refuseDocumentOpenWhileTrapped(): boolean {
  if (!engineTrap()) return false;
  // 한 번의 시도가 여러 길(명령·열기·저장 확인)을 거쳐도, 거듭 눌러도 안내는 하나만 띄운다.
  if (Date.now() < refusedOpenNoticeUntil) return true;
  refusedOpenNoticeUntil = Date.now() + 6000;
  const recoverable = trapRecoveryAvailable();
  showToast({
    message: recoverable
      ? '문서 엔진이 멈춰 문서를 열거나 만들 수 없습니다.\n문서 복구를 먼저 진행하세요.'
      : '문서 엔진이 멈춰 문서를 열거나 만들 수 없습니다.\n사본을 저장한 뒤 앱을 다시 여세요.',
    durationMs: 6000,
    action: recoverable
      ? { label: '문서 복구', onClick: () => void openTrapRecoveryDialog() }
      : { label: '사본 저장', onClick: saveTrappedDocumentCopy },
  });
  return true;
}

onEngineTrap(() => {
  if (!trapRecoveryAvailable()) {
    // 멈춘 엔진이 아직 읽기는 받아 줄 때 지금 상태를 복구본으로 남긴다. 엔진 메모리는 모든 문서가
    // 함께 쓰므로 열린 문서 전부를 남긴다.
    for (const session of liveSessions) void session.autosave.flushNow('engine-trap');
    showToast({
      message: '문서 엔진이 멈춰 편집을 중단했습니다.\n사본을 저장한 뒤 앱을 다시 여세요.',
      durationMs: 0,
      action: { label: '사본 저장', onClick: saveTrappedDocumentCopy },
    });
    return;
  }
  // 멈춘 엔진이 아직 읽기는 받아 줄 때, 바뀐 문서마다 복구본을 하나씩 남기기 시작한다.
  trapRecoveryPage.begin();
  showTrapRecoveryToast();
});
window.addEventListener('pagehide', (event) => {
  if (!event.persisted) {
    disposeAgentSidebar();
    for (const session of liveSessions) {
      void session.versions?.persistWorktree().catch(() => {});
      session.autosave.dispose();
    }
  }
});
initThemeSync((effective, mode) => {
  eventBus.emit('theme-changed', { mode, effective });
  eventBus.emit('command-state-changed');
});
initWindowActivity();
// 2.0.10까지 Cloud 채팅 초안(첨부 바이트 포함)을 담던 DB를 지운다. 없으면 아무 일도 하지 않는다.
try { indexedDB.deleteDatabase('rhwpCloudChatDrafts'); } catch { /* 저장소 접근 불가 */ }

/** 엔진 trap 뒤 저장 명령은 승인·조판 같은 쓰기를 거치므로, 읽기만으로 사본을 내려받는다. */
function saveTrappedDocumentCopy(): void {
  try {
    const bytes = wasm.exportHwpx();
    const base = fileNameForFormat(wasm.fileName, 'hwpx').replace(/\.hwpx$/i, '');
    const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/hwp+zip' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${base} 복구본.hwpx`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (error) {
    console.error('[engine] 멈춘 엔진에서 사본을 만들지 못했습니다:', error);
    showToast({ message: '사본을 만들지 못했습니다. 앱을 다시 열어 자동 저장본으로 복구하세요.', durationMs: 0 });
  }
}

/**
 * 호스트 저장 완료 통지 (#2660).
 *
 * 호스트가 내보내기 바이트의 영속화(업로드/핸드오프)를 마친 뒤 호출한다.
 * 마지막 RPC export 이후 편집이 있으면 dirty 와 복구용 draft 를 남긴다.
 */
const hostSaveFacade = createAttachableFacade<HostSaveTracker>(firstSession.hostSave);
const hostSave = hostSaveFacade.facade;

async function completeHostSave(fileName?: string): Promise<{ ok: true; wasDirty: boolean }> {
  return hostSave.complete(fileName);
}

// 호스트 통합용 공개 API — 팝업/포크 등 SDK 없이 스튜디오 페이지 안에서 통합하는
// 호스트를 위해 프로덕션 빌드에도 항상 노출한다 (iframe 호스트는 embed RPC 사용).
(window as any).rhwpStudio = {
  notifySaved: (fileName?: string) => completeHostSave(fileName),
};

// E2E 테스트용 전역 노출 (개발 모드 전용)
if (import.meta.env.DEV) {
  (window as any).__wasm = wasm;
  (window as any).__eventBus = eventBus;
  (window as any).__documentState = documentState;
  (window as any).__autosaveManager = autosaveManager;
  (window as any).__theme = { getThemeMode, getEffectiveTheme, setThemeMode };
  initRhwpDev(wasm);
}
let canvasView: CanvasView | null = null;
let inputHandler: InputHandler | null = null;
let commandPalette: CommandPalette | null = null;
let toolbar: Toolbar | null = null;
let editorToolbarOverflow: EditorToolbarOverflow | null = null;
let tableRibbonMenus: TableRibbonMenusController | null = null;
let editorStyleOverflow: EditorStyleOverflow | null = null;
let ruler: Ruler | null = null;
let rendererSession: RendererSession | null = null;
let editMode: EditorEditMode = 'normal';
let documentReadOnly = new URLSearchParams(window.location.search).get('templatePreview') === '1';
let agentEditingLease: AgentEditingLease = { active: false, agent: 'codex' };
let rendererRuntimeRequest: EmbedRendererRuntimeRequestV1 | null = null;
let renderBackendFallbackReason: RenderBackendFallbackReason | null = null;
let rendererInitializationError: string | null = null;
let rendererInitialized = false;

class DocumentOwnedElsewhereError extends Error {
  constructor() {
    super('다른 창에서 이미 열려 있는 문서입니다.');
    this.name = 'DocumentOwnedElsewhereError';
  }
}

let extensionViewerSettings: ExtensionViewerSettings = {
  disableExternalWebFonts: false,
};

/** 제한 시간을 넘겨 늦게 도착한 웹폰트로 이미 그린 페이지를 다시 그린다. */
function repaintAfterLateWebFonts(): void {
  if (wasm.hasLoadedDocument()) eventBus.emit('document-view-changed');
}

function createActiveDocumentId(): string {
  return globalThis.crypto?.randomUUID?.()
    ?? `document_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}


// ─── 커맨드 시스템 ─────────────────────────────
const registry = new CommandRegistry();

function getContext(): EditorContext {
  // 엔진이 멈춘 뒤에는 엔진을 부르지 않는다. 명령 상태를 갱신할 때마다 EngineTrappedError 가
  // 나지 않도록, 복구(문서 복구)까지는 문서가 없는 읽기 전용 상태로 둔다.
  if (engineTrap()) return trappedEditorContext();
  const hasDoc = wasm.pageCount > 0;
  const canEditFormField = inputHandler?.canEditCurrentFormField() ?? false;
  const isFormMode = editMode === 'form';
  const selectedObject = inputHandler?.getSelectedPictureRef() ?? null;
  const selectedObjects = inputHandler?.getSelectedPictureRefs() ?? [];
  return {
    hasDocument: hasDoc,
    hasSelection: inputHandler?.hasSelection() ?? false,
    hasCopiedFormat: inputHandler?.hasCopiedFormat() ?? false,
    inTable: inputHandler?.isInTable() ?? false,
    inCellSelectionMode: inputHandler?.isInCellSelectionMode() ?? false,
    hasMultiCellSelection: inputHandler?.hasMultiCellSelection() ?? false,
    hasTableTransposeClipboard: wasm.hasTableTransposeClipboard(),
    inTableObjectSelection: inputHandler?.isInTableObjectSelection() ?? false,
    inPictureObjectSelection: inputHandler?.isInPictureObjectSelection() ?? false,
    canArrangeSelectedObject: !!selectedObject && isTopLevelLayerOrderTarget(selectedObject),
    canGroupSelectedObjects: canGroupTopLevelBodyObjects(selectedObjects),
    canUngroupSelectedObject: canUngroupTopLevelBodyObject(selectedObject),
    inField: inputHandler?.isInField() ?? false,
    isEditable: !sessionReadOnly() && !agentEditingLease.active && (!isFormMode || canEditFormField),
    readOnly: sessionReadOnly(),
    userEditingLocked: agentEditingLease.active,
    editMode,
    isFormMode,
    canEditFormField,
    canUndo: inputHandler?.canUndo() ?? false,
    canRedo: inputHandler?.canRedo() ?? false,
    zoom: canvasView?.getViewportManager().getZoom() ?? 1.0,
    showControlCodes: wasm.getShowControlCodes(),
    showParagraphMarks: wasm.getShowParagraphMarks(),
    isDirty: documentState.isDirty(),
    sourceFormat: hasDoc ? (wasm.getSourceFormat() as 'hwp' | 'hwpx' | 'hml') : undefined,
  };
}

/** 엔진이 멈춘 창의 명령 상태 — 엔진을 부르지 않고 모든 편집 명령을 끈다. */
function trappedEditorContext(): EditorContext {
  return {
    hasDocument: false,
    hasSelection: false,
    hasCopiedFormat: false,
    inTable: false,
    inCellSelectionMode: false,
    hasMultiCellSelection: false,
    hasTableTransposeClipboard: false,
    inTableObjectSelection: false,
    inPictureObjectSelection: false,
    canArrangeSelectedObject: false,
    canGroupSelectedObjects: false,
    canUngroupSelectedObject: false,
    inField: false,
    isEditable: false,
    readOnly: true,
    userEditingLocked: true,
    editMode,
    isFormMode: editMode === 'form',
    canEditFormField: false,
    canUndo: false,
    canRedo: false,
    zoom: canvasView?.getViewportManager().getZoom() ?? 1.0,
    showControlCodes: false,
    showParagraphMarks: false,
    isDirty: documentState.isDirty(),
    sourceFormat: undefined,
  };
}

function setEditMode(mode: EditorEditMode): void {
  editMode = mode;
  inputHandler?.setEditMode(mode);
  document.documentElement.dataset.editMode = mode;
  document.querySelectorAll('[data-cmd="view:form-mode"]').forEach(el => {
    el.classList.toggle('active', mode === 'form');
  });
  sbMessage().textContent = mode === 'form' ? '양식 모드' : '기본 편집 모드';
  eventBus.emit('edit-mode-changed', mode);
  eventBus.emit('command-state-changed');
}

function setDocumentReadOnly(readOnly: boolean): void {
  documentReadOnly = readOnly;
  document.documentElement.dataset.documentReadOnly = sessionReadOnly() ? 'true' : 'false';
  inputHandler?.setReadOnly(sessionReadOnly());
  // 멈춘 엔진에는 쪽 수를 묻지 않는다 (버전 기록이 작업 공간 점유를 다시 맞출 때도 여기를 지난다).
  toolbar?.setEnabled(!engineTrap() && wasm.pageCount > 0 && !sessionReadOnly() && !agentEditingLease.active);
  eventBus.emit('command-state-changed');
}

function setAgentEditingLease(lease: AgentEditingLease): void {
  agentEditingLease = lease;
  document.documentElement.dataset.agentEditing = lease.active ? 'true' : 'false';
  const editorArea = document.getElementById('editor-area');
  const frame = document.getElementById('agent-editing-frame');
  const status = document.getElementById('agent-editing-status');
  const statusLabel = document.getElementById('agent-editing-status-label');
  if (editorArea) editorArea.dataset.editingAgent = lease.agent;
  editorArea?.setAttribute('aria-busy', lease.active ? 'true' : 'false');
  if (frame) frame.hidden = !lease.active;
  if (status) status.hidden = !lease.active;
  if (statusLabel) {
    statusLabel.textContent = `${AGENT_LABEL[lease.agent]}가 문서를 편집 중이에요`;
    if (lease.waitingForUser) statusLabel.textContent = `${AGENT_LABEL[lease.agent]}가 답변을 기다리고 있어요`;
  }
  inputHandler?.setUserEditingLocked(agentEditingLease.active);
  toolbar?.setEnabled(wasm.pageCount > 0 && !sessionReadOnly() && !agentEditingLease.active);
  scheduleCharacterStatus();
  eventBus.emit('command-state-changed');
}

let agentSidebarReady = false;

eventBus.on('settings:open', (payload) => {
  if (agentSidebarReady) return;
  const destination = (payload as { destination?: unknown } | undefined)?.destination;
  if (destination !== undefined && destination !== 'editing') return;
  showEditingSettingsFallback({
    eventBus,
    runtime: {
      preview: applyEditorSettingsPreview,
      committed: commitEditorSettingsRuntime,
    },
  });
});

const commandServices: CommandServices = {
  eventBus,
  wasm,
  documentState,
  getContext,
  getInputHandler: () => inputHandler,
  getViewportManager: () => canvasView?.getViewportManager() ?? null,
  pickOpenHandle: pickDesktopNativeOpenFile,
  pickSaveHandle: pickDesktopNativeSaveFile,
  validateSaveHandle: reserveSaveHandleForWrite,
  canSaveDocument: () => !sessionReadOnly(),
  createPortableHistoryBundle: async () => {
    if (!attachedSession.versions) throw new Error('버전 기록 서비스를 사용할 수 없습니다.');
    return attachedSession.versions.createPortableHistoryBundle();
  },
  isManagedWorktree: () => isManagedWorktree(),
  saveManagedWorktree: async () => {
    const session = attachedSession;
    if (!isManagedWorktree(session)) return false;
    if (!session.versions) throw new Error('워크트리 저장 서비스를 사용할 수 없습니다.');
    await session.versions.saveManagedWorktree();
    return true;
  },
  persistManagedWorktree: async () => {
    if (!isManagedWorktree()) return;
    if (!attachedSession.versions) throw new Error('워크트리 저장 서비스를 사용할 수 없습니다.');
    await attachedSession.versions.persistWorktree();
  },
  setEditMode,
  opensDocumentsInNewSession: () => shouldOpenInNewSession(),
  getPendingAgentEdits: () => {
    // 한 문서의 채팅 중 문서를 고친 채팅의 검토 대기 변경을 모두 본다.
    const chats = () => attachedSession.chats.filter((chat) => chat.bridge.pendingEdits.hasPending());
    if (chats().length === 0) return null;
    const sets = () => chats().flatMap((chat) => chat.bridge.pendingEdits.getChangeSets()
      .filter((set) => set.ops.length > 0)
      .map((set) => ({ chat, set })));
    return {
      opCount: sets().reduce((sum, { set }) => sum + set.ops.length, 0),
      approveAll: () => sets().every(({ chat, set }) => chat.bridge.pendingEdits.approve(set.id)),
      rejectAll: () => { for (const chat of chats()) chat.bridge.pendingEdits.rejectAll(); },
    };
  },
};

installDesktopCloseHandling(async () => {
  if (!await confirmCloseWithBackgroundSessions()) return false;
  const allowClose = await canReplaceCurrentDocument();
  if (allowClose) {
    for (const session of liveSessions) session.documentState.permitNextUnload();
  }
  return allowClose;
});

const dispatcher = new CommandDispatcher(registry, commandServices, eventBus);

// 모든 내장 커맨드 등록
registry.registerAll(fileCommands);
registry.registerAll(editCommands);
registry.registerAll(viewCommands);
registry.registerAll(formatCommands);
registry.registerAll(insertCommands);
registry.registerAll(tableCommands);
registry.registerAll(pageCommands);
registry.registerAll(toolCommands);
// 엔진이 멈춘 뒤의 열기·새 문서는 저장 확인과 파일 선택 전에 문서 복구로 안내한다.
holdDocumentLoadingCommands(registry, refuseDocumentOpenWhileTrapped);

// 상태 바 요소
const sbMessage = () => document.getElementById('sb-message')!;
const sbPage = () => document.getElementById('sb-page')!;
const sbSection = () => document.getElementById('sb-section')!;
const sbZoomVal = () => document.getElementById('sb-zoom-val')!;
const sbPaper = () => document.getElementById('sb-paper')!;
const sbCount = () => document.getElementById('sb-count')!;
let statusSectionIndex = 0;
let paperStatusFrame = 0;
let characterStatusFrame = 0;
let characterRecountTimer: ReturnType<typeof setTimeout> | null = null;
const CHARACTER_RECOUNT_IDLE_MS = 150;
const statusCharacterCounter = new StatusCharacterCounter();
const statusNumber = new Intl.NumberFormat('ko-KR');

function updatePaperStatus(): void {
  paperStatusFrame = 0;
  const paper = sbPaper();
  try {
    if (wasm.getSectionCount() === 0) {
      paper.textContent = '—';
      paper.title = '용지 크기';
      return;
    }
    const size = describePaperSize(wasm.getPageDef(statusSectionIndex));
    paper.textContent = size.label;
    paper.title = size.title;
  } catch {
    paper.textContent = '—';
    paper.title = '용지 크기';
  }
}

function schedulePaperStatus(): void {
  if (!paperStatusFrame) paperStatusFrame = requestAnimationFrame(updatePaperStatus);
}

function updateCharacterStatus(): void {
  characterStatusFrame = 0;
  const indicator = sbCount();
  if (!inputHandler) {
    indicator.textContent = '0글자';
    indicator.title = '문서 글자 수';
    return;
  }
  try {
    if (wasm.getSectionCount() === 0) {
      indicator.textContent = '0글자';
      indicator.title = '문서 글자 수';
      return;
    }
    const { current, total, scope } = statusCharacterCounter.read(wasm, inputHandler);
    indicator.textContent = scope === 'document'
      ? `${statusNumber.format(total)}글자`
      : `${statusNumber.format(current)}/${statusNumber.format(total)}글자`;
    indicator.title = scope === 'selection'
      ? '선택한 글자 / 전체 글자'
      : scope === 'cell' ? '현재 셀 글자 / 전체 글자' : '문서 글자 수';
  } catch (error) {
    console.warn('[status] 글자 수를 읽지 못했습니다:', error);
    indicator.textContent = '—';
    indicator.title = '글자 수를 읽지 못했습니다';
  }
}

function scheduleCharacterStatus(invalidate = false): void {
  if (invalidate) {
    cancelCharacterRecount();
    statusCharacterCounter.invalidate();
  }
  if (!characterStatusFrame) characterStatusFrame = requestAnimationFrame(updateCharacterStatus);
}

/** 편집 뒤 전체 글자 수는 문서 전체를 다시 세므로 타이핑이 멈춘 뒤 한 번만 갱신한다. */
function scheduleCharacterRecount(): void {
  cancelCharacterRecount();
  characterRecountTimer = setTimeout(() => {
    characterRecountTimer = null;
    scheduleCharacterStatus(true);
  }, CHARACTER_RECOUNT_IDLE_MS);
}

function cancelCharacterRecount(): void {
  if (characterRecountTimer === null) return;
  clearTimeout(characterRecountTimer);
  characterRecountTimer = null;
}
let autosaveStatusRestoreTimer: ReturnType<typeof setTimeout> | null = null;
let autosavePreviousMessage: string | null = null;

function autosaveScheduleFromUserSettings(): AutosaveScheduleSettings {
  const settings = userSettings.getAutosaveSettings();
  return {
    recoveryEnabled: settings.recoveryEnabled,
    recoveryIntervalMs: settings.recoveryIntervalMinutes * 60_000,
    idleEnabled: settings.idleSaveEnabled,
    idleDelayMs: settings.idleDelaySeconds * 1_000,
  };
}

function handleAutosaveStatus(status: AutosaveStatus): void {
  const message = document.getElementById('sb-message');
  if (!message) return;
  if (autosaveStatusRestoreTimer) {
    clearTimeout(autosaveStatusRestoreTimer);
    autosaveStatusRestoreTimer = null;
  }

  if (status.state === 'saving') {
    if (autosavePreviousMessage === null) {
      autosavePreviousMessage = message.textContent ?? '';
    }
    message.textContent = '복구용 자동 저장 중...';
    return;
  }

  const restoreTarget = autosavePreviousMessage;
  autosavePreviousMessage = null;
  const nextMessage = status.state === 'saved'
    ? `복구용 자동 저장 완료 (${formatBytes(status.byteLength)})`
    : '복구용 자동 저장 실패';
  message.textContent = nextMessage;
  if (restoreTarget !== null) {
    autosaveStatusRestoreTimer = setTimeout(() => {
      if (message.textContent === nextMessage) {
        message.textContent = restoreTarget;
      }
      autosaveStatusRestoreTimer = null;
    }, status.state === 'saved' ? 1_600 : 4_000);
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kib = bytes / 1024;
  if (kib < 1024) return `${kib.toFixed(1)} KiB`;
  return `${(kib / 1024).toFixed(1)} MiB`;
}

function waitForNextPaint(): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    window.setTimeout(finish, 50);
    requestAnimationFrame(() => requestAnimationFrame(finish));
  });
}

async function updateLoadProgress(percent: number, label: string): Promise<void> {
  const safePercent = Math.max(0, Math.min(100, Math.round(percent)));
  sbMessage().textContent = `파일 로딩 ${safePercent}% - ${label}`;
  await waitForNextPaint();
}

/** 문서 로드가 데스크톱 글꼴 연결을 기다리는 최대 시간. 넘기면 백그라운드에서 마저 연결한다. */
const DESKTOP_FONT_LOAD_BUDGET_MS = 4000;
/** 입력 중에는 문서 글꼴 목록을 이 간격에 한 번만 다시 읽는다. */
const DESKTOP_FONT_EDIT_INTERVAL_MS = 600;
let desktopFontEditTimer: ReturnType<typeof setTimeout> | null = null;
let desktopFontEditCheckedAt = -Infinity;

/** 브라우저에서 저장된 글꼴 폴더를 다시 연결하는 작업. 첫 문서 로드가 잠깐 기다린다. */
let fontFolderRestore: Promise<unknown> | null = null;

function initializeDesktopFonts(): void {
  // "로컬 글꼴 감지"는 설치 글꼴·데스크톱·허브·글꼴 폴더를 한 번에 모두 돌린다.
  configureFontDetection({
    documentFonts: () => {
      try {
        return wasm.pageCount > 0 ? wasm.getDocumentInfo().fontsUsed : undefined;
      } catch {
        return undefined;
      }
    },
    applyReports: (reports) => {
      applyLateFontReports(reports);
      eventBus.emit('local-fonts-changed', {
        fonts: getLocalFonts({ includeRegistered: true }),
        source: 'detect-all',
      });
      prepareCanvasKitLocalFonts(wasm.getDocumentInfo().fontsUsed);
      prepareLocalFontRepairs(wasm.getDocumentInfo().fontsUsed);
    },
  });
  // 런타임 메트릭은 데스크톱·글꼴 폴더·가져온 파일·로컬 글꼴 감지 모두에 쓴다.
  configureDesktopFonts({
    metrics: wasm.getRuntimeFontMetricsApi(),
    onLateRegistration: applyLateDesktopFontReport,
  });
  if (isDesktopFontsSupported()) {
    // 첫 문서가 열리기 전에 색인을 미리 받아 둔다.
    void loadDesktopFontIndex().catch((error) => {
      console.warn('[DesktopFonts] 글꼴 색인 준비 실패:', error);
    });
    return;
  }
  if (!isFontFolderSupported()) return;
  installFontFolderStatusButton();
  onFontFolderStateChange(handleFontFolderState);
  fontFolderRestore = restoreFontFolder().catch((error) => {
    console.warn('[FontFolder] 저장된 글꼴 폴더를 다시 연결하지 못했습니다:', error);
  });
}

/** 권한을 다시 받아야 할 때만 상태 바에 한 번 누르는 버튼을 띄운다. */
function installFontFolderStatusButton(): void {
  const button = document.getElementById('sb-font-folder') as HTMLButtonElement | null;
  if (!button) return;
  button.addEventListener('click', () => {
    // 권한 요청은 클릭 처리 안에서 바로 해야 한다.
    reconnectFontFolder().catch((error) => {
      console.warn('[FontFolder] 다시 연결 실패:', error);
      showToast({ message: '글꼴 폴더를 다시 연결하지 못했습니다.', durationMs: 5000 });
    });
  });
}

function handleFontFolderState(state: FontFolderState): void {
  const button = document.getElementById('sb-font-folder') as HTMLButtonElement | null;
  if (button) button.hidden = state.status !== 'needs-permission';
  if (state.status === 'connected') connectPendingDocumentFonts();
}

/**
 * 브라우저에서 로컬 에이전트 허브가 내주는 설치 글꼴을 쓴다. 폴더 선택·권한 요청이 필요 없다.
 * 데스크톱 preload나 연결한 글꼴 폴더가 있으면 그쪽이 먼저다.
 */
/** 허브 글꼴 색인은 창 하나에 하나다. 지금 붙은 세션의 브리지부터, 없으면 연결된 아무 브리지로 연다. */
function installHubFonts(): void {
  if (isDesktopFontsSupported()) return;
  setHubFontHost(createHubFontHost({
    access: () => attachedSession.bridge?.getHubFontAccess()
      ?? allChats().map((chat) => chat.bridge.getHubFontAccess()).find(Boolean)
      ?? null,
  }));
}

/** 글꼴 색인 host가 새로 준비되면 열린 문서에서 아직 시도하지 않은 글꼴을 연결한다. */
function connectPendingDocumentFonts(): void {
  if (wasm.pageCount === 0 || !hasSystemFontHost()) return;
  let fontsUsed: string[] | undefined;
  try {
    fontsUsed = wasm.getDocumentInfo().fontsUsed;
  } catch {
    return;
  }
  const pending = unattemptedDesktopFonts(fontsUsed);
  if (!pending.length) return;
  void prepareDesktopFontsForDocument(pending)
    .then((report) => {
      applyLateDesktopFontReport(report);
      updateFontStatusButton();
    })
    .catch((error) => console.warn('[SystemFonts] 문서 글꼴 연결 실패:', error));
}

/** 문서 로드 뒤에 끝난 연결 결과를 레이아웃·화면·CanvasKit에 반영한다. */
function applyLateDesktopFontReport(report: DesktopFontReport): void {
  applyLateFontReports([report]);
}

function applyLateFontReports(reports: readonly DesktopFontReport[]): void {
  // HFT 윤곽선은 폭을 바꾸지 않지만 같은 경로로 다시 그린다.
  const hftChanged = takeHftOutlineChange();
  if (fontReportsChangedLayout(reports) || hftChanged) eventBus.emit('font-files-imported');
  for (const report of reports) finalizeDesktopFontReport(report);
}

/** 로컬 글꼴 감지 결과가 바뀌면 현재 문서 글꼴의 레이아웃 메트릭을 등록한다. */
function syncLocalFontAccessMetrics(): void {
  let fontsUsed: string[] | undefined;
  try {
    fontsUsed = wasm.pageCount > 0 ? wasm.getDocumentInfo().fontsUsed : undefined;
  } catch {
    return;
  }
  if (!fontsUsed?.length) return;
  void prepareLocalFontAccessMetrics(fontsUsed)
    .then((report) => {
      if (report && report.totals.metricsRegistered > 0) applyLateFontReports([report]);
    })
    .catch((error) => console.warn('[LocalFonts] 레이아웃 메트릭 등록 실패:', error));
}

/**
 * 편집·에이전트·붙여넣기로 새 글꼴이 문서에 들어오면 데스크톱 글꼴에서 찾아 연결한다.
 * 글꼴 메뉴로 바꾼 글꼴은 바로 읽기 시작하고, 이어지는 입력은 간격마다 한 번만 확인한다.
 */
function scheduleDesktopFontSync(): void {
  if (!hasSystemFontHost() || desktopFontEditTimer !== null) return;
  const wait = Math.max(0, desktopFontEditCheckedAt + DESKTOP_FONT_EDIT_INTERVAL_MS - performance.now());
  desktopFontEditTimer = setTimeout(() => {
    desktopFontEditTimer = null;
    desktopFontEditCheckedAt = performance.now();
    let fontsUsed: string[] | undefined;
    try {
      fontsUsed = wasm.getDocumentInfo().fontsUsed;
    } catch {
      return;
    }
    const pending = unattemptedDesktopFonts(fontsUsed);
    if (!pending.length) return;
    void prepareDesktopFontsForDocument(pending)
      .then(applyLateDesktopFontReport)
      .catch((error) => console.warn('[DesktopFonts] 새 글꼴 연결 실패:', error));
  }, wait);
}

/**
 * 실제 글꼴로 보이지 않는 문서 글꼴이 있으면 상태 바에 "글꼴 N개 대체됨"을 띄운다.
 * 누르면 대체된 글꼴과 대신 쓰는 글꼴, 연결된 글꼴 목록을 연다.
 */
function updateFontStatusButton(): void {
  const button = document.getElementById('sb-font-status') as HTMLButtonElement | null;
  if (!button) return;
  let fontsUsed: string[] | undefined;
  try {
    fontsUsed = wasm.pageCount > 0 ? wasm.getDocumentInfo().fontsUsed : undefined;
  } catch {
    fontsUsed = undefined;
  }
  const report = fontsUsed?.length ? analyzeDocumentFonts(fontsUsed) : null;
  const substituted = report ? report.total - report.summary.available : 0;
  button.hidden = substituted <= 0;
  button.textContent = substituted > 0 ? `글꼴 ${substituted}개 대체됨` : '';
}

function installFontStatusButton(): void {
  const button = document.getElementById('sb-font-status') as HTMLButtonElement | null;
  if (!button) return;
  button.addEventListener('click', () => {
    let fontsUsed: string[] | undefined;
    try {
      fontsUsed = wasm.getDocumentInfo().fontsUsed;
    } catch {
      return;
    }
    if (!fontsUsed?.length) return;
    const offerFolder = !isDesktopFontsSupported() && isFontFolderSupported()
      && getFontFolderState().status !== 'connected';
    showDocumentFontsDialog(analyzeDocumentFonts(fontsUsed), {
      sourceFileFor: (name) => resolveLocalFont(name)?.sourcePath?.split(/[\\/]/).pop() ?? null,
      connectFolder: offerFolder
        ? () => {
          const connect = getFontFolderState().status === 'needs-permission' ? reconnectFontFolder : chooseFontFolder;
          connect().catch((error: unknown) => {
            console.warn('[FontFolder] 연결 실패:', error);
            showToast({ message: '글꼴 폴더를 연결하지 못했습니다.', durationMs: 5000 });
          });
        }
        : null,
    });
  });
  for (const event of ['local-fonts-changed', 'font-files-imported'] as const) {
    eventBus.on(event, updateFontStatusButton);
  }
}

/**
 * CanvasKit은 browser CSS font fallback을 사용하지 않는다. 초기 페이지를 먼저 표시한 뒤,
 * 저장된 권한 범위 안에서 필요한 local face를 준비하고 등록된 경우에만 다시 그린다.
 */
/** 설치 글꼴 중 합성 글리프 bbox 가 잘린 face 를 복구해 Canvas2D 에 등록하고, 등록되면 다시 그린다. */
function prepareLocalFontRepairs(fontNames: readonly string[] | undefined): void {
  if (!fontNames?.length) return;
  const requestedFonts = [...fontNames];
  void (async () => {
    await loadStoredLocalFonts();
    if (await repairLocalFontFacesFor(requestedFonts)) eventBus.emit('document-view-changed');
  })().catch((error) => {
    console.warn('[LocalFonts] 설치 글꼴 복구 등록 실패, 설치 글꼴로 계속 표시합니다:', error);
  });
}

function prepareCanvasKitLocalFonts(fontNames: readonly string[] | undefined): void {
  const renderer = canvasView?.getRenderBackend() === 'canvaskit'
    ? rendererSession?.getCanvasKitRenderer() ?? null
    : null;
  if (!renderer || !fontNames?.length) return;
  const requestedFonts = [...fontNames];
  void (async () => {
    await loadStoredLocalFonts();
    await renderer.prepareLocalFonts(requestedFonts);
    if (
      renderer === rendererSession?.getCanvasKitRenderer()
      && canvasView?.getRenderBackend() === 'canvaskit'
    ) {
      // 등록 성공 여부와 관계없이 pending 진단이 끝난 상태를 page snapshot에 반영한다.
      eventBus.emit('document-view-changed');
    }
  })().catch((error) => {
    console.warn('[CanvasKit] 로컬 Typeface 준비 실패, 기본 fallback으로 계속 표시합니다:', error);
  });
}

async function initialize(): Promise<void> {
  installWebAppShell();
  installDesktopWindowChrome();
  installDesktopDocumentState({
    subscribe: (update) => {
      desktopDocumentStateUpdate = update;
      for (const name of ['document-context-changed', 'document-dirty-changed', 'document-saved']) {
        eventBus.on(name, update);
      }
    },
    hasDocument: () => wasm.hasLoadedDocument(),
    // 창의 편집됨 표시는 뒤에 열려 있는 문서의 저장하지 않은 변경도 친다.
    isDirty: () => liveSessions.some((session) => session.documentState.isDirty()),
  });
  editorStyleOverflow = new EditorStyleOverflow(document.getElementById('style-bar')!);
  const msg = sbMessage();
  try {
    extensionViewerSettings = await loadExtensionViewerSettings();
    if (extensionViewerSettings.disableExternalWebFonts) {
      console.info('[main] 외부 웹폰트 사용 안 함 옵션이 켜져 있습니다.');
    }
    msg.textContent = extensionViewerSettings.disableExternalWebFonts
      ? 'WASM 및 로컬 폰트 준비 중...'
      : 'WASM 및 웹폰트 로딩 중...';
    // 대체 CSS 별칭이 원본 설치 여부를 가리지 않도록 등록 전에 측정한다.
    installDeclaredFontAvailabilityProbe();
    // OS 폰트 감지·CSS 등록을 먼저 시작하고, 네트워크 로드와 WASM 컴파일은 겹친다.
    // 첫 문서 조판은 두 작업이 준비된 뒤에만 진행한다.
    await Promise.all([
      loadWebFonts([], undefined, { ...extensionViewerSettings, onLateLoad: repaintAfterLateWebFonts }),
      wasm.initialize(),
    ]);
    if (import.meta.env.DEV && import.meta.env.VITE_RHWP_DEV_FONT_PACK === '1') {
      msg.textContent = '글꼴 준비 중...';
      const { loadConfiguredDevFontPack } = await import('./core/dev-font-pack.ts');
      await loadConfiguredDevFontPack((loaded, total) => {
        msg.textContent = `글꼴 준비 중... (${loaded}/${total})`;
      });
    }
    if (import.meta.env.DEV) {
      initRhwpDev(wasm);
    }
    initializeDesktopFonts();
    const renderBackendRequest = resolveRenderBackendRequest(window.location.search);
    const canvaskitModeRequest = resolveCanvasKitRenderModeRequest(window.location.search);
    const canvaskitMode = canvaskitModeRequest.mode;
    const canvaskitSurfaceRequest = resolveCanvasKitSurfaceRequest(window.location.search);
    const renderProfile = resolveRenderProfile(window.location.search);
    const diagnosticsBackendRequest: EmbedRendererRuntimeRequestV1['backend'] =
      renderBackendRequest.backend === 'auto'
        ? { ...renderBackendRequest, backend: 'canvas2d' }
        : { ...renderBackendRequest, backend: renderBackendRequest.backend };
    rendererRuntimeRequest = {
      backend: diagnosticsBackendRequest,
      canvaskitMode: canvaskitModeRequest,
      canvaskitSurface: canvaskitSurfaceRequest,
      renderProfile,
    };
    if (renderBackendRequest.unsupportedReason) {
      console.warn(
        `[main] 지원하지 않는 renderer 값입니다: ${renderBackendRequest.requested}; Canvas2D를 사용합니다.`,
      );
    }
    if (canvaskitModeRequest.unsupportedReason) {
      console.warn(
        `[main] 지원하지 않는 CanvasKit mode입니다: ${canvaskitModeRequest.requested}; default를 사용합니다.`,
      );
    }
    renderBackendFallbackReason = renderBackendRequest.unsupportedReason ?? null;
    rendererSession = new RendererSession(
      renderBackendRequest,
      canvaskitModeRequest,
      canvaskitSurfaceRequest,
      renderProfile,
      async (mode, surface) => {
        msg.textContent = 'CanvasKit 로딩 중...';
        const { CanvasKitLayerRenderer } = await import('@/view/canvaskit-renderer');
        return CanvasKitLayerRenderer.create(mode, surface, {
          requirePreparedFontFamilies: renderBackendRequest.backend === 'auto',
        });
      },
      {
        transformCanvasKitPreflight(report) {
          const plan = resolveCanvasKitFontPlan(
            report.requiredFontFamilies,
            extensionViewerSettings,
          );
          const blockers = plan.unavailableFonts.map(font => `fontUnavailable:${font}`);
          if (wasm.getShowControlCodes()) blockers.push('viewOption:showControlCodes');
          return withCanvasKitSurfaceBlockers(
            report,
            blockers,
          );
        },
        async prepareCanvasKitDocument(renderer, report) {
          const plan = resolveCanvasKitFontPlan(
            report.requiredFontFamilies,
            extensionViewerSettings,
          );
          if (plan.unavailableFonts.length > 0) {
            throw new Error(`CanvasKit font family가 준비되지 않았습니다: ${plan.unavailableFonts.join(', ')}`);
          }
          await renderer.prepareBundledFonts(plan.sources);
        },
      },
    );
    msg.textContent = 'HWP 파일을 선택해주세요.';

    const container = document.getElementById('scroll-container')!;
    canvasView = new CanvasView(
      container,
      wasm,
      eventBus,
      rendererSession,
    );

    // [#3313] 외부 연결 그림(HWP3 pic_type=0)의 비동기 주입이 첫 렌더 이후에 끝나면
    // 화면이 이전 프레임(그림 없는 상태)에 머무른다. 주입 완료 시 뷰 문서를 다시
    // 로드해 페이지 트리를 재구성한다 — dirty 마킹 없는 뷰 전용 갱신.
    wasm.onExternalImagesInjected = () => {
      void canvasView?.loadDocument();
    };

    // 눈금자 초기화
    ruler = new Ruler(
      document.getElementById('h-ruler') as HTMLCanvasElement,
      document.getElementById('v-ruler') as HTMLCanvasElement,
      container,
      eventBus,
      wasm,
      canvasView.getVirtualScroll(),
      canvasView.getViewportManager(),
    );

    inputHandler = new InputHandler(
      container, wasm, eventBus,
      canvasView.getVirtualScroll(),
      canvasView.getViewportManager(),
      // 처음 붙은 문서 세션과 같은 히스토리를 쓴다 — 세션 단위 기록(턴 체크포인트)이 같은 것을 본다.
      attachedSession.editorState.history,
    );
    inputHandler.setEditMode(editMode);
    inputHandler.setReadOnly(sessionReadOnly());
    inputHandler.setUserEditingLocked(agentEditingLease.active);

    toolbar = new Toolbar(document.getElementById('style-bar')!, wasm, eventBus, dispatcher);
    toolbar.setEnabled(false);

    // InputHandler에 커맨드 디스패처 및 컨텍스트 메뉴 주입
    inputHandler.setDispatcher(dispatcher);
    inputHandler.setContextMenu(new ContextMenu(dispatcher, registry));
    commandPalette = new CommandPalette(registry, dispatcher);
    inputHandler.setCommandPalette(commandPalette);
    const commandSearch = document.getElementById('editor-command-search');
    if (commandSearch) {
      const shortcutLabel = detectPlatformKind() === 'mac' ? '⌘/' : 'Ctrl+/';
      const shortcut = commandSearch.querySelector('kbd');
      if (shortcut) shortcut.textContent = shortcutLabel;
      commandSearch.title = `명령 검색 (${shortcutLabel})`;
      commandSearch.addEventListener('click', () => commandPalette?.open());
    }
    inputHandler.setCellSelectionRenderer(
      new CellSelectionRenderer(container, canvasView.getVirtualScroll()),
    );
    inputHandler.setTableObjectRenderer(
      new TableObjectRenderer(container, canvasView.getVirtualScroll()),
    );
    inputHandler.setTableResizeRenderer(
      new TableResizeRenderer(container, canvasView.getVirtualScroll()),
    );
    inputHandler.setPictureObjectRenderer(
      new TableObjectRenderer(container, canvasView.getVirtualScroll(), true),
    );

    new MenuBar(document.getElementById('menu-bar')!, eventBus, dispatcher, registry, {
      onMenuOpen: (menuName) => {
        if (menuName === 'file') void renderRecentSubmenu();
      },
    });
    installDesktopNativeMenu({ menuBar: document.getElementById('menu-bar')!, dispatcher, registry, eventBus });

    // 툴바 내 data-cmd 버튼 클릭 → 커맨드 디스패치
    // (.tb-btn + 서식바 접기 버튼 .sb-collapse-btn)
    document.querySelectorAll('.tb-btn[data-cmd], .sb-collapse-btn[data-cmd]').forEach(btn => {
      btn.addEventListener('mousedown', (e) => {
        e.preventDefault();
        const cmd = (btn as HTMLElement).dataset.cmd;
        if (cmd) dispatcher.dispatch(cmd, { anchorEl: btn as HTMLElement });
      });
      (btn as HTMLElement).addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        const cmd = (btn as HTMLElement).dataset.cmd;
        if (cmd && dispatcher.isEnabled(cmd)) dispatcher.dispatch(cmd, { anchorEl: btn as HTMLElement });
      });
    });

    // 스플릿 버튼 드롭다운 메뉴
    document.querySelectorAll('.tb-split').forEach(split => {
      const arrow = split.querySelector('.tb-split-arrow');
      if (arrow) {
        arrow.addEventListener('mousedown', (e) => {
          e.preventDefault();
          e.stopPropagation();
          // 다른 열린 메뉴 닫기
          document.querySelectorAll('.tb-split.open').forEach(s => {
            if (s !== split) s.classList.remove('open');
          });
          split.classList.toggle('open');
        });
      }
      split.querySelectorAll('.tb-split-item[data-cmd]').forEach(item => {
        item.addEventListener('mousedown', (e) => {
          e.preventDefault();
          split.classList.remove('open');
          const cmd = (item as HTMLElement).dataset.cmd;
          if (cmd) dispatcher.dispatch(cmd, { anchorEl: item as HTMLElement });
        });
      });
    });
    // 외부 클릭 시 스플릿 메뉴 닫기
    document.addEventListener('mousedown', () => {
      document.querySelectorAll('.tb-split.open').forEach(s => s.classList.remove('open'));
    });

    // #780: 도구 모음/서식 도구 모음 영역 mousedown 시 focus 이동 방지
    // — 편집 영역의 텍스트 선택(cursor.anchor)이 보존되어야 서식 적용이 동작함
    for (const id of ['icon-toolbar', 'style-bar']) {
      const el = document.getElementById(id);
      if (el) el.addEventListener('mousedown', (e) => {
        if ((e.target as HTMLElement).tagName !== 'INPUT' && (e.target as HTMLElement).tagName !== 'SELECT') {
          e.preventDefault();
        }
      });
    }

    setupFileInput();
    setupZoomControls();
    setupEventListeners();
    tableRibbonMenus = setupTableRibbonMenus(
      document.getElementById('icon-toolbar')!,
      (command, anchor) => {
        const fromOverflow = Boolean(anchor.closest('#editor-toolbar-overflow'));
        dispatcher.dispatch(command, { anchorEl: anchor });
        if (fromOverflow) editorToolbarOverflow?.closePopover();
      },
      (command) => dispatcher.isEnabled(command),
    );
    editorToolbarOverflow = new EditorToolbarOverflow(document.getElementById('icon-toolbar')!);
    editorStyleOverflow?.refresh();
    setupGlobalShortcuts();
    installDesktopFileHandling((handles) => {
      const handle = handles[0];
      if (!handle) return;
      void readFileFromHandle(handle)
        .then(({ bytes, name }) => openDocumentBytes({
          bytes,
          fileName: name,
          fileHandle: handle,
        }))
        .catch(async (error) => {
          await handle.releaseUnusedSaveTarget?.().catch(() => {});
          if (!(error instanceof DocumentOwnedElsewhereError)) showLoadError(error);
        });
    }, undefined, { skipHandleIds: trapManifestToRecover?.deliveredLaunchHandleIds ?? [] });
    installDesktopGeneratedDocumentHandling(({ bytes, fileName, readOnly }) => {
      if (readOnly) setDocumentReadOnly(true);
      eventBus.emit('open-document-bytes', { bytes, fileName });
    }, undefined, { skipLaunchDocumentIds: trapManifestToRecover?.deliveredGeneratedDocumentIds ?? [] });
    installDesktopEditCommandHandling((command) => {
      const target = document.activeElement;
      if (ownsTextInput(target) && !isEditorInput(target)) {
        document.execCommand(command === 'select-all' ? 'selectAll' : command);
        return;
      }
      if (!allowsDocumentShortcut(target) || !inputHandler?.isActive()) return;
      inputHandler.finalizeCompositionBeforeCursorMove();
      inputHandler.focus();
      dispatcher.dispatch(`edit:${command}`);
    });
    installDesktopPlainTextPasteHandling((text) => {
      inputHandler?.performPlainTextPaste(text);
    });
    if (trapManifestToRecover) {
      // 엔진 trap 복구로 다시 불러온 페이지다. URL 문서 대신 멈추기 전에 열려 있던 문서를 다시 연다.
      void recoverDocumentsAfterTrap(trapRecoveryRun!);
    } else {
      if (isPinnedDocumentEnabled()) void loadPinnedDocument();
      else void loadFromUrlParam();
      void offerAutosaveRecoveryAtStartup();
    }
    installPwaFileHandling(window as FileHandlingWindowLike, {
      openDocumentBytes(payload) {
        eventBus.emit('open-document-bytes', payload);
      },
      notifyUnsupportedFile(fileName) {
        showLoadError(new Error(`지원하지 않는 파일 형식입니다: ${fileName}. HWP/HWPX/HML/RHWPX 파일만 지원합니다.`));
      },
      notifyError(error) {
        showLoadError(error);
      },
      notifyMultipleFiles(count) {
        console.warn(`[pwa-file-handling] 여러 파일(${count}개)이 전달되어 첫 번째 파일만 엽니다.`);
      },
    });

    // E2E 테스트용 전역 노출 (개발 모드 전용)
    if (import.meta.env.DEV) {
      (window as any).__inputHandler = inputHandler;
      (window as any).__canvasView = canvasView;
      (window as any).__rendererSession = rendererSession;
      (window as any).__renderBackend = null;
      (window as any).__renderBackendRequest = renderBackendRequest;
      (window as any).__rendererRuntimeRequest = rendererRuntimeRequest;
      (window as any).__renderBackendFallbackReason = renderBackendFallbackReason;
      (window as any).__canvaskitRenderMode = canvaskitMode;
      (window as any).__canvaskitSurfaceRequest = canvaskitSurfaceRequest;
      (window as any).__renderProfile = renderProfile;
    }

    // AI 페어 에디팅: 문서 세션마다 허브 브리지 + 버전 기록 + 사이드바를 둔다.
    // 선택(opt-in) 기능이므로 여기서 실패해도 렌더러 초기화를 실패로 만들지 않는다.
    try {
      installWindowAgentAttention();
      installChatAgent(firstSession, null, true);
      installHubFonts();
      disposeAgentSidebar = () => {
        for (const chat of allChats()) chat.sidebar.dispose();
        disposeAgentSidebar = () => {};
      };
      agentSidebarReady = true;
      reinstallInlinePrompt();
      if (import.meta.env.DEV) {
        Object.defineProperty(window, '__agentBridge', {
          configurable: true,
          get: () => attachedSession.bridge,
        });
        Object.defineProperty(window, '__versionController', {
          configurable: true,
          get: () => attachedSession.versions,
        });
        (window as any).__dispatcher = dispatcher;
        (window as any).__documentSessions = {
          list: () => [...liveSessions],
          attached: () => attachedSession,
        };
      }
    } catch (agentError) {
      console.error('[main] 에이전트 사이드바 초기화 실패 (기능 비활성화):', agentError);
    }

    rendererInitialized = true;
  } catch (error) {
    rendererInitializationError = error instanceof Error ? error.message : String(error);
    msg.textContent = `초기화 실패: ${error}`;
    console.error('[main] 초기화 실패:', error);
  }
}

// ─── 문서 세션 전환 ─────────────────────────────

/** 문서 세션에 버전 기록을 단다. 버전 기록은 그 문서의 채팅들을 합쳐 본다. */
function installDocumentVersions(session: DocumentSession): DocumentVersionController {
  if (session.versions) return session.versions;
  if (!inputHandler) throw new Error('편집기가 아직 준비되지 않았습니다.');
  const editor = inputHandler;
  session.versions = new DocumentVersionController({
    wasm: session.wasm,
    eventBus: session.bus,
    documentState: session.documentState,
    getInputHandler: () => (attachedSession === session ? editor : null),
    getDocumentId: () => session.documentId,
    agentBridge: documentAgentView(session),
    autoEnable: () => userSettings.getUseHancomGit(),
    worktreeHost: {
      ensureOwnership: (worktree) => ensureWorktreeOwnership(session, worktree),
      canMutate: () => !documentReadOnly && !loadingWorktreeSessions.has(session)
        && (!session.worktree || session.worktreeWritable),
      getStatus: (worktree) => {
        const live = liveSessionForDocument(worktree.documentId);
        return {
          isOpen: Boolean(live) || openWorktreeDocuments.has(worktree.documentId),
          readOnly: Boolean(live && !live.worktreeWritable),
          busy: live
            ? !live.worktreeWritable || mutatingWorktreeSessions.has(live) || isDocumentSessionBusy(live) || documentAgentView(live).pendingEdits.hasPending()
            : openWorktreeDocuments.has(worktree.documentId),
        };
      },
      open: (worktree) => runNavigation(async () => { await openWorktreeSession(worktree); }),
      close: (worktree) => runNavigation(() => closeWorktreeSession(worktree)),
      remove: (worktree) => runNavigation(async () => { await removeWorktreeSession(worktree); return true; }),
      merge: (worktree) => runNavigation(() => mergeWorktreeSession(worktree)),
    },
  });
  return session.versions;
}

async function ensureWorktreeOwnership(session: DocumentSession, worktree: VersionWorktree): Promise<boolean> {
  if (session.documentId !== worktree.documentId) return false;
  if (session.worktree?.documentId !== worktree.documentId) deniedWorktreeSessions.delete(session);
  const alreadyOwned = worktreeOwnership.owns(session, worktree.documentId);
  session.worktree = worktree;
  session.worktreeWritable = alreadyOwned;
  if (deniedWorktreeSessions.has(session)) return false;
  if (session === attachedSession) setDocumentReadOnly(documentReadOnly);
  const writable = await worktreeOwnership.claim(session, worktree.documentId);
  if (session.documentId !== worktree.documentId || !liveSessions.includes(session)) {
    worktreeOwnership.release(session);
    return false;
  }
  session.worktreeWritable = writable;
  if (!writable) deniedWorktreeSessions.add(session);
  if (writable && !alreadyOwned) refreshWorktreeSessions();
  if (session === attachedSession) setDocumentReadOnly(documentReadOnly);
  return writable;
}

function refreshWorktreeSessions(broadcast = true): void {
  if (broadcast) worktreeWindows?.postMessage('changed');
  void (async () => {
    if (navigator.locks?.query) {
      const state = await navigator.locks.query();
      openWorktreeDocuments.clear();
      for (const lock of state.held ?? []) {
        if (lock.name?.startsWith('rhwp-worktree:')) openWorktreeDocuments.add(lock.name.slice('rhwp-worktree:'.length));
      }
    }
    for (const session of liveSessions) {
      void session.versions?.refresh().catch((error) => console.warn('[worktrees] 작업 공간 갱신 실패:', error));
    }
  })().catch((error) => console.warn('[worktrees] 창 상태 확인 실패:', error));
}

function assertWorktreeIdle(session: DocumentSession): void {
  if (!session.worktreeWritable) throw new Error('다른 창에서 이 워크트리를 편집하고 있습니다.');
  if (isDocumentSessionBusy(session) || documentAgentView(session).pendingEdits.hasPending()) {
    throw new Error('에이전트 작업과 변경 검토를 마친 뒤 다시 시도하세요.');
  }
}

/** 저장한 작업 공간의 바이트를 새 세션에 연다. 문서 ID와 파일 핸들을 복제하지 않는다. */
async function openWorktreeSession(requested: VersionWorktree): Promise<DocumentSession> {
  let worktree = await worktreeStore.getWorktree(requested.id);
  if (!worktree) throw new Error('워크트리가 삭제되었습니다.');
  const existing = liveSessionForDocument(worktree.documentId);
  if (existing) {
    await attachSession(existing);
    if (!existing.worktreeWritable) {
      // 다른 창의 오래된 화면을 편집 가능하게 바꾸지 않는다. 명시적으로 열 때 최신 바이트를 복구한다.
      if (!await worktreeOwnership.claim(existing, worktree.documentId)) {
        throw new Error('다른 창에서 이 워크트리를 편집하고 있습니다.');
      }
      loadingWorktreeSessions.add(existing);
      try {
        await withWorktreeMutation(existing, async () => {
          const fresh = await worktreeStore.getWorktree(requested.id);
          const blob = fresh ? await worktreeStore.getBlob(fresh.blobId) : null;
          if (!fresh || !blob) throw new Error('워크트리의 문서 데이터를 찾을 수 없습니다.');
          deniedWorktreeSessions.delete(existing);
          await loadBytes(blob.bytes, fresh.fileName, null, performance.now(), {
            skipRecent: true, suppressDialogs: true, worktreeSnapshot: true,
            grant: { kind: 'verified', documentId: fresh.documentId },
          });
        });
      } catch (error) {
        existing.worktreeWritable = false;
        deniedWorktreeSessions.add(existing);
        worktreeOwnership.release(existing);
        throw error;
      } finally {
        loadingWorktreeSessions.delete(existing);
        refreshWorktreeSessions();
      }
    }
    return existing;
  }
  const previous = attachedSession;
  const session = await createLiveSession();
  if (!session) throw new Error('열린 문서나 채팅을 닫은 뒤 다시 시도하세요.');
  session.documentId = worktree.documentId;
  session.worktree = worktree;
  let reopenedHandle: FileSystemFileHandleLike | null = null;
  try {
    if (!await ensureWorktreeOwnership(session, worktree)) {
      throw new Error('다른 창에서 이 워크트리를 편집하고 있습니다.');
    }
    worktree = await worktreeStore.getWorktree(requested.id);
    if (!worktree) throw new Error('워크트리가 삭제되었습니다.');
    session.worktree = worktree;
    const blob = await worktreeStore.getBlob(worktree.blobId);
    if (!blob) throw new Error('워크트리의 문서 데이터를 찾을 수 없습니다.');
    await attachSession(session);
    // 파일이 외부에서 바뀌었으면 복구한 작업 내용에 그 파일의 쓰기 권한을 붙이지 않는다.
    let handle: FileSystemFileHandleLike | null = null;
    let nativeSourceBytes: Uint8Array | undefined;
    if (worktree.primary) {
      const recent = (await listRecentDocs()).find((entry) => entry.documentId === worktree!.documentId);
      const native = await restoreNativeDocument(worktree.documentId);
      if (native === 'owned') throw new Error('다른 창에서 원본 문서를 편집하고 있습니다.');
      reopenedHandle = native ?? (recent?.handle?.identityKind === 'native-path' ? null : recent?.handle ?? null);
      if (reopenedHandle) {
        try {
          const bytes = await readBlobBytesWithLimit(await reopenedHandle.getFile(), EXACT_LOCAL_DOCUMENT_MAX_BYTES, '원본 문서');
          if (recent && documentSourceDigest(bytes) === recent.sourceDigest) {
            handle = reopenedHandle;
            nativeSourceBytes = bytes;
          }
        } catch { /* 원본 파일 없이도 저장한 작업 공간을 복구할 수 있다. */ }
        if (!handle) {
          await reopenedHandle.releaseUnusedSaveTarget?.().catch(() => {});
          reopenedHandle = null;
        }
      }
    }
    await loadBytes(blob.bytes, worktree.fileName, handle, performance.now(), {
      skipRecent: true,
      worktreeSnapshot: true,
      suppressDialogs: true,
      grant: { kind: 'verified', documentId: worktree.documentId },
      nativeSourceBytes,
    });
    if (!session.wasm.hasLoadedDocument() || session.documentId !== worktree.documentId) {
      throw new Error('워크트리 문서를 열지 못했습니다.');
    }
    refreshWorktreeSessions();
    return session;
  } catch (error) {
    if (attachedSession === session && liveSessions.includes(previous)) await attachSession(previous);
    await disposeSession(session, { persistWorktree: false });
    await reopenedHandle?.releaseUnusedSaveTarget?.().catch(() => {});
    throw error;
  }
}

async function closeWorktreeSession(worktree: VersionWorktree, removed = false): Promise<void> {
  const session = liveSessionForDocument(worktree.documentId);
  if (!session) return;
  if (mutatingWorktreeSessions.has(session)) return closeWorktreeSessionNow(worktree, removed);
  return withWorktreeMutation(session, () => closeWorktreeSessionNow(worktree, removed));
}

async function closeWorktreeSessionNow(worktree: VersionWorktree, removed: boolean): Promise<void> {
  const session = liveSessionForDocument(worktree.documentId);
  if (!session) return;
  assertWorktreeIdle(session);
  if (!removed) await session.versions?.persistWorktree();
  if (session === attachedSession) {
    let next = liveSessions.find((candidate) => candidate !== session && candidate.worktree?.repositoryId === worktree.repositoryId)
      ?? liveSessions.find((candidate) => candidate !== session);
    if (!next) {
      const primary = (await worktreeStore.listWorktrees(worktree.repositoryId)).find((candidate) => candidate.primary && candidate.id !== worktree.id);
      if (primary) next = await openWorktreeSession(primary);
      else next = await createLiveSession() ?? undefined;
    }
    if (!next) throw new Error('워크트리를 닫을 화면을 준비하지 못했습니다.');
    await attachSession(next);
  }
  await disposeSession(session, { persistWorktree: !removed });
  refreshWorktreeSessions();
}

async function removeWorktreeSession(requested: VersionWorktree): Promise<void> {
  const worktree = await worktreeStore.getWorktree(requested.id);
  if (!worktree) return;
  if (worktree.primary) throw new Error('기본 작업 공간은 삭제할 수 없습니다.');
  const previous = attachedSession;
  const session = await openWorktreeSession(worktree);
  assertWorktreeIdle(session);
  await withWorktreeMutation(session, async () => {
    try {
      await session.versions!.checkpoint();
    } catch (error) {
      if (versionErrorCode(error) !== 'NO_CHANGES') throw error;
    }
    await session.versions!.persistWorktree();
    const persisted = await worktreeStore.getWorktree(worktree.id);
    if (!persisted) return;
    await worktreeStore.deleteWorktree({ id: persisted.id, expectedRevision: persisted.revision });
    if (previous !== session && liveSessions.includes(previous)) await attachSession(previous);
    await closeWorktreeSession(persisted, true);
  });
}

async function mergeWorktreeSession(requested: VersionWorktree): Promise<void> {
  const source = await worktreeStore.getWorktree(requested.id);
  if (!source || source.primary || !source.mergeTarget) throw new Error('병합할 워크트리와 대상 브랜치를 찾을 수 없습니다.');
  const sourceSession = await openWorktreeSession(source);
  assertWorktreeIdle(sourceSession);
  const { sourceRevision, sourceSnapshot } = await withWorktreeMutation(sourceSession, async () => {
    try {
      await sourceSession.versions!.checkpoint();
    } catch (error) {
      if (versionErrorCode(error) !== 'NO_CHANGES') throw error;
    }
    await sourceSession.versions!.persistWorktree();
    const sourceRevision = sourceSession.documentState.captureRevision();
    const sourceSnapshot = await worktreeStore.getWorktree(source.id);
    if (!sourceSnapshot) throw new Error('병합할 워크트리가 삭제되었습니다.');
    return { sourceRevision, sourceSnapshot };
  });
  let target = (await worktreeStore.listWorktrees(source.repositoryId)).find((candidate) => (
    candidate.branch === source.mergeTarget!.name && candidate.branchGeneration === source.mergeTarget!.generation
  ));
  if (!target) {
    if (allChats().length >= MAX_PARALLEL_CHATS) throw new Error('열린 문서나 채팅을 닫은 뒤 다시 병합하세요.');
    const [repository, branch] = await Promise.all([
      worktreeStore.getRepository(source.repositoryId),
      worktreeStore.getBranch(source.repositoryId, source.mergeTarget.name),
    ]);
    if (!repository || !branch || branch.generation !== source.mergeTarget.generation) {
      throw new Error('병합 대상 브랜치가 삭제되었거나 새로 만들어졌습니다.');
    }
    target = await worktreeStore.createWorktree({
      repositoryId: repository.id, documentId: versionDocumentId(createActiveDocumentId()),
      branch: branch.name, fileName: source.fileName, sourceFormat: source.sourceFormat,
      expectedRepositoryRevision: repository.revision, expectedBranchRevision: branch.revision,
      mergeTarget: null,
    });
  }
  const targetSession = await openWorktreeSession(target);
  assertWorktreeIdle(targetSession);
  await targetSession.versions!.startMerge(source.branch, {
    onCompleted: async () => {
      await withWorktreeMutation(sourceSession, async () => {
        // 검토 중 원본에 새 편집이 생겼으면 병합한 시점 뒤의 변경을 지우지 않는다.
        if (!liveSessions.includes(sourceSession) || sourceSession.documentState.captureRevision() !== sourceRevision) {
          throw new Error('검토 중 워크트리가 변경되어 삭제하지 않았습니다.');
        }
        assertWorktreeIdle(sourceSession);
        const current = await worktreeStore.getWorktree(source.id);
        if (!current) return;
        if (current.blobId !== sourceSnapshot.blobId || current.baseCommitId !== sourceSnapshot.baseCommitId) {
          throw new Error('검토 중 워크트리의 저장 내용이 변경되어 삭제하지 않았습니다.');
        }
        await worktreeStore.deleteWorktree({ id: current.id, expectedRevision: current.revision });
        await closeWorktreeSession(current, true);
      });
    },
  });
}

type ChatPendingChange = Parameters<Parameters<ChatSession['bridge']['pendingEdits']['onChange']>[0]>[0];

/** 문서마다 그 문서 채팅들의 이벤트를 모아 듣는 곳 (나중에 생긴 채팅도 포함). */
const documentTaps = new WeakMap<DocumentSession, {
  events: Set<(event: AttentionEvent) => void>;
  pending: Set<(event: ChatPendingChange) => void>;
  modeLock: Set<() => void>;
}>();

function tapsFor(session: DocumentSession) {
  let taps = documentTaps.get(session);
  if (!taps) {
    taps = { events: new Set(), pending: new Set(), modeLock: new Set() };
    documentTaps.set(session, taps);
  }
  return taps;
}

/** 문서의 채팅들을 하나의 에이전트처럼 보이게 한다 (버전 기록용). */
function documentAgentView(session: DocumentSession): VersionAgentView {
  const taps = tapsFor(session);
  const ownerOf = (changeSetId: string) => session.chats.find((chat) => (
    chat.bridge.pendingEdits.getChangeSets().some((set) => set.id === changeSetId)
  ));
  return {
    getEditingLease: () => documentEditingLease(session),
    isTurnRunning: () => session.chats.some((chat) => chat.bridge.isTurnRunning()),
    onEvent: (cb) => {
      taps.events.add(cb);
      return () => { taps.events.delete(cb); };
    },
    requestCheckpointTitle: (input) => {
      const chat = session.chats.find(chatHoldsDocumentWrites) ?? session.activeChat;
      return chat ? chat.bridge.requestCheckpointTitle(input) : Promise.resolve(null);
    },
    pendingEdits: {
      getChangeSets: () => session.chats.flatMap((chat) => [...chat.bridge.pendingEdits.getChangeSets()]),
      hasPending: () => session.chats.some((chat) => chat.bridge.pendingEdits.hasPending()),
      approve: (changeSetId, opts) => ownerOf(changeSetId)?.bridge.pendingEdits.approve(changeSetId, opts) ?? false,
      reject: (changeSetId) => { ownerOf(changeSetId)?.bridge.pendingEdits.reject(changeSetId); },
      onChange: (cb) => {
        taps.pending.add(cb);
        return () => { taps.pending.delete(cb); };
      },
    },
  };
}

function allChats(): ChatSession[] {
  return liveSessions.flatMap((session) => session.chats);
}

/** 같은 문서의 다른 채팅이 문서를 고치는 중이면 이 채팅은 채팅 모드만 쓴다. */
function chatModeLockFor(chat: ChatSession): { reason: string } | null {
  // 문서를 고치고 있는 채팅은 스스로 잠기지 않는다 (잠그면 그 채팅의 계획·모드를 잃는다).
  if (chatHoldsDocumentWrites(chat)) return null;
  return chat.document.chats.some((other) => other !== chat && chatHoldsDocumentWrites(other))
    ? { reason: '다른 채팅이 이 문서를 편집하고 있어요' }
    : null;
}

/**
 * 되돌리기를 막을 만큼 채팅이 일하는 중인가 — 턴·도구 호출·보낸 메시지·질문. 검토 대기 편집만
 * 남은 채팅(따로 알린다)과 승인을 기다리는 계획만 있는 채팅은 일하는 중으로 보지 않는다.
 */
function chatWorksOnDocument(bridge: AgentBridge): boolean {
  if (bridge.isTurnRunning() || bridge.getEditingLease().active) return true;
  if (!bridge.isBusy() || bridge.pendingEdits.hasPending()) return false;
  const { workflow, phase } = bridge.getWorkflowState();
  return !(workflow === 'plan' && phase === 'awaiting-approval');
}

/**
 * 채팅의 쓰기 상태가 바뀌었다. 문서를 고칠 채팅(writer)을 먼저 맞추고 잠금을 다시 읽힌다.
 * changed 는 방금 바뀐 채팅 — 문서가 비어 있을 때 먼저 쥔 그 채팅이 주인이 된다.
 */
function notifyChatModeLock(session: DocumentSession, changed?: ChatSession): void {
  syncDocumentWriter(session, changed);
  for (const listener of tapsFor(session).modeLock) listener();
}

/**
 * 문서 세션에 채팅 하나를 단다 — 브리지, 사이드바. active 면 그 문서에서 보이는 채팅이 된다.
 * 화면에 붙은 문서의 채팅은 바로 화면을 쓰고, 아니면 편집기 대역으로 문서를 고친다.
 */
function installChatAgent(
  session: DocumentSession,
  hubSession: AgentHubSessionLease | null,
  active: boolean,
): ChatSession {
  if (!inputHandler || !canvasView) throw new Error('편집기가 아직 준비되지 않았습니다.');
  const editor = inputHandler;
  const view = { inputHandler: editor, canvasView };
  const versions = installDocumentVersions(session);
  const documentShown = () => attachedSession === session;
  const docAttached = documentShown();
  let chat: ChatSession | undefined;
  const bridge = initAgentBridge({
    wasm: session.wasm,
    eventBus: session.bus,
    documentState: session.documentState,
    editor: docAttached ? editor : session.editorHost,
    view: docAttached ? view : null,
    isReadOnly: () => sessionReadOnly(session),
    commitVersion: async (message) => {
      await versions.checkpoint(message);
    },
    // 같은 문서의 다른 채팅이 고치는 중이면 이 채팅의 쓰기는 문서에 닿지 않는다.
    claimDocumentWrite: () => chat !== undefined && claimDocumentWriter(session, chat),
    turnCheckpoints: session.turnCheckpoints,
  }, hubSession ? { resolveSessionContext: hubSession.resolveContext } : takeTrapInterruptedTurnOptions());
  const shown = () => documentShown() && chat !== undefined && session.activeChat === chat;
  /** 이 작업 전으로 되돌리기의 문 — 엔진, 화면, 이 문서의 채팅들, 읽기 전용. */
  const restoreGates: TurnRestoreGates = {
    engineStopped: () => engineTrap() !== null,
    documentShown,
    turnRunning: () => session.chats.some(({ bridge: other }) => chatWorksOnDocument(other)),
    reviewPending: () => session.chats.some(({ bridge: other }) => other.pendingEdits.hasPending()),
    readOnly: () => sessionReadOnly(session) || editMode === 'form',
    apply: (snapshotId) => editor.restoreDocumentSnapshot(snapshotId),
  };
  const sidebar = initAgentSidebar({
    bridge,
    eventBus: session.bus,
    startActive: active && docAttached,
    editorSettingsRuntime: {
      preview: applyEditorSettingsPreview,
      committed: commitEditorSettingsRuntime,
    },
    versionController: versions,
    getAgentUndoEntry: () => (shown() ? editor.getAgentUndoEntry() : null),
    undoAgentTurn: (entry) => (shown() ? editor.undoAgentTurn(entry) : false),
    turnRestore: {
      noteTurnStart: (threadId, key) => session.turnCheckpoints.noteTurnStart(threadId, key),
      status: (threadId, key) => session.turnCheckpoints.status(threadId, key),
      check: (threadId, key) => checkTurnRestore(session.turnCheckpoints, threadId, key, restoreGates),
      restore: (threadId, key) => {
        const result = restoreTurn(session.turnCheckpoints, threadId, key, restoreGates);
        // 이 채팅의 다음 요청에 문서를 되돌렸다는 안내를 붙인다 (에이전트가 되돌린 편집을 믿지 않게).
        if (result.ok) bridge.noteDocumentRestored();
        return result;
      },
      subscribe: (listener) => session.turnCheckpoints.subscribe(listener),
    },
    navigateToChange: (position, anchor) => {
      if (!shown()) return;
      if (anchor && position.cellIndex === undefined) {
        position = { ...position, cursorRect: { ...anchor } };
      }
      editor.moveCursorTo(position);
    },
    openClassicVersionControl: () => openClassicDocumentHistory(commandServices),
    getDocumentContext: () => {
      const doc = session.wasm;
      const documentName = doc.pageCount > 0 ? doc.fileName : null;
      let selectionLabel: string | null = null;
      if (documentShown() && editor.getSelectedPictureRef()) {
        selectionLabel = '개체 선택됨';
      } else if (documentShown() && editor.hasSelection()) {
        selectionLabel = '텍스트 선택됨';
      }
      return {
        documentId: session.documentId,
        documentName,
        selectionLabel,
        pageCount: doc.pageCount,
      };
    },
    moveToLibraryDocument: (target, options) => moveFromSession(session, target, options),
    openThreadDocument: (thread) => moveFromSession(
      session,
      { documentId: thread.documentId, fileName: thread.docKey },
      { commit: true, threadId: thread.id },
    ),
    openChat: (request) => (chat ? openChatFromChat(chat, request) : Promise.resolve('handled' as const)),
    renameDocument: async (name) => {
      const result = await renameDocumentInSession(session, name);
      if (result.ok) return result.fileName;
      showToast({ message: result.message, durationMs: 3200 });
      return null;
    },
    chatModeLock: {
      // 사이드바는 만들어지는 동안 잠금을 한 번 읽는다. 그때는 채팅이 아직 없다 (잠금 없음).
      get: () => (chat ? chatModeLockFor(chat) : null),
      subscribe: (listener) => {
        const listeners = tapsFor(session).modeLock;
        listeners.add(listener);
        return () => { listeners.delete(listener); };
      },
    },
    createDocument: () => { dispatcher.dispatch('file:new-doc'); },
    openDocumentFile: () => { dispatcher.dispatch('file:open'); },
    listRecentDocuments: async () => (await listRecentDocs())
      .slice(0, 20)
      .map(({ documentId, fileName, sourceFormat, openedAt }) => (
        { documentId, fileName, sourceFormat, openedAt }
      )),
  });
  const created: ChatSession = {
    id: createDocumentSessionSlotId(),
    document: session,
    bridge,
    sidebar,
    hubSession,
    agentLease: { active: false, agent: 'codex' },
    disposers: [],
  };
  chat = created;
  session.chats.push(created);
  if (active || !session.activeChat) session.activeChat = created;
  const taps = tapsFor(session);
  created.disposers.push(
    bridge.onEditingLeaseChange((lease) => {
      created.agentLease = lease;
      if (documentShown()) setAgentEditingLease(documentEditingLease(session));
    }),
    bridge.onEvent((event) => {
      if (event.type === 'connection' && event.state === 'connected' && documentShown()) {
        connectPendingDocumentFonts();
      }
      if (event.type === 'workflow-changed') notifyChatModeLock(session, created);
      for (const listener of taps.events) listener(event);
      attentionSession = session;
      try {
        for (const listener of attentionEventListeners) listener(event);
      } finally {
        attentionSession = null;
      }
    }),
    bridge.onBusyChange((busy) => {
      notifyChatModeLock(session, created);
      // 보이지 않는 채팅이 일을 마치면 닫는다. 기록은 채팅 목록에 남고, 허브 세션과 공급자를 놓는다.
      if (!busy) closeIdleHiddenChats(session);
    }),
    bridge.pendingEdits.onChange((event) => {
      for (const listener of taps.pending) listener(event);
      notifyAttentionPendingChanged();
      notifyChatModeLock(session, created);
    }),
  );
  notifyChatModeLock(session, created);
  return created;
}

/**
 * 기본 허브 세션을 받는 첫 채팅에 한 번만 넘긴다. 엔진 trap 복구 전에 멈추지 못한 턴을 그 채팅이
 * 이어받으면 첫 welcome 에서 멈춘다 (AgentBridgeOptions.interruptTurnsOnFirstWelcome).
 */
function takeTrapInterruptedTurnOptions(): { interruptTurnsOnFirstWelcome: string[] } | undefined {
  if (trapInterruptedThreadIds.length === 0) return undefined;
  const threadIds = trapInterruptedThreadIds;
  trapInterruptedThreadIds = [];
  return { interruptTurnsOnFirstWelcome: threadIds };
}

/**
 * 새 채팅을 만든다. 창의 기본 허브 세션이 비어 있으면 그것을, 아니면 허브 세션을 따로 받는다.
 * 채팅 수가 상한이거나 허브 세션을 받을 수 없으면 null.
 */
async function createChatSession(
  session: DocumentSession,
  options: { active: boolean },
): Promise<ChatSession | null> {
  if (allChats().length >= MAX_PARALLEL_CHATS) {
    showToast({
      message: `에이전트는 한 창에서 ${MAX_PARALLEL_CHATS}개까지 함께 실행할 수 있습니다. 끝난 채팅을 닫은 뒤 다시 여세요.`,
      durationMs: 4500,
    });
    return null;
  }
  const usesDefaultHub = !allChats().some((chat) => chat.hubSession === null);
  let hubSession: AgentHubSessionLease | null = null;
  if (!usesDefaultHub) {
    hubSession = await createAgentHubSession();
    if (!hubSession) {
      showToast({ message: '이 환경에서는 에이전트를 여러 개 함께 실행할 수 없습니다.', durationMs: 4500 });
      return null;
    }
  }
  if (!liveSessions.includes(session)) {
    void hubSession?.release();
    return null;
  }
  try {
    return installChatAgent(session, hubSession, options.active);
  } catch (error) {
    console.error('[sessions] 새 채팅을 준비하지 못했습니다:', error);
    void hubSession?.release();
    return null;
  }
}

/** 채팅 하나를 닫는다. 브리지와 허브 세션, 사이드바를 놓는다. */
function disposeChat(chat: ChatSession): void {
  const session = chat.document;
  const index = session.chats.indexOf(chat);
  if (index < 0) return;
  session.chats.splice(index, 1);
  if (session.activeChat === chat) session.activeChat = session.chats[0] ?? null;
  for (const dispose of chat.disposers.splice(0)) {
    try { dispose(); } catch (error) { console.warn('[sessions] 채팅 정리 실패:', error); }
  }
  chat.sidebar.dispose();
  chat.bridge.dispose();
  // 공급자 프로세스가 끝날 때까지 기다리므로 화면을 막지 않는다.
  void chat.hubSession?.release();
  // 닫힌 채팅은 문서를 놓는다 — 다음으로 쥔 채팅이 주인이 된다.
  if (session.writer === chat) session.writer = null;
  notifyChatModeLock(session);
  notifyAttentionPendingChanged();
}

/** 같은 문서의 다른 채팅을 보인다. 문서가 화면에 붙어 있으면 사이드바를 바꿔 끼운다. */
function showChat(session: DocumentSession, chat: ChatSession): void {
  const previous = session.activeChat;
  if (previous === chat) return;
  const documentShown = attachedSession === session;
  if (documentShown) previous?.sidebar.deactivate();
  session.activeChat = chat;
  if (documentShown) {
    chat.sidebar.activate();
    reinstallInlinePrompt();
    setAgentEditingLease(documentEditingLease(session));
  }
  closeIdleHiddenChats(session);
}

/** 보이지 않는 채팅 중 일이 없는 것을 닫는다 (문서마다 보이는 채팅 하나는 남는다). */
function closeIdleHiddenChats(session: DocumentSession): void {
  for (const chat of [...session.chats]) {
    if (session.chats.length < 2) return;
    if (chat === session.activeChat || chat.bridge.isBusy()) continue;
    disposeChat(chat);
  }
}

/**
 * 사이드바의 새 채팅·같은 문서의 다른 채팅 열기. 지금 채팅이 일하는 중이면 멈추지 않고
 * 채팅을 하나 더 열어 그쪽을 보인다. 그 채팅이 이미 다른 채팅 창에 떠 있으면 그리로 넘어간다.
 */
function openChatFromChat(
  chat: ChatSession,
  request: { kind: 'new' } | { kind: 'thread'; threadId: string },
): Promise<'handled' | 'local'> {
  if (isNavigating()) return Promise.resolve('handled');
  return runNavigation(async () => {
    const session = chat.document;
    if (attachedSession !== session || session.activeChat !== chat) return 'handled';
    if (request.kind === 'thread') {
      const holder = session.chats.find((other) => (
        other !== chat && other.sidebar.currentThreadId() === request.threadId
      ));
      if (holder) {
        showChat(session, holder);
        return 'handled';
      }
    }
    if (!chat.bridge.isBusy()) return 'local';
    // 채팅을 따로 열 수 없는 환경(웹 배포판)은 예전처럼 지금 채팅에서 연다.
    if (!supportsExtraAgentHubSessions() && allChats().every((other) => other.hubSession !== null)) {
      return 'local';
    }
    const fresh = await createChatSession(session, { active: false });
    if (!fresh) return 'handled';
    showChat(session, fresh);
    if (request.kind === 'new') fresh.sidebar.startDraftChat();
    else fresh.sidebar.openThreadById(request.threadId);
    return 'handled';
  });
}

/** 문서를 연 뒤 그 문서의 채팅 하나를 보인다. 일하는 채팅은 멈추지 않는다. */
async function focusThreadInSession(session: DocumentSession, threadId: string): Promise<void> {
  const holder = session.chats.find((chat) => chat.sidebar.currentThreadId() === threadId);
  if (holder) {
    showChat(session, holder);
    return;
  }
  const active = session.activeChat;
  if (!active) return;
  if (!active.bridge.isBusy()) {
    active.sidebar.openThreadById(threadId);
    return;
  }
  const fresh = await createChatSession(session, { active: false });
  if (!fresh) return;
  showChat(session, fresh);
  fresh.sidebar.openThreadById(threadId);
}

// Dock 배지와 완료 알림은 창에 하나다. 모든 세션의 이벤트를 한 곳으로 모아 넘긴다.
type AttentionEvent = Parameters<Parameters<NonNullable<DocumentSession['bridge']>['onEvent']>[0]>[0];
const attentionEventListeners = new Set<(event: AttentionEvent) => void>();
const attentionPendingListeners = new Set<() => void>();
let attentionSession: DocumentSession | null = null;

function notifyAttentionPendingChanged(): void {
  for (const listener of attentionPendingListeners) listener();
}

function installWindowAgentAttention(): void {
  installDesktopAgentAttention({
    onEvent: (cb) => {
      attentionEventListeners.add(cb);
      return () => { attentionEventListeners.delete(cb); };
    },
    onPendingChange: (cb) => {
      attentionPendingListeners.add(cb);
      return () => { attentionPendingListeners.delete(cb); };
    },
    pendingReviewCount: totalPendingReviewCount,
    documentTitle: () => {
      const session = attentionSession ?? attachedSession;
      return session.wasm.hasLoadedDocument() ? session.wasm.fileName : '';
    },
  });
}

let inlinePrompt: { dispose(): void } | null = null;

/** 문서 위 인라인 프롬프트는 화면에 붙은 세션의 에이전트에 보낸다. */
function reinstallInlinePrompt(): void {
  inlinePrompt?.dispose();
  inlinePrompt = null;
  const session = attachedSession;
  if (!session.bridge || !session.sidebar || !inputHandler || !canvasView) return;
  inlinePrompt = initInlinePrompt({
    wasm: session.wasm,
    eventBus: session.bus,
    inputHandler,
    canvasView,
    bridge: session.bridge,
    submit: session.sidebar.sendInlinePrompt,
  });
}

/** 창 전체에서 검토를 기다리는 변경 묶음 수 (Dock 배지) */
function totalPendingReviewCount(): number {
  return allChats().reduce((sum, chat) => sum + chat.bridge.pendingEdits.getChangeSets()
    .filter((set) => set.ops.length > 0).length, 0);
}

function liveSessionForDocument(documentId: string | null | undefined): DocumentSession | null {
  if (!documentId) return null;
  return liveSessions.find((session) => (
    session.documentId === documentId && session.wasm.hasLoadedDocument()
  )) ?? null;
}

/**
 * 같은 파일이 이미 다른 세션에 열려 있으면 그 세션. 문서 id 가 어긋난 채팅(예: 다른 경로로
 * 다시 연 문서)도 파일로 알아본다.
 */
async function liveSessionForFile(
  handle: FileSystemFileHandleLike | null | undefined,
): Promise<DocumentSession | null> {
  if (!handle || typeof handle.isSameEntry !== 'function') return null;
  for (const session of liveSessions) {
    const current = session.wasm.currentFileHandle;
    if (session === attachedSession || !current || !session.wasm.hasLoadedDocument()) continue;
    try {
      if (current === handle || await handle.isSameEntry(current)) return session;
    } catch {
      // 비교할 수 없는 핸들은 건너뛴다.
    }
  }
  return null;
}

/**
 * 문서 이름을 바꾼다. 파일이 있는 문서는 같은 폴더 안에서 디스크의 파일 이름을 바꾸고, 파일이
 * 없는 문서는 저장할 때 쓸 이름만 바꾼다. 확장자는 그대로 둔다. 바뀐 파일 이름을 돌려준다.
 */
async function renameDocumentInSession(
  session: DocumentSession,
  requested: string,
): Promise<{ ok: true; fileName: string } | { ok: false; message: string }> {
  const doc = session.wasm;
  if (!doc.hasLoadedDocument()) return { ok: false, message: '열린 문서가 없습니다.' };
  const current = doc.fileName;
  const extension = current.match(/\.[^./\\]+$/)?.[0] ?? '';
  // eslint-disable-next-line no-control-regex
  let base = requested.trim().replace(/[\\/:*?"<>|\u0000-\u001f]/g, '').trim();
  if (extension && base.toLowerCase().endsWith(extension.toLowerCase())) {
    base = base.slice(0, -extension.length).trim();
  }
  if (!base || base.startsWith('.')) return { ok: false, message: '쓸 수 있는 이름을 입력하세요.' };
  const nextName = `${base}${extension}`;
  if (nextName === current) return { ok: true, fileName: current };
  const handle = doc.currentFileHandle;
  try {
    if (handle && canRenameNativeFile(handle)) {
      doc.currentFileHandle = await renameNativeDocumentFile(handle, nextName);
    } else if (handle) {
      return { ok: false, message: '이 문서의 파일 이름은 여기서 바꿀 수 없습니다.' };
    }
  } catch (error) {
    const reason = error instanceof NativeRenameRefusedError ? error.reason : null;
    if (!reason) console.warn('[rename] 파일 이름을 바꾸지 못했습니다:', error);
    const messages: Record<string, string> = {
      exists: '같은 이름의 파일이 이미 있습니다.',
      open: '같은 이름의 파일이 이미 열려 있습니다.',
      saving: '저장이 끝난 뒤 다시 바꾸세요.',
      invalid: '쓸 수 있는 이름을 입력하세요.',
      extension: '확장자는 바꿀 수 없습니다.',
    };
    return { ok: false, message: (reason && messages[reason]) || '파일 이름을 바꾸지 못했습니다.' };
  }
  doc.fileName = nextName;
  const documentId = session.documentId;
  if (documentId) {
    renameThreadsDocument(documentId, nextName);
    const sourceDigest = doc.documentDigest;
    if (sourceDigest && doc.currentFileHandle) {
      await addRecentDoc({
        documentId,
        sourceDigest,
        fileName: nextName,
        sourceFormat: doc.getSourceFormat(),
        handle: doc.currentFileHandle,
      }).catch((error) => console.warn('[recent] 이름을 바꾼 문서를 기록하지 못했습니다:', error));
    }
  }
  session.bus.emit('document-context-changed');
  return { ok: true, fileName: nextName };
}

/** 화면에 붙은 문서의 이름을 바꾼다 (제목 막대). 못 바꾸면 알리고 null. */
async function renameAttachedDocument(name: string): Promise<string | null> {
  const result = await renameDocumentInSession(attachedSession, name);
  if (result.ok) return result.fileName;
  showToast({ message: result.message, durationMs: 3200 });
  return null;
}

/** 열려는 문서가 이미 이 창의 다른 세션에 살아 있다. 다시 읽지 않고 그 세션으로 넘어간다. */
class DocumentLiveInSessionError extends Error {
  constructor(readonly session: DocumentSession) {
    super('이미 열려 있는 문서입니다.');
    this.name = 'DocumentLiveInSessionError';
  }
}

let documentIoCount = 0;
let documentIoIdle: Promise<void> = Promise.resolve();
let settleDocumentIo: (() => void) | null = null;

/** 문서를 읽어 들이는 동안을 표시한다. 화면 세션 전환은 이 일이 끝난 뒤에 한다. */
async function trackDocumentIo<T>(run: () => Promise<T>): Promise<T> {
  if (documentIoCount === 0) documentIoIdle = new Promise((resolve) => { settleDocumentIo = resolve; });
  documentIoCount += 1;
  try {
    return await run();
  } finally {
    documentIoCount -= 1;
    if (documentIoCount === 0) {
      settleDocumentIo?.();
      settleDocumentIo = null;
    }
  }
}

/** 진행 중인 문서 열기와 저장이 모두 끝날 때까지 기다린다. 끝나기 전에 세션을 바꾸면 그 일이 다른 문서에 닿는다. */
async function whenDocumentIoIdle(): Promise<void> {
  await whenSavesIdle();
  while (documentIoCount > 0) await documentIoIdle;
}

let navigationChain: Promise<unknown> = Promise.resolve();
/** 줄에 선 이동 수 (기다리는 것 포함). 0 이 아니면 사이드바의 새 이동을 받지 않는다. */
let navigationQueued = 0;
/** 지금 실행 중인 이동. 그 안에서 내보낸 열기는 같은 일의 일부다. */
let navigationRunning = 0;

function isNavigating(): boolean {
  return navigationQueued > 0;
}

/**
 * 문서를 열거나 다른 문서 세션으로 넘어가는 일은 한 번에 하나씩 한다. nested 는 이미 진행 중인
 * 이동이 스스로 내보낸 열기라 줄을 서지 않는다 (줄을 서면 자기 자신을 기다린다).
 */
function runNavigation<T>(run: () => Promise<T>, options: { nested?: boolean } = {}): Promise<T> {
  if (options.nested) return run();
  navigationQueued += 1;
  const next = navigationChain.then(async () => {
    navigationRunning += 1;
    try {
      await whenDocumentIoIdle();
      return await run();
    } finally {
      navigationRunning -= 1;
      navigationQueued -= 1;
    }
  });
  navigationChain = next.catch(() => {});
  return next;
}

let sessionSwitchChain: Promise<void> = Promise.resolve();

/** 화면을 다른 문서 세션에 붙인다. 전환은 한 번에 하나씩 한다. */
function attachSession(next: DocumentSession): Promise<void> {
  const run = sessionSwitchChain.then(() => attachSessionNow(next));
  sessionSwitchChain = run.catch(() => {});
  return run;
}

async function attachSessionNow(next: DocumentSession): Promise<void> {
  await whenDocumentIoIdle();
  const previous = attachedSession;
  if (previous === next || !liveSessions.includes(next) || !inputHandler || !canvasView) return;

  // 1. 지금 세션을 화면에서 뗀다. 에이전트는 편집기 대역으로 계속 쓴다.
  previous.viewState = previous.wasm.hasLoadedDocument() ? canvasView.captureViewState() : null;
  previous.editMode = editMode;
  Object.assign(previous.editorState, inputHandler.detachDocumentState());
  for (const chat of previous.chats) chat.bridge.detachView(previous.editorHost);
  previous.sidebar?.deactivate();
  inlinePrompt?.dispose();
  inlinePrompt = null;

  // 2. 페이지 퍼사드를 다음 세션으로 돌린다.
  attachedSession = next;
  wasmFacade.retarget(next.wasm);
  eventBus.retarget(next.bus);
  documentStateFacade.retarget(next.documentState);
  autosaveFacade.retarget(next.autosave);
  hostSaveFacade.retarget(next.hostSave);

  // 3. 화면을 다음 문서로 다시 그린다. 문서를 다시 읽지 않는다.
  //    그리다 실패해도(엔진 trap 등) 편집 상태·에이전트·사이드바는 반드시 다음 세션에 붙인다.
  //    그러지 않으면 사이드바가 하나도 보이지 않고, 다음 전환이 이 세션의 실행 취소 기록을 덮는다.
  canvasView.prepareDocumentLoad();
  const hasDocument = next.wasm.hasLoadedDocument();
  let fontsUsed: string[] | undefined;
  let viewReady = false;
  try {
    if (hasDocument) {
      const info = next.wasm.getDocumentInfo();
      fontsUsed = info.fontsUsed;
      setActiveDocumentFonts(fontsUsed ?? []);
      applyTextMarkSettingsTo(next.wasm);
      // 이 문서가 뒤에 있는 동안 등록된 글꼴이 있으면 조판이 낡았다.
      next.wasm.refreshLayout();
      totalSections = info.sectionCount ?? 1;
      await canvasView.loadDocument(next.viewState);
      viewReady = true;
    }
  } catch (error) {
    console.error('[sessions] 문서 화면을 다시 그리지 못했습니다:', error);
  }
  inputHandler.attachDocumentState(next.editorState);
  inputHandler.setReadOnly(sessionReadOnly(next));
  if (next.editMode !== editMode) setEditMode(next.editMode);
  if (viewReady) {
    try {
      inputHandler.activateWithCaretPosition(next.editorState.cursor);
      prepareCanvasKitLocalFonts(fontsUsed);
      toolbar?.initFontDropdown(fontsUsed);
      toolbar?.initStyleDropdown();
      const emptyState = document.getElementById('document-empty-state');
      if (emptyState) {
        emptyState.hidden = true;
        emptyState.setAttribute('aria-hidden', 'true');
      }
    } catch (error) {
      console.error('[sessions] 편집 상태를 이어 붙이지 못했습니다:', error);
    }
  }
  for (const chat of next.chats) chat.bridge.attachView({ inputHandler, canvasView });
  // 채팅마다 붙을 때 템플릿 잠금을 다시 알린다. 마지막 채팅의 "잠금 없음"이 덮지 않게, 잠근
  // 채팅이 있으면 그 상태로 한 번 더 맞춘다.
  next.chats.find((chat) => chat.bridge.pendingEdits.isTemplateLocked())
    ?.bridge.pendingEdits.republishTemplateLock();
  setAgentEditingLease(documentEditingLease(next));
  next.sidebar?.activate();
  reinstallInlinePrompt();

  // 4. 문서 상태를 쓰는 화면 요소를 새 문서로 맞춘다. 세션 버스로는 내지 않는다.
  wasm.onFileNameChanged?.(wasm.fileName);
  statusSectionIndex = 0;
  sbSection().textContent = `구역: 1 / ${totalSections}`;
  schedulePaperStatus();
  scheduleCharacterStatus(true);
  updateFontStatusButton();
  eventBus.emitPage('document-context-changed');
  eventBus.emitPage('document-dirty-changed', {
    dirty: next.documentState.isDirty(),
    reason: 'document-session-attached',
  });
  eventBus.emitPage('command-state-changed');
  desktopDocumentStateUpdate?.();
}

/** 새 문서 세션을 만든다. 첫 채팅은 비어 있는 허브 세션으로 붙는다. */
async function createLiveSession(): Promise<DocumentSession | null> {
  if (allChats().length >= MAX_PARALLEL_CHATS) {
    showToast({
      message: `에이전트는 한 창에서 ${MAX_PARALLEL_CHATS}개까지 함께 실행할 수 있습니다. 끝난 채팅을 닫은 뒤 다시 여세요.`,
      durationMs: 4500,
    });
    return null;
  }
  const session = createSessionCore(createDocumentSessionSlotId());
  liveSessions.push(session);
  try {
    installDocumentVersions(session);
  } catch (error) {
    console.error('[sessions] 새 문서 세션을 준비하지 못했습니다:', error);
    await disposeSession(session);
    return null;
  }
  const chat = await createChatSession(session, { active: true });
  if (!chat) {
    await disposeSession(session);
    return null;
  }
  return session;
}

/** 화면에 붙어 있지 않은 세션을 닫는다. 엔진 문서와 허브 세션, 문서 점유를 모두 놓는다. */
async function disposeSession(session: DocumentSession, options: { persistWorktree?: boolean } = {}): Promise<void> {
  if (session === attachedSession) return;
  const index = liveSessions.indexOf(session);
  if (index < 0) return;
  if (session.worktree && session.worktreeWritable && options.persistWorktree !== false) {
    await session.versions?.persistWorktree();
  }
  liveSessions.splice(index, 1);
  for (const dispose of session.disposers.splice(0)) {
    try { dispose(); } catch (error) { console.warn('[sessions] 세션 정리 실패:', error); }
  }
  for (const chat of [...session.chats]) disposeChat(chat);
  session.versions?.dispose();
  session.editorHost.dispose();
  session.versions = null;
  worktreeOwnership.release(session);
  deniedWorktreeSessions.delete(session);
  refreshWorktreeSessions();
  notifyAttentionPendingChanged();
  // 파일 핸들(북마크 포함)과 문서 점유를 먼저 놓는다. 방금 닫은 문서를 곧바로 다시 열면
  // 아직 이 창이 쥔 것으로 보인다. 자동 저장 정리는 그 뒤에 한다.
  await releaseReplacedNativeFileHandle(session.wasm.currentFileHandle, null)
    .catch((error) => console.warn('[desktop] 닫은 문서의 네이티브 파일 핸들 해제 실패:', error));
  await releaseDesktopDocument(undefined, session.slotId).catch(() => {});
  await session.autosave.endDocument({ discardDraft: true, reason: 'document-session-closed' })
    .catch(() => {});
  session.autosave.dispose();
  if (session.wasm.hasLoadedDocument()) session.wasm.releaseDocument();
  desktopDocumentStateUpdate?.();
}

/**
 * 지금 문서를 뒤에 둔 채 새 세션에서 문서를 연다. 열지 못하면 원래 세션으로 돌아간다.
 * 세션을 만들 수 없으면 null.
 */
async function openInNewSession<T>(
  setup: (session: DocumentSession) => void,
  open: () => Promise<T>,
): Promise<{ result: T; loaded: boolean } | null> {
  const previous = attachedSession;
  const fresh = await createLiveSession();
  if (!fresh) return null;
  setup(fresh);
  let loaded = false;
  try {
    await attachSession(fresh);
    const result = await open();
    // 열기를 기다리지 않는 경로가 있어도, 진행 중인 열기가 끝난 뒤에 성공 여부를 본다.
    await whenDocumentIoIdle();
    loaded = fresh.wasm.hasLoadedDocument();
    return { result, loaded };
  } finally {
    if (!loaded) {
      if (attachedSession === fresh && liveSessions.includes(previous)) await attachSession(previous);
      await disposeSession(fresh);
    }
  }
}

/**
 * 이미 열려 있는 세션으로 넘어간다. 에이전트가 일하지 않는 지금 문서는 저장하고 닫는다.
 * 에이전트가 일하는 문서는 뒤에 남아 작업을 이어 간다.
 */
async function switchToLiveSession(
  live: DocumentSession,
  options: { saveCurrent?: boolean; commitCurrent?: () => Promise<void> } = {},
): Promise<'ok' | 'cancelled' | 'failed'> {
  const current = attachedSession;
  if (current === live) return 'ok';
  const closeCurrent = !isDocumentSessionBusy(current) && !isManagedWorktree(current);
  if (closeCurrent && options.saveCurrent && current.wasm.hasLoadedDocument()) {
    const left = await runSaveBeforeLeaving(
      commandServices,
      () => current.documentId,
      options.commitCurrent,
    );
    if (left !== 'ok') return left;
  }
  await attachSession(live);
  if (closeCurrent) await disposeSession(current);
  return 'ok';
}

/**
 * 사이드바에서 다른 문서(또는 그 문서의 채팅)로 옮겨 간다.
 * - 그 문서가 이미 열려 있으면 그 세션으로 넘어간다.
 * - 지금 문서에서 에이전트가 일하는 중이면 지금 문서를 뒤에 두고 새 세션에서 연다.
 * - 아니면 지금처럼 저장·커밋하고 같은 세션에서 문서를 바꾼다.
 */
function moveFromSession(
  session: DocumentSession,
  target: LibraryDocumentTarget,
  options: { commit?: boolean; threadId?: string } = {},
): Promise<LibraryMoveResult> {
  // 다른 문서를 여는 중에 누른 이동은 받지 않는다. 겹치면 열던 일이 엉뚱한 세션에 닿는다.
  if (isNavigating()) return Promise.resolve('cancelled');
  // 멈춘 엔진에서는 저장 확인과 다른 문서 열기가 지금 문서를 잃게 한다.
  if (refuseDocumentOpenWhileTrapped()) return Promise.resolve('cancelled');
  return runNavigation(() => moveFromSessionNow(session, target, options));
}

async function moveFromSessionNow(
  session: DocumentSession,
  target: LibraryDocumentTarget,
  options: { commit?: boolean; threadId?: string },
): Promise<LibraryMoveResult> {
  if (session !== attachedSession) return 'cancelled';
  const versions = session.versions;
  const commitCurrent = options.commit && versions
    ? () => commitBeforeLibraryMove(versions)
    : undefined;
  const live = liveSessionForDocument(target.documentId);
  if (live === session) return 'same';
  if (live) {
    const switched = await switchToLiveSession(live, { saveCurrent: true, commitCurrent });
    if (switched !== 'ok') return switched;
    if (options.threadId) await focusThreadInSession(live, options.threadId);
    return 'moved';
  }
  if (isDocumentSessionBusy(session)) {
    const outcome = await openInNewSession(
      (fresh) => {
        if (options.threadId) fresh.sidebar?.followThreadOnNextDocument(options.threadId);
      },
      () => runLibraryMove(commandServices, target, () => attachedSession.documentId),
    );
    if (!outcome) return 'cancelled';
    if (!outcome.loaded) return outcome.result === 'moved' ? 'failed' : outcome.result;
    return outcome.result;
  }
  if (options.threadId) session.sidebar?.followThreadOnNextDocument(options.threadId);
  return runLibraryMove(commandServices, target, () => attachedSession.documentId, commitCurrent);
}

/** 창을 닫기 전에, 뒤에서 에이전트가 일하거나 저장하지 않은 문서가 있으면 묻는다. */
async function confirmCloseWithBackgroundSessions(): Promise<boolean> {
  // 다른 문서에서 일하는 에이전트와, 지금 문서에서 보이지 않는 채팅이 일하는 경우를 함께 묻는다.
  const background = liveSessions.filter((session) => session.wasm.hasLoadedDocument() && (
    session === attachedSession
      ? session.chats.some((chat) => chat !== session.activeChat && chat.bridge.isBusy())
      : isDocumentSessionBusy(session) || session.documentState.isDirty()
  ));
  if (background.length === 0) return true;
  const names = background.map((session) => `"${session.wasm.fileName}"`).join(', ');
  const confirmed = await showConfirm(
    '다른 문서에서 작업 중입니다',
    `${names}\n창을 닫으면 에이전트가 멈춥니다. 저장하지 않은 변경은 자동 저장본으로 복구할 수 있습니다.`,
  );
  if (!confirmed) return false;
  await Promise.all(background.map((session) => session.autosave.flushNow('window-close')
    .catch(() => {})));
  await Promise.all(liveSessions.filter((session) => session.worktreeWritable)
    .map((session) => session.versions?.persistWorktree()));
  return true;
}

/** 다른 문서로 옮기기 전에 커밋하지 않은 변경을 버전 기록에 남긴다. */
async function commitBeforeLibraryMove(versions: DocumentVersionController): Promise<void> {
  // 방금 끝난 저장이 버전 기록의 저장 지점을 고치는 중이다. 그 뒤에 커밋해야
  // 저장소 판이 어긋나 커밋이 STALE_WORKSPACE 로 조용히 빠지지 않는다.
  await versions.whenIdle();
  const state = versions.getState();
  if (!state.enabled || !state.dirty || state.mutationBlockedReason) return;
  try {
    // 메시지 없이 커밋한다. 메시지가 있으면 내용이 같을 때 커밋 대신 태그가 생긴다.
    await versions.checkpoint();
  } catch (error) {
    const code = versionErrorCode(error);
    if (code === 'NO_CHANGES' || code === 'STALE_WORKSPACE' || code === 'VERSIONING_DISABLED') return;
    console.warn('[main] 문서를 옮기기 전 버전 기록 커밋 실패:', error);
    throw error;
  }
}

/**
 * 전역 단축키 핸들러 — InputHandler.active 여부와 무관하게 동작해야 하는 단축키.
 * 예: 문서 미로드 상태에서도 Alt+N(새 문서), Ctrl+O(열기) 등.
 */
function setupGlobalShortcuts(): void {
  document.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey
      || e.key !== '/'
      || e.isComposing || e.defaultPrevented) return;
    const target = e.target instanceof Element ? e.target : null;
    if (!allowsDocumentShortcut(target)) return;
    e.preventDefault();
    e.stopPropagation();
    commandPalette?.open();
  }, true);
  document.addEventListener('keydown', (e) => {
    const target = e.target instanceof Element ? e.target : null;
    if (e.defaultPrevented || e.isComposing || !allowsDocumentShortcut(target)) return;
    // 문서 입력은 모드별 처리가 있으므로 같은 키를 두 번 실행하지 않는다.
    if (isEditorInput(target) && inputHandler?.isActive()) return;
    const commandId = matchShortcut(e, defaultShortcuts);
    if (!commandId) return;
    if (!inputHandler?.isActive() && !['file:new-doc', 'file:open'].includes(commandId)) return;
    e.preventDefault();
    if (inputHandler?.isActive()) inputHandler.focus();
    dispatcher.dispatch(commandId);
  }, false);
}

function setupFileInput(): void {
  const fileInput = document.getElementById('file-input') as HTMLInputElement;
  const openAction = document.getElementById('document-open-action') as HTMLButtonElement | null;
  const newAction = document.getElementById('document-new-action') as HTMLButtonElement | null;

  openAction?.addEventListener('click', () => dispatcher.dispatch('file:open'));
  newAction?.addEventListener('click', () => dispatcher.dispatch('file:new-doc'));
  void renderEmptyStateRecents();

  fileInput.addEventListener('change', async (e) => {
    const input = e.target as HTMLInputElement;
    const skipUnsavedGuard = input.dataset.skipUnsavedGuard === 'true';
    delete input.dataset.skipUnsavedGuard;
    const file = input.files?.[0];
    if (!file) return;
    if (!isSupportedDocumentFileName(file.name)) {
      alert('HWP/HWPX/HML/RHWPX 파일만 지원합니다.');
      fileInput.value = '';
      return;
    }
    let fileHandle: FileSystemFileHandleLike | null | undefined;
    try {
      fileHandle = await captureDesktopNativeDroppedFile(file);
    } catch (error) {
      fileInput.value = '';
      showLoadError(error);
      return;
    }
    await loadFile(file, { skipUnsavedGuard, fileHandle: fileHandle ?? undefined });
    fileInput.value = '';
  });

  // 문서 전체에서 브라우저 기본 드롭 동작 방지 (파일 열기/다운로드 방지)
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', (e) => e.preventDefault());

  // 드래그 앤 드롭 지원 (scroll-container 영역)
  const container = document.getElementById('scroll-container')!;
  container.addEventListener('dragover', (e) => {
    e.preventDefault();
    container.classList.add('drag-over');
  });
  container.addEventListener('dragleave', () => {
    container.classList.remove('drag-over');
  });
  container.addEventListener('drop', async (e) => {
    e.preventDefault();
    container.classList.remove('drag-over');
    const file = e.dataTransfer?.files[0];
    if (!file) return;
    const dropName = file.name.toLowerCase();
    const imageExts = ['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp'];
    const isImage = imageExts.some(ext => dropName.endsWith(ext));
    const isDoc = isSupportedDocumentFileName(dropName);
    // 문서는 지금 문서를 뒤에 두고 따로 열 수 있다. 그림은 지금 문서에 넣으므로 기다린다.
    if (agentEditingLease.active && !(isDoc && shouldOpenInNewSession())) {
      showToast({ message: '에이전트가 편집을 마친 뒤 파일을 놓을 수 있습니다.', durationMs: 2600 });
      return;
    }
    if (!isImage && !isDoc) {
      alert('HWP/HWPX/HML/RHWPX 파일 또는 이미지 파일만 지원합니다.');
      return;
    }

    // #3259: Chromium은 getAsFileSystemHandle을 drop event와 같은 tick에 호출해야 한다.
    // 아직 bytes를 읽거나 handle을 저장하지 않으며, 아래 사용자 확인이 승인된 뒤에만 사용한다.
    const browserDroppedFileHandle = isDoc
      ? captureDroppedFileHandle(e.dataTransfer?.items, file)
      : Promise.resolve<FileSystemFileHandleLike | null>(null);
    const desktopDroppedFileHandle = isDoc
      ? captureDesktopNativeDroppedFile(file)
      : Promise.resolve<FileSystemFileHandleLike | null | undefined>(undefined);
    const droppedFileHandle = desktopDroppedFileHandle.then(async (nativeHandle) => (
      nativeHandle === undefined ? browserDroppedFileHandle : nativeHandle
    ));

    // [#1439] 보안: 드롭으로 로컬 파일을 읽는 동작은 기본에서 제외하고, 사용자가
    // 명시적으로 [열기]를 눌러 동의한 경우에만 진행한다 (확장/웹 공통).
    const confirmed = await showDropConfirmDialog(file.name);
    if (!confirmed) {
      const unusedHandle = await droppedFileHandle.catch(() => null);
      await unusedHandle?.releaseUnusedSaveTarget?.().catch(() => {});
      return;
    }

    if (isImage) {
      if (!inputHandler || wasm.pageCount === 0) return;
      let objectUrl = '';
      try {
        const data = await readBlobBytesWithLimit(file, INSERTED_IMAGE_MAX_BYTES, '그림');
        const ext = file.name.split('.').pop()?.toLowerCase() || 'png';
        assertEncodedImageDecodeDimensions(data, '그림');
        const img = new Image();
        objectUrl = URL.createObjectURL(file);
        img.src = objectUrl;
        await img.decode();
        assertImageDecodeDimensions(img.naturalWidth, img.naturalHeight, '그림');
        const result = inputHandler.insertDroppedImageAtClientPoint(
          data,
          ext,
          img.naturalWidth,
          img.naturalHeight,
          file.name,
          e.clientX,
          e.clientY,
        );
        if (!result.ok) {
          showToast({
            message: `그림 삽입에 실패했습니다.\n${result.error ?? '삽입 위치 또는 이미지 정보를 확인할 수 없습니다.'}`,
            durationMs: 6000,
          });
        }
      } catch (error) {
        const message = error instanceof Error && error.message
          ? error.message
          : '브라우저가 이 이미지 파일을 읽지 못했습니다.';
        console.warn('[drop] 이미지 준비 실패:', error);
        showToast({
          message: `그림을 삽입할 수 없습니다.\n${message}`,
          durationMs: 6000,
        });
      } finally {
        if (objectUrl) URL.revokeObjectURL(objectUrl);
      }
      return;
    }

    // HWP/HWPX/HML/RHWPX — loadFile 내부 unsaved 가드는 드롭 확인 이후에 동작한다.
    let fileHandle: FileSystemFileHandleLike | null;
    try {
      fileHandle = await droppedFileHandle;
    } catch {
      return;
    }
    await loadFile(file, { fileHandle, untrustedSource: true });
  });
}

function setupZoomControls(): void {
  if (!canvasView) return;
  const vm = canvasView.getViewportManager();
  setupStatusZoomSlider(document.getElementById('sb-zoom-range') as HTMLInputElement, sbZoomVal(), vm, eventBus);

  document.getElementById('sb-zoom-in')!.addEventListener('click', () => {
    vm.smoothZoomBy(0.1);
  });
  document.getElementById('sb-zoom-out')!.addEventListener('click', () => {
    vm.smoothZoomBy(-0.1);
  });

  // 폭 맞춤: 용지 폭에 맞게 줌 조절
  document.getElementById('sb-zoom-fit-width')!.addEventListener('click', () => {
    if (wasm.pageCount === 0) return;
    const container = document.getElementById('scroll-container')!;
    const pageInfo = wasm.getPageInfo(0);
    // pageInfo.width는 이미 px 단위 (96dpi 기준)
    const zoom = calculateFitWidthZoom(container.clientWidth, pageInfo.width);
    vm.setZoom(zoom);
  });

  // 쪽 맞춤: 한 페이지 전체가 보이도록 줌 조절
  document.getElementById('sb-zoom-fit')!.addEventListener('click', () => {
    if (wasm.pageCount === 0) return;
    const container = document.getElementById('scroll-container')!;
    const pageInfo = wasm.getPageInfo(0);
    // pageInfo.width/height는 이미 px 단위 (96dpi 기준)
    const zoom = calculateFitPageZoom(
      container.clientWidth,
      container.clientHeight,
      pageInfo.width,
      pageInfo.height,
    );
    vm.setZoom(zoom);
  });

  // 모바일: 줌 값 클릭 → 100% 토글
  document.getElementById('sb-zoom-val')!.addEventListener('click', () => {
    const currentZoom = vm.getZoom();
    if (Math.abs(currentZoom - 1.0) < 0.05) {
      // 현재 100% → 쪽 맞춤으로 전환
      document.getElementById('sb-zoom-fit')!.click();
    } else {
      // 현재 쪽 맞춤/기타 → 100%로 전환
      vm.setZoom(1.0);
    }
  });
}

let totalSections = 1;

function setupEventListeners(): void {
  installFontStatusButton();
  eventBus.on('font-files-imported', () => {
    try {
      // 직접 가져온 파일도 레이아웃 메트릭에 올린다.
      syncImportedFontMetrics();
      wasm.refreshLayout();
      eventBus.emit('document-view-changed');
      prepareCanvasKitLocalFonts(wasm.getDocumentInfo().fontsUsed);
    } catch (error) {
      console.warn('[LocalFonts] 글꼴 가져오기 뒤 문서 갱신 실패:', error);
    }
  });
  eventBus.on('local-fonts-changed', () => syncLocalFontAccessMetrics());
  eventBus.on('current-page-changed', (page, _total) => {
    const pageIdx = page as number;
    sbPage().textContent = `${pageIdx + 1} / ${_total} 쪽`;

    // 구역 정보: 현재 페이지의 sectionIndex로 갱신
    if (wasm.pageCount > 0) {
      try {
        const pageInfo = wasm.getPageInfo(pageIdx);
        statusSectionIndex = pageInfo.sectionIndex;
        sbSection().textContent = `구역: ${pageInfo.sectionIndex + 1} / ${totalSections}`;
        schedulePaperStatus();
      } catch { /* 무시 */ }
    }
  });

  eventBus.on('zoom-level-display', (zoom) => {
    sbZoomVal().textContent = `${Math.round((zoom as number) * 100)}%`;
  });

  eventBus.on('cursor-rect-updated', () => {
    if (inputHandler) {
      const section = inputHandler.getCursorPosition().sectionIndex;
      if (section !== statusSectionIndex) {
        statusSectionIndex = section;
        schedulePaperStatus();
      }
    }
    scheduleCharacterStatus();
  });

  eventBus.on('cell-selection-changed', () => scheduleCharacterStatus());

  // 삽입/수정 모드 토글
  eventBus.on('insert-mode-changed', (insertMode) => {
    document.getElementById('sb-mode')!.textContent = (insertMode as boolean) ? '삽입' : '수정';
  });

  // 더티 표시는 문서 세션이 직접 한다 (createDocumentSessionCore).
  eventBus.on('document-mutated', () => {
    schedulePaperStatus();
    scheduleCharacterRecount();
  });

  eventBus.on('document-changed', () => {
    schedulePaperStatus();
    scheduleCharacterRecount();
    scheduleDesktopFontSync();
  });

  eventBus.on('renderer-selection-changed', (payload) => {
    const diagnostics = payload as RendererSessionDiagnostics;
    renderBackendFallbackReason = diagnostics.fallbackReason;
    if (import.meta.env.DEV) {
      (window as any).__renderBackend = diagnostics.effectiveBackend;
      (window as any).__renderBackendFallbackReason = diagnostics.fallbackReason;
      (window as any).__rendererSelection = diagnostics;
    }
  });

  eventBus.on('document-dirty-changed', () => {
    eventBus.emit('command-state-changed');
  });

  eventBus.on('document-file-handle-saved', (payload) => {
    const saved = payload as {
      fileHandle: FileSystemFileHandleLike;
      previousFileHandle: FileSystemFileHandleLike | null;
      fileName: string;
      sourceFormat: string;
      savedDigest?: string | null;
    };
    const documentId = attachedSession.documentId;
    // 파일에 쓴 내용의 digest 를 남겨야, 옮기거나 이름을 바꾼 파일도 내용으로 다시 찾는다.
    const sourceDigest = saved.savedDigest ?? wasm.documentDigest;
    if (!documentId || !sourceDigest) {
      void releaseReplacedNativeFileHandle(saved.previousFileHandle, saved.fileHandle)
        .catch((error) => console.warn('[desktop] 이전 네이티브 파일 핸들 해제 실패:', error));
      return;
    }

    // Save/Save As changes storage metadata, not logical document identity. Explicitly
    // bind the new handle to the active ID so reopening it in a later session restores
    // the same document-scoped references. Download fallbacks emit no such event.
    void (async () => {
      await rememberNativeDocument(documentId, saved.fileHandle, sourceDigest);
      await releaseReplacedNativeFileHandle(saved.previousFileHandle, saved.fileHandle);
      await addRecentDoc({
        documentId,
        sourceDigest,
        fileName: saved.fileName,
        sourceFormat: saved.sourceFormat,
        handle: saved.fileHandle,
      });
    })().catch((err) => console.warn('[recent] 저장 핸들 identity 갱신 실패:', err));
  });

  eventBus.on('autosave-settings-changed', () => {
    const schedule = autosaveScheduleFromUserSettings();
    for (const session of liveSessions) session.autosave.updateSchedule(schedule);
  });

  // 필드 정보 표시
  const sbField = document.getElementById('sb-field');
  eventBus.on('field-info-changed', (info) => {
    if (!sbField) return;
    const fi = info as { fieldId: number; fieldType: string; guideName?: string } | null;
    if (fi) {
      const label = fi.guideName || `#${fi.fieldId}`;
      sbField.textContent = `[누름틀] ${label}`;
      sbField.style.display = '';
    } else {
      sbField.textContent = '';
      sbField.style.display = 'none';
    }
  });

  const modeGroups = Array.from(
    document.querySelectorAll<HTMLElement>('#icon-toolbar > .tb-mode-group[data-toolbar-mode]'),
  );
  const defaultTbGroups = Array.from(
    document.querySelectorAll<HTMLElement>('#icon-toolbar > .tb-group:not(.tb-mode-group), #icon-toolbar > .tb-sep'),
  );
  let objectSelected = false;
  let tableObjectSelected = false;
  let headerFooterActive = false;
  let noteToolbarActive = false;

  const applyContextualToolbarMode = (): ContextualEditingToolbarMode => {
    const context = getContext();
    const mode = contextualEditingToolbarMode({
      objectSelected,
      inTable: tableObjectSelected
        || context.inTableObjectSelection
        || context.inCellSelectionMode
        || context.inTable,
      headerFooterActive,
      noteActive: noteToolbarActive,
    });
    if (mode !== 'table') tableRibbonMenus?.closeAll();
    defaultTbGroups.forEach((element) => {
      element.style.display = mode === 'default' ? '' : 'none';
    });
    document.querySelectorAll<HTMLButtonElement>(
      '#icon-toolbar .tb-group:not(.tb-mode-group) .tb-btn[data-cmd]',
    ).forEach((button) => {
      button.disabled = !dispatcher.isEnabled(button.dataset.cmd ?? '');
    });
    modeGroups.forEach((group) => {
      group.style.display = group.dataset.toolbarMode === mode ? '' : 'none';
      if (group.dataset.toolbarMode === mode) {
        const selectedObject = inputHandler?.getSelectedPictureRef() ?? null;
        const selectedObjects = inputHandler?.getSelectedPictureRefs() ?? [];
        const selectedObjectScope = selectedObject ? objectAddressScope(selectedObject) : null;
        const objectSelection = {
          kind: selectedObject?.type ?? null,
          count: selectedObjects.length,
          topLevel: selectedObjects.length > 0 && selectedObjects.every(isTopLevelBodyObject),
          arrangeable: context.canArrangeSelectedObject,
          groupable: context.canGroupSelectedObjects,
          ungroupable: context.canUngroupSelectedObject,
          deletable: Boolean(
            selectedObject
            && (
              selectedObjectScope === 'body'
              || (selectedObjectScope === 'cell' && selectedObject.type === 'image')
            ),
          ),
          propertyEditable: Boolean(
            selectedObject
            && selectedObjectScope !== 'memo'
            && (selectedObjectScope !== 'note' || selectedObject.type === 'equation'),
          ),
        };
        group.querySelectorAll<HTMLButtonElement>('.tb-btn[data-cmd]').forEach((button) => {
          const command = button.dataset.cmd ?? '';
          button.disabled = !dispatcher.isEnabled(command)
            || (mode === 'object' && !contextualObjectCommandEnabled(command, objectSelection));
        });
      }
    });
    tableRibbonMenus?.refresh();
    document.getElementById('icon-toolbar')?.setAttribute('data-context-mode', mode);
    return mode;
  };

  eventBus.on('picture-object-selection-changed', (selected) => {
    objectSelected = selected as boolean;
    if (objectSelected) {
      tableObjectSelected = false;
      setBasicToolboxExpanded(true);
    }
    applyContextualToolbarMode();
  });
  eventBus.on('table-object-selection-changed', (selected) => {
    tableObjectSelected = selected as boolean;
    if (tableObjectSelected) {
      objectSelected = false;
      setBasicToolboxExpanded(true);
    }
    applyContextualToolbarMode();
  });
  eventBus.on('cursor-format-changed', applyContextualToolbarMode);
  eventBus.on('cell-selection-changed', applyContextualToolbarMode);
  eventBus.on('command-state-changed', applyContextualToolbarMode);

  // 머리말/꼬리말 편집 모드 시 도구상자 전환 + 본문 dimming
  const hfLabel = document.querySelector<HTMLElement>('.tb-headerfooter-group .tb-hf-label');
  const hfLiveStatus = document.getElementById('hf-edit-status-live');
  const scrollContainer = document.getElementById('scroll-container');

  eventBus.on('headerFooterModeChanged', (payload) => {
    const state = parseHeaderFooterModeChanged(payload);
    const isActive = state !== 'none';
    headerFooterActive = isActive;
    // 접힌 기본 도구 상자는 머리말/꼬리말 전용 버튼을 가리므로 모드 진입 시 펼친다.
    if (isActive) setBasicToolboxExpanded(true);
    // 도구상자 전환
    if (hfLabel) {
      const kind = state === 'none' ? '' : state.mode === 'header' ? '머리말' : '꼬리말';
      const target = state === 'none' ? '' : headerFooterApplyToLabel(state.applyTo);
      hfLabel.textContent = state === 'none' ? '' : `${kind} · ${target} 편집 중`;
      hfLabel.dataset.mode = state === 'none' ? '' : state.mode;
      hfLabel.dataset.applyTo = state === 'none' ? '' : String(state.applyTo);
      if (hfLiveStatus) {
        hfLiveStatus.textContent = state === 'none'
          ? '머리말 꼬리말 편집 종료'
          : `${kind} ${target} 편집 중, 구역 ${state.sectionIdx + 1} 첫 페이지`;
      }
    }
    applyContextualToolbarMode();
    // 서식 도구 모음은 머리말/꼬리말 편집 시에도 유지 (문단/글자 모양 설정 필요)
    // 본문 dimming
    if (scrollContainer) {
      if (isActive) {
        scrollContainer.classList.add('hf-editing');
      } else {
        scrollContainer.classList.remove('hf-editing');
      }
    }
  });

  eventBus.on('footnoteModeChanged', (active) => {
    const isActive = active as boolean;
    noteToolbarActive = isActive;
    if (isActive) setBasicToolboxExpanded(true);
    applyContextualToolbarMode();
  });

  applyContextualToolbarMode();
}

function applyEditorSettingsPreview(settings: EditorScalarSettings): void {
  applyTheme(settings.theme.mode);
  syncThemeMenu(settings.theme.mode);
  wasm.setShowControlCodes(settings.view.showControlCodes);
  wasm.setShowParagraphMarks(settings.view.showParagraphMarks);
  syncTextMarkMenu(settings.view.showControlCodes, settings.view.showParagraphMarks);
  const clipEnabled = !settings.view.clipView;
  wasm.setClipEnabled(clipEnabled);
  syncClipMenu(clipEnabled);
  eventBus.emit('document-view-changed');
}

function commitEditorSettingsRuntime(settings: EditorScalarSettings): void {
  applyEditorSettingsPreview(settings);
  eventBus.emit('autosave-settings-changed');
  eventBus.emit('font-settings-changed');
  eventBus.emit('command-state-changed');
}

/** 문서마다 따로 가진 보기 설정(조판 부호·문단 부호·잘라 보기)을 사용자 설정에 맞춘다. */
function applyTextMarkSettingsTo(target: WasmBridge): void {
  const settings = userSettings.getEditorScalarSettings();
  target.setShowControlCodes(settings.view.showControlCodes);
  target.setShowParagraphMarks(settings.view.showParagraphMarks);
  target.setClipEnabled(!settings.view.clipView);
}

/** 문서 초기화 공통 시퀀스 (loadFile, createNewDocument 양쪽에서 사용) */
function applySavedTextMarkSettings(): void {
  applyEditorSettingsPreview(userSettings.getEditorScalarSettings());
}

async function initializeDocument(
  docInfo: DocumentInfo,
  options: {
    suppressDialogs?: boolean;
    fromDisk?: boolean;
    initialDirtyReason?: string;
    autoEnableVersions?: boolean;
  } = {},
): Promise<void> {
  const msg = sbMessage();
  try {
    await updateLoadProgress(55, '폰트 준비 중...');
    setActiveDocumentFonts(docInfo.fontsUsed ?? []);
    const desktopFontsStartedAt = performance.now();
    // 저장된 글꼴 폴더 핸들을 먼저 확인한다 (IndexedDB 조회뿐이라 짧다).
    if (fontFolderRestore) await settleWithin(fontFolderRestore, DESKTOP_FONT_LOAD_BUDGET_MS);
    // 웹 글꼴과 함께 사용자 PC의 글꼴(데스크톱 색인·글꼴 폴더·로컬 글꼴 감지)을 연결한다.
    // 첫 페이지가 실제 글꼴로 조판되도록 제한 시간 안에 끝나면 레이아웃을 다시 계산한 뒤 그린다.
    const fontsUsed = docInfo.fontsUsed;
    const desktopFonts = fontsUsed?.length
      ? (async () => {
        await loadStoredLocalFonts();
        return prepareSystemFontsForDocument(fontsUsed);
      })().catch((error): DesktopFontReport[] => {
        console.warn('[DesktopFonts] 문서 글꼴 연결 실패:', error);
        return [];
      })
      : null;
    if (docInfo.fontsUsed?.length) {
      await loadWebFonts(docInfo.fontsUsed, (loaded, total) => {
        const fontPercent = total > 0 ? 55 + Math.round((loaded / total) * 20) : 65;
        msg.textContent = `파일 로딩 ${fontPercent}% - 폰트 로딩 중... (${loaded}/${total})`;
      }, { ...extensionViewerSettings, onLateLoad: repaintAfterLateWebFonts });
    }
    if (desktopFonts) {
      const budget = DESKTOP_FONT_LOAD_BUDGET_MS - (performance.now() - desktopFontsStartedAt);
      const settled = await settleWithin(desktopFonts, budget);
      if (settled) {
        const reports = settled.value;
        const hftChanged = takeHftOutlineChange();
        if (fontReportsChangedLayout(reports) || hftChanged) wasm.refreshLayout();
        for (const report of reports) finalizeDesktopFontReport(report);
      } else {
        console.info(`[DesktopFonts] ${DESKTOP_FONT_LOAD_BUDGET_MS}ms 안에 끝나지 않아 백그라운드에서 계속 연결합니다.`);
        // 글꼴 등록은 세션 전체에 적용되므로 그사이 다른 문서가 열렸어도 현재 문서를 다시 조판한다.
        void desktopFonts.then(applyLateFontReports);
      }
    }
    await updateLoadProgress(75, '문서 상태 적용 중...');
    totalSections = docInfo.sectionCount ?? 1;
    statusSectionIndex = 0;
    sbSection().textContent = `구역: 1 / ${totalSections}`;
    schedulePaperStatus();
    applySavedTextMarkSettings();
    await updateLoadProgress(82, '페이지 렌더 준비 중...');
    await canvasView?.loadDocument();
    prepareCanvasKitLocalFonts(docInfo.fontsUsed);
    prepareLocalFontRepairs(docInfo.fontsUsed);
    await updateLoadProgress(90, '도구 모음 준비 중...');
    toolbar?.setEnabled(!sessionReadOnly() && !agentEditingLease.active);
    toolbar?.initFontDropdown(docInfo.fontsUsed);
    toolbar?.initStyleDropdown();
    await updateLoadProgress(94, '문서 검증 및 글꼴 확인 중...');
    const emptyState = document.getElementById('document-empty-state');
    if (emptyState) {
      emptyState.hidden = true;
      emptyState.setAttribute('aria-hidden', 'true');
    }

    // #177: HWPX 비표준 lineseg 감지 (진단 로그).
    // #2527: 자동 보정(reflowLinesegs)이 빈-lineseg 문서에서 글리프 좌표를 붕괴시켜
    // 글자가 대량으로 겹치므로, 모달을 띄우지 않고 항상 '그대로 보기'로 연다.
    // reflow 근본 수정 후 모달/자동 보정 재도입을 검토한다.
    try {
      if (wasm.getSourceFormat() === 'hwpx') {
        const report = wasm.getValidationWarnings();
        if (report.count > 0) {
          console.log(`[validation] ${report.count} warnings — 그대로 보기 (#2527)`, report.summary);
        }
      } else if (wasm.getSourceFormat() === 'hml') {
        const metadata = wasm.getHmlOpenMetadata();
        if (metadata) showHmlImportWarning(metadata);
      }
    } catch (e) {
      console.warn('[validation] 감지 실패 (치명적이지 않음):', e);
    }

    if (!options.suppressDialogs) {
      await promptLocalFontsIfNeeded(docInfo);
    }

    // 로컬 글꼴 감지 결과가 뷰를 갱신한 뒤에 캐럿을 연결해야 입력 포커스가 재설정과 경합하지 않는다.
    await updateLoadProgress(96, '편집 상태 초기화 중...');
    inputHandler?.activateWithCaretPosition();
    eventBus.emit('document-context-changed');
    scheduleCharacterStatus(true);
    // 최종 단계 뒤에는 비동기 작업이 없으므로 100% progress paint를 기다리지 않는다.
    msg.textContent = documentReadOnly ? '읽기 전용' : '';
    updateFontStatusButton();

    // #2527: 자동 보정을 하지 않으므로 로드 직후 문서는 clean 이다. 복구한 자동 저장본만 dirty 로 연다.
    // 버전 기록이 문서를 저장된 기준으로 기록하지 않도록 documentLoaded 보다 먼저 정한다.
    if (options.initialDirtyReason) documentState.markDirty(options.initialDirtyReason);
    else documentState.markClean('document-initialized');
    try {
      await attachedSession.versions?.documentLoaded({
        fromDisk: options.fromDisk,
        autoEnable: options.autoEnableVersions,
      });
    } catch (error) {
      console.warn('[Hancom Git] Could not initialize document history', error);
      showToast({ message: '문서는 열렸지만 버전 기록을 준비하지 못했습니다.', durationMs: 4500 });
    }
  } catch (error) {
    console.error('[initDoc] 오류:', error);
    if (window.innerWidth < 768) alert(`초기화 오류: ${error}`);
  }
}

async function promptLocalFontsIfNeeded(docInfo: DocumentInfo): Promise<void> {
  if (!docInfo.fontsUsed?.length) return;

  const msg = sbMessage();
  try {
    await loadStoredLocalFonts();
    const report = analyzeDocumentFonts(docInfo.fontsUsed);
    if (!report.shouldPromptLocalAccess) return;

    const folderState = getFontFolderState();
    // 글꼴 폴더나 에이전트 허브의 글꼴 색인을 받았으면 데스크톱처럼 문서를 열 때 묻지 않는다.
    // 연결하지 못한 글꼴 수는 상태 바에, 감지·가져오기는 설정에 있다.
    if (folderState.status === 'connected' || folderState.status === 'connecting') return;
    if (isDesktopFontIndexReady()) return;
    const reconnect = folderState.status === 'needs-permission';
    const offerFolder = !isDesktopFontsSupported() && isFontFolderSupported()
      && (folderState.status === 'none' || folderState.status === 'error' || reconnect);
    const choice = await showLocalFontsModalIfNeeded(report, {
      disableExternalWebFonts: extensionViewerSettings.disableExternalWebFonts,
      folder: offerFolder
        ? { reconnect, connect: () => (reconnect ? reconnectFontFolder() : chooseFontFolder()) }
        : null,
    });
    if (typeof choice === 'object' && choice.type === 'folder') {
      // 색인은 뒤에서 이어 가고, 연결되면 handleFontFolderState가 문서 글꼴을 연결해 다시 조판한다.
      void choice.result.catch((error: unknown) => {
        console.warn('[FontFolder] 연결 실패:', error);
        showToast({ message: '글꼴 폴더를 연결하지 못했습니다.', durationMs: 5000 });
      });
      return;
    }
    if (typeof choice === 'object' && choice.type === 'import') {
      try {
        const result = await importLocalFontFiles(choice.files);
        const hftChanged = takeHftOutlineChange();
        if (result.imported.length > 0 || hftChanged) {
          const fonts = getLocalFonts({ includeRegistered: true });
          eventBus.emit('local-fonts-changed', { fonts, report: analyzeDocumentFonts(docInfo.fontsUsed) });
          eventBus.emit('font-files-imported');
        }
        showToast({ message: localFontImportMessage(result), durationMs: result.rejected.length ? 8000 : 5000 });
      } catch (error) {
        showToast({
          message: error instanceof Error ? error.message : '글꼴 파일을 불러오지 못했습니다.',
          durationMs: 6000,
        });
      }
      return;
    }
    if (choice !== 'detect') return;

    msg.textContent = '글꼴 감지 중...';
    const result = await detectAllFonts();
    msg.textContent = '';
    showToast({ message: fontDetectionMessage(result), durationMs: 5000 });
  } catch (error) {
    console.warn('[local-fonts] 감지 안내/실행 실패 (치명적이지 않음):', error);
    msg.textContent = '';
    showToast({
      message: '로컬 글꼴 감지에 실패했습니다.\n웹 대체 글꼴로 계속 표시합니다.',
      durationMs: 8000,
    });
  }
}

async function loadFile(
  file: File,
  options: {
    skipUnsavedGuard?: boolean;
    fileHandle?: FileSystemFileHandleLike | null;
    /** Drag payloads retain a save handle but never receive the exact-picker parser grant. */
    untrustedSource?: boolean;
  } = {},
): Promise<boolean> {
  try {
    if (!shouldOpenInNewSession() && !await canReplaceCurrentDocument(options.skipUnsavedGuard)) {
      return false;
    }
    await updateLoadProgress(0, '파일 읽는 중...');
    const selected = options.fileHandle && !options.untrustedSource
      ? await readFileFromHandle(options.fileHandle)
      : {
        bytes: await readBlobBytesWithLimit(file, UNTRUSTED_DOCUMENT_MAX_BYTES, '문서'),
        name: file.name,
      };
    await updateLoadProgress(15, '파일 읽기 완료');
    return openDocumentBytes({
      bytes: selected.bytes,
      fileName: selected.name,
      fileHandle: options.fileHandle ?? null,
      skipUnsavedGuard: true,
    });
  } catch (error) {
    await options.fileHandle?.releaseUnusedSaveTarget?.().catch(() => {});
    if (!(error instanceof DocumentOwnedElsewhereError)) showLoadError(error);
    return false;
  }
}

function prepareCanvasRendererDocument(): void {
  canvasView?.prepareDocumentLoad();
}

async function reserveDocumentOpen(
  data: Uint8Array,
  fileHandle: typeof wasm.currentFileHandle,
  { freshDocumentId = false, grant }: { freshDocumentId?: boolean; grant?: VerifiedDocumentGrant | null } = {},
): Promise<{ identity: DocumentPreflightIdentity; reservationId: string | null | undefined }> {
  const mainIssuedDocumentId = getNativeFileHandleVerifiedDocumentId(fileHandle);
  const verifiedGrant = grant ?? (mainIssuedDocumentId
    ? { kind: 'verified' as const, documentId: mainIssuedDocumentId }
    : null);
  const resolved = await resolveDocumentPreflight(
    data,
    fileHandle,
    await listRecentDocs(),
    undefined,
    verifiedGrant,
  );
  // 확인된 문서 ID 가 있으면 그 ID 가 이긴다.
  const identity = freshDocumentId && !verifiedGrant
    ? { ...resolved, documentId: createActiveDocumentId(), useSourceDigest: false }
    : resolved;
  const live = liveSessionForDocument(identity.documentId)
    ?? await liveSessionForFile(fileHandle);
  if (live && live !== attachedSession) throw new DocumentLiveInSessionError(live);
  const reservationId = await reserveDesktopDocument(identity, fileHandle, undefined, attachedSession.slotId);
  if (reservationId === null) throw new DocumentOwnedElsewhereError();
  return { identity, reservationId };
}

async function reserveSaveHandleForWrite(
  handle: FileSystemFileHandleLike,
): Promise<((saved: boolean) => Promise<void>) | void> {
  if (isManagedWorktree()) {
    // 내보낸 사본은 현재 워크트리와 다른 문서다. 성공해도 이 세션의 파일 점유를 바꾸지 않는다.
    const source = attachedSession;
    const slotId = source.slotId;
    const identity = { documentId: createActiveDocumentId(), sourceDigest: null, useSourceDigest: false };
    const reservationId = await reserveDesktopDocument(identity, handle, undefined, slotId);
    if (reservationId === null) throw new DocumentOwnedElsewhereError();
    try {
      bindNativeFileHandleIdentity(handle, identity);
      const linked = new Set((await worktreeStore.listWorktrees(source.worktree!.repositoryId)).map((entry) => String(entry.documentId)));
      const handles = [
        ...liveSessions.map((session) => session.wasm.currentFileHandle),
        ...(await listRecentDocs()).filter((entry) => linked.has(entry.documentId)).map((entry) => entry.handle),
      ];
      for (const owned of handles) {
        if (owned && (owned === handle || await handle.isSameEntry?.(owned))) {
          throw new Error('연결된 문서를 덮어쓸 수 없습니다. 다른 파일 이름을 선택하세요.');
        }
      }
    } catch (error) {
      await cancelDesktopDocument(reservationId, undefined, slotId).catch(() => {});
      throw error;
    }
    return async () => { await cancelDesktopDocument(reservationId, undefined, slotId); };
  }
  const currentHandle = wasm.currentFileHandle;
  const currentIdentity = attachedSession.documentId
    ? { documentId: attachedSession.documentId, sourceDigest: wasm.documentDigest, useSourceDigest: false }
    : null;
  if (handle === currentHandle) {
    if (currentIdentity) bindNativeFileHandleIdentity(handle, currentIdentity);
    return;
  }
  if (currentHandle && typeof handle.isSameEntry === 'function') {
    try {
      if (await handle.isSameEntry(currentHandle)) {
        if (currentIdentity) bindNativeFileHandleIdentity(handle, currentIdentity);
        return;
      }
    } catch {
      // Continue with recent/digest identity when the browser cannot compare handles.
    }
  }

  if (handle.identityKind === 'native-path') {
    if (!currentIdentity) throw new Error('Active document identity is unavailable');
    bindNativeFileHandleIdentity(handle, currentIdentity);
    const slotId = attachedSession.slotId;
    const reservationId = await reserveDesktopDocument(currentIdentity, handle, undefined, slotId);
    if (reservationId === null) throw new DocumentOwnedElsewhereError();
    if (!reservationId) return;
    return async (saved) => {
      if (saved) await commitDesktopDocument(reservationId, undefined, slotId);
      else await cancelDesktopDocument(reservationId, undefined, slotId);
    };
  }

  const target = await handle.getFile();
  const targetBytes = await readBlobBytesWithLimit(
    target,
    EXACT_LOCAL_DOCUMENT_MAX_BYTES,
    '저장 대상 문서',
  );
  const identity = await resolveDocumentPreflight(targetBytes, handle, await listRecentDocs());
  if (identity.documentId === attachedSession.documentId) return;

  const slotId = attachedSession.slotId;
  const reservationId = await reserveDesktopDocument(identity, handle, undefined, slotId);
  if (reservationId === null) throw new DocumentOwnedElsewhereError();
  if (!reservationId) return;
  return () => cancelDesktopDocument(reservationId, undefined, slotId);
}

/** 문서 열기는 끝날 때까지 화면 세션을 바꾸지 않는다 (trackDocumentIo). */
function loadBytes(...args: Parameters<typeof loadBytesNow>): Promise<void> {
  // 멈춘 엔진에 올리면 지금 문서를 먼저 해제한 뒤 실패하고 그 자동 저장본까지 지운다.
  const trap = engineTrap();
  if (trap) return Promise.reject(new EngineTrappedError(trap.message));
  return trackDocumentIo(async () => {
    const target = attachedSession;
    if (target.worktree && target.worktreeWritable && target.wasm.hasLoadedDocument()) {
      await target.versions?.persistWorktree();
      await target.versions?.whenIdle();
    }
    loadingWorktreeSessions.add(target);
    try { await loadBytesNow(...args); }
    finally {
      loadingWorktreeSessions.delete(target);
      if (target === attachedSession) setDocumentReadOnly(documentReadOnly);
    }
  });
}

async function loadBytesNow(
  data: Uint8Array,
  fileName: string,
  fileHandle: typeof wasm.currentFileHandle,
  startTime = performance.now(),
  options: {
    dataReadProgressShown?: boolean;
    skipRecent?: boolean;
    suppressDialogs?: boolean;
    /** 이미 저장소에서 읽은 작업 바이트이면 디스크 열기 복구를 반복하지 않는다. */
    worktreeSnapshot?: boolean;
    grant?: VerifiedDocumentGrant | null;
    preparedDocument?: PreparedWasmDocument;
    /** 복구한 draft 의 id. 새 id 대신 이 id 로 자동 저장해 복구본을 제자리에서 갱신한다. */
    autosaveDraftId?: string;
    /** fileHandle 이 가리키는 파일 전체 바이트. data 가 그 안의 문서일 때(RHWPX) 넘긴다. */
    nativeSourceBytes?: Uint8Array;
    /** grant 가 없을 때 최근 문서와 맞추지 않고 새 문서 ID 를 만든다. */
    freshDocumentId?: boolean;
    /**
     * fileHandle 이 가리키는 파일의 디스크 바이트. data 가 디스크 내용과 다를 때(자동 저장본 복구)
     * 넘긴다. 문서 식별·저장 충돌 기준·최근 문서 digest·자동 저장 기준은 이 바이트를 따른다.
     */
    diskBytes?: Uint8Array;
    /** 있으면 문서를 clean 대신 이 이유로 dirty 로 연다. */
    initialDirtyReason?: string;
    /** 자동 저장 기준. 생략하면 연 파일 바이트, null 이면 기준 없이 시작한다. */
    autosaveBase?: AutosaveBaseInput | null;
    /** false 면 전역 설정과 상관없이 열 때 버전 기록을 켜지 않는다. 자동 저장본 병합이 직접 켠다. */
    autoEnableVersions?: boolean;
    /** 보관된 원본 작업 공간으로 바꾸지 않고 이 바이트를 그대로 연다 (자동 저장본 병합 전 디스크 내용). */
    keepBytes?: boolean;
  } = {},
): Promise<void> {
  const target = attachedSession;
  const sourceBytes = options.diskBytes ?? data;
  const ownership = await reserveDocumentOpen(
    sourceBytes,
    fileHandle,
    { freshDocumentId: options.freshDocumentId, grant: options.grant },
  );
  try {
    assertStillAttached(target);
  } catch (error) {
    await cancelDesktopDocument(ownership.reservationId, undefined, target.slotId).catch(() => {});
    throw error;
  }
  const previousFileHandle = wasm.currentFileHandle;
  const previousBinding = {
    documentId: target.documentId, worktree: target.worktree,
    writable: target.worktreeWritable, denied: deniedWorktreeSessions.has(target),
  };
  try {
    if (target.worktree && target.worktree.documentId !== ownership.identity.documentId) {
      worktreeOwnership.release(target);
      deniedWorktreeSessions.delete(target);
      target.worktree = null;
      target.worktreeWritable = false;
    }
    target.documentId = ownership.identity.documentId;
    if (!options.worktreeSnapshot && !options.autosaveDraftId && !options.keepBytes) {
      const persisted = await worktreeStore.findWorktreeByDocumentId(versionDocumentId(ownership.identity.documentId));
      if (persisted?.primary && String(persisted.blobId) !== String(persisted.savedFingerprint)) {
        // 원본 파일을 다시 열어도 닫기 전에 보관한 편집을 디스크의 이전 내용으로 덮지 않는다.
        const writable = await worktreeOwnership.claim(target, persisted.documentId);
        const latest = await worktreeStore.getWorktree(persisted.id);
        const blob = latest ? await worktreeStore.getBlob(latest.blobId) : null;
        if (!latest || !blob) throw new Error('보관된 원본 작업 공간을 읽지 못했습니다.');
        const recent = (await listRecentDocs()).find((entry) => entry.documentId === persisted.documentId);
        const originalBytes = options.nativeSourceBytes ?? data;
        if (recent && recent.sourceDigest !== ownership.identity.sourceDigest) {
          await fileHandle?.releaseUnusedSaveTarget?.().catch(() => {});
          fileHandle = null;
          showToast({ message: '원본 파일이 변경되어 보관된 작업을 별도로 열었습니다.', durationMs: 4500 });
        }
        data = blob.bytes;
      options = { ...options, skipRecent: true, worktreeSnapshot: true, preparedDocument: undefined, nativeSourceBytes: originalBytes };
        target.worktree = latest;
        target.worktreeWritable = writable;
        if (!writable) deniedWorktreeSessions.add(target);
      }
    }
  } catch (error) {
    await cancelDesktopDocument(ownership.reservationId, undefined, target.slotId).catch(() => {});
    worktreeOwnership.release(target);
    target.documentId = previousBinding.documentId;
    target.worktree = previousBinding.worktree;
    target.worktreeWritable = previousBinding.writable && previousBinding.worktree !== null
      ? await worktreeOwnership.claim(target, previousBinding.worktree.documentId)
      : false;
    if (previousBinding.denied || (previousBinding.worktree && !target.worktreeWritable)) {
      deniedWorktreeSessions.add(target);
    } else {
      deniedWorktreeSessions.delete(target);
    }
    throw error;
  }
  if (!options.dataReadProgressShown) {
    await updateLoadProgress(0, '문서 데이터 준비 중...');
  }
  await updateLoadProgress(25, '문서 파싱 및 쪽 계산 중...');
  let docInfo: DocumentInfo;
  try {
    // 문서를 바꾸기 직전에 한 번 더 본다. 다른 세션의 문서를 덮으면 그 문서의 에이전트가 끝난다.
    assertStillAttached(target);
    inputHandler?.deactivate();
    docInfo = options.preparedDocument
      ? wasm.adoptPreparedDocument(options.preparedDocument)
      : consumeExactLocalFileRead(data, fileHandle)
        ? wasm.loadTrustedLocalFileOnce(data, fileName)
        : wasm.loadDocument(data, fileName);
    if (options.diskBytes) {
      // 화면에는 자동 저장본을 열었지만 파일은 디스크 내용 그대로다. 원본 digest 를 기준으로 삼고,
      // 디스크 바이트를 읽을 때 붙은 일회성 신뢰 표시는 여기서 소비한다.
      wasm.adoptSourceDigest(ownership.identity.sourceDigest);
      consumeExactLocalFileRead(options.diskBytes, fileHandle);
    }
    await commitDesktopDocument(ownership.reservationId, undefined, attachedSession.slotId);
    fileHandle?.adoptSaveTarget?.();
  } catch (error) {
    await cancelDesktopDocument(ownership.reservationId, undefined, attachedSession.slotId).catch(() => {});
    worktreeOwnership.release(target);
    deniedWorktreeSessions.delete(target);
    target.worktree = null;
    target.worktreeWritable = false;
    attachedSession.documentId = null;
    eventBus.emit('document-context-changed');
    await releaseDesktopDocument(undefined, attachedSession.slotId).catch(() => {});
    await releaseReplacedNativeFileHandle(previousFileHandle, null).catch(() => {});
    await autosaveManager.endDocument({ discardDraft: true, reason: 'failed-document-replacement' })
      .catch(() => {});
    throw error;
  }
  attachedSession.documentId = ownership.identity.documentId;
  bindNativeFileHandleIdentity(fileHandle, ownership.identity);
  await rememberNativeDocument(
    ownership.identity.documentId,
    fileHandle,
    ownership.identity.sourceDigest,
  )
    .catch((error) => console.warn('[desktop] native document bookmark failed:', error));
  // 같은 창에서 같은 파일을 다시 열면 핸들이 재사용된다. 방금 연 바이트를 저장 충돌 기준으로 삼는다.
  await adoptLoadedNativeFileContent(fileHandle, options.nativeSourceBytes ?? sourceBytes)
    .catch((error) => console.warn('[desktop] 네이티브 파일 저장 기준 갱신 실패:', error));
  await releaseReplacedNativeFileHandle(previousFileHandle, fileHandle)
    .catch((error) => console.warn('[desktop] 교체된 네이티브 파일 핸들 해제 실패:', error));
  prepareCanvasRendererDocument();
  hostSave.reset();
  eventBus.emit('document-swapped');
  await updateLoadProgress(45, '자동 저장 준비 중...');
  forgetConvertedHmlSaveHandle(fileHandle);
  wasm.currentFileHandle = fileHandle;

  // 최근 문서 기록 — 문서 로드 성공 직후, 폰트/모달 등 블로킹 UI 단계 이전에 기록한다.
  // 핸들이 있으면 라이브 재열기용으로 함께 기록하고, 없으면(드롭/input/URL 로드)
  // 메타-only 로 기록한다 — 목록에는 남기되 자동 재열기는 핸들 있는 항목만 가능하다.
  // 원본과 연결하지 않은 복구 문서는 options.skipRecent 로 제외.
  if (!options.skipRecent) {
    const sourceDigest = wasm.documentDigest;
    if (!sourceDigest) {
      console.warn('[recent] 원본 digest가 없어 세션 전용 문서 ID를 사용합니다.');
    } else {
      try {
        await addRecentDoc({
          documentId: ownership.identity.documentId,
          sourceDigest,
          fileName: wasm.fileName,
          sourceFormat: wasm.getSourceFormat(),
          handle: fileHandle,
        });
      } catch (err) {
        console.warn('[recent] 최근 문서 기록 실패, 세션 identity를 유지합니다:', err);
      }
    }
  }

  const baseBytes = options.nativeSourceBytes ?? sourceBytes;
  // 관리되는 워크트리는 파일이 아니라 공유 버전 저장소에 저장한다. 파일 기준을 남기지 않아야 복구할 때
  // 원본 파일에 연결되지 않고, 같은 문서 ID 로 열려 그 워크트리로 돌아간다. 파일 핸들 없이 연
  // 작업 공간 스냅숏도 디스크 파일과 이어지지 않는다.
  const fileBacked = !isManagedWorktree(target) && !(options.worktreeSnapshot && !fileHandle);
  await autosaveManager.beginDocument(
    {
      fileName: wasm.fileName,
      sourceFormat: wasm.getSourceFormat(),
      documentId: ownership.identity.documentId,
      ...(options.autosaveDraftId ? { draftId: options.autosaveDraftId } : {}),
    },
    {
      discardPreviousDraft: true,
      base: options.autosaveBase !== undefined ? options.autosaveBase : fileBacked ? {
        bytes: baseBytes,
        digest: documentSourceDigest(baseBytes),
        // .rhwpx 묶음은 문서 자체가 아니어서 병합 기준으로 쓸 수 없다.
        mergeable: !isPortableHistoryBytes(baseBytes),
      } : null,
    },
  );
  await updateLoadProgress(50, '문서 초기화 중...');
  const elapsed = performance.now() - startTime;
  console.debug(`[load] ${fileName}: ${docInfo.pageCount} pages in ${elapsed.toFixed(1)}ms`);
  loadingWorktreeSessions.delete(target);
  await initializeDocument(docInfo, {
    suppressDialogs: options.suppressDialogs,
    fromDisk: !options.worktreeSnapshot && !options.autosaveDraftId && !options.keepBytes,
    initialDirtyReason: options.initialDirtyReason,
    autoEnableVersions: options.autoEnableVersions,
  });
}

/** 시작 화면(empty state)의 최근 문서 목록 — 파일 메뉴 서브패널과 같은 목록/명령을 쓴다. */
async function renderEmptyStateRecents(): Promise<void> {
  const host = document.getElementById('document-recent-list');
  if (!host) return;
  let recents;
  try {
    recents = await listRecentDocs();
  } catch {
    return;
  }
  if (!recents.length) return;
  const title = document.createElement('h3');
  title.className = 'empty-recent-title';
  title.textContent = '최근 문서';
  const list = document.createElement('div');
  list.className = 'empty-recent-list';
  for (const doc of recents.slice(0, 8)) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'empty-recent-item';
    item.title = doc.fileName;
    const name = document.createElement('span');
    name.className = 'empty-recent-name';
    name.textContent = doc.fileName;
    const format = document.createElement('span');
    format.className = 'empty-recent-format';
    format.textContent = doc.sourceFormat.toUpperCase();
    item.append(name, format);
    item.addEventListener('click', () => dispatcher.dispatch('file:open-recent', { id: doc.id }));
    list.appendChild(item);
  }
  host.replaceChildren(title, list);
}

/** 파일 메뉴 "최근 문서" 서브패널을 최신 목록으로 다시 렌더한다(메뉴 open 시 호출). */
async function renderRecentSubmenu(): Promise<void> {
  const panel = document.getElementById('recent-docs-panel');
  if (!panel) return;

  let recents;
  try {
    recents = await listRecentDocs();
  } catch (err) {
    console.warn('[recent] 최근 문서 조회 실패:', err);
    return;
  }

  const makeItem = (opts: {
    label: string;
    cmd?: string;
    id?: string;
    right?: string;
    disabled?: boolean;
    title?: string;
  }): HTMLElement => {
    const item = document.createElement('div');
    item.className = opts.disabled ? 'md-item disabled' : 'md-item';
    if (opts.cmd) item.dataset.cmd = opts.cmd;
    if (opts.id) item.dataset.id = opts.id;
    if (opts.title) item.title = opts.title;
    const icon = document.createElement('span');
    icon.className = 'md-icon';
    const label = document.createElement('span');
    label.className = 'md-label';
    label.textContent = opts.label;
    item.append(icon, label);
    if (opts.right) {
      const right = document.createElement('span');
      right.className = 'md-shortcut';
      right.textContent = opts.right;
      item.append(right);
    }
    return item;
  };

  const frag = document.createDocumentFragment();
  if (recents.length === 0) {
    frag.append(makeItem({ label: '(최근 문서 없음)', disabled: true }));
  } else {
    for (const doc of recents) {
      frag.append(
        makeItem({
          label: doc.fileName,
          cmd: 'file:open-recent',
          id: doc.id,
          right: doc.sourceFormat.toUpperCase(),
          title: doc.fileName,
        }),
      );
    }
    const sep = document.createElement('div');
    sep.className = 'md-sep';
    frag.append(sep);
    frag.append(makeItem({ label: '최근 문서 목록 지우기', cmd: 'file:clear-recent' }));
  }

  panel.replaceChildren(frag);
  // 목록이 비면 서브메뉴 자체를 비활성(hover 열림 차단). updateMenuStates가
  // 렌더 이전(스테일) 내용으로 판정하므로 여기서 직접 갱신한다.
  panel.closest('.md-sub')?.classList.toggle('disabled', recents.length === 0);
}

function shouldSkipInitialAutosaveRecovery(): boolean {
  const params = new URLSearchParams(window.location.search);
  return params.has('url') || isPinnedDocumentEnabled();
}

async function loadPinnedDocument(): Promise<void> {
  try {
    await startPinnedDocument({
      eventBus,
      // 글꼴 구성은 서버 쪽 번들 글꼴을 그대로 쓰므로 기기별 로컬 글꼴 안내를 띄우지 않는다.
      loadBytes: (data, fileName) => loadBytes(data, fileName, null, performance.now(), {
        skipRecent: true,
        freshDocumentId: true,
        suppressDialogs: true,
        autosaveBase: null,
      }),
      exportBytes: () => wasm.exportHwp(),
      markSaved: () => {
        documentState.markClean('pinned-save');
        void autosaveManager.discardCurrentDraft('pinned-save');
      },
    });
  } catch (error) {
    showLoadError(error);
  }
}

async function offerAutosaveRecoveryAtStartup(): Promise<void> {
  if (shouldSkipInitialAutosaveRecovery()) return;

  try {
    await rendererSessionContextPromise;
    await offerAutosaveRecovery({
      listRecoverable: () => listRecoverableAutosaveDrafts(),
      hasOpenDocument: () => wasm.pageCount > 0 || documentState.isDirty(),
      notifyAvailable: (open) => showToast({
        message: '복구할 수 있는 자동 저장본이 있습니다.',
        durationMs: 0,
        action: { label: '복구', onClick: open },
      }),
      markOffered: (ids) => markAutosaveDraftsOffered(ids),
      showDialog: (drafts) => showAutosaveRecoveryDialog(drafts),
      clearRecoverable: () => clearRecoverableAutosaveDrafts(),
      canReplaceCurrentDocument: () => canReplaceCurrentDocument(),
      restore: (draft) => restoreAutosaveDraftIntoEditor(draft),
      toast: (message, durationMs) => showToast({ message, durationMs }),
      onRestoreError: (error) => showLoadError(error),
      // 멈춘 엔진에는 열 수 없고, 남은 복구본은 다음 문서 복구가 다시 열 문서의 것이다.
      engineStopped: () => engineTrap() !== null,
      onEngineStopped: () => { refuseDocumentOpenWhileTrapped(); },
    });
  } catch (error) {
    console.warn('[autosave] 복구 후보 확인 실패:', error);
  }
}

function restoreAutosaveDraftIntoEditor(draft: AutosaveDraftSummary): Promise<void> {
  if (refuseDocumentOpenWhileTrapped()) return Promise.resolve();
  return runNavigation(() => restoreAutosaveDraftNow(draft));
}

/** 이 창의 세션이 아닌 다른 창이 이 문서의 워크트리 편집권을 쥐고 있다. */
async function worktreeHeldElsewhere(documentId: string | undefined): Promise<boolean> {
  if (!documentId || !navigator.locks?.query) return false;
  if (liveSessions.some((session) => worktreeOwnership.owns(session, documentId))) return false;
  try {
    const state = await navigator.locks.query();
    return (state.held ?? []).some((lock) => lock.name === `rhwp-worktree:${documentId}`);
  } catch {
    return false;
  }
}

async function restoreAutosaveDraftNow(draft: AutosaveDraftSummary): Promise<void> {
  // 다른 창이 이 문서를 편집 중이면 여기서 열어도 읽기 전용이다. 그 창에서 닫은 뒤 복구하게 한다.
  if (await worktreeHeldElsewhere(draft.documentId)) {
    showToast({ message: BLOCKED_RESTORE_MESSAGE, durationMs: 5000 });
    return;
  }
  // 같은 문서가 이 창의 다른 세션에 열려 있으면 그 세션으로 넘어가 그 자리에서 복구한다.
  const live = liveSessionForDocument(draft.documentId);
  if (live && live !== attachedSession) {
    if (await switchToLiveSession(live) !== 'ok') return;
    if (!await canReplaceCurrentDocument()) return;
  }
  if (attachedSession.documentId && attachedSession.documentId === draft.documentId
    && isDocumentSessionBusy(attachedSession)) {
    showToast({ message: '에이전트가 작업을 마친 뒤 다시 복구하세요.', durationMs: 3200 });
    return;
  }
  // 에이전트가 일하는 다른 문서는 뒤에 두고 새 세션에서 복구한다.
  if (shouldOpenInNewSession()) {
    await openInNewSession(() => {}, () => restoreAutosaveDraftInAttachedSession(draft));
    return;
  }
  await restoreAutosaveDraftInAttachedSession(draft);
}

function restoreAutosaveDraftInAttachedSession(
  draft: AutosaveDraftSummary,
  options: DraftRestoreOptions & { canMerge?: boolean } = {},
): Promise<DraftRestoreOutcome> {
  const { canMerge = true, ...restoreOptions } = options;
  return restoreAutosaveDraft(draft, {
    readDraft: (id) => getAutosaveDraft(id),
    locateOriginal: locateAutosaveOriginal,
    digestOf: documentSourceDigest,
    releaseHandle: async (handle) => {
      await handle.releaseUnusedSaveTarget?.().catch(() => {});
    },
    canMerge: () => canMerge && Boolean(attachedSession.versions || inputHandler),
    releaseCurrentDocument: () => {
      if (documentState.isDirty()) documentState.markClean('autosave-restore-replace');
    },
    openDraft: openAutosaveDraft,
    mergeExternal: mergeAutosaveDraft,
    deleteDraft: (id) => deleteAutosaveDraft(id),
    flush: () => autosaveManager.flushNow('autosave-recovered'),
    toast: (message, durationMs) => showToast({ message, durationMs }),
  }, restoreOptions);
}

/**
 * 복구할 문서를 지금 세션에 연다. 파일로 알아본 같은 문서가 다른 세션에 살아 있으면 그 세션으로
 * 넘어가 바꿔도 되는지 다시 물은 뒤 그 자리에 연다 (openDocumentBytesNow 와 같은 규칙).
 */
async function loadRecoveredDocument(load: () => Promise<void>): Promise<'opened' | 'blocked' | 'cancelled'> {
  try {
    try {
      await load();
    } catch (error) {
      if (!(error instanceof DocumentLiveInSessionError)) throw error;
      if (await switchToLiveSession(error.session) !== 'ok') return 'cancelled';
      if (!await canReplaceCurrentDocument()) return 'cancelled';
      await load();
    }
    return 'opened';
  } catch (error) {
    if (error instanceof DocumentOwnedElsewhereError) return 'blocked';
    if (error instanceof DocumentSessionChangedError) return 'cancelled';
    throw error;
  }
}

/** 자동 저장본의 원본 파일을 파일 선택 창 없이 찾는다. draft 에 남은 핸들, 최근 문서, 데스크톱 북마크 순이다. */
async function locateAutosaveOriginal(draft: AutosaveDraft) {
  const recents = await listRecentDocs().catch(() => []);
  const recent = recents.find((row) => row.documentId === draft.documentId);
  const digest = draft.base?.digest;
  return locateRecoveryOriginal({
    documentId: draft.documentId!,
    displayName: draft.fileName,
    knownDigest: digest?.startsWith('blake3:') ? digest as `blake3:${string}` : null,
    liveHandle: draft.fileHandle ?? recent?.handle ?? null,
    recentId: recent?.id ?? null,
  });
}

/**
 * 자동 저장본을 dirty 로 연다. clean 이면 깨끗하게 연다 — 원본이 있으면 draft 대신 원본 파일을,
 * 없으면 draft 바이트를 원본과 연결하지 않고 (읽기 전용으로 보던 문서).
 */
async function openAutosaveDraft(draft: AutosaveDraft, target: OpenDraftTarget): Promise<OpenDraftOutcome> {
  const original = target.original;
  if (target.clean && original) {
    const opened = await loadRecoveredDocument(() => loadBytes(
      original.bytes, target.fileName, original.handle, performance.now(),
      target.documentId ? { grant: { kind: 'verified', documentId: target.documentId } } : {},
    ));
    if (opened !== 'opened') await original.handle.releaseUnusedSaveTarget?.().catch(() => {});
    return opened;
  }
  if (target.clean) {
    return loadRecoveredDocument(() => loadBytes(draft.data, target.fileName, null, performance.now(), {
      skipRecent: true,
      autosaveBase: null,
      ...(target.documentId
        ? { grant: { kind: 'verified' as const, documentId: target.documentId } }
        : { freshDocumentId: true }),
    }));
  }
  const outcome = await loadRecoveredDocument(() => loadBytes(
    draft.data, target.fileName, original?.handle ?? null, performance.now(), {
      autosaveDraftId: draft.id,
      initialDirtyReason: 'autosave-recovered',
      ...(original
        ? {
          grant: { kind: 'verified' as const, documentId: target.documentId! },
          diskBytes: original.bytes,
        }
        : {
          // 원본과 연결하지 않은 문서는 최근 목록에 넣지 않는다. 문서 ID 는 그대로 둬 채팅과 기록을 잇는다.
          skipRecent: true,
          autosaveBase: null,
          ...(target.documentId
            ? { grant: { kind: 'verified' as const, documentId: target.documentId } }
            : { freshDocumentId: true }),
        }),
    },
  ));
  if (outcome !== 'opened' && original) await original.handle.releaseUnusedSaveTarget?.().catch(() => {});
  return outcome;
}

/**
 * 디스크 파일이 바뀐 뒤의 자동 저장본. 디스크 내용을 깨끗한 원본으로 연 뒤 그 문서의 버전 기록에서
 * 외부 변경으로 남기고 draft 와 병합한다. 버전 기록을 쓸 수 없으면 연결하지 않고 연다.
 */
async function mergeAutosaveDraft(draft: AutosaveDraft, original: FoundOriginal): Promise<MergeExternalResult> {
  const base = await getAutosaveDraftBase(draft.id);
  if (!base || !(attachedSession.versions || inputHandler)) {
    await original.handle.releaseUnusedSaveTarget?.().catch(() => {});
    const opened = await openAutosaveDraft(draft, {
      fileName: draft.fileName,
      original: null,
      documentId: draft.documentId ?? null,
    });
    return opened === 'opened' ? { kind: 'detached' } : { kind: opened };
  }
  const outcome = await loadRecoveredDocument(() => loadBytes(
    original.bytes, original.name, original.handle, performance.now(), {
      grant: { kind: 'verified', documentId: draft.documentId! },
      autoEnableVersions: false,
      keepBytes: true,
    },
  ));
  if (outcome !== 'opened') {
    await original.handle.releaseUnusedSaveTarget?.().catch(() => {});
    return { kind: outcome };
  }
  const controller = attachedSession.versions ?? installDocumentVersions(attachedSession);
  await controller.whenIdle();
  const recovery = await controller.recoverAutosaveDraft({
    draftId: draft.id,
    baseBytes: base.data,
    draftBytes: draft.data,
  });
  return { kind: 'merging', ...recovery };
}

// ─── 엔진 trap 복구: 다시 불러온 페이지 ─────────────────────────────

/**
 * 멈추기 전에 열려 있던 문서를 다시 연다. 기본 자리 문서는 첫 세션에, 나머지는 새 세션에 열고
 * 보던 문서를 화면에 붙인다. 다시 연 문서의 복구본은 이 창이 이어받으므로, 끝난 뒤의 자동 저장본
 * 제안에는 관계없는 것과 열지 못한 문서의 복구본만 남는다.
 */
async function recoverDocumentsAfterTrap(run: TrapRecoveryRun<DocumentSession>): Promise<void> {
  try {
    const report = await runNavigation(async () => {
      // 복구한 draft 를 이 창 이름으로 다시 기록하므로 창 세션을 먼저 받는다.
      await rendererSessionContextPromise;
      return runTrapRecovery(run, {
        listDrafts: () => listAutosaveDrafts(),
        engineStopped: () => engineTrap() !== null,
        defaultSession: () => firstSession,
        markInterrupted: (threadId) => markThreadInterruptedByEngineTrap(threadId),
        openInDefault: (entry, plan, options) => openTrapEntryInAttached(entry, plan, options),
        openInBackground: async (entry, plan, options) => {
          let fresh: DocumentSession | null = null;
          const outcome = await openInNewSession(
            (session) => { fresh = session; },
            () => openTrapEntryInAttached(entry, plan, options),
          );
          if (!outcome) return { result: { kind: 'failed', reason: 'no-session' }, session: null };
          if (outcome.loaded) return { result: outcome.result, session: fresh };
          return {
            result: outcome.result.kind === 'failed' ? outcome.result : { kind: 'failed', reason: 'error' },
            session: null,
          };
        },
        // 일하지 않는 세션도 닫지 않도록 switchToLiveSession 이 아니라 attachSession 으로 붙인다.
        attach: (session) => attachSession(session),
      });
    });
    presentTrapRecoveryReport(report, {
      toast: (message) => showToast({ message, durationMs: 6000 }),
      openEntry: (entry) => openTrapEntryOnDemand(entry),
    });
  } catch (error) {
    console.error('[engine] 멈추기 전에 열려 있던 문서를 다시 열지 못했습니다:', error);
    showLoadError(error);
  } finally {
    void offerAutosaveRecoveryAtStartup();
  }
}

function trapResultOfRestore(outcome: DraftRestoreOutcome): TrapOpenResult {
  switch (outcome.kind) {
    case 'opened':
      return { kind: 'opened', detached: outcome.detached, message: outcome.message };
    case 'merging':
      return { kind: 'opened', merging: true, message: outcome.message };
    case 'blocked':
      return { kind: 'failed', reason: 'blocked', message: outcome.message };
    case 'cancelled':
      return { kind: 'failed', reason: 'cancelled' };
  }
}

/** 지금 화면에 붙은 세션에 manifest 항목 하나를 연다. 그 문서의 채팅이 따라 열린다. */
async function openTrapEntryInAttached(
  entry: TrapManifestEntry,
  plan: TrapEntryPlan,
  options: { canMerge: boolean },
): Promise<TrapOpenResult> {
  if (entry.activeThreadId) attachedSession.sidebar?.followThreadOnNextDocument(entry.activeThreadId);
  // 읽기 전용으로 보던 창(생성 문서 미리보기 등)은 다시 열어도 읽기 전용이다. 창 전체 설정이다.
  if (entry.readOnly) setDocumentReadOnly(true);
  try {
    if (plan.action === 'restore-draft') {
      const outcome = await restoreAutosaveDraftInAttachedSession(plan.draft, {
        canMerge: options.canMerge,
        cleanAtTrap: plan.cleanAtTrap,
        readOnly: entry.readOnly,
        report: () => {},
      });
      return trapResultOfRestore(outcome);
    }
    if (plan.action === 'reopen-file') return await reopenTrapFile(entry);
    return { kind: 'failed', reason: 'cancelled' };
  } catch (error) {
    // 정적 파서 같은 감시 밖 호출에서 난 trap 도 엔진을 멈춘 것으로 표시해 복구가 거기서 멈추게 한다.
    reportEngineTrap(error);
    console.warn('[engine] 복구 중 문서를 열지 못했습니다:', error);
    return { kind: 'failed', reason: 'error', message: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * 깨끗했던 문서를 파일 선택 창 없이 그 파일에서 다시 연다. 파일 열기와 같은 길로 연다 — 버전 기록을
 * 함께 담은 .rhwpx 묶음은 문서를 꺼내 열어야 한다.
 */
async function reopenTrapFile(entry: TrapManifestEntry): Promise<TrapOpenResult> {
  const claim = claimForExplorerGroup(
    { documentId: entry.documentId, displayName: entry.fileName },
    await listRecentDocs().catch(() => []),
  );
  if (!claim) return { kind: 'failed', reason: 'not-found' };
  const located = await locateRecoveryOriginal(claim);
  if (located.kind === 'owned-elsewhere') return { kind: 'failed', reason: 'blocked' };
  if (located.kind === 'permission-denied') return { kind: 'failed', reason: 'permission-denied' };
  if (located.kind === 'missing') return { kind: 'failed', reason: 'not-found' };
  const grant = { kind: 'verified' as const, documentId: claim.documentId };
  let replaced = true;
  const opened = await loadRecoveredDocument(
    isPortableHistoryFileName(located.name) || isPortableHistoryBytes(located.bytes)
      ? async () => {
        replaced = await openDocumentBytesInAttachedSessionNow({
          bytes: located.bytes,
          fileName: located.name,
          fileHandle: located.handle,
          grant,
          skipUnsavedGuard: true,
        });
      }
      : () => loadBytes(located.bytes, located.name, located.handle, performance.now(), { grant }),
  );
  if (opened === 'opened' && replaced) return { kind: 'opened' };
  // 바꿔 열지 않았으면 열기 쪽이 이미 핸들을 놓았다. 그 밖의 실패는 여기서 놓는다.
  if (opened !== 'opened') await located.handle.releaseUnusedSaveTarget?.().catch(() => {});
  return { kind: 'failed', reason: opened === 'opened' ? 'cancelled' : opened };
}

/** 복구 결과의 열기 — 자동으로 열지 않은 문서를 사용자가 직접 연다. 지금 문서는 그대로 둔다. */
async function openTrapEntryOnDemand(entry: TrapManifestEntry): Promise<string> {
  if (engineTrap()) return '문서 엔진이 멈춰 열 수 없습니다. 문서 복구를 다시 누르세요.';
  const drafts = entry.draft ? await listAutosaveDrafts().catch(() => []) : [];
  const row = entry.draft ? drafts.find((draft) => draft.id === entry.draft!.id) ?? null : null;
  const target = { ...entry, suspect: false, attached: true };
  const plan = planTrapEntry(target, row);
  const result = plan.action === 'skip' ? null : await runNavigation(async (): Promise<TrapOpenResult> => {
    if (!attachedSession.wasm.hasLoadedDocument()) return openTrapEntryInAttached(target, plan, { canMerge: true });
    const outcome = await openInNewSession(() => {}, () => openTrapEntryInAttached(target, plan, { canMerge: true }));
    if (outcome) {
      if (outcome.loaded) return outcome.result;
      return outcome.result.kind === 'failed' ? outcome.result : { kind: 'failed', reason: 'error' };
    }
    // 세션을 더 만들 수 없는 환경(웹 배포판)은 지금 문서를 바꿔 연다.
    if (!await canReplaceCurrentDocument()) return { kind: 'failed', reason: 'cancelled' };
    return openTrapEntryInAttached(target, plan, { canMerge: true });
  });
  return describeTrapOutcome({
    entry: target,
    plan,
    status: result === null ? 'skipped' : result.kind === 'opened' ? 'opened' : 'failed',
    result,
    draftId: row?.id ?? null,
  }, false).text;
}

function createNewDocument(): Promise<boolean> {
  // 멈춘 엔진에서는 만들기가 실패하면서 지금 문서의 자동 저장본까지 지운다.
  if (engineTrap()) return Promise.resolve(false);
  return trackDocumentIo(createNewDocumentNow);
}

async function createNewDocumentNow(): Promise<boolean> {
  const msg = sbMessage();
  const target = attachedSession;
  if (target.worktree) {
    if (target.worktreeWritable) await target.versions?.persistWorktree();
    worktreeOwnership.release(target);
    target.worktree = null;
    target.worktreeWritable = false;
  }
  const previousFileHandle = wasm.currentFileHandle;
  const identity = { documentId: createActiveDocumentId(), sourceDigest: null };
  const slotId = attachedSession.slotId;
  const reservationId = await reserveDesktopDocument(identity, null, undefined, slotId);
  if (reservationId === null) throw new DocumentOwnedElsewhereError();
  try {
    msg.textContent = '새 문서 생성 중...';
    assertStillAttached(target);
    inputHandler?.deactivate();
    const docInfo = wasm.createNewDocument();
    await commitDesktopDocument(reservationId, undefined, slotId);
    attachedSession.documentId = identity.documentId;
    hostSave.reset();
    await releaseReplacedNativeFileHandle(previousFileHandle, wasm.currentFileHandle)
      .catch((error) => console.warn('[desktop] 새 문서 전환 핸들 해제 실패:', error));
    prepareCanvasRendererDocument();
    await autosaveManager.beginDocument(
      { fileName: wasm.fileName, sourceFormat: wasm.getSourceFormat(), documentId: identity.documentId },
      { discardPreviousDraft: true, base: null },
    );
    await initializeDocument(docInfo);
    return true;
  } catch (error) {
    await cancelDesktopDocument(reservationId, undefined, slotId).catch(() => {});
    attachedSession.documentId = null;
    eventBus.emit('document-context-changed');
    await releaseDesktopDocument(undefined, slotId).catch(() => {});
    await releaseReplacedNativeFileHandle(previousFileHandle, null).catch(() => {});
    await autosaveManager.endDocument({ discardDraft: true, reason: 'failed-new-document' })
      .catch(() => {});
    msg.textContent = `새 문서 생성 실패: ${error}`;
    console.error('[main] 새 문서 생성 실패:', error);
    return false;
  }
}

async function canReplaceCurrentDocument(skipUnsavedGuard?: boolean): Promise<boolean> {
  // 저장 확인의 버리기는 지금 문서의 복구본을 지운다. 멈춘 엔진에는 바꿔 열 문서도 올릴 수 없다.
  if (refuseDocumentOpenWhileTrapped()) return false;
  if (agentEditingLease.active) {
    showToast({ message: '에이전트가 편집을 마친 뒤 문서를 바꿀 수 있습니다.', durationMs: 2600 });
    return false;
  }
  const allowed = skipUnsavedGuard === true
    || await confirmSaveBeforeReplacingDocument(commandServices);
  if (!allowed) return false;
  await attachedSession.versions?.whenIdle();
  return true;
}

/** 에이전트가 일하는 중이면 지금 문서를 뒤에 두고 새 세션에서 연다. */
function shouldOpenInNewSession(): boolean {
  return attachedSession.wasm.hasLoadedDocument()
    && (isDocumentSessionBusy(attachedSession) || isManagedWorktree());
}

function openDocumentBytes(data: OpenDocumentBytesEvent): Promise<boolean> {
  if (refuseDocumentOpenWhileTrapped()) {
    void data.fileHandle?.releaseUnusedSaveTarget?.().catch(() => {});
    return Promise.resolve(false);
  }
  // 라이브러리 이동이 내보내는 열기는 그 이동의 일부라 줄을 서지 않는다.
  return runNavigation(() => openDocumentBytesNow(data), { nested: navigationRunning > 0 });
}

async function openDocumentBytesNow(data: OpenDocumentBytesEvent): Promise<boolean> {
  try {
    if (shouldOpenInNewSession()) {
      const outcome = await openInNewSession(() => {}, () => openDocumentBytesInAttachedSession(data));
      if (!outcome) {
        await data.fileHandle?.releaseUnusedSaveTarget?.().catch(() => {});
        return false;
      }
      return outcome.loaded && outcome.result;
    }
    return await openDocumentBytesInAttachedSession(data);
  } catch (error) {
    if (error instanceof DocumentSessionChangedError) {
      await data.fileHandle?.releaseUnusedSaveTarget?.().catch(() => {});
      return false;
    }
    if (!(error instanceof DocumentLiveInSessionError)) throw error;
    // 이미 이 창에 열려 있는 문서다. 다시 읽지 않고 그 문서로 넘어간다.
    await data.fileHandle?.releaseUnusedSaveTarget?.().catch(() => {});
    return (await switchToLiveSession(error.session)) === 'ok';
  }
}

/** 열기가 시작된 문서 세션이 그사이 화면에서 바뀌었다. 열던 문서를 다른 세션에 넣지 않는다. */
class DocumentSessionChangedError extends Error {
  constructor() {
    super('문서를 여는 동안 다른 문서로 넘어갔습니다.');
    this.name = 'DocumentSessionChangedError';
  }
}

function assertStillAttached(target: DocumentSession): void {
  if (attachedSession !== target) throw new DocumentSessionChangedError();
}

/** 열기는 시작부터 끝까지 세션 전환을 막는다 (trackDocumentIo). */
function openDocumentBytesInAttachedSession(data: OpenDocumentBytesEvent): Promise<boolean> {
  return trackDocumentIo(() => openDocumentBytesInAttachedSessionNow(data));
}

async function openDocumentBytesInAttachedSessionNow(data: OpenDocumentBytesEvent): Promise<boolean> {
  if (!await canReplaceCurrentDocument(data.skipUnsavedGuard)) {
    await data.fileHandle?.releaseUnusedSaveTarget?.().catch(() => {});
    return false;
  }
  try {
    if (isPortableHistoryFileName(data.fileName) || isPortableHistoryBytes(data.bytes)) {
      const bundle = openPortableHistoryBundle(data.bytes);
      const store = new VersionGraphStore();
      let retainPortableHistoryHandle = Boolean(
        data.fileHandle
        && !isLegacyPortableHistoryFolderHandle(data.fileHandle)
        && isPortableHistoryFileName(data.fileName),
      );
      let importedRepository = false;
      let preparedDocument: PreparedWasmDocument | null = null;
      try {
        const imported = await store.importRepositorySnapshot(bundle.snapshot);
        importedRepository = imported.imported;
        const localWorktrees = await store.listWorktrees(bundle.snapshot.repository.id);
        const localWorktree = localWorktrees.find((entry) => entry.branch === bundle.activeBranch);
        if (localWorktree && localWorktree.blobId !== bundle.currentBlobId) {
          throw new Error('이 브랜치에 보관된 작업 내용이 있습니다. 워크트리에서 기존 작업을 먼저 여세요.');
        }
        if (localWorktrees.length > 0 && !localWorktree) {
          throw new Error('이 버전 기록은 이미 열려 있습니다. 워크트리에서 해당 브랜치를 여세요.');
        }
        if (localWorktree && !localWorktree.primary) retainPortableHistoryHandle = false;
        const openFileName = retainPortableHistoryHandle ? data.fileName : bundle.documentFileName;
        const openDocumentId = localWorktree?.documentId ?? bundle.snapshot.repository.documentId;
        // 최초 작업 공간이 만들어지기 전에 아카이브가 선택한 브랜치를 지정한다.
        persistActiveBranch(openDocumentId, bundle.activeBranch);
        preparedDocument = wasm.prepareDocument(
          bundle.currentDocumentBytes,
          openFileName,
        );
        userSettings.setUseHancomGit(true);
        await loadBytes(
          bundle.currentDocumentBytes,
          openFileName,
          retainPortableHistoryHandle ? data.fileHandle : null,
          performance.now(),
          {
            grant: {
              kind: 'verified',
              documentId: openDocumentId,
            },
            skipRecent: Boolean(localWorktree && !localWorktree.primary),
            preparedDocument,
            nativeSourceBytes: data.bytes,
          },
        );
        await attachedSession.versions?.refresh().catch((error) => {
          console.warn('[versioning] 가져온 기록 새로고침 실패:', error);
        });
      } catch (error) {
        if (importedRepository) {
          await store.removeImportedRepository(
            bundle.snapshot.repository.id,
            versionDocumentId(bundle.snapshot.repository.documentId),
            bundle.snapshot.repository.revision,
          ).catch(() => undefined);
        }
        throw error;
      } finally {
        preparedDocument?.dispose();
        await store.close();
      }
      if (!retainPortableHistoryHandle) {
        await data.fileHandle?.releaseUnusedSaveTarget?.().catch(() => {});
      }
      showToast({ message: '문서와 전체 버전 기록을 불러왔습니다.', durationMs: 3500 });
      return true;
    }
    await loadBytes(data.bytes, data.fileName, data.fileHandle, performance.now(), {
      grant: data.grant,
      suppressDialogs: data.suppressDialogs,
    });
    return true;
  } catch (error) {
    await data.fileHandle?.releaseUnusedSaveTarget?.().catch(() => {});
    throw error;
  }
}

// 커맨드에서 새 문서 생성 호출
eventBus.on('create-new-document', (payload) => {
  void (async () => {
    const options = payload as { skipUnsavedGuard?: boolean; requestId?: string } | undefined;
    const notify = (ok: boolean, error?: string) => {
      if (options?.requestId) eventBus.emit('create-new-document:done', { requestId: options.requestId, ok, error });
    };
    if (refuseDocumentOpenWhileTrapped()) {
      notify(false, '문서 엔진이 멈춰 새 문서를 만들 수 없습니다.');
      return;
    }
    try {
      const ok = await runNavigation(async () => {
        if (shouldOpenInNewSession()) {
          const outcome = await openInNewSession(() => {}, () => createNewDocument());
          return Boolean(outcome?.loaded && outcome.result);
        }
        if (!await canReplaceCurrentDocument(options?.skipUnsavedGuard)) return null;
        return createNewDocument();
      });
      if (ok === null) {
        notify(false, '문서 생성이 취소되었습니다.');
        return;
      }
      notify(ok, ok ? undefined : sbMessage().textContent ?? '문서 생성 실패');
    } catch (error) {
      notify(false, error instanceof Error ? error.message : String(error));
      console.error('[main] 새 문서 생성 요청 실패:', error);
    }
  })();
});
eventBus.on('open-document-bytes', async (payload) => {
  const data = payload as OpenDocumentBytesEvent;
  const notifyDone = (ok: boolean, error?: string) => {
    if (!data.requestId) return;
    eventBus.emit('open-document-bytes:done', { requestId: data.requestId, ok, error });
  };
  try {
    if (!await openDocumentBytes(data)) {
      notifyDone(false, '문서 열기가 취소되었습니다.');
      return;
    }
    notifyDone(true);
  } catch (error) {
    // #265: WASM 파서 에러 (예: HWP 3.0 미지원) 를 사용자에게 전파
    if (!(error instanceof DocumentOwnedElsewhereError)) showLoadError(error);
    const msg = error instanceof Error ? error.message : String(error);
    notifyDone(false, msg);
  }
});

// 수식 더블클릭 → 수식 편집 대화상자
eventBus.on('equation-edit-request', () => {
  dispatcher.dispatch('insert:equation-edit');
});

/**
 * URL 파라미터(?url=)로 전달된 HWP 파일을 자동 로드한다.
 * Chrome 확장 프로그램에서 뷰어 탭을 열 때 사용.
 */
async function loadFromUrlParam(): Promise<void> {
  const params = new URLSearchParams(window.location.search);
  const fileUrl = params.get('url');
  if (!fileUrl) return;

  const fileName = params.get('filename') || fileUrl.split('/').pop()?.split('?')[0] || FALLBACK_DOCUMENT_FILE_NAME;
  const msg = sbMessage();

  try {
    msg.textContent = '파일 로딩 중...';
    console.log(`[loadFromUrlParam] ${fileUrl}`);

    // file:// 은 확장 권한을 먼저 확인한다. 공개 URL 정책은 HTTP(S) 직접 fetch와
    // SW 프록시 우회 방지에만 적용한다.
    let validatedRemoteUrl: URL | null = null;
    if (fileUrl.startsWith('file:')) {
      if (typeof chrome === 'undefined') {
        throw new RemoteDocumentUrlError('scheme-blocked', 'file: URL은 확장 프로그램에서만 열 수 있습니다.');
      }
      const allowed = await isFileSchemeAccessAllowed();
      if (allowed === false) {
        showFileUrlAccessGuidance();
        return;
      }
    } else {
      // Keep the parsed URL as the authority for both policy and fetch. URL()
      // canonicalizes leading ASCII whitespace/control characters that a raw
      // /^https?:/ check can miss.
      validatedRemoteUrl = validateRemoteDocumentUrl(fileUrl);
    }

    const browserRuntime = (
      globalThis as typeof globalThis & {
        browser?: { runtime?: { sendMessage?: unknown } };
      }
    ).browser?.runtime;
    const hasExtensionRuntime = (
      typeof chrome !== 'undefined'
      && typeof (chrome as { runtime?: { sendMessage?: unknown } }).runtime?.sendMessage === 'function'
    ) || typeof browserRuntime?.sendMessage === 'function';
    if (hasExtensionRuntime && validatedRemoteUrl) {
      // Extension-origin fetch and its service worker both carry host
      // permissions. Hostname validation cannot stop DNS rebinding, so remote
      // URLs stay fail-closed until a native/server fetcher can resolve and pin
      // every redirect hop while preserving Host/SNI.
      throw new ExtensionRemoteProxyUnavailableError();
    }

    // file: remains an explicitly granted local read; ordinary web Studio
    // fetches retain the browser's CORS/private-network enforcement.
    const response = await fetch(validatedRemoteUrl?.href ?? fileUrl);

    if (!response.ok) {
      await cancelResponseBody(response, `HTTP ${response.status}`);
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    const contentType = response.headers.get('content-type');
    const data = await readResponseBytesWithLimit(
      response,
      UNTRUSTED_DOCUMENT_MAX_BYTES,
      '원격 문서',
    );
    assertRemoteDocumentBytes(data, contentType);
    await loadBytes(data, fileName, null);
  } catch (error) {
    if (error instanceof DocumentOwnedElsewhereError) return;
    if (
      error instanceof RemoteDocumentUrlError
      && error.reason === 'scheme-blocked'
      && fileUrl.startsWith('file:')
    ) {
      // file:// 은 별도 안내 흐름(#1131)을 유지한다 — 공개 URL 정책과 무관.
      if (typeof chrome !== 'undefined') {
        const allowed = await isFileSchemeAccessAllowed();
        if (allowed === false) {
          showFileUrlAccessGuidance();
          return;
        }
      }
    }
    showLoadError(error);
  }
}

/**
 * 확장 프로그램의 "파일 URL에 대한 액세스 허용" 권한 상태를 조회한다 (#1131).
 *
 * 확장 페이지에서만 의미가 있다. API 부재(비-확장 환경 등) 시 판정 불가로
 * `null` 을 반환하여 호출부가 기존 동작(일반 에러)으로 폴백하도록 한다.
 *
 * @returns 허용=true, 미허용=false, 판정 불가=null
 */
async function isFileSchemeAccessAllowed(): Promise<boolean | null> {
  const ext = (typeof chrome !== 'undefined' ? chrome.extension : undefined) as
    | { isAllowedFileSchemeAccess?: () => Promise<boolean> }
    | undefined;
  if (!ext?.isAllowedFileSchemeAccess) return null;
  try {
    return await ext.isAllowedFileSchemeAccess();
  } catch {
    return null;
  }
}

/**
 * 로컬 file:// 문서를 열 때 "파일 URL 액세스 허용" 권한이 꺼져 있어 로드가
 * 실패한 경우, 일반 "Failed to fetch" 대신 원인과 해결 방법을 안내한다 (#1131).
 *
 * 설정 화면(chrome://extensions/?id=...)은 일반 링크로는 열리지 않으므로
 * 확장 컨텍스트의 chrome.tabs.create 로 연다.
 */
function showFileUrlAccessGuidance(): void {
  const errMsg = '로컬 파일을 열려면 확장 프로그램의 "파일 URL에 대한 액세스 허용"을 켜야 합니다.\n설정에서 권한을 허용한 뒤 파일을 다시 열어 주세요.';
  const sb = sbMessage();
  if (sb) sb.textContent = '파일 로드 실패: 파일 URL 액세스 권한이 필요합니다.';
  console.error('[main] file:// 로드 실패 — 파일 URL 액세스 미허용 (#1131)');
  showToast({
    message: errMsg,
    durationMs: 0, // 사용자가 읽고 직접 닫기
    confirmLabel: '확인',
    action: {
      label: '설정 열기',
      onClick: () => {
        if (typeof chrome !== 'undefined' && chrome.tabs?.create && chrome.runtime?.id) {
          chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` });
        }
      },
    },
  });
}

/**
 * 파일 로드 실패 시 사용자에게 에러를 명확히 알린다 (#265).
 *
 * 상태 표시줄은 22px 한 줄로 긴 에러 메시지가 ellipsis 로 잘리므로,
 * 우상단 토스트 (긴 메시지 줄바꿈 지원 · 사용자 닫기 · action 링크) 를
 * 병행 사용한다.
 */
function showLoadError(error: unknown): void {
  const raw = String(error).replace(/^Error:\s*/, '');
  const errMsg = `파일 로드 실패: ${raw}`;
  const sb = sbMessage();
  if (sb) sb.textContent = errMsg;
  console.error('[main] 파일 로드 실패:', error);
  showToast({
    message: errMsg,
    durationMs: 0, // 에러는 자동 페이드 없음 — 사용자가 읽고 닫기
    confirmLabel: '확인',
  });
}

const initPromise = initialize();

installEmbedRuntime({
  hostWindow: window,
  parentWindow: window.parent,
  handlers: {
    async ready() {
      await initPromise;
      return true;
    },
    async loadFile(data, fileName, skipUnsavedGuard, suppressDialogs) {
      await initPromise;
      if (!await canReplaceCurrentDocument(skipUnsavedGuard)) {
        throw new Error('문서 열기가 취소되었습니다.');
      }
      await loadBytes(data, fileName, null, undefined, { suppressDialogs });
      return { pageCount: wasm.pageCount };
    },
    async pageCount() {
      await initPromise;
      return wasm.pageCount;
    },
    async getRendererDiagnostics(pageIndex) {
      await initPromise;
      const selection = canvasView?.getRendererSessionDiagnostics() ?? null;
      return {
        schemaVersion: 1 as const,
        request: rendererRuntimeRequest,
        initialized: rendererInitialized,
        initializationError: rendererInitializationError,
        effectiveBackend: selection?.effectiveBackend ?? null,
        backendFallbackReason: selection?.fallbackReason ?? renderBackendFallbackReason,
        selection,
        page: {
          index: pageIndex,
          canvaskit: canvasView?.getCanvasKitRenderDiagnostics(pageIndex) ?? null,
        },
      };
    },
    async getPageSvg(page) {
      await initPromise;
      return wasm.renderPageSvg(page);
    },
    async exportHwp() {
      await initPromise;
      hostSave.recordExport();
      return wasm.exportHwp();
    },
    async exportHwpx() {
      await initPromise;
      hostSave.recordExport();
      return wasm.exportHwpx();
    },
    async exportHml() {
      await initPromise;
      hostSave.recordExport();
      return wasm.exportHml();
    },
    async getHmlSaveState() {
      await initPromise;
      return wasm.getHmlSaveState();
    },
    async exportHwpVerify() {
      await initPromise;
      return JSON.parse(wasm.exportHwpVerify());
    },
    async notifySaved(fileName) {
      await initPromise;
      return completeHostSave(fileName);
    },
  },
});
