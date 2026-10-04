import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import puppeteer from 'puppeteer-core';
import { createServer } from 'vite';
import { browserExecutable, browserLaunchArgs, requireWasmPackage } from './browser-support.ts';

const studioRoot = fileURLToPath(new URL('../', import.meta.url));
const rhwpRoot = resolve(studioRoot, '..');
const wasmPackageRoot = process.env.RHWP_WASM_PACKAGE_DIR ?? resolve(rhwpRoot, 'pkg');
requireWasmPackage(wasmPackageRoot);

// 커서의 평면 필드(parentParaIndex/controlIndex/cellIndex)는 바깥 표를 가리킨다.
// 중첩 표 안에서 표 명령이 평면 API 를 쓰면 화면 밖 바깥 표를 조용히 고친 채 저장된다.
test('중첩 표 안의 표 명령은 바깥 표를 고치지 않고 안쪽 표에만 적용된다', { timeout: 60_000 }, async () => {
  const server = await createServer({
    root: studioRoot,
    configFile: false,
    cacheDir: resolve(studioRoot, 'node_modules/.vite-table-nested-commands-test'),
    logLevel: 'silent',
    resolve: {
      alias: {
        '@': resolve(studioRoot, 'src'),
        '@wasm/rhwp.js': resolve(wasmPackageRoot, 'rhwp.js'),
        '@wasm': wasmPackageRoot,
      },
    },
    server: {
      host: '127.0.0.1',
      port: 0,
      hmr: false,
      fs: { allow: [studioRoot, wasmPackageRoot] },
    },
  });
  let browser: Awaited<ReturnType<typeof puppeteer.launch>> | undefined;
  try {
    await server.listen();
    const address = server.httpServer?.address();
    assert.ok(address && typeof address !== 'string');
    browser = await puppeteer.launch({ executablePath: browserExecutable(), headless: true, args: browserLaunchArgs() });
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${address.port}/tests/fixtures/version-store-idb.html`);
    const result = await page.evaluate(async () => {
      const [{ WasmBridge }, { EventBus }, { tableCommands }] = await Promise.all([
        import('/src/core/wasm-bridge.ts'),
        import('/src/core/event-bus.ts'),
        import('/src/command/commands/table.ts'),
      ]);
      const wasm = new WasmBridge();
      await wasm.initialize();
      wasm.createNewDocument();
      wasm.insertText(0, 0, 0, 'A');
      wasm.splitParagraph(0, 0, 1);
      // 바깥 2x2 표의 첫 셀에 안쪽 2x2 표를 붙여 넣는다.
      const outer = wasm.createTableEx({ sectionIdx: 0, paraIdx: 0, charOffset: 1, rowCount: 2, colCount: 2 });
      const source = wasm.createTableEx({
        sectionIdx: 0, paraIdx: wasm.getParagraphCount(0) - 1, charOffset: 0, rowCount: 2, colCount: 2,
      });
      wasm.copyControl(0, source.paraIdx, source.controlIdx);
      wasm.pasteInternalInCell(0, outer.paraIdx, outer.controlIdx, 0, 0, 0);
      const ppi = outer.paraIdx;
      const ci = outer.controlIdx;
      const innerPath = (cellIndex: number) => [
        { controlIndex: ci, cellIndex: 0, cellParaIndex: 0 },
        { controlIndex: 0, cellIndex, cellParaIndex: 0 },
      ];
      const innerPos = (cellIndex: number) => ({
        sectionIndex: 0, paragraphIndex: 0, charOffset: 0,
        parentParaIndex: ppi, controlIndex: ci, cellIndex: 0, cellParaIndex: 0,
        cellPath: innerPath(cellIndex),
      });
      const outerPos = (cellIndex: number) => ({
        sectionIndex: 0, paragraphIndex: 0, charOffset: 0,
        parentParaIndex: ppi, controlIndex: ci, cellIndex, cellParaIndex: 0,
        cellPath: [{ controlIndex: ci, cellIndex, cellParaIndex: 0 }],
      });
      wasm.insertTextInCell(0, ppi, ci, 1, 0, 0, '7');
      wasm.insertTextInCell(0, ppi, ci, 2, 0, 0, '3');
      wasm.insertTextInCell(0, ppi, ci, 3, 0, 0, '1234');
      wasm.insertTextInCellByPath(0, ppi, JSON.stringify(innerPath(1)), 0, '1234567');

      const outerText = (cellIndex: number, para = 0) => {
        const len = wasm.getCellParagraphLength(0, ppi, ci, cellIndex, para);
        return wasm.getTextInCell(0, ppi, ci, cellIndex, para, 0, len);
      };
      const innerText = (cellIndex: number) => {
        const path = JSON.stringify(innerPath(cellIndex));
        return wasm.getTextInCellByPath(0, ppi, path, 0, wasm.getCellParagraphLengthByPath(0, ppi, path));
      };
      const outerTexts = () => [0, 1, 2, 3].map((i) => outerText(i));
      const outerWidths = () => [0, 1, 2, 3].map((i) => wasm.getCellProperties(0, ppi, ci, i).width);
      const innerWidths = () => [0, 1, 2, 3]
        .map((i) => wasm.getCellPropertiesByPath(0, ppi, JSON.stringify(innerPath(0)), i).width);
      const innerDims = () => wasm.getTableDimensionsByPath(0, ppi, JSON.stringify(innerPath(0)));

      const operations: string[] = [];
      const run = (
        id: string,
        pos: Record<string, unknown>,
        selection?: { range: Record<string, number>; ctx: Record<string, unknown> },
      ) => {
        const ih = {
          getCursorPosition: () => pos,
          isInCellSelectionMode: () => Boolean(selection),
          hasMultiCellSelection: () => Boolean(selection),
          getSelectedCellRange: () => selection?.range ?? null,
          getCellTableContext: () => selection?.ctx ?? null,
          hasExcludedCellSelection: () => false,
          isInTableObjectSelection: () => false,
          getSelectedTableRef: () => null,
          executeOperation(desc: { kind: string; operationType: string; operation: (w: unknown) => unknown }) {
            operations.push(desc.operationType);
            desc.operation(wasm);
          },
        };
        const command = tableCommands.find((candidate) => candidate.id === id);
        if (!command) throw new Error(`missing ${id}`);
        command.execute({ wasm, eventBus: new EventBus(), getInputHandler: () => ih } as never);
      };
      const toasts = () => [...document.querySelectorAll('.rhwp-toast-message')].map((node) => node.textContent);

      // 바깥 표를 일부러 고르지 않게 만든다. 평면 경로로 새면 바깥 폭이 바뀐다.
      wasm.resizeTableCells(0, ppi, ci, [{ cellIdx: 1, widthDelta: 1500 }]);
      wasm.resizeTableCellsByPath(0, ppi, JSON.stringify(innerPath(0)), [{ cellIdx: 0, widthDelta: 1200 }]);

      const outerBefore = outerTexts();
      const outerWidthsBefore = outerWidths();
      const innerWidthsBefore = innerWidths();

      run('table:block-sum', innerPos(3));
      const afterBlockSum = outerTexts();

      run('table:formula', innerPos(3));
      const formulaDialogOpened = Boolean(document.querySelector('.dialog-overlay, .modal-overlay, [role="dialog"]'));

      run('table:cell-width-equal', innerPos(0), {
        range: { startRow: 0, startCol: 0, endRow: 1, endCol: 1 },
        ctx: { sec: 0, ppi, ci, cellPath: innerPath(0) },
      });

      run('table:thousand-sep', innerPos(1));
      run('table:thousand-sep', outerPos(3));

      return {
        outerBefore,
        afterBlockSum,
        outerAfter: outerTexts(),
        outerWidthsBefore,
        outerWidthsAfter: outerWidths(),
        innerWidthsBefore,
        innerWidthsAfter: innerWidths(),
        innerDims: innerDims(),
        innerCell1: innerText(1),
        operations,
        toasts: toasts(),
        formulaDialogOpened,
      };
    });

    assert.deepEqual(result.afterBlockSum, result.outerBefore, '블록 합계가 바깥 표 셀을 덮어쓰면 안 된다');
    assert.equal(result.formulaDialogOpened, false, '계산식 대화상자는 바깥 표 좌표로 열리면 안 된다');
    assert.ok(
      result.toasts.filter((text) => text === '중첩 표에서는 지원하지 않습니다.').length >= 2,
      '지원하지 않는 명령은 이유를 알린다',
    );

    assert.deepEqual(result.outerWidthsAfter, result.outerWidthsBefore, '셀 너비 균등화가 바깥 표를 바꾸면 안 된다');
    assert.notEqual(result.innerWidthsBefore[0], result.innerWidthsBefore[1], '전제: 안쪽 표 폭이 다르다');
    assert.ok(Math.abs(result.innerWidthsAfter[0] - result.innerWidthsAfter[1]) <= 1, `안쪽 표 폭이 같아진다: ${result.innerWidthsAfter}`);
    assert.deepEqual(result.innerDims, { rowCount: 2, colCount: 2, cellCount: 4 });

    assert.equal(result.innerCell1, '1,234,567', '천 단위 쉼표는 안쪽 셀에 적용된다');
    assert.deepEqual(
      result.outerAfter,
      [result.outerBefore[0], result.outerBefore[1], result.outerBefore[2], '1,234'],
      '바깥 표는 평면 경로 명령만 바꾼다',
    );
    assert.deepEqual(result.operations, ['equalizeTableCellWidths', 'cellNumberFormat', 'cellNumberFormat']);
  } finally {
    await browser?.close();
    await server.close();
  }
});

// 셀 목록은 병합 기준 셀만 담는다. 계산식 대화상자가 cellIndex 를 열 수로 나눠 좌표를 만들면
// 병합 머리글 아래에서 커서 셀이 아닌 다른 셀에 결과를 쓴다.
test('병합 표에서 계산식 대화상자는 커서 셀에 결과를 쓴다', { timeout: 60_000 }, async () => {
  const server = await createServer({
    root: studioRoot,
    configFile: false,
    cacheDir: resolve(studioRoot, 'node_modules/.vite-table-nested-commands-test'),
    logLevel: 'silent',
    resolve: {
      alias: {
        '@': resolve(studioRoot, 'src'),
        '@wasm/rhwp.js': resolve(wasmPackageRoot, 'rhwp.js'),
        '@wasm': wasmPackageRoot,
      },
    },
    server: {
      host: '127.0.0.1',
      port: 0,
      hmr: false,
      fs: { allow: [studioRoot, wasmPackageRoot] },
    },
  });
  let browser: Awaited<ReturnType<typeof puppeteer.launch>> | undefined;
  try {
    await server.listen();
    const address = server.httpServer?.address();
    assert.ok(address && typeof address !== 'string');
    browser = await puppeteer.launch({ executablePath: browserExecutable(), headless: true, args: browserLaunchArgs() });
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${address.port}/tests/fixtures/version-store-idb.html`);
    const result = await page.evaluate(async () => {
      const [{ WasmBridge }, { EventBus }, { FormulaDialog }] = await Promise.all([
        import('/src/core/wasm-bridge.ts'),
        import('/src/core/event-bus.ts'),
        import('/src/ui/formula-dialog.ts'),
      ]);
      const wasm = new WasmBridge();
      await wasm.initialize();
      wasm.createNewDocument();
      const table = wasm.createTableEx({ sectionIdx: 0, paraIdx: 0, charOffset: 0, rowCount: 3, colCount: 3 });
      const ppi = table.paraIdx;
      const ci = table.controlIdx;
      wasm.mergeTableCells(0, ppi, ci, 0, 0, 0, 2);
      const cellCount = wasm.getTableDimensions(0, ppi, ci).cellCount;
      const indexAt = (row: number, col: number) => {
        for (let i = 0; i < cellCount; i++) {
          const info = wasm.getCellInfo(0, ppi, ci, i);
          if (info.row === row && info.col === col) return i;
        }
        throw new Error(`no cell (${row},${col})`);
      };
      const text = (idx: number) => wasm.getTextInCell(0, ppi, ci, idx, 0, 0, wasm.getCellParagraphLength(0, ppi, ci, idx, 0));
      wasm.insertTextInCell(0, ppi, ci, indexAt(2, 0), 0, 0, '4');
      wasm.insertTextInCell(0, ppi, ci, indexAt(2, 1), 0, 0, '5');
      const target = indexAt(2, 2);

      const dialog = new FormulaDialog(wasm, new EventBus(), { sec: 0, ppi, ci, cellIndex: target });
      dialog.show();
      const internals = dialog as unknown as { formulaInput: HTMLInputElement; onConfirm(): boolean };
      internals.formulaInput.value = '=SUM(left)';
      const confirmed = internals.onConfirm();
      dialog.hide?.();
      return { confirmed, target: text(target), left: text(indexAt(2, 0)) };
    });

    assert.equal(result.confirmed, true);
    assert.equal(result.target, '9', '결과는 커서 셀에 들어간다');
    assert.equal(result.left, '4', '왼쪽 셀은 그대로다');
  } finally {
    await browser?.close();
    await server.close();
  }
});
