import test from 'node:test';
import assert from 'node:assert/strict';
import { agentEngineCoordinates, agentTextToLogicalOffset } from '../src/agent/engine-coordinates.ts';
import type { WasmBridge } from '../src/core/wasm-bridge.ts';

/** wasm 로드 없이 UTF-16 호스트와 agent 경계의 계약을 확인한다. */
function fixture() {
  const paragraphs = ['a😀b', '😀cd'];
  let last: unknown[] = [];
  const host = {
    core: {},
    getTextRange(_sec: number, para: number, from: number, count: number) { return paragraphs[para].slice(from, from + count); },
    getTextInCell(_sec: number, _parent: number, _control: number, _cell: number, para: number, from: number, count: number) { return paragraphs[para].slice(from, from + count); },
    getTextInCellByPath(_sec: number, _parent: number, path: string, from: number, count: number) { return paragraphs[JSON.parse(path).at(-1).cellParaIndex].slice(from, from + count); },
    getParagraphLength(_sec: number, para: number) { return paragraphs[para].length; },
    getCellParagraphLength() { return 4; },
    getCellParagraphLengthByPath() { return 4; },
    logicalToTextOffset(_sec: number, _para: number, at: number) { return at - 1; },
    textToLogicalOffset(_sec: number, _para: number, at: number) { return at + 1; },
    textToLogicalOffsetInCellByPath(_sec: number, _parent: number, _path: string, at: number) { return at + 1; },
    splitParagraphLogical(...args: unknown[]) { last = args; return '{}'; },
    insertText(_sec: number, para: number, at: number, text: string, logical = false) {
      last = [at, logical]; paragraphs[para] = paragraphs[para].slice(0, at) + text + paragraphs[para].slice(at);
      return JSON.stringify({ ok: true, charOffset: at + text.length });
    },
    deleteText(_sec: number, para: number, at: number, count: number) {
      const removed = paragraphs[para].slice(at, at + count);
      paragraphs[para] = paragraphs[para].slice(0, at) + paragraphs[para].slice(at + count);
      return JSON.stringify({ ok: true, charOffset: at, removedStart: at, removedCount: [...removed].length, removedContent: { text: removed } });
    },
    getCharPropertiesAt(...args: unknown[]) { last = args; return {}; },
    applyCharFormatInCell(...args: unknown[]) { last = args; return '{}'; },
    getCharShapeRuns(...args: unknown[]) { last = args; return [{ startOffset: 1, endOffset: 3, charShapeId: 8 }]; },
    setCharShapeRunsInCellByPath(...args: unknown[]) { last = args; return '{}'; },
    deleteRangeInCellByPath(...args: unknown[]) { last = args; return JSON.stringify({ ok: true, paraIdx: args[3], charOffset: args[4] }); },
    deleteRangeAcrossSections(...args: unknown[]) { last = args; return { ok: true, sectionIdx: args[0], paraIdx: args[1], charOffset: args[2] }; },
    searchAllText() { return [{ sec: 0, para: 7, cellPath: [{ controlIndex: 0, cellIndex: 0, cellParaIndex: 0 }], charOffset: 3, length: 1 }]; },
    searchText(...args: unknown[]) { last = args; return { found: true, sec: 0, para: 0, charOffset: 1, length: 2 }; },
    getLogicalLength() { assert.equal(this, host); return 5; },
  };
  return { host: host as unknown as WasmBridge, paragraphs, last: () => last };
}
const path = JSON.stringify([{ controlIndex: 0, cellIndex: 0, cellParaIndex: 0 }]);

test('본문·셀·중첩 셀 읽기와 넣기·지우기는 scalar 좌표를 쓴다', () => {
  const f = fixture(), engine = agentEngineCoordinates(f.host);
  assert.equal(engine.getParagraphLength(0, 0), 3);
  assert.equal(engine.getCellParagraphLength(0, 7, 0, 0, 0), 3);
  assert.equal(engine.getCellParagraphLengthByPath(0, 7, path), 3);
  assert.equal(engine.getTextRange(0, 0, 1, 1), '😀');
  assert.equal(engine.getTextInCell(0, 7, 0, 0, 0, 1, 1), '😀');
  assert.equal(engine.getTextInCellByPath(0, 7, path, 1, 1), '😀');
  assert.equal(JSON.parse(engine.insertText(0, 0, 2, '😀')).charOffset, 3);
  assert.equal(f.paragraphs[0], 'a😀😀b');
  assert.deepEqual(JSON.parse(engine.deleteText(0, 0, 2, 1)), { ok: true, charOffset: 2, removedStart: 2, removedCount: 1, removedContent: { text: '😀' } });
  assert.equal(f.paragraphs[0], 'a😀b');
});

test('논리 캐럿은 한 번만 변환하고 UI 전용 메서드는 호스트에 위임한다', () => {
  const f = fixture(), engine = agentEngineCoordinates(f.host);
  assert.equal(engine.textToLogicalOffset(0, 0, 2), 4);
  assert.equal(engine.logicalToTextOffset(0, 0, 4), 2);
  assert.equal(agentTextToLogicalOffset(engine, 0, 0, 2), 4);
  assert.equal(agentTextToLogicalOffset(engine, 0, 0, 2, { paraIdx: 7, controlIdx: 0, cellIdx: 0 }), 4);
  assert.equal(agentTextToLogicalOffset(engine, 0, 0, 2, { paraIdx: 7, controlIdx: 0, cellIdx: 0, path: JSON.parse(path) }), 4);
  engine.splitParagraphLogical(0, 0, 4);
  assert.deepEqual(f.last(), [0, 0, 4]);
  engine.insertText(0, 0, 3, 'Z', true);
  assert.deepEqual(f.last(), [3, true]);
  assert.equal(engine.getLogicalLength(0, 0), 5);
  assert.equal(agentEngineCoordinates(f.host), engine);
  assert.equal(agentEngineCoordinates(engine), engine);
  const mock = {} as WasmBridge;
  assert.equal(agentEngineCoordinates(mock), mock);
});

test('속성·서식 범위·서식 runs 를 문단 기준으로 변환한다', () => {
  const f = fixture(), engine = agentEngineCoordinates(f.host);
  engine.getCharPropertiesAt(0, 0, 2);
  assert.deepEqual(f.last(), [0, 0, 3]);
  engine.applyCharFormatInCell(0, 7, 0, 0, 0, 1, 2, '{}');
  assert.deepEqual(f.last(), [0, 7, 0, 0, 0, 1, 3, '{}']);
  assert.deepEqual(engine.getCharShapeRuns(0, 0, 1, 2), [{ startOffset: 1, endOffset: 2, charShapeId: 8 }]);
  engine.setCharShapeRunsInCellByPath(0, 7, path, 1, 2, [{ startOffset: 1, endOffset: 2, charShapeId: 8 }]);
  assert.deepEqual(f.last().slice(3), [1, 3, [{ startOffset: 1, endOffset: 3, charShapeId: 8 }]]);
});

test('여러 문단 범위와 셀 검색 결과는 각각의 문단 텍스트로 변환한다', () => {
  const f = fixture(), engine = agentEngineCoordinates(f.host);
  assert.equal(JSON.parse(engine.deleteRangeInCellByPath(0, 7, path, 0, 2, 1, 1)).charOffset, 2);
  assert.deepEqual(f.last().slice(3), [0, 3, 1, 2]);
  assert.equal(engine.deleteRangeAcrossSections(0, 0, 2, 1, 1, 1).charOffset, 2);
  assert.deepEqual(f.last(), [0, 0, 3, 1, 1, 2]);
  assert.equal(engine.searchAllText('b', true, true)[0].charOffset, 2);
  assert.deepEqual(engine.searchText('😀', 0, 0, 2, true, true), { found: true, sec: 0, para: 0, charOffset: 1, length: 1 });
  assert.equal(f.last()[3], 3);
});
