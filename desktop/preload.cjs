const { contextBridge, ipcRenderer, webUtils } = require('electron');

// 재시작 직전 메인이 창마다 두 번 묻는다. 준비(prepare)에 모든 창이 응하면 확정(commit)한다. 받을 처리기가
// 없거나 실패하면 ok:false 로 재시작을 멈춘다.
const restartHandlers = { prepare: null, commit: null };
for (const phase of Object.keys(restartHandlers)) {
  ipcRenderer.on(`desktop:update-${phase}-restart`, async (_event, request) => {
    let slice = { ok: false };
    try {
      if (restartHandlers[phase]) slice = await restartHandlers[phase]();
    } catch {
      slice = { ok: false };
    }
    ipcRenderer.invoke(`desktop:update-${phase}-response`, request?.requestId, slice).catch(() => {});
  });
}
function setRestartHandler(phase, handler) {
  restartHandlers[phase] = handler;
  return () => {
    if (restartHandlers[phase] === handler) restartHandlers[phase] = null;
  };
}

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
      block: (payload) => ipcRenderer.invoke('desktop:browser-passwords-block', payload),
      save: (payload) => ipcRenderer.invoke('desktop:browser-passwords-save', payload),
      cookieSites: (payload) => ipcRenderer.invoke('desktop:browser-passwords-cookieSites', payload),
      importCookies: (payload) => ipcRenderer.invoke('desktop:browser-passwords-importCookies', payload),
      fill: (payload) => ipcRenderer.invoke('desktop:browser-passwords-fill', payload),
    },
    attach: (payload) => ipcRenderer.invoke('desktop:browser-attach', payload),
    detach: (payload) => ipcRenderer.invoke('desktop:browser-detach', payload),
    getState: (payload) => ipcRenderer.invoke('desktop:browser-state', payload),
    zoom: (payload) => ipcRenderer.invoke('desktop:browser-zoom', payload),
    pointer: (payload) => ipcRenderer.invoke('desktop:browser-pointer', payload),
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
  // 문제 보고. prepare 는 시트를 띄우기 전에 창을 찍고 진단 기록을 붙잡고, submit 은 메인이 보낸다.
  issueReport: {
    prepare: () => ipcRenderer.invoke('desktop:issue-report-prepare'),
    submit: (draft) => ipcRenderer.invoke('desktop:issue-report-submit', draft),
  },
  // 자동 수정. run 은 메인이 코딩 에이전트를 창 없이 돌려 이 컴퓨터의 앱 상태를 고치고, 결과를 문제 보고로 보낸다.
  // prewarm 은 단추가 서기 전에 제공자를 미리 고르고, outcome 은 고친 자리의 동작이 다시 됐는지 메인에 알린다.
  // 설정(켜기·제공자 순서·모델·노력)은 메인이 저장하고, 바뀌면 모든 창에 알린다.
  autofix: {
    run: (request) => ipcRenderer.invoke('desktop:autofix-run', request),
    prewarm: () => ipcRenderer.invoke('desktop:autofix-prewarm'),
    outcome: (outcome) => ipcRenderer.invoke('desktop:autofix-outcome', outcome),
    getSettings: () => ipcRenderer.invoke('desktop:autofix-get-settings'),
    setSettings: (patch) => ipcRenderer.invoke('desktop:autofix-set-settings', patch),
    onChange: (callback) => {
      const listener = (_event, settings) => callback(settings);
      ipcRenderer.on('autofix:changed', listener);
      return () => ipcRenderer.removeListener('autofix:changed', listener);
    },
  },
  // 렌더러가 죽었을 때 메인이 띄우는 안내 화면(crash-page.html)이 편집기를 다시 연다.
  crashPage: {
    reopen: () => ipcRenderer.invoke('desktop:crash-page-reopen'),
  },
  // 렌더러 오류(window error·unhandledrejection·console.error)를 메인의 진단 기록에 남긴다.
  logDiagnostics: (entries) => {
    if (Array.isArray(entries) && entries.length > 0) ipcRenderer.send('desktop:diagnostic-log', entries);
  },
  // 체험·라이선스. 활성화와 비활성화는 메인이 키 서버와 주고받고, 렌더러는 상태만 받는다.
  license: {
    getStatus: () => ipcRenderer.invoke('license:status'),
    checkNow: () => ipcRenderer.invoke('license:check'),
    activate: (key) => ipcRenderer.invoke('license:activate', String(key ?? '')),
    deactivate: () => ipcRenderer.invoke('license:deactivate'),
    openActivation: () => ipcRenderer.invoke('license:open-window'),
    openPricing: () => ipcRenderer.invoke('license:open-pricing'),
    openPaymentFix: () => ipcRenderer.invoke('license:open-payment-fix'),
    openSupport: () => ipcRenderer.invoke('license:open-support'),
    copyKey: () => ipcRenderer.invoke('license:copy-key'),
    // 체험이 끝날 때 열린 문서를 자동 저장하려고 한 번 유예를 받는다.
    beginExpirySave: () => ipcRenderer.invoke('license:begin-expiry-save'),
    onChange: (callback) => {
      const listener = (_event, status) => callback(status);
      ipcRenderer.on('license:changed', listener);
      return () => ipcRenderer.removeListener('license:changed', listener);
    },
  },
  // 선물 크레딧(macOS 전용). 서버와는 메인이 라이선스 lease 로 주고받는다.
  gift: {
    getStatus: (options) => ipcRenderer.invoke('gift:status', { refresh: options?.refresh === true }),
    claim: () => ipcRenderer.invoke('gift:claim'),
    onChange: (callback) => {
      const listener = (_event, status) => callback(status);
      ipcRenderer.on('gift:changed', listener);
      return () => ipcRenderer.removeListener('gift:changed', listener);
    },
  },
  // 앱 업데이트. 확인·다운로드·재시작은 메인이 하고, 렌더러는 상태를 받아 보여 준다.
  updates: {
    getAllState: () => ipcRenderer.invoke('desktop:update-all-get-state'),
    onAllState: (callback) => {
      const listener = (_event, state) => callback(state);
      ipcRenderer.on('desktop:update-all-state', listener);
      return () => ipcRenderer.removeListener('desktop:update-all-state', listener);
    },
    refreshAll: () => ipcRenderer.invoke('desktop:update-all-refresh'),
    updateAll: () => ipcRenderer.invoke('desktop:update-all-start'),
    later: () => ipcRenderer.invoke('desktop:update-all-later'),
    getState: () => ipcRenderer.invoke('desktop:update-get-state'),
    onState: (callback) => {
      const listener = (_event, state) => callback(state);
      ipcRenderer.on('desktop:update-state', listener);
      return () => ipcRenderer.removeListener('desktop:update-state', listener);
    },
    check: () => ipcRenderer.invoke('desktop:update-check'),
    download: () => ipcRenderer.invoke('desktop:update-download'),
    restart: () => ipcRenderer.invoke('desktop:update-restart'),
    setRunningChatCount: (count) => {
      ipcRenderer.send('desktop:update-running-chats', Number.isSafeInteger(count) ? count : 0);
    },
    // 준비 처리기는 문서를 저장해 두고 확인한다. ok:false 면 재시작하지 않는다.
    onPrepareRestart: (handler) => setRestartHandler('prepare', handler),
    // 확정 처리기는 마지막으로 저장하고 닫기 확인을 풀고 이 창의 몫을 돌려준다.
    onCommitRestart: (handler) => setRestartHandler('commit', handler),
    getRestore: () => ipcRenderer.invoke('desktop:get-update-restore'),
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
  locateNativeFile: (handleId) => ipcRenderer.invoke('desktop:native-file-locate', handleId),
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
  // 문서 홈 카드를 파일로 다른 앱에 끌어 놓는다. 준비(내보내기·임시 사본) 뒤에 끌기를 시작한다.
  prepareFileDrag: (items) => ipcRenderer.invoke('desktop:prepare-file-drag', Array.isArray(items) ? items : []),
  // true: 끌기가 끝났다(Windows 는 놓은 뒤에 돌아온다). false: 운영체제가 아직 끄는 중이다.
  startFileDrag: (token, iconDataUrl) => ipcRenderer.invoke(
    'desktop:start-file-drag',
    String(token ?? ''),
    String(iconDataUrl ?? ''),
  ).then((finished) => finished === true, () => true),
  endFileDrag: (token, dropped) => {
    ipcRenderer.send('desktop:end-file-drag', String(token ?? ''), dropped === true);
  },
  // 다른 창이 이 창에 열린 문서를 끌 때: 바뀐 내용을 내보내 돌려준다.
  onDragExportRequest: (callback) => {
    const listener = (_event, payload) => {
      if (typeof payload?.requestId !== 'string' || typeof payload.documentId !== 'string') return;
      Promise.resolve()
        .then(() => callback(payload.documentId))
        .catch(() => null)
        .then((result) => ipcRenderer.invoke('desktop:drag-export-reply', payload.requestId, result ?? null))
        .catch(() => {});
    };
    ipcRenderer.on('desktop:drag-export-request', listener);
    return () => ipcRenderer.removeListener('desktop:drag-export-request', listener);
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
  systemFontNameTables: (ids) => ipcRenderer.invoke('desktop:font-name-tables', ids),
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
  // 창 배경색을 앱 테마의 바탕색에 맞춘다(#rrggbb 만 보낸다).
  setWindowBackground: (color) => {
    if (typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color)) ipcRenderer.send('desktop:set-window-background', color);
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
  setWindowChromeTheme: (dark) => ipcRenderer.send('window:chrome-theme', dark),
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
  // 탐색기에서 이름이 바뀌거나 옮겨진 문서를 메인이 따라갔다. 제목·목록을 새 이름으로 고친다.
  onNativeFileMoved: (callback) => {
    const listener = (_event, payload) => {
      if (typeof payload?.handleId === 'string' && typeof payload?.name === 'string') {
        callback({
          handleId: payload.handleId,
          name: payload.name,
          previousName: typeof payload.previousName === 'string' ? payload.previousName : '',
        });
      }
    };
    ipcRenderer.on('desktop:native-file-moved', listener);
    return () => ipcRenderer.removeListener('desktop:native-file-moved', listener);
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
