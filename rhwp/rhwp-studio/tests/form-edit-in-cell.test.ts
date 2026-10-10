import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

import { createTestModuleServer } from './support/module-server.ts';

// [Task #2374 후속] 셀 안 양식 개체는 hit 의 para 가 표를 담은 최상위 문단이고 ci 는 셀 문단
// 안의 컨트롤 인덱스다. 값 쓰기와 undo 기록이 모두 셀 locator 를 써야 값이 저장되고
// Ctrl+Z 가 같은 슬롯을 되돌린다.
const vite = await createTestModuleServer(fileURLToPath(new URL('../', import.meta.url)));
const { InputHandler } = await vite.ssrLoadModule('/src/engine/input-handler.ts') as typeof import('../src/engine/input-handler.ts');
test.after(() => vite.close());

const cellHit = {
  found: true, sec: 0, para: 4, ci: 1, inCell: true,
  tablePara: 4, tableCi: 0, cellIdx: 2, cellPara: 1,
  bbox: { x: 0, y: 0, w: 100, h: 20 },
};

function handler() {
  const writes: unknown[][] = [];
  const records: Array<{ undo(wasm: unknown): unknown }> = [];
  const wasm = {
    setFormValue: (...args: unknown[]) => { writes.push(['flat', ...args]); },
    setFormValueInCell: (...args: unknown[]) => { writes.push(['cell', ...args]); },
  };
  const ih = Object.assign(Object.create(InputHandler.prototype), {
    wasm,
    cursor: { getPosition: () => ({ sectionIndex: 0, paragraphIndex: 0, charOffset: 0 }) },
    container: { querySelector: () => null, appendChild() {} },
    viewportManager: { getZoom: () => 1 },
    virtualScroll: { getPageOffset: () => 0, getPageLeftResolved: () => 0 },
    formOverlay: null,
    executeOperation(desc: { kind: string; command: { undo(wasm: unknown): unknown } }) {
      assert.equal(desc.kind, 'record');
      records.push(desc.command);
    },
    afterEdit() {},
  });
  return { ih, wasm, writes, records };
}

test('셀 안 체크박스 토글은 셀 locator 로 쓰고 undo 도 같은 슬롯을 되돌린다', () => {
  const { ih, wasm, writes, records } = handler();
  ih.handleFormObjectClick({ ...cellHit, formType: 'CheckBox', value: 0 }, 0, 1);
  assert.deepEqual(writes, [['cell', 0, 4, 0, 2, 1, 1, '{"value":1}']]);
  records[0]!.undo(wasm);
  assert.deepEqual(writes[1], ['cell', 0, 4, 0, 2, 1, 1, '{"value":0}']);
});

test('셀 안 Edit 필드 커밋은 셀 locator 로 쓰고 undo 도 같은 슬롯을 되돌린다', () => {
  const g = globalThis as Record<string, unknown>;
  const saved = { document: g.document, requestAnimationFrame: g.requestAnimationFrame };
  const listeners: Record<string, (event: unknown) => void> = {};
  const input = {
    value: '', style: {} as Record<string, string>,
    addEventListener(type: string, listener: (event: unknown) => void) { listeners[type] = listener; },
    remove() {}, focus() {}, select() {},
  };
  g.document = { createElement: () => input };
  g.requestAnimationFrame = () => 0;
  try {
    const { ih, wasm, writes, records } = handler();
    ih.handleFormObjectClick({ ...cellHit, formType: 'Edit', text: '이전' }, 0, 1);
    input.value = '새 값';
    listeners['keydown']!({ key: 'Enter', preventDefault() {} });
    listeners['blur']!({});
    assert.deepEqual(writes, [['cell', 0, 4, 0, 2, 1, 1, '{"text":"새 값"}']]);
    assert.equal(records.length, 1, 'Enter 뒤 blur 가 와도 한 번만 기록한다');
    records[0]!.undo(wasm);
    assert.deepEqual(writes[1], ['cell', 0, 4, 0, 2, 1, 1, '{"text":"이전"}']);
  } finally {
    g.document = saved.document;
    g.requestAnimationFrame = saved.requestAnimationFrame;
  }
});
