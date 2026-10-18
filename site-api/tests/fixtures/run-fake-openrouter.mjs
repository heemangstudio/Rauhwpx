#!/usr/bin/env node
// Local stand-in for OpenRouter, for a live check of the gift proxy:
//   node tests/fixtures/run-fake-openrouter.mjs [port] [chunkDelayMs]
// then start the server with OPENROUTER_API_BASE=http://127.0.0.1:<port>/api/v1 and
// OPENROUTER_PROVISIONING_KEY=pk-local.
import { createFakeOpenRouter } from './fake-openrouter.mjs';

const port = Number(process.argv[2] ?? 5199);
const delay = Number(process.argv[3] ?? 400);
const fake = createFakeOpenRouter({ provisioningKey: 'pk-local', autoRelease: delay });
const base = await fake.listen(port);
process.stderr.write(`[fake-openrouter] ${base} (chunk every ${delay} ms)\n`);
