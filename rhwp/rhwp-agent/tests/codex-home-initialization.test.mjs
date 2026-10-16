import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { acquireCodexHomeInitialization } from '../codex-home-initialization.mjs';
import { discoverCodexModels } from '../codex-model-routing.mjs';
import { createCodexAppServerSession } from '../agents/codex-app-server.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate) {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await tick(); }
  assert.fail('Expected fake Codex state was not reached');
}
function home(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rhwp-codex-init-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
class FakeStream extends EventEmitter {
  constructor(onWrite) { super(); this.onWrite = onWrite; }
  write(chunk, callback) { this.onWrite?.(String(chunk)); callback?.(); return true; }
  end() {}
}
class FakeChild extends EventEmitter {
  constructor(responder) {
    super(); this.exitCode = null; this.signalCode = null; this.frames = [];
    this.stdout = new FakeStream(); this.stderr = new FakeStream();
    this.stdin = new FakeStream(text => {
      for (const line of text.split('\n').filter(Boolean)) {
        const frame = JSON.parse(line); this.frames.push(frame);
        queueMicrotask(() => responder(frame, result => this.send({ id: frame.id, result }), this));
      }
    });
  }
  send(frame) { this.stdout.emit('data', JSON.stringify(frame) + '\n'); }
  kill(signal = 'SIGTERM') {
    if (this.signalCode !== null) return true;
    this.signalCode = signal;
    queueMicrotask(() => { this.emit('exit', null, signal); this.emit('close', null, signal); });
    return true;
  }
}
function chat(t, codexHome) {
  const children = [], events = [];
  const opts = { rootDir: path.dirname(codexHome), codexHome, mcpScriptPath: '/fake/mcp.mjs', hubPort: 1, token: 'fake',
    model: 'fake-model', permissionProfile: 'safe', workflow: 'direct', phase: 'implementing', agentRole: 'chat',
    onEvent: event => events.push(event), requestUserInput: async () => ({ status: 'cancelled' }) };
  const session = createCodexAppServerSession(opts, {
    spawnProcess() {
      const child = new FakeChild((frame, reply, proc) => {
        if (frame.method === 'initialize') reply({ userAgent: 'fake' });
        if (frame.method === 'experimentalFeature/list') reply({ data: [{ name: 'default_mode_request_user_input', enabled: true, stage: 'underDevelopment' }], nextCursor: null });
        if (frame.method === 'thread/start') reply({ thread: { id: 'thread-init-test' } });
        if (frame.method === 'turn/start') {
          proc.send({ method: 'turn/started', params: { threadId: 'thread-init-test', turn: { id: 'turn-init-test', status: 'inProgress' } } });
          reply({ turn: { id: 'turn-init-test', status: 'inProgress' } });
        }
        if (frame.method === 'turn/interrupt') reply({});
      });
      children.push(child); return child;
    },
    terminateProcess: child => child.kill(),
  });
  t.after(() => session.dispose());
  return { session, children, events };
}

test('resolved same-home initializes queue while distinct homes acquire independently', async t => {
  const root = home(t);
  const release = await acquireCodexHomeInitialization(path.join(root, 'a'));
  let second = false;
  const next = acquireCodexHomeInitialization(path.join(root, 'a', '..', 'a')).then(unlock => { second = true; return unlock; });
  const other = await acquireCodexHomeInitialization(path.join(root, 'b'));
  await tick(); assert.equal(second, false);
  other(); release();
  const unlock = await next; assert.equal(second, true); unlock();
});

test('cancelled waiters leave no poisoned queue or extra acquisition', async t => {
  const root = home(t), controller = new AbortController();
  const release = await acquireCodexHomeInitialization(root);
  const cancelled = acquireCodexHomeInitialization(root, { signal: controller.signal });
  controller.abort(new Error('cancel fixture'));
  await assert.rejects(cancelled, /cancel fixture/);
  let acquired = false;
  const following = acquireCodexHomeInitialization(root).then(unlock => { acquired = true; return unlock; });
  await tick(); assert.equal(acquired, false);
  release(); (await following)();
});

test('catalog and chat serialize spawn until initialize ACK, not until model/list or a turn completes', async t => {
  const root = home(t), codexHome = path.join(root, '.codex');
  let initialize, models, catalogChild;
  const catalog = discoverCodexModels({ codexHome, env: { PATH: '/bin' }, spawnProcess() {
    catalogChild = new FakeChild((frame, reply) => {
      if (frame.method === 'initialize') initialize = reply;
      if (frame.method === 'model/list') models = reply;
    }); return catalogChild;
  } });
  await until(() => initialize);
  const h = chat(t, codexHome); h.session.sendUserMessage('fake turn');
  await tick(); await tick(); assert.equal(h.children.length, 0);
  initialize({ userAgent: 'fake' });
  await until(() => models && h.children[0]?.frames.some(frame => frame.method === 'turn/start'));
  assert.equal(catalogChild.signalCode, null, 'catalog client is still waiting for its list');
  assert.ok(h.children[0].frames.some(frame => frame.method === 'turn/start'), 'chat has started independently');
  models({ data: [{ model: 'fake-model' }], nextCursor: null });
  assert.equal((await catalog)[0].model, 'fake-model');
});

test('discovery timeout cleans its child and releases the next same-home startup', async t => {
  const codexHome = home(t); let failed;
  const catalog = discoverCodexModels({ codexHome, env: { PATH: '/bin' }, timeoutMs: 10, spawnProcess() { failed = new FakeChild(() => {}); return failed; } });
  const rejected = assert.rejects(catalog, /timed out/);
  await until(() => failed);
  const release = acquireCodexHomeInitialization(codexHome);
  await rejected;
  assert.equal(failed.signalCode, 'SIGTERM');
  (await release)();
});

test('interrupted or disposed chat waiting for a home never spawns stale config and can be replaced', async t => {
  const root = home(t), codexHome = path.join(root, '.codex');
  const release = await acquireCodexHomeInitialization(codexHome);
  const h = chat(t, codexHome);
  h.session.sendUserMessage('cancel before spawn'); await tick(); await tick();
  assert.equal(h.children.length, 0);
  h.session.interrupt(); await tick(); await tick();
  release(); await tick(); await tick();
  assert.equal(h.children.length, 0);
  h.session.sendUserMessage('replacement');
  await until(() => h.children[0]?.frames.some(frame => frame.method === 'turn/start'));
  assert.equal(h.children.length, 1);
  const started = h.children[0].frames.find(frame => frame.method === 'turn/start');
  assert.equal(started.params.model, 'fake-model');
  assert.match(JSON.stringify(started.params.input), /replacement/);
  assert.doesNotMatch(JSON.stringify(started.params.input), /cancel before spawn/);

  const blockedHome = path.join(root, 'disposed');
  const unblock = await acquireCodexHomeInitialization(blockedHome);
  const disposed = chat(t, blockedHome);
  disposed.session.sendUserMessage('dispose before spawn'); await tick();
  assert.equal(await disposed.session.dispose(), true);
  unblock(); await tick(); await tick();
  assert.equal(disposed.children.length, 0);
});

test('exhausted initialize retry cleans its exact child before a queued catalog may spawn', async t => {
  const root = home(t), codexHome = path.join(root, '.codex');
  let failSecond, finishSecondCleanup, kills = 0, spawns = 0;
  const session = createCodexAppServerSession({ rootDir: root, codexHome, mcpScriptPath: '/fake/mcp.mjs', hubPort: 1, token: 'fake',
    model: 'fake-model', permissionProfile: 'safe', workflow: 'direct', phase: 'implementing', agentRole: 'chat', onEvent() {} }, {
    spawnProcess() {
      const index = spawns++;
      const child = new FakeChild((frame, reply, proc) => {
        if (frame.method !== 'initialize') return;
        const fail = () => proc.send({ id: frame.id, error: { code: -32603, message: 'fixture initialization failed' } });
        if (index === 0) fail(); else failSecond = fail;
      });
      if (index === 1) child.kill = signal => {
        kills++;
        finishSecondCleanup = () => { child.signalCode = signal; child.emit('exit', null, signal); child.emit('close', null, signal); };
        return true;
      };
      return child;
    }, terminateProcess: child => child.kill(),
  });
  t.after(() => session.dispose());
  const readiness = session.setExecutionMode({ workflow: 'plan', phase: 'planning', capabilityEpoch: 1 });
  const rejected = assert.rejects(readiness, error => {
    assert.match(error.message, /negotiation failed/);
    assert.match(error.cause?.message, /initialization failed/);
    return true;
  });
  await until(() => failSecond);
  let catalogSpawns = 0;
  const catalog = discoverCodexModels({ codexHome, env: { PATH: '/bin' }, spawnProcess() {
    catalogSpawns++;
    return new FakeChild((frame, reply) => {
      if (frame.method === 'initialize') reply({});
      if (frame.method === 'model/list') reply({ data: [{ model: 'fake-model' }], nextCursor: null });
    });
  } });
  failSecond(); await until(() => finishSecondCleanup);
  assert.equal(catalogSpawns, 0, 'queued client must wait for failed child cleanup');
  assert.equal(kills, 1, 'the exact failed child is cleaned only once');
  finishSecondCleanup();
  await rejected;
  assert.equal((await catalog)[0].model, 'fake-model');
  assert.equal(catalogSpawns, 1);
});


test('discovery timeout while queued cannot spawn later or block the next startup', async t => {
  const codexHome = home(t);
  const release = await acquireCodexHomeInitialization(codexHome);
  let spawned = false;
  await assert.rejects(discoverCodexModels({ codexHome, env: { PATH: '/bin' }, timeoutMs: 10, spawnProcess() { spawned = true; throw new Error('unexpected spawn'); } }), /timed out/);
  release(); await tick(); await tick();
  assert.equal(spawned, false);
  (await acquireCodexHomeInitialization(codexHome))();
});

test('unconfirmed cleanup rejects queued and future home acquisitions without blocking other homes', async t => {
  const root = home(t), shared = path.join(root, 'shared');
  const release = await acquireCodexHomeInitialization(shared);
  const waiting = assert.rejects(acquireCodexHomeInitialization(shared), { code: 'CODEX_HOME_INITIALIZATION_BLOCKED' });
  release.poison(new Error('fixture cleanup unconfirmed'));
  release();
  await waiting;
  await assert.rejects(acquireCodexHomeInitialization(shared), { code: 'CODEX_HOME_INITIALIZATION_BLOCKED' });
  (await acquireCodexHomeInitialization(path.join(root, 'different')))();
});

test('pre-ACK chat cleanup without proof prevents queued catalog/chat and future clients from spawning', async t => {
  const root = home(t), codexHome = path.join(root, '.codex');
  let failInitialize, failedChild;
  const opts = { rootDir: root, codexHome, mcpScriptPath: '/fake/mcp.mjs', hubPort: 1, token: 'fake', model: 'fake-model',
    permissionProfile: 'safe', workflow: 'direct', phase: 'implementing', agentRole: 'chat', onEvent() {} };
  const first = createCodexAppServerSession({ ...opts }, {
    spawnProcess() {
      failedChild = new FakeChild((frame, reply, child) => {
        if (frame.method === 'initialize') failInitialize = () => child.send({ id: frame.id, error: { code: -32603, message: 'fixture initialize failure' } });
      }); return failedChild;
    },
    terminateProcess(child) {
      child.signalCode = 'SIGTERM'; child.emit('exit', null, 'SIGTERM'); child.emit('close', null, 'SIGTERM');
      return null; // Exit notification alone is not process-tree cleanup proof.
    },
  });
  t.after(() => first.dispose());
  const firstFailure = assert.rejects(first.setExecutionMode({ workflow: 'plan', phase: 'planning', capabilityEpoch: 1 }), /cleanup could not be confirmed/);
  await until(() => failInitialize);
  let catalogSpawns = 0, chatSpawns = 0;
  const noCatalogSpawn = () => { catalogSpawns++; throw new Error('poisoned catalog spawned'); };
  const queuedCatalog = assert.rejects(discoverCodexModels({ codexHome, env: { PATH: '/bin' }, spawnProcess: noCatalogSpawn }), /cleanup is unconfirmed/);
  const second = createCodexAppServerSession({ ...opts }, { spawnProcess() { chatSpawns++; throw new Error('poisoned chat spawned'); } });
  t.after(() => second.dispose());
  const queuedChat = assert.rejects(second.setExecutionMode({ workflow: 'plan', phase: 'planning', capabilityEpoch: 1 }));
  failInitialize();
  await Promise.all([firstFailure, queuedCatalog, queuedChat]);
  assert.equal(catalogSpawns, 0); assert.equal(chatSpawns, 0);
  await assert.rejects(discoverCodexModels({ codexHome, env: { PATH: '/bin' }, spawnProcess: noCatalogSpawn }), /cleanup is unconfirmed/);
  assert.equal(catalogSpawns, 0);
});

test('pre-ACK catalog cleanup without proof blocks queued chat and future catalog starts', async t => {
  const root = home(t), codexHome = path.join(root, '.codex');
  let failInitialize;
  const catalog = discoverCodexModels({ codexHome, env: { PATH: '/bin' }, spawnProcess() {
    return new FakeChild((frame, reply, child) => {
      if (frame.method === 'initialize') failInitialize = () => {
        child.signalCode = 'SIGTERM'; // Leader exit without a retained tree identity cannot prove cleanup.
        child.send({ id: frame.id, error: { code: -32603, message: 'fixture initialize failure' } });
      };
    });
  } });
  const catalogFailure = assert.rejects(catalog, /process cleanup failed/);
  await until(() => failInitialize);
  let chatSpawns = 0, catalogSpawns = 0;
  const session = createCodexAppServerSession({ rootDir: root, codexHome, mcpScriptPath: '/fake/mcp.mjs', hubPort: 1, token: 'fake',
    model: 'fake-model', permissionProfile: 'safe', workflow: 'direct', phase: 'implementing', agentRole: 'chat', onEvent() {} }, {
    spawnProcess() { chatSpawns++; throw new Error('poisoned chat spawned'); },
  });
  t.after(() => session.dispose());
  const chatFailure = assert.rejects(session.setExecutionMode({ workflow: 'plan', phase: 'planning', capabilityEpoch: 1 }));
  failInitialize();
  await Promise.all([catalogFailure, chatFailure]);
  assert.equal(chatSpawns, 0);
  await assert.rejects(discoverCodexModels({ codexHome, env: { PATH: '/bin' }, spawnProcess() {
    catalogSpawns++; throw new Error('poisoned catalog spawned');
  } }), /cleanup is unconfirmed/);
  assert.equal(catalogSpawns, 0);
});
