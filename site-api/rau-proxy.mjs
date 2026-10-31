import { createHash } from 'node:crypto';

import { RAU_PRICES, costFromUsage, finite, usd } from './rau-ledger.mjs';
import { createRateLimiter } from './rate-limit.mjs';

/**
 * Hosted Rau upstreams and the Rau agent route.
 *
 * `createRauUpstream` turns RAU_MODEL into an ordered chain of routes:
 *   haiku    → OpenRouter `anthropic/claude-haiku-4.5` on its Anthropic-compatible `/messages`
 *              (RAU_OPENROUTER_KEY), then Anthropic `claude-haiku-4-5` (ANTHROPIC_API_KEY) as the backup;
 *   deepseek → OpenRouter `deepseek/deepseek-v4.1-flash` on `/messages`, pinned to one provider
 *              (`provider: {only: [slug], allow_fallbacks: false}`) so its price stays known.
 * A route without its key is left out. A call moves to the next route only before any byte reached the
 * client: on a network error or timeout, 408, 429, 5xx (529 included), 401/402/403, a 400 about credit
 * or billing, or a 200 stream whose first event is an overloaded, api or rate-limit error.
 *
 * `createRauAgentProxy` serves `POST /v1/rau/agent/v1/messages` (Anthropic Messages, model `rau`) for
 * Pi's `anthropic-messages` provider. It streams through as bytes arrive, reads usage on the way and
 * bills the call once by its provider id against the principal's period (rau.record). A cut stream is
 * still billed: what upstream reported, or a conservative estimate when no final usage arrived.
 */

export const RAU_AGENT_PREFIX = '/v1/rau/agent';
export const RAU_AGENT_MODEL = 'rau';
export const RAU_CONTEXT_WINDOW = 200000;
export const RAU_MAX_OUTPUT_TOKENS = 16000;
/** Haiku 4.5 needs at least this thinking budget, and less than max_tokens. */
export const MIN_THINKING_BUDGET = 1024;
export const RAU_CONCURRENCY_PER_PRINCIPAL = 4;
export const RAU_REQUESTS_PER_MINUTE = 60;
export const MAX_RAU_AGENT_BODY_BYTES = 16 * 1024 * 1024;
const MINUTE = 60 * 1000;
const ANTHROPIC_VERSION = '2023-06-01';
// Until upstream answers with headers. A non-streamed reply only answers once it is complete.
const STREAM_HEADERS_TIMEOUT_MS = 60 * 1000;
const JSON_HEADERS_TIMEOUT_MS = 10 * MINUTE;
const MAX_ERROR_BYTES = 64 * 1024;
const MAX_JSON_REPLY_BYTES = 32 * 1024 * 1024;
const MAX_SSE_LINE_BYTES = 1024 * 1024;
// A session that failed over stays on the route that served it this long: prompt caches are per provider.
const FAILOVER_PIN_MS = 30 * MINUTE;
const SESSION_TTL_MS = 60 * MINUTE;
const MAX_SESSIONS = 5000;
const BILLING_ERROR = /credit balance|billing|insufficient credits/i;
const STREAM_FAILOVER = new Set(['overloaded_error', 'api_error', 'rate_limit_error']);
/** Messages API fields passed upstream; anything else (OpenRouter routing such as `models` or `provider`, service tiers) is dropped. */
const ALLOWED_FIELDS = new Set([
  'model', 'messages', 'system', 'max_tokens', 'metadata', 'stop_sequences', 'stream',
  'temperature', 'top_p', 'top_k', 'tools', 'tool_choice', 'thinking', 'output_config', 'cache_control',
]);

/** Upstream model ids per Rau model and route. Constants on purpose: no env adds another model. */
export const RAU_UPSTREAM_MODELS = Object.freeze({
  haiku: Object.freeze({ openrouter: 'anthropic/claude-haiku-4.5', anthropic: 'claude-haiku-4-5' }),
  deepseek: Object.freeze({ openrouter: 'deepseek/deepseek-v4.1-flash' }),
});

function bearer(req) {
  const match = String(req.headers.authorization ?? '').match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() ?? '';
}

/** The lease the app sends as its API key: `x-api-key` (Pi's Anthropic provider) or a bearer token. */
export function leaseOf(req) {
  return String(req.headers['x-api-key'] ?? '').trim() || bearer(req);
}

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

/** Resolves when the response can take more data or has closed. */
function writable(res) {
  return new Promise((resolve) => {
    const done = () => {
      res.off('drain', done);
      res.off('close', done);
      resolve();
    };
    res.on('drain', done);
    res.on('close', done);
  });
}

function jsonOrNull(buffer) {
  try { return buffer && buffer.length ? JSON.parse(buffer.toString('utf8')) : null; } catch { return null; }
}

const sha = (text) => createHash('sha256').update(text).digest('hex');

/** Small LRU with per-entry expiry. */
function createSessionCache({ now, ttl = SESSION_TTL_MS, max = MAX_SESSIONS }) {
  const map = new Map();
  return {
    get(key) {
      const hit = map.get(key);
      if (!hit) return undefined;
      if (hit.expires <= now()) { map.delete(key); return undefined; }
      map.delete(key);
      map.set(key, hit);
      return hit.value;
    },
    set(key, value, life = ttl) {
      map.delete(key);
      map.set(key, { value, expires: now() + life });
      while (map.size > max) map.delete(map.keys().next().value);
    },
  };
}

/**
 * Session key, scoped to the principal: Pi's session id when it sends one (`x-session-id`), else a hash
 * of the conversation's stable start (system prompt and first user message).
 */
function sessionKey(principalId, req, payload) {
  const explicit = String(req.headers['x-session-id'] ?? req.headers['x-session-affinity'] ?? '').trim();
  if (explicit) return sha(`${principalId}\nid\n${explicit.slice(0, 512)}`);
  const firstUser = Array.isArray(payload.messages) ? payload.messages.find((m) => m?.role === 'user')?.content : null;
  return sha(`${principalId}\n${JSON.stringify(payload.system ?? null)}\n${JSON.stringify(firstUser ?? null)}`);
}

/** Line splitter over a byte stream; calls onData for every complete `data:` payload. */
function sseTap(onData) {
  const decoder = new TextDecoder();
  let pending = '';
  let skipping = false;
  return (chunk) => {
    pending += decoder.decode(chunk, { stream: true });
    let index;
    while ((index = pending.indexOf('\n')) !== -1) {
      const line = pending.slice(0, index).replace(/\r$/, '');
      pending = pending.slice(index + 1);
      if (skipping) { skipping = false; continue; }
      if (line.startsWith('data:')) onData(line.slice(5).trim());
    }
    if (pending.length > MAX_SSE_LINE_BYTES) { pending = ''; skipping = true; }
  };
}

/**
 * Usage of one Anthropic Messages call as it streams by: message_start carries the id and input usage,
 * message_delta the cumulative output (and possibly updated input/cache counts, and OpenRouter's cost).
 */
export function createMeter() {
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
    deltaBytes: 0,
    text: [],
  };
  const set = (field, value) => { const n = finite(value); if (n !== null) m[field] = n; };
  function usage(u) {
    if (!u || typeof u !== 'object') return;
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
      m.cacheWrite1h = 0;
    }
    const cost = finite(u.cost);
    if (cost !== null) m.cost = cost + (u.is_byok ? (finite(u.cost_details?.upstream_inference_cost) ?? 0) : 0);
  }
  function event(data) {
    if (!data || typeof data !== 'object') return;
    if (data.type === 'message_start' && data.message) {
      m.started = true;
      if (typeof data.message.id === 'string') m.id = data.message.id;
      usage(data.message.usage);
    } else if (data.type === 'message_delta') {
      usage(data.usage);
      m.final = true;
    } else if (data.type === 'content_block_delta' && data.delta) {
      const text = data.delta.text ?? data.delta.partial_json ?? data.delta.thinking ?? '';
      if (typeof text === 'string') m.deltaBytes += Buffer.byteLength(text);
    } else if (data.type === 'message' && typeof data.id === 'string') {
      // A non-streamed reply.
      m.started = true;
      m.id = data.id;
      usage(data.usage);
      m.final = Boolean(data.usage);
      for (const block of Array.isArray(data.content) ? data.content : []) {
        if (block?.type === 'text' && typeof block.text === 'string') {
          m.text.push(block.text);
          m.deltaBytes += Buffer.byteLength(block.text);
        }
      }
    }
  }
  return {
    meter: m,
    sse: sseTap((line) => {
      if (line === '[DONE]') return;
      try { event(JSON.parse(line)); } catch { /* not JSON: skip */ }
    }),
    json: (buffer) => event(jsonOrNull(buffer)),
  };
}

/**
 * Prepares a client body for the hosted model: only `model: 'rau'`, no server tools or MCP servers
 * (they bill outside token usage), no `output_config.effort` (Haiku 4.5 rejects it), output clamped to
 * RAU_MAX_OUTPUT_TOKENS, and a thinking budget of at least MIN_THINKING_BUDGET below max_tokens (else no
 * thinking; adaptive thinking is dropped too). Returns `{ body }` or `{ error: [status, code, message] }`.
 */
export function normalizeAgentRequest(payload) {
  if (payload.model !== RAU_AGENT_MODEL) {
    const model = String(payload.model ?? '(none)').slice(0, 100);
    return { error: [400, 'model_not_allowed', `Model not available: ${model}. Use ${RAU_AGENT_MODEL}.`] };
  }
  if (payload.tools !== undefined && !Array.isArray(payload.tools)) return { error: [400, 'invalid_request', 'tools must be an array.'] };
  if ((payload.tools ?? []).some((tool) => tool?.type !== undefined && tool.type !== 'custom')) {
    return { error: [400, 'tool_not_allowed', 'Server tools are not available on Rau.'] };
  }
  if (payload.mcp_servers !== undefined) return { error: [400, 'tool_not_allowed', 'MCP servers are not available on Rau.'] };
  const body = {};
  for (const [field, value] of Object.entries(payload)) if (ALLOWED_FIELDS.has(field)) body[field] = value;
  const requested = Number(body.max_tokens);
  body.max_tokens = Number.isFinite(requested) && requested >= 1 ? Math.min(Math.floor(requested), RAU_MAX_OUTPUT_TOKENS) : RAU_MAX_OUTPUT_TOKENS;
  if (body.output_config !== undefined) {
    const config = body.output_config && typeof body.output_config === 'object' && !Array.isArray(body.output_config) ? { ...body.output_config } : {};
    delete config.effort;
    if (Object.keys(config).length) body.output_config = config;
    else delete body.output_config;
  }
  if (body.thinking !== undefined) {
    const thinking = body.thinking;
    if (thinking?.type === 'enabled') {
      const asked = Math.floor(Number(thinking.budget_tokens));
      const budget = Math.min(Number.isFinite(asked) ? asked : MIN_THINKING_BUDGET, body.max_tokens - 1);
      if (budget >= MIN_THINKING_BUDGET) body.thinking = { type: 'enabled', budget_tokens: budget };
      else delete body.thinking;
    } else if (thinking?.type === 'disabled') {
      body.thinking = { type: 'disabled' };
    } else {
      delete body.thinking;
    }
  }
  return { body };
}

export function createRauUpstream({
  config = {},
  fetchImpl = globalThis.fetch,
  now = Date.now,
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
  const pins = createSessionCache({ now });

  /** The routes a session tries, in order: from the one it is pinned to after a failover, else all. */
  function routesFor(session) {
    const pinned = session ? pins.get(session) : undefined;
    const index = pinned ? routes.findIndex((route) => route.id === pinned) : -1;
    return index > 0 ? routes.slice(index) : [...routes];
  }

  function pin(session, route) {
    if (session) pins.set(session, route.id, FAILOVER_PIN_MS);
  }

  /** URL and fetch init of one route for a prepared Messages body. */
  function request(route, payload, { stream = false, session, version, beta } = {}) {
    const body = {
      ...payload,
      model: route.apiModel,
      ...(route.via === 'openrouter' && session ? { session_id: session.slice(0, 64) } : {}),
      ...(route.only ? { provider: { only: [route.only], allow_fallbacks: false } } : {}),
    };
    const headers = {
      'Content-Type': 'application/json',
      Accept: stream ? 'text/event-stream' : 'application/json',
      'anthropic-version': /^\d{4}-\d{2}-\d{2}$/.test(version ?? '') ? version : ANTHROPIC_VERSION,
      ...(/^[A-Za-z0-9._,\- ]{1,512}$/.test(beta ?? '') ? { 'anthropic-beta': beta } : {}),
      ...(route.via === 'anthropic'
        ? { 'x-api-key': anthropicKey }
        : { Authorization: `Bearer ${openrouterKey}`, 'HTTP-Referer': 'https://heemangstudios.com/', 'X-Title': 'HamaEditor' }),
    };
    const url = route.via === 'anthropic' ? `${anthropicBase}/v1/messages` : `${openrouterBase}/messages`;
    return { url, init: { method: 'POST', headers, body: JSON.stringify(body) } };
  }

  /**
   * One upstream attempt until response headers. Returns {response} or {network: true} (refused,
   * reset or timed out) or {aborted: true} (the caller left).
   */
  async function attempt(url, init, abort, timeoutMs) {
    const timer = new AbortController();
    const timeout = setTimeout(() => timer.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, { ...init, signal: AbortSignal.any([abort.signal, timer.signal]) });
      return { response };
    } catch {
      return abort.signal.aborted ? { aborted: true } : { network: true };
    } finally {
      clearTimeout(timeout);
    }
  }

  /** Whether an error answer moves the call to the next route: never for a client's own mistake. */
  function failover(status, body) {
    if (status === 408 || status === 429 || status >= 500 || status === 401 || status === 402 || status === 403) return true;
    return status === 400 && BILLING_ERROR.test(String(body?.error?.message ?? ''));
  }

  /** An error that is ours (credentials, billing, upstream down), not the client's: answered as 502. */
  function ownFailure(status, body) {
    return status === 401 || status === 402 || status === 403 || (status === 400 && BILLING_ERROR.test(String(body?.error?.message ?? '')));
  }

  /**
   * Peeks at a 200 stream's first event: a provider may answer 200 and then an `error` event (overloaded).
   * Returns the bytes read, and the error type when that first event is an error.
   */
  async function peekFirstEvent(reader) {
    const chunks = [];
    let text = '';
    while (!/\n\r?\n/.test(text) && text.length < 64 * 1024) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      text += Buffer.from(value).toString('utf8');
    }
    let errorType = null;
    const match = /^event:\s*error\s*\r?\ndata:\s*(.+)$/m.exec(text);
    if (match && text.trimStart().startsWith('event: error')) errorType = jsonOrNull(Buffer.from(match[1]))?.error?.type ?? 'api_error';
    return { chunks, errorType };
  }

  /**
   * What one call cost, from its meter, at the prices of the model that served it. Haiku always bills at
   * its list price; DeepSeek takes OpenRouter's reported cost when there is one. A call without final
   * usage (cut off) is estimated high: ~3 bytes per token.
   */
  function bill(route, meter, requestBytes) {
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
        output = Math.max(output, Math.ceil(meter.deltaBytes / 3));
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

  /**
   * One non-streamed Messages call through the chain (Rau-0.1). `payload` has no model; each route sets
   * its own. Resolves to `{ text, call }` (the joined text blocks and the billing record), or
   * `{ failed: true }` when every route failed.
   */
  async function complete(payload, { timeoutMs = 2 * MINUTE } = {}) {
    const raw = JSON.stringify(payload);
    for (const [index, route] of routes.entries()) {
      const hasNext = index < routes.length - 1;
      const { url, init } = request(route, { ...payload, stream: false });
      const result = await attempt(url, init, new AbortController(), timeoutMs);
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
      const { meter, json } = createMeter();
      json(bytes);
      if (!meter.started) {
        log(`[site-api] rau ${route.id} answered without a message`);
        continue;
      }
      return { text: meter.text.join(''), call: bill(route, meter, raw.length) };
    }
    return { failed: true };
  }

  return {
    configured: routes.length > 0,
    routes: routes.map((route) => ({ id: route.id, model: route.model, via: route.via })),
    routesFor,
    pin,
    request,
    attempt,
    failover,
    ownFailure,
    peekFirstEvent,
    bill,
    complete,
  };
}

export function createRauAgentProxy({
  rau,
  upstream,
  now = Date.now,
  log = (line) => process.stderr.write(`${line}\n`),
} = {}) {
  const perPrincipal = createRateLimiter({ now });
  const inFlight = new Map();

  /** Errors in the Anthropic shape `{type:'error', error:{type, message}}` that Pi reads. */
  function sender(req, res) {
    const fail = (status, code, message, { headers = {}, extra = {} } = {}) => {
      req.resume?.();
      if (res.headersSent) { res.destroy(); return; }
      res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        ...headers,
      });
      res.end(JSON.stringify({ type: 'error', error: { type: code, message, ...extra } }));
    };
    return fail;
  }

  /** 429 once the period's credits are spent: the message holds `quota exceeded` (Pi does not retry it) and a parseable tag. */
  function refuseCredits(fail, refusal) {
    const seconds = Math.max(1, Math.ceil((Date.parse(refusal.resetsAt) - now()) / 1000));
    fail(429, 'rau_credits_exhausted', `Rau quota exceeded until ${refusal.resetsAt}. [rau-credits:${refusal.resetsAt}]`, {
      headers: { 'Retry-After': String(seconds), 'X-Rau-Resets-At': refusal.resetsAt },
      extra: { resetsAt: refusal.resetsAt },
    });
  }

  const ADMIT_MESSAGES = {
    unauthorized: 'Invalid or expired lease.',
    rau_plan_required: 'Rau is not part of this plan.',
    not_configured: 'Rau is not available right now.',
  };

  /** `subpath` is the path after RAU_AGENT_PREFIX. */
  async function handle(req, res, subpath) {
    const fail = sender(req, res);
    if (`${req.method} ${subpath}` !== 'POST /v1/messages') return fail(404, 'not_found', 'Not found.');
    let admitted;
    try {
      admitted = await rau.admit(leaseOf(req));
    } catch (error) {
      if (error?.licenseError) {
        const code = error.code === 'rau_not_configured' ? 'not_configured' : error.code;
        return fail(error.status, code, ADMIT_MESSAGES[code] ?? code);
      }
      log(`[site-api] rau auth failed: ${error?.message ?? error}`);
      return fail(503, 'service_unavailable', 'Service unavailable.');
    }
    if (admitted.refusal) return refuseCredits(fail, admitted.refusal);
    const { principal } = admitted;
    const id = principal.ledgerId;
    if (!perPrincipal.check(id, RAU_REQUESTS_PER_MINUTE, MINUTE)) {
      return fail(429, 'rate_limited', 'Too many requests. Retry in a minute.', { headers: { 'Retry-After': '60' } });
    }
    if ((inFlight.get(id) ?? 0) >= RAU_CONCURRENCY_PER_PRINCIPAL) {
      return fail(429, 'rate_limited', 'Too many concurrent requests.', { headers: { 'Retry-After': '5' } });
    }
    inFlight.set(id, (inFlight.get(id) ?? 0) + 1);
    try {
      const raw = await readBounded(req, MAX_RAU_AGENT_BODY_BYTES).catch(() => undefined);
      if (raw === undefined) return; // client went away while uploading
      if (raw === null) return fail(413, 'too_large', 'Request body too large.');
      const payload = jsonOrNull(raw);
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return fail(400, 'invalid_request', 'Request body is not a JSON object.');
      const prepared = normalizeAgentRequest(payload);
      if (prepared.error) return fail(...prepared.error);
      await forward(req, res, principal, prepared.body, raw.length, fail);
    } finally {
      const left = (inFlight.get(id) ?? 1) - 1;
      if (left > 0) inFlight.set(id, left);
      else inFlight.delete(id);
    }
  }

  async function forward(req, res, principal, body, requestBytes, fail) {
    const stream = body.stream === true;
    const session = sessionKey(principal.ledgerId, req, body);
    const chain = upstream.routesFor(session);
    if (chain.length === 0) return fail(503, 'not_configured', ADMIT_MESSAGES.not_configured);
    const version = String(req.headers['anthropic-version'] ?? '');
    const beta = String(req.headers['anthropic-beta'] ?? '');

    const abort = new AbortController();
    const onClose = () => { if (!res.writableFinished) abort.abort(); };
    res.once('close', onClose);
    try {
      for (const [index, route] of chain.entries()) {
        const hasNext = index < chain.length - 1;
        const { url, init } = upstream.request(route, body, { stream, session, version, beta });
        const result = await upstream.attempt(url, init, abort, stream ? STREAM_HEADERS_TIMEOUT_MS : JSON_HEADERS_TIMEOUT_MS);
        if (result.aborted) return;
        const moveOn = (reason) => log(`[site-api] rau ${route.id} failed (${reason})${hasNext ? ', trying the next route' : ''}`);
        if (result.network) {
          moveOn('network');
          if (hasNext) continue;
          return fail(502, 'upstream_unavailable', 'Upstream unavailable.');
        }
        const answer = result.response;
        if (!answer.ok) {
          const errorBody = jsonOrNull(answer.body ? await readBounded(answer.body, MAX_ERROR_BYTES).catch(() => null) : null);
          if (upstream.failover(answer.status, errorBody)) {
            moveOn(String(answer.status));
            if (hasNext) continue;
            if (upstream.ownFailure(answer.status, errorBody)) return fail(502, 'upstream_unavailable', 'Upstream unavailable.');
          }
          // The client's own mistake (or the last route's overload or rate limit) passes through.
          const retryAfter = answer.headers.get('retry-after');
          res.writeHead(answer.status, {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
            ...(retryAfter ? { 'Retry-After': retryAfter } : {}),
          });
          res.end(JSON.stringify(errorBody?.type === 'error' ? errorBody : { type: 'error', error: { type: 'api_error', message: `Upstream answered ${answer.status}.` } }));
          return;
        }
        const reader = answer.body?.getReader();
        if (!reader) { res.writeHead(answer.status); res.end(); return; }
        let first = [];
        if (stream && hasNext) {
          const peek = await upstream.peekFirstEvent(reader).catch(() => ({ chunks: [], errorType: 'network' }));
          if (abort.signal.aborted) { reader.cancel().catch(() => {}); return; }
          if (peek.errorType && (peek.errorType === 'network' || STREAM_FAILOVER.has(peek.errorType))) {
            reader.cancel().catch(() => {});
            moveOn(`stream ${peek.errorType}`);
            continue;
          }
          first = peek.chunks;
        }
        // Served after a failover: the session stays on this route for a while.
        if (index > 0) upstream.pin(session, route);
        const { meter, sse, json } = createMeter();
        const jsonChunks = [];
        let jsonBytes = 0;
        const tap = stream
          ? (chunk) => sse(chunk)
          : (chunk) => {
            jsonBytes += chunk.length;
            if (jsonBytes <= MAX_JSON_REPLY_BYTES) jsonChunks.push(chunk);
          };
        await pipe(res, answer, reader, first, tap);
        if (!stream && jsonBytes <= MAX_JSON_REPLY_BYTES) json(Buffer.concat(jsonChunks));
        const call = upstream.bill(route, meter, requestBytes);
        await rau.record(principal, call).catch((error) => log(`[site-api] rau usage for ${principal.ledgerId} not recorded: ${error?.message ?? error}`));
        return;
      }
      return fail(502, 'upstream_unavailable', 'Upstream unavailable.');
    } finally {
      res.off('close', onClose);
    }
  }

  /** Streams an upstream answer to the client while the meter reads it. Never throws. */
  async function pipe(res, answer, reader, firstChunks, tap) {
    const headers = {
      'Content-Type': answer.headers.get('content-type') || 'application/json',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'X-Accel-Buffering': 'no',
    };
    const retryAfter = answer.headers.get('retry-after');
    if (retryAfter) headers['retry-after'] = retryAfter;
    res.writeHead(answer.status, headers);
    res.flushHeaders();
    try {
      for (const chunk of firstChunks) {
        tap(chunk);
        if (!res.write(chunk)) await writable(res);
      }
      for (;;) {
        if (res.destroyed) break;
        const { done, value } = await reader.read();
        if (done) break;
        tap(value);
        if (!res.write(value)) {
          await writable(res);
          if (res.destroyed) break;
        }
      }
      res.end();
    } catch {
      // Client disconnect (aborted upstream) or a broken upstream stream: cut the response.
      res.destroy();
    } finally {
      reader.cancel().catch(() => {});
    }
  }

  return { handle };
}
