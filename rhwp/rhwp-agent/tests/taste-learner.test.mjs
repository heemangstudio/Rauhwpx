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
  TasteSettingsStore,
  appendRauInstruction,
  createTasteLearner,
  guardTasteOps,
  newTasteTurn,
  noteTasteTurnEvent,
} from '../taste-learner.mjs';

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
function harness(t, { outputs = {}, settings = { enabled: true }, running = () => false, promote, timing = {} } = {}) {
  const dir = tempDir(t);
  const store = new DocumentMemoryStore({ dir });
  const signals = createTasteSignalBuffer();
  const calls = [];
  const frames = [];
  const changedEvents = [];
  const proposals = [];
  const learner = createTasteLearner({
    store,
    signals,
    settings: () => settings,
    routes: () => ({ hosted: {
      usable: () => true,
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
    promote: promote ?? ((proposal) => {
      proposals.push(proposal);
      return `draft-${proposals.length}`;
    }),
    debounceMs: 30,
    acceptIdleMs: 150,
    acceptCapMs: 400,
    deferredCapMs: 300,
    ...timing,
  });
  t.after(() => learner.close());
  return { store, signals, learner, calls, frames, changedEvents, proposals };
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

test('a preference learned in two documents is proposed once; a rejected one is never proposed again', async (t) => {
  const userCandidate = json([{ op: 'add', kind: 'style', subject: '문체.종결', text: '본문은 한다체 사용', userCandidate: true }]);
  const h = harness(t, { outputs: { rau: userCandidate } });
  await h.learner.turnEnded({ threadId: 'a', turnId: 't1', documentId: 'doc-a', userText: '한다체로', learn: true });
  await until(() => h.frames.length === 1, 'doc a');
  assert.equal(h.proposals.length, 0, 'one document is not enough');
  assert.equal(h.frames[0].proposal, undefined);

  await h.learner.turnEnded({ threadId: 'b', turnId: 't1', documentId: 'doc-b', userText: '여기도 한다체로', learn: true });
  await until(() => h.frames.length === 2, 'doc b');
  assert.equal(h.proposals.length, 1);
  assert.equal(h.proposals[0].line, '본문은 한다체 사용');
  assert.equal(h.proposals[0].documents, 2);
  assert.deepEqual(h.frames[1].proposal, { draftId: 'draft-1' });
  assert.match(h.calls[1].prompt, /known_user_subjects":\[\{"subject":"문체\.종결","text":"본문은 한다체 사용"\}\]/, 'the other document\'s preference is offered for reuse');

  await h.learner.promotionSettled(h.proposals[0].refs, 'rejected');
  await h.learner.turnEnded({ threadId: 'c', turnId: 't1', documentId: 'doc-c', userText: '한다체', learn: true });
  await until(() => h.frames.length === 3, 'doc c');
  assert.equal(h.proposals.length, 1, 'a rejected preference is not proposed again');
  const keyC = h.frames[2].key;
  assert.equal((await h.store.read(keyC)).entries[0].promotionDeclined, true);
});

test('a busy proposal slot leaves the candidate for a later run', async (t) => {
  let free = false;
  const proposals = [];
  const h = harness(t, {
    outputs: {
      rau: (call) => json([
        { op: 'add', kind: 'style', subject: '문체.종결', text: '본문은 한다체 사용', userCandidate: true },
        ...(call.prompt.includes('셋') ? [{ op: 'add', kind: 'term', subject: '용어.고객', text: "'고객' 대신 '이용자'로 통일" }] : []),
      ]),
    },
    promote: (proposal) => {
      proposals.push(proposal);
      return free ? 'draft-late' : null;
    },
  });
  await h.learner.turnEnded({ threadId: 'a', turnId: 't1', documentId: 'doc-a', userText: '하나', learn: true });
  await until(() => h.frames.length === 1, 'a');
  await h.learner.turnEnded({ threadId: 'b', turnId: 't1', documentId: 'doc-b', userText: '둘', learn: true });
  await until(() => h.frames.length === 2, 'b');
  assert.equal(proposals.length, 1);
  assert.equal(h.frames[1].proposal, undefined);
  free = true;
  await h.learner.turnEnded({ threadId: 'b', turnId: 't2', documentId: 'doc-b', userText: '셋', learn: true });
  await until(() => h.frames.length === 3, 'b again');
  assert.deepEqual(h.frames[2].proposal, { draftId: 'draft-late' });
  await h.learner.promotionSettled(proposals.at(-1).refs, 'confirmed', { text: proposals.at(-1).line });
  const entries = (await h.store.read(h.frames[2].key)).entries;
  assert.equal(entries.find((entry) => entry.subject === '문체.종결').promoted, true);
  assert.equal(entries.find((entry) => entry.subject === '용어.고객').promoted, undefined);
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

test('AGENTS.md lines go under one Rau-0.1 heading and are never duplicated', () => {
  const first = appendRauInstruction('# 지시\n- 짧게 답하기\n', '본문은 한다체 사용');
  assert.equal(first, '# 지시\n- 짧게 답하기\n\n## Rau-0.1\n- 본문은 한다체 사용\n');
  const second = appendRauInstruction(`${first}\n## 기타\n- 표는 가운데\n`, "'고객' 대신 '이용자'로 통일");
  assert.match(second, /## Rau-0\.1\n- 본문은 한다체 사용\n- '고객' 대신 '이용자'로 통일\n\n## 기타/);
  assert.equal(appendRauInstruction(first, '본문은 한다체 사용'), null);
  assert.equal(appendRauInstruction('', '본문은 한다체 사용'), '## Rau-0.1\n- 본문은 한다체 사용\n');
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

test('promotion counts only the same preference text; a decline sticks to that text', async (t) => {
  const h = harness(t, { outputs: { rau: (call) => styleNote(call.prompt.includes('"user_message":"합니다체로"') ? '본문은 합니다체 사용' : '본문은 한다체 사용') } });
  const end = async (documentId, userText) => {
    const before = h.frames.length;
    await h.learner.turnEnded({ threadId: documentId, turnId: 't1', documentId, userText, learn: true });
    await until(() => h.frames.length === before + 1, documentId);
    return h.frames.at(-1).key;
  };
  const a = await end('doc-a', '한다체로');
  await end('doc-b', '합니다체로');
  assert.equal(h.proposals.length, 0, 'two different preferences on one subject are not a shared taste');
  const c = await end('doc-c', '한다체로');
  assert.equal(h.proposals.length, 1);
  assert.equal(h.proposals[0].line, '본문은 한다체 사용');
  assert.deepEqual(h.proposals[0].refs.map((ref) => ref.key).sort(), [a, c].sort());

  await h.learner.promotionSettled(h.proposals[0].refs, 'rejected', { text: h.proposals[0].line });
  await end('doc-d', '합니다체로');
  assert.equal(h.proposals.length, 2, 'declining 한다체 does not block 합니다체');
  assert.equal(h.proposals[1].line, '본문은 합니다체 사용');
  const e = await end('doc-e', '한다체로');
  assert.equal(h.proposals.length, 2, 'the declined text is never proposed again');
  assert.equal((await h.store.read(e)).entries[0].promotionDeclined, true);
});

test('a line already in AGENTS.md marks its notes promoted and the next candidate is still proposed', async (t) => {
  const proposals = [];
  const h = harness(t, {
    outputs: {
      rau: json([
        { op: 'add', kind: 'style', subject: '문체.종결', text: '본문은 한다체 사용', userCandidate: true },
        { op: 'add', kind: 'style', subject: '문장부호.쉼표', text: '쉼표 뒤 한 칸 띄움', userCandidate: true },
      ]),
    },
    promote: (proposal) => {
      proposals.push(proposal);
      return proposal.subject === '문체.종결' ? { exists: true } : 'draft-comma';
    },
  });
  await h.learner.turnEnded({ threadId: 'a', turnId: 't1', documentId: 'doc-a', userText: '하나', learn: true });
  await until(() => h.frames.length === 1, 'a');
  await h.learner.turnEnded({ threadId: 'b', turnId: 't1', documentId: 'doc-b', userText: '둘', learn: true });
  await until(() => h.frames.length === 2, 'b');
  assert.deepEqual(proposals.map((proposal) => proposal.subject), ['문체.종결', '문장부호.쉼표']);
  assert.deepEqual(h.frames[1].proposal, { draftId: 'draft-comma' });
  for (const frame of h.frames) {
    const entries = (await h.store.read(frame.key)).entries;
    assert.equal(entries.find((entry) => entry.subject === '문체.종결').promoted, true);
  }
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
  assert.equal((await current()).evidence, 2);

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
  const once = [{ id: noteId, subject: '문체.종결', origin: 'learned', evidence: 1 }];
  const swap = [{ op: 'add', kind: 'style', subject: '문체.종결', text: '본문은 한다체 사용' }];
  assert.deepEqual(guardTasteOps(swap, once, { userTexts: ['여기는 한다체로 써 줘'], signals: [{ kind: 'accepted' }] }), []);
  assert.deepEqual(guardTasteOps(swap, once, { userTexts: ['본문은 한다체로 써 줘'] }), swap);
  assert.deepEqual(guardTasteOps(swap, [{ ...once[0], origin: 'user' }], { userTexts: ['본문은 한다체로 써 줘'] }), []);
});
