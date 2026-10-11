/**
 * Out-of-process replay transport: a fake `claude`, `codex` or `pi` binary
 * that plays a replay bundle over its real stdio under the real hub, so the
 * hub's spawning and process-tree cleanup run for real.
 *
 * `installReplayCli(binDir, 'pi', bundlePath)` copies the bundle next to the
 * launcher and bakes its absolute path into the launcher source: adapters
 * build child environments from allow-lists, so an environment variable
 * would not reach the fake CLI. Each invocation other than `--version`
 * claims the next process script, plays it, and keeps
 * `<bundle>.result-<n>.json` up to date with what the adapter wrote, what
 * was unexpected and which steps were left over.
 *
 * Out of process, `exit {close: false}` and `closeDelayMs` are not
 * simulated (the pipes close when the process exits), and on Windows an
 * `await-kill` simply waits until `taskkill /F` ends the process.
 */
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { writeFakeCliBin } from '../fake-cli-bin.mjs';
import { createProcessRun, loadReplayBundle } from './replay.mjs';

const REPLAY_CLI_MODULE = fileURLToPath(import.meta.url);

function isVersionProbe(argv) {
  return argv.length === 1 && (argv[0] === '--version' || argv[0] === '-V' || argv[0] === '-v');
}

function matchTokens(bundle) {
  return new Set(bundle.processes.flatMap((steps) => steps[0]?.match?.argvIncludes ?? []));
}

/**
 * Claim this invocation's spawn number. Appends are atomic, so every
 * concurrent invocation finds its own line; scripts are then assigned by
 * replaying the same claim rule over the earlier invocations' argv tokens.
 */
function claimScript(bundlePath, bundle, argv) {
  const tokens = matchTokens(bundle);
  const nonce = randomUUID();
  const spawnsFile = `${bundlePath}.spawns`;
  appendFileSync(spawnsFile, `${JSON.stringify({ nonce, pid: process.pid, tokens: argv.filter((arg) => tokens.has(arg)) })}\n`);
  const entries = readFileSync(spawnsFile, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const spawnIndex = entries.findIndex((entry) => entry.nonce === nonce);
  const claimed = new Set();
  let script = -1;
  for (let index = 0; index <= spawnIndex; index += 1) {
    const entryTokens = new Set(entries[index].tokens);
    script = -1;
    for (let candidate = 0; candidate < bundle.processes.length; candidate += 1) {
      if (claimed.has(candidate)) continue;
      const includes = bundle.processes[candidate][0]?.match?.argvIncludes;
      if (includes && !includes.every((item) => entryTokens.has(item))) continue;
      claimed.add(candidate);
      script = candidate;
      break;
    }
  }
  return { spawn: spawnIndex + 1, script };
}

function writeResult(file, result) {
  try {
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(result, null, 2)}\n`);
    renameSync(temp, file);
  } catch {
    // A result file is diagnostics; the replay itself continues.
  }
}

/** Entry point baked into the launcher by `installReplayCli`. */
export async function runReplayCli(bundlePath, argv = process.argv.slice(2)) {
  const bundle = loadReplayBundle(bundlePath);
  if (isVersionProbe(argv)) {
    process.stdout.write(`${bundle.meta.cli}\n`);
    return;
  }
  const { spawn, script } = claimScript(bundlePath, bundle, argv);
  const resultFile = `${bundlePath}.result-${spawn}.json`;
  if (script < 0) {
    writeResult(resultFile, { spawn, script: null, argv, error: 'no process script left for this spawn' });
    process.stderr.write(`provider replay: no process script left for spawn #${spawn}\n`);
    process.exit(97);
  }

  const keepAlive = setInterval(() => {}, 1 << 30);
  let pendingWrites = Promise.resolve();
  const write = (stream, text) => {
    pendingWrites = pendingWrites.then(() => new Promise((resolve) => {
      stream.write(text, () => resolve());
    }));
  };
  let run;
  let exitOutcome = null;
  const snapshot = () => ({
    spawn,
    script: script + 1,
    argv,
    pid: process.pid,
    killed: run?.killed ?? false,
    exited: run?.exited ?? false,
    finished: run?.finished ?? false,
    stdinFrames: run?.stdinFrames ?? [],
    unexpected: run?.unexpected ?? [],
    leftover: run?.leftover() ?? [],
    errors: run?.errors ?? [],
    exit: exitOutcome,
  });
  const onSignal = (signal) => { run.kill(signal); };
  run = createProcessRun(bundle.meta, bundle.processes[script], {
    io: {
      stdout: (text) => write(process.stdout, text),
      stderr: (text) => write(process.stderr, text),
      exit: ({ code, signal }) => {
        exitOutcome = { code, signal };
        writeResult(resultFile, snapshot());
        void pendingWrites.then(() => {
          clearInterval(keepAlive);
          if (signal && process.platform !== 'win32') {
            process.removeAllListeners('SIGTERM');
            process.removeAllListeners('SIGINT');
            process.kill(process.pid, signal);
            setTimeout(() => process.exit(128), 1_000).unref();
            return;
          }
          process.exit(code ?? 1);
        });
      },
      close: () => {},
    },
    onChange: () => writeResult(resultFile, snapshot()),
  });
  process.on('SIGTERM', () => onSignal('SIGTERM'));
  process.on('SIGINT', () => onSignal('SIGINT'));
  process.stdin.on('data', (chunk) => run.feed(chunk));
  process.stdin.on('end', () => run.feedEnd());
  process.stdin.on('error', () => {});
  // A reader that went away (EPIPE) must not crash the replay mid-script.
  process.stdout.on('error', () => {});
  process.stderr.on('error', () => {});
  writeResult(resultFile, snapshot());
  run.start();
}

/**
 * Install `binName` in `binDir` as a replay of `bundlePath`. The bundle is
 * copied into `binDir`, so the spawn counter and result files live in the
 * test's temporary directory. Returns helpers to read the results back.
 */
export function installReplayCli(binDir, binName, bundlePath) {
  mkdirSync(binDir, { recursive: true });
  const localBundle = path.resolve(binDir, `${binName}-replay.ndjson`);
  copyFileSync(bundlePath, localBundle);
  const moduleUrl = pathToFileURL(REPLAY_CLI_MODULE).href;
  const source = [
    `import(${JSON.stringify(moduleUrl)})`,
    `  .then((m) => m.runReplayCli(${JSON.stringify(localBundle)}, process.argv.slice(2)))`,
    "  .catch((error) => { process.stderr.write(`provider replay failed: ${error?.stack ?? error}\\n`); process.exit(70); });",
  ].join('\n');
  const installed = writeFakeCliBin(binDir, binName, source);
  return {
    ...installed,
    bundlePath: localBundle,
    /** Number of non-`--version` invocations so far. */
    spawnCount() {
      const file = `${localBundle}.spawns`;
      return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).length : 0;
    },
    /** Result snapshots by spawn number (1-based), as the CLI last wrote them. */
    results() {
      const prefix = `${path.basename(localBundle)}.result-`;
      return readdirSync(binDir)
        .filter((name) => name.startsWith(prefix) && name.endsWith('.json'))
        .map((name) => JSON.parse(readFileSync(path.join(binDir, name), 'utf8')))
        .sort((left, right) => left.spawn - right.spawn);
    },
  };
}
