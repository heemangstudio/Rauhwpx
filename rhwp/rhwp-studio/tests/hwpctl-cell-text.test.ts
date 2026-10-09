import './support/wasm-liftoff.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { requireWasmPackage } from './browser-support.ts';
import { createTestModuleServer } from './support/module-server.ts';

// hwpctl 표 셀 텍스트 API(SetCellText / GetCellText)를 실제 엔진 문서로 왕복한다.
// SetCellText 는 Set 의미라 같은 셀에 두 번 써도 누적되지 않고(#2344 계열),
// GetCellText 는 엔진의 인덱스 기반 셀 텍스트 API 로 실제 내용을 돌려준다.
requireWasmPackage(fileURLToPath(new URL('../../pkg/', import.meta.url)));
const { initSync, HwpDocument } = await import('../../pkg/rhwp.js');
initSync({ module: readFileSync(new URL('../../pkg/rhwp_bg.wasm', import.meta.url)) });
const vite = await createTestModuleServer(fileURLToPath(new URL('../', import.meta.url)));
const { HwpCtrl } = await vite.ssrLoadModule('/src/hwpctl/index.ts') as typeof import('../src/hwpctl/index.ts');
test.after(() => vite.close());

test('SetCellText 는 기존 셀 텍스트를 덮어쓰고 GetCellText 가 그 값을 읽는다', () => {
  const document = HwpDocument.createEmpty();
  const table = JSON.parse(document.createTableEx(JSON.stringify({
    sectionIdx: 0, paraIdx: 0, charOffset: 0, rowCount: 2, colCount: 2,
  })));
  const ctrl = new HwpCtrl(document);
  assert.equal(ctrl.SetCellText(table.paraIdx, 0, 1, '10', 2, table.controlIdx), true);
  assert.equal(ctrl.SetCellText(table.paraIdx, 0, 1, '20', 2, table.controlIdx), true);
  assert.equal(ctrl.GetCellText(table.paraIdx, 0, 1, 2, table.controlIdx), '20');
  assert.equal(ctrl.GetCellText(table.paraIdx, 1, 0, 2, table.controlIdx), '');
});
