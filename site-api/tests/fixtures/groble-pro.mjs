import { grobleSignature } from '../../groble-webhook.mjs';

// Groble `subscription_payment.completed` for the Pro products, shaped like
// https://groble.im/help/guides/webhook-events (read 2026-10-19). Product ids are test-only.

export const PRO_MONTHLY_ID = 'ProMo1';
export const PRO_YEARLY_ID = 'ProYr1';
export const PRO_ENV = { GROBLE_PRO_PRODUCT_IDS: `${PRO_MONTHLY_ID}:1,${PRO_YEARLY_ID}:12` };
export const PRO_PRODUCTS = [{ id: PRO_MONTHLY_ID, months: 1 }, { id: PRO_YEARLY_ID, months: 12 }];

/**
 * One paid Pro round. `cycle` is the event's `billingCycleMonths`; `null` drops the field.
 * Round 1 is INITIAL, later rounds RENEWAL.
 */
export function proPaid({
  merchantUid = 'pro_m1',
  ref = 'hama-pro-1',
  email = 'pro@example.com',
  contentId = PRO_MONTHLY_ID,
  price = contentId === PRO_YEARLY_ID ? 39000 : 3900,
  round = 1,
  paidAt = '2026-10-20T14:22:11+09:00',
  cycle = contentId === PRO_YEARLY_ID ? 12 : 1,
} = {}) {
  return {
    id: `evt_pro_${merchantUid}`,
    type: 'subscription_payment.completed',
    version: '2026-04-30',
    occurredAt: paidAt,
    data: { object: {
      merchantUid,
      ...(ref ? { sellerReference: ref } : {}),
      buyer: { type: 'MEMBER', displayName: '프로 구독자', email },
      content: { id: contentId, title: 'HamaEditor Pro', type: 'SERVICE', paymentType: 'SUBSCRIPTION' },
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
