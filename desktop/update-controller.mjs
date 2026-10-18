import { EventEmitter } from 'node:events';

// The app checks for updates by itself and downloads only when the user asks.
// Every change is broadcast to all windows as one state object; there are no
// native update dialogs.
export const UPDATE_LAUNCH_CHECK_DELAY_MS = 4000;
export const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000;

const BUSY = new Set(['downloading', 'downloaded', 'restarting']);
const MAX_RUNNING_CHATS = 1000;

function errorMessage(error) {
  return String(error?.message ?? error ?? 'Unknown error');
}

/**
 * mode: 'in-app' installs through `updater` (electron-updater or the dev fake),
 * 'external' (Debian) checks with `checkExternal` and opens the download page,
 * 'disabled' never checks.
 */
export function createUpdateController({
  currentVersion,
  mode,
  updater = null,
  checkExternal = async () => null,
  openExternal = async () => {},
  broadcast = () => {},
  restartApp = async () => false,
  logger = console,
}) {
  const install = mode === 'external' ? 'external' : 'in-app';
  let state = Object.freeze({
    status: mode === 'disabled' ? 'disabled' : 'idle',
    currentVersion,
    version: null,
    percent: null,
    install,
    error: null,
    manual: false,
    runningChats: 0,
  });
  const runningChats = new Map();
  let checkPromise = null;
  let checkIsManual = false;
  let updaterHasInfo = false;
  let externalUrl = null;
  let notAppliedVersion = null;
  let restartPromise = null;

  function set(patch) {
    state = Object.freeze({ ...state, ...patch });
    try {
      broadcast(state);
    } catch (error) {
      logger.warn('[hamaeditor] update state broadcast failed:', error);
    }
    return state;
  }

  function available(version) {
    // A relaunch that did not apply this version keeps saying so until the user retries.
    const error = notAppliedVersion && notAppliedVersion === version
      ? { context: 'install', message: 'The update was not applied.' }
      : null;
    return { status: 'available', version, percent: null, error };
  }

  if (updater) {
    updater.on('update-available', (info) => {
      updaterHasInfo = true;
      if (BUSY.has(state.status)) return;
      set({ ...available(String(info?.version ?? '')), manual: checkIsManual });
    });
    updater.on('update-not-available', () => {
      if (BUSY.has(state.status)) return;
      set({ status: 'up-to-date', version: null, percent: null, error: null, manual: checkIsManual });
    });
    updater.on('download-progress', (progress) => {
      if (state.status !== 'downloading') return;
      const percent = Math.max(0, Math.min(100, Math.floor(Number(progress?.percent) || 0)));
      if (percent !== state.percent) set({ percent });
    });
    updater.on('update-downloaded', (info) => {
      if (state.status === 'restarting') return;
      set({ status: 'downloaded', version: String(info?.version ?? state.version ?? ''), percent: null, error: null });
    });
    // macOS reports a failed Squirrel staging only through this event.
    updater.on('error', (error) => {
      if (state.status !== 'downloading') return;
      set({ status: 'error', percent: null, error: { context: 'download', message: errorMessage(error) } });
    });
  }

  async function runCheck() {
    if (mode === 'external') {
      const release = await checkExternal();
      if (BUSY.has(state.status)) return;
      if (release) {
        externalUrl = release.url;
        set({ ...available(release.version), manual: checkIsManual });
      } else {
        set({ status: 'up-to-date', version: null, percent: null, error: null, manual: checkIsManual });
      }
      return;
    }
    await updater.checkForUpdates();
  }

  function check({ manual = false } = {}) {
    if (state.status === 'disabled') return Promise.resolve(state);
    if (BUSY.has(state.status)) {
      // A downloaded update is already waiting on the user's restart.
      if (manual) set({ manual: true });
      return Promise.resolve(state);
    }
    if (checkPromise) {
      if (manual && !checkIsManual) {
        checkIsManual = true;
        set({ status: 'checking', manual: true, error: null });
      }
      return checkPromise;
    }
    checkIsManual = manual;
    const before = state;
    // A background check keeps the current sign up until the result arrives.
    if (manual) set({ status: 'checking', manual: true, error: null });
    checkPromise = (async () => {
      try {
        await runCheck();
        // An inactive updater resolves without an event.
        if (state.status === 'checking') {
          set({ status: 'up-to-date', version: null, percent: null, error: null });
        }
      } catch (error) {
        logger.warn('[hamaeditor] update check failed:', errorMessage(error));
        if (BUSY.has(state.status)) return;
        if (checkIsManual) {
          set({ status: 'idle', version: null, percent: null, manual: true,
            error: { context: 'check', message: errorMessage(error) } });
        } else if (state.status !== before.status) {
          set({ status: before.status, version: before.version, error: before.error });
        }
      } finally {
        checkPromise = null;
        checkIsManual = false;
      }
    })();
    return checkPromise.then(() => state);
  }

  async function download() {
    if (state.status !== 'available' && !(state.status === 'error' && state.error?.context === 'download')) {
      return state;
    }
    if (mode === 'external') {
      if (externalUrl) await openExternal(externalUrl);
      return state;
    }
    const version = state.version;
    set({ status: 'downloading', percent: 0, error: null, manual: false });
    try {
      // A relaunch that did not apply the update has no update info yet.
      if (!updaterHasInfo) await updater.checkForUpdates();
      if (state.status === 'downloading') await updater.downloadUpdate();
    } catch (error) {
      logger.warn('[hamaeditor] update download failed:', errorMessage(error));
      if (state.status === 'downloading') {
        set({ status: 'error', version, percent: null, error: { context: 'download', message: errorMessage(error) } });
      }
    }
    return state;
  }

  function restart() {
    if (restartPromise) return restartPromise;
    if (state.status !== 'downloaded') return Promise.resolve({ ok: false });
    set({ status: 'restarting', error: null });
    restartPromise = (async () => {
      let handedOff = false;
      let message = 'The restart did not start.';
      try {
        handedOff = await restartApp(state);
      } catch (error) {
        message = errorMessage(error);
        logger.warn('[hamaeditor] update restart failed:', message);
      }
      if (!handedOff) {
        // The downloaded update stays; the sign offers the restart again.
        set({ status: 'downloaded', error: { context: 'install', message } });
        restartPromise = null;
      }
      return { ok: handedOff };
    })();
    return restartPromise;
  }

  function setRunningChats(windowId, count) {
    const value = Number.isSafeInteger(count) ? Math.max(0, Math.min(MAX_RUNNING_CHATS, count)) : 0;
    if (value === 0) runningChats.delete(windowId);
    else runningChats.set(windowId, value);
    const total = [...runningChats.values()].reduce((sum, item) => sum + item, 0);
    if (total !== state.runningChats) set({ runningChats: total });
  }

  /** The previous process restarted to install `version`, but this process still runs the old one. */
  function markNotApplied(version) {
    if (state.status === 'disabled' || !version) return;
    notAppliedVersion = version;
    set({ ...available(version), manual: false });
  }

  function start({
    initialDelayMs = UPDATE_LAUNCH_CHECK_DELAY_MS,
    intervalMs = UPDATE_CHECK_INTERVAL_MS,
    setTimeoutImpl = setTimeout,
    setIntervalImpl = setInterval,
  } = {}) {
    if (state.status === 'disabled') return;
    const launch = setTimeoutImpl(() => {
      void check({ manual: false });
      const periodic = setIntervalImpl(() => { void check({ manual: false }); }, intervalMs);
      periodic?.unref?.();
    }, initialDelayMs);
    launch?.unref?.();
  }

  return {
    state: () => state,
    check,
    download,
    restart,
    setRunningChats,
    forgetRunningChats: (windowId) => setRunningChats(windowId, 0),
    markNotApplied,
    start,
  };
}

/**
 * Development stand-in for electron-updater (RHWP_FAKE_UPDATE). It offers
 * `version`, downloads it over about three seconds and never installs. After
 * a simulated restart (`applied`) it reports that the app is up to date.
 */
export function createFakeUpdater({
  version,
  applied = false,
  durationMs = 3000,
  setTimeoutImpl = setTimeout,
}) {
  const updater = new EventEmitter();
  const wait = (ms) => new Promise((resolve) => { setTimeoutImpl(resolve, ms); });
  let downloading = null;
  updater.checkForUpdates = async () => {
    await wait(400);
    if (applied) {
      updater.emit('update-not-available', { version });
      return { isUpdateAvailable: false };
    }
    updater.emit('update-available', { version });
    return { isUpdateAvailable: true };
  };
  updater.downloadUpdate = () => {
    downloading ??= (async () => {
      const steps = 20;
      for (let step = 1; step <= steps; step += 1) {
        await wait(durationMs / steps);
        updater.emit('download-progress', { percent: (step / steps) * 100 });
      }
      updater.emit('update-downloaded', { version });
      return [];
    })();
    return downloading;
  };
  return updater;
}
