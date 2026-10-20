/**
 * 자동 수정(데스크톱 전용). 다시 시도로 풀리지 않는 오류에 초록 '자동 수정' 단추를 둔다. 누르면 메인이
 * 보이지 않는 코딩 에이전트로 이 컴퓨터의 앱 환경을 고치고 개발자에게 오류 보고를 보낸다.
 *
 * - 설정에서 켠 경우에만 단추가 선다(autofixReady). 웹 빌드나 꺼진 설정은 지금처럼 다시 시도만 둔다.
 * - 다시 시도가 같은 오류로 두 번 실패하면 그 자리의 다시 시도가 자동 수정으로 바뀐다(createRetryEscalation).
 * - 단추 상태: 자동 수정 → 점 세 개(실행 중) → 고침/실패(1.5초) 또는 흔들림 + 사용 불가(1.6초) → 자동 수정.
 *   고침 뒤에는 실패했던 동작을 다시 한다.
 */
export type AutofixStatus = 'fixed' | 'failed' | 'unavailable';
export type AutofixProviderId = 'codex' | 'claude';

export interface AutofixRequest {
  /** 오류가 난 곳의 짧은 고정 id (provider-failure, hub-connection, browser-page, engine-trap, init-failure) */
  surface: string;
  /** 사용자가 본 오류 제목 */
  title: string;
  /** 오류 코드나 원문 */
  detail?: string;
  /** 사용자가 다시 시도한 횟수 */
  attempts?: number;
}

export interface AutofixResult {
  status: AutofixStatus;
  provider?: AutofixProviderId;
}

export interface AutofixProviderSettings {
  id: AutofixProviderId;
  enabled: boolean;
  model: string;
  effort: string;
}

export interface AutofixSettings {
  /** 켜야만 단추가 선다(기본 꺼짐). */
  enabled: boolean;
  /** 사용자가 켤지 말지 답했다. */
  decided: boolean;
  /** 순서가 우선순위다. 두 id 가 늘 다 있다. */
  providers: AutofixProviderSettings[];
}

export interface DesktopAutofixApi {
  /** 앱 전체에서 한 번에 하나만 돈다. 보통 거절하지 않지만, 거절하면 실패로 본다. */
  run(request: AutofixRequest): Promise<AutofixResult>;
  getSettings(): Promise<AutofixSettings>;
  setSettings(patch: Partial<AutofixSettings>): Promise<AutofixSettings>;
  onChange(callback: (settings: AutofixSettings) => void): () => void;
}

// ─── 데스크톱 API 와 설정 ─────────────────────────────

let override: DesktopAutofixApi | null | undefined;
let boundApi: DesktopAutofixApi | null = null;
let settings: AutofixSettings | null = null;
let unsubscribe: (() => void) | null = null;
const listeners = new Set<(settings: AutofixSettings | null) => void>();

function validApi(value: unknown): DesktopAutofixApi | null {
  const api = value as Partial<DesktopAutofixApi> | null | undefined;
  return api && typeof api.run === 'function' && typeof api.getSettings === 'function'
    && typeof api.setSettings === 'function' && typeof api.onChange === 'function'
    ? api as DesktopAutofixApi
    : null;
}

/** 데스크톱 preload 의 자동 수정 API. 웹 빌드는 null. */
export function autofixApi(): DesktopAutofixApi | null {
  if (override !== undefined) return override;
  const host = globalThis as { rhwpDesktop?: { autofix?: unknown } };
  return validApi(host.rhwpDesktop?.autofix);
}

/** 미리보기·테스트가 API 를 바꿔 끼운다. undefined 면 다시 window.rhwpDesktop 을 본다. */
export function setAutofixApi(api: DesktopAutofixApi | null | undefined): void {
  override = api;
  unsubscribe?.();
  unsubscribe = null;
  boundApi = null;
  publish(null);
  bind();
}

function publish(next: AutofixSettings | null): void {
  settings = next;
  for (const listener of [...listeners]) listener(next);
}

/** 설정을 읽고 바뀌는 것을 따라간다. 처음 한 번만 붙는다. */
function bind(): DesktopAutofixApi | null {
  const api = autofixApi();
  if (!api || boundApi === api) return api;
  boundApi = api;
  unsubscribe = api.onChange((next) => publish(next));
  void api.getSettings().then((next) => {
    if (boundApi === api) publish(next);
  }, (error) => console.warn('[autofix] 설정을 읽지 못했습니다:', error));
  return api;
}

/** 지금 아는 설정. 아직 읽지 못했거나 웹 빌드면 null. */
export function autofixSettings(): AutofixSettings | null {
  bind();
  return settings;
}

/** 설정을 새로 읽는다. 웹 빌드면 null. */
export async function loadAutofixSettings(): Promise<AutofixSettings | null> {
  const api = bind();
  if (!api) return null;
  const next = await api.getSettings();
  if (boundApi === api) publish(next);
  return next;
}

/** 설정 일부를 바꾼다. 웹 빌드면 null. */
export async function updateAutofixSettings(patch: Partial<AutofixSettings>): Promise<AutofixSettings | null> {
  const api = bind();
  if (!api) return null;
  const next = await api.setSettings(patch);
  if (boundApi === api) publish(next);
  return next;
}

/** 설정이 바뀔 때마다 부른다. 해제 함수를 돌려준다. */
export function onAutofixSettings(listener: (settings: AutofixSettings | null) => void): () => void {
  bind();
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** 자동 수정 단추를 세워도 되는가 — 데스크톱이고 사용자가 켰다. */
export function autofixReady(): boolean {
  return autofixSettings()?.enabled === true;
}

let inflight: Promise<AutofixStatus> | null = null;

/** 자동 수정을 돌린다. 이 창에서 이미 돌고 있으면 그 결과를 같이 기다린다. 거절은 실패다. */
export function runAutofix(request: AutofixRequest): Promise<AutofixStatus> {
  if (inflight) return inflight;
  const api = bind();
  if (!api) return Promise.resolve('unavailable');
  const run: Promise<AutofixStatus> = (async () => {
    try {
      const result = await api.run(request);
      const status = result?.status;
      return status === 'fixed' || status === 'unavailable' ? status : 'failed';
    } catch (error) {
      console.warn('[autofix] 자동 수정이 실패했습니다:', error);
      return 'failed';
    }
  })();
  inflight = run;
  void run.finally(() => { if (inflight === run) inflight = null; });
  return run;
}

// ─── 다시 시도 누적 ─────────────────────────────

export interface RetryEscalation {
  /** 사용자가 이 오류를 다시 시도했다. */
  retried(key: string): void;
  /** 이 오류가 났다(다시). 다시 시도 뒤 같은 오류면 실패 횟수가 하나 는다. 실패 횟수를 돌려준다. */
  failed(key: string): number;
  /** 동작이 성공했거나 사용자가 다른 일을 시작했다. */
  reset(): void;
  /** 이 오류의 다시 시도가 한도만큼 실패했다 — 자동 수정을 보인다. */
  escalated(key: string): boolean;
  /** 이 오류의 실패한 다시 시도 횟수 */
  attempts(key: string): number;
}

/** 같은 오류의 실패한 다시 시도를 센다. 오류가 바뀌거나 성공하면 처음부터 센다. */
export function createRetryEscalation(threshold = 2): RetryEscalation {
  let current: string | null = null;
  let pending: string | null = null;
  let count = 0;
  return {
    retried(key) {
      pending = key;
      if (current !== key) {
        current = key;
        count = 0;
      }
    },
    failed(key) {
      if (current !== key) {
        current = key;
        count = 0;
      } else if (pending === key) {
        count += 1;
      }
      pending = null;
      return count;
    },
    reset() {
      current = null;
      pending = null;
      count = 0;
    },
    escalated(key) {
      return current === key && count >= threshold;
    },
    attempts(key) {
      return current === key ? count : 0;
    },
  };
}

// ─── 단추 상태 ─────────────────────────────

export type AutofixPhase = 'idle' | 'running' | AutofixStatus;

/** 고침·실패를 보이는 시간 */
export const AUTOFIX_RESULT_MS = 1500;
/** 사용 불가(흔들림 + 빨강)를 보이는 시간 */
export const AUTOFIX_UNAVAILABLE_MS = 1600;

export interface AutofixControllerOptions {
  run(): Promise<AutofixStatus>;
  /** 고침을 보인 뒤 실패했던 동작을 다시 한다. */
  onFixed(): void;
  onPhase(phase: AutofixPhase): void;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface AutofixController {
  phase(): AutofixPhase;
  /** 쉬고 있을 때만 시작한다. */
  start(): void;
  dispose(): void;
}

export function createAutofixController(options: AutofixControllerOptions): AutofixController {
  const setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  let phase: AutofixPhase = 'idle';
  let timer: unknown = null;
  let disposed = false;
  const set = (next: AutofixPhase) => {
    phase = next;
    options.onPhase(next);
  };
  return {
    phase: () => phase,
    start() {
      if (disposed || phase !== 'idle') return;
      set('running');
      void options.run().catch((): AutofixStatus => 'failed').then((status) => {
        if (disposed) return;
        set(status);
        timer = setTimer(() => {
          timer = null;
          if (disposed) return;
          set('idle');
          if (status === 'fixed') options.onFixed();
        }, status === 'unavailable' ? AUTOFIX_UNAVAILABLE_MS : AUTOFIX_RESULT_MS);
      });
    },
    dispose() {
      disposed = true;
      if (timer !== null) clearTimer(timer);
      timer = null;
    },
  };
}
