import test from 'node:test';
import assert from 'node:assert/strict';
import { openHeemangAgent, rhwpFile } from './heemang-agent-env.ts';

test('Studio HWPX export packages previews while native saving keeps source bytes and history', async t => {
  const path = 'rhwp-studio/tests/fixtures/heemang-clipboard.hwpx';
  const { wasm, adapter } = await openHeemangAgent(t, path);
  const source = new Uint8Array(rhwpFile(path));
  const before = adapter.state();
  const originalText = wasm.getTextRange(0, 0, 0, 100000);
  const output = wasm.exportHwpx();
  assert.notDeepEqual(output, source);
  assert.deepEqual(adapter.serialize(false), source);
  assert.deepEqual(adapter.state(), before);
  assert.deepEqual(wasm.exportHwpx(), output);
  const reopened = adapter.hmEngine().open(output);
  try {
    const paras = JSON.parse(reopened.query(JSON.stringify({ kind: 'paragraphs', list: { section: 0 } })));
    assert.equal(paras[0].text, originalText);
    assert.deepEqual(reopened.exportHwpx(), output);
  } finally { reopened.close(); reopened.free(); }
  wasm.insertText(0, 0, 0, '출력😀');
  const edited = adapter.state();
  wasm.exportHwpx();
  assert.deepEqual(adapter.state(), edited);
  assert.equal(adapter.state().dirty, true);
});
