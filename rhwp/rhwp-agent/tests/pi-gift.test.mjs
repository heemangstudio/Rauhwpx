import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createPiSession,
  GIFT_EXHAUSTED_NO_KEY_MESSAGE,
  GIFT_EXHAUSTED_OWN_KEY_MESSAGE,
  GIFT_RETRY_MESSAGE,
} from '../agents/pi.mjs';
import { createStaticGiftSource } from '../gift-source.mjs';
import { createPiManager, GIFT_MAX_OUTPUT_TOKENS, pickDefaultGiftModels } from '../pi-manager.mjs';
import { createMemorySecretStore } from '../secret-store.mjs';

const OPENROUTER = 'https://openrouter.ai/api/v1';
const GIFT_BASE = 'https://gift.example.test/v1/gift/openrouter';
const OWN_KEY = 'sk-or-v1-own-0123456789abcdef';
const LEASE = [
  Buffer.from(JSON.stringify({ v: 1, kid: 'test-1', keyId: 'lic-1', deviceId: 'dev-1', expiresAt: 9e12 })).toString('base64url'),
  randomBytes(64).toString('base64url'),
].join('.');

function rawModel(id, { completion = '0.000015', maxCompletion = 64000, reasoning = true } = {}) {
  return {
    id,
    name: id,
    context_length: 200000,
    top_provider: { context_length: 200000, max_completion_tokens: maxCompletion },
    pricing: { prompt: '0.000003', completion },
    supported_parameters: reasoning ? ['tools', 'reasoning'] : ['tools'],
    architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
  };
}

const GIFT_CATALOG = [
  rawModel('anthropic/claude-sonnet-4'),
  rawModel('anthropic/claude-sonnet-4.5'),
  rawModel('anthropic/claude-3.7-sonnet:thinking'),
  rawModel('anthropic/claude-haiku-4.5', { completion: '0.000005', reasoning: false }),
  rawModel('anthropic/claude-opus-4.1', { completion: '0.000075', maxCompletion: 128000 }),
];
const OWN_CATALOG = [
  rawModel('deepseek/deepseek-chat-v3.1', { completion: '0.0000008' }),
  ...GIFT_CATALOG,
];

/**
 * openrouter.ai 와 선물 프록시를 흉내 낸다. 요청마다 주소와 Authorization 을 남긴다.
 * giftCredits 가 0 이면 선물 프록시의 채팅이 402 로 끝난다.
 */
function fakeNetwork() {
  const calls = [];
  const state = { giftCredits: 1 };
  const json = (status, body) => new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json' },
  });
  async function fetchImpl(url, init = {}) {
    const auth = init.headers?.Authorization ?? null;
    calls.push({ url: String(url), auth });
    const href = String(url);
    if (href.startsWith(GIFT_BASE)) {
      if (auth !== `Bearer ${LEASE}`) return json(401, { error: { code: 401, message: 'unauthorized' } });
      const route = href.slice(GIFT_BASE.length);
      if (route === '/models') return json(200, { data: GIFT_CATALOG });
      if (route === '/auth/key') {
        return json(200, { data: { label: 'gift', limit: 20, usage: 19, limit_remaining: 1, is_free_tier: false } });
      }
      if (route === '/chat/completions') {
        if (state.giftCredits <= 0) {
          return json(402, { error: { code: 402, message: 'Insufficient credits. This gift has no remaining balance.' } });
        }
        const body = JSON.parse(init.body);
        return json(200, { choices: [{ message: { content: `gift:${body.model}` } }] });
      }
      return json(404, {});
    }
    if (href.startsWith(OPENROUTER)) {
      if (auth && auth !== `Bearer ${OWN_KEY}`) return json(401, { error: { message: 'bad key' } });
      const route = href.slice(OPENROUTER.length);
      if (route === '/models') return json(200, { data: OWN_CATALOG });
      if (route === '/key') return json(200, { data: { label: 'own', limit: null, usage: 2 } });
      if (route === '/credits') return json(200, { data: { total_credits: 10, total_usage: 2 } });
      if (route === '/chat/completions') {
        const body = JSON.parse(init.body);
        return json(200, { choices: [{ message: { content: `own:${body.model}` } }] });
      }
    }
    return json(404, {});
  }
  return { calls, state, fetchImpl };
}

function giftCredentials(overrides = {}) {
  return {
    available: true,
    active: true,
    lease: LEASE,
    baseUrl: GIFT_BASE,
    eventId: 'special-2026-10',
    amountUsd: 20,
    remainingUsd: 18.4,
    claimed: true,
    ...overrides,
  };
}

const INACTIVE = giftCredentials({ active: false, lease: null, claimed: false, remainingUsd: null });


/** 내 키와 내 모델(DeepSeek)이 설정된 Pi. 선물 자격은 처음엔 꺼져 있다. */
async function setUpManager(t, { ownKey = true, platform = 'darwin', initial = INACTIVE } = {}) {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-pi-gift-'));
  const network = fakeNetwork();
  const source = createStaticGiftSource(initial);
  const manager = createPiManager({
    rootDir,
    platform,
    baseEnv: {},
    fetchImpl: network.fetchImpl,
    giftSource: source,
    secretStore: createMemorySecretStore(ownKey ? { 'rhwp.pi.openrouter-api-key': OWN_KEY } : {}),
  });
  await manager.init();
  if (ownKey) await manager.setModels([{ id: 'deepseek/deepseek-chat-v3.1' }]);
  t.after(async () => {
    await manager.close();
    await fs.rm(rootDir, { recursive: true, force: true, maxRetries: 3 });
  });
  return { manager, source, network, rootDir };
}

async function activateGift(source, manager, overrides) {
  source.set(giftCredentials(overrides));
  return manager.refreshGift();
}

test('default gift picks are the newest Sonnet, Haiku and Opus with Sonnet first', () => {
  const picks = pickDefaultGiftModels([
    { id: 'anthropic/claude-3.5-haiku' },
    { id: 'anthropic/claude-opus-4' },
    { id: 'anthropic/claude-sonnet-4' },
    { id: 'anthropic/claude-sonnet-4.5' },
    { id: 'anthropic/claude-sonnet-4.6:thinking' },
    { id: 'anthropic/claude-haiku-4.5' },
    { id: 'anthropic/claude-opus-4.1' },
    { id: 'openai/gpt-5-sonnet' },
  ]).map((entry) => entry.id);
  assert.deepEqual(picks, ['anthropic/claude-sonnet-4.5', 'anthropic/claude-haiku-4.5', 'anthropic/claude-opus-4.1']);
});

test('Pi uses the gift first, then the own key, then nothing', async (t) => {
  const { manager, source } = await setUpManager(t);
  assert.equal(manager.access().mode, 'own');
  assert.equal((await manager.status()).credential, 'own');

  const status = await activateGift(source, manager);
  assert.equal(status.credential, 'gift');
  assert.equal(status.setupComplete, true);
  assert.deepEqual(status.models.map((model) => model.id), [
    'anthropic/claude-sonnet-4.5', 'anthropic/claude-haiku-4.5', 'anthropic/claude-opus-4.1',
  ]);
  assert.equal(status.defaultModelId, 'anthropic/claude-sonnet-4.5');
  // 내 키 표시는 그대로다.
  assert.equal(status.keyConfigured, true);
  assert.equal(status.keyTail, OWN_KEY.slice(-4));
  assert.equal(manager.apiKey(), LEASE);
  assert.equal(manager.ownApiKey(), OWN_KEY);

  const spawn = manager.resolveSpawn('deepseek/deepseek-chat-v3.1');
  assert.equal(spawn.mode, 'gift');
  assert.equal(spawn.key, LEASE);
  assert.equal(spawn.agentDir, manager.giftAgentDir);
  assert.equal(spawn.model, 'anthropic/claude-sonnet-4.5', 'an own-key model falls back to the gift default');
  assert.equal(spawn.reasoning, true);
  assert.equal(spawn.fallback, 'own');

  // 이벤트가 꺼지면 내 키로 돌아가고, 내 모델은 건드리지 않았다.
  source.set(INACTIVE);
  const own = await manager.refreshGift({ refresh: true });
  assert.equal(own.credential, 'own');
  assert.deepEqual(own.models.map((model) => model.id), ['deepseek/deepseek-chat-v3.1']);
  assert.equal(manager.resolveSpawn('anthropic/claude-sonnet-4.5').model, 'deepseek/deepseek-chat-v3.1');
  assert.equal(manager.resolveSpawn('x').key, OWN_KEY);
});

test('a gift-only Pi counts as set up and has nothing once the gift is off', async (t) => {
  const { manager, source } = await setUpManager(t, { ownKey: false });
  assert.equal((await manager.status()).setupComplete, false);
  assert.equal(manager.access().mode, 'none');
  const gift = await activateGift(source, manager);
  assert.equal(gift.setupComplete, true);
  assert.equal(gift.keyConfigured, false);
  assert.equal(manager.resolveSpawn(null).fallback, 'none');
});

test('a gift 402 is sticky for the event and falls back to the own key', async (t) => {
  const { manager, source, network, rootDir } = await setUpManager(t);
  await activateGift(source, manager);
  network.state.giftCredits = 0;

  await assert.rejects(
    manager.router.chat({ key: manager.apiKey(), model: 'anthropic/claude-haiku-4.5', messages: [] }),
    (error) => error.status === 402,
  );
  await manager.flush();
  // 데스크톱이 아직 활성이라고 답해도 이 이벤트의 선물은 다시 쓰지 않는다.
  await manager.refreshGift({ refresh: true });
  const spawn = manager.resolveSpawn('anthropic/claude-sonnet-4.5');
  assert.equal(spawn.mode, 'own');
  assert.equal(spawn.key, OWN_KEY);
  assert.equal(spawn.agentDir, manager.agentDir);
  assert.equal((await manager.status()).credential, 'own');

  // 다시 열어도 소진 표시가 남는다.
  const reopened = createPiManager({
    rootDir, platform: 'darwin', baseEnv: {}, fetchImpl: network.fetchImpl, giftSource: source,
    secretStore: createMemorySecretStore({ 'rhwp.pi.openrouter-api-key': OWN_KEY }),
  });
  t.after(() => reopened.close());
  await reopened.init();
  assert.equal((await reopened.refreshGift()).credential, 'own');

  // 잔액이 다 줄어든 뒤 서버가 한도를 늘려 주면 선물로 돌아간다.
  source.set(giftCredentials({ remainingUsd: 0.2 }));
  assert.equal((await reopened.refreshGift({ refresh: true })).credential, 'own');
  source.set(giftCredentials({ remainingUsd: 5 }));
  assert.equal((await reopened.refreshGift({ refresh: true })).credential, 'gift');
  await reopened.markGiftExhausted();

  // 새 이벤트는 새 선물이다.
  const next = await activateGift(source, reopened, { eventId: 'special-2027-01' });
  assert.equal(next.credential, 'gift');
});

test('a gift 402 without an own key leaves Pi with the reconnect message', async (t) => {
  const { manager, source } = await setUpManager(t, { ownKey: false });
  await activateGift(source, manager);
  const { session, events, spawns } = giftSession(manager, { model: 'anthropic/claude-sonnet-4.5' });

  session.sendUserMessage('hi');
  const { proc } = spawns[0];
  proc.emitJson(
    { type: 'message_end', message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: '402: {"code":402,"message":"Insufficient credits. This gift has no remaining balance."}' } },
    { type: 'agent_settled' },
  );
  proc.exit(0);
  const failed = events.find((event) => event.type === 'error');
  assert.equal(failed.failure.code, 'gift_credits');
  assert.match(failed.message, new RegExp(`^${GIFT_EXHAUSTED_NO_KEY_MESSAGE}`));
  assert.equal(manager.access().mode, 'none');
  assert.equal(manager.access().reason, 'gift-exhausted');

  // 다음 턴은 Pi 를 띄우지 않고 같은 문구로 설정을 권한다.
  await settle();
  session.sendUserMessage('again');
  await settle();
  assert.equal(spawns.length, 1);
  const blocked = events.filter((event) => event.type === 'error').at(-1);
  assert.equal(blocked.message, GIFT_EXHAUSTED_NO_KEY_MESSAGE);
  assert.equal(blocked.failure.code, 'gift_credits');
  await session.dispose();
});

test('a gift 402 with an own key says the next request uses that key', async (t) => {
  const { manager, source } = await setUpManager(t);
  await activateGift(source, manager);
  const { session, events, spawns } = giftSession(manager, { model: 'anthropic/claude-sonnet-4.5' });
  session.sendUserMessage('hi');
  spawns[0].proc.stderr.emit('data', 'Error: 402 Insufficient credits: the HamaEditor gift credit for this license is used up.\n');
  spawns[0].proc.exit(1);
  const failed = events.find((event) => event.type === 'error');
  assert.equal(failed.message, GIFT_EXHAUSTED_OWN_KEY_MESSAGE);
  await manager.flush();
  assert.equal(manager.access().mode, 'own');

  await settle();
  session.sendUserMessage('again');
  await settle();
  assert.equal(spawns.length, 2);
  const env = spawns[1].options.env;
  assert.equal(env.OPENROUTER_API_KEY, OWN_KEY);
  assert.equal(env.PI_CODING_AGENT_DIR, manager.agentDir);
  assert.ok(spawns[1].argv.includes('openrouter/deepseek/deepseek-chat-v3.1'));
  await session.dispose();
});

test('a passing 402 keeps the gift while the server still shows a balance', async (t) => {
  const { manager, source } = await setUpManager(t);
  await activateGift(source, manager);
  const { session, events, spawns } = giftSession(manager, { model: 'anthropic/claude-sonnet-4.5' });
  session.sendUserMessage('hi');
  spawns[0].proc.stderr.emit('data', 'Error: 402 Provider returned error\n');
  spawns[0].proc.exit(1);
  const transient = events.find((event) => event.type === 'error');
  assert.equal(transient.message, GIFT_RETRY_MESSAGE);
  assert.equal(transient.failure.code, 'gift_retry');
  await settle();
  await manager.flush();
  assert.equal(manager.access().mode, 'gift');

  // 같은 402 라도 서버 잔액이 거의 없으면 선물을 끝낸다.
  source.set(giftCredentials({ remainingUsd: 0.2 }));
  await manager.markGiftExhausted({ confirmed: false });
  await manager.flush();
  assert.equal(manager.access().mode, 'own');
  await session.dispose();
});

test('a gift spawn gets the lease and the gift home, never the own key', async (t) => {
  const { manager, source } = await setUpManager(t);
  await activateGift(source, manager);
  // 세션을 열 때의 키가 남아 있어도 스폰마다 받은 자격이 이긴다.
  const { session, spawns } = giftSession(manager, {
    model: 'deepseek/deepseek-chat-v3.1', openRouterApiKey: OWN_KEY,
  });
  session.sendUserMessage('hi');
  const { options, argv } = spawns[0];
  assert.equal(options.env.OPENROUTER_API_KEY, LEASE);
  assert.equal(options.env.PI_CODING_AGENT_DIR, path.join(manager.rootDir, 'agent-gift'));
  assert.equal(JSON.stringify(options.env).includes(OWN_KEY), false);
  assert.ok(argv.includes('openrouter/anthropic/claude-sonnet-4.5'));
  await session.dispose();
});

test('the gift home points at the gift proxy without any key, and the own home never does', async (t) => {
  const { manager, source, rootDir } = await setUpManager(t);
  await activateGift(source, manager);
  const giftText = await fs.readFile(path.join(rootDir, 'agent-gift', 'models.json'), 'utf8');
  const gift = JSON.parse(giftText).providers.openrouter;
  assert.equal(gift.baseUrl, GIFT_BASE);
  assert.equal(gift.api, 'openai-completions');
  assert.equal('apiKey' in gift, false);
  assert.equal(giftText.includes(OWN_KEY), false);
  assert.equal(giftText.includes(LEASE), false);
  assert.ok(gift.models.every((model) => model.id.startsWith('anthropic/')));
  assert.ok(gift.models.every((model) => model.maxTokens <= GIFT_MAX_OUTPUT_TOKENS));
  await fs.access(path.join(rootDir, 'agent-gift', 'settings.json'));

  // 선물 모드에서 모델을 바꿔도 선물 홈만 바뀐다.
  await manager.setModels([{ id: 'anthropic/claude-opus-4.1' }]);
  const ownText = await fs.readFile(path.join(rootDir, 'agent', 'models.json'), 'utf8');
  const own = JSON.parse(ownText).providers.openrouter;
  assert.equal(own.baseUrl, OPENROUTER);
  assert.equal(ownText.includes('gift.example.test'), false);
  assert.equal(ownText.includes(LEASE), false);
  assert.deepEqual(own.models.map((model) => model.id), ['deepseek/deepseek-chat-v3.1']);
  const giftAfter = JSON.parse(await fs.readFile(path.join(rootDir, 'agent-gift', 'models.json'), 'utf8'));
  assert.deepEqual(giftAfter.providers.openrouter.models.map((model) => model.id), ['anthropic/claude-opus-4.1']);
  assert.equal(giftAfter.providers.openrouter.models[0].maxTokens, GIFT_MAX_OUTPUT_TOKENS);
  // 선물 카탈로그에 없는 모델은 고를 수 없다.
  await assert.rejects(manager.setModels([{ id: 'deepseek/deepseek-chat-v3.1' }]), { code: 'PI_MODEL_UNKNOWN' });
});

test('the router sends the lease only to the gift proxy and the own key only to OpenRouter', async (t) => {
  const { manager, source, network } = await setUpManager(t);
  await activateGift(source, manager);
  network.calls.length = 0;

  // 선물에 없는 모델(DeepSeek)은 가장 싼 선물 모델로 바뀐다.
  assert.equal(
    await manager.router.chat({ key: LEASE, model: 'deepseek/deepseek-chat-v3.1', messages: [] }),
    'gift:anthropic/claude-haiku-4.5',
  );
  assert.equal(
    await manager.router.chat({ key: OWN_KEY, model: 'deepseek/deepseek-chat-v3.1', messages: [] }),
    'own:deepseek/deepseek-chat-v3.1',
  );
  const giftCatalog = await manager.router.catalog(true, LEASE);
  assert.ok(giftCatalog.length > 0 && giftCatalog.every((model) => model.id.startsWith('anthropic/')));
  await manager.router.catalog(true, OWN_KEY);
  assert.equal((await manager.router.credits(LEASE, true)).balanceUsd, 1);
  await manager.router.credits(OWN_KEY, true);
  // 사용량 카드는 내 키의 잔액이다.
  assert.equal((await manager.credits(true)).balanceUsd, 8);

  assert.ok(network.calls.length >= 6);
  for (const call of network.calls) {
    if (call.auth === `Bearer ${LEASE}`) assert.ok(call.url.startsWith(GIFT_BASE), call.url);
    if (call.auth === `Bearer ${OWN_KEY}`) assert.ok(call.url.startsWith(OPENROUTER), call.url);
    if (call.url.startsWith(GIFT_BASE)) assert.equal(call.auth, `Bearer ${LEASE}`);
  }
});

test('gift credits never apply outside macOS', async (t) => {
  for (const platform of ['win32', 'linux']) {
    const { manager, source, network } = await setUpManager(t, { platform, initial: giftCredentials() });
    const status = await manager.refreshGift({ refresh: true });
    assert.equal(status.credential, 'own');
    assert.equal(manager.resolveSpawn(null).key, OWN_KEY);
    assert.equal(source.calls.length, 0, 'the desktop is never asked');
    assert.equal(network.calls.some((call) => call.url.startsWith(GIFT_BASE)), false);
  }
});

test('an untrusted gift base URL never receives the lease', async (t) => {
  const { manager, source, network } = await setUpManager(t);
  for (const baseUrl of ['https://openrouter.ai/api/v1', 'http://gift.example.test/v1/gift/openrouter']) {
    network.calls.length = 0;
    const status = await activateGift(source, manager, { baseUrl });
    assert.equal(status.credential, 'own');
    assert.equal(network.calls.some((call) => call.auth === `Bearer ${LEASE}`), false);
  }
});

/** 서버가 채팅 세션에 붙이는 것과 같은 훅으로 Pi 세션을 연다. */
function giftSession(manager, extra = {}) {
  const events = [];
  const spawns = [];
  const session = createPiSession({
    rootDir: '/tmp/rhwp',
    hubPort: 6201,
    token: 'secret-token',
    sessionId: 'gift-chat',
    piBin: '/pi/bin/pi',
    piRoot: manager.rootDir,
    permissionProfile: 'safe',
    onEvent: (event) => events.push(event),
    resolvePiAccess: (model) => manager.resolveSpawn(model),
    onCreditExhausted: (info) => { void manager.markGiftExhausted(info); },
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
  for (let index = 0; index < 5; index += 1) await new Promise((resolve) => setImmediate(resolve));
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
