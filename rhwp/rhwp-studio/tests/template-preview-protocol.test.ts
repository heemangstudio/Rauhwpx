import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { CommandDispatcher } from '../src/command/dispatcher.ts';
import { EventBus } from '../src/core/event-bus.ts';
import { AgentToolExecutor } from '../src/agent/tool-executor.ts';
import { createTestModuleServer } from './support/module-server.ts';

const bridge = readFileSync(new URL('../src/agent/bridge.ts', import.meta.url), 'utf8');
const sidebar = readFileSync(new URL('../src/ui/agent-sidebar/index.ts', import.meta.url), 'utf8');
const desktopIntegration = readFileSync(new URL('../src/desktop-integration.ts', import.meta.url), 'utf8');
const toolExecutor = readFileSync(new URL('../src/agent/tool-executor.ts', import.meta.url), 'utf8');
const css = readFileSync(new URL('../src/ui/agent-sidebar/agent-sidebar.css', import.meta.url), 'utf8');
const studioRoot = dirname(dirname(fileURLToPath(import.meta.url)));

test('template artifact opens read-only only after its main-chat card is clicked', () => {
  assert.doesNotMatch(bridge, /template-preview-ready/);
  assert.doesNotMatch(bridge, /template-preview-opened/);
  assert.match(desktopIntegration, /templatePreview'\) === '1' \? \{ readOnly: true \}/);
  assert.match(sidebar, /const card = el\('span', 'ag-md-artifact-card'\)/);
  assert.match(sidebar, /openPublishedDocumentInNewWindow\(artifact, undefined, \{ readOnly: artifact\.readOnly === true \}\)/);
  assert.match(css, /\.ag-md-artifact-card\s*\{[^}]*display:\s*flex;[^}]*border:/s);
  assert.match(css, /\.ag-md-artifact-open\s*\{[^}]*flex:\s*1 1 auto;/s);
});

test('read-only input blocks typing, clipboard writes, operations, and applied snapshots', async () => {
  const vite = await createTestModuleServer(studioRoot);
  try {
    const [{ InputHandler }, { onInput }, { onKeyDown, onCut, onPaste }] = await Promise.all([
      vite.ssrLoadModule('/src/engine/input-handler.ts'),
      vite.ssrLoadModule('/src/engine/input-handler-text.ts'),
      vite.ssrLoadModule('/src/engine/input-handler-keyboard.ts'),
    ]);
    const calls: string[] = [];
    const handler = Object.create(InputHandler.prototype) as any;
    handler.active = true;
    handler.textarea = { blur: () => calls.push('blur') };
    handler.container = { style: { cursor: 'text' } };
    handler.clearPendingCharFormat = () => calls.push('clear-format');
    handler.eventBus = { emit: () => {} };
    handler.resetTextareaBuffer = () => calls.push('reset-input');
    handler.wasm = { saveSnapshot: () => { calls.push('snapshot'); return 1; } };
    handler.history = { execute: () => calls.push('history') };

    handler.setReadOnly(true);
    assert.deepEqual(calls, ['blur', 'clear-format']);
    assert.equal(handler.container.style.cursor, '');

    onInput.call(handler, { data: 'blocked' });
    const event = { key: 'a', code: 'KeyA', ctrlKey: false, metaKey: false,
      shiftKey: false, altKey: false, preventDefault: () => calls.push('prevent') };
    onKeyDown.call(handler, event);
    onCut.call(handler, event);
    onPaste.call(handler, event);
    handler.executeOperation({ kind: 'command', command: { type: 'insertText' } });
    assert.throws(() => handler.executeAppliedSnapshot('replace', () => calls.push('edit')), /read-only/);
    assert.deepEqual(calls, ['blur', 'clear-format', 'reset-input', 'prevent', 'reset-input', 'prevent', 'prevent']);
  } finally {
    await vite.close();
  }
});

test('template block insertion transfers exact source bytes through the native importer', () => {
  const insertBlock = toolExecutor.match(
    /private async templateInsertBlock[\s\S]*?\n  dispose\(\): void/,
  )?.[0];
  assert.ok(insertBlock, 'templateInsertBlock implementation must be present');
  assert.match(insertBlock, /templateBytes\.slice\(\)/);
  assert.match(insertBlock, /pasteDocumentBlock\(/);
  assert.doesNotMatch(insertBlock, /exportSelectionHtml|pasteHtml/);
});

test('read-only dispatcher permits view/copy but rejects document and file mutations', () => {
  const executed: string[] = [];
  const definitions = new Map(['edit:copy', 'view:zoom-in', 'insert:table', 'format:bold', 'file:save'].map((id) => [
    id,
    { execute: () => executed.push(id) },
  ]));
  const dispatcherInstance = new CommandDispatcher(
    { get: (id: string) => definitions.get(id) } as any,
    { getContext: () => ({ readOnly: true, isEditable: false }) } as any,
    new EventBus(),
  );
  assert.equal(dispatcherInstance.dispatch('edit:copy'), true);
  assert.equal(dispatcherInstance.dispatch('view:zoom-in'), true);
  assert.equal(dispatcherInstance.dispatch('insert:table'), false);
  assert.equal(dispatcherInstance.dispatch('format:bold'), false);
  assert.equal(dispatcherInstance.dispatch('file:save'), false);
  assert.deepEqual(executed, ['edit:copy', 'view:zoom-in']);
});

test('read-only agent executor rejects mutation tools before touching document services', async () => {
  const executor = new AgentToolExecutor({
    wasm: {} as any,
    editor: {} as any,
    documentState: {} as any,
    revision: {} as any,
    pending: {} as any,
    isReadOnly: () => true,
  });
  await assert.rejects(
    executor.execute('insert_text', {}, 'codex'),
    (error: any) => error?.code === 'READ_ONLY_TEMPLATE_PREVIEW',
  );
});
