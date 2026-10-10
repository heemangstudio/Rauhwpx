/**
 * In-process replay transport: a fake `ChildProcess` that plays one process
 * script of a replay bundle, and a spawner that hands those processes to the
 * real adapters (`spawnProcess`, the Claude SDK's `spawnClaudeCodeProcess`,
 * `terminateProcess`, `waitForExit`).
 */
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';

import { assertRunConsumed, createProcessRun, replayRunProblems } from './replay.mjs';

// Far above any Linux/macOS pid_max, so a stray process.kill(-pid) on a
// replay process can never reach a real process group.
let nextReplayPid = 2_000_000_000;

function epipeError() {
  return Object.assign(new Error('write EPIPE'), { code: 'EPIPE', errno: -32, syscall: 'write' });
}

/**
 * Implements the `ChildProcess` surface the adapters use and the Agent SDK's
 * `SpawnedProcess` interface. `kill()` is what the adapters' termination
 * reaches through the spawner; it satisfies a scripted `await-kill` or ends
 * the process with `exit(null, signal)`.
 */
export class ReplayChildProcess extends EventEmitter {
  constructor(meta, steps, {
    timeScale = 0,
    platform = process.platform,
    spawnfile = 'replay',
    spawnargs = [],
    label = 'process',
  } = {}) {
    super();
    this.pid = nextReplayPid++;
    this.spawnfile = spawnfile;
    this.spawnargs = spawnargs;
    this.label = label;
    this.exitCode = null;
    this.signalCode = null;
    this.killed = false;
    this.connected = false;
    this.killSignals = [];
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.stdin = new Writable({
      decodeStrings: false,
      write: (chunk, _encoding, callback) => {
        if (this.#hasExited()) {
          callback(epipeError());
          return;
        }
        this.run.feed(chunk);
        callback();
      },
      final: (callback) => {
        if (!this.#hasExited()) this.run.feedEnd();
        callback();
      },
    });
    this.stdio = [this.stdin, this.stdout, this.stderr];
    let resolveExited = () => {};
    /** Resolves with `{code, signal}` once the process has emitted `exit`. */
    this.exited = new Promise((resolve) => { resolveExited = resolve; });
    this.#resolveExited = resolveExited;
    this.run = createProcessRun(meta, steps, {
      timeScale,
      platform,
      io: {
        stdout: (text) => { if (!this.stdout.writableEnded) this.stdout.write(text); },
        stderr: (text) => { if (!this.stderr.writableEnded) this.stderr.write(text); },
        exit: (outcome) => this.#exit(outcome),
        close: () => this.#close(),
      },
    });
    this.run.start();
  }

  #resolveExited;
  #exitEmitted = false;
  #closeEmitted = false;

  #hasExited() {
    return this.#exitEmitted;
  }

  #exit({ code, signal, close, closeDelayMs }) {
    if (this.#exitEmitted) return;
    this.#exitEmitted = true;
    this.exitCode = code;
    this.signalCode = signal;
    this.emit('exit', code, signal);
    this.#resolveExited({ code, signal });
    if (!close) return;
    if (closeDelayMs > 0) setTimeout(() => this.#close(), closeDelayMs);
    else setImmediate(() => this.#close());
  }

  #close() {
    if (this.#closeEmitted) return;
    this.#closeEmitted = true;
    this.stdout.end();
    this.stderr.end();
    setImmediate(() => this.emit('close', this.exitCode, this.signalCode));
  }

  kill(signal = 'SIGTERM') {
    if (this.#exitEmitted) return false;
    this.killed = true;
    this.killSignals.push(signal);
    return this.run.kill(signal);
  }

  ref() {}

  unref() {}

  disconnect() {}
}

/**
 * Hand the bundle's process scripts to an adapter in spawn order (or by
 * `spawn.match.argvIncludes`). Spread the result into the adapter's
 * dependencies:
 *
 *   const replay = createReplaySpawner(loadReplayBundle(providerReplayFixture('pi/credits-402')));
 *   const session = createPiSession({ ...opts, onEvent }, replay);
 *   ...
 *   await replay.settled();
 *   replay.assertConsumed();
 *
 * `meta.terminate: 'fail'` makes `terminateProcess` report an unproven
 * cleanup (it still kills the replay process). `platform` is the platform
 * the adapter runs as (its `platform` dependency, default `process.platform`).
 */
export function createReplaySpawner(bundle, { timeScale = 0, platform = process.platform } = {}) {
  const { meta, processes } = bundle;
  const claimed = new Set();
  /** @type {Array<{command: string, argv: string[], options: any, process: ReplayChildProcess, script: number}>} */
  const spawns = [];
  const unexpectedSpawns = [];

  function claim(argv) {
    for (let index = 0; index < processes.length; index += 1) {
      if (claimed.has(index)) continue;
      const includes = processes[index][0]?.match?.argvIncludes;
      if (includes && !includes.every((item) => argv.includes(item))) continue;
      claimed.add(index);
      return index;
    }
    return -1;
  }

  function spawnProcess(command, argv = [], options = {}) {
    const args = Array.from(argv ?? [], String);
    const script = claim(args);
    if (script < 0) {
      unexpectedSpawns.push({ command, argv: args });
      throw new Error(`provider replay: no process script left for spawn #${spawns.length + unexpectedSpawns.length} (${command})`);
    }
    const child = new ReplayChildProcess(meta, processes[script], {
      timeScale,
      platform,
      spawnfile: command,
      spawnargs: [command, ...args],
      label: `${bundle.source ?? 'bundle'} process #${script + 1}`,
    });
    spawns.push({ command, argv: args, options, process: child, script });
    return child;
  }

  return {
    meta,
    spawns,
    unexpectedSpawns,
    get processes() { return spawns.map((entry) => entry.process); },
    spawnProcess,
    /** The Agent SDK's spawn hook: `options.spawnClaudeCodeProcess`. */
    spawnClaudeCodeProcess(sdkOptions) {
      const child = spawnProcess(sdkOptions.command, sdkOptions.args, {
        cwd: sdkOptions.cwd,
        env: sdkOptions.env,
        signal: sdkOptions.signal,
      });
      sdkOptions.signal?.addEventListener?.('abort', () => child.kill('SIGTERM'), { once: true });
      return child;
    },
    terminateProcess(proc) {
      try { proc?.kill?.('SIGTERM'); } catch {}
      return meta.terminate !== 'fail';
    },
    waitForExit(proc) {
      if (!proc || proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve(true);
      return proc.exited ? proc.exited.then(() => true) : new Promise((resolve) => proc.once('exit', () => resolve(true)));
    },
    /** Resolves once every process started so far has exited. */
    settled() {
      return Promise.all(spawns.map((entry) => entry.process.exited)).then(() => undefined);
    },
    problems() {
      const problems = [];
      processes.forEach((_steps, index) => {
        if (!claimed.has(index)) problems.push(`process script #${index + 1} was never spawned`);
      });
      for (const entry of unexpectedSpawns) {
        problems.push(`unexpected spawn ${entry.command} ${entry.argv.join(' ').slice(0, 200)}`);
      }
      for (const entry of spawns) {
        problems.push(...replayRunProblems(entry.process.run, `process #${entry.script + 1}`));
      }
      return problems;
    },
    /** Throw when a script was not spawned or not consumed, or a frame was unexpected. */
    assertConsumed() {
      const problems = this.problems();
      if (problems.length > 0) {
        const error = new Error(`provider replay was not consumed cleanly:\n${problems.join('\n')}`);
        error.problems = problems;
        throw error;
      }
    },
  };
}

export { assertRunConsumed };
