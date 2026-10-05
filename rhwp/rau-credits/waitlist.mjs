import { createHash, timingSafeEqual } from 'node:crypto';

import { createMemoryStore } from './store.mjs';

const MAX_EMAIL_BYTES = 254;
const EMAIL_RE = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;
const NOTIFY_TIMEOUT_MS = 5000;

function waitlistError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function emptyWaitlistState() {
  return { entries: {} };
}

export function parseWaitlistEmail(body) {
  const email = typeof body?.email === 'string' ? body.email.trim() : '';
  if (!email || Buffer.byteLength(email, 'utf8') > MAX_EMAIL_BYTES || !EMAIL_RE.test(email)) {
    throw waitlistError('WAITLIST_EMAIL_INVALID', '이메일 주소를 다시 확인해 주세요');
  }
  return email;
}

function tokenMatches(given, expected) {
  if (!expected || !given) return false;
  const left = createHash('sha256').update(String(given)).digest();
  const right = createHash('sha256').update(String(expected)).digest();
  return timingSafeEqual(left, right);
}

/** 베타 체험 신청. 웹사이트가 이메일을 남기고, 관리자 토큰으로만 목록을 읽는다. */
export function createWaitlistService({
  store = createMemoryStore(emptyWaitlistState()),
  now = Date.now,
  adminToken = '',
  notifyUrl = '',
  fetchImpl = globalThis.fetch,
} = {}) {
  let mutation = Promise.resolve();

  function withLock(fn) {
    const result = mutation.then(fn, fn);
    mutation = result.then(() => undefined, () => undefined);
    return result;
  }

  async function notify(email) {
    if (!notifyUrl) return;
    const text = `Rauhwpx 체험 신청: ${email}`;
    try {
      // Discord 는 content, Slack 은 text 를 읽는다.
      await fetchImpl(notifyUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: text, text }),
        signal: AbortSignal.timeout(NOTIFY_TIMEOUT_MS),
      });
    } catch (error) {
      process.stderr.write(`[rau-credits] waitlist notify failed: ${error?.message ?? error}\n`);
    }
  }

  async function join(body) {
    const email = parseWaitlistEmail(body);
    const key = email.toLowerCase();
    const created = await withLock(async () => {
      const state = await store.load();
      if (!state.entries || typeof state.entries !== 'object' || Array.isArray(state.entries)) {
        state.entries = {};
      }
      if (state.entries[key]) return false;
      state.entries[key] = { email, joinedAt: new Date(now()).toISOString() };
      try {
        await store.save(state);
      } catch (error) {
        if (error?.code === 'RAU_CREDITS_STORE_TOO_LARGE') {
          throw waitlistError('WAITLIST_CAPACITY_EXCEEDED', '신청을 받을 수 없어요. 메일로 연락해 주세요');
        }
        throw error;
      }
      return true;
    });
    if (created) await notify(email);
    return { ok: true };
  }

  async function list(token) {
    if (!tokenMatches(token, adminToken)) {
      throw waitlistError('WAITLIST_FORBIDDEN', '권한이 없어요');
    }
    const state = await store.load();
    const entries = Object.values(state.entries ?? {})
      .sort((a, b) => String(a.joinedAt).localeCompare(String(b.joinedAt)));
    return { count: entries.length, entries };
  }

  return { join, list };
}
