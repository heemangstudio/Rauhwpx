// 요금제 관리자를 Electron 에 연결한다: Studio IPC 와 상태 방송. 결제 주소·ref·키는 렌더러로 보내지 않는다.
import { PLAN_SKUS } from './plan-manager.mjs';

/** Studio 창에 plan:status·plan:start-checkout·plan:cancel-checkout 을 열고, 바뀐 상태를 plan:changed 로 보낸다. */
export function installPlanHost({
  ipcMain,
  manager,
  isTrustedStudioEvent,
  studioWebContents = () => [],
}) {
  const handlers = {
    'plan:status': () => manager.getStatus(),
    // 렌더러는 상품 이름만 넘긴다. 주소는 메인이 설정에서 고른다. 실패 코드(not_available·busy·open_failed·
    // sign_in_required)는 그대로 돌려준다.
    'plan:start-checkout': (_event, sku) => manager.startCheckout(PLAN_SKUS.includes(sku) ? sku : null),
    'plan:cancel-checkout': () => manager.cancelCheckout(),
  };
  for (const [channel, handler] of Object.entries(handlers)) {
    ipcMain.handle(channel, (event, ...args) => {
      if (!isTrustedStudioEvent(event)) throw new Error('Untrusted plan IPC sender');
      return handler(event, ...args);
    });
  }

  function broadcast(status) {
    for (const contents of studioWebContents()) {
      if (!contents || contents.isDestroyed?.()) continue;
      try { contents.send('plan:changed', status); } catch { /* 닫히는 창 */ }
    }
  }

  return { broadcast, channels: Object.keys(handlers) };
}
