#!/usr/bin/env node
// Local stand-in for WorkOS, for a live check of the account sign-in:
//   node tests/fixtures/run-fake-workos.mjs [port] [email]
// then start the server with WORKOS_API_BASE=http://127.0.0.1:<port>, WORKOS_API_KEY=sk_local and
// ACCOUNT_AUTH_REDIRECT_URI=http://127.0.0.1:<server port>/v1/account/auth/callback. Every authorize
// request signs in `email` (verified) and redirects back with a code, like a finished AuthKit page.
import { DEFAULT_WORKOS_CLIENT_ID } from '../../workos.mjs';
import { createFakeWorkOS } from './fake-workos.mjs';

const port = Number(process.argv[2] ?? 5198);
const email = process.argv[3] ?? 'live@example.com';
const fake = createFakeWorkOS({ apiKey: 'sk_local', clientId: process.env.WORKOS_CLIENT_ID || DEFAULT_WORKOS_CLIENT_ID });
fake.setNextUser({ email, firstName: '하마' });
const base = await fake.listen(port);
process.stderr.write(`[fake-workos] ${base} (signs in ${email})\n`);
