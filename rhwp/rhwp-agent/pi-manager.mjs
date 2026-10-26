import { createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import { readUtf8FileBounded } from './bounded-file.mjs';
import {
  PI_EXTENSION_PATH,
  PI_SKILLS_DIR,
  PI_SUBAGENT_EXTENSION_PATH,
} from './pi/resources.mjs';
import { createOpenRouter } from './openrouter.mjs';
import {
  fetchLatestPackage,
  recoverInterruptedFileReplacement,
  replaceFileAtomically,
  updatePrefixAtomically,
} from './harness-update.mjs';
import {
  applyManagedCliLaunch,
  createNodeHost,
} from './npm-cli-launch.mjs';
import { bundledNpmLaunch } from './npm-runtime.mjs';
import { API_KEY_MAX_BYTES, textFitsByteLimit } from './input-bounds.mjs';
import { cancelResponseBody, readResponseJsonBounded } from './response-bounds.mjs';
import {
  processTreeSpawnOptions,
  terminateAndWaitForProcessTreeExit,
  terminateProcessTree,
  withoutHubPrivateEnv,
} from './process-tree.mjs';
import { setupFailureMessage, shouldUseNpmNetworkPath } from './setup-errors.mjs';

const require = createRequire(import.meta.url);
let crossSpawn = null;

/**
 * cross-spawn: Windows에서 npm .cmd 심을 인자 이스케이프 손상 없이 실행한다.
 * 스폰이 실제로 필요할 때 늦게 불러온다 — 스폰을 주입하는 쪽은 의존성이 없어도 된다.
 */
function spawn(command, argv, options) {
  crossSpawn ??= require('cross-spawn');
  return crossSpawn(command, argv, options);
}

const PI_PACKAGE = '@earendil-works/pi-coding-agent';
/**
 * 하니스(시스템 프롬프트 파일, prepareArguments, agent_before_settle, maxTokens=0, 도구별
 * executionMode)를 맞춰 잰 Pi 버전. 설치와 자동 업데이트 모두 이 버전으로 수렴한다 —
 * 더 새 버전이 깔려 있어도 되돌린다. 올릴 때는 하니스 점검과 라이브 벤치를 다시 돌린다.
 */
export const PI_VERSION = '1.1.0';
const CONFIG_FILE = 'config.json';
const CONFIG_VERSION = 1;
const MAX_MODELS = 3;
export const PI_MODEL_ID_MAX_CHARS = 256;
export const PI_MODEL_NAME_MAX_CHARS = 256;
export const PI_API_KEY_MAX_CHARS = API_KEY_MAX_BYTES;
export const PI_SETTINGS_MAX_BYTES = 64 * 1024;
const PI_PACKAGE_MANIFEST_MAX_BYTES = 1024 * 1024;
/** OpenRouter 의 reasoning_effort 가 받는 값 — 우리는 이 셋만 노출한다. */
const EFFORTS = /** @type {const} */ (['low', 'medium', 'high']);
const DEFAULT_EFFORT = 'medium';
const DEFAULT_CONTEXT_WINDOW = 128_000;
/** OpenRouter 제공자 라우팅 정렬. off 면 provider 필드를 아예 보내지 않는다. */
const ROUTING_SORTS = new Set(['latency', 'throughput', 'price', 'off']);
const DEFAULT_ROUTING_SORT = 'throughput';
const STDERR_TAIL_LIMIT = 1_200;
const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;
const REGISTRY_TIMEOUT_MS = 10_000;
const OAUTH_EXCHANGE_TIMEOUT_MS = 20_000;
const OAUTH_RESPONSE_LIMIT_BYTES = 64 * 1024;
export const PI_TARBALL_MAX_BYTES = 256 * 1024 * 1024;
const INSTALL_STDERR_LIMIT_BYTES = 64 * 1024;
/** 진행 이벤트는 이 간격으로만 내보낸다 — 청크마다 WS 를 두드리지 않는다. */
const PROGRESS_INTERVAL_MS = 150;
const PI_SECRET_ID = 'rhwp.pi.openrouter-api-key';
const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
/** 선물 크레딧은 Claude 모델만, 출력은 서버 상한(GIFT_MAX_OUTPUT_TOKENS)까지만 쓴다. */
const GIFT_MODEL_PREFIX = 'anthropic/';
export const GIFT_MAX_OUTPUT_TOKENS = 32_000;
/** 기본 선물 모델 순서. 첫 번째가 기본 모델이다. */
const GIFT_DEFAULT_FAMILIES = ['sonnet', 'haiku', 'opus'];
/** 이보다 오래된 선물 자격은 스폰할 때 뒤에서 다시 받는다 (리스가 갱신됐을 수 있다). */
const GIFT_CREDENTIALS_STALE_MS = 60_000;
/** 내 키를 먼저 쓰다 크레딧이 떨어졌을 때, 내 키 잔액이 이만큼 다시 생기면 내 키로 돌아간다. */
const OWN_RESUME_BALANCE_USD = 1;
/** 선물 크레딧을 쓰는 데스크톱 플랫폼. */
const GIFT_PLATFORMS = new Set(['darwin', 'win32']);
const GIFT_LEASE_MAX_BYTES = 16 * 1024;
const GIFT_RECENT_LEASES = 8;
/** 이보다 적게 남은 선물은 402 를 받으면 다 쓴 것으로 본다 (요청 하나도 치르기 어렵다). */
const GIFT_EXHAUSTED_BELOW_USD = 0.5;
/** 다 쓴 선물도 서버 잔액이 그 뒤로 본 가장 낮은 값보다 이만큼 늘면(한도를 늘려 준 경우) 다시 쓴다. */
const GIFT_RESUME_STEP_USD = 1;
const INSTALL_PROGRESS = Object.freeze({
  preparing: 8,
  downloadStart: 12,
  downloadEnd: 58,
  installStart: 64,
  installEnd: 86,
  configuring: 92,
  verifying: 97,
  done: 100,
});

/** 허브가 쓰는 파일들. 쓰다 끊긴 `<이름>.tmp-*` 는 다음 동기화에서 지운다. */
const HUB_OWNED_AGENT_FILES = ['models.json', 'settings.json'];
const HUB_OWNED_ROOT_FILES = [CONFIG_FILE];
/** 이보다 오래된 임시 파일만 지운다 — 같은 루트를 쓰는 다른 허브가 지금 쓰는 중일 수 있다. */
const STALE_TEMP_MS = 60_000;

/**
 * @typedef {Object} PiModelConfig
 * @property {string} id OpenRouter 모델 id
 * @property {string} name 사용자가 붙인 표시 이름
 * @property {boolean} reasoning
 * @property {boolean} supportsImages
 * @property {string[]} efforts
 * @property {string|null} defaultEffort
 * @property {number|null} contextLength
 * @property {number|null} [maxOutputTokens] 카탈로그의 출력 토큰 상한. null 은 카탈로그에 값이 없다는 뜻이다
 * @property {{ prompt: number, completion: number, cacheRead?: number }} pricing
 *
 * maxOutputTokens 와 pricing.cacheRead 는 예전 config.json 에 없던 필드다. 필드가 아예 없으면
 * (메모리에서도 키 없음) 아직 카탈로그로 채우지 못한 것이고, syncAssets 가 다시 시도한다.
 */

/**
 * @typedef {Object} PiStatus
 * @property {boolean} installed
 * @property {boolean} installing
 * @property {string|null} version
 * @property {boolean} keyConfigured
 * @property {string|null} keyTail
 * @property {PiModelConfig[]} models
 * @property {string|null} defaultModelId
 * @property {boolean} setupComplete
 * @property {string|null} latestVersion 고정 버전(PI_VERSION). 레지스트리에서 확인한 뒤에만 채운다
 * @property {boolean} updateRequired 설치본이 고정 버전과 다르다
 * @property {string|null} error
 * @property {'gift'|'own'|'none'} credential Pi 가 지금 쓰는 자격. gift 면 models/defaultModelId 는 선물 모델이다
 * @property {GiftOrder} giftOrder 내 키가 있을 때 선물을 쓰는 순서
 */

/**
 * 내 OpenRouter 키가 있을 때 선물 크레딧을 쓰는 순서.
 * first: 선물을 먼저 쓰고 다 쓰면 내 키. after: 내 키를 먼저 쓰고 그 크레딧이 떨어지면 선물.
 * @typedef {'first'|'after'} GiftOrder
 */
export const GIFT_ORDERS = /** @type {const} */ (['first', 'after']);
const DEFAULT_GIFT_ORDER = 'first';

function normalizeGiftOrder(value) {
  return GIFT_ORDERS.includes(value) ? value : DEFAULT_GIFT_ORDER;
}

function piError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function throwIfAuthCancelled(signal) {
  if (signal?.aborted) {
    throw piError('AGENT_AUTH_CANCELLED', '로그인을 취소했어요.');
  }
}

function authRollbackError(original, rollback) {
  const error = new AggregateError(
    [original, rollback],
    'Authentication failed and its credential rollback also failed.',
    { cause: original },
  );
  error.code = 'AGENT_AUTH_ROLLBACK_FAILED';
  return error;
}

function modelRollbackError(original, rollback) {
  const error = new AggregateError(
    [original, rollback],
    'Model configuration failed and its settings rollback also failed.',
    { cause: original },
  );
  error.code = 'PI_MODELS_ROLLBACK_FAILED';
  return error;
}

function stderrTail(text) {
  return String(text ?? '')
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-4)
    .join(' / ')
    .slice(-STDERR_TAIL_LIMIT);
}

function appendUtf8Tail(current, chunk, maxBytes) {
  const combined = Buffer.concat([Buffer.from(current, 'utf8'), Buffer.from(chunk)]);
  if (combined.byteLength <= maxBytes) return combined.toString('utf8');
  let start = combined.byteLength - maxBytes;
  while (start < combined.byteLength && (combined[start] & 0xc0) === 0x80) start += 1;
  return combined.subarray(start).toString('utf8');
}

/** 토큰 1개당 USD → 100만 토큰당 USD. 부동소수 찌꺼기는 6자리에서 자른다. */
function perMillion(price) {
  return Math.round(Number(price) * 1e12) / 1e6;
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function nonNegativePrice(value) {
  const price = Number(value);
  return Number.isFinite(price) && price >= 0 ? price : 0;
}

/** 카탈로그의 출력 상한. 컨텍스트 창을 알면 그보다 크게 잡지 않는다. 모르면 null. */
function outputCeiling(maxCompletionTokens, contextLength) {
  const ceiling = positiveInteger(maxCompletionTokens);
  const context = positiveInteger(contextLength);
  return ceiling !== null && context !== null ? Math.min(ceiling, context) : ceiling;
}

/** 예전 config.json 에서 읽어 카탈로그 필드가 아직 비어 있는 모델. */
function needsCatalogFields(model) {
  return model.maxOutputTokens === undefined || model.pricing.cacheRead === undefined;
}

/** 이벤트마다 새로 시작하는 선물 설정. order 는 사용자의 고른 순서라 이벤트가 바뀌어도 남긴다. */
function emptyGiftConfig(eventId = null, order = DEFAULT_GIFT_ORDER) {
  return {
    eventId, models: [], defaultModelId: null, exhaustedAt: null, exhaustedRemainingUsd: null,
    order, ownExhaustedAt: null,
  };
}

function isGiftModelId(id) {
  return typeof id === 'string' && id.startsWith(GIFT_MODEL_PREFIX);
}

/** 모델 id 의 버전 숫자. 날짜 꼬리는 뺀다 — 'anthropic/claude-sonnet-4.5' → [4, 5]. */
function modelVersion(id) {
  return (id.split('/').pop().match(/\d+/g) ?? []).map(Number).filter((part) => part < 1000);
}

function compareVersions(a, b) {
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const diff = (a[index] ?? -1) - (b[index] ?? -1);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * 선물 카탈로그에서 기본 모델을 고른다: 가장 새 Sonnet, Haiku, Opus 순서. 변형(`:thinking` 등)은 뺀다.
 * 셋 다 없으면 첫 Claude 모델 하나.
 *
 * @param {Array<{ id: string }>} catalog
 */
export function pickDefaultGiftModels(catalog) {
  const entries = (Array.isArray(catalog) ? catalog : [])
    .filter((entry) => isGiftModelId(entry?.id) && !entry.id.includes(':'));
  const picks = [];
  for (const family of GIFT_DEFAULT_FAMILIES) {
    const pattern = new RegExp(`(?:^|[^a-z])${family}(?:[^a-z]|$)`);
    let best = null;
    for (const entry of entries) {
      if (!pattern.test(entry.id.slice(GIFT_MODEL_PREFIX.length))) continue;
      if (!best || compareVersions(modelVersion(entry.id), modelVersion(best.id)) > 0) best = entry;
    }
    if (best) picks.push(best);
  }
  return picks.length > 0 ? picks.slice(0, MAX_MODELS) : entries.slice(0, 1);
}

/** 선물 프록시 주소. https, 또는 개발용 루프백 http 만 받는다. OpenRouter 주소는 받지 않는다. */
function giftBaseUrl(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  let url;
  try { url = new URL(raw.trim()); } catch { return null; }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) return null;
  if (url.hostname === 'openrouter.ai' || url.hostname.endsWith('.openrouter.ai')) return null;
  if (url.username || url.password || url.search || url.hash) return null;
  return url.toString().replace(/\/+$/, '');
}

/** 데스크톱이 준 GiftCredentials 를 믿지 않고 다시 확인한다. 리스는 활성일 때만 남긴다. */
function normalizeGiftCredentials(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const rawLease = typeof raw.lease === 'string' ? raw.lease.trim() : '';
  const lease = rawLease && textFitsByteLimit(rawLease, GIFT_LEASE_MAX_BYTES) && !/[\s\x00-\x1f\x7f]/u.test(rawLease)
    ? rawLease
    : null;
  const baseUrl = giftBaseUrl(raw.baseUrl);
  const eventId = typeof raw.eventId === 'string' && raw.eventId.trim() && raw.eventId.length <= 128
    ? raw.eventId.trim()
    : null;
  const remainingUsd = Number.isFinite(raw.remainingUsd) ? raw.remainingUsd : null;
  const active = raw.available === true && raw.active === true && Boolean(lease && baseUrl && eventId)
    && (remainingUsd === null || remainingUsd > 0);
  return {
    available: raw.available === true,
    active,
    lease: active ? lease : null,
    baseUrl,
    eventId,
    amountUsd: Number.isFinite(raw.amountUsd) ? raw.amountUsd : null,
    remainingUsd,
    claimed: raw.claimed === true,
  };
}

/** 서명된 라이선스 리스 모양(`base64url(JSON).base64url(서명)`). OpenRouter 키는 이 모양이 아니다. */
function looksLikeLease(key) {
  const match = /^([A-Za-z0-9_-]{16,})\.([A-Za-z0-9_-]{16,})$/.exec(key);
  if (!match) return false;
  try {
    const payload = JSON.parse(Buffer.from(match[1], 'base64url').toString('utf8'));
    return Boolean(payload && typeof payload === 'object' && 'keyId' in payload);
  } catch {
    return false;
  }
}

/**
 * RHWP_PI_ROUTING_SORT 값을 정리한다. 모르는 값이나 빈 값은 throughput 으로 본다.
 *
 * @param {unknown} raw
 * @returns {string} latency | throughput | price | off
 */
export function normalizePiRoutingSort(raw) {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  return ROUTING_SORTS.has(value) ? value : DEFAULT_ROUTING_SORT;
}

function keyTailOf(key) {
  const trimmed = String(key ?? '').trim();
  return trimmed ? trimmed.slice(-4) : null;
}

function normalizedModelId(raw) {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  return value.length > 0
    && value.length <= PI_MODEL_ID_MAX_CHARS
    && !/[\s\x00-\x1f\x7f]/u.test(value)
    ? value
    : null;
}

function normalizedModelName(raw, fallback) {
  const value = typeof raw === 'string' && raw.trim() ? raw.trim() : fallback;
  return typeof value === 'string'
    && value.length > 0
    && value.length <= PI_MODEL_NAME_MAX_CHARS
    && !/[\x00-\x1f\x7f]/u.test(value)
    ? value
    : null;
}

async function boundedJsonResponse(response, limit = OAUTH_RESPONSE_LIMIT_BYTES) {
  try {
    return await readResponseJsonBounded(response, {
      maxBytes: limit,
      label: 'OpenRouter OAuth response',
    }) ?? {};
  } catch (error) {
    if (error?.code === 'RESPONSE_BODY_TOO_LARGE') {
      throw piError('OPENROUTER_OAUTH_RESPONSE_TOO_LARGE', 'OpenRouter 로그인 응답이 너무 커요');
    }
    if (error instanceof SyntaxError) return {};
    throw error;
  }
}

/** reasoning 모델에만 붙는다 — pi 의 thinking 레벨을 OpenRouter effort 로 매핑한다. */
function thinkingLevelMap() {
  return {
    off: null,
    minimal: 'minimal',
    low: 'low',
    medium: 'medium',
    high: 'high',
    xhigh: null,
    max: null,
  };
}

export function defaultPiRoot(env = process.env, platform = process.platform, home = os.homedir()) {
  const platformPath = platform === 'win32' ? path.win32 : path.posix;
  if (env.RHWP_PI_DIR) return platformPath.resolve(env.RHWP_PI_DIR);
  if (platform === 'darwin') return platformPath.join(home, 'Library', 'Application Support', 'rhwp', 'pi');
  if (platform === 'win32') {
    return platformPath.join(env.APPDATA || platformPath.join(home, 'AppData', 'Roaming'), 'rhwp', 'pi');
  }
  return platformPath.join(env.XDG_DATA_HOME || platformPath.join(home, '.local', 'share'), 'rhwp', 'pi');
}

/**
 * pi CLI 설치본과 그 에이전트 홈(모델·키·설정)을 관리한다. 확장·스킬은 앱 번들에서 바로 싣는다.
 * 설치는 single-flight 이고, 루트가 없어도 status() 는 그냥 미설치로 답한다.
 *
 * @param {{ rootDir?: string, spawnProcess?: typeof spawn, fetchImpl?: typeof fetch,
 *           now?: () => number, openRouter?: ReturnType<typeof createOpenRouter>,
 *           npmCommand?: string, nodeCommand?: string, packageSpec?: string, platform?: string,
 *           baseEnv?: NodeJS.ProcessEnv, secretStore?: object,
 *           tarballMaxBytes?: number, oauthExchangeTimeoutMs?: number,
 *           replaceFile?: typeof replaceFileAtomically,
 *           writeNodeHostFile?: typeof import('node:fs/promises').writeFile,
 *           routingSort?: string, giftSource?: { available: boolean, credentials: Function } | null,
 *           giftClientFactory?: (options: { baseUrl: string }) => ReturnType<typeof createOpenRouter> }} [deps]
 *   routingSort: OpenRouter 제공자 정렬 (latency|throughput|price|off). 기본 throughput
 *   giftSource: 선물 크레딧 자격 (gift-source.mjs). macOS·Windows 에서만 쓴다
 */
export function createPiManager({
  rootDir = defaultPiRoot(),
  spawnProcess = spawn,
  fetchImpl = globalThis.fetch,
  now = Date.now,
  openRouter = null,
  npmCommand = null,
  nodeCommand = process.execPath,
  packageSpec = PI_PACKAGE,
  platform = process.platform,
  baseEnv = process.env,
  secretStore = null,
  tarballMaxBytes = PI_TARBALL_MAX_BYTES,
  oauthExchangeTimeoutMs = OAUTH_EXCHANGE_TIMEOUT_MS,
  replaceFile = replaceFileAtomically,
  writeNodeHostFile,
  routingSort = DEFAULT_ROUTING_SORT,
  giftSource = null,
  giftClientFactory = null,
} = {}) {
  const providerSort = normalizePiRoutingSort(routingSort);
  const tarballLimitBytes = Number.isSafeInteger(tarballMaxBytes) && tarballMaxBytes > 0
    ? Math.min(tarballMaxBytes, PI_TARBALL_MAX_BYTES)
    : PI_TARBALL_MAX_BYTES;
  const oauthTimeoutMs = Number.isSafeInteger(oauthExchangeTimeoutMs) && oauthExchangeTimeoutMs > 0
    ? Math.min(oauthExchangeTimeoutMs, OAUTH_EXCHANGE_TIMEOUT_MS)
    : OAUTH_EXCHANGE_TIMEOUT_MS;
  const prefixDir = path.join(rootDir, 'prefix');
  const agentDir = path.join(rootDir, 'agent');
  const sessionsDir = path.join(rootDir, 'sessions');
  const configPath = path.join(rootDir, CONFIG_FILE);
  const modelsPath = path.join(agentDir, 'models.json');
  const settingsPath = path.join(agentDir, 'settings.json');
  /**
   * 선물 크레딧 전용 에이전트 홈. provider id 는 그대로 openrouter 다 — Pi 는 이 id 일 때만
   * Anthropic cache_control 을 붙인다. 주소만 선물 프록시이고 apiKey 는 두지 않는다 (리스는 env 로만).
   * 내 키 세션과 홈이 갈라져 있어 하위 에이전트까지 키와 주소가 섞이지 않는다.
   */
  const giftAgentDir = path.join(rootDir, 'agent-gift');
  const giftModelsPath = path.join(giftAgentDir, 'models.json');
  const giftSettingsPath = path.join(giftAgentDir, 'settings.json');
  /** 예전 허브가 번들 스킬을 복사해 두던 곳. 지금은 번들에서 바로 싣고 이 사본은 지운다. */
  const legacySkillsDir = path.join(agentDir, 'skills');
  /** 정확한 버전이 박힌 스펙이면 그대로, 아니면 고정 버전을 붙여 npm 폴백도 같은 버전을 깐다. */
  const installSpec = packageSpec.lastIndexOf('@') > 0 ? packageSpec : `${packageSpec}@${PI_VERSION}`;
  const piBin = path.join(prefixDir, 'node_modules', '.bin', platform === 'win32' ? 'pi.cmd' : 'pi');
  const packageJsonPath = (basePrefix = prefixDir) => path.join(
    basePrefix, 'node_modules', ...packageSpec.split('/'), 'package.json',
  );
  const client = openRouter ?? createOpenRouter({ fetchImpl, now, cacheDir: rootDir });
  const makeGiftClient = giftClientFactory ?? (({ baseUrl }) => createOpenRouter({
    fetchImpl, now, baseUrl, keyInfoPath: '/auth/key', cacheDir: null, platform,
  }));
  const giftEnabled = GIFT_PLATFORMS.has(platform) && giftSource?.available === true;
  const npmLaunch = bundledNpmLaunch({ nodeCommand, npmCommand });
  const ensureNodeHost = createNodeHost({
    rootDir, nodeCommand, platform, writeFile: writeNodeHostFile,
  });

  let config = {
    version: CONFIG_VERSION,
    installedVersion: null,
    keyTail: null,
    models: [],
    defaultModelId: null,
    setupComplete: false,
    gift: emptyGiftConfig(),
  };
  /** 실제 키는 Electron의 OS-backed vault 안에만 산다. */
  let apiKey = null;
  /** 마지막으로 받은 선물 자격. 리스는 메모리에만 둔다. */
  let giftCredentials = null;
  let giftCheckedAt = 0;
  let giftClient = null;
  let giftClientBase = null;
  /** agent-gift/models.json 에 마지막으로 쓴 내용과 그 주소. 같은 내용이면 다시 쓰지 않는다. */
  let giftWrittenText = null;
  let giftWrittenBase = null;
  let giftRefreshChain = Promise.resolve();
  /** 최근에 받은 리스들. 라우터가 이 값들만 선물 프록시로 보낸다. */
  const recentLeases = [];
  /** @type {Promise<void> | null} 첫 로드는 한 번만 돈다 — 동시에 들어와도 공유한다. */
  let loadPromise = null;
  let installedVersion = null;
  let installing = false;
  let lastError = null;
  let latestVersion = null;
  let updateRequired = false;
  let secretStoreError = null;
  /** @type {Promise<PiStatus> | null} */
  let installInFlight = null;
  let installProcess = null;
  let installCancelled = false;
  const installCleanupPromises = new WeakMap();
  /** @type {Set<(progress: { state: string, detail?: string }) => void>} */
  const installListeners = new Set();
  /** 설정 파일 쓰기는 직렬화한다 — 키/모델 갱신이 겹쳐도 순서가 흐트러지지 않도록. */
  let writeChain = Promise.resolve();
  let tempSeq = 0;
  /** close() 뒤에는 새 쓰기를 받지 않는다 — 종료 중인 프로세스가 임시 파일을 남기지 않게. */
  let closed = false;
  /** @type {Set<Promise<void>>} 시작된 writeAtomic. close() 가 모두 끝나길 기다린다. */
  const inflightWrites = new Set();
  /** 진행 중인 OpenRouter PKCE 로그인. 브라우저 콜백이 오면 한 번만 소비한다. */
  let oauthFlow = null;

  function writeAtomic(file, text, mode = 0o600) {
    if (closed) return Promise.reject(piError('PI_MANAGER_CLOSED', 'Pi 설정은 허브 종료 중에 쓸 수 없어요'));
    const write = writeAtomicNow(file, text, mode);
    const settled = write.then(() => {}, () => {});
    inflightWrites.add(settled);
    void settled.then(() => inflightWrites.delete(settled));
    return write;
  }

  async function writeAtomicNow(file, text, mode) {
    if (Buffer.byteLength(text, 'utf8') > PI_SETTINGS_MAX_BYTES) {
      throw piError(
        'PI_SETTINGS_TOO_LARGE',
        `Pi 설정 파일은 ${PI_SETTINGS_MAX_BYTES}바이트를 넘을 수 없어요`,
      );
    }
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temp = `${file}.tmp-${process.pid}-${now()}-${(tempSeq += 1)}`;
    try {
      await fs.writeFile(temp, text, { encoding: 'utf8', mode, flag: 'wx' });
      await replaceFile(temp, file, { platform });
    } finally {
      await fs.rm(temp, { force: true }).catch(() => {});
    }
  }

  function serialized(task) {
    const next = writeChain.then(task, task);
    writeChain = next.then(() => {}, () => {});
    return next;
  }

  function normalizeStoredModel(raw) {
    const id = normalizedModelId(raw?.id);
    if (!id) return null;
    const name = normalizedModelName(raw?.name, id);
    if (!name) return null;
    const reasoning = Boolean(raw.reasoning);
    const efforts = reasoning && Array.isArray(raw.efforts)
      ? raw.efforts.filter((effort) => EFFORTS.includes(effort))
      : (reasoning ? [...EFFORTS] : []);
    const defaultEffort = efforts.includes(raw.defaultEffort)
      ? raw.defaultEffort
      : (efforts.length > 0 ? DEFAULT_EFFORT : null);
    const contextLength = Number(raw.contextLength);
    // 필드가 없으면 키도 두지 않는다 — 아직 이관하지 않았다는 표시다 (PiModelConfig 참고).
    const cacheRead = raw?.pricing?.cacheRead;
    return {
      id,
      name,
      reasoning,
      supportsImages: raw.supportsImages === true,
      efforts,
      defaultEffort,
      contextLength: Number.isFinite(contextLength) && contextLength > 0 ? Math.round(contextLength) : null,
      ...(raw.maxOutputTokens === undefined
        ? {}
        : { maxOutputTokens: positiveInteger(raw.maxOutputTokens) }),
      pricing: {
        prompt: Number(raw?.pricing?.prompt) || 0,
        completion: Number(raw?.pricing?.completion) || 0,
        ...(cacheRead === undefined ? {} : { cacheRead: nonNegativePrice(cacheRead) }),
      },
    };
  }

  async function readInstalledVersion(basePrefix = prefixDir) {
    try {
      const raw = JSON.parse(await readUtf8FileBounded(packageJsonPath(basePrefix), {
        maxBytes: PI_PACKAGE_MANIFEST_MAX_BYTES,
        label: 'Pi package manifest',
        platform,
      }));
      return typeof raw?.version === 'string' && raw.version ? raw.version : null;
    } catch {
      return null;
    }
  }

  async function readLegacyStoredKey() {
    try {
      const raw = JSON.parse(await readUtf8FileBounded(modelsPath, {
        maxBytes: PI_SETTINGS_MAX_BYTES,
        label: 'Pi models config',
        platform,
      }));
      const key = raw?.providers?.openrouter?.apiKey;
      if (!textFitsByteLimit(key, API_KEY_MAX_BYTES)) return null;
      const trimmed = key.trim();
      return trimmed || null;
    } catch {
      return null;
    }
  }

  async function readConfig() {
    try {
      const raw = JSON.parse(await readUtf8FileBounded(configPath, {
        maxBytes: PI_SETTINGS_MAX_BYTES,
        label: 'Pi config',
        platform,
      }));
      const models = (Array.isArray(raw?.models) ? raw.models : [])
        .map(normalizeStoredModel)
        .filter(Boolean)
        .slice(0, MAX_MODELS);
      const defaultModelId = models.some((model) => model.id === raw?.defaultModelId)
        ? raw.defaultModelId
        : (models[0]?.id ?? null);
      const giftModels = (Array.isArray(raw?.gift?.models) ? raw.gift.models : [])
        .map(normalizeStoredModel)
        .filter((model) => model && isGiftModelId(model.id))
        .slice(0, MAX_MODELS);
      const giftExhaustedAt = Number(raw?.gift?.exhaustedAt);
      config = {
        version: CONFIG_VERSION,
        installedVersion: typeof raw?.installedVersion === 'string' ? raw.installedVersion : null,
        keyTail: typeof raw?.keyTail === 'string' ? raw.keyTail : null,
        models,
        defaultModelId,
        setupComplete: false,
        gift: {
          eventId: typeof raw?.gift?.eventId === 'string' ? raw.gift.eventId : null,
          models: giftModels,
          defaultModelId: giftModels.some((model) => model.id === raw?.gift?.defaultModelId)
            ? raw.gift.defaultModelId
            : (giftModels[0]?.id ?? null),
          exhaustedAt: Number.isFinite(giftExhaustedAt) && giftExhaustedAt > 0 ? giftExhaustedAt : null,
          exhaustedRemainingUsd: Number.isFinite(raw?.gift?.exhaustedRemainingUsd) && raw.gift.exhaustedRemainingUsd >= 0
            ? raw.gift.exhaustedRemainingUsd
            : null,
          order: normalizeGiftOrder(raw?.gift?.order),
          ownExhaustedAt: Number.isFinite(raw?.gift?.ownExhaustedAt) && raw.gift.ownExhaustedAt > 0
            ? raw.gift.ownExhaustedAt
            : null,
        },
      };
    } catch {
      // 설정 파일이 없거나 깨졌으면 빈 상태로 시작한다.
    }
    const legacyKey = await readLegacyStoredKey();
    if (secretStore?.available) {
      try {
        const stored = await secretStore.get(PI_SECRET_ID);
        if (stored != null && (!textFitsByteLimit(stored, API_KEY_MAX_BYTES) || !stored.trim())) {
          throw piError('OPENROUTER_KEY_TOO_LARGE', '저장된 OpenRouter 키가 허용된 길이를 넘었어요');
        }
        const storedKey = stored?.trim() || null;
        apiKey = storedKey;
        if (!apiKey && legacyKey) {
          await secretStore.set(PI_SECRET_ID, legacyKey);
          const migrated = await secretStore.get(PI_SECRET_ID);
          apiKey = textFitsByteLimit(migrated, API_KEY_MAX_BYTES) ? migrated.trim() : null;
          if (apiKey === legacyKey) await writeModelsJson();
        }
      } catch (error) {
        apiKey = legacyKey;
        secretStoreError = error?.message ?? 'OS 보안 저장소를 열지 못했어요.';
      }
    } else {
      // Preserve access until the desktop vault can migrate it; new keys are never stored here.
      apiKey = legacyKey;
    }
    installedVersion = await readInstalledVersion();
    config.setupComplete = Boolean(apiKey) && config.models.length > 0;
  }

  function load() {
    if (!loadPromise) loadPromise = readConfig();
    return loadPromise;
  }

  function persistConfig() {
    const payload = {
      version: CONFIG_VERSION,
      installedVersion: installedVersion ?? config.installedVersion ?? null,
      keyTail: config.keyTail,
      models: config.models,
      defaultModelId: config.defaultModelId,
      setupComplete: config.setupComplete,
      gift: config.gift,
    };
    return writeAtomic(configPath, `${JSON.stringify(payload, null, 2)}\n`);
  }

  /** models.json 의 모델 한 줄. maxTokens 가 null 이면 출력 토큰 필드를 두지 않는다. */
  function piModelEntry(model, maxTokens) {
    return {
      id: model.id,
      name: model.name,
      reasoning: model.reasoning,
      input: model.supportsImages ? ['text', 'image'] : ['text'],
      contextWindow: model.contextLength ?? DEFAULT_CONTEXT_WINDOW,
      ...(maxTokens === null ? {} : { maxTokens }),
      ...(model.reasoning ? { thinkingLevelMap: thinkingLevelMap() } : {}),
      // pi 는 이 값을 요청의 provider 필드로 그대로 보낸다.
      ...(providerSort === 'off'
        ? {}
        : { compat: { openRouterRouting: { require_parameters: true, sort: providerSort } } }),
      cost: {
        // OpenRouter 는 토큰 1개당 USD, pi 는 100만 토큰당 USD 를 쓴다.
        input: perMillion(model.pricing.prompt),
        output: perMillion(model.pricing.completion),
        cacheRead: perMillion(model.pricing.cacheRead ?? 0),
        cacheWrite: 0,
      },
    };
  }

  /** agent/models.json에는 비밀이 아닌 모델 설정만 쓴다. */
  async function writeModelsJson() {
    /** @type {Array<[string, { maxTokens: 0 }]>} */
    const unlimited = [];
    const models = config.models.map((model) => {
      const maxTokens = positiveInteger(model.maxOutputTokens);
      // 상한을 모르는 모델은 출력 토큰 필드를 아예 보내지 않게 한다. pi 는 models[] 정의의
      // maxTokens <= 0 을 거부하고, 빠진 maxTokens 는 16384 로 채운다. modelOverrides 의
      // maxTokens 0 만 검증 없이 들어가 max_tokens/max_completion_tokens 를 생략시킨다.
      if (maxTokens === null) unlimited.push([model.id, { maxTokens: 0 }]);
      return piModelEntry(model, maxTokens);
    });
    const provider = {
      baseUrl: OPENROUTER_BASE_URL,
      api: 'openai-completions',
      models,
      // fromEntries 는 '__proto__' 같은 id 도 평범한 키로 만든다.
      ...(unlimited.length > 0 ? { modelOverrides: Object.fromEntries(unlimited) } : {}),
    };
    // Vault가 없거나 현재 열리지 않으면 legacy 키를 보존한다. transport가
    // available이라고 광고하는 것만으로 유일한 사용 가능 복사본을 지우면 안 된다.
    // 검증된 vault 읽기/쓰기가 성공해 secretStoreError가 사라진 뒤에만 scrub한다.
    if (apiKey && (!secretStore?.available || secretStoreError)) provider.apiKey = apiKey;
    const payload = { providers: { openrouter: provider } };
    await writeAtomic(modelsPath, `${JSON.stringify(payload, null, 2)}\n`);
  }

  function settingsText() {
    return `${JSON.stringify({
      defaultProjectTrust: 'never',
      enableSkillCommands: false,
      enableInstallTelemetry: false,
    }, null, 2)}\n`;
  }

  /**
   * agent-gift/ 홈을 쓴다: 선물 프록시 주소와 선물 모델만 담고 apiKey 는 두지 않는다.
   * 출력 토큰은 서버 상한으로 자른다. 내용이 같으면 다시 쓰지 않는다.
   */
  async function writeGiftAgentFiles({ force = false } = {}) {
    const baseUrl = giftCredentials?.baseUrl;
    if (!baseUrl || config.gift.models.length === 0) return;
    const models = config.gift.models.map((model) => piModelEntry(
      model,
      Math.min(positiveInteger(model.maxOutputTokens) ?? GIFT_MAX_OUTPUT_TOKENS, GIFT_MAX_OUTPUT_TOKENS),
    ));
    const text = `${JSON.stringify({
      providers: { openrouter: { baseUrl, api: 'openai-completions', models } },
    }, null, 2)}\n`;
    if (!force && text === giftWrittenText) return;
    giftWrittenText = null;
    giftWrittenBase = null;
    await fs.mkdir(giftAgentDir, { recursive: true });
    await writeAtomic(giftSettingsPath, settingsText());
    await writeAtomic(giftModelsPath, text);
    // Pi 가 내려받은 rg/fd 는 agent/bin 에 있다. 선물 홈에서도 같은 것을 쓴다.
    // Windows 는 개발자 모드가 아니면 심볼릭 링크를 못 만든다. 디렉터리 정션은 권한 없이 된다(절대 경로만).
    const binLink = path.join(giftAgentDir, 'bin');
    const ownBin = path.join(agentDir, 'bin');
    if (platform !== 'linux' && !(await fs.lstat(binLink).catch(() => null))
      && (await fs.stat(ownBin).catch(() => null))?.isDirectory()) {
      await (platform === 'win32'
        ? fs.symlink(ownBin, binLink, 'junction')
        : fs.symlink(path.join('..', 'agent', 'bin'), binLink)).catch(() => {});
    }
    giftWrittenText = text;
    giftWrittenBase = baseUrl;
  }

  function giftExhaustedForEvent() {
    return Boolean(config.gift.exhaustedAt) && config.gift.eventId === giftCredentials?.eventId;
  }

  /** 선물로 Pi 를 돌릴 수 있는가. 자격·모델·홈 파일이 모두 지금 이벤트와 맞아야 한다. */
  function giftMode() {
    return giftEnabled
      && giftCredentials?.active === true
      && config.gift.eventId === giftCredentials.eventId
      && !config.gift.exhaustedAt
      && config.gift.models.length > 0
      && giftWrittenBase === giftCredentials.baseUrl;
  }

  function giftAccess() {
    return { mode: 'gift', key: giftCredentials.lease, agentDir: giftAgentDir, baseUrl: giftCredentials.baseUrl };
  }

  function ownAccess() {
    return { mode: 'own', key: apiKey, agentDir, baseUrl: OPENROUTER_BASE_URL };
  }

  /** 내 키를 먼저 쓰다(after) 크레딧이 떨어진 상태. 선물로 넘어간다. */
  function ownKeyExhausted() {
    return config.gift.order === 'after' && Boolean(config.gift.ownExhaustedAt);
  }

  /**
   * 우선순위. first(기본): 선물 > 내 키 > 없음.
   * after: 내 키 > 선물 > 없음. 내 키 크레딧이 떨어지면(ownExhaustedAt) 선물이 먼저다.
   * 둘 다 쓸 수 없으면 내 키를 다시 써 본다 — 그 사이 충전했을 수 있다.
   */
  function currentAccess() {
    const gift = giftMode();
    if (apiKey && config.gift.order === 'after' && !(gift && ownKeyExhausted())) return ownAccess();
    if (gift) return giftAccess();
    if (apiKey) return ownAccess();
    const giftUsedUp = giftEnabled && (giftExhaustedForEvent()
      || (giftCredentials?.claimed === true && giftCredentials.remainingUsd !== null && giftCredentials.remainingUsd <= 0));
    return { mode: 'none', key: null, agentDir, baseUrl: null, ...(giftUsedUp ? { reason: 'gift-exhausted' } : {}) };
  }

  function modeModels() {
    return currentAccess().mode === 'gift'
      ? { models: config.gift.models, defaultModelId: config.gift.defaultModelId }
      : { models: config.models, defaultModelId: config.defaultModelId };
  }

  function rememberLease(lease) {
    if (!lease || recentLeases.includes(lease)) return;
    recentLeases.push(lease);
    while (recentLeases.length > GIFT_RECENT_LEASES) recentLeases.shift();
  }

  function isGiftLease(key) {
    const trimmed = String(key ?? '').trim();
    return Boolean(trimmed) && (recentLeases.includes(trimmed) || looksLikeLease(trimmed));
  }

  function currentGiftClient() {
    const baseUrl = giftCredentials?.baseUrl;
    if (!giftEnabled || !baseUrl) {
      throw piError('GIFT_UNAVAILABLE', '선물 크레딧을 쓸 수 없습니다.');
    }
    if (!giftClient || giftClientBase !== baseUrl) {
      giftClient = makeGiftClient({ baseUrl });
      giftClientBase = baseUrl;
    }
    return giftClient;
  }

  async function giftCatalog(refresh, lease) {
    const models = await currentGiftClient().catalog(refresh, lease);
    return (Array.isArray(models) ? models : []).filter((entry) => isGiftModelId(normalizedModelId(entry?.id)));
  }

  /** 카탈로그 항목 → 저장할 모델 설정. */
  function modelConfigFromCatalog(entry, { id = entry.id, name = null, effortDefault } = {}) {
    const efforts = entry.reasoning ? [...EFFORTS] : [];
    return {
      id,
      name: name ?? normalizedModelName(entry.name, id) ?? id,
      reasoning: Boolean(entry.reasoning),
      supportsImages: entry.supportsImages === true,
      efforts,
      defaultEffort: efforts.includes(effortDefault)
        ? effortDefault
        : (efforts.length > 0 ? DEFAULT_EFFORT : null),
      contextLength: entry.contextLength ?? null,
      maxOutputTokens: outputCeiling(entry.maxCompletionTokens, entry.contextLength),
      pricing: {
        prompt: nonNegativePrice(entry.pricing?.prompt),
        completion: nonNegativePrice(entry.pricing?.completion),
        cacheRead: nonNegativePrice(entry.pricing?.cacheRead),
      },
    };
  }

  /**
   * 데스크톱에서 선물 자격을 다시 받고 상태를 맞춘다. 이벤트가 바뀌면 선물 설정을 새로 시작하고,
   * 처음이면 선물 카탈로그에서 기본 모델을 고른다. 실패는 던지지 않는다 — 선물이 꺼진 것으로 본다.
   */
  async function refreshGiftNow({ refresh = false } = {}) {
    await load();
    if (!giftEnabled || closed) return currentStatus();
    let next = null;
    try {
      next = normalizeGiftCredentials(await giftSource.credentials({ refresh }));
    } catch {
      // 데스크톱이 늦거나 잠깐 실패했다. 선물이 끝났다는 뜻이 아니니 마지막 자격을 지킨다.
      // 리스가 정말 거절되면 onAccessRejected 가 다시 받게 한다.
      next = giftCredentials;
    }
    giftCredentials = next;
    giftCheckedAt = now();
    await resumeOwnKeyIfFunded();
    if (!next?.active) {
      // 다 쓴 뒤 0 으로 보이는 잔액도 기준으로 삼아야, 그 뒤 조금 채운 크레딧에서 다시 쓴다.
      if (config.gift.exhaustedAt && config.gift.eventId === next?.eventId && next.remainingUsd !== null
        && next.remainingUsd < (config.gift.exhaustedRemainingUsd ?? 0) && !closed) {
        config.gift.exhaustedRemainingUsd = next.remainingUsd;
        await serialized(() => persistConfig()).catch(() => {});
      }
      return currentStatus();
    }
    rememberLease(next.lease);
    try {
      let changed = false;
      if (config.gift.eventId !== next.eventId) {
        config.gift = emptyGiftConfig(next.eventId, config.gift.order);
        changed = true;
      } else if (config.gift.exhaustedAt && next.remainingUsd !== null) {
        // 402 직후의 잔액은 늦게 줄 수 있다. 그 뒤로 본 가장 낮은 잔액을 기준으로 삼는다.
        const floor = config.gift.exhaustedRemainingUsd ?? 0;
        if (next.remainingUsd >= floor + GIFT_RESUME_STEP_USD) {
          config.gift.exhaustedAt = null;
          config.gift.exhaustedRemainingUsd = null;
          changed = true;
        } else if (next.remainingUsd < floor) {
          config.gift.exhaustedRemainingUsd = next.remainingUsd;
          changed = true;
        }
      }
      if (config.gift.models.length === 0 && !config.gift.exhaustedAt) {
        const picks = pickDefaultGiftModels(await giftCatalog(false, next.lease).catch(() => []));
        if (picks.length > 0) {
          // 카탈로그 이름('Anthropic: Claude Sonnet 5.5')에서 회사 이름을 떼어 사이드바에 짧게 보인다.
          config.gift.models = picks.map((entry) => modelConfigFromCatalog(entry, {
            name: normalizedModelName(String(entry.name ?? '').replace(/^Anthropic:\s*/i, ''), entry.id),
          }));
          config.gift.defaultModelId = config.gift.models[0].id;
          changed = true;
        }
      }
      if (closed) return currentStatus();
      await serialized(async () => {
        await writeGiftAgentFiles();
        if (changed) await persistConfig();
      });
    } catch {
      // 다음 새로고침에서 다시 쓴다. 홈 파일이 없으면 giftMode() 가 거짓이라 내 키로 돈다.
    }
    return currentStatus();
  }

  function refreshGift(options = {}) {
    const run = giftRefreshChain.then(() => refreshGiftNow(options));
    giftRefreshChain = run.then(() => {}, () => {});
    return run;
  }

  /**
   * 402 를 받았을 때 부른다. 선물을 다 쓴 이벤트는 다시 쓰지 않고 다음 스폰부터 내 키(없으면 없음)로 간다.
   * confirmed 가 아니면(잔액이 있는데 잠깐 거절된 402) 서버 잔액을 다시 보고, 거의 남지 않았을 때만 끝낸다.
   *
   * @param {{ confirmed?: boolean }} [options]
   */
  async function markGiftExhausted({ confirmed = true } = {}) {
    if (!confirmed) {
      await refreshGift({ refresh: true });
      const remaining = giftCredentials?.remainingUsd;
      if (!(remaining !== null && remaining !== undefined && remaining < GIFT_EXHAUSTED_BELOW_USD)) {
        return currentStatus();
      }
    }
    if (giftEnabled && config.gift.eventId && config.gift.eventId === giftCredentials?.eventId
      && !config.gift.exhaustedAt) {
      config.gift.exhaustedAt = now();
      config.gift.exhaustedRemainingUsd = giftCredentials?.remainingUsd ?? 0;
      if (!closed) void serialized(() => persistConfig()).catch(() => {});
    }
    return refreshGift({ refresh: true });
  }

  /**
   * 내 키를 먼저 쓰는 중(after)에 그 키가 402 를 받았을 때 부른다. 다음 스폰부터 선물을 쓴다.
   * first 순서이거나 선물을 쓸 수 없으면 아무것도 바꾸지 않는다.
   */
  async function markOwnKeyExhausted() {
    await load();
    if (config.gift.order !== 'after' || config.gift.ownExhaustedAt || !giftMode()) return currentStatus();
    config.gift.ownExhaustedAt = now();
    if (!closed) await serialized(() => persistConfig()).catch(() => {});
    return currentStatus();
  }

  /** 내 키 크레딧이 떨어져 선물로 넘어간 뒤, 내 키 잔액이 다시 생겼으면 내 키로 돌아간다. 실패는 무시한다. */
  async function resumeOwnKeyIfFunded() {
    if (!config.gift.ownExhaustedAt || !apiKey) return;
    try {
      const credits = await client.credits(apiKey, true);
      const balance = Number(credits?.balanceUsd);
      if (!(Number.isFinite(balance) && balance >= OWN_RESUME_BALANCE_USD)) return;
    } catch {
      return;
    }
    config.gift.ownExhaustedAt = null;
    if (!closed) await serialized(() => persistConfig()).catch(() => {});
  }

  /** 선물을 쓰는 순서를 바꾼다. 바꾸면 내 키 소진 표시는 지운다. */
  async function setGiftOrder(order) {
    await load();
    if (!GIFT_ORDERS.includes(order)) throw piError('PI_GIFT_ORDER_INVALID', '알 수 없는 순서입니다.');
    if (config.gift.order === order) return currentStatus();
    return serialized(async () => {
      const previous = { order: config.gift.order, ownExhaustedAt: config.gift.ownExhaustedAt };
      config.gift.order = order;
      config.gift.ownExhaustedAt = null;
      try {
        await persistConfig();
      } catch (error) {
        Object.assign(config.gift, previous);
        throw error;
      }
      return currentStatus();
    });
  }

  /**
   * 선물 자격을 한 번도 받지 못했으면 받아 올 때까지 기다린다(오래 걸리면 timeoutMs 뒤에 돌아간다).
   * 세션을 열 때 불러 기동 직후 첫 요청이 선물 대신 내 키로 가지 않게 한다. 오래된 자격은 뒤에서 새로 받는다.
   */
  async function ensureGiftFresh({ timeoutMs = 3_000 } = {}) {
    await load();
    if (!giftEnabled || closed) return currentStatus();
    if (giftCheckedAt) {
      if (now() - giftCheckedAt > GIFT_CREDENTIALS_STALE_MS) void refreshGift().catch(() => {});
      return currentStatus();
    }
    let timer = null;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    });
    try {
      await Promise.race([refreshGift().catch(() => {}), timeout]);
    } finally {
      clearTimeout(timer);
    }
    return currentStatus();
  }

  /** 선물 프록시로 보낼 모델. 고른 선물 모델이 아니면 가장 싼 선물 모델로 바꾼다. */
  function giftChatModel(requested) {
    const models = config.gift.models;
    const found = models.find((model) => model.id === requested);
    if (found) return found;
    let cheapest = null;
    for (const model of models) {
      if (!cheapest || model.pricing.completion < cheapest.pricing.completion) cheapest = model;
    }
    if (!cheapest) throw piError('GIFT_UNAVAILABLE', '선물 크레딧을 쓸 수 없습니다.');
    return cheapest;
  }

  /**
   * createOpenRouter 와 같은 모양의 라우터. 키로만 길을 고른다 — 리스는 선물 프록시로만,
   * 그 밖의 키(내 OpenRouter 키)는 openrouter.ai 로만 간다.
   */
  const router = {
    async chat(options = {}) {
      if (!isGiftLease(options.key)) {
        try {
          return await client.chat(options);
        } catch (error) {
          // 내 키를 먼저 쓰는 중이면 크레딧이 떨어진 내 키 대신 선물로 넘긴다.
          if (error?.status === 402 && apiKey && String(options.key ?? '').trim() === apiKey) {
            void markOwnKeyExhausted();
          }
          throw error;
        }
      }
      const model = giftChatModel(options.model);
      const effort = typeof options.reasoningEffort === 'string' && options.reasoningEffort
        ? (EFFORTS.includes(options.reasoningEffort) ? options.reasoningEffort : 'high')
        : undefined;
      const { reasoningEffort: _effort, ...rest } = options;
      try {
        return await currentGiftClient().chat({
          ...rest,
          model: model.id,
          ...(effort && model.reasoning ? { reasoningEffort: effort } : {}),
        });
      } catch (error) {
        if (error?.status === 402) {
          void markGiftExhausted({ confirmed: /HamaEditor gift credit/i.test(String(error?.message ?? '')) });
        }
        throw error;
      }
    },
    async catalog(refresh = false, key = null) {
      return isGiftLease(key) ? giftCatalog(refresh, String(key).trim()) : client.catalog(refresh, key);
    },
    async credits(key, refresh = false) {
      return isGiftLease(key) ? currentGiftClient().credits(key, refresh) : client.credits(key, refresh);
    },
    async validateKey(key) {
      return isGiftLease(key) ? currentGiftClient().validateKey(key) : client.validateKey(key);
    },
    clearCache() {
      client.clearCache();
      giftClient?.clearCache?.();
    },
  };

  function snapshotSettingsState() {
    return {
      apiKey,
      config: structuredClone(config),
      secretStoreError,
      vaultSnapshot: /** @type {{ present: boolean, value: unknown } | null} */ (null),
    };
  }

  async function captureVaultSnapshot(previous) {
    if (!secretStore?.available) return;
    const value = await secretStore.get(PI_SECRET_ID);
    previous.vaultSnapshot = {
      present: value !== null && value !== undefined,
      value,
    };
  }

  async function rollbackSettingsState(previous, {
    restoreSecret = false,
    clearClientCache = false,
  } = {}) {
    apiKey = previous.apiKey;
    config = structuredClone(previous.config);
    secretStoreError = previous.secretStoreError;
    const rollbackErrors = [];
    if (restoreSecret && secretStore?.available) {
      try {
        if (!previous.vaultSnapshot) {
          throw new Error('Cannot restore a vault value that was not snapshotted.');
        }
        if (previous.vaultSnapshot.present) {
          await secretStore.set(PI_SECRET_ID, previous.vaultSnapshot.value);
        } else {
          await secretStore.delete(PI_SECRET_ID);
        }
      } catch (error) {
        rollbackErrors.push(error);
      }
    }
    try { await writeModelsJson(); } catch (error) { rollbackErrors.push(error); }
    try { await writeGiftAgentFiles(); } catch (error) { rollbackErrors.push(error); }
    try { await persistConfig(); } catch (error) { rollbackErrors.push(error); }
    if (clearClientCache) {
      try { client.clearCache(); } catch (error) { rollbackErrors.push(error); }
    }
    return rollbackErrors;
  }

  /**
   * 레지스트리에서 고정 버전(PI_VERSION)의 타르볼 주소와 무결성 해시를 알아낸다.
   * 버전이 박힌 스펙이면 npm 에 그대로 맡기려고 null 을 돌려준다.
   */
  async function resolveDist() {
    if (packageSpec.lastIndexOf('@') > 0) return null;
    const dist = await fetchLatestPackage(fetchImpl, packageSpec, REGISTRY_TIMEOUT_MS, PI_VERSION);
    if (!dist.tarball) throw new Error('registry: tarball 주소가 없어요');
    return dist;
  }

  /**
   * 타르볼을 직접 내려받아 바이트 단위 진행률을 emit 한다. content-length 가 없으면
   * totalBytes 는 null 이고, UI 는 새 바이트가 올 때만 움직이는 막대로 처리한다.
   * 무결성 실패는 PI_INSTALL_FAILED 로 던진다 — npm 폴백으로 넘어가지 않는다.
   */
  async function downloadTarball(dist, emit) {
    // 무결성 메타데이터가 없으면 검증 없이 설치하는 셈이므로 실패로 처리한다.
    if (!dist.integrity?.startsWith('sha512-')) {
      throw piError('PI_INSTALL_FAILED', 'pi 패키지 무결성 정보가 없어 설치할 수 없어요');
    }
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, INSTALL_TIMEOUT_MS);
    let response;
    try {
      response = await fetchImpl(dist.tarball, { signal: controller.signal });
    } catch (error) {
      clearTimeout(timeout);
      if (timedOut || error?.name === 'AbortError') {
        throw piError('PI_INSTALL_FAILED', 'pi 패키지 다운로드가 제한 시간 안에 끝나지 않았어요');
      }
      throw error;
    }
    if (!response.ok || !response.body) {
      clearTimeout(timeout);
      const error = new Error(`tarball HTTP ${response.status}`);
      await cancelResponseBody(response, error);
      throw error;
    }
    const declared = Number(response.headers?.get?.('content-length'));
    const totalBytes = Number.isSafeInteger(declared) && declared > 0 ? declared : null;
    if (totalBytes !== null && totalBytes > tarballLimitBytes) {
      const error = piError('PI_INSTALL_FAILED', 'pi 패키지가 256 MiB 다운로드 한도를 초과해요');
      controller.abort(error);
      try { await response.body.cancel?.(error); } catch {}
      clearTimeout(timeout);
      throw error;
    }
    const cacheDir = path.join(rootDir, 'cache');
    await fs.mkdir(cacheDir, { recursive: true });
    const filePath = path.join(cacheDir, 'pi-package.tgz');
    const hash = createHash('sha512');
    let receivedBytes = 0;
    let lastEmit = 0;
    const handle = await fs.open(filePath, 'w', 0o600);
    let reader = null;
    try {
      const consume = async (rawChunk) => {
        const chunk = Buffer.from(rawChunk);
        receivedBytes += chunk.length;
        if (receivedBytes > tarballLimitBytes) {
          const error = piError('PI_INSTALL_FAILED', 'pi 패키지가 256 MiB 다운로드 한도를 초과해요');
          controller.abort(error);
          try { await reader?.cancel?.(error); } catch {}
          throw error;
        }
        hash.update(chunk);
        await handle.write(chunk);
        const ts = now();
        if (ts - lastEmit >= PROGRESS_INTERVAL_MS) {
          lastEmit = ts;
          const percent = totalBytes
            ? INSTALL_PROGRESS.downloadStart
              + Math.min(1, receivedBytes / totalBytes)
                * (INSTALL_PROGRESS.downloadEnd - INSTALL_PROGRESS.downloadStart)
            : undefined;
          emit({
            state: 'downloading',
            receivedBytes,
            totalBytes,
            ...(Number.isFinite(percent) ? { percent } : {}),
          });
        }
      };
      if (response.body.getReader) {
        reader = response.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          await consume(value);
        }
      } else {
        for await (const rawChunk of response.body) await consume(rawChunk);
      }
    } catch (error) {
      controller.abort(error);
      try { await response.body.cancel?.(error); } catch {}
      await handle.close().catch(() => {});
      await fs.unlink(filePath).catch(() => {});
      if (timedOut || error?.name === 'AbortError') {
        throw piError('PI_INSTALL_FAILED', 'pi 패키지 다운로드가 제한 시간 안에 끝나지 않았어요');
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      reader?.releaseLock?.();
      await handle.close().catch(() => {});
    }
    if (`sha512-${hash.digest('base64')}` !== dist.integrity) {
      await fs.unlink(filePath).catch(() => {});
      throw piError('PI_INSTALL_FAILED', '내려받은 pi 패키지가 무결성 검증에 실패했어요');
    }
    emit({
      state: 'downloading',
      receivedBytes,
      totalBytes: totalBytes ?? receivedBytes,
      percent: INSTALL_PROGRESS.downloadEnd,
    });
    return filePath;
  }

  function throwIfInstallCancelled() {
    if (!installCancelled) return;
    throw piError('PI_INSTALL_FAILED', 'pi 설치를 취소했어요');
  }

  async function runNpmInstall(emit, localTarball = null, targetPrefix = prefixDir) {
    throwIfInstallCancelled();
    const shimDir = await ensureNodeHost();
    throwIfInstallCancelled();
    const argv = [
      'install', '--prefix', targetPrefix, '--no-fund', '--no-audit',
      // 폴백(npm 이 직접 내려받는) 경로에서는 http 로그가 활동 신호가 된다.
      localTarball ? '--loglevel=error' : '--loglevel=http',
      localTarball ?? installSpec,
    ];
    const launched = applyManagedCliLaunch(npmLaunch.command, [...npmLaunch.leadingArgs, ...argv], {
      // npm 수명 주기 스크립트는 허브의 토큰을 물려받지 않는다.
      platform, nodeCommand, env: withoutHubPrivateEnv(baseEnv), shimDir,
    });
    const npmEnv = launched.env;
    return new Promise((resolve, reject) => {
      let settled = false;
      let stderrText = '';
      let lastActivity = 0;
      let activityPercent = INSTALL_PROGRESS.installStart;
      let forcedError = null;
      /** @type {NodeJS.Timeout | null} */
      let timer = null;

      const done = (error, { retainProcess = false } = {}) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (!retainProcess && installProcess === proc) installProcess = null;
        if (error) reject(error);
        else resolve();
      };

      let proc;
      try {
        proc = spawnProcess(launched.command, launched.argv, {
          ...processTreeSpawnOptions(platform),
          stdio: ['ignore', 'pipe', 'pipe'], env: npmEnv,
        });
      } catch (error) {
        done(piError('PI_INSTALL_FAILED', setupFailureMessage(error, '', 'npm 실행에 실패했어요.')));
        return;
      }
      installProcess = proc;

      const cleanupProcess = () => {
        const current = installCleanupPromises.get(proc);
        if (current) return current;
        const cleanup = terminateAndWaitForProcessTreeExit(proc, {
          terminateProcess: terminateProcessTree,
          terminateOptions: { platform, spawnProcess, env: npmEnv },
        }).catch(() => false);
        installCleanupPromises.set(proc, cleanup);
        return cleanup;
      };
      const cleanupError = () => {
        const error = piError(
          'PI_INSTALL_CLEANUP_UNCERTAIN',
          'npm install 프로세스의 종료를 확인하지 못했어요. 앱을 다시 시작한 뒤 상태를 확인해 주세요.',
        );
        error.processCleanupUncertain = true;
        return error;
      };
      const finishAfterCleanup = (error) => {
        void cleanupProcess().then((cleaned) => {
          if (!cleaned) {
            done(cleanupError(), { retainProcess: true });
            return;
          }
          done(error);
        });
      };

      timer = setTimeout(() => {
        forcedError = piError('PI_INSTALL_FAILED', 'npm install 이 10분 안에 끝나지 않았어요');
        finishAfterCleanup(forcedError);
      }, INSTALL_TIMEOUT_MS);

      // npm 출력이 나올 때마다 "일이 진행 중" 신호를 흘린다 — 멈추면 UI 막대도 멈춘다.
      const noteActivity = () => {
        const ts = now();
        if (ts - lastActivity < PROGRESS_INTERVAL_MS) return;
        lastActivity = ts;
        activityPercent = Math.min(INSTALL_PROGRESS.installEnd, activityPercent + 1.5);
        emit({ state: 'installing', percent: activityPercent, activity: true });
      };
      proc.stdout?.on?.('data', noteActivity);
      proc.stdout?.on?.('error', () => {});
      proc.stderr?.on?.('data', (chunk) => {
        noteActivity();
        stderrText = appendUtf8Tail(stderrText, chunk, INSTALL_STDERR_LIMIT_BYTES);
      });
      proc.stderr?.on?.('error', () => {});
      proc.on('error', (error) => {
        if (forcedError) return;
        const hint = setupFailureMessage(error, '', '번들된 npm 런타임을 시작하지 못했어요.');
        const failure = piError('PI_INSTALL_FAILED', hint);
        if (installCleanupPromises.has(proc)) finishAfterCleanup(failure);
        else done(failure);
      });
      const finish = (code, signal) => {
        if (forcedError) return;
        let error = null;
        if (code === 0) {
          error = null;
        } else {
          const exit = signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`;
          const detail = stderrTail(stderrText);
          error = piError(
            'PI_INSTALL_FAILED',
            setupFailureMessage(null, detail, `pi 설치가 실패했어요 (${exit})`),
          );
        }
        if (installCleanupPromises.has(proc)) finishAfterCleanup(error);
        else done(error);
      };
      proc.on('close', finish);
      // 일부 스텁/플랫폼은 close 없이 exit 만 낸다 — 한 틱 늦춰 마감한다.
      proc.on('exit', (code, signal) => setImmediate(() => finish(code, signal)));
    });
  }

  function currentStatus() {
    const access = currentAccess();
    const { models, defaultModelId } = modeModels();
    return {
      installed: Boolean(installedVersion),
      installing,
      version: installedVersion,
      keyConfigured: Boolean(apiKey),
      keyTail: apiKey ? keyTailOf(apiKey) : null,
      models: models.map((model) => ({ ...model, pricing: { ...model.pricing } })),
      defaultModelId,
      // 선물 모드는 선물 모델이 있을 때만 켜지므로 그 자체로 설정이 끝난 것이다.
      setupComplete: access.mode === 'gift' ? true : config.setupComplete,
      latestVersion,
      updateRequired,
      error: lastError ?? secretStoreError,
      credential: access.mode,
      giftOrder: config.gift.order,
    };
  }

  /**
   * 예전 config.json 모델에 빠진 필드가 있을 때만 카탈로그를 받는다. 오프라인이거나 실패하면
   * null — 아는 값만으로 models.json 을 쓰고, 다음 동기화에서 다시 시도한다.
   */
  async function catalogForMigration() {
    if (!config.models.some(needsCatalogFields)) return null;
    try {
      const catalog = await client.catalog(false, apiKey);
      return Array.isArray(catalog) ? catalog : null;
    } catch {
      return null;
    }
  }

  /** 카탈로그에서 같은 id 를 찾아 빠진 필드만 채운다. 바뀐 게 있으면 true. */
  function enrichStoredModels(catalog) {
    if (!catalog) return false;
    const byId = new Map(catalog.flatMap((entry) => {
      const id = normalizedModelId(entry?.id);
      return id ? [[id, entry]] : [];
    }));
    let changed = false;
    config.models = config.models.map((model) => {
      const entry = needsCatalogFields(model) ? byId.get(model.id) : null;
      if (!entry) return model;
      changed = true;
      return {
        ...model,
        maxOutputTokens: model.maxOutputTokens === undefined
          ? outputCeiling(entry.maxCompletionTokens, model.contextLength)
          : model.maxOutputTokens,
        pricing: {
          ...model.pricing,
          cacheRead: model.pricing.cacheRead ?? nonNegativePrice(entry.pricing?.cacheRead),
        },
      };
    });
    return changed;
  }

  /** 허브 파일의 `.tmp-*` 형제 중 STALE_TEMP_MS 보다 오래된 것을 지운다. 키 사본이 남지 않게. */
  async function removeStaleTemps(dir, owners) {
    let names;
    try {
      names = await fs.readdir(dir);
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
    const cutoff = now() - STALE_TEMP_MS;
    await Promise.all(names
      .filter((name) => owners.some((owner) => name.startsWith(`${owner}.tmp-`)))
      .map(async (name) => {
        const file = path.join(dir, name);
        const stat = await fs.lstat(file).catch(() => null);
        if (stat?.isFile() && stat.mtimeMs < cutoff) await fs.rm(file, { force: true }).catch(() => {});
      }));
  }

  async function syncAssets(migrationCatalog = null) {
    await fs.mkdir(agentDir, { recursive: true });
    await fs.mkdir(sessionsDir, { recursive: true });
    // 확장·스킬은 pi/resources.mjs 가 매 스폰마다 -e/--skill 로 넘긴다. 이 파일에는 경로를 두지 않아
    // 개발 허브·벤치·패키지 앱이 같은 루트를 써도 서로의 설치 경로를 덮어쓰지 않는다.
    await writeAtomic(settingsPath, settingsText());
    const migrated = enrichStoredModels(migrationCatalog);
    // Rebuild the provider file on every startup so settings stay in sync.
    await writeModelsJson();
    if (migrated) await persistConfig();
    await fs.rm(legacySkillsDir, { recursive: true, force: true });
    await removeStaleTemps(agentDir, HUB_OWNED_AGENT_FILES);
    await removeStaleTemps(giftAgentDir, HUB_OWNED_AGENT_FILES);
    await removeStaleTemps(rootDir, HUB_OWNED_ROOT_FILES);
  }

  return {
    rootDir,
    prefixDir,
    agentDir,
    giftAgentDir,
    sessionsDir,
    configPath,
    modelsPath,
    settingsPath,
    piBin,
    /** 설치·업데이트가 도는 중인지. 데스크톱이 창 없이 허브를 내리기 전에 묻는다. */
    isInstalling: () => installing,
    extensionPath: PI_EXTENSION_PATH,
    subagentExtensionPath: PI_SUBAGENT_EXTENSION_PATH,
    skillsDir: PI_SKILLS_DIR,

    /** 루트를 만들고 저장된 설정을 읽는다. 루트가 없어도 실패하지 않는다. */
    async init() {
      await fs.mkdir(rootDir, { recursive: true }).catch(() => {});
      await recoverInterruptedFileReplacement(configPath, { platform });
      await recoverInterruptedFileReplacement(modelsPath, { platform });
      await recoverInterruptedFileReplacement(giftModelsPath, { platform });
      await load();
      return this;
    },

    /** 스폰 없이 파일만 본다 — 부팅/웰컴 푸시에서 자주 불린다. */
    async status() {
      await load();
      installedVersion = await readInstalledVersion();
      return currentStatus();
    },

    /**
     * 고정 버전 pi CLI 를 설치하고 Pi 홈 설정을 쓴다. 동시에 부르면 하나만 돈다.
     *
     * @param {(progress: { state: string, detail?: string, percent?: number,
     *   receivedBytes?: number, totalBytes?: number|null, activity?: boolean }) => void} [onProgress]
     * @returns {Promise<PiStatus>}
     */
    async install(onProgress) {
      if (typeof onProgress === 'function') installListeners.add(onProgress);
      const emit = (progress) => {
        for (const listener of installListeners) {
          try { listener(progress); } catch {}
        }
      };
      if (installInFlight) {
        try {
          return await installInFlight;
        } finally {
          if (typeof onProgress === 'function') installListeners.delete(onProgress);
        }
      }
      if (installProcess) {
        throw piError(
          'PI_INSTALL_CLEANUP_PENDING',
          '이전 npm install 프로세스의 종료를 확인하지 못했어요. 앱을 다시 시작한 뒤 재시도해 주세요.',
        );
      }
      installing = true;
      installCancelled = false;
      lastError = null;
      // await 없이 곧바로 in-flight 를 세워야 동시에 들어온 호출이 하나로 합쳐진다.
      const running = (async () => {
        try {
          await load();
          emit({ state: 'preparing', percent: INSTALL_PROGRESS.preparing });
          await fs.mkdir(prefixDir, { recursive: true });
          // 결정적 진행률: 타르볼을 직접 받아 바이트를 센다. 레지스트리/네트워크가
          // 협조하지 않으면 npm 폴백으로 넘어가 활동 신호만 흘린다.
          let tarballPath = null;
          try {
            emit({ state: 'downloading', percent: INSTALL_PROGRESS.downloadStart });
            const dist = shouldUseNpmNetworkPath(baseEnv) ? null : await resolveDist();
            if (dist) tarballPath = await downloadTarball(dist, emit);
          } catch (error) {
            if (error?.code === 'PI_INSTALL_FAILED') throw error; // 무결성 실패는 폴백 금지
            tarballPath = null;
          }
          emit({ state: 'installing', percent: INSTALL_PROGRESS.installStart });
          await runNpmInstall(emit, tarballPath);
          if (tarballPath) await fs.unlink(tarballPath).catch(() => {});
          emit({ state: 'configuring', percent: INSTALL_PROGRESS.configuring });
          await syncAssets();
          emit({ state: 'verifying', percent: INSTALL_PROGRESS.verifying });
          installedVersion = await readInstalledVersion();
          if (latestVersion === installedVersion) updateRequired = false;
          config.installedVersion = installedVersion;
          config.setupComplete = Boolean(apiKey) && config.models.length > 0;
          await serialized(() => persistConfig());
          installing = false;
          emit({ state: 'done', detail: installedVersion ?? undefined, percent: INSTALL_PROGRESS.done });
          return currentStatus();
        } catch (error) {
          lastError = error?.message ?? String(error);
          throw error;
        } finally {
          installing = false;
          installCancelled = false;
        }
      })();
      installInFlight = running;
      try {
        return await running;
      } finally {
        if (installInFlight === running) installInFlight = null;
        if (typeof onProgress === 'function') installListeners.delete(onProgress);
      }
    },

    /** 설치된 Pi 가 PI_VERSION 과 다르면 그 버전으로 바꾼다. 실패해도 현재 prefix 는 그대로 둔다. */
    async automaticUpdate({ canActivate = () => true } = {}) {
      await load();
      if (!installedVersion) return currentStatus();

      let dist;
      try {
        dist = await resolveDist();
      } catch {
        return currentStatus();
      }
      if (!dist) return currentStatus();
      latestVersion = dist.version;
      updateRequired = latestVersion !== installedVersion;
      if (!updateRequired) return currentStatus();

      let tarballPath = null;
      let cleanupUncertain = false;
      installCancelled = false;
      try {
        tarballPath = await downloadTarball(dist, () => {});
        await updatePrefixAtomically({
          prefixDir,
          label: 'pi',
          platform,
          canActivate,
          install: (stagingDir) => runNpmInstall(() => {}, tarballPath, stagingDir),
          verify: async (stagingDir) => {
            if (await readInstalledVersion(stagingDir) !== latestVersion) {
              throw piError('PI_UPDATE_FAILED', 'updated harness version did not verify');
            }
          },
        });
        installedVersion = await readInstalledVersion();
        config.installedVersion = installedVersion;
        updateRequired = installedVersion !== latestVersion;
        await serialized(() => persistConfig());
      } catch (error) {
        cleanupUncertain = error?.processCleanupUncertain === true;
        installedVersion = await readInstalledVersion();
        updateRequired = installedVersion !== latestVersion;
      } finally {
        installCancelled = false;
        if (tarballPath && !cleanupUncertain) await fs.unlink(tarballPath).catch(() => {});
      }
      return currentStatus();
    },

    /**
     * settings.json 과 models.json 을 다시 쓰고, 예전 허브가 남긴 스킬 사본과 임시 파일을 지운다.
     * 예전 설정이면 카탈로그로 빠진 모델 필드를 채운다. 네트워크는 쓰기 큐 밖에서 기다린다.
     */
    async syncAssets() {
      await load();
      const migrationCatalog = await catalogForMigration();
      if (closed) return currentStatus();
      await serialized(() => syncAssets(migrationCatalog));
      return currentStatus();
    },

    /**
     * 허브 종료 전에 부른다. 새 쓰기를 막고 이미 줄 선 쓰기가 끝나길 기다린다 — process.exit 가
     * 임시 파일을 쓰는 도중에 프로세스를 끊어 `.tmp-*` 를 남기지 않게.
     */
    async close() {
      closed = true;
      await Promise.all([writeChain, ...inflightWrites]);
    },

    /**
     * OpenRouter 키를 확인하고 OS-backed vault에 저장한다.
     *
     * @param {string} key
     * @param {{ signal?: AbortSignal, onCommitted?: () => void }} [opts]
     */
    async setApiKey(key, { signal, onCommitted } = {}) {
      if (typeof key !== 'string') {
        throw piError('OPENROUTER_KEY_INVALID', 'OpenRouter 키를 입력하세요');
      }
      const rawKey = key;
      if (!textFitsByteLimit(rawKey, API_KEY_MAX_BYTES)) {
        throw piError('OPENROUTER_KEY_TOO_LARGE', 'OpenRouter 키가 허용된 길이를 넘었어요');
      }
      const trimmed = rawKey.trim();
      if (!trimmed) throw piError('OPENROUTER_KEY_INVALID', 'OpenRouter 키를 입력하세요');
      await load();
      throwIfAuthCancelled(signal);
      const check = await client.validateKey(trimmed);
      throwIfAuthCancelled(signal);
      if (!check.valid) throw piError('OPENROUTER_KEY_INVALID', 'OpenRouter 키가 거절됐어요');
      await serialized(async () => {
        // Validation runs outside the write queue. Snapshot only after entering it so a
        // cancelled rollback can never overwrite a newer queued settings change.
        const previous = snapshotSettingsState();
        // readConfig may have fallen back after a transient vault read failure. Capture
        // the actual current value here, before mutation, so rollback never substitutes
        // stale in-memory state for a different credential that is still in the vault.
        await captureVaultSnapshot(previous);
        let commitStarted = false;
        try {
          throwIfAuthCancelled(signal);
          // 보안 저장소가 없으면 models.json(0600)에 보관한다. load() 가 읽고, vault 가
          // 생기면 기존 이관 경로가 vault 로 옮긴 뒤 파일에서 지운다.
          if (secretStore?.available) {
            throwIfAuthCancelled(signal);
            commitStarted = true;
            await secretStore.set(PI_SECRET_ID, trimmed);
            throwIfAuthCancelled(signal);
          }
          throwIfAuthCancelled(signal);
          commitStarted = true;
          apiKey = trimmed;
          secretStoreError = null;
          config.keyTail = keyTailOf(trimmed);
          // 새 키는 새 잔액이다. 내 키 소진 표시를 지운다.
          config.gift.ownExhaustedAt = null;
          config.setupComplete = config.models.length > 0;
          throwIfAuthCancelled(signal);
          await writeModelsJson();
          throwIfAuthCancelled(signal);
          await persistConfig();
          throwIfAuthCancelled(signal);
          onCommitted?.();
        } catch (error) {
          if (!commitStarted) throw error;
          // Any failure can land after an async vault/file write has taken effect. Restore
          // the exact pre-run state before releasing the write queue; the transaction is
          // not committed until onCommitted returns.
          const rollbackErrors = await rollbackSettingsState(previous, {
            restoreSecret: true,
            clearClientCache: true,
          });
          if (rollbackErrors.length > 0) {
            throw authRollbackError(
              error,
              new AggregateError(rollbackErrors, 'One or more credential rollback steps failed.'),
            );
          }
          throw error;
        }
      });
      client.clearCache();
      return currentStatus();
    },

    /** OpenRouter PKCE 로그인 URL을 만든다. 키 교환은 completeOAuth가 맡는다. */
    beginOAuth(callbackUrl) {
      const verifier = randomBytes(48).toString('base64url');
      const challenge = createHash('sha256').update(verifier).digest('base64url');
      const state = randomBytes(18).toString('base64url');
      oauthFlow = { verifier, state, createdAt: now() };
      const url = new URL('https://openrouter.ai/auth');
      const callback = new URL(callbackUrl);
      callback.searchParams.set('state', state);
      url.searchParams.set('callback_url', callback.toString());
      url.searchParams.set('code_challenge', challenge);
      url.searchParams.set('code_challenge_method', 'S256');
      url.searchParams.set('state', state);
      return { authUrl: url.toString(), state };
    },

    /**
     * 브라우저 콜백의 일회용 코드를 OpenRouter API 키로 바꾸고 기존 키 저장 경로를 탄다.
     * @param {string} code
     * @param {string} state
     * @param {{ signal?: AbortSignal, onCommitted?: () => void }} [options]
     */
    async completeOAuth(code, state, { signal, onCommitted } = {}) {
      throwIfAuthCancelled(signal);
      const flow = oauthFlow;
      if (!flow || now() - flow.createdAt > 10 * 60 * 1000) {
        if (oauthFlow === flow) oauthFlow = null;
        throw piError('OPENROUTER_OAUTH_EXPIRED', 'OpenRouter 로그인 요청이 만료됐어요');
      }
      if (state !== flow.state) {
        throw piError('OPENROUTER_OAUTH_INVALID', 'OpenRouter 로그인 응답을 확인하지 못했어요');
      }
      if (flow.completing) {
        throw piError('OPENROUTER_OAUTH_BUSY', 'OpenRouter 로그인을 이미 완료하고 있어요');
      }
      flow.completing = true;
      const controller = new AbortController();
      const exchangeSignal = signal
        ? AbortSignal.any([signal, controller.signal])
        : controller.signal;
      let rejectTimeout;
      const timeout = new Promise((_, reject) => { rejectTimeout = reject; });
      let rejectCancellation;
      const cancellation = new Promise((_, reject) => { rejectCancellation = reject; });
      const onAbort = () => {
        controller.abort();
        rejectCancellation(piError('AGENT_AUTH_CANCELLED', '로그인을 취소했어요.'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      const timer = setTimeout(() => {
        controller.abort();
        rejectTimeout(piError('OPENROUTER_OAUTH_TIMEOUT', 'OpenRouter 로그인 응답이 너무 느려요'));
      }, oauthTimeoutMs);
      try {
        const operation = (async () => {
          const response = await fetchImpl('https://openrouter.ai/api/v1/auth/keys', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              code: String(code ?? ''),
              code_verifier: flow.verifier,
              code_challenge_method: 'S256',
            }),
            signal: exchangeSignal,
          });
          const body = await boundedJsonResponse(response);
          throwIfAuthCancelled(exchangeSignal);
          if (!response.ok || typeof body?.key !== 'string' || !body.key) {
            throw piError('OPENROUTER_OAUTH_FAILED', 'OpenRouter 로그인을 완료하지 못했어요');
          }
          throwIfAuthCancelled(exchangeSignal);
          const status = await this.setApiKey(body.key, { signal: exchangeSignal, onCommitted });
          // onCommitted synchronously removes the exact auth run. If it did not,
          // the same signal still fences this late exchange from reporting success.
          throwIfAuthCancelled(exchangeSignal);
          return status;
        })();
        const status = await Promise.race([operation, timeout, cancellation]);
        if (oauthFlow === flow) oauthFlow = null;
        return status;
      } catch (error) {
        if (signal?.aborted) {
          if (oauthFlow === flow) oauthFlow = null;
          throw piError('AGENT_AUTH_CANCELLED', '로그인을 취소했어요.');
        }
        if (error?.name === 'AbortError') {
          throw piError('OPENROUTER_OAUTH_TIMEOUT', 'OpenRouter 로그인 응답이 너무 느려요');
        }
        throw error;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        if (oauthFlow === flow) flow.completing = false;
      }
    },

    async cancelSetup() {
      oauthFlow = null;
      installCancelled = true;
      const proc = installProcess;
      if (!proc) return false;
      let cleanup = installCleanupPromises.get(proc);
      if (!cleanup) {
        cleanup = terminateAndWaitForProcessTreeExit(proc, {
          terminateProcess: terminateProcessTree,
          terminateOptions: { platform, spawnProcess, env: baseEnv },
        }).catch(() => false);
        installCleanupPromises.set(proc, cleanup);
      }
      return cleanup;
    },

    /**
     * 쓸 모델을 최대 3개 고른다. id 는 라이브 카탈로그로 검증한다. 선물 모드에서는 선물
     * 카탈로그로 검증하고 선물 모델만 바꾼다 — 내 키의 모델은 그대로 둔다.
     *
     * @param {Array<{ id: string, name?: string, effortDefault?: string }>} models
     */
    async setModels(models) {
      await load();
      const gift = currentAccess().mode === 'gift';
      const requested = Array.isArray(models) ? models : [];
      if (requested.length === 0) throw piError('PI_MODELS_EMPTY', '모델을 하나 이상 고르세요');
      if (requested.length > MAX_MODELS) {
        throw piError('PI_TOO_MANY_MODELS', `모델은 최대 ${MAX_MODELS}개까지 고를 수 있어요`);
      }
      const normalizedRequested = requested.map((item) => {
        const rawId = typeof item?.id === 'string' ? item.id.trim() : '';
        const id = normalizedModelId(rawId);
        if (rawId && !id) {
          throw piError('PI_MODEL_INVALID', '모델 ID가 허용된 길이 또는 형식이 아니에요');
        }
        const rawName = typeof item?.name === 'string' ? item.name.trim() : '';
        const name = rawName ? normalizedModelName(rawName, '') : null;
        if (rawName && !name) {
          throw piError('PI_MODEL_NAME_INVALID', '모델 이름이 허용된 길이 또는 형식이 아니에요');
        }
        return { item, id: id ?? '', name };
      });
      const catalog = gift
        ? await giftCatalog(false, giftCredentials.lease)
        : await client.catalog(false, apiKey);
      const byId = new Map(catalog.flatMap((entry) => {
        const id = normalizedModelId(entry?.id);
        return id ? [[id, entry]] : [];
      }));
      const seen = new Set();
      /** @type {PiModelConfig[]} */
      const next = [];
      for (const { item, id, name: requestedName } of normalizedRequested) {
        const entry = byId.get(id);
        if (!entry) throw piError('PI_MODEL_UNKNOWN', `OpenRouter 에 없는 모델이에요: ${id || '(빈 값)'}`);
        if (seen.has(id)) continue;
        seen.add(id);
        next.push(modelConfigFromCatalog(entry, { id, name: requestedName, effortDefault: item?.effortDefault }));
      }
      return serialized(async () => {
        const previous = snapshotSettingsState();
        try {
          if (gift) {
            config.gift.models = next;
            config.gift.defaultModelId = next.some((model) => model.id === config.gift.defaultModelId)
              ? config.gift.defaultModelId
              : next[0].id;
            await writeGiftAgentFiles();
            await persistConfig();
            return currentStatus();
          }
          config.models = next;
          config.defaultModelId = next.some((model) => model.id === config.defaultModelId)
            ? config.defaultModelId
            : next[0].id;
          config.setupComplete = Boolean(apiKey) && next.length > 0;
          await writeModelsJson();
          await persistConfig();
          return currentStatus();
        } catch (error) {
          const rollbackErrors = await rollbackSettingsState(previous);
          if (rollbackErrors.length > 0) {
            throw modelRollbackError(
              error,
              new AggregateError(rollbackErrors, 'One or more model rollback steps failed.'),
            );
          }
          throw error;
        }
      });
    },

    /** 지금 자격(선물 또는 내 키)의 모델 중 출력 단가가 가장 싼 것. 없으면 null. */
    cheapestModel() {
      let cheapest = null;
      for (const model of modeModels().models) {
        if (!cheapest || model.pricing.completion < cheapest.pricing.completion) cheapest = model;
      }
      return cheapest ? { ...cheapest, pricing: { ...cheapest.pricing } } : null;
    },

    /** 지금 자격의 기본 모델(없으면 첫 모델). */
    defaultModel() {
      const { models, defaultModelId } = modeModels();
      const found = models.find((model) => model.id === defaultModelId);
      const model = found ?? models[0] ?? null;
      return model ? { ...model, pricing: { ...model.pricing } } : null;
    },

    /**
     * 허브 내부 전용 — 지금 쓸 자격. 선물 모드면 리스, 아니면 내 OpenRouter 키다.
     * 이 값으로 직접 요청할 때는 반드시 router 를 거친다 (리스는 선물 프록시로만 간다).
     */
    apiKey() {
      return currentAccess().key;
    },

    /** 내 OpenRouter 키. 사용량 카드의 잔액은 이 키로만 본다. */
    ownApiKey() {
      return apiKey;
    },

    /** 지금 자격: { mode: 'gift'|'own'|'none', key, agentDir, baseUrl, reason? }. */
    access() {
      return currentAccess();
    },

    /**
     * Pi 를 띄울 때마다 부른다. 지금 자격과 그 자격의 모델을 고른다 — 요청한 모델이 이 자격의
     * 모델이 아니면 기본 모델로 바꾼다. fallback 은 선물이 떨어졌을 때 갈 곳이다.
     *
     * @param {string|null|undefined} requestedModel
     */
    resolveSpawn(requestedModel) {
      if (giftEnabled && now() - giftCheckedAt > GIFT_CREDENTIALS_STALE_MS) void refreshGift();
      const access = currentAccess();
      const { models, defaultModelId } = modeModels();
      const model = models.find((entry) => entry.id === requestedModel)
        ?? models.find((entry) => entry.id === defaultModelId)
        ?? models[0]
        ?? null;
      return {
        ...access,
        model: model?.id ?? (typeof requestedModel === 'string' && requestedModel ? requestedModel : null),
        reasoning: Boolean(model?.reasoning),
        // 이 자격의 크레딧이 떨어지면 다음 스폰이 갈 곳.
        fallback: access.mode === 'own'
          ? (config.gift.order === 'after' && giftMode() ? 'gift' : 'none')
          : (apiKey ? 'own' : 'none'),
      };
    },

    refreshGift,
    ensureGiftFresh,
    markGiftExhausted,
    markOwnKeyExhausted,
    setGiftOrder,
    router,

    /** 카탈로그. 선물 모드면 선물 프록시의 Claude 모델만 보인다. */
    catalog(refresh = false) {
      return currentAccess().mode === 'gift'
        ? giftCatalog(refresh, giftCredentials.lease)
        : client.catalog(refresh, apiKey);
    },

    /** 잔액. 키가 없으면 null 을 돌려준다. */
    async credits(refresh = false) {
      if (!apiKey) return null;
      return client.credits(apiKey, refresh);
    },

    /** 진행 중인 설정 파일 쓰기가 끝날 때까지 기다린다 (테스트/종료용). */
    flush() {
      return writeChain;
    },
  };
}
