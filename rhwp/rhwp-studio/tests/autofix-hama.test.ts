// 자동 수정 시트의 픽셀 하마: 세 번 내리쳐 못을 박고, 칠 때마다 망치가 못 머리에 닿고, 다 박으면 새 못이 솟는다.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AUTOFIX_HAMA_CYCLE_MS,
  AUTOFIX_HAMA_HEIGHT,
  AUTOFIX_HAMA_NAIL,
  AUTOFIX_HAMA_WIDTH,
  autofixHamaImpactTime,
  autofixHamaRows,
} from '../src/ui/autofix/autofix-hama.ts';

/** 판자 위로 나온 못 길이 */
function nailHeight(rows: string[]): number {
  let height = 0;
  for (let y = AUTOFIX_HAMA_NAIL.plankY - 1; y >= 0 && 'nN'.includes(rows[y]![AUTOFIX_HAMA_NAIL.x]!); y -= 1) height += 1;
  return height;
}

/** 망치 머리가 덮는 가장 아랫줄(못 열) */
function hammerBottom(rows: string[]): number {
  let bottom = -1;
  rows.forEach((row, y) => { if (row[AUTOFIX_HAMA_NAIL.x] === 'B') bottom = y; });
  return bottom;
}

test('three blows drive the nail in, each landing on the nail head, then a fresh nail pops up', () => {
  const before = [3, 2, 1];
  for (const [hit, height] of before.entries()) {
    const impact = autofixHamaImpactTime(hit);
    assert.equal(nailHeight(autofixHamaRows(impact - 1)), height, `nail before blow ${hit + 1}`);
    const struck = autofixHamaRows(impact + 10);
    assert.equal(nailHeight(struck), height - 1, `blow ${hit + 1} sinks the nail one pixel`);
    assert.equal(hammerBottom(struck), AUTOFIX_HAMA_NAIL.plankY - height - 1, `blow ${hit + 1} lands on the nail head`);
    assert.ok(struck.join('').includes('W'), `blow ${hit + 1} throws sparks`);
  }
  assert.ok(!autofixHamaRows(autofixHamaImpactTime(0) - 1).join('').includes('W'), 'no sparks before the first blow');
  assert.equal(nailHeight(autofixHamaRows(AUTOFIX_HAMA_CYCLE_MS - 1)), 3, 'a new nail stands before the loop repeats');
  for (const t of [0, 123, AUTOFIX_HAMA_CYCLE_MS * 7 + 400]) {
    const rows = autofixHamaRows(t);
    assert.equal(rows.length, AUTOFIX_HAMA_HEIGHT);
    assert.ok(rows.every((row) => row.length === AUTOFIX_HAMA_WIDTH));
  }
});
