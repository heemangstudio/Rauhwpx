import assert from 'node:assert/strict';
import test from 'node:test';

import { licenseSummary, msUntilNextTrialTick, trialTimeLeft, type LicenseStatus } from '../src/ui/agent-sidebar/settings-license.ts';

const NOW = Date.UTC(2026, 9, 16);
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
function status(patch: Partial<LicenseStatus>): LicenseStatus {
  return {
    state: 'trial',
    canEdit: true,
    readOnly: false,
    trial: { startedAt: NOW - 42 * HOUR, endsAt: NOW + 30 * HOUR, active: true },
    license: null,
    offline: false,
    ...patch,
  };
}

test('trial offers activation and no deactivation', () => {
  const summary = licenseSummary(status({}), NOW);
  assert.equal(summary.readOnly, false);
  assert.equal(summary.showActivate, true);
  assert.equal(summary.canDeactivate, false);
});

test('trial countdown drops to hours and minutes, then seconds in the last hour', () => {
  assert.equal(trialTimeLeft(NOW + 3 * DAY, NOW), '3일');
  assert.equal(trialTimeLeft(NOW + 2 * DAY + 13 * HOUR + 20 * MINUTE, NOW), '2일 13시간');
  assert.equal(trialTimeLeft(NOW + 13 * HOUR + 42 * MINUTE, NOW), '13시간 42분');
  assert.equal(trialTimeLeft(NOW + HOUR, NOW), '1시간');
  assert.equal(trialTimeLeft(NOW + HOUR - 1000, NOW), '59분 59초');
  assert.equal(trialTimeLeft(NOW + 42 * MINUTE + 15_000, NOW), '42분 15초');
  assert.equal(trialTimeLeft(NOW + 9_000, NOW), '9초');
  assert.equal(trialTimeLeft(NOW - 1000, NOW), '0초');
});

test('the countdown repaints exactly when its text changes', () => {
  const cases = [
    NOW + 13 * HOUR + 42 * MINUTE + 15_000,
    NOW + HOUR + 400,
    NOW + 42 * MINUTE + 15_250,
  ];
  for (const endsAt of cases) {
    const wait = msUntilNextTrialTick(endsAt, NOW);
    assert.ok(wait > 0 && wait <= MINUTE);
    assert.equal(trialTimeLeft(endsAt, NOW + wait - 1), trialTimeLeft(endsAt, NOW), String(endsAt - NOW));
    assert.notEqual(trialTimeLeft(endsAt, NOW + wait), trialTimeLeft(endsAt, NOW), String(endsAt - NOW));
  }
  assert.equal(msUntilNextTrialTick(NOW + 42 * MINUTE + 15_250, NOW), 250);
});

test('licensed shows the masked key and offers deactivation', () => {
  const summary = licenseSummary(status({
    state: 'licensed',
    license: { maskedKey: 'HAMA-…AB12', leaseExpiresAt: NOW, lastCheckAt: NOW, lastError: null },
    offline: true,
  }), NOW);
  assert.match(summary.detail, /HAMA-…AB12/);
  assert.match(summary.detail, /오프라인/);
  assert.equal(summary.canDeactivate, true);
  assert.equal(summary.readOnly, false);
});

test('expired, revoked and lapsed states are read-only', () => {
  for (const state of ['trial_expired', 'revoked', 'lease_expired', 'needs_activation'] as const) {
    assert.equal(licenseSummary(status({ state, canEdit: false, readOnly: true }), NOW).readOnly, true, state);
  }
  assert.equal(licenseSummary(status({ state: 'lease_expired', canEdit: false, readOnly: true }), NOW).canDeactivate, true);
});
