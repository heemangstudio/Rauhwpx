import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import type { EditingSelection, TextSelection } from '../src/core/heemang-editing.ts';

registerHooks({
  resolve(specifier, context, next) {
    return next(specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier) ? `${specifier}.ts` : specifier, context);
  },
});
const { copySelection, sameSelection, orderedSelection } = await import('../src/core/heemang-editing.ts');

test('selection snapshots preserve directed text affinity and isolate nested cell table addresses', () => {
  const text: TextSelection = { from: { section: 0, para: 0, offset: 4 }, to: { section: 0, para: 0, offset: 1 },
    fromAffinity: 'upstream', toAffinity: 'downstream' };
  const saved = copySelection(text);
  assert.deepEqual(saved, text);
  assert.equal(sameSelection(saved, text), true);
  const ordered = orderedSelection(text);
  assert.deepEqual([ordered.from.offset, ordered.to.offset, ordered.fromAffinity, ordered.toAffinity],
    [1, 4, 'downstream', 'upstream']);
  assert.deepEqual(text, saved, 'Ordering must not mutate the directed history selection');

  const cells: EditingSelection = { kind: 'cells', table: { section: 0,
    steps: [{ para: 2, control: 1, index: 3 }], para: 4, control: 2 },
    from: { row: 0, column: 1 }, to: { row: 2, column: 3 } };
  const block = copySelection(cells);
  cells.table.steps![0].index = 9;
  cells.from.row = 1;
  assert.equal(block.table.steps![0].index, 3);
  assert.equal(block.from.row, 0);
  assert.equal(sameSelection(block, cells), false, 'A pending clipboard snapshot detects a changed table/cell block');
});

test('clipboard selection identity includes kind, nested table path, direction and text affinities', () => {
  const text: TextSelection = { from: { section: 0, para: 1, offset: 4 }, to: { section: 0, para: 1, offset: 1 } };
  assert.equal(sameSelection(text, { ...text, from: { ...text.from, steps: [] } }), true);
  assert.equal(sameSelection(text, { ...text, fromAffinity: 'upstream' }), false);
  assert.equal(sameSelection(text, { from: text.to, to: text.from }), false);
  const cells: EditingSelection = { kind: 'cells', table: { section: 0, para: 1, control: 0 },
    from: { row: 0, column: 0 }, to: { row: 1, column: 1 } };
  assert.equal(sameSelection(text, cells), false);
  assert.equal(sameSelection(cells, text), false);
  assert.equal(sameSelection(cells, copySelection(cells)), true);
  for (const table of [{ ...cells.table, control: 1 }, { ...cells.table, para: 2 },
    { ...cells.table, steps: [{ para: 0, control: 0, index: 0 }] }]) {
    assert.equal(sameSelection(cells, { ...cells, table }), false);
  }
  assert.equal(sameSelection(cells, { ...cells, to: { row: 1, column: 2 } }), false);
});

test('local ordering leaves cross-list and cross-section normalization to the engine', () => {
  const from = { section: 0, para: 1, offset: 0 };
  for (const to of [{ ...from, section: 1 }, { ...from, steps: [{ para: 0, control: 0, index: 0 }] }]) {
    assert.throws(() => orderedSelection({ from, to }), { code: 'ENGINE_NOT_SUPPORTED' });
  }
  assert.throws(() => orderedSelection({ from, to: { ...from, offset: -1 } }), { code: 'BAD_ADDRESS' });
});
