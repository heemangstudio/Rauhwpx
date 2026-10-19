/**
 * Email to management for every Groble event the server held for review: a held order, a
 * subscription event with no matching key, or an event type it does not handle. One email per
 * order or event, never batched across orders. The copy carries the reason, buyer email, amount,
 * merchantUid and time only: never headers, signatures or the body.
 */

import { EMAIL_BANNER_URL, EMAIL_CARD_BG_URL, escapeHtml, renderEmail, SUPPORT_EMAIL } from './email-layout.mjs';
import { formatKst } from './webhook-alert.mjs';

const EVENT_LABELS = {
  'subscription_payment.failed': '갱신 결제 실패',
  'subscription.cancel_requested': '구독 해지 요청',
  'subscription.terminated': '구독 종료',
};
const SENT_KEYS_MAX = 500;

/** `9900` → `9,900원`, without depending on the host's ICU data. */
export function formatWon(value) {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return '';
  return `${String(Math.trunc(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}원`;
}

/** Why the server held an order or event, in one plain Korean sentence. Shared with the dashboard. */
export function heldReasonText(reason) {
  const text = String(reason ?? '');
  const colon = text.indexOf(':');
  const code = colon < 0 ? text : text.slice(0, colon);
  const detail = colon < 0 ? '' : text.slice(colon + 1);
  switch (code) {
    case 'wrong_price': return `상품 정가가 ${formatWon(detail) || detail}으로 왔어요. 정해 둔 가격과 달라요.`;
    case 'amount_below_minimum': return `결제 금액 ${formatWon(detail) || detail}이 최소 금액보다 적어요.`;
    case 'wrong_currency': return '원화(KRW)가 아닌 결제예요.';
    case 'missing_amount': return '결제 금액이 빠져 있어요.';
    case 'wrong_product': return `다른 상품(${detail || '없음'})의 결제예요.`;
    case 'wrong_payment_type': return `결제 방식(${detail})이 상품과 맞지 않아요.`;
    case 'renewal_unmatched': return '갱신 결제에 맞는 구독 키를 찾지 못했어요.';
    case 'renewal_for_revoked_key': return '해지한 키의 갱신 결제예요.';
    case 'subscription_unmatched': return `${EVENT_LABELS[detail] ?? detail} 알림에 맞는 구독 키를 찾지 못했어요.`;
    case 'unknown_event_type': return `처리하지 않는 이벤트(${detail})예요.`;
    case 'missing_merchant_uid': return '주문번호가 없는 이벤트예요.';
    default: return '확인이 필요한 이벤트예요.';
  }
}

/** `entry`: a held webhook-log entry ({ action, reason, merchantUid, buyerEmail, amount, eventType, at }). */
export function heldAlertEmail({ action, reason, merchantUid, buyerEmail, amount, eventType, at }) {
  const order = action === 'held';
  const renewal = reason === 'renewal_unmatched' || reason === 'renewal_for_revoked_key';
  const time = formatKst(at);
  const won = formatWon(amount);
  const subject = order
    ? `[HamaEditor] 주문 보류: ${merchantUid ?? reason}`
    : `[HamaEditor] 확인할 Groble 이벤트: ${eventType ?? reason}`;
  const todo = !order
    ? '라이선스 관리 화면에서 확인해 주세요.'
    : renewal
      ? '라이선스 관리 화면에서 쓰던 키를 골라 연장해 주세요.'
      : '라이선스 관리 화면에서 키를 발급하거나 Groble에서 환불해 주세요.';
  const lines = [
    heldReasonText(reason),
    ...(buyerEmail ? [`구매자 ${buyerEmail}`] : []),
    todo,
  ];
  const html = renderEmail({
    subject,
    preheader: [time, won, buyerEmail].filter(Boolean).join(' · '),
    banner: { url: EMAIL_BANNER_URL, alt: 'HamaEditor · Groble 주문' },
    heading: order ? '주문을 보류했어요.' : '확인할 Groble 이벤트가 왔어요.',
    noteHtml: lines.map((line, i) => (i === lines.length - 1 ? `<strong>${escapeHtml(line)}</strong>` : escapeHtml(line))).join('<br>'),
    card: { value: merchantUid ?? eventType ?? reason, caption: [time, won].filter(Boolean).join(' · '), iconUrl: '', bgUrl: EMAIL_CARD_BG_URL },
  });
  const text = [[merchantUid ?? eventType ?? reason, time, won].filter(Boolean).join(' · '), ...lines].join('\n');
  return { subject, text, html };
}

/** Same order or event, same reason: one email, even when Groble delivers it again under a new key. */
function alertKey(entry) {
  const subject = entry.merchantUid || entry.eventId || entry.idempotencyKey || entry.id || '';
  return `held-${subject}-${entry.reason ?? ''}`.replace(/[^A-Za-z0-9._:-]/g, '_').slice(0, 200);
}

/**
 * `provider` is a Resend provider or null. `notify` never throws and resolves to
 * { status: 'sent'|'failed'|'duplicate'|'skipped' }.
 */
export function createHeldAlerter({
  provider = null,
  to = SUPPORT_EMAIL,
  log = (line) => process.stderr.write(`${line}\n`),
} = {}) {
  const sentKeys = new Set();
  return {
    async notify(entry) {
      if (!provider) {
        log(`[site-api] held alert skipped (RESEND_API_KEY not set): ${entry.reason}`);
        return { status: 'skipped' };
      }
      const key = alertKey(entry);
      if (sentKeys.has(key)) return { status: 'duplicate' };
      sentKeys.add(key);
      if (sentKeys.size > SENT_KEYS_MAX) sentKeys.delete(sentKeys.values().next().value);
      let outcome;
      try {
        outcome = await provider.send({ to, ...heldAlertEmail(entry), idempotencyKey: key });
      } catch (error) {
        outcome = { status: 'failed', error: String(error?.message ?? error).slice(0, 200) };
      }
      // A failed send may go out again when Groble or a later event brings the same order back.
      if (outcome.status === 'failed') sentKeys.delete(key);
      log(`[site-api] held alert ${outcome.status} for ${entry.merchantUid ?? entry.reason}${outcome.error ? `: ${outcome.error}` : ''}`);
      return { status: outcome.status };
    },
  };
}
