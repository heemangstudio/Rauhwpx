/**
 * Email to management for every rejected Groble webhook, at most one per reason per window.
 * Alerts that fall inside the window are counted and reported in the next email for that reason.
 * The copy carries the reason, time and status only: never headers, signatures or body data.
 */

import { EMAIL_BANNER_URL, EMAIL_CARD_BG_URL, renderEmail, SUPPORT_EMAIL } from './email-layout.mjs';

export const WEBHOOK_ALERT_WINDOW_MS = 15 * 60 * 1000;

const REASON_COPY = {
  not_configured: '<strong>GROBLE_WEBHOOK_SECRET</strong>이 설정되지 않았어요.',
  missing_headers: '서명 헤더가 없는 요청이에요.',
  bad_timestamp: 'X-Groble-Timestamp 형식이 올바르지 않아요.',
  bad_signature: '서명이 맞지 않아요. Railway의 <strong>GROBLE_WEBHOOK_SECRET</strong>이 Groble 연동 화면의 시크릿과 같은지 확인해 주세요.',
  body_too_large: '본문이 256KB를 넘어요.',
  timestamp_out_of_window: '서명은 맞지만 타임스탬프가 5분 넘게 어긋나요. 서버 시계를 확인해 주세요.',
  json_invalid: '서명은 맞지만 본문이 JSON이 아니에요.',
  payload_invalid: '서명은 맞지만 이벤트 형식이 올바르지 않아요.',
  store_error: '주문을 저장하지 못했어요. 볼륨과 로그를 확인해 주세요.',
};

/** `2026-10-16 14:03:22 KST`, without depending on the host's ICU data. */
export function formatKst(iso) {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return String(iso ?? '');
  return `${new Date(ms + 9 * 60 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ')} KST`;
}

export function webhookAlertEmail({ reason, status, at, suppressed = 0 }) {
  const retried = status >= 500 || status === 408 || status === 429;
  const time = formatKst(at);
  const subject = `[HamaEditor] Groble 웹훅 거부: ${reason}`;
  const lines = [
    REASON_COPY[reason] ?? '알 수 없는 이유로 거부했어요.',
    retried
      ? `응답 ${status}. Groble이 약 44시간 동안 다시 보내요.`
      : `응답 ${status}. Groble은 다시 보내지 않아요. <strong>license-admin.mjs webhooks --rejected</strong>로 주문을 확인해 주세요.`,
  ];
  if (suppressed > 0) lines.push(`지난 알림 뒤로 같은 이유가 ${suppressed}번 더 있었어요.`);
  const html = renderEmail({
    subject,
    preheader: `${time} · 응답 ${status}`,
    banner: { url: EMAIL_BANNER_URL, alt: 'HamaEditor · Groble 웹훅' },
    heading: 'Groble 웹훅을 거부했어요.',
    noteHtml: lines.join('<br>'),
    card: { value: reason, caption: `${time} · ${status}`, iconUrl: '', bgUrl: EMAIL_CARD_BG_URL },
  });
  const text = [`${reason} · ${time} · ${status}`, ...lines.map((l) => l.replace(/<\/?strong>/g, ''))].join('\n');
  return { subject, text, html };
}

/**
 * `provider` is a Resend provider or null. `notify` never throws and resolves to
 * { status: 'sent'|'failed'|'suppressed'|'skipped' }.
 */
export function createWebhookAlerter({
  provider = null,
  to = SUPPORT_EMAIL,
  now = Date.now,
  windowMs = WEBHOOK_ALERT_WINDOW_MS,
  log = (line) => process.stderr.write(`${line}\n`),
} = {}) {
  const byReason = new Map();
  return {
    async notify(entry) {
      const { reason } = entry;
      if (!provider) {
        log(`[site-api] webhook alert skipped (RESEND_API_KEY not set): ${reason}`);
        return { status: 'skipped' };
      }
      const last = byReason.get(reason);
      if (last && now() - last.sentAt < windowMs) {
        last.suppressed += 1;
        return { status: 'suppressed' };
      }
      byReason.set(reason, { sentAt: now(), suppressed: 0 });
      const message = webhookAlertEmail({ ...entry, suppressed: last?.suppressed ?? 0 });
      let outcome;
      try {
        outcome = await provider.send({ to, ...message, idempotencyKey: `webhook-alert-${entry.id ?? `${reason}-${now()}`}` });
      } catch (error) {
        outcome = { status: 'failed', error: String(error?.message ?? error).slice(0, 200) };
      }
      log(`[site-api] webhook alert ${outcome.status} for ${reason}${outcome.error ? `: ${outcome.error}` : ''}`);
      return { status: outcome.status };
    },
  };
}
