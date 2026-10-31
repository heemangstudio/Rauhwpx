// In-memory test double of the hosted Rau routes (contract: GET /v1/rau/status, POST /v1/rau/learn).
// account-mock-server.mjs mounts it under /v1/rau/ and authenticates v2 account leases. No real provider is called.

export const RAU_PLAN_ALLOWANCE_USD = 8;
export const RAU_TRIAL_ALLOWANCE_USD = 2;
export const RAU_UPGRADE_URL = 'https://heemangstudios.com/pricing.html#rau';
/** 한 번의 학습 요청이 쓰는 크레딧(USD). */
const CALL_COST_USD = 0.01;

const round = (usd) => Math.round(usd * 1e6) / 1e6;

/**
 * @param {{ authenticate: (headers: object) => ({ account: object } | null),
 *   rauOf: (account: object) => ({ eligible: boolean, source: 'plan'|'trial'|null, allowanceUsd: number|null,
 *     usedUsd: number|null, remainingUsd: number|null, resetsAt: number|null }),
 *   spend: (account: object, usd: number) => void }} deps
 */
export function createRauMock({ authenticate, rauOf, spend }) {
  let configured = true;
  const calls = [];

  function statusBody(account) {
    const rau = rauOf(account);
    const iso = (t) => (t === null ? null : new Date(t).toISOString());
    return {
      ok: true,
      eligible: rau.eligible,
      source: rau.source,
      reason: rau.eligible ? null : 'rau_plan_required',
      upgradeUrl: RAU_UPGRADE_URL,
      allowanceUsd: rau.allowanceUsd,
      usedUsd: rau.usedUsd,
      remainingUsd: rau.remainingUsd,
      resetsAt: iso(rau.resetsAt),
    };
  }

  /** @returns {[number, object|null]} */
  function handle(path, body, { method = 'GET', headers = {} } = {}) {
    const who = authenticate(headers);
    calls.push({ path, method, accountId: who?.account.id ?? null });
    if (!configured) return [503, { ok: false, error: 'rau_not_configured' }];
    if (!who) return [401, { ok: false, error: 'unauthorized' }];
    const rau = rauOf(who.account);
    if (path === '/v1/rau/status' && method === 'GET') return [200, statusBody(who.account)];
    if (path === '/v1/rau/learn' && method === 'POST') {
      if (!rau.eligible) return [403, { ok: false, error: 'rau_plan_required', upgradeUrl: RAU_UPGRADE_URL }];
      if (typeof body?.prompt !== 'string' || !body.prompt) return [400, { ok: false, error: 'invalid' }];
      if (rau.remainingUsd !== null && rau.remainingUsd <= 0) {
        return [402, { ok: false, error: 'rau_credits_exhausted', allowanceUsd: rau.allowanceUsd, usedUsd: rau.usedUsd, resetsAt: new Date(rau.resetsAt).toISOString() }];
      }
      spend(who.account, CALL_COST_USD);
      const after = rauOf(who.account);
      return [200, {
        ok: true, text: JSON.stringify({ ops: [] }), model: 'rau-0.1',
        usage: { allowanceUsd: after.allowanceUsd, usedUsd: round(after.usedUsd), remainingUsd: round(after.remainingUsd), resetsAt: new Date(after.resetsAt).toISOString() },
      }];
    }
    return [404, { ok: false, error: 'not_found' }];
  }

  return {
    handle,
    calls,
    setConfigured(value) { configured = Boolean(value); },
  };
}
