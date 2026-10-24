import assert from 'node:assert/strict';
import test from 'node:test';

import { licenseSummary, msUntilNextTrialTick, renewalPrompt, RENEWAL_PROMPT_TITLE, trialTimeLeft, type LicenseStatus } from '../src/ui/agent-sidebar/settings-license.ts';

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

test('an annual key shows its renewal date, or its end date once auto-renewal is off; a lifetime key shows neither', () => {
  const renewsAt = Date.parse('2027-10-20T23:59:59.999+09:00');
  const licensed = (patch: Partial<NonNullable<LicenseStatus['license']>>) => licenseSummary(status({
    state: 'licensed',
    license: { maskedKey: 'HAMA-…AB12', leaseExpiresAt: NOW, lastCheckAt: NOW, lastError: null, ...patch },
  }), NOW).detail;
  assert.match(licensed({ licenseExpiresAt: renewsAt, autoRenew: true }), /HAMA-…AB12, 다음 갱신 2027년 10월 20일, 마지막 확인/);
  assert.match(licensed({ licenseExpiresAt: renewsAt, autoRenew: false }), /2027년 10월 20일까지/);
  assert.doesNotMatch(licensed({ licenseExpiresAt: null, autoRenew: null }), /갱신|까지/);
  assert.doesNotMatch(licensed({}), /갱신|까지/, 'an older main process sends no expiry');
});

test('an annual key past its date: offline grace stays editable, expired is read-only with renew and deactivate', () => {
  const endedAt = Date.parse('2027-10-20T23:59:59.999+09:00');
  const grace = licenseSummary(status({
    state: 'licensed',
    license: { maskedKey: 'HAMA-…AB12', leaseExpiresAt: NOW, lastCheckAt: NOW, lastError: null, licenseExpiresAt: endedAt, autoRenew: true, graceEndsAt: endedAt + 6 * DAY },
    offline: true,
  }), NOW);
  assert.equal(grace.readOnly, false);
  assert.match(grace.title, /갱신 확인 필요/);
  assert.match(grace.detail, /2027년 10월 20일에 기간이 끝났어요.*2027년 10월 26일까지 쓸 수 있어요/);

  const expired = licenseSummary(status({
    state: 'expired',
    canEdit: false,
    readOnly: true,
    license: { maskedKey: 'HAMA-…AB12', leaseExpiresAt: null, lastCheckAt: NOW, lastError: null, licenseExpiresAt: endedAt, autoRenew: false },
  }), NOW);
  assert.deepEqual([expired.readOnly, expired.showActivate, expired.canDeactivate], [true, true, true]);
  assert.match(expired.detail, /^2027년 10월 20일에 라이선스 기간이 끝났어요/);
});

test('a failed renewal and a lapsed key get the "키 만료, 연장할까요?" prompt; a healthy key gets none', () => {
  const endedAt = Date.parse('2027-10-20T23:59:59.999+09:00');
  const license = { maskedKey: 'HAMA-…AB12', leaseExpiresAt: NOW, lastCheckAt: NOW, lastError: null, licenseExpiresAt: endedAt, autoRenew: true };
  assert.equal(RENEWAL_PROMPT_TITLE, '키 만료, 연장할까요?');
  const failed = status({ state: 'licensed', license: { ...license, paymentFailed: true, paymentGraceEndsAt: endedAt + 10 * DAY, paymentFixUrl: 'https://groble.im/manage/purchase' } });
  const prompt = renewalPrompt(failed);
  assert.equal(prompt?.kind, 'payment_failed');
  assert.match(prompt?.detail ?? '', /2027년 10월 30일까지 결제 수단을 바꿔주세요/);
  assert.equal(prompt?.action, '결제 수단 바꾸기');
  const summary = licenseSummary(failed, NOW);
  assert.deepEqual([summary.title, summary.readOnly], ['키 만료, 연장할까요?', false], 'non-blocking: still editable');

  const lapsed = renewalPrompt(status({ state: 'expired', canEdit: false, readOnly: true, license: { ...license, autoRenew: false } }));
  assert.equal(lapsed?.kind, 'lapsed');
  assert.match(lapsed?.detail ?? '', /^2027년 10월 20일에 기간이 끝나 읽기 전용이에요/);

  assert.equal(renewalPrompt(status({ state: 'licensed', license })), null);
  assert.equal(renewalPrompt(status({ state: 'licensed', license: { ...license, licenseExpiresAt: null, autoRenew: null } })), null);
  assert.equal(renewalPrompt(status({ state: 'trial_expired', canEdit: false, readOnly: true })), null);
});
