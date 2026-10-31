// 앱 요금제(무료·Pro·예전 키·Hama)와 앱 안 결제. 메인 프로세스가 하나 만들어 Studio 의 업그레이드 카드와
// 에이전트 잠금에 상태(PlanStatus)를 준다.
//
// 규칙
// - 요금제는 계정에서 정한다(라이선스 관리자는 더 이상 정하지 않는다). Hama 가 켜져 있으면 hama, 확인한 계정
//   lease 가 있으면 그 tier('free'·'pro'·'legacy'·'hama'), 로그인하지 않았으면 free. 라이선스를 보지 않는 개발
//   빌드(enforce 끔)는 요금제와 상관없이 에이전트를 연다.
// - 오프라인 캐시: lease 로 정한 요금제를 그 계정 id 와 함께 userData/plan.json 에 적어 두고, 로그인한 채 lease 를
//   확인할 수 없을 때만(오프라인으로 lease 가 끝남 등) 마지막 확인에서 7일까지 그 요금제를 보여 준다. 화면 표시용일
//   뿐이고 호스팅 AI 는 서버가 늘 따로 확인한다. 로그아웃·무료 lease·다른 계정이면 캐시를 지운다. 시계를 되돌려
//   늘리지 못하게 확인 시각보다 이른 시각에는 캐시를 쓰지 않는다.
// - 결제: 로그인해야 시작한다(sign_in_required). 이메일이 아니라 결제마다 만든 ref 로 확인한다. 이메일로 묻게
//   하면 구매자 이메일만 알아도 키를 받아 갈 수 있기 때문이다. 웹사이트(website/assets/purchase.js)와 같은 방식으로
//   ref 를 만들어 Groble 링크에 붙여 열고, GET /v1/license/by-ref 를 5초마다 10분, 그 뒤로 30초마다, 24시간까지
//   묻는다. 키가 나오면 계정에 연결한다(accountManager.redeem). 진행 중인 결제는 plan.json 에 남겨 다시 실행해도
//   이어서 묻는다.
// - 키·ref·결제 주소는 렌더러에 보내지 않고 기록에도 남기지 않는다. plan.json 에는 ref 가 있어 0600 으로 쓴다.
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DEFAULT_LICENSE_API_BASE } from './license-client.mjs';
import { PLAN_CHECKOUT } from './plan-config.mjs';

export const PLAN_STATE_FILE = 'plan.json';
export const PLAN_SKUS = Object.freeze(['proMonthly', 'proYearly', 'hamaMonthly', 'hamaYearly']);
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
const CACHED_TIERS = new Set(['pro', 'hama', 'legacy']);
/** 다시 물어도 바뀌지 않는 키 연결 실패. 결제 확인을 끝내고 키를 직접 넣게 한다. 그 밖(네트워크·로그아웃 등)은 계속 묻는다. */
const FINAL_REDEEM_CODES = new Set(['invalid_key', 'revoked', 'invalid_format', 'key_linked_elsewhere']);

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
  return { v: 1, tier: null, accountId: null, verifiedAt: 0, pendingCheckout: null };
}

function sanitizeState(raw) {
  const state = emptyState();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.v !== 1) return state;
  // 계정 id 가 없는 예전 캐시(라이선스로 정한 요금제)는 버린다.
  if (CACHED_TIERS.has(raw.tier) && typeof raw.accountId === 'string' && raw.accountId
    && Number.isSafeInteger(raw.verifiedAt) && raw.verifiedAt > 0) {
    state.tier = raw.tier;
    state.accountId = raw.accountId;
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
  accountManager,
  enforce = true,
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

  function clearCache() {
    state.tier = null;
    state.accountId = null;
    state.verifiedAt = 0;
  }

  /** 계정(entitlement: { signedIn, accountId, tier })으로 요금제를 정하고 캐시를 고친다. 상태 파일 쓰기는 부르는 쪽이 한다. */
  function derive(entitlement) {
    const t = now();
    const signedIn = entitlement?.signedIn === true;
    const accountId = signedIn ? entitlement.accountId : null;
    let tier = 'free';
    let source = 'none';
    let cachedUntil = null;
    if (hamaActive() === true) {
      tier = 'hama';
      source = 'live';
    } else if (signedIn && entitlement.tier) {
      tier = entitlement.tier;
      source = 'live';
      if (!CACHED_TIERS.has(tier)) clearCache();
      else if (state.tier !== tier || state.accountId !== accountId || t - state.verifiedAt >= VERIFIED_PERSIST_MS || t < state.verifiedAt) {
        state.tier = tier;
        state.accountId = accountId;
        state.verifiedAt = t;
      }
    } else if (signedIn && state.tier && state.accountId === accountId
      && t >= state.verifiedAt && t - state.verifiedAt < PLAN_CACHE_MS) {
      tier = state.tier;
      source = 'cached';
      cachedUntil = state.verifiedAt + PLAN_CACHE_MS;
    } else {
      // 로그아웃·다른 계정, 7일이 지났거나 시계가 확인 시각보다 이르면 캐시를 버린다.
      clearCache();
    }
    return {
      tier,
      signedIn,
      agentUnlocked: tier !== 'free' || !enforce,
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

  /** 계정 상태를 지금 읽어 다시 정하고, 바뀌었으면 알린다. */
  function refresh() {
    return serialize(async () => {
      await load();
      status = derive(await accountManager.entitlement());
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
  async function finishCheckout(ref, outcome) {
    await serialize(async () => {
      if (state.pendingCheckout?.ref !== ref) return;
      lastCheckout = { sku: state.pendingCheckout.sku, ...outcome };
      state.pendingCheckout = null;
    });
    await refresh();
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
        // 이미 이 계정에 붙은 키(alreadyLinked)도 성공이다. 웹훅이 이메일로 먼저 붙였을 수 있다.
        const result = await accountManager.redeem(answer.key);
        if (result?.ok) {
          log.info?.('[plan] checkout linked to the account');
          await finishCheckout(pending.ref, { ok: true });
          return;
        }
        if (FINAL_REDEEM_CODES.has(result?.code)) {
          log.warn?.('[plan] checkout key could not be linked:', result.code);
          await finishCheckout(pending.ref, { ok: false, code: result.code });
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
    // 결제한 키는 계정에 붙는다. 로그인하지 않았으면 결제를 열지 않는다.
    if (!(await accountManager.entitlement())?.signedIn) return { ok: false, code: 'sign_in_required', status: await refresh() };
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
    /** 계정 관리자의 onChange 에서 부른다. */
    accountChanged: () => refresh(),
    startCheckout,
    cancelCheckout,
    start,
    stop,
  };
}
