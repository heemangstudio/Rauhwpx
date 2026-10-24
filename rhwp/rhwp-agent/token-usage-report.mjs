/**
 * 이 컴퓨터의 Claude · Codex · Pi CLI 가 남긴 로컬 세션 기록에서 기간별 토큰 사용량을 센다.
 * 앱이 띄운 세션만이 아니라 같은 기록 폴더에 쓰는 모든 세션이 대상이다 (ccusage 와 같은 방식).
 *
 * 기록은 수 GB 가 될 수 있다: 파일은 줄 단위로 스트리밍하고, 파일마다 뽑은 사용량 이벤트를
 * 경로 · 크기 · 수정 시각으로 캐시해 다음 요청은 바뀐 파일(또는 늘어난 꼬리)만 읽는다.
 * 보고서와 캐시에는 토큰 수 · 모델 이름 · 세션 id · 시각만 남긴다. 프롬프트나 파일 내용은 담지 않는다.
 */
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { readUtf8FileBounded } from './bounded-file.mjs';
import { replaceFileAtomically } from './harness-update.mjs';
import { defaultUsageRoot } from './usage-store.mjs';

export const TOKEN_USAGE_DAYS = /** @type {const} */ ([7, 30, 90]);
export const TOKEN_USAGE_DEFAULT_DAYS = 30;
const TOKEN_USAGE_AGENTS = /** @type {const} */ (['claude', 'codex', 'pi']);
const CACHE_FILE = 'token-usage-cache.json';
const CACHE_VERSION = 1;
/** 가장 긴 기간(90일)에 하루 여유를 둔다. 이보다 오래된 이벤트와 파일은 캐시에 남기지 않는다. */
const HORIZON_MS = 91 * 24 * 60 * 60 * 1000;
/** 이 길이를 넘는 줄은 건너뛴다 (이미지 붙인 Claude 줄이 수 MB 까지 간다). */
export const MAX_TOKEN_LOG_LINE_BYTES = 16 * 1024 * 1024;
const MAX_CACHE_BYTES = 256 * 1024 * 1024;
const MAX_WALK_DEPTH = 8;
const MAX_TOKEN_COUNT = 1_000_000_000;
const MAX_MODEL_CHARS = 128;
const MAX_ID_CHARS = 128;
/** 같은 파일인지 확인하려고 앞부분을 해시한다 (교체된 파일을 이어 읽지 않도록). */
const HEAD_BYTES = 4096;
/** 짧은 시간 안의 반복 요청은 다시 훑지 않고 마지막 스캔을 쓴다. */
const SCAN_MEMO_MS = 30_000;

/**
 * API 요금 기준 추정용 단가표 (USD / 100만 토큰). 위에서부터 처음 맞는 항목을 쓴다.
 * cacheWrite 는 5분 캐시 쓰기 단가다. 맞는 항목이 없는 모델은 비용을 세지 않는다.
 * 확인: Anthropic 모델표 2026-10-06, OpenAI GPT-6.1 Sol · GPT-6 Astra 는 2026-10 공개 단가.
 */
export const TOKEN_PRICE_TABLE_USD_PER_MTOK = Object.freeze([
  { match: /(fable|mythos)-5[-.]1/, input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
  { match: /(fable|mythos)-5/, input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
  { match: /opus-5[-.]5/, input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  { match: /opus-(5|4[-.][5-8])/, input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  { match: /opus/, input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  { match: /sonnet-5/, input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  { match: /sonnet/, input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  { match: /haiku-5/, input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
  { match: /haiku-4/, input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  { match: /haiku/, input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 },
  { match: /gpt-6[-.]1/, input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
  { match: /gpt-6/, input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
  { match: /gpt-5.*mini/, input: 0.25, output: 2, cacheRead: 0.025, cacheWrite: 0.25 },
  { match: /gpt-5|codex/, input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 1.25 },
]);

/** @param {string} model */
export function priceForModel(model) {
  const id = String(model ?? '').toLowerCase();
  if (!id || id === 'unknown' || id.startsWith('<')) return null;
  return TOKEN_PRICE_TABLE_USD_PER_MTOK.find((row) => row.match.test(id)) ?? null;
}

export function normalizeTokenUsageDays(value) {
  return TOKEN_USAGE_DAYS.includes(value) ? value : TOKEN_USAGE_DEFAULT_DAYS;
}

/**
 * 각 CLI 의 기록 폴더. 없는 폴더는 스캔할 때 건너뛴다.
 * piRoot: 앱이 관리하는 pi 루트 (앱이 띄운 pi 는 그 아래 sessions 에 기록한다).
 */
export function defaultTokenUsageSources({
  env = process.env,
  platform = process.platform,
  home = os.homedir(),
  piRoot = null,
} = {}) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const unique = (dirs) => [...new Set(dirs.map((dir) => p.resolve(dir)))];
  const claudeConfig = typeof env.CLAUDE_CONFIG_DIR === 'string' && env.CLAUDE_CONFIG_DIR.trim()
    ? env.CLAUDE_CONFIG_DIR.split(',').map((dir) => dir.trim()).filter(Boolean)
    : [p.join(home, '.config', 'claude'), p.join(home, '.claude')];
  const codexHome = typeof env.CODEX_HOME === 'string' && env.CODEX_HOME.trim()
    ? env.CODEX_HOME.trim()
    : p.join(home, '.codex');
  const piAgentDir = typeof env.PI_CODING_AGENT_DIR === 'string' && env.PI_CODING_AGENT_DIR.trim()
    ? env.PI_CODING_AGENT_DIR.trim()
    : p.join(home, '.pi', 'agent');
  return {
    claude: unique(claudeConfig.map((dir) => p.join(dir, 'projects'))),
    codex: unique([p.join(codexHome, 'sessions'), p.join(codexHome, 'archived_sessions')]),
    pi: unique([p.join(piAgentDir, 'sessions'), ...(piRoot ? [p.join(piRoot, 'sessions')] : [])]),
  };
}

/**
 * 앱 창마다 격리된 홈(<recordsRoot>/<record>/home)에 쓰는 Claude · Codex 기록 폴더.
 * @returns {Promise<{ claude: string[], codex: string[] }>}
 */
export async function sessionRecordSources(recordsRoot) {
  let names = [];
  try {
    names = (await fs.readdir(recordsRoot, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch { /* 기록 폴더가 아직 없다 */ }
  const homes = names.map((name) => path.join(recordsRoot, name, 'home'));
  return {
    claude: homes.map((home) => path.join(home, '.claude', 'projects')),
    codex: homes.flatMap((home) => [path.join(home, '.codex', 'sessions'), path.join(home, '.codex', 'archived_sessions')]),
  };
}

function toCount(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(Math.round(n), MAX_TOKEN_COUNT);
}

function shortText(value, max) {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null;
}

function timeOf(value) {
  const t = typeof value === 'number' ? value : Date.parse(String(value ?? ''));
  return Number.isFinite(t) ? t : null;
}

function hashKey(value) {
  return createHash('sha256').update(value).digest('base64url').slice(0, 16);
}

/**
 * 파일 하나의 파서. 상태는 JSON 으로 캐시해 늘어난 꼬리부터 이어 읽을 수 있게 한다.
 * 이벤트: [key|null, tSec, modelIdx, sessionIdx, input, output, cacheRead, cacheWrite, costUsd|null]
 */
function createFileAccumulator(entry) {
  const models = entry.models;
  const sessions = entry.sessions;
  const events = entry.events;
  const byKey = new Map();
  events.forEach((event, index) => { if (event[0]) byKey.set(event[0], index); });
  const indexOf = (list, value) => {
    let i = list.indexOf(value);
    if (i < 0) { i = list.length; list.push(value); }
    return i;
  };
  return {
    add({ key, t, model, session, input, output, cacheRead, cacheWrite, costUsd = null }) {
      if (!(input || output || cacheRead || cacheWrite)) return;
      const tSec = Math.floor(t / 1000);
      const cost = typeof costUsd === 'number' && Number.isFinite(costUsd) && costUsd >= 0 ? costUsd : null;
      if (key && byKey.has(key)) {
        // 같은 응답이 스트리밍 중 여러 줄로 남는다. 출력 토큰이 늘어나므로 항목별 최댓값을 쓴다.
        const event = events[byKey.get(key)];
        event[4] = Math.max(event[4], input);
        event[5] = Math.max(event[5], output);
        event[6] = Math.max(event[6], cacheRead);
        event[7] = Math.max(event[7], cacheWrite);
        if (cost !== null) event[8] = Math.max(event[8] ?? 0, cost);
        return;
      }
      const event = [key, tSec, indexOf(models, model), indexOf(sessions, session),
        input, output, cacheRead, cacheWrite, cost];
      if (key) byKey.set(key, events.length);
      events.push(event);
    },
  };
}

/** 줄을 JSON 으로 풀기 전에 바이트로 거른다 — 대부분의 줄은 문자열로 바꾸지도 않는다. */
const NEEDLES = {
  claude: [Buffer.from('"usage"')],
  codex: [Buffer.from('"token_count"'), Buffer.from('"turn_context"'), Buffer.from('"session_meta"')],
  pi: [Buffer.from('"usage"'), Buffer.from('"type":"session"')],
};

function createLineHandler(agent, entry, filePath) {
  const acc = createFileAccumulator(entry);
  const state = entry.state;
  const fallbackSession = shortText(path.basename(filePath).replace(/\.jsonl$/i, ''), MAX_ID_CHARS) ?? 'unknown';

  if (agent === 'claude') {
    return (obj) => {
      const message = obj?.message;
      const usage = message?.usage;
      if (!usage || typeof usage !== 'object') return;
      const t = timeOf(obj.timestamp);
      if (t === null) return;
      const messageId = shortText(message.id, MAX_ID_CHARS);
      const requestId = shortText(obj.requestId, MAX_ID_CHARS);
      acc.add({
        key: messageId && requestId ? hashKey(`c:${messageId}:${requestId}`) : null,
        t,
        model: shortText(message.model, MAX_MODEL_CHARS) ?? 'unknown',
        session: shortText(obj.sessionId, MAX_ID_CHARS) ?? fallbackSession,
        input: toCount(usage.input_tokens),
        output: toCount(usage.output_tokens),
        cacheRead: toCount(usage.cache_read_input_tokens),
        cacheWrite: toCount(usage.cache_creation_input_tokens),
      });
    };
  }

  if (agent === 'codex') {
    return (obj) => {
      const payload = obj?.payload;
      if (!payload || typeof payload !== 'object') return;
      if (obj.type === 'session_meta') {
        state.session = shortText(payload.id ?? payload.session_id, MAX_ID_CHARS) ?? state.session;
        return;
      }
      if (obj.type === 'turn_context') {
        state.model = shortText(payload.model, MAX_MODEL_CHARS) ?? state.model;
        return;
      }
      if (obj.type !== 'event_msg' || payload.type !== 'token_count') return;
      const info = payload.info;
      if (!info || typeof info !== 'object') return;
      const t = timeOf(obj.timestamp);
      if (t === null) return;
      const read = (u) => (u && typeof u === 'object' ? {
        input: toCount(u.input_tokens),
        cached: toCount(u.cached_input_tokens),
        cacheWrite: toCount(u.cache_write_input_tokens),
        output: toCount(u.output_tokens),
      } : null);
      const total = read(info.total_token_usage);
      const last = read(info.last_token_usage);
      const prev = state.prevTotal;
      let delta = null;
      if (total && prev) {
        const keys = ['input', 'cached', 'cacheWrite', 'output'];
        // 같은 누적값이 다시 오면 (재전송 · 상태 이벤트) 새 사용량이 없다.
        if (keys.every((k) => total[k] === prev[k])) { delta = null; }
        else if (keys.every((k) => total[k] >= prev[k])) {
          delta = Object.fromEntries(keys.map((k) => [k, total[k] - prev[k]]));
        } else delta = last;
      } else {
        // 첫 이벤트는 last 를 쓴다: 갈라진(fork) 세션은 부모의 누적값을 이어받아 시작한다.
        delta = last ?? total;
      }
      if (total) state.prevTotal = total;
      if (!delta) return;
      // Codex 의 input_tokens 는 캐시에서 읽은 토큰(cached_input_tokens)을 포함한다.
      const cacheRead = Math.min(delta.cached, delta.input);
      const cacheWrite = Math.min(delta.cacheWrite, delta.input - cacheRead);
      acc.add({
        key: null,
        t,
        model: state.model ?? 'unknown',
        session: state.session ?? fallbackSession,
        input: delta.input - cacheRead - cacheWrite,
        output: delta.output,
        cacheRead,
        cacheWrite,
      });
    };
  }

  return (obj) => {
    if (obj?.type === 'session') {
      state.session = shortText(obj.id, MAX_ID_CHARS) ?? state.session;
      return;
    }
    const message = obj?.message;
    if (obj?.type !== 'message' || message?.role !== 'assistant') return;
    const usage = message.usage;
    if (!usage || typeof usage !== 'object') return;
    const t = timeOf(obj.timestamp) ?? timeOf(message.timestamp);
    if (t === null) return;
    const responseId = shortText(message.responseId, MAX_ID_CHARS);
    const cost = usage.cost && typeof usage.cost === 'object' ? Number(usage.cost.total) : NaN;
    acc.add({
      key: responseId ? hashKey(`p:${responseId}`) : null,
      t,
      model: shortText(message.model, MAX_MODEL_CHARS) ?? 'unknown',
      session: state.session ?? fallbackSession,
      input: toCount(usage.input),
      output: toCount(usage.output),
      cacheRead: toCount(usage.cacheRead),
      cacheWrite: toCount(usage.cacheWrite),
      costUsd: Number.isFinite(cost) ? cost : null,
    });
  };
}

function containsAny(buffer, needles) {
  for (const needle of needles) if (buffer.indexOf(needle) >= 0) return true;
  return false;
}

/**
 * start 부터 마지막 완전한 줄까지 읽는다. 끝에 줄바꿈이 없는 조각은 쓰는 중일 수 있어 다음에 읽는다.
 * maxLineBytes 를 넘는 줄은 통째로 건너뛴다.
 * @returns {Promise<number>} 마지막 줄바꿈 다음 바이트 위치 (다음에 이어 읽을 곳)
 */
async function streamLines(filePath, start, onLine, maxLineBytes) {
  const stream = createReadStream(filePath, { start, highWaterMark: 1024 * 1024 });
  let carry = [];
  let carryBytes = 0;
  let skipping = false;
  let position = start;
  let lineEnd = start;
  for await (const chunk of stream) {
    let from = 0;
    for (;;) {
      const nl = chunk.indexOf(10, from);
      if (nl < 0) {
        const rest = chunk.length - from;
        if (!skipping && carryBytes + rest > maxLineBytes) { skipping = true; carry = []; carryBytes = 0; }
        if (!skipping && rest > 0) { carry.push(chunk.subarray(from)); carryBytes += rest; }
        position += rest;
        break;
      }
      const piece = chunk.subarray(from, nl);
      position += nl + 1 - from;
      lineEnd = position;
      from = nl + 1;
      if (skipping) { skipping = false; continue; }
      if (carryBytes + piece.length > maxLineBytes) { carry = []; carryBytes = 0; continue; }
      const line = carryBytes ? Buffer.concat([...carry, piece]) : piece;
      carry = []; carryBytes = 0;
      onLine(line);
    }
  }
  return lineEnd;
}

async function headHash(filePath, bytes) {
  const length = Math.min(bytes, HEAD_BYTES);
  if (length <= 0) return '';
  const handle = await fs.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return createHash('sha256').update(buffer.subarray(0, bytesRead)).digest('base64url').slice(0, 22);
  } finally {
    await handle.close().catch(() => {});
  }
}

function emptyEntry(agent) {
  return { agent, size: 0, mtimeMs: 0, offset: 0, head: '', models: [], sessions: [], events: [], state: {} };
}

/** 파일을 (처음부터 또는 캐시된 위치부터) 읽어 캐시 항목을 만든다. */
async function parseFile(agent, filePath, stat, cached, horizonSec, maxLineBytes) {
  let entry = null;
  if (cached && cached.agent === agent && stat.size >= cached.offset && cached.offset > 0
    && cached.head === await headHash(filePath, Math.min(cached.offset, HEAD_BYTES))) {
    entry = structuredClone(cached);
  }
  entry ??= emptyEntry(agent);
  const handle = createLineHandler(agent, entry, filePath);
  const needles = NEEDLES[agent];
  // 쓰는 중인 마지막 줄은 다음 스캔에서 읽는다.
  entry.offset = await streamLines(filePath, entry.offset, (line) => {
    if (!containsAny(line, needles)) return;
    let obj;
    try { obj = JSON.parse(line.toString('utf8')); } catch { return; }
    handle(obj);
  }, maxLineBytes);
  entry.head = await headHash(filePath, Math.min(entry.offset, HEAD_BYTES));
  entry.size = stat.size;
  entry.mtimeMs = stat.mtimeMs;
  delete entry.gone;
  if (entry.events.some((event) => event[1] < horizonSec)) {
    entry.events = entry.events.filter((event) => event[1] >= horizonSec);
  }
  return entry;
}

const FILE_MATCHERS = {
  claude: (name) => name.endsWith('.jsonl'),
  codex: (name) => name.endsWith('.jsonl'),
  pi: (name) => name.endsWith('.jsonl'),
};

/** 폴더를 걸어 내려가며 파일을 모은다. 링크는 따라가지 않는다. 루트가 없으면 null. */
async function walk(root, accept, horizonMs) {
  let rootStat;
  try { rootStat = await fs.stat(root); } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null;
    throw error;
  }
  if (!rootStat.isDirectory()) return null;
  const files = [];
  const stack = [[root, 0]];
  while (stack.length) {
    const [dir, depth] = stack.pop();
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch (error) {
      if (dir === root) throw error;
      continue;
    }
    for (const dirent of entries) {
      const full = path.join(dir, dirent.name);
      if (dirent.isDirectory()) {
        if (depth < MAX_WALK_DEPTH) stack.push([full, depth + 1]);
      } else if (dirent.isFile() && accept(dirent.name)) {
        try {
          const stat = await fs.stat(full);
          if (stat.mtimeMs >= horizonMs) files.push({ path: full, size: stat.size, mtimeMs: stat.mtimeMs });
        } catch { /* 사이에 지워진 파일 */ }
      }
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
  return files;
}

function localDateKey(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const PROVIDER_LABELS = { claude: 'Claude', codex: 'Codex', pi: 'Pi' };

/**
 * @param {{ usageRoot?: string,
 *           sources?: () => Record<'claude'|'codex'|'pi', string[]> | Promise<Record<'claude'|'codex'|'pi', string[]>>,
 *           now?: () => number, maxLineBytes?: number, scanMemoMs?: number,
 *           warn?: (message: string) => void }} [options]
 */
export function createTokenUsageReporter({
  usageRoot = defaultUsageRoot(),
  sources = () => defaultTokenUsageSources(),
  now = Date.now,
  maxLineBytes = MAX_TOKEN_LOG_LINE_BYTES,
  scanMemoMs = SCAN_MEMO_MS,
  warn = (message) => process.stderr.write(`[token-usage] ${message}\n`),
} = {}) {
  const cacheFile = path.join(usageRoot, CACHE_FILE);
  /** @type {Map<string, any> | null} path → 파일 캐시 항목 */
  let files = null;
  let lastScan = null; // { at, present: Record<agent, boolean>, errors: string[] }
  let inFlight = null;

  async function loadCache() {
    if (files) return;
    files = new Map();
    try {
      const parsed = JSON.parse(await readUtf8FileBounded(cacheFile, { maxBytes: MAX_CACHE_BYTES, label: 'Token usage cache' }));
      if (parsed?.version === CACHE_VERSION && parsed.files && typeof parsed.files === 'object') {
        for (const [file, entry] of Object.entries(parsed.files)) {
          if (TOKEN_USAGE_AGENTS.includes(entry?.agent) && Array.isArray(entry.events)) files.set(file, entry);
        }
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') warn(`cache ignored: ${error?.code ?? error?.message ?? error}`);
    }
  }

  async function saveCache() {
    await fs.mkdir(usageRoot, { recursive: true });
    const temp = `${cacheFile}.tmp-${process.pid}-${randomUUID()}`;
    try {
      await fs.writeFile(temp, JSON.stringify({ version: CACHE_VERSION, files: Object.fromEntries(files) }),
        { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      await replaceFileAtomically(temp, cacheFile);
    } finally {
      await fs.rm(temp, { force: true }).catch(() => {});
    }
  }

  async function scan() {
    await loadCache();
    const at = now();
    const horizonMs = at - HORIZON_MS;
    const horizonSec = Math.floor(horizonMs / 1000);
    const roots = await sources();
    const seen = new Set();
    const present = { claude: false, codex: false, pi: false };
    const errors = [];
    let changed = false;
    for (const agent of TOKEN_USAGE_AGENTS) {
      let failed = 0;
      for (const root of roots[agent] ?? []) {
        let listed;
        try { listed = await walk(root, FILE_MATCHERS[agent], horizonMs); } catch (error) {
          present[agent] = true;
          failed += 1;
          warn(`${agent} root unreadable: ${error?.code ?? error?.message ?? error}`);
          continue;
        }
        if (!listed) continue;
        present[agent] = true;
        for (const file of listed) {
          if (seen.has(file.path)) continue;
          seen.add(file.path);
          const cached = files.get(file.path);
          if (cached && !cached.gone && cached.agent === agent
            && cached.size === file.size && cached.mtimeMs === file.mtimeMs) continue;
          try {
            files.set(file.path, await parseFile(agent, file.path, file, cached, horizonSec, maxLineBytes));
            changed = true;
          } catch (error) {
            if (error?.code === 'ENOENT') continue;
            failed += 1;
            warn(`${agent} log unreadable: ${error?.code ?? error?.message ?? error}`);
          }
          await new Promise((resolve) => setImmediate(resolve));
        }
      }
      if (failed) errors.push(`${PROVIDER_LABELS[agent]} 기록 ${failed}곳을 읽지 못했어요.`);
    }
    // 사라진 파일의 사용량은 기간 안에 남아 있는 동안 계속 센다: Claude 는 오래된 기록을 지우고,
    // 앱 창의 격리 홈은 창을 닫으면 지워진다. 옮겨진 파일(Codex 보관함)은 앞부분 해시로 알아보고 한 번만 센다.
    const liveHeads = new Set();
    for (const [file, entry] of files) if (seen.has(file)) liveHeads.add(`${entry.agent}:${entry.head}`);
    for (const [file, entry] of [...files]) {
      if (seen.has(file)) continue;
      const before = entry.events.length;
      if (!entry.gone) { entry.gone = true; changed = true; }
      entry.events = entry.events.filter((event) => event[1] >= horizonSec);
      if (entry.events.length !== before) changed = true;
      if (!entry.events.length || liveHeads.has(`${entry.agent}:${entry.head}`)) { files.delete(file); changed = true; }
    }
    if (changed) await saveCache().catch((error) => warn(`cache not saved: ${error?.code ?? error?.message ?? error}`));
    lastScan = { at, present, errors };
    return lastScan;
  }

  function startScan() {
    inFlight ??= scan().finally(() => { inFlight = null; });
    return inFlight;
  }

  // 한 번 훑은 뒤에는 기다리지 않는다: 지난 결과로 바로 답하고, 오래됐으면 뒤에서 다시 훑는다.
  // 새로고침만 새 스캔을 기다린다.
  function ensureScanned(refresh) {
    if (refresh || !lastScan) return startScan();
    if (!inFlight && now() - lastScan.at >= scanMemoMs) {
      startScan().catch((error) => warn(`background scan failed: ${error?.code ?? error?.message ?? error}`));
    }
    return Promise.resolve(lastScan);
  }

  function aggregate(days, scanResult) {
    const at = now();
    const today = new Date(at);
    const dates = [];
    for (let i = days - 1; i >= 0; i -= 1) {
      dates.push(localDateKey(new Date(today.getFullYear(), today.getMonth(), today.getDate() - i).getTime()));
    }
    const startDay = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (days - 1));
    const startSec = Math.floor(startDay.getTime() / 1000);
    const dayIndex = new Map(dates.map((date, i) => [date, i]));
    const daily = dates.map((date) => ({ date, claude: 0, codex: 0, pi: 0 }));
    const totals = Object.fromEntries(TOKEN_USAGE_AGENTS.map((agent) => [agent, {
      agent, tokens: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
      sessions: new Set(), cost: 0, priced: false,
    }]));

    // 이어 쓴(resume) 세션은 이전 기록을 새 파일에 다시 남긴다: 응답 key 로 파일을 넘나들며 한 번만 센다.
    const keyed = new Map();
    const plain = [];
    for (const entry of files.values()) {
      if (entry.mtimeMs < startDay.getTime()) continue;
      for (const event of entry.events) {
        if (event[1] < startSec) continue;
        const row = {
          agent: entry.agent, t: event[1], model: entry.models[event[2]], session: entry.sessions[event[3]],
          input: event[4], output: event[5], cacheRead: event[6], cacheWrite: event[7], cost: event[8],
        };
        if (!event[0]) { plain.push(row); continue; }
        const key = `${entry.agent}:${event[0]}`;
        const prior = keyed.get(key);
        if (!prior) { keyed.set(key, row); continue; }
        prior.input = Math.max(prior.input, row.input);
        prior.output = Math.max(prior.output, row.output);
        prior.cacheRead = Math.max(prior.cacheRead, row.cacheRead);
        prior.cacheWrite = Math.max(prior.cacheWrite, row.cacheWrite);
        if (row.cost !== null) prior.cost = Math.max(prior.cost ?? 0, row.cost);
        if (row.t < prior.t) { prior.t = row.t; prior.session = row.session; }
      }
    }
    for (const row of [...plain, ...keyed.values()]) {
      const total = totals[row.agent];
      const tokens = row.input + row.output + row.cacheRead + row.cacheWrite;
      total.tokens += tokens;
      total.inputTokens += row.input;
      total.outputTokens += row.output;
      total.cacheReadTokens += row.cacheRead;
      total.cacheCreationTokens += row.cacheWrite;
      total.sessions.add(row.session);
      let cost = row.cost;
      if (cost === null) {
        const price = priceForModel(row.model);
        if (price) {
          cost = (row.input * price.input + row.output * price.output
            + row.cacheRead * price.cacheRead + row.cacheWrite * price.cacheWrite) / 1_000_000;
        }
      }
      if (cost !== null) { total.cost += cost; total.priced = true; }
      const index = dayIndex.get(localDateKey(row.t * 1000));
      if (index !== undefined) daily[index][row.agent] += tokens;
    }

    const providers = TOKEN_USAGE_AGENTS.filter((agent) => scanResult.present[agent]).map((agent) => {
      const total = totals[agent];
      return {
        agent,
        tokens: total.tokens,
        inputTokens: total.inputTokens,
        outputTokens: total.outputTokens,
        cacheReadTokens: total.cacheReadTokens,
        cacheCreationTokens: total.cacheCreationTokens,
        sessions: total.sessions.size,
        costUsd: total.priced ? Math.round(total.cost * 100) / 100 : null,
      };
    });
    return {
      days,
      generatedAt: at,
      totalTokens: providers.reduce((sum, p) => sum + p.tokens, 0),
      sessions: providers.reduce((sum, p) => sum + p.sessions, 0),
      providers,
      daily,
      ...(scanResult.errors.length ? { errors: [...scanResult.errors] } : {}),
    };
  }

  return {
    /** @param {number} days 7 | 30 | 90 (그 밖은 30) @param {{ refresh?: boolean }} [options] */
    async report(days, { refresh = false } = {}) {
      const normalized = normalizeTokenUsageDays(days);
      const scanResult = await ensureScanned(refresh === true);
      return aggregate(normalized, scanResult);
    },
    /** 허브가 뜰 때 미리 훑어 두어 첫 화면이 기다리지 않게 한다. */
    warm() {
      return lastScan ? Promise.resolve(lastScan) : startScan();
    },
    cacheFile,
  };
}
