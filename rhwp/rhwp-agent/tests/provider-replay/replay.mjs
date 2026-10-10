/**
 * Provider replay at the stdio boundary (test-only).
 *
 * A replay bundle is NDJSON: a `meta` line, then one script per provider
 * process, each starting at a `spawn` record. The same format comes out of
 * the hub's recorder (`RHWP_PROVIDER_TRANSCRIPT_DIR`, see
 * `../../provider-transcript.mjs`, one file per process; concatenating files
 * gives a valid bundle) and is written by hand for synthetic fixtures under
 * `../fixtures/provider-replay/<agent>/<name>.ndjson`.
 *
 * Records after `spawn`:
 * - `in`     (recorded) adapter -> CLI. Replayed as a loose expectation:
 *            JSON-RPC by `method` (responses by `id`), Claude stream-json by
 *            `type` plus `request.subtype`/`response.subtype`, text by EOF.
 * - `expect` (hand-written) waits for a write: `json` subset match, `text:
 *            {includes}`, `end: true` (stdin EOF), `capture: {name: 'dot.path'}`.
 * - `out`    CLI -> adapter stdout line (`json` or `line`, `partial: true`
 *            omits the newline). Strings that are exactly `"$in.<path>"` (last
 *            matched input) or `"$cap.<name>"` become the typed value.
 * - `err`    stderr chunk. `sleep {ms}` waits `ms * timeScale`.
 * - `await-kill` waits until the adapter terminates the process; later `out`
 *            records are output that arrives after the kill.
 * - `exit {code, signal, close?, closeDelayMs?}` emits `exit`, then `close`
 *            unless `close: false` (a descendant still holds the pipes). A
 *            later recorded `close` record closes such a process.
 * - `truncated` means the recorder hit its size cap: such files are refused.
 *
 * Recorded JSON-RPC `id`s and Claude control `request_id`s are mapped to the
 * live ids the adapter wrote, and later `out` responses are rewritten through
 * that map, so recorded transcripts answer the live requests.
 *
 * Strictness: a frame the adapter writes that no step consumed is reported
 * by `assertRunConsumed` unless it matches a `meta.ignoreOutbound` subset
 * matcher; so are steps left over when the process ended.
 *
 * Turning a recording into a fixture: copy the files (concatenate several
 * processes of one session into one bundle), replace prompt and document
 * text with short placeholders, keep `provenance: 'recorded'` and add a
 * `note` saying what was trimmed. Recordings hold prompts and document text;
 * review is the only guard before committing one. Synthetic fixtures set
 * `provenance: 'synthetic'` and must name the source of their shapes in
 * `basis`.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';

export const REPLAY_FORMAT_VERSION = 1;
export const REPLAY_FIXTURE_DIR = fileURLToPath(new URL('../fixtures/provider-replay/', import.meta.url));

const AGENTS = new Set(['claude', 'codex', 'pi']);
/** Transport -> stdin framing the adapter uses for it. */
export const REPLAY_TRANSPORT_STDIN = Object.freeze({
  sdk: 'ndjson',
  cli: 'ndjson',
  'app-server': 'ndjson',
  exec: 'text',
  json: 'text',
});
const STEP_KINDS = new Set(['spawn', 'in', 'expect', 'out', 'err', 'sleep', 'await-kill', 'exit', 'close']);

export class ReplayBundleError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ReplayBundleError';
  }
}

/** Absolute path of a committed fixture, e.g. `providerReplayFixture('pi/credits-402')`. */
export function providerReplayFixture(name) {
  const file = name.endsWith('.ndjson') ? name : `${name}.ndjson`;
  return path.join(REPLAY_FIXTURE_DIR, file);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function fail(source, line, message) {
  throw new ReplayBundleError(`${source}:${line}: ${message}`);
}

function validateMeta(record, source, line) {
  if (record.v !== REPLAY_FORMAT_VERSION) fail(source, line, `meta.v must be ${REPLAY_FORMAT_VERSION}`);
  if (!AGENTS.has(record.agent)) fail(source, line, `meta.agent must be claude, codex or pi`);
  if (!Object.hasOwn(REPLAY_TRANSPORT_STDIN, record.transport)) {
    fail(source, line, `meta.transport must be one of ${Object.keys(REPLAY_TRANSPORT_STDIN).join(', ')}`);
  }
  if (record.provenance !== 'recorded' && record.provenance !== 'synthetic') {
    fail(source, line, 'meta.provenance must be recorded or synthetic');
  }
  if (record.provenance === 'synthetic' && (typeof record.basis !== 'string' || !record.basis.trim())) {
    fail(source, line, 'a synthetic bundle must say where its shapes come from in meta.basis');
  }
  if (typeof record.cli !== 'string' || !record.cli.trim()) fail(source, line, 'meta.cli must name the CLI version');
  const stdin = record.stdin ?? REPLAY_TRANSPORT_STDIN[record.transport];
  if (stdin !== 'ndjson' && stdin !== 'text') fail(source, line, 'meta.stdin must be ndjson or text');
  if (record.ignoreOutbound !== undefined
    && (!Array.isArray(record.ignoreOutbound) || !record.ignoreOutbound.every(isPlainObject))) {
    fail(source, line, 'meta.ignoreOutbound must be an array of JSON subset matchers');
  }
  if (record.terminate !== undefined && record.terminate !== 'ok' && record.terminate !== 'fail') {
    fail(source, line, "meta.terminate must be 'ok' or 'fail'");
  }
  return Object.freeze({ ...record, stdin });
}

function validateStep(record, source, line) {
  const { kind } = record;
  if (!STEP_KINDS.has(kind)) fail(source, line, `unknown record kind ${JSON.stringify(kind)}`);
  if (kind === 'spawn' && record.match !== undefined) {
    const includes = record.match?.argvIncludes;
    if (!Array.isArray(includes) || !includes.every((item) => typeof item === 'string')) {
      fail(source, line, 'spawn.match.argvIncludes must be an array of strings');
    }
  }
  if (kind === 'in' && !('json' in record) && typeof record.line !== 'string'
    && typeof record.text !== 'string' && record.end !== true) {
    fail(source, line, 'in needs json, line, text or end');
  }
  if (kind === 'expect') {
    if (!('json' in record) && record.text === undefined && record.end !== true) {
      fail(source, line, 'expect needs json, text or end');
    }
    if (record.text !== undefined && typeof record.text?.includes !== 'string') {
      fail(source, line, 'expect.text must be {includes: string}');
    }
    if (record.capture !== undefined && (!isPlainObject(record.capture)
      || !Object.values(record.capture).every((value) => typeof value === 'string'))) {
      fail(source, line, 'expect.capture must map names to dot paths');
    }
  }
  if (kind === 'out' && !('json' in record) && typeof record.line !== 'string') {
    fail(source, line, 'out needs json or line');
  }
  if (kind === 'err' && typeof record.text !== 'string') fail(source, line, 'err needs text');
  if (kind === 'sleep' && !(Number.isFinite(record.ms) && record.ms >= 0)) {
    fail(source, line, 'sleep needs a non-negative ms');
  }
  if (kind === 'exit') {
    const code = record.code ?? null;
    const signal = record.signal ?? null;
    if (code !== null && !Number.isInteger(code)) fail(source, line, 'exit.code must be an integer or null');
    if (signal !== null && typeof signal !== 'string') fail(source, line, 'exit.signal must be a string or null');
    if (code === null && signal === null) fail(source, line, 'exit needs a code or a signal');
    if (record.closeDelayMs !== undefined && !(Number.isFinite(record.closeDelayMs) && record.closeDelayMs >= 0)) {
      fail(source, line, 'exit.closeDelayMs must be a non-negative number');
    }
  }
  return Object.freeze(record);
}

/**
 * Parse and validate a bundle. Returns `{ meta, processes, source }` where
 * each process is a step list starting with its `spawn` record.
 */
export function parseReplayBundle(text, { source = '<inline>' } = {}) {
  const records = [];
  String(text).split(/\r?\n/).forEach((raw, index) => {
    if (!raw.trim()) return;
    let record;
    try {
      record = JSON.parse(raw);
    } catch (error) {
      fail(source, index + 1, `not valid JSON (${error.message})`);
    }
    if (!isPlainObject(record) || typeof record.kind !== 'string') {
      fail(source, index + 1, 'each line must be an object with a string kind');
    }
    records.push({ record, line: index + 1 });
  });
  if (records.length === 0) throw new ReplayBundleError(`${source}: empty replay bundle`);
  const first = records[0];
  if (first.record.kind !== 'meta') fail(source, first.line, 'the first record must be meta');
  const meta = validateMeta(first.record, source, first.line);
  const processes = [];
  let current = null;
  for (let index = 1; index < records.length; index += 1) {
    const { record, line } = records[index];
    if (record.kind === 'truncated') {
      fail(source, line, 'the recorder truncated this transcript; it cannot be replayed');
    }
    if (record.kind === 'meta') {
      // Concatenated recordings repeat their meta line before each spawn.
      const next = records[index + 1]?.record;
      if (next?.kind !== 'spawn') fail(source, line, 'a repeated meta must precede a spawn');
      const repeated = validateMeta(record, source, line);
      if (repeated.agent !== meta.agent || repeated.stdin !== meta.stdin) {
        fail(source, line, 'all processes of a bundle must share agent and stdin framing');
      }
      continue;
    }
    const step = validateStep(record, source, line);
    if (step.kind === 'spawn') {
      current = [step];
      processes.push(current);
      continue;
    }
    if (!current) fail(source, line, `${step.kind} before the first spawn`);
    current.push(step);
  }
  if (processes.length === 0) throw new ReplayBundleError(`${source}: a bundle needs at least one spawn`);
  return Object.freeze({ meta, processes: Object.freeze(processes.map(Object.freeze)), source });
}

export function loadReplayBundle(filePath) {
  return parseReplayBundle(readFileSync(filePath, 'utf8'), { source: filePath });
}

function getPath(value, dotPath) {
  if (!dotPath) return value;
  let current = value;
  for (const key of String(dotPath).split('.')) {
    if (current === null || current === undefined) return undefined;
    current = Array.isArray(current) && /^\d+$/.test(key) ? current[Number(key)] : current[key];
  }
  return current;
}

function deepEqual(left, right) {
  if (Object.is(left, right)) return true;
  if (typeof left !== typeof right || left === null || right === null || typeof left !== 'object') return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key) => Object.hasOwn(right, key) && deepEqual(left[key], right[key]));
}

function idKey(value) {
  return `${typeof value}:${String(value)}`;
}

function describeFrame(entry) {
  if ('json' in entry) return JSON.stringify(entry.json);
  if ('line' in entry) return `line ${JSON.stringify(entry.line)}`;
  return `text ${JSON.stringify(String(entry.text).slice(0, 200))}`;
}

function describeStep(step, index) {
  const { kind, ...rest } = step;
  return `#${index} ${kind} ${JSON.stringify(rest)}`.slice(0, 400);
}

/**
 * Drive one process script. `io` receives what the fake CLI emits:
 * `stdout(text)`, `stderr(text)`, `exit({code, signal, close, closeDelayMs})`
 * and `close()` (a deferred close after `exit {close: false}`).
 *
 * The run returned exposes `feed(chunk)`, `feedEnd()`, `kill(signal)` and
 * the observable state used by assertions: `stdinFrames`, `unexpected`,
 * `leftover()`, `errors`, `captures`, `idMap`, `done` (resolves when the
 * script has nothing more to do).
 */
export function createProcessRun(meta, steps, {
  timeScale = 0,
  io,
  onWrite = null,
  onChange = null,
} = {}) {
  if (!io) throw new TypeError('createProcessRun needs io callbacks');
  const stdinMode = meta.stdin ?? REPLAY_TRANSPORT_STDIN[meta.transport];
  const ignoreOutbound = Array.isArray(meta.ignoreOutbound) ? meta.ignoreOutbound : [];
  const decoder = new StringDecoder('utf8');
  /** @type {Array<{json?: any, line?: string, text?: string, partial?: boolean, matched: boolean, ignorable: boolean}>} */
  const inbound = [];
  let partialLine = '';
  let stdinText = '';
  let stdinEnded = false;
  let lastIn;
  let lastT = null;
  let cursor = steps[0]?.kind === 'spawn' ? 1 : 0;
  let killed = false;
  let dying = false;
  let exited = false;
  let closeDeferred = false;
  let playedExitIndex = -1;
  let finished = false;
  let waiters = [];
  const captures = Object.create(null);
  const idMap = new Map();
  const errors = [];
  let resolveDone = () => {};
  const done = new Promise((resolve) => { resolveDone = resolve; });

  const notify = () => {
    const pending = waiters;
    waiters = [];
    for (const wake of pending) wake();
    onChange?.(run);
  };
  const changed = () => new Promise((resolve) => { waiters.push(resolve); });
  const waitFor = async (predicate) => {
    for (;;) {
      if (dying) return false;
      if (predicate()) return true;
      await changed();
    }
  };
  const yieldTurn = () => new Promise((resolve) => setImmediate(resolve));
  const sleep = (ms) => (ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : yieldTurn());
  const paceFor = async (step) => {
    if (timeScale > 0 && Number.isFinite(step.t) && lastT !== null && step.t > lastT) {
      await sleep((step.t - lastT) * timeScale);
    } else {
      await yieldTurn();
    }
    if (Number.isFinite(step.t)) lastT = step.t;
  };

  const ignorable = (entry) => 'json' in entry
    && ignoreOutbound.some((matcher) => subsetMatches(matcher, entry.json));

  function substituteValue(value) {
    if (typeof value === 'string') {
      if (value.startsWith('$in.') || value === '$in') {
        const resolved = getPath(lastIn, value === '$in' ? '' : value.slice(4));
        if (resolved === undefined) errors.push(`${value} is undefined (no matching input yet)`);
        return resolved ?? null;
      }
      if (value.startsWith('$cap.')) {
        const name = value.slice(5);
        if (!Object.hasOwn(captures, name)) errors.push(`${value} was never captured`);
        return captures[name] ?? null;
      }
      return value;
    }
    if (Array.isArray(value)) return value.map(substituteValue);
    if (isPlainObject(value)) {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, substituteValue(item)]));
    }
    return value;
  }

  function subsetMatches(expected, actual) {
    if (typeof expected === 'string' && (expected.startsWith('$cap.') || expected.startsWith('$in.'))) {
      const resolved = expected.startsWith('$cap.')
        ? captures[expected.slice(5)]
        : getPath(lastIn, expected.slice(4));
      return resolved !== undefined && deepEqual(resolved, actual);
    }
    if (Array.isArray(expected)) {
      return Array.isArray(actual) && actual.length === expected.length
        && expected.every((item, index) => subsetMatches(item, actual[index]));
    }
    if (isPlainObject(expected)) {
      return isPlainObject(actual)
        && Object.entries(expected).every(([key, item]) => subsetMatches(item, actual[key]));
    }
    return Object.is(expected, actual);
  }

  function rememberId(recordedValue, liveValue) {
    if (recordedValue === undefined || liveValue === undefined) return;
    idMap.set(idKey(recordedValue), liveValue);
  }

  function remapIds(json) {
    if (!isPlainObject(json) || idMap.size === 0) return json;
    const mapped = (value) => (idMap.has(idKey(value)) ? idMap.get(idKey(value)) : value);
    const out = { ...json };
    if (out.method === undefined && out.type === undefined && 'id' in out) out.id = mapped(out.id);
    if (out.type === 'control_response') {
      if ('request_id' in out) out.request_id = mapped(out.request_id);
      if (isPlainObject(out.response) && 'request_id' in out.response) {
        out.response = { ...out.response, request_id: mapped(out.response.request_id) };
      }
    }
    return out;
  }

  function consumeText() {
    for (const entry of inbound) entry.matched = true;
    lastIn = stdinText;
  }

  function matchExpect(step) {
    if (step.end === true && !stdinEnded) return false;
    if (stdinMode === 'text') {
      if (step.text && !stdinText.includes(step.text.includes)) return false;
      if ('json' in step) {
        let parsed;
        try { parsed = JSON.parse(stdinText); } catch { return false; }
        if (!subsetMatches(step.json, parsed)) return false;
      }
      consumeText();
      return true;
    }
    if (!('json' in step) && step.text === undefined) return true;
    const entry = inbound.find((candidate) => {
      if (candidate.matched) return false;
      if ('json' in step && !('json' in candidate && subsetMatches(step.json, candidate.json))) return false;
      if (step.text) {
        const raw = 'json' in candidate ? JSON.stringify(candidate.json) : candidate.line;
        if (!raw.includes(step.text.includes)) return false;
      }
      return true;
    });
    if (!entry) return false;
    entry.matched = true;
    lastIn = 'json' in entry ? entry.json : entry.line;
    for (const [name, dotPath] of Object.entries(step.capture ?? {})) {
      const value = getPath(lastIn, dotPath);
      if (value === undefined) errors.push(`capture ${name} (${dotPath}) is undefined in ${describeFrame(entry)}`);
      captures[name] = value;
    }
    return true;
  }

  function recordedMatches(recorded, live) {
    if (isPlainObject(recorded) && recorded.method !== undefined) {
      return isPlainObject(live) && live.method === recorded.method;
    }
    if (isPlainObject(recorded) && recorded.id !== undefined && recorded.type === undefined) {
      return isPlainObject(live) && live.method === undefined && deepEqual(live.id, recorded.id);
    }
    if (isPlainObject(recorded) && recorded.type !== undefined) {
      if (!isPlainObject(live) || live.type !== recorded.type) return false;
      if (recorded.request?.subtype !== undefined && live.request?.subtype !== recorded.request.subtype) return false;
      if (recorded.response?.subtype !== undefined && live.response?.subtype !== recorded.response.subtype) return false;
      return true;
    }
    return true;
  }

  function matchRecorded(step) {
    if (stdinMode === 'text') {
      if (step.end !== true) return true; // Text chunking is not stable; only EOF is checked.
      if (!stdinEnded) return false;
      consumeText();
      return true;
    }
    if (!('json' in step) && typeof step.line !== 'string') return stdinEnded;
    const entry = inbound.find((candidate) => !candidate.matched && (
      'json' in step ? 'json' in candidate && recordedMatches(step.json, candidate.json) : 'line' in candidate
    ));
    if (!entry) return false;
    if (step.end === true && !stdinEnded) return false;
    entry.matched = true;
    lastIn = 'json' in entry ? entry.json : entry.line;
    if ('json' in step && isPlainObject(step.json) && isPlainObject(entry.json)) {
      if (step.json.method !== undefined && step.json.id !== undefined) rememberId(step.json.id, entry.json.id);
      if (step.json.type === 'control_request') rememberId(step.json.request_id, entry.json.request_id);
    }
    return true;
  }

  function hasAwaitKillAhead() {
    for (let index = cursor; index < steps.length; index += 1) {
      if (steps[index].kind === 'await-kill') return true;
      if (steps[index].kind === 'exit') return false;
    }
    return false;
  }

  function hasExitAhead() {
    return steps.slice(cursor).some((step) => step.kind === 'exit');
  }

  /** Only output stands between the cursor and a natural (coded) exit. */
  function naturalExitPending() {
    for (let index = cursor; index < steps.length; index += 1) {
      const { kind } = steps[index];
      if (kind === 'exit') return Number.isInteger(steps[index].code);
      if (kind !== 'out' && kind !== 'err' && kind !== 'sleep' && kind !== 'close') return false;
    }
    return false;
  }

  function emitOut(step) {
    if (exited && !closeDeferred) return;
    if ('json' in step) {
      const json = substituteValue(remapIds(step.json));
      io.stdout(`${JSON.stringify(json)}${step.partial ? '' : '\n'}`);
    } else {
      io.stdout(`${step.line}${step.partial ? '' : '\n'}`);
    }
  }

  async function play() {
    for (; cursor < steps.length; cursor += 1) {
      if (dying) return;
      const step = steps[cursor];
      switch (step.kind) {
        case 'spawn':
          break;
        case 'in':
          if (!await waitFor(() => matchRecorded(step))) return;
          if (Number.isFinite(step.t)) lastT = step.t;
          break;
        case 'expect':
          if (!await waitFor(() => matchExpect(step))) return;
          break;
        case 'out':
          await paceFor(step);
          if (dying) return;
          emitOut(step);
          break;
        case 'err':
          await paceFor(step);
          if (dying) return;
          if (!exited || closeDeferred) io.stderr(step.text);
          break;
        case 'sleep':
          await sleep(step.ms * timeScale);
          break;
        case 'await-kill':
          if (!await waitFor(() => killed)) return;
          break;
        case 'exit': {
          await paceFor(step);
          if (dying || exited) return;
          exited = true;
          playedExitIndex = cursor;
          closeDeferred = step.close === false;
          io.exit({
            code: step.code ?? null,
            signal: step.signal ?? null,
            close: !closeDeferred,
            closeDelayMs: (step.closeDelayMs ?? 0) * timeScale,
          });
          break;
        }
        case 'close':
          if (exited && closeDeferred) {
            await paceFor(step);
            closeDeferred = false;
            io.close();
          }
          break;
        default:
          errors.push(`unsupported step ${step.kind}`);
      }
      notify();
    }
  }

  const run = {
    meta,
    steps,
    captures,
    idMap,
    errors,
    done,
    get cursor() { return cursor; },
    get killed() { return killed; },
    get exited() { return exited; },
    get finished() { return finished; },
    get stdinEnded() { return stdinEnded; },
    /** Every frame the adapter wrote, in order (parsed JSON, `{line}` or `{text}`). */
    get stdinFrames() {
      if (stdinMode === 'text') return [{ text: stdinText, end: stdinEnded }];
      return inbound.map((entry) => ('json' in entry ? entry.json : { line: entry.line }));
    },
    /** Frames no step consumed and no `meta.ignoreOutbound` matcher covers. */
    get unexpected() {
      if (stdinMode === 'text') {
        const pending = inbound.some((entry) => !entry.matched);
        return pending ? [{ text: stdinText }] : [];
      }
      return inbound
        .filter((entry) => !entry.matched && !entry.ignorable)
        .map((entry) => ('json' in entry ? entry.json : { line: entry.line }));
    },
    /** Steps the script did not reach, except informational records. */
    leftover() {
      return steps.slice(cursor).flatMap((step, offset) => {
        if (step.kind === 'close' || step.kind === 'spawn') return [];
        if (cursor + offset === playedExitIndex) return [];
        if (step.kind === 'in' && stdinMode === 'text' && step.end !== true) return [];
        return [describeStep(step, cursor + offset)];
      });
    },
    feed(chunk) {
      if (stdinEnded) return;
      const text = typeof chunk === 'string' ? chunk : decoder.write(Buffer.from(chunk));
      if (stdinMode === 'text') {
        stdinText += text;
        const entry = { text, matched: false, ignorable: false };
        inbound.push(entry);
        onWrite?.({ text });
        notify();
        return;
      }
      partialLine += text;
      let newline = partialLine.indexOf('\n');
      while (newline >= 0) {
        const line = partialLine.slice(0, newline).trim();
        partialLine = partialLine.slice(newline + 1);
        if (line) addLine(line, false);
        newline = partialLine.indexOf('\n');
      }
      notify();
    },
    feedEnd() {
      if (stdinEnded) return;
      if (stdinMode === 'ndjson') {
        const rest = (partialLine + decoder.end()).trim();
        partialLine = '';
        if (rest) addLine(rest, true);
      } else {
        stdinText += decoder.end();
      }
      stdinEnded = true;
      onWrite?.({ end: true });
      notify();
    },
    /**
     * The adapter terminated the process. A pending or upcoming `await-kill`
     * absorbs it; otherwise the process dies now with `exit(null, signal)`.
     * Returns false when the process had already exited.
     */
    kill(signal = 'SIGTERM') {
      if (exited || dying) return false;
      const repeated = killed;
      killed = true;
      // A scripted kill, a repeated signal while the script plays its own
      // shutdown, or a kill racing a process that is already finishing on
      // its own (Windows adapters terminate right after the terminal frame)
      // lets the script continue. Anything else dies now.
      if (hasAwaitKillAhead() || (repeated && hasExitAhead()) || naturalExitPending()) {
        notify();
        return true;
      }
      dying = true;
      exited = true;
      notify();
      setImmediate(() => io.exit({ code: null, signal, close: true, closeDelayMs: 0 }));
      return true;
    },
  };

  function addLine(line, partial) {
    let entry;
    try {
      entry = { json: JSON.parse(line), matched: false, ignorable: false };
    } catch {
      entry = { line, matched: false, ignorable: false };
    }
    if (partial) entry.partial = true;
    entry.ignorable = ignorable(entry);
    inbound.push(entry);
    onWrite?.('json' in entry ? { json: entry.json } : { line: entry.line });
  }

  run.start = () => {
    play().catch((error) => {
      errors.push(`replay engine failed: ${error?.stack ?? error}`);
    }).finally(() => {
      finished = true;
      resolveDone();
      onChange?.(run);
    });
    return run;
  };
  return run;
}

/** Problems that make a run fail its replay: leftover steps, unexpected frames, script errors. */
export function replayRunProblems(run, label = 'process') {
  const problems = [];
  for (const step of run.leftover()) problems.push(`${label}: leftover step ${step}`);
  for (const frame of run.unexpected) problems.push(`${label}: unexpected frame ${JSON.stringify(frame).slice(0, 400)}`);
  for (const error of run.errors) problems.push(`${label}: ${error}`);
  return problems;
}

/** Throw listing leftover steps and unexpected frames, if any. */
export function assertRunConsumed(run, label = 'process') {
  const problems = replayRunProblems(run, label);
  if (problems.length > 0) {
    const error = new Error(`provider replay was not consumed cleanly:\n${problems.join('\n')}`);
    error.problems = problems;
    throw error;
  }
}
