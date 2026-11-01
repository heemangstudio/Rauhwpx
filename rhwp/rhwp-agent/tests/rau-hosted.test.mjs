// 호스팅 Rau-0.1: 성공·자격 거절·한도·오류에서 사용자 계정 경로로 넘어가지 않는다.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { DocumentMemoryStore } from '../document-memory-store.mjs';
import { availabilityFromStatus, createHostedRau, createIpcRauSource, RAU_REFUSAL_MS } from '../rau-hosted.mjs';
import { createTasteSignalBuffer } from '../taste-signals.mjs';
import { createTasteLearner } from '../taste-learner.mjs';

const ready = { claude: { ready: true }, codex: { ready: true }, pi: { ready: true } };
const json = (ops) => JSON.stringify({ ops });
const learned = json([{ op: 'add', kind: 'style', subject: '문체.종결', text: '본문은 한다체 사용' }]);

async function until(predicate, label, timeoutMs = 3_000) {
  const end = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > end) throw new Error(`timed out: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 80));

/** 데스크톱 대신 답하는 소스. answer 는 (prompt) => value 이거나 던진다. */
function fakeSource(answer, { available = true } = {}) {
  const listeners = new Set();
  const prompts = [];
  return {
    available,
    prompts,
    async learn(prompt) {
      prompts.push(prompt);
      return answer(prompt);
    },
    onChange(callback) { listeners.add(callback); return () => listeners.delete(callback); },
    licenseChanged() { for (const listener of listeners) listener(); },
  };
}

const refusal = (code, extra = {}) => () => { throw Object.assign(new Error(code), { code, ...extra }); };

function harness(t, { source, settings = { enabled: true }, clock = { t: Date.parse('2026-10-30T00:00:00Z') }, claude = learned } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'rhwp-rau-hosted-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new DocumentMemoryStore({ dir });
  const calls = [];
  const frames = [];
  const hosted = createHostedRau({ source, now: () => clock.t });
  const learner = createTasteLearner({
    store,
    signals: createTasteSignalBuffer(),
    settings: () => settings,
    routes: () => ({
      readiness: ready,
      hosted,
      deps: { runProvider: async (call) => { calls.push(call); return claude; } },
    }),
    resolveKey: ({ documentId }) => store.resolveKey({ documentId }),
    emit: (frame) => frames.push(frame),
    debounceMs: 30,
  });
  t.after(() => learner.close());
  let turn = 0;
  const run = async () => {
    turn += 1;
    const before = calls.length + source.prompts.length;
    const usable = hosted.usable();
    await learner.turnEnded({ threadId: 'th1', turnId: `t${turn}`, documentId: 'doc-1', userText: `한다체로 써 줘 ${turn}. 앞으로도.`, learn: true });
    if (usable) await until(() => calls.length + source.prompts.length > before, `run ${turn}`);
    await settle();
  };
  return { calls, frames, run, clock, store, learner };
}

test('with a license the hosted route runs first and its text is learned like any route', async (t) => {
  const source = fakeSource(() => ({ text: learned, model: 'rau-0.1' }));
  const h = harness(t, { source });
  await h.run();
  assert.equal(source.prompts.length, 1);
  assert.equal(h.calls.length, 0, 'no own-account route');
  assert.equal(h.frames.length, 1);
  assert.equal(h.frames[0].type, 'taste-learned');
});

test('a plan refusal skips learning, prompts once, and is remembered until the license changes', async (t) => {
  const source = fakeSource(refusal('rau_plan_required', { upgradeUrl: 'https://heemangstudios.com/pricing.html#rau' }));
  const h = harness(t, { source });
  await h.run();
  assert.equal(h.calls.length, 0);
  const upgrades = h.frames.filter((frame) => frame.type === 'rau-upgrade');
  assert.equal(upgrades.length, 1);
  assert.deepEqual([upgrades[0].reason, upgrades[0].upgradeUrl, upgrades[0].documentId], ['rau_plan_required', 'https://heemangstudios.com/pricing.html#rau', 'doc-1']);

  await h.run();
  assert.equal(source.prompts.length, 1, 'the refusal is remembered');
  assert.equal(h.calls.length, 0);

  h.clock.t += RAU_REFUSAL_MS;
  await h.run();
  assert.equal(source.prompts.length, 2, 'asked again after a day');
  assert.equal(h.frames.filter((frame) => frame.type === 'rau-upgrade').length, 1, 'the same refusal never prompts twice');

  source.licenseChanged();
  await h.run();
  assert.equal(source.prompts.length, 3, 'a license change asks at once');
  assert.equal(h.frames.filter((frame) => frame.type === 'rau-upgrade').length, 2);
});

test('exhausted credits skip hosted Rau until they reset, without prompting', async (t) => {
  const resetsAt = Date.parse('2026-11-01T00:00:00Z');
  const source = fakeSource(refusal('rau_credits_exhausted', { resetsAt }));
  const h = harness(t, { source });
  await h.run();
  await h.run();
  assert.equal(source.prompts.length, 1);
  assert.equal(h.calls.length, 0);
  h.clock.t = resetsAt;
  await h.run();
  assert.equal(source.prompts.length, 2);
  assert.equal(h.frames.some((frame) => frame.type === 'rau-upgrade'), false);
});

test('without a license or outside the desktop app, no local route runs and nothing prompts', async (t) => {
  const noLicense = fakeSource(refusal('no_license'));
  const h = harness(t, { source: noLicense });
  await h.run();
  assert.equal(h.calls.length, 0);
  assert.equal(h.frames.some((frame) => frame.type === 'rau-upgrade'), false);

  const browser = fakeSource(() => ({ text: learned }), { available: false });
  const web = harness(t, { source: browser });
  await web.run();
  assert.equal(browser.prompts.length, 0);
  assert.equal(web.calls.length, 0);
});

test('a legacy provider selection cannot bypass hosted Rau', async (t) => {
  const source = fakeSource(() => ({ text: learned }));
  const h = harness(t, { source, settings: { enabled: true, provider: 'claude', model: null, effort: null } });
  await h.run();
  assert.equal(source.prompts.length, 1);
  assert.equal(h.calls.length, 0);
});

test('the IPC source sends only the prompt and maps the desktop error back', async () => {
  const processRef = new EventEmitter();
  processRef.env = { RHWP_RAU_BROKER: 'ipc' };
  const sent = [];
  processRef.send = (message, callback) => { sent.push(message); callback?.(null); };
  const source = createIpcRauSource({ processRef });
  assert.equal(source.available, true);

  const ok = source.learn('prompt-1');
  assert.deepEqual(Object.keys(sent[0]).sort(), ['id', 'operation', 'prompt', 'type']);
  processRef.emit('message', { type: 'rhwp-rau-response', id: sent[0].id, ok: true, value: { text: '{"ops":[]}', model: 'rau' } });
  assert.deepEqual(await ok, { text: '{"ops":[]}', model: 'rau' });

  const refused = source.learn('prompt-2');
  processRef.emit('message', { type: 'rhwp-rau-response', id: sent[1].id, ok: false, error: 'rau_plan_required', code: 'rau_plan_required', upgradeUrl: 'https://heemangstudios.com/pricing.html#rau' });
  await assert.rejects(refused, (error) => error.code === 'rau_plan_required' && error.upgradeUrl === 'https://heemangstudios.com/pricing.html#rau');

  let changed = 0;
  source.onChange(() => { changed += 1; });
  processRef.emit('message', { type: 'rhwp-rau-changed' });
  assert.equal(changed, 1);

  const plain = new EventEmitter();
  plain.env = {};
  plain.send = () => {};
  const unavailable = createIpcRauSource({ processRef: plain });
  assert.equal(unavailable.available, false);
  await assert.rejects(unavailable.learn('x'), (error) => error.code === 'RAU_SOURCE_UNAVAILABLE');
});


test('hosting errors and invalid output never fall back to configured user accounts', async (t) => {
  for (const answer of [refusal('network'), refusal('server'), () => ({ text: 'invalid JSON' })]) {
    const source = fakeSource(answer);
    const h = harness(t, { source, settings: { enabled: true, provider: 'pi', model: 'user/model', effort: 'max' } });
    await h.run();
    assert.equal(source.prompts.length, 1);
    assert.equal(h.calls.length, 0);
    assert.equal(h.frames.filter((frame) => frame.type === 'taste-learned').length, 0);
  }
});


test('an unavailable hosted learn preserves existing preferences and manual history never uses local accounts', async (t) => {
  let fail = false;
  const source = fakeSource(() => {
    if (fail) throw Object.assign(new Error('offline'), { code: 'network' });
    return { text: learned, model: 'rau-0.1' };
  });
  const h = harness(t, { source });
  await h.run();
  const key = await h.store.resolveKey({ documentId: 'doc-1' });
  const before = await h.store.read(key);
  assert.equal(before.entries.length, 1);
  fail = true;
  await h.run();
  await h.learner.learnHistory({ documentId: 'doc-1', signals: [{ kind: 'history', at: '2026-10-30T00:00:00Z', userText: '앞으로도 한다체로 써 줘', after: '한다' }] });
  assert.equal(source.prompts.length, 3);
  assert.equal(h.calls.length, 0);
  assert.deepEqual(await h.store.read(key), before);
});

test('the IPC status operation asks the desktop for eligibility', async () => {
  const processRef = new EventEmitter();
  processRef.env = { RHWP_RAU_BROKER: 'ipc' };
  const sent = [];
  processRef.send = (message, callback) => { sent.push(message); callback?.(null); };
  const source = createIpcRauSource({ processRef });
  const status = source.status();
  assert.deepEqual([sent[0].type, sent[0].operation, 'prompt' in sent[0]], ['rhwp-rau-request', 'status', false]);
  processRef.emit('message', { type: 'rhwp-rau-response', id: sent[0].id, ok: true, value: { eligible: true, source: 'trial', remainingPercent: 75 } });
  assert.deepEqual(await status, { eligible: true, source: 'trial', remainingPercent: 75 });
});

test('eligibility maps the desktop answer, is cached for its TTL, waits only briefly and refreshes on a license change', async () => {
  assert.equal(availabilityFromStatus({ eligible: true, remainingPercent: 3 }), 'active');
  assert.equal(availabilityFromStatus({ eligible: true, remainingPercent: 0 }), 'exhausted');
  assert.equal(availabilityFromStatus({ eligible: true, remainingPercent: null }), 'active');
  assert.equal(availabilityFromStatus({ eligible: false, reason: 'rau_plan_required' }), 'not_eligible');
  assert.equal(availabilityFromStatus(null), 'unavailable');

  const clock = { t: 1_000 };
  let answer = { eligible: true, remainingPercent: 2 };
  let asks = 0;
  let hold = null;
  const listeners = new Set();
  const source = {
    available: true,
    async learn() { throw Object.assign(new Error('x'), { code: 'rau_credits_exhausted' }); },
    async status() {
      asks += 1;
      if (hold) await hold;
      if (answer instanceof Error) throw answer;
      return answer;
    },
    onChange(callback) { listeners.add(callback); },
  };
  const hosted = createHostedRau({ source, now: () => clock.t, eligibilityTtlMs: 60_000, eligibilityWaitMs: 30 });
  const changes = [];
  hosted.onEligibilityChange((value) => changes.push(value));
  assert.equal(hosted.cachedEligibility(), 'unavailable', 'nothing known before the first answer');
  assert.equal(await hosted.eligibility(), 'active');
  answer = { eligible: false };
  clock.t += 59_000;
  assert.equal(await hosted.eligibility(), 'active', 'cached within the TTL');
  assert.equal(asks, 1);
  clock.t += 2_000;
  assert.equal(await hosted.eligibility(), 'not_eligible', 'asked again after the TTL');

  // 데스크톱이 늦으면 길게 기다리지 않고 지난 답을 쓰고, 새 답은 들어오는 대로 기억한다.
  let release;
  hold = new Promise((resolve) => { release = resolve; });
  answer = { eligible: true, remainingPercent: 0 };
  clock.t += 61_000;
  const started = Date.now();
  assert.equal(await hosted.eligibility(), 'not_eligible');
  assert.ok(Date.now() - started < 1_000);
  release();
  hold = null;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(hosted.cachedEligibility(), 'exhausted');

  // 라이선스가 바뀌면 곧바로 다시 묻는다. 실패는 unavailable 이다.
  answer = new Error('offline');
  for (const listener of listeners) listener();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(hosted.cachedEligibility(), 'unavailable');
  assert.deepEqual(changes, ['active', 'not_eligible', 'exhausted', 'unavailable']);

  // learn 이 크레딧 소진을 받으면 쓸 수 있음도 exhausted 가 된다.
  answer = { eligible: true, remainingPercent: 5 };
  for (const listener of listeners) listener();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(hosted.cachedEligibility(), 'active');
  await hosted.learn('p');
  assert.equal(hosted.cachedEligibility(), 'exhausted');
  assert.equal(hosted.unusableCode(), 'rau_credits_exhausted');

  const browser = createHostedRau({ source: { available: false } });
  assert.equal(await browser.eligibility(), 'unavailable');
  assert.equal(browser.unusableCode(), 'unavailable');
});
