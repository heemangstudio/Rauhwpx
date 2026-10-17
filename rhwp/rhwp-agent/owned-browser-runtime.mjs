import { promises as fs, constants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { createBrowserNetworkProxy } from './owned-browser-network.mjs';
import { processTreeSpawnOptions, terminateAndWaitForProcessTreeExit } from './process-tree.mjs';

export class OwnedBrowserError extends Error {
  constructor(code, message, retryable = false) { super(message); this.name = 'OwnedBrowserError'; this.code = code; this.retryable = retryable; }
}

export const browserProcessEnv = () => Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|HOME|USERPROFILE|TMPDIR|TEMP|TMP|SystemRoot|WINDIR|DISPLAY|WAYLAND_DISPLAY|XDG_RUNTIME_DIR|LANG|LC_.*|DBUS_SESSION_BUS_ADDRESS|PLAYWRIGHT_BROWSERS_PATH)$/.test(key)));

const execFileAsync = promisify(execFile);
const CHROME_REQUIREMENT = '=identifier "com.google.Chrome" and anchor apple generic and certificate leaf[subject.OU] = "EQHXZ8M8AV"';

export async function inspectMacPasskeyBrowser({ platform = process.platform,
  locations = ['/Applications/Google Chrome.app', path.join(homedir(), 'Applications', 'Google Chrome.app')], runFile = execFileAsync } = {}) {
  const base = { method: 'mac-passkey', provider: 'Google Chrome', requiresUserVerification: true };
  if (platform !== 'darwin') return { ...base, supported: false, reason: 'macos-required' };
  try {
    const { stdout } = await runFile('/usr/bin/sw_vers', ['-productVersion'], { timeout: 5000 });
    const [major, minor] = stdout.trim().split('.').map(Number);
    if (!Number.isInteger(major) || major < 13 || (major === 13 && minor < 5)) return { ...base, supported: false, reason: 'macos-13.5-required' };
  } catch { return { ...base, supported: false, reason: 'macos-version-unavailable' }; }
  for (const bundle of locations) {
    const executablePath = path.join(bundle, 'Contents', 'MacOS', 'Google Chrome');
    try {
      await fs.access(executablePath, constants.X_OK);
      await runFile('/usr/bin/codesign', ['--verify', '--strict', '-R', CHROME_REQUIREMENT, bundle], { timeout: 10_000, maxBuffer: 1024 * 1024 });
      const { stdout } = await runFile('/usr/bin/codesign', ['-d', '--entitlements', ':-', executablePath], { timeout: 5000, maxBuffer: 1024 * 1024 });
      if (!/<key>com\.apple\.developer\.web-browser\.public-key-credential<\/key>\s*<true\s*\/>/.test(stdout)) continue;
      return { ...base, supported: true, executablePath };
    } catch {}
  }
  return { ...base, supported: false, reason: 'signed-chrome-required' };
}

export function macPasskeyCapability(inspection) {
  const { executablePath: _privatePath, ...capability } = inspection;
  return capability;
}

let passkeyCapabilityPromise;
let passkeyCapabilityExpiresAt = 0;
export async function inspectMacPasskeyCapability({ fresh = false } = {}) {
  // 상태 조회는 동시에 하나만 확인한다. 실제 실행 경로는 별도로 서명을 다시 검증한다.
  if (fresh || !passkeyCapabilityPromise || Date.now() >= passkeyCapabilityExpiresAt) {
    passkeyCapabilityExpiresAt = Date.now() + 15_000;
    passkeyCapabilityPromise = inspectMacPasskeyBrowser().then(macPasskeyCapability);
  }
  return { ...await passkeyCapabilityPromise };
}

async function managedProvider(dataDir) {
  try {
    const file = path.join(dataDir, 'browser', 'managed-provider.json');
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024) throw new Error('Invalid provider file');
    const value = JSON.parse(await fs.readFile(file, 'utf8'));
    if (value.version !== 1 || !['chromium', 'chrome'].includes(value.provider)) throw new Error('Invalid provider');
    return value.provider;
  } catch (failure) {
    if (failure.code === 'ENOENT') return 'chromium';
    throw new OwnedBrowserError('BROWSER_PROFILE_SETTINGS_INVALID', 'The owned browser provider settings cannot be read. Recover the profile before starting the browser.');
  }
}

async function saveManagedProvider(dataDir, provider) {
  const file = path.join(dataDir, 'browser', 'managed-provider.json');
  const temp = `${file}.${randomUUID()}.part`;
  try {
    await fs.writeFile(temp, JSON.stringify({ version: 1, provider }), { mode: 0o600, flag: 'wx' });
    await fs.rename(temp, file);
  } finally { await fs.rm(temp, { force: true }); }
}

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

export async function inspectOwnedBrowserRuntime({ dataDir, freshPasskeys = false } = {}) {
  configureBrowserCache(dataDir);
  const passkeys = await inspectMacPasskeyCapability({ fresh: freshPasskeys });
  try {
    if (dataDir && await managedProvider(dataDir) === 'chrome') {
      return passkeys.supported ? { state: 'ready', installed: true, message: 'Google Chrome is ready.', passkeys }
        : { state: 'not-installed', installed: false, code: 'BROWSER_MAC_PASSKEY_UNAVAILABLE', message: 'Install signed Google Chrome to reopen the Mac passkey browser profile.', retryAction: 'install-chrome', passkeys };
    }
    const { chromium } = await playwrightModule();
    await fs.access(chromium.executablePath(), constants.X_OK);
    return { state: 'ready', installed: true, message: 'Chromium is ready.', passkeys };
  } catch (error) {
    return { state: 'not-installed', installed: false, code: error.code ?? 'BROWSER_NOT_INSTALLED', message: error.code === 'BROWSER_DEPENDENCY_MISSING' ? error.message : 'Install the managed Chromium browser to start browsing.', retryAction: 'install', passkeys };
  }
}

/** Uses the locked Playwright package's matching browser revision. No shell or global npx. */
export async function installOwnedBrowserRuntime({ dataDir, onProgress = () => {}, timeoutMs = 180_000 } = {}) {
  configureBrowserCache(dataDir);
  if (dataDir && await managedProvider(dataDir) === 'chrome') {
    const readiness = await inspectOwnedBrowserRuntime({ dataDir, freshPasskeys: true });
    if (!readiness.installed) throw new OwnedBrowserError('BROWSER_MAC_PASSKEY_UNAVAILABLE', readiness.message, true);
    return readiness;
  }
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
export async function startOwnedBrowserSignIn({ dataDir, url, onExit = () => {}, autoInstall = true, spawnProcess = spawn,
  authenticationMethod = 'website', inspectPasskeyBrowser = inspectMacPasskeyBrowser } = {}) {
  configureBrowserCache(dataDir);
  if (!['website', 'mac-passkey'].includes(authenticationMethod)) throw new OwnedBrowserError('BROWSER_SIGN_IN_METHOD_INVALID', 'Choose a supported website sign-in method.');
  let provider = await managedProvider(dataDir);
  if (authenticationMethod === 'mac-passkey') provider = 'chrome';
  let executablePath;
  if (provider === 'chrome') {
    const passkeys = await inspectPasskeyBrowser();
    if (!passkeys.supported) throw new OwnedBrowserError('BROWSER_MAC_PASSKEY_UNAVAILABLE', 'Mac passkeys require macOS 13.5 or later and signed Google Chrome.', true);
    executablePath = passkeys.executablePath;
  } else {
    const readiness = await inspectOwnedBrowserRuntime({ dataDir });
    if (!readiness.installed) {
      if (!autoInstall) throw new OwnedBrowserError('BROWSER_NOT_INSTALLED', readiness.message, true);
      await installOwnedBrowserRuntime({ dataDir });
    }
    const { chromium } = await playwrightModule();
    executablePath = chromium.executablePath();
  }
  const profileDir = path.join(dataDir, 'browser', provider === 'chrome' ? 'chrome-profile' : 'profile');
  await fs.mkdir(profileDir, { recursive: true, mode: 0o700 });
  await fs.chmod(profileDir, 0o700);
  await disableProfilePasswordSaving(profileDir);
  const child = spawnProcess(executablePath, [
    `--user-data-dir=${profileDir}`, '--no-first-run', '--no-default-browser-check',
    ...(provider === 'chrome' ? [] : ['--password-store=basic', '--use-mock-keychain']),
    '--disable-save-password-bubble', '--disable-features=PasswordManagerOnboarding,PasswordLeakDetection,AutofillServerCommunication',
    '--new-window', url,
  ], { ...processTreeSpawnOptions(), shell: false, stdio: 'ignore', env: browserProcessEnv() });
  let exited = false;
  await new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', () => reject(new OwnedBrowserError('BROWSER_SIGN_IN_START_FAILED', 'The full browser could not open. Check the browser installation and desktop display.', true)));
  });
  child.once('exit', () => { exited = true; onExit(); });
  try { await saveManagedProvider(dataDir, provider); }
  catch (failure) { await terminateAndWaitForProcessTreeExit(child, { timeoutMs: 5000 }); throw failure; }
  return {
    mode: 'standalone-no-debug',
    authenticationMethod, provider,
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
  const provider = nativeAdapter ? null : await managedProvider(dataDir);
  const chrome = provider === 'chrome' ? await inspectMacPasskeyBrowser() : null;
  if (chrome && !chrome.supported) throw new OwnedBrowserError('BROWSER_MAC_PASSKEY_UNAVAILABLE', 'Install signed Google Chrome to reopen the Mac passkey browser profile.', true);
  const profileDir = path.join(browserDir, nativeAdapter ? 'native-profile' : provider === 'chrome' ? 'chrome-profile' : 'profile');
  const downloadsPath = path.join(browserDir, 'transfers');
  for (const dir of [browserDir, profileDir, downloadsPath]) { await fs.mkdir(dir, { recursive: true, mode: 0o700 }); await fs.chmod(dir, 0o700); }
  if (!nativeAdapter) await disableProfilePasswordSaving(profileDir);
  configureBrowserCache(dataDir);
  const { chromium } = await playwrightModule();
  if (!nativeAdapter && provider !== 'chrome') {
    const readiness = await inspectOwnedBrowserRuntime({ dataDir });
    if (!readiness.installed) {
      if (!autoInstall) throw new OwnedBrowserError('BROWSER_NOT_INSTALLED', readiness.message, true);
      await installOwnedBrowserRuntime({ dataDir, onProgress: onEvent });
    }
  }
  const proxy = await createBrowserNetworkProxy(guard);
  const launchManaged = (directory) => chromium.launchPersistentContext(directory, {
    ...(chrome ? { executablePath: chrome.executablePath, ignoreDefaultArgs: ['--use-mock-keychain', '--password-store=basic'] } : {}),
    headless, viewport, deviceScaleFactor: 1, acceptDownloads: true, downloadsPath,
    serviceWorkers: 'block', proxy: proxy.settings, chromiumSandbox: true,
    timeout: 30_000, env: browserProcessEnv(),
    args: ['--disable-quic', '--disable-save-password-bubble', '--disable-features=PasswordManagerOnboarding,PasswordLeakDetection,AutofillServerCommunication', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp', '--proxy-bypass-list=<-loopback>'],
  });
  let native;
  let context;
  let browser;
  let phase = nativeAdapter ? 'native-host' : 'managed-launch';
  try {
    if (nativeAdapter) {
      native = await nativeAdapter.start({ profileDir, downloadsPath, proxy: proxy.settings, onEvent });
      phase = 'native-cdp';
      browser = await chromium.connectOverCDP(native.endpointURL, { timeout: 20_000, noDefaults: true, artifactsDir: downloadsPath });
      context = browser.contexts()[0];
      if (!context) throw new OwnedBrowserError('BROWSER_NATIVE_UNAVAILABLE', 'The desktop browser did not provide a private session.', true);
    } else {
      context = await launchManaged(profileDir);
      browser = context.browser();
    }
    context.setDefaultTimeout(10_000);
    context.setDefaultNavigationTimeout(20_000);
    // 관리형 Chromium은 에이전트 탭을 사용자 로그인과 분리된 두 번째 프로필로 연다. 첫 에이전트 탭에서 시작한다.
    let agentContext;
    const openAgentContext = nativeAdapter ? undefined : () => agentContext ??= (async () => {
      const agentProfileDir = path.join(browserDir, provider === 'chrome' ? 'chrome-agent-profile' : 'agent-profile');
      await fs.mkdir(agentProfileDir, { recursive: true, mode: 0o700 }); await fs.chmod(agentProfileDir, 0o700);
      await disableProfilePasswordSaving(agentProfileDir);
      const opened = await launchManaged(agentProfileDir);
      opened.setDefaultTimeout(10_000);
      opened.setDefaultNavigationTimeout(20_000);
      return opened;
    })().catch((failure) => { agentContext = undefined; throw failure; });
    return { context, browser, profileDir, downloadsPath, nativeGeneration: native?.generation, kind: nativeAdapter ? 'native' : provider === 'chrome' ? 'chrome' : 'chromium', openAgentContext,
      async close() { if (nativeAdapter) await browser.close().catch(() => {}); else { await agentContext?.then((opened) => opened.close()).catch(() => {}); await context.close().catch(() => {}); } await native?.close?.(); await proxy.close(); } };
  } catch (error) {
    await context?.close().catch(() => {});
    await native?.close?.();
    await proxy.close();
    if (error instanceof OwnedBrowserError) throw error;
    if (nativeAdapter) {
      // CDP 연결 오류에는 비공개 endpoint 토큰이 들어갈 수 있으므로 원문을 기록하지 않는다.
      const reason = String(error?.message ?? error).split('\n')[0].replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s<>]+/gi, '[private endpoint]').slice(0, 400);
      const failure = new OwnedBrowserError('BROWSER_NATIVE_CONNECT_FAILED', 'The desktop browser could not reconnect. Retry its connection.', true);
      failure.details = { phase, reason };
      failure.cause = new Error(reason);
      console.error('[owned-browser-runtime] native startup failed', JSON.stringify(failure.details));
      throw failure;
    }
    throw new OwnedBrowserError('BROWSER_START_FAILED', 'The owned browser could not start. Close competing browser owners and retry.', true);
  }
}
