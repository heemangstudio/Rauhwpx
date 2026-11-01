// 계정 화면의 글과 판단. DOM 없이 시험할 수 있게 따로 둔다.
import type { AccountLicense, AccountPlan, AccountRau, AccountStatus, AccountTrial } from './account-types.ts';

const DAY_MS = 86_400_000;

export const ACCOUNT_TIER_LABEL: Record<AccountPlan['tier'], string> = { free: '무료', hama: 'Hama', rau: 'Rau' };
const CYCLE_LABEL: Record<NonNullable<AccountPlan['plan']>, string> = { monthly: '월간', annual: '연간', lifetime: '평생' };
const EDITION_LABEL: Record<NonNullable<AccountLicense['edition']>, string> = { hama: 'Hama', rau: 'Rau', signature: 'Signature' };
const LICENSE_STATUS_LABEL: Record<AccountLicense['status'], string> = { active: '', past_due: '결제 실패', expired: '만료', revoked: '해지' };

/** 서버가 한국 시간 하루 끝까지로 정하므로 한국 시간으로 보인다. 예: 2026년 11월 30일 */
export function formatAccountDate(ms: number): string {
  return new Intl.DateTimeFormat('ko-KR', { dateStyle: 'long', timeZone: 'Asia/Seoul' }).format(new Date(ms));
}

/** 예: 11월 30일 */
export function formatShortDate(ms: number): string {
  return new Intl.DateTimeFormat('ko-KR', { month: 'long', day: 'numeric', timeZone: 'Asia/Seoul' }).format(new Date(ms));
}

/** 마지막 접속. 한 달 안은 '3일 전'처럼, 그 뒤는 날짜. */
export function formatLastSeen(ms: number, now = Date.now()): string {
  const elapsed = Math.max(0, now - ms);
  if (elapsed < 60_000) return '방금';
  const rtf = new Intl.RelativeTimeFormat('ko', { numeric: 'auto' });
  if (elapsed < 3_600_000) return rtf.format(-Math.floor(elapsed / 60_000), 'minute');
  if (elapsed < DAY_MS) return rtf.format(-Math.floor(elapsed / 3_600_000), 'hour');
  if (elapsed < 30 * DAY_MS) return rtf.format(-Math.floor(elapsed / DAY_MS), 'day');
  return formatAccountDate(ms);
}

export function platformLabel(platform: string): string {
  if (platform === 'darwin') return 'macOS';
  if (platform === 'win32') return 'Windows';
  if (platform === 'linux') return 'Linux';
  return platform || '기기';
}

/** 사진이 없을 때 원 안에 넣을 한 글자. 이름의 첫 글자, 없으면 이메일의 첫 글자. */
export function accountInitial(name: string | null | undefined, email: string | null | undefined): string {
  for (const source of [name, email]) {
    const first = [...(source ?? '').trim()][0];
    if (first) return first.toLocaleUpperCase('ko-KR');
  }
  return '';
}

/** 보일 이름. 이름이 비면 이메일의 @ 앞. */
export function accountDisplayName(account: { name: string; email: string }): string {
  return account.name.trim() || account.email.split('@')[0]!.trim() || account.email;
}

const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;
export const NAME_MAX = 30;

/** 서버와 같은 규칙: 앞뒤 공백을 뺀 1~30자, 제어 문자 없이. */
export function validateAccountName(raw: string): { ok: true; name: string } | { ok: false; message: string } {
  const name = raw.trim();
  const length = [...name].length;
  if (length < 1 || length > NAME_MAX || CONTROL_CHARS.test(name)) return { ok: false, message: '이름은 1~30자로 적어 주세요.' };
  return { ok: true, name };
}

/** 계정 삭제는 계정 이메일을 그대로 적어야 열린다(대소문자·앞뒤 공백은 보지 않는다). */
export function deleteConfirmMatches(email: string | null | undefined, typed: string): boolean {
  const want = (email ?? '').trim().toLowerCase();
  return want !== '' && typed.trim().toLowerCase() === want;
}

/** Rau 크레딧. 자격이 없거나 값이 없으면 null. */
export interface RauCredits {
  remainingPercent: number;
  resetsAt: number | null;
  trial: boolean;
}

export function rauCredits(rau: AccountRau | null | undefined): RauCredits | null {
  if (!rau?.eligible) return null;
  const percent = rau.remainingPercent;
  if (typeof percent !== 'number' || !Number.isFinite(percent)) return null;
  return {
    remainingPercent: Math.min(100, Math.max(0, percent)),
    resetsAt: typeof rau.resetsAt === 'number' && rau.resetsAt > 0 ? rau.resetsAt : null,
    trial: rau.source === 'trial',
  };
}

/** 예: 65% 남음 */
export function rauCreditsLine(credits: RauCredits): string {
  return `${credits.remainingPercent}% 남음`;
}

/** 크레딧이 다시 차는 날. 체험은 다시 차지 않으므로 빈 글. 예: 11월 30일 초기화 */
export function rauResetLine(credits: RauCredits): string {
  return !credits.trial && credits.resetsAt ? `${formatShortDate(credits.resetsAt)} 초기화` : '';
}

/** 끝나는 때까지 남은 날(올림). 지났으면 0. */
export function daysLeft(endsAt: number, now = Date.now()): number {
  return Math.max(0, Math.ceil((endsAt - now) / DAY_MS));
}

/** 예: 무료 체험 5일 남음 */
export function trialLine(trial: AccountTrial, now = Date.now()): string {
  if (trial.state !== 'active' || !trial.endsAt) return '';
  const left = daysLeft(trial.endsAt, now);
  return left > 0 ? `무료 체험 ${left}일 남음` : '무료 체험 오늘 끝나요';
}

/** 체험을 시작할 수 있는 계정. 이미 Rau 이면 권하지 않는다. */
export function trialAvailable(status: AccountStatus | null): boolean {
  return status?.state === 'signed_in' && status.plan.tier !== 'rau' && status.trial?.state === 'available';
}

/** 체험 단추 글. 예: 7일 무료 체험 */
export function trialButtonLabel(trial: AccountTrial | null | undefined): string {
  return `${trial?.days && trial.days > 0 ? trial.days : 7}일 무료 체험`;
}

/** 요금제 이름 옆의 주기. 무료는 빈 글. */
export function planCycleLabel(plan: AccountPlan): string {
  return plan.tier === 'free' || !plan.plan ? '' : CYCLE_LABEL[plan.plan];
}

/** 샀다가 해지한 구독. 끝나는 날까지 쓰고 갱신되지 않는다. 처음부터 갱신이 없는 선물·프로모션 키는 아니다. */
export function planCancelled(plan: AccountPlan): boolean {
  return plan.tier !== 'free' && plan.autoRenew === false && Boolean(plan.manageUrl) && !plan.paymentFailed;
}

export type PlanCardKind = 'free' | 'monthly' | 'yearly' | 'cancelled' | 'gift' | 'failed' | 'lifetime' | 'trial';

/** 요금제 카드의 그림과 표면을 정하는 상태. 선물·프로모션 키는 처음부터 갱신이 없다. */
export function planCardKind(plan: AccountPlan): PlanCardKind {
  if (plan.tier === 'free') return 'free';
  if (plan.paymentFailed) return 'failed';
  if (plan.rau?.source === 'trial') return 'trial';
  if (plan.plan === 'lifetime') return 'lifetime';
  if (planCancelled(plan)) return 'cancelled';
  if (plan.autoRenew === false) return 'gift';
  return plan.plan === 'annual' ? 'yearly' : 'monthly';
}

/** 갱신일이나 끝나는 날. 평생·무료는 빈 글. */
export function planTermLine(plan: AccountPlan): string {
  if (plan.tier === 'free' || plan.plan === 'lifetime' || !plan.expiresAt) return '';
  return plan.autoRenew === false ? `${formatAccountDate(plan.expiresAt)}까지` : `${formatAccountDate(plan.expiresAt)}에 갱신`;
}

export function paymentFailedLine(plan: AccountPlan): string {
  return plan.paymentGraceEndsAt
    ? `결제가 되지 않았어요. ${formatAccountDate(plan.paymentGraceEndsAt)}까지 결제 수단을 바꿔 주세요.`
    : '결제가 되지 않았어요. 결제 수단을 바꿔 주세요.';
}

/** 라이선스 줄의 설명. 예: Hama · 연간 · 2027년 10월 20일에 갱신 */
export function licenseLine(license: AccountLicense): string {
  const parts = [
    license.tier === 'beta' ? '베타' : license.edition ? EDITION_LABEL[license.edition] : '',
    license.plan ? CYCLE_LABEL[license.plan] : '',
    license.plan !== 'lifetime' && license.expiresAt
      ? (license.status === 'expired' ? `${formatAccountDate(license.expiresAt)} 만료`
        : license.autoRenew === true && license.status !== 'revoked' ? `${formatAccountDate(license.expiresAt)}에 갱신`
        : `${formatAccountDate(license.expiresAt)}까지`)
      : '',
  ];
  return parts.filter(Boolean).join(' · ');
}

export function licenseStatusLabel(license: AccountLicense): string {
  return LICENSE_STATUS_LABEL[license.status];
}

export interface AccountRenewalPrompt {
  kind: 'payment_failed' | 'lapsed';
  id: string;
  title: string;
  detail: string;
  action: string;
}

/**
 * 편집 화면 왼쪽 아래의 연장 안내. 결제가 실패한 구독, 또는 요금제가 무료로 내려앉은 뒤의 끝난 구독.
 * 해당 없으면 null.
 */
export function accountRenewalPrompt(status: AccountStatus | null): AccountRenewalPrompt | null {
  if (status?.state !== 'signed_in') return null;
  const { plan } = status;
  if (plan.tier !== 'free' && plan.paymentFailed) {
    return {
      kind: 'payment_failed',
      id: `payment_failed:${plan.paymentGraceEndsAt ?? ''}`,
      title: '결제가 되지 않았어요',
      detail: plan.paymentGraceEndsAt
        ? `${formatAccountDate(plan.paymentGraceEndsAt)}까지 결제 수단을 바꿔 주세요.`
        : '결제 수단을 바꿔 주세요.',
      action: '결제 수단 바꾸기',
    };
  }
  if (plan.tier !== 'free') return null;
  const lapsed = status.licenses
    .filter((license) => license.status === 'expired' && license.expiresAt && (license.plan === 'monthly' || license.plan === 'annual'))
    .sort((a, b) => (b.expiresAt ?? 0) - (a.expiresAt ?? 0))[0];
  if (!lapsed?.expiresAt) return null;
  const name = lapsed.edition === 'rau' ? 'Rau' : 'Hama';
  return {
    kind: 'lapsed',
    id: `lapsed:${lapsed.keyId}:${lapsed.expiresAt}`,
    title: `${name} 기간이 끝났어요`,
    detail: `${formatAccountDate(lapsed.expiresAt)}에 끝났어요.`,
    action: '구독 관리',
  };
}
