// 앱 요금제. 데스크톱 main(desktop/plan-manager.mjs)이 정하고 rhwpDesktop.plan 으로 알린다.
// 이 꼴은 데스크톱 JSON 과 같다. 결제 주소와 ref 는 렌더러로 오지 않는다.

/** free: 편집기만. hama: 내 AI 연결. rau: Hama 에 Rau 모드(Rau-0.1)를 더한다(체험 포함). */
export type PlanTier = 'free' | 'hama' | 'rau';
export type PlanSku = 'hamaMonthly' | 'hamaYearly' | 'rauMonthly' | 'rauYearly';

export const PLAN_SKUS: readonly PlanSku[] = ['hamaMonthly', 'hamaYearly', 'rauMonthly', 'rauYearly'];

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
  return sku === 'rauMonthly' || sku === 'rauYearly' ? 'rau' : 'hama';
}

/** 요금제의 높이. 결제가 끝났는지는 산 등급 이상이 되었는지로 본다(Rau 는 Hama 를 넘어선다). */
export function tierRank(tier: PlanTier): number {
  return tier === 'rau' ? 2 : tier === 'hama' ? 1 : 0;
}
