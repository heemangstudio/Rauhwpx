import spawn from 'cross-spawn';
import os from 'node:os';
import path from 'node:path';

import {
  IDLE_PROCESS_RELEASE_MS,
  isPlanningRestricted,
  chatPermissionGrantsFor,
  hasLocalExecutionGrant,
  mcpCapabilityEnv,
  mcpRuntimeFor,
  applyPreparedProviderLaunch,
  nativeProviderInteractionMode,
  redactDiagnosticText,
  systemBriefFor,
  truncate,
  validateExecutionMode,
  findSessionFile,
  isSafeSessionId,
} from './backend.mjs';
import {
  CODEX_REQUEST_USER_INPUT_METHOD,
  codexDefaultModeUserInputEnabled,
  handleCodexRequestUserInputFrame,
} from './provider-user-input.mjs';
import {
  isolatedProcessEnv,
  processTreeSpawnOptions,
  terminateAndWaitForProcessTreeExit,
  terminateProcessTree,
} from '../process-tree.mjs';
import { applyManagedCliLaunch } from '../npm-cli-launch.mjs';
import { codexHistoryItems } from '../chat-handoff.mjs';

const DEFAULT_CODEX_MODEL = 'gpt-5.6-sol';
const DEFAULT_MODE_FEATURE = 'default_mode_request_user_input';
const NEGOTIATION_TIMEOUT_MS = 10_000;
const STDERR_TAIL_LIMIT = 16_000;
export const CODEX_RPC_LINE_LIMIT_BYTES = 8 * 1024 * 1024;

export class CodexAppServerUnavailableError extends Error {
  constructor(message, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = 'CodexAppServerUnavailableError';
    this.code = 'CODEX_APP_SERVER_UNAVAILABLE';
  }
}

function capabilityConfig(opts) {
  const runtime = mcpRuntimeFor(opts);
  const capabilityEnv = {
    ...runtime.env,
    RHWP_WS_URL: `ws://127.0.0.1:${opts.hubPort}/mcp`,
    RHWP_AGENT_TOKEN: opts.token,
    RHWP_AGENT_NAME: 'codex',
    ...mcpCapabilityEnv(opts),
  };
  const mcpEnv = Object.entries(capabilityEnv)
    .map(([key, value]) => `${key} = ${JSON.stringify(String(value))}`)
    .join(', ');
  return [
    '-c', `mcp_servers.rhwp.command=${JSON.stringify(runtime.command)}`,
    '-c', `mcp_servers.rhwp.args=${JSON.stringify(runtime.args)}`,
    '-c', `mcp_servers.rhwp.env={${mcpEnv}}`,
    '-c', 'mcp_servers.rhwp.startup_timeout_sec=20',
    '-c', 'mcp_servers.rhwp.default_tools_approval_mode="auto"',
    // 자료 저장은 허브가 모드·설정·세션 경계를 검사하므로 승인 UI 없이 실행한다.
    '-c', 'mcp_servers.rhwp.tools.project_import.approval_mode="approve"',
    '-c', 'mcp_servers.rhwp.tools.download_file.approval_mode="approve"',
    '-c', 'approval_policy="never"',
    '-c', `sandbox_mode="${sandboxMode(opts)}"`,
    // app-server has no `--ignore-rules` flag. A zero project-doc budget is
    // its config-level equivalent; Rau supplies the complete brief itself.
    '-c', 'project_doc_max_bytes=0',
    ...(opts.workflow === 'plan' || opts.workflow === 'question' ? ['-c', 'web_search="live"'] : []),
    ...(opts.effort ? ['-c', `model_reasoning_effort=${JSON.stringify(opts.effort)}`] : []),
  ];
}

/** Build the persistent app-server invocation for the current idle mode. */
export function buildCodexAppServerArgv(opts, { enableDefaultModeUserInput = false } = {}) {
  return [
    'app-server', '--stdio',
    '--disable', 'apps',
    '--disable', 'browser_use',
    '--disable', 'computer_use',
    ...(opts.toolProfile === 'copy-layout-worker'
      ? ['--disable', 'image_generation']
      : ['--enable', 'image_generation']),
    ...(opts.toolProfile === 'copy-layout-worker'
      ? [
        '--disable', 'multi_agent', '--disable', 'shell_tool', '--disable', 'unified_exec',
        // GPT-6의 MCP 호출에 필요한 호스트이며 파일·셸 권한은 부여하지 않는다.
        '--enable', 'code_mode_host', '--disable', 'standalone_web_search',
        '--disable', 'view_image', '--disable', 'shell_snapshot',
      ]
      : ['--enable', 'multi_agent']),
    '--disable', 'plugins',
    '--disable', 'skill_search',
    ...(enableDefaultModeUserInput
      ? ['--enable', DEFAULT_MODE_FEATURE, '-c', 'suppress_unstable_features_warning=true']
      : []),
    ...capabilityConfig(opts),
  ];
}

function rpcKey(id) {
  return `${typeof id}:${String(id)}`;
}

function rpcError(error) {
  return Object.assign(
    new Error(String(error?.message ?? 'Codex app-server request failed')),
    { code: error?.code, data: error?.data },
  );
}

export class CodexJsonRpcConnection {
  constructor(proc, { onFrame, onClosed, terminateProcess = terminateProcessTree }) {
    this.proc = proc;
    this.onFrame = onFrame;
    this.onClosed = onClosed;
    this.nextId = 1;
    this.pending = new Map();
    this.closed = false;
    this.lineChunks = [];
    this.lineBytes = 0;
    this.terminateProcess = terminateProcess;
    this.cleanupPromise = null;

    proc.stdout.on('data', (chunk) => this.consume(chunk));
    proc.on('error', (error) => this.close(error, { terminate: Boolean(proc.pid) }));
    proc.on('exit', (code, signal) => {
      const suffix = signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`;
      this.close(new Error(`Codex app-server exited with ${suffix}`), { terminate: true });
    });
    proc.on('close', (code, signal) => {
      if (this.closed) return;
      const suffix = signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`;
      this.close(new Error(`Codex app-server closed with ${suffix}`), { terminate: true });
    });
  }

  consume(chunk) {
    if (this.closed) return;
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let start = 0;
    while (start < bytes.length) {
      const newline = bytes.indexOf(0x0a, start);
      const end = newline === -1 ? bytes.length : newline;
      const segment = bytes.subarray(start, end);
      if (this.lineBytes + segment.byteLength > CODEX_RPC_LINE_LIMIT_BYTES) {
        const error = new CodexAppServerUnavailableError('Codex app-server emitted a JSON-RPC line larger than 8 MiB');
        this.lineChunks = [];
        this.lineBytes = 0;
        this.close(error, { terminate: true, graceMs: 1_000 });
        return;
      }
      if (segment.byteLength > 0) {
        this.lineChunks.push(Buffer.from(segment));
        this.lineBytes += segment.byteLength;
      }
      if (newline === -1) return;
      const line = Buffer.concat(this.lineChunks, this.lineBytes).toString('utf8').trim();
      this.lineChunks = [];
      this.lineBytes = 0;
      start = newline + 1;
      if (!line) continue;
      let frame;
      try {
        frame = JSON.parse(line);
      } catch {
        process.stderr.write('[codex-app-server] skipped a malformed provider frame\n');
        continue;
      }
      if (frame && frame.id !== undefined && frame.method === undefined) {
        const pending = this.pending.get(rpcKey(frame.id));
        if (!pending) continue;
        this.pending.delete(rpcKey(frame.id));
        if (pending.timer) clearTimeout(pending.timer);
        if (frame.error) pending.reject(rpcError(frame.error));
        else pending.resolve(frame.result);
        continue;
      }
      Promise.resolve(this.onFrame(frame)).catch((error) => {
        process.stderr.write(`[codex-app-server] frame handler failed: ${redactDiagnosticText(error?.message ?? error)}\n`);
      });
    }
  }

  send(frame) {
    if (this.closed) throw new Error('Codex app-server connection is closed');
    // Codex's generated protocol envelopes omit the optional JSON-RPC marker.
    const { jsonrpc: _jsonrpc, ...wireFrame } = frame;
    this.proc.stdin.write(`${JSON.stringify(wireFrame)}\n`);
  }

  request(method, params, { timeoutMs = null, label = method } = {}) {
    const id = this.nextId++;
    const key = rpcKey(id);
    const promise = new Promise((resolve, reject) => {
      let timer = null;
      if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
        timer = setTimeout(() => {
          const pending = this.pending.get(key);
          if (!pending) return;
          this.pending.delete(key);
          pending.reject(new CodexAppServerUnavailableError(`${label} timed out`));
        }, timeoutMs);
      }
      this.pending.set(key, { resolve, reject, method, timer });
    });
    try {
      this.send({ id, method, params });
    } catch (error) {
      const pending = this.pending.get(key);
      if (pending?.timer) clearTimeout(pending.timer);
      this.pending.delete(key);
      return Promise.reject(error);
    }
    return promise;
  }

  notify(method, params) {
    this.send(params === undefined ? { method } : { method, params });
  }

  close(error = new Error('Codex app-server connection closed'), {
    terminate = false,
    graceMs = 3_000,
  } = {}) {
    if (this.closed) return this.cleanupPromise;
    this.closed = true;
    for (const pending of this.pending.values()) if (pending.timer) clearTimeout(pending.timer);
    const finish = (cleaned) => {
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
      this.onClosed(error, cleaned);
      return cleaned;
    };
    if (!terminate) {
      this.cleanupPromise = Promise.resolve(finish(null)).then(() => true);
      return this.cleanupPromise;
    }
    this.cleanupPromise = terminateAndWaitForProcessTreeExit(this.proc, {
      terminateProcess: this.terminateProcess,
      terminateOptions: { graceMs },
      timeoutMs: graceMs + 1_000,
    }).catch(() => false).then(finish);
    return this.cleanupPromise;
  }
}

function sandboxMode(opts) {
  if (opts.toolProfile === 'copy-layout-worker') return 'read-only';
  if (hasLocalExecutionGrant(opts)) return 'danger-full-access';
  if (isPlanningRestricted(opts)) return 'read-only';
  return opts.permissionProfile === 'unrestricted' ? 'danger-full-access' : 'workspace-write';
}

export function sandboxPolicy(opts) {
  const mode = sandboxMode(opts);
  if (mode === 'danger-full-access') return { type: 'dangerFullAccess' };
  if (mode === 'read-only') {
    return { type: 'readOnly', networkAccess: opts.toolProfile === 'copy-layout-worker' ? false : true };
  }
  return {
    type: 'workspaceWrite',
    writableRoots: [opts.rootDir],
    networkAccess: true,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  };
}

function collaborationMode(opts) {
  return {
    // Codex는 현재 Plan과 Default를 노출한다. Rau의 Build 의도는 Default와
    // 독립적으로 선택한 sandbox 정책의 조합으로 대응한다.
    mode: nativeProviderInteractionMode(opts) === 'plan' ? 'plan' : 'default',
    settings: {
      model: opts.model ?? DEFAULT_CODEX_MODEL,
      reasoning_effort: opts.effort ?? null,
      // 주변 app-server v2 프로토콜은 camelCase지만 Collaboration-mode Settings는
      // 의도적으로 snake_case를 쓴다. resume은 기존 스레드 지시를 유지할 수
      // 있으므로 현재 모드 브리프를 매 턴 개발자 지시로 갱신한다.
      developer_instructions: systemBriefFor(opts, 'codex'),
    },
  };
}

function questionErrorFrame(frame, error) {
  return {
    id: frame.id,
    error: {
      code: -32602,
      message: truncate(String(error?.message ?? 'Invalid user question'), 500),
      data: { code: String(error?.code ?? 'INVALID_PROVIDER_USER_QUESTION') },
    },
  };
}

function toolInfo(item) {
  if (!item || typeof item !== 'object') return null;
  const callId = String(item.id ?? '');
  if (!callId) return null;
  if (item.type === 'mcpToolCall') {
    return {
      callId,
      tool: String(item.tool ?? 'mcp_tool').replace(/^mcp__rhwp__/, ''),
      args: item.arguments ?? {},
      ok: item.status !== 'failed',
      result: item.result ?? item.error ?? null,
    };
  }
  if (item.type === 'collabAgentToolCall') {
    return {
      callId,
      tool: item.tool === 'wait' ? 'wait_agents' : String(item.tool ?? 'collaboration'),
      args: item.prompt ? { prompt: item.prompt } : {},
      ok: item.status !== 'failed',
      result: item.agentsStates ?? item.status ?? null,
    };
  }
  if (item.type === 'commandExecution') {
    return {
      callId,
      tool: 'command_execution',
      args: { command: item.command ?? '' },
      ok: item.status !== 'failed' && item.exitCode !== null ? item.exitCode === 0 : item.status !== 'failed',
      result: item.aggregatedOutput ?? `exit_code=${item.exitCode ?? '?'}`,
    };
  }
  if (item.type === 'fileChange') {
    return {
      callId,
      tool: 'file_change',
      args: { changes: item.changes ?? [] },
      ok: item.status !== 'failed',
      result: item.changes ?? item.status ?? null,
    };
  }
  if (item.type === 'webSearch') {
    return {
      callId,
      tool: 'web_search',
      args: { query: item.query ?? item.action ?? '' },
      ok: true,
      result: item.action ?? null,
    };
  }
  return null;
}

/**
 * 앱 서버가 메서드를 모른다는 거절. JSON-RPC 표준은 -32601 이지만 codex 0.162 앱 서버는 요청 enum
 * 역직렬화에서 -32600 "Invalid request: unknown variant `<method>`, expected one of …" 를 낸다.
 */
function isUnknownMethodError(error, method) {
  if (error?.code === -32601) return true;
  return error?.code === -32600 && String(error?.message ?? '').includes(`unknown variant \`${method}\``);
}

/** 스레드 롤아웃(`<codexHome>/sessions/YYYY/MM/DD/rollout-…-<threadId>.jsonl`)이 남아 있는지 본다. */
export async function canResumeCodexThread(opts, threadId) {
  if (!isSafeSessionId(threadId)) return false;
  const codexHome = opts.codexHome ?? process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
  const found = await findSessionFile(
    path.join(codexHome, 'sessions'),
    (name) => name.startsWith('rollout-') && name.endsWith(`-${threadId}.jsonl`),
    { maxDepth: 3 },
  );
  return Boolean(found);
}

/** Codex 가 맥락 창 크기로 세는 값 — 마지막 모델 호출의 totalTokens (입력 + 출력). */
function contextTokensOf(last) {
  if (!last || typeof last !== 'object') return null;
  const total = Number(last.totalTokens ?? last.total_tokens);
  if (Number.isFinite(total) && total > 0) return Math.round(total);
  const sum = (Number(last.inputTokens ?? last.input_tokens) || 0) + (Number(last.outputTokens ?? last.output_tokens) || 0);
  return sum > 0 ? Math.round(sum) : null;
}

const COMPACTION_START_TIMEOUT_MS = 30_000;

function normalizedUsage(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const usage = {
    inputTokens: Math.max(0, Number(raw.inputTokens ?? raw.input_tokens) || 0),
    outputTokens: Math.max(0, Number(raw.outputTokens ?? raw.output_tokens) || 0),
    cacheReadTokens: Math.max(0, Number(raw.cachedInputTokens ?? raw.cached_input_tokens) || 0),
    cacheCreationTokens: Math.max(0, Number(raw.cacheWriteInputTokens ?? raw.cache_write_input_tokens) || 0),
  };
  return Object.values(usage).some((value) => value > 0) ? usage : null;
}

/**
 * Persistent Codex app-server session. Negotiation is lazy, so inability to
 * initialize or enable default-mode request_user_input can hand the untouched
 * first message to the legacy transport without overlapping provider turns.
 *
 * @param {import('./backend.mjs').BackendOptions} opts
 * @param {any} [dependencies]
 * @returns {import('./backend.mjs').AgentSession}
 */
export function createCodexAppServerSession(opts, dependencies = {}) {
  const {
    spawnProcess = spawn,
    terminateProcess = terminateProcessTree,
    createRolloutWatcher,
    prepareHome = () => {},
    createLegacySession,
    platform = process.platform,
    nodeCommand = process.execPath,
  } = dependencies;
  // 재개가 사라진 턴의 turn-end 에 resumeLost 를 싣는다 — turn-end 를 내는 곳이 여럿이라 여기서 한 번에.
  let turnResumeLost = false;
  // 이번 턴에 thread/inject_items 를 보냈다 — 턴이 끝나지 못하면 스레드가 기록을 받았는지 알 수 없다.
  let turnHistoryInjected = false;
  const onEvent = (event) => {
    if (event?.type !== 'turn-end') {
      opts.onEvent(event);
      return;
    }
    const lost = turnResumeLost;
    const uncertain = turnHistoryInjected && (event.stopReason !== 'completed' || Boolean(event.errorMessage));
    turnResumeLost = false;
    turnHistoryInjected = false;
    opts.onEvent({
      ...event,
      ...(lost ? { resumeLost: true } : {}),
      ...(uncertain ? { handoffUncertain: true } : {}),
    });
  };
  // 앱 서버가 thread/inject_items 를 모르면(-32601) 이 세션 동안은 인라인 기록을 보낸다.
  let historyInjectSupported = true;
  /** @type {import('node:child_process').ChildProcess | null} */
  let proc = null;
  /** @type {CodexJsonRpcConnection | null} */
  let rpc = null;
  /** @type {Promise<CodexJsonRpcConnection> | null} */
  let readyPromise = null;
  /** @type {Promise<void>} */
  let restartPromise = Promise.resolve();
  let expectedShutdown = false;
  let cleanupUncertain = false;
  let attachedGeneration = 0;
  let permissionBriefDirty = false;
  let injectedPermissionBrief = null;
  let generation = 0;
  /** @type {string | null} */
  let threadId = isSafeSessionId(opts.resumeSessionId) ? opts.resumeSessionId : null;
  // 재개 커서로 받은 스레드는 처음 붙을 때까지 확인되지 않았다 — 붙지 못하면 새 스레드로 간다.
  let resumeUnverified = Boolean(threadId);
  // Codex writes a thread's rollout only once a turn starts. A thread opened
  // for Plan readiness alone cannot be resumed by a fresh app-server.
  // A resume cursor is recorded only after a turn, so it has a rollout.
  let threadHasTurns = Boolean(threadId);
  let resumeLostPending = false;
  /** @type {'message'|'compact'} */
  let turnKind = 'message';
  let lastContextTokens = null;
  let contextWindow = null;
  /** @type {{ compactionId: string, trigger: 'auto'|'manual', beforeTokens?: number, afterTokens?: number, done: boolean } | null} */
  let turnCompaction = null;
  /** @type {string | null} */
  let activeTurnId = null;
  /** @type {{ connection: CodexJsonRpcConnection, generation: number } | null} */
  let pendingTurnStart = null;
  /** @type {string | null} */
  let settlingTurnId = null;
  let turnOpen = false;
  let starting = false;
  let disposed = false;
  let interruptRequested = false;
  // Stop나 다음 메시지가 진행 중인 시작 시도를 대체하면 값이 바뀐다. 대체된
  // 시도는 늦게 도착한 실패를 legacy 전환이나 두 번째 turn-end로 바꾸지 않는다.
  let turnAttempt = 0;
  // 이 CLI가 런타임 enablement를 무시한다는 것이 확인되면 이후 턴은 처음부터
  // 기능 플래그를 붙여 한 번만 spawn한다.
  let defaultModeFlagRequired = false;
  /** @type {import('./backend.mjs').AgentSession | null} */
  let fallback = null;
  let stderrTail = '';
  /** @type {import('./backend.mjs').UsageTokens | null} */
  let pendingUsage = null;
  /** @type {import('./backend.mjs').UsageTokens | null} */
  let cumulativeUsage = null;
  /** @type {import('./backend.mjs').UsageTokens | null} */
  let turnUsageBaseline = null;
  /** @type {any} */
  let rolloutWatcher = null;
  const questionControllers = new Map();
  /** @type {ReturnType<typeof setTimeout> | null} */
  let idleReleaseTimer = null;

  function safeMessage(error, max = 1200) {
    return truncate(redactDiagnosticText(error?.message ?? error, [opts.token]), max);
  }

  function finalizeRolloutWatcher() {
    const watcher = rolloutWatcher;
    rolloutWatcher = null;
    if (!watcher) return;
    try {
      watcher.finalize();
    } catch (error) {
      process.stderr.write(`[codex-app-server] rollout finalize error: ${error?.message ?? error}\n`);
    }
  }

  function abortQuestions(reason = new Error('Codex request was invalidated')) {
    for (const entry of questionControllers.values()) entry.controller.abort(reason);
    questionControllers.clear();
  }

  function endTurn(event) {
    if (!turnOpen) return;
    turnOpen = false;
    starting = false;
    activeTurnId = null;
    pendingTurnStart = null;
    settlingTurnId = null;
    pendingUsage = null;
    turnCompaction = null;
    interruptRequested = event.stopReason === 'interrupted';
    finalizeRolloutWatcher();
    onEvent(event);
  }

  function compactionEvent(compaction, phase, extra = {}) {
    return {
      type: 'compaction',
      agent: 'codex',
      compactionId: compaction.compactionId,
      phase,
      trigger: compaction.trigger,
      ...(compaction.beforeTokens !== undefined ? { beforeTokens: compaction.beforeTokens } : {}),
      ...extra,
    };
  }

  /** contextCompaction 항목(item/started → item/completed)과 구식 thread/compacted 를 한 계약으로 낸다. */
  function onCompaction(phase, id) {
    if (phase === 'started') {
      if (turnCompaction && !turnCompaction.done) return;
      turnCompaction = {
        compactionId: `codex:${id}`,
        trigger: turnKind === 'compact' ? 'manual' : 'auto',
        ...(lastContextTokens !== null ? { beforeTokens: lastContextTokens } : {}),
        done: false,
      };
      onEvent(compactionEvent(turnCompaction, 'started'));
      return;
    }
    const compaction = turnCompaction && !turnCompaction.done ? turnCompaction : {
      compactionId: `codex:${id}`,
      trigger: turnKind === 'compact' ? 'manual' : 'auto',
      ...(lastContextTokens !== null ? { beforeTokens: lastContextTokens } : {}),
      done: false,
    };
    compaction.done = true;
    turnCompaction = compaction;
    onEvent(compactionEvent(compaction, 'completed', {
      ...(compaction.afterTokens !== undefined ? { afterTokens: compaction.afterTokens } : {}),
    }));
  }

  function emitContextUsage() {
    if (lastContextTokens === null) return;
    onEvent({
      type: 'context-usage',
      agent: 'codex',
      usedTokens: lastContextTokens,
      ...(contextWindow ? { maxTokens: contextWindow } : {}),
      autoCompact: true,
    });
  }

  function emitSessionInfo(id) {
    if (!id || threadId === id) return;
    threadId = id;
    onEvent({ type: 'session-info', agent: 'codex', sessionId: id });
  }

  function connectionIsCurrent(connection, frameGeneration) {
    return rpc === connection
      && !connection.closed
      && generation === frameGeneration;
  }

  function notificationMatchesActiveTurn(params) {
    const notificationTurnId = String(params?.turnId ?? params?.turn?.id ?? '');
    return turnOpen
      && Boolean(activeTurnId)
      && notificationTurnId === activeTurnId;
  }

  function activateTurn(connection, frameGeneration, turnId) {
    const pending = pendingTurnStart;
    if (!starting
      || !pending
      || pending.connection !== connection
      || pending.generation !== frameGeneration
      || !connectionIsCurrent(connection, frameGeneration)
      || !turnId) return false;
    activeTurnId = turnId;
    pendingTurnStart = null;
    starting = false;
    turnOpen = true;
    threadHasTurns = true;
    onEvent({ type: 'turn-start', agent: 'codex' });
    const codexHome = opts.codexHome ?? process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
    rolloutWatcher = createRolloutWatcher?.({
      codexHome,
      emit: (event) => { if (!disposed && turnOpen && activeTurnId === turnId) onEvent(event); },
    }) ?? null;
    rolloutWatcher?.start(threadId);
    pendingUsage = null;
    turnUsageBaseline = cumulativeUsage ? { ...cumulativeUsage } : null;
    return true;
  }

  async function settleCompletedTurn(connection, frameGeneration, params) {
    const completedTurnId = String(params?.turn?.id ?? '');
    if (!connectionIsCurrent(connection, frameGeneration)
      || !notificationMatchesActiveTurn(params)
      || settlingTurnId === completedTurnId) return;
    settlingTurnId = completedTurnId;
    const status = String(params.turn?.status ?? 'completed');
    const usage = pendingUsage;
    const failureMessage = status === 'failed'
      ? String(params.turn?.error?.message ?? 'Codex turn failed')
      : null;
    abortQuestions(Object.assign(new Error('Codex turn completed'), { code: 'REQUEST_INVALIDATED' }));
    // The app-server owns the MCP stdio child. A protocol terminal frame does
    // not prove that background work is quiescent, so close and prove this
    // process generation before publishing turn-end. The next turn resumes
    // the same thread in a fresh app-server process.
    const cleaned = await stopConnection();
    if (disposed || !turnOpen || activeTurnId !== completedTurnId) return;
    if (usage) {
      onEvent({
        type: 'usage', agent: 'codex', model: opts.model ?? DEFAULT_CODEX_MODEL,
        usage,
      });
    }
    if (!cleaned) {
      const message = 'Codex app-server process-tree cleanup could not be confirmed after the turn';
      onEvent({ type: 'error', agent: 'codex', message });
      endTurn({ type: 'turn-end', agent: 'codex', stopReason: 'failed', errorMessage: message });
    } else if (failureMessage) {
      onEvent({ type: 'error', agent: 'codex', message: failureMessage });
      endTurn({ type: 'turn-end', agent: 'codex', stopReason: 'failed', errorMessage: failureMessage });
    } else {
      endTurn({
        type: 'turn-end', agent: 'codex',
        stopReason: status === 'interrupted' ? 'interrupted' : 'completed',
      });
    }
  }

  function handleNotification(frame, connection, frameGeneration) {
    if (!connectionIsCurrent(connection, frameGeneration)) return;
    const method = frame?.method;
    const params = frame?.params ?? {};
    if (method === 'thread/started') {
      const id = String(params.thread?.id ?? '');
      if (!threadId && id) emitSessionInfo(id);
      return;
    }
    if (params.threadId && threadId && String(params.threadId) !== threadId) return;
    if (method === 'turn/started') {
      activateTurn(connection, frameGeneration, String(params.turn?.id ?? ''));
      return;
    }
    if (method === 'item/agentMessage/delta') {
      if (!notificationMatchesActiveTurn(params)) return;
      if (params.delta) onEvent({ type: 'text-delta', agent: 'codex', text: String(params.delta) });
      return;
    }
    if ((method === 'item/started' || method === 'item/completed') && params.item?.type === 'contextCompaction') {
      // 자식(서브에이전트) 스레드의 압축은 위 threadId 필터에서 이미 걸러진다.
      if (!notificationMatchesActiveTurn(params)) return;
      onCompaction(method === 'item/started' ? 'started' : 'completed', String(params.item.id ?? activeTurnId));
      return;
    }
    if (method === 'thread/compacted') {
      // 0.162 는 contextCompaction 항목만 낸다. 구버전 서버의 알림은 항목이 없을 때만 완료로 친다.
      if (!notificationMatchesActiveTurn(params)) return;
      if (!turnCompaction?.done) onCompaction('completed', `${params.turnId}:compacted`);
      return;
    }
    if (method === 'item/started' || method === 'item/completed') {
      if (!notificationMatchesActiveTurn(params)) return;
      const info = toolInfo(params.item);
      if (!info || info.tool === 'ask_user_question') return;
      if (method === 'item/started') {
        onEvent({
          type: 'tool-call', agent: 'codex', callId: info.callId, tool: info.tool,
          argsJson: JSON.stringify(info.args),
        });
      } else {
        onEvent({
          type: 'tool-result', agent: 'codex', callId: info.callId, ok: info.ok,
          resultPreview: truncate(typeof info.result === 'string' ? info.result : JSON.stringify(info.result)),
        });
      }
      return;
    }
    if (method === 'thread/tokenUsage/updated') {
      if (!notificationMatchesActiveTurn(params)) return;
      const window = Number(params.tokenUsage?.modelContextWindow);
      if (Number.isFinite(window) && window > 0) contextWindow = Math.round(window);
      const contextTokens = contextTokensOf(params.tokenUsage?.last);
      if (contextTokens !== null) {
        lastContextTokens = contextTokens;
        // 압축 중의 갱신은 압축 뒤 맥락 크기다 (0.162: 17780 → 11504 확인).
        if (turnCompaction && !turnCompaction.done) turnCompaction.afterTokens = contextTokens;
        emitContextUsage();
      }
      const total = normalizedUsage(params.tokenUsage?.total);
      if (total) {
        const baseline = turnUsageBaseline ?? {
          inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
        };
        pendingUsage = {
          inputTokens: Math.max(0, total.inputTokens - baseline.inputTokens),
          outputTokens: Math.max(0, total.outputTokens - baseline.outputTokens),
          cacheReadTokens: Math.max(0, total.cacheReadTokens - baseline.cacheReadTokens),
          cacheCreationTokens: Math.max(0, total.cacheCreationTokens - baseline.cacheCreationTokens),
        };
        if (!Object.values(pendingUsage).some((value) => value > 0)) pendingUsage = null;
        cumulativeUsage = total;
      } else {
        // Older app-server fixtures exposed only `last`; retain compatibility
        // while current servers use cumulative totals to cover both sides of
        // a request_user_input pause in one logical turn.
        pendingUsage = normalizedUsage(params.tokenUsage?.last);
      }
      return;
    }
    if (method === 'turn/completed') {
      void settleCompletedTurn(connection, frameGeneration, params);
      return;
    }
    if (method === 'error' && params.message
      && (!params.turnId || notificationMatchesActiveTurn(params))) {
      onEvent({ type: 'error', agent: 'codex', message: String(params.message) });
    }
  }

  async function handleServerRequest(frame, connection, frameGeneration) {
    if (!connectionIsCurrent(connection, frameGeneration)) return;
    if (frame.method !== CODEX_REQUEST_USER_INPUT_METHOD) {
      // Approval requests should be impossible under approvalPolicy=never. If a
      // future server still sends one, fail closed instead of hanging it.
      if (frame.id !== undefined) {
        connection.send({ id: frame.id, error: { code: -32601, message: `Unsupported server request: ${frame.method}` } });
      }
      return;
    }
    const requestThreadId = String(frame.params?.threadId ?? '');
    const requestTurnId = String(frame.params?.turnId ?? '');
    if (!turnOpen || !activeTurnId || !threadId
      || requestThreadId !== threadId || requestTurnId !== activeTurnId) {
      connection.send(questionErrorFrame(frame, Object.assign(
        new Error('Codex user questions are restricted to the active root turn'),
        { code: 'SUBAGENT_USER_INPUT_DENIED' },
      )));
      return;
    }
    const key = rpcKey(frame.id);
    if (questionControllers.has(key)) return;
    const controller = new AbortController();
    const binding = { controller, connection, generation: frameGeneration, turnId: activeTurnId };
    questionControllers.set(key, binding);
    try {
      const response = await handleCodexRequestUserInputFrame(opts, frame, controller.signal, {
        agentRole: opts.agentRole,
      });
      if (connectionIsCurrent(connection, frameGeneration)
        && turnOpen && activeTurnId === binding.turnId) connection.send(response);
    } catch (error) {
      if (!connection.closed) connection.send(questionErrorFrame(frame, error));
    } finally {
      if (questionControllers.get(key) === binding) questionControllers.delete(key);
    }
  }

  function handleFrame(frame, connection, frameGeneration) {
    if (frame?.method && frame.id !== undefined) {
      return handleServerRequest(frame, connection, frameGeneration);
    }
    if (frame?.method) handleNotification(frame, connection, frameGeneration);
  }

  function handleConnectionClosed(child, connection, error, cleaned = null) {
    if (proc === child && cleaned === true) proc = null;
    if (cleaned === false) cleanupUncertain = true;
    if (rpc === connection) {
      rpc = null;
      readyPromise = null;
      attachedGeneration = 0;
      pendingTurnStart = null;
      abortQuestions(Object.assign(new Error('Codex provider disconnected'), { code: 'PROVIDER_DISCONNECTED' }));
    }
    if (!expectedShutdown && turnOpen && !disposed && !fallback) {
      const clean = redactDiagnosticText(stderrTail, [opts.token]);
      const message = clean.trim()
        ? `Codex app-server disconnected.\n${truncate(clean.trim(), 1200)}`
        : String(error?.message ?? 'Codex app-server disconnected');
      onEvent({ type: 'error', agent: 'codex', message });
      endTurn({ type: 'turn-end', agent: 'codex', stopReason: 'exited' });
    }
  }

  async function listFeatures(connection, timeoutMs = NEGOTIATION_TIMEOUT_MS) {
    const features = [];
    let cursor = null;
    const deadline = Date.now() + timeoutMs;
    for (let page = 0; page < 10; page += 1) {
      const remaining = Math.max(1, deadline - Date.now());
      const result = await connection.request('experimentalFeature/list', {
        ...(cursor ? { cursor } : {}),
        limit: 100,
      }, {
        timeoutMs: remaining,
        label: 'Codex feature discovery',
      });
      features.push(...(Array.isArray(result?.data) ? result.data : []));
      cursor = result?.nextCursor ?? null;
      if (!cursor) break;
    }
    return features;
  }

  async function negotiate(connection, { featureForced = false } = {}) {
    await connection.request('initialize', {
      clientInfo: { name: 'rhwp-studio', title: 'HamaEditor', version: '4' },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
        extensions: {},
      },
    }, {
      timeoutMs: NEGOTIATION_TIMEOUT_MS,
      label: 'Codex app-server initialize',
    });
    connection.notify('initialized');

    const planNative = nativeProviderInteractionMode(opts) === 'plan';
    if (planNative) {
      let modes;
      try {
        modes = await connection.request('collaborationMode/list', {}, {
          timeoutMs: NEGOTIATION_TIMEOUT_MS,
          label: 'Codex collaboration-mode discovery',
        });
      } catch (error) {
        throw new CodexAppServerUnavailableError('Codex cannot verify native Plan mode', error);
      }
      if (!Array.isArray(modes?.data) || !modes.data.some((entry) => entry?.mode === 'plan')) {
        throw new CodexAppServerUnavailableError('Codex native Plan mode is unavailable');
      }
      return { restartWithFeature: false };
    }
    let features;
    try {
      features = await listFeatures(connection);
    } catch (error) {
      throw new CodexAppServerUnavailableError('Codex cannot verify default-mode user input', error);
    }

    const feature = features.find((entry) => entry?.name === DEFAULT_MODE_FEATURE);
    if (!feature || feature.stage === 'removed') {
      throw new CodexAppServerUnavailableError('Codex default-mode user input is unavailable');
    }
    if (codexDefaultModeUserInputEnabled(features)) return { restartWithFeature: false };
    if (featureForced) {
      throw new CodexAppServerUnavailableError('Codex ignored the default-mode user input feature flag');
    }
    try {
      const enabled = await connection.request('experimentalFeature/enablement/set', {
        enablement: { [DEFAULT_MODE_FEATURE]: true },
      }, {
        timeoutMs: NEGOTIATION_TIMEOUT_MS,
        label: 'Codex feature enablement',
      });
      if (enabled?.enablement?.[DEFAULT_MODE_FEATURE] === true) {
        features = await listFeatures(connection);
        if (codexDefaultModeUserInputEnabled(features)) return { restartWithFeature: false };
      }
    } catch (error) {
      process.stderr.write(`[codex-app-server] runtime feature enablement was not confirmed: ${safeMessage(error)}\n`);
    }
    // 0.149 advertises the runtime API but intentionally does not mutate
    // under-development flags through it (the response contains an empty
    // enablement map). Restart pre-turn with the equivalent supported CLI flag,
    // then re-query to prove the capability actually became active.
    return { restartWithFeature: true };
  }

  async function stopNegotiationProcess(child, connection) {
    expectedShutdown = true;
    const cleaned = await connection.close(
      new Error('Restarting Codex app-server with native user input enabled'),
      { terminate: true },
    );
    if (cleaned && proc === child) proc = null;
    if (!cleaned) cleanupUncertain = true;
    expectedShutdown = false;
    if (!cleaned) {
      throw new CodexAppServerUnavailableError('Codex app-server process tree cleanup could not be confirmed');
    }
  }

  async function startConnection({ featureForced = false } = {}) {
    const attempt = turnAttempt;
    let child;
    let launch;
    try {
      launch = opts.prepareLaunch ? await opts.prepareLaunch() : null;
      if (disposed || attempt !== turnAttempt) throw new Error('Codex launch was cancelled');
      applyPreparedProviderLaunch(opts, 'codex', launch);
      const codexHome = opts.codexHome ?? process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
      prepareHome(codexHome, opts.codexAuthPath);
      stderrTail = '';
      expectedShutdown = false;
      const spawnEnv = {
        ...isolatedProcessEnv(opts, opts.providerEnv ?? process.env),
        CODEX_HOME: codexHome,
      };
      const launched = applyManagedCliLaunch(opts.codexBin ?? 'codex', buildCodexAppServerArgv(opts, {
        enableDefaultModeUserInput: featureForced,
      }), { platform, nodeCommand, env: spawnEnv });
      child = spawnProcess(launched.command, launched.argv, {
        ...processTreeSpawnOptions(),
        cwd: opts.rootDir,
        env: launched.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      throw new CodexAppServerUnavailableError('Failed to start Codex app-server', error);
    } finally {
      launch?.release?.();
    }
    proc = child;
    const connectionGeneration = ++generation;
    let connection;
    connection = new CodexJsonRpcConnection(child, {
      onFrame: (frame) => handleFrame(frame, connection, connectionGeneration),
      onClosed: (error, cleaned) => handleConnectionClosed(
        child, connection, error, cleaned,
      ),
      terminateProcess,
    });
    rpc = connection;
    child.stdin.on('error', (error) => {
      process.stderr.write(`[codex-app-server] stdin error: ${error?.message ?? error}\n`);
    });
    child.stderr.on('data', (chunk) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-STDERR_TAIL_LIMIT);
    });
    try {
      const result = await negotiate(connection, { featureForced });
      if (result.restartWithFeature) {
        defaultModeFlagRequired = true;
        await stopNegotiationProcess(child, connection);
        return startConnection({ featureForced: true });
      }
    } catch (error) {
      if (!(error instanceof CodexAppServerUnavailableError)) {
        throw new CodexAppServerUnavailableError('Codex app-server negotiation failed', error);
      }
      throw error;
    }
    return connection;
  }

  function ensureConnection() {
    return restartPromise.then(async () => {
      if (cleanupUncertain) {
        throw new CodexAppServerUnavailableError('Codex app-server process tree cleanup remains unconfirmed');
      }
      if (rpc && !rpc.closed) return rpc;
      if (proc) {
        const cleaned = await stopConnection();
        if (!cleaned) {
          throw new CodexAppServerUnavailableError('Codex app-server process tree cleanup could not be confirmed');
        }
      }
      if (!readyPromise) {
        const connecting = startConnection({
          featureForced: defaultModeFlagRequired && nativeProviderInteractionMode(opts) !== 'plan',
        }).catch((error) => {
          if (readyPromise === connecting) readyPromise = null;
          throw error;
        });
        readyPromise = connecting;
      }
      return readyPromise;
    });
  }

  async function attachThread(connection) {
    if (attachedGeneration === generation) return;
    let result;
    if (threadId && threadHasTurns) {
      try {
        result = await connection.request('thread/resume', {
          threadId,
          model: opts.model ?? DEFAULT_CODEX_MODEL,
          cwd: opts.rootDir,
          approvalPolicy: 'never',
          sandbox: sandboxMode(opts),
          developerInstructions: systemBriefFor(opts, 'codex'),
          excludeTurns: true,
        });
      } catch (error) {
        // 재개 커서의 롤아웃이 사라졌다 ("no rollout found for thread id …", 0.162 확인).
        // 이 백엔드에서 이미 붙었던 스레드도 롤아웃이 없으면 새 스레드로 간다. 그 밖의 실패는 그대로 올린다.
        if (!resumeUnverified && !/no rollout found/i.test(String(error?.message ?? error))) throw error;
        process.stderr.write(`[codex-app-server] resume failed, starting a new thread: ${safeMessage(error)}\n`);
        resumeUnverified = false;
        resumeLostPending = true;
        threadId = null;
        threadHasTurns = false;
        lastContextTokens = null;
      }
    }
    if (!result) {
      result = await connection.request('thread/start', {
        model: opts.model ?? DEFAULT_CODEX_MODEL,
        cwd: opts.rootDir,
        approvalPolicy: 'never',
        sandbox: sandboxMode(opts),
        developerInstructions: systemBriefFor(opts, 'codex'),
        ephemeral: false,
      });
    }
    const id = String(result?.thread?.id ?? threadId ?? '');
    if (!id) throw new Error('Codex app-server did not return a thread id');
    emitSessionInfo(id);
    if (permissionBriefDirty) {
      // Default 모드는 settings.developer_instructions를 모델 이력에 넣지 않는다.
      // 현재 채팅 권한은 같은 스레드의 개발자 메시지로 갱신해야 실제로 적용된다.
      try {
        const brief = systemBriefFor(opts, 'codex');
        await connection.request('thread/inject_items', {
          threadId: id,
          items: [{
            type: 'message', role: 'developer',
            content: [{ type: 'input_text', text: `The following is the current Rauhwpx chat capability state and replaces earlier Rauhwpx mode and permission instructions for this conversation.\n\n${brief}` }],
          }],
        }, { timeoutMs: NEGOTIATION_TIMEOUT_MS, label: 'Codex chat permission instructions' });
        injectedPermissionBrief = brief;
      } catch (error) {
        throw new CodexAppServerUnavailableError('Codex could not update this chat permission. A CLI with thread/inject_items support is required; update Codex and retry.', error);
      }
      permissionBriefDirty = false;
    }
    resumeUnverified = false;
    attachedGeneration = generation;
  }

  /** 붙는 중에 재개가 사라졌으면 이번 턴이 그 사실을 turn-end 로 알린다. */
  function takeResumeLost() {
    if (!resumeLostPending) return false;
    resumeLostPending = false;
    turnResumeLost = true;
    return true;
  }

  async function stopConnection() {
    if (cleanupUncertain) return false;
    const child = proc;
    if (!child) return true;
    const connection = rpc?.proc === child ? rpc : null;
    expectedShutdown = true;
    let cleaned;
    if (connection) {
      cleaned = await connection.close(
        new Error('Codex app-server restarted between turns'),
        { terminate: true },
      );
    } else {
      cleaned = await terminateAndWaitForProcessTreeExit(child, { terminateProcess });
    }
    if (cleaned && proc === child) proc = null;
    if (!cleaned) cleanupUncertain = true;
    if (rpc === connection) rpc = null;
    readyPromise = null;
    attachedGeneration = 0;
    expectedShutdown = false;
    return cleaned;
  }

  function cancelIdleRelease() {
    if (idleReleaseTimer) clearTimeout(idleReleaseTimer);
    idleReleaseTimer = null;
  }

  // Plan readiness keeps a warm app-server between turns. Release it after a
  // quiet period; the next turn resumes the same thread in a fresh process.
  function scheduleIdleRelease() {
    cancelIdleRelease();
    idleReleaseTimer = setTimeout(() => {
      idleReleaseTimer = null;
      if (disposed || starting || turnOpen) return;
      const priorRestart = restartPromise;
      restartPromise = priorRestart.then(() => (starting || turnOpen ? true : stopConnection()));
    }, opts.idleReleaseMs ?? IDLE_PROCESS_RELEASE_MS);
    idleReleaseTimer.unref?.();
  }

  async function switchToLegacy(text, error, attempt) {
    const superseded = () => disposed || attempt !== turnAttempt;
    const reportCleanupFailure = () => {
      const message = 'Codex app-server process-tree cleanup could not be confirmed.';
      onEvent({ type: 'error', agent: 'codex', message });
      onEvent({ type: 'turn-end', agent: 'codex', stopReason: 'failed', errorMessage: message });
    };
    if (nativeProviderInteractionMode(opts) === 'plan') {
      process.stderr.write(`[codex-app-server] native plan mode unavailable: ${safeMessage(error)}\n`);
      const cleaned = await stopConnection();
      if (superseded()) return;
      starting = false;
      if (!cleaned) {
        reportCleanupFailure();
        return;
      }
      const message = `Codex native Plan mode is unavailable: ${safeMessage(error)}`;
      onEvent({ type: 'error', agent: 'codex', message });
      onEvent({ type: 'turn-end', agent: 'codex', stopReason: 'failed', errorMessage: message });
      return;
    }
    process.stderr.write(`[codex-app-server] using legacy exec fallback: ${safeMessage(error)}\n`);
    const cleaned = await stopConnection();
    if (superseded()) return;
    if (!cleaned) {
      starting = false;
      reportCleanupFailure();
      return;
    }
    fallback = createLegacySession?.(threadId) ?? null;
    starting = false;
    if (!fallback) {
      onEvent({ type: 'error', agent: 'codex', message: 'Codex native and legacy transports are unavailable.' });
      onEvent({ type: 'turn-end', agent: 'codex', stopReason: 'exited' });
      return;
    }
    fallback.sendUserMessage(text);
  }

  /**
   * 기록을 네이티브 항목으로 넣는다. true = 주입됨(기록 없는 프롬프트를 보낸다), false = 앱 서버가
   * 메서드를 모른다(인라인으로 보낸다). 그 밖의 오류는 스레드 상태가 불확실하므로 던진다.
   */
  async function injectHistory(connection, handoff) {
    if (!historyInjectSupported) return false;
    turnHistoryInjected = true;
    try {
      await connection.request('thread/inject_items', { threadId, items: codexHistoryItems(handoff) });
      return true;
    } catch (error) {
      // 이 세션에서는 다시 주입하지 않는다 — 모호한 실패 뒤의 교체 턴도 인라인으로 보내야 매 턴 같은
      // 오류로 막히지 않는다.
      historyInjectSupported = false;
      if (!isUnknownMethodError(error, 'thread/inject_items')) throw error;
      // 모르는 메서드는 요청을 해석하는 단계에서 거절되어 스레드를 건드리지 않는다.
      turnHistoryInjected = false;
      process.stderr.write('[codex-app-server] thread/inject_items unsupported; sending history inline\n');
      return false;
    }
  }

  async function startTurn(text, attempt, { resumeFallbackText = null, handoff = null, resumeFallbackHandoff = null } = {}) {
    const stale = () => disposed || attempt !== turnAttempt;
    let connection;
    try {
      connection = await ensureConnection();
    } catch (error) {
      if (stale()) return;
      await switchToLegacy(text, error, attempt);
      return;
    }
    if (stale()) return;
    if (fallback || interruptRequested) {
      starting = false;
      return;
    }
    try {
      await attachThread(connection);
    } catch (error) {
      if (stale()) return;
      starting = false;
      const detail = safeMessage(error);
      const cleaned = await stopConnection();
      const message = `Codex app-server could not open the thread: ${detail}${cleaned ? '' : ' Process-tree cleanup could not be confirmed.'}`;
      onEvent({ type: 'error', agent: 'codex', message });
      onEvent({ type: 'turn-end', agent: 'codex', stopReason: 'failed', errorMessage: message });
      return;
    }
    if (stale()) return;
    if (interruptRequested) {
      starting = false;
      return;
    }
    let history = handoff;
    if (takeResumeLost() && resumeFallbackText) {
      text = resumeFallbackText;
      history = resumeFallbackHandoff;
    }
    if (history && Array.isArray(history.entries) && history.entries.length > 0 && typeof history.plainText === 'string') {
      let injected;
      try {
        injected = await injectHistory(connection, history);
      } catch (error) {
        if (stale()) return;
        starting = false;
        const cleaned = await stopConnection();
        const message = `Codex could not add the earlier conversation: ${safeMessage(error)}${cleaned ? '' : ' Process-tree cleanup could not be confirmed.'}`;
        onEvent({ type: 'error', agent: 'codex', message });
        onEvent({ type: 'turn-end', agent: 'codex', stopReason: 'failed', errorMessage: message });
        return;
      }
      if (stale()) return;
      if (interruptRequested) {
        starting = false;
        return;
      }
      if (injected) text = history.plainText;
    }

    const turnGeneration = generation;
    pendingTurnStart = { connection, generation: turnGeneration };
    try {
      const response = await connection.request('turn/start', {
        threadId,
        input: [{ type: 'text', text }],
        cwd: opts.rootDir,
        approvalPolicy: 'never',
        sandboxPolicy: sandboxPolicy(opts),
        model: opts.model ?? DEFAULT_CODEX_MODEL,
        effort: opts.effort ?? null,
        collaborationMode: collaborationMode(opts),
      });
      if (stale() || interruptRequested || (!starting && !turnOpen)) return;
      const responseTurnId = String(response?.turn?.id ?? '');
      if (!responseTurnId) throw new Error('Codex app-server turn/start returned no turn id');
      if (turnOpen) {
        if (activeTurnId !== responseTurnId) {
          throw new Error('Codex app-server returned a mismatched turn id');
        }
      } else if (!activateTurn(connection, turnGeneration, responseTurnId)) {
        throw new Error('Codex app-server turn start was superseded');
      }
    } catch (error) {
      const ownsPending = pendingTurnStart?.connection === connection
        && pendingTurnStart.generation === turnGeneration;
      if (ownsPending) pendingTurnStart = null;
      if (stale()) return;
      const ownedActiveTurn = turnOpen && connectionIsCurrent(connection, turnGeneration);
      if (starting || ownedActiveTurn) {
        starting = false;
        const cleaned = await stopConnection();
        const cleanupDetail = cleaned ? '' : ' Process-tree cleanup could not be confirmed.';
        const message = `Codex app-server could not start the turn: ${safeMessage(error)}${cleanupDetail}`;
        onEvent({ type: 'error', agent: 'codex', message });
        if (ownedActiveTurn) {
          endTurn({ type: 'turn-end', agent: 'codex', stopReason: 'failed', errorMessage: message });
        } else {
          onEvent({ type: 'turn-end', agent: 'codex', stopReason: 'failed', errorMessage: message });
        }
      }
    }
  }

  /**
   * 수동 압축은 앱 서버가 스스로 여는 턴이다: thread/compact/start 응답은 빈 객체이고
   * turn/started → contextCompaction 항목 → turn/completed 가 뒤따른다 (0.162 확인).
   */
  async function startCompaction(attempt) {
    const stale = () => disposed || attempt !== turnAttempt;
    const failStart = async (detail) => {
      starting = false;
      pendingTurnStart = null;
      const cleaned = await stopConnection();
      const message = `Codex could not compact the conversation: ${detail}${cleaned ? '' : ' Process-tree cleanup could not be confirmed.'}`;
      onEvent({ type: 'error', agent: 'codex', message });
      onEvent({ type: 'turn-end', agent: 'codex', stopReason: 'failed', errorMessage: message });
    };
    let connection;
    try {
      connection = await ensureConnection();
      if (stale()) return;
      if (interruptRequested) { starting = false; return; }
      await attachThread(connection);
    } catch (error) {
      if (!stale()) await failStart(safeMessage(error));
      return;
    }
    if (stale()) return;
    if (interruptRequested) { starting = false; return; }
    if (takeResumeLost()) {
      // 새로 연 빈 스레드는 압축할 것이 없다.
      await failStart('the resumed Codex thread no longer exists');
      return;
    }
    const turnGeneration = generation;
    pendingTurnStart = { connection, generation: turnGeneration };
    try {
      await connection.request('thread/compact/start', { threadId });
    } catch (error) {
      if (stale() || turnOpen) return;
      if (starting) await failStart(safeMessage(error));
      return;
    }
    if (stale() || turnOpen || !starting) return;
    // 응답과 turn/started 의 순서는 정해져 있지 않다 — 시작 알림을 잠시 기다린다.
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, COMPACTION_START_TIMEOUT_MS);
      const poll = setInterval(() => {
        if (stale() || turnOpen || !starting) {
          clearInterval(poll);
          clearTimeout(timer);
          resolve();
        }
      }, 25);
      timer.unref?.();
      poll.unref?.();
    });
    if (stale() || turnOpen || !starting) return;
    await failStart('the compaction turn did not start');
  }

  return {
    agent: 'codex',
    getSessionId() {
      return fallback?.getSessionId() ?? threadId;
    },
    get compactionSupport() {
      // legacy exec 는 자동 압축만 한다.
      return fallback ? 'auto-only' : 'manual';
    },
    canResume(id) {
      return canResumeCodexThread(opts, id);
    },
    sendUserMessage(text, { resumeFallbackText, handoff, resumeFallbackHandoff, replaceSession } = {}) {
      if (disposed) return;
      if (fallback) {
        // legacy exec 는 기록을 인라인으로만 받는다.
        fallback.sendUserMessage(text, replaceSession ? { replaceSession: true } : undefined);
        return;
      }
      if (starting || turnOpen) throw new Error('A Codex turn is already running');
      cancelIdleRelease();
      starting = true;
      interruptRequested = false;
      turnKind = 'message';
      turnHistoryInjected = false;
      if (replaceSession) {
        // 허브가 이 스레드를 믿지 않는다 — 새 스레드를 열고 turn-end 에 resumeLost 를 싣는다.
        threadId = null;
        threadHasTurns = false;
        resumeUnverified = false;
        resumeLostPending = true;
        attachedGeneration = 0;
        lastContextTokens = null;
      }
      void startTurn(text, ++turnAttempt, {
        resumeFallbackText: resumeFallbackText ?? null,
        handoff: handoff ?? null,
        resumeFallbackHandoff: resumeFallbackHandoff ?? null,
      });
    },
    compact() {
      if (disposed) return;
      if (fallback) throw new Error('Codex legacy exec cannot compact on request');
      if (starting || turnOpen) throw new Error('A Codex turn is already running');
      cancelIdleRelease();
      starting = true;
      interruptRequested = false;
      turnKind = 'compact';
      turnHistoryInjected = false;
      void startCompaction(++turnAttempt);
    },
    async setPermissionProfile(profile) {
      if (fallback) return fallback.setPermissionProfile(profile);
      if (starting || turnOpen) throw new Error('Permission profile can only change between turns');
      if (profile !== 'safe' && profile !== 'unrestricted') throw new Error(`Unknown permission profile: ${profile}`);
      cancelIdleRelease();
      const previous = opts.permissionProfile;
      const previousBriefDirty = permissionBriefDirty;
      const previousInjectedBrief = injectedPermissionBrief;
      opts.permissionProfile = profile;
      permissionBriefDirty ||= injectedPermissionBrief !== null
        && injectedPermissionBrief !== systemBriefFor(opts, 'codex');
      try {
        const priorRestart = restartPromise;
        restartPromise = priorRestart.then(() => stopConnection());
        const cleaned = await restartPromise;
        if (!cleaned) {
          throw new CodexAppServerUnavailableError('Codex app-server process tree cleanup could not be confirmed');
        }
        if (nativeProviderInteractionMode(opts) === 'plan' || (permissionBriefDirty && threadId)) {
          const connection = await ensureConnection();
          await attachThread(connection);
          scheduleIdleRelease();
        }
      } catch (error) {
        opts.permissionProfile = previous;
        permissionBriefDirty = previousBriefDirty;
        injectedPermissionBrief = previousInjectedBrief;
        try { await stopConnection(); } catch {}
        restartPromise = Promise.resolve();
        throw error;
      }
    },
    async setExecutionMode(mode) {
      if (starting || turnOpen) throw new Error('Execution mode can only change between turns');
      validateExecutionMode(mode);
      if (fallback) {
        if (nativeProviderInteractionMode({ ...opts, ...mode }) === 'plan') {
          throw new CodexAppServerUnavailableError('Codex native Plan mode is unavailable while using legacy exec');
        }
        return fallback.setExecutionMode(mode);
      }
      cancelIdleRelease();
      const previous = {
        workflow: opts.workflow,
        phase: opts.phase,
        capabilityEpoch: opts.capabilityEpoch,
        chatPermissionGrants: chatPermissionGrantsFor(opts),
        permissionBriefDirty,
        injectedPermissionBrief,
      };
      opts.workflow = mode.workflow;
      opts.phase = mode.phase;
      opts.capabilityEpoch = mode.capabilityEpoch;
      opts.chatPermissionGrants = chatPermissionGrantsFor(mode, opts);
      permissionBriefDirty ||= JSON.stringify(previous.chatPermissionGrants) !== JSON.stringify(opts.chatPermissionGrants);
      permissionBriefDirty ||= injectedPermissionBrief !== null
        && injectedPermissionBrief !== systemBriefFor(opts, 'codex');
      // Preserve an earlier permission-change shutdown barrier. Replacing the
      // promise here lets two stopConnection calls race over the same child.
      const priorRestart = restartPromise;
      restartPromise = priorRestart.then(() => stopConnection());
      try {
        const cleaned = await restartPromise;
        if (!cleaned) {
          throw new CodexAppServerUnavailableError('Codex app-server process tree cleanup could not be confirmed');
        }
        if (nativeProviderInteractionMode(opts) === 'plan' || (permissionBriefDirty && threadId)) {
          const connection = await ensureConnection();
          await attachThread(connection);
          scheduleIdleRelease();
        }
      } catch (error) {
        opts.workflow = previous.workflow;
        opts.phase = previous.phase;
        opts.capabilityEpoch = previous.capabilityEpoch;
        opts.chatPermissionGrants = previous.chatPermissionGrants;
        permissionBriefDirty = previous.permissionBriefDirty;
        injectedPermissionBrief = previous.injectedPermissionBrief;
        try { await stopConnection(); } catch {}
        restartPromise = Promise.resolve();
        throw error;
      }
    },
    interrupt() {
      if (fallback) return fallback.interrupt();
      if (disposed) return;
      interruptRequested = true;
      abortQuestions(Object.assign(new Error('Codex turn interrupted'), { code: 'USER_STOP' }));
      if (turnOpen) {
        if (threadId && activeTurnId && rpc && !rpc.closed) {
          rpc.request('turn/interrupt', { threadId, turnId: activeTurnId }).catch(() => {});
        }
        const priorRestart = restartPromise;
        restartPromise = priorRestart.then(() => stopConnection());
        endTurn({ type: 'turn-end', agent: 'codex', stopReason: 'interrupted' });
      } else if (starting) {
        turnAttempt += 1;
        starting = false;
        pendingTurnStart = null;
        onEvent({ type: 'turn-end', agent: 'codex', stopReason: 'interrupted' });
        const priorRestart = restartPromise;
        restartPromise = priorRestart.then(() => stopConnection());
      }
    },
    async dispose() {
      disposed = true;
      cancelIdleRelease();
      starting = false;
      turnOpen = false;
      abortQuestions(Object.assign(new Error('Codex session disposed'), { code: 'PROVIDER_DISCONNECTED' }));
      rolloutWatcher?.stop();
      rolloutWatcher = null;
      if (fallback) return fallback.dispose();
      await restartPromise;
      return stopConnection();
    },
  };
}
