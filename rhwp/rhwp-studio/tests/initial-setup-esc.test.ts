/**
 * 첫 실행 설정 위에 뜬 연결 창에서 Esc 를 누르면 연결 창만 닫히고 설정은 이어진다. 예전에는 그 Esc 가
 * 문서까지 번져 설정을 끝냈다(completed: true) — 나머지 단계를 보지 못한 채 다시 열리지 않았다.
 * 설정을 끝내면 연결한 프로바이더가 기본값이 되고, 아직 보낸 메시지가 없는 채팅은 그 프로바이더로 선다.
 *
 * 실제 createInitialSetup 을 설정 창이 쓰는 만큼만 흉내 낸 DOM 위에서 돌린다.
 */
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

registerHooks({
  load(url, context, next) {
    return url.endsWith('.css')
      ? { format: 'module', source: 'export default {};', shortCircuit: true }
      : next(url, context);
  },
});

type Listener = (event: FakeEvent) => void;

class FakeEvent {
  defaultPrevented = false;
  propagationStopped = false;
  target: FakeNode | null = null;
  readonly type: string;
  readonly key: string;
  constructor(type: string, init: { key?: string } = {}) {
    this.type = type;
    this.key = init.key ?? '';
  }
  preventDefault() { this.defaultPrevented = true; }
  stopPropagation() { this.propagationStopped = true; }
}

class FakeNode {
  children: FakeNode[] = [];
  parentNode: FakeNode | null = null;
  attributes = new Map<string, string>();
  dataset: Record<string, string> = {};
  style: Record<string, string> & { setProperty(name: string, value: string): void } = Object.assign(
    {} as Record<string, string>,
    { setProperty() {} },
  );
  textContent = '';
  hidden = false;
  disabled = false;
  tabIndex = 0;
  title = '';
  type = '';
  src = '';
  alt = '';
  private listeners = new Map<string, Listener[]>();
  private classes = new Set<string>();
  readonly tagName: string;
  constructor(tagName: string) { this.tagName = tagName.toUpperCase(); }
  getContext() {
    return { canvas: this, fillStyle: '', clearRect() {}, fillRect() {} };
  }
  get className() { return [...this.classes].join(' '); }
  set className(value: string) { this.classes = new Set(value.split(/\s+/).filter(Boolean)); }
  classList = {
    add: (...names: string[]) => { for (const name of names) this.classes.add(name); },
    remove: (...names: string[]) => { for (const name of names) this.classes.delete(name); },
    contains: (name: string) => this.classes.has(name),
    toggle: (name: string, force?: boolean) => {
      const on = force ?? !this.classes.has(name);
      if (on) this.classes.add(name); else this.classes.delete(name);
      return on;
    },
  };
  get isConnected(): boolean {
    let node: FakeNode | null = this;
    while (node) {
      if (node === fakeDocument.body) return true;
      node = node.parentNode;
    }
    return false;
  }
  setAttribute(name: string, value: string) {
    if (name === 'class') this.className = value;
    this.attributes.set(name, String(value));
  }
  getAttribute(name: string) { return this.attributes.get(name) ?? null; }
  removeAttribute(name: string) { this.attributes.delete(name); }
  toggleAttribute(name: string, force?: boolean) {
    const on = force ?? !this.attributes.has(name);
    if (on) this.attributes.set(name, ''); else this.attributes.delete(name);
    return on;
  }
  addEventListener(type: string, listener: Listener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  removeEventListener(type: string, listener: Listener) {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((entry) => entry !== listener));
  }
  /** 문서까지 거슬러 올라가며 듣는 이를 부른다(버블링). */
  dispatchEvent(event: FakeEvent) {
    event.target ??= this;
    let node: FakeNode | null = this;
    while (node && !event.propagationStopped) {
      for (const listener of node.listeners.get(event.type) ?? []) listener(event);
      node = node.parentNode;
    }
    if (!event.propagationStopped) fakeDocument.fire(event);
    return !event.defaultPrevented;
  }
  click() { this.dispatchEvent(new FakeEvent('click')); }
  focus() { fakeDocument.activeElement = this; }
  blur() {}
  scrollIntoView() {}
  append(...nodes: Array<FakeNode | string>) {
    for (const node of nodes) {
      if (typeof node === 'string') continue;
      this.appendChild(node);
    }
  }
  appendChild(node: FakeNode) {
    node.parentNode?.removeChild(node);
    node.parentNode = this;
    this.children.push(node);
    return node;
  }
  removeChild(node: FakeNode) {
    this.children = this.children.filter((child) => child !== node);
    node.parentNode = null;
    return node;
  }
  replaceChildren(...nodes: FakeNode[]) {
    for (const child of [...this.children]) this.removeChild(child);
    this.append(...nodes);
  }
  replaceWith(next: FakeNode) {
    const parent = this.parentNode;
    if (!parent) return;
    const index = parent.children.indexOf(this);
    next.parentNode?.removeChild(next);
    parent.children.splice(index, 1, next);
    next.parentNode = parent;
    this.parentNode = null;
  }
  remove() { this.parentNode?.removeChild(this); }
  contains(node: FakeNode | null): boolean {
    for (let current = node; current; current = current.parentNode) if (current === this) return true;
    return false;
  }
  getBoundingClientRect() { return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }; }
  *walk(): Generator<FakeNode> {
    for (const child of this.children) {
      yield child;
      yield* child.walk();
    }
  }
  matches(selector: string): boolean {
    const match = /^((?:\.[\w-]+)*)(?:\[([\w-]+)="([^"]*)"\])?$/.exec(selector.trim());
    if (!match) return false;
    const classes = (match[1] ?? '').split('.').filter(Boolean);
    if (!classes.every((name) => this.classes.has(name))) return false;
    if (match[2] && this.getAttribute(match[2]) !== match[3]) return false;
    return classes.length > 0 || Boolean(match[2]);
  }
  querySelector(selector: string): FakeNode | null {
    for (const node of this.walk()) if (node.matches(selector)) return node;
    return null;
  }
  querySelectorAll(selector: string): FakeNode[] {
    return [...this.walk()].filter((node) => node.matches(selector));
  }
}

const documentListeners = new Map<string, Listener[]>();
const fakeDocument = {
  body: new FakeNode('body'),
  documentElement: new FakeNode('html'),
  activeElement: null as FakeNode | null,
  visibilityState: 'visible',
  createElement: (tag: string) => new FakeNode(tag),
  createElementNS: (_ns: string, tag: string) => new FakeNode(tag),
  createTextNode: (text: string) => Object.assign(new FakeNode('#text'), { textContent: text }),
  getElementById: () => null,
  querySelector: (selector: string) => fakeDocument.body.querySelector(selector),
  querySelectorAll: (selector: string) => fakeDocument.body.querySelectorAll(selector),
  addEventListener(type: string, listener: Listener) {
    documentListeners.set(type, [...(documentListeners.get(type) ?? []), listener]);
  },
  removeEventListener(type: string, listener: Listener) {
    documentListeners.set(type, (documentListeners.get(type) ?? []).filter((entry) => entry !== listener));
  },
  fire(event: FakeEvent) {
    for (const listener of documentListeners.get(event.type) ?? []) listener(event);
  },
};

Object.defineProperty(globalThis, 'document', { configurable: true, value: fakeDocument });
Object.defineProperty(globalThis, 'window', {
  configurable: true,
  value: {
    setTimeout: (fn: () => void, ms?: number) => setTimeout(fn, ms),
    clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
    setInterval: (fn: () => void, ms?: number) => setInterval(fn, ms),
    clearInterval: (id: ReturnType<typeof setInterval>) => clearInterval(id),
    addEventListener() {},
    removeEventListener() {},
    matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }),
    open() {},
  },
});
Object.defineProperty(globalThis, 'requestAnimationFrame', {
  configurable: true,
  value: (fn: () => void) => setTimeout(fn, 0),
});
Object.defineProperty(globalThis, 'getComputedStyle', {
  configurable: true,
  value: () => ({ getPropertyValue: () => '' }),
});
Object.defineProperty(globalThis, 'HTMLElement', { configurable: true, value: FakeNode });
Object.defineProperty(globalThis, 'HTMLButtonElement', { configurable: true, value: FakeNode });

const { createInitialSetup, firstRunAgentForChat } = await import('../src/ui/initial-setup/initial-setup.ts');
const { INITIAL_SETUP_STORAGE_KEY } = await import('../src/ui/initial-setup/state.ts');
const { loadAgentPrefs } = await import('../src/agent/agent-prefs.ts');
type AgentName = import('../src/agent/types.ts').AgentName;
type AgentSetupStatus = import('../src/agent/types.ts').AgentSetupStatus;

function memoryStore() {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value); },
    removeItem: (key: string) => { store.delete(key); },
  };
}

function status(agent: AgentName, partial: Partial<AgentSetupStatus> = {}): AgentSetupStatus {
  return {
    agent, available: false, connected: false, installed: false, installing: false, version: null,
    authenticated: false, authMethod: null, keyTail: null, authenticating: false, setupComplete: false,
    latestVersion: null, updateRequired: false, error: null, ...partial,
  } as AgentSetupStatus;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

async function openWizard(tier?: 'hama' | 'rau') {
  const storage = memoryStore();
  let finished = 0;
  const ui = createInitialSetup({
    openAgentSetup: () => {},
    storage,
    detectFontStep: async () => null,
    plan: tier ? { api: null, status: () => ({ tier, signedIn: true }), subscribe: () => () => {}, dispose() {} } as never : undefined,
    onFinished: () => { finished += 1; },
  });
  ui.open();
  await tick();
  await tick();
  const record = () => JSON.parse(storage.getItem(INITIAL_SETUP_STORAGE_KEY) ?? '{}') as { completed?: boolean };
  return { ui, storage, record, finished: () => finished };
}

/** 설정 모달의 연결 창처럼 본문에 뜨고, 자기 Esc 를 처리하는 창. */
function openConnectDialog() {
  const overlay = new FakeNode('div');
  overlay.className = 'ag-agent-setup-overlay ag-open';
  overlay.setAttribute('aria-hidden', 'false');
  const field = new FakeNode('input');
  overlay.appendChild(field);
  fakeDocument.body.appendChild(overlay);
  overlay.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    overlay.classList.remove('ag-open');
    overlay.setAttribute('aria-hidden', 'true');
  });
  return { overlay, field };
}

test('Esc in the provider connect dialog closes only that dialog; the first-run setup stays open and unfinished', async () => {
  const { ui, record, finished } = await openWizard();
  const { overlay, field } = openConnectDialog();
  field.dispatchEvent(new FakeEvent('keydown', { key: 'Escape' }));
  assert.equal(overlay.getAttribute('aria-hidden'), 'true', 'the connect dialog closed');
  assert.equal(ui.element.isConnected, true, 'the setup is still on screen');
  assert.equal(ui.element.classList.contains('rhwp-setup-open'), true);
  assert.notEqual(record().completed, true, 'the setup is not saved as completed');
  assert.equal(finished(), 0);

  // 연결 창이 열린 채 다른 곳에서 누른 Esc 도 그 창의 것이다.
  overlay.setAttribute('aria-hidden', 'false');
  fakeDocument.body.dispatchEvent(new FakeEvent('keydown', { key: 'Escape' }));
  assert.notEqual(record().completed, true);

  // 연결 창이 닫힌 뒤의 Esc 는 예전처럼 설정을 끝낸다(나중에).
  overlay.remove();
  fakeDocument.body.dispatchEvent(new FakeEvent('keydown', { key: 'Escape' }));
  assert.equal(record().completed, true);
  assert.equal(finished(), 1);
  ui.dispose();
});

test('finishing first-run setup with only Codex connected makes Codex the provider of the untouched chat, not of a started one', async () => {
  const { ui, storage, finished } = await openWizard('hama');
  ui.handleEvent({
    type: 'agent-setup-status',
    statuses: { claude: status('claude'), codex: status('codex', { available: true, installed: true, authenticated: true, connected: true }), pi: status('pi') },
  } as never);
  // 안내 → 테마 → AI 경로 → 선택적 연결 → 홈.
  const primary = ui.element.querySelector('.rhwp-setup-primary');
  assert.ok(primary);
  primary.click();
  await tick();
  primary.click();
  await tick();
  ui.element.querySelectorAll('.rhwp-setup-path')[1]!.click();
  await tick();
  primary.click();
  await tick();
  assert.equal(finished(), 1, 'the setup finished');

  const prefs = loadAgentPrefs(storage);
  assert.equal(prefs.defaultAgent, 'codex', 'the connected provider became the default');
  // 사이드바가 끝난 뒤 세울 프로바이더 — 아직 보낸 메시지 없는 채팅은 Codex 로, 시작한 채팅은 그대로.
  const untouched = { selectedAgent: 'claude' as AgentName, userMessages: 0, working: false, readOnly: false };
  assert.equal(firstRunAgentForChat(prefs.defaultAgent, untouched), 'codex');
  assert.equal(firstRunAgentForChat(prefs.defaultAgent, { ...untouched, userMessages: 1 }), null);
  assert.equal(firstRunAgentForChat(prefs.defaultAgent, { ...untouched, working: true }), null);
  assert.equal(firstRunAgentForChat(prefs.defaultAgent, { ...untouched, selectedAgent: 'codex' }), null);
  ui.dispose();
});


test('Rau subscribers who skip provider connection see the Rau introduction and keep the regular default agent', async () => {
  const { ui, storage, finished } = await openWizard('rau');
  const primary = ui.element.querySelector('.rhwp-setup-primary')!;
  primary.click();
  await tick();
  primary.click();
  await tick();
  ui.element.querySelectorAll('.rhwp-setup-path')[1]!.click();
  await tick();
  primary.click();
  await tick();
  assert.equal(ui.element.querySelector('.rhwp-setup-dialog')!.dataset.step, 'rau');
  primary.click();
  await tick();
  assert.equal(finished(), 1);
  assert.equal(loadAgentPrefs(storage).defaultAgent, 'claude');
  ui.dispose();
});
