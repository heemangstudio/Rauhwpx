/**
 * 벤치마크: 도구 호출 왕복과 병렬 호출 — 실제 경로 전체
 *   MCP 클라이언트 → mcp-stdio.mjs(stdio JSON-RPC) → WS → 허브 → WS → 스튜디오 브리지 → 실행기 → wasm → 역순
 *
 * 프로바이더 턴은 가짜 pi 로 열고(모델 시간 없음), 도구 호출은 provider CLI 처럼 실제 mcp-stdio 자식
 * 프로세스에 보낸다. 허브는 RHWP_TOOL_TRACE=1 로 띄워 호출마다 단계별 시각을 남긴다.
 *
 * 시나리오 × 동시성(1/4/8): 한 라운드에 c 개를 동시에 보내고 전부 끝나면 다음 라운드
 * (Claude Code 가 한 메시지의 병렬 tool_use 를 실행하는 방식). 시나리오마다 새 턴.
 *   read:get_structure | read:read_batch | read:find_text      — 병렬 읽기
 *   write:insert_text  | write:apply_edits                    — 같은 expectedRevision 병렬 쓰기(서로 다른 문단)
 *   mixed                                                     — 절반 읽기 + 절반 쓰기
 *
 * 실행: node bench/agent-tool-concurrency-bench.mjs --mode=headless [--calls=24] [--levels=1,4,8]
 *        [--scenario=<이름>] [--sample=biz_plan.hwp] [--profile] [--out=<json 경로>]
 * 결과: 표 + 마지막 줄 CONCURRENCY_BENCH_RESULT: {...}
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { registerHubSession } from '../../../desktop/agent-hub.mjs';
import { readToolTelemetryRows } from '../../rhwp-agent/tool-telemetry.mjs';
import {
  ensureChat,
  ensureChromePath,
  findAvailablePort,
  openSample,
  removeTempDir,
  repoRoot,
  startHub,
  startVite,
  stats,
  stopServer,
  writeFakePi,
} from '../e2e/agent-bench-harness.mjs';
import { McpStdioClient, epochNow } from './mcp-stdio-client.mjs';
import {
  callStages,
  estimateStudioSkew,
  joinCalls,
  maxOverlap,
  readTraceRows,
  round,
  summarizeStages,
  unionLength,
} from './tool-trace-analysis.mjs';

const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? null;
const HUB_TOKEN = 'bench';
const SAMPLE = arg('sample') ?? 'biz_plan.hwp';
const CALLS = Number(arg('calls') ?? 24);
const LEVELS = (arg('levels') ?? '1,4,8').split(',').map(Number).filter((n) => n > 0);
const SCENARIO_FILTER = arg('scenario');
const PROFILE = process.argv.includes('--profile');
const OUT = arg('out');
// 한 라운드의 쓰기 슬롯마다 겹치지 않는 문단 4개 — 동시성 8 × 4 = 32.
const BENCH_PARAGRAPHS = 32;
const PARAS_PER_SLOT = 4;

ensureChromePath();
const hubPort = await findAvailablePort(Number(process.env.RHWP_AGENT_PORT || '5761'));
const vitePort = await findAvailablePort(Number(process.env.VITE_PORT || '7761'));
const viteUrl = `http://127.0.0.1:${vitePort}`;
console.log('=== BENCH: 도구 호출 왕복 + 병렬 (mcp-stdio → 허브 → 스튜디오) ===\n');
console.log(`  [setup] 허브 포트=${hubPort}, vite 포트=${vitePort}, 샘플=${SAMPLE}, calls=${CALLS}, levels=${LEVELS.join('/')}`);

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rhwp-concurrency-bench-'));
const traceFile = path.join(fixtureRoot, 'tool-trace.jsonl');
const { piRoot, finishTurnPath } = writeFakePi(fixtureRoot);
const hub = await startHub({
  hubPort, token: HUB_TOKEN, fixtureRoot,
  env: { RHWP_PI_DIR: piRoot, RHWP_TOOL_TRACE: '1', RHWP_TOOL_TRACE_FILE: traceFile },
  logName: 'rhwp-agent-concurrency-bench-hub.log',
});
const vite = await startVite({ vitePort, hubPort, token: HUB_TOKEN, logName: 'rhwp-studio-concurrency-bench-vite.log' });
process.env.VITE_URL = viteUrl;
const { runTest } = await import('../e2e/helpers.mjs');

// ─── 호출 생성기 ─────────────────────────────────────────────

/** 문서에서 찾은 앵커 — 시드 뒤에 채운다. */
const doc = { benchStart: 0, paraCount: 0, findQuery: '사업' };

const READS = {
  get_structure: () => ({ tool: 'get_structure', args: {} }),
  read_batch: (i) => ({ tool: 'read_batch', args: { reads: [
    { tool: 'get_text_range', args: { sectionIdx: 0, paraIdx: (i * 3) % doc.paraCount } },
    { tool: 'get_text_range', args: { sectionIdx: 0, paraIdx: (i * 3 + 1) % doc.paraCount } },
    { tool: 'get_text_range', args: { sectionIdx: 0, paraIdx: (i * 3 + 2) % doc.paraCount } },
    { tool: 'get_para_format', args: { sectionIdx: 0, paraIdx: (i * 3) % doc.paraCount } },
  ] } }),
  find_text: () => ({ tool: 'find_text', args: { query: doc.findQuery } }),
};
// 쓰기는 라운드 안 슬롯별로 서로 다른 문단 묶음을 건드린다 — 같은 문단을 동시에 고치는 충돌은
// REVISION_MISMATCH 가 맞는 결과라, 여기서는 겹치지 않는 병렬 쓰기의 지연만 잰다.
const slotPara = (slot, k = 0) => doc.benchStart + ((slot * PARAS_PER_SLOT + k) % BENCH_PARAGRAPHS);
const WRITES = {
  insert_text: (i, revision, slot) => ({ tool: 'insert_text', args: {
    sectionIdx: 0, paraIdx: slotPara(slot), charOffset: 0, text: `w${i} `, expectedRevision: revision,
  } }),
  apply_edits: (i, revision, slot) => ({ tool: 'apply_edits', args: { expectedRevision: revision, edits: Array.from({ length: PARAS_PER_SLOT }, (_, k) => ({
    tool: 'insert_text',
    args: { sectionIdx: 0, paraIdx: slotPara(slot, k), charOffset: 0, text: `b${i}.${k} ` },
  })) } }),
};
const READ_ROTATION = ['get_structure', 'read_batch', 'find_text'];
const WRITE_ROTATION = ['insert_text', 'apply_edits'];

const SCENARIOS = [
  ...Object.keys(READS).map((tool) => ({ name: `read:${tool}`, make: (i) => READS[tool](i) })),
  ...Object.keys(WRITES).map((tool) => ({ name: `write:${tool}`, make: (i, revision, slot) => WRITES[tool](i, revision, slot) })),
  {
    name: 'mixed',
    // 라운드 안에서 짝수 슬롯은 읽기, 홀수 슬롯은 쓰기. c=1 이면 읽기·쓰기가 번갈아 온다.
    make: (i, revision, slot) => (i % 2 === 0
      ? READS[READ_ROTATION[(i / 2) % READ_ROTATION.length]](i)
      : WRITES[WRITE_ROTATION[((i - 1) / 2) % WRITE_ROTATION.length]](i, revision, slot)),
  },
];

// ─── CPU 프로파일 (선택) ────────────────────────────────────

function categorize(frame) {
  const url = frame.url ?? '';
  const fn = frame.functionName ?? '';
  if (fn === '(idle)') return 'idle';
  if (fn === '(garbage collector)') return 'gc';
  if (fn === '(program)') return 'program';
  if (url.startsWith('wasm://') || /^\$?wasm-function/.test(fn)) return 'engine (wasm)';
  if (/\/pkg\/rhwp\.js|@wasm/.test(url)) return 'wasm glue';
  if (url.includes('/src/agent/')) return 'agent (bridge/executor/pending)';
  if (url.includes('/src/view/') || url.includes('/src/core/')) return 'view/core (layout+render JS)';
  if (url.includes('/src/ui/')) return 'ui';
  if (!url) return 'native/builtin';
  return 'other js';
}

function summarizeProfile(profile) {
  const byId = new Map(profile.nodes.map((node) => [node.id, node]));
  const parentOf = new Map();
  for (const node of profile.nodes) for (const child of node.children ?? []) parentOf.set(child, node.id);
  // 이름 없는 wasm 프레임은 가장 가까운 앱 소스(src/) 호출자에게 돌린다 — 어느 경로가 엔진을 부르는지.
  // wasm-bridge.ts 는 얇은 래퍼라 그 위의 호출자까지 붙인다 ("getSelectionRects ← refresh pending-overlay.ts").
  const appCaller = (id) => {
    const names = [];
    for (let cur = parentOf.get(id); cur !== undefined && names.length < 2; cur = parentOf.get(cur)) {
      const frame = byId.get(cur)?.callFrame;
      if (!frame?.url?.includes('/src/')) continue;
      const name = `${frame.functionName || '(anonymous)'} ${path.basename(frame.url)}`;
      names.push(name);
      if (!frame.url.endsWith('wasm-bridge.ts')) break;
    }
    return names.length > 0 ? names.join(' ← ') : '(no app caller)';
  };
  const selfMs = new Map();
  for (let i = 0; i < profile.samples.length; i += 1) {
    const dt = (profile.timeDeltas[i] ?? 0) / 1000;
    selfMs.set(profile.samples[i], (selfMs.get(profile.samples[i]) ?? 0) + dt);
  }
  const categories = {};
  const functions = {};
  const engineCallers = {};
  for (const [id, ms] of selfMs) {
    const node = byId.get(id);
    if (!node) continue;
    const category = categorize(node.callFrame);
    categories[category] = (categories[category] ?? 0) + ms;
    if (category === 'engine (wasm)' || category === 'wasm glue') {
      const caller = appCaller(id);
      engineCallers[caller] = (engineCallers[caller] ?? 0) + ms;
    }
    if (category === 'idle' || category === 'program') continue;
    const key = `${node.callFrame.functionName || '(anonymous)'} ${path.basename(node.callFrame.url || '')}`;
    functions[key] = (functions[key] ?? 0) + ms;
  }
  return {
    categoriesMs: Object.fromEntries(Object.entries(categories).map(([k, v]) => [k, round(v)]).sort((a, b) => b[1] - a[1])),
    topSelfMs: Object.entries(functions).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, v]) => [k, round(v)]),
    engineByAppCallerMs: Object.entries(engineCallers).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, v]) => [k, round(v)]),
  };
}

// ─── 실행 ──────────────────────────────────────────────────

let failed = false;
const results = [];

try {
  await runTest('도구 호출 병렬 벤치마크', async ({ page }) => {
    await page.waitForFunction(() => window.__agentBridge?.getConnectionState?.() === 'connected', { timeout: 20000 });
    await openSample(page, SAMPLE);
    await ensureChat(page);
    const health = await (await fetch(`http://127.0.0.1:${hubPort}/healthz?token=${encodeURIComponent(HUB_TOKEN)}`)).json();
    const sessionId = health.sessions?.[0]?.sessionId;
    if (!sessionId) throw new Error('Studio hub session was not registered');
    const cdp = PROFILE ? await page.createCDPSession() : null;
    if (cdp) {
      await cdp.send('Profiler.enable');
      await cdp.send('Profiler.setSamplingInterval', { interval: 100 });
    }

    let telemetryRows = 0;
    const beginTurn = async () => {
      await page.evaluate(async () => {
        window.__benchTurnStarted = false;
        const unsubscribe = window.__agentBridge.onEvent((event) => {
          if (event.type === 'agent' && event.event.type === 'turn-start') {
            window.__benchTurnStarted = true;
            unsubscribe();
          }
        });
        await window.__agentBridge.sendUserMessage('Bench turn.');
      });
      await page.waitForFunction(() => window.__benchTurnStarted, { timeout: 15000 });
      const capabilityEpoch = await page.evaluate(() => window.__agentBridge.getWorkflowState().capabilityEpoch);
      const capabilities = await registerHubSession({ port: hubPort, token: HUB_TOKEN, launchId: health.launchId, sessionId });
      const client = new McpStdioClient({
        env: {
          RHWP_WS_URL: `ws://127.0.0.1:${hubPort}/mcp`,
          RHWP_AGENT_TOKEN: capabilities.mcp,
          RHWP_SESSION_ID: sessionId,
          RHWP_AGENT_NAME: 'pi',
          RHWP_AGENT_WORKFLOW: 'direct',
          RHWP_AGENT_PHASE: 'implementing',
          RHWP_CAPABILITY_EPOCH: String(capabilityEpoch),
        },
        logPath: path.join(repoRoot, 'target', 'rhwp-concurrency-bench-mcp.log'),
      });
      await client.initialize();
      const end = async () => {
        fs.writeFileSync(finishTurnPath, 'finish');
        let rows = [];
        for (let i = 0; i < 400 && rows.length <= telemetryRows; i += 1) {
          rows = await readToolTelemetryRows(fixtureRoot);
          if (rows.length <= telemetryRows) await delay(25);
        }
        if (rows.length <= telemetryRows) throw new Error('턴 텔레메트리 행이 기록되지 않음');
        telemetryRows = rows.length;
        await page.waitForFunction(() => !window.__inputHandler.isUserEditingLocked(), { timeout: 30000 });
        await client.close();
        fs.rmSync(finishTurnPath);
        return rows[rows.length - 1];
      };
      return { client, end };
    };

    const must = (record, label) => {
      if (record.isError) throw new Error(`${label} 실패: ${record.text.slice(0, 300)}`);
      return record;
    };

    // ── 시드: 문서 끝에 벤치 문단 16개 ──
    {
      const { client, end } = await beginTurn();
      const structure = JSON.parse(must(await client.callTool('get_structure', { format: 'json' }), 'get_structure').text);
      const section = structure.sections[0];
      const last = section.paragraphs[section.paragraphCount - 1] ?? section.paragraphs.at(-1);
      doc.paraCount = section.paragraphCount;
      doc.benchStart = section.paragraphCount;
      const text = Array.from({ length: BENCH_PARAGRAPHS }, (_, k) => `\n벤치 문단 ${k} 병렬 도구 호출 측정 대상입니다`).join('');
      must(await client.callTool('insert_text', {
        sectionIdx: 0, paraIdx: section.paragraphCount - 1, charOffset: last?.length ?? 0, text, expectedRevision: structure.revision,
      }), 'seed insert_text');
      await end();
      doc.paraCount += BENCH_PARAGRAPHS;
      const pages = await page.evaluate(() => window.__wasm.pageCount);
      console.log(`  [seed] 문단 ${doc.paraCount}개, 벤치 문단 p${doc.benchStart}..p${doc.benchStart + BENCH_PARAGRAPHS - 1}, ${pages}쪽`);
    }

    // ── 시계 보정: 한가한 스튜디오에 가벼운 읽기를 띄엄띄엄 보내 브라우저↔허브 시계 차이를 잰다 ──
    let studioSkew = 0;
    {
      const { client, end } = await beginTurn();
      const t0 = epochNow();
      const ids = new Set();
      for (let i = 0; i < 30; i += 1) {
        ids.add((await client.callTool('get_selection', {})).id);
        await delay(15);
      }
      await end();
      const calls = joinCalls(readTraceRows(traceFile)).filter((call) => call.mcp && ids.has(call.mcp.rpcId) && call.mcp.mcpIn >= t0 - 1);
      studioSkew = estimateStudioSkew(calls);
      console.log(`  [clock] 브라우저-허브 시계 차이 ${round(studioSkew, 2)}ms (보정에 사용)`);
    }

    for (const scenario of SCENARIOS) {
      if (SCENARIO_FILTER && scenario.name !== SCENARIO_FILTER) continue;
      for (const concurrency of LEVELS) {
        const { client, end } = await beginTurn();
        // 웜업 + 현재 revision
        let revision = must(await client.callTool('get_structure', { maxParagraphs: 1 }), 'warmup').revision;
        for (let i = 0; i < 4; i += 1) {
          const spec = scenario.make(CALLS + i, revision, i);
          const warm = must(await client.callTool(spec.tool, spec.args), `warmup ${spec.tool}`);
          if (Number.isInteger(warm.revision)) revision = Math.max(revision, warm.revision);
        }
        if (cdp) await cdp.send('Profiler.start');
        const records = [];
        const rounds = [];
        const t0 = epochNow();
        for (let r = 0; r * concurrency < CALLS; r += 1) {
          const roundRevision = revision;
          const specs = Array.from({ length: Math.min(concurrency, CALLS - r * concurrency) }, (_, k) => scenario.make(r * concurrency + k, roundRevision, k));
          const r0 = epochNow();
          const done = await Promise.all(specs.map((spec) => client.callTool(spec.tool, spec.args).then((record) => ({
            ...record, tool: spec.tool, write: spec.args.expectedRevision !== undefined,
          }))));
          rounds.push(epochNow() - r0);
          for (const record of done) {
            if (Number.isInteger(record.revision)) revision = Math.max(revision, record.revision);
            records.push(record);
          }
        }
        const wallMs = epochNow() - t0;
        const profile = cdp ? summarizeProfile((await cdp.send('Profiler.stop')).profile) : null;
        await end();

        // ── 추적 행과 잇기 ──
        const byRpc = new Map(records.map((record) => [record.id, record]));
        const joined = joinCalls(readTraceRows(traceFile)).filter((call) => call.mcp && byRpc.has(call.mcp.rpcId)
          && call.mcp.mcpIn >= t0 - 1);
        // 쓰기 뒤에는 스튜디오 메인 스레드가 늘 바빠 최소 하행 지연이 부풀므로 시계 차이는
        // 한가한 상태에서 따로 잰 값을 쓴다.
        const skew = studioSkew;
        const stageRows = joined.map((call) => {
          const record = byRpc.get(call.mcp.rpcId);
          return callStages(call, { skew, client: { send: record.send, recv: record.recv } });
        });
        const errors = {};
        for (const record of records) if (record.isError) errors[record.errorCode] = (errors[record.errorCode] ?? 0) + 1;
        const mcpIntervals = joined.map((call) => [call.mcp.mcpIn, call.mcp.mcpOut]);
        const studioIntervals = joined.filter((call) => call.studio).map((call) => [call.studio.stIn - skew, call.studio.stSend - skew]);
        const execIntervals = joined.filter((call) => call.studio).map((call) => [call.studio.exec0 - skew, call.studio.stSend - skew]);
        const perTool = {};
        for (const record of records) (perTool[record.tool] ??= []).push(record.ms);
        const row = {
          scenario: scenario.name,
          concurrency,
          calls: records.length,
          wallMs: round(wallMs),
          callsPerSec: round(records.length / (wallMs / 1000)),
          latency: stats(records.map((record) => record.ms)),
          perTool: Object.fromEntries(Object.entries(perTool).map(([tool, samples]) => [tool, stats(samples)])),
          round: stats(rounds),
          errors,
          traced: joined.length,
          studioSkewMs: round(skew, 2),
          maxConcurrentMcp: maxOverlap(mcpIntervals),
          maxConcurrentStudioExec: maxOverlap(execIntervals),
          studioBusyMs: round(unionLength(execIntervals)),
          studioSpanMs: round(unionLength(studioIntervals)),
          stages: summarizeStages(stageRows),
          ...(profile ? { profile } : {}),
        };
        results.push(row);
        const err = Object.entries(errors).map(([k, v]) => `${k}×${v}`).join(' ') || '-';
        console.log(`  [${scenario.name.padEnd(17)} c=${concurrency}] wall=${String(row.wallMs).padStart(7)}ms  p50=${row.latency.p50}  p95=${row.latency.p95}  calls/s=${row.callsPerSec}  mcpOverlap=${row.maxConcurrentMcp}  execOverlap=${row.maxConcurrentStudioExec}  errors=${err}`);
      }
    }

    printSummary();
  });
} catch (err) {
  console.error('벤치 실패:', err.message || err);
  failed = true;
} finally {
  await stopServer(vite);
  await stopServer(hub);
  removeTempDir(fixtureRoot);
}

function printSummary() {
  const stageOrder = ['client→mcp', 'mcp.pre', 'mcp→hub', 'hub.route', 'hub→studio', 'studio.pre', 'studio.baseline',
    'executor+engine', 'studio.report', 'studio.post', 'studio→hub', 'hub.queue', 'hub.result', 'hub→mcp', 'mcp.post',
    'mcp→client', 'hub.local', 'total'];
  console.log('\n  [bench] 단계별 p50 ms (c=1 → 최대 동시성):');
  for (const row of results) {
    const parts = stageOrder.filter((name) => row.stages[name]).map((name) => `${name}=${row.stages[name].p50}`);
    console.log(`    ${`${row.scenario} c=${row.concurrency}`.padEnd(24)} ${parts.join('  ')}`);
  }
  const payload = { sample: SAMPLE, calls: CALLS, levels: LEVELS, results };
  if (OUT) fs.writeFileSync(OUT, JSON.stringify(payload, null, 2));
  console.log(`\nCONCURRENCY_BENCH_RESULT: ${JSON.stringify(payload)}`);
}

process.exit(failed || process.exitCode ? 1 : 0);
