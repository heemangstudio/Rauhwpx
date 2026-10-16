import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { baselineLimits, browserArms, browserDeadlineBudget, summarizeBrowserRuns, browserFailureMetrics, mergeBrowserCalls, compareBrowserRuns, browserSnapshotsFromTranscripts, browserSnapshotsFromSidecar, browserReportedModel, browserReportedEffort, budgetDelta, browserFailureConsistency, measureBrowserFailures, benchmarkDay, BENCHMARK_TIMEZONE, classifyBrowserTurn, preserveBrowserDiagnostics, runtimeSourceFingerprint } from './browser-agent-suite.mjs';

const fixtureEffortProof = { verified: true, requested: 'medium', reports: [{ effort: 'medium', source: 'fixture' }] };
const fixtureDeadlineAuthority = { canonicalSourceSha256: 'a'.repeat(64), scoringDefinitionHash: 'same', semanticTaskManifestHash: 'same', taskLimits: {}, fallbackTimeoutMs: 150 };
const fixtureModelProof = { verified: true, reports: [{ model: 'fixture-model', provider: 'fixture-provider' }] };

test('limits use the best arm median from successful nonblocked baseline turns', () => {
  const row = (arm, wallMs, extra = {}) => ({ task: 'site', arm, wallMs, passed: true, blocked: false, status: 'done', limitMs: 1000000, ...extra });
  const rows = [
    row('a', 100), row('a', 300), row('a', 200), row('b', 50), row('b', 300), row('b', 300),
    row('bad-a', 1, { passed: false }), row('bad-b', 1, { blocked: true }), row('bad-c', 1, { status: 'timeout' }),
    { task: 'unavailable', arm: 'a', wallMs: 2, passed: false, blocked: true, status: 'done' },
  ];
  assert.deepEqual(baselineLimits(rows), { site: 300 });
  const summary = summarizeBrowserRuns(rows);
  assert.equal(summary.find(s => s.task === 'unavailable').medianWallMs, null);
  assert.equal(summary.find(s => s.arm === 'a' && s.task === 'site').medianWallMs, 200);
});

test('browser errors distinguish invalid, click, navigation, and challenge failures', () => {
  const calls = [
    { tool: 'browser_click', ok: false, error: 'BROWSER_STALE_REFERENCE' },
    { tool: 'browser_click', ok: false, error: 'element covered timeout' },
    { tool: 'browser_navigate', ok: false, error: 'navigation timeout' },
    { tool: 'browser_open', ok: false, error: 'CAPTCHA challenge' },
    { tool: 'browser_type', ok: false, error: 'invalid argument schema' },
    { tool: 'browser_snapshot', ok: true },
  ];
  const metrics = browserFailureMetrics(calls);
  assert.equal(metrics.invalidCalls, 2);
  assert.equal(metrics.clickFailures, 1);
  assert.equal(metrics.navigationFailures, 1);
  assert.equal(metrics.challengeBlocked, true);
  assert.equal(metrics.browserToolCalls, 6);
});


import { browserTasks } from './browser-agent-tasks.mjs';

test('a claimed answer cannot pass without independently observed browser evidence', () => {
  for (const task of browserTasks) {
    const check = task.check({ answer: task.prompt, tabs: [], snapshots: [], downloads: [], calls: [] });
    assert.equal(check.passed, false, task.id);
    assert.equal(check.blocked, false, task.id + ' missing evidence is a failed attempt');
  }
});

test('actual service argument and stale codes count invalid calls without treating permission errors as external challenges', () => {
  const codes = ['BROWSER_REF_NOT_FOUND', 'BROWSER_SNAPSHOT_REQUIRED', 'BROWSER_EPOCH_REQUIRED', 'BROWSER_STALE_CONTROL', 'BROWSER_STALE_RUNTIME'];
  const metrics = browserFailureMetrics(codes.map((error) => ({ tool: 'browser_click', ok: false, error })));
  assert.equal(metrics.invalidCalls, codes.length);
  assert.equal(browserFailureMetrics([{ tool: 'browser_open', ok: false, error: 'BROWSER_APPROVAL_REQUIRED' }]).challengeBlocked, false);
});

test('pipeline joins preserve repeated failures for one tool without counting hub and provider twice', () => {
  const calls = [{ tool: 'browser_click', callId: 'a' }, { tool: 'browser_click', callId: 'b' }];
  const hubs = [{ tool: 'browser_click', mcp: { toolUseId: 'a' }, ok: false, error: 'covered' }, { tool: 'browser_click', mcp: { toolUseId: 'b' }, ok: false, error: 'timeout' }];
  const results = [{ callId: 'a', ok: false, resultPreview: 'covered' }, { callId: 'b', ok: false, resultPreview: 'timeout' }];
  const merged = mergeBrowserCalls(hubs, calls, results);
  assert.equal(merged.length, 2);
  assert.equal(browserFailureMetrics(merged).clickFailures, 2);
});

test('speed comparisons require three successes, unchanged tasks and the same declared Seoul day', () => {
  const meta = { armDefinitions: [{ id: 'pi', agent: 'pi', model: 'test/pi' }, { id: 'haiku', agent: 'claude', model: 'claude-haiku-5-5' }], benchmarkDay: '2026-10-16', semanticTaskManifestHash: 'same', deadlineAuthority: fixtureDeadlineAuthority, effort: 'medium', benchmarkTimezone: BENCHMARK_TIMEZONE, startedAt: '2026-10-15T19:59:00Z', finishedAt: '2026-10-16T00:02:00Z', taskDefinitionHash: 'same' };
  const rows = (wallMs) => [1, 2, 3].map((rep) => ({ task: 'site', arm: 'pi', rep, wallMs, status: 'done', limitMs: 1000000, effortProof: fixtureEffortProof, modelProof: fixtureModelProof, passed: true, blocked: false, startedAt: '2026-10-15T20:00:00Z', finishedAt: '2026-10-15T20:01:00Z' }));
  const baseline = { meta, runs: rows(200) };
  const candidate = { meta, runs: rows(100) };
  assert.equal(compareBrowserRuns(baseline, candidate).pairs[0].speedup, 2);
  candidate.runs[2].passed = false;
  assert.equal(compareBrowserRuns(baseline, candidate).pairs[0].speedup, null);
  candidate.runs[2].passed = true;
  candidate.meta = { ...meta, armDefinitions: [{ id: 'pi', agent: 'claude', model: 'claude-haiku-5-5' }] };
  assert.equal(compareBrowserRuns(baseline, candidate).pairs[0].reason, 'arm-configuration-changed');
  candidate.meta = { ...meta, taskDefinitionHash: 'changed' };
  assert.equal(compareBrowserRuns(baseline, candidate).pairs[0].eligible, false);
  candidate.meta = meta;
  candidate.runs[2].startedAt = '2026-10-16T00:00:00Z';
  candidate.runs[2].finishedAt = '2026-10-16T00:01:00Z';
  assert.equal(compareBrowserRuns(baseline, candidate).pairs[0].eligible, true);
  candidate.runs[2].finishedAt = '2026-10-16T15:01:00Z';
  assert.equal(compareBrowserRuns(baseline, candidate).pairs[0].eligible, false);
  assert.equal(benchmarkDay('2026-10-15T14:59:00Z'), '2026-10-15');
  assert.equal(benchmarkDay('2026-10-15T15:01:00Z'), '2026-10-16');
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('historical DOM evidence comes only from real tool-result messages, not assistant claims', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-evidence-'));
  try {
    const file = path.join(directory, 'session.jsonl');
    const snapshot = { snapshotId: 'real', tabId: 'tab', url: 'https://example.com', text: 'real DOM' };
    fs.writeFileSync(file, [
      { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: JSON.stringify({ snapshot: { ...snapshot, snapshotId: 'claimed' } }) }] } },
      { type: 'message', message: { role: 'toolResult', toolName: 'browser_snapshot', content: [{ type: 'text', text: JSON.stringify({ snapshot }) }] } },
    ].map((entry) => JSON.stringify(entry)).join('\n'));
    assert.deepEqual(browserSnapshotsFromTranscripts([file]).map((item) => item.snapshotId), ['real']);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('per-turn costs use authoritative request-ID deltas and preserve unknown pending cost', () => {
  const entries = [
    { id: 'old', state: 'settled', actual: '1000000000000' },
    { id: 'new', state: 'settled', actual: '2000000000' },
    { id: 'pending', state: 'pending', reserved: '3000000000000' },
  ];
  const delta = budgetDelta({ requests: entries }, new Set(['old']));
  assert.equal(delta.costUsd, null);
  assert.equal(delta.authoritativeSettledCostUsd, 0.002);
  assert.equal(delta.pendingReservationUsd, 3);
  assert.deepEqual(delta.budgetRequestIds, ['new', 'pending']);
  assert.equal(budgetDelta({ requests: entries.slice(0, 2) }, new Set(['old'])).costUsd, 0.002);
});

test('pipeline identity survives reversed same-tool arrival order and unmatched errors stay visible', () => {
  const hubs = [
    { tool: 'browser_click', mcp: { toolUseId: 'success' }, ok: true },
    { tool: 'browser_click', mcp: { toolUseId: 'failure' }, ok: false, error: 'BROWSER_REF_NOT_FOUND' },
  ];
  const providers = [{ tool: 'browser_click', callId: 'failure' }, { tool: 'browser_click', callId: 'success' }];
  const results = [{ callId: 'success', ok: true }];
  assert.equal(browserFailureMetrics(mergeBrowserCalls(hubs, providers, results)).invalidCalls, 1);
  const unmatched = { tool: 'browser_click', ok: false, error: 'BROWSER_SNAPSHOT_REQUIRED' };
  const unmatchedMetrics = browserFailureMetrics(mergeBrowserCalls([unmatched], [], []));
  assert.equal(unmatchedMetrics.invalidCalls, 0);
  assert.equal(unmatchedMetrics.uncorrelatedHubFailures, 1);
});

test('diagnostics expose runtime failures missing from provider flags without changing their authoritative hub count', () => {
  const hub = [{ tool: 'browser_open', ok: false, error: 'BROWSER_ACCOUNT_APPROVAL_REQUIRED' }];
  const calls = [{ tool: 'browser_open', callId: 'a' }];
  const missing = browserFailureConsistency(hub, calls, []);
  assert.equal(missing.consistent, false);
  const present = browserFailureConsistency(hub, calls, [{ callId: 'a', ok: false, resultPreview: 'BROWSER_ACCOUNT_APPROVAL_REQUIRED: blocked' }]);
  assert.equal(present.consistent, true);
  assert.equal(browserFailureMetrics(mergeBrowserCalls(hub, calls, [{ callId: 'a', ok: false, resultPreview: 'BROWSER_ACCOUNT_APPROVAL_REQUIRED' }])).navigationFailures, 1);
  assert.equal(browserFailureConsistency([...hub, ...hub], calls, [{ callId: 'a', ok: false, resultPreview: 'BROWSER_ACCOUNT_APPROVAL_REQUIRED' }]).consistent, false);
});

test('hub runtime failures remain authoritative when a baseline adapter reports success', () => {
  const hubs = [{ tool: 'browser_click', ok: false, error: 'BROWSER_REF_NOT_FOUND' }];
  const calls = [{ tool: 'browser_click', callId: 'a' }];
  const wrongSuccess = [{ callId: 'a', ok: true, resultPreview: JSON.stringify({ isError: true, content: [{ type: 'text', text: 'BROWSER_REF_NOT_FOUND' }] }) }];
  const measured = measureBrowserFailures(hubs, calls, wrongSuccess);
  assert.equal(measured.invalidCalls, 1);
  assert.equal(measured.failureReconciliation.aggregateCovered, 1);
  assert.equal(measured.failureReconciliation.consistent, false);
  const missingProvider = measureBrowserFailures(hubs, calls, []);
  assert.equal(missingProvider.invalidCalls, 1);
  const prehub = measureBrowserFailures([], calls, [{ callId: 'a', ok: false, resultPreview: 'invalid argument schema' }]);
  assert.equal(prehub.invalidCalls, 1);
  assert.equal(prehub.failureReconciliation.providerExcess, 1);
  const twoFailures = measureBrowserFailures([...hubs, ...hubs], calls, [{ callId: 'a', ok: false, resultPreview: 'BROWSER_REF_NOT_FOUND' }]);
  assert.equal(twoFailures.invalidCalls, 2);
});

test('terminal-only SDK failures and empty startup turns cannot count as completed trials', () => {
  const input = { turn: { status: null }, capture: { events: [] }, metrics: { requests: [], inputTokens: 0, outputTokens: 0 }, answer: '', browserCalls: [] };
  assert.deepEqual(classifyBrowserTurn(input), { status: 'provider-error', abortReason: 'provider-startup-without-evidence' });
  const terminal = classifyBrowserTurn({ ...input, capture: { events: [{ type: 'turn-end', errorMessage: 'OAuth expired', failure: { code: 'authentication_error' } }] } });
  assert.equal(terminal.status, 'provider-error');
  assert.ok(terminal.abortReason);
  assert.equal(classifyBrowserTurn({ ...input, answer: 'A real Codex answer', metrics: { modelRequests: 0 } }).status, 'done');
  const cap = classifyBrowserTurn({ ...input, answer: 'Partial progress', browserCalls: [{ tool: 'browser_open' }], metrics: { requests: [{ errorMessage: '402 Budget reservation exceeds $10 cap' }] } });
  assert.equal(cap.status, 'provider-error');
  assert.equal(cap.abortReason, 'budget-denial');
});

test('private terminal diagnostics and trace survive fixture cleanup with secrets redacted', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-diagnostics-'));
  try {
    const fixture = path.join(root, 'fixture');
    const artifactDir = path.join(root, 'retained');
    fs.mkdirSync(fixture);
    const traceFile = path.join(fixture, 'trace.jsonl');
    fs.writeFileSync(traceFile, JSON.stringify({ kind: 'provider', ev: 'turn-end' }));
    preserveBrowserDiagnostics({ artifactDir, traceFile, turn: { status: 'failed' },
      capture: { events: [{ type: 'turn-end', errorMessage: 'OAuth expired', failure: { code: 'authentication_error' }, authorization: 'private-test-credential' }] } });
    fs.rmSync(fixture, { recursive: true });
    const terminal = JSON.parse(fs.readFileSync(path.join(artifactDir, 'terminal.json')));
    assert.equal(terminal.terminalEvents[0].errorMessage, 'OAuth expired');
    assert.equal(terminal.terminalEvents[0].authorization, '[redacted]');
    assert.equal(terminal.rawTurn.status, 'failed');
    assert.ok(fs.existsSync(path.join(artifactDir, 'tool-trace.jsonl')));
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(artifactDir).mode & 0o777, 0o700);
      assert.equal(fs.statSync(path.join(artifactDir, 'terminal.json')).mode & 0o777, 0o600);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('source freeze detects staged and new runtime code while excluding fixture and cache corpora', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-fingerprint-'));
  try {
    const bench = path.join(root, 'rhwp/rhwp-studio/bench');
    fs.mkdirSync(bench, { recursive: true });
    for (const file of ['browser-agent-suite.mjs', 'browser-agent-tasks.mjs', 'browser-agent-budget.mjs', 'agent-live-common.mjs']) fs.writeFileSync(path.join(bench, file), 'harness');
    let staged = '', untracked = [], head = 'base';
    const git = (args) => {
      if (args[0] === 'rev-parse') return head;
      if (args[0] === 'diff') { assert.deepEqual(args.slice(1), ['HEAD', '--binary', '--no-ext-diff']); return staged; }
      assert.equal(args[0], 'ls-files');
      return untracked.join('\0');
    };
    const fingerprint = () => runtimeSourceFingerprint({ repoRoot: root, harnessRoot: root, git });
    const initial = fingerprint();
    staged = 'staged runtime edit';
    assert.notEqual(fingerprint(), initial);
    staged = '';
    const module = path.join(root, 'rhwp/rhwp-agent/new-tool.mjs');
    fs.mkdirSync(path.dirname(module), { recursive: true });
    fs.writeFileSync(module, 'first');
    untracked = ['rhwp/rhwp-agent/new-tool.mjs'];
    const newModule = fingerprint();
    assert.notEqual(newModule, initial);
    fs.writeFileSync(module, 'second');
    assert.notEqual(fingerprint(), newModule);
    untracked = ['samples/large-corpus.json', '.tools/browser-cache.js', 'rhwp/rhwp-agent/tests/fixture.json'];
    assert.equal(fingerprint(), initial);
    head = 'new commit';
    assert.notEqual(fingerprint(), initial);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

import { execFileSync } from 'node:child_process';

test('existing compare CLI reports browser metrics and keeps document scorecards compatible', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-compare-'));
  try {
    const meta = { armDefinitions: [{ id: 'pi', agent: 'pi', model: 'test/pi' }, { id: 'haiku', agent: 'claude', model: 'claude-haiku-5-5' }], taskDefinitionHash: 'same', semanticTaskManifestHash: 'same', deadlineAuthority: fixtureDeadlineAuthority, effort: 'medium', benchmarkTimezone: BENCHMARK_TIMEZONE, benchmarkDay: '2026-10-16',
      startedAt: '2026-10-15T20:00:00Z', finishedAt: '2026-10-15T20:01:00Z' };
    const runs = (wallMs) => [1, 2, 3].map((rep) => ({ task: 'site', arm: 'haiku', rep, status: 'done', limitMs: 1000000, effortProof: fixtureEffortProof, modelProof: fixtureModelProof, passed: true, blocked: false,
      wallMs, startedAt: meta.startedAt, finishedAt: meta.finishedAt, invalidCalls: 1, clickFailures: 0, navigationFailures: 0, costUsd: 0.001 }));
    const before = path.join(directory, 'before.json'), after = path.join(directory, 'after.json');
    fs.writeFileSync(before, JSON.stringify({ meta, runs: runs(200) }));
    fs.writeFileSync(after, JSON.stringify({ meta, runs: runs(100) }));
    const command = new URL('./agent-live-compare.mjs', import.meta.url);
    const output = execFileSync(process.execPath, [command.pathname, before, after, '--json'], { encoding: 'utf8' });
    const scorecard = JSON.parse(output);
    assert.equal(scorecard.sources[1].summaries[0].invalidCalls, 3);
    assert.equal(scorecard.sources[1].summaries[0].costUsd, 0.003);
    assert.equal(scorecard.comparisons[0].pairs[0].speedup, 2);
    const document = path.join(directory, 'document.json');
    fs.writeFileSync(document, JSON.stringify({ meta: { agent: 'pi', model: 'document-model' }, runs: [{ task: 'typos', status: 'done', limitMs: 1000000, wallMs: 1000, score: 1 }] }));
    const legacy = execFileSync(process.execPath, [command.pathname, document], { encoding: 'utf8' });
    assert.match(legacy, /pi:document-model/);
    assert.match(legacy, /score/);
    assert.match(legacy, /typos/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

import { loadOpenRouterKey } from './agent-live-common.mjs';

test('bench key files take priority without fallback when empty, insecure, or symlinked', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-keyfile-'));
  try {
    const keyFile = path.join(root, 'dedicated-key');
    fs.writeFileSync(keyFile, 'dedicated-test-value\n', { mode: 0o600 });
    fs.writeFileSync(path.join(root, '.env'), 'OPENROUTER_API_KEY=legacy-test-value');
    const env = { RHWP_BENCH_OPENROUTER_KEY_FILE: keyFile, OPENROUTER_API_KEY: 'environment-test-value' };
    assert.equal(loadOpenRouterKey({ env, home: root }), 'dedicated-test-value');
    fs.writeFileSync(keyFile, '  ');
    assert.throws(() => loadOpenRouterKey({ env, home: root }), /empty/);
    fs.writeFileSync(keyFile, 'dedicated-test-value');
    if (process.platform !== 'win32') {
      fs.chmodSync(keyFile, 0o644);
      assert.throws(() => loadOpenRouterKey({ env, home: root }), /private/);
      fs.chmodSync(keyFile, 0o600);
      const link = path.join(root, 'link');
      fs.symlinkSync(keyFile, link);
      assert.throws(() => loadOpenRouterKey({ env: { ...env, RHWP_BENCH_OPENROUTER_KEY_FILE: link }, home: root }), /private/);
    }
    assert.equal(loadOpenRouterKey({ env: { OPENROUTER_API_KEY: 'environment-test-value' }, home: root }), 'environment-test-value');
    assert.equal(loadOpenRouterKey({ env: {}, home: root }), 'legacy-test-value');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('SDK oversized browser results are harvested only from verified own attachment envelopes before cleanup', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-sdk-'));
  const artifacts = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-artifacts-'));
  try {
    const folder = path.join(root, 'sessions', 'record', 'home', '.claude', 'projects', 'project', 'session', 'tool-results');
    fs.mkdirSync(folder, { recursive: true });
    const attachment = path.join(folder, 'mcp-rhwp-browser_wait-1792095338916.txt');
    const snapshot = { snapshotId: 'sdk-snapshot', tabId: 'tab', url: 'https://search.naver.com/search.naver', text: 'observed second result', elements: [{ ref: 'e71', name: 'Observed title' }] };
    fs.writeFileSync(attachment, JSON.stringify([{ type: 'text', text: JSON.stringify({ ok: true, snapshot }) }]));
    const notice = file => 'Error: result (138,485 characters across 1 line) exceeds maximum allowed tokens. Output has been saved to ' + file + '.\nFormat: Plain text\nSearch within the file for specific content, and use jq if the content is JSON.\nREQUIREMENTS FOR SUMMARIZATION/ANALYSIS/REVIEW:\n';
    const transcript = path.join(root, 'provider.ndjson');
    const write = (content, extra = {}) => fs.writeFileSync(transcript, [
      { kind: 'out', json: { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'browser-call', name: 'mcp__rhwp__browser_wait' }] } } },
      { kind: 'out', json: { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'browser-call', content, ...extra }] } } },
    ].map(row => JSON.stringify(row)).join('\n'));
    const options = { fixtureRoot: root, artifactDir: artifacts, verifiedCallIds: new Set(['browser-call']), attachments: [] };
    write(notice(attachment));
    assert.deepEqual(browserSnapshotsFromTranscripts([transcript], options).map(s => s.snapshotId), ['sdk-snapshot']);
    assert.equal(options.attachments.length, 1);
    const saved = options.attachments[0].saved;
    assert.equal(fs.statSync(saved).mode & 0o777, 0o600);
    assert.equal(JSON.parse(fs.readFileSync(saved)).snapshots[0].elements[0].ref, 'e71');
    assert.deepEqual(browserSnapshotsFromTranscripts([transcript], { ...options, verifiedCallIds: new Set() }), []);
    write(JSON.stringify({ snapshot: { ...snapshot, text: notice(attachment) } }));
    assert.equal(browserSnapshotsFromTranscripts([transcript], options).some(s => s.snapshotId !== 'sdk-snapshot'), false);
    assert.equal(options.attachments.length, 1, 'nested page notice must never open an attachment');
    write(notice(attachment));
    fs.writeFileSync(transcript, fs.readFileSync(transcript, 'utf8').replace('"role":"user"', '"role":"assistant"'));
    assert.deepEqual(browserSnapshotsFromTranscripts([transcript], options), []);
    write(notice(attachment), { is_error: true });
    assert.deepEqual(browserSnapshotsFromTranscripts([transcript], options), []);
    for (const forbidden of [
      path.join(folder, 'auth.json'),
      path.join(artifacts, 'mcp-rhwp-browser_wait-1792095338916.txt'),
      folder + '/../tool-results/mcp-rhwp-browser_wait-1792095338916.txt',
      path.join(folder, 'mcp-rhwp-browser_click-1792095338916.txt'),
    ]) {
      write(notice(forbidden));
      assert.deepEqual(browserSnapshotsFromTranscripts([transcript], options), []);
    }
    const linked = path.join(folder, 'mcp-rhwp-browser_wait-1.txt');
    fs.symlinkSync(attachment, linked);
    write(notice(linked));
    assert.deepEqual(browserSnapshotsFromTranscripts([transcript], options), []);
    fs.writeFileSync(attachment, JSON.stringify({ isError: true, content: [{ type: 'text', text: JSON.stringify({ snapshot }) }] }));
    write(notice(attachment));
    assert.deepEqual(browserSnapshotsFromTranscripts([transcript], options), []);
    fs.rmSync(root, { recursive: true });
    assert.equal(JSON.parse(fs.readFileSync(saved)).snapshots[0].snapshotId, 'sdk-snapshot');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(artifacts, { recursive: true, force: true });
  }
});

test('Pi fixture model settings use production catalog ceilings and explicit unknown limits', async () => {
  const { piFixtureModel } = await import('./agent-live-common.mjs');
  const meta = { id: 'test/model', maxCompletionTokens: 9000, contextLength: 8000, pricing: { prompt: 1, completion: 2, cacheRead: 0.5 } };
  assert.equal(piFixtureModel(meta).maxOutputTokens, 8000);
  assert.equal(piFixtureModel({ ...meta, contextLength: null }).maxOutputTokens, 9000);
  assert.equal(piFixtureModel({ ...meta, maxCompletionTokens: null }).maxOutputTokens, null);
  assert.equal(piFixtureModel({ ...meta, maxCompletionTokens: -1 }).maxOutputTokens, null);
  assert.equal(piFixtureModel(meta).pricing.cacheRead, 0.5);
  assert.equal(piFixtureModel({ ...meta, pricing: { prompt: 1, completion: 2 } }).pricing.cacheRead, 0);
});


test('benchmark arms use Haiku Claude subscription and Codex Luna without Pi configuration', async () => {
  const { browserArms } = await import('./browser-agent-suite.mjs');
  assert.deepEqual(browserArms, [
    { id: 'haiku', agent: 'claude', model: 'claude-haiku-5-5' },
    { id: 'luna', agent: 'codex', model: 'gpt-6-luna' },
  ]);
  const plan = JSON.parse(execFileSync(process.execPath, [new URL('./browser-agent-suite.mjs', import.meta.url).pathname], { encoding: 'utf8' }));
  assert.deepEqual(plan.arms.map(arm => arm.id), ['haiku', 'luna']);
  const candidate = JSON.parse(execFileSync(process.execPath, [new URL('./browser-agent-suite.mjs', import.meta.url).pathname, '--label=candidate'], { encoding: 'utf8' }));
  assert.deepEqual(candidate.arms, plan.arms);
});

test('arm target uses the median across all ten eligible tasks and rejects each failure metric regression separately', () => {
  const meta = { armDefinitions: [{ id: 'pi', agent: 'pi', model: 'test/pi' }, { id: 'haiku', agent: 'claude', model: 'claude-haiku-5-5' }], benchmarkDay: '2026-10-16', semanticTaskManifestHash: 'same', deadlineAuthority: fixtureDeadlineAuthority, effort: 'medium', benchmarkTimezone: BENCHMARK_TIMEZONE, startedAt: '2026-10-15T20:00:00Z', finishedAt: '2026-10-15T21:00:00Z', taskDefinitionHash: 'same' };
  const rows = candidate => Array.from({ length: 10 }, (_, task) => [1, 2, 3].map(rep => ({
    task: 'task-' + task, arm: 'haiku', rep, wallMs: candidate ? task === 0 ? 200 : 100 : 300,
    status: 'done', limitMs: 1000000, effortProof: fixtureEffortProof, modelProof: fixtureModelProof, passed: true, blocked: false, startedAt: '2026-10-15T20:01:00Z', finishedAt: '2026-10-15T20:02:00Z',
  }))).flat();
  const baseline = { meta, runs: rows(false) }, candidate = { meta, runs: rows(true) };
  let comparison = compareBrowserRuns(baseline, candidate);
  assert.equal(comparison.pairs[0].speedup, 1.5);
  assert.equal(comparison.arms[0].medianSpeedup, 3);
  assert.equal(comparison.arms[0].eligibleTasks, 10);
  assert.equal(comparison.arms[0].targetMet, true);
  baseline.runs[0].clickFailures = 2;
  candidate.runs[0].invalidCalls = 1;
  comparison = compareBrowserRuns(baseline, candidate);
  assert.deepEqual(comparison.arms[0].failureMetrics.invalidCalls, { before: 0, after: 1, regressed: true });
  assert.deepEqual(comparison.arms[0].failureMetrics.clickFailures, { before: 2, after: 0, regressed: false });
  assert.equal(comparison.arms[0].failuresRegressed, true);
  assert.equal(comparison.arms[0].targetMet, false);
  candidate.runs[0].invalidCalls = 0;
  candidate.runs[0].passed = false;
  comparison = compareBrowserRuns(baseline, candidate);
  assert.equal(comparison.arms[0].eligibleTasks, 9);
  assert.equal(comparison.arms[0].targetMet, false);
});

test('retried provider and harness failures remain observed attempts and cannot produce three-of-three speed claims', () => {
  const meta = { armDefinitions: [{ id: 'pi', agent: 'pi', model: 'test/pi' }, { id: 'haiku', agent: 'claude', model: 'claude-haiku-5-5' }], benchmarkDay: '2026-10-16', semanticTaskManifestHash: 'same', deadlineAuthority: fixtureDeadlineAuthority, effort: 'medium', benchmarkTimezone: BENCHMARK_TIMEZONE, startedAt: '2026-10-15T20:00:00Z', finishedAt: '2026-10-15T21:00:00Z', taskDefinitionHash: 'same' };
  const rows = wallMs => [1, 2, 3].map(rep => ({ task: 'site', arm: 'haiku', rep, wallMs, status: 'done', limitMs: 1000000, effortProof: fixtureEffortProof, modelProof: fixtureModelProof, passed: true, blocked: false,
    startedAt: '2026-10-15T20:01:00Z', finishedAt: '2026-10-15T20:02:00Z' }));
  for (const status of ['provider-error', 'harness-error']) for (const side of ['baseline', 'current']) {
    const baseline = { meta, runs: rows(300) }, current = { meta, runs: rows(100) };
    const data = side === 'baseline' ? baseline : current;
    data.runs.push({ ...data.runs[0], status, passed: false, costUsd: 0.1 });
    const pair = compareBrowserRuns(baseline, current).pairs[0];
    assert.equal(pair.eligible, false);
    assert.equal(pair.speedup, null);
    assert.equal(pair.reason, 'requires-exactly-three-observed-attempts');
    assert.deepEqual(pair.attemptCounts, { baseline: side === 'baseline' ? 4 : 3, current: side === 'current' ? 4 : 3 });
    assert.equal(data.runs.length, 4);
  }
});

test('Codex completed MCP history requires matching successful call identity and structured result', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-codex-history-'));
  try {
    const file = path.join(root, 'provider.ndjson');
    const snapshot = { snapshotId: 'codex-snapshot', tabId: 'tab', url: 'https://example.org', text: 'observed DOM', elements: [{ ref: 'e71', name: 'Observed title' }] };
    const call = { callId: 'exec-observed', tool: 'browser_snapshot', args: { tabId: 'tab' } };
    const item = { type: 'mcpToolCall', id: call.callId, server: 'rhwp', tool: call.tool, status: 'completed', error: null, arguments: call.args,
      result: { content: [{ type: 'text', text: JSON.stringify({ ok: true, snapshot }) }], structuredContent: null } };
    const options = { calls: [call], verifiedCallIds: new Set([call.callId]) };
    const extract = (value = item, kind = 'out') => {
      fs.writeFileSync(file, JSON.stringify({ kind, json: { method: 'item/completed', params: { item: value } } }));
      return browserSnapshotsFromTranscripts([file], options);
    };
    assert.deepEqual(extract().map(s => s.snapshotId), ['codex-snapshot']);
    for (const patch of [{ id: 'different' }, { server: 'other' }, { tool: 'browser_click' }, { arguments: { tabId: 'other' } },
      { status: 'failed' }, { error: { message: 'failed' } }, { result: { isError: true, content: item.result.content } },
      { result: { content: [{ type: 'text', text: JSON.stringify({ ok: false, snapshot }) }] } },
      { result: { content: [{ type: 'text', text: JSON.stringify({ ok: true, snapshot }).slice(0, -3) }] } }]) assert.deepEqual(extract({ ...item, ...patch }), []);
    assert.deepEqual(extract(item, 'in'), []);
    assert.deepEqual(extract({ type: 'assistantMessage', text: JSON.stringify(item) }), []);
    options.verifiedCallIds.clear();
    assert.deepEqual(extract(), []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('private snapshot receipts bind exact actor, turn, call and arguments despite provider truncation', async () => {
  const { createBrowserEvidenceWriter, browserEvidenceArgsHash } = await import('../../rhwp-agent/tool-trace.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-snapshot-sidecar-'));
  try {
    const actor = { sessionId: 'hub-session', threadId: 'thread', documentId: 'document', agentId: 'thread:root', taskId: null, isHuman: false };
    const call = { callId: 'exec-snapshot', tool: 'browser_snapshot', args: { tabId: 'tab' } };
    const snapshot = { snapshotId: 'observed', tabId: 'tab', url: 'https://example.org', title: 'Observed', text: 'Actual masked DOM [masked]', navigationEpoch: 1, controllerEpoch: 1, truncated: false, elements: [{ ref: 'e71', role: 'link', name: 'Actual title' }] };
    const file = path.join(root, 'snapshots.jsonl'), writer = createBrowserEvidenceWriter(file);
    assert.equal(writer.write({ delivered: true, actor, callId: call.callId, argsHash: browserEvidenceArgsHash(call.args), args: call.args, tool: call.tool, hub: { seq: 1, clientId: 0, turnId: 'turn', agent: 'codex' }, result: { ok: true, snapshot } }).status, 'written');
    writer.close();
    const options = { actor, turnId: 'turn', agent: 'codex', calls: [call], verifiedCallIds: new Set([call.callId]) };
    const parsed = browserSnapshotsFromSidecar(file, options);
    assert.deepEqual(parsed.errors, []);
    assert.equal(parsed.snapshots[0].snapshotId, 'observed');
    assert.match(parsed.receipts[0].sourceSha256, /^[a-f0-9]{64}$/);
    const laterWriteFailed = browserSnapshotsFromSidecar(file, { ...options, captureFailures: [{ actor, hub: { turnId: 'turn', agent: 'codex' }, callId: 'later-call', code: 'write-failed' }] });
    assert.equal(laterWriteFailed.snapshots.length, 0);
    assert.deepEqual(laterWriteFailed.errors, ['snapshot-capture-write-failed']);

    // The provider preview is truncated. Only the separate authoritative receipt supplies DOM.
    assert.deepEqual(browserSnapshotsFromTranscripts([], options), []);
    for (const patch of [{ actor: { ...actor, sessionId: 'foreign' } }, { actor: { ...actor, agentId: 'thread:task:child' } }, { turnId: 'other-turn' },
      { calls: [{ ...call, args: { tabId: 'foreign' } }] }, { verifiedCallIds: new Set() }]) {
      const checked = browserSnapshotsFromSidecar(file, { ...options, ...patch });
      assert.equal(checked.snapshots.length, 0);
      assert.ok(checked.errors.length);
    }
    fs.chmodSync(file, 0o644);
    assert.ok(browserSnapshotsFromSidecar(file, options).errors.length);
    fs.chmodSync(file, 0o600);
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, JSON.stringify({ ...value, kind: 'browser-snapshot-capture-error', code: 'snapshot-limit', snapshot: undefined }) + '\n', { mode: 0o600 });
    assert.deepEqual(browserSnapshotsFromSidecar(file, options).errors, ['snapshot-limit']);
    assert.ok(browserSnapshotsFromSidecar(path.join(root, 'missing'), options).errors.length);
    const summary = summarizeBrowserRuns([{ task: 'task', arm: 'luna', status: 'measurement-insufficient', passed: false, invalidCalls: 0 }])[0];
    assert.equal(summary.measurementInsufficient, 1);
    assert.equal(summary.failed, 0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('subscription funding refuses API credentials and routing overrides without exposing secrets', async () => {
  const { inspectSubscriptionFunding, dropLiveBenchEnv } = await import('./agent-live-common.mjs');
  for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CONFIG_DIR',
    'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'AZURE_OPENAI_API_KEY', 'CODEX_HOME', 'CODEX_CONFIG', 'CODEX_CONFIG_PATH', 'CODEX_MODEL_PROVIDER', 'OPENROUTER_API_KEY', 'RHWP_BENCH_OPENROUTER_KEY_FILE']) assert.equal(dropLiveBenchEnv(key), true, key);
  assert.equal(dropLiveBenchEnv('PLAYWRIGHT_BROWSERS_PATH'), false);
  const now = Date.now(), oauth = { accessToken: 'fixture-private-token', subscriptionType: 'max', scopes: ['user:inference'], expiresAt: now + 3600000 };
  const claude = patch => inspectSubscriptionFunding('claude', { now, readClaude: async () => ({ text: JSON.stringify({ claudeAiOauth: { ...oauth, ...patch } }) }) });
  const funding = await claude({});
  assert.equal(funding.plan, 'max');
  assert.equal(JSON.stringify(funding).includes(oauth.accessToken), false);
  for (const patch of [{ accessToken: '' }, { subscriptionType: 'api' }, { scopes: [] }, { expiresAt: now - 1 }]) await assert.rejects(claude(patch), /subscription OAuth/);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-subscription-auth-'));
  try {
    fs.mkdirSync(path.join(root, '.codex'));
    const file = path.join(root, '.codex', 'auth.json');
    const claims = { exp: Math.ceil((now + 3600000) / 1000), 'https://api.openai.com/auth': { chatgpt_plan_type: 'pro' } };
    const access = 'header.' + Buffer.from(JSON.stringify(claims)).toString('base64url') + '.signature';
    const auth = { auth_mode: 'chatgpt', OPENAI_API_KEY: null, tokens: { access_token: access } };
    const write = value => fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
    write(auth);
    assert.equal((await inspectSubscriptionFunding('codex', { home: root, now })).plan, 'pro');
    for (const value of [{ ...auth, OPENAI_API_KEY: 'fixture-paid-key' }, { ...auth, auth_mode: 'apikey' }, { ...auth, tokens: { access_token: 'invalid' } }]) {
      write(value); await assert.rejects(inspectSubscriptionFunding('codex', { home: root, now }), /subscription OAuth/);
    }
    write(auth); fs.chmodSync(file, 0o644);
    await assert.rejects(inspectSubscriptionFunding('codex', { home: root, now }), /subscription OAuth/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('subscription portable config excludes host routing and reported inference models require provider envelopes', async () => {
  const { seedSubscriptionClaudeConfig } = await import('./agent-live-common.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-model-proof-'));
  try {
    const config = seedSubscriptionClaudeConfig(root);
    assert.deepEqual(JSON.parse(fs.readFileSync(config, 'utf8')), { hasCompletedOnboarding: true });
    assert.equal(fs.statSync(config).mode & 0o077, 0);
    const file = path.join(root, 'provider.ndjson');
    const write = rows => fs.writeFileSync(file, rows.map(row => JSON.stringify(row)).join('\n'));
    const claude = model => ({ kind: 'out', json: { type: 'assistant', message: { model, content: [{ type: 'text', text: 'answer' }] } } });
    write([claude('claude-haiku-5-5-20261001')]);
    assert.equal(browserReportedModel([file], { agent: 'claude', requested: 'claude-haiku-5-5' }).verified, true);
    write([claude('claude-opus-5-5')]);
    assert.equal(browserReportedModel([file], { agent: 'claude', requested: 'claude-haiku-5-5' }).reason, 'provider-model-mismatch');
    write([{ kind: 'out', json: { type: 'assistant', message: { content: [{ type: 'text', text: JSON.stringify({ model: 'claude-haiku-5-5' }) }] } } }]);
    assert.equal(browserReportedModel([file], { agent: 'claude', requested: 'claude-haiku-5-5' }).reason, 'provider-model-unverified');
    const request = { kind: 'in', json: { id: 3, method: 'thread/start', params: { model: 'gpt-6-luna' } } };
    const response = { kind: 'out', json: { id: 3, result: { model: 'gpt-6-luna', modelProvider: 'openai' } } };
    write([request]); assert.equal(browserReportedModel([file], { agent: 'codex', requested: 'gpt-6-luna' }).verified, false);
    write([request, response]); assert.equal(browserReportedModel([file], { agent: 'codex', requested: 'gpt-6-luna' }).verified, true);
    write([request, { ...response, json: { ...response.json, id: 99 } }]); assert.equal(browserReportedModel([file], { agent: 'codex', requested: 'gpt-6-luna' }).verified, false);
    write([request, { ...response, json: { ...response.json, result: { model: 'gpt-6.1-sol', modelProvider: 'openai' } } }]);
    assert.equal(browserReportedModel([file], { agent: 'codex', requested: 'gpt-6-luna' }).reason, 'provider-model-mismatch');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('speed comparisons require identical reported model revisions and providers across all six trials', () => {
  const meta = { armDefinitions: [{ id: 'haiku', agent: 'claude', model: 'claude-haiku-5-5' }], taskDefinitionHash: 'same',
    semanticTaskManifestHash: 'same', deadlineAuthority: fixtureDeadlineAuthority, effort: 'medium', benchmarkTimezone: BENCHMARK_TIMEZONE, benchmarkDay: '2026-10-16', startedAt: '2026-10-15T20:00:00Z', finishedAt: '2026-10-15T21:00:00Z' };
  const rows = model => [1, 2, 3].map(rep => ({ task: 'site', arm: 'haiku', rep, status: 'done', limitMs: 1000000, passed: true, blocked: false, wallMs: 100,
    startedAt: '2026-10-15T20:01:00Z', finishedAt: '2026-10-15T20:02:00Z', effortProof: fixtureEffortProof, modelProof: { verified: true, reports: [{ model, provider: 'anthropic' }] } }));
  const baseline = { meta, runs: rows('claude-haiku-5-5-20261001') }, current = { meta, runs: rows('claude-haiku-5-5-20261001') };
  assert.equal(compareBrowserRuns(baseline, current).pairs[0].eligible, true);
  current.runs = rows('claude-haiku-5-5-20261002');
  assert.equal(compareBrowserRuns(baseline, current).pairs[0].reason, 'reported-model-changed-or-missing');
  current.runs = rows('claude-haiku-5-5-20261001');
  delete current.runs[0].modelProof;
  assert.equal(compareBrowserRuns(baseline, current).pairs[0].speedup, null);
  current.runs = rows('claude-haiku-5-5-20261001');
  current.runs[2].modelProof.reports[0].provider = 'other';
  assert.equal(compareBrowserRuns(baseline, current).pairs[0].eligible, false);
});

{
const meta = { taskDefinitionHash:'new',semanticTaskManifestHash: 'same', deadlineAuthority: { ...fixtureDeadlineAuthority, scoringDefinitionHash: 'new' }, effort: 'medium', benchmarkTimezone:'Asia/Seoul',benchmarkDay:'2026-10-16',startedAt:'2026-10-16T01:00:00Z',finishedAt:'2026-10-16T01:05:00Z',armDefinitions:[{id:'haiku',agent:'claude',model:'claude-haiku-5-5'}] };
const runs = Array.from({length:3},()=>({task:'task',arm:'haiku',passed:true,status:'done',limitMs:1000000,wallMs:1000,startedAt:meta.startedAt,finishedAt:meta.finishedAt,effortProof: fixtureEffortProof, modelProof:{verified:true,reports:[{model:'claude-haiku-5-5',provider:'anthropic'}]}}));
const baseline={meta:{...meta,taskDefinitionHash:'original',scoringDefinitionHash:'new',semanticTaskManifestHash:'same'},runs};
const current={meta:{...meta,semanticTaskManifestHash:'same'},runs};
test('corrected reference retains original source hash and compares only with the same scorer and semantic task manifest',()=>{
 assert.equal(compareBrowserRuns(baseline,current).pairs[0].eligible,true);
 assert.equal(baseline.meta.taskDefinitionHash,'original');
 for(const next of [{...current.meta,semanticTaskManifestHash:'changed-prompt-or-url'},{...current.meta,semanticTaskManifestHash:undefined},{...current.meta,taskDefinitionHash:'other-scorer'}]) assert.equal(compareBrowserRuns(baseline,{...current,meta:next}).pairs[0].eligible,false);
});
test('correction cannot bypass trial, day, actual model or arm identity guards',()=>{
 for(const data of [{...current,runs:[...runs,{...runs[0],status:'provider-error',passed:false}]},{...current,meta:{...current.meta,benchmarkDay:'2026-10-17'}},{...current,runs:runs.map(r=>({...r,effortProof: fixtureEffortProof, modelProof:{verified:true,reports:[{model:'claude-haiku-5-5-20990101',provider:'anthropic'}]}}))},{...current,meta:{...current.meta,armDefinitions:[{id:'haiku',agent:'pi',model:'anthropic/claude-haiku-5.5'}]}}]) assert.equal(compareBrowserRuns(baseline,data).pairs[0].eligible,false);
});
}

test('actual provider effort proof rejects missing, contradictory and assistant-invented settings', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-effort-'));
  const file = path.join(root, 'provider.ndjson');
  const proof = (rows, agent = 'codex', requested = 'medium') => {
    const scoped = agent === 'codex' ? [{ kind: 'in', json: { id: 1, method: 'thread/start' } }, { kind: 'out', json: { id: 1, result: { model: 'fixture-model', thread: { id: 'actual-thread' } } } }, ...rows] : rows;
    fs.writeFileSync(file, scoped.map(row => JSON.stringify(row)).join('\n'));
    return browserReportedEffort([file], { agent, requested, modelProof: { verified: true, reports: [{ model: 'fixture-model', sourceSha256: createHash('sha256').update(fs.readFileSync(file)).digest('hex') }] } });
  };
  const spawn = { kind: 'spawn', argv: ['codex', '-c', 'model_reasoning_effort="medium"', 'app-server'] };
  const turn = { kind: 'in', json: { method: 'turn/start', params: { threadId: 'actual-thread', effort: 'medium', collaborationMode: { settings: { reasoning_effort: 'medium' } } } } };
  try {
    const valid = proof([spawn, turn]); assert.equal(valid.verified, true); assert.ok(valid.reports.every(r => /^[a-f0-9]{64}$/.test(r.sourceSha256)));
    assert.equal(proof([spawn]).verified, false);
    assert.equal(proof([spawn, { ...turn, json: { ...turn.json, params: { ...turn.json.params, threadId: 'discovery-thread' } } }]).verified, false);
    assert.equal(proof([turn]).verified, false);
    assert.equal(proof([spawn, { ...turn, json: { method: 'turn/start', params: { effort: 'high' } } }]).verified, false);
    assert.equal(proof([{ kind: 'out', json: { type: 'assistant', message: { content: [{ text: 'effort medium --effort medium' }] } } }], 'claude').verified, false);
    assert.equal(proof([{ kind: 'spawn', argv: ['claude', '--effort', 'medium'] }], 'claude').verified, true);
    assert.equal(proof([{ kind: 'spawn', argv: ['claude', '--effort', 'high'] }], 'claude').verified, false);
    assert.equal(proof([{ kind: 'spawn', argv: ['claude', '--effort', 'medium', '--effort', 'high'] }], 'claude').verified, false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('effort comparison requires actual unanimous proof matching both phase configurations', () => {
  const meta = { semanticTaskManifestHash: 'same', deadlineAuthority: fixtureDeadlineAuthority, effort: 'medium', taskDefinitionHash: 'same', benchmarkTimezone: BENCHMARK_TIMEZONE, benchmarkDay: '2026-10-16', startedAt: '2026-10-15T20:00:00Z', finishedAt: '2026-10-15T20:05:00Z', armDefinitions: [{ id: 'haiku', agent: 'claude', model: 'claude-haiku-5-5' }] };
  const rows = () => [1, 2, 3].map(rep => ({ task: 'site', arm: 'haiku', rep, passed: true, status: 'done', limitMs: 1000000, wallMs: 100, startedAt: meta.startedAt, finishedAt: meta.finishedAt, modelProof: fixtureModelProof, effortProof: structuredClone(fixtureEffortProof) }));
  const baseline = { meta, runs: rows() }, current = { meta: { ...meta }, runs: rows() };
  assert.equal(compareBrowserRuns(baseline, current).pairs[0].eligible, true);
  current.meta.effort = 'high'; assert.equal(compareBrowserRuns(baseline, current).pairs[0].reason, 'effort-changed-or-unverified');
  current.meta.effort = 'medium'; delete current.runs[0].effortProof;
  assert.equal(compareBrowserRuns(baseline, current).pairs[0].eligible, false);
  current.runs = rows(); current.runs[1].effortProof.reports[0].effort = 'high';
  assert.equal(compareBrowserRuns(baseline, current).pairs[0].eligible, false);
  current.runs = rows(); delete current.meta.effort;
  assert.equal(compareBrowserRuns(baseline, current).pairs[0].eligible, false);
});

test('a deadline shorter than the corrected reference budget cannot produce a speed claim', () => {
  const meta = { semanticTaskManifestHash: 'same', deadlineAuthority: fixtureDeadlineAuthority, effort: 'medium', taskDefinitionHash: 'same', benchmarkTimezone: BENCHMARK_TIMEZONE, benchmarkDay: '2026-10-16', startedAt: '2026-10-15T20:00:00Z', finishedAt: '2026-10-15T20:05:00Z', timeoutMs: 300000, armDefinitions: [{ id: 'haiku', agent: 'claude', model: 'claude-haiku-5-5' }] };
  const rows = (wallMs, limitMs) => [1,2,3].map(rep => ({ task:'site',arm:'haiku',rep,passed:true,status:'done',wallMs,limitMs,startedAt:meta.startedAt,finishedAt:meta.finishedAt,modelProof:fixtureModelProof,effortProof:fixtureEffortProof }));
  const baseline={meta,runs:rows(100,300000)},current={meta,runs:rows(40,149)};
  const pair=compareBrowserRuns(baseline,current).pairs[0];
  assert.equal(pair.eligible,false);assert.equal(pair.speedup,null);assert.equal(pair.deadline.requiredLimitMs,150);assert.equal(pair.reason,'recorded-deadline-shorter-than-corrected-reference');
  const previousCandidate = { meta: { ...meta, label: 'candidate' }, runs: rows(10,150) };
  assert.equal(compareBrowserRuns(previousCandidate,current).pairs[0].deadline.requiredLimitMs,150);
  assert.equal(compareBrowserRuns(previousCandidate,current).pairs[0].eligible,false);
  current.runs=rows(40,150);assert.equal(compareBrowserRuns(baseline,current).pairs[0].eligible,true);
  assert.equal(compareBrowserRuns(previousCandidate,current).pairs[0].eligible,true);
  const newerScorer = { ...meta, taskDefinitionHash: 'newer-scoring', semanticTaskManifestHash: 'same' };
  assert.equal(compareBrowserRuns({ ...previousCandidate, meta: newerScorer },{ ...current, meta: newerScorer }).pairs[0].reason,'deadline-authority-changed-or-unverified');
  assert.equal(compareBrowserRuns({ ...previousCandidate, meta: { ...previousCandidate.meta, deadlineAuthority: { ...fixtureDeadlineAuthority, canonicalSourceSha256: 'b'.repeat(64) } } },current).pairs[0].eligible,false);
  delete current.runs[0].limitMs;assert.equal(compareBrowserRuns(baseline,current).pairs[0].eligible,false);
});


test('execution budgets use the original canonical task limits and reject altered scope', () => {
  const authority = { ...fixtureDeadlineAuthority, taskLimits: { site: 24400 }, fallbackTimeoutMs: 300000 };
  assert.deepEqual(browserDeadlineBudget(authority, { scoringDefinitionHash: 'same', semanticTaskManifestHash: 'same' }), { taskLimits: { site: 24400 }, fallbackTimeoutMs: 300000 });
  assert.throws(() => browserDeadlineBudget(authority, { scoringDefinitionHash: 'changed' }));
  assert.throws(() => browserDeadlineBudget(authority, { semanticTaskManifestHash: 'changed-prompt-url' }));
  assert.throws(() => browserDeadlineBudget({ ...authority, fallbackTimeoutMs: NaN }));
  assert.throws(() => browserDeadlineBudget({ ...authority, taskLimits: { site: -1 } }));
});


test('checkpoint resume preserves its original timeout before starting any runtime', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-resume-timeout-'));
  const out = path.join(directory, 'checkpoint.json');
  const command = new URL('./browser-agent-suite.mjs', import.meta.url).pathname;
  const repoRoot = new URL('../../../', import.meta.url).pathname;
  const task = 'naver-second-result';
  const meta = {
    timeoutMs: 10000, effort: 'medium', deadlineAuthority: null,
    commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim(),
    label: 'baseline', probe: true, fingerprint: runtimeSourceFingerprint({ repoRoot, harnessRoot: repoRoot }),
    repetitions: 1, budgetUsd: 10, armDefinitions: browserArms.filter(arm => arm.id === 'haiku'),
    benchmarkTimezone: BENCHMARK_TIMEZONE, benchmarkDay: benchmarkDay(new Date().toISOString()),
    comparisonFiles: [], taskIds: [task], armIds: ['haiku'],
  };
  // Completed probe rows ensure even a missing guard cannot launch a browser/model.
  const runs = [{ task, arm: 'probe', rep: 1, status: 'done', passed: false, blocked: false }];
  const args = [command, '--probe', '--label=baseline', '--reps=1', '--arms=haiku', '--tasks=' + task, '--out=' + out, '--repo-root=' + repoRoot];
  try {
    fs.writeFileSync(out, JSON.stringify({ meta, runs }));
    execFileSync(process.execPath, [...args, '--timeout-ms=10000'], { encoding: 'utf8', timeout: 10000 });
    const original = fs.readFileSync(out);
    assert.throws(() => execFileSync(process.execPath, [...args, '--timeout-ms=300000'], { encoding: 'utf8', timeout: 10000, stdio: 'pipe' }), error => /Checkpoint configuration changed/.test(String(error.stderr)));
    assert.deepEqual(fs.readFileSync(out), original);
    assert.equal(JSON.parse(original).meta.timeoutMs, 10000);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
