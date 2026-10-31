// 계정 관리자를 Electron 에 연결한다: Studio IPC 와 상태 방송. 세션 토큰·lease·로그인 코드는 렌더러로 보내지 않는다.
import {
  ACCOUNT_PROVIDERS, ACTIVITY_KINDS, accountErrorMessage, AVATAR_MAX_BYTES, AVATAR_TYPES,
} from './account-manager.mjs';

const DEVICE_ID_RE = /^[A-Za-z0-9\-_.:]{8,128}$/;

/** 렌더러가 보낸 사진 바이트. Uint8Array·ArrayBuffer 만 받는다. */
function bytesFrom(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return null;
}

const shortText = (value, max) => (typeof value === 'string' ? value.slice(0, max) : null);

/**
 * Studio 창에 account:* 를 열고, 바뀐 상태를 account:changed 로 보낸다.
 * account:record-activity 만 send(답 없음)이고 나머지는 invoke 다.
 */
export function installAccountHost({
  ipcMain,
  manager,
  isTrustedStudioEvent,
  studioWebContents = () => [],
}) {
  async function rejected(code) {
    return { ok: false, code, message: accountErrorMessage(code), status: await manager.getStatus() };
  }

  const handlers = {
    'account:status': () => manager.getStatus(),
    'account:sign-in': (_event, provider, loginHint, intent) => {
      if (!ACCOUNT_PROVIDERS.includes(provider)) return rejected('invalid');
      if (loginHint !== undefined && loginHint !== null && typeof loginHint !== 'string') return rejected('invalid');
      if (intent !== undefined && intent !== null && intent !== 'sign_in' && intent !== 'sign_up') return rejected('invalid');
      return manager.signIn(provider, typeof loginHint === 'string' ? loginHint.slice(0, 254) : undefined, intent ?? undefined);
    },
    'account:cancel-sign-in': () => manager.cancelSignIn(),
    'account:replace-device': (_event, deviceId) => (
      typeof deviceId === 'string' && DEVICE_ID_RE.test(deviceId) ? manager.replaceDevice(deviceId) : rejected('device_not_found')
    ),
    'account:refresh': () => manager.refresh(),
    'account:sign-out': () => manager.signOut(),
    'account:remove-device': (_event, deviceId) => (
      typeof deviceId === 'string' && DEVICE_ID_RE.test(deviceId) ? manager.removeDevice(deviceId) : rejected('device_not_found')
    ),
    'account:update-name': (_event, name) => {
      const value = shortText(name, 200);
      return value === null ? rejected('name_invalid') : manager.updateName(value);
    },
    'account:set-avatar': (_event, bytes, type) => {
      const data = bytesFrom(bytes);
      if (!data || !AVATAR_TYPES.includes(type)) return rejected('unsupported_type');
      if (data.byteLength > AVATAR_MAX_BYTES) return rejected('too_large');
      return manager.setAvatar(data, type);
    },
    'account:remove-avatar': () => manager.removeAvatar(),
    'account:get-avatar': () => manager.getAvatar(),
    'account:redeem': (_event, key) => {
      const value = shortText(key, 256);
      return value === null ? rejected('invalid_format') : manager.redeem(value);
    },
    'account:claim': (_event, orderId, email) => {
      const order = shortText(orderId, 128);
      const address = shortText(email, 254);
      return order === null || address === null ? rejected('order_not_found') : manager.claim(order, address);
    },
    'account:delete': (_event, confirm) => {
      const value = shortText(confirm, 320);
      return value === null ? rejected('confirm_mismatch') : manager.deleteAccount(value);
    },
    // 주소는 렌더러가 넘기지 않는다. 메인이 서버가 준 Groble 주소(없으면 기본 주문조회)를 연다.
    'account:open-manage': async () => { await manager.openManage(); },
  };
  for (const [channel, handler] of Object.entries(handlers)) {
    ipcMain.handle(channel, (event, ...args) => {
      if (!isTrustedStudioEvent(event)) throw new Error('Untrusted account IPC sender');
      return handler(event, ...args);
    });
  }
  // 답을 기다리지 않는 사용 기록.
  ipcMain.on('account:record-activity', (event, kind, id) => {
    if (!isTrustedStudioEvent(event)) return;
    if (!Object.hasOwn(ACTIVITY_KINDS, kind) || typeof id !== 'string' || !id || id.length > 512) return;
    manager.recordActivity(kind, id);
  });

  function broadcast(status) {
    for (const contents of studioWebContents()) {
      if (!contents || contents.isDestroyed?.()) continue;
      try { contents.send('account:changed', status); } catch { /* 닫히는 창 */ }
    }
  }

  return { broadcast, channels: [...Object.keys(handlers), 'account:record-activity'] };
}
