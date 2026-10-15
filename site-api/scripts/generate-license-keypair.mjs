#!/usr/bin/env node
// Generate the Ed25519 keypair that signs activation leases.
//   node scripts/generate-license-keypair.mjs [--out ./license-signing-key.pem]
// Prints the PUBLIC key (safe to commit into the desktop app) to stdout.
// The PRIVATE key is written to a 0600 file (default ./license-signing-key.pem, git-ignored)
// and must go into Railway as LICENSE_SIGNING_PRIVATE_KEY. It is never printed.
import { writeFileSync } from 'node:fs';
import { generateLeaseKeyPair } from '../license-lease.mjs';

const outIndex = process.argv.indexOf('--out');
const out = outIndex > 0 ? process.argv[outIndex + 1] : './license-signing-key.pem';
const pair = generateLeaseKeyPair();
writeFileSync(out, `${pair.privateKeyDerBase64}\n`, { mode: 0o600, flag: 'wx' });
process.stdout.write([
  `Private key (one-line base64 PKCS#8 DER) written to ${out} with mode 0600.`,
  'Set it on Railway:  railway variables --set "LICENSE_SIGNING_PRIVATE_KEY=$(cat ' + out + ')"',
  'Then move the file somewhere safe (password manager) and delete it from disk.',
  '',
  'Public key for the desktop app. Pin it in desktop/license-lease.mjs:',
  `  PRODUCTION_LICENSE_PUBLIC_KEYS = { 'hama-prod-1': '${pair.publicKeyRawBase64}' }`,
  '(raw 32-byte Ed25519 key, base64; GET /v1/license/public-key returns the same value as rawBase64)',
  '',
  'Same public key as SPKI DER base64:',
  pair.publicKeyDerBase64,
  '',
].join('\n'));
