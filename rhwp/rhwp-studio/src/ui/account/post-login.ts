// 홈에서 로그인한 뒤의 안내. 프로필·기기·결제 관리는 계정 화면에 남긴다.
import { createSheetFrame } from '../agent-sidebar/sheet.ts';
import { createTypingHama } from '../agent-sidebar/hama-art.ts';
import type { PlanStore } from '../plan/plan-store.ts';
import type { AccountStore } from './account-store.ts';
import type { AccountStatus } from './account-types.ts';

export async function openPostLogin(
  status: AccountStatus,
  account: AccountStore,
  plan: PlanStore | null,
  newAccount: boolean,
): Promise<void> {
  if (newAccount && status.plan.tier === 'free' && plan?.api) {
    const { openPlanCard } = await import('../plan/upgrade-card.ts');
    openPlanCard({ store: plan, account, license: null });
    return;
  }

  const frame = createSheetFrame({
    title: newAccount ? 'HamaEditor에 오신 걸 환영해요' : '로그인했어요',
    center: true,
    role: 'dialog',
    className: 'acct-login-success',
    dragIgnore: 'button',
  });
  frame.header.before(createTypingHama());
  const email = document.createElement('p');
  email.className = 'acct-login-success-email';
  email.textContent = status.account?.email ?? '';
  const done = document.createElement('button');
  done.type = 'button';
  done.className = 'acct-btn acct-btn-primary acct-login-success-done';
  done.textContent = '시작하기';
  frame.sheet.append(email, done);
  const finish = frame.present(() => done, () => {});
  done.addEventListener('click', () => finish(true));
}
