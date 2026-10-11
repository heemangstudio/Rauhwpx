import type { BrowserEvent, BrowserFrame, BrowserTab } from '../agent/types.ts';

/** 실제 브라우저 API 모양을 따르는 로컬 미리보기. 비밀번호는 보관하지 않는다. */
export function createPreviewBrowser(emit: (event: BrowserEvent) => void, getThread: () => string, getProject: () => string | null) {
  let tabs: BrowserTab[] = []; let frameSequence = 0; let generation = 1;
  const inputs: Array<Record<string, unknown>> = []; const captures: Array<Record<string, unknown>> = [];
  let accounts = [{ profileId: 'default', origins: ['https://accounts.google.com'], id: 'google', origin: 'https://accounts.google.com', label: 'Google 연구', hasPassword: true, agentReuseApproved: true, sessionStatus: 'authenticated' }];
  let resetCount = 0;
  let signInAccountId: string | null = null;
  const signIns: Array<{ accountId: string; url: string }> = [];
  const defaults = { browse: true, download: true, researchImport: true };
  let sites = [
    { id: 'google', origin: 'https://www.google.com', label: 'Google', source: 'default', allowedActions: ['browse', 'download'], blockedActions: [] as string[] },
    { id: 'wikipedia', origin: 'https://wikipedia.org', label: 'Wikipedia', source: 'default', allowedActions: ['browse', 'download'], blockedActions: [] as string[] },
    { id: 'pubmed', origin: 'https://pubmed.ncbi.nlm.nih.gov', label: 'PubMed', source: 'default', allowedActions: ['browse', 'download'], blockedActions: [] as string[] },
    { id: 'arxiv', origin: 'https://arxiv.org', label: 'arXiv', source: 'default', allowedActions: ['browse', 'download'], blockedActions: [] as string[] },
  ];
  const configuration: Record<string, unknown> = { profileId: 'shared', downloads: { maxFileBytes: 64 * 1024 * 1024, autoImport: true }, preview: { mode: 'docked', reducedMotion: false }, security: { privateNetworkAccess: false }, googleSignIn: { supported: null, status: 'not-verified' } };
  const runtime = () => ({ runtimeId: 'preview-owned-browser', generation, state: signInAccountId ? 'sign-in' : 'ready', kind: 'chromium', profile: 'shared', signIn: signInAccountId ? { mode: 'standalone-no-debug', accountId: signInAccountId } : null, readiness: { installed: true } });
  function frame(tab: BrowserTab): BrowserFrame {
    const canvas = document.createElement('canvas'); canvas.width = 1280; canvas.height = 800;
    const context = canvas.getContext('2d')!;
    context.fillStyle = '#fafaf7'; context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = '#161b19'; context.font = '600 42px sans-serif'; context.fillText('연구 자료', 90, 120);
    context.font = '24px sans-serif'; context.fillText(tab.url, 90, 176, 1080);
    context.fillStyle = '#e4ece7'; context.fillRect(90, 240, 1080, 320);
    context.fillStyle = '#243f32'; context.font = '32px sans-serif'; context.fillText('브라우저 협업 미리보기', 125, 306);
    context.font = '23px sans-serif'; context.fillText('페이지, 개체, 영역을 선택해 의견을 채팅에 첨부할 수 있습니다.', 125, 362);
    context.fillStyle = '#fff'; context.fillRect(125, 411, 620, 66);
    context.fillStyle = '#26352d'; context.fillText(String(inputs.filter((entry) => entry.tabId === tab.tabId && entry.type === 'text').map((entry) => entry.text).join('')) || '입력한 글이 여기에 표시됩니다', 145, 452);
    return { frameId: `preview-frame-${++frameSequence}`, tabId: tab.tabId, navigationEpoch: tab.navigationEpoch, controllerEpoch: tab.controllerEpoch,
      mimeType: 'image/jpeg', data: canvas.toDataURL('image/jpeg').split(',')[1], width: 1280, height: 800, deviceScaleFactor: 1, scrollX: 0, scrollY: 0 };
  }
  function changed(tab?: BrowserTab) { emit({ type: 'owned_browser_inventory', runtime: runtime(), tabs: structuredClone(tabs), ...(tab ? { tab: structuredClone(tab) } : {}) }); }
  async function request(action: string, args: Record<string, unknown> = {}, actor = { isHuman: true }): Promise<unknown> {
    if (action === 'reset-browser') {
      if (!actor.isHuman) throw Object.assign(new Error('사용자 설정에서 삭제하세요.'), { code: 'BROWSER_HUMAN_REQUIRED' });
      resetCount++; accounts = []; signInAccountId = null; tabs = []; generation++; inputs.length = 0; captures.length = 0; signIns.length = 0; changed();
      return { ok: true, action, runtime: runtime(), removed: ['accounts', 'browser-profile', 'auth-archive'] };
    }
    if (action === 'accounts.list') return { accounts: structuredClone(accounts), secureStorageAvailable: true };
    if (action === 'policy.list') return { defaults: { ...defaults }, sites: structuredClone(sites) };
    if (action === 'policy.update') {
      if (args.operation === 'set-default' && typeof args.key === 'string' && args.key in defaults) (defaults as Record<string, boolean>)[args.key] = args.enabled === true;
      if (args.operation === 'set-site') {
        const old = sites.find((row) => row.origin === args.origin);
        if (old) Object.assign(old, { allowedActions: args.allowedActions ?? old.allowedActions, blockedActions: args.blockedActions ?? old.blockedActions });
        else sites.push({ id: String(args.origin), origin: String(args.origin), label: String(args.origin), source: 'user', allowedActions: (args.allowedActions as string[]) ?? [], blockedActions: (args.blockedActions as string[]) ?? [] });
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
      if (action === 'accounts.approve' && args.account && typeof args.account === 'object') {
        const account = args.account as Record<string, unknown>; const row = { profileId: 'default', origins: (account.origins as string[]) ?? [String(account.origin)], id: crypto.randomUUID(), origin: String(account.origin), label: String(account.label), hasPassword: false, agentReuseApproved: true, sessionStatus: 'session-retained' }; accounts.push(row);
        return { account: structuredClone(row) };
      }
      const id = String(args.accountId ?? args.id ?? '');
      if (action === 'accounts.forget') accounts = accounts.filter((row) => row.id !== id);
      else for (const account of accounts) if (account.id === id) {
        if (action === 'accounts.approve') account.agentReuseApproved = true;
        if (action === 'accounts.revoke') account.agentReuseApproved = false;
        if (action === 'accounts.signout') account.sessionStatus = 'signed-out';
      }
      return { accounts: structuredClone(accounts), secureStorageAvailable: true };
    }
    if (action === 'status' || action === 'install') return { ok: true, runtime: runtime(), tabs: structuredClone(tabs) };
    if (action === 'list-downloads' || action === 'downloads') return { downloads: [] };
    if (action === 'sign-in') {
      const account = accounts.find(entry => entry.id === args.accountId);
      if (!account || account.profileId !== 'default' || !account.agentReuseApproved || !account.origins.includes(new URL(String(args.url)).origin)) throw Object.assign(new Error('등록된 계정을 선택하세요.'), { code: 'BROWSER_ACCOUNT_REGISTRATION_REQUIRED' });
      if (signInAccountId) throw Object.assign(new Error('로그인 확인을 마치세요.'), { code: 'BROWSER_SIGN_IN_ACTIVE' });
      signInAccountId = account.id; signIns.push({ accountId: account.id, url: String(args.url) });
      return { ok: true, runtime: runtime(), status: 'human-sign-in' };
    }
    if (action === 'confirm-sign-in') {
      const account = accounts.find(entry => entry.id === args.accountId);
      if (!account || !signIns.some(entry => entry.accountId === account.id)) throw new Error('먼저 해당 계정으로 로그인하세요.');
      if (signInAccountId && signInAccountId !== account.id) throw new Error('해당 로그인 계정을 선택하세요.');
      signInAccountId = null; account.sessionStatus = 'authenticated'; return { ok: true, account: structuredClone(account), runtime: runtime() };
    }
    if (action === 'open') {
      const tab: BrowserTab = { tabId: crypto.randomUUID(), threadId: getThread(), projectId: getProject(), documentId: null, agentId: 'preview-agent', url: String(args.url ?? 'https://www.google.com/'), title: '연구 자료', navigationEpoch: 1, controllerEpoch: 1, controller: { owner: 'agent' }, status: 'ready', canGoBack: false, canGoForward: false };
      tabs.push(tab); changed(tab); return { ok: true, tab: structuredClone(tab) };
    }
    const tab = tabs.find((row) => row.tabId === args.tabId);
    if (!tab) throw Object.assign(new Error('브라우저 탭을 찾을 수 없습니다.'), { code: 'BROWSER_TAB_NOT_FOUND' });
    if (args.navigationEpoch !== undefined && args.navigationEpoch !== tab.navigationEpoch) throw Object.assign(new Error('페이지가 바뀌었습니다. 다시 캡처해 주세요.'), { code: 'STALE_NAVIGATION' });
    if (action === 'close') { tabs = tabs.filter((row) => row !== tab); changed(); return { ok: true }; }
    if (action === 'control') { tab.controller.owner = args.owner === 'human' ? 'human' : 'agent'; tab.controllerEpoch++; changed(tab); }
    if (action === 'navigate') { if (args.url) tab.url = String(args.url); tab.navigationEpoch++; tab.canGoBack = true; changed(tab); }
    if (action === 'recover') { generation++; tab.status = 'ready'; changed(tab); }
    if (action === 'input') {
      if (tab.controller.owner !== 'human' || args.controllerEpoch !== tab.controllerEpoch) throw new Error('직접 조작 권한을 다시 선택해 주세요.');
      inputs.push({ ...args });
    }
    if (action === 'capture') {
      const captured = frame(tab); captures.push({ ...args });
      return { ok: true, tab: structuredClone(tab), capture: { captureId: crypto.randomUUID(), tabId: tab.tabId, threadId: args.destinationThreadId,
        mode: args.mode, comment: args.comment, rect: args.rect, element: args.mode === 'element' ? { role: 'heading', name: '연구 자료', text: '연구 자료' } : undefined,
        screenshot: { mimeType: captured.mimeType, data: captured.data, width: captured.width, height: captured.height } } };
    }
    if (action === 'snapshot') return { tab: structuredClone(tab), snapshot: { selectedText: '연구 자료' } };
    return { ok: true, tab: structuredClone(tab), frame: frame(tab) };
  }
  return { request,
    requestAsAgent: (action: string, args: Record<string, unknown> = {}) => request(action, args, { isHuman: false }),
    submit: async (args: Record<string, unknown>) => {
      const account = (args.account && typeof args.account === 'object' ? args.account : args) as Record<string, unknown>;
      const id = String(account.accountId ?? account.id ?? crypto.randomUUID());
      const row = { profileId: 'default', origins: (account.origins as string[]) ?? [String(account.origin)], id, origin: String(account.origin ?? ''), label: String(account.label ?? args.username ?? '새 계정'), hasPassword: Boolean(args.password), agentReuseApproved: args.remember !== false, sessionStatus: 'saved' };
      accounts = [...accounts.filter((entry) => entry.id !== id), row]; return { account: structuredClone(row), accounts: structuredClone(accounts) };
    },
    snapshot: () => ({ runtime: runtime(), tabs: structuredClone(tabs), inputs: structuredClone(inputs), captures: structuredClone(captures), accounts: structuredClone(accounts), defaults: { ...defaults }, sites: structuredClone(sites), resetCount, signIns: structuredClone(signIns), configuration: structuredClone(configuration) }),
  };
}
