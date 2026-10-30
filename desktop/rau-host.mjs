// 호스팅 Rau-0.1 을 Electron 에 연결한다: Studio IPC(상태·업그레이드 페이지)와 허브 자식 프로세스 요청.
// lease 는 여기서만 쓰고 Studio·허브로 보내지 않는다.
import { PRICING_URL } from './license-manager.mjs';
import { RauServerError, upgradeUrlFrom } from './rau-client.mjs';

/** 키가 없거나 lease 가 지금 검증되지 않을 때. 서버에 묻지 않는다. */
const NO_LICENSE = 'no_license';

/** Studio 의 rau:status 답. 라이선스가 없으면 서버에 묻지 않고 자격이 없다고 답한다. */
async function statusFor({ client, currentLease }) {
  const lease = await currentLease();
  if (!lease) return { ok: true, eligible: false, reason: NO_LICENSE, upgradeUrl: PRICING_URL };
  try {
    return { ok: true, ...(await client.status(lease)) };
  } catch (error) {
    if (error?.code === 'rau_requires_pro') {
      return { ok: true, eligible: false, reason: 'rau_requires_pro', upgradeUrl: upgradeUrlFrom(error.upgradeUrl) };
    }
    return { ok: false, code: error?.code ?? 'server' };
  }
}

/** Studio 창에 rau:status·rau:open-upgrade 를 연다. */
export function installRauHost({ ipcMain, shell, client, currentLease, isTrustedStudioEvent }) {
  const handlers = {
    'rau:status': () => statusFor({ client, currentLease }),
    // 주소는 같은 규칙(우리 사이트·Groble 의 https)으로 다시 거른다.
    'rau:open-upgrade': (_event, url) => shell.openExternal(upgradeUrlFrom(url)),
  };
  for (const [channel, handler] of Object.entries(handlers)) {
    ipcMain.handle(channel, (event, ...args) => {
      if (!isTrustedStudioEvent(event)) throw new Error('Untrusted Rau IPC sender');
      return handler(event, ...args);
    });
  }
  return { channels: Object.keys(handlers) };
}

/** 허브에 돌려줄 오류 칸. lease 와 서버 원문은 넣지 않는다. */
function errorFields(error) {
  const code = error instanceof RauServerError || typeof error?.code === 'string' ? error.code : 'server';
  return {
    code,
    ...(code === 'rau_requires_pro' ? { upgradeUrl: upgradeUrlFrom(error.upgradeUrl) } : {}),
    ...(code === 'rau_cap_reached' ? { capUsd: error.capUsd, usedUsd: error.usedUsd, resetsAt: error.resetsAt } : {}),
  };
}

/**
 * 허브의 {type:'rhwp-rau-request', id, operation:'learn', prompt} 에 답한다. 다른 메시지면 null.
 * 성공: {ok:true, value:{text, model}}. 실패: {ok:false, error, code, ...}.
 */
export async function handleRauRequest({ client, currentLease }, message) {
  if (!message || message.type !== 'rhwp-rau-request' || typeof message.id !== 'string') return null;
  const response = { type: 'rhwp-rau-response', id: message.id };
  try {
    if (message.operation !== 'learn') throw Object.assign(new Error('Unsupported Rau operation.'), { code: 'RAU_UNSUPPORTED' });
    const lease = await currentLease();
    if (!lease) throw Object.assign(new Error('No license lease.'), { code: NO_LICENSE });
    const result = await client.learn(lease, String(message.prompt ?? ''));
    response.ok = true;
    response.value = { text: result.text, model: result.model };
  } catch (error) {
    response.ok = false;
    response.error = error?.code ?? 'server';
    Object.assign(response, errorFields(error));
  }
  return response;
}

/** 멈추는 중이거나 이전 허브의 요청에 보내는 거절. */
export function staleRauResponse(message) {
  return { type: 'rhwp-rau-response', id: message?.id, ok: false, error: 'stale', code: 'RAU_OWNER_STALE' };
}
