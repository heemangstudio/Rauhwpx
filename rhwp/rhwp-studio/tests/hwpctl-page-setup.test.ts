import './support/wasm-liftoff.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { requireWasmPackage } from './browser-support.ts';
import { createTestModuleServer } from './support/module-server.ts';

// hwpctl PageSetup(SecDef) 의 머리말·꼬리말·제본 여백이 실제 엔진 쪽 정의에 들어가는지 본다.
// 한컴처럼 하위 셋 PageDef 에 담은 경우와 SecDef 에 바로 넣은 경우 모두 HWPUNIT 그대로다.
requireWasmPackage(fileURLToPath(new URL('../../pkg/', import.meta.url)));
const { initSync, HwpDocument } = await import('../../pkg/rhwp.js');
initSync({ module: readFileSync(new URL('../../pkg/rhwp_bg.wasm', import.meta.url)) });
const vite = await createTestModuleServer(fileURLToPath(new URL('../', import.meta.url)));
const { HwpCtrl } = await vite.ssrLoadModule('/src/hwpctl/index.ts') as typeof import('../src/hwpctl/index.ts');
test.after(() => vite.close());

test('PageSetup 은 한컴 PageDef 하위 셋의 HeaderLen/FooterLen/GutterLen/GutterType 을 반영한다', () => {
  const document = HwpDocument.createEmpty();
  const ctrl = new HwpCtrl(document);
  const action = ctrl.CreateAction('PageSetup');
  const set = action.CreateSet();
  const pageDef = set.CreateItemSet('PageDef', 'PageDef');
  pageDef.SetItem('TopMargin', 2835);
  pageDef.SetItem('HeaderLen', 1417);
  pageDef.SetItem('FooterLen', 1418);
  pageDef.SetItem('GutterLen', 567);
  pageDef.SetItem('GutterType', 1);
  assert.equal(action.Execute(set), true);
  const def = JSON.parse(document.getPageDef(0));
  assert.deepEqual(
    [def.marginTop, def.marginHeader, def.marginFooter, def.marginGutter, def.binding],
    [2835, 1417, 1418, 567, 1],
  );
});

test('PageSetup 은 SecDef 에 바로 넣은 HeaderMargin/FooterMargin 도 반영한다', () => {
  const document = HwpDocument.createEmpty();
  const ctrl = new HwpCtrl(document);
  const action = ctrl.CreateAction('PageSetup');
  const set = action.CreateSet();
  set.SetItem('HeaderMargin', 2000);
  set.SetItem('FooterMargin', 2100);
  assert.equal(action.Execute(set), true);
  const def = JSON.parse(document.getPageDef(0));
  assert.deepEqual([def.marginHeader, def.marginFooter], [2000, 2100]);
});
