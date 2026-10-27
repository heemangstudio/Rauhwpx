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
  INITIAL_SETUP_STORAGE_KEY,
  isInitialSetupComplete,
  isInitialSetupDeferred,
  loadInitialSetup,
  saveInitialSetup,
  shouldForceInitialSetup,
  shouldShowInitialSetup,
  shouldSuppressInitialSetup,
} from '../src/ui/initial-setup/state.ts';
import { indexHasHancomFonts, planFontStep, planSteps } from '../src/ui/initial-setup/steps.ts';
import { needsLicenseStep } from '../src/ui/initial-setup/license-step.ts';
import { looksLikeFullKey } from '../src/ui/agent-sidebar/settings-license.ts';
import type { LicenseStatus } from '../src/ui/agent-sidebar/settings-license.ts';
import { BOOT_FINAL_HOLD_MS, remainingBootMs } from '../src/ui/boot-screen.ts';

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

test('이전 버전에서 끝낸 설정은 업데이트 뒤에도 다시 열리지 않는다', () => {
  const storage = memoryStore({
    [INITIAL_SETUP_STORAGE_KEY]: JSON.stringify({
      version: 1,
      completed: true,
      completedAt: '2026-08-01T00:00:00.000Z',
      providerStep: 'configured',
      calibrationStep: 'done',
    }),
  });
  assert.equal(shouldShowInitialSetup(storage, ''), false);
  const migrated = loadInitialSetup(storage);
  assert.equal(migrated.version, 2);
  assert.equal(migrated.providerStep, 'configured');
  assert.equal(migrated.calibrationStep, 'done');
  assert.equal(migrated.deferred, false);
});

test('문서를 열면서 처음 켜져 미룬 설정은 자동으로 열지 않고 칩으로만 권한다', () => {
  const storage = memoryStore();
  saveInitialSetup({ deferred: true }, storage);
  assert.equal(shouldShowInitialSetup(storage, ''), false);
  assert.equal(isInitialSetupDeferred(storage), true);
  completeInitialSetup({ themeStep: 'done', providerStep: 'skipped' }, storage);
  assert.equal(isInitialSetupDeferred(storage), false);
  assert.equal(isInitialSetupComplete(storage), true);
});

test('글꼴 단계는 한컴 글꼴을 스스로 찾지 못했을 때만 넣는다', () => {
  const base = { desktop: false, hancomFonts: null, canDiscover: false };
  // 데스크톱: 색인에 없을 때만 다시 찾기·한컴오피스 받기를 보인다.
  assert.equal(planFontStep({ ...base, desktop: true, hancomFonts: false }), 'missing');
  assert.equal(planFontStep({ ...base, desktop: true, hancomFonts: true }), null);
  // 색인을 못 받았으면 없다고 단정하지 않는다.
  assert.equal(planFontStep({ ...base, desktop: true, hancomFonts: null }), null);
  // 브라우저: 조용히 찾았으면 묻지 않고, 못 찾았으면 한 번 눌러 찾게 한다.
  assert.equal(planFontStep({ ...base, canDiscover: true }), 'discover');
  assert.equal(planFontStep({ ...base, canDiscover: true, hancomFonts: false }), 'discover');
  assert.equal(planFontStep({ ...base, canDiscover: true, hancomFonts: true }), null);
  // 찾을 방법이 없는 브라우저는 묻지 않는다.
  assert.equal(planFontStep(base), null);
  assert.deepEqual(planSteps('discover'), ['theme', 'models', 'fonts']);
  assert.deepEqual(planSteps(null), ['theme', 'models']);
});

test('자동 버그 수정 단계는 데스크톱에서만 맨 끝에 넣는다', () => {
  assert.deepEqual(planSteps('missing', { autofix: true }), ['theme', 'models', 'fonts', 'autofix']);
  assert.deepEqual(planSteps(null, { autofix: true }), ['theme', 'models', 'autofix']);
  assert.deepEqual(planSteps(null, { autofix: false }), ['theme', 'models']);
});

test('라이선스 장은 키를 넣지 않은 데스크톱 사용자에게만 자동 버그 수정 앞에 뜬다', () => {
  const status = (state: LicenseStatus['state']) => ({ state } as LicenseStatus);
  for (const state of ['trial', 'trial_expired', 'needs_activation'] as const) assert.equal(needsLicenseStep(status(state)), true);
  for (const state of ['licensed', 'unenforced', 'lease_expired', 'revoked', 'expired'] as const) assert.equal(needsLicenseStep(status(state)), false);
  // 웹 빌드처럼 라이선스 API 가 없으면 장이 없다.
  assert.equal(needsLicenseStep(null), false);
  assert.deepEqual(planSteps('missing', { license: true }), ['theme', 'models', 'fonts', 'license']);
  assert.deepEqual(planSteps(null, { autofix: true, license: true }), ['theme', 'models', 'license', 'autofix']);
  // Rau-0.1 은 자동 버그 수정 바로 앞에 묻는다.
  assert.deepEqual(planSteps('missing', { autofix: true, license: true, taste: true }), ['theme', 'models', 'fonts', 'license', 'taste', 'autofix']);
  // ChatGPT·Claude 연결은 데스크톱에서 Rau-0.1 바로 앞에 묻는다.
  assert.deepEqual(planSteps('missing', { autofix: true, license: true, connectors: true, taste: true }), ['theme', 'models', 'fonts', 'license', 'connectors', 'taste', 'autofix']);
  assert.deepEqual(planSteps(null, { connectors: true }), ['theme', 'models', 'connectors']);
  // 붙여 넣은 키는 다 찼을 때만 바로 확인한다.
  assert.equal(looksLikeFullKey(' hama-7kq2m-px4rt-9wzlb-c3vnd-h8yja\n'), true);
  assert.equal(looksLikeFullKey('HAMA-7KQ2M-PX4RT'), false);
});

test('한컴 설치 폴더의 글꼴이나 한컴 전용 글꼴이 있으면 한컴 글꼴이 있다고 본다', () => {
  const face = (partial: { source?: 'system' | 'user' | 'hancom'; families?: string[]; koreanNames?: string[] }) => ({
    source: partial.source ?? 'system',
    families: partial.families ?? [],
    koreanNames: partial.koreanNames ?? [],
    fullNames: [],
  });
  const index = (...faces: ReturnType<typeof face>[]) => ({ faces }) as unknown as Parameters<typeof indexHasHancomFonts>[0];
  assert.equal(indexHasHancomFonts(index(face({ families: ['Malgun Gothic'] }), face({ families: ['Batang'] }))), false);
  assert.equal(indexHasHancomFonts(index(face({ source: 'hancom', families: ['Anything'] }))), true);
  // 운영체제 글꼴 폴더에 설치된 한컴 글꼴도 이름으로 알아본다.
  assert.equal(indexHasHancomFonts(index(face({ families: ['HYHeadLine-Medium'] }))), true);
  assert.equal(indexHasHancomFonts(index(face({ koreanNames: ['휴먼명조'] }))), true);
});

test('부트 화면은 첫 실행 애니메이션이 끝나고 마지막 프레임을 잠깐 보인 뒤 걷힌다', () => {
  const intro = { mode: 'intro' as const, shownAt: 1000, animationMs: 2700 };
  assert.equal(remainingBootMs(intro, 1000), 2700 + BOOT_FINAL_HOLD_MS);
  assert.equal(remainingBootMs(intro, 1000 + 2700 + BOOT_FINAL_HOLD_MS + 1), 0);
  // 건너뛰거나 정지 로고면 기다리지 않는다.
  assert.equal(remainingBootMs({ ...intro, mode: 'still' }, 1000), 0);
});
