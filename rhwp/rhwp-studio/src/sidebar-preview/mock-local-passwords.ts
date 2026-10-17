import type { LocalPasswordAccount, LocalPasswordsApi } from '../ui/agent-sidebar/browser-local-passwords.ts';

export type PreviewVaultMode = 'ready' | 'empty' | 'unsupported' | 'fail';

/**
 * 데스크톱 보관함(`rhwpDesktop.browser.passwords`)의 미리보기 대역. 비밀번호는 다루지 않고
 * 메타데이터와 호출 기록만 둔다. `vault=1|empty|unsupported|fail` 로 고른다.
 */
export function createPreviewLocalPasswords(mode: PreviewVaultMode, delayMs = 350) {
  const wait = () => new Promise((resolve) => setTimeout(resolve, delayMs));
  const profiles = mode === 'ready' || mode === 'fail' ? [{ id: 'Default', name: '개인' }, { id: 'Profile 1', name: '연구실' }] : [];
  const sample = (id: string, origin: string, label: string, username: string, sourceProfile: string, approved: boolean): LocalPasswordAccount => ({
    id, origin, origins: [origin], username, label, source: 'chrome', sourceProfile, profileId: 'native', hasPassword: true,
    agentReuseApproved: approved, sessionStatus: 'saved', updatedAt: '2026-10-12T08:00:00Z',
  });
  let accounts: LocalPasswordAccount[] = mode === 'ready'
    ? [sample('local-scholar', 'https://www.notion.so', 'Notion', 'lab@example.org', '개인', true), sample('local-kosis', 'https://kosis.kr', 'KOSIS', 'researcher01', '연구실', false)]
    : [];
  const cookieSites: Record<string, { domain: string; count: number }[]> = {
    Default: [{ domain: '.google.com', count: 24 }, { domain: '.notion.so', count: 8 }, { domain: '.github.com', count: 12 }, { domain: 'kosis.kr', count: 3 }],
    'Profile 1': [{ domain: '.naver.com', count: 15 }, { domain: 'www.data.go.kr', count: 5 }],
  };
  let failures = mode === 'fail' ? 1 : 0;
  const calls = { imports: [] as string[], cookieImports: [] as Array<{ profileId: string; domains: string[] }>, approvals: [] as Array<{ id: string; approved: boolean }>, removals: [] as string[] };
  const fail = () => { if (failures > 0) { failures--; throw new Error('키체인 접근이 거부됐습니다.'); } };
  const api: LocalPasswordsApi = {
    listProfiles: async () => ({ supported: mode !== 'unsupported', profiles: structuredClone(profiles) }),
    list: async () => ({ accounts: structuredClone(accounts), secureStorageAvailable: true }),
    importProfile: async ({ profileId }) => {
      await wait(); fail(); calls.imports.push(profileId);
      const name = profiles.find((profile) => profile.id === profileId)?.name ?? profileId;
      const added = sample(`local-github-${profileId}`, 'https://github.com', 'GitHub', 'hama-lab', name, false);
      accounts = [...accounts.filter((account) => account.id !== added.id), added];
      return { imported: 1, skipped: 2, unsupported: profileId === 'Default' ? 0 : 1 };
    },
    remove: async ({ id }) => { await wait(); calls.removals.push(id); accounts = accounts.filter((account) => account.id !== id); return { removed: true }; },
    approve: async ({ id, approved }) => {
      await wait(); calls.approvals.push({ id, approved });
      const account = accounts.find((entry) => entry.id === id);
      if (!account) throw new Error('없는 계정입니다.');
      account.agentReuseApproved = approved; return structuredClone(account);
    },
    cookieSites: async ({ profileId }) => { await wait(); fail(); return { supported: true, sites: structuredClone(cookieSites[profileId] ?? []) }; },
    importCookies: async ({ profileId, domains }) => {
      await wait(); calls.cookieImports.push({ profileId, domains: [...domains] });
      return { imported: domains.length * 3, skipped: 0, unsupported: 0, domains: [...domains] };
    },
    fill: async ({ accountId }) => ({ completed: true, accountId }),
  };
  return { api, snapshot: () => ({ mode, accounts: structuredClone(accounts), ...structuredClone(calls) }) };
}
