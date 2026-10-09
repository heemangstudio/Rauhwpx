import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MAX_IMAGE_DECODE_DIMENSION,
  MAX_IMAGE_DECODE_PIXELS,
  assertBase64EncodedImageDecodeDimensions,
  assertEncodedImageDecodeDimensions,
  assertImageDecodeDimensions,
  encodedImageDimensions,
} from '../src/view/canvaskit/image-header.ts';

function pngHeader(width: number, height: number): Uint8Array {
  const png = new Uint8Array(24);
  png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  png.set([0x49, 0x48, 0x44, 0x52], 12);
  new DataView(png.buffer).setUint32(16, width, false);
  new DataView(png.buffer).setUint32(20, height, false);
  return png;
}

test('encodedImageDimensions reads bounded PNG, GIF, WebP, BMP, and JPEG headers', () => {
  const png = new Uint8Array(24);
  png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  png.set([0x49, 0x48, 0x44, 0x52], 12);
  new DataView(png.buffer).setUint32(16, 320, false);
  new DataView(png.buffer).setUint32(20, 240, false);

  const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x40, 0x01, 0xf0, 0x00]);
  const webp = new Uint8Array(30);
  webp.set(new TextEncoder().encode('RIFF'), 0);
  webp.set(new TextEncoder().encode('WEBPVP8X'), 8);
  webp.set([0x3f, 0x01, 0x00, 0xef, 0x00, 0x00], 24);
  const bmp = new Uint8Array(26);
  bmp.set([0x42, 0x4d], 0);
  new DataView(bmp.buffer).setInt32(18, 640, true);
  new DataView(bmp.buffer).setInt32(22, -480, true);
  const jpeg = new Uint8Array([
    0xff, 0xd8,
    0xff, 0xe0, 0x00, 0x04, 0x00, 0x00,
    0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0xc8, 0x01, 0x2c, 0x01, 0x01,
    0xff, 0xd9,
  ]);

  assert.deepEqual(encodedImageDimensions(png), { width: 320, height: 240 });
  assert.deepEqual(encodedImageDimensions(gif), { width: 320, height: 240 });
  assert.deepEqual(encodedImageDimensions(webp), { width: 320, height: 240 });
  assert.deepEqual(encodedImageDimensions(bmp), { width: 640, height: 480 });
  assert.deepEqual(encodedImageDimensions(jpeg), { width: 300, height: 200 });
});

test('encodedImageDimensions rejects malformed and zero-sized headers', () => {
  assert.equal(encodedImageDimensions(new Uint8Array([0xff, 0xd8, 0xff, 0xc0])), null);
  const png = new Uint8Array(24);
  png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  png.set([0x49, 0x48, 0x44, 0x52], 12);
  assert.equal(encodedImageDimensions(png), null);
});

test('decode guard rejects a tiny PNG header that declares bomb-sized dimensions', () => {
  const bomb = pngHeader(0xffff_ffff, 0xffff_ffff);
  assert.deepEqual(encodedImageDimensions(bomb), {
    width: 0xffff_ffff,
    height: 0xffff_ffff,
  });
  assert.throws(
    () => assertEncodedImageDecodeDimensions(bomb, '테스트 그림'),
    /안전 한도/,
  );
  assert.throws(
    () => assertBase64EncodedImageDecodeDimensions(Buffer.from(bomb).toString('base64')),
    /안전 한도/,
  );
});

test('decode guard enforces both per-axis and aggregate pixel limits', () => {
  assert.deepEqual(
    assertImageDecodeDimensions(MAX_IMAGE_DECODE_DIMENSION, 1),
    { width: MAX_IMAGE_DECODE_DIMENSION, height: 1 },
  );
  assert.throws(
    () => assertImageDecodeDimensions(MAX_IMAGE_DECODE_DIMENSION + 1, 1),
    /안전 한도/,
  );
  const width = 8192;
  const height = Math.floor(MAX_IMAGE_DECODE_PIXELS / width) + 1;
  assert.throws(() => assertImageDecodeDimensions(width, height), /안전 한도/);

  const safe = pngHeader(320, 240);
  assert.deepEqual(
    assertBase64EncodedImageDecodeDimensions(Buffer.from(safe).toString('base64')),
    { width: 320, height: 240 },
  );
});

test('decode guard preserves bounded SVG images without treating viewBox units as pixels', () => {
  const generatedWmfSvg = new TextEncoder().encode(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200000 100000"><path d="M0 0"/></svg>',
  );
  assert.deepEqual(encodedImageDimensions(generatedWmfSvg), { width: 300, height: 150 });
  assert.deepEqual(
    encodedImageDimensions(new TextEncoder().encode('<svg width="10cm" height="20mm"></svg>')),
    { width: 378, height: 76 },
  );
  assert.throws(
    () => assertEncodedImageDecodeDimensions(
      new TextEncoder().encode('<svg width="20000" height="20000"></svg>'),
    ),
    /안전 한도/,
  );
  assert.deepEqual(
    assertBase64EncodedImageDecodeDimensions(Buffer.from(generatedWmfSvg).toString('base64')),
    { width: 300, height: 150 },
  );
});

/** APPn 메타데이터 segment 들 뒤에 SOF0 가 오는 JPEG. */
function jpegWithMetadata(metadataBytes: number, width: number, height: number): Uint8Array {
  const bytes: number[] = [0xff, 0xd8];
  let remaining = metadataBytes;
  while (remaining > 0) {
    const payload = Math.min(remaining, 0xfff0);
    const length = payload + 2;
    bytes.push(0xff, 0xe1, length >> 8, length & 0xff);
    for (let i = 0; i < payload; i += 1) bytes.push(0x41);
    remaining -= payload;
  }
  bytes.push(0xff, 0xc0, 0x00, 0x0b, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x01, 0x01);
  bytes.push(0xff, 0xd9);
  return Uint8Array.from(bytes);
}

test('decode guard reads JPEG sizes behind long metadata past the first header slice', () => {
  // 크기 marker 가 첫 조각(96KB) 밖에 있어도 4MB 한도 안이면 끝까지 따라가 읽는다.
  const jpeg = jpegWithMetadata(300 * 1024, 640, 480);
  assert.deepEqual(
    assertBase64EncodedImageDecodeDimensions(Buffer.from(jpeg).toString('base64')),
    { width: 640, height: 480 },
  );
  const oversized = jpegWithMetadata(200 * 1024, 16_000, 16_000);
  assert.throws(
    () => assertBase64EncodedImageDecodeDimensions(Buffer.from(oversized).toString('base64')),
    /안전 한도/,
  );
});

test('decode guard reads a large image from its first header slice only', () => {
  // 큰 그림마다 수 MB prefix 를 풀면 쪽 렌더·prefetch 판정마다 그림 수만큼 비용이 붙는다.
  const png = new Uint8Array(3 * 1024 * 1024);
  png.set(pngHeader(4000, 3000), 0);
  const base64 = Buffer.from(png).toString('base64');
  const realAtob = globalThis.atob;
  const decodedChars: number[] = [];
  globalThis.atob = (data: string) => {
    decodedChars.push(data.length);
    return realAtob(data);
  };
  try {
    assert.deepEqual(assertBase64EncodedImageDecodeDimensions(base64), { width: 4000, height: 3000 });
  } finally {
    globalThis.atob = realAtob;
  }
  assert.equal(decodedChars.length, 1);
  assert.ok(decodedChars[0] <= 128 * 1024 + 4, `first slice decoded ${decodedChars[0]} chars`);
});
