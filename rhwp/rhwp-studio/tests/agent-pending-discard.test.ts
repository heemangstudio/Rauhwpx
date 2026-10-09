/**
 * 에이전트 pending 편집 — 문서 로드/digest 동기화 테스트.
 *
 * 회귀 시나리오(e2e 확정): 문서가 없는 상태에서 생성된 매니저는 lastDigest=null
 * 로 시작한다. 문서 로드는 dirty 전이를 만들지 않으므로(로드 직후 항상 clean),
 * 첫 에이전트 쓰기의 dirty false→true 전이에서 document-dirty-changed 핸들러가
 * null → blake3:… 불일치를 "문서 교체"로 오판해 첫 op 을 폐기했다.
 *
 * 가짜 wasm 은 agent-pending-replace.test.ts 와 같은 계약이다 — 모든 오프셋을
 * 코드포인트(Unicode scalar) 단위로 처리한다.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../src/core/event-bus.ts';
import { DocumentDirtyState } from '../src/core/document-dirty-state.ts';
import { PendingEditManager } from '../src/agent/pending-edits.ts';
import { expectErr, makeEnv } from './agent-test-env.ts';

// ─── 코드포인트 단위 가짜 wasm (로드 가능) ──────────────────

interface FakePara {
  chars: string[]; // 코드포인트 배열
}

function paraOf(text: string): FakePara {
  return { chars: [...text] };
}

function makeFakeWasm() {
  let body: FakePara[] = [];
  let digest: string | null = null;

  const wasm = {
    getSectionCount: () => (body.length > 0 ? 1 : 0),
    getParagraphCount: (_s: number) => body.length,
    getParagraphLength: (_s: number, p: number) => body[p].chars.length,
    getTextRange: (_s: number, p: number, off: number, cnt: number) =>
      body[p].chars.slice(off, off + cnt).join(''),
    insertText: (_s: number, p: number, off: number, t: string) => {
      const chars = [...t]; // 코드포인트 단위
      body[p].chars.splice(off, 0, ...chars);
      return JSON.stringify({ ok: true, charOffset: off + chars.length });
    },
    get documentDigest() { return digest; },
    /** 문서 로드 시뮬레이션 — WasmBridge.loadDocument 와 같이 digest 만 바뀌고
     * dirty 이벤트는 발생하지 않는다 (로드 직후 markClean 은 no-op 전이). */
    load(paras: FakePara[], nextDigest: string) {
      body = paras;
      digest = nextDigest;
    },
  };
  return {
    wasm,
    load: (paras: FakePara[], nextDigest: string) => wasm.load(paras, nextDigest),
    text: (p: number) => body[p].chars.join(''),
  };
}

function makeManager(fake: ReturnType<typeof makeFakeWasm>) {
  const eventBus = new EventBus();
  // main.ts 의 배선과 동일: mutation 이벤트가 dirty 를 세우고, dirty 전이가
  // document-dirty-changed 를 발화한다.
  const dirty = new DocumentDirtyState(eventBus);
  eventBus.on('document-mutated', (reason) =>
    dirty.markDirty(typeof reason === 'string' ? reason : 'document-mutated'));
  eventBus.on('document-changed', (reason) =>
    dirty.markDirty(typeof reason === 'string' ? reason : 'document-changed'));

  const inputHandler = {
    getCursorPosition: () => ({ sectionIndex: 0, paragraphIndex: 0, charOffset: 0 }),
    executeOperation: () => {},
    prepareSnapshotCapacity: () => {},
  };
  const overlay = { setOps: () => {}, clear: () => {} };
  const mgr = new PendingEditManager({
    wasm: fake.wasm as never,
    eventBus,
    editor: inputHandler as never,
    overlay: overlay as never,
  });
  const events: string[] = [];
  mgr.onChange((e) => events.push(e.type));
  return { mgr, eventBus, dirty, events };
}

// ─── 회귀: 로드 후 첫 쓰기는 폐기되면 안 된다 ─────────────────

test('문서 없이 생성 → 로드(dirty 이벤트 없음) → 첫 쓰기는 pending 으로 남는다', () => {
  const fake = makeFakeWasm();
  const { mgr, events } = makeManager(fake);
  assert.equal(fake.wasm.getSectionCount(), 0); // 아직 문서 없음

  // 문서 로드 — digest 가 생기지만 document-dirty-changed 는 발화하지 않는다
  fake.load([paraOf('hello')], 'blake3:doc-A');
  assert.equal(fake.wasm.getSectionCount(), 1);

  const r = mgr.insertText('claude', { sectionIdx: 0, paraIdx: 0, charOffset: 5 }, '!');

  // 버그: 첫 쓰기의 dirty false→true 전이가 stale digest(null)와 불일치하여
  // 방금 기록된 op 을 discardAll('document loaded')로 폐기했다.
  assert.equal(fake.text(0), 'hello!'); // 텍스트는 문서에 적용돼 있다
  assert.equal(mgr.hasPending(), true); // …그리고 pending 으로 추적돼야 한다
  const sets = mgr.getChangeSets();
  assert.equal(sets.length, 1);
  assert.equal(sets[0].id, r.changeSetId);
  assert.equal(sets[0].ops.length, 1);
  assert.equal(sets[0].ops[0].kind, 'insert');
  assert.ok(!events.includes('invalidated'));

  // 후속 쓰기도 그대로 유지된다
  mgr.insertText('claude', { sectionIdx: 0, paraIdx: 0, charOffset: 6 }, '?');
  assert.equal(mgr.hasPending(), true);
  assert.equal(mgr.getChangeSets()[0].ops.length, 2);
  assert.ok(!events.includes('invalidated'));
});

// ─── 보호 유지: 진짜 문서 교체는 여전히 폐기한다 ───────────────

test('문서가 있는 상태에서 생성 → pending 중 진짜 교체는 전부 폐기한다', () => {
  const fake = makeFakeWasm();
  fake.load([paraOf('hello')], 'blake3:doc-A');
  const { mgr, dirty, events } = makeManager(fake); // 생성 시점 digest = doc-A

  mgr.insertText('claude', { sectionIdx: 0, paraIdx: 0, charOffset: 5 }, '!');
  assert.equal(mgr.hasPending(), true);
  assert.ok(dirty.isDirty()); // 쓰기로 dirty

  // 진짜 교체: 다른 문서 로드 + 로드 직후 markClean(dirty true→false 전이 발화)
  fake.load([paraOf('new document')], 'blake3:doc-B');
  dirty.markClean('document-initialized');

  assert.equal(mgr.hasPending(), false);
  assert.equal(mgr.getChangeSets().length, 0);
  assert.ok(events.includes('invalidated'));
});

test('초기 digest 동기화 이후의 교체는 여전히 폐기한다 (보호 약화 없음)', () => {
  const fake = makeFakeWasm();
  const { mgr, dirty, events } = makeManager(fake); // 문서 없이 생성

  fake.load([paraOf('hello')], 'blake3:doc-A'); // 로드 — 이벤트 없음
  mgr.insertText('claude', { sectionIdx: 0, paraIdx: 0, charOffset: 5 }, '!');
  assert.equal(mgr.hasPending(), true); // 첫 쓰기 생존 (초기 동기화)

  // 이 상태에서의 교체는 doc-A → doc-B 불일치이므로 폐기돼야 한다
  fake.load([paraOf('other')], 'blake3:doc-B');
  dirty.markClean('document-initialized'); // dirty true→false 전이

  assert.equal(mgr.hasPending(), false);
  assert.ok(events.includes('invalidated'));
});

// ─── 문서 인스턴스 기준 교체 판정 ─────────────────────────────

function makeInstanceEnv(initialBody: string[]) {
  const doc = { instance: 1, digest: 'blake3:doc-A' };
  const engineCalls: string[] = [];
  const h = makeEnv(initialBody, (wasm) => {
    Object.defineProperty(wasm, 'documentInstance', { get: () => doc.instance });
    Object.defineProperty(wasm, 'documentDigest', { get: () => doc.digest });
    const discardSnapshot = wasm['discardSnapshot'] as (id: number) => void;
    wasm['discardSnapshot'] = (id: number) => { engineCalls.push(`discardSnapshot:${id}`); discardSnapshot(id); };
    wasm['discardParagraphCapture'] = (id: number) => { engineCalls.push(`discardParagraphCapture:${id}`); };
  });
  // main.ts 배선과 같다: 변이가 dirty 를 세우고 dirty 전이가 document-dirty-changed 를 낸다.
  const dirty = new DocumentDirtyState(h.bus);
  h.bus.on('document-mutated', () => dirty.markDirty('edit'));
  const events: Array<{ type: string; reason?: string }> = [];
  h.pending.onChange((e) => events.push({ type: e.type, ...('reason' in e ? { reason: e.reason } : {}) }));
  /** 다른(또는 같은 바이트의) 문서를 연다 — 로드는 dirty 전이를 만들지 않는다. */
  const open = (paras: string[], digest: string) => {
    doc.instance++;
    doc.digest = digest;
    h.body.splice(0, h.body.length, ...paras);
  };
  return { h, dirty, events, engineCalls, open };
}

test('깨끗한 문서를 닫고 다른 깨끗한 문서를 열어도 새 문서의 첫 스테이징 쓰기는 살아남는다', async () => {
  const { h, dirty, events, open } = makeInstanceEnv(['문서 A']);
  h.pending.beginTurn('claude');
  await h.call('insert_text', { sectionIdx: 0, paraIdx: 0, charOffset: 4, text: '!' });
  h.pending.endTurn('review');
  assert.equal(h.pending.approve(h.pending.getChangeSets()[0].id), true);
  dirty.markClean('save');

  open(['문서 B'], 'blake3:doc-B');
  events.length = 0;
  h.pending.beginTurn('claude');
  await h.call('insert_text', { sectionIdx: 0, paraIdx: 0, charOffset: 4, text: '?' });

  // 예전 digest 판정은 이 쓰기의 dirty 전이에서 A≠B 를 보고 방금 스테이징한 op 을 버렸다 —
  // 글자는 문서에 남은 채 검토에서 사라져, 안전 모드에서도 검토 없이 확정됐다.
  assert.equal(h.body[0], '문서 B?');
  const sets = h.pending.getChangeSets();
  assert.equal(sets.length, 1);
  assert.equal(sets[0].ops.length, 1);
  assert.ok(!events.some((e) => e.type === 'invalidated'), JSON.stringify(events));
});

test('같은 바이트로 다시 열어도 이전 인스턴스의 대기 편집은 엔진 호출 없이 잊는다', async () => {
  const { h, events, engineCalls, open } = makeInstanceEnv(['첫 문단 본문', '둘째 문단']);
  h.pending.beginTurn('claude');
  await h.call('replace_range', {
    sectionIdx: 0, startParaIdx: 0, startCharOffset: 0, endParaIdx: 0, endCharOffset: 2, text: '머리',
  });
  await h.call('insert_text', { sectionIdx: 0, paraIdx: 1, charOffset: 2, text: '\n새 줄' });
  const held = h.pending.getChangeSets()[0].ops.filter((op) => op.kind === 'replace' && op.snapshotId != null).length;
  assert.equal(held, 1);
  const releasedBefore = h.releasedSnapshots();

  // 저장하지 않고 같은 파일을 다시 연다 — digest 가 같아 예전 판정은 교체를 보지 못했다.
  open(['첫 문단 본문', '둘째 문단'], 'blake3:doc-A');
  engineCalls.length = 0;
  h.bus.emit('document-context-changed');

  assert.equal(h.pending.hasPending(), false);
  assert.deepEqual(events.filter((e) => e.type === 'invalidated'), [{ type: 'invalidated', reason: 'document replaced' }]);
  // 엔진 스냅샷·문단 보관본 id 는 문서마다 0 부터 다시 매겨진다 — 새 문서에 discard 를 부르면
  // 새 문서 자신의 스냅샷을 지울 수 있다. 히스토리 예산 점유만 반환한다.
  assert.deepEqual(engineCalls, []);
  assert.equal(h.releasedSnapshots() - releasedBefore, held);
  // 턴은 계속된다 — 다음 쓰기는 새 set 으로 스테이징된다.
  await h.call('insert_text', { sectionIdx: 0, paraIdx: 1, charOffset: 0, text: '*' });
  assert.equal(h.pending.getChangeSets().length, 1);
  assert.equal(h.pending.getChangeSets()[0].ops.length, 1);
});

test('문서 교체 직후 실패한 배치의 롤백이 이전 문서의 열린 set 을 되살리지 않는다', async () => {
  const { h, open } = makeInstanceEnv(['문서 A 본문']);
  h.pending.beginTurn('claude');
  await h.call('insert_text', { sectionIdx: 0, paraIdx: 0, charOffset: 0, text: '*' });
  // 이벤트 없이 다른 문서가 열린 상태에서 곧바로 배치가 실패한다.
  open(['문서 B 본문'], 'blake3:doc-B');
  await expectErr(h.call('apply_edits', {
    edits: [
      { tool: 'insert_text', args: { anchor: { text: '본문' }, text: '!' } },
      { tool: 'delete_range', args: { anchor: { text: '없는 글' } } },
    ],
  }), 'INVALID_ARGS');
  assert.equal(h.body[0], '문서 B 본문');
  assert.equal(h.pending.hasPending(), false, '이전 문서의 op 은 검토 대기로 돌아오지 않는다');
  // 다음 쓰기는 검토 목록에 보이는 set 에 쌓여야 한다 — 목록 밖 set 에 들어가면 검토 없이 확정된다.
  await h.call('insert_text', { sectionIdx: 0, paraIdx: 0, charOffset: 0, text: '#' });
  const sets = h.pending.getChangeSets();
  assert.equal(sets.length, 1);
  assert.deepEqual(sets[0].ops.map((op) => op.kind), ['insert']);
});
