/**
 * HeemangEngine 위 에이전트 도구 통합 테스트 환경 — 실제 hm-wasm 문서 → 에이전트 도구 엔진
 * (core/hm) → PendingEditManager → AgentToolExecutor.
 *
 * HM_WASM_PKG 에 hm-wasm 빌드 폴더(hm_wasm.js·hm_wasm_bg.wasm)를 주면 번들(vendor/hm-wasm)
 * 대신 그것을 쓴다 — 번들이 아직 갖추지 않은 엔진 API 를 시험할 때.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { transformSync } from 'rolldown/utils';
import { pathToFileURL } from 'node:url';
import type test from 'node:test';

const pkg = process.env.HM_WASM_PKG ? pathToFileURL(`${process.env.HM_WASM_PKG.replace(/\/$/, '')}/`) : new URL('../vendor/hm-wasm/', import.meta.url);

registerHooks({
  resolve(specifier, context, next) {
    if (specifier.endsWith('/vendor/hm-wasm/hm_wasm')) return next(new URL('hm_wasm.js', pkg).href, context);
    if (specifier.endsWith('blank.hwpx?url')) return { url: `data:text/javascript,export default ${JSON.stringify(new URL('../src/core/hm/blank.hwpx', import.meta.url).href)}`, shortCircuit: true };
    return next(specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier) ? `${specifier}.ts` : specifier, context);
  },
  load(url, context, next) {
    if (new URL(url).pathname.endsWith('.ts')) {
      return { format: 'module', shortCircuit: true, source: transformSync(new URL(url).pathname,
        readFileSync(new URL(url), 'utf8').replaceAll('import.meta.env', '({DEV:false})'), { lang: 'ts' }).code };
    }
    return next(url, context);
  },
});

const wasmModule = await import(new URL('hm_wasm.js', pkg).href) as { initSync(o: { module: Uint8Array }): unknown };
wasmModule.initSync({ module: readFileSync(new URL('hm_wasm_bg.wasm', pkg)) });

const { WasmBridge } = await import('../src/core/wasm-bridge.ts');
const { provideEngineFont } = await import('../src/core/engine-support.ts');
const { CommandHistory } = await import('../src/engine/history.ts');
const { HeadlessEditorHost } = await import('../src/engine/headless-editor-host.ts');
const { EventBus } = await import('../src/core/event-bus.ts');
const { RevisionTracker } = await import('../src/agent/revision.ts');
const { PendingEditManager } = await import('../src/agent/pending-edits.ts');
const { AgentToolExecutor } = await import('../src/agent/tool-executor.ts');

const fontDir = new URL('../../ttfs/opensource/', import.meta.url);
let fontsRegistered = false;

/** rhwp/ 아래 경로의 파일 */
export function rhwpFile(path: string): Uint8Array {
  return readFileSync(new URL(`../../${path}`, import.meta.url));
}

export const FIXTURES = {
  /** 본문 몇 문단과 셀 하나 (한컴 저장) */
  cellMixed: 'tests/fixtures/editing_parity/mac-hancom-12.30.0/cell-mixed-text/source.hwpx',
  bodyMixed: 'tests/fixtures/editing_parity/mac-hancom-12.30.0/body-mixed-text/edited.hwpx',
  blankHwpx: 'samples/hwpx/blank_hwpx.hwpx',
  blankHwp: 'template/blank-batang.hwp',
} as const;

export async function openHeemangAgent(t: test.TestContext, path: string = FIXTURES.cellMixed) {
  const wasm = new WasmBridge();
  const adapter = wasm.viewer;
  await adapter.initialize();
  if (!fontsRegistered) {
    for (const name of readdirSync(fontDir)) {
      if (/\.(ttf|otf|ttc)$/i.test(name)) provideEngineFont(name, readFileSync(new URL(name, fontDir)));
    }
    fontsRegistered = true;
  }
  wasm.loadDocument(rhwpFile(path), path.split('/').pop());
  // 테스트는 웹 글꼴을 받지 않는다 — 등록한 글꼴로 바로 조판한다.
  (adapter as unknown as { fontsPrepared: boolean }).fontsPrepared = true;
  adapter.refreshLayout();
  t.after(() => adapter.releaseDocument());
  const bus = new EventBus();
  const revision = new RevisionTracker(bus, { documentInstance: () => adapter.documentInstance });
  const history = new CommandHistory();
  const editor = new HeadlessEditorHost({ wasm, eventBus: bus, state: { history, cursor: null } });
  t.after(() => editor.dispose());
  const pending = new PendingEditManager({
    wasm,
    eventBus: bus,
    editor: editor as never,
    overlay: { setOps: () => {}, clear: () => {} } as never,
  });
  const executor = new AgentToolExecutor({
    wasm,
    editor: editor as never,
    documentState: { isDirty: () => adapter.state().dirty } as never,
    revision,
    pending,
  });
  const call = (tool: string, args: Record<string, unknown> = {}) =>
    executor.execute(tool, { expectedRevision: revision.revision, ...args }, 'claude') as Promise<Record<string, unknown>>;
  /** 읽기 도구 — expectedRevision 을 붙이지 않는다. */
  const read = (tool: string, args: Record<string, unknown> = {}) =>
    executor.execute(tool, args, 'claude') as Promise<Record<string, unknown>>;
  const text = (para: number, section = 0) => adapter.getParagraphText(section, para);
  /** 이 엔진 빌드가 글자 offset 표(ParagraphInfo.offsets)를 주는가 — 없으면 좌표 도구가 거절된다. */
  const modern = Array.isArray(adapter.paragraphs(0, [], 0, 1)[0]?.offsets);
  return { adapter, wasm, bus, revision, pending, executor, history, call, read, text, modern };
}
