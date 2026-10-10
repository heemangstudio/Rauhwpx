/**
 * 에이전트 벤치 공용 하니스 — 실제 허브 + vite 스튜디오 + 가짜 pi 프로바이더 턴.
 *
 * agent-tool-bench.mjs, agent-tool-concurrency-bench.mjs, agent-claude-live-bench.mjs 가 같이 쓴다.
 * 모델/추론 없이 프로덕션 도구 경로(허브 → 브리지 → 실행기 → wasm)를 구동한다.
 *
 * 허브·Vite 를 띄우는 e2e 스크립트는 모두 spawnLogged/stopServer 로 서버를 띄우고 멈춘다.
 * 서버는 자기 프로세스 그룹(POSIX)으로 띄워 `npm run dev` 의 npm → sh → vite 같은 트리를
 * 통째로 멈추고, 테스트 프로세스가 신호·예외·process.exit 로 끝나도 남기지 않는다.
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import {
  processTreeSpawnOptions,
  terminateAndWaitForProcessTreeExit,
  terminateProcessTree,
} from '../../rhwp-agent/process-tree.mjs';
import { writeFakeCliBin } from '../../rhwp-agent/tests/fake-cli-bin.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const studioRoot = path.resolve(__dirname, '..');
export const repoRoot = path.resolve(studioRoot, '..');
const isWindows = process.platform === 'win32';
export const npmCmd = isWindows ? 'npm.cmd' : 'npm';

export async function findAvailablePort(startPort, attempts = 40) {
  for (let port = startPort; port < startPort + attempts; port += 1) {
    const available = await new Promise((resolve) => {
      const server = net.createServer();
      server.once('error', () => resolve(false));
      server.listen(port, '127.0.0.1', () => {
        server.close(() => resolve(true));
      });
    });
    if (available) return port;
  }
  throw new Error(`failed to find an available port starting at ${startPort}`);
}

export async function waitForHttp(url, label, child, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    if (child && (child.exitCode !== null || child.signalCode)) {
      throw new Error(`${label} 프로세스가 준비 전 종료 (code=${child.exitCode ?? child.signalCode})`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) return;
      lastError = new Error(`status ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await delay(400);
  }
  throw new Error(`${label} 준비 대기 시간 초과: ${lastError?.message || 'unknown'}`);
}

// ─── 소유한 서버 프로세스 트리 ─────────────────────────────────

/** 허브가 정상 종료(세션·공급자 정리)를 마치도록 SIGKILL 전에 기다리는 시간. */
const SERVER_STOP_GRACE_MS = 5_000;
/** 서버가 자기 그룹 밖으로 띄운 자손(예: 허브의 Pi 자동 업데이트 npm install)의 유예. */
const ESCAPED_GROUP_GRACE_MS = 3_000;
const DESCENDANT_POLL_MS = 200;
/** 신호를 직접 처리하는 스크립트가 정리(서버 멈춤·임시 폴더 삭제)를 마치고 끝내기를 기다리는 상한. */
const SIGNAL_CLEANUP_GRACE_MS = 15_000;

/** 이 프로세스가 띄우고 아직 끝난 것을 확인하지 못한 서버. 종료 경로가 트리째 정리한다. */
const ownedServers = new Set();
let exitHooksInstalled = false;

/**
 * POSIX 프로세스 표. ps 가 없거나 실패하면 null — 그룹 밖 자손 추적만 건너뛴다.
 * 시작 시각(lstart)은 pid 재사용과 구별하는 데 쓴다.
 */
function readProcessTable() {
  if (isWindows) return null;
  let output;
  try {
    output = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,pgid=,stat=,lstart='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5_000,
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch {
    return null;
  }
  const rows = [];
  for (const line of output.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
    if (!match) continue;
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      pgid: Number(match[3]),
      zombie: match[4].startsWith('Z'),
      key: `${match[1]}@${match[5]}`,
    });
  }
  return rows;
}

function validPid(value) {
  const pid = Number(value);
  return Number.isSafeInteger(pid) && pid > 1 ? pid : null;
}

/** rootPid 의 자손 가운데 rootPid 의 프로세스 그룹을 벗어난 것 — 그룹 신호가 닿지 않는다. */
function escapedDescendants(rootPid, table) {
  const children = new Map();
  for (const row of table) {
    if (!children.has(row.ppid)) children.set(row.ppid, []);
    children.get(row.ppid).push(row);
  }
  const found = [];
  const seen = new Set([rootPid]);
  const queue = [rootPid];
  while (queue.length > 0) {
    for (const row of children.get(queue.shift()) ?? []) {
      if (seen.has(row.pid)) continue;
      seen.add(row.pid);
      queue.push(row.pid);
      if (row.pgid !== rootPid && !row.zombie) found.push(row);
    }
  }
  return found;
}

/**
 * 서버를 멈추는 동안 그룹 밖 자손을 모은다. 리더가 끝나면 자손은 init 으로 넘어가 부모 관계로는
 * 더 찾을 수 없으므로 리더가 살아 있는 동안 계속 기록한다.
 */
function trackEscapedDescendants(child) {
  const rows = new Map();
  const pid = validPid(child?.pid);
  if (isWindows || pid === null) return { stop() {}, rows: () => [] };
  const snapshot = () => {
    // 끝난 리더의 pid 는 재사용될 수 있으니 그 뒤로는 부모 관계를 따라가지 않는다.
    if (child.exitCode !== null || child.signalCode !== null) return;
    const table = readProcessTable();
    if (!table) return;
    for (const row of escapedDescendants(pid, table)) rows.set(row.key, row);
  };
  snapshot();
  const timer = setInterval(snapshot, DESCENDANT_POLL_MS);
  return { stop: () => clearInterval(timer), rows: () => [...rows.values()] };
}

/** 기록한 자손 중 같은 프로세스(pid 와 시작 시각)로 아직 살아 있는 것들의 프로세스 그룹. */
function liveEscapedGroups(rows, excludedGroups = []) {
  if (rows.length === 0) return [];
  const table = readProcessTable();
  if (!table) return [];
  const excluded = new Set(excludedGroups);
  // 테스트 프로세스 자신의 그룹은 건드리지 않는다.
  const own = table.find((row) => row.pid === process.pid);
  if (own) excluded.add(own.pgid);
  const current = new Map(table.map((row) => [row.key, row]));
  const groups = new Set();
  for (const row of rows) {
    const live = current.get(row.key);
    if (live && !live.zombie && validPid(live.pgid) && !excluded.has(live.pgid)) groups.add(live.pgid);
  }
  return [...groups];
}

/**
 * 좀비가 아닌 구성원이 남은 그룹만 고른다. 좀비만 남은 그룹은 이미 끝났다 — 끝난 자식은 부모나
 * init 이 거둘 때까지 그룹에 남는데, 동기 종료 경로에서는 이벤트 루프가 자식을 거두지 않고
 * 컨테이너의 init 은 고아를 늦게 거두기도 해 kill(-pgid, 0) 만으로는 끝났는지 알 수 없다.
 */
function runningGroups(groups) {
  const table = readProcessTable();
  if (!table) {
    return groups.filter((pgid) => {
      try { process.kill(-pgid, 0); return true; } catch (error) { return error?.code === 'EPERM'; }
    });
  }
  const running = new Set(table.filter((row) => !row.zombie).map((row) => row.pgid));
  return groups.filter((pgid) => running.has(pgid));
}

/** terminateProcessTree 의 POSIX 옵션 — 그룹이 끝났는지를 좀비를 빼고 판단한다. */
function groupTerminateOptions(pgid, graceMs) {
  if (isWindows) return { graceMs };
  return { graceMs, pollMs: 100, processGroupAlive: () => runningGroups([pgid]).length > 0 };
}

/** 그룹 밖 자손의 그룹을 SIGTERM → 유예 → SIGKILL 로 멈추고 끝날 때까지 기다린다. */
async function stopEscapedGroups(rows, excludedGroups) {
  const groups = liveEscapedGroups(rows, excludedGroups);
  if (groups.length === 0) return true;
  console.log(`  [cleanup] 서버가 남긴 프로세스 그룹 ${groups.join(', ')} 을 멈춥니다`);
  // POSIX 의 terminateProcessTree 는 pid 를 그룹 id 로 보고 -pid 에 신호를 보낸 뒤 그룹이 빌
  // 때까지 지켜본다. 리더가 이 프로세스의 자식이 아니므로 그룹 id 만 넘긴다.
  const results = await Promise.all(groups.map((pgid) => terminateProcessTree(
    { pid: pgid },
    groupTerminateOptions(pgid, ESCAPED_GROUP_GRACE_MS),
  )));
  return results.every((result) => result === true);
}

function closeServerLog(child) {
  if (child?._logFile === undefined) return;
  try { fs.closeSync(child._logFile); } catch { /* 이미 닫힘 */ }
  child._logFile = undefined;
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function stopGroupsSync(groups, graceMs) {
  let alive = runningGroups(groups);
  for (const pgid of alive) {
    try { process.kill(-pgid, 'SIGTERM'); } catch { /* 이미 끝남 */ }
  }
  const deadline = Date.now() + graceMs;
  while (alive.length > 0 && Date.now() < deadline) {
    sleepSync(50);
    alive = runningGroups(alive);
  }
  for (const pgid of alive) {
    try { process.kill(-pgid, 'SIGKILL'); } catch { /* 이미 끝남 */ }
  }
}

/** 'exit' 에서 부른다 — 동기로만 정리할 수 있다. 아직 멈추지 않은 서버를 트리째 끝낸다. */
function stopOwnedServersSync() {
  const servers = [...ownedServers];
  ownedServers.clear();
  if (servers.length === 0) return;
  if (isWindows) {
    const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
    if (!systemRoot) return;
    const taskkill = path.win32.join(systemRoot, 'System32', 'taskkill.exe');
    for (const child of servers) {
      // 끝난 리더의 pid 는 재사용될 수 있다 — 살아 있는 리더만 트리째 끊는다.
      if (child.exitCode !== null || child.signalCode !== null || !validPid(child.pid)) continue;
      spawnSync(taskkill, ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    }
    return;
  }
  const table = readProcessTable();
  const groups = servers.map((child) => validPid(child.pid)).filter((pid) => pid !== null);
  const escaped = table ? groups.flatMap((pid) => escapedDescendants(pid, table)) : [];
  stopGroupsSync(groups, SERVER_STOP_GRACE_MS);
  stopGroupsSync(liveEscapedGroups(escaped, groups), ESCAPED_GROUP_GRACE_MS);
}

function installExitHooks() {
  if (exitHooksInstalled) return;
  exitHooksInstalled = true;
  // 'exit' 은 정상 종료, process.exit, 잡히지 않은 예외에서 모두 불린다.
  process.on('exit', stopOwnedServersSync);
  // 서버를 별도 그룹으로 띄웠으므로 터미널의 Ctrl-C 가 서버에 직접 닿지 않는다. 신호를 받으면
  // 'exit' 경로로 서버 트리를 정리하고 관례대로 128 + 신호 번호로 끝낸다.
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    // 서버를 띄우기 전에 스크립트가 이 신호에 단 처리기(스모크 러너처럼 서버를 멈추고 임시 폴더를
    // 지운 뒤 스스로 끝낸다)가 남아 있으면 그 정리를 끊지 않고, 유예 안에 끝내지 않을 때만 끝낸다.
    // 맨 앞에서 받아야 한 번만 받는(once) 처리기가 아직 목록에 있다.
    const scriptHandlers = new Set(process.listeners(signal));
    process.prependListener(signal, () => {
      const code = 128 + (os.constants.signals[signal] ?? 0);
      if (process.listeners(signal).some((listener) => scriptHandlers.has(listener))) {
        setTimeout(() => process.exit(code), SIGNAL_CLEANUP_GRACE_MS).unref();
        return;
      }
      console.error(`\n  [cleanup] ${signal}: 띄운 서버를 정리하고 종료합니다`);
      process.exit(code);
    });
  }
}

/**
 * 서버(허브·Vite 등)를 띄우고 출력을 로그 파일로 보낸다. 자식은 자기 프로세스 그룹의 리더가 되어
 * stopServer 와 테스트 프로세스의 종료 경로가 래퍼 아래 트리까지 함께 멈춘다.
 */
export function spawnLogged(cmd, args, cwd, extraEnv, logPath, { dropEnv = () => false } = {}) {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const logFile = fs.openSync(logPath, 'w');
  const env = { ...process.env, ...extraEnv };
  for (const key of Object.keys(env)) if (dropEnv(key)) delete env[key];
  // Windows 의 .cmd 는 셸 없이 띄우면 EINVAL 이다 (CVE-2024-27980 이후 Node 정책). 인자는
  // 포트·호스트 같은 고정 값뿐이라 셸 이스케이프 문제가 없다.
  const needsShell = isWindows && /\.(cmd|bat)$/i.test(cmd);
  installExitHooks();
  const child = spawn(needsShell ? `"${cmd}"` : cmd, args, {
    cwd,
    stdio: ['ignore', logFile, logFile],
    env,
    shell: needsShell,
    ...processTreeSpawnOptions(),
  });
  child._logFile = logFile;
  ownedServers.add(child);
  return child;
}

/**
 * 서버를 프로세스 트리째 멈추고 끝날 때까지 기다린다 (POSIX 는 그룹에 SIGTERM → 유예 → SIGKILL,
 * Windows 는 taskkill /T). 리더가 먼저 끝났어도 그룹에 남은 프로세스를 정리하고, 서버가 그룹
 * 밖으로 띄운 자손도 기다려 멈춘다. 여러 번 불러도 된다.
 * @returns {Promise<boolean>} 트리가 모두 끝난 것을 확인했으면 true
 */
export async function stopServer(child, { graceMs = SERVER_STOP_GRACE_MS } = {}) {
  if (!child) return true;
  const escaped = trackEscapedDescendants(child);
  let stopped = false;
  try {
    stopped = await terminateAndWaitForProcessTreeExit(child, {
      timeoutMs: graceMs + 2_000,
      terminateOptions: validPid(child.pid) ? groupTerminateOptions(child.pid, graceMs) : { graceMs },
    });
  } finally {
    escaped.stop();
  }
  const escapedStopped = await stopEscapedGroups(escaped.rows(), [validPid(child.pid)]);
  if (stopped) ownedServers.delete(child);
  closeServerLog(child);
  if (!stopped || !escapedStopped) {
    console.warn(`  [cleanup] pid ${child.pid} 의 프로세스 트리가 끝난 것을 확인하지 못했습니다`);
  }
  return stopped && escapedStopped;
}

/**
 * 임시 디렉터리를 지운다. 막 끝난 자손이 쓰던 디렉터리는 한동안 ENOTEMPTY/EBUSY 로 실패할 수
 * 있어 다시 시도하고, 그래도 실패하면 경고만 남긴다 — 정리 실패가 테스트 결과를 덮지 않는다.
 */
export function removeTempDir(dir) {
  if (!dir) return;
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch (error) {
    console.warn(`  [cleanup] ${dir} 를 지우지 못했습니다: ${error.message}`);
  }
}

/**
 * 외부 계정 없이 턴을 여는 가짜 pi CLI 를 fixtureRoot/pi 에 만든다.
 * finishTurnPath 파일이 생기면 턴을 정착시킨다 (agent_settled).
 */
export function writeFakePi(fixtureRoot) {
  const piRoot = path.join(fixtureRoot, 'pi');
  const packageDir = path.join(piRoot, 'prefix/node_modules/@earendil-works/pi-coding-agent');
  fs.mkdirSync(packageDir, { recursive: true });
  fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({ version: '0.0.0-test' }));
  fs.writeFileSync(path.join(piRoot, 'config.json'), JSON.stringify({
    version: 1, installedVersion: '0.0.0-test', defaultModelId: 'mock-model',
    models: [{ id: 'mock-model', name: 'Mock model', reasoning: false, supportsImages: true,
      efforts: [], defaultEffort: null, contextLength: 8192, pricing: { prompt: 0, completion: 0 } }],
  }));
  fs.mkdirSync(path.join(piRoot, 'agent'), { recursive: true });
  fs.writeFileSync(path.join(piRoot, 'agent/models.json'), JSON.stringify({
    providers: { openrouter: { apiKey: 'test-placeholder-key' } },
  }));
  const finishTurnPath = path.join(fixtureRoot, 'finish-turn');
  writeFakeCliBin(path.join(piRoot, 'prefix/node_modules/.bin'), 'pi', `
  if (process.argv.includes('--version')) { console.log('0.0.0-test'); process.exit(0); }
  const fs = require('node:fs');
  const timer = setInterval(() => {
    if (!fs.existsSync(${JSON.stringify(finishTurnPath)})) return;
    clearInterval(timer);
    console.log(JSON.stringify({ type: 'agent_settled' }));
  }, 25);
`);
  return { piRoot, finishTurnPath };
}

/** 준비되기를 기다린다. 준비되지 못하면 호출자가 받지 못한 서버를 여기서 멈춘다. */
async function waitForServer(child, url, label) {
  try {
    await waitForHttp(url, label, child);
  } catch (error) {
    await stopServer(child);
    throw error;
  }
}

/** 허브를 띄우고 /healthz 까지 기다린다. env 는 허브 프로세스 환경에 덧붙는다. */
export async function startHub({ hubPort, token, fixtureRoot, env = {}, logName = 'rhwp-agent-bench-hub.log', dropEnv }) {
  const hub = spawnLogged(
    process.execPath,
    [path.join(repoRoot, 'rhwp-agent', 'server.mjs')],
    path.join(repoRoot, 'rhwp-agent'),
    {
      NODE_ENV: 'test', RHWP_AGENT_MODE: 'development', RHWP_SECRET_BROKER: '',
      RHWP_AGENT_PORT: String(hubPort), RHWP_AGENT_TOKEN: token,
      RHWP_WORK_DIR: fixtureRoot,
      RHWP_AGENT_INSTRUCTIONS_DIR: path.join(fixtureRoot, 'instructions'),
      RHWP_TEMPLATES_DIR: path.join(fixtureRoot, 'templates'),
      ...env,
    },
    path.join(repoRoot, 'target', logName),
    { dropEnv },
  );
  await waitForServer(hub, `http://127.0.0.1:${hubPort}/healthz?token=${encodeURIComponent(token)}`, 'rhwp-agent 허브');
  return hub;
}

/** 외부 허브에 붙는 vite 개발 서버를 띄운다. */
export async function startVite({ vitePort, hubPort, token, logName = 'rhwp-studio-bench-vite.log' }) {
  const vite = spawnLogged(
    npmCmd,
    ['run', 'dev', '--', '--host', '127.0.0.1', '--port', String(vitePort), '--strictPort'],
    studioRoot,
    {
      BROWSER: 'none',
      VITE_RHWP_AGENT_URL: `ws://127.0.0.1:${hubPort}`,
      RHWP_AGENT_TOKEN: token,
    },
    path.join(repoRoot, 'target', logName),
  );
  await waitForServer(vite, `http://127.0.0.1:${vitePort}`, 'vite dev server');
  return vite;
}

/** helpers.mjs 는 로드 시점에 CHROME_PATH/VITE_URL 을 고정하므로 import 전에 부른다. */
export function ensureChromePath() {
  if (!process.env.CHROME_PATH && !process.env.PUPPETEER_EXECUTABLE_PATH) {
    const macChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    if (fs.existsSync(macChrome)) process.env.CHROME_PATH = macChrome;
  }
}

/** /samples 의 문서를 연다 (사용자가 파일을 여는 것과 같은 open-document-bytes 경로). */
export async function openSample(page, name) {
  await page.evaluate(async (fileName) => {
    const response = await fetch(`/samples/${encodeURIComponent(fileName)}`);
    if (!response.ok) throw new Error(`Sample load failed: ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const requestId = `bench-${Date.now()}`;
    await new Promise((resolve, reject) => {
      const off = window.__eventBus.on('open-document-bytes:done', (payload) => {
        if (payload?.requestId !== requestId) return;
        off();
        if (payload.ok) resolve(); else reject(new Error(payload.error || 'open failed'));
      });
      window.__eventBus.emit('open-document-bytes', {
        bytes, fileName, requestId, suppressDialogs: true, skipUnsavedGuard: true,
      });
    });
  }, name);
  await page.waitForFunction(() => window.__wasm?.pageCount > 0
    && document.querySelector('#scroll-content canvas')
    && window.__versionController?.getState().enabled);
}

/**
 * 문서를 바꾸면 사이드바가 그 문서의 스레드로 옮겨 기본 프로바이더를 띄울 수 있다 —
 * 원하는 채팅인지 확인하고 아니면 새로 연다. 기본은 가짜 pi, 전체 접근(턴 끝 자동 커밋).
 */
export async function ensureChat(page, { agent = 'pi', model = 'mock-model', effort = null, permission = 'unrestricted' } = {}) {
  await delay(300);
  const active = await page.evaluate(() => window.__agentBridge.getActiveAgent());
  if (active === agent) return;
  await page.evaluate((a, m, e, p) => window.__agentBridge.startChat(a, m, e, false, p, 'direct'), agent, model, effort, permission);
  await page.waitForFunction((a) => window.__agentBridge?.getActiveAgent?.() === a, { timeout: 30000 }, agent);
}

export function stats(samples) {
  if (samples.length === 0) return { n: 0 };
  const sorted = [...samples].sort((a, b) => a - b);
  const pick = (q) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  const r = (v) => Math.round(v * 100) / 100;
  return {
    n: samples.length,
    mean: r(mean),
    p50: r(pick(0.5)),
    p95: r(pick(0.95)),
    max: r(sorted[sorted.length - 1]),
  };
}
