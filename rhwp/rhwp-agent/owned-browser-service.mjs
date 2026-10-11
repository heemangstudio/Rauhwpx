import crypto from 'node:crypto';
import path from 'node:path';
import { isIP } from 'node:net';
import { promises as fs } from 'node:fs';
import { createBrowserNetworkGuard } from './owned-browser-network.mjs';
import { OwnedBrowserError, inspectOwnedBrowserRuntime, installOwnedBrowserRuntime, startOwnedBrowserRuntime, startOwnedBrowserSignIn } from './owned-browser-runtime.mjs';
import { removeOwnedBrowserState } from './browser-cleanup.mjs';

export { OwnedBrowserError } from './owned-browser-runtime.mjs';

const ELEMENTS = 'a[href],button,input,textarea,select,[role="button"],[role="link"],[role="textbox"],[role="menuitem"],[role="option"],[role="tab"],[contenteditable="true"],summary';
const SENSITIVE = 'input[type="password"],input[type="email"],input[autocomplete="username"],input[name="username"],input[name="email"],input[autocomplete="current-password"],input[autocomplete="new-password"],input[autocomplete="one-time-code"],input[autocomplete^="cc-"],[data-rhwp-private-field]';
const MUTATIONS = new Set(['navigate', 'click', 'type', 'press', 'scroll', 'close', 'input', 'fill-account', 'viewport', 'upload']);
const READS = new Set(['snapshot', 'frame', 'capture', 'wait']);
const id = (prefix) => `${prefix}_${crypto.randomUUID()}`;
const error = (code, message, retryable = false) => new OwnedBrowserError(code, message, retryable);
const bounded = (value, min, max, fallback) => Number.isFinite(Number(value)) ? Math.max(min, Math.min(max, Number(value))) : fallback;
const text = (value, max = 4000) => String(value ?? '').slice(0, max);
const publicURL = (value) => { try { const url = new URL(value); if (!['http:', 'https:'].includes(url.protocol)) return 'about:blank'; return `${url.origin}${url.pathname}`; } catch { return 'about:blank'; } };
const sameScope = (actor, tab) => actor.threadId === tab.threadId && actor.agentId === tab.agentId && (actor.projectId ?? null) === tab.projectId;
const PARAMETER_RULES = { verbs: ['delete', 'remove', 'destroy', 'send', 'publish', 'purchase', 'checkout', 'share', 'save', 'edit', 'upload', 'invite', 'logout'], operations: ['action', 'command', 'operation', 'method'], negative: ['0', 'false', 'no', 'none', 'off'] };
const mutatingParameter = (name, value) => { const key = name.toLowerCase(), setting = String(value).trim().toLowerCase(); return PARAMETER_RULES.verbs.includes(key) && !PARAMETER_RULES.negative.includes(setting) || PARAMETER_RULES.operations.includes(key) && PARAMETER_RULES.verbs.includes(setting); };
const changesWebsiteURL = (value) => {
  try { const url = new URL(value); return /\/(delete|remove|destroy|send|purchase|checkout|logout)(\/|$)/i.test(url.pathname) || [...url.searchParams].some(([name, setting]) => mutatingParameter(name, setting)); }
  catch { return false; }
};

/** The native endpoint and IPC correlation IDs never enter browser tools or UI events. */
export function createIpcNativeBrowserAdapter({ send = process.send?.bind(process), events = process, timeoutMs = 20_000 } = {}) {
  const pending = new Map();
  const receive = (message) => {
    if (message?.type !== 'rhwp-browser-response') return;
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id); clearTimeout(waiter.timer);
    message.ok ? waiter.resolve(message.value) : waiter.reject(error(message.error?.code ?? 'BROWSER_NATIVE_FAILED', message.error?.message ?? 'The desktop browser request failed.', true));
  };
  events.on('message', receive);
  const call = (operation, params = {}) => new Promise((resolve, reject) => {
    if (!send) { reject(error('BROWSER_NATIVE_UNAVAILABLE', 'The desktop browser is not connected.', true)); return; }
    const requestId = id('native');
    const timer = setTimeout(() => { pending.delete(requestId); reject(error('BROWSER_NATIVE_TIMEOUT', 'The desktop browser did not respond. Reconnect before retrying.', true)); }, timeoutMs);
    pending.set(requestId, { resolve, reject, timer });
    try { send({ type: 'rhwp-browser-request', id: requestId, operation, params }); }
    catch { clearTimeout(timer); pending.delete(requestId); reject(error('BROWSER_NATIVE_UNAVAILABLE', 'The desktop browser disconnected.', true)); }
  });
  return {
    async start(params) { return { ...(await call('start', params)), close: () => call('release') }; },
    bind: (params) => call('bind', params), control: (params) => call('control', params), reset: () => call('reset'),
    async dispose() { events.off('message', receive); for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(error('BROWSER_CLOSED', 'The browser service closed.')); } pending.clear(); },
  };
}

/** One owner for shared authentication, with independently scoped agent tabs and control queues. */
export function createOwnedBrowserService(options = {}) {
  const { dataDir, credentialBroker, policy, downloads, onEvent = () => {}, nativeAdapter, runtimeFactory = startOwnedBrowserRuntime } = options;
  if (!dataDir) throw new TypeError('Owned browser dataDir is required');
  const guard = createBrowserNetworkGuard({ workspaceTargets: options.workspaceTargets ?? policy?.workspaceTargets ?? [], lookup: options.lookup });
  const tabs = new Map();
  const pageTabs = new WeakMap();
  const runtimeId = id('runtime');
  const descriptorFile = path.join(dataDir, 'browser', 'tabs.json');
  let generation = 0;
  let runtime;
  let starting;
  let state = 'idle';
  let closed = false;
  let resetting = false;
  let resetFailed = false;
  let persistQueue = Promise.resolve();
  let installPromise;
  let runtimeMode = options.runtimeMode === 'native' ? 'native' : 'managed';
  let headless = options.headless !== false;
  let checkpointTimer;
  let checkpointQueue = Promise.resolve();
  let signIn;
  let signInAccountId;
  let handoffPending = false;
  let handoffPromise;
  let handoffProfile = false;
  const sessionKey = crypto.randomBytes(32);
  let sessionBaseline = new Map();
  let cookieBaseline = new Map();
  let sessionQueue = Promise.resolve();
  let humanSessionEpoch = 0;
  let humanActionsPending = 0;
  const humanRequestsPending = new Set();
  const humanOrigins = new Set();
  const unconfirmedHumanOrigins = new Set();
  const profileId = () => runtimeMode === 'native' ? 'native' : 'default';
  const selectedAdapter = () => runtimeMode === 'native' ? nativeAdapter : undefined;
  const limits = { maxTabs: options.maxTabs ?? 12, maxTabsPerAgent: options.maxTabsPerAgent ?? 3, maxSnapshotElements: options.maxSnapshotElements ?? 400, maxDownloadBytes: options.maxDownloadBytes ?? 100 * 1024 * 1024, maxFrameBytes: options.maxFrameBytes ?? 5 * 1024 * 1024 };

  const emit = (type, payload) => { try { onEvent({ type, ...payload }); } catch {} };
  const runtimeInfo = () => ({ runtimeId, generation, state: resetting ? 'resetting' : resetFailed ? 'reset-failed' : handoffPending ? 'sign-in-starting' : state, kind: runtime?.kind ?? (runtimeMode === 'native' ? 'native' : 'chromium'), mode: runtimeMode, headless, profile: 'shared', profileId: profileId(), security: 'restricted-plaintext-profile', supportsSignIn: true, supportsNative: !!nativeAdapter, googleSignIn: runtimeMode === 'native' ? 'switch-to-full-browser' : 'standalone-no-debug-available', signIn: signIn ? { mode: signIn.mode, accountId: signInAccountId, exited: signIn.exited } : null });
  const descriptor = (tab) => ({ tabId: tab.tabId, threadId: tab.threadId, documentId: tab.documentId, projectId: tab.projectId, agentId: tab.agentId, profileId: profileId(), url: publicURL(tab.page?.url?.() ?? tab.url), title: tab.title, status: tab.status, navigationEpoch: tab.navigationEpoch, controllerEpoch: tab.controllerEpoch, controller: { ...tab.controller }, runtime: runtime?.kind ?? tab.runtime ?? 'chromium', nativeTargetId: tab.nativeTargetId, runtimeGeneration: generation, snapshotId: tab.snapshot?.snapshotId ?? null });
  const publish = (tab) => emit('owned_browser_tab', { tab: descriptor(tab), runtime: runtimeInfo() });
  const persist = () => {
    if (resetting || resetFailed) return Promise.resolve();
    const records = [...tabs.values()].map((tab) => ({ ...descriptor(tab), sessionId: tab.sessionId, taskId: tab.taskId }));
    persistQueue = persistQueue.catch(() => {}).then(async () => {
      await fs.mkdir(path.dirname(descriptorFile), { recursive: true, mode: 0o700 });
      const temp = `${descriptorFile}.${crypto.randomBytes(8).toString('hex')}.part`;
      await fs.writeFile(temp, JSON.stringify({ version: 1, tabs: records, humanStorageOrigins: [...unconfirmedHumanOrigins] }), { mode: 0o600, flag: 'wx' });
      await fs.rename(temp, descriptorFile);
    });
    return persistQueue;
  };
  const markHumanOrigin = (origin) => {
    humanOrigins.add(origin);
    if (!unconfirmedHumanOrigins.has(origin)) { unconfirmedHumanOrigins.add(origin); void persist(); }
  };
  const markHumanDocument = (tab) => { for (const frame of tab.page?.frames?.() ?? []) if (/^https?:/.test(frame.url())) markHumanOrigin(new URL(frame.url()).origin); };
  const validateActor = (actor) => {
    if (!actor || (actor.isHuman ? !actor.clientId : !actor.threadId || !actor.agentId)) throw error('BROWSER_SCOPE_REQUIRED', 'A server-authorized browser actor is required.');
    if (closed) throw error('BROWSER_CLOSED', 'The browser service has closed.');
  };
  const ownedTab = (actor, tabId) => {
    const tab = tabs.get(tabId);
    if (!tab || (!actor.isHuman && !sameScope(actor, tab))) throw error('BROWSER_TAB_NOT_FOUND', 'This browser tab is unavailable to the current agent.');
    return tab;
  };
  const assertPolicy = async (actor, action, url, tab, args = {}) => {
    if (!actor.isHuman && action !== 'close' && (humanActionsPending || humanRequestsPending.size)) throw error('BROWSER_HUMAN_SESSION_PENDING', 'Wait for the current human browser action to finish before using its shared session.', true);
    const mapped = args.intent === 'website-change' || !actor.isHuman && changesWebsiteURL(url) ? 'website-change' : action === 'download' ? 'download' : READS.has(action) || MUTATIONS.has(action) ? 'read' : 'browse';
    if (policy?.assertAllowed && url !== 'about:blank') await policy.assertAllowed({ actor, action: mapped, url, profileId: profileId() });
    else if (policy?.assertBrowserAction) await policy.assertBrowserAction({ actor, action, url, tab: tab && descriptor(tab), intent: args.intent ?? 'research' });
    else if (mapped === 'website-change') throw error('BROWSER_WEBSITE_CHANGE_REQUIRED', 'Approve website changes for this site before continuing.');
    if (credentialBroker?.assertBrowserAccess && url !== 'about:blank') await credentialBroker.assertBrowserAccess({ actor, url, tab: { ...descriptor(tab ?? { page: null, url, controller: {} }), profileId: profileId() } });
  };
  const invalidate = (tab) => {
    for (const handle of tab.snapshot?.handles?.values?.() ?? []) void handle.dispose?.().catch(() => {});
    tab.snapshot = null;
    tab.frame = null;
    credentialBroker?.invalidateTab?.(tab.tabId);
  };
  const epochs = (tab, args, required = false) => {
    if (required && (args.navigationEpoch === undefined || args.controllerEpoch === undefined)) throw error('BROWSER_EPOCH_REQUIRED', 'Refresh the browser state before sending input.');
    if (args.navigationEpoch !== undefined && args.navigationEpoch !== tab.navigationEpoch) throw error('BROWSER_STALE_NAVIGATION', 'The page changed. Take a new snapshot before continuing.', true);
    if (args.controllerEpoch !== undefined && args.controllerEpoch !== tab.controllerEpoch) throw error('BROWSER_STALE_CONTROL', 'Browser control changed. Refresh the tab before continuing.', true);
    if (args.runtimeGeneration !== undefined && args.runtimeGeneration !== generation) throw error('BROWSER_STALE_RUNTIME', 'The browser restarted. Refresh its inventory before continuing.', true);
  };
  const assertController = (actor, tab) => {
    if (actor.isHuman) {
      if (tab.controller.owner !== 'human' || tab.controller.clientId !== actor.clientId) throw error('BROWSER_CONTROL_REQUIRED', 'Take control of this tab before sending input.');
    } else if (tab.controller.owner !== 'agent') throw error('BROWSER_HUMAN_CONTROL', 'The user controls this tab. Wait until control returns to the agent.', true);
  };
  const enqueue = (tab, operation) => {
    const result = tab.queue.catch(() => {}).then(operation);
    tab.queue = result.catch(() => {});
    return result;
  };
  const releaseInput = async (tab) => {
    for (const key of tab.heldKeys) await tab.page?.keyboard?.up(key).catch(() => {});
    for (const button of tab.heldButtons) await tab.page?.mouse?.up({ button }).catch(() => {});
    tab.heldKeys.clear(); tab.heldButtons.clear();
  };
  const actorForTab = (tab) => ({ threadId: tab.threadId, projectId: tab.projectId, documentId: tab.documentId, agentId: tab.agentId, ownerId: tab.ownerId, sessionId: tab.sessionId, isHuman: false });
  const sessionFingerprint = (storage) => {
    const grouped = new Map();
    for (const cookie of storage.cookies ?? []) { const domain = cookie.domain.replace(/^\./, '').toLowerCase(); const key = `domain:${domain}`; if (!grouped.has(key)) grouped.set(key, []); grouped.get(key).push(cookie); }
    for (const origin of storage.origins ?? []) grouped.set(`origin:${origin.origin}`, origin);
    return new Map([...grouped].map(([key, values]) => [key, crypto.createHmac('sha256', sessionKey).update(JSON.stringify(Array.isArray(values) ? values.sort((a, b) => `${a.domain}:${a.name}:${a.path}`.localeCompare(`${b.domain}:${b.name}:${b.path}`)) : values)).digest('hex')]));
  };
  const cookieIdentity = (cookie) => `${cookie.domain.toLowerCase()}\n${cookie.path}\n${cookie.name}`;
  const serializeSession = (operation) => { const result = sessionQueue.catch(() => {}).then(operation); sessionQueue = result.catch(() => {}); return result; };
  const matchesOrigin = (key, origin) => {
    if (key.startsWith('origin:')) return key.slice(7) === origin;
    const domain = key.slice(7), host = new URL(origin).hostname;
    return host === domain || host.endsWith(`.${domain}`);
  };
  const recordAgentSessions = (url, epoch, headers = []) => serializeSession(async () => {
    if (!runtime || state !== 'ready' || epoch !== humanSessionEpoch || humanActionsPending || humanRequestsPending.size || !/^https?:/.test(url)) return;
    const storage = await runtime.context.storageState({ indexedDB: true });
    const current = sessionFingerprint(storage);
    if (epoch !== humanSessionEpoch || humanActionsPending || humanRequestsPending.size) return;
    const origin = new URL(url).origin;
    const humanStorageOwner = unconfirmedHumanOrigins.has(origin) || runtime.context.pages().some((page) => !pageTabs.has(page) && page.frames().some((frame) => { try { return new URL(frame.url()).origin === origin; } catch { return false; } }));
    // Origin storage has no per-write actor identity. Never credit an agent with
    // an unproved localStorage/IndexedDB change while a human shares that origin.
    if (!humanStorageOwner) for (const [key, fingerprint] of current) if (key.startsWith('origin:') && matchesOrigin(key, origin)) sessionBaseline.set(key, fingerprint);
    const source = new URL(url), touchedDomains = new Set();
    for (const header of headers.filter((entry) => entry.name.toLowerCase() === 'set-cookie')) {
      const [pair, ...attributes] = header.value.split(';'), separator = pair.indexOf('=');
      if (separator <= 0) continue;
      const name = pair.slice(0, separator).trim(), value = pair.slice(separator + 1);
      const attrs = new Map(attributes.map((entry) => { const split = entry.indexOf('='); return [entry.slice(0, split < 0 ? undefined : split).trim().toLowerCase(), split < 0 ? '' : entry.slice(split + 1).trim()]; }));
      const domain = (attrs.get('domain') ?? source.hostname).replace(/^\./, '').toLowerCase();
      if (source.hostname !== domain && !source.hostname.endsWith(`.${domain}`)) continue;
      const cookiePath = attrs.get('path')?.startsWith('/') ? attrs.get('path') : source.pathname.slice(0, source.pathname.lastIndexOf('/')) || '/';
      const cookieDomain = attrs.has('domain') && !isIP(domain) ? `.${domain}` : domain;
      const identity = `${cookieDomain}\n${cookiePath}\n${name}`;
      const cookie = storage.cookies.find((entry) => cookieIdentity(entry) === identity);
      if (cookie?.value === value) { cookieBaseline.set(identity, cookie); touchedDomains.add(domain); }
      else if (!cookie && (Number(attrs.get('max-age')) <= 0 && attrs.has('max-age') || Date.parse(attrs.get('expires')) < Date.now())) { cookieBaseline.delete(identity); touchedDomains.add(domain); }
    }
    // Only the exact keys written by this authorized response advance cookie provenance.
    const approved = sessionFingerprint({ cookies: [...cookieBaseline.values()], origins: [] });
    for (const domain of touchedDomains) { const key = `domain:${domain}`; if (approved.has(key)) sessionBaseline.set(key, approved.get(key)); else sessionBaseline.delete(key); }
  });
  const observeHumanSessions = () => serializeSession(async () => {
    if (!runtime || state !== 'ready' || !credentialBroker?.registerSessionOrigins) return;
    for (const page of runtime.context.pages()) if (!pageTabs.has(page) && /^https?:/.test(page.url())) markHumanOrigin(new URL(page.url()).origin);
    const storage = await runtime.context.storageState({ indexedDB: true });
    const current = sessionFingerprint(storage);
    const domains = [], origins = [];
    for (const [key, fingerprint] of current) {
      if (fingerprint === sessionBaseline.get(key)) continue;
      if (key.startsWith('domain:')) {
        const domain = key.slice(7);
        if ([...humanOrigins].some((origin) => { const host = new URL(origin).hostname; return host === domain || host.endsWith(`.${domain}`) || domain.endsWith(`.${host}`); })) domains.push(domain);
      } else { const origin = key.slice(7); if (humanOrigins.has(origin)) origins.push(origin); }
    }
    if (domains.length || origins.length) await credentialBroker.registerSessionOrigins({ profileId: profileId(), origins, domains, source: 'human' });
    sessionBaseline = current;
    cookieBaseline = new Map(storage.cookies.map((cookie) => [cookieIdentity(cookie), cookie]));
  });

  const onDownload = async (tab, download) => {
    const actor = Object.freeze(tab.activeActor ?? (tab.controller.owner === 'human' ? { ...actorForTab(tab), isHuman: true, clientId: tab.controller.clientId } : actorForTab(tab)));
    const target = Object.freeze({ ...descriptor(tab), taskId: tab.taskId });
    const pageUrl = tab.page.url();
    const deliveredUrl = typeof download.url === 'function' ? download.url() : '';
    const downloadUrl = /^https?:/.test(deliveredUrl) ? deliveredUrl : pageUrl;
    const transferRuntime = runtime;
    try {
      await assertPolicy(actor, 'download', pageUrl, tab);
      await assertPolicy(actor, 'download', downloadUrl, tab);
      const handler = downloads?.handleBrowserDownload ?? downloads?.acceptBrowserDownload;
      if (!handler) throw error('BROWSER_DOWNLOADS_UNAVAILABLE', 'Managed downloads are not configured.');
      let monitoring = false;
      const monitor = setInterval(async () => {
        if (monitoring) return;
        monitoring = true;
        try {
          await assertPolicy(actor, 'download', pageUrl, tab);
          await assertPolicy(actor, 'download', downloadUrl, tab);
          const files = await fs.readdir(transferRuntime.downloadsPath, { withFileTypes: true });
          let total = 0;
          const maxBytes = downloads.maxBytes ?? limits.maxDownloadBytes;
          for (const file of files) if (file.isFile()) { const stat = await fs.stat(path.join(transferRuntime.downloadsPath, file.name)); total += stat.size; if (stat.size > maxBytes) await download.cancel(); }
          if (total > maxBytes * (downloads.maxConcurrent ?? 4)) await download.cancel();
        } catch (failure) { if (failure.code?.startsWith('BROWSER_')) await download.cancel().catch(() => {}); } finally { monitoring = false; }
      }, 100);
      monitor.unref?.();
      try {
        await handler.call(downloads, { download, actor, tab: target, pageUrl, source: { url: deliveredUrl || undefined, title: tab.title } });
        // The manager reserves a durable job immediately; Playwright completes its temporary transfer later.
        if (typeof download.failure === 'function') await download.failure();
      }
      finally { clearInterval(monitor); }
    } catch (failure) {
      await download.cancel().catch(() => {});
      emit('owned_browser_download_error', { tabId: tab.tabId, threadId: tab.threadId, projectId: tab.projectId, error: { code: failure.code ?? 'BROWSER_DOWNLOAD_FAILED', message: 'The browser download could not be stored.' } });
    }
  };

  const attach = async (tab, page) => {
    tab.page = page;
    pageTabs.set(page, tab);
    await page.routeWebSocket('**/*', async (socket) => {
      const url = socket.url().replace(/^wss:/, 'https:').replace(/^ws:/, 'http:');
      try {
        await guard.resolve(url);
        const handshakeActor = tab.activeActor ?? (tab.controller.owner === 'human' ? { ...actorForTab(tab), isHuman: true, clientId: tab.controller.clientId } : actorForTab(tab));
        await assertPolicy(handshakeActor, 'browse', url, tab);
        const server = socket.connectToServer();
        socket.onMessage(async (message) => {
          const actor = tab.activeActor ?? (tab.controller.owner === 'human' ? { ...actorForTab(tab), isHuman: true, clientId: tab.controller.clientId } : actorForTab(tab));
          try { await assertPolicy(actor, 'browse', url, tab, { intent: 'website-change' }); server.send(message); }
          catch { await server.close({ code: 4003, reason: 'Website changes require owner approval' }); await socket.close({ code: 4003, reason: 'Website changes require owner approval' }); }
        });
        server.onMessage(async (message) => {
          const actor = tab.controller.owner === 'human' ? { ...actorForTab(tab), isHuman: true, clientId: tab.controller.clientId } : actorForTab(tab);
          try { await assertPolicy(actor, 'snapshot', url, tab); socket.send(message); }
          catch { await server.close({ code: 4003, reason: 'Website access requires owner approval' }); await socket.close({ code: 4003, reason: 'Website access requires owner approval' }); }
        });
      } catch { await socket.close({ code: 4003, reason: 'Browser destination blocked' }); }
    });
    page.on('download', (download) => { void onDownload(tab, download); });
    page.on('dialog', (dialog) => { void dialog.dismiss().catch(() => {}); });
    page.on('filechooser', (chooser) => {
      if (tab.controller.owner !== 'human') { void chooser.setFiles([]).catch(() => {}); return; }
      tab.pendingChooser = chooser;
      emit('owned_browser_file_chooser', { tabId: tab.tabId, threadId: tab.threadId, multiple: chooser.isMultiple(), navigationEpoch: tab.navigationEpoch, controllerEpoch: tab.controllerEpoch });
    });
    page.on('framenavigated', (frame) => {
      if (frame !== page.mainFrame()) return;
      tab.navigationEpoch++; invalidate(tab); tab.url = page.url(); tab.status = 'loading'; publish(tab); void persist();
    });
    page.on('domcontentloaded', () => { tab.status = 'ready'; void page.title().then((title) => { tab.title = text(title, 500); publish(tab); void persist(); }).catch(() => {}); });
    page.on('crash', () => { tab.status = 'crashed'; tab.controllerEpoch++; invalidate(tab); publish(tab); });
    page.on('close', () => { if (tab.page !== page) return; tab.status = closed ? 'closed' : 'disconnected'; tab.page = null; tab.controllerEpoch++; invalidate(tab); publish(tab); });
    if (selectedAdapter()?.bind) {
      const session = await runtime.context.newCDPSession(page);
      try { tab.nativeTargetId = (await session.send('Target.getTargetInfo')).targetInfo.targetId; }
      finally { await session.detach().catch(() => {}); }
      await selectedAdapter().bind({ targetId: tab.nativeTargetId, tabId: tab.tabId, sessionId: tab.sessionId, chatId: tab.threadId });
    }
  };

  const ensureRuntime = async () => {
    if (resetting || resetFailed) throw error('BROWSER_RESET_REQUIRED', 'Complete browser cleanup in Settings before starting another browser.', true);
    if (signIn || handoffPending) throw error('BROWSER_SIGN_IN_ACTIVE', 'Complete sign-in in the full browser, then confirm the account in Browser settings.', true);
    if (runtime && state === 'ready') return runtime;
    if (starting) return starting;
    state = 'starting'; emit('owned_browser_runtime', { runtime: runtimeInfo() });
    starting = (async () => {
      try {
        if (runtime) { await runtime.close().catch(() => {}); runtime = null; }
        runtime = await runtimeFactory({ dataDir, guard, nativeAdapter: selectedAdapter(), headless, autoInstall: options.autoInstall !== false, onEvent: (progress) => emit('owned_browser_runtime', { runtime: { ...runtimeInfo(), ...progress } }) });
        generation++; state = 'ready';
        let checkpoint;
        if (credentialBroker?.restoreCheckpoint) {
          checkpoint = await credentialBroker.restoreCheckpoint({ profileId: profileId() });
          if (checkpoint && !handoffProfile && !(selectedAdapter() && runtime.context.pages().length)) await runtime.context.setStorageState(checkpoint);
        }
        const initialStorage = await runtime.context.storageState({ indexedDB: true });
        const initialFingerprint = sessionFingerprint(initialStorage);
        if ((!checkpoint || handoffProfile) && credentialBroker?.registerSessionOrigins && (initialStorage.cookies.length || initialStorage.origins.length)) {
          const origins = initialStorage.origins.map((entry) => entry.origin).filter((origin) => !handoffProfile || initialFingerprint.get(`origin:${origin}`) !== sessionBaseline.get(`origin:${origin}`));
          const domains = initialStorage.cookies.map((cookie) => cookie.domain.replace(/^\./, '')).filter((domain) => !handoffProfile || initialFingerprint.get(`domain:${domain}`) !== sessionBaseline.get(`domain:${domain}`));
          if (origins.length || domains.length) await credentialBroker.registerSessionOrigins({ profileId: profileId(), origins, domains, source: handoffProfile ? 'human' : 'unknown' });
        }
        sessionBaseline = initialFingerprint;
        cookieBaseline = new Map(initialStorage.cookies.map((cookie) => [cookieIdentity(cookie), cookie]));
        handoffProfile = false;
        await runtime.context.route('**/*', async (route) => {
          const request = route.request();
          try {
            const url = request.url();
            if (url.startsWith('data:') || url === 'about:blank') { await route.continue(); return; }
            await guard.resolve(url);
            let page; try { page = request.frame().page(); } catch {}
            const tab = page && pageTabs.get(page);
            if (tab) {
              const actor = tab.activeActor ?? (tab.controller.owner === 'human' ? { ...actorForTab(tab), isHuman: true, clientId: tab.controller.clientId } : actorForTab(tab));
              if (actor.isHuman) {
                humanSessionEpoch++; humanOrigins.add(new URL(url).origin); humanRequestsPending.add(request);
                // Cookies are applied with response headers. Streaming bodies must not hold
                // the shared profile indefinitely; the human action retains its own fence.
                void request.response().then(async () => { await observeHumanSessions(); }).catch(() => {}).finally(() => { humanRequestsPending.delete(request); });
              }
              else {
                const epoch = humanSessionEpoch;
                void request.response().then(async (response) => { if (response) await recordAgentSessions(url, epoch, await response.headersArray()); }).catch(() => {});
              }
              await assertPolicy(actor, 'browse', url, tab);
              if (!actor.isHuman && !['GET', 'HEAD', 'OPTIONS'].includes(request.method())) {
                const destination = new URL(url);
                const submit = tab.allowedSubmit;
                const safeSubmit = submit && submit.expiresAt > Date.now() && submit.origin === destination.origin && submit.pathname === destination.pathname && submit.method === request.method();
                if (!safeSubmit) await assertPolicy(actor, 'browse', url, tab, { intent: 'website-change' });
              }
            }
            await route.continue();
          } catch { await route.abort('blockedbyclient').catch(() => {}); }
        });
        runtime.context.on('page', (page) => {
          // Pages created by popup scripts never gain another agent's binding.
          void page.opener().then(async (opener) => {
            const parent = opener && pageTabs.get(opener);
            if (!parent) return;
            if (tabs.size >= limits.maxTabs) { await page.close(); return; }
            const tab = makeTab(actorForTab(parent)); tabs.set(tab.tabId, tab); await attach(tab, page); publish(tab); void persist();
          }).catch(() => {});
        });
        if (selectedAdapter()) for (const page of runtime.context.pages()) {
          const session = await runtime.context.newCDPSession(page);
          let targetId;
          try { targetId = (await session.send('Target.getTargetInfo')).targetInfo.targetId; }
          finally { await session.detach().catch(() => {}); }
          const retained = [...tabs.values()].find((tab) => tab.nativeTargetId === targetId);
          if (retained) { retained.controller = { owner: 'agent' }; retained.controllerEpoch++; retained.status = 'ready'; await attach(retained, page); publish(retained); }
        }
        runtime.browser?.on('disconnected', () => {
          if (closed) return;
          state = 'disconnected';
          for (const tab of tabs.values()) { tab.status = 'disconnected'; tab.controllerEpoch++; invalidate(tab); tab.page = null; publish(tab); }
          credentialBroker?.invalidateRuntime?.(generation);
          emit('owned_browser_runtime', { runtime: runtimeInfo() });
        });
        if (credentialBroker?.saveCheckpoint) { clearInterval(checkpointTimer); checkpointTimer = setInterval(() => { void saveCheckpoint().catch(() => {}); }, 30_000); checkpointTimer.unref?.(); }
        emit('owned_browser_runtime', { runtime: runtimeInfo() });
        return runtime;
      } catch (failure) { state = 'failed'; runtime = null; emit('owned_browser_runtime', { runtime: { ...runtimeInfo(), error: { code: failure.code ?? 'BROWSER_START_FAILED', message: failure.message } } }); throw failure; }
      finally { starting = null; }
    })();
    return starting;
  };
  const makeTab = (actor) => ({ tabId: id('tab'), threadId: actor.threadId ?? null, projectId: actor.projectId ?? null, documentId: actor.documentId ?? null, agentId: actor.agentId ?? 'human', ownerId: actor.ownerId, sessionId: actor.sessionId, taskId: actor.taskId, url: 'about:blank', title: '', status: 'ready', page: null, navigationEpoch: 0, controllerEpoch: 1, controller: actor.isHuman ? { owner: 'human', clientId: actor.clientId } : { owner: 'agent' }, queue: Promise.resolve(), heldKeys: new Set(), heldButtons: new Set(), snapshot: null, frame: null });
  const requirePage = (tab) => { if (!tab.page || tab.page.isClosed()) throw error('BROWSER_RECONNECT_REQUIRED', 'The browser page disconnected. Recover it before sending input.', true); return tab.page; };
  const saveCheckpoint = () => {
    if (resetting || resetFailed) return Promise.resolve();
    const result = checkpointQueue.catch(() => {}).then(async () => { if (!resetting && !resetFailed && runtime && state === 'ready' && credentialBroker?.saveCheckpoint) { await observeHumanSessions(); if (!resetting && !resetFailed) await credentialBroker.saveCheckpoint({ profileId: profileId(), state: await runtime.context.storageState({ indexedDB: true }) }); } });
    checkpointQueue = result.catch(() => {}); return result;
  };
  credentialBroker?.setDataResetter?.(async ({ phase }) => {
    if (phase === 'before') {
      resetting = true; clearInterval(checkpointTimer);
      if (starting) await starting.catch(() => {});
      if (handoffPromise) await handoffPromise.catch(() => {});
      for (const tab of tabs.values()) { tab.controllerEpoch++; invalidate(tab); }
      await Promise.all([...tabs.values()].map((tab) => tab.queue.catch(() => {})));
      await checkpointQueue; await sessionQueue; await persistQueue.catch(() => {});
      await signIn?.close(); signIn = null; signInAccountId = null;
      for (const tab of tabs.values()) await releaseInput(tab);
      await runtime?.close(); runtime = null;
      await nativeAdapter?.reset?.();
      tabs.clear(); sessionBaseline.clear(); cookieBaseline.clear(); humanOrigins.clear(); unconfirmedHumanOrigins.clear(); humanRequestsPending.clear(); handoffProfile = false; state = 'resetting';
      await removeOwnedBrowserState({ dataDir });
    } else if (phase === 'after') { resetting = false; resetFailed = false; state = 'idle'; emit('owned_browser_runtime', { runtime: runtimeInfo() }); }
    else { resetting = false; resetFailed = true; state = 'failed'; emit('owned_browser_runtime', { runtime: runtimeInfo() }); }
  });
  credentialBroker?.setSessionClearer?.(async ({ profileId: targetProfile, origins }) => {
    if (targetProfile !== profileId()) throw error('BROWSER_PROFILE_NOT_ACTIVE', 'Select this account profile before signing it out.');
    await ensureRuntime();
    const hosts = origins.map((origin) => new URL(origin).hostname);
    const cookies = await runtime.context.cookies();
    const domains = [...new Set(cookies.map((cookie) => cookie.domain).filter((raw) => { const domain = raw.replace(/^\./, ''); return hosts.some((host) => host === domain || host.endsWith(`.${domain}`)); }))];
    for (const domain of domains) await runtime.context.clearCookies({ domain });
    const storage = await runtime.context.storageState({ indexedDB: true });
    const clearedOrigins = [...new Set([...origins, ...storage.origins.map((entry) => entry.origin).filter((origin) => domains.some((raw) => { const domain = raw.replace(/^\./, ''), host = new URL(origin).hostname; return host === domain || host.endsWith(`.${domain}`); }))])];
    for (const origin of clearedOrigins) {
      const page = await runtime.context.newPage();
      const session = await runtime.context.newCDPSession(page);
      try { await session.send('Storage.clearDataForOrigin', { origin, storageTypes: 'all' }); }
      finally { await session.detach().catch(() => {}); await page.close().catch(() => {}); }
    }
    for (const tab of tabs.values()) { invalidate(tab); tab.controllerEpoch++; publish(tab); }
    const clearedStorage = await runtime.context.storageState({ indexedDB: true });
    sessionBaseline = sessionFingerprint(clearedStorage); cookieBaseline = new Map(clearedStorage.cookies.map((cookie) => [cookieIdentity(cookie), cookie]));
    return { clearedDomains: domains.map((domain) => domain.replace(/^\./, '')), clearedOrigins };
  });
  const requireRef = (tab, args) => {
    if (!args.snapshotId || args.snapshotId !== tab.snapshot?.snapshotId || !args.ref) throw error('BROWSER_STALE_REFERENCE', 'Take a new snapshot and use one of its element references.', true);
    const entry = tab.snapshot.handles.get(String(args.ref));
    if (!entry) throw error('BROWSER_REFERENCE_NOT_FOUND', 'The element reference is not in the current snapshot.');
    return entry;
  };

  const snapshot = async (tab) => {
    invalidate(tab);
    const navigationEpoch = tab.navigationEpoch;
    const handles = await tab.page.locator(ELEMENTS).elementHandles();
    const refs = new Map();
    const elements = [];
    for (const handle of handles.slice(0, limits.maxSnapshotElements)) {
      const element = await handle.evaluate((el) => {
        const rect = el.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0 || getComputedStyle(el).visibility === 'hidden') return null;
        const sensitive = el.matches('input[type="password"],input[type="email"],input[autocomplete="username"],input[name="username"],input[name="email"],input[autocomplete="current-password"],input[autocomplete="new-password"],input[autocomplete="one-time-code"],input[autocomplete^="cc-"],[data-rhwp-private-field]');
        const label = el.getAttribute('aria-label') || el.labels?.[0]?.textContent || el.getAttribute('placeholder') || el.textContent || '';
        return { tag: el.tagName.toLowerCase(), role: el.getAttribute('role') || ({ A: 'link', BUTTON: 'button', INPUT: 'textbox', TEXTAREA: 'textbox', SELECT: 'combobox', SUMMARY: 'button' })[el.tagName] || 'textbox', name: String(label).trim().slice(0, 500), text: sensitive ? '[masked]' : String(el.textContent ?? '').trim().slice(0, 1000), value: sensitive ? '[masked]' : String(el.value ?? '').slice(0, 1000), sensitive, disabled: !!el.disabled, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } };
      }).catch(() => null);
      if (!element) { await handle.dispose(); continue; }
      const ref = `e${elements.length + 1}`; refs.set(ref, handle); elements.push({ ref, ...element });
    }
    for (const handle of handles.slice(limits.maxSnapshotElements)) await handle.dispose();
    const content = await tab.page.locator('body').innerText({ timeout: 3000 }).catch(() => '');
    const selectedText = await tab.page.evaluate((selector) => {
      if (document.activeElement?.matches(selector)) return '';
      const selection = window.getSelection();
      if (!selection) return '';
      for (let index = 0; index < selection.rangeCount; index++) {
        const range = selection.getRangeAt(index);
        for (const el of document.querySelectorAll(selector)) if (range.intersectsNode(el)) return '';
      }
      return String(selection).slice(0, 16_000);
    }, SENSITIVE);
    if (navigationEpoch !== tab.navigationEpoch) { for (const handle of refs.values()) await handle.dispose().catch(() => {}); throw error('BROWSER_STALE_NAVIGATION', 'The page changed while it was observed. Take a new snapshot.', true); }
    const result = { snapshotId: id('snapshot'), tabId: tab.tabId, navigationEpoch, controllerEpoch: tab.controllerEpoch, url: publicURL(tab.page.url()), title: tab.title, text: text(content, 24_000), selectedText, elements, truncated: handles.length > limits.maxSnapshotElements };
    tab.snapshot = { ...result, handles: refs };
    return result;
  };
  const viewportInfo = async (tab) => tab.page.evaluate(() => ({ width: innerWidth, height: innerHeight, deviceScaleFactor: devicePixelRatio, scrollX, scrollY }));
  const screenshot = async (tab, rect) => {
    const masks = tab.page.frames().map((frame) => frame.locator(SENSITIVE));
    const bytes = await tab.page.screenshot({ type: 'jpeg', quality: 75, fullPage: false, animations: 'disabled', mask: masks, maskColor: '#333333', ...(rect ? { clip: rect } : {}), timeout: 10_000 });
    if (bytes.length > limits.maxFrameBytes) throw error('BROWSER_FRAME_TOO_LARGE', 'The captured browser frame exceeds the size limit.');
    return bytes.toString('base64');
  };
  const frame = async (tab) => {
    const epoch = tab.navigationEpoch;
    const viewport = await viewportInfo(tab);
    const data = await screenshot(tab);
    if (epoch !== tab.navigationEpoch) throw error('BROWSER_STALE_NAVIGATION', 'The page changed during capture. Request another frame.', true);
    const result = { frameId: id('frame'), tabId: tab.tabId, navigationEpoch: epoch, controllerEpoch: tab.controllerEpoch, mimeType: 'image/jpeg', data, ...viewport };
    tab.frame = { ...result, data: undefined };
    return result;
  };

  const input = async (tab, args) => {
    if (args.type === 'release') { await releaseInput(tab); return { completed: true }; }
    if (args.frameId && args.frameId !== tab.frame?.frameId) throw error('BROWSER_STALE_FRAME', 'The displayed browser frame is stale.', true);
    const x = bounded(args.x, 0, 1919, 0), y = bounded(args.y, 0, 1079, 0);
    if (args.type === 'pointer') {
      const button = ['left', 'middle', 'right'].includes(args.button) ? args.button : 'left';
      await tab.page.mouse.move(x, y);
      if (args.event === 'down') { await tab.page.mouse.down({ button }); tab.heldButtons.add(button); }
      else if (args.event === 'up') { await tab.page.mouse.up({ button }); tab.heldButtons.delete(button); }
      else if (args.event === 'click') await tab.page.mouse.click(x, y, { button });
    } else if (args.type === 'wheel') await tab.page.mouse.wheel(bounded(args.deltaX, -2000, 2000, 0), bounded(args.deltaY, -2000, 2000, 0));
    else if (args.type === 'text' || args.type === 'composition') { if (args.type === 'text' || args.event === 'end') await tab.page.keyboard.insertText(text(args.text, 16_000)); }
    else if (args.type === 'key') {
      const key = text(args.key, 80);
      if (args.event === 'down') { await tab.page.keyboard.down(key); tab.heldKeys.add(key); }
      else if (args.event === 'up') { await tab.page.keyboard.up(key); tab.heldKeys.delete(key); }
      else await tab.page.keyboard.press(key);
    } else throw error('BROWSER_INPUT_INVALID', 'Unsupported browser input event.');
    return { completed: true };
  };

  const capture = async (actor, tab, args) => {
    if (args.frameId && args.frameId !== tab.frame?.frameId) throw error('BROWSER_STALE_FRAME', 'The displayed browser frame is stale.', true);
    const epoch = tab.navigationEpoch;
    const viewport = await viewportInfo(tab);
    const result = { captureId: id('capture'), tabId: tab.tabId, threadId: actor.isHuman ? args.destinationThreadId ?? tab.threadId : tab.threadId, projectId: tab.projectId, documentId: tab.documentId, navigationEpoch: epoch, source: { url: publicURL(tab.page.url()), title: tab.title, timestamp: new Date().toISOString() }, viewport, mode: args.mode ?? (args.ref ? 'element' : args.rect || args.region ? 'region' : 'page'), comment: text(args.comment) };
    let rect = args.rect ?? args.region;
    if (result.mode === 'element') {
      const handle = args.ref ? requireRef(tab, args) : await tab.page.evaluateHandle(({ x, y }) => document.elementFromPoint(x, y), { x: Number(args.point?.x) || 0, y: Number(args.point?.y) || 0 });
      result.element = await handle.evaluate((el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { tag: el.tagName.toLowerCase(), role: el.getAttribute('role') ?? '', name: (el.getAttribute('aria-label') ?? '').slice(0, 500), text: el.matches('input') ? '[masked]' : String(el.textContent ?? '').slice(0, 2000), rect: { x: r.x, y: r.y, width: r.width, height: r.height } }; });
      if (!args.ref) await handle.dispose();
      if (!result.element) throw error('BROWSER_ELEMENT_NOT_FOUND', 'No page element was found at this point.');
      rect = result.element.rect;
    }
    if (rect) {
      const x = bounded(rect.x, 0, viewport.width, 0), y = bounded(rect.y, 0, viewport.height, 0);
      const width = bounded(rect.width, 1, viewport.width - x, 1), height = bounded(rect.height, 1, viewport.height - y, 1);
      if (width < 1 || height < 1) throw error('BROWSER_CAPTURE_REGION_INVALID', 'Select a region inside the browser page.');
      result.rect = { x, y, width, height };
    }
    try { result.screenshot = { mimeType: 'image/jpeg', data: await screenshot(tab, result.rect), width: result.rect?.width ?? viewport.width, height: result.rect?.height ?? viewport.height }; }
    catch { result.screenshotError = { code: 'BROWSER_CAPTURE_IMAGE_FAILED', message: 'The screenshot failed. The annotation and page evidence were retained.' }; }
    if (epoch !== tab.navigationEpoch) throw error('BROWSER_STALE_NAVIGATION', 'The page changed during annotation. Capture the current page again.', true);
    return result;
  };

  const assertInputIntent = async (actor, action, tab, args) => {
    if (actor.isHuman || !['click', 'type', 'press'].includes(action)) return;
    const handle = args.ref ? requireRef(tab, args) : await tab.page.evaluateHandle(() => document.activeElement);
    let target;
    try {
      target = await handle.evaluate((el, rules) => {
        if (!el) return null;
        const form = el.form ?? el.closest('form');
        return { tag: el.tagName.toLowerCase(), role: el.getAttribute('role') ?? '', type: el.getAttribute('type') ?? '', editable: el.isContentEditable,
          label: String(el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || '').trim().slice(0, 500),
          name: `${el.id} ${el.getAttribute('name') ?? ''} ${el.getAttribute('placeholder') ?? ''}`,
          href: el.href ?? '', download: el.hasAttribute('download'), form: !!form, method: (form?.method ?? 'get').toLowerCase(), action: form?.action ?? '', login: !!form?.querySelector('input[type="password"]'),
          queryVisible: !!form && [...form.elements].some((field) => { const rect = field.getBoundingClientRect(); return field.tagName === 'INPUT' && ['search', 'text'].includes(field.type) && /^(q|query|search|term|keyword|keywords|searchquery)$/i.test(field.name) && !field.disabled && rect.width > 0 && rect.height > 0 && getComputedStyle(field).visibility !== 'hidden'; }),
          dangerousParams: !!form && [...form.elements].some((field) => { const name = field.name.toLowerCase(); if (!rules.verbs.includes(name) && !rules.operations.includes(name)) return false; const value = String(field.value).trim().toLowerCase(); return rules.verbs.includes(name) && !rules.negative.includes(value) || rules.operations.includes(name) && rules.verbs.includes(value); }),
          exportOnly: !!form && form.elements.length <= 64 && [...form.elements].every((field) => field.tagName === 'BUTTON' || field.tagName === 'INPUT' && ['hidden', 'submit', 'button', 'image'].includes(field.type)) };
      }, PARAMETER_RULES);
    } finally { if (!args.ref) await handle.dispose(); }
    let changesWebsite = !target;
    if (target) {
      const dangerous = /\b(delete|remove|destroy|send|publish|buy|purchase|checkout|share|save|edit|upload|invite|subscribe|unsubscribe|logout|sign out)\b|삭제|구매|결제|공유|전송|저장|편집|게시|초대|로그아웃/i.test(target.label);
      let destination;
      try { destination = new URL(target.href || target.action || tab.page.url(), tab.page.url()); } catch {}
      const dangerousPath = destination && changesWebsiteURL(destination.href);
      changesWebsite = dangerous || !!dangerousPath || target.dangerousParams || target.editable || target.tag === 'textarea';
      if (action === 'type') {
        // Typing in editor surfaces and unknown POST forms can trigger autosave.
        changesWebsite ||= target.form && target.method !== 'get' && !target.login && !/search|query|\bq\b/i.test(target.name);
      } else if (action === 'click' || /Enter|Space/.test(args.key ?? '')) {
        if (target.href) changesWebsite ||= !destination || !( ['https:', 'http:'].includes(destination.protocol) || target.download && destination.protocol === 'blob:' );
        else if (target.form && (action === 'press' || target.tag === 'button' || ['button', 'menuitem'].includes(target.role) || target.tag === 'input' && ['button', 'submit', 'image'].includes(target.type))) {
          const accounts = credentialBroker?.listAccounts ? (await credentialBroker.listAccounts()).accounts : [];
          const loginAllowed = target.login && destination && accounts.some((account) => account.agentReuseApproved && account.origins.includes(new URL(tab.page.url()).origin) && account.origins.includes(destination.origin));
          const host = new URL(tab.page.url()).hostname;
          const knownSearch = ['www.google.com', 'pubmed.ncbi.nlm.nih.gov', 'pmc.ncbi.nlm.nih.gov', 'arxiv.org', 'www.arxiv.org'].includes(host) && /search|검색/i.test(target.label);
          const knownExport = host === 'docs.google.com' && /download|export|pdf|다운로드|내보내기/i.test(target.label) && /\/presentation\/d\//.test(new URL(tab.page.url()).pathname);
          const pdfExport = target.exportOnly && /download|export|pdf|다운로드|내보내기/i.test(target.label) && destination && /(?:\/|[-_.])(pdf|export|download)(?:\/|[-_.]|$)/i.test(destination.pathname) && !dangerousPath;
          const searchDestination = destination && ( /^\/(?:$|(?:search|query|find|results)(?:[/.]|$))/i.test(destination.pathname) || host.endsWith('.wikipedia.org') && destination.pathname === '/w/index.php' );
          const searchTarget = /search|query|find|검색|찾기/i.test(target.label) || action === 'press' && /(^|\s)(q|query|search|term|keyword|keywords|searchquery)(\s|$)/i.test(target.name);
          const querySearch = target.method === 'get' && target.queryVisible && searchDestination && searchTarget;
          const safeSubmit = !target.dangerousParams && (loginAllowed || knownSearch || knownExport || pdfExport || querySearch);
          changesWebsite ||= !safeSubmit;
          if (safeSubmit && destination) tab.allowedSubmit = { origin: destination.origin, pathname: destination.pathname, method: target.method.toUpperCase(), expiresAt: Date.now() + 15_000 };
        } else if (!target.form && (target.tag === 'button' || ['button', 'menuitem'].includes(target.role) || target.tag === 'input' && ['button', 'submit', 'image'].includes(target.type))) changesWebsite = true;
        else if (action === 'press' && !/Enter|Space/.test(args.key ?? '')) changesWebsite = true;
      }
    }
    if (changesWebsite) {
      if (!policy?.assertAllowed && !policy?.assertBrowserAction) throw error('BROWSER_WEBSITE_CHANGE_REQUIRED', 'This action can change the website. Approve website changes for this site before continuing.');
      await assertPolicy(actor, action, tab.page.url(), tab, { ...args, intent: 'website-change' });
    }
  };
  const assertAgentKey = (actor, key) => {
    if (actor.isHuman) return;
    const value = String(key ?? '');
    const navigation = ['Enter', 'Space', 'Tab', 'Escape', 'Backspace', 'Delete', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'];
    const allowed = navigation.includes(value) || /^[A-Za-z0-9]$/.test(value) || ['Shift+Tab', 'Control+a', 'Meta+a', 'ControlOrMeta+a'].includes(value);
    if (!allowed) throw error('BROWSER_SHORTCUT_BLOCKED', 'Use browser navigation and input tools. Clipboard and browser-window shortcuts are reserved for human control.');
  };

  const operate = async (actor, action, tab, args) => {
    if (action === 'close') { await releaseInput(tab); await tab.page?.close(); tab.status = 'closed'; tabs.delete(tab.tabId); await persist(); return { completed: true }; }
    const page = requirePage(tab);
    if (action === 'snapshot') return { snapshot: await snapshot(tab) };
    if (action === 'frame') return { frame: await frame(tab) };
    if (action === 'capture') return { capture: await capture(actor, tab, args) };
    if (action === 'wait') {
      if (args.ref) await requireRef(tab, args).waitForElementState(args.state === 'hidden' ? 'hidden' : 'visible', { timeout: bounded(args.timeoutMs, 1, 15_000, 3000) });
      else await page.waitForLoadState(args.state === 'load' ? 'load' : 'domcontentloaded', { timeout: bounded(args.timeoutMs, 1, 15_000, 3000) });
      return { completed: true };
    }
    if (action === 'navigate') {
      invalidate(tab);
      if (args.direction === 'stop') await page.evaluate(() => window.stop());
      else if (args.direction === 'back') await page.goBack({ waitUntil: 'domcontentloaded' });
      else if (args.direction === 'forward') await page.goForward({ waitUntil: 'domcontentloaded' });
      else if (args.direction === 'reload') await page.reload({ waitUntil: 'domcontentloaded' });
      else { const url = guard.parse(args.url).href; await assertPolicy(actor, action, url, tab, args); await page.goto(url, { waitUntil: 'domcontentloaded' }); }
      return { completed: true };
    }
    if (action === 'click') { await requireRef(tab, args).click({ timeout: 10_000, button: args.button === 'right' ? 'right' : 'left' }); return { completed: true }; }
    if (action === 'type') {
      const handle = requireRef(tab, args);
      if (await handle.evaluate((el) => el.matches('input[type="password"],input[autocomplete="current-password"],input[autocomplete="new-password"]'))) throw error('BROWSER_SECRET_CHANNEL_REQUIRED', 'Use the saved-account broker to fill password fields.');
      await handle.fill(text(args.text, 16_000), { timeout: 10_000 }); return { completed: true };
    }
    if (action === 'press') { assertAgentKey(actor, args.key); if (args.ref) await requireRef(tab, args).press(text(args.key, 80)); else await page.keyboard.press(text(args.key, 80)); return { completed: true }; }
    if (action === 'scroll') { await page.mouse.wheel(bounded(args.deltaX, -2000, 2000, 0), bounded(args.deltaY, -2000, 2000, 600)); return { completed: true }; }
    if (action === 'input') { if (!actor.isHuman) throw error('BROWSER_HUMAN_INPUT_REQUIRED', 'Raw browser input is reserved for human takeover.'); return input(tab, args); }
    if (action === 'upload') {
      if (!actor.isHuman || !tab.pendingChooser) throw error('BROWSER_UPLOAD_UNAVAILABLE', 'Choose Upload in a human-controlled page first.');
      const files = Array.isArray(args.files) ? args.files : [];
      if (files.length > 5) throw error('BROWSER_UPLOAD_LIMIT', 'Choose at most five files.');
      let total = 0;
      const payloads = files.map((file) => {
        if (typeof file.data !== 'string' || file.data.length > 28 * 1024 * 1024 || !/^[A-Za-z0-9+/]*={0,2}$/.test(file.data)) throw error('BROWSER_UPLOAD_INVALID', 'The selected file data is invalid.');
        const buffer = Buffer.from(file.data, 'base64'); total += buffer.length;
        if (buffer.length > 20 * 1024 * 1024 || total > 40 * 1024 * 1024) throw error('BROWSER_UPLOAD_LIMIT', 'The selected files exceed the upload limit.');
        return { name: path.basename(text(file.name, 256).replaceAll('\\', '/')).replace(/[\u0000-\u001f\u007f]/g, '') || 'upload', mimeType: text(file.mimeType, 128) || 'application/octet-stream', buffer };
      });
      const chooser = tab.pendingChooser; tab.pendingChooser = null; await chooser.setFiles(payloads); return { completed: true };
    }
    if (action === 'viewport') { await page.setViewportSize({ width: Math.floor(bounded(args.width, 320, 1920, 1280)), height: Math.floor(bounded(args.height, 240, 1080, 800)) }); tab.frame = null; return { completed: true }; }
    if (action === 'fill-account') {
      if (!credentialBroker?.issueHandle || !credentialBroker?.fill) throw error('BROWSER_VAULT_UNAVAILABLE', 'The secure account broker is unavailable.', true);
      const passwordHandle = requireRef(tab, { ...args, ref: args.passwordRef ?? args.ref });
      const usernameHandle = args.usernameRef ? requireRef(tab, { ...args, ref: args.usernameRef }) : null;
      const origin = new URL(page.url()).origin;
      const binding = { tabId: tab.tabId, runtimeGeneration: generation, navigationEpoch: tab.navigationEpoch, controlEpoch: tab.controllerEpoch, frameId: 'main', origin, accountId: args.accountId };
      const issued = await credentialBroker.issueHandle({ actor, accountId: args.accountId, binding });
      await credentialBroker.fill({ actor, handle: issued.handle, binding, getBinding: async () => ({ ...binding, origin: new URL(page.url()).origin, navigationEpoch: tab.navigationEpoch, controlEpoch: tab.controllerEpoch, runtimeGeneration: generation }), fill: async ({ username, password, assertAuthorized, perform = async (write) => write() }) => {
        epochs(tab, args, true); assertController(actor, tab);
        if (new URL(page.url()).origin !== origin || await passwordHandle.ownerFrame() !== page.mainFrame()) throw error('BROWSER_CREDENTIAL_TARGET_CHANGED', 'The sign-in page or frame changed.');
        if (!await passwordHandle.evaluate((el) => el.matches('input[type="password"]') && el.isConnected)) throw error('BROWSER_CREDENTIAL_TARGET_INVALID', 'The selected field is not a current password field.');
        const write = async (handle, value, isPassword) => {
          if (!isPassword) await handle.evaluate((el) => el.setAttribute('data-rhwp-private-field', 'true'));
          // Readiness waits hold no credential data and never hold a revocation fence.
          await handle.waitForElementState('visible', { timeout: 10_000 });
          await handle.waitForElementState('editable', { timeout: 10_000 });
          await assertAuthorized?.();
          await assertPolicy(actor, 'fill-account', page.url(), tab, args);
          epochs(tab, args, true); assertController(actor, tab);
          await perform(async () => {
            const written = await handle.evaluate((el, payload) => {
              const rect = el.getBoundingClientRect();
              if (location.origin !== payload.origin || !el.isConnected || el.disabled || el.readOnly || rect.width <= 0 || rect.height <= 0 || getComputedStyle(el).visibility === 'hidden' || !(el instanceof HTMLInputElement) || (payload.isPassword && el.type !== 'password')) return false;
              Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, payload.value);
              el.dispatchEvent(new Event('input', { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
              return true;
            }, { value, origin, isPassword });
            if (!written) throw error('BROWSER_CREDENTIAL_TARGET_CHANGED', 'The sign-in field changed before credential input. Refresh it before retrying.');
          });
        };
        if (usernameHandle) await write(usernameHandle, username, false);
        await write(passwordHandle, password, true);
      } });
      return { completed: true, accountId: args.accountId };
    }
    throw error('BROWSER_ACTION_INVALID', 'Unsupported browser action.');
  };

  const inventory = async (actor) => {
    validateActor(actor);
    if (!actor.isHuman) await observeHumanSessions();
    const visible = [];
    for (const tab of tabs.values()) {
      if (!actor.isHuman && !sameScope(actor, tab)) continue;
      let current = descriptor(tab);
      if (!actor.isHuman) try { await assertPolicy(actor, 'snapshot', tab.page?.url?.() ?? tab.url, tab); }
      catch { current = { ...current, url: 'about:blank', title: '', status: 'approval-required', snapshotId: null }; }
      visible.push(current);
    }
    return { ok: true, action: 'status', runtime: runtimeInfo(), tabs: visible, limits };
  };
  const request = async (actor, action, args = {}) => {
    validateActor(actor);
    if ((resetting || resetFailed) && !['status', 'reset-browser'].includes(action)) throw error('BROWSER_RESET_REQUIRED', 'Complete browser cleanup in Settings before using the browser.', true);
    if (action === 'reset-browser') {
      if (!actor.isHuman) throw error('BROWSER_HUMAN_REQUIRED', 'Browser cleanup is managed from Settings.');
      if (!credentialBroker?.resetBrowserData) throw error('BROWSER_RESET_UNAVAILABLE', 'The browser account store is unavailable.');
      if (resetting) throw error('BROWSER_RESET_ACTIVE', 'Browser cleanup is already running.', true);
      resetting = true; emit('owned_browser_runtime', { runtime: runtimeInfo() });
      try { const result = await credentialBroker.resetBrowserData({ actor }); return { ok: true, action, ...result, runtime: runtimeInfo(), tabs: [] }; }
      catch (failure) { resetting = false; resetFailed = true; throw failure; }
    }
    if (!actor.isHuman && action !== 'status' && (signIn || handoffPending)) throw error('BROWSER_SIGN_IN_ACTIVE', 'The user owns the browser profile during sign-in. Wait for account confirmation.', true);
    if (runtime && !actor.isHuman) await observeHumanSessions();
    if (action === 'status') return { ...(await inventory(actor)), readiness: state === 'ready' ? { state: 'ready', installed: true } : await inspectOwnedBrowserRuntime({ dataDir }) };
    if (action === 'install') {
      if (!actor.isHuman) throw error('BROWSER_HUMAN_REQUIRED', 'Browser installation is managed from Browser settings.');
      installPromise ??= installOwnedBrowserRuntime({ dataDir, onProgress: (progress) => emit('owned_browser_runtime', { runtime: { ...runtimeInfo(), ...progress } }) }).finally(() => { installPromise = null; });
      return { ok: true, action, readiness: await installPromise };
    }
    if (action === 'configure') {
      if (!actor.isHuman) throw error('BROWSER_HUMAN_REQUIRED', 'Browser configuration is managed by the user.');
      if (signIn || handoffPending) throw error('BROWSER_SIGN_IN_ACTIVE', 'Finish the current sign-in before changing browser mode.');
      if ([...tabs.values()].some((tab) => tab.page && !tab.page.isClosed())) throw error('BROWSER_TABS_OPEN', 'Close browser tabs before changing runtime mode.');
      if (!['managed', 'native'].includes(args.mode)) throw error('BROWSER_CONFIGURATION_INVALID', 'Choose a managed or native browser.');
      if (args.mode === 'native' && !nativeAdapter) throw error('BROWSER_NATIVE_UNAVAILABLE', 'The native desktop browser is unavailable on this hub.');
      await saveCheckpoint().catch(() => {}); await runtime?.close(); runtime = null; state = 'idle';
      runtimeMode = args.mode; if (typeof args.headless === 'boolean') headless = args.headless;
      await fs.mkdir(path.dirname(descriptorFile), { recursive: true, mode: 0o700 });
      await fs.writeFile(path.join(dataDir, 'browser', 'runtime.json'), JSON.stringify({ version: 1, mode: runtimeMode, headless }), { mode: 0o600 });
      return { ok: true, action, runtime: runtimeInfo() };
    }
    if (action === 'sign-in') {
      if (!actor.isHuman) throw error('BROWSER_HUMAN_REQUIRED', 'Open full-browser sign-in from Browser settings.');
      const url = guard.parse(args.url ?? 'https://accounts.google.com/').href;
      const account = credentialBroker?.listAccounts && (await credentialBroker.listAccounts()).accounts.find((entry) => entry.id === args.accountId);
      if (!account || account.profileId !== 'default' || !account.origins.includes(new URL(url).origin)) throw error('BROWSER_ACCOUNT_REGISTRATION_REQUIRED', 'Add and approve this website account in Browser settings before opening full-browser sign-in.');
      if (signIn || handoffPending) throw error('BROWSER_SIGN_IN_ACTIVE', 'Finish the current sign-in before opening another account.');
      handoffPending = true;
      try {
        let resolveHandoff; handoffPromise = new Promise((resolve) => { resolveHandoff = resolve; });
        try {
        if (starting) await starting;
        clearInterval(checkpointTimer);
        if (runtime) { await saveCheckpoint().catch(() => {}); await runtime.close(); runtime = null; }
        await credentialBroker.deleteCheckpoint?.({ profileId: 'default' });
        for (const tab of tabs.values()) { tab.page = null; tab.status = 'disconnected'; tab.controllerEpoch++; tab.controller = { owner: 'agent' }; invalidate(tab); }
        runtimeMode = 'managed'; state = 'sign-in'; signInAccountId = account.id;
        const start = options.signInFactory ?? startOwnedBrowserSignIn;
        signIn = await start({ dataDir, url, autoInstall: options.autoInstall !== false, onExit: () => emit('owned_browser_runtime', { runtime: runtimeInfo() }) });
        } finally { resolveHandoff(); handoffPromise = null; }
      } catch (failure) { state = 'failed'; signInAccountId = null; throw failure; }
      finally { handoffPending = false; }
      emit('owned_browser_runtime', { runtime: runtimeInfo() });
      return { ok: true, action, runtime: runtimeInfo(), signIn: { mode: 'standalone-no-debug', accountId: account.id, message: 'Complete sign-in in the separate Chromium window, then confirm the account in Browser settings.' } };
    }
    if (action === 'confirm-sign-in') {
      if (!actor.isHuman || !credentialBroker?.confirmAccountSession) throw error('BROWSER_HUMAN_REQUIRED', 'Confirm the signed-in account from Browser settings.');
      if (handoffPending) throw error('BROWSER_SIGN_IN_ACTIVE', 'Wait for the sign-in browser to open before confirming the account.');
      if (signIn) {
        if (args.accountId !== signInAccountId) throw error('BROWSER_ACCOUNT_IDENTITY_MISMATCH', 'Confirm the account selected for this sign-in window.');
        await signIn.close(); signIn = null; signInAccountId = null; handoffProfile = true; state = 'idle';
        await ensureRuntime();
      }
      await observeHumanSessions();
      const result = await credentialBroker.confirmAccountSession({ actor, accountId: args.accountId });
      const account = result.account ?? result;
      const confirmedStorage = await runtime.context.storageState({ indexedDB: true });
      const confirmed = sessionFingerprint(confirmedStorage);
      for (const origin of account.origins ?? []) {
        unconfirmedHumanOrigins.delete(origin);
        const key = `origin:${origin}`;
        if (confirmed.has(key)) sessionBaseline.set(key, confirmed.get(key)); else sessionBaseline.delete(key);
      }
      await persist();
      await saveCheckpoint();
      return { ok: true, action, account, runtime: runtimeInfo() };
    }
    if (action === 'downloads') {
      if (!downloads) throw error('BROWSER_DOWNLOADS_UNAVAILABLE', 'Managed downloads are unavailable.');
      const operation = args.action ?? 'list';
      if (operation === 'list') return { ok: true, action, downloads: await downloads.list(actor) };
      if (!['cancel', 'retry', 'import'].includes(operation)) throw error('BROWSER_ACTION_INVALID', 'Unsupported download action.');
      const method = operation === 'import' ? downloads.importDownload : downloads[operation];
      return { ok: true, action, download: await method.call(downloads, { ...args, actor }) };
    }
    if (action === 'open') {
      const url = args.url ? guard.parse(args.url).href : 'about:blank';
      await assertPolicy(actor, action, url, null, args);
      if (tabs.size >= limits.maxTabs || [...tabs.values()].filter((tab) => sameScope(actor, tab)).length >= limits.maxTabsPerAgent) throw error('BROWSER_TAB_LIMIT', 'Close an unused browser tab before opening another.');
      await ensureRuntime();
      if (closed) throw error('BROWSER_CLOSED', 'The browser service has closed.');
      if (resetting || resetFailed) throw error('BROWSER_RESET_REQUIRED', 'Complete browser cleanup before opening another page.');
      if (signIn || handoffPending) throw error('BROWSER_SIGN_IN_ACTIVE', 'The user owns the browser profile during sign-in.', true);
      await assertPolicy(actor, action, url, null, args);
      const tab = makeTab(actor); tabs.set(tab.tabId, tab);
      const agentSessionEpoch = humanSessionEpoch;
      if (actor.isHuman) { humanSessionEpoch++; humanActionsPending++; }
      try { await attach(tab, await runtime.context.newPage()); tab.activeActor = actor; if (actor.isHuman && url !== 'about:blank') markHumanOrigin(new URL(url).origin); if (url !== 'about:blank') await tab.page.goto(url, { waitUntil: 'domcontentloaded' }); if (actor.isHuman) markHumanDocument(tab); }
      catch (failure) { await tab.page?.close().catch(() => {}); tabs.delete(tab.tabId); throw failure; }
      finally { tab.activeActor = null; if (actor.isHuman) humanActionsPending--; }
      if (actor.isHuman) await observeHumanSessions();
      else { await recordAgentSessions(url, agentSessionEpoch); await observeHumanSessions(); }
      await assertPolicy(actor, action, requirePage(tab).url(), tab, args);
      publish(tab); await persist(); return { ok: true, action, runtime: runtimeInfo(), tab: descriptor(tab) };
    }
    const tab = ownedTab(actor, args.tabId);
    if (action === 'recover') {
      if (!actor.isHuman) throw error('BROWSER_HUMAN_REQUIRED', 'Recover disconnected pages from Browser settings.');
      await ensureRuntime();
      tab.activeActor = actor;
      try { if (!tab.page) { tab.controllerEpoch++; invalidate(tab); await attach(tab, await runtime.context.newPage()); if (tab.url !== 'about:blank') { markHumanOrigin(new URL(tab.url).origin); await guard.resolve(tab.url); await tab.page.goto(tab.url, { waitUntil: 'domcontentloaded' }); } } }
      finally { tab.activeActor = null; }
      tab.status = 'ready'; tab.controller = { owner: 'human', clientId: actor.clientId }; markHumanDocument(tab); await observeHumanSessions(); publish(tab); return { ok: true, action, tab: descriptor(tab), runtime: runtimeInfo(), recovery: 'Page reloaded. Previous uncertain actions were not replayed.' };
    }
    if (action === 'control') {
      if (!actor.isHuman) throw error('BROWSER_HUMAN_REQUIRED', 'Only the user can transfer browser control.');
      epochs(tab, args);
      tab.controllerEpoch++; tab.controller = args.owner === 'agent' ? { owner: 'agent' } : { owner: 'human', clientId: actor.clientId };
      if (tab.controller.owner === 'human') markHumanDocument(tab);
      credentialBroker?.invalidateTab?.(tab.tabId);
      // Invalidate queued agent input immediately, then drain before confirming the transfer.
      await tab.queue.catch(() => {}); await releaseInput(tab);
      if (selectedAdapter()?.control) await selectedAdapter().control({ targetId: tab.nativeTargetId, human: tab.controller.owner === 'human' });
      publish(tab); return { ok: true, action, tab: descriptor(tab), runtime: runtimeInfo() };
    }
    const mutating = MUTATIONS.has(action);
    epochs(tab, args, mutating);
    if (mutating) assertController(actor, tab);
    const queuedControlEpoch = tab.controllerEpoch;
    return enqueue(tab, async () => {
      epochs(tab, args, mutating);
      if (mutating) assertController(actor, tab);
      if (resetting || resetFailed) throw error('BROWSER_RESET_REQUIRED', 'Browser cleanup invalidated the pending action.');
      await assertPolicy(actor, action, action === 'close' ? tab.page?.url?.() ?? tab.url : requirePage(tab).url(), tab, args);
      if (action === 'press') assertAgentKey(actor, args.key);
      await assertInputIntent(actor, action, tab, args);
      if (!actor.isHuman && (signIn || handoffPending)) throw error('BROWSER_SIGN_IN_ACTIVE', 'The user owns the browser profile during sign-in.', true);
      epochs(tab, args, mutating);
      if (mutating) assertController(actor, tab);
      tab.activeActor = actor;
      const agentSessionEpoch = humanSessionEpoch;
      if (actor.isHuman) { humanSessionEpoch++; humanActionsPending++; }
      if (actor.isHuman && mutating && action !== 'close') markHumanDocument(tab);
      try {
        const value = await operate(actor, action, tab, args);
        if (actor.isHuman) { if (mutating && action !== 'close') markHumanDocument(tab); await observeHumanSessions(); }
        else if (action !== 'close') { await recordAgentSessions(requirePage(tab).url(), agentSessionEpoch); await observeHumanSessions(); }
        if (mutating && action !== 'close' && queuedControlEpoch !== tab.controllerEpoch) throw error('BROWSER_ACTION_UNCERTAIN', 'Control changed during the action. Observe the current page before deciding what to do next.', true);
        if (action !== 'close') await assertPolicy(actor, action, requirePage(tab).url(), tab, args);
        if (value.capture) emit('owned_browser_capture', { capture: value.capture });
        publish(tab); return { ok: true, action, runtime: runtimeInfo(), tab: descriptor(tab), ...value };
      } catch (failure) {
        if (failure instanceof OwnedBrowserError || failure.code?.startsWith('BROWSER_')) throw failure;
        throw error(failure.name === 'TimeoutError' ? 'BROWSER_ACTION_TIMEOUT' : 'BROWSER_ACTION_FAILED', 'The browser action did not complete. Observe the current page before retrying.', true);
      } finally { tab.activeActor = null; if (actor.isHuman) humanActionsPending--; }
    });
  };
  return {
    request, inventory,
    async restore() {
      try { const config = JSON.parse(await fs.readFile(path.join(dataDir, 'browser', 'runtime.json'), 'utf8')); if (config.version === 1 && ['managed', 'native'].includes(config.mode) && (config.mode !== 'native' || nativeAdapter)) { runtimeMode = config.mode; headless = config.headless !== false; } } catch {}
      let stored; try { stored = JSON.parse(await fs.readFile(descriptorFile, 'utf8')); } catch { return; }
      if (stored?.version !== 1 || !Array.isArray(stored.tabs)) return;
      for (const origin of Array.isArray(stored.humanStorageOrigins) ? stored.humanStorageOrigins.slice(0, 2048) : []) { try { const url = new URL(origin); if (['https:', 'http:'].includes(url.protocol) && url.origin === origin) { unconfirmedHumanOrigins.add(origin); humanOrigins.add(origin); } } catch {} }
      for (const record of stored.tabs.slice(0, limits.maxTabs)) {
        if (typeof record.tabId !== 'string' || !record.threadId || !record.agentId) continue;
        const tab = makeTab(record); Object.assign(tab, { tabId: record.tabId, nativeTargetId: record.nativeTargetId, url: publicURL(record.url), title: text(record.title, 500), status: 'disconnected', navigationEpoch: Number(record.navigationEpoch) || 0, controllerEpoch: (Number(record.controllerEpoch) || 0) + 1 }); tabs.set(tab.tabId, tab);
      }
    },
    async close() { if (closed) return; closed = true; if (starting) await starting.catch(() => {}); if (handoffPromise) await handoffPromise; clearInterval(checkpointTimer); for (const tab of tabs.values()) await releaseInput(tab); await persist().catch(() => {}); await saveCheckpoint().catch(() => {}); await signIn?.close(); await runtime?.close(); await nativeAdapter?.dispose?.(); state = 'closed'; },
  };
}
