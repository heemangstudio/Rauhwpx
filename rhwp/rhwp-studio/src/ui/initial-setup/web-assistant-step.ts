/**
 * 처음 설정의 웹 ChatGPT·Claude 장: 프로바이더 연결 뒤, Hama·Rau 요금제에서 데스크톱 앱 안 브라우저가 있을 때만 뜬다.
 *
 * 카드를 누르면 켜고, 로그인돼 있지 않으면 앱 안 브라우저의 로그인 창을 연다. 로그인되면 보이지 않는 탭으로
 * 짧은 질문을 실제로 하나 보내 답을 받아야 "작동 확인됨"이 된다(로그인만으로는 입력창·답 읽기가 되는지 모른다).
 * 확인 질문은 HamaEditor 프로젝트의 같은 채팅 하나를 이어 쓴다. 설명은 하마가 한다.
 */
import { createIcon } from '../agent-sidebar/icons.ts';
import { createProviderIcon } from '../agent-sidebar/providers.ts';
import type { BrowserSettingsRequest } from '../agent-sidebar/browser-settings.ts';
import {
  readWebAssistantStatus,
  watchSignInWindow,
  WEB_ASSISTANTS,
  webAssistantErrorKind,
  type SignInWindow,
  type WebAssistant,
} from '../agent-sidebar/web-assistant-settings.ts';
import { HIPPO_LINES } from './steps.ts';

/** idle: 아직 안 함. signed-out·challenge·failed 는 다시 누를 수 있다. */
export type AssistantCardState = 'idle' | 'checking' | 'signing-in' | 'verifying' | 'verified' | 'signed-out' | 'challenge' | 'failed';

export interface WebAssistantStepDeps {
  request: BrowserSettingsRequest;
  /** 앱 안 브라우저의 별도 창으로 주소를 연다. 없으면 로그인이 필요할 때 실패로 보인다. */
  openSignInWindow?: (url: string) => Promise<SignInWindow>;
  say(line: string): void;
  cheer(line: string): void;
  onStateChange(): void;
  pollMs?: number;
}

export interface WebAssistantStepUi {
  element: HTMLElement;
  /** 작동을 확인한 웹 비서. 다음 단추의 글을 정한다. */
  verified(): WebAssistant[];
  busy(): boolean;
  dispose(): void;
}

const SERVICES: readonly WebAssistant[] = ['chatgpt', 'claude'];
/** 카드 로고 — 같은 회사의 프로바이더 마크를 쓴다. */
const LOGO = { chatgpt: 'codex', claude: 'claude' } as const;

/** 앱 안 브라우저가 있어 이 장을 넣을지. 허브가 모르는 동작이거나 끊겼거나 늦으면 넣지 않는다. */
export async function webAssistantsAvailable(request: BrowserSettingsRequest, timeoutMs = 3_000): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const status = await Promise.race([
      request('chatgpt.status', {}),
      new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); }),
    ]);
    return readWebAssistantStatus(status)?.available === true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export function assistantCardDetail(state: AssistantCardState, account: string | null): string {
  switch (state) {
    case 'idle': return '눌러서 연결';
    case 'checking': return '확인 중…';
    case 'signing-in': return '로그인 창에서 로그인하세요';
    case 'verifying': return '질문을 보내 확인하는 중…';
    case 'verified': return account ? `작동 확인됨 · ${account}` : '작동 확인됨';
    case 'signed-out': return '로그인 필요 · 다시 누르기';
    case 'challenge': return '사람 확인 필요 · 눌러서 열기';
    case 'failed': return '확인하지 못함 · 다시 시도';
  }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const codeOf = (failure: unknown): string => (failure as { code?: string })?.code ?? 'failed';

export function createWebAssistantStep(deps: WebAssistantStepDeps): WebAssistantStepUi {
  let disposed = false;
  const panel = el('div', 'rhwp-setup-panel rhwp-setup-assistants');
  panel.dataset.step = 'assistants';
  const grid = el('div', 'rhwp-setup-grid rhwp-setup-assistant-grid');
  grid.setAttribute('role', 'list');
  panel.append(grid, el('p', 'rhwp-setup-hint', '확인 질문은 HamaEditor 프로젝트의 채팅 하나에 남아요.'));

  const cards = new Map<WebAssistant, {
    root: HTMLElement; action: HTMLButtonElement; detail: HTMLElement; answer: HTMLElement;
    state: AssistantCardState; account: string | null; window: SignInWindow | null;
  }>();

  for (const service of SERVICES) {
    const spec = WEB_ASSISTANTS[service];
    const root = el('div', 'rhwp-setup-card rhwp-setup-assistant');
    root.setAttribute('role', 'listitem');
    root.dataset.service = service;
    const action = el('button', 'rhwp-setup-card-action');
    action.type = 'button';
    const logo = el('span', 'rhwp-setup-card-logo');
    logo.append(createProviderIcon(LOGO[service]));
    const detail = el('span', 'rhwp-setup-assistant-detail');
    detail.setAttribute('aria-live', 'polite');
    const answer = el('span', 'rhwp-setup-assistant-answer');
    answer.hidden = true;
    const check = el('span', 'rhwp-setup-check');
    check.append(createIcon('check'));
    action.append(logo, el('span', 'rhwp-setup-card-name', spec.name), detail, answer, check);
    root.append(action);
    grid.append(root);
    const card = { root, action, detail, answer, state: 'idle' as AssistantCardState, account: null as string | null, window: null as SignInWindow | null };
    cards.set(service, card);
    action.addEventListener('click', () => { void connect(service); });
  }

  function render(service: WebAssistant, notify = true): void {
    const card = cards.get(service)!;
    card.root.dataset.state = card.state;
    card.root.dataset.configured = card.state === 'verified' ? 'true' : 'false';
    card.action.setAttribute('aria-busy', isBusy(card.state) ? 'true' : 'false');
    card.action.setAttribute('aria-label', `${WEB_ASSISTANTS[service].name} ${assistantCardDetail(card.state, card.account)}`);
    card.detail.textContent = assistantCardDetail(card.state, card.account);
    card.answer.hidden = card.state !== 'verified' || !card.answer.textContent;
    if (notify) deps.onStateChange();
  }

  function set(service: WebAssistant, state: AssistantCardState, account?: string | null): void {
    if (disposed) return;
    const card = cards.get(service)!;
    card.state = state;
    if (account !== undefined) card.account = account;
    render(service);
  }

  const isBusy = (state: AssistantCardState) => state === 'checking' || state === 'signing-in' || state === 'verifying';

  function fail(service: WebAssistant, failure: unknown): void {
    const kind = webAssistantErrorKind(codeOf(failure));
    set(service, kind ?? 'failed');
    deps.say(kind === 'signed-out' ? HIPPO_LINES.assistantSignedOut : HIPPO_LINES.assistantFailed);
  }

  async function checkSignedIn(service: WebAssistant): Promise<{ signedIn: boolean; account: string | null }> {
    const status = readWebAssistantStatus(await deps.request(`${service}.status`, { check: true }));
    return { signedIn: status?.signedIn === true, account: status?.account ?? null };
  }

  /** 로그인 창(사람 확인이면 첫 화면)을 열고 로그인될 때까지 본다. 창을 닫았는데 안 됐으면 false. */
  async function signIn(service: WebAssistant, challenge: boolean): Promise<{ signedIn: boolean; account: string | null }> {
    const spec = WEB_ASSISTANTS[service];
    if (!deps.openSignInWindow) throw Object.assign(new Error('desktop only'), { code: 'failed' });
    const card = cards.get(service)!;
    const window = await deps.openSignInWindow(challenge ? spec.homeUrl : spec.signInUrl);
    card.window = window;
    set(service, 'signing-in');
    deps.say(HIPPO_LINES.assistantSignIn);
    let last = { signedIn: false, account: null as string | null };
    try {
      await watchSignInWindow(window, async () => {
        last = await checkSignedIn(service).catch(() => last);
        return last.signedIn;
      }, deps.pollMs);
      await window.closed;
    } finally {
      card.window = null;
    }
    // 창을 그냥 닫았어도 그 사이 로그인했을 수 있다.
    return last.signedIn ? last : checkSignedIn(service);
  }

  async function connect(service: WebAssistant): Promise<void> {
    const card = cards.get(service)!;
    if (disposed || isBusy(card.state) || card.state === 'verified') return;
    const challenge = card.state === 'challenge';
    set(service, 'checking');
    try {
      await deps.request(`${service}.configure`, { enabled: true });
      let session = challenge ? { signedIn: false, account: null } : await checkSignedIn(service);
      if (!session.signedIn) session = await signIn(service, challenge);
      if (disposed) return;
      if (!session.signedIn) { set(service, 'signed-out'); deps.say(HIPPO_LINES.assistantSignedOut); return; }
      set(service, 'verifying', session.account);
      deps.say(HIPPO_LINES.assistantVerifying);
      const result = await deps.request(`${service}.verify`, {}) as { verified?: unknown; answer?: unknown } | null;
      if (result?.verified !== true) throw Object.assign(new Error('not verified'), { code: 'failed' });
      card.answer.textContent = typeof result.answer === 'string' ? `“${result.answer}”` : '';
      set(service, 'verified');
      deps.cheer(HIPPO_LINES.assistantVerified);
    } catch (failure) {
      if (!disposed) fail(service, failure);
    }
  }

  for (const service of SERVICES) render(service, false);

  return {
    element: panel,
    verified: () => SERVICES.filter((service) => cards.get(service)!.state === 'verified'),
    busy: () => SERVICES.some((service) => isBusy(cards.get(service)!.state)),
    dispose() {
      disposed = true;
      for (const card of cards.values()) void card.window?.close();
    },
  };
}
