import './browser-compat.ts';
import '../style.css';
import './preview.css';
import { initAgentSidebar, type AgentSidebarHandle } from '../ui/agent-sidebar/index.ts';
import { EventBus } from '../core/event-bus.ts';
import { applyTheme, setThemeMode } from '../core/theme.ts';
import { createMockBridge, scenarios, type Scenario } from './mock-bridge.ts';
import { createMockVersions } from './mock-versions.ts';
import { showToast } from '../ui/toast.ts';
import { userSettings } from '../core/user-settings.ts';
import { completeInitialSetup, saveInitialSetup } from '../ui/initial-setup/state.ts';
import { listThreads, getThread, waitForThreadsPersistence } from '../agent/threads.ts';
import { markChatFinished, markChatWorking } from '../agent/chat-status.ts';
import type { LibraryMoveResult } from '../library/move-to-document.ts';
import {
  SAMPLE_FINISHED_CHAT_ID,
  SAMPLE_WORKING_CHAT_ID,
  sampleRecentDocuments,
} from './fixtures.ts';
import { normalizeSettingsDestination } from '../ui/agent-sidebar/settings-contract.ts';
import { mountAuditNavigator } from './audit-scenarios.ts';
import { mountAuditDialogs } from './audit-dialogs.ts';
import { applyAuditState } from './audit-state.ts';
import { mountEditorShell } from './editor-shell.ts';
import { createProjectScene } from './project-scene.ts';
import { mountCitationScenes } from './mock-citations.ts';

const params = new URLSearchParams(location.search);
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
const undoState = { entry: null as object | null, calls: 0 };
const navigation = { calls: [] as Array<{ sectionIndex: number; paragraphIndex: number; charOffset: number }> };
const mock = createMockBridge(report, () => { undoState.entry = {}; });
const previewProjects = mock.projects;
if (params.get('services') === 'setup') mock.setServices(false);
const eventBus = new EventBus();
const versions = createMockVersions(report, params.get('history') === 'branches');
let documentId: string | null = 'preview-proposal';
let documentName: string | null = '사업 제안서.hwpx';
const recentDocuments = sampleRecentDocuments(Date.now());
let createdDocuments = 0;
const documentSelect = document.querySelector<HTMLSelectElement>('#document')!;

/** Swap the mock document and announce it with the editor's document events. */
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
    calibrationStep: 'skipped',
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
applyTheme();
if (params.get('editor') === '1') mountEditorShell(report, eventBus);

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
  });
  chatMock.boot();
  const chat = { sidebar: chatSidebar, mock: chatMock };
  chats.push(chat);
  watchChatModeLock(chat);
  placeholderFocusButton(chatSidebar);
  return chat;
}

const sidebar = initAgentSidebar({
  bridge: mock.bridge,
  eventBus,
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
  listRecentDocuments: async () => recentDocuments.map((row) => ({ ...row })),
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
  navigateToChange: (position) => { navigation.calls.push(position); },
  openClassicVersionControl: () =>
    report('Classic document history placeholder'),
  editorSettingsRuntime: {
    preview: (settings) => {
      applyTheme(settings.theme.mode);
    },
    committed: (settings) => {
      applyTheme(settings.theme.mode);
    },
  },
});
mock.boot();
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
if (params.get('chats') === 'sample') {
  markChatWorking(SAMPLE_WORKING_CHAT_ID);
  markChatFinished(SAMPLE_FINISHED_CHAT_ID);
}

const scenarioSelect = document.querySelector<HTMLSelectElement>('#scenario')!;
for (const name of scenarios)
  scenarioSelect.add(new Option(name[0].toUpperCase() + name.slice(1), name));
const initialScenario = params.get('scenario');
if (scenarios.includes(initialScenario as Scenario))
  scenarioSelect.value = initialScenario!;
mock.setScenario(scenarioSelect.value as Scenario);
// 압축 장면의 hold 는 압축 턴에만 건다 — 앞의 답변은 끝나야 압축할 수 있다.
mock.setHold(params.get('hold') === '1' && params.get('compact') !== '1');
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
  eventBus.emit('settings:open', { destination: 'ai' });
});
const theme = document.querySelector<HTMLSelectElement>('#theme')!;
if (['light', 'dark', 'system'].includes(params.get('theme') ?? ''))
  setThemeMode(params.get('theme') as 'light' | 'dark' | 'system');
theme.value = userSettings.getThemeSettings().mode;
theme.addEventListener('change', () =>
  setThemeMode(theme.value as 'light' | 'dark' | 'system'),
);
documentSelect.addEventListener('change', () => {
  const empty = documentSelect.value === 'empty';
  showMockDocument(
    empty ? null : `preview-${documentSelect.value}`,
    empty ? null : documentSelect.selectedOptions[0].text,
  );
});
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
// Keep the production focus button visible while staying within the sidebar-only scope.
function placeholderFocusButton(target: AgentSidebarHandle): void {
  target.root.querySelector('.ag-fullscreen-btn')!.addEventListener(
    'click',
    (event) => {
      event.stopImmediatePropagation();
      report('Focus mode opens the full workspace in the application.');
    },
    { capture: true },
  );
}
for (const session of sessions) placeholderFocusButton(session.sidebar);
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
  await waitForThreadsPersistence();
if (params.get('fullscreen') === '1') await enterFocusMode();
if (params.get('page') === 'settings')
  eventBus.emit('settings:open', { destination: normalizeSettingsDestination(params.get('destination')) ?? 'editing' });
if (params.get('page') === 'versions') sidebar.openVersions();
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
  await waitForThreadsPersistence();
  const input = sidebar.root.querySelector<HTMLTextAreaElement>('.ag-input')!;
  const modeButton = sidebar.root.querySelector<HTMLButtonElement>('.ag-mode-btn')!;
  await until(() => !input.disabled && !modeButton.disabled);
  // A restored chat may be in another mode; the first chat edits in 에이전트.
  if (modeButton.dataset.mode !== 'agent') {
    modeButton.click();
    sidebar.root.querySelector<HTMLButtonElement>('.ag-mode-item[data-mode="agent"]')!.click();
    await until(() => modeButton.dataset.mode === 'agent' && !input.disabled);
  }
  mock.setHold(true);
  playSample();
  await until(() => chatEditing(chats[0]!));
  sidebar.root.querySelector<HTMLButtonElement>('.ag-threads-new')!.click();
  await until(() => chats.length > 1 && chats[shownChat]!.sidebar.root.classList.contains('ag-fullscreen'));
}
if (parallel === 'locked') await openLockedParallelScene();

// Typed hooks for browser checks and custom scenario scripts.
const preview = { ...mock, sidebar, versions, eventBus, enterFocusMode, undoState, navigation,
  sessions, attachSession, chats, showChat, openChatCalls, projects: previewProjects, projectScene,
  threadStore: { listThreads, getThread, waitForThreadsPersistence } };
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
