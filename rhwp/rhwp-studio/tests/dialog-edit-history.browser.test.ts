/**
 * 문서를 고치는 대화상자는 확인 한 번이 편집 이력 한 칸이어야 한다.
 *
 * 실제 WASM 엔진과 실제 편집 라우터(InputHandler.executeOperation)·handleUndo/handleRedo
 * 위에서 대화상자를 실제 명령으로 열고, 사용자가 하듯 값을 바꿔 확인한다. 그 뒤 undo 한 번이
 * 편집 전 문서를, redo 한 번이 편집 후 문서를 정확히 되살리는지 쪽 SVG 전부와 HWPX 바이트로
 * 비교한다. 대화상자가 엔진을 직접 고치거나 진입점이 services 를 빠뜨려 직접 적용 경로로
 * 떨어지면 undo 가 문서를 되돌리지 못해 실패한다.
 *
 * 시나리오 본문은 tests/support/dialog-history-scenarios.ts (브라우저 쪽) 에 있다.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import puppeteer, { type Browser, type Page } from 'puppeteer-core';
import { createServer, type ViteDevServer } from 'vite';
import { browserExecutable, browserLaunchArgs, requireWasmPackage } from './browser-support.ts';
import type { StepResult, scenarios as Scenarios } from './support/dialog-history-scenarios.ts';

const studioRoot = fileURLToPath(new URL('../', import.meta.url));
const rhwpRoot = resolve(studioRoot, '..');
const wasmPackageRoot = process.env.RHWP_WASM_PACKAGE_DIR ?? resolve(rhwpRoot, 'pkg');
requireWasmPackage(wasmPackageRoot);
const headerPictureSample = readFileSync(resolve(rhwpRoot, 'samples/hwp3-sample11.hwp'));

let server: ViteDevServer;
let browser: Browser;
let page: Page;

before(async () => {
  server = await createServer({
    root: studioRoot,
    configFile: false,
    cacheDir: resolve(studioRoot, 'node_modules/.vite-dialog-edit-history-test'),
    logLevel: 'silent',
    // 파일 명령이 불러오는 PWA 등록 모듈은 앱 플러그인이 만든다. 여기서는 빈 모듈로 둔다.
    plugins: [{
      name: 'stub-pwa-register',
      resolveId: (id: string) => (id === 'virtual:pwa-register' ? '\0virtual:pwa-register' : null),
      load: (id: string) => (id === '\0virtual:pwa-register' ? 'export function registerSW() {}' : null),
    }],
    resolve: {
      alias: {
        '@': resolve(studioRoot, 'src'),
        '@wasm/rhwp.js': resolve(wasmPackageRoot, 'rhwp.js'),
        '@wasm': wasmPackageRoot,
      },
    },
    server: { host: '127.0.0.1', port: 0, hmr: false, fs: { allow: [studioRoot, wasmPackageRoot] } },
  });
  await server.listen();
  const address = server.httpServer?.address();
  assert.ok(address && typeof address !== 'string');
  browser = await puppeteer.launch({ executablePath: browserExecutable(), headless: true, args: browserLaunchArgs() });
  page = await browser.newPage();
  page.on('pageerror', (error) => console.error('[page]', error));
  await page.goto(`http://127.0.0.1:${address.port}/tests/fixtures/version-store-idb.html`);
  await page.evaluate(async () => {
    const { scenarios } = await import('/tests/support/dialog-history-scenarios.ts');
    await scenarios.init();
    (window as unknown as { scenarios: typeof scenarios }).scenarios = scenarios;
  });
}, { timeout: 120_000 });

after(async () => {
  await browser?.close();
  await server?.close();
});

type ScenarioName = keyof typeof Scenarios;

/** 페이지 안의 시나리오를 실행하고 결과를 받는다. */
function scenario<K extends ScenarioName>(
  name: K,
  ...args: Parameters<(typeof Scenarios)[K]>
): Promise<Awaited<ReturnType<(typeof Scenarios)[K]>>> {
  return page.evaluate(
    (n, a) => (window as any).scenarios[n](...a),
    name,
    args as unknown[],
  ) as never;
}

/** 확인 한 번이 이력 한 칸: 문서가 바뀌고, undo 한 번이 전으로, redo 한 번이 후로 되살린다. */
function assertOneUndoStep(result: StepResult, label: string): void {
  assert.notEqual(result.after, result.before, `${label}: 확인이 문서를 바꾸지 않았다`);
  assert.equal(result.entries, 1, `${label}: 이력 항목이 하나여야 한다`);
  assert.equal(result.undone, result.before, `${label}: undo 한 번이 편집 전 문서를 되살리지 못했다`);
  assert.equal(result.redone, result.after, `${label}: redo 한 번이 편집 후 문서를 되살리지 못했다`);
}

function assertNothingRecorded(result: { before: string; after: string; entries: number }, label: string): void {
  assert.equal(result.after, result.before, `${label}: 문서가 바뀌면 안 된다`);
  assert.equal(result.entries, 0, `${label}: 이력에 아무것도 남기면 안 된다`);
}

const opts = { timeout: 60_000 };

test('수식 속성 대화상자 확인은 두 진입점 모두 undo 한 번으로 되돌아간다', opts, async (t) => {
  for (const entry of ['insert:picture-props', 'format:object-properties']) {
    await t.test(entry, async () => assertOneUndoStep(await scenario('equationProps', entry), entry));
  }
});

test('찾아 바꾸기의 바꾸기와 모두 바꾸기는 각각 undo 한 번으로 되돌아간다', opts, async () => {
  const result = await scenario('findReplace');
  const count = (text: string, word: string) => text.split(word).length - 1;
  assert.deepEqual([count(result.text[0], '포도'), count(result.text[0], '사과')], [1, 2], '바꾸기는 찾은 하나만 바꾼다');
  assert.equal(result.text[1], '포도 배 포도 감 포도');
  assertOneUndoStep(result.replace, '바꾸기');
  assertOneUndoStep(result.replaceAll, '모두 바꾸기');
});

test('찾기 대화상자는 undo 뒤 옛 결과를 버리고, 닫으면 구독을 푼다', opts, async () => {
  const result = await scenario('findHistoryJump');
  assert.deepEqual(result.selectionAfterPrev, { start: 0, end: 1 }, '이전 찾기는 undo 뒤 커서 위치에서 거꾸로 찾는다');
  assert.equal(result.listeners.shown, result.listeners.beforeShow + 1, '열면 history-jumped 를 구독한다');
  assert.equal(result.listeners.hidden, result.listeners.beforeShow, '닫으면 구독을 푼다');
});

test('계산식 대화상자는 쉼표 결과를 한 번에 쓰고, 틀린 식은 기록하지 않는다', opts, async () => {
  const result = await scenario('formula');
  assert.equal(result.written, '6,912', '쉼표 결과가 원시 결과와 겹치면 안 된다');
  assert.equal(result.undoneText, '', 'undo 는 계산과 쉼표 기록을 함께 되돌린다');
  assertOneUndoStep(result.commit, '계산식');
  assertNothingRecorded(result.invalid, '틀린 계산식');
  assert.equal(result.invalid.stillOpen, true, '틀린 식이면 대화상자가 열린 채 남는다');
});

test('그림/도형 속성 대화상자 확인은 대상마다 undo 한 번으로 되돌아간다', opts, async (t) => {
  const cases = [
    ['body-picture', 'insert:picture-props'],
    ['body-picture', 'format:object-properties'],
    ['body-shape', 'insert:picture-props'],
    ['body-shape', 'format:object-properties'],
    ['cell-picture', 'insert:picture-props'],
  ] as const;
  for (const [target, entry] of cases) {
    const label = `${target} via ${entry}`;
    await t.test(label, async () => assertOneUndoStep(await scenario('pictureProps', target, entry), label));
  }
});

test('머리말 그림 속성 대화상자 확인도 undo 한 번으로 되돌아간다', { timeout: 120_000 }, async () => {
  const result = await page.evaluate(
    (b64) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      return (window as any).scenarios.headerPictureProps(bytes);
    },
    headerPictureSample.toString('base64'),
  );
  assert.equal(result.found, true, '샘플 머리말에 그림이 있어야 한다');
  assertOneUndoStep(result, '머리말 그림');
});

test('그림 속성 대화상자를 바꾼 것 없이 확인하면 기록하지 않는다', opts, async () => {
  assertNothingRecorded(await scenario('picturePropsNoChange'), '변경 없는 확인');
});

test('그림 넣기는 배치 모드와 끌어 놓기 모두 undo 한 번으로 되돌아간다', opts, async (t) => {
  for (const kind of ['placement', 'drop'] as const) {
    await t.test(kind, async () => {
      const result = await scenario('pictureInsert', kind);
      assert.equal(result.ok, true, `${kind}: 그림이 들어가야 한다`);
      assertOneUndoStep(result, kind);
    });
  }
});

test('스타일 삭제는 undo 한 번으로 되돌아가고, 열린 대화상자가 undo/redo 를 따라온다', opts, async () => {
  const result = await scenario('styleDelete');
  assertOneUndoStep(result.step, '스타일 삭제');
  assert.deepEqual(result.afterUndo, { label: result.styleName, listed: true }, 'undo 뒤 현재 스타일과 목록이 돌아온다');
  assert.deepEqual(result.afterRedo, { label: result.baseName, listed: false }, 'redo 뒤 현재 스타일과 목록이 다시 바뀐다');
  assert.equal(result.listeners.shown, result.listeners.beforeShow + 1, '열면 history-jumped 를 구독한다');
  assert.equal(result.listeners.hidden, result.listeners.beforeShow, '닫으면 구독을 푼다');
});

test('스타일 추가와 편집은 글자 모양까지 undo 한 번으로 되돌아가고, 실패는 기록하지 않는다', opts, async (t) => {
  await t.test('추가', async () => assertOneUndoStep(await scenario('styleSave', 'add'), '스타일 추가'));
  await t.test('편집', async () => assertOneUndoStep(await scenario('styleSave', 'edit'), '스타일 편집'));
  await t.test('실패', async () => {
    const failure = await scenario('styleCreateFailure');
    assertNothingRecorded(failure, '스타일 추가 실패');
    assert.equal(failure.stillOpen, true, '실패하면 대화상자가 열린 채 남는다');
  });
});

test('표/셀 속성과 셀 테두리/배경 대화상자 확인은 진입점마다 undo 한 번으로 되돌아간다', opts, async (t) => {
  for (const entry of ['cell-props-table', 'cell-props-cell', 'object-properties', 'border-each', 'border-one'] as const) {
    await t.test(entry, async () => assertOneUndoStep(await scenario('tableDialog', entry), entry));
  }
});

test('책갈피 넣기·이름 바꾸기·지우기는 각각 undo 한 번으로 되돌아간다', opts, async () => {
  const result = await scenario('bookmarks');
  assert.deepEqual(result.names, [['표지'], ['목차'], []]);
  assertOneUndoStep(result.add, '책갈피 넣기');
  assertOneUndoStep(result.rename, '책갈피 이름 바꾸기');
  assertOneUndoStep(result.remove, '책갈피 지우기');
});

test('쪽·구역·번호 대화상자 확인은 각각 undo 한 번으로 되돌아간다', opts, async (t) => {
  for (const entry of [
    'page:setup', 'file:page-setup', 'page:page-border', 'page:col-settings',
    'page:section-settings', 'page:new-page-num', 'insert:endnote-shape',
  ] as const) {
    await t.test(entry, async () => assertOneUndoStep(await scenario('layoutDialog', entry), entry));
  }
});

test('양식 모드에서는 편집 용지 두 진입점이 모두 막힌다', opts, async () => {
  const result = await scenario('formModePageSetup');
  for (const id of ['file:page-setup', 'page:setup']) {
    assert.deepEqual(result[id], { dispatched: false, opened: false }, id);
  }
});

test('수식 편집기로 넣은 수식은 undo 한 번으로 빠진다', opts, async () => {
  const result = await scenario('equationInsert');
  assert.equal(result.equations, 1, '수식이 하나 들어가야 한다');
  assertOneUndoStep(result, '수식 넣기');
});

test('검토 대기 에이전트 편집이 있으면 저장은 쓰기 전에 수락·거절·취소를 묻는다', opts, async (t) => {
  const cases = [
    ['cancel', ['dialog']],
    ['discard', ['dialog', 'rejectAll', 'pick', 'write', 'close']],
    ['approve', ['dialog', 'approveAll', 'pick', 'write', 'close']],
    ['approve-fails', ['dialog', 'approveAll']],
  ] as const;
  for (const [choice, expected] of cases) {
    await t.test(choice, async () => assert.deepEqual(await scenario('saveGate', choice), expected));
  }
});
