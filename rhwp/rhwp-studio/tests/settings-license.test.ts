import assert from 'node:assert/strict';
import test from 'node:test';

import { licenseSummary, msUntilNextTrialMinute, trialTimeLeft, type LicenseStatus } from '../src/ui/agent-sidebar/settings-license.ts';

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

test('trial countdown drops to hours and minutes as the deadline nears', () => {
  assert.equal(trialTimeLeft(NOW + 3 * DAY, NOW), '3일');
  assert.equal(trialTimeLeft(NOW + 2 * DAY + 13 * HOUR + 20 * MINUTE, NOW), '2일 13시간');
  assert.equal(trialTimeLeft(NOW + 13 * HOUR + 42 * MINUTE, NOW), '13시간 42분');
  assert.equal(trialTimeLeft(NOW + 42 * MINUTE - 1000, NOW), '42분');
  assert.equal(trialTimeLeft(NOW + 1000, NOW), '1분');
  assert.equal(trialTimeLeft(NOW - 1000, NOW), '0분');
});

test('the countdown repaints when its displayed minute changes', () => {
  const endsAt = NOW + 13 * HOUR + 42 * MINUTE + 15_000;
  const wait = msUntilNextTrialMinute(endsAt, NOW);
  assert.equal(wait, 15_000);
  assert.notEqual(trialTimeLeft(endsAt, NOW + wait - 1), trialTimeLeft(endsAt, NOW + wait));
  assert.equal(msUntilNextTrialMinute(NOW + 5 * MINUTE, NOW), MINUTE);
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
