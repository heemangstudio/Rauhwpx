import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { createRateLimiter } from './rate-limit.mjs';
import { createFileStore, syncDirectory } from './store.mjs';

/**
 * In-app issue reports (문제 보고) from the desktop app.
 * Must match the desktop client's key. Same weak-auth model as the unique-install ping: it keeps
 * out drive-by junk, not a determined forger. Railway may override it with RAU_FEEDBACK_PROOF_KEY.
 */
export const DEFAULT_FEEDBACK_PROOF_KEY = 'rau.feedback.v1.desktop';
export const MAX_FEEDBACK_BODY_BYTES = 40 * 1024 * 1024;
export const DEFAULT_FEEDBACK_MAX_STORAGE_BYTES = 2 * 1024 * 1024 * 1024;
export const FEEDBACK_RETENTION_DAYS = 90;
export const FEEDBACK_STATUSES = Object.freeze(['new', 'seen', 'resolved']);
export const FEEDBACK_ATTACHMENTS = Object.freeze(['screenshot', 'log', 'chat', 'document']);

const KIB = 1024;
const MIB = 1024 * KIB;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const MAX_MESSAGE_CHARS = 5000;
const MAX_EMAIL_BYTES = 254;
const MAX_META_BYTES = 16 * KIB;
const MAX_LOG_BYTES = 512 * KIB;
const MAX_CHAT_BYTES = 2 * MIB;
const MAX_SCREENSHOT_BYTES = 4 * MIB;
const MAX_DOCUMENT_BYTES = 20 * MIB;
const MAX_CLOCK_SKEW_MS = DAY;
const REPORTS_PER_INSTALL_PER_HOUR = 5;
const PREVIEW_CHARS = 200;

const INSTALL_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
const REPORT_ID_RE = /^fb_[0-9a-z]{8,40}$/;
const STORED_FILE_RE = /^(?:screenshot\.(?:png|jpg)|log\.txt|chat\.txt|document\.(?:hwp|hwpx|hml|bin))$/;
const DOCUMENT_EXTENSIONS = new Set(['.hwp', '.hwpx', '.hml']);
const SCREENSHOT_TYPES = {
  'image/png': { ext: 'png', magic: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
  'image/jpeg': { ext: 'jpg', magic: Buffer.from([0xff, 0xd8, 0xff]) },
};

/** Errors the HTTP layer turns into `{ ok:false, error, field? }` with `status`. */
export function feedbackError(code, status, field) {
  const error = new Error(code);
  error.code = code;
  error.status = status;
  error.expose = true;
  if (field) error.field = field;
  return error;
}

const invalid = (field) => feedbackError('invalid', 400, field);
const tooLarge = (field) => feedbackError('too_large', 413, field);

export function emptyFeedbackIndex() {
  return { reports: [] };
}

export function sha256Hex(value) {
  return createHash('sha256').update(value, typeof value === 'string' ? 'utf8' : undefined).digest('hex');
}

/** hex HMAC-SHA256(key, `${installId}\n${createdAt}\n${sha256hex(message)}`) over the strings exactly as sent. */
export function createFeedbackProof({ installId, createdAt, message }, key = DEFAULT_FEEDBACK_PROOF_KEY) {
  return createHmac('sha256', String(key))
    .update(`${installId}\n${createdAt}\n${sha256Hex(String(message))}`, 'utf8')
    .digest('hex');
}

function proofMatches(proof, fields, key) {
  if (typeof proof !== 'string' || !/^[0-9a-f]{64}$/i.test(proof)) return false;
  return timingSafeEqual(Buffer.from(proof, 'hex'), Buffer.from(createFeedbackProof(fields, key), 'hex'));
}

function optionalText(value, maxBytes, field) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string') throw invalid(field);
  if (Buffer.byteLength(value, 'utf8') > maxBytes) throw tooLarge(field);
  return value;
}

function decodeBase64(value, maxBytes, field) {
  if (typeof value !== 'string' || value.length % 4 !== 0 || !BASE64_RE.test(value)) throw invalid(field);
  if (value.length > Math.ceil(maxBytes / 3) * 4) throw tooLarge(field);
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length > maxBytes) throw tooLarge(field);
  return bytes;
}

/**
 * A display name with no path, no control or bidi-override characters and no quotes. Only the
 * formats the editor opens keep their name; anything else becomes document.bin, so the inbox
 * never downloads an executable. The file on disk never uses the name.
 */
export function sanitizeDocumentName(name) {
  const base = String(name ?? '').normalize('NFC').split(/[\\/]/).pop()
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069"<>|:*?]/g, '')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, 200);
  return DOCUMENT_EXTENSIONS.has(path.extname(base).toLowerCase()) ? base : 'document.bin';
}

const documentFileName = (name) => `document${path.extname(name).toLowerCase()}`;

function shortText(value, max = 80) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

/**
 * Validates a POST /v1/feedback body (wire contract v1). Proof is checked before any size so a
 * forged request costs no decoding. Returns the report and its files, not yet stored.
 */
export function parseFeedback(body, { proofKey = DEFAULT_FEEDBACK_PROOF_KEY, now = Date.now() } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw invalid();
  if (body.v !== 1) throw invalid('v');
  const { installId, createdAt, message } = body;
  if (typeof installId !== 'string' || !INSTALL_ID_RE.test(installId)) throw invalid('installId');
  if (typeof createdAt !== 'string' || createdAt.length > 64 || !Number.isFinite(Date.parse(createdAt))) {
    throw invalid('createdAt');
  }
  if (typeof message !== 'string' || !message.trim() || message.length > MAX_MESSAGE_CHARS) throw invalid('message');
  if (!proofMatches(body.proof, { installId, createdAt, message }, proofKey)) throw feedbackError('bad_proof', 401);
  if (Math.abs(now - Date.parse(createdAt)) > MAX_CLOCK_SKEW_MS) throw invalid('createdAt');

  let email = '';
  if (body.email !== undefined && body.email !== null && body.email !== '') {
    email = typeof body.email === 'string' ? body.email.trim() : '';
    if (!email || Buffer.byteLength(email, 'utf8') > MAX_EMAIL_BYTES || !EMAIL_RE.test(email)) throw invalid('email');
  }
  let meta = {};
  if (body.meta !== undefined && body.meta !== null) {
    if (typeof body.meta !== 'object' || Array.isArray(body.meta)) throw invalid('meta');
    if (Buffer.byteLength(JSON.stringify(body.meta), 'utf8') > MAX_META_BYTES) throw tooLarge('meta');
    meta = body.meta;
  }

  const files = [];
  const attachments = {};
  const log = optionalText(body.log, MAX_LOG_BYTES, 'log');
  if (log) {
    files.push(['log.txt', Buffer.from(log, 'utf8')]);
    attachments.log = { file: 'log.txt', size: files.at(-1)[1].length };
  }
  const chat = optionalText(body.chat, MAX_CHAT_BYTES, 'chat');
  if (chat) {
    files.push(['chat.txt', Buffer.from(chat, 'utf8')]);
    attachments.chat = { file: 'chat.txt', size: files.at(-1)[1].length };
  }
  if (body.screenshot !== undefined && body.screenshot !== null) {
    const type = SCREENSHOT_TYPES[body.screenshot?.mime];
    if (!type) throw invalid('screenshot');
    const bytes = decodeBase64(body.screenshot.base64, MAX_SCREENSHOT_BYTES, 'screenshot');
    if (!bytes.subarray(0, type.magic.length).equals(type.magic)) throw invalid('screenshot');
    const file = `screenshot.${type.ext}`;
    files.push([file, bytes]);
    attachments.screenshot = { file, mime: body.screenshot.mime, size: bytes.length };
  }
  if (body.document !== undefined && body.document !== null) {
    if (typeof body.document !== 'object' || typeof body.document.name !== 'string') throw invalid('document');
    const bytes = decodeBase64(body.document.base64, MAX_DOCUMENT_BYTES, 'document');
    if (bytes.length === 0) throw invalid('document');
    const name = sanitizeDocumentName(body.document.name);
    const file = documentFileName(name);
    files.push([file, bytes]);
    attachments.document = { file, name, size: bytes.length };
  }

  return {
    report: {
      v: 1,
      createdAt,
      installHash: sha256Hex(installId.toLowerCase()),
      email,
      message,
      meta,
      attachments,
    },
    files,
  };
}

/** The index line the inbox lists. */
function summarize(report, status) {
  const meta = report.meta ?? {};
  return {
    id: report.id,
    receivedAt: report.receivedAt,
    createdAt: report.createdAt,
    status,
    installHash: report.installHash,
    email: report.email,
    preview: report.message.trim().slice(0, PREVIEW_CHARS),
    appVersion: shortText(meta.appVersion, 32),
    os: shortText(meta.os, 16),
    osVersion: shortText(meta.osVersion, 64),
    arch: shortText(meta.arch, 16),
    attachments: Object.fromEntries(Object.entries(report.attachments)
      .map(([kind, { file, ...rest }]) => [kind, rest])),
    bytes: report.bytes,
  };
}

const OS_NAMES = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' };
const ATTACHMENT_NAMES = { screenshot: '스크린샷', log: '로그', chat: '대화', document: '문서' };

export function feedbackTelegramText(summary) {
  const preview = summary.preview.length >= PREVIEW_CHARS ? `${summary.preview}…` : summary.preview;
  const platform = [OS_NAMES[summary.os] ?? summary.os, summary.osVersion, summary.arch].filter(Boolean).join(' ');
  const attached = FEEDBACK_ATTACHMENTS.filter((kind) => summary.attachments[kind]).map((kind) => ATTACHMENT_NAMES[kind]);
  return [
    `HamaEditor 문제 보고 ${summary.id}`,
    preview,
    [summary.appVersion, platform].filter(Boolean).join(' · '),
    attached.length ? `첨부: ${attached.join(', ')}` : '',
  ].filter(Boolean).join('\n');
}

function tokenMatches(given, expected) {
  if (!expected || !given) return false;
  const left = createHash('sha256').update(String(given)).digest();
  const right = createHash('sha256').update(String(expected)).digest();
  return timingSafeEqual(left, right);
}

async function writeDurable(file, bytes) {
  const handle = await fs.open(file, 'wx', 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Reports live in `<dir>/<id>/` (report.json plus attachment files) with `<dir>/index.json`
 * listing them. A report directory appears with one rename, and every write holds one lock,
 * so a directory not in the index is a leftover and the next prune removes it.
 */
export function createFeedbackService({
  dir,
  now = Date.now,
  proofKey = DEFAULT_FEEDBACK_PROOF_KEY,
  maxStorageBytes = DEFAULT_FEEDBACK_MAX_STORAGE_BYTES,
  retentionDays = FEEDBACK_RETENTION_DAYS,
  adminToken = '',
  notify = async () => {},
} = {}) {
  if (!dir) throw new Error('feedback dir is required');
  const index = createFileStore(path.join(dir, 'index.json'), { emptyState: emptyFeedbackIndex });
  const installLimiter = createRateLimiter({ now });
  let mutation = Promise.resolve();

  function withLock(fn) {
    const result = mutation.then(fn, fn);
    mutation = result.then(() => undefined, () => undefined);
    return result;
  }

  async function loadIndex() {
    const state = await index.load();
    return Array.isArray(state?.reports) ? state : emptyFeedbackIndex();
  }

  /** Drops reports past retention and leftover directories. Call only inside the lock. */
  async function prune(state) {
    const cutoff = now() - retentionDays * DAY;
    const expired = state.reports.filter((entry) => !(Date.parse(entry.receivedAt) >= cutoff));
    state.reports = state.reports.filter((entry) => Date.parse(entry.receivedAt) >= cutoff);
    const keep = new Set(state.reports.map((entry) => entry.id));
    let names = [];
    try {
      names = await fs.readdir(dir);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    const stale = names.filter((name) => (REPORT_ID_RE.test(name) && !keep.has(name)) || name.startsWith('.incoming-'));
    if (expired.length) await index.save(state);
    await Promise.all(stale.map((name) => fs.rm(path.join(dir, name), { recursive: true, force: true })));
    return expired.length;
  }

  const usedBytes = (state) => state.reports.reduce((sum, entry) => sum + (Number(entry.bytes) || 0), 0);

  async function submit(body) {
    const { report, files } = parseFeedback(body, { proofKey, now: now() });
    if (!installLimiter.check(report.installHash, REPORTS_PER_INSTALL_PER_HOUR, HOUR)) {
      throw feedbackError('rate_limited', 429);
    }
    return withLock(async () => {
      const state = await loadIndex();
      await prune(state);
      const id = `fb_${now().toString(36)}${randomBytes(6).toString('hex')}`;
      const stored = { id, receivedAt: new Date(now()).toISOString(), ...report };
      const json = Buffer.from(`${JSON.stringify({ ...stored, bytes: undefined }, null, 2)}\n`, 'utf8');
      stored.bytes = json.length + files.reduce((sum, [, bytes]) => sum + bytes.length, 0);
      if (usedBytes(state) + stored.bytes > maxStorageBytes) throw feedbackError('storage_full', 507);

      await fs.mkdir(dir, { recursive: true });
      const incoming = path.join(dir, `.incoming-${id}`);
      const target = path.join(dir, id);
      try {
        await fs.mkdir(incoming, { mode: 0o700 });
        await Promise.all([...files, ['report.json', json]].map(([name, bytes]) => writeDurable(path.join(incoming, name), bytes)));
        await syncDirectory(incoming);
        await fs.rename(incoming, target);
        await syncDirectory(dir);
        const summary = summarize(stored, 'new');
        state.reports.push(summary);
        await index.save(state);
        return summary;
      } catch (error) {
        await fs.rm(incoming, { recursive: true, force: true }).catch(() => {});
        await fs.rm(target, { recursive: true, force: true }).catch(() => {});
        if (error?.code === 'STORE_TOO_LARGE') throw feedbackError('storage_full', 507);
        throw error;
      }
    });
  }

  function requireAdmin(token) {
    if (!tokenMatches(token, adminToken)) throw feedbackError('forbidden', 403);
  }

  function requireEntry(state, id) {
    if (typeof id !== 'string' || !REPORT_ID_RE.test(id)) throw invalid('id');
    const entry = state.reports.find((item) => item.id === id);
    if (!entry) throw feedbackError('not_found', 404);
    return entry;
  }

  async function readReport(id) {
    return JSON.parse(await fs.readFile(path.join(dir, id, 'report.json'), 'utf8'));
  }

  const admin = {
    /** Newest first, with storage use so the inbox can show how full the volume is. */
    async list(token) {
      requireAdmin(token);
      return withLock(async () => {
        const state = await loadIndex();
        await prune(state);
        const reports = [...state.reports].sort((a, b) => String(b.receivedAt).localeCompare(String(a.receivedAt)));
        const counts = Object.fromEntries(FEEDBACK_STATUSES.map((status) => [status, 0]));
        for (const entry of reports) if (Object.hasOwn(counts, entry.status)) counts[entry.status] += 1;
        return { ok: true, reports, counts, storage: { bytes: usedBytes(state), maxBytes: maxStorageBytes } };
      });
    },
    async detail(token, id) {
      requireAdmin(token);
      const entry = requireEntry(await loadIndex(), id);
      const report = await readReport(entry.id);
      report.attachments = Object.fromEntries(Object.entries(report.attachments ?? {})
        .map(([kind, { file, ...rest }]) => [kind, rest]));
      return { ok: true, report: { ...report, status: entry.status } };
    },
    /** `{ bytes, contentType, fileName, inline }` for one stored attachment. */
    async attachment(token, { id, name } = {}) {
      requireAdmin(token);
      if (!FEEDBACK_ATTACHMENTS.includes(name)) throw invalid('name');
      const entry = requireEntry(await loadIndex(), id);
      const attachment = (await readReport(entry.id)).attachments?.[name];
      if (!attachment || !STORED_FILE_RE.test(attachment.file)) throw feedbackError('not_found', 404);
      const bytes = await fs.readFile(path.join(dir, entry.id, attachment.file));
      if (name === 'screenshot') return { bytes, contentType: attachment.mime, fileName: `${entry.id}-${attachment.file}`, inline: true };
      if (name === 'document') return { bytes, contentType: 'application/octet-stream', fileName: attachment.name, inline: false };
      return { bytes, contentType: 'text/plain; charset=utf-8', fileName: `${entry.id}-${attachment.file}`, inline: name === 'log' };
    },
    async setStatus(token, { id, status } = {}) {
      requireAdmin(token);
      if (!FEEDBACK_STATUSES.includes(status)) throw invalid('status');
      return withLock(async () => {
        const state = await loadIndex();
        const entry = requireEntry(state, id);
        entry.status = status;
        await index.save(state);
        return { ok: true, report: entry };
      });
    },
    async remove(token, { id } = {}) {
      requireAdmin(token);
      return withLock(async () => {
        const state = await loadIndex();
        const entry = requireEntry(state, id);
        state.reports = state.reports.filter((item) => item !== entry);
        await index.save(state);
        await fs.rm(path.join(dir, entry.id), { recursive: true, force: true });
        return { ok: true };
      });
    },
  };

  return {
    submit,
    /** Telegram ping for a stored report. Never throws. */
    notify: (summary) => Promise.resolve().then(() => notify(feedbackTelegramText(summary))).catch(() => {}),
    prune: () => withLock(async () => prune(await loadIndex())),
    admin,
  };
}
