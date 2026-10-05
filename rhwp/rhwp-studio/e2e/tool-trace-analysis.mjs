/**
 * 도구 추적(RHWP_TOOL_TRACE=1) 행 분석 — 허브 tool-trace.jsonl 을 호출 단위로 묶고 단계별 ms 로 나눈다.
 *
 * 행 종류 (rhwp-agent/tool-trace.mjs):
 *   hub      — 허브가 결과를 보낸 순간 한 줄. seq, hubIn/hubFwd/hubRespIn/hubRespDeq/hubOut, studio{...}
 *   mcp      — mcp-stdio 가 CLI 에 결과를 돌려준 뒤 보낸 자기 구간. seq, rpcId, toolUseId?, mcpIn/wsSend/wsRecv/mcpOut
 *   provider — 허브가 받은 프로바이더 이벤트 (turn-start/turn-end/tool-call/tool-result)
 *   claude   — claude 어댑터 stream 이벤트 (message_start, tool_use_start, tool_use, tool_result, result)
 * 시각은 모두 epoch ms 다.
 */
import fs from 'node:fs';

import { stats } from './agent-bench-harness.mjs';

export function readTraceRows(file) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  return text.split('\n').filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}

/** hub 행과 mcp 행을 seq 로 묶는다. */
export function joinCalls(rows) {
  const mcpBySeq = new Map();
  for (const row of rows) if (row.kind === 'mcp' && Number.isFinite(row.seq)) mcpBySeq.set(row.seq, row);
  return rows.filter((row) => row.kind === 'hub').map((hub) => ({
    seq: hub.seq,
    tool: hub.tool,
    agent: hub.agent,
    ok: hub.ok,
    error: hub.error ?? null,
    hub,
    studio: hub.studio && Object.keys(hub.studio).length > 0 ? hub.studio : null,
    mcp: mcpBySeq.get(hub.seq) ?? null,
  }));
}

/**
 * 브라우저와 허브의 시계 차이 추정 — 양방향 최소 지연이 같다고 보고 (NTP 식) 절반으로 나눈다.
 * 양수면 스튜디오 시계가 허브보다 앞선다.
 */
export function estimateStudioSkew(calls) {
  let down = Infinity;
  let up = Infinity;
  for (const call of calls) {
    const s = call.studio;
    if (!s || !Number.isFinite(s.stIn) || !Number.isFinite(s.stSend)) continue;
    if (!Number.isFinite(call.hub.hubFwd) || !Number.isFinite(call.hub.hubRespIn)) continue;
    down = Math.min(down, s.stIn - call.hub.hubFwd);
    up = Math.min(up, call.hub.hubRespIn - s.stSend);
  }
  if (!Number.isFinite(down) || !Number.isFinite(up)) return 0;
  return (down - up) / 2;
}

const span = (a, b) => (Number.isFinite(a) && Number.isFinite(b) ? b - a : null);

/**
 * 호출 하나를 단계별 ms 로 나눈다. client = { send, recv } 는 벤치 MCP 클라이언트 시각(있을 때만).
 * skew 는 estimateStudioSkew 결과 — 스튜디오 시각에서 뺀다.
 */
export function callStages(call, { skew = 0, client = null } = {}) {
  const h = call.hub;
  const m = call.mcp ?? {};
  const st = call.studio
    ? Object.fromEntries(Object.entries(call.studio).map(([k, v]) => [k, typeof v === 'number' ? v - skew : v]))
    : null;
  const stages = {};
  const put = (name, value) => { if (value !== null) stages[name] = value; };
  if (client) put('client→mcp', span(client.send, m.mcpIn));
  put('mcp.pre', span(m.mcpIn, m.wsSend));
  put('mcp→hub', span(m.wsSend, h.hubIn));
  if (Number.isFinite(h.hubFwd)) {
    put('hub.route', span(h.hubIn, h.hubFwd));
    if (st) {
      put('hub→studio', span(h.hubFwd, st.stIn));
      put('studio.pre', span(st.stIn, st.exec0));
      put('studio.baseline', span(st.exec0, st.dispatch0));
      put('executor+engine', span(st.dispatch0, st.dispatch1));
      put('studio.report', span(st.dispatch1, st.report1));
      put('studio.post', span(st.report1 ?? st.exec0, st.stSend));
      put('studio→hub', span(st.stSend, h.hubRespIn));
    } else {
      put('studio.total', span(h.hubFwd, h.hubRespIn));
    }
    put('hub.queue', span(h.hubRespIn, h.hubRespDeq));
    put('hub.result', span(h.hubRespDeq, h.hubOut));
  } else {
    put('hub.local', span(h.hubIn, h.hubOut));
  }
  put('hub→mcp', span(h.hubOut, m.wsRecv));
  put('mcp.post', span(m.wsRecv, m.mcpOut));
  if (client) put('mcp→client', span(m.mcpOut, client.recv));
  const start = client?.send ?? m.mcpIn ?? h.hubIn;
  const end = client?.recv ?? m.mcpOut ?? h.hubOut;
  put('total', span(start, end));
  return stages;
}

/** 단계별 p50/p95 요약. */
export function summarizeStages(stageRows) {
  const buckets = {};
  for (const stages of stageRows) {
    for (const [name, value] of Object.entries(stages)) (buckets[name] ??= []).push(value);
  }
  return Object.fromEntries(Object.entries(buckets).map(([name, samples]) => [name, stats(samples)]));
}

/** 구간 목록에서 동시에 열려 있던 최대 개수. */
export function maxOverlap(intervals) {
  const events = [];
  for (const [a, b] of intervals) {
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    events.push([a, 1], [b, -1]);
  }
  events.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  let open = 0;
  let max = 0;
  for (const [, delta] of events) {
    open += delta;
    max = Math.max(max, open);
  }
  return max;
}

/** 여러 구간의 합집합 길이 — 병렬 호출이 실제로 차지한 벽시계 시간. */
export function unionLength(intervals) {
  const sorted = intervals.filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b) && b > a)
    .sort((x, y) => x[0] - y[0]);
  let total = 0;
  let curA = null;
  let curB = null;
  for (const [a, b] of sorted) {
    if (curB === null || a > curB) {
      if (curB !== null) total += curB - curA;
      curA = a;
      curB = b;
    } else {
      curB = Math.max(curB, b);
    }
  }
  if (curB !== null) total += curB - curA;
  return total;
}

export function round(value, digits = 1) {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

/**
 * 실제 프로바이더 턴 하나를 분석한다 — [from, to] 사이의 추적 행으로.
 * claude 행(tool_use/tool_result/message_start)과 허브·mcp 행을 toolUseId(있으면) 또는 도구 이름 순서로 잇는다.
 */
export function analyzeProviderTurn(rows, { from, to, skew = 0 }) {
  const inWindow = (t) => Number.isFinite(t) && t >= from && t <= to;
  const calls = joinCalls(rows).filter((call) => inWindow(call.hub.hubIn));
  const claude = rows.filter((row) => row.kind === 'claude' && inWindow(row.t));
  const provider = rows.filter((row) => row.kind === 'provider' && inWindow(row.t));
  const toolUses = claude.filter((row) => row.ev === 'tool_use');
  const toolResults = new Map(claude.filter((row) => row.ev === 'tool_result').map((row) => [row.toolUseId, row]));
  const toolUseStarts = new Map(claude.filter((row) => row.ev === 'tool_use_start').map((row) => [row.toolUseId, row]));

  // tool_use ↔ 허브 호출 잇기: mcp 행의 toolUseId 가 있으면 그걸, 없으면 같은 도구의 도착 순서로.
  const byToolUseId = new Map(calls.filter((call) => call.mcp?.toolUseId).map((call) => [call.mcp.toolUseId, call]));
  const unmatched = new Map();
  for (const call of [...calls].sort((a, b) => a.hub.hubIn - b.hub.hubIn)) {
    if (call.mcp?.toolUseId) continue;
    if (!unmatched.has(call.tool)) unmatched.set(call.tool, []);
    unmatched.get(call.tool).push(call);
  }
  const linked = toolUses.map((use) => {
    let call = byToolUseId.get(use.toolUseId) ?? null;
    if (!call && unmatched.get(use.tool)?.length) call = unmatched.get(use.tool).shift();
    return { use, call, result: toolResults.get(use.toolUseId) ?? null, start: toolUseStarts.get(use.toolUseId) ?? null };
  });

  const perCall = linked.map(({ use, call, result, start }) => {
    const m = call?.mcp ?? null;
    return {
      tool: use.tool,
      messageId: use.messageId,
      parent: use.parent ?? null,
      rhwp: Boolean(call),
      // 모델이 도구 인자를 스트리밍한 시간 (content_block_start → assistant 블록 완성)
      argsStreamMs: start ? use.t - start.t : null,
      // CLI 가 블록 완성부터 MCP 호출까지 쓴 시간 (같은 메시지의 뒤 블록을 기다린 시간 포함)
      cliDispatchMs: m ? m.mcpIn - use.t : null,
      // 우리 경로 전체: mcp-stdio 수신 → 반환
      pipelineMs: m ? m.mcpOut - m.mcpIn : call ? call.hub.hubOut - call.hub.hubIn : null,
      studioExecMs: call?.studio ? call.studio.stSend - call.studio.exec0 : null,
      studioWaitMs: call?.studio ? (call.studio.stIn - skew) - call.hub.hubFwd : null,
      // CLI 가 결과를 받아 tool_result 로 내보내기까지
      cliReturnMs: m && result ? result.t - m.mcpOut : null,
      // CLI 가 본 도구 시간 (블록 완성 → tool_result)
      toolMs: result ? result.t - use.t : null,
      interval: m ? [m.mcpIn, m.mcpOut] : null,
      execInterval: call?.studio ? [call.studio.exec0 - skew, call.studio.stSend - skew] : null,
      cliInterval: result ? [use.t, result.t] : null,
      ok: call ? call.ok : result ? !result.isError : null,
    };
  });

  // 한 assistant 메시지의 tool_use 묶음 = 모델이 병렬로 낸 호출.
  const batches = new Map();
  for (const entry of perCall) {
    const key = `${entry.parent ?? 'root'}:${entry.messageId}`;
    if (!batches.has(key)) batches.set(key, []);
    batches.get(key).push(entry);
  }
  const batchRows = [...batches.values()].map((entries) => {
    const cli = entries.filter((e) => e.cliInterval).map((e) => e.cliInterval);
    return {
      size: entries.length,
      tools: entries.map((entry) => entry.tool),
      rhwp: entries.filter((entry) => entry.rhwp).length,
      maxConcurrentMcp: maxOverlap(entries.filter((e) => e.interval).map((e) => e.interval)),
      maxConcurrentCli: maxOverlap(cli),
      maxConcurrentStudioExec: maxOverlap(entries.filter((e) => e.execInterval).map((e) => e.execInterval)),
      makespanMs: cli.length ? round(Math.max(...cli.map(([, b]) => b)) - Math.min(...cli.map(([a]) => a))) : null,
      sumToolMs: round(entries.reduce((sum, e) => sum + (e.toolMs ?? 0), 0)),
    };
  });

  // 모델 요청별 구간 — 루트 메시지만. 요청은 앞 경계(턴 시작 또는 직전 도구 결과)에서 시작한다.
  const rootRows = claude.filter((row) => !row.parent).sort((a, b) => a.t - b.t);
  const spawnRow = rootRows.find((row) => row.ev === 'spawn') ?? null;
  const initRow = rootRows.find((row) => row.ev === 'init') ?? null;
  const requests = [];
  let boundary = from;
  let current = null;
  for (const row of rootRows) {
    if (row.ev === 'message_start') {
      current = {
        messageId: row.messageId,
        at: round(row.t - from),
        waitMs: round(row.t - boundary),
        inTok: row.inTok ?? null,
        cacheRead: row.cacheRead ?? null,
        cacheWrite: row.cacheWrite ?? null,
        blocks: [],
        open: new Map(),
        startT: row.t,
      };
      requests.push(current);
    } else if (current && (row.ev === 'block_start' || row.ev === 'tool_use_start')) {
      current.open.set(row.index, { type: row.ev === 'tool_use_start' ? `tool_use:${row.tool}` : row.blockType, t: row.t });
    } else if (current && row.ev === 'block_stop') {
      const open = current.open.get(row.index);
      if (open) {
        current.blocks.push({ type: open.type, ms: round(row.t - open.t) });
        current.open.delete(row.index);
      }
    } else if (current && row.ev === 'message_delta') {
      current.genMs = round(row.t - current.startT);
      current.outTok = row.outTok ?? null;
      current.stopReason = row.stopReason;
      boundary = row.t;
    } else if (row.ev === 'tool_result') {
      boundary = row.t;
    }
  }
  for (const request of requests) {
    delete request.open;
    delete request.startT;
    const sum = (prefix) => round(request.blocks.filter((b) => b.type.startsWith(prefix)).reduce((s, b) => s + b.ms, 0));
    request.thinkingMs = sum('thinking');
    request.textMs = sum('text');
    request.toolArgsMs = sum('tool_use');
  }
  const startup = {
    spawnMs: spawnRow ? round(spawnRow.t - from) : null,
    initMs: spawnRow && initRow ? round(initRow.t - spawnRow.t) : null,
    firstRequestMs: requests[0] ? round(requests[0].at) : null,
  };

  // claude 가 아닌 프로바이더는 스트림 행이 없다 — 허브가 받은 tool-call/tool-result 이벤트로 센다.
  const providerCalls = provider.filter((row) => row.ev === 'tool-call' && !row.parentTaskId);
  const providerResults = provider.filter((row) => row.ev === 'tool-result' && !row.parentTaskId);
  const fromProvider = claude.length === 0;

  const toolIntervals = perCall.filter((e) => e.cliInterval).map((e) => e.cliInterval);
  const turnStart = provider.find((row) => row.ev === 'turn-start')?.t ?? from;
  const turnEnd = [...provider].reverse().find((row) => row.ev === 'turn-end')?.t ?? to;
  const results = claude.filter((row) => row.ev === 'result');
  const pick = (key) => perCall.map((e) => e[key]).filter((v) => Number.isFinite(v));
  const toolsUsed = {};
  for (const e of fromProvider ? providerCalls : perCall) toolsUsed[e.tool] = (toolsUsed[e.tool] ?? 0) + 1;
  const parallel = batchRows.filter((b) => b.size > 1);
  return {
    turnWallMs: round(turnEnd - from),
    providerTurnMs: round(turnEnd - turnStart),
    modelRequests: claude.filter((row) => row.ev === 'message_start' && !row.parent).length,
    subagentModelRequests: claude.filter((row) => row.ev === 'message_start' && row.parent).length,
    toolCalls: fromProvider ? providerCalls.length : perCall.length,
    // CLI 가 오류로 돌려받은 호출 — 인자 검증 실패와 도구 오류 모두. 모델이 다시 보내야 하는 요청이다.
    failedToolCalls: fromProvider
      ? providerResults.filter((row) => row.ok === false).length
      : claude.filter((row) => row.ev === 'tool_result' && row.isError && !row.parent).length,
    rhwpToolCalls: perCall.filter((e) => e.rhwp).length,
    hubToolCalls: calls.length,
    toolsUsed,
    toolUnionMs: round(unionLength(toolIntervals)),
    nonToolMs: round((turnEnd - from) - unionLength(toolIntervals)),
    parallelBatches: parallel.length,
    parallelCalls: parallel.reduce((sum, b) => sum + b.size, 0),
    largestBatch: Math.max(0, ...batchRows.map((b) => b.size)),
    batches: parallel,
    latency: {
      pipelineMs: stats(pick('pipelineMs')),
      toolMs: stats(pick('toolMs')),
      cliDispatchMs: stats(pick('cliDispatchMs')),
      cliReturnMs: stats(pick('cliReturnMs')),
      studioExecMs: stats(pick('studioExecMs')),
      studioWaitMs: stats(pick('studioWaitMs')),
      argsStreamMs: stats(pick('argsStreamMs')),
    },
    startup,
    requests,
    modelWaitMs: round(requests.reduce((sum, r) => sum + (r.waitMs ?? 0), 0)),
    modelGenMs: round(requests.reduce((sum, r) => sum + (r.genMs ?? 0), 0)),
    thinkingMs: round(requests.reduce((sum, r) => sum + r.thinkingMs, 0)),
    toolArgsMs: round(requests.reduce((sum, r) => sum + r.toolArgsMs, 0)),
    textMs: round(requests.reduce((sum, r) => sum + r.textMs, 0)),
    outputTokens: requests.reduce((sum, r) => sum + (r.outTok ?? 0), 0),
    claudeResult: results.at(-1) ?? null,
    matchedByToolUseId: calls.filter((call) => call.mcp?.toolUseId).length,
    perCall: perCall.map(({ interval, execInterval, cliInterval, ...rest }) => ({
      ...Object.fromEntries(Object.entries(rest).map(([k, v]) => [k, typeof v === 'number' ? round(v) : v])),
      ...(cliInterval ? { at: round(cliInterval[0] - from) } : {}),
    })),
  };
}
