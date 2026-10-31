import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DesktopUpdateState } from '../src/desktop-integration.ts';
import { updateSign } from '../src/ui/update-hippo/update-sign.ts';

function state(patch: Partial<DesktopUpdateState>): DesktopUpdateState {
  return {
    status: 'idle',
    currentVersion: '3.0.2',
    version: '3.0.3',
    percent: null,
    install: 'in-app',
    error: null,
    manual: false,
    runningChats: 0,
    ...patch,
  };
}

const plain = { confirming: false };
const actionIds = (patch: Partial<DesktopUpdateState>, view = plain) => updateSign(state(patch), view)?.actions.map((a) => a.id);

test('확인 중이거나 할 일이 없으면 하마는 팻말을 들지 않는다', () => {
  for (const status of ['disabled', 'idle', 'checking', 'up-to-date'] as const) {
    assert.equal(updateSign(state({ status }), plain), null, status);
  }
  // 백그라운드 확인 실패는 조용히 지나간다.
  assert.equal(updateSign(state({ status: 'idle', error: { context: 'check', message: 'offline' } }), plain), null);
});

test('새 버전 팻말의 단추는 다운로드를 시작하고, 리눅스 deb 는 같은 팻말에서 릴리스 페이지를 연다', () => {
  const inApp = updateSign(state({ status: 'available' }), plain)!;
  assert.deepEqual(inApp.actions.map((a) => [a.id, a.icon]), [['download', 'download']]);
  const external = updateSign(state({ status: 'available', install: 'external' }), plain)!;
  assert.deepEqual(external.lines, inApp.lines);
  assert.equal(external.actions[0].id, 'download');
  assert.notEqual(external.actions[0].label, inApp.actions[0].label);
});

test('다시 켠 뒤 설치가 안 됐으면 다시 받는 팻말을 든다', () => {
  const offer = updateSign(state({ status: 'available' }), plain)!;
  const failed = updateSign(state({ status: 'available', error: { context: 'install', message: 'x' } }), plain)!;
  assert.notEqual(failed.key, offer.key);
  assert.deepEqual(failed.actions.map((a) => a.id), ['download']);
});

test('내려받는 동안 비율이 바뀌어도 같은 팻말이라 하마가 내려가지 않는다', () => {
  const a = updateSign(state({ status: 'downloading', percent: 12.4 }), plain)!;
  const b = updateSign(state({ status: 'downloading', percent: 140 }), plain)!;
  assert.equal(a.key, b.key);
  assert.equal(a.progress, 12);
  assert.equal(b.progress, 100);
});

test('재시작은 늘 경고 팻말을 거치고, 채팅 수가 바뀌어도 같은 경고 팻말이다', () => {
  assert.deepEqual(actionIds({ status: 'downloaded', runningChats: 3 }), ['restart']);
  const withChats = updateSign(state({ status: 'downloaded', runningChats: 3 }), { confirming: true })!;
  assert.equal(withChats.tone, 'warning');
  assert.deepEqual(withChats.actions.map((a) => a.id), ['confirm', 'cancel']);
  const idle = updateSign(state({ status: 'downloaded', runningChats: 0 }), { confirming: true })!;
  assert.notDeepEqual(withChats.lines, idle.lines);
  assert.equal(withChats.key, idle.key);
});

test('멈춘 재시작은 다른 팻말로 알리고, 다시 누르면 경고 팻말로 간다', () => {
  const failure = { context: 'install', message: 'timeout' } as const;
  const failed = updateSign(state({ status: 'downloaded', error: failure }), plain)!;
  assert.notEqual(failed.key, updateSign(state({ status: 'downloaded' }), plain)!.key);
  assert.deepEqual(failed.actions.map((a) => [a.id, a.icon]), [['restart', 'reload']]);
  assert.deepEqual(actionIds({ status: 'downloaded', error: failure }, { confirming: true }), ['confirm', 'cancel']);
});

test('다운로드에 실패하면 다시 받을 단추를 든다', () => {
  assert.deepEqual(actionIds({ status: 'error', error: { context: 'download', message: 'reset' } }), ['download']);
});

test('home offers CLI updates only to signed-in paid members and keeps app updates available', async () => {
  const { homeUpdateSign } = await import('../src/ui/update-hippo/update-all-sign.ts');
  const all: import('../src/desktop-integration.ts').UpdateAllState = {
    runId: null, phase: 'idle', restartAt: null,
    items: [
      { id: 'claude', fromVersion: '1', targetVersion: '2', status: 'available', message: null },
      { id: 'codex', fromVersion: '1', targetVersion: '2', status: 'available', message: null },
    ],
  };
  const plan = (tier: 'free' | 'hama' | 'rau', signedIn: boolean, agentUnlocked: boolean) => (
    { tier, signedIn, agentUnlocked } as import('../src/ui/plan/plan-types.ts').PlanStatus
  );
  for (const restricted of [null, plan('hama', false, true), plan('free', true, false), plan('free', true, true), plan('hama', true, false)]) {
    assert.equal(homeUpdateSign(all, state({ status: 'idle' }), restricted, plain), null);
    const app = homeUpdateSign(all, state({ status: 'available' }), restricted, plain)!;
    assert.deepEqual(app.actions.map((action) => action.id), ['download']);
  }
  for (const tier of ['hama', 'rau'] as const) {
    const sign = homeUpdateSign(all, state({ status: 'idle' }), plan(tier, true, true), plain)!;
    assert.equal(sign.lines.length, 2);
    assert.deepEqual(sign.actions.map((action) => action.id), ['update-all']);
    assert.equal(homeUpdateSign(all, state({ status: 'idle' }), plan(tier, false, true), plain), null);
  }
});
