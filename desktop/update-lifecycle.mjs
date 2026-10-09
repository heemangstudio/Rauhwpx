// The application approves document closure and stops its services before an
// installer can take over. electron-updater owns the final platform handoff.
export function createUpdateLifecycle({
  app, updater, nativeUpdater, platform, showMessageBox, openReleases,
  cleanup, onQuitRequested, onTeardown, isInteractive = () => false, logger = console,
}) {
  let downloaded = null;
  let prompt = null;
  let installRequested = false;
  let handoffStarted = false;
  let updaterQuitting = false;
  let teardown = null;
  let failureDialog = null;
  const reportedErrors = new WeakSet();

  function cancelQuit() {
    installRequested = false;
    onQuitRequested(false);
  }

  async function reportError(error) {
    logger.warn('[hamaeditor] update failed:', error?.message ?? error);
    if (error && typeof error === 'object') {
      if (reportedErrors.has(error)) return;
      reportedErrors.add(error);
    }
    if (failureDialog) return failureDialog;
    const failedInstall = handoffStarted;
    if (!failedInstall && installRequested) cancelQuit();
    failureDialog = (async () => {
      try {
        const { response } = await showMessageBox({
          type: 'warning',
          message: failedInstall ? 'Hamaeditor could not install the update' : 'Hamaeditor could not update',
          detail: `${error?.message ?? String(error)}${failedInstall ? '\nRestart Hamaeditor to try again, or download the latest release.' : '\nChoose Check for Updates to try again.'}`,
          buttons: ['Open releases page', failedInstall ? 'Quit' : 'OK'],
          defaultId: 1,
          cancelId: 1,
        });
        if (response === 0) await openReleases();
      } catch (dialogError) {
        logger.warn('[hamaeditor] update error dialog failed:', dialogError);
      } finally {
        // Services have stopped and MacUpdater may retain a native staging
        // listener after an error. Retry in a fresh process, never a second
        // quitAndInstall call against that listener.
        if (failedInstall) app.exit(1);
        failureDialog = null;
      }
    })();
    return failureDialog;
  }

  function offerInstall() {
    if (!downloaded || installRequested || teardown || failureDialog) return Promise.resolve(false);
    if (prompt) return prompt;
    prompt = (async () => {
      try {
        const { response } = await showMessageBox({
          type: 'info',
          message: `Hamaeditor ${downloaded.version ?? ''} is ready to install`,
          detail: platform === 'win32'
            ? 'Your documents will close before the installer opens. Windows may ask you to confirm the installer. Choose Check for Updates to install later.'
            : 'Hamaeditor will restart after your documents close. Choose Check for Updates to install later.',
          buttons: [platform === 'win32' ? 'Install now' : 'Restart to install', 'Later'],
          defaultId: 1,
          cancelId: 1,
        });
        if (response !== 0 || teardown) return false;
        installRequested = true;
        app.quit();
        return true;
      } catch (error) {
        await reportError(error);
        return false;
      } finally {
        prompt = null;
      }
    })();
    return prompt;
  }

  function configureUpdates() {
    // A plain quit must never start a competing installer before our guards.
    updater.autoInstallOnAppQuit = false;
    updater.on('error', (error) => {
      if (handoffStarted || installRequested || isInteractive()) void reportError(error);
      else logger.warn('[hamaeditor] background update failed:', error?.message ?? error);
    });
    updater.on('update-downloaded', (info) => {
      const alreadyDownloaded = downloaded !== null && downloaded.version === info?.version;
      downloaded = info ?? {};
      if (!alreadyDownloaded) void offerInstall();
    });
  }

  async function finishQuit() {
    try {
      await cleanup();
    } catch (error) {
      logger.warn('[hamaeditor] quit cleanup failed:', error);
    }
    if (!installRequested) {
      app.exit(0);
      return;
    }
    handoffStarted = true;
    try {
      // On macOS this waits for Squirrel staging and invokes the native
      // quitAndInstall. Plain app.quit() cannot perform that handoff.
      await updater.quitAndInstall(false, true);
    } catch (error) {
      await reportError(error);
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

  return { start, configureUpdates, cancelQuit, offerInstall, reportError, hasDownloadedUpdate: () => downloaded !== null };
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
