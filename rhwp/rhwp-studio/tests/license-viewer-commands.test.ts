import assert from 'node:assert/strict';
import test from 'node:test';

import { CommandDispatcher } from '../src/command/dispatcher.ts';
import { EventBus } from '../src/core/event-bus.ts';

const IDS = ['file:open', 'file:open-recent', 'edit:compare-documents', 'edit:find', 'view:zoom-in', 'file:save', 'format:bold', 'insert:table', 'edit:undo'];

function dispatcherFor(context: Record<string, unknown>) {
  const executed: string[] = [];
  const definitions = new Map(IDS.map((id) => [id, { execute: () => executed.push(id) }]));
  const dispatcher = new CommandDispatcher(
    { get: (id: string) => definitions.get(id) } as any,
    { getContext: () => ({ isEditable: false, ...context }) } as any,
    new EventBus(),
  );
  for (const id of IDS) dispatcher.dispatch(id);
  return executed;
}

test('a license read-only window opens and compares documents but cannot edit or save', () => {
  assert.deepEqual(
    dispatcherFor({ readOnly: true, readOnlyCanOpen: true }),
    ['file:open', 'file:open-recent', 'edit:compare-documents', 'edit:find', 'view:zoom-in'],
  );
});

test('a template preview window stays fixed on its document', () => {
  assert.deepEqual(dispatcherFor({ readOnly: true, readOnlyCanOpen: false }), ['edit:find', 'view:zoom-in']);
});

test('Heemang은 저장과 hm history만 열고 기존 편집·비교 명령은 차단한다', () => {
  assert.deepEqual(dispatcherFor({ engineKind: 'heemang', readOnly: false }),
    ['file:open', 'file:open-recent', 'view:zoom-in', 'file:save', 'edit:undo']);
  assert.deepEqual(dispatcherFor({ engineKind: 'heemang', readOnly: true, readOnlyCanOpen: true }),
    ['file:open', 'file:open-recent', 'view:zoom-in']);
  assert.deepEqual(dispatcherFor({ engineKind: 'heemang', userEditingLocked: true }),
    ['file:open', 'file:open-recent', 'view:zoom-in']);
});


test('Heemang wire commands bypass legacy handlers while preserving edit locks and default-engine routing', () => {
  const bus = new EventBus();
  const routed: unknown[] = [];
  bus.on('heemang-command', event => routed.push(event));
  let legacyCalls = 0;
  let context = { engineKind: 'heemang', hasDocument: true, readOnly: false, userEditingLocked: false };
  const dispatcher = new CommandDispatcher(
    { get: () => ({ canExecute() { legacyCalls++; return false; }, execute() { legacyCalls++; } }) } as any,
    { getContext: () => context } as any, bus,
  );
  for (const id of ['format:bold', 'format:apply-style', 'table:cell-merge', 'edit:cut', 'edit:find']) {
    assert.equal(dispatcher.isEnabled(id), true);
    assert.equal(dispatcher.dispatch(id, { value: 150 }), true);
  }
  assert.equal(legacyCalls, 0);
  assert.equal(routed.length, 5);
  assert.deepEqual(routed[0], { id: 'format:bold', params: { value: 150 } });
  context = { ...context, userEditingLocked: true };
  assert.equal(dispatcher.dispatch('format:bold'), false);
  assert.equal(dispatcher.dispatch('table:cell-merge'), false);
  assert.equal(dispatcher.dispatch('edit:cut'), false);
  context = { ...context, userEditingLocked: false, readOnly: true };
  assert.equal(dispatcher.dispatch('format:bold'), false);
  assert.equal(dispatcher.dispatch('edit:find'), true);
  context = { ...context, engineKind: 'rhwp', readOnly: false };
  assert.equal(dispatcher.dispatch('format:bold'), false);
  assert.equal(legacyCalls, 1);
  assert.equal(routed.length, 6);
});
