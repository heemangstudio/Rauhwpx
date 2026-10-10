/**
 * Provider transcript recorder. Off unless `RHWP_PROVIDER_TRANSCRIPT_DIR` is an
 * absolute directory when the hub spawns a provider CLI.
 *
 * Each provider process becomes one NDJSON file in the replay format read by
 * `tests/provider-replay/replay.mjs`: a `meta` line (with the recording
 * `platform`), a `spawn` line (redacted argv, environment variable names only),
 * then `in` (adapter -> CLI stdin), `out` (stdout lines), `err` (stderr lines),
 * `await-kill` (the hub started terminating the process), `exit` and `close`,
 * each with `t` in ms since the spawn. Concatenating the files of one session
 * gives a replayable bundle.
 *
 * Credentials are removed before anything reaches disk: stdout, stdin and
 * stderr are split into lines first, so a secret split across pipe chunks is
 * still whole when it is redacted. JSON lines are parsed and every string is
 * redacted (values under secret-named keys such as `authToken` or
 * `anthropicApiKey` become "[redacted]"; token counts like `input_tokens`
 * stay), then re-serialized so the line stays valid JSON; other text goes
 * through `redactDiagnosticText` plus a JWT rule. Prompts and document text
 * are kept, so the files are private and the hub says so once on stderr. On
 * POSIX the directory is created 0700 and files 0600; an existing directory
 * is refused (one stderr warning) when it is a symbolic link, belongs to
 * another user or is group- or world-writable, and is otherwise narrowed to
 * 0700. On Windows mode bits are ignored and the files inherit the
 * directory's ACL, so point the variable at a folder only you can read (e.g.
 * under %LOCALAPPDATA%).
 *
 * The desktop app's hub (RHWP_AGENT_MODE or NODE_ENV `production`) ignores
 * the variable unless `RHWP_PROVIDER_TRANSCRIPT_ALLOW_PRODUCTION=1` is set as
 * well, so a directory left in a shell profile never records a user's
 * documents by accident.
 *
 * Bounds: records are capped at 64 KiB, files at 8 MiB (then one `truncated`
 * record), a hub process writes at most 200 files, and at its first recording
 * a hub process deletes transcript files older than 14 days and then the
 * oldest beyond 400 files or 1 GiB (only regular files named like ours). The
 * recorder never throws into an adapter: any failure stops that file.
 */
import { spawn as spawnChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { StringDecoder } from 'node:string_decoder';

import { redactableTail, redactDiagnosticText } from './agents/backend.mjs';
import { PROVIDER_TERMINATION_HOOK } from './process-tree.mjs';

export const PROVIDER_TRANSCRIPT_ENV = 'RHWP_PROVIDER_TRANSCRIPT_DIR';
/** Second opt-in the desktop app's (production) hub needs before it records. */
export const PROVIDER_TRANSCRIPT_PRODUCTION_ENV = 'RHWP_PROVIDER_TRANSCRIPT_ALLOW_PRODUCTION';
export const PROVIDER_TRANSCRIPT_LIMITS = Object.freeze({
  maxRecordBytes: 64 * 1024,
  maxFileBytes: 8 * 1024 * 1024,
  maxFiles: 200,
  /** Directory budget enforced once per hub process, before its first file. */
  maxDirFiles: 400,
  maxDirBytes: 1024 * 1024 * 1024,
  /** Transcript files older than this are deleted with the directory budget. */
  maxFileAgeMs: 14 * 24 * 60 * 60 * 1000,
});
/** The Agent SDK's own stderr tail for exit errors (sdk.mjs `MC`). */
const SDK_STDERR_TAIL_CHARS = 2048;
const TRANSCRIPT_FILE_NAME = /^(?:claude|codex|pi)-(?:sdk|cli|app-server|exec|json)-.+\.ndjson$/;

const TRANSPORT_STDIN = Object.freeze({
  sdk: 'ndjson',
  cli: 'ndjson',
  'app-server': 'ndjson',
  exec: 'text',
  json: 'text',
});
const REDACTED = '[redacted]';
/**
 * Secret-named JSON keys, matched on the key lowercased without separators
 * (`authToken`, `session_token`, `x-api-key`, `anthropicApiKey`). Suffixes are
 * singular, so usage counters (`input_tokens`, `totalTokens`) never match;
 * numbers and booleans under a matching key are kept anyway.
 */
const SECRET_JSON_KEY_SUFFIX = /(?:token|apikey|secret|secretkey|accesskey|privatekey|sessionkey|passw(?:or)?d|passphrase|authorization|cookies?|credentials?|oauthcode|usercode|codeverifier)$/;
/**
 * header.payload.signature of a JSON Web Token (the signature may be empty), starting at
 * the first `eyJ` after a word boundary — also inside a hyphenated word (`x-eyJ…`). The
 * header runs to the end of its [A-Za-z0-9_-] run, so when the run's first `eyJ` cannot
 * start a token no later `eyJ` in the run can either: the (non-backtracking) lookahead
 * tries only that one from the run's start and $1 puts back the word part before it.
 * Rescanning the run from every `eyJ` would make `-eyJ-eyJ…` quadratic.
 */
const JWT_SHAPED = /(?<![\w-])(?=((?:\w*-)*?)eyJ)\1eyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]*/g;
const CREDENTIAL_NAME = /(?:API_KEY|AUTH_TOKEN|OAUTH_TOKEN|ACCESS_TOKEN|REFRESH_TOKEN|SECRET|ACCESS_KEY|BEARER|PASSWORD|_TOKEN$|^TOKEN$)/i;
const MAX_JSON_DEPTH = 64;
const TRUNCATED_RESERVE_BYTES = 128;

let filesOpened = 0;
let fileLimitLogged = false;
const announcedDirs = new Set();
const prunedDirs = new Set();
const failedDirs = new Set();
let relativeDirLogged = false;
let productionLogged = false;
let fileSequence = 0;

/** Absolute recording directory, or null when recording is off. */
export function providerTranscriptDir(env = process.env) {
  const value = env?.[PROVIDER_TRANSCRIPT_ENV];
  if (typeof value !== 'string' || !value.trim()) return null;
  const production = env.NODE_ENV === 'production' || env.RHWP_AGENT_MODE === 'production';
  if (production && env[PROVIDER_TRANSCRIPT_PRODUCTION_ENV] !== '1') {
    if (!productionLogged) {
      productionLogged = true;
      process.stderr.write(`[provider-transcript] ${PROVIDER_TRANSCRIPT_ENV} is ignored by the desktop app's hub; set ${PROVIDER_TRANSCRIPT_PRODUCTION_ENV}=1 as well to record\n`);
    }
    return null;
  }
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
  return redactDiagnosticText(value, secrets).replace(JWT_SHAPED, `$1${REDACTED}`);
}

function isSecretJsonKey(key) {
  const normalized = String(key).toLowerCase().replace(/[^a-z0-9]/g, '');
  return SECRET_JSON_KEY_SUFFIX.test(normalized) || CREDENTIAL_NAME.test(key);
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
    isSecretJsonKey(key)
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
 * The longest per-string cut of `value` (a record or its `json`) that fits
 * `budget` once rebuilt by `rebuild`, or null when even empty strings do not.
 */
function fitStrings(value, rebuild, budget) {
  let low = 0;
  let high = longestString(value);
  let best = null;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (Buffer.byteLength(JSON.stringify(rebuild(cutStrings(value, middle)))) <= budget) {
      best = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return best;
}

/**
 * Serialize a record within `maxBytes`: long JSON string values are cut
 * (the record gains `truncatedBytes`), text fields are cut to fit, and the
 * strings of other records (`spawn` argv, `meta`) are cut the same way.
 */
export function boundTranscriptRecord(record, maxBytes) {
  const full = JSON.stringify(record);
  const fullBytes = Buffer.byteLength(full);
  if (fullBytes <= maxBytes) return full;
  const budget = maxBytes - TRUNCATED_RESERVE_BYTES;
  if (!('json' in record) && typeof record.line !== 'string' && typeof record.text !== 'string') {
    const { kind, ...fields } = record;
    const rebuild = (cut) => ({ kind, ...cut });
    const best = fitStrings(fields, rebuild, budget);
    const bounded = best === null
      ? { kind, ...(Number.isFinite(record.t) ? { t: record.t } : {}) }
      : rebuild(cutStrings(fields, best));
    const bytes = Buffer.byteLength(JSON.stringify(bounded));
    return JSON.stringify({ ...bounded, truncatedBytes: fullBytes - bytes });
  }
  if ('json' in record) {
    const rebuild = (json) => ({ ...record, json });
    const best = fitStrings(record.json, rebuild, budget);
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

/**
 * Refuse a recording directory other users could read, swap or fill: on POSIX
 * it must be a real directory (not a symbolic link) owned by this user and not
 * group- or world-writable; it is then narrowed to 0700, since `mkdirSync`'s
 * mode applies only to a directory it creates. Returns why it was refused, or
 * null. Windows has no mode bits; the folder's ACL decides.
 */
function insecureTranscriptDir(dir) {
  if (process.platform === 'win32') return null;
  const link = fs.lstatSync(dir);
  if (link.isSymbolicLink()) return 'it is a symbolic link';
  if (!link.isDirectory()) return 'it is not a directory';
  const { O_RDONLY, O_DIRECTORY = 0, O_NOFOLLOW = 0 } = fs.constants;
  const fd = fs.openSync(dir, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isDirectory()) return 'it is not a directory';
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) return 'it belongs to another user';
    if (stat.mode & 0o022) return 'other users can write to it';
    if ((stat.mode & 0o777) !== 0o700) fs.fchmodSync(fd, 0o700);
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Keep the directory within its budget across hub restarts: delete transcript
 * files older than `maxFileAgeMs`, then the oldest (by mtime) until at most
 * `maxDirFiles` and `maxDirBytes` remain; only regular files with names the
 * recorder writes, never links or other files. Runs once per directory per
 * hub process, before its first file; a file this process opens later is
 * bounded by `maxFiles` and `maxFileBytes`.
 */
function pruneTranscriptDir(dir, limits) {
  if (prunedDirs.has(dir)) return;
  prunedDirs.add(dir);
  let files;
  try {
    files = fs.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && TRANSCRIPT_FILE_NAME.test(entry.name))
      .flatMap((entry) => {
        const file = path.join(dir, entry.name);
        try {
          const stat = fs.lstatSync(file);
          return stat.isFile() ? [{ file, size: stat.size, mtimeMs: stat.mtimeMs }] : [];
        } catch {
          return [];
        }
      })
      .sort((left, right) => left.mtimeMs - right.mtimeMs || left.file.localeCompare(right.file));
  } catch {
    return;
  }
  let count = files.length;
  let bytes = files.reduce((sum, entry) => sum + entry.size, 0);
  let removed = 0;
  const cutoff = Date.now() - limits.maxFileAgeMs;
  for (const entry of files) {
    const expired = entry.mtimeMs < cutoff;
    if (!expired && count <= limits.maxDirFiles && bytes <= limits.maxDirBytes) break;
    try {
      fs.unlinkSync(entry.file);
      removed += 1;
    } catch {
      // Still counted: another process may have removed or locked it.
    }
    count -= 1;
    bytes -= entry.size;
  }
  if (removed > 0) {
    process.stderr.write(`[provider-transcript] removed ${removed} transcript file(s) from ${dir} older than ${Math.round(limits.maxFileAgeMs / 86_400_000)} days or beyond ${limits.maxDirFiles} files and ${Math.round(limits.maxDirBytes / (1024 * 1024))} MiB\n`);
  }
}

function openTranscriptFile(dir, agent, transport, limits) {
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
    const refused = insecureTranscriptDir(dir);
    if (refused) {
      failedDirs.add(dir);
      process.stderr.write(`[provider-transcript] not recording to ${dir}: ${refused}; use a private directory only you can write to\n`);
      return null;
    }
    pruneTranscriptDir(dir, limits);
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
 *   platform?: NodeJS.Platform,
 *   hubEnv?: NodeJS.ProcessEnv,
 *   limits?: Partial<typeof PROVIDER_TRANSCRIPT_LIMITS>,
 * }} options `platform` is the adapter's platform (its Windows-only
 *   terminal cleanup shows up as an `await-kill` that replay on another
 *   platform treats as optional).
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
  platform = process.platform,
  limits: limitOverrides = {},
}) {
  const limits = { ...PROVIDER_TRANSCRIPT_LIMITS, ...limitOverrides };
  const opened = openTranscriptFile(dir, agent, transport, limits);
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
    platform: typeof platform === 'string' && platform ? platform : process.platform,
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
    if (!writer.open || !line.trim()) return;
    writer.write(lineRecord('in', line, partial ? { partial: true } : {}));
  }, limits.maxFileBytes);
  const stdinDecoder = new StringDecoder('utf8');
  // Once the file is capped or closed nothing is parsed or redacted any more.
  const recordStdin = (chunk) => {
    if (!writer.open || stdinEnded || chunk === undefined || chunk === null || typeof chunk === 'function') return;
    if (stdin === 'text') {
      const text = chunkText(stdinDecoder, chunk);
      if (text) writer.write({ kind: 'in', t: writer.now(), text: redactText(text) });
    } else {
      stdinLines.write(chunk);
    }
  };
  const recordStdinEnd = () => {
    if (!writer.open || stdinEnded) return;
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
    if (!writer.open || !line.trim()) return;
    beforeOutput();
    writer.write(lineRecord('out', line, partial ? { partial: true } : {}));
  }, limits.maxFileBytes);
  // stderr is split into lines like stdout so a secret written across two
  // chunks is redacted whole; each record keeps its newline, and the
  // unterminated rest is flushed when the stream ends.
  const stderrLines = createLineSplitter((line, partial) => {
    if (!writer.open) return;
    beforeOutput();
    writer.write({ kind: 'err', t: writer.now(), text: `${redactText(line)}${partial ? '' : '\n'}` });
  }, limits.maxFileBytes);
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
    if (writer.open) stdoutLines.end();
  };
  let stderrEnded = false;
  const endStderr = () => {
    if (stderrEnded) return;
    stderrEnded = true;
    if (writer.open) stderrLines.end();
  };
  tapReadable(child.stdout, (chunk) => { if (writer.open) stdoutLines.write(chunk); }, endStdout);
  tapReadable(child.stderr, (chunk) => { if (writer.open) stderrLines.write(chunk); }, endStderr);

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
    endStderr();
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
 * the spawner drains it, keeping the last 2048 characters as the SDK's own
 * spawn does: `stderrTail()` returns them for the most recent process, and
 * `withSdkStderrTail` puts them back into the SDK's exit error. Returns
 * undefined when recording is off so the SDK keeps its own spawn.
 */
export function recordingClaudeSdkSpawner({ secrets = [], cli = null, platform = process.platform, hubEnv = process.env } = {}) {
  if (!providerTranscriptDir(hubEnv)) return undefined;
  let tail = '';
  const spawnRecorded = (sdkOptions) => {
    const child = spawnChildProcess(sdkOptions.command, sdkOptions.args, {
      cwd: sdkOptions.cwd,
      env: sdkOptions.env,
      signal: sdkOptions.signal,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    tail = '';
    const decoder = new StringDecoder('utf8');
    child.stderr?.on('data', (chunk) => {
      tail += decoder.write(chunk);
      // The tail is cut before redaction, so cut at a line boundary: a secret
      // that lost its start (or its `Authorization:` prefix) never survives.
      if (tail.length > 2 * SDK_STDERR_TAIL_CHARS) tail = redactableTail(tail, SDK_STDERR_TAIL_CHARS);
    });
    child.stderr?.once('end', () => { tail += decoder.end(); });
    child.stderr?.on('error', () => {});
    return tapProviderProcess(child, {
      agent: 'claude',
      transport: 'sdk',
      stdin: 'ndjson',
      argv: sdkOptions.args,
      env: sdkOptions.env,
      secrets,
      cli,
      platform,
      hubEnv,
    });
  };
  spawnRecorded.stderrTail = () => tail;
  return spawnRecorded;
}

const SDK_PROCESS_EXIT_ERROR = /Claude Code process (?:exited with code -?\d+|terminated by signal [A-Z0-9]+)/;

/**
 * The Agent SDK appends `. stderr: <tail>` to its process exit errors only for
 * the process it spawned itself. With the recording spawner the tail lives in
 * the spawner; this puts it back where the SDK would, so the error a user sees
 * is the same with and without recording. Other messages pass unchanged.
 */
export function withSdkStderrTail(message, tail, secrets = []) {
  const text = String(message ?? '');
  if (typeof tail !== 'string' || !tail || text.includes('. stderr: ') || !SDK_PROCESS_EXIT_ERROR.test(text)) {
    return text;
  }
  let kept = redactDiagnosticText(tail, secrets);
  if (kept.length > SDK_STDERR_TAIL_CHARS) {
    kept = kept.slice(-SDK_STDERR_TAIL_CHARS);
    const first = kept.charCodeAt(0);
    if (first >= 0xdc00 && first <= 0xdfff) kept = kept.slice(1);
  }
  kept = kept.trim();
  if (!kept) return text;
  return text.replace(SDK_PROCESS_EXIT_ERROR, (phrase) => `${phrase}. stderr: ${kept}`);
}
