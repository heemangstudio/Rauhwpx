// 앱 전체 메모리를 단계별로 잰다: 브라우저 프로세스 전부 + 허브 프로세스 트리.
//
// 사용: node e2e/app-memory-bench.mjs --mode=headless [--runs=3] [--output=<json>]
//   [--samples=a.hwp,b.hwp,c.hwp] [--idle-env=RHWP_AGENT_IDLE_MS] [--idle-ms=30000]
//   [--settle-ms=10000] [--reap-grace-ms=10000]
//
// 실제 허브와 Vite 를 띄우고, 가짜 claude CLI 로 문서마다 에이전트 턴을 연다. 가짜 CLI 는
// 실제 CLI 처럼 --mcp-config 의 mcp-stdio 를 자식으로 띄우고 그 MCP 로 문서를 읽는다.
// 다른 문서는 에이전트가 일하는 동안에만 따로 열리므로 턴은 세 문서가 다 열릴 때까지 열어 둔다.
// 단계: app → docs-open → versioning-settled → turns-done → idle-settle → after-idle-reap.
// 메모리는 proc_pid_rusage 의 phys_footprint (footprint 도구·top MEM 과 같은 값)로 잰다.
// 페이지·워커·허브(인스펙터)는 재기 전에 GC 를 돌린다. 제목 생성이 진짜 codex 를 부르지 않게
// codex 도 가짜로 가리고, Pi 는 빈 디렉터리를 쓴다.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import {
  ensureChromePath,
  findAvailablePort,
  openSample,
  removeTempDir,
  repoRoot,
  spawnLogged,
  startVite,
  stopServer,
  waitForHttp,
} from './agent-bench-harness.mjs';

function arg(name, fallback) {
  const hit = process.argv.find((value) => value.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

const SAMPLES = arg('samples', 'kps-ai.hwp,exam_math.hwp,k-water-rfp.hwp').split(',').filter(Boolean);
const RUNS = Number(arg('runs', '3'));
const IDLE_ENV = arg('idle-env', 'RHWP_AGENT_IDLE_MS');
const IDLE_MS = Number(arg('idle-ms', '30000'));
const SETTLE_MS = Number(arg('settle-ms', '10000'));
const REAP_GRACE_MS = Number(arg('reap-grace-ms', '10000'));
const OUTPUT = arg('output', '');
const TOKEN = 'app-memory-bench';
const MiB = 1024 * 1024;
const mib = (bytes) => (bytes === null || bytes === undefined ? null : +(bytes / MiB).toFixed(1));

// ── 가짜 claude CLI ────────────────────────────────────────────
// SDK 경로(제어 요청)와 CLI 경로 모두 stream-json 으로 받는다. 메시지마다 MCP 로
// get_document_info 를 부르고, finish 파일이 생기면 턴을 정착시킨다. 턴 뒤에도 살아 있는다.
const FAKE_CLAUDE = String.raw`
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';

const argv = process.argv.slice(2);
if (argv.includes('--version') || argv.includes('-v')) {
  console.log('2.1.235 (Claude Code)');
  process.exit(0);
}
if (argv[0] && !argv[0].startsWith('-')) {
  console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }));
  process.exit(0);
}
const FINISH = process.env.RHWP_BENCH_FINISH_FILE;
const valueOf = (flag) => {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
};
const sessionId = valueOf('--session-id') ?? valueOf('--resume') ?? randomUUID();
const emit = (obj) => process.stdout.write(JSON.stringify({ session_id: sessionId, ...obj }) + '\n');

let mcp = null;
let nextId = 1;
const pending = new Map();
function rpc(method, params) {
  const id = nextId++;
  mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(method + ' timed out')); }, 60000);
    pending.set(id, { resolve, timer });
  });
}
let mcpReady = Promise.resolve();
const rawConfig = valueOf('--mcp-config');
if (rawConfig) {
  const config = JSON.parse(rawConfig.trim().startsWith('{') ? rawConfig : fs.readFileSync(rawConfig, 'utf8'));
  const server = config.mcpServers?.rhwp;
  if (server?.command) {
    mcp = spawn(server.command, server.args ?? [], {
      env: { ...process.env, ...(server.env ?? {}) },
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    createInterface({ input: mcp.stdout }).on('line', (line) => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      clearTimeout(entry.timer);
      entry.resolve(message);
    });
    mcpReady = rpc('initialize', {
      protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-code', version: '2.1.235' },
    }).then(() => {
      mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
      return rpc('tools/list', {});
    });
  }
}

const waitFinish = () => new Promise((resolve) => {
  const timer = setInterval(() => {
    if (!FINISH || fs.existsSync(FINISH)) { clearInterval(timer); resolve(); }
  }, 50);
});

let turn = 0;
async function runTurn() {
  turn += 1;
  emit({ type: 'system', subtype: 'init', model: 'bench-sonnet', tools: [], mcp_servers: [{ name: 'rhwp', status: mcp ? 'connected' : 'failed' }] });
  let resultText = 'no mcp';
  if (mcp) {
    await mcpReady;
    const toolUseId = 'toolu_bench_' + turn;
    emit({ type: 'assistant', parent_tool_use_id: null, message: { role: 'assistant', content: [
      { type: 'tool_use', id: toolUseId, name: 'mcp__rhwp__get_document_info', input: {} },
    ] } });
    const response = await rpc('tools/call', { name: 'get_document_info', arguments: {} });
    resultText = JSON.stringify(response.result?.content ?? response.error ?? null).slice(0, 2000);
    emit({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [
      { type: 'tool_result', tool_use_id: toolUseId, content: resultText },
    ] } });
  }
  emit({ type: 'assistant', parent_tool_use_id: null, message: { role: 'assistant', content: [
    { type: 'text', text: '문서 정보를 확인했습니다.' },
  ] } });
  await waitFinish();
  emit({
    type: 'result', subtype: 'success', is_error: false, stop_reason: 'end_turn', result: 'done', num_turns: 1,
    modelUsage: { 'bench-sonnet': { inputTokens: 10, outputTokens: 10, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0 } },
  });
}

let queue = Promise.resolve();
const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message?.type === 'control_request') {
    const subtype = message.request?.subtype;
    const response = subtype === 'initialize'
      ? { commands: [], agents: [], output_style: 'default', available_output_styles: ['default'], models: [], account: {} }
      : {};
    process.stdout.write(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response } }) + '\n');
    return;
  }
  if (message?.type !== 'user') return;
  queue = queue.then(runTurn).catch((error) => {
    process.stderr.write('fake claude turn failed: ' + (error?.stack ?? error) + '\n');
  });
});
const shutdown = () => { try { mcp?.kill('SIGTERM'); } catch {} process.exit(0); };
rl.on('close', () => setTimeout(shutdown, 500));
process.on('SIGTERM', shutdown);
setInterval(() => { if (process.ppid === 1) shutdown(); }, 1000).unref?.();
`;

function prepareFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rhwp-app-memory-'));
  const binDir = path.join(root, 'bin');
  const cliDir = path.join(root, 'cli');
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(cliDir, { recursive: true });
  const script = path.join(root, 'fake-claude.mjs');
  fs.writeFileSync(script, FAKE_CLAUDE);
  const finishFile = path.join(root, 'finish-turn');
  fs.writeFileSync(
    path.join(binDir, 'claude'),
    `#!/bin/sh\nRHWP_BENCH_FINISH_FILE="${finishFile}" exec "${process.execPath}" "${script}" "$@"\n`,
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(binDir, 'codex'),
    '#!/bin/sh\ncase "$1" in --version) echo "codex-cli 0.0.0-bench"; exit 0;; esac\nexit 1\n',
    { mode: 0o755 },
  );
  const piDir = path.join(root, 'pi');
  fs.mkdirSync(piDir, { recursive: true });
  return { root, binDir, cliDir, piDir, script, finishFile };
}

// ── 프로세스 메모리 ───────────────────────────────────────────

const RUSAGE_PY = `
import ctypes, json, sys
lib = ctypes.CDLL('/usr/lib/libproc.dylib')
buf = ctypes.create_string_buffer(512)
out = {}
for pid in sys.argv[1:]:
    if lib.proc_pid_rusage(int(pid), 2, buf) == 0:
        out[pid] = int.from_bytes(buf.raw[72:80], 'little')
print(json.dumps(out))
`;

/** pid → phys_footprint 바이트. 이미 끝난 프로세스는 빠진다. */
function footprints(pids) {
  if (pids.length === 0) return new Map();
  const out = execFileSync('python3', ['-c', RUSAGE_PY, ...pids.map(String)], { encoding: 'utf8' });
  return new Map(Object.entries(JSON.parse(out)).map(([pid, bytes]) => [Number(pid), bytes]));
}

function processTable() {
  const out = execFileSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8', maxBuffer: 32 * MiB });
  return out.split('\n').map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)).filter(Boolean)
    .map(([, pid, ppid, command]) => ({ pid: Number(pid), ppid: Number(ppid), command }));
}

function descendants(table, rootPid) {
  const found = [];
  const queue = [rootPid];
  while (queue.length > 0) {
    const pid = queue.shift();
    for (const entry of table) {
      if (entry.ppid === pid) {
        found.push(entry);
        queue.push(entry.pid);
      }
    }
  }
  return found;
}

function hubKind(entry, fakeScript) {
  // 공급자 argv 의 --mcp-config 에도 mcp-stdio.mjs 경로가 들어 있어 공급자를 먼저 가른다.
  if (entry.command.includes(fakeScript)) return 'provider';
  if (entry.command.includes('mcp-stdio.mjs')) return 'mcpStdio';
  return 'other';
}

// ── 허브 ──────────────────────────────────────────────────────

/** agent-bench-harness 의 startHub 와 같은 환경에 인스펙터만 더해 띄운다. */
async function launchHub(hubPort, fixture, runIndex) {
  const logPath = path.join(repoRoot, 'target', `app-memory-bench-hub-${runIndex}.log`);
  const hub = spawnLogged(
    process.execPath,
    ['--inspect=127.0.0.1:0', path.join(repoRoot, 'rhwp-agent', 'server.mjs')],
    path.join(repoRoot, 'rhwp-agent'),
    {
      NODE_ENV: 'test', RHWP_AGENT_MODE: 'development', RHWP_SECRET_BROKER: '',
      RHWP_AGENT_PORT: String(hubPort), RHWP_AGENT_TOKEN: TOKEN,
      RHWP_WORK_DIR: fixture.root,
      RHWP_AGENT_INSTRUCTIONS_DIR: path.join(fixture.root, 'instructions'),
      RHWP_TEMPLATES_DIR: path.join(fixture.root, 'templates'),
      RHWP_CLI_DIR: fixture.cliDir,
      RHWP_PI_DIR: fixture.piDir,
      PATH: `${fixture.binDir}${path.delimiter}${process.env.PATH ?? ''}`,
      [IDLE_ENV]: String(IDLE_MS),
    },
    logPath,
  );
  await waitForHttp(`http://127.0.0.1:${hubPort}/healthz?token=${TOKEN}`, 'rhwp-agent 허브', hub);
  const url = fs.readFileSync(logPath, 'utf8').match(/Debugger listening on (ws:\/\/\S+)/)?.[1];
  hub.inspector = url ? await connectInspector(url) : null;
  return hub;
}

async function connectInspector(url) {
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  let nextId = 1;
  const pending = new Map();
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data));
    pending.get(message.id)?.(message.result);
    pending.delete(message.id);
  });
  return {
    send(method, params = {}) {
      const id = nextId++;
      ws.send(JSON.stringify({ id, method, params }));
      return new Promise((resolve) => pending.set(id, resolve));
    },
    close: () => ws.close(),
  };
}

// ── 측정 ──────────────────────────────────────────────────────

async function browserProcesses(browser) {
  const session = await browser.target().createCDPSession();
  try {
    const { processInfo } = await session.send('SystemInfo.getProcessInfo');
    return processInfo.map((info) => ({ pid: info.id, type: info.type }));
  } finally {
    await session.detach().catch(() => {});
  }
}

async function workerStats(page) {
  const workers = page.workers();
  let heapBytes = 0;
  for (const worker of workers) {
    try {
      await worker.client.send('HeapProfiler.collectGarbage');
      const { usedSize } = await worker.client.send('Runtime.getHeapUsage');
      heapBytes += usedSize;
    } catch {}
  }
  return { count: workers.length, heapBytes, urls: workers.map((worker) => worker.url().replace(/^.*\//, '').slice(0, 60)) };
}

async function measure(ctx, label) {
  const { browser, page, cdp, hub, fixture } = ctx;
  await cdp.send('HeapProfiler.collectGarbage');
  const workers = await workerStats(page);
  await hub.inspector?.send('HeapProfiler.collectGarbage');
  const hubHeap = await hub.inspector?.send('Runtime.getHeapUsage');
  await delay(500);

  const table = processTable();
  const chromeProcs = await browserProcesses(browser);
  const browserPid = browser.process()?.pid;
  const chromeTree = browserPid ? descendants(table, browserPid).map((entry) => entry.pid) : [];
  const chromePids = [...new Set([...chromeProcs.map((entry) => entry.pid), ...(browserPid ? [browserPid] : []), ...chromeTree])];
  const hubTree = [{ pid: hub.pid, command: 'hub' }, ...descendants(table, hub.pid)];
  const bytes = footprints([...chromePids, ...hubTree.map((entry) => entry.pid)]);

  const byType = {};
  for (const entry of chromeProcs) {
    byType[entry.type] = (byType[entry.type] ?? 0) + (bytes.get(entry.pid) ?? 0);
  }
  const renderers = chromeProcs.filter((entry) => entry.type === 'renderer')
    .map((entry) => bytes.get(entry.pid) ?? 0);
  const browserAll = chromePids.reduce((sum, pid) => sum + (bytes.get(pid) ?? 0), 0);

  const hubKinds = { provider: { n: 0, bytes: 0 }, mcpStdio: { n: 0, bytes: 0 }, other: { n: 0, bytes: 0 } };
  for (const entry of hubTree.slice(1)) {
    const kind = hubKinds[hubKind(entry, fixture.script)];
    kind.n += 1;
    kind.bytes += bytes.get(entry.pid) ?? 0;
  }
  const hubSelf = bytes.get(hub.pid) ?? 0;
  const hubTreeBytes = hubTree.reduce((sum, entry) => sum + (bytes.get(entry.pid) ?? 0), 0);

  const { metrics } = await cdp.send('Performance.getMetrics');
  const metric = (name) => metrics.find((entry) => entry.name === name)?.value ?? 0;
  const inPage = await page.evaluate(() => {
    const sessions = window.__documentSessions?.list?.() ?? [];
    const canvases = [...document.querySelectorAll('canvas')].filter((canvas) => canvas.width > 0 && canvas.height > 0);
    return {
      wasmBytes: window.__wasmMemory?.buffer?.byteLength ?? null,
      domCanvases: canvases.length,
      domCanvasBytes: canvases.reduce((sum, canvas) => sum + canvas.width * canvas.height * 4, 0),
      sessions: sessions.length,
      chats: sessions.reduce((sum, session) => sum + session.chats.length, 0),
      busyChats: sessions.reduce((sum, session) => sum + session.chats.filter((chat) => chat.bridge.isBusy()).length, 0),
      files: sessions.map((session) => session.wasm.fileName),
    };
  });

  const row = {
    label,
    rendererMiB: mib(Math.max(0, ...renderers)),
    jsHeapMiB: mib(metric('JSHeapUsedSize')),
    wasmMiB: mib(inPage.wasmBytes),
    workers: workers.count,
    workerHeapMiB: mib(workers.heapBytes),
    gpuMiB: mib(byType.GPU ?? byType.gpu ?? 0),
    utilityMiB: mib(byType.utility ?? 0),
    browserMainMiB: mib(byType.browser ?? 0),
    browserAllMiB: mib(browserAll),
    browserProcs: chromePids.length,
    hubMiB: mib(hubSelf),
    hubHeapMiB: mib(hubHeap?.usedSize ?? null),
    providers: hubKinds.provider.n,
    providerMiB: mib(hubKinds.provider.bytes),
    mcpStdio: hubKinds.mcpStdio.n,
    mcpStdioMiB: mib(hubKinds.mcpStdio.bytes),
    hubOtherProcs: hubKinds.other.n,
    hubTreeMiB: mib(hubTreeBytes),
    totalMiB: mib(browserAll + hubTreeBytes),
    sessions: inPage.sessions,
    chats: inPage.chats,
    busyChats: inPage.busyChats,
    domNodes: metric('Nodes'),
    domCanvases: inPage.domCanvases,
    domCanvasMiB: mib(inPage.domCanvasBytes),
    workerUrls: workers.urls,
  };
  console.log(JSON.stringify(row));
  return row;
}

// ── 시나리오 ──────────────────────────────────────────────────

async function startTurn(page, index) {
  await page.evaluate((threadId) => {
    const session = window.__documentSessions.attached();
    const bridge = session.activeChat.bridge;
    bridge.startChat('claude', 'sonnet', 'high', false, 'safe', 'direct', threadId, session.documentId, session.wasm.fileName);
    void bridge.sendUserMessage('이 문서를 훑어보고 구성을 알려 주세요.');
  }, `app-memory-bench-${index}-${Date.now()}`);
  await page.waitForFunction(() => window.__documentSessions.attached().activeChat.bridge.isTurnRunning(), { timeout: 30_000 });
}

async function runOnce(runIndex, shared) {
  const fixture = prepareFixture();
  const hub = await launchHub(shared.hubPort, fixture, runIndex);
  const browser = await shared.launchBrowser();
  const rows = [];
  try {
    const page = await browser.newPage();
    // puppeteer 가 켜 둔 Network 도메인은 응답 본문(Vite 모듈, 허브 글꼴)을 렌더러에 붙잡아
    // 110–170 MiB 를 부풀린다.
    await page._client().send('Network.disable');
    await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 });
    await page.evaluateOnNewDocument(() => {
      const capture = (result) => {
        const instance = result?.instance ?? result;
        const memory = instance?.exports?.memory;
        if (memory instanceof WebAssembly.Memory && !window.__wasmMemory) window.__wasmMemory = memory;
        return result;
      };
      const streaming = WebAssembly.instantiateStreaming;
      if (streaming) WebAssembly.instantiateStreaming = (...args) => streaming(...args).then(capture);
      const instantiate = WebAssembly.instantiate;
      WebAssembly.instantiate = (...args) => instantiate(...args).then(capture);
    });
    page.on('pageerror', (error) => console.log(`  [browser:pageerror] ${error.message}`));
    const cdp = await page.createCDPSession();
    await cdp.send('Performance.enable');
    const ctx = { browser, page, cdp, hub, fixture };

    await shared.loadApp(page);
    await page.waitForFunction(() => window.__agentBridge?.getConnectionState?.() === 'connected', { timeout: 30_000 });
    await delay(2000);
    rows.push(await measure(ctx, 'app'));

    for (const [index, sample] of SAMPLES.entries()) {
      await openSample(page, sample);
      await page.waitForFunction((count) => window.__documentSessions.list().length === count, { timeout: 20_000 }, index + 1);
      await startTurn(page, index);
    }
    await delay(3000);
    rows.push(await measure(ctx, 'docs-open'));

    await page.evaluate(() => Promise.all(window.__documentSessions.list().map((session) => session.versions?.whenIdle())));
    await delay(SETTLE_MS);
    await page.evaluate(() => Promise.all(window.__documentSessions.list().map((session) => session.versions?.whenIdle())));
    rows.push(await measure(ctx, 'versioning-settled'));

    fs.writeFileSync(fixture.finishFile, '');
    await page.waitForFunction(() => window.__documentSessions.list()
      .every((session) => session.chats.every((chat) => !chat.bridge.isBusy())), { timeout: 60_000 });
    const turnsDoneAt = Date.now();
    await delay(2000);
    rows.push(await measure(ctx, 'turns-done'));

    await delay(Math.max(0, turnsDoneAt + SETTLE_MS - Date.now()));
    rows.push(await measure(ctx, 'idle-settle'));

    // 프로바이더 정리와 30 s 유휴 정리(병합 워커, 스냅샷 캐시)가 모두 지난 같은 시점에 잰다.
    await delay(Math.max(0, turnsDoneAt + IDLE_MS + REAP_GRACE_MS - Date.now()));
    const reapRow = await measure(ctx, 'after-idle-reap');
    reapRow.reapedAfterMs = Date.now() - turnsDoneAt;
    rows.push(reapRow);
  } finally {
    await shared.closeBrowser(browser);
    hub.inspector?.close();
    await stopServer(hub);
    removeTempDir(fixture.root);
  }
  return rows;
}

const SUMMARY_KEYS = [
  'rendererMiB', 'jsHeapMiB', 'wasmMiB', 'domCanvasMiB', 'workers', 'workerHeapMiB', 'gpuMiB', 'browserAllMiB',
  'hubMiB', 'hubHeapMiB', 'providers', 'providerMiB', 'mcpStdio', 'mcpStdioMiB', 'hubTreeMiB', 'totalMiB',
];

function summarize(runs) {
  const labels = runs[0].map((row) => row.label);
  return labels.map((label) => {
    const entry = { label };
    for (const key of SUMMARY_KEYS) {
      const values = runs.map((rows) => rows.find((row) => row.label === label)?.[key])
        .filter((value) => typeof value === 'number').sort((a, b) => a - b);
      if (values.length === 0) continue;
      const median = values.length % 2
        ? values[(values.length - 1) / 2]
        : (values[values.length / 2 - 1] + values[values.length / 2]) / 2;
      entry[key] = { median: +median.toFixed(1), spread: +(values[values.length - 1] - values[0]).toFixed(1) };
    }
    return entry;
  });
}

ensureChromePath();
const hubPort = await findAvailablePort(Number(process.env.RHWP_AGENT_PORT || 5861));
const vitePort = await findAvailablePort(Number(process.env.VITE_PORT || 7861));
const vite = await startVite({ vitePort, hubPort, token: TOKEN, logName: 'app-memory-bench-vite.log' });
process.env.VITE_URL = `http://127.0.0.1:${vitePort}`;
const helpers = await import('./helpers.mjs');
const shared = { hubPort, launchBrowser: helpers.launchBrowser, closeBrowser: helpers.closeBrowser, loadApp: helpers.loadApp };

const runs = [];
try {
  for (let run = 0; run < RUNS; run += 1) {
    console.log(`# run ${run + 1}/${RUNS}`);
    runs.push(await runOnce(run, shared));
  }
} finally {
  await stopServer(vite);
}

const summary = summarize(runs);
for (const entry of summary) {
  const cells = SUMMARY_KEYS.filter((key) => entry[key])
    .map((key) => `${key}=${entry[key].median}±${entry[key].spread}`);
  console.log(`${entry.label.padEnd(20)} ${cells.join(' ')}`);
}
if (OUTPUT) {
  fs.mkdirSync(path.dirname(path.resolve(OUTPUT)), { recursive: true });
  fs.writeFileSync(OUTPUT, `${JSON.stringify({
    samples: SAMPLES, idleEnv: IDLE_ENV, idleMs: IDLE_MS, settleMs: SETTLE_MS, runs, summary,
  }, null, 2)}\n`);
}
