import { existsSync, promises as fs, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { applyManagedCliLaunch, applyNodeHostEnv, createNodeHost, isNodeBinary } from './npm-cli-launch.mjs';
import { bundledNpmLaunch } from './npm-runtime.mjs';
import { API_KEY_MAX_BYTES, AUTH_CODE_MAX_BYTES, textFitsByteLimit } from './input-bounds.mjs';
import { redactDiagnosticText } from './agents/backend.mjs';
import {
  claudeCredentialExpiry,
  claudeKeychainService,
  parseClaudeOAuthCredential,
  parseClaudeSetupTokenOutput,
  readClaudeOAuthCredential,
  verifyClaudeCredential,
} from './claude-credentials.mjs';
import { cleanupStaleOAuthCredentialStaging } from './oauth-credential-transaction.mjs';
import { createSetupTerminal } from './setup-terminal.mjs';
import { fetchLatestPackage, replaceFileAtomically } from './harness-update.mjs';
import { processTreeSpawnOptions, terminateAndWaitForProcessTreeExit, withoutHubPrivateEnv } from './process-tree.mjs';

const require = createRequire(import.meta.url);
let crossSpawn = null;
function spawn(command, args, options) { crossSpawn ??= require('cross-spawn'); return crossSpawn(command, args, options); }
const CONFIG = Object.freeze({
  claude: { package: '@anthropic-ai/claude-code', bin: 'claude', keyEnv: 'ANTHROPIC_API_KEY' },
  codex: { package: '@openai/codex', bin: 'codex', keyEnv: 'OPENAI_API_KEY' },
});
const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;
const STATUS_TIMEOUT_MS = 10_000;
// 새로 받은 실행 파일의 첫 실행은 Windows 백신 검사·첫 실행 초기화로 10초를 넘기기도 한다.
const FIRST_PROBE_TIMEOUT_MS = 30_000;
// Codex 가 auth.json 을 다시 쓰는 순간(빈 파일·쓰다 만 JSON)이나 백신이 잡은 잠금(EBUSY/EPERM)은 잠깐 기다렸다 다시 읽는다.
const CODEX_LOGIN_READ_ATTEMPTS = 3;
const CODEX_LOGIN_RETRY_MS = 100;
// 다시 읽어도 읽히지 않으면 이 시간 안에 확인한 마지막 결과를 유지한다.
const CODEX_LOGIN_GRACE_MS = 60_000;
// 사용자 config.toml 이 keyring/auto 저장소를 고르면 `codex login` 이 auth.json 을 남기지 않아 앱이 로그인을 보지 못한다.
const CODEX_FILE_STORE_ARGS = Object.freeze(['-c', 'cli_auth_credentials_store=file']);
const AUTH_TIMEOUT_MS = 10 * 60 * 1000;
const CLAUDE_TOKEN_SECRET = 'rhwp.claude.oauth-token';
// `claude setup-token` tokens last a year. The CLI does not report the exact
// expiry in a machine-readable form, so the app keeps a slightly short copy.
const CLAUDE_TOKEN_LIFETIME_MS = 364 * 24 * 60 * 60 * 1000;
const CLAUDE_VERIFY_TTL_MS = 10 * 60 * 1000;
// A reused terminal login is only handed out while it has this much life left.
const CLAUDE_LOCAL_LOGIN_MIN_REMAINING_MS = 5 * 60 * 1000;
// A reused terminal login is re-read (Keychain on macOS) only when it is missing,
// close to expiry, or this old. Explicit refreshes and verification always re-read.
const CLAUDE_LOCAL_LOGIN_REREAD_MS = 15 * 60 * 1000;
const CLAUDE_LOCAL_LOGIN_RENEW_MARGIN_MS = 30 * 60 * 1000;
/**
 * Inherited variables that would override or hijack the app's Claude login:
 * other credentials, gateways, and cloud-provider switches.
 */
export const CLAUDE_AUTH_ENV_KEYS = Object.freeze([
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_UNIX_SOCKET',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
]);

export function defaultCliSetupRoot(env = process.env, platform = process.platform, home = os.homedir()) {
  const pathImpl = platform === 'win32' ? path.win32 : path.posix;
  if (env.RHWP_CLI_DIR) return pathImpl.resolve(env.RHWP_CLI_DIR);
  if (platform === 'darwin') return pathImpl.join(home, 'Library', 'Application Support', 'rhwp', 'cli');
  if (platform === 'win32') return pathImpl.join(env.APPDATA || pathImpl.join(home, 'AppData', 'Roaming'), 'rhwp', 'cli');
  return pathImpl.join(env.XDG_DATA_HOME || pathImpl.join(home, '.local', 'share'), 'rhwp', 'cli');
}
function setupError(code, message, detail = null) {
  const error = new Error(message);
  error.code = code;
  // 원시 터미널 출력은 배너 문구가 아니라 펼쳐보기 상세로만 내려보낸다.
  if (typeof detail === 'string' && detail) error.detail = detail;
  return error;
}
function keyTail(value) { const text = String(value ?? '').trim(); return text ? text.slice(-4) : null; }
/** `codex-cli 0.159.0`, `2.1.284 (Claude Code)` 처럼 CLI 마다 다른 --version 출력에서 버전만 꺼낸다. */
export function parseCliVersion(output) {
  const text = String(output ?? '').trim();
  return text.match(/\bv?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/)?.[1] ?? (text.split(/\s+/)[0] || null);
}
function cleanOutput(value) { return redactDiagnosticText(String(value ?? '')).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').trim().slice(-1600); }

/** 앱에 번들된 Agent SDK 가 쓰는 Claude Code 버전. 관리형 CLI 가 없을 때 실제로 실행되는 런타임이다. */
export function bundledClaudeCodeVersion(resolve = (id) => require.resolve(id)) {
  try {
    const manifest = JSON.parse(readFileSync(path.join(path.dirname(resolve('@anthropic-ai/claude-agent-sdk')), 'package.json'), 'utf8'));
    return typeof manifest.claudeCodeVersion === 'string' ? manifest.claudeCodeVersion : null;
  } catch { return null; }
}

/**
 * Replays login terminal output on a headless screen. Claude Code draws with
 * cursor moves instead of spaces, so only the rendered screen reads the way
 * the user sees it.
 */
export function createLoginScreen({ cols = 80, rows = 18 } = {}) {
  const { Terminal } = require('@xterm/headless');
  const terminal = new Terminal({ cols, rows, scrollback: 2000, allowProposedApi: true });
  let pending = Promise.resolve();
  return {
    write(data) { pending = new Promise((resolve) => terminal.write(String(data), resolve)); },
    resize(nextCols, nextRows) { if (nextCols > 0 && nextRows > 0) terminal.resize(nextCols, nextRows); },
    async text() {
      await pending;
      const buffer = terminal.buffer.active;
      let text = '';
      for (let i = 0; i < buffer.length; i += 1) {
        const line = buffer.getLine(i);
        if (!line) continue;
        text += `${line.isWrapped || i === 0 ? '' : '\n'}${line.translateToString(true)}`;
      }
      return text;
    },
    dispose() { terminal.dispose(); },
  };
}

/** The native Claude Code binary the Agent SDK ships for this platform. */
export function bundledClaudeBinary({
  platform = process.platform,
  arch = process.arch,
  resolve = (id) => require.resolve(id),
  exists = existsSync,
} = {}) {
  const exe = platform === 'win32' ? 'claude.exe' : 'claude';
  const base = `@anthropic-ai/claude-agent-sdk-${platform}-${arch}`;
  for (const name of platform === 'linux' ? [base, `${base}-musl`] : [base]) {
    try {
      const file = path.join(path.dirname(resolve(`${name}/package.json`)), exe);
      if (exists(file)) return file;
    } catch {}
  }
  return null;
}

/** `candidate` 가 `current` 보다 새 버전이면 true. 프리릴리스 꼬리표는 비교하지 않는다. */
export function isNewerVersion(candidate, current) {
  const parts = (value) => String(value ?? '').replace(/^v/, '').split(/[-+]/)[0].split('.').map((n) => Number.parseInt(n, 10) || 0);
  const a = parts(candidate); const b = parts(current);
  for (let i = 0; i < 3; i += 1) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  return false;
}

/** Create the app-managed Claude/Codex CLI setup service. */
export function createCliSetupManager({ rootDir = defaultCliSetupRoot(), spawnProcess = spawn, createTerminal = createSetupTerminal, npmCommand = null, nodeCommand = process.execPath, platform = process.platform, baseEnv = process.env, homeDir = os.homedir(), secretStore = null, readClaudeLogin = readClaudeOAuthCredential, verifyClaude = verifyClaudeCredential, deleteKeychainItem = null, fetchImpl = globalThis.fetch, bundledClaudeVersion = bundledClaudeCodeVersion(), bundledClaudeBin = bundledClaudeBinary(), now = Date.now, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  const prefixDir = path.join(rootDir, 'prefix');
  const binDir = path.join(prefixDir, 'node_modules', '.bin');
  const configPath = path.join(rootDir, 'config.json');
  const secretsPath = path.join(rootDir, 'secrets.json');
  const platformPath = platform === 'win32' ? path.win32 : path;
  const hostProfileHome = platform === 'win32'
    ? platformPath.resolve(baseEnv.USERPROFILE || homeDir)
    : platformPath.resolve(homeDir);
  const claudeOAuthStagingDir = path.join(rootDir, 'claude-oauth-staging');
  const claudeLoginDir = path.join(rootDir, 'claude-login');
  const legacyClaudeSeedDir = path.join(rootDir, 'claude-source-credentials');
  // 예전 빌드가 설치마다 쌓아 두던 npm 캐시. 지금은 설치마다 npmCacheRunsDir 아래 임시 캐시를 쓰고 지운다.
  const legacyNpmCacheDir = path.join(rootDir, 'npm-cache');
  const npmCacheRunsDir = path.join(rootDir, 'npm-cache-runs');
  const npmLogsDir = path.join(rootDir, 'npm-logs');
  /**
   * The app's Claude connection. An in-app login stores a long-lived token that
   * every Claude child receives through CLAUDE_CODE_OAUTH_TOKEN, so nothing in
   * the user's own Claude profile, Keychain, or shell can break it. A terminal
   * login is reused only while no app credential exists and it is still valid.
   */
  const claudeAuth = {
    token: null,
    tokenExpiresAt: null,
    useLocalLogin: true,
    local: null,
    rejected: new Set(),
    verified: null,
    localReadAt: 0,
  };
  const npmLaunch = bundledNpmLaunch({ nodeCommand, npmCommand });
  const ensureNodeHost = createNodeHost({ rootDir, nodeCommand, platform });
  const apiKeys = { claude: null, codex: null };
  const latestVersions = { claude: null, codex: null };
  const authProcesses = new Map();
  const authTerminals = new Map();
  const loginScreens = new Map();
  /** 진행 중인 설치. 같은 prefix 의 npm 은 package.json 을 서로 덮어쓰므로 설치는 한 번에 하나씩 돈다. */
  const installs = new Map();
  /**
   * 관리형 CLI 의 `--version` 결과. 버전은 실행 파일이 바뀔 때만 달라지므로 .bin shim 과
   * 패키지 package.json 의 크기·수정 시각이 같으면 프로세스를 다시 띄우지 않는다.
   * 같은 지문의 확인이 이미 돌고 있으면 그 결과를 함께 기다린다.
   */
  const versionProbes = new Map();
  const installedVersions = new Map();
  /** 한 번 확인에 실패한 지문. 같은 파일의 다음 확인은 첫 실행만큼 오래 기다리지 않는다. */
  const failedProbeFingerprints = new Map();
  /** 설치 직후 확인에서 실행되지 않은 관리형 CLI 의 지문. 같은 파일이 남아 있으면 설치되지 않은 것으로 알린다. */
  const unusableBins = new Map();
  /** 마지막으로 끝까지 읽은 Codex auth.json 결과. 잠깐 읽히지 않을 때 로그인 표시가 깜박이지 않게 한다. */
  let codexLoginSeen = null;
  let installQueue = Promise.resolve();
  let activeLaunches = 0;
  let launchReady = Promise.resolve();
  let releaseLaunches = () => {};
  let prefixCleanupUncertain = false;
  let nodeHostShimDir = null;
  let loaded = false;
  let loadPromise = null;
  let legacyLoaded = false;
  let migrationPending = false;
  let claudeTokenPending = true;
  let configTokenExpiresAt = null;
  /** 보안 저장소에서 아직 읽지 못한 에이전트. 읽기가 실패하면 다음 load() 가 다시 시도한다. */
  const pendingSecretReads = new Set(Object.keys(CONFIG));
  async function writePrivateJson(file, value) {
    const temp = `${file}.new-${randomUUID()}`;
    try {
      await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
      await replaceFileAtomically(temp, file, { platform });
    } finally {
      await fs.rm(temp, { force: true }).catch(() => {});
    }
  }
  function assertAgent(agent) { if (!Object.hasOwn(CONFIG, agent)) throw setupError('AGENT_SETUP_INVALID', `지원하지 않는 에이전트예요: ${agent}`); return CONFIG[agent]; }
  function assertPrefixAvailable() {
    if (prefixCleanupUncertain) throw setupError('AGENT_INSTALL_CLEANUP_UNCERTAIN', '이전 CLI 설치 프로세스가 종료됐는지 확인할 수 없어 설치와 실행을 중단했어요.');
  }
  function binPath(agent) { const item = assertAgent(agent); return path.join(binDir, platform === 'win32' ? `${item.bin}.cmd` : item.bin); }
  function managedLaunch(command, argv, env) {
    return applyManagedCliLaunch(command, argv, {
      platform, nodeCommand, env: applyNodeHostEnv(env, { nodeCommand, shimDir: nodeHostShimDir, platform }),
    });
  }
  function terminalCommand(launch) {
    // Windows GUI 실행 파일인 Electron은 ConPTY에 직접 붙이면 입출력이 사라진다.
    // 기존 node.cmd를 통해 콘솔을 상속한다. 파이프 실행은 위의 직접 실행을 유지한다.
    return platform === 'win32' && launch.command === nodeCommand && !isNodeBinary(nodeCommand)
      ? path.join(nodeHostShimDir, 'node.cmd') : launch.command;
  }
  function claudeCleanEnv() {
    const env = withoutHubPrivateEnv(baseEnv);
    for (const key of CLAUDE_AUTH_ENV_KEYS) delete env[key];
    delete env.OPENAI_API_KEY;
    return env;
  }
  /**
   * The credential Claude children use right now: the app token, then an API
   * key, then a still-valid terminal login. Anything Anthropic rejected is
   * skipped so the next working source takes over.
   */
  function claudeCredential() {
    const at = now();
    const usable = (secret) => Boolean(secret) && !claudeAuth.rejected.has(secret);
    if (usable(claudeAuth.token) && !(claudeAuth.tokenExpiresAt && claudeAuth.tokenExpiresAt <= at)) {
      return { source: 'app', token: claudeAuth.token };
    }
    if (usable(apiKeys.claude)) return { source: 'api-key', apiKey: apiKeys.claude };
    const local = claudeAuth.local;
    if (claudeAuth.useLocalLogin && usable(local?.token)
      && (!local.expiresAt || local.expiresAt - at > CLAUDE_LOCAL_LOGIN_MIN_REMAINING_MS)) {
      return { source: 'local', token: local.token };
    }
    return null;
  }
  /** authenticate() 가 정한 키는 늦게 끝난 저장소 읽기가 덮어쓰지 못하게 한다. */
  function settleApiKey(agent, value) { apiKeys[agent] = value; pendingSecretReads.delete(agent); }
  function settleClaudeToken(token, expiresAt) {
    claudeAuth.token = token;
    claudeAuth.tokenExpiresAt = token ? expiresAt : null;
    claudeTokenPending = false;
  }
  function envFor(agent) {
    const item = assertAgent(agent);
    if (agent === 'claude') {
      const env = claudeCleanEnv();
      const credential = claudeCredential();
      if (credential?.token) env.CLAUDE_CODE_OAUTH_TOKEN = credential.token;
      else if (credential?.apiKey) env.ANTHROPIC_API_KEY = credential.apiKey;
      return env;
    }
    const env = withoutHubPrivateEnv(baseEnv); delete env.ANTHROPIC_API_KEY; delete env.OPENAI_API_KEY; if (apiKeys[agent]) env[item.keyEnv] = apiKeys[agent]; return env;
  }
  /** Re-read a terminal Claude login. Skipped while the app owns a credential. */
  async function refreshLocalClaudeLogin() {
    const current = claudeCredential();
    if (!claudeAuth.useLocalLogin || current?.source === 'app' || current?.source === 'api-key') return;
    const previousReadAt = claudeAuth.localReadAt;
    claudeAuth.localReadAt = now();
    const found = await readClaudeLogin({ homeDir: hostProfileHome, env: baseEnv, platform, reportUnreadable: true })
      .catch(() => ({ source: 'unreadable' }));
    // Claude Code 가 파일을 다시 쓰는 중이거나 Windows 에서 잠겨 읽지 못했으면 있던 로그인을 지우지 않는다.
    // 파일이 없거나 읽었는데 토큰이 없을 때만 로그아웃으로 본다. 다음 확인에서 곧바로 다시 읽는다.
    if (found?.source === 'unreadable') { claudeAuth.localReadAt = previousReadAt; return; }
    const parsed = found ? parseClaudeOAuthCredential(found.text) : null;
    claudeAuth.local = parsed
      ? { token: parsed.claudeAiOauth.accessToken, expiresAt: claudeCredentialExpiry(parsed) || null }
      : null;
  }
  /**
   * Status reads reuse a recent terminal login instead of asking the Keychain
   * every time. A missing login is always re-read, so a login completed in a
   * terminal is picked up by the next message.
   */
  async function refreshStaleLocalClaudeLogin() {
    const current = claudeCredential();
    if (current && current.source !== 'local') return;
    if (current) {
      const at = now();
      const expiresAt = claudeAuth.local?.expiresAt;
      const recent = at - claudeAuth.localReadAt < CLAUDE_LOCAL_LOGIN_REREAD_MS;
      if (recent && !(expiresAt && expiresAt - at < CLAUDE_LOCAL_LOGIN_RENEW_MARGIN_MS)) return;
    }
    await refreshLocalClaudeLogin();
  }
  /**
   * Check the active Claude credential against Anthropic. A rejected app token
   * is dropped so the next source (or a fresh login) takes over; network
   * trouble never signs anyone out.
   */
  async function verifyClaudeAuth({ force = false } = {}) {
    await load();
    await refreshLocalClaudeLogin();
    let result = null;
    // After a rejection the next source is checked right away, so a failed
    // turn can recover onto a working login without another round trip.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const credential = claudeCredential();
      if (!credential) return result;
      const secret = credential.token ?? credential.apiKey;
      const cached = claudeAuth.verified;
      if ((!force || attempt > 0) && cached?.secret === secret && now() - cached.at < CLAUDE_VERIFY_TTL_MS) return cached.result;
      result = await verifyClaude(credential.token ? { token: credential.token, fetchImpl } : { apiKey: credential.apiKey, fetchImpl });
      claudeAuth.verified = { secret, result, at: now() };
      if (result !== 'invalid') return result;
      claudeAuth.rejected.add(secret);
      if (credential.source === 'app' && claudeAuth.token === secret) {
        settleClaudeToken(null, null);
        await persist().catch(() => {});
      }
      await refreshLocalClaudeLogin();
    }
    return result;
  }
  function load() {
    if (loaded) return Promise.resolve();
    loadPromise ??= loadPendingKeys().finally(() => { loadPromise = null; });
    return loadPromise;
  }
  const acceptToken = (value) => (typeof value === 'string' && textFitsByteLimit(value, API_KEY_MAX_BYTES) && value.trim() ? value.trim() : null);
  async function loadPendingKeys() {
    if (!legacyLoaded) {
      legacyLoaded = true;
      try { const raw = JSON.parse(await fs.readFile(configPath, 'utf8')); for (const agent of Object.keys(CONFIG)) { const key = raw?.[agent]?.key; if (typeof key === 'string' && textFitsByteLimit(key, API_KEY_MAX_BYTES)) { apiKeys[agent] = key.trim() || null; migrationPending = migrationPending || Boolean(apiKeys[agent]); } }
        const claude = raw?.claude ?? {};
        if (Number.isFinite(claude.tokenExpiresAt)) configTokenExpiresAt = claude.tokenExpiresAt;
        if (claude.useLocalLogin === false) claudeAuth.useLocalLogin = false;
      } catch {}
    }
    if (secretStore?.available) {
      // 일시적인 저장소 오류(시간 초과 등)로 키를 잃지 않도록, 실패한 에이전트는 남겨 두고 다음 호출에서 다시 읽는다.
      await Promise.all([...[...pendingSecretReads].map(async (agent) => {
        try {
          const value = await secretStore.get(`rhwp.${agent}.api-key`);
          if (!pendingSecretReads.has(agent)) return;
          if (typeof value === 'string' && textFitsByteLimit(value, API_KEY_MAX_BYTES)) apiKeys[agent] = value.trim() || null;
          pendingSecretReads.delete(agent);
        } catch {}
      }), claudeTokenPending ? (async () => {
        try {
          const value = await secretStore.get(CLAUDE_TOKEN_SECRET);
          if (claudeTokenPending) settleClaudeToken(acceptToken(value), configTokenExpiresAt);
        } catch {}
      })() : null]);
    } else {
      try { const raw = JSON.parse(await fs.readFile(secretsPath, 'utf8')); for (const agent of Object.keys(CONFIG)) { const value = raw?.[`rhwp.${agent}.api-key`]; if (typeof value === 'string' && textFitsByteLimit(value, API_KEY_MAX_BYTES)) apiKeys[agent] = value.trim() || null; }
        if (claudeTokenPending) settleClaudeToken(acceptToken(raw?.[CLAUDE_TOKEN_SECRET]), configTokenExpiresAt); } catch {}
      pendingSecretReads.clear();
      claudeTokenPending = false;
    }
    loaded = pendingSecretReads.size === 0 && !claudeTokenPending;
    // 저장소 값을 모두 읽은 뒤에만 이전한다. 읽지 못한 새 값을 이전 설정 파일의 키로 덮어쓰지 않기 위해서다.
    if (loaded && migrationPending) {
      migrationPending = false;
      // 이전 설정 파일의 키는 메모리와 원본 파일에 남아 있으므로, 이전이 실패해도 허브 시작을 막지 않는다.
      // persist() 는 보안 저장소에 쓴 뒤에만 config.json 에서 키를 지우므로 다음 저장 때 이전이 마저 끝난다.
      try { await persist(); } catch (error) { process.stderr.write(`[cli-setup] API 키 이전 실패: ${redactDiagnosticText(String(error?.message ?? error))}\n`); }
    }
  }
  async function persist() {
    await fs.mkdir(rootDir, { recursive: true, mode: 0o700 });
    const config = Object.fromEntries(Object.keys(CONFIG).map((agent) => [agent, { authMethod: apiKeys[agent] ? 'api-key' : null, keyTail: keyTail(apiKeys[agent]) }]));
    config.claude = {
      ...config.claude,
      ...(claudeAuth.token ? { authMethod: 'oauth-token', tokenExpiresAt: claudeAuth.tokenExpiresAt } : {}),
      ...(claudeAuth.useLocalLogin ? {} : { useLocalLogin: false }),
    };
    if (secretStore?.available) {
      for (const agent of Object.keys(CONFIG)) if (apiKeys[agent]) await secretStore.set(`rhwp.${agent}.api-key`, apiKeys[agent]);
      if (claudeAuth.token) await secretStore.set(CLAUDE_TOKEN_SECRET, claudeAuth.token);
      else await secretStore.delete?.(CLAUDE_TOKEN_SECRET)?.catch?.(() => {});
    } else {
      const secrets = Object.fromEntries(Object.keys(CONFIG).filter((agent) => apiKeys[agent]).map((agent) => [`rhwp.${agent}.api-key`, apiKeys[agent]]));
      if (claudeAuth.token) secrets[CLAUDE_TOKEN_SECRET] = claudeAuth.token;
      await writePrivateJson(secretsPath, secrets);
    }
    await writePrivateJson(configPath, config);
  }
  async function run(command, args, options = {}) {
    let child;
    // 실행 파일이 없거나(설치 중 교체) 실행 권한이 없거나 EMFILE 이면 spawn 이 던지거나 'error' 를 낸다.
    // 처리하지 않은 'error' 이벤트는 허브 프로세스를 끝내므로 실패한 실행 결과로 바꾼다.
    const { tree = false, timeoutMs = STATUS_TIMEOUT_MS, ...spawnOptions } = options;
    try {
      nodeHostShimDir = await ensureNodeHost();
      const launch = managedLaunch(command, args, options.env ?? withoutHubPrivateEnv(baseEnv));
      child = spawnProcess(launch.command, launch.argv, { ...spawnOptions, ...(tree ? processTreeSpawnOptions(platform) : { windowsHide: true }), stdio: ['ignore', 'pipe', 'pipe'], env: launch.env });
    } catch (error) { return { code: null, stdout: '', stderr: String(error?.message ?? error) }; }
    let stdout = ''; let stderr = '';
    child.stdout?.on('data', (chunk) => { stdout += String(chunk); }); child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
    return await new Promise((resolve) => {
      // 설치(tree)는 npm 이 띄운 자식까지 끝난 뒤에 실패를 알린다. 남은 npm 이 다음 설치와 겹쳐 파일을 쓰지 않게 하기 위해서다.
      let settling = false;
      const finish = async (result, stop = false) => {
        if (settling) return;
        settling = true;
        clearTimeout(timer);
        if (stop) {
          if (tree) {
            const cleaned = await terminateAndWaitForProcessTreeExit(child).catch(() => false);
            if (!cleaned) prefixCleanupUncertain = true;
          } else child.kill?.();
        }
        resolve(result);
      };
      const timer = setTimeout(() => { void finish({ code: null, stdout, stderr: `${stderr}\ntimeout`, timedOut: true }, true); }, timeoutMs);
      child.on('error', (error) => { void finish({ code: null, stdout, stderr: `${stderr}\n${error?.message ?? error}` }, tree); });
      child.once('close', (code, signal) => { void finish({ code, signal, stdout, stderr }); });
    });
  }
  /** `codex login` 이 남긴 auth.json 을 확인한다. 허브도 같은 파일을 세션에 연결해 쓴다. */
  async function readCodexLogin() {
    const codexHome = typeof baseEnv.CODEX_HOME === 'string' && baseEnv.CODEX_HOME.trim()
      ? platformPath.resolve(baseEnv.CODEX_HOME)
      : platformPath.join(hostProfileHome, '.codex');
    const file = platformPath.join(codexHome, 'auth.json');
    for (let attempt = 1; ; attempt += 1) {
      let auth;
      try {
        const text = await fs.readFile(file, 'utf8');
        if (!text.trim()) throw new Error('empty auth.json');
        auth = JSON.parse(text);
      } catch (error) {
        if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') { codexLoginSeen = null; return false; }
        if (attempt < CODEX_LOGIN_READ_ATTEMPTS) { await sleep(CODEX_LOGIN_RETRY_MS); continue; }
        return Boolean(codexLoginSeen?.authenticated && now() - codexLoginSeen.at < CODEX_LOGIN_GRACE_MS);
      }
      const authenticated = Boolean(auth?.tokens?.refresh_token || auth?.tokens?.access_token || auth?.OPENAI_API_KEY);
      codexLoginSeen = { authenticated, at: now() };
      return authenticated;
    }
  }
  async function binFingerprint(agent, bin) {
    const manifest = path.join(prefixDir, 'node_modules', ...CONFIG[agent].package.split('/'), 'package.json');
    const stamps = await Promise.all([bin, manifest].map((file) => fs.stat(file).then(
      (stat) => `${stat.size}:${stat.mtimeMs}:${stat.ino}`,
      () => '-',
    )));
    return `${bin}|${stamps.join('|')}`;
  }
  /** `--version` 으로 버전을 읽는다. 곧바로 실패하면 한 번 더 띄우고, 시간 초과는 이미 오래 기다렸으므로 다시 띄우지 않는다. */
  async function probeVersion(agent, bin, timeoutMs) {
    let result = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      result = await run(bin, ['--version'], { env: envFor(agent), timeoutMs });
      const version = result.code === 0 ? parseCliVersion(cleanOutput(result.stdout)) : null;
      if (version) return { version, result };
      if (result.timedOut) break;
    }
    return { version: null, result };
  }
  async function managedVersion(agent) {
    const bin = binPath(agent);
    if (!existsSync(bin)) { versionProbes.delete(agent); return null; }
    const fingerprint = await binFingerprint(agent, bin);
    const cached = versionProbes.get(agent);
    if (cached?.fingerprint === fingerprint) return cached.version;
    // 새 실행 파일의 첫 확인만 넉넉히 기다린다. 같은 파일에서 이미 실패했으면 평소 시간만 기다린다.
    const timeoutMs = failedProbeFingerprints.get(agent) === fingerprint ? STATUS_TIMEOUT_MS : FIRST_PROBE_TIMEOUT_MS;
    const probe = { fingerprint, version: probeVersion(agent, bin, timeoutMs).then(({ version }) => version) };
    versionProbes.set(agent, probe);
    const version = await probe.version;
    // 실패(시간 초과·설치 중 교체)는 기억하지 않고 다음 상태 확인에서 다시 실행한다.
    if (!version && versionProbes.get(agent) === probe) { versionProbes.delete(agent); failedProbeFingerprints.set(agent, fingerprint); }
    if (version) failedProbeFingerprints.delete(agent);
    return version;
  }
  async function authState(agent) {
    let authenticated = Boolean(apiKeys[agent]);
    let authMethod = authenticated ? 'api-key' : null;
    if (agent === 'codex' && !authenticated && await readCodexLogin()) {
      authenticated = true;
      authMethod = 'oauth';
    }
    let authSource = null;
    let authVerifiedAt = null;
    if (agent === 'claude') {
      await refreshStaleLocalClaudeLogin();
      const credential = claudeCredential();
      const secret = credential?.token ?? credential?.apiKey ?? null;
      authenticated = Boolean(credential);
      authMethod = !authenticated ? null : (credential.apiKey ? 'api-key' : 'oauth');
      authSource = authenticated ? credential.source : null;
      const verified = claudeAuth.verified;
      if (authenticated && verified?.secret === secret && verified.result === 'valid') authVerifiedAt = verified.at;
    }
    return { authenticated, authMethod, authSource, authVerifiedAt };
  }
  async function status(agent) {
    assertAgent(agent); await load(); const bin = binPath(agent);
    const installing = installs.has(agent);
    // npm 이 바이너리를 교체하는 동안 확인된 버전을 유지한다.
    let version = installing
      ? installedVersions.get(agent) ?? null
      : await managedVersion(agent);
    const hasBin = existsSync(bin);
    // 설치 직후 확인에서 실행되지 않은 그 파일이 그대로면 설치되지 않은 것으로 알린다.
    const unusable = !installing && !version && hasBin && unusableBins.has(agent)
      && unusableBins.get(agent) === await binFingerprint(agent, bin);
    if (version) {
      installedVersions.set(agent, version);
      if (!installing) unusableBins.delete(agent);
    } else if (!installing) {
      // 실행 파일은 있는데 확인만 실패하면(백신 검사로 인한 시간 초과 등) 마지막으로 확인한 버전을 유지한다.
      // 번들 버전으로 바꿔 알리면 멀쩡한 CLI 가 업데이트 대상으로 보인다.
      if (hasBin && !unusable) version = installedVersions.get(agent) ?? null;
      else installedVersions.delete(agent);
    }
    const { authenticated, authMethod, authSource, authVerifiedAt } = await authState(agent);
    // 관리형 CLI 가 없으면 Claude 는 SDK 번들 런타임으로 실행되므로 그 버전을 기준으로 삼는다.
    const runtimeVersion = version ?? (agent === 'claude' && !hasBin ? bundledClaudeVersion : null);
    const latestVersion = latestVersions[agent];
    const updateRequired = Boolean(runtimeVersion && latestVersion && isNewerVersion(latestVersion, runtimeVersion));
    return { installed: !unusable && Boolean(version || hasBin), installing, version: runtimeVersion, authenticated, authMethod, ...(agent === 'claude' ? { authSource, authVerifiedAt } : {}), keyTail: keyTail(apiKeys[agent]), latestVersion, updateRequired, error: null };
  }
  /** Login state only: no `--version` run. Used before every chat message. */
  async function authStatus(agent) {
    assertAgent(agent); await load();
    return authState(agent);
  }
  /** 같은 에이전트 설치가 이미 돌고 있으면 그 결과를 함께 기다린다. */
  async function install(agent, onProgress) {
    const item = assertAgent(agent);
    onProgress?.({ state: 'installing', phase: 'installing', activity: true });
    const running = installs.get(agent);
    if (running) return running;
    const task = installQueue.then(async () => {
      assertPrefixAvailable();
      await launchReady;
      await load(); await fs.mkdir(rootDir, { recursive: true, mode: 0o700 });
      // 사용자 npm 설정의 global/cache 값이 관리자 폴더로 설치를 돌리지 않도록 고정한다.
      // 캐시는 이번 설치에만 쓰고 지운다. 설치는 늘 @latest 라 받아 둔 tarball(Claude 는 100MB 이상)을 다시 쓸 일이 없다.
      // npm 로그는 캐시 밖(npm-logs, npm 이 최근 10개만 남김)에 두어 실패 메시지가 가리키는 로그 파일이 지워지지 않게 한다.
      // 캐시가 매번 새로 생기므로 번들 npm 의 업데이트 확인도 매번 돌게 되는데, 번들 npm 은 앱이 고정하므로 끈다.
      const npmCacheDir = path.join(npmCacheRunsDir, `${now()}-${randomUUID()}`);
      let result;
      try {
        // 사용자 npm 설정의 ignore-scripts=true, omit=optional, save=false 도 덮어쓴다. 그대로 두면 npm 이 0 으로 끝나도
        // 플랫폼 바이너리 없이 자리표시 실행 파일만 남거나, package.json 이 갱신되지 않아 다음 설치가 다른 CLI 를 지운다.
        result = await run(npmLaunch.command, [...npmLaunch.leadingArgs, 'install', '--global=false', '--prefix', prefixDir, '--cache', npmCacheDir, '--logs-dir', npmLogsDir, '--update-notifier=false', '--ignore-scripts=false', '--include=optional', '--save', `${item.package}@latest`], { env: withoutHubPrivateEnv(baseEnv), timeoutMs: INSTALL_TIMEOUT_MS, tree: true });
      } finally {
        // Windows 에서는 백신 검사가 방금 받은 tarball 을 잠깐 잡고 있어 EBUSY/EPERM 이 날 수 있으므로 몇 번 다시 시도한다.
        // 그래도 남으면 다음 시작 때 pruneNpmCaches 가 지운다.
        await fs.rm(npmCacheDir, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
      }
      assertPrefixAvailable();
      if (result.code !== 0) throw setupError('AGENT_INSTALL_FAILED', cleanOutput(result.stderr || result.stdout) || 'CLI 설치에 실패했어요.');
      // npm 이 성공해도 실행 파일이 실제로 도는지 확인한 뒤에만 설치 완료로 알린다. 첫 실행은 오래 걸릴 수 있다.
      const bin = binPath(agent);
      const fingerprint = await binFingerprint(agent, bin);
      const probe = await probeVersion(agent, bin, FIRST_PROBE_TIMEOUT_MS);
      if (!probe.version) {
        unusableBins.set(agent, fingerprint);
        failedProbeFingerprints.set(agent, fingerprint);
        installedVersions.delete(agent);
        throw setupError('AGENT_INSTALL_FAILED', 'CLI 를 설치했지만 실행되지 않아요. npm 설정(ignore-scripts, optional 의존성, 레지스트리 미러)을 확인한 뒤 다시 설치해 주세요.',
          cleanOutput(probe.result?.stderr || probe.result?.stdout) || null);
      }
      unusableBins.delete(agent);
      return { fingerprint, version: probe.version };
    });
    installQueue = task.catch(() => {});
    const settled = task.then(
      // 설치 확인에서 읽은 버전을 기억해 바로 이어지는 상태 확인이 CLI 를 다시 띄우지 않게 한다.
      (verified) => { versionProbes.set(agent, { fingerprint: verified.fingerprint, version: Promise.resolve(verified.version) }); },
      (error) => { versionProbes.delete(agent); throw error; },
    ).finally(() => { installs.delete(agent); }).then(async () => {
      onProgress?.({ state: 'installing', phase: 'verifying' });
      const installed = await status(agent);
      onProgress?.({ state: 'done' });
      return installed;
    });
    installs.set(agent, settled);
    return settled;
  }
  /** npm replaces .bin targets while installing; resolve a launch only after the shared prefix is stable. */
  async function prepareLaunch(agent) {
    assertAgent(agent);
    await load();
    // 설정 화면에서 시작한 설치·업데이트가 실패해도 이 실행과는 상관없으므로 기존 실행 파일로 계속한다.
    const ownInstall = installs.get(agent);
    if (ownInstall) await ownInstall.catch(() => {});
    let pending;
    do {
      pending = installQueue;
      await pending;
    } while (pending !== installQueue);
    assertPrefixAvailable();
    if (activeLaunches++ === 0) launchReady = new Promise((resolve) => { releaseLaunches = resolve; });
    let released = false;
    const bin = binPath(agent);
    return {
      bin: existsSync(bin) ? bin : null,
      env: envFor(agent),
      release() {
        if (released) return;
        released = true;
        if (--activeLaunches === 0) releaseLaunches();
      },
    };
  }
  async function authenticate(agent, method, key, onProgress, { signal, onCommitted, terminal = false } = {}) {
    assertAgent(agent); await load();
    if (method === 'api-key') {
      if (typeof key !== 'string' || !textFitsByteLimit(key, API_KEY_MAX_BYTES) || !key.trim()) throw setupError('AGENT_KEY_INVALID', 'API 키를 입력해 주세요.');
      const cancelled = () => setupError('AGENT_AUTH_CANCELLED', '로그인을 취소했어요.');
      if (signal?.aborted) throw cancelled();
      const verdict = agent === 'claude' ? await verifyClaude({ apiKey: key.trim(), fetchImpl }) : null;
      if (verdict === 'invalid') throw setupError('AGENT_KEY_INVALID', 'Anthropic 이 이 API 키를 받아들이지 않았어요.');
      if (signal?.aborted) throw cancelled();
      const previous = { key: apiKeys[agent], token: claudeAuth.token, tokenExpiresAt: claudeAuth.tokenExpiresAt, useLocalLogin: claudeAuth.useLocalLogin };
      settleApiKey(agent, key.trim()); if (agent === 'claude') { settleClaudeToken(null, null); claudeAuth.useLocalLogin = true; }
      try {
        if (secretStore?.available) await secretStore.set(`rhwp.${agent}.api-key`, apiKeys[agent]);
        await persist();
        // 저장하는 동안 취소됐으면 커밋하지 않고 이전 자격 증명으로 되돌린다.
        if (signal?.aborted) throw cancelled();
        onCommitted?.();
      } catch (error) {
        settleApiKey(agent, previous.key);
        if (agent === 'claude') { settleClaudeToken(previous.token, previous.tokenExpiresAt); claudeAuth.useLocalLogin = previous.useLocalLogin; }
        if (!previous.key && secretStore?.available) await secretStore.delete?.(`rhwp.${agent}.api-key`)?.catch?.(() => {});
        await persist().catch(() => {});
        throw error;
      }
      if (agent === 'claude') {
        claudeAuth.rejected.delete(apiKeys.claude);
        if (verdict === 'valid') claudeAuth.verified = { secret: apiKeys.claude, result: 'valid', at: now() };
      }
      onProgress?.({ state: 'done' }); return status(agent);
    }
    if (!['oauth', 'login'].includes(method)) throw setupError('AGENT_AUTH_INVALID', '지원하지 않는 로그인 방식이에요.');
    nodeHostShimDir = await ensureNodeHost();
    if (agent !== 'claude') {
      const argv = agent === 'codex' ? [...CODEX_FILE_STORE_ARGS, 'login', '--device-auth'] : ['login'];
      // 앱이 설치한 CLI 가 없으면 PATH 의 CLI 로 로그인한다. 없는 경로를 실행하면 아무 출력 없이 멈춘다.
      const command = existsSync(binPath(agent)) ? binPath(agent) : CONFIG[agent].bin;
      const launch = managedLaunch(command, argv, envFor(agent));
      onProgress?.({ state: 'authorizing', activity: true });
      let code;
      if (terminal) {
        // Studio 는 로그인 터미널을 열고 출력만 기다리므로 CLI 출력(기기 코드·주소)을 그대로 넘긴다.
        const session = createTerminal({
          command: terminalCommand(launch),
          argv: launch.argv,
          env: launch.env,
          cwd: rootDir,
          signal,
          timeoutMs: AUTH_TIMEOUT_MS,
          onOutput: (data) => onProgress?.({ state: 'authorizing', terminalData: data }),
        });
        authTerminals.set(agent, session);
        onProgress?.({ state: 'authorizing', terminalReady: true });
        try { ({ code } = await session.done); } finally { if (authTerminals.get(agent) === session) authTerminals.delete(agent); }
      } else {
        const proc = spawnProcess(launch.command, launch.argv, { env: launch.env, cwd: rootDir, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }); authProcesses.set(agent, proc);
        let output = '';
        const collect = (chunk) => {
          output = `${output}${String(chunk)}`.slice(-16_000);
          const clean = redactDiagnosticText(output).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
          const authUrl = clean.match(/https?:\/\/[^\s<>"'\x07\]]+/)?.[0];
          const userCode = clean.match(/\b[A-Z0-9]{4}-[A-Z0-9]{4,5}\b/)?.[0];
          onProgress?.({ state: 'authorizing', ...(authUrl ? { authUrl } : {}), ...(userCode ? { userCode } : {}) });
        };
        proc.stdout?.on('data', collect); proc.stderr?.on('data', collect);
        try {
          code = await new Promise((resolve, reject) => {
            const abort = () => { proc.kill?.(); reject(setupError('AGENT_AUTH_CANCELLED', '로그인을 취소했어요.')); };
            signal?.addEventListener('abort', abort, { once: true });
            proc.once('error', (error) => { signal?.removeEventListener('abort', abort); reject(setupError('AGENT_AUTH_FAILED', `${command} 을 실행하지 못했어요: ${error?.message ?? error}`)); });
            proc.once('close', (exitCode) => { signal?.removeEventListener('abort', abort); resolve(exitCode); });
          });
        } finally { if (authProcesses.get(agent) === proc) authProcesses.delete(agent); }
      }
      if (code !== 0) throw setupError('AGENT_AUTH_FAILED', 'CLI 로그인을 완료하지 못했어요.');
      onCommitted?.(); onProgress?.({ state: 'done' }); return status(agent);
    }

    // `setup-token` mints a year-long token owned by the app alone. It runs in a
    // throwaway profile so the user's own Claude login is never read or changed.
    const runDir = path.join(claudeLoginDir, `run-${randomUUID()}`);
    const configDir = path.join(runDir, '.claude');
    await fs.mkdir(configDir, { recursive: true, mode: 0o700 });
    const command = existsSync(binPath('claude')) ? binPath('claude') : (bundledClaudeBin ?? 'claude');
    const loginEnv = {
      ...claudeCleanEnv(),
      HOME: platform === 'darwin' ? hostProfileHome : runDir,
      USERPROFILE: runDir,
      CLAUDE_CONFIG_DIR: configDir,
      ...(platform === 'darwin' ? {} : { CLAUDE_SECURESTORAGE_CONFIG_DIR: configDir }),
    };
    const launch = managedLaunch(command, ['setup-token'], loginEnv);
    let output = '';
    const keep = (data) => { output = `${output}${String(data)}`.slice(-65_536); };
    const screen = terminal ? createLoginScreen() : null;
    onProgress?.({ state: 'authorizing', activity: true });
    try {
      let result;
      if (terminal) {
        const session = createTerminal({
          command: terminalCommand(launch),
          argv: launch.argv,
          env: launch.env,
          cwd: runDir,
          signal,
          timeoutMs: AUTH_TIMEOUT_MS,
          onOutput: (data) => { keep(data); screen.write(data); onProgress?.({ state: 'authorizing', terminalData: data }); },
        });
        loginScreens.set(agent, screen);
        authTerminals.set(agent, session);
        onProgress?.({ state: 'authorizing', terminalReady: true });
        try { result = await session.done; } finally {
          if (authTerminals.get(agent) === session) authTerminals.delete(agent);
          if (loginScreens.get(agent) === screen) loginScreens.delete(agent);
        }
      } else {
        const proc = spawnProcess(launch.command, launch.argv, { env: launch.env, cwd: runDir, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
        authProcesses.set(agent, proc);
        const collect = (chunk) => {
          keep(chunk);
          const authUrl = redactDiagnosticText(output).match(/https?:\/\/[^\s<>"'\x07\]]+/)?.[0];
          onProgress?.({ state: 'authorizing', ...(authUrl ? { authUrl } : {}) });
        };
        proc.stdout?.on('data', collect); proc.stderr?.on('data', collect);
        try {
          result = await new Promise((resolve, reject) => {
            const timer = setTimeout(() => { proc.kill?.(); reject(setupError('AGENT_AUTH_TIMEOUT', '로그인 시간이 만료됐어요. 다시 시도해 주세요.')); }, AUTH_TIMEOUT_MS);
            const abort = () => { proc.kill?.(); clearTimeout(timer); reject(setupError('AGENT_AUTH_CANCELLED', '로그인을 취소했어요.')); };
            if (signal?.aborted) { abort(); return; }
            signal?.addEventListener('abort', abort, { once: true });
            proc.once('error', (error) => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(setupError('AGENT_AUTH_FAILED', `Claude 로그인을 시작하지 못했어요: ${error?.message ?? error}`)); });
            proc.once('close', (code) => { clearTimeout(timer); signal?.removeEventListener('abort', abort); resolve({ code }); });
          });
        } finally { if (authProcesses.get(agent) === proc) authProcesses.delete(agent); }
      }
      const parsed = (screen ? parseClaudeSetupTokenOutput(await screen.text()) : null)
        ?? parseClaudeSetupTokenOutput(output);
      if (!parsed) {
        const detail = cleanOutput(output).split('\n').map((line) => line.trim()).filter(Boolean).slice(-3).join(' ');
        throw setupError('AGENT_AUTH_FAILED', result?.code === 0
          ? 'Claude 로그인이 끝났지만 토큰을 받지 못했어요. 다시 시도해 주세요.'
          : 'Claude 로그인을 완료하지 못했어요. 다시 시도해 주세요.', detail.slice(-300) || null);
      }
      if (signal?.aborted) throw setupError('AGENT_AUTH_CANCELLED', '로그인을 취소했어요.');
      const verdict = await verifyClaude({ token: parsed.token, fetchImpl });
      if (verdict === 'invalid') throw setupError('AGENT_AUTH_FAILED', 'Anthropic 이 새 토큰을 받아들이지 않았어요. 다시 로그인해 주세요.');
      onCommitted?.();
      settleClaudeToken(parsed.token, now() + CLAUDE_TOKEN_LIFETIME_MS);
      claudeAuth.useLocalLogin = true;
      claudeAuth.rejected.delete(parsed.token);
      claudeAuth.verified = verdict === 'valid' ? { secret: parsed.token, result: 'valid', at: now() } : null;
      settleApiKey('claude', null);
      if (secretStore?.available) await secretStore.delete?.('rhwp.claude.api-key')?.catch?.(() => {});
      // The token is live in memory now. A failed save only loses it on the next restart.
      try { await persist(); } catch (error) { process.stderr.write(`[cli-setup] Claude 로그인 후 설정 저장 실패: ${redactDiagnosticText(String(error?.message ?? error))}\n`); }
      onProgress?.({ state: 'done' });
      return status(agent);
    } finally {
      screen?.dispose();
      await fs.rm(runDir, { recursive: true, force: true }).catch(() => {});
      // Some CLI builds park even a setup-token session in the Keychain.
      if (platform === 'darwin') {
        await deleteKeychainItem?.(claudeKeychainService({ configDir, hasConfigDir: true }))?.catch?.(() => {});
      }
    }
  }
  /** Forget the app's Claude credentials and stop reusing the terminal login. */
  async function disconnect(agent) {
    assertAgent(agent); await load();
    if (agent !== 'claude') throw setupError('AGENT_SETUP_INVALID', '이 프로바이더는 앱에서 연결을 해제할 수 없어요.');
    await cancelLogin(agent);
    settleClaudeToken(null, null);
    claudeAuth.useLocalLogin = false;
    claudeAuth.local = null;
    claudeAuth.verified = null;
    settleApiKey('claude', null);
    if (secretStore?.available) await secretStore.delete?.('rhwp.claude.api-key')?.catch?.(() => {});
    await persist();
    return status(agent);
  }
  /** 예전 공유 캐시와, 끝나지 못한(허브 종료 등) 설치가 남긴 임시 캐시를 지운다. 다른 허브가 아직 쓰고 있을 수 있는 최근 것은 남긴다. */
  async function pruneNpmCaches() {
    await fs.rm(legacyNpmCacheDir, { recursive: true, force: true }).catch(() => {});
    const entries = await fs.readdir(npmCacheRunsDir).catch(() => []);
    const cutoff = now() - 2 * INSTALL_TIMEOUT_MS;
    await Promise.all(entries.map((name) => {
      const startedAt = Number.parseInt(name, 10);
      return Number.isFinite(startedAt) && startedAt < cutoff
        ? fs.rm(path.join(npmCacheRunsDir, name), { recursive: true, force: true }).catch(() => {})
        : null;
    }));
  }
  async function cancelLogin(agent) { const terminal = authTerminals.get(agent); if (terminal) return terminal.cancel().catch(() => false); const proc = authProcesses.get(agent); if (!proc) return false; proc.kill?.(); authProcesses.delete(agent); return true; }
  return {
    rootDir, prefixDir, binDir, codexOAuthStagingDir: path.join(rootDir, 'codex-oauth-staging'), claudeOAuthStagingDir, claudeLoginDir, binPath, envFor,
    nodeHostDir: () => nodeHostShimDir,
    async init() { await fs.mkdir(rootDir, { recursive: true, mode: 0o700 }); await cleanupStaleOAuthCredentialStaging(claudeOAuthStagingDir).catch(() => {});
      // Earlier builds copied Claude logins into these folders. Nothing reads them now.
      await fs.rm(claudeLoginDir, { recursive: true, force: true }).catch(() => {});
      await fs.rm(legacyClaudeSeedDir, { recursive: true, force: true }).catch(() => {});
      await pruneNpmCaches(); nodeHostShimDir = await ensureNodeHost().catch(() => null); await load(); return this; },
    status, authStatus, install, prepareLaunch, authenticate,
    /** 설치나 로그인이 도는 중인지. 데스크톱이 창 없이 허브를 내리기 전에 묻는다. */
    busy: () => installs.size > 0 || authProcesses.size > 0 || authTerminals.size > 0,
    async submitAuthCode(agent, code) { assertAgent(agent); if (typeof code !== 'string' || Buffer.byteLength(code) > AUTH_CODE_MAX_BYTES) throw setupError('AGENT_AUTH_CODE_INVALID', '인증 코드가 올바르지 않아요.'); if (authTerminals.has(agent)) authTerminals.get(agent).write(`${code.trim()}\n`); else authProcesses.get(agent)?.stdin?.write?.(`${code.trim()}\n`); },
    terminalSnapshot(agent) { return authTerminals.get(agent)?.snapshot() ?? null; }, terminalInput(agent, data) { authTerminals.get(agent)?.write(String(data ?? '')); }, terminalResize(agent, cols, rows) { authTerminals.get(agent)?.resize(cols, rows); loginScreens.get(agent)?.resize(cols, rows); },
    async cancel(agent) { return cancelLogin(agent); },
    disconnect,
    verifyAuth(agent, options) { assertAgent(agent); return agent === 'claude' ? verifyClaudeAuth(options) : Promise.resolve(null); },
    refreshAuth(agent) { assertAgent(agent); return agent === 'claude' ? load().then(refreshLocalClaudeLogin) : Promise.resolve(); },
    /** registry 최신 버전만 확인한다. 설치는 사용자가 업데이트를 누를 때 install() 로 진행한다. */
    async automaticUpdate(agent) {
      const item = assertAgent(agent);
      const current = await status(agent);
      if (!current.version) return current;
      try { latestVersions[agent] = (await fetchLatestPackage(fetchImpl, item.package)).version; } catch { return current; }
      return status(agent);
    },
  };
}
