import { grobleSignature } from '../../groble-webhook.mjs';

// Groble `subscription_payment.completed` for the Basic products, shaped like
// https://groble.im/help/guides/webhook-events (read 2026-10-19). Product ids are test-only.

export const BASIC_MONTHLY_ID = 'BasMo1';
export const BASIC_YEARLY_ID = 'BasYr1';
export const BASIC_ENV = { GROBLE_BASIC_PRODUCT_IDS: `${BASIC_MONTHLY_ID}:1,${BASIC_YEARLY_ID}:12` };
export const BASIC_PRODUCTS = [{ id: BASIC_MONTHLY_ID, months: 1 }, { id: BASIC_YEARLY_ID, months: 12 }];

/**
 * One paid Basic round. `cycle` is the event's `billingCycleMonths`; `null` drops the field.
 * Round 1 is INITIAL, later rounds RENEWAL.
 */
export function basicPaid({
  merchantUid = 'pro_m1',
  ref = 'hama-pro-1',
  email = 'pro@example.com',
  contentId = BASIC_MONTHLY_ID,
  price = contentId === BASIC_YEARLY_ID ? 39000 : 3900,
  round = 1,
  paidAt = '2026-10-20T14:22:11+09:00',
  cycle = contentId === BASIC_YEARLY_ID ? 12 : 1,
} = {}) {
  return {
    id: `evt_pro_${merchantUid}`,
    type: 'subscription_payment.completed',
    version: '2026-04-30',
    occurredAt: paidAt,
    data: { object: {
      merchantUid,
      ...(ref ? { sellerReference: ref } : {}),
      buyer: { type: 'MEMBER', displayName: '베이직 구독자', email },
      content: { id: contentId, title: 'HamaEditor Basic', type: 'SERVICE', paymentType: 'SUBSCRIPTION' },
      pricing: { currency: 'KRW', originalAmount: price, finalAmount: price },
      payment: { purchasedAt: paidAt },
      subscription: {
        billingReason: round === 1 ? 'INITIAL' : 'RENEWAL',
        currentRound: round,
        status: 'ACTIVE',
        activatedAt: paidAt,
        ...(cycle === null ? {} : { billingCycleMonths: cycle }),
      },
    } },
  };
}

/** POST a Groble event to a running site API, signed with `secret`. */
export function signedGroblePost(origin, secret, body, idem = `idem-${Math.random()}`) {
  const raw = JSON.stringify(body);
  const ts = String(Math.floor(Date.now() / 1000));
  return fetch(`${origin}/v1/groble/webhook`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Groble-Signature': grobleSignature(secret, ts, raw),
      'X-Groble-Timestamp': ts,
      'X-Groble-Idempotency-Key': idem,
    },
    body: raw,
  });
}
