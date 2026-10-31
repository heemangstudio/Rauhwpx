/**
 * 데스크톱 계정 API(rhwpDesktop.account)의 미리보기 대역. `?account=` 로 시작 장면을 고른다(없으면 웹처럼 API 없음):
 * signed-out · signing-in · choose-device · free · pro · hama · legacy · payment-failed · offline.
 *
 * 로그인은 브라우저를 열지 않고 1.2초 뒤에 끝난다(이메일에 `limit` 이 들면 기기 고르기, `fail` 이면 실패).
 * `&accountHold=1` 이면 로그인 중에 머문다. 키 등록은 `HAMA-` 키를 받고 `HAMA-FAIL…`(없는 키), `HAMA-ELSE…`
 * (다른 계정의 키)를 거절한다. 주문번호 찾기는 `missing` 을 못 찾는다. 자동 갱신 구독이 켜진 계정은 삭제가
 * subscription_active 로 막힌다. 사진은 1 MiB 를 넘으면 too_large. 바깥 페이지는 열지 않고 보고만 한다.
 */
import type {
  AccountActivityKind,
  AccountDevice,
  AccountLicense,
  AccountLinkResult,
  AccountPlan,
  AccountProfile,
  AccountResult,
  AccountStatus,
  DesktopAccountApi,
} from '../ui/account/account-types.ts';
import type { PlanTier } from '../ui/plan/plan-types.ts';

export const mockAccountScenarios = [
  'signed-out', 'signing-in', 'choose-device', 'free', 'pro', 'hama', 'legacy', 'payment-failed', 'offline',
] as const;
export type MockAccountScenario = (typeof mockAccountScenarios)[number];

const DAY_MS = 86_400_000;
const SIGN_IN_DELAY_MS = 1200;
const ACTION_DELAY_MS = 350;
const MAX_AVATAR_BYTES = 1024 * 1024;

const MESSAGES: Record<string, string> = {
  auth_failed: '로그인하지 못했어요. 다시 시도해 주세요.',
  auth_cancelled: '로그인을 취소했어요.',
  device_not_found: '그 기기는 이미 빠졌어요.',
  grant_invalid: '로그인 시간이 지났어요. 다시 시도해 주세요.',
  invalid_format: '라이선스 키 형식이 아니에요.',
  invalid_key: '라이선스 키를 찾을 수 없어요.',
  key_linked_elsewhere: '다른 계정에 연결된 키예요.',
  order_not_found: '주문을 찾지 못했어요. 주문번호와 Groble 이메일을 확인해 주세요.',
  name_invalid: '이름은 1~30자로 적어 주세요.',
  too_large: '사진이 너무 커요.',
  unsupported_type: 'JPG, PNG, WebP 사진만 쓸 수 있어요.',
  confirm_mismatch: '이메일이 맞지 않아요.',
  subscription_active: '구독이 아직 켜져 있어요. Groble에서 구독을 해지한 뒤 다시 시도해 주세요.',
  sign_in_required: '먼저 로그인해 주세요.',
  already_signed_in: '이미 로그인했어요.',
  invalid: '요청을 처리하지 못했어요.',
};

export function mockAccountScenario(params: URLSearchParams): MockAccountScenario | null {
  const value = params.get('account');
  return mockAccountScenarios.includes(value as MockAccountScenario) ? (value as MockAccountScenario) : null;
}

/** 장면이 정하는 요금제 등급. 로그아웃은 무료. */
export function mockAccountTier(scenario: MockAccountScenario): PlanTier {
  if (scenario === 'hama') return 'hama';
  if (scenario === 'legacy') return 'legacy';
  if (scenario === 'pro' || scenario === 'payment-failed' || scenario === 'offline') return 'pro';
  return 'free';
}

export function mockAccountSignedIn(scenario: MockAccountScenario): boolean {
  return !['signed-out', 'signing-in', 'choose-device'].includes(scenario);
}

/** 미리보기용 사진: 따뜻한 면 위의 단순한 사람 모양(SVG). */
function sampleAvatar(): string {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96">'
    + '<rect width="96" height="96" fill="#d8c6ae"/>'
    + '<circle cx="48" cy="38" r="17" fill="#6f5643"/>'
    + '<path d="M14 96c3-21 17-32 34-32s31 11 34 32z" fill="#3f4b5a"/>'
    + '</svg>';
  return `data:image/svg+xml;base64,${btoa(svg)}`;
}

function bytesToDataUrl(bytes: Uint8Array, type: string): string {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return `data:${type};base64,${btoa(binary)}`;
}

function device(id: string, name: string, platform: string, lastSeenAgo: number, current = false): AccountDevice {
  const now = Date.now();
  return { id, name, platform, appVersion: '2.1.0', addedAt: now - 60 * DAY_MS, lastSeenAt: now - lastSeenAgo, current };
}

function sampleDevices(): AccountDevice[] {
  return [
    device('dev-this', '지우의 MacBook Air', 'darwin', 0, true),
    device('dev-mini', 'Mac mini', 'darwin', 3 * 3_600_000),
    device('dev-office', '사무실 PC', 'win32', 4 * DAY_MS),
  ];
}

function fullDevices(): AccountDevice[] {
  return [
    device('dev-mini', 'Mac mini', 'darwin', 2 * 3_600_000),
    device('dev-office', '사무실 PC', 'win32', 2 * DAY_MS),
    device('dev-home', '집 데스크톱', 'win32', 9 * DAY_MS),
    device('dev-old-mac', '예전 MacBook Pro', 'darwin', 41 * DAY_MS),
    device('dev-lab', '연구실 노트북', 'win32', 17 * DAY_MS),
  ];
}

function planFor(tier: PlanTier, scenario: MockAccountScenario | 'signed-in'): AccountPlan {
  const now = Date.now();
  if (tier === 'free') {
    return { tier, edition: null, plan: null, expiresAt: null, autoRenew: null, paymentFailed: false, paymentGraceEndsAt: null, manageUrl: null };
  }
  if (tier === 'legacy') {
    return { tier, edition: 'signature', plan: 'lifetime', expiresAt: null, autoRenew: null, paymentFailed: false, paymentGraceEndsAt: null, manageUrl: null };
  }
  const failed = scenario === 'payment-failed';
  return {
    tier,
    edition: tier === 'hama' ? 'hama' : 'pro',
    plan: failed ? 'annual' : 'monthly',
    expiresAt: now + (failed ? -2 : 24) * DAY_MS,
    autoRenew: true,
    paymentFailed: failed,
    paymentGraceEndsAt: failed ? now + 5 * DAY_MS : null,
    manageUrl: 'https://groble.im/manage/purchase',
  };
}

function licenseFor(plan: AccountPlan, key = 'HAMA-7KQ2M-•••••-•••••-•••••-H8YJA'): AccountLicense {
  return {
    keyId: `key-${key.slice(-5)}`,
    maskedKey: key,
    tier: 'paid',
    edition: plan.edition,
    plan: plan.plan,
    status: plan.paymentFailed ? 'past_due' : 'active',
    expiresAt: plan.expiresAt,
    autoRenew: plan.autoRenew,
    primary: true,
  };
}

function maskKey(key: string): string {
  const groups = key.toUpperCase().replace(/[^0-9A-Z]/g, '').replace(/^HAMA/, '').match(/.{1,5}/g) ?? [];
  const first = groups[0] ?? 'XXXXX';
  const last = groups[groups.length - 1] ?? 'XXXXX';
  return `HAMA-${first}-•••••-•••••-•••••-${last}`;
}

export interface MockAccount {
  api: DesktopAccountApi;
  status(): AccountStatus;
  setScenario(scenario: MockAccountScenario): void;
  /** 결제가 끝나 요금제가 바뀐 것처럼 등급을 바꾼다(로그인했을 때만). */
  setTier(tier: PlanTier): void;
  readonly activity: Array<{ kind: AccountActivityKind; id: string }>;
  readonly calls: string[];
}

export function createMockAccount(
  scenario: MockAccountScenario | null,
  options: { report: (message: string) => void; hold: boolean },
): MockAccount | null {
  if (!scenario) return null;
  const listeners = new Set<(status: AccountStatus) => void>();
  const activity: MockAccount['activity'] = [];
  const calls: string[] = [];
  let avatarUrl: string | null = null;
  let timer: number | null = null;
  let status: AccountStatus = build(scenario);

  function base(): AccountStatus {
    return {
      available: true,
      state: 'signed_out',
      providers: ['email', 'google'],
      signIn: null,
      lastError: null,
      deviceChoice: null,
      account: null,
      plan: planFor('free', 'signed-out'),
      licenses: [],
      devices: [],
      deviceLimit: 5,
      stats: null,
      sync: { lastSyncAt: null, offline: false, error: null },
      localKey: null,
    };
  }

  function signedIn(tier: PlanTier, from: MockAccountScenario | 'signed-in'): AccountStatus {
    const now = Date.now();
    const plan = planFor(tier, from);
    avatarUrl = tier === 'free' || tier === 'legacy' ? null : sampleAvatar();
    const account: AccountProfile = {
      id: 'acct_0f3a9c21b7d4e58a6c',
      email: 'jiwoo@example.com',
      name: '김지우',
      avatarRev: avatarUrl ? 3 : null,
      provider: 'google',
      createdAt: now - 120 * DAY_MS,
    };
    return {
      ...base(),
      state: 'signed_in',
      account,
      plan,
      licenses: tier === 'free' ? [] : [licenseFor(plan)],
      devices: sampleDevices(),
      stats: {
        agentSessions: tier === 'free' ? 0 : 128,
        documentsEdited: tier === 'free' ? 3 : 46,
        since: account.createdAt,
        hama: tier === 'hama' ? { usedUsd: 6.42, allowanceUsd: 20, periodEndsAt: now + 18 * DAY_MS, calls: 412 } : null,
      },
      sync: { lastSyncAt: now - 60_000, offline: from === 'offline', error: null },
      localKey: tier === 'free' ? { maskedKey: 'HAMA-…2000', state: 'linked_elsewhere' } : null,
    };
  }

  function build(next: MockAccountScenario): AccountStatus {
    avatarUrl = null;
    if (next === 'signed-out') return base();
    if (next === 'signing-in') return { ...base(), state: 'signing_in', signIn: { provider: 'google', startedAt: Date.now() } };
    if (next === 'choose-device') {
      return {
        ...base(),
        state: 'choose_device',
        signIn: { provider: 'google', startedAt: Date.now() },
        deviceChoice: { limit: 5, devices: fullDevices() },
      };
    }
    return signedIn(mockAccountTier(next), next);
  }

  function emit(next: AccountStatus): void {
    status = next;
    for (const listener of [...listeners]) listener(status);
  }

  function clearTimer(): void {
    if (timer !== null) window.clearTimeout(timer);
    timer = null;
  }

  const delay = <T>(value: () => T): Promise<T> => new Promise((resolve) => setTimeout(() => resolve(value()), ACTION_DELAY_MS));
  const ok = (): AccountResult => ({ ok: true, status });
  const fail = (code: string): Extract<AccountResult, { ok: false }> => {
    emit({ ...status, lastError: { code, message: MESSAGES[code] ?? code } });
    return { ok: false, code, message: MESSAGES[code] ?? code, status };
  };
  const signedInOnly = (): Extract<AccountResult, { ok: false }> | null => (status.state === 'signed_in' ? null : fail('sign_in_required'));
  const linked = (alreadyLinked: boolean): AccountLinkResult => ({ ok: true, alreadyLinked, status });

  const api: DesktopAccountApi = {
    getStatus: async () => status,
    onChange(callback) {
      listeners.add(callback);
      return () => { listeners.delete(callback); };
    },
    async signIn(provider, loginHint) {
      calls.push(`signIn:${provider}${loginHint ? `:${loginHint}` : ''}`);
      if (status.state === 'signed_in') return fail('already_signed_in');
      if (!status.providers.includes(provider)) return fail('invalid');
      clearTimer();
      options.report(`Browser sign-in placeholder (${provider})`);
      emit({ ...base(), state: 'signing_in', signIn: { provider, startedAt: Date.now() } });
      if (!options.hold) {
        timer = window.setTimeout(() => {
          timer = null;
          if (loginHint?.includes('fail')) emit({ ...base(), lastError: { code: 'auth_failed', message: MESSAGES.auth_failed! } });
          else if (loginHint?.includes('limit')) {
            emit({ ...status, state: 'choose_device', deviceChoice: { limit: 5, devices: fullDevices() } });
          } else {
            const next = signedIn('pro', 'signed-in');
            emit({ ...next, account: { ...next.account!, provider } });
          }
        }, SIGN_IN_DELAY_MS);
      }
      return ok();
    },
    async cancelSignIn() {
      calls.push('cancelSignIn');
      clearTimer();
      emit({ ...base(), lastError: { code: 'auth_cancelled', message: MESSAGES.auth_cancelled! } });
      return status;
    },
    replaceDevice: (deviceId) => delay(() => {
      calls.push(`replaceDevice:${deviceId}`);
      if (status.state !== 'choose_device') return fail('invalid');
      if (!status.deviceChoice?.devices.some((entry) => entry.id === deviceId)) return fail('device_not_found');
      const next = signedIn('pro', 'signed-in');
      const kept = status.deviceChoice.devices.filter((entry) => entry.id !== deviceId);
      emit({ ...next, devices: [device('dev-this', '지우의 MacBook Air', 'darwin', 0, true), ...kept] });
      return ok();
    }),
    refresh: () => delay(() => ok()),
    signOut: () => delay(() => {
      calls.push('signOut');
      avatarUrl = null;
      emit(base());
      return ok();
    }),
    removeDevice: (deviceId) => delay(() => {
      calls.push(`removeDevice:${deviceId}`);
      const blocked = signedInOnly();
      if (blocked) return blocked;
      const target = status.devices.find((entry) => entry.id === deviceId);
      if (!target) return fail('device_not_found');
      if (target.current) {
        avatarUrl = null;
        emit(base());
      } else emit({ ...status, lastError: null, devices: status.devices.filter((entry) => entry.id !== deviceId) });
      return ok();
    }),
    updateName: (name) => delay(() => {
      calls.push(`updateName:${name}`);
      const blocked = signedInOnly();
      if (blocked) return blocked;
      const trimmed = name.trim();
      if (!trimmed || [...trimmed].length > 30) return fail('name_invalid');
      emit({ ...status, lastError: null, account: { ...status.account!, name: trimmed } });
      return ok();
    }),
    setAvatar: (bytes, type) => delay(() => {
      calls.push(`setAvatar:${type}:${bytes.length}`);
      const blocked = signedInOnly();
      if (blocked) return blocked;
      if (bytes.length > MAX_AVATAR_BYTES) return fail('too_large');
      avatarUrl = bytesToDataUrl(bytes, type);
      emit({ ...status, lastError: null, account: { ...status.account!, avatarRev: (status.account!.avatarRev ?? 0) + 1 } });
      return ok();
    }),
    removeAvatar: () => delay(() => {
      calls.push('removeAvatar');
      const blocked = signedInOnly();
      if (blocked) return blocked;
      avatarUrl = null;
      emit({ ...status, lastError: null, account: { ...status.account!, avatarRev: null } });
      return ok();
    }),
    getAvatar: async () => avatarUrl,
    redeem: (key) => delay(() => {
      calls.push(`redeem:${key}`);
      const blocked = signedInOnly();
      if (blocked) return blocked;
      const normalized = key.trim().toUpperCase();
      if (!/^HAMA-?[0-9A-Z]/.test(normalized)) return fail('invalid_format');
      if (normalized.startsWith('HAMA-FAIL')) return fail('invalid_key');
      if (normalized.startsWith('HAMA-ELSE')) return fail('key_linked_elsewhere');
      const masked = maskKey(normalized);
      if (status.licenses.some((entry) => entry.maskedKey === masked)) return linked(true);
      const plan = status.plan.tier === 'free' ? planFor('pro', 'signed-in') : status.plan;
      const license = { ...licenseFor(planFor('pro', 'signed-in'), masked), primary: status.licenses.length === 0 };
      emit({ ...status, lastError: null, plan, licenses: [...status.licenses, license] });
      options.report('License linked (sample)');
      return linked(false);
    }),
    claim: (orderId, email) => delay(() => {
      calls.push(`claim:${orderId}:${email}`);
      const blocked = signedInOnly();
      if (blocked) return blocked;
      if (orderId.includes('missing') || !email.includes('@')) return fail('order_not_found');
      const plan = status.plan.tier === 'free' ? planFor('pro', 'signed-in') : status.plan;
      const license = { ...licenseFor(planFor('pro', 'signed-in'), 'HAMA-Q8W3E-•••••-•••••-•••••-ORDER'), primary: status.licenses.length === 0 };
      emit({ ...status, lastError: null, plan, licenses: [...status.licenses, license] });
      return linked(false);
    }),
    deleteAccount: (confirm) => delay(() => {
      calls.push(`deleteAccount:${confirm}`);
      const blocked = signedInOnly();
      if (blocked) return blocked;
      if (confirm.trim().toLowerCase() !== status.account!.email.toLowerCase()) return fail('confirm_mismatch');
      const live = status.licenses.some((license) => (license.status === 'active' || license.status === 'past_due') && license.autoRenew === true);
      if (live) return fail('subscription_active');
      avatarUrl = null;
      emit(base());
      options.report('Account deleted (sample)');
      return ok();
    }),
    openManage: async () => { calls.push('openManage'); options.report('Groble buyer page placeholder'); },
    recordActivity(kind, id) {
      activity.push({ kind, id });
    },
  };

  return {
    api,
    status: () => status,
    setScenario(next) {
      clearTimer();
      emit(build(next));
    },
    setTier(tier) {
      if (status.state !== 'signed_in' || status.plan.tier === tier) return;
      const plan = planFor(tier, 'signed-in');
      const licenses = tier === 'free' ? [] : [licenseFor(plan, tier === 'hama' ? 'HAMA-H4M4X-•••••-•••••-•••••-PLAN1' : undefined)];
      emit({ ...status, plan, licenses });
    },
    activity,
    calls,
  };
}
