import assert from 'node:assert/strict';
import test from 'node:test';

import { licenseSummary, type LicenseStatus } from '../src/ui/agent-sidebar/settings-license.ts';

const NOW = Date.UTC(2026, 9, 16);
function status(patch: Partial<LicenseStatus>): LicenseStatus {
  return {
    state: 'trial',
    canEdit: true,
    readOnly: false,
    trial: { endsAt: NOW + 30 * 60 * 60 * 1000, savesLeft: 2, saveLimit: 3, active: true },
    license: null,
    offline: false,
    ...patch,
  };
}

test('trial shows hours and saves left with a way to buy', () => {
  const summary = licenseSummary(status({}), NOW);
  assert.equal(summary.title, '체험 중');
  assert.match(summary.detail, /30시간 또는 저장 2번/);
  assert.equal(summary.showActivate, true);
  assert.equal(summary.canDeactivate, false);
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
