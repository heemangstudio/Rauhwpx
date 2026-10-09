// 도구 없이 한 번 묻고 한 번 답을 받는 짧은 LLM 호출입니다.
// 체크포인트 제목과 프로젝트 정리 도우미가 함께 씁니다. 각 시도는 시간 상한 안에서 끝나고,
// CLI 프로세스 트리는 정리가 확인된 뒤에만 작업 폴더를 지웁니다.
import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import spawn from 'cross-spawn';

import { applyManagedCliLaunch } from '../npm-cli-launch.mjs';
import {
  isolatedProcessEnv,
  PROCESS_TREE_CLEANUP_OUTCOME,
  processTreeSpawnOptions,
  terminateAndWaitForProcessTreeExitOutcome,
  terminateProcessTree,
} from '../process-tree.mjs';

export const ONE_SHOT_MAX_CLI_OUTPUT_BYTES = 64 * 1024;
export const ONE_SHOT_DEFAULT_CODEX_MODEL = 'gpt-6-luna';
export const ONE_SHOT_DEFAULT_CLAUDE_MODEL = 'claude-haiku-4-5';

const CODEX_EFFORTS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const CLAUDE_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

/** Tool-free, sandboxed one-shot CLI argv. Codex reads the prompt from stdin (`-`); Claude from stdin with `-p`. */
export function buildOneShotCliSpec(provider, {
  command,
  model,
  effort,
} = {}) {
  if (provider === 'codex') {
    const reasoning = CODEX_EFFORTS.has(effort) ? effort : 'low';
    return {
      provider,
      command: command ?? 'codex',
      argv: [
        'exec', '--json', '--ephemeral', '--skip-git-repo-check',
        '--ignore-user-config', '--ignore-rules',
        '--disable', 'apps', '--disable', 'browser_use', '--disable', 'computer_use',
        '--disable', 'image_generation', '--disable', 'multi_agent', '--disable', 'plugins',
        '--disable', 'skill_search', '--disable', 'shell_tool', '--disable', 'unified_exec',
        '--disable', 'code_mode_host', '--disable', 'standalone_web_search',
        '--disable', 'view_image', '--disable', 'shell_snapshot', '--sandbox', 'read-only',
        '-m', model ?? ONE_SHOT_DEFAULT_CODEX_MODEL, '-c', `model_reasoning_effort="${reasoning}"`, '-',
      ],
      stdin: true,
    };
  }
  if (provider === 'claude') {
    return {
      provider,
      command: command ?? 'claude',
      argv: [
        '-p', '--output-format', 'json', '--setting-sources', '',
        '--disable-slash-commands', '--tools', '', '--permission-mode', 'dontAsk',
        '--model', model ?? ONE_SHOT_DEFAULT_CLAUDE_MODEL,
        '--effort', CLAUDE_EFFORTS.has(effort) ? effort : 'max',
      ],
      stdin: true,
    };
  }
  throw new Error(`Unsupported one-shot CLI provider: ${String(provider)}`);
}

function textFromEvent(event) {
  if (!event || typeof event !== 'object') return null;
  if (event.is_error === true) return null;
  if (typeof event.result === 'string') return event.result;
  if (event.type === 'item.completed' && event.item?.type === 'agent_message') {
    return String(event.item.text ?? event.item.message ?? '');
  }
  if (event.type === 'assistant' && Array.isArray(event.message?.content)) {
    return event.message.content
      .filter((block) => block?.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('');
  }
  return null;
}

/** Final assistant text from Claude `--output-format json` or Codex `exec --json` output. */
export function extractOneShotText(stdout) {
  const text = String(stdout ?? '').trim();
  if (!text) return null;
  try {
    const direct = textFromEvent(JSON.parse(text));
    if (direct !== null) return direct;
  } catch {}

  let last = null;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const candidate = textFromEvent(JSON.parse(line));
      if (candidate !== null) last = candidate;
    } catch {}
  }
  return last;
}

export function hasTerminalOneShotOutput(provider, stdout) {
  for (const line of String(stdout).split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (event?.type === 'result' || event?.is_error === true || event?.type === 'turn.failed') {
        return true;
      }
      if (provider === 'codex'
        && event?.type === 'item.completed'
        && event.item?.type === 'agent_message') return true;
    } catch {}
  }
  return false;
}

function nonEmptyText(value) {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * Run one CLI attempt. Resolves the extracted text or null; rejects only when process-tree
 * cleanup could not be confirmed (`error.processCleanupUncertain`).
 */
export function runCli(spec, prompt, timeoutMs, {
  env,
  cwd,
  signal,
  spawnProcess = spawn,
  terminateProcess = terminateProcessTree,
  cleanupProcessOutcome,
  onCleanupUncertain = () => {},
  platform,
  nodeCommand,
  maxOutputBytes = ONE_SHOT_MAX_CLI_OUTPUT_BYTES,
  acceptOutput = nonEmptyText,
  label = 'One-shot',
} = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let finalizing = false;
    let stdout = '';
    let outputExceeded = false;
    let child;
    let timer = null;
    let stopping = false;
    let cleanupPromise = null;
    let abort = () => {};

    const finish = (value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener?.('abort', abort);
      resolve(value);
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener?.('abort', abort);
      reject(error);
    };
    const finishAfterCleanup = (value, { allowUnavailable = false } = {}) => {
      if (settled || finalizing) return;
      finalizing = true;
      if (timer) clearTimeout(timer);
      if (!child) {
        finish(value);
        return;
      }
      if (!cleanupPromise) {
        cleanupPromise = (typeof cleanupProcessOutcome === 'function'
          ? Promise.resolve(cleanupProcessOutcome(child))
          : terminateAndWaitForProcessTreeExitOutcome(child, { terminateProcess }))
          .catch(() => PROCESS_TREE_CLEANUP_OUTCOME.FAILED);
      }
      void cleanupPromise.then((outcome) => {
        if (allowUnavailable
          && value !== null
          && outcome === PROCESS_TREE_CLEANUP_OUTCOME.UNAVAILABLE) {
          onCleanupUncertain();
          finish(value);
          return;
        }
        if (outcome !== PROCESS_TREE_CLEANUP_OUTCOME.PROVEN) {
          const error = new Error(`${label} process-tree cleanup could not be confirmed`);
          error.processCleanupUncertain = true;
          fail(error);
          return;
        }
        finish(value);
      });
    };
    const stop = () => {
      if (!child || stopping) return;
      stopping = true;
      finishAfterCleanup(null);
    };
    abort = () => {
      stop();
    };

    try {
      const launched = applyManagedCliLaunch(spec.command, spec.argv, {
        platform,
        nodeCommand,
        env,
      });
      child = spawnProcess(launched.command, launched.argv, {
        ...processTreeSpawnOptions(),
        shell: false,
        ...(cwd ? { cwd } : {}),
        env: launched.env,
        stdio: [spec.stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      });
    } catch {
      finish(null);
      return;
    }

    child.stdout?.setEncoding?.('utf8');
    child.stdout?.on?.('data', (chunk) => {
      if (outputExceeded) return;
      stdout += String(chunk);
      if (Buffer.byteLength(stdout, 'utf8') > maxOutputBytes) {
        outputExceeded = true;
        stop();
        return;
      }
      if (typeof cleanupProcessOutcome === 'function'
        && hasTerminalOneShotOutput(spec.provider, stdout)) {
        finishAfterCleanup(extractOneShotText(stdout));
      }
    });
    child.stdout?.on?.('error', () => {});
    child.stderr?.on?.('data', () => {});
    child.stderr?.on?.('error', () => {});
    child.on?.('error', () => {
      if (child.pid) stop();
      else finish(null);
    });
    child.on?.('close', (code) => {
      if (stopping || outputExceeded) {
        finishAfterCleanup(null);
        return;
      }
      const value = code === 0 ? extractOneShotText(stdout) : null;
      finishAfterCleanup(value, {
        allowUnavailable: code === 0 && acceptOutput(value),
      });
    });

    timer = setTimeout(abort, timeoutMs);
    signal?.addEventListener?.('abort', abort, { once: true });
    if (signal?.aborted) {
      abort();
      return;
    }

    if (spec.stdin) {
      child.stdin?.on?.('error', abort);
      try { child.stdin?.end?.(prompt); }
      catch { abort(); }
    }
  });
}

/**
 * Temp cwd + CLI spec + env for one attempt.
 * deps: { buildSpec?, tempPrefix?, mkdtemp?, commands?, cliModel?, cliEffort?, readiness?,
 *   isolatedHome?, sessionId?, providerEnvs? }
 */
export async function prepareCliWorkspace(provider, _prompt, deps) {
  const makeTemp = deps.mkdtemp ?? ((prefix) => fs.mkdtemp(prefix));
  const tempRoot = await makeTemp(path.join(os.tmpdir(), deps.tempPrefix ?? 'rhwp-one-shot-'));
  try {
    const buildSpec = deps.buildSpec ?? buildOneShotCliSpec;
    return {
      tempRoot,
      spec: buildSpec(provider, {
        command: deps.commands?.[provider],
        model: deps.cliModel ?? deps.readiness?.[provider]?.model,
        effort: deps.cliEffort ?? undefined,
        sessionId: crypto.randomUUID(),
      }),
      // Claude's env owns HOME: macOS keeps the real one so the CLI can reach its Keychain login.
      env: isolatedProcessEnv(
        {
          isolatedHome: provider === 'claude' ? undefined : deps.isolatedHome,
          sessionId: deps.sessionId,
        },
        deps.providerEnvs?.[provider],
      ),
    };
  } catch (error) {
    await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

export async function prepareCliWorkspaceBounded(provider, prompt, timeoutMs, deps) {
  if (timeoutMs <= 0 || deps.signal?.aborted) return null;
  const stopped = Symbol('stopped');
  let timer;
  let detachExternal = () => {};
  let stop;
  const aborted = new Promise((resolve) => {
    stop = () => resolve(stopped);
    timer = setTimeout(stop, timeoutMs);
    if (deps.signal) {
      deps.signal.addEventListener('abort', stop, { once: true });
      detachExternal = () => deps.signal.removeEventListener('abort', stop);
      if (deps.signal.aborted) stop();
    }
  });
  if (deps.signal?.aborted) {
    clearTimeout(timer);
    detachExternal();
    return null;
  }

  const running = prepareCliWorkspace(provider, prompt, deps);
  try {
    const workspace = await Promise.race([running, aborted]);
    if (workspace !== stopped) return workspace;
    void running.then(disposeCliWorkspace, () => {});
    return null;
  } finally {
    clearTimeout(timer);
    detachExternal();
  }
}

export async function runPreparedCli(workspace, prompt, timeoutMs, deps) {
  let cleanupUncertain = false;
  try {
    return await runCli(workspace.spec, prompt, timeoutMs, {
      cwd: workspace.tempRoot,
      signal: deps.signal,
      spawnProcess: deps.spawnProcess,
      terminateProcess: deps.terminateProcess,
      cleanupProcessOutcome: deps.cleanupProcessOutcome,
      env: workspace.env,
      platform: deps.platform,
      nodeCommand: deps.nodeCommand,
      maxOutputBytes: deps.maxOutputBytes,
      acceptOutput: deps.acceptOutput,
      label: deps.label,
      onCleanupUncertain: () => { cleanupUncertain = true; },
    });
  } catch (error) {
    cleanupUncertain ||= error?.processCleanupUncertain === true;
    throw error;
  } finally {
    if (!cleanupUncertain) await disposeCliWorkspace(workspace);
  }
}

export async function disposeCliWorkspace(workspace) {
  if (!workspace?.tempRoot) return;
  workspace.disposePromise ??= fs
    .rm(workspace.tempRoot, { recursive: true, force: true })
    .catch(() => {});
  await workspace.disposePromise;
}

/** Non-CLI routes: an injected runner, or Pi through OpenRouter chat completions. */
export async function runProvider(provider, model, prompt, timeoutMs, deps) {
  if (deps.signal?.aborted) return null;
  if (deps.runProvider) {
    return deps.runProvider({
      provider,
      model,
      prompt,
      timeoutMs,
      signal: deps.signal,
      ...(deps.cliEffort ? { effort: deps.cliEffort } : {}),
    });
  }
  if (provider === 'pi') {
    try {
      return await deps.openRouter.chat({
        key: deps.piManager.apiKey(),
        model,
        messages: [{ role: 'user', content: prompt }],
        maxTokens: deps.maxTokens ?? 128,
        temperature: deps.temperature ?? 0.2,
        timeout: timeoutMs,
        ...(deps.cliEffort ? { reasoningEffort: deps.cliEffort } : {}),
      });
    } catch {
      return null;
    }
  }
  return null;
}

/** Abort `operation` at `timeoutMs` (or the external signal) and wait a short grace for it to settle. */
export async function boundedAttempt(operation, timeoutMs, externalSignal) {
  const controller = new AbortController();
  const stopped = Symbol('stopped');
  const cleanupGraceMs = Math.min(100, Math.max(1, Math.floor(timeoutMs / 3)));
  const executionTimeoutMs = Math.max(1, timeoutMs - cleanupGraceMs);
  let timer = null;
  let detachExternal = () => {};
  let stopAttempt;
  const aborted = new Promise((resolve) => {
    const stop = () => {
      controller.abort();
      resolve(stopped);
    };
    stopAttempt = stop;
    timer = setTimeout(stop, executionTimeoutMs);
    if (externalSignal) {
      externalSignal.addEventListener('abort', stop, { once: true });
      detachExternal = () => externalSignal.removeEventListener('abort', stop);
      if (externalSignal.aborted) stop();
    }
  });
  const running = Promise.resolve().then(() => operation(controller.signal)).catch(() => null);
  try {
    const first = await Promise.race([running, aborted]);
    if (first !== stopped) return first;
    let cleanupTimer = null;
    try {
      return await Promise.race([
        running,
        new Promise((resolve) => { cleanupTimer = setTimeout(() => resolve(null), cleanupGraceMs); }),
      ]);
    } finally {
      if (cleanupTimer) clearTimeout(cleanupTimer);
    }
  } finally {
    if (timer) clearTimeout(timer);
    detachExternal();
    stopAttempt?.();
  }
}

/** One provider attempt bounded by its own timeout and the shared overall deadline. */
export async function runTimedProvider(provider, model, prompt, timeoutMs, overallDeadline, deps) {
  if (deps.runProvider || provider === 'pi') {
    return boundedAttempt(
      (signal) => runProvider(provider, model, prompt, timeoutMs, { ...deps, signal }),
      timeoutMs,
      deps.signal,
    );
  }

  let workspace;
  try {
    workspace = await prepareCliWorkspaceBounded(
      provider,
      prompt,
      overallDeadline - Date.now(),
      deps,
    );
  } catch {
    return null;
  }
  if (!workspace) return null;
  if (deps.signal?.aborted) {
    await disposeCliWorkspace(workspace);
    return null;
  }
  const remaining = overallDeadline - Date.now();
  if (remaining <= 0) {
    await disposeCliWorkspace(workspace);
    return null;
  }
  const runTimeoutMs = Math.max(1, Math.min(timeoutMs, remaining));
  try {
    return await runPreparedCli(workspace, prompt, runTimeoutMs, deps);
  } catch (error) {
    if (error?.processCleanupUncertain === true) throw error;
    return null;
  }
}

/**
 * Try candidates in order until `parse(output)` returns a non-null value.
 * candidates: { provider, model, ready, effort?, resolveModel? }[]. Unready, unresolved,
 * failed, invalid, or timed-out routes fall through. Unconfirmed process cleanup stops the
 * cascade and resolves null so no more processes are started.
 * @returns {Promise<{provider: string, model: string, value: any, output: string} | null>}
 */
export async function runOneShot({
  prompt,
  candidates,
  parse = (output) => (nonEmptyText(output) ? output : null),
  providerTimeoutMs,
  overallTimeoutMs,
  deps = {},
}) {
  const overallDeadline = Date.now() + overallTimeoutMs;
  for (const candidate of candidates) {
    if (deps.signal?.aborted) break;
    const { provider } = candidate;
    if (candidate.ready !== true || typeof candidate.model !== 'string' || !candidate.model) continue;
    if (overallDeadline - Date.now() <= 0) break;
    let model = candidate.model;
    if (candidate.resolveModel) {
      try { model = await candidate.resolveModel(); }
      catch { continue; }
      if (!model || deps.signal?.aborted) continue;
    }
    const remaining = overallDeadline - Date.now();
    if (remaining <= 0) break;
    const timeoutMs = Math.max(1, Math.min(providerTimeoutMs, remaining));
    let output;
    try {
      output = await runTimedProvider(
        provider,
        model,
        prompt,
        timeoutMs,
        overallDeadline,
        { ...deps, cliModel: model, cliEffort: candidate.effort ?? undefined },
      );
    } catch (error) {
      if (error?.processCleanupUncertain === true) return null;
      throw error;
    }
    const value = parse(output);
    if (value === null || value === undefined) continue;
    return { provider, model, value, output };
  }
  return null;
}
