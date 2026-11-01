/**
 * 큰 문서 점진 조판. 문서를 열 때 앞쪽 몇 쪽만 조판해 먼저 그리고(HeemangAdapter.beginFirstPages),
 * 나머지는 첫 화면을 그린 뒤 쉬는 시간에 조금씩 조판한다. 조판하는 동안에도 그린 쪽을 스크롤하고 볼 수 있다.
 * 엔진은 쪽 읽기 밖의 호출(위치 찾기·편집·저장 등)이 오면 남은 조판을 먼저 끝내므로, 언제 끊겨도 결과는 같다.
 */
import type { LayoutProgress } from '../core/heemang-adapter';

/** 첫 화면에 먼저 조판할 쪽 수. 첫 쪽과 스크롤 바로 아래 쪽까지 덮는다. */
export const FIRST_LAYOUT_PAGES = 3;
/** 조각 하나의 목표 시간. 한 프레임(16 ms) 안에 끝나 스크롤·입력이 밀리지 않게 한다. */
const SLICE_BUDGET_MS = 12;
/** 쪽 목록·스크롤 높이를 이 간격보다 자주 다시 맞추지 않는다. */
const VIEW_REFRESH_INTERVAL_MS = 120;
const MIN_SLICE_PAGES = 2;
const MAX_SLICE_PAGES = 64;

/** 점진 조판을 끈다(같은 앱으로 켠 것과 끈 것을 비교하는 측정용). */
export function progressiveLayoutEnabled(): boolean {
  return (globalThis as { __rhwpProgressiveLayout?: boolean }).__rhwpProgressiveLayout !== false;
}

export interface LayoutContinuation {
  /** 조판을 마치거나 멈추면(문서가 바뀌었거나 엔진 오류) 풀린다. 다 조판했으면 true. */
  readonly done: Promise<boolean>;
  /** 남은 조판을 지금 끝낸다(문서를 누르거나 키를 칠 때). */
  finish(): void;
}

/**
 * 남은 쪽을 쉬는 시간마다 SLICE_BUDGET_MS 안팎의 조각으로 조판한다. 다음 조각의 쪽 수는 지난 조각의 쪽당
 * 시간으로 정한다. 다시 그릴 쪽은 모아 두었다가 VIEW_REFRESH_INTERVAL_MS 마다, 그리고 끝날 때 넘긴다.
 */
export function continueLayout(
  layoutMore: (pages: number) => LayoutProgress | null,
  onProgress: (changedPages: number[], complete: boolean) => void,
  laidPages: number,
): LayoutContinuation {
  let settle!: (complete: boolean) => void;
  const done = new Promise<boolean>(resolve => { settle = resolve; });
  let state: 'running' | 'complete' | 'cancelled' = 'running';
  let handle: number | null = null;
  let slicePages = 8;
  let pageCount = laidPages;
  let lastRefresh = performance.now();
  const changed = new Set<number>();

  const flush = (complete: boolean) => {
    lastRefresh = performance.now();
    const pages = [...changed].sort((a, b) => a - b);
    changed.clear();
    try {
      onProgress(pages, complete);
    } catch (error) {
      console.warn('[progressive-layout] 화면 갱신 실패:', error);
    }
  };
  const stop = (next: 'complete' | 'cancelled') => {
    if (state !== 'running') return;
    state = next;
    if (handle !== null) cancelIdle(handle);
    handle = null;
    if (next === 'complete') flush(true);
    settle(next === 'complete');
  };
  /** 조각 하나. 새로 조판한 쪽 수, 끝났거나 조판할 수 없으면 null. */
  const slice = (pages: number): number | null => {
    let progress: LayoutProgress | null;
    try {
      progress = layoutMore(pages);
    } catch (error) {
      console.warn('[progressive-layout] 나머지 쪽 조판 실패:', error);
      progress = null;
    }
    if (!progress) {
      stop('cancelled');
      return null;
    }
    for (const page of progress.changedPages) changed.add(page);
    const laid = progress.pageCount - pageCount;
    pageCount = progress.pageCount;
    if (progress.complete) {
      stop('complete');
      return null;
    }
    return laid;
  };
  const run = (deadline?: IdleDeadline) => {
    handle = null;
    if (state !== 'running') return;
    for (;;) {
      const startedAt = performance.now();
      const laid = slice(slicePages);
      if (laid === null) return;
      const elapsed = Math.max(performance.now() - startedAt, 0.5);
      slicePages = Math.max(MIN_SLICE_PAGES, Math.min(MAX_SLICE_PAGES, Math.floor(SLICE_BUDGET_MS * Math.max(laid, 1) / elapsed)));
      if (performance.now() - lastRefresh >= VIEW_REFRESH_INTERVAL_MS) flush(false);
      // 쉬는 시간이 다음 조각만큼 남았으면 이어 간다. 아니면 프레임을 내준다.
      if (!deadline || deadline.didTimeout || deadline.timeRemaining() < SLICE_BUDGET_MS + 2) break;
    }
    handle = requestIdle(run);
  };
  handle = requestIdle(run);

  return {
    done,
    finish() {
      if (state !== 'running') return;
      slice(0);
    },
  };
}

function requestIdle(run: (deadline?: IdleDeadline) => void): number {
  if (typeof requestIdleCallback === 'function') return requestIdleCallback(run, { timeout: 50 });
  return window.setTimeout(run, 0);
}

function cancelIdle(handle: number): void {
  if (typeof cancelIdleCallback === 'function') cancelIdleCallback(handle);
  else clearTimeout(handle);
}
