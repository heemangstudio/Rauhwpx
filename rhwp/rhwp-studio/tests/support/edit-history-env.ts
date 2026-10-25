/**
 * 실제 HeemangEngine(hm-wasm) 위에서 편집 이력(undo/redo)을 검증하는 Node 테스트 환경.
 *
 * Vite 모듈 로더로 실제 WasmBridge·명령 클래스·CommandHistory·InputHandler 프로토타입을
 * 불러온다. InputHandler 는 DOM 없이 만들 수 없으므로 프로토타입을 그대로 쓰는 호스트를
 * 만들고, 캐럿 그리기 같은 화면 갱신만 비워 둔다. 편집 라우터(executeOperation)와
 * handleUndo/handleRedo 는 실제 코드가 돈다.
 */
import './wasm-liftoff.ts';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadStudioModule } from './module-server.ts';

const hmWasmRoot = new URL('../../vendor/hm-wasm/', import.meta.url);
const fontDir = new URL('../../../ttfs/opensource/', import.meta.url);

// Node fetch 는 file: URL 을 못 읽는다. 새 문서 서식(blank.hwpx?url) 같은 로컬 자산만 디스크에서 준다.
const networkFetch = globalThis.fetch;
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const url = input instanceof URL ? input.href : typeof input === 'string' ? input : input.url;
  if (url.startsWith('file:')) return Promise.resolve(new Response(readFileSync(fileURLToPath(url))));
  return networkFetch(input, init);
}) as typeof fetch;

export interface EditEngine {
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
  const load = (path: string) => loadStudioModule(path);
  const hm = await load(new URL('hm_wasm.js', hmWasmRoot).href);
  hm.initSync({ module: readFileSync(new URL('hm_wasm_bg.wasm', hmWasmRoot)) });
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

  const { provideEngineFont } = await load('/src/core/engine-support.ts');
  // initialize() 는 프로세스 하나에 한 번 엔진 런타임(Engine·글꼴 등록기)을 만들고 어댑터에 붙인다.
  // 편집 테스트는 문서를 동기로 열므로, 첫 어댑터가 받은 런타임 필드를 새 어댑터에 그대로 붙인다.
  const probe = new WasmBridge();
  const bare: Record<string, unknown> = { ...probe.viewer };
  await probe.initialize();
  const runtime = Object.fromEntries(Object.entries(probe.viewer).filter(([key, value]) => value !== bare[key]));
  for (const name of readdirSync(fontDir)) {
    if (/\.(ttf|otf|ttc)$/i.test(name)) provideEngineFont(name, readFileSync(new URL(name, fontDir)));
  }

  function bridge(): any {
    const wasm = new WasmBridge();
    Object.assign(wasm.viewer, runtime);
    return wasm;
  }

  /** 웹 글꼴을 받지 않고 등록한 글꼴로 바로 조판한다. */
  function laidOut(wasm: any): any {
    wasm.viewer.markFontsPrepared();
    wasm.refreshLayout();
    return wasm;
  }

  return {
    load,
    command,
    CommandHistory,
    EventBus,
    newDocument() {
      const wasm = bridge();
      quietly(() => wasm.createNewDocument());
      return laidOut(wasm);
    },
    openDocument(bytes, fileName) {
      const wasm = bridge();
      quietly(() => wasm.loadDocument(bytes, fileName));
      return laidOut(wasm);
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
        caret: { show() {} },
        viewportManager: { getZoom: () => 1 },
        // 화면 갱신(캐럿·스크롤)만 비운다.
        updateCaret() {},
        scheduleDeferredPaginationFlush() {},
      });
      return host;
    },
    close: async () => {},
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
