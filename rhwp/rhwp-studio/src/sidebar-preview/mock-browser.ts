import type { BrowserEvent, BrowserFrame, BrowserTab } from '../agent/types.ts';

/** 실제 브라우저 API 모양을 따르는 로컬 미리보기. 비밀번호는 보관하지 않는다. */
export function createPreviewBrowser(emit: (event: BrowserEvent) => void, getThread: () => string, getProject: () => string | null) {
  let tabs: BrowserTab[] = []; let frameSequence = 0; let generation = 1;
  const inputs: Array<Record<string, unknown>> = []; const captures: Array<Record<string, unknown>> = [];
  type PreviewAccount = { profileId: string; origins: string[]; id: string; origin: string; label: string; stableIdentity?: string; hasPassword: boolean; agentBlocked: boolean; sessionStatus: string };
  const browserParams = new URLSearchParams(location.search);
  /** `browserAccounts=empty|many`: 계정 없이, 또는 상태가 고루 섞인 계정으로 시작한다. `secureStorage=0`: 보안 저장소 없음. */
  const accountFixture = browserParams.get('browserAccounts');
  const secureStorageAvailable = browserParams.get('secureStorage') !== '0';
  const google: PreviewAccount = { profileId: 'default', origins: ['https://accounts.google.com'], id: 'google', origin: 'https://accounts.google.com', label: 'Google 연구', hasPassword: true, agentBlocked: false, sessionStatus: 'authenticated' };
  let accounts: PreviewAccount[] = accountFixture === 'empty' ? [] : accountFixture === 'many' ? [
    google,
    { profileId: 'default', origins: ['https://github.com'], id: 'github', origin: 'https://github.com', label: 'GitHub', stableIdentity: 'hama-lab', hasPassword: true, agentBlocked: false, sessionStatus: 'saved' },
    { profileId: 'default', origins: ['https://nid.naver.com', 'https://www.naver.com'], id: 'naver', origin: 'https://nid.naver.com', label: '네이버', stableIdentity: 'hama_editor', hasPassword: true, agentBlocked: true, sessionStatus: 'signed-out' },
    { profileId: 'default', origins: ['https://www.data.go.kr'], id: 'data-go', origin: 'https://www.data.go.kr', label: '공공데이터포털', stableIdentity: 'research-team', hasPassword: true, agentBlocked: false, sessionStatus: 'saved' },
  ] : [google];
  let resetCount = 0;
  let signInAccountId: string | null = null;
  const signIns: Array<{ accountId: string; url: string }> = [];
  const defaults = { browse: true, download: true, researchImport: true };
  type PreviewSite = { id: string; origin: string; domain?: string; label: string; source: string; allowedActions: string[]; blockedActions: string[] };
  const SITE_ACCESS = ['browse', 'read', 'website-change', 'account-use'];
  let sites: PreviewSite[] = [
    { id: 'google', origin: 'https://www.google.com', label: 'Google', source: 'default', allowedActions: ['browse', 'download'], blockedActions: [] },
    { id: 'wikipedia', origin: 'https://wikipedia.org', label: 'Wikipedia', source: 'default', allowedActions: ['browse', 'download'], blockedActions: [] },
    { id: 'pubmed', origin: 'https://pubmed.ncbi.nlm.nih.gov', label: 'PubMed', source: 'default', allowedActions: ['browse', 'download'], blockedActions: [] },
    { id: 'arxiv', origin: 'https://arxiv.org', label: 'arXiv', source: 'default', allowedActions: ['browse', 'download'], blockedActions: [] },
    ...accountFixture === 'empty' ? [] : [
      { id: 'coupang', origin: 'https://coupang.com', domain: 'coupang.com', label: 'coupang.com', source: 'user', allowedActions: [...SITE_ACCESS], blockedActions: [] },
      { id: 'naver', origin: 'https://naver.com', domain: 'naver.com', label: 'naver.com', source: 'user', allowedActions: [], blockedActions: ['download', 'research-import'] },
    ],
  ];
  /** 등록 도메인 흉내: 끝의 두 이름(국가 도메인의 .co.kr·.go.kr 류는 셋). 미리보기 사이트에만 맞으면 된다. */
  const siteKey = (origin: string) => {
    const host = (() => { try { return new URL(origin).hostname; } catch { return origin.replace(/^\./, ''); } })();
    const parts = host.split('.');
    const keep = parts.length > 2 && /^(co|go|or|ac|ne)$/.test(parts.at(-2)!) ? 3 : 2;
    return `https://${parts.slice(-keep).join('.')}`;
  };
  /** 지금 채팅의 사이트 사용(채팅마다)과 사용자가 로그인한 사이트. */
  const chatSites = new Map<string, Set<string>>();
  const signedIn = new Set<string>(accountFixture === 'empty' ? [] : ['https://coupang.com', 'https://google.com']);
  const userSite = (key: string) => {
    let site = sites.find((row) => row.origin === key);
    if (!site) { site = { id: key, origin: key, domain: new URL(key).hostname, label: new URL(key).hostname, source: 'user', allowedActions: [], blockedActions: [] }; sites.push(site); }
    return site;
  };
  /** 허브의 sites.approve: 이 채팅 또는 항상 사이트 사용을 주고, 차단을 푸는 카드면 그 차단을 먼저 푼다. */
  function grantSite(origin: string, scope: 'chat' | 'always', unblock: string[] = []) {
    const key = siteKey(origin);
    if (unblock.length) { const site = userSite(key); site.blockedActions = site.blockedActions.filter((action) => !unblock.includes(action)); }
    if (scope === 'always') { const site = userSite(key); site.source = 'user'; site.allowedActions = [...new Set([...site.allowedActions, ...SITE_ACCESS])]; }
    else { const granted = chatSites.get(getThread()) ?? new Set<string>(); granted.add(key); chatSites.set(getThread(), granted); }
  }
  const siteStatus = () => {
    const keys = new Set([...sites.map((site) => site.origin), ...signedIn, ...chatSites.get(getThread()) ?? []]);
    return [...keys].map((key) => {
      const site = sites.find((row) => row.origin === key);
      return { key, domain: new URL(key).hostname, always: Boolean(site && site.source === 'user' && site.allowedActions.includes('website-change')),
        chat: chatSites.get(getThread())?.has(key) === true, signedIn: signedIn.has(key), blocked: site?.blockedActions.length ? [{ origin: key, actions: [...site.blockedActions] }] : [] };
    });
  };
  const configuration: Record<string, unknown> = { profileId: 'shared', downloads: { maxFileBytes: 64 * 1024 * 1024, autoImport: true }, preview: { mode: 'docked', reducedMotion: false }, security: { privateNetworkAccess: false }, googleSignIn: { supported: null, status: 'not-verified' } };
  let faviconRequests = 0;
  const icons = new Map<string, string | null>();
  /** 미리보기 사이트의 아이콘 — 허브가 보내는 것과 같은 작은 data: PNG. 모르는 사이트는 null. */
  function favicon(origin: string): string | null {
    if (icons.has(origin)) return icons.get(origin)!;
    const host = (() => { try { return new URL(origin).hostname; } catch { return ''; } })();
    const marks: Record<string, [string, string, string]> = {
      'accounts.example.com': ['#2f6fdf', '#fff', 'E'], 'accounts.google.com': ['#fff', '#4285f4', 'G'], 'www.google.com': ['#fff', '#4285f4', 'G'],
      'www.notion.so': ['#fff', '#111', 'N'], 'api.notion.com': ['#fff', '#111', 'N'], 'www.data.go.kr': ['#0b5fa5', '#fff', '공'],
      'apis.data.go.kr': ['#0b5fa5', '#fff', '공'], 'kosis.kr': ['#e5463b', '#fff', 'K'], 'github.com': ['#24292f', '#fff', 'G'], 'nid.naver.com': ['#03c75a', '#fff', 'N'], 'www.naver.com': ['#03c75a', '#fff', 'N'], 'naver.com': ['#03c75a', '#fff', 'N'], 'google.com': ['#fff', '#4285f4', 'G'], 'notion.so': ['#fff', '#111', 'N'], 'data.go.kr': ['#0b5fa5', '#fff', '공'], 'wikipedia.org': ['#fff', '#222', 'W'], 'arxiv.org': ['#b31b1b', '#fff', 'a'],
    };
    const mark = marks[host];
    let icon: string | null = null;
    if (mark) {
      const canvas = document.createElement('canvas'); canvas.width = 32; canvas.height = 32;
      const context = canvas.getContext('2d')!;
      context.fillStyle = mark[0]; context.beginPath(); context.roundRect(0, 0, 32, 32, 7); context.fill();
      context.fillStyle = mark[1]; context.font = '700 20px -apple-system, sans-serif'; context.textAlign = 'center'; context.textBaseline = 'middle';
      context.fillText(mark[2], 16, 17);
      icon = canvas.toDataURL('image/png');
    }
    icons.set(origin, icon);
    return icon;
  }
  const originOf = (url: string) => { try { return new URL(url).origin; } catch { return ''; } };
  const runtime = () => ({ runtimeId: 'preview-owned-browser', generation, state: signInAccountId ? 'sign-in' : 'ready', kind: 'chromium', profile: 'shared', signIn: signInAccountId ? { mode: 'standalone-no-debug', accountId: signInAccountId } : null, readiness: { installed: true } });
  function frame(tab: BrowserTab): BrowserFrame {
    const canvas = document.createElement('canvas'); canvas.width = 1280; canvas.height = 800;
    const context = canvas.getContext('2d')!;
    if (tab.url.startsWith('https://accounts.example.com/')) {
      // 로그인·인증 코드 넘김 미리보기 — 입력란 하나와 버튼이 있는 확인 페이지.
      const typed = inputs.filter((entry) => entry.tabId === tab.tabId && entry.type === 'text').map((entry) => entry.text).join('');
      context.fillStyle = '#f6f7f9'; context.fillRect(0, 0, canvas.width, canvas.height);
      context.fillStyle = '#fff'; context.fillRect(90, 70, 760, 560);
      context.fillStyle = '#2f6fdf'; context.fillRect(130, 120, 56, 56);
      context.fillStyle = '#171b22'; context.font = '600 44px sans-serif'; context.fillText('인증 코드 입력', 130, 250);
      context.fillStyle = '#6b7280'; context.font = '26px sans-serif'; context.fillText('휴대폰으로 받은 6자리 코드를 입력하세요.', 130, 300);
      context.strokeStyle = typed ? '#171b22' : '#c9ced6'; context.lineWidth = 3; context.strokeRect(130, 350, 420, 76);
      context.fillStyle = '#171b22'; context.font = '34px monospace'; context.fillText(typed.split('').join(' '), 154, 400);
      context.fillStyle = '#2f6fdf'; context.fillRect(130, 470, 200, 70);
      context.fillStyle = '#fff'; context.font = '600 28px sans-serif'; context.fillText('확인', 200, 515);
      return { frameId: `preview-frame-${++frameSequence}`, tabId: tab.tabId, navigationEpoch: tab.navigationEpoch, controllerEpoch: tab.controllerEpoch,
        mimeType: 'image/jpeg', data: canvas.toDataURL('image/jpeg').split(',')[1]!, width: 1280, height: 800, deviceScaleFactor: 1, scrollX: 0, scrollY: 0 };
    }
    context.fillStyle = '#fafaf7'; context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = '#161b19'; context.font = '600 42px sans-serif'; context.fillText('연구 자료', 90, 120);
    context.font = '24px sans-serif'; context.fillText(tab.url, 90, 176, 1080);
    context.fillStyle = '#e4ece7'; context.fillRect(90, 240, 1080, 320);
    context.fillStyle = '#243f32'; context.font = '32px sans-serif'; context.fillText('브라우저 협업 미리보기', 125, 306);
    context.font = '23px sans-serif'; context.fillText('현재 화면을 캡처해 채팅에 첨부할 수 있습니다.', 125, 362);
    context.fillStyle = '#fff'; context.fillRect(125, 411, 620, 66);
    context.fillStyle = '#26352d'; context.fillText(String(inputs.filter((entry) => entry.tabId === tab.tabId && entry.type === 'text').map((entry) => entry.text).join('')) || '입력한 글이 여기에 표시됩니다', 145, 452);
    return { frameId: `preview-frame-${++frameSequence}`, tabId: tab.tabId, navigationEpoch: tab.navigationEpoch, controllerEpoch: tab.controllerEpoch,
      mimeType: 'image/jpeg', data: canvas.toDataURL('image/jpeg').split(',')[1], width: 1280, height: 800, deviceScaleFactor: 1, scrollX: 0, scrollY: 0 };
  }
  function changed(tab?: BrowserTab) { emit({ type: 'owned_browser_inventory', runtime: runtime(), tabs: structuredClone(tabs), ...(tab ? { tab: structuredClone(tab) } : {}) }); }
  async function request(action: string, args: Record<string, unknown> = {}, actor = { isHuman: true }): Promise<unknown> {
    if (action === 'reset-browser') {
      if (!actor.isHuman) throw Object.assign(new Error('사용자 설정에서 삭제하세요.'), { code: 'BROWSER_HUMAN_REQUIRED' });
      resetCount++; accounts = []; signedIn.clear(); signInAccountId = null; tabs = []; generation++; inputs.length = 0; captures.length = 0; signIns.length = 0; changed();
      return { ok: true, action, runtime: runtime(), removed: ['accounts', 'browser-profile', 'auth-archive'] };
    }
    if (action === 'favicons.get') {
      if (!actor.isHuman) throw Object.assign(new Error('사용자 화면만 아이콘을 읽습니다.'), { code: 'BROWSER_HUMAN_REQUIRED' });
      faviconRequests++;
      const origins = Array.isArray(args.origins) ? (args.origins as unknown[]).filter((value): value is string => typeof value === 'string').slice(0, 50) : [];
      return { icons: Object.fromEntries(origins.map((origin) => [origin, favicon(origin)])) };
    }
    if (action === 'accounts.list') return { accounts: structuredClone(accounts), secureStorageAvailable };
    if (action === 'policy.list') return { defaults: { ...defaults }, sites: structuredClone(sites), siteStatus: siteStatus() };
    if (action === 'sites.allow') { grantSite(String(args.origin), 'always'); return { sites: structuredClone(sites), siteStatus: siteStatus() }; }
    if (action === 'sites.revoke') {
      const key = siteKey(String(args.origin)); const site = sites.find((row) => row.origin === key);
      if (site) site.allowedActions = site.allowedActions.filter((value) => !SITE_ACCESS.includes(value));
      sites = sites.filter((row) => row.source !== 'user' || row.allowedActions.length || row.blockedActions.length);
      chatSites.get(getThread())?.delete(key);
      return { sites: structuredClone(sites), siteStatus: siteStatus() };
    }
    if (action === 'sites.clearSignedIn') { signedIn.delete(siteKey(String(args.origin))); return { siteStatus: siteStatus() }; }
    if (action === 'policy.update') {
      if (args.operation === 'set-default' && typeof args.key === 'string' && args.key in defaults) (defaults as Record<string, boolean>)[args.key] = args.enabled === true;
      if (args.operation === 'set-site') {
        const old = sites.find((row) => row.origin === args.origin);
        if (old) Object.assign(old, { allowedActions: args.allowedActions ?? old.allowedActions, blockedActions: args.blockedActions ?? old.blockedActions });
        else sites.push({ id: String(args.origin), origin: String(args.origin), label: new URL(String(args.origin)).hostname, source: 'user', allowedActions: (args.allowedActions as string[]) ?? [], blockedActions: (args.blockedActions as string[]) ?? [] });
      }
      if (args.defaults && typeof args.defaults === 'object') Object.assign(defaults, args.defaults);
      if (args.site && typeof args.site === 'object') { const site = args.site as typeof sites[number]; sites = [...sites.filter((row) => row.id !== site.id && row.origin !== site.origin), site]; }
      if (args.sites && Array.isArray(args.sites)) sites = structuredClone(args.sites);
      return { defaults: { ...defaults }, sites: structuredClone(sites) };
    }
    if (action === 'configuration.get') return structuredClone(configuration);
    if (action === 'configuration.update') { Object.assign(configuration, structuredClone(args)); return structuredClone(configuration); }
    if (action === 'accounts.request') return { requestId: crypto.randomUUID() };
    if (action.startsWith('accounts.')) {
      const id = String(args.accountId ?? args.id ?? '');
      if (action === 'accounts.forget') accounts = accounts.filter((row) => row.id !== id);
      else for (const account of accounts) if (account.id === id) {
        if (action === 'accounts.block') account.agentBlocked = args.blocked === true;
        if (action === 'accounts.signout') { account.sessionStatus = 'signed-out'; signedIn.delete(siteKey(account.origin)); }
      }
      return { accounts: structuredClone(accounts), secureStorageAvailable };
    }
    if (action === 'sessions.imported') return { ok: true };
    if (action === 'status' || action === 'install') return { ok: true, runtime: runtime(), tabs: structuredClone(tabs) };
    if (action === 'list-downloads' || action === 'downloads') return { downloads: [] };
    if (action === 'sign-in') {
      const account = accounts.find(entry => entry.id === args.accountId);
      if (!account || account.profileId !== 'default' || !account.origins.includes(new URL(String(args.url)).origin)) throw Object.assign(new Error('등록된 계정을 선택하세요.'), { code: 'BROWSER_ACCOUNT_REGISTRATION_REQUIRED' });
      if (signInAccountId) throw Object.assign(new Error('로그인 확인을 마치세요.'), { code: 'BROWSER_SIGN_IN_ACTIVE' });
      signInAccountId = account.id; signIns.push({ accountId: account.id, url: String(args.url) });
      return { ok: true, runtime: runtime(), status: 'human-sign-in' };
    }
    if (action === 'confirm-sign-in') {
      const account = accounts.find(entry => entry.id === args.accountId);
      if (!account || !signIns.some(entry => entry.accountId === account.id)) throw new Error('먼저 해당 계정으로 로그인하세요.');
      if (signInAccountId && signInAccountId !== account.id) throw new Error('해당 로그인 계정을 선택하세요.');
      signInAccountId = null; account.sessionStatus = 'authenticated'; signedIn.add(siteKey(account.origin)); return { ok: true, account: structuredClone(account), runtime: runtime() };
    }
    if (action === 'open') {
      const url = String(args.url ?? 'https://www.google.com/'); const icon = favicon(originOf(url));
      const tab: BrowserTab = { tabId: crypto.randomUUID(), threadId: getThread(), projectId: getProject(), documentId: null, agentId: 'preview-agent', url, title: url.startsWith('https://accounts.example.com/') ? 'Example 인증' : '연구 자료', navigationEpoch: 1, controllerEpoch: 1, controller: { owner: 'agent' }, status: 'ready', canGoBack: false, canGoForward: false, ...(icon ? { faviconUrl: icon } : {}) };
      tabs.push(tab); changed(tab); return { ok: true, tab: structuredClone(tab) };
    }
    const tab = tabs.find((row) => row.tabId === args.tabId);
    if (!tab) throw Object.assign(new Error('브라우저 탭을 찾을 수 없습니다.'), { code: 'BROWSER_TAB_NOT_FOUND' });
    if (args.navigationEpoch !== undefined && args.navigationEpoch !== tab.navigationEpoch) throw Object.assign(new Error('페이지가 바뀌었습니다. 다시 캡처해 주세요.'), { code: 'STALE_NAVIGATION' });
    if (action === 'close') { tabs = tabs.filter((row) => row !== tab); changed(); return { ok: true }; }
    if (action === 'control') { tab.controller = { owner: tab.controller.owner, ...(args.owner === 'agent' ? {} : { held: true }) }; tab.controllerEpoch++; changed(tab); }
    if (action === 'navigate') { if (args.url) tab.url = String(args.url); const icon = favicon(originOf(tab.url)); if (icon) tab.faviconUrl = icon; else delete tab.faviconUrl; tab.navigationEpoch++; tab.canGoBack = true; changed(tab); }
    if (action === 'recover') { generation++; tab.status = 'ready'; changed(tab); }
    if (action === 'input') {
      if (args.controllerEpoch !== tab.controllerEpoch) throw new Error('페이지 상태를 다시 읽어 주세요.');
      inputs.push({ ...args });
    }
    if (action === 'capture') {
      const captured = frame(tab); captures.push({ ...args });
      return { ok: true, tab: structuredClone(tab), capture: { captureId: crypto.randomUUID(), tabId: tab.tabId, threadId: args.destinationThreadId,
        mode: args.mode, comment: args.comment,
        screenshot: { mimeType: captured.mimeType, data: captured.data, width: captured.width, height: captured.height } } };
    }
    if (action === 'snapshot') return { tab: structuredClone(tab), snapshot: { selectedText: '연구 자료' } };
    return { ok: true, tab: structuredClone(tab), frame: frame(tab) };
  }
  return { request, grantSite,
    requestAsAgent: (action: string, args: Record<string, unknown> = {}) => request(action, args, { isHuman: false }),
    submit: async (args: Record<string, unknown>) => {
      const account = (args.account && typeof args.account === 'object' ? args.account : args) as Record<string, unknown>;
      const id = String(account.accountId ?? account.id ?? crypto.randomUUID());
      const row: PreviewAccount = { profileId: 'default', origins: (account.origins as string[]) ?? [String(account.origin)], id, origin: String(account.origin ?? ''), label: String(account.label ?? args.username ?? '새 계정'), hasPassword: Boolean(args.password), agentBlocked: false, sessionStatus: 'saved' };
      accounts = [...accounts.filter((entry) => entry.id !== id), row];
      // 허브처럼 채팅 카드에서 저장하면 고른 범위로 그 사이트 사용도 허용한다.
      if (args.scope === 'chat' || args.scope === 'always') grantSite(row.origin, args.scope);
      return { account: structuredClone(row), accounts: structuredClone(accounts) };
    },
    snapshot: () => ({ faviconRequests, runtime: runtime(), tabs: structuredClone(tabs), inputs: structuredClone(inputs), captures: structuredClone(captures), accounts: structuredClone(accounts), defaults: { ...defaults }, sites: structuredClone(sites), siteStatus: siteStatus(), resetCount, signIns: structuredClone(signIns), configuration: structuredClone(configuration) }),
  };
}
