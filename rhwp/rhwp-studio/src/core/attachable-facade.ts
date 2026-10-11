/**
 * 붙였다 뗄 수 있는 전달 퍼사드.
 *
 * 페이지 코드(CanvasView·InputHandler·명령 서비스 등)는 퍼사드 하나를 계속 쥐고, 퍼사드가
 * 가리키는 대상만 문서 세션 사이에서 바꾼다. 다시 파싱하지 않고 화면에 붙은 문서를 바꾸기
 * 위한 장치다.
 *
 * - 읽기·쓰기·`in`·`instanceof` 는 현재 대상으로 그대로 전달한다. getter/setter 의 this 는
 *   대상 자신이라 JS `#private` 필드와 TS private 필드가 모두 동작한다.
 * - 메서드는 대상에 bind 한 함수를 (대상, 키) 마다 캐시해 돌려준다. 렌더 hot path 에서
 *   호출마다 새 함수를 만들지 않으며, 같은 대상으로 돌아오면 같은 함수가 나온다.
 *   꺼내 둔 bound 메서드는 꺼낸 시점의 대상을 계속 부른다.
 * - sticky 키(콜백 슬롯)는 퍼사드에 값을 보관하고, 퍼사드가 거쳐 간 모든 대상에 "그 대상이
 *   현재일 때만 퍼사드 값을 부르는" 래퍼를 심는다. 대상이 원래 갖고 있던 콜백은 래퍼가
 *   이어서 항상 부른다.
 */
export interface AttachableFacade<T extends object> {
  /** 현재 대상으로 읽기·호출·쓰기를 전달하는 객체 */
  readonly facade: T;
  current(): T;
  retarget(target: T): void;
}

export interface AttachableFacadeOptions {
  /** 퍼사드에 보관하고 현재 대상에서만 불리는 콜백 슬롯 */
  stickyKeys?: readonly string[];
}

type AnyFunction = (...args: unknown[]) => unknown;

interface BoundMethod {
  source: AnyFunction;
  bound: AnyFunction;
}

interface StickyWrapper {
  wrapper: AnyFunction;
}

export function createAttachableFacade<T extends object>(
  initial: T,
  opts: AttachableFacadeOptions = {},
): AttachableFacade<T> {
  let target: T = initial;
  const boundByTarget = new WeakMap<object, Map<PropertyKey, BoundMethod>>();
  let currentBound = boundCacheFor(initial);
  const stickyKeys = new Set<PropertyKey>(opts.stickyKeys ?? []);
  const stickyValues = new Map<PropertyKey, unknown>();
  const stickyByTarget = new WeakMap<object, Map<PropertyKey, StickyWrapper>>();

  function boundCacheFor(next: object): Map<PropertyKey, BoundMethod> {
    let cache = boundByTarget.get(next);
    if (!cache) {
      cache = new Map();
      boundByTarget.set(next, cache);
    }
    return cache;
  }

  function installSticky(owner: T, key: PropertyKey): void {
    let wrappers = stickyByTarget.get(owner);
    if (!wrappers) {
      wrappers = new Map();
      stickyByTarget.set(owner, wrappers);
    }
    const existing = wrappers.get(key);
    const present = Reflect.get(owner, key, owner);
    if (existing && present === existing.wrapper) return;
    // 대상이 스스로 걸어 둔 콜백(세션 전용 훅 등)은 잃지 않고 이어 부른다.
    const previous = typeof present === 'function' ? present as AnyFunction : null;
    const wrapper = function stickyForward(this: unknown, ...args: unknown[]): unknown {
      let result: unknown;
      if (target === owner) {
        const value = stickyValues.get(key);
        if (typeof value === 'function') result = Reflect.apply(value, facade, args);
      }
      if (previous) Reflect.apply(previous, owner, args);
      return result;
    };
    Reflect.set(owner, key, wrapper, owner);
    wrappers.set(key, { wrapper });
  }

  const facade = new Proxy({} as T, {
    get(_shell, key) {
      if (stickyKeys.has(key) && stickyValues.has(key)) return stickyValues.get(key);
      const value = Reflect.get(target, key, target);
      if (typeof value !== 'function' || key === 'constructor') return value;
      const hit = currentBound.get(key);
      if (hit !== undefined && hit.source === value) return hit.bound;
      const bound = (value as AnyFunction).bind(target) as AnyFunction;
      currentBound.set(key, { source: value as AnyFunction, bound });
      return bound;
    },
    set(_shell, key, value) {
      if (stickyKeys.has(key)) {
        stickyValues.set(key, value);
        installSticky(target, key);
        return true;
      }
      return Reflect.set(target, key, value, target);
    },
    has(_shell, key) {
      return Reflect.has(target, key);
    },
    deleteProperty(_shell, key) {
      if (stickyKeys.has(key)) {
        stickyValues.delete(key);
        return true;
      }
      return Reflect.deleteProperty(target, key);
    },
    ownKeys() {
      return Reflect.ownKeys(target);
    },
    getOwnPropertyDescriptor(_shell, key) {
      const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
      // 프록시 껍데기에는 없는 속성이므로 configurable 로 보고해야 Proxy 불변식을 지킨다.
      return descriptor ? { ...descriptor, configurable: true } : undefined;
    },
    defineProperty(_shell, key, descriptor) {
      return Reflect.defineProperty(target, key, descriptor);
    },
    getPrototypeOf() {
      return Reflect.getPrototypeOf(target);
    },
  });

  return {
    facade,
    current: () => target,
    retarget(next: T): void {
      if (next === target) return;
      if ((next as unknown) === facade) throw new Error('A facade cannot target itself');
      target = next;
      currentBound = boundCacheFor(next);
      for (const key of stickyValues.keys()) installSticky(next, key);
    },
  };
}
