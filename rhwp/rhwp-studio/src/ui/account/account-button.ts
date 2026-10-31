// 문서 홈 위 막대의 계정 단추: 24px 둥근 사진과 이름(로그아웃이면 '로그인'). 누르면 계정 페이지를 열고, 열려 있으면 닫는다.
// 데스크톱 계정 API 가 있을 때만 단다(웹 Studio 에는 없다).
import './account-button.css';
import { accountDisplayName } from './account-format.ts';
import { createAvatar } from './account-glyphs.ts';
import { openAccountPage, closeAccountPage, isAccountPageOpen } from './account-page.ts';
import { isSignedIn, type AccountStore } from './account-store.ts';
import type { PlanStore } from '../plan/plan-store.ts';

export function mountAccountButton(
  slot: HTMLElement,
  { store, plan }: { store: AccountStore; plan: PlanStore | null },
): () => void {
  if (!store.api) return () => {};
  const control = document.createElement('button');
  control.type = 'button';
  control.className = 'acct-button';
  control.setAttribute('aria-haspopup', 'dialog');
  const avatar = createAvatar('acct-button-avatar');
  const label = document.createElement('span');
  label.className = 'acct-button-label';
  control.append(avatar.element, label);
  control.addEventListener('click', () => {
    if (isAccountPageOpen()) closeAccountPage();
    else openAccountPage({ store, plan });
  });
  slot.append(control);

  const sync = (): void => {
    const status = store.status();
    avatar.paint(status, store.avatar());
    const account = isSignedIn(status) ? status!.account : null;
    const name = account ? accountDisplayName(account) : '';
    label.textContent = account ? name : '로그인';
    control.title = account ? `${name} · ${account.email}` : '로그인';
    control.setAttribute('aria-label', account ? `계정, ${name}` : '계정, 로그인');
  };
  sync();
  const unsubscribe = store.subscribe(sync);
  return () => {
    unsubscribe();
    control.remove();
  };
}
