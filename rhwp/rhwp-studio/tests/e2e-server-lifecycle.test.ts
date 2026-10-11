import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

// e2e 스크립트가 허브·Vite 를 띄우고 멈추는 공용 하니스. 실제 프로세스를 띄워 확인한다.
import { spawnLogged, stopServer } from '../e2e/agent-bench-harness.mjs';

const harnessUrl = pathToFileURL(join(import.meta.dirname, '../e2e/agent-bench-harness.mjs')).href;
const posixOnly = { skip: process.platform === 'win32' ? 'POSIX 프로세스 그룹을 ps 로 확인한다' : false };

/**
 * `npm run dev` 를 흉내 낸 서버: 같은 그룹의 자식(npm → sh → vite 처럼 래퍼가 SIGTERM 을 넘기지
 * 않는 자식)과, 허브의 Pi 자동 업데이트 npm install 처럼 자기 그룹으로 떨어져 나간 자식을 둔다.
 */
const FAKE_SERVER = `
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const keepAlive = 'setInterval(() => {}, 1000)';
const inGroup = spawn(process.execPath, ['-e', keepAlive], { stdio: 'ignore' });
const escaped = spawn(process.execPath, ['-e', keepAlive], { stdio: 'ignore', detached: true });
fs.writeFileSync(process.argv[2], JSON.stringify({ leader: process.pid, inGroup: inGroup.pid, escaped: escaped.pid }));
setInterval(() => {}, 1000);
`;

/** 하니스로 서버를 띄운 e2e 스크립트. 준비되면 pid 를 알리고 mode 대로 끝난다. */
const RUNNER = `
import fs from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { spawnLogged } from ${JSON.stringify(harnessUrl)};
const [serverPath, pidsPath, logPath, mode] = process.argv.slice(2);
spawnLogged(process.execPath, [serverPath, pidsPath], process.cwd(), {}, logPath);
while (!fs.existsSync(pidsPath) || !fs.readFileSync(pidsPath, 'utf8')) await delay(20);
process.stdout.write('READY\\n');
if (mode === 'throw') throw new Error('e2e step failed');
setInterval(() => {}, 1000);
`;

type ServerPids = { leader: number; inGroup: number; escaped: number };

function fixture(t: { after: (fn: () => void) => void }) {
  const dir = mkdtempSync(join(tmpdir(), 'rhwp-e2e-lifecycle-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const serverPath = join(dir, 'server.cjs');
  writeFileSync(serverPath, FAKE_SERVER);
  const runnerPath = join(dir, 'runner.mjs');
  writeFileSync(runnerPath, RUNNER);
  return { dir, serverPath, runnerPath, pidsPath: join(dir, 'pids.json'), logPath: join(dir, 'server.log') };
}

/** 좀비는 이미 끝난 것으로 본다 — 부모가 거두기 전까지 표에 남을 뿐이다. */
function running(pid: number): boolean {
  try {
    const stat = execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).trim();
    return stat !== '' && !stat.startsWith('Z');
  } catch {
    return false;
  }
}

async function waitForPids(pidsPath: string): Promise<ServerPids> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const text = readFileSync(pidsPath, 'utf8');
      if (text) return JSON.parse(text) as ServerPids;
    } catch { /* 아직 없음 */ }
    await delay(20);
  }
  throw new Error('fake server did not start');
}

async function assertAllStopped(pids: ServerPids, cleanup: number[]) {
  const deadline = Date.now() + 5_000;
  let alive = Object.entries(pids).filter(([, pid]) => running(pid));
  while (alive.length > 0 && Date.now() < deadline) {
    await delay(50);
    alive = alive.filter(([, pid]) => running(pid));
  }
  // 실패해도 이 테스트가 만든 프로세스를 남기지 않는다.
  for (const [, pid] of alive) cleanup.push(pid);
  assert.deepEqual(alive.map(([name]) => name), [], 'every process the server started has stopped');
}

function killLeftovers(pids: number[]) {
  for (const pid of pids) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* 이미 끝남 */ }
  }
}

async function startRunner(paths: ReturnType<typeof fixture>, mode: 'wait' | 'throw') {
  const runner = spawn(
    process.execPath,
    [paths.runnerPath, paths.serverPath, paths.pidsPath, paths.logPath, mode],
    { cwd: paths.dir, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let stderr = '';
  runner.stderr.on('data', (chunk) => { stderr += chunk; });
  // close 는 stdout 을 다 읽은 뒤에 온다 — READY 를 읽기 전에 끝났다고 보지 않는다.
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    runner.once('close', (code, signal) => resolve({ code, signal }));
  });
  await new Promise<void>((resolve, reject) => {
    let out = '';
    runner.stdout.on('data', (chunk) => {
      out += chunk;
      if (out.includes('READY')) resolve();
    });
    void exited.then(() => reject(new Error(`runner exited before ready: ${stderr}`)));
  });
  return { runner, exited, stderr: () => stderr, pids: await waitForPids(paths.pidsPath) };
}

test('stopServer는 래퍼만이 아니라 서버가 띄운 프로세스 트리 전체를 멈춘다', posixOnly, async (t) => {
  const paths = fixture(t);
  const leftovers: number[] = [];
  t.after(() => killLeftovers(leftovers));
  const server = spawnLogged(process.execPath, [paths.serverPath, paths.pidsPath], paths.dir, {}, paths.logPath);
  const pids = await waitForPids(paths.pidsPath);
  leftovers.push(...Object.values(pids));

  const stopped = await stopServer(server);
  await assertAllStopped(pids, leftovers);
  assert.equal(stopped, true, 'stopServer reports the tree as stopped');
  // 이미 멈춘 서버를 다시 멈춰도 된다 (finally 와 중간 정리가 겹치는 경우).
  assert.equal(await stopServer(server), true);
});

for (const [signal, code] of [['SIGTERM', 143], ['SIGINT', 130]] as const) {
  test(`테스트 프로세스가 ${signal} 로 끝나도 띄운 서버 트리가 남지 않는다`, posixOnly, async (t) => {
    const paths = fixture(t);
    const leftovers: number[] = [];
    t.after(() => killLeftovers(leftovers));
    const { runner, exited, pids } = await startRunner(paths, 'wait');
    leftovers.push(runner.pid!, ...Object.values(pids));

    runner.kill(signal);
    const result = await exited;
    await assertAllStopped(pids, leftovers);
    assert.equal(result.code, code, 'the runner still exits with the conventional signal code');
  });
}

test('테스트가 잡히지 않은 예외로 끝나도 띄운 서버 트리가 남지 않는다', posixOnly, async (t) => {
  const paths = fixture(t);
  const leftovers: number[] = [];
  t.after(() => killLeftovers(leftovers));
  const { runner, exited, stderr, pids } = await startRunner(paths, 'throw');
  leftovers.push(runner.pid!, ...Object.values(pids));

  const result = await exited;
  await assertAllStopped(pids, leftovers);
  assert.equal(result.code, 1);
  assert.match(stderr(), /e2e step failed/, 'the original failure is still reported');
});
