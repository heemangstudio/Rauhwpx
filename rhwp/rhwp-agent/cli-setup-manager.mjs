import { existsSync, promises as fs, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { applyManagedCliLaunch, createNodeHost } from './npm-cli-launch.mjs';
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

const require = createRequire(import.meta.url);
let crossSpawn = null;
function spawn(command, args, options) { crossSpawn ??= require('cross-spawn'); return crossSpawn(command, args, options); }
const CONFIG = Object.freeze({
  claude: { package: '@anthropic-ai/claude-code', bin: 'claude', keyEnv: 'ANTHROPIC_API_KEY' },
  codex: { package: '@openai/codex', bin: 'codex', keyEnv: 'OPENAI_API_KEY' },
});
const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;
const STATUS_TIMEOUT_MS = 10_000;
const AUTH_TIMEOUT_MS = 10 * 60 * 1000;
const CLAUDE_TOKEN_SECRET = 'rhwp.claude.oauth-token';
// `claude setup-token` tokens last a year. The CLI does not report the exact
// expiry in a machine-readable form, so the app keeps a slightly short copy.
const CLAUDE_TOKEN_LIFETIME_MS = 364 * 24 * 60 * 60 * 1000;
const CLAUDE_VERIFY_TTL_MS = 10 * 60 * 1000;
// A reused terminal login is only handed out while it has this much life left.
const CLAUDE_LOCAL_LOGIN_MIN_REMAINING_MS = 5 * 60 * 1000;
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
function setupError(code, message) { const error = new Error(message); error.code = code; return error; }
function keyTail(value) { const text = String(value ?? '').trim(); return text ? text.slice(-4) : null; }
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
export function createCliSetupManager({ rootDir = defaultCliSetupRoot(), spawnProcess = spawn, createTerminal = createSetupTerminal, npmCommand = null, nodeCommand = process.execPath, platform = process.platform, baseEnv = process.env, homeDir = os.homedir(), secretStore = null, readClaudeLogin = readClaudeOAuthCredential, verifyClaude = verifyClaudeCredential, deleteKeychainItem = null, fetchImpl = globalThis.fetch, bundledClaudeVersion = bundledClaudeCodeVersion(), bundledClaudeBin = bundledClaudeBinary(), now = Date.now } = {}) {
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
  };
  const npmLaunch = bundledNpmLaunch({ nodeCommand, npmCommand });
  const ensureNodeHost = createNodeHost({ rootDir, nodeCommand, platform });
  const apiKeys = { claude: null, codex: null };
  const latestVersions = { claude: null, codex: null };
  const authProcesses = new Map();
  const authTerminals = new Map();
  const loginScreens = new Map();
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
  function binPath(agent) { const item = assertAgent(agent); return path.join(binDir, platform === 'win32' ? `${item.bin}.cmd` : item.bin); }
  function claudeCleanEnv() {
    const env = { ...baseEnv };
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
    const env = { ...baseEnv }; delete env.ANTHROPIC_API_KEY; delete env.OPENAI_API_KEY; if (apiKeys[agent]) env[item.keyEnv] = apiKeys[agent]; return env;
  }
  /** Re-read a terminal Claude login. Skipped while the app owns a credential. */
  async function refreshLocalClaudeLogin() {
    const current = claudeCredential();
    if (!claudeAuth.useLocalLogin || current?.source === 'app' || current?.source === 'api-key') return;
    const found = await readClaudeLogin({ homeDir: hostProfileHome, env: baseEnv, platform }).catch(() => null);
    const parsed = found ? parseClaudeOAuthCredential(found.text) : null;
    claudeAuth.local = parsed
      ? { token: parsed.claudeAiOauth.accessToken, expiresAt: claudeCredentialExpiry(parsed) || null }
      : null;
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
    try { child = spawnProcess(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'], env: options.env ?? baseEnv }); } catch (error) { return { code: null, stdout: '', stderr: String(error?.message ?? error) }; }
    let stdout = ''; let stderr = '';
    child.stdout?.on('data', (chunk) => { stdout += String(chunk); }); child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
    return await new Promise((resolve) => {
      const timer = setTimeout(() => { child.kill?.(); resolve({ code: null, stdout, stderr: `${stderr}\ntimeout` }); }, options.timeoutMs ?? STATUS_TIMEOUT_MS);
      child.on('error', (error) => { clearTimeout(timer); resolve({ code: null, stdout, stderr: `${stderr}\n${error?.message ?? error}` }); });
      child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
    });
  }
  /** `codex login` 이 남긴 auth.json 을 확인한다. 허브도 같은 파일을 세션에 연결해 쓴다. */
  async function readCodexLogin() {
    const codexHome = typeof baseEnv.CODEX_HOME === 'string' && baseEnv.CODEX_HOME.trim()
      ? platformPath.resolve(baseEnv.CODEX_HOME)
      : platformPath.join(hostProfileHome, '.codex');
    try {
      const auth = JSON.parse(await fs.readFile(platformPath.join(codexHome, 'auth.json'), 'utf8'));
      return Boolean(auth?.tokens?.refresh_token || auth?.tokens?.access_token || auth?.OPENAI_API_KEY);
    } catch { return false; }
  }
  async function status(agent) {
    assertAgent(agent); await load(); const bin = binPath(agent); let version = null;
    if (existsSync(bin)) { const result = await run(bin, ['--version'], { env: envFor(agent) }); if (result.code === 0) version = cleanOutput(result.stdout).split(/\s+/)[0] || null; }
    let authenticated = Boolean(apiKeys[agent]);
    let authMethod = authenticated ? 'api-key' : null;
    if (agent === 'codex' && !authenticated && await readCodexLogin()) {
      authenticated = true;
      authMethod = 'oauth';
    }
    let authSource = null;
    let authVerifiedAt = null;
    if (agent === 'claude') {
      await refreshLocalClaudeLogin();
      const credential = claudeCredential();
      const secret = credential?.token ?? credential?.apiKey ?? null;
      authenticated = Boolean(credential);
      authMethod = !authenticated ? null : (credential.apiKey ? 'api-key' : 'oauth');
      authSource = authenticated ? credential.source : null;
      const verified = claudeAuth.verified;
      if (authenticated && verified?.secret === secret && verified.result === 'valid') authVerifiedAt = verified.at;
    }
    // 관리형 CLI 가 없으면 Claude 는 SDK 번들 런타임으로 실행되므로 그 버전을 기준으로 삼는다.
    const runtimeVersion = version ?? (agent === 'claude' ? bundledClaudeVersion : null);
    const latestVersion = latestVersions[agent];
    const updateRequired = Boolean(runtimeVersion && latestVersion && isNewerVersion(latestVersion, runtimeVersion));
    return { installed: Boolean(version || existsSync(bin)), installing: false, version: runtimeVersion, authenticated, authMethod, ...(agent === 'claude' ? { authSource, authVerifiedAt } : {}), keyTail: keyTail(apiKeys[agent]), latestVersion, updateRequired, error: null };
  }
  async function install(agent, onProgress) {
    const item = assertAgent(agent); await load(); onProgress?.({ state: 'installing', phase: 'install', activity: true }); await fs.mkdir(rootDir, { recursive: true, mode: 0o700 });
    const result = await run(npmLaunch.command, [...npmLaunch.leadingArgs, 'install', '--prefix', prefixDir, `${item.package}@latest`], { env: baseEnv, timeoutMs: INSTALL_TIMEOUT_MS });
    if (result.code !== 0) throw setupError('AGENT_INSTALL_FAILED', cleanOutput(result.stderr || result.stdout) || 'CLI 설치에 실패했어요.'); onProgress?.({ state: 'done' }); return status(agent);
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
    if (agent !== 'claude') {
      const argv = agent === 'codex' ? ['login', '--device-auth'] : ['login'];
      // 앱이 설치한 CLI 가 없으면 PATH 의 CLI 로 로그인한다. 없는 경로를 실행하면 아무 출력 없이 멈춘다.
      const command = existsSync(binPath(agent)) ? binPath(agent) : CONFIG[agent].bin;
      onProgress?.({ state: 'authorizing', activity: true });
      let code;
      if (terminal) {
        // Studio 는 로그인 터미널을 열고 출력만 기다리므로 CLI 출력(기기 코드·주소)을 그대로 넘긴다.
        const session = createTerminal({
          command,
          argv,
          env: envFor(agent),
          cwd: rootDir,
          signal,
          timeoutMs: AUTH_TIMEOUT_MS,
          onOutput: (data) => onProgress?.({ state: 'authorizing', terminalData: data }),
        });
        authTerminals.set(agent, session);
        onProgress?.({ state: 'authorizing', terminalReady: true });
        try { ({ code } = await session.done); } finally { if (authTerminals.get(agent) === session) authTerminals.delete(agent); }
      } else {
        const proc = spawnProcess(command, argv, { env: envFor(agent), cwd: rootDir, stdio: ['pipe', 'pipe', 'pipe'] }); authProcesses.set(agent, proc);
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
    let output = '';
    const keep = (data) => { output = `${output}${String(data)}`.slice(-65_536); };
    const screen = terminal ? createLoginScreen() : null;
    onProgress?.({ state: 'authorizing', activity: true });
    try {
      let result;
      if (terminal) {
        const session = createTerminal({
          command,
          argv: ['setup-token'],
          env: loginEnv,
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
        const proc = spawnProcess(command, ['setup-token'], { env: loginEnv, cwd: runDir, stdio: ['pipe', 'pipe', 'pipe'] });
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
          : `Claude 로그인을 완료하지 못했어요.${detail ? ` ${detail.slice(-300)}` : ''}`);
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
  async function cancelLogin(agent) { const terminal = authTerminals.get(agent); if (terminal) return terminal.cancel().catch(() => false); const proc = authProcesses.get(agent); if (!proc) return false; proc.kill?.(); authProcesses.delete(agent); return true; }
  return {
    rootDir, prefixDir, binDir, codexOAuthStagingDir: path.join(rootDir, 'codex-oauth-staging'), claudeOAuthStagingDir, claudeLoginDir, binPath, envFor,
    nodeHostDir: () => nodeHostShimDir,
    async init() { await fs.mkdir(rootDir, { recursive: true, mode: 0o700 }); await cleanupStaleOAuthCredentialStaging(claudeOAuthStagingDir).catch(() => {});
      // Earlier builds copied Claude logins into these folders. Nothing reads them now.
      await fs.rm(claudeLoginDir, { recursive: true, force: true }).catch(() => {});
      await fs.rm(legacyClaudeSeedDir, { recursive: true, force: true }).catch(() => {}); nodeHostShimDir = await ensureNodeHost().catch(() => null); await load(); return this; },
    status, install, authenticate,
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
