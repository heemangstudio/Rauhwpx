// 설정 → AI 의 Rau-0.1 (취향 학습). 대화에서 배우기 스위치와 학습기의 공급자·모델·추론 강도.
// 허브가 정본이다. 알림·Git 전환처럼 바꾸는 즉시 저장하고 적용 초안을 거치지 않는다.
// 공급자 고르기는 정리 도우미(settings-project.ts)와 같은 방식이다. OpenRouter 는 내 키로만 돌므로, 키가 없으면
// Pi 설정과 같은 경로(connectOpenRouterKey)로 저장하는 키 칸을 이 자리에 보인다 — 앱 전체의 키는 하나다.
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
import type { PiCatalogModel, PiStatus, TasteProvider, TasteSettings } from '../../agent/types.ts';
import { AGENT_LABEL } from './providers.ts';

type Option = { id: string; label: string };
type ChosenProvider = Exclude<TasteProvider, 'auto'>;

const PROVIDERS: readonly { id: TasteProvider; label: string }[] = [
  { id: 'auto', label: '자동' },
  { id: 'claude', label: AGENT_LABEL.claude },
  { id: 'codex', label: AGENT_LABEL.codex },
  { id: 'pi', label: 'OpenRouter' },
];

/** OpenRouter 의 reasoning effort. 학습기 기본값이 max 라 Pi 설정의 세 단계에 더한다. */
const OPENROUTER_EFFORTS: readonly Option[] = [
  { id: 'low', label: 'Low' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High' },
  { id: 'max', label: 'Max' },
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
  bridge: Pick<SidebarBridge, 'requestTasteSettings' | 'setTasteSettings' | 'requestPiCatalog'>;
  piStatus(): PiStatus | null;
  /** Pi 설정의 키 칸과 같은 저장 경로. 성공하면 true. */
  connectOpenRouterKey(key: string): Promise<boolean>;
  isDisposed(): boolean;
}

export interface TasteSettingsSection {
  root: HTMLElement;
  /** 허브의 값(요청의 답이나 다른 창의 알림). 고르는 중인 요청의 답은 이 값이 덮는다. */
  accept(settings: TasteSettings | null): void;
  refresh(): Promise<void>;
  /** Pi 상태(내 키)가 바뀌었다. */
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

  const provider = selectRow('provider', '공급자');
  const model = selectRow('model', '모델');
  const effort = selectRow('effort', '추론');

  const keyRow = el('form', 'ag-settings-control-row ag-taste-key-row');
  const keyInput = el('input', 'ag-settings-input');
  keyInput.type = 'password';
  keyInput.placeholder = 'OpenRouter 키';
  keyInput.autocomplete = 'new-password';
  keyInput.spellcheck = false;
  keyInput.setAttribute('aria-label', 'OpenRouter 키');
  const keySubmit = el('button', 'ag-settings-primary', '연결');
  keySubmit.type = 'submit';
  const keyError = el('span', 'ag-settings-cliproxy-error', '키 확인 실패');
  keyError.hidden = true;
  keyRow.append(keyInput, keySubmit, keyError);

  body.append(learning, provider.root, model.root, effort.root, keyRow);

  // 허브가 답하기 전에는 기본값(켜짐, 자동)을 보이고 잠가 둔다.
  let settings: TasteSettings | null = null;
  let shown: TasteSettings = { enabled: true, provider: 'auto', model: null, effort: null };
  let saving = false;
  let request = 0;
  let catalog: PiCatalogModel[] = [];
  let catalogState: 'idle' | 'loading' | 'done' = 'idle';
  let catalogKey: string | null = null;
  let keyBusy = false;

  const hasOwnKey = () => deps.piStatus()?.keyConfigured === true;

  function loadCatalog(): void {
    // 키를 새로 연결하면 내 키의 목록으로 다시 받는다.
    const key = hasOwnKey() ? deps.piStatus()?.keyTail ?? 'own' : null;
    if (catalogState === 'loading' || (catalogState === 'done' && catalogKey === key)) return;
    catalogState = 'loading';
    catalogKey = key;
    void deps.bridge.requestPiCatalog(false, { own: true }).then((models) => {
      if (deps.isDisposed()) return;
      catalogState = 'done';
      if (models) catalog = models;
      render();
    });
  }

  function modelOptions(agent: ChosenProvider, current: string): Option[] {
    const options: Option[] = agent === 'pi'
      ? catalog.map((entry) => ({ id: entry.id, label: entry.name }))
      : modelsForAgent(agent).map((entry) => ({ id: entry.id, label: entry.label }));
    if (!options.some((option) => option.id === current)) {
      const label = agent === 'claude' ? claudeModelLabel(current) : agent === 'codex' ? labelForModel('codex', current) : current;
      options.unshift({ id: current, label });
    }
    return options;
  }

  function effortOptions(agent: ChosenProvider, current: string): Option[] {
    if (agent === 'pi') {
      return catalog.find((entry) => entry.id === current)?.reasoning === false ? [] : [...OPENROUTER_EFFORTS];
    }
    return [...effortsForAgent(agent, current)].filter((option) => TASTE_EFFORTS.includes(option.id)).reverse();
  }

  function effortFor(agent: ChosenProvider, chosenModel: string, chosenEffort: string | null): string | null {
    const options = effortOptions(agent, chosenModel);
    if (options.length === 0) return null;
    const preferred = chosenEffort ?? TASTE_DEFAULT_ROUTES[agent].effort;
    if (options.some((option) => option.id === preferred)) return preferred;
    const resolved = agent === 'pi' ? '' : resolveEffortForAgent(agent, null, chosenModel);
    return options.some((option) => option.id === resolved) ? resolved : options[0]!.id;
  }

  function render(): void {
    const locked = settings === null || saving;
    learningInput.checked = shown.enabled;
    learningInput.disabled = locked;
    const off = locked || !shown.enabled;
    fill(provider.select, PROVIDERS, shown.provider);
    provider.select.disabled = off;
    const agent = shown.provider === 'auto' ? null : shown.provider;
    model.root.hidden = agent === null;
    effort.root.hidden = agent === null;
    keyRow.hidden = agent !== 'pi' || deps.piStatus() === null || hasOwnKey();
    if (!agent) return;
    if (agent === 'pi') loadCatalog();
    const currentModel = shown.model ?? TASTE_DEFAULT_ROUTES[agent].model;
    fill(model.select, modelOptions(agent, currentModel), currentModel);
    model.select.disabled = off;
    const efforts = effortOptions(agent, currentModel);
    effort.root.hidden = efforts.length === 0;
    fill(effort.select, efforts, effortFor(agent, currentModel, shown.effort) ?? '');
    effort.select.disabled = off;
    keyInput.disabled = off || keyBusy;
    keySubmit.disabled = off || keyBusy;
  }

  function accept(next: TasteSettings | null): void {
    request += 1;
    saving = false;
    settings = next;
    if (next) shown = { ...next };
    render();
  }

  async function refresh(): Promise<void> {
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
  keyRow.addEventListener('submit', async (event) => {
    event.preventDefault();
    const key = keyInput.value.trim();
    if (!key || keyBusy) return;
    keyBusy = true;
    keyError.hidden = true;
    render();
    const ok = await deps.connectOpenRouterKey(key);
    if (deps.isDisposed()) return;
    keyBusy = false;
    if (ok) keyInput.value = '';
    keyError.hidden = ok;
    render();
  });

  render();
  return { root, accept, refresh, render };
}
