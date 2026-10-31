/**
 * 입력창 위의 문체 학습 알약 — 설정 → Rau 가 보이지 않는 동안 학습이 돌면 "문체 학습 중 3/7",
 * 끝나면 잠깐 "문체 학습 끝 새 장기기억 N". 누르면 Rau 탭을 연다. 칩 무리(composerStackNodes)에 들어가
 * 입력창 하마의 자리를 함께 올린다.
 */
import type { RauMemoryState, RauMemoryStore, StyleLearnOutcome } from './rau-memory-state.ts';
import { styleLearnFraction } from './rau-memory-state.ts';

/** 끝난 알림을 보이는 시간. */
const DONE_MS = 6000;

export interface StyleLearnPillDeps {
  store: RauMemoryStore;
  /** 설정 → Rau 를 연다. */
  open(): void;
  /** Rau 탭이 지금 보이는가 — 보이면 알약을 숨긴다(탭의 카드가 같은 것을 보인다). */
  rauTabVisible(): boolean;
}

export interface StyleLearnPill {
  root: HTMLElement;
  /** 탭이 열리거나 닫혔을 때 다시 정한다. */
  sync(): void;
  dispose(): void;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** 진행 줄의 "3/7". 읽기에서는 지금 읽는 파일, 찾기에서는 마친 파일 수. */
export function styleLearnCountLabel(run: RauMemoryState['run']): string {
  // 보내는 중에는 허브가 아직 어느 파일도 읽지 않았다.
  if (!run || run.stage === 'starting') return '';
  if (run.stage === 'merging') return '합치는 중';
  const total = run.stage === 'extracting' ? run.total : (run.files.length || run.total);
  if (!total) return '';
  const index = run.stage === 'extracting' ? run.completed : Math.min(total, run.completed + 1);
  return `${index}/${total}`;
}

function doneLabel(outcome: StyleLearnOutcome): string {
  if (outcome.kind === 'error') return outcome.code === 'CANCELLED' ? '문체 학습 멈춤' : '문체 학습을 마치지 못함';
  const fresh = outcome.summary.new.length;
  const reinforced = outcome.summary.reinforced.length;
  if (fresh) return `문체 학습 끝 새 장기기억 ${fresh}`;
  if (reinforced) return `문체 학습 끝 보강 ${reinforced}`;
  return '문체 학습 끝';
}

export function createStyleLearnPill(deps: StyleLearnPillDeps): StyleLearnPill {
  const root = el('div', 'ag-calibration-chip ag-style-pill');
  root.hidden = true;
  const openButton = el('button', 'ag-calibration-chip-open ag-style-pill-open');
  openButton.type = 'button';
  const hippo = el('span', 'ag-style-pill-hippo');
  hippo.setAttribute('aria-hidden', 'true');
  const text = el('span', 'ag-calibration-chip-text ag-style-pill-text');
  const bar = el('span', 'ag-style-pill-bar');
  bar.setAttribute('aria-hidden', 'true');
  const fill = el('span', 'ag-style-pill-fill');
  bar.append(fill);
  openButton.append(hippo, text, el('span', 'ag-calibration-chip-action', 'Rau 보기'));
  root.append(openButton, bar);
  root.setAttribute('role', 'status');
  openButton.addEventListener('click', () => deps.open());

  /** 탭이 가려진 동안 끝난 학습 — 알약이 잠깐 알린다. */
  let finished: { outcome: StyleLearnOutcome; until: number } | null = null;
  let doneTimer = 0;
  let prev = deps.store.state();

  function render(state: RauMemoryState): void {
    const visibleTab = deps.rauTabVisible();
    const run = state.run;
    if (run && !visibleTab) {
      root.hidden = false;
      root.dataset.state = 'running';
      const count = styleLearnCountLabel(run);
      text.textContent = count ? `문체 학습 중 ${count}` : '문체 학습 중';
      fill.style.transform = `scaleX(${styleLearnFraction(run)})`;
      return;
    }
    if (finished && !visibleTab && performance.now() < finished.until) {
      root.hidden = false;
      root.dataset.state = finished.outcome.kind === 'result' ? 'done' : 'error';
      text.textContent = doneLabel(finished.outcome);
      fill.style.transform = 'scaleX(1)';
      return;
    }
    root.hidden = true;
  }

  const unsubscribe = deps.store.subscribe((state) => {
    if (prev.run && !state.run && state.outcome && !deps.rauTabVisible()) {
      finished = { outcome: state.outcome, until: performance.now() + DONE_MS };
      window.clearTimeout(doneTimer);
      doneTimer = window.setTimeout(() => {
        finished = null;
        render(deps.store.state());
      }, DONE_MS);
    }
    prev = state;
    render(state);
  });
  render(prev);

  return {
    root,
    sync() {
      // 탭을 열어 결과를 봤으면 알림은 끝이다.
      if (deps.rauTabVisible()) finished = null;
      render(deps.store.state());
    },
    dispose() {
      unsubscribe();
      window.clearTimeout(doneTimer);
    },
  };
}
