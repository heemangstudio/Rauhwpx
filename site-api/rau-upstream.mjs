import { RAU_PRICES, costFromUsage, finite, usd } from './rau-ledger.mjs';

/**
 * Hosted Rau upstreams: the chain Rau-0.1 (`POST /v1/rau/learn`, rau.mjs) calls a model through.
 *
 * `createRauUpstream` turns RAU_MODEL into an ordered chain of routes:
 *   haiku    → OpenRouter `anthropic/claude-haiku-4.5` on its Anthropic-compatible `/messages`
 *              (RAU_OPENROUTER_KEY), then Anthropic `claude-haiku-4-5` (ANTHROPIC_API_KEY) as the backup;
 *   deepseek → OpenRouter `deepseek/deepseek-v4.1-flash` on `/messages`, pinned to one provider
 *              (`provider: {only: [slug], allow_fallbacks: false}`) so its price stays known.
 * A route without its key is left out. Each call is one non-streamed Messages request. It moves to the
 * next route on a network error or timeout, 408, 429, 5xx (529 included), 401/402/403, a 400 about
 * credit or billing, or a reply without a message. The caller bills the call once by its provider id
 * (rau.record), at the price of the model that served it (`billCall`).
 */

/** Upstream model ids per Rau model and route. Constants on purpose: no env adds another model. */
export const RAU_UPSTREAM_MODELS = Object.freeze({
  haiku: Object.freeze({ openrouter: 'anthropic/claude-haiku-4.5', anthropic: 'claude-haiku-4-5' }),
  deepseek: Object.freeze({ openrouter: 'deepseek/deepseek-v4.1-flash' }),
});

const MINUTE = 60 * 1000;
const ANTHROPIC_VERSION = '2023-06-01';
const MAX_ERROR_BYTES = 64 * 1024;
const MAX_JSON_REPLY_BYTES = 32 * 1024 * 1024;
const BILLING_ERROR = /credit balance|billing|insufficient credits/i;

async function readBounded(stream, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > maxBytes) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function jsonOrNull(buffer) {
  try { return buffer && buffer.length ? JSON.parse(buffer.toString('utf8')) : null; } catch { return null; }
}

/**
 * Usage of one non-streamed Anthropic Messages reply: its id, input, output and cache counts (and
 * OpenRouter's cost), and its text blocks. `final` is false when the reply carried no usage.
 */
export function meterReply(reply) {
  const m = {
    id: null,
    final: false,
    started: false,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    cost: null,
    textBytes: 0,
    text: [],
  };
  if (!reply || typeof reply !== 'object' || reply.type !== 'message' || typeof reply.id !== 'string') return m;
  m.started = true;
  m.id = reply.id;
  const u = reply.usage;
  if (u && typeof u === 'object') {
    m.final = true;
    const set = (field, value) => { const n = finite(value); if (n !== null) m[field] = n; };
    set('input', u.input_tokens);
    set('output', u.output_tokens);
    set('cacheRead', u.cache_read_input_tokens);
    const write = finite(u.cache_creation_input_tokens);
    const fiveMin = finite(u.cache_creation?.ephemeral_5m_input_tokens);
    const oneHour = finite(u.cache_creation?.ephemeral_1h_input_tokens);
    if (fiveMin !== null || oneHour !== null) {
      m.cacheWrite5m = fiveMin ?? 0;
      m.cacheWrite1h = oneHour ?? 0;
    } else if (write !== null) {
      m.cacheWrite5m = write;
    }
    const cost = finite(u.cost);
    if (cost !== null) m.cost = cost + (u.is_byok ? (finite(u.cost_details?.upstream_inference_cost) ?? 0) : 0);
  }
  for (const block of Array.isArray(reply.content) ? reply.content : []) {
    if (block?.type === 'text' && typeof block.text === 'string') {
      m.text.push(block.text);
      m.textBytes += Buffer.byteLength(block.text);
    }
  }
  return m;
}

/**
 * What one call cost, from its meter, at the prices of the model that served it. Haiku always bills at
 * its list price; DeepSeek takes OpenRouter's reported cost when there is one. A reply without usage is
 * estimated high: ~3 bytes per token.
 */
export function billCall(route, meter, requestBytes) {
  const prices = RAU_PRICES[route.model];
  let { input, output } = meter;
  let costUsd;
  let costSource;
  if (meter.final && route.model === 'deepseek' && meter.cost !== null) {
    costUsd = meter.cost;
    costSource = 'upstream';
  } else {
    if (!meter.final) {
      if (!meter.started || !(input + meter.cacheRead + meter.cacheWrite5m + meter.cacheWrite1h > 0)) input = Math.ceil(requestBytes / 3);
      output = Math.max(output, Math.ceil(meter.textBytes / 3));
    }
    costUsd = costFromUsage({ inputTokens: input, outputTokens: output, cacheReadTokens: meter.cacheRead, cacheWrite5mTokens: meter.cacheWrite5m, cacheWrite1hTokens: meter.cacheWrite1h }, prices);
    costSource = meter.final ? 'price_table' : 'estimate';
  }
  return {
    id: meter.id,
    model: route.model,
    route: route.via,
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: meter.cacheRead,
    cacheWriteTokens: meter.cacheWrite5m + meter.cacheWrite1h,
    costUsd: usd(Math.max(0, costUsd)),
    costSource,
  };
}

export function createRauUpstream({
  config = {},
  fetchImpl = globalThis.fetch,
  log = (line) => process.stderr.write(`${line}\n`),
} = {}) {
  const {
    models = ['haiku'],
    deepseekProvider = 'deepinfra',
    openrouterKey = '',
    openrouterBase = 'https://openrouter.ai/api/v1',
    anthropicKey = '',
    anthropicBase = 'https://api.anthropic.com',
  } = config;
  const routes = [];
  for (const model of models) {
    if (model === 'haiku') {
      if (openrouterKey) routes.push({ id: 'openrouter-haiku', model, via: 'openrouter', apiModel: RAU_UPSTREAM_MODELS.haiku.openrouter });
      if (anthropicKey) routes.push({ id: 'anthropic-haiku', model, via: 'anthropic', apiModel: RAU_UPSTREAM_MODELS.haiku.anthropic });
    } else if (model === 'deepseek' && openrouterKey) {
      routes.push({ id: 'openrouter-deepseek', model, via: 'openrouter', apiModel: RAU_UPSTREAM_MODELS.deepseek.openrouter, only: deepseekProvider });
    }
  }

  /** URL and fetch init of one route for a Messages body. */
  function request(route, payload) {
    const body = {
      ...payload,
      model: route.apiModel,
      ...(route.only ? { provider: { only: [route.only], allow_fallbacks: false } } : {}),
    };
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'anthropic-version': ANTHROPIC_VERSION,
      ...(route.via === 'anthropic'
        ? { 'x-api-key': anthropicKey }
        : { Authorization: `Bearer ${openrouterKey}`, 'HTTP-Referer': 'https://heemangstudios.com/', 'X-Title': 'HamaEditor' }),
    };
    const url = route.via === 'anthropic' ? `${anthropicBase}/v1/messages` : `${openrouterBase}/messages`;
    return { url, init: { method: 'POST', headers, body: JSON.stringify(body) } };
  }

  /** One upstream attempt until response headers: {response}, or {network: true} when refused, reset or timed out. */
  async function attempt(url, init, timeoutMs) {
    const timer = new AbortController();
    const timeout = setTimeout(() => timer.abort(), timeoutMs);
    try {
      return { response: await fetchImpl(url, { ...init, signal: timer.signal }) };
    } catch {
      return { network: true };
    } finally {
      clearTimeout(timeout);
    }
  }

  /** Whether an error answer moves the call to the next route: never for a client's own mistake. */
  function failover(status, body) {
    if (status === 408 || status === 429 || status >= 500 || status === 401 || status === 402 || status === 403) return true;
    return status === 400 && BILLING_ERROR.test(String(body?.error?.message ?? ''));
  }

  /**
   * One non-streamed Messages call through the chain. `payload` has no model; each route sets its own.
   * Resolves to `{ text, call }` (the joined text blocks and the billing record), or `{ failed: true }`
   * when every route failed.
   */
  async function complete(payload, { timeoutMs = 2 * MINUTE } = {}) {
    const raw = JSON.stringify(payload);
    for (const [index, route] of routes.entries()) {
      const hasNext = index < routes.length - 1;
      const { url, init } = request(route, { ...payload, stream: false });
      const result = await attempt(url, init, timeoutMs);
      if (result.network) {
        log(`[site-api] rau ${route.id} failed (network)${hasNext ? ', trying the next route' : ''}`);
        continue;
      }
      const upstream = result.response;
      const bytes = upstream.body ? await readBounded(upstream.body, upstream.ok ? MAX_JSON_REPLY_BYTES : MAX_ERROR_BYTES).catch(() => null) : null;
      const body = jsonOrNull(bytes);
      if (!upstream.ok) {
        log(`[site-api] rau ${route.id} answered ${upstream.status}${failover(upstream.status, body) && hasNext ? ', trying the next route' : ''}`);
        if (failover(upstream.status, body)) continue;
        return { failed: true };
      }
      const meter = meterReply(body);
      if (!meter.started) {
        log(`[site-api] rau ${route.id} answered without a message`);
        continue;
      }
      return { text: meter.text.join(''), call: billCall(route, meter, raw.length) };
    }
    return { failed: true };
  }

  return {
    configured: routes.length > 0,
    routes: routes.map((route) => ({ id: route.id, model: route.model, via: route.via })),
    complete,
  };
}
