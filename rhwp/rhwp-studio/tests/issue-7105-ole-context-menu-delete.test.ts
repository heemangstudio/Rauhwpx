import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

import { createTestModuleServer } from './support/module-server.ts';

// [#7105] 코어에서 OLE 는 `Control::Shape(Ole)` 다. 그림 삭제(`deletePictureControl`)는
// `Control::Picture` 만 받으므로 메뉴 "지우기"와 키보드 Delete 모두 OLE 를 도형 삭제로 보내야 한다.
// 레거시 수식 OLE 의 편집은 선택한 슬롯을 undo 가능한 snapshot 편집으로 native 수식으로 바꾼다.
const vite = await createTestModuleServer(fileURLToPath(new URL('../', import.meta.url)));
const { insertCommands } = await vite.ssrLoadModule('/src/command/commands/insert.ts') as typeof import('../src/command/commands/insert.ts');
const { deleteObjectControl } = await vite.ssrLoadModule('/src/engine/input-handler-picture.ts') as typeof import('../src/engine/input-handler-picture.ts');
test.after(() => vite.close());

const oleRef = { sec: 0, ppi: 3, ci: 1, type: 'ole' as const };

function recordingWasm(calls: string[]) {
  return new Proxy({}, {
    get: (_target, name) => (...args: unknown[]) => {
      calls.push(`${String(name)}(${args.join(',')})`);
      return name === 'promoteOleEquation' ? { ok: false } : undefined;
    },
  });
}

function runCommand(id: string, ref: Record<string, unknown>) {
  const calls: string[] = [];
  const operations: string[] = [];
  const wasm = recordingWasm(calls);
  const ih = {
    getSelectedPictureRef: () => ref,
    getCursorPosition: () => ({ sectionIndex: 0, paragraphIndex: 0, charOffset: 0 }),
    executeOperation(desc: { kind: string; operationType: string; operation(w: unknown): unknown }) {
      operations.push(`${desc.kind}:${desc.operationType}`);
      desc.operation(wasm);
    },
    exitPictureObjectSelectionAndAfterEdit() {},
  };
  const command = insertCommands.find((c) => c.id === id)!;
  let error: unknown = null;
  try {
    command.execute({ wasm, eventBus: { emit() {} }, getInputHandler: () => ih } as never);
  } catch (e) {
    error = e;
  }
  return { calls, operations, error };
}

test('메뉴 "지우기"와 키보드 Delete 는 OLE 개체를 같은 도형 삭제로 보낸다', () => {
  const menu = runCommand('insert:picture-delete', oleRef);
  assert.deepEqual(menu.operations, ['snapshot:deleteObject']);
  assert.deepEqual(menu.calls, ['deleteShapeControl(0,3,1)']);

  const keyboard: string[] = [];
  assert.equal(deleteObjectControl.call({ wasm: recordingWasm(keyboard) }, oleRef as never), true);
  assert.deepEqual(keyboard, menu.calls);
});

test('레거시 수식 OLE 편집은 선택한 슬롯을 undo 가능한 snapshot 편집으로 전환한다', () => {
  // 전환 실패를 돌려주면 대화상자를 열기 전에 멈춘다.
  const body = runCommand('insert:equation-edit', oleRef);
  assert.deepEqual(body.operations, ['snapshot:promoteOleEquation']);
  assert.deepEqual(body.calls, ['promoteOleEquation(0,3,1)']);
  assert.ok(body.error instanceof Error);

  // 셀·머리말 안 OLE 는 본문 전용 전환 API 로 보내지 않는다.
  const inCell = runCommand('insert:equation-edit', { ...oleRef, cellPath: [{ controlIndex: 0, cellIndex: 0, cellParaIndex: 0 }] });
  assert.deepEqual(inCell.operations, []);
  assert.deepEqual(inCell.calls, []);
});
