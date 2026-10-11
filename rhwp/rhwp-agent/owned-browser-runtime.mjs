import { promises as fs, constants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createBrowserNetworkProxy } from './owned-browser-network.mjs';
import { processTreeSpawnOptions, terminateAndWaitForProcessTreeExit } from './process-tree.mjs';

export class OwnedBrowserError extends Error {
  constructor(code, message, retryable = false) { super(message); this.name = 'OwnedBrowserError'; this.code = code; this.retryable = retryable; }
}

export const browserProcessEnv = () => Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|HOME|USERPROFILE|TMPDIR|TEMP|TMP|SystemRoot|WINDIR|DISPLAY|WAYLAND_DISPLAY|XDG_RUNTIME_DIR|LANG|LC_.*|DBUS_SESSION_BUS_ADDRESS|PLAYWRIGHT_BROWSERS_PATH)$/.test(key)));

async function playwrightModule() {
  try { return await import('playwright'); }
  catch { throw new OwnedBrowserError('BROWSER_DEPENDENCY_MISSING', 'Install the application dependencies, then retry the browser.', true); }
}

function configureBrowserCache(dataDir) {
  // Explicit development/test caches remain supported; shipping owners use their own data directory.
  if (dataDir && !process.env.PLAYWRIGHT_BROWSERS_PATH) process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(dataDir, 'browser', 'binaries');
}

async function disableProfilePasswordSaving(profileDir) {
  const directory = path.join(profileDir, 'Default');
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, 'Preferences');
  let preferences = {};
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8 * 1024 * 1024) throw new Error('Invalid preference file');
    preferences = JSON.parse(await fs.readFile(file, 'utf8'));
    if (!preferences || typeof preferences !== 'object' || Array.isArray(preferences)) throw new Error('Invalid preferences');
  } catch (failure) {
    if (failure.code !== 'ENOENT') throw new OwnedBrowserError('BROWSER_PROFILE_SETTINGS_INVALID', 'The owned browser preferences cannot be read. Recover the profile before starting the browser.');
  }
  preferences.credentials_enable_service = false;
  preferences.credentials_enable_autosignin = false;
  preferences.profile = { ...preferences.profile, password_manager_enabled: false };
  const temp = `${file}.${process.pid}.part`;
  await fs.writeFile(temp, JSON.stringify(preferences), { mode: 0o600, flag: 'wx' });
  await fs.rename(temp, file);
}

export async function inspectOwnedBrowserRuntime({ dataDir } = {}) {
  configureBrowserCache(dataDir);
  try {
    const { chromium } = await playwrightModule();
    await fs.access(chromium.executablePath(), constants.X_OK);
    return { state: 'ready', installed: true, message: 'Chromium is ready.' };
  } catch (error) {
    return { state: 'not-installed', installed: false, code: error.code ?? 'BROWSER_NOT_INSTALLED', message: error.code === 'BROWSER_DEPENDENCY_MISSING' ? error.message : 'Install the managed Chromium browser to start browsing.', retryAction: 'install' };
  }
}

/** Uses the locked Playwright package's matching browser revision. No shell or global npx. */
export async function installOwnedBrowserRuntime({ dataDir, onProgress = () => {}, timeoutMs = 180_000 } = {}) {
  configureBrowserCache(dataDir);
  await playwrightModule();
  const cli = path.join(path.dirname(fileURLToPath(import.meta.resolve('playwright/package.json'))), 'cli.js');
  await new Promise((resolve, reject) => {
    const installEnv = browserProcessEnv();
    if (process.versions.electron) installEnv.ELECTRON_RUN_AS_NODE = '1';
    const child = spawn(process.execPath, [cli, 'install', 'chromium'], { shell: false, ...processTreeSpawnOptions(), stdio: ['ignore', 'pipe', 'pipe'], env: installEnv });
    let settled = false;
    const timer = setTimeout(() => { void terminateAndWaitForProcessTreeExit(child, { timeoutMs: 5000 }).then(() => finish(new OwnedBrowserError('BROWSER_INSTALL_TIMEOUT', 'Chromium installation timed out. Retry from Browser settings.', true))); }, timeoutMs);
    const finish = (error) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(); };
    // Package output is deliberately not forwarded: URLs and the host environment stay private.
    let received = 0;
    for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => { received += chunk.length; if (received < 1024 * 1024) onProgress({ state: 'installing', message: 'Downloading the managed Chromium browser.' }); });
    child.once('error', () => finish(new OwnedBrowserError('BROWSER_INSTALL_FAILED', 'Chromium installation could not start. Check application dependencies.', true)));
    child.once('close', (code) => finish(code === 0 ? null : new OwnedBrowserError('BROWSER_INSTALL_FAILED', 'Chromium installation failed. Check the network and available disk space, then retry.', true)));
  });
  return inspectOwnedBrowserRuntime({ dataDir });
}

/** A normal, unautomated browser process owns the profile until the user returns it. */
export async function startOwnedBrowserSignIn({ dataDir, url, onExit = () => {}, autoInstall = true, spawnProcess = spawn } = {}) {
  configureBrowserCache(dataDir);
  const readiness = await inspectOwnedBrowserRuntime({ dataDir });
  if (!readiness.installed) {
    if (!autoInstall) throw new OwnedBrowserError('BROWSER_NOT_INSTALLED', readiness.message, true);
    await installOwnedBrowserRuntime({ dataDir });
  }
  const { chromium } = await playwrightModule();
  const profileDir = path.join(dataDir, 'browser', 'profile');
  await fs.mkdir(profileDir, { recursive: true, mode: 0o700 });
  await fs.chmod(profileDir, 0o700);
  await disableProfilePasswordSaving(profileDir);
  const child = spawnProcess(chromium.executablePath(), [
    `--user-data-dir=${profileDir}`, '--no-first-run', '--no-default-browser-check',
    '--password-store=basic', '--use-mock-keychain',
    '--disable-save-password-bubble', '--disable-features=PasswordManagerOnboarding,PasswordLeakDetection,AutofillServerCommunication',
    '--new-window', url,
  ], { ...processTreeSpawnOptions(), shell: false, stdio: 'ignore', env: browserProcessEnv() });
  let exited = false;
  await new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', () => reject(new OwnedBrowserError('BROWSER_SIGN_IN_START_FAILED', 'The full browser could not open. Check the browser installation and desktop display.', true)));
  });
  child.once('exit', () => { exited = true; onExit(); });
  return {
    mode: 'standalone-no-debug',
    get exited() { return exited || child.exitCode !== null || child.signalCode !== null; },
    async close() {
      if (!exited && process.platform === 'darwin') {
        // Ask only this owned app PID to quit normally so Chromium flushes its profile.
        const quit = spawn('/usr/bin/osascript', ['-l', 'JavaScript', '-e', `ObjC.import('AppKit'); $.NSRunningApplication.runningApplicationWithProcessIdentifier(${child.pid}).terminate();`], { ...processTreeSpawnOptions(), shell: false, stdio: 'ignore', env: browserProcessEnv() });
        await new Promise((resolve) => { const timer = setTimeout(() => { quit.kill(); resolve(); }, 2000); quit.once('error', () => { clearTimeout(timer); resolve(); }); quit.once('exit', () => { clearTimeout(timer); resolve(); }); });
        if (!exited) await new Promise((resolve) => { const timer = setTimeout(resolve, 5000); child.once('exit', () => { clearTimeout(timer); resolve(); }); });
      }
      if (!exited && !await terminateAndWaitForProcessTreeExit(child, { timeoutMs: 5000 })) throw new OwnedBrowserError('BROWSER_SIGN_IN_CLOSE_FAILED', 'Close the sign-in browser before returning it to the app.', true);
      exited = true;
    },
  };
}

export async function startOwnedBrowserRuntime({ dataDir, guard, onEvent = () => {}, nativeAdapter, headless = true, viewport = { width: 1280, height: 800 }, autoInstall = true }) {
  const browserDir = path.join(dataDir, 'browser');
  const profileDir = path.join(browserDir, nativeAdapter ? 'native-profile' : 'profile');
  const downloadsPath = path.join(browserDir, 'transfers');
  for (const dir of [browserDir, profileDir, downloadsPath]) { await fs.mkdir(dir, { recursive: true, mode: 0o700 }); await fs.chmod(dir, 0o700); }
  if (!nativeAdapter) await disableProfilePasswordSaving(profileDir);
  configureBrowserCache(dataDir);
  const { chromium } = await playwrightModule();
  if (!nativeAdapter) {
    const readiness = await inspectOwnedBrowserRuntime({ dataDir });
    if (!readiness.installed) {
      if (!autoInstall) throw new OwnedBrowserError('BROWSER_NOT_INSTALLED', readiness.message, true);
      await installOwnedBrowserRuntime({ dataDir, onProgress: onEvent });
    }
  }
  const proxy = await createBrowserNetworkProxy(guard);
  let native;
  let context;
  let browser;
  try {
    if (nativeAdapter) {
      native = await nativeAdapter.start({ profileDir, downloadsPath, proxy: proxy.settings, onEvent });
      browser = await chromium.connectOverCDP(native.endpointURL, { timeout: 20_000 });
      context = browser.contexts()[0];
      if (!context) throw new OwnedBrowserError('BROWSER_NATIVE_UNAVAILABLE', 'The desktop browser did not provide a private session.', true);
    } else {
      context = await chromium.launchPersistentContext(profileDir, {
        headless, viewport, deviceScaleFactor: 1, acceptDownloads: true, downloadsPath,
        serviceWorkers: 'block', proxy: proxy.settings, chromiumSandbox: true,
        timeout: 30_000, env: browserProcessEnv(),
        args: ['--disable-quic', '--disable-save-password-bubble', '--disable-features=PasswordManagerOnboarding,PasswordLeakDetection,AutofillServerCommunication', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp', '--proxy-bypass-list=<-loopback>'],
      });
      browser = context.browser();
    }
    context.setDefaultTimeout(10_000);
    context.setDefaultNavigationTimeout(20_000);
    return { context, browser, profileDir, downloadsPath, kind: nativeAdapter ? 'native' : 'chromium', async close() { if (nativeAdapter) await browser.close().catch(() => {}); else await context.close().catch(() => {}); await native?.close?.(); await proxy.close(); } };
  } catch (error) {
    await context?.close().catch(() => {});
    await native?.close?.();
    await proxy.close();
    if (error instanceof OwnedBrowserError) throw error;
    throw new OwnedBrowserError('BROWSER_START_FAILED', 'The owned browser could not start. Close competing browser owners and retry.', true);
  }
}
