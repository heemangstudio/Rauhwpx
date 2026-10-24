/**
 * 에이전트 도구 엔진의 입구 — HeemangEngine 세션 엔진을 받아, 에이전트 도구(실행기·대기 편집·
 * 검토 오버레이·편집 따라가기)가 부르던 문서 API 를 내놓는다.
 *
 * 구현하지 않은 메서드는 세션 엔진으로 넘긴다. 세션 엔진에도 없으면 EngineNotSupportedError
 * (도구 오류 ENGINE_NOT_SUPPORTED) 로 거절된다. ABSENT 의 이름은 "없음"으로 보인다 —
 * 호출하는 쪽이 typeof 로 확인하고 다른 길로 가는 기능이다.
 */
import type { StudioEngine, WasmBridge } from '../../core/wasm-bridge.ts';
import type { Capabilities } from './wire.ts';
import { HeemangLayoutApi } from './layout.ts';

export { HeemangAgentCore } from './core.ts';

/** 엔진 이력으로 대신하는 문단 보관·스냅샷 공유, rhwp 전용 일괄 조판 */
const ABSENT = new Set<string>([
  'captureParagraph', 'restoreCapturedParagraph', 'discardParagraphCapture',
  'shareSnapshotExact', 'withBodyTextPaginationBatch',
]);

export class HeemangAgentEngine extends HeemangLayoutApi {}

/** 에이전트 도구가 HeemangEngine 문서에 닿는 엔진인지 */
export function isHeemangAgentEngine(engine: unknown): engine is HeemangAgentEngine {
  return engine instanceof HeemangAgentEngine;
}

/**
 * 엔진 빌드의 capabilities(). 어댑터가 이미 읽어 들인 hm-wasm 모듈을 늦게 가져온다 — 정적으로
 * 가져오면 엔진 없이 브리지만 읽는 곳(Node 테스트 등)까지 wasm 모듈을 끌어온다. 아직 못 읽었으면
 * null 이고, 그동안의 확인은 엔진 자신의 오류에 맡긴다.
 */
let readCapabilities: (() => string) | null = null;
let loadingCapabilities: Promise<void> | null = null;
function engineCapabilities(): Capabilities | null {
  loadingCapabilities ??= import('../../../vendor/hm-wasm/hm_wasm')
    .then((module) => { readCapabilities = module.capabilities; })
    .catch(() => { /* 엔진 모듈이 없는 환경 */ });
  return readCapabilities ? JSON.parse(readCapabilities()) as Capabilities : null;
}

/** 세션 엔진에서 에이전트 도구 엔진을 얻는다. HeemangEngine 이 아니면 그대로 돌려준다. */
export function agentEngineFor(host: WasmBridge | StudioEngine): WasmBridge {
  const adapter = (host as StudioEngine).viewer;
  if ((host as StudioEngine).engineKind !== 'heemang' || !adapter) return host as WasmBridge;
  engineCapabilities();
  const engine = new HeemangAgentEngine(adapter, engineCapabilities);
  return new Proxy(engine, {
    get(target, key, receiver) {
      if (typeof key === 'symbol' || key === 'then') return Reflect.get(target, key, receiver);
      if (ABSENT.has(key)) return undefined;
      if (Reflect.has(target, key)) {
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      }
      const value = Reflect.get(host, key);
      return typeof value === 'function' ? value.bind(host) : value;
    },
    set(target, key, value) {
      if (Reflect.has(target, key)) return Reflect.set(target, key, value, target);
      return Reflect.set(host, key, value);
    },
    has(target, key) {
      if (typeof key === 'string' && ABSENT.has(key)) return false;
      return Reflect.has(target, key) || Reflect.has(host, key);
    },
  }) as unknown as WasmBridge;
}
