import { WasmBridge, installDeclaredFontAvailabilityProbe, type PreparedWasmDocument } from '@/core/wasm-bridge';
import { installDocumentTitle } from '@/ui/document-title';
import { FALLBACK_DOCUMENT_FILE_NAME } from '@/core/document-names';
import type { DocumentInfo } from '@/core/types';
import { EventBus } from '@/core/event-bus';
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
  runLibraryMove,
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
import { onEngineTrap } from '@/core/engine-trap';
import { ContextMenu } from '@/ui/context-menu';
import { CommandPalette } from '@/ui/command-palette';
import { showHmlImportWarning } from '@/ui/hml-import-warning';
import { showLocalFontsModalIfNeeded } from '@/ui/local-fonts-modal';
import { showToast } from '@/ui/toast';
import { resolveDocumentPreflight, type DocumentPreflightIdentity, type OpenDocumentBytesEvent, type VerifiedDocumentGrant } from '@/recent/document-preflight';
import { addRecentDoc, listRecentDocs } from '@/recent/recent-store';
import { showDropConfirmDialog } from '@/ui/drop-confirm-dialog';
import { initRhwpDev } from '@/core/rhwp-dev';
import { DocumentDirtyState } from '@/core/document-dirty-state';
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
import { AutosaveManager, type AutosaveScheduleSettings, type AutosaveStatus } from '@/recovery/autosave-manager';
import {
  clearRecoverableAutosaveDrafts,
  defaultAutosaveLocks,
  getAutosaveDraft,
  listRecoverableAutosaveDrafts,
  markAutosaveDraftsOffered,
  type AutosaveDraftSummary,
} from '@/recovery/autosave-store';
import { HostSaveTracker } from '@/recovery/host-save';
import { offerAutosaveRecovery, restoreAutosaveDraft } from '@/recovery/recovery-flow';
import { showAutosaveRecoveryDialog } from '@/recovery/recovery-ui';
import { isPinnedDocumentEnabled, startPinnedDocument } from '@/recovery/pinned-document';
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
  releaseReplacedNativeFileHandle,
  rememberNativeDocument,
  reserveDesktopDocument,
} from '@/desktop-integration';
import { initAgentBridge, type AgentBridge } from './agent/bridge.ts';
import { initAgentSidebar } from './ui/agent-sidebar/index.ts';
import { showEditingSettingsFallback } from './ui/agent-sidebar/settings-editing-fallback.ts';
import { AGENT_LABEL } from './ui/agent-sidebar/providers.ts';
import { initInlinePrompt } from './agent/inline-prompt.ts';
import { DocumentVersionController, persistActiveBranch } from './versioning/controller.ts';
import {
  VersionGraphStore,
  documentId as versionDocumentId,
  isPortableHistoryBytes,
  isPortableHistoryFileName,
  openPortableHistoryBundle,
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

const wasm = new WasmBridge();
installDocumentTitle(wasm);
const eventBus = new EventBus();
const documentState = new DocumentDirtyState(eventBus);
documentState.installBeforeUnload(window);
const rendererSessionContextPromise = getRendererSessionContext();
let disposeAgentSidebar = (): void => {};
const autosaveManager = new AutosaveManager({
  exportBytes: () => wasm.exportHwp(),
  schedule: autosaveScheduleFromUserSettings(),
  onStatus: handleAutosaveStatus,
  locks: defaultAutosaveLocks(),
});
void rendererSessionContextPromise.then((context) => {
  if (context) {
    autosaveManager.setOwner({ launchId: context.launchId, sessionId: context.sessionId });
  }
});
autosaveManager.connect(eventBus);
onEngineTrap(() => {
  // 멈춘 엔진이 아직 읽기는 받아 줄 때 지금 상태를 복구본으로 남긴다.
  void autosaveManager.flushNow('engine-trap');
  showToast({
    message: '문서 엔진이 멈춰 편집을 중단했습니다.\n사본을 저장한 뒤 앱을 다시 여세요.',
    durationMs: 0,
    action: { label: '사본 저장', onClick: saveTrappedDocumentCopy },
  });
});
window.addEventListener('pagehide', (event) => {
  if (!event.persisted) {
    disposeAgentSidebar();
    autosaveManager.dispose();
  }
});
initThemeSync((effective, mode) => {
  eventBus.emit('theme-changed', { mode, effective });
  eventBus.emit('command-state-changed');
});
initWindowActivity();
// 2.0.10까지 Cloud 채팅 초안(첨부 바이트 포함)을 담던 DB를 지운다. 없으면 아무 일도 하지 않는다.
try { indexedDB.deleteDatabase('hamaeditorCloudChatDrafts'); } catch { /* 저장소 접근 불가 */ }

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
const hostSave = new HostSaveTracker({
  documentState,
  setFileName: (fileName) => { wasm.fileName = fileName; },
  emitSaved: () => {
    eventBus.emit('document-context-changed');
    eventBus.emit('document-saved', {
      reason: 'host-save',
      fileName: wasm.fileName,
      sourceFormat: wasm.getSourceFormat(),
    });
  },
  discardDraft: (reason) => autosaveManager.discardCurrentDraft(reason),
});

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
/**
 * 현재 편집 세션의 논리 문서 ID. 파일명/Save As 대상과 분리되어 문서가 열린
 * 동안 유지되고, 재열기 시 recent-store가 handle/digest로 이전 ID를 복원한다.
 */
let activeDocumentId: string | null = null;

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
    isEditable: !documentReadOnly && !agentEditingLease.active && (!isFormMode || canEditFormField),
    readOnly: documentReadOnly,
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
  document.documentElement.dataset.documentReadOnly = readOnly ? 'true' : 'false';
  inputHandler?.setReadOnly(readOnly);
  toolbar?.setEnabled(wasm.pageCount > 0 && !readOnly && !agentEditingLease.active);
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
  toolbar?.setEnabled(wasm.pageCount > 0 && !documentReadOnly && !agentEditingLease.active);
  scheduleCharacterStatus();
  eventBus.emit('command-state-changed');
}

/** 렌더러 초기화 후에 생성되는 에이전트 브리지 — 저장 가드가 대기 편집을 조회한다. */
let agentBridgeRef: AgentBridge | null = null;
let versionControllerRef: DocumentVersionController | null = null;
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
  createPortableHistoryBundle: async () => {
    if (!versionControllerRef) throw new Error('버전 기록 서비스를 사용할 수 없습니다.');
    return versionControllerRef.createPortableHistoryBundle();
  },
  setEditMode,
  getPendingAgentEdits: () => {
    const pending = agentBridgeRef?.pendingEdits;
    if (!pending || !pending.hasPending()) return null;
    const sets = () => pending.getChangeSets().filter((set) => set.ops.length > 0);
    return {
      opCount: sets().reduce((sum, set) => sum + set.ops.length, 0),
      approveAll: () => sets().every((set) => pending.approve(set.id)),
      rejectAll: () => pending.rejectAll(),
    };
  },
};

installDesktopCloseHandling(async () => {
  const allowClose = await canReplaceCurrentDocument();
  if (allowClose) documentState.permitNextUnload();
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
const DESKTOP_FONT_EDIT_DEBOUNCE_MS = 600;
let desktopFontEditTimer: ReturnType<typeof setTimeout> | null = null;

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
function installHubFonts(bridge: AgentBridge): void {
  if (isDesktopFontsSupported()) return;
  setHubFontHost(createHubFontHost({ access: () => bridge.getHubFontAccess() }));
  bridge.onEvent((event) => {
    if (event.type === 'connection' && event.state === 'connected') connectPendingDocumentFonts();
  });
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

/** 편집·에이전트·붙여넣기로 새 글꼴이 문서에 들어오면 데스크톱 글꼴에서 찾아 연결한다. */
function scheduleDesktopFontSync(): void {
  if (!hasSystemFontHost()) return;
  if (desktopFontEditTimer !== null) clearTimeout(desktopFontEditTimer);
  desktopFontEditTimer = setTimeout(() => {
    desktopFontEditTimer = null;
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
  }, DESKTOP_FONT_EDIT_DEBOUNCE_MS);
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
      for (const name of ['document-context-changed', 'document-dirty-changed', 'document-saved']) {
        eventBus.on(name, update);
      }
    },
    hasDocument: () => wasm.hasLoadedDocument(),
    isDirty: () => documentState.isDirty(),
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
    );
    inputHandler.setEditMode(editMode);
    inputHandler.setReadOnly(documentReadOnly);
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
    });
    installDesktopGeneratedDocumentHandling(({ bytes, fileName, readOnly }) => {
      if (readOnly) setDocumentReadOnly(true);
      eventBus.emit('open-document-bytes', { bytes, fileName });
    });
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
    if (isPinnedDocumentEnabled()) void loadPinnedDocument();
    else void loadFromUrlParam();
    void offerAutosaveRecoveryAtStartup();
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

    // AI 페어 에디팅: rhwp-agent 허브 브리지 + 사이드바 (Phase 1)
    // 선택(opt-in) 기능이므로 여기서 실패해도 렌더러 초기화를 실패로 만들지 않는다.
    try {
      const agentBridge = initAgentBridge({
        wasm,
        eventBus,
        inputHandler,
        canvasView,
        documentState,
        isReadOnly: () => documentReadOnly,
        commitVersion: async (message) => {
          if (!versionControllerRef) throw new Error('Version history is not ready yet.');
          await versionControllerRef.checkpoint(message, { agentTurn: true });
        },
      });
      agentBridgeRef = agentBridge;
      installHubFonts(agentBridge);
      agentBridge.onEditingLeaseChange(setAgentEditingLease);
      installDesktopAgentAttention({
        onEvent: (cb) => agentBridge.onEvent(cb),
        onPendingChange: (cb) => agentBridge.pendingEdits.onChange(cb),
        pendingReviewCount: () => agentBridge.pendingEdits.getChangeSets()
          .filter((set) => set.ops.length > 0).length,
        documentTitle: () => (wasm.hasLoadedDocument() ? wasm.fileName : ''),
      });
      const versionController = new DocumentVersionController({
        wasm,
        eventBus,
        documentState,
        getInputHandler: () => inputHandler,
        getDocumentId: () => activeDocumentId,
        agentBridge,
        autoEnable: () => userSettings.getUseHancomGit(),
      });
      versionControllerRef = versionController;
      const agentSidebar = initAgentSidebar({
        bridge: agentBridge,
        eventBus,
        editorSettingsRuntime: {
          preview: applyEditorSettingsPreview,
          committed: commitEditorSettingsRuntime,
        },
        versionController,
        getAgentUndoEntry: () => inputHandler?.getAgentUndoEntry() ?? null,
        undoAgentTurn: (entry) => inputHandler?.undoAgentTurn(entry) ?? false,
        navigateToChange: (position, anchor) => {
          if (!inputHandler) return;
          if (anchor && position.cellIndex === undefined) {
            position = { ...position, cursorRect: { ...anchor } };
          }
          inputHandler.moveCursorTo(position);
        },
        openClassicVersionControl: () => openClassicDocumentHistory(commandServices),
        getDocumentContext: () => {
          const documentName = wasm.pageCount > 0 ? wasm.fileName : null;
          let selectionLabel: string | null = null;
          if (inputHandler?.getSelectedPictureRef()) {
            selectionLabel = '개체 선택됨';
          } else if (inputHandler?.hasSelection()) {
            selectionLabel = '텍스트 선택됨';
          }
          return {
            documentId: activeDocumentId,
            documentName,
            selectionLabel,
            pageCount: wasm.pageCount,
          };
        },
        moveToLibraryDocument: async (target) => {
          await runLibraryMove(commandServices, target, () => activeDocumentId);
        },
      });
      disposeAgentSidebar = () => {
        agentSidebar.dispose();
        disposeAgentSidebar = () => {};
      };
      agentSidebarReady = true;
      initInlinePrompt({
        wasm,
        eventBus,
        inputHandler,
        canvasView,
        bridge: agentBridge,
        submit: agentSidebar.sendInlinePrompt,
      });
      if (import.meta.env.DEV) {
        (window as any).__agentBridge = agentBridge;
        (window as any).__versionController = versionController;
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
    if (agentEditingLease.active) {
      showToast({ message: '에이전트가 편집을 마친 뒤 파일을 놓을 수 있습니다.', durationMs: 2600 });
      return;
    }
    const dropName = file.name.toLowerCase();
    const imageExts = ['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp'];
    const isImage = imageExts.some(ext => dropName.endsWith(ext));
    const isDoc = isSupportedDocumentFileName(dropName);
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

  eventBus.on('document-mutated', (reason) => {
    documentState.markDirty(typeof reason === 'string' ? reason : 'document-mutated');
    schedulePaperStatus();
    scheduleCharacterRecount();
  });

  eventBus.on('document-changed', (reason) => {
    documentState.markDirty(typeof reason === 'string' ? reason : 'document-changed');
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
    };
    const documentId = activeDocumentId;
    const sourceDigest = wasm.documentDigest;
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
    autosaveManager.updateSchedule(autosaveScheduleFromUserSettings());
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

/** 문서 초기화 공통 시퀀스 (loadFile, createNewDocument 양쪽에서 사용) */
function applySavedTextMarkSettings(): void {
  applyEditorSettingsPreview(userSettings.getEditorScalarSettings());
}

async function initializeDocument(
  docInfo: DocumentInfo,
  options: { suppressDialogs?: boolean } = {},
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
    toolbar?.setEnabled(!documentReadOnly && !agentEditingLease.active);
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

    // #2527: 자동 보정을 하지 않으므로 로드 직후 문서는 항상 clean.
    documentState.markClean('document-initialized');
    try {
      await versionControllerRef?.documentLoaded();
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
    if (!await canReplaceCurrentDocument(options.skipUnsavedGuard)) return false;
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
  skipRecent = false,
  grant?: VerifiedDocumentGrant | null,
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
  const identity = skipRecent
    ? { ...resolved, documentId: createActiveDocumentId(), useSourceDigest: false }
    : resolved;
  const reservationId = await reserveDesktopDocument(identity, fileHandle);
  if (reservationId === null) throw new DocumentOwnedElsewhereError();
  return { identity, reservationId };
}

async function reserveSaveHandleForWrite(
  handle: FileSystemFileHandleLike,
): Promise<((saved: boolean) => Promise<void>) | void> {
  const currentHandle = wasm.currentFileHandle;
  const currentIdentity = activeDocumentId
    ? { documentId: activeDocumentId, sourceDigest: wasm.documentDigest, useSourceDigest: false }
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
    const reservationId = await reserveDesktopDocument(currentIdentity, handle);
    if (reservationId === null) throw new DocumentOwnedElsewhereError();
    if (!reservationId) return;
    return async (saved) => {
      if (saved) await commitDesktopDocument(reservationId);
      else await cancelDesktopDocument(reservationId);
    };
  }

  const target = await handle.getFile();
  const targetBytes = await readBlobBytesWithLimit(
    target,
    EXACT_LOCAL_DOCUMENT_MAX_BYTES,
    '저장 대상 문서',
  );
  const identity = await resolveDocumentPreflight(targetBytes, handle, await listRecentDocs());
  if (identity.documentId === activeDocumentId) return;

  const reservationId = await reserveDesktopDocument(identity, handle);
  if (reservationId === null) throw new DocumentOwnedElsewhereError();
  if (!reservationId) return;
  return () => cancelDesktopDocument(reservationId);
}

async function loadBytes(
  data: Uint8Array,
  fileName: string,
  fileHandle: typeof wasm.currentFileHandle,
  startTime = performance.now(),
  options: {
    dataReadProgressShown?: boolean;
    skipRecent?: boolean;
    suppressDialogs?: boolean;
    grant?: VerifiedDocumentGrant | null;
    preparedDocument?: PreparedWasmDocument;
    /** 복구한 draft 의 id. 새 id 대신 이 id 로 자동 저장해 복구본을 제자리에서 갱신한다. */
    autosaveDraftId?: string;
    /** fileHandle 이 가리키는 파일 전체 바이트. data 가 그 안의 문서일 때(RHWPX) 넘긴다. */
    nativeSourceBytes?: Uint8Array;
  } = {},
): Promise<void> {
  const ownership = await reserveDocumentOpen(
    data,
    fileHandle,
    options.skipRecent,
    options.grant,
  );
  const previousFileHandle = wasm.currentFileHandle;
  if (!options.dataReadProgressShown) {
    await updateLoadProgress(0, '문서 데이터 준비 중...');
  }
  await updateLoadProgress(25, '문서 파싱 및 쪽 계산 중...');
  let docInfo: DocumentInfo;
  try {
    inputHandler?.deactivate();
    docInfo = options.preparedDocument
      ? wasm.adoptPreparedDocument(options.preparedDocument)
      : consumeExactLocalFileRead(data, fileHandle)
        ? wasm.loadTrustedLocalFileOnce(data, fileName)
        : wasm.loadDocument(data, fileName);
    await commitDesktopDocument(ownership.reservationId);
    fileHandle?.adoptSaveTarget?.();
  } catch (error) {
    await cancelDesktopDocument(ownership.reservationId).catch(() => {});
    activeDocumentId = null;
    eventBus.emit('document-context-changed');
    await releaseDesktopDocument().catch(() => {});
    await releaseReplacedNativeFileHandle(previousFileHandle, null).catch(() => {});
    await autosaveManager.endDocument({ discardDraft: true, reason: 'failed-document-replacement' })
      .catch(() => {});
    throw error;
  }
  activeDocumentId = ownership.identity.documentId;
  bindNativeFileHandleIdentity(fileHandle, ownership.identity);
  await rememberNativeDocument(
    ownership.identity.documentId,
    fileHandle,
    ownership.identity.sourceDigest,
  )
    .catch((error) => console.warn('[desktop] native document bookmark failed:', error));
  // 같은 창에서 같은 파일을 다시 열면 핸들이 재사용된다. 방금 연 바이트를 저장 충돌 기준으로 삼는다.
  await adoptLoadedNativeFileContent(fileHandle, options.nativeSourceBytes ?? data)
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
  // 자동저장 복구본은 options.skipRecent 로 제외.
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

  await autosaveManager.beginDocument(
    {
      fileName: wasm.fileName,
      sourceFormat: wasm.getSourceFormat(),
      ...(options.autosaveDraftId ? { draftId: options.autosaveDraftId } : {}),
    },
    { discardPreviousDraft: true },
  );
  await updateLoadProgress(50, '문서 초기화 중...');
  const elapsed = performance.now() - startTime;
  console.debug(`[load] ${fileName}: ${docInfo.pageCount} pages in ${elapsed.toFixed(1)}ms`);
  await initializeDocument(docInfo, {
    suppressDialogs: options.suppressDialogs,
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
        suppressDialogs: true,
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
    });
  } catch (error) {
    console.warn('[autosave] 복구 후보 확인 실패:', error);
  }
}

function restoreAutosaveDraftIntoEditor(draft: AutosaveDraftSummary): Promise<void> {
  return restoreAutosaveDraft(draft, {
    readDraft: (id) => getAutosaveDraft(id),
    releaseCurrentDocument: () => {
      if (documentState.isDirty()) documentState.markClean('autosave-restore-replace');
    },
    load: (bytes, fileName, draftId) => loadBytes(bytes, fileName, null, performance.now(), {
      skipRecent: true,
      autosaveDraftId: draftId,
    }),
    markDirty: () => documentState.markDirty('autosave-recovered'),
    flush: () => autosaveManager.flushNow('autosave-recovered'),
    toast: (message, durationMs) => showToast({ message, durationMs }),
  });
}


async function createNewDocument(): Promise<boolean> {
  const msg = sbMessage();
  const previousFileHandle = wasm.currentFileHandle;
  const identity = { documentId: createActiveDocumentId(), sourceDigest: null };
  const reservationId = await reserveDesktopDocument(identity, null);
  if (reservationId === null) throw new DocumentOwnedElsewhereError();
  try {
    msg.textContent = '새 문서 생성 중...';
    inputHandler?.deactivate();
    const docInfo = wasm.createNewDocument();
    await commitDesktopDocument(reservationId);
    activeDocumentId = identity.documentId;
    hostSave.reset();
    await releaseReplacedNativeFileHandle(previousFileHandle, wasm.currentFileHandle)
      .catch((error) => console.warn('[desktop] 새 문서 전환 핸들 해제 실패:', error));
    prepareCanvasRendererDocument();
    await autosaveManager.beginDocument(
      { fileName: wasm.fileName, sourceFormat: wasm.getSourceFormat() },
      { discardPreviousDraft: true },
    );
    await initializeDocument(docInfo);
    return true;
  } catch (error) {
    await cancelDesktopDocument(reservationId).catch(() => {});
    activeDocumentId = null;
    eventBus.emit('document-context-changed');
    await releaseDesktopDocument().catch(() => {});
    await releaseReplacedNativeFileHandle(previousFileHandle, null).catch(() => {});
    await autosaveManager.endDocument({ discardDraft: true, reason: 'failed-new-document' })
      .catch(() => {});
    msg.textContent = `새 문서 생성 실패: ${error}`;
    console.error('[main] 새 문서 생성 실패:', error);
    return false;
  }
}

async function canReplaceCurrentDocument(skipUnsavedGuard?: boolean): Promise<boolean> {
  if (agentEditingLease.active) {
    showToast({ message: '에이전트가 편집을 마친 뒤 문서를 바꿀 수 있습니다.', durationMs: 2600 });
    return false;
  }
  const allowed = skipUnsavedGuard === true
    || await confirmSaveBeforeReplacingDocument(commandServices);
  if (!allowed) return false;
  await versionControllerRef?.whenIdle();
  return true;
}

async function openDocumentBytes(data: OpenDocumentBytesEvent) {
  if (!await canReplaceCurrentDocument(data.skipUnsavedGuard)) {
    await data.fileHandle?.releaseUnusedSaveTarget?.().catch(() => {});
    return false;
  }
  try {
    if (isPortableHistoryFileName(data.fileName) || isPortableHistoryBytes(data.bytes)) {
      const bundle = openPortableHistoryBundle(data.bytes);
      const store = new VersionGraphStore();
      const retainPortableHistoryHandle = Boolean(
        data.fileHandle
        && !isLegacyPortableHistoryFolderHandle(data.fileHandle)
        && isPortableHistoryFileName(data.fileName),
      );
      const openFileName = retainPortableHistoryHandle
        ? data.fileName
        : bundle.documentFileName;
      let importedRepository = false;
      let preparedDocument: PreparedWasmDocument | null = null;
      try {
        const imported = await store.importRepositorySnapshot(bundle.snapshot);
        importedRepository = imported.imported;
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
              documentId: bundle.snapshot.repository.documentId,
            },
            preparedDocument,
            nativeSourceBytes: data.bytes,
          },
        );
        persistActiveBranch(bundle.snapshot.repository.documentId, bundle.activeBranch);
        await versionControllerRef?.refresh().catch((error) => {
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
    try {
      if (!await canReplaceCurrentDocument(options?.skipUnsavedGuard)) {
        notify(false, '문서 생성이 취소되었습니다.');
        return;
      }
      const ok = await createNewDocument();
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
