import test from 'node:test';
import assert from 'node:assert/strict';
import type { UserQuestionInteraction } from '../src/agent/types.ts';

/* DOM 없이 질문 카드를 움직여 보는 최소 노드. 컨트롤러가 쓰는 Element 모양만 흉내낸다. */
class FakeElement {
  tagName: string;
  className = '';
  id = '';
  type = '';
  title = '';
  placeholder = '';
  value = '';
  maxLength = -1;
  tabIndex = 0;
  disabled = false;
  own = '';
  dataset: Record<string, string> = {};
  attrs: Record<string, string> = {};
  children: FakeElement[] = [];
  parent: FakeElement | null = null;
  connected = false;
  listeners: Record<string, Array<(event: unknown) => void>> = {};

  constructor(tag: string) {
    this.tagName = tag.toUpperCase();
  }

  get isConnected(): boolean {
    for (let node: FakeElement | null = this; node; node = node.parent) if (node.connected) return true;
    return false;
  }

  get textContent(): string {
    return this.children.length ? this.children.map((child) => child.textContent).join('') : this.own;
  }

  set textContent(value: string) {
    this.children = [];
    this.own = value;
  }

  get firstElementChild(): FakeElement | null { return this.children[0] ?? null; }
  get lastElementChild(): FakeElement | null { return this.children.at(-1) ?? null; }

  appendChild(child: FakeElement): FakeElement {
    child.parent?.children.splice(child.parent.children.indexOf(child), 1);
    child.parent = this;
    this.children.push(child);
    return child;
  }

  append(...nodes: FakeElement[]): void { for (const node of nodes) this.appendChild(node); }

  replaceChildren(...nodes: FakeElement[]): void {
    for (const child of this.children) child.parent = null;
    this.children = [];
    this.own = '';
    this.append(...nodes);
  }

  remove(): void {
    if (!this.parent) return;
    this.parent.children.splice(this.parent.children.indexOf(this), 1);
    this.parent = null;
  }

  setAttribute(name: string, value: string): void { this.attrs[name] = value; }
  getAttribute(name: string): string | null { return this.attrs[name] ?? null; }
  removeAttribute(name: string): void { delete this.attrs[name]; }

  addEventListener(type: string, fn: (event: unknown) => void): void {
    (this.listeners[type] ??= []).push(fn);
  }

  dispatchEvent(event: { type: string }): boolean {
    for (const fn of this.listeners[event.type] ?? []) fn(event);
    return true;
  }

  click(): void { if (!this.disabled) this.dispatchEvent({ type: 'click' }); }

  focus(): void { fakeDocument.activeElement = this; }

  /** 컨트롤러가 묻는 선택자 두 가지만 안다: '.클래스' 와 편집 가능한 칸 목록. */
  closest(selector: string): FakeElement | null {
    for (let node: FakeElement | null = this; node; node = node.parent) {
      if (selector.startsWith('.') ? node.classes().includes(selector.slice(1))
        : ['INPUT', 'TEXTAREA', 'SELECT'].includes(node.tagName)) return node;
    }
    return null;
  }

  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  querySelectorAll(selector: string): FakeElement[] {
    const [className, attr] = selector.slice(1).split('[');
    const out: FakeElement[] = [];
    const walk = (node: FakeElement) => {
      for (const child of node.children) {
        const [key, value] = attr ? attr.replace(/\]$/, '').split('=') : [];
        const attrOk = !attr || child.dataset[key!.replace(/^data-/, '')] === value!.replace(/"/g, '');
        if (child.classes().includes(className!) && attrOk) out.push(child);
        walk(child);
      }
    };
    walk(this);
    return out;
  }

  classes(): string[] { return this.className.split(/\s+/).filter(Boolean); }
}

const documentListeners: Record<string, Array<(event: unknown) => void>> = {};
const body = new FakeElement('body');
body.connected = true;
const fakeDocument = {
  activeElement: body as FakeElement,
  body,
  createElement: (tag: string) => new FakeElement(tag),
  addEventListener(type: string, fn: (event: unknown) => void) { (documentListeners[type] ??= []).push(fn); },
  removeEventListener(type: string, fn: (event: unknown) => void) {
    documentListeners[type] = (documentListeners[type] ?? []).filter((listener) => listener !== fn);
  },
};
Object.assign(globalThis, {
  document: fakeDocument,
  HTMLElement: FakeElement,
  window: { setTimeout, clearTimeout, matchMedia: () => ({ matches: true }) },
});

const { createUserQuestionController } = await import('../src/ui/agent-sidebar/user-question-controller.ts');

const interaction: UserQuestionInteraction = {
  interactionId: 'q-1',
  providerRequestId: 'r-1',
  threadId: 't-1',
  turnId: 'turn-1',
  agent: 'claude',
  source: 'native',
  createdAt: '2026-10-10T00:00:00Z',
  updatedAt: '2026-10-10T00:00:00Z',
  questions: [{
    id: 'tone',
    header: '문체',
    question: '어떤 문체로 다듬을까요?',
    mode: 'single',
    allowOther: true,
    options: [
      { id: 'formal', label: '공식적인 문체', description: '' },
      { id: 'friendly', label: '친근한 문체', description: '' },
    ],
  }],
};

/** 사람이 누른 숫자 키. target 은 키가 떨어진 곳이다. */
function pressDigit(digit: string, target: FakeElement): { prevented: boolean } {
  const event = { key: digit, target, prevented: false, preventDefault() { this.prevented = true; } };
  for (const listener of documentListeners.keydown ?? []) listener(event);
  return event;
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function mount(options: { canTakeFocus?: () => boolean } = {}) {
  const composer = new FakeElement('textarea');
  body.appendChild(composer);
  const modes: Array<[boolean, boolean]> = [];
  const submitted: unknown[] = [];
  let arrivalOpens = 0;
  const controller = createUserQuestionController({
    input: composer as unknown as HTMLTextAreaElement,
    submitAnswers: (interactionId, answers) => {
      submitted.push({ interactionId, answers });
      return 'response-1';
    },
    stop: () => {},
    onDraftChange: () => {},
    onComposerModeChange: (active, usesOther) => { modes.push([active, usesOther]); },
    onResolved: () => {},
    canTakeFocus: options.canTakeFocus,
    onArrivalOpen: () => { arrivalOpens += 1; },
  });
  const root = controller.root as unknown as FakeElement;
  body.appendChild(root);
  return {
    composer, controller, root, modes, submitted,
    arrivalOpens: () => arrivalOpens,
    selected: () => root.querySelectorAll('.ag-question-option[data-selected="true"]').length,
    cleanup: () => { controller.dispose(); composer.remove(); fakeDocument.activeElement = body; },
  };
}

test('a question held while typing leaves the composer, its focus and digits alone', async (t) => {
  const view = mount();
  t.after(view.cleanup);
  view.composer.value = '2026년 3쪽';
  view.composer.focus();
  view.controller.request(interaction, undefined, { held: true });
  await flush();
  assert.equal(view.controller.isHeld(), true);
  assert.equal(view.controller.isPresented(), false);
  assert.equal(view.root.dataset.held, 'true');
  assert.ok(view.root.querySelector('.ag-question-arrival'), 'the one-line arrival strip is shown');
  assert.equal(view.root.querySelector('.ag-question-prompt'), null, 'the card is not opened');
  assert.equal(fakeDocument.activeElement, view.composer, 'focus stays where the user types');
  assert.equal(view.composer.value, '2026년 3쪽', 'the composer text is untouched');
  assert.equal(view.modes.some(([active]) => active), false, 'the composer is never taken over');
  assert.equal(pressDigit('1', body).prevented, false, 'a digit is not captured by a held question');
  assert.equal(view.selected(), 0);
});

test('clicking the arrival strip asks the sidebar to open held arrivals', (t) => {
  const view = mount();
  t.after(view.cleanup);
  view.controller.request(interaction, undefined, { held: true });
  view.root.querySelector('.ag-question-arrival')!.click();
  assert.equal(view.arrivalOpens(), 1);
});

test('presenting opens the card, takes the composer and focuses the question when allowed', async (t) => {
  const view = mount({ canTakeFocus: () => true });
  t.after(view.cleanup);
  view.composer.focus();
  view.controller.request(interaction, undefined, { held: true });
  view.controller.present();
  await flush();
  assert.equal(view.controller.isPresented(), true);
  assert.equal(view.root.dataset.held, undefined);
  assert.deepEqual(view.modes.at(-1), [true, false], 'the card takes the composer over');
  assert.equal(fakeDocument.activeElement, view.root.querySelector('.ag-question-prompt'));
  assert.equal(pressDigit('1', body).prevented, true, 'digits answer once the card is open');
  assert.equal(view.selected(), 1);
});

test('presenting never takes focus from the document or another text field', async (t) => {
  const editorInput = new FakeElement('textarea');
  body.appendChild(editorInput);
  t.after(() => editorInput.remove());
  const view = mount({ canTakeFocus: () => false });
  t.after(view.cleanup);
  editorInput.focus();
  view.controller.request(interaction);
  await flush();
  assert.equal(view.controller.isPresented(), true);
  assert.equal(fakeDocument.activeElement, editorInput, 'focus stays in the document');
  assert.equal(pressDigit('1', editorInput).prevented, false, 'digits typed in the document stay text');
  assert.equal(view.selected(), 0);
});

test('a replayed copy of an open question does not fold it back into the strip', async (t) => {
  const view = mount();
  t.after(view.cleanup);
  view.controller.request(interaction);
  view.controller.request({ ...interaction, updatedAt: '2026-10-10T00:00:01Z' }, undefined, { held: true });
  assert.equal(view.controller.isPresented(), true);
  assert.equal(view.controller.isHeld(), false);
});

test('Other borrows the composer and gives the user\'s own text back when the question ends', async (t) => {
  const view = mount();
  t.after(view.cleanup);
  view.composer.value = '초안';
  view.controller.request(interaction, undefined, { held: true });
  view.controller.present();
  pressDigit('3', body);
  assert.equal(view.controller.usesComposerForOther(), true);
  assert.equal(view.composer.value, '', 'Other starts from its own empty draft');
  view.composer.value = '보고서처럼 딱딱하게';
  view.controller.handleComposerInput();
  assert.equal(view.controller.handleComposerSubmit(), true, 'Enter in the composer answers the question');
  assert.deepEqual(view.submitted, [{
    interactionId: 'q-1',
    answers: { tone: { selectedOptionIds: [], otherText: '보고서처럼 딱딱하게' } },
  }]);
  view.controller.resolve('q-1', { status: 'answered', answers: {} } as never);
  assert.equal(view.composer.value, '초안');
  assert.equal(view.controller.hasPending(), false);
});

test('a question that resolves while held disappears without touching the composer', (t) => {
  const view = mount();
  t.after(view.cleanup);
  view.composer.value = '쓰던 글';
  view.controller.request(interaction, undefined, { held: true });
  view.controller.resolve('q-1', { status: 'cancelled', reason: 'user-stop' } as never);
  assert.equal(view.composer.value, '쓰던 글');
  assert.equal(view.root.dataset.inactive, 'true');
  assert.equal(view.root.querySelector('.ag-question-arrival'), null);
});
