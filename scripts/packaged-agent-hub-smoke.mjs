import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { processTreeSpawnOptions, terminateAndWaitForProcessTreeExit } from '../rhwp/rhwp-agent/process-tree.mjs';

const READY_PREFIX = 'RHWP_HUB_READY ';
const LOG_LIMIT = 16 * 1024;

function appendLog(current, chunk) {
  return `${current}${String(chunk)}`.slice(-LOG_LIMIT);
}

function waitForReady(child, { timeoutMs, stderr }) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout?.off('data', onData);
      child.off('error', onError);
      child.off('exit', onExit);
    };
    const fail = (error) => {
      cleanup();
      reject(error);
    };
    const consume = () => {
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line.startsWith(READY_PREFIX)) continue;
        cleanup();
        try {
          resolve(JSON.parse(line.slice(READY_PREFIX.length)));
        } catch (error) {
          reject(new Error(`Packaged agent hub emitted an invalid ready line: ${error.message}`));
        }
        return;
      }
    };
    const onData = (chunk) => {
      buffer = appendLog(buffer, chunk);
      consume();
    };
    const onError = (error) => fail(error);
    const onExit = (code, signal) => {
      fail(new Error(`Packaged agent hub exited before ready (${code ?? signal ?? 'unknown'}):\n${stderr()}`));
    };
    const timer = setTimeout(() => {
      fail(new Error(`Packaged agent hub did not become ready within ${timeoutMs}ms:\n${stderr()}`));
    }, timeoutMs);
    child.stdout?.on('data', onData);
    child.once('error', onError);
    child.once('exit', onExit);
  });
}

function waitForExit(child, timeoutMs = 10_000) {
  if (child.exitCode != null || child.signalCode != null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const finish = (exited) => {
      clearTimeout(timer);
      child.off('exit', onExit);
      resolve(exited);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once('exit', onExit);
  });
}

async function ownerRequest(baseUrl, pathname, { token, launchId, method = 'GET' }) {
  return fetch(`${baseUrl}${pathname}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      'x-rhwp-launch-id': launchId,
    },
  });
}

/** Exercise the same unpacked module and Electron host used by provider login. */
export async function smokePackagedSetupTerminal({ executable, agentDir, timeoutMs = 10_000 }) {
  const moduleUrl = pathToFileURL(path.join(agentDir, 'setup-terminal.mjs')).href;
  const childCode = `
    process.stdout.write('LOGIN_TTY:' + Boolean(process.stdin.isTTY && process.stdout.isTTY) + '\\n');
    process.stdin.once('data', (data) => {
      const received = String(data).trim() === 'package-smoke';
      console.log(received ? 'LOGIN_INPUT_OK' : 'LOGIN_INPUT_FAILED');
      process.exit(received ? 0 : 1);
    });
  `;
  // Electron is a Windows GUI executable, so the PTY child must be a
  // console executable even when the owning hub runs as Electron-as-Node.
  const command = process.platform === 'win32'
    ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    : executable;
  const argv = process.platform === 'win32'
    ? ['-NoLogo', '-NoProfile', '-Command',
      '[Console]::WriteLine("LOGIN_TTY:" + (![Console]::IsInputRedirected -and ![Console]::IsOutputRedirected).ToString().ToLower()); $received=[Console]::ReadLine() -eq "package-smoke"; [Console]::WriteLine($(if($received){"LOGIN_INPUT_OK"}else{"LOGIN_INPUT_FAILED"})); if(!$received){exit 1}']
    : ['-e', childCode];
  const probe = `
    import assert from 'node:assert/strict';
    import { createSetupTerminal } from ${JSON.stringify(moduleUrl)};
    let output = '';
    let sentInput = false;
    const terminal = createSetupTerminal({
      command: ${JSON.stringify(command)},
      argv: ${JSON.stringify(argv)},
      cwd: process.cwd(),
      env: process.env,
      timeoutMs: 5_000,
      onOutput(data) {
        output += data;
        if (!sentInput && output.includes('LOGIN_TTY:true')) {
          sentInput = true;
          terminal.resize(100, 24);
          terminal.write('package-smoke\\r');
        }
      },
    });
    assert.equal((await terminal.done).code, 0, output);
    assert.match(output, /LOGIN_TTY:true/);
    assert.match(output, /LOGIN_INPUT_OK/);
    // ConPTY can retain handles after the login child exits. This probe has
    // verified its result, so flush the marker and end the disposable host.
    process.stdout.write('Packaged provider login terminal passed\\n', () => process.exit(0));
  `;
  const child = spawn(executable, ['--input-type=module', '--eval', probe], {
    cwd: agentDir,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    ...processTreeSpawnOptions(),
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output = appendLog(output, chunk); });
  child.stderr.on('data', (chunk) => { output = appendLog(output, chunk); });
  const closed = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code === 0 && output.includes('Packaged provider login terminal passed')) resolve();
      else reject(new Error(`Packaged provider login terminal failed (${code ?? signal ?? 'unknown'}):\n${output}`));
    });
  });
  let timer;
  let cleanup;
  const timedOut = new Promise((_, reject) => {
    timer = setTimeout(() => {
      cleanup = terminateAndWaitForProcessTreeExit(child);
      reject(new Error(`Packaged provider login terminal timed out after ${timeoutMs}ms:\n${output}`));
    }, timeoutMs);
  });
  try {
    await Promise.race([closed, timedOut]);
  } catch (error) {
    if (!cleanup && child.pid && child.exitCode == null && child.signalCode == null) {
      cleanup = terminateAndWaitForProcessTreeExit(child);
    }
    if (cleanup && !await cleanup) {
      throw new Error(`Packaged provider login terminal cleanup could not be confirmed: ${error.message}`, { cause: error });
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function smokePackagedAgentHub({ executable, agentDir, timeoutMs = 30_000 }) {
  const workRoot = mkdtempSync(path.join(os.tmpdir(), 'hamaeditor-packaged-hub-'));
  const token = `package-smoke-${process.pid}-${Date.now()}`;
  const launchId = `package-smoke-${process.pid}`;
  const scriptPath = path.join(agentDir, 'server.mjs');
  let stderr = '';
  let child;
  const secrets = new Map();
  try {
    child = spawn(executable, [scriptPath], {
      cwd: agentDir,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        NODE_ENV: 'production',
        RHWP_AGENT_MODE: 'production',
        RHWP_AGENT_PORT: '0',
        RHWP_AGENT_TOKEN: token,
        RHWP_LAUNCH_ID: launchId,
        RHWP_SECRET_BROKER: 'ipc',
        RHWP_WORK_DIR: path.join(workRoot, 'work'),
        RHWP_RUNTIME_DIR: path.join(workRoot, 'runtime'),
        RHWP_AGENT_INSTRUCTIONS_DIR: path.join(workRoot, 'agent-instructions'),
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    child.on('message', (message) => {
      if (!message || message.type !== 'rhwp-secret-request' || typeof message.id !== 'string') return;
      let value = null;
      if (message.operation === 'get') value = secrets.get(message.key) ?? null;
      else if (message.operation === 'set') {
        secrets.set(message.key, String(message.value));
        value = true;
      } else if (message.operation === 'delete') value = secrets.delete(message.key);
      else if (message.operation === 'reset') {
        secrets.clear();
        value = true;
      } else {
        child.send({
          type: 'rhwp-secret-response',
          id: message.id,
          ok: false,
          code: 'SECRET_STORE_INVALID_OPERATION',
          error: `Unsupported secret operation: ${message.operation}`,
        });
        return;
      }
      child.send({ type: 'rhwp-secret-response', id: message.id, ok: true, value });
    });
    child.stderr?.on('data', (chunk) => {
      stderr = appendLog(stderr, chunk);
    });

    const ready = await waitForReady(child, { timeoutMs, stderr: () => stderr });
    assert.equal(ready.launchId, launchId, 'packaged hub ready line used the wrong launch id');
    assert.equal(ready.pid, child.pid, 'packaged hub ready line used the wrong process id');
    assert.ok(Number.isSafeInteger(ready.port) && ready.port > 0, 'packaged hub did not bind a port');
    const baseUrl = `http://127.0.0.1:${ready.port}`;

    const healthResponse = await ownerRequest(baseUrl, '/healthz', { token, launchId });
    const healthText = await healthResponse.text();
    assert.equal(healthResponse.status, 200, `packaged hub health check failed: ${healthText}`);
    const health = JSON.parse(healthText);
    assert.equal(health.ok, true);
    assert.equal(health.launchId, launchId);
    assert.equal(health.pid, child.pid);

    const sessionPath = '/sessions/package-smoke';
    const sessionResponse = await ownerRequest(baseUrl, sessionPath, {
      token,
      launchId,
      method: 'POST',
    });
    const sessionText = await sessionResponse.text();
    assert.equal(sessionResponse.status, 200, `packaged hub session connection failed: ${sessionText}`);
    const session = JSON.parse(sessionText);
    assert.equal(session.status, 'registered');
    assert.equal(session.sessionId, 'package-smoke');
    assert.ok(session.capabilities?.studio);

    const deleteResponse = await ownerRequest(baseUrl, sessionPath, {
      token,
      launchId,
      method: 'DELETE',
    });
    assert.equal(deleteResponse.status, 200, `packaged hub session cleanup failed: ${await deleteResponse.text()}`);

    const shutdownResponse = await ownerRequest(baseUrl, '/shutdown', {
      token,
      launchId,
      method: 'POST',
    });
    assert.equal(shutdownResponse.status, 200, `packaged hub shutdown failed: ${await shutdownResponse.text()}`);
    assert.equal(await waitForExit(child), true, 'packaged hub did not exit after shutdown');
    return { port: ready.port, pid: ready.pid, sessionId: session.sessionId };
  } finally {
    if (child && child.exitCode == null && child.signalCode == null) {
      child.kill('SIGTERM');
      await waitForExit(child);
    }
    rmSync(workRoot, { recursive: true, force: true });
  }
}
