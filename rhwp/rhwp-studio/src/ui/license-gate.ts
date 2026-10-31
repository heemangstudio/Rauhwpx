import { accountRenewalPrompt } from './account/account-format';
import { accountStore } from './account/account-store';
import { createRenewalNotice } from './license-renewal-notice';
import { OPEN_PLAN_CARD_EVENT } from './plan/upgrade-card';

/**
 * 계정 요금제의 연장 안내를 편집 화면에 띄운다. 편집은 막지 않는다.
 * 구독 결제가 실패한 동안은 결제 수단 바꾸기를, 구독이 끝나 무료가 됐으면 구독 관리와 새로 구매하기를 권한다.
 * 계정 API 가 없으면(웹 Studio) 아무것도 하지 않는다.
 */
export function installLicenseGate(): void {
  const store = accountStore();
  const api = store.api;
  if (!api) return;
  const notice = createRenewalNotice();

  const render = (): void => {
    const prompt = accountRenewalPrompt(store.status());
    notice.show(prompt ? {
      id: prompt.id,
      title: prompt.title,
      detail: prompt.detail,
      action: prompt.action,
      onAction: () => { void api.openManage(); },
      // 끝난 구독은 Groble에서 다시 살릴 수 없을 때가 있어 새로 구매하는 길도 둔다.
      secondary: prompt.kind === 'lapsed'
        ? { label: '새로 구매하기', onClick: () => { window.dispatchEvent(new CustomEvent(OPEN_PLAN_CARD_EVENT)); } }
        : undefined,
    } : null);
  };

  const unsubscribe = store.subscribe(render);
  render();
  window.addEventListener('pagehide', unsubscribe, { once: true });
}
