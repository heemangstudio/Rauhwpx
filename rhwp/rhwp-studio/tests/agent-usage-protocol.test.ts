import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { PendingRequestRegistry } from '../src/agent/pending-requests.ts';

// bridge.ts 는 오버레이 css 를 함께 들여온다 — node 테스트에서는 빈 모듈로 대체한다.
registerHooks({
  load(url, context, nextLoad) {
    if (/\.css$/.test(url)) return { format: 'module', source: 'export default {};', shortCircuit: true };
    return nextLoad(url, context);
  },
});

const { AgentBridgeImpl } = await import('../src/agent/bridge.ts');

// ─── 요청/응답 짝 맞추기 (실제 모듈) ────────────────────────

test('허브 응답이 오면 그 값으로 안착한다', async () => {
  const registry = new PendingRequestRegistry();
  const pending = registry.create<{ ok: boolean }>('usage-1', 10_000);
  assert.equal(registry.size, 1);
  assert.equal(registry.settle('usage-1', { ok: true }), true);
  assert.deepEqual(await pending, { ok: true });
  assert.equal(registry.size, 0);
});

test('응답이 없으면 타임아웃에 null 로 안착한다 (던지지 않는다)', async () => {
  const registry = new PendingRequestRegistry();
  assert.equal(await registry.create('usage-2', 10), null);
  assert.equal(registry.size, 0);
});

test('모르는 requestId 는 무시된다 (늦게 온 응답이 다른 대기를 깨우지 않는다)', async () => {
  const registry = new PendingRequestRegistry();
  const pending = registry.create<string>('usage-3', 10_000);
  assert.equal(registry.settle('usage-999', 'stray'), false);
  registry.settle('usage-3', 'mine');
  assert.equal(await pending, 'mine');
});

test('usage-error 처럼 값 없이 닫으면 null 이 온다', async () => {
  const registry = new PendingRequestRegistry();
  const pending = registry.create<string>('usage-4', 10_000);
  registry.settle('usage-4', null);
  assert.equal(await pending, null);
});

test('연결이 끊기면 대기 중인 모든 요청이 null 로 닫힌다', async () => {
  const registry = new PendingRequestRegistry();
  const a = registry.create('usage-5', 10_000);
  const b = registry.create('provider-status-1', 10_000);
  registry.cancelAll();
  assert.deepEqual(await Promise.all([a, b]), [null, null]);
  assert.equal(registry.size, 0);
});

// ─── 브리지 배선 (실제 브리지) ──────────────────────────────

function bridgeFixture(state: 'connected' | 'disconnected', send = true) {
  const bridge = Object.create(AgentBridgeImpl.prototype) as any;
  const frames: any[] = [];
  const events: any[] = [];
  Object.assign(bridge, {
    state,
    requests: new PendingRequestRegistry(),
    requestSeq: 0,
    listeners: new Set([(e: unknown) => { events.push(e); }]),
    sendJson: (frame: unknown) => { if (send) frames.push(frame); return send; },
  });
  return { bridge, frames, events };
}

test('오프라인이거나 전송에 실패하면 사용량 요청은 곧바로 null 로 안착한다', async () => {
  const offline = bridgeFixture('disconnected');
  assert.equal(await offline.bridge.requestUsage(), null);
  assert.equal(offline.frames.length, 0);
  const unsent = bridgeFixture('connected', false);
  assert.equal(await unsent.bridge.requestProviderStatus(), null);
  assert.equal(unsent.bridge.requests.size, 0);
});

test('usage-report 는 대기 중인 요청을 풀고 사이드바 이벤트를 낸다', async () => {
  const { bridge, frames, events } = bridgeFixture('connected');
  const pending = bridge.requestUsage(true);
  assert.equal(frames[0].type, 'usage-request');
  assert.equal(frames[0].refresh, true);
  bridge.handleMessage({ type: 'usage-report', requestId: frames[0].requestId, usage: { providers: {} } });
  const usage = await pending;
  assert.ok(usage);
  assert.deepEqual(Object.keys(usage.providers).sort(), ['claude', 'codex', 'pi']);
  assert.equal(usage.providers.claude.session.turns, 0);
  assert.equal(events.at(-1).type, 'usage-report');
});

test('usage-error 는 던지지 않고 대기 중인 요청을 null 로 닫는다', async () => {
  const { bridge, frames } = bridgeFixture('connected');
  const pending = bridge.requestUsage();
  bridge.handleMessage({ type: 'usage-error', requestId: frames[0].requestId, message: 'boom' });
  assert.equal(await pending, null);
});

test('모델별 사용량은 항목 수·이름 길이를 제한하고 프로토타입 키를 남기지 않는다', async () => {
  const { bridge, frames } = bridgeFixture('connected');
  const pending = bridge.requestUsage();
  const byModel: Record<string, unknown> = JSON.parse('{"__proto__": {"turns": 1}}');
  byModel['x'.repeat(300)] = { turns: 1 };
  for (let i = 0; i < 700; i += 1) byModel[`model-${i}`] = { turns: i, costUsd: 0.5 };
  bridge.handleMessage({
    type: 'usage-report',
    requestId: frames[0].requestId,
    usage: { providers: { claude: { byModel } } },
  });
  const usage = await pending;
  const models = usage.providers.claude.byModel;
  assert.equal(Object.getPrototypeOf(models), null);
  assert.ok(Object.keys(models).length <= 512);
  assert.ok(Object.keys(models).every((name) => name.length <= 256));
  assert.equal(models['model-0'].costUsd, 0.5);
  assert.equal(({} as any).turns, undefined);
});
