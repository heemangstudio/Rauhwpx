import assert from 'node:assert/strict';
import test from 'node:test';
import { startEditEngine, commandServices, assertUndoRedoRestores, documentFingerprint } from './support/edit-history-env.ts';

// 실제 엔진·커서·찾기 대화상자·편집 이력을 함께 통과한다. DOM 출력만 비운다.
const env = await startEditEngine();
const { FindDialog, isLiveFindHit } = await env.load('/src/ui/find-dialog.ts');
test.after(() => env.close());

for (const kind of ['body', 'cell', 'nested-cell'] as const) {
  test(`${kind}: 인라인 수식 뒤 찾기·왕복·치환은 인접 글자와 수식을 보존한다`, () => {
    const wasm = env.newDocument();
    let root = 0;
    const path: Array<{ controlIndex: number; cellIndex: number; cellParaIndex: number }> = [];
    if (kind !== 'body') {
      wasm.insertText(0, 0, 0, 'A');
      wasm.splitParagraph(0, 0, 1);
      const outer = wasm.createTable(0, 0, 1, 1, 1);
      root = outer.paraIdx;
      path.push({ controlIndex: outer.controlIdx, cellIndex: 0, cellParaIndex: 0 });
      if (kind === 'nested-cell') {
        const source = wasm.createTable(0, wasm.getParagraphCount(0) - 1, 0, 1, 1);
        wasm.copyControl(0, source.paraIdx, source.controlIdx);
        wasm.pasteInternalInCell(0, root, outer.controlIdx, 0, 0, 0, 'nest');
        path.push({ controlIndex: 0, cellIndex: 0, cellParaIndex: 0 });
      }
    }
    const json = JSON.stringify(path);
    if (path.length) {
      wasm.insertTextInCellByPath(0, root, json, 0, 'ABneedleZneedleQ');
      wasm.insertEquationInCellByPath(0, root, path, 1, 'x', 1000, 0);
    } else {
      wasm.insertText(0, root, 0, 'ABneedleZneedleQ');
      wasm.insertEquation(0, root, 1, 'x', 1000, 0);
    }
    const host = env.createHost(wasm);
    host.moveCursorTo(path.length ? {
      sectionIndex: 0, paragraphIndex: 0, charOffset: 0, parentParaIndex: root,
      controlIndex: path[0].controlIndex, cellIndex: 0, cellParaIndex: 0, cellPath: path,
    } : { sectionIndex: 0, paragraphIndex: root, charOffset: 0 });
    const dialog = new FindDialog(commandServices(host), 'find');
    Object.assign(dialog, {
      queryInput: { value: 'needle' }, caseSensitiveCheck: { checked: true },
      statusLabel: { style: {}, textContent: '' },
    });
    const read = (bridge: any) => path.length
      ? bridge.getTextInCellByPath(0, root, json, 0, bridge.getCellParagraphLengthByPath(0, root, json))
      : bridge.getTextRange(0, root, 0, bridge.getParagraphLength(0, root));
    const selected = () => {
      const { start, end } = host.getSelection();
      assert.deepEqual(start.cellPath ?? [], path);
      assert.deepEqual(end.cellPath ?? [], path);
      const count = end.charOffset - start.charOffset;
      return path.length
        ? wasm.getTextInCellByPath(0, root, json, start.charOffset, count, true)
        : wasm.getTextRange(0, root, start.charOffset, count, true);
    };
    const assertHit = (start: number, end: number) => {
      assert.equal(selected(), 'needle');
      assert.deepEqual([host.getSelection().start.charOffset, host.getSelection().end.charOffset], [start, end]);
    };
    dialog.findNext(); assertHit(3, 9);
    if (!path.length) {
      const hit = wasm.searchText('needle', 0, root, 0, true, true);
      assert.equal(isLiveFindHit(wasm.searchAllText('needle', true, false), hit, host.getSelection(), wasm), true);
    }
    dialog.findNext(); assertHit(10, 16);
    dialog.findPrev(); assertHit(3, 9);
    dialog.findPrev(); assertHit(10, 16); // 맨 앞에서 역방향 wrap.
    dialog.findNext(); assertHit(3, 9); // 마지막에서 정방향 wrap.

    const before = documentFingerprint(wasm);
    const selection = host.getSelection();
    host.executeOperation({ kind: 'command', command: new env.command.ReplaceSelectionCommand(selection.start, selection.end, 'X') });
    assert.equal(read(wasm), 'ABXZneedleQ');
    assertUndoRedoRestores(host, before);
    assert.equal(read(wasm), 'ABXZneedleQ');

    const reopened = env.openDocument(wasm.exportHwpx(), 'find-inline-object.hwpx');
    assert.equal(read(reopened), 'ABXZneedleQ');
    // 글자 A와 B 사이의 수식 한 칸도 저장·다시 열기 후 남아 있어야 한다.
    const toText = (at: number) => path.length
      ? reopened.logicalToTextOffsetInCellByPath(0, root, json, at)
      : reopened.logicalToTextOffset(0, root, at);
    assert.deepEqual([toText(1), toText(2), toText(3)], [1, 1, 2]);
    reopened.releaseDocument();
    wasm.releaseDocument();
  });
}
