import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

import { sfntMetricsSubset } from '../src/core/sfnt-subset.ts';

const pkg = new URL('../../pkg/', import.meta.url);
const fixture = (name: string): ArrayBuffer => {
  const bytes = readFileSync(new URL(`../../tests/fixtures/fonts/${name}`, import.meta.url));
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
};

test('실제 WASM: 메트릭 표만 남긴 SFNT는 원본과 같은 런타임 메트릭으로 등록된다', async (t) => {
  if (!existsSync(new URL('rhwp_bg.wasm', pkg))) {
    t.skip('rhwp/pkg 의 WASM 빌드가 필요하다 (wasm-pack build --target web)');
    return;
  }
  const rhwp = await import(new URL('rhwp.js', pkg).href);
  rhwp.initSync({ module: readFileSync(new URL('rhwp_bg.wasm', pkg)) });
  const register = (bytes: Uint8Array, aliases: string[], bold: boolean, italic: boolean): string => {
    rhwp.clearRuntimeFontMetrics();
    const result = String(rhwp.registerRuntimeFontMetrics(bytes, JSON.stringify(aliases), bold, italic));
    return result + String(rhwp.getRuntimeFontMetricsReport());
  };
  try {
    // 컬렉션은 별칭·굵기·기울임으로 face를 고르므로 name·OS/2·post가 face마다 남아야 한다.
    for (const name of ['RHWPShapingFixture.ttf', 'HYhwpEQSourceFixture.ttf', 'RHWPExactFaceSmoke.ttc']) {
      const source = fixture(name);
      const subset = sfntMetricsSubset(source);
      assert.ok(subset.byteLength < source.byteLength, name);
      for (const [aliases, bold, italic] of [
        [['Fixture'], false, false],
        [['RHWP Exact Face Smoke Bold'], true, false],
        [['RHWP Exact Face Smoke'], false, true],
      ] as const) {
        assert.equal(register(subset, [...aliases], bold, italic), register(new Uint8Array(source), [...aliases], bold, italic), name);
      }
    }
  } finally {
    rhwp.clearRuntimeFontMetrics();
  }
});

test('표 디렉터리를 믿을 수 없는 입력은 원본을 그대로 넘긴다', () => {
  const source = fixture('RHWPShapingFixture.ttf');
  const view = new DataView(source);
  // 첫 표의 길이를 파일 밖으로 늘린다.
  view.setUint32(12 + 12, source.byteLength);
  assert.deepEqual(sfntMetricsSubset(source), new Uint8Array(source));
  assert.deepEqual(sfntMetricsSubset(new ArrayBuffer(4)), new Uint8Array(4));
});
