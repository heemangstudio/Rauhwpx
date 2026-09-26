import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createCloudController,
  normalizeBoatError,
  parseBoatChallenge,
  parseCloudSnapshot,
} from '../src/cloud/desktop-cloud.ts';
import type { BoatSnapshot, CloudSnapshot } from '../src/cloud/types.ts';
import {
  boatCardStatus,
  boatStageRows,
  boatStateAfterAccount,
  createCloudSetupState,
  defaultCloudProfileDraft,
  formatBoatElapsed,
  formatBoatHours,
  formatBoatUserCode,
  reconcileCloudSetupState,
  validateBoatApiKey,
  validateBoatEmail,
  type CloudSetupState,
} from '../src/ui/agent-sidebar/cloud-onboarding-state.ts';

const draft = defaultCloudProfileDraft();
const account = (patch: Partial<BoatSnapshot['account']> = {}): BoatSnapshot['account'] => ({
  connected: true, method: 'api-key', email: null, canStart: true, trial: false, ...patch,
});
const server = (state: NonNullable<BoatSnapshot['server']>['state'], monthHours: number | null = 12.5) => ({
  sandboxId: 'bx_7k2m9q4d', state, machine: 'default' as const, machineLabel: '4 vCPU · 8 GB', region: 'EU' as const,
  monthHours, idleStopMinutes: 30, message: state === 'error' ? 'boat가 VM을 다시 시작하지 못했습니다.' : null,
});

function snapshot(boat: BoatSnapshot | null, boatProfile = false, link: CloudSnapshot['link'] = undefined): CloudSnapshot {
  return {
    revision: 1,
    profileEpoch: 1,
    available: true,
    profile: boatProfile
      ? {
          kind: 'configured', mode: 'self-hosted', connection: 'ready', serviceVersion: '1.2.0', message: null,
          profile: { ...draft, name: 'boat', host: '46.225.12.34', sshUser: 'user', transport: { kind: 'ssh-tunnel' },
            boat: { sandboxId: 'bx_7k2m9q4d', machine: 'default' } },
        }
      : { kind: 'unconfigured' },
    server: { mode: null, preferredMode: 'app-hosted', providers: [], lifecycle: 'idle', message: null },
    lease: { owner: 'local' },
    session: { kind: 'idle' },
    sessions: [],
    queuedMessages: [],
    timeline: null,
    updatedAt: '2026-09-27T00:00:00.000Z',
    ...(link ? { link } : {}),
    boat,
  };
}

test('the server choice offers boat only on a desktop that supports it', () => {
  const connected = snapshot({ account: account(), server: null, setup: null });
  assert.deepEqual(createCloudSetupState(connected, 'manage', { boat: true }).kind, 'choose');
  const chosen = createCloudSetupState(connected, 'manage', { boat: true });
  assert.equal(chosen.kind === 'choose' && chosen.mode, 'boat');
  const older = createCloudSetupState(connected, 'manage');
  assert.equal(older.kind === 'choose' && older.mode, 'app-hosted');
});

test('a connected account goes to billing only when boat says it cannot start', () => {
  assert.equal(boatStateAfterAccount(snapshot({ account: account({ connected: false }), server: null, setup: null }), 'manage', draft).kind, 'boat-connect');
  assert.equal(boatStateAfterAccount(snapshot({ account: account({ canStart: false }), server: null, setup: null }), 'manage', draft).kind, 'boat-billing');
  assert.equal(boatStateAfterAccount(snapshot({ account: account({ canStart: null }), server: null, setup: null }), 'manage', draft).kind, 'boat-confirm');
});

test('billing and sign-in advance from snapshots without a second request', () => {
  const billing: CloudSetupState = { kind: 'boat-billing', draft, intent: 'manage', opened: true, pending: false };
  assert.equal(reconcileCloudSetupState(billing, snapshot({ account: account({ canStart: false }), server: null, setup: null })), billing);
  assert.equal(reconcileCloudSetupState(billing, snapshot({ account: account(), server: null, setup: null })).kind, 'boat-confirm');
  const signin: CloudSetupState = {
    kind: 'boat-signin', draft, intent: 'transfer', email: 'a@b.co', beat: 'code', expired: false, pending: false,
    challenge: { claimId: 'c1', verificationUri: 'https://boat.dev/activate', userCode: '123456', expiresAt: '2026-09-27T01:00:00.000Z', intervalSeconds: 5 },
  };
  assert.equal(reconcileCloudSetupState(signin, snapshot({ account: account({ connected: false }), server: null, setup: null })), signin);
  const next = reconcileCloudSetupState(signin, snapshot({ account: account(), server: null, setup: null }));
  assert.equal(next.kind, 'boat-confirm');
  assert.equal(next.kind === 'boat-confirm' && next.intent, 'transfer');
});

test('setup progress ignores a failure left by an earlier attempt and settles on the new result', () => {
  const startedAt = Date.parse('2026-09-27T10:00:00.000Z');
  const progress: CloudSetupState = { kind: 'boat-progress', draft, intent: 'manage', startedAt };
  const error = { title: 'Cloud 설치를 마치지 못했습니다', guidance: '다시 시도합니다.', detail: 'exit 100' };
  const stale = snapshot({ account: account(), server: null, setup: {
    stage: 'installing', startedAt: '2026-09-27T09:50:00.000Z', detail: null, error, importedProviders: [] } });
  assert.equal(reconcileCloudSetupState(progress, stale), progress);
  const failed = reconcileCloudSetupState(progress, snapshot({ account: account(), server: null, setup: {
    stage: 'installing', startedAt: '2026-09-27T10:00:01.000Z', detail: null, error, importedProviders: [] } }));
  assert.equal(failed.kind, 'boat-failed');
  const ready = reconcileCloudSetupState(progress, snapshot({ account: account(), server: server('running'), setup: {
    stage: 'done', startedAt: '2026-09-27T10:00:01.000Z', detail: null, error: null, importedProviders: ['claude', 'codex'] } }, true));
  assert.deepEqual(ready, { kind: 'boat-ready', intent: 'manage', importedProviders: ['claude', 'codex'] });
});

test('opening setup resumes the boat flow from the snapshot', () => {
  const running = createCloudSetupState(snapshot({ account: account(), server: null, setup: {
    stage: 'pairing', startedAt: '2026-09-27T10:00:00.000Z', detail: null, error: null, importedProviders: [] } }), 'manage');
  assert.equal(running.kind, 'boat-progress');
  const ready = createCloudSetupState(snapshot({ account: account(), server: server('stopped'), setup: null }, true), 'transfer');
  assert.equal(ready.kind, 'boat-ready');
  const forgotten = reconcileCloudSetupState(ready, snapshot({ account: account(), server: null, setup: null }));
  assert.equal(forgotten.kind, 'choose');
});

test('setup stages mark done, active and pending in order', () => {
  assert.deepEqual(boatStageRows('installing').map((row) => row.status), ['done', 'done', 'active', 'pending', 'pending']);
  assert.deepEqual(boatStageRows('done').map((row) => row.status), ['done', 'done', 'done', 'done', 'done']);
  assert.equal(boatStageRows('pairing', 'windows')[3].label, '이 PC 연결');
  assert.equal(boatStageRows('pairing')[3].label, '이 Mac 연결');
});

test('the settings card describes each server state in one line', () => {
  const card = (state: Parameters<typeof server>[0], hours: number | null = 12.5) =>
    boatCardStatus(snapshot({ account: account(), server: server(state, hours), setup: null }, true));
  assert.deepEqual(card('running'), { title: 'boat · EU', detail: '실행 중 · 이번 달 12.5시간', dot: 'connected', pulse: false,
    action: { kind: 'stop', label: '중지', disabled: false }, menu: true });
  assert.equal(card('stopped', 3)?.detail, '정지됨 · 이번 달 3시간');
  assert.equal(card('stopped', null)?.detail, '정지됨');
  assert.deepEqual(card('waking')?.action, { kind: 'wake', label: '시작', disabled: true });
  assert.equal(card('waking')?.pulse, true);
  assert.deepEqual(card('stopping')?.action, { kind: 'stop', label: '중지', disabled: true });
  assert.equal(card('missing')?.detail, '서버를 찾을 수 없습니다');
  assert.equal(card('missing')?.action, null);
  assert.equal(card('error')?.detail, 'boat가 VM을 다시 시작하지 못했습니다.');
  const setup = boatCardStatus(snapshot({ account: account(), server: null, setup: {
    stage: 'installing', startedAt: '2026-09-27T10:00:00.000Z', detail: null, error: null, importedProviders: [] } }));
  assert.equal(setup?.detail, 'Cloud 설치');
  assert.equal(setup?.menu, false);
  assert.equal(boatCardStatus(snapshot({ account: account(), server: null, setup: null })), null);
  const lost = boatCardStatus(snapshot({ account: account(), server: server('running'), setup: null }, true,
    { kind: 'failed', error: 'ECONNRESET', attempt: 1, canRecreate: false }));
  assert.equal(lost?.detail, '연결에 문제가 있습니다');
});

test('boat input and display helpers keep the copy short and exact', () => {
  assert.equal(validateBoatEmail(''), '이메일이 필요합니다.');
  assert.equal(validateBoatEmail('andy@example'), '이메일 형식이 올바르지 않습니다.');
  assert.equal(validateBoatEmail(' andy@example.com '), null);
  assert.equal(validateBoatApiKey('sk-123'), 'boat_로 시작하는 키가 필요합니다.');
  assert.equal(validateBoatApiKey('boat_live_0123456789'), null);
  assert.equal(formatBoatUserCode('123456'), '123 456');
  assert.equal(formatBoatElapsed(65_000), '1:05');
  assert.equal(formatBoatElapsed(3_725_000), '1:02:05');
  assert.equal(formatBoatHours(12.46), '12.5시간');
});

test('boat snapshot parsing is tolerant and never drops the whole Cloud snapshot', () => {
  const base = snapshot(null);
  const parsed = parseCloudSnapshot({ ...base, boat: {
    account: { connected: true, method: 'email', email: 'a@b.co', canStart: false, trial: true },
    server: { sandboxId: 'bx_7k2m9q4d', state: 'running', machine: 'default', machineLabel: '4 vCPU · 8 GB',
      region: 'EU', monthHours: 12.46, idleStopMinutes: 30, message: null },
    setup: { stage: 'installing', startedAt: '2026-09-27T10:00:00.000Z', detail: 'podman', error: null,
      importedProviders: ['codex', 'grok', 'claude'] },
  } });
  assert.equal(parsed?.boat?.server?.monthHours, 12.5);
  assert.deepEqual(parsed?.boat?.setup?.importedProviders, ['claude', 'codex']);
  const malformed = parseCloudSnapshot({ ...base, boat: { account: { connected: 'yes' } } });
  assert.ok(malformed);
  assert.equal(malformed?.boat, null);
  assert.equal(parseCloudSnapshot({ ...base, boat: undefined })?.boat, undefined);
  const profile = parseCloudSnapshot(snapshot(null, true));
  assert.deepEqual(profile?.profile.kind === 'configured' && profile.profile.mode === 'self-hosted' && profile.profile.profile.boat,
    { sandboxId: 'bx_7k2m9q4d', machine: 'default' });
});

test('sign-in challenges only accept boat.dev links', () => {
  const challenge = { claimId: 'c1', verificationUri: 'https://boat.dev/activate', userCode: '123 456',
    expiresAt: '2026-09-27T10:10:00.000Z', intervalSeconds: 5 };
  assert.equal(parseBoatChallenge(challenge)?.userCode, '123456');
  assert.equal(parseBoatChallenge({ ...challenge, verificationUri: 'https://boat.dev.evil.example/activate' }), null);
  assert.equal(parseBoatChallenge({ ...challenge, verificationUri: 'http://boat.dev/activate' }), null);
});

test('IPC rejections keep the Korean sentence and recover the boat code', () => {
  const error = normalizeBoatError(new Error("Error invoking remote method 'cloud:boat-connect-key': Error: BOAT_AUTH_INVALID: boat가 이 API 키를 거절했습니다."));
  assert.equal(error.message, 'boat가 이 API 키를 거절했습니다.');
  assert.equal(error.code, 'BOAT_AUTH_INVALID');
  assert.equal(normalizeBoatError(Object.assign(new Error('잠시 후 다시 시도합니다.'), { code: 'BOAT_RATE_LIMITED' })).code, 'BOAT_RATE_LIMITED');
  // preload 가 contextBridge 너머로 거절하는 오류 모양 객체.
  const bridged = normalizeBoatError({ name: 'BoatError', message: 'boat 요금제가 필요합니다.', code: 'BOAT_BILLING_REQUIRED' });
  assert.deepEqual([bridged.message, bridged.code], ['boat 요금제가 필요합니다.', 'BOAT_BILLING_REQUIRED']);
});

test('an older desktop without boat methods hides boat and rejects calls plainly', async () => {
  const older = createCloudController({ cloudGetState: async () => snapshot(null) } as never);
  assert.equal(older.boatSupported(), false);
  await assert.rejects(older.boatWake(), /boat 서버를 지원하지 않습니다/);
  const methods = ['cloudBoatStartEmailSignIn', 'cloudBoatPollSignIn', 'cloudBoatConnectApiKey', 'cloudBoatOpenLink',
    'cloudBoatSetup', 'cloudBoatWake', 'cloudBoatStop', 'cloudBoatRefresh', 'cloudBoatDisconnect'];
  const api = Object.fromEntries(methods.map((method) => [method, async () => {
    throw new Error(`Error invoking remote method 'cloud:boat': Error: BOAT_UNAVAILABLE: boat에 연결할 수 없습니다.`);
  }]));
  const current = createCloudController(api as never);
  assert.equal(current.boatSupported(), true);
  await assert.rejects(current.boatRefresh(), (error: Error & { code?: string }) =>
    error.message === 'boat에 연결할 수 없습니다.' && error.code === 'BOAT_UNAVAILABLE');
});
