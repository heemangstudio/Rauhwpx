import { licenseError, tokenEquals } from './licenses.mjs';
import { createOpenRouterClient, finite, isKeyLimitReached, readBounded, upstreamFailure, usd } from './openrouter.mjs';
import { createRateLimiter } from './rate-limit.mjs';
import { createMemoryStore } from './store.mjs';

/**
 * Gift credits for beta keys: one OpenRouter key per license (keyId) per event, created through the
 * provisioning API with `limit = amountUsd`. The key never leaves the server; the app calls
 * the OpenAI-compatible proxy under GIFT_PROXY_PREFIX with its license lease as the bearer.
 *
 * gifts.json = { events: { [eventId]: { grants: { [keyId]: grant }, allocations: { [keyId]: usd } } } }
 * grant.status: provisioning (key being created, or a crashed attempt to reconcile) | active | revoked.
 * allocations: the admin-set gift amount per license; licenses without one get `amountUsd`, and 0 means
 * no gift. grant.limitUsd is the limit on the OpenRouter key; pendingLimitUsd is a limit change on
 * its way to OpenRouter, counted against the budget until it lands.
 * Every write runs exclusively through `store.update`; OpenRouter calls happen between updates,
 * never inside one.
 */

export const GIFT_PROXY_PREFIX = '/v1/gift/openrouter';
export const MAX_GIFT_PROXY_BODY_BYTES = 16 * 1024 * 1024;
export const GIFT_CONCURRENCY_PER_LICENSE = 4;
export const GIFT_REQUESTS_PER_MINUTE = 60;
const MINUTE = 60 * 1000;
const BALANCE_CACHE_MS = 15 * 1000;
const CATALOG_CACHE_MS = 10 * MINUTE;
export const MAX_GIFT_AMOUNT_USD = 1000;
const INSUFFICIENT_CREDITS = 'Insufficient credits: the HamaEditor gift credit for this license is used up.';

export function emptyGiftsState() {
  return { events: {} };
}

function giftError(code, status) {
  return licenseError(code, status);
}

/** Admin-set gift amount: 0–MAX_GIFT_AMOUNT_USD dollars, number or numeric string, rounded to cents. */
export function parseGiftAmount(value) {
  const n = typeof value === 'string' && value.trim() ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > MAX_GIFT_AMOUNT_USD) throw giftError('amount_invalid', 400);
  return Math.round(n * 100) / 100;
}

function own(map, key) {
  return map && typeof map === 'object' && Object.hasOwn(map, key) ? map[key] : undefined;
}

function bearer(req) {
  const match = String(req.headers.authorization ?? '').match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() ?? '';
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

export function createGiftsService({
  store = createMemoryStore(emptyGiftsState()),
  authenticate,
  config = {},
  adminToken = '',
  fetchImpl = globalThis.fetch,
  now = Date.now,
  log = (line) => process.stderr.write(`${line}\n`),
} = {}) {
  const {
    provisioningKey = '',
    eventId = '',
    amountUsd = 20,
    endsAt,
    totalBudgetUsd,
    modelPrefixes = ['anthropic/'],
    platforms = ['darwin', 'win32'],
    maxOutputTokens = 32000,
    apiBase = 'https://openrouter.ai/api/v1',
  } = config;
  const configured = Boolean(provisioningKey && eventId);
  const openrouter = createOpenRouterClient({ apiBase, provisioningKey, fetchImpl });

  function normalize(state) {
    const next = state && typeof state === 'object' && !Array.isArray(state) ? state : {};
    if (!next.events || typeof next.events !== 'object' || Array.isArray(next.events)) next.events = {};
    return next;
  }
  function eventState(state) {
    const ev = state.events[eventId] ?? { grants: {} };
    if (!ev.grants || typeof ev.grants !== 'object') ev.grants = {};
    if (!ev.allocations || typeof ev.allocations !== 'object' || Array.isArray(ev.allocations)) ev.allocations = {};
    state.events[eventId] = ev;
    return ev;
  }
  /** The license's gift: the limit of its claimed key, else its allocation, else the event default. */
  function amountOf(ev, keyId) {
    const grant = own(ev?.grants, keyId);
    if (grant?.status === 'active' || grant?.status === 'revoked') return finite(grant.limitUsd) ?? amountUsd;
    return finite(own(ev?.allocations, keyId)) ?? amountUsd;
  }
  const committedOf = (grant) => Math.max(finite(grant.limitUsd) ?? 0, finite(grant.pendingLimitUsd) ?? 0);
  function committedExcept(ev, keyId) {
    return Object.values(ev?.grants ?? {}).filter((g) => g.keyId !== keyId).reduce((sum, g) => sum + committedOf(g), 0);
  }
  /** `fn` runs alone on the store and returns `{ value, dirty }`; the state is saved unless `dirty` is false. */
  async function mutate(fn) {
    const result = await store.update((state) => fn(normalize(state)));
    return result?.value ?? result;
  }
  async function read() {
    return normalize(await store.read());
  }
  async function currentGrant(keyId) {
    return own((await read()).events[eventId]?.grants, keyId);
  }

  function eventActive() {
    return configured && (endsAt === undefined || now() < endsAt);
  }
  function eventInfo() {
    return {
      id: eventId || null,
      amountUsd,
      endsAt: endsAt === undefined ? null : new Date(endsAt).toISOString(),
      active: eventActive(),
    };
  }

  /**
   * Lease → license principal. Eligible = an active beta key on an allowed platform (macOS and
   * Windows by default). Checked on every status, claim and proxy call, so a key that stops qualifying
   * loses an already claimed gift too.
   */
  async function principal(lease) {
    if (typeof authenticate !== 'function') throw giftError('unauthorized', 401);
    const who = await authenticate(lease);
    return { ...who, eligible: who.tier === 'beta' && platforms.includes(who.platform) };
  }

  // ------------------------------------------------------------ OpenRouter

  const balances = new Map();
  /**
   * GET /key with the gift key → {limit, usage, remaining}. `usage` there is OpenRouter credit spend
   * only (BYOK fees) and `byok_usage` the spend on the owner's provider key; the limit counts both.
   * Cached briefly per license.
   */
  async function balance(grant, { fresh = false } = {}) {
    const cached = balances.get(grant.keyId);
    if (!fresh && cached && now() - cached.at < BALANCE_CACHE_MS) return cached.value;
    const data = await openrouter.keyInfo(grant.openrouterKey);
    const limit = finite(data.limit) ?? grant.limitUsd;
    const credit = finite(data.usage);
    if (credit === null) throw upstreamFailure('upstream_key_failed');
    const spent = credit + (finite(data.byok_usage) ?? 0);
    const reported = finite(data.limit_remaining);
    const remaining = usd(Math.max(0, reported ?? limit - spent));
    const value = { limit, usage: usd(Math.min(limit, reported === null ? spent : limit - remaining)), remaining };
    balances.set(grant.keyId, { at: now(), value });
    return value;
  }

  // --------------------------------------------------------- status/claim

  async function status(lease) {
    const who = await principal(lease);
    const ev = configured ? (await read()).events[eventId] : undefined;
    const grant = own(ev?.grants, who.keyId);
    const amount = amountOf(ev, who.keyId);
    const claimed = grant?.status === 'active' || grant?.status === 'revoked';
    let remainingUsd = null;
    let usedUsd = null;
    if (grant?.status === 'revoked') remainingUsd = 0;
    else if (grant?.status === 'active') {
      const b = await balance(grant).catch(() => null);
      if (b) { remainingUsd = b.remaining; usedUsd = b.usage; }
    }
    return {
      ok: true,
      event: { ...eventInfo(), amountUsd: amount },
      // An allocation of 0 keeps a license from claiming; a claimed gift set to 0 just reads as used up.
      eligible: who.eligible && (claimed || amount > 0),
      claimed,
      remainingUsd,
      usedUsd,
      claimedAt: claimed ? grant.claimedAt ?? null : null,
    };
  }

  async function claimedResult(grant, created) {
    let remainingUsd = 0;
    if (grant.status === 'active') {
      remainingUsd = created ? grant.limitUsd : ((await balance(grant).catch(() => null))?.remaining ?? null);
    }
    return { ok: true, claimed: true, created, remainingUsd, claimedAt: grant.claimedAt };
  }

  const claiming = new Map();
  /**
   * 한 라이선스의 한도 변경은 OpenRouter 응답과 저장까지 하나씩 끝낸다. 겹치면 늦게 온 이전 응답이
   * 새 한도를 덮어써, 기록된 약정액이 실제 키 한도보다 작아지고 예산을 넘는 지급이 허용된다.
   */
  const limitChanges = new Map();
  function serializeLimitChange(keyId, change) {
    const previous = limitChanges.get(keyId);
    const run = (previous ? previous.catch(() => {}) : Promise.resolve()).then(change);
    limitChanges.set(keyId, run);
    const clear = () => { if (limitChanges.get(keyId) === run) limitChanges.delete(keyId); };
    run.then(clear, clear);
    return run;
  }

  async function claim(lease) {
    const who = await principal(lease);
    if (!configured) throw giftError('event_inactive', 410);
    if (!who.eligible) throw giftError('not_eligible', 403);
    // Parallel claims from the license's devices share one attempt.
    if (claiming.has(who.keyId)) return claiming.get(who.keyId);
    const attempt = provision(who).finally(() => claiming.delete(who.keyId));
    claiming.set(who.keyId, attempt);
    return attempt;
  }

  async function provision(who) {
    const name = `hama-gift-${eventId}-${who.keyId}`;
    const reserved = await mutate((state) => {
      const ev = eventState(state);
      const existing = own(ev.grants, who.keyId);
      if (existing && existing.status !== 'provisioning') return { dirty: false, value: { existing } };
      if (!eventActive()) throw giftError('event_inactive', 410);
      const limit = finite(own(ev.allocations, who.keyId)) ?? amountUsd;
      if (!(limit > 0)) throw giftError('not_eligible', 403);
      if (totalBudgetUsd !== undefined && usd(committedExcept(ev, who.keyId) + limit) > usd(totalBudgetUsd)) {
        throw giftError('budget_exhausted', 409);
      }
      ev.grants[who.keyId] = {
        keyId: who.keyId,
        status: 'provisioning',
        name,
        limitUsd: limit,
        source: who.source,
        deviceId: who.deviceId,
        startedAt: new Date(now()).toISOString(),
      };
      return { value: { stale: existing?.status === 'provisioning', limit } };
    });
    if (reserved.existing) return claimedResult(reserved.existing, false);

    let created;
    try {
      // A provisioning record without a live attempt is a crash between create and save.
      if (reserved.stale) await openrouter.removeOrphans(name);
      created = await openrouter.createKey(name, reserved.limit);
    } catch (error) {
      log(`[site-api] gift key for ${who.keyId} not created: ${error?.code ?? 'error'}${error?.status ? ` (${error.status})` : ''}`);
      if (error?.definite) {
        await mutate((state) => {
          const ev = eventState(state);
          if (ev.grants[who.keyId]?.status !== 'provisioning') return { dirty: false };
          delete ev.grants[who.keyId];
          return {};
        }).catch(() => {});
      }
      throw giftError('upstream_unavailable', 502);
    }
    const grant = await mutate((state) => {
      const g = eventState(state).grants[who.keyId];
      Object.assign(g, {
        status: 'active',
        openrouterHash: created.hash,
        openrouterKey: created.key,
        claimedAt: new Date(now()).toISOString(),
      });
      return { value: { ...g } };
    });
    log(`[site-api] gift claimed by ${who.keyId}`);
    return claimedResult(grant, true);
  }

  // ----------------------------------------------------------------- proxy

  const perLicense = createRateLimiter({ now });
  const inFlight = new Map();
  let catalog = null;

  async function filteredCatalog() {
    if (catalog && now() - catalog.at < CATALOG_CACHE_MS) return catalog.value;
    const { ok, body } = await openrouter.json('/models').catch(() => ({}));
    if (!ok || !Array.isArray(body?.data)) {
      if (catalog) return catalog.value; // a stale list beats a failure
      throw upstreamFailure('upstream_models_failed');
    }
    const value = { data: body.data.filter((m) => typeof m?.id === 'string' && modelAllowed(m.id)) };
    catalog = { at: now(), value };
    return value;
  }

  function modelAllowed(model) {
    return typeof model === 'string' && modelPrefixes.some((prefix) => model.startsWith(prefix));
  }

  /** Clamp output tokens so one request cannot spend the whole gift. */
  function capTokens(payload) {
    let capped = false;
    for (const field of ['max_tokens', 'max_completion_tokens']) {
      if (payload[field] === undefined || payload[field] === null) continue;
      const value = Number(payload[field]);
      payload[field] = Number.isFinite(value) && value > 0 ? Math.min(Math.floor(value), maxOutputTokens) : maxOutputTokens;
      capped = true;
    }
    if (!capped) payload.max_tokens = maxOutputTokens;
  }

  /** Handles every request under GIFT_PROXY_PREFIX. Errors use OpenRouter's {error:{code,message}} shape. */
  async function handleProxy(req, res, subpath) {
    const sendJson = (statusCode, body, headers = {}) => {
      if (res.headersSent) { res.destroy(); return; }
      res.writeHead(statusCode, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        ...headers,
      });
      res.end(JSON.stringify(body));
    };
    const fail = (code, message, headers) => {
      req.resume?.();
      sendJson(code, { error: { code, message } }, headers);
    };
    const route = `${req.method} ${subpath}`;
    const routes = new Set(['GET /models', 'GET /auth/key', 'GET /key', 'GET /credits', 'POST /chat/completions']);
    if (!routes.has(route)) return fail(404, 'not_found');

    let who;
    try {
      who = await principal(bearer(req));
    } catch (error) {
      if (error?.licenseError) return fail(401, 'unauthorized');
      log(`[site-api] gift auth failed: ${error?.message ?? error}`);
      return fail(503, 'service_unavailable');
    }
    if (!configured) return fail(410, 'event_inactive');
    if (!who.eligible) return fail(403, 'not_eligible');
    const grant = await currentGrant(who.keyId);
    if (!grant || grant.status === 'provisioning') return fail(403, 'gift_not_claimed');
    // A gift set to $0 never reaches OpenRouter: its key is only ever used through this proxy.
    const revoked = grant.status !== 'active' || !(finite(grant.limitUsd) > 0);

    if (req.method === 'GET') {
      req.resume?.();
      if (route === 'GET /models') {
        try {
          return sendJson(200, await filteredCatalog());
        } catch {
          return fail(502, 'upstream_unavailable');
        }
      }
      let b;
      if (revoked) b = { limit: grant.limitUsd, usage: grant.limitUsd, remaining: 0 };
      else {
        try { b = await balance(grant); } catch { return fail(502, 'upstream_unavailable'); }
      }
      if (route === 'GET /credits') return sendJson(200, { data: { total_credits: b.limit, total_usage: b.usage } });
      return sendJson(200, {
        data: { label: 'HamaEditor gift', limit: b.limit, usage: b.usage, limit_remaining: b.remaining, limit_reset: null, is_free_tier: false },
      });
    }

    // POST /chat/completions
    if (revoked) return fail(402, INSUFFICIENT_CREDITS);
    if (!perLicense.check(who.keyId, GIFT_REQUESTS_PER_MINUTE, MINUTE)) {
      return fail(429, 'Rate limit exceeded for the gift credit. Retry in a minute.', { 'Retry-After': '60' });
    }
    if ((inFlight.get(who.keyId) ?? 0) >= GIFT_CONCURRENCY_PER_LICENSE) {
      return fail(429, 'Too many concurrent requests on the gift credit.', { 'Retry-After': '5' });
    }
    inFlight.set(who.keyId, (inFlight.get(who.keyId) ?? 0) + 1);
    try {
      await forwardChat(req, res, grant, { fail, sendJson });
    } finally {
      const left = (inFlight.get(who.keyId) ?? 1) - 1;
      if (left > 0) inFlight.set(who.keyId, left);
      else inFlight.delete(who.keyId);
      balances.delete(who.keyId);
    }
  }

  async function forwardChat(req, res, grant, { fail, sendJson }) {
    const raw = await readBounded(req, MAX_GIFT_PROXY_BODY_BYTES).catch(() => undefined);
    if (raw === undefined) return; // client went away while uploading
    if (raw === null) return fail(413, 'Request body too large.');
    let payload;
    try { payload = JSON.parse(raw.toString('utf8')); } catch { payload = null; }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return fail(400, 'Request body is not a JSON object.');
    const requested = [payload.model, ...(Array.isArray(payload.models) ? payload.models : [])];
    if (payload.models !== undefined && !Array.isArray(payload.models)) return fail(400, 'models must be an array.');
    const rejected = requested.findIndex((model) => !modelAllowed(model));
    if (rejected !== -1) {
      const model = String(requested[rejected] ?? '(none)').slice(0, 100);
      return fail(400, `Model not available with the gift credit: ${model}. Allowed: ${modelPrefixes.join(', ')}*`);
    }
    capTokens(payload);

    const abort = new AbortController();
    const onClose = () => { if (!res.writableFinished) abort.abort(); };
    res.once('close', onClose);
    let upstream;
    try {
      upstream = await fetchImpl(`${apiBase}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${grant.openrouterKey}`,
          'Content-Type': 'application/json',
          Accept: req.headers.accept || 'application/json',
          'HTTP-Referer': 'https://heemangstudios.com/',
          'X-Title': 'HamaEditor',
        },
        body: JSON.stringify(payload),
        signal: abort.signal,
      });
    } catch {
      if (abort.signal.aborted) return;
      return fail(502, 'Upstream unavailable.');
    }

    if (upstream.status === 402 || upstream.status === 403) {
      const errorRaw = upstream.body ? await readBounded(upstream.body, 64 * 1024).catch(() => null) : null;
      let errorBody = null;
      try { errorBody = errorRaw ? JSON.parse(errorRaw.toString('utf8')) : null; } catch { errorBody = null; }
      if (isKeyLimitReached(upstream.status, errorBody)) return fail(402, INSUFFICIENT_CREDITS);
      const retryAfter = upstream.headers.get('retry-after');
      return sendJson(upstream.status, errorBody ?? { error: { code: upstream.status, message: 'Upstream refused the request.' } },
        retryAfter ? { 'Retry-After': retryAfter } : {});
    }

    const headers = {
      'Content-Type': upstream.headers.get('content-type') || 'application/json',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'X-Accel-Buffering': 'no',
    };
    for (const name of ['retry-after', 'x-generation-id']) {
      const value = upstream.headers.get(name);
      if (value) headers[name] = value;
    }
    res.writeHead(upstream.status, headers);
    res.flushHeaders();
    if (!upstream.body) { res.end(); return; }
    const reader = upstream.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
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
      res.off('close', onClose);
    }
  }

  // ----------------------------------------------------------------- admin

  function requireAdmin(token) {
    if (!tokenEquals(token, adminToken)) throw giftError('forbidden', 403);
  }
  function grantView(grant) {
    const { openrouterKey: _secret, ...rest } = grant;
    return rest;
  }
  /** Dashboard view of one license's gift. `live` is the cached OpenRouter balance of an active key. */
  function licenseGift(ev, keyId, live = null) {
    const grant = own(ev?.grants, keyId);
    const status = grant?.status ?? 'unclaimed';
    return {
      amountUsd: amountOf(ev, keyId),
      status,
      limitUsd: grant ? finite(grant.limitUsd) : null,
      usedUsd: status === 'active' ? live?.usage ?? null : null,
      remainingUsd: status === 'revoked' ? 0 : status === 'active' ? live?.remaining ?? null : null,
      claimedAt: grant?.claimedAt ?? null,
    };
  }

  const admin = {
    async list(token, { eventId: wanted, status: wantedStatus } = {}) {
      requireAdmin(token);
      const id = wanted || eventId;
      const ev = (await read()).events[id];
      const grants = Object.values(ev?.grants ?? {});
      const committedUsd = usd(grants.reduce((sum, g) => sum + committedOf(g), 0));
      const list = grants
        .filter((g) => !wantedStatus || g.status === wantedStatus)
        .sort((a, b) => String(b.claimedAt ?? b.startedAt).localeCompare(String(a.claimedAt ?? a.startedAt)))
        .map(grantView);
      return {
        ok: true,
        eventId: id || null,
        defaultAmountUsd: amountUsd,
        committedUsd,
        budgetUsd: totalBudgetUsd ?? null,
        count: list.length,
        grants: list,
        allocations: { ...(ev?.allocations ?? {}) },
      };
    },
    /** Adds `gift` (null while no event is configured) to each beta from licenses.admin.betas, and `giftEvent`. */
    async withGifts(token, result) {
      requireAdmin(token);
      if (!configured) return { ...result, giftEvent: null, betas: result.betas.map((b) => ({ ...b, gift: null })) };
      const ev = (await read()).events[eventId];
      const betas = await Promise.all(result.betas.map(async (b) => {
        const grant = own(ev?.grants, b.keyId);
        const live = grant?.status === 'active' ? await balance(grant).catch(() => null) : null;
        return { ...b, gift: licenseGift(ev, b.keyId, live) };
      }));
      const committedUsd = usd(Object.values(ev?.grants ?? {}).reduce((sum, g) => sum + committedOf(g), 0));
      return { ...result, giftEvent: { ...eventInfo(), committedUsd, budgetUsd: totalBudgetUsd ?? null }, betas };
    },
    /**
     * Sets one license's gift amount for the current event. Unclaimed: stored for its claim. Active: the
     * OpenRouter key's limit is PATCHed first (lowering below what is spent is allowed), and raising it
     * must fit the budget. Revoked: stored only.
     */
    async setAmount(token, body) {
      requireAdmin(token);
      if (!configured) throw giftError('event_inactive', 410);
      const keyId = typeof body?.keyId === 'string' ? body.keyId.trim() : '';
      if (!keyId) throw giftError('key_id_required', 400);
      const amount = parseGiftAmount(body?.amountUsd);
      return serializeLimitChange(keyId, async () => {
        const plan = await mutate((state) => {
          const ev = eventState(state);
          const grant = own(ev.grants, keyId);
          if (grant?.status === 'provisioning' && claiming.has(keyId)) throw giftError('gift_provisioning', 409);
          if (grant?.status !== 'active' || (grant.limitUsd === amount && grant.pendingLimitUsd === undefined)) {
            ev.allocations[keyId] = amount;
            return { value: { gift: licenseGift(ev, keyId) } };
          }
          const raising = amount > (finite(grant.limitUsd) ?? 0);
          if (raising && totalBudgetUsd !== undefined && usd(committedExcept(ev, keyId) + amount) > usd(totalBudgetUsd)) {
            throw giftError('budget_exhausted', 409);
          }
          grant.pendingLimitUsd = amount;
          return { value: { hash: grant.openrouterHash } };
        });
        if (plan.gift) {
          log(`[site-api] gift amount for ${keyId} set to $${amount}`);
          return { ok: true, gift: plan.gift };
        }

        const { ok, status: code } = await openrouter.patchKey(plan.hash, { limit: amount });
        if (!ok) {
          log(`[site-api] gift limit for ${keyId} not changed: ${code ?? 'network'}`);
          // A refusal frees the reservation. After a network failure the new limit may be live, so it stays counted.
          if (code >= 400 && code < 500) {
            await mutate((state) => {
              const g = own(state.events[eventId]?.grants, keyId);
              if (g?.pendingLimitUsd !== amount) return { dirty: false };
              delete g.pendingLimitUsd;
              return {};
            }).catch(() => {});
          }
          throw giftError('upstream_unavailable', 502);
        }
        const gift = await mutate((state) => {
          const ev = eventState(state);
          const g = own(ev.grants, keyId);
          ev.allocations[keyId] = amount;
          if (g) {
            g.limitUsd = amount;
            g.limitChangedAt = new Date(now()).toISOString();
            if (g.pendingLimitUsd === amount) delete g.pendingLimitUsd;
          }
          return { value: licenseGift(ev, keyId) };
        });
        balances.delete(keyId);
        log(`[site-api] gift limit for ${keyId} changed to $${amount}`);
        return { ok: true, gift };
      });
    },
    /** PATCH the OpenRouter key to disabled, then mark the grant revoked. */
    async disable(token, body) {
      requireAdmin(token);
      const keyId = typeof body?.keyId === 'string' ? body.keyId.trim() : '';
      const id = (typeof body?.eventId === 'string' && body.eventId.trim()) || eventId;
      const grants = (await read()).events[id]?.grants ?? {};
      const grant = Object.hasOwn(grants, keyId) ? grants[keyId] : undefined;
      if (!grant) throw giftError('gift_not_found', 404);
      if (grant.status === 'revoked') return { ok: true, changed: false, gift: grantView(grant) };
      if (grant.status === 'provisioning') throw giftError('gift_provisioning', 409);
      if (grant.openrouterHash) {
        const { ok, status: code } = await openrouter.patchKey(grant.openrouterHash, { disabled: true });
        if (!ok && code !== 404) throw giftError('upstream_unavailable', 502);
      }
      const reason = typeof body?.reason === 'string' && body.reason.trim() ? body.reason.trim().slice(0, 200) : 'manual';
      const updated = await mutate((state) => {
        const g = state.events[id]?.grants?.[keyId];
        if (!g) throw giftError('gift_not_found', 404);
        Object.assign(g, { status: 'revoked', revokedAt: new Date(now()).toISOString(), revokeReason: `admin:${reason}` });
        return { value: { ...g } };
      });
      balances.delete(keyId);
      log(`[site-api] gift for ${keyId} disabled`);
      return { ok: true, changed: true, gift: grantView(updated) };
    },
  };

  return { configured, status, claim, handleProxy, admin, eventInfo };
}
