/**
 * Pi output settings follow production catalog ceilings.
 * 실제 사이트 브라우저 과제. --probe 는 모델을 호출하지 않는다.
 * --execute --label=baseline|final|candidate --repo-root=<실행할 체크아웃> --out=<체크포인트>
 * 최종/후보 실행에는 --baseline=<baseline JSON> 이 필요하다. 중단 후 같은 명령으로 재개한다.
 */
import fs from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  arg, startLiveStack, startFreshChat, sendThroughComposer, waitForTurnEnd,
  installEventCapture, resetEventCapture, readEventCapture, analyzeTurn, listPiSessionFiles,
  loadOpenRouterKey, inspectSubscriptionFunding,
} from './agent-live-common.mjs';
import { joinCalls, readTraceRows } from './tool-trace-analysis.mjs';
import { selectBrowserTasks } from './browser-agent-tasks.mjs';
import { redactTranscriptJson } from '../../rhwp-agent/provider-transcript.mjs';
import { startBudgetProxy } from './browser-agent-budget.mjs';
import { browserEvidenceArgsHash } from '../../rhwp-agent/tool-trace.mjs';

export const BENCHMARK_TIMEZONE = 'Asia/Seoul';
export function benchmarkDay(timestamp, timezone = BENCHMARK_TIMEZONE) {
  if (!timestamp || !Number.isFinite(Date.parse(timestamp))) return null;
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(timestamp));
}

export const browserArms = [
  { id: 'haiku', agent: 'claude', model: 'claude-haiku-5-5' },
  { id: 'luna', agent: 'codex', model: 'gpt-6-luna' },
];
const isInfrastructureError = (row) => ['harness-error', 'provider-error', 'measurement-insufficient'].includes(row.status);
const median = (xs) => {
  const values = xs.filter(Number.isFinite).sort((a, b) => a - b);
  return values.length ? (values[Math.floor((values.length - 1) / 2)] + values[Math.ceil((values.length - 1) / 2)]) / 2 : null;
};

export function baselineLimits(rows) {
  const groups = new Map();
  for (const row of rows) {
    if (isInfrastructureError(row)) continue;
    const key = row.task + '\0' + row.arm;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const limits = {};
  for (const [key, values] of groups) {
    const task = key.split('\0')[0];
    if (values.length !== 3 || values.some((row) => !row.passed || row.blocked || row.status !== 'done' || !Number.isFinite(row.wallMs))) continue;
    const duration = median(values.map((row) => row.wallMs));
    limits[task] = Math.min(limits[task] ?? Infinity, duration * 1.5);
  }
  return limits;
}

export function browserFailureMetrics(calls, validation = {}) {
  const measured = calls.filter((call) => !call.uncorrelatedHub);
  const failures = measured.filter((call) => call.ok === false);
  const text = (call) => JSON.stringify(call.error ?? call.resultPreview ?? '');
  const is = (pattern) => failures.filter((call) => pattern.test(text(call))).length;
  return {
    browserToolCalls: measured.filter((call) => /browser/.test(call.tool ?? '')).length,
    uncorrelatedHubCalls: calls.filter((call) => call.uncorrelatedHub).length,
    uncorrelatedHubFailures: calls.filter((call) => call.uncorrelatedHub && call.ok === false).length,
    invalidCalls: is(/schema|invalid.{0,20}(arg|param)|ARGUMENT|STALE_[A-Z_]+|(?:REF|REFERENCE)_NOT_FOUND|SNAPSHOT_REQUIRED|EPOCH_REQUIRED/i),
    clickFailures: failures.filter((call) => /click/.test(call.tool ?? '') && /timeout|covered|not.found|intercept/i.test(text(call))).length,
    navigationFailures: failures.filter((call) => /navigate|open/.test(call.tool ?? '') && /block|timeout|invalid.url|navigation|net::|APPROVAL_REQUIRED|FORBIDDEN|DENIED/i.test(text(call))).length + (validation.wrongURL ? 1 : 0),
    challengeBlocked: !!validation.blocked || failures.some((call) => /captcha|challenge|CLOUDFLARE|ACCESS_DENIED/i.test(text(call))),
  };
}

export function classifyBrowserTurn({ turn, capture, metrics, answer, browserCalls = [] }) {
  if (turn.timedOut) return { status: 'timeout', abortReason: null };
  if (turn.askedUser) return { status: 'asked-user', abortReason: null };
  const terminal = capture.events.filter((event) => event.type === 'turn-end').at(-1);
  const errors = capture.events.filter((event) => ['error', 'hub-error'].includes(event.type));
  const requestErrors = (metrics.requests ?? []).filter((request) => request.errorMessage);
  const terminalFailed = terminal?.errorMessage || terminal?.message || terminal?.failure
    || /^(?:failed|error|exited|error_.*)$/.test(terminal?.stopReason ?? '') || /^(?:failed|error)$/.test(turn.status ?? '');
  const empty = !answer.trim() && !browserCalls.length && !(metrics.inputTokens > 0) && !(metrics.outputTokens > 0);
  const failed = !!terminalFailed || !!metrics.stopReasons?.error || errors.length > 0 || requestErrors.length > 0 || empty;
  const messages = JSON.stringify([terminal, errors, requestErrors]);
  return { status: failed ? 'provider-error' : 'done', abortReason: !failed ? null
    : /Budget reservation|Budget proxy blocked|reservation exceeds|402.*cap/i.test(messages) ? 'budget-denial'
    : empty ? 'provider-startup-without-evidence' : 'provider-terminal-failure' };
}

export function budgetDelta(snapshot, beforeIds) {
  const entries = snapshot.requests.filter((entry) => !beforeIds.has(entry.id));
  const settled = entries.filter((entry) => entry.state === 'settled');
  const pending = entries.filter((entry) => entry.state !== 'settled');
  const actual = Number(settled.reduce((sum, entry) => sum + BigInt(entry.actual), 0n)) / 1e12;
  return { costUsd: pending.length ? null : actual, authoritativeSettledCostUsd: actual,
    pendingReservationUsd: Number(pending.reduce((sum, entry) => sum + BigInt(entry.reserved), 0n)) / 1e12,
    budgetRequestIds: entries.map((entry) => entry.id), budgetRequestLimits: entries.map(({ id, model, requestedLimits }) => ({ id, model, requestedLimits: requestedLimits ?? null })), budgetPendingRequests: pending.length };
}

export function mergeBrowserCalls(hubCalls, providerCalls, providerResults) {
  const idOf = (call) => call.mcp?.toolUseId ?? call.hub?.toolUseId ?? call.callId;
  const hubById = new Map(hubCalls.filter((call) => idOf(call)).map((call) => [idOf(call), call]));
  const matched = new Set();
  const merged = providerCalls.map((call) => {
    const hub = hubById.get(call.callId);
    if (hub) matched.add(hub);
    const result = providerResults.find((entry) => entry.callId === call.callId);
    return { ...call, ok: result?.ok ?? hub?.ok, error: result?.ok === false ? result.resultPreview : hub?.error,
      correlatedPipeline: !!hub, uncorrelatedHub: false };
  });
  return [...merged, ...hubCalls.filter((call) => !matched.has(call)).map((call) => ({ ...call, correlatedPipeline: false, uncorrelatedHub: true }))];
}

export function browserFailureConsistency(hubCalls, providerCalls, providerResults) {
  const tool = (name) => String(name ?? '').replace(/^mcp__rhwp__/, '');
  const code = (error) => /\b(BROWSER_[A-Z_]+|[A-Z]+_[A-Z_]+)\b/.exec(String(error ?? ''))?.[1] ?? 'UNCLASSIFIED';
  const count = (rows) => rows.reduce((map, row) => {
    const key = tool(row.tool) + ':' + code(row.error);
    map.set(key, (map.get(key) ?? 0) + 1);
    return map;
  }, new Map());
  const hubFailures = hubCalls.filter((call) => /browser/.test(call.tool) && call.ok === false);
  const providerFailures = providerResults.filter((result) => result.ok === false).map((result) => ({
    tool: providerCalls.find((call) => call.callId === result.callId)?.tool,
    error: result.resultPreview,
  }));
  const hubCounts = count(hubFailures);
  const providerCounts = count(providerFailures);
  const missing = [...hubCounts].filter(([key, n]) => n > (providerCounts.get(key) ?? 0))
    .map(([key, n]) => ({ error: key, hubCount: n, providerCount: providerCounts.get(key) ?? 0 }));
  return { source: 'provider-call-id', consistent: missing.length === 0,
    hubFailures: hubFailures.length, providerFailures: providerFailures.length, missingHubFailureCounts: missing };
}

function structuredToolFailure(value, depth = 0) {
  if (!value || depth > 8) return false;
  if (typeof value === 'string') { try { return structuredToolFailure(JSON.parse(value), depth + 1); } catch { return false; } }
  if (Array.isArray(value)) return value.some((item) => structuredToolFailure(item, depth + 1));
  if (typeof value !== 'object' || value.snapshotId) return false;
  if (value.ok === false || value.isError === true || typeof value.error?.code === 'string') return true;
  return ['result', 'structuredContent', 'content'].some((key) => structuredToolFailure(value[key], depth + 1))
    || value.type === 'text' && structuredToolFailure(value.text, depth + 1);
}

/** 허브 런타임 실패가 기준이다. ID 없는 경로는 오류 코드별 개수만 보수적으로 조정한다. */
export function measureBrowserFailures(hubCalls, providerCalls, providerResults, validation = {}) {
  const normalize = (name) => String(name ?? '').replace(/^mcp__rhwp__/, '');
  const key = (call) => normalize(call.tool) + ':' + (/\b(BROWSER_[A-Z_]+|[A-Z]+_[A-Z_]+)\b/.exec(String(call.error ?? ''))?.[1] ?? 'UNCLASSIFIED');
  const measured = hubCalls.filter((call) => /browser/.test(call.tool)).map((call) => ({ ...call, source: 'hub-runtime' }));
  const coverage = new Map();
  for (const call of measured.filter((call) => call.ok === false)) coverage.set(key(call), (coverage.get(key(call)) ?? 0) + 1);
  let providerExcess = 0, aggregateCovered = 0, structuredOverrides = 0;
  for (const result of providerResults) {
    if (result.ok !== false && !structuredToolFailure(result.resultPreview)) continue;
    const call = providerCalls.find((entry) => entry.callId === result.callId);
    if (!call) continue;
    const failure = { ...call, ok: false, error: result.resultPreview, source: 'provider-prehub-or-excess' };
    const exact = measured.find((entry) => (entry.mcp?.toolUseId ?? entry.hub?.toolUseId ?? entry.callId) === result.callId);
    if (exact) {
      if (exact.ok !== false) { Object.assign(exact, failure, { source: 'provider-structured-result' }); structuredOverrides++; }
      const k = key(failure);
      coverage.set(k, Math.max(0, (coverage.get(k) ?? 0) - 1));
      continue;
    }
    const k = key(failure);
    if ((coverage.get(k) ?? 0) > 0) { coverage.set(k, coverage.get(k) - 1); aggregateCovered++; }
    else { measured.push(failure); providerExcess++; }
  }
  const diagnostics = browserFailureConsistency(hubCalls, providerCalls, providerResults);
  return { ...browserFailureMetrics(measured, validation),
    failureCountSource: 'hub-runtime-plus-provider-excess-by-tool-and-error-code',
    failureReconciliation: { ...diagnostics, providerExcess, aggregateCovered, structuredOverrides,
      uncorrelatedHubFailures: hubCalls.filter((call) => call.ok === false && !call.mcp?.toolUseId && !call.callId).length,
      identityPolicy: 'Exact IDs when present; aggregate error counts do not assert cross-call identity.' } };
}

export function summarizeBrowserRuns(rows) {
  const allRows = rows;
  rows = rows.filter((row) => !isInfrastructureError(row));
  const keys = [...new Set(allRows.map((row) => row.task + '\0' + row.arm))];
  return keys.map((key) => {
    const [task, arm] = key.split('\0');
    const group = rows.filter((row) => row.task === task && row.arm === arm);
    const attempts = allRows.filter((row) => row.task === task && row.arm === arm);
    const successful = group.filter((row) => row.passed && !row.blocked);
    return {
      task, arm, runs: group.length, passed: successful.length,
      harnessErrors: attempts.filter((row) => row.status === 'harness-error').length,
      providerErrors: attempts.filter((row) => row.status === 'provider-error').length,
      measurementInsufficient: attempts.filter((row) => row.status === 'measurement-insufficient').length,
      costUsd: attempts.every((row) => Number.isFinite(row.costUsd)) ? attempts.reduce((sum, row) => sum + row.costUsd, 0) : null,
      pendingReservationUsd: attempts.reduce((sum, row) => sum + (row.pendingReservationUsd ?? 0), 0),
      blocked: group.filter((row) => row.blocked).length,
      failed: group.filter((row) => !row.passed && !row.blocked).length,
      medianWallMs: median(successful.map((row) => row.wallMs)),
      medianAllWallMs: median(group.map((row) => row.wallMs)),
      invalidCalls: group.reduce((n, row) => n + (row.invalidCalls ?? 0), 0),
      clickFailures: group.reduce((n, row) => n + (row.clickFailures ?? 0), 0),
      navigationFailures: group.reduce((n, row) => n + (row.navigationFailures ?? 0), 0),
    };
  });
}

export function browserDeadlineBudget(authority, { scoringDefinitionHash, semanticTaskManifestHash } = {}) {
  if (!authority?.canonicalSourceSha256 || !/^[a-f0-9]{64}$/.test(authority.canonicalSourceSha256)
    || !authority.scoringDefinitionHash || !authority.semanticTaskManifestHash
    || scoringDefinitionHash && authority.scoringDefinitionHash !== scoringDefinitionHash
    || semanticTaskManifestHash && authority.semanticTaskManifestHash !== semanticTaskManifestHash
    || !authority.taskLimits || !Object.values(authority.taskLimits).every(limit => Number.isFinite(limit) && limit > 0)
    || !Number.isFinite(authority.fallbackTimeoutMs) || authority.fallbackTimeoutMs <= 0) {
    throw new Error('Canonical deadline authority changed or is unverified.');
  }
  return { taskLimits: authority.taskLimits, fallbackTimeoutMs: authority.fallbackTimeoutMs };
}

export function compareBrowserRuns(baseline, current) {
  const reportedModels = rows => {
    if (!rows.length || rows.some(row => row.modelProof?.verified !== true || !row.modelProof.reports?.length)) return null;
    const sets = rows.map(row => JSON.stringify([...new Set(row.modelProof.reports.map(report => JSON.stringify([report.model, report.provider ?? null])))].sort()));
    return new Set(sets).size === 1 ? sets[0] : null;
  };
  const eligible = (rows) => rows.length === 3 && rows.every((row) => row.passed && !row.blocked && row.status === 'done' && Number.isFinite(row.wallMs));
  const priorDeadline = baseline.meta.deadlineAuthority, nextDeadline = current.meta.deadlineAuthority;
  let sameDeadlineAuthority = false;
  try {
    for (const data of [baseline, current]) {
      const scoringDefinitionHash = data.meta.scoringDefinitionHash ?? data.meta.taskDefinitionHash;
      if (!scoringDefinitionHash || !data.meta.semanticTaskManifestHash) throw new Error('Missing deadline scope.');
      browserDeadlineBudget(data.meta.deadlineAuthority, { scoringDefinitionHash, semanticTaskManifestHash: data.meta.semanticTaskManifestHash });
    }
    sameDeadlineAuthority = isDeepStrictEqual(priorDeadline, nextDeadline);
  } catch {}

  const pairs = [...new Set(current.runs.map((row) => row.task + '\0' + row.arm))].map((key) => {
    const [task, arm] = key.split('\0');
    const before = baseline.runs.filter((row) => row.task === task && row.arm === arm);
    const after = current.runs.filter((row) => row.task === task && row.arm === arm);
    const priorArm = baseline.meta.armDefinitions?.find(definition => definition.id === arm);
    const nextArm = current.meta.armDefinitions?.find(definition => definition.id === arm);
    const sameArm = !!priorArm && !!nextArm && isDeepStrictEqual(priorArm, nextArm);
    const priorModels = reportedModels(before), nextModels = reportedModels(after);
    const sameReportedModels = !!priorModels && priorModels === nextModels;
    const priorScoring = baseline.meta.scoringDefinitionHash ?? baseline.meta.taskDefinitionHash;
    const nextScoring = current.meta.scoringDefinitionHash ?? current.meta.taskDefinitionHash;
    const corrected = !!baseline.meta.scoringDefinitionHash || !!current.meta.scoringDefinitionHash;
    const sameTask = !!priorScoring && priorScoring === nextScoring && (!corrected ||
      !!baseline.meta.semanticTaskManifestHash && baseline.meta.semanticTaskManifestHash === current.meta.semanticTaskManifestHash);
    const timezone = current.meta.benchmarkTimezone;
    const sameDay = timezone === BENCHMARK_TIMEZONE && baseline.meta.benchmarkTimezone === timezone
      && baseline.meta.benchmarkDay === current.meta.benchmarkDay
      && [baseline.meta.startedAt, baseline.meta.finishedAt, current.meta.startedAt, current.meta.finishedAt]
        .every((timestamp) => benchmarkDay(timestamp, timezone) === current.meta.benchmarkDay)
      && [...before, ...after].every((row) => [row.startedAt, row.finishedAt, row.turnStartedAt ?? row.startedAt, row.turnEndedAt ?? row.finishedAt]
        .every((timestamp) => benchmarkDay(timestamp, timezone) === current.meta.benchmarkDay));
    const sameEffort = baseline.meta.effort === current.meta.effort && matchingBrowserEffort(before, baseline.meta.effort) && matchingBrowserEffort(after, current.meta.effort);
    const requiredLimitMs = sameDeadlineAuthority ? priorDeadline.taskLimits[task] ?? priorDeadline.fallbackTimeoutMs : null;
    const deadlineEligible = sameDeadlineAuthority && Number.isFinite(requiredLimitMs) && after.length > 0 && after.every(row => Number.isFinite(row.limitMs) && row.limitMs >= requiredLimitMs);
    const valid = deadlineEligible && sameEffort && eligible(before) && eligible(after) && sameTask && sameDay && sameArm && sameReportedModels;
    return { task, arm, eligible: valid, deadline: { requiredLimitMs, recordedLimitMs: after.map(row => row.limitMs ?? null), authorityMatches: sameDeadlineAuthority, eligible: deadlineEligible }, attemptCounts: { baseline: before.length, current: after.length }, baselinePassed: before.filter((row) => row.passed && !row.blocked).length,
      currentPassed: after.filter((row) => row.passed && !row.blocked).length,
      speedup: valid ? median(before.map((row) => row.wallMs)) / median(after.map((row) => row.wallMs)) : null,
      reason: valid ? null : !sameDeadlineAuthority ? 'deadline-authority-changed-or-unverified' : !deadlineEligible ? 'recorded-deadline-shorter-than-corrected-reference' : !sameEffort ? 'effort-changed-or-unverified' : !sameArm ? 'arm-configuration-changed' : !sameReportedModels ? 'reported-model-changed-or-missing' : !sameTask ? 'task-definition-changed' : !sameDay ? 'different-benchmark-calendar-day' : before.length !== 3 || after.length !== 3 ? 'requires-exactly-three-observed-attempts' : 'requires-three-of-three-successes',
    };
  });
  const arms = [...new Set(pairs.map((pair) => pair.arm))].map((arm) => {
    const selected = pairs.filter((pair) => pair.arm === arm);
    const comparable = selected.filter((pair) => pair.eligible);
    const count = (data, metric) => data.runs.filter((row) => row.arm === arm && selected.some((pair) => pair.task === row.task))
      .reduce((sum, row) => sum + (row[metric] ?? 0), 0);
    const failureMetrics = Object.fromEntries(['invalidCalls', 'clickFailures', 'navigationFailures'].map(metric => {
      const before = count(baseline, metric), after = count(current, metric);
      return [metric, { before, after, regressed: after > before }];
    }));
    const failuresRegressed = Object.values(failureMetrics).some(metric => metric.regressed);
    const medianSpeedup = median(comparable.map((pair) => pair.speedup));
    return { arm, eligibleTasks: comparable.length, totalTasks: selected.length, medianSpeedup, failureMetrics,
      failuresRegressed, targetMet: comparable.length === selected.length && selected.length === 10 && !failuresRegressed && medianSpeedup >= 2 };
  });
  return { pairs, arms };
}

/** 모델 답변은 읽지 않고, 실제 도구 결과 메시지에서만 전체 DOM 관측을 추출한다. */
export function browserSnapshotsFromTranscripts(files, { fixtureRoot, artifactDir, verifiedCallIds, calls = [], attachments = [] } = {}) {
  const snapshots = [];
  const callsById = new Map(calls.map(call => [call.callId, call]));
  const verified = id => !verifiedCallIds || verifiedCallIds.has(id);
  const decode = (value) => {
    if (typeof value === 'string') { try { return decode(JSON.parse(value)); } catch { return; } }
    if (!value || typeof value !== 'object') return;
    if (typeof value.snapshotId === 'string' && typeof value.tabId === 'string' && typeof value.url === 'string' && typeof value.text === 'string') {
      snapshots.push({ snapshotId: value.snapshotId, tabId: value.tabId, url: value.url, title: value.title, text: value.text, elements: value.elements, navigationEpoch: value.navigationEpoch, controllerEpoch: value.controllerEpoch });
      return;
    }
    if (Array.isArray(value)) { for (const item of value) decode(item); return; }
    for (const key of ['snapshot', 'result', 'content', 'text', 'structuredContent']) if (Object.hasOwn(value, key)) decode(value[key]);
  };
  const attachment = (block, tool) => {
    if (!fixtureRoot || !artifactDir || !verifiedCallIds?.has(block.tool_use_id) || block.is_error === true || typeof block.content !== 'string') return;
    // SDK truncation envelope only. A path nested in page JSON is never followed.
    const notice = /^Error: result \([\d,]+ characters across [\d,]+ lines?\) exceeds maximum allowed tokens\. Output has been saved to ([^\r\n]+)\.\nFormat: Plain text\nSearch within the file for specific content, and use jq if the content is JSON\.\nREQUIREMENTS FOR SUMMARIZATION\/ANALYSIS\/REVIEW:\n/.exec(block.content);
    if (!notice) return;
    const file = notice[1], root = path.resolve(fixtureRoot);
    const relative = path.relative(root, file);
    const action = String(tool).replace(/^mcp__rhwp__/, '');
    if (!path.isAbsolute(file) || path.resolve(file) !== file || relative.startsWith('..') || path.isAbsolute(relative)
      || !/^sessions\/[^/]+\/home\/\.claude\/projects\/[^/]+\/[^/]+\/tool-results\/mcp-rhwp-browser_[a-z]+-\d+\.txt$/.test(relative)
      || !path.basename(file).startsWith('mcp-rhwp-' + action + '-')) return;
    try {
      let current = root;
      if (fs.lstatSync(current).isSymbolicLink()) return;
      for (const part of relative.split(path.sep)) {
        current = path.join(current, part);
        if (fs.lstatSync(current).isSymbolicLink()) return;
      }
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.size > 16 * 1024 * 1024 || fs.realpathSync(file) !== file) return;
      const bytes = fs.readFileSync(file);
      const value = JSON.parse(bytes.toString('utf8'));
      if (structuredToolFailure(value)) return;
      const before = snapshots.length;
      decode(value);
      const found = snapshots.slice(before);
      if (!found.length) return;
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      const saved = path.join(artifactDir, 'browser-results', sha256 + '.json');
      atomicJson(saved, { callId: block.tool_use_id, tool, sha256, snapshots: found });
      if (!attachments.some(item => item.callId === block.tool_use_id && item.sha256 === sha256)) attachments.push({ callId: block.tool_use_id, tool, source: relative, sha256, bytes: stat.size, saved, snapshotIds: found.map(s => s.snapshotId) });
    } catch { /* Missing or malformed attachments cannot establish browser state. */ }
  };
  for (const file of files) {
    const names = new Map();
    let source;
    try { source = fs.readFileSync(file, 'utf8'); } catch { continue; }
    for (const line of source.split('\n')) {
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      if (row.kind) { if (row.kind !== 'out' || !row.json) continue; row = row.json; }
      const message = row.message;
      if (message?.role === 'toolResult' && /browser_/.test(message.toolName ?? '') && verified(message.toolCallId) && !message.isError && !structuredToolFailure(message.content)) decode(message.content);
      const blocks = Array.isArray(message?.content) ? message.content : [];
      for (const block of blocks) {
        if (message?.role === 'assistant' && block.type === 'tool_use') names.set(block.id, block.name);
        const tool = names.get(block.tool_use_id);
        if (message?.role === 'user' && block.type === 'tool_result' && /browser_/.test(tool ?? '') && verified(block.tool_use_id) && block.is_error !== true && !structuredToolFailure(block.content)) {
          decode(block.content);
          attachment(block, tool);
        }
      }
      // Codex app-server records completed MCP calls directly, not response_item.
      const completed = row.method === 'item/completed' ? row.params?.item : null;
      const call = callsById.get(completed?.id);
      if (completed?.type === 'mcpToolCall' && completed.server === 'rhwp' && completed.status === 'completed'
        && completed.error === null && call && verified(completed.id) && completed.tool === call.tool
        && /^browser_[a-z_]+$/.test(completed.tool) && isDeepStrictEqual(completed.arguments, call.args)
        && !structuredToolFailure(completed.result)) decode(completed.result);
      const item = row.type === 'response_item' ? row.payload : null;
      if (item?.type === 'function_call') names.set(item.call_id, item.name);
      if (item?.type === 'function_call_output' && /browser_/.test(names.get(item.call_id) ?? '') && verified(item.call_id) && !structuredToolFailure(item.output)) decode(item.output);
    }
  }
  return [...new Map(snapshots.map((snapshot) => [snapshot.snapshotId, snapshot])).values()];
}

/** Private hub receipts only: no transcript prefixes or cross-call guesses. */
export function browserSnapshotsFromSidecar(file, { actor, turnId, agent, calls = [], verifiedCallIds = new Set(), captureFailures = [] } = {}) {
  const snapshots = [], receipts = [], errors = captureFailures.map(failure => isDeepStrictEqual(failure.actor, actor) && failure.hub?.turnId === turnId && failure.hub?.agent === agent
    ? 'snapshot-capture-' + (/^[a-z-]+$/.test(failure.code) ? failure.code : 'failed') : 'snapshot-sidecar-scope-mismatch');
  const expected = calls.filter(call => verifiedCallIds.has(call.callId));
  const needsSnapshot = expected.some(call => call.tool === 'browser_snapshot' || call.args?.snapshot !== false
    && /^browser_(?:open|navigate|click|type|press|scroll|wait)$/.test(call.tool));
  if (!fs.existsSync(file)) return { snapshots, receipts, errors: [...errors, ...(needsSnapshot ? ['snapshot-sidecar-missing'] : [])] };
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) || stat.size > 64 * 1024 * 1024) throw new Error('snapshot-sidecar-insecure-or-oversized');
    const bytes = fs.readFileSync(file), sourceSha256 = createHash('sha256').update(bytes).digest('hex');
    if (!actor?.sessionId || !actor?.threadId || !turnId || actor.isHuman !== false || actor.taskId !== null) throw new Error('snapshot-sidecar-scope-unavailable');
    const seen = new Set();
    for (const line of bytes.toString('utf8').split('\n').filter(Boolean)) {
      const row = JSON.parse(line);
      if (row.schema !== 1 || !isDeepStrictEqual(row.actor, actor) || row.hub?.turnId !== turnId || row.hub?.agent !== agent) throw new Error('snapshot-sidecar-scope-mismatch');
      if (row.kind === 'browser-snapshot-capture-error') { errors.push(row.code ?? 'snapshot-capture-error'); continue; }
      const matches = expected.filter(call => call.callId === row.callId && call.tool === row.tool && browserEvidenceArgsHash(call.args) === row.argsHash);
      if (row.kind !== 'browser-snapshot' || matches.length !== 1 || !Number.isSafeInteger(row.hub.seq) || row.hub.seq <= 0 || !Number.isSafeInteger(row.hub.clientId)) throw new Error('snapshot-sidecar-receipt-mismatch');
      const call = matches[0], snapshot = row.snapshot;
      for (const key of ['tabId', 'snapshotId', 'navigationEpoch', 'controllerEpoch', 'ref']) if (call.args?.[key] !== undefined && row.args?.[key] !== call.args[key]) throw new Error('snapshot-sidecar-args-mismatch');
      if (!snapshot || typeof snapshot.snapshotId !== 'string' || typeof snapshot.tabId !== 'string' || typeof snapshot.url !== 'string' || typeof snapshot.text !== 'string' || !Array.isArray(snapshot.elements)
        || !Number.isSafeInteger(snapshot.navigationEpoch) || !Number.isSafeInteger(snapshot.controllerEpoch) || call.args?.tabId && call.args.tabId !== snapshot.tabId) throw new Error('snapshot-sidecar-invalid-snapshot');
      if (seen.has(snapshot.snapshotId)) throw new Error('snapshot-sidecar-duplicate-snapshot');
      seen.add(snapshot.snapshotId);
      snapshots.push(snapshot);
      receipts.push({ callId: row.callId, tool: row.tool, argsHash: row.argsHash, hub: row.hub, snapshotId: snapshot.snapshotId, sourceSha256 });
    }
    if (needsSnapshot && !snapshots.length && !errors.length) errors.push('snapshot-sidecar-empty');
  } catch (error) { errors.push(/^snapshot-sidecar-[a-z-]+$/.test(error.message) ? error.message : 'snapshot-sidecar-malformed'); }
  return { snapshots: errors.length ? [] : snapshots, receipts, errors };
}

/** Actual process/request envelopes, never assistant prose or a legacy default. */
export function browserReportedEffort(files, { agent, requested, modelProof } = {}) {
  const reports = [], sources = [];
  const trustedSources = new Set(modelProof?.verified ? modelProof.reports?.map(report => report.sourceSha256) : []);
  const reportedModels = new Set(modelProof?.reports?.map(report => report.model));
  for (const file of files) {
    let source;
    try { source = fs.readFileSync(file, 'utf8'); } catch { continue; }
    const sourceSha256 = createHash('sha256').update(source).digest('hex');
    const selected = trustedSources.has(sourceSha256);
    sources.push({ sourceSha256, selected });
    if (!selected) continue;
    const rows = source.split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
    const threadRequests = new Set(rows.filter(row => row.kind === 'in' && ['thread/start', 'thread/resume'].includes(row.json?.method)).map(row => row.json.id));
    const threads = new Set(rows.filter(row => row.kind === 'out' && threadRequests.has(row.json?.id) && !row.json?.error && reportedModels.has(row.json?.result?.model))
      .map(row => row.json.result.thread?.id ?? row.json.result.threadId).filter(Boolean));
    const actualTurns = rows.filter(row => row.kind === 'in' && row.json?.method === 'turn/start' && threads.has(row.json.params?.threadId));
    if (agent === 'codex' && !actualTurns.length) continue;
    for (const row of rows) {
      const record = (effort, kind) => { if (typeof effort === 'string' && effort) reports.push({ effort, source: kind, sourceSha256 }); };
      if (row.kind === 'spawn' && Array.isArray(row.argv)) {
        for (let i = 0; i < row.argv.length; i++) {
          if (agent === 'claude' && row.argv[i] === '--effort') record(row.argv[i + 1], 'spawn-effort');
          if (agent === 'codex' && row.argv[i] === '-c') {
            const match = String(row.argv[i + 1]).match(/^model_reasoning_effort\s*=\s*("[^"\r\n]+"|'[^'\r\n]+'|[a-z]+)$/);
            if (match) record(match[1].replace(/^['"]|['"]$/g, ''), 'spawn-reasoning-effort');
          }
        }
      }
      if (agent === 'codex' && actualTurns.includes(row)) {
        record(row.json.params?.effort, 'turn-start-effort');
        record(row.json.params?.collaborationMode?.settings?.reasoning_effort, 'collaboration-reasoning-effort');
      }
    }
  }
  const required = agent === 'claude' ? ['spawn-effort'] : agent === 'codex' ? ['spawn-reasoning-effort', 'turn-start-effort'] : [];
  const complete = required.length > 0 && required.every(source => reports.some(report => report.source === source));
  const verified = complete && typeof requested === 'string' && reports.every(report => report.effort === requested);
  return { requested, reports, sources, verified, reason: verified ? null : !complete ? 'provider-effort-unverified' : 'provider-effort-mismatch' };
}
const matchingBrowserEffort = (rows, expected) => typeof expected === 'string' && expected.length > 0 && rows.length > 0
  && rows.every(row => row.effortProof?.verified === true && row.effortProof.requested === expected
    && row.effortProof.reports?.length > 0 && row.effortProof.reports.every(report => report.effort === expected));

/** Provider envelopes only. Requested options and assistant prose are not model proof. */
export function browserReportedModel(files, { agent, requested } = {}) {
  const reports = [];
  for (const file of files) {
    let source;
    try { source = fs.readFileSync(file, 'utf8'); } catch { continue; }
    const threadRequests = new Set(), sourceSha256 = createHash('sha256').update(source).digest('hex');
    for (const line of source.split('\n')) {
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      const event = row.json;
      if (!event) continue;
      if (agent === 'codex' && row.kind === 'in' && ['thread/start', 'thread/resume'].includes(event.method)) threadRequests.add(event.id);
      if (row.kind !== 'out') continue;
      if (agent === 'claude' && event.type === 'assistant' && typeof event.message?.model === 'string') {
        reports.push({ model: event.message.model, source: 'assistant-message-model', sourceSha256 });
      }
      if (agent === 'codex' && threadRequests.has(event.id) && !event.error && typeof event.result?.model === 'string') {
        reports.push({ model: event.result.model, provider: event.result.modelProvider, source: 'thread-initialization-ack', sourceSha256 });
      }
    }
  }
  const matches = report => agent === 'claude' && requested === 'claude-haiku-5-5'
    ? /^claude-haiku-5-5(?:-\d{8})?$/.test(report.model)
    : report.model === requested && (agent !== 'codex' || report.provider === 'openai');
  const unique = [...new Map(reports.map(report => [report.source + ':' + report.model + ':' + (report.provider ?? ''), report])).values()];
  return { requested, reports: unique, verified: unique.length > 0 && unique.every(matches),
    reason: !unique.length ? 'provider-model-unverified' : unique.every(matches) ? null : 'provider-model-mismatch' };
}

function transcriptFiles(root, extension = '.jsonl') {
  const files = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile() && entry.name.endsWith(extension)) files.push(file);
    }
  };
  if (fs.existsSync(root)) visit(root);
  return files;
}

const requestBrowser = (page, action, args = {}) => page.evaluate(
  (a, b) => window.__agentBridge.requestBrowser(a, b), action, args,
);

async function inspectBrowser(page) {
  const inventory = await requestBrowser(page, 'status');
  if (inventory.runtime?.mode !== 'managed' || inventory.runtime?.headless !== true) {
    throw new Error('Benchmark requires the managed headless browser.');
  }
  const snapshots = [];
  const inspectionErrors = [];
  for (const tab of inventory.tabs ?? []) {
    if (tab.status === 'closed' || tab.url === 'about:blank') continue;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const current = attempt ? (await requestBrowser(page, 'status')).tabs.find((item) => item.tabId === tab.tabId) : tab;
        if (!current) break;
        const result = await requestBrowser(page, 'snapshot', {
          tabId: current.tabId, navigationEpoch: current.navigationEpoch, controllerEpoch: current.controllerEpoch,
        });
        if (result.snapshot) snapshots.push(result.snapshot);
        break;
      } catch (error) {
        if (attempt < 2 && /changed while|stale|snapshot/i.test(error.message)) continue;
        inspectionErrors.push({ tabId: tab.tabId, error: String(error.message) });
        break;
      }
    }
  }
  const result = await requestBrowser(page, 'downloads', { action: 'list' });
  return { tabs: inventory.tabs ?? [], snapshots, downloads: result.downloads ?? [], inspectionErrors, runtime: inventory.runtime };
}

async function captureBrowserEvents(page) {
  await page.evaluate(() => {
    window.__browserBench = { events: [], calls: [], results: [] };
    if (window.__browserBenchInstalled) return;
    window.__browserBenchInstalled = true;
    window.__agentBridge.onEvent((event) => {
      const store = window.__browserBench;
      if (event.type === 'browser-event') store.events.push(event.event);
      const inner = event.type === 'agent' ? event.event : null;
      if (!inner || inner.parentTaskId) return;
      if (inner.type === 'tool-call' && /browser/.test(inner.tool ?? '')) {
        let args = {};
        try { args = JSON.parse(inner.argsJson ?? '{}'); } catch {}
        store.calls.push({ tool: inner.tool, callId: inner.callId, args, t: Date.now() });
      } else if (inner.type === 'tool-result') {
        const tool = store.calls.find((call) => call.callId === inner.callId)?.tool;
        if (!tool) return;
        store.results.push({ tool, callId: inner.callId, ok: inner.ok, resultPreview: inner.resultPreview, t: Date.now() });
      }
    });
  });
}

function quotaGate() {
  const gate = path.join(os.homedir(), '.claude/skills/pr-parity-watch/scripts/gate.sh');
  if (!fs.existsSync(gate)) throw new Error('Quota gate is missing; refusing provider run.');
  execFileSync('bash', [gate], { stdio: 'inherit', timeout: 30_000 });
}

function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(redactTranscriptJson(value), null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(temp, file);
}

/** 추적 파일과 새 런타임 모듈만 읽는다. 코퍼스·브라우저 캐시는 순회하지 않는다. */
export function runtimeSourceFingerprint({ repoRoot, harnessRoot, git = (args) => execFileSync('git', args, { cwd: repoRoot }) }) {
  const hash = createHash('sha256').update(git(['rev-parse', 'HEAD'])).update(git(['diff', 'HEAD', '--binary', '--no-ext-diff']));
  const areas = ['rhwp/rhwp-agent', 'rhwp/rhwp-studio', 'desktop', 'rhwp-shared'];
  const untracked = String(git(['ls-files', '--others', '--exclude-standard', '-z', '--', ...areas])).split('\0').filter(Boolean).sort();
  for (const relative of untracked) {
    if (!areas.some((area) => relative.startsWith(area + '/')) || /(?:^|\/)(?:tests?|__fixtures__|node_modules|samples|artifacts|dist|build|pkg|\.tools)(?:\/|$)|\.test\.[cm]?[jt]s$/.test(relative)) continue;
    const runtime = /\.(?:[cm]?js|ts|json|ya?ml|toml)$/.test(relative)
      || /(?:^|\/)(?:AGENTS|CLAUDE|SKILL)\.md$/.test(relative)
      || /\/(?:assets|skills|harness|prompts|pi-assets)\/.*\.md$/.test(relative);
    if (!runtime) continue;
    const file = path.resolve(repoRoot, relative);
    if (!file.startsWith(path.resolve(repoRoot) + path.sep) || !fs.lstatSync(file).isFile()) throw new Error('Untracked runtime paths must be regular repository files.');
    hash.update(relative + '\0').update(fs.readFileSync(file)).update('\0');
  }
  for (const name of ['browser-agent-suite.mjs', 'browser-agent-tasks.mjs', 'browser-agent-budget.mjs', 'agent-live-common.mjs']) {
    hash.update(name + '\0').update(fs.readFileSync(path.join(harnessRoot, 'rhwp/rhwp-studio/bench', name))).update('\0');
  }
  return hash.digest('hex');
}

export function preserveBrowserDiagnostics({ artifactDir, traceFile, capture, turn }) {
  fs.mkdirSync(artifactDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(artifactDir, 0o700);
  if (traceFile && fs.existsSync(traceFile)) {
    const target = path.join(artifactDir, 'tool-trace.jsonl');
    fs.copyFileSync(traceFile, target);
    fs.chmodSync(target, 0o600);
  }
  if (capture) {
    atomicJson(path.join(artifactDir, 'capture.json'), capture);
    atomicJson(path.join(artifactDir, 'terminal.json'), { rawTurn: turn,
      terminalEvents: capture.events.filter((event) => ['turn-end', 'error', 'hub-error'].includes(event.type)) });
  }
}

async function main() {
  const repoRoot = path.resolve(arg('repo-root') ?? fileURLToPath(new URL('../../../', import.meta.url)));
  const tasks = selectBrowserTasks(arg('tasks'));
  const label = arg('label') ?? 'baseline';
  if (!['baseline', 'final', 'candidate'].includes(label)) throw new Error('Unknown round label.');
  const armIds = arg('arms')?.split(',');
  const arms = browserArms.filter((arm) => (!armIds || armIds.includes(arm.id)));
  if (!arms.length || armIds?.some((id) => !browserArms.some((arm) => arm.id === id))) throw new Error('Unknown or empty arms.');
  const budgetUsd = Number(arg('budget-usd') ?? 10);
  if (!Number.isFinite(budgetUsd) || budgetUsd <= 0 || !Number.isSafeInteger(budgetUsd * 1e12)) throw new Error('budget-usd must be positive finite USD in exact picodollars.');
  const probe = process.argv.includes('--probe');
  if (!probe && !process.argv.includes('--execute')) {
    console.log(JSON.stringify({ arms, tasks: tasks.map(({ id, prompt, urls }) => ({ id, prompt, urls })), execution: 'Pass --probe for no-model site checks or --execute for subscription provider turns.' }, null, 2));
    return;
  }
  const out = path.resolve(arg('out') ?? path.join(repoRoot, 'output/browser-agent-' + label + '.json'));
  const reps = Number(arg('reps') ?? 3);
  if (!Number.isSafeInteger(reps) || reps < 1 || reps > 3) throw new Error('reps must be 1..3.');
  const effort = arg('effort') ?? 'medium';
  if (!/^[a-z][a-z0-9-]*$/.test(effort)) throw new Error('Invalid effort.');
  const baselineFile = arg('baseline');
  if (!probe && label !== 'baseline' && !baselineFile) throw new Error('Final/candidate requires --baseline.');
  const comparisonFiles = (arg('compare-to') ?? baselineFile ?? '').split(',').filter(Boolean).map((file) => path.resolve(file));
  const references = comparisonFiles.map((file) => ({ file, data: JSON.parse(fs.readFileSync(file)) }));
  const baseline = baselineFile ? JSON.parse(fs.readFileSync(baselineFile)) : null;
  const attachDeadlineAuthority = (data, file) => {
    if (!data || data.meta.deadlineAuthority || data.meta.label !== 'baseline') return;
    data.meta.deadlineAuthority = {
      canonicalSourceSha256: createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
      scoringDefinitionHash: data.meta.scoringDefinitionHash ?? data.meta.taskDefinitionHash,
      semanticTaskManifestHash: data.meta.semanticTaskManifestHash,
      taskLimits: baselineLimits(data.runs), fallbackTimeoutMs: data.meta.timeoutMs ?? 300000,
    };
  };
  attachDeadlineAuthority(baseline, baselineFile);
  for (const { data, file } of references) attachDeadlineAuthority(data, file);
  for (const { data } of references) if (arms.some(arm => !isDeepStrictEqual(data.meta.armDefinitions?.find(definition => definition.id === arm.id), arm))) {
    throw new Error('Reference arm model/backend configuration changed; record a fresh baseline.');
  }

  for (const { data } of references) if (data.meta.effort !== effort || !matchingBrowserEffort(data.runs.filter(row => arms.some(arm => arm.id === row.arm)), effort)) {
    throw new Error('Reference effort changed or lacks actual provider proof; audit provenance before comparison.');
  }
  const currentScoringHash = createHash('sha256').update(fs.readFileSync(new URL('./browser-agent-tasks.mjs', import.meta.url))).digest('hex');
  const currentSemanticHash = createHash('sha256').update(JSON.stringify(tasks.map(({ id, prompt, urls }) => ({ id, prompt, urls })))).digest('hex');
  for (const { data } of references) {
    const authority = data.meta.deadlineAuthority;
    browserDeadlineBudget(authority, { scoringDefinitionHash: currentScoringHash, semanticTaskManifestHash: currentSemanticHash });
    if (!isDeepStrictEqual(authority, baseline?.meta.deadlineAuthority)) throw new Error('Reference canonical deadline authority changed.');
  }
  const deadlineBudget = baseline ? browserDeadlineBudget(baseline.meta.deadlineAuthority, { scoringDefinitionHash: currentScoringHash, semanticTaskManifestHash: currentSemanticHash }) : null;
  const limits = deadlineBudget?.taskLimits ?? {};
  const fallbackTimeoutMs = deadlineBudget?.fallbackTimeoutMs ?? 300000;
  const timeoutMs = Number(arg('timeout-ms') ?? 300000);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 900000) throw new Error('timeout-ms must be 1000..900000.');
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
  const diff = execFileSync('git', ['diff', 'HEAD', '--stat'], { cwd: repoRoot, encoding: 'utf8' }).trim();
  const harnessRoot = fileURLToPath(new URL('../../../', import.meta.url));
  const sourceFingerprint = () => runtimeSourceFingerprint({ repoRoot, harnessRoot });
  const fingerprint = sourceFingerprint();
  const previous = fs.existsSync(out) ? JSON.parse(fs.readFileSync(out)) : null;
  const taskIds = tasks.map((task) => task.id);
  if (previous && (previous.meta.timeoutMs !== timeoutMs || previous.meta.effort !== effort || !isDeepStrictEqual(previous.meta.deadlineAuthority, baseline?.meta.deadlineAuthority ?? null) || previous.meta.commit !== commit || previous.meta.label !== label || previous.meta.probe !== probe || previous.meta.fingerprint !== fingerprint || previous.meta.repetitions !== reps || previous.meta.budgetUsd !== budgetUsd || JSON.stringify(previous.meta.armDefinitions) !== JSON.stringify(arms) || previous.meta.benchmarkTimezone !== BENCHMARK_TIMEZONE || JSON.stringify(previous.meta.comparisonFiles) !== JSON.stringify(comparisonFiles)
    || JSON.stringify(previous.meta.taskIds) !== JSON.stringify(taskIds)
    || JSON.stringify(previous.meta.armIds) !== JSON.stringify(arms.map((arm) => arm.id)))) {
    throw new Error('Checkpoint configuration changed; choose another --out.');
  }
  const runs = previous?.runs ?? [];
  const meta = previous?.meta ?? {
    label, probe, commit, diff, fingerprint, repoRoot, budgetUsd, effort,
    deadlinePolicy: 'best-three-successful-reference-median-times-1.5-or-reference-timeout',
    deadlineAuthority: baseline?.meta.deadlineAuthority ?? null,
    baselineSourceSha256: baselineFile ? createHash('sha256').update(fs.readFileSync(baselineFile)).digest('hex') : null, armDefinitions: arms,
    taskDefinitionHash: createHash('sha256').update(fs.readFileSync(new URL('./browser-agent-tasks.mjs', import.meta.url))).digest('hex'),
    semanticTaskManifestHash: currentSemanticHash, taskIds, armIds: arms.map((arm) => arm.id),
    startedAt: new Date().toISOString(), benchmarkTimezone: BENCHMARK_TIMEZONE, benchmarkDay: benchmarkDay(new Date().toISOString()),
    round: arg('round') ?? label, node: process.version, platform: process.platform,
    browserExecutable: process.env.CHROME_PATH ?? process.env.PUPPETEER_EXECUTABLE_PATH ?? null,
    repetitions: reps, timeoutMs, comparisonFiles, baseline: baselineFile ? path.resolve(baselineFile) : null,
    harnessCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fileURLToPath(new URL('../../../', import.meta.url)), encoding: 'utf8' }).trim(),
    siteChanges: tasks.map((task) => ({ id: task.id, ...task.probe })),
  };
  let budget = null;
  if (!probe && arms.some((arm) => arm.agent === 'pi')) {
    const ledger = path.join(os.homedir(), '.rhwp-browser-bench/openrouter-budget.json');
    if (arg('ledger') && path.resolve(arg('ledger')) !== ledger) throw new Error('All paid rounds must use the shared persistent budget ledger.');
    const key = loadOpenRouterKey();
    if (!key) throw new Error('OpenRouter key is unavailable.');
    budget = await startBudgetProxy({
      ledgerFile: path.join(os.homedir(), '.rhwp-browser-bench/openrouter-budget.json'),
      key, models: arms.filter((arm) => arm.agent === 'pi').map((arm) => arm.model),
      maxUsd: budgetUsd,
      capAuthorization: 'Explicit operator --budget-usd=' + budgetUsd,
    });
    meta.budget = { ledger: ledger, maxUsd: budgetUsd, outputPolicy: 'production-model-ceiling-and-sdk-context-clamp', budgets: budget.budgets };
  }
  const save = () => { meta.updatedAt = new Date().toISOString(); return atomicJson(out, { meta, summaries: summarizeBrowserRuns(runs), limits: label === 'baseline' ? baselineLimits(runs) : limits,
    comparison: references[0] ? compareBrowserRuns(references[0].data, { meta, runs }) : null,
    comparisons: references.map(({ file, data }) => ({ file, label: data.meta.label, round: data.meta.round, ...compareBrowserRuns(data, { meta, runs }) })), budget: budget?.snapshot(), runs }); };
  const retryHarnessErrors = process.argv.includes('--retry-harness-errors');
  const retryProviderErrors = process.argv.includes('--retry-provider-errors');
  const shouldRetry = (row) => row.status === 'harness-error' && retryHarnessErrors || row.status === 'provider-error' && retryProviderErrors;
  const done = new Set(runs.filter((row) => !shouldRetry(row)).map((row) => row.task + '\0' + row.arm + '\0' + row.rep));
  try {
    for (const task of tasks) for (let rep = 1; rep <= (probe ? 1 : reps); rep++) {
      // 과제별로 모델 순서를 회전하여 특정 모델이 항상 먼저 실행되지 않게 한다.
      const ordered = probe ? [{ id: 'probe', agent: 'probe' }] : [...arms.slice((rep - 1) % arms.length), ...arms.slice(0, (rep - 1) % arms.length)];
      for (const arm of ordered) {
        const key = task.id + '\0' + arm.id + '\0' + rep;
        if (done.has(key)) continue;
        if (benchmarkDay(new Date().toISOString()) !== meta.benchmarkDay) throw new Error('Benchmark calendar day changed in Asia/Seoul; refusing mixed-day timings.');
        if (sourceFingerprint() !== fingerprint) throw new Error('Benchmark source changed during the round; refusing mixed-version timings.');
        const start = Date.now();
        const row = { task: task.id, arm: arm.id, agent: arm.agent, model: arm.model, rep, startedAt: new Date(start).toISOString(), passed: false, blocked: false };
        let stack, browser, budgetBeforeIds, capture = null, abortReason = null;
        const artifactDir = path.join(out + '.artifacts', task.id + '-' + arm.id + '-r' + rep + '-' + start);
        fs.mkdirSync(artifactDir, { recursive: true, mode: 0o700 });
        row.artifactDir = artifactDir;
        try {
          if (!probe && arm.agent !== 'pi') row.funding = await inspectSubscriptionFunding(arm.agent, { minimumRemainingMs: timeoutMs + 300000 });
          const browserData = fs.mkdtempSync(path.join(os.tmpdir(), 'rhwp-browser-bench-data-'));
          try {
            stack = await startLiveStack({
              repoRoot, agent: arm.agent, model: arm.model, subscriptionOnly: arm.agent !== 'pi', tag: 'browser-' + arm.id,
              env: { RHWP_BROWSER_BENCH_EVIDENCE_FILE: path.join(artifactDir, 'browser-snapshots.jsonl'), RHWP_PROVIDER_TRANSCRIPT_DIR: path.join(artifactDir, 'provider'), RHWP_BROWSER_DATA_DIR: browserData, PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH ?? path.join(fileURLToPath(new URL('../../../', import.meta.url)), '.tools/owned-browser-chromium') },
              piModels: arms.filter((a) => a.agent === 'pi').map((a) => a.model),
              piTransport: budget ? { url: budget.url, token: budget.token } : null,
            });
            const helpers = await import('../e2e/helpers.mjs?port=' + stack.vitePort + '&t=' + start);
            browser = await helpers.launchBrowser();
            const page = await helpers.createPage(browser);
            await helpers.loadApp(page);
            await helpers.createNewDocument(page);
            await installEventCapture(page);
            await requestBrowser(page, 'configure', { mode: 'managed', headless: true });
            await requestBrowser(page, 'configuration.update', { downloads: { autoImport: false } });
            if (probe) {
              for (const url of task.urls ?? []) await requestBrowser(page, 'open', { url });
              Object.assign(row, await inspectBrowser(page));
              row.status = 'probe';
              row.blocked = row.tabs.some((tab) => tab.challenge || tab.status === 'error');
              row.passed = row.snapshots.some((snapshot) => snapshot.text?.trim().length > 100) && !row.blocked;
              row.unavailableText = !row.snapshots.some((snapshot) => snapshot.text?.trim().length > 100);
              row.probeScope = 'Starting-page accessibility only; full task completion is not tested.';
              continue;
            }
            await page.evaluate(() => window.__agentBridge.onEvent(event => {
              if (event.type === 'chat-started' && event.threadId) window.__browserBenchActor = {
                sessionId: window.__agentBridge.getHubFontAccess?.()?.sessionId ?? null,
                threadId: event.threadId, documentId: event.documentId ?? null,
                agentId: event.threadId + ':root', taskId: null, isHuman: false,
              };
            }));
            await startFreshChat(page, { agent: arm.agent, model: arm.model, effort, permissionProfile: 'safe', workflow: 'question' });
            row.browserEvidenceActor = await page.evaluate(() => window.__browserBenchActor ?? null);
            stack.enforcePiTransport();
            const setup = await page.evaluate(() => window.__agentBridge.requestAgentSetupStatus());
            if (arm.agent !== 'pi' && (setup?.[arm.agent]?.authenticated !== true || setup[arm.agent].authMethod !== 'oauth')) throw new Error('Subscription OAuth runtime authentication is required; refusing API-key billing.');
            row.fundingRuntimeVerified = arm.agent !== 'pi';
            row.runtimeVersions = { ...Object.fromEntries(Object.entries(setup ?? {}).map(([id, status]) => [id, status?.version ?? null])), studioBrowser: await browser.version() };
            if (arm.agent === 'claude') {
              try { row.runtimeVersions.claudeSdk = JSON.parse(fs.readFileSync(path.join(repoRoot, 'rhwp/rhwp-agent/node_modules/@anthropic-ai/claude-agent-sdk/package.json'))).version; } catch {}
            }
            row.piVersion = stack.pi?.version ?? null;
            row.modelMetadata = stack.pi?.model ?? null;
            row.outputLimit = stack.pi ? { configuredModelCeiling: stack.pi.model.maxOutputTokens, source: 'production-catalog-ceiling-with-sdk-context-clamp' }
              : { configuredModelCeiling: null, source: 'provider-runtime-defaults' };
            await resetEventCapture(page);
            await captureBrowserEvents(page);
            const initial = await requestBrowser(page, 'status');
            await page.evaluate((tabs) => window.__browserBench.events.push({ type: 'benchmark-start-state', tabs }), initial.tabs);
            const beforeFiles = stack.pi ? new Map(listPiSessionFiles(stack.pi.sessionsDir).map((file) => [file, fs.statSync(file).size])) : null;
            if (arm.agent !== 'pi') quotaGate();
            if (arm.agent === 'pi') budgetBeforeIds = new Set(budget.snapshot().requests.map((entry) => entry.id));
            const sentAt = Date.now();
            row.turnStartedAt = new Date(sentAt).toISOString();
            await sendThroughComposer(page, 'Starting URL(s): ' + (task.urls ?? []).join(', ') + '\n\n' + task.prompt);
            const turn = await waitForTurnEnd(page, { traceFile: stack.traceFile, sentAt, timeoutMs: label === 'baseline' ? timeoutMs : Math.ceil(limits[task.id] ?? fallbackTimeoutMs) });
            row.turnEndedAt = new Date(turn.endedAt).toISOString();
            row.wallMs = turn.endedAt - sentAt;
            row.limitMs = label === 'baseline' ? timeoutMs : limits[task.id] ?? fallbackTimeoutMs;
            row.limitSource = label === 'baseline' ? 'baseline-budget' : limits[task.id] ? 'best-successful-baseline-median' : 'baseline-budget-no-success';
            row.speedComparisonAvailable = label !== 'baseline' && !!limits[task.id];
            capture = await readEventCapture(page);
            row.rawTurn = turn;
            row.terminalEvents = capture.events.filter((event) => ['turn-end', 'error', 'hub-error'].includes(event.type));
            atomicJson(path.join(artifactDir, 'capture.json'), redactTranscriptJson(capture));
            const piFiles = stack.pi ? listPiSessionFiles(stack.pi.sessionsDir).filter((file) => !beforeFiles.has(file) || fs.statSync(file).size !== beforeFiles.get(file)) : [];
            const metrics = analyzeTurn({ agent: arm.agent, traceFile: stack.traceFile, fixtureRoot: stack.fixtureRoot, from: sentAt, to: turn.endedAt, piFiles, pricing: stack.pi?.model.pricing, usageEvents: capture.events.filter((event) => event.type === 'usage') });
            const evidence = await inspectBrowser(page);
            const observed = await page.evaluate(() => window.__browserBench);
            const answer = capture.answer.trim() || metrics.finalText || capture.text;
            row.providerTransport = readTraceRows(stack.traceFile).find((entry) => entry.kind === 'claude' && entry.ev === 'spawn')?.transport ?? (arm.agent === 'pi' ? 'json' : arm.agent === 'codex' ? 'app-server' : null);
            const calls = joinCalls(readTraceRows(stack.traceFile)).filter((call) => call.hub.hubIn >= sentAt && call.hub.hubIn <= turn.endedAt + 1000);
            const historicalSnapshotAttachments = [];
            const verifiedCallIds = new Set(observed.results.filter(result => result.ok === true && !structuredToolFailure(result.resultPreview)).map(result => result.callId));
            const historicalSnapshots = browserSnapshotsFromTranscripts(stack.pi ? piFiles : [...transcriptFiles(path.join(stack.fixtureRoot, 'sessions')), ...transcriptFiles(path.join(artifactDir, 'provider'), '.ndjson')], { fixtureRoot: stack.fixtureRoot, artifactDir, verifiedCallIds, calls: observed.calls, attachments: historicalSnapshotAttachments });
            const turnIds = [...new Set(readTraceRows(stack.traceFile).filter(entry => entry.kind === 'provider' && entry.ev === 'tool-call' && entry.t >= sentAt && entry.t <= turn.endedAt + 1000 && verifiedCallIds.has(entry.callId)).map(entry => entry.turnId).filter(Boolean))];
            const sidecar = browserSnapshotsFromSidecar(path.join(artifactDir, 'browser-snapshots.jsonl'), { actor: row.browserEvidenceActor, turnId: turnIds.length === 1 ? turnIds[0] : null, agent: arm.agent, calls: observed.calls, verifiedCallIds, captureFailures: readTraceRows(stack.traceFile).filter(entry => entry.kind === 'browser-evidence-capture-error' && entry.t >= sentAt && entry.t <= turn.endedAt + 1000) });
            historicalSnapshots.push(...sidecar.snapshots);
            row.snapshotEvidenceReceipts = sidecar.receipts;
            row.measurementErrors = [...sidecar.errors];
            const check = task.check({ ...evidence, snapshots: [...evidence.snapshots, ...historicalSnapshots], currentSnapshots: evidence.snapshots, snapshotReceipts: sidecar.receipts, verifiedAttachmentCallIds: historicalSnapshotAttachments.map(item => item.callId), answer, calls: observed.calls, browserEvents: observed.events, toolResults: observed.results });
            if (check.measurementInsufficient) row.measurementErrors.push(check.measurementReason ?? 'task-evidence-insufficient');
            const modelProof = browserReportedModel(transcriptFiles(path.join(artifactDir, 'provider'), '.ndjson'), { agent: arm.agent, requested: arm.model });
            row.modelProof = modelProof;
            const effortProof = browserReportedEffort(transcriptFiles(path.join(artifactDir, 'provider'), '.ndjson'), { agent: arm.agent, requested: effort, modelProof });
            row.effortProof = effortProof;
            const classification = classifyBrowserTurn({ turn, capture, metrics, answer, browserCalls: observed.calls });
            abortReason = classification.abortReason ?? (sidecar.errors.length ? 'browser-evidence-capture-failure' : check.measurementInsufficient ? 'task-evidence-insufficient' : classification.status === 'done' && !modelProof.verified ? modelProof.reason : classification.status === 'done' && !effortProof.verified ? effortProof.reason : null);
            row.abortReason = abortReason;
            const consistency = browserFailureConsistency(calls, observed.calls, observed.results);
            Object.assign(row, metrics, measureBrowserFailures(calls, observed.calls, observed.results, { wrongURL: check.wrongURL, blocked: !!check.blocked || evidence.tabs.some((tab) => !!tab.challenge) }), {
              status: classification.status === 'done' && (row.measurementErrors.length || !modelProof.verified || !effortProof.verified) ? 'measurement-insufficient' : classification.status,
              turnErrors: capture.events.filter((event) => ['error', 'hub-error'].includes(event.type) || event.type === 'turn-end' && classification.status === 'provider-error').map((event) => event.errorMessage ?? event.message ?? event.failure).filter(Boolean),
              passed: !!check.passed && classification.status === 'done' && !row.measurementErrors.length && modelProof.verified && effortProof.verified,
              blocked: !!check.blocked || evidence.tabs.some((tab) => !!tab.challenge) || /captcha|challenge|access.denied|cloudflare/i.test(evidence.snapshots.map((snapshot) => snapshot.title).join(' ')),
              check: check.details, wrongURL: check.wrongURL, answer, evidence, historicalSnapshots, historicalSnapshotAttachments, browserEvents: observed.events, browserCalls: observed.calls, browserResults: observed.results, failureConsistency: consistency,
            });
            const policyEvidence = observed.results.filter((result) => (result.ok === false || structuredToolFailure(result.resultPreview)) && /BROWSER_(?:PERMISSION_REQUIRED|WEBSITE_CHANGE_REQUIRED|POLICY_[A-Z_]+)/.test(result.resultPreview ?? ''))
              .map((result) => ({ callId: result.callId, tool: result.tool, error: result.resultPreview }));
            row.policyLimited = policyEvidence.length > 0;
            row.policyEvidence = policyEvidence;
            row.taskConstraints = task.probe?.searchForm ?? null;
            if (task.id === 'law-statute-frame' && !evidence.snapshots.some((snapshot) => /대한민국은 민주공화국이다/.test(snapshot.text))) {
              row.unavailableStatuteText = true;
              row.unavailableTextCause = row.policyLimited ? 'observed-policy-failure' : 'unverified-browser-observation';
            }
            row.validationInspectionComplete = evidence.inspectionErrors.length === 0;
            if (row.blocked || !row.validationInspectionComplete) row.passed = false;
            if (arm.agent === 'pi') row.sdkCostUsd = row.costUsd;
          } finally {
            try {
              preserveBrowserDiagnostics({ artifactDir, traceFile: stack?.traceFile, capture, turn: row.rawTurn });
            } catch (error) { abortReason = 'diagnostic-write-failed'; throw error; }
            finally {
              if (browser) await browser.close().catch(() => {});
              if (stack) await stack.stop().catch(() => {});
              fs.rmSync(browserData, { recursive: true, force: true });
            }
          }
        } catch (error) {
          row.status = 'harness-error';
          row.error = String(error.message);
          if (/gate|budget|Quota|subscription|billing/i.test(row.error)) throw error;
        } finally {
          if (arm.agent !== 'pi') {
            row.catalogCostUsd = Number.isFinite(row.costUsd) ? row.costUsd : null;
            row.costUsd = 0;
            row.billing = row.funding && row.fundingRuntimeVerified ? 'subscription' : 'unverified-no-inference';
          }
          if (budgetBeforeIds) {
            await budget.flush();
            Object.assign(row, budgetDelta(budget.snapshot(), budgetBeforeIds));
          }
          row.finishedAt = new Date().toISOString();
          row.sameBenchmarkDay = [row.startedAt, row.finishedAt].every((timestamp) => benchmarkDay(timestamp) === meta.benchmarkDay);
          row.setupAndTurnMs = Date.now() - start;
          runs.push(row);
          if (!shouldRetry(row)) done.add(key);
          save();
          console.log(JSON.stringify({ task: row.task, arm: row.arm, rep, status: row.status, passed: row.passed, blocked: row.blocked, wallMs: row.wallMs, abortReason }));
        }
        if (abortReason) throw new Error('Round aborted: ' + abortReason + '; inspect private artifacts before retrying.');
      }
    }
  } finally {
    meta.finishedAt = new Date().toISOString();
    save();
    await budget?.stop();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error('Browser benchmark: ' + error.message); process.exitCode = 1; });
}
