import './browser-compat.ts';
import '../style.css';
import './preview.css';
import { initAgentSidebar, type AgentSidebarHandle } from '../ui/agent-sidebar/index.ts';
import { HAMA_SHOWCASE, type HamaActionName } from '../ui/agent-sidebar/chat-hama.ts';
import { EventBus } from '../core/event-bus.ts';
import {
  getEffectiveTheme,
  getThemeMode,
  getThemeSettings,
  initThemeSync,
  setThemeAccent,
  setThemeMode,
  setThemePreset,
} from '../core/theme.ts';
import { THEME_PRESET_LIST } from '../core/theme-presets/index.ts';
import { createMockBridge, failureKinds, scenarios, type FailureKind, type Scenario } from './mock-bridge.ts';
import { createMockVersions } from './mock-versions.ts';
import { skipTasteUndo, tasteUndos } from './mock-taste.ts';
import { syncUserMemoryPlan, userMemoryControls } from './mock-user-memory.ts';
import { showToast } from '../ui/toast.ts';
import { normalizeThemeAccent, normalizeThemePreset, userSettings } from '../core/user-settings.ts';
import { completeInitialSetup, saveInitialSetup } from '../ui/initial-setup/state.ts';
import { listThreads, getThread, upsertThread, waitForThreadsPersistence } from '../agent/threads.ts';
import {
  getChatStatus,
  markChatFailed,
  markChatFinished,
  markChatNeedsReview,
  getChatStatusLabel,
  markChatWorking,
} from '../agent/chat-status.ts';
import {
  connectChatAttention,
  createChatAttentionLedger,
  type AttentionNotice,
} from '../agent/chat-attention.ts';
import { loadAttentionPrefs, saveAttentionPrefs, subscribeAttentionPrefs } from '../agent/attention-prefs.ts';
import { installAttentionToasts } from '../ui/agent-attention.ts';
import type { LibraryMoveResult } from '../library/move-to-document.ts';
import type { ChatDocumentLinked, ChatDocumentLinkTarget } from '../agent/document-link.ts';
import type { TurnRestoreControl, TurnRestoreResult, TurnRestoreStatus } from '../agent/turn-checkpoints.ts';
import {
  PREVIEW_WINDOW_SESSION_ID,
  SAMPLE_FINISHED_CHAT_ID,
  SAMPLE_INTERRUPTED_CHAT_ID,
  SAMPLE_REVIEW_CHAT_ID,
  SAMPLE_WORKING_CHAT_ID,
  sampleRecentDocuments,
  sampleReloadQuestion,
} from './fixtures.ts';
import { isSettingsDestination } from '../ui/agent-sidebar/settings-contract.ts';
import { mountAuditNavigator } from './audit-scenarios.ts';
import { mountAuditDialogs } from './audit-dialogs.ts';
import { applyAuditState } from './audit-state.ts';
import { applyPreviewCompactToolbar, mountEditorShell } from './editor-shell.ts';
import { createProjectScene } from './project-scene.ts';
import { mountCitationScenes } from './mock-citations.ts';
import { typingActivity, type TypingActivity } from '../ui/agent-sidebar/typing-guard.ts';
import { provideLocalPasswordsApi } from '../ui/agent-sidebar/browser-local-passwords.ts';
import { createPreviewLocalPasswords } from './mock-local-passwords.ts';
import { createMockGift, mockGiftMode } from './mock-gift.ts';
import { createMockAutofix, mockAutofixOutcomes } from './mock-autofix.ts';
import { setAutofixApi, type AutofixStatus } from '../ui/autofix/autofix.ts';
import { createMockLicense, mockLicenseMode } from './mock-license.ts';
import { createMockRau, mockRauMode, MOCK_RAU_UPGRADE_URL } from './mock-rau.ts';
import { createMockPlan, mockCheckoutMode, mockCheckoutModes, mockPlanTier, mockPlanTiers, type MockCheckoutMode } from './mock-plan.ts';
import {
  createMockAccount,
  mockAccountScenario,
  mockAccountScenarios,
  mockAccountSignedIn,
  mockAccountTier,
  type MockAccountScenario,
} from './mock-account.ts';
import { accountStore, setAccountApi } from '../ui/account/account-store.ts';
import { listenForAccountPageEvents } from '../ui/account/account-page.ts';
import type { PlanTier } from '../ui/plan/plan-types.ts';
import { createPlanStore } from '../ui/plan/plan-store.ts';
import { mountHomeScene } from './home-scene.ts';
import { startSpecialEvent } from '../ui/special-event/special-event-trigger.ts';
import { installManualAutofix } from '../ui/autofix/autofix-manual.ts';
import { isInitialSetupActive, onInitialSetupInactive, wasLicensedHere } from '../ui/initial-setup/active.ts';

const params = new URLSearchParams(location.search);
/** `vault=1|empty|unsupported|fail`: 데스크톱 앱의 Chrome 비밀번호 보관함을 흉내 낸다. */
const vaultParam = params.get('vault');
const localPasswords = vaultParam
  ? createPreviewLocalPasswords(vaultParam === 'empty' || vaultParam === 'unsupported' || vaultParam === 'fail' ? vaultParam : 'ready')
  : null;
provideLocalPasswordsApi(localPasswords?.api);
if (params.get('usage') === 'live') {
  const description = document.querySelector('#preview-controls > p');
  if (description) description.textContent = 'Live account usage. Sample chat and documents.';
  document.title = 'Live usage audit · HamaEditor';
}
const status = document.querySelector<HTMLOutputElement>('#preview-status')!;
const report = (message: string) => {
  status.value = message;
  showToast({ message, durationMs: 2500 });
};
/*
 * Background-chat attention. The preview has its own ledger so `attention=away` can route every
 * notice to the system sink (as when the window has no focus); otherwise a hidden chat's notice is
 * an in-app toast with 열기. System notices are reported as `알림: {title} — {body}` and logged in
 * `sidebarPreview.attentionNotices`. `notifications=granted` stubs the browser permission so the
 * 설정 → AI → 알림 toggles show on the web build. System notices carry only the app name and the fixed
 * phrase unless 알림에 채팅 제목과 문서 이름 표시 is on; `notificationDetails=1` turns it on at load.
 */
if (params.get('notifications') === 'granted' && typeof Notification === 'function') {
  Object.defineProperty(Notification, 'permission', { configurable: true, get: () => 'granted' });
}
const attentionAway = params.get('attention') === 'away';
if (params.get('notificationDetails') === '1') saveAttentionPrefs({ showChatDetails: true });
const attention = createChatAttentionLedger({
  getStatus: getChatStatus,
  windowFocused: () => !attentionAway && document.visibilityState === 'visible' && document.hasFocus(),
  showDetails: () => loadAttentionPrefs().showChatDetails,
});
attention.setEnabled(loadAttentionPrefs().notifications);
subscribeAttentionPrefs((prefs) => attention.setEnabled(prefs.notifications));
connectChatAttention(attention);
const attentionNotices: AttentionNotice[] = [];
const attentionCounts: number[] = [];
attention.subscribe({
  notice(notice) {
    if (notice.channel !== 'system') return;
    attentionNotices.push(notice);
    report(`알림: ${notice.title} — ${notice.body}`);
  },
  count(count) {
    attentionCounts.push(count);
  },
});
const undoState = { entry: null as object | null, calls: 0 };
const navigation = {
  calls: [] as Array<{ sectionIndex: number; paragraphIndex: number; charOffset: number }>,
  targets: [] as Array<{ anchor?: unknown; opId?: string } | undefined>,
};
/*
 * "이 작업 전으로 되돌리기" fixture. The request whose turn produced an approved change becomes
 * restorable. `restore=later` reports edits after it (the confirm sheet), `restore=evicted` a
 * checkpoint that is gone (the refusal toast). A restore only counts calls; the document is a sample.
 */
const restoreMode = params.get('restore');
const restoreState = {
  calls: 0,
  turnKey: null as string | null,
  ready: new Set<string>(),
  restored: new Set<string>(),
  rebinds: [] as Array<{ from: string; to: string | null }>,
};
const restoreListeners = new Set<() => void>();
const notifyRestore = () => { for (const listener of [...restoreListeners]) listener(); };
function restoreStatus(key: string): TurnRestoreStatus {
  if (!restoreState.ready.has(key)) return { kind: 'none' };
  if (restoreMode === 'evicted') return { kind: 'blocked', reason: 'evicted' };
  const restored = restoreState.restored.has(key);
  return { kind: 'ready', laterEdits: restoreMode === 'later' && !restored, alreadyRestored: restored };
}
function checkRestore(key: string): TurnRestoreResult {
  const status = restoreStatus(key);
  if (status.kind === 'blocked') return { ok: false, reason: status.reason };
  if (mock.bridge.isTurnRunning()) return { ok: false, reason: 'running' };
  return status.kind === 'ready' ? { ok: true } : { ok: false, reason: 'unavailable' };
}
const turnRestore: TurnRestoreControl = {
  noteTurnStart: (_threadId, key) => { restoreState.turnKey = key; },
  // A request the hub refused is taken out of the chat; a hub turn bound to it moves to the request before.
  rebindTurn: (_threadId, fromKey, toKey) => {
    restoreState.rebinds.push({ from: fromKey, to: toKey });
    if (restoreState.turnKey === fromKey) restoreState.turnKey = toKey;
  },
  status: (_threadId, key) => restoreStatus(key),
  check: (_threadId, key) => checkRestore(key),
  restore: (_threadId, key) => {
    const checked = checkRestore(key);
    if (!checked.ok) return checked;
    restoreState.calls += 1;
    restoreState.restored.add(key);
    eventBus.emit('document-changed');
    notifyRestore();
    return { ok: true };
  },
  subscribe: (listener) => {
    restoreListeners.add(listener);
    return () => { restoreListeners.delete(listener); };
  },
};
/*
 * `chats=sample&reload=running|question` mounts the sidebar as after a reload while the hub still
 * runs the 사업 제안서 chat's turn (and, for `question`, waits on its question). Without
 * `chats=sample` the chat is not seeded again, so a second load keeps what the first one stored
 * (its queued follow-ups, for example).
 */
const reload = params.get('reload');
/*
 * `reload=ended|failed`: the chat's turn ended (or failed) while the page reloaded — the hub replays
 * that turn-end before its welcome, which reports the session idle. The sidebar must apply it to
 * the re-adopted chat, not to the empty startup draft. `reload=ended-error`: the hub replays the
 * turn's provider error and then a turn-end without a failure — the turn still failed.
 */
const liveChat = reload === 'running' || reload === 'question' || reload === 'ended' || reload === 'failed'
  || reload === 'ended-error'
  ? {
    threadId: SAMPLE_WORKING_CHAT_ID,
    agent: 'claude' as const,
    ...(reload === 'question' ? { question: sampleReloadQuestion() } : {}),
    ...(reload === 'ended' ? { ended: 'completed' as const } : reload === 'failed' ? { ended: 'failed' as const }
      : reload === 'ended-error' ? { ended: 'error' as const } : {}),
  }
  : undefined;
/*
 * 선물 크레딧. `gift=unclaimed|claimed|exhausted|off` 가 Pi 설정의 선물 줄과 `event=special` 창을 함께 정한다.
 * 받은 선물이 남아 있으면 Pi 상태의 credential 이 'gift' 다(순서가 '내 키 다음에'면 내 키가 먼저).
 * Pi 는 내 OpenRouter 키가 있는 상태로 시작한다. `pikey=none` 이면 키 없이 시작해 예전 창(받기만)이 뜬다.
 */
/*
 * 라이선스. `license=free|expired` 면 처음 설정에 라이선스 장이 생긴다. 선물(`gift=`)과 함께 주면
 * 앱처럼 키를 활성화한 뒤에야 선물이 보이고, 처음 설정 위에 선물 창이 뜬다.
 */
/*
 * 앱 요금제. `plan=free|hama|rau` 면 데스크톱 요금제 API 가 생긴다(없으면 웹처럼 잠금·↑ 단추 없음).
 * 요금제 카드의 '키 직접 입력'이 쓰도록 라이선스 대역도 무료 상태로 함께 둔다(HAMA- 키가 Hama 를 연다).
 */
/*
 * 계정. `account=signed-out|signing-in|choose-device|free|hama|rau|rau-trial|trial-ended|payment-failed|offline` 이면
 * 데스크톱 계정 API 가 생기고, `plan=` 이 없으면 요금제 대역도 계정의 등급과 로그인 여부를 따라 함께 생긴다.
 * `open=plans`(`&focus=hama|rau`)는 요금제 카드를, `open=account`(`&section=plan|devices|licenses|sign-in`)는 계정 페이지를
 * 띄운 채로 연다(스크린숏용).
 */
const accountScenario = mockAccountScenario(params);
const mockPlan = createMockPlan(mockPlanTier(params) ?? (accountScenario ? mockAccountTier(accountScenario) : null), {
  checkout: mockCheckoutMode(params),
  hold: params.get('checkoutHold') === '1',
  signedIn: accountScenario ? mockAccountSignedIn(accountScenario) : true,
  report,
});
const mockAccount = createMockAccount(accountScenario, {
  report,
  hold: params.get('accountHold') === '1',
  trialFailure: params.get('trialFail'),
});
if (mockAccount) {
  setAccountApi(mockAccount.api);
  // 로그인 여부와 등급은 계정이 정하고, 결제로 바뀐 등급은 계정에도 남는다.
  mockAccount.api.onChange((status) => {
    mockPlan?.setSignedIn(status.state === 'signed_in');
    if (mockPlan && mockPlan.status().tier !== status.plan.tier) mockPlan.setTier(status.plan.tier);
  });
  mockPlan?.api.onChange((status) => {
    // 체험 중에 Rau 를 사면 등급은 그대로라 결제 확인으로도 계정을 고친다.
    if (status.tier !== mockAccount.status().plan.tier || status.lastCheckout?.ok) mockAccount.setTier(status.tier);
  });
  listenForAccountPageEvents({ plan: mockPlan ? createPlanStore(mockPlan.api) : null });
}
/*
 * 계정 기억(Rau 탭). 허브의 쓸 수 있음은 요금제를 따른다 — rau(체험 포함)면 active, hama·free 면 not_eligible,
 * 요금제 API 가 없으면 웹 Studio 의 허브처럼 unavailable. `availability=` 가 고정하고, `userMemory=sample|empty|legacy`
 * 와 `styleLearn=hold|fail` 은 mock-user-memory.ts 가 읽는다.
 */
syncUserMemoryPlan(mockPlan?.status().tier ?? null);
mockPlan?.api.onChange((status) => syncUserMemoryPlan(status.tier));
const mockLicense = createMockLicense(
  mockPlan && mockLicenseMode(params) === 'off' ? 'free' : mockLicenseMode(params), report);
mockLicense?.onLicensed(() => {
  if (mockPlan && mockPlan.status().tier === 'free') mockPlan.setTier('hama');
});
/* 호스팅 Rau. `rau=free|rau|trial|exhausted` 가 설정 → Rau-0.1 의 Rau 줄을, `rau=upgrade` 는 입력창 위 업그레이드 칩도 띄운다. */
const mockRau = createMockRau(mockRauMode(params), report);
const mockGift = createMockGift(mockGiftMode(params), {
  failClaim: params.get('claim') === 'fail',
  locked: mockLicense !== null && mockLicenseMode(params) !== 'licensed',
});
mockLicense?.onLicensed(() => mockGift?.unlock());
const mock = createMockBridge(report, () => {
  undoState.entry = {};
  if (restoreState.turnKey) {
    restoreState.ready.add(restoreState.turnKey);
    notifyRestore();
  }
}, { liveChat, piGift: () => mockGift?.active() === true });
mockGift?.api.onChange(() => mock.syncPiStatus());
/** 업그레이드 단추·잠긴 Rau 탭이 앱에 띄워 달라는 요금제 카드. 요금제 대역이 있으면 진짜 카드가 뜨므로 기록만 한다. */
const planCardRequests: unknown[] = [];
window.addEventListener('rhwp:open-plan-card', (event) => {
  planCardRequests.push((event as CustomEvent).detail);
  if (!mockPlan) report('Plan card placeholder');
});
/** 자동 수정(데스크톱). `autofix=fixed|failed|unavailable|off|undecided`, 없으면 웹 빌드처럼 단추가 없다. */
const mockAutofix = createMockAutofix(params);
setAutofixApi(mockAutofix?.api ?? null);
// `hub=down`: 허브가 뜨지 않아 다시 연결이 실패한다. 자동 수정이 고치면 다시 붙는다.
if (params.get('hub') === 'down') {
  mock.setHubDown(true);
  mockAutofix?.onFixed(() => mock.setHubDown(false));
}
if (params.get('pikey') === 'none') mock.setPiOwnKey(false);
const previewProjects = mock.projects;
if (params.get('services') === 'setup') mock.setServices(false);
const eventBus = new EventBus();
const versions = createMockVersions(report, params.get('history') === 'branches');
// `document=empty` 는 문서 없이 시작한다 — 새로고침 뒤 이어 붙일 채팅의 문서가 아직 열리지 않은 상태.
const startsEmpty = params.get('document') === 'empty';
let documentId: string | null = startsEmpty ? null : 'preview-proposal';
let documentName: string | null = startsEmpty ? null : '사업 제안서.hwpx';
const recentDocuments = sampleRecentDocuments(Date.now());
let createdDocuments = 0;
const documentSelect = document.querySelector<HTMLSelectElement>('#document')!;
if (startsEmpty) documentSelect.value = 'empty';

/** Swap the mock document and announce it with the editor's document events. */
/** 미리보기의 문서 연결 — 편집기(main.ts)와 같은 순서로 사이드바를 부른다. 호출은 linkCalls 에 남는다. */
const linkCalls: ChatDocumentLinkTarget[] = [];
async function linkPreviewDocument(target: ChatDocumentLinkTarget): Promise<ChatDocumentLinked | null> {
  linkCalls.push(target);
  const threadId = sidebar.beginDocumentLink();
  if (!threadId) return null;
  if (target.kind === 'pick') {
    report('File picker placeholder');
    sidebar.cancelDocumentLink();
    return null;
  }
  const recent = target.kind === 'recent' ? recentDocuments.find((row) => row.documentId === target.documentId) : null;
  if (target.kind === 'recent' && !recent) {
    sidebar.cancelDocumentLink();
    return null;
  }
  if (!recent) createdDocuments += 1;
  const id = recent?.documentId ?? `preview-new-${createdDocuments}`;
  const name = recent?.fileName
    ?? (target.kind === 'new' && target.name ? `${target.name}.hwpx` : `새 문서 ${createdDocuments}.hwpx`);
  showMockDocument(id, name);
  await sidebar.completeDocumentLink({ documentId: id, docKey: name });
  report(`Linked ${name}`);
  return { documentId: id, name };
}

/**
 * 미리보기의 문서 떼기 — 편집기처럼 하마가 이름을 삼킨 뒤 문서를 내리고 같은 허브 세션에서 문서 없이 잇는다.
 * 편집기는 채팅을 새 세션으로 옮기지만 미리보기는 사이드바가 하나라 그 자리에서 마친다. 호출은 detachCalls 에 남는다.
 */
const detachCalls: Array<{ threadId: string; documentId: string | null; draft: boolean }> = [];
async function detachPreviewDocument(): Promise<boolean> {
  const detach = await sidebar.beginDocumentDetach();
  if (!detach) return false;
  detachCalls.push({ threadId: detach.threadId, documentId: detach.documentId, draft: detach.draft });
  const name = documentName;
  showMockDocument(null, null);
  const detached = sidebar.completeDocumentDetach();
  if (detached) report(`Detached ${name ?? 'the document'}`);
  return detached;
}

function showMockDocument(id: string | null, name: string | null): void {
  documentId = id;
  documentName = name;
  Object.assign(versions.getState(), { documentId, documentName, saved: !!documentId });
  const value = id ? id.replace(/^preview-/, '') : 'empty';
  if (id && name && ![...documentSelect.options].some((option) => option.value === value))
    documentSelect.add(new Option(name, value), documentSelect.options.length - 1);
  documentSelect.value = value;
  if (id && name) {
    const index = recentDocuments.findIndex((row) => row.documentId === id);
    const [row] = index >= 0 ? recentDocuments.splice(index, 1) : [{
      documentId: id, fileName: name, sourceFormat: name.split('.').pop() ?? 'hwpx', openedAt: 0,
    }];
    recentDocuments.unshift({ ...row, fileName: name, openedAt: Date.now() });
  }
  void versions.refresh();
  eventBus.emit('document-swapped');
  eventBus.emit('document-context-changed');
}

if (params.get('initial-setup') === 'deferred')
  saveInitialSetup({ completed: false, deferred: true });
else if (!params.has('initial-setup'))
  completeInitialSetup({
    providerStep: 'configured',
  });
if (params.get('width'))
  localStorage.setItem(
    'rhwp-agent-sidebar-width-v3',
    String(Math.min(900, Math.max(280, Number(params.get('width')) || 480))),
  );
if (!localStorage.getItem('sidebar-preview-seeded')) {
  userSettings.setUseHancomGit(true);
  localStorage.setItem('sidebar-preview-seeded', '1');
}
/*
 * `theme=light|dark|system`, `preset=<id>`, `accent=<hex>|default` set the theme before the first paint
 * (and keep it, like the settings would). `accent` accepts `ff6600`, `%23ff6600` or `#f60`.
 */
if (['light', 'dark', 'system'].includes(params.get('theme') ?? ''))
  userSettings.setThemeMode(params.get('theme') as 'light' | 'dark' | 'system');
if (params.has('preset')) userSettings.setThemePreset(normalizeThemePreset(params.get('preset')));
if (params.has('accent')) {
  const raw = params.get('accent') ?? '';
  userSettings.setThemeAccent(normalizeThemeAccent(raw.startsWith('#') ? raw : `#${raw}`));
}
initThemeSync();
if (params.get('editor') === '1') {
  mountEditorShell(report, eventBus);
  // 앱과 같이 명령 검색 왼쪽에 자동 수정 단추를 단다(`autofix=` 가 있고 켠 상태일 때).
  installManualAutofix({ reportIssue: () => report('버그 제보 · issue report fixture') });
}
if ((params.get('event') === 'special' || mockLicense) && mockGift) {
  // 앱과 같은 트리거로 띄운다. 기록은 메모리에만 남겨 새로고침하면 다시 뜬다.
  const records = new Map<string, string>();
  startSpecialEvent({
    gift: mockGift.api,
    storage: { getItem: (key) => records.get(key) ?? null, setItem: (key, value) => { records.set(key, value); } },
    whenReady: async () => {},
    isSetupActive: isInitialSetupActive,
    onSetupInactive: onInitialSetupInactive,
    occasion: () => (wasLicensedHere() ? 'license' : 'update'),
    pi: {
      status: () => mock.bridge.requestPiStatus(),
      setGiftOrder: async (order) => {
        if (params.get('order') === 'fail') throw new Error('sample save failure');
        await mock.bridge.setPiGiftOrder(order);
        report(`Gift order: ${order} (sample)`);
      },
    },
    open: async (options) => {
      const { openSpecialEventPopup } = await import('../ui/special-event/special-event-popup.ts');
      const result = await openSpecialEventPopup(options);
      report(`Special event closed: ${result} (sample)`);
      return result;
    },
  });
}

/** Swap the document of the primary session, as the editor's move does. */
async function moveDocument(
  target: { documentId: string | null; fileName: string | null },
  options?: { commit?: boolean },
): Promise<LibraryMoveResult> {
  if (!target.documentId && !target.fileName) return 'failed';
  if (target.documentId ? target.documentId === documentId : target.fileName === documentName)
    return 'same';
  await new Promise((resolve) => setTimeout(resolve, 150));
  if (options?.commit && documentId) report(`Committed "${documentName}" to version history (sample)`);
  if (!target.documentId) {
    report(`File picker placeholder for "${target.fileName}"`);
    return 'moved';
  }
  // As in the editor, the move resolves before the opened file swaps in.
  const id = target.documentId;
  const name = target.fileName
    ?? recentDocuments.find((row) => row.documentId === id)?.fileName ?? null;
  setTimeout(() => showMockDocument(id, name), 100);
  return 'moved';
}

/*
 * `sessions=2` adds a second live document (회의록) whose sidebar waits off-screen
 * with its own mock agent, like the editor's background document sessions. Opening
 * a chat of a live document attaches that session instead of reopening the file.
 */
const multiSession = params.get('sessions') === '2';
const BACKGROUND_DOCUMENT = { documentId: 'preview-notes', documentName: '회의록.hwpx' };
interface PreviewSession {
  sidebar: AgentSidebarHandle;
  mock: ReturnType<typeof createMockBridge>;
  documentId: () => string | null;
}
const sessions: PreviewSession[] = [];
let attachedSession = 0;

function attachSession(index: number): void {
  if (index === attachedSession || !sessions[index]) return;
  sessions[attachedSession]!.sidebar.deactivate();
  attachedSession = index;
  sessions[index]!.sidebar.activate();
}

async function openThreadDocument(
  thread: { id: string; documentId: string | null; docKey: string | null },
): Promise<LibraryMoveResult> {
  const owner = thread.documentId
    ? sessions.findIndex((session) => session.documentId() === thread.documentId)
    : -1;
  if (owner >= 0) {
    attachSession(owner);
    sessions[owner]!.sidebar.openThreadById(thread.id);
    return 'moved';
  }
  // No live session holds the document: the primary session opens it, as an idle editor session does.
  attachSession(0);
  sessions[0]!.sidebar.followThreadOnNextDocument(thread.id);
  return moveDocument({ documentId: thread.documentId, fileName: thread.docKey }, { commit: true });
}

/*
 * `parallel=1` gives the proposal document several chats, like the editor when a chat is busy:
 * a new chat or another chat of the document opens in its own sidebar with its own mock agent,
 * and the busy agent keeps running. While one chat edits, the others may only use 채팅.
 * `parallel=locked` opens on that state: the first chat edits with a held reply and a second,
 * locked new chat is shown.
 */
const parallel = params.get('parallel');
const parallelChats = parallel === '1' || parallel === 'locked';
interface PreviewChat {
  sidebar: AgentSidebarHandle;
  mock: ReturnType<typeof createMockBridge>;
}
type OpenChatRequest = { kind: 'new' } | { kind: 'thread'; threadId: string };
const chats: PreviewChat[] = [];
let shownChat = 0;
const openChatCalls: Array<{ chat: number; request: OpenChatRequest }> = [];
const modeLockListeners = new Set<() => void>();
const CHAT_MODE_LOCK = { reason: '다른 채팅이 이 문서를 편집하고 있어요' };

/** Busy as the editor counts it: a running turn, a question, or unreviewed edits. */
function chatBusy(chat: PreviewChat): boolean {
  const state = chat.mock.snapshot();
  return state.running || state.pendingChanges > 0 || chat.mock.bridge.getPendingUserQuestion() !== null;
}

/** A chat holds the document while it edits or leaves edits to review. */
function chatEditing(chat: PreviewChat): boolean {
  const state = chat.mock.snapshot();
  const writes = state.workflow.workflow === 'direct' || state.workflow.phase === 'implementing';
  return (state.running && writes) || state.pendingChanges > 0;
}

function chatModeLockFor(index: number) {
  return {
    get: () => (chats.some((chat, other) => other !== index && chatEditing(chat)) ? CHAT_MODE_LOCK : null),
    subscribe: (listener: () => void) => {
      modeLockListeners.add(listener);
      return () => { modeLockListeners.delete(listener); };
    },
  };
}

function watchChatModeLock(chat: PreviewChat): void {
  const notify = () => { for (const listener of [...modeLockListeners]) listener(); };
  chat.mock.bridge.onEditingLeaseChange(notify);
  chat.mock.bridge.pendingEdits.onChange(notify);
  chat.mock.bridge.onEvent((event) => {
    if (event.type === 'workflow-changed' || event.type === 'chat-started') notify();
  });
}

function showChat(index: number): void {
  if (index === shownChat || !chats[index]) return;
  chats[shownChat]!.sidebar.deactivate();
  shownChat = index;
  chats[index]!.sidebar.activate();
}

/** The editor's openChat: a busy chat stays put and the request opens in another chat. */
async function openChatFrom(index: number, request: OpenChatRequest): Promise<'handled' | 'local'> {
  openChatCalls.push({ chat: index, request });
  if (request.kind === 'thread') {
    const holder = chats.findIndex((chat, other) => (
      other !== index && chat.sidebar.currentThreadId() === request.threadId
    ));
    if (holder >= 0) {
      showChat(holder);
      return 'handled';
    }
  }
  if (!chatBusy(chats[index]!)) return 'local';
  const fresh = createParallelChat();
  showChat(chats.indexOf(fresh));
  if (request.kind === 'new') fresh.sidebar.startDraftChat();
  else fresh.sidebar.openThreadById(request.threadId);
  return 'handled';
}

/** Another chat of the proposal document with its own sidebar and mock agent. */
function createParallelChat(): PreviewChat {
  const index = chats.length;
  const chatMock = createMockBridge(report);
  const chatBus = new EventBus();
  for (const name of ['document-swapped', 'document-context-changed'] as const) {
    eventBus.on(name, () => chatBus.emit(name));
  }
  const chatSidebar = initAgentSidebar({
    bridge: chatMock.bridge,
    eventBus: chatBus,
    startActive: false,
    getDocumentContext: () => ({ documentId, documentName, selectionLabel: null }),
    moveToLibraryDocument: moveDocument,
    listRecentDocuments: async () => recentDocuments.map((row) => ({ ...row })),
    openChat: (request) => openChatFrom(index, request),
    chatModeLock: chatModeLockFor(index),
    attention,
  });
  chatMock.boot();
  const chat = { sidebar: chatSidebar, mock: chatMock };
  chats.push(chat);
  watchChatModeLock(chat);
  return chat;
}

/*
 * `questionHeld=1` shows a question that arrived while the reviewer was typing. Page scripts
 * cannot produce trusted keystrokes, so this fixture holds the "typing" state from start()
 * until the real activity settles (a strip click, focus leaving a text field, a send).
 */
function createTypingHold() {
  const real = typingActivity();
  let holding = false;
  real.onSettle(() => { holding = false; });
  const activity: TypingActivity = {
    isTyping: (holdsComposition) => holding || real.isTyping(holdsComposition),
    onSettle: (listener) => real.onSettle(listener),
    noteSend: () => real.noteSend(),
    dispose: () => {},
  };
  return { activity, start: () => { holding = true; } };
}
const typingHold = params.get('questionHeld') === '1' ? createTypingHold() : null;

const sidebar = initAgentSidebar({
  bridge: mock.bridge,
  eventBus,
  typingActivity: typingHold?.activity,
  attention,
  // '리셋 후 이어서' 를 몇 초 안에 볼 수 있게 시계 차이 여유를 줄인다 (앱은 30초).
  failureResumeGraceMs: 500,
  getDocumentContext: () => ({
    documentId,
    documentName,
    selectionLabel: null,
  }),
  moveToLibraryDocument: moveDocument,
  openThreadDocument: multiSession ? openThreadDocument : undefined,
  openChat: parallelChats ? (request) => openChatFrom(0, request) : undefined,
  chatModeLock: parallelChats ? chatModeLockFor(0) : undefined,
  createDocument: () => {
    createdDocuments += 1;
    showMockDocument(`preview-new-${createdDocuments}`, `새 문서 ${createdDocuments}.hwpx`);
  },
  openDocumentFile: () => report('File picker placeholder'),
  // 데스크톱의 문제 보고. 끊김 안내와 끊긴 턴 줄의 '버그 제보' 단추를 보이게 한다.
  reportIssue: () => report('Issue report placeholder'),
  // 문서 없는 채팅에 문서 잇기 — 편집기처럼 연결을 알리고, 표본 문서를 연 뒤 이 채팅에 잇는다.
  linkDocument: (target) => linkPreviewDocument(target),
  detachDocument: () => detachPreviewDocument(),
  listRecentDocuments: async () => recentDocuments.map((row) => ({ ...row })),
  // @ 의 문서 묶음 — 표본 최근 문서 (지금 문서는 뺀다).
  listMentionDocuments: async () => recentDocuments
    .filter((row) => row.documentId !== documentId)
    .map((row) => ({ documentId: row.documentId, title: row.fileName, open: false })),
  versionController: versions,
  getAgentUndoEntry: () => undoState.entry,
  undoAgentTurn: (entry) => {
    if (entry !== undoState.entry) return false;
    undoState.entry = null;
    undoState.calls += 1;
    void versions.discardUncommitted();
    eventBus.emit('history-jumped');
    return true;
  },
  turnRestore,
  gift: mockGift?.api ?? null,
  license: mockLicense?.api ?? null,
  rau: mockRau,
  plan: mockPlan?.api ?? null,
  // 웹 빌드처럼 창 세션만 안다(앱 실행 id 는 데스크톱만). 이 사이드바가 창의 기본 허브 세션을 쓴다.
  interruptionScope: () => ({ windowSessionId: PREVIEW_WINDOW_SESSION_ID, appLaunchId: null }),
  ownsWindowSession: true,
  navigateToChange: (position, target) => {
    navigation.calls.push(position);
    navigation.targets.push(target);
  },
  openClassicVersionControl: () =>
    report('Classic document history placeholder'),
  // 문서 보기 설정은 편집기 엔진이 없어 반영할 곳이 없다. 테마는 core/theme.ts 가 직접 건다.
  editorSettingsRuntime: {
    preview: (settings) => applyPreviewCompactToolbar(settings.view.compactToolbar),
    committed: (settings) => applyPreviewCompactToolbar(settings.view.compactToolbar),
  },
});
mock.boot();
if (params.get('hub') === 'down') mock.setConnection('disconnected');
/* `home=1`: 문서 홈(표본 최근 문서). Hama 요금제면 위 막대에 Rau 입구가 선다. */
const home = params.get('home') === '1'
  ? mountHomeScene({
    plan: mockPlan ? createPlanStore(mockPlan.api) : null,
    license: mockLicense?.api ?? null,
    account: mockAccount ? accountStore() : null,
    report,
  })
  : null;
const projectScene = createProjectScene(sidebar);
sessions.push({ sidebar, mock, documentId: () => documentId });
chats.push({ sidebar, mock });
if (parallelChats) watchChatModeLock(chats[0]!);
if (multiSession) {
  const backgroundMock = createMockBridge(report);
  backgroundMock.setScenario('chat');
  const backgroundSidebar = initAgentSidebar({
    bridge: backgroundMock.bridge,
    eventBus: new EventBus(),
    startActive: false,
    getDocumentContext: () => ({ ...BACKGROUND_DOCUMENT, selectionLabel: null }),
    attention,
    moveToLibraryDocument: (target, options) => {
      attachSession(0);
      return moveDocument(target, options);
    },
    listRecentDocuments: async () => recentDocuments.map((row) => ({ ...row })),
    openThreadDocument,
  });
  backgroundMock.boot();
  sessions.push({ sidebar: backgroundSidebar, mock: backgroundMock, documentId: () => BACKGROUND_DOCUMENT.documentId });
}
if (params.get('chats') === 'sample' || params.get('chats') === 'engine-trap') {
  // 새로고침 뒤에는 옛 페이지가 떠나며(pagehide) 자기 작업 신호를 지웠다 — 허브가 아직 그 턴을 돌려도,
  // 끝났거나 사라졌어도 그 채팅의 노란 불은 없다. 다시 잡은 사이드바가 다시 켠다.
  if (reload === null) markChatWorking(SAMPLE_WORKING_CHAT_ID);
  markChatFinished(SAMPLE_FINISHED_CHAT_ID);
  markChatNeedsReview(SAMPLE_REVIEW_CHAT_ID);
  markChatFailed(SAMPLE_INTERRUPTED_CHAT_ID, { label: '중단됨' });
}
/** The shown chat's 열기 from a toast or notification — the same path as a rail click. */
function openFromAttention(threadId: string): void {
  const shown = parallelChats ? chats[shownChat] : sessions[attachedSession];
  shown?.sidebar.openThreadFromHost(threadId);
}
installAttentionToasts(attention, openFromAttention);

const scenarioSelect = document.querySelector<HTMLSelectElement>('#scenario')!;
for (const name of scenarios)
  scenarioSelect.add(new Option(name[0].toUpperCase() + name.slice(1), name));
const initialScenario = params.get('scenario');
if (scenarios.includes(initialScenario as Scenario))
  scenarioSelect.value = initialScenario!;
mock.setScenario(scenarioSelect.value as Scenario);
// 압축 장면의 hold 는 압축 턴에만 건다 — 앞의 답변은 끝나야 압축할 수 있다.
mock.setHold(params.get('hold') === '1' && params.get('compact') !== '1');
// 오류 시나리오의 실패 유형 — 알림 종류마다 URL 하나로 열린다 (?scenario=error&failure=usage).
const failureSelect = document.querySelector<HTMLSelectElement>('#failure')!;
for (const kind of failureKinds) failureSelect.add(new Option(kind, kind));
const initialFailure = params.get('failure');
if (failureKinds.includes(initialFailure as FailureKind)) failureSelect.value = initialFailure!;
mock.setFailureKind(failureSelect.value as FailureKind);
failureSelect.addEventListener('change', () => {
  mock.setFailureKind(failureSelect.value as FailureKind);
  const url = new URL(location.href);
  url.searchParams.set('failure', failureSelect.value);
  history.replaceState(null, '', url);
});
scenarioSelect.addEventListener('change', () => {
  mock.bridge.interrupt();
  mock.bridge.setWorkflow('direct');
  mock.setScenario(scenarioSelect.value as Scenario);
  const url = new URL(location.href);
  url.searchParams.set('scenario', scenarioSelect.value);
  history.replaceState(null, '', url);
});
/** Sends the sample request from the shown chat's composer. */
function playSample(): void {
  const input = chats[shownChat]!.sidebar.root.querySelector<HTMLTextAreaElement>('.ag-input')!;
  input.value = '이 문서의 핵심 내용을 검토하고 개선해 주세요.';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.form?.requestSubmit();
}
document.querySelector('#play')!.addEventListener('click', playSample);
const connection = document.querySelector<HTMLSelectElement>('#connection')!;
connection.addEventListener('change', () =>
  mock.setConnection(
    connection.value as ReturnType<typeof mock.bridge.getConnectionState>,
  ),
);
mock.bridge.onEvent((event) => {
  if (event.type === 'connection') connection.value = event.state;
});
const services = document.querySelector<HTMLSelectElement>('#services')!;
services.value = params.get('services') === 'setup' ? 'setup' : 'ready';
services.addEventListener('change', () => {
  mock.bridge.interrupt();
  mock.setServices(services.value === 'ready');
  eventBus.emit('settings:open', { destination: 'ai-connection' });
});
const autofixSelect = document.querySelector<HTMLSelectElement>('#autofix')!;
for (const outcome of mockAutofixOutcomes) autofixSelect.add(new Option(outcome, outcome));
autofixSelect.closest('label')!.hidden = !mockAutofix;
if (mockAutofix) autofixSelect.value = mockAutofix.outcome();
autofixSelect.addEventListener('change', () => mockAutofix?.setOutcome(autofixSelect.value as AutofixStatus));
const planSelect = document.querySelector<HTMLSelectElement>('#plan')!;
const checkoutSelect = document.querySelector<HTMLSelectElement>('#checkout')!;
for (const tier of mockPlanTiers) planSelect.add(new Option(tier, tier));
for (const mode of mockCheckoutModes) checkoutSelect.add(new Option(mode, mode));
planSelect.closest('label')!.hidden = !mockPlan;
checkoutSelect.closest('label')!.hidden = !mockPlan;
if (mockPlan) {
  planSelect.value = mockPlan.status().tier;
  checkoutSelect.value = mockCheckoutMode(params);
  mockPlan.api.onChange((status) => { planSelect.value = status.tier; });
}
planSelect.addEventListener('change', () => mockPlan?.setTier(planSelect.value as PlanTier));
const accountSelect = document.querySelector<HTMLSelectElement>('#account')!;
for (const scenario of mockAccountScenarios) accountSelect.add(new Option(scenario, scenario));
accountSelect.closest('label')!.hidden = !mockAccount;
if (accountScenario) accountSelect.value = accountScenario;
accountSelect.addEventListener('change', () => mockAccount?.setScenario(accountSelect.value as MockAccountScenario));
checkoutSelect.addEventListener('change', () => mockPlan?.setCheckout(checkoutSelect.value as MockCheckoutMode));
const theme = document.querySelector<HTMLSelectElement>('#theme')!;
theme.value = userSettings.getThemeSettings().mode;
theme.addEventListener('change', () =>
  setThemeMode(theme.value as 'light' | 'dark' | 'system'),
);
const presetSelect = document.querySelector<HTMLSelectElement>('#preset')!;
for (const preset of THEME_PRESET_LIST) presetSelect.add(new Option(preset.label, preset.id));
presetSelect.value = userSettings.getThemeSettings().preset;
presetSelect.addEventListener('change', () => setThemePreset(normalizeThemePreset(presetSelect.value)));
// Screenshot scripts drive the theme the same way as the editor's dev build.
Object.assign(window, {
  __theme: {
    getThemeMode,
    getEffectiveTheme,
    getThemeSettings,
    setThemeMode,
    setPreset: setThemePreset,
    setAccent: setThemeAccent,
  },
});
documentSelect.addEventListener('change', () => {
  const empty = documentSelect.value === 'empty';
  showMockDocument(
    empty ? null : `preview-${documentSelect.value}`,
    empty ? null : documentSelect.selectedOptions[0].text,
  );
});
// 문서 없는 채팅: 문서 잇기(칩과 하마), 저장 안내 줄. 문서가 있으면 먼저 비운다.
function previewUnlinkedChat(): boolean {
  if (sidebar.isUnlinkedChat()) return true;
  report('Choose Document → No document and start a new chat first');
  return false;
}
document.querySelector('#link-document')!.addEventListener('click', () => {
  if (previewUnlinkedChat()) void sidebar.linkCurrentChat({ kind: 'new' });
});
document.querySelector('#detach-document')!.addEventListener('click', () => {
  if (sidebar.isUnlinkedChat()) report('The shown chat has no document');
  else void detachPreviewDocument();
});
document.querySelector('#save-gate')!.addEventListener('click', () => {
  if (previewUnlinkedChat()) mock.emitDocumentRequired('project_edit');
});
document.querySelector('#rau-upgrade')!.addEventListener('click', () => mock.emitRauUpgrade(MOCK_RAU_UPGRADE_URL));
// 한 턴의 학습이 문서 기억과 계정 기억을 함께 바꾼 구분선 — 보이는 채팅에 붙는다.
const rauMemoryLearned = document.createElement('button');
rauMemoryLearned.id = 'rau-memory-learned';
rauMemoryLearned.title = 'Rau-0.1 taught a document note and changed the long-term memory (장기기억 승격, 보강, 감쇄)';
rauMemoryLearned.textContent = 'Rau memory learned';
document.querySelector('#rau-upgrade')!.after(rauMemoryLearned);
rauMemoryLearned.addEventListener('click', () => {
  const shown = chats[shownChat]!;
  const threadId = shown.sidebar.currentThreadId();
  if (!threadId) {
    report('Start or open a chat first');
    return;
  }
  shown.mock.emitAccountTasteLearned(threadId);
});
if (mockRauMode(params) === 'upgrade') mock.emitRauUpgrade(MOCK_RAU_UPGRADE_URL);
document
  .querySelector('#settings')!
  .addEventListener('click', () =>
    eventBus.emit('settings:open', { destination: 'editing' }),
  );
document
  .querySelector('#versions')!
  .addEventListener('click', () => sidebar.openVersions());
document.querySelector('#reset')!.addEventListener('click', () => {
  const url = new URL(location.href);
  url.searchParams.set('reset', '1');
  location.replace(url);
});
// External destinations are represented locally; never launch an OAuth page.
const openLocalWindow = window.open.bind(window);
window.open = (url, target, features) => {
  if ((!url || url === 'about:blank') && target === 'rhwp-owned-browser') return openLocalWindow(url, target, features);
  report('External page placeholder');
  return null;
};
document.addEventListener(
  'click',
  (event) => {
    const anchor = (event.target as Element).closest?.('a[href]');
    if (anchor && !anchor.hasAttribute('data-preview-navigation') && !anchor.getAttribute('href')?.startsWith('#')) {
      event.preventDefault();
      event.stopImmediatePropagation();
      report('Linked document or external page placeholder');
    }
  },
  { capture: true },
);
if (params.get('controls') === '0')
  document.querySelector('#preview-controls')!.setAttribute('hidden', '');
/** Focus mode through the same agent command the native menu sends. */
async function enterFocusMode(): Promise<void> {
  window.dispatchEvent(new CustomEvent('rhwp:agent-command', { detail: { command: 'toggle-focus-chat' } }));
  while (!sidebar.root.classList.contains('ag-fullscreen'))
    await new Promise((resolve) => requestAnimationFrame(resolve));
}
// Open the requested view after the sidebar restores its saved conversation.
if (params.get('page') === 'settings' || params.get('page') === 'versions')
  await sidebar.startupChatSettled();
if (params.get('fullscreen') === '1') await enterFocusMode();
if (params.get('page') === 'settings') {
  const requestedDestination = params.get('destination');
  eventBus.emit('settings:open', { destination: isSettingsDestination(requestedDestination) ? requestedDestination : 'editing' });
}
if (params.get('page') === 'versions') sidebar.openVersions();
// `open=plans` / `open=account`: 요금제 카드나 계정 페이지를 띄운 채로 시작한다.
if (params.get('open') === 'plans' && mockPlan) {
  await sidebar.startupChatSettled();
  const focus = params.get('focus');
  window.dispatchEvent(new CustomEvent('rhwp:open-plan-card', { detail: focus === 'hama' || focus === 'rau' ? { focus } : {} }));
}
if (params.get('open') === 'account' && mockAccount) {
  await sidebar.startupChatSettled();
  const section = params.get('section');
  window.dispatchEvent(new CustomEvent('rhwp:open-account', {
    detail: section === 'plan' || section === 'devices' || section === 'licenses' || section === 'sign-in' ? { section } : {},
  }));
}
// `styleLearn=run|hold|fail`: a style-learning run from "another window" is already going when the page opens.
if (['run', 'hold', 'fail'].includes(params.get('styleLearn') ?? '')) {
  await sidebar.startupChatSettled();
  userMemoryControls.startSampleStyleLearn();
}
// `memory=sample` / `memory=empty`: the 문서 기억 sheet of the shown document (mock store in mock-document-memory.ts).
if (params.has('memory')) {
  await sidebar.startupChatSettled();
  sidebar.openDocumentMemory();
}
const projectTab = params.get('project');
if (projectTab === 'board' || projectTab === 'graph' || projectTab === 'files') {
  await waitForThreadsPersistence();
  await projectScene.open({ tab: projectTab, itemId: params.get('item') ?? undefined });
}

/** `parallel=locked`: the first chat edits with a held reply, then a new chat opens beside it. */
async function openLockedParallelScene(): Promise<void> {
  const until = async (ready: () => boolean) => {
    while (!ready()) await new Promise((resolve) => setTimeout(resolve, 20));
  };
  // The restored chat starts first; the scene is played on top of it.
  await sidebar.startupChatSettled();
  const modeButton = sidebar.root.querySelector<HTMLButtonElement>('.ag-mode-btn')!;
  await until(() => sidebar.root.dataset.composerReady === 'true' && !modeButton.disabled);
  // A restored chat may be in another mode; the first chat edits in 에이전트.
  if (modeButton.dataset.mode !== 'agent') {
    modeButton.click();
    sidebar.root.querySelector<HTMLButtonElement>('.ag-mode-item[data-mode="agent"]')!.click();
    await until(() => modeButton.dataset.mode === 'agent' && sidebar.root.dataset.composerReady === 'true');
  }
  mock.setHold(true);
  playSample();
  await until(() => chatEditing(chats[0]!));
  sidebar.root.querySelector<HTMLButtonElement>('.ag-threads-new')!.click();
  await until(() => chats.length > 1 && chats[shownChat]!.sidebar.root.classList.contains('ag-fullscreen'));
}
// 잠긴 두 번째 채팅은 전체 화면에서만 보인다. fullscreen=1 이 없어도 장면이 열리게 먼저 들어간다.
if (parallel === 'locked') {
  if (!sidebar.root.classList.contains('ag-fullscreen')) await enterFocusMode();
  await openLockedParallelScene();
}

/**
 * 입력기 위 하마의 몸짓. `hama=stamp`(HAMA_SHOWCASE 의 이름)는 하마를 켜고 그 몸짓을 4.5초마다 되풀이한다.
 * 컨트롤의 Hama 목록은 몸짓 하나를 바로 하거나, 앱 순간의 실제 편집기 이벤트를 보낸다(쉬는 중·간격 규칙을 따른다).
 */
const HAMA_MOMENTS: Record<string, [string, unknown?]> = {
  'moment:saved': ['document-saved', { reason: 'save', fileName: '사업 제안서.hwpx', sourceFormat: 'hwpx' }],
  'moment:exported': ['document-exported', { format: 'pdf', fileName: '사업 제안서.pdf' }],
  'moment:undone': ['history-jumped'],
  'moment:opened': ['document-swapped'],
};
function showHama(): void {
  const settings = userSettings.getEditorScalarSettings();
  if (settings.view.showHama) return;
  settings.view.showHama = true;
  userSettings.tryApplyEditorScalarSettings(settings);
}
const hamaSelect = document.querySelector<HTMLSelectElement>('#hama-action')!;
for (const name of HAMA_SHOWCASE) hamaSelect.add(new Option(name, name));
for (const key of Object.keys(HAMA_MOMENTS)) hamaSelect.add(new Option(key.replace('moment:', 'event: '), key));
function playHama(value: string): void {
  showHama();
  const moment = HAMA_MOMENTS[value];
  if (moment) {
    const [event, payload] = moment;
    eventBus.emit(event, ...(payload === undefined ? [] : [payload]));
    report(`Hama event ${event}`);
    return;
  }
  // 설정이 바뀐 뒤 하마가 붙기까지 한 프레임 기다린다.
  requestAnimationFrame(() => {
    if (!sidebar.playHama(value as HamaActionName)) report('Hama is off');
  });
}
document.querySelector('#hama-play')!.addEventListener('click', () => playHama(hamaSelect.value));
const hamaParam = params.get('hama');
if (hamaParam && (HAMA_SHOWCASE as readonly string[]).includes(hamaParam)) {
  hamaSelect.value = hamaParam;
  showHama();
  await sidebar.startupChatSettled();
  const loop = (): void => {
    playHama(hamaParam);
    window.setTimeout(loop, 4500);
  };
  loop();
}

// Typed hooks for browser checks and custom scenario scripts.
const preview = { ...mock, sidebar, versions, eventBus, enterFocusMode, undoState, restoreState, navigation, typingHold, linkCalls, detachCalls,
  gift: mockGift,
  planCardRequests,
  autofix: mockAutofix,
  plan: mockPlan,
  account: mockAccount,
  home,
  sessions, attachSession, chats, showChat, openChatCalls, attention, attentionNotices, attentionCounts,
  openFromAttention,
  projects: previewProjects, projectScene, localPasswords,
  taste: { undos: tasteUndos, skipUndo: skipTasteUndo },
  userMemory: userMemoryControls,
  threadStore: { listThreads, getThread, upsertThread, waitForThreadsPersistence },
  chatStatus: { markChatWorking, getChatStatus, getChatStatusLabel } };
export type SidebarPreview = typeof preview;
Object.assign(window, { sidebarPreview: preview });
if (params.get('audit') === '1') {
  document.body.classList.add('preview-audit');
  const controls = document.querySelector<HTMLElement>('#preview-controls')!;
  const advanced = document.createElement('details');
  advanced.className = 'audit-controls';
  const summary = document.createElement('summary');
  summary.textContent = 'Fixture controls';
  advanced.append(summary, ...controls.children);
  controls.append(advanced);
  const navigation = document.createElement('section');
  controls.prepend(navigation);
  mountAuditNavigator(navigation, params);
  const dialogs = document.createElement('section');
  controls.append(dialogs);
  mountAuditDialogs(dialogs, report);
  dialogs.hidden = true;
  const tabs = document.createElement('div');
  tabs.className = 'audit-tabs';
  for (const title of ['Scenes', 'Editor dialogs']) {
    const button = document.createElement('button');
    button.textContent = title;
    button.type = 'button';
    button.setAttribute('aria-pressed', String(title === 'Scenes'));
    button.addEventListener('click', () => {
      navigation.hidden = title !== 'Scenes';
      dialogs.hidden = title !== 'Editor dialogs';
      for (const sibling of tabs.querySelectorAll('button'))
        sibling.setAttribute('aria-pressed', String(sibling === button));
    });
    tabs.append(button);
  }
  const viewControls = document.createElement('div');
  viewControls.className = 'audit-view-controls';
  viewControls.append(theme.closest('label')!);
  const widthLabel = document.createElement('label');
  widthLabel.textContent = 'Sidebar width';
  const widthSelect = document.createElement('select');
  widthSelect.id = 'audit-width';
  for (const value of [280, 360, 480, 640, 840]) widthSelect.add(new Option(`${value}px`, String(value)));
  widthSelect.value = params.get('width') ?? '480';
  widthSelect.addEventListener('change', () => {
    const url = new URL(location.href);
    url.searchParams.set('width', widthSelect.value);
    location.href = url.href;
  });
  theme.addEventListener('change', () => {
    const url = new URL(location.href);
    url.searchParams.set('theme', theme.value);
    history.replaceState(null, '', url);
    params.set('theme', theme.value);
    for (const link of controls.querySelectorAll<HTMLAnchorElement>('[data-preview-navigation]')) {
      const target = new URL(link.href);
      target.searchParams.set('theme', theme.value);
      link.href = target.href;
    }
  });
  widthLabel.append(widthSelect);
  viewControls.append(widthLabel);
  controls.prepend(viewControls, tabs);
}
void mountCitationScenes(preview, params).catch((error: unknown) => {
  status.value = error instanceof Error ? error.message : 'Citation scene could not be prepared';
});
void applyAuditState(preview, params).catch((error: unknown) => {
  status.value = error instanceof Error ? error.message : 'Preview state could not be prepared';
  document.body.dataset.auditReady = 'error';
});
window.addEventListener('pagehide', () => {
  for (const session of sessions) {
    session.sidebar.dispose();
    session.mock.bridge.dispose();
  }
  for (const chat of chats.slice(1)) {
    chat.sidebar.dispose();
    chat.mock.bridge.dispose();
  }
  versions.dispose?.();
});
