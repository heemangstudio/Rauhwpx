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
