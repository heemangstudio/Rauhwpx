/**
 * 처음 설정의 계정 장: Google·이메일 로그인(카카오는 서버가 알릴 때만). 편집은 로그인 없이 되므로 '나중에'로 넘어갈 수 있다.
 *
 * 데스크톱에서 로그아웃 상태일 때만 뜬다. 로그인 판은 계정 페이지와 같은 것을 쓰고(브라우저 기다림, 기기 고르기 포함),
 * 로그인을 마치면 사진·이름을 잠깐 보인 뒤 다음 장으로 넘어간다. 설명은 하마가 한다.
 */
import { createIcon } from '../agent-sidebar/icons.ts';
import { createAvatar } from '../account/account-glyphs.ts';
import { isSignedIn, type AccountStore } from '../account/account-store.ts';
import type { AccountStatus } from '../account/account-types.ts';
import { createSignInPanel } from '../account/sign-in-panel.ts';

export interface AccountStepUi {
  element: HTMLElement;
  /** 이 장에서(또는 다른 곳에서) 로그인을 마쳤는지. 다음 단추의 글을 정한다. */
  signedIn(): boolean;
  focusTarget(): HTMLElement | null;
  dispose(): void;
}

export interface AccountStepDeps {
  store: AccountStore;
  cheer(line: string): void;
  /** 로그인을 마쳤을 때 한 번. */
  onSignedIn(status: AccountStatus): void;
  onStateChange(): void;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function createAccountStep(deps: AccountStepDeps): AccountStepUi {
  const { store } = deps;
  let signedIn = isSignedIn(store.status());

  const panel = el('div', 'rhwp-setup-panel rhwp-setup-account');
  panel.dataset.step = 'account';
  const signIn = createSignInPanel(store, { variant: 'setup' });

  // 로그인을 마친 자리: 사진·이름·이메일과 체크.
  const done = el('div', 'rhwp-setup-account-done');
  done.tabIndex = -1;
  const avatar = createAvatar('rhwp-setup-account-avatar');
  const copy = el('span', 'rhwp-setup-account-copy');
  const name = el('span', 'rhwp-setup-account-name');
  const email = el('span', 'rhwp-setup-account-email');
  copy.append(name, email);
  const check = el('span', 'rhwp-setup-check');
  check.append(createIcon('check'));
  done.append(avatar.element, copy, check);
  panel.append(signIn.element, done);

  function render(): void {
    const status = store.status();
    const account = isSignedIn(status) ? status!.account : null;
    panel.dataset.state = account ? 'signed_in' : status?.state ?? 'signed_out';
    signIn.element.hidden = account !== null;
    done.hidden = account === null;
    avatar.paint(status, store.avatar());
    name.textContent = account?.name ?? '';
    email.textContent = account?.email ?? '';
  }

  const unsubscribe = store.subscribe((status) => {
    render();
    if (!signedIn && isSignedIn(status)) {
      signedIn = true;
      deps.cheer('로그인했어요!');
      deps.onSignedIn(status!);
    }
    deps.onStateChange();
  });
  render();

  return {
    element: panel,
    signedIn: () => signedIn,
    focusTarget: () => (signedIn ? done : signIn.focusTarget()),
    dispose() {
      unsubscribe();
      signIn.dispose();
    },
  };
}
