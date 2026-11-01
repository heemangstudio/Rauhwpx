import { createSetupTerminal } from './setup-terminal.ts';
/** 설정 허브의 탐색과 AI·연결 목적지를 소유한다. 편집 설정은 전용 모듈이 맡는다. */
import './settings.css';
import { type SettingsNavIconId, withNavIcon } from './settings-nav-icons.ts';
import { confirmSheet } from './sheet.ts';
import { createUpdateSignHippo } from '../update-hippo/update-hippo.ts';
import { isInitialSetupActive, onInitialSetupInactive } from '../initial-setup/active.ts';

import {
  availableModelsForAgent,
  effortsForAgent,
  labelForModel,
  modelGroupsForAgent,
  resolveEffortForAgent,
  type AgentModelGroup,
} from '../../agent/models.ts';
import {
  AGENT_EDIT_LOCK_STEPS,
  loadAgentPrefs,
  normalizeAgentPrefs,
  trySaveAgentPrefs,
  type AgentEditLock,
  type AgentPrefs,
} from '../../agent/agent-prefs.ts';
import { createEffortSlider } from './effort-slider.ts';
import { createBrowserSettingsPane } from './browser-settings.ts';
import { createWebAssistantSettingsRow, type SignInWindow } from './web-assistant-settings.ts';
import { createIcon } from './icons.ts';
import { createProviderQuota } from './provider-quota.ts';
import { createUsageViews } from './token-usage-view.ts';
import { createEditingSettings } from './settings-editing.ts';
import { createThemeSettings } from './settings-theme.ts';
import { createProjectSettingsPane } from './settings-project.ts';
import { projectClientOf, type ProjectService } from '../../agent/project-service.ts';
import { userSettings } from '../../core/user-settings.ts';
import { loadAttentionPrefs, saveAttentionPrefs, subscribeAttentionPrefs } from '../../agent/attention-prefs.ts';
import { isDesktopApp, desktopUpdatesApi, type DesktopUpdatesApi } from '../../desktop-integration.ts';
import { webNotificationsGranted } from '../agent-attention.ts';
import {
  aiSettingsSection,
  normalizeSettingsDestination,
  type AiSettingsSection,
  type DirtyExitChoice,
  type EditorSettingsRuntime,
  type SettingsDestination,
  type SettingsDestinationInput,
} from './settings-contract.ts';
import { createChevron } from '../chevron.ts';
import { createSleepyHippo } from './sleepy-hippo.ts';
import { AGENT_LABEL, createProviderIcon, PROVIDER_ORDER } from './providers.ts';
import { createSettingsSearch, type SettingsSearchTarget } from './settings-search.ts';
import {
  formatResetAt,
  formatShortDate,
  formatTokens,
} from './usage-format.ts';
import type { SidebarBridge } from '../../agent/bridge.ts';
import { installOutcomeFromStatus, SetupTerminalResync } from '../../agent/pending-requests.ts';
import type { ThreadSummary } from '../../agent/threads.ts';
import { createArchiveSettingsPane } from './settings-archive.ts';
import { createAccountSettingsSection } from '../account/account-settings.ts';
import { accountStore } from '../account/account-store.ts';
import type { PlanStore } from '../plan/plan-store.ts';
import { createPiGiftLine } from './settings-gift.ts';
import { createAutofixSettingsSection } from './settings-autofix.ts';
import { createRauSettingsPane } from './settings-rau.ts';
import { sharedRauMemoryStore, type RauMemoryStore } from './rau-memory-state.ts';
import { planLocksRau } from '../plan/plan-store.ts';
import { createMarkdownEditor } from './markdown-editor.ts';
import type { DesktopGiftApi } from '../special-event/gift.ts';
import { AGENT_MODES, AGENT_MODE_LABEL, isAgentMode, type AgentMode } from '../../agent/types.ts';
import type { EventBus } from '../../core/event-bus.ts';
import type {
  AgentName,
  AgentInstructionsStatus,
  AgentAuthMethod,
  AgentSetupStatusMap,
  PermissionProfile,
  PiCatalogModel,
  PiStatus,
  ProviderStatusMap,
  SidebarEvent,
  UsageSummary,
  DocumentTemplate,
} from '../../agent/types.ts';

type ConnectionState = 'connecting' | 'connected' | 'disconnected' | 'replaced';

/** 직접 계정 한도를 조회하는 구독 제공자. */
type PlanAgent = 'claude' | 'codex';

const PLAN_AGENTS: readonly PlanAgent[] = ['claude', 'codex'];

/** API 키 입력칸 힌트 — 키 접두사가 있는 프로바이더만 형태를 보여준다. */
const API_KEY_PLACEHOLDER: Record<AgentName, string> = {
  claude: 'sk-ant-…',
  codex: 'sk-proj-…',
  pi: 'sk-or-…',
  grok: 'xai-…',
  cursor: 'API 키',
  opencode: 'API 키',
};

const CONN_LABEL: Record<ConnectionState, string> = {
  connected: '연결됨',
  connecting: '연결 중',
  disconnected: '끊김',
  replaced: '다른 탭에서 사용 중',
};

/** 새 대화의 기본 모드. 옵션 title 에만 짧은 설명을 둔다. */
const MODE_OPTIONS: ReadonlyArray<{ id: AgentMode; label: string; title: string }> = AGENT_MODES.map((id) => ({
  id,
  label: AGENT_MODE_LABEL[id],
  title: {
    chat: '읽기 전용',
    plan: '계획을 세우고 승인 후 실행',
    agent: '편집은 검토 후 반영',
    full: '편집 즉시 반영, 노트북 전체 접근',
  }[id],
}));



/** OpenRouter 키 발급과 연결 순서를 설명하는 문서. */
const OPENROUTER_GUIDE_URL = 'https://heemangstudios.com/tutorial-openrouter.html';

/** OpenRouter 가 받는 reasoning_effort 세 단계. */
const PI_EFFORT_OPTIONS: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'low', label: 'Low' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High' },
];

/** 고를 수 있는 모델 수 상한 (허브도 같은 값으로 막는다). */
const PI_MODEL_MAX = 3;

/** 카탈로그는 수천 개다 — 한 번에 그리는 줄 수를 묶고 나머지는 검색으로 좁힌다. */
const PI_CATALOG_VISIBLE_MAX = 50;

const PI_PROGRESS_LABEL: Record<string, string> = {
  preparing: '준비하는 중',
  downloading: '내려받는 중',
  installing: '설치하는 중',
  configuring: '설정하는 중',
  verifying: '설치 확인 중',
  done: '',
};

const INSTALL_PROGRESS_LABEL: Record<string, string> = {
  preparing: '준비하는 중',
  resolving: '패키지 확인 중',
  downloading: '내려받는 중',
  installing: '설치하는 중',
  configuring: '설정하는 중',
  verifying: '설치 확인 중',
  done: '설치 완료',
};

const INSTALL_PROGRESS_CEILING: Record<string, number> = {
  preparing: 18,
  resolving: 27,
  downloading: 58,
  installing: 86,
  configuring: 95,
  verifying: 99,
  done: 100,
};

const UNRESTRICTED_DEFAULT_WARNING = '승인 없이 편집하고 파일에 접근합니다.';

/** 미터가 경고 색으로 넘어가는 소진율. */
const METER_WARN_PERCENT = 80;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** OpenRouter 가격은 토큰당이라 100만 토큰 기준으로 바꿔 읽는다. */
function pricePerMillion(perToken: number): number {
  return Number.isFinite(perToken) ? perToken * 1_000_000 : 0;
}

function formatUsd(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '$0';
  if (value < 0.01) return `$${value.toFixed(4)}`;
  if (value < 1) return `$${value.toFixed(3)}`;
  return `$${value.toFixed(2)}`;
}

function createToggleRow(
  label: string,
  description?: string,
): { root: HTMLLabelElement; input: HTMLInputElement } {
  const root = el('label', 'ag-settings-control-row ag-settings-toggle-row');
  const copy = el('span', 'ag-settings-control-copy');
  copy.append(el('span', 'ag-settings-control-label', label));
  if (description) {
    copy.append(el('span', 'ag-settings-control-description', description));
  }
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.className = 'ag-settings-toggle-input';
  input.setAttribute('role', 'switch');
  input.setAttribute('aria-label', label);
  const track = el('span', 'ag-settings-toggle-track');
  track.setAttribute('aria-hidden', 'true');
  root.append(copy, input, track);
  return { root, input };
}

/** 편집 중 잠금 눈금의 이름 — 왼쪽 끝은 잠그지 않음, 오른쪽 끝은 작업 내내. */
function editLockLabel(lock: AgentEditLock): string {
  if (lock === 'off') return '잠그지 않음';
  if (lock === 'always') return '작업 내내';
  return lock >= 60 ? `편집 후 ${lock / 60}분` : `편집 후 ${lock}초`;
}

const EDIT_LOCK_OPTIONS = AGENT_EDIT_LOCK_STEPS.map((lock) => ({ id: String(lock), label: editLockLabel(lock) }));

/** 슬라이더 아래 눈금 숫자 — 단위는 오른쪽 이름이 알려 준다. */
function editLockTick(lock: AgentEditLock): string {
  if (lock === 'off') return '0';
  if (lock === 'always') return '∞';
  return String(lock);
}

function editLockFromId(id: string): AgentEditLock {
  return AGENT_EDIT_LOCK_STEPS.find((lock) => String(lock) === id) ?? AGENT_EDIT_LOCK_STEPS[0]!;
}

function createSection(title: string): { root: HTMLElement; head: HTMLElement; body: HTMLElement } {
  const root = el('section', 'ag-settings-section');
  const head = el('div', 'ag-settings-section-head');
  const heading = el('h3', 'ag-settings-section-title', title);
  head.append(heading);
  const body = el('div', 'ag-settings-section-body');
  root.append(head, body);
  return { root, head, body };
}

function createTextField(
  label: string,
  opts: { type?: string; placeholder?: string; autocomplete?: HTMLInputElement['autocomplete'] } = {},
): { field: HTMLElement; input: HTMLInputElement } {
  const field = el('label', 'ag-settings-field');
  field.append(el('span', 'ag-settings-field-label', label));
  const input = document.createElement('input');
  input.className = 'ag-settings-input';
  input.type = opts.type ?? 'text';
  if (opts.placeholder) input.placeholder = opts.placeholder;
  input.autocomplete = opts.autocomplete ?? 'off';
  input.spellcheck = false;
  field.append(input);
  return { field, input };
}

function createSelect(
  label: string,
  options: ReadonlyArray<{ id: string; label: string }>,
): { field: HTMLElement; select: HTMLSelectElement } {
  const field = el('label', 'ag-settings-field');
  field.append(el('span', 'ag-settings-field-label', label));
  const select = el('select', 'ag-settings-select') as HTMLSelectElement;
  fillSelect(select, options);
  field.append(select);
  return { field, select };
}

function fillSelect(
  select: HTMLSelectElement,
  options: ReadonlyArray<{ id: string; label: string }>,
): void {
  const previous = select.value;
  select.replaceChildren();
  for (const option of options) {
    const node = document.createElement('option');
    node.value = option.id;
    node.textContent = option.label;
    select.appendChild(node);
  }
  if (options.some((option) => option.id === previous)) select.value = previous;
}

/** 라벨 있는 그룹은 optgroup 으로 묶는다 — cursor 의 구독/API 과금 풀 구분. */
function fillSelectGrouped(
  select: HTMLSelectElement,
  groups: ReadonlyArray<AgentModelGroup>,
): void {
  const previous = select.value;
  select.replaceChildren();
  for (const group of groups) {
    let parent: HTMLSelectElement | HTMLOptGroupElement = select;
    if (group.label) {
      const optgroup = document.createElement('optgroup');
      optgroup.label = group.label;
      select.appendChild(optgroup);
      parent = optgroup;
    }
    for (const option of group.options) {
      const node = document.createElement('option');
      node.value = option.id;
      node.textContent = option.label;
      parent.appendChild(node);
    }
  }
  const ids = groups.flatMap((group) => group.options.map((option) => option.id));
  if (ids.includes(previous)) select.value = previous;
}

/** pi 마법사의 네 단계 (+ 완료 요약). */
type PiStep = 'install' | 'key' | 'catalog' | 'naming' | 'summary';

/** 고르는 중인 모델 한 줄 — 저장 전까지만 산다. */
interface PiDraftModel {
  id: string;
  name: string;
  reasoning: boolean;
  effort: string;
}

export interface SettingsPanelDeps {
  bridge: SidebarBridge;
  plan?: PlanStore | null;
  updatesApi?: DesktopUpdatesApi | null;
  eventBus?: EventBus;
  editorRuntime: EditorSettingsRuntime;
  /** 지금 대화가 쓰고 있는 조합 — 기본값과 다를 수 있다. */
  getSelection: () => {
    agent: AgentName;
    model: string;
    effort: string;
    permission: PermissionProfile;
  };
  /** 저장된 기본값을 사이드바에 알린다 (새 대화에 적용된다). */
  applyDefaults: (prefs: AgentPrefs) => void;
  /** 현재 대화의 CLI 세션을 다시 시작한다. */
  reconnectSession: () => void;
  /** 설정 안에 스킬 선반을 붙인다. */
  skillsSettings?: HTMLElement;
  /** 스킬 탭에 들어갈 때 최신 목록을 요청한다. */
  refreshSkills?: () => void;
  /** 설정 → 프로젝트가 쓰는 허브 서비스. 없으면 bridge.projects 를 찾는다. */
  projectSettings?: ProjectService | null;
  /** 보관함에서 채팅을 영구히 지운다. 사이드바의 삭제 확인 경로를 쓴다. */
  deleteArchivedThread?: (thread: ThreadSummary) => Promise<boolean>;
  /** 선물 크레딧(macOS 데스크톱만). 없으면 Pi 카드에 선물 줄이 없다. */
  gift?: DesktopGiftApi | null;
  /** 주소를 앱 안 브라우저의 별도 창으로 연다(ChatGPT·Claude 로그인). */
  openSignInWindow?: (url: string) => Promise<SignInWindow>;
  /** 창이 함께 보는 계정의 기억. 생략하면 창의 것을 쓴다. */
  rauMemory?: RauMemoryStore;
  /** 무료 요금제면 true. AI 설정은 잠기고, 들어가려는 길마다 요금제 카드가 열린다. */
  agentLocked?: () => boolean;
  openPlans?: () => void;
}

export interface SettingsPanel {
  element: HTMLElement;
  /** 요금제가 바뀌면 AI 묶음과 Rau 탭의 잠금을 맞춘다. */
  syncPlanLock(): void;
  open(destination?: SettingsDestinationInput): void;
  close(): void;
  /** 설정 → Rau 가 지금 보이는가. */
  rauVisible(): boolean;
  requestClose(): Promise<boolean>;
  isDirty(): boolean;
  /** 첫 실행 마법사 카드에서도 같은 설치/로그인 모달을 연다. */
  openAgentSetup(agent: AgentName): void;
  /**
   * 모달을 연 뒤 허브 상태에 따라 설치 또는 대표 인증 경로를 바로 시작한다.
   * 이미 로그인된 프로바이더는 완료 화면만 보여 준다.
   */
  beginAgentConnect(agent: AgentName, options?: { reauth?: boolean }): void;
  handleEvent(ev: SidebarEvent): void;
  dispose(): void;
}

export function createSettingsPanel(deps: SettingsPanelDeps): SettingsPanel {
  const {
    bridge,
    eventBus,
    editorRuntime,
    applyDefaults,
    reconnectSession,
    skillsSettings,
    refreshSkills,
    projectSettings,
  } = deps;

  let disposed = false;
  let prefs: AgentPrefs = loadAgentPrefs();
  let prefsBaseline: AgentPrefs = clonePrefs(prefs);
  let prefsDraft: AgentPrefs = clonePrefs(prefs);
  let modelCatalogAgent: PlanAgent | 'pi' = 'claude';
  const modelCatalogLoading = new Set<PlanAgent>();
  const modelCatalogErrors = new Set<PlanAgent>();
  let connectionState: ConnectionState = bridge.getConnectionState();
  let providers: ProviderStatusMap | null = null;
  let usage: UsageSummary | null = null;
  let agentInstructions: AgentInstructionsStatus | null = null;
  let instructionsDraftRevision = 0;
  let instructionsDirty = false;
  let instructionsBusy = false;
  let aiPrefsSaving = false;
  let instructionsMessage = '';
  let currentDestination: SettingsDestination = 'editing';
  let lastDestination: SettingsDestination = 'editing';
  try {
    const storedDestination = sessionStorage.getItem('rhwp-settings-destination');
    const normalized = normalizeSettingsDestination(storedDestination);
    if (normalized) {
      currentDestination = normalized;
      lastDestination = normalized;
    }
  } catch {
    // 세션 저장소가 없어도 기본 목적지로 계속 진행한다.
  }
  // AI 아래 세부 탭(연결, 사용량, 사용자화, Rau)과 사이드 목록에서 펼친 상태.
  let currentAiSection: AiSettingsSection = 'connection';
  try {
    currentAiSection = aiSettingsSection(`ai-${sessionStorage.getItem('rhwp-settings-ai-section')}`) ?? 'connection';
  } catch {
    // 세션 저장소가 없으면 연결부터 연다.
  }
  let aiGroupExpanded = currentDestination === 'ai';
  let templates: DocumentTemplate[] = [];
  let templatesBusy = false;
  let templatesMessage = '';
  let setupStatuses: AgentSetupStatusMap | null = null;
  let setupStatusRevision = 0;
  let setupAgent: AgentName | null = null;
  let setupBusy = false;
  /** 이 탭이 보낸 뒤 아직 응답을 받지 못한 설치 요청. */
  const pendingInstalls = new Set<AgentName>();
  let setupCloseTimer: ReturnType<typeof setTimeout> | null = null;
  let setupMessage = '';
  /** 설치·로그인 실패 상세 — 메시지 배너 아래 펼침 상자로만 보인다. */
  let setupDetail = '';
  let setupDetailFor = '';
  let setupReauth = false;
  let setupCodePending = false;
  /** 브라우저 로그인이 진행 중인 동안 카드에 직접 그릴 인증 주소와 기기 코드. */
  let setupOauthPending = false;
  let setupAuthUrl: string | null = null;
  let setupUserCode: string | null = null;
  let setupAuthRunId: string | null = null;
  let setupCopyResetTimer: ReturnType<typeof setTimeout> | null = null;
  let setupProgressPercent = 0;
  let setupProgressLabel = '';
  let setupProgressPhase = '';
  let setupProgressCreepTimer: ReturnType<typeof setInterval> | null = null;
  let setupProgressResetTimer: ReturnType<typeof setTimeout> | null = null;
  const openedAuthUrls = new Set<string>();
  const updatesApi = deps.updatesApi === undefined ? desktopUpdatesApi() : deps.updatesApi;
  const unifiedUpdates = Boolean(updatesApi?.updateAll);
  let updateAgent: AgentName | null = null;
  const providerUpdateHippo = unifiedUpdates ? null : createUpdateSignHippo(() => {
    if (updateAgent) openAgentSetup(updateAgent);
  });
  if (providerUpdateHippo) {
    providerUpdateHippo.element.classList.add('uh-provider');
    document.body.append(providerUpdateHippo.element);
  }
  const unsubscribeInitialSetup = onInitialSetupInactive(() => {
    if (!disposed && setupStatuses) announceProviderUpdates(setupStatuses);
  });
  /** 사용자가 닫거나 취소한 로그인. 늦게 도착한 상태로 다시 붙지 않게 한다. */
  const abandonedAuthRunIds = new Set<string>();
  /** 닫기마다 올라간다. 닫기 전에 보낸 시작 요청의 응답을 버리는 데 쓴다. */
  let authAttempt = 0;

  // pi 마법사 상태 — 한 장의 카드가 단계를 갈아 끼운다.
  let piStatus: PiStatus | null = null;
  // 설정 → Rau 의 요금제 카드 — 사이드바가 이 이벤트로 Rau 칸에 맞춰 띄운다.
  const openRauPlans = deps.plan?.api
    ? () => { window.dispatchEvent(new CustomEvent('rhwp:open-plan-card', { detail: { focus: 'rau' } })); }
    : null;
  // 계정의 기억(Rau-0.1)과 문체 학습. 정본은 허브다 — 이 탭은 창이 함께 보는 상태를 그린다.
  const rauPane = createRauSettingsPane({
    bridge,
    store: deps.rauMemory ?? sharedRauMemoryStore(),
    isDisposed: () => disposed,
    openPlans: openRauPlans,
    hasPlanApi: Boolean(deps.plan?.api),
  });
  let piCatalog: PiCatalogModel[] = [];
  let piCatalogLoading = false;
  /** 한 번 실패한 목록을 렌더마다 다시 부르지 않게 막는다. */
  let piCatalogTried = false;
  /** 사용자가 되돌아간 단계 (없으면 상태에서 단계를 유도한다). */
  let piStepOverride: PiStep | null = null;
  let piBusy = false;
  let piMessage = '';
  let piProgress = '';
  let piProgressPercent = 0;
  let piProgressPhase = '';
  let piProgressCreepTimer: ReturnType<typeof setInterval> | null = null;
  /** 활동 신호가 끊기면 움직이는 막대를 멈추는 타이머. */
  let piActivityPause: ReturnType<typeof setTimeout> | null = null;
  let piDraft: PiDraftModel[] = [];
  /** 이름 칸이 지금 물고 있는 초안 — 같은 객체면 다시 세우지 않는다. */
  let piNamingRendered: readonly PiDraftModel[] = [];

  // ── 페이지 골격 ────────────────────────────────────────
  const element = el('div', 'ag-settings-page');
  element.id = 'ag-settings-panel';
  element.setAttribute('role', 'region');
  element.setAttribute('aria-label', '설정');
  element.setAttribute('aria-hidden', 'true');

  const header = el('div', 'ag-threads-header');
  const title = el('span', 'ag-threads-title', '설정');
  const close = el('button', 'ag-threads-btn ag-threads-close ag-settings-close');
  close.type = 'button';
  close.setAttribute('aria-label', '채팅으로 돌아가기');
  close.title = '채팅으로 돌아가기';
  close.appendChild(createIcon('close'));
  close.addEventListener('click', () => {
    element.dispatchEvent(new CustomEvent('ag-settings-close-request', { bubbles: true }));
  });
  header.append(title, close);

  const layout = el('div', 'ag-settings-layout');
  const navigation = el('nav', 'ag-settings-nav');
  navigation.setAttribute('aria-label', '설정 범주');
  navigation.setAttribute('role', 'tablist');
  const body = el('div', 'ag-settings-body');
  const panes = new Map<SettingsDestination, HTMLElement>();
  const navButtons = new Map<SettingsDestination, HTMLButtonElement>();
  // 데스크톱 앱의 계정. 웹에는 계정 탭이 없다.
  const desktopAccount = accountStore();
  const destinations: ReadonlyArray<{ id: SettingsDestination; label: string; icon: SettingsNavIconId }> = [
    { id: 'editing', label: '편집', icon: 'editing' },
    { id: 'theme', label: '테마', icon: 'theme' },
    { id: 'ai', label: 'AI', icon: 'ai' },
    { id: 'browser', label: '브라우저', icon: 'browser' },
    { id: 'skills', label: '스킬', icon: 'skills' },
    { id: 'project', label: '프로젝트', icon: 'project' },
    { id: 'archive', label: '보관함', icon: 'archive' },
    ...(desktopAccount.api ? [{ id: 'account' as const, label: '계정', icon: 'account' as const }] : []),
  ];
  const aiSections: ReadonlyArray<{ id: AiSettingsSection; label: string; icon: SettingsNavIconId }> = [
    { id: 'connection', label: '연결', icon: 'connection' },
    { id: 'usage', label: '사용량', icon: 'usage' },
    { id: 'custom', label: '사용자화', icon: 'customize' },
    { id: 'rau', label: 'Rau', icon: 'rau' },
  ];
  const aiSectionButtons = new Map<AiSettingsSection, HTMLButtonElement>();
  // AI 는 탭이 아니라 묶음 머리다. 누르면 아래에 세부 탭이 펼쳐진다.
  const aiGroupHeader = el('button', 'ag-settings-nav-button ag-settings-nav-group');
  aiGroupHeader.type = 'button';
  aiGroupHeader.id = 'ag-settings-tab-ai';
  aiGroupHeader.append(
    withNavIcon(el('span', 'ag-settings-nav-group-label', 'AI'), 'ai'),
    createChevron('ag-settings-nav-group-caret'),
  );
  const aiGroupLock = el('span', 'ag-settings-nav-group-lock');
  aiGroupLock.setAttribute('aria-hidden', 'true');
  aiGroupLock.append(createIcon('lock'));
  aiGroupHeader.append(aiGroupLock);
  const aiGroupList = el('div', 'ag-settings-nav-sublist');
  aiGroupList.id = 'ag-settings-nav-ai-sections';
  aiGroupList.setAttribute('role', 'group');
  aiGroupList.setAttribute('aria-labelledby', aiGroupHeader.id);
  aiGroupHeader.setAttribute('aria-controls', aiGroupList.id);
  for (const section of aiSections) {
    const sub = withNavIcon(el('button', 'ag-settings-nav-button ag-settings-nav-sub', section.label), section.icon);
    sub.type = 'button';
    sub.id = `ag-settings-tab-ai-${section.id}`;
    sub.dataset.destination = 'ai';
    sub.dataset.aiSection = section.id;
    sub.setAttribute('role', 'tab');
    sub.setAttribute('aria-controls', 'ag-settings-pane-ai');
    aiGroupList.appendChild(sub);
    aiSectionButtons.set(section.id, sub);
  }
  for (const destination of destinations) {
    const button = destination.id === 'ai'
      ? aiGroupHeader
      : withNavIcon(el('button', 'ag-settings-nav-button', destination.label), destination.icon);
    if (destination.id === 'ai') {
      const pane = el('section', 'ag-settings-pane');
      pane.id = 'ag-settings-pane-ai';
      pane.dataset.destination = 'ai';
      pane.setAttribute('role', 'tabpanel');
      navigation.append(aiGroupHeader, aiGroupList);
      panes.set('ai', pane);
      navButtons.set('ai', aiGroupHeader);
      continue;
    }
    button.type = 'button';
    button.id = `ag-settings-tab-${destination.id}`;
    button.dataset.destination = destination.id;
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-controls', `ag-settings-pane-${destination.id}`);
    const pane = el('section', 'ag-settings-pane');
    pane.id = `ag-settings-pane-${destination.id}`;
    pane.dataset.destination = destination.id;
    pane.setAttribute('role', 'tabpanel');
    pane.setAttribute('aria-labelledby', button.id);
    navigation.appendChild(button);
    panes.set(destination.id, pane);
    navButtons.set(destination.id, button);
  }
  // Rau 세부 탭: Rau 요금제(체험 포함)가 아니면 자물쇠를 달고, 누르면 요금제 카드가 열린다.
  const createRauLock = (): HTMLElement => {
    const lock = el('span', 'ag-settings-nav-group-lock ag-settings-nav-rau-lock');
    lock.setAttribute('aria-hidden', 'true');
    lock.append(createIcon('lock'));
    return lock;
  };
  const rauNavButton = aiSectionButtons.get('rau')!;
  rauNavButton.append(createRauLock());
  layout.append(navigation, body);
  body.append(...panes.values());
  element.append(header, layout);

  const browserPane = createBrowserSettingsPane({
    request: (action, args) => bridge.requestBrowser(action, args),
    submit: (args) => bridge.submitBrowserAccount(args),
    isConnected: () => connectionState === 'connected',
  });
  panes.get('browser')?.append(browserPane.element);
  let shellReady = false;
  const editingSettings = createEditingSettings({
    eventBus,
    runtime: editorRuntime,
    onDirtyChange: () => {
      if (shellReady) renderDestinationState();
    },
  });
  panes.get('editing')?.appendChild(editingSettings.element);
  const themeSettings = createThemeSettings({
    onDirtyChange: () => {
      if (shellReady) renderDestinationState();
    },
  });
  panes.get('theme')?.appendChild(themeSettings.element);
  const accountSection = desktopAccount.api ? createAccountSettingsSection(desktopAccount, deps.plan) : null;
  if (accountSection) {
    const accountContent = el('div', 'ag-settings-destination-content');
    accountContent.append(accountSection.root);
    panes.get('account')?.append(accountContent);
  }
  const projectPane = createProjectSettingsPane({
    service: () => projectSettings ?? projectClientOf(bridge)?.service ?? null,
    isConnected: () => connectionState === 'connected',
    onDirtyChange: () => {
      if (shellReady) renderDestinationState();
    },
  });
  panes.get('project')?.appendChild(projectPane.element);
  const archivePane = createArchiveSettingsPane({
    deleteThread: (thread) => deps.deleteArchivedThread?.(thread) ?? Promise.resolve(false),
    isShown: () => settingsOpen && currentDestination === 'archive',
  });
  panes.get('archive')?.appendChild(archivePane.element);

  // ── 1. 연결 ────────────────────────────────────────────
  const connection = createSection('연결');
  const hubRow = el('div', 'ag-settings-row ag-settings-hub-row');
  const hubDot = el('span', 'ag-settings-dot');
  hubDot.setAttribute('aria-hidden', 'true');
  const hubText = el('div', 'ag-settings-row-text');
  const hubName = el('span', 'ag-settings-row-name', '에이전트 허브');
  const hubLabel = el('span', 'ag-settings-row-detail', CONN_LABEL[connectionState]);
  hubText.append(hubName, hubLabel);
  const hubReconnect = el('button', 'ag-settings-btn', '다시 연결');
  hubReconnect.type = 'button';
  hubReconnect.addEventListener('click', () => {
    void bridge.reconnectNow();
    renderConnection();
  });
  hubRow.append(hubText, hubDot, hubReconnect);

  const providerRows = new Map<
    AgentName,
    { root: HTMLDetailsElement; dot: HTMLElement; detail: HTMLElement; message: HTMLElement; setup: HTMLButtonElement }
  >();
  const providerList = el('div', 'ag-settings-provider-list');
  for (const agent of PROVIDER_ORDER) {
    const row = el('details', 'ag-settings-provider-row');
    row.dataset.agent = agent;
    const dot = el('span', 'ag-settings-dot');
    dot.setAttribute('aria-hidden', 'true');
    const header = el('summary', 'ag-settings-provider-summary');
    const text = el('div', 'ag-settings-row-text');
    const name = el('span', 'ag-settings-row-name');
    name.append(createProviderIcon(agent), document.createTextNode(AGENT_LABEL[agent]));
    const detail = el('span', 'ag-settings-row-detail', '확인 중…');
    text.append(name, detail);
    const setup = el('button', 'ag-settings-primary ag-provider-setup-btn', '설정');
    setup.type = 'button';
    setup.addEventListener('click', () => openAgentSetup(agent));
    const message = el('p', 'ag-settings-provider-message');
    const panel = el('div', 'ag-settings-provider-panel');
    panel.append(message, setup);
    header.append(text, dot);
    row.append(header, panel);
    row.addEventListener('toggle', () => {
      if (row.open) for (const other of providerRows.values()) {
        if (other.root !== row) other.root.open = false;
      }
    });
    providerList.appendChild(row);
    providerRows.set(agent, { root: row, dot, detail, message, setup });
  }

  const refreshBtn = el('button', 'ag-settings-btn');
  refreshBtn.type = 'button';
  refreshBtn.append(createIcon('refresh'));
  refreshBtn.title = '상태 새로고침';
  refreshBtn.setAttribute('aria-label', refreshBtn.title);
  let connectionRefreshing = false;
  refreshBtn.addEventListener('click', async () => {
    if (connectionRefreshing) return;
    connectionRefreshing = true;
    renderConnection();
    try { await Promise.all([refreshProviders(true), refreshSetupStatuses(true), ...assistantRows.map(row => row.refresh(true))]); }
    finally { connectionRefreshing = false; if (!disposed) renderConnection(); }
  });
  refreshBtn.classList.add('ag-settings-section-action');
  connection.head.append(refreshBtn);
  // 웹 ChatGPT·Claude. 로그인 창은 설정 위에 별도 창으로 뜨고, 설정은 그대로 둔다.
  const assistantRows = (['chatgpt', 'claude'] as const).map(service => createWebAssistantSettingsRow(service, {
    request: (action, args) => bridge.requestBrowser(action, args),
    ...(deps.openSignInWindow ? { openSignInWindow: deps.openSignInWindow } : {}),
    isConnected: () => connectionState === 'connected',
  }));
  connection.body.append(providerList, ...assistantRows.map(row => row.root), hubRow);

  // ── Pi 모달 흐름 ──────────────────────────────────────
  // 설치 → 로그인 → 모델 → 요약으로 모습을 바꾸며, 설정 페이지에는 직접 붙지 않는다.
  const piCard = el('div', 'ag-pi-card');
  const piHead = el('div', 'ag-agent-setup-hero');
  const piHeadIcon = el('div', 'ag-agent-setup-hero-icon');
  piHeadIcon.append(createProviderIcon('pi'));
  const piHeadCopy = el('div', 'ag-agent-setup-hero-copy');
  const piHeadName = el('strong', 'ag-agent-setup-hero-title', 'Pi');
  const piHeadDetail = el('span', 'ag-settings-row-detail', '확인 중…');
  piHeadCopy.append(piHeadName, piHeadDetail);
  piHead.append(piHeadIcon, piHeadCopy);
  const piMessageLine = el('p', 'ag-settings-cliproxy-error');
  piMessageLine.hidden = true;
  // 선물 크레딧 — 어느 단계에서든 카드 맨 위에 보인다.
  const piGift = deps.gift
    ? createPiGiftLine(deps.gift, async (order) => {
      const status = await bridge.setPiGiftOrder(order);
      if (!status) throw new Error('Pi gift order was not saved.');
      piStatus = status;
      renderPi();
    })
    : null;

  // 1단계 — 설치
  const piInstallStep = el('div', 'ag-pi-step');
  const piInstallBtn = el('button', 'ag-settings-primary ag-pi-logo-btn');
  piInstallBtn.type = 'button';
  piInstallBtn.append(createProviderIcon('pi'), el('span', '', 'Pi 연결'));
  const piProgressLine = el('p', 'ag-settings-note');
  piProgressLine.hidden = true;
  // 내려받기 진행 막대 — 크기를 알면 채움 폭, 모르면 신호가 올 때만 흐르는 줄무늬.
  const piProgressTrack = el('div', 'ag-settings-meter-track ag-pi-progress');
  const piProgressFill = el('div', 'ag-settings-meter-fill');
  piProgressTrack.appendChild(piProgressFill);
  piProgressTrack.hidden = true;
  piInstallStep.append(piInstallBtn, piProgressTrack, piProgressLine);

  // 2단계 — OpenRouter 키
  const piKeyStep = el('div', 'ag-pi-step');
  const piKeyNote = el('p', 'ag-settings-note', 'OpenRouter 로그인 또는 API 키');
  const piOauth = el('button', 'ag-settings-btn ag-pi-oauth', '브라우저로 로그인');
  piOauth.type = 'button';
  const piKeyInput = createTextField('OpenRouter 키', {
    type: 'password',
    placeholder: 'sk-or-v1-…',
    autocomplete: 'new-password',
  });
  const piKeyActions = el('div', 'ag-settings-actions');
  const piKeySubmit = el('button', 'ag-settings-primary', '연결');
  piKeySubmit.type = 'button';
  const piKeyCancel = el('button', 'ag-settings-btn', '취소');
  piKeyCancel.type = 'button';
  const piKeyGuide = el('a', 'ag-pi-key-guide', '가이드');
  piKeyGuide.href = OPENROUTER_GUIDE_URL;
  piKeyGuide.target = '_blank';
  piKeyGuide.rel = 'noopener noreferrer';
  piKeyActions.append(piKeySubmit, piKeyCancel, piKeyGuide);
  // 브라우저 로그인과 키 입력은 한 줄에 나란히 둔다.
  const piAuthRow = el('div', 'ag-pi-auth-row');
  piAuthRow.append(piOauth, el('span', 'ag-pi-auth-or', '또는'), piKeyInput.field);
  piKeyStep.append(piKeyNote, piAuthRow, piKeyActions);

  // 3단계 — 카탈로그에서 모델 고르기
  const piCatalogStep = el('div', 'ag-pi-step');
  const piCatalogOpen = el('button', 'ag-settings-primary', '모델 선택');
  piCatalogOpen.type = 'button';
  piCatalogOpen.addEventListener('click', () => openPiModelCatalog());
  piCatalogStep.append(piCatalogOpen);
  const piChips = el('div', 'ag-pi-chips');
  const piCatalogActions = el('div', 'ag-settings-actions ag-settings-pi-actions');
  const piCatalogNext = el('button', 'ag-settings-primary', '다음');
  piCatalogNext.type = 'button';
  const piCatalogCancel = el('button', 'ag-settings-btn', '선택 취소');
  piCatalogCancel.type = 'button';
  const piCatalogConnect = el('button', 'ag-settings-primary', 'Pi 연결');
  piCatalogConnect.type = 'button';
  piCatalogConnect.addEventListener('click', () => openAgentSetup('pi'));
  piCatalogActions.append(piCatalogNext, piCatalogCancel, piCatalogConnect);

  // 4단계 — 이름 짓기 + 기본 강도
  const piNamingStep = el('div', 'ag-pi-step');
  const piNamingNote = el('p', 'ag-settings-note', '사이드바 표시 이름');
  const piNamingRows = el('div', 'ag-pi-naming');
  const piNamingActions = el('div', 'ag-settings-actions');
  const piNamingSave = el('button', 'ag-settings-primary', '저장');
  piNamingSave.type = 'button';
  const piNamingBack = el('button', 'ag-settings-btn', '뒤로');
  piNamingBack.type = 'button';
  piNamingActions.append(piNamingSave, piNamingBack);
  piNamingStep.append(piNamingNote, piNamingRows, piNamingActions);

  // 완료 — 요약
  const piSummaryStep = el('div', 'ag-pi-step');
  const piSummaryModels = el('div', 'ag-pi-summary-models');
  const piSummaryKey = el('p', 'ag-settings-note');
  const piSummaryActions = el('div', 'ag-settings-actions');
  const piRepick = el('button', 'ag-settings-btn', '모델 다시 고르기');
  piRepick.type = 'button';
  const piRekey = el('button', 'ag-settings-btn', '로그인 방식 변경');
  piRekey.type = 'button';
  piSummaryActions.append(piRepick, piRekey);
  piSummaryStep.append(piSummaryModels, piSummaryKey, piSummaryActions);

  piCard.append(
    piHead,
    ...(piGift ? [piGift.root] : []),
    piMessageLine,
    piInstallStep,
    piKeyStep,
    piCatalogStep,
    piNamingStep,
    piSummaryStep,
  );

  const piSteps: ReadonlyArray<[PiStep, HTMLElement]> = [
    ['install', piInstallStep],
    ['key', piKeyStep],
    ['catalog', piCatalogStep],
    ['naming', piNamingStep],
    ['summary', piSummaryStep],
  ];

  // 에이전트 설치/로그인은 설정 페이지를 떠나지 않는 모달 한 장에서 끝낸다.
  const setupOverlay = el('div', 'ag-agent-setup-overlay');
  setupOverlay.setAttribute('aria-hidden', 'true');
  const setupDialog = el('section', 'ag-agent-setup-dialog');
  setupDialog.setAttribute('role', 'dialog');
  setupDialog.setAttribute('aria-modal', 'true');
  setupDialog.setAttribute('aria-labelledby', 'ag-agent-setup-title');
  setupDialog.tabIndex = -1;
  // 머리: 프로바이더 아이콘 · 이름 · 상태 한 줄. 본문에 따로 큰 제목을 두지 않는다.
  const setupChrome = el('header', 'ag-agent-setup-chrome');
  const setupHeroIcon = el('div', 'ag-agent-setup-icon');
  setupHeroIcon.setAttribute('aria-hidden', 'true');
  const setupTitleWrap = el('div', 'ag-agent-setup-title-wrap');
  const setupTitle = el('h2', 'ag-agent-setup-title');
  setupTitle.id = 'ag-agent-setup-title';
  const setupState = el('p', 'ag-agent-setup-state');
  const setupStateDot = el('span', 'ag-settings-dot');
  setupStateDot.setAttribute('aria-hidden', 'true');
  const setupStateText = el('span', '');
  setupState.append(setupStateDot, setupStateText);
  setupTitleWrap.append(setupTitle, setupState);
  const setupClose = el('button', 'ag-agent-setup-close');
  setupClose.type = 'button';
  setupClose.setAttribute('aria-label', '설정 닫기');
  setupClose.appendChild(createIcon('close'));
  setupChrome.append(setupHeroIcon, setupTitleWrap, setupClose);
  const setupBody = el('div', 'ag-agent-setup-body');
  const setupGeneric = el('div', 'ag-agent-setup-generic');

  // 연결 상태 카드 — 계정 줄과 버전 줄. 새 버전이 있으면 버전 줄에서 바로 업데이트한다.
  const setupStatusCard = el('div', 'ag-agent-setup-card');
  const setupAccountRow = el('div', 'ag-agent-setup-row');
  const setupAccountValue = el('span', 'ag-agent-setup-row-value');
  const setupChangeAuth = el('button', 'ag-settings-btn', '로그인 방식 변경');
  setupChangeAuth.type = 'button';
  const setupAccountLogout = el('button', 'ag-settings-btn', '로그아웃');
  setupAccountLogout.type = 'button';
  setupAccountLogout.hidden = true;
  setupAccountRow.append(el('span', 'ag-agent-setup-row-label', '계정'), setupAccountValue, setupChangeAuth, setupAccountLogout);
  const setupVersionRow = el('div', 'ag-agent-setup-row');
  const setupVersionValue = el('span', 'ag-agent-setup-row-value');
  const setupUpdate = el('button', 'ag-settings-btn ag-agent-setup-update', '업데이트');
  setupUpdate.type = 'button';
  setupVersionRow.append(el('span', 'ag-agent-setup-row-label', '버전'), setupVersionValue, setupUpdate);
  // 업데이트하는 동안 지금 버전과 새 버전을 화살표로 잇는다.
  const setupVersionArrow = el('span', 'ag-agent-setup-arrow', '→');
  setupVersionArrow.setAttribute('aria-hidden', 'true');
  setupStatusCard.append(setupAccountRow, setupVersionRow);
  const setupProgress = el('div', 'ag-agent-setup-progress');
  setupProgress.setAttribute('role', 'progressbar');
  setupProgress.setAttribute('aria-valuemin', '0');
  setupProgress.setAttribute('aria-valuemax', '100');
  const setupProgressFill = el('span', '');
  setupProgress.appendChild(setupProgressFill);
  setupProgress.hidden = true;
  const setupProgressLine = el('p', 'ag-agent-setup-progress-label');
  setupProgressLine.hidden = true;
  const setupError = el('p', 'ag-agent-setup-error');
  setupError.hidden = true;
  const setupErrorDetail = el('details', 'ag-agent-setup-error-detail');
  const setupErrorDetailText = el('pre', '');
  setupErrorDetail.append(el('summary', '', '자세한 출력'), setupErrorDetailText);
  setupErrorDetail.hidden = true;

  const setupInstallPane = el('div', 'ag-agent-setup-pane');
  const setupInstall = el('button', 'ag-agent-setup-primary', '설치하고 계속');
  setupInstall.type = 'button';
  setupInstallPane.append(setupInstall);

  const setupAuthPane = el('div', 'ag-agent-setup-pane');
  const setupAuthHeading = el('h3', 'ag-agent-setup-section-title', '로그인 방법');
  const setupOauth = el('button', 'ag-agent-auth-card');
  setupOauth.type = 'button';
  setupOauth.append(el('strong', '', '브라우저로 로그인'), el('span', '', '구독 계정 또는 웹 계정 연결'));
  const setupApiToggle = el('button', 'ag-agent-auth-card');
  setupApiToggle.type = 'button';
  setupApiToggle.append(el('strong', '', 'API 키 입력'), el('span', '', '사용량 기반 API 결제'));
  const setupKeyBox = el('div', 'ag-agent-key-box');
  setupKeyBox.hidden = true;
  const setupKey = createTextField('API 키', { type: 'password', autocomplete: 'new-password' });
  const setupKeySubmit = el('button', 'ag-agent-setup-primary', '키 연결');
  setupKeySubmit.type = 'button';
  setupKeyBox.append(setupKey.field, setupKeySubmit);
  // 브라우저 로그인 상자 — 팝업이 막혀도 주소와 기기 코드를 카드 안에서 직접 준다.
  const setupLoginBox = el('div', 'ag-agent-login-box');
  setupLoginBox.hidden = true;
  const setupAuthUrlRow = el('div', 'ag-agent-login-url-row');
  setupAuthUrlRow.hidden = true;
  const setupAuthLink = el('a', 'ag-agent-login-url');
  setupAuthLink.target = '_blank';
  setupAuthLink.rel = 'noopener noreferrer';
  const setupAuthActions = el('div', 'ag-agent-login-actions');
  const setupAuthOpen = el('button', 'ag-settings-btn', '브라우저에서 열기');
  setupAuthOpen.type = 'button';
  const setupAuthCopy = el('button', 'ag-settings-btn', '주소 복사');
  setupAuthCopy.type = 'button';
  setupAuthActions.append(setupAuthOpen, setupAuthCopy);
  setupAuthUrlRow.append(setupAuthLink, setupAuthActions);
  const setupUserCodeRow = el('div', 'ag-agent-login-code');
  setupUserCodeRow.hidden = true;
  const setupUserCodeValue = el('strong', 'ag-agent-login-code-value');
  const setupUserCodeCopy = el('button', 'ag-settings-btn', '코드 복사');
  setupUserCodeCopy.type = 'button';
  const setupUserCodeCaption = el(
    'p',
    'ag-agent-login-caption',
    '브라우저에서 이 코드를 확인합니다.',
  );
  setupUserCodeRow.append(setupUserCodeValue, setupUserCodeCopy, setupUserCodeCaption);
  const setupLoginWait = el(
    'p',
    'ag-agent-login-wait',
    '브라우저에서 로그인하면 자동으로 완료됩니다.',
  );
  const setupLoginCancel = el('button', 'ag-settings-btn ag-agent-login-cancel', '로그인 취소');
  setupLoginCancel.type = 'button';
  setupLoginBox.append(setupAuthUrlRow, setupUserCodeRow, setupLoginWait, setupLoginCancel);
  const setupCodeBox = el('div', 'ag-agent-key-box');
  setupCodeBox.hidden = true;
  const setupCodeNote = el('p', 'ag-agent-setup-copy', '브라우저에 표시된 인증 코드 붙여넣기');
  const setupCode = createTextField('인증 코드', { autocomplete: 'off' });
  const setupCodeSubmit = el('button', 'ag-agent-setup-primary', '코드 확인');
  setupCodeSubmit.type = 'button';
  setupCodeBox.append(setupCodeNote, setupCode.field, setupCodeSubmit);
  // 로그인 방법 두 가지는 연결 목록과 같은 한 장의 카드 안 행으로 묶는다.
  const setupAuthChoices = el('div', 'ag-agent-auth-list');
  setupAuthChoices.append(setupOauth, setupApiToggle);
  setupAuthPane.append(
    setupAuthHeading,
    setupAuthChoices,
    setupKeyBox,
    setupLoginBox,
    setupCodeBox,
  );

  setupGeneric.append(
    setupStatusCard,
    setupProgress,
    setupProgressLine,
    setupError,
    setupErrorDetail,
    setupInstallPane,
    setupAuthPane,
  );
  setupDialog.append(setupChrome, setupBody);
  setupOverlay.appendChild(setupDialog);

  setupInstall.addEventListener('click', () => {
    const agent = setupAgent;
    void installSelectedAgent().then(() => {
      if (agent && setupAgent === agent && isAgentInstalled(agent) && !isAgentLoggedIn(agent)) {
        return startPreferredSetupAuth(agent);
      }
    });
  });
  setupUpdate.addEventListener('click', () => void installSelectedAgent());
  setupOauth.addEventListener('click', () => void startSetupAuth('oauth'));
  setupApiToggle.addEventListener('click', () => {
    setupKeyBox.hidden = false;
    setupKey.input.focus();
  });
  setupKeySubmit.addEventListener('click', () => void startSetupAuth('api-key'));
  setupKey.input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      void startSetupAuth('api-key');
    }
  });
  // 직접 클릭 안에서 여는 창은 팝업 차단에 걸리지 않는다.
  setupAuthOpen.addEventListener('click', () => {
    if (!setupAuthUrl) return;
    openedAuthUrls.add(setupAuthUrl);
    window.open(setupAuthUrl, '_blank', 'noopener,noreferrer');
  });
  setupAuthCopy.addEventListener('click', () => {
    if (setupAuthUrl) void copySetupText(setupAuthUrl, setupAuthCopy, '주소 복사');
  });
  setupUserCodeCopy.addEventListener('click', () => {
    if (setupUserCode) void copySetupText(setupUserCode, setupUserCodeCopy, '코드 복사');
  });
  const setupTerminal = createSetupTerminal({
    input: data => { if (supportsTerminalSetup(setupAgent) && setupAuthRunId) bridge.sendSetupTerminalInput(setupAgent, setupAuthRunId, data); },
    resize: (cols, rows) => { if (supportsTerminalSetup(setupAgent) && setupAuthRunId) bridge.resizeSetupTerminal(setupAgent, setupAuthRunId, cols, rows); },
    cancel: () => setupLoginCancel.click(),
  });
  setupAuthPane.append(setupTerminal.root);
  setupTerminal.setOnline(connectionState === 'connected');
  // 끊긴 동안 허브가 보낸 터미널 프레임은 사라진다 — 같은 로그인으로 다시 붙으면 화면을 다시 받는다.
  const setupTerminalResync = new SetupTerminalResync((agent, authRunId) => bridge.resumeSetupTerminal(agent, authRunId));
  setupLoginCancel.addEventListener('click', () => {
    if (setupAgent && setupAuthRunId) {
      abandonedAuthRunIds.add(setupAuthRunId);
      bridge.cancelAgentSetup(setupAgent, setupAuthRunId);
    }
    authAttempt += 1;
    setupBusy = false;
    setupCodePending = false;
    clearSetupAuthPrompt();
    renderAgentSetup();
  });
  setupCodeSubmit.addEventListener('click', submitSetupAuthCode);
  setupCode.input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      submitSetupAuthCode();
    }
  });
  setupCode.input.addEventListener('input', () => {
    setupCodeSubmit.disabled = connectionState !== 'connected' || !setupCode.input.value.trim();
  });
  setupClose.addEventListener('click', closeAgentSetup);
  setupChangeAuth.addEventListener('click', () => {
    setupReauth = true;
    setupMessage = '';
    renderAgentSetup();
  });
  setupAccountLogout.addEventListener('click', () => {
    void disconnectProvider('claude');
  });
  setupOverlay.addEventListener('pointerdown', (event) => {
    if (event.target === setupOverlay) closeAgentSetup();
  });
  setupOverlay.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    // 이 Esc 는 연결 창만 닫는다 — 뒤에 열린 첫 실행 설정 같은 문서 수준 Esc 처리로 번지지 않게 한다.
    event.preventDefault();
    event.stopPropagation();
    closeAgentSetup();
  });

  piInstallBtn.addEventListener('click', () => void runPiInstall());
  piOauth.addEventListener('click', () => void startSetupAuth('oauth'));
  piKeySubmit.addEventListener('click', () => void submitPiKey());
  piKeyInput.input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      void submitPiKey();
    }
  });
  piKeyCancel.addEventListener('click', () => {
    piKeyInput.input.value = '';
    piStepOverride = null;
    piMessage = '';
    renderPi();
  });
  piCatalogNext.addEventListener('click', () => {
    if (piDraft.length === 0) return;
    piStepOverride = 'naming';
    piMessage = '';
    openAgentSetup('pi');
  });
  piCatalogCancel.addEventListener('click', () => {
    piStepOverride = null;
    piMessage = '';
    resetPiDraft();
    renderPi();
  });
  piNamingBack.addEventListener('click', () => {
    openPiModelCatalog();
  });
  piNamingSave.addEventListener('click', () => void savePiModels());
  piRepick.addEventListener('click', () => openPiModelCatalog());
  piRekey.addEventListener('click', () => {
    piKeyInput.input.value = '';
    piStepOverride = 'key';
    piMessage = '';
    renderPi();
    piKeyInput.input.focus();
  });

  // ── 2. 기본 설정 ──────────────────────────────────────
  const defaults = createSection('기본 모델');
  defaults.root.classList.add('ag-settings-defaults');
  const agentField = createSelect('제공자', selectableAgents().map(
    (agent) => ({ id: agent, label: AGENT_LABEL[agent] }),
  ));
  agentField.field.classList.add('ag-settings-provider-field');
  const providerMark = el('span', 'ag-settings-provider-mark');
  providerMark.setAttribute('aria-hidden', 'true');
  agentField.field.insertBefore(providerMark, agentField.select);
  const modelField = createSelect('모델', []);
  const effortField = createSelect('추론 강도', []);
  const modeField = createSelect('모드', MODE_OPTIONS.map(({ id, label }) => ({ id, label })));
  for (const option of modeField.select.options) {
    option.title = MODE_OPTIONS.find(item => item.id === option.value)?.title ?? '';
  }
  defaults.body.append(
    agentField.field,
    modelField.field,
    effortField.field,
    modeField.field,
  );

  agentField.select.addEventListener('change', () => {
    const value = agentField.select.value;
    const agent = PROVIDER_ORDER.find((name) => name === value) ?? 'claude';
    stagePrefs({ defaultAgent: agent });
  });
  modelField.select.addEventListener('change', () => {
    stagePrefs({ defaultModel: modelField.select.value });
  });
  effortField.select.addEventListener('change', () => {
    stagePrefs({ defaultEffort: effortField.select.value });
  });
  modeField.select.addEventListener('change', () => {
    const value = modeField.select.value;
    stagePrefs({ defaultMode: isAgentMode(value) ? value : 'agent' });
  });

  // 에이전트·전체 모드에서 에이전트가 문서를 고치는 동안 내 편집을 막는 시간. 대화만 할 때는 막지 않는다.
  const editLockSection = createSection('에이전트 편집 중 문서 잠금');
  const editLockValue = el('span', 'ag-settings-edit-lock-value');
  const editLockSlider = createEffortSlider({
    ariaLabel: '에이전트 편집 중 문서 잠금',
    tickLabel: (id) => editLockTick(editLockFromId(id)),
    onChange: (id) => stagePrefs({ editLock: editLockFromId(id) }),
    onPreview: (id) => { editLockValue.textContent = editLockLabel(editLockFromId(id)); },
  });
  const editLockField = el('div', 'ag-settings-field ag-settings-edit-lock');
  editLockField.append(el('span', 'ag-settings-field-label', '잠금'), editLockSlider.root, editLockValue);
  editLockSection.body.append(editLockField);

  const modelCatalogSection = createSection('모델');
  modelCatalogSection.root.classList.add('ag-settings-model-catalog-section');
  const modelCatalogCard = el('div', 'ag-settings-model-catalog-card');
  const modelCatalogTop = el('div', 'ag-settings-model-catalog-top');
  const modelCatalogTabs = el('div', 'ag-settings-model-tabs');
  modelCatalogTabs.setAttribute('role', 'tablist');
  modelCatalogTabs.setAttribute('aria-label', '모델 제공자');
  const catalogAgents = [...PLAN_AGENTS, 'pi'] as const;
  const catalogTabs = new Map<PlanAgent | 'pi', HTMLButtonElement>();
  for (const agent of catalogAgents) {
    const tab = el('button', 'ag-settings-model-tab');
    tab.type = 'button';
    tab.id = `ag-settings-model-tab-${agent}`;
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-controls', 'ag-settings-model-list');
    tab.dataset.agent = agent;
    tab.append(createProviderIcon(agent), document.createTextNode(AGENT_LABEL[agent]));
    tab.addEventListener('click', () => {
      if (agent === 'pi') {
        openPiModelCatalog();
        return;
      }
      modelCatalogAgent = agent;
      modelCatalogSearch.value = '';
      renderModelCatalog();
      if (availableModelsForAgent(agent).length === 0) void loadModelCatalog(agent);
    });
    tab.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const target = event.key === 'Home' ? catalogAgents[0]
        : event.key === 'End' ? catalogAgents[catalogAgents.length - 1]
        : catalogAgents[(catalogAgents.indexOf(agent) + (event.key === 'ArrowRight' ? 1 : -1) + catalogAgents.length) % catalogAgents.length];
      const next = target && catalogTabs.get(target);
      next?.click();
      next?.focus();
    });
    catalogTabs.set(agent, tab);
    modelCatalogTabs.append(tab);
  }
  const modelCatalogCount = el('span', 'ag-settings-model-count');
  modelCatalogTop.append(modelCatalogTabs, modelCatalogCount);
  const modelCatalogTools = el('div', 'ag-settings-model-tools');
  const modelCatalogSearchWrap = el('label', 'ag-settings-model-search');
  modelCatalogSearchWrap.append(createIcon('search'));
  const modelCatalogSearch = el('input', 'ag-settings-model-search-input') as HTMLInputElement;
  modelCatalogSearch.type = 'search';
  modelCatalogSearch.placeholder = '모델 검색';
  modelCatalogSearch.setAttribute('aria-label', '모델 검색');
  modelCatalogSearch.autocomplete = 'off';
  modelCatalogSearch.spellcheck = false;
  modelCatalogSearch.addEventListener('input', renderModelCatalog);
  modelCatalogSearchWrap.append(modelCatalogSearch);
  const modelCatalogRefresh = el('button', 'ag-settings-model-refresh');
  modelCatalogRefresh.type = 'button';
  modelCatalogRefresh.title = '모델 목록 새로고침';
  modelCatalogRefresh.setAttribute('aria-label', '모델 목록 새로고침');
  modelCatalogRefresh.append(createIcon('refresh'));
  modelCatalogRefresh.addEventListener('click', () => {
    if (modelCatalogAgent === 'pi') void loadPiCatalog(true);
    else void loadModelCatalog(modelCatalogAgent, true);
  });
  modelCatalogTools.append(modelCatalogSearchWrap, modelCatalogRefresh);
  const modelCatalogList = el('div', 'ag-settings-model-list');
  modelCatalogList.id = 'ag-settings-model-list';
  modelCatalogList.setAttribute('role', 'tabpanel');
  modelCatalogList.setAttribute('aria-label', '모델 선택');
  modelCatalogList.addEventListener('keydown', (event) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const rows = [...modelCatalogList.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
    const current = rows.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1
      : event.key === 'ArrowDown' ? Math.min(rows.length - 1, current + 1) : Math.max(0, current - 1);
    if (rows[next]) {
      event.preventDefault();
      rows[next].focus();
    }
  });
  const modelCatalogStatus = el('div', 'ag-settings-model-status');
  modelCatalogStatus.setAttribute('role', 'status');
  modelCatalogCard.append(modelCatalogTop, modelCatalogTools, piChips, modelCatalogList, modelCatalogStatus, piCatalogActions);
  modelCatalogSection.body.append(modelCatalogCard);

  // ── 4. 지시 ──────────────────────────────────────────
  const instructionsSection = createSection('지시');
  instructionsSection.root.classList.add('ag-settings-instructions-section');
  const instructionsEditor = createMarkdownEditor({
    className: 'ag-settings-instructions-editor',
    ariaLabel: '앱 전용 AGENTS.md 지시',
    placeholder: 'AGENTS.md를 불러오는 중…',
  });
  const instructionsStatus = el('p', 'ag-settings-instructions-status');
  instructionsStatus.hidden = true;
  const instructionsReload = el('button', 'ag-settings-quota-refresh');
  instructionsReload.type = 'button';
  instructionsReload.title = '다시 불러오기';
  instructionsReload.setAttribute('aria-label', '다시 불러오기');
  instructionsReload.append(createIcon('refresh'));
  instructionsSection.head.append(instructionsReload);
  const hancomGit = createToggleRow('한컴용 Git 사용하기');
  hancomGit.input.checked = userSettings.getUseHancomGit();
  hancomGit.input.addEventListener('change', () => {
    userSettings.setUseHancomGit(hancomGit.input.checked);
  });
  const unsubscribeHancomGit = userSettings.subscribeUseHancomGit((enabled) => {
    hancomGit.input.checked = enabled;
  });
  instructionsSection.body.append(
    instructionsEditor.root,
    instructionsStatus,
  );
  const gitSection = createSection('Git');
  gitSection.body.append(hancomGit.root);
  // 바꾸는 즉시 적용되는 문서 설정이라 편집 탭의 적용 줄 위에 둔다.
  editingSettings.element.insertBefore(
    gitSection.root,
    editingSettings.element.querySelector(':scope > .ag-settings-apply-footer'),
  );
  // 백그라운드 채팅 알림 — 데스크톱은 늘, 웹은 이 사이트가 이미 알림을 허락받았을 때만 보인다.
  // 꺼도 채팅 목록의 점과 확인 필요 칩은 남는다. Git 전환처럼 바꾸는 즉시 적용한다.
  const desktopShell = isDesktopApp();
  const notificationsSection = createSection('알림');
  const backgroundNotifications = createToggleRow(
    '백그라운드 채팅 알림',
    desktopShell
      ? '보이지 않는 채팅이 끝나거나, 답이나 검토를 기다리거나, 멈추면 알림과 앱 아이콘 배지로 알려 줍니다.'
      : '보이지 않는 채팅이 끝나거나, 답이나 검토를 기다리거나, 멈추면 브라우저 알림으로 알려 줍니다.',
  );
  // 알림 센터·잠금 화면에 남는 글 — 기본은 앱 이름과 정해진 문구뿐이다. 앱 안 토스트는 늘 제목을 보인다.
  const notificationDetails = createToggleRow(
    '알림에 채팅 제목과 문서 이름 표시',
    '끄면 알림에는 앱 이름과 "답변을 기다립니다" 같은 문구만 보여, 잠금 화면이나 알림 센터에 채팅 내용이 드러나지 않습니다.',
  );
  const initialAttentionPrefs = loadAttentionPrefs();
  backgroundNotifications.input.checked = initialAttentionPrefs.notifications;
  notificationDetails.input.checked = initialAttentionPrefs.showChatDetails;
  backgroundNotifications.input.addEventListener('change', () => {
    saveAttentionPrefs({ notifications: backgroundNotifications.input.checked });
  });
  notificationDetails.input.addEventListener('change', () => {
    saveAttentionPrefs({ showChatDetails: notificationDetails.input.checked });
  });
  const unsubscribeAttentionPrefs = subscribeAttentionPrefs((next) => {
    backgroundNotifications.input.checked = next.notifications;
    notificationDetails.input.checked = next.showChatDetails;
  });
  notificationsSection.body.append(backgroundNotifications.root, notificationDetails.root);
  const syncNotificationsSection = () => {
    notificationsSection.root.hidden = !desktopShell && !webNotificationsGranted();
  };
  syncNotificationsSection();
  // 자동 버그 수정 — 데스크톱만. 바꾸는 즉시 저장한다.
  const autofixSection = createAutofixSettingsSection();
  instructionsEditor.addEventListener('input', () => {
    instructionsDirty = instructionsEditor.value !== (agentInstructions?.content ?? '');
    instructionsMessage = '';
    renderAgentInstructions();
    renderDestinationState();
  });
  instructionsReload.addEventListener('click', async () => {
    if (instructionsDirty && !await confirmSheet(instructionsReload, '변경 버리기', '작성 중인 지시를 버리고 다시 불러옵니다.', { confirmLabel: '버리기', destructive: true })) return;
    instructionsDirty = false;
    instructionsMessage = '';
    void refreshAgentInstructions(true);
  });

  // ── 5. 글쓰기 보정 ────────────────────────────────────

  // ── 6. 템플릿 ─────────────────────────────────────────
  const templatesSection = createSection('템플릿');
  templatesSection.root.classList.add('ag-settings-templates-section');
  const templatesNote = el('p', 'ag-settings-note', '채팅에서 /templates로 선택');
  const templatesList = el('div', 'ag-template-list');
  const templatesStatus = el('p', 'ag-settings-cliproxy-error');
  templatesStatus.hidden = true;
  const addTemplateInput = document.createElement('input');
  addTemplateInput.type = 'file';
  addTemplateInput.accept = '.hwp,.hwpx';
  addTemplateInput.hidden = true;
  const replaceTemplateInput = document.createElement('input');
  replaceTemplateInput.type = 'file';
  replaceTemplateInput.accept = '.hwp,.hwpx';
  replaceTemplateInput.hidden = true;
  let replacingTemplateId: string | null = null;
  const addTemplateBtn = el('button', 'ag-settings-btn', '템플릿 추가');
  addTemplateBtn.type = 'button';
  addTemplateBtn.addEventListener('click', () => addTemplateInput.click());
  addTemplateInput.addEventListener('change', () => {
    const file = addTemplateInput.files?.[0];
    addTemplateInput.value = '';
    if (file) void promptToAddTemplate(file);
  });
  replaceTemplateInput.addEventListener('change', () => {
    const file = replaceTemplateInput.files?.[0];
    const id = replacingTemplateId;
    replaceTemplateInput.value = '';
    replacingTemplateId = null;
    if (file && id) void replaceTemplate(id, file);
  });
  const templatesFooter = el('div', 'ag-settings-row ag-template-footer');
  templatesFooter.append(templatesNote, addTemplateBtn);
  templatesSection.body.append(templatesList, templatesStatus, templatesFooter, addTemplateInput, replaceTemplateInput);

  // Electron's native browser prompt is unreliable, so add and rename share
  // a small in-app naming dialog.
  const templateNameOverlay = el('div', 'ag-template-name-overlay');
  templateNameOverlay.setAttribute('aria-hidden', 'true');
  const templateNameDialog = document.createElement('form');
  templateNameDialog.className = 'ag-template-name-dialog';
  templateNameDialog.setAttribute('role', 'dialog');
  templateNameDialog.setAttribute('aria-modal', 'true');
  templateNameDialog.setAttribute('aria-labelledby', 'ag-template-name-title');
  const templateNameTitle = el('h2', 'ag-template-name-title');
  templateNameTitle.id = 'ag-template-name-title';
  const templateNameDescription = el('p', 'ag-settings-note');
  const templateNameInput = document.createElement('input');
  templateNameInput.className = 'ag-template-name-input';
  templateNameInput.type = 'text';
  templateNameInput.maxLength = 80;
  templateNameInput.required = true;
  templateNameInput.autocomplete = 'off';
  templateNameInput.setAttribute('aria-label', '템플릿 이름');
  const templateNameActions = el('div', 'ag-template-name-actions');
  const templateNameCancel = el('button', 'ag-settings-btn', '취소');
  templateNameCancel.type = 'button';
  const templateNameSave = el('button', 'ag-settings-primary', '저장');
  templateNameSave.type = 'submit';
  templateNameActions.append(templateNameCancel, templateNameSave);
  templateNameDialog.append(templateNameTitle, templateNameDescription, templateNameInput, templateNameActions);
  templateNameOverlay.appendChild(templateNameDialog);
  let resolveTemplateName: ((name: string | null) => void) | null = null;

  templateNameDialog.addEventListener('submit', (event) => {
    event.preventDefault();
    const name = templateNameInput.value.trim();
    if (!name) {
      templateNameInput.setCustomValidity('템플릿 이름 입력');
      templateNameInput.reportValidity();
      return;
    }
    finishTemplateName(name);
  });
  templateNameInput.addEventListener('input', () => templateNameInput.setCustomValidity(''));
  templateNameCancel.addEventListener('click', () => finishTemplateName(null));
  templateNameOverlay.addEventListener('pointerdown', (event) => {
    if (event.target === templateNameOverlay) finishTemplateName(null);
  });
  templateNameOverlay.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') finishTemplateName(null);
  });

  // ── 7. 사용량 ─────────────────────────────────────────
  let settingsOpen = false;
  const unsubscribeBrowserSettings = bridge.onBrowserEvent((event) => {
    if (!settingsOpen || currentDestination !== 'browser') return;
    if (event.type === 'user-secrets-changed') browserPane.secretsChanged();
    else if (event.type === 'site-recipes-changed') browserPane.recipesChanged();
    else if (['browser-account-changed', 'browser-policy-changed', 'browser-runtime-state', 'owned_browser_runtime'].includes(event.type)) browserPane.open();
  });
  let usageBusy = false;
  let usagePoll: ReturnType<typeof setInterval> | null = null;
  const quotaSection = createSection('사용량');
  quotaSection.root.classList.add('ag-settings-quota-section');
  const quotaCards = createProviderQuota(bridge, (summary) => { usage = summary; renderUsage(); }, () => void refreshUsage(true));
  const usageFeedback = el('p', 'ag-settings-note');
  usageFeedback.setAttribute('role', 'status');
  quotaSection.body.append(usageFeedback, quotaCards.element);
  const usageViews = createUsageViews(bridge, { section: quotaSection.root, refreshLimits: () => void refreshUsage(true) });
  quotaSection.head.append(usageViews.controls);
  quotaSection.body.append(usageViews.element);

  const aiStatus = el('p', 'ag-settings-apply-status');
  aiStatus.hidden = true;
  aiStatus.setAttribute('role', 'status');
  const aiCancel = el('button', 'ag-settings-btn', '취소');
  aiCancel.type = 'button';
  const aiApply = el('button', 'ag-settings-primary', '적용');
  aiApply.type = 'button';
  const aiFooter = el('div', 'ag-settings-apply-footer ag-settings-ai-footer');
  aiFooter.append(aiStatus, aiCancel, aiApply);
  // 자주 바꾸고 결과가 큰 것부터 둔다. 세부 탭은 이 순서를 그대로 걸러 보여 준다.
  const aiContent = el('div', 'ag-settings-destination-content');
  const aiSectionMembers: ReadonlyArray<readonly [AiSettingsSection, HTMLElement]> = [
    ['connection', connection.root],
    ['usage', quotaSection.root],
    ['connection', defaults.root],
    ['custom', editLockSection.root],
    ['connection', modelCatalogSection.root],
    ['custom', instructionsSection.root],
    ['custom', templatesSection.root],
    ['custom', notificationsSection.root],
    ['rau', rauPane.root],
    ...(autofixSection ? [['connection', autofixSection.root] as const] : []),
  ];
  // 좁은 폭에서는 사이드 목록이 가로 탭 줄이 되므로 세부 탭을 본문 위에 따로 둔다.
  const aiSubnav = el('div', 'ag-settings-segmented ag-settings-ai-subnav');
  aiSubnav.setAttribute('role', 'tablist');
  aiSubnav.setAttribute('aria-label', 'AI 설정');
  const aiSubnavButtons = new Map<AiSettingsSection, HTMLButtonElement>();
  for (const section of aiSections) {
    const segment = el('button', 'ag-settings-segment', section.label);
    segment.type = 'button';
    segment.setAttribute('role', 'tab');
    segment.addEventListener('click', () => selectAiSection(section.id));
    if (section.id === 'rau') segment.append(createRauLock());
    aiSubnav.appendChild(segment);
    aiSubnavButtons.set(section.id, segment);
  }
  const rauSegment = aiSubnavButtons.get('rau')!;
  aiContent.append(
    aiSubnav,
    defaults.root,
    connection.root,
    quotaSection.root,
    modelCatalogSection.root,
    instructionsSection.root,
    templatesSection.root,
    notificationsSection.root,
    ...(autofixSection ? [autofixSection.root] : []),
    editLockSection.root,
    rauPane.root,
    aiFooter,
  );
  panes.get('ai')?.appendChild(aiContent);
  if (skillsSettings) {
    const skillsContent = el('div', 'ag-settings-destination-content ag-settings-skills-content');
    skillsContent.appendChild(skillsSettings);
    panes.get('skills')?.appendChild(skillsContent);
  }

  aiApply.addEventListener('click', () => void applyAiDraft());
  aiCancel.addEventListener('click', cancelAiDraft);
  aiGroupHeader.addEventListener('click', () => {
    if (aiLocked()) {
      deps.openPlans?.();
      return;
    }
    if (aiGroupExpanded && currentDestination === 'ai') {
      aiGroupExpanded = false;
      renderDestinationState();
      return;
    }
    aiGroupExpanded = true;
    if (currentDestination === 'ai') renderDestinationState();
    else void requestDestination('ai');
  });
  for (const [destination, button] of navButtons) {
    if (destination !== 'ai') button.addEventListener('click', () => void requestDestination(destination));
  }
  for (const [section, button] of aiSectionButtons) {
    button.addEventListener('click', () => {
      if (section === 'rau' && rauLocked()) openRauPlans?.();
      else if (currentDestination === 'ai') selectAiSection(section);
      else void requestDestination('ai', section);
    });
  }
  // 왼쪽 목록 맨 위의 검색: 모든 탭의 머리말과 라벨을 찾아 그 자리로 데려간다.
  const searchSelector = '.ag-settings-section-title, .ag-settings-group-title, .ag-settings-group-heading, .ag-settings-control-label, .ag-settings-field-label';
  function collectSearchTargets(): SettingsSearchTarget[] {
    const targets: SettingsSearchTarget[] = [];
    for (const destination of destinations) {
      const pane = panes.get(destination.id);
      if (!pane || (destination.id === 'ai' && aiLocked())) continue;
      for (const label of pane.querySelectorAll<HTMLElement>(searchSelector)) {
        const text = label.textContent?.trim();
        // 프로젝트·보관한 채팅 이름은 설정이 아니다.
        if (!text || label.closest('.ag-pset-storage')) continue;
        let hidden = false;
        for (let node: HTMLElement | null = label; node && node !== pane; node = node.parentElement) {
          if (node.hidden) { hidden = true; break; }
        }
        if (hidden) continue;
        const aiSection = destination.id === 'ai'
          ? aiSectionMembers.find(([, member]) => member.contains(label))?.[0]
          : undefined;
        if (aiSection === 'rau' && rauLocked()) continue;
        const sectionLabel = aiSection ? aiSections.find((section) => section.id === aiSection)?.label : undefined;
        const icon = aiSection ? aiSections.find((section) => section.id === aiSection)?.icon : destination.icon;
        targets.push({
          label: text,
          path: sectionLabel ? `${destination.label} › ${sectionLabel}` : destination.label,
          icon,
          element: label,
        });
      }
    }
    return targets;
  }
  async function openSearchTarget(target: SettingsSearchTarget): Promise<void> {
    const pane = target.element.closest<HTMLElement>('.ag-settings-pane');
    const destination = pane?.dataset.destination as SettingsDestination | undefined;
    if (!destination) return;
    const aiSection = destination === 'ai'
      ? aiSectionMembers.find(([, member]) => member.contains(target.element))?.[0]
      : undefined;
    if (destination !== currentDestination) {
      if (!await resolveDirtyExit()) return;
      selectDestination(destination, aiSection);
    } else if (aiSection && aiSection !== currentAiSection) {
      selectAiSection(aiSection);
    }
    const spot = target.element.closest<HTMLElement>('.ag-settings-control-row, .ag-settings-field, .ag-settings-section, .ag-settings-group')
      ?? target.element;
    requestAnimationFrame(() => {
      spot.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
      // 찾은 머리말·라벨 글자만 하마 색으로 잠깐 밝힌다. 스크롤이 멈춘 뒤에 켜야 눈에 들어온다.
      const hit = target.element;
      hit.classList.remove('ag-settings-search-hit');
      let started = false;
      const flash = () => {
        if (started) return;
        started = true;
        document.removeEventListener('scrollend', flash, true);
        void hit.offsetWidth;
        hit.classList.add('ag-settings-search-hit');
        hit.addEventListener('animationend', () => hit.classList.remove('ag-settings-search-hit'), { once: true });
      };
      document.addEventListener('scrollend', flash, true);
      // 이미 보이는 자리라 스크롤이 없으면 scrollend 가 오지 않는다.
      setTimeout(flash, 700);
    });
  }
  const settingsSearch = createSettingsSearch({
    collect: collectSearchTargets,
    open: (target) => void openSearchTarget(target),
    onActiveChange: (active) => navigation.classList.toggle('ag-settings-searching', active),
  });
  navigation.prepend(settingsSearch.root);
  element.addEventListener('keydown', (event) => {
    if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey || event.isComposing) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])')) return;
    event.preventDefault();
    settingsSearch.focus();
  });
  // 위아래 화살표는 보이는 목록 순서대로 옮긴다. 펼친 AI 묶음은 머리 대신 세부 탭이 자리를 차지한다.
  navigation.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight'
      && event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    const items = [...navigation.querySelectorAll<HTMLButtonElement>('.ag-settings-nav-button')]
      .filter((button) => !button.hidden && !button.closest('[hidden]'));
    const index = items.indexOf(event.target as HTMLButtonElement);
    if (index < 0) return;
    event.preventDefault();
    const delta = event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1;
    const next = items[(index + delta + items.length) % items.length];
    if (!next) return;
    next.focus();
    // 잠긴 Rau 탭은 화살표로 지나갈 때 요금제 카드를 띄우지 않는다 — Enter·Space 로만 연다.
    if (next === aiGroupHeader || (next === rauNavButton && rauLocked())) return;
    next.click();
  });
  shellReady = true;

  setupKey.input.addEventListener('input', renderAgentSetup);

  // ── 상태 → DOM ────────────────────────────────────────

  function samePrefs(left: AgentPrefs, right: AgentPrefs): boolean {
    return left.defaultAgent === right.defaultAgent
      && left.defaultModel === right.defaultModel
      && left.defaultEffort === right.defaultEffort
      && left.defaultMode === right.defaultMode
      && left.editLock === right.editLock
      && PLAN_AGENTS.every((agent) => left.selectedModels[agent].join('\u0000') === right.selectedModels[agent].join('\u0000'));
  }

  function clonePrefs(value: AgentPrefs): AgentPrefs {
    return {
      ...value,
      selectedModels: {
        claude: [...value.selectedModels.claude],
        codex: [...value.selectedModels.codex],
      },
    };
  }

  function isAiDirty(): boolean {
    return instructionsDirty || !samePrefs(prefsDraft, prefsBaseline);
  }

  function isCurrentDestinationDirty(): boolean {
    switch (currentDestination) {
      case 'editing':
        return editingSettings.isDirty();
      case 'theme':
        return themeSettings.isDirty();
      case 'ai':
        return isAiDirty();
      case 'browser':
      case 'skills':
      case 'archive':
      case 'account':
        return false;
      case 'project':
        return projectPane.isDirty();
      default: {
        const _exhaustive: never = currentDestination;
        return _exhaustive;
      }
    }
  }

  function renderDestinationState(): void {
    for (const destination of destinations) {
      const selected = destination.id === currentDestination;
      const button = navButtons.get(destination.id);
      const pane = panes.get(destination.id);
      if (destination.id !== 'ai') {
        button?.classList.toggle('ag-active', selected);
        button?.setAttribute('aria-selected', String(selected));
        button?.setAttribute('tabindex', selected ? '0' : '-1');
      }
      if (pane) {
        pane.hidden = !selected;
        pane.inert = !selected;
      }
    }
    renderAiSectionState();
    const dirty = isAiDirty();
    aiApply.disabled = !dirty || instructionsBusy || aiPrefsSaving;
    aiCancel.disabled = !dirty || instructionsBusy || aiPrefsSaving;
    agentField.select.disabled = aiPrefsSaving;
    modelField.select.disabled = aiPrefsSaving;
    effortField.select.disabled = aiPrefsSaving;
    modeField.select.disabled = aiPrefsSaving;
    modelCatalogList.inert = aiPrefsSaving;
    modelCatalogRefresh.disabled = aiPrefsSaving || connectionState !== 'connected'
      || (modelCatalogAgent === 'pi'
        ? !piStatus?.installed || !piHasCredential() || piBusy || setupBusy || piCatalogLoading
        : modelCatalogLoading.has(modelCatalogAgent));
  }

  function aiLocked(): boolean {
    return deps.agentLocked?.() === true;
  }

  /** 요금제를 알고 Rau 가 아니면 Rau 세부 탭이 잠긴다. 요금제 API 가 없는 웹 Studio 에서는 열려 있다. */
  function rauLocked(): boolean {
    return planLocksRau(deps.plan?.status() ?? null);
  }

  function syncRauLock(): void {
    const locked = rauLocked();
    for (const button of [rauNavButton, rauSegment]) {
      button.classList.toggle('ag-settings-ai-locked', locked);
      button.classList.toggle('ag-settings-rau-locked', locked);
      // 자물쇠 그림은 aria-hidden 이라 잠김을 말로도 알린다.
      if (locked) {
        button.title = 'Rau에서 쓸 수 있어요';
        button.setAttribute('aria-description', 'Rau에서 쓸 수 있어요');
      } else {
        button.removeAttribute('title');
        button.removeAttribute('aria-description');
      }
    }
    if (locked && currentAiSection === 'rau') {
      currentAiSection = 'connection';
      renderAiSectionState();
      syncRauPane();
    }
  }

  function syncRauPane(): void {
    if (settingsOpen && currentDestination === 'ai' && currentAiSection === 'rau') rauPane.open();
    else rauPane.close();
  }

  function syncPlanLock(): void {
    syncRauLock();
    const locked = aiLocked();
    aiGroupHeader.classList.toggle('ag-settings-ai-locked', locked);
    if (locked) aiGroupHeader.title = 'Hama에서 쓸 수 있어요';
    else aiGroupHeader.removeAttribute('title');
    if (!locked) return;
    aiGroupExpanded = false;
    if (currentDestination === 'ai') selectDestination('editing');
    else renderAiSectionState();
  }

  function renderAiSectionState(): void {
    const onAi = currentDestination === 'ai';
    aiGroupHeader.setAttribute('aria-expanded', String(aiGroupExpanded));
    aiGroupHeader.classList.toggle('ag-has-active', onAi);
    // 접힌 채로 AI 에 있으면 머리가 고른 자리를 대신 보여 주고 키보드 초점도 받는다.
    aiGroupHeader.classList.toggle('ag-active', onAi && !aiGroupExpanded);
    aiGroupHeader.setAttribute('tabindex', onAi && !aiGroupExpanded ? '0' : '-1');
    aiGroupList.hidden = !aiGroupExpanded;
    for (const [section, button] of aiSectionButtons) {
      const selected = onAi && section === currentAiSection;
      button.classList.toggle('ag-active', selected);
      button.setAttribute('aria-selected', String(selected));
      button.setAttribute('tabindex', selected && aiGroupExpanded ? '0' : '-1');
    }
    for (const [section, segment] of aiSubnavButtons) {
      const selected = section === currentAiSection;
      segment.classList.toggle('ag-active', selected);
      segment.setAttribute('aria-selected', String(selected));
    }
    for (const [section, member] of aiSectionMembers) member.classList.toggle('ag-settings-ai-off', section !== currentAiSection);
    // Rau 는 바로 저장되므로 AI 초안의 적용 줄을 두지 않는다.
    aiFooter.classList.toggle('ag-settings-ai-off', currentAiSection === 'rau');
    syncTokenUsage();
    const pane = panes.get('ai');
    pane?.setAttribute('aria-labelledby', aiGroupExpanded ? `ag-settings-tab-ai-${currentAiSection}` : aiGroupHeader.id);
  }

  function selectAiSection(section: AiSettingsSection): void {
    if (section === 'rau' && rauLocked()) {
      openRauPlans?.();
      return;
    }
    const changed = section !== currentAiSection;
    currentAiSection = section;
    aiGroupExpanded = true;
    try {
      sessionStorage.setItem('rhwp-settings-ai-section', section);
    } catch {
      // 세션 저장소가 막혀도 설정 탐색은 계속 동작한다.
    }
    renderAiSectionState();
    syncRauPane();
    if (changed) panes.get('ai')?.scrollTo({ top: 0 });
  }

  function selectDestination(requested: SettingsDestination, aiSection?: AiSettingsSection): void {
    let destination = requested;
    let section = aiSection;
    // 잠긴 Rau 를 바로 열면 자리를 옮기지 않고 요금제 카드를 Rau 칸에 맞춰 연다.
    if (section === 'rau' && rauLocked()) {
      openRauPlans?.();
      section = undefined;
      destination = currentDestination === 'ai' && aiLocked() ? 'editing' : currentDestination;
    }
    // 설정 열기, 검색, 연결 안내 어디서 오든 잠긴 AI 로는 들어가지 않는다.
    if (destination === 'ai' && aiLocked()) {
      deps.openPlans?.();
      destination = currentDestination === 'ai' ? 'editing' : currentDestination;
    }
    if (destination === 'ai') {
      aiGroupExpanded = true;
      if (section) selectAiSection(section);
    }
    currentDestination = destination;
    lastDestination = destination;
    try {
      sessionStorage.setItem('rhwp-settings-destination', destination);
    } catch {
      // 세션 저장소가 막혀도 설정 탐색은 계속 동작한다.
    }
    renderDestinationState();
    syncUsagePolling();
    if (destination === 'account') accountSection?.open();
    else accountSection?.close();
    if (destination === 'browser') browserPane.open();
    if (destination === 'skills') refreshSkills?.();
    if (destination === 'project') projectPane.open();
    if (destination === 'archive') archivePane.open();
    syncRauPane();
    if (destination === 'ai') for (const row of assistantRows) void row.refresh(true);
    panes.get(destination)?.scrollTo({ top: 0 });
  }

  function stagePrefs(partial: Partial<AgentPrefs>): void {
    prefsDraft = normalizeAgentPrefs({ ...prefsDraft, ...partial });
    syncPrefsInputs();
    renderModelCatalog();
    aiStatus.hidden = true;
    renderDestinationState();
  }

  function persistPrefs(nextPrefs: AgentPrefs): ReturnType<typeof trySaveAgentPrefs> {
    const result = trySaveAgentPrefs(nextPrefs);
    if (result.ok) {
      prefs = result.value;
      prefsBaseline = clonePrefs(result.value);
      prefsDraft = clonePrefs(result.value);
      applyDefaults(result.value);
    }
    return result;
  }

  async function applyAiDraft(): Promise<boolean> {
    const nextPrefs = normalizeAgentPrefs(prefsDraft);
    if (instructionsDirty) {
      const maxChars = agentInstructions?.maxChars ?? 30_000;
      if (!agentInstructions || instructionsEditor.value.length > maxChars) {
        instructionsMessage = 'AGENTS.md 내용 확인 필요';
        renderAgentInstructions();
        return false;
      }
    }
    if (nextPrefs.defaultMode === 'full'
      && prefsBaseline.defaultMode !== 'full'
      && !await confirmSheet(aiStatus, '기본 모드를 전체로', UNRESTRICTED_DEFAULT_WARNING, { confirmLabel: '적용' })) {
      aiStatus.textContent = '적용 취소';
      aiStatus.hidden = false;
      return false;
    }
    if (instructionsDirty) {
      aiPrefsSaving = true;
      renderDestinationState();
      try {
        const savedInstructions = await saveAgentInstructions();
        if (!savedInstructions) return false;
      } finally {
        aiPrefsSaving = false;
        if (!disposed) renderDestinationState();
      }
    }
    if (!samePrefs(nextPrefs, prefsBaseline)) {
      const result = persistPrefs(nextPrefs);
      if (!result.ok) {
        prefsDraft = nextPrefs;
        aiStatus.textContent = `AI 기본값을 저장하지 못했습니다. ${result.error}`;
        aiStatus.hidden = false;
        renderDestinationState();
        return false;
      }
    }
    aiStatus.textContent = 'AI 설정을 적용했습니다.';
    aiStatus.hidden = false;
    syncPrefsInputs();
    renderModelCatalog();
    renderDestinationState();
    return true;
  }

  function cancelAiDraft(): void {
    prefsDraft = clonePrefs(prefsBaseline);
    if (agentInstructions) {
      instructionsEditor.value = agentInstructions.content;
      instructionsDraftRevision = agentInstructions.revision;
    }
    instructionsDirty = false;
    instructionsMessage = '';
    aiStatus.hidden = true;
    syncPrefsInputs();
    renderModelCatalog();
    renderAgentInstructions();
    renderDestinationState();
  }

  function askDirtyExit(): Promise<DirtyExitChoice> {
    const previousFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const overlay = el('div', 'ag-settings-dirty-overlay');
    overlay.setAttribute('role', 'presentation');
    const dialog = el('div', 'ag-settings-dirty-dialog');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', 'ag-settings-dirty-title');
    dialog.setAttribute('aria-describedby', 'ag-settings-dirty-description');
    const dialogTitle = el('h2', 'ag-settings-dirty-title', '적용하지 않은 변경');
    dialogTitle.id = 'ag-settings-dirty-title';
    const description = el(
      'p',
      'ag-settings-dirty-description',
      '이동하기 전에 적용하거나 버립니다.',
    );
    description.id = 'ag-settings-dirty-description';
    const actions = el('div', 'ag-settings-dirty-actions');
    const applyButton = el('button', 'ag-settings-primary', '적용');
    applyButton.type = 'button';
    const discardButton = el('button', 'ag-settings-btn ag-settings-danger', '버리기');
    discardButton.type = 'button';
    const continueButton = el('button', 'ag-settings-btn', '계속 편집');
    continueButton.type = 'button';
    actions.append(applyButton, discardButton, continueButton);
    dialog.append(dialogTitle, description, actions);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
    return new Promise((resolve) => {
      const finish = (choice: DirtyExitChoice) => {
        overlay.remove();
        previousFocus?.focus();
        resolve(choice);
      };
      applyButton.addEventListener('click', () => finish('apply'));
      discardButton.addEventListener('click', () => finish('discard'));
      continueButton.addEventListener('click', () => finish('continue'));
      overlay.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          finish('continue');
          return;
        }
        if (event.key !== 'Tab') return;
        const first = applyButton;
        const last = continueButton;
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      });
      requestAnimationFrame(() => continueButton.focus());
    });
  }

  async function resolveDirtyExit(): Promise<boolean> {
    if (!isCurrentDestinationDirty()) return true;
    const choice = await askDirtyExit();
    if (choice === 'continue') return false;
    if (choice === 'discard') {
      switch (currentDestination) {
        case 'editing':
          editingSettings.cancel();
          return true;
        case 'theme':
          themeSettings.cancel();
          return true;
        case 'ai':
          cancelAiDraft();
          return true;
        case 'browser':
      case 'skills':
        case 'archive':
        case 'account':
          return true;
        case 'project':
          projectPane.cancel();
          return true;
        default: {
          const _exhaustive: never = currentDestination;
          return _exhaustive;
        }
      }
    }
    switch (currentDestination) {
      case 'editing':
        return editingSettings.apply();
      case 'theme':
        return themeSettings.apply();
      case 'ai':
        return applyAiDraft();
      case 'browser':
      case 'skills':
      case 'archive':
      case 'account':
        return true;
      case 'project':
        return projectPane.apply();
      default: {
        const _exhaustive: never = currentDestination;
        return _exhaustive;
      }
    }
  }

  async function requestDestination(destination: SettingsDestination, aiSection?: AiSettingsSection): Promise<void> {
    if (destination === currentDestination) return;
    if (!await resolveDirtyExit()) return;
    selectDestination(destination, aiSection);
    if (destination === 'ai') aiSectionButtons.get(currentAiSection)?.focus();
    else navButtons.get(destination)?.focus();
  }

  function templateSize(bytes: number): string {
    return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  function renderTemplates(): void {
    templatesList.replaceChildren();
    for (const template of templates) {
      const row = el('div', 'ag-template-row');
      const text = el('div', 'ag-template-row-text');
      text.append(
        el('span', 'ag-settings-row-name', template.name),
        el('span', 'ag-settings-row-detail', `${template.format.toUpperCase()}, ${templateSize(template.size)}, ${template.pageCount}쪽, r${template.revision}`),
      );
      const actions = el('div', 'ag-template-actions');
      const rename = el('button', 'ag-settings-btn', '이름 변경');
      rename.type = 'button';
      rename.addEventListener('click', () => {
        void requestTemplateName('템플릿 이름 변경', template.name, `현재 이름: ${template.name}`).then((name) => {
          if (name && name !== template.name) void renameTemplate(template.id, name);
        });
      });
      const replace = el('button', 'ag-settings-btn', '교체');
      replace.type = 'button';
      replace.addEventListener('click', () => {
        replacingTemplateId = template.id;
        replaceTemplateInput.click();
      });
      const remove = el('button', 'ag-settings-btn ag-template-delete', '삭제');
      remove.type = 'button';
      remove.addEventListener('click', async () => {
        if (await confirmSheet(remove, `“${template.name}” 삭제`, undefined, { confirmLabel: '삭제', destructive: true })) void deleteTemplate(template.id);
      });
      actions.append(rename, replace, remove);
      row.append(text, actions);
      templatesList.appendChild(row);
    }
    templatesStatus.textContent = templatesMessage;
    templatesStatus.hidden = !templatesMessage;
    addTemplateBtn.disabled = templatesBusy || connectionState !== 'connected';
    for (const button of templatesList.querySelectorAll('button')) (button as HTMLButtonElement).disabled = templatesBusy;
  }

  async function refreshTemplates(): Promise<void> {
    try {
      const catalog = await bridge.listTemplates();
      if (disposed) return;
      templates = catalog.templates;
      templatesMessage = '';
    } catch (error) {
      if (!disposed) templatesMessage = error instanceof Error ? error.message : String(error);
    }
    renderTemplates();
  }

  async function withTemplateMutation(operation: () => Promise<unknown>): Promise<void> {
    templatesBusy = true;
    templatesMessage = '';
    renderTemplates();
    try {
      await operation();
      await refreshTemplates();
    } catch (error) {
      templatesMessage = error instanceof Error ? error.message : String(error);
    } finally {
      templatesBusy = false;
      renderTemplates();
    }
  }

  function requestTemplateName(title: string, initialName: string, description: string): Promise<string | null> {
    finishTemplateName(null);
    templateNameTitle.textContent = title;
    templateNameDescription.textContent = description;
    templateNameInput.value = initialName;
    templateNameInput.setCustomValidity('');
    document.body.appendChild(templateNameOverlay);
    templateNameOverlay.setAttribute('aria-hidden', 'false');
    requestAnimationFrame(() => {
      templateNameOverlay.classList.add('ag-open');
      templateNameInput.focus();
      templateNameInput.select();
    });
    return new Promise((resolve) => {
      resolveTemplateName = resolve;
    });
  }

  function finishTemplateName(name: string | null): void {
    const resolve = resolveTemplateName;
    resolveTemplateName = null;
    templateNameOverlay.classList.remove('ag-open');
    templateNameOverlay.setAttribute('aria-hidden', 'true');
    templateNameOverlay.remove();
    resolve?.(name);
  }

  async function promptToAddTemplate(file: File): Promise<void> {
    const defaultName = file.name.replace(/\.(?:hwp|hwpx)$/i, '');
    const name = await requestTemplateName('템플릿 추가', defaultName, `선택한 파일: ${file.name}`);
    if (name) await addTemplate(file, name);
  }

  function addTemplate(file: File, name: string): Promise<void> {
    return withTemplateMutation(() => bridge.addTemplate(file, name));
  }

  function renameTemplate(id: string, name: string): Promise<void> {
    return withTemplateMutation(() => bridge.renameTemplate(id, name));
  }

  function replaceTemplate(id: string, file: File): Promise<void> {
    return withTemplateMutation(() => bridge.replaceTemplate(id, file));
  }

  function deleteTemplate(id: string): Promise<void> {
    return withTemplateMutation(() => bridge.deleteTemplate(id));
  }

  /** 설정이 끝나기 전의 pi 는 기본 제공자 후보에서 빠진다. */
  function selectableAgents(): readonly AgentName[] {
    return PROVIDER_ORDER.filter((agent) => {
      if (agent === 'pi') return piStatus?.setupComplete === true;
      return true;
    });
  }

  function renderModelCatalog(): void {
    modelCatalogList.setAttribute('aria-labelledby', `ag-settings-model-tab-${modelCatalogAgent}`);
    for (const [agent, tab] of catalogTabs) {
      const active = agent === modelCatalogAgent;
      tab.classList.toggle('ag-active', active);
      tab.setAttribute('aria-selected', String(active));
      tab.tabIndex = active ? 0 : -1;
    }
    modelCatalogSearch.disabled = false;
    const agent = modelCatalogAgent;
    piCatalogActions.hidden = agent !== 'pi';
    piChips.hidden = agent !== 'pi' || piDraft.length === 0;
    if (agent === 'pi') {
      renderSharedPiCatalog();
      return;
    }
    const selected = new Set(prefsDraft.selectedModels[agent]);
    const entries = availableModelsForAgent(agent);
    const terms = modelCatalogSearch.value.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    const matches = entries.filter((entry) => terms.every((term) =>
      `${entry.label} ${entry.id} ${entry.description ?? ''}`.toLocaleLowerCase().includes(term)));
    const focusedId = modelCatalogList.contains(document.activeElement)
      ? (document.activeElement as HTMLElement).dataset.modelId : null;
    const scrollTop = modelCatalogList.scrollTop;
    modelCatalogList.replaceChildren();
    if (matches.length === 0) {
      const message = modelCatalogLoading.has(agent) ? '모델을 불러오는 중…'
        : terms.length ? '검색 결과가 없습니다.' : '사용 가능한 모델이 없습니다.';
      modelCatalogList.append(el('div', 'ag-settings-model-empty', message));
    }
    for (const entry of matches) {
      const active = selected.has(entry.id);
      const row = el('button', 'ag-settings-model-row');
      row.type = 'button';
      row.dataset.modelId = entry.id;
      row.classList.toggle('ag-active', active);
      row.setAttribute('aria-pressed', String(active));
      row.setAttribute('aria-label', `${entry.label}, ${active ? '선택됨' : '선택 안 됨'}`);
      row.title = entry.description ? `${entry.id}\n${entry.description}` : entry.id;
      row.disabled = aiPrefsSaving;
      const text = el('span', 'ag-settings-model-row-text');
      const name = el('span', 'ag-settings-model-row-name', entry.label);
      text.append(name);
      if (entry.description) text.append(el('span', 'ag-settings-model-row-description', entry.description));
      const trailing = el('span', 'ag-settings-model-row-trailing');
      if (prefsDraft.defaultAgent === agent && prefsDraft.defaultModel === entry.id) {
        trailing.append(el('span', 'ag-settings-model-default', '기본값'));
      }
      const check = el('span', 'ag-settings-model-check');
      check.append(createIcon('check'));
      check.setAttribute('aria-hidden', 'true');
      trailing.append(check);
      row.append(text, trailing);
      row.addEventListener('click', () => {
        const current = prefsDraft.selectedModels[agent];
        if (current.includes(entry.id) && current.length === 1) return;
        const next = current.includes(entry.id)
          ? current.filter((id) => id !== entry.id)
          : [...current, entry.id];
        const selectedModels = { ...prefsDraft.selectedModels, [agent]: next };
        const defaultModel = prefsDraft.defaultAgent === agent && !next.includes(prefsDraft.defaultModel)
          ? next[0] ?? '' : prefsDraft.defaultModel;
        stagePrefs({ selectedModels, defaultModel });
      });
      modelCatalogList.append(row);
    }
    modelCatalogList.scrollTop = scrollTop;
    if (focusedId) {
      [...modelCatalogList.querySelectorAll<HTMLButtonElement>('button')]
        .find((row) => row.dataset.modelId === focusedId)?.focus({ preventScroll: true });
    }
    modelCatalogCount.textContent = `${selected.size}개 선택`;
    modelCatalogStatus.textContent = modelCatalogLoading.has(agent) ? '목록을 불러오는 중…'
      : modelCatalogErrors.has(agent) ? '목록을 불러오지 못했습니다. 새로고침을 눌러 다시 시도하세요.'
      : terms.length ? `${matches.length}개 결과` : '';
    modelCatalogRefresh.disabled = aiPrefsSaving || modelCatalogLoading.has(agent) || connectionState !== 'connected';
  }

  async function loadModelCatalog(agent: PlanAgent, refresh = false): Promise<void> {
    if (modelCatalogLoading.has(agent) || connectionState !== 'connected') return;
    modelCatalogLoading.add(agent);
    modelCatalogErrors.delete(agent);
    renderModelCatalog();
    const result = await bridge.requestModelCatalog(agent, refresh);
    if (disposed) return;
    modelCatalogLoading.delete(agent);
    if (!result) modelCatalogErrors.add(agent);
    else {
      prefsBaseline = normalizeAgentPrefs(prefsBaseline);
      prefsDraft = normalizeAgentPrefs(prefsDraft);
      syncPrefsInputs();
    }
    renderModelCatalog();
    renderDestinationState();
  }

  function syncPrefsInputs(): void {
    fillSelect(
      agentField.select,
      selectableAgents().map((agent) => ({ id: agent, label: AGENT_LABEL[agent] })),
    );
    agentField.select.value = prefsDraft.defaultAgent;
    providerMark.replaceChildren(createProviderIcon(prefsDraft.defaultAgent));
    if (prefsDraft.defaultAgent === 'claude' || prefsDraft.defaultAgent === 'codex') {
      const selected = new Set(prefsDraft.selectedModels[prefsDraft.defaultAgent]);
      fillSelect(modelField.select, availableModelsForAgent(prefsDraft.defaultAgent)
        .filter((model) => selected.has(model.id))
        .map((model) => ({ id: model.id, label: model.label })));
    } else {
      fillSelectGrouped(modelField.select, modelGroupsForAgent(prefsDraft.defaultAgent));
    }
    modelField.select.value = prefsDraft.defaultModel;
    const effortOptions = effortsForAgent(prefsDraft.defaultAgent, prefsDraft.defaultModel);
    // 추론 강도가 없는 프로바이더(cursor, opencode 등)에서는 줄 자체를 접는다.
    effortField.field.hidden = effortOptions.length === 0;
    fillSelect(effortField.select, [...effortOptions].reverse());
    effortField.select.value = resolveEffortForAgent(
      prefsDraft.defaultAgent,
      prefsDraft.defaultEffort,
      prefsDraft.defaultModel,
    );
    modeField.select.value = prefsDraft.defaultMode;
    editLockSlider.setOptions(EDIT_LOCK_OPTIONS, String(prefsDraft.editLock));
    editLockValue.textContent = editLockLabel(prefsDraft.editLock);
  }

  function renderConnection(): void {
    hubDot.dataset.state = connectionState;
    hubLabel.textContent = CONN_LABEL[connectionState];
    hubReconnect.hidden = connectionState === 'connected';
    hubReconnect.disabled = connectionState === 'connected';
    const online = connectionState === 'connected';
    refreshBtn.disabled = !online || connectionRefreshing;
    refreshBtn.setAttribute('aria-busy', String(connectionRefreshing));
    renderProviders();
  }

  function renderProviders(): void {
    if (setupStatuses) announceProviderUpdates(setupStatuses);
    const online = connectionState === 'connected';
    for (const agent of PROVIDER_ORDER) {
      const row = providerRows.get(agent);
      if (!row) continue;
      const setup = setupStatuses?.[agent];
      const health = providers?.[agent];
      const detected = health?.available === true || setup?.available === true;
      const connected = setup?.connected === true || setup?.setupComplete === true
        || (detected && setup?.authenticated === true);
      const working = pendingInstalls.has(agent) || setup?.installing === true || setup?.authenticating === true;
      const identity = (setup?.authMethod === 'api-key' && setup.keyTail ? `API 키 ****${setup.keyTail}` : null)
        || ((agent === 'claude' || agent === 'codex') ? usage?.limits?.[agent]?.planType : null);
      let label: string;
      let message: string;
      if (!online) {
        label = '허브 연결 필요';
        message = '허브 연결 후 관리합니다.';
      } else if (working) {
        label = pendingInstalls.has(agent) || setup?.installing ? '설치 중…' : '로그인 중…';
        message = '설정에서 진행 상황 확인';
      } else if (setup?.installed === true && setup?.updateRequired) {
        // 설치 전에는 번들 런타임의 오래된 버전이 updateRequired 를 켠다 —
        // 미설치 프로바이더에 업데이트 안내를 띄우지 않는다.
        label = '업데이트 필요';
        message = '설정에서 업데이트';
      } else if (!setup && !health) {
        label = '확인 중…';
        message = '연결 확인 중';
      } else if (setup?.error || health?.error) {
        label = '확인 필요';
        message = setup?.error || health?.error || '연결 상태 확인 필요';
      } else if (connected) {
        label = identity || '연결됨';
        message = identity ? `연결된 계정: ${identity}` : '이 기기의 계정 사용 중';
      } else {
        label = detected ? '로그인 필요' : '연결하기';
        message = detected ? '설정에서 로그인' : `${AGENT_LABEL[agent]} 연결 필요`;
      }
      // 문구와 같은 기준 — 설치하지 않은 프로바이더의 updateRequired(번들 런타임)는 연결 상태를 흐리지 않는다.
      const needsUpdate = setup?.installed === true && setup?.updateRequired === true;
      row.dot.dataset.state = !online || working ? 'unknown' : connected && !needsUpdate && !setup?.error && !health?.error ? 'connected' : 'disconnected';
      row.detail.textContent = label;
      row.detail.title = label;
      row.detail.classList.toggle('ag-settings-account-detail', online && connected && label === (identity || '연결됨'));
      row.detail.classList.toggle('ag-update-required', online && setup?.installed === true && setup?.updateRequired === true);
      row.message.textContent = message;
      row.setup.textContent = working ? '진행 상황 보기' : setup?.installed && setup?.updateRequired ? '업데이트' : connected ? '계정 관리' : '연결하기';
      row.setup.disabled = !online || (!setup && !health);
      row.setup.setAttribute('aria-label', `${AGENT_LABEL[agent]} ${row.setup.textContent}`);
    }
  }

  /** 앱 업데이트와 같은 하마가 프로바이더 업데이트를 안내한다. */
  function announceProviderUpdates(statuses: AgentSetupStatusMap): void {
    updateAgent = isInitialSetupActive() ? null : (['claude', 'codex'] as const).find((agent) => {
      const status = statuses[agent];
      return status?.installed && status.updateRequired && status.latestVersion
        && !status.installing && !pendingInstalls.has(agent);
    }) ?? null;
    const status = updateAgent ? statuses[updateAgent] : null;
    const line = updateAgent && status ? `${AGENT_LABEL[updateAgent]} ${status.latestVersion} 업데이트가 있어요.` : '';
    providerUpdateHippo?.setSign(status ? {
      key: `provider:${updateAgent}:${status.latestVersion}`,
      tone: 'plain', lines: [line, '업데이트할까요?'], progress: null,
      actions: [{ id: 'download', label: '업데이트', icon: 'download' }], spoken: line,
    } : null);
  }

  function maybeOpenAuthUrl(url: string | null | undefined): void {
    if (!url || openedAuthUrls.has(url)) return;
    openedAuthUrls.add(url);
    window.open(url, '_blank', 'noopener,noreferrer');
  }

  /** 진행 중인 로그인의 주소·코드를 지운다. */
  function clearSetupAuthPrompt(): void {
    setupTerminal.close();
    setupTerminalResync.reset();
    setupOauthPending = false;
    setupAuthUrl = null;
    setupUserCode = null;
    setupAuthRunId = null;
    if (setupCopyResetTimer) {
      clearTimeout(setupCopyResetTimer);
      setupCopyResetTimer = null;
    }
    setupAuthCopy.textContent = '주소 복사';
    setupUserCodeCopy.textContent = '코드 복사';
  }

  /**
   * 보안 컨텍스트(https·localhost)가 아니면 navigator.clipboard 자체가 없습니다.
   * 원격 http 주소로 스튜디오를 여는 경우가 있어, 임시 textarea 로 한 번 더
   * 시도하고 그것마저 막히면 실패를 버튼에 알립니다.
   */
  async function writeClipboardText(text: string): Promise<boolean> {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {
      // 아래 폴백으로 넘어갑니다.
    }
    return copyTextByExecCommand(text);
  }

  function copyTextByExecCommand(text: string): boolean {
    const holder = document.createElement('textarea');
    holder.value = text;
    holder.setAttribute('readonly', '');
    holder.style.position = 'fixed';
    holder.style.top = '0';
    holder.style.left = '-9999px';
    holder.style.opacity = '0';
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    document.body.appendChild(holder);
    let copied = false;
    try {
      holder.select();
      holder.setSelectionRange(0, text.length);
      copied = document.execCommand('copy');
    } catch {
      copied = false;
    }
    holder.remove();
    previous?.focus();
    return copied;
  }

  async function copySetupText(text: string, button: HTMLButtonElement, label: string): Promise<void> {
    const copied = await writeClipboardText(text);
    if (setupCopyResetTimer) clearTimeout(setupCopyResetTimer);
    setupAuthCopy.textContent = '주소 복사';
    setupUserCodeCopy.textContent = '코드 복사';
    button.textContent = copied ? '복사됨' : '복사 실패';
    setupCopyResetTimer = setTimeout(() => {
      setupCopyResetTimer = null;
      button.textContent = label;
    }, 1600);
  }

  function supportsTerminalSetup(agent: AgentName | null): agent is AgentName {
    return agent !== null && agent !== 'pi'
      && setupStatuses?.[agent]?.terminalAuthSupported !== false;
  }

  function isAgentLoggedIn(agent: AgentName): boolean {
    if (agent === 'pi' && piStatus?.setupComplete === true) return true;
    const status = setupStatuses?.[agent];
    const available = providers?.[agent]?.available === true || status?.available === true;
    return status?.connected === true
      || status?.setupComplete === true
      || (available && status?.authenticated === true);
  }

  function isAgentInstalled(agent: AgentName): boolean {
    const status = setupStatuses?.[agent];
    const health = providers?.[agent];
    return health?.available === true || status?.available === true || status?.installed === true;
  }

  async function continueAgentConnect(agent: AgentName, reauth = false): Promise<void> {
    await refreshSetupStatuses();
    if (agent === 'pi') {
      try {
        const next = await bridge.requestPiStatus();
        if (next) piStatus = next;
      } catch {
        // 설치 여부는 아래 상태로 판단한다.
      }
    }
    if (disposed || setupAgent !== agent) return;
    renderAgentSetup();
    if (connectionState !== 'connected') return;
    // 허브는 로그인으로 보지만 CLI 가 인증을 거절했으면 다시 로그인한다.
    if (isAgentLoggedIn(agent) && !reauth) return;
    if (isAgentInstalled(agent) || (agent === 'pi' && piStatus?.installed === true)) {
      await startPreferredSetupAuth(agent);
      return;
    }
    await installSelectedAgent();
    if (disposed || setupAgent !== agent) return;
    if (isAgentLoggedIn(agent)) return;
    if (isAgentInstalled(agent) || (agent === 'pi' && piStatus?.installed === true)) {
      await startPreferredSetupAuth(agent);
    }
  }

  async function startPreferredSetupAuth(agent: AgentName): Promise<void> {
    setupReauth = true;
    if (setupStatuses?.[agent]?.terminalAuthSupported === false) {
      setupKeyBox.hidden = false;
      renderAgentSetup();
      setupKey.input.focus();
      return;
    }
    await startSetupAuth('oauth');
  }

  function beginAgentConnect(agent: AgentName, options?: { reauth?: boolean }): void {
    if (aiLocked()) {
      deps.openPlans?.();
      return;
    }
    openAgentSetup(agent);
    void continueAgentConnect(agent, options?.reauth === true);
  }

  function openAgentSetup(agent: AgentName): void {
    if (aiLocked()) {
      deps.openPlans?.();
      return;
    }
    if (setupCloseTimer) {
      clearTimeout(setupCloseTimer);
      setupCloseTimer = null;
    }
    const sameAgent = setupAgent === agent;
    setupAgent = agent;
    setupMessage = '';
    setupBusy = false;
    setupReauth = false;
    setupCodePending = false;
    clearSetupAuthPrompt();
    if (!sameAgent) resetSetupInstallProgress();
    if (pendingInstalls.has(agent) || setupStatuses?.[agent]?.installing) {
      setupBusy = true;
      if (setupProgressPercent <= 0) setSetupInstallProgress(8, 'preparing');
    }
    setupKey.input.value = '';
    setupKeyBox.hidden = true;
    setupCode.input.value = '';
    setupCodeBox.hidden = true;
    document.body.appendChild(setupOverlay);
    setupOverlay.setAttribute('aria-hidden', 'false');
    renderAgentSetup();
    requestAnimationFrame(() => {
      setupOverlay.classList.add('ag-open');
      setupDialog.focus();
    });
    void refreshSetupStatuses();
    if (agent === 'pi') {
      void refreshPiStatus();
      piGift?.refresh();
    }
  }

  function isSetupOpen(): boolean {
    return setupOverlay.isConnected && setupOverlay.getAttribute('aria-hidden') !== 'true';
  }

  function closeAgentSetup(): void {
    if (!setupOverlay.isConnected) return;
    // 창을 닫으면 진행 중인 로그인을 취소한다. 시작 응답 전이면 startSetupAuth 가 받은 뒤 취소한다.
    if (setupAgent) {
      const owned = setupStatuses?.[setupAgent];
      const runId = setupAuthRunId ?? (owned?.authOwnedByThisSession ? owned.authRunId : null);
      if (runId) {
        abandonedAuthRunIds.add(runId);
        bridge.cancelAgentSetup(setupAgent, runId);
      }
    }
    authAttempt += 1;
    setupCodePending = false;
    setupBusy = false;
    clearSetupAuthPrompt();
    setupOverlay.classList.remove('ag-open');
    setupOverlay.setAttribute('aria-hidden', 'true');
    if (!setupAgent || !pendingInstalls.has(setupAgent)) resetSetupInstallProgress();
    if (setupCloseTimer) clearTimeout(setupCloseTimer);
    setupCloseTimer = setTimeout(() => {
      setupOverlay.remove();
      setupCloseTimer = null;
    }, 180);
  }

  function resetSetupInstallProgress(): void {
    if (setupProgressResetTimer) {
      clearTimeout(setupProgressResetTimer);
      setupProgressResetTimer = null;
    }
    if (setupProgressCreepTimer) {
      clearInterval(setupProgressCreepTimer);
      setupProgressCreepTimer = null;
    }
    setupProgressPercent = 0;
    setupProgressLabel = '';
    setupProgressPhase = '';
    setupProgressFill.style.width = '0%';
    setupProgress.removeAttribute('aria-valuenow');
    setupProgress.removeAttribute('aria-valuetext');
  }

  function paintSetupInstallProgress(): void {
    setupProgressFill.style.width = `${setupProgressPercent.toFixed(2)}%`;
    setupProgress.setAttribute('aria-valuenow', String(Math.round(setupProgressPercent)));
    setupProgress.setAttribute('aria-valuetext', `${setupProgressLabel} ${Math.floor(setupProgressPercent)}%`);
    setupProgressLine.textContent = `${setupProgressLabel} ${Math.floor(setupProgressPercent)}%`;
  }

  function ensureSetupProgressCreep(): void {
    if (setupProgressCreepTimer) return;
    setupProgressCreepTimer = setInterval(() => {
      const ceiling = INSTALL_PROGRESS_CEILING[setupProgressPhase] ?? setupProgressPercent;
      if (setupProgressPercent >= ceiling || setupProgressPercent >= 100) return;
      setupProgressPercent = Math.min(
        ceiling,
        setupProgressPercent + Math.max(0.08, (ceiling - setupProgressPercent) * 0.018),
      );
      paintSetupInstallProgress();
    }, 100);
  }

  function setSetupInstallProgress(percent: number, phase = 'installing'): void {
    if (setupProgressResetTimer) {
      clearTimeout(setupProgressResetTimer);
      setupProgressResetTimer = null;
    }
    setupProgressPercent = Math.max(setupProgressPercent, Math.min(100, Math.max(0, percent)));
    setupProgressPhase = phase;
    setupProgressLabel = INSTALL_PROGRESS_LABEL[phase] ?? INSTALL_PROGRESS_LABEL.installing;
    paintSetupInstallProgress();
    if (setupProgressPercent >= 100) {
      if (setupProgressCreepTimer) {
        clearInterval(setupProgressCreepTimer);
        setupProgressCreepTimer = null;
      }
      setupProgressResetTimer = setTimeout(() => {
        setupProgressResetTimer = null;
        setupProgressPercent = 0;
        setupProgressLabel = '';
        setupProgressFill.style.width = '0%';
        renderAgentSetup();
      }, 650);
    } else {
      ensureSetupProgressCreep();
    }
  }

  /**
   * 다시 그릴 때 방금 누른 버튼이 사라지면(로그인 취소·코드 확인 등) 포커스가
   * <body> 로 떨어지고, Esc 를 받는 덮개 밖이라 키보드로 카드를 닫을 수 없게
   * 됩니다. 포커스가 빠져나간 경우에만 카드로 되돌립니다.
   */
  function restoreSetupFocus(): void {
    if (!setupOverlay.isConnected) return;
    const active = document.activeElement;
    if (active && active !== document.body) return;
    setupDialog.focus();
  }

  /**
   * 대화상자는 <body> 에 붙어 사이드바의 프로바이더 색 변수를 물려받지 못한다.
   * 사이드바 루트에서 해당 프로바이더 색을 읽어 강조색으로 옮긴다.
   */
  function syncSetupAccent(agent: AgentName): void {
    const root = providerList.closest('.ag-root');
    if (!root) return;
    const styles = getComputedStyle(root);
    const accent = styles.getPropertyValue(`--ag-${agent}`).trim();
    const onAccent = styles.getPropertyValue('--ag-on-accent').trim();
    if (accent) setupDialog.style.setProperty('--accent-primary', accent);
    if (onAccent) setupDialog.style.setProperty('--n-on-accent', onAccent);
  }

  function renderAgentSetup(): void {
    if (!setupAgent) return;
    const agent = setupAgent;
    // Pi 카드는 자체 머리(아이콘·상태)를 가지므로 대화상자 머리는 제목만 둔다.
    setupTitle.textContent = agent === 'pi' ? `${AGENT_LABEL[agent]} 설정` : AGENT_LABEL[agent];
    setupHeroIcon.hidden = agent === 'pi';
    if (setupHeroIcon.dataset.agent !== agent) {
      setupHeroIcon.replaceChildren(createProviderIcon(agent));
      setupHeroIcon.dataset.agent = agent;
    }
    syncSetupAccent(agent);
    const body = agent === 'pi' ? piCard : setupGeneric;
    if (setupBody.firstChild !== body) setupBody.replaceChildren(body);
    if (agent === 'pi') {
      setupState.hidden = true;
      if (setupMessage) piMessage = setupMessage;
      renderPi();
      restoreSetupFocus();
      return;
    }
    const status = setupStatuses?.[agent] ?? null;
    const detected = providers?.[agent]?.available === true;
    const available = detected || status?.available === true || status?.installed === true;
    // OpenCode도 바이너리 감지만으로 실행할 수 없다. API 키나 사용자의
    // `opencode auth login`을 허브가 확인한 뒤에만 완료 화면으로 보낸다.
    const connected = status?.connected === true || status?.setupComplete === true
      || (available && status?.authenticated === true);
    const showConnected = connected && !setupReauth;
    const updateVersion = available && status?.updateRequired ? status.latestVersion : null;
    const installing = pendingInstalls.has(agent) || status?.installing === true
      || (setupBusy && setupProgressPercent > 0);
    if (installing) setupBusy = true;
    setupKey.input.placeholder = API_KEY_PLACEHOLDER[agent];
    setupAuthHeading.textContent = '로그인 방법';
    setupOauth.hidden = status?.terminalAuthSupported === false;
    const oauthTitle = setupOauth.querySelector('strong');
    const oauthDetail = setupOauth.querySelector('span');
    if (oauthTitle) oauthTitle.textContent = supportsTerminalSetup(agent) ? '로그인 시작' : '브라우저로 로그인';
    if (oauthDetail) oauthDetail.textContent = supportsTerminalSetup(agent) ? '이 창에서 계정 연결' : '구독 계정 또는 웹 계정 연결';
    const checking = status === null && !setupMessage && !setupBusy;
    setupInstallPane.hidden = available || checking;
    setupAuthPane.hidden = !available || showConnected || checking;

    // 머리 상태 줄 — 목록의 점 색과 같은 규칙.
    const [stateDot, stateText] = checking
      ? ['connecting', '확인 중…']
      : installing
      ? ['connecting', available ? '업데이트 중' : '설치 중']
      : setupBusy
        ? ['connecting', '로그인 중']
        : connected
          ? updateVersion ? ['replaced', '업데이트 있음'] : ['connected', '연결됨']
          : !available ? ['unknown', '설치 필요'] : ['unknown', '로그인 필요'];
    setupState.hidden = false;
    setupStateDot.dataset.state = stateDot;
    setupStateText.textContent = stateText;

    // 상태 카드: 연결됐으면 계정·버전, 로그인 전이라도 새 버전이 있으면 버전 줄만.
    setupAccountRow.hidden = !showConnected;
    setupAccountValue.textContent = status?.authMethod === 'api-key' && status.keyTail
      ? `API 키 ····${status.keyTail}`
      : status?.authenticated
        ? agent === 'opencode' ? 'CLI 자격 증명'
          : status.authSource === 'local' ? '터미널 로그인' : '웹 계정'
        : 'CLI 로그인';
    setupAccountValue.title = setupAccountValue.textContent;
    setupChangeAuth.disabled = setupBusy;
    setupAccountLogout.hidden = agent !== 'claude' || !connected;
    setupAccountLogout.disabled = setupBusy || connectionState !== 'connected';
    setupVersionRow.hidden = !(updateVersion || (available && status?.version));
    const versionKey = JSON.stringify([agent, status?.version, updateVersion, installing]);
    if (setupVersionValue.dataset.version !== versionKey) {
      setupVersionValue.dataset.version = versionKey;
      setupVersionValue.replaceChildren(status?.version ?? '');
      if (updateVersion && installing) {
        setupVersionValue.append(setupVersionArrow, el('span', 'ag-agent-setup-row-next', updateVersion));
      } else if (updateVersion) {
        setupVersionValue.append(el('span', 'ag-agent-setup-row-note', `새 버전 ${updateVersion}`));
      }
    }
    setupUpdate.hidden = !updateVersion;
    setupUpdate.textContent = installing ? '업데이트 중' : '업데이트';
    setupUpdate.disabled = setupBusy || connectionState !== 'connected';
    setupStatusCard.hidden = setupAccountRow.hidden && setupVersionRow.hidden;

    setupError.textContent = setupMessage;
    setupError.hidden = !setupMessage;
    const errorDetail = setupMessage === setupDetailFor ? setupDetail : '';
    setupErrorDetail.hidden = !errorDetail;
    setupErrorDetailText.textContent = errorDetail;
    setupProgress.hidden = setupProgressPercent <= 0;
    setupProgressLine.hidden = setupProgressPercent <= 0;
    setupProgressLine.textContent = setupProgressPercent > 0
      ? `${setupProgressLabel} ${Math.floor(setupProgressPercent)}%`
      : '';
    setupInstall.disabled = checking || setupBusy || connectionState !== 'connected';
    const authBusyElsewhere = status?.authenticating === true && status.authOwnedByThisSession !== true;
    setupOauth.disabled = setupBusy || authBusyElsewhere || connectionState !== 'connected';
    setupApiToggle.disabled = setupBusy || authBusyElsewhere || connectionState !== 'connected';
    setupKeySubmit.disabled = setupBusy || !setupKey.input.value.trim();
    renderSetupLoginBox();
    setupCodeBox.hidden = supportsTerminalSetup(agent) || agent !== 'claude' || !setupCodePending || !setupBusy;
    setupCodeSubmit.disabled = connectionState !== 'connected' || !setupCode.input.value.trim();
    restoreSetupFocus();
  }

  /** 로그인이 진행 중일 때 주소·코드 상자와 대기/취소 줄을 세운다. */
  function renderSetupLoginBox(): void {
    // 인증이 진행 중일 때 버튼만 무효화하면 이유가 보이지 않는다. 어떤 로그인이라도
    // 실행 중이면 대기 문구와 취소 버튼을 노출한다(키 검사 중에는 주소/코드 행만 비어 있다).
    // 설치/업데이트처럼 진행률 막대가 진행 상황을 대신 보여 주는 동안에는 띄우지 않는다.
    const authorizing = setupBusy && setupProgressPercent <= 0 && !supportsTerminalSetup(setupAgent);
    setupLoginBox.hidden = !authorizing;
    setupLoginWait.textContent = setupOauthPending || setupAuthUrl || setupUserCode
      ? '브라우저에서 로그인하면 자동으로 완료됩니다.'
      : '로그인을 확인하는 중입니다.';
    setupAuthUrlRow.hidden = !setupAuthUrl;
    if (setupAuthUrl) {
      setupAuthLink.href = setupAuthUrl;
      setupAuthLink.textContent = setupAuthUrl;
      setupAuthLink.title = setupAuthUrl;
    }
    setupUserCodeRow.hidden = !setupUserCode;
    if (setupUserCode) setupUserCodeValue.textContent = setupUserCode;
  }

  async function refreshSetupStatuses(refresh = false): Promise<void> {
    const revision = ++setupStatusRevision;
    const statuses = await bridge.requestAgentSetupStatus(refresh);
    if (disposed || revision !== setupStatusRevision) return;
    if (!statuses) {
      if (!setupStatuses) {
        setupMessage = '연결 상태를 확인하지 못했습니다.';
        renderAgentSetup();
      }
      return;
    }
    setupStatuses = statuses;
    renderProviders();
    renderAgentSetup();
    renderUsage();
  }

  async function installSelectedAgent(): Promise<void> {
    if (!setupAgent || setupBusy || pendingInstalls.has(setupAgent)
      || setupStatuses?.[setupAgent]?.installing) return;
    if (setupAgent === 'pi') {
      await runPiInstall();
      return;
    }
    const agent = setupAgent;
    setupBusy = true;
    setupMessage = '';
    resetSetupInstallProgress();
    setSetupInstallProgress(8, 'preparing');
    pendingInstalls.add(agent);
    renderAgentSetup();
    renderProviders();
    let statuses: AgentSetupStatusMap | null = null;
    try {
      statuses = await bridge.installAgent(agent);
    } catch {
      // 연결 실패도 오류 카드로 끝내고 다시 시도할 수 있게 한다.
    } finally {
      pendingInstalls.delete(agent);
    }
    if (disposed) return;
    // 답이 없다(시간 초과·끊김·오류) — 허브는 아직 설치 중이거나 이미 끝냈을 수 있다. 상태를 다시 읽어
    // 실제 결과로 정한다. 그러지 않으면 '설치 실패' 가 곧 오는 완료 방송에 뒤집힌다.
    let outcome: ReturnType<typeof installOutcomeFromStatus> = 'installed';
    if (!statuses) {
      const fresh = await bridge.requestAgentSetupStatus(true).catch(() => null);
      if (disposed) return;
      if (fresh) statuses = fresh;
      outcome = installOutcomeFromStatus(fresh?.[agent]);
    }
    setupStatusRevision += 1;
    if (statuses) setupStatuses = statuses;
    // 그사이 다른 프로바이더 창을 열었다면 그 창의 진행 상태는 건드리지 않는다.
    if (setupAgent === agent) {
      // 아직 설치 중이면 진행 표시를 그대로 둔다 — 끝나면 허브의 상태 방송이 막대를 마친다.
      setupBusy = outcome === 'installing';
      if (outcome === 'failed') {
        if (!setupMessage) setupMessage = '설치 실패';
        resetSetupInstallProgress();
      } else if (outcome === 'installed') {
        setSetupInstallProgress(100, 'done');
      }
    }
    renderAgentSetup();
    renderProviders();
  }

  async function disconnectProvider(agent: AgentName): Promise<void> {
    if (setupBusy || connectionState !== 'connected') return;
    setupBusy = true;
    setupMessage = '';
    renderAgentSetup();
    const statuses = await bridge.disconnectAgent(agent);
    if (disposed) return;
    setupBusy = false;
    if (statuses) setupStatuses = statuses;
    else if (!setupMessage) setupMessage = '로그아웃 실패';
    renderAgentSetup();
    renderProviders();
    renderUsage();
  }

  async function startSetupAuth(method: AgentAuthMethod): Promise<void> {
    if (!setupAgent || setupBusy) return;
    const keyInput = setupAgent === 'pi' ? piKeyInput.input : setupKey.input;
    const key = method === 'api-key' ? keyInput.value.trim() : '';
    if (method === 'api-key' && !key) return;
    setupBusy = true;
    setupMessage = '';
    clearSetupAuthPrompt();
    setupOauthPending = method === 'oauth';
    if (supportsTerminalSetup(setupAgent) && method === 'oauth') void setupTerminal.open(AGENT_LABEL[setupAgent]);
    resetSetupInstallProgress();
    if (setupAgent === 'pi') piMessage = '';
    renderAgentSetup();
    const authenticatingAgent = setupAgent;
    const attempt = authAttempt;
    const started = await bridge.authenticateAgent(authenticatingAgent, method, key || undefined);
    if (disposed || attempt !== authAttempt || setupAgent !== authenticatingAgent || !isSetupOpen()) {
      if (started?.authRunId) {
        abandonedAuthRunIds.add(started.authRunId);
        bridge.cancelAgentSetup(authenticatingAgent, started.authRunId);
      }
      return;
    }
    if (!started) {
      setupBusy = false;
      setupMessage = '로그인 시작 실패';
      clearSetupAuthPrompt();
      renderAgentSetup();
      return;
    }
    if (!started.authRunId) {
      setupBusy = false;
      setupMessage = '로그인 보안 정보 수신 실패, 다시 시도';
      clearSetupAuthPrompt();
      renderAgentSetup();
      return;
    }
    setupAuthRunId = started.authRunId;
    keyInput.value = '';
    // pi 는 인증 주소를 시작 응답에만 실어 보낸다.
    if (method === 'oauth' && started.authUrl) setupAuthUrl = started.authUrl;
    if (method === 'oauth' && setupAgent === 'claude') {
      // claude 는 브라우저 로그인 뒤 표시되는 인증 코드를 CLI 에 넘겨야 로그인이 끝난다.
      setupCodePending = true;
      setupCode.input.value = '';
    }
    maybeOpenAuthUrl(started.authUrl);
    // 완료 상태는 agent-setup-status 이벤트로 온다. OAuth 동안 모달은 진행 상태를 유지한다.
    renderAgentSetup();
  }

  function submitSetupAuthCode(): void {
    const code = setupCode.input.value.trim();
    if (!code || !setupAuthRunId || setupAgent !== 'claude'
      || connectionState !== 'connected') return;
    bridge.submitAgentAuthCode(setupAgent, setupAuthRunId, code);
    setupCode.input.value = '';
    setupMessage = '';
    renderAgentSetup();
  }

  /** 미터 행 DOM — 라벨·값·진행 막대. percent 가 null 이면 막대 없는 행이다. */
  function meterRow(label: string, value: string, percent: number | null): HTMLElement {
    const row = el('div', 'ag-settings-meter');
    const head = el('div', 'ag-settings-meter-head');
    head.append(
      el('span', 'ag-settings-meter-label', label),
      el('span', 'ag-settings-meter-value', value),
    );
    row.appendChild(head);
    if (percent !== null) {
      if (percent >= METER_WARN_PERCENT) row.classList.add('ag-settings-meter-warn');
      const track = el('div', 'ag-settings-meter-track');
      const fill = el('div', 'ag-settings-meter-fill');
      // 100% 를 넘겨도 막대는 가득 찬 상태로 멈춘다.
      fill.style.width = `${Math.min(100, Math.max(0, percent)).toFixed(1)}%`;
      track.appendChild(fill);
      row.appendChild(track);
    }
    return row;
  }

  function renderUsage(): void {
    quotaCards.render(usage);
  }

  // ── pi 마법사 ─────────────────────────────────────────

  /** 내 키가 있거나 선물 크레딧을 쓰는 중이면 키 단계를 건너뛴다. */
  function piHasCredential(): boolean {
    return piStatus?.keyConfigured === true || piStatus?.credential === 'gift';
  }

  function piCurrentStep(): PiStep {
    if (piStepOverride) return piStepOverride;
    if (!piStatus?.installed) return 'install';
    if (!piHasCredential()) return 'key';
    if (piStatus.models.length === 0) return 'catalog';
    return 'summary';
  }

  function piHeadText(): string {
    if (piProgress) return piProgress;
    if (!piStatus) return connectionState === 'connected' ? '확인 중…' : '허브 연결 대기';
    const version = piStatus.version ?? '설치됨';
    if (!piStatus.installed) return '설치 안 됨';
    if (!piHasCredential()) return `${version}, 키 필요`;
    if (piStatus.models.length === 0) return `${version}, 모델 필요`;
    return `${version}, 모델 ${piStatus.models.length}개`;
  }

  function piEffortLabel(effort: string): string {
    return PI_EFFORT_OPTIONS.find((option) => option.id === effort)?.label ?? effort;
  }

  function filterPiCatalog(query: string): PiCatalogModel[] {
    const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return piCatalog;
    return piCatalog.filter((model) => {
      const hay = `${model.id} ${model.name} ${model.provider}`.toLowerCase();
      return terms.every((term) => hay.includes(term));
    });
  }

  function togglePiModel(model: PiCatalogModel): void {
    piStepOverride = 'catalog';
    if (piDraft.some((draft) => draft.id === model.id)) {
      piDraft = piDraft.filter((draft) => draft.id !== model.id);
    } else if (piDraft.length >= PI_MODEL_MAX) {
      piMessage = `모델 최대 ${PI_MODEL_MAX}개`;
      renderPi();
      return;
    } else {
      piDraft = [
        ...piDraft,
        {
          id: model.id,
          name: model.name,
          reasoning: model.reasoning,
          effort: model.reasoning ? 'medium' : '',
        },
      ];
    }
    piMessage = '';
    renderPi();
  }

  function buildPiCatalogRow(model: PiCatalogModel): HTMLElement {
    const row = el('button', 'ag-settings-model-row');
    row.type = 'button';
    row.dataset.modelId = model.id;
    row.disabled = piBusy || connectionState !== 'connected';
    const picked = piDraft.some((draft) => draft.id === model.id);
    row.classList.toggle('ag-active', picked);
    row.setAttribute('aria-pressed', String(picked));
    row.setAttribute('aria-label', `${model.name}, ${picked ? '선택됨' : '선택 안 됨'}`);
    row.title = `${model.id} (${model.provider})\n${formatTokens(model.contextLength)} 콘텍스트, 입력 ${formatUsd(pricePerMillion(model.pricing.prompt))}, 출력 ${formatUsd(pricePerMillion(model.pricing.completion))}${model.reasoning ? ', 추론' : ''}`;
    const text = el('span', 'ag-settings-model-row-text');
    text.append(el('span', 'ag-settings-model-row-name', model.name));
    const trailing = el('span', 'ag-settings-model-row-trailing');
    const check = el('span', 'ag-settings-model-check');
    check.append(createIcon('check'));
    check.setAttribute('aria-hidden', 'true');
    trailing.append(check);
    row.append(text, trailing);
    row.addEventListener('click', () => togglePiModel(model));
    return row;
  }

  function renderPiChips(): void {
    piChips.replaceChildren();
    for (const draft of piDraft) {
      const chip = el('button', 'ag-pi-chip');
      chip.type = 'button';
      chip.title = draft.id;
      chip.setAttribute('aria-label', `${draft.name || draft.id} 빼기`);
      chip.append(
        el('span', 'ag-pi-chip-name', draft.name || draft.id),
        el('span', 'ag-pi-chip-x', '×'),
      );
      chip.addEventListener('click', () => {
        piStepOverride = 'catalog';
        piDraft = piDraft.filter((item) => item.id !== draft.id);
        renderPi();
      });
      piChips.appendChild(chip);
    }
    piChips.hidden = piDraft.length === 0;
  }

  function resetPiDraft(): void {
    piDraft = (piStatus?.models ?? []).map((model) => ({
      id: model.id, name: model.name, reasoning: model.reasoning, effort: model.defaultEffort,
    }));
  }

  function openPiModelCatalog(): void {
    if (piStepOverride !== 'catalog' && piStepOverride !== 'naming') resetPiDraft();
    piStepOverride = piStatus?.installed && piHasCredential() ? 'catalog' : null;
    piMessage = '';
    modelCatalogAgent = 'pi';
    modelCatalogSearch.value = '';
    closeAgentSetup();
    // 이미 모델 목록을 보고 있으면(Codex 에서 Pi 탭으로 옮길 때) 스크롤 자리를 그대로 둔다.
    const alreadyShown = currentDestination === 'ai' && currentAiSection === 'connection';
    if (!alreadyShown) selectDestination('ai', 'connection');
    renderPi();
    if (!alreadyShown) modelCatalogSection.root.scrollIntoView({ block: 'nearest' });
    modelCatalogSearch.focus({ preventScroll: true });
    if (piHasCredential() && !piCatalogTried) void loadPiCatalog(false);
  }

  function renderSharedPiCatalog(): void {
    const ready = piStatus?.installed === true && piHasCredential();
    const online = connectionState === 'connected';
    const focusedId = modelCatalogList.contains(document.activeElement)
      ? (document.activeElement as HTMLElement).dataset.modelId : null;
    const scrollTop = modelCatalogList.scrollTop;
    // OpenRouter 목록은 수백 개라 검색하지 않을 때는 고른 모델만 보여 준다.
    const searching = modelCatalogSearch.value.trim().length > 0;
    const matches = searching ? filterPiCatalog(modelCatalogSearch.value) : [];
    const visible = searching
      ? matches.slice(0, PI_CATALOG_VISIBLE_MAX)
      : piDraft.map((draft) => piCatalog.find((model) => model.id === draft.id) ?? {
        id: draft.id,
        name: draft.name || draft.id,
        provider: draft.id.split('/')[0] ?? '',
        contextLength: 0,
        pricing: { prompt: 0, completion: 0 },
        reasoning: draft.reasoning,
        supportsImages: false,
      });
    modelCatalogList.replaceChildren();
    if (ready && !piCatalogLoading && !searching && visible.length === 0) {
      const empty = el('div', 'ag-settings-model-empty ag-settings-model-empty-hippo');
      empty.append(createSleepyHippo('ag-sleepy-hippo'), el('span', '', '검색해서 모델을 선택해주세요'));
      modelCatalogList.append(empty);
    } else if (!ready || piCatalogLoading || visible.length === 0) {
      modelCatalogList.append(el('div', 'ag-settings-model-empty', !ready ? 'Pi 연결 후 모델을 선택하세요.'
        : piCatalogLoading ? '모델을 불러오는 중…' : '검색 결과가 없습니다.'));
    } else {
      modelCatalogList.append(...visible.map(buildPiCatalogRow));
    }
    modelCatalogList.scrollTop = scrollTop;
    if (focusedId) [...modelCatalogList.querySelectorAll<HTMLButtonElement>('button')]
      .find((row) => row.dataset.modelId === focusedId)?.focus({ preventScroll: true });
    renderPiChips();
    // 검색하지 않을 때는 목록이 곧 고른 모델이라 칩을 겹쳐 두지 않는다.
    if (!searching) piChips.hidden = true;
    modelCatalogCount.textContent = `${piDraft.length}/${PI_MODEL_MAX} 선택`;
    modelCatalogStatus.textContent = piMessage || (ready
      ? matches.length > visible.length ? `${matches.length}개 중 ${visible.length}개, 검색으로 찾기` : ''
      : 'OpenRouter');
    modelCatalogRefresh.disabled = !ready || !online || piBusy || setupBusy || piCatalogLoading;
    modelCatalogSearch.disabled = !ready;
    piCatalogNext.hidden = !ready;
    piCatalogNext.disabled = piBusy || setupBusy || !online || piDraft.length === 0;
    piCatalogCancel.hidden = !ready;
    piCatalogCancel.disabled = piBusy || setupBusy;
    piCatalogConnect.hidden = ready;
    piCatalogConnect.disabled = !online;
  }

  /** 이름 칸은 입력 중인 값을 지키려고 구성이 바뀔 때만 다시 세운다. */
  function renderPiNaming(): void {
    const same = piNamingRendered.length === piDraft.length
      && piNamingRendered.every((draft, index) => draft === piDraft[index]);
    if (same) return;
    piNamingRendered = piDraft;
    piNamingRows.replaceChildren();
    for (const draft of piDraft) {
      const row = el('div', 'ag-pi-naming-row');
      row.append(el('div', 'ag-pi-model-id', draft.id));
      const name = createTextField('이름', { placeholder: draft.id });
      name.input.value = draft.name;
      name.input.addEventListener('input', () => {
        draft.name = name.input.value;
      });
      row.append(name.field);
      if (draft.reasoning) {
        const effort = createSelect('기본 강도', PI_EFFORT_OPTIONS);
        effort.select.value = draft.effort || 'medium';
        effort.select.addEventListener('change', () => {
          draft.effort = effort.select.value;
        });
        row.append(effort.field);
      }
      piNamingRows.appendChild(row);
    }
  }

  function renderPiSummary(): void {
    const models = piStatus?.models ?? [];
    piSummaryModels.replaceChildren(
      ...models.map((model) => {
        const row = el('div', 'ag-settings-model-row');
        row.append(
          el('span', 'ag-settings-model-name', model.name),
          el('span', 'ag-pi-model-id', model.id),
        );
        if (model.reasoning && model.defaultEffort) {
          row.append(el('span', 'ag-settings-model-turns', piEffortLabel(model.defaultEffort)));
        }
        return row;
      }),
    );
    // 선물 크레딧을 쓰는 동안 내 키는 소진 뒤에 넘어갈 곳이다.
    const ownKey = piStatus?.keyConfigured && piStatus.keyTail ? `키 ****${piStatus.keyTail}` : '';
    piSummaryKey.textContent = ownKey && piStatus?.credential === 'gift' ? `소진 후 ${ownKey}` : ownKey;
  }

  function renderPi(): void {
    piGift?.setPiStatus(piStatus);
    const step = piCurrentStep();
    for (const [id, node] of piSteps) node.hidden = id !== step;
    const online = connectionState === 'connected';
    piHead.hidden = step === 'summary';
    piHeadDetail.textContent = piHeadText();
    piMessageLine.textContent = piMessage;
    piMessageLine.hidden = !piMessage;

    piInstallBtn.disabled = piBusy || setupBusy || !online;
    piProgressLine.textContent = piProgress;
    piProgressLine.hidden = !piProgress;

    piKeyNote.textContent = piStatus?.keyConfigured
      ? '새 키를 넣으면 이전 키를 대체합니다.'
      : 'openrouter.ai/keys 에서 만든 키';
    piKeySubmit.disabled = piBusy || setupBusy || !online;
    piOauth.disabled = piBusy || setupBusy || !online;
    piKeyCancel.hidden = piStepOverride !== 'key';

    renderModelCatalog();
    if (modelCatalogAgent === 'pi' && piHasCredential() && online && !piCatalogTried) {
      void loadPiCatalog(false);
    }

    if (step === 'naming') renderPiNaming();
    piNamingSave.disabled = piBusy || setupBusy || !online || piDraft.length === 0;

    if (step === 'summary') renderPiSummary();
    piRepick.disabled = piBusy || setupBusy || !online;
    piRekey.disabled = piBusy || setupBusy || !online;
  }

  function formatMb(bytes: number): string {
    return `${(bytes / 1048576).toFixed(1)}MB`;
  }

  /** 결정적 진행률 — 채움 폭을 퍼센트로 그린다. */
  function piBarDeterminate(percent: number): void {
    if (piActivityPause) {
      clearTimeout(piActivityPause);
      piActivityPause = null;
    }
    piProgressPercent = Math.max(piProgressPercent, Math.min(100, Math.max(0, percent)));
    piProgressTrack.hidden = false;
    piProgressTrack.classList.remove('ag-pi-progress-indeterminate', 'ag-pi-progress-paused');
    piProgressFill.style.width = `${piProgressPercent.toFixed(2)}%`;
    piProgressTrack.setAttribute('role', 'progressbar');
    piProgressTrack.setAttribute('aria-valuemin', '0');
    piProgressTrack.setAttribute('aria-valuemax', '100');
    piProgressTrack.setAttribute('aria-valuenow', String(Math.round(piProgressPercent)));
  }

  function setPiInstallProgress(percent: number, phase: string, creep = true): void {
    piProgressPhase = phase;
    piBarDeterminate(percent);
    if (!creep || percent >= 100) {
      if (piProgressCreepTimer) {
        clearInterval(piProgressCreepTimer);
        piProgressCreepTimer = null;
      }
      return;
    }
    if (piProgressCreepTimer) return;
    piProgressCreepTimer = setInterval(() => {
      const ceiling = INSTALL_PROGRESS_CEILING[piProgressPhase] ?? piProgressPercent;
      if (piProgressPercent >= ceiling || piProgressPercent >= 100) return;
      piProgressPercent = Math.min(
        ceiling,
        piProgressPercent + Math.max(0.08, (ceiling - piProgressPercent) * 0.018),
      );
      piBarDeterminate(piProgressPercent);
      const label = PI_PROGRESS_LABEL[piProgressPhase] ?? '';
      piProgress = `${label} ${Math.floor(piProgressPercent)}%`;
      piProgressLine.textContent = piProgress;
    }, 100);
  }

  /** 크기를 모를 때 — 새 신호가 올 때만 흐르고, 잠잠해지면 멈추는 막대. */
  function piBarNudge(): void {
    piProgressTrack.hidden = false;
    piProgressTrack.classList.add('ag-pi-progress-indeterminate');
    piProgressTrack.classList.remove('ag-pi-progress-paused');
    piProgressFill.style.width = '';
    piProgressTrack.removeAttribute('aria-valuenow');
    if (piActivityPause) clearTimeout(piActivityPause);
    piActivityPause = setTimeout(() => {
      piProgressTrack.classList.add('ag-pi-progress-paused');
    }, 1200);
  }

  function piBarHide(): void {
    if (piActivityPause) {
      clearTimeout(piActivityPause);
      piActivityPause = null;
    }
    if (piProgressCreepTimer) {
      clearInterval(piProgressCreepTimer);
      piProgressCreepTimer = null;
    }
    piProgressPercent = 0;
    piProgressPhase = '';
    piProgressTrack.hidden = true;
    piProgressTrack.classList.remove('ag-pi-progress-indeterminate', 'ag-pi-progress-paused');
    piProgressFill.style.width = '0%';
    piProgressTrack.removeAttribute('aria-valuenow');
  }

  async function runPiInstall(): Promise<void> {
    if (piBusy) return;
    piBusy = true;
    piMessage = '';
    piProgress = `${PI_PROGRESS_LABEL.preparing} 8%`;
    setPiInstallProgress(8, 'preparing');
    renderPi();
    const status = await bridge.installPi();
    if (disposed) return;
    piBusy = false;
    piProgress = '';
    piBarHide();
    if (status) {
      piStatus = status;
      piStepOverride = null;
    } else if (!piMessage) {
      piMessage = '설치 실패';
    }
    renderPi();
    syncPrefsInputs();
    void refreshProviders(true);
  }

  /** OpenRouter 키 저장 — Pi 설정의 키 칸. 성공하면 true. */
  async function connectOpenRouterKey(key: string): Promise<boolean> {
    if (!key || piBusy) return false;
    piBusy = true;
    piMessage = '';
    renderPi();
    const status = await bridge.setPiKey(key);
    if (disposed) return false;
    piBusy = false;
    if (status) {
      piStatus = status;
      // 새 키로 목록을 다시 받아 본다.
      piCatalogTried = false;
      piStepOverride = null;
    } else if (!piMessage) {
      piMessage = '키 확인 실패';
    }
    renderPi();
    syncPrefsInputs();
    return status !== null;
  }

  async function submitPiKey(): Promise<void> {
    const key = piKeyInput.input.value.trim();
    if (!key || piBusy) return;
    const connected = await connectOpenRouterKey(key);
    if (disposed) return;
    piKeyInput.input.value = '';
    if (connected) {
      openPiModelCatalog();
      renderPi();
    }
  }

  async function loadPiCatalog(refresh: boolean): Promise<void> {
    if (piCatalogLoading) return;
    if (!refresh && piCatalog.length > 0) return;
    piCatalogTried = true;
    piCatalogLoading = true;
    renderPi();
    const models = await bridge.requestPiCatalog(refresh);
    if (disposed) return;
    piCatalogLoading = false;
    if (models) piCatalog = models;
    else if (!piMessage) piMessage = '모델 목록 불러오기 실패';
    renderPi();
  }

  async function savePiModels(): Promise<void> {
    if (piBusy || piDraft.length === 0) return;
    piBusy = true;
    piMessage = '';
    renderPi();
    const status = await bridge.setPiModels(
      piDraft.map((draft) => ({
        id: draft.id,
        name: draft.name.trim() || draft.id,
        ...(draft.reasoning && draft.effort ? { defaultEffort: draft.effort } : {}),
      })),
    );
    if (disposed) return;
    piBusy = false;
    if (status) {
      piStatus = status;
      piStepOverride = null;
    } else if (!piMessage) {
      piMessage = '모델 저장 실패';
    }
    renderPi();
    syncPrefsInputs();
    renderUsage();
  }

  async function refreshPiStatus(): Promise<void> {
    const status = await bridge.requestPiStatus();
    if (disposed) return;
    if (status) piStatus = status;
    renderPi();
    syncPrefsInputs();
    renderUsage();
  }

  async function refreshProviders(refresh: boolean): Promise<void> {
    refreshBtn.disabled = true;
    const result = await bridge.requestProviderStatus(refresh);
    if (disposed) return;
    if (result) providers = result;
    renderConnection();
    renderProviders();
  }

  function syncTokenUsage(): void {
    usageViews.setActive(settingsOpen && !disposed && !document.hidden && currentDestination === 'ai' && currentAiSection === 'usage');
  }

  function syncUsagePolling(): void {
    if (usagePoll) clearInterval(usagePoll);
    usagePoll = null;
    syncTokenUsage();
    if (!settingsOpen || currentDestination !== 'ai' || document.hidden || disposed) return;
    void refreshUsage();
    usagePoll = setInterval(() => void refreshUsage(), 60_000);
  }
  document.addEventListener('visibilitychange', syncUsagePolling);

  async function refreshUsage(refresh = false): Promise<void> {
    if (usageBusy || disposed) return;
    usageBusy = true;
    quotaCards.setRefreshing(true);
    usageViews.setLimitsRefreshing(true);
    usageFeedback.textContent = '';
    usageFeedback.hidden = true;
    try {
      const result = await bridge.requestUsage(refresh);
      if (disposed) return;
      if (!result) throw new Error('허브 연결 필요');
      usage = result;
      renderUsage();
      usageFeedback.textContent = refresh ? '조회 완료' : '';
      usageFeedback.hidden = !refresh;
    } catch (error) {
      if (!disposed) {
        usageFeedback.textContent = `조회 실패, 다시 시도 ${error instanceof Error ? error.message : ''}`;
        usageFeedback.hidden = false;
      }
    } finally {
      usageBusy = false;
      if (!disposed) {
        quotaCards.setRefreshing(false);
        usageViews.setLimitsRefreshing(false);
      }
    }
  }

  function acceptAgentInstructions(
    status: AgentInstructionsStatus,
    changedBy = 'system',
    force = false,
  ): void {
    const changedByAgent = changedBy.startsWith('agent:')
      || changedBy.startsWith('agent-confirmed:');
    const changedElsewhere = instructionsDirty
      && instructionsDraftRevision > 0
      && status.revision !== instructionsDraftRevision;
    agentInstructions = status;
    if (changedElsewhere && !force) {
      instructionsMessage = changedByAgent
        ? '에이전트가 지시를 변경했습니다. 초안은 보존됩니다.'
        : '다른 창에서 지시가 변경됐습니다. 초안은 보존됩니다.';
    } else {
      instructionsEditor.value = status.content;
      instructionsDraftRevision = status.revision;
      instructionsDirty = false;
      if (changedByAgent) instructionsMessage = '변경안을 AGENTS.md에 적용했습니다.';
    }
    renderAgentInstructions();
    if (shellReady) renderDestinationState();
  }

  function renderAgentInstructions(): void {
    const maxChars = agentInstructions?.maxChars ?? 30_000;
    instructionsEditor.maxLength = maxChars;
    instructionsEditor.disabled = instructionsBusy || !agentInstructions;
    instructionsReload.disabled = instructionsBusy || connectionState !== 'connected';
    instructionsStatus.textContent = instructionsMessage;
    instructionsStatus.hidden = !instructionsMessage;
  }

  async function refreshAgentInstructions(force = false): Promise<void> {
    if (instructionsBusy) return;
    if (connectionState !== 'connected') {
      renderAgentInstructions();
      return;
    }
    instructionsBusy = true;
    renderAgentInstructions();
    const status = await bridge.requestAgentInstructions();
    if (disposed) return;
    instructionsBusy = false;
    if (status) acceptAgentInstructions(status, 'system', force);
    else {
      instructionsMessage = 'AGENTS.md 불러오기 실패';
      renderAgentInstructions();
    }
  }

  async function saveAgentInstructions(): Promise<boolean> {
    if (!instructionsDirty) return true;
    if (instructionsBusy || connectionState !== 'connected' || !agentInstructions) return false;
    instructionsBusy = true;
    instructionsMessage = '';
    renderAgentInstructions();
    const status = await bridge.saveAgentInstructions(
      instructionsEditor.value,
      instructionsDraftRevision,
    );
    if (disposed) return false;
    instructionsBusy = false;
    if (status) {
      acceptAgentInstructions(status, 'user', true);
      instructionsMessage = '저장됨, 다음 턴부터 적용';
    } else if (!instructionsMessage) {
      instructionsMessage = '저장 실패, 최신 지시를 다시 불러옵니다';
    }
    renderAgentInstructions();
    renderDestinationState();
    return Boolean(status);
  }

  syncPrefsInputs();
  renderModelCatalog();
  renderConnection();
  renderProviders();
  renderAgentInstructions();
  renderTemplates();
  renderUsage();
  renderPi();
  renderDestinationState();
  syncRauLock();

  return {
    element,
    syncPlanLock,
    open(requested?: SettingsDestinationInput): void {
      const destination = normalizeSettingsDestination(requested);
      settingsOpen = true;
      if (!isAiDirty()) {
        prefs = loadAgentPrefs();
        prefsBaseline = clonePrefs(prefs);
        prefsDraft = clonePrefs(prefs);
      }
      connectionState = bridge.getConnectionState();
      projectPane.setConnected(connectionState === 'connected');
      // 웹의 알림 허락은 Studio 밖(사이트 설정)에서 바뀐다 — 열 때마다 다시 본다.
      syncNotificationsSection();
      editingSettings.open();
      themeSettings.open();
      if (destination) selectDestination(destination, aiSettingsSection(requested));
      else selectDestination(lastDestination);
      syncPrefsInputs();
      renderModelCatalog();
      renderConnection();
      if (currentDestination === 'browser') browserPane.open();
      renderProviders();
      renderAgentInstructions();
          renderTemplates();
      renderPi();
      void refreshProviders(false);
      void refreshAgentInstructions(false);
      void refreshUsage();
      void refreshPiStatus();
      void refreshSetupStatuses();
      void refreshTemplates();
      if (connectionState === 'connected') {
        for (const agent of PLAN_AGENTS) void loadModelCatalog(agent);
      }
    },
    close(): void {
      settingsOpen = false;
      rauPane.close();
      accountSection?.close();
      browserPane.close();
      syncUsagePolling();
      if (editingSettings.isDirty()) editingSettings.cancel();
      if (themeSettings.isDirty()) themeSettings.cancel();
      if (isAiDirty()) cancelAiDraft();
      if (projectPane.isDirty()) projectPane.cancel();
      closeAgentSetup();
      finishTemplateName(null);
    },
    rauVisible: () => settingsOpen && currentDestination === 'ai' && currentAiSection === 'rau' && rauPane.isOpen(),
    requestClose: resolveDirtyExit,
    isDirty(): boolean {
      return editingSettings.isDirty() || themeSettings.isDirty() || isAiDirty() || projectPane.isDirty();
    },
    openAgentSetup,
    beginAgentConnect,
    handleEvent(ev: SidebarEvent): void {
      switch (ev.type) {
        case 'taste-settings':
          // 다른 창에서 바꿨거나 요청의 답이다. 고르는 중인 값은 그 요청의 답이 덮는다.
          rauPane.acceptTasteSettings(ev.settings);
          break;
        case 'connection':
          connectionState = ev.state;
          setupTerminalResync.connection(ev.state,
            supportsTerminalSetup(setupAgent) && setupAuthRunId !== null && setupOauthPending);
          setupTerminal.setOnline(ev.state === 'connected');
          projectPane.setConnected(ev.state === 'connected');
          renderConnection();
          renderProviders();
          renderPi();
          renderTemplates();
          renderAgentInstructions();
          browserPane.setConnected();
          rauPane.setConnected(ev.state === 'connected');
          if (ev.state === 'connected' && !agentInstructions) void refreshAgentInstructions(false);
          if (ev.state === 'connected' && currentDestination === 'browser') browserPane.open();
          if (ev.state === 'connected' && settingsOpen) {
            for (const agent of PLAN_AGENTS) void loadModelCatalog(agent);
          }
          renderModelCatalog();
          break;
        case 'model-catalog':
          if (ev.agent === 'claude' || ev.agent === 'codex') {
            renderModelCatalog();
            syncPrefsInputs();
          }
          break;
        case 'agent-instructions':
          acceptAgentInstructions(ev.status, ev.changedBy);
          break;
        case 'agent-instructions-error':
          if (ev.status) agentInstructions = ev.status;
          instructionsBusy = false;
          instructionsMessage = ev.message;
          renderAgentInstructions();
          break;
        case 'provider-status':
          providers = ev.providers;
          renderProviders();
          break;
        case 'agent-setup-status': {
          if (unifiedUpdates) void updatesApi?.refreshAll?.().catch(() => {});
          setupStatusRevision += 1;
          setupStatuses = ev.statuses;
          announceProviderUpdates(ev.statuses);
          const selectedStatus = setupAgent ? ev.statuses[setupAgent] : null;
          if (setupAgent && isSetupOpen() && selectedStatus?.authOwnedByThisSession && selectedStatus.authRunId
            && !abandonedAuthRunIds.has(selectedStatus.authRunId)) {
            const previousRunId = setupAuthRunId;
            setupAuthRunId = selectedStatus.authRunId;
            setupBusy = true;
            setupOauthPending = supportsTerminalSetup(setupAgent) || Boolean(selectedStatus.authUrl);
            if (supportsTerminalSetup(setupAgent)) {
              void setupTerminal.open(AGENT_LABEL[setupAgent]);
              // 다른 로그인이거나, 같은 로그인이라도 끊겼다 다시 붙었으면 화면을 다시 받는다.
              setupTerminalResync.sync(setupAgent, previousRunId, selectedStatus.authRunId);
            }
            setupAuthUrl = selectedStatus.authUrl ?? setupAuthUrl;
            if (setupAgent === 'claude') setupCodePending = true;
          }
          // 재접속했거나 다른 탭에서 시작한 설치도 끝날 때까지 설치 중으로 보인다.
          const installInFlight = setupAgent !== null && setupAgent !== 'pi'
            && (selectedStatus?.installing === true || pendingInstalls.has(setupAgent));
          if (installInFlight && isSetupOpen() && !setupBusy) {
            setupBusy = true;
            setupMessage = '';
            if (setupProgressPercent <= 0) setSetupInstallProgress(8, 'preparing');
          }
          // 로그인·설치가 아직 진행 중이면 주기 방송이 카드 상태(주소·코드)를 지우지 않는다.
          const inFlight = setupAgent !== null && setupBusy
            && ((ev.statuses[setupAgent]?.authenticating === true
                && ev.statuses[setupAgent]?.authOwnedByThisSession === true)
              || ev.statuses[setupAgent]?.installing === true
              || pendingInstalls.has(setupAgent));
          if (!inFlight) {
            setupBusy = false;
            setupReauth = false;
            setupCodePending = false;
            clearSetupAuthPrompt();
            // 재접속한 탭이나 다른 탭에는 완료 프레임이 오지 않는다. 방송된 상태로 막대를 끝낸다.
            if (setupProgressPercent > 0 && setupProgressPercent < 100) {
              if (selectedStatus?.installed && !selectedStatus.updateRequired) setSetupInstallProgress(100, 'done');
              else resetSetupInstallProgress();
            }
          }
          renderProviders();
          renderAgentSetup();
          // 설정을 마친 grok · cursor 는 기록이 없어도 사용량 칸을 연다.
          renderUsage();
          // cursor 동적 모델 목록이 도착하면 기본 모델 선택지도 다시 채운다.
          syncPrefsInputs();
          break;
        }
        case 'agent-setup-terminal':
          if (!supportsTerminalSetup(setupAgent) || ev.agent !== setupAgent || !setupBusy || !setupOauthPending) break;
          if (abandonedAuthRunIds.has(ev.authRunId)) break;
          if (setupAuthRunId && ev.authRunId !== setupAuthRunId) break;
          setupAuthRunId = ev.authRunId;
          setupBusy = true;
          setupOauthPending = true;
          void setupTerminal.open(AGENT_LABEL[setupAgent]);
          if (ev.ready) setupTerminal.ready();
          if (ev.data !== undefined) setupTerminal.write(ev.data, ev.reset);
          break;
        case 'agent-setup-progress':
          if (setupAgent === ev.agent) {
            if (ev.authRunId && setupAuthRunId && ev.authRunId !== setupAuthRunId) break;
            // 끊긴 사이 취소한 실행은 재연결 때 재생돼도 다시 열지 않는다.
            if (ev.authRunId && abandonedAuthRunIds.has(ev.authRunId)) break;
            if (ev.authRunId) setupAuthRunId = ev.authRunId;
            const awaitingInstall = pendingInstalls.has(ev.agent);
            if (ev.state === 'installing' && setupProgressPercent <= 0) setSetupInstallProgress(8, 'preparing');
            setupBusy = awaitingInstall || ev.state !== 'done';
            // API 키 검증 중에도 authorizing 이 온다 — 브라우저 로그인 근거가 있을 때만 상자를 연다.
            if (ev.state === 'authorizing' && (ev.authUrl || ev.userCode)) setupOauthPending = true;
            if (ev.authUrl) setupAuthUrl = ev.authUrl;
            if (ev.userCode) setupUserCode = ev.userCode;
            if (ev.state === 'done') clearSetupAuthPrompt();
            maybeOpenAuthUrl(ev.authUrl);
            if (ev.state === 'done' && awaitingInstall) {
              setSetupInstallProgress(Math.min(setupProgressPercent, 99), 'verifying');
            } else if (typeof ev.percent === 'number') {
              setSetupInstallProgress(ev.percent, ev.phase ?? ev.state);
            } else if (setupProgressPercent > 0) {
              // CLI 설치는 단계만 알린다. 단계로 막대를 옮기고 끝나면 100% 까지 채운다.
              setSetupInstallProgress(ev.state === 'done' ? 100 : setupProgressPercent, ev.phase ?? ev.state);
            }
            renderAgentSetup();
          }
          break;
        case 'agent-setup-error':
          if (!ev.agent || setupAgent === ev.agent) {
            if (ev.authRunId && setupAuthRunId && ev.authRunId !== setupAuthRunId) break;
            setupBusy = false;
            setupCodePending = false;
            setupMessage = ev.message;
            setupDetail = ev.detail ?? '';
            setupDetailFor = ev.message;
            clearSetupAuthPrompt();
            resetSetupInstallProgress();
            if (setupAgent === 'pi') piMessage = ev.message;
            renderAgentSetup();
          }
          break;
        case 'usage-report':
          usage = ev.usage;
          renderUsage();
          break;
        case 'templates-catalog':
          templates = ev.catalog.templates;
          templatesMessage = '';
          renderTemplates();
          break;
        case 'pi-status': {
          const authenticated = ev.status.keyConfigured && (!piStatus?.keyConfigured || setupBusy);
          // 선물과 내 키는 모델 목록이 다르다. 자격이 바뀌면 목록을 다시 받는다.
          if (piStatus && (piStatus.credential ?? 'own') !== (ev.status.credential ?? 'own')) {
            piCatalog = [];
            piCatalogTried = false;
          }
          piStatus = ev.status;
          if (authenticated && setupAgent === 'pi' && setupOverlay.getAttribute('aria-hidden') === 'false') {
            setupBusy = false;
            piBusy = false;
            openPiModelCatalog();
          }
          renderPi();
          syncPrefsInputs();
          renderUsage();
          break;
        }
        case 'pi-setup-progress':
          piProgress = PI_PROGRESS_LABEL[ev.state] ?? '';
          if (ev.state === 'done') {
            setPiInstallProgress(100, 'done', false);
          } else if (typeof ev.percent === 'number') {
            setPiInstallProgress(ev.percent, ev.state, typeof ev.receivedBytes !== 'number');
            piProgress = `${piProgress} ${Math.floor(ev.percent)}%`;
            if (typeof ev.receivedBytes === 'number') {
              const total = typeof ev.totalBytes === 'number' && ev.totalBytes > 0 ? ev.totalBytes : null;
              piProgress = total
                ? `${PI_PROGRESS_LABEL.downloading} ${formatMb(ev.receivedBytes)} / ${formatMb(total)} (${Math.floor(ev.percent)}%)`
                : `${PI_PROGRESS_LABEL.downloading} ${formatMb(ev.receivedBytes)} (${Math.floor(ev.percent)}%)`;
            }
          } else if (typeof ev.receivedBytes === 'number') {
            const total = typeof ev.totalBytes === 'number' && ev.totalBytes > 0 ? ev.totalBytes : null;
            if (total) {
              const percent = (ev.receivedBytes / total) * 100;
              piBarDeterminate(percent);
              piProgress = `${PI_PROGRESS_LABEL['downloading']} ${formatMb(ev.receivedBytes)} / ${formatMb(total)} (${Math.floor(percent)}%)`;
            } else {
              piBarNudge();
              piProgress = `${PI_PROGRESS_LABEL['downloading']} ${formatMb(ev.receivedBytes)}`;
            }
          } else {
            // 숫자 없는 단계 — 신호가 도착할 때만 막대가 흐른다.
            piBarNudge();
          }
          renderPi();
          break;
        case 'pi-catalog':
          piCatalog = ev.models;
          renderPi();
          break;
        case 'pi-error':
          piMessage = ev.message;
          if (setupAgent === 'pi') setupBusy = false;
          renderPi();
          break;
        default:
          break;
      }
    },
    dispose(): void {
      if (supportsTerminalSetup(setupAgent) && setupAuthRunId) bridge.cancelAgentSetup(setupAgent, setupAuthRunId);
      if (setupCloseTimer) clearTimeout(setupCloseTimer);
      setupTerminal.dispose();
      projectPane.dispose();
      archivePane.dispose();
      browserPane.dispose();
      rauPane.dispose();
      unsubscribeBrowserSettings();
      disposed = true;
      settingsOpen = false;
      browserPane.close();
      syncUsagePolling();
      document.removeEventListener('visibilitychange', syncUsagePolling);
      quotaCards.dispose();
      usageViews.dispose();
      if (piActivityPause) {
        clearTimeout(piActivityPause);
        piActivityPause = null;
      }
      if (setupProgressResetTimer) {
        clearTimeout(setupProgressResetTimer);
        setupProgressResetTimer = null;
      }
      if (setupCopyResetTimer) {
        clearTimeout(setupCopyResetTimer);
        setupCopyResetTimer = null;
      }
      if (setupProgressCreepTimer) clearInterval(setupProgressCreepTimer);
      if (piProgressCreepTimer) clearInterval(piProgressCreepTimer);
      unsubscribeHancomGit();
      unsubscribeAttentionPrefs();
      instructionsEditor.destroy();
      unsubscribeInitialSetup();
      providerUpdateHippo?.dispose();
      accountSection?.dispose();
      autofixSection?.dispose();
      piGift?.dispose();
      editingSettings.dispose();
      themeSettings.dispose();
      element.remove();
      setupOverlay.remove();
      finishTemplateName(null);
    },
  };
}
