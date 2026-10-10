/**
 * Shared harness for tests that run the real hub (`server.mjs`) as a child.
 *
 * The hub cannot be driven in process: it builds provider backends from its
 * own factories and starts listening on import. Tests therefore start it as a
 * child with a private work root, and replace provider CLIs through the hub's
 * real binary lookup (Pi under `RHWP_PI_DIR`, see `prepareFakePi`).
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import WebSocket from 'ws';

import { ALIVE_PI_FIXTURE_SOURCE, writeFakeCliBin } from './fake-cli-bin.mjs';

export const HUB_TEST_TOKEN = 'hub-test-token';
export const HUB_TEST_LAUNCH_ID = 'hub-test-launch';
export const HUB_PROTOCOL_VERSION = 5;

export function waitForLine(stream, predicate, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    const lines = createInterface({ input: stream });
    const timer = setTimeout(() => {
      lines.close();
      reject(new Error('Timed out waiting for process output'));
    }, timeoutMs);
    lines.on('line', (line) => {
      if (!predicate(line)) return;
      clearTimeout(timer);
      lines.close();
      resolve(line);
    });
  });
}

export async function waitForPath(filePath, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(filePath)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for path: ${filePath}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

export async function registerSession(port, sessionId, {
  token = HUB_TEST_TOKEN,
  launchId = HUB_TEST_LAUNCH_ID,
} = {}) {
  const registration = await fetch(
    `http://127.0.0.1:${port}/sessions/${encodeURIComponent(sessionId)}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'X-Rhwp-Launch-Id': launchId,
      },
    },
  );
  assert.equal(registration.status, 200);
  return registration.json();
}

/**
 * Open a hub WebSocket and buffer every JSON frame. `next(predicate)` resolves
 * with the first buffered or future frame that matches, and removes it.
 * `frames()` lists everything received so far, matched or not.
 */
export async function openClient(url, { token, launchId } = {}) {
  const parsedUrl = new URL(url);
  const sessionId = parsedUrl.searchParams.get('sessionId');
  if (sessionId) await registerSession(parsedUrl.port, sessionId, { token, launchId });
  const socket = new WebSocket(url);
  const buffered = [];
  const received = [];
  const waiters = [];
  socket.on('message', (data) => {
    let frame;
    try { frame = JSON.parse(data.toString()); } catch { return; }
    received.push(frame);
    const index = waiters.findIndex((waiter) => waiter.predicate(frame));
    if (index < 0) {
      buffered.push(frame);
      return;
    }
    const [waiter] = waiters.splice(index, 1);
    clearTimeout(waiter.timer);
    waiter.resolve(frame);
  });
  await once(socket, 'open');
  return {
    socket,
    frames: () => [...received],
    next(predicate, timeoutMs = 10_000) {
      const index = buffered.findIndex(predicate);
      if (index >= 0) return Promise.resolve(buffered.splice(index, 1)[0]);
      return new Promise((resolve, reject) => {
        const timeoutError = new Error('Timed out waiting for websocket frame');
        const waiter = { predicate, resolve, timer: null };
        waiter.timer = setTimeout(() => {
          const current = waiters.indexOf(waiter);
          if (current >= 0) waiters.splice(current, 1);
          timeoutError.message += `; buffered=${JSON.stringify(buffered)}`;
          reject(timeoutError);
        }, timeoutMs);
        waiters.push(waiter);
      });
    },
  };
}

export function sendFrame(client, frame) {
  client.socket.send(JSON.stringify({ v: HUB_PROTOCOL_VERSION, ...frame }));
}

export async function closeClient(client) {
  if (!client || client.socket.readyState === WebSocket.CLOSED) return;
  const closed = once(client.socket, 'close');
  client.socket.close();
  await closed;
}

/**
 * Lay out a configured Pi under `root` as the hub expects it for
 * `RHWP_PI_DIR`: installed package, one model, a placeholder OpenRouter key
 * (setup complete; `apiKey: null` leaves setup incomplete), and
 * `prefix/node_modules/.bin/pi` running `fixtureSource` (`null` installs no
 * launcher). Returns the bin directory so callers can install their own.
 */
export function prepareFakePi(root, fixtureSource = ALIVE_PI_FIXTURE_SOURCE, {
  version = '0.0.0-test',
  modelId = 'mock-model',
  apiKey = 'test-placeholder-key',
} = {}) {
  const packageDir = path.join(root, 'prefix', 'node_modules', '@earendil-works', 'pi-coding-agent');
  const binDir = path.join(root, 'prefix', 'node_modules', '.bin');
  mkdirSync(packageDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({ version }));
  writeFileSync(path.join(root, 'config.json'), JSON.stringify({
    version: 1,
    installedVersion: version,
    models: [{
      id: modelId, name: 'Mock model', reasoning: false, supportsImages: false,
      efforts: [], defaultEffort: null, contextLength: 8_192,
      pricing: { prompt: 0, completion: 0 },
    }],
    defaultModelId: modelId,
  }));
  const agentDir = path.join(root, 'agent');
  mkdirSync(agentDir, { recursive: true });
  // Without a key the hub treats Pi setup as incomplete (PI_NOT_CONFIGURED).
  writeFileSync(path.join(agentDir, 'models.json'), JSON.stringify({
    providers: apiKey ? { openrouter: { apiKey } } : {},
  }));
  if (fixtureSource !== null) writeFakeCliBin(binDir, 'pi', fixtureSource);
  return { binDir };
}

/**
 * Start `server.mjs` on an ephemeral port with a private work root that is
 * removed after the test.
 *
 * `fakePi` installs a configured Pi under `<workRoot>/pi`:
 * - `true`: a CLI that stays alive and never answers;
 * - a string: the CLI's JavaScript source;
 * - a function `(context) => source | null`: called with
 *   `{ workRoot, piRoot, binDir }` before the hub starts. Returning `null`
 *   keeps whatever launcher the function installed itself (for example
 *   `installReplayCli`).
 * `piApiKey: null` leaves the fake Pi's setup incomplete.
 */
export async function startHub(t, {
  fakePi = false,
  piApiKey,
  env = {},
  token = HUB_TEST_TOKEN,
  launchId = HUB_TEST_LAUNCH_ID,
  prefix = 'rhwp-hub-test-',
  readyTimeoutMs = 20_000,
} = {}) {
  const workRoot = mkdtempSync(path.join(os.tmpdir(), prefix));
  const piRoot = path.join(workRoot, 'pi');
  if (fakePi) {
    const piOptions = piApiKey === undefined ? {} : { apiKey: piApiKey };
    if (typeof fakePi === 'function') {
      const { binDir } = prepareFakePi(piRoot, null, piOptions);
      const source = fakePi({ workRoot, piRoot, binDir });
      if (source !== null && source !== undefined) writeFakeCliBin(binDir, 'pi', source);
    } else {
      prepareFakePi(piRoot, typeof fakePi === 'string' ? fakePi : ALIVE_PI_FIXTURE_SOURCE, piOptions);
    }
  }
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: new URL('..', import.meta.url),
    env: {
      ...process.env,
      NODE_ENV: 'test',
      RHWP_AGENT_PORT: '0',
      RHWP_AGENT_TOKEN: token,
      RHWP_LAUNCH_ID: launchId,
      RHWP_WORK_DIR: workRoot,
      RHWP_TEMPLATES_DIR: path.join(workRoot, 'templates'),
      // Provider usage from fake CLIs must never reach the user's usage log.
      RHWP_USAGE_DIR: path.join(workRoot, 'usage'),
      ...(fakePi ? { RHWP_PI_DIR: piRoot } : {}),
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  t.after(async () => {
    if (child.exitCode === null) child.kill('SIGTERM');
    if (child.exitCode === null) await once(child, 'exit');
    rmSync(workRoot, { recursive: true, force: true });
  });
  const readyLine = await waitForLine(
    child.stdout,
    (line) => line.startsWith('RHWP_HUB_READY '),
    readyTimeoutMs,
  );
  const ready = JSON.parse(readyLine.slice('RHWP_HUB_READY '.length));
  return {
    port: ready.port,
    token,
    launchId,
    workRoot,
    piRoot,
    child,
    stderr: () => stderr,
  };
}
