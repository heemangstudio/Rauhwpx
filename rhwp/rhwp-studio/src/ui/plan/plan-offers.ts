// 요금제 카드와 계정 페이지가 함께 쓰는 상품 규칙: 값(모르면 기본값), 열린 결제 링크, 올라갈 수 있는 요금제.
import type { PlanSku, PlanStatus, PlanTier } from './plan-types.ts';

export type PlanFamily = 'basic' | 'hama';

export const PLAN_DEFAULT_PRICE: Record<PlanSku, number> = { basicMonthly: 3900, basicYearly: 39000, hamaMonthly: 12900, hamaYearly: 139000 };
export const PLAN_CYCLES: Record<PlanFamily, { monthly: PlanSku; yearly: PlanSku }> = {
  basic: { monthly: 'basicMonthly', yearly: 'basicYearly' },
  hama: { monthly: 'hamaMonthly', yearly: 'hamaYearly' },
};

export function won(value: number): string {
  return `₩${value.toLocaleString('ko-KR')}`;
}

export function planPrice(status: PlanStatus | null, sku: PlanSku): number | null {
  return status?.checkout[sku]?.priceKrw ?? PLAN_DEFAULT_PRICE[sku];
}

export function planSkuAvailable(status: PlanStatus | null, sku: PlanSku): boolean {
  return status?.checkout[sku]?.available === true;
}

/** 지금 요금제에서 사 볼 만한 요금제. 무료는 둘 다, Basic·기존 라이선스는 Hama, Hama 는 없다. */
export function upgradeFamilies(tier: PlanTier): PlanFamily[] {
  if (tier === 'free') return ['basic', 'hama'];
  if (tier === 'basic' || tier === 'legacy') return ['hama'];
  return [];
}
