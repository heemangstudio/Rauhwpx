import './cloud-boat.css';

import type { CloudController } from '../../cloud/desktop-cloud.ts';
import type { BoatSetupProgress, BoatSignInChallenge, CloudProfileDraft, CloudSnapshot } from '../../cloud/types.ts';
import {
  BOAT_DEFAULT_IDLE_MINUTES,
  BOAT_MACHINE,
  BOAT_MACHINE_LABELS,
  BOAT_REGION_LABEL,
  boatIdleLabel,
  boatProvidersLabel,
  boatSetupIssue,
  boatStageRows,
  boatStateAfterAccount,
  formatBoatElapsed,
  formatBoatUserCode,
  reconcileBoatState,
  snapshotBoatProfile,
  validateBoatApiKey,
  validateBoatEmail,
  type BoatHostPlatform,
  type BoatSetupState,
  type CloudSetupIntent,
  type CloudSetupIssue,
  type CloudSetupState,
} from './cloud-onboarding-state.ts';
import { createIcon } from './icons.ts';

export interface BoatSetupContext {
  controller: CloudController;
  platform: BoatHostPlatform;
  snapshot(): CloudSnapshot;
  state(): CloudSetupState | null;
  visible(): boolean;
  setState(next: CloudSetupState, announcement?: string): void;
  announce(text: string): void;
  button(label: string, tone?: 'primary' | 'quiet' | 'danger'): HTMLButtonElement;
  description(text: string): HTMLParagraphElement;
  issueDetails(issue: CloudSetupIssue, summary: string): HTMLElement;
  transferContext(intent: CloudSetupIntent): HTMLElement | null;
  continueTransfer(intent: CloudSetupIntent): void;
  chooseAgain(intent: CloudSetupIntent, draft: CloudProfileDraft): void;
  close(restoreFocus?: boolean): void;
  beginOperation(): number;
  operationIsCurrent(operation: number): boolean;
}

export interface BoatSetupParts {
  title: HTMLElement;
  body: HTMLElement;
  footer: HTMLElement;
}

export interface BoatSetupView {
  render(state: BoatSetupState, parts: BoatSetupParts): void;
  /** 스냅샷만 바뀌었을 때 진행 목록을 제자리에서 고친다. 포커스를 옮기지 않는다. */
  refresh(): void;
  /** 상태가 바뀌거나 창이 닫힐 때 폴링·시계를 맞춘다. */
  sync(): void;
  dispose(): void;
}

const COPY_CONFIRM_MS = 1_200;
const BILLING_POLL_MS = 5_000;
const AUTOFOCUS = 'ag-cloud-setup-autofocus';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function waitingRow(text: string, spinning = true): HTMLElement {
  const row = el('p', 'ag-cloud-setup-waiting');
  row.setAttribute('role', 'status');
  if (spinning) {
    const spinner = el('span', 'ag-cloud-setup-waiting-spinner ui-spinner');
    spinner.setAttribute('aria-hidden', 'true');
    row.append(spinner);
  }
  row.append(el('span', 'ag-cloud-setup-waiting-text', text));
  return row;
}

/** 사양·지역처럼 짧은 사실 몇 줄. 머리선으로만 나눈다. */
function facts(rows: Array<[string, string]>): HTMLElement {
  const list = el('dl', 'ag-cloud-setup-facts');
  for (const [key, value] of rows) {
    const row = el('div', 'ag-cloud-setup-fact');
    row.append(el('dt', '', key), el('dd', '', value));
    list.append(row);
  }
  return list;
}

export function createBoatSetupView(ctx: BoatSetupContext): BoatSetupView {
  let signInPoll: { claimId: string; timer: number; failures: number } | null = null;
  let billingTimer = 0;
  let clockTimer = 0;
  let copyTimer = 0;
  let progressList: HTMLOListElement | null = null;
  let progressKey = '';
  let lastAnnouncedStage = '';
  let disposed = false;

  function current<K extends BoatSetupState['kind']>(kind: K): Extract<BoatSetupState, { kind: K }> | null {
    const state = ctx.state();
    return state?.kind === kind ? state as Extract<BoatSetupState, { kind: K }> : null;
  }

  function linkButton(label: string): HTMLButtonElement {
    const node = el('button', 'ag-cloud-setup-link', label) as HTMLButtonElement;
    node.type = 'button';
    return node;
  }

  function field(label: string, id: string, options: {
    type: 'email' | 'password';
    value: string;
    placeholder?: string;
    autocomplete: string;
    error: string | null;
    busy: boolean;
  }): { root: HTMLLabelElement; input: HTMLInputElement } {
    const root = el('label', 'ag-cloud-setup-field');
    const input = el('input', `ag-cloud-setup-input ${AUTOFOCUS}`) as HTMLInputElement;
    input.type = options.type;
    input.id = id;
    input.name = id;
    input.value = options.value;
    input.placeholder = options.placeholder ?? '';
    input.autocomplete = options.autocomplete as AutoFill;
    input.spellcheck = false;
    input.setAttribute('autocapitalize', 'off');
    input.readOnly = options.busy;
    root.append(el('span', 'ag-cloud-setup-label', label), input);
    if (options.error) {
      const error = el('span', 'ag-cloud-setup-field-error', options.error);
      error.id = `${id}-error`;
      input.setAttribute('aria-invalid', 'true');
      input.setAttribute('aria-describedby', error.id);
      root.append(error);
    }
    return { root, input };
  }

  function submitOnEnter(form: HTMLFormElement): void {
    form.noValidate = true;
    form.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' || event.isComposing || !(event.target instanceof HTMLInputElement)) return;
      event.preventDefault();
      form.requestSubmit();
    });
  }

  /* ── 계정 연결 ─────────────────────────────────────── */

  async function startEmailSignIn(email: string, intent: CloudSetupIntent, draft: CloudProfileDraft): Promise<void> {
    const error = validateBoatEmail(email);
    if (error) {
      ctx.setState({ kind: 'boat-connect', draft, intent, email, error, pending: false }, error);
      return;
    }
    const operation = ctx.beginOperation();
    const trimmed = email.trim();
    const previous = ctx.state();
    if (previous?.kind === 'boat-signin') ctx.setState({ ...previous, pending: true });
    else ctx.setState({ kind: 'boat-connect', draft, intent, email: trimmed, error: null, pending: true });
    try {
      const challenge = await ctx.controller.boatStartEmailSignIn(trimmed);
      if (!ctx.operationIsCurrent(operation)) return;
      ctx.setState({
        kind: 'boat-signin', draft, intent, email: trimmed, challenge, beat: 'open', expired: false, pending: false,
      }, '브라우저에서 boat에 로그인합니다.');
    } catch (cause) {
      if (!ctx.operationIsCurrent(operation)) return;
      const message = cause instanceof Error ? cause.message : String(cause);
      ctx.setState({ kind: 'boat-connect', draft, intent, email: trimmed, error: message, pending: false }, message);
    }
  }

  async function connectApiKey(apiKey: string, intent: CloudSetupIntent, draft: CloudProfileDraft): Promise<void> {
    const error = validateBoatApiKey(apiKey);
    if (error) {
      ctx.setState({ kind: 'boat-key', draft, intent, apiKey, error, pending: false }, error);
      return;
    }
    const operation = ctx.beginOperation();
    ctx.setState({ kind: 'boat-key', draft, intent, apiKey, error: null, pending: true }, 'boat 계정을 확인하고 있습니다.');
    try {
      const next = await ctx.controller.boatConnectApiKey(apiKey.trim());
      if (!ctx.operationIsCurrent(operation) || current('boat-key')?.pending !== true) return;
      ctx.setState(boatStateAfterAccount(next, intent, draft), 'boat 계정을 연결했습니다.');
    } catch (cause) {
      if (!ctx.operationIsCurrent(operation)) return;
      const message = cause instanceof Error ? cause.message : String(cause);
      ctx.setState({ kind: 'boat-key', draft, intent, apiKey, error: message, pending: false }, message);
    }
  }

  async function openLink(kind: 'verification' | 'checkout' | 'api-keys', claimId?: string): Promise<boolean> {
    try {
      return await ctx.controller.boatOpenLink(kind, claimId);
    } catch (cause) {
      ctx.announce(cause instanceof Error ? cause.message : String(cause));
      return false;
    }
  }

  function renderConnect(state: Extract<BoatSetupState, { kind: 'boat-connect' }>, parts: BoatSetupParts): void {
    const { draft, intent } = state;
    parts.title.textContent = 'boat 계정 연결';
    const form = el('form', 'ag-cloud-setup-form');
    const email = field('이메일', 'ag-boat-email', {
      type: 'email', value: state.email, autocomplete: 'email', error: state.error, busy: state.pending,
    });
    email.input.addEventListener('input', () => {
      const live = current('boat-connect');
      if (live) Object.assign(live, { email: email.input.value });
    });
    form.append(email.root);
    submitOnEnter(form);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      if (current('boat-connect')?.pending) return;
      void startEmailSignIn(email.input.value, intent, draft);
    });
    const withKey = linkButton('API 키로 연결');
    withKey.disabled = state.pending;
    withKey.addEventListener('click', () => ctx.setState({
      kind: 'boat-key', draft, intent, apiKey: '', error: null, pending: false,
    }));
    parts.body.append(ctx.description('boat 계정에 Cloud 서버를 만듭니다. 사용 요금은 boat에서 청구합니다.'), form, withKey);
    const back = ctx.button('뒤로');
    back.addEventListener('click', () => ctx.chooseAgain(intent, draft));
    const primary = ctx.button('계속', 'primary');
    primary.disabled = state.pending;
    primary.setAttribute('aria-busy', String(state.pending));
    primary.addEventListener('click', () => form.requestSubmit());
    parts.footer.append(back, primary);
  }

  function renderKey(state: Extract<BoatSetupState, { kind: 'boat-key' }>, parts: BoatSetupParts): void {
    const { draft, intent } = state;
    parts.title.textContent = 'API 키로 연결';
    const form = el('form', 'ag-cloud-setup-form');
    const key = field('API 키', 'ag-boat-api-key', {
      type: 'password', value: state.apiKey, placeholder: 'boat_…', autocomplete: 'off', error: state.error, busy: state.pending,
    });
    key.input.addEventListener('input', () => {
      const live = current('boat-key');
      if (live) Object.assign(live, { apiKey: key.input.value });
    });
    form.append(key.root);
    submitOnEnter(form);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      if (current('boat-key')?.pending) return;
      void connectApiKey(key.input.value, intent, draft);
    });
    const create = linkButton('boat에서 키 만들기');
    create.addEventListener('click', () => { void openLink('api-keys'); });
    parts.body.append(form, create);
    const back = ctx.button('뒤로');
    back.disabled = state.pending;
    back.addEventListener('click', () => ctx.setState({
      kind: 'boat-connect', draft, intent, email: '', error: null, pending: false,
    }));
    const primary = ctx.button('연결', 'primary');
    primary.disabled = state.pending;
    primary.setAttribute('aria-busy', String(state.pending));
    primary.addEventListener('click', () => form.requestSubmit());
    parts.footer.append(back, primary);
  }

  /* ── 로그인 두 박자 ─────────────────────────────────── */

  function renderSignIn(state: Extract<BoatSetupState, { kind: 'boat-signin' }>, parts: BoatSetupParts): void {
    const { draft, intent, challenge } = state;
    parts.title.textContent = 'boat 로그인';
    const back = ctx.button('뒤로');
    back.addEventListener('click', () => ctx.setState({
      kind: 'boat-connect', draft, intent, email: state.email, error: null, pending: false,
    }));
    if (state.beat !== 'code') {
      parts.body.append(ctx.description('브라우저에서 boat에 로그인합니다.'));
      const primary = ctx.button(state.beat === 'open' ? '로그인 페이지 열기' : '로그인했습니다', 'primary');
      primary.classList.add(AUTOFOCUS);
      primary.disabled = state.pending;
      primary.addEventListener('click', async () => {
        const live = current('boat-signin');
        if (!live || live.pending || live.challenge.claimId !== challenge.claimId) return;
        if (live.beat === 'opened') {
          ctx.setState({ ...live, beat: 'code' }, 'boat 페이지에 이 코드를 입력합니다.');
          return;
        }
        ctx.setState({ ...live, pending: true });
        let opened = await openLink('verification', challenge.claimId);
        if (!opened) opened = window.open(challenge.verificationUri, '_blank', 'noopener,noreferrer') !== null;
        const after = current('boat-signin');
        if (!after || after.challenge.claimId !== challenge.claimId) return;
        // 창을 열었는지 확인할 수 없어도 사용자는 다음 박자로 넘어갈 수 있어야 한다.
        ctx.setState({ ...after, beat: 'opened', pending: false },
          opened ? '로그인한 뒤 로그인했습니다를 누릅니다.' : '로그인 페이지를 열지 못했습니다.');
      });
      parts.footer.append(back, primary);
      return;
    }
    parts.body.append(ctx.description('boat 페이지에 이 코드를 입력합니다.'));
    const code = el('div', 'ag-cloud-setup-code');
    if (state.expired) code.dataset.expired = 'true';
    const value = el('span', 'ag-cloud-setup-code-value');
    // 세 자리씩 끊어 보이되, 선택해 복사하면 공백 없는 코드가 된다.
    for (const group of formatBoatUserCode(challenge.userCode).split(' ')) value.append(el('span', '', group));
    value.setAttribute('role', 'text');
    value.setAttribute('aria-label', `로그인 코드 ${challenge.userCode.split('').join(' ')}`);
    const copy = el('button', 'ag-cloud-setup-code-copy') as HTMLButtonElement;
    copy.type = 'button';
    copy.title = '코드 복사';
    copy.setAttribute('aria-label', '코드 복사');
    copy.append(createIcon('copy'));
    copy.disabled = state.expired;
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(challenge.userCode);
        copy.replaceChildren(createIcon('check'));
        copy.dataset.copied = 'true';
        ctx.announce('코드를 복사했습니다.');
        window.clearTimeout(copyTimer);
        copyTimer = window.setTimeout(() => {
          copy.replaceChildren(createIcon('copy'));
          delete copy.dataset.copied;
        }, COPY_CONFIRM_MS);
      } catch {
        ctx.announce('복사하지 못했습니다. 코드를 직접 선택합니다.');
      }
    });
    code.append(value, copy);
    parts.body.append(code);
    if (state.expired) {
      parts.body.append(waitingRow('코드가 만료되었습니다.', false));
      const renew = ctx.button('새 코드', 'primary');
      renew.classList.add(AUTOFOCUS);
      renew.disabled = state.pending;
      renew.addEventListener('click', () => {
        if (current('boat-signin')?.pending) return;
        void startEmailSignIn(state.email, intent, draft);
      });
      parts.footer.append(back, renew);
      return;
    }
    parts.body.append(waitingRow('확인 중'));
    parts.footer.append(back);
  }

  function stopSignInPoll(): void {
    if (signInPoll) window.clearTimeout(signInPoll.timer);
    signInPoll = null;
  }

  function expireSignIn(claimId: string): void {
    stopSignInPoll();
    const live = current('boat-signin');
    if (!live || live.challenge.claimId !== claimId || live.expired) return;
    ctx.setState({ ...live, expired: true }, '코드가 만료되었습니다.');
  }

  function scheduleSignInPoll(challenge: BoatSignInChallenge, delay: number): void {
    const token = signInPoll;
    if (!token) return;
    token.timer = window.setTimeout(() => { void pollSignIn(challenge, token); }, delay);
  }

  async function pollSignIn(challenge: BoatSignInChallenge, token: NonNullable<typeof signInPoll>): Promise<void> {
    if (signInPoll !== token) return;
    const expiresAt = Date.parse(challenge.expiresAt);
    if (Number.isFinite(expiresAt) && Date.now() >= expiresAt) {
      expireSignIn(challenge.claimId);
      return;
    }
    const interval = challenge.intervalSeconds * 1_000;
    try {
      const result = await ctx.controller.boatPollSignIn(challenge.claimId);
      if (signInPoll !== token || disposed) return;
      const live = current('boat-signin');
      if (!live || live.challenge.claimId !== challenge.claimId) return;
      if (result.status === 'connected') {
        stopSignInPoll();
        ctx.setState(boatStateAfterAccount(result.snapshot, live.intent, live.draft), 'boat 계정을 연결했습니다.');
        return;
      }
      if (result.status === 'expired') {
        expireSignIn(challenge.claimId);
        return;
      }
      token.failures = 0;
      scheduleSignInPoll(challenge, interval);
    } catch {
      if (signInPoll !== token) return;
      token.failures += 1;
      scheduleSignInPoll(challenge, interval * Math.min(4, 2 ** token.failures));
    }
  }

  function syncSignInPoll(): void {
    const live = current('boat-signin');
    const wanted = ctx.visible() && live?.beat === 'code' && !live.expired ? live.challenge : null;
    if (!wanted) {
      stopSignInPoll();
      return;
    }
    if (signInPoll?.claimId === wanted.claimId) return;
    stopSignInPoll();
    signInPoll = { claimId: wanted.claimId, timer: 0, failures: 0 };
    scheduleSignInPoll(wanted, wanted.intervalSeconds * 1_000);
  }

  /* ── 요금제 ─────────────────────────────────────────── */

  function renderBilling(state: Extract<BoatSetupState, { kind: 'boat-billing' }>, parts: BoatSetupParts): void {
    const { draft, intent } = state;
    parts.title.textContent = 'boat 요금제 필요';
    parts.body.append(ctx.description('서버를 만들려면 boat 요금제가 필요합니다.'));
    if (state.opened) parts.body.append(waitingRow('결제 확인 중'));
    const back = ctx.button('뒤로');
    back.addEventListener('click', () => ctx.chooseAgain(intent, draft));
    const primary = ctx.button('결제 페이지 열기', state.opened ? 'quiet' : 'primary');
    primary.classList.add(AUTOFOCUS);
    primary.disabled = state.pending;
    primary.addEventListener('click', async () => {
      const live = current('boat-billing');
      if (!live || live.pending) return;
      ctx.setState({ ...live, pending: true });
      const opened = await openLink('checkout');
      const after = current('boat-billing');
      if (!after) return;
      ctx.setState({ ...after, opened: after.opened || opened, pending: false },
        opened ? '결제를 마치면 자동으로 이어집니다.' : '결제 페이지를 열지 못했습니다.');
    });
    parts.footer.append(back, primary);
  }

  function syncBillingPoll(): void {
    const live = current('boat-billing');
    const wanted = ctx.visible() && live?.opened === true;
    if (!wanted) {
      window.clearInterval(billingTimer);
      billingTimer = 0;
      return;
    }
    if (billingTimer) return;
    billingTimer = window.setInterval(() => {
      // 데스크톱도 결제를 확인하지만, 창이 열려 있는 동안은 직접 한 번 더 묻는다.
      void ctx.controller.boatRefresh().catch(() => {});
    }, BILLING_POLL_MS);
  }

  /* ── 확인 · 준비 · 실패 · 완료 ──────────────────────── */

  async function startSetup(intent: CloudSetupIntent, draft: CloudProfileDraft): Promise<void> {
    const operation = ctx.beginOperation();
    const startedAt = Date.now();
    ctx.setState({ kind: 'boat-progress', draft, intent, startedAt }, 'boat 서버를 준비하고 있습니다.');
    try {
      const next = await ctx.controller.boatSetup(BOAT_MACHINE);
      if (!ctx.operationIsCurrent(operation)) return;
      const live = current('boat-progress');
      if (live) {
        const settled = reconcileBoatState(live, next);
        if (settled !== live) ctx.setState(settled, settled.kind === 'boat-ready' ? 'boat 서버가 준비되었습니다.' : '');
      }
      // 완료 스냅샷이 명령 응답보다 늦게 와도 작성해 둔 요청은 한 번만 보낸다.
      if (current('boat-ready') && intent === 'transfer') ctx.continueTransfer(intent);
    } catch (cause) {
      if (!ctx.operationIsCurrent(operation) || !current('boat-progress')) return;
      const code = (cause as { code?: unknown } | null)?.code;
      if (code === 'BOAT_BILLING_REQUIRED') {
        ctx.setState({ kind: 'boat-billing', draft, intent, opened: false, pending: false }, 'boat 요금제가 필요합니다.');
        return;
      }
      if (code === 'BOAT_AUTH_INVALID') {
        const message = cause instanceof Error ? cause.message : String(cause);
        ctx.setState({ kind: 'boat-connect', draft, intent, email: '', error: message, pending: false }, message);
        return;
      }
      ctx.setState({ kind: 'boat-failed', draft, intent, issue: boatSetupIssue(cause) }, 'boat 서버를 준비하지 못했습니다.');
    }
  }

  function renderConfirm(state: Extract<BoatSetupState, { kind: 'boat-confirm' }>, parts: BoatSetupParts): void {
    const { draft, intent } = state;
    const existing = ctx.snapshot().boat?.server ?? null;
    parts.title.textContent = existing ? 'boat 서버 연결' : 'boat 서버 만들기';
    parts.body.append(facts([
      ['사양', existing?.machineLabel || BOAT_MACHINE_LABELS[existing?.machine ?? BOAT_MACHINE]],
      ['지역', BOAT_REGION_LABEL],
      ['자동 중지', boatIdleLabel(existing?.idleStopMinutes ?? BOAT_DEFAULT_IDLE_MINUTES)],
    ]));
    const context = ctx.transferContext(intent);
    if (context) parts.body.append(context);
    const back = ctx.button('뒤로');
    back.addEventListener('click', () => ctx.chooseAgain(intent, draft));
    const primary = ctx.button(existing ? '서버 연결' : '서버 만들기', 'primary');
    primary.classList.add(AUTOFOCUS);
    primary.addEventListener('click', () => {
      if (!current('boat-confirm')) return;
      void startSetup(intent, draft);
    });
    parts.footer.append(back, primary);
  }

  function activeSetup(state: Extract<BoatSetupState, { kind: 'boat-progress' }>): BoatSetupProgress {
    const setup = ctx.snapshot().boat?.setup ?? null;
    const setupAt = setup ? Date.parse(setup.startedAt) : Number.NaN;
    if (setup && !setup.error && (!Number.isFinite(setupAt) || setupAt >= state.startedAt - 2_000)) return setup;
    return {
      stage: 'creating', startedAt: new Date(state.startedAt).toISOString(), detail: null, error: null, importedProviders: [],
    };
  }

  function paintProgress(state: Extract<BoatSetupState, { kind: 'boat-progress' }>): void {
    if (!progressList) return;
    const setup = activeSetup(state);
    const key = JSON.stringify([setup.stage, setup.detail]);
    const startedAt = Date.parse(setup.startedAt);
    const elapsed = formatBoatElapsed(Date.now() - (Number.isFinite(startedAt) ? startedAt : state.startedAt));
    if (key === progressKey) {
      const clock = progressList.querySelector<HTMLElement>('.ag-cloud-setup-stage-time');
      if (clock) clock.textContent = elapsed;
      return;
    }
    progressKey = key;
    const rows = boatStageRows(setup.stage, ctx.platform);
    progressList.replaceChildren(...rows.map((row) => {
      const item = el('li', 'ag-cloud-setup-stage');
      item.dataset.status = row.status;
      const mark = el('span', 'ag-cloud-setup-stage-mark');
      mark.setAttribute('aria-hidden', 'true');
      if (row.status === 'done') mark.append(createIcon('check'));
      else if (row.status === 'active') mark.append(el('span', 'ag-cloud-setup-stage-spinner ui-spinner'));
      else mark.append(createIcon('pending'));
      const copy = el('span', 'ag-cloud-setup-stage-copy');
      const label = el('span', 'ag-cloud-setup-stage-label', row.label);
      copy.append(label);
      if (row.status === 'active' && setup.detail) {
        const detail = el('span', 'ag-cloud-setup-stage-detail', setup.detail);
        detail.title = setup.detail;
        copy.append(detail);
      }
      item.append(mark, copy);
      if (row.status === 'active') {
        item.setAttribute('aria-current', 'step');
        item.append(el('span', 'ag-cloud-setup-stage-time', elapsed));
      }
      const status = row.status === 'done' ? '완료' : row.status === 'active' ? '진행 중' : '대기';
      item.setAttribute('aria-label', `${row.label}, ${status}`);
      return item;
    }));
    const active = rows.find((row) => row.status === 'active');
    if (active && active.label !== lastAnnouncedStage) {
      lastAnnouncedStage = active.label;
      ctx.announce(active.label);
    }
  }

  function renderProgress(state: Extract<BoatSetupState, { kind: 'boat-progress' }>, parts: BoatSetupParts): void {
    parts.title.textContent = 'boat 서버 준비 중';
    progressList = el('ol', 'ag-cloud-setup-stages');
    progressList.setAttribute('aria-label', '준비 단계');
    progressKey = '';
    paintProgress(state);
    parts.body.append(progressList);
    const context = ctx.transferContext(state.intent);
    if (context) parts.body.append(context);
    const hide = ctx.button('숨기기');
    hide.addEventListener('click', () => ctx.close());
    parts.footer.append(hide);
  }

  function syncClock(): void {
    const live = current('boat-progress');
    if (!live || !ctx.visible()) {
      window.clearInterval(clockTimer);
      clockTimer = 0;
      if (!live) progressList = null;
      return;
    }
    clockTimer ||= window.setInterval(() => {
      const state = current('boat-progress');
      if (state) paintProgress(state);
    }, 1_000);
  }

  function renderFailed(state: Extract<BoatSetupState, { kind: 'boat-failed' }>, parts: BoatSetupParts): void {
    const { draft, intent, issue } = state;
    parts.title.textContent = 'boat 서버를 준비하지 못했습니다';
    parts.body.append(ctx.description(issue.guidance || issue.title));
    if (issue.detail.trim()) parts.body.append(ctx.issueDetails(issue, '자세히'));
    const context = ctx.transferContext(intent);
    if (context) parts.body.append(context);
    const dismiss = ctx.button('닫기');
    dismiss.addEventListener('click', () => ctx.close());
    const retry = ctx.button('다시 시도', 'primary');
    retry.classList.add(AUTOFOCUS);
    retry.addEventListener('click', () => {
      if (!current('boat-failed')) return;
      void startSetup(intent, draft);
    });
    parts.footer.append(dismiss, retry);
  }

  function renderReady(state: Extract<BoatSetupState, { kind: 'boat-ready' }>, parts: BoatSetupParts): void {
    const snapshot = ctx.snapshot();
    const server = snapshot.boat?.server ?? null;
    const machine = server?.machine ?? snapshotBoatProfile(snapshot)?.machine ?? BOAT_MACHINE;
    parts.title.textContent = 'boat 서버가 준비되었습니다';
    const rows: Array<[string, string]> = [
      ['사양', server?.machineLabel || BOAT_MACHINE_LABELS[machine]],
      ['지역', BOAT_REGION_LABEL],
    ];
    if (state.importedProviders.length) rows.push(['로그인 정보', boatProvidersLabel(state.importedProviders)]);
    parts.body.append(facts(rows));
    const primary = ctx.button(state.intent === 'transfer' ? 'Cloud로 계속' : '완료', 'primary');
    primary.classList.add(AUTOFOCUS);
    primary.addEventListener('click', () => {
      if (state.intent === 'transfer') ctx.continueTransfer('transfer');
      else ctx.close(true);
    });
    parts.footer.append(primary);
  }

  return {
    render(state, parts) {
      if (state.kind !== 'boat-progress') progressList = null;
      switch (state.kind) {
        case 'boat-connect': renderConnect(state, parts); break;
        case 'boat-key': renderKey(state, parts); break;
        case 'boat-signin': renderSignIn(state, parts); break;
        case 'boat-billing': renderBilling(state, parts); break;
        case 'boat-confirm': renderConfirm(state, parts); break;
        case 'boat-progress': renderProgress(state, parts); break;
        case 'boat-failed': renderFailed(state, parts); break;
        case 'boat-ready': renderReady(state, parts); break;
      }
    },
    refresh() {
      const live = current('boat-progress');
      if (live && ctx.visible()) paintProgress(live);
    },
    sync() {
      if (disposed) return;
      syncSignInPoll();
      syncBillingPoll();
      syncClock();
    },
    dispose() {
      disposed = true;
      stopSignInPoll();
      window.clearInterval(billingTimer);
      window.clearInterval(clockTimer);
      window.clearTimeout(copyTimer);
      billingTimer = 0;
      clockTimer = 0;
    },
  };
}
