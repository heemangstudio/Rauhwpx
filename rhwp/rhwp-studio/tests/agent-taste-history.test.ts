// 기록에서 배우기(Rau-0.1): 출처 기록 남기기·상한·기간·설정, 에이전트의 뒤 고침(글 없는 지우기 포함)이 옮기는
// 기준, 다른 세션에서 문단 다시 찾기(지운 문단·빈 이웃·짧은 같은 글은 짝 없음), 검토 대기 중 멈춤, 허브가 받은
// 짝만 남기기, 나누거나 합친 문단의 재시도, 문서를 연 뒤 한 번 도는 자동 실행.
import test from 'node:test';
import assert from 'node:assert/strict';
import type { PendingChangeSet, PendingEditsChangeEvent, PendingOp, ReviewSignal, TasteHistoryResult } from '../src/agent/types.ts';
import { TasteSignalCollector } from '../src/agent/taste-signals.ts';
import type { ParagraphReader } from '../src/agent/taste-rewrites.ts';
import {
  AutoHistoryTrigger,
  ProvenanceLog,
  TasteHistoryMiner,
  addProvenance,
  cachedReader,
  memoryProvenanceBackend,
  mineProvenance,
  provenanceObserver,
  type HistoryBlocker,
  type ProvenanceBackend,
  type ProvenanceDocument,
  type ProvenanceRecord,
} from '../src/agent/taste-history.ts';

function fakeDocument(paragraphs: string[]): { paras: string[]; reader: ParagraphReader } {
  const doc = { paras: paragraphs, reader: null as unknown as ParagraphReader };
  doc.reader = {
    count: () => doc.paras.length,
    text: (ref) => doc.paras[ref.paraIdx] ?? null,
  };
  return doc;
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
      for (const cb of listeners) cb({ type: 'ops-changed' });
    },
    settle(set: PendingChangeSet, e: PendingEditsChangeEvent) {
      sets = sets.filter((s) => s !== set);
      for (const cb of listeners) cb(e);
    },
  };
}

function insertOp(id: string, paraIdx: number, offset: number, text: string): PendingOp {
  const lines = text.split('\n');
  return {
    kind: 'insert', id, agent: 'claude',
    range: {
      sectionIdx: 0,
      startParaIdx: paraIdx,
      startCharOffset: offset,
      endParaIdx: paraIdx + lines.length - 1,
      endCharOffset: lines.length > 1 ? lines.at(-1)!.length : offset + text.length,
    },
    text, charShapeId: null, paraShapeIds: [], snapshotId: null,
  } as PendingOp;
}

/** 문단 하나 안의 바꾸기. text 가 비었으면 delete_range 와 같은 글 없는 지우기다. */
function replaceOp(id: string, paraIdx: number, offset: number, text: string, deletedText: string): PendingOp {
  return {
    kind: 'replace', id, agent: 'claude',
    range: { sectionIdx: 0, startParaIdx: paraIdx, startCharOffset: offset, endParaIdx: paraIdx, endCharOffset: offset + text.length },
    text, deletedText, charShapeId: null, paraShapeIds: [],
  } as PendingOp;
}

const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

const AGENT = '회의는 화요일 오후 세 시에 본관에서 열립니다. 모두 참석해 주시기 바랍니다.';
const USER = '회의는 화요일 오후 세 시에 본관에서 열린다. 모두 참석해 주기 바란다.';

/** 첫 세션에서 [머리말, 에이전트 글, 맺음말] 의 가운데 문단을 쓴 기록 */
function record(overrides: Partial<ProvenanceRecord> = {}): ProvenanceRecord {
  return {
    id: 'prv_a', documentId: 'doc-1', at: '2026-10-22T01:00:00.000Z', agentText: AGENT, spans: null,
    ref: { sectionIdx: 0, paraIdx: 1 }, lastText: AGENT, prevText: '머리말', nextText: '맺음말', count: 3,
    threadId: 'th1', turnId: 'turn-1',
    ...overrides,
  };
}

function documentWith(records: ProvenanceRecord[]): ProvenanceDocument {
  return { documentId: 'doc-1', updatedAt: 0, records: structuredClone(records) };
}

/** 실제 신호 모으기 + 출처 기록 — 에이전트 쓰기를 스테이징하고 승인하는 손잡이 */
function collectorHarness(paragraphs: string[], options: { recording?: () => boolean } = {}) {
  const doc = fakeDocument(paragraphs);
  const bus = fakeBus();
  const pending = fakePending();
  const log = new ProvenanceLog(memoryProvenanceBackend());
  const undoStack: object[] = [];
  const redoStack: object[] = [];
  const collector = new TasteSignalCollector({
    pending,
    eventBus: bus,
    reader: doc.reader,
    caret: () => null,
    turnContext: () => ({ threadId: 'th1', turnId: 'turn-1' }),
    history: () => ({
      peekUndoTop: () => (undoStack.at(-1) as { type: string } | undefined) ?? null,
      hasRedoEntry: (entry) => redoStack.includes(entry),
    }),
    emit: () => {},
    observer: provenanceObserver(log, () => 'doc-1', { reader: doc.reader, recording: options.recording ?? (() => true) }),
  });
  let seq = 0;
  /** 에이전트 쓰기 하나 — 미리보기로 문서를 바꾸고 승인(direct 면 전체 모드의 바로 확정)한다. 실행 취소 항목을 돌려준다. */
  async function agentWrite(ops: PendingOp[], nextParas: string[], { direct = false } = {}) {
    const set: PendingChangeSet = { id: `cs${++seq}`, agent: 'claude', status: 'awaiting-review', ops, createdAt: 0 };
    pending.stage(set);
    doc.paras = nextParas;
    bus.emit('document-mutated', 'agent-apply');
    const command = { type: 'snapshot:agentApplyChangeSet' };
    undoStack.push(command);
    pending.settle(set, { type: 'approved', changeSetId: set.id, ...(direct ? { direct: true } : {}) } as PendingEditsChangeEvent);
    await settled();
    return command;
  }
  async function undo(command: object, restored: string[]) {
    undoStack.splice(undoStack.indexOf(command), 1);
    redoStack.push(command);
    doc.paras = restored;
    bus.emit('history-jumped');
    await settled();
  }
  return { doc, bus, log, collector, agentWrite, undo };
}

function minerFor(doc: { reader: ParagraphReader }, log: ProvenanceLog, overrides: Partial<ConstructorParameters<typeof TasteHistoryMiner>[0]> = {}) {
  const sent: ReviewSignal[][] = [];
  const miner = new TasteHistoryMiner({
    log,
    reader: doc.reader,
    documentId: () => 'doc-1',
    send: async (_documentId, pairs) => {
      sent.push(pairs);
      return { ok: true, learnId: 'learn_1', key: 'k', items: [], changes: [], accepted: pairs.map((_, index) => index) };
    },
    pause: async () => {},
    ...overrides,
  });
  return { miner, sent };
}

test('승인한 에이전트 글을 앞뒤 문단과 함께 출처 기록에 남기고, 실행 취소하면 지운다', async () => {
  const h = collectorHarness(['머리말', '맺음말']);
  // 문단 끝에 '\n…' 을 붙인 삽입 — 새 문단만 에이전트 글이다.
  const command = await h.agentWrite([insertOp('a', 0, 3, `\n${AGENT}`)], ['머리말', AGENT, '맺음말']);
  const stored = await h.log.read('doc-1');
  assert.equal(stored.records.length, 1);
  const [written] = stored.records;
  assert.equal(written.agentText, AGENT);
  assert.deepEqual([written.ref.paraIdx, written.prevText, written.nextText, written.count], [1, '머리말', '맺음말', 3]);
  assert.deepEqual([written.threadId, written.turnId], ['th1', 'turn-1']);

  // 실행 취소로 에이전트 글이 사라졌다 — 그 기록은 사용자 고침의 재료가 아니다.
  await h.undo(command, ['머리말', '맺음말']);
  assert.equal((await h.log.read('doc-1')).records.length, 0);
  h.collector.dispose();
});

test('대화에서 배우기가 꺼져 있으면 에이전트 글을 출처 기록에 남기지 않는다', async () => {
  const h = collectorHarness(['머리말', '맺음말'], { recording: () => false });
  await h.agentWrite([insertOp('a', 0, 3, `\n${AGENT}`)], ['머리말', AGENT, '맺음말']);
  assert.equal((await h.log.read('doc-1')).records.length, 0);
  h.collector.dispose();
});

test('에이전트가 뒤 턴에 자기 글을 지우거나(글 없는 바꾸기) 전체 모드로 고쳐도 사용자 고침으로 보내지 않는다', async () => {
  const h = collectorHarness(['머리말', '맺음말']);
  await h.agentWrite([insertOp('a', 0, 3, `\n${AGENT}`)], ['머리말', AGENT, '맺음말']);
  // 다음 턴 — 지켜보기는 끝났다. 에이전트가 둘째 문장을 지운다 (delete_range = 빈 바꾸기).
  h.collector.noteTurnStart();
  const cut = ' 모두 참석해 주시기 바랍니다.';
  const trimmed = AGENT.slice(0, AGENT.length - cut.length);
  const trim = await h.agentWrite([replaceOp('b', 1, trimmed.length, '', cut)], ['머리말', trimmed, '맺음말']);
  const [rebased] = (await h.log.read('doc-1')).records;
  assert.equal(rebased.minedText, trimmed, '기준을 에이전트가 고친 글로 옮긴다');
  const { miner, sent } = minerFor(h.doc, h.log);
  assert.deepEqual(await miner.run({ auto: true }), { status: 'empty' });

  // 그 지우기를 실행 취소했다 — 되살아난 글도 사용자가 쓴 것이 아니다.
  await h.undo(trim, ['머리말', AGENT, '맺음말']);
  assert.deepEqual(await miner.run({ auto: true }), { status: 'empty' });

  // 전체 모드의 바로 확정도 같다.
  h.collector.noteTurnStart();
  const second = '꼭 오셔서 의견을 들려주시기 바랍니다.';
  const direct = AGENT.replace('모두 참석해 주시기 바랍니다.', second);
  await h.agentWrite([replaceOp('c', 1, AGENT.indexOf('모두'), second, '모두 참석해 주시기 바랍니다.')], ['머리말', direct, '맺음말'], { direct: true });
  assert.deepEqual(await miner.run({ auto: true }), { status: 'empty' });
  assert.equal(sent.length, 0);

  // 그 뒤 사용자가 에이전트 글을 고친 것은 짝이 된다.
  h.doc.paras = ['머리말', direct.replace(second, '꼭 와서 의견을 들려주기 바란다.'), '맺음말'];
  assert.equal((await miner.run({ auto: true })).status, 'learned');
  assert.equal(sent.length, 1);
  assert.equal(sent[0]![0]!.userText, h.doc.paras[1]);
  h.collector.dispose();
});

test('같은 문서에 검토를 기다리는 변경이 있으면 자동·수동 모두 돌지 않고, 미리보기 글로 기록을 바꾸지 않는다', async () => {
  // 다른 채팅의 에이전트가 기록한 문단을 미리보기로 바꿔 둔 상태 — 사용자 고침처럼 보인다.
  const filler = Array.from({ length: 450 }, (_, index) => `채움 문단 ${index}`);
  const doc = fakeDocument([...filler, '머리말', USER, '맺음말']);
  const log = new ProvenanceLog(memoryProvenanceBackend());
  await log.update('doc-1', (document) => addProvenance(document, [record({ ref: { sectionIdx: 0, paraIdx: 451 }, count: 453 })]));
  let blocker: HistoryBlocker = 'review';
  const { miner, sent } = minerFor(doc, log, { blocked: () => blocker });
  assert.deepEqual(await miner.run({ auto: true }), { status: 'review' });
  assert.deepEqual(await miner.run({ auto: false }), { status: 'review' }, '시트의 단추도 막는다');
  // 읽는 사이 검토가 생겨도 멈춘다.
  blocker = null;
  const pausing = minerFor(doc, log, { blocked: () => blocker, pause: async () => { blocker = 'review'; } });
  assert.deepEqual(await pausing.miner.run({ auto: false }), { status: 'review' });
  assert.equal(sent.length + pausing.sent.length, 0);
  const [untouched] = (await log.read('doc-1')).records;
  assert.deepEqual([untouched.lastText, untouched.minedText, untouched.ref.paraIdx], [AGENT, undefined, 451]);

  // 턴만 돌면 자동 실행은 미루고 시트의 단추는 돈다.
  blocker = 'turn';
  assert.deepEqual(await miner.run({ auto: true }), { status: 'busy' });
  assert.equal((await miner.run({ auto: false })).status, 'learned');
});

test('출처 기록은 문서마다 최근 기록만, 문서도 최근에 쓴 것만 남기고, 쓰기마다 다른 문서를 읽지 않는다', async () => {
  let clock = Date.parse('2026-10-22T02:00:00Z');
  const inner = memoryProvenanceBackend();
  const calls = { get: [] as string[], list: 0 };
  const backend: ProvenanceBackend = {
    ...inner,
    get: (documentId) => { calls.get.push(documentId); return inner.get(documentId); },
    list: () => { calls.list += 1; return inner.list(); },
  };
  const log = new ProvenanceLog(backend, { perDocument: 3, documents: 2, now: () => ++clock });
  for (let i = 0; i < 5; i++) {
    await log.update('doc-1', (document) => addProvenance(document, [record({ id: `prv_${i}`, at: new Date(Date.UTC(2026, 9, 22, 1, i)).toISOString() })]));
  }
  assert.deepEqual((await log.read('doc-1')).records.map((item) => item.id), ['prv_2', 'prv_3', 'prv_4']);
  await log.update('doc-2', (document) => addProvenance(document, [record({ id: 'prv_b', documentId: 'doc-2' })]));
  assert.deepEqual(new Set(calls.get), new Set(['doc-1', 'doc-2']));
  assert.equal(calls.list, 0, '상한 안에서는 문서 목록을 읽지 않는다');
  await log.update('doc-3', (document) => addProvenance(document, [record({ id: 'prv_c', documentId: 'doc-3' })]));
  assert.equal(calls.list, 1);
  assert.deepEqual((await inner.list()).map((row) => row.documentId).sort(), ['doc-2', 'doc-3']);
});

test('90일이 지난 출처 기록은 버린다', async () => {
  const now = Date.parse('2026-10-22T00:00:00Z');
  const backend = memoryProvenanceBackend();
  await backend.put(documentWith([
    record({ id: 'prv_old', at: new Date(now - 91 * 86_400_000).toISOString() }),
    record({ id: 'prv_new', at: new Date(now - 89 * 86_400_000).toISOString() }),
  ]));
  await backend.put({ ...documentWith([record({ id: 'prv_gone', documentId: 'doc-2', at: new Date(now - 120 * 86_400_000).toISOString() })]), documentId: 'doc-2' });
  const log = new ProvenanceLog(backend, { now: () => now });
  assert.deepEqual((await log.read('doc-1')).records.map((item) => item.id), ['prv_new']);
  // 기간이 지난 기록만 남은 문서는 그 문서를 고칠 때 지운다.
  assert.equal(await log.update('doc-2', () => false), false);
  assert.equal(await backend.get('doc-2'), null);
});

test('다른 세션에서 번호가 밀린 문단을 다시 찾아 고친 짝을 내고, 지운 문단은 짝을 내지 않는다', () => {
  // 앞에 문단 둘이 늘었고 사용자가 종결을 한다체로 바꿨다.
  const later = fakeDocument(['새 표', '새 설명', '머리말', USER, '맺음말']);
  const document = documentWith([record()]);
  const { pairs } = mineProvenance(document, cachedReader(later.reader));
  assert.equal(pairs.length, 1);
  assert.deepEqual(pairs[0].signal, { kind: 'history', at: '2026-10-22T01:00:00.000Z', after: AGENT, userText: USER, paraIdx: 3, turnId: 'turn-1' });
  assert.equal(document.records[0].ref.paraIdx, 3, '기록의 자리를 지금 문서로 옮긴다');

  // 문단을 지웠다 — 비슷한 뒤 문단을 고쳐 쓴 글로 잡지 않고 기록을 버린다.
  const similar = '회의 자료는 화요일 오후 세 시까지 본관에서 나눠 드립니다.';
  const deleted = documentWith([record({ nextText: similar, count: 4 })]);
  const { pairs: none } = mineProvenance(deleted, cachedReader(fakeDocument(['머리말', similar, '맺음말']).reader));
  assert.deepEqual(none, []);
  assert.equal(deleted.records.length, 0);

  // 사소한 고침(한 글자)은 짝이 아니라 기준만 옮긴다.
  const typo = documentWith([record()]);
  const { pairs: trivial } = mineProvenance(typo, cachedReader(fakeDocument(['머리말', AGENT.replace('본관', '본괸'), '맺음말']).reader));
  assert.deepEqual(trivial, []);
  assert.equal(typo.records[0].minedText, AGENT.replace('본관', '본괸'));
});

test('빈 이웃 문단과 짧은 같은 글로는 다른 문단에 옮겨 붙지 않는다', () => {
  // 빈 문단 사이의 에이전트 글을 지웠고, 사용자가 다른 자리에 비슷한 문단을 빈 문단 사이에 새로 썼다.
  const spaced = record({ ref: { sectionIdx: 0, paraIdx: 2 }, prevText: '', nextText: '', count: 5 });
  const userParagraph = '회의는 수요일 오전 열 시에 별관에서 열린다. 모두 참석하기 바란다.';
  const blankNeighbours = documentWith([spaced]);
  const later = fakeDocument(['제목', '', '', '새 안내', '', userParagraph, '', '끝']);
  assert.deepEqual(mineProvenance(blankNeighbours, cachedReader(later.reader)).pairs, []);
  assert.equal(blankNeighbours.records.length, 0, '증거가 없으면 짝 없이 버린다');

  // 에이전트의 '이상입니다.' 를 사용자가 고쳤고, 다른 곳에 같은 맺음말을 직접 두 번 썼다.
  const closing = record({ agentText: '이상입니다.', lastText: '이상입니다.', ref: { sectionIdx: 0, paraIdx: 3 }, prevText: '', nextText: null, count: 4 });
  const duplicated = documentWith([closing]);
  const after = fakeDocument(['이상입니다.', '머리말', '본문', '', '이상이다.', '부록', '이상입니다.']);
  assert.deepEqual(mineProvenance(duplicated, cachedReader(after.reader)).pairs, []);
  assert.equal(duplicated.records.length, 0, '사용자가 쓴 같은 글로 옮겨 가지 않는다');

  // 이웃이 없는 한 문단짜리 문서는 제자리에서 고친 것만 짝이 된다.
  const alone = record({ ref: { sectionIdx: 0, paraIdx: 0 }, prevText: null, nextText: null, count: 1 });
  assert.equal(mineProvenance(documentWith([alone]), cachedReader(fakeDocument([USER]).reader)).pairs.length, 1);
  assert.deepEqual(mineProvenance(documentWith([alone]), cachedReader(fakeDocument(['새 머리말', USER]).reader)).pairs, []);

  // 앞·뒤 문단이 같은 닮은 문단이 둘이면 고르지 않는다.
  const twice = documentWith([record({ count: 9 })]);
  const ambiguous = fakeDocument(['머리말', USER, '맺음말', '표', '머리말', USER.replace('세 시', '네 시'), '맺음말']);
  assert.deepEqual(mineProvenance(twice, cachedReader(ambiguous.reader)).pairs, []);
});

test('같은 문단을 에이전트가 뒤 턴에 다시 썼으면 앞 기록은 사용자 고침이 아니다', () => {
  const rewrite = '회의는 수요일 오전 열 시에 별관에서 열립니다. 꼭 참석해 주시기 바랍니다.';
  const records = [
    record({ id: 'prv_old' }),
    // 두 번째 쓰기는 바꾸기 전 글을 모른다 (짝이 맞지 않은 op) — 자리로 가른다.
    record({ id: 'prv_new', at: '2026-10-22T02:00:00.000Z', agentText: rewrite, lastText: rewrite, turnId: 'turn-2' }),
  ];
  const untouched = documentWith(records);
  assert.deepEqual(mineProvenance(untouched, cachedReader(fakeDocument(['머리말', rewrite, '맺음말']).reader)).pairs, []);
  assert.deepEqual(untouched.records.map((item) => item.id), ['prv_new']);

  const userEdited = rewrite.replace('열립니다', '열린다').replace('주시기 바랍니다', '주기 바란다');
  const { pairs } = mineProvenance(documentWith(records), cachedReader(fakeDocument(['머리말', userEdited, '맺음말']).reader));
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].signal.after, rewrite);
  assert.equal(pairs[0].signal.turnId, 'turn-2');

  // 바꾸기 전 글이 앞 기록의 글이면 쓰는 순간 앞 기록을 버린다.
  const document = documentWith([record({ id: 'prv_old' })]);
  addProvenance(document, [record({ id: 'prv_new', agentText: rewrite, lastText: rewrite, beforeText: AGENT })]);
  assert.deepEqual(document.records.map((item) => item.id), ['prv_new']);
});

test('한 번에 20쌍까지 보내고, 허브가 받은 짝만 남기며 실패한 학습은 다음에 다시 보낸다', async () => {
  const sentences = Array.from({ length: 25 }, (_, i) => `${i + 1}번 안건은 화요일 오후 세 시에 본관에서 다룹니다. 모두 참석해 주시기 바랍니다.`);
  const paragraphs = sentences.flatMap((text, i) => [`구분 ${i}`, text]);
  const doc = fakeDocument(paragraphs.map((text) => text.replace('다룹니다', '다룬다').replace('주시기 바랍니다', '주기 바란다')));
  const log = new ProvenanceLog(memoryProvenanceBackend());
  await log.update('doc-1', (document) => addProvenance(document, sentences.map((text, i) => record({
    id: `prv_${i}`,
    at: new Date(Date.UTC(2026, 9, 21, 0, i)).toISOString(),
    agentText: text,
    lastText: text,
    ref: { sectionIdx: 0, paraIdx: 2 * i + 1 },
    prevText: `구분 ${i}`,
    nextText: i + 1 < sentences.length ? `구분 ${i + 1}` : null,
    count: paragraphs.length,
  }))));
  const sent: ReviewSignal[][] = [];
  let reply = (pairs: ReviewSignal[]): TasteHistoryResult => ({ ok: false, learnId: '', key: '', items: [], changes: [], accepted: [], error: { code: 'TASTE_HISTORY_NO_RESULT', message: '' } });
  const { miner } = minerFor(doc, log, { send: async (_documentId, pairs) => { sent.push(pairs); return reply(pairs); } });
  assert.deepEqual(await miner.run({ auto: false }), { status: 'failed', code: 'TASTE_HISTORY_NO_RESULT' });
  assert.equal(sent[0]!.length, 20);
  assert.equal((await log.read('doc-1')).records.filter((item) => item.minedText).length, 0);

  // 허브가 앞의 12쌍만 학습기에 넘겼다.
  reply = (pairs) => ({ ok: true, learnId: 'learn_1', key: 'k', items: [], changes: [], accepted: pairs.slice(0, 12).map((_, index) => index) });
  assert.equal((await miner.run({ auto: false })).status, 'learned');
  assert.equal((await log.read('doc-1')).records.filter((item) => item.minedText).length, 12);
  assert.equal((await miner.run({ auto: false })).status, 'learned');
  assert.equal(sent[2]!.length, 13, '받지 않은 8쌍과 보내지 않은 5쌍을 다시 보낸다');
  assert.equal(new Set([...sent[1]!.slice(0, 12), ...sent[2]!].map((pair) => pair.after)).size, 25);
});

test('나누거나 합친 문단의 짝은 학습이 실패해도 남아 다시 보내고, 받은 뒤에 놓는다', async () => {
  // 사용자가 문단을 둘로 나누고 뒷문장을 한다체로 고쳤다.
  const doc = fakeDocument(['머리말', '회의는 화요일 오후 세 시에 본관에서 열립니다.', '모두 참석해 주기 바란다.', '맺음말']);
  const log = new ProvenanceLog(memoryProvenanceBackend());
  await log.update('doc-1', (document) => addProvenance(document, [record()]));
  let ok = false;
  const { miner, sent } = minerFor(doc, log, {
    send: async (_documentId, pairs) => {
      sent.push(pairs);
      return ok
        ? { ok: true, learnId: 'learn_1', key: 'k', items: [], changes: [], accepted: [0] }
        : { ok: false, learnId: '', key: '', items: [], changes: [], accepted: [], error: { code: 'TASTE_HISTORY_BUSY', message: '' } };
    },
  });
  assert.deepEqual(await miner.run({ auto: false }), { status: 'failed', code: 'TASTE_HISTORY_BUSY' });
  assert.equal((await log.read('doc-1')).records.length, 1);
  ok = true;
  assert.equal((await miner.run({ auto: false })).status, 'learned');
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[1], sent[0]);
  assert.equal((await log.read('doc-1')).records.length, 0);
  assert.deepEqual(await miner.run({ auto: false }), { status: 'empty' });
});

test('학습을 마친 고침은 다시 보내지 않고, 그 뒤 또 고치면 다시 보낸다', async () => {
  const doc = fakeDocument(['머리말', USER, '맺음말']);
  const log = new ProvenanceLog(memoryProvenanceBackend());
  await log.update('doc-1', (document) => addProvenance(document, [record()]));
  const { miner, sent } = minerFor(doc, log);
  assert.equal((await miner.run({ auto: false })).status, 'learned');
  assert.deepEqual(await miner.run({ auto: false }), { status: 'empty' });
  doc.paras[1] = `${USER} 자료는 미리 읽어 온다.`;
  assert.equal((await miner.run({ auto: false })).status, 'learned');
  assert.equal(sent.length, 2);
  assert.equal(sent[1]![0]!.after, AGENT);
  assert.equal(sent[1]![0]!.userText, doc.paras[1]);
});

function fakeTimers() {
  const pending = new Set<() => void>();
  return {
    setTimer: (run: () => void) => {
      pending.add(run);
      return run as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: (handle: ReturnType<typeof setTimeout>) => { pending.delete(handle as unknown as () => void); },
    async flush() {
      for (const run of [...pending]) {
        pending.delete(run);
        run();
      }
      await settled();
    },
  };
}

test('자동 실행은 문서를 연 뒤 한 번, 설정이 켜져 있고 같은 문서가 한가할 때만 돌며, 도는 사이 턴이 시작되면 다시 건다', async () => {
  const timers = fakeTimers();
  const state = { key: 'doc-1#1', ready: true, blocked: false, enabled: true, runs: 0, outcome: 'learned' as 'learned' | 'busy' };
  const trigger = new AutoHistoryTrigger({
    openKey: () => state.key,
    ready: () => state.ready,
    blocked: () => state.blocked,
    enabled: async () => state.enabled,
    run: async () => { state.runs += 1; return state.outcome; },
    whenIdle: (run) => { run(); return () => {}; },
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    claimed: new Set(),
  });

  // 같은 문서의 턴·검토 중에는 미루고, 끝나면 돈다.
  state.blocked = true;
  trigger.noteDocument();
  await timers.flush();
  assert.equal(state.runs, 0);
  state.blocked = false;
  trigger.noteTurnEnded();
  await timers.flush();
  assert.equal(state.runs, 1);

  // 같은 열기는 다시 돌지 않는다.
  trigger.noteDocument();
  trigger.noteTurnEnded();
  await timers.flush();
  assert.equal(state.runs, 1);

  // 다시 열었지만 짝을 찾는 사이 턴이 시작돼 보내지 못했다 — 턴이 끝나면 한 번 더 돈다.
  state.key = 'doc-1#2';
  state.outcome = 'busy';
  trigger.noteDocument();
  await timers.flush();
  assert.equal(state.runs, 2);
  state.outcome = 'learned';
  trigger.noteTurnEnded();
  await timers.flush();
  assert.equal(state.runs, 3);
  trigger.noteTurnEnded();
  await timers.flush();
  assert.equal(state.runs, 3);

  // 다시 열었지만 설정이 꺼져 있다 — 돌지 않고, 이번 열기에는 더 보지 않는다.
  state.key = 'doc-1#3';
  state.enabled = false;
  trigger.noteDocument();
  await timers.flush();
  state.enabled = true;
  trigger.noteDocument();
  await timers.flush();
  assert.equal(state.runs, 3);

  // 연결 전에는 기다렸다가 연결되면 돈다.
  state.key = 'doc-1#4';
  state.ready = false;
  trigger.noteDocument();
  await timers.flush();
  assert.equal(state.runs, 3);
  state.ready = true;
  trigger.noteDocument();
  await timers.flush();
  assert.equal(state.runs, 4);
  trigger.dispose();
});

test('사용자가 누른 실행은 고친 글이 없어도 그 문서의 채팅을 싣고, 자동 실행은 싣지 않는다', async () => {
  const log = new ProvenanceLog(memoryProvenanceBackend());
  const sent: Array<{ pairs: ReviewSignal[]; chats: unknown[] }> = [];
  const chats = [{ userText: '앞으로 한다체로 써 줘', answer: '네.' }];
  const { miner } = minerFor(fakeDocument(['본문']), log, {
    chats: () => chats,
    send: async (_documentId, pairs, options) => {
      sent.push({ pairs, chats: options.chats });
      return { ok: true, learnId: 'learn_1', key: 'k', items: [], changes: [], accepted: [] };
    },
  });
  assert.deepEqual(await miner.run({ auto: true }), { status: 'empty' });
  assert.equal((await miner.run({ auto: false })).status, 'learned');
  assert.deepEqual(sent, [{ pairs: [], chats }]);
});
