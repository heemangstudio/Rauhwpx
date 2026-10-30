// 앱 요금제(무료·Pro·예전 키·Hama)와 앱 안 결제. 메인 프로세스가 하나 만들어 Studio 의 업그레이드 카드와
// 에이전트 잠금에 상태(PlanStatus)를 준다.
//
// 규칙
// - 요금제: Hama 가 켜져 있으면 hama, 서명한 lease 가 있으면 edition 'pro' 는 pro, 그 밖의 키(GLJFC9 연간·평생·
//   Signature·베타·기존 사용자·수동 발급)는 legacy, 없으면 free. 라이선스를 보지 않는 개발 빌드(unenforced)는
//   요금제와 상관없이 에이전트를 연다.
// - 오프라인 캐시: lease 로 정한 요금제를 userData/plan.json 에 적어 두고, lease 를 확인할 수 없을 때만
//   (lease_expired·needs_activation) 마지막 확인에서 7일까지 그 요금제를 보여 준다. 화면 표시용일 뿐이고
//   호스팅 AI 는 서버가 늘 따로 확인한다. 해지·만료·키 없음이면 캐시를 지운다. 시계를 되돌려 늘리지 못하게
//   확인 시각보다 이른 시각에는 캐시를 쓰지 않는다.
// - 결제: 이메일이 아니라 결제마다 만든 ref 로 확인한다. 이메일로 묻게 하면 구매자 이메일만 알아도 키를 받아 갈
//   수 있기 때문이다. 웹사이트(website/assets/purchase.js)와 같은 방식으로 ref 를 만들어 Groble 링크에 붙여 열고,
//   GET /v1/license/by-ref 를 5초마다 10분, 그 뒤로 30초마다, 24시간까지 묻는다. 키가 나오면 라이선스 관리자로
//   활성화한다. 진행 중인 결제는 plan.json 에 남겨 다시 실행해도 이어서 묻는다.
// - 키·ref·결제 주소는 렌더러에 보내지 않고 기록에도 남기지 않는다. plan.json 에는 ref 가 있어 0600 으로 쓴다.
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DEFAULT_LICENSE_API_BASE } from './license-client.mjs';
import { PLAN_CHECKOUT } from './plan-config.mjs';

export const PLAN_STATE_FILE = 'plan.json';
export const PLAN_SKUS = Object.freeze(['proMonthly', 'proYearly', 'hama']);
/** lease 를 확인할 수 없을 때 마지막 확인의 요금제를 보여 주는 기간. */
export const PLAN_CACHE_MS = 7 * 24 * 60 * 60 * 1000;
/** 결제 시작 뒤 이 시간 동안은 자주, 그 뒤로는 드물게 묻는다. */
export const CHECKOUT_FAST_WINDOW_MS = 10 * 60 * 1000;
export const CHECKOUT_FAST_POLL_MS = 5 * 1000;
export const CHECKOUT_SLOW_POLL_MS = 30 * 1000;
/** 이만큼 지나도 키가 나오지 않으면 묻기를 그만둔다. 키는 메일로도 가므로 직접 넣으면 된다. */
export const CHECKOUT_GIVE_UP_MS = 24 * 60 * 60 * 1000;
/** 오래 켜 둔 앱에서 캐시 만료와 확인 시각을 이 간격으로 다시 본다. */
const REFRESH_TICK_MS = 60 * 60 * 1000;
/** lease 로 다시 확인했을 때 확인 시각을 이 간격으로만 파일에 쓴다. */
const VERIFIED_PERSIST_MS = 60 * 60 * 1000;
const BY_REF_TIMEOUT_MS = 10_000;
/** Groble sellerReference 규칙. 서버(site-api/licenses.mjs REF_RE)와 같다. */
const REF_RE = /^[A-Za-z0-9\-_.:=~]{1,128}$/;
const CACHED_TIERS = new Set(['pro', 'legacy']);
/** lease 를 지금 확인할 수 없을 뿐인 라이선스 상태. 이때만 캐시를 쓴다. */
const UNVERIFIABLE_STATES = new Set(['lease_expired', 'needs_activation']);
/** 다시 물어도 바뀌지 않는 활성화 실패. 결제 확인을 끝내고 키를 직접 넣게 한다. */
const FINAL_ACTIVATION_CODES = new Set(['invalid_key', 'revoked', 'expired', 'device_limit', 'invalid_format', 'bad_lease']);

/** 결제 링크는 groble.im 의 https 주소일 때만 쓴다. 아니면 null. */
export function checkoutUrlFrom(value) {
  if (typeof value !== 'string' || !value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && (url.hostname === 'groble.im' || url.hostname.endsWith('.groble.im')) ? url.href : null;
  } catch {
    return null;
  }
}

/** 웹사이트와 같은 모양의 ref: hama-<시각 36진수>-<32자리 16진수>. */
export function newCheckoutRef(t = Date.now()) {
  return `hama-${t.toString(36)}-${randomBytes(16).toString('hex')}`;
}

function withRef(url, ref) {
  return `${url}${url.includes('?') ? '&' : '?'}ref=${encodeURIComponent(ref)}`;
}

function emptyState() {
  return { v: 1, tier: null, verifiedAt: 0, pendingCheckout: null };
}

function sanitizeState(raw) {
  const state = emptyState();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.v !== 1) return state;
  if (CACHED_TIERS.has(raw.tier) && Number.isSafeInteger(raw.verifiedAt) && raw.verifiedAt > 0) {
    state.tier = raw.tier;
    state.verifiedAt = raw.verifiedAt;
  }
  const pending = raw.pendingCheckout;
  if (pending && PLAN_SKUS.includes(pending.sku) && typeof pending.ref === 'string' && REF_RE.test(pending.ref)
    && Number.isSafeInteger(pending.startedAt) && pending.startedAt > 0) {
    state.pendingCheckout = { sku: pending.sku, ref: pending.ref, startedAt: pending.startedAt };
  }
  return state;
}

export function createPlanManager({
  licenseManager,
  fetchImpl = globalThis.fetch,
  apiBase = DEFAULT_LICENSE_API_BASE,
  userDataDir,
  now = Date.now,
  config = PLAN_CHECKOUT,
  hamaActive = () => null,
  openExternal = async () => {},
  onChange = () => {},
  timers = { setTimeout, clearTimeout, setInterval, clearInterval },
  fs = { mkdir, readFile, rename, rm, writeFile },
  log = console,
} = {}) {
  const statePath = join(String(userDataDir), PLAN_STATE_FILE);
  const base = String(apiBase).replace(/\/+$/, '');
  let state = null;
  let persistedBody = null;
  let queue = Promise.resolve();
  let status = null;
  let notified = null;
  let lastCheckout = null;
  let pollTimer = null;
  let tickTimer = null;
  let polling = false;
  let stopped = true;

  function serialize(task) {
    const next = queue.then(task);
    queue = next.catch(() => {});
    return next;
  }

  async function persist() {
    const body = `${JSON.stringify(state, null, 2)}\n`;
    if (body === persistedBody) return;
    const temp = `${statePath}.${process.pid}.${randomUUID()}.tmp`;
    await fs.mkdir(String(userDataDir), { recursive: true });
    try {
      await fs.writeFile(temp, body, { mode: 0o600 });
      await fs.rename(temp, statePath);
      persistedBody = body;
    } catch (error) {
      await fs.rm(temp, { force: true }).catch(() => {});
      throw error;
    }
  }

  async function load() {
    if (state) return;
    let raw = null;
    try {
      raw = JSON.parse(await fs.readFile(statePath, 'utf8'));
    } catch (error) {
      if (error?.code !== 'ENOENT') log.warn?.('[plan] state unreadable, starting fresh:', error?.message ?? error);
    }
    state = sanitizeState(raw);
    persistedBody = raw ? `${JSON.stringify(raw, null, 2)}\n` : null;
  }

  function checkoutView() {
    return Object.fromEntries(PLAN_SKUS.map((sku) => [sku, {
      available: checkoutUrlFrom(config?.[sku]?.url) !== null,
      priceKrw: Number.isFinite(config?.[sku]?.priceKrw) ? config[sku].priceKrw : null,
    }]));
  }

  /** 라이선스 상태로 요금제를 정하고 캐시를 고친다. 상태 파일 쓰기는 부르는 쪽이 한다. */
  function derive(license) {
    const t = now();
    const unenforced = license?.state === 'unenforced';
    let tier = 'free';
    let source = 'none';
    let cachedUntil = null;
    if (hamaActive() === true) {
      tier = 'hama';
      source = 'live';
    } else if (license?.paid) {
      tier = license.edition === 'pro' ? 'pro' : 'legacy';
      source = 'live';
      if (state.tier !== tier || t - state.verifiedAt >= VERIFIED_PERSIST_MS || t < state.verifiedAt) {
        state.tier = tier;
        state.verifiedAt = t;
      }
    } else if (state.tier && UNVERIFIABLE_STATES.has(license?.state)
      && t >= state.verifiedAt && t - state.verifiedAt < PLAN_CACHE_MS) {
      tier = state.tier;
      source = 'cached';
      cachedUntil = state.verifiedAt + PLAN_CACHE_MS;
    } else if (!unenforced) {
      // 해지·만료·키 없음, 7일이 지났거나 시계가 확인 시각보다 이르면 캐시를 버린다.
      state.tier = null;
      state.verifiedAt = 0;
    }
    return {
      tier,
      agentUnlocked: tier !== 'free' || unenforced,
      source,
      cachedUntil,
      checkout: checkoutView(),
      pendingCheckout: state.pendingCheckout
        ? { sku: state.pendingCheckout.sku, startedAt: state.pendingCheckout.startedAt }
        : null,
      lastCheckout,
    };
  }

  function emit() {
    const fingerprint = JSON.stringify(status);
    if (fingerprint === notified) return;
    notified = fingerprint;
    try { onChange(status); } catch (error) { log.warn?.('[plan] change listener failed:', error); }
  }

  /** 라이선스 상태(없으면 지금 읽는다)로 다시 정하고, 바뀌었으면 알린다. */
  function refresh(license) {
    return serialize(async () => {
      await load();
      status = derive(license ?? await licenseManager.status());
      await persist().catch((error) => log.warn?.('[plan] state write failed:', error?.message ?? error));
      emit();
      return status;
    });
  }

  function clearPoll() {
    if (pollTimer !== null) timers.clearTimeout(pollTimer);
    pollTimer = null;
  }

  function schedulePoll(delayMs) {
    clearPoll();
    if (stopped || !state?.pendingCheckout) return;
    pollTimer = timers.setTimeout(() => {
      pollTimer = null;
      return poll().catch((error) => log.warn?.('[plan] checkout poll failed:', error?.message ?? error));
    }, delayMs);
    pollTimer?.unref?.();
  }

  function nextDelay(pending) {
    return Math.max(0, now() - pending.startedAt) < CHECKOUT_FAST_WINDOW_MS ? CHECKOUT_FAST_POLL_MS : CHECKOUT_SLOW_POLL_MS;
  }

  /** 진행 중인 결제를 끝낸다. 같은 ref 일 때만. */
  async function finishCheckout(ref, outcome, license) {
    await serialize(async () => {
      if (state.pendingCheckout?.ref !== ref) return;
      lastCheckout = { sku: state.pendingCheckout.sku, ...outcome };
      state.pendingCheckout = null;
    });
    await refresh(license);
  }

  async function askByRef(ref) {
    const response = await fetchImpl(`${base}/v1/license/by-ref?ref=${encodeURIComponent(ref)}`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(BY_REF_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const body = await response.json().catch(() => null);
    return body && typeof body === 'object' && !Array.isArray(body) ? body : null;
  }

  async function poll() {
    if (polling || stopped) return;
    const pending = state?.pendingCheckout;
    if (!pending) return;
    polling = true;
    try {
      if (Math.max(0, now() - pending.startedAt) >= CHECKOUT_GIVE_UP_MS) {
        log.info?.('[plan] checkout gave up after 24 h');
        await finishCheckout(pending.ref, { ok: false, code: 'timed_out' });
        return;
      }
      let answer = null;
      try {
        answer = await askByRef(pending.ref);
      } catch {
        // 네트워크 오류는 다음 차례에 다시 묻는다.
      }
      if (state.pendingCheckout?.ref !== pending.ref) return;
      if (answer?.status === 'revoked') {
        await finishCheckout(pending.ref, { ok: false, code: 'revoked' });
        return;
      }
      if (answer?.status === 'issued' && typeof answer.key === 'string' && answer.key) {
        const result = await licenseManager.activate(answer.key);
        if (result?.ok) {
          log.info?.('[plan] checkout activated');
          await finishCheckout(pending.ref, { ok: true }, result.status);
          return;
        }
        if (FINAL_ACTIVATION_CODES.has(result?.code)) {
          log.warn?.('[plan] checkout key activation failed:', result.code);
          await finishCheckout(pending.ref, { ok: false, code: result.code }, result.status);
          return;
        }
      }
      if (state.pendingCheckout?.ref === pending.ref) schedulePoll(nextDelay(pending));
    } finally {
      polling = false;
    }
  }

  async function startCheckout(sku) {
    const url = PLAN_SKUS.includes(sku) ? checkoutUrlFrom(config?.[sku]?.url) : null;
    if (!url) return { ok: false, code: 'not_available', status: await refresh() };
    const pending = await serialize(async () => {
      await load();
      if (state.pendingCheckout) return null;
      const startedAt = now();
      state.pendingCheckout = { sku, ref: newCheckoutRef(startedAt), startedAt };
      lastCheckout = null;
      await persist();
      return state.pendingCheckout;
    });
    if (!pending) return { ok: false, code: 'busy', status: await refresh() };
    try {
      await openExternal(withRef(url, pending.ref));
    } catch (error) {
      log.warn?.('[plan] checkout page failed to open:', error?.message ?? error);
      await serialize(async () => {
        if (state.pendingCheckout?.ref === pending.ref) state.pendingCheckout = null;
      });
      return { ok: false, code: 'open_failed', status: await refresh() };
    }
    schedulePoll(CHECKOUT_FAST_POLL_MS);
    return { ok: true, status: await refresh() };
  }

  async function cancelCheckout() {
    await serialize(async () => {
      await load();
      state.pendingCheckout = null;
    });
    clearPoll();
    return refresh();
  }

  async function start() {
    stopped = false;
    await refresh().catch((error) => log.warn?.('[plan] first refresh failed:', error));
    // 다시 실행했을 때 진행 중이던 결제를 이어서 묻는다.
    if (state?.pendingCheckout) schedulePoll(0);
    tickTimer = timers.setInterval(() => {
      void refresh().catch((error) => log.warn?.('[plan] scheduled refresh failed:', error));
    }, REFRESH_TICK_MS);
    tickTimer?.unref?.();
  }

  function stop() {
    stopped = true;
    clearPoll();
    if (tickTimer !== null) timers.clearInterval(tickTimer);
    tickTimer = null;
  }

  return {
    getStatus: () => refresh(),
    /** 라이선스 관리자의 onChange 에서 부른다. */
    licenseChanged: (license) => refresh(license),
    startCheckout,
    cancelCheckout,
    start,
    stop,
  };
}
