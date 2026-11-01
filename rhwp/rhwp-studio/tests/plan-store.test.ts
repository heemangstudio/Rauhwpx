import assert from 'node:assert/strict';
import test from 'node:test';

import { familyPriceLine, upgradeFamilies } from '../src/ui/plan/plan-offers.ts';
import { createPlanStore, desktopPlanApi, planLocksAgent, showsRauHomeEntry } from '../src/ui/plan/plan-store.ts';
import { tierForSku, tierRank, type DesktopPlanApi, type PlanStatus, type PlanTier } from '../src/ui/plan/plan-types.ts';

function status(tier: PlanTier, agentUnlocked = tier !== 'free'): PlanStatus {
  return {
    tier,
    agentUnlocked,
    source: 'live',
    cachedUntil: null,
    checkout: {
      hamaMonthly: { available: true, priceKrw: 3900 },
      hamaYearly: { available: true, priceKrw: 39000 },
      rauMonthly: { available: true, priceKrw: 14900 },
      rauYearly: { available: true, priceKrw: 149000 },
    },
    pendingCheckout: null,
    lastCheckout: null,
    signedIn: true,
  };
}

test('without a desktop plan API nothing is locked', () => {
  assert.equal(desktopPlanApi({}), null);
  assert.equal(desktopPlanApi({ rhwpDesktop: {} }), null);
  const store = createPlanStore(null);
  assert.equal(store.api, null);
  assert.equal(store.status(), null);
  assert.equal(planLocksAgent(store.status()), false);
});

test('the lock and the home Rau entry follow the tier', () => {
  assert.equal(planLocksAgent(status('free')), true);
  // 라이선스를 강제하지 않는 개발 빌드는 무료여도 열린다.
  assert.equal(planLocksAgent(status('free', true)), false);
  for (const tier of ['hama', 'rau'] as const) assert.equal(planLocksAgent(status(tier)), false, tier);
  // Hama 사용자만 문서 홈에서 Rau 로 올라간다.
  assert.deepEqual((['free', 'hama', 'rau'] as const).map((tier) => showsRauHomeEntry(status(tier))), [false, true, false]);
  assert.equal(showsRauHomeEntry(null), false);
});

test('each product opens its tier, and upgrades only go up', () => {
  assert.deepEqual(
    (['hamaMonthly', 'hamaYearly', 'rauMonthly', 'rauYearly'] as const).map(tierForSku),
    ['hama', 'hama', 'rau', 'rau'],
  );
  assert.ok(tierRank('free') < tierRank('hama') && tierRank('hama') < tierRank('rau'));
  assert.deepEqual(upgradeFamilies('free'), ['hama', 'rau']);
  assert.deepEqual(upgradeFamilies('hama'), ['rau']);
  assert.deepEqual(upgradeFamilies('rau'), []);
  // 값을 모르면 기본값으로 보인다.
  assert.equal(familyPriceLine(null, 'rau'), '월 ₩14,900\u2003연 ₩149,000');
  assert.equal(familyPriceLine(status('hama'), 'hama'), '월 ₩3,900\u2003연 ₩39,000');
});

test('the store follows status changes and an unknown status does not lock', async () => {
  const listeners = new Set<(s: PlanStatus) => void>();
  let resolveInitial!: (s: PlanStatus) => void;
  const api: DesktopPlanApi = {
    getStatus: () => new Promise((resolve) => { resolveInitial = resolve; }),
    startCheckout: async () => ({ ok: false, code: 'not_available', status: status('free') }),
    cancelCheckout: async () => status('free'),
    onChange: (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
  };
  const store = createPlanStore(api);
  assert.equal(planLocksAgent(store.status()), false, 'unknown status stays unlocked');
  const seen: Array<PlanTier | undefined> = [];
  store.subscribe((s) => seen.push(s?.tier));
  resolveInitial(status('free'));
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(planLocksAgent(store.status()), true);
  for (const cb of listeners) cb(status('hama'));
  assert.equal(planLocksAgent(store.status()), false, 'unlocks live on change');
  assert.deepEqual(seen, ['free', 'hama']);
  store.dispose();
  assert.equal(listeners.size, 0, 'dispose unsubscribes from the desktop');
});
