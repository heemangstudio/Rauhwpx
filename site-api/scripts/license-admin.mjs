#!/usr/bin/env node
// Admin CLI for the license server. Talks to the deployed API over HTTPS.
//   export SITE_API_BASE=https://rau-credits-production.up.railway.app
//   export ADMIN_TOKEN=...            # same value as the Railway ADMIN_TOKEN variable
//   node scripts/license-admin.mjs issue --email buyer@example.com --merchant-uid <groble merchantUid> [--ref r] [--note "..."] [--send-email]
//   node scripts/license-admin.mjs lookup --email buyer@example.com | --key HAMA-... | --merchant-uid ... | --ref ...
//   node scripts/license-admin.mjs orders [--status held|issued|refunded]
//   node scripts/license-admin.mjs release --merchant-uid ...          # issue a key for a held order
//   node scripts/license-admin.mjs revoke --key HAMA-... | --merchant-uid ... [--reason "..."]
//   node scripts/license-admin.mjs restore --key HAMA-...
//   node scripts/license-admin.mjs reset-devices --key HAMA-...
//   node scripts/license-admin.mjs resend-email --key HAMA-... [--email new@example.com]
const [command, ...rest] = process.argv.slice(2);
const args = {};
for (let i = 0; i < rest.length; i += 1) {
  const name = rest[i].replace(/^--/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  const next = rest[i + 1];
  if (next === undefined || next.startsWith('--')) args[name] = true;
  else { args[name] = next; i += 1; }
}
const base = (process.env.SITE_API_BASE || 'https://rau-credits-production.up.railway.app').replace(/\/+$/, '');
const token = process.env.ADMIN_TOKEN;
if (!token) { process.stderr.write('ADMIN_TOKEN is not set\n'); process.exit(2); }

const posts = {
  issue: '/v1/admin/licenses/issue',
  revoke: '/v1/admin/licenses/revoke',
  restore: '/v1/admin/licenses/restore',
  'reset-devices': '/v1/admin/licenses/reset-devices',
  'resend-email': '/v1/admin/licenses/resend-email',
  release: '/v1/admin/orders/release',
};
let res;
if (command === 'lookup' || command === 'orders') {
  const path = command === 'lookup' ? '/v1/admin/licenses' : '/v1/admin/orders';
  const qs = new URLSearchParams(Object.entries(args).map(([k, v]) => [k, String(v)]));
  res = await fetch(`${base}${path}?${qs}`, { headers: { Authorization: `Bearer ${token}` } });
} else if (posts[command]) {
  const body = { ...args };
  if (command === 'issue') body.sendEmail = args.sendEmail === true;
  if (body.amount) body.amount = Number(body.amount);
  res = await fetch(`${base}${posts[command]}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
} else {
  process.stderr.write('usage: license-admin.mjs issue|lookup|orders|release|revoke|restore|reset-devices|resend-email [--flags]\n');
  process.exit(2);
}
const text = await res.text();
process.stdout.write(`${res.status} ${text}\n`);
process.exit(res.ok ? 0 : 1);
