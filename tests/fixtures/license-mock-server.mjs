// In-memory test double of the HamaEditor key server (docs/license-api.md) and the gift-credit
// routes (/v1/gift/*). The desktop tests use .fetch; `node tests/fixtures/license-mock-server.mjs
// [--port N]` (or MOCK_PORT) serves it on http://127.0.0.1:8787 for manual runs
// (HAMA_LICENSE_API_BASE + HAMA_LICENSE_DEV_PUBLIC_KEY). The CLI streams real SSE for
// `stream:true` chat completions and adds admin routes under /__mock/. It prints a lifetime key, a beta key
// and an annual key; `POST /__mock/license/expiry {key, licenseExpiresAt, autoRenew, paymentGraceEndsAt}` renews, cancels,
// fails the payment of (grace end) or ends one.
import { generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { normalizeLicenseKey, licenseKeyHash, verifyLease } from '../../desktop/license-lease.mjs';

// 테스트마다 메모리에서 생성한다. 개인키는 저장하거나 커밋하지 않는다.
const pair = generateKeyPairSync('ed25519');
export const DEV_KEYPAIR = {
  kid: 'hama-prod-1',
  publicKeyBase64: Buffer.from(pair.publicKey.export({ format: 'jwk' }).x, 'base64url').toString('base64'),
  privateKey: pair.privateKey,
};
export const DEV_PUBLIC_KEYS = Object.freeze({ [DEV_KEYPAIR.kid]: DEV_KEYPAIR.publicKeyBase64 });
const LEASE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const PAYMENT_FIX_URL = 'https://groble.im/manage/purchase';
const BETA_LEASE_TTL_MS = 3 * 24 * 60 * 60 * 1000;
/** The server's default for beta keys (`issue-beta` without `devices`). */
const BETA_DEVICE_LIMIT = 5;
export function signLease(payload, keypair = DEV_KEYPAIR) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  return `${body.toString('base64url')}.${sign(null, Buffer.from(body.toString('base64url'), 'ascii'), keypair.privateKey).toString('base64url')}`;
}

export const GIFT_PROXY_PREFIX = '/v1/gift/openrouter';
const GIFT_REPLY = ['모의 선물 크레딧', ' 응답입니다.', ' 요청을 잘', ' 받았습니다.'];

/** OpenRouter 카탈로그 모양의 고정 목록. anthropic/ 이 아닌 항목은 목록에서 걸러진다. */
export const GIFT_FIXTURE_MODELS = Object.freeze([
  fixtureModel('anthropic/claude-sonnet-5.5', 'Anthropic: Claude Sonnet 5.5', 1_789_000_000, 1_000_000, 64_000, '0.000003', '0.000015'),
  fixtureModel('anthropic/claude-haiku-5.5', 'Anthropic: Claude Haiku 5.5', 1_789_100_000, 200_000, 64_000, '0.000001', '0.000005'),
  fixtureModel('anthropic/claude-opus-5.5', 'Anthropic: Claude Opus 5.5', 1_789_200_000, 1_000_000, 128_000, '0.000005', '0.000025'),
  fixtureModel('anthropic/claude-sonnet-5', 'Anthropic: Claude Sonnet 5', 1_775_000_000, 1_000_000, 64_000, '0.000003', '0.000015'),
  fixtureModel('openai/gpt-5', 'OpenAI: GPT-5', 1_754_587_413, 400_000, 128_000, '0.00000125', '0.00001'),
]);

function fixtureModel(id, name, created, contextLength, maxCompletion, prompt, completion) {
  return {
    id,
    canonical_slug: id,
    name,
    created,
    context_length: contextLength,
    architecture: { modality: 'text+image->text', input_modalities: ['text', 'image'], output_modalities: ['text'], tokenizer: 'Claude' },
    pricing: { prompt, completion, request: '0', image: '0', input_cache_read: '0', input_cache_write: '0' },
    top_provider: { context_length: contextLength, max_completion_tokens: maxCompletion, is_moderated: false },
    supported_parameters: ['include_reasoning', 'max_tokens', 'reasoning', 'stop', 'temperature', 'tool_choice', 'tools', 'top_p'],
  };
}

function headerValue(headers, name) {
  if (!headers) return '';
  if (typeof headers.get === 'function') return headers.get(name) ?? '';
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return Array.isArray(value) ? String(value[0] ?? '') : String(value ?? '');
  }
  return '';
}

const roundUsd = (value) => Math.round(value * 1e6) / 1e6;

export function createMockLicenseServer({
  keypair = DEV_KEYPAIR,
  now = Date.now,
  deviceLimit = 2,
  eligibleInstallId = null,
  gift: giftOptions = {},
  log = null,
} = {}) {
  const licenses = new Map();
  const calls = [];
  let offline = false;
  const giftConfig = {
    eventId: 'special-2026-10',
    amountUsd: 20,
    endsAt: null,
    active: true,
    platforms: ['darwin', 'win32'],
    totalBudgetUsd: Infinity,
    costPerRequestUsd: 0.05,
    modelPrefixes: ['anthropic/'],
    models: GIFT_FIXTURE_MODELS,
    ...giftOptions,
  };
  /** license id → { claimed, claimedAt, usageUsd } */
  const gifts = new Map();
  let giftCreatedUsd = 0;

  /**
   * licenseExpiresAt (epoch ms) makes an annual subscription key; without it the key is lifetime, like beta keys.
   * plan answers like the plan server (edition 'hama' | 'rau', plan, rau.eligible true only for Rau); without it the
   * answer matches the older server.
   */
  function issueKey({ tier = 'paid', licenseExpiresAt = null, autoRenew = true, devices = tier === 'beta' ? BETA_DEVICE_LIMIT : deviceLimit, plan = null, edition = 'hama', rauEligible = edition === 'rau' } = {}) {
    const raw = Array.from(randomBytes(25), n => '0123456789ABCDEFGHJKMNPQRSTVWXYZ'[n & 31]).join('');
    const key = `HAMA-${raw.slice(0, 5)}-${raw.slice(5, 10)}-${raw.slice(10, 15)}-${raw.slice(15, 20)}-${raw.slice(20, 25)}`;
    licenses.set(key, { id: `lic_${licenses.size + 1}`, key, tier, devices: new Set(), platforms: new Map(), revoked: false, licenseExpiresAt, autoRenew, paymentGraceEndsAt: null, deviceLimit: devices, plan, edition, rauEligible });
    return key;
  }

  const ttl = (license) => (license.tier === 'beta' ? BETA_LEASE_TTL_MS : LEASE_TTL_MS);

  function lease(key, deviceId) {
    const issuedAt = now();
    const license = licenses.get(key);
    return signLease({
      v: 1, kid: keypair.kid, keyId: license.id, keyHash: licenseKeyHash(key), deviceId, issuedAt, expiresAt: issuedAt + ttl(license),
      ...(license.licenseExpiresAt !== null ? { licenseExpiresAt: license.licenseExpiresAt } : {}),
      ...(license.paymentGraceEndsAt !== null ? { paymentGraceEndsAt: license.paymentGraceEndsAt } : {}),
    }, keypair);
  }

  function leaseBody(key, deviceId, license) {
    return {
      ok: true, lease: lease(key, deviceId), keyId: license.id, tier: license.tier, expiresAt: now() + ttl(license),
      licenseExpiresAt: license.licenseExpiresAt, autoRenew: license.licenseExpiresAt === null ? null : license.autoRenew,
      licenseState: license.paymentGraceEndsAt === null ? 'active' : 'payment_failed', paymentGraceEndsAt: license.paymentGraceEndsAt,
      ...(license.licenseExpiresAt === null ? {} : { paymentFixUrl: PAYMENT_FIX_URL }),
      devicesUsed: license.devices.size, deviceLimit: license.deviceLimit,
      ...(license.plan ? { edition: license.edition, plan: license.plan, rau: { eligible: license.rauEligible } } : {}),
    };
  }

  function licenseByRef(ref) {
    if (licenses.has(ref)) return licenses.get(ref);
    for (const license of licenses.values()) if (license.id === ref) return license;
    return null;
  }

  function giftRecord(licenseId) {
    let record = gifts.get(licenseId);
    if (!record) {
      record = { claimed: false, claimedAt: null, usageUsd: 0 };
      gifts.set(licenseId, record);
    }
    return record;
  }

  /** Bearer lease 를 서버처럼 확인한다: 서명, 만료, 해지, 활성화된 기기, keyHash. */
  function authenticate(headers) {
    const match = /^Bearer\s+(\S+)$/i.exec(headerValue(headers, 'authorization').trim());
    if (!match) return null;
    const result = verifyLease(match[1], { publicKeys: { [keypair.kid]: keypair.publicKeyBase64 }, now: now() });
    if (!result.ok) return null;
    const license = licenseByRef(result.payload.keyId);
    if (!license || license.revoked || !license.devices.has(result.payload.deviceId)) return null;
    if (licenseKeyHash(license.key) !== result.payload.keyHash) return null;
    return { license, deviceId: result.payload.deviceId, platform: license.platforms.get(result.payload.deviceId) ?? null };
  }

  function giftEvent() {
    return { id: giftConfig.eventId, amountUsd: giftConfig.amountUsd, endsAt: giftConfig.endsAt, active: giftConfig.active };
  }

  function remainingUsd(record) {
    return roundUsd(Math.max(0, giftConfig.amountUsd - record.usageUsd));
  }

  /** 서버처럼 베타 키만, 허용한 플랫폼에서만 받을 수 있다. */
  function giftEligible(auth) {
    return auth.license.tier === 'beta' && giftConfig.platforms.includes(auth.platform);
  }

  function giftStatusBody(auth) {
    const record = giftRecord(auth.license.id);
    const eligible = giftEligible(auth);
    return {
      ok: true,
      event: giftEvent(),
      eligible,
      claimed: record.claimed,
      remainingUsd: record.claimed ? remainingUsd(record) : null,
      usedUsd: record.claimed ? roundUsd(record.usageUsd) : null,
      claimedAt: record.claimedAt,
    };
  }

  function claimGift(auth) {
    if (!giftConfig.active) return [410, { ok: false, error: 'event_inactive' }];
    if (!giftEligible(auth)) return [403, { ok: false, error: 'not_eligible' }];
    const record = giftRecord(auth.license.id);
    let created = false;
    if (!record.claimed) {
      if (giftCreatedUsd + giftConfig.amountUsd > giftConfig.totalBudgetUsd) return [409, { ok: false, error: 'budget_exhausted' }];
      giftCreatedUsd += giftConfig.amountUsd;
      record.claimed = true;
      record.claimedAt = new Date(now()).toISOString();
      created = true;
    }
    return [200, { ok: true, claimed: true, created, remainingUsd: remainingUsd(record), claimedAt: record.claimedAt }];
  }

  const proxyError = (status, message) => [status, { error: { code: status, message } }];
  const allowedModel = (id) => typeof id === 'string' && giftConfig.modelPrefixes.some((prefix) => id.startsWith(prefix));

  function chatCompletion(record, body) {
    const model = body.model;
    const id = `gen-mock-${randomUUID()}`;
    const created = Math.floor(now() / 1000);
    record.usageUsd = roundUsd(record.usageUsd + giftConfig.costPerRequestUsd);
    const content = GIFT_REPLY.join('');
    const usage = { prompt_tokens: 42, completion_tokens: 12, total_tokens: 54, cost: giftConfig.costPerRequestUsd };
    if (body.stream !== true) {
      return [200, {
        id, object: 'chat.completion', created, model, provider: 'Anthropic',
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop', native_finish_reason: 'end_turn' }],
        usage,
      }];
    }
    const chunk = (delta, finishReason = null, extra = {}) => ({
      id, object: 'chat.completion.chunk', created, model, provider: 'Anthropic',
      choices: [{ index: 0, delta, finish_reason: finishReason }],
      ...extra,
    });
    const events = [chunk({ role: 'assistant', content: '' })];
    for (const piece of GIFT_REPLY) events.push(chunk({ content: piece }));
    events.push(chunk({}, 'stop', { usage }));
    return [200, null, { sse: [...events.map((event) => JSON.stringify(event)), '[DONE]'] }];
  }

  function handleProxy(route, method, body, auth) {
    if (!auth) return proxyError(401, 'unauthorized');
    if (!giftEligible(auth)) return proxyError(403, 'not_eligible');
    if (!giftConfig.active) return proxyError(410, 'event_inactive');
    const record = giftRecord(auth.license.id);
    if (!record.claimed) return proxyError(403, 'gift_not_claimed');
    if (method === 'GET' && route === '/models') {
      return [200, { data: giftConfig.models.filter((model) => allowedModel(model.id)) }];
    }
    if (method === 'GET' && (route === '/auth/key' || route === '/key')) {
      return [200, { data: {
        label: `gift ${giftConfig.eventId}`,
        limit: giftConfig.amountUsd,
        usage: roundUsd(record.usageUsd),
        limit_remaining: remainingUsd(record),
        is_free_tier: false,
      } }];
    }
    if (method === 'GET' && route === '/credits') {
      return [200, { data: { total_credits: giftConfig.amountUsd, total_usage: roundUsd(record.usageUsd) } }];
    }
    if (method === 'POST' && route === '/chat/completions') {
      if (!body || typeof body !== 'object' || !Array.isArray(body.messages)) return proxyError(400, 'invalid_request');
      if (!allowedModel(body.model)) return proxyError(400, `Model not allowed for this gift: ${String(body.model)}`);
      if (remainingUsd(record) <= 0) return proxyError(402, 'Insufficient credits. This gift has no remaining balance.');
      return chatCompletion(record, body);
    }
    return proxyError(404, 'not_found');
  }

  function handleGift(path, body, method, headers) {
    const auth = authenticate(headers);
    if (path.startsWith(`${GIFT_PROXY_PREFIX}/`)) return handleProxy(path.slice(GIFT_PROXY_PREFIX.length), method, body, auth);
    if (path === '/v1/gift/status' && method !== 'POST') {
      return auth ? [200, giftStatusBody(auth)] : [401, { ok: false, error: 'unauthorized' }];
    }
    if (path === '/v1/gift/claim' && method !== 'GET') {
      return auth ? claimGift(auth) : [401, { ok: false, error: 'unauthorized' }];
    }
    return [404, { ok: false, error: 'not_found' }];
  }

  let grandfatherKey;
  /** 반환값: [status, body] 또는 SSE 일 때 [status, null, { sse: string[] }]. 예전 2인자 호출도 받는다. */
  function handle(path, body, { method, headers = {} } = {}) {
    calls.push({ path, body });
    if (path.startsWith('/v1/gift/')) {
      const result = handleGift(path, body, method ? String(method).toUpperCase() : undefined, headers);
      if (log) {
        const model = typeof body?.model === 'string' ? ` model=${body.model}` : '';
        const mode = result[2]?.sse ? ' stream' : '';
        log(`[gift] ${method ?? '-'} ${path}${model} → ${result[0]}${mode}`);
      }
      return result;
    }
    if (path === '/v1/license/public-key') return [200, { alg: 'Ed25519', kid: keypair.kid, rawBase64: keypair.publicKeyBase64, spkiDerBase64: pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64') }];
    if (path === '/v1/license/grandfather') {
      if (!eligibleInstallId) return [403, { ok: false, error: 'grandfather_disabled' }];
      if (body.installId !== eligibleInstallId) return [403, { ok: false, error: 'not_eligible' }];
      const created = !grandfatherKey;
      grandfatherKey ??= issueKey();
      return [200, { ok: true, key: grandfatherKey, created }];
    }
    if (!/^[A-Za-z0-9\-_.:]{8,128}$/.test(body?.deviceId ?? '')) return [400, { ok: false, error: 'device_id_invalid' }];
    const normalizedKey = normalizeLicenseKey(body?.key);
    const license = licenses.get(normalizedKey);
    const deviceId = String(body?.deviceId ?? '');
    if (!license) return [404, { ok: false, error: 'invalid_key' }];
    if (path === '/v1/license/deactivate') {
      const removed = license.devices.delete(deviceId);
      license.platforms.delete(deviceId);
      return [200, { ok: true, removed, tier: license.tier, devicesUsed: license.devices.size, deviceLimit: license.deviceLimit }];
    }
    if (license.revoked) return [403, { ok: false, error: 'revoked', tier: license.tier }];
    if (license.licenseExpiresAt !== null && now() >= Math.max(license.licenseExpiresAt, license.paymentGraceEndsAt ?? 0)) {
      return [403, { ok: false, error: 'expired', tier: license.tier, licenseExpiresAt: license.licenseExpiresAt, paymentFixUrl: PAYMENT_FIX_URL }];
    }
    if (path === '/v1/license/activate') {
      if (!license.devices.has(deviceId) && license.devices.size >= license.deviceLimit) return [409, { ok: false, error: 'device_limit' }];
      license.devices.add(deviceId);
      license.platforms.set(deviceId, typeof body.platform === 'string' ? body.platform : null);
      return [200, leaseBody(normalizedKey, deviceId, license)];
    }
    if (path === '/v1/license/validate') {
      if (!license.devices.has(deviceId)) return [404, { ok: false, error: 'not_activated' }];
      return [200, leaseBody(normalizedKey, deviceId, license)];
    }
    return [404, { ok: false, error: 'not_found' }];
  }

  function sseStream(events) {
    const encoder = new TextEncoder();
    return new ReadableStream({
      start(controller) {
        for (const data of events) controller.enqueue(encoder.encode(sseFrame(data)));
        controller.close();
      },
    });
  }

  async function fetch(url, init = {}) {
    if (offline) throw new TypeError('fetch failed');
    if (init.signal?.aborted) throw init.signal.reason ?? new DOMException('aborted', 'AbortError');
    let body = {};
    try { body = JSON.parse(init.body ?? '{}'); } catch { body = null; }
    const [status, payload, extra] = handle(new URL(url).pathname, body, { method: init.method ?? 'GET', headers: init.headers ?? {} });
    if (extra?.sse) return new Response(sseStream(extra.sse), { status, headers: { 'Content-Type': 'text/event-stream' } });
    return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json', ...(extra?.headers ?? {}) } });
  }

  function giftState(ref) {
    const license = licenseByRef(ref);
    if (!license) return null;
    const record = giftRecord(license.id);
    return { licenseId: license.id, claimed: record.claimed, claimedAt: record.claimedAt, usageUsd: record.usageUsd, remainingUsd: remainingUsd(record) };
  }

  function setGiftUsage(ref, usd) {
    const license = licenseByRef(ref);
    if (license) giftRecord(license.id).usageUsd = Number(usd) || 0;
  }

  function snapshot() {
    return {
      event: giftEvent(),
      platforms: [...giftConfig.platforms],
      createdUsd: giftCreatedUsd,
      totalBudgetUsd: Number.isFinite(giftConfig.totalBudgetUsd) ? giftConfig.totalBudgetUsd : null,
      licenses: [...licenses.values()].map((license) => ({
        key: license.key,
        id: license.id,
        revoked: license.revoked,
        devices: [...license.devices].map((deviceId) => ({ deviceId, platform: license.platforms.get(deviceId) ?? null })),
        gift: giftState(license.id),
      })),
    };
  }

  return {
    fetch,
    handle,
    issueKey,
    calls,
    revoke(key) { licenses.get(key).revoked = true; },
    /** A renewal (later time), a cancel (autoRenew false) or an admin extend on the server. */
    setLicenseExpiry(key, licenseExpiresAt, { autoRenew = true, paymentGraceEndsAt = null } = {}) { Object.assign(licenses.get(key), { licenseExpiresAt, autoRenew, paymentGraceEndsAt }); },
    devices(key) { return [...licenses.get(key).devices]; },
    setOffline(value) { offline = value; },
    giftState,
    setGiftUsage,
    /** 모든 라이선스의 사용액을 같은 값으로 둔다(CLI 관리 경로). */
    setAllGiftUsage(usd) { for (const license of licenses.values()) setGiftUsage(license.id, usd); },
    setGiftActive(value) { giftConfig.active = Boolean(value); },
    snapshot,
  };
}

function cliPort(argv, env) {
  const index = argv.indexOf('--port');
  const raw = index >= 0 ? argv[index + 1] : env.MOCK_PORT;
  const port = Number(raw);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : 8787;
}

/** SSE 한 덩어리. 문자열은 data 만, {event, data} 는 event 줄도 붙인다 (Anthropic Messages). */
export function sseFrame(entry) {
  if (entry && typeof entry === 'object') return `event: ${entry.event}\ndata: ${entry.data}\n\n`;
  return `data: ${entry}\n\n`;
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => resolve(raw));
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = cliPort(process.argv.slice(2), process.env);
  const server = createMockLicenseServer({ log: (line) => console.log(line) });
  const key = server.issueKey();
  const betaKey = server.issueKey({ tier: 'beta' });
  const annualKey = server.issueKey({ licenseExpiresAt: Date.now() + 365 * 24 * 60 * 60 * 1000 });
  createServer(async (req, res) => {
    const raw = await readBody(req);
    let body = {};
    try { body = JSON.parse(raw || '{}'); } catch { body = null; }
    const path = new URL(req.url, 'http://x').pathname;
    const json = (status, payload) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    };
    if (path.startsWith('/__mock/')) {
      if (req.method === 'POST' && path === '/__mock/gift/usage') server.setAllGiftUsage(body?.usd);
      else if (req.method === 'POST' && path === '/__mock/gift/active') server.setGiftActive(body?.active);
      else if (req.method === 'POST' && path === '/__mock/license/expiry') {
        const target = normalizeLicenseKey(body?.key);
        if (!target || !server.snapshot().licenses.some((l) => l.key === target)) return json(404, { ok: false, error: 'invalid_key' });
        server.setLicenseExpiry(target, Number.isSafeInteger(body?.licenseExpiresAt) ? body.licenseExpiresAt : null, {
          autoRenew: body?.autoRenew !== false,
          paymentGraceEndsAt: Number.isSafeInteger(body?.paymentGraceEndsAt) ? body.paymentGraceEndsAt : null,
        });
      }
      else if (!(req.method === 'GET' && path === '/__mock/state')) return json(404, { ok: false, error: 'not_found' });
      console.log(`[mock] ${req.method} ${path}${raw ? ` ${raw}` : ''}`);
      return json(200, { ok: true, state: server.snapshot() });
    }
    if (!['POST', 'GET'].includes(req.method)) return json(405, { ok: false, error: 'method' });
    const [status, payload, extra] = server.handle(path, body ?? {}, { method: req.method, headers: req.headers });
    if (!extra?.sse) {
      res.writeHead(status, { 'Content-Type': 'application/json', ...(extra?.headers ?? {}) });
      res.end(JSON.stringify(payload));
      return;
    }
    res.writeHead(status, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    let closed = false;
    res.on('close', () => { closed = true; });
    for (const data of extra.sse) {
      if (closed) return;
      res.write(sseFrame(data));
      await new Promise((resolve) => setTimeout(resolve, 60));
    }
    res.end();
  }).listen(port, '127.0.0.1', () => {
    console.log(`mock key server on http://127.0.0.1:${port}, test key ${key}`);
    console.log(`beta test key ${betaKey} (lifetime, 3-day leases)`);
    console.log(`annual test key ${annualKey} (renews in 365 days)`);
    console.log(`HAMA_LICENSE_DEV_PUBLIC_KEY=${DEV_KEYPAIR.kid}:${DEV_KEYPAIR.publicKeyBase64}`);
    console.log(`gift proxy base http://127.0.0.1:${port}${GIFT_PROXY_PREFIX}`);
  });
}
