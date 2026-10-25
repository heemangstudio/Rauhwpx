import test from 'node:test';
import assert from 'node:assert/strict';
import { openHeemangAgent } from './heemang-agent-env.ts';

const FIXTURE = 'tests/fixtures/legacy-equation-body.hwpx';
const object = { section: 0, para: 4, control: 0 };
const query = (doc: { query(request: string): string }, request: object) => JSON.parse(doc.query(JSON.stringify(request)));

test('본문 레거시 OLE 수식을 같은 틀에서 전환하고 실행 취소·저장 후 복원한다', async t => {
  const { wasm, adapter } = await openHeemangAgent(t, FIXTURE);
  const doc = adapter.hmDoc();
  const before = doc.serialize(false);
  const frame = query(doc, { kind: 'objectProperties', object });
  assert.equal(frame.objectId, 1701116216); assert.equal(frame.instanceId, 627374393);
  const undo = JSON.parse(doc.state()).undo;
  const promoted = wasm.promoteOleEquation(0, 4, 0);
  assert.equal(promoted.ok, true); assert.equal(promoted.paraIdx, 4); assert.equal(promoted.controlIdx, 0);
  assert.match(promoted.script, /TIMES/); assert.match(promoted.script, /over\s*\{75\}/);
  const props = wasm.getEquationProperties(0, 4, 0);
  assert.equal(props.width, frame.width); assert.equal(props.height, frame.height); assert.equal(props.instanceId, frame.instanceId);
  assert.equal(props.fontSize, 950); assert.equal(props.baseline, 60); assert.equal(props.fontName, 'HYhwpEQ');
  assert.equal(JSON.parse(doc.state()).undo, undo + 1);
  for (const format of ['hwp5', 'hwpx'] as const) {
    const reopened = adapter.hmEngine().open(doc.serializeAs(format, false));
    try {
      assert.equal(query(reopened, { kind: 'equation', object }).script, promoted.script);
      const saved = query(reopened, { kind: 'objectProperties', object });
      for (const key of ['width', 'height', 'horzOffset', 'vertOffset', 'treatAsChar', 'zOrder', 'instanceId']) assert.equal(saved[key], frame[key], key);
      assert.equal(query(reopened, { kind: 'paragraphs', list: { section: 0 }, from: 4, count: 1 })[0].controls[0].kind, 'equation');
    } finally { reopened.free(); }
  }
  wasm.core.mutate(value => value.undo()); assert.deepEqual(doc.serialize(false), before);
  wasm.core.mutate(value => value.redo()); assert.equal(wasm.getEquationProperties(0, 4, 0).script, promoted.script);
});

test('수식이 아닌 개체의 전환 실패는 문서와 이력을 바꾸지 않는다', async t => {
  const { wasm, adapter } = await openHeemangAgent(t, FIXTURE);
  const shape = wasm.createShapeControl({ sectionIdx: 0, paraIdx: 4, charOffset: 1, shapeType: 'rectangle', width: 3000, height: 2000 });
  const doc = adapter.hmDoc(), before = doc.serialize(false), state = doc.state();
  assert.throws(() => wasm.promoteOleEquation(0, shape.paraIdx, shape.controlIdx));
  assert.deepEqual(doc.serialize(false), before); assert.equal(doc.state(), state);
});

for (const fixture of ['samples/issue1853_caption_precedes_body_split.hwpx', 'samples/수식-문자처럼취급-아님.hwpx']) {
  test(`기존 캡션·수식 문서의 중첩 글자와 수식은 두 형식으로 보존된다: ${fixture}`, async t => {
    const { adapter } = await openHeemangAgent(t, fixture);
    const snapshot = (doc: { query(request: string): string }) => {
      const records = query(doc, { kind: 'controls' }) as Array<{ kind: string; target: object; lists: object[] }>;
      const lists = [...new Map(records.flatMap(record => record.lists ?? []).map(list => [JSON.stringify(list), list])).values()];
      return {
        text: lists.map(list => (query(doc, { kind: 'paragraphs', list }) as Array<{ text: string }>).map(p => p.text)),
        equations: records.filter(record => record.kind === 'equation').map(record => query(doc, { kind: 'equation', object: record.target }).script),
      };
    };
    const before = snapshot(adapter.hmDoc());
    assert.ok(before.text.length || before.equations.length);
    for (const format of ['hwp5', 'hwpx'] as const) {
      const reopened = adapter.hmEngine().open(adapter.hmDoc().serializeAs(format, false));
      try { assert.deepEqual(snapshot(reopened), before); } finally { reopened.free(); }
    }
  });
}
