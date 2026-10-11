/**
 * 깜빡이지 않는 상태 표시 — 잠깐 지나가는 상태는 400ms 를 넘겨야 보이고,
 * 한 번 보이면 적어도 400ms 는 머문다. 오류·질문·다른 탭 사용 같은 주의
 * 상태는 immediate 로 지연 없이 보이고 풀리는 즉시 걷힌다.
 *
 * DOM 을 모른다. 보일 값이 바뀔 때만 onChange 를 부르고, 이미 보이는 값으로는
 * 다시 부르지 않는다. 타이머는 전환이 걸려 있을 때만 하나 돈다.
 */

export const STATUS_SHOW_DELAY_MS = 400;
export const STATUS_MIN_VISIBLE_MS = 400;

export interface StatusClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): number;
  clearTimeout(id: number): void;
}

export interface DelayedStatus<T> {
  /** 실제 상태. null = 보일 것 없음. since = 상태가 실제로 시작된 시각(기본 지금). 같은 값을 다시 알려도 타이머는 그대로다. */
  set(value: T | null, since?: number): void;
  /** 지금 보이는 값. */
  readonly shown: T | null;
  /** 대상이 바뀌었다(스레드 전환 등) — 보이던 것을 바로 걷고 타이머를 버린다. */
  reset(): void;
  dispose(): void;
}

const browserClock: StatusClock = {
  now: () => performance.now(),
  setTimeout: (fn, ms) => window.setTimeout(fn, ms),
  clearTimeout: (id) => window.clearTimeout(id),
};

export function createDelayedStatus<T>(
  onChange: (shown: T | null) => void,
  opts?: { immediate?: (value: T) => boolean; clock?: StatusClock },
): DelayedStatus<T> {
  const clock = opts?.clock ?? browserClock;
  const immediate = opts?.immediate ?? (() => false);
  let latest: T | null = null;
  let shown: T | null = null;
  let shownAt = 0;
  let timer: number | null = null;
  let disposed = false;

  function clearTimer(): void {
    if (timer === null) return;
    clock.clearTimeout(timer);
    timer = null;
  }

  function schedule(at: number): void {
    clearTimer();
    timer = clock.setTimeout(onTimer, Math.max(0, at - clock.now()));
  }

  function show(value: T | null): void {
    if (Object.is(value, shown)) return;
    if (shown === null && value !== null) shownAt = clock.now();
    shown = value;
    onChange(value);
  }

  /** 예약한 전환이 올 때 — 그 사이에 바뀐 최신 값으로 정한다. */
  function onTimer(): void {
    timer = null;
    if (disposed) return;
    if (shown === null) {
      // 보이기 예약: 그 사이 값이 사라졌으면 아무것도 하지 않는다.
      if (latest !== null) show(latest);
      return;
    }
    // 걷기 예약: 그 사이 값이 돌아왔으면 그 값을 보인다.
    show(latest);
  }

  return {
    set(value, since) {
      if (disposed) return;
      latest = value;
      if (value !== null) {
        if (immediate(value) || shown !== null) {
          // 주의 상태이거나 이미 보이는 중이면 글만 바꾼다. 처음 보인 시각은 그대로 둔다.
          clearTimer();
          show(value);
          return;
        }
        // 보이기를 이미 기다리는 중이면 그 예약을 그대로 둔다 — 반복 알림이 미루지 않는다.
        if (timer !== null) return;
        const startedAt = since ?? clock.now();
        if (clock.now() - startedAt >= STATUS_SHOW_DELAY_MS) show(value);
        else schedule(startedAt + STATUS_SHOW_DELAY_MS);
        return;
      }
      if (shown === null) {
        clearTimer();
        return;
      }
      if (immediate(shown)) {
        clearTimer();
        show(null);
        return;
      }
      // 걷기를 이미 기다리는 중이면 그 예약을 그대로 둔다.
      if (timer !== null) return;
      const hideAt = shownAt + STATUS_MIN_VISIBLE_MS;
      if (clock.now() >= hideAt) show(null);
      else schedule(hideAt);
    },
    get shown() {
      return shown;
    },
    reset() {
      clearTimer();
      latest = null;
      show(null);
    },
    dispose() {
      clearTimer();
      disposed = true;
    },
  };
}

/** 저장된 시작 시각으로 다시 그리는 목록용 — 시작 뒤 400ms 가 지나야 보인다. */
export function revealAfterDelay(since: number, now: number): { revealed: boolean; revealInMs: number } {
  // 다른 탭의 시계가 조금 앞서도 400ms 넘게 기다리지 않는다.
  const revealInMs = Math.min(STATUS_SHOW_DELAY_MS, Math.max(0, since + STATUS_SHOW_DELAY_MS - now));
  return { revealed: revealInMs === 0, revealInMs };
}
