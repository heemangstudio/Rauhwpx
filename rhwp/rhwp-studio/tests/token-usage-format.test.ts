import test from 'node:test';
import assert from 'node:assert/strict';
import { formatCompact, niceTicks } from '../src/ui/agent-sidebar/token-usage-format.ts';

test('토큰 수는 유효숫자 세 자리로 줄이고 반올림이 넘치면 다음 단위로 올린다', () => {
  assert.equal(formatCompact(77_912_000_000), '77.9B');
  assert.equal(formatCompact(1_268_000_000), '1.27B');
  assert.equal(formatCompact(461_200), '461K');
  assert.equal(formatCompact(2_000_000_000), '2B');
  assert.equal(formatCompact(999_600), '1M');
  assert.equal(formatCompact(980), '980');
  assert.equal(formatCompact(0), '0');
});

test('눈금은 0 에서 시작해 최댓값을 덮는 고른 간격이다', () => {
  assert.deepEqual(niceTicks(5_800_000_000), [0, 2e9, 4e9, 6e9]);
  assert.deepEqual(niceTicks(0), [0, 1]);
  const ticks = niceTicks(37_000);
  assert.equal(ticks[0], 0);
  assert.ok(ticks[ticks.length - 1]! >= 37_000);
  assert.ok(ticks.length >= 3 && ticks.length <= 6);
});

test('손그림 선은 같은 씨앗이면 같은 모양이고 원래 선에서 크게 벗어나지 않는다', async () => {
  const { roughStrokes, wobble, monotoneSamples } = await import('../src/ui/agent-sidebar/token-usage-chart.ts');
  const line = monotoneSamples([[0, 100], [50, 20], [100, 100], [150, 100], [200, 60]], 4);
  assert.deepEqual(roughStrokes(line, 42), roughStrokes(line, 42));
  assert.notEqual(roughStrokes(line, 42)[0], roughStrokes(line, 43)[0]);
  const moved = wobble(line, 7, 1.5);
  for (let i = 0; i < line.length; i++) {
    assert.ok(Math.hypot(moved[i]![0] - line[i]![0], moved[i]![1] - line[i]![1]) <= 1.5 + 1e-9);
  }
});

test('곡선은 0 인 날에 바닥 아래로 내려가거나 봉우리를 넘지 않는다', async () => {
  const { monotoneSamples } = await import('../src/ui/agent-sidebar/token-usage-chart.ts');
  // y 는 화면 좌표: 100 이 바닥, 10 이 봉우리.
  const samples = monotoneSamples([[0, 100], [10, 100], [20, 10], [30, 100], [40, 100]], 1);
  assert.ok(samples.every(([, y]) => y <= 100 + 1e-9 && y >= 10 - 1e-9));
  assert.ok(samples.filter(([x]) => x <= 10).every(([, y]) => Math.abs(y - 100) < 1e-9));
});
