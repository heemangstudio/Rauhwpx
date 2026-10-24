// token-usage-request → token-usage: Studio 의 설정 > AI > 사용량 토큰 보기가 받는 보고서.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { HUB_TEST_TOKEN as TOKEN, closeClient, openClient, sendFrame, startHub } from './hub-harness.mjs';

test('the hub answers token-usage-request with a report built from the CLI session logs', { timeout: 40_000 }, async (t) => {
  const logs = mkdtempSync(path.join(os.tmpdir(), 'rhwp-hub-token-logs-'));
  t.after(() => rmSync(logs, { recursive: true, force: true }));
  const claudeDir = path.join(logs, 'claude');
  const projects = path.join(claudeDir, 'projects', 'p');
  mkdirSync(projects, { recursive: true });
  writeFileSync(path.join(projects, 's.jsonl'), `${JSON.stringify({
    type: 'assistant', sessionId: 's', requestId: 'r', timestamp: new Date().toISOString(),
    message: { id: 'm', model: 'claude-sonnet-5-5', usage: {
      input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 40,
    } },
  })}\n`);

  const hub = await startHub(t, {
    prefix: 'rhwp-hub-token-usage-',
    env: {
      CLAUDE_CONFIG_DIR: claudeDir,
      CODEX_HOME: path.join(logs, 'codex'),
      PI_CODING_AGENT_DIR: path.join(logs, 'pi'),
      RHWP_PI_DIR: path.join(logs, 'rhwp-pi'),
    },
  });
  const studio = await openClient(`ws://127.0.0.1:${hub.port}/studio?token=${TOKEN}&sessionId=token-usage&instance=page-1`);
  t.after(() => closeClient(studio));
  await studio.next((frame) => frame.type === 'welcome');

  sendFrame(studio, { type: 'token-usage-request', requestId: 'token-usage-1', days: 7 });
  const report = await studio.next((frame) => frame.type === 'token-usage' && frame.requestId === 'token-usage-1');
  assert.equal(report.days, 7);
  assert.equal(report.totalTokens, 100);
  assert.equal(report.sessions, 1);
  assert.deepEqual(report.providers.map((p) => p.agent), ['claude']);
  assert.equal(report.daily.length, 7);
  assert.equal(report.daily.at(-1).claude, 100);

  sendFrame(studio, { type: 'token-usage-request', requestId: 'token-usage-2', days: 'all', refresh: true });
  const fallback = await studio.next((frame) => frame.type === 'token-usage' && frame.requestId === 'token-usage-2');
  assert.equal(fallback.days, 30);
  assert.equal(fallback.daily.length, 30);
});
