/**
 * 설정 → 프로젝트. 모든 프로젝트에 쓰는 기본값을 허브의 project settings 에 저장한다.
 * AI 창과 같이 초안을 고친 뒤 적용·취소하며, 저장 공간 줄의 동작(휴지통 비우기·삭제)은
 * 초안과 따로 바로 실행한다.
 */
import './settings-project.css';
import { confirmSheet } from './sheet.ts';
import { effortsForAgent, modelsForAgent, resolveEffortForAgent, resolveModelForAgent } from '../../agent/models.ts';
import {
  DEFAULT_PROJECT_FILE_TYPES,
  defaultProjectSettings,
  normalizeProjectSettings,
  type ProjectService,
} from '../../agent/project-service.ts';
import type {
  ProjectCapabilities,
  ProjectLibrarianProvider,
  ProjectSettings,
  ProjectSummary,
} from '../../agent/types.ts';
import { AGENT_LABEL } from './providers.ts';

export interface ProjectSettingsPaneDeps {
  /** 통합 전에는 없을 수 있어 매번 묻는다. */
  service(): ProjectService | null;
  isConnected(): boolean;
  onDirtyChange(): void;
}

export interface ProjectSettingsPane {
  element: HTMLElement;
  open(): void;
  isDirty(): boolean;
  apply(): Promise<boolean>;
  cancel(): void;
  setConnected(connected: boolean): void;
  dispose(): void;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function group(title: string): { root: HTMLElement; body: HTMLElement } {
  const root = el('section', 'ag-settings-group ag-pset-group');
  const heading = el('div', 'ag-settings-group-heading');
  heading.append(el('h2', 'ag-settings-group-title', title));
  const body = el('div', 'ag-settings-group-body');
  root.append(heading, body);
  return { root, body };
}

/** 라벨(+선택 설명)과 오른쪽 컨트롤 한 줄. */
function row(label: string, control?: HTMLElement): { root: HTMLElement; copy: HTMLElement; description: HTMLElement } {
  const root = el('div', 'ag-pset-row');
  const copy = el('div', 'ag-pset-copy');
  copy.append(el('span', 'ag-settings-control-label', label));
  const description = el('span', 'ag-settings-control-description');
  description.hidden = true;
  copy.append(description);
  root.append(copy);
  if (control) root.append(control);
  return { root, copy, description };
}

function toggle(label: string): { root: HTMLElement; input: HTMLInputElement; description: HTMLElement } {
  const input = el('input', 'ag-settings-toggle-input');
  input.type = 'checkbox';
  input.setAttribute('role', 'switch');
  input.setAttribute('aria-label', label);
  const track = el('span', 'ag-settings-toggle-track');
  track.setAttribute('aria-hidden', 'true');
  const wrap = el('label', 'ag-pset-switch');
  wrap.append(input, track);
  const line = row(label, wrap);
  line.root.classList.add('ag-pset-toggle-row');
  line.root.addEventListener('click', (event) => {
    if (event.target === line.root || line.copy.contains(event.target as Node)) {
      if (!input.disabled) input.click();
    }
  });
  return { root: line.root, input, description: line.description };
}

function segmented<T extends string | number>(
  label: string,
  options: ReadonlyArray<{ value: T; label: string }>,
  onPick: (value: T) => void,
): { root: HTMLElement; set(value: T): void; setDisabled(disabled: boolean): void } {
  const choices = el('div', 'ag-settings-segmented');
  choices.setAttribute('role', 'radiogroup');
  choices.setAttribute('aria-label', label);
  const buttons = options.map((option) => {
    const choice = el('button', 'ag-settings-segment', option.label);
    choice.type = 'button';
    choice.setAttribute('role', 'radio');
    choice.addEventListener('click', () => onPick(option.value));
    choices.append(choice);
    return { value: option.value, choice };
  });
  choices.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const index = buttons.findIndex((entry) => entry.choice.classList.contains('ag-active'));
    const next = buttons[(index + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length];
    onPick(next.value);
    next.choice.focus();
  });
  return {
    root: row(label, choices).root,
    set(value) {
      for (const entry of buttons) {
        const active = entry.value === value;
        entry.choice.classList.toggle('ag-active', active);
        entry.choice.setAttribute('aria-checked', String(active));
        entry.choice.tabIndex = active ? 0 : -1;
      }
    },
    setDisabled(disabled) {
      for (const entry of buttons) entry.choice.disabled = disabled;
    },
  };
}

function select(label: string): { root: HTMLElement; select: HTMLSelectElement } {
  const control = el('select', 'ag-settings-select ag-pset-select');
  control.setAttribute('aria-label', label);
  return { root: row(label, control).root, select: control };
}

function fill(control: HTMLSelectElement, options: ReadonlyArray<{ id: string; label: string }>, value: string): void {
  control.replaceChildren(...options.map((option) => new Option(option.label, option.id)));
  if (options.some((option) => option.id === value)) control.value = value;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(0, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function clone(settings: ProjectSettings): ProjectSettings {
  return normalizeProjectSettings(JSON.parse(JSON.stringify(settings)));
}

const PROVIDERS: ReadonlyArray<{ id: ProjectLibrarianProvider; label: string }> = [
  { id: 'auto', label: '자동' },
  { id: 'chat', label: '채팅과 같은 공급자' },
  { id: 'claude', label: AGENT_LABEL.claude },
  { id: 'codex', label: AGENT_LABEL.codex },
  { id: 'pi', label: AGENT_LABEL.pi },
];

/** 토큰(확장자·폴더) 목록 편집기: 칩 + 추가 입력. */
function tokenList(options: {
  label: string;
  placeholder: string;
  normalize(value: string): string | null;
  onChange(values: string[]): void;
}): { root: HTMLElement; set(values: readonly string[]): void; setDisabled(disabled: boolean): void } {
  const root = el('div', 'ag-pset-tokens');
  const head = el('div', 'ag-pset-copy');
  head.append(el('span', 'ag-settings-control-label', options.label));
  const chips = el('div', 'ag-pset-token-list');
  chips.setAttribute('role', 'list');
  chips.setAttribute('aria-label', options.label);
  const input = el('input', 'ag-pset-token-input');
  input.placeholder = options.placeholder;
  input.setAttribute('aria-label', `${options.label} 추가`);
  root.append(head, chips);
  let values: string[] = [];
  let disabled = false;
  const render = () => {
    chips.replaceChildren();
    for (const value of values) {
      const chip = el('span', 'ag-pset-token');
      chip.setAttribute('role', 'listitem');
      chip.append(el('span', '', value));
      const remove = el('button', 'ag-pset-token-remove');
      remove.type = 'button';
      remove.disabled = disabled;
      remove.setAttribute('aria-label', `${value} 빼기`);
      remove.textContent = '×';
      remove.addEventListener('click', () => {
        values = values.filter((entry) => entry !== value);
        options.onChange(values);
        render();
        input.focus();
      });
      chip.append(remove);
      chips.append(chip);
    }
    input.disabled = disabled;
    chips.append(input);
  };
  const commit = () => {
    const parts = input.value.split(/[,\s]+/).map((part) => options.normalize(part)).filter((part): part is string => Boolean(part));
    input.value = '';
    const next = [...new Set([...values, ...parts])];
    if (next.length === values.length) return;
    values = next;
    options.onChange(values);
    render();
    chips.querySelector<HTMLInputElement>('.ag-pset-token-input')?.focus();
  };
  input.addEventListener('keydown', (event) => {
    if ((event.key === 'Enter' || event.key === ',') && !event.isComposing) {
      event.preventDefault();
      commit();
    } else if (event.key === 'Backspace' && !input.value && values.length) {
      values = values.slice(0, -1);
      options.onChange(values);
      render();
      chips.querySelector<HTMLInputElement>('.ag-pset-token-input')?.focus();
    }
  });
  input.addEventListener('blur', commit);
  return {
    root,
    set(next) {
      values = [...next];
      render();
    },
    setDisabled(next) {
      disabled = next;
      render();
    },
  };
}

export function createProjectSettingsPane(deps: ProjectSettingsPaneDeps): ProjectSettingsPane {
  let baseline: ProjectSettings | null = null;
  let draft: ProjectSettings = defaultProjectSettings();
  let capabilities: ProjectCapabilities = { homeAccess: false, platform: 'browser' };
  let projects: ProjectSummary[] = [];
  let loading = false;
  let saving = false;
  let connected = deps.isConnected();
  let loadError = '';
  let disposed = false;

  const element = el('div', 'ag-settings-destination-content ag-settings-project-content');
  const notice = el('p', 'ag-pset-notice');
  notice.hidden = true;
  notice.setAttribute('role', 'status');

  // ── 1. 정리 도우미 ──
  const librarian = group('정리 도우미');
  const enabled = toggle('사용');
  const provider = select('공급자');
  const model = select('모델');
  const effort = select('추론 강도');
  const rename = toggle('이름 바꾸기');
  const classify = toggle('분류');
  const link = toggle('연결');
  const concurrency = segmented('동시 실행', [1, 2, 3, 4].map((value) => ({ value, label: String(value) })), (value) => {
    draft.librarian.concurrency = value as 1 | 2 | 3 | 4;
    changed();
  });
  librarian.body.append(enabled.root, provider.root, model.root, effort.root, rename.root, classify.root, link.root, concurrency.root);

  // ── 2. 가져오기 ──
  const ingest = group('가져오기');
  const homeSearch = toggle('홈 폴더 검색');
  const fileTypes = tokenList({
    label: '파일 형식',
    placeholder: '확장자 추가',
    normalize: (value) => {
      const type = value.trim().replace(/^\*?\./, '').toLowerCase();
      return /^[a-z0-9]{1,8}$/.test(type) ? type : null;
    },
    onChange: (values) => {
      draft.ingest.fileTypes = values;
      changed();
    },
  });
  const resetTypes = el('button', 'ag-settings-btn ag-pset-inline-btn', '기본값');
  resetTypes.type = 'button';
  resetTypes.addEventListener('click', () => {
    draft.ingest.fileTypes = [...DEFAULT_PROJECT_FILE_TYPES];
    changed();
  });
  fileTypes.root.querySelector('.ag-pset-copy')?.append(resetTypes);
  const excluded = tokenList({
    label: '제외 폴더',
    placeholder: '~/폴더',
    normalize: (value) => {
      const folder = value.trim().replace(/\/+$/, '');
      if (!folder) return null;
      return folder.startsWith('~/') ? folder : `~/${folder.replace(/^\/+/, '')}`;
    },
    onChange: (values) => {
      draft.ingest.excludedFolders = values;
      changed();
    },
  });
  const maxSizeInput = el('input', 'ag-settings-number-input');
  maxSizeInput.type = 'number';
  maxSizeInput.min = '1';
  maxSizeInput.max = '100';
  maxSizeInput.setAttribute('aria-label', '최대 파일 크기 (MB)');
  const maxSizeField = el('span', 'ag-settings-number-field');
  maxSizeField.append(maxSizeInput, el('span', 'ag-settings-number-unit', 'MB'));
  const maxSize = row('최대 파일 크기', maxSizeField);
  ingest.body.append(homeSearch.root, fileTypes.root, excluded.root, maxSize.root);

  // ── 3. 에이전트 ──
  const agent = group('에이전트');
  const chatMayEdit = toggle('채팅에서 프로젝트 변경');
  const summary = segmented('턴마다 요약 크기', [
    { value: 'small', label: '작게' },
    { value: 'medium', label: '보통' },
    { value: 'large', label: '크게' },
  ] as const, (value) => {
    draft.agent.summarySize = value;
    changed();
  });
  agent.body.append(chatMayEdit.root, summary.root);

  // ── 4. 보드 ──
  const board = group('보드');
  const columnsRoot = el('div', 'ag-pset-columns');
  const columnsHead = el('div', 'ag-pset-copy');
  columnsHead.append(el('span', 'ag-settings-control-label', '새 프로젝트의 열'));
  const columnsList = el('ol', 'ag-pset-column-list');
  const addColumn = el('button', 'ag-settings-btn ag-pset-inline-btn', '열 추가');
  addColumn.type = 'button';
  columnsHead.append(addColumn);
  columnsRoot.append(columnsHead, columnsList);
  const trashDays = segmented('휴지통 보관', [
    { value: 7, label: '7일' },
    { value: 30, label: '30일' },
    { value: 90, label: '90일' },
  ] as const, (value) => {
    draft.board.trashDays = value;
    changed();
  });
  board.body.append(columnsRoot, trashDays.root);

  // ── 5. 저장 공간 ──
  const storage = group('저장 공간');
  const storageList = el('div', 'ag-pset-storage');
  storage.body.append(storageList);

  const status = el('p', 'ag-settings-apply-status');
  status.hidden = true;
  status.setAttribute('role', 'status');
  const cancel = el('button', 'ag-settings-btn', '취소');
  cancel.type = 'button';
  const apply = el('button', 'ag-settings-primary', '적용');
  apply.type = 'button';
  const footer = el('div', 'ag-settings-apply-footer');
  footer.append(status, cancel, apply);

  element.append(notice, librarian.root, ingest.root, agent.root, board.root, storage.root, footer);

  // ── 초안 ──

  function isDirty(): boolean {
    return baseline !== null && JSON.stringify(normalizeProjectSettings(draft)) !== JSON.stringify(baseline);
  }

  function changed(): void {
    status.hidden = true;
    render();
    deps.onDirtyChange();
  }

  function catalogAgent(): 'claude' | 'codex' | 'pi' | null {
    const value = draft.librarian.provider;
    return value === 'auto' || value === 'chat' ? null : value;
  }

  function renderModel(): void {
    fill(provider.select, PROVIDERS, draft.librarian.provider);
    const agentName = catalogAgent();
    model.root.hidden = agentName === null;
    effort.root.hidden = agentName === null;
    if (!agentName) return;
    const models = modelsForAgent(agentName).map((entry) => ({ id: entry.id, label: entry.label }));
    const current = draft.librarian.model ?? resolveModelForAgent(agentName, null);
    if (current && !models.some((entry) => entry.id === current)) models.unshift({ id: current, label: current });
    fill(model.select, models, current);
    const efforts = [...effortsForAgent(agentName, current)].reverse();
    effort.root.hidden = efforts.length === 0;
    fill(effort.select, efforts, resolveEffortForAgent(agentName, draft.librarian.effort, current));
  }

  function renderColumns(): void {
    const disabled = !editable();
    columnsList.replaceChildren();
    draft.board.defaultColumns.forEach((name, index) => {
      const item = el('li', 'ag-pset-column');
      const input = el('input', 'ag-pset-column-input');
      input.value = name;
      input.maxLength = 40;
      input.disabled = disabled;
      input.setAttribute('aria-label', `${index + 1}번째 열 이름`);
      input.addEventListener('change', () => {
        const value = input.value.trim();
        if (value) draft.board.defaultColumns[index] = value;
        else draft.board.defaultColumns.splice(index, 1);
        changed();
      });
      const remove = el('button', 'ag-pset-token-remove');
      remove.type = 'button';
      remove.textContent = '×';
      remove.disabled = disabled || draft.board.defaultColumns.length <= 1;
      remove.setAttribute('aria-label', `${name} 열 빼기`);
      remove.addEventListener('click', () => {
        draft.board.defaultColumns.splice(index, 1);
        changed();
      });
      item.append(input, remove);
      columnsList.append(item);
    });
    addColumn.disabled = disabled || draft.board.defaultColumns.length >= 12;
  }

  function projectLabel(project: ProjectSummary): string {
    if (project.name) return project.name;
    return project.members[0]?.name ?? project.id;
  }

  function renderStorage(): void {
    storageList.replaceChildren();
    const total = projects.reduce((sum, project) => sum + project.usage.bytes, 0);
    const totalRow = row('전체', el('span', 'ag-pset-usage', `${formatBytes(total)} · 파일 ${projects.reduce((sum, project) => sum + project.usage.files, 0)}개`));
    totalRow.root.classList.add('ag-pset-total');
    storageList.append(totalRow.root);
    if (!projects.length) {
      if (loading) storageList.append(row('불러오는 중…').root);
      return;
    }
    for (const project of [...projects].sort((a, b) => b.usage.bytes - a.usage.bytes)) {
      const actions = el('div', 'ag-settings-actions ag-pset-storage-actions');
      const emptyTrash = el('button', 'ag-settings-btn', '휴지통 비우기');
      emptyTrash.type = 'button';
      const remove = el('button', 'ag-settings-btn ag-settings-danger', '삭제');
      remove.type = 'button';
      actions.append(emptyTrash, remove);
      const line = row(projectLabel(project), actions);
      line.description.hidden = false;
      line.description.textContent = `${formatBytes(project.usage.bytes)} · 파일 ${project.usage.files}개`;
      emptyTrash.disabled = !connected;
      remove.disabled = !connected;
      emptyTrash.addEventListener('click', async () => {
        const service = deps.service();
        if (!service) return;
        if (!await confirmSheet(emptyTrash, '휴지통 비우기', `${projectLabel(project)}의 휴지통 항목을 영구히 삭제합니다.`, { confirmLabel: '비우기', destructive: true })) return;
        emptyTrash.disabled = true;
        try {
          await service.emptyTrash(project.id);
          showStatus('휴지통을 비웠습니다.');
          await loadProjects();
        } catch (error) {
          emptyTrash.disabled = false;
          showStatus(error instanceof Error ? error.message : String(error));
        }
      });
      remove.addEventListener('click', async () => {
        const service = deps.service();
        if (!service) return;
        if (!await confirmSheet(remove, `“${projectLabel(project)}” 삭제`, `파일 ${project.usage.files}개와 노트, 보드를 삭제합니다. 문서는 그대로 둡니다.`, { confirmLabel: '삭제', destructive: true })) return;
        remove.disabled = true;
        try {
          await service.remove(project.id);
          showStatus(`“${projectLabel(project)}”을 삭제했습니다.`);
          await loadProjects();
        } catch (error) {
          remove.disabled = false;
          showStatus(error instanceof Error ? error.message : String(error));
        }
      });
      storageList.append(line.root);
    }
  }

  function editable(): boolean {
    return connected && baseline !== null && !saving && deps.service() !== null;
  }

  function render(): void {
    const disabled = !editable();
    notice.hidden = !(loadError || !connected || (!loading && baseline === null));
    notice.textContent = loadError || (!connected ? '허브 연결 대기' : baseline === null ? '프로젝트 설정을 불러오지 못했습니다.' : '');
    enabled.input.checked = draft.librarian.enabled;
    enabled.input.disabled = disabled;
    renderModel();
    for (const control of [provider.select, model.select, effort.select]) control.disabled = disabled || !draft.librarian.enabled;
    rename.input.checked = draft.librarian.actions.rename;
    classify.input.checked = draft.librarian.actions.classify;
    link.input.checked = draft.librarian.actions.link;
    for (const entry of [rename, classify, link]) entry.input.disabled = disabled || !draft.librarian.enabled;
    concurrency.set(draft.librarian.concurrency);
    concurrency.setDisabled(disabled || !draft.librarian.enabled);

    homeSearch.input.checked = capabilities.homeAccess && draft.ingest.homeSearch;
    homeSearch.input.disabled = disabled || !capabilities.homeAccess;
    homeSearch.description.hidden = false;
    homeSearch.description.textContent = capabilities.homeAccess
      ? '파일 이름과 내용이 AI 제공자에게 전달됩니다.'
      : '데스크톱 앱에서 사용 가능';
    fileTypes.set(draft.ingest.fileTypes);
    fileTypes.setDisabled(disabled);
    resetTypes.disabled = disabled;
    excluded.set(draft.ingest.excludedFolders);
    excluded.setDisabled(disabled || !capabilities.homeAccess);
    excluded.root.hidden = !capabilities.homeAccess;
    if (document.activeElement !== maxSizeInput) maxSizeInput.value = String(draft.ingest.maxFileMb);
    maxSizeInput.disabled = disabled;

    chatMayEdit.input.checked = draft.agent.chatMayEdit;
    chatMayEdit.input.disabled = disabled;
    summary.set(draft.agent.summarySize);
    summary.setDisabled(disabled);
    renderColumns();
    trashDays.set(draft.board.trashDays);
    trashDays.setDisabled(disabled);

    const dirty = isDirty();
    apply.disabled = !dirty || disabled;
    cancel.disabled = !dirty || saving;
  }

  function showStatus(message: string): void {
    status.textContent = message;
    status.hidden = !message;
  }

  enabled.input.addEventListener('change', () => {
    draft.librarian.enabled = enabled.input.checked;
    changed();
  });
  provider.select.addEventListener('change', () => {
    const value = provider.select.value as ProjectLibrarianProvider;
    draft.librarian.provider = value;
    if (value === 'auto' || value === 'chat') {
      draft.librarian.model = null;
      draft.librarian.effort = null;
    } else {
      draft.librarian.model = resolveModelForAgent(value, null) || null;
      draft.librarian.effort = resolveEffortForAgent(value, null, draft.librarian.model) || null;
    }
    changed();
  });
  model.select.addEventListener('change', () => {
    const agentName = catalogAgent();
    draft.librarian.model = model.select.value || null;
    if (agentName) draft.librarian.effort = resolveEffortForAgent(agentName, draft.librarian.effort, draft.librarian.model) || null;
    changed();
  });
  effort.select.addEventListener('change', () => {
    draft.librarian.effort = effort.select.value || null;
    changed();
  });
  for (const [entry, key] of [[rename, 'rename'], [classify, 'classify'], [link, 'link']] as const) {
    entry.input.addEventListener('change', () => {
      draft.librarian.actions[key] = entry.input.checked;
      changed();
    });
  }
  homeSearch.input.addEventListener('change', () => {
    draft.ingest.homeSearch = homeSearch.input.checked;
    changed();
  });
  maxSizeInput.addEventListener('change', () => {
    const value = Math.round(Number(maxSizeInput.value));
    draft.ingest.maxFileMb = Number.isFinite(value) ? Math.min(100, Math.max(1, value)) : draft.ingest.maxFileMb;
    maxSizeInput.value = String(draft.ingest.maxFileMb);
    changed();
  });
  chatMayEdit.input.addEventListener('change', () => {
    draft.agent.chatMayEdit = chatMayEdit.input.checked;
    changed();
  });
  addColumn.addEventListener('click', () => {
    draft.board.defaultColumns.push('새 열');
    changed();
    const inputs = columnsList.querySelectorAll<HTMLInputElement>('.ag-pset-column-input');
    const last = inputs[inputs.length - 1];
    last?.focus();
    last?.select();
  });
  apply.addEventListener('click', () => void applyDraft());
  cancel.addEventListener('click', () => cancelDraft());

  async function load(): Promise<void> {
    const service = deps.service();
    if (!service || !connected || loading) {
      render();
      return;
    }
    loading = true;
    loadError = '';
    render();
    try {
      const payload = await service.getSettings();
      if (disposed) return;
      capabilities = payload.capabilities;
      if (!isDirty()) {
        baseline = clone(payload.settings);
        draft = clone(payload.settings);
      }
    } catch (error) {
      loadError = error instanceof Error ? error.message : String(error);
    } finally {
      loading = false;
      if (!disposed) {
        render();
        deps.onDirtyChange();
      }
    }
    await loadProjects();
  }

  async function loadProjects(): Promise<void> {
    const service = deps.service();
    if (!service || !connected) return;
    try {
      projects = await service.list();
    } catch {
      projects = [];
    }
    if (!disposed) renderStorage();
  }

  async function applyDraft(): Promise<boolean> {
    const service = deps.service();
    if (!isDirty()) return true;
    if (!service || !connected) {
      showStatus('허브 연결 대기');
      return false;
    }
    saving = true;
    render();
    try {
      const payload = await service.saveSettings(normalizeProjectSettings(draft));
      capabilities = payload.capabilities;
      baseline = clone(payload.settings);
      draft = clone(payload.settings);
      showStatus('프로젝트 설정을 적용했습니다.');
      return true;
    } catch (error) {
      showStatus(`적용하지 못했습니다 · ${error instanceof Error ? error.message : String(error)}`);
      return false;
    } finally {
      saving = false;
      if (!disposed) {
        render();
        deps.onDirtyChange();
      }
    }
  }

  function cancelDraft(): void {
    if (baseline) draft = clone(baseline);
    showStatus('');
    render();
    deps.onDirtyChange();
  }

  render();
  renderStorage();

  return {
    element,
    open() {
      void load();
    },
    isDirty,
    apply: applyDraft,
    cancel: cancelDraft,
    setConnected(next) {
      if (connected === next) return;
      connected = next;
      render();
      renderStorage();
      if (next && baseline === null) void load();
    },
    dispose() {
      disposed = true;
    },
  };
}
