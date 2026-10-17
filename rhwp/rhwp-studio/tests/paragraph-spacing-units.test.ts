import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks, stripTypeScriptTypes } from 'node:module';
import { readFileSync } from 'node:fs';
import { makeEnv } from './agent-test-env.ts';

// DOM 없이 실제 대화상자의 표시/변경 수집 경로를 실행한다.
registerHooks({ resolve(specifier, context, next) {
  return next(specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier) ? `${specifier}.ts` : specifier, context);
}, load(url, context, next) {
  // 생성자는 실행하지 않는다. Node strip-only가 지원하지 않는 생성자 parameter property만 제거한다.
  if (url.endsWith('/para-shape-dialog.ts')) return { format: 'module', source: stripTypeScriptTypes(readFileSync(new URL(url), 'utf8').replace(/private (wasm|eventBus):/g, '$1:')), shortCircuit: true };
  return next(url, context);
} });
const { ParaShapeDialog } = await import('../src/ui/para-shape-dialog.ts');
function dialog(beforePx = 6.7, afterPx = 4) {
  const input = () => ({ value: '', checked: false });
  const d: any = Object.create(ParaShapeDialog.prototype);
  Object.assign(d, {
    initialProps: { alignment: 'justify', spacingBefore: beforePx, spacingAfter: afterPx, patternType: -1 },
    updatePreview() {}, alignBtns: {}, firstLineRadios: ['normal', 'indent', 'hanging'].map(value => ({ value, checked: false })),
    headTypeRadios: [{ value: 'None', checked: true }], tabState: {},
    tabResult: { tabAutoLeftCb: input(), tabAutoRightCb: input(), defaultTabLabel: {}, renderTabList() {}, renderDeletedTabList() {} },
    borderStates: {}, bdSideToggles: {}, borderResult: { bdSpacingInputs: Array.from({ length: 4 }, input), updateBdPreview() {} },
  });
  for (const key of ['marginLeftInput', 'marginRightInput', 'indentInput', 'lineSpacingTypeSelect', 'lineSpacingInput',
    'spacingBeforeInput', 'spacingAfterInput', 'paraLevelSelect', 'widowOrphanCb', 'keepWithNextCb', 'keepLinesCb',
    'pageBreakBeforeCb', 'fontLineHeightCb', 'singleLineCb', 'autoSpaceKrEnCb', 'autoSpaceKrNumCb',
    'verticalAlignSelect', 'koreanBreakSelect', 'englishBreakSelect']) d[key] = input();
  d.lineSpacingUnitLabel = {};
  for (const key of ['bgFillSelect', 'bgFillPicker', 'bgPatColorInput', 'bgPatShapeSelect', 'bdConnectCb',
    'bdIgnoreMarginCb', 'bdTypeSelect', 'bdWidthSelect', 'bdColorInput']) d.borderResult[key] = input();
  d.props = d.initialProps;
  d.populateFromProps();
  return d;
}
test('대화상자는 물리 5pt/3pt를 표시하고 정렬만 바꾸면 원본 간격을 보존한다', () => {
  const d = dialog();
  assert.equal(d.spacingBeforeInput.value, '5.0');
  assert.equal(d.spacingAfterInput.value, '3.0');
  d.spacingBeforeInput.value = '5.00';
  assert.deepEqual(d.collectMods(), {});
  d.getSelectedAlignment = () => 'center';
  assert.deepEqual(d.collectMods(), { alignment: 'center' });
});
test('대화상자에서 5pt/3pt로 고친 간격은 raw 1000/600으로 전송한다', () => {
  const d = dialog(0, 0);
  d.spacingBeforeInput.value = '5'; d.spacingAfterInput.value = '3';
  assert.deepEqual(d.collectMods(), { spacingBefore: 1000, spacingAfter: 600 });
  d.spacingBeforeInput.value = '0';
  assert.deepEqual(d.collectMods(), { spacingAfter: 600 });
});
test('도구 쓰기/읽기는 물리 pt를 사용하고 정렬만 바꾸면 간격을 보내지 않는다', async () => {
  const h = makeEnv(['본문'], wasm => {
    wasm.getParaPropertiesAt = () => ({ paraShapeId: 10, alignment: 'left', spacingBefore: 6.7, spacingAfter: 4 });
  });
  await h.call('apply_para_format', { paraIdx: 0, spaceBeforePt: 5, spaceAfterPt: 3 });
  assert.deepEqual(JSON.parse(String(h.calls.find(c => c.m === 'applyParaFormat')!.a[1])), { spacingBefore: 1000, spacingAfter: 600 });
  const read: any = await h.call('get_para_format', { sectionIdx: 0, paraIdx: 0 });
  assert.equal(read.spaceBeforePt, 5); assert.equal(read.spaceAfterPt, 3);
  h.calls.length = 0;
  await h.call('apply_para_format', { paraIdx: 0, alignment: 'center' });
  assert.deepEqual(JSON.parse(String(h.calls.find(c => c.m === 'applyParaFormat')!.a[1])), { alignment: 'center' });
});
