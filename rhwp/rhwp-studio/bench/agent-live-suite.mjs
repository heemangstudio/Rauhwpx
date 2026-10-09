/**
 * 실측 과제 모음 — 실제 프로바이더(claude|codex|pi)로 문서 편집 과제를 돌리고 결과를 자동 채점한다.
 *
 *   사이드바 입력창 → 브리지 → 허브 → 프로바이더 CLI → MCP → 허브 → 스튜디오 → wasm
 *
 * 실행마다 샘플을 새로 열고(필요하면 오타 주입 등 준비), 과제의 모드로 새 채팅을 연 뒤 프롬프트를 보낸다.
 * 턴이 끝나면 문서 스냅숏(또는 마지막 답)을 채점하고, 모델 요청·도구 호출·실패·병렬 묶음·토큰·비용을 함께 적는다.
 * 과제 목록과 채점 기준은 agent-live-tasks.mjs 에 있다. 모델 호출이 실제로 나가므로 사용량이 든다.
 *
 * 실행: node bench/agent-live-suite.mjs --mode=headless --agent=pi --model=deepseek/deepseek-v4.1-flash --effort=medium
 *        [--runs=1] [--tasks=typos,question] [--out=<json>] [--transcripts=<dir>] [--timeout-ms=600000]
 *        --agent=claude --model=claude-opus-5-5 --effort=medium 도 같은 과제를 돈다.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { openSample } from '../e2e/agent-bench-harness.mjs';
import {
  analyzeTurn,
  arg,
  installEventCapture,
  listPiSessionFiles,
  keepTranscripts,
  readEventCapture,
  readPendingEdits,
  rejectPendingEdits,
  resetEventCapture,
  round,
  sendThroughComposer,
  startFreshChat,
  startLiveStack,
  stats,
  waitForTurnEnd,
} from './agent-live-common.mjs';
import { documentSnapshot, selectTasks } from './agent-live-tasks.mjs';

const AGENT = arg('agent') ?? 'pi';
const MODEL = arg('model') ?? (AGENT === 'pi' ? 'deepseek/deepseek-v4.1-flash' : AGENT === 'claude' ? 'claude-opus-5-5' : null);
const EFFORT = arg('effort') ?? 'medium';
const RUNS = Number(arg('runs') ?? 1);
const OUT = arg('out');
const TRANSCRIPTS = arg('transcripts');
const TURN_TIMEOUT_MS = Number(arg('timeout-ms') ?? 10 * 60_000);
const TASKS = selectTasks(arg('tasks'));

console.log('=== LIVE SUITE: 실제 프로바이더 문서 편집 과제 ===\n');
const stack = await startLiveStack({ agent: AGENT, model: MODEL, tag: `suite-${AGENT}` });
console.log(`  [setup] 허브=${stack.hubPort} vite=${stack.vitePort} agent=${AGENT} model=${MODEL ?? '(기본)'} effort=${EFFORT} runs=${RUNS}`);
console.log(`  [setup] tasks: ${TASKS.map((t) => t.id).join(', ')}`);
if (stack.pi) console.log(`  [setup] pi ${stack.pi.version}, ${stack.pi.model.name} (ctx ${stack.pi.model.contextLength}, $${round(stack.pi.model.pricing.prompt * 1e6, 3)}/$${round(stack.pi.model.pricing.completion * 1e6, 3)} per M in/out)`);
const { runTest } = await import('../e2e/helpers.mjs');

const results = [];

async function runOne(page, task, run) {
  const tag = `${task.id}#${run}`;
  await openSample(page, task.sample);
  await delay(300);
  const setupState = task.setup ? await task.setup(page) : null;
  const before = await documentSnapshot(page);
  await startFreshChat(page, { agent: AGENT, model: MODEL, effort: EFFORT, permissionProfile: task.permissionProfile, workflow: task.workflow });
  await delay(500);
  await resetEventCapture(page);
  const piFilesBefore = stack.pi ? new Map(listPiSessionFiles(stack.pi.sessionsDir).map((f) => [f, fs.statSync(f).size])) : null;
  const sentAt = await page.evaluate(() => performance.timeOrigin + performance.now());
  const via = await sendThroughComposer(page, task.prompt);
  const turn = await waitForTurnEnd(page, { traceFile: stack.traceFile, sentAt, timeoutMs: TURN_TIMEOUT_MS });
  await delay(1500); // 추적·세션 기록 대기
  // 전체 접근 턴은 끝나면 자동 커밋된다 — 편집 잠금이 풀린 뒤 결과를 읽는다.
  await page.waitForFunction(() => !window.__inputHandler?.isUserEditingLocked?.(), { timeout: 60000 }).catch(() => {});
  const capture = await readEventCapture(page);
  const pending = await readPendingEdits(page);
  const after = await documentSnapshot(page);
  const piFiles = stack.pi
    ? listPiSessionFiles(stack.pi.sessionsDir).filter((f) => !piFilesBefore.has(f) || fs.statSync(f).size !== piFilesBefore.get(f))
    : [];
  const metrics = analyzeTurn({
    agent: AGENT, traceFile: stack.traceFile, fixtureRoot: stack.fixtureRoot,
    from: sentAt, to: turn.endedAt, piFiles, pricing: stack.pi?.model.pricing ?? null,
    usageEvents: capture.events.filter((e) => e.type === 'usage'),
  });
  const finalText = capture.answer.trim() || metrics.finalText || capture.text;
  let check;
  try {
    check = task.check({ before, after, finalText, pending, setup: setupState });
  } catch (error) {
    check = { score: 0, details: { checkError: String(error?.message ?? error) } };
  }
  if (TRANSCRIPTS) keepTranscripts({ agent: AGENT, fixtureRoot: stack.fixtureRoot, dir: TRANSCRIPTS, prefix: `${task.id}-r${run}-`, piFiles });
  if (pending?.hasPending) await rejectPendingEdits(page);
  const row = {
    task: task.id,
    title: task.title,
    sample: task.sample,
    mode: `${task.workflow}/${task.permissionProfile}`,
    run,
    via,
    wallMs: round(turn.endedAt - sentAt),
    status: turn.timedOut ? 'timeout' : turn.askedUser ? 'asked-user' : 'done',
    askedUser: turn.askedUser,
    score: check.score,
    check: check.details,
    pending,
    finalText: finalText.slice(0, 2000),
    turnErrors: capture.events.filter((e) => e.type === 'error' || e.type === 'hub-error').map((e) => e.message),
    ...metrics,
  };
  results.push(row);
  const cost = row.costUsd !== null && row.costUsd !== undefined ? ` cost=$${row.costUsd}` : '';
  console.log(`  [${tag}] score=${row.score} wall=${round(row.wallMs / 1000, 1)}s req=${row.modelRequests} tools=${row.toolCalls} (rhwp ${row.rhwpToolCalls}, failed ${row.failedToolCalls}) batches=${row.parallelBatches} out=${row.outputTokens}tok${cost} ${row.status}`);
  console.log(`      check: ${JSON.stringify(check.details).slice(0, 400)}`);
  for (const failure of row.failures.slice(0, 6)) console.log(`      failed ${failure.tool}: ${failure.code} ${failure.message.slice(0, 120).replace(/\s+/g, ' ')}`);
  return row;
}

const mean6 = (xs) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 1e6) / 1e6 : null);

function summarizeTask(rows) {
  const pick = (key) => rows.map((r) => r[key]).filter((v) => Number.isFinite(v));
  return {
    task: rows[0].task,
    runs: rows.length,
    score: stats(pick('score')),
    wallS: stats(rows.map((r) => r.wallMs / 1000)),
    modelRequests: stats(pick('modelRequests')),
    toolCalls: stats(pick('toolCalls')),
    rhwpToolCalls: stats(pick('rhwpToolCalls')),
    failedToolCalls: stats(pick('failedToolCalls')),
    parallelBatches: stats(pick('parallelBatches')),
    inputTokens: stats(pick('inputTokens')),
    outputTokens: stats(pick('outputTokens')),
    // stats() 는 소수 둘째 자리에서 자른다 — 비용은 따로 정확히 낸다.
    costUsd: mean6(pick('costUsd')),
    catalogCostUsd: mean6(pick('catalogCostUsd')),
    askedUser: rows.filter((r) => r.askedUser).length,
    timeouts: rows.filter((r) => r.status === 'timeout').length,
    failureCodes: rows.flatMap((r) => r.failures.map((f) => `${f.tool}:${f.code}`)),
  };
}

function printTable(summaries) {
  const header = ['task', 'runs', 'score', 'wall s', 'req', 'tools', 'failed', 'batches', 'out tok', 'cost $'];
  const lines = summaries.map((s) => [
    s.task, s.runs, s.score.mean, round(s.wallS.mean ?? 0, 1), s.modelRequests.mean ?? '-', s.toolCalls.mean ?? '-',
    s.failedToolCalls.mean ?? '-', s.parallelBatches.mean ?? '-', s.outputTokens.mean ?? '-', Number.isFinite(s.costUsd) ? s.costUsd.toFixed(4) : '-',
  ].map(String));
  const widths = header.map((h, i) => Math.max(h.length, ...lines.map((l) => l[i].length)));
  const fmt = (cells) => cells.map((c, i) => (i === 0 ? c.padEnd(widths[i]) : c.padStart(widths[i]))).join('  ');
  console.log(`\n  ${fmt(header)}`);
  for (const line of lines) console.log(`  ${fmt(line)}`);
}

let finished = false;
function finish() {
  if (finished) return;
  finished = true;
  const byTask = TASKS.map((task) => results.filter((r) => r.task === task.id && r.status !== 'harness-error'))
    .filter((rows) => rows.length > 0);
  const summaries = byTask.map(summarizeTask);
  printTable(summaries);
  const total = {
    agent: AGENT, model: MODEL, effort: EFFORT, runs: RUNS,
    meanScore: round(results.reduce((n, r) => n + (r.score ?? 0), 0) / Math.max(1, results.length), 3),
    totalCostUsd: round(results.reduce((n, r) => n + (Number(r.costUsd) || 0), 0), 4),
    harnessErrors: results.filter((r) => r.status === 'harness-error').length,
  };
  console.log(`\n  mean score=${total.meanScore}  total cost=$${total.totalCostUsd}  harness errors=${total.harnessErrors}`);
  if (OUT) {
    fs.mkdirSync(path.dirname(path.resolve(OUT)), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify({ meta: { ...total, pi: stack.pi ? { version: stack.pi.version, model: stack.pi.model } : null, at: new Date().toISOString() }, summaries, runs: results }, null, 2));
    console.log(`  [out] ${path.resolve(OUT)}`);
  }
  if (TRANSCRIPTS) console.log(`  [transcripts] ${path.resolve(TRANSCRIPTS)}`);
  if (results.length) {
    const keep = path.join(os.tmpdir(), `rhwp-live-suite-trace-${Date.now()}.jsonl`);
    try { fs.copyFileSync(stack.traceFile, keep); console.log(`  [trace] ${keep}`); } catch { /* 추적 없음 */ }
  }
  if (total.harnessErrors > 0) process.exitCode = 1;
  // puppeteer browser.close() 가 이 Mac 에서 멈출 수 있다 — 결과를 쓴 뒤에는 감시 타이머로 스스로 끝낸다.
  setTimeout(async () => {
    console.log('  [watchdog] 브라우저 종료가 멈춰 강제로 끝냅니다');
    await stack.stop().catch(() => {});
    process.exit(process.exitCode ?? 0);
  }, 30_000).unref();
}

try {
  await runTest('실제 프로바이더 문서 편집 과제', async ({ page }) => {
    await installEventCapture(page);
    try {
      for (const task of TASKS) {
        for (let run = 1; run <= RUNS; run += 1) {
          try {
            await runOne(page, task, run);
          } catch (error) {
            console.log(`  [${task.id}#${run}] 실행 실패: ${error?.message ?? error}`);
            results.push({ task: task.id, run, status: 'harness-error', error: String(error?.message ?? error), score: 0, failures: [] });
            if (/Pi 가 설치|OpenRouter 키|채팅을 시작하지 못했|준비되지 않은/.test(String(error?.message))) throw error;
          }
        }
      }
    } finally {
      finish();
    }
  });
} catch (err) {
  console.error('실측 실패:', err.message || err);
  process.exitCode = 1;
} finally {
  finish();
  await stack.stop();
}
process.exit(process.exitCode ?? 0);
