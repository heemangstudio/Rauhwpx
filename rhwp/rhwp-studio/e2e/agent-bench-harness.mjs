/**
 * 에이전트 벤치 공용 하니스 — 실제 허브 + vite 스튜디오 + 가짜 pi 프로바이더 턴.
 *
 * agent-tool-bench.mjs, agent-tool-concurrency-bench.mjs, agent-claude-live-bench.mjs 가 같이 쓴다.
 * 모델/추론 없이 프로덕션 도구 경로(허브 → 브리지 → 실행기 → wasm)를 구동한다.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { writeFakeCliBin } from '../../rhwp-agent/tests/fake-cli-bin.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const studioRoot = path.resolve(__dirname, '..');
export const repoRoot = path.resolve(studioRoot, '..');
const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';

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

export function spawnLogged(cmd, args, cwd, extraEnv, logPath, { dropEnv = () => false } = {}) {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const logFile = fs.openSync(logPath, 'w');
  const env = { ...process.env, ...extraEnv };
  for (const key of Object.keys(env)) if (dropEnv(key)) delete env[key];
  const child = spawn(cmd, args, {
    cwd,
    stdio: ['ignore', logFile, logFile],
    env,
  });
  child._logFile = logFile;
  return child;
}

export async function stopServer(child) {
  if (!child || child.exitCode !== null || child.signalCode) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  await Promise.race([
    exited,
    delay(5000).then(() => {
      if (child.exitCode === null && !child.signalCode) child.kill('SIGKILL');
    }),
  ]);
  if (child._logFile !== undefined) fs.closeSync(child._logFile);
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
      // 참고 자료·프로젝트는 부팅 때 옮겨 쓰인다 — 앱 데이터 대신 늘 고정 폴더 안에 둔다.
      RHWP_REFERENCES_DIR: path.join(fixtureRoot, 'references'),
      RHWP_PROJECTS_DIR: path.join(fixtureRoot, 'projects'),
      ...env,
    },
    path.join(repoRoot, 'target', logName),
    { dropEnv },
  );
  await waitForHttp(`http://127.0.0.1:${hubPort}/healthz?token=${encodeURIComponent(token)}`, 'rhwp-agent 허브', hub);
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
  await waitForHttp(`http://127.0.0.1:${vitePort}`, 'vite dev server', vite);
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
