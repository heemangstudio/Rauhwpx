import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

import { createTestModuleServer } from './support/module-server.ts';

// [Task #3206/#3207] 머리말/꼬리말 진입은 이 쪽에 실제로 렌더되는 컨트롤을 대상으로 한다.
// 없을 때만 되돌릴 수 있는 snapshot 편집으로 만들고, 있으면 만들지 않고 들어간다.
const vite = await createTestModuleServer(fileURLToPath(new URL('../', import.meta.url)));
const { pageCommands } = await vite.ssrLoadModule('/src/command/commands/page.ts') as typeof import('../src/command/commands/page.ts');
test.after(() => vite.close());

function enterHeader(exists: boolean) {
  const created: unknown[][] = [];
  const operations: Array<{ kind: string; operationType: string }> = [];
  const entered: unknown[][] = [];
  const target = { sectionIndex: 1, applyTo: 2 };
  const wasm = {
    getHeaderFooterEditTarget: (page: number, isHeader: boolean) => {
      assert.deepEqual([page, isHeader], [3, true]);
      return target;
    },
    getHeaderFooter: (section: number, isHeader: boolean, applyTo: number) => {
      assert.deepEqual([section, isHeader, applyTo], [1, true, 2]);
      return JSON.stringify({ exists });
    },
    createHeaderFooter: (...args: unknown[]) => { created.push(args); },
  };
  const bodyPos = { sectionIndex: 1, paragraphIndex: 0, charOffset: 0 };
  const cursor = {
    rect: { pageIndex: 3 },
    getPosition: () => bodyPos,
    enterHeaderFooterMode: (...args: unknown[]) => { entered.push(args); },
    isInHeaderFooter: () => false,
  };
  const inputHandler = {
    cursor,
    executeOperation(desc: { kind: string; operationType: string; operation(w: unknown): unknown }) {
      operations.push({ kind: desc.kind, operationType: desc.operationType });
      assert.equal(desc.operation(wasm), bodyPos);
    },
  };
  const command = pageCommands.find((c) => c.id === 'page:header-create')!;
  command.execute({ wasm, eventBus: { emit() {} }, getInputHandler: () => inputHandler } as never);
  return { created, operations, entered };
}

test('머리말이 없으면 렌더 대상 좌표에 undo 가능한 snapshot 편집으로 만든 뒤 진입한다', () => {
  const { created, operations, entered } = enterHeader(false);
  assert.deepEqual(operations, [{ kind: 'snapshot', operationType: 'createHeaderFooter' }]);
  assert.deepEqual(created, [[1, true, 2]]);
  assert.deepEqual(entered, [[true, 1, 2, 3]]);
});

test('이미 있는 머리말은 만들지 않고 그 좌표로 진입한다', () => {
  const { created, operations, entered } = enterHeader(true);
  assert.deepEqual(operations, []);
  assert.deepEqual(created, []);
  assert.deepEqual(entered, [[true, 1, 2, 3]]);
});
