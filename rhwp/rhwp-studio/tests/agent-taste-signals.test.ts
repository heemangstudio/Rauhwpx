// 취향 학습 신호: 승인·거절에서 짝 만들기, 고쳐 쓰기 감지(문단 재탐색·기다림·사소한 수정·통째 교체·
// 지운 문단·다른 채팅의 글·저장), 실행 취소, chat-review-signal 묶어 보내기.
import test from 'node:test';
import assert from 'node:assert/strict';
import type { PendingChangeSet, PendingEditsChangeEvent, PendingOp, ReviewSignal } from '../src/agent/types.ts';
import type { DocumentPosition } from '../src/core/types.ts';
import {
  ReviewSignalOutbox,
  TasteSignalCollector,
  outcomeSignals,
  type ReviewSignalFrame,
} from '../src/agent/taste-signals.ts';
import { RewriteTracker, classifyRewrite, type ParagraphReader } from '../src/agent/taste-rewrites.ts';

/** 본문 구역 0 의 문단 배열로 읽는 가짜 문서 */
function fakeDocument(paragraphs: string[]): { paras: string[]; reader: ParagraphReader } {
  const doc = { paras: paragraphs, reader: null as unknown as ParagraphReader };
  doc.reader = {
    count: () => doc.paras.length,
    text: (ref) => doc.paras[ref.paraIdx] ?? null,
  };
  return doc;
}

/** 손으로 돌리는 시계와 타이머 */
function fakeClock() {
  let now = Date.parse('2026-10-22T00:00:00Z');
  let seq = 0;
  const timers = new Map<number, { at: number; run: () => void }>();
  return {
    now: () => now,
    setTimer: (run: () => void, ms: number) => {
      const id = ++seq;
      timers.set(id, { at: now + ms, run });
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: (handle: ReturnType<typeof setTimeout>) => { timers.delete(handle as unknown as number); },
    advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].run();
      }
      now = end;
    },
  };
}

function fakeBus() {
  const handlers = new Map<string, Set<(payload?: unknown) => void>>();
  return {
    on(name: string, cb: (payload?: unknown) => void) {
      const set = handlers.get(name) ?? new Set();
      set.add(cb);
      handlers.set(name, set);
      return () => set.delete(cb);
    },
    emit(name: string, payload?: unknown) {
      for (const cb of handlers.get(name) ?? []) cb(payload);
    },
  };
}

function fakePending() {
  const listeners = new Set<(e: PendingEditsChangeEvent) => void>();
  let sets: PendingChangeSet[] = [];
  return {
    onChange(cb: (e: PendingEditsChangeEvent) => void) {
      listeners.add(cb);
      return () => { listeners.delete(cb); };
    },
    getChangeSets: () => sets,
    stage(set: PendingChangeSet) {
      sets = [...sets, set];
      this.fire({ type: 'ops-changed' });
    },
    /** 매니저처럼 set 을 먼저 빼고 결과를 알린다. */
    settle(set: PendingChangeSet, e: PendingEditsChangeEvent) {
      sets = sets.filter((s) => s !== set);
      this.fire(e);
    },
    fire(e: PendingEditsChangeEvent) {
      for (const cb of listeners) cb(e);
    },
  };
}

const range = (paraIdx: number, start: number, end: number, endPara = paraIdx) => ({
  sectionIdx: 0, startParaIdx: paraIdx, startCharOffset: start, endParaIdx: endPara, endCharOffset: end,
});

function replaceOp(id: string, paraIdx: number, start: number, text: string, deletedText: string): PendingOp {
  return {
    kind: 'replace', id, agent: 'claude', range: range(paraIdx, start, start + text.length), text, deletedText,
    charShapeId: null, paraShapeIds: [], snapshotId: null,
  };
}

function changeSet(id: string, ops: PendingOp[]): PendingChangeSet {
  return { id, agent: 'claude', status: 'awaiting-review', ops, createdAt: 0 };
}

const at = '2026-10-22T00:00:00.000Z';

test('승인은 한 문단의 op 들을 문단 전·후 글로 묶고, 거절은 op 글을 짝짓는다', () => {
  const doc = fakeDocument(['회의는 화요일에 진행합니다. 장소는 3층 회의실입니다.']);
  const ops = [
    replaceOp('a', 0, 4, '화요일', '월요일'),
    replaceOp('b', 0, 20, '3층', '2층'),
  ];
  assert.deepEqual(outcomeSignals('accepted', ops, { at, turnId: 't1', reader: doc.reader }), [{
    kind: 'accepted',
    at,
    before: '회의는 월요일에 진행합니다. 장소는 2층 회의실입니다.',
    after: '회의는 화요일에 진행합니다. 장소는 3층 회의실입니다.',
    paraIdx: 0,
    turnId: 't1',
  }]);
  assert.deepEqual(outcomeSignals('rejected', ops, { at }), [
    { kind: 'rejected', at, before: '월요일 … 2층', after: '화요일 … 3층', paraIdx: 0 },
  ]);
});

test('문서 자리에 에이전트 글이 없으면 op 글로 짝짓고, 같은 짝·사용자가 덮은 op 은 한 번만·빼고 낸다', () => {
  const doc = fakeDocument(['이용자 안내', '이용자 문의', '사용자가 바꾼 문단']);
  const ops = [
    replaceOp('a', 0, 0, '이용자', '고객'),
    replaceOp('b', 1, 0, '이용자', '고객'),
    replaceOp('c', 2, 0, '이용자', '고객'),
  ];
  const signals = outcomeSignals('accepted', ops, { at, reader: fakeDocument(['x', 'y', 'z']).reader, exclude: new Set(['c']) });
  assert.deepEqual(signals, [{ kind: 'accepted', at, before: '고객', after: '이용자', paraIdx: 0 }]);
  // 서식만 바꾼 op 은 글의 취향이 아니다.
  const format: PendingOp = { kind: 'format', id: 'f', agent: 'claude', range: range(0, 0, 3), format: { bold: true }, inverse: {} };
  assert.deepEqual(outcomeSignals('accepted', [format], { at, reader: doc.reader }), []);
});

function trackerHarness(paragraphs: string[]) {
  const doc = fakeDocument(paragraphs);
  const clock = fakeClock();
  const emitted: ReviewSignal[] = [];
  let caret: DocumentPosition | null = null;
  const tracker = new RewriteTracker({
    reader: doc.reader,
    caret: () => caret,
    emit: (signal) => emitted.push(signal),
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  return {
    doc, clock, emitted, tracker,
    placeCaret(paraIdx: number | null) {
      caret = paraIdx === null ? null : { sectionIndex: 0, paragraphIndex: paraIdx, charOffset: 0 };
    },
  };
}

test('고쳐 쓴 문단은 밀린 번호에서 다시 찾고, 커서가 머무는 동안은 5초 쉴 때까지 기다린다', () => {
  const agentText = '이번 분기 매출은 전년 대비 크게 증가하였습니다.';
  const h = trackerHarness(['머리말', agentText, '맺음말']);
  h.tracker.track([{ ref: { sectionIdx: 0, paraIdx: 1 }, turnId: 't1' }]);

  // 사용자가 위에 문단 둘을 넣고, 에이전트 문단을 고쳐 쓴다. 커서는 그 문단에 있다.
  h.doc.paras = ['머리말', '새 문단', '또 새 문단', '이번 분기 매출은 전년보다 늘었다.', '맺음말'];
  h.placeCaret(3);
  h.tracker.noteUserEdit();
  h.clock.advance(3_000);
  assert.equal(h.emitted.length, 0, '커서가 머무는 동안은 내지 않는다');
  h.clock.advance(2_500);
  assert.deepEqual(h.emitted, [{
    kind: 'rewritten', at: new Date(h.clock.now() - 500).toISOString(),
    after: agentText, userText: '이번 분기 매출은 전년보다 늘었다.', paraIdx: 3, turnId: 't1',
  }]);
  assert.equal(h.tracker.size, 0, '낸 문단은 더 지켜보지 않는다');
});

test('커서가 고친 문단을 떠나면 5초를 기다리지 않고 낸다', () => {
  const h = trackerHarness(['보고서는 금요일까지 제출해 주시기 바랍니다.', '다음 문단']);
  h.tracker.track([{ ref: { sectionIdx: 0, paraIdx: 0 } }]);
  h.doc.paras[0] = '보고서는 금요일까지 내 주세요.';
  h.placeCaret(0);
  h.tracker.noteUserEdit();
  h.clock.advance(1_000);
  assert.equal(h.emitted.length, 0);
  h.placeCaret(1);
  h.clock.advance(1_000);
  assert.equal(h.emitted.length, 1);
  assert.equal(h.emitted[0].userText, '보고서는 금요일까지 내 주세요.');
});

test('공백·한 글자 오타·에이전트 구간 밖 수정·되돌림·통째 교체는 고쳐 쓰기가 아니다', () => {
  const agent = '본 사업은 지역 주민의 삶의 질 향상을 목표로 합니다.';
  assert.equal(classifyRewrite(agent, '본 사업은  지역 주민의 삶의 질 향상을 목표로 합니다. '), 'trivial');
  assert.equal(classifyRewrite(agent, '본 사업은 지역 주민의 삶의 질 향상을 목표로 함니다.'), 'trivial');
  // 두 글자 종결 어미 교체는 취향이다.
  assert.equal(classifyRewrite(agent, '본 사업은 지역 주민의 삶의 질 향상을 목표로 한다.'), 'rewrite');
  assert.equal(classifyRewrite(agent, '전혀 다른 내용으로 새로 썼다.'), 'replaced');
  assert.equal(classifyRewrite(agent, '본 사업의 목표', { beforeText: '본 사업의 목표' }), 'reverted');
  // 에이전트는 '지역 주민의'(6~12)만 썼고, 사용자는 문장 끝을 고쳤다.
  assert.equal(classifyRewrite(agent, '본 사업은 지역 주민의 삶의 질 향상이 목표입니다.', { spans: [[6, 12]] }), 'outside');

  const h = trackerHarness([agent, '두 번째 에이전트 문단입니다.']);
  h.tracker.track([{ ref: { sectionIdx: 0, paraIdx: 0 } }, { ref: { sectionIdx: 0, paraIdx: 1 } }]);
  h.doc.paras = ['본 사업은 지역 주민의 삶의 질 향상을 목표로 함니다.', '완전히 새로 쓴 글'];
  h.tracker.noteUserEdit();
  h.clock.advance(6_000);
  assert.deepEqual(h.emitted, []);
  assert.equal(h.tracker.size, 1, '오타만 고친 문단은 계속 지켜보고, 통째로 바꾼 문단은 놓는다');
  // 오타 수정이 새 기준이 된다 — 뒤의 진짜 고쳐 쓰기는 그 글과 견준다.
  h.doc.paras[0] = '본 사업은 주민 삶의 질 향상을 목표로 한다.';
  h.tracker.noteUserEdit();
  h.clock.advance(6_000);
  assert.equal(h.emitted.length, 1);
  assert.equal(h.emitted[0].after, '본 사업은 지역 주민의 삶의 질 향상을 목표로 함니다.');
});

test('지켜보기는 10분 뒤에 끝난다', () => {
  const h = trackerHarness(['에이전트가 쓴 문장은 이렇게 길게 이어집니다.']);
  h.tracker.track([{ ref: { sectionIdx: 0, paraIdx: 0 } }]);
  h.clock.advance(11 * 60_000);
  h.doc.paras[0] = '에이전트가 쓴 문장을 사용자가 짧게 줄였다.';
  h.tracker.noteUserEdit();
  h.clock.advance(6_000);
  assert.deepEqual(h.emitted, []);
});

function collectorHarness(paragraphs: string[], shared?: { doc: ReturnType<typeof fakeDocument>; clock: ReturnType<typeof fakeClock>; bus: ReturnType<typeof fakeBus> }) {
  const doc = shared?.doc ?? fakeDocument(paragraphs);
  const clock = shared?.clock ?? fakeClock();
  const bus = shared?.bus ?? fakeBus();
  const pending = fakePending();
  const instance = { current: 1 };
  const sent: Array<{ signals: ReviewSignal[]; threadId: string; turnId: string | null }> = [];
  const context = { threadId: 'th1', turnId: 'turn-1' as string | null };
  const undoStack: object[] = [];
  const redoStack: object[] = [];
  const collector = new TasteSignalCollector({
    learningEnabled: () => true,
    pending,
    eventBus: bus,
    reader: doc.reader,
    caret: () => null,
    turnContext: () => ({ ...context }),
    documentInstance: () => instance.current,
    history: () => ({
      peekUndoTop: () => (undoStack.at(-1) as { type: string } | undefined) ?? null,
      hasRedoEntry: (entry) => redoStack.includes(entry),
    }),
    emit: (signals, ctx) => sent.push({ signals, ...ctx }),
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  return { doc, clock, bus, pending, sent, context, collector, undoStack, redoStack, instance };
}

test('승인 신호는 set 이 생긴 턴에 묶이고, 전체 모드 즉시 확정·무효화는 신호 없이 지나간다', () => {
  const h = collectorHarness(['계약 기간은 2년으로 한다.', '두 번째']);
  const set = changeSet('cs1', [replaceOp('a', 0, 7, '2년', '1년')]);
  h.pending.stage(set);
  // 턴이 끝나고 다음 턴 id 가 바뀐 뒤에 승인한다 (에이전트 모드).
  h.context.turnId = null;
  h.pending.settle(set, { type: 'approved', changeSetId: 'cs1' });
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].turnId, 'turn-1');
  assert.deepEqual(h.sent[0].signals[0], {
    kind: 'accepted', at, before: '계약 기간은 1년으로 한다.', after: '계약 기간은 2년으로 한다.', paraIdx: 0, turnId: 'turn-1',
  });
  assert.equal(h.collector.trackedParagraphs, 1, '승인한 문단은 고쳐 쓰기를 지켜본다');

  const direct = changeSet('cs2', [replaceOp('b', 1, 0, '둘째', '두 번째')]);
  h.doc.paras[1] = '둘째';
  h.pending.stage(direct);
  h.pending.settle(direct, { type: 'approved', changeSetId: 'cs2', direct: true });
  const dropped = changeSet('cs3', [replaceOp('c', 0, 0, 'x', 'y')]);
  h.pending.stage(dropped);
  h.pending.settle(dropped, { type: 'invalidated', reason: 'document loaded', changeSetId: 'cs3' });
  assert.equal(h.sent.length, 1);
  assert.equal(h.collector.trackedParagraphs, 2, '전체 모드로 쓴 문단도 지켜본다');

  // 다음 턴이 시작되면 고친 문단을 바로 내고 지켜보기를 그만둔다.
  h.doc.paras[0] = '계약 기간은 이 년으로 정한다.';
  h.bus.emit('document-mutated', 'input-handler-edit');
  h.collector.noteTurnStart();
  assert.equal(h.sent.length, 2);
  assert.equal(h.sent[1].signals[0].kind, 'rewritten');
  assert.equal(h.collector.trackedParagraphs, 0);
});

test('에이전트 적용을 실행 취소하거나 그 턴 이전으로 되돌리면 undone 을 에이전트 글과 함께 낸다', () => {
  const h = collectorHarness(['첫 문장입니다.', '둘째 문장입니다.']);
  h.collector.noteTurnKey('th1', 'msg-1');
  const first = changeSet('cs1', [replaceOp('a', 0, 0, '첫 문장', '처음 문장')]);
  h.pending.stage(first);
  const command = { type: 'snapshot:agentApplyChangeSet' };
  h.undoStack.push(command);
  h.pending.settle(first, { type: 'approved', changeSetId: 'cs1' });
  h.sent.length = 0;

  // 사용자가 실행 취소한다.
  h.undoStack.pop();
  h.redoStack.push(command);
  h.bus.emit('history-jumped');
  assert.deepEqual(h.sent.map((s) => s.signals), [[{ kind: 'undone', at, after: '첫 문장', turnId: 'turn-1' }]]);
  assert.equal(h.collector.trackedParagraphs, 0, '되돌린 문단은 고쳐 쓰기로 보지 않는다');
  h.bus.emit('history-jumped');
  assert.equal(h.sent.length, 1, '같은 실행 취소를 두 번 내지 않는다');

  // 다음 요청의 턴이 쓰고, 사용자가 "이 작업 전으로 되돌리기"를 누른다.
  h.context.turnId = 'turn-2';
  h.collector.noteTurnKey('th1', 'msg-2');
  const second = changeSet('cs2', [replaceOp('b', 1, 0, '둘째', '두 번째')]);
  h.pending.stage(second);
  h.pending.settle(second, { type: 'approved', changeSetId: 'cs2', direct: true });
  h.collector.noteTurnRestored('th1', 'msg-2');
  assert.deepEqual(h.sent.at(-1)?.signals, [{ kind: 'undone', at, after: '둘째', turnId: 'turn-2' }]);
});

/** 에이전트 문단 하나를 승인한다 (insert op, 문단 끝에 '\n' + text). */
function approveInsert(h: ReturnType<typeof collectorHarness>, id: string, afterPara: number, text: string): void {
  const prevLength = h.doc.paras[afterPara].length;
  h.doc.paras.splice(afterPara + 1, 0, text);
  const op: PendingOp = {
    kind: 'insert', id: `${id}-op`, agent: 'claude', range: range(afterPara, prevLength, text.length, afterPara + 1),
    text: `\n${text}`, charShapeId: null, paraShapeIds: [], snapshotId: null,
  } as PendingOp;
  const set = changeSet(id, [op]);
  h.pending.stage(set);
  const command = { type: 'snapshot:agentApplyChangeSet' };
  h.undoStack.push(command);
  h.pending.settle(set, { type: 'approved', changeSetId: id });
}

const userEdit = (h: ReturnType<typeof collectorHarness>) => h.bus.emit('document-mutated', 'input-handler-edit');
const rewrites = (h: ReturnType<typeof collectorHarness>) =>
  h.sent.flatMap((s) => s.signals).filter((signal) => signal.kind === 'rewritten');

test('저장·이름 바꾸기는 지켜보기와 승인 대기를 지우지 않고, 문서가 바뀌면 지운다', () => {
  const h = collectorHarness(['회의는 화요일입니다.']);
  approveInsert(h, 'cs1', 0, '보고서는 금요일까지 제출해 주시기 바랍니다.');
  // 아직 검토 대기인 다른 set 이 있다.
  const waiting = changeSet('cs2', [replaceOp('b', 0, 4, '화요일', '월요일')]);
  h.pending.stage(waiting);
  // Cmd+S — 같은 문서 인스턴스에서 document-context-changed 가 온다.
  h.bus.emit('document-context-changed');
  h.pending.settle(waiting, { type: 'approved', changeSetId: 'cs2' });
  assert.equal(h.sent.at(-1)?.signals[0].kind, 'accepted', '저장 전에 생긴 set 의 승인도 낸다');

  h.doc.paras[1] = '보고서는 금요일까지 꼭 내 주세요.';
  userEdit(h);
  h.clock.advance(6_000);
  assert.deepEqual(rewrites(h).map((signal) => signal.userText), ['보고서는 금요일까지 꼭 내 주세요.']);

  approveInsert(h, 'cs3', 1, '참석 대상은 팀장급 이상입니다.');
  h.instance.current = 2;
  h.bus.emit('document-context-changed');
  assert.equal(h.collector.trackedParagraphs, 0, '다른 문서가 열리면 지켜보기를 버린다');
});

test('에이전트 문단을 지우면 고쳐 쓰기가 아니고, 닮은 이웃 문단을 대신 잡지 않는다', () => {
  const h = collectorHarness(['회의는 화요일입니다.', '자료는 회의 전날까지 담당자에게 제출해 주시기 바랍니다.']);
  approveInsert(h, 'cs1', 0, '보고서는 금요일까지 제출해 주시기 바랍니다.');
  h.doc.paras.splice(1, 1);
  userEdit(h);
  h.clock.advance(6_000);
  assert.deepEqual(rewrites(h), []);
  assert.equal(h.collector.trackedParagraphs, 0);

  // 앞 문단과 합치고(첫머리에서 Backspace) 고쳐 쓴 것은 합친 글의 제 몫으로 견준다.
  const m = collectorHarness(['회의는 화요일입니다.', '끝']);
  approveInsert(m, 'cs1', 0, '보고서는 금요일까지 제출해 주시기 바랍니다.');
  m.doc.paras = ['회의는 화요일입니다.보고서는 금요일까지 꼭 내 주세요.', '끝'];
  userEdit(m);
  m.clock.advance(6_000);
  assert.deepEqual(rewrites(m).map((signal) => signal.userText), ['보고서는 금요일까지 꼭 내 주세요.']);
});

test('번호가 밀린 뒤에도 실행 취소는 그 쓰기의 지켜보기를 거둔다', () => {
  const h = collectorHarness(['머리말']);
  approveInsert(h, 'cs1', 0, '보고서는 금요일까지 제출해 주시기 바랍니다.');
  // 사용자가 위에 문단을 넣어 에이전트 문단이 1 → 2 로 밀리고, 지켜보기가 그 자리로 옮겨 간다.
  h.doc.paras.splice(1, 0, '새 문단');
  userEdit(h);
  h.clock.advance(6_000);
  assert.equal(h.collector.trackedParagraphs, 1);
  h.redoStack.push(h.undoStack.pop()!);
  h.bus.emit('history-jumped');
  assert.equal(h.sent.at(-1)?.signals[0].kind, 'undone');
  assert.equal(h.collector.trackedParagraphs, 0);
});

test('같은 문서의 다른 채팅이 고친 글은 사용자의 고쳐 쓰기가 아니다', () => {
  const a = collectorHarness(['머리말']);
  const b = collectorHarness([], { doc: a.doc, clock: a.clock, bus: a.bus });
  b.context.threadId = 'th2';
  approveInsert(a, 'cs-a', 0, '보고서는 금요일까지 제출해 주시기 바랍니다.');

  // 채팅 B 가 같은 문단을 다듬고(스테이징 = 'agent-*'), 사용자가 승인한다 (입력기 경로로 온다).
  a.doc.paras[1] = '보고서는 금요일까지 꼭 제출해 주십시오.';
  a.bus.emit('document-mutated', 'agent-pending-edit');
  const polish = changeSet('cs-b', [replaceOp('p', 1, 0, a.doc.paras[1], '보고서는 금요일까지 제출해 주시기 바랍니다.')]);
  b.pending.stage(polish);
  userEdit(a);
  b.pending.settle(polish, { type: 'approved', changeSetId: 'cs-b' });
  // 그 뒤 사용자가 다른 곳을 친다.
  a.doc.paras[0] = '머리말입니다';
  userEdit(a);
  a.clock.advance(6_000);
  assert.deepEqual(rewrites(a), [], 'A 는 B 의 글을 사용자 글로 보지 않는다');

  // 다른 채팅이 위에 문단을 넣어 밀린 문단을 사용자가 고치면 그건 고쳐 쓰기다.
  const c = collectorHarness(['머리말', '끝']);
  approveInsert(c, 'cs-c', 0, '보고서는 금요일까지 제출해 주시기 바랍니다.');
  c.doc.paras.splice(1, 0, '다른 채팅이 넣은 문단');
  c.bus.emit('document-mutated', 'agent-pending-edit');
  c.clock.advance(0);
  c.doc.paras[2] = '보고서는 금요일까지 꼭 내 주세요.';
  userEdit(c);
  c.clock.advance(6_000);
  assert.deepEqual(rewrites(c).map((signal) => [signal.paraIdx, signal.userText]), [[2, '보고서는 금요일까지 꼭 내 주세요.']]);
});

test('긴 문단의 고쳐 쓰기는 바뀐 곳 둘레만 보내 두 글이 같아지지 않는다', () => {
  const head = '가나다라마바사아자차카타파하'.repeat(50);
  const agentText = `${head} 결론적으로 본 사업은 반드시 추진되어야 합니다.`;
  const h = collectorHarness(['머리말']);
  approveInsert(h, 'cs1', 0, agentText);
  h.doc.paras[1] = `${head} 그래서 이 사업은 꼭 해야 한다.`;
  userEdit(h);
  h.clock.advance(6_000);
  const [signal] = rewrites(h);
  assert.ok(signal, '고쳐 쓰기를 낸다');
  assert.ok([...signal.after!].length <= 600 && [...signal.userText!].length <= 600);
  assert.notEqual(signal.after, signal.userText);
  assert.match(signal.after!, /반드시 추진되어야/);
  assert.match(signal.userText!, /꼭 해야 한다/);
});

function outboxHarness() {
  const clock = fakeClock();
  const frames: ReviewSignalFrame[] = [];
  const state = { connected: true, documentId: 'doc-1' as string | null };
  const outbox = new ReviewSignalOutbox({
    send: (frame) => {
      if (!state.connected) return false;
      frames.push(frame);
      return true;
    },
    canSend: () => state.connected,
    documentId: () => state.documentId,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  return { clock, frames, state, outbox };
}

const signal = (i: number, extra: Partial<ReviewSignal> = {}): ReviewSignal => ({ kind: 'accepted', at, after: `글 ${i}`, ...extra });

test('신호는 2초 모아 턴마다 20개씩 프레임에 싣고, 긴 글은 600자로 자른다', () => {
  const h = outboxHarness();
  h.outbox.push({ threadId: 'th1', documentId: 'doc-1', turnId: 'turn-1' }, Array.from({ length: 23 }, (_, i) => signal(i)));
  h.outbox.push({ threadId: 'th1', documentId: 'doc-1', turnId: 'turn-2' }, [signal(99, { after: '가'.repeat(700) })]);
  h.clock.advance(1_900);
  assert.equal(h.frames.length, 0);
  h.clock.advance(200);
  assert.deepEqual(h.frames.map((f) => [f.turnId, f.signals.length]), [['turn-1', 20], ['turn-1', 3], ['turn-2', 1]]);
  assert.equal(h.frames[0].documentId, 'doc-1');
  assert.equal([...h.frames[2].signals[0].after!].length, 600);
});

test('끊긴 동안은 쌓아 두었다가 다시 연결되면 보내고, 다른 문서로 바뀐 신호는 버린다', () => {
  const h = outboxHarness();
  h.state.connected = false;
  h.outbox.push({ threadId: 'th1', documentId: 'doc-1' }, [signal(1)]);
  h.clock.advance(3_000);
  assert.equal(h.frames.length, 0);
  h.state.connected = true;
  h.outbox.noteConnected();
  h.clock.advance(0);
  assert.equal(h.frames.length, 1);

  h.outbox.push({ threadId: 'th1', documentId: 'doc-1' }, [signal(2)]);
  h.state.documentId = 'doc-2';
  h.clock.advance(3_000);
  assert.equal(h.frames.length, 1);
  assert.equal(h.outbox.pending, 0);

  // 1분 넘게 끊겨 있던 신호는 버린다.
  h.state.connected = false;
  h.outbox.push({ threadId: 'th1', documentId: 'doc-2' }, [signal(3)]);
  h.clock.advance(61_000);
  h.state.connected = true;
  h.outbox.noteConnected();
  h.clock.advance(0);
  assert.equal(h.frames.length, 1);
});
