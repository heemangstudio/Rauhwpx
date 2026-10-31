// 요금제 카드와 계정 페이지가 함께 쓰는 상품 규칙: 값(모르면 기본값), 열린 결제 링크, 올라갈 수 있는 요금제.
import type { PlanSku, PlanStatus, PlanTier } from './plan-types.ts';

export type PlanFamily = 'hama' | 'rau';

export const PLAN_DEFAULT_PRICE: Record<PlanSku, number> = { hamaMonthly: 3900, hamaYearly: 39000, rauMonthly: 14900, rauYearly: 149000 };
export const PLAN_CYCLES: Record<PlanFamily, { monthly: PlanSku; yearly: PlanSku }> = {
  hama: { monthly: 'hamaMonthly', yearly: 'hamaYearly' },
  rau: { monthly: 'rauMonthly', yearly: 'rauYearly' },
};
export const PLAN_FAMILY_LABEL: Record<PlanFamily, string> = { hama: 'Hama', rau: 'Rau' };

export function won(value: number): string {
  return `₩${value.toLocaleString('ko-KR')}`;
}

export function planPrice(status: PlanStatus | null, sku: PlanSku): number | null {
  return status?.checkout[sku]?.priceKrw ?? PLAN_DEFAULT_PRICE[sku];
}

export function planSkuAvailable(status: PlanStatus | null, sku: PlanSku): boolean {
  return status?.checkout[sku]?.available === true;
}

/** 'Rau 월 ₩14,900 · 연 ₩149,000' 의 값 부분. 예: 월 ₩14,900 · 연 ₩149,000 */
export function familyPriceLine(status: PlanStatus | null, family: PlanFamily): string {
  const monthly = planPrice(status, PLAN_CYCLES[family].monthly);
  const yearly = planPrice(status, PLAN_CYCLES[family].yearly);
  return [monthly === null ? '' : `월 ${won(monthly)}`, yearly === null ? '' : `연 ${won(yearly)}`].filter(Boolean).join(' · ');
}

/** 지금 요금제에서 사 볼 만한 요금제. 무료는 둘 다, Hama 는 Rau, Rau 는 없다. */
export function upgradeFamilies(tier: PlanTier): PlanFamily[] {
  if (tier === 'free') return ['hama', 'rau'];
  if (tier === 'hama') return ['rau'];
  return [];
}
