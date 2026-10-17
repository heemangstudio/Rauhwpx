const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('rhwpDesktop', {
  browser: {
    native: true,
    adblock: {
      get: () => ipcRenderer.invoke('desktop:browser-adblock-get'),
      configure: (payload) => ipcRenderer.invoke('desktop:browser-adblock-configure', payload),
      update: () => ipcRenderer.invoke('desktop:browser-adblock-update'),
    },
    passwords: {
      armSave: (payload) => ipcRenderer.invoke('desktop:browser-passwords-armSave', payload),
      listProfiles: () => ipcRenderer.invoke('desktop:browser-passwords-profiles'),
      importProfile: (payload) => ipcRenderer.invoke('desktop:browser-passwords-import', payload),
      list: () => ipcRenderer.invoke('desktop:browser-passwords-list'),
      remove: (payload) => ipcRenderer.invoke('desktop:browser-passwords-remove', payload),
      fill: (payload) => ipcRenderer.invoke('desktop:browser-passwords-fill', payload),
    },
    attach: (payload) => ipcRenderer.invoke('desktop:browser-attach', payload),
    detach: (payload) => ipcRenderer.invoke('desktop:browser-detach', payload),
    getState: (payload) => ipcRenderer.invoke('desktop:browser-state', payload),
    zoom: (payload) => ipcRenderer.invoke('desktop:browser-zoom', payload),
    navigate: (payload) => ipcRenderer.invoke('desktop:browser-navigate', payload),
    back: (payload) => ipcRenderer.invoke('desktop:browser-back', payload),
    forward: (payload) => ipcRenderer.invoke('desktop:browser-forward', payload),
    reload: (payload) => ipcRenderer.invoke('desktop:browser-reload', payload),
    stop: (payload) => ipcRenderer.invoke('desktop:browser-stop', payload),
    onEvent: (callback) => {
      const listener = (_event, payload) => callback(payload);
      ipcRenderer.on('desktop:browser-event', listener);
      return () => ipcRenderer.removeListener('desktop:browser-event', listener);
    },
  },
  saveAgentContext: (payload) => ipcRenderer.invoke('desktop:agent-context-save', payload),
  listAgentContexts: (documentId) => ipcRenderer.invoke('desktop:agent-context-list', documentId),
  readAgentContextFiles: (id) => ipcRenderer.invoke('desktop:agent-context-files', id),
  setAgentContextState: (ids, state) => ipcRenderer.invoke('desktop:agent-context-state', ids, state),
  captureDocumentRegion: (rect) => ipcRenderer.invoke('desktop:agent-context-capture', rect),
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
  // 체험·라이선스. 활성화와 비활성화는 메인이 키 서버와 주고받고, 렌더러는 상태만 받는다.
  license: {
    getStatus: () => ipcRenderer.invoke('license:status'),
    checkNow: () => ipcRenderer.invoke('license:check'),
    deactivate: () => ipcRenderer.invoke('license:deactivate'),
    openActivation: () => ipcRenderer.invoke('license:open-window'),
    openPricing: () => ipcRenderer.invoke('license:open-pricing'),
    // 체험이 끝날 때 열린 문서를 자동 저장하려고 한 번 유예를 받는다.
    beginExpirySave: () => ipcRenderer.invoke('license:begin-expiry-save'),
    onChange: (callback) => {
      const listener = (_event, status) => callback(status);
      ipcRenderer.on('license:changed', listener);
      return () => ipcRenderer.removeListener('license:changed', listener);
    },
  },
  takeRebrandImport: () => ipcRenderer.invoke('desktop:take-rebrand-import'),
  takeRebrandImportChunk: (token, index) => ipcRenderer.invoke('desktop:take-rebrand-import-chunk', token, index),
  finishRebrandImport: (token, outcome) => ipcRenderer.invoke('desktop:finish-rebrand-import', token, outcome),
  getLaunchFiles: () => ipcRenderer.invoke('desktop:get-launch-files'),
  getLaunchGeneratedDocument: () => ipcRenderer.invoke('desktop:get-launch-generated-document'),
  offersAutosaveRecovery: () => ipcRenderer.invoke('desktop:offers-autosave-recovery'),
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
  openNativeDocumentAtPath: (path) => ipcRenderer.invoke('desktop:open-native-document-at-path', path),
  createNamedNativeDocument: (payload) => ipcRenderer.invoke('desktop:create-named-native-document', {
    name: payload?.name,
    folder: payload?.folder,
    bytes: payload?.bytes,
  }),
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
  inspectNativeDocuments: (documentIds) => ipcRenderer.invoke(
    'desktop:inspect-native-documents',
    Array.isArray(documentIds) ? documentIds.map(String) : [],
  ),
  relocateNativeDocument: (documentId) => ipcRenderer.invoke(
    'desktop:relocate-native-document',
    documentId,
  ),
  readRememberedNativeDocument: (documentId, options) => ipcRenderer.invoke(
    'desktop:read-remembered-native-document',
    documentId,
    options?.detailed === true ? { detailed: true } : undefined,
  ),
  revealNativeDocument: (documentId) => ipcRenderer.invoke('desktop:reveal-native-document', documentId),
  openNativeDocumentWindow: (documentId) => ipcRenderer.invoke(
    'desktop:open-native-document-window',
    documentId,
  ),
  // 저장하지 않은 새 문서: 창마다 자기 목록을 알리고, 모든 창의 목록을 받는다.
  setUnsavedDocuments: (documents) => {
    ipcRenderer.send('desktop:set-unsaved-documents', Array.isArray(documents) ? documents : []);
  },
  listUnsavedDocuments: () => ipcRenderer.invoke('desktop:list-unsaved-documents'),
  onUnsavedDocumentsChanged: (callback) => {
    const listener = (_event, documents) => callback(Array.isArray(documents) ? documents : []);
    ipcRenderer.on('desktop:unsaved-documents-changed', listener);
    return () => ipcRenderer.removeListener('desktop:unsaved-documents-changed', listener);
  },
  runUnsavedDocumentAction: (documentId, action) => ipcRenderer.invoke(
    'desktop:unsaved-document-action',
    String(documentId),
    String(action),
  ),
  onUnsavedDocumentAction: (callback) => {
    const listener = (_event, payload) => {
      if (typeof payload?.documentId === 'string' && (payload.action === 'open' || payload.action === 'save')) {
        callback(payload.documentId, payload.action);
      }
    };
    ipcRenderer.on('desktop:run-unsaved-document-action', listener);
    return () => ipcRenderer.removeListener('desktop:run-unsaved-document-action', listener);
  },
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
  systemFontBaseUrl: () => ipcRenderer.invoke('desktop:fonts-base'),
  // 사용자가 더한 글꼴 폴더. 고르기는 main 의 폴더 선택 창이 하고, 바뀌면 모든 창에 fonts-changed 가 온다.
  fontFolders: {
    list: () => ipcRenderer.invoke('desktop:font-folders-list'),
    add: () => ipcRenderer.invoke('desktop:font-folders-add'),
    remove: (folder) => ipcRenderer.invoke('desktop:font-folders-remove', String(folder ?? '')),
  },
  onFontsChanged: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('desktop:fonts-changed', listener);
    return () => ipcRenderer.removeListener('desktop:fonts-changed', listener);
  },
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
  // 보지 않는 채팅의 알림. 창에 초점이 없을 때만 메인이 OS 알림으로 띄운다.
  notifyAgentAttention: (payload) => {
    ipcRenderer.send('desktop:agent-attention', {
      threadId: String(payload?.threadId ?? ''),
      title: String(payload?.title ?? ''),
      body: String(payload?.body ?? ''),
    });
  },
  // 알렸지만 아직 보지 않은 채팅 수 — 앱 아이콘 배지(macOS·Linux), 작업 표시줄 표시(Windows).
  setAgentAttentionCount: (count) => {
    ipcRenderer.send('desktop:set-agent-attention-count', Number(count) || 0);
  },
  onOpenAgentChat: (callback) => {
    const listener = (_event, payload) => {
      if (typeof payload?.threadId === 'string') callback(payload.threadId);
    };
    ipcRenderer.on('desktop:open-agent-chat', listener);
    return () => ipcRenderer.removeListener('desktop:open-agent-chat', listener);
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
