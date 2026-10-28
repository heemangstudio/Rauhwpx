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
type PathEntry = { controlIndex: number; cellIndex: number; cellParaIndex: number };

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

/** 바깥 2x2 표의 첫 셀에 안쪽 2x2 표를 붙여 넣는다. */
function nested(wasm: Wasm) {
  const outer = table(wasm, 2, 2);
  const source = wasm.createTableEx({ sectionIdx: 0, paraIdx: wasm.getParagraphCount(0) - 1, charOffset: 0, rowCount: 2, colCount: 2 });
  wasm.copyControl(0, source.paraIdx, source.controlIdx);
  wasm.pasteInternalInCell(0, outer.ppi, outer.ci, 0, 0, 0);
  const inner = (cellIndex: number): PathEntry[] => [{ controlIndex: outer.ci, cellIndex: 0, cellParaIndex: 0 }, { controlIndex: 0, cellIndex, cellParaIndex: 0 }];
  const innerText = (cellIndex: number) => {
    const path = JSON.stringify(inner(cellIndex));
    return wasm.getTextInCellByPath(0, outer.ppi, path, 0, wasm.getCellParagraphLengthByPath(0, outer.ppi, path));
  };
  const innerPos = (cellIndex: number) => ({ ...outer.pos(0), cellPath: inner(cellIndex) });
  return { outer, inner, innerText, innerPos };
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

test('중첩 표에서 블록 계산·계산식·셀 속성은 안쪽 표를 다루고 바깥 표는 그대로 둔다', async t => {
  const { wasm } = await openHeemangAgent(t, FIXTURES.blankHwpx);
  const { outer, inner, innerText, innerPos } = nested(wasm);
  wasm.insertTextInCell(0, outer.ppi, outer.ci, 1, 0, 0, '7');
  wasm.insertTextInCell(0, outer.ppi, outer.ci, 3, 0, 0, '100');
  wasm.insertTextInCellByPath(0, outer.ppi, JSON.stringify(inner(0)), 0, '40');
  wasm.insertTextInCellByPath(0, outer.ppi, JSON.stringify(inner(1)), 0, '2');
  const outerBefore = [0, 1, 2, 3].map(i => outer.text(i));
  toasts.length = 0;

  run(wasm, 'table:block-sum', innerPos(2));
  assert.equal(innerText(2), '40', '블록 합계는 안쪽 표의 위 칸을 더한다');
  run(wasm, 'table:block-product', innerPos(3));
  assert.equal(innerText(3), '2');
  assert.deepEqual([0, 1, 2, 3].map(i => outer.text(i)).slice(1), outerBefore.slice(1), '바깥 표 셀은 바뀌지 않는다');
  assert.deepEqual(toasts, []);

  dialogs.length = 0;
  run(wasm, 'table:formula', innerPos(3));
  run(wasm, 'table:cell-props', innerPos(1));
  run(wasm, 'table:border-each', innerPos(1));
  const [formula, props, border] = dialogs;
  assert.deepEqual([formula.name, props.name, border.name], ['FormulaDialog', 'TableCellPropsDialog', 'CellBorderBgDialog']);
  assert.deepEqual(formula.args[2], { sec: 0, ppi: outer.ppi, ci: outer.ci, cellPath: inner(3), cellIndex: 3 });
  assert.equal(props.args[3], 1, '셀 속성은 안쪽 표의 셀 번호로 연다');
  assert.equal(border.args[3], 1);

  // 대화상자가 쓰는 경로 API 는 안쪽 표의 셀과 표를 바꾼다.
  const path = JSON.stringify(inner(1));
  const outerCell = wasm.getCellProperties(0, outer.ppi, outer.ci, 1);
  const outerTable = wasm.getTableProperties(0, outer.ppi, outer.ci);
  wasm.setCellPropertiesByPath(0, outer.ppi, path, 1, { verticalAlign: 2, fillType: 'solid', fillColor: '#ff0000' });
  assert.equal(wasm.getCellPropertiesByPath(0, outer.ppi, path, 1).verticalAlign, 2);
  assert.equal(wasm.getCellPropertiesByPath(0, outer.ppi, path, 1).fillColor, '#ff0000');
  wasm.setTablePropertiesByPath(0, outer.ppi, path, { cellSpacing: 120 });
  assert.equal(wasm.getTablePropertiesByPath(0, outer.ppi, path).cellSpacing, 120);
  assert.deepEqual(wasm.getCellProperties(0, outer.ppi, outer.ci, 1), outerCell, '바깥 셀은 그대로다');
  assert.deepEqual(wasm.getTableProperties(0, outer.ppi, outer.ci), outerTable, '바깥 표는 그대로다');
});

test('캡션 넣기는 캡션 목록 끝에 커서를 두고 그 글이 저장된다', async t => {
  const { wasm, adapter } = await openHeemangAgent(t, FIXTURES.blankHwpx);
  const tb = table(wasm, 2, 2);
  const [[sec, ppi, ci, offset, captionIndex, cellPath]] = run(wasm, 'table:caption-toggle', tb.pos(0)).caption as unknown[][];
  assert.deepEqual([sec, ppi, ci, captionIndex], [0, tb.ppi, tb.ci, 4], '캡션 목록은 셀 목록 다음 번호다');
  assert.equal(wasm.getTableProperties(0, tb.ppi, tb.ci).hasCaption, true);
  assert.equal(offset, wasm.getCellParagraphLength(0, tb.ppi, tb.ci, 4, 0), '캡션 글 끝');
  wasm.insertTextInCell(0, tb.ppi, tb.ci, captionIndex as number, 0, offset as number, '설명');
  assert.equal((cellPath as unknown[]).length, 1);
  // 이미 캡션이 있으면 캡션을 하나 더 만들지 않고 그 끝으로 간다.
  const again = run(wasm, 'table:caption-toggle', tb.pos(0)).caption[0] as unknown[];
  assert.equal(again[3], wasm.getCellParagraphLength(0, tb.ppi, tb.ci, 4, 0));
  reopenBoth(wasm, adapter, () => assert.match(wasm.getTextInCell(0, tb.ppi, tb.ci, 4, 0, 0, 20), /설명$/));
});

test('중첩 표의 캡션 넣기는 안쪽 표에 캡션을 만든다', async t => {
  const { wasm, adapter } = await openHeemangAgent(t, FIXTURES.blankHwpx);
  const { outer, inner } = nested(wasm);
  const call = run(wasm, 'table:caption-toggle', { ...outer.pos(0), cellPath: inner(0) }).caption[0] as unknown[];
  assert.equal(call[4], 4);
  assert.deepEqual(call[5], inner(0));
  assert.equal(wasm.getTablePropertiesByPath(0, outer.ppi, JSON.stringify(inner(0))).hasCaption, true);
  assert.equal(wasm.getTableProperties(0, outer.ppi, outer.ci).hasCaption, false, '바깥 표에는 캡션이 생기지 않는다');
  const captionPath = JSON.stringify([inner(0)[0], { controlIndex: 0, cellIndex: 4, cellParaIndex: 0 }]);
  wasm.insertTextInCellByPath(0, outer.ppi, captionPath, call[3] as number, '안쪽');
  const text = () => wasm.getTextInCellByPath(0, outer.ppi, captionPath, 0, wasm.getCellParagraphLengthByPath(0, outer.ppi, captionPath));
  assert.match(text(), /안쪽$/);
  reopenBoth(wasm, adapter, () => assert.match(text(), /안쪽$/));
});

test('계산식은 대화상자가 고르는 함수와 비교식, @ 시작을 계산한다', async t => {
  const { wasm } = await openHeemangAgent(t, FIXTURES.blankHwpx);
  const tb = table(wasm, 3, 3);
  ['4', '9', '2.567', '-7', '3', ''].forEach((v, i) => v && wasm.insertTextInCell(0, tb.ppi, tb.ci, i, 0, 0, v));
  const value = (formula: string) => {
    const result = JSON.parse(wasm.evaluateTableFormula(0, tb.ppi, tb.ci, 2, 2, formula, false));
    if (!result.ok) throw new Error(result.error);
    return result.result;
  };
  const cases: Array<[string, number]> = [
    ['=SQRT(B1)', 3], ['=ROUND(C1)', 3], ['=ROUND(C1,2)', 2.57], ['=ROUND(-2.5)', -3], ['=ROUND(2.675,2)', 2.68],
    ['=CEILING(C1)', 3], ['=FLOOR(C1)', 2], ['=TRUNC(C1)', 2], ['=TRUNC(C1,1)', 2.5], ['=INT(-2.5)', -2],
    ['=MOD(A2,B2)', -1], ['=MOD(B1;A1)', 1], ['=SIGN(A2)', -1], ['=EXP(0)', 1], ['=LOG(1)', 0], ['=LOG10(1000)', 3],
    ['=SIN(0)', 0], ['=COS(0)', 1], ['=TAN(0)', 0], ['=ASIN(0)', 0], ['=ACOS(1)', 0], ['=RADIAN(180)', Math.PI],
    ['=IF(A1>B1,1,2)', 2], ['=IF(A1<B1,1,2)', 1], ['=IF(A1=4,10,20)', 10], ['=IF(A1<>4,10,20)', 20], ['=IF(A1>=4,SUM(A1:B1),0)', 13],
    ['@SUM(A1:B1)', 13], ['=sum(a1:b1)*2', 26], ['=AVG(A1:B1)', 6.5],
  ];
  for (const [formula, expected] of cases) assert.ok(Math.abs(value(formula) - expected) < 1e-9, `${formula} = ${value(formula)}`);
  for (const bad of ['=SQRT(A2)', '=MOD(A1,0)', '=IF(1,2)', '=NOPE(1)', '=A1>B1']) assert.throws(() => value(bad), undefined, bad);
});
