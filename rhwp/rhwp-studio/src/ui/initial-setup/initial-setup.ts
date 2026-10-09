/**
 * 첫 실행 카드 — 모델 한 곳을 연결하거나 바로 편집기로 간다.
 * 실제 로그인·설치는 설정 모달이 맡는다. 문체 보정은 여기서 묻지 않고,
 * 첫 대화 뒤 사이드바의 작은 칩이 권한다.
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
import { AGENT_LABEL, createProviderIcon, PROVIDER_ORDER } from '../agent-sidebar/providers.ts';
import {
  isProviderConfigured,
  PROVIDER_VENDOR,
  SUGGESTED_AGENT,
} from './catalog.ts';
import {
  completeInitialSetup,
  loadInitialSetup,
  shouldShowInitialSetup,
  type InitialSetupRecord,
  type InitialSetupStorage,
} from './state.ts';

const SETUP_TITLE = '모델 연결';

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

function checkMark(): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 12 12');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M2.5 6.4 5 8.9l4.5-5.4');
  svg.appendChild(path);
  return svg;
}

export interface InitialSetupDeps {
  openAgentSetup: (agent: AgentName) => void;
  beginAgentConnect?: (agent: AgentName) => void;
  /** 예전 2단계 흐름의 보정 창 열기. 카드는 더 이상 쓰지 않는다. */
  openCalibration?: (options?: { elevate?: boolean }) => void;
  storage?: InitialSetupStorage | null;
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
  let disposed = false;
  let record: InitialSetupRecord = loadInitialSetup(storage);
  let setupStatuses: AgentSetupStatusMap | null = null;
  let lastFocus: HTMLElement | null = null;

  const overlay = el('div', 'rhwp-setup-overlay');
  overlay.setAttribute('aria-hidden', 'true');
  const dialog = el('section', 'rhwp-setup-dialog');
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-labelledby', 'rhwp-setup-title');
  dialog.tabIndex = -1;

  const title = el('h1', 'rhwp-setup-title', SETUP_TITLE);
  title.id = 'rhwp-setup-title';

  const providersPanel = el('div', 'rhwp-setup-providers');
  const grid = el('div', 'rhwp-setup-grid');
  grid.setAttribute('role', 'list');
  const cards = new Map<AgentName, { root: HTMLElement; action: HTMLButtonElement }>();

  for (const agent of PROVIDER_ORDER) {
    const card = el('div', 'rhwp-setup-card');
    card.setAttribute('role', 'listitem');
    card.dataset.agent = agent;
    card.dataset.suggested = agent === SUGGESTED_AGENT ? 'true' : 'false';
    const action = el('button', 'rhwp-setup-card-action');
    action.type = 'button';
    const logo = el('span', 'rhwp-setup-card-logo');
    logo.appendChild(createProviderIcon(agent));
    const name = el('span', 'rhwp-setup-card-name', AGENT_LABEL[agent]);
    const vendor = el('span', 'rhwp-setup-card-vendor', PROVIDER_VENDOR[agent]);
    const check = el('span', 'rhwp-setup-card-check');
    check.appendChild(checkMark());
    action.append(logo, name, vendor, check);
    action.addEventListener('click', () => {
      (beginAgentConnect ?? openAgentSetup)(agent);
    });
    card.append(action);
    grid.appendChild(card);
    cards.set(agent, { root: card, action });
  }
  providersPanel.append(grid);

  const footer = el('footer', 'rhwp-setup-footer');
  const primary = el('button', 'rhwp-setup-primary', '나중에');
  primary.type = 'button';
  footer.append(primary);

  dialog.append(title, providersPanel, footer);
  overlay.appendChild(dialog);

  function configuredAgents(): AgentName[] {
    return PROVIDER_ORDER.filter((agent) => isProviderConfigured(agent, setupStatuses));
  }

  function configuredCount(): number {
    return configuredAgents().length;
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
    const ready = configuredCount() > 0;
    dialog.dataset.ready = ready ? 'true' : 'false';
    primary.textContent = ready ? '계속' : '나중에';
  }

  function finish(partial: Pick<InitialSetupRecord, 'providerStep' | 'calibrationStep'>): void {
    applyFirstRunDefaultAgent(configuredAgents(), storage ?? null);
    record = completeInitialSetup(partial, storage);
    close();
  }

  /** 문체 보정은 묻지 않고 넘긴다 — 첫 대화 뒤 사이드바 칩이 이어받는다. */
  function skipToEditor(): void {
    finish({
      providerStep: configuredCount() > 0 ? 'configured' : 'skipped',
      calibrationStep: record.calibrationStep === 'done' ? 'done' : 'pending',
    });
  }

  primary.addEventListener('click', skipToEditor);

  function onKeyDown(event: KeyboardEvent): void {
    if (!overlay.isConnected || !overlay.classList.contains('rhwp-setup-open')) return;
    if (event.key !== 'Escape') return;
    event.preventDefault();
    skipToEditor();
  }

  function open(): void {
    if (disposed || overlay.isConnected) return;
    lastFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    document.body.appendChild(overlay);
    overlay.setAttribute('aria-hidden', 'false');
    renderCards();
    requestAnimationFrame(() => {
      overlay.classList.add('rhwp-setup-open');
      cards.get(PROVIDER_ORDER[0])?.action.focus({ preventScroll: true });
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
      setupStatuses = event.statuses;
      renderCards();
    },
    notifyCalibrationClosed(): void {
      // 카드에는 보정 단계가 없다. 사이드바 칩이 결과를 기록한다.
    },
    dispose(): void {
      disposed = true;
      document.removeEventListener('keydown', onKeyDown);
      overlay.remove();
    },
  };
}

export function maybeStartInitialSetup(deps: InitialSetupDeps): InitialSetupUi | null {
  if (!shouldShowInitialSetup(deps.storage)) return null;
  const ui = createInitialSetup(deps);
  ui.open();
  return ui;
}
