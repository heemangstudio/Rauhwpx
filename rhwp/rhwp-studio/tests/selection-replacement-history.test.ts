import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { registerHooks } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

if (!process.env.RHWP_REPLACEMENT_HISTORY_CHILD) {
  test('선택 치환의 입력·IME·붙여넣기 이력은 사용자 동작 단위로 복원된다', () => {
    const childEnv = { ...process.env, RHWP_REPLACEMENT_HISTORY_CHILD: '1' };
    delete childEnv.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, [
      '--no-warnings', '--import',
      new URL('./support/ts-transform-hooks.mjs', import.meta.url).href,
      fileURLToPath(import.meta.url),
    ], { encoding: 'utf8', env: childEnv });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  });
} else {
  const src = join(dirname(fileURLToPath(import.meta.url)), '../src');
  registerHooks({
    resolve(specifier, context, next) {
      if (specifier.startsWith('@/')) {
        return { url: pathToFileURL(join(src, specifier.slice(2) + '.ts')).href, shortCircuit: true };
      }
      if ((specifier.startsWith('./') || specifier.startsWith('../')) && !/\.[cm]?[tj]s$/.test(specifier)) {
        return { url: new URL(specifier + '.ts', context.parentURL).href, shortCircuit: true };
      }
      return next(specifier, context);
    },
  });
  const { CommandHistory } = await import('../src/engine/history.ts');
  const commands = await import('../src/engine/command.ts');
  const input = await import('../src/engine/input-handler-text.ts');
  const { ImeSession } = await import('../src/engine/ime-session.ts');
  const keyboard = await import('../src/engine/input-handler-keyboard.ts');

  function fixture(nested: boolean) {
    let state = { text: 'A길😀B', format: ['a', 'selected', 'emoji', 'b'], provenance: 'imported' };
    let nextId = 0;
    const snapshots = new Map<number, typeof state>();
    const base = {
      sectionIndex: 0, paragraphIndex: 0, charOffset: 0,
      ...(nested ? {
        parentParaIndex: 0, controlIndex: 6, cellIndex: 0, cellParaIndex: 0,
        cellPath: [{ controlIndex: 6, cellIndex: 0, cellParaIndex: 3 },
          { controlIndex: 0, cellIndex: 1, cellParaIndex: 0 }],
      } : {}),
    };
    let position = { ...base, charOffset: 3 };
    let selection: any = { start: { ...base, charOffset: 1 }, end: { ...base, charOffset: 3 } };
    const mutate = (at: number, count: number, text: string) => {
      const chars = [...state.text];
      chars.splice(at, count, ...text);
      state.text = chars.join('');
      state.format.splice(at, count, ...[...text].map(() => 'inserted'));
      return JSON.stringify({ ok: true, charOffset: at + [...text].length });
    };
    const assertPath = (path: string) => assert.deepEqual(JSON.parse(path), base.cellPath);
    const wasm: any = {
      saveSnapshot() { const id = ++nextId; snapshots.set(id, structuredClone(state)); return id; },
      shareSnapshot(id: number) { const shared = ++nextId; snapshots.set(shared, structuredClone(snapshots.get(id)!)); return shared; },
      restoreSnapshot(id: number) { assert.ok(snapshots.has(id)); state = structuredClone(snapshots.get(id)!); },
      discardSnapshot(id: number) { assert.equal(snapshots.delete(id), true); },
      deleteRange(_s: number, _p: number, at: number, _ep: number, end: number) { return mutate(at, end - at, ''); },
      deleteRangeInCellByPath(_s: number, _p: number, path: string, _cp: number, at: number, _ep: number, end: number) {
        assertPath(path); return mutate(at, end - at, '');
      },
      insertText(_s: number, _p: number, at: number, text: string) { return mutate(at, 0, text); },
      insertTextInCellByPath(_s: number, _p: number, path: string, at: number, text: string) {
        assertPath(path); return mutate(at, 0, text);
      },
      replaceBodyTextLocal(_s: number, _p: number, at: number, count: number, text: string) {
        return { ...JSON.parse(mutate(at, count, text)), documentPaginationPending: false, flowChanged: false };
      },
      deleteText(_s: number, _p: number, at: number, count: number) { return mutate(at, count, ''); },
      deleteTextInCellByPath(_s: number, _p: number, path: string, at: number, count: number) {
        assertPath(path); return mutate(at, count, '');
      },
    };
    const history = new CommandHistory();
    const handler: any = {
      active: true, wasm, history, eventBus: { emit() {} },
      cursor: {
        isInHeaderFooter: () => false, isInFootnote: () => false,
        isInPictureObjectSelection: () => false, isInTableObjectSelection: () => false,
        hasSelection: () => !!selection, getSelectionOrdered: () => selection,
        getPosition: () => structuredClone(position), getRect: () => ({ pageIndex: 0 }),
        clearSelection() { selection = null; }, moveTo(pos: typeof position) { position = structuredClone(pos); },
      },
      imeSession: new ImeSession(),
      unconsumedTextareaValue: () => '', consumeTextareaValue() {},
      canDeleteSelectionInFormMode: () => true, canInsertTextInFormMode: () => true,
      canDeleteTextInFormMode: () => true,
      resetRawTextMutationEffects() {}, consumeRawTextMutationBeforeCursor: () => false,
      afterEdit() {}, afterTextInputEdit() {}, resetTextareaBuffer() {},
      captureCompositionAnchorRect() {}, clearCompositionAnchorRect() {}, updateCaret() {},
      caret: { hideComposition() {} },
      replaceTextAtRaw(pos: any, count: number, text: string) {
        return input.replaceTextAtRaw.call(handler, pos, count, text);
      },
      executeOperation(desc: any) {
        if (desc.kind === 'record') history.recordWithoutExecute(desc.command, wasm);
        else {
          const command = desc.kind === 'snapshot'
            ? new commands.SnapshotCommand(desc.operationType, handler.cursor.getPosition(), handler.cursor.getPosition(), desc.operation)
            : desc.command;
          const pos = history.execute(command, wasm);
          handler.cursor.clearSelection(); handler.cursor.moveTo(pos);
        }
      },
      deleteSelection() {
        const sel = selection;
        handler.cursor.clearSelection();
        handler.executeOperation({ kind: 'command', command: new commands.DeleteSelectionCommand(sel.start, sel.end) });
      },
    };
    Object.defineProperty(handler, 'isComposing', { get: () => handler.imeSession.isComposing });
    const original = structuredClone(state);
    return { handler, history, wasm, original, state: () => state, position: () => position, snapshots, mutate };
  }

  for (const nested of [false, true]) {
    test(`${nested ? '중첩 셀' : '본문'} 선택 치환은 서식·출처·경로를 한 번의 undo/redo로 복원한다`, () => {
      const f = fixture(nested);
      input.onInput.call(f.handler, { data: '민', inputType: 'insertText', isComposing: false } as InputEvent);
      assert.equal(f.state().text, 'A민B');
      const replaced = structuredClone(f.state());
      const undo = f.history.undo(f.wasm);
      assert.deepEqual(f.state(), f.original);
      assert.deepEqual(undo?.cellPath, f.position().cellPath);
      f.history.redo(f.wasm);
      assert.deepEqual(f.state(), replaced);
      f.history.clear(f.wasm);
      assert.equal(f.snapshots.size, 0);
    });

    test(`${nested ? '중첩 셀' : '본문'} 선택 위 연속 키 입력 전체를 한 번에 되돌린다`, () => {
      const f = fixture(nested);
      for (const data of 'XYZ') input.onInput.call(f.handler, { data, inputType: 'insertText', isComposing: false } as InputEvent);
      assert.equal(f.state().text, 'AXYZB');
      const replaced = structuredClone(f.state());
      f.history.undo(f.wasm);
      assert.deepEqual(f.state(), f.original);
      assert.equal(f.history.canUndo(), false);
      f.history.redo(f.wasm);
      assert.deepEqual(f.state(), replaced);
      // 한컴처럼 쉬었다가 이어 친 글자도 같은 입력 묶음이라 한 번에 되돌린다.
      f.history.execute(new commands.InsertTextCommand(f.position(), 'Q', Date.now() + 3000), f.wasm);
      assert.equal(f.state().text, 'AXYZQB');
      f.history.undo(f.wasm);
      assert.deepEqual(f.state(), f.original);
      f.history.clear(f.wasm);
      assert.equal(f.snapshots.size, 0);
    });

    test(`${nested ? '중첩 셀' : '본문'} 선택 위 IME 확정·취소는 다음 입력과 분리된다`, () => {
      for (const cancel of [false, true]) {
        const f = fixture(nested);
        input.onCompositionStart.call(f.handler);
        assert.equal(f.state().text, 'AB');
        input.onCompositionUpdate.call(f.handler, { data: 'ㅁ' } as CompositionEvent);
        input.onCompositionUpdate.call(f.handler, { data: '민' } as CompositionEvent);
        if (cancel) f.handler.imeSession.cancel();
        input.onCompositionEnd.call(f.handler, { data: cancel ? '' : '민' } as CompositionEvent);
        assert.equal(f.state().text, cancel ? 'A길😀B' : 'A민B');
        const beforeNextInput = structuredClone(f.state());
        input.onInput.call(f.handler, { data: 'X', inputType: 'insertText', isComposing: false } as InputEvent);
        f.history.undo(f.wasm);
        assert.deepEqual(f.state(), beforeNextInput);
        if (cancel) assert.equal(f.history.canUndo(), false);
        else {
          f.history.undo(f.wasm);
          assert.deepEqual(f.state(), f.original);
          f.history.redo(f.wasm);
          assert.deepEqual(f.state(), beforeNextInput);
        }
        f.history.clear(f.wasm);
        assert.equal(f.snapshots.size, 0);
      }
    });

    test(`${nested ? '중첩 셀' : '본문'} IME 취소는 기존 redo를 보존하고 확정할 때만 폐기한다`, () => {
      for (const cancel of [false, true]) {
        const f = fixture(nested);
        f.history.execute(new commands.InsertTextCommand({ ...f.position(), charOffset: 4 }, 'Q'), f.wasm);
        const priorEdit = structuredClone(f.state());
        f.history.undo(f.wasm);
        assert.equal(f.history.canRedo(), true);
        input.onCompositionStart.call(f.handler);
        input.onCompositionUpdate.call(f.handler, { data: '민' } as CompositionEvent);
        assert.equal(f.history.canRedo(), true);
        if (cancel) f.handler.imeSession.cancel();
        input.onCompositionEnd.call(f.handler, { data: cancel ? '' : '민' } as CompositionEvent);
        assert.equal(f.history.canRedo(), cancel);
        if (cancel) {
          f.history.redo(f.wasm);
          assert.deepEqual(f.state(), priorEdit);
        }
        f.history.clear(f.wasm);
        assert.equal(f.snapshots.size, 0);
      }
    });

    test(`${nested ? '중첩 셀' : '본문'} 내부 붙여넣기는 선택 삭제 이력을 따로 남기지 않는다`, () => {
      const f = fixture(nested);
      f.history.execute(new commands.InsertTextCommand({ ...f.position(), charOffset: 4 }, 'Q'), f.wasm);
      const beforePaste = structuredClone(f.state());
      f.wasm.hasInternalClipboard = () => true;
      f.wasm.getClipboardText = () => 'P';
      f.wasm.pasteInternal = (_s: number, _p: number, at: number) => f.mutate(at, 0, 'P');
      f.wasm.pasteInternalInCellByPath = (_s: number, _p: number, path: string, at: number) => {
        assert.deepEqual(JSON.parse(path), f.position().cellPath);
        return f.mutate(at, 0, 'P');
      };
      keyboard.onPaste.call(f.handler, { preventDefault() {}, clipboardData: null } as ClipboardEvent);
      assert.equal(f.state().text, 'APBQ');
      const pasted = structuredClone(f.state());
      f.history.undo(f.wasm);
      assert.deepEqual(f.state(), beforePaste);
      f.history.undo(f.wasm);
      assert.deepEqual(f.state(), f.original);
      f.history.redo(f.wasm);
      f.history.redo(f.wasm);
      assert.deepEqual(f.state(), pasted);
      f.history.clear(f.wasm);
      assert.equal(f.snapshots.size, 0);
    });

    test(`${nested ? '중첩 셀' : '본문'} 선택 치환 저장 실패와 조합 중단은 원본과 스냅샷 예산을 복원한다`, () => {
      for (const ime of [false, true]) {
        const f = fixture(nested);
        const save = f.wasm.saveSnapshot;
        let saves = 0;
        f.wasm.saveSnapshot = () => {
          if (++saves === 2) throw new Error('snapshot failed');
          return save();
        };
        if (ime) {
          input.onCompositionStart.call(f.handler);
          input.onCompositionUpdate.call(f.handler, { data: '민' } as CompositionEvent);
          assert.throws(() => input.onCompositionEnd.call(f.handler, { data: '민' } as CompositionEvent), /snapshot failed/);
        } else {
          assert.throws(() => input.onInput.call(f.handler, { data: '민', inputType: 'insertText' } as InputEvent), /snapshot failed/);
          assert.deepEqual(f.handler.cursor.getSelectionOrdered(), {
            start: { ...f.position(), charOffset: 1 }, end: { ...f.position(), charOffset: 3 },
          });
        }
        assert.deepEqual(f.state(), f.original);
        assert.equal(f.history.canUndo(), false);
        assert.equal(f.snapshots.size, 0);
      }
      const f = fixture(nested);
      input.onCompositionStart.call(f.handler);
      input.onCompositionUpdate.call(f.handler, { data: '민' } as CompositionEvent);
      input.revertCompositionPreview.call(f.handler);
      assert.deepEqual(f.state(), f.original);
      assert.equal(f.history.canUndo(), false);
      assert.equal(f.snapshots.size, 0);
      assert.equal(f.history.hasSnapshotCapacity(98), true);
    });

    test(`${nested ? '중첩 셀' : '본문'} 조합 스냅샷 여유가 없으면 기존 문서와 이력을 건드리지 않는다`, () => {
      const f = fixture(nested);
      f.history.execute(new commands.InsertTextCommand({ ...f.position(), charOffset: 4 }, 'Q'), f.wasm);
      const priorEdit = structuredClone(f.state());
      f.history.undo(f.wasm);
      f.history.hasSnapshotCapacity = () => false;
      input.onCompositionStart.call(f.handler);
      assert.deepEqual(f.state(), f.original);
      assert.equal(f.handler.isComposing, false);
      assert.equal(f.snapshots.size, 0);
      f.history.redo(f.wasm);
      assert.deepEqual(f.state(), priorEdit);
    });
  }
}
