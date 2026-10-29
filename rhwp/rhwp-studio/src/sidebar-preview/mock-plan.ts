/**
 * 데스크톱 요금제 API(rhwpDesktop.plan)의 미리보기 대역. `?plan=free|pro|legacy|hama` (기본 off: 웹처럼 API 없음).
 * `&checkout=off` 면 결제 링크가 비어 모든 단추가 '곧 출시'다. 기본은 Pro 월간·연간만 열리고 Hama 는 준비 중,
 * `checkout=all` 이면 Hama 도 열린다. 결제를 시작하면 페이지는 열지 않고 보고만 하며, 2.4초 뒤 산 등급이 된다
 * (`&checkoutHold=1` 이면 확인 중에 머문다).
 */
import type { DesktopPlanApi, PlanSku, PlanStatus, PlanTier } from '../ui/plan/plan-types.ts';
import { tierForSku } from '../ui/plan/plan-types.ts';

export const mockPlanTiers = ['free', 'pro', 'legacy', 'hama'] as const;
export const mockCheckoutModes = ['pro', 'all', 'off'] as const;
export type MockCheckoutMode = (typeof mockCheckoutModes)[number];

const CHECKOUT_DELAY_MS = 2400;

export function mockPlanTier(params: URLSearchParams): PlanTier | null {
  const value = params.get('plan');
  return mockPlanTiers.includes(value as PlanTier) ? (value as PlanTier) : null;
}

export function mockCheckoutMode(params: URLSearchParams): MockCheckoutMode {
  const value = params.get('checkout');
  return mockCheckoutModes.includes(value as MockCheckoutMode) ? (value as MockCheckoutMode) : 'pro';
}

export interface MockPlan {
  api: DesktopPlanApi;
  status(): PlanStatus;
  setTier(tier: PlanTier): void;
  setCheckout(mode: MockCheckoutMode): void;
  /** 결제를 시작한 상품들(순서대로). */
  readonly checkouts: PlanSku[];
}

export function createMockPlan(
  tier: PlanTier | null,
  options: { checkout: MockCheckoutMode; hold: boolean; report: (message: string) => void },
): MockPlan | null {
  if (!tier) return null;
  let checkoutMode = options.checkout;
  const checkouts: PlanSku[] = [];
  const listeners = new Set<(status: PlanStatus) => void>();
  let timer: number | null = null;

  const checkoutOptions = (): PlanStatus['checkout'] => ({
    proMonthly: { available: checkoutMode !== 'off', priceKrw: 3900 },
    proYearly: { available: checkoutMode !== 'off', priceKrw: 39000 },
    hama: { available: checkoutMode === 'all', priceKrw: null },
  });
  let status: PlanStatus = {
    tier,
    agentUnlocked: tier !== 'free',
    source: 'live',
    cachedUntil: null,
    checkout: checkoutOptions(),
    pendingCheckout: null,
    lastCheckout: null,
  };
  const emit = (next: Partial<PlanStatus>): void => {
    status = { ...status, ...next };
    for (const listener of [...listeners]) listener(status);
  };
  const setTier = (next: PlanTier): void => emit({ tier: next, agentUnlocked: next !== 'free' });

  const api: DesktopPlanApi = {
    getStatus: async () => status,
    async startCheckout(sku) {
      if (!status.checkout[sku].available) return { ok: false, code: 'not_available', status };
      if (status.pendingCheckout) return { ok: false, code: 'busy', status };
      checkouts.push(sku);
      options.report(`Checkout page placeholder (${sku})`);
      emit({ pendingCheckout: { sku, startedAt: Date.now() }, lastCheckout: null });
      if (!options.hold) {
        timer = window.setTimeout(() => {
          timer = null;
          const bought = tierForSku(sku);
          emit({ tier: bought, agentUnlocked: true, pendingCheckout: null, lastCheckout: { ok: true, sku } });
        }, CHECKOUT_DELAY_MS);
      }
      return { ok: true, status };
    },
    async cancelCheckout() {
      if (timer !== null) window.clearTimeout(timer);
      timer = null;
      emit({ pendingCheckout: null });
      return status;
    },
    onChange(callback) {
      listeners.add(callback);
      return () => { listeners.delete(callback); };
    },
  };
  return {
    api,
    status: () => status,
    setTier,
    setCheckout(mode) {
      checkoutMode = mode;
      emit({ checkout: checkoutOptions() });
    },
    checkouts,
  };
}
