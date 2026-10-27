import type { BrowserEvent } from '../../agent/types.ts';
import { nativeBrowserApi } from './browser-presentation.ts';

/** Google Chrome에서 사이트 하나에 로그인하는 흐름. 패스키와 Google 로그인은 앱 브라우저 대신 Chrome에서 한다. */
export interface ChromeSignIn {
  /** 진행 중인 로그인의 사이트(등록 도메인). 없으면 null이다. */
  site(): string | null;
  /** macOS와 서명된 Google Chrome이 있는가. 확인 전에는 true로 보고 허브의 오류를 따른다. */
  available(): boolean;
  /** 쓸 수 없을 때 보여 줄 이유. */
  unavailableReason(): string;
  start(url: string): Promise<void>;
  finish(): Promise<void>;
  cancel(): Promise<void>;
  /** 진행 중인 로그인이 끝날 때(가져오기 성공·실패·취소) 풀린다. */
  settled(): Promise<void>;
  subscribe(listener: () => void): () => void;
  dispose(): void;
}

interface Bridge {
  requestBrowser<T = unknown>(action: string, args?: Record<string, unknown>): Promise<T>;
  onBrowserEvent(handler: (event: BrowserEvent) => void): () => void;
}

const UNAVAILABLE: Record<string, string> = {
  'macos-required': 'Chrome 로그인은 Mac에서 사용할 수 있습니다',
  'macos-13.5-required': 'macOS 13.5 이상이 필요합니다',
  'signed-chrome-required': 'Google Chrome 필요',
};

export function createChromeSignIn(bridge: Bridge, notify: (message: string) => void): ChromeSignIn {
  let current: string | null = null;
  let passkeys: { supported?: boolean; reason?: string } | null = null;
  const listeners = new Set<() => void>();
  let waiters: Array<() => void> = [];
  const changed = () => { for (const listener of listeners) listener(); };
  const settle = () => { const pending = waiters; waiters = []; for (const resolve of pending) resolve(); };
  const accept = (site: string | null) => {
    if (site === current) return;
    current = site;
    void nativeBrowserApi()?.chromeSignIn?.({ site }).catch(() => {});
    if (!site) settle();
    changed();
  };
  const readRuntime = (runtime: unknown) => {
    if (!runtime || typeof runtime !== 'object') return;
    const value = runtime as { passkeys?: { supported?: boolean; reason?: string }; signIn?: { site?: unknown } | null };
    if (value.passkeys) passkeys = value.passkeys;
    accept(typeof value.signIn?.site === 'string' ? value.signIn.site : null);
  };
  const failure = (error: unknown) => {
    const code = (error as { code?: string })?.code;
    if (code === 'BROWSER_MAC_PASSKEY_UNAVAILABLE') return 'Google Chrome을 찾지 못했습니다. Chrome을 설치한 뒤 다시 시도하세요.';
    if (code === 'BROWSER_SIGN_IN_ACTIVE') return '진행 중인 로그인을 먼저 마치세요.';
    if (code === 'BROWSER_SITE_SIGN_IN_EMPTY') return 'Chrome에 이 사이트의 로그인이 남지 않았습니다. Chrome에서 로그인한 뒤 완료를 누르세요.';
    return error instanceof Error && error.message ? `Chrome 로그인을 마치지 못했습니다: ${error.message}` : 'Chrome 로그인을 마치지 못했습니다.';
  };
  const unsubscribe = bridge.onBrowserEvent((event) => {
    const data = event.payload && typeof event.payload === 'object' ? { ...event, ...event.payload } as BrowserEvent : event;
    if (data.type === 'owned_browser_runtime') readRuntime(data.runtime);
    if (data.type === 'owned_browser_sign_in') {
      const site = typeof data.site === 'string' ? data.site : '사이트';
      notify(data.ok === true ? `${site}에 로그인했습니다` : failure({ code: data.code }));
    }
  });
  void bridge.requestBrowser<{ runtime?: unknown; readiness?: { passkeys?: { supported?: boolean; reason?: string } } }>('status')
    .then((status) => { if (status.readiness?.passkeys) passkeys = status.readiness.passkeys; readRuntime(status.runtime); changed(); })
    .catch(() => {});
  const run = async (action: string, args: Record<string, unknown> = {}) => {
    try { const result = await bridge.requestBrowser<{ runtime?: unknown }>(action, args); readRuntime(result.runtime); }
    catch (error) { notify(failure(error)); throw error; }
  };
  return {
    site: () => current,
    available: () => passkeys?.supported !== false,
    unavailableReason: () => UNAVAILABLE[passkeys?.reason ?? ''] ?? 'Google Chrome 필요',
    start: (url) => run('sign-in-site', { url }),
    finish: () => run('sign-in-site-finish'),
    cancel: () => run('sign-in-site-cancel'),
    settled: () => current ? new Promise((resolve) => { waiters.push(resolve); }) : Promise.resolve(),
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    dispose() { unsubscribe(); listeners.clear(); settle(); },
  };
}
