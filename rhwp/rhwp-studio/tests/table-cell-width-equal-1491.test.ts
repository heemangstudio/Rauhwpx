import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

import { createTestModuleServer } from './support/module-server.ts';

// #1491: 셀 너비·높이를 같게는 화면에 보이는 bbox 크기로 평균을 내고, 셀마다 로컬 resize
// 힌트를 보내며, 마우스 resize 처럼 되돌릴 수 있는 snapshot 편집 하나로 적용한다.
const vite = await createTestModuleServer(fileURLToPath(new URL('../', import.meta.url)));
const { tableCommands } = await vite.ssrLoadModule('/src/command/commands/table.ts') as typeof import('../src/command/commands/table.ts');
test.after(() => vite.close());

// 1행 3열 표. 모델 폭은 모두 3000 이지만 화면 폭은 40·60·80px(=3000·4500·6000 HWPUNIT)이다.
function run(id: string) {
  const resized: unknown[][] = [];
  const operations: string[] = [];
  const pos = { sectionIndex: 0, paragraphIndex: 0, charOffset: 0, parentParaIndex: 2, controlIndex: 0, cellIndex: 0 };
  const widths = [40, 60, 80];
  const heights = [20, 20, 40];
  const wasm = {
    getTableDimensions: () => ({ rowCount: 1, colCount: 3, cellCount: 3 }),
    getTableCellBboxes: () => widths.map((w, cellIdx) => ({ cellIdx, w, h: heights[cellIdx] })),
    getCellInfo: (_s: number, _p: number, _c: number, i: number) => ({ row: 0, col: i, rowSpan: 1, colSpan: 1 }),
    getCellProperties: () => ({ width: 3000, height: 1500 }),
    resizeTableCells: (...args: unknown[]) => { resized.push(args); },
  };
  const ih = {
    getCursorPosition: () => pos,
    isInCellSelectionMode: () => false,
    executeOperation(desc: { kind: string; operationType: string; operation(w: unknown): unknown }) {
      operations.push(`${desc.kind}:${desc.operationType}`);
      assert.equal(desc.operation(wasm), pos);
    },
  };
  const command = tableCommands.find((c) => c.id === id)!;
  command.execute({ wasm, getInputHandler: () => ih } as never);
  return { resized, operations };
}

test('셀 너비를 같게는 표시 폭 평균으로 셀마다 로컬 resize 힌트를 보내고 undo 가능한 편집 하나로 적용한다', () => {
  const { resized, operations } = run('table:cell-width-equal');
  assert.deepEqual(operations, ['snapshot:equalizeTableCellWidths']);
  assert.deepEqual(resized, [[0, 2, 0, [0, 1, 2].map((cellIdx) => ({
    cellIdx, widthDelta: 1500, localResize: true, renderWidth: 4500,
  }))]]);
});

test('셀 높이를 같게는 표시 높이 평균으로 행 모델 높이를 건드리지 않고 적용한다', () => {
  const { resized, operations } = run('table:cell-height-equal');
  assert.deepEqual(operations, ['snapshot:equalizeTableCellHeights']);
  assert.deepEqual(resized, [[0, 2, 0, [0, 1, 2].map((cellIdx) => ({
    cellIdx, heightDelta: 0, localResize: true, renderHeight: 2000,
  }))]]);
});
