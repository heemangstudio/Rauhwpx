// The application approves document closure and stops its services before an
// installer can take over. electron-updater owns the final platform handoff.
export function createUpdateLifecycle({
  app, updater, nativeUpdater, platform, cleanup, onQuitRequested, onTeardown, logger = console,
}) {
  // null: plain quit. 'native': quitAndInstall. 'relaunch': the dev update seam restarts without installing.
  let install = null;
  let handoffStarted = false;
  let updaterQuitting = false;
  let teardown = null;
  let failed = false;

  function cancelQuit() {
    install = null;
    onQuitRequested(false);
  }

  // Services have stopped and MacUpdater may retain a native staging listener
  // after an error. Retry in a fresh process, never a second quitAndInstall call
  // against that listener. The relaunch restores the windows from the restart
  // manifest and offers the update again.
  function failAfterHandoff(error) {
    logger.warn('[hamaeditor] update install failed:', error?.message ?? error);
    if (failed) return;
    failed = true;
    app.relaunch();
    app.exit(1);
  }

  function configureUpdates() {
    // A plain quit must never start a competing installer before our guards.
    updater.autoInstallOnAppQuit = false;
    updater.autoDownload = false;
    updater.on('error', (error) => {
      if (handoffStarted) failAfterHandoff(error);
      else logger.warn('[hamaeditor] update failed:', error?.message ?? error);
    });
  }

  /** Quits through the normal teardown, then installs. Windows must already be allowed to close. */
  function requestInstall({ relaunchOnly = false } = {}) {
    if (teardown || install) return false;
    install = relaunchOnly ? 'relaunch' : 'native';
    app.quit();
    return true;
  }

  async function finishQuit() {
    try {
      await cleanup();
    } catch (error) {
      logger.warn('[hamaeditor] quit cleanup failed:', error);
    }
    if (!install) {
      app.exit(0);
      return;
    }
    if (install === 'relaunch') {
      app.relaunch();
      app.exit(0);
      return;
    }
    handoffStarted = true;
    try {
      // On macOS this waits for Squirrel staging and invokes the native
      // quitAndInstall. Plain app.quit() cannot perform that handoff.
      // Windows installs silently so an update never reopens the setup wizard.
      await updater.quitAndInstall(platform === 'win32', true);
    } catch (error) {
      failAfterHandoff(error);
    }
  }

  function start() {
    const allowUpdaterQuit = () => {
      if (handoffStarted) updaterQuitting = true;
    };
    nativeUpdater?.on('before-quit-for-update', allowUpdaterQuit);
    app.on('before-quit', (event) => {
      if (teardown && !updaterQuitting) {
        event.preventDefault();
        return;
      }
      onQuitRequested(true);
    });
    app.on('will-quit', (event) => {
      if (updaterQuitting) return;
      event.preventDefault();
      if (teardown) return;
      onTeardown();
      teardown = Promise.resolve().then(finishQuit);
    });
  }

  return { start, configureUpdates, cancelQuit, requestInstall };
}

// A renderer has approved Save/Discard. Bookmark writes must finish before
// this window can close or an update can install.
export async function completeWindowClose({ session, allowClose, cancelQuit, persistBookmarks, onError = () => {} }) {
  if (!allowClose) {
    cancelQuit();
    return false;
  }
  try {
    await persistBookmarks();
    session.allowCloseOnce = true;
    session.window.close();
    return true;
  } catch (error) {
    cancelQuit();
    await onError(error);
    return false;
  }
}
