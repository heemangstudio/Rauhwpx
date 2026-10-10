import assert from 'node:assert/strict';
import test from 'node:test';
import type { ThreadTaskRecord } from '../src/agent/threads.ts';

/* DOM 없이 편대 카드를 검증하는 최소 노드. 실제 Element 와 같은 형태만 흉내낸다. */
class FakeNode {
  tagName: string;
  className = '';
  attrs: Record<string, string> = {};
  children: FakeNode[] = [];
  parentNode: FakeNode | null = null;
  listeners: Record<string, Array<() => void>> = {};
  hidden = false;
  disabled = false;
  type = '';
  own = '';
  classList: {
    add: (...names: string[]) => void;
    remove: (...names: string[]) => void;
    toggle: (name: string, force?: boolean) => boolean;
    contains: (name: string) => boolean;
  };

  constructor(tag: string) {
    this.tagName = tag.toUpperCase();
    const names = (): string[] => this.className.split(/\s+/).filter(Boolean);
    this.classList = {
      add: (...add: string[]) => {
        const set = new Set([...names(), ...add]);
        this.className = [...set].join(' ');
      },
      remove: (...drop: string[]) => {
        this.className = names().filter((name) => !drop.includes(name)).join(' ');
      },
      toggle: (name: string, force?: boolean) => {
        const on = force === undefined ? !names().includes(name) : force;
        if (on) this.classList.add(name);
        else this.classList.remove(name);
        return on;
      },
      contains: (name: string) => names().includes(name),
    };
  }

  get textContent(): string {
    if (this.children.length === 0) return this.own;
    return this.children.map((child) => child.textContent).join('');
  }

  set textContent(value: string) {
    this.children = [];
    this.own = value;
  }

  appendChild(child: FakeNode): FakeNode {
    child.parentNode?.removeChild(child);
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  append(...nodes: FakeNode[]): void {
    for (const node of nodes) this.appendChild(node);
  }

  removeChild(child: FakeNode): FakeNode {
    const index = this.children.indexOf(child);
    if (index >= 0) this.children.splice(index, 1);
    child.parentNode = null;
    return child;
  }

  remove(): void {
    this.parentNode?.removeChild(this);
  }

  replaceChildren(...nodes: FakeNode[]): void {
    for (const child of this.children) child.parentNode = null;
    this.own = '';
    this.children = [];
    this.append(...nodes);
  }

  setAttribute(name: string, value: string): void {
    this.attrs[name] = value;
  }

  getAttribute(name: string): string | null {
    return this.attrs[name] ?? null;
  }

  addEventListener(type: string, fn: () => void): void {
    (this.listeners[type] ??= []).push(fn);
  }

  insertBefore(child: FakeNode, reference: FakeNode | null): FakeNode {
    child.parentNode?.removeChild(child);
    child.parentNode = this;
    const index = reference ? this.children.indexOf(reference) : -1;
    if (index < 0) this.children.push(child);
    else this.children.splice(index, 0, child);
    return child;
  }

  removeEventListener(type: string, fn: () => void): void {
    this.listeners[type] = (this.listeners[type] ?? []).filter((listener) => listener !== fn);
  }

  click(): void {
    for (const fn of this.listeners['click'] ?? []) fn();
  }
}

const fakeDoc = {
  createElement: (tag: string) => new FakeNode(tag),
  createElementNS: (_ns: string, tag: string) => new FakeNode(tag),
};

// icons.ts / chevron.ts 는 전역 document 로 SVG 를 만든다.
(globalThis as Record<string, unknown>)['document'] = fakeDoc;

const { createWorkbenchAgents } = await import('../src/ui/agent-sidebar/workbench-agents.ts');

function all(node: FakeNode, className: string): FakeNode[] {
  return [node, ...node.children.flatMap((child) => all(child, className))]
    .filter((candidate) => candidate.className.split(/\s+/).includes(className));
}

function one(node: FakeNode, className: string): FakeNode {
  const found = all(node, className)[0];
  assert.ok(found, className);
  return found;
}

function task(id: string, patch: Partial<ThreadTaskRecord> = {}): ThreadTaskRecord {
  return {
    taskId: id, taskKind: 'agent', title: id, role: 'explore', workflowName: '',
    status: 'running', activity: '', summary: '', totalTokens: null, toolUses: null,
    durationMs: null, tools: [], ...patch,
  };
}

function setup(onOpenTask?: (id: string) => void) {
  const view = createWorkbenchAgents({ onOpenTask });
  return { view, root: view.element as unknown as FakeNode };
}

function select(root: FakeNode, value: string): void {
  const button = all(root, 'ag-workbench-agents-filter').find((node) => node.getAttribute('data-filter') === value);
  assert.ok(button);
  button.click();
}

function cards(root: FakeNode): FakeNode[] {
  return all(root, 'ag-workbench-agent-card');
}

function visibleCards(root: FakeNode): FakeNode[] {
  return cards(root).filter((node) => !node.hidden);
}

test('상태 필터가 실시간 종료와 실패, 중단을 반영하고 카드 자리를 보존한다', () => {
  const { view, root } = setup();
  const records = [task('running'), task('done', { status: 'completed' }), task('failed', { status: 'failed' }), task('stopped', { status: 'stopped' })];
  view.update({ threadId: 'a', tasks: records });
  const first = cards(root)[0];
  select(root, 'running');
  assert.deepEqual(visibleCards(root).map((node) => node.getAttribute('data-task-id')), ['running']);
  records[0].status = 'completed';
  records[0].summary = '표를 확인했습니다.';
  view.update({ threadId: 'a', tasks: records });
  assert.equal(cards(root)[0], first);
  assert.equal(visibleCards(root).length, 0);
  assert.equal(one(root, 'ag-workbench-agents-empty').hidden, false);
  select(root, 'finished');
  assert.equal(visibleCards(root).length, 4);
  assert.equal(one(cards(root)[2], 'ag-workbench-agent-status').textContent, '실패');
  assert.equal(one(cards(root)[3], 'ag-workbench-agent-status').textContent, '중단됨');
  view.dispose();
});

test('작업과 도구 상세가 진행 중 갱신되어도 펼침과 원본 상태를 보존한다', () => {
  const { view, root } = setup();
  const record = task('a', { tools: [{ callId: 'call', tool: 'read_document', argsJson: '{}', status: 'running', resultPreview: '', elapsedMs: null }] });
  view.update({ threadId: 'a', tasks: [record] });
  const card = cards(root)[0];
  const toggle = one(card, 'ag-workbench-agent-toggle');
  toggle.click();
  const tool = one(card, 'ag-workbench-agent-tool');
  const raw = one(tool, 'ag-workbench-agent-tool-raw') as FakeNode & { open: boolean };
  raw.open = true;
  record.activity = '본문을 확인합니다.';
  record.totalTokens = 1200;
  record.tools[0].status = 'failed';
  record.tools[0].resultPreview = '권한이 없습니다.';
  view.update({ threadId: 'a', tasks: [record] });
  assert.equal(cards(root)[0], card);
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  assert.equal(one(card, 'ag-workbench-agent-tool'), tool);
  assert.equal(raw.open, true);
  assert.equal(tool.getAttribute('data-status'), 'failed');
  assert.match(one(tool, 'ag-workbench-agent-tool-result').textContent, /권한/);
  assert.match(one(card, 'ag-workbench-agent-metrics').textContent, /1,200 토큰/);
  record.tools.push({ callId: 'stopped', tool: 'read_document', argsJson: '{}', status: 'stopped', resultPreview: '', elapsedMs: null });
  view.update({ threadId: 'a', tasks: [record] });
  assert.match(all(card, 'ag-workbench-agent-tool-result')[1].textContent, /중단/);
  toggle.click();
  assert.equal(one(card, 'ag-workbench-agent-detail').hidden, true);
  view.dispose();
});

test('숨긴 뷰는 최신 기록을 한 번 반영하고 대화 전환은 필터와 상세를 버린다', () => {
  const { view, root } = setup();
  view.update({ threadId: 'a', tasks: [task('same')] });
  const old = cards(root)[0];
  one(old, 'ag-workbench-agent-toggle').click();
  select(root, 'running');
  view.setVisible(false);
  view.update({ threadId: 'a', tasks: [task('intermediate')] });
  view.update({ threadId: 'a', tasks: [task('latest')] });
  assert.equal(cards(root)[0], old);
  view.setVisible(true);
  assert.deepEqual(cards(root).map((node) => node.getAttribute('data-task-id')), ['latest']);
  view.setVisible(false);
  view.update({ threadId: 'b', tasks: [task('same', { status: 'completed' })] });
  assert.equal(cards(root).length, 0, '이전 대화 DOM은 숨겨진 상태에서도 즉시 제거한다');
  view.setVisible(true);
  assert.equal(visibleCards(root).length, 1, '필터가 전체로 초기화된다');
  assert.notEqual(cards(root)[0], old);
  assert.equal(one(cards(root)[0], 'ag-workbench-agent-toggle').getAttribute('aria-expanded'), 'false');
  view.dispose();
});

test('대화 위치 콜백과 키 순서가 맞고 해제 뒤 이벤트와 갱신이 멈춘다', () => {
  const opened: string[] = [];
  const { view, root } = setup((id) => opened.push(id));
  const a = task('a');
  const b = task('b');
  view.update({ threadId: 'a', tasks: [a, b] });
  const card = cards(root)[0];
  const toggle = one(card, 'ag-workbench-agent-toggle');
  const open = one(card, 'ag-workbench-agent-open');
  toggle.click();
  open.click();
  assert.deepEqual(opened, ['a']);
  view.update({ threadId: 'a', tasks: [b, a] });
  assert.equal(cards(root)[1], card);
  view.update({ threadId: 'a', tasks: [b] });
  open.click();
  assert.deepEqual(opened, ['a'], '기록에서 빠진 카드의 이벤트가 해제된다');
  view.dispose();
  view.dispose();
  view.update({ threadId: 'b', tasks: [a] });
  view.setVisible(true);
  toggle.click();
  open.click();
  assert.equal(cards(root).length, 0);
  assert.deepEqual(opened, ['a']);
});
