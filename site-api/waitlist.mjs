import { createHash, timingSafeEqual } from 'node:crypto';

import { createMemoryStore } from './store.mjs';
import { createTelegramSender } from './telegram.mjs';

const MAX_EMAIL_BYTES = 254;
const EMAIL_RE = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;

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
  telegramBotToken = '',
  telegramChatId = '',
  fetchImpl = globalThis.fetch,
} = {}) {
  const sendTelegram = createTelegramSender({
    botToken: telegramBotToken,
    chatId: telegramChatId,
    fetchImpl,
    label: 'waitlist',
  });
  const notify = (email) => sendTelegram(`HamaEditor 체험 신청: ${email}`);

  async function join(body) {
    const email = parseWaitlistEmail(body);
    const key = email.toLowerCase();
    let created;
    try {
      ({ value: created } = await store.update((state) => {
        if (!state.entries || typeof state.entries !== 'object' || Array.isArray(state.entries)) {
          state.entries = {};
        }
        if (state.entries[key]) return { dirty: false, value: false };
        state.entries[key] = { email, joinedAt: new Date(now()).toISOString() };
        return { value: true };
      }));
    } catch (error) {
      // The file store's 8 MiB limit; Postgres has none.
      if (error?.code === 'STORE_TOO_LARGE') {
        throw waitlistError('WAITLIST_CAPACITY_EXCEEDED', '신청을 받을 수 없어요. 메일로 연락해 주세요');
      }
      throw error;
    }
    if (created) await notify(email);
    return { ok: true };
  }

  async function list(token) {
    if (!tokenMatches(token, adminToken)) {
      throw waitlistError('WAITLIST_FORBIDDEN', '권한이 없어요');
    }
    const state = await store.read();
    const entries = Object.values(state.entries ?? {})
      .sort((a, b) => String(a.joinedAt).localeCompare(String(b.joinedAt)));
    return { count: entries.length, entries };
  }

  return { join, list };
}
