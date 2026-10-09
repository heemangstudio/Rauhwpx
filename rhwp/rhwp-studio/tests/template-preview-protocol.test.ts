import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test, { after, before } from 'node:test';
import { fileURLToPath } from 'node:url';

import { CommandDispatcher } from '../src/command/dispatcher.ts';
import { EventBus } from '../src/core/event-bus.ts';
import { AgentToolExecutor } from '../src/agent/tool-executor.ts';
import { createTestModuleServer } from './support/module-server.ts';

const rootDir = fileURLToPath(new URL('..', import.meta.url));
let vite: Awaited<ReturnType<typeof createTestModuleServer>>;
let inputHandlerProto: any;

before(async () => {
  vite = await createTestModuleServer(rootDir);
  inputHandlerProto = (await vite.ssrLoadModule('/src/engine/input-handler.ts')).InputHandler.prototype;
});

after(async () => {
  await vite?.close();
});

/** 건드리면 바로 실패하는 문서 서비스. 읽기 전용 게이트가 먼저 막았는지 본다. */
function untouchable(name: string): any {
  return new Proxy({}, {
    get: (_target, key) => {
      throw new Error(`read-only preview touched ${name}.${String(key)}`);
    },
  });
}

test('read-only preview input handler blocks operations, snapshots, typing, keys, cut and paste', () => {
  let textareaResets = 0;
  const handler: any = Object.create(inputHandlerProto);
  Object.assign(handler, {
    active: true,
    readOnly: true,
    userEditingLocked: false,
    cursor: untouchable('cursor'),
    wasm: untouchable('wasm'),
    history: untouchable('history'),
    imeSession: untouchable('imeSession'),
    resetTextareaBuffer: () => { textareaResets += 1; },
  });
  let prevented = 0;
  const event = (extra: Record<string, unknown> = {}) => ({
    preventDefault: () => { prevented += 1; },
    key: 'Backspace',
    code: 'Backspace',
    ...extra,
  });

  handler.executeOperation({ kind: 'command', command: untouchable('command') });
  assert.throws(() => handler.executeAppliedSnapshot('replace', () => 1), /template preview is read-only/);
  handler.onInput({ inputType: 'insertText', data: '가', isComposing: false });
  handler.onKeyDown(event());
  handler.onKeyDown(event({ key: 'v', code: 'KeyV', ctrlKey: true }));
  handler.onCut(event());
  handler.onPaste(event({ clipboardData: untouchable('clipboardData') }));
  assert.equal(prevented, 4);
  assert.ok(textareaResets >= 3, 'typed text must not stay queued for a later edit');
});


// 남은 소스 가드: 템플릿 블록 전송은 실제 템플릿 문서·네이티브 importer 를 거쳐야 해서
// 단위 테스트로 재현하기 어렵다. URL 플래그 배선은 main-entry-guards.test.ts 가 지킨다.
test('template block insertion transfers exact source bytes through the native importer', () => {
  const toolExecutor = readFileSync(new URL('../src/agent/tool-executor.ts', import.meta.url), 'utf8');
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
  const definitions = new Map(['edit:copy', 'view:zoom-in', 'insert:table', 'file:save'].map((id) => [
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
