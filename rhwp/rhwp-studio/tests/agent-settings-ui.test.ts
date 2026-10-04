import test from 'node:test';
import assert from 'node:assert/strict';
import { formatRelativeTime, formatResetAt, formatTokens, formatUsageAge, formatUsageReset } from '../src/ui/agent-sidebar/usage-format.ts';
import { AGENT_LABEL, MASK_ICON_AGENTS, PROVIDER_ICON_SRC, PROVIDER_ORDER } from '../src/ui/agent-sidebar/providers.ts';

test('토큰·시각 표기는 짧게 (폭이 흔들리지 않게)', () => {
  assert.equal(formatTokens(980), '980');
  assert.equal(formatTokens(340_000), '340K');
  assert.equal(formatTokens(1_240_000), '1.2M');
  const now = Date.now();
  assert.equal(formatRelativeTime(now, now), '방금');
  assert.equal(formatRelativeTime(now - 5 * 60_000, now), '5분 전');
  assert.equal(formatRelativeTime(now - 3 * 3_600_000, now), '3시간 전');
  assert.equal(formatRelativeTime(now - 50 * 3_600_000, now), '2일 전');
  assert.equal(formatResetAt(now + 5 * 60_000, now), '5분 후 리셋');
  assert.equal(formatResetAt(now + 3 * 3_600_000, now), '3시간 후 리셋');
  assert.equal(formatResetAt(now - 1_000, now), '곧 리셋');
  assert.equal(formatUsageAge(now - 5 * 60_000, now), '5m ago');
  assert.equal(formatUsageAge(now - 3 * 3_600_000, now), '3h ago');
  assert.equal(formatUsageReset(now + 5 * 60_000, now), 'Resets in 5m');
  assert.equal(formatUsageReset(now + 3 * 3_600_000, now), 'Resets in 3h');
});

test('provider values share the live provider catalog', () => {
  assert.deepEqual([...PROVIDER_ORDER], ['claude', 'codex', 'pi']);
  assert.deepEqual(PROVIDER_ORDER.map(name => AGENT_LABEL[name]), ['Claude', 'Codex', 'Pi']);
  assert.deepEqual([...MASK_ICON_AGENTS], ['codex', 'pi']);
  assert.equal(PROVIDER_ICON_SRC.claude, '/icons/provider-claude.png');
  assert.equal(PROVIDER_ICON_SRC.codex, '/icons/provider-codex.png');
});
