// cross-spawn: Windows에서 npm .cmd 심을 인자 이스케이프 손상 없이 실행한다.
import spawn from 'cross-spawn';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { toolProfileForPhase } from '../planning-state.mjs';
import {
  createLineReader,
  isPlanningRestricted,
  mcpCapabilityEnv,
  normalizeExecutionMode,
  providerReadOnlyRoots,
  redactDiagnosticText,
  truncate,
  validateExecutionMode,
  isSafeSessionId,
} from './backend.mjs';
import {
  availableReadOnlyBuiltins,
  piSystemPromptFor,
  piToolSelection,
} from './pi-prompt.mjs';
import { piResourceArgs } from '../pi/resources.mjs';
import { applyManagedCliLaunch } from '../npm-cli-launch.mjs';
import { tapProviderProcess } from '../provider-transcript.mjs';
import {
  PROCESS_TREE_CLEANUP_OUTCOME,
  processTreeCleanupOutcome,
  processTreeSpawnOptions,
  terminateProcessTree,
  waitForProcessTreeExit,
} from '../process-tree.mjs';

const STDERR_TAIL_LIMIT = 16_000;
/** 계획 단계에서 막는 pi 내장 도구. 확장 도구(rhwp)는 그대로 남는다. */
const PLANNING_EXCLUDED_TOOLS = 'bash,edit,write';
const SAFE_EXCLUDED_TOOLS = 'bash';
const SAFE_WORKER_EXCLUDED_TOOLS = 'bash,edit,write';
const SPAWN_TOOL = 'subagent_spawn';
const WAIT_TOOL = 'subagent_wait';
const CANCEL_TOOL = 'subagent_cancel';

/**
 * 자식에게 넘겨줄 환경변수 화이트리스트. 여기 없는 값은 전달하지 않는다 —
 * 앰비언트 *_API_KEY 가 남아 있으면 pi 가 우리가 설정하지 않은 provider 를
 * 추가로 붙여버린다(검증됨).
 */
const ENV_PASSTHROUGH = [
  'PATH', 'HOME', 'SHELL', 'LANG', 'LC_ALL', 'TMPDIR',
  // Windows 에서 cross-spawn/셸이 요구하는 값들.
  'SystemRoot', 'ComSpec', 'PATHEXT', 'APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'TEMP', 'TMP',
];

/** 화이트리스트에 실수로 자격증명이 섞여도 걸러낸다. */
const CREDENTIAL_NAME = /(API_KEY|AUTH_TOKEN|OAUTH_TOKEN|SECRET|ACCESS_KEY|BEARER)/i;
/** 오류 문자열에서 API 키처럼 보이는 토큰을 지운다. */
const CREDIT_ERROR = /(?:\b402\b|payment required|insufficient (?:credits|quota)|credit(?:s)? (?:exhausted|depleted|exceeded)|out of credits)/i;

export function isOpenRouterCreditError(text) {
  return CREDIT_ERROR.test(String(text ?? ''));
}

export function formatOpenRouterCreditError(text) {
  if (!isOpenRouterCreditError(text)) return null;
  return 'OpenRouter 크레딧이 부족합니다.';
}

/**
 * @typedef {import('./backend.mjs').BackendOptions & {
 *   piBin?: string,
 *   piRoot?: string,
 *   openRouterApiKey?: string,
 *   reasoning?: boolean,
 * }} PiBackendOptions
 *
 * piBin  — pi 실행 파일 경로(`<piRoot>/prefix/node_modules/.bin/pi`).
 * piRoot — 영속 pi 루트. 에이전트 디렉터리는 `<piRoot>/agent`, 세션은 `<piRoot>/sessions`.
 * model  — provider 접두사 없는 OpenRouter 모델 id. argv 에서 `openrouter/` 를 붙인다.
 * effort — 추론 강도(low|medium|high) 또는 null.
 * reasoning — 선택한 모델이 thinking 을 지원하는지 여부.
 */

/** 계획 단계에서는 확장 도구 목록도 좁혀야 하므로 phase 기준으로 다시 계산한다. */
function toolProfileFor(opts) {
  const { workflow, phase } = normalizeExecutionMode(opts);
  return workflow === 'direct' ? 'direct' : toolProfileForPhase(phase);
}

/**
 * pi CLI 인자를 만든다. 프롬프트는 argv가 아니라 stdin으로 전달한다.
 *
 * @param {PiBackendOptions} opts
 * @param {string} sessionId
 * @param {NodeJS.ProcessEnv} [env] PATH 를 읽는 환경
 * @param {{ systemPromptPath?: string | null }} [options] 시스템 프롬프트를 담은 파일. pi 는
 *   --system-prompt 값이 있는 파일 경로면 그 내용을 읽는다 — 긴 프롬프트가 명령줄 한계를 쓰지 않게 한다.
 */
export function buildPiArgv(opts, sessionId, env = process.env, { systemPromptPath = null } = {}) {
  const piRoot = opts.piRoot ?? '';
  const modelId = String(opts.model ?? '').replace(/^openrouter\//, '');
  const argv = ['--mode', 'json', '--model', `openrouter/${modelId}`];
  // thinking 은 추론 모델에서만 유효하다. 나머지는 요청 자체가 거부된다.
  if (opts.reasoning && opts.effort) argv.push('--thinking', String(opts.effort));
  argv.push(
    '--session-dir', path.join(piRoot, 'sessions'),
    '--session-id', sessionId,
    // Pi 의 코딩 어시스턴트 기본 프롬프트(도구 목록·규칙·Pi 문서 절)를 통째로 대체한다.
    '--system-prompt', systemPromptPath ?? piSystemPromptFor(opts),
    // 앱 번들의 확장·스킬만 싣고 사용자 Pi 설정과 워크스페이스의 AGENTS.md/.pi 는 읽지 않는다.
    ...piResourceArgs(),
    '--tools', piToolSelection(availableReadOnlyBuiltins({
      pathEnv: env.PATH ?? '',
      binDir: path.join(piRoot, 'agent', 'bin'),
    })),
  );
  // Safe Pi has no OS write sandbox. Never expose its general shell: even
  // a hub-private sibling path is writable by the same OS user. Background
  // copy-layout work uses the structured hub runner instead.
  if (isPlanningRestricted(opts)) argv.push('--exclude-tools', PLANNING_EXCLUDED_TOOLS);
  else if (opts.toolProfile === 'copy-layout-worker') argv.push('--exclude-tools', SAFE_WORKER_EXCLUDED_TOOLS);
  else if (opts.permissionProfile !== 'unrestricted') argv.push('--exclude-tools', SAFE_EXCLUDED_TOOLS);
  return argv;
}

/**
 * 이번 스폰의 시스템 프롬프트를 세션 폴더의 파일로 쓴다. 18K자 안팎의 프롬프트를 argv 에 싣지
 * 않으므로 Windows 명령줄 32,767자 한계와 무관해진다. 쓰지 못하면 null — argv 에 글을 그대로 싣는다.
 *
 * @param {PiBackendOptions} opts
 * @param {string} sessionId
 * @returns {string | null}
 */
export function writeSystemPromptFile(opts, sessionId) {
  if (!opts.piRoot) return null;
  try {
    // pi-manager 가 세션 폴더를 만든다. 없으면 설치되지 않은 루트이므로 만들지 않는다.
    const dir = path.join(opts.piRoot, 'sessions');
    if (!fs.statSync(dir).isDirectory()) return null;
    const file = path.join(dir, `${sessionId}.system-prompt.md`);
    fs.writeFileSync(file, piSystemPromptFor(opts), { mode: 0o600 });
    return file;
  } catch {
    return null;
  }
}

/**
 * 자식 프로세스 환경을 처음부터 조립한다(앰비언트 상속 없음).
 *
 * @param {PiBackendOptions} opts
 * @param {NodeJS.ProcessEnv} [sourceEnv]
 */
export function buildPiEnv(opts, sourceEnv = process.env) {
  /** @type {Record<string, string>} */
  const env = {};
  for (const name of ENV_PASSTHROUGH) {
    const value = sourceEnv[name];
    if (typeof value !== 'string' || CREDENTIAL_NAME.test(name)) continue;
    env[name] = value;
  }
  if (opts.isolatedHome) {
    env.HOME = String(opts.isolatedHome);
    env.USERPROFILE = String(opts.isolatedHome);
  }
  const piRoot = opts.piRoot ?? '';
  const readOnlyRoots = providerReadOnlyRoots(opts);
  return {
    ...env,
    PI_CODING_AGENT_DIR: path.join(piRoot, 'agent'),
    ...(opts.openRouterApiKey ? { OPENROUTER_API_KEY: String(opts.openRouterApiKey) } : {}),
    // 버전 확인/카탈로그 갱신 같은 기동 시 네트워크 동작을 끈다.
    PI_OFFLINE: '1',
    PI_TELEMETRY: '0',
    RHWP_WS_URL: `ws://127.0.0.1:${opts.hubPort}/mcp`,
    RHWP_AGENT_TOKEN: String(opts.token ?? ''),
    RHWP_AGENT_NAME: 'pi',
    RHWP_HUB_HTTP: `http://127.0.0.1:${opts.hubPort}`,
    RHWP_ROOT_DIR: String(opts.rootDir ?? ''),
    ...(readOnlyRoots.length > 0 ? { RHWP_READONLY_ROOTS: readOnlyRoots.join(path.delimiter) } : {}),
    RHWP_PERMISSION_PROFILE: opts.permissionProfile ?? 'safe',
    RHWP_TOOL_PROFILE: toolProfileFor(opts),
    RHWP_PI_BIN: String(opts.piBin ?? 'pi'),
    RHWP_PI_MODEL: String(opts.model ?? ''),
    ...(opts.effort ? { RHWP_PI_EFFORT: String(opts.effort) } : {}),
    ...(opts.reasoning ? { RHWP_PI_REASONING: '1' } : {}),
    RHWP_PI_SESSION_DIR: path.join(piRoot, 'sessions'),
    ...mcpCapabilityEnv(opts),
  };
}

function fleetStatusFromWait(status) {
  return ['completed', 'failed', 'stopped'].includes(status) ? status : null;
}

function waitRecordsFromResult(result) {
  const records = result && typeof result === 'object' ? result?.details?.records : null;
  if (!Array.isArray(records)) return [];
  return records.slice(0, 64).flatMap((entry) => {
    if (!entry || typeof entry.id !== 'string' || !/^sa-[1-9][0-9]{0,8}$/.test(entry.id)) return [];
    const status = fleetStatusFromWait(entry.status);
    return status ? [{ id: entry.id, status }] : [];
  });
}

function toolResultText(result) {
  if (typeof result === 'string') return result;
  if (typeof result?.message === 'string') return result.message;
  if (Array.isArray(result?.content)) {
    return result.content.map((block) => String(block?.text ?? '')).join('\n');
  }
  return JSON.stringify(result ?? '');
}

function spawnIdFromToolResult(result) {
  const direct = result?.details?.id ?? result?.id;
  if (typeof direct === 'string' && /^sa-\d+$/.test(direct)) return direct;
  return toolResultText(result).match(/sa-\d+/)?.[0] ?? null;
}

/** Map Pi extension subagent tools onto the unified task-card event stream. */
export function createPiFleetMapper(onEvent) {
  const agent = 'pi';
  const taskIdBySubagent = new Map();
  const callMeta = new Map();
  const running = new Set();

  function emitEnd(taskId, status, summary) {
    if (!running.delete(taskId)) return;
    onEvent({ type: 'task-end', agent, taskId, status, ...(summary ? { summary } : {}) });
  }

  function idsFrom(callId, fallback = {}) {
    const args = callMeta.get(callId)?.args ?? fallback;
    return Array.isArray(args?.ids)
      ? args.ids.slice(0, 64).map(String).filter((id) => /^sa-[1-9][0-9]{0,8}$/.test(id))
      : [];
  }

  function taskIdsFor(ids) {
    return ids.map((id) => taskIdBySubagent.get(id)).filter(Boolean);
  }

  return {
    onToolStart(event) {
      const tool = String(event?.toolName ?? '');
      const callId = String(event?.toolCallId ?? '');
      const args = event?.args && typeof event.args === 'object' ? event.args : {};
      callMeta.set(callId, { tool, args });
      if (tool === SPAWN_TOOL) {
        running.add(callId);
        onEvent({
          type: 'task-start',
          agent,
          taskId: callId,
          callId,
          title: truncate(String(args.name ?? args.title ?? 'subagent'), 159),
          ...(args.role ? { role: truncate(String(args.role), 63) } : {}),
          taskKind: 'agent',
        });
      } else if (tool === WAIT_TOOL) {
        for (const taskId of taskIdsFor(idsFrom(callId, args))) {
          onEvent({ type: 'task-progress', agent, taskId, activity: 'waiting' });
        }
      }
    },
    onToolEnd(event) {
      const callId = String(event?.toolCallId ?? '');
      const meta = callMeta.get(callId);
      const tool = String(event?.toolName ?? meta?.tool ?? '');
      const args = meta?.args ?? {};
      callMeta.delete(callId);
      if (tool === SPAWN_TOOL) {
        const subagentId = spawnIdFromToolResult(event?.result);
        if (subagentId) {
          while (taskIdBySubagent.size >= 64) {
            taskIdBySubagent.delete(taskIdBySubagent.keys().next().value);
          }
          taskIdBySubagent.set(subagentId, callId);
        }
        if (event?.isError) emitEnd(callId, 'failed', truncate(toolResultText(event.result), 1_199));
        return;
      }
      if (tool === WAIT_TOOL) {
        if (event?.isError && /Wait aborted\. Subagents keep running/.test(toolResultText(event.result))) return;
        const records = waitRecordsFromResult(event?.result);
        if (records.length > 0) {
          for (const record of records) {
            const taskId = taskIdBySubagent.get(record.id);
            if (taskId) emitEnd(taskId, record.status);
          }
          return;
        }
        const ids = idsFrom(callId, args);
        for (const taskId of taskIdsFor(ids.length > 0 ? ids : [...taskIdBySubagent.keys()])) {
          emitEnd(taskId, event?.isError ? 'failed' : 'completed');
        }
        return;
      }
      if (tool === CANCEL_TOOL) {
        for (const taskId of taskIdsFor(idsFrom(callId, args))) {
          emitEnd(taskId, event?.isError ? 'failed' : 'stopped');
        }
      }
    },
    finalize(status = 'stopped') {
      for (const taskId of [...running]) emitEnd(taskId, status);
    },
  };
}

/**
 * CLI stderr 를 사용자에게 보여줄 짧은 이유로 바꾼다. 세션 토큰과 키처럼 보이는
 * 문자열은 지운다.
 *
 * @param {string} stderrText
 * @param {number | null} code
 * @param {NodeJS.Signals | null} signal
 * @param {string} token
 */
export function formatPiExitError(stderrText, code, signal, token) {
  const credit = formatOpenRouterCreditError(stderrText);
  if (credit) return credit;
  const clean = redactDiagnosticText(stderrText, [token]);
  const detail = clean
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/^Usage:/i.test(line) && !/^For more information/i.test(line))
    .slice(-8)
    .join('\n');
  const exit = signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`;
  return detail
    ? `Pi 실행이 중단되었습니다 (${exit}).\n${truncate(detail, 1200)}`
    : `Pi 실행이 중단되었습니다 (${exit}). Pi가 오류 설명을 제공하지 않았습니다.`;
}

/**
 * pi usage 는 {input,output,cacheRead,cacheWrite,reasoning,cost:{total}} 모양이라
 * 공용 normalizeUsageTokens 로는 읽히지 않는다. 여기서 직접 정규화한다.
 *
 * @param {any} raw
 * @returns {{ usage: import('./backend.mjs').UsageTokens, costUsd: number } | null}
 */
/**
 * `--session-id` 로 이어 쓸 세션 파일(`<piRoot>/sessions/<시각>_<id>.jsonl`)을 찾는다. Pi 1.1.0 은
 * --session-dir 아래에서 헤더의 cwd 가 같은 파일만 연다 (없으면 같은 id 로 빈 세션을 새로 만든다).
 *
 * @returns {string | null}
 */
export function findPiSessionFileSync(opts, sessionId) {
  if (!opts.piRoot || !isSafeSessionId(sessionId)) return null;
  const dir = path.join(opts.piRoot, 'sessions');
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return null;
  }
  // Pi 는 process.cwd()(실경로)와 비교한다 — /var → /private/var 같은 링크를 풀어 둔다.
  const cwds = new Set([path.resolve(String(opts.rootDir ?? ''))]);
  try { cwds.add(fs.realpathSync(String(opts.rootDir ?? ''))); } catch {}
  for (const name of names) {
    if (!name.endsWith(`_${sessionId}.jsonl`)) continue;
    const file = path.join(dir, name);
    let fd;
    try {
      fd = fs.openSync(file, 'r');
      const buffer = Buffer.alloc(16 * 1024);
      const bytes = fs.readSync(fd, buffer, 0, buffer.length, 0);
      const header = JSON.parse(buffer.subarray(0, bytes).toString('utf8').split('\n')[0]);
      if (header?.type === 'session' && header.id === sessionId
        && typeof header.cwd === 'string' && cwds.has(path.resolve(header.cwd))) return file;
    } catch {
      // 읽지 못한 파일은 재개 대상이 아니다.
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }
  return null;
}

export async function canResumePiSession(opts, sessionId) {
  return findPiSessionFileSync(opts, sessionId) !== null;
}

/** Pi 가 맥락 크기로 세는 값 — 마지막 호출의 totalTokens, 없으면 네 칸의 합. */
function piContextTokens(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const total = Number(raw.totalTokens);
  if (Number.isFinite(total) && total > 0) return Math.round(total);
  const sum = ['input', 'output', 'cacheRead', 'cacheWrite']
    .reduce((acc, key) => acc + (Number(raw[key]) > 0 ? Number(raw[key]) : 0), 0);
  return sum > 0 ? Math.round(sum) : null;
}

function finitePiTokens(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : undefined;
}

function normalizePiUsage(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const count = (value) => {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
  };
  const usage = {
    inputTokens: count(raw.input),
    outputTokens: count(raw.output),
    cacheReadTokens: count(raw.cacheRead),
    cacheCreationTokens: count(raw.cacheWrite),
  };
  const cost = Number(raw.cost?.total);
  const costUsd = Number.isFinite(cost) && cost > 0 ? cost : 0;
  const tokens = usage.inputTokens + usage.outputTokens
    + usage.cacheReadTokens + usage.cacheCreationTokens;
  // 값이 전부 0 이면(예: 401 로 끝난 턴) 기록할 것이 없다.
  return tokens > 0 || costUsd > 0 ? { usage, costUsd } : null;
}

/**
 * @param {PiBackendOptions} opts
 * @returns {import('./backend.mjs').AgentSession}
 */
export function createPiSession(opts, {
  spawnProcess = spawn,
  terminateProcess = terminateProcessTree,
  waitForExit = waitForProcessTreeExit,
  closeGraceMs = 2_000,
  platform = process.platform,
  nodeCommand = process.execPath,
} = {}) {
  const onEvent = opts.onEvent;

  const agent = 'pi';

  // pi 세션 id 는 우리가 발급한다. 첫 스폰은 세션 파일을 만들고(“creating a new
  // session” 경고가 stderr 에 찍힌다) 이후 스폰은 같은 파일을 이어 쓴다.
  // 재개 커서로 시작하면 그 파일을 이어 쓴다 — 첫 스폰 직전에 파일이 남아 있는지 다시 본다.
  let sessionId = isSafeSessionId(opts.resumeSessionId) ? opts.resumeSessionId : crypto.randomUUID();
  let resumeUnverified = sessionId === opts.resumeSessionId;
  let turnResumeLost = false;
  let lastContextTokens = null;
  let compactionSeq = 0;
  /** @type {{ compactionId: string, trigger: 'auto'|'manual', beforeTokens?: number } | null} */
  let activeCompaction = null;
  /** @type {import('node:child_process').ChildProcess | null} */
  let child = null;
  let turnOpen = false;
  let turnCompleted = false;
  let turnFailureMessage = null;
  /**
   * 프로세스를 띄우거나 돌리지 못한 턴의 실패 단서 (spawn 'error': ENOENT 면 cli_missing). 오류는
   * 턴이 정착할 때 한 번만 이 단서와 함께 알린다.
   * @type {{ source: 'pi', code: 'cli_missing' | 'process_exit' } | null}
   */
  let turnProcessFailure = null;
  /**
   * 마지막 assistant 시도의 API 오류. Pi 는 실패한 시도마다 message_end 를 보낸 뒤에야 자동
   * 재시도(auto_retry_*)나 압축 복구를 정한다 — 다음 시도가 정상으로 끝나면 지워지고, 턴이
   * 정착할 때 남아 있으면 그때 실패로 확정한다.
   * @type {string | null}
   */
  let lastAttemptError = null;
  let disposed = false;
  let stderrTail = '';
  let childExitPromise = Promise.resolve(true);
  let resolveChildExit = null;
  /** @type {(reason?: 'forced'|'queue') => Promise<boolean>} */
  let stopChild = () => Promise.resolve(true);
  let beginTerminalCleanup = () => Promise.resolve(true);
  let suppressChildOutput = () => {};
  let uncertainTreeCleanup = false;
  /** @type {{ text: string } | null} */
  let queuedTurn = null;
  const fleet = createPiFleetMapper(onEvent);

  function endTurn(evt) {
    if (!turnOpen) return;
    turnOpen = false;
    activeCompaction = null;
    fleet.finalize(evt?.stopReason === 'failed' ? 'failed' : 'stopped');
    const lost = turnResumeLost;
    turnResumeLost = false;
    onEvent(lost ? { ...evt, resumeLost: true } : evt);
  }

  function emitContextUsage() {
    if (lastContextTokens === null) return;
    const window = Number(opts.contextWindow);
    onEvent({
      type: 'context-usage',
      agent,
      usedTokens: lastContextTokens,
      ...(Number.isFinite(window) && window > 0 ? { maxTokens: Math.round(window) } : {}),
      autoCompact: true,
    });
  }

  function compactionEvent(compaction, phase, extra = {}) {
    return {
      type: 'compaction',
      agent,
      compactionId: compaction.compactionId,
      phase,
      trigger: compaction.trigger,
      ...(compaction.beforeTokens !== undefined ? { beforeTokens: compaction.beforeTokens } : {}),
      ...extra,
    };
  }

  function makeHandler() {
    return (e) => {
      if (disposed) return; // 폐기 후 죽어가는 CLI 가 흘리는 stdout 은 무시한다.
      const type = e?.type;
      if (type === 'session') {
        if (e.id) {
          sessionId = String(e.id);
          onEvent({
            type: 'session-info',
            agent,
            sessionId,
            model: opts.model ?? undefined,
          });
        }
        return;
      }
      if (type === 'message_update') {
        // thinking_*/toolcall_* 델타는 흘리지 않는다. 도구는 tool_execution_* 로 본다.
        const sub = e.assistantMessageEvent;
        if (sub?.type === 'text_delta' && sub.delta) {
          onEvent({ type: 'text-delta', agent, text: String(sub.delta) });
        }
        return;
      }
      if (type === 'compaction_start') {
        // reason: manual | threshold | overflow (Pi 1.1.0 json.md).
        activeCompaction = {
          compactionId: `pi:${sessionId}:${Date.now().toString(36)}:${++compactionSeq}`,
          trigger: e.reason === 'manual' ? 'manual' : 'auto',
          ...(lastContextTokens !== null ? { beforeTokens: lastContextTokens } : {}),
        };
        onEvent(compactionEvent(activeCompaction, 'started'));
        return;
      }
      if (type === 'compaction_end') {
        const compaction = activeCompaction ?? {
          compactionId: `pi:${sessionId}:${Date.now().toString(36)}:${++compactionSeq}`,
          trigger: e.reason === 'manual' ? 'manual' : 'auto',
        };
        activeCompaction = null;
        const result = e.result;
        if (result && !e.aborted) {
          const beforeTokens = finitePiTokens(result.tokensBefore) ?? compaction.beforeTokens;
          const afterTokens = finitePiTokens(result.estimatedTokensAfter);
          onEvent(compactionEvent({ ...compaction, beforeTokens }, 'completed', {
            ...(afterTokens !== undefined ? { afterTokens } : {}),
          }));
          if (afterTokens !== undefined) {
            lastContextTokens = afterTokens;
            emitContextUsage();
          }
        } else {
          const message = e.aborted ? 'Compaction was aborted' : String(e.errorMessage ?? 'Compaction failed');
          onEvent(compactionEvent(compaction, 'failed', { message: truncate(message, 500) }));
        }
        return;
      }
      if (type === 'message_end') {
        const message = e.message ?? {};
        if (message.role !== 'assistant') return;
        const contextTokens = piContextTokens(message.usage);
        if (contextTokens !== null) {
          lastContextTokens = contextTokens;
          emitContextUsage();
        }
        const usage = normalizePiUsage(message.usage);
        if (usage) {
          onEvent({
            type: 'usage',
            agent,
            model: opts.model ?? null,
            usage: usage.usage,
            costUsd: usage.costUsd,
          });
        }
        // json 모드의 API 오류는 종료 코드 0 으로 끝난다. 이유는 여기에만 있다. 바로 실패로
        // 보내지 않는다 — Pi 가 이 시도를 스스로 다시 할 수 있다.
        lastAttemptError = message.stopReason === 'error'
          ? String(message.errorMessage ?? 'pi turn failed')
          : null;
        return;
      }
      if (type === 'auto_retry_end') {
        if (e.success === false) {
          lastAttemptError = typeof e.finalError === 'string' && e.finalError ? e.finalError : lastAttemptError;
        }
        return;
      }
      if (type === 'tool_execution_start') {
        fleet.onToolStart(e);
        onEvent({
          type: 'tool-call',
          agent,
          callId: String(e.toolCallId ?? ''),
          tool: String(e.toolName ?? 'tool'),
          argsJson: JSON.stringify(e.args ?? {}),
        });
        return;
      }
      if (type === 'tool_execution_end') {
        fleet.onToolEnd(e);
        onEvent({
          type: 'tool-result',
          agent,
          callId: String(e.toolCallId ?? ''),
          ok: !e.isError,
          resultPreview: truncate(JSON.stringify(e.result?.content ?? e.result ?? null)),
        });
        return;
      }
      if (type === 'agent_settled') {
        // 완료 신호는 agent_end 가 아니라 agent_settled 다 — agent_end 뒤에도
        // 자동 재시도/압축이 이어질 수 있다.
        turnCompleted = true;
        void beginTerminalCleanup();
        return;
      }
      if (type === 'error') {
        onEvent({ type: 'error', agent, message: String(e.message ?? 'unknown error') });
      }
    };
  }

  function killChild() {
    return stopChild('forced');
  }

  const session = {
    agent,
    getSessionId() {
      return sessionId;
    },
    // json 모드는 /compact 를 처리하지 않는다 (대화형 전용 명령). 자동 압축은 compaction_* 로 보인다.
    compactionSupport: 'auto-only',
    canResume(id) {
      return canResumePiSession(opts, id);
    },
    sendUserMessage(text, options = {}) {
      if (disposed) return;
      if (turnOpen || queuedTurn) throw new Error('Pi already has a turn in progress');
      if (uncertainTreeCleanup) {
        turnOpen = true;
        turnCompleted = false;
        turnFailureMessage = null;
        turnProcessFailure = null;
        lastAttemptError = null;
        onEvent({
          type: 'error',
          agent,
          message: 'Pi process-tree cleanup remains unconfirmed; start a new isolated session',
        });
        endTurn({ type: 'turn-end', agent, stopReason: 'failed' });
        return;
      }
      if (child) {
        const queued = { text, options };
        queuedTurn = queued;
        const ownership = childExitPromise;
        void stopChild('queue');
        void ownership.then((cleaned) => {
          if (queuedTurn !== queued) return;
          queuedTurn = null;
          if (disposed) return;
          if (cleaned && !child) {
            session.sendUserMessage(queued.text, queued.options);
            return;
          }
          turnOpen = true;
          turnCompleted = false;
          turnFailureMessage = null;
          turnProcessFailure = null;
          lastAttemptError = null;
          const message = 'Pi process tree cleanup could not be confirmed before the next turn';
          onEvent({ type: 'error', agent, message });
          endTurn({ type: 'turn-end', agent, stopReason: 'exited' });
        }, () => {
          if (queuedTurn !== queued) return;
          queuedTurn = null;
          if (disposed) return;
          turnOpen = true;
          turnCompleted = false;
          turnFailureMessage = null;
          turnProcessFailure = null;
          lastAttemptError = null;
          onEvent({
            type: 'error',
            agent,
            message: 'Pi process tree cleanup could not be confirmed before the next turn',
          });
          endTurn({ type: 'turn-end', agent, stopReason: 'exited' });
        });
        return;
      }
      turnOpen = true;
      turnCompleted = false;
      turnFailureMessage = null;
      turnProcessFailure = null;
      lastAttemptError = null;
      onEvent({ type: 'turn-start', agent });

      if (options.replaceSession) {
        // 허브가 이 세션의 기록 전달을 믿지 않는다 — 새 세션 id 로 전체 기록을 보낸다.
        resumeUnverified = false;
        turnResumeLost = true;
        sessionId = crypto.randomUUID();
        lastContextTokens = null;
      } else if (resumeUnverified) {
        resumeUnverified = false;
        if (!findPiSessionFileSync(opts, sessionId)) {
          // 이어 쓸 파일이 사라졌다. Pi 는 같은 id 로 빈 세션을 만들 뿐이라 여기서 알아챈다.
          turnResumeLost = true;
          sessionId = crypto.randomUUID();
          lastContextTokens = null;
          if (typeof options.resumeFallbackText === 'string' && options.resumeFallbackText) {
            text = options.resumeFallbackText;
          }
        }
      }

      if (!opts.model) {
        const failure = { source: 'pi', code: 'PI_MODEL_MISSING' };
        onEvent({ type: 'error', agent, message: 'Pi 모델이 선택되지 않았습니다.', failure });
        endTurn({ type: 'turn-end', agent, stopReason: 'exited', failure });
        return;
      }

      // 시스템 프롬프트는 --system-prompt 로 매 스폰마다 새로 정한다(모드가 바뀌면 함께 바뀐다).
      // 프롬프트는 stdin 으로 넘긴다. argv 로 넘기면 Linux 의 인자당 128 KiB,
      // Windows 의 명령줄 32,767자 한계에 걸리고 '-'/'@' 로 시작하는 메시지가
      // 플래그나 첨부 파일로 파싱된다.
      const argv = buildPiArgv(opts, sessionId, process.env, {
        systemPromptPath: writeSystemPromptFile(opts, sessionId),
      });
      stderrTail = '';

      let proc;
      try {
        const spawnEnv = buildPiEnv(opts);
        const launched = applyManagedCliLaunch(opts.piBin ?? 'pi', argv, {
          platform, nodeCommand, env: spawnEnv,
        });
        proc = tapProviderProcess(spawnProcess(launched.command, launched.argv, {
          ...processTreeSpawnOptions(),
          cwd: opts.rootDir,
          env: launched.env,
          // json 모드는 stdin 이 닫힐 때까지 읽는다. 프롬프트를 쓰고 바로 닫는다.
          stdio: ['pipe', 'pipe', 'pipe'],
        }), {
          agent, transport: 'json', stdin: 'text', argv: launched.argv, env: launched.env,
          secrets: [opts.token, opts.openRouterApiKey], cli: opts.providerCliVersion, platform,
        });
      } catch (e) {
        const failure = { source: 'pi', code: e?.code === 'ENOENT' ? 'cli_missing' : 'process_exit' };
        onEvent({
          type: 'error',
          agent,
          message: `failed to start pi: ${redactDiagnosticText(e?.message ?? e, [opts.token, opts.openRouterApiKey])}`,
          failure,
        });
        endTurn({ type: 'turn-end', agent, stopReason: 'exited', failure });
        return;
      }
      child = proc;
      childExitPromise = new Promise((resolve) => { resolveChildExit = resolve; });
      const readStdout = createLineReader(makeHandler());
      let outputEnded = false;
      let readerEnded = false;
      let acceptOutput = true;
      let cleanupSettled = false;
      let cleanupOutcome = PROCESS_TREE_CLEANUP_OUTCOME.FAILED;
      let drainedClose = false;
      let completedAtDrain = false;
      let forcedCleanup = false;
      /** @type {{ code: number|null, signal: NodeJS.Signals|null } | null} */
      let exitInfo = null;
      /** @type {ReturnType<typeof setTimeout> | null} */
      let closeGraceTimer = null;
      const closeOutputReader = (flush) => {
        if (readerEnded) return;
        readerEnded = true;
        acceptOutput = false;
        if (flush) readStdout.end();
        else readStdout.discard();
      };
      const discardOutputReader = () => closeOutputReader(false);
      const finishOutput = (flush) => {
        if (outputEnded) return;
        outputEnded = true;
        if (closeGraceTimer) {
          clearTimeout(closeGraceTimer);
          closeGraceTimer = null;
        }
        closeOutputReader(flush);
      };
      const endOutput = () => finishOutput(true);
      const discardOutput = () => finishOutput(false);
      suppressChildOutput = () => {
        if (proc === child) discardOutput();
      };
      const finishOwnership = () => {
        if (!outputEnded || !cleanupSettled) return;
        const proven = cleanupOutcome === PROCESS_TREE_CLEANUP_OUTCOME.PROVEN;
        const naturalDrainedRelease = cleanupOutcome === PROCESS_TREE_CLEANUP_OUTCOME.UNAVAILABLE
          && drainedClose
          && completedAtDrain
          && exitInfo?.code === 0
          && !forcedCleanup;
        const released = proven || naturalDrainedRelease;
        if (released && proc === child) {
          child = null;
          beginTerminalCleanup = () => Promise.resolve(true);
        }
        resolveChildExit?.(proven);
        resolveChildExit = null;
      };
      const settleOutput = (code, signal, fromClose) => {
        if (proc !== child || outputEnded) return;
        drainedClose = fromClose;
        exitInfo ??= { code, signal };
        if (fromClose) endOutput();
        else discardOutput();
        completedAtDrain = fromClose && turnCompleted;
        if (turnOpen && !disposed) {
          turnFailureMessage ??= lastAttemptError;
          if (turnFailureMessage && turnProcessFailure) {
            // Pi 를 띄우거나 돌리지 못했다 (spawn 오류) — 오류는 여기서 한 번, 그 단서와 함께 보낸다.
            const failure = turnProcessFailure;
            onEvent({ type: 'error', agent, message: turnFailureMessage, failure });
            endTurn({ type: 'turn-end', agent, stopReason: 'exited', failure });
          } else if (turnFailureMessage) {
            // 재시도로도 회복하지 못한 마지막 시도의 오류 — 한 번만 보낸다.
            const detail = turnFailureMessage;
            const credit = formatOpenRouterCreditError(detail);
            const status = detail.match(/^\s*(\d{3})\b/);
            const failure = {
              source: 'pi',
              ...(status ? { httpStatus: Number(status[1]) } : {}),
              ...(credit ? { code: 'openrouter_credits' } : {}),
            };
            const message = credit ? `${credit}\n${detail}` : detail;
            onEvent({ type: 'error', agent, message, failure });
            endTurn({ type: 'turn-end', agent, stopReason: 'failed', errorMessage: message, failure });
          } else if (!completedAtDrain && code !== 0) {
            const failure = {
              source: 'pi',
              code: isOpenRouterCreditError(stderrTail) ? 'openrouter_credits' : 'process_exit',
            };
            onEvent({
              type: 'error',
              agent,
              message: formatPiExitError(stderrTail, code, signal, opts.token),
              failure,
            });
            endTurn({ type: 'turn-end', agent, stopReason: 'exited', failure });
          } else {
            endTurn({ type: 'turn-end', agent, stopReason: completedAtDrain ? 'completed' : 'exited' });
          }
        }
        void beginCleanup(false);
        finishOwnership();
      };
      const scheduleCloseGrace = (code, signal) => {
        if (outputEnded || closeGraceTimer) return;
        closeGraceTimer = setTimeout(() => {
          closeGraceTimer = null;
          settleOutput(code ?? null, signal ?? null, false);
        }, closeGraceMs);
        closeGraceTimer.unref?.();
      };
      let cleanupPromise = null;
      const beginCleanup = (forced = false) => {
        forcedCleanup ||= forced;
        if (proc !== child) return Promise.resolve(true);
        if (cleanupPromise) return cleanupPromise;
        let resolveCleanup = () => {};
        cleanupPromise = new Promise((resolve) => { resolveCleanup = resolve; });
        let termination;
        let exited;
        try { termination = Promise.resolve(terminateProcess(proc)); } catch { termination = Promise.resolve(false); }
        try { exited = Promise.resolve(waitForExit(proc)); } catch { exited = Promise.resolve(false); }
        void Promise.all([termination, exited]).then(
          ([terminationResult, exitResult]) => processTreeCleanupOutcome(
            terminationResult,
            exitResult,
          ),
          () => PROCESS_TREE_CLEANUP_OUTCOME.FAILED,
        ).then((outcome) => {
          cleanupSettled = true;
          cleanupOutcome = outcome;
          if (outcome !== PROCESS_TREE_CLEANUP_OUTCOME.PROVEN) {
            uncertainTreeCleanup = true;
          }
          if (!outputEnded) {
            scheduleCloseGrace(
              exitInfo?.code ?? proc.exitCode ?? null,
              exitInfo?.signal ?? proc.signalCode ?? null,
            );
          }
          finishOwnership();
          resolveCleanup(outcome === PROCESS_TREE_CLEANUP_OUTCOME.PROVEN);
        });
        return cleanupPromise;
      };
      stopChild = (reason = 'forced') => {
        const forced = reason === 'forced' || (reason === 'queue' && exitInfo === null);
        if (forced) discardOutput();
        return beginCleanup(forced);
      };
      beginTerminalCleanup = () => platform === 'win32'
        ? beginCleanup(false)
        : Promise.resolve(true);
      // 기동 중 종료하면 EPIPE 가 난다. 턴 정리는 exit/close 처리가 맡는다.
      proc.stdin.on('error', (err) => {
        process.stderr.write(`[pi] stdin write error: ${redactDiagnosticText(err?.message ?? err, [opts.token])}\n`);
      });
      proc.stdin.end(text);
      proc.stdout.on('data', (chunk) => {
        if (proc !== child || disposed || !acceptOutput) return;
        readStdout(chunk);
      });
      proc.stderr.on('data', (chunk) => {
        if (proc !== child || disposed || !acceptOutput) return;
        const chunkText = chunk.toString();
        stderrTail = (stderrTail + chunkText).slice(-STDERR_TAIL_LIMIT);
      });
      proc.on('error', (err) => {
        if (proc !== child) return;
        discardOutputReader();
        const safeError = redactDiagnosticText(err?.message ?? err, [opts.token]);
        process.stderr.write(`[pi] spawn error: ${safeError}\n`);
        if (turnOpen) {
          // 여기서 알리지 않는다 — 출력이 닫히며 턴이 정착할 때 이 단서로 한 번만 알린다
          // (없는 CLI 는 설정 열기, 그 밖의 프로세스 오류는 다시 시도).
          turnFailureMessage = `pi process error: ${safeError}`;
          turnProcessFailure = { source: 'pi', code: err?.code === 'ENOENT' ? 'cli_missing' : 'process_exit' };
        }
        void beginCleanup(true);
        scheduleCloseGrace(proc.exitCode ?? null, proc.signalCode ?? null);
      });
      proc.on('exit', (code, signal) => {
        if (proc !== child) return;
        exitInfo = { code, signal };
        void beginCleanup(false);
        scheduleCloseGrace(code, signal);
      });
      proc.on('close', (code, signal) => {
        if (proc !== child) return;
        exitInfo ??= { code: code ?? null, signal: signal ?? null };
        settleOutput(code ?? exitInfo.code ?? null, signal ?? exitInfo.signal ?? null, true);
      });
    },
    setPermissionProfile(profile) {
      if (turnOpen || queuedTurn) throw new Error('Permission profile can only change between turns');
      if (uncertainTreeCleanup) throw new Error('Pi process tree cleanup remains unconfirmed');
      if (profile !== 'safe' && profile !== 'unrestricted') throw new Error(`Unknown permission profile: ${profile}`);
      opts.permissionProfile = profile;
    },
    async setExecutionMode(mode) {
      if (turnOpen || queuedTurn) throw new Error('Execution mode can only change between turns');
      if (uncertainTreeCleanup) throw new Error('Pi process tree cleanup remains unconfirmed');
      validateExecutionMode(mode);
      if (child) killChild();
      if (await childExitPromise === false) {
        throw new Error('Pi process tree could not be stopped for the mode change');
      }
      opts.workflow = mode.workflow;
      opts.phase = mode.phase;
      opts.capabilityEpoch = mode.capabilityEpoch;
    },
    interrupt() {
      queuedTurn = null;
      suppressChildOutput();
      killChild();
      endTurn({ type: 'turn-end', agent, stopReason: 'interrupted' });
    },
    dispose() {
      disposed = true;
      turnOpen = false;
      queuedTurn = null;
      suppressChildOutput();
      // 죽어가는 자식의 stdout 을 아예 파싱하지 않는다.
      try { child?.stdout?.removeAllListeners('data'); } catch {}
      const currentCleanup = killChild();
      return Promise.all([currentCleanup, childExitPromise])
        .then((results) => !uncertainTreeCleanup && results.every((result) => result !== false));
    },
  };
  return session;
}
