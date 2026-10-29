/**
 * 첫 실행 설정 — 테마, 모델 연결, (필요하면) 글꼴, (데스크톱에서 키가 없으면) 라이선스, (데스크톱이면) 자동 버그 수정.
 *
 * 화면에는 고를 것만 두고 설명은 하마의 말풍선 한 줄로 한다. 실제 로그인·설치는 설정 모달이
 * 맡는다. 문체 보정은 여기서 묻지 않고 첫 대화 뒤 사이드바의 작은 칩이 권한다.
 * 부트 화면이 사라진 뒤에 열리고, 첫 실행이 문서를 열면서 시작됐으면 열지 않고 미룬다.
 * 라이선스 장에서 키를 활성화하면 선물 크레딧 창(special-event)이 이 창 위에 바로 뜰 수 있게 비켜 준다.
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
  TasteProvider,
  TasteSettings,
} from '../../agent/types.ts';
import { RAU_TASTE_NAME } from '../../agent/taste.ts';
import { getThemeMode, setThemeMode } from '../../core/theme.ts';
import type { ThemeMode } from '../../core/user-settings.ts';
import { chooseFontFolder } from '../../core/font-folder.ts';
import { createIcon } from '../agent-sidebar/icons.ts';
import { AGENT_LABEL, CONNECTABLE_PROVIDERS, createProviderIcon } from '../agent-sidebar/providers.ts';
import { afterBootScreen, bootLaunchedWithFile } from '../boot-screen.ts';
import {
  isProviderConfigured,
  SUGGESTED_AGENT,
} from './catalog.ts';
import { createHippo } from './hippo.ts';
import { autofixApi, autofixSettings, onAutofixSettings, updateAutofixSettings } from '../autofix/autofix.ts';
import type { DesktopLicenseApi, LicenseStatus } from '../agent-sidebar/settings-license.ts';
import { createLicenseStep, licenseLine, needsLicenseStep } from './license-step.ts';
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
const LICENSED_HOLD_MS = 1_400;

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
  /** 자동 버그 수정 단계를 넣을지. 기본은 데스크톱 자동 수정 API 가 있을 때. */
  autofixAvailable?: () => boolean;
  /** Rau-0.1 설정(허브가 정본). 없으면 Rau-0.1 단계가 없다. */
  taste?: {
    get(): Promise<TasteSettings | null>;
    set(patch: Partial<TasteSettings>): Promise<TasteSettings | null>;
  } | null;
  /** 데스크톱 라이선스. 생략하면 rhwpDesktop.license 를 쓰고, null 이면 라이선스 장이 없다. */
  license?: DesktopLicenseApi | null;
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
  const withAutofix = (deps.autofixAvailable ?? (() => autofixApi() !== null))();
  const tasteApi = deps.taste ?? null;
  const withTaste = tasteApi !== null;
  let steps: SetupStep[] = planSteps(null, { autofix: withAutofix, taste: withTaste });
  let stepIndex = 0;
  let themeStep: InitialSetupRecord['themeStep'] = record.themeStep;
  let fontStepState: InitialSetupRecord['fontStep'] = record.fontStep;
  let fontSearch: 'idle' | 'searching' | 'found' | 'missing' = 'idle';
  const licenseApi = deps.license === undefined
    ? (window as Window & { rhwpDesktop?: { license?: DesktopLicenseApi } }).rhwpDesktop?.license ?? null
    : deps.license;
  let licenseStatus: LicenseStatus | null = null;
  let licenseStep = false;
  const fontStepReady = (deps.detectFontStep ?? detectFontStep)()
    .catch(() => null)
    .then((kind) => {
      fontStep = kind;
      steps = planSteps(kind, { autofix: withAutofix, license: licenseStep, taste: withTaste });
      renderFonts();
      renderStep();
    });
  // 라이선스 장은 처음 본 상태로 정한다. 이 창에서 활성화해도 장은 그대로 남는다.
  const licenseStepReady = (licenseApi ? licenseApi.getStatus().catch(() => null) : Promise.resolve(null))
    .then((status) => {
      licenseStatus = status;
      licenseStep = needsLicenseStep(status);
      steps = planSteps(fontStep, { autofix: withAutofix, license: licenseStep, taste: withTaste });
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
  for (const agent of CONNECTABLE_PROVIDERS) {
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

  // ── Rau-0.1: 기본은 켜짐, 자동 공급자. 고르는 순간 허브에 저장한다. 켰을 때만 공급자를 고른다. ──
  const tastePanel = el('div', 'rhwp-setup-panel rhwp-setup-taste');
  tastePanel.dataset.step = 'taste';
  const tasteGroup = el('div', 'rhwp-setup-font-actions');
  tasteGroup.setAttribute('role', 'radiogroup');
  tasteGroup.setAttribute('aria-label', RAU_TASTE_NAME);
  const tasteChoices = ([[true, '켜기', 'sparkles'], [false, '끄기', 'minimize']] as const).map(([enabled, label, icon]) => {
    const root = button('rhwp-setup-font-action');
    root.setAttribute('role', 'radio');
    const iconSlot = el('span', 'rhwp-setup-font-icon');
    iconSlot.appendChild(createIcon(icon));
    const check = el('span', 'rhwp-setup-check');
    check.appendChild(createIcon('check'));
    root.append(iconSlot, el('span', 'rhwp-setup-font-label', label), check);
    root.addEventListener('click', () => void saveTaste({ enabled }));
    tasteGroup.append(root);
    return { enabled, root };
  });
  const tasteProviders = el('div', 'rhwp-setup-grid rhwp-setup-taste-providers');
  tasteProviders.setAttribute('role', 'radiogroup');
  tasteProviders.setAttribute('aria-label', `${RAU_TASTE_NAME} 공급자`);
  const TASTE_PROVIDER_CHOICES: ReadonlyArray<{ id: TasteProvider; label: string }> = [
    { id: 'auto', label: '자동' },
    { id: 'claude', label: AGENT_LABEL.claude },
    { id: 'codex', label: AGENT_LABEL.codex },
    { id: 'pi', label: 'OpenRouter' },
  ];
  const tasteProviderChoices = TASTE_PROVIDER_CHOICES.map(({ id, label }) => {
    const root = button('rhwp-setup-card-action');
    root.setAttribute('role', 'radio');
    root.setAttribute('aria-label', label);
    const logo = el('span', 'rhwp-setup-card-logo');
    logo.appendChild(id === 'auto' ? createIcon('refresh') : createProviderIcon(id));
    const check = el('span', 'rhwp-setup-check');
    check.appendChild(createIcon('check'));
    root.append(logo, el('span', 'rhwp-setup-card-name', label), check);
    root.addEventListener('click', () => void saveTaste({ provider: id, model: null, effort: null }));
    tasteProviders.append(root);
    return { id, root };
  });
  tastePanel.append(tasteGroup, tasteProviders);
  /** 허브가 답하기 전에는 기본값을 보인다. */
  let taste: Pick<TasteSettings, 'enabled' | 'provider'> = { enabled: true, provider: 'auto' };
  let tasteRequest = 0;
  async function loadTaste(): Promise<void> {
    if (!tasteApi) return;
    const seq = ++tasteRequest;
    const current = await tasteApi.get().catch(() => null);
    if (disposed || seq !== tasteRequest || !current) return;
    taste = { enabled: current.enabled, provider: current.provider };
    renderTaste();
  }
  async function saveTaste(patch: Partial<TasteSettings>): Promise<void> {
    if (!tasteApi) return;
    const seq = ++tasteRequest;
    taste = { ...taste, ...patch };
    renderTaste();
    const saved = await tasteApi.set(patch).catch(() => null);
    if (disposed || seq !== tasteRequest) return;
    // 저장하지 못했으면 허브의 값으로 되돌린다.
    if (saved) {
      taste = { enabled: saved.enabled, provider: saved.provider };
      renderTaste();
    } else {
      console.warn('[initial-setup] Rau-0.1 설정을 저장하지 못했습니다');
      void loadTaste();
    }
  }

  // ── 자동 버그 수정: 기본은 꺼짐. 고르는 순간 답한 것으로 저장한다. ──
  const autofixPanel = el('div', 'rhwp-setup-panel');
  autofixPanel.dataset.step = 'autofix';
  const autofixGroup = el('div', 'rhwp-setup-font-actions');
  autofixGroup.setAttribute('role', 'radiogroup');
  autofixGroup.setAttribute('aria-label', '자동 버그 수정');
  /* 글꼴 단추와 같은 면을 쓴다. */
  const autofixChoices = ([[true, '켜기', 'sparkles'], [false, '끄기', 'minimize']] as const).map(([enabled, label, icon]) => {
    const root = button('rhwp-setup-font-action');
    root.setAttribute('role', 'radio');
    const iconSlot = el('span', 'rhwp-setup-font-icon');
    iconSlot.appendChild(createIcon(icon));
    const check = el('span', 'rhwp-setup-check');
    check.appendChild(createIcon('check'));
    root.append(iconSlot, el('span', 'rhwp-setup-font-label', label), check);
    root.addEventListener('click', () => {
      autofixChoice = enabled;
      renderAutofix();
      void updateAutofixSettings({ decided: true, enabled }).catch((error) => {
        console.warn('[initial-setup] 자동 버그 수정 설정을 저장하지 못했습니다:', error);
      });
    });
    autofixGroup.append(root);
    return { enabled, root };
  });
  autofixPanel.append(autofixGroup);
  /** 답한 값. 아직 답하지 않았으면 null(둘 다 고르지 않은 상태). */
  let autofixChoice: boolean | null = null;
  const readAutofixChoice = () => {
    const current = autofixSettings();
    if (current?.decided) autofixChoice = current.enabled;
  };
  readAutofixChoice();
  const stopAutofixSettings = withAutofix
    ? onAutofixSettings(() => { readAutofixChoice(); renderAutofix(); })
    : () => {};

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
    if (!overlay.isConnected || celebrating || currentStep() !== 'fonts') return;
    if (fontSearch === 'found' || fontSearch === 'searching') return;
    if (Date.now() - lastFocusSearch < 4000) return;
    lastFocusSearch = Date.now();
    void searchHancomFonts({ refresh: true }).then((found) => {
      if (found) settleFontSearch(true);
    }).catch(() => {});
  }
  window.addEventListener('focus', onWindowFocus);

  // ── 라이선스: 구매와 키 넣기. 활성화를 잠깐 보여 준 뒤 다음 장으로 넘어간다. ──
  let licensedTimer: number | undefined;
  const licensePanel = licenseApi
    ? createLicenseStep({
      api: licenseApi,
      status: null,
      say: (line) => hippo.say(line),
      cheer: (line) => hippo.cheer(line),
      onLicensed: () => {
        markLicensedHere();
        window.clearTimeout(licensedTimer);
        licensedTimer = window.setTimeout(() => {
          if (overlay.isConnected && !celebrating && currentStep() === 'license') void next();
        }, LICENSED_HOLD_MS);
      },
      onStateChange: () => renderStep(),
    })
    : null;
  const licenseElement = licensePanel?.element ?? el('div', 'rhwp-setup-panel');

  const body = el('div', 'rhwp-setup-body');
  body.append(themePanel, modelsPanel, fontsPanel, licenseElement, tastePanel, autofixPanel);
  const panels: Record<SetupStep, HTMLElement> = {
    theme: themePanel,
    models: modelsPanel,
    taste: tastePanel,
    autofix: autofixPanel,
    fonts: fontsPanel,
    license: licenseElement,
  };

  const footer = el('footer', 'rhwp-setup-footer');
  const dots = el('span', 'rhwp-setup-dots');
  dots.setAttribute('aria-hidden', 'true');
  const primary = button('rhwp-setup-primary', '다음');
  footer.append(dots, primary);

  dialog.append(head, body, footer);
  overlay.appendChild(dialog);

  function configuredAgents(): AgentName[] {
    return CONNECTABLE_PROVIDERS.filter((agent) => isProviderConfigured(agent, setupStatuses));
  }

  function renderTheme(): void {
    const mode = getThemeMode();
    for (const [choice, tile] of themeButtons) {
      tile.setAttribute('aria-checked', choice === mode ? 'true' : 'false');
    }
  }

  function renderCards(): void {
    for (const agent of CONNECTABLE_PROVIDERS) {
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

  function renderAutofix(): void {
    for (const choice of autofixChoices) {
      const picked = autofixChoice === choice.enabled;
      choice.root.setAttribute('aria-checked', picked ? 'true' : 'false');
      choice.root.dataset.done = picked ? 'true' : 'false';
    }
  }

  function renderTaste(): void {
    for (const choice of tasteChoices) {
      const picked = taste.enabled === choice.enabled;
      choice.root.setAttribute('aria-checked', picked ? 'true' : 'false');
      choice.root.dataset.done = picked ? 'true' : 'false';
    }
    tasteProviders.hidden = !taste.enabled;
    for (const choice of tasteProviderChoices) {
      choice.root.setAttribute('aria-checked', choice.id === taste.provider ? 'true' : 'false');
    }
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
    if (step === 'taste') return HIPPO_LINES.taste;
    if (step === 'autofix') return HIPPO_LINES.autofix;
    if (step === 'license') return licensePanel?.licensed() ? HIPPO_LINES.licensed : licenseLine(licenseStatus);
    if (fontSearch === 'found') return HIPPO_LINES.found;
    if (fontSearch === 'missing') return offerFolder() ? HIPPO_LINES.missingWithFolder : HIPPO_LINES.missing;
    return HIPPO_LINES.discover;
  }

  let spokenStep: SetupStep | null = null;
  function renderStep(): void {
    const step = currentStep();
    for (const [name, panel] of Object.entries(panels) as Array<[SetupStep, HTMLElement]>) {
      panel.hidden = name !== step;
    }
    dialog.dataset.step = step;
    dots.replaceChildren(...steps.map((_, index) => {
      const dot = el('span', 'rhwp-setup-dot');
      if (index === stepIndex) dot.dataset.current = 'true';
      return dot;
    }));
    const last = stepIndex >= steps.length - 1;
    // 키 없이 넘어가면 체험으로 쓴다.
    const later = step === 'license' && !licensePanel?.licensed();
    primary.textContent = later ? '나중에' : last ? '완료' : '다음';
    // 키가 없을 때는 구매 칸이 눈에 먼저 띄도록 다음 단추를 낮춘다.
    primary.dataset.quiet = later ? 'true' : 'false';
    if (spokenStep !== step && overlay.isConnected) {
      spokenStep = step;
      hippo.say(lineFor(step));
    }
  }

  function focusStep(): void {
    const step = currentStep();
    if (step === 'license' && licensePanel) {
      licensePanel.focusTarget().focus({ preventScroll: true });
      return;
    }
    const panel = panels[step];
    // 자동 버그 수정은 직접 골라야 켜진다. 아무것도 고르지 않았으면 켜기에 포커스를 두지 않는다.
    const target = panel.querySelector<HTMLElement>('[aria-checked="true"]')
      ?? (step === 'autofix' ? null : panel.querySelector<HTMLElement>('button:not([disabled])'));
    (target ?? primary).focus({ preventScroll: true });
  }

  /* 마지막 장면에 들어서는 순간 끝난 것으로 저장한다. 그 뒤로 닫는 방법은 상관없다. */
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

  /* 마지막 장면: 고를 것은 치우고, 하마가 신나서 완료를 알린다. */
  let celebrating = false;
  function showDone(): void {
    window.clearTimeout(licensedTimer);
    save();
    celebrating = true;
    // 키를 활성화했으면 선물 창이 이 장면 위에 바로 뜨도록 비켜 준다.
    if (licensePanel?.licensed()) releaseInitialSetup(overlay);
    for (const panel of Object.values(panels)) panel.hidden = true;
    dialog.dataset.step = 'done';
    dots.hidden = true;
    primary.textContent = '시작';
    hippo.celebrate(HIPPO_LINES.done);
    primary.focus({ preventScroll: true });
  }

  async function next(): Promise<void> {
    if (celebrating) {
      finish();
      return;
    }
    // 글꼴·라이선스 장을 넣을지 알기 전에는 마지막 장을 정하지 않는다.
    await Promise.all([fontStepReady, licenseStepReady]);
    if (stepIndex >= steps.length - 1) {
      showDone();
      return;
    }
    stepIndex += 1;
    renderStep();
    focusStep();
  }

  primary.addEventListener('click', () => { void next(); });
  skip.addEventListener('click', () => finish());

  function onKeyDown(event: KeyboardEvent): void {
    if (!overlay.isConnected || !overlay.classList.contains('rhwp-setup-open')) return;
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
    stepIndex = 0;
    spokenStep = null;
    saved = false;
    celebrating = false;
    dots.hidden = false;
    renderTheme();
    renderCards();
    renderAutofix();
    renderTaste();
    void loadTaste();
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
      if (overlay.isConnected && !celebrating && currentStep() === 'models' && configuredAgents().length > before) {
        hippo.cheer(HIPPO_LINES.modelConnected);
      }
    },
    notifyCalibrationClosed(): void {
      // 카드에는 보정 단계가 없다. 사이드바 칩이 결과를 기록한다.
    },
    dispose(): void {
      disposed = true;
      window.clearTimeout(licensedTimer);
      licensePanel?.dispose();
      hippo.dispose();
      stopAutofixSettings();
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
