import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createRauSession } from '../agents/rau.mjs';
import { RAU_AGENT_UNAVAILABLE_MESSAGE, RAU_CREDITS_MESSAGE } from '../agents/pi.mjs';
import { tasteLearningAllowed } from '../byok-taste.mjs';
import { normalizeProviderFailureEvent } from '../provider-failure.mjs';
import { parseRauCredits, RAU_AGENT_MODEL } from '../rau-agent.mjs';
import { createRauAgentHarness, createStaticRauAgentSource } from '../rau-agent-hosted.mjs';

const SITE = 'https://site.example.test';
const LEASE = [
  Buffer.from(JSON.stringify({ v: 2, kid: 'test-1', accountId: 'acc-1', deviceId: 'dev-1', tier: 'rau', expiresAt: 9e12 })).toString('base64url'),
  randomBytes(64).toString('base64url'),
].join('.');
const RESETS_AT = '2026-11-01T00:00:00.000Z';

function serverStatus(overrides = {}) {
  return {
    ok: true,
    eligible: true,
    source: 'plan',
    allowanceUsd: 8,
    usedUsd: 1.5,
    remainingUsd: 6.5,
    resetsAt: Date.parse(RESETS_AT),
    agent: { baseUrl: '/v1/rau/agent', model: 'rau', contextWindow: 200000, maxOutputTokens: 16000 },
    ...overrides,
  };
}

const active = (status = serverStatus()) => ({ availability: 'active', lease: LEASE, apiBase: SITE, status });

async function setUp(t, answer = active()) {
  const piRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-rau-agent-'));
  t.after(() => fs.rm(piRoot, { recursive: true, force: true, maxRetries: 3 }));
  const source = createStaticRauAgentSource(answer);
  const harness = createRauAgentHarness({ piRoot, source, isPiInstalled: () => true, platform: 'darwin' });
  return { harness, source, piRoot };
}

test('the Rau home has one Rau model on the site route with budget thinking, no key and no model or vendor name', async (t) => {
  const { harness, piRoot } = await setUp(t);
  const snapshot = await harness.refresh();
  const text = await fs.readFile(path.join(piRoot, 'agent-rau', 'models.json'), 'utf8');
  const provider = JSON.parse(text).providers.openrouter;
  assert.equal('apiKey' in provider, false);
  assert.equal(text.includes(LEASE), false);
  assert.doesNotMatch(text, /haiku|claude|sonnet|opus|deepseek/i);
  assert.equal(provider.models.length, 1);
  const [rau] = provider.models;
  assert.deepEqual(
    [rau.id, rau.name, rau.api, rau.baseUrl, rau.contextWindow, rau.maxTokens, rau.input],
    ['rau', 'Rau', 'anthropic-messages', `${SITE}/v1/rau/agent`, 200000, 16000, ['text', 'image']],
  );
  // 서버 모델은 adaptive thinking·effort 를 받지 않는다. Pi 는 이 표시가 없을 때만 budget_tokens 로 보낸다.
  assert.equal(rau.reasoning, true);
  assert.equal(rau.compat?.forceAdaptiveThinking, undefined);
  assert.deepEqual(rau.thinkingLevelMap, { minimal: null, xhigh: null, max: null });
  assert.deepEqual(rau.cost, { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 });

  assert.equal(snapshot.availability, 'active');
  assert.equal(snapshot.source, 'plan');
  assert.deepEqual(snapshot.credits, { allowanceUsd: 8, usedUsd: 1.5, remainingUsd: 6.5, resetsAt: Date.parse(RESETS_AT) });
  assert.equal(snapshot.exhausted, false);
  assert.equal(snapshot.defaultModelId, RAU_AGENT_MODEL);
  assert.deepEqual(snapshot.models.map((model) => [model.id, model.name, model.efforts, model.defaultEffort]),
    [['rau', 'Rau', ['low', 'medium', 'high'], 'medium']]);
  assert.equal(snapshot.ready, true);
  assert.deepEqual(['caps', 'blocked', 'cheapModelIds', 'plan'].filter((key) => key in snapshot), []);
});

test('a free or Hama account, or an unreachable server, never runs Rau and never gets the lease', async (t) => {
  const { harness, source } = await setUp(t, { availability: 'not_eligible', reason: 'rau_plan_required' });
  const notEligible = await harness.refresh();
  assert.deepEqual(
    [notEligible.availability, notEligible.source, notEligible.credits, notEligible.models.length, notEligible.ready],
    ['not_eligible', null, null, 0, false],
  );
  const access = harness.resolveSpawn();
  assert.deepEqual([access.mode, access.key, access.reason], ['none', null, 'rau-unavailable']);
  assert.equal(harness.secret(), null);

  source.set(active());
  assert.equal((await harness.refresh()).availability, 'active');
  assert.equal(harness.resolveSpawn().key, LEASE);
  // 서버가 자격이 없다고 답하면 lease 를 받았어도 쓰지 않는다.
  source.set(active(serverStatus({ eligible: false, source: null })));
  assert.equal((await harness.refresh()).availability, 'not_eligible');
  assert.equal(harness.secret(), null);
  source.set(active(serverStatus({ agent: { baseUrl: 'https://elsewhere.example/v1/messages' } })));
  assert.equal((await harness.refresh()).availability, 'unavailable');
  source.set({ availability: 'unavailable', reason: 'rau_not_configured' });
  assert.equal((await harness.refresh()).availability, 'unavailable');
  assert.equal(harness.active(), false);
});

test('a trial reads as Rau with its own credits', async (t) => {
  const { harness } = await setUp(t, active(serverStatus({ source: 'trial', allowanceUsd: 2, usedUsd: 2, remainingUsd: 0 })));
  const snapshot = await harness.refresh();
  assert.deepEqual([snapshot.availability, snapshot.source, snapshot.exhausted], ['active', 'trial', true]);
});

test('a Rau turn without eligibility stops before spawning and never falls back to a user key', async (t) => {
  const { harness } = await setUp(t, { availability: 'not_eligible', reason: 'rau_plan_required' });
  await harness.refresh();
  const { session, events, spawns } = rauSession(harness, { openRouterApiKey: ['test', 'own', 'key'].join('-') });
  session.sendUserMessage('hi');
  await settle();
  assert.equal(spawns.length, 0);
  const failed = events.find((event) => event.type === 'error');
  assert.equal(failed.agent, 'rau');
  assert.equal(failed.message, RAU_AGENT_UNAVAILABLE_MESSAGE);
  assert.equal(normalizeProviderFailureEvent(failed, { agent: 'rau' }).failure.class, 'auth_required');
  await session.dispose();
});

test('a credits-tagged 429 becomes a typed usage-limit failure with the reset time and marks Rau exhausted', async (t) => {
  const { harness, source, piRoot } = await setUp(t);
  await harness.refresh();
  const exhausted = [];
  const { session, events, spawns } = rauSession(harness, {
    effort: 'medium',
    reasoning: true,
    onRauCredits: (info) => { exhausted.push(info); void harness.noteCreditsExhausted(info); },
  });
  session.sendUserMessage('hi');
  const { proc, options, argv } = spawns[0];
  assert.equal(options.env.OPENROUTER_API_KEY, LEASE);
  assert.equal(options.env.PI_CODING_AGENT_DIR, path.join(piRoot, 'agent-rau'));
  assert.equal(options.env.RHWP_AGENT_NAME, 'rau');
  assert.ok(argv.includes('openrouter/rau'));
  assert.equal(argv[argv.indexOf('--thinking') + 1], 'medium');

  source.set(active(serverStatus({ usedUsd: 8, remainingUsd: 0 })));
  const tag = `[rau-credits:${RESETS_AT}]`;
  proc.emitJson(
    {
      type: 'message_end',
      message: {
        role: 'assistant', content: [], stopReason: 'error',
        errorMessage: `429 {"type":"error","error":{"type":"rau_credits_exhausted","message":"Rau quota exceeded until ${RESETS_AT}. ${tag}"}}`,
      },
    },
    { type: 'agent_settled' },
  );
  proc.exit(0);
  const failed = events.find((event) => event.type === 'error');
  assert.equal(failed.agent, 'rau');
  assert.equal(failed.failure.code, 'rau_credits_exhausted');
  assert.ok(failed.message.startsWith(RAU_CREDITS_MESSAGE));
  assert.ok(failed.message.includes(tag), 'Studio reads the reset time from the tag');
  assert.deepEqual(exhausted, [{ resetsAt: Date.parse(RESETS_AT) }]);

  const { failure } = normalizeProviderFailureEvent(failed, { agent: 'rau' });
  assert.deepEqual([failure.class, failure.code, failure.resetAt], ['usage_limit', 'rau_credits_exhausted', Date.parse(RESETS_AT)]);

  await settle();
  const snapshot = harness.snapshot();
  assert.equal(snapshot.exhausted, true);
  assert.equal(snapshot.credits.remainingUsd, 0);
  await session.dispose();
});

test('a credits failure on stderr still carries the tag', async (t) => {
  const { harness } = await setUp(t);
  await harness.refresh();
  const { session, events, spawns } = rauSession(harness);
  session.sendUserMessage('hi');
  spawns[0].proc.stderr.emit('data', `Error: 429 Rau quota exceeded [rau-credits:${RESETS_AT}]\n`);
  spawns[0].proc.exit(1);
  await settle();
  const failed = events.find((event) => event.type === 'error');
  assert.equal(failed.failure.code, 'rau_credits_exhausted');
  assert.ok(failed.message.includes(`[rau-credits:${RESETS_AT}]`));
  await session.dispose();
});

test('a mid-session 403 rau_plan_required becomes the Rau-not-active failure that offers the upgrade', async (t) => {
  const { harness } = await setUp(t);
  await harness.refresh();
  const rejected = [];
  const { session, events, spawns } = rauSession(harness, { onAccessRejected: (info) => rejected.push(info) });
  session.sendUserMessage('hi');
  spawns[0].proc.emitJson(
    {
      type: 'message_end',
      message: {
        role: 'assistant', content: [], stopReason: 'error',
        errorMessage: '403 {"type":"error","error":{"type":"rau_plan_required","message":"Rau is not part of this plan."}}',
      },
    },
    { type: 'agent_settled' },
  );
  spawns[0].proc.exit(0);
  await settle();
  const failed = events.find((event) => event.type === 'error');
  assert.equal(failed.failure.code, 'RAU_AGENT_NOT_ACTIVE');
  assert.ok(failed.message.startsWith(RAU_AGENT_UNAVAILABLE_MESSAGE));
  const { failure } = normalizeProviderFailureEvent(failed, { agent: 'rau' });
  assert.deepEqual([failure.class, failure.code], ['auth_required', 'RAU_AGENT_NOT_ACTIVE']);
  assert.deepEqual(rejected, [{ mode: 'rau', status: 403 }], 'the hub asks for its standing again');
  await session.dispose();
});

test('the credits tag parser reads the reset time and ignores look-alikes', () => {
  assert.deepEqual(parseRauCredits(`x [rau-credits:${RESETS_AT}] y`), { resetsAt: Date.parse(RESETS_AT) });
  assert.equal(parseRauCredits('[rau-credits:2026-11-01T00:00:00Z]').resetsAt, Date.parse('2026-11-01T00:00:00Z'));
  assert.equal(parseRauCredits('Rau quota exceeded'), null);
  assert.equal(parseRauCredits('[hama-cap:cap_5h:2026-11-01T00:00:00Z]'), null);
  assert.equal(parseRauCredits('[rau-credits:soon]'), null);
});

test('Rau-0.1 taste learning skips BYOK chats only', () => {
  assert.equal(tasteLearningAllowed('pi'), false);
  for (const agent of ['claude', 'codex', 'rau']) assert.equal(tasteLearningAllowed(agent), true);
});

function rauSession(harness, extra = {}) {
  const events = [];
  const spawns = [];
  const session = createRauSession({
    rootDir: '/tmp/rhwp',
    hubPort: 6201,
    token: 'hub-token',
    sessionId: 'rau-chat',
    piBin: '/pi/bin/pi',
    piRoot: path.dirname(harness.agentDir),
    permissionProfile: 'safe',
    onEvent: (event) => events.push(event),
    resolvePiAccess: () => harness.resolveSpawn(),
    ...extra,
  }, {
    spawnProcess(command, argv, options) {
      const proc = new FakeProcess();
      spawns.push({ command, argv, options, proc });
      return proc;
    },
    terminateProcess: async () => true,
    waitForExit: async () => true,
  });
  return { session, events, spawns };
}

async function settle() {
  for (let index = 0; index < 10; index += 1) await new Promise((resolve) => setImmediate(resolve));
}

class FakeStream extends EventEmitter {
  chunks = [];
  ended = false;
  end(chunk) {
    if (chunk !== undefined) this.chunks.push(String(chunk));
    this.ended = true;
  }
}

class FakeProcess extends EventEmitter {
  stdin = new FakeStream();
  stdout = new FakeStream();
  stderr = new FakeStream();
  exitCode = null;
  signalCode = null;
  signals = [];
  kill(signal) {
    this.signals.push(signal);
    return true;
  }
  emitJson(...events) {
    this.stdout.emit('data', events.map((event) => JSON.stringify(event)).join('\n') + '\n');
  }
  exit(code) {
    this.exitCode = code;
    this.emit('exit', code, null);
    this.emit('close', code, null);
  }
}
