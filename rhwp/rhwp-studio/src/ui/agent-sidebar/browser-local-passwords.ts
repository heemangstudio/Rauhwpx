/** 데스크톱 보관함은 메타데이터만 반환하며 비밀번호는 페이지에 직접 입력한다. */
export interface LocalPasswordAccount {
  id: string; origin: string; origins: string[]; username: string; label: string;
  source: 'chrome'; sourceProfile: string; profileId: 'native'; hasPassword: true;
  agentReuseApproved: boolean; sessionStatus: 'saved'; updatedAt: string;
}
export interface LocalPasswordsApi {
  listProfiles(): Promise<{ supported: boolean; profiles: { id: string; name: string }[] }>;
  importProfile(args: { profileId: string }): Promise<{ imported: number; skipped: number; unsupported: number }>;
  list(): Promise<{ accounts: LocalPasswordAccount[]; secureStorageAvailable: boolean }>;
  remove(args: { id: string }): Promise<{ removed: true }>;
  approve(args: { id: string; approved: boolean }): Promise<LocalPasswordAccount>;
  cookieSites(args: { profileId: string }): Promise<{ supported: boolean; sites: { domain: string; count: number }[] }>;
  importCookies(args: { profileId: string; domains: string[] }): Promise<{ imported: number; skipped: number; unsupported: number; domains: string[] }>;
  fill(args: { tabId: string; accountId: string }): Promise<{ completed: true; accountId: string }>;
}
export function localPasswordsApi(): LocalPasswordsApi | undefined {
  return (window as unknown as { rhwpDesktop?: { browser?: { passwords?: LocalPasswordsApi } } }).rhwpDesktop?.browser?.passwords;
}
