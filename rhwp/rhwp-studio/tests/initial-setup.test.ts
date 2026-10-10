import assert from 'node:assert/strict';
import test from 'node:test';

import { AGENT_MODELS } from '../src/agent/models.ts';
import type { AgentName, AgentSetupStatus } from '../src/agent/types.ts';
import { PROVIDER_ORDER } from '../src/ui/agent-sidebar/providers.ts';
import {
  isProviderConfigured,
  previewModelLabels,
  PROVIDER_VENDOR,
  SUGGESTED_AGENT,
} from '../src/ui/initial-setup/catalog.ts';
import {
  completeInitialSetup,
  defaultInitialSetup,
  isInitialSetupComplete,
  loadInitialSetup,
  shouldForceInitialSetup,
  shouldShowInitialSetup,
  shouldSuppressInitialSetup,
} from '../src/ui/initial-setup/state.ts';

function memoryStore(seed: Record<string, string> = {}) {
  const store = new Map(Object.entries(seed));
  return {
    getItem(key: string) {
      return store.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      store.set(key, value);
    },
  };
}

function status(partial: Partial<AgentSetupStatus> & { agent: AgentName }): AgentSetupStatus {
  return {
    available: false,
    connected: false,
    installed: false,
    installing: false,
    version: null,
    authenticated: false,
    authMethod: null,
    keyTail: null,
    authenticating: false,
    setupComplete: false,
    latestVersion: null,
    updateRequired: false,
    error: null,
    ...partial,
  };
}

test('첫 실행 플래그가 없으면 마법사를 보여 준다', () => {
  const storage = memoryStore();
  assert.equal(isInitialSetupComplete(storage), false);
  assert.equal(shouldShowInitialSetup(storage, ''), true);
  assert.deepEqual(loadInitialSetup(storage), defaultInitialSetup());
});

test('끝내거나 건너뛰면 다음 실행에서 다시 열리지 않는다', () => {
  const storage = memoryStore();
  completeInitialSetup({ providerStep: 'skipped', calibrationStep: 'skipped' }, storage, () => '2026-08-23T00:00:00.000Z');
  assert.equal(isInitialSetupComplete(storage), true);
  assert.equal(shouldShowInitialSetup(storage, ''), false);
  const saved = loadInitialSetup(storage);
  assert.equal(saved.providerStep, 'skipped');
  assert.equal(saved.calibrationStep, 'skipped');
  assert.equal(saved.completedAt, '2026-08-23T00:00:00.000Z');
});

test('?initial-setup=1 이면 끝난 뒤에도 다시 연다', () => {
  const storage = memoryStore();
  completeInitialSetup({ providerStep: 'configured', calibrationStep: 'done' }, storage);
  assert.equal(shouldForceInitialSetup('?initial-setup=1'), true);
  assert.equal(shouldForceInitialSetup('initial-setup'), true);
  assert.equal(shouldForceInitialSetup('?foo=1'), false);
  assert.equal(shouldShowInitialSetup(storage, '?initial-setup=1'), true);
  assert.equal(shouldSuppressInitialSetup(), typeof navigator !== 'undefined' && navigator.webdriver === true);
});

test('카드 모델 목록은 현재 선택과 Pi 기본 안내를 짧게 보여 준다', () => {
  assert.deepEqual(previewModelLabels('claude'), AGENT_MODELS.claude.map((model) => model.label));
  assert.deepEqual(previewModelLabels('codex'), AGENT_MODELS.codex.map((model) => model.label));
  assert.deepEqual(previewModelLabels('pi'), ['OpenRouter에서 고름', '최대 3개']);
  assert.equal(SUGGESTED_AGENT, 'claude');
  assert.equal(PROVIDER_ORDER[0], 'claude');
  assert.deepEqual([...PROVIDER_ORDER], ['claude', 'codex', 'pi']);
  assert.equal(PROVIDER_VENDOR.claude, 'Anthropic');
  for (const agent of PROVIDER_ORDER) {
    assert.ok(PROVIDER_VENDOR[agent]);
  }
});

test('연결됨은 실행 가능한 CLI와 인증을 둘 다 확인한다', () => {
  const statuses = {
    claude: status({ agent: 'claude', available: true }),
    codex: status({ agent: 'codex', connected: true }),
    pi: status({ agent: 'pi', setupComplete: true }),
  };
  assert.equal(isProviderConfigured('claude', statuses), false);
  assert.equal(isProviderConfigured('codex', statuses), true);
  assert.equal(isProviderConfigured('pi', statuses), true);
});
