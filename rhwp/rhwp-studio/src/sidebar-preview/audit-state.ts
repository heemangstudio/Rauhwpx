import type { SidebarPreview } from './main.ts';
import type { BoatPreviewState } from './mock-cloud.ts';

async function until<T>(read: () => T | null | false, description: string): Promise<T> {
  const deadline = performance.now() + 10_000;
  while (performance.now() < deadline) {
    const value = read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`Could not open preview: ${description}`);
}

async function click(selector: string): Promise<void> {
  const button = await until(() => {
    const element = document.querySelector<HTMLButtonElement>(selector);
    return element && element.checkVisibility() && !element.disabled ? element : null;
  }, selector);
  button.click();
}

function select(id: string, value: string): void {
  const control = document.querySelector<HTMLSelectElement>(id)!;
  control.value = value;
  control.dispatchEvent(new Event('change', { bubbles: true }));
}

const BOAT_STATES: readonly BoatPreviewState[] = ['off', 'connected', 'billing', 'existing', 'setup', 'failed',
  'running', 'stopped', 'waking', 'stopping', 'missing', 'error'];

async function setupTitle(text: string): Promise<void> {
  await until(() => {
    const overlay = document.querySelector<HTMLElement>('.ag-cloud-setup-overlay');
    return overlay && !overlay.hidden && document.querySelector('.ag-cloud-setup-title')?.textContent === text;
  }, `setup screen ${text}`);
}

async function clickSetup(label: string): Promise<void> {
  const button = await until(() => [...document.querySelectorAll<HTMLButtonElement>('.ag-cloud-setup-dialog button')]
    .find((node) => node.textContent?.trim() === label && node.checkVisibility() && !node.disabled) ?? null, `setup button ${label}`);
  button.click();
}

async function typeSetup(selector: string, value: string): Promise<void> {
  const input = await until(() => document.querySelector<HTMLInputElement>(selector), selector);
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.form?.requestSubmit();
}

/** boat 설정 화면은 설정 카드에서 시작해 실제 버튼을 눌러 도달한다. */
async function applyBoatState(preview: SidebarPreview, params: URLSearchParams): Promise<void> {
  const cloud = preview.cloud;
  if (!cloud) return;
  const flags = new Set((params.get('boat-scenario') ?? '').split(',').filter(Boolean));
  cloud.setBoatScenario({
    invalidKey: flags.has('invalidKey'),
    billingRequired: flags.has('billingRequired'),
    expireFirstCode: flags.has('expireFirstCode'),
    existingServer: flags.has('existingServer'),
    installFailures: flags.has('installFailure') ? 1 : 0,
  });
  const boatState = params.get('boat-state') as BoatPreviewState | null;
  if (boatState && BOAT_STATES.includes(boatState)) cloud.setBoatState(boatState);
  const screen = params.get('boat-screen');
  if (params.get('boat-chat') === 'waking') {
    cloud.holdBoatWake(true);
    await click('[aria-label="프로바이더 선택"]');
    await click('.ag-provider-item[data-agent="codex"]');
    await click('.ag-header [data-workspace-mode="cloud"]');
    await until(() => preview.workspace?.mode() === 'cloud', 'Cloud execution');
    document.querySelector<HTMLButtonElement>('#play')!.click();
    await until(() => document.querySelector('.ag-cloud-recovery-strip:not([hidden])'), 'waking strip');
    return;
  }
  if (!screen) return;
  // 도착할 화면까지는 빠르게 가고, 도착한 뒤에는 실제와 비슷한 속도로 둔다.
  cloud.setBoatSpeed(0.2);
  if (screen === 'progress' || screen === 'failed') {
    await click('.ag-cloud-settings-action');
    await setupTitle(screen === 'progress' ? 'boat 서버 준비 중' : 'boat 서버를 준비하지 못했습니다');
    cloud.setBoatSpeed(1);
    return;
  }
  await click('.ag-cloud-settings-action');
  await setupTitle('Cloud 서버 선택');
  await click('.ag-cloud-setup-option[data-server-mode="boat"]');
  if (screen !== 'choose') await clickSetup('계속');
  if (screen === 'connect' || screen === 'key' || screen === 'key-error' || screen === 'signin'
    || screen === 'code' || screen === 'expired') {
    await setupTitle('boat 계정 연결');
    if (screen === 'key' || screen === 'key-error') {
      await clickSetup('API 키로 연결');
      await setupTitle('API 키로 연결');
      if (screen === 'key-error') {
        await typeSetup('#ag-boat-api-key', 'boat_live_4f9c2a7e81d3b6c0');
        await until(() => document.querySelector('.ag-cloud-setup-field-error'), 'API key error');
      }
    }
    if (screen === 'signin' || screen === 'code' || screen === 'expired') {
      await typeSetup('#ag-boat-email', 'designer@example.test');
      await setupTitle('boat 로그인');
      if (screen !== 'signin') {
        await clickSetup('로그인 페이지 열기');
        await clickSetup('로그인했습니다');
        await until(() => document.querySelector('.ag-cloud-setup-code'), 'sign-in code');
        if (screen === 'expired') await until(() => document.querySelector('.ag-cloud-setup-code[data-expired]'), 'expired code');
      }
    }
  }
  if (screen === 'billing') await setupTitle('boat 요금제 필요');
  if (screen === 'confirm') await setupTitle(boatState === 'existing' ? 'boat 서버 연결' : 'boat 서버 만들기');
  if (screen === 'ready') {
    await setupTitle('boat 서버 만들기');
    await clickSetup('서버 만들기');
    await setupTitle('boat 서버가 준비되었습니다');
  }
  cloud.setBoatSpeed(1);
}

/** Prepare fixtures through the same controls used in the shipping sidebar. */
export async function applyAuditState(preview: SidebarPreview, params: URLSearchParams): Promise<void> {
  if (params.get('permission') === 'unrestricted') preview.bridge.setPermissionProfile('unrestricted');
  const browserbase = params.get('browserbase');
  if (browserbase === 'ready' || browserbase === 'setup' || browserbase === 'error')
    preview.setBrowserbaseState(browserbase === 'ready' ? 'connected' : browserbase);
  if (params.get('document') === 'empty') select('#document', 'empty');
  const cloudState = params.get('cloud-state');
  if (preview.cloud && (cloudState === 'logged-out' || cloudState === 'exhausted'
    || cloudState === 'self-hosted' || cloudState === 'unknown'
    || cloudState === 'unconfigured' || cloudState === 'unavailable')) {
    preview.cloud.setDashboardState(cloudState);
  }
  await applyBoatState(preview, params);
  if (params.get('cloud-turn') === '1' || params.has('cloud-phase') || params.has('cloud-link')) {
    if (!preview.cloud || !preview.workspace) throw new Error('Cloud fixture is required');
    await click('[aria-label="프로바이더 선택"]');
    await click('.ag-provider-item[data-agent="codex"]');
    await click('.ag-header [data-workspace-mode="cloud"]');
    await until(() => preview.workspace?.mode() === 'cloud', 'Cloud execution');
    document.querySelector<HTMLButtonElement>('#play')!.click();
    await until(() => preview.cloud?.controller.getSnapshot().session.kind === 'running', 'Cloud conversation');
    preview.cloud.finishReply('사업 제안서의 예산과 일정을 검토했습니다. 수정 사항을 확인해 주세요.');
    if (params.get('cloud-turn') === '1') preview.cloud.commitTurn();
    const phase = params.get('cloud-phase');
    if (phase === 'working' || phase === 'waiting' || phase === 'suspended') preview.cloud.setConversationPhase(phase);
    if (params.get('cloud-view') !== 'local') await click('[data-document-view="cloud"]');
    const link = params.get('cloud-link');
    if (link === 'failed' || link === 'ready') preview.cloud.setLink(link);
  } else if (params.get('play') === '1') {
    await until(() => {
      const input = document.querySelector<HTMLTextAreaElement>('.ag-input');
      return input && !input.disabled;
    }, 'composer');
    document.querySelector<HTMLButtonElement>('#play')!.click();
    await until(() => preview.snapshot().running, 'sample reply');
    if (params.get('hold') !== '1' && params.get('scenario') !== 'question') {
      await until(() => !preview.snapshot().running, 'completed reply');
    }
  }
  const surface = params.get('surface');
  const surfaces: Record<string, string> = {
    skills: '.ag-settings-nav-button[data-destination="skills"]', references: '.ag-references-btn', threads: '.ag-header .ag-threads-btn',
    'provider-picker': '[aria-label="프로바이더 선택"]', 'model-picker': '[aria-label="모델 선택"]',
    'effort-picker': '[aria-label="추론 강도 선택"]', permissions: '.ag-permission-btn',
    'provider-setup': `.ag-settings-provider-row[data-agent="${['claude', 'codex', 'pi'].includes(params.get('provider') ?? '') ? params.get('provider') : 'codex'}"] button`,
    'cloud-options': '.ag-header [data-workspace-mode="cloud"]', 'cloud-setup': '.ag-header [data-workspace-mode="cloud"]',
  };
  if (surface === 'skills') {
    await click('.ag-settings-btn');
    await until(() => document.querySelector('.ag-root.ag-settings-open'), 'settings page');
  }
  if (surface === 'provider-setup') {
    const rowSelector = surfaces[surface]!.replace(/ button$/, '');
    const row = await until(() => document.querySelector<HTMLDetailsElement>(rowSelector), 'provider connection');
    if (!row.open) await click(`${rowSelector} summary`);
  }
  if (surface && surfaces[surface]) await click(surfaces[surface]);
  if (surface === 'changes') {
    document.querySelector('.ag-settings-page')!.dispatchEvent(
      new CustomEvent('ag-settings-expand-request', { bubbles: true }),
    );
    await until(() => document.querySelector('.ag-root.ag-fullscreen'), 'full-screen workspace');
    await click('.ag-workspace-settings-back');
    await click('.ag-environment-changes');
    await until(() => document.querySelector('.ag-root.ag-review-drawer-open'), 'changes drawer');
  }
  if (params.get('terminal') === '1' && surface === 'provider-setup' && params.get('provider') === 'claude') {
    await click('.ag-agent-setup-pane:not([hidden]) .ag-agent-setup-primary');
    await until(() => document.querySelector('.ag-setup-terminal:not([hidden]) .xterm'), 'login terminal');
  }
  const connection = params.get('connection');
  if (connection && ['connected', 'connecting', 'disconnected', 'replaced'].includes(connection)) {
    select('#connection', connection);
  }
  document.body.dataset.auditReady = 'true';
}
