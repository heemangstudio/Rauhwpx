// In-memory test double of the Hama plan routes (/tmp contract: GET /v1/hama/status and the two proxies).
// license-mock-server.mjs mounts it under /v1/hama/. No real provider is called: the Anthropic route streams
// a fixed Messages SSE reply and the OpenAI route streams fixed chat-completion chunks.
// Admin (CLI): POST /__mock/hama/enroll {key}, POST /__mock/hama/cap {cap: 'cap_5h'|'cap_week'|'cap_month'|null}.
import { randomUUID } from 'node:crypto';

export const HAMA_CLAUDE_MODEL = 'anthropic/claude-haiku-5.5';
export const HAMA_CHEAP_MODELS = Object.freeze(['deepseek/deepseek-v4.1-flash']);
const CLAUDE_IDS = new Set([HAMA_CLAUDE_MODEL, 'claude-haiku-5-5']);
const HOUR = 3_600_000;
const REPLY = ['Hama ', '모의 ', '응답입니다.'];

/**
 * @param {{ now: () => number, authenticate: (headers: object) => ({ license: { id: string } } | null) }} deps
 */
export function createHamaMock({ now, authenticate }) {
  /** license id → { allowanceUsd, periodStart } */
  const plans = new Map();
  /** Forced cap (the mock does not meter spend). */
  let cap = null;
  const calls = [];

  function resetsAtFor(name) {
    if (name === 'cap_5h') return new Date(now() + 3 * HOUR + 12 * 60_000).toISOString();
    if (name === 'cap_week') return new Date(now() + 53 * HOUR).toISOString();
    return new Date(now() + 9 * 24 * HOUR).toISOString();
  }

  function statusBody(plan) {
    const periodEnd = new Date(now() + 9 * 24 * HOUR).toISOString();
    const window = (name, limit, share) => ({
      usedUsd: cap === name ? limit : Math.round(limit * share * 100) / 100,
      limitUsd: limit,
      resetsAt: name === 'cap_month' ? periodEnd : cap === name ? resetsAtFor(name) : null,
    });
    return {
      ok: true,
      plan: { status: 'active', allowanceUsd: plan.allowanceUsd, periodStart: plan.periodStart, periodEnd },
      caps: { cap_5h: window('cap_5h', 3, 0.13), cap_week: window('cap_week', 7.5, 0.16), cap_month: window('cap_month', 15, 0.13) },
      blocked: cap ? { cap, resetsAt: resetsAtFor(cap), cheapAvailable: cap !== 'cap_month' } : null,
      models: { default: HAMA_CLAUDE_MODEL, claude: [HAMA_CLAUDE_MODEL], cheap: [...HAMA_CHEAP_MODELS], maxOutputTokens: 16000 },
      endpoints: { anthropic: '/v1/hama/anthropic', openai: '/v1/hama/openrouter' },
    };
  }

  /** Lease as Bearer, or as x-api-key (Pi's Anthropic client). */
  function auth(headers) {
    const direct = authenticate(headers);
    if (direct) return direct;
    const key = Object.entries(headers ?? {}).find(([name]) => name.toLowerCase() === 'x-api-key')?.[1];
    return typeof key === 'string' && key ? authenticate({ authorization: `Bearer ${key}` }) : null;
  }

  function capMessage(name) {
    const at = resetsAtFor(name);
    return { at, text: `Hama quota exceeded (${name}) until ${at}. [hama-cap:${name}:${at}]` };
  }

  function capRefusal(route, name) {
    const { at, text } = capMessage(name);
    const seconds = Math.max(1, Math.round((Date.parse(at) - now()) / 1000));
    const headers = { 'Retry-After': String(seconds), 'X-Hama-Cap': name, 'X-Hama-Resets-At': at };
    const body = route === 'anthropic'
      ? { type: 'error', error: { type: name, message: text, resetsAt: at } }
      : { error: { code: name, message: text, resetsAt: at } };
    return [429, body, { headers }];
  }

  function anthropicReply(body) {
    const id = `msg_mock_${randomUUID()}`;
    const usage = { input_tokens: 42, output_tokens: 12 };
    const events = [
      { event: 'message_start', data: { type: 'message_start', message: { id, type: 'message', role: 'assistant', model: 'claude-haiku-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { ...usage, output_tokens: 1 } } } },
      { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
      ...REPLY.map((text) => ({ event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } })),
      { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
      { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage } },
      { event: 'message_stop', data: { type: 'message_stop' } },
    ];
    if (body?.stream !== true) {
      return [200, { id, type: 'message', role: 'assistant', model: 'claude-haiku-5-5', content: [{ type: 'text', text: REPLY.join('') }], stop_reason: 'end_turn', usage }];
    }
    return [200, null, { sse: events.map(({ event, data }) => ({ event, data: JSON.stringify(data) })) }];
  }

  function chatReply(body) {
    const id = `gen-hama-${randomUUID()}`;
    const created = Math.floor(now() / 1000);
    const usage = { prompt_tokens: 42, completion_tokens: 12, total_tokens: 54, cost: 0.0001 };
    const chunk = (delta, finish = null, extra = {}) => ({ id, object: 'chat.completion.chunk', created, model: body.model, choices: [{ index: 0, delta, finish_reason: finish }], ...extra });
    if (body.stream !== true) {
      return [200, { id, object: 'chat.completion', created, model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: REPLY.join('') }, finish_reason: 'stop' }], usage }];
    }
    const events = [chunk({ role: 'assistant', content: '' }), ...REPLY.map((content) => chunk({ content })), chunk({}, 'stop', { usage })];
    return [200, null, { sse: [...events.map((event) => JSON.stringify(event)), '[DONE]'] }];
  }

  function cheapCatalogEntry(id) {
    return {
      id, name: id, context_length: 128000,
      architecture: { input_modalities: ['text'], output_modalities: ['text'] },
      pricing: { prompt: '0.0000001', completion: '0.0000004' },
      top_provider: { context_length: 128000, max_completion_tokens: 16000 },
      supported_parameters: ['tools', 'max_tokens'],
    };
  }

  /** @returns {[number, object|null, object?]} */
  function handle(path, body, { method = 'GET', headers = {} } = {}) {
    const who = auth(headers);
    calls.push({ path, method, model: typeof body?.model === 'string' ? body.model : null, keyId: who?.license.id ?? null });
    if (!who) return [401, { ok: false, error: 'unauthorized' }];
    const plan = plans.get(who.license.id);
    if (!plan) return [403, { ok: false, error: 'hama_not_enrolled' }];
    if (path === '/v1/hama/status' && method === 'GET') return [200, statusBody(plan)];
    if (path === '/v1/hama/anthropic/v1/messages' && method === 'POST') {
      if (!CLAUDE_IDS.has(body?.model)) return [400, { type: 'error', error: { type: 'model_not_allowed', message: `model not allowed: ${String(body?.model)}` } }];
      if (cap) return capRefusal('anthropic', cap);
      return anthropicReply(body);
    }
    if (path === '/v1/hama/openrouter/models' && method === 'GET') return [200, { data: HAMA_CHEAP_MODELS.map(cheapCatalogEntry) }];
    if (path === '/v1/hama/openrouter/chat/completions' && method === 'POST') {
      if (!HAMA_CHEAP_MODELS.includes(body?.model)) return [400, { error: { code: 'model_not_allowed', message: `model not allowed: ${String(body?.model)}` } }];
      if (cap === 'cap_month') return capRefusal('openai', cap);
      return chatReply(body);
    }
    return [404, { ok: false, error: 'not_found' }];
  }

  return {
    handle,
    calls,
    enroll(licenseId, { allowanceUsd = 15 } = {}) {
      plans.set(licenseId, { allowanceUsd, periodStart: new Date(now() - 21 * 24 * HOUR).toISOString() });
    },
    disenroll(licenseId) { plans.delete(licenseId); },
    setCap(next) { cap = ['cap_5h', 'cap_week', 'cap_month'].includes(next) ? next : null; },
  };
}
