/**
 * Provider transcript recorder. Off unless `RHWP_PROVIDER_TRANSCRIPT_DIR` is an
 * absolute directory when the hub spawns a provider CLI.
 *
 * Each provider process becomes one NDJSON file in the replay format read by
 * `tests/provider-replay/replay.mjs`: a `meta` line, a `spawn` line (redacted
 * argv, environment variable names only), then `in` (adapter -> CLI stdin),
 * `out` (stdout lines), `err` (stderr chunks), `await-kill` (the hub started
 * terminating the process), `exit` and `close`, each with `t` in ms since the
 * spawn. Concatenating the files of one session gives a replayable bundle.
 *
 * Credentials are removed before anything reaches disk: JSON lines are parsed
 * and every string is redacted (values under secret-named keys become
 * "[redacted]"), then re-serialized so the line stays valid JSON; other text
 * goes through `redactDiagnosticText`. Prompts and document text are kept, so
 * the files are private (directory 0700, files 0600) and the hub says so once
 * on stderr. Records are capped at 64 KiB, files at 8 MiB (then one
 * `truncated` record), and a hub process writes at most 200 files. The
 * recorder never throws into an adapter: any failure stops that file.
 */
import { spawn as spawnChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { StringDecoder } from 'node:string_decoder';

import { redactDiagnosticText } from './agents/backend.mjs';
import { PROVIDER_TERMINATION_HOOK } from './process-tree.mjs';

export const PROVIDER_TRANSCRIPT_ENV = 'RHWP_PROVIDER_TRANSCRIPT_DIR';
export const PROVIDER_TRANSCRIPT_LIMITS = Object.freeze({
  maxRecordBytes: 64 * 1024,
  maxFileBytes: 8 * 1024 * 1024,
  maxFiles: 200,
});

const TRANSPORT_STDIN = Object.freeze({
  sdk: 'ndjson',
  cli: 'ndjson',
  'app-server': 'ndjson',
  exec: 'text',
  json: 'text',
});
const REDACTED = '[redacted]';
const SECRET_JSON_KEY = /^(?:access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|apikey|x[_-]api[_-]key|authorization|proxy[_-]?authorization|cookie|set[_-]?cookie|password|passwd|secret|client[_-]?secret|token|bearer[_-]?token|session[_-]?key|oauth[_-]?code|authorization[_-]?code|user[_-]?code|code[_-]?verifier)$/i;
const CREDENTIAL_NAME = /(?:API_KEY|AUTH_TOKEN|OAUTH_TOKEN|ACCESS_TOKEN|REFRESH_TOKEN|SECRET|ACCESS_KEY|BEARER|PASSWORD|_TOKEN$|^TOKEN$)/i;
const MAX_JSON_DEPTH = 64;
const TRUNCATED_RESERVE_BYTES = 128;

let filesOpened = 0;
let fileLimitLogged = false;
const announcedDirs = new Set();
const failedDirs = new Set();
let relativeDirLogged = false;
let fileSequence = 0;

/** Absolute recording directory, or null when recording is off. */
export function providerTranscriptDir(env = process.env) {
  const value = env?.[PROVIDER_TRANSCRIPT_ENV];
  if (typeof value !== 'string' || !value.trim()) return null;
  if (!path.isAbsolute(value)) {
    if (!relativeDirLogged) {
      relativeDirLogged = true;
      process.stderr.write(`[provider-transcript] ${PROVIDER_TRANSCRIPT_ENV} must be an absolute path; recording is off\n`);
    }
    return null;
  }
  return path.resolve(value);
}

function credentialValues(env) {
  if (!env || typeof env !== 'object') return [];
  return Object.entries(env)
    .filter(([name, value]) => CREDENTIAL_NAME.test(name) && typeof value === 'string' && value.length >= 8)
    .map(([, value]) => value);
}

function redactString(value, secrets) {
  return redactDiagnosticText(value, secrets);
}

function redactLeaves(value, depth) {
  if (typeof value === 'string') return REDACTED;
  if (depth > MAX_JSON_DEPTH || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => redactLeaves(item, depth + 1));
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactLeaves(item, depth + 1)]));
}

/** Redact every string in a parsed JSON value; secret-named keys lose their string values. */
export function redactTranscriptJson(value, secrets = [], depth = 0) {
  if (typeof value === 'string') return redactString(value, secrets);
  if (value === null || typeof value !== 'object') return value;
  if (depth > MAX_JSON_DEPTH) return redactString(JSON.stringify(value), secrets);
  if (Array.isArray(value)) return value.map((item) => redactTranscriptJson(item, secrets, depth + 1));
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    redactString(key, secrets),
    SECRET_JSON_KEY.test(key) || CREDENTIAL_NAME.test(key)
      ? redactLeaves(item, depth + 1)
      : redactTranscriptJson(item, secrets, depth + 1),
  ]));
}

/** Redact one argv element; JSON arguments (`--mcp-config {...}`) stay valid JSON. */
function redactArg(arg, secrets) {
  const text = String(arg ?? '');
  const trimmed = text.trim();
  if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    try {
      return JSON.stringify(redactTranscriptJson(JSON.parse(trimmed), secrets));
    } catch {
      // Not JSON after all; fall through to text redaction.
    }
  }
  return redactString(text, secrets);
}

function longestString(value, depth = 0) {
  if (typeof value === 'string') return value.length;
  if (value === null || typeof value !== 'object' || depth > MAX_JSON_DEPTH) return 0;
  let longest = 0;
  for (const item of Array.isArray(value) ? value : Object.values(value)) {
    longest = Math.max(longest, longestString(item, depth + 1));
  }
  return longest;
}

function cutStrings(value, limit, depth = 0) {
  if (typeof value === 'string') return value.length > limit ? value.slice(0, limit) : value;
  if (value === null || typeof value !== 'object' || depth > MAX_JSON_DEPTH) return value;
  if (Array.isArray(value)) return value.map((item) => cutStrings(item, limit, depth + 1));
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cutStrings(item, limit, depth + 1)]));
}

function cutTextToBytes(text, maxBytes) {
  if (maxBytes <= 0) return '';
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.length <= maxBytes) return text;
  return buffer.subarray(0, maxBytes).toString('utf8').replace(/�+$/, '');
}

/**
 * Serialize a record within `maxBytes`: long JSON string values are cut
 * (the record gains `truncatedBytes`), text fields are cut to fit.
 */
export function boundTranscriptRecord(record, maxBytes) {
  const full = JSON.stringify(record);
  const fullBytes = Buffer.byteLength(full);
  if (fullBytes <= maxBytes) return full;
  const budget = maxBytes - TRUNCATED_RESERVE_BYTES;
  if ('json' in record) {
    let low = 0;
    let high = longestString(record.json);
    let best = null;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const candidate = JSON.stringify({ ...record, json: cutStrings(record.json, middle) });
      if (Buffer.byteLength(candidate) <= budget) {
        best = middle;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    if (best !== null) {
      const json = cutStrings(record.json, best);
      const bytes = Buffer.byteLength(JSON.stringify({ ...record, json }));
      return JSON.stringify({ ...record, json, truncatedBytes: fullBytes - bytes });
    }
    // Too many small values to fit even with empty strings: keep a prefix of the line.
    const { json, ...rest } = record;
    const line = JSON.stringify(json);
    const overhead = Buffer.byteLength(JSON.stringify({ ...rest, line: '' }));
    const kept = cutTextToBytes(line, budget - overhead);
    return JSON.stringify({ ...rest, line: kept, truncatedBytes: Buffer.byteLength(line) - Buffer.byteLength(kept) });
  }
  const field = typeof record.line === 'string' ? 'line' : 'text';
  const value = String(record[field] ?? '');
  const overhead = Buffer.byteLength(JSON.stringify({ ...record, [field]: '' }));
  const kept = cutTextToBytes(value, budget - overhead);
  return JSON.stringify({ ...record, [field]: kept, truncatedBytes: Buffer.byteLength(value) - Buffer.byteLength(kept) });
}

function openTranscriptFile(dir, agent, transport) {
  if (failedDirs.has(dir)) return null;
  if (filesOpened >= PROVIDER_TRANSCRIPT_LIMITS.maxFiles) {
    if (!fileLimitLogged) {
      fileLimitLogged = true;
      process.stderr.write(`[provider-transcript] ${PROVIDER_TRANSCRIPT_LIMITS.maxFiles} files recorded; recording stopped for this hub process\n`);
    }
    return null;
  }
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (!announcedDirs.has(dir)) {
      announcedDirs.add(dir);
      process.stderr.write(`[provider-transcript] recording provider stdio to ${dir}; files contain prompts and document text\n`);
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const name = `${agent}-${transport}-${stamp}-${process.pid}-${++fileSequence}.ndjson`;
    const file = path.join(dir, name);
    const fd = fs.openSync(file, 'wx', 0o600);
    filesOpened += 1;
    return { file, fd };
  } catch (error) {
    failedDirs.add(dir);
    process.stderr.write(`[provider-transcript] cannot record to ${dir}: ${redactDiagnosticText(error?.message ?? error)}\n`);
    return null;
  }
}

function createTranscriptWriter({ file, fd, limits }) {
  const startedAt = performance.now();
  let bytes = 0;
  let open = true;
  const stop = () => {
    if (!open) return;
    open = false;
    try { fs.closeSync(fd); } catch {}
  };
  const writeLine = (text) => {
    const line = `${text}\n`;
    fs.writeSync(fd, line);
    bytes += Buffer.byteLength(line);
  };
  return {
    file,
    get open() { return open; },
    now() {
      return Math.round((performance.now() - startedAt) * 10) / 10;
    },
    write(record) {
      if (!open) return false;
      try {
        const text = boundTranscriptRecord(record, limits.maxRecordBytes);
        const size = Buffer.byteLength(text) + 1;
        if (bytes + size > limits.maxFileBytes - TRUNCATED_RESERVE_BYTES) {
          writeLine(JSON.stringify({ kind: 'truncated', t: this.now() }));
          stop();
          return false;
        }
        writeLine(text);
        return true;
      } catch {
        stop();
        return false;
      }
    },
    stop,
  };
}

/** Decode a stream chunk (string or bytes) as UTF-8 text. */
function chunkText(decoder, chunk) {
  if (typeof chunk === 'string') return chunk;
  return decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
}

/** Line splitter with a bounded buffer; `onLine(text, partial)`. */
function createLineSplitter(onLine, maxLineBytes) {
  const decoder = new StringDecoder('utf8');
  let buffer = '';
  let discarding = false;
  const take = (text) => {
    let rest = text;
    for (;;) {
      const newline = rest.indexOf('\n');
      if (newline < 0) break;
      const piece = rest.slice(0, newline);
      rest = rest.slice(newline + 1);
      if (discarding) {
        discarding = false;
        buffer = '';
        continue;
      }
      onLine(buffer + piece, false);
      buffer = '';
    }
    if (discarding) return;
    buffer += rest;
    if (buffer.length > maxLineBytes) {
      onLine(buffer, true);
      buffer = '';
      discarding = true;
    }
  };
  return {
    write(chunk) {
      take(chunkText(decoder, chunk));
    },
    end() {
      const rest = decoder.end();
      if (rest) take(rest);
      if (buffer && !discarding) onLine(buffer, true);
      buffer = '';
    },
  };
}

/**
 * Record `child`'s stdio when recording is on; returns `child` itself in
 * every case. `options.hubEnv` (default `process.env`) decides whether
 * recording is on; `options.env` is the child's environment (names are
 * recorded, credential-named values are redacted wherever they appear).
 *
 * @template T
 * @param {T} child
 * @param {{
 *   agent: 'claude'|'codex'|'pi',
 *   transport: 'sdk'|'cli'|'app-server'|'exec'|'json',
 *   argv?: string[],
 *   env?: Record<string, string|undefined>,
 *   secrets?: Array<string|null|undefined>,
 *   stdin?: 'ndjson'|'text',
 *   cli?: string|null,
 *   hubEnv?: NodeJS.ProcessEnv,
 *   limits?: Partial<typeof PROVIDER_TRANSCRIPT_LIMITS>,
 * }} options
 * @returns {T}
 */
export function tapProviderProcess(child, options) {
  const dir = providerTranscriptDir(options?.hubEnv ?? process.env);
  if (!dir || !child || typeof child !== 'object') return child;
  try {
    tapChild(/** @type {any} */ (child), dir, options);
  } catch (error) {
    process.stderr.write(`[provider-transcript] recording failed: ${redactDiagnosticText(error?.message ?? error)}\n`);
  }
  return child;
}

function tapChild(child, dir, {
  agent,
  transport,
  argv = [],
  env = {},
  secrets = [],
  stdin = TRANSPORT_STDIN[transport] ?? 'ndjson',
  cli = null,
  limits: limitOverrides = {},
}) {
  const limits = { ...PROVIDER_TRANSCRIPT_LIMITS, ...limitOverrides };
  const opened = openTranscriptFile(dir, agent, transport);
  if (!opened) return;
  const writer = createTranscriptWriter({ ...opened, limits });
  const secretValues = [
    ...secrets.filter((value) => typeof value === 'string' && value.length >= 4),
    ...credentialValues(env),
  ];
  const redactText = (text) => redactString(text, secretValues);
  const lineRecord = (kind, text, extra = {}) => {
    const trimmed = text.replace(/\r$/, '');
    try {
      return { kind, t: writer.now(), json: redactTranscriptJson(JSON.parse(trimmed), secretValues), ...extra };
    } catch {
      return { kind, t: writer.now(), line: redactText(trimmed), ...extra };
    }
  };

  writer.write({
    kind: 'meta',
    v: 1,
    agent,
    transport,
    stdin,
    provenance: 'recorded',
    cli: typeof cli === 'string' && cli.trim() ? cli.trim() : 'unknown',
    recordedAt: new Date().toISOString(),
    note: 'Recorded by the hub; holds prompts and document text. Trim before committing as a fixture.',
  });
  writer.write({
    kind: 'spawn',
    t: 0,
    argv: Array.from(argv ?? [], (arg) => redactArg(arg, secretValues)),
    envNames: Object.keys(env ?? {}).sort(),
  });

  let exitInfo = null;
  let exitWritten = false;
  let closed = false;
  let killNoted = false;
  const writeExit = (close) => {
    if (!exitInfo || exitWritten) return;
    exitWritten = true;
    writer.write({ kind: 'exit', t: exitInfo.t, code: exitInfo.code, signal: exitInfo.signal, ...(close ? {} : { close: false }) });
  };
  const beforeOutput = () => { if (exitInfo && !exitWritten) writeExit(false); };

  // stdin: adapter -> CLI.
  let stdinEnded = false;
  const stdinLines = createLineSplitter((line, partial) => {
    if (!line.trim()) return;
    writer.write(lineRecord('in', line, partial ? { partial: true } : {}));
  }, limits.maxFileBytes);
  const stdinDecoder = new StringDecoder('utf8');
  const recordStdin = (chunk) => {
    if (stdinEnded || chunk === undefined || chunk === null || typeof chunk === 'function') return;
    if (stdin === 'text') {
      const text = chunkText(stdinDecoder, chunk);
      if (text) writer.write({ kind: 'in', t: writer.now(), text: redactText(text) });
    } else {
      stdinLines.write(chunk);
    }
  };
  const recordStdinEnd = () => {
    if (stdinEnded) return;
    if (stdin === 'text') {
      const rest = stdinDecoder.end();
      if (rest) writer.write({ kind: 'in', t: writer.now(), text: redactText(rest) });
    } else {
      stdinLines.end();
    }
    stdinEnded = true;
    writer.write({ kind: 'in', t: writer.now(), end: true });
  };
  const input = child.stdin;
  if (input && typeof input.write === 'function' && typeof input.end === 'function') {
    const originalWrite = input.write;
    const originalEnd = input.end;
    let ending = false;
    input.write = function tappedWrite(chunk) {
      if (!ending) {
        try { recordStdin(chunk); } catch {}
      }
      return originalWrite.apply(this, arguments);
    };
    input.end = function tappedEnd(chunk) {
      try {
        recordStdin(chunk);
        recordStdinEnd();
      } catch {}
      ending = true;
      try {
        return originalEnd.apply(this, arguments);
      } finally {
        ending = false;
      }
    };
  }

  // stdout/stderr: wrap `push`, the point where data arrives, so the tap
  // neither switches the streams to flowing mode nor races a consumer that
  // attaches its reader later (the Agent SDK does).
  const stdoutLines = createLineSplitter((line, partial) => {
    if (!line.trim()) return;
    beforeOutput();
    writer.write(lineRecord('out', line, partial ? { partial: true } : {}));
  }, limits.maxFileBytes);
  const stderrDecoder = new StringDecoder('utf8');
  const tapReadable = (stream, onChunk, onEnd) => {
    if (!stream || typeof stream.push !== 'function') return;
    const originalPush = stream.push;
    stream.push = function tappedPush(chunk) {
      try {
        if (chunk === null) onEnd();
        else if (chunk !== undefined) onChunk(chunk);
      } catch {}
      return originalPush.apply(this, arguments);
    };
  };
  let stdoutEnded = false;
  const endStdout = () => {
    if (stdoutEnded) return;
    stdoutEnded = true;
    stdoutLines.end();
  };
  tapReadable(child.stdout, (chunk) => stdoutLines.write(chunk), endStdout);
  tapReadable(child.stderr, (chunk) => {
    const text = chunkText(stderrDecoder, chunk);
    if (!text) return;
    beforeOutput();
    writer.write({ kind: 'err', t: writer.now(), text: redactText(text) });
  }, () => {});

  // The hub's termination reaches the child through `kill` (SDK, pid-less
  // fallbacks) or through terminateProcessTree's hook.
  const noteKill = (signal = 'SIGTERM') => {
    if (killNoted || exitInfo || closed) return;
    killNoted = true;
    writer.write({ kind: 'await-kill', t: writer.now(), signal: typeof signal === 'string' ? signal : 'SIGTERM' });
  };
  if (typeof child.kill === 'function') {
    const originalKill = child.kill;
    child.kill = function tappedKill(signal) {
      try { noteKill(signal); } catch {}
      return originalKill.apply(this, arguments);
    };
  }
  child[PROVIDER_TERMINATION_HOOK] = noteKill;

  child.once?.('exit', (code, signal) => {
    exitInfo = { t: writer.now(), code: code ?? null, signal: signal ?? null };
  });
  child.once?.('close', (code, signal) => {
    closed = true;
    endStdout();
    exitInfo ??= { t: writer.now(), code: code ?? null, signal: signal ?? null };
    if (!exitWritten) writeExit(true);
    writer.write({ kind: 'close', t: writer.now() });
    writer.stop();
  });
}

/**
 * While recording, the Agent SDK's spawn hook: spawns the CLI the way the
 * SDK's own local spawn does (pipes, `windowsHide`, the forwarded abort
 * signal) and taps it. The SDK never reads stderr from a custom process, so
 * the tap drains it to keep the pipe from filling. Returns undefined when
 * recording is off so the SDK keeps its own spawn.
 */
export function recordingClaudeSdkSpawner({ secrets = [], cli = null, hubEnv = process.env } = {}) {
  if (!providerTranscriptDir(hubEnv)) return undefined;
  return (sdkOptions) => {
    const child = spawnChildProcess(sdkOptions.command, sdkOptions.args, {
      cwd: sdkOptions.cwd,
      env: sdkOptions.env,
      signal: sdkOptions.signal,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    child.stderr?.resume();
    return tapProviderProcess(child, {
      agent: 'claude',
      transport: 'sdk',
      stdin: 'ndjson',
      argv: sdkOptions.args,
      env: sdkOptions.env,
      secrets,
      cli,
      hubEnv,
    });
  };
}
