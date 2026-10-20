// 설정 → AI 의 자동 버그 수정(데스크톱만). 켜기 스위치와, 켰을 때 쓰는 프로바이더의 순서·켜기·모델·추론 강도.
// 바꾸는 즉시 데스크톱에 저장한다(알림·Git 전환처럼 적용 단추를 거치지 않는다).
// 다른 창이나 소개 창에서 바뀌어도 onAutofixSettings 로 따라간다.
import './settings-autofix.css';

import {
  AGENT_MODELS,
  claudeModelLabel,
  effortsForAgent,
  OFFICIAL_CLAUDE_MODELS,
  resolveEffortForAgent,
  type AgentModelOption,
} from '../../agent/models.ts';
import {
  autofixApi,
  autofixSettings,
  onAutofixSettings,
  updateAutofixSettings,
  type AutofixProviderId,
  type AutofixProviderSettings,
  type AutofixSettings,
} from '../autofix/autofix.ts';
import { AUTOFIX_INTRO_MESSAGE } from '../autofix/autofix-intro-popup.ts';
import { createIcon } from './icons.ts';
import { AGENT_LABEL, createProviderIcon } from './providers.ts';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function createSwitch(label: string): { root: HTMLLabelElement; input: HTMLInputElement } {
  const root = el('label', 'ag-autofix-switch');
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.className = 'ag-settings-toggle-input';
  input.setAttribute('role', 'switch');
  input.setAttribute('aria-label', label);
  const track = el('span', 'ag-settings-toggle-track');
  track.setAttribute('aria-hidden', 'true');
  root.append(input, track);
  return { root, input };
}

/** 프로바이더별 모델 선택지. 지금 값이 목록에 없으면 맨 뒤에 붙여 그대로 보인다. */
export function autofixModelOptions(id: AutofixProviderId, current: string): AgentModelOption[] {
  const options: AgentModelOption[] = id === 'codex'
    ? AGENT_MODELS.codex.map((model) => ({ id: model.id, label: model.label }))
    : OFFICIAL_CLAUDE_MODELS.map((model) => ({ id: model, label: claudeModelLabel(model) }));
  if (current && !options.some((option) => option.id === current)) {
    options.push({ id: current, label: id === 'claude' ? claudeModelLabel(current) : current });
  }
  return options;
}

function fill(select: HTMLSelectElement, options: readonly AgentModelOption[], value: string): void {
  const same = select.options.length === options.length
    && options.every((option, index) => select.options[index]?.value === option.id);
  if (!same) {
    select.replaceChildren(...options.map((option) => new Option(option.label, option.id)));
  }
  select.value = value;
}

interface ProviderRow {
  root: HTMLElement;
  rank: HTMLElement;
  up: HTMLButtonElement;
  enabled: HTMLInputElement;
  model: HTMLSelectElement;
  effort: HTMLSelectElement;
}

export interface AutofixSettingsSection {
  root: HTMLElement;
  dispose(): void;
}

/** 데스크톱 자동 수정 API 가 없으면(웹 빌드) null. */
export function createAutofixSettingsSection(): AutofixSettingsSection | null {
  if (!autofixApi()) return null;
  const root = el('section', 'ag-settings-section ag-autofix-settings');
  const head = el('div', 'ag-settings-section-head');
  head.append(el('h3', 'ag-settings-section-title', '자동 버그 수정'));
  const body = el('div', 'ag-settings-section-body');
  root.append(head, body);

  const toggle = el('label', 'ag-settings-control-row ag-settings-toggle-row');
  const copy = el('span', 'ag-settings-control-copy');
  copy.append(el('span', 'ag-settings-control-label', '사용'), el('span', 'ag-settings-control-description', AUTOFIX_INTRO_MESSAGE));
  const toggleInput = document.createElement('input');
  toggleInput.type = 'checkbox';
  toggleInput.className = 'ag-settings-toggle-input';
  toggleInput.setAttribute('role', 'switch');
  toggleInput.setAttribute('aria-label', '자동 버그 수정 사용');
  const toggleTrack = el('span', 'ag-settings-toggle-track');
  toggleTrack.setAttribute('aria-hidden', 'true');
  toggle.append(copy, toggleInput, toggleTrack);

  const list = el('div', 'ag-autofix-providers');
  list.setAttribute('role', 'list');
  list.setAttribute('aria-label', '쓰는 순서');
  body.append(toggle, list);

  let current: AutofixSettings | null = autofixSettings();
  const rows = new Map<AutofixProviderId, ProviderRow>();

  function save(patch: Partial<AutofixSettings>): void {
    void updateAutofixSettings(patch).catch((error) => {
      console.warn('[settings] 자동 버그 수정 설정을 저장하지 못했습니다:', error);
      render();
    });
  }

  function patchProvider(id: AutofixProviderId, change: (entry: AutofixProviderSettings) => AutofixProviderSettings): void {
    if (!current) return;
    const providers = current.providers.map((entry) => entry.id === id ? change({ ...entry }) : { ...entry });
    current = { ...current, providers };
    render();
    save({ providers });
  }

  function moveUp(id: AutofixProviderId): void {
    if (!current) return;
    const providers = current.providers.map((entry) => ({ ...entry }));
    const index = providers.findIndex((entry) => entry.id === id);
    if (index <= 0) return;
    [providers[index - 1], providers[index]] = [providers[index]!, providers[index - 1]!];
    current = { ...current, providers };
    render();
    // 옮긴 줄이 맨 위면 위로 단추가 사라지므로 그 줄의 스위치로 포커스를 옮긴다.
    const row = rows.get(id);
    (row && !row.up.hidden ? row.up : row?.enabled)?.focus({ preventScroll: true });
    save({ providers });
  }

  function createRow(id: AutofixProviderId): ProviderRow {
    const label = AGENT_LABEL[id];
    const row = el('div', 'ag-autofix-provider');
    row.setAttribute('role', 'listitem');
    row.dataset.provider = id;
    const top = el('div', 'ag-autofix-provider-head');
    const rank = el('span', 'ag-autofix-rank');
    const name = el('span', 'ag-autofix-provider-name');
    name.append(createProviderIcon(id), document.createTextNode(label));
    const up = el('button', 'ag-settings-btn ag-autofix-up');
    up.type = 'button';
    up.title = '먼저 쓰기';
    up.setAttribute('aria-label', `${label} 먼저 쓰기`);
    up.append(createIcon('updown'));
    up.addEventListener('click', () => moveUp(id));
    const enabled = createSwitch(`${label} 사용`);
    enabled.input.addEventListener('change', () => {
      const on = enabled.input.checked;
      patchProvider(id, (entry) => ({ ...entry, enabled: on }));
    });
    top.append(rank, name, up, enabled.root);

    const controls = el('div', 'ag-autofix-provider-controls');
    const model = el('select', 'ag-settings-select') as HTMLSelectElement;
    model.setAttribute('aria-label', `${label} 모델`);
    const effort = el('select', 'ag-settings-select') as HTMLSelectElement;
    effort.setAttribute('aria-label', `${label} 추론 강도`);
    model.addEventListener('change', () => {
      const next = model.value;
      patchProvider(id, (entry) => ({ ...entry, model: next, effort: resolveEffortForAgent(id, entry.effort, next) }));
    });
    effort.addEventListener('change', () => {
      const next = effort.value;
      patchProvider(id, (entry) => ({ ...entry, effort: next }));
    });
    controls.append(model, effort);
    row.append(top, controls);
    return { root: row, rank, up, enabled: enabled.input, model, effort };
  }

  function render(): void {
    const settings = current;
    root.hidden = !settings;
    if (!settings) return;
    toggleInput.checked = settings.enabled;
    list.hidden = !settings.enabled;
    settings.providers.forEach((entry, index) => {
      let row = rows.get(entry.id);
      if (!row) {
        row = createRow(entry.id);
        rows.set(entry.id, row);
      }
      // 순서가 바뀐 줄만 옮겨 포커스와 열린 선택 상자를 흔들지 않는다.
      if (list.children[index] !== row.root) list.insertBefore(row.root, list.children[index] ?? null);
      row.rank.textContent = String(index + 1);
      row.up.hidden = index === 0;
      row.enabled.checked = entry.enabled;
      row.root.dataset.enabled = entry.enabled ? 'true' : 'false';
      row.model.disabled = !entry.enabled;
      row.effort.disabled = !entry.enabled;
      fill(row.model, autofixModelOptions(entry.id, entry.model), entry.model);
      const efforts = [...effortsForAgent(entry.id, entry.model)];
      if (entry.effort && !efforts.some((option) => option.id === entry.effort)) {
        efforts.push({ id: entry.effort, label: entry.effort });
      }
      fill(row.effort, efforts, entry.effort);
    });
  }

  toggleInput.addEventListener('change', () => {
    if (!current) return;
    const enabled = toggleInput.checked;
    current = { ...current, enabled, decided: true };
    render();
    save({ enabled, decided: true });
  });

  const stop = onAutofixSettings((next) => {
    current = next;
    render();
  });
  render();

  return {
    root,
    dispose(): void {
      stop();
    },
  };
}
