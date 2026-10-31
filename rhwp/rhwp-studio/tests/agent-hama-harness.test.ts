import test from 'node:test';
import assert from 'node:assert/strict';
import { inactiveHamaStatus } from '../src/agent/hama-status.ts';
import type { HamaStatus, PiModelConfig } from '../src/agent/types.ts';
import {
  hamaEntry,
  hamaGauge,
  hamaIsDefault,
  readHarnessChoice,
  recordHarnessChoice,
} from '../src/ui/agent-sidebar/hama-harness.ts';

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 9, 30, 3, 0, 0);

const haiku: PiModelConfig = {
  id: 'anthropic/claude-haiku-5.5', name: 'Haiku 5.5', reasoning: true, supportsImages: true,
  efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'medium', contextLength: 200_000, pricing: { prompt: 0, completion: 0 },
};

function active(overrides: Partial<HamaStatus> = {}): HamaStatus {
  return {
    availability: 'active',
    plan: { status: 'active', allowanceUsd: 15, periodStart: NOW - 20 * 24 * HOUR, periodEnd: NOW + 10 * 24 * HOUR },
    caps: {
      cap_5h: { usedUsd: 0.4, limitUsd: 3, resetsAt: null },
      cap_week: { usedUsd: 1.2, limitUsd: 7.5, resetsAt: null },
      cap_month: { usedUsd: 2, limitUsd: 15, resetsAt: NOW + 10 * 24 * HOUR },
    },
    blocked: null,
    models: [haiku],
    defaultModelId: haiku.id,
    cheapModelIds: [],
    ready: true,
    ...overrides,
  };
}

test('Hama entry: active opens it, Basic and legacy keys never see it, Free desktop sees it locked, web hides it', () => {
  assert.equal(hamaEntry(active(), false), 'open');
  assert.equal(hamaEntry(active(), true), 'open');
  // not_enrolled = a valid license without a Hama plan (Basic, legacy): their upgrade entry is on the home screen.
  assert.equal(hamaEntry(inactiveHamaStatus('not_enrolled'), true), 'hidden');
  assert.equal(hamaEntry(inactiveHamaStatus('not_enrolled'), false), 'hidden');
  // unavailable = no license (Free) or the server is unreachable.
  for (const status of [null, inactiveHamaStatus('unavailable')]) {
    assert.equal(hamaEntry(status, true), 'locked');
    assert.equal(hamaEntry(status, false), 'hidden');
  }
});

test('Hama is the default only for connected Hama subscribers without another chosen or used harness', () => {
  const fresh = { choice: null, hasChats: false };
  assert.equal(hamaIsDefault(active(), fresh), true);
  // Basic, Free and lapsed plans keep their provider.
  assert.equal(hamaIsDefault(inactiveHamaStatus('not_enrolled'), fresh), false);
  assert.equal(hamaIsDefault(active({ ready: false }), fresh), false);
  // A recorded choice wins; Hama stays default only when Hama itself was the last choice.
  assert.equal(hamaIsDefault(active(), { choice: 'claude', hasChats: false }), false);
  assert.equal(hamaIsDefault(active(), { choice: 'pi', hasChats: true }), false);
  assert.equal(hamaIsDefault(active(), { choice: 'hama', hasChats: true }), true);
  // Users who chatted before the choice was recorded keep their provider.
  assert.equal(hamaIsDefault(active(), { choice: null, hasChats: true }), false);
});

test('the harness choice is stored and read back', () => {
  const map = new Map<string, string>();
  const storage = { getItem: (key: string) => map.get(key) ?? null, setItem: (key: string, value: string) => { map.set(key, value); } };
  assert.equal(readHarnessChoice(storage), null);
  recordHarnessChoice('codex', storage);
  assert.equal(readHarnessChoice(storage), 'codex');
  recordHarnessChoice('hama', storage);
  assert.equal(readHarnessChoice(storage), 'hama');
});

test('gauge percentages round, clamp, and read a blocked window as full', () => {
  const status = active({
    caps: {
      cap_5h: { usedUsd: 2.9, limitUsd: 3, resetsAt: null },
      cap_week: { usedUsd: 9, limitUsd: 7.5, resetsAt: null },
      cap_month: { usedUsd: 0, limitUsd: 0, resetsAt: NOW + HOUR },
    },
    blocked: { cap: 'cap_5h', resetsAt: NOW + 2 * HOUR, cheapAvailable: true },
  });
  const windows = hamaGauge(status);
  assert.deepEqual(windows.map((window) => [window.cap, window.percent, window.blocked]), [
    ['cap_5h', 100, true],
    ['cap_week', 100, false],
    ['cap_month', 0, false],
  ]);
  // The blocked window's reset comes from the block when the window has none.
  assert.equal(windows[0]!.resetsAt, NOW + 2 * HOUR);
  assert.deepEqual(hamaGauge(inactiveHamaStatus('not_enrolled')), []);
});
