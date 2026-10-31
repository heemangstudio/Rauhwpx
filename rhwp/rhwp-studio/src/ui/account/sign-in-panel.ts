// 로그인 판: 로그아웃(공급자 단추와 이메일), 로그인 중(브라우저를 기다림), 기기 고르기.
// 계정 페이지와 처음 설정의 계정 장이 같이 쓴다. 로그인을 마치면 부른 쪽이 다음 화면을 정한다.
import './account-page.css';
import { formatLastSeen, platformLabel } from './account-format.ts';
import { PROVIDER_LABEL, platformGlyph, providerGlyph } from './account-glyphs.ts';
import type { AccountStore } from './account-store.ts';
import type { AccountDevice, AccountProvider, AccountStatus } from './account-types.ts';

type PanelView = 'signed_out' | 'signing_in' | 'choose_device' | null;

export interface SignInPanel {
  element: HTMLElement;
  /** 지금 보이는 판, 로그인했으면 null. */
  view(): PanelView;
  focusTarget(): HTMLElement | null;
  dispose(): void;
}

const SOCIAL: readonly AccountProvider[] = ['google', 'kakao'];
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function button(className: string, text = ''): HTMLButtonElement {
  const node = el('button', className, text);
  node.type = 'button';
  return node;
}

function spinner(className = ''): HTMLElement {
  const node = el('span', `ui-spinner${className ? ` ${className}` : ''}`);
  node.setAttribute('aria-hidden', 'true');
  return node;
}

/** 단추 글자 자리에 도는 표를 얹는다. 글자는 남겨 폭이 그대로다. */
export function setBusy(control: HTMLButtonElement, busy: boolean): void {
  control.setAttribute('aria-busy', busy ? 'true' : 'false');
  control.querySelector(':scope > .acct-btn-spinner')?.remove();
  if (busy) control.prepend(spinner('acct-btn-spinner'));
}

export function createSignInPanel(store: AccountStore, options: { variant: 'page' | 'setup' }): SignInPanel {
  const api = store.api!;
  const root = el('div', `acct-signin acct-signin-${options.variant}`);

  // ── 로그아웃 ──
  const out = el('div', 'acct-signin-out');
  if (options.variant === 'page') {
    const mark = el('span', 'ag-rau-icon acct-signin-mark');
    mark.setAttribute('aria-hidden', 'true');
    out.append(mark, el('h2', 'acct-signin-title', '로그인'));
  }
  const socials = el('div', 'acct-signin-socials');
  const socialButtons = new Map<AccountProvider, HTMLButtonElement>();
  for (const provider of SOCIAL) {
    const control = button('acct-btn acct-signin-provider');
    control.dataset.provider = provider;
    control.append(providerGlyph(provider), el('span', '', `${PROVIDER_LABEL[provider]}로 계속하기`));
    control.addEventListener('click', () => { void start(provider); });
    socialButtons.set(provider, control);
    socials.append(control);
  }
  const divider = el('div', 'acct-signin-or');
  divider.append(el('span', '', '또는'));
  const emailForm = el('form', 'acct-signin-email');
  emailForm.noValidate = true;
  const emailInput = el('input', 'acct-input');
  emailInput.type = 'email';
  emailInput.autocomplete = 'email';
  emailInput.spellcheck = false;
  emailInput.placeholder = '이메일 주소';
  emailInput.setAttribute('aria-label', '이메일 주소');
  emailInput.maxLength = 254;
  const emailButton = el('button', 'acct-btn acct-btn-primary', '이메일로 계속하기');
  emailButton.type = 'submit';
  emailForm.append(emailInput, emailButton);
  emailForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const hint = emailInput.value.trim();
    if (hint && !EMAIL_PATTERN.test(hint)) {
      showError('이메일 주소를 확인해 주세요.');
      emailInput.focus();
      return;
    }
    void start('email', hint || undefined);
  });
  const outError = el('p', 'acct-error', '');
  outError.setAttribute('role', 'alert');
  const unavailable = el('p', 'acct-signin-unavailable', '');
  out.append(socials, divider, emailForm, outError, unavailable);

  // ── 로그인 중 ──
  const waiting = el('div', 'acct-signin-wait');
  const waitTitle = el('p', 'acct-signin-wait-title', '브라우저에서 로그인을 마쳐 주세요');
  waitTitle.setAttribute('role', 'status');
  const waitMeta = el('p', 'acct-meta', '');
  const cancelWait = button('acct-btn', '취소');
  cancelWait.addEventListener('click', () => { void cancel(cancelWait); });
  waiting.append(spinner('acct-signin-spinner'), waitTitle, waitMeta, cancelWait);

  // ── 기기 고르기 ──
  const choose = el('div', 'acct-signin-choose');
  const chooseTitle = el('h2', 'acct-signin-choose-title', '');
  const chooseList = el('ul', 'acct-device-list');
  const chooseError = el('p', 'acct-error', '');
  chooseError.setAttribute('role', 'alert');
  const cancelChoose = button('acct-btn acct-btn-quiet', '로그인 취소');
  cancelChoose.addEventListener('click', () => { void cancel(cancelChoose); });
  choose.append(chooseTitle, chooseList, chooseError, cancelChoose);

  root.append(out, waiting, choose);

  let busyProvider: AccountProvider | null = null;
  let error = '';
  let confirming: string | null = null;
  let replacing: string | null = null;
  let chooseErrorText = '';
  let shown: PanelView = null;

  function showError(message: string): void {
    error = message;
    render();
  }

  async function start(provider: AccountProvider, loginHint?: string): Promise<void> {
    if (busyProvider) return;
    busyProvider = provider;
    error = '';
    render();
    try {
      const result = await api.signIn(provider, loginHint);
      if (!result.ok) error = result.message;
    } catch {
      error = '로그인하지 못했어요. 다시 시도해 주세요.';
    } finally {
      busyProvider = null;
      render();
    }
  }

  async function cancel(control: HTMLButtonElement): Promise<void> {
    control.disabled = true;
    setBusy(control, true);
    try { await api.cancelSignIn(); } catch { /* 다음 상태가 다시 그린다 */ }
    control.disabled = false;
    setBusy(control, false);
  }

  async function replace(device: AccountDevice): Promise<void> {
    if (replacing) return;
    replacing = device.id;
    chooseErrorText = '';
    render();
    try {
      const result = await api.replaceDevice(device.id);
      if (!result.ok) chooseErrorText = result.message;
    } catch {
      chooseErrorText = '로그인하지 못했어요. 다시 시도해 주세요.';
    } finally {
      replacing = null;
      confirming = null;
      render();
    }
  }

  function deviceRow(device: AccountDevice): HTMLLIElement {
    const row = el('li', 'acct-device');
    row.dataset.deviceId = device.id;
    const icon = el('span', 'acct-device-icon');
    icon.append(platformGlyph(device.platform));
    const copy = el('span', 'acct-device-copy');
    copy.append(
      el('span', 'acct-device-name', device.name),
      el('span', 'acct-meta', `${platformLabel(device.platform)} · ${formatLastSeen(device.lastSeenAt)}`),
    );
    const actions = el('span', 'acct-device-actions');
    if (confirming === device.id) {
      const no = button('acct-btn acct-btn-quiet', '취소');
      no.disabled = replacing !== null;
      no.addEventListener('click', () => { confirming = null; render(); actionFor(device.id)?.focus(); });
      const yes = button('acct-btn acct-btn-danger acct-device-confirm', '빼고 로그인');
      yes.disabled = replacing !== null;
      if (replacing === device.id) setBusy(yes, true);
      yes.addEventListener('click', () => { void replace(device); });
      actions.append(no, yes);
    } else {
      const remove = button('acct-btn acct-device-remove', '빼기');
      remove.disabled = replacing !== null;
      remove.setAttribute('aria-label', `${device.name} 빼기`);
      remove.addEventListener('click', () => {
        confirming = device.id;
        render();
        root.querySelector<HTMLElement>(`[data-device-id="${CSS.escape(device.id)}"] .acct-device-confirm`)?.focus();
      });
      actions.append(remove);
    }
    row.append(icon, copy, actions);
    return row;
  }

  function actionFor(deviceId: string): HTMLElement | null {
    return root.querySelector<HTMLElement>(`[data-device-id="${CSS.escape(deviceId)}"] .acct-device-remove`);
  }

  function render(): void {
    const status: AccountStatus | null = store.status();
    const state = status?.state ?? 'signed_out';
    shown = state === 'signed_in' ? null : state;
    root.dataset.view = shown ?? 'signed_in';
    out.hidden = shown !== 'signed_out';
    waiting.hidden = shown !== 'signing_in';
    choose.hidden = shown !== 'choose_device';
    if (shown !== 'choose_device') confirming = null;

    const available = status?.available !== false;
    const providers = new Set(status?.providers ?? ['email', 'google']);
    for (const [provider, control] of socialButtons) {
      control.hidden = !available || !providers.has(provider);
      control.disabled = busyProvider !== null;
      setBusy(control, busyProvider === provider);
    }
    const email = available && providers.has('email');
    emailForm.hidden = !email;
    divider.hidden = !email || ![...socialButtons].some(([, control]) => !control.hidden);
    emailInput.disabled = busyProvider !== null;
    emailButton.disabled = busyProvider !== null;
    setBusy(emailButton, busyProvider === 'email');
    unavailable.hidden = available;
    unavailable.textContent = available ? '' : (status?.lastError?.message ?? '계정 기능을 아직 쓸 수 없어요.');
    // 실패한 로그인(취소·시간 초과 등)은 main 이 lastError 로 알린다.
    const shownError = error || (available && shown === 'signed_out' ? status?.lastError?.message ?? '' : '');
    outError.textContent = shownError;
    outError.hidden = !shownError;

    waitMeta.textContent = status?.signIn ? PROVIDER_LABEL[status.signIn.provider] : '';
    waitMeta.hidden = !status?.signIn;

    const choice = status?.deviceChoice;
    chooseTitle.textContent = `기기는 ${choice?.limit ?? status?.deviceLimit ?? 5}대까지 쓸 수 있어요`;
    if (shown === 'choose_device') {
      const focusedId = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>('[data-device-id]')?.dataset.deviceId;
      chooseList.replaceChildren(...(choice?.devices ?? []).map(deviceRow));
      if (focusedId && !root.contains(document.activeElement)) {
        root.querySelector<HTMLElement>(`[data-device-id="${CSS.escape(focusedId)}"] button:not([disabled])`)?.focus();
      }
    }
    chooseError.textContent = chooseErrorText;
    chooseError.hidden = !chooseErrorText;
  }

  let lastState = store.status()?.state ?? null;
  const unsubscribe = store.subscribe((status) => {
    // 판이 바뀌면 앞 판의 오류는 지운다. 같은 판의 새 오류는 lastError 로 온다.
    if (status?.state !== lastState) {
      lastState = status?.state ?? null;
      error = '';
      chooseErrorText = '';
    }
    render();
  });
  render();

  return {
    element: root,
    view: () => shown,
    focusTarget() {
      if (shown === 'signing_in') return cancelWait;
      if (shown === 'choose_device') return root.querySelector<HTMLElement>('.acct-device-remove') ?? cancelChoose;
      return [...socialButtons.values()].find((control) => !control.hidden) ?? (emailForm.hidden ? null : emailInput);
    },
    dispose: unsubscribe,
  };
}
