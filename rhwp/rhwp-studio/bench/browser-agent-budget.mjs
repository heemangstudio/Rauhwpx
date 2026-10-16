/** Persistent OpenRouter spend guard. Only this proxy receives the paid key.
 * Prices: https://openrouter.ai/api/v1/models and /models/:id/endpoints
 * Cost: https://openrouter.ai/docs/guides/guides/usage-accounting
 * Ceilings: https://openrouter.ai/docs/guides/routing/provider-selection#max-price
 * Linux flock owns the ledger for the process lifetime. Pending reservations
 * survive crashes, missing usage, transport errors, and malformed responses.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

const UNIT = 1_000_000_000_000n;
const DEFAULT_CAP = 10n * UNIT;
function configuredCap(maxUsd) {
  const units = maxUsd * Number(UNIT);
  if (typeof maxUsd !== 'number' || !Number.isFinite(maxUsd) || maxUsd <= 0 || !Number.isSafeInteger(units)) throw new Error('Budget cap must be positive finite USD in exact picodollars');
  return BigInt(units);
}
// Round UP to picodollars, including sub-picodollar token prices.
function money(value) {
  if (!['string', 'number'].includes(typeof value)) throw new Error('Unknown price/cost');
  const match = /^(\d+)(?:\.(\d*))?(?:e([+-]?\d+))?$/i.exec(String(value));
  if (!match) throw new Error('Invalid nonnegative price/cost');
  const exponent = Number(match[3] || 0) + 12 - (match[2]?.length || 0);
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 100) throw new Error('Unbounded price/cost');
  const digits = BigInt(match[1] + (match[2] || ''));
  if (exponent >= 0) return digits * 10n ** BigInt(exponent);
  const divisor = 10n ** BigInt(-exponent);
  return (digits + divisor - 1n) / divisor;
}
function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Missing bounded ${label}`);
  return value;
}
const INPUT_PRICES = ['prompt', 'input_cache_read', 'input_cache_write', 'input_cache_write_1h'];
const OUTPUT_PRICES = ['completion', 'internal_reasoning'];
const OTHER_PRICES = ['request', 'image', 'image_token', 'image_output', 'audio', 'input_audio', 'output_audio', 'input_audio_cache', 'web_search'];
function prices(pricing, partial = false) {
  if (!pricing || typeof pricing !== 'object' || Array.isArray(pricing)) throw new Error('Unknown pricing');
  if (!partial && (pricing.prompt == null || pricing.completion == null)) throw new Error('Unknown token pricing');
  const rates = {};
  for (const [key, value] of Object.entries(pricing)) {
    if (key === 'overrides') continue;
    if (key === 'discount') { if (Number(value) < 0 || Number(value) > 1 || !Number.isFinite(Number(value))) throw new Error('Invalid discount'); continue; }
    if (partial && key === 'min_prompt_tokens') { positiveInteger(value, 'tier threshold'); continue; }
    if (partial && ['utc_start', 'utc_end'].includes(key)) { if (!Number.isInteger(value) || value < 0 || value > 2359 || value % 100 > 59) throw new Error('Invalid UTC pricing window'); continue; }
    if (partial && key === 'utc_days') { if (!Array.isArray(value) || !value.length || value.some(day => !['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'].includes(day))) throw new Error('Invalid UTC pricing days'); continue; }
    if (![...INPUT_PRICES, ...OUTPUT_PRICES, ...OTHER_PRICES].includes(key)) throw new Error(`Unknown pricing field ${key}`);
    rates[key] = money(value);
  }
  if (pricing.overrides !== undefined) {
    if (!Array.isArray(pricing.overrides)) throw new Error('Unknown pricing tiers');
    for (const tier of pricing.overrides) {
      if (tier.min_prompt_tokens === undefined && tier.utc_start === undefined && tier.utc_days === undefined) throw new Error('Unknown pricing tier condition');
      if ((tier.utc_start === undefined) !== (tier.utc_end === undefined)) throw new Error('Incomplete UTC pricing window');
      for (const [key, value] of Object.entries(prices(tier, true))) rates[key] = value > (rates[key] || 0n) ? value : rates[key];
    }
  }
  return rates;
}
/** Prices are nonnegative integer picodollars already rounded UP by money().
 * PublicEndpoint.max_completion_tokens explicitly shares context with input:
 * https://openrouter.ai/openapi.json#/components/schemas/PublicEndpoint
 * Combined context: https://openrouter.ai/docs/guides/providers/integration
 * Reasoning is output: https://openrouter.ai/docs/guides/best-practices/reasoning-tokens
 */
export function jointContextReservation({ contextLength, outputTokens, inputPrice, outputPrice, requestPrice = 0n }) {
  positiveInteger(contextLength, 'context');
  if (!Number.isSafeInteger(outputTokens) || outputTokens < 0) throw new Error('Missing bounded output ceiling');
  if ([inputPrice, outputPrice, requestPrice].some(price => typeof price !== 'bigint' || price < 0n)) throw new Error('Prices must be nonnegative integer picodollars');
  return BigInt(contextLength) * inputPrice
    + (outputPrice > inputPrice ? outputPrice - inputPrice : 0n) * BigInt(Math.min(outputTokens, contextLength)) + requestPrice;
}
function bound(model) {
  if (!Array.isArray(model.architecture?.output_modalities) || model.architecture.output_modalities.length !== 1 || model.architecture.output_modalities[0] !== 'text') throw new Error('Only known text-output models are budgeted');
  const context = positiveInteger(model.context_length, 'model context');
  const endpoints = model.endpoints;
  if (!Array.isArray(endpoints) || !endpoints.length) throw new Error(`No authoritative endpoint pricing for ${model.id}`);
  // OpenRouter documents total-output max_tokens enforcement only for most providers.
  // Reserve the catalog's finite completion ceiling, including reasoning, instead.
  const reservedOutputTokens = Math.max(...endpoints.map(e => positiveInteger(e.max_completion_tokens, 'endpoint completion ceiling')));
  let maxContext = context, input = 0n, output = 0n, request = 0n;
  for (const endpoint of [model, ...endpoints]) {
    maxContext = Math.max(maxContext, positiveInteger(endpoint.context_length, 'endpoint context'));
    const rate = prices(endpoint.pricing);
    // Add cache charges conservatively rather than assuming they replace input.
    const cache = INPUT_PRICES.slice(1).reduce((max, key) => (rate[key] || 0n) > max ? rate[key] : max, 0n);
    input = input > rate.prompt + cache ? input : rate.prompt + cache;
    const out = OUTPUT_PRICES.reduce((max, key) => (rate[key] || 0n) > max ? rate[key] : max, 0n);
    output = output > out ? output : out;
    request = request > (rate.request || 0n) ? request : rate.request || 0n;
  }
  return { id: model.id, contextLength: maxContext, reservedOutputTokens, input, output, request,
    reserve: jointContextReservation({ contextLength: maxContext, outputTokens: reservedOutputTokens, inputPrice: input, outputPrice: output, requestPrice: request }) };
}
async function lockLedger(file) {
  // The helper exits on pipe EOF even if this process crashes; the kernel releases flock.
  const child = spawn('flock', ['--exclusive', '--nonblock', `${file}.lock`, process.execPath, '-e',
    "process.stdout.write('locked\\n');process.stdin.resume();process.stdin.on('end',()=>process.exit(0))"], { stdio: ['pipe', 'pipe', 'ignore'] });
  child.stdin.on('error', () => {});
  await new Promise((resolve, reject) => {
    child.once('error', () => reject(new Error('Ledger locking requires flock')));
    child.once('exit', () => reject(new Error('Budget ledger is already locked')));
    child.stdout.once('data', () => resolve());
  });
  return child;
}
async function atomicWrite(file, data) {
  const tmp = `${file}.${randomUUID()}.tmp`;
  const handle = await fs.open(tmp, 'wx', 0o600);
  try { await handle.writeFile(`${JSON.stringify(data, null, 2)}\n`); await handle.sync(); } finally { await handle.close(); }
  await fs.rename(tmp, file);
  const dir = await fs.open(path.dirname(file), 'r');
  try { await dir.sync(); } finally { await dir.close(); }
}
function validateLedger(ledger) {
  if (ledger.version !== 1 || typeof ledger.cap !== 'string' || !/^[1-9]\d*$/.test(ledger.cap) || BigInt(ledger.cap) > BigInt(Number.MAX_SAFE_INTEGER) || !Array.isArray(ledger.requests) || typeof ledger.blocked !== 'boolean') throw new Error('Invalid budget ledger');
  for (const entry of ledger.requests) {
    if (!entry || typeof entry.id !== 'string' || typeof entry.model !== 'string' || !/^\d+$/.test(entry.reserved) || !['pending', 'settled'].includes(entry.state)) throw new Error('Invalid ledger request');
    if (entry.state === 'settled' && !/^\d+$/.test(entry.actual)) throw new Error('Invalid settled cost');
  }
}
function charged(ledger) { return ledger.requests.reduce((sum, r) => sum + BigInt(r.state === 'settled' ? r.actual : r.reserved), 0n); }
function fingerprintKey(key) {
  if (typeof key !== 'string' || !key) throw new Error('A nonempty key is required');
  return createHash('sha256').update(key, 'utf8').digest('hex');
}
const GENERATION_ID = /^gen-[A-Za-z0-9_-]{1,256}$/;
function settleCost(ledger, entry, cost, source) {
  entry.state = 'settled'; entry.actual = String(cost); entry.costSource = source;
  entry.settledAt = new Date().toISOString();
  if (cost > BigInt(entry.reserved) || charged(ledger) > BigInt(ledger.cap)) ledger.blocked = true;
}
async function reconcileEntry(ledger, entry, { key, upstreamUrl, fetchImpl, timeoutMs }, save) {
  if (!entry.keyFingerprint) return { id: entry.id, status: 'missing-key-fingerprint' };
  if (entry.keyFingerprint !== fingerprintKey(key)) return { id: entry.id, status: 'key-fingerprint-mismatch' };
  if (entry.generationConflict) return { id: entry.id, status: 'generation-conflict' };
  if (entry.state !== 'pending' || !GENERATION_ID.test(entry.generationId || '')) return { id: entry.id, status: 'no-generation-id' };
  try {
    const response = await fetchImpl(`${upstreamUrl}/generation?id=${encodeURIComponent(entry.generationId)}`, {
      method: 'GET', headers: { Authorization: `Bearer ${key}` }, redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return { id: entry.id, status: `lookup-http-${response.status}` };
    const data = (await response.json())?.data;
    if (data?.id !== entry.generationId || data?.model !== entry.model) return { id: entry.id, status: 'generation-mismatch' };
    // Never settle a provisional zero from an unfinished generation.
    if (typeof data.finish_reason !== 'string' || !data.finish_reason || !Number.isFinite(data.generation_time) || data.generation_time < 0) return { id: entry.id, status: 'generation-not-final' };
    const cost = money(data.total_cost);
    settleCost(ledger, entry, cost, 'generation.total_cost');
    await save();
    return { id: entry.id, status: 'settled' };
  } catch (error) { if (entry.state === 'settled') throw error; return { id: entry.id, status: 'lookup-failed' }; }
}
/** GET-only recovery. Existing unknown reservations are retained. Generation IDs
 * must already be captured from their own upstream response; no timestamp matching.
 * https://openrouter.ai/docs/api/api-reference/generations/get-generation
 */
export async function reconcileBudgetLedger({ ledgerFile, key, upstreamUrl = 'https://openrouter.ai/api/v1', fetchImpl = fetch, timeoutMs = 15000 } = {}) {
  if (!ledgerFile || !key) throw new Error('ledgerFile and key are required');
  fingerprintKey(key);
  positiveInteger(timeoutMs, 'lookup timeout');
  ledgerFile = path.resolve(ledgerFile);
  const lock = await lockLedger(ledgerFile);
  try {
    const ledger = JSON.parse(await fs.readFile(ledgerFile, 'utf8'));
    validateLedger(ledger);
    const outcomes = [];
    for (const entry of ledger.requests.filter(r => r.state === 'pending')) outcomes.push(await reconcileEntry(ledger, entry, { key, upstreamUrl, fetchImpl, timeoutMs }, () => atomicWrite(ledgerFile, ledger)));
    return { outcomes, spentUsd: Number(charged(ledger)) / 1e12, pending: ledger.requests.filter(r => r.state === 'pending').length, blocked: ledger.blocked };
  } finally { lock.stdin.end(); await new Promise(resolve => lock.exitCode !== null ? resolve() : lock.once('exit', resolve)); }
}

function reject(code, message) { return Object.assign(new Error(message), { status: code }); }
function textOnly(body) {
  if (!Array.isArray(body.messages) || !body.messages.length) throw reject(400, 'Messages required');
  for (const message of body.messages) {
    if (!message || typeof message !== 'object') throw reject(400, 'Invalid message');
    if (message.content != null && typeof message.content !== 'string') {
      if (!Array.isArray(message.content) || message.content.some(p => !p || p.type !== 'text' || typeof p.text !== 'string' || Object.keys(p).some(k => !['type', 'text', 'cache_control'].includes(k)))) throw reject(400, 'Only text input is budgeted');
    }
    if (Object.keys(message).some(k => !['role', 'content', 'name', 'tool_calls', 'tool_call_id', 'reasoning', 'reasoning_details'].includes(k))) throw reject(400, 'Unsupported message field');
  }
  if (body.tools && (!Array.isArray(body.tools) || body.tools.some(t => !t || t.type !== 'function' || typeof t.function?.name !== 'string' || t.function.name.startsWith('openrouter:')))) throw reject(400, 'Only local function tools are budgeted');
}
const ALLOWED = new Set(['model', 'messages', 'stream', 'max_tokens', 'max_completion_tokens', 'temperature', 'top_p', 'top_k', 'frequency_penalty', 'presence_penalty', 'repetition_penalty', 'seed', 'stop', 'tools', 'tool_choice', 'parallel_tool_calls', 'reasoning', 'reasoning_effort', 'include_reasoning', 'response_format', 'stream_options', 'usage', 'n', 'provider', 'store']);

/** models: exact model ID strings. catalog: optional raw models array, each with
 * endpoints (same shape as /models/:id/endpoints data.endpoints). Test injection
 * uses upstreamUrl/catalogUrl or fetchImpl. Never call a paid endpoint in tests.
 */
export async function startBudgetProxy({ ledgerFile, key, models, maxUsd = 10, capAuthorization,
  upstreamUrl = 'https://openrouter.ai/api/v1', catalogUrl = upstreamUrl, catalog,
  fetchImpl = fetch, timeoutMs = 180000, maxBodyBytes = 16 * 1024 * 1024 } = {}) {
  if (!ledgerFile || !key || !Array.isArray(models) || !models.length || models.some(m => typeof m !== 'string' || !m)) throw new Error('ledgerFile, key, and exact models are required');
  const keyFingerprint = fingerprintKey(key);
  const cap = configuredCap(maxUsd);
  positiveInteger(timeoutMs, 'timeout');
  positiveInteger(maxBodyBytes, 'request bytes');
  ledgerFile = path.resolve(ledgerFile);
  await fs.mkdir(path.dirname(ledgerFile), { recursive: true, mode: 0o700 });
  const lock = await lockLedger(ledgerFile);
  let ledger, server, stopped = false, fatal = false, uncertainRequestId = null, queue = Promise.resolve();
  const save = async () => { try { await atomicWrite(ledgerFile, ledger); } catch { fatal = true; throw new Error('Budget ledger write failed; proxy blocked'); } };
  const token = randomBytes(32).toString('hex');
  const readJson = async url => {
    const result = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
    if (!result.ok) throw new Error(`Catalog request failed (${result.status})`);
    return result.json();
  };
  try {
    let originalBytes;
    try { originalBytes = await fs.readFile(ledgerFile); ledger = JSON.parse(originalBytes); validateLedger(ledger); }
    catch (e) { if (e.code !== 'ENOENT') throw e; ledger = { version: 1, cap: String(cap), blocked: false, requests: [] }; await save(); }
    if (BigInt(ledger.cap) !== cap) {
      // Only the known original default may be raised by an explicit operator option.
      if (BigInt(ledger.cap) !== DEFAULT_CAP || cap <= DEFAULT_CAP || typeof capAuthorization !== 'string' || !capAuthorization.trim() || capAuthorization.length > 1024) throw new Error('Invalid budget ledger: cap differs from configured cap; explicit reviewed default-cap raise required');
      const backupFile = ledgerFile + '.before-cap-raise.' + randomUUID() + '.json';
      const backup = await fs.open(backupFile, 'wx', 0o600);
      try { await backup.writeFile(originalBytes); await backup.sync(); } finally { await backup.close(); }
      const directory = await fs.open(path.dirname(backupFile), 'r');
      try { await directory.sync(); } finally { await directory.close(); }
      ledger.capHistory ??= [];
      ledger.capHistory.push({ at: new Date().toISOString(), from: ledger.cap, to: String(cap), authorization: capAuthorization,
        backupFile, originalLedgerSha256: createHash('sha256').update(originalBytes).digest('hex') });
      ledger.cap = String(cap);
      await save();
    }
    const raw = catalog || (await readJson(`${catalogUrl}/models`)).data;
    if (!Array.isArray(raw)) throw new Error('Invalid model catalog');
    const bounds = new Map();
    for (const id of new Set(models)) {
      const model = raw.find(m => m.id === id);
      if (!model) throw new Error(`Unknown model ${id}`);
      const endpoints = model.endpoints || (await readJson(`${catalogUrl}/models/${id}/endpoints`)).data?.endpoints;
      bounds.set(id, bound({ ...model, endpoints }));
    }
    lock.once('exit', () => { fatal = true; server?.close(); });
    server = http.createServer((req, res) => {
      const run = async () => {
        let entry, forwarded = false;
        try {
          if (stopped || fatal || ledger.blocked) throw reject(503, 'Budget proxy blocked');
          const auth = Buffer.from(req.headers.authorization || '');
          const expected = Buffer.from(`Bearer ${token}`);
          if (auth.length !== expected.length || !timingSafeEqual(auth, expected)) throw reject(401, 'Unauthorized');
          if (req.method !== 'POST' || req.url !== '/api/v1/chat/completions') throw reject(404, 'Unsupported endpoint');
          if (uncertainRequestId) throw reject(402, `BUDGET_HOLD_UNSETTLED_REQUEST ${uncertainRequestId}`);
          let size = 0, chunks = [];
          for await (const chunk of req) { size += chunk.length; if (size > maxBodyBytes) throw reject(413, 'Request too large'); chunks.push(chunk); }
          let body;
          try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw reject(400, 'Invalid JSON'); }
          if (!body || Array.isArray(body) || typeof body !== 'object') throw reject(400, 'Request must be an object');
          const unknownFields = Object.keys(body).filter(k => !ALLOWED.has(k));
          if (unknownFields.length) throw reject(400, `Unsupported request fields: ${unknownFields.join(', ')}`);
          // Pi 1.1.0 sends store:false for OpenAI-compatible providers. It is
          // a local compatibility flag; omit it from the billable request.
          if (body.store !== undefined && body.store !== false) throw reject(400, 'Only store:false is supported');
          delete body.store;
          const model = bounds.get(body.model);
          if (!model) throw reject(400, 'Unknown model');
          if (body.n !== undefined && body.n !== 1) throw reject(400, 'Only one completion is budgeted');
          textOnly(body);
          if (body.max_tokens !== undefined && body.max_completion_tokens !== undefined) throw reject(400, 'Conflicting output limits');
          for (const field of ['max_tokens', 'max_completion_tokens']) if (body[field] !== undefined
            && (!Number.isSafeInteger(body[field]) || body[field] <= 0 || body[field] > model.reservedOutputTokens)) throw reject(400, 'Requested output is invalid or exceeds published ceiling');
          if (body.reasoning !== undefined) {
            if (!body.reasoning || typeof body.reasoning !== 'object' || Array.isArray(body.reasoning)
              || Object.keys(body.reasoning).some(key => !['effort', 'max_tokens', 'exclude', 'enabled'].includes(key))) throw reject(400, 'Unknown reasoning options');
            if (body.reasoning.max_tokens !== undefined && (!Number.isSafeInteger(body.reasoning.max_tokens) || body.reasoning.max_tokens <= 0 || body.reasoning.max_tokens > model.reservedOutputTokens)) throw reject(400, 'Reasoning output exceeds published ceiling');
          }
          if (body.provider !== undefined && (!body.provider || typeof body.provider !== 'object' || Array.isArray(body.provider))) throw reject(400, 'Invalid provider options');
          const sort = body.provider?.sort;
          if (sort !== undefined && !['throughput', 'latency', 'price'].includes(sort)) throw reject(400, 'Unknown provider sort');
          const requestedLimits = { maxTokens: body.max_tokens ?? null, maxCompletionTokens: body.max_completion_tokens ?? null,
            reasoningMaxTokens: body.reasoning?.max_tokens ?? null };
          if (charged(ledger) + model.reserve > cap) throw reject(402, 'Budget reservation exceeds $' + maxUsd + ' cap');
          entry = { id: randomUUID(), keyFingerprint, model: body.model, requestedLimits, reservationBasis: { formula: 'joint-context-v1', contextLength: model.contextLength, outputTokens: model.reservedOutputTokens, inputPrice: String(model.input), outputPrice: String(model.output), requestPrice: String(model.request), unit: 'picodollar' }, reserved: String(model.reserve), state: 'pending', startedAt: new Date().toISOString() };
          ledger.requests.push(entry);
          await save(); // Persist BEFORE even attempting a paid request.
          if (fatal) throw reject(503, 'Budget ledger lock lost');
          body.provider = { ...(sort ? { sort } : {}), allow_fallbacks: false, require_parameters: true, max_price: {
            prompt: Number(model.input) / 1e6, completion: Number(model.output) / 1e6, request: Number(model.request) / 1e12 } };
          body.usage = { include: true };
          if (body.stream) body.stream_options = { include_usage: true };
          let cost;
          const observe = async value => {
            if (GENERATION_ID.test(value?.id || '')) {
              if (entry.generationId && entry.generationId !== value.id) { entry.generationConflict = true; ledger.blocked = true; await save(); throw new Error('Conflicting upstream generation IDs'); }
              if (!entry.generationId) { entry.generationId = value.id; await save(); }
            }
            if (value?.error) { entry.failureReason ||= 'upstream-error-response'; const code = value.error.code; if (Number.isSafeInteger(code) || typeof code === 'string' && /^[A-Z0-9_-]{1,64}$/.test(code)) entry.upstreamErrorCode = code; }
            if (value?.usage && Object.hasOwn(value.usage, 'cost')) { try { const next = money(value.usage.cost); cost = cost === undefined || next > cost ? next : cost; } catch { cost = undefined; } } };
          const forwardedBody = JSON.stringify(body);
          entry.requestDigest = createHash('sha256').update(forwardedBody, 'utf8').digest('hex');
          await save();
          forwarded = true;
          const response = await fetchImpl(`${upstreamUrl}/chat/completions`, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: forwardedBody, signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
          entry.upstreamStatus = response.status;
          // OpenRouter documents X-Generation-Id on every response, before body chunks.
          // https://openrouter.ai/docs/guides/features/response-caching#response-headers
          const headerGenerationId = response.headers.get('x-generation-id');
          if (GENERATION_ID.test(headerGenerationId || '')) {
            entry.headerGenerationId = headerGenerationId;
            await observe({ id: headerGenerationId });
          }
          if (!response.ok) entry.failureReason = `upstream-http-${response.status}`;
          const requestId = response.headers.get('x-request-id');
          if (requestId && /^[A-Za-z0-9_.:-]{1,256}$/.test(requestId)) entry.upstreamRequestId = requestId;
          await save();
          const streamingResponse = body.stream && response.headers.get('content-type')?.includes('text/event-stream');
          res.writeHead(response.status, { 'Content-Type': streamingResponse ? 'text/event-stream' : 'application/json', 'Cache-Control': 'no-store' });
          if (streamingResponse) {
            const decoder = new TextDecoder();
            let pending = '';
            const parse = async () => {
              let end;
              while ((end = pending.indexOf('\n\n')) >= 0) {
                const event = pending.slice(0, end); pending = pending.slice(end + 2);
                const data = event.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n');
                if (data && data !== '[DONE]') { let value; try { value = JSON.parse(data); } catch { continue; } await observe(value); }
              }
            };
            for await (const chunk of response.body) { pending = (pending + decoder.decode(chunk, { stream: true })).replace(/\r\n/g, '\n'); await parse(); if (!res.destroyed) res.write(chunk); }
            pending += decoder.decode(); await parse();
            if (pending.trim()) { pending += '\n\n'; await parse(); }
          } else {
            const bytes = Buffer.from(await response.arrayBuffer());
            let value; try { value = JSON.parse(bytes.toString('utf8')); } catch { /* Missing usage keeps reservation. */ }
            await observe(value);
            if (!res.destroyed) res.write(bytes);
          }
          entry.finishedAt = new Date().toISOString();
          if (cost !== undefined) {
            settleCost(ledger, entry, cost, 'usage.cost');
            await save();
          }
          if (entry.state === 'pending') {
            entry.failureReason ||= 'missing-authoritative-usage-cost';
            await save();
            await reconcileEntry(ledger, entry, { key, upstreamUrl, fetchImpl, timeoutMs: Math.min(timeoutMs, 15000) }, save);
          }
          res.end();
        } catch (error) {
          if (entry?.state === 'pending' && !fatal) {
            entry.finishedAt ||= new Date().toISOString();
            entry.failureReason ||= 'upstream-transport-or-parse-failure';
            await save().catch(() => {});
            if (!fatal) await reconcileEntry(ledger, entry, { key, upstreamUrl, fetchImpl, timeoutMs: Math.min(timeoutMs, 15000) }, save).catch(() => {});
          }
          if (!res.headersSent) { res.writeHead(error.status || 502, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: error.status ? error.message : 'Upstream or ledger failure; reservation retained' } })); }
          else res.destroy();
        } finally {
          // Keep an unresolved attempted POST from multiplying liabilities through SDK retries.
          // This hold is per instance; old pending reservations still count after explicit restart.
          if (forwarded && entry?.state === 'pending') uncertainRequestId ??= entry.id;
        }
      };
      // ponytail: one request at a time prevents concurrent overspend and bounds exposure.
      queue = queue.then(run, run);
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const snapshot = () => structuredClone({ ...ledger, spentUsd: Number(charged(ledger)) / 1e12, capUsd: Number(ledger.cap) / Number(UNIT) });
    return { url: `http://127.0.0.1:${server.address().port}/api/v1`, token, models: [...bounds.keys()],
      budgets: [...bounds.values()].map(b => ({ model: b.id, contextLength: b.contextLength, reservedOutputTokens: b.reservedOutputTokens, inputUsdPerMillion: Number(b.input) / 1e6, outputUsdPerMillion: Number(b.output) / 1e6, requestUsd: Number(b.request) / 1e12, reserveUsd: Number(b.reserve) / 1e12 })), snapshot, flush: () => queue,
      reconcilePending: () => { const run = async () => { if (fatal || stopped) throw new Error('Budget proxy unavailable'); const outcomes = []; for (const entry of ledger.requests.filter(r => r.state === 'pending')) outcomes.push(await reconcileEntry(ledger, entry, { key, upstreamUrl, fetchImpl, timeoutMs: Math.min(timeoutMs, 15000) }, save)); return outcomes; }; queue = queue.then(run, run); return queue; },
      stop: async () => { if (stopped) return; stopped = true; const closed = new Promise(resolve => server.close(resolve)); server.closeIdleConnections(); await queue.catch(() => {}); server.closeAllConnections(); await closed; lock.stdin.end(); await new Promise(resolve => lock.exitCode !== null ? resolve() : lock.once('exit', resolve)); } };
  } catch (error) { lock.stdin.end(); await new Promise(resolve => lock.exitCode !== null ? resolve() : lock.once('exit', resolve)); throw error; }
}
