// 문서 홈 위 막대의 계정 단추. 누르면 단추 아래에 프로필 카드를 연다.
// 데스크톱 계정 API 가 있을 때만 단다(웹 Studio 에는 없다).
import './account-button.css';
import { accountDisplayName } from './account-format.ts';
import { createAvatar } from './account-glyphs.ts';
import { openAccountPage, closeAccountPage, isAccountPageOpen } from './account-page.ts';
import { isSignedIn, type AccountStore } from './account-store.ts';
import type { PlanStore } from '../plan/plan-store.ts';

export function mountAccountButton(
  slot: HTMLElement,
  { store, plan, openSettings }: { store: AccountStore; plan: PlanStore | null; openSettings?: () => void },
): () => void {
  if (!store.api) return () => {};
  const control = document.createElement('button');
  control.type = 'button';
  control.className = 'acct-button';
  control.setAttribute('aria-haspopup', 'dialog');
  control.setAttribute('aria-expanded', 'false');
  const avatar = createAvatar('acct-button-avatar');
  const label = document.createElement('span');
  label.className = 'acct-button-label';
  control.append(avatar.element, label);
  control.addEventListener('click', () => {
    if (isAccountPageOpen()) closeAccountPage();
    else {
      const card = openAccountPage({ store, plan, anchor: control, openSettings });
      if (card) {
        control.setAttribute('aria-expanded', 'true');
        void card.closed.then(() => control.setAttribute('aria-expanded', 'false'));
      }
    }
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
