/** 데스크톱 보관함은 메타데이터만 반환하며 비밀번호는 페이지에 직접 입력한다. */
export interface LocalPasswordAccount {
  id: string; origin: string; origins: string[]; username: string; label: string;
  source: string; sourceProfile?: string; profileId: 'native'; hasPassword: true;
  /** 사이트 키(등록 도메인 출처, 예: https://coupang.com). 이 로그인은 그 사이트(하위 도메인 포함)에서만 입력된다. */
  site?: string;
  /** 사용자가 에이전트 사용을 껐다. 켜 두면 에이전트가 사이트 사용을 받은 곳에서 쓸 수 있다. */
  agentBlocked: boolean;
  sessionStatus: 'saved'; updatedAt: string;
}
export interface LocalPasswordsApi {
  listProfiles(): Promise<{ supported: boolean; profiles: { id: string; name: string }[] }>;
  importProfile(args: { profileId: string }): Promise<{ imported: number; skipped: number; unsupported: number }>;
  list(): Promise<{ accounts: LocalPasswordAccount[]; secureStorageAvailable: boolean }>;
  remove(args: { id: string }): Promise<{ removed: true }>;
  block(args: { id: string; blocked: boolean }): Promise<LocalPasswordAccount>;
  cookieSites(args: { profileId: string }): Promise<{ supported: boolean; sites: { domain: string; count: number }[] }>;
  importCookies(args: { profileId: string; domains: string[] }): Promise<{ imported: number; skipped: number; unsupported: number; domains: string[] }>;
  fill(args: { tabId: string; accountId: string }): Promise<{ completed: true; accountId: string }>;
}
let provided: LocalPasswordsApi | undefined;
/** 사이드바 미리보기의 대역 보관함. 데스크톱 앱은 preload 가 연 API 를 쓴다. */
export function provideLocalPasswordsApi(api: LocalPasswordsApi | undefined): void { provided = api; }
export function localPasswordsApi(): LocalPasswordsApi | undefined {
  return provided ?? (window as unknown as { rhwpDesktop?: { browser?: { passwords?: LocalPasswordsApi } } }).rhwpDesktop?.browser?.passwords;
}
