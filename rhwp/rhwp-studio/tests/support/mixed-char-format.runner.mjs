// #6788: 실제 command/history/bridge + HeemangEngine(hm-wasm) 행위 회귀.
import assert from 'node:assert/strict';
import { startEditEngine } from './edit-history-env.ts';

const engine = await startEditEngine();
const { ApplyCharFormatCommand } = engine.command;
const { CommandHistory } = engine;

const pos = (p, off) => ({ sectionIndex: 0, paragraphIndex: p, charOffset: off });
const bodyRange = (p, from, to) => ({
  target: { kind: 'body', sectionIndex: 0, paragraphIndex: p },
  startOffset: from,
  endOffset: to,
});
const text = '가😀나다라마바';
const purple = '#a020c0';
const yellow = { shadeColor: '#ffff00' };
function bodyState(wasm, count = 1) {
  return Array.from({ length: count }, (_, p) => Array.from({ length: wasm.getParagraphLength(0, p) }, (_, o) => wasm.getCharPropertiesAt(0, p, o)));
}
function checkHighlight(before, after, from, to) {
  for (let p = 0; p < before.length; p++) {
    for (let o = 0; o < before[p].length; o++) {
      const selected = (p > from.paragraphIndex || o >= from.charOffset) && (p < to.paragraphIndex || o < to.charOffset);
      const expected = { ...before[p][o] };
      const actual = { ...after[p][o] };
      delete expected.charShapeId;
      delete actual.charShapeId;
      if (selected) expected.shadeColor = '#ffff00';
      assert.deepEqual(actual, expected, `문단 ${p}, 문자 ${o}: 미지정 속성/선택 밖 보존`);
    }
  }
}
function rangesFor(from, to, count) {
  const ranges = [];
  for (let p = from.paragraphIndex; p <= to.paragraphIndex; p++) {
    const start = p === from.paragraphIndex ? from.charOffset : 0;
    const end = p === to.paragraphIndex ? to.charOffset : 7;
    ranges.push(bodyRange(p, start, end));
  }
  void count;
  return ranges;
}
let scenarios = 0;
for (const [count, from, to] of [[1, pos(0, 0), pos(0, 7)], [1, pos(0, 2), pos(0, 4)], [1, pos(0, 3), pos(0, 6)], [2, pos(0, 1), pos(1, 6)]]) {
  const wasm = engine.newDocument();
  for (let p = 0; p < count; p++) {
    if (p) wasm.splitParagraph(0, p - 1, 7);
    wasm.insertText(0, p, 0, text);
    wasm.applyCharFormat(0, p, 2, 4, JSON.stringify({ textColor: purple, bold: true, fontSize: 1800 }));
  }
  const history = new CommandHistory();
  let restoreCalls = 0;
  const restore = wasm.setCharShapeRuns.bind(wasm);
  wasm.setCharShapeRuns = (...args) => { restoreCalls++; return restore(...args); };
  const before = bodyState(wasm, count);
  history.execute(new ApplyCharFormatCommand(rangesFor(from, to, count), yellow, from), wasm);
  const after = bodyState(wasm, count);
  checkHighlight(before, after, from, to);
  for (let cycle = 0; cycle < 3; cycle++) {
    assert.deepEqual(history.undo(wasm), from);
    assert.deepEqual(bodyState(wasm, count), before, 'Undo 전체 모양/ID');
    assert.deepEqual(history.redo(wasm), from);
    assert.deepEqual(bodyState(wasm, count), after, 'Redo 전체 모양/ID');
  }
  assert.equal(restoreCalls, count * 6, '구간 수와 무관하게 문단당 복원 호출 한 번');
  history.clear(wasm);
  scenarios++;
}

{
  const wasm = engine.newDocument();
  wasm.insertText(0, 0, 0, text);
  wasm.splitParagraph(0, 0, 7);
  wasm.insertText(0, 1, 0, text);
  const before = bodyState(wasm, 2);
  const apply = wasm.applyCharFormat.bind(wasm);
  wasm.applyCharFormat = (sec, p, ...args) => {
    if (p === 1) throw new Error('injected failure');
    return apply(sec, p, ...args);
  };
  const history = new CommandHistory();
  assert.throws(() => history.execute(new ApplyCharFormatCommand([
    bodyRange(0, 0, 7), bodyRange(1, 0, 7),
  ], yellow, pos(0, 0)), wasm),
    error => error.cause?.message === 'injected failure');
  assert.deepEqual(bodyState(wasm, 2), before);
  assert.equal(history.undo(wasm), null);
  scenarios++;
}

{
  const wasm = engine.newDocument();
  const history = new CommandHistory();
  history.execute(new ApplyCharFormatCommand([bodyRange(0, 0, 0)], yellow, pos(0, 0)), wasm);
  assert.equal(history.undo(wasm), null);
  scenarios++;
}

console.log(`MIXED_CHAR_FORMAT_OK scenarios=${scenarios}`);
