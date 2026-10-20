// 자동 수정 단추의 상태 흐름과 데스크톱 API 연결 — 결과마다 돌아오는 자리, 고친 뒤 다시 하기,
// 거절·API 없음, 설정을 켜고 끌 때 단추를 세울지.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AUTOFIX_RESULT_MS,
  AUTOFIX_UNAVAILABLE_MS,
  autofixReady,
  createAutofixController,
  createRetryEscalation,
  runAutofix,
  setAutofixApi,
  type AutofixPhase,
  type AutofixSettings,
  type AutofixStatus,
  type DesktopAutofixApi,
} from '../src/ui/autofix/autofix.ts';

function fakeTimers() {
  const pending: Array<{ at: number; run: () => void }> = [];
  let now = 0;
  return {
    setTimer: (run: () => void, ms: number) => { const entry = { at: now + ms, run }; pending.push(entry); return entry; },
    clearTimer: (handle: unknown) => { pending.splice(pending.indexOf(handle as never), 1); },
    advance(ms: number) {
      now += ms;
      for (const entry of pending.filter((item) => item.at <= now)) {
        pending.splice(pending.indexOf(entry), 1);
        entry.run();
      }
    },
  };
}

async function settle(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
}

function controllerFor(result: () => Promise<AutofixStatus>) {
  const timers = fakeTimers();
  const phases: AutofixPhase[] = [];
  let fixed = 0;
  const controller = createAutofixController({
    run: result,
    onFixed: () => { fixed += 1; },
    onPhase: (phase) => phases.push(phase),
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  return { controller, timers, phases, fixed: () => fixed };
}

test('fixed shows its result, then returns to idle and reruns the failed action', async () => {
  const h = controllerFor(async () => 'fixed');
  h.controller.start();
  h.controller.start();
  await settle();
  assert.deepEqual(h.phases, ['running', 'fixed'], 'a second click while running does nothing');
  h.timers.advance(AUTOFIX_RESULT_MS - 1);
  assert.equal(h.fixed(), 0, 'the rerun waits until 고침 has been shown');
  h.timers.advance(1);
  assert.deepEqual(h.phases, ['running', 'fixed', 'idle']);
  assert.equal(h.fixed(), 1);
});

test('failed and unavailable go back to 자동 수정 without rerunning; a rejection counts as failed', async () => {
  const failed = controllerFor(async () => { throw new Error('ipc closed'); });
  failed.controller.start();
  await settle();
  failed.timers.advance(AUTOFIX_RESULT_MS);
  assert.deepEqual(failed.phases, ['running', 'failed', 'idle']);
  assert.equal(failed.fixed(), 0);

  const unavailable = controllerFor(async () => 'unavailable');
  unavailable.controller.start();
  await settle();
  unavailable.timers.advance(AUTOFIX_RESULT_MS);
  assert.equal(unavailable.controller.phase(), 'unavailable', 'unavailable stays a little longer');
  unavailable.timers.advance(AUTOFIX_UNAVAILABLE_MS - AUTOFIX_RESULT_MS);
  assert.equal(unavailable.controller.phase(), 'idle');
  unavailable.controller.start();
  assert.equal(unavailable.controller.phase(), 'running', 'the button can be used again');
});

test('a disposed button never reruns the action', async () => {
  const h = controllerFor(async () => 'fixed');
  h.controller.start();
  await settle();
  h.controller.dispose();
  h.timers.advance(AUTOFIX_RESULT_MS);
  assert.equal(h.fixed(), 0);
});

test('retry escalation counts only failed retries of the same error', () => {
  const escalation = createRetryEscalation(2);
  escalation.failed('a');
  escalation.failed('a');
  assert.equal(escalation.escalated('a'), false, 'a recurrence without a retry is not a failed retry');
  escalation.retried('a');
  escalation.failed('a');
  escalation.retried('a');
  escalation.failed('a');
  assert.equal(escalation.escalated('a'), true);
  assert.equal(escalation.attempts('a'), 2);
  escalation.retried('b');
  escalation.failed('b');
  assert.equal(escalation.escalated('a'), false, 'a different error starts over');
  escalation.retried('b');
  escalation.failed('b');
  escalation.reset();
  assert.equal(escalation.escalated('b'), false, 'success resets');
});

function fakeApi(settings: AutofixSettings, run: DesktopAutofixApi['run']) {
  const listeners = new Set<(next: AutofixSettings) => void>();
  const api: DesktopAutofixApi = {
    run,
    getSettings: async () => settings,
    setSettings: async (patch) => {
      settings = { ...settings, ...patch };
      for (const listener of listeners) listener(settings);
      return settings;
    },
    onChange: (callback) => { listeners.add(callback); return () => listeners.delete(callback); },
  };
  return api;
}

const SETTINGS: AutofixSettings = {
  enabled: false,
  decided: false,
  providers: [
    { id: 'codex', enabled: true, model: 'sol', effort: 'low' },
    { id: 'claude', enabled: true, model: 'claude-opus-5-5', effort: 'medium' },
  ],
};

test('the button stands only on desktop with autofix turned on, and follows the setting live', async () => {
  setAutofixApi(null);
  assert.equal(autofixReady(), false, 'web build');
  assert.equal(await runAutofix({ surface: 's', title: 't' }), 'unavailable');

  const api = fakeApi(SETTINGS, async () => ({ status: 'fixed' }));
  setAutofixApi(api);
  await settle();
  assert.equal(autofixReady(), false, 'off by default');
  await api.setSettings({ enabled: true, decided: true });
  assert.equal(autofixReady(), true);
  setAutofixApi(undefined);
});

test('runs share one in-flight request in a window and treat rejections as failed', async () => {
  let calls = 0;
  let release: (status: AutofixStatus) => void = () => {};
  setAutofixApi(fakeApi({ ...SETTINGS, enabled: true }, () => {
    calls += 1;
    return new Promise((resolve) => { release = (status) => resolve({ status }); });
  }));
  const first = runAutofix({ surface: 'a', title: 'a' });
  const second = runAutofix({ surface: 'b', title: 'b' });
  release('fixed');
  assert.deepEqual(await Promise.all([first, second]), ['fixed', 'fixed']);
  assert.equal(calls, 1);

  setAutofixApi(fakeApi({ ...SETTINGS, enabled: true }, async () => { throw new Error('boom'); }));
  assert.equal(await runAutofix({ surface: 'a', title: 'a' }), 'failed');
  setAutofixApi(undefined);
});
