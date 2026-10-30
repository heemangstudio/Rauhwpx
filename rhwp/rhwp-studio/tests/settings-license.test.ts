import assert from 'node:assert/strict';
import test from 'node:test';

import { licenseSummary, renewalPrompt, RENEWAL_PROMPT_TITLE, type LicenseStatus } from '../src/ui/agent-sidebar/settings-license.ts';

const NOW = Date.UTC(2026, 9, 16);
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
function status(patch: Partial<LicenseStatus>): LicenseStatus {
  return {
    state: 'free',
    paid: false,
    license: null,
    offline: false,
    ...patch,
  };
}

test('a free install offers a key and no deactivation', () => {
  const summary = licenseSummary(status({}));
  assert.equal(summary.showActivate, true);
  assert.equal(summary.canDeactivate, false);
  assert.doesNotMatch(summary.title + summary.detail, /읽기 전용|체험/);
});

test('licensed shows the masked key and offers deactivation', () => {
  const summary = licenseSummary(status({
    state: 'licensed',
    license: { maskedKey: 'HAMA-…AB12', leaseExpiresAt: NOW, lastCheckAt: NOW, lastError: null },
    offline: true,
  }));
  assert.match(summary.detail, /HAMA-…AB12/);
  assert.match(summary.detail, /오프라인/);
  assert.equal(summary.canDeactivate, true);
});

test('license problems never say read-only; a key that cannot be checked can still be deactivated', () => {
  for (const state of ['revoked', 'expired', 'lease_expired', 'needs_activation'] as const) {
    const summary = licenseSummary(status({ state }));
    assert.doesNotMatch(summary.title + summary.detail, /읽기 전용|저장할 수/, state);
  }
  assert.equal(licenseSummary(status({ state: 'lease_expired' })).canDeactivate, true);
});

test('an annual key shows its renewal date, or its end date once auto-renewal is off; a lifetime key shows neither', () => {
  const renewsAt = Date.parse('2027-10-20T23:59:59.999+09:00');
  const licensed = (patch: Partial<NonNullable<LicenseStatus['license']>>) => licenseSummary(status({
    state: 'licensed',
    license: { maskedKey: 'HAMA-…AB12', leaseExpiresAt: NOW, lastCheckAt: NOW, lastError: null, ...patch },
  })).detail;
  assert.match(licensed({ licenseExpiresAt: renewsAt, autoRenew: true }), /HAMA-…AB12, 다음 갱신 2027년 10월 20일, 마지막 확인/);
  assert.match(licensed({ licenseExpiresAt: renewsAt, autoRenew: false }), /2027년 10월 20일까지/);
  assert.doesNotMatch(licensed({ licenseExpiresAt: null, autoRenew: null }), /갱신|까지/);
  assert.doesNotMatch(licensed({}), /갱신|까지/, 'an older main process sends no expiry');
});

test('an annual key past its date: offline grace stays paid, expired offers renew and deactivate', () => {
  const endedAt = Date.parse('2027-10-20T23:59:59.999+09:00');
  const grace = licenseSummary(status({
    state: 'licensed',
    license: { maskedKey: 'HAMA-…AB12', leaseExpiresAt: NOW, lastCheckAt: NOW, lastError: null, licenseExpiresAt: endedAt, autoRenew: true, graceEndsAt: endedAt + 6 * DAY },
    offline: true,
  }));
  assert.match(grace.title, /갱신 확인 필요/);
  assert.match(grace.detail, /2027년 10월 20일에 기간이 끝났어요.*2027년 10월 26일까지 쓸 수 있어요/);

  const expired = licenseSummary(status({
    state: 'expired',
    license: { maskedKey: 'HAMA-…AB12', leaseExpiresAt: null, lastCheckAt: NOW, lastError: null, licenseExpiresAt: endedAt, autoRenew: false },
  }));
  assert.deepEqual([expired.showActivate, expired.canDeactivate], [true, true]);
  assert.match(expired.detail, /^2027년 10월 20일에 Pro 기간이 끝났어요/);
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
  assert.equal(licenseSummary(failed).title, '키 만료, 연장할까요?');

  const lapsed = renewalPrompt(status({ state: 'expired', license: { ...license, autoRenew: false } }));
  assert.equal(lapsed?.kind, 'lapsed');
  assert.match(lapsed?.detail ?? '', /^2027년 10월 20일에 Pro 기간이 끝났어요/);

  assert.equal(renewalPrompt(status({ state: 'licensed', license })), null);
  assert.equal(renewalPrompt(status({ state: 'licensed', license: { ...license, licenseExpiresAt: null, autoRenew: null } })), null);
  assert.equal(renewalPrompt(status({})), null);
});
