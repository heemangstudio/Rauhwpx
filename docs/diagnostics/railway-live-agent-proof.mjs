// Railway worker probe. Credentials stay in memory; only timings and fixture results are printed.
// Required env: RAU_PROOF_PROJECT, RAU_PROOF_ENVIRONMENT, RAU_PROOF_SERVICE, RAU_PROOF_ENDPOINT.
// Pass --edit to run a real Codex edit against a disposable worker, using local Codex auth.
// Delete that disposable worker afterward to remove its imported credentials and fixture data.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { inflateRawSync } from 'node:zlib';
import { CloudClient } from '../../desktop/cloud-client.mjs';
import { collectProviderAuth } from '../../desktop/cloud-provider-auth.mjs';

const endpoint = process.env.RAU_PROOF_ENDPOINT;
assert(endpoint?.startsWith('https://'), 'Set RAU_PROOF_ENDPOINT to the disposable Railway worker HTTPS base path');
const durations = [];
let health;
for (let i = 0; i < 20; i++) {
  const start = performance.now();
  const response = await fetch(`${endpoint}/v1/health`, { signal: AbortSignal.timeout(10_000) });
  assert.equal(response.status, 200);
  health = await response.json();
  assert.equal(health.ok, true);
  durations.push(Math.round(performance.now() - start));
}
const sorted = [...durations.slice(1)].sort((a, b) => a - b);
console.log(JSON.stringify({ probe: 'railway-health', version: health.version, samples: durations,
  p50Ms: sorted[Math.floor(sorted.length * .5)], p95Ms: sorted[Math.ceil(sorted.length * .95) - 1] }));
if (!process.argv.includes('--edit')) process.exit(0);

const variables = process.env.RAU_PROOF_BOOTSTRAP_TOKEN ? { RAUHWpx_BOOTSTRAP_TOKEN: process.env.RAU_PROOF_BOOTSTRAP_TOKEN }
  : JSON.parse(execFileSync('railway', ['variable', 'list', '--json',
  '-p', process.env.RAU_PROOF_PROJECT, '-e', process.env.RAU_PROOF_ENVIRONMENT,
  '-s', process.env.RAU_PROOF_SERVICE], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, RAILWAY_CALLER: 'skill:use-railway@1.6.1', RAILWAY_AGENT_SESSION: 'railway-rau-20261001' } }));
const values = new Map();
const client = new CloudClient({ vault: {
  get: async key => values.get(key) ?? null,
  set: async (key, value) => { values.set(key, value); return true; },
  delete: async key => values.delete(key),
} });
const profile = { endpoint, serverPublicKey: health.serverPublicKey, mode: 'app-hosted',
  sandbox: { providerId: 'railway', sandboxId: process.env.RAU_PROOF_SERVICE } };
const receipt = await client.bootstrapPairing({ ...profile, bootstrapToken: variables.RAUHWpx_BOOTSTRAP_TOKEN,
  deviceName: 'Railway latency fixture' });
await client.redeemPairingCode(receipt.pairingCode, 'Railway latency fixture', { profile });
const providerAuth = await collectProviderAuth('codex');
assert(providerAuth, 'Local Codex login required');
const sessions = await client.sessions();
assert.equal((Array.isArray(sessions) ? sessions : sessions.sessions).some(s => ['queued', 'running'].includes(s.status)), false,
  'Use an idle disposable worker');
const sessionId = `railway-proof-${randomUUID()}`;
const marker = `RAILWAY_EDIT_${randomUUID().replaceAll('-', '')}`;
const model = process.env.RAU_PROOF_MODEL || 'gpt-5.6';
const goal = `Append exactly one plain paragraph containing "${marker}" at the end of the document. Keep all existing content. Execute the edit using document tools, then finish. Do not ask questions.`;
const timestamp = Date.now();
const timeline = { schema: 'rauhwpx.cloud.timeline', version: 1, exportedAt: new Date().toISOString(), thread: {
  id: sessionId, title: 'Railway fixture edit', titleRequested: false, createdAt: timestamp, updatedAt: timestamp,
  agent: 'codex', model, effort: 'low', workflow: 'direct', docKey: 'fixture.hwpx', documentId: sessionId,
  activeTemplateId: null, messages: [{ role: 'user', text: goal }],
} };
const started = performance.now();
let completed = false;
let stateVersion = 1;
const eventsController = new AbortController();
let eventsTask;
try {
  await client.transfer({ sessionId, threadId: sessionId, documentId: sessionId, provider: 'codex',
    executionConfig: { model, effort: 'low', workflow: 'direct', permissionProfile: 'unrestricted' }, goal,
    documentName: 'fixture.hwpx', documentBytes: await readFile(new URL('../../rhwp/samples/hwpx_sample2.hwpx', import.meta.url)),
    timeline, providerAuth, limits: { maxDurationSeconds: 900, maxTurns: 10 } });
  console.log(JSON.stringify({ probe: 'railway-transfer', elapsedMs: Math.round(performance.now() - started), sessionId }));
  eventsTask = client.watchSession(sessionId, 0, { signal: eventsController.signal, onEvent: event => {
    const type = event.type ?? event.event;
    if (/error|failed|suspended|tool|turn|running/.test(type)) console.log(JSON.stringify({
      probe: 'railway-agent-event', type, elapsedMs: Math.round(performance.now() - started),
      reason: event.payload?.reason ?? event.data?.reason, code: event.payload?.code ?? event.data?.code,
    }));
  } }).catch(error => { if (!eventsController.signal.aborted) console.log(JSON.stringify({ probe: 'railway-stream-error', code: error.code })); });
  const deadline = Date.now() + 260_000;
  let previous = '';
  while (Date.now() < deadline) {
    const state = await client.session(sessionId);
    const session = state.session ?? state;
    stateVersion = session.stateVersion ?? session.version ?? stateVersion;
    if (previous !== session.status) {
      previous = session.status;
      console.log(JSON.stringify({ probe: 'railway-agent-state', status: previous, elapsedMs: Math.round(performance.now() - started) }));
    }
    if (['failed', 'cancelled', 'suspended'].includes(session.status)) {
      console.log(JSON.stringify({ probe: 'railway-agent-failure', status: session.status,
        reason: session.suspendedReason ?? session.error }));
      assert.fail(`Agent session ${session.status}`);
    }
    if (session.status === 'completed') {
      const result = await client.downloadCheckpoint(sessionId);
      const bytes = result.bytes;
      const end = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
      assert(end >= 0, 'Result must be HWPX');
      let offset = bytes.readUInt32LE(end + 16);
      let xml = '';
      for (let i = 0; i < bytes.readUInt16LE(end + 10); i++) {
        const nameLength = bytes.readUInt16LE(offset + 28);
        const name = bytes.subarray(offset + 46, offset + 46 + nameLength).toString();
        if (/^Contents\/section\d+\.xml$/.test(name)) {
          const local = bytes.readUInt32LE(offset + 42);
          const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
          const compressed = bytes.subarray(start, start + bytes.readUInt32LE(offset + 20));
          xml += (bytes.readUInt16LE(offset + 10) === 8 ? inflateRawSync(compressed) : compressed).toString();
        }
        offset += 46 + nameLength + bytes.readUInt16LE(offset + 30) + bytes.readUInt16LE(offset + 32);
      }
      assert.equal(xml.split(marker).length - 1, 1, 'Real agent marker must appear exactly once in exported document');
      if (process.env.RAU_PROOF_OUTPUT) await writeFile(process.env.RAU_PROOF_OUTPUT, bytes, { mode: 0o600 });
      completed = true;
      console.log(JSON.stringify({ probe: 'railway-real-edit', ok: true, elapsedMs: Math.round(performance.now() - started),
        marker, bytes: bytes.length, sha256: result.sha256 }));
      break;
    }
    await delay(1500);
  }
  assert(completed, 'Real agent edit exceeded deadline');
} finally {
  eventsController.abort();
  await eventsTask;
  if (!completed) await client.command(sessionId, 'session.cancel', { expectedVersion: stateVersion }).catch(() => {});
  await client.disconnect();
}
