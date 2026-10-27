/**
 * 설정 → AI → 연결의 ChatGPT·Claude 줄. 켜면 에이전트가 ask_chatgpt·ask_claude 로 사용자의 웹 계정(메모리·채팅 기록)에 물을 수 있다.
 * 로그인은 앱 안 브라우저의 별도 창으로 연다. 에이전트가 물을 때는 허브가 보이지 않는 탭으로 한다.
 */
import type { BrowserSettingsRequest } from './browser-settings.ts';

export type WebAssistant = 'chatgpt' | 'claude';

export interface WebAssistantSpec {
  name: string;
  signInUrl: string;
  /** 사람 확인(Cloudflare)을 풀 때 여는 첫 화면 */
  homeUrl: string;
  note: string;
}

export const WEB_ASSISTANTS: Readonly<Record<WebAssistant, WebAssistantSpec>> = {
  chatgpt: { name: 'ChatGPT', signInUrl: 'https://chatgpt.com/auth/login', homeUrl: 'https://chatgpt.com/', note: '내 ChatGPT 계정과 메모리를 사용합니다' },
  claude: { name: 'Claude', signInUrl: 'https://claude.ai/login', homeUrl: 'https://claude.ai/', note: '내 Claude 계정과 메모리를 사용합니다' },
};

/** 로그인 창. closed 는 사용자가 닫거나 close() 로 닫으면 끝난다. */
export interface SignInWindow {
  closed: Promise<void>;
  close(): Promise<void>;
}

export interface WebAssistantStatus {
  enabled: boolean;
  available: boolean;
  signedIn: boolean | null;
  account?: string;
}

export function readWebAssistantStatus(value: unknown): WebAssistantStatus | null {
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : null;
  if (!raw || typeof raw.enabled !== 'boolean' || typeof raw.available !== 'boolean') return null;
  return {
    enabled: raw.enabled,
    available: raw.available,
    signedIn: typeof raw.signedIn === 'boolean' ? raw.signedIn : null,
    ...(typeof raw.account === 'string' && raw.account.length <= 320 ? { account: raw.account } : {}),
  };
}

const errorKind = (code: string | null | undefined): 'challenge' | 'signed-out' | null =>
  code === 'CHATGPT_CHALLENGE' || code === 'CLAUDE_CHALLENGE' ? 'challenge'
    : code === 'CHATGPT_SIGNED_OUT' || code === 'CLAUDE_SIGNED_OUT' ? 'signed-out' : null;

/** 줄의 상태 문구와 점 색. */
export function webAssistantStatusView(service: WebAssistant, status: WebAssistantStatus | null, options: { checking?: boolean; error?: string | null; signingIn?: boolean } = {}): { text: string; tone: 'ok' | 'warn' | 'off' } {
  const name = WEB_ASSISTANTS[service].name;
  if (!status) return { text: options.error ? '허브에 연결할 수 없음' : '확인 중…', tone: 'off' };
  if (!status.available) return { text: '데스크톱 앱에서만 사용 가능', tone: 'off' };
  if (!status.enabled) return { text: '꺼짐', tone: 'off' };
  if (options.signingIn && status.signedIn !== true) return { text: '로그인 창에서 로그인하세요', tone: 'warn' };
  const kind = errorKind(options.error);
  if (kind === 'challenge') return { text: `${name} 확인 필요`, tone: 'warn' };
  if (kind === 'signed-out') return { text: '로그인 필요', tone: 'warn' };
  if (options.error && !options.checking) return { text: '확인하지 못함', tone: 'warn' };
  if (options.checking || status.signedIn === null) return { text: '확인 중…', tone: 'off' };
  if (!status.signedIn) return { text: '로그인 필요', tone: 'warn' };
  return { text: status.account ? `연결됨 · ${status.account}` : '연결됨', tone: 'ok' };
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** 로그인 창이 열린 동안 로그인을 확인하는 간격. */
const SIGN_IN_POLL_MS = 3_000;

export function createWebAssistantSettingsRow(service: WebAssistant, options: {
  request: BrowserSettingsRequest;
  /** 앱 안 브라우저의 별도 창으로 주소를 연다. 없으면 로그인 단추를 숨긴다. */
  openSignInWindow?: (url: string, title: string) => Promise<SignInWindow>;
  isConnected: () => boolean;
  pollMs?: number;
}): { root: HTMLElement; refresh(check?: boolean): Promise<void> } {
  const spec = WEB_ASSISTANTS[service];
  const root = el('div', 'ag-settings-row ag-settings-assistant-row');
  root.dataset.service = service;
  const text = el('div', 'ag-settings-row-text');
  const name = el('span', 'ag-settings-row-name', spec.name);
  const detail = el('span', 'ag-settings-row-detail', '확인 중…');
  const note = el('span', 'ag-settings-row-detail ag-settings-assistant-note', spec.note);
  text.append(name, detail, note);
  const dot = el('span', 'ag-settings-dot');
  dot.setAttribute('aria-hidden', 'true');
  const signIn = el('button', 'ag-settings-btn', '로그인');
  signIn.type = 'button';
  signIn.hidden = true;
  const toggle = document.createElement('input');
  toggle.type = 'checkbox';
  toggle.className = 'ag-settings-toggle-input';
  toggle.setAttribute('role', 'switch');
  toggle.setAttribute('aria-label', `${spec.name} 사용`);
  const track = el('span', 'ag-settings-toggle-track');
  track.setAttribute('aria-hidden', 'true');
  const switchLabel = el('label', 'ag-settings-assistant-switch');
  switchLabel.append(toggle, track);
  root.append(text, dot, signIn, switchLabel);

  let status: WebAssistantStatus | null = null;
  let checking = false;
  let error: string | null = null;
  let sequence = 0;
  let signInWindow: SignInWindow | null = null;

  const render = () => {
    const view = webAssistantStatusView(service, status, { checking, error, signingIn: !!signInWindow });
    detail.textContent = view.text;
    dot.dataset.state = view.tone === 'ok' ? 'connected' : view.tone === 'warn' ? 'connecting' : 'off';
    toggle.checked = status?.enabled === true;
    toggle.disabled = !options.isConnected() || !status?.available;
    signIn.hidden = !options.openSignInWindow || !status?.enabled || !status.available || status.signedIn === true || (checking && !signInWindow);
    signIn.disabled = !!signInWindow;
    signIn.textContent = errorKind(error) === 'challenge' ? '확인 열기' : '로그인';
  };

  const refresh = async (check = true): Promise<void> => {
    const current = ++sequence;
    if (!options.isConnected()) { status = null; error = 'offline'; render(); return; }
    checking = check && status?.enabled === true && status.available;
    render();
    try {
      // 먼저 켜짐·사용 가능만 받고, 켜져 있으면 앱 안 브라우저(보이지 않는 탭)로 로그인을 확인한다.
      const base = readWebAssistantStatus(await options.request(`${service}.status`, {}));
      if (current !== sequence) return;
      status = base; error = null;
      checking = check && base?.enabled === true && base.available;
      render();
      if (!checking) return;
      const checked = readWebAssistantStatus(await options.request(`${service}.status`, { check: true }));
      if (current !== sequence) return;
      status = checked ?? status;
    } catch (failure) {
      if (current !== sequence) return;
      error = (failure as { code?: string })?.code ?? 'failed';
    } finally {
      if (current === sequence) { checking = false; render(); }
    }
  };

  /** 로그인 창이 열린 동안 로그인됐는지 보고, 되면 창을 닫는다. */
  const watchSignIn = async (window: SignInWindow): Promise<void> => {
    let open = true;
    void window.closed.then(() => { open = false; });
    while (open) {
      await Promise.race([window.closed, new Promise((resolve) => setTimeout(resolve, options.pollMs ?? SIGN_IN_POLL_MS))]);
      if (!open) break;
      await refresh(true);
      if (status?.signedIn === true) { await window.close(); break; }
    }
  };

  toggle.addEventListener('change', () => {
    const enabled = toggle.checked;
    toggle.disabled = true;
    void options.request(`${service}.configure`, { enabled })
      .then((value) => { status = readWebAssistantStatus(value) ?? status; error = null; })
      .catch((failure) => { error = (failure as { code?: string })?.code ?? 'failed'; })
      .finally(() => { render(); if (status?.enabled) void refresh(true); });
  });
  signIn.addEventListener('click', () => {
    if (!options.openSignInWindow || signInWindow) return;
    const url = errorKind(error) === 'challenge' ? spec.homeUrl : spec.signInUrl;
    void options.openSignInWindow(url, spec.name).then(async (window) => {
      signInWindow = window; error = null; render();
      await watchSignIn(window);
      await window.closed;
      signInWindow = null;
      await refresh(true);
    }).catch((failure) => {
      signInWindow = null;
      error = (failure as { code?: string })?.code ?? 'failed';
      render();
    });
  });
  render();
  return { root, refresh };
}
