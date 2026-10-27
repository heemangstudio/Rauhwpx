import { randomUUID } from 'node:crypto';
import { rename, rm, writeFile } from 'node:fs/promises';
import { isNewerStableVersion } from './update-policy.mjs';

const ACTIVE = new Set(['checking', 'updating', 'waiting', 'countdown', 'restarting']);
const message = (error) => String(error?.message ?? error);
const RETRYABLE_RENAME = new Set(['EPERM', 'EBUSY', 'EACCES']);

/**
 * Small progress JSON: a temp file plus rename is enough. The document-grade writer (ACL copy,
 * hard-link publish) costs several icacls spawns per write on Windows and is not needed here.
 * Windows rename can briefly fail while a scanner holds the target, so retry a few times.
 */
export async function writeUpdateAllState(file, state, {
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), attempts = 5,
} = {}) {
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(state), 'utf8');
  try {
    for (let attempt = 1; ; attempt++) {
      try { await rename(temp, file); return; }
      catch (error) {
        if (attempt >= attempts || !RETRYABLE_RENAME.has(error?.code)) throw error;
        await sleep(50 * attempt);
      }
    }
  } finally {
    await rm(temp, { force: true }).catch(() => {});
  }
}

/** One application-wide run. Installers retain ownership of downloads and process cleanup. */
export function createUpdateAllController({
  appState, checkApp, downloadApp, restartApp, providerStatus, installProvider,
  broadcast = () => {}, persist = async () => {},
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = Date.now, countdownMs = 5000,
}) {
  let state = { runId: null, phase: 'idle', items: [], restartAt: null };
  let running = null;
  let refreshing = null;
  let save = Promise.resolve();
  let published = null;
  let deferred = false;
  let disposed = false;

  function snapshot() {
    return structuredClone({ ...state, appPercent: appState()?.percent ?? null });
  }
  function publish() {
    const next = snapshot();
    // Waiting loops re-set the same phase every second; skip identical snapshots.
    const serialized = JSON.stringify(next);
    if (serialized === published) return;
    published = serialized;
    broadcast(next);
    // Serialize writes so a slow earlier snapshot cannot replace a newer result.
    save = save.catch(() => {}).then(() => persist(next));
    save.catch(() => {});
  }
  function set(patch) { state = { ...state, ...patch }; publish(); }
  function item(id, patch) {
    set({ items: state.items.map((entry) => entry.id === id ? { ...entry, ...patch } : entry) });
  }
  function mergeOffers(statuses) {
    const offers = [];
    const app = appState();
    if (app?.version && ['available', 'downloading', 'downloaded', 'error'].includes(app.status)) {
      offers.push({ id: 'app', fromVersion: app.currentVersion, targetVersion: app.version,
        status: app.install === 'external' ? 'manual' : 'available', message: null });
    }
    for (const id of ['claude', 'codex']) {
      const status = statuses?.[id];
      if (status?.installed && status.updateRequired && status.latestVersion) {
        offers.push({ id, fromVersion: status.version, targetVersion: status.latestVersion,
          status: 'available', message: null });
      }
    }
    const retained = state.items.filter((entry) => ['failed', 'done'].includes(entry.status)
      || entry.id === 'app' && entry.status === 'ready' && app?.status === 'downloaded').map((entry) => {
      const installed = statuses?.[entry.id];
      return entry.id !== 'app' && installed?.installed && installed.version
        && !isNewerStableVersion(entry.targetVersion, installed.version)
        ? { ...entry, status: 'done', installedVersion: installed.version, message: null } : entry;
    });
    set({ items: [...offers.map((offer) => retained.find((entry) => entry.id === offer.id
      && entry.targetVersion === offer.targetVersion) ?? offer),
    ...retained.filter((entry) => !offers.some((offer) => offer.id === entry.id))] });
  }
  function appChanged() {
    if (ACTIVE.has(state.phase) || state.phase === 'deferred') publish();
    else mergeOffers(lastProviders);
  }
  let lastProviders = null;
  function refresh() {
    if (refreshing) return refreshing;
    if (running) return Promise.resolve(snapshot());
    refreshing = (async () => {
      const result = await providerStatus();
      lastProviders = result.statuses;
      if (!running) mergeOffers(lastProviders);
      return snapshot();
    })().finally(() => { refreshing = null; });
    return refreshing;
  }

  async function finishRestart() {
    if (state.items.some((entry) => entry.status === 'failed')) {
      set({ phase: 'failed', restartAt: null });
      return;
    }
    if (deferred) { set({ phase: 'deferred', restartAt: null }); return; }
    // A turn may have started while the application was downloading.
    while (!disposed && (appState()?.runningChats > 0 || (await providerStatus()).busy)) {
      set({ phase: 'waiting', restartAt: null });
      await sleep(1000);
      if (deferred) { set({ phase: 'deferred', restartAt: null }); return; }
    }
    if (disposed) return;
    set({ phase: 'countdown', restartAt: now() + countdownMs });
    await sleep(countdownMs);
    if (deferred || disposed) { if (!disposed) set({ phase: 'deferred', restartAt: null }); return; }
    // Recheck after the countdown rather than interrupting a newly started turn.
    if (appState()?.runningChats > 0 || (await providerStatus()).busy) return finishRestart();
    set({ phase: 'restarting', restartAt: null });
    // A lost write must not block the restart; the relaunch rebuilds the state from versions.
    await save.catch(() => {});
    const result = await restartApp();
    if (!result?.ok) {
      item('app', { status: 'failed', message: '재시작이 취소되었거나 시작하지 못했습니다.' });
      set({ phase: 'failed' });
    }
  }

  function start() {
    if (running) return running;
    deferred = false;
    const retryIds = state.phase === 'failed' && state.items.some((entry) => entry.status === 'failed')
      ? new Set(state.items.filter((entry) => entry.status === 'failed').map((entry) => entry.id)) : null;
    running = (async () => {
      if (state.phase === 'deferred' && appState()?.status === 'downloaded') {
        await finishRestart();
        return snapshot();
      }
      set({ phase: 'checking', error: null });
      await checkApp();
      const result = await providerStatus();
      lastProviders = result.statuses;
      mergeOffers(lastProviders);
      const targets = state.items.filter((entry) => ['available', 'failed'].includes(entry.status)
        && (!retryIds || retryIds.has(entry.id)));
      set({ runId: randomUUID(), phase: 'updating', restartAt: null,
        items: state.items.map((entry) => targets.includes(entry) ? { ...entry, status: 'queued', message: null } : entry) });
      const appTarget = targets.find((entry) => entry.id === 'app');
      const appDownload = (async () => {
        if (!appTarget) return;
        item('app', { status: 'running' });
        try {
          if (appState()?.status !== 'downloaded') await downloadApp();
          while (!disposed && appState()?.status === 'downloading') await sleep(1000);
          if (disposed) return;
          if (appState()?.status !== 'downloaded') throw new Error(appState()?.error?.message ?? '앱을 내려받지 못했습니다.');
          item('app', { status: 'ready' });
        } catch (error) { item('app', { status: 'failed', message: message(error) }); }
      })();
      for (const target of targets.filter((entry) => entry.id !== 'app')) {
        try {
          while (!disposed && (await providerStatus()).busy) {
            item(target.id, { status: 'waiting' });
            set({ phase: 'waiting' });
            await sleep(1000);
          }
          if (disposed) return snapshot();
          set({ phase: 'updating' });
          item(target.id, { status: 'running' });
          let installed;
          for (;;) {
            try { installed = await installProvider(target.id); break; }
            catch (error) {
              if (error.status !== 409) throw error;
              item(target.id, { status: 'waiting' });
              set({ phase: 'waiting' });
              await sleep(1000);
              if (disposed) return snapshot();
              set({ phase: 'updating' });
              item(target.id, { status: 'running' });
            }
          }
          const status = installed.statuses?.[target.id];
          if (!status?.installed || !status.version || status.updateRequired
            || isNewerStableVersion(target.targetVersion, status.version)) {
            throw new Error('설치된 버전을 확인하지 못했습니다.');
          }
          item(target.id, { status: 'done', installedVersion: status.version, message: null });
        } catch (error) { item(target.id, { status: 'failed', message: message(error) }); }
      }
      await appDownload;
      if (state.items.some((entry) => entry.id === 'app' && entry.status === 'ready')) await finishRestart();
      else set({ phase: state.items.some((entry) => entry.status === 'failed') ? 'failed' : 'complete' });
      return snapshot();
    })().catch((error) => {
      set({ phase: 'failed', error: message(error), restartAt: null });
      return snapshot();
    }).finally(() => { running = null; });
    return running;
  }
  return {
    state: snapshot, refresh, start, appChanged,
    later() { deferred = true; if (state.phase === 'countdown') set({ phase: 'deferred', restartAt: null }); },
    restore(saved) {
      if (!saved || !Array.isArray(saved.items)) return;
      // A saved 'done' was already shown in the launch that finished it; reshowing it every launch
      // flashes a stale completion sign. The app item becomes 'done' only in the launch that applied it.
      state = { runId: saved.runId ?? null, phase: 'complete', restartAt: null,
        items: saved.items.filter((entry) => ['app', 'claude', 'codex'].includes(entry.id)
          && entry.status !== 'done').map((entry) => {
          if (entry.id === 'app' && entry.targetVersion && !isNewerStableVersion(entry.targetVersion, appState().currentVersion)) {
            return { ...entry, status: 'done', installedVersion: appState().currentVersion, message: null };
          }
          if (['queued', 'running', 'ready', 'waiting'].includes(entry.status) || saved.phase === 'restarting' && entry.id === 'app') {
            return { ...entry, status: 'failed', message: '업데이트가 중단되었습니다. 다시 시도해 주세요.' };
          }
          return entry;
        }) };
      if (state.items.some((entry) => entry.status === 'failed')) state.phase = 'failed';
      publish();
    },
    dispose() { disposed = true; deferred = true; },
  };
}
