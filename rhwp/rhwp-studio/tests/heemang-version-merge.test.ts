import test from 'node:test';
import assert from 'node:assert/strict';
import { openHeemangAgent, FIXTURES } from './heemang-agent-env.ts';

test('HWP 병합 검증은 실제 내보내기를 다시 열고 편집 상태를 유지한다', async t => {
  const { wasm, adapter } = await openHeemangAgent(t, FIXTURES.blankHwp);
  wasm.insertText(0, 0, 0, '검증 한글😀');
  const epoch = adapter.state().contentEpoch;
  const before = adapter.getParagraphText(0, 0);
  const report = JSON.parse(wasm.exportHwpVerify());
  assert.equal(report.recovered, true);
  assert.equal(report.structureMatches, true);
  assert.deepEqual(report.serializationLosses, []);
  assert.equal(adapter.state().contentEpoch, epoch);
  assert.equal(adapter.state().dirty, true);
  assert.equal(adapter.getParagraphText(0, 0), before);
});
