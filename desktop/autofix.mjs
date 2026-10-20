import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { PRODUCT_NAME } from './app-identity.mjs';
import { buildHubPath, findOnPath, sanitizeHubEnv } from './agent-hub.mjs';
import { redactSecrets } from './diagnostic-log.mjs';
import { replaceFile } from './fs-replace.mjs';
import { buildFeedbackPayload, DEFAULT_FEEDBACK_PROOF_KEY, FEEDBACK_LIMITS, submitFeedback } from './issue-report.mjs';
import { loadOrCreateUniqueInstallState, uniqueInstallStatePath } from './unique-install.mjs';
import { bundledClaudeBinary, createCliSetupManager, defaultCliSetupRoot } from '../rhwp/rhwp-agent/cli-setup-manager.mjs';
import { OFFICIAL_CLAUDE_MODELS } from '../rhwp/rhwp-agent/claude-model-label.mjs';
import { codexLineup, createCodexModelResolver, discoverCodexModels } from '../rhwp/rhwp-agent/codex-model-routing.mjs';
import { applyManagedCliLaunch, applyNodeHostEnv, createNodeHost } from '../rhwp/rhwp-agent/npm-cli-launch.mjs';
import { processTreeSpawnOptions, terminateProcessTree } from '../rhwp/rhwp-agent/process-tree.mjs';

const agentRequire = createRequire(new URL('../rhwp/rhwp-agent/package.json', import.meta.url));

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
const DEFAULT_PROVIDERS = Object.freeze([
  Object.freeze({ id: 'codex', enabled: true, model: 'sol', effort: 'low' }),
  Object.freeze({ id: 'claude', enabled: true, model: 'claude-opus-5-5', effort: 'medium' }),
]);

/** @returns {{ enabled: boolean, decided: boolean, providers: Array<{ id: 'codex'|'claude', enabled: boolean, model: string, effort: string }> }} */
export function defaultAutofixSettings() {
  return { enabled: false, decided: false, providers: DEFAULT_PROVIDERS.map((entry) => ({ ...entry })) };
}

function normalizeProviderEntry(raw, base) {
  const entry = raw && typeof raw === 'object' ? raw : {};
  const fallback = DEFAULT_PROVIDERS.find((item) => item.id === base.id);
  let model = typeof entry.model === 'string' ? entry.model.trim() : base.model;
  if (base.id === 'codex') model = codexLineup(model) ?? (CODEX_LINEUPS.has(base.model) ? base.model : fallback.model);
  else if (!OFFICIAL_CLAUDE_MODELS.includes(model)) model = OFFICIAL_CLAUDE_MODELS.includes(base.model) ? base.model : fallback.model;
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
 * 실행 파일: 앱이 설치한 CLI → PATH(GUI 앱에 없는 Homebrew·nvm 등 위치를 더한 것) → Claude 는 SDK 번들 런타임.
 * Windows 의 .cmd 심은 실행할 때 applyManagedCliLaunch 가 푼다.
 */
export function resolveCliCommand(agent, { managedBin, pathEnv, platform = process.platform, exists = existsSync, bundledClaudeBin = null }) {
  if (managedBin && exists(managedBin)) return { command: managedBin, source: 'managed' };
  const names = platform === 'win32' ? [`${agent}.cmd`, `${agent}.exe`] : [agent];
  for (const name of names) {
    const found = findOnPath(name, pathEnv, exists, platform);
    if (found) return { command: found, source: 'path' };
  }
  if (agent === 'claude' && bundledClaudeBin && exists(bundledClaudeBin)) return { command: bundledClaudeBin, source: 'bundled' };
  return null;
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
}) {
  const pathEnv = buildHubPath({ home, envPath: baseEnv.PATH ?? baseEnv.Path ?? '', exists, platform });
  const found = resolveCliCommand(agent, { managedBin: cliSetup.binPath(agent), pathEnv, platform, exists, bundledClaudeBin });
  if (!found) return { available: false, reason: 'missing' };
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
  const env = { ...cliSetup.envFor(agent), PATH: pathEnv };
  if (platform === 'win32') env.Path = pathEnv;
  return { available: true, command: found.command, source: found.source, env };
}

// ── 실행 ──────────────────────────────────────────────────────────────────

export function codexAutofixArgv({ model, effort, cwd, outputFile }) {
  return [
    'exec',
    '--skip-git-repo-check', '--ephemeral', '--ignore-user-config', '--ignore-rules',
    '--color', 'never',
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

/**
 * 에이전트를 한 번 돌린다. 창은 띄우지 않고(windowsHide, 분리된 프로세스 그룹), 시간이 넘거나 dispose 되면
 * 프로세스 트리를 끝낸다. 끝난 뒤에도 남은 자식은 트리째 정리한다.
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
  timeoutMs = AUTOFIX_TIMEOUT_MS,
  tmpRoot = os.tmpdir(),
  readFileImpl = readFile,
  onChild = () => {},
}) {
  const scratch = provider === 'codex' ? await mkdtemp(path.join(tmpRoot, 'hama-autofix-')) : null;
  const outputFile = scratch ? path.join(scratch, 'last-message.txt') : null;
  const argv = provider === 'codex'
    ? codexAutofixArgv({ model, effort, cwd, outputFile })
    : claudeAutofixArgv({ model, effort });
  try {
    const launch = applyManagedCliLaunch(command, argv, { platform, nodeCommand, env: applyNodeHostEnv(env, { nodeCommand, shimDir, platform }) });
    let child;
    try {
      child = spawnProcess(launch.command, launch.argv, {
        ...processTreeSpawnOptions(platform),
        windowsHide: true,
        cwd,
        env: launch.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      return { code: null, timedOut: false, stdout: '', stderr: String(error?.message ?? error), finalText: '' };
    }
    onChild(child);
    let stdout = '';
    let stderr = '';
    const capture = (current, chunk) => {
      const next = current + String(chunk);
      return next.length > OUTPUT_CAPTURE_BYTES * 2 ? next.slice(-OUTPUT_CAPTURE_BYTES) : next;
    };
    child.stdout?.on('data', (chunk) => { stdout = capture(stdout, chunk); });
    child.stderr?.on('data', (chunk) => { stderr = capture(stderr, chunk); });
    child.stdin?.on('error', () => {});
    child.stdin?.end(prompt);
    let timedOut = false;
    const result = await new Promise((resolve) => {
      let settled = false;
      const finish = (code, extra = '') => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (extra) stderr += `\n${extra}`;
        resolve(code);
      };
      const timer = setTimeout(() => {
        timedOut = true;
        Promise.resolve(terminate(child)).catch(() => {}).finally(() => finish(null, 'timeout'));
      }, timeoutMs);
      child.on('error', (error) => finish(null, String(error?.message ?? error)));
      child.on('close', (code) => finish(code));
    });
    // 에이전트가 띄우고 남긴 자식이 앱보다 오래 살지 않게 한다.
    await Promise.resolve(terminate(child)).catch(() => {});
    let finalText = '';
    if (provider === 'codex') {
      finalText = await readFileImpl(outputFile, 'utf8').catch(() => '') || stdout;
    } else {
      finalText = claudeResultText(stdout) ?? '';
    }
    return { code: result, timedOut, stdout, stderr, finalText };
  } finally {
    if (scratch) await rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
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
  resolveModel,
  execute,
  buildPrompt,
  sendReport,
  diagnosticLog,
  now = Date.now,
}) {
  let inflight = null;
  const log = (level, text) => diagnosticLog?.writeText?.('autofix', level, text);

  async function runOnce(rawRequest) {
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
    if (!chosen) return { status: 'unavailable' };
    const provider = chosen.entry.id;
    const started = now();
    log('info', `autofix started: ${provider} ${chosen.model} (${chosen.entry.effort}, ${chosen.found.source}) for ${request.surface}: ${request.title}`);
    let run = null;
    let answer = null;
    try {
      const prompt = await buildPrompt(request);
      run = await execute({ provider, command: chosen.found.command, env: chosen.found.env, model: chosen.model, effort: chosen.entry.effort, prompt });
      answer = parseAutofixAnswer(run.finalText);
    } catch (error) {
      log('error', `autofix run failed: ${error?.stack ?? error}`);
    }
    const status = run && run.code === 0 && !run.timedOut && answer?.fixed === true ? 'fixed' : 'failed';
    const durationMs = now() - started;
    log(status === 'fixed' ? 'info' : 'warn', `autofix ${status}: ${provider} exit ${run?.code ?? '?'}${run?.timedOut ? ' (timeout)' : ''}${answer ? '' : ', no answer'} in ${durationMs} ms`);
    void Promise.resolve()
      .then(() => sendReport({ status, provider, model: chosen.model, request, answer, run, durationMs }))
      .then((result) => log(result?.ok ? 'info' : 'warn', `autofix report ${result?.ok ? `sent ${result.id}` : `failed: ${result?.code ?? 'unknown'}${result?.status ? ` (${result.status})` : ''}`}`))
      .catch((error) => log('warn', `autofix report failed: ${error?.message ?? error}`));
    return { status, provider };
  }

  return {
    run(request) {
      if (inflight) return inflight;
      inflight = runOnce(request)
        .catch((error) => {
          log('error', `autofix failed: ${error?.stack ?? error}`);
          return { status: 'failed' };
        })
        .finally(() => { inflight = null; });
      return inflight;
    },
    running: () => Boolean(inflight),
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
  const spawnChild = spawnProcess ?? ((command, args, options) => agentRequire('cross-spawn')(command, args, options));
  let activeChild = null;
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
    }),
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
          'Codex config folder': codexHomeDir({ env, home, platform }),
          'Claude config folder': typeof env.CLAUDE_CONFIG_DIR === 'string' && env.CLAUDE_CONFIG_DIR ? env.CLAUDE_CONFIG_DIR : path.join(home, '.claude'),
          ...paths,
        },
        logTail: diagnosticLog?.tail(LOG_TAIL_BYTES) ?? '',
      });
    },
    async execute(options) {
      const shimDir = await ensureNodeHost().catch(() => null);
      try {
        return await executeAutofixAgent({
          ...options,
          cwd: userDataDir,
          platform,
          nodeCommand,
          shimDir,
          spawnProcess: spawnChild,
          onChild: (child) => { activeChild = child; },
        });
      } finally {
        activeChild = null;
      }
    },
    async sendReport({ status, provider, model, request, answer, run, durationMs }) {
      const { installId } = await loadOrCreateUniqueInstallState(uniqueInstallStatePath(userDataDir));
      const output = keepTailBytes(`${run?.finalText ? `${run.finalText}\n` : ''}${run?.stderr ?? ''}`, AGENT_OUTPUT_TAIL_BYTES);
      const payload = buildAutofixReportPayload({
        installId,
        createdAt: new Date().toISOString(),
        status,
        request,
        answer,
        meta: { ...appInfo(), autofix: { status, provider, model, surface: request.surface, attempts: request.attempts, durationMs } },
        log: `${diagnosticLog?.tail(LOG_TAIL_BYTES) ?? ''}\n\n--- 자동 수정 에이전트 출력 ---\n${redactSecrets(output, { home })}`,
      }, { proofKey });
      return submitFeedback(payload, { origin, fetchImpl });
    },
  });

  ipcMain.handle('desktop:autofix-run', async (event, request) => {
    sessionForEvent(event);
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
    /** 앱을 끝낼 때 도는 에이전트를 트리째 끝낸다. */
    dispose() {
      const child = activeChild;
      activeChild = null;
      if (child) return Promise.resolve(terminateProcessTree(child)).catch(() => {});
      return Promise.resolve();
    },
  };
}
