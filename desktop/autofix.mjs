import { existsSync, realpathSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn as nodeSpawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { PRODUCT_NAME } from './app-identity.mjs';
import { buildHubPath, findOnPath, sanitizeHubEnv } from './agent-hub.mjs';
import { aliveTracked, createCwdReader, createProcessKiller, createProcessLister, createTreeWatcher, findRunOrphans, killSurvivors } from './autofix-process.mjs';
import { redactSecrets } from './diagnostic-log.mjs';
import { replaceFile } from './fs-replace.mjs';
import { buildFeedbackPayload, DEFAULT_FEEDBACK_PROOF_KEY, FEEDBACK_LIMITS, submitFeedback } from './issue-report.mjs';
import { loadOrCreateUniqueInstallState, uniqueInstallStatePath } from './unique-install.mjs';
import { bundledClaudeBinary, createCliSetupManager, defaultCliSetupRoot } from '../rhwp/rhwp-agent/cli-setup-manager.mjs';
import { OFFICIAL_CLAUDE_MODELS } from '../rhwp/rhwp-agent/claude-model-label.mjs';
import { codexLineup, createCodexModelResolver, discoverCodexModels } from '../rhwp/rhwp-agent/codex-model-routing.mjs';
import { applyManagedCliLaunch, applyNodeHostEnv, createNodeHost } from '../rhwp/rhwp-agent/npm-cli-launch.mjs';
import { defaultPiRoot } from '../rhwp/rhwp-agent/pi-manager.mjs';
import { processTreeSpawnOptions, terminateProcessTree } from '../rhwp/rhwp-agent/process-tree.mjs';

// 자동 수정. 새로고침으로 풀리지 않는 오류에서 사용자가 누르면, 코딩 에이전트(Codex → Claude 순, 설정으로 바꿀 수 있다)를
// 창 없이 전체 권한으로 띄워 이 컴퓨터의 앱 상태만 고치게 하고, 끝나면 문제 보고(#581) 경로로 개발자에게 알린다.

export const AUTOFIX_SETTINGS_FILE = 'autofix-settings.json';
export const AUTOFIX_TIMEOUT_MS = 8 * 60_000;
const CODEX_DISCOVERY_TIMEOUT_MS = 10_000;
const LOG_TAIL_BYTES = 64 * 1024;
const AGENT_OUTPUT_TAIL_BYTES = 32 * 1024;
const OUTPUT_CAPTURE_BYTES = 256 * 1024;

export const AUTOFIX_EFFORTS = Object.freeze({
  codex: Object.freeze(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']),
  claude: Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']),
});
const CODEX_LINEUPS = new Set(['astra', 'sol', 'luna', 'terra']);
/**
 * 자동 수정의 Claude 모델 선택지: 채팅의 공식 목록에 Sonnet 5.5 를 더한다(채팅 목록은 그대로 둔다).
 * Studio 사본은 rhwp-studio/src/agent/models.ts 의 AUTOFIX_CLAUDE_MODELS 다.
 */
export const AUTOFIX_CLAUDE_MODELS = Object.freeze(OFFICIAL_CLAUDE_MODELS.includes('claude-sonnet-5-5')
  ? [...OFFICIAL_CLAUDE_MODELS]
  : OFFICIAL_CLAUDE_MODELS.flatMap((id) => (id === 'claude-sonnet-5' ? ['claude-sonnet-5-5', id] : [id])));
const DEFAULT_PROVIDERS = Object.freeze([
  Object.freeze({ id: 'codex', enabled: true, model: 'sol', effort: 'low' }),
  Object.freeze({ id: 'claude', enabled: true, model: 'claude-sonnet-5-5', effort: 'medium' }),
]);
/**
 * 마지막 수단: 선물 크레딧. Codex·Claude 를 둘 다 쓸 수 없을 때만, 받은 선물에 잔액이 있으면 Pi 를
 * 선물 프록시로 돌린다. 사용자의 OpenRouter 키는 쓰지 않는다. 설정의 순서 목록에는 없다.
 */
export const GIFT_AUTOFIX_MODEL = 'anthropic/claude-sonnet-5.5';
export const GIFT_AUTOFIX_EFFORT = 'medium';

/** @returns {{ enabled: boolean, decided: boolean, providers: Array<{ id: 'codex'|'claude', enabled: boolean, model: string, effort: string }> }} */
export function defaultAutofixSettings() {
  return { enabled: false, decided: false, providers: DEFAULT_PROVIDERS.map((entry) => ({ ...entry })) };
}

function normalizeProviderEntry(raw, base) {
  const entry = raw && typeof raw === 'object' ? raw : {};
  const fallback = DEFAULT_PROVIDERS.find((item) => item.id === base.id);
  let model = typeof entry.model === 'string' ? entry.model.trim() : base.model;
  if (base.id === 'codex') model = codexLineup(model) ?? (CODEX_LINEUPS.has(base.model) ? base.model : fallback.model);
  else if (!AUTOFIX_CLAUDE_MODELS.includes(model)) model = AUTOFIX_CLAUDE_MODELS.includes(base.model) ? base.model : fallback.model;
  const efforts = AUTOFIX_EFFORTS[base.id];
  let effort = typeof entry.effort === 'string' ? entry.effort.trim() : base.effort;
  if (!efforts.includes(effort)) effort = efforts.includes(base.effort) ? base.effort : fallback.effort;
  return {
    id: base.id,
    enabled: typeof entry.enabled === 'boolean' ? entry.enabled : Boolean(base.enabled),
    model,
    effort,
  };
}

/**
 * 저장하거나 받은 설정을 바로잡는다. 모르는 값은 base(지금 설정 또는 기본값)를 따른다.
 * providers 는 배열 순서가 우선순위이고, 두 id 가 정확히 한 번씩 들어 있다.
 */
export function normalizeAutofixSettings(raw, base = defaultAutofixSettings()) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const providers = [];
  const seen = new Set();
  const baseFor = (id) => base.providers.find((entry) => entry.id === id) ?? DEFAULT_PROVIDERS.find((entry) => entry.id === id);
  if (Array.isArray(source.providers)) {
    for (const entry of source.providers) {
      const id = entry?.id;
      if ((id !== 'codex' && id !== 'claude') || seen.has(id)) continue;
      seen.add(id);
      providers.push(normalizeProviderEntry(entry, baseFor(id)));
    }
  }
  for (const entry of base.providers) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    providers.push(normalizeProviderEntry(null, entry));
  }
  return {
    enabled: typeof source.enabled === 'boolean' ? source.enabled : Boolean(base.enabled),
    decided: typeof source.decided === 'boolean' ? source.decided : Boolean(base.decided),
    providers,
  };
}

/** <userData>/autofix-settings.json. 깨진 파일은 기본값으로 읽고, 쓰기는 임시 파일을 바꿔 끼운다. */
export function createAutofixSettingsStore({ filePath, platform = process.platform, onChange = () => {} }) {
  let current = null;
  let chain = Promise.resolve();
  async function load() {
    if (current) return current;
    try {
      current = normalizeAutofixSettings(JSON.parse(await readFile(filePath, 'utf8')));
    } catch {
      current = defaultAutofixSettings();
    }
    return current;
  }
  const clone = (value) => JSON.parse(JSON.stringify(value));
  return {
    filePath,
    async get() { return clone(await load()); },
    set(patch) {
      const task = chain.then(async () => {
        const base = await load();
        const next = normalizeAutofixSettings({ ...base, ...(patch && typeof patch === 'object' ? patch : {}) }, base);
        await mkdir(path.dirname(filePath), { recursive: true });
        const temp = `${filePath}.${randomUUID()}.tmp`;
        try {
          await writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
          await replaceFile(temp, filePath, platform);
        } finally {
          await rm(temp, { force: true }).catch(() => {});
        }
        current = next;
        try { onChange(clone(next)); } catch {}
        return clone(next);
      });
      chain = task.catch(() => {});
      return task;
    },
  };
}

// ── 요청 ──────────────────────────────────────────────────────────────────

function cleanText(value, max) {
  if (typeof value !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, max);
}

export function sanitizeAutofixRequest(raw) {
  const request = raw && typeof raw === 'object' ? raw : {};
  const attempts = Number(request.attempts);
  return {
    surface: cleanText(request.surface, 80) || 'unknown',
    title: cleanText(request.title, 300) || '알 수 없는 오류',
    detail: cleanText(request.detail, 4000),
    attempts: Number.isFinite(attempts) ? Math.max(0, Math.min(99, Math.trunc(attempts))) : 0,
  };
}

// ── 제공자 찾기 ───────────────────────────────────────────────────────────

function jwtClaims(token) {
  try {
    return JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

/** Codex 로그인(auth.json)의 ChatGPT 요금제. API 키 로그인이나 알 수 없으면 null. */
export function codexPlanType(auth) {
  for (const token of [auth?.tokens?.id_token, auth?.tokens?.access_token]) {
    const plan = jwtClaims(token)?.['https://api.openai.com/auth']?.chatgpt_plan_type;
    if (typeof plan === 'string' && plan.trim()) return plan.trim().toLowerCase();
  }
  return null;
}

export function codexHomeDir({ env = process.env, home = os.homedir(), platform = process.platform } = {}) {
  const pathImpl = platform === 'win32' ? path.win32 : path.posix;
  const configured = typeof env.CODEX_HOME === 'string' ? env.CODEX_HOME.trim() : '';
  return configured ? pathImpl.resolve(configured) : pathImpl.join(home, '.codex');
}

/**
 * 실행 파일 후보를 순서대로: 앱이 설치한 CLI → PATH(GUI 앱에 없는 Homebrew·nvm 등 위치를 더한 것) → Claude 는 SDK 번들 런타임.
 * 앞 후보가 진짜 CLI 가 아니면 다음 후보를 쓴다. Windows 의 .cmd 심은 실행할 때 applyManagedCliLaunch 가 node·exe 로 푼다.
 */
export function resolveCliCandidates(agent, { managedBin, pathEnv, platform = process.platform, exists = existsSync, bundledClaudeBin = null }) {
  const candidates = [];
  const add = (command, source) => {
    if (command && !candidates.some((item) => item.command === command)) candidates.push({ command, source });
  };
  if (managedBin && exists(managedBin)) add(managedBin, 'managed');
  for (const name of platform === 'win32' ? [`${agent}.cmd`, `${agent}.exe`] : [agent]) {
    add(findOnPath(name, pathEnv, exists, platform), 'path');
  }
  if (agent === 'claude' && bundledClaudeBin && exists(bundledClaudeBin)) add(bundledClaudeBin, 'bundled');
  return candidates;
}

/** 넘기는 인자를 그 CLI 가 아는지 `--help` 로 확인한다. 버전 번호보다 정확하다. */
const CLI_IDENTITY = Object.freeze({
  claude: {
    version: /^v?(\d+\.\d+\.\d+)\S*\s+\(Claude Code\)\s*$/m,
    helpArgs: ['--help'],
    flags: ['--print', '--output-format', '--model', '--effort', '--permission-mode', 'bypassPermissions',
      '--dangerously-skip-permissions', '--no-session-persistence', '--setting-sources', '--strict-mcp-config'],
  },
  codex: {
    version: /^codex-cli (\d+\.\d+\.\d+)\S*\s*$/m,
    helpArgs: ['exec', '--help'],
    flags: ['--skip-git-repo-check', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--color',
      '--dangerously-bypass-approvals-and-sandbox', '--model', '--config', '--cd', '--output-last-message'],
  },
  pi: {
    version: /^(\d+\.\d+\.\d+)\S*\s*$/m,
    helpArgs: ['--help'],
    head: /^pi - /m,
    flags: ['--print', '--mode', '--model', '--thinking', '--no-session', '--no-extensions', '--no-skills',
      '--no-prompt-templates', '--no-themes', '--no-context-files', '--no-mcp', '--no-approve', '--offline'],
  },
});

/** `--version`·`--help` 출력이 진짜 Claude Code·Codex CLI·Pi 이고 쓰는 인자를 모두 아는지. */
export function checkCliIdentity(agent, versionOutput, helpOutput) {
  const spec = CLI_IDENTITY[agent];
  if (!spec) return { ok: false, reason: 'unknown-agent' };
  const version = spec.version.exec(String(versionOutput ?? '').trim())?.[1];
  if (!version) return { ok: false, reason: 'not-genuine' };
  const help = String(helpOutput ?? '');
  if (spec.head && !spec.head.test(help)) return { ok: false, reason: 'not-genuine', version };
  const missing = spec.flags.filter((flag) => !help.includes(flag));
  if (missing.length > 0) return { ok: false, reason: `unsupported-flags:${missing.join(',')}`, version };
  return { ok: true, version };
}

/**
 * 실행 파일이 진짜 CLI 인지 창 없이 `--version`·`--help` 로 확인한다. 결과는 실제 파일 경로·수정 시각·크기마다 기억한다.
 */
export function createCliIdentityVerifier({
  platform = process.platform,
  nodeCommand = process.execPath,
  spawnProcess,
  statImpl = stat,
  realpath = (file) => { try { return realpathSync(file); } catch { return file; } },
  timeoutMs = 20_000,
}) {
  const cache = new Map();
  const runText = (command, args, env) => new Promise((resolve) => {
    let child;
    try {
      const launch = applyManagedCliLaunch(command, args, { platform, nodeCommand, env });
      if (platform === 'win32' && /\.(?:cmd|bat)$/i.test(launch.command)) {
        resolve(null);
        return;
      }
      child = spawnProcess(launch.command, launch.argv, { shell: false, detached: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: launch.env });
    } catch {
      resolve(null);
      return;
    }
    let out = '';
    const timer = setTimeout(() => { void terminateProcessTree(child, { platform }); resolve(null); }, timeoutMs);
    child.stdout?.on('data', (chunk) => { out += String(chunk); });
    child.stderr?.on('data', (chunk) => { out += String(chunk); });
    child.on('error', () => { clearTimeout(timer); resolve(null); });
    child.on('close', () => { clearTimeout(timer); resolve(out); });
  });
  return async function verifyCliIdentity(agent, command, env) {
    const real = realpath(command);
    const info = await statImpl(real).catch(() => null);
    if (!info) return { ok: false, reason: 'missing' };
    const key = `${agent}\0${command}\0${real}\0${info.mtimeMs}\0${info.size}`;
    if (!cache.has(key)) {
      cache.set(key, (async () => {
        const versionOutput = await runText(command, ['--version'], env);
        const pre = checkCliIdentity(agent, versionOutput, '');
        if (!pre.version) return { ok: false, reason: 'not-genuine' };
        const helpOutput = await runText(command, CLI_IDENTITY[agent].helpArgs, env);
        return checkCliIdentity(agent, versionOutput, helpOutput);
      })());
    }
    const result = await cache.get(key);
    // 실행이 실패한 결과(시간 초과 등)는 다음 번에 다시 확인한다.
    if (!result.ok && result.reason === 'not-genuine') cache.delete(key);
    return result;
  };
}

/**
 * 창·브라우저·업데이트를 띄우지 않게 하는 환경. BROWSER 는 POSIX 의 `true` 로(열려는 주소를 그냥 버린다),
 * Claude 는 자동 업데이트와 필수 아닌 통신을 끈다.
 */
export function hardenAgentEnv(env, provider, platform = process.platform) {
  const next = { ...env, NO_COLOR: '1', TERM: 'dumb' };
  if (platform !== 'win32') next.BROWSER = 'true';
  if (provider === 'claude') {
    next.DISABLE_AUTOUPDATER = '1';
    next.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
  }
  return next;
}

/**
 * 제공자 하나를 쓸 수 있는지 본다: 실행 파일이 있고 로그인돼 있어야 한다. Codex 는 무료 ChatGPT 계정이면 쓰지 않는다.
 * @returns {Promise<{ available: true, command: string, source: string, env: Record<string,string> } | { available: false, reason: string }>}
 */
export async function probeAutofixProvider(agent, {
  cliSetup,
  baseEnv,
  home,
  platform = process.platform,
  exists = existsSync,
  readFileImpl = readFile,
  bundledClaudeBin = null,
  verifyIdentity,
}) {
  const pathEnv = buildHubPath({ home, envPath: baseEnv.PATH ?? baseEnv.Path ?? '', exists, platform });
  const candidates = resolveCliCandidates(agent, { managedBin: cliSetup.binPath(agent), pathEnv, platform, exists, bundledClaudeBin });
  if (candidates.length === 0) return { available: false, reason: 'missing' };
  const env = { ...cliSetup.envFor(agent), PATH: pathEnv };
  if (platform === 'win32') env.Path = pathEnv;
  let found = null;
  const rejected = [];
  for (const candidate of candidates) {
    const identity = await verifyIdentity(agent, candidate.command, hardenAgentEnv(env, agent, platform)).catch(() => ({ ok: false, reason: 'probe-failed' }));
    if (identity.ok) {
      found = { ...candidate, version: identity.version };
      break;
    }
    rejected.push(`${candidate.source}:${identity.reason}`);
  }
  if (!found) return { available: false, reason: `not-genuine (${rejected.join(', ')})` };
  const auth = await cliSetup.authStatus(agent).catch(() => null);
  const envKey = agent === 'codex' && typeof baseEnv.CODEX_API_KEY === 'string' && baseEnv.CODEX_API_KEY.trim();
  if (!auth?.authenticated && !envKey) return { available: false, reason: 'signed-out' };
  if (agent === 'codex' && auth?.authMethod === 'oauth') {
    let plan = null;
    try {
      plan = codexPlanType(JSON.parse(await readFileImpl(path.join(codexHomeDir({ env: baseEnv, home, platform }), 'auth.json'), 'utf8')));
    } catch {}
    if (plan === 'free') return { available: false, reason: 'free-plan' };
  }
  return { available: true, command: found.command, source: found.source, version: found.version, env };
}

// ── 실행 ──────────────────────────────────────────────────────────────────

export function codexAutofixArgv({ model, effort, cwd, outputFile }) {
  return [
    'exec',
    '--skip-git-repo-check', '--ephemeral', '--ignore-user-config', '--ignore-rules',
    '--color', 'never',
    // 업데이트 확인과 완료 알림(notify 명령)을 끈다. 사용자 config.toml 의 hooks·notify·MCP 는 --ignore-user-config 로 읽지 않는다.
    '-c', 'check_for_update_on_startup=false',
    '-c', 'notify=[]',
    // 전체 권한: 승인 없이, 샌드박스 없이 돈다.
    '--dangerously-bypass-approvals-and-sandbox',
    '-m', model,
    '-c', `model_reasoning_effort=${JSON.stringify(effort)}`,
    '-C', cwd,
    '-o', outputFile,
    '-',
  ];
}

export function claudeAutofixArgv({ model, effort }) {
  return [
    '-p',
    '--output-format', 'json',
    '--model', model,
    '--effort', effort,
    '--permission-mode', 'bypassPermissions', '--dangerously-skip-permissions',
    '--no-session-persistence',
    '--setting-sources', '',
    '--strict-mcp-config',
  ];
}

export function piAutofixArgv({ model, effort }) {
  return [
    '-p',
    '--mode', 'text',
    '--model', `openrouter/${model}`,
    '--thinking', effort,
    '--no-session',
    // 앱의 선물 홈만 읽는다: 사용자 Pi 설정·확장·스킬·AGENTS.md 는 싣지 않는다. 기본 도구(read·bash·edit·write)는 모두 켠다.
    '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes', '--no-context-files', '--no-mcp', '--no-approve',
    '--offline',
  ];
}

/** 선물 프록시 주소. https, 또는 개발용 루프백 http 만 받는다. OpenRouter 로 바로 가는 주소는 받지 않는다. */
function giftProxyUrl(raw) {
  let url;
  try { url = new URL(String(raw ?? '').trim()); } catch { return null; }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) return null;
  if (url.hostname === 'openrouter.ai' || url.hostname.endsWith('.openrouter.ai')) return null;
  if (url.username || url.password || url.search || url.hash) return null;
  return url.toString().replace(/\/+$/, '');
}

/** 자동 수정 전용 Pi 홈: 선물 프록시와 모델 하나만 담는다. apiKey 는 두지 않는다(리스는 env 로만). */
export async function writeGiftPiHome(dir, { baseUrl, model = GIFT_AUTOFIX_MODEL }) {
  await mkdir(dir, { recursive: true });
  const levels = { off: null, minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', xhigh: null, max: null };
  const models = {
    providers: {
      openrouter: {
        baseUrl,
        api: 'openai-completions',
        models: [{
          id: model,
          name: model,
          reasoning: true,
          input: ['text'],
          contextWindow: 200_000,
          maxTokens: 32_000,
          thinkingLevelMap: levels,
          compat: { openRouterRouting: { require_parameters: true, sort: 'throughput' } },
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        }],
      },
    },
  };
  const settings = { defaultProjectTrust: 'never', enableSkillCommands: false, enableInstallTelemetry: false };
  await writeFile(path.join(dir, 'models.json'), `${JSON.stringify(models, null, 2)}\n`, { mode: 0o600 });
  await writeFile(path.join(dir, 'settings.json'), `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
}

/**
 * 선물 크레딧으로 돌 수 있는지 본다. 받았고(claimed) 잔액이 있는 활성 선물과, 앱이 설치한 Pi 가 있어야 한다.
 * env 에는 사용자 키 대신 선물 리스만 OPENROUTER_API_KEY 로 싣는다.
 */
export async function probeGiftProvider({ credentials, piBin, agentDir, baseEnv, home, platform = process.platform, exists = existsSync, verifyIdentity }) {
  if (!piBin || !exists(piBin)) return { available: false, reason: 'missing' };
  const gift = await Promise.resolve().then(() => credentials?.()).catch(() => null);
  const baseUrl = giftProxyUrl(gift?.baseUrl);
  const remaining = Number(gift?.remainingUsd);
  if (!gift?.active || gift.claimed !== true || typeof gift.lease !== 'string' || !gift.lease || !baseUrl
    || !(Number.isFinite(remaining) && remaining > 0)) {
    return { available: false, reason: 'gift-inactive' };
  }
  const pathEnv = buildHubPath({ home, envPath: baseEnv.PATH ?? baseEnv.Path ?? '', exists, platform });
  const env = {};
  for (const [name, value] of Object.entries(baseEnv)) {
    // 사용자의 OpenRouter·Anthropic·OpenAI 키는 넘기지 않는다.
    if (/^(?:OPENROUTER|ANTHROPIC|OPENAI|CODEX|CLAUDE_CODE|PI)_/i.test(name)) continue;
    env[name] = value;
  }
  Object.assign(env, {
    PATH: pathEnv,
    PI_CODING_AGENT_DIR: agentDir,
    OPENROUTER_API_KEY: gift.lease,
    PI_OFFLINE: '1',
    PI_TELEMETRY: '0',
  });
  if (platform === 'win32') env.Path = pathEnv;
  const identity = await verifyIdentity('pi', piBin, hardenAgentEnv(env, 'gift', platform)).catch(() => ({ ok: false, reason: 'probe-failed' }));
  if (!identity.ok) return { available: false, reason: `not-genuine (${identity.reason})` };
  return { available: true, command: piBin, source: 'gift', version: identity.version, env, baseUrl, remainingUsd: remaining };
}

/** Claude `-p --output-format json` 출력의 result. 오류 결과나 읽을 수 없는 출력은 null. */
export function claudeResultText(stdout) {
  const text = String(stdout ?? '').trim();
  const candidates = [text, ...text.split('\n').reverse()];
  for (const candidate of candidates) {
    try {
      const value = JSON.parse(candidate);
      if (Array.isArray(value)) {
        const result = value.findLast?.((item) => item?.type === 'result');
        if (result) return result.is_error ? null : (typeof result.result === 'string' ? result.result : null);
      }
      if (value && typeof value === 'object' && 'result' in value) {
        return value.is_error ? null : (typeof value.result === 'string' ? value.result : null);
      }
    } catch {}
  }
  return null;
}

/** 에이전트의 마지막 답에서 {"fixed","cause","touched","suggestedFix"} 를 꺼낸다. 코드 울타리를 견딘다. */
export function parseAutofixAnswer(text) {
  const source = String(text ?? '');
  const attempts = [];
  for (const match of source.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) attempts.push(match[1]);
  const first = source.indexOf('{');
  const last = source.lastIndexOf('}');
  if (first >= 0 && last > first) attempts.push(source.slice(first, last + 1));
  attempts.push(source);
  for (const attempt of attempts.reverse()) {
    let value;
    try {
      value = JSON.parse(attempt.trim());
    } catch {
      continue;
    }
    if (!value || typeof value !== 'object' || typeof value.fixed !== 'boolean') continue;
    return {
      fixed: value.fixed,
      cause: typeof value.cause === 'string' ? value.cause.trim().slice(0, 1500) : '',
      touched: Array.isArray(value.touched)
        ? value.touched.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim().slice(0, 300)).slice(0, 40)
        : [],
      suggestedFix: typeof value.suggestedFix === 'string' ? value.suggestedFix.trim().slice(0, 2000) : '',
    };
  }
  return null;
}

export function buildAutofixPrompt({ request, app, paths, logTail }) {
  const pathLines = Object.entries(paths)
    .filter(([, value]) => typeof value === 'string' && value)
    .map(([label, value]) => `- ${label}: ${value}`)
    .join('\n');
  return `You are repairing ${PRODUCT_NAME}, a desktop HWP/HWPX document editor (Electron app with a local Node "agent hub" child process), on the user's own computer. The user hit an error the app could not recover from by reloading, and pressed "auto fix". Nobody is watching this run; work quickly and finish within a few minutes.

## App
- Version: ${app.version}
- Platform: ${app.platform} ${app.arch}${app.osVersion ? ` (OS ${app.osVersion})` : ''}
- Packaged build: ${app.packaged ? 'yes' : 'no (development run)'}
- Main process pid: ${app.mainPid} (never kill it)

## Error
- Surface: ${request.surface}
- Title: ${request.title}
- Reload attempts so far: ${request.attempts}
${request.detail ? `- Detail:\n${request.detail}\n` : ''}
## Paths
${pathLines}

## Rules
- Repair only this app's local state: files in its user data folder, caches, the managed CLI install, stale lock/pid files, this app's own stuck hub or child processes, and ports held by them.
- Never modify the app bundle or install directory, the hub source (read it only to diagnose), the user's documents, or any other application's data.
- Before deleting or replacing any file, copy it into ${paths['Backup folder']}.
- Do not quit or kill the ${PRODUCT_NAME} main or renderer process; the app reloads itself after you finish.
- Do not change the app's source code. If the root cause is a bug in the app, work around it locally if you safely can, and describe the real fix for the developer.
- This run is invisible to the user. Never open a terminal, console, GUI app, browser, or any new window (no \`open\`, \`osascript\`, \`start\`, \`Start-Process\`, \`xdg-open\`, \`cmd /c start\`).
- Never run anything detached or in the background (no \`&\`, \`nohup\`, \`setsid\`, \`disown\`, services, or scheduled tasks). Wait for every command to finish. Anything left running is killed when you end.

## Diagnostic log (most recent last)
\`\`\`
${logTail || '(empty)'}
\`\`\`

## Answer
Your final message must be ONLY this JSON object, with no other text:
{"fixed": boolean, "cause": string, "touched": string[], "suggestedFix": string}
- fixed: true only if you changed something that should make the error go away.
- cause: the root cause, one or two sentences in Korean.
- touched: every file, folder, or process you changed, moved, or killed (empty if none).
- suggestedFix: what the app developer should change in the code so this never happens again, in Korean.
`;
}

function keepTailBytes(text, maxBytes) {
  const bytes = Buffer.from(String(text ?? ''), 'utf8');
  if (bytes.length <= maxBytes) return String(text ?? '');
  return bytes.subarray(bytes.length - maxBytes).toString('utf8').replace(/^[^\n]*\n/, '');
}

/** 끝난 뒤 정리 결과. clean: 남은 것 없이 끝남, forced: 남은 것·시간 초과·중단을 끝냄, uncertain: 다 끝났는지 확인 못 함. */
export function classifyCleanup({ forced, stragglers, outcome, survivors }) {
  if (survivors.remaining === null && stragglers === null) {
    if (outcome !== true) return 'uncertain';
    return forced ? 'forced' : 'clean';
  }
  if (survivors.remaining !== null && survivors.remaining > 0) return 'uncertain';
  if (forced || (stragglers ?? 0) > 0 || survivors.found > 0) return 'forced';
  if (outcome === false) return 'uncertain';
  return 'clean';
}

/**
 * 에이전트를 한 번 돌린다. 창은 띄우지 않는다: shell 없이, Windows 는 detached 없이 windowsHide 로(숨은 콘솔을 손자까지
 * 물려받는다), POSIX 는 자기 프로세스 그룹으로. 도는 동안 자손을 기록해 두고, 끝나거나 시간이 넘거나 중단되면 트리를 끝낸 뒤
 * 기록된 것 가운데 살아남은 것까지 끝낸다.
 */
export async function executeAutofixAgent({
  provider,
  command,
  env,
  model,
  effort,
  prompt,
  cwd,
  platform = process.platform,
  nodeCommand = process.execPath,
  shimDir = null,
  spawnProcess,
  terminate = terminateProcessTree,
  listProcesses = createProcessLister({ platform }),
  killProcess = createProcessKiller({ platform }),
  readCwd = createCwdReader({ platform }),
  uid = typeof process.getuid === 'function' && platform !== 'win32' ? process.getuid() : null,
  // ps 한 번이 수십 ms 라 POSIX 는 자주 본다. Windows 의 CIM 조회는 무거워 덜 자주 본다.
  watchIntervalMs = platform === 'win32' ? 3_000 : 250,
  timeoutMs = AUTOFIX_TIMEOUT_MS,
  cleanupTimeoutMs = 10_000,
  signal = null,
  tmpRoot = os.tmpdir(),
  readFileImpl = readFile,
  onChild = () => {},
}) {
  const scratch = provider === 'codex' ? await mkdtemp(path.join(tmpRoot, 'hama-autofix-')) : null;
  const outputFile = scratch ? path.join(scratch, 'last-message.txt') : null;
  const argv = provider === 'codex'
    ? codexAutofixArgv({ model, effort, cwd, outputFile })
    : provider === 'gift' ? piAutofixArgv({ model, effort }) : claudeAutofixArgv({ model, effort });
  try {
    const launch = applyManagedCliLaunch(command, argv, {
      platform, nodeCommand, env: applyNodeHostEnv(hardenAgentEnv(env, provider, platform), { nodeCommand, shimDir, platform }),
    });
    // Windows 에서 node·exe 로 풀리지 않은 배치 심은 cmd.exe 를 거쳐야 하므로 돌리지 않는다.
    if (platform === 'win32' && /\.(?:cmd|bat)$/i.test(launch.command)) {
      return { code: null, timedOut: false, aborted: false, stdout: '', stderr: `refusing to run a batch shim: ${launch.command}`, finalText: '', cleanup: 'clean' };
    }
    let child;
    try {
      child = spawnProcess(launch.command, launch.argv, {
        ...processTreeSpawnOptions(platform),
        shell: false,
        windowsHide: true,
        cwd,
        env: launch.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      return { code: null, timedOut: false, aborted: false, stdout: '', stderr: String(error?.message ?? error), finalText: '', cleanup: 'clean' };
    }
    onChild(child);
    const rootPid = Number.isSafeInteger(child.pid) && child.pid > 0 ? child.pid : null;
    const startedAt = Date.now();
    const watcher = rootPid ? createTreeWatcher({ rootPid, list: listProcesses, intervalMs: watchIntervalMs }) : null;
    let stdout = '';
    let stderr = '';
    const capture = (current, chunk) => {
      const next = current + String(chunk);
      return next.length > OUTPUT_CAPTURE_BYTES * 2 ? next.slice(-OUTPUT_CAPTURE_BYTES) : next;
    };
    child.stdout?.on('data', (chunk) => { stdout = capture(stdout, chunk); });
    child.stderr?.on('data', (chunk) => { stderr = capture(stderr, chunk); });
    child.stdin?.on('error', () => {});
    // 프롬프트를 쓰고 바로 닫는다. 열린 stdin 을 기다리며 멈추는 CLI 가 없게 한다.
    child.stdin?.end(prompt);
    let timedOut = false;
    let aborted = false;
    const code = await new Promise((resolve) => {
      let settled = false;
      let fallback = null;
      const finish = (value, extra = '') => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(fallback);
        signal?.removeEventListener?.('abort', onAbort);
        if (extra) stderr += `\n${extra}`;
        resolve(value);
      };
      const stop = (reason) => {
        if (timedOut || aborted) return;
        if (reason === 'timeout') timedOut = true;
        else aborted = true;
        void Promise.resolve(terminate(child)).catch(() => {});
        // 끝내도 close 가 오지 않으면(파이프를 쥔 손자 등) 기다리지 않고 정리로 넘어간다.
        fallback = setTimeout(() => finish(null, reason), cleanupTimeoutMs);
      };
      const onAbort = () => stop('aborted');
      const timer = setTimeout(() => stop('timeout'), timeoutMs);
      signal?.addEventListener?.('abort', onAbort, { once: true });
      if (signal?.aborted) stop('aborted');
      child.on('error', (error) => finish(null, String(error?.message ?? error)));
      child.on('close', (value) => finish(value, timedOut ? 'timeout' : aborted ? 'aborted' : ''));
    });
    const cleanup = await cleanupAgentTree({
      child, rootPid, watcher, list: listProcesses, kill: killProcess, terminate, forced: timedOut || aborted, timeoutMs: cleanupTimeoutMs,
      orphans: { since: startedAt, uid, dir: cwd, readCwd },
    });
    let finalText = '';
    if (provider === 'codex') {
      finalText = await readFileImpl(outputFile, 'utf8').catch(() => '') || stdout;
    } else if (provider === 'gift') {
      finalText = stdout;
    } else {
      finalText = claudeResultText(stdout) ?? '';
    }
    return { code, timedOut, aborted, stdout, stderr, finalText, cleanup };
  } finally {
    if (scratch) await rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}

/** 에이전트 트리를 끝내고 기록된 프로세스 가운데 살아남은 것을 끝낸다. */
async function cleanupAgentTree({ child, rootPid, watcher, list, kill, terminate, forced, timeoutMs, orphans }) {
  let listing = null;
  if (watcher) {
    await watcher.stop();
    // 마지막으로 한 번 더 본다: 부모가 끝나 고아가 된 것도 그룹·기록된 부모로 찾는다.
    listing = await watcher.snapshot();
  }
  const stragglers = listing ? aliveTracked(watcher.tracked, listing, { exclude: [rootPid] }).length : null;
  let timer;
  const outcome = await Promise.race([
    Promise.resolve().then(() => terminate(child)).catch(() => false),
    new Promise((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); }),
  ]);
  clearTimeout(timer);
  if (watcher && orphans) {
    const after = await list().catch(() => null);
    if (after) {
      for (const row of await findRunOrphans({ listing: after, tracked: watcher.tracked, ...orphans })) watcher.tracked.set(row.pid, row.start);
    }
  }
  const survivors = watcher
    ? await killSurvivors({ tracked: watcher.tracked, list, kill })
    : { found: 0, remaining: null };
  return classifyCleanup({ forced, stragglers, outcome, survivors });
}

// ── 보고 ──────────────────────────────────────────────────────────────────

export function autofixReportMessage({ status, request, answer }) {
  const clip = (text, max) => (text.length > max ? `${text.slice(0, max)}…` : text);
  const touched = answer?.touched?.length ? answer.touched.map((item) => `- ${clip(item, 200)}`).join('\n') : '- 없음';
  const text = [
    `[자동 수정] ${status === 'fixed' ? '고침' : '실패'} · ${request.surface}: ${clip(request.title, 300)}`,
    '',
    `원인: ${clip(answer?.cause || '알 수 없음', 1200)}`,
    `건드린 것:\n${clip(touched, 1500)}`,
    '',
    `개발자 제안: ${clip(answer?.suggestedFix || '없음', 1800)}`,
  ].join('\n');
  return text.slice(0, FEEDBACK_LIMITS.messageChars);
}

/** 화면·문서·채팅 없이, 진단 기록과 에이전트 출력 끝만 싣는다. */
export function buildAutofixReportPayload({ installId, createdAt, status, request, answer, meta, log }, options) {
  return buildFeedbackPayload({
    installId,
    createdAt,
    message: autofixReportMessage({ status, request, answer }),
    meta,
    log,
  }, options);
}

// ── 서비스 ────────────────────────────────────────────────────────────────

/**
 * 앱 전체에서 한 번에 하나만 돈다. 도는 중에 온 요청은 그 결과를 함께 받는다.
 * 렌더러에는 던지지 않는다: 내부 오류는 'failed' 로 끝내고 진단 기록에 남긴다.
 */
export function createAutofixService({
  settings,
  probe,
  probeGift = null,
  resolveModel,
  execute,
  buildPrompt,
  sendReport,
  diagnosticLog,
  now = Date.now,
}) {
  let inflight = null;
  let controller = null;
  const log = (level, text) => diagnosticLog?.writeText?.('autofix', level, text);

  async function runOnce(rawRequest, signal) {
    const request = sanitizeAutofixRequest(rawRequest);
    const current = await settings.get();
    if (!current.enabled) {
      log('info', 'autofix skipped: disabled');
      return { status: 'unavailable' };
    }
    let chosen = null;
    for (const entry of current.providers) {
      if (!entry.enabled) continue;
      const found = await probe(entry.id).catch((error) => ({ available: false, reason: String(error?.message ?? error) }));
      if (!found.available) {
        log('info', `autofix ${entry.id} unavailable: ${found.reason}`);
        continue;
      }
      let model;
      try {
        model = await resolveModel(entry, found);
      } catch (error) {
        log('info', `autofix ${entry.id} model unavailable: ${error?.message ?? error}`);
        continue;
      }
      chosen = { entry, found, model };
      break;
    }
    if (!chosen && probeGift) {
      const found = await probeGift().catch((error) => ({ available: false, reason: String(error?.message ?? error) }));
      if (found.available) chosen = { entry: { id: 'gift', effort: GIFT_AUTOFIX_EFFORT }, found, model: GIFT_AUTOFIX_MODEL };
      else log('info', `autofix gift unavailable: ${found.reason}`);
    }
    if (!chosen) return { status: 'unavailable' };
    const provider = chosen.entry.id;
    const started = now();
    log('info', `autofix started: ${provider} ${chosen.model} (${chosen.entry.effort}, ${chosen.found.source}) for ${request.surface}: ${request.title}`);
    let run = null;
    let answer = null;
    try {
      const prompt = await buildPrompt(request);
      if (signal.aborted) throw new Error('aborted before start');
      run = await execute({ provider, command: chosen.found.command, env: chosen.found.env, model: chosen.model, effort: chosen.entry.effort, prompt, found: chosen.found, signal });
      answer = parseAutofixAnswer(run.finalText);
    } catch (error) {
      log('error', `autofix run failed: ${error?.stack ?? error}`);
    }
    const status = run && run.code === 0 && !run.timedOut && answer?.fixed === true ? 'fixed' : 'failed';
    const durationMs = now() - started;
    log(status === 'fixed' ? 'info' : 'warn', `autofix ${status}: ${provider} exit ${run?.code ?? '?'}${run?.timedOut ? ' (timeout)' : ''}${run?.aborted ? ' (aborted)' : ''}${answer ? '' : ', no answer'}, cleanup ${run?.cleanup ?? '?'} in ${durationMs} ms`);
    const cli = { path: chosen.found.command, version: chosen.found.version ?? null, source: chosen.found.source };
    void Promise.resolve()
      .then(() => sendReport({ status, provider, model: chosen.model, request, answer, run, durationMs, cli }))
      .then((result) => log(result?.ok ? 'info' : 'warn', `autofix report ${result?.ok ? `sent ${result.id}` : `failed: ${result?.code ?? 'unknown'}${result?.status ? ` (${result.status})` : ''}`}`))
      .catch((error) => log('warn', `autofix report failed: ${error?.message ?? error}`));
    return { status, provider };
  }

  return {
    /** 도는 중이면 그 실행(정리까지 끝나야 끝난다)을 함께 기다린다. */
    run(request) {
      if (inflight) return inflight;
      controller = new AbortController();
      inflight = runOnce(request, controller.signal)
        .catch((error) => {
          log('error', `autofix failed: ${error?.stack ?? error}`);
          return { status: 'failed' };
        })
        .finally(() => { inflight = null; controller = null; });
      return inflight;
    },
    running: () => Boolean(inflight),
    /** 도는 실행을 멈춘다. 프로세스 정리는 실행 안에서 끝까지 한다. */
    abort(reason = 'aborted') {
      if (!controller || controller.signal.aborted) return;
      log('warn', `autofix aborting: ${reason}`);
      controller.abort(reason);
    },
    /** 앱을 끝낼 때: 멈추고 정리가 끝날 때까지(최대 limitMs) 기다린다. */
    async dispose({ limitMs = 20_000 } = {}) {
      const current = inflight;
      if (!current) return;
      this.abort('app quit');
      let timer;
      await Promise.race([current, new Promise((resolve) => { timer = setTimeout(resolve, limitMs); })]);
      clearTimeout(timer);
    },
  };
}

/**
 * 렌더러용 자동 수정 IPC.
 * - desktop:autofix-run → { status: 'fixed'|'failed'|'unavailable', provider? }
 * - desktop:autofix-get-settings / desktop:autofix-set-settings, 바뀌면 모든 창에 autofix:changed
 */
export function installAutofixHost({
  ipcMain,
  sessionForEvent,
  diagnosticLog,
  userDataDir,
  appInfo,
  origin,
  fetchImpl,
  secretStore = () => null,
  giftCredentials = null,
  broadcast = () => {},
  paths = {},
  mainPid = process.pid,
  platform = process.platform,
  arch = process.arch,
  baseEnv = process.env,
  home = os.homedir(),
  nodeCommand = process.execPath,
  unpacked = (file) => file,
  bundledClaudeBin: bundledClaudeOverride,
  spawnProcess,
  proofKey = DEFAULT_FEEDBACK_PROOF_KEY,
}) {
  const settings = createAutofixSettingsStore({
    filePath: path.join(userDataDir, AUTOFIX_SETTINGS_FILE),
    platform,
    onChange: (value) => broadcast('autofix:changed', value),
  });
  const env = sanitizeHubEnv(baseEnv);
  const bundled = bundledClaudeOverride === undefined ? bundledClaudeBinary({ platform, arch }) : bundledClaudeOverride;
  // 패키지 앱에서 SDK 바이너리는 app.asar.unpacked 에서만 실행할 수 있다.
  const bundledClaudeBin = bundled ? unpacked(bundled) : null;
  // 허브와 같은 저장소의 로그인·API 키를 읽기만 한다. 허브가 쓰는 동안 겹쳐 쓰지 않게 쓰기는 막는다.
  const readOnlySecrets = {
    get available() { return Boolean(secretStore()); },
    get: (key) => secretStore().get(key),
    set: async () => { throw new Error('autofix does not write secrets'); },
    delete: async () => {},
  };
  // 로그인은 실행마다 새로 읽는다(그사이 앱에서 로그인했을 수 있다).
  const cliRoot = defaultCliSetupRoot(env, platform, home);
  const ensureNodeHost = createNodeHost({ rootDir: cliRoot, nodeCommand, platform });
  // cross-spawn 은 풀지 못한 .cmd 를 cmd.exe 로 돌린다. 여기서는 Node 의 spawn 만 쓴다(shell 없음).
  const spawnChild = spawnProcess ?? nodeSpawn;
  const verifyCli = createCliIdentityVerifier({ platform, nodeCommand, spawnProcess: spawnChild });
  // npm 으로 깐 CLI 는 `#!/usr/bin/env node` 스크립트다. node 가 없는 GUI 환경에서도 허브처럼 node-host 로 돈다.
  const verifyIdentity = async (agent, command, agentEnv) => verifyCli(agent, command, applyNodeHostEnv(agentEnv, {
    nodeCommand, shimDir: await ensureNodeHost().catch(() => null), platform,
  }));
  let giftLease = null;
  const piRoot = defaultPiRoot(env, platform, home);
  const piBin = path.join(piRoot, 'prefix', 'node_modules', '.bin', platform === 'win32' ? 'pi.cmd' : 'pi');
  const giftPiHome = path.join(userDataDir, 'autofix-pi');
  // 목록을 늦게 주거나 못 주면 그 라인업의 기본 모델(gpt-6-sol 등)로 돈다.
  const codexModels = createCodexModelResolver({ discover: discoverCodexModels });

  const service = createAutofixService({
    settings,
    diagnosticLog,
    probe: (agent) => probeAutofixProvider(agent, {
      cliSetup: createCliSetupManager({ rootDir: cliRoot, npmCommand: 'npm', secretStore: readOnlySecrets, nodeCommand, platform, baseEnv: env, homeDir: home, bundledClaudeBin }),
      baseEnv: env,
      home,
      platform,
      bundledClaudeBin,
      verifyIdentity,
    }),
    probeGift: giftCredentials
      ? () => probeGiftProvider({ credentials: giftCredentials, piBin, agentDir: giftPiHome, baseEnv: env, home, platform, verifyIdentity })
      : null,
    async resolveModel(entry, found) {
      if (entry.id !== 'codex') return entry.model;
      const shimDir = await ensureNodeHost().catch(() => null);
      return codexModels(entry.model, {
        bin: found.command, env: applyNodeHostEnv(found.env, { nodeCommand, shimDir, platform }),
        platform, nodeCommand, cwd: userDataDir, timeoutMs: CODEX_DISCOVERY_TIMEOUT_MS,
      });
    },
    buildPrompt: async (request) => {
      const info = appInfo();
      return buildAutofixPrompt({
        request,
        app: { version: info.appVersion, platform, arch, osVersion: info.osVersion, packaged: info.packaged, mainPid },
        paths: {
          'User data folder (working directory)': userDataDir,
          'Logs folder': path.join(userDataDir, 'logs'),
          'Backup folder': path.join(userDataDir, 'autofix-backups', new Date().toISOString().replace(/[:.]/g, '-')),
          'Managed CLI root': cliRoot,
          'Managed Pi root': piRoot,
          'Codex config folder': codexHomeDir({ env, home, platform }),
          'Claude config folder': typeof env.CLAUDE_CONFIG_DIR === 'string' && env.CLAUDE_CONFIG_DIR ? env.CLAUDE_CONFIG_DIR : path.join(home, '.claude'),
          ...paths,
        },
        logTail: diagnosticLog?.tail(LOG_TAIL_BYTES) ?? '',
      });
    },
    async execute({ found, ...options }) {
      const shimDir = await ensureNodeHost().catch(() => null);
      if (options.provider === 'gift') {
        await writeGiftPiHome(giftPiHome, { baseUrl: found.baseUrl, model: options.model });
        giftLease = found.env.OPENROUTER_API_KEY;
      }
      return executeAutofixAgent({
        ...options,
        cwd: userDataDir,
        platform,
        nodeCommand,
        shimDir,
        spawnProcess: spawnChild,
      });
    },
    async sendReport({ status, provider, model, request, answer, run, durationMs, cli }) {
      const { installId } = await loadOrCreateUniqueInstallState(uniqueInstallStatePath(userDataDir));
      const output = keepTailBytes(`${run?.finalText ? `${run.finalText}\n` : ''}${run?.stderr ?? ''}`, AGENT_OUTPUT_TAIL_BYTES);
      const payload = buildAutofixReportPayload({
        installId,
        createdAt: new Date().toISOString(),
        status,
        request,
        answer,
        meta: {
          ...appInfo(),
          autofix: {
            status, provider, model, surface: request.surface, attempts: request.attempts, durationMs,
            cliPath: redactSecrets(cli?.path ?? '', { home }), cliVersion: cli?.version ?? '', cliSource: cli?.source ?? '',
            cleanup: run?.cleanup ?? 'uncertain',
          },
        },
        log: `${diagnosticLog?.tail(LOG_TAIL_BYTES) ?? ''}\n\n--- 자동 수정 에이전트 출력 ---\n${redactSecrets(output, { home, secrets: giftLease ? [giftLease] : [] })}`,
      }, { proofKey });
      return submitFeedback(payload, { origin, fetchImpl });
    },
  });

  // 실행을 기다리는 창. 모두 닫히면 실행을 멈추고 프로세스를 정리한다.
  const waiting = new Set();
  const watched = new WeakSet();
  ipcMain.handle('desktop:autofix-run', async (event, request) => {
    sessionForEvent(event);
    const sender = event.sender;
    if (!service.running()) waiting.clear();
    if (sender && typeof sender === 'object') waiting.add(sender);
    if (sender && typeof sender === 'object' && !watched.has(sender)) {
      watched.add(sender);
      sender.once?.('destroyed', () => {
        if (!waiting.delete(sender)) return;
        if (waiting.size === 0) service.abort('window closed');
      });
    }
    return service.run(request);
  });
  ipcMain.handle('desktop:autofix-get-settings', (event) => {
    sessionForEvent(event);
    return settings.get();
  });
  ipcMain.handle('desktop:autofix-set-settings', (event, patch) => {
    sessionForEvent(event);
    return settings.set(patch);
  });

  return {
    run: (request) => service.run(request),
    settings,
    /** 앱을 끝낼 때 도는 에이전트를 멈추고, 트리 정리가 끝날 때까지 기다린다. */
    dispose: (options) => service.dispose(options),
  };
}
