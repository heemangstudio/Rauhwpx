/**
 * Transactional email behind a tiny provider interface: `{ name, send({ to, subject, text, html, idempotencyKey }) }`.
 * Resend is the only real provider. With no RESEND_API_KEY the log provider records the
 * attempt and reports `skipped`, so a missing email setup never fails the Groble webhook.
 */

import { EMAIL_BANNER_URL, EMAIL_CARD_BG_URL, EMAIL_KEY_ICON_URL, renderEmail, SITE_URL } from './email-layout.mjs';

export function createResendProvider({ apiKey, from, replyTo, fetchImpl = globalThis.fetch, timeoutMs = 8000 }) {
  return {
    name: 'resend',
    async send({ to, subject, text, html, idempotencyKey }) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetchImpl('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
          },
          body: JSON.stringify({
            from,
            to: [to],
            subject,
            text,
            html,
            ...(replyTo ? { reply_to: replyTo } : {}),
          }),
          signal: controller.signal,
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
          return { status: 'failed', error: `resend ${res.status}: ${String(body?.message ?? body?.name ?? '').slice(0, 200)}` };
        }
        return { status: 'sent', providerId: typeof body?.id === 'string' ? body.id : undefined };
      } catch (error) {
        return { status: 'failed', error: String(error?.message ?? error).slice(0, 200) };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

export function createLogProvider({ log = (line) => process.stderr.write(`${line}\n`) } = {}) {
  return {
    name: 'log',
    async send({ to }) {
      log(`[site-api] license email skipped (RESEND_API_KEY not set) for ${maskEmail(to)}`);
      return { status: 'skipped' };
    },
  };
}

/** The Resend provider from env, or null when RESEND_API_KEY is not set. */
export function resendProviderFromEnv(env = process.env) {
  const apiKey = typeof env.RESEND_API_KEY === 'string' ? env.RESEND_API_KEY.trim() : '';
  if (!apiKey) return null;
  return createResendProvider({
    apiKey,
    from: env.LICENSE_EMAIL_FROM?.trim() || 'HamaEditor <license@heemangstudios.com>',
    replyTo: env.LICENSE_EMAIL_REPLY_TO?.trim() || 'management@heemangstudios.com',
  });
}

export function createEmailProvider(env = process.env) {
  return resendProviderFromEnv(env) ?? createLogProvider();
}

export function maskEmail(email) {
  const text = String(email ?? '');
  const at = text.indexOf('@');
  if (at < 1) return '***';
  return `${text[0]}***${text.slice(at)}`;
}

export const MAC_DMG_URL = 'https://github.com/heemangstudio/hamaeditor-releases/releases/latest/download/HamaEditor-mac-arm64.dmg';

/** Copy per reason the key goes out. Every kind shares the layout, the key card and the download button. */
const LICENSE_EMAIL_COPY = {
  // Groble purchase, a held order released by an admin, or a manual backfill of a paid order.
  purchase: { subject: '[HamaEditor] Mac 라이선스 키를 보내드려요', heading: '구매해 주셔서 고마워요.' },
  // Admin `resend-email`.
  resend: { subject: '[HamaEditor] Mac 라이선스 키를 다시 보내드려요', heading: '라이선스 키를 다시 보내드려요.' },
  // Admin `issue --send-email` with no order or payment behind it (free or beta keys).
  free: { subject: '[HamaEditor] Mac 라이선스 키를 보내드려요', heading: 'HamaEditor 라이선스 키를 보내드려요.' },
  // A subscription renewal paid on Groble extended the same key.
  renewal: {
    subject: '[HamaEditor] Mac 라이선스가 갱신됐어요',
    heading: '라이선스가 갱신됐어요.',
    noteHtml: '쓰던 키를 그대로 계속 쓰면 돼요. 키 하나로 <strong>Mac 2대</strong>까지 쓸 수 있어요.',
  },
};
const DEFAULT_NOTE_HTML = '아래 키를 HamaEditor에 붙여 넣으면 바로 모든 기능을 쓸 수 있어요. 키 하나로 <strong>Mac 2대</strong>까지 쓸 수 있어요.';
export const LICENSE_EMAIL_KINDS = Object.keys(LICENSE_EMAIL_COPY);
export const LICENSE_EMAIL_SUBJECT = LICENSE_EMAIL_COPY.purchase.subject;

/** Which copy a stored license gets: a resend wins, then a renewal, then any sign of payment, else a free key. */
export function licenseEmailKind(license) {
  if (license?.emailDelivery?.resend) return 'resend';
  if (license?.emailDelivery?.renewal) return 'renewal';
  if (license?.source === 'groble' || license?.merchantUid || license?.amount > 0) return 'purchase';
  return 'free';
}

const KST_DATE = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', year: 'numeric', month: 'long', day: 'numeric' });

/** The line under the key card for a subscription key, e.g. `다음 갱신일은 2027년 10월 19일이에요.` Lifetime keys get none. */
export function licenseExpiryLine(expiresAt, { autoRenew = true } = {}) {
  if (!Number.isSafeInteger(expiresAt)) return '';
  const date = KST_DATE.format(new Date(expiresAt));
  return autoRenew ? `매년 자동으로 갱신돼요. 다음 갱신일은 ${date}이에요.` : `${date}까지 쓸 수 있어요.`;
}

/**
 * License key email on the shared layout.
 * `downloadUrl` is the CTA target: a direct .dmg link works best; the homepage falls back to the dmg.
 * `expiresAt` (epoch ms) adds the renewal or end date under the key card; the card itself holds only the key.
 */
export function licenseEmail({
  key,
  kind = 'purchase',
  expiresAt = null,
  autoRenew = true,
  downloadUrl = MAC_DMG_URL,
  bannerUrl = EMAIL_BANNER_URL,
  keyIconUrl = EMAIL_KEY_ICON_URL,
  cardBgUrl = EMAIL_CARD_BG_URL,
  preheader = '라이선스 키와 Mac용 내려받기 링크를 담았어요.',
  subjectPrefix = '',
} = {}) {
  const copy = LICENSE_EMAIL_COPY[kind] ?? LICENSE_EMAIL_COPY.purchase;
  // The server default used to be the homepage; send buyers straight to the dmg instead.
  const href = !downloadUrl || downloadUrl === SITE_URL ? MAC_DMG_URL : downloadUrl;
  const subject = `${subjectPrefix}${copy.subject}`;
  const html = renderEmail({
    subject,
    preheader,
    banner: { url: bannerUrl, alt: 'HamaEditor · Mac 라이선스 키' },
    heading: copy.heading,
    noteHtml: copy.noteHtml ?? DEFAULT_NOTE_HTML,
    card: { value: key, iconUrl: keyIconUrl, bgUrl: cardBgUrl },
    cardNote: licenseExpiryLine(expiresAt, { autoRenew }),
    cta: { href, label: 'Mac용 내려받기', icon: '&#8595;', caption: 'Apple Silicon (M1 이후) · .dmg' },
  });
  return { subject, text: String(key), html };
}
