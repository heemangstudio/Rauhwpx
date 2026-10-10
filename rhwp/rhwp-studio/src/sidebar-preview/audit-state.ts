import type { SidebarPreview } from './main.ts';

async function until<T>(read: () => T | null | false, description: string): Promise<T> {
  const deadline = performance.now() + 10_000;
  while (performance.now() < deadline) {
    const value = read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`Could not open preview: ${description}`);
}

/** 실제 준비 상태 — 입력기의 보이는 잠금은 400ms 늦게 따라온다(data-composer-ready 는 늦지 않는다). */
function composerReady(): boolean {
  return document.querySelector<HTMLElement>('#agent-sidebar')?.dataset.composerReady === 'true';
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

/** 입력기의 모드 칩으로 모드를 고른다. 전체 접근 확인 시트는 승인한다. */
async function chooseMode(mode: 'chat' | 'plan' | 'agent' | 'full'): Promise<void> {
  const chip = () => document.querySelector<HTMLElement>('.ag-mode');
  await until(() => chip()?.dataset.mode && !document.querySelector<HTMLButtonElement>('.ag-mode-btn')?.disabled, 'mode chip');
  if (chip()!.dataset.mode === mode) return;
  await click('.ag-mode-btn');
  await click(`.ag-mode-item[data-mode="${mode}"]`);
  const deadline = performance.now() + 10_000;
  while (chip()?.dataset.mode !== mode && performance.now() < deadline) {
    const confirm = document.querySelector<HTMLButtonElement>('.ag-sheet-open .ag-sheet-confirm');
    if (confirm?.checkVisibility()) confirm.click();
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  if (chip()?.dataset.mode !== mode) throw new Error(`Could not open preview: mode ${mode}`);
}

/** Prepare fixtures through the same controls used in the shipping sidebar. */
export async function applyAuditState(preview: SidebarPreview, params: URLSearchParams): Promise<void> {
  // 저장된 대화를 다시 열면 채팅이 그 대화의 모드와 권한으로 새로 시작된다. 장면은 그 뒤에 준비한다.
  await preview.threadStore.waitForThreadsPersistence();
  await preview.sidebar.startupChatSettled();
  await new Promise((resolve) => requestAnimationFrame(resolve));
  // 감사 장면은 저장된 대화를 이어받는다. 앞 장면이 남긴 대기 메시지는 삭제 단추로 걷고 시작한다.
  if (params.get('audit') === '1') {
    for (const remove of document.querySelectorAll<HTMLButtonElement>('.ag-followup-remove:not(:disabled)')) remove.click();
  }
  const mode = params.get('mode');
  const choosesMode = mode === 'chat' || mode === 'plan' || mode === 'agent' || mode === 'full';
  if (params.get('permission') === 'unrestricted' || choosesMode) {
    await until(composerReady, 'composer');
  }
  if (params.get('permission') === 'unrestricted') preview.bridge.setPermissionProfile('unrestricted');
  if (choosesMode) await chooseMode(mode);
  const browserbase = params.get('browserbase');
  if (browserbase === 'ready' || browserbase === 'setup' || browserbase === 'error')
    preview.setBrowserbaseState(browserbase === 'ready' ? 'connected' : browserbase);
  if (params.get('document') === 'empty') select('#document', 'empty');
  if (params.get('play') === '1') {
    await until(composerReady, 'composer');
    document.querySelector<HTMLButtonElement>('#play')!.click();
    await until(() => preview.snapshot().running, 'sample reply');
    if (params.get('hold') !== '1' && params.get('scenario') !== 'question') {
      await until(() => !preview.snapshot().running, 'completed reply');
    }
  }
  if (params.get('questionHeld') === '1') {
    // 사용자가 입력기에 쓰는 중에 질문이 도착한 장면 — 띠만 보이고 입력기는 그대로다.
    await until(() => preview.snapshot().running, 'running turn');
    const input = await until(() => document.querySelector<HTMLTextAreaElement>('.ag-input'), 'composer');
    input.focus();
    input.value = '2026년 3쪽 일정은';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    preview.typingHold?.start();
    preview.askQuestion();
    await until(() => document.querySelector('.ag-user-question[data-held="true"] .ag-question-arrival'), 'held question');
  }
  // 일하는 동안 입력기에 친 글을 Enter 로 대기열에 넣는다. queueHold=stopped 는 중지로 붙잡는다.
  const queued = Math.min(Number(params.get('queue') ?? 0) || 0, 10);
  if (queued > 0 && preview.snapshot().running) {
    const input = document.querySelector<HTMLTextAreaElement>('.ag-input')!;
    const samples = ['표를 정리해 줘', '맞춤법도 확인해 줘', '제목을 굵게 바꿔 줘'];
    for (let index = 0; index < queued; index += 1) {
      input.value = samples[index % samples.length]!;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    }
    await until(() => document.querySelectorAll('.ag-followup').length >= queued, 'queued messages');
    if (params.get('queueHold') === 'stopped') {
      await click('.ag-send.ag-stop');
      await until(() => document.querySelector('.ag-followups-hold:not([hidden])'), 'held queue');
    }
  }
  const surface = params.get('surface');
  const surfaces: Record<string, string> = {
    skills: '.ag-settings-nav-button[data-destination="skills"]', references: '.ag-references-btn', threads: '.ag-header .ag-threads-btn',
    'provider-picker': '[aria-label="프로바이더 선택"]', 'model-picker': '[aria-label="모델 선택"]',
    'effort-picker': '[aria-label="추론 강도 선택"]', 'mode-menu': '.ag-mode-btn',
    'provider-setup': `.ag-settings-provider-row[data-agent="${['claude', 'codex', 'pi'].includes(params.get('provider') ?? '') ? params.get('provider') : 'codex'}"] button`,
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
  if (surface === 'plan-actions') {
    const actions = await until(() => document.querySelector<HTMLElement>('.ag-plan-actions'), 'plan approval actions');
    actions.scrollIntoView({ block: 'end' });
  }
  if (surface === 'changes') {
    // 에이전트 모드의 검토 대기 편집을 승인해 적용된 변경으로 만든다.
    for (const set of [...preview.bridge.pendingEdits.getChangeSets()]) preview.bridge.pendingEdits.approve(set.id);
    await preview.enterFocusMode();
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
    // 연결 상태와 입력기 잠금은 400ms 를 넘긴 뒤에 보인다(다른 탭 사용은 바로).
    if (connection !== 'connected') {
      await until(() => {
        const dot = document.querySelector<HTMLElement>('.ag-conn-dot');
        return dot && !dot.hidden && document.querySelector('.ag-composer.ag-composer-locked');
      }, 'connection status');
    }
  }
  document.body.dataset.auditReady = 'true';
}
