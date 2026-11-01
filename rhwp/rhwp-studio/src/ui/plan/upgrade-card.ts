// 요금제 카드. 무료 / Hama / Rau 를 나란히 두고, 결제는 데스크톱 main 이 연다(rhwpDesktop.plan).
// 결제를 시작하면 카드는 확인을 기다리고, 요금제가 산 등급으로 바뀌면 잠깐 알리고 닫힌다.
// Rau 칸은 계정이 체험을 쓸 수 있으면 '7일 무료 체험'도 둔다. 체험은 계정 API(startRauTrial)로 시작하고 결제처럼 닫힌다.
// 로그아웃 상태의 결제·체험은 카드를 닫고 계정 페이지의 로그인으로 보낸 뒤, 로그인하면 카드로 돌아온다.
// 어디서든 window 의 'rhwp:open-plan-card' 이벤트로 연다(detail.focus 로 Hama·Rau 칸을 짚는다).
import '../agent-sidebar/sheet.css';
import './upgrade-card.css';
import { createRauArt, stretchRauArt, type RauArt } from './rau-art.ts';
import { createSheetFrame } from '../agent-sidebar/sheet.ts';
import { createIcon } from '../agent-sidebar/icons.ts';
import { openAccountPage } from '../account/account-page.ts';
import { accountStore, type AccountStore } from '../account/account-store.ts';
import { planCardKind, trialButtonLabel } from '../account/account-format.ts';
import { createHamaMark } from './hama-mark.ts';
import type { DesktopLicenseApi } from '../agent-sidebar/settings-license.ts';
import { PLAN_CYCLES, PLAN_FAMILY_LABEL, planPrice, planSkuAvailable, won, type PlanFamily } from './plan-offers.ts';
import type { PlanStore } from './plan-store.ts';
import { tierForSku, tierRank, type PlanSku, type PlanStatus, type PlanTier } from './plan-types.ts';

export const OPEN_PLAN_CARD_EVENT = 'rhwp:open-plan-card';
export type PlanCardFocus = PlanFamily;

const SUCCESS_HOLD_MS = 1200;

const TIER_LABEL: Record<PlanTier, string> = { free: '무료', hama: 'Hama', rau: 'Rau' };
const SKU_LABEL: Record<PlanSku, string> = { hamaMonthly: 'Hama 월간', hamaYearly: 'Hama 연간', rauMonthly: 'Rau 월간', rauYearly: 'Rau 연간' };
/** 칸마다 한두 줄. 모델·회사 이름은 쓰지 않는다. */
const FEATURES: Record<'free' | PlanFamily, string[]> = {
  free: ['문서 편집'],
  hama: ['내 AI 연결'],
  rau: ['Hama의 모든 기능', 'Rau 모드'],
};

/** 요금제 이름 앞의 마크. 무료는 없다. */
export function planMark(plan: 'free' | PlanFamily, className: string): Element | null {
  if (plan === 'hama') return createHamaMark(`${className} ${className}-hama`);
  if (plan === 'rau') return createHamaMark(`${className} ${className}-rau`);
  return null;
}

export interface PlanCardOptions {
  store: PlanStore;
  license: DesktopLicenseApi | null;
  /** 결제 전 로그인할 계정. 생략하면 창의 계정 상태를 쓴다. */
  account?: AccountStore;
  focus?: PlanCardFocus;
}

export type PlanChooserView = 'plans' | 'waiting' | 'done';

export interface PlanChooserOptions {
  store: PlanStore;
  account?: AccountStore;
  focus?: PlanCardFocus;
  /** 결제나 체험을 확인하고 잠깐 알린 뒤. */
  onFinish: () => void;
  /** 완료를 알리는 시간. 다음 화면이 알려 주면 0 을 넘긴다. */
  doneHoldMs?: number;
  /** 그릴 때마다. busy 면 결제나 체험이 진행 중이다. */
  onRender?: (view: PlanChooserView, busy: boolean) => void;
  /** 로그인으로 보낸다. 생략하면 계정 페이지만 연다. 보내지 못하면 false. */
  signIn?: (focus: PlanCardFocus | undefined) => boolean;
}

export interface PlanChooser {
  element: HTMLElement;
  focusColumn(target: PlanCardFocus | undefined): void;
  focusTarget(): HTMLElement | null;
  dispose(): void;
}

export interface PlanCardHandle {
  close(): void;
  closed: Promise<void>;
}

let openCard: { handle: PlanCardHandle; focus(target: PlanCardFocus | undefined): void } | null = null;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function button(className: string, text: string): HTMLButtonElement {
  const node = el('button', className, text);
  node.type = 'button';
  return node;
}

/**
 * 세 칸과 결제·체험 흐름. 틀이 없어 시트 카드와 처음 설정의 요금제 장이 함께 쓴다.
 * 결제나 체험을 확인하고 잠깐 알린 뒤 onFinish 를 부른다.
 */
export function createPlanChooser(options: PlanChooserOptions): PlanChooser {
  const { store } = options;
  const api = store.api!;
  const account = options.account ?? accountStore();
  const body = el('div', 'ag-pricing-body');
  /** 다시 그려도 물결이 끊기지 않게 하나를 옮겨 붙인다. */
  let rauArt: RauArt | null = null;
  let stopStretch: () => void = () => {};

  let view: PlanChooserView = 'plans';
  /** 결제한 상품의 등급이 되면 성공. */
  let awaiting: { sku: PlanSku; fromTier: PlanTier } | null = null;
  const awaitingFor = (sku: PlanSku): { sku: PlanSku; fromTier: PlanTier } => ({ sku, fromTier: status()?.tier ?? 'free' });
  let notice = '';
  let checkoutBusy = false;
  let trialBusy = false;
  /** 완료 단추의 등급. 체험은 요금제 상태보다 먼저 끝날 수 있어 따로 든다. */
  let doneTier: PlanTier | null = null;
  let focused: PlanCardFocus | undefined = options.focus;
  let successTimer: number | null = null;

  const status = (): PlanStatus | null => store.status();

  function price(sku: PlanSku): number | null {
    return planPrice(status(), sku);
  }

  function available(sku: PlanSku): boolean {
    return planSkuAvailable(status(), sku);
  }

  /** 프로모션 키로 쓰는 중. 그 등급의 정식 버전을 살 수 있다. */
  function onPromo(): boolean {
    const current = account.status();
    return current?.state === 'signed_in' && planCardKind(current.plan) === 'gift';
  }

  /** 계정의 Rau 체험. 로그아웃이면 상태를 모르므로 단추를 두고 로그인으로 보낸다. */
  function trialState(): 'available' | 'active' | 'none' {
    if (!account.api?.startRauTrial) return 'none';
    const current = account.status();
    if (!current || current.state !== 'signed_in') return current?.available === false ? 'none' : 'available';
    if (current.trial?.state === 'active' && current.plan.rau?.source === 'trial') return 'active';
    if (current.trial?.state === 'available' && current.plan.tier !== 'rau') return 'available';
    return 'none';
  }

  async function beginTrial(): Promise<void> {
    if (doneTier !== null || trialBusy || checkoutBusy) return;
    const current = account.status();
    if (current?.state !== 'signed_in') {
      if (sendToSignIn()) return;
      notice = '먼저 로그인해 주세요.';
      render();
      return;
    }
    trialBusy = true;
    notice = '';
    render();
    try {
      const result = await account.api!.startRauTrial!();
      if (result.ok) {
        doneTier = 'rau';
        showDone();
        return;
      }
      if (result.code === 'session_invalid' && sendToSignIn()) return;
      notice = result.message;
    } catch {
      notice = '서버에 연결하지 못했어요. 인터넷 연결을 확인해 주세요.';
    } finally {
      trialBusy = false;
      if (view !== 'done') render();
    }
  }

  function showDone(): void {
    view = 'done';
    if (successTimer === null) successTimer = window.setTimeout(options.onFinish, options.doneHoldMs ?? SUCCESS_HOLD_MS);
    render();
  }

  /** 계정 페이지의 로그인으로 보낸다. 시트 카드는 닫았다가 로그인하면 같은 칸을 짚어 돌아온다. */
  function sendToSignIn(): boolean {
    return options.signIn
      ? options.signIn(focused)
      : openAccountPage({ store: account, plan: store, section: 'sign-in' }) !== null;
  }

  async function begin(sku: PlanSku): Promise<void> {
    if (doneTier !== null || checkoutBusy || trialBusy) return;
    checkoutBusy = true;
    notice = '';
    render();
    try {
      const result = await api.startCheckout(sku);
      if (result.code === 'sign_in_required') {
        if (!sendToSignIn()) notice = '먼저 로그인해 주세요.';
        return;
      }
      if (result.ok || result.code === 'busy') {
        awaiting = awaitingFor(result.status.pendingCheckout?.sku ?? sku);
        view = 'waiting';
      }
    } catch {
      notice = '결제 페이지를 열지 못했어요';
    } finally {
      checkoutBusy = false;
      render();
    }
  }

  async function cancelCheckout(): Promise<void> {
    awaiting = null;
    view = 'plans';
    render();
    try { await api.cancelCheckout(); } catch { /* 다음 상태가 다시 그린다 */ }
  }

  function reached(current: PlanStatus): boolean {
    if (!awaiting) return false;
    // main 이 이 결제를 확인했거나, 산 등급으로 올라섰다(체험 중 Rau 를 사면 등급이 그대로라 확인만 본다).
    if (current.lastCheckout?.ok && current.lastCheckout.sku === awaiting.sku && current.pendingCheckout === null) return true;
    const target = tierRank(tierForSku(awaiting.sku));
    return tierRank(awaiting.fromTier) < target && tierRank(current.tier) >= target;
  }

  function settleIfDone(): void {
    const current = status();
    if (view === 'done' || !current) return;
    if (!reached(current)) {
      // 결제를 기다리다 main 이 접었다(취소·거절·포기).
      if (view === 'waiting' && current.pendingCheckout === null) {
        const last = current.lastCheckout;
        if (last && !last.ok) notice = last.code === 'timed_out'
          ? '결제 확인 시간이 지났어요. 잠시 후 다시 시도해 주세요.'
          : last.code === 'revoked' ? '결제가 취소되었어요' : '결제를 확인하지 못했어요';
        if (!last?.ok) {
          awaiting = null;
          view = 'plans';
        }
      }
      return;
    }
    doneTier = tierForSku(awaiting!.sku);
    view = 'done';
    successTimer = window.setTimeout(options.onFinish, options.doneHoldMs ?? SUCCESS_HOLD_MS);
  }

  function planColumn(plan: 'free' | PlanFamily, tier: PlanTier | null): HTMLElement {
    const column = el('article', 'ag-pricing-col');
    column.dataset.plan = plan;
    if (plan === 'rau') {
      rauArt ??= createRauArt();
      column.append(rauArt.element);
      column.addEventListener('click', () => {
        const host = body.closest<HTMLElement>('.ag-pricing-card, .rhwp-setup-dialog');
        if (!host) return;
        stopStretch();
        stopStretch = stretchRauArt(host, column);
      });
    }
    const trial = plan === 'rau' ? trialState() : 'none';
    const current = tier === plan;
    if (current) column.dataset.current = 'true';
    if (focused === plan) column.dataset.focus = 'true';
    const name = el('div', 'ag-pricing-name', plan === 'free' ? '무료' : PLAN_FAMILY_LABEL[plan]);
    const mark = planMark(plan, 'ag-pricing-mark');
    if (mark) name.prepend(mark);
    const priceRow = el('div', 'ag-pricing-price');
    const features = el('ul', 'ag-pricing-features');
    const actions = el('div', 'ag-pricing-actions');
    if (plan === 'free') {
      priceRow.append(el('span', 'ag-pricing-amount', '₩0'));
    } else {
      const monthly = price(PLAN_CYCLES[plan].monthly);
      const yearly = price(PLAN_CYCLES[plan].yearly);
      priceRow.append(el('span', 'ag-pricing-amount', monthly === null ? '—' : won(monthly)), el('span', 'ag-pricing-unit', '/월'));
      if (yearly !== null) priceRow.append(el('span', 'ag-pricing-alt', `연 ${won(yearly)}`));
    }
    for (const line of FEATURES[plan]) features.append(el('li', '', line));

    // 체험 중이거나 프로모션으로 쓰는 등급은 표시를 두고 계속 쓸 결제 단추를 그대로 둔다.
    if (view === 'done' && doneTier === plan) {
      const done = button('ag-pricing-btn ag-pricing-btn-primary ag-pricing-btn-success', '');
      done.disabled = true;
      done.setAttribute('aria-label', `${TIER_LABEL[plan]} 활성화 완료`);
      done.append(createIcon('check'));
      actions.setAttribute('role', 'status');
      actions.setAttribute('aria-label', `${TIER_LABEL[plan]} 활성화 완료`);
      actions.append(done);
    } else if (current && trial !== 'active' && !onPromo()) {
      actions.append(el('span', 'ag-pricing-current', '사용 중'));
    } else if (plan !== 'free' && !(plan === 'hama' && tier === 'rau')) {
      if (trial === 'active') actions.append(el('span', 'ag-pricing-current ag-pricing-trial-tag', '체험 중'));
      else if (current) actions.append(el('span', 'ag-pricing-current ag-pricing-trial-tag', '프로모션'));
      const { monthly, yearly } = PLAN_CYCLES[plan];
      // 체험을 쓸 수 있으면 체험만 권한다. 체험을 쓴 뒤에 결제 단추가 선다.
      const skus = trial === 'available' ? [] : [monthly, yearly].filter(available);
      if (trial === 'available') {
        const start = button('ag-pricing-btn ag-pricing-btn-primary ag-pricing-btn-trial', trialButtonLabel(account.status()?.trial));
        start.dataset.trial = 'rau';
        start.disabled = view === 'done' || trialBusy || checkoutBusy;
        start.addEventListener('click', () => { void beginTrial(); });
        actions.append(start);
      }
      if (skus.length === 0 && trial !== 'available') actions.append(soonButton());
      for (const sku of skus) {
        const primary = sku === monthly && trial !== 'available';
        const buy = button(primary ? 'ag-pricing-btn ag-pricing-btn-primary' : 'ag-pricing-btn', sku === monthly ? '월간' : '연간');
        buy.dataset.sku = sku;
        buy.disabled = view === 'done' || checkoutBusy || trialBusy;
        buy.addEventListener('click', () => { void begin(sku); });
        actions.append(buy);
      }
    }
    column.append(name, priceRow, features, actions);
    return column;
  }

  function soonButton(): HTMLButtonElement {
    const soon = button('ag-pricing-btn', '곧 출시');
    soon.disabled = true;
    return soon;
  }

  function renderPlans(): void {
    const tier = status()?.tier ?? null;
    const grid = el('div', 'ag-pricing-grid');
    grid.append(planColumn('free', tier), planColumn('hama', tier), planColumn('rau', tier));
    body.append(grid);
    const foot = el('div', 'ag-pricing-foot');
    const message = el('p', 'ag-pricing-notice', notice);
    message.setAttribute('role', 'status');
    message.hidden = !notice;
    foot.append(message);
    if (notice) body.append(foot);
  }

  function renderWaiting(): void {
    const wait = el('div', 'ag-pricing-state');
    const spinner = el('span', 'ui-spinner ag-pricing-spinner');
    spinner.setAttribute('aria-hidden', 'true');
    const title = el('p', 'ag-pricing-state-title', '결제 확인 중');
    title.setAttribute('role', 'status');
    const sku = awaiting?.sku ?? status()?.pendingCheckout?.sku ?? null;
    wait.append(spinner, title);
    if (sku) wait.append(el('p', 'ag-pricing-state-meta', SKU_LABEL[sku]));
    const actions = el('div', 'ag-pricing-state-actions');
    const cancel = button('ag-pricing-btn', '취소');
    cancel.addEventListener('click', () => { void cancelCheckout(); });
    actions.append(cancel);
    wait.append(actions);
    body.append(wait);
  }

  function render(): void {
    body.replaceChildren();
    options.onRender?.(view, view !== 'plans' || checkoutBusy || trialBusy);
    if (view === 'waiting') renderWaiting();
    else renderPlans();
  }

  function focusColumn(target: PlanCardFocus | undefined): void {
    if (target !== focused) {
      focused = target;
      if (view === 'plans') render();
    }
    if (target) body.querySelector(`.ag-pricing-col[data-plan="${target}"]`)?.scrollIntoView({ block: 'nearest' });
  }

  if (status()?.pendingCheckout) {
    awaiting = awaitingFor(status()!.pendingCheckout!.sku);
    view = 'waiting';
  }
  render();

  const unsubscribeAccount = account.subscribe(() => {
    if (view === 'plans') render();
  });
  const unsubscribe = store.subscribe(() => {
    if (view === 'done') return;
    if (view === 'plans' && status()?.pendingCheckout && !awaiting) {
      awaiting = awaitingFor(status()!.pendingCheckout!.sku);
      view = 'waiting';
    }
    settleIfDone();
    render();
  });

  return {
    element: body,
    focusColumn,
    focusTarget: () => body.querySelector<HTMLElement>(
      focused ? `.ag-pricing-col[data-plan="${focused}"] button:not([disabled])` : '.ag-pricing-btn-primary:not([disabled])',
    ),
    dispose(): void {
      rauArt?.dispose();
      stopStretch();
      unsubscribe();
      unsubscribeAccount();
      if (successTimer !== null) window.clearTimeout(successTimer);
    },
  };
}

/** 열린 카드가 있으면 그 카드를 짚고, 없으면 새로 연다. 요금제 API 가 없으면 열지 않는다. */
export function openPlanCard(options: PlanCardOptions): PlanCardHandle | null {
  if (!options.store.api) return null;
  if (openCard) {
    openCard.focus(options.focus);
    return openCard.handle;
  }
  const { store } = options;
  const account = options.account ?? accountStore();
  const frame = createSheetFrame({
    title: '요금제',
    center: true,
    role: 'dialog',
    className: 'ag-pricing-card',
    dragIgnore: 'button, label, input',
  });
  const { sheet, header } = frame;

  const head = el('div', 'ag-pricing-head');
  header.replaceWith(head);
  const close = button('ag-pricing-close', '');
  close.setAttribute('aria-label', '닫기');
  close.append(createIcon('close'));
  head.append(header, close);

  const chooser = createPlanChooser({
    store,
    account,
    ...(options.focus ? { focus: options.focus } : {}),
    onFinish: () => finish(true),
    onRender: (view) => { sheet.dataset.view = view; },
    signIn: (back) => {
      const page = openAccountPage({
        store: account,
        plan: store,
        section: 'sign-in',
        onSignedIn: () => { openPlanCard({ ...options, ...(back ? { focus: back } : {}) }); },
      });
      if (!page) return false;
      finish(false);
      return true;
    },
  });
  sheet.append(chooser.element);

  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => { resolveClosed = resolve; });
  const finish = frame.present(
    () => chooser.focusTarget() ?? close,
    () => {
      chooser.dispose();
      openCard = null;
      resolveClosed();
    },
  );
  close.addEventListener('click', () => finish(false));
  const handle: PlanCardHandle = { close: () => finish(false), closed };
  openCard = { handle, focus: chooser.focusColumn };
  if (options.focus) requestAnimationFrame(() => chooser.focusColumn(options.focus));
  return handle;
}

/**
 * window 의 'rhwp:open-plan-card' 를 카드로 잇는다. 창마다 하나만 듣는다 — 다시 부르면 앞의 것을 바꾼다.
 * 돌려준 함수로 떼면 그 뒤로는 듣지 않는다.
 */
let detachPlanCardEvents: (() => void) | null = null;
export function listenForPlanCardEvents(options: Omit<PlanCardOptions, 'focus'>): () => void {
  detachPlanCardEvents?.();
  const onOpen = (event: Event): void => {
    const detail = (event as CustomEvent<{ focus?: unknown } | null>).detail;
    const focus = detail?.focus === 'hama' || detail?.focus === 'rau' ? detail.focus : undefined;
    openPlanCard({ ...options, ...(focus ? { focus } : {}) });
  };
  window.addEventListener(OPEN_PLAN_CARD_EVENT, onOpen);
  const detach = (): void => {
    window.removeEventListener(OPEN_PLAN_CARD_EVENT, onOpen);
    if (detachPlanCardEvents === detach) detachPlanCardEvents = null;
  };
  detachPlanCardEvents = detach;
  return detach;
}
