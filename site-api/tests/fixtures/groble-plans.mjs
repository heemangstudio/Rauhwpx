import { grobleSignature } from '../../groble-webhook.mjs';

// Groble `subscription_payment.completed` for the Hama and Rau products, shaped like
// https://groble.im/help/guides/webhook-events (read 2026-10-31): a subscription event carries exactly
// one `options` item with quantity 1. The ids are the real defaults in config.mjs.

export const PRODUCTS = Object.freeze({
  hamaMonthly: { id: 'SfYBy5', months: 1, price: 3900, optionId: null },
  hamaYearly: { id: 'vdw3HN', months: 12, price: 39000, optionId: '8JF8jD' },
  rauMonthly: { id: 'R3n8zG', months: 1, price: 14900, optionId: 't3QJ4b' },
  rauYearly: { id: 'atqjpJ', months: 12, price: 149000, optionId: 'nqSZ94' },
});

/**
 * One paid round of `sku`. `cycle` is the event's `billingCycleMonths` (`null` drops it); `options`
 * replaces the option list (`null` drops the field). Round 1 is INITIAL, later rounds RENEWAL.
 * `contentId` and `price` override the product (GLJFC9 rounds use them).
 */
export function planPaid({
  sku = 'hamaMonthly',
  merchantUid = `m_${sku}`,
  ref = `ref-${sku}`,
  email = 'buyer@example.com',
  contentId = PRODUCTS[sku].id,
  price = PRODUCTS[sku].price,
  round = 1,
  paidAt = '2026-10-20T14:22:11+09:00',
  cycle = PRODUCTS[sku].months,
  options,
} = {}) {
  const product = PRODUCTS[sku];
  const list = options !== undefined ? options : [{
    optionId: product.optionId ?? 'default_option',
    name: product.months === 1 ? '월간 플랜' : '연간 플랜',
    quantity: 1,
    unitOriginalPrice: price,
    unitDiscountedPrice: price,
    additionalOptions: [],
    subtotal: price,
  }];
  return {
    id: `evt_${merchantUid}`,
    type: 'subscription_payment.completed',
    version: '2026-04-30',
    occurredAt: paidAt,
    data: { object: {
      merchantUid,
      ...(ref ? { sellerReference: ref } : {}),
      buyer: { type: 'MEMBER', displayName: '구독자', email },
      content: { id: contentId, title: 'HamaEditor', type: 'SERVICE', paymentType: 'SUBSCRIPTION' },
      ...(list === null ? {} : { options: list }),
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
