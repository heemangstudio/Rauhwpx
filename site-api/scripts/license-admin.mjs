#!/usr/bin/env node
// Admin CLI for the license server. Talks to the deployed API over HTTPS.
//   export SITE_API_BASE=https://rau-credits-production.up.railway.app
//   export ADMIN_TOKEN=...            # same value as the Railway ADMIN_TOKEN variable
//   node scripts/license-admin.mjs issue --email buyer@example.com --merchant-uid <groble merchantUid> [--ref r] [--note "..."] [--send-email]
//   node scripts/license-admin.mjs beta --name "홍길동" [--devices 5] [--email tester@example.com] [--note "..."]   # beta-tester key, 1..50 devices, never emailed
//   node scripts/license-admin.mjs betas                               # every beta key with its devices
//   node scripts/license-admin.mjs lookup --email buyer@example.com | --key HAMA-... | --merchant-uid ... | --ref ...
//   node scripts/license-admin.mjs orders [--status held|issued|refunded]
//   node scripts/license-admin.mjs webhooks [--rejected | --held] [--limit 50]   # recorded webhook rejections and holds
//   node scripts/license-admin.mjs release --merchant-uid ...          # issue a key for a held order
//   node scripts/license-admin.mjs revoke --key HAMA-... | --merchant-uid ... [--reason "..."]
//   node scripts/license-admin.mjs restore --key HAMA-...
//   node scripts/license-admin.mjs reset-devices --key HAMA-...
//   node scripts/license-admin.mjs resend-email --key HAMA-... [--email new@example.com]
import { adminRequest, siteApiBase } from './admin-request.mjs';

const [command, ...rest] = process.argv.slice(2);
const args = {};
for (let i = 0; i < rest.length; i += 1) {
  const name = rest[i].replace(/^--/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  const next = rest[i + 1];
  if (next === undefined || next.startsWith('--')) args[name] = true;
  else { args[name] = next; i += 1; }
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
  release: '/v1/admin/orders/release',
};
const gets = {
  lookup: '/v1/admin/licenses',
  betas: '/v1/admin/licenses/betas',
  orders: '/v1/admin/orders',
  webhooks: '/v1/admin/webhooks',
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
  res = await adminRequest({ base, token, method: 'POST', path: posts[command], body });
} else {
  process.stderr.write('usage: license-admin.mjs issue|beta|betas|lookup|orders|webhooks|release|revoke|restore|reset-devices|resend-email [--flags]\n');
  process.exit(2);
}
const parsed = res.json;
const pretty = parsed ? JSON.stringify(parsed, null, 2) : res.text;
process.stdout.write(`${res.status} ${pretty}\n`);
// The key alone on the last line, so it can be copied without picking through the JSON.
if (command === 'beta' && res.ok && parsed?.license?.key) {
  process.stdout.write(`\n${parsed.license.name} (${parsed.license.deviceLimit} devices): ${parsed.license.key}\n`);
}
process.exit(res.ok ? 0 : 1);
