// 설정 → AI 의 Rau-0.1 (취향 학습). 대화에서 배우기 스위치와 학습기의 공급자·모델·추론 강도.
// 허브가 정본이다. 알림·Git 전환처럼 바꾸는 즉시 저장하고 적용 초안을 거치지 않는다.
// 데스크톱에서 공급자가 자동이면 Pro 줄이 호스팅 Rau 자격을 보인다(Pro 가 아니면 업그레이드 단추).
// 공급자 고르기는 정리 도우미(settings-project.ts)와 같은 방식이다. BYOK(Pi)로는 돌지 않는다 — 고를 수 있는 공급자는 Claude·Codex 뿐이다.
import './settings-taste.css';

import type { SidebarBridge } from '../../agent/bridge.ts';
import {
  claudeModelLabel,
  effortsForAgent,
  labelForModel,
  modelsForAgent,
  resolveEffortForAgent,
} from '../../agent/models.ts';
import { RAU_TASTE_NAME, TASTE_DEFAULT_ROUTES, TASTE_EFFORTS } from '../../agent/taste.ts';
import type { TasteProvider, TasteSettings } from '../../agent/types.ts';
import { AGENT_LABEL } from './providers.ts';
import { openRauUpgrade, type DesktopRauApi, type RauStatus } from './rau-upgrade.ts';

type Option = { id: string; label: string };
type ChosenProvider = Exclude<TasteProvider, 'auto'>;

const PROVIDERS: readonly { id: TasteProvider; label: string }[] = [
  { id: 'auto', label: '자동' },
  { id: 'claude', label: AGENT_LABEL.claude },
  { id: 'codex', label: AGENT_LABEL.codex },
];

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function selectRow(field: string, label: string): { root: HTMLElement; select: HTMLSelectElement } {
  const root = el('div', 'ag-settings-control-row ag-taste-setting-row');
  root.dataset.tasteField = field;
  const copy = el('span', 'ag-settings-control-copy');
  copy.append(el('span', 'ag-settings-control-label', label));
  const select = el('select', 'ag-settings-select ag-taste-setting-select');
  select.setAttribute('aria-label', `${RAU_TASTE_NAME} ${label}`);
  root.append(copy, select);
  return { root, select };
}

function fill(control: HTMLSelectElement, options: readonly Option[], value: string): void {
  const same = control.options.length === options.length
    && options.every((option, index) => control.options[index]?.value === option.id && control.options[index]?.text === option.label);
  if (!same) control.replaceChildren(...options.map((option) => new Option(option.label, option.id)));
  if (options.some((option) => option.id === value)) control.value = value;
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

  const provider = selectRow('provider', '공급자');
  const model = selectRow('model', '모델');
  const effort = selectRow('effort', '추론');

  // 호스팅 Rau(Pro). 자동 경로일 때만 먼저 쓰므로 그때만 보인다.
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

  body.append(learning, provider.root, pro, model.root, effort.root);

  // 허브가 답하기 전에는 기본값(켜짐, 자동)을 보이고 잠가 둔다.
  let settings: TasteSettings | null = null;
  let shown: TasteSettings = { enabled: true, provider: 'auto', model: null, effort: null };
  let saving = false;
  let request = 0;

  function modelOptions(agent: ChosenProvider, current: string): Option[] {
    const options: Option[] = modelsForAgent(agent).map((entry) => ({ id: entry.id, label: entry.label }));
    if (!options.some((option) => option.id === current)) {
      options.unshift({ id: current, label: agent === 'claude' ? claudeModelLabel(current) : labelForModel('codex', current) });
    }
    return options;
  }

  function effortOptions(agent: ChosenProvider, current: string): Option[] {
    return [...effortsForAgent(agent, current)].filter((option) => TASTE_EFFORTS.includes(option.id)).reverse();
  }

  function effortFor(agent: ChosenProvider, chosenModel: string, chosenEffort: string | null): string | null {
    const options = effortOptions(agent, chosenModel);
    if (options.length === 0) return null;
    const preferred = chosenEffort ?? TASTE_DEFAULT_ROUTES[agent].effort;
    if (options.some((option) => option.id === preferred)) return preferred;
    const resolved = resolveEffortForAgent(agent, null, chosenModel);
    return options.some((option) => option.id === resolved) ? resolved : options[0]!.id;
  }

  function renderPro(): void {
    const status = rauStatus;
    pro.hidden = !status?.ok || shown.provider !== 'auto' || !shown.enabled;
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
    const off = locked || !shown.enabled;
    fill(provider.select, PROVIDERS, shown.provider);
    provider.select.disabled = off;
    const agent = shown.provider === 'auto' ? null : shown.provider;
    model.root.hidden = agent === null;
    effort.root.hidden = agent === null;
    if (!agent) return;
    const currentModel = shown.model ?? TASTE_DEFAULT_ROUTES[agent].model;
    fill(model.select, modelOptions(agent, currentModel), currentModel);
    model.select.disabled = off;
    const efforts = effortOptions(agent, currentModel);
    effort.root.hidden = efforts.length === 0;
    fill(effort.select, efforts, effortFor(agent, currentModel, shown.effort) ?? '');
    effort.select.disabled = off;
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
  provider.select.addEventListener('change', () => {
    void save({ provider: provider.select.value as TasteProvider, model: null, effort: null });
  });
  model.select.addEventListener('change', () => {
    const agent = shown.provider === 'auto' ? null : shown.provider;
    if (!agent) return;
    const next = model.select.value;
    void save({ model: next, effort: effortFor(agent, next, shown.effort) });
  });
  effort.select.addEventListener('change', () => void save({ effort: effort.select.value || null }));
  upgrade.addEventListener('click', () => openRauUpgrade(deps.rau ?? null, rauStatus?.upgradeUrl));

  render();
  return { root, accept, refresh };
}
