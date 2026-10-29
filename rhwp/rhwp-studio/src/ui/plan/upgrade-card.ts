// 요금제 카드. 무료 / Pro / Hama 를 나란히 두고, 결제는 데스크톱 main 이 연다(rhwpDesktop.plan).
// 결제를 시작하면 카드는 확인을 기다리고, 요금제가 산 등급으로 바뀌면 잠깐 알리고 닫힌다.
// 키를 직접 붙여 넣는 길은 rhwpDesktop.license.activate 를 쓴다.
// 어디서든 window 의 'rhwp:open-plan-card' 이벤트로 연다(detail.focus 로 Pro·Hama 칸을 짚는다).
import '../agent-sidebar/sheet.css';
import './upgrade-card.css';
import { createSheetFrame } from '../agent-sidebar/sheet.ts';
import { createIcon } from '../agent-sidebar/icons.ts';
import type { DesktopLicenseApi } from '../agent-sidebar/settings-license.ts';
import type { PlanStore } from './plan-store.ts';
import { tierForSku, type PlanSku, type PlanStatus, type PlanTier } from './plan-types.ts';

export const OPEN_PLAN_CARD_EVENT = 'rhwp:open-plan-card';
export type PlanCardFocus = 'pro' | 'hama';

const DEFAULT_PRICE: Record<PlanSku, number | null> = { proMonthly: 3900, proYearly: 39000, hama: null };
const SUCCESS_HOLD_MS = 1200;

const TIER_LABEL: Record<PlanTier, string> = { free: '무료', pro: 'Pro', legacy: '기존 라이선스', hama: 'Hama' };
const SKU_LABEL: Record<PlanSku, string> = { proMonthly: 'Pro · 월간', proYearly: 'Pro · 연간', hama: 'Hama' };

export interface PlanCardOptions {
  store: PlanStore;
  license: DesktopLicenseApi | null;
  focus?: PlanCardFocus;
}

export interface PlanCardHandle {
  close(): void;
  closed: Promise<void>;
}

let openCard: { handle: PlanCardHandle; focus(target: PlanCardFocus | undefined): void } | null = null;

function won(value: number): string {
  return `₩${value.toLocaleString('ko-KR')}`;
}

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

/** 열린 카드가 있으면 그 카드를 짚고, 없으면 새로 연다. 요금제 API 가 없으면 열지 않는다. */
export function openPlanCard(options: PlanCardOptions): PlanCardHandle | null {
  if (!options.store.api) return null;
  if (openCard) {
    openCard.focus(options.focus);
    return openCard.handle;
  }
  const { store, license } = options;
  const api = store.api!;
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
  const legacyMark = el('span', 'ag-pricing-badge', '기존 라이선스');
  legacyMark.hidden = true;
  const close = button('ag-pricing-close', '');
  close.setAttribute('aria-label', '닫기');
  close.append(createIcon('close'));
  head.append(header, legacyMark, close);

  const body = el('div', 'ag-pricing-body');
  sheet.append(body);

  type View = 'plans' | 'waiting' | 'key' | 'done';
  let view: View = 'plans';
  /** 이 등급이 되면 성공. 결제는 산 등급, 키는 에이전트가 열리는 아무 등급. */
  let awaiting: { sku: PlanSku | null } | null = null;
  let notice = '';
  let keyError = '';
  let keyBusy = false;
  let keyValue = '';
  let checkoutBusy = false;
  let focused: PlanCardFocus | undefined = options.focus;
  let successTimer: number | null = null;

  const status = (): PlanStatus | null => store.status();

  function price(sku: PlanSku): number | null {
    return status()?.checkout[sku]?.priceKrw ?? DEFAULT_PRICE[sku];
  }

  function available(sku: PlanSku): boolean {
    return status()?.checkout[sku]?.available === true;
  }

  async function begin(sku: PlanSku): Promise<void> {
    if (checkoutBusy) return;
    checkoutBusy = true;
    notice = '';
    render();
    try {
      const result = await api.startCheckout(sku);
      if (result.ok || result.code === 'busy') {
        awaiting = { sku: result.status.pendingCheckout?.sku ?? sku };
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

  async function activateKey(): Promise<void> {
    const key = keyValue.trim();
    if (!license || !key || keyBusy) return;
    keyBusy = true;
    keyError = '';
    render();
    try {
      const result = await license.activate(key);
      if (!result.ok) keyError = result.message || '키를 활성화하지 못했어요';
      else {
        awaiting = { sku: null };
        settleIfDone();
      }
    } catch {
      keyError = '키를 활성화하지 못했어요';
    } finally {
      keyBusy = false;
      render();
    }
  }

  function reached(current: PlanStatus): boolean {
    if (!awaiting) return false;
    if (awaiting.sku === null) return current.agentUnlocked && current.tier !== 'free';
    return current.tier === tierForSku(awaiting.sku);
  }

  function settleIfDone(): void {
    const current = status();
    if (view === 'done' || !current) return;
    if (!reached(current)) {
      // 결제를 기다리다 main 이 접었다(취소·거절·포기).
      if (view === 'waiting' && current.pendingCheckout === null) {
        const last = current.lastCheckout;
        if (last && !last.ok) notice = last.code === 'revoked' ? '결제가 취소되었어요' : '결제를 확인하지 못했어요';
        if (!last?.ok) {
          awaiting = null;
          view = 'plans';
        }
      }
      return;
    }
    view = 'done';
    successTimer = window.setTimeout(() => finish(true), SUCCESS_HOLD_MS);
  }

  function planColumn(plan: 'free' | 'pro' | 'hama', tier: PlanTier | null): HTMLElement {
    const column = el('article', 'ag-pricing-col');
    column.dataset.plan = plan;
    const current = tier === plan;
    if (current) column.dataset.current = 'true';
    if (focused === plan) column.dataset.focus = 'true';
    const name = el('div', 'ag-pricing-name', plan === 'free' ? '무료' : plan === 'pro' ? 'Pro' : 'Hama');
    const priceRow = el('div', 'ag-pricing-price');
    const features = el('ul', 'ag-pricing-features');
    const actions = el('div', 'ag-pricing-actions');
    const lines: string[] = [];
    if (plan === 'free') {
      priceRow.append(el('span', 'ag-pricing-amount', '₩0'));
      lines.push('문서 편집·저장');
    } else if (plan === 'pro') {
      const monthly = price('proMonthly');
      const yearly = price('proYearly');
      priceRow.append(el('span', 'ag-pricing-amount', monthly === null ? '—' : won(monthly)), el('span', 'ag-pricing-unit', '/월'));
      if (yearly !== null) priceRow.append(el('span', 'ag-pricing-alt', `연 ${won(yearly)}`));
      lines.push('에이전트(BYOK)', 'Rau-0.1');
    } else {
      priceRow.append(el('span', 'ag-pricing-amount ag-pricing-amount-soon', '준비 중'));
      lines.push('Hama 에이전트');
    }
    for (const line of lines) features.append(el('li', '', line));

    if (current) {
      actions.append(el('span', 'ag-pricing-current', '사용 중'));
    } else if (plan === 'pro') {
      const skus = (['proMonthly', 'proYearly'] as const).filter(available);
      if (skus.length === 0) actions.append(soonButton());
      for (const sku of skus) {
        const buy = button(sku === 'proMonthly' ? 'ag-pricing-btn ag-pricing-btn-primary' : 'ag-pricing-btn', sku === 'proMonthly' ? '월간' : '연간');
        buy.dataset.sku = sku;
        buy.disabled = checkoutBusy;
        buy.addEventListener('click', () => { void begin(sku); });
        actions.append(buy);
      }
    } else if (plan === 'hama') {
      if (!available('hama')) actions.append(soonButton());
      else {
        const buy = button('ag-pricing-btn ag-pricing-btn-primary', '시작하기');
        buy.dataset.sku = 'hama';
        buy.disabled = checkoutBusy;
        buy.addEventListener('click', () => { void begin('hama'); });
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

  function keyLink(): HTMLButtonElement | null {
    if (!license) return null;
    const link = button('ag-pricing-link', '키 직접 입력');
    link.addEventListener('click', () => {
      view = 'key';
      keyError = '';
      render();
      sheet.querySelector<HTMLInputElement>('.ag-pricing-key-input')?.focus();
    });
    return link;
  }

  function renderPlans(): void {
    const tier = status()?.tier ?? null;
    const grid = el('div', 'ag-pricing-grid');
    grid.append(planColumn('free', tier), planColumn('pro', tier), planColumn('hama', tier));
    body.append(grid);
    const foot = el('div', 'ag-pricing-foot');
    const message = el('p', 'ag-pricing-notice', notice);
    message.setAttribute('role', 'status');
    message.hidden = !notice;
    foot.append(message);
    const link = keyLink();
    if (link) foot.append(link);
    if (notice || link) body.append(foot);
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
    const link = keyLink();
    if (link) actions.append(link);
    wait.append(actions);
    body.append(wait);
  }

  function renderKey(): void {
    const form = el('form', 'ag-pricing-key');
    form.noValidate = true;
    const row = el('div', 'ag-pricing-key-row');
    const input = el('input', 'ag-pricing-key-input');
    input.type = 'text';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.setAttribute('autocapitalize', 'characters');
    input.placeholder = 'HAMA-…';
    input.setAttribute('aria-label', '라이선스 키');
    input.value = keyValue;
    input.disabled = keyBusy;
    const submit = el('button', 'ag-pricing-btn ag-pricing-btn-primary', '활성화');
    submit.type = 'submit';
    submit.disabled = keyBusy || !keyValue.trim();
    input.addEventListener('input', () => {
      keyValue = input.value;
      submit.disabled = keyBusy || !keyValue.trim();
    });
    row.append(input, submit);
    const error = el('p', 'ag-pricing-error', keyError);
    error.setAttribute('role', 'alert');
    error.hidden = !keyError;
    const back = button('ag-pricing-link', '돌아가기');
    back.addEventListener('click', () => {
      view = status()?.pendingCheckout ? 'waiting' : 'plans';
      render();
    });
    form.append(row, error, back);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      void activateKey();
    });
    body.append(form);
  }

  function renderDone(): void {
    const done = el('div', 'ag-pricing-state ag-pricing-done');
    const mark = el('span', 'ag-pricing-done-mark');
    mark.append(createIcon('check'));
    const tier = status()?.tier ?? 'pro';
    const title = el('p', 'ag-pricing-state-title', `${TIER_LABEL[tier]}를 쓸 수 있어요`);
    title.setAttribute('role', 'status');
    done.append(mark, title);
    body.append(done);
  }

  function render(): void {
    const focusInKey = view === 'key' && document.activeElement?.classList.contains('ag-pricing-key-input');
    body.replaceChildren();
    sheet.dataset.view = view;
    legacyMark.hidden = status()?.tier !== 'legacy';
    if (view === 'plans') renderPlans();
    else if (view === 'waiting') renderWaiting();
    else if (view === 'key') renderKey();
    else renderDone();
    if (focusInKey) sheet.querySelector<HTMLInputElement>('.ag-pricing-key-input')?.focus();
  }

  function focusColumn(target: PlanCardFocus | undefined): void {
    focused = target;
    if (view === 'plans') render();
    if (target) sheet.querySelector(`.ag-pricing-col[data-plan="${target}"]`)?.scrollIntoView({ block: 'nearest' });
  }

  if (status()?.pendingCheckout) {
    awaiting = { sku: status()!.pendingCheckout!.sku };
    view = 'waiting';
  }
  render();

  const unsubscribe = store.subscribe(() => {
    if (view === 'done') return;
    if (view === 'plans' && status()?.pendingCheckout && !awaiting) {
      awaiting = { sku: status()!.pendingCheckout!.sku };
      view = 'waiting';
    }
    settleIfDone();
    render();
  });

  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => { resolveClosed = resolve; });
  const finish = frame.present(
    () => sheet.querySelector<HTMLElement>(focused ? `.ag-pricing-col[data-plan="${focused}"] button:not([disabled])` : '.ag-pricing-btn-primary:not([disabled])')
      ?? close,
    () => {
      unsubscribe();
      if (successTimer !== null) window.clearTimeout(successTimer);
      openCard = null;
      resolveClosed();
    },
  );
  close.addEventListener('click', () => finish(false));
  const handle: PlanCardHandle = { close: () => finish(false), closed };
  openCard = { handle, focus: focusColumn };
  if (focused) requestAnimationFrame(() => focusColumn(focused));
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
    const focus = detail?.focus === 'pro' || detail?.focus === 'hama' ? detail.focus : undefined;
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
