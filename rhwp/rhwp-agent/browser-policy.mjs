import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const ACTIONS = new Set(['browse', 'read', 'download', 'research-import', 'website-change', 'account-use']);
const RESEARCH_ACTIONS = ['browse', 'read', 'download', 'research-import'];
export const DEFAULT_RESEARCH_SITES = Object.freeze([
  { origin: 'https://www.google.com', label: 'Google Search' },
  { origin: 'https://docs.google.com', label: 'Google Slides / Docs reading' },
  { origin: 'https://drive.google.com', label: 'Google Drive reading' },
  { origin: 'https://accounts.google.com', label: 'Google account sign-in' },
  { origin: 'https://www.wikipedia.org', label: 'Wikipedia' },
  { origin: 'https://en.wikipedia.org', label: 'Wikipedia English' },
  { origin: 'https://ko.wikipedia.org', label: 'Wikipedia Korean' },
  { origin: 'https://pubmed.ncbi.nlm.nih.gov', label: 'PubMed' },
  { origin: 'https://pmc.ncbi.nlm.nih.gov', label: 'PMC' },
  { origin: 'https://arxiv.org', label: 'arXiv' },
]);

export function browserOrigin(value) {
  let url;
  try { url = new URL(String(value)); } catch { throw failure('BROWSER_INVALID_ORIGIN', 'A valid website origin is required.'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
    throw failure('BROWSER_INVALID_ORIGIN', 'Only HTTP or HTTPS website origins are supported.');
  }
  return url.origin;
}

function failure(code, message) { return Object.assign(new Error(message), { code }); }
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function boundedText(value, limit = 200) { return String(value ?? '').trim().slice(0, limit); }
function actions(values = []) {
  if (!Array.isArray(values) || values.some((value) => !ACTIONS.has(value))) {
    throw failure('BROWSER_INVALID_POLICY', 'The website permission actions are invalid.');
  }
  return [...new Set(values)];
}
function origins(values) {
  if (!Array.isArray(values) || values.length === 0 || values.length > 32) {
    throw failure('BROWSER_INVALID_POLICY', 'At least one exact account origin is required.');
  }
  return [...new Set(values.map(browserOrigin))];
}
function requireHuman(actor) {
  if (!actor?.isHuman) throw failure('BROWSER_OWNER_REQUIRED', 'Browser permissions can only be changed by the owner.');
}

export async function writeBrowserJson(filePath, value, maxBytes = 1024 * 1024) {
  const bytes = Buffer.from(JSON.stringify(value));
  if (bytes.length > maxBytes) throw failure('BROWSER_STORAGE_LIMIT', 'Browser settings exceed their storage limit.');
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await fs.chmod(path.dirname(filePath), 0o700);
  const temp = `${filePath}.${crypto.randomUUID()}.tmp`;
  try {
    const file = await fs.open(temp, 'wx', 0o600);
    try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
    await fs.rename(temp, filePath);
    await fs.chmod(filePath, 0o600);
  } finally { await fs.rm(temp, { force: true }); }
}

export async function readBrowserJson(filePath, maxBytes = 1024 * 1024) {
  try {
    const stat = await fs.lstat(filePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) {
      throw failure('BROWSER_STORAGE_INVALID', 'Browser settings storage is invalid.');
    }
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    if (error instanceof SyntaxError) throw failure('BROWSER_STORAGE_INVALID', 'Browser settings cannot be read. Restore the saved data before continuing.');
    throw error;
  }
}

export function createBrowserPolicy({ dataDir, ownerId = 'local-owner', onChange = () => {} } = {}) {
  if (!dataDir) throw new TypeError('Browser policy dataDir is required.');
  const filePath = path.join(dataDir, 'browser-policy.json');
  let state;
  let initialized = false;
  let queue = Promise.resolve();
  const changeGuards = new Set();
  const readyPromise = (async () => {
    state = await readBrowserJson(filePath);
    if (state) {
      if (state.schema !== 1 || state.ownerId !== ownerId || !state.defaults || !Array.isArray(state.sites) || !Array.isArray(state.accounts)) {
        throw failure('BROWSER_POLICY_INVALID', 'Browser policy belongs to a different owner or cannot be read.');
      }
      if (Object.values(state.defaults).some((value) => typeof value !== 'boolean')) throw failure('BROWSER_POLICY_INVALID', 'Browser defaults cannot be read.');
      for (const site of state.sites) { site.origin = browserOrigin(site.origin); actions(site.allowedActions); actions(site.blockedActions); }
      for (const account of state.accounts) { account.origins = origins(account.origins); }
      initialized = true;
      return;
    }
    state = {
      schema: 1, ownerId, revision: 1, seeded: true,
      defaults: { browse: true, download: true, researchImport: true },
      sites: DEFAULT_RESEARCH_SITES.map((site) => ({ ...site, id: crypto.randomUUID(), source: 'research-default', allowedActions: [...RESEARCH_ACTIONS], blockedActions: [] })),
      accounts: [],
    };
    await writeBrowserJson(filePath, state);
    initialized = true;
  })();

  function effectiveResearch() {
    return { browse: initialized && state.defaults.browse === true, downloads: initialized && state.defaults.download === true, import: initialized && state.defaults.researchImport === true };
  }
  function categoryAvailability() {
    const defaults = effectiveResearch();
    if (!initialized) return defaults;
    const permitted = (requested) => state.sites.some((site) => site.source !== 'research-default' && requested.some((action) => site.allowedActions.includes(action) && !site.blockedActions.includes(action)));
    return { browse: defaults.browse || permitted(['browse', 'read']), downloads: defaults.downloads || permitted(['download']), import: defaults.import || permitted(['research-import']) };
  }

  async function list() { await readyPromise; return clone(state); }
  async function update(input = {}) {
    requireHuman(input.actor);
    const operation = async () => {
      await readyPromise;
      const next = clone(state);
      if (input.operation === 'set-default') {
        if (!['browse', 'download', 'researchImport'].includes(input.key) || typeof input.enabled !== 'boolean') throw failure('BROWSER_INVALID_POLICY', 'The research default is invalid.');
        next.defaults[input.key] = input.enabled;
      } else if (input.operation === 'set-site') {
        const origin = browserOrigin(input.origin);
        const previous = next.sites.find((site) => site.origin === origin);
        const allowedActions = actions(input.allowedActions ?? previous?.allowedActions ?? RESEARCH_ACTIONS);
        const blockedActions = actions(input.blockedActions ?? previous?.blockedActions ?? []);
        const site = { id: previous?.id ?? crypto.randomUUID(), origin, label: boundedText(input.label ?? previous?.label ?? origin), source: 'user', allowedActions, blockedActions };
        next.sites = next.sites.filter((entry) => entry.origin !== origin);
        next.sites.push(site);
      } else if (input.operation === 'remove-site') {
        const origin = browserOrigin(input.origin);
        next.sites = next.sites.filter((site) => site.origin !== origin);
      } else if (input.operation === 'approve-account' || input.operation === 'revoke-account') {
        if (typeof input.accountId !== 'string' || !input.accountId) throw failure('BROWSER_INVALID_POLICY', 'The account identity is missing.');
        const previous = next.accounts.find((account) => account.accountId === input.accountId);
        const account = {
          accountId: input.accountId,
          profileId: boundedText(input.profileId ?? previous?.profileId ?? 'default', 100),
          origins: origins(input.origins ?? previous?.origins),
          approved: input.operation === 'approve-account',
          version: (previous?.version ?? 0) + 1,
          updatedAt: new Date().toISOString(),
        };
        next.accounts = next.accounts.filter((entry) => entry.accountId !== input.accountId);
        next.accounts.push(account);
      } else if (input.operation === 'forget-account') {
        next.accounts = next.accounts.filter((entry) => entry.accountId !== input.accountId);
      } else throw failure('BROWSER_INVALID_POLICY', 'The browser policy operation is unknown.');
      next.revision += 1;
      for (const guard of changeGuards) await guard({ operation: input.operation, accountId: input.accountId, origin: input.origin, key: input.key, enabled: input.enabled });
      await writeBrowserJson(filePath, next);
      state = next;
      try { onChange({ type: 'browser-policy-changed', revision: state.revision }); } catch {}
      return list();
    };
    const task = queue.then(operation, operation);
    queue = task.catch(() => {});
    return task;
  }

  async function check({ actor, action, url, accountId, profileId } = {}) {
    await readyPromise;
    if (!ACTIONS.has(action)) return { allowed: false, code: 'BROWSER_ACTION_UNKNOWN', reason: 'The browser action is unknown.' };
    const origin = url ? browserOrigin(url) : null;
    if (actor?.isHuman) return { allowed: true, origin, source: 'owner', revision: state.revision };
    const site = state.sites.find((entry) => entry.origin === origin);
    if (site?.blockedActions.includes(action)) return { allowed: false, origin, code: 'BROWSER_SITE_BLOCKED', reason: 'This website action has been revoked.', revision: state.revision };
    if (action === 'account-use' || accountId) {
      const account = state.accounts.find((entry) => entry.accountId === accountId);
      if (!account?.approved || !origin || !account.origins.includes(origin) || (profileId && account.profileId !== profileId)) {
        return { allowed: false, origin, code: 'BROWSER_ACCOUNT_APPROVAL_REQUIRED', reason: 'Approve this website account before agent access.', revision: state.revision };
      }
      if (action === 'account-use') return { allowed: true, origin, source: 'remembered-account', accountVersion: account.version, revision: state.revision };
    }
    const enabled = action === 'browse' || action === 'read' ? state.defaults.browse
      : action === 'download' ? state.defaults.download
        : action === 'research-import' ? state.defaults.researchImport : false;
    if (site?.allowedActions.includes(action) && (site.source !== 'research-default' || enabled)) return { allowed: true, origin, source: site.source, revision: state.revision };
    return enabled ? { allowed: true, origin, source: 'research-default', revision: state.revision }
      : { allowed: false, origin, code: 'BROWSER_PERMISSION_REQUIRED', reason: 'This browser action requires owner approval.', revision: state.revision };
  }

  async function assertAllowed(input) {
    const result = await check(input);
    if (!result.allowed) throw failure(result.code, result.reason);
    return result;
  }

  return { ready: () => readyPromise, list, update, check, assertAllowed, effectiveResearch, categoryAvailability,
    addChangeGuard: (guard) => { changeGuards.add(guard); return () => changeGuards.delete(guard); },
  };
}
