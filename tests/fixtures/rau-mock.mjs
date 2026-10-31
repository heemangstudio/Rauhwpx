// In-memory test double of the hosted Rau routes (contract: GET /v1/rau/status, POST /v1/rau/agent/v1/messages,
// POST /v1/rau/learn). account-mock-server.mjs mounts it under /v1/rau/ and authenticates v2 account leases.
// No real provider is called: the agent route streams a fixed Anthropic Messages SSE reply.
// Like the real upstream model, the agent route takes budget thinking only: `thinking.type: 'adaptive'` or
// `output_config` answers 400, so a live run shows whether Pi sends `thinking: {type: 'enabled', budget_tokens}`.
import { randomUUID } from 'node:crypto';

export const RAU_PLAN_ALLOWANCE_USD = 8;
export const RAU_TRIAL_ALLOWANCE_USD = 2;
export const RAU_UPGRADE_URL = 'https://heemangstudios.com/pricing.html#rau';
const REPLY = ['Rau ', '모의 ', '응답입니다.'];
/** 한 번의 에이전트 요청이 쓰는 크레딧(USD). */
const CALL_COST_USD = 0.01;

const round = (usd) => Math.round(usd * 1e6) / 1e6;

/**
 * @param {{ now: () => number, authenticate: (headers: object) => ({ account: object } | null),
 *   rauOf: (account: object) => ({ eligible: boolean, source: 'plan'|'trial'|null, allowanceUsd: number|null,
 *     usedUsd: number|null, remainingUsd: number|null, resetsAt: number|null }),
 *   spend: (account: object, usd: number) => void }} deps
 */
export function createRauMock({ now, authenticate, rauOf, spend }) {
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
      agent: { baseUrl: '/v1/rau/agent', model: 'rau', contextWindow: 200000, maxOutputTokens: 16000 },
    };
  }

  /** Lease as Bearer, or as x-api-key (Pi's Anthropic client). */
  function auth(headers) {
    const direct = authenticate(headers);
    if (direct) return direct;
    const key = Object.entries(headers ?? {}).find(([name]) => name.toLowerCase() === 'x-api-key')?.[1];
    return typeof key === 'string' && key ? authenticate({ authorization: `Bearer ${key}` }) : null;
  }

  function creditsRefusal(rau) {
    const at = new Date(rau.resetsAt ?? now() + 86_400_000).toISOString();
    const seconds = Math.max(1, Math.round((Date.parse(at) - now()) / 1000));
    return [429, { type: 'error', error: { type: 'rau_credits_exhausted', message: `Rau quota exceeded until ${at}. [rau-credits:${at}]` } },
      { headers: { 'Retry-After': String(seconds), 'X-Rau-Resets-At': at } }];
  }

  function agentReply(body) {
    const id = `msg_mock_${randomUUID()}`;
    const usage = { input_tokens: 42, output_tokens: 12 };
    const events = [
      { event: 'message_start', data: { type: 'message_start', message: { id, type: 'message', role: 'assistant', model: 'rau', content: [], stop_reason: null, stop_sequence: null, usage: { ...usage, output_tokens: 1 } } } },
      { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
      ...REPLY.map((text) => ({ event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } })),
      { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
      { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage } },
      { event: 'message_stop', data: { type: 'message_stop' } },
    ];
    if (body?.stream !== true) {
      return [200, { id, type: 'message', role: 'assistant', model: 'rau', content: [{ type: 'text', text: REPLY.join('') }], stop_reason: 'end_turn', usage }];
    }
    return [200, null, { sse: events.map(({ event, data }) => ({ event, data: JSON.stringify(data) })) }];
  }

  /** 서버 모델이 받지 않는 thinking 모양. 없으면 null. */
  function thinkingRejection(body) {
    if (body?.output_config !== undefined) return 'output_config is not supported for this model';
    const thinking = body?.thinking;
    if (thinking === undefined || thinking?.type === 'disabled') return null;
    if (thinking?.type !== 'enabled' || !Number.isSafeInteger(thinking.budget_tokens) || thinking.budget_tokens < 1024) {
      return `thinking.type ${String(thinking?.type)} is not supported for this model`;
    }
    return null;
  }

  /** @returns {[number, object|null, object?]} */
  function handle(path, body, { method = 'GET', headers = {} } = {}) {
    const who = auth(headers);
    calls.push({
      path, method,
      model: typeof body?.model === 'string' ? body.model : null,
      thinking: body?.thinking ?? null,
      outputConfig: body?.output_config ?? null,
      accountId: who?.account.id ?? null,
    });
    if (!configured) return [503, { ok: false, error: 'rau_not_configured' }];
    if (!who) {
      return path.startsWith('/v1/rau/agent/')
        ? [401, { type: 'error', error: { type: 'unauthorized', message: 'unauthorized' } }]
        : [401, { ok: false, error: 'unauthorized' }];
    }
    const rau = rauOf(who.account);
    if (path === '/v1/rau/status' && method === 'GET') return [200, statusBody(who.account)];
    if (path === '/v1/rau/agent/v1/messages' && method === 'POST') {
      if (!rau.eligible) return [403, { type: 'error', error: { type: 'rau_plan_required', message: 'Rau plan required' } }];
      if (body?.model !== 'rau') return [400, { type: 'error', error: { type: 'model_not_allowed', message: `model not allowed: ${String(body?.model)}` } }];
      const rejected = thinkingRejection(body);
      if (rejected) return [400, { type: 'error', error: { type: 'invalid_request_error', message: rejected } }];
      if (rau.remainingUsd !== null && rau.remainingUsd <= 0) return creditsRefusal(rau);
      spend(who.account, CALL_COST_USD);
      return agentReply(body);
    }
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
