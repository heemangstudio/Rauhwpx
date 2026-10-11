import test from 'node:test';
import assert from 'node:assert/strict';
import {
  STATUS_MIN_VISIBLE_MS,
  STATUS_SHOW_DELAY_MS,
  createDelayedStatus,
  revealAfterDelay,
  type StatusClock,
} from '../src/ui/agent-sidebar/delayed-status.ts';

/* 가짜 시계 — advance() 가 그 사이에 걸린 타이머를 시각 순서대로 돌린다. */
function fakeClock(): StatusClock & { advance(ms: number): void; pending(): number } {
  let now = 1_000;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => now,
    setTimeout(fn, ms) {
      const id = nextId++;
      timers.set(id, { at: now + Math.max(0, ms), fn });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    advance(ms) {
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
    pending: () => timers.size,
  };
}

function setup(immediate?: (value: string) => boolean) {
  const clock = fakeClock();
  const changes: Array<{ at: number; shown: string | null }> = [];
  const status = createDelayedStatus<string>((shown) => changes.push({ at: clock.now(), shown }), { clock, immediate });
  return { clock, changes, status };
}

test('a blip shorter than the show delay never appears', () => {
  const { clock, changes, status } = setup();
  status.set('connecting');
  clock.advance(STATUS_SHOW_DELAY_MS - 1);
  status.set(null);
  clock.advance(5_000);
  assert.deepEqual(changes, []);
  assert.equal(clock.pending(), 0, 'no timer is left behind');
});

test('a lasting status appears after the show delay', () => {
  const { clock, changes, status } = setup();
  status.set('connecting');
  clock.advance(STATUS_SHOW_DELAY_MS - 1);
  assert.equal(status.shown, null);
  clock.advance(1);
  assert.equal(status.shown, 'connecting');
  assert.deepEqual(changes, [{ at: 1_000 + STATUS_SHOW_DELAY_MS, shown: 'connecting' }]);
});

test('a shown status stays for the minimum visible time', () => {
  const { clock, changes, status } = setup();
  status.set('disconnected');
  clock.advance(STATUS_SHOW_DELAY_MS);
  clock.advance(50);
  status.set(null);
  clock.advance(STATUS_MIN_VISIBLE_MS - 50 - 1);
  assert.equal(status.shown, 'disconnected', 'still visible 1 ms before the minimum');
  clock.advance(1);
  assert.equal(status.shown, null);
  assert.equal(changes.at(-1)!.at - changes[0]!.at, STATUS_MIN_VISIBLE_MS);
});

test('a status that started long ago shows at once', () => {
  const { clock, changes, status } = setup();
  status.set('working', clock.now() - 1_000);
  assert.equal(status.shown, 'working');
  assert.equal(changes.length, 1);
});

test('immediate values show at once and vanish as soon as they resolve', () => {
  const { clock, changes, status } = setup((value) => value === 'replaced');
  status.set('replaced');
  assert.equal(status.shown, 'replaced');
  clock.advance(10);
  status.set(null);
  assert.equal(status.shown, null);
  assert.deepEqual(changes.map((change) => change.shown), ['replaced', null]);
});

test('a new value while shown changes the label at once and keeps the first show time', () => {
  const { clock, changes, status } = setup();
  status.set('connecting');
  clock.advance(STATUS_SHOW_DELAY_MS);
  clock.advance(100);
  status.set('disconnected');
  assert.equal(status.shown, 'disconnected');
  status.set(null);
  clock.advance(STATUS_MIN_VISIBLE_MS - 100 - 1);
  assert.equal(status.shown, 'disconnected');
  clock.advance(1);
  assert.equal(status.shown, null);
  assert.deepEqual(changes.map((change) => change.shown), ['connecting', 'disconnected', null]);
});

test('a value that comes back during the minimum visible time stays shown', () => {
  const { clock, changes, status } = setup();
  status.set('connecting');
  clock.advance(STATUS_SHOW_DELAY_MS);
  status.set(null);
  clock.advance(100);
  status.set('connecting');
  clock.advance(5_000);
  assert.equal(status.shown, 'connecting');
  assert.deepEqual(changes.map((change) => change.shown), ['connecting']);
});

test('reset hides at once and no timer fires later', () => {
  const { clock, changes, status } = setup();
  status.set('working');
  clock.advance(STATUS_SHOW_DELAY_MS);
  status.set(null);
  status.reset();
  assert.equal(status.shown, null);
  status.set('working');
  status.reset();
  clock.advance(5_000);
  assert.deepEqual(changes.map((change) => change.shown), ['working', null]);
  assert.equal(clock.pending(), 0);
});

test('repeating the same value does not postpone the show', () => {
  const { clock, status } = setup();
  status.set('starting');
  clock.advance(300);
  status.set('starting');
  clock.advance(100);
  assert.equal(status.shown, 'starting');
});

test('dispose stops a pending transition', () => {
  const { clock, changes, status } = setup();
  status.set('starting');
  status.dispose();
  clock.advance(5_000);
  assert.deepEqual(changes, []);
});

test('list rows reveal a working status 400 ms after its stored start', () => {
  assert.deepEqual(revealAfterDelay(10_000 - 100, 10_000), { revealed: false, revealInMs: 300 });
  assert.deepEqual(revealAfterDelay(10_000 - 500, 10_000), { revealed: true, revealInMs: 0 });
  assert.deepEqual(revealAfterDelay(10_000 + 5_000, 10_000), { revealed: false, revealInMs: STATUS_SHOW_DELAY_MS },
    'a clock running ahead in another tab never delays it longer than the show delay');
});
