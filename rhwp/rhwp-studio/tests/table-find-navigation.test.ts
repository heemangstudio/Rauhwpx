import test from 'node:test';
import assert from 'node:assert/strict';
import { findHitRange, findSearchStart, navigateToFindHit } from '../src/core/find-navigation.ts';
import type { DocumentPosition } from '../src/core/types.ts';
import { isLiveFindHit } from '../src/ui/find-dialog.ts';

const path = [{ controlIndex: 0, cellIndex: 3, cellParaIndex: 0 },
  { controlIndex: 2, cellIndex: 1, cellParaIndex: 4 }];

test('table Find selects both endpoints through the real nested address and repeats from that address', () => {
  const hit = { found: true, sec: 0, para: 70, charOffset: 0, length: 4, cellPath: path };
  const calls: unknown[] = [];
  let position: DocumentPosition | undefined;
  const handler = {
    moveCursorTo: (pos: DocumentPosition) => { calls.push(['start', pos]); position = pos; return true; },
    cursor: { setAnchor: () => calls.push(['anchor']), moveTo: (pos: DocumentPosition) => { calls.push(['end', pos]); position = pos; } },
    updateCaret: () => calls.push(['caret']),
  };
  assert.equal(navigateToFindHit(handler, hit, offsets), true);
  assert.deepEqual(calls.map(x => (x as unknown[])[0]), ['start', 'anchor', 'end', 'caret']);
  const range = findHitRange(hit, offsets)!;
  assert.deepEqual(range.start.cellPath, path);
  assert.deepEqual(range.end.cellPath, path);
  assert.equal(range.start.parentParaIndex, 70);
  assert.equal(range.start.paragraphIndex, 4);
  assert.equal(range.end.charOffset, 4);
  assert.deepEqual(findSearchStart(position!, offsets), { section: 0, paragraph: 70, offset: 4, path });
  range.end.cellPath![0].cellIndex = 99;
  assert.equal(range.start.cellPath![0].cellIndex, 3);
  assert.equal(path[0].cellIndex, 3);
});

test('body Find keeps its original address and failed caret navigation cannot create a selection', () => {
  const hit = { found: true, sec: 1, para: 2, charOffset: 3, length: 4, cellPath: [] };
  const range = findHitRange(hit, offsets)!;
  assert.deepEqual(findSearchStart(range.end, offsets), { section: 1, paragraph: 2, offset: 7, path: [] });
  let anchored = false;
  assert.equal(navigateToFindHit({ moveCursorTo: () => false,
    cursor: { setAnchor: () => { anchored = true; }, moveTo: () => {} } }, hit, offsets), false);
  assert.equal(anchored, false);
});


test('legacy textbox/table tuples cannot be mistaken for a body Find position', () => {
  assert.equal(findHitRange({ found: true, sec: 0, para: 70, charOffset: 0, length: 4,
    cellContext: { parentPara: 70, ctrlIdx: 0, cellIdx: 3, cellPara: 0 } }, offsets), null);
});


test('cellPath-only hits cannot validate body replacement at identical numeric offsets', () => {
  const bodyHit = { found: true, sec: 0, para: 70, charOffset: 0, length: 4 };
  const selection = { start: { sectionIndex: 0, paragraphIndex: 70, charOffset: 0 },
    end: { sectionIndex: 0, paragraphIndex: 70, charOffset: 4 } };
  const liveBody = [{ sec: 0, para: 70, charOffset: 0, length: 4 }];
  assert.equal(isLiveFindHit(liveBody, bodyHit, selection, offsets), true);
  assert.equal(isLiveFindHit(liveBody, { ...bodyHit, cellPath: path }, selection, offsets), false,
    'a remembered table hit cannot replace the host body text');
  assert.equal(isLiveFindHit([{ ...liveBody[0], cellPath: path }], bodyHit, selection, offsets), false,
    'a live table match without legacy cellContext cannot validate a remembered body hit');
});

const offsets = {
  textToLogicalOffset: (_s: number, _p: number, at: number) => at,
  logicalToTextOffset: (_s: number, _p: number, at: number) => at,
  textToLogicalOffsetInCellByPath: (_s: number, _p: number, _path: string, at: number) => at,
  logicalToTextOffsetInCellByPath: (_s: number, _p: number, _path: string, at: number) => at,
};
