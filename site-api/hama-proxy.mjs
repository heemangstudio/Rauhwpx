import { createHash } from 'node:crypto';

import {
  HAMA_ANTHROPIC_PREFIX,
  HAMA_CLAUDE_API_MODEL,
  HAMA_CLAUDE_MODEL,
  HAMA_OPENAI_PREFIX,
} from './hama.mjs';
import { HAIKU_PRICES, costFromUsage, finite, usd } from './hama-ledger.mjs';
import { createRateLimiter } from './rate-limit.mjs';

/**
 * Hama proxy: the app's Pi harness calls these two routes with its license lease as the API key.
 *
 * - `${HAMA_ANTHROPIC_PREFIX}/v1/messages` (Anthropic Messages): Haiku 5.5 only. Anthropic direct
 *   first with ANTHROPIC_API_KEY; OpenRouter's Anthropic-compatible `/messages` with
 *   HAMA_OPENROUTER_KEY is the backup, used only before any byte reached the client.
 * - `${HAMA_OPENAI_PREFIX}/chat/completions` (OpenAI chat completions on OpenRouter): cheap models only.
 *
 * Both stream through as they arrive and parse usage on the way, without holding bytes back, then
 * bill the call once by its provider id (hama.record). A cut stream is still billed: what upstream
 * reported, or a conservative estimate when no final usage arrived.
 */

export const HAMA_CONCURRENCY_PER_LICENSE = 4;
export const HAMA_REQUESTS_PER_MINUTE = 60;
export const MAX_HAMA_BODY_BYTES = 16 * 1024 * 1024;
const MINUTE = 60 * 1000;
const ANTHROPIC_VERSION = '2023-06-01';
// Until upstream answers with headers. A non-streamed reply only answers once it is complete.
const STREAM_HEADERS_TIMEOUT_MS = 60 * 1000;
const JSON_HEADERS_TIMEOUT_MS = 10 * MINUTE;
const MAX_ERROR_BYTES = 64 * 1024;
const MAX_JSON_REPLY_BYTES = 32 * 1024 * 1024;
const MAX_SSE_LINE_BYTES = 1024 * 1024;
// A session that failed over stays on OpenRouter this long: prompt caches are per provider.
const FAILOVER_COOLDOWN_MS = 30 * MINUTE;
const SESSION_TTL_MS = 60 * MINUTE;
const MAX_SESSIONS = 5000;
const BILLING_ERROR = /credit balance|billing/i;
const ANTHROPIC_MID_STREAM_FAILOVER = new Set(['overloaded_error', 'api_error', 'rate_limit_error']);

function bearer(req) {
  const match = String(req.headers.authorization ?? '').match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() ?? '';
}

function leaseOf(req) {
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

/** OpenRouter provider display name ("Google Vertex") → routing slug ("google-vertex"). */
export function providerSlug(name) {
  return String(name ?? '').trim().toLowerCase().replace(/\s+/g, '-');
}

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
 * Session key, scoped to the license: Pi's session id when it sends one (`x-session-id` for provider
 * `openrouter` on both APIs, `prompt_cache_key` on OpenAI), else a hash of the conversation's stable
 * start (model, system prompt, first user message). `metadata.user_id` names a user, not a session.
 */
function sessionKey(keyId, req, payload, { model, system, firstUser }) {
  const explicit = String(req.headers['x-session-id'] ?? req.headers['x-session-affinity'] ?? '').trim()
    || (typeof payload.prompt_cache_key === 'string' ? payload.prompt_cache_key : '');
  if (explicit) return sha(`${keyId}\nid\n${explicit.slice(0, 512)}`);
  return sha(`${keyId}\n${model}\n${JSON.stringify(system ?? null)}\n${JSON.stringify(firstUser ?? null)}`);
}

/** Line splitter over a byte stream; calls onLine for every complete `data:` payload. */
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
 * Usage of one call as it streams by. Anthropic: message_start carries the id and input usage,
 * message_delta the cumulative output (and possibly updated input/cache counts). OpenAI (OpenRouter):
 * every chunk carries the id and provider, the last one usage with `cost`.
 */
function createMeter(kind) {
  const m = {
    id: null,
    provider: null,
    model: null,
    final: false,
    started: false,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    cost: null,
    deltaBytes: 0,
    replyBytes: 0,
  };
  const set = (field, value) => { const n = finite(value); if (n !== null) m[field] = n; };
  function anthropicUsage(u) {
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
  function openaiUsage(u) {
    if (!u || typeof u !== 'object') return;
    const cached = finite(u.prompt_tokens_details?.cached_tokens) ?? 0;
    const written = finite(u.prompt_tokens_details?.cache_write_tokens) ?? 0;
    m.input = Math.max(0, (finite(u.prompt_tokens) ?? 0) - cached - written);
    m.cacheRead = cached;
    m.cacheWrite5m = written;
    set('output', u.completion_tokens);
    const cost = finite(u.cost);
    if (cost !== null) m.cost = cost + (u.is_byok ? (finite(u.cost_details?.upstream_inference_cost) ?? 0) : 0);
    m.final = true;
  }
  function event(data) {
    if (!data || typeof data !== 'object') return;
    if (kind === 'anthropic') {
      if (data.type === 'message_start' && data.message) {
        m.started = true;
        if (typeof data.message.id === 'string') m.id = data.message.id;
        if (typeof data.message.model === 'string') m.model = data.message.model;
        if (typeof data.message.provider === 'string') m.provider = data.message.provider;
        anthropicUsage(data.message.usage);
      } else if (data.type === 'message_delta') {
        anthropicUsage(data.usage);
        m.final = true;
      } else if (data.type === 'content_block_delta' && data.delta) {
        const text = data.delta.text ?? data.delta.partial_json ?? data.delta.thinking ?? '';
        if (typeof text === 'string') m.deltaBytes += Buffer.byteLength(text);
      } else if (data.type === 'message' && typeof data.id === 'string') {
        // A non-streamed reply.
        m.started = true;
        m.id = data.id;
        if (typeof data.model === 'string') m.model = data.model;
        if (typeof data.provider === 'string') m.provider = data.provider;
        anthropicUsage(data.usage);
        m.final = Boolean(data.usage);
      }
      return;
    }
    m.started = true;
    if (typeof data.id === 'string' && !m.id) m.id = data.id;
    if (typeof data.provider === 'string') m.provider = data.provider;
    if (typeof data.model === 'string') m.model = data.model;
    for (const choice of Array.isArray(data.choices) ? data.choices : []) {
      const content = choice?.delta?.content ?? choice?.message?.content;
      const reasoning = choice?.delta?.reasoning ?? choice?.message?.reasoning;
      for (const text of [content, reasoning]) if (typeof text === 'string') m.deltaBytes += Buffer.byteLength(text);
      for (const call of choice?.delta?.tool_calls ?? choice?.message?.tool_calls ?? []) {
        const args = call?.function?.arguments;
        if (typeof args === 'string') m.deltaBytes += Buffer.byteLength(args);
      }
    }
    if (data.usage) openaiUsage(data.usage);
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

export function createHamaProxy({
  hama,
  config = {},
  fetchImpl = globalThis.fetch,
  now = Date.now,
  log = (line) => process.stderr.write(`${line}\n`),
} = {}) {
  const {
    anthropicKey = '',
    anthropicBase = 'https://api.anthropic.com',
    openrouterKey = '',
    openrouterBase = 'https://openrouter.ai/api/v1',
    cheapModels = [],
    cheapReasoningEffort = 'high',
    maxOutputTokens = 16000,
  } = config;
  const prices = { ...HAIKU_PRICES, ...(config.prices ?? {}) };
  const perLicense = createRateLimiter({ now });
  const inFlight = new Map();
  const claudePins = createSessionCache({ now }); // session → 'openrouter' after a failover
  const cheapPins = createSessionCache({ now }); // session → OpenRouter provider slug

  // ------------------------------------------------------------- responses

  /** Errors in each route's native shape: Anthropic {type:'error', error:{type,message}}, OpenAI {error:{code,message}}. */
  function sender(req, res, route) {
    const sendJson = (status, body, headers = {}) => {
      if (res.headersSent) { res.destroy(); return; }
      res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        ...headers,
      });
      res.end(JSON.stringify(body));
    };
    const fail = (status, code, message, { headers, extra } = {}) => {
      req.resume?.();
      const error = route === 'anthropic'
        ? { type: 'error', error: { type: code, message, ...extra } }
        : { error: { code, message, ...extra } };
      sendJson(status, error, headers);
    };
    return { sendJson, fail };
  }

  /** 429 for a cap: the message always holds `quota exceeded` (Pi does not retry it) and a parseable tag. */
  function refuseCap(fail, refusal) {
    const seconds = Math.max(1, Math.ceil((Date.parse(refusal.resetsAt) - now()) / 1000));
    const message = `Hama quota exceeded (${refusal.cap}) until ${refusal.resetsAt}. [hama-cap:${refusal.cap}:${refusal.resetsAt}]`;
    fail(429, refusal.cap, message, {
      headers: { 'Retry-After': String(seconds), 'X-Hama-Cap': refusal.cap, 'X-Hama-Resets-At': refusal.resetsAt },
      extra: { resetsAt: refusal.resetsAt },
    });
  }

  /** Clamps output tokens so one call cannot overshoot a cap by much; sets the field when missing. */
  function capTokens(payload, fields) {
    let capped = false;
    for (const field of fields) {
      if (payload[field] === undefined || payload[field] === null) continue;
      const value = Number(payload[field]);
      payload[field] = Number.isFinite(value) && value > 0 ? Math.min(Math.floor(value), maxOutputTokens) : maxOutputTokens;
      capped = true;
    }
    if (!capped) payload[fields[0]] = maxOutputTokens;
  }

  // -------------------------------------------------------------- upstream

  /**
   * One upstream attempt until response headers. Returns {response} or {network: true} (refused,
   * reset or timed out) or {aborted: true} (the client left).
   */
  async function attempt(url, init, clientAbort, stream) {
    const timer = new AbortController();
    const timeout = setTimeout(() => timer.abort(), stream ? STREAM_HEADERS_TIMEOUT_MS : JSON_HEADERS_TIMEOUT_MS);
    try {
      const response = await fetchImpl(url, { ...init, signal: AbortSignal.any([clientAbort.signal, timer.signal]) });
      return { response };
    } catch {
      return clientAbort.signal.aborted ? { aborted: true } : { network: true };
    } finally {
      clearTimeout(timeout);
    }
  }

  /** Whether an Anthropic error answer should move the call to the backup: never for a client's own mistake. */
  function anthropicFailover(status, body) {
    if (status === 429 || status >= 500 || status === 401 || status === 402 || status === 403) return true;
    return status === 400 && BILLING_ERROR.test(String(body?.error?.message ?? ''));
  }

  /**
   * Peeks at a 200 stream's first event: Anthropic may answer 200 and then an `error` event (overloaded).
   * Returns the bytes read, and whether that first event is such an error.
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

  /** Streams an upstream answer to the client while the meter reads it. Never throws. */
  async function pipe(res, upstream, reader, firstChunks, tap, provider) {
    const headers = {
      'Content-Type': upstream.headers.get('content-type') || 'application/json',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'X-Accel-Buffering': 'no',
      'X-Hama-Provider': provider,
    };
    for (const name of ['retry-after', 'request-id', 'x-generation-id']) {
      const value = upstream.headers.get(name);
      if (value) headers[name] = value;
    }
    res.writeHead(upstream.status, headers);
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

  /** Bills a call from its meter. The estimate (no final usage) errs high: ~3 bytes per token. */
  async function bill(keyId, meter, { route, provider, requestBytes }) {
    let costUsd;
    let costSource;
    let { input, output } = meter;
    if (meter.cost !== null && meter.final) {
      costUsd = meter.cost;
      costSource = 'upstream';
    } else if (meter.final) {
      costUsd = costFromUsage({ inputTokens: input, outputTokens: output, cacheReadTokens: meter.cacheRead, cacheWrite5mTokens: meter.cacheWrite5m, cacheWrite1hTokens: meter.cacheWrite1h }, prices);
      costSource = 'price_table';
    } else {
      if (!meter.started || !(input + meter.cacheRead + meter.cacheWrite5m + meter.cacheWrite1h > 0)) input = Math.ceil(requestBytes / 3);
      output = Math.max(output, Math.ceil(meter.deltaBytes / 3));
      costUsd = costFromUsage({ inputTokens: input, outputTokens: output, cacheReadTokens: meter.cacheRead, cacheWrite5mTokens: meter.cacheWrite5m, cacheWrite1hTokens: meter.cacheWrite1h }, prices);
      costSource = 'estimate';
    }
    await hama.record(keyId, {
      id: meter.id,
      route,
      provider: meter.provider ? `${provider}:${meter.provider}` : provider,
      model: meter.model,
      inputTokens: input,
      outputTokens: output,
      cacheReadTokens: meter.cacheRead,
      cacheWriteTokens: meter.cacheWrite5m + meter.cacheWrite1h,
      costUsd: usd(costUsd),
      costSource,
    }).catch((error) => log(`[site-api] hama usage for ${keyId} not recorded: ${error?.message ?? error}`));
  }

  // ----------------------------------------------------------- entry point

  async function handle(req, res, pathname) {
    const route = pathname.startsWith(`${HAMA_ANTHROPIC_PREFIX}/`) ? 'anthropic' : 'openai';
    const subpath = pathname.slice((route === 'anthropic' ? HAMA_ANTHROPIC_PREFIX : HAMA_OPENAI_PREFIX).length);
    const { fail, sendJson } = sender(req, res, route);
    const known = route === 'anthropic'
      ? `${req.method} ${subpath}` === 'POST /v1/messages'
      : ['POST /chat/completions', 'GET /models'].includes(`${req.method} ${subpath}`);
    if (!known) return fail(404, 'not_found', 'Not found.');
    if (route === 'openai' && req.method === 'GET') {
      req.resume?.();
      return sendJson(200, { data: cheapModels.map((id) => ({ id, name: id })) });
    }

    let admitted;
    try {
      admitted = await hama.admit(leaseOf(req), { cheap: route === 'openai' });
    } catch (error) {
      if (error?.licenseError) return fail(error.status, error.code, error.code === 'hama_not_enrolled' ? 'The Hama plan is not active for this license.' : 'Invalid or expired license lease.');
      log(`[site-api] hama auth failed: ${error?.message ?? error}`);
      return fail(503, 'service_unavailable', 'Service unavailable.');
    }
    if (admitted.refusal) return refuseCap(fail, admitted.refusal);
    const { keyId } = admitted;
    if (!perLicense.check(keyId, HAMA_REQUESTS_PER_MINUTE, MINUTE)) {
      return fail(429, 'rate_limited', 'Too many requests on the Hama plan. Retry in a minute.', { headers: { 'Retry-After': '60' } });
    }
    if ((inFlight.get(keyId) ?? 0) >= HAMA_CONCURRENCY_PER_LICENSE) {
      return fail(429, 'rate_limited', 'Too many concurrent requests on the Hama plan.', { headers: { 'Retry-After': '5' } });
    }
    inFlight.set(keyId, (inFlight.get(keyId) ?? 0) + 1);
    try {
      const raw = await readBounded(req, MAX_HAMA_BODY_BYTES).catch(() => undefined);
      if (raw === undefined) return; // client went away while uploading
      if (raw === null) return fail(413, 'too_large', 'Request body too large.');
      const payload = jsonOrNull(raw);
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return fail(400, 'invalid_request', 'Request body is not a JSON object.');
      if (route === 'anthropic') await forwardClaude(req, res, keyId, payload, raw.length, fail);
      else await forwardCheap(req, res, keyId, payload, raw.length, fail);
    } finally {
      const left = (inFlight.get(keyId) ?? 1) - 1;
      if (left > 0) inFlight.set(keyId, left);
      else inFlight.delete(keyId);
    }
  }

  // ---------------------------------------------------------------- Claude

  async function forwardClaude(req, res, keyId, payload, requestBytes, fail) {
    if (payload.model !== HAMA_CLAUDE_MODEL && payload.model !== HAMA_CLAUDE_API_MODEL) {
      const model = String(payload.model ?? '(none)').slice(0, 100);
      return fail(400, 'model_not_allowed', `Model not available on the Hama plan: ${model}. Allowed: ${HAMA_CLAUDE_MODEL}`);
    }
    // Server tools and MCP connectors bill outside token usage, so the plan does not carry them.
    if (Array.isArray(payload.tools) && payload.tools.some((tool) => tool?.type !== undefined && tool.type !== 'custom')) {
      return fail(400, 'tool_not_allowed', 'Server tools are not available on the Hama plan.');
    }
    if (payload.mcp_servers !== undefined) return fail(400, 'tool_not_allowed', 'MCP servers are not available on the Hama plan.');
    const efforts = ['low', 'medium', 'high', 'xhigh'];
    const requestedEfforts = [payload.output_config?.effort, ...(Array.isArray(payload.messages) ? payload.messages.map((message) => message?.output_config?.effort) : [])];
    if (requestedEfforts.some((effort) => effort !== undefined && !efforts.includes(effort))) {
      return fail(400, 'invalid_request', 'Haiku supports low, medium, high and xhigh effort on Hama.');
    }
    capTokens(payload, ['max_tokens']);
    const stream = payload.stream === true;
    const firstUser = Array.isArray(payload.messages) ? payload.messages.find((m) => m?.role === 'user')?.content : null;
    const session = sessionKey(keyId, req, payload, { model: HAMA_CLAUDE_MODEL, system: payload.system, firstUser });

    const version = String(req.headers['anthropic-version'] ?? '');
    const beta = String(req.headers['anthropic-beta'] ?? '');
    const anthropicHeaders = {
      'Content-Type': 'application/json',
      Accept: stream ? 'text/event-stream' : 'application/json',
      'anthropic-version': /^\d{4}-\d{2}-\d{2}$/.test(version) ? version : ANTHROPIC_VERSION,
      ...(/^[A-Za-z0-9._,\- ]{1,512}$/.test(beta) ? { 'anthropic-beta': beta } : {}),
    };
    const routes = [];
    if (anthropicKey && claudePins.get(session) !== 'openrouter') routes.push('anthropic');
    if (openrouterKey) routes.push('openrouter');
    if (routes.length === 0) return fail(503, 'not_configured', 'The Hama plan has no upstream configured.');

    const abort = new AbortController();
    const onClose = () => { if (!res.writableFinished) abort.abort(); };
    res.once('close', onClose);
    try {
      for (const [index, provider] of routes.entries()) {
        const body = provider === 'anthropic'
          ? { ...payload, model: HAMA_CLAUDE_API_MODEL }
          : { ...payload, model: HAMA_CLAUDE_MODEL, session_id: session.slice(0, 64) };
        const init = provider === 'anthropic'
          ? { method: 'POST', headers: { ...anthropicHeaders, 'x-api-key': anthropicKey }, body: JSON.stringify(body) }
          : {
            method: 'POST',
            headers: { ...anthropicHeaders, Authorization: `Bearer ${openrouterKey}`, 'HTTP-Referer': 'https://heemangstudios.com/', 'X-Title': 'HamaEditor' },
            body: JSON.stringify(body),
          };
        const url = provider === 'anthropic' ? `${anthropicBase}/v1/messages` : `${openrouterBase}/messages`;
        const hasNext = index < routes.length - 1;
        const result = await attempt(url, init, abort, stream);
        if (result.aborted) return;
        const moveOn = (reason) => {
          log(`[site-api] hama ${provider} failed (${reason})${hasNext ? ', trying the backup' : ''}`);
          if (provider === 'anthropic' && hasNext) claudePins.set(session, 'openrouter', FAILOVER_COOLDOWN_MS);
        };
        if (result.network) {
          moveOn('network');
          if (hasNext) continue;
          return fail(502, 'upstream_unavailable', 'Upstream unavailable.');
        }
        const upstream = result.response;
        if (!upstream.ok) {
          const errorRaw = upstream.body ? await readBounded(upstream.body, MAX_ERROR_BYTES).catch(() => null) : null;
          const errorBody = jsonOrNull(errorRaw);
          if (provider === 'anthropic' ? anthropicFailover(upstream.status, errorBody) : false) {
            moveOn(String(upstream.status));
            if (hasNext) continue;
          }
          if (provider === 'openrouter') log(`[site-api] hama openrouter answered ${upstream.status}`);
          const retryAfter = upstream.headers.get('retry-after');
          res.writeHead(upstream.status, {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
            'X-Hama-Provider': provider,
            ...(retryAfter ? { 'Retry-After': retryAfter } : {}),
          });
          res.end(errorBody ? JSON.stringify(errorBody) : JSON.stringify({ type: 'error', error: { type: 'api_error', message: `Upstream answered ${upstream.status}.` } }));
          return;
        }
        const reader = upstream.body?.getReader();
        if (!reader) { res.writeHead(upstream.status); res.end(); return; }
        let first = [];
        if (stream && hasNext) {
          const peek = await peekFirstEvent(reader).catch(() => ({ chunks: [], errorType: 'network' }));
          if (abort.signal.aborted) { reader.cancel().catch(() => {}); return; }
          if (peek.errorType && (peek.errorType === 'network' || ANTHROPIC_MID_STREAM_FAILOVER.has(peek.errorType))) {
            reader.cancel().catch(() => {});
            moveOn(`stream ${peek.errorType}`);
            continue;
          }
          first = peek.chunks;
        }
        const { meter, sse, json } = createMeter('anthropic');
        const jsonChunks = [];
        let jsonBytes = 0;
        const tap = stream
          ? (chunk) => { meter.replyBytes += chunk.length; sse(chunk); }
          : (chunk) => {
            meter.replyBytes += chunk.length;
            jsonBytes += chunk.length;
            if (jsonBytes <= MAX_JSON_REPLY_BYTES) jsonChunks.push(chunk);
          };
        await pipe(res, upstream, reader, first, tap, provider);
        if (!stream && jsonBytes <= MAX_JSON_REPLY_BYTES) json(Buffer.concat(jsonChunks));
        await bill(keyId, meter, { route: 'anthropic', provider, requestBytes });
        return;
      }
      return fail(502, 'upstream_unavailable', 'Upstream unavailable.');
    } finally {
      res.off('close', onClose);
    }
  }

  // ----------------------------------------------------------------- cheap

  async function forwardCheap(req, res, keyId, payload, requestBytes, fail) {
    const requested = [payload.model, ...(Array.isArray(payload.models) ? payload.models : [])];
    if (payload.models !== undefined && !Array.isArray(payload.models)) return fail(400, 'invalid_request', 'models must be an array.');
    const rejected = requested.find((model) => typeof model !== 'string' || !cheapModels.includes(model));
    if (rejected !== undefined) {
      const model = String(rejected ?? '(none)').slice(0, 100);
      return fail(400, 'model_not_allowed', `Model not available on the Hama plan's OpenAI route: ${model}. Allowed: ${cheapModels.join(', ')}`);
    }
    if (!openrouterKey) return fail(503, 'not_configured', 'The Hama plan has no upstream configured.');
    capTokens(payload, ['max_tokens', 'max_completion_tokens']);
    const effort = payload.reasoning?.effort ?? payload.reasoning_effort ?? cheapReasoningEffort;
    if (!['low', 'high', 'max'].includes(effort)) {
      return fail(400, 'invalid_request', 'DeepSeek supports low, high and max effort on Hama.');
    }
    delete payload.reasoning_effort;
    payload.reasoning = { effort };
    payload.usage = { include: true };
    const stream = payload.stream === true;
    if (stream) payload.stream_options = { ...(payload.stream_options ?? {}), include_usage: true };
    const messages = Array.isArray(payload.messages) ? payload.messages : [];
    const session = sessionKey(keyId, req, payload, {
      model: payload.model,
      system: messages.filter((m) => m?.role === 'system' || m?.role === 'developer').map((m) => m.content),
      firstUser: messages.find((m) => m?.role === 'user')?.content,
    });
    payload.session_id = session.slice(0, 64);
    const pinned = cheapPins.get(`${session}\n${payload.model}`);
    if (pinned && payload.provider === undefined) payload.provider = { order: [pinned], allow_fallbacks: true };

    const abort = new AbortController();
    const onClose = () => { if (!res.writableFinished) abort.abort(); };
    res.once('close', onClose);
    try {
      const result = await attempt(`${openrouterBase}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${openrouterKey}`,
          'Content-Type': 'application/json',
          Accept: stream ? 'text/event-stream' : 'application/json',
          'HTTP-Referer': 'https://heemangstudios.com/',
          'X-Title': 'HamaEditor',
        },
        body: JSON.stringify(payload),
      }, abort, stream);
      if (result.aborted) return;
      if (result.network) return fail(502, 'upstream_unavailable', 'Upstream unavailable.');
      const upstream = result.response;
      if (!upstream.ok) {
        const errorRaw = upstream.body ? await readBounded(upstream.body, MAX_ERROR_BYTES).catch(() => null) : null;
        log(`[site-api] hama openrouter answered ${upstream.status}`);
        const retryAfter = upstream.headers.get('retry-after');
        res.writeHead(upstream.status, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
          ...(retryAfter ? { 'Retry-After': retryAfter } : {}),
        });
        res.end(errorRaw && jsonOrNull(errorRaw) ? errorRaw : JSON.stringify({ error: { code: upstream.status, message: 'Upstream refused the request.' } }));
        return;
      }
      const reader = upstream.body?.getReader();
      if (!reader) { res.writeHead(upstream.status); res.end(); return; }
      const { meter, sse, json } = createMeter('openai');
      const jsonChunks = [];
      let jsonBytes = 0;
      const tap = stream
        ? (chunk) => { meter.replyBytes += chunk.length; sse(chunk); }
        : (chunk) => {
          meter.replyBytes += chunk.length;
          jsonBytes += chunk.length;
          if (jsonBytes <= MAX_JSON_REPLY_BYTES) jsonChunks.push(chunk);
        };
      await pipe(res, upstream, reader, [], tap, 'openrouter');
      if (!stream && jsonBytes <= MAX_JSON_REPLY_BYTES) json(Buffer.concat(jsonChunks));
      // The provider that served this session's first call keeps serving it (its prompt cache is warm).
      if (!pinned && meter.provider) cheapPins.set(`${session}\n${payload.model}`, providerSlug(meter.provider));
      await bill(keyId, meter, { route: 'openai', provider: 'openrouter', requestBytes });
    } finally {
      res.off('close', onClose);
    }
  }

  return { handle };
}
