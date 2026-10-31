// HamaEditor 계정. 데스크톱 main(desktop/account-manager.mjs)이 가지고 rhwpDesktop.account 로 알린다.
// 이 꼴은 계약(§5)과 같다. 오류 글(message)은 main 이 한국어로 만들어 보내고, Studio 는 그대로 보인다.

export type AccountProvider = 'email' | 'google';
/** 로그인 판에서 고른 길. 서버에서는 같은 로그인이고, 가입은 AuthKit 이메일 화면만 바꾼다. */
export type AccountSignInIntent = 'sign_in' | 'sign_up';
export type AccountState = 'signed_out' | 'signing_in' | 'choose_device' | 'signed_in';

export interface AccountDevice {
  id: string;
  name: string;
  platform: string;
  appVersion: string | null;
  addedAt: number;
  lastSeenAt: number;
  current: boolean;
}

export interface AccountLicense {
  keyId: string;
  maskedKey: string;
  tier: 'paid' | 'beta';
  edition: 'pro' | 'hama' | 'signature' | null;
  plan: 'monthly' | 'annual' | 'lifetime' | null;
  status: 'active' | 'past_due' | 'expired' | 'revoked';
  expiresAt: number | null;
  autoRenew: boolean | null;
  primary: boolean;
}

export interface AccountPlan {
  tier: 'free' | 'pro' | 'legacy' | 'hama';
  edition: 'pro' | 'hama' | 'signature' | null;
  plan: 'monthly' | 'annual' | 'lifetime' | null;
  expiresAt: number | null;
  autoRenew: boolean | null;
  paymentFailed: boolean;
  paymentGraceEndsAt: number | null;
  manageUrl: string | null;
}

export interface AccountStats {
  agentSessions: number;
  documentsEdited: number;
  since: number | null;
  hama: { usedUsd: number; allowanceUsd: number; periodEndsAt: number; calls: number } | null;
}

export interface AccountProfile {
  id: string;
  email: string;
  name: string;
  avatarRev: number | null;
  provider: AccountProvider | null;
  createdAt: number;
}

export interface AccountStatus {
  /** false: 서버가 accounts_not_configured 라고 했다. 로그인 단추를 숨기고 고장처럼 보이지 않게 한다. */
  available: boolean;
  state: AccountState;
  /** 서버가 답하기 전에는 ['email','google']. */
  providers: AccountProvider[];
  /** signing_in·choose_device 동안. */
  signIn: { provider: AccountProvider; startedAt: number; intent?: AccountSignInIntent } | null;
  /** 마지막으로 실패한 로그인이나 동작. 다음 성공에 지워진다. */
  lastError: { code: string; message: string } | null;
  /** choose_device 에서만. */
  deviceChoice: { limit: number; devices: AccountDevice[] } | null;
  account: AccountProfile | null;
  /** 로그아웃 상태면 tier 'free'. */
  plan: AccountPlan;
  licenses: AccountLicense[];
  devices: AccountDevice[];
  deviceLimit: number;
  stats: AccountStats | null;
  /** error: 'session_unreadable'(저장된 세션을 못 읽음), 'bad_lease'(서버 lease 검증 실패), 아니면 null. */
  sync: { lastSyncAt: number | null; offline: boolean; error: string | null };
  localKey: { maskedKey: string; state: 'pending' | 'linked' | 'linked_elsewhere' | 'invalid' } | null;
}

export type AccountResult =
  | { ok: true; status: AccountStatus }
  | { ok: false; code: string; message: string; status: AccountStatus };

/** redeem·claim 은 성공할 때 이미 이 계정에 있던 키인지도 알린다. */
export type AccountLinkResult =
  | { ok: true; alreadyLinked: boolean; status: AccountStatus }
  | { ok: false; code: string; message: string; status: AccountStatus };

export type AccountAvatarType = 'image/jpeg' | 'image/png' | 'image/webp';
export type AccountActivityKind = 'agent_session' | 'document_edited';

export interface DesktopAccountApi {
  getStatus(): Promise<AccountStatus>;
  onChange(callback: (status: AccountStatus) => void): () => void;
  /** 브라우저를 연 뒤에 끝난다. */
  /** intent 'sign_up' 이면 가입 화면으로 연다(AuthKit 이메일). 같은 계정이면 그대로 로그인된다. */
  signIn(provider: AccountProvider, loginHint?: string, intent?: AccountSignInIntent): Promise<AccountResult>;
  cancelSignIn(): Promise<AccountStatus>;
  /** choose_device 에서. */
  replaceDevice(deviceId: string): Promise<AccountResult>;
  refresh(): Promise<AccountResult>;
  signOut(): Promise<AccountResult>;
  removeDevice(deviceId: string): Promise<AccountResult>;
  updateName(name: string): Promise<AccountResult>;
  setAvatar(bytes: Uint8Array, type: AccountAvatarType): Promise<AccountResult>;
  removeAvatar(): Promise<AccountResult>;
  /** 저장해 둔 사진의 data URL. */
  getAvatar(): Promise<string | null>;
  redeem(key: string): Promise<AccountLinkResult>;
  claim(orderId: string, email: string): Promise<AccountLinkResult>;
  /** code 'subscription_active' 면 글과 함께 openManage 를 권한다. */
  deleteAccount(confirm: string): Promise<AccountResult>;
  /** Groble 구매자 페이지를 브라우저로 연다. */
  openManage(): Promise<void>;
  /** 보내고 잊는다(ipcRenderer.send). */
  recordActivity(kind: AccountActivityKind, id: string): void;
}
