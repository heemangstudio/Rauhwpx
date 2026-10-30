import test from 'node:test';
import assert from 'node:assert/strict';
import { FIXTURES, openHeemangAgent } from './heemang-agent-env.ts';

test('그림 지정은 틀을 유지하고 스냅샷으로 원래 이미지를 복원한다', async t => {
  const { wasm } = await openHeemangAgent(t, FIXTURES.blankHwpx);
  const png = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a5kAAAAASUVORK5CYII=', 'base64'));
  const gif = new Uint8Array(Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'));
  const inserted = wasm.insertPicture(0, 0, 0, '', png, 4000, 3000, 1, 1, 'png', '유지할 틀');
  const read = () => wasm.getControlImageData(0, inserted.paraIdx, inserted.controlIdx, '');
  const frame = wasm.getPictureProperties(0, inserted.paraIdx, inserted.controlIdx);
  const beforeSnapshot = wasm.saveSnapshot();
  const result = wasm.assignPictureImage(0, inserted.paraIdx, '', inserted.controlIdx, gif, 1, 1, 'gif');
  assert.equal(result.ok, true);
  assert.ok(result.binDataId > 0);
  assert.deepEqual(read(), gif);
  const after = wasm.getPictureProperties(0, inserted.paraIdx, inserted.controlIdx);
  assert.equal(after.width, frame.width);
  assert.equal(after.height, frame.height);
  const afterSnapshot = wasm.saveSnapshot();
  wasm.restoreSnapshot(beforeSnapshot);
  assert.deepEqual(read(), png);
  wasm.restoreSnapshot(afterSnapshot);
  assert.deepEqual(read(), gif);
  wasm.discardSnapshot(beforeSnapshot);
  wasm.discardSnapshot(afterSnapshot);
});
