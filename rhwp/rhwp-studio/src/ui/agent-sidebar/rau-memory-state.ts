/**
 * 창 하나가 함께 보는 계정의 장기기억(Rau-0.1)과 문체 학습 진행.
 *
 * 사이드바는 채팅마다 따로 있고 허브는 user-memory·style-learn-* 를 모든 창(소켓)에 보낸다. 그래서 같은
 * 프레임이 사이드바 수만큼 온다 — 이 상태는 창에 하나만 두고, 같은 리비전·같은 학습은 한 번만 받는다.
 * 설정의 Rau 탭, 입력창의 학습 알약, 권유 칩이 모두 이것을 구독한다.
 */
import type {
  SidebarEvent,
  StyleLearnFound,
  StyleLearnStage,
  StyleLearnSummary,
  UserMemorySnapshot,
} from '../../agent/types.ts';

/** 지금 도는 문체 학습. jobId 는 허브가 받아 준 뒤에 생긴다(그 전에는 보낸 요청만 있다). */
export interface StyleLearnRun {
  jobId: string | null;
  requestId: string | null;
  stage: StyleLearnStage | 'starting';
  completed: number;
  total: number;
  file: { index: number; name: string } | null;
  files: string[];
  /** 이 학습에서 지금까지 찾은 규칙 — 허브가 누적해 보낸다. */
  found: StyleLearnFound[];
  /** 예전 말투 맞추기 원고를 가져오는 학습. */
  legacy: boolean;
  startedAt: number;
}

export type StyleLearnOutcome =
  | { kind: 'result'; jobId: string; summary: StyleLearnSummary; files: string[]; legacy: boolean; at: number }
  | { kind: 'error'; jobId: string | null; code: string; message: string; legacy: boolean; at: number };

export interface RauMemoryState {
  memory: UserMemorySnapshot | null;
  run: StyleLearnRun | null;
  /** 마지막으로 끝난 학습. 사용자가 닫으면 null. */
  outcome: StyleLearnOutcome | null;
}

export type RauMemoryListener = (state: RauMemoryState) => void;

export interface RauMemoryStore {
  state(): RauMemoryState;
  subscribe(listener: RauMemoryListener): () => void;
  /** 사이드바가 받은 이벤트를 넘긴다. 관계없는 이벤트는 무시한다. */
  accept(event: SidebarEvent): void;
  /** 보낸 요청을 곧바로 진행으로 보인다 — 허브의 첫 답을 기다리지 않는다. */
  begin(requestId: string, files: string[], options?: { legacy?: boolean }): void;
  /** 보내지 못했거나 허브가 받기 전에 거절했다. */
  fail(requestId: string | null, code: string, message?: string): void;
  dismissOutcome(): void;
}

/** 허브가 받아 주지 않은 채로 이만큼 지나면 보낸 요청을 버린다(답을 잃은 경우). */
const STARTING_TIMEOUT_MS = 30_000;

export function createRauMemoryStore(now: () => number = () => Date.now()): RauMemoryStore {
  let current: RauMemoryState = { memory: null, run: null, outcome: null };
  /** 이미 결과·오류를 받은 학습 — 다른 창(소켓)으로 같은 프레임이 다시 와도 한 번만 받는다. */
  const settled = new Set<string>();
  const listeners = new Set<RauMemoryListener>();
  /** 보낸 요청이 jobId 를 받지 못한 채 남지 않게 거두는 시계. */
  let startTimer = 0;

  function clearStartTimer(): void {
    if (startTimer) window.clearTimeout(startTimer);
    startTimer = 0;
  }

  function set(next: Partial<RauMemoryState>): void {
    current = { ...current, ...next };
    // 진행이 jobId 를 받았거나 끝났으면 보낸 요청의 시계는 할 일이 없다.
    if (!current.run || current.run.jobId) clearStartTimer();
    for (const listener of [...listeners]) listener(current);
  }

  function acceptMemory(memory: UserMemorySnapshot): void {
    const known = current.memory;
    // 쓸 수 있음이 바뀌어도(요금제·크레딧) 리비전은 그대로다 — 같거나 새 리비전이면 받는다.
    if (known && memory.revision < known.revision) return;
    if (known && memory.revision === known.revision && memory.availability === known.availability
      && memory.available === known.available && (memory.legacy?.files ?? 0) === (known.legacy?.files ?? 0)) return;
    set({ memory });
  }

  /** 이 프레임이 지금 학습의 것인가. jobId 가 아직 없으면 requestId 로 맞춘다. */
  function ours(jobId: string | null | undefined, requestId: string | null | undefined): boolean {
    const run = current.run;
    if (!run) return false;
    if (jobId && run.jobId) return jobId === run.jobId;
    return Boolean(requestId && run.requestId && requestId === run.requestId);
  }

  function runFor(jobId: string, requestId: string | null): StyleLearnRun {
    const run = current.run;
    if (run && (run.jobId === jobId || (!run.jobId && (!requestId || run.requestId === requestId)))) {
      return { ...run, jobId };
    }
    // 다른 창이 시작한 학습이거나 다시 연 창 — 처음 보는 일이다.
    return {
      jobId, requestId, stage: 'reading', completed: 0, total: 0, file: null, files: [], found: [],
      legacy: false, startedAt: now(),
    };
  }

  function expireStarting(): void {
    const run = current.run;
    if (run && !run.jobId && now() - run.startedAt > STARTING_TIMEOUT_MS) set({ run: null });
  }

  return {
    state: () => current,
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    accept(event) {
      switch (event.type) {
        case 'user-memory':
          acceptMemory(event.memory);
          return;
        case 'style-learn-status': {
          const job = event.job;
          if (!job) {
            expireStarting();
            // 끝난 학습의 결과는 status 보다 먼저 온다. 결과를 잃었으면(연결이 끊겼던 사이) 진행만 거둔다.
            if (current.run?.jobId) set({ run: null });
            return;
          }
          if (settled.has(job.jobId)) return;
          const base = runFor(job.jobId, event.requestId ?? null);
          set({
            run: {
              ...base,
              stage: job.stage,
              completed: job.completed,
              total: job.total,
              files: job.files.length ? job.files : base.files,
              found: job.found.length >= base.found.length ? job.found : base.found,
              startedAt: Number.isFinite(Date.parse(job.startedAt)) ? Date.parse(job.startedAt) : base.startedAt,
            },
            ...(current.run?.jobId === job.jobId ? {} : { outcome: null }),
          });
          return;
        }
        case 'style-learn-progress': {
          if (settled.has(event.jobId)) return;
          const fresh = current.run?.jobId !== event.jobId;
          const base = runFor(event.jobId, event.requestId || null);
          set({
            run: {
              ...base,
              stage: event.stage,
              completed: event.completed,
              total: event.total,
              file: event.file ?? (event.stage === base.stage ? base.file : null),
              found: event.found && event.found.length >= base.found.length ? event.found : base.found,
            },
            ...(fresh ? { outcome: null } : {}),
          });
          return;
        }
        case 'style-learn-result': {
          if (settled.has(event.jobId)) return;
          settled.add(event.jobId);
          const run = current.run;
          const mine = run && (run.jobId === event.jobId || (!run.jobId && run.requestId === event.requestId));
          acceptMemory(event.memory);
          set({
            run: mine || run?.jobId === event.jobId ? null : run,
            outcome: {
              kind: 'result', jobId: event.jobId, summary: event.summary,
              files: mine ? run!.files : [], legacy: mine ? run!.legacy : false, at: now(),
            },
          });
          return;
        }
        case 'style-learn-error': {
          if (event.jobId && settled.has(event.jobId)) return;
          if (!ours(event.jobId, event.requestId)) return;
          if (event.jobId) settled.add(event.jobId);
          const legacy = current.run?.legacy === true;
          set({
            run: null,
            outcome: { kind: 'error', jobId: event.jobId ?? null, code: event.code, message: event.message, legacy, at: now() },
          });
          return;
        }
        default:
      }
    },
    begin(requestId, files, options = {}) {
      set({
        run: {
          jobId: null, requestId, stage: 'starting', completed: 0, total: files.length, file: null, files,
          found: [], legacy: options.legacy === true, startedAt: now(),
        },
        outcome: null,
      });
      // 보낸 뒤 허브가 받기 전에 연결이 끊기면 아무 프레임도 이 요청을 거두지 않는다(다시 붙을 때의
      // status null 은 너무 일러 expireStarting 이 거르지 못한다). 그래서 따로 시계를 둔다.
      clearStartTimer();
      startTimer = window.setTimeout(() => {
        startTimer = 0;
        const run = current.run;
        if (run && !run.jobId && run.requestId === requestId) {
          set({ run: null, outcome: { kind: 'error', jobId: null, code: 'RAU_UNAVAILABLE', message: '', legacy: run.legacy, at: now() } });
        }
      }, STARTING_TIMEOUT_MS);
    },
    fail(requestId, code, message = '') {
      if (requestId !== null && !ours(null, requestId)) return;
      const legacy = current.run?.legacy === true;
      set({ run: null, outcome: { kind: 'error', jobId: null, code, message, legacy, at: now() } });
    },
    dismissOutcome() {
      if (current.outcome) set({ outcome: null });
    },
  };
}

let windowStore: RauMemoryStore | null = null;

/** 창 하나의 장기기억 상태. 사이드바들이 함께 쓴다. */
export function sharedRauMemoryStore(): RauMemoryStore {
  windowStore ??= createRauMemoryStore();
  return windowStore;
}

/** 미리보기·테스트가 새 창처럼 시작할 때. */
export function resetSharedRauMemoryStore(): void {
  windowStore = null;
}

/** 진행 막대 0..1 — 읽기 0–25%, 찾기 25–90%, 합치기 90–100%. */
export function styleLearnFraction(run: Pick<StyleLearnRun, 'stage' | 'completed' | 'total'>): number {
  const part = run.total > 0 ? Math.max(0, Math.min(1, run.completed / run.total)) : 0;
  switch (run.stage) {
    case 'starting': return 0.02;
    case 'reading': return 0.02 + 0.23 * part;
    case 'extracting': return 0.25 + 0.65 * part;
    case 'merging': return 0.9 + 0.1 * part;
    default: return 0;
  }
}

/**
 * 학습 오류를 사용자 말로 — 허브의 영문 message 는 보이지 않는다. legacy 는 이전 원고 가져오기라 사용자가
 * 고른 파일이 없다 — 허브는 가져올 것이 없으면 INVALID_FILES, 읽을 글이 없으면 NO_TEXT 를 보낸다.
 */
export function styleLearnErrorMessage(code: string, options: { legacy?: boolean } = {}): string {
  if (options.legacy) {
    if (code === 'INVALID_FILES') return '가져올 이전 원고가 없어요.';
    if (code === 'NO_TEXT') return '이전 원고에서 읽을 수 있는 글을 찾지 못했어요.';
  }
  switch (code) {
    case 'RAU_PLAN_REQUIRED': return '문체 학습은 Rau 요금제에서 쓸 수 있어요.';
    case 'RAU_CREDITS_EXHAUSTED': return '이번 달 Rau 크레딧을 다 써서 지금은 배울 수 없어요. 장기기억은 그대로 보고 고칠 수 있어요.';
    case 'RAU_UNAVAILABLE': return '지금 Rau 에 닿지 않아요. 잠시 뒤에 다시 올려 주세요.';
    case 'LEARN_BUSY': return '다른 창에서 문체 학습이 돌고 있어요. 끝난 뒤에 올려 주세요.';
    case 'NO_TEXT': return '올린 파일에서 읽을 수 있는 글을 찾지 못했어요.';
    case 'CANCELLED': return '문체 학습을 멈췄어요. 장기기억은 바뀌지 않았어요.';
    case 'INVALID_FILES': return '올릴 파일을 읽지 못했어요. 파일을 다시 골라 주세요.';
    case 'FILE_TOO_LARGE': return '파일 하나는 20MB 까지 올릴 수 있어요.';
    case 'FILES_TOO_LARGE': return '한 번에 50MB, 20개까지 올릴 수 있어요.';
    case 'UNSUPPORTED_FILE': return 'txt, md, pdf, docx, rtf, html, csv, hwp, hwpx 파일만 배울 수 있어요.';
    case 'OFFLINE': return '허브에 연결되지 않아 올리지 못했어요.';
    default: return '문체 학습을 마치지 못했어요. 잠시 뒤에 다시 올려 주세요.';
  }
}

/** user-memory-result 의 오류를 사용자 말로. */
export function userMemoryErrorMessage(code: string): string {
  switch (code) {
    case 'USER_MEMORY_UNDO_STALE': return '그새 다시 바뀌어 되돌릴 수 없어요.';
    case 'USER_MEMORY_NOT_FOUND': return '그 장기기억은 이미 없어요.';
    case 'USER_MEMORY_SUBJECT_TAKEN': return '같은 내용의 장기기억이 이미 있어요.';
    case 'USER_MEMORY_INVALID': return '한 줄로, 300자 안에서 적어 주세요.';
    case 'OFFLINE': return '허브에 연결되지 않아 저장하지 못했어요.';
    default: return '장기기억을 저장하지 못했어요. 잠시 뒤에 다시 해 주세요.';
  }
}
