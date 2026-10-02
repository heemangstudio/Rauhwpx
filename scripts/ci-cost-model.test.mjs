import test from 'node:test';
import assert from 'node:assert/strict';
import { modelRun } from './ci-cost-model.mjs';

function evidence(overrides = {}) {
  return { id: 1, head_sha: 'a'.repeat(40), conclusion: 'success', jobs: [{
    id: 2, head_sha: 'a'.repeat(40), name: 'gate', labels: ['blacksmith-4vcpu-ubuntu-2404'],
    conclusion: 'success', started_at: '2026-10-01T00:00:00Z', completed_at: '2026-10-01T00:01:01Z',
    ...overrides,
  }] };
}

test('cost model separates duration and unverified rounding scenarios', () => {
  const result = modelRun(evidence());
  assert.equal(result.durationEquivalentUSD, 61 / 60 * 0.008);
  assert.equal(result.roundedMinuteScenarioUSD, 0.016);
  assert.equal(modelRun(evidence({ labels: ['ubuntu-24.04'] })).durationEquivalentUSD, 0);
});

test('skipped jobs contribute no compute despite carrying a runner label', () => {
  assert.equal(modelRun(evidence({ conclusion: 'skipped', completed_at: null })).durationEquivalentUSD, 0);
});

test('cost evidence fails closed on unknown runners, wrong heads, incomplete jobs and bad clocks', () => {
  for (const overrides of [{ labels: ['unknown-paid-runner'] }, { head_sha: 'b'.repeat(40) },
    { conclusion: null }, { completed_at: null }, { completed_at: '2025-01-01T00:00:00Z' }]) {
    assert.throws(() => modelRun(evidence(overrides)));
  }
  assert.throws(() => modelRun({ jobs: [] }));
});
