import assert from 'node:assert/strict';
import test from 'node:test';

import { isDomDisplayableFlowImage } from '../src/view/flow-image-clip.ts';
import {
  MAX_PREFETCH_IMAGES_PER_PAGE,
  collectLayerImagePrefetch,
} from '../src/view/raw-svg-prefetch.ts';

// 첫 paint 에 없던 그림이 나중에라도 반드시 보이게 하는 두 판정:
// - DOM `<img>` 층이 그 그림을 그릴 수 있는가 (없으면 엔진 flow-static canvas 로 그린다)
// - 지연 재렌더를 디코드 뒤에 할지, fallback 을 기다릴지, 아예 필요 없는지

const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0WQAAAAASUVORK5CYII=';
const GIF_1X1 = 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
const JPEG_300X200 = Buffer.from([
  0xff, 0xd8,
  0xff, 0xe0, 0x00, 0x04, 0x00, 0x00,
  0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0xc8, 0x01, 0x2c, 0x01, 0x01,
  0xff, 0xd9,
]).toString('base64');
// placeable WMF 헤더 — 브라우저는 모르는 형식이고, 엔진은 SVG 로 바꿔 비동기로 그린다.
const WMF = Buffer.from([0xd7, 0xcd, 0xc6, 0x9a, 0, 0, 0, 0, 0, 0, 0x10, 0x27, 0x10, 0x27]).toString('base64');

function pngHeaderBase64(width: number, height: number): string {
  const png = new Uint8Array(24);
  png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  png.set([0x49, 0x48, 0x44, 0x52], 12);
  new DataView(png.buffer).setUint32(16, width, false);
  new DataView(png.buffer).setUint32(20, height, false);
  return Buffer.from(png).toString('base64');
}

/** paint/json.rs 와 같은 필드 순서(type, bbox, mime, base64)로 image op JSON 을 만든다. */
function imageOp(mime: string, base64: string): string {
  return `{"type":"image","bbox":{"x":10.000,"y":20.000,"width":30.000,"height":40.000},`
    + `"mime":"${mime}","base64":"${base64}","transform":{"rotation":0.0,"horzFlip":false,"vertFlip":false}}`;
}

/** getPageLayerTree 모양의 JSON 을 파싱한다 (group → leaf 중첩). */
function layerTree(...ops: string[]): unknown {
  return JSON.parse(
    '{"pageWidth":794.0,"pageHeight":1123.0,"profile":"screen","root":{"kind":"group","children":['
    + `{"kind":"leaf","bounds":{"x":0,"y":0,"width":794,"height":1123},"ops":[${ops.join(',')}]}]}}`,
  );
}

test('DOM 그림 층은 브라우저가 못 그리는 그림을 맡지 않는다', () => {
  assert.equal(isDomDisplayableFlowImage({ mime: 'image/png', base64: PNG_1X1 }), true);
  assert.equal(isDomDisplayableFlowImage({ mime: 'image/gif', base64: GIF_1X1 }), true);
  assert.equal(isDomDisplayableFlowImage({ mime: 'image/jpeg', base64: JPEG_300X200 }), true);
  // WMF 는 엔진 canvas 만 SVG 로 바꿔 그린다. `<img>` 로 띄우면 빈 칸이 된다.
  assert.equal(isDomDisplayableFlowImage({ mime: 'image/x-wmf', base64: WMF }), false);
  assert.equal(isDomDisplayableFlowImage({ mime: 'application/octet-stream', base64: PNG_1X1 }), false);
  // 600dpi 스캔처럼 디코드 한도를 넘는 raster.
  assert.equal(isDomDisplayableFlowImage({ mime: 'image/png', base64: pngHeaderBase64(20_000, 20_000) }), false);
  assert.equal(isDomDisplayableFlowImage({ mime: 'image/png', base64: pngHeaderBase64(6_800, 5_100) }), false);
});

test('그림 prefetch 는 실제 PageLayerTree 필드 순서(bbox 가 mime 앞)에서 비동기 그림을 찾는다', () => {
  const plan = collectLayerImagePrefetch(layerTree(imageOp('image/gif', GIF_1X1)));
  assert.deepEqual(plan, { kind: 'decoded', urls: [`data:image/gif;base64,${GIF_1X1}`] });
});

test('엔진이 동기로 그리는 그림만 있으면 재렌더가 필요 없다', () => {
  assert.deepEqual(
    collectLayerImagePrefetch(layerTree(imageOp('image/png', PNG_1X1), imageOp('image/jpeg', JPEG_300X200))),
    { kind: 'none' },
  );
  // 데이터 없는 외부 그림은 자리표시만 동기로 그린다.
  assert.deepEqual(
    collectLayerImagePrefetch(layerTree('{"type":"image","bbox":{"x":0,"y":0,"width":1,"height":1}}')),
    { kind: 'none' },
  );
});

test('미리 디코드할 수 없는 비동기 그림은 fallback 재렌더를 기다린다', () => {
  assert.deepEqual(collectLayerImagePrefetch(layerTree(imageOp('image/x-wmf', WMF))), { kind: 'wait' });
  // GIF 디코드만 기다렸다 다시 그리면 아직 로드 중인 WMF 가 빠진다.
  assert.deepEqual(
    collectLayerImagePrefetch(layerTree(imageOp('image/gif', GIF_1X1), imageOp('image/x-wmf', WMF))),
    { kind: 'wait' },
  );
  // 한도를 넘는 raster 는 엔진 동기 디코드가 실패해 비동기 경로로 떨어질 수 있다.
  assert.deepEqual(
    collectLayerImagePrefetch(layerTree(imageOp('image/png', pngHeaderBase64(20_000, 20_000)))),
    { kind: 'wait' },
  );
  const many = Array.from(
    { length: MAX_PREFETCH_IMAGES_PER_PAGE + 1 },
    (_, index) => imageOp('image/gif', GIF_1X1 + ' '.repeat(index)),
  );
  assert.deepEqual(collectLayerImagePrefetch(layerTree(...many)), { kind: 'wait' });
});

test('rawSvg 는 엔진과 같은 bbox 계약으로 감싼 SVG URL 을 미리 디코드한다', () => {
  const plan = collectLayerImagePrefetch({
    root: {
      kind: 'leaf',
      ops: [{
        type: 'rawSvg',
        bbox: { x: 12.5, y: 34.25, width: 56.75, height: 78.5 },
        svg: '<g class="hwp-ooxml-chart"><path d="M0 0"/></g>',
      }],
    },
  });
  assert.equal(plan.kind, 'decoded');
  assert.equal(plan.kind === 'decoded' && plan.urls.length, 1);
  const url = plan.kind === 'decoded' ? plan.urls[0] : '';
  assert.match(url, /^data:image\/svg\+xml;base64,/);
  assert.equal(
    Buffer.from(url.slice(url.indexOf(',') + 1), 'base64').toString('utf8'),
    '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" '
      + 'width="56.750" height="78.500" viewBox="12.500 34.250 56.750 78.500">\n'
      + '<g class="hwp-ooxml-chart"><path d="M0 0"/></g>\n</svg>',
  );
});

test('단일 <image> rawSvg 는 엔진처럼 감싸지 않고 그 data URL 을 쓴다', () => {
  const href = `data:image/gif;base64,${GIF_1X1}`;
  assert.deepEqual(
    collectLayerImagePrefetch({
      root: { kind: 'leaf', ops: [{
        type: 'rawSvg',
        bbox: { x: 0, y: 0, width: 1, height: 1 },
        svg: `<image x="0" y="0" width="1" height="1" xlink:href="${href}"/>`,
      }] },
    }),
    { kind: 'decoded', urls: [href] },
  );
  assert.deepEqual(
    collectLayerImagePrefetch({
      root: { kind: 'leaf', ops: [{
        type: 'rawSvg',
        bbox: { x: 0, y: 0, width: 1, height: 1 },
        svg: '<image href="data:image/png;base64,AA=="/>',
      }] },
    }),
    { kind: 'wait' },
    '크기를 알 수 없는 내장 raster 는 미리 디코드하지 않는다',
  );
});

test('큰 rawSvg 조각은 data URL 을 만들지 않고 조기/fallback 재렌더에 맡긴다', () => {
  assert.deepEqual(
    collectLayerImagePrefetch({
      root: { kind: 'leaf', ops: [{
        type: 'rawSvg',
        bbox: { x: 0, y: 0, width: 1, height: 1 },
        svg: 'x'.repeat(1_048_577),
      }] },
    }),
    { kind: 'wait' },
  );
});
