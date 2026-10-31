// 설정 → 계정. 사진·이름·이메일·요금제 한 줄과 '계정 열기'. 로그아웃이면 '로그인'.
// 자세한 일(기기, 라이선스, 삭제)은 계정 페이지가 한다.
import './account-settings.css';
import { createHamaMark } from '../plan/hama-mark.ts';
import { ACCOUNT_TIER_LABEL, planCycleLabel } from './account-format.ts';
import { createAvatar } from './account-glyphs.ts';
import { isSignedIn, requestAccountPage, type AccountStore } from './account-store.ts';

export function createAccountSettingsSection(store: AccountStore): { root: HTMLElement; dispose: () => void } {
  const root = document.createElement('section');
  root.className = 'ag-settings-section ag-settings-account-section';
  const head = document.createElement('div');
  head.className = 'ag-settings-section-head';
  const heading = document.createElement('h3');
  heading.className = 'ag-settings-section-title';
  heading.textContent = '계정';
  head.append(heading);

  const row = document.createElement('div');
  row.className = 'ag-settings-control-row ag-settings-account-row';
  const avatar = createAvatar('ag-settings-account-avatar');
  const copy = document.createElement('span');
  copy.className = 'ag-settings-control-copy';
  const name = document.createElement('span');
  name.className = 'ag-settings-control-label';
  const email = document.createElement('span');
  email.className = 'ag-settings-control-description';
  const tier = document.createElement('span');
  tier.className = 'ag-settings-control-description ag-settings-account-tier';
  copy.append(name, email, tier);
  const open = document.createElement('button');
  open.type = 'button';
  open.className = 'ag-settings-btn';
  row.append(avatar.element, copy, open);
  root.append(head, row);

  open.addEventListener('click', () => {
    requestAccountPage(isSignedIn(store.status()) ? undefined : 'sign-in');
  });

  function render(): void {
    const status = store.status();
    avatar.paint(status, store.avatar());
    const account = isSignedIn(status) ? status!.account! : null;
    root.dataset.state = account ? 'signed_in' : 'signed_out';
    name.textContent = account ? account.name : '로그인하지 않았어요';
    email.textContent = account?.email ?? '';
    email.hidden = !account;
    tier.replaceChildren();
    if (account && status) {
      if (status.plan.tier === 'hama') tier.append(createHamaMark('ag-settings-account-hama'));
      const cycle = planCycleLabel(status.plan);
      tier.append(cycle ? `${ACCOUNT_TIER_LABEL[status.plan.tier]} · ${cycle}` : ACCOUNT_TIER_LABEL[status.plan.tier]);
    }
    tier.hidden = !account;
    open.textContent = account ? '계정 열기' : '로그인';
    open.hidden = !account && status?.available === false;
  }

  render();
  const unsubscribe = store.subscribe(render);
  return { root, dispose: unsubscribe };
}
