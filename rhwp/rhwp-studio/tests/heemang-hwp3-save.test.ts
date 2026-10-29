import test from 'node:test';
import assert from 'node:assert/strict';
import { openHeemangAgent, rhwpFile } from './heemang-agent-env.ts';

test('HWP3 edits and adopted HWP3 content save to modern formats without marking unwritten output clean', async t => {
  const { wasm, adapter } = await openHeemangAgent(t, 'rhwp-studio/tests/fixtures/hwp3-tabs.hwp');
  assert.equal(adapter.readOnly, false);
  const before = wasm.getTextRange(0, 0, 0, 100000);
  wasm.insertText(0, 0, 0, '저장😀');
  assert.equal(wasm.getTextRange(0, 0, 0, 100000), `저장😀${before}`);
  assert.equal(adapter.state().dirty, true);
  const epoch = adapter.state().contentEpoch;
  for (const format of ['hwp', 'hwpx'] as const) {
    const bytes = format === 'hwp' ? wasm.exportHwp() : wasm.exportHwpx();
    assert.deepEqual([...bytes.slice(0, 2)], format === 'hwp' ? [0xd0, 0xcf] : [0x50, 0x4b]);
    assert.equal(adapter.state().dirty, true);
    assert.equal(adapter.state().contentEpoch, epoch);
    const probe = adapter.hmEngine().open(bytes);
    try {
      const paras = JSON.parse(probe.query(JSON.stringify({ kind: 'paragraphs', list: { section: 0 } })));
      assert.equal(paras[0].text, `저장😀${before}`);
    } finally { probe.close(); probe.free(); }
  }
  // 파일 쓰기가 끝나기 전에는 직렬화만 해도 dirty 를 유지한다.
  adapter.serialize(false);
  assert.equal(adapter.state().dirty, true);
  assert.equal(adapter.markSaved(), true);
  assert.equal(adapter.state().dirty, false);
  wasm.replaceContentFromBytes(rhwpFile('rhwp-studio/tests/fixtures/hwp3-tabs.hwp'));
  assert.equal(adapter.readOnly, false);
  wasm.insertText(0, 0, 0, '다시');
  assert.ok(wasm.getTextRange(0, 0, 0, 100000).startsWith('다시'));
});
