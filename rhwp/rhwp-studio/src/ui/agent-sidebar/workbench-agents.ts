import type { ThreadTaskRecord, ThreadToolRecord } from '../../agent/threads.ts';
import { presentToolCall, presentToolResult } from './tool-presentation.ts';

type TaskStatus = ThreadTaskRecord['status'];
type TaskFilter = 'all' | 'running' | 'finished';

export interface WorkbenchAgentsOptions {
  onOpenTask?: (taskId: string) => void;
}

export interface WorkbenchAgents {
  readonly element: HTMLElement;
  update(state: { threadId: string; tasks: readonly ThreadTaskRecord[] }): void;
  setVisible(visible: boolean): void;
  dispose(): void;
}

const STATUS_LABEL: Record<TaskStatus, string> = {
  running: '진행 중', completed: '완료', failed: '실패', stopped: '중단됨',
};
const ROLE_LABEL: Record<string, string> = {
  explore: '조사', researcher: '조사', research: '조사', implement: '구현',
  implementer: '구현', worker: '작업', review: '검토', reviewer: '검토',
};

function setText(node: HTMLElement, text: string): void {
  if (node.textContent !== text) node.textContent = text;
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(Math.max(0, ms) / 1000);
  return seconds < 60 ? `${seconds}초` : `${Math.floor(seconds / 60)}분 ${seconds % 60}초`;
}

function metric(value: number | null, unit: string): string {
  return value !== null && Number.isFinite(value) && value >= 0
    ? `${Math.round(value).toLocaleString('ko-KR')} ${unit}` : '';
}

interface ToolView {
  element: HTMLElement;
  label: HTMLElement;
  summary: HTMLElement;
  status: HTMLElement;
  result: HTMLElement;
  args: HTMLElement;
  rawResult: HTMLElement;
  signature: string;
}

interface CardView {
  element: HTMLElement;
  toggle: HTMLButtonElement;
  title: HTMLElement;
  role: HTMLElement;
  status: HTMLElement;
  activity: HTMLElement;
  metrics: HTMLElement;
  detail: HTMLElement;
  summary: HTMLElement;
  tools: HTMLElement;
  noTools: HTMLElement;
  toolViews: Map<string, ToolView>;
  expanded: boolean;
  dispose(): void;
}

/** 저장된 작업 기록만 그린다. 실행과 취소는 기존 대화가 맡는다. */
export function createWorkbenchAgents(options: WorkbenchAgentsOptions = {}): WorkbenchAgents {
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] => {
    const node = document.createElement(tag);
    node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const element = el('section', 'ag-workbench-agents');
  element.setAttribute('aria-label', '서브에이전트');
  const header = el('header', 'ag-workbench-agents-header');
  const heading = el('h2', 'ag-workbench-agents-title', '서브에이전트');
  const count = el('span', 'ag-workbench-agents-count');
  header.append(heading, count);
  const filters = el('div', 'ag-workbench-agents-filters');
  filters.setAttribute('role', 'group');
  filters.setAttribute('aria-label', '작업 상태');
  const list = el('div', 'ag-workbench-agents-list');
  const empty = el('div', 'ag-workbench-agents-empty');
  const stack = el('div', 'ag-workbench-agents-empty-stack');
  stack.setAttribute('aria-hidden', 'true');
  stack.append(el('span', ''), el('span', ''), el('span', ''));
  const emptyTitle = el('p', 'ag-workbench-agents-empty-title');
  const emptyText = el('p', 'ag-workbench-agents-empty-text');
  empty.append(stack, emptyTitle, emptyText);
  element.append(header, filters, list, empty);

  let threadId: string | null = null;
  let tasks: readonly ThreadTaskRecord[] = [];
  let filter: TaskFilter = 'all';
  let visible = true;
  let disposed = false;
  const cards = new Map<string, CardView>();
  const filterButtons = new Map<TaskFilter, HTMLButtonElement>();
  const filterCleanup: Array<() => void> = [];

  for (const [value, label] of [['all', '전체'], ['running', '진행 중'], ['finished', '종료']] as const) {
    const button = el('button', 'ag-workbench-agents-filter', label);
    button.type = 'button';
    button.setAttribute('data-filter', value);
    const click = (): void => {
      if (disposed) return;
      filter = value;
      render();
    };
    button.addEventListener('click', click);
    filterCleanup.push(() => button.removeEventListener('click', click));
    filterButtons.set(value, button);
    filters.append(button);
  }

  function createCard(task: ThreadTaskRecord): CardView {
    const card = el('article', 'ag-workbench-agent-card');
    card.setAttribute('data-task-id', task.taskId);
    const toggle = el('button', 'ag-workbench-agent-toggle');
    toggle.type = 'button';
    toggle.setAttribute('aria-expanded', 'false');
    const dot = el('span', 'ag-workbench-agent-dot');
    dot.setAttribute('aria-hidden', 'true');
    const identity = el('span', 'ag-workbench-agent-identity');
    const role = el('span', 'ag-workbench-agent-role');
    const title = el('span', 'ag-workbench-agent-title');
    identity.append(role, title);
    const status = el('span', 'ag-workbench-agent-status');
    const chevron = el('span', 'ag-workbench-agent-chevron', '⌄');
    chevron.setAttribute('aria-hidden', 'true');
    toggle.append(dot, identity, status, chevron);
    const activity = el('p', 'ag-workbench-agent-activity');
    const metrics = el('p', 'ag-workbench-agent-metrics');
    const detail = el('div', 'ag-workbench-agent-detail');
    detail.hidden = true;
    detail.inert = true;
    const summary = el('p', 'ag-workbench-agent-summary');
    const tools = el('div', 'ag-workbench-agent-tools');
    const noTools = el('p', 'ag-workbench-agent-no-tools', '기록된 도구 호출이 없습니다.');
    detail.append(summary, tools, noTools);
    const listeners: Array<() => void> = [];
    if (options.onOpenTask) {
      const open = el('button', 'ag-workbench-agent-open', '대화에서 보기');
      open.type = 'button';
      const click = (): void => { if (!disposed) options.onOpenTask?.(task.taskId); };
      open.addEventListener('click', click);
      listeners.push(() => open.removeEventListener('click', click));
      detail.append(open);
    }
    card.append(toggle, activity, metrics, detail);
    const view: CardView = {
      element: card, toggle, title, role, status, activity, metrics, detail, summary, tools, noTools,
      toolViews: new Map(), expanded: false,
      dispose: () => { listeners.forEach((cleanup) => cleanup()); card.remove(); },
    };
    const click = (): void => {
      if (disposed) return;
      view.expanded = !view.expanded;
      toggle.setAttribute('aria-expanded', String(view.expanded));
      detail.hidden = !view.expanded;
      detail.inert = !view.expanded;
      if (view.expanded) updateTools(view, tasks.find((item) => item.taskId === task.taskId)?.tools ?? []);
    };
    toggle.addEventListener('click', click);
    listeners.push(() => toggle.removeEventListener('click', click));
    return view;
  }

  function updateTools(card: CardView, records: readonly ThreadToolRecord[]): void {
    const ids = new Set(records.map((tool) => tool.callId));
    for (const [id, view] of card.toolViews) {
      if (!ids.has(id)) { view.element.remove(); card.toolViews.delete(id); }
    }
    records.forEach((tool, index) => {
      let view = card.toolViews.get(tool.callId);
      if (!view) {
        const row = el('div', 'ag-workbench-agent-tool');
        row.setAttribute('data-call-id', tool.callId);
        const head = el('div', 'ag-workbench-agent-tool-head');
        const label = el('span', 'ag-workbench-agent-tool-label');
        const status = el('span', 'ag-workbench-agent-tool-status');
        head.append(label, status);
        const summary = el('p', 'ag-workbench-agent-tool-summary');
        const result = el('p', 'ag-workbench-agent-tool-result');
        const raw = el('details', 'ag-workbench-agent-tool-raw');
        const args = el('pre', '');
        const rawResult = el('pre', '');
        raw.append(el('summary', '', '원본'), args, rawResult);
        row.append(head, summary, result, raw);
        view = { element: row, label, summary, status, result, args, rawResult, signature: '' };
        card.toolViews.set(tool.callId, view);
      }
      const signature = JSON.stringify(tool);
      if (view.signature !== signature) {
        view.signature = signature;
        const call = presentToolCall(tool.tool, tool.argsJson);
        const outcome = tool.outcome ?? (tool.status === 'running' || tool.status === 'stopped' && !tool.resultPreview ? null : presentToolResult({
          tool: tool.tool, argsJson: tool.argsJson, ok: tool.status === 'completed', preview: tool.resultPreview,
        }));
        setText(view.label, outcome?.label || call.label);
        setText(view.summary, call.summary);
        view.summary.hidden = !call.summary;
        setText(view.status, [STATUS_LABEL[tool.status], tool.elapsedMs !== null ? formatDuration(tool.elapsedMs) : ''].filter(Boolean).join(' · '));
        view.element.setAttribute('data-status', tool.status);
        setText(view.result, [...new Set([outcome?.text, outcome?.detail, ...(outcome?.notices ?? []), ...(outcome?.items?.map((item) => item.text) ?? [])].filter(Boolean))].join('\n')
          || (tool.status === 'stopped' ? '결과 없이 중단됨' : ''));
        view.result.hidden = !view.result.textContent;
        setText(view.args, tool.argsJson);
        setText(view.rawResult, tool.resultPreview);
        view.rawResult.hidden = !tool.resultPreview;
      }
      if (card.tools.children[index] !== view.element) card.tools.insertBefore(view.element, card.tools.children[index] ?? null);
    });
    card.noTools.hidden = records.length > 0;
  }

  function clearCards(): void {
    cards.forEach((card) => card.dispose());
    cards.clear();
  }

  function render(): void {
    if (!visible || disposed) return;
    const unique = new Map(tasks.map((task) => [task.taskId, task]));
    for (const [id, card] of cards) {
      if (!unique.has(id)) { card.dispose(); cards.delete(id); }
    }
    const running = [...unique.values()].filter((task) => task.status === 'running').length;
    setText(count, unique.size ? `${running} 진행 중 · ${unique.size}개` : '');
    for (const [value, button] of filterButtons) button.setAttribute('aria-pressed', String(value === filter));
    let shown = 0;
    for (const task of unique.values()) {
      let card = cards.get(task.taskId);
      if (!card) { card = createCard(task); cards.set(task.taskId, card); }
      card.element.setAttribute('data-status', task.status);
      const workflow = task.taskKind === 'workflow';
      setText(card.role, workflow ? '워크플로' : ROLE_LABEL[task.role] || task.role || '에이전트');
      setText(card.title, task.title || task.workflowName || '작업');
      setText(card.status, STATUS_LABEL[task.status]);
      setText(card.activity, task.status === 'running'
        ? task.activity || '작업을 시작했습니다.'
        : task.summary || task.activity || (task.status === 'failed' ? '작업이 실패했습니다.' : task.status === 'stopped' ? '작업이 중단되었습니다.' : '작업을 마쳤습니다.'));
      card.activity.setAttribute('title', card.activity.textContent ?? '');
      const toolCount = task.toolUses ?? (task.tools.length ? task.tools.length : null);
      setText(card.metrics, [metric(toolCount, '도구'), metric(task.totalTokens, '토큰'), task.durationMs !== null ? formatDuration(task.durationMs) : ''].filter(Boolean).join(' · '));
      setText(card.summary, task.summary || task.activity);
      card.summary.hidden = !card.summary.textContent;
      if (card.expanded) updateTools(card, task.tools);
      card.element.hidden = filter === 'running' ? task.status !== 'running' : filter === 'finished' ? task.status === 'running' : false;
      if (!card.element.hidden) shown++;
    }
    [...unique.keys()].forEach((id, index) => {
      const node = cards.get(id)!.element;
      if (list.children[index] !== node) list.insertBefore(node, list.children[index] ?? null);
    });
    empty.hidden = shown > 0;
    setText(emptyTitle, unique.size === 0 ? '아직 서브에이전트가 없습니다.' : filter === 'running' ? '진행 중인 작업이 없습니다.' : '종료된 작업이 없습니다.');
    setText(emptyText, unique.size === 0 ? '이 대화에서 실행한 작업이 여기에 모입니다.' : '다른 상태의 작업은 전체에서 볼 수 있습니다.');
  }

  render();
  return {
    element,
    update: (state) => {
      if (disposed) return;
      if (threadId !== state.threadId) {
        clearCards();
        threadId = state.threadId;
        filter = 'all';
        element.scrollTop = 0;
      }
      tasks = state.tasks;
      render();
    },
    setVisible: (next) => {
      if (disposed) return;
      visible = next;
      element.hidden = !visible;
      element.inert = !visible;
      if (visible) render();
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      filterCleanup.forEach((cleanup) => cleanup());
      clearCards();
      tasks = [];
      element.remove();
    },
  };
}
