/**
 * 첫 실행 설정 — 테마, 모델 연결, (필요하면) 글꼴.
 *
 * 화면에는 고를 것만 두고 설명은 하마의 말풍선 한 줄로 한다. 실제 로그인·설치는 설정 모달이
 * 맡는다. 문체 보정은 여기서 묻지 않고 첫 대화 뒤 사이드바의 작은 칩이 권한다.
 * 부트 화면이 사라진 뒤에 열리고, 첫 실행이 문서를 열면서 시작됐으면 열지 않고 미룬다.
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

const THEME_CHOICES: ReadonlyArray<{ mode: ThemeMode; label: string }> = [
  { mode: 'system', label: '시스템 설정' },
  { mode: 'light', label: '밝게' },
  { mode: 'dark', label: '어둡게' },
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
  let steps: SetupStep[] = planSteps(null);
  let stepIndex = 0;
  let themeStep: InitialSetupRecord['themeStep'] = record.themeStep;
  let fontStepState: InitialSetupRecord['fontStep'] = record.fontStep;
  let fontSearch: 'idle' | 'searching' | 'found' | 'missing' = 'idle';
  const fontStepReady = (deps.detectFontStep ?? detectFontStep)()
    .catch(() => null)
    .then((kind) => {
      fontStep = kind;
      steps = planSteps(kind);
      renderFonts();
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

  const body = el('div', 'rhwp-setup-body');
  body.append(themePanel, modelsPanel, fontsPanel);
  const panels: Record<SetupStep, HTMLElement> = {
    theme: themePanel,
    models: modelsPanel,
    fonts: fontsPanel,
  };

  const footer = el('footer', 'rhwp-setup-footer');
  const dots = el('span', 'rhwp-setup-dots');
  dots.setAttribute('aria-hidden', 'true');
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
    primary.textContent = last ? '시작' : '다음';
    if (spokenStep !== step && overlay.isConnected) {
      spokenStep = step;
      hippo.say(lineFor(step));
    }
  }

  function focusStep(): void {
    const panel = panels[currentStep()];
    const target = panel.querySelector<HTMLElement>('[aria-checked="true"]')
      ?? panel.querySelector<HTMLElement>('button:not([disabled])');
    (target ?? primary).focus({ preventScroll: true });
  }

  function finish(): void {
    applyFirstRunDefaultAgent(configuredAgents(), storage ?? null);
    record = completeInitialSetup({
      themeStep: themeStep === 'done' ? 'done' : 'skipped',
      providerStep: configuredAgents().length > 0 ? 'configured' : 'skipped',
      fontStep: fontStepState === 'done' ? 'done' : 'skipped',
      calibrationStep: record.calibrationStep === 'done' ? 'done' : 'pending',
    }, storage);
    close();
    deps.onFinished?.();
  }

  async function next(): Promise<void> {
    if (currentStep() === 'models') await fontStepReady;
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
    if (!overlay.isConnected || !overlay.classList.contains('rhwp-setup-open')) return;
    if (event.key !== 'Escape') return;
    event.preventDefault();
    finish();
  }

  function open(): void {
    if (disposed || overlay.isConnected) return;
    lastFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    document.body.appendChild(overlay);
    overlay.setAttribute('aria-hidden', 'false');
    stepIndex = 0;
    spokenStep = null;
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
      if (overlay.isConnected && currentStep() === 'models' && configuredAgents().length > before) {
        hippo.cheer(HIPPO_LINES.modelConnected);
      }
    },
    notifyCalibrationClosed(): void {
      // 카드에는 보정 단계가 없다. 사이드바 칩이 결과를 기록한다.
    },
    dispose(): void {
      disposed = true;
      hippo.dispose();
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('focus', onWindowFocus);
      overlay.remove();
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
  void (async () => {
    if (!shouldForceInitialSetup() && await bootLaunchedWithFile()) {
      saveInitialSetup({ deferred: true }, deps.storage);
      deps.onDeferred?.();
      return;
    }
    await afterBootScreen();
    ui.open();
  })();
  return ui;
}
