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

test('확인 중이거나 할 일이 없으면 하마는 팻말을 들지 않는다', () => {
  for (const status of ['disabled', 'idle', 'checking', 'up-to-date'] as const) {
    assert.equal(updateSign(state({ status }), plain), null, status);
  }
  // 백그라운드 확인 실패는 조용히 지나간다.
  assert.equal(updateSign(state({ status: 'idle', error: { context: 'check', message: 'offline' } }), plain), null);
});

test('새 버전 팻말의 단추는 다운로드를 시작하고, 리눅스 deb 는 같은 글로 릴리스 페이지를 연다', () => {
  const inApp = updateSign(state({ status: 'available' }), plain)!;
  assert.equal(inApp.lines.join(' '), 'v3.0.3 업데이트가 있어요. 다운로드할까요?');
  assert.deepEqual(inApp.actions.map((a) => [a.id, a.icon]), [['download', 'download']]);
  const external = updateSign(state({ status: 'available', install: 'external' }), plain)!;
  assert.deepEqual(external.lines, inApp.lines);
  assert.equal(external.actions[0].id, 'download');
  assert.equal(external.actions[0].label, '다운로드 페이지 열기');
});

test('다시 켠 뒤 설치가 안 됐으면 다시 받을지 묻는다', () => {
  const sign = updateSign(state({ status: 'available', error: { context: 'install', message: 'x' } }), plain)!;
  assert.equal(sign.lines.join(' '), 'v3.0.3 업데이트를 설치하지 못했어요. 다시 받을까요?');
  assert.equal(sign.actions[0].id, 'download');
});

test('내려받는 동안 비율이 바뀌어도 같은 팻말이라 하마가 내려가지 않는다', () => {
  const a = updateSign(state({ status: 'downloading', percent: 12.4 }), plain)!;
  const b = updateSign(state({ status: 'downloading', percent: 140 }), plain)!;
  assert.equal(a.key, b.key);
  assert.equal(a.progress, 12);
  assert.equal(b.progress, 100);
});

test('재시작은 늘 경고 팻말을 거치고, 실행 중인 채팅이 있으면 그 수를 알린다', () => {
  const downloaded = updateSign(state({ status: 'downloaded', runningChats: 3 }), plain)!;
  assert.deepEqual(downloaded.actions.map((a) => a.id), ['restart']);
  const withChats = updateSign(state({ status: 'downloaded', runningChats: 3 }), { confirming: true })!;
  assert.equal(withChats.tone, 'warning');
  assert.deepEqual(withChats.lines, ['채팅 3개가 재시작돼요']);
  assert.deepEqual(withChats.actions.map((a) => a.id), ['confirm', 'cancel']);
  const idle = updateSign(state({ status: 'downloaded', runningChats: 0 }), { confirming: true })!;
  assert.deepEqual(idle.lines, ['앱이 재시작돼요']);
  // 채팅 수가 바뀌어도 같은 경고 팻말 안에서 글만 바뀐다.
  assert.equal(withChats.key, idle.key);
});

test('다운로드에 실패하면 다시 받을 단추를 든다', () => {
  const sign = updateSign(state({ status: 'error', error: { context: 'download', message: 'reset' } }), plain)!;
  assert.deepEqual(sign.lines, ['다운로드하지 못했어요']);
  assert.equal(sign.actions[0].id, 'download');
});
