import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
registerHooks({
  load(url, context, next) {
    return url.endsWith('.css')
      ? { format: 'module', source: 'export default {};', shortCircuit: true }
      : next(url, context);
  },
});
const { AgentBridgeImpl } = await import('../src/agent/bridge.ts');
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
function fixture() {
  let connections = 0;
  const events: any[] = [];
  const bridge = Object.assign(Object.create(AgentBridgeImpl.prototype), {
    disposed: false,
    state: 'disconnected',
    reconnectTimer: null,
    reconnectAttempt: 1,
    reconnectSeq: 0,
    threadId: 'thread-1',
    documentId: 'document-1',
    requestHubLaunch: async () => true,
    refreshSessionContext: async () => true,
    connect: () => {
      connections++;
    },
    emit: (event: any) => events.push(event),
  });
  return { bridge, events, connections: () => connections };
}

test('retries back off, do not duplicate timers, and retain document/thread identity', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  let previousDelay = 0;
  for (let attempt = 1; attempt <= 7; attempt++) {
    f.bridge.reconnectAttempt = attempt;
    f.bridge.scheduleReconnect();
    const delay = f.events.at(-1).retryInMs;
    assert(
      delay > 0 && delay >= previousDelay,
      'retry delays must be positive and non-decreasing',
    );
    previousDelay = delay;
    f.bridge.scheduleReconnect(); // repeated failure signals must not add a second timer
    t.mock.timers.tick(delay - 1);
    await settle();
    assert.equal(f.connections(), attempt - 1);
    t.mock.timers.tick(1);
    await settle();
    assert.equal(f.connections(), attempt);
  }
  assert.equal(f.bridge.threadId, 'thread-1');
  assert.equal(f.bridge.documentId, 'document-1');
});

test('disposed or superseded reconnects cannot open a socket', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const stop of ['disposed', 'superseded', 'cancelled']) {
    const f = fixture();
    f.bridge.scheduleReconnect();
    if (stop === 'disposed') f.bridge.disposed = true;
    if (stop === 'superseded') f.bridge.reconnectSeq++;
    if (stop === 'cancelled') f.bridge.clearReconnectTimer();
    t.mock.timers.runAll();
    await settle();
    assert.equal(f.connections(), 0, stop);
  }
});

test('manual reconnect awaits hub readiness and ignores a superseding request', async () => {
  const f = fixture();
  let release!: () => void;
  f.bridge.requestHubLaunch = () =>
    new Promise<void>((resolve) => {
      release = resolve;
    });
  f.bridge.abortSocket = () => {};
  f.bridge.forceReconnect = () => f.bridge.connect();
  const pending = f.bridge.reconnectNow();
  assert.equal(f.connections(), 0);
  f.bridge.reconnectSeq++;
  release();
  await pending;
  assert.equal(f.connections(), 0);
  f.bridge.requestHubLaunch = async () => true;
  await f.bridge.reconnectNow();
  assert.equal(f.connections(), 1);
});

test('a reconnect superseded during session lookup cannot apply stale credentials or open a socket', async () => {
  for (const entry of ['initializeConnection', 'connectAfterHub', 'reconnectNow']) {
    const f = fixture();
    delete f.bridge.refreshSessionContext;
    const applied: unknown[] = [];
    let release!: (value: unknown) => void;
    f.bridge.loadSessionContext = () => new Promise((resolve) => { release = resolve; });
    f.bridge.applySessionContext = (value: unknown) => applied.push(value);
    f.bridge.abortSocket = () => {};
    f.bridge.forceReconnect = () => f.bridge.connect();
    const pending = f.bridge[entry](f.bridge.reconnectSeq);
    await settle();
    f.bridge.reconnectSeq++;
    release({ sessionId: 'superseded-session', hubToken: 'superseded-capability' });
    await pending;
    assert.equal(applied.length, 0, `${entry} must discard a superseded session lookup`);
    assert.equal(f.connections(), 0, `${entry} must leave the newer connection alone`);
  }
});

test('overlapping initializers replace a pending retry and keep the latest session lookup', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  delete f.bridge.refreshSessionContext;
  const lookups: Array<(value: unknown) => void> = [];
  const applied: unknown[] = [];
  f.bridge.loadSessionContext = () => new Promise((resolve) => lookups.push(resolve));
  f.bridge.applySessionContext = (value: unknown) => applied.push(value);
  f.bridge.scheduleReconnect();
  const earlier = f.bridge.initializeConnection();
  await settle();
  const latest = f.bridge.initializeConnection();
  await settle();
  lookups[1]({ sessionId: 'latest-session' });
  await latest;
  lookups[0]({ sessionId: 'old-session' });
  await earlier;
  assert.deepEqual(applied, [{ sessionId: 'latest-session' }]);
  assert.equal(f.connections(), 1);
  t.mock.timers.runAll();
  await settle();
  assert.equal(f.connections(), 1, 'the superseded retry timer must not reopen the connection');
});
