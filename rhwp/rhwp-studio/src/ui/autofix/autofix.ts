/**
 * 자동 수정(데스크톱 전용). 다시 시도로 풀리지 않는 오류에 초록 '자동 수정' 단추를 둔다. 누르면 메인이
 * 보이지 않는 코딩 에이전트로 이 컴퓨터의 앱 환경을 고치고 개발자에게 오류 보고를 보낸다.
 *
 * - 설정에서 켠 경우에만 단추가 선다(autofixReady). 웹 빌드나 꺼진 설정은 지금처럼 다시 시도만 둔다.
 * - 다시 시도가 같은 오류로 두 번 실패하면 그 자리의 다시 시도가 자동 수정으로 바뀐다(createRetryEscalation).
 * - 단추 상태: 자동 수정 → 점 세 개(실행 중) → 고침/실패(1.5초) 또는 흔들림 + 사용 불가(1.6초) → 자동 수정.
 *   고침 뒤에는 실패했던 동작을 다시 한다.
 * - 다시 한 동작이 되거나 또 실패하면 메인에 알린다(noteAutofixOutcome). 메인은 그 결과까지 담아 보고하고,
 *   다음 실행의 맥락에 싣는다.
 * - 같은 오류의 다시 시도가 한 번 실패하면 단추가 서기 전에 제공자를 미리 고른다(prewarmAutofix).
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
  /** 'gift' 는 Codex·Claude 를 둘 다 쓸 수 없을 때 받은 선물 크레딧으로 돈 경우다(설정 목록에는 없다). */
  provider?: AutofixProviderId | 'gift';
  /** 이 실행의 기록 이름(사용자 데이터의 autofix-runs 아래 폴더) */
  runId?: string;
  /** 에이전트가 찾은 원인(한국어). 믿지 않는 글이므로 텍스트로만 보인다. */
  cause?: string;
}

/** 고친 자리의 동작이 다시 됐는지(ok) 또 실패했는지. runId 가 없으면 메인이 그 자리의 가장 최근 실행과 맞춘다. */
export interface AutofixOutcome {
  surface: string;
  ok: boolean;
  runId?: string;
}

export interface AutofixProviderSettings {
  id: AutofixProviderId;
  enabled: boolean;
  model: string;
  effort: string;
}

export interface AutofixSettings {
  /** 켜야만 단추가 선다(기본 켜짐). */
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
  /** 단추가 서기 전에 쓸 제공자를 미리 고른다. */
  prewarm?(): Promise<unknown>;
  /** 고친 자리의 확인 결과를 알린다. */
  outcome?(outcome: AutofixOutcome): Promise<unknown>;
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
  awaiting.clear();
  lastPrewarmAt = Number.NEGATIVE_INFINITY;
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

let inflight: Promise<AutofixResult> | null = null;
/** 이 페이지에서 고친 자리 → 그 실행. 그 자리의 다음 성공·실패를 메인에 알린다. */
const awaiting = new Map<string, string | undefined>();

function readResult(result: AutofixResult | null | undefined): AutofixResult {
  const status: AutofixStatus = result?.status === 'fixed' || result?.status === 'unavailable' ? result.status : 'failed';
  const out: AutofixResult = { status };
  if (result?.provider === 'codex' || result?.provider === 'claude' || result?.provider === 'gift') out.provider = result.provider;
  if (typeof result?.runId === 'string' && result.runId) out.runId = result.runId;
  if (typeof result?.cause === 'string' && result.cause.trim()) out.cause = result.cause.trim();
  return out;
}

/** 자동 수정을 돌리고 결과(원인·실행 이름 포함)를 돌려준다. 이 창에서 이미 돌고 있으면 그 결과를 같이 기다린다. 거절은 실패다. */
export function runAutofixResult(request: AutofixRequest): Promise<AutofixResult> {
  if (inflight) return inflight;
  const api = bind();
  if (!api) return Promise.resolve({ status: 'unavailable' });
  const run: Promise<AutofixResult> = (async () => {
    try {
      const result = readResult(await api.run(request));
      if (result.status === 'fixed') awaiting.set(request.surface, result.runId);
      return result;
    } catch (error) {
      console.warn('[autofix] 자동 수정이 실패했습니다:', error);
      return { status: 'failed' };
    }
  })();
  inflight = run;
  void run.finally(() => { if (inflight === run) inflight = null; });
  return run;
}

/** 자동 수정을 돌린다. 결과 상태만 돌려준다. */
export function runAutofix(request: AutofixRequest): Promise<AutofixStatus> {
  return runAutofixResult(request).then((result) => result.status);
}

/** 이 페이지에서 자동 수정이 돌고 있는가 */
export function autofixRunning(): boolean {
  return inflight !== null;
}

/**
 * 고치면 페이지를 다시 불러오는 자리. 다시 불러온 페이지는 고친 실행을 모르므로 늘 메인에 알리고,
 * 메인이 확인을 기다리는 실행이 있을 때만 맞춘다.
 */
const RELOADING_SURFACES: ReadonlySet<string> = new Set(['init-failure', 'engine-trap', 'renderer-crash']);

/** 고친 자리의 동작이 다시 됐다(ok) 또는 또 실패했다. 고친 실행이 없는 자리면 아무것도 하지 않는다. */
export function noteAutofixOutcome(surface: string, ok: boolean): void {
  const known = awaiting.has(surface);
  if (!known && !RELOADING_SURFACES.has(surface)) return;
  const runId = awaiting.get(surface);
  awaiting.delete(surface);
  const api = autofixApi();
  if (!api?.outcome) return;
  void api.outcome({ surface, ok, ...(runId ? { runId } : {}) }).catch(() => {});
}

/** 미리 고르기를 다시 부르지 않는 간격. 메인도 같은 설정으로 고른 것을 몇 분 동안 다시 쓴다. */
export const AUTOFIX_PREWARM_INTERVAL_MS = 60_000;
let lastPrewarmAt = Number.NEGATIVE_INFINITY;

/** 곧 자동 수정을 누를 것 같다: 메인이 쓸 제공자를 미리 고르게 한다. 꺼져 있거나 웹이면 하지 않는다. */
export function prewarmAutofix(now = Date.now()): void {
  if (!autofixReady() || inflight) return;
  const api = bind();
  if (!api?.prewarm || now - lastPrewarmAt < AUTOFIX_PREWARM_INTERVAL_MS) return;
  lastPrewarmAt = now;
  void api.prewarm().catch(() => {});
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

/**
 * 같은 오류의 실패한 다시 시도를 센다. 오류가 바뀌거나 성공하면 처음부터 센다.
 * surface 를 주면 그 자리의 성공·실패를 고친 실행의 확인으로도 알리고, 한도 한 번 전에 제공자를 미리 고른다.
 */
export function createRetryEscalation(threshold = 2, surface?: string): RetryEscalation {
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
      if (surface) {
        noteAutofixOutcome(surface, false);
        if (count >= threshold - 1 && count > 0) prewarmAutofix();
      }
      return count;
    },
    reset() {
      current = null;
      pending = null;
      count = 0;
      if (surface) noteAutofixOutcome(surface, true);
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
