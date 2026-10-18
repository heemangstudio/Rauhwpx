// 선물 크레딧 관리자를 Electron 에 연결한다: Studio IPC, 상태 방송, 허브 자식 프로세스 요청.

/** Studio 창에 gift:status·gift:claim 을 열고, 바뀐 상태를 gift:changed 로 보낸다. */
export function installGiftHost({
  ipcMain,
  manager,
  isTrustedStudioEvent,
  studioWebContents = () => [],
}) {
  const handlers = {
    'gift:status': (_event, options) => manager.status({ refresh: options?.refresh === true }),
    'gift:claim': () => manager.claim(),
  };
  for (const [channel, handler] of Object.entries(handlers)) {
    ipcMain.handle(channel, (event, ...args) => {
      if (!isTrustedStudioEvent(event)) throw new Error('Untrusted gift IPC sender');
      return handler(event, ...args);
    });
  }

  function broadcast(status) {
    for (const contents of studioWebContents()) {
      if (!contents || contents.isDestroyed?.()) continue;
      try { contents.send('gift:changed', status); } catch { /* 닫히는 창 */ }
    }
  }

  return { broadcast, channels: Object.keys(handlers) };
}

/**
 * 허브의 {type:'rhwp-gift-request', id, operation:'credentials', refresh?} 에 답한다.
 * 다른 메시지면 null. 실패 응답은 비밀 저장소 중개와 같은 모양이다: {ok:false, error, code}.
 */
export async function handleGiftRequest(manager, message) {
  if (!message || message.type !== 'rhwp-gift-request' || typeof message.id !== 'string') return null;
  const response = { type: 'rhwp-gift-response', id: message.id };
  try {
    if (message.operation !== 'credentials') throw Object.assign(new Error('Unsupported gift operation.'), { code: 'GIFT_UNSUPPORTED' });
    response.value = await manager.credentials({ refresh: message.refresh === true });
    response.ok = true;
  } catch (error) {
    response.ok = false;
    response.error = error instanceof Error ? error.message : String(error);
    response.code = error?.code ?? 'GIFT_FAILED';
  }
  return response;
}

/** 멈추는 중이거나 이전 허브의 요청에 보내는 거절. */
export function staleGiftResponse(message) {
  return {
    type: 'rhwp-gift-response',
    id: message?.id,
    ok: false,
    error: 'The desktop gift owner is stopping.',
    code: 'GIFT_OWNER_STALE',
  };
}
