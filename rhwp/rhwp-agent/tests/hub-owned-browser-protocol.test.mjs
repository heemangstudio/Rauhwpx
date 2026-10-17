import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import WebSocket from 'ws';
import { registerHubSession } from '../../../desktop/agent-hub.mjs';

const TOKEN = 'owned-browser-protocol-test';

function receive(socket, predicate) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.off('message', onMessage); reject(new Error('Browser response timed out')); }, 8_000);
    function onMessage(bytes) {
      const message = JSON.parse(bytes.toString());
      if (!predicate(message)) return;
      clearTimeout(timer); socket.off('message', onMessage); resolve(message);
    }
    socket.on('message', onMessage);
  });
}

async function request(socket, requestId, action, args = {}) {
  const response = receive(socket, (message) => message.type === 'browser-response' && message.requestId === requestId);
  socket.send(JSON.stringify({ v: 5, type: 'browser-request', requestId, action, args }));
  return response;
}

for (const native of [false, true]) test(`owner browser channels bind approvals to ${native ? 'native' : 'managed'} runtime without exposing secrets`, { timeout: 35_000 }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'owned-browser-hub-'));
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, NODE_ENV: 'test', RHWP_AGENT_MODE: '', RHWP_AGENT_PORT: '0', RHWP_AGENT_TOKEN: TOKEN,
      RHWP_WORK_DIR: path.join(root, 'work'), RHWP_REFERENCES_DIR: path.join(root, 'references'),
      RHWP_PROJECTS_DIR: path.join(root, 'projects'), RHWP_TEMPLATES_DIR: path.join(root, 'templates'),
      RHWP_AGENT_INSTRUCTIONS_DIR: path.join(root, 'instructions'), RHWP_PI_DIR: path.join(root, 'pi'),
      RHWP_BROWSER_DATA_DIR: path.join(root, 'browser'), RHWP_BROWSER_OS_KEYRING: '0', RHWP_BROWSER_HOST: native ? 'ipc' : '', RHWP_SECRET_BROKER: '' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  child.on('message', message => {
    if (message?.type === 'rhwp-browser-request') {
      assert.equal(message.operation, 'password-accounts');
      child.send({ type: 'rhwp-browser-response', id: message.id, ok: true, value: { accounts: [] } });
    }
  });
  let stderr = '';
  child.stderr.on('data', (bytes) => { stderr += bytes.toString(); });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); }
    await rm(root, { recursive: true, force: true });
  });
  const ready = await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`Hub did not start: ${stderr}`)), 20_000);
    child.once('exit', () => { clearTimeout(timer); reject(new Error(`Hub exited: ${stderr}`)); });
    child.stdout.on('data', (bytes) => {
      output += bytes.toString();
      const line = output.split('\n').find((entry) => entry.startsWith('RHWP_HUB_READY '));
      if (!line) return;
      clearTimeout(timer); resolve(JSON.parse(line.slice('RHWP_HUB_READY '.length)));
    });
  });
  const capabilities = await registerHubSession({ port: ready.port, token: TOKEN, launchId: ready.launchId, sessionId: 'browser-owner' });
  const socket = new WebSocket(`ws://127.0.0.1:${ready.port}/studio?token=${capabilities.studio}&sessionId=browser-owner&instance=window-one`);
  const observed = [];
  socket.on('message', (bytes) => observed.push(bytes.toString()));
  await once(socket, 'open');
  t.after(() => socket.terminate());

  const policy = await request(socket, 'policy', 'policy.list');
  assert.equal(policy.result.defaults.browse, true);
  assert.equal(policy.result.defaults.download, true);
  assert.equal(policy.result.defaults.researchImport, true);
  assert.deepEqual((await request(socket, 'inbox', 'downloads')).result.downloads, []);
  assert.deepEqual((await request(socket, 'accounts', 'accounts.list')).result.accounts, []);
  const secret = 'browser-password-must-stay-private';
  const blocked = await request(socket, 'bad-channel', 'accounts.request', { origin: 'https://example.com', password: secret });
  assert.equal(blocked.error.code, 'BROWSER_SECURE_CHANNEL_REQUIRED');
  assert.equal(observed.some((message) => message.includes(secret)), false);

  const revoked = await request(socket, 'disable', 'policy.update', { operation: 'set-default', key: 'download', enabled: false });
  assert.equal(revoked.result.defaults.download, false);
  assert.equal((await request(socket, 'policy-after', 'policy.list')).result.defaults.download, false);
  const persistedResponse = await request(socket, 'secure-wrong-request', 'accounts.request', { origin: 'https://example.com', label: 'Research account', tabId: 'settings-tab', reason: 'Read saved references' });
  assert.equal(typeof persistedResponse.result.requestId, 'string');
  assert.equal(persistedResponse.result.profileId, native ? 'native' : 'default');
  const submit = receive(socket, (message) => message.type === 'browser-response' && message.requestId === 'secure');
  socket.send(JSON.stringify({ v: 5, type: 'browser-account-submit', requestId: 'secure', accountRequestId: persistedResponse.result.requestId,
    username: 'private-user', password: secret, remember: true, consent: { save: true, use: true } }));
  const submitted = await submit;
  assert.equal(submitted.error.code, 'BROWSER_SECURE_STORAGE_UNAVAILABLE');
  assert.equal(observed.some((message) => message.includes(secret) || message.includes('private-user')), false);
  assert.equal(stderr.includes(secret), false);

  const unauthenticated = await fetch(`http://127.0.0.1:${ready.port}/browser-downloads?sessionId=browser-owner`);
  assert.equal(unauthenticated.status, 401);
  const inbox = await fetch(`http://127.0.0.1:${ready.port}/browser-downloads?sessionId=browser-owner`, { headers: { Authorization: `Bearer ${capabilities.reference}` } });
  assert.equal(inbox.status, 200);
  assert.deepEqual((await inbox.json()).downloads, []);
  const retained = await request(socket, 'retained-request', 'accounts.request', { origin: 'https://example.com', profileId: 'default', intent: 'use' });
  const accepted = await request(socket, 'retained-approve', 'accounts.approve', { requestId: retained.result.requestId });
  assert.equal(accepted.result.account.profileId, 'default');
  const listed = (await request(socket, 'retained-list', 'accounts.list')).result.accounts.find(row => row.id === accepted.result.account.id);
  assert.equal(listed.agentReuseApproved, !native);
  const active = await request(socket, 'active-approve', 'accounts.approve', { accountId: listed.id });
  assert.equal(active.result.account.id, listed.id);
  assert.equal(active.result.account.profileId, native ? 'native' : 'default');
  assert.equal(active.result.account.agentReuseApproved, true);
  if (native) {
    const status = await request(socket, 'native-status', 'status');
    assert.equal(status.result.readiness.installed, true);
    assert.equal(status.result.readiness.state, 'ready');
  }

});
