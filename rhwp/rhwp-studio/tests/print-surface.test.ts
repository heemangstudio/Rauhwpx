import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PrintSurfaceClosedError,
  resolvePrintSurfaceUrl,
  waitForPrintSurfaceReady,
  type PrintDocumentSurface,
} from '../src/command/print-surface.ts';

/** 닫힌 창처럼 rAF 콜백과 fonts.ready 가 영영 오지 않는 인쇄 surface. */
function frozenSurface() {
  const state = { closed: false, layoutReads: 0 };
  const surface = {
    window: {
      get closed() { return state.closed; },
      requestAnimationFrame() { return 0; },
    },
    document: {
      fonts: { ready: new Promise(() => {}) },
      documentElement: {
        getBoundingClientRect() {
          state.layoutReads += 1;
          return {};
        },
      },
    },
  } as unknown as PrintDocumentSurface;
  return { surface, state };
}

test('준비 중에 미리보기 창을 닫으면 대기가 PrintSurfaceClosedError로 끝난다', { timeout: 5_000 }, async () => {
  const { surface, state } = frozenSurface();
  const started = Date.now();
  const waiting = waitForPrintSurfaceReady(surface, { fontTimeoutMs: 60_000, frameTimeoutMs: 60_000 });
  setTimeout(() => { state.closed = true; }, 20);
  await assert.rejects(waiting, PrintSurfaceClosedError);
  assert.ok(Date.now() - started < 1_000, '닫힌 창을 기다리며 인쇄 작업을 붙잡으면 안 된다');
  assert.equal(state.layoutReads, 0);
});

test('열린 창에서 rAF가 멈춰도 제한 시간 뒤 인쇄 준비를 마친다', { timeout: 5_000 }, async () => {
  const { surface, state } = frozenSurface();
  await waitForPrintSurfaceReady(surface, { fontTimeoutMs: 20, frameTimeoutMs: 20 });
  assert.equal(state.layoutReads, 1);
});

test('이미 닫힌 창은 곧바로 취소로 끝난다', async () => {
  const { surface, state } = frozenSurface();
  state.closed = true;
  await assert.rejects(waitForPrintSurfaceReady(surface), PrintSurfaceClosedError);
});

test('print surface URL은 Studio와 같은 origin의 전용 문서로 해석된다', () => {
  assert.equal(
    resolvePrintSurfaceUrl('https://studio.example.test/app/index.html'),
    'https://studio.example.test/app/print.html',
  );
  assert.equal(
    resolvePrintSurfaceUrl('chrome-extension://abcdefghijklmnop/index.html'),
    'chrome-extension://abcdefghijklmnop/print.html',
  );
});

test('print surface URL은 about:blank를 사용하지 않는다', () => {
  const url = resolvePrintSurfaceUrl('https://studio.example.test/');
  assert.equal(url.startsWith('about:'), false);
  assert.equal(new URL(url).origin, 'https://studio.example.test');
});
