/**
 * 실측: 실제 claude CLI 를 제품 경로로 돌려 도구 호출 지연과 병렬 실행을 잰다.
 *
 *   사이드바 입력창 → 브리지 → 허브 → claude(Agent SDK) → mcp-stdio → 허브 → 스튜디오 → wasm
 *
 * 허브는 RHWP_TOOL_TRACE=1 로 띄운다. 추적 행에서 턴마다 도구 호출 수, 호출별 지연,
 * 모델이 한 메시지에 낸 병렬 호출 묶음과 그 묶음이 실제로 겹쳐 실행됐는지를 뽑는다.
 * 모델 호출이 실제로 나가므로 계정 사용량이 든다.
 *
 * 실행: node e2e/agent-claude-live-bench.mjs --mode=headless [--runs=3] [--model=claude-sonnet-5]
 *        [--effort=<low|medium|high>] [--sample=biz_plan.hwp] [--prompt="..."] [--out=<json>]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { readToolTelemetryRows } from '../../rhwp-agent/tool-telemetry.mjs';
import {
  ensureChromePath,
  findAvailablePort,
  openSample,
  startHub,
  startVite,
  stats,
  stopServer,
} from './agent-bench-harness.mjs';
import { analyzeProviderTurn, readTraceRows, round } from './tool-trace-analysis.mjs';

const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? null;
const HUB_TOKEN = `live-${process.pid}`;
const RUNS = Number(arg('runs') ?? 3);
const MODEL = arg('model') ?? 'claude-sonnet-5';
const EFFORT = arg('effort');
const SAMPLE = arg('sample') ?? 'biz_plan.hwp';
const PROMPT = arg('prompt') ?? 'Read the first 3 pages, then fix every typo and make the section titles bold.';
const OUT = arg('out');
const TURN_TIMEOUT_MS = Number(arg('timeout-ms') ?? 15 * 60_000);

ensureChromePath();
const hubPort = await findAvailablePort(Number(process.env.RHWP_AGENT_PORT || '5781'));
const vitePort = await findAvailablePort(Number(process.env.VITE_PORT || '7781'));
console.log('=== LIVE: 실제 claude 도구 호출 지연·병렬 ===\n');
console.log(`  [setup] 허브=${hubPort} vite=${vitePort} model=${MODEL} effort=${EFFORT ?? '(기본)'} runs=${RUNS} sample=${SAMPLE}`);
console.log(`  [setup] prompt: ${PROMPT}`);

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rhwp-claude-live-'));
const traceFile = path.join(fixtureRoot, 'tool-trace.jsonl');
// 이 세션을 띄운 Claude Code 의 환경 변수가 허브 → claude 자식에 새지 않게 뺀다.
const dropEnv = (key) => key === 'CLAUDECODE' || key.startsWith('CLAUDE_CODE_') || key === 'CLAUDE_PID'
  || key === 'CLAUDE_EFFORT' || key === 'CLAUDE_AGENT_SDK_VERSION';
const hub = await startHub({
  hubPort, token: HUB_TOKEN, fixtureRoot, dropEnv,
  env: {
    RHWP_TOOL_TRACE: '1',
    RHWP_TOOL_TRACE_FILE: traceFile,
    // 사용자 앱 상태(관리형 CLI·Pi 설정)를 건드리지 않는다. 자격 증명은 호스트 ~/.claude 또는 Keychain 에서 읽는다.
    RHWP_CLI_DIR: path.join(fixtureRoot, 'cli'),
    RHWP_PI_DIR: path.join(fixtureRoot, 'pi'),
  },
  logName: 'rhwp-agent-claude-live-hub.log',
});
const vite = await startVite({ vitePort, hubPort, token: HUB_TOKEN, logName: 'rhwp-studio-claude-live-vite.log' });
process.env.VITE_URL = `http://127.0.0.1:${vitePort}`;
const { runTest } = await import('./helpers.mjs');

let failed = false;
const runs = [];

async function sendThroughComposer(page, text) {
  // 사용자가 하는 것처럼 사이드바 입력창에 치고 Enter. 입력창이 안 보이면 브리지로 보낸다.
  const visible = await page.evaluate(() => {
    const input = document.querySelector('#agent-sidebar textarea.ag-input');
    if (!(input instanceof HTMLTextAreaElement)) return false;
    const rect = input.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && !input.disabled;
  });
  if (visible) {
    await page.focus('#agent-sidebar textarea.ag-input');
    await page.evaluate((value) => {
      const input = document.querySelector('#agent-sidebar textarea.ag-input');
      input.value = value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }, text);
    await page.keyboard.press('Enter');
    return 'composer';
  }
  await page.evaluate((value) => { void window.__agentBridge.sendUserMessage(value); }, text);
  return 'bridge';
}

try {
  await runTest('실제 claude 도구 호출 실측', async ({ page }) => {
    await page.waitForFunction(() => window.__agentBridge?.getConnectionState?.() === 'connected', { timeout: 30000 });
    // 브리지 이벤트를 epoch 시각과 함께 모은다 (턴 시작/끝, 도구 실행 알림).
    await page.evaluate(() => {
      const now = () => performance.timeOrigin + performance.now();
      window.__liveEvents = [];
      window.__agentBridge.onEvent((event) => {
        if (event.type === 'agent' && ['turn-start', 'turn-end', 'error'].includes(event.event.type)) {
          window.__liveEvents.push({ t: now(), type: event.event.type, status: event.event.status ?? null, message: event.event.message ?? null });
        } else if (event.type === 'connection' || event.type === 'connection-state') {
          window.__liveEvents.push({ t: now(), type: 'connection', state: event.state ?? null });
        } else if (event.type === 'tool-executed') {
          window.__liveEvents.push({ t: now(), type: 'tool-executed', tool: event.tool, ok: event.ok });
        }
      });
    });

    for (let run = 1; run <= RUNS; run += 1) {
      await openSample(page, SAMPLE);
      await delay(300);
      await page.evaluate((model, effort) => window.__agentBridge.startChat('claude', model, effort ?? undefined, true, 'unrestricted', 'direct'), MODEL, EFFORT);
      await page.waitForFunction(() => window.__agentBridge?.getActiveAgent?.() === 'claude', { timeout: 60000 });
      await delay(500);
      await page.evaluate(() => { window.__liveEvents.length = 0; });
      const sentAt = await page.evaluate(() => performance.timeOrigin + performance.now());
      const via = await sendThroughComposer(page, PROMPT);
      // 턴 끝은 허브 추적 행으로 판정한다 — 페이지가 다시 연결되거나 새로고침돼도 놓치지 않는다.
      const deadline = Date.now() + TURN_TIMEOUT_MS;
      let turnEndRow = null;
      while (!turnEndRow && Date.now() < deadline) {
        await delay(500);
        turnEndRow = readTraceRows(traceFile).find((row) => row.kind === 'provider' && row.ev === 'turn-end' && row.t > sentAt) ?? null;
      }
      if (!turnEndRow) throw new Error(`turn did not end within ${TURN_TIMEOUT_MS}ms`);
      const endedAt = turnEndRow.t;
      await delay(1500); // 추적 스트림·텔레메트리 기록 대기
      const events = await page.evaluate(() => window.__liveEvents?.slice() ?? []);
      const telemetry = (await readToolTelemetryRows(fixtureRoot)).at(-1) ?? null;
      const analysis = analyzeProviderTurn(readTraceRows(traceFile), { from: sentAt, to: endedAt + 1000 });
      const row = {
        run,
        via,
        studioReconnects: events.filter((event) => event.type === 'connection').length,
        pageTurnWallMs: round(endedAt - sentAt),
        ...analysis,
        telemetry: telemetry ? { toolCalls: telemetry.toolCalls, toolMs: telemetry.toolMs, errors: telemetry.errors, resultChars: telemetry.resultChars } : null,
        errors: events.filter((event) => event.type === 'error').map((event) => event.message),
      };
      runs.push(row);
      console.log(`  [run ${run}] via=${via} wall=${round(row.pageTurnWallMs / 1000, 1)}s  model requests=${row.modelRequests}  tool calls=${row.toolCalls} (rhwp ${row.rhwpToolCalls})  parallel batches=${row.parallelBatches} (${row.parallelCalls} calls, largest ${row.largestBatch})  tool union=${round(row.toolUnionMs / 1000, 2)}s  pipeline p50/p95=${row.latency.pipelineMs.p50}/${row.latency.pipelineMs.p95}ms  cli tool p50/p95=${row.latency.toolMs.p50}/${row.latency.toolMs.p95}ms`);
      for (const batch of row.batches) {
        console.log(`      batch ×${batch.size} [${batch.tools.join(', ')}] mcpOverlap=${batch.maxConcurrentMcp} cliOverlap=${batch.maxConcurrentCli} execOverlap=${batch.maxConcurrentStudioExec} makespan=${batch.makespanMs}ms sum=${batch.sumToolMs}ms`);
      }
      await page.waitForFunction(() => !window.__inputHandler?.isUserEditingLocked?.(), { timeout: 60000 }).catch(() => {});
    }
    printSummary();
  });
} catch (err) {
  console.error('실측 실패:', err.message || err);
  failed = true;
} finally {
  await stopServer(vite);
  await stopServer(hub);
  // 추적 원본은 남긴다 — 실행마다 다시 분석할 수 있게.
  if (runs.length > 0) {
    const keep = path.join(os.tmpdir(), `rhwp-claude-live-trace-${Date.now()}.jsonl`);
    try { fs.copyFileSync(traceFile, keep); console.log(`  [trace] ${keep}`); } catch { /* 추적 없음 */ }
  }
  fs.rmSync(fixtureRoot, { recursive: true, force: true, maxRetries: 5 });
}

function printSummary() {
  const all = runs.flatMap((row) => row.perCall);
  const pick = (key) => all.map((e) => e[key]).filter((v) => Number.isFinite(v));
  const summary = {
    model: MODEL,
    effort: EFFORT,
    prompt: PROMPT,
    sample: SAMPLE,
    runs: runs.length,
    turnWallMs: stats(runs.map((row) => row.pageTurnWallMs)),
    toolCallsPerTurn: stats(runs.map((row) => row.toolCalls)),
    parallelBatchesPerTurn: stats(runs.map((row) => row.parallelBatches)),
    pipelineMs: stats(pick('pipelineMs')),
    cliToolMs: stats(pick('toolMs')),
    cliDispatchMs: stats(pick('cliDispatchMs')),
    cliReturnMs: stats(pick('cliReturnMs')),
    studioExecMs: stats(pick('studioExecMs')),
    studioWaitMs: stats(pick('studioWaitMs')),
    toolShareOfTurn: round(runs.reduce((s, r) => s + r.toolUnionMs, 0) / Math.max(1, runs.reduce((s, r) => s + r.turnWallMs, 0)), 3),
  };
  console.log('\n  [live] 요약:', JSON.stringify(summary));
  const payload = { summary, runs };
  if (OUT) fs.writeFileSync(OUT, JSON.stringify(payload, null, 2));
  console.log(`\nCLAUDE_LIVE_RESULT: ${JSON.stringify(summary)}`);
}

process.exit(failed || process.exitCode ? 1 : 0);
