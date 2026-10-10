/**
 * Run a real provider adapter (`claude.mjs`, `codex.mjs`/`codex-app-server.mjs`,
 * `pi.mjs`) against a replay bundle, in process.
 *
 * The bundle's `meta.agent` and `meta.transport` pick the adapter path:
 * - `pi` / `json`: `createPiSession`;
 * - `claude` / `cli`: `createClaudeSession` without `requestUserInput`
 *   (the CLI + MCP path; it shares `handleEvent` with the SDK path);
 * - `claude` / `sdk`: `createClaudeSession` as a root chat, with the real
 *   Agent SDK spawning through `spawnClaudeCodeProcess` (needs a recorded
 *   `initialize` handshake);
 * - `codex` / `app-server`: `createCodexSession` as a root chat;
 * - `codex` / `exec`: `createCodexSession` without `requestUserInput`.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { query as queryClaude } from '@anthropic-ai/claude-agent-sdk';

import { createClaudeSession } from '../../agents/claude.mjs';
import { createCodexSession } from '../../agents/codex.mjs';
import { createPiSession } from '../../agents/pi.mjs';
import { loadReplayBundle, providerReplayFixture } from './replay.mjs';
import { createReplaySpawner } from './replay-process.mjs';

export const REPLAY_SESSION_TOKEN = 'replay-session-token-0123456789';

/** A Codex rollout watcher that observes nothing (the rollout files are not part of a replay). */
export function noopRolloutWatcher() {
  return { start() {}, finalize() {}, stop() {} };
}

function resolveBundle(bundleOrName) {
  if (typeof bundleOrName !== 'string') return bundleOrName;
  const file = path.isAbsolute(bundleOrName) ? bundleOrName : providerReplayFixture(bundleOrName);
  return loadReplayBundle(file);
}

/**
 * Start the adapter for `bundleOrName` (a bundle, an absolute path, or a
 * fixture name like `'pi/credits-402'`). Returns the live session, the
 * replay spawner, the emitted `UnifiedAgentEvent`s and helpers to wait for
 * events. Call `close()` (or pass `t` to register it) to dispose the
 * session and remove the temporary directories.
 */
export function startReplaySession(bundleOrName, {
  t = null,
  opts: overrides = {},
  timeScale = 0,
  closeGraceMs = 100,
  requestUserInput = async () => ({ status: 'cancelled', reason: 'user-stop' }),
  dependencies = {},
} = {}) {
  const bundle = resolveBundle(bundleOrName);
  const { agent, transport } = bundle.meta;
  const root = mkdtempSync(path.join(os.tmpdir(), `rhwp-replay-${agent}-`));
  const replay = createReplaySpawner(bundle, { timeScale });
  const events = [];
  const listeners = new Set();
  const onEvent = (event) => {
    events.push(event);
    for (const listener of [...listeners]) listener(event);
  };
  const base = {
    rootDir: path.join(root, 'work'),
    isolatedHome: path.join(root, 'home'),
    mcpScriptPath: path.join(root, 'mcp-stdio.mjs'),
    hubPort: 5199,
    token: REPLAY_SESSION_TOKEN,
    sessionId: `replay-${agent}-thread`,
    permissionProfile: 'safe',
    onEvent,
  };
  let session;
  if (agent === 'pi') {
    session = createPiSession({
      ...base,
      piBin: 'pi',
      piRoot: path.join(root, 'pi'),
      model: 'mock-model',
      openRouterApiKey: 'sk-or-v1-replayPlaceholderKey0123456789',
      ...overrides,
    }, { ...replay, closeGraceMs, ...dependencies });
  } else if (agent === 'claude') {
    const sdk = transport === 'sdk';
    session = createClaudeSession({
      ...base,
      claudeBin: sdk ? process.execPath : 'claude',
      model: 'claude-sonnet-4-5',
      ...(sdk ? { requestUserInput, agentRole: 'chat' } : {}),
      ...overrides,
    }, {
      ...replay,
      closeGraceMs,
      flushCredentialMirrors: () => {},
      ...(sdk ? {
        queryAgent: (args) => queryClaude({
          ...args,
          options: { ...args.options, spawnClaudeCodeProcess: replay.spawnClaudeCodeProcess },
        }),
      } : {}),
      ...dependencies,
    });
  } else {
    const native = transport === 'app-server';
    session = createCodexSession({
      ...base,
      codexHome: path.join(root, 'codex-home'),
      codexBin: 'codex',
      model: 'gpt-5.6-sol',
      ...(native ? { requestUserInput, agentRole: 'chat' } : {}),
      ...overrides,
    }, {
      ...replay,
      closeGraceMs,
      createRolloutWatcher: noopRolloutWatcher,
      ...dependencies,
    });
  }

  function waitForEvent(predicate, { timeoutMs = 5_000, from = 0 } = {}) {
    const existing = events.slice(from).find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const listener = (event) => {
        if (!predicate(event)) return;
        clearTimeout(timer);
        listeners.delete(listener);
        resolve(event);
      };
      const timer = setTimeout(() => {
        listeners.delete(listener);
        reject(new Error(`replay ${bundle.source}: timed out waiting for an event; got ${JSON.stringify(events.map((event) => event.type))}\n${replay.problems().join('\n')}`));
      }, timeoutMs);
      listeners.add(listener);
    });
  }

  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    try { await session.dispose(); } catch {}
    rmSync(root, { recursive: true, force: true });
  }
  t?.after(close);

  return {
    bundle,
    session,
    replay,
    events,
    root,
    waitForEvent,
    /** Wait for the `n`-th turn-end (1-based) emitted since the session started. */
    turnEnd(n = 1, options) {
      let seen = 0;
      return waitForEvent((event) => event.type === 'turn-end' && ++seen === n, options);
    },
    /** Send a user message and resolve with the turn-end that closes it. */
    async runTurn(text = 'replay prompt', options) {
      const before = events.filter((event) => event.type === 'turn-end').length;
      session.sendUserMessage(text);
      return this.turnEnd(before + 1, options);
    },
    close,
  };
}
