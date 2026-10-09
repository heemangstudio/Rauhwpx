const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('rhwpDesktop', {
  getSessionContext: () => ipcRenderer.invoke('desktop:get-session-context'),
  // 백그라운드 문서의 에이전트용 추가 허브 세션. 만든 창만 문맥을 받고 해제할 수 있다.
  createAgentSession: () => ipcRenderer.invoke('desktop:agent-session-create'),
  getAgentSessionContext: (agentSessionId) => ipcRenderer.invoke(
    'desktop:get-session-context',
    String(agentSessionId),
  ),
  releaseAgentSession: (agentSessionId) => ipcRenderer.invoke(
    'desktop:agent-session-release',
    agentSessionId,
  ),
  getUniqueInstalls: () => ipcRenderer.invoke('desktop:get-unique-installs'),
  getLaunchFiles: () => ipcRenderer.invoke('desktop:get-launch-files'),
  getLaunchGeneratedDocument: () => ipcRenderer.invoke('desktop:get-launch-generated-document'),
  openGeneratedDocumentWindow: (payload) => ipcRenderer.invoke(
    'desktop:open-generated-document-window',
    payload,
  ),
  pickNativeOpenFile: (options) => ipcRenderer.invoke('desktop:pick-native-open-file', options),
  pickLegacyHistoryFolder: () => ipcRenderer.invoke('desktop:pick-legacy-history-folder'),
  claimNativeDroppedFile: (file) => {
    const path = webUtils.getPathForFile(file);
    return path ? ipcRenderer.invoke('desktop:claim-native-dropped-file', path) : null;
  },
  pickNativeSaveFile: (options) => ipcRenderer.invoke('desktop:pick-native-save-file', options),
  releaseNativeFile: (handleId) => ipcRenderer.invoke('desktop:release-native-file', handleId),
  renameNativeFile: (handleId, nextName) => ipcRenderer.invoke('desktop:rename-native-file', handleId, nextName),
  readNativeFile: (handleId) => ipcRenderer.invoke('desktop:native-file-read', handleId),
  getNativeFileSourcePath: (handleId) => ipcRenderer.invoke(
    'desktop:native-file-source-path',
    handleId,
  ),
  validateNativeSave: (handleId, identity) => ipcRenderer.invoke(
    'desktop:native-file-validate-save',
    handleId,
    identity,
  ),
  writeNativeFile: (handleId, bytes, identity) => ipcRenderer.invoke(
    'desktop:native-file-write',
    handleId,
    bytes,
    identity,
  ),
  isSameNativeFile: (firstHandleId, secondHandleId) => ipcRenderer.invoke(
    'desktop:native-file-is-same',
    firstHandleId,
    secondHandleId,
  ),
  adoptNativeFileContent: (handleId, digest) => ipcRenderer.invoke(
    'desktop:native-file-adopt-loaded',
    handleId,
    digest,
  ),
  rememberNativeDocument: (documentId, handleId, digest) => ipcRenderer.invoke(
    'desktop:remember-native-document',
    documentId,
    handleId,
    digest,
  ),
  reopenNativeDocument: (documentId) => ipcRenderer.invoke(
    'desktop:reopen-native-document',
    documentId,
  ),
  searchNearbyNativeDocument: (documentId, options) => ipcRenderer.invoke(
    'desktop:search-nearby-native-document',
    documentId,
    options,
  ),
  readNativeProbe: (probeId) => ipcRenderer.invoke('desktop:native-probe-read', probeId),
  claimNativeProbe: (probeId) => ipcRenderer.invoke('desktop:native-probe-claim', probeId),
  verifyNativePick: (documentId, handleId) => ipcRenderer.invoke(
    'desktop:verify-native-pick',
    documentId,
    handleId,
  ),
  reserveDocument: (identity, nativeHandleId, slotId) => ipcRenderer.invoke(
    'desktop:document-reserve',
    identity,
    nativeHandleId,
    slotId,
  ),
  commitDocument: (reservationId, slotId) => ipcRenderer.invoke(
    'desktop:document-commit',
    reservationId,
    slotId,
  ),
  cancelDocument: (reservationId, slotId) => ipcRenderer.invoke(
    'desktop:document-cancel',
    reservationId,
    slotId,
  ),
  releaseDocument: (slotId) => ipcRenderer.invoke('desktop:document-release', slotId),
  listSystemFonts: (options) => ipcRenderer.invoke('desktop:fonts-list', options),
  readSystemFont: (id) => ipcRenderer.invoke('desktop:fonts-read', id),
  ensureAgentHub: () => ipcRenderer.invoke('agent-hub:ensure'),
  respondToCloseRequest: (requestId, allowClose) => (
    ipcRenderer.invoke('desktop:close-response', requestId, allowClose)
  ),
  onCloseRequested: (callback) => {
    ipcRenderer.on('desktop:close-requested', (_event, request) => callback(request));
  },
  platform: process.platform,
  setDocumentState: (state) => {
    ipcRenderer.send('desktop:set-document-state', { edited: state?.edited === true });
  },
  notifyAgentTurnFinished: (payload) => {
    ipcRenderer.send('desktop:agent-turn-finished', {
      title: String(payload?.title ?? ''),
      body: String(payload?.body ?? ''),
    });
  },
  setPendingReviewCount: (count) => {
    ipcRenderer.send('desktop:set-pending-review-count', Number(count) || 0);
  },
  showContextMenu: (items) => ipcRenderer.invoke('desktop:show-context-menu', items),
  showUnsavedChangesSheet: (payload) => ipcRenderer.invoke(
    'desktop:show-unsaved-changes-sheet',
    { fileName: String(payload?.fileName ?? '') },
  ),
  isFullScreen: () => ipcRenderer.invoke('window:is-fullscreen'),
  // 네이티브 인쇄 대화상자를 호출 창의 내용으로 연다 (인쇄 미리보기 자식 창).
  printCurrentWindow: () => ipcRenderer.invoke('desktop:print'),
  // PDF 내보내기: 저장 위치는 main 이 고르고 renderer 는 불투명 토큰만 받는다.
  pickPdfExportPath: (options) => ipcRenderer.invoke('desktop:pick-pdf-export-path', {
    suggestedName: String(options?.suggestedName ?? ''),
  }),
  // 숨은 PDF surface 창이 자기 내용을 PDF 로 저장한다.
  exportPdf: (token) => ipcRenderer.invoke('desktop:export-pdf', String(token ?? '')),
  revealPdfExport: (exportId) => ipcRenderer.invoke('desktop:reveal-pdf-export', String(exportId ?? '')),
  onFullScreenChange: (callback) => {
    ipcRenderer.on('window:fullscreen-changed', (_event, fullscreen) => {
      callback(Boolean(fullscreen));
    });
  },
  onOpenFiles: (callback) => {
    ipcRenderer.on('desktop:open-files', (_event, files) => {
      callback(Array.isArray(files) ? files.map((file) => ({ ...file })) : []);
    });
  },
  onOpenGeneratedDocument: (callback) => {
    ipcRenderer.on('desktop:open-generated-document', (_event, payload) => {
      callback(payload);
    });
  },
  onEditCommand: (callback) => {
    ipcRenderer.on('desktop:edit-command', (_event, command) => callback(command));
  },
  onPastePlainText: (callback) => {
    ipcRenderer.on('desktop:paste-plain-text', (_event, text) => {
      callback(typeof text === 'string' ? text : '');
    });
  },
  setAppMenuModel: (model) => ipcRenderer.send('desktop:set-app-menu-model', model),
  onMenuCommand: (callback) => {
    const listener = (_event, payload) => {
      if (typeof payload?.commandId === 'string') callback(payload.commandId);
    };
    ipcRenderer.on('desktop:menu-command', listener);
    return () => ipcRenderer.removeListener('desktop:menu-command', listener);
  },
  onAgentCommand: (callback) => {
    const listener = (_event, payload) => {
      if (typeof payload?.command === 'string') callback(payload.command);
    };
    ipcRenderer.on('desktop:agent-command', listener);
    return () => ipcRenderer.removeListener('desktop:agent-command', listener);
  },
});
