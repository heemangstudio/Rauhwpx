import { createHash, createHmac } from 'node:crypto';
import { uniqueInstallStatePath, loadOrCreateUniqueInstallState, SITE_API_ORIGIN } from './unique-install.mjs';

// 문제 보고(POST /v1/feedback). 계약: site-api/feedback.mjs 와 /tmp/issue-reports/CONTRACT.md.
// 렌더러가 메시지·스크린숏·선택한 첨부를 보내면, 메인이 설치 id·증명·진단 기록을 붙여 보낸다.

/** Must match site-api/feedback.mjs DEFAULT_FEEDBACK_PROOF_KEY. 막는 것은 지나가는 쓰레기 요청뿐이다. */
export const DEFAULT_FEEDBACK_PROOF_KEY = 'rau.feedback.v1.desktop';
export const FEEDBACK_PATH = '/v1/feedback';
const KIB = 1024;
const MIB = 1024 * KIB;
/** site-api MAX_FEEDBACK_BODY_BYTES 와 같다. 넘는 본문은 보내기 전에 too_large 로 끝낸다. */
export const FEEDBACK_MAX_BODY_BYTES = 40 * MIB;
export const FEEDBACK_LIMITS = Object.freeze({
  messageChars: 5000,
  emailBytes: 254,
  metaBytes: 16 * KIB,
  logBytes: 512 * KIB,
  chatBytes: 2 * MIB,
  screenshotBytes: 4 * MIB,
  documentBytes: 20 * MIB,
});
const EMAIL_RE = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;
const SCREENSHOT_MIMES = new Set(['image/png', 'image/jpeg']);
const META_STRING_CHARS = 300;

/** 응답까지 기다릴 시간. 느린 회선에서 큰 첨부가 끊기지 않게 본문 100 KiB 마다 1초를 더하고, 10분에서 멈춘다. */
export function feedbackTimeoutMs(bodyBytes) {
  return Math.min(10 * 60_000, 30_000 + Math.ceil(bodyBytes / (100 * KIB)) * 1000);
}

export class FeedbackDraftError extends Error {
  constructor(field, code = 'invalid') {
    super(`${code}: ${field}`);
    this.name = 'FeedbackDraftError';
    this.field = field;
    this.code = code;
  }
}

export function sha256Hex(value) {
  return createHash('sha256').update(value, typeof value === 'string' ? 'utf8' : undefined).digest('hex');
}

/** hex HMAC-SHA256(key, `${installId}\n${createdAt}\n${sha256hex(message)}`). site-api 와 같은 식이다. */
export function createFeedbackProof({ installId, createdAt, message }, key = DEFAULT_FEEDBACK_PROOF_KEY) {
  return createHmac('sha256', String(key))
    .update(`${installId}\n${createdAt}\n${sha256Hex(String(message))}`, 'utf8')
    .digest('hex');
}

/** 개발 실행에서만 RAU_SITE_API_ORIGIN 으로 시험용 site-api 를 쓴다. 출시 빌드는 늘 운영 주소다. */
export function feedbackOrigin({ packaged, env = process.env } = {}) {
  const override = packaged ? '' : String(env.RAU_SITE_API_ORIGIN ?? '').trim();
  return (override || SITE_API_ORIGIN).replace(/\/+$/, '');
}

function utf8Bytes(text) {
  return Buffer.byteLength(text, 'utf8');
}

/** 끝을 남기고 앞을 자른다. 잘린 첫 줄은 버린다. */
function keepTail(text, maxBytes) {
  if (utf8Bytes(text) <= maxBytes) return text;
  const bytes = Buffer.from(text, 'utf8');
  const tail = bytes.subarray(bytes.length - maxBytes + 64).toString('utf8');
  const newline = tail.indexOf('\n');
  return `… (앞부분 생략)\n${newline >= 0 ? tail.slice(newline + 1) : tail}`;
}

function toBytes(value) {
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  return null;
}

/** 메타는 짧은 값만 남긴다: 문자열·수·참거짓, 그리고 그 값들을 담은 한 단계 객체. */
export function sanitizeFeedbackMeta(raw) {
  const clean = (value, depth) => {
    if (typeof value === 'string') return value.slice(0, META_STRING_CHARS);
    if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
    if (typeof value === 'boolean') return value;
    if (depth > 0 && value && typeof value === 'object' && !Array.isArray(value)) {
      const out = {};
      for (const [key, inner] of Object.entries(value).slice(0, 40)) {
        const cleaned = clean(inner, depth - 1);
        if (cleaned !== undefined) out[key.slice(0, 60)] = cleaned;
      }
      return out;
    }
    return undefined;
  };
  const meta = clean(raw && typeof raw === 'object' ? raw : {}, 2) ?? {};
  if (utf8Bytes(JSON.stringify(meta)) > FEEDBACK_LIMITS.metaBytes) throw new FeedbackDraftError('meta', 'too_large');
  return meta;
}

/**
 * 계약 v1 의 요청 본문을 만든다. 서버가 거절할 값은 보내기 전에 FeedbackDraftError 로 거절하고,
 * 기록·채팅은 상한에 맞게 앞을 자른다.
 */
export function buildFeedbackPayload({
  installId,
  createdAt,
  message,
  email = '',
  meta = {},
  log = '',
  screenshot = null,
  chat = '',
  document = null,
}, { proofKey = DEFAULT_FEEDBACK_PROOF_KEY } = {}) {
  const text = typeof message === 'string' ? message.trim() : '';
  if (!text) throw new FeedbackDraftError('message');
  if (text.length > FEEDBACK_LIMITS.messageChars) throw new FeedbackDraftError('message', 'too_large');
  const payload = {
    v: 1,
    installId,
    createdAt,
    proof: createFeedbackProof({ installId, createdAt, message: text }, proofKey),
    message: text,
  };
  const address = typeof email === 'string' ? email.trim() : '';
  if (address) {
    if (utf8Bytes(address) > FEEDBACK_LIMITS.emailBytes || !EMAIL_RE.test(address)) throw new FeedbackDraftError('email');
    payload.email = address;
  }
  payload.meta = sanitizeFeedbackMeta(meta);
  if (typeof log === 'string' && log) payload.log = keepTail(log, FEEDBACK_LIMITS.logBytes);
  if (screenshot) {
    const bytes = toBytes(screenshot.bytes);
    if (!bytes || !SCREENSHOT_MIMES.has(screenshot.mime)) throw new FeedbackDraftError('screenshot');
    if (bytes.length > FEEDBACK_LIMITS.screenshotBytes) throw new FeedbackDraftError('screenshot', 'too_large');
    payload.screenshot = { mime: screenshot.mime, base64: bytes.toString('base64') };
  }
  if (typeof chat === 'string' && chat) payload.chat = keepTail(chat, FEEDBACK_LIMITS.chatBytes);
  if (document) {
    const bytes = toBytes(document.bytes);
    const name = typeof document.name === 'string' ? document.name.slice(0, 200) : '';
    if (!bytes || !name) throw new FeedbackDraftError('document');
    if (bytes.length > FEEDBACK_LIMITS.documentBytes) throw new FeedbackDraftError('document', 'too_large');
    payload.document = { name, base64: bytes.toString('base64') };
  }
  return payload;
}

/**
 * 보낸다. 결과는 렌더러가 고를 문구의 코드로 준다.
 * @returns {Promise<{ ok: true, id: string } | { ok: false, code: 'rate_limited'|'busy'|'too_large'|'invalid'|'rejected'|'offline'|'timeout'|'server', status?: number }>}
 */
export async function submitFeedback(payload, {
  origin,
  fetchImpl = globalThis.fetch,
  timeoutMs,
} = {}) {
  const body = JSON.stringify(payload);
  const bytes = Buffer.byteLength(body, 'utf8');
  // 필드마다 상한 안이어도 base64 로 불어난 합이 서버 상한을 넘을 수 있다.
  if (bytes > FEEDBACK_MAX_BODY_BYTES) return { ok: false, code: 'too_large' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs ?? feedbackTimeoutMs(bytes));
  let response;
  try {
    response = await fetchImpl(`${origin}${FEEDBACK_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body,
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timer);
    return { ok: false, code: controller.signal.aborted || error?.name === 'AbortError' ? 'timeout' : 'offline' };
  }
  let answer = null;
  try {
    answer = await response.json();
  } catch {
    answer = null;
  } finally {
    clearTimeout(timer);
  }
  const { status } = response;
  if (response.ok && answer?.ok === true && typeof answer.id === 'string') return { ok: true, id: answer.id };
  if (status === 429) return { ok: false, code: 'rate_limited', status };
  if (status === 503 && answer?.error === 'busy') return { ok: false, code: 'busy', status };
  if (status === 413) return { ok: false, code: 'too_large', status };
  if (status === 401) return { ok: false, code: 'rejected', status };
  if (status === 400) return { ok: false, code: 'invalid', status, ...(typeof answer?.field === 'string' ? { field: answer.field } : {}) };
  return { ok: false, code: 'server', status };
}

function licenseMeta(status) {
  if (!status) return {};
  const tier = status.license?.tier ?? (status.state === 'free' ? 'free' : 'none');
  return { licenseTier: tier, licenseState: String(status.state ?? '') };
}

/**
 * 렌더러용 문제 보고 IPC.
 * - desktop:issue-report-prepare: 창 전체를 찍고(시트를 띄우기 전) 진단 기록·앱 정보를 이 창 몫으로 붙잡아 준다.
 * - desktop:issue-report-submit: 붙잡은 기록과 정보에 렌더러의 글·첨부를 더해 보낸다.
 */
export function installIssueReportHost({
  ipcMain,
  sessionForEvent,
  diagnosticLog,
  userDataDir,
  appInfo,
  licenseStatus = async () => null,
  origin,
  fetchImpl,
  proofKey = DEFAULT_FEEDBACK_PROOF_KEY,
  now = () => new Date(),
}) {
  /** webContents id → 시트를 연 때의 기록과 앱 정보. 보낼 때 이것을 그대로 싣는다(본 것과 보낸 것이 같다). */
  const prepared = new Map();

  ipcMain.handle('desktop:issue-report-prepare', async (event) => {
    const { window } = sessionForEvent(event);
    const contents = window.webContents;
    let screenshot = null;
    try {
      const image = await contents.capturePage();
      if (!image.isEmpty()) {
        const size = image.getSize();
        screenshot = { bytes: new Uint8Array(image.toPNG()), width: size.width, height: size.height };
      }
    } catch (error) {
      diagnosticLog?.write('main', 'warn', 'issue report capture failed:', error);
    }
    const bounds = window.getContentBounds();
    const meta = {
      ...appInfo(),
      ...licenseMeta(await licenseStatus().catch(() => null)),
      window: { width: bounds.width, height: bounds.height },
    };
    const log = diagnosticLog?.tail(FEEDBACK_LIMITS.logBytes) ?? '';
    if (!prepared.has(contents.id)) contents.once('destroyed', () => prepared.delete(contents.id));
    prepared.set(contents.id, { meta, log });
    return { screenshot, meta, log };
  });

  ipcMain.handle('desktop:issue-report-submit', async (event, draft = {}) => {
    const { window } = sessionForEvent(event);
    const snapshot = prepared.get(window.webContents.id);
    if (!snapshot) return { ok: false, code: 'invalid' };
    let payload;
    try {
      const { installId } = await loadOrCreateUniqueInstallState(uniqueInstallStatePath(userDataDir));
      payload = buildFeedbackPayload({
        installId,
        createdAt: now().toISOString(),
        message: draft.message,
        email: draft.email,
        meta: {
          ...(draft.meta && typeof draft.meta === 'object' ? draft.meta : {}),
          ...snapshot.meta,
          screenshotBlurred: draft.screenshot ? draft.screenshot.blurred !== false : false,
        },
        log: snapshot.log,
        screenshot: draft.screenshot ? { mime: draft.screenshot.mime, bytes: draft.screenshot.bytes } : null,
        chat: typeof draft.chat === 'string' ? draft.chat : '',
        document: draft.document ? { name: draft.document.name, bytes: draft.document.bytes } : null,
      }, { proofKey });
    } catch (error) {
      if (error instanceof FeedbackDraftError) {
        return { ok: false, code: error.code === 'too_large' ? 'too_large' : 'invalid', field: error.field };
      }
      throw error;
    }
    const result = await submitFeedback(payload, { origin, fetchImpl });
    if (result.ok) prepared.delete(window.webContents.id);
    diagnosticLog?.write('main', result.ok ? 'info' : 'warn', `issue report ${result.ok ? `sent ${result.id}` : `failed: ${result.code}${result.status ? ` (${result.status})` : ''}`}`);
    return result;
  });
}
