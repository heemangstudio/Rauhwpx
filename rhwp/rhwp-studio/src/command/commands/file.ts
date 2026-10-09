import type { CommandDef, CommandServices } from '../types';
import { PageSetupDialog } from '@/ui/page-setup-dialog';
import { AboutDialog } from '@/ui/about-dialog';
import { showSaveAs } from '@/ui/save-as-dialog';
import { showUnsavedChangesDialog } from '@/ui/unsaved-changes-dialog';
import { showPendingAgentEditsDialog } from '@/ui/pending-agent-edits-dialog';
import { showHmlSaveFormatDialog } from '@/ui/hml-save-format-dialog';
import {
  fileNameForFormat,
  markConvertedHmlSaveHandle,
  requiresSaveFormatChoice,
  resolveSaveTarget,
  type SaveFormat,
} from '@/command/save-target';
import { SAVE_FORMAT_DETAILS } from '@/command/save-format';
import { exportDocumentForFormat } from '@/command/save-document-format';
import { SaveSession, type SaveOutcome } from '@/command/save-session';
import {
  readHmlSaveContext,
  resolveHmlSaveCapability,
} from '@/core/hml-save-capability';
import {
  appendPrintStyle,
  appendSvgPage,
  createPrintPage,
  pdfPrintTitle,
  printProgressText,
  printReadyText,
  type PrintFontResolver,
  type PrintIntent,
  type PrintPage,
} from '@/command/print-pages';
import { hasImportedLocalFontFace, resolveSessionLocalFont } from '@/core/local-fonts';
import {
  createPrintPreviewSurface,
  createPrintSurface,
  mirrorDocumentFonts,
  PrintPreviewBlockedError,
  PrintSurfaceClosedError,
  waitForPrintSurfaceReady,
  type PrintPreviewSurface,
  type PrintSurface,
} from '@/command/print-surface';
import {
  canUseOpenFilePicker,
  pickOpenFileHandle,
  pickReadableBrowserDocument,
  readFileFromHandle,
  saveDocumentToFileSystem,
  writeBlobToHandle,
  type FileSystemDirectoryHandleLike,
  type FileSystemFileHandleLike,
  type SaveDocumentResult,
  type FileSystemWindowLike,
} from '@/command/file-system-access';
import { PdfPrintDialog } from '@/ui/pdf-print-dialog';
import { userSettings } from '@/core/user-settings';
import { showToast } from '@/ui/toast';
import { clearRecentDocs, listRecentDocs, removeRecentDoc } from '@/recent/recent-store';
import { documentSourceDigest } from '@/recent/document-preflight';
import { claimForRecentDoc } from '@/project-file/claim';
import {
  locateProjectFile,
  openProjectFile,
  type ProjectFileDeps,
  type ProjectFileLocation,
} from '@/project-file/open';
import type { ProjectFileClaim } from '@/project-file/identity';
import {
  claimNativeProbe,
  isDesktopApp,
  pickDesktopLegacyHistoryFolder,
  pickDesktopNativeProjectFile,
  pickDesktopPortableHistorySaveFile,
  readNativeProbe,
  restoreNativeDocument,
  searchNearbyNativeDocuments,
  verifyNativePick,
  type DesktopHost,
  type RhwpDesktopApi,
} from '@/desktop-integration';
import {
  moveToLibraryDocument,
  saveAndCommitBeforeLeaving,
  type LibraryDocumentTarget,
  type LibraryMoveResult,
  type MoveToLibraryDocumentDeps,
} from '@/library/move-to-document';
import {
  isPortableHistoryFileName,
  PORTABLE_HISTORY_FOLDER_HISTORY_NAME,
  PORTABLE_HISTORY_MAX_BYTES,
  PORTABLE_HISTORY_MIME_TYPE,
} from '@/versioning/portable-bundle';

/**
 * 문서 열기를 요청하고 다 열릴 때까지 기다린다. 기다리지 않으면 호출부가 "아직 열리지 않음"을
 * 실패로 보고 되돌린 사이에 열기가 끝나, 엉뚱한 문서 세션에 문서가 들어간다.
 */
function openDocumentBytesAndWait(
  services: CommandServices,
  payload: Record<string, unknown>,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const requestId = `open-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const off = services.eventBus.on('open-document-bytes:done', (done) => {
      const result = done as { requestId?: string; ok?: boolean } | undefined;
      if (result?.requestId !== requestId) return;
      off();
      resolve(result.ok === true);
    });
    services.eventBus.emit('open-document-bytes', { ...payload, requestId });
  });
}

async function openFileViaPicker(services: CommandServices): Promise<void> {
  let handle: FileSystemFileHandleLike | null | undefined;
  try {
    // 에이전트가 일하는 문서는 바꾸지 않고 뒤에 남기므로 지금은 저장을 묻지 않는다. 묻지 않았다면
    // 파일을 고르는 사이 에이전트가 끝나 지금 문서를 바꾸게 될 때 그 자리에서 다시 묻는다.
    const askedToSave = !services.opensDocumentsInNewSession?.();
    if (askedToSave) {
      const canReplace = await confirmSaveBeforeReplacingDocument(services);
      if (!canReplace) return;
    }

    const windowLike = window as FileSystemWindowLike;
    const desktopHandle = await services.pickOpenHandle?.();
    handle = desktopHandle;
    const selected = desktopHandle === undefined
      ? await pickReadableBrowserDocument(windowLike)
      : desktopHandle === null
        ? null
        : { ...await readFileFromHandle(desktopHandle), handle: desktopHandle };
    if (selected === null) return;
    if (selected === undefined) {
      const fileInput = document.getElementById('file-input') as HTMLInputElement | null;
      if (fileInput) {
        if (askedToSave) fileInput.dataset.skipUnsavedGuard = 'true';
        else delete fileInput.dataset.skipUnsavedGuard;
        fileInput.click();
      }
      return;
    }

    const { bytes, name } = selected;
    handle = selected.handle;
    await openDocumentBytesAndWait(services, {
      bytes,
      fileName: name,
      fileHandle: handle,
      skipUnsavedGuard: askedToSave,
    });
  } catch (err) {
    await handle?.releaseUnusedSaveTarget?.().catch(() => {});
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[file:open] 열기 실패:', msg);
    alert(`파일 열기에 실패했습니다:\n${msg}`);
  }
}

async function importLegacyHistoryFolder(services: CommandServices): Promise<void> {
  let handle: FileSystemFileHandleLike | null | undefined;
  try {
    const askedToSave = !services.opensDocumentsInNewSession?.();
    if (askedToSave && !await confirmSaveBeforeReplacingDocument(services)) return;
    handle = await pickDesktopLegacyHistoryFolder();
    if (handle === null) return;

    if (handle) {
      const { bytes, name } = await readFileFromHandle(handle);
      await openDocumentBytesAndWait(services, {
        bytes,
        fileName: name,
        fileHandle: handle,
        skipUnsavedGuard: askedToSave,
      });
      return;
    }

    const windowLike = window as FileSystemWindowLike;
    if (!windowLike.showDirectoryPicker) {
      showToast({
        message: '이 환경에서는 이전 기록 폴더를 선택할 수 없습니다.',
        durationMs: 3500,
      });
      return;
    }
    let directory: FileSystemDirectoryHandleLike;
    try {
      directory = await windowLike.showDirectoryPicker({
        id: 'rhwpx-legacy-history-import',
        mode: 'read',
      });
    } catch (error) {
      if (isUserCancelError(error)) return;
      throw error;
    }
    if (!isPortableHistoryFileName(directory.name)) {
      throw new Error('.rhwpx 확장자를 가진 이전 기록 폴더를 선택해야 합니다.');
    }
    const historyHandle = await directory.getFileHandle(PORTABLE_HISTORY_FOLDER_HISTORY_NAME);
    const historyFile = await historyHandle.getFile();
    if (historyFile.size <= 0 || historyFile.size > PORTABLE_HISTORY_MAX_BYTES) {
      throw new Error('이전 기록 파일이 비어 있거나 128 MiB 한도를 초과했습니다.');
    }
    const bytes = new Uint8Array(await historyFile.arrayBuffer());
    if (bytes.byteLength !== historyFile.size) {
      throw new Error('읽는 동안 이전 기록 파일이 변경되었습니다.');
    }
    await openDocumentBytesAndWait(services, {
      bytes,
      fileName: directory.name,
      skipUnsavedGuard: askedToSave,
    });
  } catch (error) {
    await handle?.releaseUnusedSaveTarget?.().catch(() => {});
    const message = error instanceof Error ? error.message : String(error);
    console.error('[file:import-legacy-history] 가져오기 실패:', message);
    alert(`이전 기록 폴더를 가져오지 못했습니다:\n${message}`);
  }
}

/** 최근 문서 핸들의 읽기 권한을 확인/요청한다. 최종 'granted' 여부 반환. */
async function ensureReadPermission(handle: FileSystemFileHandleLike): Promise<boolean> {
  try {
    if (typeof handle.queryPermission === 'function') {
      if ((await handle.queryPermission({ mode: 'read' })) === 'granted') return true;
    }
    if (typeof handle.requestPermission === 'function') {
      return (await handle.requestPermission({ mode: 'read' })) === 'granted';
    }
    // 권한 API 미지원 브라우저 → getFile() 시도로 위임(여기선 통과).
    return true;
  } catch {
    return false;
  }
}

/** [Task #833] 사용자 명시 cancel 에러 검출.
 * - AbortError: showSaveFilePicker / showOpenFilePicker 다이얼로그 취소
 * - NotAllowedError: writeBlobToHandle 권한 거부 (Chrome "변경사항 저장" 프롬프트 취소)
 *
 * 두 케이스 모두 fallback download 우회 — 사용자가 명시적으로 취소했으므로
 * 의도하지 않은 Downloads 폴더 저장 + chrome-extension viewer 자동 연결 차단. */
function isUserCancelError(e: unknown): boolean {
  return e instanceof DOMException
      && (e.name === 'AbortError' || e.name === 'NotAllowedError');
}

function saveBaseNameFor(fileName: string, format: SaveFormat): string {
  return fileNameForFormat(fileName, format).replace(/\.(hwp|hwpx|hml)$/i, '');
}

function flushDeferredPaginationBeforeExplicitOutput(
  services: CommandServices,
  reason: string,
): void {
  const inputHandler = services.getInputHandler();
  if (!inputHandler) return;
  inputHandler.flushDeferredPaginationIfNeeded(reason);
  if (inputHandler.hasDeferredPaginationPending()) {
    throw new Error(`출력 전 페이지네이션을 완료하지 못했습니다 (${reason})`);
  }
}

async function chooseSaveAsFormat(services: CommandServices): Promise<SaveFormat | null> {
  const sourceFormat = services.wasm.getSourceFormat();
  if (sourceFormat === 'hml') {
    const context = getHmlSaveContext(services);
    return showHmlSaveFormatDialog(
      context.metadata,
      context.exporterAvailable,
    );
  }
  return resolveSaveTarget(
    sourceFormat,
    services.wasm.fileName,
    services.wasm.currentFileHandle,
  ).format;
}

function createSaveBlob(services: CommandServices, format: SaveFormat): Blob {
  const bytes = exportDocumentForFormat(services.wasm, format);
  return new Blob([bytes as unknown as BlobPart], {
    type: SAVE_FORMAT_DETAILS[format].mimeType,
  });
}

function isHmlSaveEnabled(services: CommandServices): boolean {
  const context = getHmlSaveContext(services);
  return resolveHmlSaveCapability(
    context.metadata,
    context.exporterAvailable,
  ).hmlEnabled;
}

function getHmlSaveContext(services: CommandServices) {
  return readHmlSaveContext(
    () => services.wasm.getHmlOpenMetadata(),
    () => services.wasm.hasHmlExportCapability(),
  );
}

async function tryFileSystemSave(
  services: CommandServices,
  format: SaveFormat,
  blob: Blob,
  suggestedName: string,
  forceSaveAs: boolean,
  currentHandle: FileSystemFileHandleLike | null,
  retainHandle = true,
): Promise<SaveDocumentResult | 'cancelled'> {
  try {
    return await saveDocumentToFileSystem({
      blob,
      suggestedName,
      currentHandle,
      windowLike: window as FileSystemWindowLike,
      forceSaveAs,
      saveFormat: format,
      pickSaveHandle: services.pickSaveHandle,
      validateTarget: services.validateSaveHandle,
      retainHandle,
    });
  } catch (error) {
    if (isUserCancelError(error)) return 'cancelled';
    throw error;
  }
}

function completeHandleSave(
  services: CommandServices,
  sourceFormat: string,
  savedFormat: SaveFormat,
  result: SaveDocumentResult,
  reason: 'save' | 'save-as',
  revision: number,
  saved: SavedFileContent | null,
): void {
  if (sourceFormat === 'hml') markConvertedHmlSaveHandle(result.handle);
  const previousFileHandle = services.wasm.currentFileHandle;
  services.wasm.currentFileHandle = result.handle;
  services.wasm.fileName = result.fileName;
  // 쓰는 동안 들어온 편집은 파일에 없다. 그 편집이 있으면 dirty 를 유지한다.
  services.documentState.markCleanIfUnchanged(revision, reason);
  services.eventBus.emit('document-context-changed');
  services.eventBus.emit('document-saved', {
    reason,
    fileName: result.fileName,
    sourceFormat: savedFormat,
  });
  if (result.handle) {
    // Handle-backed saves can be reopened across browser sessions. Keep this event
    // deliberately limited to the durable handle/name association; fallback downloads
    // have no handle and remain session-only.
    services.eventBus.emit('document-file-handle-saved', {
      fileHandle: result.handle,
      previousFileHandle,
      fileName: result.fileName,
      sourceFormat: savedFormat,
      // 파일에 실제로 쓴 내용의 digest. 최근 문서·북마크가 지금 파일을 알아보게 한다.
      savedDigest: saved?.digest ?? null,
      // 자동 저장은 이 바이트를 새 복구 기준으로 삼는다.
      savedBytes: saved?.bytes ?? null,
    });
  }
}

interface SavedFileContent {
  bytes: Uint8Array;
  digest: string;
}

/** 저장한 바이트와 digest. 읽지 못해도 저장은 이미 끝났으므로 null 로 넘긴다. */
async function savedBlobContent(blob: Blob): Promise<SavedFileContent | null> {
  try {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    return { bytes, digest: documentSourceDigest(bytes) };
  } catch (error) {
    console.warn('[save] 저장한 내용의 digest 를 계산하지 못했습니다:', error);
    return null;
  }
}

function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function promptFallbackName(
  suggestedName: string,
  format: SaveFormat,
): Promise<string | null> {
  const result = await showSaveAs(saveBaseNameFor(suggestedName, format), format);
  return result ? fileNameForFormat(result, format) : null;
}

/**
 * 검토 대기 중인 에이전트 편집이 있으면 저장 전에 수락/거절을 결정하게 한다.
 * 대기 편집은 라이브 미리보기로 이미 문서에 반영돼 있어, 그냥 저장하면 승인하지
 * 않은 변경이 파일에 담기기 때문이다. true = 저장 계속, false = 저장 취소.
 */
async function resolvePendingAgentEditsBeforeSave(services: CommandServices): Promise<boolean> {
  const pending = services.getPendingAgentEdits?.();
  if (!pending || pending.opCount === 0) return true;
  const choice = await showPendingAgentEditsDialog(pending.opCount);
  if (choice === 'cancel') return false;
  if (choice === 'approve') {
    if (!pending.approveAll()) {
      alert('일부 변경을 수락하지 못했습니다. 검토 패널에서 남은 변경을 처리한 뒤 다시 저장하세요.');
      return false;
    }
    return true;
  }
  pending.rejectAll();
  return true;
}

async function saveAsFormat(services: CommandServices, format: SaveFormat): Promise<SaveOutcome> {
  try {
    assertCanSaveDocument(services);
    if (!await resolvePendingAgentEditsBeforeSave(services)) return 'cancelled';
    assertCanSaveDocument(services);
    flushDeferredPaginationBeforeExplicitOutput(services, 'save-as');
    const managed = services.isManagedWorktree?.() === true;
    if (managed) {
      if (!services.persistManagedWorktree) throw new Error('작업 사본 저장 서비스를 사용할 수 없습니다.');
      await services.persistManagedWorktree();
    }
    const sourceFormat = services.wasm.getSourceFormat();
    const saveName = fileNameForFormat(services.wasm.fileName, format);
    const revision = services.documentState.captureRevision();
    const blob = createSaveBlob(services, format);
    const originalHandle = !managed && sourceFormat === 'hml' ? services.wasm.currentFileHandle : null;
    const result = await tryFileSystemSave(
      services,
      format,
      blob,
      saveName,
      true,
      originalHandle,
      !managed,
    );
    if (result === 'cancelled') return 'cancelled';
    if (result.method !== 'fallback') {
      if (managed) return 'saved';
      completeHandleSave(services, sourceFormat, format, result, 'save-as', revision, await savedBlobContent(blob));
      return 'saved';
    }
    const downloadName = await promptFallbackName(saveName, format);
    if (!downloadName) return 'cancelled';
    downloadBlob(blob, downloadName);
    if (managed) return 'saved';
    services.wasm.fileName = downloadName;
    services.documentState.markCleanIfUnchanged(revision, 'save-as');
    services.eventBus.emit('document-context-changed');
    services.eventBus.emit('document-saved', {
      reason: 'save-as',
      fileName: downloadName,
      sourceFormat: format,
    });
    return 'saved';
  } catch (error) {
    reportSaveError('file:save-as', error);
    return 'failed';
  }
}

async function saveWithHistory(services: CommandServices): Promise<SaveCurrentDocumentResult> {
  try {
    assertCanSaveDocument(services);
    if (!await resolvePendingAgentEditsBeforeSave(services)) return 'cancelled';
    assertCanSaveDocument(services);
    flushDeferredPaginationBeforeExplicitOutput(services, 'save-with-history');
    const managed = services.isManagedWorktree?.() === true;
    if (managed) {
      if (!services.persistManagedWorktree) throw new Error('작업 사본 저장 서비스를 사용할 수 없습니다.');
      await services.persistManagedWorktree();
    }
    if (!services.createPortableHistoryBundle) {
      throw new Error('버전 기록 서비스를 사용할 수 없습니다.');
    }

    const revision = services.documentState.captureRevision();
    const archive = await services.createPortableHistoryBundle();
    const currentHandle = managed ? null : services.wasm.currentFileHandle;
    const historyBlob = new Blob([archive.bytes as unknown as BlobPart], {
      type: PORTABLE_HISTORY_MIME_TYPE,
    });
    if (
      currentHandle
      && isPortableHistoryFileName(currentHandle.name)
    ) {
      await writeBlobToHandle(currentHandle, historyBlob, services.validateSaveHandle);
      completePortableHistorySave(
        services, currentHandle, currentHandle.name, revision, (await savedBlobContent(historyBlob))?.bytes ?? null,
      );
      return 'saved';
    }

    const windowLike = window as FileSystemWindowLike;
    let targetHandle = await pickDesktopPortableHistorySaveFile(archive);
    if (targetHandle === null) return 'cancelled';
    if (!targetHandle && windowLike.showSaveFilePicker) {
      try {
        targetHandle = await windowLike.showSaveFilePicker({
          excludeAcceptAllOption: true,
          suggestedName: archive.fileName,
          types: [{
            description: 'HamaEditor 기록 파일',
            accept: { [PORTABLE_HISTORY_MIME_TYPE]: ['.rhwpx'] },
          }],
        });
      } catch (error) {
        if (isUserCancelError(error)) return 'cancelled';
        throw error;
      }
    }

    if (targetHandle) {
      if (!isPortableHistoryFileName(targetHandle.name)) {
        await targetHandle.releaseUnusedSaveTarget?.().catch(() => {});
        throw new Error('.rhwpx 확장자를 가진 기록 파일을 선택해야 합니다.');
      }
      await writeBlobToHandle(targetHandle, historyBlob, services.validateSaveHandle, !managed);
      if (!managed) {
        completePortableHistorySave(
          services, targetHandle, targetHandle.name, revision, (await savedBlobContent(historyBlob))?.bytes ?? null,
        );
      }
      return 'saved';
    }

    downloadBlob(historyBlob, archive.fileName);
    showToast({ message: '문서와 전체 버전 기록을 저장했습니다.', durationMs: 3000 });
    return 'saved';
  } catch (error) {
    reportSaveError('file:save-with-history', error);
    return 'failed';
  }
}

function completePortableHistorySave(
  services: CommandServices,
  handle: FileSystemFileHandleLike,
  fileName: string,
  revision: number,
  savedBytes: Uint8Array | null,
): void {
  const previousFileHandle = services.wasm.currentFileHandle;
  services.wasm.currentFileHandle = handle;
  services.wasm.fileName = fileName;
  services.documentState.markCleanIfUnchanged(revision, 'save-with-history');
  services.eventBus.emit('document-context-changed');
  services.eventBus.emit('document-saved', {
    reason: 'save-with-history',
    fileName,
    sourceFormat: services.wasm.getSourceFormat(),
  });
  services.eventBus.emit('document-file-handle-saved', {
    fileHandle: handle,
    previousFileHandle,
    fileName,
    sourceFormat: services.wasm.getSourceFormat(),
    savedBytes,
  });
  showToast({ message: '문서와 전체 버전 기록을 저장했습니다.', durationMs: 3000 });
}

function reportSaveError(scope: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[${scope}] 저장 실패:`, message);
  alert(`파일 저장에 실패했습니다:\n${message}`);
}

function assertCanSaveDocument(services: CommandServices): void {
  if (services.canSaveDocument?.() === false) {
    throw new Error('읽기 전용 문서는 저장할 수 없습니다. 편집 중인 창에서 저장하세요.');
  }
}

export type SaveCurrentDocumentResult = SaveOutcome;

/** 저장은 한 번에 하나만 실행한다 (겹친 쓰기가 오래된 바이트로 최신 저장을 덮지 않도록). */
const saveSession = new SaveSession();

/**
 * 현재 문서를 저장한다. 진행 중인 저장이 있으면 그 결과를 기다리고, 그사이 편집이
 * 들어와 여전히 dirty 일 때만 한 번 더 저장한다.
 */
/** 진행 중인 저장이 모두 끝날 때까지 기다린다. 저장 도중 다른 문서로 넘어가지 않게 한다. */
export function whenSavesIdle(): Promise<void> {
  return saveSession.whenIdle();
}

export function saveCurrentDocument(services: CommandServices): Promise<SaveCurrentDocumentResult> {
  return saveSession.save(
    () => runSaveCurrentDocument(services),
    () => services.documentState.isDirty(),
  );
}

/** 대화상자가 필요한 저장은 다른 저장이 진행 중이면 실행하지 않는다. */
async function runExclusiveSave(run: () => Promise<SaveOutcome>): Promise<void> {
  const outcome = await saveSession.exclusive(run);
  if (outcome === 'busy') showToast({ message: '저장 중입니다.', durationMs: 2000 });
}

async function runSaveCurrentDocument(services: CommandServices): Promise<SaveCurrentDocumentResult> {
  try {
    assertCanSaveDocument(services);
    if (!await resolvePendingAgentEditsBeforeSave(services)) return 'cancelled';
    assertCanSaveDocument(services);
    flushDeferredPaginationBeforeExplicitOutput(services, 'save');
    if (await services.saveManagedWorktree?.()) return 'saved';
    if (services.isManagedWorktree?.()) throw new Error('작업 사본을 저장하지 못했습니다.');
    if (
      isPortableHistoryFileName(services.wasm.fileName)
      || isPortableHistoryFileName(services.wasm.currentFileHandle?.name ?? '')
    ) {
      return saveWithHistory(services);
    }
    const sourceFormat = services.wasm.getSourceFormat();
    let target = resolveSaveTarget(
      sourceFormat,
      services.wasm.fileName,
      services.wasm.currentFileHandle,
    );
    const hmlEnabled = target.format !== 'hml' || isHmlSaveEnabled(services);
    if (requiresSaveFormatChoice(target, hmlEnabled)) {
      const format = await chooseSaveAsFormat(services);
      if (format === null) return 'cancelled';
      target = {
        ...target,
        format,
        forceSaveAs: target.forceSaveAs || format !== target.format,
        suggestedName: fileNameForFormat(services.wasm.fileName, format),
      };
    }
    const revision = services.documentState.captureRevision();
    const blob = createSaveBlob(services, target.format);
    const result = await tryFileSystemSave(
      services,
      target.format,
      blob,
      target.suggestedName,
      target.forceSaveAs,
      services.wasm.currentFileHandle,
    );
    if (result === 'cancelled') return 'cancelled';
    if (result.method !== 'fallback') {
      completeHandleSave(
        services, sourceFormat, target.format, result, 'save', revision, await savedBlobContent(blob),
      );
      return 'saved';
    }
    const downloadName = await fallbackNameForCurrentSave(services, target);
    if (!downloadName) return 'cancelled';
    downloadBlob(blob, downloadName);
    services.documentState.markCleanIfUnchanged(revision, 'save');
    services.eventBus.emit('document-context-changed');
    services.eventBus.emit('document-saved', {
      reason: 'save',
      fileName: downloadName,
      sourceFormat: target.format,
    });
    return 'saved';
  } catch (error) {
    reportSaveError('file:save', error);
    return 'failed';
  }
}

async function fallbackNameForCurrentSave(
  services: CommandServices,
  target: ReturnType<typeof resolveSaveTarget>,
): Promise<string | null> {
  if (!services.wasm.isNewDocument && !target.forceSaveAs) return target.suggestedName;
  const downloadName = await promptFallbackName(target.suggestedName, target.format);
  if (!downloadName) return null;
  services.wasm.fileName = downloadName;
  if (target.forceSaveAs) services.wasm.currentFileHandle = null;
  return downloadName;
}

export async function confirmSaveBeforeReplacingDocument(
  services: CommandServices,
): Promise<boolean> {
  // 저장하는 동안 들어온 편집이 있으면 문서가 dirty 로 남는다. 그 편집을 버리지 않도록 다시 묻는다.
  for (;;) {
    const ctx = services.getContext();
    if (!ctx.hasDocument || !ctx.isDirty) return true;

    const choice = await showUnsavedChangesDialog({
      fileName: services.wasm.fileName,
      canSave: true, // HWPX 직접 저장 활성화로 모든 출처 저장 가능
    });

    if (choice === 'cancel') return false;
    if (choice === 'discard') return true;

    const result = await saveCurrentDocument(services);
    if (result !== 'saved') return false;
  }
}

/** 파일을 찾고 읽는 데만 쓰는 의존성. 문서를 열거나 사용자에게 묻지 않는다. */
function projectFileLookupDeps(
  claim: ProjectFileClaim,
): Omit<ProjectFileDeps, 'loadBound' | 'pickForProject' | 'forgetRecent' | 'toast'> {
  return {
    ensurePermission: ensureReadPermission,
    readHandle: readFileFromHandle,
    digestOf: documentSourceDigest,
    reopenRemembered: (documentId) => restoreNativeDocument(documentId),
    searchNearby: async (query) => searchNearbyNativeDocuments(query.documentId, {
      basenameHint: query.basenameHint,
    }),
    readProbe: async (probeId) => {
      const read = await readNativeProbe(probeId);
      if (!read) throw new Error('Native probe expired');
      return read;
    },
    claimProbe: (probeId) => claimNativeProbe(probeId),
    locationOf: async (handle, documentId) => {
      if (!isDesktopApp()) return 'unknown';
      return await verifyNativePick(documentId, handle) ? 'remembered' : 'not-remembered';
    },
  };
}

function projectFileDeps(
  services: CommandServices,
  claim: ProjectFileClaim,
  { skipUnsavedGuard = false } = {},
): ProjectFileDeps {
  return {
    ...projectFileLookupDeps(claim),
    // 문서가 다 열린 뒤에 돌아온다. 호출부가 결과 문서를 바로 다룰 수 있어야 한다.
    loadBound: async (bytes, name, handle, documentId) => {
      await openDocumentBytesAndWait(services, {
        bytes,
        fileName: name,
        fileHandle: handle,
        ...(skipUnsavedGuard ? { skipUnsavedGuard: true } : {}),
        grant: { kind: 'verified', documentId },
      });
    },
    pickForProject: async (displayName) => {
      const desktop = await pickDesktopNativeProjectFile({
        suggestedName: displayName,
        documentId: claim.documentId,
      });
      if (desktop !== undefined) return desktop;
      const windowLike = window as FileSystemWindowLike;
      if (!canUseOpenFilePicker(windowLike)) {
        showToast({
          message: '이 브라우저에서는 파일을 선택하는 대화상자를 열 수 없습니다.',
          durationMs: 4000,
        });
        return null;
      }
      return pickOpenFileHandle(windowLike);
    },
    forgetRecent: removeRecentDoc,
    toast: (message, durationMs) => showToast({ message, durationMs }),
  };
}

/** 자동 저장본을 복구할 때 원본 파일을 찾는다. 파일 선택 창은 띄우지 않고 최근 목록도 바꾸지 않는다. */
export function locateRecoveryOriginal(claim: ProjectFileClaim): Promise<ProjectFileLocation> {
  return locateProjectFile(claim, projectFileLookupDeps(claim));
}

function libraryMoveDeps(
  services: CommandServices,
  getActiveDocumentId: () => string | null,
  commitCurrent?: () => Promise<void>,
): MoveToLibraryDocumentDeps {
  return {
    getCurrent: () => ({
      documentId: getActiveDocumentId(),
      fileName: services.getContext().hasDocument ? services.wasm.fileName : null,
      hasDocument: services.getContext().hasDocument,
      // 검토 대기 편집은 저장 경로에서 수락/거절을 물어야 하므로 바뀐 내용으로 친다.
      isDirty: services.documentState.isDirty()
        || (services.getPendingAgentEdits?.()?.opCount ?? 0) > 0,
    }),
    saveCurrent: () => saveCurrentDocument(services),
    listRecent: listRecentDocs,
    openProjectFile: (claim) => openProjectFile(claim, projectFileDeps(services, claim, {
      skipUnsavedGuard: true,
    })),
    openViaPicker: () => openFileViaPicker(services),
    toast: (message) => showToast({ message, durationMs: 3500 }),
    commitCurrent,
  };
}

/** commitCurrent 를 넘기면 저장한 뒤 대상 문서를 열기 전에 버전 기록 커밋을 남긴다. */
export async function runLibraryMove(
  services: CommandServices,
  target: LibraryDocumentTarget,
  getActiveDocumentId: () => string | null,
  commitCurrent?: () => Promise<void>,
): Promise<LibraryMoveResult> {
  return moveToLibraryDocument(
    target,
    libraryMoveDeps(services, getActiveDocumentId, commitCurrent),
    { commit: commitCurrent !== undefined },
  );
}

/** 이미 열린 다른 문서 세션으로 넘어가기 전에 현재 문서를 저장하고 커밋한다. */
export function runSaveBeforeLeaving(
  services: CommandServices,
  getActiveDocumentId: () => string | null,
  commitCurrent?: () => Promise<void>,
): Promise<'ok' | 'cancelled' | 'failed'> {
  return saveAndCommitBeforeLeaving(
    libraryMoveDeps(services, getActiveDocumentId, commitCurrent),
    { commit: commitCurrent !== undefined },
  );
}

function setupPrintDocument(
  doc: Document,
  fileName: string,
  printPages: PrintPage[],
  previewWindow: Window | null = null,
): void {
  doc.documentElement.lang = 'ko';

  doc.head.replaceChildren();
  const meta = doc.createElement('meta');
  meta.setAttribute('charset', 'UTF-8');
  const viewport = doc.createElement('meta');
  viewport.name = 'viewport';
  viewport.content = 'width=device-width, initial-scale=1.0';
  doc.head.append(meta, viewport);
  doc.title = previewWindow
    ? `${fileName} — 인쇄 미리보기`
    : pdfPrintTitle(fileName);
  appendPrintStyle(doc, printPages);

  doc.body.replaceChildren();
  doc.body.className = previewWindow ? 'rhwp-print-preview' : '';
  if (previewWindow) {
    appendPrintPreviewBar(doc, previewWindow, fileName, printPages.length);
  }
  const resolveFont = createPrintFontResolver();
  for (const printPage of printPages) {
    appendSvgPage(doc, doc.body, printPage, resolveFont);
  }
  mirrorDocumentFonts(document, doc);
}

/** 화면이 쓰는 세션 글꼴 face(예: 수식 HyhwpEQ)를 인쇄 SVG도 쓰게 한다. */
function createPrintFontResolver(): PrintFontResolver {
  const cache = new Map<string, string | null>();
  return (family) => {
    if (!cache.has(family)) {
      const record = resolveSessionLocalFont(family);
      cache.set(family, record?.runtimeFamily && hasImportedLocalFontFace(family) ? record.runtimeFamily : null);
    }
    return cache.get(family) ?? null;
  };
}

function appendPrintPreviewBar(
  doc: Document,
  printWindow: Window,
  fileName: string,
  pageCount: number,
): void {
  const bar = doc.createElement('div');
  bar.className = 'print-preview-bar';
  bar.setAttribute('role', 'toolbar');
  bar.setAttribute('aria-label', '인쇄 미리보기 도구');

  const printButton = doc.createElement('button');
  printButton.id = 'print-btn';
  printButton.type = 'button';
  printButton.className = 'print-preview-primary';
  printButton.textContent = '인쇄';
  printButton.addEventListener('click', () => {
    // Electron 데스크톱은 네이티브 인쇄 대화상자를 연다 — 미리보기 창의
    // webContents 를 main 이 print() 한다. 브라우저 빌드는 그대로 window.print.
    const printCurrentWindow = (printWindow as unknown as {
      rhwpDesktop?: { printCurrentWindow?: () => Promise<void> };
    }).rhwpDesktop?.printCurrentWindow;
    if (typeof printCurrentWindow === 'function') {
      void printCurrentWindow();
    } else {
      printWindow.print();
    }
  });

  const closeButton = doc.createElement('button');
  closeButton.id = 'close-btn';
  closeButton.type = 'button';
  closeButton.textContent = '닫기';
  closeButton.addEventListener('click', () => printWindow.close());

  const title = doc.createElement('span');
  title.className = 'print-preview-title';
  title.textContent = `${fileName} — ${pageCount}쪽`;

  bar.append(printButton, closeButton, title);
  doc.body.appendChild(bar);
}

function waitForHostAnimationFrame(): Promise<void> {
  return new Promise((resolve) => {
    window.requestAnimationFrame(() => resolve());
  });
}

async function waitForHostPaint(): Promise<void> {
  await waitForHostAnimationFrame();
  await waitForHostAnimationFrame();
}

function setPrintPreviewLoading(
  surface: PrintPreviewSurface,
  message: string,
): void {
  const loadingMessage = surface.document.getElementById('print-loading-message');
  if (loadingMessage) loadingMessage.textContent = message;
}

async function preparePrintPages(
  services: CommandServices,
  intent: PrintIntent,
  onProgress: (currentPage: number, pageCount: number) => void,
  isCancelled: () => boolean = () => false,
): Promise<PrintPage[]> {
  const wasm = services.wasm;
  const pageCount = wasm.pageCount;
  const printPages: PrintPage[] = [];
  for (let i = 0; i < pageCount; i++) {
    // 미리보기 창을 닫으면 남은 쪽을 그리지 않고 멈춘다.
    if (isCancelled()) throw new PrintSurfaceClosedError();
    onProgress(i + 1, pageCount);
    const svg = wasm.renderPageSvgWithProfile(i, 'print');
    const pageInfo = wasm.getPageInfo(i);
    printPages.push(createPrintPage(svg, pageInfo, i));
    if (i % 5 === 0) await new Promise(resolve => setTimeout(resolve, 0));
  }
  return printPages;
}

let printJobActive = false;

function beginPrintJob(): boolean {
  if (printJobActive) {
    showToast({ message: '인쇄 문서를 준비하고 있습니다.', durationMs: 2500 });
    return false;
  }
  printJobActive = true;
  return true;
}

async function runPdfPrint(services: CommandServices): Promise<void> {
  if (!beginPrintJob()) return;

  const wasm = services.wasm;
  const statusEl = document.getElementById('sb-message');
  const originalStatus = statusEl?.textContent || '';
  let dialog: PdfPrintDialog | null = null;
  let surface: PrintSurface | null = null;
  let restoreStatus = true;
  let dialogVisible = false;
  let originalDocumentTitle: string | null = null;

  try {
    flushDeferredPaginationBeforeExplicitOutput(services, 'print-pdf');
    const pageCount = wasm.pageCount;
    if (pageCount === 0) return;

    const showGuidance = userSettings.getShowPdfPrintGuidance();
    dialog = new PdfPrintDialog(pageCount, showGuidance);
    dialogVisible = true;
    const decision = await dialog.showAsync();
    if (!decision.confirmed) return;
    if (decision.hideFutureGuidance) {
      try {
        userSettings.setShowPdfPrintGuidance(false);
      } catch (error) {
        console.warn('[file:print-to-pdf] 안내 표시 설정을 저장하지 못했습니다:', error);
      }
    }

    const initialProgress = printProgressText('pdf', 0, pageCount);
    if (statusEl) statusEl.textContent = initialProgress;
    dialog.updateProgress(0);
    await waitForHostPaint();

    surface = await createPrintSurface();
    const printPages = await preparePrintPages(services, 'pdf', (current, total) => {
      if (statusEl) statusEl.textContent = printProgressText('pdf', current, total);
      dialog?.updateProgress(current);
    });

    setupPrintDocument(surface.document, wasm.fileName, printPages);
    await waitForPrintSurfaceReady(surface);
    if (statusEl) statusEl.textContent = printReadyText('pdf');

    dialog.closeBeforePrint();
    dialogVisible = false;
    await waitForHostPaint();

    console.info(
      `[file:print-to-pdf] 브라우저 인쇄 호출 `
      + `(surface=iframe, pages=${pageCount}, profile=print)`,
    );
    // Chromium/Edge는 iframe을 인쇄해도 최상위 문서 제목을 PDF 기본 파일명으로
    // 사용한다. native print()가 열린 동안에만 원본 파일의 basename을 노출한다.
    originalDocumentTitle = document.title;
    document.title = pdfPrintTitle(wasm.fileName);
    surface.window.print();
  } catch (err) {
    restoreStatus = false;
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[file:print-to-pdf]', msg);
    if (statusEl) statusEl.textContent = `PDF 준비 실패: ${msg}`;
    if (dialogVisible && dialog) {
      dialog.showError(msg);
    } else {
      showToast({ message: `PDF 준비에 실패했습니다: ${msg}`, durationMs: 5000 });
    }
  } finally {
    if (originalDocumentTitle !== null) {
      document.title = originalDocumentTitle;
    }
    surface?.dispose();
    printJobActive = false;
    if (restoreStatus && statusEl) statusEl.textContent = originalStatus;
  }
}

/** PDF 내보내기 숨은 창의 이름. desktop/pdf-export.mjs 의 PDF_EXPORT_FRAME_NAME 과 같다. */
const PDF_EXPORT_FRAME_NAME = 'rhwp-pdf-export';

type DesktopPdfExportApi = RhwpDesktopApi & Required<Pick<RhwpDesktopApi, 'pickPdfExportPath'>>;

function desktopPdfExportApi(): DesktopPdfExportApi | null {
  const api = (window as unknown as DesktopHost).rhwpDesktop;
  if (typeof api?.pickPdfExportPath !== 'function') return null;
  return api as DesktopPdfExportApi;
}

/**
 * 데스크톱 앱의 PDF 직접 내보내기. 저장 위치를 고른 뒤 숨은 창에 쪽을 그리고
 * Electron printToPDF 로 바로 파일을 쓴다. 인쇄 대화상자를 거치지 않는다.
 */
async function runDesktopPdfExport(
  services: CommandServices,
  desktop: DesktopPdfExportApi,
): Promise<void> {
  if (!beginPrintJob()) return;

  const wasm = services.wasm;
  const statusEl = document.getElementById('sb-message');
  const originalStatus = statusEl?.textContent || '';
  let surface: PrintPreviewSurface | null = null;
  let restoreStatus = true;

  try {
    flushDeferredPaginationBeforeExplicitOutput(services, 'export-pdf');
    const pageCount = wasm.pageCount;
    if (pageCount === 0) return;

    const target = await desktop.pickPdfExportPath({
      suggestedName: `${pdfPrintTitle(wasm.fileName)}.pdf`,
    });
    if (!target) return;

    if (statusEl) statusEl.textContent = printProgressText('pdf', 0, pageCount);
    surface = await createPrintPreviewSurface({ frameName: PDF_EXPORT_FRAME_NAME });
    const exportWindow = surface.window;
    const printPages = await preparePrintPages(services, 'pdf', (current, total) => {
      if (statusEl) statusEl.textContent = printProgressText('pdf', current, total);
    }, () => exportWindow.closed);

    setupPrintDocument(surface.document, wasm.fileName, printPages);
    await waitForPrintSurfaceReady(surface);

    const exportPdf = (exportWindow as unknown as DesktopHost).rhwpDesktop?.exportPdf;
    if (typeof exportPdf !== 'function') {
      throw new Error('PDF 내보내기 창을 준비하지 못했습니다.');
    }
    const result = await exportPdf(target.token);
    console.info(`[file:print-to-pdf] PDF 내보내기 완료 (pages=${pageCount}, file=${result.fileName})`);
    const reveal = desktop.revealPdfExport;
    showToast({
      message: `PDF로 내보냈습니다: ${result.fileName}`,
      durationMs: 6000,
      action: typeof reveal === 'function'
        ? { label: '폴더에서 보기', onClick: () => void reveal(result.exportId) }
        : undefined,
    });
  } catch (err) {
    if (err instanceof PrintSurfaceClosedError) return;
    restoreStatus = false;
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[file:print-to-pdf]', msg);
    if (statusEl) statusEl.textContent = `PDF 내보내기 실패: ${msg}`;
    showToast({ message: `PDF 내보내기에 실패했습니다: ${msg}`, durationMs: 5000 });
  } finally {
    surface?.close();
    printJobActive = false;
    if (restoreStatus && statusEl) statusEl.textContent = originalStatus;
  }
}

async function runPrintPreview(services: CommandServices): Promise<void> {
  if (!beginPrintJob()) return;

  const wasm = services.wasm;
  const statusEl = document.getElementById('sb-message');
  const originalStatus = statusEl?.textContent || '';
  let surface: PrintPreviewSurface | null = null;
  let keepPreviewOpen = false;
  let restoreStatus = true;

  try {
    flushDeferredPaginationBeforeExplicitOutput(services, 'print');
    const pageCount = wasm.pageCount;
    if (pageCount === 0) return;

    // popup 허용을 위해 사용자 클릭에서 첫 await 전에 창을 연다.
    const surfacePromise = createPrintPreviewSurface();
    const initialProgress = printProgressText('print', 0, pageCount);
    if (statusEl) statusEl.textContent = initialProgress;

    surface = await surfacePromise;
    if (!surface) return;
    setPrintPreviewLoading(surface, initialProgress);

    const previewWindow = surface.window;
    const printPages = await preparePrintPages(services, 'print', (current, total) => {
      const progressText = printProgressText('print', current, total);
      if (statusEl) statusEl.textContent = progressText;
      if (surface) setPrintPreviewLoading(surface, progressText);
    }, () => previewWindow.closed);

    setupPrintDocument(surface.document, wasm.fileName, printPages, surface.window);
    await waitForPrintSurfaceReady(surface);
    if (statusEl) statusEl.textContent = printReadyText('print');
    keepPreviewOpen = true;

    console.info(
      `[file:print] 인쇄 미리보기 준비 완료 `
      + `(surface=window, pages=${pageCount}, profile=print)`,
    );
  } catch (err) {
    if (err instanceof PrintSurfaceClosedError) {
      // 사용자가 준비 중인 미리보기 창을 닫았다. 취소로 보고 상태 문구만 되돌린다.
      console.info('[file:print] 인쇄 미리보기 창이 닫혀 준비를 멈춥니다.');
      return;
    }
    restoreStatus = false;
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[file:print]', msg);
    if (statusEl) statusEl.textContent = `인쇄 미리보기 실패: ${msg}`;
    if (err instanceof PrintPreviewBlockedError) {
      alert('인쇄 미리보기 팝업이 차단되었습니다. 팝업 허용 후 다시 시도해주세요.');
    } else {
      showToast({ message: `인쇄 미리보기에 실패했습니다: ${msg}`, durationMs: 5000 });
    }
  } finally {
    if (!keepPreviewOpen) surface?.close();
    printJobActive = false;
    if (restoreStatus && statusEl) statusEl.textContent = originalStatus;
  }
}

export const fileCommands: CommandDef[] = [
  {
    id: 'file:new-doc',
    label: '새로 만들기',
    icon: 'icon-new-doc',
    shortcutLabel: 'Alt+N',
    canExecute: () => true,
    execute(services) {
      services.eventBus.emit('create-new-document');
    },
  },
  {
    id: 'file:open',
    label: '열기',
    execute: openFileViaPicker,
  },
  {
    id: 'file:import-legacy-history',
    label: '이전 기록 폴더 가져오기',
    execute: importLegacyHistoryFolder,
  },
  {
    id: 'file:open-recent',
    label: '최근 문서 열기',
    async execute(services, params) {
      const id = typeof params?.id === 'string' ? params.id : undefined;
      if (!id) return;
      const recents = await listRecentDocs();
      const entry = recents.find((r) => r.id === id);
      if (!entry) {
        showToast({ message: '최근 문서 정보를 찾을 수 없습니다.', durationMs: 2500 });
        return;
      }

      const claim = claimForRecentDoc(entry);
      await openProjectFile(claim, projectFileDeps(services, claim));
    },
  },
  {
    // 최근 문서 목록 전체 삭제.
    id: 'file:clear-recent',
    label: '최근 문서 목록 지우기',
    async execute() {
      if (!confirm('최근 문서 목록을 모두 지우시겠습니까?')) return;
      await clearRecentDocs();
      showToast({ message: '최근 문서 목록을 지웠습니다.', durationMs: 2200 });
    },
  },
  {
    id: 'file:save',
    label: '저장',
    icon: 'icon-save',
    shortcutLabel: 'Ctrl+S',
    canExecute: (ctx) => ctx.hasDocument,
    async execute(services) {
      await saveCurrentDocument(services);
    },
  },
  {
    // [Task #833] 다른 이름으로 저장 — currentFileHandle 무시 + 항상 picker.
    // 열린 .hwp는 HWP, 새 문서·그 외는 HWPX. 명시 메뉴로 HWP 5.0도 선택 가능.
    id: 'file:save-as',
    label: '다른 이름으로 저장',
    shortcutLabel: 'Ctrl+Shift+S',
    canExecute: (ctx) => ctx.hasDocument,
    async execute(services) {
      await runExclusiveSave(async () => {
        try {
          assertCanSaveDocument(services);
        } catch (error) {
          reportSaveError('file:save-as', error);
          return 'failed';
        }
        const format = await chooseSaveAsFormat(services);
        return format === null ? 'cancelled' : saveAsFormat(services, format);
      });
    },
  },
  {
    id: 'file:save-with-history',
    label: '기록을 포함해 저장',
    canExecute: (ctx) => ctx.hasDocument,
    async execute(services) {
      await runExclusiveSave(() => saveWithHistory(services));
    },
  },
  {
    // [#1613] HWP 5.0으로 저장 — 출처 무관 바이너리 HWP 출력.
    id: 'file:save-as-hwp',
    label: 'HWP 5.0으로 저장',
    canExecute: (ctx) => ctx.hasDocument,
    async execute(services) {
      await runExclusiveSave(() => saveAsFormat(services, 'hwp'));
    },
  },
  {
    // [#1613] HWPX로 저장 — 출처 무관 HWPX 출력 (새 문서·내보내기 기본).
    id: 'file:save-as-hwpx',
    label: 'HWPX로 저장',
    canExecute: (ctx) => ctx.hasDocument,
    async execute(services) {
      await runExclusiveSave(() => saveAsFormat(services, 'hwpx'));
    },
  },
  {
    id: 'file:page-setup',
    label: '편집 용지',
    icon: 'icon-page-setup',
    shortcutLabel: 'F7',
    canExecute: (ctx) => ctx.hasDocument,
    execute(services) {
      // 커서가 있는 구역의 용지를 연다 (page:setup 과 같은 기준).
      const sectionIdx = services.getInputHandler()?.getCursorPosition().sectionIndex ?? 0;
      const dialog = new PageSetupDialog(services.wasm, services.eventBus, sectionIdx, services);
      dialog.show();
    },
  },
  {
    id: 'file:print-to-pdf',
    label: 'PDF로 내보내기…',
    canExecute: (ctx) => ctx.hasDocument,
    async execute(services) {
      const desktop = desktopPdfExportApi();
      if (desktop) await runDesktopPdfExport(services, desktop);
      else await runPdfPrint(services);
    },
  },
  {
    id: 'file:print',
    label: '인쇄',
    icon: 'icon-print',
    shortcutLabel: 'Ctrl+P',
    canExecute: (ctx) => ctx.hasDocument,
    async execute(services) {
      await runPrintPreview(services);
    },
  },
  {
    id: 'file:about',
    label: '제품 정보',
    icon: 'icon-help',
    execute() {
      new AboutDialog().show();
    },
  },
];
