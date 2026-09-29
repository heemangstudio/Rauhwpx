/**
 * WASM 엔진 trap 감지.
 *
 * wasm 은 trap(unreachable, memory access out of bounds 등) 뒤에 스택 포인터와 RefCell 대여를
 * 되돌리지 않는다. 그 인스턴스의 다음 호출은 "recursive use of an object" 로 거절되거나 또 trap
 * 하므로, 첫 trap 을 한 번 알리고 이후 화면 갱신·쓰기를 멈춰 마지막으로 그린 쪽을 지킨다.
 */

export interface EngineTrapInfo {
  message: string;
}

const TRAP_MESSAGE = /memory access out of bounds|^unreachable$|recursive use of an object detected|already (mutably )?borrowed/;

/** trap 뒤에 엔진 호출을 막을 때 던진다. */
export class EngineTrappedError extends Error {
  constructor(message: string) {
    super(`문서 엔진이 멈췄습니다: ${message}`);
    this.name = 'EngineTrappedError';
  }
}

/** 멈춘 뒤에도 허용하는 읽기 — 복구본·사본 저장이 쓴다. */
const CALLS_ALLOWED_AFTER_TRAP = new Set(['exportHwp', 'exportHwpx', 'free']);

let trapped: EngineTrapInfo | null = null;
const listeners = new Set<(info: EngineTrapInfo) => void>();

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isEngineTrap(error: unknown): boolean {
  if (error instanceof EngineTrappedError) return true;
  if (typeof WebAssembly !== 'undefined' && error instanceof WebAssembly.RuntimeError) return true;
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
  const marker = Symbol.for('rhwp.engineTrapGuard');
  const target = proto as Record<PropertyKey, unknown>;
  if (target[marker]) return;
  target[marker] = true;
  for (const name of Object.getOwnPropertyNames(proto)) {
    if (name === 'constructor') continue;
    const descriptor = Object.getOwnPropertyDescriptor(proto, name);
    const original = descriptor?.value;
    if (typeof original !== 'function' || !descriptor?.writable) continue;
    const allowedAfterTrap = CALLS_ALLOWED_AFTER_TRAP.has(name);
    target[name] = function guarded(this: unknown, ...args: unknown[]) {
      if (trapped && !allowedAfterTrap) throw new EngineTrappedError(trapped.message);
      try {
        return original.apply(this, args);
      } catch (error) {
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
