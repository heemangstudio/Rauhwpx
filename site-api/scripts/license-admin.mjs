#!/usr/bin/env node
// Admin CLI for the license server. Talks to the deployed API over HTTPS.
//   export SITE_API_BASE=https://rau-credits-production.up.railway.app
//   export ADMIN_TOKEN=...            # same value as the Railway ADMIN_TOKEN variable
//   node scripts/license-admin.mjs issue --email buyer@example.com --merchant-uid <groble merchantUid> [--ref r] [--note "..."] [--send-email] [--years 1 | --until 2027-10-20]   # --years/--until = subscription key
//   node scripts/license-admin.mjs issue --edition signature --email buyer@example.com [--product-id 8Xy27f] [--updates-until 2029-10-20] [--send-email]
//   node scripts/license-admin.mjs extend <key|ref> [--years N | --until YYYY-MM-DD] [--note "..."]   # subscription keys only; default 1 year from expiry (or now if lapsed)
//   node scripts/license-admin.mjs beta --name "홍길동" [--devices 5] [--email tester@example.com] [--note "..."] [--gift-usd 20]   # beta-tester key, 1..50 devices, never emailed
//   node scripts/license-admin.mjs betas                               # every beta key with its devices
//   node scripts/license-admin.mjs signatures                          # Signature Edition keys (priority email support)
//   node scripts/license-admin.mjs lookup --email buyer@example.com | --key HAMA-... | --merchant-uid ... | --ref ...
//   node scripts/license-admin.mjs orders [--status held|issued|refunded]
//   node scripts/license-admin.mjs webhooks [--rejected | --held] [--limit 50]   # recorded webhook rejections and holds
//   node scripts/license-admin.mjs release --merchant-uid ...          # issue a key for a held order
//   node scripts/license-admin.mjs apply-renewal --merchant-uid ... --key HAMA-...   # a held renewal onto the buyer's annual key
//   node scripts/license-admin.mjs attention                          # held orders and events waiting for review
//   node scripts/license-admin.mjs ack --id wh_... | --merchant-uid ...   # dismiss one of them
//   node scripts/license-admin.mjs customers                          # paid keys with term, devices and email delivery
//   node scripts/license-admin.mjs remove-device --key-id lic_... --device-id ...   # free one device, keep the others
//   node scripts/license-admin.mjs revoke --key HAMA-... | --merchant-uid ... [--reason "..."]
//   node scripts/license-admin.mjs restore --key HAMA-...
//   node scripts/license-admin.mjs reset-devices --key HAMA-...
//   node scripts/license-admin.mjs resend-email --key HAMA-... [--email new@example.com]
//   node scripts/license-admin.mjs downloads [--days 30]             # website download starts by day, platform and version
//   node scripts/license-admin.mjs gifts [--status active|revoked|provisioning] [--event-id special-2026-10]
//   node scripts/license-admin.mjs gift-disable --key-id lic_... [--reason "..."]   # disables the OpenRouter key too
//   node scripts/license-admin.mjs gift-amount --key-id lic_... --usd 30   # this beta key's gift; 0 = none, a claimed key's limit changes on OpenRouter
import { adminRequest, siteApiBase } from './admin-request.mjs';

const [command, ...argv] = process.argv.slice(2);
// `extend` takes the key or success-page ref as its first word.
const target = command === 'extend' && argv[0] && !argv[0].startsWith('--') ? argv[0] : undefined;
const rest = target ? argv.slice(1) : argv;
const args = {};
for (let i = 0; i < rest.length; i += 1) {
  const name = rest[i].replace(/^--/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  const next = rest[i + 1];
  if (next === undefined || next.startsWith('--')) args[name] = true;
  else { args[name] = next; i += 1; }
}
if (command === 'extend') {
  if (!target) { process.stderr.write('usage: license-admin.mjs extend <key|ref> [--years N | --until YYYY-MM-DD] [--note "..."]\n'); process.exit(2); }
  if (/^HAMA[-\s]?/i.test(target)) args.key = target;
  else if (target.startsWith('lic_')) args.keyId = target;
  else args.ref = target;
}
const base = siteApiBase();
const token = process.env.ADMIN_TOKEN;
if (!token) { process.stderr.write('ADMIN_TOKEN is not set\n'); process.exit(2); }

const posts = {
  issue: '/v1/admin/licenses/issue',
  beta: '/v1/admin/licenses/issue-beta',
  revoke: '/v1/admin/licenses/revoke',
  restore: '/v1/admin/licenses/restore',
  'reset-devices': '/v1/admin/licenses/reset-devices',
  'resend-email': '/v1/admin/licenses/resend-email',
  extend: '/v1/admin/licenses/extend',
  release: '/v1/admin/orders/release',
  'apply-renewal': '/v1/admin/orders/apply-renewal',
  ack: '/v1/admin/attention/ack',
  'remove-device': '/v1/admin/licenses/remove-device',
  'gift-disable': '/v1/admin/gifts/disable',
  'gift-amount': '/v1/admin/gifts/amount',
};
const gets = {
  lookup: '/v1/admin/licenses',
  betas: '/v1/admin/licenses/betas',
  signatures: '/v1/admin/licenses/signatures',
  customers: '/v1/admin/licenses/customers',
  attention: '/v1/admin/attention',
  orders: '/v1/admin/orders',
  webhooks: '/v1/admin/webhooks',
  gifts: '/v1/admin/gifts',
  downloads: '/v1/admin/downloads',
};
if (command === 'webhooks') {
  if (args.rejected && args.held) { process.stderr.write('pick one of --rejected or --held\n'); process.exit(2); }
  if (args.rejected || args.held) args.kind = args.rejected ? 'rejected' : 'held';
  delete args.rejected;
  delete args.held;
}
let res;
if (gets[command]) {
  res = await adminRequest({ base, token, path: gets[command], query: args });
} else if (posts[command]) {
  const body = { ...args };
  if (command === 'issue') body.sendEmail = args.sendEmail === true;
  if (body.amount) body.amount = Number(body.amount);
  if (command === 'beta') {
    if (typeof args.name !== 'string') { process.stderr.write('beta needs --name "tester name"\n'); process.exit(2); }
  }
  if (command === 'gift-amount') {
    if (typeof args.keyId !== 'string' || typeof args.usd !== 'string') { process.stderr.write('gift-amount needs --key-id lic_... --usd N\n'); process.exit(2); }
    body.amountUsd = args.usd;
    delete body.usd;
  }
  res = await adminRequest({ base, token, method: 'POST', path: posts[command], body });
} else {
  process.stderr.write('usage: license-admin.mjs issue|beta|betas|signatures|customers|lookup|orders|webhooks|attention|ack|release|apply-renewal|revoke|restore|reset-devices|remove-device|resend-email|extend|downloads|gifts|gift-disable|gift-amount [--flags]\n');
  process.exit(2);
}
const parsed = res.json;
const pretty = parsed ? JSON.stringify(parsed, null, 2) : res.text;
process.stdout.write(`${res.status} ${pretty}\n`);
const kstDate = (iso) => new Date(Date.parse(iso) + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
/** One line per key: plan, status and how long it runs (KST date). */
function expiryLine(license) {
  if (license.edition === 'signature') {
    const until = license.updatesUntil ? ` · 업데이트 약속 ~${kstDate(license.updatesUntil)}` : '';
    return `${license.key} signature · ${license.status} · 우선지원 1영업일${until}`;
  }
  if (!license.expiresAt) return `${license.key} ${license.plan ?? 'lifetime'} · ${license.status} · 평생`;
  const renews = license.subscription?.autoRenew === false ? '갱신 안 함' : '자동 갱신';
  const failed = license.subscription?.status === 'past_due' && license.subscription.paymentGraceEndsAt
    ? ` · 결제 실패, ${kstDate(license.subscription.paymentGraceEndsAt)}까지 유예` : '';
  return `${license.key} annual · ${license.status} · ${kstDate(license.expiresAt)}까지 · ${renews}${failed}`;
}
if (command === 'downloads' && res.ok && parsed) {
  const pairs = (counts) => Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(', ') || '-';
  const lines = [`${parsed.total} downloads since ${parsed.since} · ${pairs(parsed.byPlatform)} · ${pairs(parsed.byVersion)}`];
  for (const day of parsed.byDay) lines.push(`${day.day} ${day.total} (${pairs(day.counts)})`);
  process.stdout.write(`\n${lines.join('\n')}\n`);
}
const listed = parsed?.licenses ?? parsed?.signatures ?? (parsed?.license ? [parsed.license] : []);
if (res.ok && listed.length && listed.every((l) => l.key)) {
  process.stdout.write(`\n${listed.map(expiryLine).join('\n')}\n`);
}
// The key alone on the last line, so it can be copied without picking through the JSON.
if (command === 'beta' && res.ok && parsed?.license?.key) {
  process.stdout.write(`\n${parsed.license.name} (${parsed.license.deviceLimit} devices): ${parsed.license.key}\n`);
}
process.exit(res.ok ? 0 : 1);
