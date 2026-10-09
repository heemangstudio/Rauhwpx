/**
 * 실제 WASM 엔진 위에서 편집 이력(undo/redo)을 검증하는 Node 테스트 환경.
 *
 * Vite 모듈 로더로 실제 WasmBridge·명령 클래스·CommandHistory·InputHandler 프로토타입을
 * 불러온다. InputHandler 는 DOM 없이 만들 수 없으므로 프로토타입을 그대로 쓰는 호스트를
 * 만들고, 캐럿 그리기 같은 화면 갱신만 비워 둔다. 편집 라우터(executeOperation)와
 * handleUndo/handleRedo 는 실제 코드가 돈다.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, type ViteDevServer } from 'vite';

const studioRoot = fileURLToPath(new URL('../../', import.meta.url));
const wasmPackageRoot = resolve(studioRoot, '../pkg');

export interface EditEngine {
  vite: ViteDevServer;
  load: (path: string) => Promise<any>;
  /** src/engine/command.ts 모듈 */
  command: any;
  CommandHistory: any;
  EventBus: any;
  /** 빈 새 문서를 연 WasmBridge */
  newDocument(): any;
  /** 바이트로 문서를 연 WasmBridge */
  openDocument(bytes: Uint8Array, fileName: string): any;
  /** 실제 InputHandler 프로토타입 위에 화면 갱신만 비운 편집 호스트 */
  createHost(wasm: any): any;
  close(): Promise<void>;
}

function quietly<T>(run: () => T): T {
  const log = console.log;
  console.log = () => {};
  try {
    return run();
  } finally {
    console.log = log;
  }
}

export async function startEditEngine(): Promise<EditEngine> {
  const vite = await createServer({
    root: studioRoot,
    configFile: false,
    appType: 'custom',
    logLevel: 'silent',
    resolve: {
      alias: {
        '@': resolve(studioRoot, 'src'),
        '@wasm/rhwp.js': resolve(wasmPackageRoot, 'rhwp.js'),
        '@wasm': wasmPackageRoot,
      },
    },
    server: { middlewareMode: true, hmr: false },
  });
  const load = (path: string) => vite.ssrLoadModule(path);
  const engine = await load('@wasm/rhwp.js');
  engine.initSync({ module: readFileSync(resolve(wasmPackageRoot, 'rhwp_bg.wasm')) });
  const [
    { WasmBridge }, command, { CommandHistory }, { InputHandler }, { CursorState }, { EventBus }, { ImeSession },
  ] = await Promise.all([
    load('/src/core/wasm-bridge.ts'),
    load('/src/engine/command.ts'),
    load('/src/engine/history.ts'),
    load('/src/engine/input-handler.ts'),
    load('/src/engine/cursor.ts'),
    load('/src/core/event-bus.ts'),
    load('/src/engine/ime-session.ts'),
  ]);

  function bridge(): any {
    const wasm = new WasmBridge();
    // initialize() 는 브라우저 캔버스 글꼴 측정을 설치한다. 엔진은 위 initSync 로 이미 준비됐다.
    wasm.initialized = true;
    return wasm;
  }

  return {
    vite,
    load,
    command,
    CommandHistory,
    EventBus,
    newDocument() {
      const wasm = bridge();
      quietly(() => wasm.createNewDocument());
      return wasm;
    },
    openDocument(bytes, fileName) {
      const wasm = bridge();
      quietly(() => wasm.loadDocument(bytes, fileName));
      return wasm;
    },
    createHost(wasm) {
      const host = Object.create(InputHandler.prototype);
      Object.assign(host, {
        wasm,
        eventBus: new EventBus(),
        history: new CommandHistory(),
        cursor: new CursorState(wasm),
        active: true,
        insertMode: true,
        editMode: 'normal',
        readOnly: false,
        userEditingLocked: false,
        agentTemplateLocked: false,
        imeSession: new ImeSession(),
        compositionAnchor: null,
        compositionLength: 0,
        pendingCharFormat: null,
        lastCellKey: null,
        protectedCellHitCache: null,
        cachedTableRef: null,
        cachedCellBboxes: null,
        tableBboxFetchFailures: new Set(),
        tableLocalResizeSegments: new Set(),
        rawTextMutationEffects: new command.TextMutationEffectAccumulator(),
        deferredPaginationPending: false,
        deferredPaginationFlushTimer: null,
        deferredPaginationRunner: { isActive: () => false, cancel() {}, start() {} },
        caretLayoutReveal: { requestFor() {} },
        textarea: { value: '', focus() {}, blur() {} },
        // 화면 갱신(캐럿·스크롤)만 비운다.
        updateCaret() {},
        scheduleDeferredPaginationFlush() {},
      });
      return host;
    },
    close: () => vite.close(),
  };
}

/**
 * 사용자가 보는 쪽 전부와 저장될 HWPX 바이트를 합친 문서 지문.
 * undo 가 문서를 "정확히" 되돌렸는지 비교하는 기준이다.
 */
export function documentFingerprint(wasm: any): string {
  wasm.flushDeferredPagination?.();
  const hash = createHash('sha256');
  for (let page = 0; page < wasm.pageCount; page++) hash.update(wasm.renderPageSvg(page));
  hash.update(wasm.exportHwpx());
  return hash.digest('hex');
}

/**
 * 화면에 보이는 쪽 전부의 지문. 글자 모양을 새로 만든 편집은 undo 뒤에도 글자 모양 표가
 * 남아 HWPX 바이트가 달라지므로, 서식 편집의 undo 는 이 지문으로 비교한다.
 */
export function pagesFingerprint(wasm: any): string {
  wasm.flushDeferredPagination?.();
  const hash = createHash('sha256');
  for (let page = 0; page < wasm.pageCount; page++) hash.update(wasm.renderPageSvg(page));
  return hash.digest('hex');
}

/** 명령 모듈(src/command/commands/*.ts)에 넘기는 최소 CommandServices. */
export function commandServices(host: any, extra: Record<string, unknown> = {}): any {
  return {
    wasm: host.wasm,
    eventBus: host.eventBus,
    documentState: { isDirty: () => false, markDirty() {}, markClean() {} },
    getContext: () => ({}),
    getInputHandler: () => host,
    getViewportManager: () => null,
    setEditMode() {},
    ...extra,
  };
}

/**
 * 편집 한 번이 이력 한 칸으로 남았는지 확인한다: 실제 handleUndo 가 편집 전 문서를,
 * handleRedo 가 편집 후 문서를 정확히 되살려야 한다. 이력을 우회한 편집은 undo 로
 * 되돌아가지 않으므로 여기서 실패한다.
 */
export function assertUndoRedoRestores(
  host: any,
  before: string,
  message = '',
  fingerprint: (wasm: any) => string = documentFingerprint,
): string {
  const after = fingerprint(host.wasm);
  assert.notEqual(after, before, `편집이 문서를 바꾸지 않았다 ${message}`);
  host.handleUndo();
  assert.equal(fingerprint(host.wasm), before, `undo 가 편집 전 문서를 되살리지 못했다 ${message}`);
  host.handleRedo();
  assert.equal(fingerprint(host.wasm), after, `redo 가 편집 후 문서를 되살리지 못했다 ${message}`);
  return after;
}
