// 앱 요금제. 데스크톱 main(desktop/plan-manager.mjs)이 정하고 rhwpDesktop.plan 으로 알린다.
// 이 꼴은 데스크톱 JSON 과 같다. 결제 주소와 ref 는 렌더러로 오지 않는다.

export type PlanTier = 'free' | 'basic' | 'legacy' | 'hama';
export type PlanSku = 'basicMonthly' | 'basicYearly' | 'hamaMonthly' | 'hamaYearly';

export const PLAN_SKUS: readonly PlanSku[] = ['basicMonthly', 'basicYearly', 'hamaMonthly', 'hamaYearly'];

export interface PlanCheckoutOption {
  available: boolean;
  priceKrw: number | null;
}

export interface PlanStatus {
  tier: PlanTier;
  /** tier !== 'free' 이거나 라이선스를 강제하지 않는 개발 빌드. */
  agentUnlocked: boolean;
  source: 'live' | 'cached' | 'none';
  /** source 가 cached 일 때 verifiedAt + 7일. */
  cachedUntil: number | null;
  checkout: Record<PlanSku, PlanCheckoutOption>;
  pendingCheckout: { sku: PlanSku; startedAt: number } | null;
  lastCheckout: { ok: boolean; sku: PlanSku; code?: string } | null;
  /** 계정에 로그인했는지. 로그아웃이면 무료이고 결제는 sign_in_required 로 막힌다. */
  signedIn: boolean;
}

export interface PlanCheckoutResult {
  ok: boolean;
  code?: 'not_available' | 'busy' | 'sign_in_required';
  status: PlanStatus;
}

export interface DesktopPlanApi {
  getStatus(): Promise<PlanStatus>;
  startCheckout(sku: PlanSku): Promise<PlanCheckoutResult>;
  cancelCheckout(): Promise<PlanStatus>;
  onChange(callback: (status: PlanStatus) => void): () => void;
}

/** 산 상품이 여는 요금제. */
export function tierForSku(sku: PlanSku): PlanTier {
  return sku === 'hamaMonthly' || sku === 'hamaYearly' ? 'hama' : 'basic';
}
