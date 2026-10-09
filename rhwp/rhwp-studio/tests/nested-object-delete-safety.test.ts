import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test, { after, before } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  canGroupTopLevelBodyObjects,
  canUngroupTopLevelBodyObject,
  sameAddressedObject,
} from '../src/core/object-address.ts';
import { createTestModuleServer } from './support/module-server.ts';

// 셀 안 도형과 머리말/꼬리말 개체를 본문 삭제·묶기 API 로 넘기면 같은 숫자 주소의 엉뚱한
// 본문 개체가 지워지거나 묶인다. 실제 입력 처리기·명령으로 삭제 경로를 하나씩 눌러 본다.

const rootDir = fileURLToPath(new URL('..', import.meta.url));
let vite: Awaited<ReturnType<typeof createTestModuleServer>>;
let inputHandlerProto: any;
let insertCommands: Array<{ id: string; execute(services: unknown): void }>;

before(async () => {
  vite = await createTestModuleServer(rootDir);
  inputHandlerProto = (await vite.ssrLoadModule('/src/engine/input-handler.ts')).InputHandler.prototype;
  insertCommands = (await vite.ssrLoadModule('/src/command/commands/insert.ts')).insertCommands;
});

after(async () => {
  await vite?.close();
});

const BODY_SHAPE = { sec: 0, ppi: 3, ci: 1, type: 'shape' };
const CELL_SHAPE = { ...BODY_SHAPE, cellPath: [{ controlIndex: 0, cellIndex: 2, cellParaIndex: 0 }] };
const HEADER_IMAGE = { sec: 0, ppi: 3, ci: 1, type: 'image', headerFooter: { kind: 'header', applyTo: 0, paraIdx: 0 } };

/** 개체 하나가 선택된 입력 처리기. 스냅샷은 바로 실행하고 엔진 삭제 호출을 기록한다. */
function selectedObjectHandler(ref: Record<string, unknown>) {
  const deletes: string[] = [];
  const wasm = new Proxy({}, {
    get: (_target, key) => (...args: unknown[]) => {
      if (String(key).startsWith('delete')) deletes.push(`${String(key)}(${args.slice(0, 3).join(',')})`);
      return '{"ok":true}';
    },
  });
  const quiet: any = new Proxy({}, { get: () => () => false });
  const handler: any = Object.create(inputHandlerProto);
  Object.assign(handler, {
    active: true,
    readOnly: false,
    userEditingLocked: false,
    editMode: 'normal',
    eventBus: quiet,
    pictureObjectRenderer: quiet,
    caret: quiet,
    imeSession: { isComposing: false },
    textarea: quiet,
    wasm,
    cursor: new Proxy({
      isInPictureObjectSelection: () => true,
      getSelectedPictureRef: () => ref,
      getPosition: () => ({ sectionIndex: 0, paragraphIndex: 0, charOffset: 0 }),
    } as Record<string | symbol, unknown>, { get: (cursor, key) => cursor[key] ?? (() => false) }),
    performCopy: () => true,
    executeOperation: (op: { operation?: (wasm: unknown) => unknown }) => { op.operation?.(wasm); },
  });
  return { handler, deletes };
}

for (const [name, run] of [
  ['performDelete', (h: any) => h.performDelete()],
  ['performCut', (h: any) => h.performCut()],
  ['Delete key', (h: any) => h.onKeyDown({ key: 'Delete', code: 'Delete', preventDefault() {} })],
  ['insert:picture-delete', (h: any) => insertCommands
    .find((command) => command.id === 'insert:picture-delete')!
    .execute({ getInputHandler: () => ({
      getSelectedPictureRef: () => h.cursor.getSelectedPictureRef(),
      getCursorPosition: () => h.cursor.getPosition(),
      executeOperation: (op: any) => h.executeOperation(op),
      exitPictureObjectSelectionAndAfterEdit() {},
    }) })],
] as const) {
  test(`${name} never sends a cell or header object to the body delete API`, () => {
    for (const ref of [CELL_SHAPE, HEADER_IMAGE]) {
      const { handler, deletes } = selectedObjectHandler(ref);
      run(handler);
      assert.deepEqual(deletes, [], JSON.stringify(ref));
    }
    const body = selectedObjectHandler(BODY_SHAPE);
    run(body.handler);
    assert.deepEqual(body.deletes, ['deleteShapeControl(0,3,1)']);
  });
}

test('group and ungroup commands leave nested objects alone', () => {
  const calls: string[] = [];
  const wasm = {
    groupShapes: () => { calls.push('group'); return { paraIdx: 0, controlIdx: 0 }; },
    ungroupShape: () => { calls.push('ungroup'); },
  };
  const run = (id: string, refs: Array<Record<string, unknown>>) => insertCommands
    .find((command) => command.id === id)!
    .execute({
      wasm,
      getInputHandler: () => ({
        getSelectedPictureRefs: () => refs,
        getSelectedPictureRef: () => refs[0],
        getCursorPosition: () => ({ sectionIndex: 0, paragraphIndex: 0, charOffset: 0 }),
        executeOperation: (op: { operation?: (engine: unknown) => unknown }) => { op.operation?.(wasm); },
        exitPictureObjectSelectionAndAfterEdit() {},
        selectPictureObject() {},
      }),
    });

  run('insert:group-shapes', [BODY_SHAPE, CELL_SHAPE]);
  run('insert:ungroup-shapes', [{ ...CELL_SHAPE, type: 'group' }]);
  assert.deepEqual(calls, []);
  run('insert:group-shapes', [BODY_SHAPE, { ...BODY_SHAPE, ppi: 4 }]);
  run('insert:ungroup-shapes', [{ ...BODY_SHAPE, type: 'group' }]);
  assert.deepEqual(calls, ['group', 'ungroup']);
});

test('nested and non-body group addresses are rejected before body-only APIs', () => {
  const bodyA = { sec: 0, ppi: 0, ci: 0, type: 'shape' };
  const bodyB = { sec: 0, ppi: 1, ci: 0, type: 'image' };
  const cellPath = [{ controlIndex: 2, cellIndex: 0, cellParaIndex: 0 }];

  assert.equal(canGroupTopLevelBodyObjects([bodyA, bodyB]), true);
  assert.equal(canGroupTopLevelBodyObjects([bodyA, { ...bodyB, cellPath }]), false);
  assert.equal(canGroupTopLevelBodyObjects([bodyA, { ...bodyB, cellIdx: 0 }]), false);
  assert.equal(canGroupTopLevelBodyObjects([bodyA, { ...bodyB, cellParaIdx: 0 }]), false);
  assert.equal(canGroupTopLevelBodyObjects([bodyA, { ...bodyB, outerTableControlIdx: 0 }]), false);
  assert.equal(canGroupTopLevelBodyObjects([bodyA, { ...bodyB, headerFooter: { kind: 'header' } }]), false);
  assert.equal(canGroupTopLevelBodyObjects([bodyA, { ...bodyB, noteRef: { kind: 'footnote' } }]), false);
  assert.equal(canGroupTopLevelBodyObjects([bodyA, { ...bodyB, memoRef: { memoIndex: 0 } }]), false);
  assert.equal(canGroupTopLevelBodyObjects([bodyA, { ...bodyB, memoRef: 0 }]), false);
  assert.equal(canGroupTopLevelBodyObjects([bodyA, { ...bodyB, sec: 1 }]), false);

  assert.equal(canUngroupTopLevelBodyObject({ ...bodyA, type: 'group' }), true);
  assert.equal(canUngroupTopLevelBodyObject({ ...bodyA, type: 'group', cellPath }), false);
});

test('selection identity keeps the complete object address', () => {
  const body = { sec: 0, ppi: 0, ci: 0, type: 'line' };
  const nested = {
    ...body,
    cellPath: [{ controlIndex: 2, cellIndex: 0, cellParaIndex: 0 }],
  };
  assert.equal(sameAddressedObject(body, nested), false);
  assert.equal(sameAddressedObject(nested, { ...nested }), true);
});

// 남은 소스 가드: 클릭으로 앞으로 가져오기와 클릭 결과 변환은 마우스 이벤트·렌더 트리
// 히트 테스트를 거쳐야 해서 단위 테스트로 띄우지 않는다.
test('click-to-front and hit conversion keep nested object addresses', () => {
  const mouse = readFileSync(new URL('../src/engine/input-handler-mouse.ts', import.meta.url), 'utf8');
  const picture = readFileSync(new URL('../src/engine/input-handler-picture.ts', import.meta.url), 'utf8');
  const frontStart = mouse.indexOf('function bringShapeToFront');
  assert.match(mouse.slice(frontStart, mouse.indexOf('\n}\n', frontStart)), /isTopLevelBodyObject\(picHit\)/);
  const conversionStart = picture.indexOf('function controlToRef');
  const conversion = picture.slice(conversionStart, picture.indexOf('/** 클릭 좌표', conversionStart));
  for (const field of ['cellPath', 'headerFooter', 'noteRef', 'memoRef']) {
    assert.match(conversion, new RegExp(`ctrl\\.${field}`), `${field} survives line/shape hit conversion`);
  }
});
