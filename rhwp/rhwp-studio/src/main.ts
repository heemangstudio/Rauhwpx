import { installLicenseGate } from './ui/license-gate';
import { createPlanStore, desktopPlanApi, type PlanStore } from './ui/plan/plan-store';
import { mountAccountButton } from './ui/account/account-button';
import { listenForAccountPageEvents } from './ui/account/account-page';
import { accountStore, recordAccountActivity } from './ui/account/account-store';
import { mountHamaHomeEntry } from './ui/plan/hama-home-entry';
import { openPlanCard } from './ui/plan/upgrade-card';
import type { DesktopLicenseApi } from './ui/agent-sidebar/settings-license';
import { WasmBridge, installDeclaredFontAvailabilityProbe, type PreparedWasmDocument } from '@/core/wasm-bridge';
import { installDocumentTitle } from '@/ui/document-title';
import { worktreeIdentity } from '@/ui/worktree-chip';
import type { DocumentInfo, DocumentPosition, SelectionRect } from '@/core/types';
import { AttachableEventBus } from '@/core/event-bus';
import { createAttachableFacade } from '@/core/attachable-facade';
import { consumeExactLocalFileRead } from '@/core/local-file-grant';
import {
  EXACT_LOCAL_DOCUMENT_MAX_BYTES,
  INSERTED_IMAGE_MAX_BYTES,
  UNTRUSTED_DOCUMENT_MAX_BYTES,
  readBlobBytesWithLimit,
} from '@/core/document-input-limits';
import { prepareDocumentImage } from '@/core/document-image';
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
import { COMPACT_TOOLBAR_ATTR, CompactToolbarLayout } from '@/ui/compact-toolbar';
import { setupStatusZoomSlider } from '@/ui/status-zoom';
import { describePaperSize } from '@/ui/status-paper-size';
import { StatusCharacterCounter } from '@/ui/status-character-count';
import { MenuBar } from '@/ui/menu-bar';
import { installDesktopMenuCommands, installDesktopNativeMenu } from '@/desktop-native-menu';
import { syncSpacingPresetMenus } from '@/ui/spacing-preset-menu';
import { loadWebFonts, resolveCanvasKitFontPlan } from '@/core/font-loader';
import { withCanvasKitSurfaceBlockers } from '@/core/canvaskit-document-preflight';
import { CommandRegistry } from '@/command/registry';
import { CommandDispatcher } from '@/command/dispatcher';
import { defaultShortcuts, matchShortcut } from '@/command/shortcut-map';
import { detectPlatformKind } from '@/engine/navigation-keymap';
import { allowsDocumentShortcut, isEditorInput, ownsTextInput } from '@/command/shortcut-target';
import type { EditorContext, CommandServices, EditorEditMode } from '@/command/types';
import {
  confirmSaveBeforeReplacingDocument,
  type ConfirmSaveOptions,
  fileCommands,
  locateRecoveryOriginal,
  openRecentDocument,
  pickDocumentFile,
  runLibraryMove,
  runSaveBeforeLeaving,
  whenSavesIdle,
  isSaveInProgress,
  saveCurrentDocument,
} from '@/command/commands/file';
import { editCommands, openClassicDocumentHistory } from '@/command/commands/edit';
import { waitForDocumentIoIdle } from '@/core/document-io-idle';
import {
  applyCompactToolbar,
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
import {
  captureDroppedFileHandle,
  isSupportedDocumentFileName,
  readFileFromHandle,
  type FileSystemFileHandleLike,
} from '@/command/file-system-access';
import { fileNameForFormat, forgetConvertedHmlSaveHandle, resolveSaveTarget } from '@/command/save-target';
import { EngineTrappedError, engineTrap, onEngineTrap, reportEngineTrap } from '@/core/engine-trap';
import { ContextMenu } from '@/ui/context-menu';
import { CommandPalette } from '@/ui/command-palette';
import { showHmlImportWarning } from '@/ui/hml-import-warning';
import { showLocalFontsModalIfNeeded } from '@/ui/local-fonts-modal';
import { setToastReporter, showToast } from '@/ui/toast';
import { loadAutofixSettings, noteAutofixOutcome } from '@/ui/autofix/autofix';
import { installManualAutofix } from '@/ui/autofix/autofix-manual';
import { createAutofixButton } from '@/ui/autofix/autofix-button';
import { installRendererDiagnostics } from '@/ui/issue-report/renderer-diagnostics';
import { REPORT_ISSUE_COMMAND, startIssueReport } from '@/ui/issue-report/issue-report';
import { exportDocumentForFormat } from '@/command/save-document-format';
import type { SaveFormat } from '@/command/save-format';
import {
  documentSourceDigest,
  resolveDocumentPreflight,
  type DocumentPreflightIdentity,
  type OpenDocumentBytesEvent,
  type VerifiedDocumentGrant,
} from '@/recent/document-preflight';
import { addRecentDoc, listRecentDocs, RECENT_MENU_LIMIT, updateRecentDoc, type RecentDoc } from '@/recent/recent-store';
import { createDocumentHome, type DocumentHome, type HomeCloseResult, type HomeDragItem } from '@/home/document-home';
import { createEmptyDocumentView, type EmptyDocumentView } from '@/ui/empty-document-view';
import {
  createUnsavedDocuments,
  type UnsavedDocumentAction,
  type UnsavedDocumentReport,
  type UnsavedDocuments,
} from '@/home/unsaved-documents';
import { createIcon } from '@/ui/agent-sidebar/icons';
import { showSheet } from '@/ui/agent-sidebar/sheet';
import { loadWorktreeData } from '@/home/home-data';
import { renderFirstPage } from '@/home/thumbnail-render';
import { showDropConfirmDialog } from '@/ui/drop-confirm-dialog';
import { showConfirm } from '@/ui/confirm-dialog';
import type { LibraryDocumentTarget, LibraryMoveResult } from '@/library/move-to-document';
import { initRhwpDev } from '@/core/rhwp-dev';
import type { DocumentDirtyState } from '@/core/document-dirty-state';
import {
  getEffectiveTheme,
  getThemeMode,
  getThemeSettings,
  initThemeSync,
  setThemeAccent,
  setThemeMode,
  setThemePreset,
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
  getDesktopFontHostApi,
  getSystemFontHost,
  hasSystemFontHost,
  setHubFontHost,
  isDesktopFontIndexReady,
  isDesktopFontsSupported,
  loadDesktopFontIndex,
  prepareDesktopFontsForDocument,
  prepareLocalFontAccessMetrics,
  prepareSystemFontsForDocument,
  reloadDesktopFonts,
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
import {
  MAX_PARALLEL_CHATS,
  chatHoldsDocumentWrites,
  contextDocumentId,
  createDocumentSessionCore,
  createDocumentSessionSlotId,
  documentCreatedBy,
  documentEditingLease,
  isDocumentSessionBusy,
  type ChatSession,
  type DocumentSession,
} from './document-session.ts';
import { pickChatForDocument } from './document-switch-chat.ts';
import { getChatStatus, subscribeChatStatus } from './agent/chat-status.ts';
import { closeDocumentDropdown, toggleDocumentDropdown } from './ui/document-switcher/dropdown.ts';
import { DocumentSwitcherPopup } from './ui/document-switcher/popup.ts';
import { anotherModalOpen, type DocumentSwitcherHost } from './ui/document-switcher/view.ts';
import type { DocumentRowStatus, OpenDocumentRow, RecentDocumentRow } from './ui/document-switcher/model.ts';
import { opensInNewSession, opensNestedInNavigation, planChatCapacity, routeUnlinkedThread, sessionHoldsActiveUnlinkedChat, settledLinkLoad, type LinkLoad } from './document-session-routing.ts';
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
import {
  orderUpdateRestore,
  takeUpdateRestartRecord,
  updateRestartKind,
  writeUpdateRestartRecords,
  type UpdateRestartRecord,
} from '@/recovery/update-restart';
import type { InterruptionScope } from '@/agent/turn-interruption';
import { claimForExplorerGroup, claimForRecentDoc } from '@/project-file/claim';
import type { ProjectFileLocation } from '@/project-file/open';
import {
  ChatDocumentLinkError,
  linkError,
  type ChatDocumentDetachRequest,
  type ChatDocumentLinkCode,
  type ChatDocumentLinked,
  type ChatDocumentLinkRequest,
  type ChatDocumentLinkTarget,
} from './agent/document-link.ts';
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
  isDesktopApp,
  suppressDesktopServiceWorker,
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
  locateNativeDocumentFile,
  subscribeNativeFileMoves,
  type NativeFileMovedEvent,
  type AgentHubSessionLease,
  releaseReplacedNativeFileHandle,
  rememberNativeDocument,
  restoreNativeDocument,
  reserveDesktopDocument,
  canOpenNativeDocumentWindow,
  offersAutosaveRecovery,
  canRevealNativeDocument,
  desktopFileManagerName,
  openNativeDocumentWindow,
  revealNativeDocument,
  openNativeDocumentAtPath,
  createNamedNativeDocument,
  syncDesktopWindowBackground,
  desktopUpdatesApi,
  desktopDiagnosticsLogger,
  desktopIssueReportApi,
  desktopFileDragApi,
  type DesktopDragExport,
  type DesktopFileDragApi,
  type DesktopFileDragItem,
  nativeFileHandleId,
  restoredNativeFileHandle,
  type UpdateRestartSlice,
  type UpdateRestoreSlice,
  type DesktopUpdateState,
} from '@/desktop-integration';
import { initAgentBridge, type AgentBridge } from './agent/bridge.ts';
import { chatAttention, connectChatAttention } from './agent/chat-attention.ts';
import { loadAttentionPrefs, subscribeAttentionPrefs } from './agent/attention-prefs.ts';
import { installAttentionToasts, installWebAgentAttention } from './ui/agent-attention.ts';
import { claimDocumentWriter, syncDocumentWriter } from './agent/document-writer.ts';
import { checkTurnRestore, restoreTurn, type TurnRestoreGates } from './agent/turn-checkpoints.ts';
import {
  addStoredTasteHistoryMarker,
  detachThreadDocument,
  getThread,
  listThreadSummaries,
  renameThreadsDocument,
  tasteHistoryThreadId,
  waitForThreadsPersistence,
} from './agent/threads.ts';
import {
  ForeignDocumentPool,
  createRecentDocumentResolver,
  mergeKnownDocuments,
  type ForeignDocumentAccess,
  type KnownDocument,
  type KnownDocumentSources,
} from './agent/foreign-documents.ts';
import { initAgentSidebar, type DocumentDetachStart } from './ui/agent-sidebar/index.ts';
import { mergeReceivedDocument } from './ui/agent-sidebar/version-manager.ts';
import { afterBootScreen, markStudioReady } from './ui/boot-screen.ts';
import { isInitialSetupActive, onInitialSetupInactive, wasLicensedHere } from './ui/initial-setup/active.ts';
import { desktopGiftApi } from './ui/special-event/gift.ts';
import { startSpecialEvent } from './ui/special-event/special-event-trigger.ts';
import { startAutofixIntro } from './ui/autofix/autofix-intro.ts';
import { showEditingSettingsFallback } from './ui/agent-sidebar/settings-editing-fallback.ts';
import { AGENT_LABEL } from './ui/agent-sidebar/providers.ts';
import { initInlinePrompt } from './agent/inline-prompt.ts';
import { createDocumentRegionCapture } from './agent/document-region-capture.ts';
import { DocumentVersionController, persistActiveBranch, type VersionAgentView } from './versioning/controller.ts';
import { WorktreeOwnership } from './versioning/worktree-ownership.ts';
import type { VersionWorktree } from './versioning/types.ts';
import type { ProjectWorktreeBinding } from './agent/types.ts';
import {
  VersionGraphStore,
  documentId as versionDocumentId,
  isPortableHistoryBytes,
  isPortableHistoryFileName,
  openPortableHistoryBundle,
  versionErrorCode,
} from './versioning/index.ts';
import type { AgentEditingLease, TasteHistoryLearned } from './agent/types.ts';
import { mountUpdateHippo } from './ui/update-hippo/update-hippo.ts';
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

// 데스크톱 앱이면 렌더러 오류를 메인의 진단 기록(문제 보고에 실린다)으로도 보낸다.
installRendererDiagnostics(desktopDiagnosticsLogger());

const rendererSessionContextPromise = getRendererSessionContext();
/**
 * 끊긴 턴을 가르는 이 페이지의 정체성(S3) — 창 세션은 새로고침을 넘어 같고, 앱 실행 id 는 데스크톱만
 * 안다(웹의 launchId 는 페이지나 허브마다 바뀐다). 세션 구성이 오기 전에는 null.
 */
let interruptionScope: InterruptionScope | null = null;
/**
 * 부팅 정리(S3, reconcileInterruptedTurns)는 이 페이지에서 한 번만 돈다 — 페이지가 처음 만든, 창의 기본
 * 허브 세션을 쓰는 채팅이 맡는다. 그 채팅이 닫힌 뒤(숨은 채팅 정리·문서 닫기) 기본 허브 세션을 물려받는
 * 새 채팅은 정리하지 않는다: 그때는 같은 창의 다른 사이드바가 아직 턴을 돌리고 있어 끊긴 턴이 아니다.
 */
let bootReconcileClaimed = false;
function claimBootReconcile(hubSession: AgentHubSessionLease | null): boolean {
  if (hubSession !== null || bootReconcileClaimed) return false;
  bootReconcileClaimed = true;
  return true;
}
void rendererSessionContextPromise.then((context) => {
  if (!context) return;
  interruptionScope = {
    windowSessionId: context.sessionId,
    appLaunchId: isDesktopApp() ? context.launchId : null,
  };
}, () => {});

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
    onDirtyChanged: () => {
      desktopDocumentStateUpdate?.();
      unsavedDocuments?.invalidate();
      notifyOpenDocumentsChanged();
    },
  });
  return session;
}

let desktopDocumentStateUpdate: (() => void) | null = null;
/** 세션 콜백이 먼저 정의되므로 나중에 채운다. */
let unsavedDocuments: UnsavedDocuments | null = null;
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
const refreshDocumentTitle = installDocumentTitle(wasm, {
  switcher: {
    count: () => openDocumentRows().length,
    toggle: (anchor) => toggleDocumentDropdown(anchor, documentSwitcherHost),
  },
  rename: (name) => renameAttachedDocument(name),
  canRename: () => canRenameSessionDocument(attachedSession),
  worktree: () => worktreeIdentity(attachedSession.versions?.getState(), attachedSession.documentId),
});
const eventBus = new AttachableEventBus(firstSession.bus);
const documentStateFacade = createAttachableFacade<DocumentDirtyState>(firstSession.documentState);
const documentState = documentStateFacade.facade;
let disposeAgentSidebar = (): void => {};
const autosaveFacade = createAttachableFacade<AutosaveManager>(firstSession.autosave);
const autosaveManager = autosaveFacade.facade;
/**
 * 엔진 trap 복구는 페이지를 다시 불러와 문서를 모두 다시 연다. 문서를 호스트가 쥐는 고정 문서는
 * 다시 불러오면 호스트와의 연결을 잃으므로 예전처럼 사본만 받는다.
 */
function trapRecoveryAvailable(): boolean {
  return !isPinnedDocumentEnabled();
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
  const message = '문서 엔진이 멈췄습니다. 열린 문서를 모두 다시 열어 복구할 수 있습니다.';
  showToast({
    message,
    durationMs: 0,
    report: true,
    action: { label: '문서 복구', onClick: () => void openTrapRecoveryDialog() },
    // 다시 연 페이지에서 또 멈췄으면 다시 여는 것만으로는 풀리지 않는다 — 자동 수정을 앞에 두고, 문서 복구는
    // 자동 수정이 실패해도 쓸 수 있게 옆의 링크로 남는다.
    // 고치면 같은 복구(다시 불러오기)를 이어서 한다.
    ...(trapManifestToRecover ? {
      autofix: {
        surface: 'engine-trap',
        title: message,
        detail: engineTrap()?.message ?? '',
        attempts: trapManifestToRecover.attempt,
        onFixed: () => {
          void trapRecoveryPage.reopenWhenReady().then((problem) => {
            if (problem) showToast({ message: problem, durationMs: 0, report: true });
          });
        },
      },
    } : {}),
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
    report: true,
    action: recoverable
      ? { label: '문서 복구', onClick: () => void openTrapRecoveryDialog() }
      : { label: '사본 저장', onClick: saveTrappedDocumentCopy },
  });
  return true;
}

onEngineTrap(() => {
  // 자동 수정이 고치고 다시 연 페이지에서 또 멈췄다.
  noteAutofixOutcome('engine-trap', false);
  if (!trapRecoveryAvailable()) {
    // 멈춘 엔진이 아직 읽기는 받아 줄 때 지금 상태를 복구본으로 남긴다. 엔진 메모리는 모든 문서가
    // 함께 쓰므로 열린 문서 전부를 남긴다.
    for (const session of liveSessions) void session.autosave.flushNow('engine-trap');
    showToast({
      message: '문서 엔진이 멈춰 편집을 중단했습니다.\n사본을 저장한 뒤 앱을 다시 여세요.',
      durationMs: 0,
      report: true,
      action: { label: '사본 저장', onClick: saveTrappedDocumentCopy },
    });
    return;
  }
  // 멈춘 엔진이 아직 읽기는 받아 줄 때, 바뀐 문서마다 복구본을 하나씩 남기기 시작한다.
  trapRecoveryPage.begin();
  showTrapRecoveryToast();
});
// 한 번도 편집하지 않은 새 문서는 dirty 자동 저장본이 없다. 동기 체크포인트로 문서 ID까지
// 남겨야 새로고침 뒤 살아 있는 에이전트 턴이 같은 문서에 다시 붙을 수 있다.
const UNEDITED_DOCUMENT_RELOAD_KEY = 'rhwp-unedited-document-reload-v1';
function checkpointUneditedDocument(): void {
  try {
    const storage = sessionStorageOrNull();
    // 시작 복구가 끝나기 전에 다시 새로고침해도 아직 읽는 체크포인트를 지우지 않는다.
    if (!engineTrap() && (documentIoCount > 0 || !wasm.hasLoadedDocument())) return;
    storage?.removeItem(UNEDITED_DOCUMENT_RELOAD_KEY);
    if (engineTrap() || !attachedSession.documentId || attachedSession.worktree
      || !wasm.isNewDocument || wasm.currentFileHandle
      || documentState.isDirty()) return;
    storage?.setItem(UNEDITED_DOCUMENT_RELOAD_KEY, JSON.stringify({
      documentId: attachedSession.documentId,
      bytes: Array.from(wasm.exportHwpx()),
    }));
  } catch (error) {
    console.warn('[recovery] 새 문서 새로고침 체크포인트 저장 실패:', error);
  }
}

async function reopenUneditedDocumentAfterReload(): Promise<boolean> {
  const storage = sessionStorageOrNull();
  try {
    const saved = storage?.getItem(UNEDITED_DOCUMENT_RELOAD_KEY);
    const navigation = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
    if (!saved || navigation?.type !== 'reload' || isPinnedDocumentEnabled()) return false;
    const checkpoint = JSON.parse(saved);
    if (typeof checkpoint.documentId !== 'string' || !checkpoint.documentId
      || !Array.isArray(checkpoint.bytes) || checkpoint.bytes.length === 0) return false;
    return await createNewDocument(new Uint8Array(checkpoint.bytes), checkpoint.documentId);
  } catch (error) {
    console.warn('[recovery] 새 문서 새로고침 복구 실패:', error);
    return false;
  } finally {
    try { storage?.removeItem(UNEDITED_DOCUMENT_RELOAD_KEY); } catch { /* 저장소 접근 불가 */ }
  }
}

window.addEventListener('pagehide', (event) => {
  if (!event.persisted) {
    checkpointUneditedDocument();
    disposeAgentSidebar();
    for (const session of liveSessions) {
      void session.versions?.persistWorktree().catch(() => {});
      session.autosave.dispose();
    }
  }
});
initThemeSync((theme) => {
  eventBus.emit('theme-changed', theme);
  eventBus.emit('command-state-changed');
  syncDesktopWindowBackground(getComputedStyle(document.body).backgroundColor);
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
    showToast({ message: '사본을 만들지 못했습니다. 앱을 다시 열어 자동 저장본으로 복구하세요.', durationMs: 0, report: true });
  }
}

// E2E 테스트용 전역 노출 (개발 모드 전용)
if (import.meta.env.DEV) {
  (window as any).__wasm = wasm;
  (window as any).__eventBus = eventBus;
  (window as any).__documentState = documentState;
  (window as any).__autosaveManager = autosaveManager;
  (window as any).__theme = {
    getThemeMode,
    getEffectiveTheme,
    getThemeSettings,
    setThemeMode,
    setPreset: setThemePreset,
    setAccent: setThemeAccent,
  };
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
let renderBackendFallbackReason: RenderBackendFallbackReason | null = null;

class DocumentOwnedElsewhereError extends Error {
  constructor() {
    super('다른 창에서 이미 열려 있는 문서입니다.');
    this.name = 'DocumentOwnedElsewhereError';
  }
}

/** 제한 시간을 넘겨 늦게 도착한 웹폰트로 이미 그린 페이지를 다시 그린다. */
function repaintAfterLateWebFonts(): void {
  if (wasm.hasLoadedDocument()) eventBus.emit('document-view-changed');
}

/** 본문 문단의 글자 범위들을 줄별 rect 로 잰다. 빈 범위(지운 자리)는 그 자리의 캐럿 rect 다. */
function changeRangeRects(
  wasm: WasmBridge,
  position: DocumentPosition,
  ranges: readonly { start: number; end: number }[],
): SelectionRect[] {
  const { sectionIndex: sec, paragraphIndex: para } = position;
  return ranges.flatMap((range) => {
    try {
      if (range.end > range.start) return wasm.getSelectionRects(sec, para, range.start, para, range.end, false);
      const caret = wasm.getCursorRect(sec, para, range.start);
      return caret ? [{ pageIndex: caret.pageIndex, x: caret.x, y: caret.y, width: 0, height: caret.height }] : [];
    } catch {
      return [];
    }
  });
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
    inNote: inputHandler?.isInFootnoteMode() ?? false,
    inHeaderFooter: inputHandler?.isInHeaderFooterMode() ?? false,
    isEditable: !sessionReadOnly() && !agentEditingLease.active && (!isFormMode || canEditFormField),
    readOnly: sessionReadOnly(),
    // 라이선스 읽기 전용은 문서 보기 전용이다. 템플릿 미리보기 창은 다른 문서를 열지 않는다.
    readOnlyCanOpen: !documentReadOnly,
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
  // 문서 없는 세션(빈 종이)에는 고칠 문서가 없다 — 압축 같은 턴이 돌아도 편집 중 테두리와 알약을 띄우지 않는다.
  const shown = lease.active && wasm.hasLoadedDocument();
  document.documentElement.dataset.agentEditing = shown ? 'true' : 'false';
  const editorArea = document.getElementById('editor-area');
  const frame = document.getElementById('agent-editing-frame');
  const status = document.getElementById('agent-editing-status');
  const statusLabel = document.getElementById('agent-editing-status-label');
  if (editorArea) editorArea.dataset.editingAgent = lease.agent;
  editorArea?.setAttribute('aria-busy', shown ? 'true' : 'false');
  if (frame) frame.hidden = !shown;
  if (status) status.hidden = !shown;
  if (status) status.dataset.waiting = lease.waitingForUser ? 'true' : 'false';
  if (statusLabel) {
    statusLabel.textContent = lease.waitingForUser ? `${AGENT_LABEL[lease.agent]}가 답변을 기다리고 있어요` : '편집 중';
  }
  inputHandler?.setUserEditingLocked(agentEditingLease.active);
  toolbar?.setEnabled(wasm.pageCount > 0 && !sessionReadOnly() && !agentEditingLease.active);
  scheduleCharacterStatus();
  eventBus.emit('command-state-changed');
}

// 문서가 들어오거나 나가면 편집 중 표시를 다시 맞춘다 (빈 종이에는 띄우지 않는다).
for (const name of ['document-swapped', 'document-context-changed']) {
  eventBus.on(name, () => setAgentEditingLease(agentEditingLease));
}

let agentSidebarReady = false;

eventBus.on('settings:open', (payload) => {
  if (agentSidebarReady) return;
  const request = payload as { destination?: unknown; onOpen?: () => void } | undefined;
  const destination = request?.destination;
  if (destination !== undefined && destination !== 'editing' && destination !== 'theme') return;
  request?.onOpen?.();
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
  // 다른 이름으로 저장은 지금 문서가 있는 폴더에서 연다.
  pickSaveHandle: (options) => pickDesktopNativeSaveFile(options, undefined, wasm.currentFileHandle),
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
  discardUnsavedWork: async () => {
    // 관리되는 작업 사본은 그 자체가 저장 위치라 놓지 않는다. 원본 파일의 작업 공간만 되돌린다.
    if (isManagedWorktree()) return;
    await attachedSession.versions?.discardUnsavedWorktree();
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

/** 창을 닫기 전에 미뤄 둔 작업 공간 기록을 적는다. 다시 열면 파일 대신 이 작업 공간을 연다. */
async function flushWorktreesBeforeClose(): Promise<void> {
  await Promise.all(liveSessions.filter((session) => session.worktreeWritable)
    .map((session) => session.versions?.flushScheduledPersist().catch(() => {})));
}

installDesktopCloseHandling(async () => {
  if (!await confirmCloseWithBackgroundSessions()) return false;
  if (!await confirmSaveBackgroundDocuments()) return false;
  // 저장 안 함을 고른 문서는 닫기가 정해진 뒤 복구본을 지운다. 남겨 두면 다음 실행이 버린 변경을 복구하자고 묻는다.
  const discarded: DocumentSession[] = [];
  const allowClose = await canReplaceCurrentDocument(undefined, {
    onDiscard: () => { discarded.push(attachedSession); },
  });
  if (allowClose) {
    await Promise.all(discarded.map((session) => session.autosave.discardCurrentDraft('window-close-discard')
      .catch((error) => console.warn('[recovery] 닫을 때 버린 문서의 복구본을 지우지 못했습니다:', error))));
    await flushWorktreesBeforeClose();
    for (const session of liveSessions) session.documentState.permitNextUnload();
  }
  return allowClose;
});
// 업데이트 재시작은 창마다 문서를 넘겨받은 뒤 저장을 묻지 않고 닫는다.
desktopUpdatesApi()?.onPrepareRestart(prepareUpdateRestart);
desktopUpdatesApi()?.onCommitRestart(commitUpdateRestart);
// 메뉴의 업데이트 확인은 답을 홈의 하마가 한다. 그 메뉴를 고른 창(초점 창)만 홈을 연다.
let lastUpdateState: DesktopUpdateState | null = null;
desktopUpdatesApi()?.onState((state) => {
  const previous = lastUpdateState;
  lastUpdateState = state;
  // 수동 확인이 막 시작했을 때만 연다. 이미 받아 둔 업데이트면 확인 없이 manual 만 켜진다.
  const startedChecking = state.status === 'checking' && previous?.status !== 'checking';
  if (state.manual && (startedChecking || !previous?.manual) && document.hasFocus()) openDocumentHome();
});
void desktopUpdatesApi()?.getState().then((state) => { lastUpdateState ??= state; }).catch(() => {});

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
// 네이티브 메뉴 명령은 편집기 준비와 상관없이 받는다(문서 엔진이 뜨지 못해도 문제 보고는 열린다).
installDesktopMenuCommands(dispatcher);
/** 문제 보고를 여는 함수. 데스크톱이 아니면 null — 사이드바의 문제 보고 단추도 없다. */
let issueReporter: (() => void) | null = null;
installIssueReport();
// 제목 막대의 자동 수정 단추(데스크톱, 자동 수정을 켠 경우): 오류 알림 없이도 지금 상태를 적고 고친다.
// 편집기 준비와 상관없이 단다 — 엔진이 뜨지 못해도 쓸 수 있다.
installManualAutofix({ reportIssue: () => issueReporter?.() });

/**
 * 문제 보고(데스크톱 전용): 도움말 메뉴·명령 팔레트·Cmd/Ctrl+Shift+/·오류 토스트·허브 끊김 안내에서 연다.
 * 웹·확장에는 보낼 곳이 없으므로 명령을 두지 않는다.
 */
function installIssueReport(): void {
  const api = desktopIssueReportApi();
  if (!api) return;
  const report = (): void => {
    void startIssueReport({
      api,
      chat: () => attachedSession.sidebar?.reportSnapshot() ?? null,
      document: () => {
        if (engineTrap() || wasm.pageCount <= 0) return null;
        const format = wasm.getSourceFormat() as SaveFormat;
        return {
          name: wasm.fileName,
          format,
          pageCount: wasm.pageCount,
          export: () => exportDocumentForFormat(wasm, format),
        };
      },
      meta: () => ({
        commit: __APP_COMMIT__,
        view: documentHome?.visible ? 'home' : attachedSession.sidebar?.isFullscreen() ? 'chat' : 'editor',
        zoom: canvasView?.getViewportManager().getZoom() ?? null,
        devicePixelRatio: window.devicePixelRatio,
        theme: document.documentElement.dataset.themeEffective ?? '',
      }),
    }).catch((error) => console.warn('[issue-report] 버그 제보를 열지 못했습니다:', error));
  };
  issueReporter = report;
  registry.register({
    id: REPORT_ISSUE_COMMAND,
    label: '버그 제보',
    shortcutLabel: 'Ctrl+Shift+/',
    icon: 'icon-help',
    execute: report,
  });
  setToastReporter(report);
  // 편집기·사이드바 입력 어디서나 받는다. 한글 자판에서도 물리 / 키로 알아본다.
  document.addEventListener('keydown', (event) => {
    if (!(event.ctrlKey || event.metaKey) || !event.shiftKey || event.altKey || event.isComposing) return;
    if (event.code !== 'Slash' && event.key !== '?' && event.key !== '/') return;
    event.preventDefault();
    event.stopPropagation();
    dispatcher.dispatch(REPORT_ISSUE_COMMAND);
  }, true);
  // Windows 는 HTML 메뉴 막대가 창의 메뉴다. macOS 는 네이티브 도움말 메뉴에 있다.
  if (detectPlatformKind() !== 'mac') {
    const about = document.querySelector('#menu-bar .md-item[data-cmd="file:about"]');
    if (about && !document.querySelector(`#menu-bar .md-item[data-cmd="${REPORT_ISSUE_COMMAND}"]`)) {
      const item = document.createElement('div');
      item.className = 'md-item';
      item.dataset.cmd = REPORT_ISSUE_COMMAND;
      item.innerHTML = '<span class="md-icon"></span><span class="md-label">버그 제보…</span><span class="md-shortcut">Ctrl+Shift+/</span>';
      about.after(item);
    }
  }
}

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

/** 같은 상태를 표시할 때 텍스트 노드를 다시 만들지 않는다. */
function setStatusLabel(element: HTMLElement, text: string, title?: string): void {
  if (element.textContent !== text) element.textContent = text;
  if (title !== undefined && element.title !== title) element.title = title;
}

function updatePaperStatus(): void {
  paperStatusFrame = 0;
  const paper = sbPaper();
  try {
    if (wasm.getSectionCount() === 0) {
      setStatusLabel(paper, '—', '용지 크기');
      return;
    }
    const size = describePaperSize(wasm.getPageDef(statusSectionIndex));
    setStatusLabel(paper, size.label, size.title);
  } catch {
    setStatusLabel(paper, '—', '용지 크기');
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

/**
 * 진행 문구를 그리려고 프레임을 기다리는 최소 간격. 문서 하나를 열며 열 번 가까이 부르므로 매번 기다리면
 * 그것만으로 수백 ms 가 든다. 오래 걸린 단계 뒤에는 기다려 문구가 화면에 남게 한다.
 */
const LOAD_PROGRESS_PAINT_INTERVAL_MS = 100;
let lastLoadProgressPaintAt = -Infinity;

async function updateLoadProgress(
  percent: number,
  label: string,
  options: { paint?: boolean } = {},
): Promise<void> {
  const safePercent = Math.max(0, Math.min(100, Math.round(percent)));
  sbMessage().textContent = `파일 로딩 ${safePercent}% - ${label}`;
  if (!options.paint && performance.now() - lastLoadProgressPaintAt < LOAD_PROGRESS_PAINT_INTERVAL_MS) return;
  await waitForNextPaint();
  lastLoadProgressPaintAt = performance.now();
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
    // 글꼴 폴더를 바꾸면 main 이 새로 만든 색인을 받아 열린 문서 글꼴을 다시 잇는다.
    getDesktopFontHostApi()?.onFontsChanged?.(() => {
      void reloadDesktopFonts({ rescan: false }).catch((error) => {
        console.warn('[DesktopFonts] 글꼴 색인 갱신 실패:', error);
      });
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
  // HFT 윤곽선·전진폭의 늦은 등록도 레이아웃과 화면에 반영한다.
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
  void suppressDesktopServiceWorker();
  installDesktopWindowChrome();
  installLicenseGate();
  listenForAccountPageEvents({ plan: sharedPlanStore() });
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
    msg.textContent = 'WASM 및 웹폰트 로딩 중...';
    // 대체 CSS 별칭이 원본 설치 여부를 가리지 않도록 등록 전에 측정한다.
    installDeclaredFontAvailabilityProbe();
    // OS 폰트 감지·CSS 등록을 먼저 시작하고, 네트워크 로드와 WASM 컴파일은 겹친다.
    // 첫 문서 조판은 두 작업이 준비된 뒤에만 진행한다.
    await Promise.all([
      loadWebFonts([], undefined, { onLateLoad: repaintAfterLateWebFonts }),
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
    if (import.meta.env.DEV && import.meta.env.VITE_RHWP_DEV_FONT_PACK === '1') {
      // 가져온 개발 글꼴을 첫 문서 조판 전에 WASM 메트릭에도 등록한다.
      syncImportedFontMetrics();
    }
    // HeemangEngine 은 Canvas2D 로만 그린다. renderer URL 값은 무시한다.
    const renderBackendRequest = resolveRenderBackendRequest('');
    const canvaskitModeRequest = resolveCanvasKitRenderModeRequest(window.location.search);
    const canvaskitMode = canvaskitModeRequest.mode;
    const canvaskitSurfaceRequest = resolveCanvasKitSurfaceRequest(window.location.search);
    const renderProfile = resolveRenderProfile(window.location.search);
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
          const plan = resolveCanvasKitFontPlan(report.requiredFontFamilies);
          const blockers = plan.unavailableFonts.map(font => `fontUnavailable:${font}`);
          if (wasm.getShowControlCodes()) blockers.push('viewOption:showControlCodes');
          return withCanvasKitSurfaceBlockers(
            report,
            blockers,
          );
        },
        async prepareCanvasKitDocument(renderer, report) {
          const plan = resolveCanvasKitFontPlan(report.requiredFontFamilies);
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
        if (menuName === 'page' || menuName === 'format') syncSpacingPresetMenus(wasm);
      },
    });
    installDesktopNativeMenu({
      menuBar: document.getElementById('menu-bar')!, dispatcher, registry, eventBus,
      beforeSync: () => syncSpacingPresetMenus(wasm),
    });

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
    if (editorStyleOverflow) {
      new CompactToolbarLayout(document.getElementById('studio-header')!, editorToolbarOverflow, editorStyleOverflow);
      applyCompactToolbar(userSettings.getViewSettings().compactToolbar);
    }
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
      if (documentHome?.visible) return;
      inputHandler?.performPlainTextPaste(text);
    });
    if (trapManifestToRecover) {
      // 엔진 trap 복구로 다시 불러온 페이지다. 멈추기 전에 열려 있던 문서를 다시 연다.
      void recoverDocumentsAfterTrap(trapRecoveryRun!);
    } else {
      void (async () => {
        // 업데이트로 다시 켠 창이다. 닫히기 전의 문서와 채팅을 다시 연다.
        const restore = await desktopUpdatesApi()?.getRestore().catch(() => null) ?? null;
        if (restore) {
          await restoreWindowAfterUpdate(restore);
          return;
        }
        if (!await reopenUneditedDocumentAfterReload() && isPinnedDocumentEnabled()) {
          void loadPinnedDocument();
        }
        void offerAutosaveRecoveryAtStartup();
      })();
    }

    // E2E 테스트용 전역 노출 (개발 모드 전용)
    if (import.meta.env.DEV) {
      (window as any).__inputHandler = inputHandler;
      (window as any).__canvasView = canvasView;
      (window as any).__rendererSession = rendererSession;
      (window as any).__renderBackend = null;
      (window as any).__renderBackendRequest = renderBackendRequest;
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

    // 자동 수정이 고치고 다시 불러온 페이지라면 이번에는 떴다(초기화 실패·렌더러 비정상 종료).
    noteAutofixOutcome('init-failure', true);
    noteAutofixOutcome('renderer-crash', true);
  } catch (error) {
    msg.textContent = `초기화 실패: ${error}`;
    console.error('[main] 초기화 실패:', error);
    noteAutofixOutcome('init-failure', false);
    offerInitAutofix(msg, error instanceof Error ? error.message : String(error));
  }
}

/**
 * 엔진·렌더러가 뜨지 못했다 — 새로고침으로 풀릴 일이 드물어 자동 수정을 켠 데스크톱 앱에서는 메시지 옆에
 * 자동 수정을 바로 둔다. 고치면 페이지를 다시 불러온다.
 */
function offerInitAutofix(message: HTMLElement, detail: string): void {
  void loadAutofixSettings().then((settings) => {
    if (!settings?.enabled || !message.isConnected) return;
    const button = createAutofixButton({
      className: 'stb-autofix',
      request: () => ({ surface: 'init-failure', title: '초기화 실패', detail }),
      onFixed: () => window.location.reload(),
    });
    message.after(button.element);
  }, () => {});
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
    // 가져오기는 바이트만 읽는다. 데스크톱 열기 창이 잡아 둔 저장 대상은 바로 놓는다.
    pickExternalDocument: async () => {
      const picked = await pickDocumentFile(commandServices);
      if (!picked) return null;
      await picked.handle?.releaseUnusedSaveTarget?.().catch(() => {});
      return { bytes: picked.bytes, name: picked.name };
    },
    worktreeHost: {
      ensureOwnership: (worktree) => ensureWorktreeOwnership(session, worktree),
      canMutate: () => !documentReadOnly && !loadingWorktreeSessions.has(session)
        && (!session.worktree || session.worktreeWritable),
      // 라이선스 읽기 전용은 편집만 막는다. 파일에 저장된 내용을 기준으로 적는 일은 문서를 바꾸지 않는다.
      canRecordSaved: () => !documentReadOnly && !loadingWorktreeSessions.has(session)
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
  // 문서의 작업 공간이 바뀌면(열기·병합·이름 바꾸기) 채팅마다 같은 프로젝트에 다시 묶는다.
  session.disposers.push(session.versions.subscribe(() => syncProjectWorktrees(session)));
  // 작업 트리가 생기거나 사라지면 제목의 가지 표시를 다시 그린다.
  session.disposers.push(session.versions.subscribe(() => { if (session === attachedSession) refreshDocumentTitle(); }));
  return session.versions;
}

/** 문서 세션의 작업 공간 묶음. 버전 기록이 꺼졌거나 작업 공간을 아직 모르면 null. */
function projectWorktreeBinding(session: DocumentSession): ProjectWorktreeBinding | null {
  const state = session.versions?.getState();
  const worktree = session.worktree;
  if (!state || !session.documentId || !worktree || worktree.documentId !== session.documentId) return null;
  if (state.documentId !== session.documentId || !state.enabled) return null;
  const current = state.worktrees.find((entry) => entry.isCurrent && entry.id === worktree.id);
  if (!current) return null;
  return {
    documentId: session.documentId,
    repositoryId: worktree.repositoryId,
    current: { id: current.id, branch: current.branch, primary: current.primary },
    worktrees: state.worktrees.map(({ id, branch, primary, documentId }) => ({ id, branch, primary, documentId })),
  };
}

function syncProjectWorktrees(session: DocumentSession): void {
  const binding = projectWorktreeBinding(session);
  for (const chat of session.chats) chat.bridge.setProjectWorktrees(binding);
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
    if (!await makeRoomForChat(null, { quiet: true })) throw new Error('열린 문서나 채팅을 닫은 뒤 다시 병합하세요.');
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

/**
 * 기록에서 배운 것(Rau-0.1)의 구분선 — 보이는 채팅이 그 문서의 것이면 그 채팅에, 아니면 그 문서의 최근 채팅에
 * 남긴다. 다른 문서의 보이는 채팅에는 놓지 않는다. 그 채팅을 띄운 사이드바가 있으면 그 사이드바가 그린다.
 */
function routeTasteHistory(learned: TasteHistoryLearned): void {
  const visible = attachedSession.activeChat?.sidebar.currentThreadId() ?? null;
  const threadId = tasteHistoryThreadId(learned.documentId, visible);
  if (!threadId) return;
  const holder = allChats().find((chat) => chat.sidebar.currentThreadId() === threadId);
  if (holder) holder.sidebar.addTasteHistoryMarker(threadId, learned);
  else addStoredTasteHistoryMarker(threadId, learned);
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
    getDocumentWorktree: () => {
      const identity = worktreeIdentity(session.versions?.getState(), session.documentId);
      return identity ? { branch: identity.branch, primary: identity.primary } : null;
    },
    commitVersion: async (message, author) => {
      await versions.checkpoint(message, {
        agentTurn: true,
        agent: { label: author.agent ? AGENT_LABEL[author.agent] : '에이전트', threadId: author.threadId },
      });
    },
    documentTurnRunning: () => session.chats.some(({ bridge: other }) => chatWorksOnDocument(other)),
    // 같은 문서의 다른 채팅이 고치는 중이면 이 채팅의 쓰기는 문서에 닿지 않는다.
    claimDocumentWrite: () => chat !== undefined && claimDocumentWriter(session, chat),
    turnCheckpoints: session.turnCheckpoints,
    undoHistory: () => session.editorState.history,
    foreignDocuments: foreignDocumentsFor(session),
    // 문서 없는 채팅의 open_document·create_document — 이 채팅의 문서 세션에 열고 잇는다.
    linkDocument: (request) => (chat ? linkChatDocument(chat, request) : Promise.reject(linkError('LINK_UNAVAILABLE'))),
    // 붙은 채팅의 detach_document — 이 채팅을 빈 문서 자리로 옮긴다.
    detachDocument: (request) => (chat ? detachChatDocumentForAgent(chat, request) : Promise.reject(linkError('DETACH_UNAVAILABLE'))),
    documentCreatedBy: () => documentCreatedBy(session),
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
    routeTasteHistory,
    ...(issueReporter ? { reportIssue: issueReporter } : {}),
    editorSettingsRuntime: {
      preview: applyEditorSettingsPreview,
      committed: commitEditorSettingsRuntime,
    },
    versionController: versions,
    getAgentUndoEntry: () => (shown() ? editor.getAgentUndoEntry() : null),
    undoAgentTurn: (entry) => (shown() ? editor.undoAgentTurn(entry) : false),
    // 턴 표식의 주인(창·앱)과, 새로고침을 넘어 사는 창의 기본 허브 세션을 쓰는지(S3 부팅 정리).
    interruptionScope: () => interruptionScope,
    ownsWindowSession: claimBootReconcile(hubSession),
    turnRestore: {
      noteTurnStart: (threadId, key) => {
        session.turnCheckpoints.noteTurnStart(threadId, key);
        bridge.noteTurnKey(threadId, key);
      },
      rebindTurn: (threadId, fromKey, toKey) => {
        session.turnCheckpoints.rebindTurn(threadId, fromKey, toKey);
        bridge.noteTurnKeyRebound(threadId, fromKey, toKey);
      },
      status: (threadId, key) => session.turnCheckpoints.status(threadId, key),
      check: (threadId, key) => checkTurnRestore(session.turnCheckpoints, threadId, key, restoreGates),
      restore: (threadId, key) => {
        const result = restoreTurn(session.turnCheckpoints, threadId, key, restoreGates);
        // 이 스레드의 다음 요청에 문서를 되돌렸다는 안내를 붙인다 (에이전트가 되돌린 편집을 믿지 않게).
        // 되돌리기를 실행 취소하면 안내도 거둔다.
        if (result.ok) {
          bridge.noteDocumentRestored(threadId, () => session.turnCheckpoints.restoreStillApplies(threadId, key));
          bridge.noteTurnRestored(threadId, key);
        }
        return result;
      },
      subscribe: (listener) => session.turnCheckpoints.subscribe(listener),
    },
    navigateToChange: (position, target) => {
      if (!shown()) return;
      const inBody = position.cellIndex === undefined;
      const ranges = inBody ? target?.ranges : undefined;
      // anchor 는 문단 첫 자리의 rect 라 바뀐 글자 범위가 있으면 쓰지 않는다.
      const anchor = inBody && !ranges ? target?.anchor : undefined;
      if (anchor) position = { ...position, cursorRect: { ...anchor } };
      if (!editor.moveCursorTo(position, { center: true })) return;
      bridge.flashJumpTarget({
        opId: target?.opId,
        rects: ranges ? changeRangeRects(session.wasm, position, ranges) : anchor && [anchor],
      });
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
        documentId: contextDocumentId(session),
        documentName,
        selectionLabel,
        pageCount: doc.pageCount,
      };
    },
    moveToLibraryDocument: (target, options) => moveFromSession(session, target, options),
    // 문서 없는 채팅은 옮겨 갈 문서가 없다 — 문서 없는 세션에서 이어 간다.
    openThreadDocument: (thread) => (thread.documentId === null && thread.docKey === null
      ? openUnlinkedThread(session, thread.id)
      : moveFromSession(
        session,
        { documentId: thread.documentId, fileName: thread.docKey },
        { commit: true, threadId: thread.id },
      )),
    linkDocument: (target) => (chat ? linkChatDocumentForUser(chat, target) : Promise.resolve(null)),
    detachDocument: () => (chat ? detachChatDocument(chat) : Promise.resolve(false)),
    openChat: (request) => (chat ? openChatFromChat(chat, request) : Promise.resolve('handled' as const)),
    canRenameDocument: () => canRenameSessionDocument(session),
    toggleDocumentList: (anchor) => toggleDocumentDropdown(anchor, documentSwitcherHost),
    closeDocumentList: closeDocumentDropdown,
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
    openDocumentHome,
    listRecentDocuments: async () => (await listRecentDocs())
      .slice(0, 20)
      .map(({ documentId, fileName, sourceFormat, openedAt }) => (
        { documentId, fileName, sourceFormat, openedAt }
      )),
    listMentionDocuments: async () => mergeKnownDocuments(await listKnownDocuments()).documents
      .filter((row) => row.documentId !== session.documentId)
      .map((row) => ({ documentId: row.documentId, title: row.name, open: row.state === 'open' })),
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
  bridge.setProjectWorktrees(projectWorktreeBinding(session));
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
      reportRunningChats();
    }),
    bridge.onBusyChange((busy) => {
      notifyChatModeLock(session, created);
      reportRunningChats();
      // 보이지 않는 채팅이 일을 마치면 닫는다. 기록은 채팅 목록에 남고, 허브 세션과 공급자를 놓는다.
      if (!busy) closeIdleHiddenChats(session);
    }),
    bridge.pendingEdits.onChange((event) => {
      for (const listener of taps.pending) listener(event);
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
 * 새 채팅 하나의 자리를 낸다. 화면 밖에서 일을 마친 문서 세션이 자리를 차지하고 있으면 오래된 것부터 닫는다 — 저장하지
 * 않았거나 검토·답을 기다리는 문서는 닫지 않는다. 그래도 자리가 없으면 그 까닭을 한 줄로 알리고 false.
 * target 은 채팅을 달 세션이라 닫지 않는다.
 */
async function makeRoomForChat(
  target: DocumentSession | null = null,
  options: { quiet?: boolean } = {},
): Promise<boolean> {
  for (const session of liveSessions) closeIdleHiddenChats(session);
  const plan = chatCapacityPlan(target);
  if (plan.kind === 'room') {
    for (const { session } of plan.release) await disposeSession(session);
    if (allChats().length < MAX_PARALLEL_CHATS) return true;
  }
  if (!options.quiet) {
    showToast({
      message: plan.kind === 'room' || plan.working
        ? `에이전트는 한 창에서 ${MAX_PARALLEL_CHATS}개까지 함께 실행할 수 있습니다. 하나가 끝나면 다시 여세요.`
        : '다른 문서에 저장하거나 검토할 변경이 남아 있어 채팅을 더 열 수 없습니다.',
      durationMs: 4500,
    });
  }
  return false;
}

/**
 * 새 채팅 하나의 자리를 어떻게 낼지 본다. 아무것도 닫지 않는다 — 화면 밖의 쉬는 채팅은 닫힌 셈으로 센다.
 * 오래 안 본 문서부터 닫는다.
 */
function chatCapacityPlan(target: DocumentSession | null) {
  const byLastSeen = [...liveSessions].sort((a, b) => a.lastAttachedAt - b.lastAttachedAt);
  return planChatCapacity(byLastSeen.map((session) => ({
    session,
    chats: session.chats.slice(0, chatsKeptAfterIdleClose(session)),
    inUse: session === attachedSession || session === target,
    working: session.chats.some((chat) => chat.bridge.isTurnRunning()),
    holds: isDocumentSessionBusy(session)
      || session.documentState.isDirty()
      || documentCreatedBy(session) !== null
      || isManagedWorktree(session)
      || mutatingWorktreeSessions.has(session)
      || loadingWorktreeSessions.has(session)
      || linkingSession === session
      || sessionHoldsActiveUnlinkedChat(session)
      || session.chats.some((chat) => restartResumingChats.has(chat)),
  })), MAX_PARALLEL_CHATS);
}

/**
 * 지금 문서를 탭으로 남긴 채 새 탭을 열 수 있는가. 채팅을 따로 열 수 없는 환경(웹 배포판·확장)이거나, 다른 탭을
 * 닫아도 채팅 자리가 나지 않으면 예전처럼 지금 문서 자리에 연다.
 */
function canOpenDocumentTab(): boolean {
  if (!supportsExtraAgentHubSessions() && allChats().some((chat) => chat.hubSession === null)) return false;
  return chatCapacityPlan(null).kind === 'room';
}

/**
 * 새 채팅을 만든다. 창의 기본 허브 세션이 비어 있으면 그것을, 아니면 허브 세션을 따로 받는다.
 * 채팅 수가 상한이거나 허브 세션을 받을 수 없으면 null.
 */
async function createChatSession(
  session: DocumentSession,
  options: { active: boolean },
): Promise<ChatSession | null> {
  if (!await makeRoomForChat(session)) return null;
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

/**
 * 채팅 하나를 닫는다. 브리지와 허브 세션, 사이드바를 놓는다. keepHubSession 이면 허브의 채팅을 멈추지 않고
 * 허브 세션도 놓지 않은 채 돌려준다 — 다음 채팅이 그 세션으로 같은 허브 채팅을 잇는다(문서에서 떼기). 창의
 * 기본 허브 세션이면 null 이다.
 */
function disposeChat(chat: ChatSession, options: { keepHubSession?: boolean } = {}): AgentHubSessionLease | null {
  const session = chat.document;
  const index = session.chats.indexOf(chat);
  if (index < 0) return null;
  session.chats.splice(index, 1);
  if (session.activeChat === chat) session.activeChat = session.chats[0] ?? null;
  for (const dispose of chat.disposers.splice(0)) {
    try { dispose(); } catch (error) { console.warn('[sessions] 채팅 정리 실패:', error); }
  }
  chat.sidebar.dispose();
  chat.bridge.dispose({ keepHubChat: options.keepHubSession === true });
  // 공급자 프로세스가 끝날 때까지 기다리므로 화면을 막지 않는다.
  if (!options.keepHubSession) void chat.hubSession?.release();
  // 닫힌 채팅은 문서를 놓는다 — 다음으로 쥔 채팅이 주인이 된다.
  if (session.writer === chat) session.writer = null;
  notifyChatModeLock(session);
  reportRunningChats();
  return chat.hubSession;
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

/**
 * 보이지 않는 채팅 중 일이 없는 것을 닫는다 (문서마다 보이는 채팅 하나는 남는다). 앱 업데이트 뒤 이어서 진행을
 * 기다리는 채팅은 아직 일을 시작하지 않았어도 남긴다.
 */
function closeIdleHiddenChats(session: DocumentSession): void {
  for (const chat of [...session.chats]) {
    if (session.chats.length < 2) return;
    if (chat === session.activeChat || chat.bridge.isBusy() || restartResumingChats.has(chat)) continue;
    disposeChat(chat);
  }
}

/** closeIdleHiddenChats 뒤에 남을 채팅 수. */
function chatsKeptAfterIdleClose(session: DocumentSession): number {
  let kept = session.chats.length;
  for (const chat of session.chats) {
    if (kept < 2) break;
    if (chat === session.activeChat || chat.bridge.isBusy() || restartResumingChats.has(chat)) continue;
    kept -= 1;
  }
  return kept;
}

/**
 * 사이드바의 새 채팅·같은 문서의 다른 채팅 열기. 지금 채팅이 일하는 중이면 멈추지 않고
 * 채팅을 하나 더 열어 그쪽을 보인다. 그 채팅이 이미 다른 채팅 창에 떠 있으면 그리로 넘어간다.
 */
function openChatFromChat(
  chat: ChatSession,
  request: { kind: 'new' } | { kind: 'thread'; threadId: string },
): Promise<'handled' | 'local'> {
  if (refuseWhileNavigating()) return Promise.resolve('handled');
  return runNavigation(async () => {
    const session = chat.document;
    if (attachedSession !== session || session.activeChat !== chat) {
      console.error('[navigation] 화면에 없는 채팅 창이 채팅 열기를 요청했습니다');
      return 'handled';
    }
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
  }, { label: 'open-chat' });
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

/**
 * 열린 문서 목록·Ctrl+Tab 에서 문서를 고른다. 그 문서에 붙은 뒤 일하는 채팅, 마지막으로 본 채팅, 그 문서의
 * 최근 대화 순으로 채팅을 보인다. 집중 모드에 있었으면 다음 문서에서도 집중 모드를 잇는다.
 */
function switchToDocument(documentId: string): Promise<void> {
  const session = liveSessionForDocument(documentId);
  if (!session || refuseWhileNavigating()) return Promise.resolve();
  return runNavigation(async () => {
    const focused = attachedSession.sidebar?.isFullscreen() ?? false;
    if (session !== attachedSession) await attachSession(session);
    if (attachedSession !== session) return;
    documentHome?.hide();
    await showChatForDocument(session);
    const sidebar = session.sidebar;
    if (focused && !sidebar?.isFullscreen()) sidebar?.enterFullscreen({ instant: true });
    else if (!focused && sidebar?.isFullscreen()) sidebar.exitFullscreen();
  }, { label: 'switch-document' });
}

async function showChatForDocument(session: DocumentSession): Promise<void> {
  const decision = pickChatForDocument({
    chats: session.chats.map((chat) => ({
      running: chat.bridge.isTurnRunning(),
      threadId: chat.sidebar.currentThreadId(),
    })),
    activeIndex: session.activeChat ? session.chats.indexOf(session.activeChat) : -1,
    threads: listThreadSummaries(),
    documentId: session.documentId,
    docKey: session.wasm.hasLoadedDocument() ? session.wasm.fileName : null,
  });
  if (decision.kind === 'show') showChat(session, session.chats[decision.index]);
  else if (decision.kind === 'open-thread') await focusThreadInSession(session, decision.threadId);
}

type AttentionEvent = Parameters<Parameters<NonNullable<DocumentSession['bridge']>['onEvent']>[0]>[0];

/**
 * 알림·토스트의 '열기' — 창에 붙은 채팅 창이 레일에서 고른 것처럼 연다. 다른 채팅 창에 떠 있으면
 * 그 창을, 다른 문서의 채팅이면 그 문서를 연다. 지운 채팅이면 창만 앞으로 온다.
 */
function openThreadFromAttention(threadId: string): void {
  attachedSession.sidebar?.openThreadFromHost(threadId);
}

/**
 * 백그라운드 채팅 알림은 창에 하나다(장부 chatAttention). 사이드바마다 자기 채팅의 상태를 알리고,
 * 여기서 알림 설정을 적용하고 데스크톱(OS 알림·배지) 또는 웹(허락된 브라우저 알림)과 앱 안 토스트로 보낸다.
 */
function installWindowAgentAttention(): void {
  chatAttention.setEnabled(loadAttentionPrefs().notifications);
  subscribeAttentionPrefs((prefs) => chatAttention.setEnabled(prefs.notifications));
  connectChatAttention(chatAttention);
  if (isDesktopApp()) installDesktopAgentAttention(chatAttention, openThreadFromAttention);
  else installWebAgentAttention(chatAttention, openThreadFromAttention);
  installAttentionToasts(chatAttention, openThreadFromAttention);
}

let inlinePrompt: { dispose(): void } | null = null;
let documentRegionCapture: ReturnType<typeof createDocumentRegionCapture> | null = null;

/** 문서 위 인라인 프롬프트는 화면에 붙은 세션의 에이전트에 보낸다. */
function reinstallInlinePrompt(): void {
  inlinePrompt?.dispose();
  inlinePrompt = null;
  documentRegionCapture?.dispose();
  documentRegionCapture = null;
  const session = attachedSession;
  if (!session.bridge || !session.sidebar || !inputHandler || !canvasView) return;
  const sidebar = session.sidebar;
  const bridge = session.bridge;
  documentRegionCapture = createDocumentRegionCapture({
    wasm: session.wasm,
    canvasView,
    eventBus: session.bus,
    getIdentity: () => bridge.getDocumentSelectionIdentity(),
    getDocumentName: () => session.wasm.fileName,
    onCapture: (draft) => { void sidebar.queueCaptureDraft(draft); },
  });
  inlinePrompt = initInlinePrompt({
    wasm: session.wasm,
    eventBus: session.bus,
    inputHandler,
    canvasView,
    bridge: session.bridge,
    submit: session.sidebar.sendInlinePrompt,
    blocked: () => sidebar.planBlocksAgent(),
    startScreenshot: () => documentRegionCapture?.startCapture(),
  });
}

function liveSessionForDocument(documentId: string | null | undefined): DocumentSession | null {
  if (!documentId) return null;
  return liveSessions.find((session) => (
    session.documentId === documentId && session.wasm.hasLoadedDocument()
  )) ?? null;
}

// ─── 다른 문서 읽기 ─────────────────────────────
// 에이전트가 documentId 로 읽는 다른 문서의 엔진은 창의 모든 채팅이 함께 쓴다. 이 창에 열린 문서의
// 바이트는 이미 공유 엔진에 문제없이 올라왔으므로 미리 읽기를 건너뛴다.
const foreignDocumentPool = new ForeignDocumentPool({
  isLoadedDigest: (digest) => liveSessions.some((session) => session.wasm.documentDigest === digest),
});
const resolveRecentForeignDocument = createRecentDocumentResolver();

/** 에이전트의 문서 목록과 @ 멘션이 보는 문서 — 이 창에 열린 문서와 최근 문서 기록. */
async function listKnownDocuments(): Promise<KnownDocumentSources> {
  const rows = await listRecentDocs().catch(() => []);
  const recent = rows.map((row): KnownDocument => ({
    documentId: row.documentId, name: row.fileName, format: row.sourceFormat, openedAt: row.openedAt, state: 'closed',
  }));
  const openedAt = new Map<string, number>();
  for (const row of rows) openedAt.set(row.documentId, Math.max(openedAt.get(row.documentId) ?? 0, row.openedAt));
  const now = Date.now();
  const open = liveSessions.flatMap((session): KnownDocument[] => (
    session.documentId && session.wasm.hasLoadedDocument()
      ? [{
        documentId: session.documentId,
        name: session.wasm.fileName,
        format: session.wasm.getSourceFormat(),
        openedAt: openedAt.get(session.documentId) ?? now,
        dirty: session.documentState.isDirty(),
        state: 'open',
      }]
      : []
  ));
  return { open, recent };
}

/** 채팅 하나의 다른 문서 접근 — 이 창에 열린 문서는 그 세션의 엔진을 그대로 읽는다 (자기 문서는 뺀다). */
function foreignDocumentsFor(session: DocumentSession): ForeignDocumentAccess {
  return {
    pool: foreignDocumentPool,
    resolveLiveDocument: (documentId) => {
      if (documentId === session.documentId) return null;
      const live = liveSessionForDocument(documentId);
      if (!live) return null;
      return {
        wasm: live.wasm,
        name: live.wasm.fileName,
        dirty: live.documentState.isDirty(),
        pendingReview: live.chats.some((chat) => chat.bridge.pendingEdits.hasPending()),
      };
    },
    resolveClosedDocument: resolveRecentForeignDocument,
    listDocuments: listKnownDocuments,
    ownPendingReview: () => session.chats.some((chat) => chat.bridge.pendingEdits.hasPending()),
  };
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
/**
 * 이 문서의 이름을 바꿀 수 있는가. 파일이 없는 새 문서는 이름만, 데스크톱 파일은 디스크 이름까지
 * 바꾼다. 브라우저 파일 핸들은 이름을 바꿀 수 없어 이름 바꾸기를 내놓지 않는다.
 */
function canRenameSessionDocument(session: DocumentSession): boolean {
  if (!session.wasm.hasLoadedDocument()) return false;
  const handle = session.wasm.currentFileHandle;
  return !handle || canRenameNativeFile(handle);
}

/** 확장자는 그대로 두고 파일 이름에 쓸 수 없는 글자를 뺀다. 쓸 수 있는 이름이 없으면 null. */
function requestedFileName(current: string, requested: string): string | null {
  const extension = current.match(/\.[^./\\]+$/)?.[0] ?? '';
  // eslint-disable-next-line no-control-regex
  let base = requested.trim().replace(/[\\/:*?"<>|\u0000-\u001f]/g, '').trim();
  if (extension && base.toLowerCase().endsWith(extension.toLowerCase())) {
    base = base.slice(0, -extension.length).trim();
  }
  if (!base || base.startsWith('.')) return null;
  return `${base}${extension}`;
}

function renameFailureMessage(error: unknown): string {
  const reason = error instanceof NativeRenameRefusedError ? error.reason : null;
  if (!reason) console.warn('[rename] 파일 이름을 바꾸지 못했습니다:', error);
  const messages: Record<string, string> = {
    exists: '같은 이름의 파일이 이미 있습니다.',
    open: '같은 이름의 파일이 이미 열려 있습니다.',
    saving: '저장이 끝난 뒤 다시 바꾸세요.',
    invalid: '쓸 수 있는 이름을 입력하세요.',
    extension: '확장자는 바꿀 수 없습니다.',
    missing: '문서 파일을 찾을 수 없습니다. 지워졌거나 다른 곳으로 옮겨졌습니다.',
    unavailable: '문서가 있는 드라이브나 네트워크 폴더에 연결할 수 없습니다.',
    'in-use': '다른 프로그램이 이 문서를 쓰고 있습니다. 그 프로그램에서 닫은 뒤 다시 바꾸세요.',
    denied: '이 파일이나 폴더의 이름을 바꿀 권한이 없습니다.',
  };
  return (reason && messages[reason]) || '파일 이름을 바꾸지 못했습니다.';
}

/** 문서 파일의 이름이 바뀌었다. 채팅과 최근 문서가 새 이름을 쓰게 한다. */
async function rememberRenamedDocumentFile(session: DocumentSession, fileName: string): Promise<void> {
  const doc = session.wasm;
  const documentId = session.documentId;
  if (!documentId) return;
  renameThreadsDocument(documentId, fileName);
  const sourceDigest = doc.documentDigest;
  if (sourceDigest && doc.currentFileHandle) {
    await addRecentDoc({
      documentId,
      sourceDigest,
      fileName,
      sourceFormat: doc.getSourceFormat(),
      handle: doc.currentFileHandle,
    }).catch((error) => console.warn('[recent] 이름을 바꾼 문서를 기록하지 못했습니다:', error));
  }
}

/**
 * 탐색기에서 문서 파일의 이름이 바뀌었거나 다른 폴더로 옮겨져 데스크톱이 그 파일을 따라갔다.
 * 그 파일을 연 문서의 이름·채팅·최근 문서를 맞춘다. 저장은 이미 옮긴 파일로 간다.
 */
async function applyFollowedNativeFile(event: NativeFileMovedEvent): Promise<void> {
  for (const session of liveSessions) {
    const doc = session.wasm;
    if (nativeFileHandleId(doc.currentFileHandle) !== event.handleId) continue;
    const renamed = event.name !== event.previousName;
    // 저장이 먼저 새 이름을 받아 왔으면 이미 맞다.
    if (renamed && doc.fileName === event.previousName) doc.fileName = event.name;
    if (renamed) await rememberRenamedDocumentFile(session, event.name);
    session.bus.emit('document-context-changed');
    if (session === attachedSession) {
      missingNativeFileNotices.delete(session);
      showToast({
        message: renamed
          ? `파일 이름이 '${event.name}'(으)로 바뀌어 그 파일에 이어서 저장합니다.`
          : '문서 파일이 다른 폴더로 옮겨져 옮긴 파일에 이어서 저장합니다.',
        durationMs: 4000,
      });
    }
  }
}

/** 원래 파일을 찾을 수 없다고 이미 알린 문서. 파일을 다시 찾으면 지운다. */
const missingNativeFileNotices = new WeakSet<DocumentSession>();
let nativeFileLocatedAt = 0;

/** 창이 다시 앞으로 오면 보이는 문서의 파일이 아직 그 자리에 있는지 본다. 옮겨졌으면 따라간다. */
async function checkAttachedNativeFile(): Promise<void> {
  const session = attachedSession;
  const handle = session.wasm.currentFileHandle;
  if (!handle || !nativeFileHandleId(handle)) return;
  const now = Date.now();
  if (now - nativeFileLocatedAt < 1500) return;
  nativeFileLocatedAt = now;
  try {
    const location = await locateNativeDocumentFile(handle);
    if (location?.state !== 'missing') {
      missingNativeFileNotices.delete(session);
      return;
    }
    if (session !== attachedSession || missingNativeFileNotices.has(session)) return;
    missingNativeFileNotices.add(session);
    showToast({
      message: '원래 문서 파일을 찾을 수 없습니다. 지워졌거나 다른 드라이브로 옮겨졌습니다. 다른 이름으로 저장하세요.',
      durationMs: 6000,
    });
  } catch (error) {
    console.warn('[desktop] 문서 파일 위치를 확인하지 못했습니다:', error);
  }
}

subscribeNativeFileMoves((event) => {
  void applyFollowedNativeFile(event).catch((error) => {
    console.warn('[desktop] 옮겨진 문서 파일을 반영하지 못했습니다:', error);
  });
});
window.addEventListener('focus', () => { void checkAttachedNativeFile(); });

async function renameDocumentInSession(
  session: DocumentSession,
  requested: string,
): Promise<{ ok: true; fileName: string } | { ok: false; message: string }> {
  const doc = session.wasm;
  if (!doc.hasLoadedDocument()) return { ok: false, message: '열린 문서가 없습니다.' };
  const current = doc.fileName;
  const nextName = requestedFileName(current, requested);
  if (!nextName) return { ok: false, message: '쓸 수 있는 이름을 입력하세요.' };
  if (nextName === current) return { ok: true, fileName: current };
  const handle = doc.currentFileHandle;
  let fileName = nextName;
  try {
    if (handle && canRenameNativeFile(handle)) {
      // 진행 중인 저장이 끝난 뒤 바꾼다. 저장 도중 바꾸면 데스크톱이 거절한다.
      await whenSavesIdle().catch(() => {});
      doc.currentFileHandle = await renameNativeDocumentFile(handle, nextName);
      // 바깥에서 대소문자만 바꾼 이름처럼 디스크가 정한 이름을 쓴다.
      fileName = doc.currentFileHandle.name;
    } else if (handle) {
      return { ok: false, message: '이 문서의 파일 이름은 여기서 바꿀 수 없습니다.' };
    }
  } catch (error) {
    return { ok: false, message: renameFailureMessage(error) };
  }
  doc.fileName = fileName;
  await rememberRenamedDocumentFile(session, fileName);
  session.bus.emit('document-context-changed');
  return { ok: true, fileName };
}

/**
 * 문서 홈에서 이름을 바꾼다. 열린 문서는 제목 막대와 같은 경로를 쓰고, 닫힌 데스크톱 문서는
 * 기억한 위치의 파일을 잠깐 잡아 이름만 바꾼 뒤 놓는다.
 */
async function renameRecentDocument(row: RecentDoc, name: string): Promise<string | null> {
  const fail = (message: string) => {
    showToast({ message, durationMs: 3200 });
    return null;
  };
  const session = liveSessionForDocument(row.documentId);
  if (session) {
    const result = await renameDocumentInSession(session, name);
    if (!result.ok) return fail(result.message);
    await updateRecentDoc(row.id, { fileName: result.fileName }).catch(() => null);
    return result.fileName;
  }
  const nextName = requestedFileName(row.fileName, name);
  if (!nextName) return fail('쓸 수 있는 이름을 입력하세요.');
  if (nextName === row.fileName) return row.fileName;
  const handle = await restoreNativeDocument(row.documentId);
  if (handle === 'owned') return fail('다른 창에서 열려 있는 문서입니다.');
  if (!handle || !canRenameNativeFile(handle)) {
    await handle?.releaseUnusedSaveTarget?.().catch(() => {});
    return fail('파일을 찾을 수 없어 이름을 바꾸지 못했습니다.');
  }
  try {
    const renamed = await renameNativeDocumentFile(handle, nextName);
    await updateRecentDoc(row.id, { fileName: renamed.name }).catch(() => null);
    renameThreadsDocument(row.documentId, renamed.name);
    return renamed.name;
  } catch (error) {
    return fail(renameFailureMessage(error));
  } finally {
    await handle.releaseUnusedSaveTarget?.().catch(() => {});
  }
}

let documentHome: DocumentHome | null = null;

/** 새 문서를 처음 본 시각. 홈의 저장하지 않은 문서는 새것부터 놓인다. */
const newDocumentSeenAt = new Map<string, number>();

/** 이 창에 열린, 아직 경로가 없는 새 문서. 작업 트리 문서는 작업 트리에 저장되어 있다. */
function localUnsavedDocuments(): UnsavedDocumentReport[] {
  return liveSessions
    .filter((session) => session.documentId && !session.worktree
      && session.wasm.hasLoadedDocument() && session.wasm.isNewDocument)
    .map((session) => {
      const documentId = session.documentId!;
      let createdAt = newDocumentSeenAt.get(documentId);
      if (createdAt === undefined) {
        createdAt = Date.now();
        newDocumentSeenAt.set(documentId, createdAt);
      }
      return { documentId, fileName: session.wasm.fileName, edited: session.documentState.isDirty(), createdAt };
    });
}

/** 홈의 저장하지 않은 문서 카드: 그 문서로 가거나, 그 문서를 붙인 채 저장 창을 띄운다. */
async function runUnsavedDocumentAction(documentId: string, action: UnsavedDocumentAction): Promise<void> {
  const session = liveSessionForDocument(documentId);
  if (!session) return;
  if (session !== attachedSession) await runNavigation(() => attachSession(session));
  if (action === 'open') {
    documentHome?.hide();
    showOpenedDocumentInSidebar();
    return;
  }
  await saveCurrentDocument(commandServices);
}

const unsavedDocumentStore = createUnsavedDocuments({
  local: localUnsavedDocuments,
  run: runUnsavedDocumentAction,
});
unsavedDocuments = unsavedDocumentStore;
for (const name of ['document-context-changed', 'document-saved']) {
  eventBus.on(name, () => unsavedDocumentStore.invalidate());
}

/**
 * 이 창에 열린 문서를 파일로 끌 때 넘길 내용. 저장된 파일과 같으면 clean 이라 그 파일이 간다.
 * 바뀐 문서·새 문서는 저장할 때의 형식으로 내보낸다. HML 은 저장 때 형식을 다시 묻는 문서라 HWPX 로 낸다.
 */
function exportLiveDocumentForDrag(documentId: string): DesktopDragExport {
  const session = liveSessionForDocument(documentId);
  if (!session || engineTrap()) return null;
  if (!session.wasm.isNewDocument && !session.documentState.isDirty()) return 'clean';
  const target = resolveSaveTarget(session.wasm.getSourceFormat(), session.wasm.fileName, session.wasm.currentFileHandle);
  const format = target.format === 'hml' ? 'hwpx' : target.format;
  if (session === attachedSession) commandServices.getInputHandler()?.flushDeferredPaginationIfNeeded('drag-out');
  const bytes = exportDocumentForFormat(session.wasm, format);
  return { fileName: fileNameForFormat(session.wasm.fileName, format), bytes };
}

/** 문서 홈에서 끌 카드들을 파일로 준비한다. 이 창에 열린 문서는 여기서 내보내고, 나머지는 데스크톱이 찾는다. */
async function prepareHomeFileDrag(api: DesktopFileDragApi, items: readonly HomeDragItem[]) {
  const failed: string[] = [];
  const wire: DesktopFileDragItem[] = [];
  const live = items.filter((item) => (item.kind === 'recent' || item.local) && liveSessionForDocument(item.documentId));
  // 내보내기는 엔진을 붙잡는다. 준비 중 표시가 먼저 그려지게 한 틀 넘긴다.
  if (live.length) await new Promise((resolve) => requestAnimationFrame(resolve));
  for (const item of items) {
    if (!live.includes(item)) {
      wire.push({ kind: item.kind, documentId: item.documentId, fileName: item.fileName });
      continue;
    }
    try {
      const exported = exportLiveDocumentForDrag(item.documentId);
      if (exported === 'clean') wire.push({ kind: 'recent', documentId: item.documentId, fileName: item.fileName });
      else if (exported) wire.push({ kind: 'bytes', fileName: exported.fileName, bytes: exported.bytes });
      else failed.push(item.fileName);
    } catch (error) {
      console.warn('[drag-out] export failed:', error);
      failed.push(item.fileName);
    }
  }
  if (!wire.length) return { token: null, failed };
  const prepared = await api.prepareFileDrag(wire);
  return { token: prepared.token, failed: [...failed, ...prepared.failed] };
}

/** 템플릿은 허브에 있다. 지금 보이는 채팅의 브리지로 묻는다. */
function templateBridge() {
  return attachedSession.activeChat?.bridge ?? null;
}

/** 문서 홈의 Hama 입구·계정 단추·계정 페이지가 함께 쓰는 요금제 상태. 데스크톱 요금제 API 가 없으면 null. */
let windowPlanStore: PlanStore | null | undefined;
function sharedPlanStore(): PlanStore | null {
  if (windowPlanStore === undefined) {
    const plan = desktopPlanApi();
    windowPlanStore = plan ? createPlanStore(plan) : null;
  }
  return windowPlanStore;
}

/** 문서 홈의 Hama 입구(Pro·기존 라이선스). 데스크톱 요금제 API 가 없으면 두지 않는다. */
function mountHomeHamaEntry(slot: HTMLElement): void {
  const store = sharedPlanStore();
  if (!store) return;
  const license = (globalThis as { rhwpDesktop?: { license?: DesktopLicenseApi } }).rhwpDesktop?.license ?? null;
  mountHamaHomeEntry(slot, { store, open: () => { openPlanCard({ store, license, focus: 'hama' }); } });
}

function installDocumentHome(): void {
  const fileManager = desktopFileManagerName();
  const fileDrag = desktopFileDragApi();
  // 다른 창의 홈이 이 창에 열린 문서를 끌면 바뀐 내용을 내보내 준다.
  fileDrag?.onDragExportRequest((documentId) => exportLiveDocumentForDrag(documentId));
  documentHome = createDocumentHome({
    listRecent: () => listRecentDocs(),
    loadWorktrees: () => loadWorktreeData(worktreeStore),
    listTemplates: async () => {
      const bridge = templateBridge();
      if (!bridge) return null;
      try {
        return (await bridge.listTemplates()).templates;
      } catch {
        return null;
      }
    },
    templateBytes: (template) => {
      const bridge = templateBridge();
      if (!bridge) return Promise.reject(new Error('에이전트 허브에 연결되어 있지 않습니다.'));
      return bridge.fetchTemplateContent(template);
    },
    addTemplate: async (file) => {
      const bridge = templateBridge();
      if (!bridge) throw new Error('에이전트 허브에 연결되어 있지 않습니다.');
      await bridge.addTemplate(file);
    },
    liveDocumentIds: () => new Set(liveSessions
      .filter((session) => session.documentId && session.wasm.hasLoadedDocument())
      .map((session) => session.documentId!)),
    liveThumbnail: (documentId) => {
      const session = liveSessionForDocument(documentId);
      if (!session) return null;
      return renderFirstPage(session.wasm).catch(() => null);
    },
    mountTopbarTrailing: (slot) => {
      mountHomeHamaEntry(slot);
      mountAccountButton(slot, { store: accountStore(), plan: sharedPlanStore() });
    },
    mountCorner: (slot) => mountUpdateHippo(slot),
    unsaved: {
      list: () => unsavedDocumentStore.list(),
      subscribe: (listener) => unsavedDocumentStore.subscribe(listener),
      open: (document) => { void unsavedDocumentStore.run(document, 'open'); },
      save: (document) => { void unsavedDocumentStore.run(document, 'save'); },
    },
    createBlank: () => {
      dispatcher.dispatch('file:new-doc');
    },
    createFromTemplate: async (template) => {
      eventBus.emit('document-open-intent');
      const bridge = templateBridge();
      if (!bridge) throw new Error('에이전트 허브에 연결되어 있지 않습니다.');
      eventBus.emit('create-new-document', { template: await bridge.fetchTemplateContent(template) });
    },
    openFile: () => { dispatcher.dispatch('file:open'); },
    openDocument: async (row) => {
      eventBus.emit('document-open-intent');
      const live = liveSessionForDocument(row.documentId);
      if (live) {
        await runNavigation(async () => {
          await attachSession(live);
          if (attachedSession === live) await showChatForDocument(live);
        }, { label: 'home-open' });
        documentHome?.hide();
        showOpenedDocumentInSidebar();
        return 'opened';
      }
      return openRecentDocument(commandServices, row);
    },
    openWorktree: (tree) => runNavigation(async () => {
      const worktree = await worktreeStore.getWorktree(tree.id);
      if (!worktree) throw new Error('워크트리가 삭제되었습니다.');
      eventBus.emit('document-open-intent');
      await openWorktreeSession(worktree);
      documentHome?.hide();
      showOpenedDocumentInSidebar();
    }),
    // 열린 문서는 그 세션의 규칙을, 닫힌 문서는 데스크톱에서만 디스크 이름을 바꾼다.
    canRename: (row) => {
      const live = liveSessionForDocument(row.documentId);
      return live ? canRenameSessionDocument(live) : isDesktopApp();
    },
    renameDocument: renameRecentDocument,
    closeDocument: (row) => closeLiveDocument(row.documentId),
    openInNewWindow: canOpenNativeDocumentWindow()
      ? (row) => openNativeDocumentWindow(row.documentId)
      : undefined,
    reveal: canRevealNativeDocument()
      ? { label: `${fileManager}에서 보기`, run: (row) => revealNativeDocument(row.documentId) }
      : undefined,
    // 에이전트 전체 화면에서 열었으면 그 채팅으로, 아니면 열린 문서로 돌아간다.
    returnTarget: () => {
      // 집중 화면 설정에서 홈으로 왔으면 설정으로 돌아간다.
      if (document.querySelector('#agent-sidebar.ag-fullscreen.ag-settings-open')) {
        return { kind: 'settings', label: '설정' };
      }
      if (document.body.classList.contains('ag-fullscreen-open')) {
        const title = document.querySelector('#agent-sidebar .ag-workspace-chat-title')?.textContent?.trim();
        return { kind: 'chat', label: title || '채팅' };
      }
      return wasm.hasLoadedDocument() ? { kind: 'document', label: wasm.fileName } : null;
    },
    whenIdle: () => whenDocumentIoIdle(),
    restoreFocus: () => {
      if (document.body.classList.contains('ag-fullscreen-open')) {
        document.querySelector<HTMLElement>('#agent-sidebar .ag-input')?.focus();
      } else if (inputHandler?.isActive()) {
        inputHandler.focus();
      }
    },
    onDrop: (event) => { void handleDocumentDrop(event, { fromHome: true }); },
    dragOut: fileDrag
      ? {
        prepare: (items) => prepareHomeFileDrag(fileDrag, items),
        start: (token, icon) => fileDrag.startFileDrag(token, icon),
        end: (token, dropped) => fileDrag.endFileDrag(token, dropped),
      }
      : undefined,
    // 문서 없이도 집중 화면 설정으로 가고, 설정을 닫으면 홈으로 돌아온다.
    // 홈은 설정 화면이 자리 잡은 뒤에 내린다. 먼저 내리면 교차 페이드가 문서 화면에서 시작해 한 번 비친다.
    openSettings: () => {
      eventBus.emit('settings:open', {
        fullscreen: true,
        from: 'home',
        onOpen: () => documentHome?.hide(),
      });
    },
    newChat: () => { void startNoDocumentChat(); },
    toast: (message) => showToast({ message, durationMs: 3200 }),
  });
  // 앱을 켤 때는 카드에 초점 고리를 띄우지 않는다. 키보드는 홈 안에 둔다.
  documentHome.show({ focus: false });
}

/**
 * 홈의 새 채팅 — 문서 없는 새 채팅을 집중 화면에 열고 홈을 내린다. 지금 문서가 있으면 문서 없는 새
 * 세션으로 옮긴다(다른 문서의 채팅으로 갈 때처럼 지금 문서는 저장하고, 에이전트가 일하지 않으면 닫는다).
 * 지금 채팅이 일하는 중이면 멈추지 않고 채팅을 하나 더 연다.
 */
async function startNoDocumentChat(): Promise<void> {
  if (refuseWhileNavigating()) return;
  if (attachedSession.wasm.hasLoadedDocument()) {
    const moved = await runNavigation(async () => {
      const fresh = await createLiveSession();
      if (!fresh) return false;
      await switchToLiveSession(fresh);
      return true;
    });
    if (!moved) return;
  }
  const chat = attachedSession.activeChat;
  if (!chat) return;
  if (await openChatFromChat(chat, { kind: 'new' }) === 'local') chat.sidebar.startDraftChat();
  const shown = attachedSession.activeChat ?? chat;
  // 홈은 집중 화면이 선 뒤에 내린다 — 먼저 내리면 문서 화면이 한 번 비친다.
  shown.sidebar.enterFullscreen({ instant: true, then: () => documentHome?.hide() });
}

/**
 * 문서가 없을 때 용지 자리의 새 문서·파일 열기. 보이는 채팅에 문서가 없으면 그 채팅에 잇고, 아니면 파일
 * 메뉴의 새 문서·열기와 같다.
 */
let emptyDocumentView: EmptyDocumentView | null = null;

function installEmptyDocumentView(): void {
  const container = document.getElementById('scroll-container');
  if (!container) return;
  const run = (kind: 'new' | 'pick'): void => {
    if (attachedSession.activeChat?.sidebar.isUnlinkedChat()) {
      void linkVisibleChatDocument({ kind });
      return;
    }
    dispatcher.dispatch(kind === 'new' ? 'file:new-doc' : 'file:open');
  };
  const view = createEmptyDocumentView({ create: () => run('new'), open: () => run('pick') });
  emptyDocumentView = view;
  container.append(view.element);
  const sync = (): void => view.setVisible(!wasm.hasLoadedDocument());
  for (const name of ['document-context-changed', 'document-swapped', 'command-state-changed']) eventBus.on(name, sync);
  sync();
}

/** macOS 셸의 신호등 옆 문서 홈 단추. 어느 화면에서든 같은 자리에 떠 있다. */
function installAppHomeButton(): void {
  const home = document.createElement('button');
  home.type = 'button';
  home.className = 'app-home-button';
  home.setAttribute('aria-label', '문서 홈');
  home.title = '문서 홈';
  home.setAttribute('aria-pressed', 'false');
  home.append(createIcon('home'));
  home.addEventListener('click', () => openDocumentHome());
  document.body.append(home);
  // 홈이 떠 있는 동안은 눌린 모양으로 둔다.
  const homeElement = documentHome?.element;
  if (homeElement) {
    const sync = () => {
      home.setAttribute('aria-pressed', homeElement.hidden ? 'false' : 'true');
      // Electron 은 창 끌기 영역을 문서 순서로 덮는다. 홈이 몸통 끝으로 옮겨 가면 단추를 그 뒤에 둔다.
      if (home.nextElementSibling) document.body.append(home);
    };
    new MutationObserver(sync).observe(homeElement, { attributes: true, attributeFilter: ['hidden'] });
    sync();
  }
}

/** 문서 홈을 창 전체에 연다. 편집기·사이드바(에이전트 전체 화면 포함)는 닫힐 때 그대로 돌아온다. */
function openDocumentHome(options: { instant?: boolean } = {}): void {
  documentHome?.show({ instant: options.instant === true });
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
  await waitForDocumentIoIdle({
    whenSavesIdle,
    isSaving: isSaveInProgress,
    pendingLoads: () => documentIoCount,
    whenLoadsIdle: () => documentIoIdle,
  });
}

let navigationChain: Promise<unknown> = Promise.resolve();
/** 줄에 선 이동 수 (기다리는 것 포함). 0 이 아니면 사이드바의 새 이동을 받지 않는다. */
let navigationQueued = 0;
/** 지금 실행 중인 이동. 그 안에서 내보낸 열기는 같은 일의 일부다. */
let navigationRunning = 0;

/** 이 시간이 지나도 끝나지 않은 이동은 문제 보고의 진단 기록에 남긴다. 그동안 사이드바의 이동은 모두 막힌다. */
const NAVIGATION_STALL_MS = 15_000;
let navigationRefusedNoticeUntil = 0;

function isNavigating(): boolean {
  return navigationQueued > 0;
}

/**
 * 이동이 진행 중이면 사이드바의 새 이동을 받지 않는다. 누른 것이 아무 일도 하지 않은 것처럼 보이지 않게 한 줄로
 * 알린다. 받지 않았으면 true.
 */
function refuseWhileNavigating(): boolean {
  if (!isNavigating()) return false;
  if (Date.now() >= navigationRefusedNoticeUntil) {
    navigationRefusedNoticeUntil = Date.now() + 3000;
    showToast({ message: '다른 문서를 여는 중입니다. 열린 뒤 다시 고르세요.', durationMs: 3000 });
  }
  return true;
}

/**
 * 문서를 열거나 다른 문서 세션으로 넘어가는 일은 한 번에 하나씩 한다. nested 는 이미 진행 중인
 * 이동이 스스로 내보낸 열기라 줄을 서지 않는다 (줄을 서면 자기 자신을 기다린다). label 은 오래 걸린
 * 이동을 진단 기록에 남길 때 쓴다.
 */
function runNavigation<T>(run: () => Promise<T>, options: { nested?: boolean; label?: string } = {}): Promise<T> {
  if (options.nested) return run();
  navigationQueued += 1;
  const label = options.label ?? 'navigation';
  const next = navigationChain.then(async () => {
    navigationRunning += 1;
    let stage = '입출력 대기';
    const stall = window.setTimeout(() => {
      console.error(`[navigation] ${label} 이동이 ${NAVIGATION_STALL_MS / 1000}초 넘게 끝나지 않았습니다 (${stage}, 문서 입출력 ${documentIoCount}건)`);
    }, NAVIGATION_STALL_MS);
    try {
      await whenDocumentIoIdle();
      stage = '실행';
      return await run();
    } finally {
      window.clearTimeout(stall);
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
  documentRegionCapture?.dispose();
  documentRegionCapture = null;

  // 2. 페이지 퍼사드를 다음 세션으로 돌린다.
  previous.lastAttachedAt = Date.now();
  attachedSession = next;
  next.lastAttachedAt = Date.now();
  wasmFacade.retarget(next.wasm);
  refreshDocumentTitle();
  eventBus.retarget(next.bus);
  documentStateFacade.retarget(next.documentState);
  autosaveFacade.retarget(next.autosave);

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
      documentHome?.hide();
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
  notifyOpenDocumentsChanged();
}

/** 새 문서 세션을 만든다. 첫 채팅은 비어 있는 허브 세션으로 붙는다. */
async function createLiveSession(): Promise<DocumentSession | null> {
  if (!await makeRoomForChat()) return null;
  const session = await createEmptySession();
  if (!session) return null;
  const chat = await createChatSession(session, { active: true });
  if (!chat) {
    await disposeSession(session);
    return null;
  }
  return session;
}

/** 채팅 없는 새 문서 세션 — 문서도 없다. 채팅은 부른 쪽이 단다. */
async function createEmptySession(): Promise<DocumentSession | null> {
  const session = createSessionCore(createDocumentSessionSlotId());
  liveSessions.push(session);
  unsavedDocuments?.invalidate();
  try {
    // 엔진은 세션마다 붙인다. 붙이지 않은 세션에 새 문서나 파일을 열면 엔진이 없어 실패한다.
    await session.wasm.initialize();
    installDocumentVersions(session);
  } catch (error) {
    console.error('[sessions] 새 문서 세션을 준비하지 못했습니다:', error);
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
  unsavedDocuments?.invalidate();
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
  notifyOpenDocumentsChanged();
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
 * 문서 홈의 닫기. 바뀐 내용은 저장하고 커밋한 뒤 세션을 닫는다. 지금 문서를 닫으면 문서 없는 화면으로 간다.
 * 채팅이 진행 중이면 먼저 묻고, 닫기로 하면 그 채팅을 멈추고 검토 전 변경을 버린 뒤 닫는다.
 * 검토할 변경만 남은 문서는 닫지 않는다.
 */
async function closeLiveDocument(documentId: string): Promise<HomeCloseResult> {
  if (isNavigating() || refuseDocumentOpenWhileTrapped()) return 'cancelled';
  const running = liveSessionForDocument(documentId)?.chats.filter((chat) => chat.bridge.isBusy()).length ?? 0;
  if (running > 0 && !await showSheet({
    title: '정말로 닫을까요?',
    message: `${running}개의 채팅이 진행 중이에요`,
    confirmLabel: '닫기',
    cancelLabel: '돌아가기',
    destructive: true,
    focusCancel: true,
    center: true,
  })) return 'cancelled';
  return runNavigation(async () => {
    const session = liveSessionForDocument(documentId);
    if (!session) return 'closed';
    if (running > 0 && !await stopSessionChats(session)) return 'failed';
    if (isDocumentSessionBusy(session) || mutatingWorktreeSessions.has(session)
      || documentAgentView(session).pendingEdits.hasPending()) return 'busy';
    try {
      if (isManagedWorktree(session)) {
        await closeWorktreeSession(session.worktree!);
        return 'closed';
      }
      const previous = attachedSession;
      if (session.wasm.hasLoadedDocument()) {
        if (previous !== session) await attachSession(session);
        const versions = session.versions;
        const left = await runSaveBeforeLeaving(
          commandServices,
          () => session.documentId,
          versions ? () => commitBeforeLibraryMove(versions) : undefined,
        );
        if (left !== 'ok') {
          if (previous !== session && liveSessions.includes(previous)) await attachSession(previous);
          return left;
        }
      }
      // 지금 문서를 닫으면 옆 탭으로 간다. 열린 문서가 더 없으면 문서 없는 화면으로 간다.
      const neighbor = previous === session ? neighborDocumentSession(session) : null;
      const next = previous !== session && liveSessions.includes(previous)
        ? previous
        : neighbor
          ?? liveSessions.find((candidate) => candidate !== session && !candidate.wasm.hasLoadedDocument())
          ?? await createLiveSession()
          ?? liveSessions.find((candidate) => candidate !== session);
      if (!next) return 'failed';
      await attachSession(next);
      await disposeSession(session);
      if (next === neighbor && attachedSession === next) await showChatForDocument(next);
      return 'closed';
    } catch (error) {
      console.error('[sessions] 문서를 닫지 못했습니다:', error);
      return 'failed';
    }
  });
}

// ─── 열린 문서 목록 (제목 막대 목록·Ctrl+Tab) ─────────────────────────────

const openDocumentListeners = new Set<() => void>();
let openDocumentsNotifyQueued = false;

/** 열린 문서·저장 상태·채팅 상태가 바뀌었다. 한 프레임에 한 번만 다시 그린다. */
function notifyOpenDocumentsChanged(): void {
  if (openDocumentsNotifyQueued) return;
  openDocumentsNotifyQueued = true;
  queueMicrotask(() => {
    openDocumentsNotifyQueued = false;
    refreshDocumentTitle();
    for (const listener of openDocumentListeners) listener();
  });
}
subscribeChatStatus(notifyOpenDocumentsChanged);

function documentRowStatus(session: DocumentSession): DocumentRowStatus {
  if (session.chats.some((chat) => chat.bridge.isTurnRunning())) return 'working';
  const waiting = session.chats.some((chat) => {
    if (chat.bridge.pendingEdits.hasPending()) return true;
    const threadId = chat.sidebar.currentThreadId();
    const status = threadId ? getChatStatus(threadId) : null;
    return status === 'needs-input' || status === 'needs-review';
  });
  return waiting ? 'attention' : null;
}

/** 이 창에 열린 문서, 연 순서. */
function openDocumentRows(): OpenDocumentRow[] {
  return liveSessions.flatMap((session): OpenDocumentRow[] => (
    session.documentId && session.wasm.hasLoadedDocument()
      ? [{
        kind: 'open',
        documentId: session.documentId,
        name: session.wasm.fileName,
        dirty: session.documentState.isDirty(),
        status: documentRowStatus(session),
        current: session === attachedSession,
      }]
      : []
  ));
}

const recentDocsForSwitcher = new Map<string, RecentDoc>();

const documentSwitcherHost: DocumentSwitcherHost = {
  openRows: openDocumentRows,
  recentRows: async () => {
    const rows = await listRecentDocs().catch(() => []);
    recentDocsForSwitcher.clear();
    const recent: RecentDocumentRow[] = [];
    for (const row of rows) {
      if (recentDocsForSwitcher.has(row.documentId)) continue;
      recentDocsForSwitcher.set(row.documentId, row);
      recent.push({
        kind: 'recent', documentId: row.documentId, name: row.fileName, format: row.sourceFormat, openedAt: row.openedAt,
      });
    }
    return recent;
  },
  switchTo: (documentId) => {
    // 지금 문서를 고르면 채팅은 그대로 두고 문서 홈만 걷는다.
    if (attachedSession.documentId === documentId) documentHome?.hide();
    else void switchToDocument(documentId);
  },
  openRecent: (row) => {
    const entry = recentDocsForSwitcher.get(row.documentId);
    if (!entry) return;
    eventBus.emit('document-open-intent');
    void openRecentDocument(commandServices, entry).then((result) => {
      if (result !== 'opened') return;
      documentHome?.hide();
      showOpenedDocumentInSidebar();
    }).catch((error) => console.error('[documents] 최근 문서를 열지 못했습니다:', error));
  },
  close: (documentId) => { void closeOpenDocument(documentId); },
  runAction: (action) => {
    if (action === 'home') {
      openDocumentHome();
      return;
    }
    dispatcher.dispatch(action === 'new' ? 'file:new-doc' : 'file:open');
  },
  subscribe: (listener) => {
    openDocumentListeners.add(listener);
    return () => openDocumentListeners.delete(listener);
  },
};

/** 목록의 닫기. 마지막 문서를 닫으면 문서 홈으로 간다. */
async function closeOpenDocument(documentId: string): Promise<void> {
  // 일하는 채팅이 있으면 닫기 전에 묻는다. 목록이 그 물음을 가리지 않게 먼저 접는다.
  if (liveSessionForDocument(documentId)?.chats.some((chat) => chat.bridge.isBusy())) closeDocumentSwitchers();
  const result = await closeLiveDocument(documentId);
  if (result === 'busy') showToast({ message: '검토할 변경이 남아 있어 닫지 않았습니다.', durationMs: 3200 });
  if (result === 'closed' && openDocumentRows().length === 0) {
    closeDocumentSwitchers();
    openDocumentHome();
  }
}

function closeDocumentSwitchers(): void {
  closeDocumentDropdown();
  documentSwitcherPopup?.close();
}

let documentSwitcherPopup: DocumentSwitcherPopup | null = null;

/**
 * Ctrl+Tab / Ctrl+Shift+Tab — 문서 전환 창. 표 셀 안에서는 한컴처럼 탭 문자를 넣으므로 편집기에 둔다.
 * 브라우저는 이 키를 탭 전환에 쓰므로 데스크톱 앱에서만 닿는다.
 */
window.addEventListener('keydown', (event) => {
  if (event.key !== 'Tab' || !event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return;
  if (documentSwitcherPopup?.isOpen()) return;
  if (inputHandler?.ownsCtrlTab(event.target)) return;
  if (anotherModalOpen(null) || commandPalette?.isOpen()) return;
  if (openDocumentRows().length === 0) return;
  event.preventDefault();
  event.stopPropagation();
  closeDocumentDropdown();
  documentSwitcherPopup ??= new DocumentSwitcherPopup(documentSwitcherHost);
  documentSwitcherPopup.step(event.shiftKey ? -1 : 1);
}, true);

/** 열린 문서 목록에서 그 문서 다음(없으면 앞) 탭의 세션. */
function neighborDocumentSession(session: DocumentSession): DocumentSession | null {
  const tabs = liveSessions.filter((candidate) => candidate === session || candidate.wasm.hasLoadedDocument());
  const index = tabs.indexOf(session);
  return tabs[index + 1] ?? tabs[index - 1] ?? null;
}

/** 문서의 채팅을 모두 멈추고 검토 전 변경을 버린다. 정해진 시간 안에 멈추지 않으면 false. */
async function stopSessionChats(session: DocumentSession): Promise<boolean> {
  for (const chat of session.chats) if (chat.bridge.isBusy()) chat.bridge.interrupt();
  const deadline = Date.now() + 5000;
  while (isDocumentSessionBusy(session)) {
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => window.setTimeout(resolve, 100));
  }
  for (const chat of session.chats) chat.bridge.pendingEdits.rejectAll();
  return true;
}

/** 이미 열려 있는 세션으로 넘어간다. 지금 문서는 탭으로 남는다. */
async function switchToLiveSession(live: DocumentSession): Promise<'ok' | 'cancelled' | 'failed'> {
  if (attachedSession === live) return 'ok';
  await attachSession(live);
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
  if (refuseWhileNavigating()) return Promise.resolve('cancelled');
  // 멈춘 엔진에서는 저장 확인과 다른 문서 열기가 지금 문서를 잃게 한다.
  if (refuseDocumentOpenWhileTrapped()) return Promise.resolve('cancelled');
  return runNavigation(() => moveFromSessionNow(session, target, options), { label: 'move-to-document' });
}

async function moveFromSessionNow(
  session: DocumentSession,
  target: LibraryDocumentTarget,
  options: { commit?: boolean; threadId?: string },
): Promise<LibraryMoveResult> {
  if (session !== attachedSession) {
    console.error('[navigation] 화면에 없는 문서의 채팅 창이 문서 이동을 요청했습니다');
    return 'cancelled';
  }
  const versions = session.versions;
  const commitCurrent = options.commit && versions
    ? () => commitBeforeLibraryMove(versions)
    : undefined;
  const live = liveSessionForDocument(target.documentId);
  if (live === session) return 'same';
  if (live) {
    const switched = await switchToLiveSession(live);
    if (switched !== 'ok') return switched;
    if (options.threadId) await focusThreadInSession(live, options.threadId);
    return 'moved';
  }
  // 열린 문서는 탭으로 남는다. 쓰이는 문서 없는 채팅도 뒤에 둔다 — 그 자리에 열면 열기가 어차피 새 세션으로
  // 비키는데, 그 세션의 사이드바는 고른 채팅을 모른다. 따라갈 채팅을 새 세션에 먼저 알려 둔다.
  if ((session.wasm.hasLoadedDocument() && canOpenDocumentTab())
    || isDocumentSessionBusy(session) || sessionHoldsActiveUnlinkedChat(session)) {
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

// ─── 문서 없는 채팅에 문서 잇기 ─────────────────────────────
// 문서 없는 채팅(문서 없이 시작했거나 문서를 뗀 채팅)은 문서 하나를 얻을 수 있다. 문서는 그 채팅의 문서 세션에 열리고,
// 채팅은 멈추지도 새로 열리지도 않는다. 사용자 진입점(빈 문서 화면·문서 선택·저장 안내 줄)과 에이전트
// 도구(open_document·create_document)가 이 흐름 하나를 쓴다. 홈·파일 메뉴의 열기는 잇지 않는다.

/** 지금 이 세션에 이을 문서를 여는 중이다 — 열기가 새 세션으로 비키지 않고 이 세션에 연다. */
let linkingSession: DocumentSession | null = null;

/** 열기·만들기 실패를 연결 오류로 바꾼다. 도구 응답과 사용자 안내가 같은 코드를 쓴다. */
function documentLinkFailure(error: unknown): ChatDocumentLinkError {
  if (error instanceof ChatDocumentLinkError) return error;
  if (error instanceof DocumentLiveInSessionError) {
    return linkError('DOC_OPEN_ELSEWHERE', 'The document is open in another tab of this window. Read it with documentId instead.');
  }
  if (error instanceof DocumentOwnedElsewhereError) return linkError('DOC_OPEN_ELSEWHERE');
  if (error instanceof DocumentSessionChangedError) return linkError('LINK_UNAVAILABLE');
  const message = error instanceof Error ? error.message : String(error);
  return linkError('UNREADABLE', message ? `The file could not be opened as a document: ${message}` : undefined);
}

/** 찾은 파일을 이 세션에 연다. 버전 기록 묶음(.rhwpx)은 파일 열기와 같은 길로 꺼내 연다. */
async function openLinkedBytes(
  file: { bytes: Uint8Array; name: string; handle: FileSystemFileHandleLike | null },
  options: { grant?: VerifiedDocumentGrant; suppressDialogs: boolean; freshDocumentId?: boolean },
): Promise<void> {
  if (isPortableHistoryFileName(file.name) || isPortableHistoryBytes(file.bytes)) {
    // 실패하면 이 길이 핸들을 놓는다.
    const common = { bytes: file.bytes, fileName: file.name, skipUnsavedGuard: true, suppressDialogs: options.suppressDialogs };
    const opened = await openDocumentBytesInAttachedSessionNow(options.grant && file.handle
      ? { ...common, fileHandle: file.handle, grant: options.grant }
      : { ...common, fileHandle: file.handle });
    if (!opened) throw linkError('LINK_FAILED');
    return;
  }
  try {
    await loadBytes(file.bytes, file.name, file.handle, performance.now(), {
      suppressDialogs: options.suppressDialogs,
      ...(options.grant ? { grant: options.grant } : {}),
      ...(options.freshDocumentId ? { freshDocumentId: true } : {}),
    });
  } catch (error) {
    await file.handle?.releaseUnusedSaveTarget?.().catch(() => {});
    throw error;
  }
}

/** 최근 문서 기록의 문서를 파일 선택 창 없이 찾아 연다. 이 창의 다른 세션에 열려 있으면 열지 않는다. */
async function openRecentForLink(documentId: string, suppressDialogs: boolean): Promise<void> {
  if (liveSessionForDocument(documentId)) {
    throw linkError('DOC_OPEN_ELSEWHERE', 'The document is open in another tab of this window. Read it with documentId instead.');
  }
  const row = (await listRecentDocs().catch(() => []))
    .filter((entry) => entry.documentId === documentId)
    .sort((a, b) => b.openedAt - a.openedAt)[0];
  if (!row) throw linkError('NOT_FOUND');
  const located = await locateRecoveryOriginal(claimForRecentDoc(row));
  if (located.kind === 'owned-elsewhere') throw linkError('DOC_OPEN_ELSEWHERE');
  if (located.kind === 'permission-denied') {
    throw linkError('PERMISSION_DENIED', 'The browser has not granted access to this file. Ask the user to open it from 문서 선택.');
  }
  if (located.kind !== 'found') throw linkError('NOT_FOUND');
  await openLinkedBytes(located, { grant: { kind: 'verified', documentId: row.documentId }, suppressDialogs });
}

/**
 * 빈 새 문서를 이 세션에 만든다. 데스크톱의 에이전트는 이름(과 폴더)으로 파일을 바로 쓰고 그 파일을
 * 연다. 웹과 사용자의 새 문서는 이름만 정한 저장하지 않은 문서다 — 처음 저장할 때 그 이름을 권한다.
 */
async function createDocumentForLink(
  session: DocumentSession,
  target: Extract<ChatDocumentLinkTarget, { kind: 'new' }>,
  origin: ChatDocumentLinkRequest['origin'],
): Promise<void> {
  if (origin === 'agent' && target.name) {
    const made = await createNamedNativeDocument({
      name: target.name,
      ...(target.folder ? { folder: target.folder } : {}),
      bytes: session.wasm.newDocumentBytes(),
    });
    if (made && !made.ok) throw linkError(made.code);
    if (made) {
      await openLinkedBytes(made, { suppressDialogs: true, freshDocumentId: true });
      return;
    }
    // 데스크톱이 아니면 이름 붙인 저장하지 않은 문서로 만든다. 폴더는 고를 수 없다.
  }
  if (!await createNewDocument()) throw linkError('LINK_FAILED', sbMessage().textContent || undefined);
  if (target.name) {
    const renamed = await renameDocumentInSession(session, target.name);
    if (!renamed.ok) console.warn('[link] 새 문서 이름을 정하지 못했습니다:', renamed.message);
  }
}

/**
 * 대상 문서를 붙은 세션에 연다. 이 열기가 세션에 올린 문서 id 를 열기 직후에 읽어 돌려준다 — 연결은 그
 * 문서에만 한다. 에이전트가 만든 문서면 created.
 */
async function loadLinkTarget(session: DocumentSession, request: ChatDocumentLinkRequest): Promise<LinkLoad> {
  const { target, origin } = request;
  const suppressDialogs = origin === 'agent';
  const loaded = (created: boolean): LinkLoad => ({ created, documentId: session.documentId });
  switch (target.kind) {
    case 'new':
      await createDocumentForLink(session, target, origin);
      return loaded(origin === 'agent');
    case 'recent':
      await openRecentForLink(target.documentId, suppressDialogs);
      return loaded(false);
    case 'path': {
      const opened = await openNativeDocumentAtPath(target.path);
      if (opened === null) throw linkError('DESKTOP_ONLY');
      if (!opened.ok) throw linkError(opened.code);
      await openLinkedBytes(opened, { suppressDialogs });
      return loaded(false);
    }
    case 'pick': {
      const picked = await pickDocumentFile(commandServices);
      if (!picked) throw linkError('CANCELLED');
      await openLinkedBytes(picked, { suppressDialogs });
      return loaded(false);
    }
  }
}

/**
 * 채팅의 문서 세션에 문서를 열고 그 채팅에 잇는다. 이동은 한 번에 하나라 줄을 선다. 뒤에 있는 채팅이면
 * 그 채팅을 앞으로 가져온다 — 열기는 화면에 붙은 세션에만 할 수 있다. 허브에는 열기가 끝난 뒤
 * chat-link-document 로 알린다(도구 응답보다 먼저).
 */
function linkChatDocument(chat: ChatSession, request: ChatDocumentLinkRequest): Promise<ChatDocumentLinked> {
  if (engineTrap()) {
    if (request.origin === 'user') refuseDocumentOpenWhileTrapped();
    return Promise.reject(linkError('LINK_UNAVAILABLE', 'The document engine stopped; the user must recover documents first.'));
  }
  return runNavigation(() => linkChatDocumentNow(chat, request), { label: 'link-document' });
}

async function linkChatDocumentNow(chat: ChatSession, request: ChatDocumentLinkRequest): Promise<ChatDocumentLinked> {
  const session = chat.document;
  if (!liveSessions.includes(session) || !session.chats.includes(chat)) throw linkError('LINK_UNAVAILABLE');
  if (session.wasm.hasLoadedDocument() || !chat.sidebar.isUnlinkedChat()) throw linkError('THREAD_ALREADY_LINKED');
  if (attachedSession !== session) await attachSession(session);
  if (attachedSession !== session) throw linkError('LINK_UNAVAILABLE');
  if (session.activeChat !== chat) showChat(session, chat);
  const threadId = chat.sidebar.beginDocumentLink(request.origin === 'agent' ? request.threadId : undefined);
  // 다른 창이 이 채팅을 먼저 이었으면 사이드바가 그 연결을 따른다.
  if (!threadId) throw linkError(chat.sidebar.isUnlinkedChat() ? 'LINK_UNAVAILABLE' : 'THREAD_ALREADY_LINKED');
  let link: { documentId: string; created: boolean };
  linkingSession = session;
  try {
    const loaded = await loadLinkTarget(session, request);
    await whenDocumentIoIdle();
    // 이 열기가 올린 문서만 잇는다. 그사이 다른 열기가 세션의 문서를 바꿨으면 잇지 않는다.
    const settled = settledLinkLoad(loaded, session.wasm.hasLoadedDocument() ? session.documentId : null);
    if (!settled) throw linkError('LINK_FAILED');
    link = settled;
  } catch (error) {
    chat.sidebar.cancelDocumentLink();
    throw documentLinkFailure(error);
  } finally {
    if (linkingSession === session) linkingSession = null;
  }
  const { documentId, created } = link;
  const name = session.wasm.fileName;
  if (created) session.createdDocument = { threadId, documentId };
  try {
    await chat.sidebar.completeDocumentLink({ documentId, docKey: name, createdByThread: created ? threadId : null });
  } catch (error) {
    const failure = documentLinkFailure(error);
    if (failure.code === 'THREAD_ALREADY_LINKED') {
      // 다른 창이 먼저 이 채팅을 다른 문서에 이었다. 연 문서는 이 채팅의 것이 아니다 — 검토 없이 쓰지 않는다.
      if (session.createdDocument?.documentId === documentId) session.createdDocument = null;
      throw failure;
    }
    // 문서는 이 채팅에 이어졌다. 허브가 확인하지 않은 것은 에이전트에게만 알린다.
    if (request.origin === 'agent') throw failure;
    console.warn('[link] 허브가 문서 연결을 확인하지 않았습니다:', error);
  }
  return { documentId, name };
}

const USER_LINK_FAILURES: Partial<Record<string, string>> = {
  DOC_OPEN_ELSEWHERE: '이미 다른 곳에서 열려 있는 문서입니다.',
  NOT_FOUND: '문서를 찾을 수 없습니다.',
  PERMISSION_DENIED: '파일을 읽을 권한이 없습니다.',
  THREAD_ALREADY_LINKED: '이 채팅에는 이미 문서가 있습니다.',
};

/** 사용자 진입점의 연결. 실패는 짧게 알리고 null. */
async function linkChatDocumentForUser(chat: ChatSession, target: ChatDocumentLinkTarget): Promise<ChatDocumentLinked | null> {
  try {
    return await linkChatDocument(chat, { target, origin: 'user' });
  } catch (error) {
    const code = error instanceof ChatDocumentLinkError ? error.code : '';
    if (code !== 'CANCELLED' && !engineTrap()) {
      showToast({ message: USER_LINK_FAILURES[code] ?? '문서를 연결하지 못했습니다.', durationMs: 3600 });
    }
    return null;
  }
}

/**
 * 화면에 보이는 채팅에 문서를 잇는다 — 빈 문서 화면의 새 문서·파일 열기처럼 편집기 쪽 단추가 부른다.
 * 보이는 채팅에 이미 문서가 있으면 아무것도 하지 않는다.
 */
function linkVisibleChatDocument(target: ChatDocumentLinkTarget): Promise<ChatDocumentLinked | null> {
  const chat = attachedSession.activeChat;
  if (!chat || !chat.sidebar.isUnlinkedChat()) return Promise.resolve(null);
  return linkChatDocumentForUser(chat, target);
}

/**
 * 문서 없는 채팅을 연다. 이 창에 그 채팅이 살아 있으면 그리로 가고, 지금 세션에 문서가 없으면 그 자리에서
 * 잇는다(same). 아니면 문서 없는 새 세션을 열어 집중 화면에서 잇는다 — 지금 문서는 탭으로 남는다.
 */
function openUnlinkedThread(session: DocumentSession, threadId: string): Promise<LibraryMoveResult> {
  if (refuseWhileNavigating()) return Promise.resolve('cancelled');
  return runNavigation(async (): Promise<LibraryMoveResult> => {
    if (session !== attachedSession) {
      console.error('[navigation] 화면에 없는 문서의 채팅 창이 문서 없는 채팅 열기를 요청했습니다');
      return 'cancelled';
    }
    const route = routeUnlinkedThread(session, threadId, allChats());
    if (route.kind === 'holder') {
      const holder = route.chat;
      if (holder.document !== session) {
        const switched = await switchToLiveSession(holder.document);
        if (switched !== 'ok') return switched;
      }
      showChat(holder.document, holder);
      holder.sidebar.enterFullscreen();
      return 'moved';
    }
    if (route.kind === 'in-place') return 'same';
    const fresh = await createLiveSession();
    if (!fresh) return 'failed';
    const switched = await switchToLiveSession(fresh);
    if (switched !== 'ok') {
      await disposeSession(fresh);
      return switched;
    }
    fresh.sidebar?.openThreadById(threadId);
    fresh.sidebar?.enterFullscreen();
    return 'moved';
  });
}

// ─── 채팅을 문서에서 떼기 ─────────────────────────────
// 문서에 붙은 채팅은 그 문서를 뗄 수 있다. 뗀 채팅은 문서 없는 새 세션(빈 종이) 옆에서 이어진다 — 대화와 열람은
// 그대로고 그 문서의 프로젝트와 쓰기는 잃는다. 옮기기 직전에 허브에 떼기를 알리면(chat-detach-document) 허브는
// 공급자를 다시 띄우지 않고 세션의 문서만 비우고, 새 채팅이 그 허브 채팅을 그대로 잇는다(continueHubChat) — 화면은
// 하마가 이름을 삼킨 그대로다. 지금 문서는 다른 문서로 옮겨 갈 때처럼 저장하고, 일하는 다른 채팅이 없으면 닫는다.
// 에이전트의 detach_document 도 같은 길로 옮긴다. 그 턴이 도는 중이라 허브가 그 도구 호출을 맡았다가 새 채팅이
// 붙으면 답한다. 저장도 같다 — 바뀐 문서는 저장하고(처음 저장이면 저장 창이 뜬다) 닫아서, 저장하지 않은 문서가
// 탭으로 쌓이지 않는다. 사용자가 저장을 취소하면 떼지 않는다.

type DetachFailure = Extract<ChatDocumentLinkCode, 'NO_DOCUMENT' | 'EDITS_PENDING_REVIEW' | 'DETACH_UNAVAILABLE' | 'DETACH_FAILED' | 'CANCELLED'>;

const DETACH_FAILURE_MESSAGES: Partial<Record<DetachFailure, string>> = {
  CANCELLED: 'The user cancelled saving the document, so the chat stays attached to it.',
};

function detachChatDocument(chat: ChatSession): Promise<boolean> {
  if (refuseWhileNavigating() || refuseDocumentOpenWhileTrapped()) return Promise.resolve(false);
  return runNavigation(async () => await detachChatDocumentNow(chat, null) === true, { label: 'detach-document' });
}

/** 에이전트의 detach_document. 이동은 한 번에 하나라 줄을 선다. 실패는 그 이유의 ChatDocumentLinkError 로 던진다. */
function detachChatDocumentForAgent(chat: ChatSession, request: ChatDocumentDetachRequest): Promise<void> {
  if (engineTrap()) {
    return Promise.reject(linkError('DETACH_UNAVAILABLE', 'The document engine stopped; the user must recover documents first.'));
  }
  return runNavigation(async () => {
    const outcome = await detachChatDocumentNow(chat, request);
    if (outcome !== true) throw linkError(outcome, DETACH_FAILURE_MESSAGES[outcome]);
  });
}

function hasStagedAgentEdits(chat: ChatSession): boolean {
  return chat.bridge.pendingEdits.getChangeSets().some((set) => set.ops.length > 0);
}

async function detachChatDocumentNow(chat: ChatSession, agent: ChatDocumentDetachRequest | null): Promise<true | DetachFailure> {
  const session = chat.document;
  if (!liveSessions.includes(session) || !session.chats.includes(chat)) return 'DETACH_UNAVAILABLE';
  if (agent) {
    if (chat.sidebar.isUnlinkedChat()) return 'NO_DOCUMENT';
    if (agent.threadId && chat.sidebar.currentThreadId() !== agent.threadId) return 'DETACH_UNAVAILABLE';
    if (hasStagedAgentEdits(chat)) return 'EDITS_PENDING_REVIEW';
    // 하마는 보이는 머리에서 이름을 삼킨다 — 뒤에 있는 채팅이면 앞으로 가져온다(문서 잇기와 같다).
    if (attachedSession !== session) await attachSession(session);
    if (attachedSession === session && session.activeChat !== chat && session.chats.includes(chat)) showChat(session, chat);
  }
  // 사용자의 떼기는 쉬는 채팅만 한다. 에이전트의 떼기는 그 채팅의 턴 중이다.
  const ready = (): boolean => attachedSession === session && session.activeChat === chat
    && session.chats.includes(chat) && (agent !== null || !chat.bridge.isBusy());
  if (!ready()) return 'DETACH_UNAVAILABLE';
  const detach = await chat.sidebar.beginDocumentDetach(agent ? { agent: true } : undefined);
  if (!detach) return agent && hasStagedAgentEdits(chat) ? 'EDITS_PENDING_REVIEW' : 'DETACH_UNAVAILABLE';
  const cancel = (failure: DetachFailure = 'DETACH_UNAVAILABLE'): DetachFailure => {
    chat.sidebar.cancelDocumentDetach();
    return failure;
  };
  // 하마가 이름을 삼키는 사이 채팅이 일을 시작했거나 다른 화면으로 옮겼으면 떼지 않는다.
  if (!ready()) return cancel();
  // 일하는 다른 채팅이 없으면 저장하고 닫는다. 에이전트의 떼기는 그 채팅 자신의 턴을 빼고 본다.
  const closing = !session.chats.some((other) => (agent === null || other !== chat) && other.bridge.isBusy())
    && !isManagedWorktree(session);
  let fresh: DocumentSession | null = null;
  let hubDetached = false;
  // 아직 아무것도 옮기지 않았다 — 원래 문서로 돌아가고 머리의 이름을 되돌린다. 허브에 떼기를 이미 알렸으면 다시 잇는다
  // (에이전트의 떼기면 허브가 맡아 둔 호출을 실패로 답한다).
  const giveUp = async (failure: DetachFailure = 'DETACH_FAILED'): Promise<DetachFailure> => {
    if (hubDetached && detach.documentId && liveSessions.includes(session) && session.chats.includes(chat)) {
      await chat.bridge.linkChatDocument({ threadId: detach.threadId, documentId: detach.documentId, documentName: detach.docKey })
        .catch((error) => console.warn('[sessions] 떼지 못한 채팅을 허브에 다시 잇지 못했습니다:', error));
    }
    if (attachedSession !== session && liveSessions.includes(session)) await attachSession(session);
    if (fresh) await disposeSession(fresh);
    return cancel(failure);
  };
  try {
    if (closing && session.wasm.hasLoadedDocument()) {
      const versions = session.versions;
      const left = await runSaveBeforeLeaving(
        commandServices,
        () => session.documentId,
        versions ? () => commitBeforeLibraryMove(versions) : undefined,
      );
      if (left !== 'ok') return cancel(left === 'cancelled' ? 'CANCELLED' : 'DETACH_FAILED');
    }
    fresh = await createEmptySession();
    if (!fresh) return cancel('DETACH_FAILED');
  } catch (error) {
    console.error('[sessions] 문서에서 떼지 못했습니다:', error);
    return giveUp();
  }
  // 허브가 세션의 문서를 비운다. 에이전트의 떼기면 이 도구 호출을 맡는다 — 새 채팅이 붙으면 허브가 답하고 턴이
  // 이어진다. 허브에 이 채팅이 없으면(초안·연결 끊김) 새 채팅의 chat-start 가 뗀 문서를 싣는다. 옛 사이드바가 아직
  // 화면에 있을 때 기다린다 — 아래의 사이드바 바꾸기는 한 프레임 안에서 끝나야 빈 자리가 비치지 않는다.
  if (!detach.draft) {
    try {
      hubDetached = await chat.bridge.detachChatDocument({
        threadId: detach.threadId,
        ...(agent ? { callId: agent.callId } : {}),
      });
    } catch (error) {
      console.warn('[sessions] 허브가 문서 떼기를 받지 않았습니다:', error);
      return giveUp();
    }
  }
  if (agent && !hubDetached) return giveUp();
  // 쓰던 글과 초점은 새 사이드바가 이어 받는다 — 옛 사이드바가 화면에서 내려가기 전에 잡는다.
  const handoff = chat.sidebar.captureHandoff();
  try {
    await attachSession(fresh);
  } catch (error) {
    console.error('[sessions] 문서에서 떼지 못했습니다:', error);
    return giveUp();
  }
  if (attachedSession !== fresh || !session.chats.includes(chat) || (agent === null && chat.bridge.isBusy())) {
    return giveUp('DETACH_UNAVAILABLE');
  }
  emptyDocumentView?.arrive();
  // 옛 채팅을 먼저 걷는다 — 허브 기록에는 브리지가 하나만 붙는다. 새 채팅이 그 허브 세션으로 같은 채팅을 잇는다.
  const lease = disposeChat(chat, { keepHubSession: true });
  let moved: ChatSession;
  try {
    moved = installChatAgent(fresh, lease, false);
  } catch (error) {
    console.error('[sessions] 뗀 채팅을 새 세션에 달지 못했습니다:', error);
    await restoreUndetachedChat(session, fresh, lease, detach, hubDetached);
    return 'DETACH_FAILED';
  }
  // 새 채팅이 섰다 — 이제 저장소의 채팅을 뗀다. 새 사이드바는 문서 없는 채팅으로 연다. 초점은 옮기지 않는다.
  if (!detach.draft) detachThreadDocument(detach.threadId, { byAgent: agent !== null });
  if (session.createdDocument?.threadId === detach.threadId) session.createdDocument = null;
  if (hubDetached) moved.bridge.continueHubChat(detach.threadId);
  moved.sidebar.activate();
  setAgentEditingLease(documentEditingLease(fresh));
  reinstallInlinePrompt();
  if (detach.draft) moved.sidebar.startDraftChat();
  else moved.sidebar.openThreadById(detach.threadId, { handoff });
  if (closing && !isDocumentSessionBusy(session)) {
    await disposeSession(session);
  } else if (session.chats.length === 0 && liveSessions.includes(session)) {
    // 뒤에 남는 문서에도 채팅 하나는 있어야 한다 — 다시 붙으면 그 사이드바가 보인다.
    if (!await createChatSession(session, { active: true })) console.warn('[sessions] 뒤에 남은 문서에 채팅을 달지 못했습니다');
  }
  return true;
}

/**
 * 새 세션에 채팅을 달지 못했다 — 같은 허브 세션으로 원래 문서에 채팅을 다시 달고, 아직 이어진 그 채팅을 연다.
 * 허브에 이미 떼기를 알렸으면(relink) 그 문서를 다시 잇는다 — 허브는 맡아 둔 떼기를 실패로 답한다.
 */
async function restoreUndetachedChat(
  session: DocumentSession,
  fresh: DocumentSession,
  lease: AgentHubSessionLease | null,
  detach: DocumentDetachStart,
  relink = false,
): Promise<void> {
  try {
    const chat = installChatAgent(session, lease, true);
    if (relink) chat.bridge.continueHubChat(detach.threadId);
    if (attachedSession !== session) await attachSession(session);
    if (!detach.draft) chat.sidebar.openThreadById(detach.threadId);
    if (relink && detach.documentId) {
      await chat.bridge.hubSessionKnown();
      await chat.bridge.linkChatDocument({ threadId: detach.threadId, documentId: detach.documentId, documentName: detach.docKey });
    }
  } catch (error) {
    console.error('[sessions] 채팅을 원래 문서에 되돌리지 못했습니다:', error);
    void lease?.release();
  }
  await disposeSession(fresh);
}

/** 창을 닫기 전에, 뒤에서 에이전트가 일하거나 저장하지 않은 문서가 있으면 묻는다. */
async function confirmCloseWithBackgroundSessions(): Promise<boolean> {
  // 다른 문서에서 일하는 에이전트와, 지금 문서에서 보이지 않는 채팅이 일하는 경우를 함께 묻는다.
  // 뒤에서 일하는 문서 없는 채팅(홈에서 문서를 연 뒤에도 이어 가는 채팅)도 묻는다.
  // 저장하지 않은 쉬는 탭은 여기서 묻지 않는다 — confirmSaveBackgroundDocuments 가 하나씩 저장을 묻는다.
  const background = liveSessions.filter((session) => (session.wasm.hasLoadedDocument()
    ? (session === attachedSession
      ? session.chats.some((chat) => chat !== session.activeChat && chat.bridge.isBusy())
      : isDocumentSessionBusy(session))
    : session !== attachedSession && isDocumentSessionBusy(session)));
  if (background.length === 0) return true;
  const names = background.map((session) => (
    session.wasm.hasLoadedDocument() ? `"${session.wasm.fileName}"` : '문서 없는 채팅'
  )).join(', ');
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

/**
 * 창을 닫기 전에 뒤 탭의 저장하지 않은 문서를 하나씩 앞에 띄워 저장을 묻는다. 하나라도 취소하면 그 문서에 머물고
 * false. 다 물으면 처음 문서로 돌아간다 — 그 문서는 창 닫기가 마지막에 묻는다.
 */
async function confirmSaveBackgroundDocuments(): Promise<boolean> {
  const original = attachedSession;
  const dirty = liveSessions.filter((session) => session !== original && session.wasm.hasLoadedDocument()
    && session.documentState.isDirty() && !isDocumentSessionBusy(session));
  for (const session of dirty) {
    if (!liveSessions.includes(session) || !session.documentState.isDirty()) continue;
    if (refuseWhileNavigating()) return false;
    await runNavigation(() => attachSession(session), { label: 'close-window-save' });
    if (attachedSession !== session) return false;
    documentHome?.hide();
    if (!await canReplaceCurrentDocument()) return false;
  }
  if (attachedSession !== original && liveSessions.includes(original) && !isNavigating()) {
    await runNavigation(() => attachSession(original), { label: 'close-window-save' });
  }
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
    if (e.defaultPrevented || e.isComposing) return;
    // 문서 홈이 떠 있으면 새 문서·열기만 받는다. 가린 문서를 고치거나 그쪽으로 초점을 옮기지 않는다.
    if (documentHome?.visible) {
      const commandId = matchShortcut(e, defaultShortcuts);
      if (commandId !== 'file:new-doc' && commandId !== 'file:open') return;
      e.preventDefault();
      dispatcher.dispatch(commandId);
      return;
    }
    if (!allowsDocumentShortcut(target)) return;
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
  installDocumentHome();
  installAppHomeButton();
  installEmptyDocumentView();

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
  container.addEventListener('drop', (e) => {
    container.classList.remove('drag-over');
    void handleDocumentDrop(e);
  });
}

/**
 * 편집 영역·문서 홈에 놓은 파일. 문서는 열고, 그림은 지금 문서에 넣는다. 문서 홈에 놓은 그림은
 * 가린 문서에 넣지 않는다.
 */
async function handleDocumentDrop(e: DragEvent, options: { fromHome?: boolean } = {}): Promise<void> {
  eventBus.emit('document-open-intent');
  e.preventDefault();
  const file = e.dataTransfer?.files[0];
  if (!file) return;
  const dropName = file.name.toLowerCase();
  const imageExts = ['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp'];
  const isImage = imageExts.some(ext => dropName.endsWith(ext));
  const isDoc = isSupportedDocumentFileName(dropName);
  if (options.fromHome && !isDoc) {
    showToast({ message: 'HWP/HWPX/HML/RHWPX 파일을 놓으면 열립니다.', durationMs: 2600 });
    return;
  }
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
      const prepared = await prepareDocumentImage(data, ext, file.type);
      const result = inputHandler.insertDroppedImageAtClientPoint(
        prepared.bytes,
        prepared.extension,
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
          report: true,
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

  // 받기: 받은 문서를 지금 문서의 현재 브랜치에 병합한다.
  document.getElementById('sb-receive')!.addEventListener('click', () => {
    if (wasm.pageCount === 0) return;
    const session = attachedSession;
    mergeReceivedDocument(session.versions ?? installDocumentVersions(session)).catch((error) => {
      if (versionErrorCode(error) === 'CANCELLED') return;
      showToast({ message: error instanceof Error ? error.message : String(error), durationMs: 5000 });
    });
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
    setStatusLabel(sbPage(), `${pageIdx + 1} / ${_total} 쪽`);

    // 구역 정보: 현재 페이지의 sectionIndex로 갱신
    if (wasm.pageCount > 0) {
      try {
        const pageInfo = wasm.getPageInfo(pageIdx);
        statusSectionIndex = pageInfo.sectionIndex;
        setStatusLabel(sbSection(), `구역: ${pageInfo.sectionIndex + 1} / ${totalSections}`);
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

  eventBus.on('document-dirty-changed', (payload) => {
    eventBus.emit('command-state-changed');
    // 계정 통계: 이 창에서 문서를 처음 고친 때. 세션을 붙이거나 자동 저장을 되살린 표시는 편집이 아니다.
    const change = payload as { dirty?: boolean; reason?: string } | undefined;
    if (change?.dirty && change.reason !== 'document-session-attached' && change.reason !== 'autosave-recovered') {
      recordAccountActivity('document_edited', attachedSession.documentId);
    }
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
      button.disabled = !dispatcher.isEnabled(button.dataset.cmd ?? '', context);
    });
    // 글머리표는 명령 대신 고르기 팝업을 여는 단추라 data-cmd 가 없다. 같은 명령의 상태를 따른다.
    const bulletButton = document.getElementById('tb-bullet') as HTMLButtonElement | null;
    if (bulletButton) bulletButton.disabled = !dispatcher.isEnabled('format:bullet-shape', context);
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
          button.disabled = !dispatcher.isEnabled(command, context)
            || (mode === 'object' && !contextualObjectCommandEnabled(command, objectSelection));
        });
      }
    });
    tableRibbonMenus?.refresh((command) => dispatcher.isEnabled(command, context));
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
      hfLabel.textContent = state === 'none' ? '' : `${kind}(${target}) 편집 중`;
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
  wasm.setShowControlCodes(settings.view.showControlCodes);
  wasm.setShowParagraphMarks(settings.view.showParagraphMarks);
  syncTextMarkMenu(settings.view.showControlCodes, settings.view.showParagraphMarks);
  const clipEnabled = !settings.view.clipView;
  wasm.setClipEnabled(clipEnabled);
  syncClipMenu(clipEnabled);
  // 꺼질 때마다 배치를 다시 재므로 바뀐 경우에만 건다.
  const header = document.getElementById('studio-header');
  if (header && header.hasAttribute(COMPACT_TOOLBAR_ATTR) !== settings.view.compactToolbar) {
    applyCompactToolbar(settings.view.compactToolbar);
  }
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

// 사용자가 직접 문서를 열면 집중 화면을 접고 사이드바 보기로 연다. 채팅 목록에서 다른
// 문서의 채팅으로 옮겨 가며 문서가 열릴 때는 집중 화면을 그대로 둔다. 파일 선택 창을
// 닫고 끝난 의도가 나중의 채팅 이동에 남지 않게 잠깐만 유효하다.
const DOCUMENT_OPEN_INTENT_MS = 60_000;
let documentOpenIntentAt = 0;
eventBus.on('document-open-intent', () => { documentOpenIntentAt = performance.now(); });

function showOpenedDocumentInSidebar(): void {
  documentOpenIntentAt = 0;
  for (const chat of allChats()) chat.sidebar.exitFullscreen();
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
    // PC 전체 색인을 쓰면 본문 윤곽선은 엔진이 직접 준비한다. 브라우저 face는 목록 미리보기용이다.
    // 첫 문서도 엔진이 기다릴 같은 색인 약속을 쓴다. 로딩 중이라는 이유로 full face를 중복 읽지 않는다.
    if (getSystemFontHost()?.coversSystem) await loadDesktopFontIndex().catch(() => {});
    const desktopPreviewOnly = isDesktopFontIndexReady() && getSystemFontHost()?.coversSystem === true;
    if (desktopPreviewOnly) await loadStoredLocalFonts();
    const fontsUsed = docInfo.fontsUsed;
    const prepareDesktopFonts = fontsUsed?.length
      ? () => (async () => {
        await loadStoredLocalFonts();
        return prepareSystemFontsForDocument(fontsUsed);
      })().catch((error): DesktopFontReport[] => {
        console.warn('[DesktopFonts] 문서 글꼴 연결 실패:', error);
        return [];
      })
      : null;
    const desktopFonts = desktopPreviewOnly ? null : prepareDesktopFonts?.();
    if (docInfo.fontsUsed?.length) {
      // 쪽 글자는 엔진이 글꼴 윤곽선으로 그린다. CSS 웹 글꼴은 글꼴 목록 미리보기용이라 기다리지 않는다.
      void loadWebFonts(docInfo.fontsUsed, () => {})
        .catch(error => console.warn('[fonts] 웹 글꼴 미리보기 등록 실패:', error));
    }
    // PC 글꼴과 엔진의 윤곽선 준비를 겹치되, 첫 조판은 둘 다 끝난 뒤에 한다.
    const engineFonts = wasm.viewer.prepareFonts(docInfo.fontsUsed ?? [], {});
    void engineFonts.catch(() => {}); // 아래 await에서 오류를 전파한다.
    if (desktopFonts && !desktopPreviewOnly) {
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
    // PC 글꼴과 엔진 윤곽선이 모두 준비된 뒤 문서 상태와 첫 쪽을 읽는다.
    await engineFonts;
    docInfo = wasm.getDocumentInfo();
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
    documentHome?.hide();
    if (documentOpenIntentAt && performance.now() - documentOpenIntentAt < DOCUMENT_OPEN_INTENT_MS) {
      showOpenedDocumentInSidebar();
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
    await updateLoadProgress(96, '편집 상태 초기화 중...', { paint: true });
    inputHandler?.activateWithCaretPosition();
    if (desktopPreviewOnly && prepareDesktopFonts) {
      // 쪽과 입력이 준비된 다음 브라우저 목록용 face를 연결한다.
      void waitForNextPaint().then(prepareDesktopFonts).then(applyLateFontReports);
    }
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
      showToast({ message: '문서는 열렸지만 버전 기록을 준비하지 못했습니다.', durationMs: 4500, report: true });
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
    // 새 바이트가 올라갈 때까지 엔진에는 앞 문서가 있다 — 채팅이 새 id 를 앞 문서 이름과 짝짓지 않게 한다.
    target.replacingDocument = { previousDocumentId: previousBinding.documentId };
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
    target.replacingDocument = null;
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
    target.replacingDocument = null;
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
    target.replacingDocument = null;
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
    for (const doc of recents.slice(0, RECENT_MENU_LIMIT)) {
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

/** skipDocumentIds: 업데이트로 다시 켠 다른 창이 다시 여는 문서. 그 복구본은 묻지도 지우지도 않는다. */
async function offerAutosaveRecoveryAtStartup(skipDocumentIds: ReadonlySet<string> = new Set()): Promise<void> {
  if (isPinnedDocumentEnabled()) return;
  const listRecoverable = async () => (await listRecoverableAutosaveDrafts())
    .filter((draft) => !draft.documentId || !skipDocumentIds.has(draft.documentId));

  try {
    // 다른 창에서 띄운 창은 묻지 않는다. 복구본은 남아 앱의 첫 창이 다음에 묻는다.
    if (!await offersAutosaveRecovery()) return;
    await rendererSessionContextPromise;
    await offerAutosaveRecovery({
      listRecoverable,
      hasOpenDocument: () => wasm.pageCount > 0 || documentState.isDirty(),
      notifyAvailable: (open) => showToast({
        message: '복구할 수 있는 자동 저장본이 있습니다.',
        durationMs: 0,
        action: { label: '복구', onClick: open },
      }),
      markOffered: (ids) => markAutosaveDraftsOffered(ids),
      showDialog: (drafts) => showAutosaveRecoveryDialog(drafts),
      clearRecoverable: async () => {
        await Promise.all((await listRecoverable()).map((draft) => deleteAutosaveDraft(draft.id)));
      },
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
  options: DraftRestoreOptions & {
    canMerge?: boolean;
    /** 이미 아는 원본 파일. 생략하면 찾아보고, null 이면 파일이 없는 문서다. */
    original?: FileSystemFileHandleLike | null;
  } = {},
): Promise<DraftRestoreOutcome> {
  const { canMerge = true, original, ...restoreOptions } = options;
  return restoreAutosaveDraft(draft, {
    readDraft: (id) => getAutosaveDraft(id),
    locateOriginal: original === undefined ? locateAutosaveOriginal : () => readKnownOriginal(original),
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

/** 이미 아는 원본 핸들(업데이트로 다시 켠 창에 메인이 다시 만든 것)을 읽는다. 없거나 읽지 못하면 원본이 없다. */
async function readKnownOriginal(handle: FileSystemFileHandleLike | null): Promise<ProjectFileLocation> {
  if (!handle) return { kind: 'missing' };
  try {
    return { kind: 'found', ...await readFileFromHandle(handle), handle };
  } catch {
    return { kind: 'missing' };
  }
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

// ─── 앱 업데이트 재시작 ─────────────────────────────
// 메인은 업데이트를 설치하기 전에 창마다 문서를 넘겨받고 저장을 묻지 않고 창을 닫는다. 다시 켠 창은 그 문서를 같은
// 문서 ID·파일·채팅으로 다시 열고, 돌던 턴을 이어서 진행한다. 메인이 모르는 것(바뀐 문서인지, 그 복구본, 보던
// 채팅)은 recovery/update-restart 가 문서마다 남긴다.

function localStorageOrNull(): Storage | null {
  try { return window.localStorage; } catch { return null; }
}

/** 턴이 돌고 있고 사용자의 답(질문·권한)을 기다리지 않는 채팅 — 다시 켠 뒤 이어서 진행한다. */
function chatContinuesAfterRestart(chat: ChatSession): boolean {
  return chat.bridge.isTurnRunning() && chat.bridge.getPendingUserQuestion() === null
    && chat.bridge.getPendingChatPermissionRequests().length === 0;
}

let reportedRunningChats: number | null = null;

/** 재시작 경고 팻말이 세는 이 창의 채팅 수를 메인에 알린다. 다시 켠 뒤 이어서 진행할 채팅과 같다. */
function reportRunningChats(): void {
  const updates = desktopUpdatesApi();
  if (!updates) return;
  const count = allChats().filter(chatContinuesAfterRestart).length;
  if (count === reportedRunningChats) return;
  reportedRunningChats = count;
  updates.setRunningChatCount(count);
}

/** 이 문서의 복구본을 지금 내용으로 남긴다. 엔진이 멈췄으면 엔진 trap 복구본처럼 한 번만 시도한다. */
async function keepUpdateRestartDraft(session: DocumentSession): Promise<boolean> {
  if (engineTrap()) return (await session.autosave.saveForRecovery('update-restart').catch(() => null))?.ok === true;
  return session.autosave.flushAndWait('update-restart').catch(() => false);
}

interface UpdateRestartEntry {
  session: DocumentSession;
  kind: UpdateRestartRecord['kind'];
  kept: boolean;
  pendingAgentOps: number;
}

/**
 * 저장을 묻지 않고 닫히므로 문서마다 다시 여는 법을 남긴다: 바뀐 문서(검토 대기 편집 포함)와 파일 없는 문서는
 * 복구본으로(복구용 자동 저장을 꺼 두었어도 이번에는 남긴다), 깨끗한 파일 문서는 그 파일로, 버전 기록의 작업
 * 공간 문서는 작업 공간으로. kept 가 false 면 그 문서의 복구본을 남기지 못했다.
 */
async function keepUpdateRestartDocuments(): Promise<UpdateRestartEntry[]> {
  // 진행 중인 저장이 끝나야 문서가 깨끗한지 안다.
  await whenSavesIdle().catch(() => {});
  try { inputHandler?.flushDeferredPaginationIfNeeded('update-restart'); } catch { /* 복구본은 그대로 남긴다 */ }
  return Promise.all(liveSessions
    .filter((session) => session.documentId !== null && session.wasm.hasLoadedDocument())
    .map(async (session) => {
      const pendingAgentOps = session.chats.reduce((sum, chat) => sum + chat.bridge.pendingEdits.getChangeSets()
        .reduce((count, set) => count + set.ops.length, 0), 0);
      const kind = updateRestartKind({
        managedWorktree: isManagedWorktree(session),
        dirty: session.documentState.isDirty() || pendingAgentOps > 0,
        hasFile: Boolean(session.wasm.currentFileHandle),
      });
      // 닫힐 때(pagehide)처럼 작업 공간에 지금 내용을 남긴다. 작업 공간 문서는 이것이 다시 열 내용이다.
      const persisted = await (session.versions?.persistWorktree() ?? Promise.resolve()).then(() => true, () => false);
      const kept = kind === 'file' ? true
        // 다른 창이 편집하는 작업 공간(읽기 전용)은 남길 변경이 없다.
        : kind === 'worktree' ? persisted || !session.worktreeWritable
          : await keepUpdateRestartDraft(session);
      return { session, kind, kept, pendingAgentOps };
    }));
}

/** 메인에 넘길 이 창의 문서와, 다시 켠 창이 문서마다 읽을 기록. */
function describeUpdateRestart(entries: readonly UpdateRestartEntry[], now: number): {
  documents: UpdateRestartSlice['documents'];
  records: Map<string, UpdateRestartRecord>;
} {
  const records = new Map<string, UpdateRestartRecord>();
  const documents: UpdateRestartSlice['documents'] = [];
  for (const { session, kind, kept, pendingAgentOps } of entries) {
    const documentId = session.documentId!;
    const hasFile = Boolean(session.wasm.currentFileHandle);
    // 복구본을 남기지 못했으면 그 전 자동 저장본을, 그것도 없으면 파일을 연다. 둘 다 없으면 다시 열 수 없다.
    const draftId = session.autosave.getLastSavedAt() !== null ? session.autosave.getCurrentDraftId() : null;
    const restore = kind === 'draft' || kind === 'copy' ? (draftId ? kind : hasFile ? 'file' : null) : kind;
    if (!restore) continue;
    records.set(documentId, {
      kind: restore,
      // 작업 공간에서 다시 열면 이 문서의 자동 저장본은 지운다. 작업 공간에 남기지 못했으면 복구 제안에 둔다.
      draftId: restore === 'file' || (restore === 'worktree' && !kept) ? null : draftId,
      activeThreadId: session.activeChat?.sidebar.currentThreadId() ?? null,
      pendingAgentOps,
      hasFile,
      readOnly: documentReadOnly,
      savedAt: now,
    });
    documents.push({
      documentId,
      handleId: nativeFileHandleId(session.wasm.currentFileHandle),
      fileName: session.wasm.fileName,
      active: session === attachedSession,
    });
  }
  return { documents, records };
}

/** 돌던 채팅은 다시 켠 뒤 이어서 진행한다(질문·권한을 기다리면 뺀다). */
function updateRestartThreadIds(): string[] {
  return allChats().filter(chatContinuesAfterRestart)
    .map((chat) => chat.sidebar.currentThreadId())
    .filter((threadId): threadId is string => threadId !== null);
}

const REFUSED_UPDATE_RESTART: UpdateRestartSlice = { ok: false, documents: [], continueThreadIds: [] };
/** 준비에 응한 결과. 확정이 이어받는다. 멈춘 재시작이 남긴 것은 다음 준비가 덮는다. */
let preparedUpdateRestart: UpdateRestartEntry[] | null = null;

/**
 * 업데이트 재시작 준비 — 메인이 모든 창에 먼저 부른다. 문서마다 복구본을 남기고, 남기지 못한 문서가 있으면 한
 * 번 묻고, 거절하면 재시작하지 않는다. 다른 창이 거절할 수 있으니 닫기 확인은 아직 풀지 않는다.
 */
async function prepareUpdateRestart(): Promise<UpdateRestartSlice> {
  preparedUpdateRestart = null;
  const entries = await keepUpdateRestartDocuments();
  const lost = entries.filter((entry) => !entry.kept);
  if (lost.length > 0) {
    const names = lost.map(({ session }) => `"${session.wasm.fileName}"`).join(', ');
    if (!await showConfirm('복구본을 남기지 못했어요', `${names}\n재시작하면 저장하지 않은 변경이 사라져요.`)) {
      return REFUSED_UPDATE_RESTART;
    }
  }
  preparedUpdateRestart = entries;
  return { ok: true, documents: describeUpdateRestart(entries, Date.now()).documents, continueThreadIds: updateRestartThreadIds() };
}

/**
 * 업데이트 재시작 확정 — 모든 창이 준비에 응한 뒤 메인이 부른다. 준비 뒤의 편집까지 같은 복구본에 남기고, 기록과
 * 채팅을 넘긴 뒤 닫기 확인을 푼다. 준비 때 사용자가 받아들이지 않은 문서의 복구본을 남기지 못하면 묻지 않고 멈춘다.
 */
async function commitUpdateRestart(): Promise<UpdateRestartSlice> {
  const prepared = preparedUpdateRestart;
  preparedUpdateRestart = null;
  if (!prepared) return REFUSED_UPDATE_RESTART;
  // 멈춘 엔진은 그 뒤로 편집을 받지 않고 복구본도 한 번만 남긴다.
  const entries = engineTrap() ? prepared : await keepUpdateRestartDocuments();
  const acceptedLoss = new Set(prepared.filter((entry) => !entry.kept).map((entry) => entry.session));
  if (entries.some((entry) => !entry.kept && !acceptedLoss.has(entry.session))) return REFUSED_UPDATE_RESTART;
  const now = Date.now();
  const { documents, records } = describeUpdateRestart(entries, now);
  // 기록을 남기지 못해도 재시작한다. 다시 켠 창은 파일 문서만 열고, 남은 복구본은 복구 제안에 나온다.
  if (!writeUpdateRestartRecords(localStorageOrNull(), records, now)) {
    console.warn('[update] 다시 켠 뒤 열 문서 기록을 남기지 못했습니다.');
  }
  const continueThreadIds = updateRestartThreadIds();
  // 닫힐 때처럼 채팅 기록을 넘기고, 창이 닫히기 전에 저장소에 닿게 기다린다.
  for (const chat of allChats()) chat.sidebar.persistThread();
  await waitForThreadsPersistence().catch(() => {});
  // 복구본을 남겼으니 저장하지 않은 문서의 나가기 확인을 이번 한 번 푼다.
  for (const session of liveSessions) session.documentState.permitNextUnload();
  return { ok: true, documents, continueThreadIds };
}

type UpdateRestoreDocument = UpdateRestoreSlice['documents'][number] & {
  kind: UpdateRestartRecord['kind'];
  record: UpdateRestartRecord;
};

/**
 * 업데이트로 다시 켠 창 — 닫히기 전의 문서를 다시 연다. 보던 문서는 화면에 붙이고 나머지는 채팅 레일처럼 뒤에
 * 둔다. 바뀐 문서는 복구본을 원래 문서에 dirty 로 얹고(자동 저장본 복구와 같은 길 — 디스크가 바뀌었으면 외부
 * 변경으로 병합하고, 원본이 없으면 연결하지 않고 연다), 깨끗한 문서는 파일에서, 파일 없는 새 문서는 복구본에서
 * 그 이름으로 연다. 한 문서를 열지 못해도 나머지는 연다. 다시 연 복구본은 이 창이 이어받으므로, 끝난 뒤의 복구
 * 제안에는 열지 못한 문서의 복구본만 남는다.
 */
async function restoreWindowAfterUpdate(restore: UpdateRestoreSlice): Promise<void> {
  try {
    await runNavigation(async () => {
      // 복구한 draft 를 이 창 이름으로 다시 기록하므로 창 세션을 먼저 받는다.
      await rendererSessionContextPromise;
      const drafts = await listAutosaveDrafts().catch((): AutosaveDraftSummary[] => []);
      const storage = localStorageOrNull();
      const now = Date.now();
      const entries = restore.documents.flatMap((document): UpdateRestoreDocument[] => {
        // 기록이 없으면(남기지 못했다) 파일 문서만 파일에서 연다. 복구본은 복구 제안에 남는다.
        const record: UpdateRestartRecord | null = takeUpdateRestartRecord(storage, document.documentId, now)
          ?? (document.file ? {
            kind: 'file', draftId: null, activeThreadId: null, pendingAgentOps: 0, hasFile: true, readOnly: false, savedAt: now,
          } : null);
        return record ? [{ ...document, kind: record.kind, record }] : [];
      });
      let othersWaited = false;
      for (const entry of orderUpdateRestore(entries)) {
        const handle = entry.file ? restoredNativeFileHandle(entry.file) : null;
        try {
          if (liveSessionForDocument(entry.documentId)) continue;
          const inPlace = entry.kind !== 'worktree' && !attachedSession.wasm.hasLoadedDocument();
          if (!inPlace && !othersWaited) {
            othersWaited = true;
            // 첫 채팅이 시작 정리(끊긴 턴 정착)를 마친 뒤에 채팅을 더 연다 — 그 채팅들이 정착된 기록을 읽는다.
            await firstSession.chats[0]?.sidebar.startupChatSettled();
          }
          if (entry.kind === 'worktree') {
            await reopenWorktreeAfterUpdate(entry);
          } else if (inPlace) {
            await openUpdatedDocument(entry, handle, drafts);
          } else {
            const outcome = await openInNewSession(() => {}, () => openUpdatedDocument(entry, handle, drafts));
            if (!outcome?.loaded) throw new Error('문서 세션을 만들지 못했습니다.');
          }
          if (entry.record.pendingAgentOps > 0) {
            showToast({
              message: `"${entry.fileName}"에 검토하지 않은 에이전트 변경 ${entry.record.pendingAgentOps}개가 반영된 채로 열렸어요.`,
              durationMs: 6000,
            });
          }
        } catch (error) {
          console.warn('[update] 업데이트 전 문서를 다시 열지 못했습니다:', error);
          showToast({ message: `"${entry.fileName}"을(를) 다시 열지 못했어요.`, durationMs: 5000, report: true });
        } finally {
          await handle?.releaseUnusedSaveTarget?.().catch(() => {});
        }
      }
      const active = liveSessionForDocument(restore.documents.find((document) => document.active)?.documentId);
      if (active) await attachSession(active);
    });
  } catch (error) {
    console.error('[update] 업데이트 전 문서를 다시 열지 못했습니다:', error);
  } finally {
    // 다른 창이 다시 여는 문서의 복구본은 그 창이 이어받는다. 이 창이 열지 못한 문서의 복구본은 제안에 남는다.
    const own = new Set(restore.documents.map((document) => document.documentId));
    void offerAutosaveRecoveryAtStartup(new Set(restore.restoredDocumentIds.filter((id) => !own.has(id))));
  }
  await continueChatsAfterUpdate(restore.continueThreadIds);
}

/** 지금 화면에 붙은 세션에 업데이트 전 문서 하나를 연다. 그 문서에서 보던 채팅이 따라 열린다. 열지 못하면 던진다. */
async function openUpdatedDocument(
  entry: UpdateRestoreDocument,
  handle: FileSystemFileHandleLike | null,
  drafts: readonly AutosaveDraftSummary[],
): Promise<void> {
  const { record } = entry;
  if (record.activeThreadId) attachedSession.sidebar?.followThreadOnNextDocument(record.activeThreadId);
  // 읽기 전용으로 보던 창(생성 문서 미리보기 등)은 다시 열어도 읽기 전용이다. 창 전체 설정이다.
  if (record.readOnly) setDocumentReadOnly(true);
  const draft = record.draftId ? drafts.find((row) => row.id === record.draftId && row.byteLength > 0) : undefined;
  if (draft) {
    const outcome = await restoreAutosaveDraftInAttachedSession(draft, {
      // 메인이 다시 만든 원본 핸들. 경로를 잃었으면 북마크로 찾고, 파일이 없던 문서는 찾지 않는다.
      original: record.hasFile ? handle ?? undefined : null,
      // 병합 화면은 보던 문서에만 연다. 뒤에 둘 문서는 디스크가 바뀌었으면 연결하지 않고 연다.
      canMerge: entry.active,
      // 깨끗했던 파일 없는 문서(편집하지 않은 새 문서 등)는 깨끗하게 연다.
      ...(record.kind === 'copy' ? { cleanAtTrap: true, readOnly: true } : {}),
      // 원래 문서에 그대로 얹었으면 알리지 않는다. 원본 파일과 끊겼거나 병합해야 하면 알린다.
      report: (outcome) => {
        if (outcome.kind === 'merging' || (outcome.kind === 'opened' && record.hasFile && outcome.detached !== null)) {
          showToast({ message: outcome.message, durationMs: 6000 });
        }
      },
    });
    if (outcome.kind === 'blocked') throw new Error(outcome.message);
    if (outcome.kind === 'cancelled') throw new Error('다시 열기를 취소했습니다.');
    return;
  }
  const reopened = handle
    ? await reopenLocatedFile(await readKnownOriginal(handle), entry.documentId)
    : await reopenTrapFile(entry);
  if (reopened.kind === 'failed') throw new Error(reopened.message ?? reopened.reason);
  if (record.kind !== 'file') {
    showToast({
      message: `"${entry.fileName}"의 저장하지 않은 변경을 복구하지 못해 마지막으로 저장한 상태로 열었어요.`,
      durationMs: 6000,
    });
  }
}

/** 버전 기록의 작업 공간 문서를 작업 공간에서 다시 연다(새 세션). 보던 채팅을 잇고 남은 자동 저장본은 지운다. */
async function reopenWorktreeAfterUpdate(entry: UpdateRestoreDocument): Promise<void> {
  const worktree = await worktreeStore.findWorktreeByDocumentId(versionDocumentId(entry.documentId));
  if (!worktree) throw new Error('워크트리가 삭제되었습니다.');
  const session = await openWorktreeSession(worktree);
  if (entry.record.activeThreadId) await focusThreadInSession(session, entry.record.activeThreadId);
  if (entry.record.draftId) await deleteAutosaveDraft(entry.record.draftId).catch(() => {});
}

/** 앱 업데이트 뒤 이어서 진행을 기다리는 채팅. 보이지 않는 채팅이어도 그동안 닫지 않는다. */
const restartResumingChats = new Set<ChatSession>();

/**
 * 업데이트 전 돌던 턴을 이어서 진행한다 — 앱 재시작으로 끊긴 턴의 이어서 진행 단추를 한 번 누른다. 그 채팅을
 * 보이는 채팅 창이 없으면 그 문서에 채팅 창을 하나 더 열고(뒤에 있는 문서면 그 문서의 에이전트 세션에서),
 * 문서 없는 채팅이면 문서 없는 세션에서 연다. 사이드바가 연결된 뒤 누르고, 질문의 답을 기다리다 끊겼거나 이미
 * 이어 간 채팅은 건너뛴다. 목록은 메인이 한 번만 주므로 새로고침해도 다시 보내지 않는다.
 */
async function continueChatsAfterUpdate(threadIds: readonly string[]): Promise<void> {
  if (threadIds.length === 0) return;
  // 채팅 창마다 시작 채팅을 고른 뒤에 본다 — 곧 그 채팅을 고를 창 옆에 채팅 창을 하나 더 열지 않게.
  await Promise.all(allChats().map((chat) => chat.sidebar.startupChatSettled()));
  const routed = await runNavigation(async () => {
    const chats: Array<{ chat: ChatSession; threadId: string }> = [];
    for (const threadId of threadIds) {
      const chat = await chatForRestartedThread(threadId).catch(() => null);
      if (chat) chats.push({ chat, threadId });
    }
    return chats;
  });
  for (const { chat, threadId } of routed) {
    restartResumingChats.add(chat);
    void chat.sidebar.startupChatSettled()
      .then(() => chat.sidebar.resumeAfterRestart(threadId))
      .finally(() => restartResumingChats.delete(chat));
  }
}

/** 그 채팅을 보일 채팅 창. 그 채팅의 문서가 이 창에 다시 열리지 않았으면 null. */
async function chatForRestartedThread(threadId: string): Promise<ChatSession | null> {
  const holder = allChats().find((chat) => chat.sidebar.currentThreadId() === threadId);
  if (holder) return holder;
  const thread = getThread(threadId);
  if (!thread) return null;
  const session = thread.documentId === null && thread.docKey === null
    ? liveSessions.find((candidate) => !candidate.wasm.hasLoadedDocument()) ?? await createLiveSession()
    : liveSessionForDocument(thread.documentId);
  if (!session) return null;
  // 아직 아무 채팅도 고르지 않은 채팅 창이 있으면 그 자리에서 연다.
  const chat = session.chats.find((candidate) => candidate.sidebar.currentThreadId() === null && !candidate.bridge.isBusy())
    ?? await createChatSession(session, { active: false });
  chat?.sidebar.openThreadById(threadId);
  return chat;
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
        // 그 채팅을 이미 연 사이드바가 있으면 그 사이드바가 표시한다(저장소 사본은 다음 저장 때 덮인다).
        markInterrupted: (threadId) => markThreadInterruptedByEngineTrap(
          threadId,
          (id) => allChats().find((chat) => chat.sidebar.currentThreadId() === id)?.sidebar ?? null,
        ),
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
    if (!report.stoppedByTrap) noteAutofixOutcome('engine-trap', true);
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

/** 깨끗했던 문서를 파일 선택 창 없이 그 파일에서 다시 연다. 최근 문서와 데스크톱 북마크로 파일을 찾는다. */
async function reopenTrapFile(entry: Pick<TrapManifestEntry, 'documentId' | 'fileName'>): Promise<TrapOpenResult> {
  const claim = claimForExplorerGroup(
    { documentId: entry.documentId, displayName: entry.fileName },
    await listRecentDocs().catch(() => []),
  );
  if (!claim) return { kind: 'failed', reason: 'not-found' };
  return reopenLocatedFile(await locateRecoveryOriginal(claim), claim.documentId);
}

/**
 * 찾은 원본 파일에서 문서를 깨끗하게 다시 연다. 파일 열기와 같은 길로 연다 — 버전 기록을 함께 담은 .rhwpx
 * 묶음은 문서를 꺼내 열어야 한다.
 */
async function reopenLocatedFile(located: ProjectFileLocation, documentId: string): Promise<TrapOpenResult> {
  if (located.kind === 'owned-elsewhere') return { kind: 'failed', reason: 'blocked' };
  if (located.kind === 'permission-denied') return { kind: 'failed', reason: 'permission-denied' };
  if (located.kind === 'missing') return { kind: 'failed', reason: 'not-found' };
  const grant = { kind: 'verified' as const, documentId };
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

/** template 이 있으면 그 문서를 내용으로 하는 이름 없는 새 문서를 만든다(문서 홈의 템플릿). */
function createNewDocument(template?: Uint8Array, restoredDocumentId?: string): Promise<boolean> {
  if (engineTrap()) return Promise.resolve(false);
  return trackDocumentIo(() => createNewDocumentNow(template, restoredDocumentId));
}

async function createNewDocumentNow(template?: Uint8Array, restoredDocumentId?: string): Promise<boolean> {
  const msg = sbMessage();
  // 템플릿은 세션 상태를 건드리기 전에 읽는다. 읽지 못하면 지금 문서·작업 트리·점유가 그대로다.
  let prepared: PreparedWasmDocument | null = null;
  if (template) {
    try {
      prepared = wasm.prepareNewDocument(template);
    } catch (error) {
      console.warn('[main] 템플릿을 읽지 못했습니다:', error);
      showToast({ message: '이 템플릿을 문서로 읽지 못했습니다.', durationMs: 3200 });
      return false;
    }
  }
  const target = attachedSession;
  if (target.worktree) {
    if (target.worktreeWritable) await target.versions?.persistWorktree();
    worktreeOwnership.release(target);
    target.worktree = null;
    target.worktreeWritable = false;
  }
  const previousFileHandle = wasm.currentFileHandle;
  const identity = { documentId: restoredDocumentId ?? createActiveDocumentId(), sourceDigest: null };
  const slotId = attachedSession.slotId;
  const reservationId = await reserveDesktopDocument(identity, null, undefined, slotId);
  if (reservationId === null) {
    prepared?.dispose();
    throw new DocumentOwnedElsewhereError();
  }
  try {
    msg.textContent = '새 문서 생성 중...';
    assertStillAttached(target);
    inputHandler?.deactivate();
    const docInfo = wasm.createNewDocument(prepared ?? undefined);
    prepared = null;
    await commitDesktopDocument(reservationId, undefined, slotId);
    attachedSession.documentId = identity.documentId;
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
    prepared?.dispose();
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

async function canReplaceCurrentDocument(
  skipUnsavedGuard?: boolean,
  confirmOptions?: ConfirmSaveOptions,
): Promise<boolean> {
  // 저장 확인의 버리기는 지금 문서의 복구본을 지운다. 멈춘 엔진에는 바꿔 열 문서도 올릴 수 없다.
  if (refuseDocumentOpenWhileTrapped()) return false;
  if (agentEditingLease.active) {
    // 문서 없는 채팅에 문서를 잇는 중이면 바꿀 문서가 없다 — 그 채팅의 턴이 돌아도 연다.
    const linkingEmptySession = linkingSession === attachedSession && !attachedSession.wasm.hasLoadedDocument();
    if (!linkingEmptySession) {
      showToast({ message: '에이전트가 편집을 마친 뒤 문서를 바꿀 수 있습니다.', durationMs: 2600 });
      return false;
    }
  }
  const allowed = skipUnsavedGuard === true
    || await confirmSaveBeforeReplacingDocument(commandServices, confirmOptions);
  if (!allowed) return false;
  await attachedSession.versions?.whenIdle();
  return true;
}

/**
 * 홈·파일 메뉴의 열기를 새 세션(새 탭)에 할지. 문서가 열려 있으면 새 탭을 열 수 있는 한 새 탭에 연다. 문서 없는 채팅이 대화 중이면
 * 그 채팅도 뒤에 둔다 — 홈·파일 메뉴의 열기는 그 채팅에 문서를 잇지 않는다. 그 채팅에 이을 문서는 이 세션에 연다.
 */
function shouldOpenInNewSession(): boolean {
  return opensInNewSession(attachedSession, {
    linking: linkingSession === attachedSession,
    tabs: canOpenDocumentTab(),
    busy: isDocumentSessionBusy(attachedSession),
    managedWorktree: isManagedWorktree(),
  });
}

function openDocumentBytes(data: OpenDocumentBytesEvent): Promise<boolean> {
  if (refuseDocumentOpenWhileTrapped()) {
    void data.fileHandle?.releaseUnusedSaveTarget?.().catch(() => {});
    return Promise.resolve(false);
  }
  // 라이브러리 이동이 내보내는 열기는 그 이동의 일부라 줄을 서지 않는다. 문서 연결 중에 온 열기(밖에서 연 파일)는
  // 그 연결의 일부가 아니다 — 연결하는 세션에 끼어들지 않게 줄을 선다.
  return runNavigation(() => openDocumentBytesNow(data), {
    label: 'open-document',
    nested: opensNestedInNavigation({ navigationRunning, linking: linkingSession !== null }),
  });
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
    const options = payload as { skipUnsavedGuard?: boolean; requestId?: string; template?: Uint8Array } | undefined;
    const template = options?.template instanceof Uint8Array ? options.template : undefined;
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
          const outcome = await openInNewSession(() => {}, () => createNewDocument(template));
          return Boolean(outcome?.loaded && outcome.result);
        }
        if (!await canReplaceCurrentDocument(options?.skipUnsavedGuard)) return null;
        return createNewDocument(template);
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
  const notifyDone = (ok: boolean, error?: string, cancelled = false) => {
    if (!data.requestId) return;
    eventBus.emit('open-document-bytes:done', { requestId: data.requestId, ok, error, cancelled });
  };
  try {
    if (!await openDocumentBytes(data)) {
      notifyDone(false, '문서 열기가 취소되었습니다.', true);
      return;
    }
    notifyDone(true);
  } catch (error) {
    // #265: WASM 파서 에러 (예: HWP 3.0 미지원) 를 사용자에게 전파
    const ownedElsewhere = error instanceof DocumentOwnedElsewhereError;
    if (!ownedElsewhere) showLoadError(error);
    const msg = error instanceof Error ? error.message : String(error);
    notifyDone(false, msg, ownedElsewhere);
  }
});

// 수식 더블클릭 → 수식 편집 대화상자
eventBus.on('equation-edit-request', () => {
  dispatcher.dispatch('insert:equation-edit');
});

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
    report: true,
  });
}

/** 지금 문서의 채팅 브리지. 사이드바가 아직 없으면 null. */
function currentAgentBridge(): AgentBridge | null {
  return attachedSession.bridge ?? allChats()[0]?.bridge ?? null;
}

const initPromise = initialize();
// 실패해도 부트 화면을 걷어 오류 표시를 가리지 않는다.
void initPromise.then(markStudioReady, markStudioReady);
// 특별 이벤트(macOS 데스크톱만). 라이선스 확인과 편집기 준비가 끝나고 부트 화면이 걷힌 뒤 본다.
void initPromise.then(() => {
  const gift = desktopGiftApi();
  if (!gift) return;
  startSpecialEvent({
    gift,
    storage: localStorage,
    whenReady: afterBootScreen,
    isSetupActive: isInitialSetupActive,
    onSetupInactive: onInitialSetupInactive,
    occasion: () => (wasLicensedHere() ? 'license' : 'update'),
    // 내 키가 있으면 쓰는 순서도 고른다. 순서는 허브(Pi)가 저장한다.
    pi: {
      status: async () => (await currentAgentBridge()?.requestPiStatus()) ?? null,
      setGiftOrder: async (order) => {
        if (!(await currentAgentBridge()?.setPiGiftOrder(order))) throw new Error('Pi gift order was not saved.');
      },
    },
    open: async (options) => (await import('./ui/special-event/special-event-popup.ts')).openSpecialEventPopup(options),
  });
}, () => {});
// 자동 버그 수정 소개(데스크톱만). 처음 설정을 마치고 아직 답하지 않은 사람에게 한 번 묻는다.
void initPromise.then(() => {
  startAutofixIntro({ whenReady: afterBootScreen });
}, () => {});
