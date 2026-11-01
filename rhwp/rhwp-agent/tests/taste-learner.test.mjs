// Rau-0.1 호스팅 취향 학습기: 설정 검증, 적용·빈 결과, 토글, 최신 요청 우선, 신호 모으기, 직접 쓰기와 묶기,
// 되돌리기, AGENTS.md 제안 문턱.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { DocumentMemoryStore } from '../document-memory-store.mjs';
import { createTasteSignalBuffer } from '../taste-signals.mjs';
import {
  RAU_TASTE_NAME,
  TASTE_PROMPT_MAX_BYTES,
  TasteSettingsStore,
  buildTastePrompt,
  createTasteLearner,
  fitTastePrompt,
  guardTasteOps,
  correctionOps,
  groundedOps,
  newTasteTurn,
  noteTasteTurnEvent,
} from '../taste-learner.mjs';
import { UserMemoryStore } from '../user-memory-store.mjs';

const at = '2026-10-22T00:00:00.000Z';

function tempDir(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'rhwp-taste-learner-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const json = (ops) => JSON.stringify({ ops });
const styleNote = (text) => json([{ op: 'add', kind: 'style', subject: '문체.종결', text, userCandidate: true }]);

/**
 * 호스팅 경로의 응답만 바꿔 끼운다. outputs.rau 는 문자열이거나 (call) => 문자열·Promise.
 */
function harness(t, { outputs = {}, settings = { enabled: true }, running = () => false, timing = {}, usable = () => true } = {}) {
  const dir = tempDir(t);
  const store = new DocumentMemoryStore({ dir });
  const userMemory = new UserMemoryStore({ dir });
  const signals = createTasteSignalBuffer();
  const calls = [];
  const frames = [];
  const changedEvents = [];
  let accountChanges = 0;
  const learner = createTasteLearner({
    store,
    userMemory,
    signals,
    settings: () => settings,
    routes: () => ({ hosted: {
      usable,
      async learn(prompt, { signal } = {}) {
        const call = { prompt, provider: 'rau', model: 'rau-0.1', signal };
        calls.push(call);
        const output = outputs.rau;
        const text = await (typeof output === 'function' ? output(call) : output ?? '{"ops":[]}');
        return { ok: true, text, model: 'rau-0.1' };
      },
    } }),
    resolveKey: ({ documentId }) => store.resolveKey({ documentId }),
    isTurnRunning: running,
    emit: (frame) => frames.push(frame),
    changed: (documentId, key, revision) => changedEvents.push({ documentId, key, revision }),
    accountChanged: () => { accountChanges += 1; },
    debounceMs: 30,
    acceptIdleMs: 150,
    acceptCapMs: 400,
    deferredCapMs: 300,
    ...timing,
  });
  t.after(() => learner.close());
  return { store, userMemory, signals, learner, calls, frames, changedEvents, accountChanges: () => accountChanges };
}

async function until(predicate, label, timeoutMs = 3_000) {
  const end = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > end) throw new Error(`timed out: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 80));

test('a successful turn applies learned notes and emits one marker; nothing durable emits nothing', async (t) => {
  const h = harness(t, {
    outputs: {
      rau: (call) => (call.prompt.includes('합니다체 말고')
        ? json([{ op: 'add', kind: 'style', subject: '문체.종결', text: '본문은 한다체 사용' }])
        : '{"ops":[]}'),
    },
  });
  await h.learner.turnEnded({
    threadId: 'th1', turnId: 'turn-1', documentId: 'doc-1',
    userText: '합니다체 말고 한다체로 써 줘. 앞으로도.', answer: '한다체로 고쳤습니다.', learn: true,
  });
  await until(() => h.frames.length === 1, 'marker');
  const [frame] = h.frames;
  assert.equal(frame.type, 'taste-learned');
  assert.deepEqual([frame.threadId, frame.turnId, frame.documentId], ['th1', 'turn-1', 'doc-1']);
  assert.deepEqual(frame.items.map(({ op, text, origin }) => [op, text, origin]), [['add', '본문은 한다체 사용', 'learned']]);
  assert.equal(frame.changes.length, 1);
  assert.equal(h.calls[0].provider, 'rau');
  assert.equal(h.calls[0].model, 'rau-0.1');
  assert.match(h.calls[0].prompt, new RegExp(RAU_TASTE_NAME));

  const memory = await h.store.read(frame.key);
  assert.equal(memory.entries[0].origin, 'learned');
  assert.deepEqual(memory.entries[0].source, { threadId: 'th1', turnId: 'turn-1', kind: 'turn' });
  assert.deepEqual(h.changedEvents.map((event) => event.revision), [1]);

  await h.learner.turnEnded({ threadId: 'th1', turnId: 'turn-2', documentId: 'doc-1', userText: '표를 하나 더 넣어 줘', answer: '넣었습니다.', learn: true });
  await until(() => h.calls.length === 2, 'second run');
  await settle();
  assert.equal(h.frames.length, 1, 'a zero-op run shows nothing');
  assert.equal((await h.store.read(frame.key)).revision, 1);
});

test('with the toggle off the learner never runs and shows nothing', async (t) => {
  const h = harness(t, { settings: { enabled: false }, outputs: { rau: json([{ op: 'add', kind: 'fact', text: '마감 11월 3일' }]) } });
  h.signals.ingest({ threadId: 'th1', documentId: 'doc-1', signals: [{ kind: 'rejected', at, after: '열립니다' }] });
  await h.learner.turnEnded({ threadId: 'th1', turnId: 't1', documentId: 'doc-1', userText: '한다체로 기억해 줘', learn: true });
  await settle();
  assert.equal(h.calls.length, 0);
  assert.deepEqual(h.frames, []);
  assert.deepEqual(h.signals.peekSignals('doc-1'), [], 'signals gathered while off are dropped');
});

test('while a run is busy only the newest request waits', async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const h = harness(t, {
    outputs: {
      rau: async (call) => {
        if (call.prompt.includes('첫 턴')) await gate;
        return '{"ops":[]}';
      },
    },
  });
  await h.learner.turnEnded({ threadId: 'th1', turnId: 't1', documentId: 'doc-1', userText: '첫 턴', learn: true });
  await until(() => h.calls.length === 1, 'first run');
  await h.learner.turnEnded({ threadId: 'th1', turnId: 't2', documentId: 'doc-1', userText: '둘째 턴', learn: true });
  await h.learner.turnEnded({ threadId: 'th1', turnId: 't3', documentId: 'doc-1', userText: '셋째 턴', learn: true });
  release();
  await until(() => h.calls.length === 2, 'second run');
  await settle();
  assert.equal(h.calls.length, 2);
  assert.match(h.calls[1].prompt, /셋째 턴/);
});

test('signals while idle are gathered for a moment and learned once; signals during a turn wait for its end', async (t) => {
  let turnRunning = false;
  const h = harness(t, {
    running: () => turnRunning,
    outputs: { rau: json([{ op: 'add', kind: 'style', subject: '문체.종결', text: '본문은 한다체 사용', userCandidate: true }]) },
  });
  h.learner.signalsArrived('doc-1', {});
  h.signals.onReviewSignals((documentId, info) => h.learner.signalsArrived(documentId, info));
  h.signals.ingest({ threadId: 'th1', turnId: 't1', documentId: 'doc-1', signals: [{ kind: 'accepted', at, after: '회의는 화요일에 열립니다.' }] });
  h.signals.ingest({ threadId: 'th1', turnId: 't1', documentId: 'doc-1', signals: [{ kind: 'rewritten', at, after: '보고서를 제출해 주시기 바랍니다.', userText: '보고서를 제출한다.' }] });
  await until(() => h.frames.length === 1, 'signal marker');
  assert.equal(h.calls.length, 1);
  assert.match(h.calls[0].prompt, /회의는 화요일에 열립니다[^]*보고서를 제출한다/);
  assert.deepEqual([h.frames[0].threadId, h.frames[0].turnId], ['th1', 't1']);
  const [entry] = (await h.store.read(h.frames[0].key)).entries;
  assert.equal(entry.source.kind, 'signal');

  turnRunning = true;
  h.signals.ingest({ threadId: 'th1', turnId: 't2', documentId: 'doc-1', signals: [{ kind: 'undone', at }] });
  await settle();
  assert.equal(h.calls.length, 1, 'no idle run while a turn is running');
  assert.equal(h.signals.peekSignals('doc-1').length, 1, 'the running turn takes them at its end');
});

test('undo reverts what is unchanged and reports what was edited since', async (t) => {
  const h = harness(t, {
    outputs: {
      rau: json([
        { op: 'add', kind: 'style', subject: '문체.종결', text: '본문은 한다체 사용' },
        { op: 'add', kind: 'term', subject: '용어.고객', text: "'고객' 대신 '이용자'로 통일" },
      ]),
    },
  });
  await h.learner.turnEnded({ threadId: 'th1', turnId: 't1', documentId: 'doc-1', userText: '한다체, 이용자', learn: true });
  await until(() => h.frames.length === 1, 'marker');
  const { key, changes, items } = h.frames[0];
  const termId = items[1].entryId;
  await h.store.apply(key, [{ op: 'update', id: termId, text: "'고객' 대신 '사용자'로 통일" }], { origin: 'user' });

  // 허브가 다시 떠도 표시가 품은 changes 로 되돌린다.
  const reopened = new DocumentMemoryStore({ dir: h.store.dir });
  const learner = createTasteLearner({ store: reopened, signals: h.signals, resolveKey: () => key, changed: (...args) => h.changedEvents.push(args) });
  t.after(() => learner.close());
  const one = await learner.undo({ key, documentId: 'doc-1', changes, entryId: items[0].entryId });
  assert.deepEqual(one, { reverted: [items[0].entryId], skipped: [] });
  const rest = await learner.undo({ key, documentId: 'doc-1', changes });
  assert.deepEqual(rest.reverted, []);
  assert.ok(rest.skipped.includes(termId), 'the note the user edited since stays');
  assert.deepEqual((await reopened.read(key)).entries.map((entry) => entry.text), ["'고객' 대신 '사용자'로 통일"]);
});

test('a preference learned in two documents becomes an account rule, both notes fold into it, and undo brings them back', async (t) => {
  const userCandidate = json([{ op: 'add', kind: 'style', subject: '문체.종결', text: '본문은 한다체 사용', userCandidate: true }]);
  const h = harness(t, { outputs: { rau: userCandidate } });
  const keyA = await h.store.resolveKey({ documentId: 'doc-a', fileName: '보고서A.hwpx' });
  await h.learner.turnEnded({ threadId: 'a', turnId: 't1', documentId: 'doc-a', userText: '한다체로', learn: true });
  await until(() => h.frames.length === 1, 'doc a');
  assert.deepEqual((await h.userMemory.read()).rules, [], 'one document is not enough');
  assert.equal(h.frames[0].items[0].tier, 'document');
  assert.equal(h.frames[0].items[0].change, 'new');
  assert.equal('proposal' in h.frames[0], false);

  await h.learner.turnEnded({ threadId: 'b', turnId: 't1', documentId: 'doc-b', userText: '여기도 한다체로', learn: true });
  await until(() => h.frames.length === 2, 'doc b');
  assert.match(h.calls[1].prompt, /known_user_subjects":\[\{"subject":"문체\.종결","text":"본문은 한다체 사용"\}\]/, 'the other document\'s preference is offered for reuse');
  const [rule] = (await h.userMemory.read()).rules;
  assert.deepEqual([rule.kind, rule.subject, rule.text, rule.strength, rule.origin], ['style', '문체.종결', '본문은 한다체 사용', 2, 'learned']);
  const keyB = h.frames[1].key;
  assert.deepEqual((await h.store.read(keyA)).entries, [], 'doc a\'s note folded into the rule');
  assert.deepEqual((await h.store.read(keyB)).entries, [], 'doc b\'s note folded into the rule');
  // 표시: 이번에 더한 문서 메모는 접혔으니 빼고, 기억 승격 하나를 보인다.
  const { items } = h.frames[1];
  assert.deepEqual(items.map(({ tier, change, op, entryId }) => [tier, change, op, entryId]), [['account', 'escalated', 'add', rule.id]]);
  assert.deepEqual(items[0].strength, { from: 0, to: 2 });
  assert.equal(items[0].eventIds.length, 1);
  assert.ok(h.changedEvents.some((event) => event.documentId === 'doc-a' && event.key === keyA), 'the other document hears its note folded');
  assert.ok(h.accountChanges() >= 1);
  const [escalation] = (await h.userMemory.snapshot()).events;
  assert.deepEqual([escalation.kind, escalation.documentName], ['escalated', '보고서A.hwpx 외 1개']);

  // 되돌리면 규칙이 '되돌림'으로 물러나고 두 문서의 메모가 돌아온다. 그 습관은 스스로 다시 올라오지 않는다.
  const undone = await h.learner.undo({ key: keyB, documentId: 'doc-b', learnId: h.frames[1].learnId, changes: h.frames[1].changes });
  assert.deepEqual(undone.reverted.sort(), [rule.id, h.frames[1].changes[0].entryId].sort());
  const after = await h.userMemory.read();
  assert.deepEqual(after.rules, []);
  assert.equal(after.retired[0].reason, 'undone');
  assert.equal((await h.store.read(keyA)).entries[0].text, '본문은 한다체 사용', 'doc a\'s note is back');
  assert.deepEqual((await h.store.read(keyB)).entries, [], 'doc b\'s note was new in this learn, so it goes too');

  await h.learner.turnEnded({ threadId: 'b', turnId: 't2', documentId: 'doc-b', userText: '한다체', learn: true });
  await until(() => h.frames.length === 3, 'doc b again');
  assert.deepEqual((await h.userMemory.read()).rules, [], 'an undone escalation is blocked');
  assert.equal((await h.store.read(keyB)).entries.length, 1);
});

test('after a hub restart, undo uses the marker\'s eventIds and restores the folded notes', async (t) => {
  const h = harness(t, { outputs: { rau: styleNote('본문은 한다체 사용') } });
  for (const documentId of ['doc-a', 'doc-b']) {
    const before = h.frames.length;
    await h.learner.turnEnded({ threadId: documentId, turnId: 't1', documentId, userText: '한다체로', learn: true });
    await until(() => h.frames.length === before + 1, documentId);
  }
  const frame = h.frames[1];
  const keyA = h.frames[0].key;
  const eventIds = frame.items.flatMap((item) => item.eventIds ?? []);
  assert.equal(eventIds.length, 1);
  const store = new DocumentMemoryStore({ dir: h.store.dir });
  const userMemory = new UserMemoryStore({ dir: h.store.dir });
  const learner = createTasteLearner({ store, userMemory, signals: h.signals, resolveKey: () => frame.key });
  t.after(() => learner.close());
  await assert.rejects(learner.undo({ key: frame.key, documentId: 'doc-b', learnId: 'learn_gone', changes: frame.changes, eventIds: 'evt' }), { code: 'MEMORY_INVALID' });
  // 규칙 항목만 되돌린다 — 문서 변경은 그대로다.
  const result = await learner.undo({ key: frame.key, documentId: 'doc-b', learnId: 'learn_gone', changes: frame.changes, eventIds, entryId: frame.items[0].entryId });
  assert.deepEqual(result, { reverted: [frame.items[0].entryId], skipped: [] });
  assert.deepEqual((await userMemory.read()).rules, []);
  assert.equal((await store.read(keyA)).entries.length, 1);
  assert.equal((await store.read(frame.key)).entries.length, 1, 'doc b\'s own note comes back from the fold');
});

test('a rule is reinforced or dampened by id, and dampening needs contrary evidence or the user\'s words', async (t) => {
  let ops = [];
  const h = harness(t, { outputs: { rau: () => json(ops) } });
  const learned = await h.userMemory.escalate({ kind: 'style', subject: '문체.종결', text: '본문은 한다체 사용', docKeys: [] });
  const user = await h.userMemory.addUserRule({ kind: 'term', text: "'고객' 대신 '이용자'" });
  const ruleId = learned.rule.id;
  const run = async (input, label) => {
    const before = h.calls.length;
    await h.learner.turnEnded({ threadId: 'th1', documentId: 'doc-1', learn: true, ...input });
    await until(() => h.calls.length === before + 1, label);
    await settle();
  };
  ops = [{ op: 'reinforce', id: ruleId }];
  await run({ turnId: 't1', userText: '좋아요' }, 'reinforce');
  const strength = async (id) => (await h.userMemory.read()).rules.find((rule) => rule.id === id)?.strength;
  assert.equal(await strength(ruleId), 2);
  assert.match(h.calls[0].prompt, /"account_rules":\[[^\]]*"id":"rule_[a-z0-9]{12}"/);
  assert.equal(h.frames.at(-1).items[0].tier, 'account');
  assert.equal(h.frames.at(-1).items[0].change, 'reinforced');

  // 사용자 말도 반대 신호도 없으면 감쇄하지 않는다.
  ops = [{ op: 'dampen', id: ruleId }];
  h.signals.ingest({ threadId: 'th1', turnId: 't2', documentId: 'doc-1', signals: [{ kind: 'accepted', at, after: '진행한다.' }, { kind: 'rejected', at, after: '진행한다' }] });
  await run({ turnId: 't2', userText: '' }, 'contrary signal dampen');
  assert.equal(await strength(ruleId), 1, 'a rejection is contrary evidence');
  h.signals.ingest({ threadId: 'th1', turnId: 't3', documentId: 'doc-1', signals: [{ kind: 'accepted', at, after: '진행한다.' }] });
  await run({ turnId: 't3', userText: '' }, 'accept-only dampen');
  assert.equal(await strength(ruleId), 1, 'an accept alone never dampens');

  // 사용자가 만든 규칙은 strong 이고 사용자 말이 있을 때만.
  ops = [{ op: 'dampen', id: user.id }];
  await run({ turnId: 't4', userText: '이용자 말고 고객이라고 써' }, 'weak dampen of a user rule');
  assert.equal(await strength(user.id), 3);
  ops = [{ op: 'dampen', id: user.id, strong: true }];
  await run({ turnId: 't5', userText: '이용자라는 말은 쓰지 마' }, 'strong dampen of a user rule');
  assert.equal(await strength(user.id), 1);
  ops = [{ op: 'dampen', id: ruleId, strong: true }];
  await run({ turnId: 't6', userText: '한다체는 그만' }, 'retire');
  assert.equal(await strength(ruleId), undefined);
  assert.equal((await h.userMemory.read()).retired[0].reason, 'dampened');
  assert.equal(h.frames.at(-1).items[0].change, 'retired');

  // 가드는 rule_ 감쇄에도 같은 규칙을 쓴다.
  const rules = [{ id: ruleId, origin: 'learned' }, { id: user.id, origin: 'user' }];
  assert.deepEqual(guardTasteOps([{ op: 'dampen', id: ruleId }], [], { rules }), []);
  assert.deepEqual(guardTasteOps([{ op: 'reinforce', id: ruleId }], [], { rules }), [{ op: 'reinforce', id: ruleId }]);
  assert.deepEqual(guardTasteOps([{ op: 'dampen', id: user.id, strong: true }], [], { rules, signals: [{ kind: 'rejected' }] }), [], 'a user rule needs the user\'s words');
});

test('a deleted rule is not escalated again unless the user states it in general terms', async (t) => {
  const h = harness(t, { outputs: { rau: styleNote('본문은 한다체 사용') } });
  const end = async (documentId, userText) => {
    const before = h.frames.length;
    await h.learner.turnEnded({ threadId: documentId, turnId: `t${before}`, documentId, userText, learn: true });
    await until(() => h.frames.length === before + 1, documentId);
  };
  await end('doc-a', '한다체로');
  await end('doc-b', '한다체로');
  const [rule] = (await h.userMemory.read()).rules;
  await h.userMemory.deleteRule(rule.id);
  await end('doc-c', '한다체로');
  await end('doc-d', '한다체로');
  assert.deepEqual((await h.userMemory.read()).rules, [], 'the user deleted it; two more documents do not bring it back');
  await end('doc-e', '앞으로 본문은 항상 한다체로');
  const [back] = (await h.userMemory.read()).rules;
  assert.equal(back?.text, '본문은 한다체 사용', 'a general statement lifts the block');
  assert.equal(back.strength, 3, 'every document that holds the habit counts');
});

test('documents that override a rule dampen it from the second one and flip it at zero', async (t) => {
  const h = harness(t, { outputs: { rau: styleNote('본문은 합니다체 사용') } });
  await h.userMemory.escalate({ kind: 'style', subject: '문체.종결', text: '본문은 한다체 사용', docKeys: [] });
  const ruleId = (await h.userMemory.read()).rules[0].id;
  await h.userMemory.reinforce(ruleId);
  const end = async (documentId) => {
    const before = h.frames.length;
    await h.learner.turnEnded({ threadId: documentId, turnId: 't1', documentId, userText: '합니다체로', learn: true });
    await until(() => h.frames.length === before + 1, documentId);
    return h.frames.at(-1);
  };
  await end('doc-a');
  assert.equal((await h.userMemory.read()).rules[0].strength, 2, 'one overriding document is only an override');
  assert.equal((await h.store.read(h.frames[0].key)).entries.length, 1, 'the override note stays in its document');
  await end('doc-b');
  assert.equal((await h.userMemory.read()).rules[0].strength, 1, 'the second overriding document dampens');
  const flipped = await end('doc-c');
  const state = await h.userMemory.read();
  assert.deepEqual(state.rules.map(({ text, strength }) => [text, strength]), [['본문은 합니다체 사용', 3]], 'the habit of three documents takes over');
  assert.deepEqual([state.retired[0].text, state.retired[0].reason], ['본문은 한다체 사용', 'flipped']);
  for (const frame of h.frames) assert.deepEqual((await h.store.read(frame.key)).entries, [], 'the overriding notes fold into the new rule');
  assert.deepEqual(flipped.items.map((item) => [item.tier, item.change]), [['account', 'retired'], ['account', 'escalated']], 'the folded override note is replaced by the escalation');
});

test('a note already moved into AGENTS.md is never escalated, and kinds other than style and term stay in the document', async (t) => {
  const h = harness(t, {
    outputs: {
      rau: json([
        { op: 'add', kind: 'decision', subject: '결정.범위', text: '3장까지만 작성', userCandidate: true },
        { op: 'add', kind: 'term', subject: '용어.고객', text: "'고객' 대신 '이용자'로 통일", userCandidate: true },
      ]),
    },
  });
  const keyA = await h.store.resolveKey({ documentId: 'doc-a' });
  await h.store.apply(keyA, [{ op: 'add', kind: 'term', subject: '용어.고객', text: "'고객' 대신 '이용자'로 통일", userCandidate: true }], { origin: 'learned' });
  const file = path.join(h.store.dir, 'docs', `${keyA}.json`);
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  raw.entries[0].promoted = true;
  raw.entries[0].promotionText = raw.entries[0].text;
  writeFileSync(file, JSON.stringify(raw));
  h.store.docs.delete(keyA);
  await h.learner.turnEnded({ threadId: 'b', turnId: 't1', documentId: 'doc-b', userText: '이용자로', learn: true });
  await until(() => h.frames.length === 1, 'doc b');
  await h.learner.turnEnded({ threadId: 'c', turnId: 't1', documentId: 'doc-c', userText: '이용자로', learn: true });
  await until(() => h.frames.length === 2, 'doc c');
  const rules = (await h.userMemory.read()).rules;
  assert.deepEqual(rules.map((rule) => [rule.subject, rule.strength]), [['용어.고객', 2]], 'only b and c count; the promoted note in a does not');
  assert.equal((await h.store.read(keyA)).entries[0].promoted, true, 'the promoted note stays');
  assert.ok((await h.store.read(h.frames[1].key)).entries.some((entry) => entry.kind === 'decision'), 'decisions never leave the document');
});

test('the first learn after a hub start escalates candidates already in two documents', async (t) => {
  const h = harness(t, { outputs: { rau: '{"ops":[]}' } });
  for (const documentId of ['doc-a', 'doc-b']) {
    const key = await h.store.resolveKey({ documentId });
    await h.store.apply(key, [{ op: 'add', kind: 'style', subject: '문장부호.쉼표', text: '쉼표 뒤 한 칸 띄움', userCandidate: true }], { origin: 'learned' });
  }
  await h.learner.turnEnded({ threadId: 'c', turnId: 't1', documentId: 'doc-c', userText: '표를 넣어 줘', learn: true });
  await until(() => h.frames.length === 1, 'sweep marker');
  assert.deepEqual((await h.userMemory.read()).rules.map((rule) => [rule.subject, rule.strength]), [['문장부호.쉼표', 2]]);
  assert.equal(h.frames[0].items[0].change, 'escalated');
});

test('the prompt fits the hosted 48 KiB limit by trimming text in steps', () => {
  const korean = (n) => '가'.repeat(n);
  const chats = Array.from({ length: 40 }, () => ({ userText: korean(800), answer: korean(400) }));
  const signals = Array.from({ length: 20 }, () => ({ kind: 'rewritten', after: korean(600), userText: korean(600), before: korean(600) }));
  const input = { entries: [], userText: korean(4000), answer: korean(4000), chats, signals };
  assert.ok(Buffer.byteLength(buildTastePrompt(input), 'utf8') > 48 * 1024, 'the untrimmed prompt overflows');
  const fitted = fitTastePrompt(input);
  assert.ok(fitted.bytes <= TASTE_PROMPT_MAX_BYTES, `${fitted.bytes} bytes`);
  assert.ok(fitted.level > 0);
  assert.equal(Buffer.byteLength(fitted.prompt, 'utf8'), fitted.bytes);
  // 작은 프롬프트는 줄이지 않는다.
  const small = fitTastePrompt({ entries: [], userText: '한다체로', answer: '네' });
  assert.equal(small.level, 0);
  assert.match(small.prompt, /"user_message":"한다체로"/);
});
test('turn text keeps only the root agent\'s final answer', () => {
  const turn = newTasteTurn('t1');
  noteTasteTurnEvent(turn, { type: 'text-delta', text: '확인하겠습니다.' });
  noteTasteTurnEvent(turn, { type: 'tool-call', tool: 'read_paragraphs' });
  noteTasteTurnEvent(turn, { type: 'text-delta', text: '하위 작업 글', parentTaskId: 'task-1' });
  noteTasteTurnEvent(turn, { type: 'text-delta', text: '한다체로 ' });
  noteTasteTurnEvent(turn, { type: 'text-delta', text: '고쳤습니다.' });
  assert.equal(turn.answer, '한다체로 고쳤습니다.');
});

test('the learn-from-chats setting is on by default and survives a restart', async (t) => {
  const dir = tempDir(t);
  const settings = await new TasteSettingsStore({ dir }).init();
  const auto = { enabled: true, provider: 'auto', model: null, effort: null };
  assert.deepEqual(settings.get(), auto);
  await settings.set({ enabled: false });
  assert.deepEqual((await new TasteSettingsStore({ dir }).init()).get(), { ...auto, enabled: false });
  await assert.rejects(settings.set({ enabled: 'no' }), { code: 'TASTE_SETTINGS_INVALID' });
});

test('learner provider settings validate, reset with the provider and read old files as auto', async (t) => {
  const dir = tempDir(t);
  // 옛 파일은 { enabled } 뿐이다 — 자동 경로로 읽는다.
  writeFileSync(path.join(dir, 'taste-settings.json'), JSON.stringify({ schemaVersion: 1, enabled: false }));
  const settings = await new TasteSettingsStore({ dir }).init();
  assert.deepEqual(settings.get(), { enabled: false, provider: 'auto', model: null, effort: null });

  await settings.set({ provider: 'pi', model: 'qwen/qwen3-max', effort: 'high' });
  assert.deepEqual((await new TasteSettingsStore({ dir }).init()).get(), { enabled: false, provider: 'auto', model: null, effort: null });
  // 공급자를 바꾸면 이전 공급자의 모델·추론을 버린다. 자동은 늘 비운다.
  assert.deepEqual(await settings.set({ provider: 'codex' }), { enabled: false, provider: 'auto', model: null, effort: null });
  assert.deepEqual(await settings.set({ provider: 'auto', model: 'gpt-6-sol', effort: 'low' }), { enabled: false, provider: 'auto', model: null, effort: null });

  for (const patch of [{ provider: 'openai' }, { model: '' }, { model: ' padded ' }, { model: 'x'.repeat(201) }, { effort: 'ultra' }, {}, null]) {
    await assert.rejects(settings.set(patch), { code: 'TASTE_SETTINGS_INVALID' }, JSON.stringify(patch));
  }
  assert.deepEqual(settings.get(), { enabled: false, provider: 'auto', model: null, effort: null }, 'a rejected change keeps the old value');

  // 손상된 칸은 그 칸만 기본값이 된다.
  writeFileSync(path.join(dir, 'taste-settings.json'), JSON.stringify({ enabled: true, provider: 'claude', model: 42, effort: 'max' }));
  assert.deepEqual((await new TasteSettingsStore({ dir }).init()).get(), { enabled: true, provider: 'auto', model: null, effort: null });
  assert.deepEqual(JSON.parse(readFileSync(path.join(dir, 'taste-settings.json'), 'utf8')), { schemaVersion: 1, enabled: true, provider: 'auto', model: null, effort: null });
});

test('closing lets a nearly finished learn land, then aborts what still runs and drops what waits', async (t) => {
  let release;
  const slow = new Promise((resolve) => { release = resolve; });
  const h = harness(t, {
    outputs: {
      rau: async (call) => {
        if (call.prompt.includes('느린')) await slow;
        else await new Promise((resolve) => setTimeout(resolve, 30));
        return styleNote('본문은 한다체 사용');
      },
    },
  });
  await h.learner.turnEnded({ threadId: 'th1', turnId: 't1', documentId: 'doc-1', userText: '빠른 턴', learn: true });
  await until(() => h.calls.length === 1, 'fast run');
  await h.learner.close({ graceMs: 500 });
  assert.equal(h.frames.length, 1, 'the run that finished within the grace still shows');

  t.after(() => release());
  const slowHarness = harness(t, {
    outputs: {
      rau: async (call) => {
        if (call.prompt.includes('느린')) await slow;
        return '{"ops":[]}';
      },
    },
  });
  await slowHarness.learner.turnEnded({ threadId: 'th1', turnId: 't1', documentId: 'doc-1', userText: '느린 턴', learn: true });
  await until(() => slowHarness.calls.length === 1, 'slow run');
  const waiting = assert.rejects(
    slowHarness.learner.learnHistory({ documentId: 'doc-1', signals: [{ kind: 'history', at, after: '가', userText: '나' }] }),
    { code: 'TASTE_CLOSED' },
  );
  const started = Date.now();
  await slowHarness.learner.close({ graceMs: 50 });
  assert.ok(Date.now() - started < 1_500, 'close is bounded');
  await waiting;
  await assert.rejects(slowHarness.learner.learnHistory({ documentId: 'doc-1', signals: [] }), { code: 'TASTE_CLOSED' });
  await settle();
  assert.equal(slowHarness.calls.length, 1, 'nothing runs after close');
});

test('signals that arrive during a failed turn, or while a debounce fires mid-turn, are still learned', async (t) => {
  let turnRunning = true;
  const h = harness(t, { running: () => turnRunning, outputs: { rau: '{"ops":[]}' } });
  h.signals.onReviewSignals((documentId, info) => h.learner.signalsArrived(documentId, info));
  h.signals.ingest({ threadId: 'th1', turnId: 't1', documentId: 'doc-1', signals: [{ kind: 'rejected', at, after: '회의는 화요일에 열립니다.' }] });
  await settle();
  assert.equal(h.calls.length, 0, 'nothing runs while the turn runs');
  turnRunning = false;
  await h.learner.turnEnded({ threadId: 'th1', turnId: 't2', documentId: 'doc-1', userText: '중단된 요청', learn: false });
  await until(() => h.calls.length === 1, 'signal run after the failed turn');
  assert.match(h.calls[0].prompt, /회의는 화요일에 열립니다/);
  assert.doesNotMatch(h.calls[0].prompt, /중단된 요청/, 'a failed turn is not learned');

  h.signals.ingest({ threadId: 'th1', turnId: 't3', documentId: 'doc-1', signals: [{ kind: 'undone', at }] });
  turnRunning = true;
  await settle();
  assert.equal(h.calls.length, 1, 'the debounce that fired mid-turn waits');
  turnRunning = false;
  await until(() => h.calls.length === 2, 're-armed signal run');
});

test('a run learns only its own chat\'s signals; another chat\'s signals get their own run under that chat', async (t) => {
  const h = harness(t, {
    outputs: { rau: (call) => (call.prompt.includes('보고서를 제출한다') ? styleNote('본문은 한다체 사용') : '{"ops":[]}') },
  });
  h.signals.ingest({ threadId: 'chat-1', turnId: 'c1-t1', documentId: 'doc-1', signals: [{ kind: 'rewritten', at, after: '보고서를 제출해 주시기 바랍니다.', userText: '보고서를 제출한다.' }] });
  h.signals.ingest({ threadId: 'chat-2', turnId: 'c2-t1', documentId: 'doc-1', signals: [{ kind: 'rejected', at, after: '표를 지웁니다.' }] });
  await h.learner.turnEnded({ threadId: 'chat-2', turnId: 'c2-t2', documentId: 'doc-1', userText: '표를 다시 넣어 줘', learn: true });
  await until(() => h.calls.length === 2, 'chat-2 turn and chat-1 signal run');
  assert.match(h.calls[0].prompt, /표를 지웁니다/);
  assert.doesNotMatch(h.calls[0].prompt, /보고서를 제출한다/, 'chat-1 review stays out of chat-2 learning');
  assert.match(h.calls[1].prompt, /보고서를 제출한다/);
  await until(() => h.frames.length === 1, 'chat-1 marker');
  assert.deepEqual([h.frames[0].threadId, h.frames[0].turnId], ['chat-1', 'c1-t1']);
});

test('a history job runs in arrival order, not behind turns that arrive while it waits', async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const h = harness(t, {
    outputs: {
      rau: async (call) => {
        if (call.prompt.includes('첫 턴')) await gate;
        return '{"ops":[]}';
      },
    },
  });
  await h.learner.turnEnded({ threadId: 'th1', turnId: 't1', documentId: 'doc-1', userText: '첫 턴', learn: true });
  await until(() => h.calls.length === 1, 'first run');
  const history = h.learner.learnHistory({ documentId: 'doc-1', signals: [{ kind: 'history', at, after: '기록 앞', userText: '기록 뒤' }] });
  await h.learner.turnEnded({ threadId: 'th1', turnId: 't2', documentId: 'doc-1', userText: '둘째 턴', learn: true });
  await h.learner.turnEnded({ threadId: 'th2', turnId: 't1', documentId: 'doc-1', userText: '다른 채팅 턴', learn: true });
  release();
  const result = await history;
  assert.deepEqual(result.items, []);
  await until(() => h.calls.length === 4, 'all runs');
  assert.match(h.calls[1].prompt, /기록 뒤/, 'the history job goes right after the running job');
  assert.match(h.calls[2].prompt, /둘째 턴/);
  assert.match(h.calls[3].prompt, /다른 채팅 턴/);
});

test('a turn waiting for review learns once, together with the accept and the rewrite', async (t) => {
  const h = harness(t, { outputs: { rau: styleNote('본문은 한다체 사용') } });
  h.signals.onReviewSignals((documentId, info) => h.learner.signalsArrived(documentId, info));
  const key = await h.store.resolveKey({ documentId: 'doc-1' });
  await h.learner.turnEnded({
    threadId: 'th1', turnId: 't1', documentId: 'doc-1', userText: '회의 안내 문단을 써 줘', answer: '썼습니다.', learn: true, reviewPending: true,
  });
  await settle();
  assert.deepEqual(h.frames, []);
  assert.equal(h.calls.length, 0, 'no run while the edits wait for review');

  h.signals.ingest({ threadId: 'th1', turnId: 't1', documentId: 'doc-1', signals: [{ kind: 'accepted', at, after: '회의는 화요일에 열립니다.' }] });
  await settle();
  assert.equal(h.calls.length, 0, 'an accept alone waits for a rewrite');
  h.signals.ingest({ threadId: 'th1', turnId: 't1', documentId: 'doc-1', signals: [{ kind: 'rewritten', at, after: '참석해 주시기 바랍니다.', userText: '참석 바란다.' }] });
  await until(() => h.frames.length === 1, 'learned marker');
  await settle();
  assert.equal(h.calls.length, 1, 'one call for the turn, the accept and the rewrite');
  assert.match(h.calls[0].prompt, /회의 안내 문단을 써 줘[^]*회의는 화요일에 열립니다[^]*참석 바란다/);
  assert.deepEqual([h.frames[0].threadId, h.frames[0].turnId], ['th1', 't1']);
  assert.deepEqual(h.frames[0].items.map((item) => [item.text, item.origin]), [['본문은 한다체 사용', 'learned']]);
  const learned = (await h.store.read(key)).entries.find((entry) => entry.subject === '문체.종결');
  assert.deepEqual(learned.source, { threadId: 'th1', turnId: 't1', kind: 'turn' });
});

test('accepts alone never call the model: the window closes into one run with the waiting turn, or nothing', async (t) => {
  const h = harness(t, { outputs: { rau: '{"ops":[]}' } });
  h.signals.onReviewSignals((documentId, info) => h.learner.signalsArrived(documentId, info));
  await h.learner.turnEnded({ threadId: 'th1', turnId: 't1', documentId: 'doc-1', userText: '공지 문단을 써 줘', learn: true, reviewPending: true });
  h.signals.ingest({ threadId: 'th1', turnId: 't1', documentId: 'doc-1', signals: [{ kind: 'accepted', at, after: '공지합니다.' }] });
  await settle();
  assert.equal(h.calls.length, 0);
  await until(() => h.calls.length === 1, 'accept window closed');
  assert.match(h.calls[0].prompt, /공지 문단을 써 줘[^]*공지합니다/);

  // 기다리는 턴이 없으면 수락은 다음 계기까지 남는다.
  h.signals.ingest({ threadId: 'th1', turnId: 't2', documentId: 'doc-1', signals: [{ kind: 'accepted', at, after: '마감은 금요일입니다.' }] });
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(h.calls.length, 1);
  assert.equal(h.signals.peekSignals('doc-1').length, 1);
  await h.learner.turnEnded({ threadId: 'th1', turnId: 't3', documentId: 'doc-1', userText: '다음 요청', learn: true });
  await until(() => h.calls.length === 2, 'next turn');
  assert.match(h.calls[1].prompt, /마감은 금요일입니다/, 'the next turn takes the buffered accept');
});

test('a waiting turn runs alone after the cap, or rides along with the next turn of its chat', async (t) => {
  const h = harness(t, { outputs: { rau: '{"ops":[]}' } });
  await h.learner.turnEnded({ threadId: 'th1', turnId: 't1', documentId: 'doc-1', userText: '표를 고쳐 줘', learn: true, reviewPending: true });
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(h.calls.length, 0, 'still waiting for review');
  await until(() => h.calls.length === 1, 'cap fallback');
  assert.match(h.calls[0].prompt, /표를 고쳐 줘/);

  await h.learner.turnEnded({ threadId: 'th1', turnId: 't2', documentId: 'doc-1', userText: '제목을 바꿔 줘', learn: true, reviewPending: true });
  await h.learner.turnEnded({ threadId: 'th1', turnId: 't3', documentId: 'doc-1', userText: '요약을 붙여 줘', learn: true });
  await until(() => h.calls.length === 2, 'next turn');
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(h.calls.length, 2, 'the waiting turn was absorbed, not run again');
  assert.match(h.calls[1].prompt, /earlier_turns":\[\{"user_message":"제목을 바꿔 줘"[^]*"user_message":"요약을 붙여 줘"/);
});

test('undo prefers the hub\'s own change list and refuses another document\'s learning', async (t) => {
  const h = harness(t, { outputs: { rau: styleNote('본문은 한다체 사용') } });
  await h.learner.turnEnded({ threadId: 'th1', turnId: 't1', documentId: 'doc-1', userText: '한다체로', learn: true });
  await until(() => h.frames.length === 1, 'marker');
  const { key, learnId, items } = h.frames[0];
  const otherKey = await h.store.resolveKey({ documentId: 'doc-2' });
  await assert.rejects(h.learner.undo({ key: otherKey, documentId: 'doc-2', learnId, changes: [] }), { code: 'MEMORY_KEY_MISMATCH' });
  // Studio 가 보낸 목록이 비었거나 틀려도 허브가 남긴 목록으로 되돌린다.
  const forged = [{ op: 'remove', entryId: 'mem_000000000000', prev: { id: 'mem_000000000000', kind: 'fact', subject: '사실.가짜', text: '가짜', origin: 'user' } }];
  const result = await h.learner.undo({ key, documentId: 'doc-1', learnId, changes: forged });
  assert.deepEqual(result.reverted, [items[0].entryId]);
  assert.deepEqual((await h.store.read(key)).entries, []);
  // 허브가 다시 떠 목록을 잃으면 표시의 목록을 쓰되, 모양이 틀린 변경은 받지 않는다.
  await assert.rejects(h.learner.undo({ key, documentId: 'doc-1', learnId: 'learn_unknown', changes: [{ op: 'add', entryId: 'mem_000000000001' }] }), { code: 'MEMORY_INVALID' });
});

test('a one-off request never overwrites a confirmed note; general phrasing or repeated rewrites do', async (t) => {
  let noteId = '';
  const h = harness(t, { outputs: { rau: () => json([{ op: 'update', id: noteId, text: '본문은 합니다체 사용' }]) } });
  h.signals.onReviewSignals((documentId, info) => h.learner.signalsArrived(documentId, info));
  const key = await h.store.resolveKey({ documentId: 'doc-1' });
  const note = { op: 'add', kind: 'style', subject: '문체.종결', text: '본문은 한다체 사용' };
  await h.store.apply(key, [note], { origin: 'learned' });
  noteId = (await h.store.apply(key, [note], { origin: 'learned' })).changes[0].entryId;
  const current = async () => (await h.store.read(key)).entries.find((entry) => entry.id === noteId);
  assert.equal((await current()).strength, 2);

  await h.learner.turnEnded({ threadId: 'th1', turnId: 't1', documentId: 'doc-1', userText: '이번 문단은 합니다체로', answer: '바꿨습니다.', learn: true });
  await until(() => h.calls.length === 1, 'scoped run');
  await settle();
  assert.equal(h.frames.length, 0, 'the scoped request changes nothing');
  assert.equal((await current()).text, '본문은 한다체 사용');

  await h.learner.turnEnded({ threadId: 'th1', turnId: 't2', documentId: 'doc-1', userText: '앞으로 본문은 합니다체로', answer: '알겠습니다.', learn: true });
  await until(() => h.frames.length === 1, 'general phrasing marker');
  assert.equal((await current()).text, '본문은 합니다체 사용');

  await h.store.apply(key, [{ op: 'update', id: noteId, text: '본문은 한다체 사용' }], { origin: 'learned' });
  h.signals.ingest({ threadId: 'th1', turnId: 't3', documentId: 'doc-1', signals: [
    { kind: 'rewritten', at, after: '회의를 진행한다.', userText: '회의를 진행합니다.' },
    { kind: 'rewritten', at, after: '자료를 지참한다.', userText: '자료를 지참해 주시기 바랍니다.' },
  ] });
  await until(() => h.frames.length === 2, 'rewrite marker');
  assert.equal((await current()).text, '본문은 합니다체 사용');

  // 한 번 배운 기억도 범위를 한정한 말로는 바뀌지 않는다. 같은 subject 의 add 도 그 기억을 고치는 것이다.
  const once = [{ id: noteId, subject: '문체.종결', origin: 'learned', strength: 1 }];
  const swap = [{ op: 'add', kind: 'style', subject: '문체.종결', text: '본문은 한다체 사용' }];
  assert.deepEqual(guardTasteOps(swap, once, { userTexts: ['여기는 한다체로 써 줘'], signals: [{ kind: 'accepted' }] }), []);
  assert.deepEqual(guardTasteOps(swap, once, { userTexts: ['본문은 한다체로 써 줘'] }), swap);
  assert.deepEqual(guardTasteOps(swap, [{ ...once[0], origin: 'user' }], { userTexts: ['본문은 한다체로 써 줘'] }), []);
});

test('live corrections require independent evidence, persist provenance, promote after three documents, and undo', async t => {
  const h = harness(t, { outputs: { rau: call => {
    const ids = [...call.prompt.matchAll(/"evidenceId":"([^"]+)"/g)].map(m => m[1]);
    return json([
      { op: 'add', kind: 'term', subject: '용어.고객', text: "'고객' 대신 '이용자'로 쓴다", userCandidate: true, evidenceIds: ids },
      { op: 'add', kind: 'fact', subject: '사실.금액', text: '금액은 100원', evidenceIds: ids },
      { op: 'add', kind: 'style', subject: '문체.근거없음', text: '문장은 짧게 쓴다', evidenceIds: ['unknown'] },
    ]);
  } } });
  h.signals.onReviewSignals((documentId, info) => h.learner.signalsArrived(documentId, info));
  const send = documentId => h.signals.ingest({ threadId: 'th1', documentId, signals: [0, 1].map(i => ({
    kind: 'correction', at, evidenceId: `${documentId}-${i}`, passageId: `p${i}`,
    after: `고객 ${i}`, userText: `이용자 ${i}`,
  })) });
  for (const [i, doc] of ['live-a', 'live-b', 'live-c'].entries()) {
    send(doc);
    await until(() => h.frames.length === i + 1, doc);
    if (i < 2) {
      assert.equal((await h.userMemory.read()).rules.length, 0);
      const key = await h.store.resolveKey({ documentId: doc });
      const memory = await h.store.read(key);
      assert.equal(memory.entries.length, 1);
      assert.equal(memory.entries[0].kind, 'term');
      assert.equal(memory.entries[0].source.corrections.length, 2);
      const reopened = new DocumentMemoryStore({ dir: h.store.dir });
      assert.equal((await reopened.read(key)).entries[0].source.corrections.length, 2);
    }
  }
  assert.equal((await h.userMemory.read()).rules.length, 1);
  const frame = h.frames.at(-1);
  await h.learner.undo({ key: frame.key, documentId: 'live-c', learnId: frame.learnId, changes: frame.changes });
  assert.equal((await h.userMemory.read()).rules.length, 0);
  send('live-c'); await settle();
  assert.equal(h.calls.length, 3, 'duplicate delivery does not spend another model call');
});


test('correction evidence cannot teach other categories, cite invented evidence, or count one passage twice', () => {
  const signals = [0, 1].map(i => ({ evidenceId: `e${i}`, passageId: 'same', after: '고객', userText: '이용자' }));
  const op = { op: 'add', kind: 'term', subject: '용어.고객', text: '이용자로 쓴다', evidenceIds: ['e0', 'e1'] };
  assert.equal(correctionOps([op], signals, []).length, 0);
  signals[1].passageId = 'another';
  assert.equal(correctionOps([op], signals, []).length, 1);
  assert.equal(correctionOps([{ ...op, kind: 'fact' }], signals, []).length, 0);
  assert.equal(correctionOps([{ ...op, evidenceIds: ['e0', 'invented'] }], signals, []).length, 0);
  assert.equal(correctionOps([{ op: 'dampen', id: 'rule_123456789012', evidenceIds: ['e0', 'e1'] }], signals, []).length, 0);
});

test('corrections conflicting with long-term memory remain document-local', async t => {
  const h = harness(t, { outputs: { rau: call => json([{ op: 'add', kind: 'style', subject: '문체.종결',
    text: '합니다체로 쓴다', userCandidate: true, evidenceIds: [...call.prompt.matchAll(/"evidenceId":"([^"]+)"/g)].map(m => m[1]) }]) } });
  await h.userMemory.escalate({ kind: 'style', subject: '문체.종결', text: '한다체로 쓴다', docKeys: ['prior-a', 'prior-b'] });
  const initial = (await h.userMemory.read()).rules;
  h.signals.onReviewSignals((doc, info) => h.learner.signalsArrived(doc, info));
  for (let d = 0; d < 3; d++) {
    h.signals.ingest({ threadId: 'th1', documentId: `conflict-${d}`, signals: [0, 1].map(i => ({
      kind: 'correction', at, evidenceId: `e${d}-${i}`, passageId: `p${i}`, after: '제출한다', userText: '제출합니다',
    })) });
    await until(() => h.frames.length === d + 1, 'local correction');
  }
  assert.deepEqual((await h.userMemory.read()).rules, initial);
});


test('a next-request flush waits for corrections and failed inference keeps evidence for retry', async t => {
  let fail = true;
  const h = harness(t, { outputs: { rau: call => {
    if (fail) return 'invalid output';
    return json([{ op: 'add', kind: 'term', subject: '용어.고객', text: '이용자로 쓴다', userCandidate: true,
      evidenceIds: [...call.prompt.matchAll(/"evidenceId":"([^"]+)"/g)].map(m => m[1]) }]);
  } } });
  h.signals.ingest({ threadId: 'th1', documentId: 'retry-doc', signals: [0, 1].map(i => ({
    kind: 'correction', at, evidenceId: `retry-${i}`, passageId: `p${i}`, after: '고객', userText: '이용자',
  })) });
  await h.learner.flushCorrections({ documentId: 'retry-doc', threadId: 'th1' });
  assert.equal(h.signals.peekSignals('retry-doc').length, 2);
  assert.equal(h.frames.length, 0);
  fail = false;
  await h.learner.flushCorrections({ documentId: 'retry-doc', threadId: 'th1' });
  const key = await h.store.resolveKey({ documentId: 'retry-doc' });
  assert.equal((await h.store.read(key)).entries[0].text, '이용자로 쓴다');
  assert.equal(h.frames.length, 1);
});

const citedIds = (call) => [...call.prompt.matchAll(/"evidenceId":"([^"]+)"/g)].map((m) => m[1]);
const correctionFrame = (documentId) => ({ threadId: 'th1', documentId, signals: [0, 1].map((i) => ({
  kind: 'correction', at, evidenceId: `${documentId}-${i}`, passageId: `p${i}`, after: `고객 ${i}`, userText: `이용자 ${i}`,
})) });

test('corrections in a batch keep what the user said in the same turn, and only cited ops need evidence', async (t) => {
  const h = harness(t, { outputs: { rau: (call) => json([
    { op: 'add', kind: 'decision', subject: '결정.예산', text: '예산표는 분기별로 나눔' },
    { op: 'add', kind: 'term', subject: '용어.고객', text: "'고객' 대신 '이용자'로 쓴다", evidenceIds: citedIds(call) },
  ]) } });
  h.signals.ingest(correctionFrame('mixed-doc'));
  await h.learner.turnEnded({ threadId: 'th1', turnId: 't1', documentId: 'mixed-doc', userText: '앞으로 예산표는 분기별로 나눠 줘', answer: '네', learn: true });
  await until(() => h.frames.length === 1, 'mixed turn learned');
  const { entries } = await h.store.read(await h.store.resolveKey({ documentId: 'mixed-doc' }));
  const decision = entries.find((entry) => entry.kind === 'decision');
  const term = entries.find((entry) => entry.kind === 'term');
  assert.equal(decision.stated, true, 'the general statement is still recorded as stated');
  assert.equal(decision.source.corrections, undefined);
  assert.equal(term.source.corrections.length, 2);
  assert.notEqual(term.stated, true);

  const op = { op: 'add', kind: 'term', subject: '용어.고객', text: '이용자로 쓴다' };
  assert.equal(groundedOps([op], [], [], false).length, 0, 'a corrections-only run has nothing else to ground an uncited op');
  assert.equal(groundedOps([op], [], [], true).length, 1);
});

test('correction provenance survives the subject and text being tidied before storing', async (t) => {
  const h = harness(t, { outputs: { rau: (call) => json([
    { op: 'add', kind: 'term', subject: '용어.  고객', text: "  '고객' 대신   '이용자'로 쓴다 ", evidenceIds: citedIds(call) },
  ]) } });
  h.signals.onReviewSignals((documentId, info) => h.learner.signalsArrived(documentId, info));
  h.signals.ingest(correctionFrame('tidy-doc'));
  await until(() => h.frames.length === 1, 'learned');
  const { entries } = await h.store.read(await h.store.resolveKey({ documentId: 'tidy-doc' }));
  assert.equal(entries[0].source.corrections.length, 2, 'the three-document promotion rule needs this provenance');
});

test('a next-request flush keeps evidence while Rau is unreachable and never delays a message without corrections', async (t) => {
  let reachable = false;
  let release = () => {};
  let hold = false;
  const h = harness(t, {
    usable: () => reachable,
    outputs: { rau: async (call) => {
      if (hold) await new Promise((resolve) => { release = resolve; });
      return json(hold ? [] : [{ op: 'add', kind: 'term', subject: '용어.고객', text: '이용자로 쓴다', evidenceIds: citedIds(call) }]);
    } },
  });
  h.signals.ingest(correctionFrame('reach-doc'));
  await h.learner.flushCorrections({ documentId: 'reach-doc', threadId: 'th1' });
  assert.equal(h.signals.peekSignals('reach-doc').length, 2);
  reachable = true;
  await h.learner.flushCorrections({ documentId: 'reach-doc', threadId: 'th1' });
  const key = await h.store.resolveKey({ documentId: 'reach-doc' });
  assert.equal((await h.store.read(key)).entries.length, 1);

  hold = true;
  await h.learner.turnEnded({ threadId: 'th1', turnId: 't2', documentId: 'reach-doc', userText: '표를 고쳐 줘', answer: '네', learn: true });
  await until(() => h.calls.length === 2, 'a run is in flight');
  const started = Date.now();
  await h.learner.flushCorrections({ documentId: 'reach-doc', threadId: 'th1' });
  assert.ok(Date.now() - started < 500, 'no corrections to wait for');
  release();
});
