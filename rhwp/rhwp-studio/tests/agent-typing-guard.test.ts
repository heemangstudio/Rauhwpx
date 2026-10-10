import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TYPING_IDLE_MS,
  createArrivalGuard,
  createTypingActivity,
  type TypingActivityEnv,
} from '../src/ui/agent-sidebar/typing-guard.ts';

/* 가짜 시계 — advance() 가 그 사이에 걸린 타이머를 시각 순서대로 돌린다. */
function fakeClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => now,
    setTimeout(fn: () => void, ms: number): number {
      const id = nextId++;
      timers.set(id, { at: now + Math.max(0, ms), fn });
      return id;
    },
    clearTimeout(id: number): void {
      timers.delete(id);
    },
    advance(ms: number): void {
      const target = now + ms;
      for (;;) {
        let due: [number, { at: number; fn: () => void }] | null = null;
        for (const entry of timers) {
          if (entry[1].at <= target && (!due || entry[1].at < due[1].at)) due = entry;
        }
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = target;
    },
  };
}

interface FakeTarget { editable?: boolean; name: string }

/* 가짜 문서·창 — 리스너를 모아 두고 fire() 로 사람이 낸(isTrusted) 또는 코드가 낸 이벤트를 흘린다. */
function fakeEventSource<T extends object>(extra: T) {
  const listeners = new Map<string, Set<(event: Event) => void>>();
  return Object.assign(extra, {
    addEventListener(type: string, listener: (event: Event) => void) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(listener);
    },
    removeEventListener(type: string, listener: (event: Event) => void) {
      listeners.get(type)?.delete(listener);
    },
    fire(type: string, props: Record<string, unknown> = {}) {
      const event = { type, isTrusted: true, ...props } as unknown as Event;
      for (const listener of [...(listeners.get(type) ?? [])]) listener(event);
    },
    listenerCount: () => [...listeners.values()].reduce((sum, set) => sum + set.size, 0),
  });
}

function setup() {
  const clock = fakeClock();
  const composer: FakeTarget = { name: 'composer', editable: true };
  const editorInput: FakeTarget = { name: 'editor', editable: true };
  const button: FakeTarget = { name: 'button' };
  const doc = fakeEventSource({ activeElement: composer as unknown as Element | null });
  const win = fakeEventSource({});
  const env: TypingActivityEnv = {
    doc,
    win,
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    isEditable: (target) => Boolean((target as FakeTarget | null)?.editable),
  };
  const activity = createTypingActivity(env);
  let shown = true;
  // 질문은 사이드바 입력기를 넘겨받는다 — 그 칸의 조합만 쉼에도 지킨다.
  const guard = createArrivalGuard(activity, () => shown, (target) => target === composer);
  const presented: string[] = [];
  const hold = (key: string) => guard.hold(key, () => presented.push(key));
  const type = (target: FakeTarget = composer, key = 'a') => {
    doc.activeElement = target as unknown as Element;
    doc.fire('keydown', { target, key });
    doc.fire('input', { target });
  };
  const focus = (target: FakeTarget) => {
    doc.fire('focusout', { target: doc.activeElement });
    doc.activeElement = target as unknown as Element;
  };
  return {
    clock, doc, win, activity, guard, presented, hold, type, focus,
    composer, editorInput, button,
    hide: () => { shown = false; },
  };
}

test('a question that arrives while typing waits until 1.5 s without keystrokes', () => {
  const t = setup();
  t.type();
  assert.equal(t.hold('question:a'), true);
  assert.deepEqual(t.presented, []);
  t.clock.advance(TYPING_IDLE_MS - 1);
  assert.deepEqual(t.presented, [], 'still held 1 ms before the pause completes');
  t.clock.advance(1);
  assert.deepEqual(t.presented, ['question:a'], 'opens once the user stopped for 1.5 s');
  t.clock.advance(10_000);
  assert.deepEqual(t.presented, ['question:a'], 'opens exactly once');
});

test('every keystroke restarts the pause', () => {
  const t = setup();
  t.type();
  t.hold('question:a');
  t.clock.advance(1_000);
  t.type();
  t.clock.advance(TYPING_IDLE_MS - 1);
  assert.deepEqual(t.presented, []);
  t.clock.advance(1);
  assert.deepEqual(t.presented, ['question:a']);
});

test('an open Hangul composition keeps the question held until it ends', () => {
  const t = setup();
  t.doc.fire('keydown', { target: t.composer, key: 'Process' });
  t.doc.fire('compositionstart', { target: t.composer });
  t.doc.fire('compositionupdate', { target: t.composer });
  assert.equal(t.hold('question:a'), true);
  t.clock.advance(500);
  // IME 가 조합 중에 내는 keyCode 229 키도 사람이 친 키다.
  t.doc.fire('keydown', { target: t.composer, key: 'Process' });
  t.clock.advance(10_000);
  assert.deepEqual(t.presented, [], 'an unfinished syllable is never cut short by an idle release');
  // Chromium 은 확정된 조합의 compositionend 를 isTrusted=false 로 보내기도 한다.
  t.doc.fire('compositionend', { target: t.composer, isTrusted: false });
  t.clock.advance(TYPING_IDLE_MS - 1);
  assert.deepEqual(t.presented, []);
  t.clock.advance(1);
  assert.deepEqual(t.presented, ['question:a']);
});

test('a composition in the document opens the question on the pause, as the card leaves focus there', () => {
  const t = setup();
  // 한국어 입력기는 쉬는 동안에도 마지막 음절을 조합 중으로 둔다.
  t.doc.activeElement = t.editorInput as unknown as Element;
  t.doc.fire('keydown', { target: t.editorInput, key: 'Process' });
  t.doc.fire('compositionstart', { target: t.editorInput });
  t.doc.fire('compositionupdate', { target: t.editorInput });
  assert.equal(t.hold('question:a'), true, 'a fresh syllable is still typing');
  t.clock.advance(1_000);
  t.doc.fire('compositionupdate', { target: t.editorInput });
  t.clock.advance(TYPING_IDLE_MS - 1);
  assert.deepEqual(t.presented, [], 'each composition update restarts the pause');
  t.clock.advance(1);
  assert.deepEqual(t.presented, ['question:a'], 'the pause opens it although the syllable is still composing');
  assert.equal(t.hold('question:b'), false, 'a later arrival during the same idle composition opens at once');
  assert.deepEqual(t.presented, ['question:a', 'question:b']);
  t.doc.fire('compositionupdate', { target: t.editorInput });
  assert.equal(t.hold('question:c'), true, 'composing again is typing again');
  t.clock.advance(TYPING_IDLE_MS);
  assert.deepEqual(t.presented, ['question:a', 'question:b', 'question:c']);
});

test('an idle composer composition still holds after a document composition opened an earlier arrival', () => {
  const t = setup();
  t.doc.activeElement = t.editorInput as unknown as Element;
  t.doc.fire('compositionstart', { target: t.editorInput });
  t.hold('question:a');
  t.doc.fire('compositionend', { target: t.editorInput });
  t.focus(t.composer);
  t.clock.advance(0);
  t.doc.fire('compositionstart', { target: t.composer });
  t.doc.fire('compositionupdate', { target: t.composer });
  t.clock.advance(TYPING_IDLE_MS * 4);
  assert.deepEqual(t.presented, [], 'the composer composition keeps the question held');
  t.doc.fire('compositionend', { target: t.composer });
  t.clock.advance(TYPING_IDLE_MS);
  assert.deepEqual(t.presented, ['question:a']);
});

test('a composition confirmed without compositionend ends at the next non-composing input', () => {
  const t = setup();
  t.doc.fire('compositionstart', { target: t.composer });
  t.hold('question:a');
  t.clock.advance(5_000);
  assert.deepEqual(t.presented, []);
  t.doc.fire('input', { target: t.composer, isComposing: false });
  t.clock.advance(TYPING_IDLE_MS);
  assert.deepEqual(t.presented, ['question:a']);
});

test('leaving every text field releases on the next task; moving to the document is still typing', () => {
  const t = setup();
  t.type();
  t.hold('question:a');
  t.focus(t.editorInput);
  t.clock.advance(0);
  assert.deepEqual(t.presented, [], 'composer → document input keeps the question held');
  t.focus(t.button);
  assert.deepEqual(t.presented, [], 'the new focus is only known after focusout');
  t.clock.advance(0);
  assert.deepEqual(t.presented, ['question:a']);
});

test('switching to another app releases held arrivals', () => {
  const t = setup();
  t.type();
  t.hold('question:a');
  t.win.fire('blur', { target: t.win });
  assert.deepEqual(t.presented, ['question:a']);
});

test('sending from the composer opens a held arrival at once', () => {
  const t = setup();
  t.type();
  t.hold('question:a');
  t.activity.noteSend();
  assert.deepEqual(t.presented, ['question:a']);
  assert.equal(t.activity.isTyping(), false, 'the sent text ended the typing');
});

test('untrusted events and bare modifier keys are not typing', () => {
  const t = setup();
  t.doc.fire('keydown', { target: t.composer, key: 'a', isTrusted: false });
  t.doc.fire('input', { target: t.composer, isTrusted: false });
  t.doc.fire('keydown', { target: t.composer, key: 'Shift' });
  t.doc.fire('keydown', { target: t.composer, key: 'Meta' });
  assert.equal(t.hold('question:a'), false);
  assert.deepEqual(t.presented, ['question:a']);
});

test('keys outside text fields are not typing', () => {
  const t = setup();
  t.doc.activeElement = t.button as unknown as Element;
  t.doc.fire('keydown', { target: t.button, key: '1' });
  assert.equal(t.hold('question:a'), false);
  assert.deepEqual(t.presented, ['question:a']);
});

test('a hidden sidebar presents at once', () => {
  const t = setup();
  t.type();
  t.hide();
  assert.equal(t.hold('question:a'), false);
  assert.deepEqual(t.presented, ['question:a']);
});

test('an arrival that resolved while held never opens', () => {
  const t = setup();
  t.type();
  t.hold('question:a');
  t.guard.cancel('question:a');
  assert.equal(t.guard.isHeld('question:a'), false);
  t.clock.advance(TYPING_IDLE_MS);
  assert.deepEqual(t.presented, []);
});

test('several held arrivals open together in arrival order, and a strip click opens them early', () => {
  const t = setup();
  t.type();
  t.hold('question:a');
  t.hold('plan:p');
  assert.equal(t.guard.isHeld('plan:p'), true);
  t.guard.release();
  assert.deepEqual(t.presented, ['question:a', 'plan:p']);
  t.clock.advance(TYPING_IDLE_MS);
  assert.deepEqual(t.presented, ['question:a', 'plan:p'], 'a later pause does not open them again');
});

test('dispose removes the window listeners and the guard stops listening', () => {
  const t = setup();
  t.type();
  t.hold('question:a');
  t.guard.dispose();
  t.clock.advance(TYPING_IDLE_MS);
  assert.deepEqual(t.presented, []);
  t.activity.dispose();
  assert.equal(t.doc.listenerCount() + t.win.listenerCount(), 0);
});
