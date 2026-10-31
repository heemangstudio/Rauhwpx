/**
 * The frozen hama.json of the old hosted Hama plan, `{ plans, ledgers }` (hama_plans and hama_ledgers
 * in Postgres mode, mappers/hama.mjs). Nothing writes it any more: it is read once, on first use, as
 * a source of Rau grants. A key whose plan there is `active` keeps hosted Rau while its license is
 * live (licenses.mjs `legacyRauPlan`). Its ledgers and usage logs are never read.
 *
 * Resolves keyId → `{ periodAnchor }` of an active plan, else null. A failed read is retried on the
 * next call.
 */
export function createLegacyRauPlans(store) {
  let loading = null;
  return async function legacyRauPlan(keyId) {
    loading ??= store.read().then((state) => {
      const plans = state?.plans;
      return plans && typeof plans === 'object' && !Array.isArray(plans) ? plans : {};
    });
    let plans;
    try {
      plans = await loading;
    } catch (error) {
      loading = null;
      throw error;
    }
    const plan = typeof keyId === 'string' && Object.hasOwn(plans, keyId) ? plans[keyId] : undefined;
    return plan?.status === 'active' ? { periodAnchor: plan.periodAnchor ?? null } : null;
  };
}
