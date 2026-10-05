import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clampFinite,
  parseCssTimeMs,
  planSpring,
  sampleSpring,
  snapToDevicePixel,
  springForDuration,
  springStateAt,
  stepSpring,
} from '../src/ui/agent-sidebar/motion-model.ts';

const FRAME = 1000 / 60;
const config = springForDuration(320, { dpr: 2 })!;

function frames(plan: ReturnType<typeof planSpring>): number[] {
  const out: number[] = [];
  for (let t = 0; t <= plan.durationMs + FRAME; t += FRAME) out.push(springStateAt(plan, t).x);
  return out;
}

test('정지에서 출발한 사이드바 스프링은 첫 프레임부터 움직이고, 넘치지 않고, 토큰 시간 안에 정확히 멈춘다', () => {
  const plan = planSpring({ x: 0, v: 0 }, 480, config);
  const xs = frames(plan);
  const firstShare = xs[1] / 480;
  assert.ok(firstShare > 0.08 && firstShare < 0.25, `첫 프레임 비율 ${firstShare}`);
  assert.ok(xs.every((x) => x <= 480 + 1e-9), '목표를 지나치지 않는다');
  for (let i = 1; i < xs.length; i += 1) assert.ok(xs[i] >= xs[i - 1] - 1e-9, '단조 증가');
  assert.ok(plan.durationMs > 200 && plan.durationMs <= 340, `안착 ${plan.durationMs}ms`);
  assert.deepEqual(springStateAt(plan, plan.durationMs), { x: 480, v: 0 });
  // 꼬리: 반 장치 픽셀 아래로 기어가는 프레임은 끝의 몇 프레임뿐이다.
  const creep = xs.slice(1).filter((x, i) => x < 480 && Math.abs(x - xs[i]) * 2 < 1).length;
  assert.ok(creep <= 5, `기어가는 프레임 ${creep}`);
});

test('도중에 되돌리면 위치와 속도가 그대로 이어진다', () => {
  const opening = planSpring({ x: 0, v: 0 }, 480, config);
  const mid = springStateAt(opening, 90);
  assert.ok(mid.v > 0);
  const closing = planSpring(mid, 0, config);
  // 되돌린 순간의 위치·속도가 같다(출발 보정은 정지 상태에서만 걸린다).
  assert.equal(closing.from, mid.x);
  assert.equal(closing.v0, mid.v);
  const at0 = closing.at(0);
  assert.ok(Math.abs(at0.x - mid.x) < 1e-9);
  assert.ok(Math.abs(at0.v - mid.v) < 1e-6);
  // 한 프레임 이동이 원래 곡선의 최대 한 프레임 이동보다 크지 않다(튀지 않음).
  const openFrames = frames(opening);
  const maxOpenStep = Math.max(...openFrames.slice(1).map((x, i) => Math.abs(x - openFrames[i])));
  const firstBack = Math.abs(closing.at(FRAME).x - mid.x);
  assert.ok(firstBack < maxOpenStep, `되돌린 첫 프레임 ${firstBack} < ${maxOpenStep}`);
  // 되돌린 뒤에도 0 아래로 넘치지 않는다.
  assert.ok(frames(closing).every((x) => x >= -1e-9));
});

test('목표 쪽으로 너무 빠른 속도는 넘침이 없도록 묶인다', () => {
  const plan = planSpring({ x: 0, v: 50_000 }, 100, config);
  assert.ok(plan.v0 <= config.omega * 100 + 1e-9);
  assert.ok(frames(plan).every((x) => x <= 100 + 1e-9));
});

test('NaN·무한대 입력은 안전한 값으로 바뀐다', () => {
  const plan = planSpring({ x: Number.NaN, v: Number.POSITIVE_INFINITY }, 200, config);
  assert.equal(plan.durationMs, 0);
  assert.deepEqual(springStateAt(plan, 16), { x: 200, v: 0 });
  const wild = planSpring({ x: 0, v: 0 }, 300, { omega: Number.NaN, launch: 9, restDelta: -1 });
  assert.ok(Number.isFinite(wild.durationMs) && wild.durationMs > 0);
  assert.ok(frames(wild).every(Number.isFinite));
  assert.equal(clampFinite(Number.NaN, 0, 10, 4), 4);
  assert.equal(clampFinite(99, 10, 0, 4), 10);
});

test('0 에 가까운 시간(동작 줄이기)은 스프링 없이 즉시 바꾼다', () => {
  assert.equal(springForDuration(1), null);
  assert.equal(springForDuration(0), null);
  assert.equal(springForDuration(Number.NaN), null);
  assert.equal(parseCssTimeMs(' 1ms', 320), 1);
  assert.equal(parseCssTimeMs('0.32s', 0), 320);
  assert.equal(parseCssTimeMs('', 320), 320);
  assert.equal(parseCssTimeMs('bogus', 180), 180);
});

test('제자리에 있으면 모션이 없다', () => {
  const plan = planSpring({ x: 480, v: 0 }, 480.1, config);
  assert.equal(plan.durationMs, 0);
});

test('표본은 시작 위치에서 시작해 정확히 목표에서 끝난다', () => {
  const plan = planSpring({ x: 480, v: 0 }, 0, config);
  const samples = sampleSpring(plan);
  assert.equal(samples[0].offset, 0);
  assert.equal(samples[0].value, 480);
  assert.deepEqual(samples.at(-1), { offset: 1, value: 0 });
  for (let i = 1; i < samples.length; i += 1) assert.ok(samples[i].offset > samples[i - 1].offset);
});

test('움직이는 목표를 따라가는 적분은 목표가 바뀌어도 이어지고 결국 멈춘다', () => {
  let state = { x: 0, v: 0 };
  let target = 100;
  let settled = false;
  for (let frame = 0; frame < 200 && !settled; frame += 1) {
    if (frame === 5) target = 180;
    const next = stepSpring(state, target, FRAME, config);
    // 한 프레임 안에서 목표를 지나치지 않는다.
    assert.ok(next.x <= target + 1e-9);
    state = next;
    settled = next.settled;
  }
  assert.ok(settled);
  assert.equal(state.x, 180);
});

test('장치 픽셀 맞춤', () => {
  assert.equal(snapToDevicePixel(93.140625, 2), 93);
  assert.equal(snapToDevicePixel(93.3, 2), 93.5);
  assert.equal(snapToDevicePixel(10.4, 1), 10);
  assert.equal(snapToDevicePixel(Number.NaN, 2), 0);
  assert.equal(snapToDevicePixel(-0.1, 2), 0);
  assert.equal(snapToDevicePixel(7.3, Number.NaN), 7);
  assert.equal(snapToDevicePixel(7.3, 0), 7);
});
