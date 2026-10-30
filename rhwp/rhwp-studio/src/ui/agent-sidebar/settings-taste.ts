// 설정 → AI 의 호스팅 Rau-0.1. 대화에서 배우기와 Pro 자격만 보여 준다.
import type { SidebarBridge } from '../../agent/bridge.ts';
import { RAU_TASTE_NAME } from '../../agent/taste.ts';
import type { TasteSettings } from '../../agent/types.ts';
import { openRauUpgrade, type DesktopRauApi, type RauStatus } from './rau-upgrade.ts';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export interface TasteSettingsSectionDeps {
  bridge: Pick<SidebarBridge, 'requestTasteSettings' | 'setTasteSettings'>;
  isDisposed(): boolean;
  /** 데스크톱의 호스팅 Rau 자격. 없으면 Pro 줄이 없다. */
  rau?: DesktopRauApi | null;
}

export interface TasteSettingsSection {
  root: HTMLElement;
  /** 허브의 값(요청의 답이나 다른 창의 알림). 고르는 중인 요청의 답은 이 값이 덮는다. */
  accept(settings: TasteSettings | null): void;
  refresh(): Promise<void>;
  /** 현재 상태를 다시 그린다. */
  render(): void;
}

export function createTasteSettingsSection(deps: TasteSettingsSectionDeps): TasteSettingsSection {
  const root = el('section', 'ag-settings-section ag-taste-settings');
  const head = el('div', 'ag-settings-section-head');
  head.append(el('h3', 'ag-settings-section-title', RAU_TASTE_NAME));
  const body = el('div', 'ag-settings-section-body');
  root.append(head, body);

  const learning = el('label', 'ag-settings-control-row ag-settings-toggle-row');
  const learningCopy = el('span', 'ag-settings-control-copy');
  learningCopy.append(el('span', 'ag-settings-control-label', '대화에서 배우기'));
  const learningInput = el('input', 'ag-settings-toggle-input');
  learningInput.type = 'checkbox';
  learningInput.setAttribute('role', 'switch');
  learningInput.setAttribute('aria-label', '대화에서 배우기');
  const learningTrack = el('span', 'ag-settings-toggle-track');
  learningTrack.setAttribute('aria-hidden', 'true');
  learning.append(learningCopy, learningInput, learningTrack);

  const pro = el('div', 'ag-settings-control-row ag-taste-setting-row ag-taste-pro-row');
  pro.dataset.tasteField = 'pro';
  const proCopy = el('span', 'ag-settings-control-copy');
  const proDetail = el('span', 'ag-settings-control-description');
  proCopy.append(el('span', 'ag-settings-control-label', 'Pro 호스팅'), proDetail);
  const proState = el('span', 'ag-settings-control-description ag-taste-pro-state');
  const upgrade = el('button', 'ag-settings-btn', '업그레이드');
  upgrade.type = 'button';
  pro.append(proCopy, proState, upgrade);
  pro.hidden = true;
  let rauStatus: RauStatus | null = null;

  body.append(learning, pro);

  // 허브가 답하기 전에는 기본값(켜짐, 자동)을 보이고 잠가 둔다.
  let settings: TasteSettings | null = null;
  let shown: TasteSettings = { enabled: true, provider: 'auto', model: null, effort: null };
  let saving = false;
  let request = 0;
  function renderPro(): void {
    const status = rauStatus;
    pro.hidden = !status?.ok || !shown.enabled;
    if (!status?.ok) return;
    const eligible = status.eligible === true;
    const capped = eligible && status.remainingUsd === 0;
    upgrade.hidden = eligible;
    proState.hidden = !eligible;
    proState.textContent = capped
      ? `${status.resetsAt ? new Intl.DateTimeFormat('ko-KR', { month: 'long', day: 'numeric' }).format(new Date(status.resetsAt)) : '다음 달'}까지 한도 도달`
      : '켜짐';
    proDetail.hidden = eligible;
    proDetail.textContent = '월 ₩3,900 · 연 ₩39,000';
  }

  function render(): void {
    renderPro();
    const locked = settings === null || saving;
    learningInput.checked = shown.enabled;
    learningInput.disabled = locked;
  }

  function accept(next: TasteSettings | null): void {
    request += 1;
    saving = false;
    settings = next;
    if (next) shown = { ...next };
    render();
  }

  async function refresh(): Promise<void> {
    if (deps.rau) {
      void deps.rau.getStatus().then((status) => {
        if (deps.isDisposed()) return;
        rauStatus = status;
        renderPro();
      }, () => {});
    }
    const seq = ++request;
    const next = await deps.bridge.requestTasteSettings();
    if (!deps.isDisposed() && seq === request) accept(next);
  }

  async function save(patch: Partial<TasteSettings>): Promise<void> {
    const seq = ++request;
    shown = { ...shown, ...patch };
    saving = true;
    render();
    const next = await deps.bridge.setTasteSettings(patch);
    if (deps.isDisposed() || seq !== request) return;
    // 저장하지 못했으면 허브의 값으로 되돌린다.
    if (next) accept(next);
    else {
      saving = false;
      if (settings) shown = { ...settings };
      void refresh();
    }
  }

  learningInput.addEventListener('change', () => void save({ enabled: learningInput.checked }));
  upgrade.addEventListener('click', () => openRauUpgrade(deps.rau ?? null, rauStatus?.upgradeUrl));

  render();
  return { root, accept, refresh, render };
}
