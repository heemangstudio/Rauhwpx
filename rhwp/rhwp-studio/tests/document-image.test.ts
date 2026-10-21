import assert from 'node:assert/strict';
import test from 'node:test';

import {
  documentImageReencodeReason,
  jpegExifOrientation,
  prepareDocumentImage,
} from '../src/core/document-image.ts';
import type { ImageCropRequest } from '../src/agent/image-crop.ts';

function png(bitDepth: number): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  bytes.set([0, 0, 1, 0, 0, 0, 0, 200, bitDepth, 2], 16);
  return bytes;
}

function segment(marker: number, payload: number[]): number[] {
  const length = payload.length + 2;
  return [0xff, marker, length >> 8, length & 0xff, ...payload];
}

function exifPayload(orientation: number, littleEndian: boolean): number[] {
  const u16 = (v: number) => (littleEndian ? [v & 0xff, v >> 8] : [v >> 8, v & 0xff]);
  const u32 = (v: number) => (littleEndian
    ? [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, v >>> 24]
    : [v >>> 24, (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff]);
  const tiff = [
    ...(littleEndian ? [0x49, 0x49] : [0x4d, 0x4d]), ...u16(42), ...u32(8),
    ...u16(2),
    // ImageWidth first so the parser has to walk past an unrelated entry.
    ...u16(0x0100), ...u16(3), ...u32(1), ...u16(640), 0, 0,
    ...u16(0x0112), ...u16(3), ...u32(1), ...u16(orientation), 0, 0,
    ...u32(0),
  ];
  return [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff];
}

function jpeg(orientation?: number, littleEndian = false): Uint8Array {
  const parts = [0xff, 0xd8];
  parts.push(...segment(0xe0, [0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]));
  if (orientation !== undefined) parts.push(...segment(0xe1, exifPayload(orientation, littleEndian)));
  parts.push(...segment(0xdb, new Array(65).fill(1)));
  parts.push(...segment(0xda, [1, 1, 0, 0, 0x3f, 0]), 0x12, 0x34, 0xff, 0xd9);
  return new Uint8Array(parts);
}

const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20]);

test('rotated phone photos are detected in either byte order', () => {
  assert.equal(jpegExifOrientation(jpeg(6)), 6);
  assert.equal(jpegExifOrientation(jpeg(8, true)), 8);
  assert.equal(jpegExifOrientation(jpeg()), 1);
  assert.equal(documentImageReencodeReason(jpeg(6)), 'orientation');
  assert.equal(documentImageReencodeReason(jpeg(3, true)), 'orientation');
});

test('images Hancom draws as stored keep their original bytes', () => {
  assert.equal(documentImageReencodeReason(jpeg()), null);
  assert.equal(documentImageReencodeReason(jpeg(1)), null);
  assert.equal(documentImageReencodeReason(png(8)), null);
  assert.equal(documentImageReencodeReason(png(1)), null);
  // 한컴 2022 는 16비트 PNG 도 바르게 그린다 (실측).
  assert.equal(documentImageReencodeReason(png(16)), null);
  assert.equal(documentImageReencodeReason(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])), null);
  assert.equal(documentImageReencodeReason(new Uint8Array([0x42, 0x4d, 0, 0, 0, 0])), null);
});

test('WebP and unrecognized bytes need re-encoding', () => {
  assert.equal(documentImageReencodeReason(webp), 'format');
  assert.equal(documentImageReencodeReason(new Uint8Array([0, 0, 0, 0x1c, 0x66, 0x74, 0x79, 0x70])), 'format');
});

test('truncated or malformed JPEG metadata never throws', () => {
  const full = jpeg(6);
  for (let end = 0; end < full.length; end++) {
    assert.doesNotThrow(() => documentImageReencodeReason(full.subarray(0, end)));
  }
  const badLength = jpeg(6);
  badLength[4] = 0xff;
  badLength[5] = 0xff;
  assert.doesNotThrow(() => jpegExifOrientation(badLength));
});

function fakeReencoder(calls: ImageCropRequest[]) {
  return async (request: ImageCropRequest) => {
    calls.push(request);
    return {
      bytes: new Uint8Array([request.output === 'image/jpeg' ? 0xd8 : 0x50]),
      mimeType: request.output,
      widthPx: 1,
      heightPx: 1,
      crop: { x: 0, y: 0, width: 1, height: 1 },
      scale: 1,
    };
  };
}

test('prepareDocumentImage re-encodes only images Hancom cannot draw as stored', async () => {
  const calls: ImageCropRequest[] = [];
  const reencode = fakeReencoder(calls);

  const plain = png(8);
  const kept = await prepareDocumentImage(plain, 'png', 'image/png', reencode);
  assert.equal(kept.bytes, plain);
  assert.equal(kept.extension, 'png');
  assert.equal(kept.reencoded, null);
  assert.equal(calls.length, 0);

  const photo = await prepareDocumentImage(jpeg(6), 'JPG', 'image/jpeg', reencode);
  assert.deepEqual([photo.extension, photo.reencoded], ['jpg', 'orientation']);
  assert.deepEqual([calls[0].mimeType, calls[0].output, calls[0].cropPx], ['image/jpeg', 'image/jpeg', undefined]);

  const fromWebp = await prepareDocumentImage(webp, 'webp', 'image/webp', reencode);
  assert.deepEqual([fromWebp.extension, fromWebp.reencoded], ['png', 'format']);
  assert.deepEqual([calls[1].mimeType, calls[1].output], ['image/webp', 'image/png']);

  await prepareDocumentImage(new Uint8Array([0, 1, 2, 3]), 'avif', '', reencode);
  assert.equal(calls[2].mimeType, 'image/avif');
});
