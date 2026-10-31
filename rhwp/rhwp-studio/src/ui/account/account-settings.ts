// 설정 → 계정. 별도 대화상자 없이 프로필·요금제·기기·라이선스를 탭 안에 표시한다.
import { openAccountPage, type AccountPageHandle } from './account-page.ts';
import type { AccountStore } from './account-store.ts';
import type { PlanStore } from '../plan/plan-store.ts';

export function createAccountSettingsSection(
  store: AccountStore,
  plan?: PlanStore | null,
): { root: HTMLElement; open(): void; close(): void; dispose(): void } {
  const root = document.createElement('section');
  root.className = 'ag-settings-account-section';
  let page: AccountPageHandle | null = null;
  const close = (): void => { page?.close(); page = null; };
  return {
    root,
    open: () => { page ??= openAccountPage({ store, plan, container: root }); },
    close,
    dispose: close,
  };
}
