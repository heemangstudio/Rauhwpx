/**
 * 첫 실행 설정 — 화면·글꼴 뒤 무료 편집과 AI 경로를 나누고, AI 는 로그인·요금제·선택적 연결 순서로 안내한다.
 *
 * 화면에는 고를 것만 두고 설명은 하마의 말풍선 한 줄로 한다. 실제 로그인·설치는 설정 모달이
 * 맡는다. 문체 보정은 여기서 묻지 않고 첫 대화 뒤 사이드바의 작은 칩이 권한다.
 * 부트 화면이 사라진 뒤에 열리고, 첫 실행이 문서를 열면서 시작됐으면 열지 않고 미룬다.
 * 요금제 안내는 기존 결제 카드로 이어지고, 무료로 시작할 수도 있다.
 */
import '../agent-sidebar/motion.css';
import './initial-setup.css';

import {
  applyFirstRunDefaultAgent,
} from '../../agent/agent-prefs.ts';
import type {
  AgentName,
  AgentSetupStatusMap,
  SidebarEvent,
} from '../../agent/types.ts';
import { createWebAssistantConnection, WEB_ASSISTANTS, type WebAssistant, type WebAssistantConnectionOptions } from '../agent-sidebar/web-assistant-settings.ts';
import { getThemeMode, setThemeMode } from '../../core/theme.ts';
import type { ThemeMode } from '../../core/user-settings.ts';
import { chooseFontFolder } from '../../core/font-folder.ts';
import { createIcon } from '../agent-sidebar/icons.ts';
import { AGENT_LABEL, createProviderIcon, PROVIDER_ORDER } from '../agent-sidebar/providers.ts';
import { afterBootScreen, bootLaunchedWithFile } from '../boot-screen.ts';
import {
  isProviderConfigured,
  SUGGESTED_AGENT,
} from './catalog.ts';
import { createHippo } from './hippo.ts';
import { createPartyHama } from '../agent-sidebar/chat-hama.ts';
import { accountStore, type AccountStore } from '../account/account-store.ts';
import type { PlanStore } from '../plan/plan-store.ts';
import { createAccountStep } from './account-step.ts';
import { holdInitialSetup, markLicensedHere, releaseInitialSetup } from './active.ts';
import {
  completeInitialSetup,
  loadInitialSetup,
  saveInitialSetup,
  shouldForceInitialSetup,
  shouldShowInitialSetup,
  type InitialSetupRecord,
  type InitialSetupStorage,
} from './state.ts';
import {
  canOfferFontFolder,
  detectFontStep,
  findHancomFonts,
  HANCOM_OFFICE_URL,
  HIPPO_LINES,
  planSteps,
  type FontStepKind,
  type SetupStep,
} from './steps.ts';

const FONT_SEARCH_TIMEOUT_MS = 30_000;
/** 활성화를 축하한 뒤 마지막 장면으로 넘어가기까지. */
const SIGNED_IN_HOLD_MS = 1_400;

const THEME_CHOICES: ReadonlyArray<{ mode: ThemeMode; label: string }> = [
  { mode: 'system', label: '시스템 설정' },
  { mode: 'light', label: '라이트' },
  { mode: 'dark', label: '다크' },
];

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

function button(className: string, label?: string): HTMLButtonElement {
  const node = el('button', className, label);
  node.type = 'button';
  return node;
}

/**
 * 첫 실행 설정이 기본값으로 저장한 프로바이더를 지금 사이드바의 채팅에 세울지. 아직 보낸 메시지가 없고 일하지
 * 않는 채팅만 바꾼다 — 이미 시작한 대화의 프로바이더는 바꾸지 않는다. 바꿀 프로바이더, 아니면 null.
 */
export function firstRunAgentForChat(
  defaultAgent: AgentName,
  chat: { selectedAgent: AgentName; userMessages: number; working: boolean; readOnly: boolean },
): AgentName | null {
  if (chat.userMessages > 0 || chat.working || chat.readOnly) return null;
  return defaultAgent === chat.selectedAgent ? null : defaultAgent;
}

/**
 * 첫 실행 설정의 문서 수준 Esc 가 설정을 끝낼지. 위에 뜬 연결 창(설정 모달)이 먼저 처리한 Esc 나 그 창이
 * 열려 있는 동안의 Esc 는 그 창의 것이다 — 첫 실행 설정을 끝내 나머지 단계를 건너뛰게 하지 않는다.
 */
export function initialSetupTakesEscape(
  event: Pick<KeyboardEvent, 'key' | 'defaultPrevented'>,
  doc: Pick<Document, 'querySelector'>,
): boolean {
  if (event.key !== 'Escape' || event.defaultPrevented) return false;
  return doc.querySelector('.ag-agent-setup-overlay[aria-hidden="false"]') === null;
}

export interface InitialSetupDeps {
  openAgentSetup: (agent: AgentName) => void;
  beginAgentConnect?: (agent: AgentName) => void;
  /** 예전 2단계 흐름의 보정 창 열기. 카드는 더 이상 쓰지 않는다. */
  openCalibration?: (options?: { elevate?: boolean }) => void;
  storage?: InitialSetupStorage | null;
  /** 글꼴 단계가 필요한지. 미리보기는 고정값을 넘긴다. */
  detectFontStep?: () => Promise<FontStepKind | null>;
  findHancomFonts?: typeof findHancomFonts;
  chooseFontFolder?: () => Promise<unknown>;
  canOfferFontFolder?: () => boolean;
  openExternal?: (url: string) => void;
  /** 데스크톱 계정. 생략하면 창의 계정 상태를 쓰고, null 이면 계정 장이 없다. */
  account?: AccountStore | null;
  plan?: PlanStore;
  /** 기존 결제 카드가 닫힐 때까지 기다린다. 열 수 없으면 false. */
  openPlans?: () => Promise<boolean>;
  /** ChatGPT·Claude 계정 연결(데스크톱 앱 브라우저). 없으면 연결 단계가 없다. */
  connectors?: WebAssistantConnectionOptions | null;
  /** 끝내거나 건너뛰어 다시 열 일이 없어졌을 때. */
  onFinished?: () => void;
}

export interface InitialSetupUi {
  element: HTMLElement;
  open(): void;
  close(): void;
  handleEvent(event: SidebarEvent): void;
  notifyCalibrationClosed(completed: boolean): void;
  dispose(): void;
}

export function createInitialSetup(deps: InitialSetupDeps): InitialSetupUi {
  const { openAgentSetup, beginAgentConnect, storage } = deps;
  const pickFontFolder = deps.chooseFontFolder ?? chooseFontFolder;
  const searchHancomFonts = deps.findHancomFonts ?? findHancomFonts;
  const offerFolder = deps.canOfferFontFolder ?? canOfferFontFolder;
  const openExternal = deps.openExternal
    ?? ((url: string) => { window.open(url, '_blank', 'noopener,noreferrer'); });
  let disposed = false;
  let record: InitialSetupRecord = loadInitialSetup(storage);
  let setupStatuses: AgentSetupStatusMap | null = null;
  let lastFocus: HTMLElement | null = null;
  let fontStep: FontStepKind | null = null;
  const connectorOptions = deps.connectors ?? null;
  let steps: SetupStep[] = planSteps(null);
  let stepIndex = 0;
  let themeStep: InitialSetupRecord['themeStep'] = record.themeStep;
  let fontStepState: InitialSetupRecord['fontStep'] = record.fontStep;
  let fontSearch: 'idle' | 'searching' | 'found' | 'missing' = 'idle';
  const account = deps.account === undefined ? accountStore() : deps.account;
  const accountApi = account?.api ?? null;
  let accountStep = false;
  let ai = false;
  let choosingPlan = false;
  function rebuildSteps(preferred = currentStep()): void {
    const plan = deps.plan?.status();
    steps = planSteps(fontStep, {
      ai, account: accountStep,
      signedIn: accountApi ? account?.status()?.state === 'signed_in' : plan?.signedIn === true,
      tier: plan?.tier ?? 'free',
      connectors: connectorOptions !== null,
    });
    const index = steps.indexOf(preferred);
    stepIndex = index >= 0 ? index : Math.min(stepIndex, steps.length - 1);
  }
  const fontStepReady = (deps.detectFontStep ?? detectFontStep)()
    .catch(() => null)
    .then((kind) => {
      fontStep = kind;
      rebuildSteps();
      renderFonts();
      renderStep();
    });
  // 계정 장은 처음 본 상태로 정한다. 이 창에서 로그인해도 장은 그대로 남는다.
  const accountStepReady = (accountApi ? accountApi.getStatus().catch(() => null) : Promise.resolve(null))
    .then((status) => {
      accountStep = accountApi !== null && status?.state !== 'signed_in';
      rebuildSteps();
      renderStep();
    });

  const overlay = el('div', 'rhwp-setup-overlay');
  overlay.setAttribute('aria-hidden', 'true');
  const dialog = el('section', 'rhwp-setup-dialog');
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-label', '처음 설정');
  dialog.tabIndex = -1;

  const head = el('header', 'rhwp-setup-head');
  const hippo = createHippo();
  const skip = button('rhwp-setup-skip');
  skip.setAttribute('aria-label', '나중에');
  skip.title = '나중에';
  skip.appendChild(createIcon('close'));
  head.append(hippo.element, skip);

  // ── 테마 ──
  const themePanel = el('div', 'rhwp-setup-panel');
  themePanel.dataset.step = 'theme';
  const themeGroup = el('div', 'rhwp-setup-themes');
  themeGroup.setAttribute('role', 'radiogroup');
  themeGroup.setAttribute('aria-label', '화면 테마');
  const themeButtons = new Map<ThemeMode, HTMLButtonElement>();
  for (const choice of THEME_CHOICES) {
    const tile = button('rhwp-setup-theme');
    tile.dataset.mode = choice.mode;
    tile.setAttribute('role', 'radio');
    tile.setAttribute('aria-label', choice.label);
    tile.title = choice.label;
    const preview = el('span', 'rhwp-setup-theme-preview');
    preview.setAttribute('aria-hidden', 'true');
    for (const side of choice.mode === 'system' ? ['light', 'dark'] : [choice.mode]) {
      const pane = el('span', 'rhwp-setup-theme-pane');
      pane.dataset.tone = side;
      pane.append(el('span', 'rhwp-setup-theme-bar'), el('span', 'rhwp-setup-theme-page'));
      preview.append(pane);
    }
    const check = el('span', 'rhwp-setup-check');
    check.appendChild(createIcon('check'));
    tile.append(preview, check);
    tile.addEventListener('click', () => {
      setThemeMode(choice.mode);
      themeStep = 'done';
      renderTheme();
    });
    themeGroup.append(tile);
    themeButtons.set(choice.mode, tile);
  }
  themePanel.append(themeGroup);

  // ── 모델 ──
  const modelsPanel = el('div', 'rhwp-setup-panel rhwp-setup-providers');
  modelsPanel.dataset.step = 'models';
  const grid = el('div', 'rhwp-setup-grid');
  grid.setAttribute('role', 'list');
  const cards = new Map<AgentName, { root: HTMLElement; action: HTMLButtonElement }>();
  for (const agent of PROVIDER_ORDER) {
    const card = el('div', 'rhwp-setup-card');
    card.setAttribute('role', 'listitem');
    card.dataset.agent = agent;
    card.dataset.suggested = agent === SUGGESTED_AGENT ? 'true' : 'false';
    const action = button('rhwp-setup-card-action');
    const logo = el('span', 'rhwp-setup-card-logo');
    logo.appendChild(createProviderIcon(agent));
    const name = el('span', 'rhwp-setup-card-name', AGENT_LABEL[agent]);
    const check = el('span', 'rhwp-setup-check');
    check.appendChild(createIcon('check'));
    action.append(logo, name, check);
    action.addEventListener('click', () => {
      (beginAgentConnect ?? openAgentSetup)(agent);
    });
    card.append(action);
    grid.appendChild(card);
    cards.set(agent, { root: card, action });
  }
  modelsPanel.append(grid);

  // ── 연결: 쓰고 있는 ChatGPT·Claude 계정. 설정 → AI → 연결의 줄과 같은 연결을 카드로 보인다. ──
  const connectorsPanel = el('div', 'rhwp-setup-panel rhwp-setup-connectors');
  connectorsPanel.dataset.step = 'connectors';
  const connectorGrid = el('div', 'rhwp-setup-grid');
  connectorGrid.setAttribute('role', 'list');
  const CONNECTOR_LOGO: Record<WebAssistant, AgentName> = { chatgpt: 'codex', claude: 'claude' };
  const connectors = connectorOptions ? (['chatgpt', 'claude'] as const).map((service) => {
    const connection = createWebAssistantConnection(service, connectorOptions);
    const card = el('div', 'rhwp-setup-card');
    card.setAttribute('role', 'listitem');
    card.dataset.service = service;
    const action = button('rhwp-setup-card-action');
    const logo = el('span', 'rhwp-setup-card-logo');
    logo.appendChild(createProviderIcon(CONNECTOR_LOGO[service]));
    const status = el('span', 'rhwp-setup-card-status');
    const check = el('span', 'rhwp-setup-check');
    check.appendChild(createIcon('check'));
    action.append(logo, el('span', 'rhwp-setup-card-name', WEB_ASSISTANTS[service].name), status, check);
    // 누르면 켜고 앱 안 로그인 창을 연다. 로그인되면 창이 저절로 닫힌다.
    action.addEventListener('click', () => {
      const current = connection.status();
      if (current?.signedIn === true || connection.signingIn() || connectorOptions.chromeSignIn?.site()) return;
      void (async () => { if (!current?.enabled) await connection.setEnabled(true); await connection.signIn(); })();
    });
    // 패스키·Google 계정은 Chrome에서 로그인한다. 진행 중이면 같은 자리가 '완료'가 된다.
    const alt = button('rhwp-setup-font-folder rhwp-setup-card-alt', 'Chrome으로 로그인');
    alt.addEventListener('click', () => {
      void (async () => { if (!connection.status()?.enabled) await connection.setEnabled(true); await connection.chrome(); })();
    });
    card.append(action, alt);
    connectorGrid.appendChild(card);
    const entry = { service, connection, card, action, status, alt, signedIn: false };
    connection.subscribe(() => renderConnector(entry));
    return entry;
  }) : [];
  connectorsPanel.append(connectorGrid);

  // ── 글꼴: 스스로 찾고, 못 찾으면 찾기·한컴오피스 받기, 그래도 없으면 폴더 ──
  const fontsPanel = el('div', 'rhwp-setup-panel');
  fontsPanel.dataset.step = 'fonts';
  const fontActions = el('div', 'rhwp-setup-font-actions');
  function fontTile(icon: 'search' | 'external'): { root: HTMLButtonElement; icon: HTMLElement; label: HTMLElement } {
    const root = button('rhwp-setup-font-action');
    const iconSlot = el('span', 'rhwp-setup-font-icon');
    iconSlot.appendChild(createIcon(icon));
    const label = el('span', 'rhwp-setup-font-label');
    const check = el('span', 'rhwp-setup-check');
    check.appendChild(createIcon('check'));
    root.append(iconSlot, label, check);
    return { root, icon: iconSlot, label };
  }
  const findTile = fontTile('search');
  const officeTile = fontTile('external');
  officeTile.label.textContent = '한컴오피스 받기';
  fontActions.append(findTile.root, officeTile.root);
  const folderLink = button('rhwp-setup-font-folder');
  folderLink.append(createIcon('folder'), el('span', '', '폴더에서 찾기'));
  fontsPanel.append(fontActions, folderLink);

  function settleFontSearch(found: boolean | null): void {
    if (disposed) return;
    if (found) {
      fontSearch = 'found';
      fontStepState = 'done';
      renderFonts();
      hippo.cheer(HIPPO_LINES.found);
      return;
    }
    fontSearch = 'missing';
    renderFonts();
    hippo.say(offerFolder() ? HIPPO_LINES.missingWithFolder : HIPPO_LINES.missing);
  }

  findTile.root.addEventListener('click', () => {
    if (fontSearch === 'searching' || fontSearch === 'found') return;
    // 설치 글꼴 권한 창은 클릭 처리 안에서 바로 열어야 한다.
    const pending = searchHancomFonts({ ask: true, refresh: true }).catch(() => null);
    fontSearch = 'searching';
    renderFonts();
    hippo.say(HIPPO_LINES.searching);
    // 권한 창이 답 없이 남아도 찾는 중에 멈춰 있지 않는다. 늦게 찾으면 그때 반영한다.
    const timeout = new Promise<null>((resolve) => window.setTimeout(() => resolve(null), FONT_SEARCH_TIMEOUT_MS));
    void Promise.race([pending, timeout]).then((found) => {
      if (fontSearch === 'searching') settleFontSearch(found);
    });
    void pending.then((found) => {
      if (found && fontSearch !== 'found') settleFontSearch(true);
    });
  });
  officeTile.root.addEventListener('click', () => openExternal(HANCOM_OFFICE_URL));
  folderLink.addEventListener('click', () => {
    // 폴더 선택 창도 클릭 처리 안에서 바로 열어야 한다.
    void pickFontFolder().then((picked) => {
      if (!picked) return null;
      return searchHancomFonts({ refresh: true });
    }).then((found) => {
      if (found !== null) settleFontSearch(found);
    }).catch(() => {});
  });

  /* 한컴오피스를 설치하고 돌아오면 묻지 않고 다시 찾아본다. */
  let lastFocusSearch = 0;
  function onWindowFocus(): void {
    if (!overlay.isConnected || currentStep() !== 'fonts') return;
    if (fontSearch === 'found' || fontSearch === 'searching') return;
    if (Date.now() - lastFocusSearch < 4000) return;
    lastFocusSearch = Date.now();
    void searchHancomFonts({ refresh: true }).then((found) => {
      if (found) settleFontSearch(true);
    }).catch(() => {});
  }
  window.addEventListener('focus', onWindowFocus);

  // ── 계정: Google·이메일 로그인. 로그인을 잠깐 보여 준 뒤 다음 장으로 넘어간다. ──
  let signedInTimer: number | undefined;
  const accountPanel = account && accountApi
    ? createAccountStep({
      store: account,
      cheer: (line) => hippo.cheer(line),
      onSignedIn: (status) => {
        // 유료 요금제로 로그인했으면 선물 창이 환영 인사로 뜬다.
        if (status.plan.tier !== 'free') markLicensedHere();
        window.clearTimeout(signedInTimer);
        signedInTimer = window.setTimeout(() => {
          if (overlay.isConnected && currentStep() === 'account') void next();
        }, SIGNED_IN_HOLD_MS);
      },
      onStateChange: () => { rebuildSteps(); renderStep(); },
    })
    : null;
  const accountElement = accountPanel?.element ?? el('div', 'rhwp-setup-panel');

  const body = el('div', 'rhwp-setup-body');
  const welcomePanel = el('div', 'rhwp-setup-panel rhwp-setup-paths');
  const freePath = button('rhwp-setup-path');
  freePath.dataset.path = 'free';
  freePath.append(createIcon('document'), el('strong', '', '문서부터 시작'), el('span', '', '로그인 없이 무료로 편집하세요.'));
  freePath.addEventListener('click', finish);
  const aiPath = button('rhwp-setup-path');
  aiPath.dataset.path = 'ai';
  const routeNotice = el('p', 'rhwp-setup-notice');
  routeNotice.setAttribute('role', 'status');
  routeNotice.hidden = true;
  aiPath.append(createIcon('sparkles'), el('strong', '', 'AI와 함께 시작'), el('span', '', '로그인하고 나에게 맞는 요금제를 고르세요.'));
  aiPath.addEventListener('click', () => {
    if (!accountApi && !deps.plan?.status()?.signedIn) {
      routeNotice.textContent = 'AI 설정은 데스크톱 앱에서 시작할 수 있어요.';
      routeNotice.hidden = false;
      return;
    }
    ai = true;
    rebuildSteps('welcome');
    void next();
  });
  welcomePanel.append(freePath, aiPath, routeNotice);

  const plansPanel = el('div', 'rhwp-setup-panel rhwp-setup-plans');
  const planSummary = el('div', 'rhwp-setup-plan-summary');
  /** 체험을 쓸 수 있는 계정이면 Rau 줄이 체험을 알린다. 로그인한 뒤라 그릴 때마다 다시 본다. */
  function renderPlanSummary(): void {
    const trial = account?.status()?.trial?.state === 'available' && !!accountApi?.startRauTrial;
    planSummary.replaceChildren(...([
      ['Hama', '쓰던 AI 계정으로 문서 작업'],
      ['Rau', trial ? 'Rau 모드 · 7일 무료 체험' : 'Hama에 Rau 모드를 더해요'],
    ] as const).map(([name, copy]) => {
      const row = el('div', 'rhwp-setup-plan-row');
      row.append(el('strong', '', name), el('span', '', copy));
      return row;
    }));
  }
  renderPlanSummary();
  const planAction = button('rhwp-setup-upgrade-action', '요금제 선택');
  const planError = el('p', 'rhwp-setup-notice');
  planError.setAttribute('role', 'status');
  planError.hidden = true;
  planAction.addEventListener('click', () => { void choosePlan(); });
  plansPanel.append(planSummary, planAction, planError);

  const rauPanel = el('div', 'rhwp-setup-panel rhwp-setup-upgrade');
  rauPanel.append(
    createPartyHama(),
    el('h2', 'rhwp-setup-upgrade-title', '이제 Rau와 함께해요'),
    el('p', 'rhwp-setup-upgrade-copy', 'Rau 모드가 작업하면서 내 글 취향을 배워요.'),
    el('p', 'rhwp-setup-hint', '배운 취향은 언제든 보고 되돌릴 수 있어요.'),
  );
  const modelsHint = el('p', 'rhwp-setup-hint', '연결은 나중에 설정에서도 할 수 있어요.');
  modelsPanel.append(modelsHint);
  body.append(themePanel, fontsPanel, welcomePanel, accountElement, plansPanel, modelsPanel, connectorsPanel, rauPanel);
  const panels: Record<SetupStep, HTMLElement> = {
    theme: themePanel, fonts: fontsPanel, welcome: welcomePanel,
    account: accountElement, plans: plansPanel, models: modelsPanel, connectors: connectorsPanel, rau: rauPanel,
  };

  async function choosePlan(): Promise<void> {
    if (choosingPlan) return;
    if (!deps.openPlans) {
      planError.textContent = '요금제는 데스크톱 앱에서 선택할 수 있어요.';
      planError.hidden = false;
      return;
    }
    choosingPlan = true;
    planAction.disabled = true;
    overlay.hidden = true;
    try {
      const opened = await deps.openPlans();
      if (disposed || !overlay.isConnected) return;
      if (!opened) {
        planError.textContent = '요금제를 열지 못했어요. 다시 시도해 주세요.';
        planError.hidden = false;
        return;
      }
      if (!deps.plan?.status() || deps.plan.status()!.tier === 'free') {
        finish();
        return;
      }
      markLicensedHere();
      rebuildSteps('models');
      renderStep();
      focusStep();
    } catch {
      planError.textContent = '요금제를 열지 못했어요. 다시 시도해 주세요.';
      planError.hidden = false;
    } finally {
      choosingPlan = false;
      planAction.disabled = false;
      overlay.hidden = false;
      if (overlay.isConnected) focusStep();
    }
  }

  const footer = el('footer', 'rhwp-setup-footer');
  const dots = el('span', 'rhwp-setup-dots');
  dots.setAttribute('role', 'group');
  dots.setAttribute('aria-label', '설정 단계');
  const primary = button('rhwp-setup-primary', '다음');
  footer.append(dots, primary);

  dialog.append(head, body, footer);
  overlay.appendChild(dialog);

  function configuredAgents(): AgentName[] {
    return PROVIDER_ORDER.filter((agent) => isProviderConfigured(agent, setupStatuses));
  }

  function renderTheme(): void {
    const mode = getThemeMode();
    for (const [choice, tile] of themeButtons) {
      tile.setAttribute('aria-checked', choice === mode ? 'true' : 'false');
    }
  }

  function renderCards(): void {
    for (const agent of PROVIDER_ORDER) {
      const card = cards.get(agent);
      if (!card) continue;
      const configured = isProviderConfigured(agent, setupStatuses);
      card.root.dataset.configured = configured ? 'true' : 'false';
      card.action.setAttribute(
        'aria-label',
        configured ? `${AGENT_LABEL[agent]} 연결됨` : `${AGENT_LABEL[agent]} 연결`,
      );
    }
  }

  function renderConnector(entry: (typeof connectors)[number]): void {
    const status = entry.connection.status();
    const chromeSite = connectorOptions?.chromeSignIn?.site() ?? null;
    const chromeHere = !!chromeSite && WEB_ASSISTANTS[entry.service].signInUrl.includes(chromeSite);
    const signedIn = status?.signedIn === true;
    entry.card.dataset.configured = signedIn ? 'true' : 'false';
    entry.status.textContent = signedIn ? '연결됨'
      : chromeHere ? 'Chrome에서 로그인 중'
      : entry.connection.signingIn() ? '로그인 창에서 로그인'
      : entry.connection.checking() ? '확인 중…'
      : status?.busy ? 'Chrome 로그인 중'
      : '';
    entry.action.setAttribute('aria-label', signedIn ? `${WEB_ASSISTANTS[entry.service].name} 연결됨` : `${WEB_ASSISTANTS[entry.service].name} 연결`);
    const chrome = connectorOptions?.chromeSignIn;
    entry.alt.hidden = !chrome || chrome.available() === false || signedIn || !!chromeSite && !chromeHere;
    entry.alt.textContent = chromeHere ? '완료' : 'Chrome으로 로그인';
    entry.alt.disabled = !chromeHere && entry.connection.signingIn();
    // 이 단계에서 새로 연결되면 하마가 알린다.
    if (signedIn && !entry.signedIn && currentStep() === 'connectors' && overlay.isConnected) hippo.say(HIPPO_LINES.connectorConnected);
    entry.signedIn = signedIn;
  }

  function renderFonts(): void {
    if (fontSearch === 'idle' && fontStep === 'missing') fontSearch = 'missing';
    const rescan = fontStep === 'missing' || fontSearch === 'missing';
    findTile.icon.replaceChildren(createIcon(rescan ? 'refresh' : 'search'));
    findTile.label.textContent = fontSearch === 'found' ? '찾았어요' : rescan ? '다시 찾기' : '글꼴 찾기';
    findTile.root.dataset.done = fontSearch === 'found' ? 'true' : 'false';
    findTile.root.setAttribute('aria-busy', fontSearch === 'searching' ? 'true' : 'false');
    fontsPanel.dataset.search = fontSearch;
    folderLink.hidden = !(fontSearch === 'missing' && offerFolder());
  }

  function currentStep(): SetupStep {
    return steps[Math.min(stepIndex, steps.length - 1)]!;
  }

  function lineFor(step: SetupStep): string {
    if (step === 'theme') return HIPPO_LINES.theme;
    if (step === 'models') {
      return configuredAgents().length > 0 ? HIPPO_LINES.modelConnected : HIPPO_LINES.models;
    }
    if (step === 'connectors') return connectors.some((entry) => entry.signedIn) ? HIPPO_LINES.connectorConnected : HIPPO_LINES.connectors;
    if (step === 'welcome') return HIPPO_LINES.welcome;
    if (step === 'plans') return HIPPO_LINES.plans;
    if (step === 'rau') return HIPPO_LINES.rau;
    if (step === 'account') return accountPanel?.signedIn() ? HIPPO_LINES.signedIn : HIPPO_LINES.account;
    if (fontSearch === 'found') return HIPPO_LINES.found;
    if (fontSearch === 'missing') return offerFolder() ? HIPPO_LINES.missingWithFolder : HIPPO_LINES.missing;
    return HIPPO_LINES.discover;
  }

  let spokenStep: SetupStep | null = null;
  function renderStep(): void {
    const step = currentStep();
    if (step === 'plans') renderPlanSummary();
    for (const [name, panel] of Object.entries(panels) as Array<[SetupStep, HTMLElement]>) {
      panel.hidden = name !== step;
    }
    dialog.dataset.step = step;
    const labels: Record<SetupStep, string> = {
      theme: '화면 테마', models: 'AI 연결', fonts: '글꼴', account: '계정',
      welcome: '시작 방법', plans: '요금제', connectors: '계정 연결', rau: 'Rau 소개',
    };
    dots.replaceChildren(...steps.map((name, index) => {
      const dot = button('rhwp-setup-dot');
      dot.setAttribute('aria-label', labels[name]);
      dot.title = labels[name];
      if (index === stepIndex) dot.setAttribute('aria-current', 'step');
      dot.addEventListener('click', () => {
        stepIndex = index;
        renderStep();
        focusStep();
      });
      return dot;
    }));
    const last = stepIndex >= steps.length - 1;
    // 로그인하지 않고 넘어가면 무료로 쓴다.
    const leave = step === 'welcome' || step === 'plans' || (step === 'account' && !accountPanel?.signedIn());
    primary.hidden = step === 'welcome';
    primary.textContent = leave ? '무료로 시작' : step === 'models' ? '연결 건너뛰기' : last ? '홈으로' : '다음';
    if (step === 'models' && configuredAgents().length > 0) primary.textContent = last ? '홈으로' : '다음';
    primary.setAttribute('aria-label', primary.textContent);
    primary.dataset.quiet = leave || step === 'models' ? 'true' : 'false';
    if (spokenStep !== step && overlay.isConnected) {
      // 연결 단계에 들어올 때 상태를 다시 읽는다(켜진 서비스만 보이지 않는 탭으로 로그인을 확인한다).
      if (step === 'connectors') for (const entry of connectors) { renderConnector(entry); void entry.connection.refresh(true); }
      spokenStep = step;
      hippo.say(lineFor(step));
    }
  }

  function focusStep(): void {
    const step = currentStep();
    if (step === 'account' && accountPanel) {
      (accountPanel.focusTarget() ?? primary).focus({ preventScroll: true });
      return;
    }
    const panel = panels[step];
    const target = panel.querySelector<HTMLElement>('[aria-checked="true"]')
      ?? panel.querySelector<HTMLElement>('button:not([disabled])');
    (target ?? primary).focus({ preventScroll: true });
  }

  /* 홈으로 나가는 순간 설정 완료 상태를 저장한다. */
  let saved = false;
  function save(): void {
    if (saved) return;
    saved = true;
    applyFirstRunDefaultAgent(configuredAgents(), storage ?? null);
    record = completeInitialSetup({
      themeStep: themeStep === 'done' ? 'done' : 'skipped',
      providerStep: configuredAgents().length > 0 ? 'configured' : 'skipped',
      fontStep: fontStepState === 'done' ? 'done' : 'skipped',
      calibrationStep: record.calibrationStep === 'done' ? 'done' : 'pending',
    }, storage);
  }

  function finish(): void {
    save();
    close();
    deps.onFinished?.();
  }

  async function next(): Promise<void> {
    // 글꼴·계정 장을 넣을지 알기 전에는 마지막 장을 정하지 않는다.
    await Promise.all([fontStepReady, accountStepReady]);
    if (currentStep() === 'plans' || (currentStep() === 'welcome' && !ai)
      || (currentStep() === 'account' && !accountPanel?.signedIn())) {
      finish();
      return;
    }
    rebuildSteps();
    if (stepIndex >= steps.length - 1) {
      finish();
      return;
    }
    stepIndex += 1;
    renderStep();
    focusStep();
  }

  primary.addEventListener('click', () => { void next(); });
  skip.addEventListener('click', () => finish());

  function onKeyDown(event: KeyboardEvent): void {
    if (choosingPlan || !overlay.isConnected || !overlay.classList.contains('rhwp-setup-open')) return;
    if (!initialSetupTakesEscape(event, document)) return;
    event.preventDefault();
    finish();
  }

  function open(): void {
    if (disposed || overlay.isConnected) return;
    holdInitialSetup(overlay);
    lastFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    document.body.appendChild(overlay);
    overlay.setAttribute('aria-hidden', 'false');
    ai = false;
    steps = planSteps(fontStep);
    stepIndex = 0;
    spokenStep = null;
    saved = false;
    dots.hidden = false;
    renderTheme();
    renderCards();
    renderFonts();
    renderStep();
    requestAnimationFrame(() => {
      overlay.classList.add('rhwp-setup-open');
      focusStep();
    });
  }

  function close(): void {
    releaseInitialSetup(overlay);
    if (!overlay.isConnected) return;
    overlay.classList.remove('rhwp-setup-open');
    overlay.setAttribute('aria-hidden', 'true');
    lastFocus?.focus();
    window.setTimeout(() => overlay.remove(), 420);
  }

  const stopPlan = deps.plan?.subscribe(() => {
    if (choosingPlan || disposed) return;
    rebuildSteps();
    renderStep();
  }) ?? (() => {});
  document.addEventListener('keydown', onKeyDown);

  return {
    element: overlay,
    open,
    close,
    handleEvent(event: SidebarEvent): void {
      if (disposed || event.type !== 'agent-setup-status') return;
      const before = configuredAgents().length;
      setupStatuses = event.statuses;
      renderCards();
      renderStep();
      if (overlay.isConnected && currentStep() === 'models' && configuredAgents().length > before) {
        hippo.cheer(HIPPO_LINES.modelConnected);
      }
    },
    notifyCalibrationClosed(): void {
      // 카드에는 보정 단계가 없다. 사이드바 칩이 결과를 기록한다.
    },
    dispose(): void {
      disposed = true;
      window.clearTimeout(signedInTimer);
      stopPlan();
      accountPanel?.dispose();
      for (const entry of connectors) entry.connection.dispose();
      hippo.dispose();
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('focus', onWindowFocus);
      overlay.remove();
      releaseInitialSetup(overlay);
    },
  };
}

/**
 * 첫 실행이면 부트 화면이 사라진 뒤 설정을 연다. 문서를 열면서 처음 켜졌으면 열지 않고
 * deferred 로 남겨 사이드바 칩이 권하게 한다(onDeferred).
 */
export function maybeStartInitialSetup(
  deps: InitialSetupDeps & { onDeferred?: () => void },
): InitialSetupUi | null {
  if (!shouldShowInitialSetup(deps.storage)) return null;
  const ui = createInitialSetup(deps);
  // 부트 화면이 걷히기를 기다리는 동안에도 처음 설정이 뜰 차례로 본다.
  holdInitialSetup(ui.element);
  void (async () => {
    if (!shouldForceInitialSetup() && await bootLaunchedWithFile()) {
      saveInitialSetup({ deferred: true }, deps.storage);
      releaseInitialSetup(ui.element);
      deps.onDeferred?.();
      return;
    }
    await afterBootScreen();
    ui.open();
  })();
  return ui;
}
