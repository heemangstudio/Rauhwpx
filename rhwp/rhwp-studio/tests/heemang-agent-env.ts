/**
 * HeemangEngine 위 에이전트 도구 통합 테스트 환경 — 실제 hm-wasm 문서 → 에이전트 도구 엔진
 * (agent/heemang) → PendingEditManager → AgentToolExecutor.
 *
 * HM_WASM_PKG 에 hm-wasm 빌드 폴더(hm_wasm.js·hm_wasm_bg.wasm)를 주면 번들(vendor/hm-wasm)
 * 대신 그것을 쓴다 — 번들이 아직 갖추지 않은 엔진 API 를 시험할 때.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { registerHooks, stripTypeScriptTypes } from 'node:module';
import { pathToFileURL } from 'node:url';
import type test from 'node:test';

const pkg = process.env.HM_WASM_PKG ? pathToFileURL(`${process.env.HM_WASM_PKG.replace(/\/$/, '')}/`) : new URL('../vendor/hm-wasm/', import.meta.url);

registerHooks({
  resolve(specifier, context, next) {
    if (specifier.endsWith('/vendor/hm-wasm/hm_wasm')) return next(new URL('hm_wasm.js', pkg).href, context);
    return next(specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier) ? `${specifier}.ts` : specifier, context);
  },
  load(url, context, next) {
    if (new URL(url).pathname.endsWith('/core/heemang-adapter.ts')) {
      return { format: 'module', shortCircuit: true, source: stripTypeScriptTypes(
        readFileSync(new URL(url), 'utf8').replaceAll('import.meta.env', '({DEV:false})')) };
    }
    return next(url, context);
  },
});

const wasmModule = await import(new URL('hm_wasm.js', pkg).href) as { initSync(o: { module: Uint8Array }): unknown };
wasmModule.initSync({ module: readFileSync(new URL('hm_wasm_bg.wasm', pkg)) });

const { HeemangAdapter } = await import('../src/core/heemang-adapter.ts');
const { provideEngineFont } = await import('../src/core/engine-support.ts');
const { agentEngineFor } = await import('../src/agent/heemang/index.ts');
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
  bodyMixed: 'tests/fixtures/editing_parity/mac-hancom-12.30.0/body-mixed-text/source.hwpx',
  blankHwpx: 'samples/hwpx/blank_hwpx.hwpx',
  blankHwp: 'template/blank-batang.hwp',
} as const;

export async function openHeemangAgent(t: test.TestContext, path: string = FIXTURES.cellMixed) {
  const adapter = new HeemangAdapter();
  await adapter.initialize();
  if (!fontsRegistered) {
    for (const name of readdirSync(fontDir)) {
      if (/\.(ttf|otf|ttc)$/i.test(name)) provideEngineFont(name, readFileSync(new URL(name, fontDir)));
    }
    fontsRegistered = true;
  }
  adapter.loadDocument(rhwpFile(path), path.split('/').pop());
  // 테스트는 웹 글꼴을 받지 않는다 — 등록한 글꼴로 바로 조판한다.
  (adapter as unknown as { fontsPrepared: boolean }).fontsPrepared = true;
  adapter.refreshLayout();
  t.after(() => adapter.releaseDocument());
  const host = new Proxy(adapter, { get: (target, key) => (key === 'viewer' ? target : Reflect.get(target, key)) });
  const wasm = agentEngineFor(host as never);
  const bus = new EventBus();
  const revision = new RevisionTracker(bus, { documentInstance: () => adapter.documentInstance });
  const editor = {
    executeOperation: () => { throw new Error('HeemangEngine 대기 편집은 편집기 이력에 명령을 남기지 않는다'); },
    getCursorPosition: () => ({ sectionIndex: 0, paragraphIndex: 0, charOffset: 0 }),
    getSelection: () => null,
  };
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
  return { adapter, wasm, bus, revision, pending, executor, call, read, text };
}
