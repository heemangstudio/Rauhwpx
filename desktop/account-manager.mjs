// 계정 상태. 메인 프로세스가 하나 만들어 Studio 의 계정 화면, 요금제, 선물·Rau 에 상태와 lease 를 준다.
//
// 규칙
// - 로그인: 시스템 브라우저로 서버의 로그인 주소(WorkOS AuthKit)를 열고, 127.0.0.1 의 일회용 루프백 서버가
//   /auth/callback 으로 돌아온 로그인 코드를 받는다. PKCE verifier 와 앱 state 는 메모리에만 두고, 10분이 지나면
//   그만둔다. 한 번에 하나만 진행한다.
// - 기기: 계정마다 5대까지. 넘으면 서버가 기기 목록을 주고(device_limit), 사용자가 고른 기기를 빼고 같은 코드로
//   다시 받는다. 그 사이 코드와 verifier 는 메모리에만 있다. 기기 id 는 처음 한 번 만든 UUID 를 로그아웃해도 그대로
//   쓴다. 같은 컴퓨터로 다시 로그인하면 새 자리를 차지하지 않는다.
// - 세션 토큰은 safeStorage 로 암호화해 account.json 에 둔다. 암호화를 쓸 수 없으면 그대로 둔다. 비밀 저장소와
//   예전 키(rhwp.account.session-token)는 쓰지 않는다. 풀지 못한 토큰은 로그아웃으로 본다.
// - 실행할 때, 12시간마다, 사용자가 다시 확인할 때, 바꾸는 요청 뒤마다 서버에 다시 묻는다. 서버에 닿지 못하면 가진
//   lease 와 계정 정보를 그대로 쓰고(sync.offline) 15분마다 다시 묻는다. 서버가 세션을 모르면(session_invalid)
//   이 기기만 로그아웃한다(기기 id 는 남긴다).
// - lease(v2)는 서명·기기·계정·만료를 확인한 것만 쓴다. 무료(tier 'free') lease 는 호스팅 기능에 주지 않는다.
// - Rau 체험(7일, 크레딧 $2)은 계정마다 한 번, 로그인한 뒤에만 시작한다(startRauTrial). 서버가 정하고 앱은 보여 주기만 한다.
// - 사진은 userData/account-avatar 에 받아 두고 서버의 rev 가 바뀌면 다시 받는다. 상태 방송에는 넣지 않는다.
// - 사용 기록(에이전트 세션·편집한 문서)은 id 를 해시로 2,000개씩 기억해 한 번만 세고, 5분에 한 번과 앱을 끝낼 때
//   서버로 보낸다. 보내지 못한 묶음은 같은 batchId 로 다시 보낸다. 로그인하지 않은 동안의 기록은 버린다.
// - 이 기기의 예전 라이선스 키는 로그인하면 한 번, 그 뒤로 하루에 한 번까지 계정에 연결한다. 키는 지우지 않는다.
// - 토큰·로그인 코드·verifier·이메일·키는 기록에 남기지 않는다.
import { remainingPercentFrom } from './rau-client.mjs';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { AccountServerError } from './account-client.mjs';
import {
  licenseKeyHash, normalizeGiftCode, normalizeLicenseKey, PRODUCTION_LICENSE_PUBLIC_KEYS, verifyAccountLease,
} from './license-lease.mjs';
import { DEFAULT_PAYMENT_FIX_URL } from './license-manager.mjs';

export const ACCOUNT_STATE_FILE = 'account.json';
export const ACCOUNT_AVATAR_FILE = 'account-avatar';
export const ACCOUNT_REFRESH_INTERVAL_MS = 12 * 60 * 60 * 1000;
/** 서버에 닿지 못했을 때 다시 묻는 간격. */
export const ACCOUNT_OFFLINE_RETRY_MS = 15 * 60 * 1000;
export const SIGN_IN_TIMEOUT_MS = 10 * 60 * 1000;
export const ACTIVITY_FLUSH_MS = 5 * 60 * 1000;
export const ACTIVITY_DEDUPE_LIMIT = 2000;
export const KEY_MIGRATION_RETRY_MS = 24 * 60 * 60 * 1000;
export const AVATAR_MAX_BYTES = 1024 * 1024;
export const AVATAR_TYPES = Object.freeze(['image/jpeg', 'image/png', 'image/webp']);
export const ACCOUNT_PROVIDERS = Object.freeze(['email', 'google']);
export const ACTIVITY_KINDS = Object.freeze({ agent_session: 'agentSessions', document_edited: 'documentsEdited' });
const DEFAULT_PROVIDERS = Object.freeze(['email', 'google']);
const DEFAULT_DEVICE_LIMIT = 5;
/** 잠자기에서 깬 뒤 등 확인할 때가 됐는지 이 간격으로 본다. */
const TICK_MS = 60 * 1000;
/** 서버가 한 묶음에 받는 최대 횟수. */
const MAX_STAT_BATCH = 1000;
const QUIT_FLUSH_TIMEOUT_MS = 3000;
const DEVICE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SERVER_DEVICE_ID_RE = /^[A-Za-z0-9\-_.:]{8,128}$/;
const SESSION_RE = /^hes_[A-Za-z0-9_-]{16,256}$/;
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/g;
const TIERS = new Set(['free', 'hama', 'rau']);
const EDITIONS = new Set(['hama', 'rau', 'signature']);
const PLANS = new Set(['monthly', 'annual', 'lifetime']);
const RAU_SOURCES = new Set(['plan', 'trial']);
const TRIAL_STATES = new Set(['available', 'active', 'ended']);
/** 서버가 정한 체험 길이와 크레딧. 서버가 보내지 않으면 이 값으로 보인다. */
export const RAU_TRIAL_DAYS = 7;
const LICENSE_STATUSES = new Set(['active', 'past_due', 'expired', 'revoked']);
/** 다시 시도해도 같은 답이 오는 키 연결 실패. */
const INVALID_KEY_CODES = new Set(['invalid_key', 'revoked', 'invalid_format']);
/** 기기를 고르는 동안 다시 시도할 수 있는 실패. 로그인을 끝내지 않는다. */
const RETRYABLE_TOKEN_CODES = new Set(['device_not_found', 'network', 'server', 'rate_limited']);

export const ACCOUNT_MESSAGES = Object.freeze({
  network: '서버에 연결하지 못했어요. 인터넷 연결을 확인해 주세요.',
  server: '서버가 잠시 응답하지 않아요. 조금 뒤 다시 시도해 주세요.',
  accounts_not_configured: '계정 기능을 아직 쓸 수 없어요.',
  auth_failed: '로그인하지 못했어요. 다시 시도해 주세요.',
  auth_cancelled: '로그인을 취소했어요.',
  auth_timeout: '로그인 시간이 지났어요. 다시 시도해 주세요.',
  browser_failed: '브라우저를 열지 못했어요.',
  grant_invalid: '로그인 시간이 지났어요. 다시 시도해 주세요.',
  device_not_found: '그 기기는 이미 빠졌어요.',
  session_invalid: '이 기기는 계정에서 빠졌어요. 다시 로그인해 주세요.',
  invalid_format: '프로모션 코드 형식이 아니에요.',
  invalid_code: '선물 코드를 찾을 수 없어요.',
  code_redeemed: '다른 계정에서 이미 사용한 선물 코드예요.',
  code_expired: '사용 기한이 지난 선물 코드예요.',
  code_revoked: '취소된 선물 코드예요.',
  invalid_key: '라이선스 키를 찾을 수 없어요.',
  revoked: '해지된 라이선스 키예요.',
  key_linked_elsewhere: '다른 계정에 연결된 키예요.',
  order_not_found: '주문을 찾지 못했어요. 주문번호와 Groble 이메일을 확인해 주세요.',
  order_not_ready: '결제를 아직 확인하는 중이에요. 잠시 뒤 다시 시도해 주세요.',
  name_invalid: '이름은 1~30자로 적어 주세요.',
  too_large: '사진이 너무 커요.',
  unsupported_type: 'JPG, PNG, WebP 사진만 쓸 수 있어요.',
  confirm_mismatch: '이메일이 맞지 않아요.',
  subscription_active: '구독을 먼저 해지해 주세요.',
  rate_limited: '잠시 뒤 다시 시도해 주세요.',
  trial_used: 'Rau 체험은 계정마다 한 번만 쓸 수 있어요.',
  rau_active: '이미 Rau 요금제를 쓰고 있어요.',
  rau_unavailable: 'Rau 체험을 지금은 시작할 수 없어요. 조금 뒤 다시 시도해 주세요.',
  sign_in_required: '먼저 로그인해 주세요.',
  already_signed_in: '이미 로그인했어요.',
  invalid: '요청을 처리하지 못했어요.',
});

export function accountErrorMessage(code) {
  return ACCOUNT_MESSAGES[code] ?? ACCOUNT_MESSAGES.server;
}

const NO_RAU = Object.freeze({
  eligible: false, source: null, remainingPercent: null, resetsAt: null,
});
const FREE_PLAN = Object.freeze({
  tier: 'free', edition: null, plan: null, expiresAt: null, autoRenew: null,
  paymentFailed: false, paymentGraceEndsAt: null, manageUrl: null, rau: NO_RAU,
});

// ── 루프백 페이지 ────────────────────────────────────────────────────────
// 브라우저에 남는 작은 페이지. 바깥 자원도 스크립트도 없다.
// 사이드바 하마(chat-hama.ts)와 같은 픽셀·팔레트를 인라인 SVG 로 그린다.
const HAMA_COLORS = { o: '#62b3e2', s: '#2f73a0' };
const HAMA_CLOSED = [
  '..............',
  '..............',
  '.....s........',
  '.....oooooooo.',
  '...ooooooooos.',
  '.oooooooo.....',
  '.ooooooo......',
  '.os..os.......',
];
const HAMA_OPEN = [
  '.......ooo....',
  '.....s.oo.....',
  '.....oooo.....',
  '.....oooooos..',
  '...oooooooo...',
  '.oooooooo.....',
  '.ooooooo......',
  '.os..os.......',
];

function hamaPixels(art) {
  return art.flatMap((row, y) => [...row.matchAll(/o+|s+/g)].map((run) => (
    `<rect x="${run.index}" y="${y}" width="${run[0].length}" height="1" fill="${HAMA_COLORS[run[0][0]]}"/>`
  ))).join('');
}

function page(title, line) {
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${title}</title>
<style>
  :root { color-scheme: light dark; --bg: #ffffff; --fg: #17181a; --muted: #6b6f76; --bubble: #eef0f3; }
  @media (prefers-color-scheme: dark) { :root { --bg: #161718; --fg: #f2f3f5; --muted: #9a9ea6; --bubble: #26282c; } }
  html, body { height: 100%; margin: 0; }
  body {
    display: grid; place-items: center; background: var(--bg); color: var(--fg);
    font-family: system-ui, "Segoe UI", "Malgun Gothic", sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  main { display: flex; flex-direction: column; align-items: center; padding: 24px; text-align: center; }
  .bubble {
    position: relative; margin: 8px 8px 32px; padding: 10px 14px; background: var(--bubble);
    box-shadow: -8px 0 var(--bubble), 8px 0 var(--bubble), 0 -8px var(--bubble), 0 8px var(--bubble);
  }
  .bubble::before, .bubble::after { content: ""; position: absolute; left: calc(50% + 16px); height: 8px; background: var(--bubble); }
  .bubble::before { bottom: -16px; width: 16px; }
  .bubble::after { bottom: -24px; width: 8px; }
  h1 { margin: 0; font-size: 18px; font-weight: 600; letter-spacing: -0.01em; }
  h1 + p { margin-top: 6px; }
  p { margin: 0; font-size: 14px; color: var(--muted); }
  svg { display: block; width: 112px; height: 64px; shape-rendering: crispEdges; }
  .mouth-open { animation: talk-open 1.2s step-end 3; }
  .mouth-closed { visibility: hidden; animation: talk-closed 1.2s step-end 3; }
  @keyframes talk-open { 0%, 50% { visibility: visible; } 25%, 75% { visibility: hidden; } }
  @keyframes talk-closed { 0%, 50% { visibility: hidden; } 25%, 75% { visibility: visible; } }
  @media (prefers-reduced-motion: reduce) { .mouth-open, .mouth-closed { animation: none; } }
</style>
</head>
<body>
<main>
<div class="bubble">
<h1>${title}</h1>${line ? `
<p>${line}</p>` : ''}
</div>
<svg viewBox="0 0 14 8" aria-hidden="true">
<g class="mouth-closed">${hamaPixels(HAMA_CLOSED)}</g>
<g class="mouth-open">${hamaPixels(HAMA_OPEN)}</g>
</svg>
</main>
</body>
</html>
`;
}

export const LOOPBACK_SUCCESS_PAGE = page('HamaEditor로 돌아가세요', '');
export const LOOPBACK_FAILURE_PAGE = page('로그인하지 못했어요', '앱에서 다시 시도해 주세요.');

const PAGE_HEADERS = Object.freeze({
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  Connection: 'close',
});

// ── 값 다듬기 ────────────────────────────────────────────────────────────
const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const text = (value, max) => (typeof value === 'string' ? value.replace(CONTROL_RE, '').slice(0, max) : '');
const epochOrNull = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : null);
const boolOrNull = (value) => (typeof value === 'boolean' ? value : null);
const count = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : 0);
const oneOf = (value, set) => (set.has(value) ? value : null);

function isoToEpoch(value) {
  if (Number.isSafeInteger(value)) return value;
  const t = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  return Number.isFinite(t) ? t : null;
}

/** 서버가 준 Groble 주소는 groble.im 의 https 페이지일 때만 쓴다. */
function grobleUrlFrom(value) {
  if (typeof value !== 'string' || !value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && (url.hostname === 'groble.im' || url.hostname.endsWith('.groble.im')) ? url.href : null;
  } catch {
    return null;
  }
}

/** 서버의 라이선스 표시와 같은 모양: HAMA-ABCDE-•••••-•••••-•••••-VWXYZ */
export function maskKeyForAccount(key) {
  const normalized = normalizeLicenseKey(key);
  if (!normalized) return '';
  const parts = normalized.split('-');
  return [parts[0], parts[1], '•••••', '•••••', '•••••', parts[5]].join('-');
}

export function sanitizeDeviceName(value) {
  const name = text(value, 256).trim().slice(0, 64).trim();
  return name || '이름 없는 기기';
}

function sanitizeDevice(raw, deviceId) {
  if (!isObject(raw) || typeof raw.id !== 'string' || !SERVER_DEVICE_ID_RE.test(raw.id)) return null;
  return {
    id: raw.id,
    name: sanitizeDeviceName(raw.name),
    platform: text(raw.platform, 16),
    appVersion: typeof raw.appVersion === 'string' && raw.appVersion ? text(raw.appVersion, 32) : null,
    addedAt: epochOrNull(isoToEpoch(raw.addedAt)) ?? 0,
    lastSeenAt: epochOrNull(isoToEpoch(raw.lastSeenAt)) ?? 0,
    current: raw.id === deviceId,
  };
}

function sanitizeDevices(raw, deviceId) {
  return (Array.isArray(raw) ? raw : []).slice(0, 50).map((entry) => sanitizeDevice(entry, deviceId)).filter(Boolean);
}

function sanitizeLimit(value) {
  return Number.isSafeInteger(value) && value >= 1 && value <= 100 ? value : DEFAULT_DEVICE_LIMIT;
}

function sanitizeAccount(raw) {
  if (!isObject(raw) || typeof raw.id !== 'string' || !raw.id || raw.id.length > 64) return null;
  const avatar = isObject(raw.avatar) && Number.isSafeInteger(raw.avatar.rev) && AVATAR_TYPES.includes(raw.avatar.type)
    ? { rev: raw.avatar.rev, type: raw.avatar.type } : null;
  return {
    id: raw.id,
    email: text(raw.email, 320),
    name: text(raw.name, 64),
    avatar,
    provider: oneOf(raw.provider, new Set(ACCOUNT_PROVIDERS)),
    createdAt: epochOrNull(isoToEpoch(raw.createdAt)) ?? 0,
  };
}

/** 호스팅 Rau 자격과 이번 기간의 크레딧. 자격이 없으면 사용량은 모두 null 이다. */
function sanitizeRau(raw) {
  if (!isObject(raw) || raw.eligible !== true) return { ...NO_RAU };
  return {
    eligible: true,
    source: oneOf(raw.source, RAU_SOURCES),
    remainingPercent: remainingPercentFrom(raw),
    resetsAt: epochOrNull(isoToEpoch(raw.resetsAt)),
  };
}

function sanitizePlan(raw) {
  if (!isObject(raw)) return { ...FREE_PLAN, rau: { ...NO_RAU } };
  return {
    tier: oneOf(raw.tier, TIERS) ?? 'free',
    edition: oneOf(raw.edition, EDITIONS),
    plan: oneOf(raw.plan, PLANS),
    expiresAt: epochOrNull(raw.expiresAt),
    autoRenew: boolOrNull(raw.autoRenew),
    paymentFailed: raw.paymentFailed === true,
    paymentGraceEndsAt: epochOrNull(raw.paymentGraceEndsAt),
    manageUrl: grobleUrlFrom(raw.manageUrl),
    rau: sanitizeRau(raw.rau),
  };
}

/** Rau 체험. 서버가 보내지 않으면 null(예전 서버). */
function sanitizeTrial(raw) {
  if (!isObject(raw)) return null;
  const days = Number.isSafeInteger(raw.days) && raw.days > 0 && raw.days <= 366 ? raw.days : RAU_TRIAL_DAYS;
  return {
    state: oneOf(raw.state, TRIAL_STATES) ?? 'ended',
    startedAt: epochOrNull(isoToEpoch(raw.startedAt)),
    endsAt: epochOrNull(isoToEpoch(raw.endsAt)),
    days,
  };
}

function sanitizeLicense(raw) {
  if (!isObject(raw) || typeof raw.keyId !== 'string' || !raw.keyId) return null;
  return {
    keyId: raw.keyId.slice(0, 64),
    maskedKey: text(raw.maskedKey, 64),
    tier: raw.tier === 'beta' ? 'beta' : 'paid',
    edition: oneOf(raw.edition, EDITIONS),
    plan: oneOf(raw.plan, PLANS),
    status: oneOf(raw.status, LICENSE_STATUSES) ?? 'expired',
    expiresAt: epochOrNull(raw.expiresAt),
    autoRenew: boolOrNull(raw.autoRenew),
    primary: raw.primary === true,
  };
}

function sanitizeStats(raw) {
  if (!isObject(raw)) return null;
  return {
    agentSessions: count(raw.agentSessions),
    documentsEdited: count(raw.documentsEdited),
    since: epochOrNull(isoToEpoch(raw.since)),
  };
}

/** 서버의 accountPayload(또는 저장한 값)를 상태에 둘 모양으로 다듬는다. 계정이 없으면 null. */
function sanitizeView(raw, deviceId) {
  if (!isObject(raw)) return null;
  const account = sanitizeAccount(raw.account);
  if (!account) return null;
  return {
    account,
    plan: sanitizePlan(raw.plan),
    licenses: (Array.isArray(raw.licenses) ? raw.licenses : []).slice(0, 50).map(sanitizeLicense).filter(Boolean),
    devices: sanitizeDevices(raw.devices, deviceId),
    deviceLimit: sanitizeLimit(raw.deviceLimit),
    stats: sanitizeStats(raw.stats),
    trial: sanitizeTrial(raw.trial),
  };
}

function emptyActivity() {
  return {
    accountId: null,
    seen: { agent_session: [], document_edited: [] },
    queued: { agentSessions: 0, documentsEdited: 0 },
    outbox: null,
  };
}

function emptyState() {
  return {
    v: 1,
    deviceId: randomUUID(),
    maxSeenAt: 0,
    available: true,
    providers: [...DEFAULT_PROVIDERS],
    session: null,
    accountId: null,
    lease: null,
    view: null,
    lastSyncAt: null,
    avatar: null,
    activity: emptyActivity(),
    localKey: null,
    migratedKeyHash: null,
  };
}

const HASH_RE = /^[0-9a-f]{24}$/;
const BATCH_RE = /^[A-Za-z0-9_-]{8,64}$/;

function sanitizeActivity(raw) {
  const activity = emptyActivity();
  if (!isObject(raw)) return activity;
  activity.accountId = typeof raw.accountId === 'string' ? raw.accountId : null;
  for (const kind of Object.keys(ACTIVITY_KINDS)) {
    const list = Array.isArray(raw.seen?.[kind]) ? raw.seen[kind] : [];
    activity.seen[kind] = list.filter((hash) => typeof hash === 'string' && HASH_RE.test(hash)).slice(-ACTIVITY_DEDUPE_LIMIT);
  }
  activity.queued = { agentSessions: count(raw.queued?.agentSessions), documentsEdited: count(raw.queued?.documentsEdited) };
  const outbox = raw.outbox;
  if (isObject(outbox) && typeof outbox.batchId === 'string' && BATCH_RE.test(outbox.batchId)) {
    activity.outbox = {
      batchId: outbox.batchId,
      agentSessions: Math.min(MAX_STAT_BATCH, count(outbox.agentSessions)),
      documentsEdited: Math.min(MAX_STAT_BATCH, count(outbox.documentsEdited)),
    };
  }
  return activity;
}

function sanitizeState(raw) {
  const state = emptyState();
  if (!isObject(raw) || raw.v !== 1) return state;
  if (typeof raw.deviceId === 'string' && DEVICE_ID_RE.test(raw.deviceId)) state.deviceId = raw.deviceId;
  if (Number.isSafeInteger(raw.maxSeenAt) && raw.maxSeenAt > 0) state.maxSeenAt = raw.maxSeenAt;
  state.available = raw.available !== false;
  if (Array.isArray(raw.providers)) {
    const providers = raw.providers.filter((id) => ACCOUNT_PROVIDERS.includes(id));
    if (providers.length > 0) state.providers = [...new Set(providers)];
  }
  const session = raw.session;
  const view = sanitizeView(raw.view, state.deviceId);
  if (isObject(session) && (session.enc === 'safe' || session.enc === 'plain') && typeof session.value === 'string'
    && session.value && typeof raw.accountId === 'string' && view?.account.id === raw.accountId) {
    state.session = { enc: session.enc, value: session.value };
    state.accountId = raw.accountId;
    state.view = view;
    state.lease = typeof raw.lease === 'string' && raw.lease.length <= 4096 ? raw.lease : null;
    state.lastSyncAt = epochOrNull(raw.lastSyncAt);
    if (isObject(raw.avatar) && Number.isSafeInteger(raw.avatar.rev) && AVATAR_TYPES.includes(raw.avatar.type)) {
      state.avatar = { rev: raw.avatar.rev, type: raw.avatar.type };
    }
    const localKey = raw.localKey;
    if (isObject(localKey) && localKey.accountId === raw.accountId && typeof localKey.keyHash === 'string'
      && ['pending', 'linked', 'linked_elsewhere', 'invalid'].includes(localKey.state)) {
      state.localKey = {
        accountId: localKey.accountId,
        keyHash: localKey.keyHash,
        maskedKey: text(localKey.maskedKey, 64),
        state: localKey.state,
        attemptedAt: count(localKey.attemptedAt),
      };
    }
    state.migratedKeyHash = typeof raw.migratedKeyHash === 'string' ? raw.migratedKeyHash : null;
  }
  state.activity = sanitizeActivity(raw.activity);
  return state;
}

function activityHash(id) {
  return createHash('sha256').update(id, 'utf8').digest('hex').slice(0, 24);
}

function pkcePair() {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier, 'ascii').digest('base64url');
  return { verifier, challenge };
}

function sameSecret(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

/** 사진 파일의 앞 바이트가 형식과 맞는지 본다. 서버도 같은 확인을 한다. */
export function avatarMagicMatches(bytes, type) {
  if (type === 'image/jpeg') return bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (type === 'image/png') return bytes.length > 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (type === 'image/webp') return bytes.length > 12 && bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP';
  return false;
}

export function accountStatePath(userDataDir) {
  return join(String(userDataDir), ACCOUNT_STATE_FILE);
}

export function accountAvatarPath(userDataDir) {
  return join(String(userDataDir), ACCOUNT_AVATAR_FILE);
}

export function createAccountManager({
  statePath,
  avatarPath = join(dirname(String(statePath)), ACCOUNT_AVATAR_FILE),
  client,
  publicKeys = PRODUCTION_LICENSE_PUBLIC_KEYS,
  safeStorage = null,
  /** Electron 의 safeStorage 는 app 이 준비된 뒤에만 쓸 수 있다. 상태 파일은 이 약속 뒤에 읽는다. */
  whenReady = Promise.resolve(),
  licenseManager = null,
  appVersion = '0.0.0',
  platform = process.platform,
  deviceName = () => '',
  openExternal = async () => {},
  now = Date.now,
  timers = { setTimeout, clearTimeout, setInterval, clearInterval },
  fs = { mkdir, readFile, rename, rm, writeFile },
  onChange = () => {},
  /** 호스팅 기능에 줄 lease(currentLease)가 바뀌면 부른다. */
  onLeaseChange = () => {},
  log = console,
} = {}) {
  let state = null;
  let loading = null;
  /** 풀어 둔 세션 토큰. 메모리에만 있다. */
  let sessionToken = null;
  let queue = Promise.resolve();
  let flow = null;
  let lastError = null;
  let offline = false;
  let syncError = null;
  /** 탈퇴가 구독 때문에 거절됐을 때 서버가 준 구독 관리 주소. */
  let manageUrlHint = null;
  let lastRefreshAttemptAt = 0;
  let lastFlushAt = 0;
  let lastMigrationCheckAt = 0;
  let tickTimer = null;
  let stopped = true;
  let persistedBody = null;
  let notifiedStatus = null;
  let notifiedLease;

  function serialize(task) {
    const next = queue.then(task);
    queue = next.catch(() => {});
    return next;
  }

  /** 시계를 되돌려 lease 를 늘리지 못하게, 본 적 있는 가장 늦은 시각을 쓴다. */
  function clock() {
    const t = now();
    if (state && t > state.maxSeenAt) state.maxSeenAt = t;
    return Math.max(t, state?.maxSeenAt ?? 0);
  }

  async function writeAtomic(path, data) {
    const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
    await fs.mkdir(dirname(path), { recursive: true });
    try {
      await fs.writeFile(temp, data, { mode: 0o600 });
      await fs.rename(temp, path);
    } catch (error) {
      await fs.rm(temp, { force: true }).catch(() => {});
      throw error;
    }
  }

  async function persist() {
    const body = `${JSON.stringify(state, null, 2)}\n`;
    if (body === persistedBody) return;
    await writeAtomic(statePath, body);
    persistedBody = body;
  }

  /** 기록 실패로 요청 결과를 바꾸지 않는다. 다음 쓰기에서 다시 쓴다. */
  async function persistSoft() {
    await persist().catch((error) => log.warn?.('[account] state write failed:', error?.code ?? error?.message ?? error));
  }

  function encryptSession(token) {
    try {
      if (safeStorage?.isEncryptionAvailable?.()) {
        return { enc: 'safe', value: Buffer.from(safeStorage.encryptString(token)).toString('base64') };
      }
    } catch (error) {
      log.warn?.('[account] session encryption failed; storing it unencrypted:', error?.message ?? error);
    }
    return { enc: 'plain', value: token };
  }

  function decryptSession(stored) {
    if (stored.enc === 'plain') return stored.value;
    if (!safeStorage?.isEncryptionAvailable?.()) throw new Error('encryption unavailable');
    return safeStorage.decryptString(Buffer.from(stored.value, 'base64'));
  }

  async function loadOnce() {
    await whenReady;
    let raw = null;
    try {
      raw = JSON.parse(await fs.readFile(statePath, 'utf8'));
    } catch (error) {
      if (error?.code !== 'ENOENT') log.warn?.('[account] state unreadable, starting fresh:', error?.code ?? error?.name ?? 'error');
    }
    const next = sanitizeState(raw);
    sessionToken = null;
    if (next.session) {
      try {
        const token = decryptSession(next.session);
        if (!SESSION_RE.test(token)) throw new Error('unexpected session format');
        sessionToken = token;
      } catch (error) {
        log.warn?.('[account] stored session could not be read; signed out:', error?.message ?? 'error');
        syncError = 'session_unreadable';
      }
    }
    state = next;
    if (!sessionToken) clearAccount();
    clock();
    await persist();
  }

  async function load() {
    if (state) return;
    loading ??= loadOnce().finally(() => { loading = null; });
    await loading;
  }

  const signedIn = () => Boolean(state && sessionToken && state.accountId && state.view);

  function verifiedLease(t = clock()) {
    if (!signedIn() || !state.lease) return null;
    const result = verifyAccountLease(state.lease, { publicKeys, deviceId: state.deviceId, accountId: state.accountId, now: t });
    return result.ok ? result.payload : null;
  }

  function hostedLease() {
    const payload = verifiedLease();
    return payload && payload.tier !== 'free' ? state.lease : null;
  }

  function errorView(code) {
    return { code, message: accountErrorMessage(code) };
  }

  function computeStatus() {
    const view = signedIn() ? state.view : null;
    let value = 'signed_out';
    if (flow?.deviceChoice) value = 'choose_device';
    else if (flow) value = 'signing_in';
    else if (view) value = 'signed_in';
    const localKey = view && state.localKey?.accountId === state.accountId
      ? { maskedKey: state.localKey.maskedKey, state: state.localKey.state } : null;
    return {
      available: state.available,
      state: value,
      providers: [...state.providers],
      signIn: flow ? { provider: flow.provider, startedAt: flow.startedAt, intent: flow.intent } : null,
      lastError,
      deviceChoice: flow?.deviceChoice ? { limit: flow.deviceChoice.limit, devices: flow.deviceChoice.devices.map((d) => ({ ...d })) } : null,
      account: view ? {
        id: view.account.id,
        email: view.account.email,
        name: view.account.name,
        avatarRev: view.account.avatar?.rev ?? null,
        provider: view.account.provider,
        createdAt: view.account.createdAt,
      } : null,
      plan: view ? { ...view.plan, rau: { ...view.plan.rau } } : { ...FREE_PLAN, rau: { ...NO_RAU } },
      trial: view?.trial ? { ...view.trial } : null,
      licenses: view ? view.licenses.map((license) => ({ ...license })) : [],
      devices: view ? view.devices.map((device) => ({ ...device })) : [],
      deviceLimit: view?.deviceLimit ?? DEFAULT_DEVICE_LIMIT,
      stats: view?.stats ? { ...view.stats } : null,
      sync: { lastSyncAt: view ? state.lastSyncAt : null, offline: view ? offline : false, error: syncError },
      localKey,
    };
  }

  function changed() {
    const status = computeStatus();
    const fingerprint = JSON.stringify(status);
    if (fingerprint !== notifiedStatus) {
      notifiedStatus = fingerprint;
      try { onChange(status); } catch (error) { log.warn?.('[account] change listener failed:', error); }
    }
    const lease = hostedLease();
    if (lease !== notifiedLease) {
      notifiedLease = lease;
      try { onLeaseChange(lease); } catch (error) { log.warn?.('[account] lease listener failed:', error); }
    }
    return status;
  }

  function okResult(extra = {}) {
    return { ok: true, ...extra, status: changed() };
  }

  /** 사용자가 한 일의 실패. lastError 에 남긴다. */
  function failResult(code) {
    lastError = errorView(code);
    return { ok: false, code, message: lastError.message, status: changed() };
  }

  function codeOf(error) {
    return error instanceof AccountServerError ? error.code : 'server';
  }

  /** 이 기기의 계정 정보를 지운다. 기기 id 와 사용 기록의 중복 확인 목록은 남긴다. */
  function clearAccount() {
    sessionToken = null;
    state.session = null;
    state.accountId = null;
    state.lease = null;
    state.view = null;
    state.lastSyncAt = null;
    state.localKey = null;
    state.migratedKeyHash = null;
    state.activity.queued = { agentSessions: 0, documentsEdited: 0 };
    state.activity.outbox = null;
    offline = false;
    manageUrlHint = null;
    if (state.avatar) state.avatar = null;
  }

  async function localSignOut(code = null) {
    clearAccount();
    await fs.rm(avatarPath, { force: true }).catch(() => {});
    if (code) lastError = errorView(code);
    await persistSoft();
    log.info?.(`[account] signed out on this device${code ? ` (${code})` : ''}`);
  }

  /** 서버의 accountPayload 를 받아 들인다. lease 는 확인한 것만 둔다. */
  function acceptPayload(body, session = null) {
    const view = sanitizeView(body, state.deviceId);
    if (!view) throw new AccountServerError('server');
    const t = clock();
    if (state.accountId && state.accountId !== view.account.id) {
      // 다른 계정이다. 앞 계정의 사진과 키 연결 기록을 넘겨받지 않는다.
      state.avatar = null;
      state.localKey = null;
      state.migratedKeyHash = null;
      state.activity.queued = { agentSessions: 0, documentsEdited: 0 };
      state.activity.outbox = null;
    }
    if (session) {
      sessionToken = session;
      state.session = encryptSession(session);
    }
    state.accountId = view.account.id;
    state.view = view;
    state.lastSyncAt = t;
    state.available = true;
    offline = false;
    const lease = verifyAccountLease(body.lease, { publicKeys, deviceId: state.deviceId, accountId: view.account.id, now: t });
    if (lease.ok) {
      state.lease = body.lease;
      syncError = null;
    } else {
      log.warn?.('[account] server lease rejected:', lease.reason);
      state.lease = null;
      syncError = 'bad_lease';
    }
    if (state.activity.accountId !== view.account.id) {
      state.activity = { ...emptyActivity(), accountId: view.account.id };
    }
  }

  /** 서버의 사진 rev 가 받아 둔 것과 다르면 다시 받는다. 실패하면 가진 것을 그대로 쓴다. */
  async function syncAvatar() {
    if (!signedIn()) return;
    const wanted = state.view.account.avatar;
    if (!wanted) {
      if (state.avatar) {
        state.avatar = null;
        await fs.rm(avatarPath, { force: true }).catch(() => {});
      }
      return;
    }
    if (state.avatar?.rev === wanted.rev) return;
    try {
      const picture = await client.fetchAvatar(sessionToken);
      if (!picture) {
        state.avatar = null;
        await fs.rm(avatarPath, { force: true }).catch(() => {});
        return;
      }
      const type = AVATAR_TYPES.includes(picture.type) ? picture.type : wanted.type;
      if (picture.bytes.length > AVATAR_MAX_BYTES || !avatarMagicMatches(picture.bytes, type)) {
        log.warn?.('[account] avatar download rejected');
        return;
      }
      await writeAtomic(avatarPath, picture.bytes);
      state.avatar = { rev: picture.rev ?? wanted.rev, type };
    } catch (error) {
      log.warn?.('[account] avatar download failed:', codeOf(error));
    }
  }

  async function syncProviders() {
    try {
      const body = await client.providers();
      const providers = (Array.isArray(body.providers) ? body.providers : []).filter((id) => ACCOUNT_PROVIDERS.includes(id));
      state.providers = [...new Set(providers)];
      state.available = true;
    } catch (error) {
      if (codeOf(error) === 'accounts_not_configured') state.available = false;
    }
  }

  /** 서버에 다시 묻는다. 큐 안에서 부른다. 실패 코드(없으면 null)를 돌려준다. */
  async function refreshInside() {
    lastRefreshAttemptAt = clock();
    if (!signedIn()) {
      await syncProviders();
      return null;
    }
    try {
      acceptPayload(await client.refresh(sessionToken, { appVersion }));
      await syncAvatar();
      return null;
    } catch (error) {
      const code = codeOf(error);
      if (code === 'session_invalid') await localSignOut('session_invalid');
      else if (code === 'accounts_not_configured') state.available = false;
      else {
        offline = true;
        if (code !== 'network') log.warn?.('[account] refresh failed:', code);
      }
      return code;
    }
  }

  function deviceInfo() {
    return {
      id: state.deviceId,
      name: sanitizeDeviceName(typeof deviceName === 'function' ? deviceName() : ''),
      platform: String(platform).slice(0, 16),
      appVersion: String(appVersion).slice(0, 32),
    };
  }

  // ── 로그인 ──────────────────────────────────────────────────────────────
  function closeLoopback(current) {
    const server = current?.server;
    if (!server) return;
    current.server = null;
    // 새 연결을 받지 않는다. 답을 쓰는 중인 요청은 끝까지 쓰고(Connection: close) 닫힌다.
    server.close(() => {});
    server.closeIdleConnections?.();
  }

  /** 로그인을 끝낸다. code 가 있으면 실패로 남긴다. */
  function endFlow(current, code = null) {
    if (!current || flow !== current) return;
    flow = null;
    if (current.timer !== null) timers.clearTimeout(current.timer);
    current.timer = null;
    current.grant = null;
    current.verifier = null;
    closeLoopback(current);
    if (code) {
      lastError = errorView(code);
      log.info?.(`[account] sign-in ended: ${code}`);
    }
    changed();
  }

  function sendPage(res, ok, statusCode = 200) {
    if (res.headersSent) return;
    res.writeHead(statusCode, PAGE_HEADERS);
    res.end(ok ? LOOPBACK_SUCCESS_PAGE : LOOPBACK_FAILURE_PAGE);
  }

  async function handleCallback(current, req, res) {
    let url;
    try {
      url = new URL(req.url ?? '/', 'http://127.0.0.1');
    } catch {
      url = null;
    }
    if (req.method !== 'GET' || url?.pathname !== '/auth/callback') {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'close' });
      res.end('Not found');
      return;
    }
    if (flow !== current || current.accepted || !sameSecret(url.searchParams.get('state'), current.appState)) {
      sendPage(res, false, 400);
      return;
    }
    current.accepted = true;
    const code = url.searchParams.get('code');
    const error = url.searchParams.get('error');
    if (error || !code) {
      sendPage(res, false);
      closeLoopback(current);
      endFlow(current, error === 'auth_cancelled' ? 'auth_cancelled' : 'auth_failed');
      return;
    }
    let outcome;
    try {
      outcome = await exchange(current, { code: code.slice(0, 512), verifier: current.verifier }, { retryable: false });
    } catch {
      outcome = { ok: false, code: 'auth_failed' };
    }
    sendPage(res, outcome.ok || outcome.code === 'device_limit');
    closeLoopback(current);
  }

  function openLoopback(current) {
    return new Promise((resolve, reject) => {
      const server = createServer((req, res) => {
        void handleCallback(current, req, res).catch(() => {
          try { sendPage(res, false, 500); } catch { /* 닫힌 연결 */ }
        });
      });
      server.headersTimeout = 10_000;
      server.requestTimeout = 30_000;
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        server.on('error', (error) => log.warn?.('[account] loopback error:', error?.code ?? 'error'));
        server.unref?.();
        resolve(server);
      });
    });
  }

  /** 로그인 코드를 세션으로 바꾼다. 큐 안에서 돈다. */
  function exchange(current, { code, verifier, replaceDeviceId = null }, { retryable }) {
    return serialize(async () => {
      await load();
      if (flow !== current) return { ok: false, code: 'auth_cancelled' };
      let body;
      try {
        body = await client.token({ code, verifier, device: deviceInfo(), replaceDeviceId });
        if (typeof body.session !== 'string' || !SESSION_RE.test(body.session)) throw new AccountServerError('server');
      } catch (error) {
        if (flow !== current) return { ok: false, code: 'auth_cancelled' };
        const failure = codeOf(error);
        if (failure === 'device_limit') {
          // 고른 기기를 빼고 같은 코드로 다시 받는다. 코드와 verifier 는 메모리에만 둔다.
          current.grant = { code, verifier };
          current.deviceChoice = {
            limit: sanitizeLimit(error.extra?.limit),
            devices: sanitizeDevices(error.extra?.devices, state.deviceId),
          };
          changed();
          return { ok: false, code: 'device_limit' };
        }
        if (retryable && RETRYABLE_TOKEN_CODES.has(failure)) {
          lastError = errorView(failure);
          changed();
          return { ok: false, code: failure };
        }
        endFlow(current, failure === 'network' || failure === 'grant_invalid' || failure === 'rate_limited' ? failure : 'auth_failed');
        return { ok: false, code: lastError?.code ?? failure };
      }
      if (flow !== current) return { ok: false, code: 'auth_cancelled' };
      acceptPayload(body, body.session);
      lastError = null;
      syncError = null;
      await syncAvatar();
      await persistSoft();
      endFlow(current, null);
      log.info?.('[account] signed in');
      // 로그인 직후 예전 키를 계정에 연결한다. 첫 사용 기록은 다음 확인 때 바로 보낸다.
      lastFlushAt = 0;
      void migrateLocalKey({ force: true }).catch((error) => log.warn?.('[account] key migration failed:', error?.message ?? error));
      changed();
      return { ok: true };
    });
  }

  /** intent 'sign_up' 은 서버가 AuthKit 의 가입 화면으로 연다. 그 밖에는 로그인과 같다. */
  async function signIn(provider, loginHint, intent) {
    await serialize(load);
    if (!ACCOUNT_PROVIDERS.includes(provider) || !state.providers.includes(provider)) return failResult('invalid');
    if (signedIn()) return failResult('already_signed_in');
    if (!state.available) return failResult('accounts_not_configured');
    const hint = typeof loginHint === 'string' ? loginHint.trim().slice(0, 254) : '';
    // 한 번에 하나만: 앞의 로그인은 그만둔다.
    endFlow(flow, null);
    const { verifier, challenge } = pkcePair();
    const current = {
      provider,
      intent: intent === 'sign_up' ? 'sign_up' : 'sign_in',
      startedAt: clock(),
      verifier,
      appState: randomBytes(24).toString('base64url'),
      server: null,
      timer: null,
      accepted: false,
      grant: null,
      deviceChoice: null,
    };
    flow = current;
    lastError = null;
    current.timer = timers.setTimeout(() => endFlow(current, 'auth_timeout'), SIGN_IN_TIMEOUT_MS);
    current.timer?.unref?.();
    changed();
    let port;
    try {
      current.server = await openLoopback(current);
      port = current.server.address().port;
    } catch (error) {
      log.warn?.('[account] loopback failed to start:', error?.code ?? 'error');
      if (flow === current) endFlow(current, 'auth_failed');
      return { ok: false, code: 'auth_failed', message: accountErrorMessage('auth_failed'), status: computeStatus() };
    }
    if (flow !== current) {
      closeLoopback(current);
      return { ok: false, code: 'auth_cancelled', message: accountErrorMessage('auth_cancelled'), status: computeStatus() };
    }
    let url;
    try {
      const answer = await client.start({
        provider, challenge, port, state: current.appState, ...(provider === 'email' && hint ? { loginHint: hint } : {}),
        ...(current.intent === 'sign_up' ? { intent: 'sign_up' } : {}),
      });
      if (typeof answer.url !== 'string' || !answer.url) throw new AccountServerError('server');
      url = answer.url;
    } catch (error) {
      const failure = codeOf(error);
      if (failure === 'accounts_not_configured') state.available = false;
      // 형식 오류나 꺼진 로그인 수단은 사용자가 고칠 수 없다. 로그인 실패로 보인다.
      const code = failure === 'invalid' || failure === 'provider_unavailable' ? 'auth_failed' : failure;
      if (flow === current) endFlow(current, code);
      return { ok: false, code, message: accountErrorMessage(code), status: computeStatus() };
    }
    if (flow !== current) {
      return { ok: false, code: 'auth_cancelled', message: accountErrorMessage('auth_cancelled'), status: computeStatus() };
    }
    try {
      await openExternal(url);
    } catch (error) {
      log.warn?.('[account] browser failed to open:', error?.message ?? 'error');
      if (flow === current) endFlow(current, 'browser_failed');
      return { ok: false, code: 'browser_failed', message: accountErrorMessage('browser_failed'), status: computeStatus() };
    }
    log.info?.(`[account] sign-in started (${provider})`);
    return { ok: true, status: computeStatus() };
  }

  async function cancelSignIn() {
    await serialize(load);
    endFlow(flow, null);
    return changed();
  }

  async function replaceDevice(deviceId) {
    await serialize(load);
    const current = flow;
    if (!current?.deviceChoice || !current.grant) return failResult('invalid');
    if (typeof deviceId !== 'string' || !current.deviceChoice.devices.some((device) => device.id === deviceId)) {
      return failResult('device_not_found');
    }
    const grant = current.grant;
    let outcome = await exchange(current, { ...grant, replaceDeviceId: deviceId }, { retryable: true });
    if (outcome.code === 'device_not_found' && flow === current) {
      // 다른 곳에서 이미 뺀 기기다. 자리가 났을 수 있으니 기기를 빼지 않고 한 번 더 받는다.
      const retry = await exchange(current, grant, { retryable: true });
      if (retry.ok) outcome = retry;
      else if (retry.code !== 'device_limit') outcome = retry;
    }
    if (outcome.ok) return okResult();
    return { ok: false, code: outcome.code, message: accountErrorMessage(outcome.code), status: changed() };
  }

  // ── 세션 요청 ────────────────────────────────────────────────────────────
  /** 로그인한 상태에서 서버에 요청하고, 성공하면 다시 묻는다(refreshAfter). 큐 안에서 돈다. */
  function sessionAction(run, { refreshAfter = true } = {}) {
    return serialize(async () => {
      await load();
      if (!signedIn()) return failResult('sign_in_required');
      let extra;
      try {
        extra = await run(sessionToken);
      } catch (error) {
        const code = codeOf(error);
        if (code === 'session_invalid') await localSignOut();
        else if (code === 'accounts_not_configured') state.available = false;
        else if (code === 'network') offline = true;
        if (code === 'subscription_active') manageUrlHint = grobleUrlFrom(error.extra?.manageUrl);
        await persistSoft();
        return failResult(code);
      }
      lastError = null;
      if (refreshAfter && signedIn()) await refreshInside();
      await persistSoft();
      return okResult(extra ?? {});
    });
  }

  async function refresh() {
    const result = await serialize(async () => {
      await load();
      const failure = await refreshInside();
      await persistSoft();
      if (failure) return failResult(failure);
      lastError = null;
      return okResult();
    });
    if (result.ok) afterSync();
    return result;
  }

  /** 정기 확인과 실행 때의 확인. 실패를 lastError 에 남기지 않는다(세션 거절은 남긴다). */
  function backgroundRefresh() {
    return serialize(async () => {
      await load();
      const failure = await refreshInside();
      await persistSoft();
      changed();
      return failure;
    }).then((failure) => {
      if (!failure) afterSync();
      return failure;
    });
  }

  /** 서버에 닿은 뒤 미뤄 둔 일을 한다. */
  function afterSync() {
    if (!signedIn()) return;
    void migrateLocalKey().catch((error) => log.warn?.('[account] key migration failed:', error?.message ?? error));
    if (hasActivity() && clock() - lastFlushAt >= ACTIVITY_FLUSH_MS) {
      void flushActivity().catch((error) => log.warn?.('[account] activity flush failed:', error?.message ?? error));
    }
  }

  async function signOut() {
    await flushActivity().catch(() => false);
    return serialize(async () => {
      await load();
      if (!signedIn()) {
        lastError = null;
        return okResult();
      }
      try {
        await client.signOut(sessionToken);
      } catch (error) {
        // 서버에 닿지 못해도 이 기기는 로그아웃한다. 같은 기기 id 로 다시 로그인하면 그 자리를 다시 쓴다.
        const code = codeOf(error);
        if (code !== 'session_invalid') log.warn?.('[account] server sign-out failed:', code);
      }
      await localSignOut();
      lastError = null;
      return okResult();
    });
  }

  async function removeDevice(deviceId) {
    if (typeof deviceId !== 'string' || !SERVER_DEVICE_ID_RE.test(deviceId)) {
      await serialize(load);
      return failResult('device_not_found');
    }
    return sessionAction(async (session) => {
      const body = await client.removeDevice(session, deviceId);
      // 이 기기를 뺐으면 서버가 세션도 지웠다.
      if (body.signedOut === true) await localSignOut();
    });
  }

  async function updateName(name) {
    const value = typeof name === 'string' ? name.replace(CONTROL_RE, '').trim() : '';
    if ([...value].length < 1 || [...value].length > 30) {
      await serialize(load);
      return failResult('name_invalid');
    }
    return sessionAction(async (session) => {
      const body = await client.updateProfile(session, { name: value });
      const account = sanitizeAccount(body.account);
      if (account && state.view && account.id === state.view.account.id) state.view.account = account;
    });
  }

  async function setAvatar(bytes, type) {
    const buffer = Buffer.isBuffer(bytes) ? bytes
      : bytes instanceof Uint8Array ? Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
        : bytes instanceof ArrayBuffer ? Buffer.from(bytes) : null;
    const reject = async (code) => {
      await serialize(load);
      return failResult(code);
    };
    if (!buffer) return reject('unsupported_type');
    if (buffer.length > AVATAR_MAX_BYTES) return reject('too_large');
    if (!AVATAR_TYPES.includes(type) || !avatarMagicMatches(buffer, type)) return reject('unsupported_type');
    const copy = Buffer.from(buffer);
    return sessionAction(async (session) => {
      const body = await client.uploadAvatar(session, copy, type);
      const rev = body.avatar?.rev;
      if (Number.isSafeInteger(rev)) {
        await writeAtomic(avatarPath, copy);
        state.avatar = { rev, type };
        if (state.view) state.view.account.avatar = { rev, type };
      }
    });
  }

  async function removeAvatar() {
    return sessionAction(async (session) => {
      await client.removeAvatar(session);
      state.avatar = null;
      if (state.view) state.view.account.avatar = null;
      await fs.rm(avatarPath, { force: true }).catch(() => {});
    });
  }

  async function getAvatar() {
    await serialize(load);
    if (!signedIn() || !state.avatar) return null;
    try {
      const bytes = await fs.readFile(avatarPath);
      if (bytes.length === 0 || bytes.length > AVATAR_MAX_BYTES) return null;
      return `data:${state.avatar.type};base64,${Buffer.from(bytes).toString('base64')}`;
    } catch {
      return null;
    }
  }

  /** 받은 accountPayload 를 그대로 쓴다(따로 다시 묻지 않는다). */
  function linkAction(run) {
    return sessionAction(async (session) => {
      const body = await run(session);
      acceptPayload(body);
      await syncAvatar();
      return { alreadyLinked: body.alreadyLinked === true || body.alreadyRedeemed === true };
    }, { refreshAfter: false });
  }

  async function redeem(rawKey) {
    const code = normalizeGiftCode(rawKey);
    if (code) return linkAction((session) => client.redeemGiftCode(session, code));
    const key = normalizeLicenseKey(rawKey);
    if (!key) {
      await serialize(load);
      return failResult('invalid_format');
    }
    const result = await linkAction((session) => client.redeem(session, key));
    if (result.ok) {
      await serialize(async () => {
        // 이 기기의 예전 키를 직접 넣었으면 연결된 것으로 본다.
        const hash = licenseKeyHash(key);
        if (state.localKey?.accountId === state.accountId && state.localKey.keyHash === hash) {
          state.localKey.state = 'linked';
          state.migratedKeyHash = hash;
          await persistSoft();
        }
      });
      return { ...result, status: changed() };
    }
    return result;
  }

  async function claim(orderId, email) {
    const order = typeof orderId === 'string' ? orderId.trim().slice(0, 128) : '';
    const address = typeof email === 'string' ? email.trim().slice(0, 254) : '';
    if (!order || !address) {
      await serialize(load);
      return failResult('order_not_found');
    }
    return linkAction((session) => client.claim(session, { orderId: order, email: address }));
  }

  /** Rau 체험을 시작한다. 서버가 계정마다 한 번만 열고, 받은 accountPayload(체험 active)를 그대로 쓴다. */
  function startRauTrial() {
    return sessionAction(async (session) => {
      acceptPayload(await client.rauTrial(session));
    }, { refreshAfter: false });
  }

  async function deleteAccount(confirm) {
    const typed = typeof confirm === 'string' ? confirm.trim().slice(0, 320) : '';
    return serialize(async () => {
      await load();
      if (!signedIn()) return failResult('sign_in_required');
      if (!typed || typed.toLowerCase() !== state.view.account.email.trim().toLowerCase()) return failResult('confirm_mismatch');
      try {
        await client.deleteAccount(sessionToken, typed);
      } catch (error) {
        const code = codeOf(error);
        if (code === 'subscription_active') manageUrlHint = grobleUrlFrom(error.extra?.manageUrl);
        if (code === 'session_invalid') await localSignOut();
        return failResult(code);
      }
      // 계정이 없어졌다. 사용 기록의 중복 확인 목록도 버린다.
      await localSignOut();
      state.activity = emptyActivity();
      await persistSoft();
      lastError = null;
      log.info?.('[account] account deleted');
      return okResult();
    });
  }

  async function openManage() {
    await serialize(load);
    const url = manageUrlHint ?? (signedIn() ? state.view.plan.manageUrl : null) ?? DEFAULT_PAYMENT_FIX_URL;
    try {
      await openExternal(url);
    } catch (error) {
      log.warn?.('[account] manage page failed to open:', error?.message ?? 'error');
    }
  }

  // ── 사용 기록 ────────────────────────────────────────────────────────────
  function hasActivity() {
    const activity = state?.activity;
    return Boolean(activity && (activity.outbox || activity.queued.agentSessions || activity.queued.documentsEdited));
  }

  function recordActivity(kind, id) {
    const field = Object.hasOwn(ACTIVITY_KINDS, kind) ? ACTIVITY_KINDS[kind] : null;
    if (!field || typeof id !== 'string' || !id || id.length > 512) return;
    void serialize(async () => {
      await load();
      if (!signedIn()) return;
      const activity = state.activity;
      if (activity.accountId !== state.accountId) state.activity = { ...emptyActivity(), accountId: state.accountId };
      const seen = state.activity.seen[kind];
      const hash = activityHash(id);
      const index = seen.indexOf(hash);
      if (index >= 0) {
        // 이미 센 id 다. 최근에 본 것으로만 옮긴다(파일은 다음 쓰기 때 함께 쓴다).
        seen.splice(index, 1);
        seen.push(hash);
        return;
      }
      seen.push(hash);
      if (seen.length > ACTIVITY_DEDUPE_LIMIT) seen.splice(0, seen.length - ACTIVITY_DEDUPE_LIMIT);
      state.activity.queued[field] += 1;
      await persistSoft();
    }).catch((error) => log.warn?.('[account] activity record failed:', error?.message ?? error));
  }

  /** 쌓인 사용 기록을 보낸다. 보내지 못하면 같은 묶음(batchId)을 남겨 다음에 다시 보낸다. */
  function flushActivity() {
    return serialize(async () => {
      await load();
      if (!signedIn() || !hasActivity()) return true;
      const activity = state.activity;
      if (!activity.outbox) {
        const agentSessions = Math.min(MAX_STAT_BATCH, activity.queued.agentSessions);
        const documentsEdited = Math.min(MAX_STAT_BATCH, activity.queued.documentsEdited);
        activity.queued = {
          agentSessions: activity.queued.agentSessions - agentSessions,
          documentsEdited: activity.queued.documentsEdited - documentsEdited,
        };
        activity.outbox = { batchId: randomBytes(16).toString('base64url'), agentSessions, documentsEdited };
        await persistSoft();
      }
      lastFlushAt = clock();
      const batch = activity.outbox;
      try {
        const body = await client.stats(sessionToken, batch);
        if (state.activity.outbox?.batchId === batch.batchId) state.activity.outbox = null;
        const stats = sanitizeStats(body.stats);
        if (stats && state.view?.stats) {
          state.view.stats.agentSessions = stats.agentSessions;
          state.view.stats.documentsEdited = stats.documentsEdited;
        }
        await persistSoft();
        changed();
        return true;
      } catch (error) {
        const code = codeOf(error);
        if (code === 'session_invalid') {
          await localSignOut('session_invalid');
          changed();
        } else if (error instanceof AccountServerError && error.status >= 400 && error.status < 500 && code !== 'rate_limited') {
          // 서버가 받지 않는 묶음은 버린다. 다시 보내도 같은 답이 온다.
          log.warn?.('[account] activity batch refused:', code);
          if (state.activity.outbox?.batchId === batch.batchId) state.activity.outbox = null;
          await persistSoft();
        }
        return false;
      }
    });
  }

  /** 앱을 끝낼 때. 오래 기다리지 않는다. */
  async function flushOnQuit({ timeoutMs = QUIT_FLUSH_TIMEOUT_MS } = {}) {
    let timer = null;
    const timeout = new Promise((resolve) => {
      timer = timers.setTimeout(() => resolve(false), timeoutMs);
      timer?.unref?.();
    });
    try {
      return await Promise.race([flushActivity().catch(() => false), timeout]);
    } finally {
      if (timer !== null) timers.clearTimeout(timer);
    }
  }

  // ── 예전 키 연결 ─────────────────────────────────────────────────────────
  async function migrateLocalKey({ force = false } = {}) {
    if (!licenseManager?.licenseKey) return;
    let key = null;
    try {
      key = normalizeLicenseKey(await licenseManager.licenseKey());
    } catch {
      key = null;
    }
    await serialize(async () => {
      await load();
      if (!signedIn()) return;
      if (!key) {
        if (state.localKey) {
          state.localKey = null;
          await persistSoft();
          changed();
        }
        return;
      }
      const hash = licenseKeyHash(key);
      const accountId = state.accountId;
      if (state.migratedKeyHash === hash && state.localKey?.accountId === accountId && state.localKey.keyHash === hash) return;
      let record = state.localKey;
      if (!record || record.accountId !== accountId || record.keyHash !== hash) {
        record = { accountId, keyHash: hash, maskedKey: maskKeyForAccount(key), state: 'pending', attemptedAt: 0 };
        state.localKey = record;
      }
      const wait = record.state === 'pending' ? ACCOUNT_OFFLINE_RETRY_MS : KEY_MIGRATION_RETRY_MS;
      if (!force && record.attemptedAt && clock() - record.attemptedAt < wait) return;
      record.attemptedAt = clock();
      try {
        const body = await client.redeem(sessionToken, key);
        acceptPayload(body);
        record.state = 'linked';
        state.migratedKeyHash = hash;
        log.info?.('[account] local license key linked');
      } catch (error) {
        const code = codeOf(error);
        if (code === 'key_linked_elsewhere') record.state = 'linked_elsewhere';
        else if (INVALID_KEY_CODES.has(code)) record.state = 'invalid';
        else if (code === 'session_invalid') await localSignOut('session_invalid');
        else if (code === 'network') offline = true;
        if (code !== 'network') log.info?.(`[account] local license key not linked: ${code}`);
      }
      await persistSoft();
      changed();
    });
  }

  // ── 일정 ────────────────────────────────────────────────────────────────
  function tick() {
    if (stopped || !state) return;
    const t = clock();
    const due = offline ? ACCOUNT_OFFLINE_RETRY_MS : ACCOUNT_REFRESH_INTERVAL_MS;
    if (signedIn() && t - lastRefreshAttemptAt >= due) {
      void backgroundRefresh().catch((error) => log.warn?.('[account] scheduled refresh failed:', error?.message ?? error));
      return;
    }
    if (signedIn() && hasActivity() && t - lastFlushAt >= ACTIVITY_FLUSH_MS) {
      void flushActivity().catch((error) => log.warn?.('[account] activity flush failed:', error?.message ?? error));
    }
    if (signedIn() && t - lastMigrationCheckAt >= ACCOUNT_OFFLINE_RETRY_MS) {
      lastMigrationCheckAt = t;
      void migrateLocalKey().catch(() => {});
    }
    // lease 가 끝나는 것처럼 서버에 묻지 않아도 바뀌는 것을 알린다.
    changed();
  }

  function start() {
    stopped = false;
    void (async () => {
      await serialize(load);
      await serialize(async () => {
        if (signedIn()) await syncProviders();
      });
      await backgroundRefresh();
    })().catch((error) => log.warn?.('[account] launch refresh failed:', error?.message ?? error));
    tickTimer = timers.setInterval(tick, TICK_MS);
    tickTimer?.unref?.();
  }

  function stop() {
    stopped = true;
    if (tickTimer !== null) timers.clearInterval(tickTimer);
    tickTimer = null;
    if (flow) endFlow(flow, null);
  }

  return {
    load: () => serialize(load),
    getStatus: async () => { await serialize(load); return computeStatus(); },
    signIn,
    cancelSignIn,
    replaceDevice,
    refresh,
    signOut,
    removeDevice,
    updateName,
    setAvatar,
    removeAvatar,
    getAvatar,
    redeem,
    claim,
    startRauTrial,
    deleteAccount,
    openManage,
    recordActivity,
    flushActivity,
    flushOnQuit,
    /**
     * 호스팅 기능(선물·Rau)에 줄 lease. 로그인했고, 서명·기기·계정·만료가 맞고, 무료가 아닐 때만.
     * 상태를 이미 읽었으면 진행 중인 서버 요청을 기다리지 않는다.
     */
    async currentLease() {
      if (!state) await serialize(load);
      return hostedLease();
    },
    /** 요금제가 쓰는 값. tier 는 확인한 lease 의 것(없으면 null). */
    async entitlement() {
      if (!state) await serialize(load);
      const payload = verifiedLease();
      return { signedIn: signedIn(), accountId: signedIn() ? state.accountId : null, tier: oneOf(payload?.tier, TIERS) };
    },
    /** 라이선스 관리자의 onChange 에서 부른다. 키가 바뀌었으면 계정에 연결한다. */
    licenseChanged: () => migrateLocalKey(),
    deviceId: async () => { await serialize(load); return state.deviceId; },
    start,
    stop,
  };
}
