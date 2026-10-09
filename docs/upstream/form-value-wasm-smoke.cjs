// 실제 생성 WASM API의 양식 값 → 저장 → 재열기와 실패/복원을 검사한다. DOM/시각 비교 없음.
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join, resolve } = require('node:path');

assert.ok(process.argv[2], '사용법: node form-value-wasm-smoke.cjs <nodejs WASM package>');
const { HwpDocument } = require(join(resolve(process.argv[2]), 'rhwp.js'));
const sample = readFileSync(join(__dirname, '../../rhwp/samples/form-01.hwp'));
const targets = [[0, 2, 'caption'], [2, 0, 'caption'], [4, 0, 'text'], [6, 0, 'caption'], [8, 0, 'text']];
let reopenedValues = 0;
for (const value of ['plain', '한글🦦', 'A"B', 'C:\\tmp', 'tail\\', 'A\nB\tC', '']) {
  const doc = new HwpDocument(sample);
  const snapshot = doc.saveSnapshot();
  const before = doc.getFormValue(0, 8, 0);
  for (const [para, ci, key] of targets) {
    assert.equal(JSON.parse(doc.setFormValue(0, para, ci, JSON.stringify({ [key]: value, value: 0 }))).ok, true);
    assert.equal(JSON.parse(doc.getFormValue(0, para, ci))[key], value);
  }
  for (const output of [doc.exportHwp(), doc.exportHwpx()]) {
    const reopened = new HwpDocument(output);
    for (const [para, ci, key] of targets) {
      assert.equal(JSON.parse(reopened.getFormValue(0, para, ci))[key], value);
      reopenedValues++;
    }
    reopened.free();
  }
  const edited = doc.getFormValue(0, 8, 0);
  for (const malformed of ['{"value":1,"text":"unfinished}', '{"value":1} trailing', 'null']) {
    assert.throws(() => doc.setFormValue(0, 8, 0, malformed));
    assert.equal(doc.getFormValue(0, 8, 0), edited);
  }
  doc.restoreSnapshot(snapshot);
  assert.equal(doc.getFormValue(0, 8, 0), before);
  doc.free();
}
console.log(JSON.stringify({ runtime: 'fresh nodejs WASM public API', reopenedValues, malformedInputs: 21, restoredSnapshots: 7, result: 'passed' }));
