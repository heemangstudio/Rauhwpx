/**
 * 기억의 강도(1–5)를 보이는 작은 물그릇. 물이 차오른 높이가 강도이고, 옆에 숫자를 함께 쓴다.
 *
 * 하마가 사는 물을 그대로 빌렸다 — 보강되면 물이 차오르며 +1 이 떠오르고, 감쇄되면 물이 빠진다.
 * 물러난(0) 기억은 빈 그릇에 점선 테두리다. Rau 탭, 문서 기억 시트, 채팅의 배움 구분선이 같은 그릇을 쓴다.
 * 화면 읽기는 그림 대신 aria-label("강도 4/5", 바뀌었으면 "강도 2/5에서 3/5로")을 읽는다.
 */
import './strength-gauge.css';

export const STRENGTH_LEVELS = 5;

export interface StrengthGauge {
  root: HTMLElement;
  readonly value: number;
  /** 강도를 바꾼다. animate 면 물이 차오르거나 빠지고 차이(+1·−1)가 잠깐 떠오른다. */
  set(value: number, options?: { animate?: boolean }): void;
}

export interface StrengthGaugeOptions {
  /** 처음 보일 강도 — 주면 from 에서 value 로 움직인다(0 은 없던 기억). */
  from?: number;
  animate?: boolean;
  size?: 'sm' | 'md';
  /** 물러난 기억처럼 흐리게. */
  muted?: boolean;
  /**
   * from 이 value 와 다르면 숫자 자리에 "2→3" 처럼 처음 강도도 늘 쓴다. 움직임이 없을 때(다시 그림,
   * 움직임 줄이기)에도 보강·감쇄가 새 기억과 구별되게 — 채팅의 배움 구분선과 학습 결과가 쓴다.
   */
  showFrom?: boolean;
}

function clamp(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(STRENGTH_LEVELS, Math.round(value))) : 0;
}

export function strengthLabel(value: number): string {
  return `강도 ${clamp(value)}/${STRENGTH_LEVELS}`;
}

export function strengthChangeLabel(from: number, to: number): string {
  if (from === to) return strengthLabel(to);
  if (from <= 0) return `새 기억, ${strengthLabel(to)}`;
  if (to <= 0) return `강도 ${clamp(from)}/${STRENGTH_LEVELS}에서 물러남`;
  return `강도 ${clamp(from)}/${STRENGTH_LEVELS}에서 ${clamp(to)}/${STRENGTH_LEVELS}로`;
}

function prefersReducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function createStrengthGauge(initial: number, options: StrengthGaugeOptions = {}): StrengthGauge {
  const root = document.createElement('span');
  root.className = 'ag-strength';
  root.dataset.size = options.size ?? 'sm';
  root.setAttribute('role', 'img');
  if (options.muted) root.classList.add('ag-strength-muted');
  const tank = document.createElement('span');
  tank.className = 'ag-strength-tank';
  tank.setAttribute('aria-hidden', 'true');
  const water = document.createElement('span');
  water.className = 'ag-strength-water';
  tank.append(water);
  const num = document.createElement('span');
  num.className = 'ag-strength-num';
  num.setAttribute('aria-hidden', 'true');
  root.append(tank, num);

  let value = clamp(initial);
  let deltaTimer = 0;
  /** showFrom 일 때 숫자 앞에 붙일 처음 강도. set() 으로 바뀌면 지운다. */
  // 없던 기억(0)에서 온 것은 "새로"가 말해 주므로 숫자만 쓴다.
  let shownFrom: number | null = options.showFrom && options.from !== undefined
    && clamp(options.from) > 0 && clamp(options.from) !== value
    ? clamp(options.from)
    : null;

  function paint(level: number): void {
    root.style.setProperty('--level', String(level / STRENGTH_LEVELS));
    root.dataset.strength = String(level);
    root.classList.toggle('ag-strength-empty', level <= 0);
    num.textContent = shownFrom !== null && level === value ? `${shownFrom}→${level}` : String(level);
    root.classList.toggle('ag-strength-with-from', shownFrom !== null && level === value);
  }

  function showDelta(diff: number): void {
    root.querySelector('.ag-strength-delta')?.remove();
    window.clearTimeout(deltaTimer);
    const delta = document.createElement('span');
    delta.className = 'ag-strength-delta';
    delta.setAttribute('aria-hidden', 'true');
    delta.dataset.direction = diff > 0 ? 'up' : 'down';
    delta.textContent = diff > 0 ? `+${diff}` : `−${-diff}`;
    root.append(delta);
    root.classList.remove('ag-strength-rise', 'ag-strength-fall');
    void root.offsetWidth;
    root.classList.add(diff > 0 ? 'ag-strength-rise' : 'ag-strength-fall');
    deltaTimer = window.setTimeout(() => {
      delta.remove();
      root.classList.remove('ag-strength-rise', 'ag-strength-fall');
    }, 1400);
  }

  function move(from: number, to: number, animate: boolean): void {
    root.setAttribute('aria-label', strengthChangeLabel(from, to));
    if (!animate || from === to || prefersReducedMotion()) {
      root.classList.add('ag-strength-still');
      paint(to);
      return;
    }
    root.classList.add('ag-strength-still');
    paint(from);
    // 그린 뒤 다음 그림에서 바꿔야 물높이가 옮겨 간다.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      root.classList.remove('ag-strength-still');
      paint(to);
      showDelta(to - from);
    }));
  }

  const from = options.from === undefined ? value : clamp(options.from);
  move(from, value, options.animate === true);
  if (from === value) root.setAttribute('aria-label', strengthLabel(value));

  return {
    root,
    get value() { return value; },
    set(next, opts = {}) {
      const to = clamp(next);
      const prev = value;
      value = to;
      shownFrom = null;
      move(prev, to, opts.animate !== false);
      if (prev === to) root.setAttribute('aria-label', strengthLabel(to));
    },
  };
}
