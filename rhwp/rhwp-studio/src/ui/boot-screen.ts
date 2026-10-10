/**
 * 부트 화면 닫기.
 *
 * public/boot-screen.js 가 첫 페인트 전에 보일지와 로고(애니메이션·정지)를 정해 window.__rhwpBoot 에
 * 남긴다. 여기서는 편집기가 준비되고 첫 실행 애니메이션이 끝난 뒤 화면을 걷어 낸다.
 * 첫 실행 설정은 afterBootScreen() 뒤에 연다.
 */

export interface BootScreenState {
  mode: 'off' | 'pending' | 'intro' | 'still';
  launchedWithFile: boolean;
  shownAt: number;
  animationMs: number;
  decided: Promise<void>;
}

/** 애니메이션이 끝난 뒤 마지막 프레임(앱 아이콘 자세)을 잠깐 보여 준다. */
export const BOOT_FINAL_HOLD_MS = 350;
const FADE_MS = 240;
const POLL_MS = 100;

function bootState(): BootScreenState | null {
  const state = (window as Window & { __rhwpBoot?: BootScreenState }).__rhwpBoot;
  return state && typeof state === 'object' ? state : null;
}

function bootElement(): HTMLElement | null {
  return document.getElementById('boot-screen');
}

/** 화면을 걷어 내기 전에 더 기다려야 하는 시간. 건너뛰면 mode 가 still 로 바뀌어 0 이 된다. */
export function remainingBootMs(state: Pick<BootScreenState, 'mode' | 'shownAt' | 'animationMs'>, now: number): number {
  if (state.mode !== 'intro') return 0;
  return Math.max(0, state.shownAt + state.animationMs + BOOT_FINAL_HOLD_MS - now);
}

const sleep = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

let resolveDone: () => void = () => {};
const done = new Promise<void>((resolve) => {
  resolveDone = resolve;
});
let dismissing = false;

async function dismiss(): Promise<void> {
  const element = bootElement();
  const state = bootState();
  if (!element || !state || state.mode === 'off') {
    element?.remove();
    resolveDone();
    return;
  }
  await state.decided.catch(() => {});
  for (let wait = remainingBootMs(state, performance.now()); wait > 0;
    wait = remainingBootMs(state, performance.now())) {
    await sleep(Math.min(wait, POLL_MS));
  }
  element.classList.add('boot-screen-leaving');
  const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  await sleep(reducedMotion ? 0 : FADE_MS);
  element.remove();
  resolveDone();
}

/** 편집기 초기화가 끝나면 부른다. 실패해도 부른다 — 오류 화면을 가리면 안 된다. */
export function markStudioReady(): void {
  if (dismissing) return;
  dismissing = true;
  void dismiss();
}

/** 부트 화면이 사라진 뒤 풀린다. 부트 화면이 없는 곳(미리보기·임베드·자동화)에서는 바로 풀린다. */
export function afterBootScreen(): Promise<void> {
  const element = bootElement();
  const state = bootState();
  if (!element || !state || state.mode === 'off') return Promise.resolve();
  return done;
}

/** 첫 실행이 문서를 열면서 시작됐는지. 그러면 설정을 미루고 사이드바 칩으로 권한다. */
export async function bootLaunchedWithFile(): Promise<boolean> {
  const state = bootState();
  if (!state) return false;
  await state.decided.catch(() => {});
  return state.launchedWithFile === true;
}
