import test from 'node:test';
import assert from 'node:assert/strict';
import { decodePacket, decodeOutlines } from '../src/view/heemang-player.ts';
import { EngineNotSupportedError } from '../src/core/engine-support.ts';

function packet() {
  // HMPK/1: 한 사각형과 빈 LINE/GLYF 블록.
  const bytes = new Uint8Array(109);
  const v = new DataView(bytes.buffer);
  v.setUint32(0, 0x4b504d48, true);
  v.setUint16(4, 1, true);
  v.setInt32(24, 59528, true); v.setInt32(28, 84188, true);
  v.setUint32(32, 3, true);
  [['PANT', 72, 25], ['LINE', 97, 8], ['GLYF', 105, 4]].forEach(([tag, offset, length], i) => {
    bytes.set(new TextEncoder().encode(String(tag)), 36 + i * 12);
    v.setUint32(40 + i * 12, Number(offset), true);
    v.setUint32(44 + i * 12, Number(length), true);
  });
  v.setUint32(72, 1, true); bytes[76] = 2;
  [100, 200, 300, 400, 0xff].forEach((n, i) => v.setInt32(77 + i * 4, n, true));
  return bytes;
}

test('Heemang packet preserves HU geometry and COLORREF paint records', () => {
  const p = decodePacket(packet());
  assert.equal(p.width, 59528);
  assert.deepEqual(p.ops, [{ op: 'rect', x: 100, y: 200, w: 300, h: 400, color: 0xff }]);
  assert.deepEqual(p.lines, []);
});

test('Heemang packet rejects incompatible, truncated and overlapping transfers', () => {
  const bytes = packet();
  assert.throws(() => decodePacket(bytes.slice(0, 90)), /overruns/);
  bytes[4] = 2;
  assert.throws(() => decodePacket(bytes), /packet version/);
  bytes[4] = 1;
  new DataView(bytes.buffer).setUint32(40, 12, true);
  assert.throws(() => decodePacket(bytes), /overlaps/);
});

test('Heemang packet rejects unknown paint instructions and oversized counts', () => {
  const bytes = packet();
  bytes[76] = 99;
  assert.throws(() => decodePacket(bytes), /unknown paint op/);
  bytes[76] = 2;
  new DataView(bytes.buffer).setUint32(72, 0xffffffff, true);
  assert.throws(() => decodePacket(bytes), /overruns/);
  assert.throws(() => decodeOutlines(new Uint8Array([1, 0, 0, 0])), /overruns/);
});

test('unavailable engine operations have one machine-readable error', () => {
  const error = new EngineNotSupportedError('exportHwpx');
  assert.equal(error.code, 'ENGINE_NOT_SUPPORTED');
  assert.equal(error.operation, 'exportHwpx');
  assert.ok(error instanceof Error);
});
