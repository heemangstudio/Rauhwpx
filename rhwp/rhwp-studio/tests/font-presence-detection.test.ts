import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createDeclaredFontAvailabilityProbe,
  isFontFamilyAvailable,
  filterAvailableFontFamilies,
} from '../src/core/font-presence.ts';

/**
 * 캔버스 글립 폭 프로브를 가짜 컨텍스트로 검증한다.
 * `installed` 에 든 서체만 generic fallback 과 다른 폭을 돌려준다.
 */
function makeProbeContext(installed: readonly string[]) {
  const installedSet = new Set(installed);
  const state = { font: '' };
  return {
    get font() {
      return state.font;
    },
    set font(value: string) {
      state.font = value;
    },
    measureText(text: string) {
      // `72px "이름", monospace` 형태에서 첫 서체명을 뽑는다.
      const match = state.font.match(/^\d+px "([^"]+)"/);
      const family = match?.[1];
      const base = 10 * text.length;
      if (family && installedSet.has(family)) {
        return { width: base + 7 };
      }
      return { width: base };
    },
  } as unknown as Pick<CanvasRenderingContext2D, 'font' | 'measureText'>;
}

test('설치된 서체만 사용 가능으로 판정한다', () => {
  const ctx = makeProbeContext(['Apple SD Gothic Neo', 'AppleMyungjo']);

  assert.equal(isFontFamilyAvailable('Apple SD Gothic Neo', ctx), true);
  assert.equal(isFontFamilyAvailable('AppleMyungjo', ctx), true);
  // Windows 전용 서체는 macOS 프로필에서 미설치로 잡혀야 한다.
  assert.equal(isFontFamilyAvailable('맑은 고딕', ctx), false);
  assert.equal(isFontFamilyAvailable('바탕', ctx), false);
  assert.equal(isFontFamilyAvailable('굴림체', ctx), false);
});

test('존재할 수 없는 서체를 설치됨으로 오검출하지 않는다', () => {
  // document.fonts.check() 회귀 방지: 그 API 는 아래 이름들에도 true 를 준다.
  const ctx = makeProbeContext(['Apple SD Gothic Neo']);
  assert.equal(isFontFamilyAvailable('ZZZ_NoSuchFont_12345', ctx), false);
  assert.equal(isFontFamilyAvailable('AbsolutelyNotInstalled_QQQ', ctx), false);
  assert.equal(isFontFamilyAvailable('', ctx), false);
});

test('프로브 컨텍스트가 없으면 미설치로 간주한다', () => {
  const previousDocument = (globalThis as typeof globalThis & { document?: unknown }).document;
  Object.defineProperty(globalThis, 'document', { configurable: true, value: undefined });
  try {
    assert.equal(isFontFamilyAvailable('맑은 고딕'), false);
    assert.deepEqual(filterAvailableFontFamilies(['맑은 고딕', '바탕']), []);
  } finally {
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: previousDocument,
    });
  }
});

test('페인트용 Canvas 치환 뒤에도 원본 face 의 설치 여부를 판정한다', () => {
  const ctx = makeProbeContext(['Apple SD Gothic Neo']);
  const original = Object.getOwnPropertyDescriptor(ctx, 'font')!;
  Object.defineProperty(ctx, 'font', {
    get: original.get,
    set(value: string) {
      // 페인트 경로는 미설치 선언 face 에 실제 설치된 fallback 을 붙인다.
      original.set!.call(ctx, value.includes('"') ? '72px "Apple SD Gothic Neo", serif' : value);
    },
  });
  const available = createDeclaredFontAvailabilityProbe(
    ctx,
    { get: original.get!, set: original.set! },
    family => family === 'Imported Face',
  );

  assert.equal(isFontFamilyAvailable('Missing Face', ctx), true);
  assert.equal(available('Missing Face'), false);
  assert.equal(available('Apple SD Gothic Neo'), true);
  assert.equal(available('Imported Face'), true);
});

test('대체 웹폰트 CSS 별칭은 원본 face의 설치 여부를 바꾸지 않는다', () => {
  const ctx = makeProbeContext(['Installed Face']);
  const original = Object.getOwnPropertyDescriptor(ctx, 'font')!;
  let webSubstituteLoaded = false;
  let actualFaceImported = false;
  const measure = ctx.measureText.bind(ctx);
  ctx.measureText = text => webSubstituteLoaded && ctx.font.includes('"Missing Face"')
    ? { width: 10 * text.length + 7 } as TextMetrics
    : measure(text);
  const available = createDeclaredFontAvailabilityProbe(
    ctx,
    { get: original.get!, set: original.set! },
    family => actualFaceImported && family === 'Missing Face',
    ['Missing Face', 'Installed Face'],
  );

  webSubstituteLoaded = true;
  assert.equal(isFontFamilyAvailable('Missing Face', ctx), true);
  assert.equal(available('Missing Face'), false);
  assert.equal(available('Installed Face'), true);
  actualFaceImported = true;
  assert.equal(available('Missing Face'), true);
});
