import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { openHeemangAgent, FIXTURES } from './heemang-agent-env.ts';

// 표 명령을 실제 HeemangEngine 문서에 실행한다. 대화상자는 열지 않고, 명령이 만든 대화상자에
// 사용자의 선택을 넘긴다 (대화상자 자체는 브라우저 테스트가 다룬다).
const dialogs: Array<{ name: string; args: unknown[]; dialog: Record<string, any> }> = [];
const toasts: string[] = [];
Object.assign(globalThis, { __tableTestDialogs: dialogs, __tableTestToasts: toasts });
const stub = (name: string) => `export class ${name} { constructor(...args) { this.args = args; } ` +
  `show() { globalThis.__tableTestDialogs.push({ name: ${JSON.stringify(name)}, args: this.args, dialog: this }); } }`;
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('@/ui/')) {
      const source = ['TableCellPropsDialog', 'TableCreateDialog', 'CellSplitDialog', 'CellBorderBgDialog', 'FormulaDialog',
        'TableDeleteRowColumnDialog', 'TableInsertRowColumnDialog'].map(stub).join('\n') +
        '\nexport function showToast(o) { globalThis.__tableTestToasts.push(o.message); }';
      return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true };
    }
    if (specifier.startsWith('@/')) return next(new URL(`../src/${specifier.slice(2)}.ts`, import.meta.url).href, context);
    return next(specifier, context);
  },
});
const { tableCommands } = await import('../src/command/commands/table.ts');
hooks.deregister();

type Wasm = Awaited<ReturnType<typeof openHeemangAgent>>['wasm'];
type Range = { startRow: number; startCol: number; endRow: number; endCol: number };

/** 명령을 실제 엔진에 실행한다. 블록 선택이 있으면 그 범위와 표를 알린다. */
function run(wasm: Wasm, id: string, pos: Record<string, any>, selection?: { range: Range; ctx: Record<string, unknown> }) {
  const caption: unknown[] = [];
  const ih = {
    getCursorPosition: () => pos,
    isInCellSelectionMode: () => Boolean(selection),
    hasMultiCellSelection: () => Boolean(selection),
    getSelectedCellRange: () => selection?.range ?? null,
    getCellTableContext: () => selection?.ctx ?? null,
    hasExcludedCellSelection: () => false,
    exitCellSelectionMode: () => {},
    isInTableObjectSelection: () => false,
    getSelectedTableRef: () => null,
    exitTableObjectSelection: () => {},
    enterTableCaptionEditing: (...args: unknown[]) => caption.push(args),
    executeOperation(desc: { operation: (w: Wasm) => unknown }) { desc.operation(wasm); },
  };
  const command = tableCommands.find(c => c.id === id);
  if (!command) throw new Error(`missing ${id}`);
  command.execute({ wasm, eventBus: { emit() {} }, getInputHandler: () => ih } as never);
  return { caption };
}

function table(wasm: Wasm, rows: number, cols: number) {
  const { paraIdx: ppi, controlIdx: ci } = wasm.createTableEx({ sectionIdx: 0, paraIdx: 0, charOffset: 0, rowCount: rows, colCount: cols });
  const index = (row: number, col: number) => {
    for (let i = 0; i < wasm.getTableDimensions(0, ppi, ci).cellCount; i++) {
      const c = wasm.getCellInfo(0, ppi, ci, i);
      if (c.row === row && c.col === col) return i;
    }
    throw new Error(`no cell ${row},${col}`);
  };
  const text = (i: number) => wasm.getTextInCell(0, ppi, ci, i, 0, 0, wasm.getCellParagraphLength(0, ppi, ci, i, 0));
  const pos = (i: number) => ({ sectionIndex: 0, paragraphIndex: 0, charOffset: 0, parentParaIndex: ppi, controlIndex: ci,
    cellIndex: i, cellParaIndex: 0, cellPath: [{ controlIndex: ci, cellIndex: i, cellParaIndex: 0 }] });
  const grid = () => {
    const dims = wasm.getTableDimensions(0, ppi, ci);
    return { rows: dims.rowCount, cols: dims.colCount, cells: Array.from({ length: dims.cellCount }, (_, i) => {
      const c = wasm.getCellInfo(0, ppi, ci, i);
      return `${c.row},${c.col} ${c.rowSpan}x${c.colSpan} ${text(i)}`;
    }) };
  };
  return { ppi, ci, index, text, pos, grid, ctx: { sec: 0, ppi, ci } };
}

function reopenBoth(wasm: Wasm, adapter: { refreshLayout(): void }, check: () => void) {
  for (const [bytes, name] of [[wasm.exportHwp(), 'saved.hwp'], [wasm.exportHwpx(), 'saved.hwpx']] as const) {
    wasm.loadDocument(bytes, name);
    adapter.refreshLayout();
    check();
  }
}

test('줄 지우기는 셀 블록이 덮은 줄을 모두 지우고 저장 후에도 남은 줄만 있다', async t => {
  const { wasm, adapter } = await openHeemangAgent(t, FIXTURES.blankHwpx);
  const tb = table(wasm, 4, 2);
  ['r0', 'r1', 'r2', 'r3'].forEach((text, row) => wasm.insertTextInCell(0, tb.ppi, tb.ci, tb.index(row, 0), 0, 0, text));
  run(wasm, 'table:delete-row', tb.pos(tb.index(1, 1)), { range: { startRow: 1, startCol: 0, endRow: 2, endCol: 1 }, ctx: tb.ctx });
  const expected = { rows: 2, cols: 2, cells: ['0,0 1x1 r0', '0,1 1x1 ', '1,0 1x1 r3', '1,1 1x1 '] };
  assert.deepEqual(tb.grid(), expected);
  // 블록이 없으면 지금처럼 커서 줄 하나만 지운다.
  run(wasm, 'table:delete-row', tb.pos(tb.index(0, 0)));
  assert.deepEqual(tb.grid(), { rows: 1, cols: 2, cells: ['0,0 1x1 r3', '0,1 1x1 '] });
  reopenBoth(wasm, adapter, () => assert.deepEqual(tb.grid(), { rows: 1, cols: 2, cells: ['0,0 1x1 r3', '0,1 1x1 '] }));
});

test('칸 지우기는 셀 블록이 덮은 칸을 모두 지운다', async t => {
  const { wasm, adapter } = await openHeemangAgent(t, FIXTURES.blankHwp);
  const tb = table(wasm, 2, 4);
  ['c0', 'c1', 'c2', 'c3'].forEach((text, col) => wasm.insertTextInCell(0, tb.ppi, tb.ci, tb.index(0, col), 0, 0, text));
  run(wasm, 'table:delete-col', tb.pos(tb.index(0, 0)), { range: { startRow: 0, startCol: 0, endRow: 1, endCol: 2 }, ctx: tb.ctx });
  assert.deepEqual(tb.grid(), { rows: 2, cols: 1, cells: ['0,0 1x1 c3', '1,0 1x1 '] });
  reopenBoth(wasm, adapter, () => assert.deepEqual(tb.grid(), { rows: 2, cols: 1, cells: ['0,0 1x1 c3', '1,0 1x1 '] }));
});

test('셀을 합친 후 나누기는 블록을 한 셀로 합친 뒤 그 셀을 나눈다', async t => {
  const { wasm, adapter } = await openHeemangAgent(t, FIXTURES.blankHwpx);
  const tb = table(wasm, 3, 3);
  wasm.insertTextInCell(0, tb.ppi, tb.ci, tb.index(0, 0), 0, 0, 'A');
  wasm.insertTextInCell(0, tb.ppi, tb.ci, tb.index(1, 1), 0, 0, 'D');
  const block = { range: { startRow: 0, startCol: 0, endRow: 1, endCol: 1 }, ctx: tb.ctx };
  dialogs.length = 0;
  run(wasm, 'table:cell-split', tb.pos(tb.index(0, 0)), block);
  const split = dialogs.find(d => d.name === 'CellSplitDialog')!;
  assert.deepEqual(split.args, [true], '여러 셀 블록에서는 「셀을 합친 후 나누기」를 쓸 수 있다');
  split.dialog.onApply(2, 1, false, true);
  const grid = tb.grid();
  assert.equal(grid.rows, 3);
  assert.equal(grid.cols, 3);
  // 블록 자리에 2칸 폭의 셀 두 개가 생기고, 합친 내용은 첫 조각에 남는다.
  assert.deepEqual(grid.cells.filter(c => c.startsWith('0,0') || c.startsWith('1,0')), ['0,0 1x2 A', '1,0 1x2 ']);
  assert.equal(grid.cells.filter(c => /^[01],[01] /.test(c)).length, 2);
  reopenBoth(wasm, adapter, () => assert.deepEqual(tb.grid(), grid));

  // 합치지 않고 나누면 블록의 셀마다 나눈다.
  const other = table(wasm, 2, 2);
  dialogs.length = 0;
  run(wasm, 'table:cell-split', other.pos(0), { range: { startRow: 0, startCol: 0, endRow: 0, endCol: 1 }, ctx: other.ctx });
  dialogs.find(d => d.name === 'CellSplitDialog')!.dialog.onApply(1, 2, false, false);
  assert.equal(other.grid().cols, 4);
});
