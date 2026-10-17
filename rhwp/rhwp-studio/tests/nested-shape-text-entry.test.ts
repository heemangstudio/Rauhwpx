import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';

if (!process.env.RHWP_SHAPE_ENTRY_CHILD) {
  test('중첩 글상자 진입은 실제 마우스·Enter·더블클릭 경로를 보존한다', () => {
    const child = spawnSync(process.execPath, ['--no-warnings', '--import',
      fileURLToPath(new URL('./support/ts-transform-hooks.mjs', import.meta.url)),
      fileURLToPath(import.meta.url)], {
      encoding: 'utf8', env: { ...process.env, NODE_TEST_CONTEXT: undefined, RHWP_SHAPE_ENTRY_CHILD: '1' },
    });
    process.stdout.write(child.stdout);
    assert.equal(child.status, 0, `${child.stdout}\n${child.stderr}`);
  });
} else {
  const source = new URL('../src/', import.meta.url);
  registerHooks({
    resolve(specifier, context, next) {
      if (specifier === '@wasm/rhwp.js') return { url: 'data:text/javascript,export default function init(){};export class HwpDocument{};export function version(){return "fixture"}', shortCircuit: true };
      if (specifier.startsWith('@/')) return { url: new URL(specifier.slice(2) + '.ts', source).href, shortCircuit: true };
      if (/^\.{1,2}\//.test(specifier) && !/\.[a-z]+$/.test(specifier)) return next(specifier + '.ts', context);
      return next(specifier, context);
    },
  });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: {
    addEventListener() {}, removeEventListener() {}, activeElement: null,
  } });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { setTimeout, clearTimeout } });
  const { CursorState } = await import('../src/engine/cursor.ts');
  const { InputHandler } = await import('../src/engine/input-handler.ts');
  const mouse = await import('../src/engine/input-handler-mouse.ts');
  const keyboard = await import('../src/engine/input-handler-keyboard.ts');

  function fixture(root = false, objectType = 'shape', outerKind = 'table') {
    const prefix = [{ controlIndex: 1, cellIndex: 0, cellParaIndex: 2 }];
    const ref: any = { sec: 1, ppi: 34, ci: 0, type: objectType,
      ...(!root ? { cellPath: structuredClone(prefix), outerTableControlIdx: 1 } : {}) };
    const path = root ? [{ controlIndex: 0, cellIndex: 0, cellParaIndex: 0 }]
      : [...prefix, { controlIndex: 0, cellIndex: 0, cellParaIndex: 0 }];
    let hit: any = { sectionIndex: 1, paragraphIndex: 0, charOffset: 1,
      parentParaIndex: 34, controlIndex: path[0].controlIndex,
      cellIndex: 0, cellParaIndex: path[0].cellParaIndex, cellPath: path,
      ...(root ? { isTextBox: true } : {}), cursorRect: { pageIndex: 12, x: 150, y: 130, height: 12 } };
    const reads: any[] = [];
    const ownerReads: any[] = [];
    const navReads: any[] = [];
    const wasm: any = { pageCount: 20, hitTest: () => structuredClone(hit),
      getCursorRectByPath: (...args: any[]) => { reads.push(args); return hit.cursorRect; },
      getCursorRectByPathNear: (...args: any[]) => { reads.push(args); return hit.cursorRect; },
      getCursorRectInCell: () => hit.cursorRect, getCursorRect: () => hit.cursorRect,
      getShapeProperties: (...args: any[]) => {
        ownerReads.push(['shape', ...args]);
        if (outerKind !== 'shape') throw new Error('not Shape');
        return {};
      },
      getTableProperties: (...args: any[]) => {
        ownerReads.push(['table', ...args]);
        if (outerKind !== 'table') throw new Error('not Table');
        return {};
      },
      getCellLogicalLengthByPath: (...args: any[]) => { navReads.push(['length', ...args]); return 5; },
      getCellParagraphCountByPath: (...args: any[]) => { navReads.push(['count', ...args]); return 2; },
      getTextInCellByPath: (...args: any[]) => {
        navReads.push(['text', ...args]); return 'ab cd'.slice(args[3], args[3] + args[4]);
      },
      logicalToTextOffsetInCellByPath: (_sec: number, _ppi: number, _path: string, offset: number) => offset,
      textToLogicalOffsetInCellByPath: (_sec: number, _ppi: number, _path: string, offset: number) => offset,
      getCellProperties: () => ({}), hitTestBodyFootnoteMarker: () => ({ hit: false }),
      pageHasFootnoteFootholds: () => false, hitTestHeaderFooter: () => ({ hit: false }),
      getFormObjectAt: () => ({ found: false }),
    };
    const cursor = new CursorState(wasm);
    const box = { left: 0, top: 0 };
    const scroll = { getBoundingClientRect: () => box, clientWidth: 1000 };
    let focus = 0;
    const handler: any = {
      active: true, wasm, cursor, readOnly: false, userEditingLocked: false, resetIosInputSession() {}, trimTextareaBufferIfIdle() {}, flushDeferredPaginationIfNeeded() {},
      container: { clientWidth: 1000, clientHeight: 1000, style: {},
        getBoundingClientRect: () => box, querySelector: () => scroll },
      viewportManager: { getZoom: () => 1 },
      virtualScroll: { getPageAtPoint: () => 12, getPageOffset: () => 0,
        getPageWidth: () => 1000, getPageLeftResolved: () => 0 },
      textarea: { focus() { focus++; } }, caret: { hide() {} }, fieldMarker: { hide() {} },
      selectionRenderer: { clear() {} }, pictureObjectRenderer: { clear() {}, getHandleAtPoint: () => null },
      eventBus: { emit() {} }, findPictureAtClick: () => ref,
      findPictureBbox: () => ({ pageIndex: 12, x: 100, y: 100, w: 100, h: 100 }),
      isTableBorderClick: () => false, findTableByOuterClick: () => null,
      findShapeByOuterClick: () => null, getObjectProperties: () => ({ treatAsChar: false }),
      renderPictureObjectSelection() {}, updateCaret() {}, startTextSelectionDrag() {},
      focusTextarea() { handler.textarea.focus(); },
      exitPictureObjectSelectionIfNeeded() { cursor.exitPictureObjectSelection(); },
      enterInlineEditing(...args: any[]) { return (InputHandler.prototype as any).enterInlineEditing.apply(handler, args); },
      enterTextboxEditing(...args: any[]) { return (InputHandler.prototype as any).enterTextboxEditing.apply(handler, args); },
    };
    const event = (x = 150, y = 150): any => ({ button: 0, detail: 1, clientX: x, clientY: y,
      shiftKey: false, ctrlKey: false, metaKey: false, altKey: false,
      target: { closest: () => null }, preventDefault() {} });
    return { handler, cursor, ref, path, event, reads, ownerReads, navReads, focus: () => focus,
      setHit: (value: any) => { hit = value; }, hit: () => hit };
  }

  test('중첩 Shape 텍스트 내부 클릭은 전체 경로와 hit 오프셋을 유지한다', () => {
    for (const offset of [0, 1]) {
      const f = fixture(); f.setHit({ ...f.hit(), charOffset: offset });
      mouse.onClick.call(f.handler, f.event());
      assert.equal(f.cursor.isInPictureObjectSelection(), false);
      assert.deepEqual(f.cursor.getPosition(), f.hit());
      assert.ok(f.focus() > 0);
    }
  });

  test('선택한 중첩 Shape의 Enter와 더블클릭은 소유 경로를 버리지 않는다', () => {
    for (const gesture of ['enter', 'double']) {
      const f = fixture(); f.cursor.enterPictureObjectSelectionRef(f.ref);
      if (gesture === 'enter') keyboard.onKeyDown.call(f.handler, { ...f.event(), key: 'Enter', code: 'Enter' });
      else mouse.onDblClick.call(f.handler, f.event());
      const pos = f.cursor.getPosition();
      assert.deepEqual(pos.cellPath, f.path);
      assert.equal(pos.sectionIndex, 1); assert.equal(pos.parentParaIndex, 34);
      assert.equal(pos.controlIndex, 1); assert.equal(pos.cellParaIndex, 2);
      assert.equal(pos.charOffset, 0); assert.notEqual(pos.isTextBox, true);
      assert.equal(f.cursor.isInPictureObjectSelection(), false);
      assert.ok(f.reads.some(args => JSON.stringify(JSON.parse(args[2])) === JSON.stringify(f.path)));
    }
  });

  test('선택된 글상자 내부 재클릭은 이동 드래그 대신 텍스트로 진입한다', () => {
    const f = fixture(); f.cursor.enterPictureObjectSelectionRef(f.ref);
    mouse.onClick.call(f.handler, f.event());
    assert.equal(f.handler.isPictureMoveDragging, undefined);
    assert.deepEqual(f.cursor.getPosition().cellPath, f.path);
    assert.equal(f.cursor.isInPictureObjectSelection(), false);
  });

  test('5px 테두리는 개체를 선택하고 중첩 image/equation이 우선한다', () => {
    for (const [kind, x] of [['shape', 102], ['image', 150], ['equation', 150]] as const) {
      const f = fixture(false, kind);
      mouse.onClick.call(f.handler, f.event(x));
      assert.equal(f.cursor.isInPictureObjectSelection(), true);
      assert.equal(f.cursor.getSelectedPictureRef()?.type, kind);
    }
  });

  test('동일한 숫자 인덱스라도 다른 소유 경로의 겹친 Shape는 텍스트로 오인하지 않는다', () => {
    const f = fixture(); f.ref.cellPath = [{ controlIndex: 1, cellIndex: 2, cellParaIndex: 2 }];
    mouse.onClick.call(f.handler, f.event());
    assert.equal(f.cursor.isInPictureObjectSelection(), true);
    assert.equal(f.cursor.getSelectedPictureRef()?.cellPath?.[0].cellIndex, 2);
  });

  test('깊은 소유 경로와 short 필드 표현을 Enter에서도 보존한다', () => {
    const f = fixture();
    const prefix = [{ controlIndex: 1, cellIndex: 2, cellParaIndex: 3 },
      { controlIndex: 4, cellIndex: 5, cellParaIndex: 6 }];
    f.ref.cellPath = prefix.map(p => ({ controlIdx: p.controlIndex, cellIdx: p.cellIndex, cellParaIdx: p.cellParaIndex }));
    const path = [...prefix, { controlIndex: 0, cellIndex: 0, cellParaIndex: 0 }];
    f.cursor.enterPictureObjectSelectionRef(f.ref);
    keyboard.onKeyDown.call(f.handler, { ...f.event(), key: 'Enter', code: 'Enter' });
    assert.deepEqual(f.cursor.getPosition().cellPath, path);
    assert.equal(f.cursor.getPosition().cellParaIndex, 3);
  });

  test('다른 루트·상위 문단·단말 컨트롤은 같은 글상자 hit가 아니다', () => {
    for (const change of [
      (f: any) => { f.ref.sec = 2; },
      (f: any) => { f.ref.ppi = 35; },
      (f: any) => { f.ref.cellPath[0].cellParaIndex = 3; },
      (f: any) => { f.ref.ci = 2; },
    ]) {
      const f = fixture(); change(f);
      mouse.onClick.call(f.handler, f.event());
      assert.equal(f.cursor.isInPictureObjectSelection(), true);
    }
  });

  test('선택된 글상자 테두리는 개체 선택을 유지하고 비본문 진입은 거부한다', () => {
    for (const x of [102, 198]) {
      const f = fixture(); f.cursor.enterPictureObjectSelectionRef(f.ref);
      mouse.onClick.call(f.handler, f.event(x));
      assert.equal(f.cursor.isInPictureObjectSelection(), true);
    }
    for (const domain of ['headerFooter', 'noteRef', 'memoRef']) {
      const f = fixture(); f.ref[domain] = {};
      f.handler.enterTextboxEditing(f.ref);
      assert.equal(f.cursor.getPosition().cellPath, undefined);
      assert.equal(f.reads.length, 0);
    }
  });

  test('선택 진입은 실제 최상위 Shape/Table 종류와 전체 소유 경로를 함께 보존한다', () => {
    for (const outerKind of ['shape', 'table']) {
      for (const withInnerTable of [false, true]) {
        for (const gesture of ['enter', 'double']) {
          const f = fixture(false, 'shape', outerKind);
          if (withInnerTable) f.ref.cellPath.push({ controlIndex: 4, cellIndex: 1, cellParaIndex: 3 });
          const path = [...f.ref.cellPath, { controlIndex: 0, cellIndex: 0, cellParaIndex: 0 }];
          f.cursor.enterPictureObjectSelectionRef(f.ref);
          if (gesture === 'enter') keyboard.onKeyDown.call(f.handler, { ...f.event(), key: 'Enter', code: 'Enter' });
          else mouse.onDblClick.call(f.handler, f.event());
          assert.deepEqual(f.cursor.getPosition().cellPath, path);
          assert.equal(f.cursor.isInTextBox(), outerKind === 'shape');
          assert.deepEqual(f.ownerReads[0], ['shape', 1, 34, 1]);
          if (outerKind === 'table') assert.deepEqual(f.ownerReads[1], ['table', 1, 34, 1]);
        }
      }
    }
  });

  test('중첩 Shape/Table 진입 후 문자·문단·단어 이동은 안쪽 전체 경로로 질의한다', () => {
    for (const outerKind of ['shape', 'table']) {
      for (const withInnerTable of [false, true]) {
        const f = fixture(false, 'shape', outerKind);
        if (withInnerTable) f.ref.cellPath.push({ controlIndex: 4, cellIndex: 1, cellParaIndex: 3 });
        const path = [...f.ref.cellPath, { controlIndex: 0, cellIndex: 0, cellParaIndex: 0 }];
        f.handler.enterTextboxEditing(f.ref);
        f.cursor.moveHorizontal(1);
        assert.ok(f.cursor.getRect());
        assert.equal(f.cursor.getPosition().charOffset, 1);
        assert.deepEqual(f.cursor.getPosition().cellPath, path);
        f.cursor.moveToParagraphBoundary(1);
        assert.ok(f.cursor.getRect());
        const nextPath = path.map((p, i) => i === path.length - 1 ? { ...p, cellParaIndex: 1 } : p);
        assert.equal(f.cursor.getPosition().charOffset, 0);
        assert.deepEqual(f.cursor.getPosition().cellPath, nextPath);
        f.cursor.moveToWordBoundary(1);
        assert.ok(f.cursor.getRect());
        assert.equal(f.cursor.getPosition().charOffset, 3);
        assert.deepEqual(f.cursor.getPosition().cellPath, nextPath);
        assert.equal(f.cursor.isInTextBox(), outerKind === 'shape');
        assert.ok(f.navReads.some(args => args[0] === 'length' && args[3] === JSON.stringify(path)));
        assert.ok(f.navReads.some(args => args[0] === 'text' && args[3] === JSON.stringify(nextPath)));
        assert.ok(f.navReads.every(args => args[1] === 1 && args[2] === 34));
      }
    }
  });

  test('단일 본문 글상자는 기존 한 단계 DFS 이동을 유지한다', () => {
    const f = fixture(true);
    const calls: any[] = [];
    f.handler.wasm.navigateNextEditable = (...args: any[]) => {
      calls.push(args);
      return { type: 'text', sec: 1, para: 0, charOffset: 1,
        context: [{ parentPara: 34, ctrlIdx: 0, ctrlTextPos: 0, cellIdx: 0, isTextBox: true }] };
    };
    f.handler.enterTextboxEditing(f.ref);
    f.cursor.moveHorizontal(1);
    assert.equal(f.cursor.getPosition().charOffset, 1);
    assert.equal(f.cursor.isInTextBox(), true);
    assert.equal(f.cursor.getPosition().cellPath, undefined);
    assert.equal(calls.length, 1);
    assert.deepEqual(JSON.parse(calls[0][4]), [{ parentPara: 34, ctrlIdx: 0, ctrlTextPos: 0, cellIdx: 0, isTextBox: true }]);
    assert.equal(f.navReads.length, 0);
  });

  test('최상위 소유 컨트롤을 확인할 수 없으면 다른 본문 위치로 진입하지 않는다', () => {
    const f = fixture(false, 'shape', 'unknown');
    const before = f.cursor.getPosition();
    f.handler.enterTextboxEditing(f.ref);
    assert.deepEqual(f.cursor.getPosition(), before);
    assert.equal(f.reads.length, 0);
  });

  function overlappingHeader(f: ReturnType<typeof fixture>) {
    const calls: any[] = [];
    f.handler.wasm.hitTestHeaderFooter = (...args: any[]) => {
      calls.push(args);
      return { hit: true, isHeader: true, sectionIndex: 1, applyTo: 2 };
    };
    f.handler.wasm.getHeaderFooter = () => JSON.stringify({ exists: true, text: '' });
    f.handler.wasm.getCursorRectInHeaderFooter = () => f.hit().cursorRect;
    f.handler.wasm.hitTestInHeaderFooter = () => ({ hit: false });
    return calls;
  }

  test('선택한 본문 글상자는 겹친 머리말보다 실제 전체 경로의 텍스트 진입을 우선한다', () => {
    for (const [root, outerKind] of [[false, 'table'], [false, 'shape'], [true, 'shape']] as const) {
      const f = fixture(root, 'shape', outerKind), headerCalls = overlappingHeader(f);
      f.cursor.enterPictureObjectSelectionRef(f.ref);
      mouse.onDblClick.call(f.handler, f.event());
      assert.equal(f.cursor.isInHeaderFooter(), false);
      assert.equal(f.cursor.isInPictureObjectSelection(), false);
      assert.deepEqual(f.cursor.getPosition().cellPath, root ? undefined : f.path);
      assert.equal(f.cursor.getPosition().charOffset, 0);
      assert.equal(f.cursor.isInTextBox(), outerKind === 'shape');
      assert.ok(f.cursor.getRect());
      assert.equal(headerCalls.length, 0);
    }
  });

  test('선택과 다른 포인터·경로는 머리말 더블클릭을 막지 않는다', () => {
    for (const scenario of ['unselected', 'outside', 'different-ref', 'different-hit', 'outer-shape-alias', 'query-error']) {
      const f = fixture(scenario === 'outer-shape-alias'), headerCalls = overlappingHeader(f);
      if (scenario !== 'unselected') f.cursor.enterPictureObjectSelectionRef(f.ref);
      if (scenario === 'outside') f.handler.findPictureAtClick = () => null;
      if (scenario === 'different-ref') f.handler.findPictureAtClick = () => ({ ...f.ref,
        cellPath: [{ controlIndex: 1, cellIndex: 2, cellParaIndex: 2 }] });
      if (scenario === 'different-hit') f.setHit({ ...f.hit(), parentParaIndex: 35 });
      if (scenario === 'outer-shape-alias') f.setHit({ ...f.hit(), cellPath: [
        ...f.path, { controlIndex: 0, cellIndex: 0, cellParaIndex: 0 },
      ] });
      if (scenario === 'query-error') f.handler.findPictureAtClick = () => { throw new Error('unavailable'); };
      mouse.onDblClick.call(f.handler, f.event());
      assert.equal(f.cursor.isInHeaderFooter(), true, scenario);
      assert.equal(f.cursor.headerFooterMode, 'header', scenario);
      assert.equal(f.cursor.hfSectionIdx, 1, scenario);
      assert.equal(f.cursor.hfApplyTo, 2, scenario);
      assert.equal(f.cursor.hfPreviewPage, 12, scenario);
      assert.equal(headerCalls.length, 1, scenario);
      assert.ok(f.cursor.getRect(), scenario);
    }
  });

  test('비본문 참조는 겹친 머리말의 더블클릭 우선순위를 유지한다', () => {
    for (const domain of ['headerFooter', 'noteRef', 'memoRef']) {
      const f = fixture(), headerCalls = overlappingHeader(f);
      f.ref[domain] = {};
      f.cursor.enterPictureObjectSelectionRef(f.ref);
      mouse.onDblClick.call(f.handler, f.event());
      assert.equal(f.cursor.isInHeaderFooter(), true, domain);
      assert.equal(headerCalls.length, 1, domain);
      assert.equal(f.reads.length, 0, domain);
    }
  });

  test('반복 앵커 더블클릭은 오래된 캐럿보다 실제 포인터 페이지를 우선한다', () => {
    for (const root of [true, false]) {
      for (const [pointerPage, stalePage, allowed] of [
        [12, 0, false], [0, 12, true], [-1, 0, true], [-1, 12, false],
      ] as const) {
        const f = fixture(root), headerCalls = overlappingHeader(f);
        f.ref.ppi = 0;
        f.setHit({ ...f.hit(), parentParaIndex: 0,
          cursorRect: { ...f.hit().cursorRect, pageIndex: stalePage } });
        f.cursor.moveTo({ sectionIndex: 1, paragraphIndex: 0, charOffset: 0 });
        assert.equal(f.cursor.getRect()?.pageIndex, stalePage);
        f.cursor.enterPictureObjectSelectionRef(f.ref);
        assert.equal(f.cursor.getRect()?.pageIndex, stalePage);
        // 선택은 캐럿을 갱신하지 않는다. 새 진입 질의만 실제 페이지 좌표를 돌려준다.
        f.setHit({ ...f.hit(), cursorRect: { ...f.hit().cursorRect,
          pageIndex: pointerPage >= 0 ? pointerPage : 0 } });
        f.handler.virtualScroll.getPageAtPoint = () => pointerPage;
        mouse.onDblClick.call(f.handler, f.event());
        const scenario = `${root ? 'root' : 'nested'} pointer=${pointerPage} stale=${stalePage}`;
        assert.equal(f.cursor.isInHeaderFooter(), false, scenario);
        assert.equal(f.cursor.isInPictureObjectSelection(), false, scenario);
        assert.equal(headerCalls.length, 0, scenario);
        if (allowed) {
          assert.equal(f.cursor.getPosition().parentParaIndex, 0, scenario);
          assert.equal(f.cursor.getPosition().charOffset, 0, scenario);
          assert.deepEqual(f.cursor.getPosition().cellPath, root ? undefined : f.path, scenario);
          assert.equal(f.cursor.getRect()?.pageIndex, 0, scenario);
          assert.equal(f.cursor.isInTextBox(), root, scenario);
        } else {
          assert.equal(f.cursor.getPosition().parentParaIndex, undefined, scenario);
          assert.equal(f.reads.length, 0, scenario);
          assert.equal(f.cursor.getRect()?.pageIndex, stalePage, scenario);
        }
      }
    }
  });

  test('실제 개체 lookup은 plane1 장식을 제외하고 머리말 더블클릭을 유지한다', () => {
    const f = fixture(true), headerCalls = overlappingHeader(f);
    f.ref.ppi = 0;
    f.setHit({ ...f.hit(), parentParaIndex: 0 });
    f.handler.wasm.getPageControlLayout = () => ({ controls: [{
      type: 'shape', secIdx: 1, paraIdx: 0, controlIdx: 0, plane: 1,
      x: 100, y: 100, w: 100, h: 100,
    }] });
    f.handler.findPictureAtClick = (...args: any[]) =>
      (InputHandler.prototype as any).findPictureAtClick.apply(f.handler, args);
    assert.equal(f.handler.findPictureAtClick(12, 150, 150), null);
    f.cursor.enterPictureObjectSelectionRef(f.ref);
    mouse.onDblClick.call(f.handler, f.event());
    assert.equal(f.cursor.isInHeaderFooter(), true);
    assert.equal(f.cursor.headerFooterMode, 'header');
    assert.equal(headerCalls.length, 1);
    assert.equal(f.reads.length, 0);
  });

  test('겹친 머리말이 있어도 선택한 반복 master 앵커의 진입 제한을 유지한다', () => {
    const f = fixture(true), headerCalls = overlappingHeader(f);
    f.ref.ppi = 0;
    f.setHit({ ...f.hit(), parentParaIndex: 0 });
    f.cursor.enterPictureObjectSelectionRef(f.ref);
    mouse.onDblClick.call(f.handler, f.event());
    assert.equal(f.cursor.isInHeaderFooter(), false);
    assert.equal(f.cursor.isInPictureObjectSelection(), false);
    assert.equal(f.cursor.getPosition().parentParaIndex, undefined);
    assert.equal(f.reads.length, 0);
    assert.equal(headerCalls.length, 0);
    assert.ok(f.focus() > 0);
  });

  test('반복 master 앵커의 더블클릭 제한은 유지한다', () => {
    const f = fixture(true); f.ref.ppi = 0;
    f.cursor.enterPictureObjectSelectionRef(f.ref);
    mouse.onDblClick.call(f.handler, f.event());
    assert.equal(f.cursor.isInPictureObjectSelection(), false);
    assert.equal(f.cursor.getPosition().parentParaIndex, undefined);
    assert.equal(f.reads.length, 0);
    assert.ok(f.focus() > 0);
  });

  test('본문 글상자와 직접 캡션 진입의 기존 flat 의미를 보존한다', () => {
    const f = fixture(true); mouse.onClick.call(f.handler, f.event());
    assert.deepEqual(f.cursor.getPosition(), f.hit());
    const root = fixture(true); root.cursor.enterPictureObjectSelectionRef(root.ref);
    keyboard.onKeyDown.call(root.handler, { ...root.event(), key: 'Enter', code: 'Enter' });
    assert.equal(root.cursor.getPosition().isTextBox, true);
    assert.equal(root.cursor.getPosition().cellPath, undefined);
    const caption = fixture(true);
    caption.handler.enterInlineEditing(1, 34, 0, 4);
    assert.deepEqual(caption.cursor.getPosition(), { sectionIndex: 1, paragraphIndex: 0,
      charOffset: 4, parentParaIndex: 34, controlIndex: 0, cellIndex: 0, cellParaIndex: 0, isTextBox: true });
  });
}
