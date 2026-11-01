import test from 'node:test';
import assert from 'node:assert/strict';

import {
  changedFiniteSelectValue,
} from '../src/ui/decoration-line-shapes.ts';

test('unchanged and unrepresentable decoration selections emit no change', () => {
  assert.equal(changedFiniteSelectValue('12', 12), undefined);
  assert.equal(changedFiniteSelectValue('15', 15), undefined);
  assert.equal(changedFiniteSelectValue('', 15), undefined);
  assert.equal(changedFiniteSelectValue('11', 15), 11);
});
