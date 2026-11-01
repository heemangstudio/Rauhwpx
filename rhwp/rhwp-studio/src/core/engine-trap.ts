/**
 * WASM 엔진 trap 감지.
 *
 * wasm 은 trap(unreachable, memory access out of bounds 등) 뒤에 스택 포인터와 RefCell 대여를
 * 되돌리지 않는다. 그 인스턴스의 다음 호출은 "recursive use of an object" 로 거절되거나 또 trap
 * 하므로, 첫 trap 을 한 번 알리고 이후 화면 갱신·쓰기를 멈춰 마지막으로 그린 쪽을 지킨다.
 * 엔진 메서드 밖으로 나온 스택 오버플로(V8 RangeError, Firefox InternalError)도 wasm 프레임을
 * 정리 없이 버려 같은 상태를 남기므로 trap 으로 본다. 엔진 밖 순수 JS 재귀 오류는 아니다.
 *
 * 복구 계약: 읽기(`&self`) 호출이 trap 하면 새어 나간 것은 공유 대여뿐이라 `&self` 인
 * exportHwp/exportHwpx/exportHml 과 getSourceFormat 은 계속 들어갈 수 있고, 멈춘 직후의
 * 복구본 저장이 이것들을 쓴다 (저장 형식을 고르는 getSourceFormat 과 HML 원본의 exportHml 까지).
 * 쓰기(`&mut self`) 호출이 trap 하면 모델이 반쯤 바뀌었을 수 있어 내보내기도 거절되며,
 * 이때는 마지막 주기 자동 저장본이 복구 원본이다.
 */

export interface EngineTrapInfo {
  message: string;
}

const TRAP_MESSAGE = /memory access out of bounds|^unreachable$|recursive use of an object detected|already (mutably )?borrowed/;
const STACK_OVERFLOW_MESSAGE = /Maximum call stack size exceeded|too much recursion/;

/** 엔진 메서드 밖으로 나온 스택 오버플로 오류 객체. */
const engineStackOverflows = new WeakSet<object>();

function isStackOverflow(error: unknown): error is Error {
  return error instanceof Error
    && (error.name === 'RangeError' || error.name === 'InternalError')
    && STACK_OVERFLOW_MESSAGE.test(error.message);
}

/** trap 뒤에 엔진 호출을 막을 때 던진다. */
export class EngineTrappedError extends Error {
  constructor(message: string) {
    super(`문서 엔진이 멈췄습니다: ${message}`);
    this.name = 'EngineTrappedError';
  }
}

/**
 * 멈춘 뒤에도 허용하는 읽기 — 복구본·사본 저장이 쓴다. 모두 `&self` 라 trap 이 남긴 공유 대여와
 * 함께 들어갈 수 있다 (wasm_api.rs 의 exportHml·getSourceFormat 도 `&self`). getSourceFormat 이
 * 막히면 확장자 없는 문서가, exportHml 이 막히면 HML 문서가 복구본을 남기지 못한다.
 */
const CALLS_ALLOWED_AFTER_TRAP = new Set(['exportHwp', 'exportHwpx', 'exportHml', 'getSourceFormat', 'free']);

/**
 * 문서 내용을 바꾸지 않는 엔진 메서드 이름 (wasm_api.rs 의 `&self` 메서드). 이름이 읽기처럼 보여도
 * `&mut self` 인 메서드는 아래 예외에 둔다 — tests/engine-mutation-epoch.test.ts 가 wasm_api.rs 와 맞춰 본다.
 */
export const ENGINE_READ_CALL = /^(get|export|render|hitTest|has|is|find|count|measure|search)[A-Z0-9]/;
export const ENGINE_MUTATING_READ_NAMES: ReadonlySet<string> = new Set([
  'exportHwpVerify',
  'findOrCreateFontId',
  'findOrCreateFontIdForLang',
  'getCharShapeRunsInCellByPath',
  'getCellCharPropertiesAtByPath',
  'getCellParaPropertiesAtByPath',
]);

/** 이름 규칙에 들지 않는 `&self` 메서드 가운데 화면·입력이 자주 부르는 것. 빠지면 지문을 다시 낼 뿐이다. */
export const ENGINE_READ_NAMES: ReadonlySet<string> = new Set([
  'canBatchBodyText', 'clipboardHasControl', 'clipboardIsSingleControl', 'hitTest',
  'logicalToTextOffset', 'logicalToTextOffsetInCell', 'logicalToTextOffsetInCellByPath',
  'moveVertical', 'moveVerticalByPath', 'moveVerticalEx', 'navigateHeaderFooterByPage',
  'navigateNextEditable', 'pageCount', 'pageHasFootnoteFootholds', 'pendingTaskCount',
  'textToLogicalOffset', 'textToLogicalOffsetInCellByPath', 'visiblePages',
]);

export function isEngineReadCall(name: string): boolean {
  if (ENGINE_READ_NAMES.has(name)) return true;
  return ENGINE_READ_CALL.test(name) && !ENGINE_MUTATING_READ_NAMES.has(name);
}

/** 읽기가 아닌 엔진 호출마다 오른다 (모든 문서 공통). 같은 값이면 그사이 어떤 문서도 바뀌지 않았다. */
let mutationEpoch = 0;

export function engineMutationEpoch(): number {
  return mutationEpoch;
}

let trapped: EngineTrapInfo | null = null;
const listeners = new Set<(info: EngineTrapInfo) => void>();

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isEngineTrap(error: unknown): boolean {
  if (error instanceof EngineTrappedError) return true;
  if (typeof WebAssembly !== 'undefined' && error instanceof WebAssembly.RuntimeError) return true;
  if (typeof error === 'object' && error !== null && engineStackOverflows.has(error)) return true;
  return TRAP_MESSAGE.test(errorMessage(error));
}

/** trap 이면 엔진을 멈춘 상태로 표시하고 true 를 돌려준다. 알림은 처음 한 번만 보낸다. */
export function reportEngineTrap(error: unknown): boolean {
  if (!isEngineTrap(error)) return false;
  if (!trapped) {
    trapped = { message: errorMessage(error) };
    console.error('[engine] WASM 엔진이 멈췄습니다. 화면 갱신과 편집을 중단합니다:', error);
    for (const listener of listeners) listener(trapped);
  }
  return true;
}

export function engineTrap(): EngineTrapInfo | null {
  return trapped;
}

export function onEngineTrap(listener: (info: EngineTrapInfo) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * 엔진 객체의 모든 메서드에서 trap 을 잡아 알린다. 멈춘 뒤에는 내보내기만 wasm 에 들어가고
 * 나머지는 곧바로 EngineTrappedError 를 던진다 — 망가진 인스턴스가 엉뚱한 쪽 수·좌표를
 * 돌려주거나 스택을 더 잃어 memory access out of bounds 로 번지지 않게 한다.
 */
export function guardEngineCalls(proto: object): void {
  guardCalls(proto, isEngineReadCall, CALLS_ALLOWED_AFTER_TRAP);
}

/** HeemangEngine `Doc` 에서 문서 내용을 바꾸지 않는 메서드. 나머지 호출마다 변이 순번이 오른다. */
const HEEMANG_READ_CALLS: ReadonlySet<string> = new Set([
  'state', 'pages', 'pageInfo', 'page', 'patch', 'pictureSource', 'pictureBytes', 'pageSvg', 'pdf', 'pagePng',
  'locate', 'objects', 'pageObjects', 'select', 'selectRange', 'navigate', 'query', 'search', 'layoutStats',
  'substitutions', 'fontRequests', 'glyphRequests', 'fontNames', 'copy', 'hasTableTransposeClipboard', 'checkpoint',
  'layoutFirst', 'layoutMore',
  'releaseCheckpoint', 'serialize', 'serializeAs', 'exportHwpx', 'verifyHwp',
]);
/** 멈춘 뒤에도 복구본 저장이 쓰는 읽기. */
const HEEMANG_CALLS_ALLOWED_AFTER_TRAP: ReadonlySet<string> = new Set(['serialize', 'serializeAs', 'state', 'free']);

/** HeemangEngine `Doc` 의 메서드에 같은 trap 감시와 변이 순번을 건다. */
export function guardHeemangEngineCalls(proto: object): void {
  guardCalls(proto, name => HEEMANG_READ_CALLS.has(name), HEEMANG_CALLS_ALLOWED_AFTER_TRAP);
}

function guardCalls(proto: object, isRead: (name: string) => boolean, allowed: ReadonlySet<string>): void {
  const marker = Symbol.for('rhwp.engineTrapGuard');
  const target = proto as Record<PropertyKey, unknown>;
  if (target[marker]) return;
  target[marker] = true;
  for (const name of Object.getOwnPropertyNames(proto)) {
    if (name === 'constructor') continue;
    const descriptor = Object.getOwnPropertyDescriptor(proto, name);
    const original = descriptor?.value;
    if (typeof original !== 'function' || !descriptor?.writable) continue;
    const allowedAfterTrap = allowed.has(name);
    const mutates = !isRead(name);
    target[name] = function guarded(this: unknown, ...args: unknown[]) {
      if (trapped && !allowedAfterTrap) throw new EngineTrappedError(trapped.message);
      if (mutates) mutationEpoch += 1;
      try {
        return original.apply(this, args);
      } catch (error) {
        if (isStackOverflow(error)) engineStackOverflows.add(error);
        reportEngineTrap(error);
        throw error;
      }
    };
  }
}

/** 테스트 전용 — 모듈 상태를 되돌린다. */
export function resetEngineTrapForTests(): void {
  trapped = null;
  listeners.clear();
}
