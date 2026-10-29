import assert from 'node:assert/strict';
import test from 'node:test';

import { createPlanStore, desktopPlanApi, planLocksAgent, planShowsUpgrade } from '../src/ui/plan/plan-store.ts';
import type { DesktopPlanApi, PlanStatus, PlanTier } from '../src/ui/plan/plan-types.ts';

function status(tier: PlanTier, agentUnlocked = tier !== 'free'): PlanStatus {
  return {
    tier,
    agentUnlocked,
    source: 'live',
    cachedUntil: null,
    checkout: {
      proMonthly: { available: true, priceKrw: 3900 },
      proYearly: { available: true, priceKrw: 39000 },
      hama: { available: false, priceKrw: null },
    },
    pendingCheckout: null,
    lastCheckout: null,
  };
}

test('without a desktop plan API nothing is locked and no upgrade button shows', () => {
  assert.equal(desktopPlanApi({}), null);
  assert.equal(desktopPlanApi({ rhwpDesktop: {} }), null);
  const store = createPlanStore(null);
  assert.equal(store.api, null);
  assert.equal(store.status(), null);
  assert.equal(planLocksAgent(store.status()), false);
  assert.equal(planShowsUpgrade(store.status()), false);
});

test('only a free tier without an unenforced license locks the agent', () => {
  assert.equal(planLocksAgent(status('free')), true);
  // 라이선스를 강제하지 않는 개발 빌드는 무료여도 열린다.
  assert.equal(planLocksAgent(status('free', true)), false);
  for (const tier of ['pro', 'legacy', 'hama'] as const) assert.equal(planLocksAgent(status(tier)), false, tier);
  assert.deepEqual(
    (['free', 'pro', 'legacy', 'hama'] as const).map((tier) => planShowsUpgrade(status(tier))),
    [true, true, true, false],
  );
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
  for (const cb of listeners) cb(status('pro'));
  assert.equal(planLocksAgent(store.status()), false, 'unlocks live on change');
  assert.deepEqual(seen, ['free', 'pro']);
  store.dispose();
  assert.equal(listeners.size, 0, 'dispose unsubscribes from the desktop');
});
