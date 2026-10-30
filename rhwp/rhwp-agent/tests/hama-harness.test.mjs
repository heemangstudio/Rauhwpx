import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createHamaSession } from '../agents/hama.mjs';
import { HAMA_CAP_MESSAGES, HAMA_UNAVAILABLE_MESSAGE } from '../agents/pi.mjs';
import { tasteLearningAllowed } from '../byok-taste.mjs';
import { HAMA_CLAUDE_MODEL, parseHamaCap } from '../hama.mjs';
import { createHamaHarness, createStaticHamaSource } from '../hama-hosted.mjs';
import { normalizeProviderFailureEvent } from '../provider-failure.mjs';

const SITE = 'https://site.example.test';
const LEASE = [
  Buffer.from(JSON.stringify({ v: 1, kid: 'test-1', keyId: 'lic-1', deviceId: 'dev-1', expiresAt: 9e12 })).toString('base64url'),
  randomBytes(64).toString('base64url'),
].join('.');
const CHEAP = ['deepseek/deepseek-v4.1-flash'];
const RESETS_AT = '2026-10-30T15:00:00.000Z';

function serverStatus(overrides = {}) {
  return {
    ok: true,
    plan: { status: 'active', allowanceUsd: 15, periodStart: '2026-10-01T00:00:00.000Z', periodEnd: '2026-11-01T00:00:00.000Z' },
    caps: {
      cap_5h: { usedUsd: 0.4, limitUsd: 3, resetsAt: null },
      cap_week: { usedUsd: 1.2, limitUsd: 7.5, resetsAt: null },
      cap_month: { usedUsd: 2, limitUsd: 15, resetsAt: '2026-11-01T00:00:00.000Z' },
    },
    blocked: null,
    models: { default: HAMA_CLAUDE_MODEL, claude: [HAMA_CLAUDE_MODEL], cheap: CHEAP, maxOutputTokens: 16000 },
    endpoints: { anthropic: '/v1/hama/anthropic', openai: '/v1/hama/openrouter' },
    ...overrides,
  };
}

const active = (status = serverStatus()) => ({ availability: 'active', lease: LEASE, apiBase: SITE, status });

async function setUp(t, answer = active()) {
  const piRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-hama-'));
  t.after(() => fs.rm(piRoot, { recursive: true, force: true, maxRetries: 3 }));
  const source = createStaticHamaSource(answer);
  const harness = createHamaHarness({ piRoot, source, isPiInstalled: () => true, platform: 'darwin' });
  return { harness, source, piRoot };
}

test('the Hama home routes Haiku through Anthropic Messages and cheap models through chat completions, with no key and no Sonnet or Opus', async (t) => {
  // 서버가 다른 Claude 를 실어 보내도 Haiku 하나만 쓴다.
  const { harness, piRoot } = await setUp(t, active(serverStatus({
    models: {
      default: 'anthropic/claude-sonnet-5.5',
      claude: [HAMA_CLAUDE_MODEL, 'anthropic/claude-sonnet-5.5', 'anthropic/claude-opus-5.5'],
      cheap: [...CHEAP, 'anthropic/claude-opus-5.5'],
      maxOutputTokens: 16000,
    },
  })));
  const snapshot = await harness.refresh();
  const text = await fs.readFile(path.join(piRoot, 'agent-hama', 'models.json'), 'utf8');
  const provider = JSON.parse(text).providers.openrouter;
  assert.equal(provider.baseUrl, `${SITE}/v1/hama/openrouter`);
  assert.equal(provider.api, 'openai-completions');
  assert.equal('apiKey' in provider, false);
  assert.equal(text.includes(LEASE), false);
  assert.doesNotMatch(text, /sonnet|opus/i);
  assert.deepEqual(provider.models.map((model) => model.id), [HAMA_CLAUDE_MODEL, ...CHEAP]);
  const [haiku, deepseek] = provider.models;
  assert.equal(haiku.api, 'anthropic-messages');
  assert.equal(haiku.baseUrl, `${SITE}/v1/hama/anthropic`);
  assert.equal(deepseek.api, undefined);
  assert.equal(deepseek.reasoning, true);
  assert.deepEqual(snapshot.models[0].efforts, ['low', 'medium', 'high', 'xhigh']);
  assert.deepEqual(snapshot.models[1].efforts, ['low', 'high', 'max']);
  assert.equal(haiku.compat.forceAdaptiveThinking, true);
  assert.equal(haiku.thinkingLevelMap.xhigh, 'xhigh');
  assert.ok(provider.models.every((model) => model.maxTokens === 16000));

  assert.equal(snapshot.availability, 'active');
  assert.equal(snapshot.defaultModelId, HAMA_CLAUDE_MODEL);
  assert.deepEqual(snapshot.cheapModelIds, CHEAP);
  assert.equal(snapshot.plan.periodEnd, Date.parse('2026-11-01T00:00:00.000Z'));
  assert.equal(snapshot.caps.cap_5h.limitUsd, 3);
  assert.equal(snapshot.ready, true);
});

test('a license the server has not enrolled (Pro included) or an unreachable server never runs Hama', async (t) => {
  const { harness, source } = await setUp(t, { availability: 'not_enrolled', reason: 'hama_not_enrolled' });
  const notEnrolled = await harness.refresh();
  assert.deepEqual(
    [notEnrolled.availability, notEnrolled.plan, notEnrolled.models.length, notEnrolled.ready],
    ['not_enrolled', null, 0, false],
  );
  const access = harness.resolveSpawn(HAMA_CLAUDE_MODEL);
  assert.deepEqual([access.mode, access.key, access.reason], ['none', null, 'hama-unavailable']);

  source.set(active());
  assert.equal((await harness.refresh()).availability, 'active');
  source.set({ availability: 'unavailable', reason: 'not_configured' });
  assert.equal((await harness.refresh()).availability, 'unavailable');
  assert.equal(harness.active(), false);
});

test('a Hama turn without an active plan stops before spawning and never falls back to a user key', async (t) => {
  const { harness } = await setUp(t, { availability: 'not_enrolled', reason: 'hama_not_enrolled' });
  await harness.refresh();
  const { session, events, spawns } = hamaSession(harness, { openRouterApiKey: ['test', 'own', 'key'].join('-') });
  session.sendUserMessage('hi');
  await settle();
  assert.equal(spawns.length, 0);
  const failed = events.find((event) => event.type === 'error');
  assert.equal(failed.agent, 'hama');
  assert.equal(failed.message, HAMA_UNAVAILABLE_MESSAGE);
  assert.equal(normalizeProviderFailureEvent(failed, { agent: 'hama' }).failure.class, 'auth_required');
  await session.dispose();
});

test('a cap-tagged 429 becomes a typed usage-limit failure, marks the plan blocked, and the cheap model still spawns', async (t) => {
  const { harness, source, piRoot } = await setUp(t);
  await harness.refresh();
  const caps = [];
  const { session, events, spawns } = hamaSession(harness, {
    onHamaCap: (info) => { caps.push(info); void harness.noteCap(info); },
  });
  session.sendUserMessage('hi');
  const { proc, options, argv } = spawns[0];
  assert.equal(options.env.OPENROUTER_API_KEY, LEASE);
  assert.equal(options.env.PI_CODING_AGENT_DIR, path.join(piRoot, 'agent-hama'));
  assert.equal(options.env.RHWP_AGENT_NAME, 'hama');
  assert.ok(argv.includes(`openrouter/${HAMA_CLAUDE_MODEL}`));

  // 서버도 막힌 상태를 알린다.
  source.set(active(serverStatus({ blocked: { cap: 'cap_5h', resetsAt: RESETS_AT, cheapAvailable: true } })));
  const tag = `[hama-cap:cap_5h:${RESETS_AT}]`;
  proc.emitJson(
    {
      type: 'message_end',
      message: {
        role: 'assistant', content: [], stopReason: 'error',
        errorMessage: `429 {"type":"error","error":{"type":"cap_5h","message":"Hama quota exceeded (cap_5h) until ${RESETS_AT}. ${tag}"}}`,
      },
    },
    { type: 'agent_settled' },
  );
  proc.exit(0);
  const failed = events.find((event) => event.type === 'error');
  assert.equal(failed.agent, 'hama');
  assert.equal(failed.failure.code, 'hama_cap_5h');
  assert.match(failed.message, new RegExp(`^${HAMA_CAP_MESSAGES.cap_5h}`));
  assert.deepEqual(caps, [{ cap: 'cap_5h', resetsAt: Date.parse(RESETS_AT) }]);

  // 허브가 Studio 로 보내는 모양: 사용 한도 + 리셋 시각.
  const { failure } = normalizeProviderFailureEvent(failed, { agent: 'hama' });
  assert.deepEqual([failure.class, failure.code, failure.resetAt], ['usage_limit', 'hama_cap_5h', Date.parse(RESETS_AT)]);

  await settle();
  const blocked = harness.snapshot();
  assert.deepEqual(blocked.blocked, { cap: 'cap_5h', resetsAt: Date.parse(RESETS_AT), cheapAvailable: true });
  assert.equal(harness.resolveSpawn(HAMA_CLAUDE_MODEL).cheapModel, CHEAP[0]);
  await session.dispose();

  // 싼 모델로 바꾼 채팅은 같은 lease 와 홈으로 그 모델을 띄운다.
  const cheap = hamaSession(harness, { model: CHEAP[0] });
  cheap.session.sendUserMessage('again');
  assert.ok(cheap.spawns[0].argv.includes(`openrouter/${CHEAP[0]}`));
  assert.equal(cheap.spawns[0].options.env.OPENROUTER_API_KEY, LEASE);
  await cheap.session.dispose();
});

test('the cap tag parser reads every cap and ignores look-alikes', () => {
  assert.deepEqual(parseHamaCap(`x [hama-cap:cap_week:${RESETS_AT}] y`), { cap: 'cap_week', resetsAt: Date.parse(RESETS_AT) });
  assert.equal(parseHamaCap('[hama-cap:cap_month:2026-11-01T00:00:00Z]').cap, 'cap_month');
  assert.equal(parseHamaCap('Hama quota exceeded (cap_5h)'), null);
  assert.equal(parseHamaCap('[hama-cap:cap_day:2026-11-01T00:00:00Z]'), null);
});

test('Rau-0.1 taste learning skips BYOK chats only', () => {
  assert.equal(tasteLearningAllowed('pi'), false);
  for (const agent of ['claude', 'codex', 'hama']) assert.equal(tasteLearningAllowed(agent), true);
});

function hamaSession(harness, extra = {}) {
  const events = [];
  const spawns = [];
  const session = createHamaSession({
    rootDir: '/tmp/rhwp',
    hubPort: 6201,
    token: 'hub-token',
    sessionId: 'hama-chat',
    piBin: '/pi/bin/pi',
    piRoot: path.dirname(harness.agentDir),
    permissionProfile: 'safe',
    onEvent: (event) => events.push(event),
    resolvePiAccess: (model) => harness.resolveSpawn(model),
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
