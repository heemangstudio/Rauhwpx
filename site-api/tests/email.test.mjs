import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { EMAIL_ASSET_BASE } from '../email-layout.mjs';
import { createEmailProvider, licenseEmail, licenseEmailKind, MAC_DMG_URL } from '../license-email.mjs';
import { createLicensesService, emptyLicensesState } from '../licenses.mjs';
import { createMemoryStore } from '../store.mjs';

const KEY = 'HAMA-ABCDE-FGHJK-MNPQR-STVWX-YZ012';
const ADMIN = 'admin-token-for-email-tests';
const WEBSITE = fileURLToPath(new URL('../../website/', import.meta.url));

const EXPECTED = {
  purchase: { subject: '[HamaEditor] Mac 라이선스 키를 보내드려요', heading: '구매해 주셔서 고마워요.' },
  resend: { subject: '[HamaEditor] Mac 라이선스 키를 다시 보내드려요', heading: '라이선스 키를 다시 보내드려요.' },
  free: { subject: '[HamaEditor] Mac 라이선스 키를 보내드려요', heading: 'HamaEditor 라이선스 키를 보내드려요.' },
  renewal: { subject: '[HamaEditor] Mac 라이선스가 갱신됐어요', heading: '라이선스가 갱신됐어요.' },
};

function imageUrls(html) {
  return [...html.matchAll(/(?:src|background)="([^"]+)"/g)].map((m) => m[1]);
}

for (const [kind, expected] of Object.entries(EXPECTED)) {
  test(`license email (${kind}): subject, key, download button and deployable images`, () => {
    const { subject, text, html } = licenseEmail({ key: KEY, kind });
    assert.equal(subject, expected.subject);
    assert.ok(html.includes(`>${expected.heading}</h1>`));
    assert.ok(html.includes(`>${KEY}</p>`), 'key sits in the card');
    assert.equal(text, KEY, 'plain-text part is the key alone');
    assert.ok(html.includes('<strong>Mac 2대</strong>'));
    assert.equal(html.match(new RegExp(`href="${MAC_DMG_URL}"`, 'g')).length, 2, 'button and Outlook fallback link the dmg');

    const images = imageUrls(html);
    assert.deepEqual([...new Set(images)].sort(), ['banner.png', 'card-stars.png', 'key-icon@2x.png'].map((f) => EMAIL_ASSET_BASE + f));
    for (const url of images) {
      assert.ok(existsSync(`${WEBSITE}assets/email/${url.slice(EMAIL_ASSET_BASE.length)}`), `${url} ships with website/`);
    }
  });
}

test('license email: homepage download URL falls back to the dmg, other links pass through, key is escaped', () => {
  assert.ok(licenseEmail({ key: KEY, downloadUrl: 'https://heemangstudios.com/' }).html.includes(`href="${MAC_DMG_URL}"`));
  const custom = licenseEmail({ key: KEY, downloadUrl: 'https://example.com/a.dmg?x=1&y=2' }).html;
  assert.ok(custom.includes('href="https://example.com/a.dmg?x=1&amp;y=2"'));
  assert.ok(!custom.includes(MAC_DMG_URL));
  assert.ok(licenseEmail({ key: '<b>x</b>' }).html.includes('&lt;b&gt;x&lt;/b&gt;'));
});

test('subscription keys show the renewal or end date under the card; the card holds only the key; lifetime keys show none', () => {
  const expiresAt = Date.parse('2027-10-20T23:59:59.999+09:00');
  const cardOf = (html) => html.slice(html.indexOf('<!-- card'), html.indexOf('<!-- CTA'));
  const frameOf = (html) => html.slice(html.indexOf('<!-- card'), html.lastIndexOf('</table>', html.indexOf('<!-- CTA')));
  for (const kind of ['purchase', 'renewal', 'resend']) {
    const { html, text } = licenseEmail({ key: KEY, kind, expiresAt });
    assert.equal(text, KEY);
    const line = '매년 자동으로 갱신돼요. 다음 갱신일은 2027년 10월 20일이에요.';
    assert.ok(cardOf(html).includes(`>${line}</p>`), `${kind}: date line follows the card`);
    assert.ok(!frameOf(html).includes('2027'), `${kind}: the key card itself has no date`);
    assert.ok(cardOf(html).indexOf(KEY) < cardOf(html).indexOf(line));
  }
  assert.ok(licenseEmail({ key: KEY, expiresAt, autoRenew: false }).html.includes('>2027년 10월 20일까지 쓸 수 있어요.</p>'));
  const lifetime = licenseEmail({ key: KEY }).html;
  assert.ok(!/갱신|일까지 쓸 수/.test(lifetime), 'lifetime keys have no date');
  assert.equal(lifetime, licenseEmail({ key: KEY, expiresAt: null }).html);
});

test('license email kind follows why the key goes out', () => {
  assert.equal(licenseEmailKind({ source: 'groble', emailDelivery: { status: 'pending', renewal: true } }), 'renewal');
  assert.equal(licenseEmailKind({ source: 'groble' }), 'purchase');
  assert.equal(licenseEmailKind({ source: 'manual', merchantUid: 'm_1' }), 'purchase');
  assert.equal(licenseEmailKind({ source: 'manual', amount: 9900 }), 'purchase');
  assert.equal(licenseEmailKind({ source: 'manual' }), 'free');
  assert.equal(licenseEmailKind({ source: 'manual', amount: 0 }), 'free');
  assert.equal(licenseEmailKind({ source: 'groble', emailDelivery: { status: 'pending', resend: true } }), 'resend');
});

test('every send path picks its copy: purchase, released hold, free issue, resend', async () => {
  const sent = [];
  const svc = createLicensesService({
    store: createMemoryStore(emptyLicensesState()),
    adminToken: ADMIN,
    emailProvider: { name: 'test', async send(m) { sent.push(m); return { status: 'sent' }; } },
    log: () => {},
  });
  const order = (merchantUid, finalAmount) => ({
    id: `evt_${merchantUid}`,
    type: 'payment.completed',
    occurredAt: '2026-10-16T01:00:00+09:00',
    data: { object: {
      merchantUid,
      buyer: { email: `${merchantUid}@example.com` },
      content: { id: 'uRshdR', paymentType: 'ONE_TIME' },
      pricing: { currency: 'KRW', originalAmount: 9900, finalAmount },
    } },
  });

  await svc.handleGrobleEvent(order('m_paid', 9900));
  await svc.handleGrobleEvent(order('m_held', 100));
  await svc.admin.release(ADMIN, { merchantUid: 'm_held' });
  const free = await svc.admin.issue(ADMIN, { email: 'beta@example.com', note: 'beta', sendEmail: true });
  await svc.deliverPendingEmails();
  const subjectFor = (to) => sent.filter((m) => m.to === to).map((m) => m.subject);
  assert.deepEqual(subjectFor('m_paid@example.com'), [EXPECTED.purchase.subject]);
  assert.deepEqual(subjectFor('m_held@example.com'), [EXPECTED.purchase.subject]);
  assert.deepEqual(subjectFor('beta@example.com'), [EXPECTED.free.subject]);
  assert.ok(sent.find((m) => m.to === 'beta@example.com').html.includes(EXPECTED.free.heading));

  await svc.admin.resendEmail(ADMIN, { keyId: free.license.keyId, email: 'beta2@example.com' });
  const resent = sent.find((m) => m.to === 'beta2@example.com');
  assert.equal(resent.subject, EXPECTED.resend.subject);
  assert.equal(resent.text, free.license.key);
});

test('Resend request carries the default sender, reply-to, both parts and the idempotency key', async (t) => {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ id: 'email_test' }), { status: 200 });
  };
  t.after(() => { globalThis.fetch = realFetch; });

  const provider = createEmailProvider({ RESEND_API_KEY: 're_test_not_real' });
  const message = licenseEmail({ key: KEY });
  const result = await provider.send({ to: 'buyer@example.com', ...message, idempotencyKey: 'license-k1-q1' });
  assert.deepEqual(result, { status: 'sent', providerId: 'email_test' });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.resend.com/emails');
  assert.equal(calls[0].init.headers['Idempotency-Key'], 'license-k1-q1');
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.from, 'HamaEditor <license@heemangstudios.com>');
  assert.equal(body.reply_to, 'management@heemangstudios.com');
  assert.deepEqual(body.to, ['buyer@example.com']);
  assert.equal(body.subject, message.subject);
  assert.equal(body.text, KEY);
  assert.equal(body.html, message.html);
});
