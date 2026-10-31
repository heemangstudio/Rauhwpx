import assert from 'node:assert/strict';
import test from 'node:test';

import { accountRenewalPrompt, deleteConfirmMatches, validateAccountName } from '../src/ui/account/account-format.ts';
import { createAccountStore, desktopAccountApi, recordAccountActivity, setAccountApi } from '../src/ui/account/account-store.ts';
import type { AccountActivityKind, AccountStatus, DesktopAccountApi } from '../src/ui/account/account-types.ts';
import { AVATAR_MAX_BYTES, AVATAR_SIZE, avatarCrop, encodeAvatar } from '../src/ui/account/avatar-image.ts';

const FREE_PLAN: AccountStatus['plan'] = {
  tier: 'free', edition: null, plan: null, expiresAt: null, autoRenew: null,
  paymentFailed: false, paymentGraceEndsAt: null, manageUrl: null,
};

function signedOut(): AccountStatus {
  return {
    available: true,
    state: 'signed_out',
    providers: ['email', 'google'],
    signIn: null,
    lastError: null,
    deviceChoice: null,
    account: null,
    plan: FREE_PLAN,
    licenses: [],
    devices: [],
    deviceLimit: 5,
    stats: null,
    sync: { lastSyncAt: null, offline: false, error: null },
    localKey: null,
  };
}

function signedIn(avatarRev: number | null = null, plan: Partial<AccountStatus['plan']> = {}): AccountStatus {
  return {
    ...signedOut(),
    state: 'signed_in',
    account: { id: 'acct_1', email: 'a@example.com', name: '가', avatarRev, provider: 'google', createdAt: 0 },
    plan: { ...FREE_PLAN, ...plan },
  };
}

function fakeApi(initial: AccountStatus, avatar: () => Promise<string | null> = async () => null) {
  const listeners = new Set<(status: AccountStatus) => void>();
  const activity: Array<[AccountActivityKind, string]> = [];
  let avatarCalls = 0;
  const api = {
    getStatus: async () => initial,
    onChange(callback: (status: AccountStatus) => void) {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
    getAvatar: () => {
      avatarCalls += 1;
      return avatar();
    },
    recordActivity: (kind: AccountActivityKind, id: string) => { activity.push([kind, id]); },
  } as unknown as DesktopAccountApi;
  return {
    api,
    activity,
    avatarCalls: () => avatarCalls,
    emit: (status: AccountStatus) => { for (const listener of listeners) listener(status); },
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test('without a desktop account API there is no account store state', () => {
  assert.equal(desktopAccountApi({}), null);
  assert.equal(desktopAccountApi({ rhwpDesktop: {} }), null);
  const store = createAccountStore(null);
  assert.equal(store.api, null);
  assert.equal(store.status(), null);
  recordAccountActivity('agent_session', 'chat-1', store);
});

test('a pushed status is not overwritten by a late getStatus answer', async () => {
  const fake = fakeApi(signedOut());
  const store = createAccountStore(fake.api);
  fake.emit(signedIn());
  await settle();
  assert.equal(store.status()?.state, 'signed_in');
  store.dispose();
});

test('the picture is fetched once per avatar revision and dropped on sign-out', async () => {
  let url: string | null = 'data:image/webp;base64,AAAA';
  const fake = fakeApi(signedIn(1), async () => url);
  const store = createAccountStore(fake.api);
  await settle();
  assert.equal(store.avatar(), 'data:image/webp;base64,AAAA');
  fake.emit(signedIn(1));
  await settle();
  assert.equal(fake.avatarCalls(), 1);
  url = 'https://example.com/a.png';
  fake.emit(signedIn(2));
  await settle();
  assert.equal(fake.avatarCalls(), 2);
  assert.equal(store.avatar(), null, 'only data:image URLs are shown');
  fake.emit(signedOut());
  await settle();
  assert.equal(store.avatar(), null);
  store.dispose();
});

test('activity is sent only while signed in and once per id', async () => {
  const fake = fakeApi(signedOut());
  setAccountApi(fake.api);
  const store = createAccountStore(fake.api);
  await settle();
  recordAccountActivity('agent_session', 'chat-1', store);
  assert.deepEqual(fake.activity, [], 'signed-out activity is dropped');
  fake.emit(signedIn());
  recordAccountActivity('agent_session', 'chat-1', store);
  recordAccountActivity('agent_session', 'chat-1', store);
  recordAccountActivity('document_edited', 'chat-1', store);
  recordAccountActivity('document_edited', null, store);
  assert.deepEqual(fake.activity, [['agent_session', 'chat-1'], ['document_edited', 'chat-1']]);
  store.dispose();
  setAccountApi(undefined);
});

test('account deletion opens only for the exact account email', () => {
  assert.equal(deleteConfirmMatches('Jiwoo@Example.com', ' jiwoo@example.com '), true);
  assert.equal(deleteConfirmMatches('jiwoo@example.com', 'jiwoo@example.co'), false);
  assert.equal(deleteConfirmMatches('jiwoo@example.com', ''), false);
  assert.equal(deleteConfirmMatches('', ''), false);
});

test('names follow the server rule of 1 to 30 characters without control characters', () => {
  assert.deepEqual(validateAccountName('  김지우 '), { ok: true, name: '김지우' });
  assert.equal(validateAccountName('   ').ok, false);
  assert.equal(validateAccountName('가'.repeat(31)).ok, false);
  assert.equal(validateAccountName('가'.repeat(30)).ok, true);
  assert.equal(validateAccountName('a\u0007b').ok, false);
});

test('the renewal notice follows the account plan', () => {
  assert.equal(accountRenewalPrompt(signedOut()), null);
  assert.equal(accountRenewalPrompt(signedIn(null, { tier: 'pro' })), null);
  assert.equal(accountRenewalPrompt(signedIn(null, { tier: 'pro', paymentFailed: true }))?.kind, 'payment_failed');
  const lapsed = {
    ...signedIn(),
    licenses: [{
      keyId: 'k1', maskedKey: 'HAMA-…', tier: 'paid' as const, edition: 'hama' as const, plan: 'annual' as const,
      status: 'expired' as const, expiresAt: Date.UTC(2026, 9, 1), autoRenew: false, primary: true,
    }],
  };
  assert.equal(accountRenewalPrompt(lapsed)?.kind, 'lapsed');
  assert.equal(accountRenewalPrompt({ ...lapsed, licenses: [{ ...lapsed.licenses[0]!, plan: 'lifetime' }] }), null);
});

test('the avatar crop takes the centered square and never upscales', () => {
  assert.deepEqual(avatarCrop(4000, 3000), { sx: 500, sy: 0, side: 3000, size: AVATAR_SIZE });
  assert.deepEqual(avatarCrop(300, 900), { sx: 0, sy: 300, side: 300, size: 300 });
  assert.deepEqual(avatarCrop(0, 0), { sx: 0, sy: 0, side: 1, size: 1 });
});

test('the avatar encoder falls back to JPEG and gives up above 1 MiB', async () => {
  const blob = (type: string, size: number) => new Blob([new Uint8Array(size)], { type });
  const asked: string[] = [];
  const jpeg = await encodeAvatar(async (type, quality) => {
    asked.push(`${type}@${quality}`);
    // WebP 를 못 만드는 환경: PNG 가 돌아온다.
    return type === 'image/webp' ? blob('image/png', 10) : blob(type, 2000);
  });
  assert.equal(jpeg?.type, 'image/jpeg');
  assert.equal(jpeg?.bytes.length, 2000);
  assert.equal(asked.filter((entry) => entry.startsWith('image/webp')).length, 3);
  const tooLarge = await encodeAvatar(async (type) => blob(type, AVATAR_MAX_BYTES + 1));
  assert.equal(tooLarge, null);
});
