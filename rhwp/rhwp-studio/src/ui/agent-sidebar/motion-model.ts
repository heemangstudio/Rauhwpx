/* ─── 공용 모션 모델: 임계 감쇠 스프링 ─────────────────────
   사이드바·문서 층·대화 스크롤이 같은 수식을 쓴다. 상태는 위치 x(px)와
   속도 v(px/s)뿐이고, 목표 T 까지의 변위 d = x − T 는 닫힌 꼴로 풀린다.

     d(t) = (A + B·t)·e^(−ω·t),  A = x₀ − T,  B = v₀ + ω·A

   - 중간에 목표가 바뀌면 그 순간의 (x, v) 에서 새 곡선을 시작한다.
     위치와 속도가 모두 이어지므로 되돌리기에서 튀지 않는다.
   - 목표 쪽 속도가 ω·|A| 를 넘으면 목표를 지나친다. 시작 속도를 그 값으로
     묶어 넘침이 수학적으로 생기지 않게 한다.
   - 정지 상태에서 출발하면 목표 쪽으로 launch·ω·|A| 만큼 밀어 준다.
     입력한 프레임부터 움직임이 보이게 하되, 첫 프레임에 몰리지 않는다.
   - 남은 변위가 restDelta(보통 0.5 장치 px) 아래로 떨어지면 끝으로 본다.
     꼬리에서 장치 픽셀 아래로 기어가는 프레임을 없애고 끝값은 정수 목표다. */

import { halfDevicePixel } from '../../core/pixel-snap.ts';

export interface SpringState {
  /** 위치(px) */
  x: number;
  /** 속도(px/s) */
  v: number;
}

export interface SpringConfig {
  /** 고유 진동수(rad/s). 클수록 빨리 안착한다. */
  omega: number;
  /** 정지 상태 출발 때 목표 쪽으로 주는 초기 속도 비율(0–1). 1 이면 순수 지수 감쇠다. */
  launch: number;
  /** 이 변위(px) 안이면 안착으로 본다. */
  restDelta: number;
}

export interface SpringPlan {
  readonly from: number;
  readonly to: number;
  /** 넘침 방지·출발 보정을 거친 실제 시작 속도(px/s) */
  readonly v0: number;
  readonly omega: number;
  /** 안착까지 걸리는 시간(ms). 0 이면 이미 제자리다. */
  readonly durationMs: number;
  at(tMs: number): SpringState;
}

/** 이 속도(px/s) 아래는 정지로 본다 — 부동소수 잔여 속도로 출발 보정이 꺼지지 않게 한다. */
const REST_VELOCITY = 1;
/** 계산이 어긋나도 모션이 이보다 길어지지 않는다. */
const MAX_DURATION_MS = 2000;
/** 표본 간격(ms). 120Hz 화면에서도 선형 보간 오차가 장치 픽셀 아래다. */
export const SAMPLE_STEP_MS = 1000 / 120;
/** 정상 이동의 안착 비율: 이동 거리의 1/2000(480px 의 반 장치 px)이 남으면 토큰 시간에 닿은 것으로 본다. */
const NOMINAL_SETTLE_RATIO = 5e-4;

export function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

/** NaN·무한대를 fallback 으로 바꾸고 [min, max] 로 묶는다. */
export function clampFinite(value: number, min: number, max: number, fallback: number): number {
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  const v = Number.isFinite(value) ? value : fallback;
  return Math.min(hi, Math.max(lo, Number.isFinite(v) ? v : lo));
}

export { halfDevicePixel, sanitizeDpr, snapToDevicePixel } from '../../core/pixel-snap.ts';

/** '300ms'·'0.3s'·'300' 같은 CSS 시간 토큰을 ms 로 읽는다. 못 읽으면 fallback. */
export function parseCssTimeMs(raw: string | null | undefined, fallback: number): number {
  const text = String(raw ?? '').trim().split(',')[0]?.trim() ?? '';
  const value = Number.parseFloat(text);
  if (!Number.isFinite(value) || value < 0) return fallback;
  if (/ms$/i.test(text)) return value;
  if (/s$/i.test(text)) return value * 1000;
  return value;
}

/**
 * 토큰 시간(ms)에 맞춘 스프링 설정. 정상 이동이 durationMs 에 이동 거리의 1/2000 안으로
 * 들어오도록 ω 를 푼다. 20ms 아래(동작 줄이기 1ms 토큰 포함)는 null — 즉시 바꾼다.
 */
export function springForDuration(
  durationMs: number,
  opts: { launch?: number; dpr?: number } = {},
): SpringConfig | null {
  if (!Number.isFinite(durationMs) || durationMs < 20) return null;
  const launch = clampFinite(opts.launch ?? SPRING_LAUNCH, 0, 1, SPRING_LAUNCH);
  const k = settleConstant(launch, NOMINAL_SETTLE_RATIO);
  return {
    omega: k / (durationMs / 1000),
    launch,
    restDelta: halfDevicePixel(opts.dpr),
  };
}

/** 사이드바·시트 공용 출발 보정. 첫 프레임 이동이 약 15% 가 된다. */
export const SPRING_LAUNCH = 0.2;

/** e^(−k)·(1 + k·(1 − c)) = ratio 를 만족하는 k (이분법). */
export function settleConstant(launch: number, ratio: number): number {
  const c = clampFinite(launch, 0, 1, 0);
  const r = clampFinite(ratio, 1e-9, 0.5, 1e-3);
  let lo = 0;
  let hi = 60;
  for (let i = 0; i < 80; i += 1) {
    const mid = (lo + hi) / 2;
    const value = Math.exp(-mid) * (1 + mid * (1 - c));
    if (value > r) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

function sanitizeConfig(config: SpringConfig): SpringConfig {
  return {
    omega: clampFinite(config.omega, 1, 400, 30),
    launch: clampFinite(config.launch, 0, 1, 0),
    restDelta: clampFinite(config.restDelta, 1e-3, 64, 0.25),
  };
}

/**
 * 현재 상태에서 target 으로 가는 곡선을 만든다. 이미 target 근처에 멈춰 있으면
 * durationMs 는 0 이다.
 */
export function planSpring(state: SpringState, target: number, config: SpringConfig): SpringPlan {
  const { omega, launch, restDelta } = sanitizeConfig(config);
  const to = finiteOr(target, 0);
  const from = finiteOr(state.x, to);
  let v0 = finiteOr(state.v, 0);
  const a = from - to;
  const toward = -Math.sign(a);

  // 정지에서 출발하면 목표 쪽으로 살짝 밀어 첫 프레임부터 움직이게 한다.
  if (Math.abs(v0) < REST_VELOCITY && launch > 0) v0 = toward * launch * omega * Math.abs(a);
  // 목표 쪽 속도가 ω·|A| 를 넘으면 목표를 지나친다 — 그 값으로 묶는다.
  const maxToward = omega * Math.abs(a);
  if (toward !== 0 && v0 * toward > maxToward) v0 = toward * maxToward;

  const b = v0 + omega * a;
  const at = (tMs: number): SpringState => {
    const t = Math.max(0, finiteOr(tMs, 0)) / 1000;
    const decay = Math.exp(-omega * t);
    const d = (a + b * t) * decay;
    const v = (b - omega * (a + b * t)) * decay;
    return { x: to + d, v };
  };

  let durationMs = 0;
  if (Math.abs(a) > restDelta || Math.abs(v0) >= REST_VELOCITY) {
    // |d| 는 극값(t* = 1/ω − A/B) 이후 단조 감소한다. 그 뒤로 restDelta 안에 드는 첫 시각.
    const peak = b !== 0 ? Math.max(0, 1 / omega - a / b) * 1000 : 0;
    durationMs = MAX_DURATION_MS;
    for (let t = Math.ceil(peak); t <= MAX_DURATION_MS; t += 1) {
      if (Math.abs(at(t).x - to) <= restDelta) {
        durationMs = t;
        break;
      }
    }
  }

  return { from, to, v0, omega, durationMs, at };
}

/** 곡선 위 한 시각의 상태. 끝 이후는 정확히 목표에서 멈춘다. */
export function springStateAt(plan: SpringPlan, tMs: number): SpringState {
  const t = finiteOr(tMs, 0);
  if (plan.durationMs <= 0 || t >= plan.durationMs) return { x: plan.to, v: 0 };
  return plan.at(t);
}

/** WAAPI 키프레임용 표본. 첫 값은 시작 위치, 끝 값은 정확히 목표다. */
export function sampleSpring(
  plan: SpringPlan,
  stepMs = SAMPLE_STEP_MS,
): Array<{ offset: number; value: number }> {
  const duration = plan.durationMs;
  if (duration <= 0) return [{ offset: 0, value: plan.to }, { offset: 1, value: plan.to }];
  const step = clampFinite(stepMs, 1, 100, SAMPLE_STEP_MS);
  const out: Array<{ offset: number; value: number }> = [];
  for (let t = 0; t < duration; t += step) {
    out.push({ offset: t / duration, value: plan.at(t).x });
  }
  out.push({ offset: 1, value: plan.to });
  return out;
}

/**
 * 프레임마다 움직이는 목표를 따라갈 때 dt 만큼 정확히 적분한다(닫힌 꼴이라 dt 가 커도
 * 안정). 목표가 매 프레임 바뀌어도 위치·속도가 이어진다.
 */
export function stepSpring(
  state: SpringState,
  target: number,
  dtMs: number,
  config: SpringConfig,
): SpringState & { settled: boolean } {
  const cfg = sanitizeConfig(config);
  const plan = planSpring(state, target, { ...cfg, launch: 0 });
  const dt = clampFinite(dtMs, 0, 100, 1000 / 60);
  if (plan.durationMs <= 0 || dt >= plan.durationMs) return { x: plan.to, v: 0, settled: true };
  const next = plan.at(dt);
  return { ...next, settled: false };
}

/**
 * CSS `linear()` 로 쓸 정규화 곡선(0→1). 정지 출발 + launch 보정 곡선을 points 개로 나눈다.
 * motion.css 의 --ag-spring-edge 가 이 함수의 출력이다.
 */
export function springEasingPoints(launch = SPRING_LAUNCH, points = 16): Array<[number, number]> {
  const c = clampFinite(launch, 0, 1, SPRING_LAUNCH);
  const k = settleConstant(c, NOMINAL_SETTLE_RATIO);
  const n = Math.max(4, Math.min(64, Math.round(points)));
  const out: Array<[number, number]> = [];
  for (let i = 0; i <= n; i += 1) {
    // 앞쪽이 가파르니 표본을 앞에 몰아 둔다(τ = (i/n)^1.6).
    const tau = i === n ? 1 : (i / n) ** 1.6;
    const p = i === n ? 1 : 1 - Math.exp(-k * tau) * (1 + k * (1 - c) * tau);
    out.push([tau, p]);
  }
  return out;
}

export function springEasingCss(launch = SPRING_LAUNCH, points = 16): string {
  const parts = springEasingPoints(launch, points).map(([tau, p], i, all) => {
    const value = Number(p.toFixed(4));
    if (i === 0 || i === all.length - 1) return String(value);
    return `${value} ${Number((tau * 100).toFixed(2))}%`;
  });
  return `linear(${parts.join(', ')})`;
}
