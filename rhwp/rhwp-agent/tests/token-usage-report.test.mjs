import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, renameSync, rmSync, statSync, utimesSync, writeFileSync, appendFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createTokenUsageReporter,
  defaultTokenUsageSources,
  priceForModel,
} from '../token-usage-report.mjs';

// 고정한 "지금": 2026-10-24 12:00 (로컬 시각).
const NOW = new Date(2026, 9, 24, 12, 0, 0).getTime();
const local = (day, hour = 12, minute = 0) => new Date(2026, 9, day, hour, minute).toISOString();

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rhwp-token-usage-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dirs = {
    claude: path.join(root, 'claude', 'projects'),
    codex: path.join(root, 'codex', 'sessions'),
    archived: path.join(root, 'codex', 'archived_sessions'),
    pi: path.join(root, 'pi', 'sessions'),
    usage: path.join(root, 'usage'),
  };
  const write = (file, lines) => {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, lines.map((line) => `${JSON.stringify(line)}\n`).join(''));
    utimesSync(file, NOW / 1000, NOW / 1000);
    return file;
  };
  const reporter = (options = {}) => createTokenUsageReporter({
    usageRoot: dirs.usage,
    sources: () => ({ claude: [dirs.claude], codex: [dirs.codex, dirs.archived], pi: [dirs.pi] }),
    now: () => NOW,
    warn: () => {},
    ...options,
  });
  return { root, dirs, write, reporter };
}

const claudeLine = ({ id, requestId, sessionId = 's1', at = local(24), model = 'claude-opus-5-5', usage }) => ({
  type: 'assistant', sessionId, requestId, timestamp: at,
  message: { id, model, role: 'assistant', content: [{ type: 'text', text: 'secret prompt text' }], usage },
});
const codexCount = (at, total, last) => ({
  timestamp: at, type: 'event_msg',
  payload: { type: 'token_count', info: { total_token_usage: total, last_token_usage: last } },
});
const usage = (input, cached, output) => ({ input_tokens: input, cached_input_tokens: cached, output_tokens: output });
const provider = (report, agent) => report.providers.find((p) => p.agent === agent);

test('Claude lines repeated while streaming and copied into a resumed session count once, at their final size', async (t) => {
  const { dirs, write, reporter } = fixture(t);
  const u = (output) => ({ input_tokens: 10, output_tokens: output, cache_read_input_tokens: 1000, cache_creation_input_tokens: 100 });
  write(path.join(dirs.claude, 'proj', 'a.jsonl'), [
    claudeLine({ id: 'm1', requestId: 'r1', usage: u(5) }),
    claudeLine({ id: 'm1', requestId: 'r1', usage: u(50) }),
    claudeLine({ id: 'm2', requestId: 'r2', usage: u(7) }),
    { type: 'user', message: { role: 'user', content: 'hello' } },
  ]);
  // 이어 쓴 세션: m1 을 다시 담고 새 응답 m3 을 더한다.
  write(path.join(dirs.claude, 'proj', 'b.jsonl'), [
    claudeLine({ id: 'm1', requestId: 'r1', sessionId: 's2', usage: u(50) }),
    claudeLine({ id: 'm3', requestId: 'r3', sessionId: 's2', usage: u(1) }),
  ]);

  const report = await reporter().report(7);
  const claude = provider(report, 'claude');
  assert.deepEqual(
    [claude.inputTokens, claude.outputTokens, claude.cacheReadTokens, claude.cacheCreationTokens],
    [30, 58, 3000, 300],
  );
  assert.equal(claude.tokens, 30 + 58 + 3000 + 300);
  assert.equal(claude.sessions, 2);
  // opus-5-5: 4 / 20 / 0.2 / 5 USD per MTok
  assert.equal(claude.costUsd, Math.round(((30 * 4 + 58 * 20 + 3000 * 0.2 + 300 * 5) / 1e6) * 100) / 100);
  assert.doesNotMatch(JSON.stringify(report), /secret prompt text|hello/);
});

test('Codex cumulative totals become per-turn deltas, cached input is split out, and appended turns resume the running total', async (t) => {
  const { dirs, write, reporter } = fixture(t);
  const file = write(path.join(dirs.codex, '2026', '10', '24', 'rollout-x.jsonl'), [
    { timestamp: local(24, 9), type: 'session_meta', payload: { id: 'codex-session', instructions: 'private' } },
    { timestamp: local(24, 9), type: 'turn_context', payload: { model: 'gpt-6.1-sol' } },
    codexCount(local(24, 9), usage(1000, 600, 50), usage(1000, 600, 50)),
    // 같은 누적값이 다시 온다 (재전송).
    codexCount(local(24, 9), usage(1000, 600, 50), usage(1000, 600, 50)),
    codexCount(local(24, 10), usage(2500, 1800, 80), usage(1500, 1200, 30)),
    { timestamp: local(24, 10), type: 'event_msg', payload: { type: 'token_count', info: null } },
  ]);
  const usageReporter = reporter({ scanMemoMs: 0 });
  let codex = provider(await usageReporter.report(7), 'codex');
  assert.deepEqual(
    [codex.inputTokens, codex.cacheReadTokens, codex.outputTokens, codex.cacheCreationTokens, codex.sessions],
    [700, 1800, 80, 0, 1],
  );
  assert.equal(codex.tokens, 2580);
  assert.equal(codex.costUsd, Math.round(((700 * 2 + 1800 * 0.1 + 80 * 10) / 1e6) * 100) / 100);

  appendFileSync(file, `${JSON.stringify(codexCount(local(24, 11), usage(3000, 2000, 100), usage(500, 200, 20)))}\n`);
  utimesSync(file, NOW / 1000, NOW / 1000 + 1);
  // 새로고침이 아니면 지난 결과로 바로 답하고 뒤에서 다시 훑는다.
  codex = provider(await usageReporter.report(7), 'codex');
  assert.deepEqual([codex.inputTokens, codex.cacheReadTokens, codex.outputTokens], [700, 1800, 80]);
  codex = provider(await usageReporter.report(7, { refresh: true }), 'codex');
  assert.deepEqual([codex.inputTokens, codex.cacheReadTokens, codex.outputTokens], [1000, 2000, 100]);
});

test('a forked Codex rollout that starts from its parent total only counts its own turn', async (t) => {
  const { dirs, write, reporter } = fixture(t);
  write(path.join(dirs.codex, 'rollout-fork.jsonl'), [
    { timestamp: local(24), type: 'session_meta', payload: { id: 'fork' } },
    codexCount(local(24), usage(90_000, 80_000, 900), usage(1000, 0, 10)),
  ]);
  const codex = provider(await reporter().report(7), 'codex');
  assert.equal(codex.tokens, 1010);
});

test('daily buckets follow local days, are zero-filled oldest first, and the range starts at local midnight', async (t) => {
  const { dirs, write, reporter } = fixture(t);
  const u = { input_tokens: 1, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  write(path.join(dirs.claude, 'p', 'days.jsonl'), [
    claudeLine({ id: 'a', requestId: 'a', at: local(23, 23, 30), usage: { ...u, input_tokens: 5 } }),
    claudeLine({ id: 'b', requestId: 'b', at: local(18, 0, 10), usage: { ...u, input_tokens: 7 } }),
    claudeLine({ id: 'c', requestId: 'c', at: local(17, 23, 50), usage: { ...u, input_tokens: 11 } }),
    claudeLine({ id: 'd', requestId: 'd', at: local(1, 8), usage: { ...u, input_tokens: 13 } }),
  ]);
  const usageReporter = reporter();
  const week = await usageReporter.report(7);
  assert.equal(week.days, 7);
  assert.deepEqual(week.daily.map((d) => d.date), [
    '2026-10-18', '2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24',
  ]);
  assert.deepEqual(week.daily.map((d) => d.claude), [7, 0, 0, 0, 0, 5, 0]);
  assert.ok(week.daily.every((d) => d.codex === 0 && d.pi === 0));
  assert.equal(week.totalTokens, 12);

  const month = await usageReporter.report(30);
  assert.equal(month.daily.length, 30);
  assert.equal(month.totalTokens, 36);
  const fallback = await usageReporter.report(12);
  assert.equal(fallback.days, 30, 'unknown ranges fall back to 30 days');
  assert.equal((await usageReporter.report(90)).daily.length, 90);
});

test('unchanged files are served from the cache, also by a new reporter, and only changed files are read again', async (t) => {
  const { dirs, write, reporter } = fixture(t);
  const u = (n) => ({ input_tokens: n, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
  const file = write(path.join(dirs.claude, 'p', 'cache.jsonl'), [claudeLine({ id: 'x', requestId: 'x', usage: u(100) })]);
  assert.equal((await reporter().report(7)).totalTokens, 100);

  // 크기와 수정 시각이 같은 파일은 다시 읽지 않는다: 내용을 같은 길이로 바꿔도 캐시 값이 나온다.
  const size = statSync(file).size;
  writeFileSync(file, `${JSON.stringify(claudeLine({ id: 'x', requestId: 'x', usage: u(900) }))}\n`);
  assert.equal(statSync(file).size, size);
  utimesSync(file, NOW / 1000, NOW / 1000);
  assert.equal((await reporter().report(7)).totalTokens, 100, 'a fresh reporter reuses the cache file');

  utimesSync(file, NOW / 1000, NOW / 1000 + 5);
  assert.equal((await reporter().report(7, { refresh: true })).totalTokens, 900, 'a touched file is read again');
});

test('a file moved to the Codex archive counts once, and a deleted session keeps counting while in range', async (t) => {
  const { dirs, write, reporter } = fixture(t);
  const file = write(path.join(dirs.codex, 'rollout-move.jsonl'), [
    { timestamp: local(24), type: 'session_meta', payload: { id: 'moved' } },
    codexCount(local(24), usage(100, 0, 10), usage(100, 0, 10)),
  ]);
  const claude = write(path.join(dirs.claude, 'p', 'gone.jsonl'), [claudeLine({
    id: 'g', requestId: 'g', usage: { input_tokens: 40, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  })]);
  const usageReporter = reporter({ scanMemoMs: 0 });
  assert.equal((await usageReporter.report(7)).totalTokens, 150);

  mkdirSync(dirs.archived, { recursive: true });
  renameSync(file, path.join(dirs.archived, 'rollout-move.jsonl'));
  rmSync(claude);
  const report = await usageReporter.report(7);
  assert.equal(provider(report, 'codex').tokens, 110);
  assert.equal(provider(report, 'claude').tokens, 40);
});

test('Pi usage keeps the cost Pi recorded, and providers without a log folder are left out', async (t) => {
  const { dirs, write, reporter } = fixture(t);
  write(path.join(dirs.pi, '--home--', 'session.jsonl'), [
    { type: 'session', id: 'pi-session', timestamp: local(24), cwd: '/' },
    { type: 'message', id: 'u1', timestamp: local(24), message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } },
    { type: 'message', id: 'a1', timestamp: local(24), message: {
      role: 'assistant', model: 'some-unpriced-model', responseId: 'resp-1',
      usage: { input: 10, output: 20, cacheRead: 300, cacheWrite: 0, cost: { total: 0.25 } },
    } },
  ]);
  const report = await reporter().report(7);
  assert.deepEqual(report.providers.map((p) => p.agent), ['pi']);
  assert.deepEqual(provider(report, 'pi'), {
    agent: 'pi', tokens: 330, inputTokens: 10, outputTokens: 20, cacheReadTokens: 300,
    cacheCreationTokens: 0, sessions: 1, costUsd: 0.25,
  });
  assert.equal(report.sessions, 1);
});

test('lines over the length bound are skipped without losing the lines around them', async (t) => {
  const { dirs, write, reporter } = fixture(t);
  const u = (n) => ({ input_tokens: n, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
  const big = claudeLine({ id: 'big', requestId: 'big', usage: u(1000) });
  big.message.content[0].text = 'x'.repeat(4096);
  write(path.join(dirs.claude, 'p', 'long.jsonl'), [
    claudeLine({ id: 'a', requestId: 'a', usage: u(1) }), big, claudeLine({ id: 'b', requestId: 'b', usage: u(2) }),
  ]);
  assert.equal((await reporter({ maxLineBytes: 1024 }).report(7)).totalTokens, 3);
});

test('log folders follow CLAUDE_CONFIG_DIR, CODEX_HOME and PI_CODING_AGENT_DIR, else the home defaults', () => {
  const home = '/home/u';
  assert.deepEqual(defaultTokenUsageSources({ env: {}, platform: 'linux', home, piRoot: '/data/pi' }), {
    claude: ['/home/u/.config/claude/projects', '/home/u/.claude/projects'],
    codex: ['/home/u/.codex/sessions', '/home/u/.codex/archived_sessions'],
    pi: ['/home/u/.pi/agent/sessions', '/data/pi/sessions'],
  });
  const custom = defaultTokenUsageSources({
    env: { CLAUDE_CONFIG_DIR: '/a, /b', CODEX_HOME: '/c', PI_CODING_AGENT_DIR: '/p' }, platform: 'linux', home,
  });
  assert.deepEqual(custom.claude, ['/a/projects', '/b/projects']);
  assert.deepEqual(custom.codex, ['/c/sessions', '/c/archived_sessions']);
  assert.deepEqual(custom.pi, ['/p/sessions']);
  const win = defaultTokenUsageSources({ env: {}, platform: 'win32', home: 'C:\\Users\\u' });
  assert.equal(win.claude[1], 'C:\\Users\\u\\.claude\\projects');
});

test('model prices match by family and unknown models have no price', () => {
  assert.equal(priceForModel('claude-opus-5-5').input, 4);
  assert.equal(priceForModel('anthropic/claude-sonnet-4-6').input, 3);
  assert.equal(priceForModel('claude-fable-5-1').cacheRead, 0.25);
  assert.equal(priceForModel('gpt-6.1-sol').output, 10);
  assert.equal(priceForModel('<synthetic>'), null);
  assert.equal(priceForModel('abliterated-model-large-flash'), null);
});
