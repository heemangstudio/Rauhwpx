import { execFile } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

/**
 * boat.dev 계정과 그 계정의 "Rauhwpx Cloud" VM 하나를 다룬다.
 * 토큰과 클레임 토큰은 이 모듈(메인 프로세스) 밖으로 나가지 않는다.
 */

export const BOAT_ORIGIN_ENV = 'RAUHWpx_BOAT_API_ORIGIN';
export const BOAT_DEFAULT_ORIGIN = 'https://boat.dev';
export const BOAT_SANDBOX_NAME = 'Rauhwpx Cloud';
export const BOAT_SSH_USER = 'user';
export const BOAT_REGION = 'EU';
export const BOAT_IDLE_STOP_MINUTES = 30;
/** Trial accounts cannot disable auto-stop or exceed two hours. */
export const BOAT_TRIAL_TTL_SECONDS = 7200;
/**
 * A VM created or resumed for setup keeps a finite auto-stop until the idle
 * timer is installed, so an abandoned setup cannot bill forever.
 */
export const BOAT_SETUP_TTL_SECONDS = 7200;
/**
 * VM이 스스로 멈출 수단(boat CLI나 ASCII_TOKEN)을 확인하지 못했을 때 켤 때마다 거는
 * boat 자동 중지. 유휴 타이머가 멈추지 못해도 요금이 끝없이 쌓이지 않는다.
 */
export const BOAT_TIMER_TTL_SECONDS = 4 * 60 * 60;
export const BOAT_MACHINES = Object.freeze({
  default: Object.freeze({ vcpu: 4, memoryGB: 8, label: '4 vCPU · 8 GB' }),
  small: Object.freeze({ vcpu: 2, memoryGB: 4, label: '2 vCPU · 4 GB' }),
});
export const BOAT_SANDBOX_ID_RE = /^bx_[a-z0-9]{8}$/;

const ACCOUNT_SECRET = 'cloud.boat.account';
const SETUP_SECRET = 'cloud.boat.setup';
const CLAIM_GRANT = 'urn:workos:agent-auth:grant-type:claim';
const JWT_BEARER_GRANT = 'urn:ietf:params:oauth:grant-type:jwt-bearer';
const MAX_RESPONSE_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 20_000;
const USABLE_STATES = new Set(['ready', 'idle', 'running']);
const STARTING_STATES = new Set(['init', 'provisioning', 'provisioned', 'cloning']);
const RETRYABLE_STATUSES = new Set([429, 502, 503, 504]);
const PIN_MARKER_PREFIX = 'rauhwpx-boat:';
const OPERATION_ID_RE = /^bdop_[a-f0-9]{32}$/;
const SSH_USER_RE = /^[a-z_][a-z0-9_-]{0,31}$/;
const HOST_RE = /^(?=.{1,253}$)(?!-)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i;
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,63}$/;
const HOST_KEY_TYPES = new Set([
  'ssh-ed25519',
  'ecdsa-sha2-nistp256',
  'ecdsa-sha2-nistp384',
  'ecdsa-sha2-nistp521',
  'ssh-rsa',
]);
const SELF_STOP_SCRIPT = '/opt/rauhwpx-cloud/current/install/boat-idle.sh';
/**
 * 설치된 유휴 스크립트의 확인 모드를 root로 부른다. 스크립트가 타이머와 같은 설정·탐색으로
 * 샌드박스 사용자의 로그인 셸을 살핀다. 확인 모드가 없는 스크립트는 실제로 멈출 수 있어 부르지 않는다.
 */
const SELF_STOP_COMMAND = [
  `f=${SELF_STOP_SCRIPT}`,
  'grep -q rauhwpx-boat-self-stop "$f" 2>/dev/null || exit 0',
  'sudo -n /bin/bash "$f" --probe 2>/dev/null',
  'exit 0',
].join('; ');
const SELF_STOP_RE = /^rauhwpx-boat-self-stop (cli|api|none)$/m;
const HOST_KEY_COMMAND = [
  'for f in /etc/ssh/ssh_host_ed25519_key.pub /etc/ssh/ssh_host_ecdsa_key.pub /etc/ssh/ssh_host_rsa_key.pub',
  'do [ -r "$f" ] && cat "$f"',
  'done',
  'exit 0',
].join('; ');

const MESSAGES = Object.freeze({
  BOAT_AUTH_INVALID: 'boat 인증이 유효하지 않습니다.',
  BOAT_API_KEY_INVALID: 'API 키가 올바르지 않습니다.',
  BOAT_BILLING_REQUIRED: 'boat 요금제가 필요합니다.',
  BOAT_RATE_LIMITED: 'boat 요청이 많습니다. 잠시 후 다시 시도할 수 있습니다.',
  BOAT_UNAVAILABLE: 'boat에 연결하지 못했습니다.',
  BOAT_SETUP_FAILED: 'boat 서버를 준비하지 못했습니다.',
  BOAT_NOT_CONNECTED: 'boat 계정이 연결되어 있지 않습니다.',
  BOAT_NOT_FOUND: 'boat 서버를 찾을 수 없습니다.',
  BOAT_SERVER_MISSING: 'boat 서버를 찾을 수 없습니다.',
  BOAT_SERVER_FAILED: 'boat 서버에 오류가 발생했습니다.',
  BOAT_SERVER_STOPPED: 'boat 서버가 정지되어 있습니다.',
  BOAT_WAKE_TIMEOUT: 'boat 서버가 제시간에 시작되지 않았습니다.',
  BOAT_FORBIDDEN: 'API 키에 필요한 권한이 없습니다.',
  BOAT_TRIAL_BLOCKED: 'boat 체험을 시작할 수 없습니다. boat 지원팀 문의가 필요합니다.',
  BOAT_CONFLICT: 'boat 서버가 다른 작업을 처리하고 있습니다.',
  BOAT_INVALID_REQUEST: 'boat가 요청을 거절했습니다.',
  BOAT_HOST_KEY_UNVERIFIED: 'boat 서버의 SSH 키를 확인하지 못했습니다.',
  BOAT_INVALID_EMAIL: '이메일 주소가 올바르지 않습니다.',
  BOAT_LINK_UNAVAILABLE: '열 수 있는 boat 링크가 없습니다.',
  BOAT_BUSY: 'boat 서버를 준비하는 중입니다.',
  BOAT_CLAIM_EXPIRED: '코드가 만료되었습니다.',
});

export class BoatError extends Error {
  constructor(code, {
    message = MESSAGES[code] ?? MESSAGES.BOAT_UNAVAILABLE,
    detail = '',
    status = 0,
    boatCode = '',
    retryable = false,
    requestId = '',
    retryAfterMs = null,
    cause,
  } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'BoatError';
    this.code = code;
    /** English diagnostic without secrets, for logs and the setup failure disclosure. */
    this.detail = String(detail || message);
    this.status = status;
    this.boatCode = boatCode;
    this.retryable = retryable;
    this.requestId = requestId;
    this.retryAfterMs = retryAfterMs;
  }
}

export function boatMessage(code) {
  return MESSAGES[code] ?? MESSAGES.BOAT_UNAVAILABLE;
}

/** 테스트는 로컬 가짜 서버를 가리킨다. 루프백이 아니면 HTTPS만 받는다. */
export function boatOrigin(env = process.env) {
  const raw = String(env?.[BOAT_ORIGIN_ENV] ?? '').trim() || BOAT_DEFAULT_ORIGIN;
  let url;
  try { url = new URL(raw); } catch { throw new Error(`${BOAT_ORIGIN_ENV} must be an absolute URL`); }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error(`${BOAT_ORIGIN_ENV} must use HTTPS`);
  }
  if (url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) {
    throw new Error(`${BOAT_ORIGIN_ENV} must be an origin`);
  }
  return url.origin;
}

function boatHost(hostname) {
  const host = String(hostname ?? '').toLowerCase();
  return host === 'boat.dev' || host.endsWith('.boat.dev') || host === 'ascii.dev' || host.endsWith('.ascii.dev');
}

/** 메인이 여는 외부 링크는 boat와, boat API가 돌려준 Stripe 결제 페이지뿐이다. */
export function isAllowedBoatLink(raw, { origin = BOAT_DEFAULT_ORIGIN, kind = '' } = {}) {
  let url;
  try { url = new URL(String(raw ?? '')); } catch { return false; }
  if (url.username || url.password) return false;
  if (url.origin === new URL(origin).origin) return true;
  if (url.protocol !== 'https:') return false;
  if (boatHost(url.hostname)) return true;
  return kind === 'checkout' && url.hostname.toLowerCase() === 'checkout.stripe.com';
}

export function boatServerState(sandboxState) {
  const state = String(sandboxState ?? '');
  if (USABLE_STATES.has(state)) return 'running';
  if (STARTING_STATES.has(state)) return 'waking';
  if (state === 'archiving') return 'stopping';
  if (state === 'archived') return 'stopped';
  if (state === 'error') return 'error';
  return 'missing';
}

export function isUsableSandboxState(state) {
  return USABLE_STATES.has(String(state ?? ''));
}

export function normalizeBoatMachine(value) {
  return value === 'small' ? 'small' : 'default';
}

export function monthStartIso(date = new Date()) {
  return new Date(date.getFullYear(), date.getMonth(), 1).toISOString();
}

export function monthHours(seconds) {
  if (seconds == null || seconds === '') return null;
  const value = Number(seconds);
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.round(value / 360) / 10;
}

export function boatHostEnv({ sandboxId, idleMinutes = BOAT_IDLE_STOP_MINUTES, user = BOAT_SSH_USER }) {
  return {
    RAUHWpx_HOST_KIND: 'boat',
    RAUHWpx_BOAT_SANDBOX_ID: sandboxId,
    RAUHWpx_BOAT_IDLE_MINUTES: String(idleMinutes),
    RAUHWpx_BOAT_USER: user,
  };
}

export function assertSandboxId(value) {
  const sandboxId = String(value ?? '');
  if (!BOAT_SANDBOX_ID_RE.test(sandboxId)) {
    throw new BoatError('BOAT_INVALID_REQUEST', { detail: 'boat sandbox id is invalid' });
  }
  return sandboxId;
}

/** Equal-jitter exponential backoff; `Retry-After` wins when the server sends one. */
export function backoffDelayMs(attempt, {
  baseMs = 500,
  capMs = 8_000,
  retryAfterMs = null,
  random = Math.random,
} = {}) {
  if (Number.isFinite(retryAfterMs) && retryAfterMs >= 0) {
    return Math.min(retryAfterMs, 30_000) + Math.floor(random() * 250);
  }
  const ceiling = Math.min(capMs, baseMs * (2 ** Math.max(0, attempt - 1)));
  return Math.floor(ceiling / 2 + random() * (ceiling / 2));
}

function retryAfterMsFrom(headers, now = Date.now()) {
  const raw = headers?.get?.('retry-after');
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
}

function errorCodeOf(body) {
  if (!body || typeof body !== 'object') return '';
  if (body.error && typeof body.error === 'object') return String(body.error.code ?? body.code ?? '');
  if (typeof body.error === 'string') return body.error;
  return String(body.code ?? '');
}

function redact(text) {
  return String(text ?? '')
    .replace(/\b(?:boat|sandbox|clm|sak)_[A-Za-z0-9_-]{6,}/g, '<redacted>')
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9._-]+/g, '<redacted>')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .slice(0, 400);
}

/** HTTP 상태와 boat 오류 봉투(ErrorEnvelope/OAuth)를 앱 오류 코드로 바꾼다. */
export function boatErrorFromResponse(status, body, { retryAfterMs = null, context = '' } = {}) {
  const envelope = body && typeof body === 'object' ? body : {};
  const nested = envelope.error && typeof envelope.error === 'object' ? envelope.error : null;
  const boatCode = errorCodeOf(envelope).trim();
  const rawMessage = redact(nested?.message ?? envelope.message ?? envelope.error_description ?? '');
  const requestId = typeof envelope.requestId === 'string' ? envelope.requestId.slice(0, 80) : '';
  const detail = `boat ${context ? `${context} ` : ''}HTTP ${status}${boatCode ? ` ${boatCode}` : ''}`
    + `${rawMessage ? `: ${rawMessage}` : ''}${requestId ? ` (${requestId})` : ''}`;
  const base = { status, boatCode, detail, requestId, retryAfterMs };
  if (boatCode === 'trial_blocked') return new BoatError('BOAT_TRIAL_BLOCKED', base);
  if (status === 401 || ['unauthorized', 'api_key_expired', 'claim_required', 'invalid_grant'].includes(boatCode)) {
    return new BoatError('BOAT_AUTH_INVALID', base);
  }
  if (status === 402 || ['billing_required', 'team_member_cap_reached', 'trial_machine_class_not_allowed']
    .includes(boatCode)) {
    return new BoatError('BOAT_BILLING_REQUIRED', base);
  }
  if (status === 403) return new BoatError('BOAT_FORBIDDEN', base);
  if (status === 404) return new BoatError('BOAT_NOT_FOUND', base);
  if (status === 429) return new BoatError('BOAT_RATE_LIMITED', { ...base, retryable: true });
  if (status === 409) {
    return new BoatError('BOAT_CONFLICT', {
      ...base,
      retryable: ['idempotency_in_progress', 'boat_starting', 'machine_not_running'].includes(boatCode),
    });
  }
  if (status >= 500) return new BoatError('BOAT_UNAVAILABLE', { ...base, retryable: true });
  if (status >= 400) return new BoatError('BOAT_INVALID_REQUEST', base);
  return new BoatError('BOAT_UNAVAILABLE', base);
}

async function boundedText(response) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    throw new BoatError('BOAT_UNAVAILABLE', { detail: 'boat response is too large' });
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => {});
        throw new BoatError('BOAT_UNAVAILABLE', { detail: 'boat response is too large' });
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size).toString('utf8');
}

function formBody(fields) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) params.set(key, String(value));
  return params.toString();
}

function expiryFrom(now, seconds) {
  const value = Number(seconds);
  return Number.isFinite(value) && value > 0 ? now + value * 1000 : null;
}

function instantFrom(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value > 1e12 ? value : value * 1000;
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function normalizeAccount(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const method = raw.method === 'email' || raw.method === 'api-key' ? raw.method : null;
  const accessToken = typeof raw.accessToken === 'string' ? raw.accessToken.trim() : '';
  if (!method || !accessToken) return null;
  const finite = (value) => (Number.isFinite(value) && value > 0 ? value : null);
  return {
    version: 1,
    method,
    accessToken,
    email: typeof raw.email === 'string' && raw.email.trim() ? raw.email.trim().slice(0, 254) : null,
    accessExpiresAt: finite(raw.accessExpiresAt),
    identityAssertion: method === 'email' && typeof raw.identityAssertion === 'string' && raw.identityAssertion
      ? raw.identityAssertion
      : null,
    assertionExpiresAt: finite(raw.assertionExpiresAt),
    connectedAt: typeof raw.connectedAt === 'string' ? raw.connectedAt : new Date(0).toISOString(),
    authInvalid: raw.authInvalid === true,
  };
}

function normalizeSetupJournal(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const idempotencyKey = typeof raw.idempotencyKey === 'string' && /^[A-Za-z0-9-]{16,80}$/.test(raw.idempotencyKey)
    ? raw.idempotencyKey
    : null;
  const startedAt = typeof raw.startedAt === 'string' && Number.isFinite(Date.parse(raw.startedAt))
    ? raw.startedAt
    : null;
  if (!idempotencyKey || !startedAt) return null;
  const stages = ['creating', 'starting', 'installing', 'pairing', 'credentials'];
  return {
    version: 1,
    machine: normalizeBoatMachine(raw.machine),
    startedAt,
    idempotencyKey,
    sandboxId: typeof raw.sandboxId === 'string' && BOAT_SANDBOX_ID_RE.test(raw.sandboxId) ? raw.sandboxId : null,
    stage: stages.includes(raw.stage) ? raw.stage : 'creating',
  };
}

function normalizeSandbox(raw) {
  if (!raw || typeof raw !== 'object' || !BOAT_SANDBOX_ID_RE.test(String(raw.id ?? ''))) return null;
  return raw;
}

/** "host:port" 또는 "[v6]:port" */
function parseEndpoint(value) {
  const text = String(value ?? '').trim();
  const bracketed = /^\[([0-9a-f:.]+)\]:(\d{1,5})$/i.exec(text);
  const plain = /^([^:\s]+):(\d{1,5})$/.exec(text);
  const match = bracketed ?? plain;
  if (!match) return null;
  const port = Number(match[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host: match[1], port };
}

function validHost(host) {
  return net.isIP(host) !== 0 || HOST_RE.test(host);
}

/** sshEndpoint(IPv4 포워더)가 있으면 그쪽, 없으면 machineIp:22 로 접속한다. */
export function resolveSshTarget(sandbox, registered = null) {
  const endpoint = parseEndpoint(registered?.sshEndpoint || sandbox?.sshEndpoint || '');
  const host = endpoint?.host ?? String(registered?.machineIp || sandbox?.ip || '').trim();
  const port = endpoint?.port ?? 22;
  const user = String(registered?.sshUser || BOAT_SSH_USER);
  if (!host || !validHost(host)) {
    throw new BoatError('BOAT_UNAVAILABLE', { detail: 'boat did not report a reachable SSH address' });
  }
  if (!SSH_USER_RE.test(user)) throw new BoatError('BOAT_UNAVAILABLE', { detail: 'boat reported an invalid SSH user' });
  return { host, port, user };
}

/** 같은 VM인지 판단하는 주소 지문. 재개할 때마다 바뀐다. */
export function sandboxMachineKey(sandbox) {
  return `${String(sandbox?.ip ?? '')}|${String(sandbox?.sshEndpoint ?? '')}`;
}

export function parseHostKeys(text) {
  const keys = [];
  const seen = new Set();
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const [type, key] = line.trim().split(/\s+/);
    if (!HOST_KEY_TYPES.has(type) || !/^[A-Za-z0-9+/]+={0,2}$/.test(key ?? '')) continue;
    const blob = Buffer.from(key, 'base64');
    if (blob.length < 8) continue;
    const length = blob.readUInt32BE(0);
    if (length + 4 > blob.length || blob.subarray(4, 4 + length).toString('latin1') !== type) continue;
    const id = `${type} ${key}`;
    if (seen.has(id)) continue;
    seen.add(id);
    keys.push({ type, key });
  }
  return keys;
}

export function knownHostsPattern(host, port = 22) {
  const bare = String(host).replace(/^\[|\]$/g, '');
  return Number(port) === 22 ? bare : `[${bare}]:${Number(port)}`;
}

function hostEntryMatches(entry, pattern) {
  if (entry === pattern) return true;
  if (!entry.startsWith('|1|')) return false;
  const [, , salt, hash] = entry.split('|');
  if (!salt || !hash) return false;
  try {
    return createHmac('sha1', Buffer.from(salt, 'base64')).update(pattern).digest('base64') === hash;
  } catch {
    return false;
  }
}

/**
 * 새 주소에 남은 다른 키를 지우고 새 키를 표식과 함께 붙인다. 이 샌드박스의 옛 주소 핀은
 * `keepOtherPins`면 남기고(새 주소가 프로필에 저장되기 전), 아니면 모두 지운다.
 * `@` 표식 줄과 다른 호스트 줄은 건드리지 않는다.
 */
export function rewriteKnownHosts(text, { sandboxId, pattern = null, keys = [], keepOtherPins = false }) {
  const marker = `${PIN_MARKER_PREFIX}${sandboxId}`;
  const kept = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('#') || trimmed.startsWith('@')) {
      kept.push(trimmed);
      continue;
    }
    const fields = trimmed.split(/\s+/);
    const atPattern = Boolean(pattern) && fields[0].split(',').some((entry) => hostEntryMatches(entry, pattern));
    if (atPattern) continue;
    if (fields.slice(3).includes(marker) && !keepOtherPins) continue;
    kept.push(trimmed);
  }
  if (pattern) {
    for (const { type, key } of keys) kept.push(`${pattern} ${type} ${key} ${marker}`);
  }
  return kept.length ? `${kept.join('\n')}\n` : '';
}

/** SSH 배너가 오면 준비된 것으로 본다. 포워더만 열린 상태는 통과시키지 않는다. */
export function sshBannerProbe(host, port, { timeoutMs = 3_000 } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const socket = net.connect({ host, port });
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once('data', (chunk) => finish(chunk.toString('latin1').startsWith('SSH-')));
    socket.once('error', () => finish(false));
    socket.once('close', () => finish(false));
  });
}

function defaultRunProcess(command, args, { timeoutMs = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, {
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 256 * 1024,
      env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
    }, (error, stdout, stderr) => {
      if (error) {
        reject(Object.assign(
          new Error(`${command} failed: ${String(stderr || error.message).trim().slice(-400)}`),
          { code: error.code },
        ));
        return;
      }
      resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

/** 가벼운 주기 갱신. 창이 보이거나 설정이 진행 중일 때만 boat API를 부른다. */
export function installBoatStatusCadence({
  refresh,
  isWanted,
  intervalMs = 60_000,
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
} = {}) {
  let stopped = false;
  const timer = setIntervalImpl(() => {
    if (stopped) return;
    let wanted = false;
    try { wanted = Boolean(isWanted?.()); } catch { wanted = false; }
    if (wanted) void Promise.resolve(refresh?.()).catch(() => {});
  }, intervalMs);
  timer?.unref?.();
  return () => {
    if (stopped) return;
    stopped = true;
    clearIntervalImpl(timer);
  };
}

export class BoatCloud {
  #vault;
  #fetch;
  #origin;
  #dataDir;
  #knownHostsPath;
  #runProcess;
  #openExternal;
  #now;
  #sleep;
  #random;
  #probeSsh;
  #timeoutMs;
  #account;
  #accountLoad = null;
  #accountChain = Promise.resolve();
  #refreshPromise = null;
  #claims = new Map();
  #limits = null;
  #pinChain = Promise.resolve();
  #identityPromise = null;

  constructor({
    vault,
    fetchImpl = globalThis.fetch,
    origin = boatOrigin(),
    dataDir,
    knownHostsPath,
    runProcess = defaultRunProcess,
    openExternal = null,
    now = () => Date.now(),
    sleep = (ms, signal) => delay(ms, undefined, signal ? { signal } : undefined),
    random = Math.random,
    probeSsh = sshBannerProbe,
    requestTimeoutMs = DEFAULT_TIMEOUT_MS,
  } = {}) {
    if (!vault) throw new Error('BoatCloud requires a secret vault');
    if (typeof fetchImpl !== 'function') throw new Error('BoatCloud requires fetch');
    if (!dataDir) throw new Error('BoatCloud requires a data directory');
    if (!knownHostsPath) throw new Error('BoatCloud requires a known-hosts path');
    this.#vault = vault;
    this.#fetch = fetchImpl;
    this.#origin = boatOrigin({ [BOAT_ORIGIN_ENV]: origin });
    this.#dataDir = dataDir;
    this.#knownHostsPath = knownHostsPath;
    this.#runProcess = runProcess;
    this.#openExternal = openExternal;
    this.#now = now;
    this.#sleep = sleep;
    this.#random = random;
    this.#probeSsh = probeSsh;
    this.#timeoutMs = requestTimeoutMs;
  }

  get origin() {
    return this.#origin;
  }

  get sshKeyPath() {
    return path.join(this.#dataDir, 'boat', 'id_ed25519');
  }

  // ── HTTP ──────────────────────────────────────────────────────────────

  async #once({ method, url, headers, body, signal, timeoutMs }) {
    const controller = new AbortController();
    const timeoutError = new BoatError('BOAT_UNAVAILABLE', {
      detail: `boat request timed out after ${timeoutMs} ms`,
      retryable: true,
    });
    const timer = setTimeout(() => controller.abort(timeoutError), timeoutMs);
    timer.unref?.();
    try {
      const response = await this.#fetch(url, {
        method,
        headers,
        body,
        signal: signal ? AbortSignal.any([controller.signal, signal]) : controller.signal,
        cache: 'no-store',
      });
      const text = await boundedText(response);
      let parsed = {};
      if (text.trim()) {
        try { parsed = JSON.parse(text); } catch {
          if (response.ok) throw new BoatError('BOAT_UNAVAILABLE', { detail: 'boat returned invalid JSON', retryable: true });
          parsed = {};
        }
      }
      return { status: response.status, ok: response.ok, headers: response.headers, body: parsed };
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error;
      if (controller.signal.aborted) throw timeoutError;
      if (error instanceof BoatError) throw error;
      throw new BoatError('BOAT_UNAVAILABLE', {
        detail: `boat network error: ${redact(error?.cause?.code ?? error?.message ?? error)}`,
        retryable: true,
        cause: error,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 429/502/503/504와 네트워크 오류는 흔들림을 준 지수 백오프로 재시도한다.
   * 멱등이 아닌 호출은 요청이 실행되지 않았음이 확실한 429에서만 다시 보낸다.
   */
  async #send({
    method = 'GET',
    url,
    token = null,
    json,
    form,
    headers = {},
    idempotent = method === 'GET',
    retries = 3,
    timeoutMs = this.#timeoutMs,
    signal,
    accept = null,
    context = '',
  }) {
    const requestHeaders = { accept: 'application/json', ...headers };
    let body;
    if (json !== undefined) {
      requestHeaders['content-type'] = 'application/json';
      body = JSON.stringify(json);
    } else if (form !== undefined) {
      requestHeaders['content-type'] = 'application/x-www-form-urlencoded';
      body = formBody(form);
    }
    if (token) requestHeaders.authorization = `Bearer ${token}`;
    for (let attempt = 1; ; attempt += 1) {
      let result;
      try {
        result = await this.#once({ method, url, headers: requestHeaders, body, signal, timeoutMs });
      } catch (error) {
        if (signal?.aborted) throw error;
        if (!(error instanceof BoatError) || !error.retryable || !idempotent || attempt > retries) throw error;
        await this.#sleep(backoffDelayMs(attempt, { random: this.#random }), signal);
        continue;
      }
      const envelopeFailed = result.ok && result.body && result.body.ok === false;
      if (result.ok && !envelopeFailed) return result;
      if (accept?.(result.status, result.body)) return result;
      const failure = boatErrorFromResponse(result.status, result.body, {
        retryAfterMs: retryAfterMsFrom(result.headers, this.#now()),
        context,
      });
      // These codes mean the request was not executed, so even a command may be resent.
      const inProgress = ['idempotency_in_progress', 'boat_starting', 'machine_not_running']
        .includes(failure.boatCode);
      const safe = result.status === 429 || inProgress || idempotent;
      const transient = RETRYABLE_STATUSES.has(result.status) || inProgress;
      if (!safe || !transient || attempt > retries) throw failure;
      await this.#sleep(backoffDelayMs(attempt, {
        random: this.#random,
        retryAfterMs: failure.retryAfterMs,
        baseMs: inProgress ? 1_000 : 500,
      }), signal);
    }
  }

  #v1(pathname) {
    return `${this.#origin}/api/v1${pathname}`;
  }

  #auth(pathname) {
    return `${this.#origin}/api/boat${pathname}`;
  }

  /** 만료가 가까운 이메일 로그인 토큰은 미리 회전하고, 401이면 한 번만 회전 후 다시 보낸다. */
  async #authorized({ retriedAuth = false, ...options }) {
    const account = await this.#requireAccount();
    let token = account.accessToken;
    if (account.method === 'email' && account.identityAssertion && account.accessExpiresAt
      && account.accessExpiresAt - this.#now() < 60_000) {
      token = (await this.#refreshAccess(account.accessToken)).accessToken;
    }
    try {
      return await this.#send({ ...options, token });
    } catch (error) {
      if (error?.code !== 'BOAT_AUTH_INVALID' || error.status !== 401) {
        if (error?.code === 'BOAT_AUTH_INVALID') await this.#markAuthInvalid();
        throw error;
      }
      if (account.method === 'email' && account.identityAssertion && !retriedAuth) {
        await this.#refreshAccess(token);
        return this.#authorized({ ...options, retriedAuth: true });
      }
      await this.#markAuthInvalid();
      throw error;
    }
  }

  #api(method, pathname, options = {}) {
    return this.#authorized({ ...options, method, url: this.#v1(pathname) });
  }

  // ── Account ───────────────────────────────────────────────────────────

  async loadAccount() {
    if (this.#account !== undefined) return this.#account;
    if (!this.#accountLoad) {
      this.#accountLoad = (async () => {
        const stored = await this.#vault.get(ACCOUNT_SECRET);
        let parsed = null;
        try { parsed = stored ? normalizeAccount(JSON.parse(stored)) : null; } catch { parsed = null; }
        if (this.#account === undefined) this.#account = parsed;
        return this.#account;
      })().finally(() => { this.#accountLoad = null; });
    }
    return this.#accountLoad;
  }

  #saveAccount(next) {
    const run = this.#accountChain.then(async () => {
      const account = next ? normalizeAccount(next) : null;
      if (account) await this.#vault.set(ACCOUNT_SECRET, JSON.stringify(account));
      else await this.#vault.delete(ACCOUNT_SECRET);
      this.#account = account;
      return account;
    });
    this.#accountChain = run.catch(() => {});
    return run;
  }

  async #requireAccount() {
    const account = await this.loadAccount();
    if (!account) throw new BoatError('BOAT_NOT_CONNECTED');
    if (account.authInvalid) throw new BoatError('BOAT_AUTH_INVALID', { detail: 'boat credentials were rejected earlier' });
    return account;
  }

  async #markAuthInvalid() {
    const account = await this.loadAccount().catch(() => null);
    this.#limits = null;
    if (account && !account.authInvalid) await this.#saveAccount({ ...account, authInvalid: true }).catch(() => {});
  }

  async isConnected() {
    const account = await this.loadAccount().catch(() => null);
    return Boolean(account && !account.authInvalid);
  }

  async accountSnapshot() {
    const account = await this.loadAccount().catch(() => null);
    const connected = Boolean(account && !account.authInvalid);
    return {
      connected,
      method: account?.method ?? null,
      email: account?.email ?? null,
      canStart: connected ? this.#limits?.canStart ?? null : null,
      trial: connected ? this.#limits?.trial ?? null : null,
    };
  }

  /** 이메일 로그인 토큰은 신원 단언으로 회전한다. 이전 키는 boat가 폐기한다. */
  async #refreshAccess(staleToken) {
    if (this.#refreshPromise) return this.#refreshPromise;
    const operation = (async () => {
      const account = await this.#requireAccount();
      if (account.accessToken !== staleToken && account.accessExpiresAt
        && account.accessExpiresAt - this.#now() >= 60_000) {
        return account;
      }
      if (account.method !== 'email' || !account.identityAssertion) {
        throw new BoatError('BOAT_AUTH_INVALID', { detail: 'boat account has no identity assertion' });
      }
      const result = await this.#send({
        method: 'POST',
        url: this.#auth('/oauth2/token'),
        form: {
          grant_type: JWT_BEARER_GRANT,
          assertion: account.identityAssertion,
          resource: `${this.#origin}/api/v1/`,
        },
        // Each exchange mints a valid key and revokes the previous one, so a lost
        // response is repaired by exchanging the same assertion again.
        idempotent: true,
        accept: (status) => status === 400 || status === 401,
        context: 'token refresh',
      });
      if (result.status >= 400 || typeof result.body?.access_token !== 'string' || !result.body.access_token) {
        await this.#markAuthInvalid();
        throw boatErrorFromResponse(result.status >= 400 ? result.status : 401, result.body, { context: 'token refresh' });
      }
      const now = this.#now();
      return this.#saveAccount({
        ...account,
        accessToken: result.body.access_token,
        accessExpiresAt: expiryFrom(now, result.body.expires_in),
        identityAssertion: typeof result.body.identity_assertion === 'string' && result.body.identity_assertion
          ? result.body.identity_assertion
          : account.identityAssertion,
        assertionExpiresAt: instantFrom(result.body.assertion_expires) ?? account.assertionExpiresAt,
        authInvalid: false,
      });
    })().finally(() => {
      if (this.#refreshPromise === operation) this.#refreshPromise = null;
    });
    this.#refreshPromise = operation;
    return operation;
  }

  async connectApiKey(apiKey) {
    const key = String(apiKey ?? '').trim();
    if (!/^[\x21-\x7e]{8,512}$/.test(key)) {
      throw new BoatError('BOAT_AUTH_INVALID', {
        message: MESSAGES.BOAT_API_KEY_INVALID,
        detail: 'boat API key format is invalid',
      });
    }
    let me;
    try {
      me = await this.#send({ url: this.#v1('/me'), token: key, context: 'me' });
    } catch (error) {
      if (error?.code === 'BOAT_AUTH_INVALID') {
        throw new BoatError('BOAT_AUTH_INVALID', {
          message: MESSAGES.BOAT_API_KEY_INVALID,
          detail: error.detail,
          status: error.status,
          boatCode: error.boatCode,
        });
      }
      throw error;
    }
    await this.#saveAccount({
      method: 'api-key',
      accessToken: key,
      email: me.body?.user?.email ?? null,
      connectedAt: new Date(this.#now()).toISOString(),
    });
    this.#claims.clear();
    await this.refreshLimits().catch(() => null);
    return this.accountSnapshot();
  }

  #claimChallenge(claimId, claim) {
    return {
      claimId,
      verificationUri: claim.verificationUri,
      userCode: claim.userCode,
      expiresAt: new Date(claim.userCodeExpiresAt).toISOString(),
      intervalSeconds: Math.round(claim.intervalMs / 1000),
    };
  }

  #acceptClaimMaterial(claim, material) {
    const block = material?.claim && typeof material.claim === 'object' ? material.claim : material;
    const userCode = String(block?.user_code ?? '').replace(/\s+/g, '');
    const verificationUri = String(block?.verification_uri ?? '');
    if (!/^[A-Za-z0-9]{4,12}$/.test(userCode)
      || !isAllowedBoatLink(verificationUri, { origin: this.#origin, kind: 'verification' })) {
      throw new BoatError('BOAT_UNAVAILABLE', { detail: 'boat returned an invalid sign-in claim' });
    }
    const now = this.#now();
    const expiresIn = Number(block.expires_in);
    const interval = Number(block.interval);
    claim.userCode = userCode;
    claim.verificationUri = verificationUri;
    claim.userCodeExpiresAt = now + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 600) * 1000;
    claim.intervalMs = Math.min(60, Math.max(1, Number.isFinite(interval) && interval > 0 ? interval : 5)) * 1000;
    claim.nextPollAt = now;
    claim.expired = false;
    if (typeof material?.claim_token === 'string' && material.claim_token) claim.claimToken = material.claim_token;
    const claimTokenExpiresAt = instantFrom(material?.claim_token_expires);
    if (claimTokenExpiresAt) claim.claimTokenExpiresAt = claimTokenExpiresAt;
    return claim;
  }

  /**
   * boat 에이전트 인증(service_auth). 같은 이메일의 살아 있는 클레임이 있으면 새로
   * 등록하지 않고 클레임 의식만 다시 받는다(코드 만료 후 "새 코드").
   */
  async startEmailSignIn(email) {
    const address = String(email ?? '').trim();
    if (!EMAIL_RE.test(address) || address.length > 254) throw new BoatError('BOAT_INVALID_EMAIL');
    const now = this.#now();
    let claim = [...this.#claims.values()].find((entry) => (
      entry.email.toLowerCase() === address.toLowerCase()
      && entry.claimToken
      && (!entry.claimTokenExpiresAt || entry.claimTokenExpiresAt > now)
    )) ?? null;
    if (claim) {
      try {
        const result = await this.#send({
          method: 'POST',
          url: this.#auth('/agent/identity/claim'),
          json: { claim_token: claim.claimToken, email: address },
          idempotent: false,
          context: 'claim',
        });
        this.#acceptClaimMaterial(claim, result.body);
      } catch (error) {
        if (!['BOAT_AUTH_INVALID', 'BOAT_INVALID_REQUEST', 'BOAT_CONFLICT', 'BOAT_NOT_FOUND'].includes(error?.code)) {
          throw error;
        }
        this.#claims.delete(claim.id);
        claim = null;
      }
    }
    if (!claim) {
      const result = await this.#send({
        method: 'POST',
        url: this.#auth('/agent/identity'),
        json: { type: 'service_auth', login_hint: address },
        idempotent: false,
        context: 'identity',
      });
      if (typeof result.body?.claim_token !== 'string' || !result.body.claim_token) {
        throw new BoatError('BOAT_UNAVAILABLE', { detail: 'boat did not return a claim token' });
      }
      claim = this.#acceptClaimMaterial({ id: randomUUID(), email: address }, result.body);
    }
    for (const [id, entry] of this.#claims) {
      if (id !== claim.id && entry.email.toLowerCase() === address.toLowerCase()) this.#claims.delete(id);
    }
    // A fresh claim id per ceremony keeps a stale renderer poll from reading the new code.
    this.#claims.delete(claim.id);
    claim.id = randomUUID();
    this.#claims.set(claim.id, claim);
    while (this.#claims.size > 8) this.#claims.delete(this.#claims.keys().next().value);
    return this.#claimChallenge(claim.id, claim);
  }

  async pollSignIn(claimId) {
    const claim = this.#claims.get(String(claimId ?? ''));
    if (!claim || claim.expired) return { status: 'expired' };
    const now = this.#now();
    if (now > claim.userCodeExpiresAt + 60_000) {
      claim.expired = true;
      return { status: 'expired' };
    }
    if (now < claim.nextPollAt) return { status: 'pending' };
    claim.nextPollAt = now + claim.intervalMs;
    let result;
    try {
      result = await this.#send({
        method: 'POST',
        url: this.#auth('/oauth2/token'),
        form: { grant_type: CLAIM_GRANT, claim_token: claim.claimToken },
        // Polling returns the same live token; it does not mint another key.
        idempotent: true,
        retries: 1,
        accept: (status) => status >= 400 && status < 500 && status !== 429,
        context: 'claim poll',
      });
    } catch (error) {
      if (['BOAT_UNAVAILABLE', 'BOAT_RATE_LIMITED'].includes(error?.code)) {
        claim.intervalMs = Math.min(60_000, claim.intervalMs + 5_000);
        claim.nextPollAt = this.#now() + claim.intervalMs;
        return { status: 'pending' };
      }
      throw error;
    }
    const body = result.body ?? {};
    if (result.status < 400 && typeof body.access_token === 'string' && body.access_token) {
      const signedInAt = this.#now();
      await this.#saveAccount({
        method: 'email',
        email: claim.email,
        accessToken: body.access_token,
        accessExpiresAt: expiryFrom(signedInAt, body.expires_in),
        identityAssertion: typeof body.identity_assertion === 'string' ? body.identity_assertion : null,
        assertionExpiresAt: instantFrom(body.assertion_expires),
        connectedAt: new Date(signedInAt).toISOString(),
      });
      this.#claims.clear();
      const me = await this.#api('GET', '/me').catch(() => null);
      const email = me?.body?.user?.email;
      if (typeof email === 'string' && email && email !== claim.email) {
        const account = await this.loadAccount();
        await this.#saveAccount({ ...account, email });
      }
      await this.refreshLimits().catch(() => null);
      return { status: 'connected' };
    }
    switch (errorCodeOf(body)) {
      case 'authorization_pending':
        return { status: 'pending' };
      case 'slow_down':
      case 'rate_limited':
        claim.intervalMs = Math.min(60_000, claim.intervalMs + 5_000);
        claim.nextPollAt = this.#now() + claim.intervalMs;
        return { status: 'pending' };
      case 'expired_token':
        // Only the user code lapsed. The claim token re-claims on the next start.
        claim.expired = true;
        return { status: 'expired' };
      case 'invalid_grant':
      case 'invalid_claim_token':
      case 'claim_expired':
      case 'access_denied':
        claim.expired = true;
        claim.claimToken = null;
        return { status: 'expired' };
      default:
        throw boatErrorFromResponse(result.status, body, { context: 'claim poll' });
    }
  }

  async disconnect() {
    const account = await this.loadAccount().catch(() => null);
    if (account?.method === 'email' && account.accessToken) {
      // This key was minted for the app, so it is revoked. A pasted API key belongs to the user.
      await this.#send({
        method: 'POST',
        url: this.#auth('/oauth2/revoke'),
        form: { token: account.accessToken, token_type_hint: 'access_token' },
        idempotent: true,
        retries: 1,
        timeoutMs: 8_000,
        accept: () => true,
        context: 'revoke',
      }).catch(() => {});
    }
    this.#claims.clear();
    this.#limits = null;
    await this.#saveAccount(null);
    return true;
  }

  async refreshLimits({ signal } = {}) {
    const { body } = await this.#api('GET', '/limits', { signal, context: 'limits' });
    const planKey = typeof body.sandboxPlanKey === 'string' ? body.sandboxPlanKey : null;
    const tier = typeof body.accessTier === 'string' ? body.accessTier : null;
    this.#limits = {
      canStart: typeof body.canStart === 'boolean' ? body.canStart : null,
      trial: tier === 'trial' || planKey === 'trial' ? true : tier || planKey ? false : null,
      checkoutRequired: body.checkoutRequired === true,
      at: this.#now(),
    };
    return this.#limits;
  }

  get limits() {
    return this.#limits;
  }

  async me() {
    const { body } = await this.#api('GET', '/me', { context: 'me' });
    return { email: body.user?.email ?? null, login: body.user?.login ?? null };
  }

  async createCheckout() {
    const request = (url) => this.#authorized({
      method: 'POST',
      url,
      json: { kind: 'subscription' },
      idempotent: false,
      context: 'checkout',
    });
    let result;
    try {
      result = await request(this.#auth('/billing/checkout'));
    } catch (error) {
      if (error?.code !== 'BOAT_NOT_FOUND') throw error;
      result = await request(this.#v1('/billing/checkout'));
    }
    const url = String(result.body?.url ?? '');
    if (!isAllowedBoatLink(url, { origin: this.#origin, kind: 'checkout' })) {
      throw new BoatError('BOAT_LINK_UNAVAILABLE', { detail: 'boat returned an unexpected checkout URL' });
    }
    return url;
  }

  async linkUrl({ kind, claimId = null } = {}) {
    if (kind === 'verification') {
      const claim = this.#claims.get(String(claimId ?? ''));
      if (!claim?.verificationUri) throw new BoatError('BOAT_LINK_UNAVAILABLE');
      return claim.verificationUri;
    }
    if (kind === 'checkout') return this.createCheckout();
    if (kind === 'api-keys') return `${this.#origin}/dashboard?tab=api-keys`;
    if (kind === 'dashboard') return `${this.#origin}/dashboard`;
    throw new BoatError('BOAT_LINK_UNAVAILABLE', { detail: 'unknown boat link kind' });
  }

  async openLink({ kind, claimId = null } = {}) {
    const url = await this.linkUrl({ kind, claimId });
    if (!isAllowedBoatLink(url, { origin: this.#origin, kind })) throw new BoatError('BOAT_LINK_UNAVAILABLE');
    if (typeof this.#openExternal !== 'function') throw new BoatError('BOAT_LINK_UNAVAILABLE');
    await this.#openExternal(url);
    return { opened: true };
  }

  // ── Setup journal ─────────────────────────────────────────────────────

  async loadSetupJournal() {
    const stored = await this.#vault.get(SETUP_SECRET);
    try { return stored ? normalizeSetupJournal(JSON.parse(stored)) : null; } catch { return null; }
  }

  async saveSetupJournal(journal) {
    const normalized = normalizeSetupJournal(journal);
    if (!normalized) throw new Error('boat setup journal is invalid');
    await this.#vault.set(SETUP_SECRET, JSON.stringify(normalized));
    return normalized;
  }

  async clearSetupJournal() {
    await this.#vault.delete(SETUP_SECRET);
  }

  // ── Sandboxes ─────────────────────────────────────────────────────────

  async getSandbox(sandboxId, { signal } = {}) {
    const id = assertSandboxId(sandboxId);
    try {
      const { body } = await this.#api('GET', `/sandboxes/${id}`, { signal, context: 'sandbox' });
      const sandbox = normalizeSandbox(body.sandbox);
      // `cancelled` is terminal: a create that never got a machine was removed.
      return !sandbox || sandbox.state === 'cancelled' ? null : sandbox;
    } catch (error) {
      if (error?.code === 'BOAT_NOT_FOUND') return null;
      throw error;
    }
  }

  async listSandboxes({ signal } = {}) {
    const sandboxes = [];
    let cursor = null;
    for (let page = 0; page < 5; page += 1) {
      const query = `?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const { body } = await this.#api('GET', `/sandboxes${query}`, { signal, context: 'sandbox list' });
      for (const sandbox of Array.isArray(body.sandboxes) ? body.sandboxes : []) {
        if (normalizeSandbox(sandbox)) sandboxes.push(sandbox);
      }
      cursor = body.pageInfo?.hasMore ? body.pageInfo.nextCursor : null;
      if (!cursor) break;
    }
    return sandboxes;
  }

  /** 두 번째 Mac은 같은 계정의 "Rauhwpx Cloud" VM을 그대로 쓴다. */
  async findRauhwpxSandbox({ signal } = {}) {
    const rank = (sandbox) => (sandbox.state === 'error' ? 1 : 0);
    const candidates = (await this.listSandboxes({ signal }))
      .filter((sandbox) => sandbox.name === BOAT_SANDBOX_NAME && sandbox.state !== 'cancelled')
      // A failed VM with nothing to resume from cannot be adopted.
      .filter((sandbox) => sandbox.state !== 'error' || sandbox.snapshotAvailable === true)
      .sort((left, right) => rank(left) - rank(right)
        || String(right.createdAt ?? '').localeCompare(String(left.createdAt ?? '')));
    return candidates[0] ?? null;
  }

  /** Idempotency-Key 덕분에 응답을 잃어도 같은 키로 다시 보내 두 번째 VM을 만들지 않는다. */
  async createSandbox({ machine = 'default', idempotencyKey, ttlSeconds = BOAT_SETUP_TTL_SECONDS, signal } = {}) {
    if (!/^[A-Za-z0-9-]{16,80}$/.test(String(idempotencyKey ?? ''))) {
      throw new Error('boat create requires an idempotency key');
    }
    const create = (key, ttl) => this.#api('POST', '/sandboxes', {
      json: { name: BOAT_SANDBOX_NAME, type: normalizeBoatMachine(machine), ttlSeconds: ttl },
      headers: { 'Idempotency-Key': key },
      idempotent: true,
      retries: 5,
      signal,
      context: 'create',
    });
    let result;
    try {
      result = await create(idempotencyKey, ttlSeconds);
    } catch (error) {
      if (error?.boatCode !== 'trial_auto_stop_required' || ttlSeconds === BOAT_TRIAL_TTL_SECONDS) throw error;
      // The refused body never created a sandbox; a derived key keeps the retry idempotent.
      result = await create(`${idempotencyKey}-trial`, BOAT_TRIAL_TTL_SECONDS);
    }
    const sandbox = normalizeSandbox(result.body.sandbox);
    if (!sandbox) throw new BoatError('BOAT_UNAVAILABLE', { detail: 'boat create returned no sandbox' });
    return sandbox;
  }

  /** 체험 계정은 자동 중지를 끌 수 없다. 그때는 2시간으로 낮춰 다시 보낸다. */
  async #withTrialTtl(ttlSeconds, send) {
    try {
      return await send(ttlSeconds);
    } catch (error) {
      if (error?.boatCode !== 'trial_auto_stop_required'
        || (ttlSeconds !== null && ttlSeconds <= BOAT_TRIAL_TTL_SECONDS)) throw error;
      return send(BOAT_TRIAL_TTL_SECONDS);
    }
  }

  async resumeSandbox(sandboxId, { ttlSeconds = null, signal } = {}) {
    const id = assertSandboxId(sandboxId);
    return this.#withTrialTtl(ttlSeconds, (ttl) => this.#api('POST', `/sandboxes/${id}/resume`, {
      json: { ttlSeconds: ttl },
      idempotent: false,
      signal,
      context: 'resume',
    }));
  }

  /** boat 자동 중지를 바꾼다. null은 끄기다(체험 계정은 2시간으로 낮춘다). */
  async setAutoStop(sandboxId, ttlSeconds = null) {
    const id = assertSandboxId(sandboxId);
    const result = await this.#withTrialTtl(ttlSeconds, (ttl) => this.#api('PATCH', `/sandboxes/${id}`, {
      json: { ttlSeconds: ttl },
      idempotent: true,
      context: 'update',
    }));
    return result.body?.sandbox?.archiveAfter ?? null;
  }

  async stopSandbox(sandboxId, { signal } = {}) {
    const id = assertSandboxId(sandboxId);
    try {
      const { body } = await this.#api('POST', `/sandboxes/${id}/stop`, {
        json: {},
        idempotent: true,
        signal,
        context: 'stop',
      });
      return normalizeSandbox(body.sandbox);
    } catch (error) {
      if (error?.code === 'BOAT_NOT_FOUND') throw new BoatError('BOAT_SERVER_MISSING', { detail: error.detail });
      if (['BOAT_INVALID_REQUEST', 'BOAT_CONFLICT'].includes(error?.code)) {
        const sandbox = await this.getSandbox(id, { signal });
        if (sandbox && ['archiving', 'archived'].includes(sandbox.state)) return sandbox;
      }
      throw error;
    }
  }

  /** 삭제는 확인 헤더를 요구하고, 받아들여진 삭제 작업이 끝날 때까지 폴링한다. */
  async deleteSandbox(sandboxId, { signal, timeoutMs = 120_000, pollMs = 2_000 } = {}) {
    const id = assertSandboxId(sandboxId);
    let operation;
    try {
      const { body } = await this.#api('DELETE', `/sandboxes/${id}`, {
        headers: { 'X-Ascii-Confirm-Delete': id },
        idempotent: true,
        signal,
        context: 'delete',
      });
      operation = body.operation ?? null;
    } catch (error) {
      if (error?.code === 'BOAT_NOT_FOUND') return { completed: true, operation: null };
      throw error;
    }
    if (!operation || !OPERATION_ID_RE.test(String(operation.id ?? ''))) return { completed: true, operation };
    const deadline = this.#now() + timeoutMs;
    while (operation.status !== 'completed') {
      if (this.#now() >= deadline) return { completed: false, operation };
      await this.#sleep(pollMs, signal);
      try {
        const { body } = await this.#api('GET', `/deletion-operations/${operation.id}`, {
          signal,
          context: 'deletion',
        });
        operation = body.operation ?? operation;
      } catch (error) {
        if (error?.code === 'BOAT_NOT_FOUND') return { completed: true, operation };
        throw error;
      }
    }
    return { completed: true, operation };
  }

  async usage(sandboxId, { signal } = {}) {
    const id = assertSandboxId(sandboxId);
    const since = monthStartIso(new Date(this.#now()));
    const { body } = await this.#api('GET', `/sandboxes/${id}/usage?since=${encodeURIComponent(since)}`, {
      signal,
      context: 'usage',
    });
    const seconds = Number(body.seconds);
    return {
      seconds: Number.isFinite(seconds) && seconds >= 0 ? seconds : null,
      monthHours: monthHours(seconds),
      running: body.running === true,
    };
  }

  /**
   * 사용자 의도가 있을 때만 부른다. 보관 중이면 보관이 끝난 뒤 재개하고,
   * 시작 중이면 기다리며, 사라졌거나(404/cancelled) 결제가 필요하면 오류로 끝낸다.
   */
  async ensureRunning(sandboxId, {
    allowResume = true,
    resumeTtlSeconds = null,
    signal,
    onState = () => {},
    timeoutMs = 10 * 60_000,
  } = {}) {
    const id = assertSandboxId(sandboxId);
    const deadline = this.#now() + timeoutMs;
    let resumed = false;
    let resumeAttempts = 0;
    let resumedAt = -Infinity;
    let lastState = '';
    for (let attempt = 1; ; attempt += 1) {
      signal?.throwIfAborted();
      const sandbox = await this.getSandbox(id, { signal });
      if (!sandbox) throw new BoatError('BOAT_SERVER_MISSING', { detail: `boat sandbox ${id} no longer exists` });
      lastState = sandbox.state;
      try { onState(sandbox); } catch { /* 관찰자는 수명 주기를 막지 않는다. */ }
      if (USABLE_STATES.has(sandbox.state)) return { sandbox, resumed };
      const resumable = sandbox.state === 'archived'
        || (sandbox.state === 'error' && sandbox.snapshotAvailable === true);
      // An accepted resume can still read `archived` for a moment; give it time
      // before asking again instead of stacking resume requests.
      if (resumable && this.#now() - resumedAt >= 20_000) {
        if (!allowResume) {
          throw new BoatError('BOAT_SERVER_STOPPED', { detail: `boat sandbox is ${sandbox.state}` });
        }
        if (resumeAttempts >= 3) {
          throw new BoatError('BOAT_SERVER_FAILED', { detail: `boat sandbox stayed ${sandbox.state} after resume` });
        }
        resumeAttempts += 1;
        try {
          await this.resumeSandbox(id, { ttlSeconds: resumeTtlSeconds, signal });
          resumed = true;
          resumedAt = this.#now();
        } catch (error) {
          // Another client may have resumed it first; the next read decides.
          if (error?.code !== 'BOAT_CONFLICT' && error?.code !== 'BOAT_RATE_LIMITED') throw error;
          if (error.code === 'BOAT_RATE_LIMITED' && this.#now() >= deadline) throw error;
        }
      } else if (sandbox.state === 'error' && !resumable) {
        throw new BoatError('BOAT_SERVER_FAILED', {
          detail: `boat sandbox failed: ${redact(sandbox.error ?? 'unknown error')}`,
        });
      }
      if (this.#now() >= deadline) {
        throw new BoatError('BOAT_UNAVAILABLE', {
          message: MESSAGES.BOAT_WAKE_TIMEOUT,
          detail: `boat sandbox stayed ${lastState} for ${Math.round(timeoutMs / 1000)} s`,
          retryable: true,
        });
      }
      await this.#sleep(attempt < 6 ? 1_000 : attempt < 20 ? 2_000 : 3_000, signal);
    }
  }

  async runCommand(sandboxId, command, { timeoutSeconds = 30, idempotent = false, signal } = {}) {
    const id = assertSandboxId(sandboxId);
    const seconds = Math.min(600, Math.max(1, Math.round(timeoutSeconds)));
    const { body } = await this.#api('POST', `/sandboxes/${id}/commands`, {
      json: { command, timeoutSeconds: seconds },
      // 409 boat_starting means nothing ran; other failures may already have run it.
      idempotent,
      retries: 8,
      timeoutMs: seconds * 1000 + 15_000,
      signal,
      context: 'command',
    });
    return {
      exitCode: Number.isInteger(body.exitCode) ? body.exitCode : null,
      stdout: typeof body.stdout === 'string' ? body.stdout : '',
      stderr: typeof body.stderr === 'string' ? body.stderr : '',
      timedOut: body.timedOut === true,
    };
  }

  /**
   * VM이 스스로 멈출 수 있는지 설치된 boat-idle.sh의 확인 모드로 본다. 타이머와 같은 탐색이므로
   * 둘의 판단이 어긋나지 않는다. 확인하지 못하면 'timer'다.
   * @returns {Promise<'idle' | 'timer'>}
   */
  async probeSelfStop(sandboxId, { signal } = {}) {
    try {
      const result = await this.runCommand(sandboxId, SELF_STOP_COMMAND, {
        timeoutSeconds: 120,
        idempotent: true,
        signal,
      });
      const match = SELF_STOP_RE.exec(result.stdout);
      return match && match[1] !== 'none' ? 'idle' : 'timer';
    } catch (error) {
      if (signal?.aborted) throw error;
      return 'timer';
    }
  }

  async registerSshKey(sandboxId, publicKey, { signal } = {}) {
    const id = assertSandboxId(sandboxId);
    const { body } = await this.#api('POST', `/sandboxes/${id}/sshkey`, {
      json: { key: publicKey },
      // Authorizing the same public key again is harmless.
      idempotent: true,
      retries: 8,
      signal,
      context: 'sshkey',
    });
    return {
      machineIp: typeof body.machineIp === 'string' ? body.machineIp : null,
      sshUser: typeof body.sshUser === 'string' ? body.sshUser : BOAT_SSH_USER,
      sshEndpoint: typeof body.sshEndpoint === 'string' ? body.sshEndpoint : null,
      hostKey: typeof body.hostKey === 'string' ? body.hostKey : null,
    };
  }

  /** 앱 전용 ed25519 키. 개인 키는 0600, 디렉터리는 0700. */
  async ensureSshIdentity() {
    if (this.#identityPromise) return this.#identityPromise;
    const operation = (async () => {
      const privateKeyPath = this.sshKeyPath;
      const publicKeyPath = `${privateKeyPath}.pub`;
      await fs.mkdir(path.dirname(privateKeyPath), { recursive: true, mode: 0o700 });
      const exists = await fs.stat(privateKeyPath).then((info) => info.isFile(), () => false);
      if (!exists) {
        await fs.rm(publicKeyPath, { force: true });
        await this.#runProcess('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'rauhwpx-boat', '-f', privateKeyPath]);
      }
      if (process.platform !== 'win32') {
        await fs.chmod(path.dirname(privateKeyPath), 0o700).catch(() => {});
        await fs.chmod(privateKeyPath, 0o600);
      }
      let publicKey = await fs.readFile(publicKeyPath, 'utf8').catch(() => '');
      if (!/^ssh-ed25519 [A-Za-z0-9+/]+={0,2}(?: .*)?$/.test(publicKey.trim())) {
        const derived = await this.#runProcess('ssh-keygen', ['-y', '-f', privateKeyPath]);
        publicKey = `${derived.stdout.trim()} rauhwpx-boat\n`;
        await fs.writeFile(publicKeyPath, publicKey, { mode: 0o644 });
      }
      const line = publicKey.trim().split(/\s+/).slice(0, 2).join(' ');
      if (!/^ssh-ed25519 [A-Za-z0-9+/]+={0,2}$/.test(line)) {
        throw new BoatError('BOAT_SETUP_FAILED', { detail: 'ssh-keygen did not produce an ed25519 key' });
      }
      return { privateKeyPath, publicKey: `${line} rauhwpx-boat` };
    })().finally(() => { this.#identityPromise = null; });
    this.#identityPromise = operation;
    return operation;
  }

  /**
   * 호스트 키를 boat 명령 API(TLS로 인증된 boat 채널)로 읽어 접속 전에 핀한다.
   * sshkey 응답의 hostKey가 있으면 서로 맞아야 한다.
   */
  async fetchHostKeys(sandboxId, { registered = null, signal } = {}) {
    let fromCommand = [];
    let failure = null;
    try {
      const result = await this.runCommand(sandboxId, HOST_KEY_COMMAND, {
        timeoutSeconds: 20,
        idempotent: true,
        signal,
      });
      fromCommand = parseHostKeys(result.stdout);
    } catch (error) {
      if (signal?.aborted) throw error;
      failure = error;
    }
    const fromApi = registered?.hostKey ? parseHostKeys(registered.hostKey) : [];
    if (fromCommand.length && fromApi.length && !fromApi.every((entry) => fromCommand.some((candidate) => (
      candidate.type === entry.type && candidate.key === entry.key
    )))) {
      throw new BoatError('BOAT_HOST_KEY_UNVERIFIED', { detail: 'boat SSH host keys disagree between API sources' });
    }
    const keys = fromCommand.length ? fromCommand : fromApi;
    if (!keys.length) {
      throw new BoatError('BOAT_HOST_KEY_UNVERIFIED', {
        detail: `boat SSH host keys are unavailable${failure?.detail ? `: ${failure.detail}` : ''}`,
      });
    }
    return keys;
  }

  #withPinLock(operation) {
    const run = this.#pinChain.then(operation, operation);
    this.#pinChain = run.catch(() => {});
    return run;
  }

  async #rewritePins(transform) {
    return this.#withPinLock(async () => {
      await fs.mkdir(path.dirname(this.#knownHostsPath), { recursive: true, mode: 0o700 });
      const current = await fs.readFile(this.#knownHostsPath, 'utf8').catch((error) => {
        if (error?.code === 'ENOENT') return '';
        throw error;
      });
      const next = transform(current);
      const temp = `${this.#knownHostsPath}.tmp-${process.pid}-${randomUUID()}`;
      await fs.writeFile(temp, next, { mode: 0o600 });
      try {
        await fs.rename(temp, this.#knownHostsPath);
      } catch (error) {
        await fs.rm(temp, { force: true }).catch(() => {});
        throw error;
      }
      if (process.platform !== 'win32') await fs.chmod(this.#knownHostsPath, 0o600).catch(() => {});
      return next;
    });
  }

  /** 새 주소를 핀한다. 옛 주소 핀은 프로필이 새 주소를 저장한 뒤 prunePins가 지운다. */
  async pinHostKeys({ sandboxId, host, port = 22, keys }) {
    const id = assertSandboxId(sandboxId);
    if (!Array.isArray(keys) || !keys.length) throw new BoatError('BOAT_HOST_KEY_UNVERIFIED');
    const pattern = knownHostsPattern(host, port);
    await this.#rewritePins((text) => rewriteKnownHosts(text, { sandboxId: id, pattern, keys, keepOtherPins: true }));
    return pattern;
  }

  /** 저장된 주소의 핀만 남긴다. */
  async prunePins(sandboxId, { host, port = 22 }) {
    const id = assertSandboxId(sandboxId);
    const keep = knownHostsPattern(host, port);
    const marker = `${PIN_MARKER_PREFIX}${id}`;
    await this.#rewritePins((text) => {
      const lines = String(text ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      const kept = lines.filter((line) => {
        const fields = line.split(/\s+/);
        return !fields.slice(3).includes(marker) || fields[0] === keep;
      });
      return kept.length ? `${kept.join('\n')}\n` : '';
    });
  }

  /** 이 샌드박스 표식으로 저장된 주소의 핀이 있으면 true다. */
  async hasPin(sandboxId, { host, port = 22 }) {
    const id = assertSandboxId(sandboxId);
    const pattern = knownHostsPattern(host, port);
    const marker = `${PIN_MARKER_PREFIX}${id}`;
    const text = await fs.readFile(this.#knownHostsPath, 'utf8').catch(() => '');
    return text.split(/\r?\n/).some((line) => {
      const fields = line.trim().split(/\s+/);
      return fields[0] === pattern && fields.slice(3).includes(marker);
    });
  }

  async removePins(sandboxId) {
    const id = assertSandboxId(sandboxId);
    await this.#rewritePins((text) => rewriteKnownHosts(text, { sandboxId: id }));
  }

  async waitForSsh(host, port, { timeoutMs = 90_000, signal } = {}) {
    const deadline = this.#now() + timeoutMs;
    for (;;) {
      signal?.throwIfAborted();
      if (await this.#probeSsh(host, port, { timeoutMs: 3_000 })) return true;
      if (this.#now() >= deadline) {
        throw new BoatError('BOAT_UNAVAILABLE', {
          message: MESSAGES.BOAT_WAKE_TIMEOUT,
          detail: `SSH at ${knownHostsPattern(host, port)} did not answer`,
          retryable: true,
        });
      }
      await this.#sleep(1_500, signal);
    }
  }

  /**
   * 키 등록 → 호스트 키 핀 → SSH 응답 대기. 재개할 때마다 IP가 바뀌므로 매번 다시 한다.
   * 옛 주소 핀은 남는다. 호출자가 새 주소를 프로필에 저장한 뒤 prunePins를 부른다.
   */
  async prepareSsh(sandboxId, { sandbox = null, signal } = {}) {
    const id = assertSandboxId(sandboxId);
    const identity = await this.ensureSshIdentity();
    const registered = await this.registerSshKey(id, identity.publicKey, { signal });
    const current = sandbox ?? await this.getSandbox(id, { signal });
    const target = resolveSshTarget(current, registered);
    const keys = await this.fetchHostKeys(id, { registered, signal });
    await this.pinHostKeys({ sandboxId: id, host: target.host, port: target.port, keys });
    await this.waitForSsh(target.host, target.port, { signal });
    return { ...target, keyPath: identity.privateKeyPath, machineKey: sandboxMachineKey(current) };
  }
}

export const __test = {
  errorCodeOf,
  normalizeAccount,
  normalizeSetupJournal,
  parseEndpoint,
  redact,
  retryAfterMsFrom,
  HOST_KEY_COMMAND,
  MESSAGES,
  SELF_STOP_COMMAND,
};
