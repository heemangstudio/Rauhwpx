import test from 'node:test';
import assert from 'node:assert/strict';

import { CommandDispatcher } from '../src/command/dispatcher.ts';
import { CommandRegistry } from '../src/command/registry.ts';
import type { CommandServices, EditorContext } from '../src/command/types.ts';
import { holdDocumentLoadingCommands } from '../src/recovery/trap-command-guard.ts';

/** 엔진이 멈춘 창의 명령 상태 (main.ts trappedEditorContext 와 같은 잠금). */
const trappedContext = {
  hasDocument: false,
  readOnly: true,
  userEditingLocked: true,
  isFormMode: false,
} as unknown as EditorContext;

function setup() {
  const ran: string[] = [];
  const held: string[] = [];
  let stopped = false;
  const registry = new CommandRegistry();
  for (const id of ['file:new-doc', 'file:open', 'file:open-recent', 'file:import-legacy-history', 'file:print']) {
    registry.register({ id, label: id, execute: () => { ran.push(id); } });
  }
  holdDocumentLoadingCommands(registry, () => {
    if (!stopped) return false;
    held.push('trap-recovery');
    return true;
  });
  const services = { getContext: () => trappedContext } as unknown as CommandServices;
  const bus = { emit: () => {} } as unknown as ConstructorParameters<typeof CommandDispatcher>[2];
  const dispatcher = new CommandDispatcher(registry, services, bus);
  return { dispatcher, ran, held, stop: () => { stopped = true; } };
}

test('before a trap, opening and creating documents run as usual', () => {
  const { dispatcher, ran, held } = setup();
  for (const id of ['file:new-doc', 'file:open', 'file:open-recent']) dispatcher.dispatch(id, { id: 'recent-1' });
  assert.deepEqual(ran, ['file:new-doc', 'file:open', 'file:open-recent']);
  assert.deepEqual(held, []);
});

test('after a trap, opening or creating a document never reaches the engine and points to 문서 복구', () => {
  const { dispatcher, ran, held, stop } = setup();
  stop();
  // 새 문서·열기·최근 문서는 엔진이 멈춰도 메뉴에서 눌린다 (편집 잠금이 허용하는 명령).
  for (const id of ['file:new-doc', 'file:open', 'file:open-recent']) dispatcher.dispatch(id, { id: 'recent-1' });
  assert.deepEqual(ran, [], 'no save prompt, file picker or load starts on the stopped engine');
  assert.equal(held.length, 3, 'each attempt explains the recovery path');
  dispatcher.dispatch('file:print');
  assert.deepEqual(ran, ['file:print'], 'commands that only read are left alone');
});
