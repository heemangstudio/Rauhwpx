// 계정 상태 한 벌. rhwpDesktop.account 를 읽고 바뀔 때마다 알린다. 창마다 하나를 함께 쓴다(accountStore()).
// 계정 API 가 없으면(웹 Studio, 예전 데스크톱) 계정 화면을 두지 않고 다른 화면은 그대로다.
// 사진은 상태 방송에 실리지 않는다. avatarRev 가 바뀔 때만 getAvatar() 로 한 번 받아 둔다.
import type { AccountActivityKind, AccountStatus, DesktopAccountApi } from './account-types.ts';

export interface AccountStore {
  readonly api: DesktopAccountApi | null;
  /** 아직 모르거나 API 가 없으면 null. */
  status(): AccountStatus | null;
  /** 지금 계정 사진의 data URL. 사진이 없거나 아직 받지 못했으면 null. */
  avatar(): string | null;
  subscribe(listener: (status: AccountStatus | null) => void): () => void;
  dispose(): void;
}

export const OPEN_ACCOUNT_EVENT = 'rhwp:open-account';
export type AccountSection = 'sign-in' | 'plan' | 'devices' | 'licenses';
export const ACCOUNT_SECTIONS: readonly AccountSection[] = ['sign-in', 'plan', 'devices', 'licenses'];

/** 계정 페이지 모듈을 가져오지 않고 연다(설정·처음 설정·갱신 안내). 창이 listenForAccountPageEvents 로 듣는다. */
export function requestAccountPage(section?: AccountSection): void {
  window.dispatchEvent(new CustomEvent(OPEN_ACCOUNT_EVENT, { detail: section ? { section } : {} }));
}

let override: DesktopAccountApi | null | undefined;
let shared: AccountStore | null = null;

/** 데스크톱 앱의 계정 API. 웹·미리보기에는 없다(미리보기는 setAccountApi 로 끼운다). */
export function desktopAccountApi(host: { rhwpDesktop?: { account?: DesktopAccountApi } } = globalThis as never): DesktopAccountApi | null {
  if (override !== undefined) return override;
  return host?.rhwpDesktop?.account ?? null;
}

/** 미리보기·시험이 API 를 바꿔 끼운다. undefined 면 다시 rhwpDesktop 을 본다. 함께 쓰던 상태는 새로 만든다. */
export function setAccountApi(api: DesktopAccountApi | null | undefined): void {
  override = api;
  shared?.dispose();
  shared = null;
  recorded.agent_session.clear();
  recorded.document_edited.clear();
}

/** 창이 함께 쓰는 계정 상태. */
export function accountStore(): AccountStore {
  shared ??= createAccountStore(desktopAccountApi());
  return shared;
}

export function isSignedIn(status: AccountStatus | null): boolean {
  return status?.state === 'signed_in' && status.account !== null;
}

export function createAccountStore(api: DesktopAccountApi | null): AccountStore {
  let current: AccountStatus | null = null;
  let disposed = false;
  let avatarUrl: string | null = null;
  /** 받아 둔(또는 받는 중인) 사진의 계정·판. */
  let avatarKey: string | null = null;
  const listeners = new Set<(status: AccountStatus | null) => void>();
  const notify = (): void => {
    for (const listener of [...listeners]) listener(current);
  };

  function syncAvatar(): void {
    const account = current?.state === 'signed_in' ? current.account : null;
    const key = account && account.avatarRev !== null ? `${account.id}:${account.avatarRev}` : null;
    if (key === avatarKey) return;
    avatarKey = key;
    avatarUrl = null;
    if (!key || !api) return;
    void api.getAvatar().then((url) => {
      if (disposed || avatarKey !== key) return;
      avatarUrl = typeof url === 'string' && url.startsWith('data:image/') ? url : null;
      notify();
    }, () => { /* 사진이 없으면 머리글자를 보인다 */ });
  }

  const accept = (next: AccountStatus): void => {
    if (disposed || !next || typeof next.state !== 'string') return;
    current = next;
    syncAvatar();
    notify();
  };
  const unsubscribe = api?.onChange(accept) ?? (() => {});
  if (api) {
    void api.getStatus().then((status) => {
      // onChange 가 먼저 더 새 상태를 줬으면 덮지 않는다.
      if (current === null) accept(status);
    }, () => { /* 모르면 로그아웃처럼 보인다 */ });
  }
  return {
    api,
    status: () => current,
    avatar: () => avatarUrl,
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    dispose() {
      disposed = true;
      listeners.clear();
      unsubscribe();
    },
  };
}

/** 이 창에서 이미 알린 채팅·문서. main 도 걸러 내지만 같은 것을 거듭 보내지 않는다. */
const recorded: Record<AccountActivityKind, Set<string>> = { agent_session: new Set(), document_edited: new Set() };

/**
 * 채팅의 첫 메시지, 문서의 첫 편집을 계정 통계로 알린다. 로그인했을 때만 보내고, 보낸 것만 기억한다
 * (로그아웃 중의 활동은 버리고, 로그인한 뒤의 다음 활동은 센다).
 */
export function recordAccountActivity(kind: AccountActivityKind, id: string | null | undefined, store: AccountStore = accountStore()): void {
  if (!id || !store.api || !isSignedIn(store.status())) return;
  const seen = recorded[kind];
  if (seen.has(id)) return;
  seen.add(id);
  try {
    store.api.recordActivity(kind, id);
  } catch {
    seen.delete(id);
  }
}
