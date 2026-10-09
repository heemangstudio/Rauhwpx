/**
 * 실측: 실제 claude CLI 를 제품 경로로 돌려 도구 호출 지연과 병렬 실행을 잰다.
 *
 *   사이드바 입력창 → 브리지 → 허브 → claude(Agent SDK) → mcp-stdio → 허브 → 스튜디오 → wasm
 *
 * 허브는 RHWP_TOOL_TRACE=1 로 띄운다. 추적 행에서 턴마다 도구 호출 수, 호출별 지연,
 * 모델이 한 메시지에 낸 병렬 호출 묶음과 그 묶음이 실제로 겹쳐 실행됐는지를 뽑는다.
 * 모델 호출이 실제로 나가므로 계정 사용량이 든다.
 *
 * --agent=codex 는 같은 경로로 codex 를 돌린다. 모델 요청 단위 분해는 claude 스트림에만 있어서
 * codex 는 턴 시간, 도구 호출 수, 실패한 호출만 나온다.
 * --agent=pi 는 픽스처 Pi 루트(사용자 Pi prefix 를 빌리고 OpenRouter 키를 심는다)로 pi 를 돌린다.
 * 모델 요청 분해는 Pi 세션 JSONL(요청별 토큰·비용·멈춤 이유·블록 종류)에서 뽑는다.
 *
 * 실행: node e2e/agent-claude-live-bench.mjs --mode=headless [--runs=3] [--agent=claude|codex|pi] [--model=claude-sonnet-5]
 *        [--effort=<low|medium|high>] [--sample=biz_plan.hwp] [--prompt="..."] [--followup="..."] [--out=<json>]
 *        [--transcripts=<dir>]  claude/pi 세션 기록(도구 인자·결과 포함)을 그 폴더에 남긴다 — 실패한 호출을 들여다볼 때.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { readToolTelemetryRows } from '../../rhwp-agent/tool-telemetry.mjs';
import { openSample, stats } from './agent-bench-harness.mjs';
import {
  analyzeTurn,
  arg,
  installEventCapture,
  keepTranscripts as keepSessionTranscripts,
  listPiSessionFiles,
  readEventCapture,
  resetEventCapture,
  sendThroughComposer,
  startFreshChat,
  startLiveStack,
  waitForTurnEnd,
} from './agent-live-common.mjs';
import { analyzeProviderTurn, readTraceRows, round } from './tool-trace-analysis.mjs';

const RUNS = Number(arg('runs') ?? 3);
const AGENT = arg('agent') ?? 'claude';
const MODEL = arg('model') ?? (AGENT === 'claude' ? 'claude-sonnet-5' : AGENT === 'pi' ? 'deepseek/deepseek-v4.1-flash' : undefined);
const EFFORT = arg('effort');
const SAMPLE = arg('sample') ?? 'biz_plan.hwp';
const PROMPT = arg('prompt') ?? 'Read the first 3 pages, then fix every typo and make the section titles bold.';
const FOLLOWUP = arg('followup');
const TRANSCRIPTS = arg('transcripts');
const OUT = arg('out');
const TURN_TIMEOUT_MS = Number(arg('timeout-ms') ?? 15 * 60_000);

console.log('=== LIVE: 실제 프로바이더 도구 호출 지연·병렬 ===\n');
const stack = await startLiveStack({ agent: AGENT, model: MODEL, tag: `${AGENT}-live` });
const { fixtureRoot, traceFile } = stack;
console.log(`  [setup] 허브=${stack.hubPort} vite=${stack.vitePort} agent=${AGENT} model=${MODEL ?? '(기본)'} effort=${EFFORT ?? '(기본)'} runs=${RUNS} sample=${SAMPLE}`);
console.log(`  [setup] prompt: ${PROMPT}`);
const { runTest } = await import('./helpers.mjs');

let failed = false;
const runs = [];
/** 마지막 턴의 Pi 세션 파일 — 기록을 옮길 때 쓴다. */
let lastPiFiles = [];

/**
 * 문서 결과 스냅샷 — 본문 문단 텍스트와 짧은 문단의 첫 글자 굵게 여부.
 * 요청 수가 줄어도 일(오타 수정·제목 굵게)을 덜 한 것은 아닌지 실행마다 비교한다.
 */
async function documentOutcome(page) {
  return page.evaluate(() => {
    const wasm = window.__wasm;
    const paragraphs = [];
    const sections = wasm.getSectionCount();
    for (let sec = 0; sec < sections; sec += 1) {
      const count = wasm.getParagraphCount(sec);
      for (let para = 0; para < count; para += 1) {
        const length = wasm.getParagraphLength(sec, para);
        const text = length > 0 ? wasm.getTextRange(sec, para, 0, length) : '';
        let bold = false;
        let format = '';
        if (length > 0) {
          try {
            const props = wasm.getCharPropertiesAt(sec, para, text.search(/\S/) < 0 ? 0 : text.search(/\S/));
            bold = length <= 60 && props.bold === true;
            format = [props.bold, props.italic, props.underline, props.fontSize].join('/');
          } catch { /* 읽기 실패는 서식 없음 */ }
          try { format += `|${wasm.getParaPropertiesAt(sec, para).alignment ?? ''}`; } catch { /* 문단 서식 없음 */ }
        }
        paragraphs.push({ sec, para, text, bold, format });
      }
    }
    return paragraphs;
  });
}

function compareOutcome(before, after) {
  const key = (p) => `${p.sec}:${p.para}`;
  const afterByKey = new Map(after.map((p) => [key(p), p]));
  const sameShape = before.length === after.length;
  let textChanged = 0;
  let boldAdded = 0;
  // 첫 글자 모양(굵게/기울임/밑줄/크기)이나 문단 정렬이 바뀐 문단 — 서식 작업의 결과량.
  let formatChanged = 0;
  const samples = [];
  for (const b of before) {
    const a = afterByKey.get(key(b));
    if (!a) continue;
    if (a.text !== b.text) {
      textChanged += 1;
      if (samples.length < 12) samples.push({ at: key(b), before: b.text.slice(0, 80), after: a.text.slice(0, 80) });
    }
    if (!b.bold && a.bold) boldAdded += 1;
    if (a.format !== b.format) formatChanged += 1;
  }
  return { paragraphsBefore: before.length, paragraphsAfter: after.length, sameShape, textChanged, boldAdded, formatChanged, samples };
}

try {
  await runTest('실제 claude 도구 호출 실측', async ({ page }) => {
    // 브리지 이벤트를 epoch 시각과 함께 모은다 (턴 시작/끝, 도구 실행 알림, 사용량).
    await installEventCapture(page);

    /** 프롬프트 하나를 보내고 턴이 끝날 때까지 잰다. */
    const measureTurn = async (run, prompt, phase) => {
      await resetEventCapture(page);
      const outcomeBefore = await documentOutcome(page);
      const piFilesBefore = stack.pi ? new Map(listPiSessionFiles(stack.pi.sessionsDir).map((f) => [f, fs.statSync(f).size])) : null;
      const sentAt = await page.evaluate(() => performance.timeOrigin + performance.now());
      const via = await sendThroughComposer(page, prompt);
      const turn = await waitForTurnEnd(page, { traceFile, sentAt, timeoutMs: TURN_TIMEOUT_MS });
      if (turn.timedOut) throw new Error(`turn did not end within ${TURN_TIMEOUT_MS}ms`);
      const endedAt = turn.endedAt;
      await delay(1500); // 추적 스트림·텔레메트리 기록 대기
      const { events } = await readEventCapture(page);
      // 전체 접근 턴은 끝나면 자동 커밋된다 — 편집 잠금이 풀린 뒤 결과를 읽는다.
      await page.waitForFunction(() => !window.__inputHandler?.isUserEditingLocked?.(), { timeout: 60000 }).catch(() => {});
      const outcome = compareOutcome(outcomeBefore, await documentOutcome(page));
      const telemetry = (await readToolTelemetryRows(fixtureRoot)).at(-1) ?? null;
      const analysis = analyzeProviderTurn(readTraceRows(traceFile), { from: sentAt, to: endedAt + 1000 });
      if (stack.pi) {
        // pi 는 스트림 추적 행이 없다 — 모델 요청 분해·토큰·비용·병렬 묶음을 세션 JSONL 에서 채운다.
        lastPiFiles = listPiSessionFiles(stack.pi.sessionsDir).filter((f) => !piFilesBefore.has(f) || fs.statSync(f).size !== piFilesBefore.get(f));
        const pi = analyzeTurn({ agent: 'pi', traceFile, fixtureRoot, from: sentAt, to: endedAt, piFiles: lastPiFiles, pricing: stack.pi.model.pricing });
        Object.assign(analysis, {
          modelRequests: pi.modelRequests, requests: pi.requests, outputTokens: pi.outputTokens,
          inputTokens: pi.inputTokens, cacheReadTokens: pi.cacheReadTokens, costUsd: pi.costUsd, catalogCostUsd: pi.catalogCostUsd,
          modelGenMs: pi.modelMs, modelWaitMs: round(pi.requests.reduce((n, r) => n + r.waitMs, 0)),
          parallelBatches: pi.parallelBatches, parallelCalls: pi.parallelCalls, largestBatch: pi.largestBatch,
          batches: pi.batches, failures: pi.failures, rhwpToolCalls: pi.rhwpToolCalls,
        });
      }
      const row = {
        run,
        phase,
        via,
        askedUser: turn.askedUser,
        studioReconnects: events.filter((event) => event.type === 'connection').length,
        pageTurnWallMs: round(endedAt - sentAt),
        ...analysis,
        outcome,
        telemetry: telemetry ? { toolCalls: telemetry.toolCalls, toolMs: telemetry.toolMs, errors: telemetry.errors, resultChars: telemetry.resultChars } : null,
        errors: events.filter((event) => event.type === 'error').map((event) => event.message),
      };
      runs.push(row);
      const tag = `run ${run}${phase === 'followup' ? ' followup' : ''}`;
      if (turn.askedUser) console.log(`  [${tag}] 모델이 사용자에게 되물어 턴을 중단했다 (물은 시각까지를 턴 시간으로 적는다)`);
      console.log(`  [${tag}] outcome: ${outcome.textChanged} paragraphs rewritten, ${outcome.boldAdded} short paragraphs bolded, ${outcome.formatChanged} reformatted (paragraphs ${outcome.paragraphsBefore}→${outcome.paragraphsAfter})`);
      console.log(`  [${tag}] via=${via} wall=${round(row.pageTurnWallMs / 1000, 1)}s  model requests=${row.modelRequests}  tool calls=${row.toolCalls} (rhwp ${row.rhwpToolCalls}, failed ${row.failedToolCalls})  parallel batches=${row.parallelBatches} (${row.parallelCalls} calls, largest ${row.largestBatch})  tool union=${round(row.toolUnionMs / 1000, 2)}s  pipeline p50/p95=${row.latency.pipelineMs.p50}/${row.latency.pipelineMs.p95}ms  cli tool p50/p95=${row.latency.toolMs.p50}/${row.latency.toolMs.p95}ms`);
      console.log(`  [${tag}] startup: spawn +${row.startup.spawnMs}ms, init ${row.startup.initMs}ms, first request at ${row.startup.firstRequestMs}ms  model wait=${round(row.modelWaitMs / 1000, 1)}s gen=${round(row.modelGenMs / 1000, 1)}s (thinking ${round(row.thinkingMs / 1000, 1)}s, tool args ${round(row.toolArgsMs / 1000, 1)}s, text ${round(row.textMs / 1000, 1)}s) out=${row.outputTokens}tok`);
      if (stack.pi) console.log(`  [${tag}] pi tokens in=${row.inputTokens} cacheRead=${row.cacheReadTokens} out=${row.outputTokens} cost=$${row.costUsd} (catalog $${row.catalogCostUsd})`);
      for (const request of row.requests) {
        const blocks = Array.isArray(request.blocks) && typeof request.blocks[0] === 'string'
          ? `${request.blocks.join(', ')} thinking=${request.thinkingChars}ch text=${request.textChars}ch args=${request.toolArgChars}ch`
          : request.blocks.map((b) => `${b.type} ${b.ms}ms`).join(', ');
        console.log(`      req @${round(request.at / 1000, 1)}s wait=${request.waitMs}ms gen=${request.genMs}ms in=${request.inTok}/${request.cacheRead}r/${request.cacheWrite}w out=${request.outTok} [${blocks}] ${request.stopReason ?? ''}`);
      }
      for (const batch of row.batches) {
        console.log(`      batch ×${batch.size} [${batch.tools.join(', ')}] mcpOverlap=${batch.maxConcurrentMcp ?? batch.maxConcurrentHub} cliOverlap=${batch.maxConcurrentCli} execOverlap=${batch.maxConcurrentStudioExec} makespan=${batch.makespanMs}ms sum=${batch.sumToolMs}ms`);
      }
      for (const failure of row.failures ?? []) console.log(`      failed ${failure.tool}: ${failure.code} ${failure.message.slice(0, 120).replace(/\s+/g, ' ')}`);
      await page.waitForFunction(() => !window.__inputHandler?.isUserEditingLocked?.(), { timeout: 60000 }).catch(() => {});
    };

    for (let run = 1; run <= RUNS; run += 1) {
      await openSample(page, SAMPLE);
      await delay(300);
      await startFreshChat(page, { agent: AGENT, model: MODEL, effort: EFFORT, permissionProfile: 'unrestricted', workflow: 'direct' });
      await measureTurn(run, PROMPT, 'first');
      // 같은 채팅의 다음 턴 — 세션 재개 비용과 다시 읽기 여부를 본다.
      if (FOLLOWUP) await measureTurn(run, FOLLOWUP, 'followup');
      // 다음 채팅이 시작되면 허브가 이 세션의 홈을 지운다 — 그 전에 옮긴다.
      if (TRANSCRIPTS) keepSessionTranscripts({ agent: AGENT, fixtureRoot, dir: TRANSCRIPTS, prefix: AGENT === 'pi' ? `r${run}-` : '', piFiles: lastPiFiles });
    }
    printSummary();
  });
} catch (err) {
  console.error('실측 실패:', err.message || err);
  failed = true;
} finally {
  // 추적 원본은 남긴다 — 실행마다 다시 분석할 수 있게.
  if (runs.length > 0) {
    const keep = path.join(os.tmpdir(), `rhwp-${AGENT}-live-trace-${Date.now()}.jsonl`);
    try { fs.copyFileSync(traceFile, keep); console.log(`  [trace] ${keep}`); } catch { /* 추적 없음 */ }
  }
  await stack.stop();
}

function summarize(rows) {
  const all = rows.flatMap((row) => row.perCall);
  const pick = (key) => all.map((e) => e[key]).filter((v) => Number.isFinite(v));
  return {
    runs: rows.length,
    turnWallMs: stats(rows.map((row) => row.pageTurnWallMs)),
    firstRequestMs: stats(rows.map((row) => row.startup.firstRequestMs).filter(Number.isFinite)),
    modelWaitMs: stats(rows.map((row) => row.modelWaitMs)),
    modelGenMs: stats(rows.map((row) => row.modelGenMs)),
    thinkingMs: stats(rows.map((row) => row.thinkingMs)),
    toolArgsMs: stats(rows.map((row) => row.toolArgsMs)),
    textMs: stats(rows.map((row) => row.textMs)),
    outputTokens: stats(rows.map((row) => row.outputTokens)),
    modelRequestsPerTurn: stats(rows.map((row) => row.modelRequests)),
    toolCallsPerTurn: stats(rows.map((row) => row.toolCalls)),
    failedToolCallsPerTurn: stats(rows.map((row) => row.failedToolCalls)),
    turnsWithFailedCalls: rows.filter((row) => row.failedToolCalls > 0).length,
    turnsAskingUser: rows.filter((row) => row.askedUser).length,
    paragraphsRewritten: stats(rows.map((row) => row.outcome.textChanged)),
    paragraphsBolded: stats(rows.map((row) => row.outcome.boldAdded)),
    paragraphsReformatted: stats(rows.map((row) => row.outcome.formatChanged)),
    parallelBatchesPerTurn: stats(rows.map((row) => row.parallelBatches)),
    pipelineMs: stats(pick('pipelineMs')),
    cliToolMs: stats(pick('toolMs')),
    cliDispatchMs: stats(pick('cliDispatchMs')),
    cliReturnMs: stats(pick('cliReturnMs')),
    studioExecMs: stats(pick('studioExecMs')),
    studioWaitMs: stats(pick('studioWaitMs')),
    toolShareOfTurn: round(rows.reduce((s, r) => s + r.toolUnionMs, 0) / Math.max(1, rows.reduce((s, r) => s + r.turnWallMs, 0)), 3),
  };
}

function printSummary() {
  const first = runs.filter((row) => row.phase === 'first');
  const followups = runs.filter((row) => row.phase === 'followup');
  const summary = {
    agent: AGENT,
    model: MODEL ?? null,
    effort: EFFORT,
    prompt: PROMPT,
    sample: SAMPLE,
    ...summarize(first),
    ...(followups.length > 0 ? { followup: { prompt: FOLLOWUP, ...summarize(followups) } } : {}),
  };
  console.log('\n  [live] 요약:', JSON.stringify(summary));
  const payload = { summary, runs };
  if (OUT) fs.writeFileSync(OUT, JSON.stringify(payload, null, 2));
  console.log(`\nCLAUDE_LIVE_RESULT: ${JSON.stringify(summary)}`);
}

process.exit(failed || process.exitCode ? 1 : 0);
