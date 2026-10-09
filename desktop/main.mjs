import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { basename, dirname, extname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  app,
  autoUpdater as nativeAutoUpdater,
  BrowserWindow,
  Menu,
  dialog,
  ipcMain,
  nativeTheme,
  net,
  Notification as ElectronNotification,
  protocol,
  safeStorage,
  screen,
  session as electronSession,
  shell,
} from 'electron';
import electronUpdater from 'electron-updater';
import {
  closeHubSession,
  createHubToken,
  isHubHealthy,
  nextHubRestartDelay,
  packagedRhwpBinary,
  registerHubSession,
  requestHubShutdown,
  resolveHubLaunch,
  spawnHubProcess,
  stopHubChild,
  waitForHub,
  waitForHubReadyLine,
} from './agent-hub.mjs';
import { DocumentLeaseManager, releaseRendererDocuments } from './document-leases.mjs';
import { quarantineBookmarkState, readBookmarkState } from './bookmark-state.mjs';
import {
  MAX_GENERATED_DOCUMENT_BYTES,
  readGeneratedDocumentResponse,
  resolveGeneratedDocumentArtifact,
} from './generated-document-artifact.mjs';
import { launchRequest } from './launch-routing.mjs';
import {
  NativeFileHandleRegistry,
  StaleNativeHandleError,
  validateNativeDocumentBytes,
  writeNativeFileAtomically,
} from './native-file-handles.mjs';
import { SerializedStateWriter } from './serialized-state-writer.mjs';
import { SessionManager } from './session-manager.mjs';
import { safeSuggestedFilename } from './safe-filename.mjs';
import { installPdfExport, PDF_EXPORT_FRAME_NAME, pdfExportWindowOptions } from './pdf-export.mjs';
import {
  STUDIO_HOST,
  STUDIO_SCHEME,
  STUDIO_URL,
  installStudioProtocol,
  registerStudioScheme,
  resolveDevelopmentUrl,
} from './studio-protocol.mjs';
import { INTERNAL_APP_NAME, PRODUCT_NAME } from './app-identity.mjs';
import { resolveProfileDirectories } from './profile-continuity.mjs';
import { createRebrandImportController } from './rebrand-import-controller.mjs';
import { createSecretVault, handleSecretRequest } from './secret-vault.mjs';
import { removeRetiredCloudData } from './retired-cloud-data.mjs';
import { isNewerStableVersion, selectDebAsset } from './update-policy.mjs';
import { createUpdateLifecycle, completeWindowClose } from './update-lifecycle.mjs';
import { installAppMenu } from './app-menu.mjs';
import {
  AgentAttention,
  WindowFrameStore,
  applyDocumentState,
  installTextContextMenu,
  popupContextMenu,
  showUnsavedChangesSheet,
} from './native-shell.mjs';
import {
  hasPendingLaunchCleanupSync,
  retainLaunchRootForProcessCleanupSync,
} from '../rhwp/rhwp-agent/credential-mirror.mjs';
import {
  REBRANDED_LAUNCH_MARKERS,
  launchStoragePaths,
  prepareDevelopmentCaches,
  rebrandedRuntimeRoots,
  removeLegacyLaunchDirectories,
  removeStaleLaunchDirectories,
  writeLaunchOwnerMetadata,
} from './runtime-cleanup.mjs';
import { reportUniqueInstall, uniqueInstallsPublicUrl } from './unique-install.mjs';
import { createSystemFontService } from './system-fonts.mjs';
import {
  nativeExtractorFileName,
  sourceStagedNativeExtractorPath,
} from './native-rhwp-path.mjs';

const { autoUpdater } = electronUpdater;
const __dirname = fileURLToPath(new URL('.', import.meta.url));
const RELEASES_URL = 'https://github.com/heemangstudio/Rauhwpx/releases/latest';
const RELEASES_API_URL = 'https://api.github.com/repos/heemangstudio/Rauhwpx/releases/latest';
const PRELOAD_PATH = join(__dirname, 'preload.cjs');
const REBRAND_EXPORT_PRELOAD_PATH = join(__dirname, 'rebrand-export-preload.cjs');
const devUrl = resolveDevelopmentUrl({
  packaged: app.isPackaged,
  rawUrl: process.env.RHWP_DEV_URL,
});
const launchId = randomUUID();
const hubToken = createHubToken();
const devOrigin = devUrl ? new URL(devUrl).origin : null;

// A hub that dies at every boot stops respawning here; the next window or
// sidebar request tries again.
const MAX_HUB_AUTO_RESTARTS = 5;
// A live hub that misses the short health probe gets one longer probe first.
const HUB_BUSY_HEALTH_TIMEOUT_MS = 2500;
// Vite gives every hot update a new timestamped URL. Reusing Electron's
// persistent HTTP cache across dev runs otherwise leaves one JS/WASM entry per
// edit and per worktree in the production profile.
if (devUrl) app.commandLine.appendSwitch('disable-http-cache');

function isTrustedRendererUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (devOrigin) return url.origin === devOrigin;
    return url.protocol === `${STUDIO_SCHEME}:` && url.host === STUDIO_HOST;
  } catch {
    return false;
  }
}

function sessionForEvent(event) {
  const senderUrl = event.senderFrame?.url || event.sender.getURL();
  if (!isTrustedRendererUrl(senderUrl)) throw new Error('Untrusted renderer IPC sender');
  return sessions.sessionForSender(event.sender);
}

// Electron 은 앱 이름으로 사용자 데이터 폴더와 safeStorage 키체인 항목을 정한다. 실행 내내
// 2.0.10 까지와 같은 내부 이름을 쓴다. 메뉴·대화상자에는 PRODUCT_NAME 을 직접 넘긴다.
app.setName(INTERNAL_APP_NAME);
const profileDirectories = resolveProfileDirectories({
  packaged: app.isPackaged,
  appDataDir: app.getPath('appData'),
  env: process.env,
  developmentUserData: join(__dirname, '..', '.run', 'desktop-user-data'),
});
app.setPath('userData', profileDirectories.userData);
registerStudioScheme(protocol);
const hasSingleInstanceLock = app.requestSingleInstanceLock();

function studioDist() {
  return join(__dirname, '..', 'rhwp', 'rhwp-studio', 'dist');
}

function unpackedPath(path) {
  const unpacked = path.replace(`app.asar${sep}`, `app.asar.unpacked${sep}`);
  return existsSync(unpacked) ? unpacked : path;
}

function agentScript() {
  return unpackedPath(join(__dirname, '..', 'rhwp', 'rhwp-agent', 'server.mjs'));
}

function nativeRhwpExecutable() {
  const bundled = unpackedPath(sourceStagedNativeExtractorPath(
    __dirname,
    process.platform,
    process.arch,
  ));
  if (existsSync(bundled)) return bundled;
  if (app.isPackaged) throw new Error(`Packaged native document extractor is missing: ${bundled}`);
  const configured = String(process.env.RHWP_BIN ?? '').trim();
  if (configured && existsSync(configured)) return configured;
  const development = join(
    __dirname,
    '..',
    'rhwp',
    'target',
    'release',
    nativeExtractorFileName(process.platform),
  );
  return existsSync(development) ? development : null;
}

class AgentHubOwner {
  #child = null;
  #context = null;
  #disposed = false;
  #startPromise = null;
  #stopPromise = null;
  #restartAttempt = 0;
  #restartTimer = null;
  #stoppingChild = null;
  // Windows-only: the hub leader exited without the shutdown handshake, so its
  // descendants may be orphaned. The owner stays usable — the next start runs
  // on a fresh per-epoch workspace the orphans cannot reach.
  #quarantined = false;
  #epoch = 0;
  #ownedRuntimeDirs = new Set();
  #ownedWorkDirs = new Set();

  constructor({ runtimeDir, workDir }) {
    this.runtimeDir = runtimeDir;
    this.workDir = workDir;
    this.runtimeRoot = dirname(runtimeDir);
    this.workRoot = dirname(workDir);
    this.#ownedRuntimeDirs.add(runtimeDir);
    this.#ownedWorkDirs.add(workDir);
  }

  activeRuntimeDir() {
    return this.#epoch === 0 ? this.runtimeDir : join(this.runtimeRoot, `${launchId}-r${this.#epoch}`);
  }

  activeWorkDir() {
    return this.#epoch === 0 ? this.workDir : join(this.workRoot, `${launchId}-r${this.#epoch}`);
  }

  context() {
    return this.#context;
  }

  clearRestart() {
    if (this.#restartTimer) clearTimeout(this.#restartTimer);
    this.#restartTimer = null;
  }

  scheduleRestart() {
    if (this.#disposed || quitting || this.#restartTimer || this.#quarantined) return;
    if (this.#restartAttempt >= MAX_HUB_AUTO_RESTARTS) {
      // Warn once; a successful start resets #restartAttempt to 0.
      if (this.#restartAttempt++ === MAX_HUB_AUTO_RESTARTS) {
        console.warn('[hamaeditor] agent hub keeps exiting; automatic restarts stopped until the next window or sidebar request');
      }
      return;
    }
    const delay = nextHubRestartDelay(this.#restartAttempt++);
    console.warn(`[hamaeditor] owned agent hub exited; restarting in ${delay}ms`);
    this.#restartTimer = setTimeout(() => {
      this.#restartTimer = null;
      void this.ensure().catch((error) => {
        console.warn('[hamaeditor] agent hub restart failed:', error);
        this.scheduleRestart();
      });
    }, delay);
  }

  quarantineUnexpectedWindowsExit() {
    if (this.#quarantined) return;
    this.#quarantined = true;
    this.clearRestart();
    try {
      retainLaunchRootForProcessCleanupSync(this.activeWorkDir(), { launchId });
    } catch (error) {
      console.warn('[hamaeditor] process cleanup retention marker failed:', error);
    }
    console.warn(
      '[hamaeditor] owned agent hub exited unexpectedly on Windows; descendants may be orphaned.',
      'Retaining launch work and moving the next hub start to a fresh workspace:',
      this.activeWorkDir(),
    );
  }

  async stopCurrent() {
    const child = this.#child;
    const context = this.#context;
    this.#context = null;
    this.#stoppingChild = child;
    let cleanupPrepared = false;
    try {
      if (child != null && (child.exitCode != null || child.signalCode != null)) {
        // The leader is already dead. A quarantined tree stays abandoned, not
        // killed: numeric-PID kills can retarget reused PIDs on Windows, so the
        // next start() instead moves to a fresh workspace they cannot reach.
        if (this.#child === child) this.#child = null;
        return;
      }
      if (context) {
        try {
          const response = await requestHubShutdown({
            port: context.port,
            token: hubToken,
            launchId,
            timeoutMs: 15_000,
          });
          cleanupPrepared = response?.status === 'prepared'
            && response?.launchId === launchId;
        } catch (error) {
          console.warn('[hamaeditor] graceful agent hub shutdown failed:', error);
        }
      }
      // A prepared response proves descendants were disposed. Windows can then
      // wait on the retained child handle without resolving a reusable PID.
      const stopped = await stopHubChild(child, { timeoutMs: 5000, cleanupPrepared });
      if (!stopped) {
        // Preserve the exited leader's PID/tree identity and make every outer
        // cleanup layer retain the launch root until a reboot proves safety.
        try {
          retainLaunchRootForProcessCleanupSync(this.activeWorkDir(), { launchId });
        } catch (error) {
          console.warn('[hamaeditor] process cleanup retention marker failed:', error);
        }
        if (!this.#child || this.#child === child) this.#child = child;
        // The tree could not be proven stopped — the next start must not share
        // its workspace.
        this.#quarantined = true;
        throw new Error(`Agent hub process tree ${child?.pid ?? 'unknown'} survived shutdown`);
      }
      if (this.#child === child) this.#child = null;
    } finally {
      if (this.#stoppingChild === child) this.#stoppingChild = null;
    }
  }

  async start() {
    if (this.#disposed) throw new Error('Agent hub owner has been disposed');
    if (this.#quarantined) {
      // An unprovable tree was quarantined. It keeps its old workspace (marked
      // for reboot-level cleanup) while the next hub starts on a fresh epoch
      // directory that no orphan can lock or corrupt.
      this.#quarantined = false;
      this.#epoch += 1;
      console.warn(`[hamaeditor] restarting agent hub on an isolated workspace (epoch ${this.#epoch})`);
    }
    if (this.#startPromise) return this.#startPromise;
    this.#startPromise = this.startOwnedChild();
    try {
      return await this.#startPromise;
    } finally {
      this.#startPromise = null;
    }
  }

  async startOwnedChild() {
    const runtimeDir = this.activeRuntimeDir();
    const workDir = this.activeWorkDir();
    mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
    mkdirSync(workDir, { recursive: true, mode: 0o700 });
    this.#ownedRuntimeDirs.add(runtimeDir);
    this.#ownedWorkDirs.add(workDir);
    if (this.#child && this.#context) {
      const child = this.#child;
      const context = this.#context;
      const probe = (timeoutMs) => isHubHealthy(context.port, {
        token: hubToken,
        launchId,
        expectedPid: child.pid,
        expectedLaunchId: launchId,
        ...(timeoutMs ? { timeoutMs } : {}),
      });
      // A busy hub (GC, a large payload, waking from sleep) must not lose every
      // agent session over one missed probe. An exited child is onExit's job.
      const running = () => child.exitCode == null && child.signalCode == null;
      const healthy = await probe() || (running() && await probe(HUB_BUSY_HEALTH_TIMEOUT_MS));
      if (healthy && this.#context === context) return { started: false, ready: true, context };
      await this.stopCurrent();
    } else if (this.#child) {
      await this.stopCurrent();
    }

    const server = agentScript();
    const rhwpExecutable = nativeRhwpExecutable();
    const rhwpBinary = packagedRhwpBinary({
      packaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
    });
    const launch = resolveHubLaunch({
      packaged: app.isPackaged,
      execPath: process.execPath,
      scriptPath: server,
      agentDir: dirname(server),
      home: app.getPath('home'),
      extraDirs: [join(__dirname, '..', 'node_modules', '.bin')],
      allowNpm: false,
      env: {
        ...process.env,
        RHWP_AGENT_PORT: '0',
        RHWP_AGENT_TOKEN: hubToken,
        RHWP_AGENT_MODE: 'production',
        ...(rhwpBinary ? { RHWP_BIN: rhwpBinary } : {}),
        RHWP_LAUNCH_ID: launchId,
        RHWP_OWNER_PID: String(process.pid),
        RHWP_OWNER_IPC: '1',
        RHWP_RUNTIME_DIR: runtimeDir,
        RHWP_WORK_DIR: workDir,
        RHWP_AGENT_INSTRUCTIONS_DIR: join(app.getPath('userData'), 'agent-instructions'),
        RHWP_OWN_RUNTIME_DIR: '1',
        RHWP_OWN_WORK_DIR: '1',
        RHWP_SECRET_BROKER: 'ipc',
        ...(rhwpExecutable ? { RHWP_BIN: rhwpExecutable } : {}),
      },
    });
    if (!launch) throw new Error(`Agent hub launch command not found: ${server}`);
    launch.cwd = workDir;

    console.log(`[hamaeditor] starting owned agent hub via ${launch.via}`);
    const child = spawnHubProcess(launch, {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      onMessage: (message, source) => {
        if (!secretVault) return;
        void handleSecretRequest(secretVault, message).then((response) => {
          if (response && source.connected) source.send(response);
        });
      },
      onError: (error) => {
        console.warn('[hamaeditor] agent hub spawn error:', error);
      },
      onExit: (code, signal) => {
        console.warn('[hamaeditor] agent hub process exit:', code, signal ?? '');
        if (this.#child !== child) return;
        this.#context = null;
        // `exit` only proves the leader died. Retain the ChildProcess/PID until
        // stopCurrent has probed and escalated the complete owned tree.
        if (this.#stoppingChild === child) return;
        if (process.platform === 'win32') {
          this.quarantineUnexpectedWindowsExit();
          return;
        }
        this.scheduleRestart();
      },
    });
    this.#child = child;

    try {
      const ready = await waitForHubReadyLine(child, { launchId });
      if (ready.pid !== child.pid) throw new Error('Agent hub ready line did not match the owned child');
      const healthy = await waitForHub(ready.port, {
        isHealthy: () => isHubHealthy(ready.port, {
          token: hubToken,
          launchId,
          expectedPid: child.pid,
          expectedLaunchId: launchId,
        }),
      });
      if (!healthy) throw new Error('Owned agent hub failed authenticated health checks');
      this.#context = Object.freeze({
        port: ready.port,
        hubUrl: `ws://127.0.0.1:${ready.port}`,
        hubToken,
      });
      this.#restartAttempt = 0;
      this.clearRestart();
      return { started: true, ready: true, context: this.#context };
    } catch (error) {
      if (this.#child === child) await this.stopCurrent();
      throw error;
    }
  }

  async ensure() {
    return this.start();
  }

  teardown() {
    if (this.#stopPromise) return this.#stopPromise;
    this.#disposed = true;
    this.clearRestart();
    this.#stopPromise = (async () => {
      await this.#startPromise?.catch(() => {});
      await this.stopCurrent();
      for (const dir of this.#ownedRuntimeDirs) {
        await rm(dir, { recursive: true, force: true }).catch(() => {});
      }
      for (const dir of this.#ownedWorkDirs) {
        if (hasPendingLaunchCleanupSync(dir)) {
          console.warn('[hamaeditor] retaining launch work for pending cleanup:', dir);
        } else {
          await rm(dir, { recursive: true, force: true }).catch(() => {});
        }
      }
    })();
    return this.#stopPromise;
  }
}

let quitting = false;
let quitRequested = false;
let desktopReady = false;
let initialLaunchesOpened = false;
let secretVault = null;
const pendingLaunches = [launchRequest({ argv: process.argv, source: 'initial' })];
const launchStorage = launchStoragePaths({
  tempDir: app.getPath('temp'),
  userDataDir: app.getPath('userData'),
  launchId,
});
const {
  profileId: userDataProfileId,
  runtimeRoot,
  workRoot,
  runtimeDir,
  workDir,
  legacyRuntimeRoot,
  legacyWorkRoot,
} = launchStorage;
const hubOwner = new AgentHubOwner({ runtimeDir, workDir });

// 멈추거나 죽은 허브는 세션을 스스로 정리한다. 그 포트로 소유자 토큰을 보내지 않는다.
async function closeOwnedHubSession(sessionId) {
  const hub = hubOwner.context();
  if (!hub) return;
  try {
    await closeHubSession({ port: hub.port, token: hubToken, launchId, sessionId });
  } catch (error) {
    if (error?.status !== 404) console.warn('[hamaeditor] hub session close failed:', error);
  }
}

const sessions = new SessionManager({
  launchId,
  getHubContext: async () => (await hubOwner.ensure()).context,
  getSessionCapabilities: (sessionId, hub) => registerHubSession({
    port: hub.port,
    token: hubToken,
    launchId,
    sessionId,
  }),
  closeHubSession: closeOwnedHubSession,
});
const documentLeases = new DocumentLeaseManager();
const nativeFiles = new NativeFileHandleRegistry();
const nativeBookmarkFile = join(app.getPath('userData'), 'native-document-bookmarks.json');
const systemFonts = createSystemFontService({
  cacheDir: join(app.getPath('userData'), 'fonts'),
  log: (line) => console.log(`[hamaeditor] fonts: ${line}`),
});
let uniqueInstallSnapshot = {
  uniqueInstalls: null,
  publicUrl: uniqueInstallsPublicUrl(),
  recorded: false,
};
let resolveUniqueInstallSync = () => {};
const uniqueInstallSync = new Promise((resolve) => {
  resolveUniqueInstallSync = resolve;
});

async function syncUniqueInstallMetric() {
  uniqueInstallSnapshot = await reportUniqueInstall({
    userDataDir: app.getPath('userData'),
    packaged: app.isPackaged,
    devUrl,
    appVersion: app.getVersion(),
    os: process.platform,
    arch: process.arch,
  });
}

async function finishUniqueInstallMetric() {
  try {
    await syncUniqueInstallMetric();
  } catch (error) {
    console.warn('[hamaeditor] unique install ping failed:', error);
  } finally {
    resolveUniqueInstallSync();
  }
}
const nativeBookmarkWriter = new SerializedStateWriter({
  write: (snapshot) => writeNativeFileAtomically(nativeBookmarkFile, Buffer.from(snapshot, 'utf8')),
  onError: (error) => console.warn('[hamaeditor] native bookmark persist failed:', error),
});

const windowFrames = new WindowFrameStore({
  filePath: join(app.getPath('userData'), 'window-frame.json'),
  screen,
  writeAtomically: writeNativeFileAtomically,
});
const agentAttention = new AgentAttention({ app, Notification: ElectronNotification });

/** 열거나 저장한 네이티브 파일을 Dock·최근 사용 메뉴에 올린다. */
function noteRecentDocument(sessionId, handleId) {
  if (process.platform !== 'darwin' && process.platform !== 'win32') return;
  try {
    const filePath = nativeFiles.sourcePathForSender(sessionId, handleId);
    if (filePath) app.addRecentDocument(filePath);
  } catch (error) {
    console.warn('[hamaeditor] recent document update failed:', error);
  }
}

async function loadNativeBookmarks() {
  try {
    const raw = await readBookmarkState(nativeBookmarkFile);
    if (raw === null) return;
    try {
      nativeFiles.loadBookmarks(raw, { strict: true });
    } catch (error) {
      error.code = 'BOOKMARK_STATE_CORRUPT';
      throw error;
    }
  } catch (error) {
    if (error?.code !== 'BOOKMARK_STATE_CORRUPT') throw error;
    const quarantined = await quarantineBookmarkState(nativeBookmarkFile);
    console.warn('[hamaeditor] corrupt native bookmark state quarantined:', quarantined);
  }
}

function persistNativeBookmarks(options) {
  return nativeBookmarkWriter.enqueue(JSON.stringify(nativeFiles.dumpBookmarks()), options);
}

async function bestEffortStartupCleanup(label, cleanup) {
  try {
    await cleanup;
  } catch (error) {
    console.warn(`[hamaeditor] ${label} cleanup failed:`, error);
  }
}

const updateLifecycle = createUpdateLifecycle({
  app,
  updater: autoUpdater,
  nativeUpdater: nativeAutoUpdater,
  platform: process.platform,
  isInteractive: () => manualUpdateCheck || interactiveUpdateDownload,
  showMessageBox: (options) => dialog.showMessageBox({ title: PRODUCT_NAME, ...options }),
  openReleases: () => shell.openExternal(RELEASES_URL),
  cleanup: () => hubOwner.teardown(),
  onQuitRequested: (requested) => { quitRequested = requested; },
  onTeardown: () => { quitting = true; },
});
let manualUpdateCheck = false;
let interactiveUpdateDownload = false;
let updateCheckPromise = null;

async function showUpToDate() {
  await dialog.showMessageBox({
    title: PRODUCT_NAME,
    type: 'info',
    message: 'HamaEditor is up to date',
    detail: `Version ${app.getVersion()} is the latest release.`,
    buttons: ['OK'],
  });
}

async function checkForDebUpdates({ manual }) {
  const response = await net.fetch(RELEASES_API_URL, {
    headers: {
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
    },
    cache: 'no-store',
  });
  if (!response.ok) throw new Error(`GitHub Releases returned HTTP ${response.status}`);
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > 2 * 1024 * 1024) {
    throw new Error('GitHub release metadata is too large');
  }
  const release = await response.json();
  if (!isNewerStableVersion(release?.tag_name, app.getVersion())) {
    if (manual) await showUpToDate();
    return null;
  }
  const asset = selectDebAsset(release?.assets, process.arch);
  const { response: choice } = await dialog.showMessageBox({
    title: PRODUCT_NAME,
    type: 'info',
    message: `HamaEditor ${String(release.tag_name).replace(/^v/i, '')} is available`,
    detail: `You are running version ${app.getVersion()}. Download the signed Debian package and install it with your system package manager.`,
    buttons: ['Open download page', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
  });
  if (choice === 0) void shell.openExternal(asset?.browser_download_url ?? release?.html_url ?? RELEASES_URL);
  return release;
}

function configureAutoUpdater() {
  autoUpdater.logger = console;
  const linuxAppImage = process.platform === 'linux' && Boolean(process.env.APPIMAGE);
  // macOS and AppImage builds can stage compatible updates. Debian packages
  // stay under the system package manager and only link to the signed release.
  autoUpdater.autoDownload = process.platform === 'darwin' || linuxAppImage;
  updateLifecycle.configureUpdates();
  autoUpdater.on('update-not-available', () => {
    if (!manualUpdateCheck) return;
    void showUpToDate();
  });
  autoUpdater.on('update-available', (info) => {
    const linuxDeb = process.platform === 'linux' && !process.env.APPIMAGE;
    if (autoUpdater.autoDownload || (!manualUpdateCheck && !linuxDeb)) return;
    void dialog.showMessageBox({
      title: PRODUCT_NAME,
      type: 'info',
      message: `HamaEditor ${info?.version ?? ''} is available`,
      detail: linuxDeb
        ? `You are running version ${app.getVersion()}. Download the signed Debian package from Releases.`
        : `You are running version ${app.getVersion()}. Download the installer now?`,
      buttons: linuxDeb ? ['Open download page', 'Cancel'] : ['Download', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
    }).then(({ response }) => {
      if (response !== 0) return;
      if (linuxDeb) {
        void shell.openExternal(RELEASES_URL);
      } else {
        interactiveUpdateDownload = true;
        void autoUpdater.downloadUpdate().catch((error) => updateLifecycle.reportError(error)).finally(() => {
          interactiveUpdateDownload = false;
        });
      }
    }).catch((error) => updateLifecycle.reportError(error));
  });
}

async function checkForAppUpdates({ manual = true } = {}) {
  if (manual && updateLifecycle.hasDownloadedUpdate()) return updateLifecycle.offerInstall();
  if (updateCheckPromise) {
    if (manual) manualUpdateCheck = true;
    return updateCheckPromise;
  }
  manualUpdateCheck = manual;
  updateCheckPromise = (async () => {
    try {
      if (process.platform === 'linux' && !process.env.APPIMAGE) {
        return await checkForDebUpdates({ manual: manualUpdateCheck });
      }
      const result = await autoUpdater.checkForUpdates();
      // Keep a user-requested automatic download interactive until it settles.
      // The updater 'error' listener already logs a failed background download.
      if (manualUpdateCheck && result?.downloadPromise) await result.downloadPromise;
      else void result?.downloadPromise?.catch(() => {});
      return result;
    } catch (error) {
      if (manualUpdateCheck) await updateLifecycle.reportError(error);
      return null;
    } finally {
      manualUpdateCheck = false;
      updateCheckPromise = null;
    }
  })();
  return updateCheckPromise;
}

function installMenu() {
  installAppMenu({
    checkForUpdates: () => {
      if (!app.isPackaged) {
        void shell.openExternal(RELEASES_URL);
        return;
      }
      void checkForAppUpdates();
    },
    openNewWindow: () => queueLaunch(launchRequest({ source: 'new-window' })),
    isTrustedSender: (event) => {
      try {
        sessionForEvent(event);
        return true;
      } catch {
        return false;
      }
    },
  });
}

function cascadedWindowPosition() {
  const source = BrowserWindow.getFocusedWindow() ?? sessions.windows().at(-1);
  if (!source || source.isDestroyed()) return {};
  const bounds = source.getBounds();
  return { x: bounds.x + 28, y: bounds.y + 28 };
}

async function createWindow(launch = launchRequest(), { generatedDocument = null } = {}) {
  // 허브는 창과 나란히 뜬다. 렌더러의 세션 문맥 요청(desktop:get-session-context)이
  // 허브 준비를 기다리므로 창 생성은 허브를 막지 않는다.
  void hubOwner.ensure().catch(() => {});
  const backgroundColor = nativeTheme.shouldUseDarkColors ? '#141416' : '#f5f5f7';
  const isMac = process.platform === 'darwin';
  // 실행 후 첫 창만 지난 프레임을 되살리고, 이후 창은 28px 계단식으로 연다.
  const restoredFrame = sessions.windows().length === 0
    ? windowFrames.takeInitialFrame({ minWidth: 900, minHeight: 640 })
    : null;
  const window = new BrowserWindow({
    ...(restoredFrame ? restoredFrame.bounds : { ...cascadedWindowPosition(), width: 1440, height: 920 }),
    title: 'HamaEditor',
    minWidth: 900,
    minHeight: 640,
    show: false,
    backgroundColor,
    ...(isMac ? {
      titleBarStyle: 'hidden',
      trafficLightPosition: { x: 14, y: 12 },
    } : {}),
    webPreferences: {
      preload: PRELOAD_PATH,
      contextIsolation: true,
      nodeIntegration: false,
      // 프리로드는 contextBridge/ipcRenderer/webUtils 만 쓰므로 샌드박스 렌더러에서도 동작한다.
      sandbox: true,
    },
  });
  const windowId = window.id;
  windowFrames.track(window);
  installTextContextMenu({ Menu, webContents: window.webContents, window, isMac });
  const session = sessions.addWindow(window, { source: launch.source, openFiles: [] });
  session.generatedDocument = generatedDocument
    ? { launchDocumentId: randomUUID(), ...generatedDocument }
    : null;
  session.allowCloseOnce = false;
  session.pendingCloseRequestId = null;
  // The renderer registers its close listener while main.ts evaluates, and an
  // earlier request is dropped. A close before the first load waits for it.
  session.rendererLoaded = false;
  session.closeDeferred = false;
  session.rendererLoadFailed = false;
  const requestRendererClose = () => {
    if (session.pendingCloseRequestId) return;
    session.pendingCloseRequestId = randomUUID();
    window.webContents.send('desktop:close-requested', {
      requestId: session.pendingCloseRequestId,
      reason: quitRequested ? 'quit' : 'close',
    });
  };
  window.on('close', (event) => {
    if (session.allowCloseOnce) return;
    // A dead renderer can never answer the Save–Discard–Cancel prompt.
    // Blocking the close here would leave an unclosable window that also
    // stalls quit, so let the close proceed instead.
    if (window.webContents.isDestroyed() || window.webContents.isCrashed()) return;
    // A window whose first load failed has no document and no listener.
    if (session.rendererLoadFailed) return;
    event.preventDefault();
    if (!session.rendererLoaded) {
      session.closeDeferred = true;
      return;
    }
    requestRendererClose();
  });
  window.on('closed', () => {
    agentAttention.forget(windowId);
    releaseRendererDocuments(session.sessionId, { documentLeases, nativeFiles });
    // 창의 추가 에이전트 세션도 함께 허브에서 닫힌다.
    sessions.removeWindow(window);
    if (quitRequested) setImmediate(() => {
      if (quitRequested && !quitting) app.quit();
    });
    void closeOwnedHubSession(session.sessionId);
  });
  const launchFiles = [];
  try {
    for (const filePath of launch.openFiles) {
      const result = await nativeFiles.create(session.sessionId, filePath);
      if (!result.ok) {
        sessions.focusSession(result.ownerSessionId);
        window.destroy();
        return null;
      }
      launchFiles.push(result.descriptor);
      noteRecentDocument(session.sessionId, result.descriptor.handleId);
    }
  } catch (error) {
    window.destroy();
    throw error;
  }

  window.on('enter-full-screen', () => {
    if (!window.isDestroyed()) window.webContents.send('window:fullscreen-changed', true);
  });
  window.on('leave-full-screen', () => {
    if (!window.isDestroyed()) window.webContents.send('window:fullscreen-changed', false);
  });
  window.webContents.on('preload-error', (_event, preloadPath, error) => {
    console.warn('[hamaeditor] preload error', preloadPath, error);
  });
  window.webContents.on('render-process-gone', (_event, details) => {
    console.warn('[hamaeditor] renderer process gone:', details?.reason);
    // An unanswered close prompt died with the renderer; clear it so the
    // window can close (the close handler skips the prompt for dead renderers).
    session.pendingCloseRequestId = null;
    // The dead renderer's document is gone. Free its path so opening the file
    // again starts a working window instead of focusing this blank one, and so
    // a reload does not resend handles that no longer exist.
    releaseRendererDocuments(session.sessionId, { documentLeases, nativeFiles });
    launchFiles.length = 0;
    // Agents of the dead page's background documents cannot be reached again.
    sessions.releaseAgentSessions(window);
  });
  // A reloaded page knows only its window session and reopens the default
  // document itself. Background documents and their agents died with the old page.
  window.webContents.on('did-navigate', () => {
    sessions.releaseAgentSessions(window);
    documentLeases.releaseSession(session.sessionId, { keepDefaultSlot: true });
  });
  window.webContents.setWindowOpenHandler(({ url, frameName }) => {
    // 인쇄 미리보기 같은 앱 내부 surface는 외부 브라우저가 아니라 네이티브
    // 자식 창으로 연다 — renderer 의 window.open 이 반환하는 창에 문서를 쓰고
    // print() 로 시스템 인쇄 대화상자를 연다.
    if (isTrustedRendererUrl(url) && frameName === PDF_EXPORT_FRAME_NAME) {
      // PDF 내보내기 surface는 보이지 않는 창에서 그린 뒤 printToPDF 한다.
      return { action: 'allow', overrideBrowserWindowOptions: pdfExportWindowOptions(PRELOAD_PATH) };
    }
    if (isTrustedRendererUrl(url)) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 1120,
          height: 820,
          minWidth: 480,
          minHeight: 360,
          autoHideMenuBar: true,
          title: 'HamaEditor',
          webPreferences: {
            preload: PRELOAD_PATH,
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
          },
        },
      };
    }
    if (/^https?:/i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  for (const eventName of ['will-navigate', 'will-redirect']) {
    window.webContents.on(eventName, (event, url) => {
      if (!isTrustedRendererUrl(url)) event.preventDefault();
    });
  }
  window.webContents.on('did-finish-load', () => {
    session.rendererLoaded = true;
    // A reload after a failed first load brings back the document and its prompt.
    session.rendererLoadFailed = false;
    // A request sent to a previous document can never be answered (dev reload).
    session.pendingCloseRequestId = null;
    if (launchFiles.length > 0 && !window.isDestroyed()) {
      window.webContents.send('desktop:open-files', launchFiles);
    }
    if (session.generatedDocument && !window.isDestroyed()) {
      window.webContents.send('desktop:open-generated-document', session.generatedDocument);
    }
    if (session.closeDeferred && !window.isDestroyed()) {
      session.closeDeferred = false;
      requestRendererClose();
    }
  });
  window.webContents.on('did-fail-load', (_event, errorCode, _description, _url, isMainFrame) => {
    // -3 (ERR_ABORTED) means another navigation took over. Once loaded, a
    // window always keeps its close prompt.
    if (!isMainFrame || errorCode === -3 || session.rendererLoaded) return;
    session.rendererLoadFailed = true;
    if (session.closeDeferred && !window.isDestroyed()) window.close();
  });
  window.once('ready-to-show', () => {
    if (window.isDestroyed()) return;
    if (restoredFrame?.zoomed) window.maximize();
    window.show();
  });
  await window.loadURL(devUrl || STUDIO_URL);
  if (!window.isDestroyed() && !window.isVisible()) window.show();
  return window;
}

async function openLaunch(request) {
  if (request.openFiles.length === 0) {
    await createWindow(request);
    return;
  }
  for (const filePath of request.openFiles) {
    const ownerSessionId = await nativeFiles.ownerForPath(filePath).catch(() => null);
    if (ownerSessionId) {
      sessions.focusSession(ownerSessionId);
      continue;
    }
    await createWindow(launchRequest({ openFiles: [filePath], source: request.source }));
  }
}

function queueLaunch(request) {
  if (quitting) return;
  if (!desktopReady) {
    pendingLaunches.push(request);
    return;
  }
  void openLaunch(request).catch(showLaunchError);
}

function showLaunchError(error) {
  dialog.showErrorBox('HamaEditor could not open', error instanceof Error ? error.message : String(error));
}

// ── 2.0.11 프로필 가져오기 ────────────────────────────────────────────────
// 2.0.11 은 다른 프로필 폴더와 출처(hamaeditor://app)에 Studio 저장소를 남겼다. 그 사본을 숨은 창에서
// 2.0.11 출처로 열어 덤프하고, 첫 Studio 창이 기동하면서 정본 저장소에 합친다. 원본은 읽기만 한다.
const rebrandImport = createRebrandImportController({
  BrowserWindow,
  session: electronSession,
  userDataDir: app.getPath('userData'),
  rebrandedDir: profileDirectories.rebranded,
  tempDir: app.getPath('temp'),
  preloadPath: REBRAND_EXPORT_PRELOAD_PATH,
});

ipcMain.handle('desktop:take-rebrand-import', (event) => {
  sessionForEvent(event);
  return rebrandImport.take();
});
ipcMain.handle('desktop:take-rebrand-import-chunk', (event, token, index) => {
  sessionForEvent(event);
  return rebrandImport.chunk(token, index);
});
ipcMain.handle('desktop:finish-rebrand-import', (event, token, outcome) => {
  sessionForEvent(event);
  return rebrandImport.finish(token, outcome);
});

ipcMain.handle('desktop:get-unique-installs', async (event) => {
  sessionForEvent(event);
  await uniqueInstallSync;
  return uniqueInstallSnapshot;
});
ipcMain.handle('desktop:get-session-context', (event, agentSessionId = null) => {
  sessionForEvent(event);
  return sessions.contextForSender(event.sender, agentSessionId);
});
ipcMain.handle('desktop:agent-session-create', (event) => {
  sessionForEvent(event);
  if (quitting) throw new Error('Rauhwpx is quitting');
  return { sessionId: sessions.addAgentSession(event.sender) };
});
ipcMain.handle('desktop:agent-session-release', (event, agentSessionId) => {
  sessionForEvent(event);
  return sessions.releaseAgentSession(event.sender, agentSessionId);
});
ipcMain.handle('desktop:fonts-list', (event, options = {}) => {
  sessionForEvent(event);
  if (process.env.RHWP_SYSTEM_FONTS === 'off') throw new Error('System font discovery is disabled');
  return systemFonts.list({ refresh: options?.refresh === true });
});
ipcMain.handle('desktop:fonts-read', (event, id) => {
  sessionForEvent(event);
  return systemFonts.readFace(id);
});
ipcMain.handle('desktop:get-launch-files', (event) => {
  const session = sessionForEvent(event);
  return nativeFiles.descriptorsForSession(session.sessionId);
});
ipcMain.handle('desktop:get-launch-generated-document', (event) => {
  const session = sessionForEvent(event);
  return session.generatedDocument;
});
installPdfExport({
  ipcMain,
  dialog,
  shell,
  BrowserWindow,
  isTrustedSender: (event) => isTrustedRendererUrl(event.senderFrame?.url || event.sender.getURL()),
});
ipcMain.handle('desktop:print', (event) => {
  // 인쇄 미리보기 자식 창처럼 세션에 등록되지 않은 창도 허용하되, 신뢰 origin
  // 에서 온 요청만 본다. 시스템 인쇄 대화상자를 호출한 창의 내용에 연다.
  const senderUrl = event.senderFrame?.url || event.sender.getURL();
  if (!isTrustedRendererUrl(senderUrl)) throw new Error('Untrusted renderer IPC sender');
  event.sender.print();
});
ipcMain.handle('desktop:open-generated-document-window', async (event, payload = {}) => {
  const session = sessionForEvent(event);
  const hub = hubOwner.context();
  if (!hub) throw new Error('Agent hub is unavailable');
  const artifact = resolveGeneratedDocumentArtifact(payload, {
    hubUrl: hub.hubUrl,
    sessionId: session.sessionId,
  });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  let bytes;
  try {
    const response = await net.fetch(artifact.downloadUrl, {
      cache: 'no-store',
      signal: controller.signal,
    });
    if (!response.ok) {
      await response.body?.cancel?.('generated-document-http-error').catch(() => {});
      throw new Error(`Generated document request failed with HTTP ${response.status}`);
    }
    bytes = await readGeneratedDocumentResponse(response, MAX_GENERATED_DOCUMENT_BYTES);
  } finally {
    clearTimeout(timeout);
  }
  validateNativeDocumentBytes(artifact.fileName, bytes);
  const opened = await createWindow(
    launchRequest({ source: 'chat-artifact' }),
    { generatedDocument: { fileName: artifact.fileName, bytes, readOnly: artifact.readOnly } },
  );
  return Boolean(opened);
});
ipcMain.handle('desktop:pick-native-open-file', async (event, options = {}) => {
  const session = sessionForEvent(event);
  const window = BrowserWindow.fromWebContents(event.sender);
  if (!window) throw new Error('Open picker sender window is unavailable');
  const suggestedName = typeof options?.suggestedName === 'string'
    ? safeSuggestedFilename(options.suggestedName, 'document.hwp')
    : '';
  const documentId = typeof options?.documentId === 'string' ? options.documentId : '';
  const bookmarked = documentId ? nativeFiles.bookmarkPathFor(documentId) : null;
  let defaultPath;
  if (bookmarked) {
    defaultPath = suggestedName ? join(dirname(bookmarked), suggestedName) : bookmarked;
  } else if (suggestedName) {
    defaultPath = suggestedName;
  }
  const picked = await dialog.showOpenDialog(window, {
    ...(defaultPath ? { defaultPath } : {}),
    filters: [{ name: 'HWP/HWPX/HML documents and HamaEditor history', extensions: ['hwp', 'hwpx', 'hml', 'rhwpx'] }],
    properties: ['openFile'],
  });
  if (picked.canceled || !picked.filePaths[0]) return null;
  const result = await nativeFiles.create(session.sessionId, picked.filePaths[0]);
  if (!result.ok) {
    sessions.focusSession(result.ownerSessionId);
    return { owned: true };
  }
  noteRecentDocument(session.sessionId, result.descriptor.handleId);
  return { ...result.descriptor, saveTargetCreated: result.created };
});
ipcMain.handle('desktop:pick-legacy-history-folder', async (event) => {
  const session = sessionForEvent(event);
  const window = BrowserWindow.fromWebContents(event.sender);
  if (!window) throw new Error('Legacy history import sender window is unavailable');
  const picked = await dialog.showOpenDialog(window, {
    title: 'Import legacy HamaEditor history folder',
    properties: ['openDirectory'],
  });
  if (picked.canceled || !picked.filePaths[0]) return null;
  const folderPath = picked.filePaths[0];
  if (extname(folderPath).toLowerCase() !== '.rhwpx') {
    throw new Error('Legacy history folders must use the .rhwpx extension');
  }
  const result = await nativeFiles.create(session.sessionId, folderPath);
  if (!result.ok) {
    sessions.focusSession(result.ownerSessionId);
    return { owned: true };
  }
  if (!result.descriptor.legacyPortableHistoryFolder) {
    nativeFiles.releaseHandle(session.sessionId, result.descriptor.handleId);
    throw new Error('The selected RHWPX item is a file, not a legacy history folder');
  }
  return { ...result.descriptor, saveTargetCreated: result.created };
});
ipcMain.handle('desktop:claim-native-dropped-file', async (event, filePath) => {
  const session = sessionForEvent(event);
  const result = await nativeFiles.create(session.sessionId, filePath);
  if (!result.ok) {
    sessions.focusSession(result.ownerSessionId);
    return { owned: true };
  }
  noteRecentDocument(session.sessionId, result.descriptor.handleId);
  return { ...result.descriptor, saveTargetCreated: result.created };
});
ipcMain.handle('desktop:pick-native-save-file', async (event, options = {}) => {
  const session = sessionForEvent(event);
  const window = BrowserWindow.fromWebContents(event.sender);
  if (!window) throw new Error('Save picker sender window is unavailable');
  const extension = String(options.extension ?? '').toLowerCase();
  if (!['hwp', 'hwpx', 'hml', 'rhwpx'].includes(extension)) throw new Error('Unsupported save format');
  const suggestedName = safeSuggestedFilename(
    options.suggestedName,
    `document.${extension}`,
  );
  // NSSavePanel의 이름 필드에 확장자가 미리 들어가 있으면 중간 편집마다
  // 관리 확장자를 다시 적용해 커서가 튀고, 사용자가 직접 친 확장자 위에
  // .hwpx 를 이어 붙여 name.hwpx.hwpx 가 된다. 순수 이름만 넘긴다.
  const suggestedStem = ['.hwp', '.hwpx', '.hml', '.rhwpx'].includes(extname(suggestedName).toLowerCase())
    ? basename(suggestedName, extname(suggestedName))
    : suggestedName;
  const picked = await dialog.showSaveDialog(window, {
    defaultPath: suggestedStem,
    filters: [{
      name: extension === 'rhwpx' ? 'HamaEditor history archive' : `${extension.toUpperCase()} document`,
      extensions: [extension],
    }],
    properties: ['showOverwriteConfirmation', 'createDirectory'],
  });
  if (picked.canceled || !picked.filePath) return null;
  // 사용자가 .hwp/.hwpx/.hml 등을 직접 치면 패널이 관리 확장자를 그대로 덧붙여
  // name.hwpx.hwpx 가 된다. 문서 확장자 꼬리를 모두 떼고 관리 확장자를 한 번만 붙인다.
  const saveDir = dirname(picked.filePath);
  let saveStem = basename(picked.filePath);
  while (['.hwp', '.hwpx', '.hml', '.rhwpx'].includes(extname(saveStem).toLowerCase())) {
    saveStem = saveStem.slice(0, -extname(saveStem).length);
  }
  const filePath = join(saveDir, `${saveStem || 'document'}.${extension}`);
  const result = await nativeFiles.createSaveTarget(session.sessionId, filePath);
  if (!result.ok) {
    sessions.focusSession(result.ownerSessionId);
    return { owned: true };
  }
  return { ...result.descriptor, saveTargetCreated: result.created };
});
ipcMain.handle('desktop:release-native-file', (event, handleId) => {
  const session = sessionForEvent(event);
  nativeFiles.releaseHandle(session.sessionId, handleId);
});
ipcMain.handle('desktop:native-file-read', async (event, handleId) => {
  const session = sessionForEvent(event);
  try {
    return await nativeFiles.read(session.sessionId, handleId);
  } catch (error) {
    // 옛 핸들은 렌더러가 기억해 둔 위치로 다시 연다. 오류로 던지면 메인 로그만 어지럽힌다.
    if (error instanceof StaleNativeHandleError) return { stale: true };
    throw error;
  }
});
ipcMain.handle('desktop:native-file-source-path', (event, handleId) => {
  const session = sessionForEvent(event);
  try {
    return nativeFiles.sourcePathForSender(session.sessionId, handleId);
  } catch (error) {
    if (error instanceof StaleNativeHandleError) return null;
    throw error;
  }
});
ipcMain.handle('desktop:native-file-validate-save', (event, handleId, identity) => {
  const session = sessionForEvent(event);
  return nativeFiles.validateSave(session.sessionId, handleId, identity, documentLeases);
});
ipcMain.handle('desktop:native-file-write', async (event, handleId, bytes, identity) => {
  const session = sessionForEvent(event);
  const written = await nativeFiles.write(session.sessionId, handleId, bytes, identity, documentLeases);
  noteRecentDocument(session.sessionId, handleId);
  return written;
});
ipcMain.handle('desktop:native-file-is-same', (event, firstHandleId, secondHandleId) => {
  const session = sessionForEvent(event);
  return nativeFiles.isSameEntry(session.sessionId, firstHandleId, secondHandleId);
});
ipcMain.handle('desktop:native-file-adopt-loaded', (event, handleId, digest) => {
  const session = sessionForEvent(event);
  if (typeof handleId !== 'string' || !handleId) return false;
  return nativeFiles.adoptLoadedContent(session.sessionId, handleId, digest);
});
ipcMain.handle('desktop:remember-native-document', async (event, documentId, handleId, digest) => {
  const session = sessionForEvent(event);
  if (typeof documentId !== 'string' || !documentId) throw new Error('documentId required');
  if (typeof handleId !== 'string' || !handleId) throw new Error('handleId required');
  nativeFiles.rememberDocument(documentId, session.sessionId, handleId, digest);
  await persistNativeBookmarks();
});
ipcMain.handle('desktop:reopen-native-document', async (event, documentId) => {
  const session = sessionForEvent(event);
  if (typeof documentId !== 'string' || !documentId) return null;
  const result = await nativeFiles.reopenDocument(session.sessionId, documentId);
  if (!result) return null;
  if (!result.ok) {
    sessions.focusSession(result.ownerSessionId);
    return { owned: true };
  }
  noteRecentDocument(session.sessionId, result.descriptor.handleId);
  return { ...result.descriptor, saveTargetCreated: result.created };
});
ipcMain.handle('desktop:search-nearby-native-document', async (event, documentId, options = {}) => {
  const session = sessionForEvent(event);
  if (typeof documentId !== 'string' || !documentId) return [];
  return nativeFiles.searchNearby(session.sessionId, documentId, {
    basenameHint: typeof options?.basenameHint === 'string' ? options.basenameHint : '',
  });
});
ipcMain.handle('desktop:native-probe-read', (event, probeId) => {
  const session = sessionForEvent(event);
  if (typeof probeId !== 'string' || !probeId) throw new Error('probeId required');
  return nativeFiles.readProbe(session.sessionId, probeId);
});
ipcMain.handle('desktop:native-probe-claim', async (event, probeId) => {
  const session = sessionForEvent(event);
  if (typeof probeId !== 'string' || !probeId) return null;
  const result = await nativeFiles.claimProbe(session.sessionId, probeId);
  if (!result.ok) {
    sessions.focusSession(result.ownerSessionId);
    return { owned: true };
  }
  return { ...result.descriptor, saveTargetCreated: result.created };
});
ipcMain.handle('desktop:verify-native-pick', (event, documentId, handleId) => {
  const session = sessionForEvent(event);
  if (typeof documentId !== 'string' || !documentId) return false;
  if (typeof handleId !== 'string' || !handleId) return false;
  return nativeFiles.verifyPick(session.sessionId, documentId, handleId);
});
ipcMain.handle('desktop:document-reserve', (event, identity, nativeHandleId, slotId) => {
  const session = sessionForEvent(event);
  const canonicalPath = nativeHandleId
    ? nativeFiles.pathForSender(session.sessionId, nativeHandleId)
    : null;
  const result = documentLeases.reserve(session.sessionId, identity, canonicalPath, slotId);
  if (!result.ok) {
    // Another slot of this window holds the document; the renderer resolves that itself.
    if (result.ownerSessionId === session.sessionId) return { ok: false, reason: 'owned' };
    sessions.focusSession(result.ownerSessionId);
    if (nativeHandleId && !documentLeases.hasLease(session.sessionId)) {
      setImmediate(() => {
        if (!session.window.isDestroyed()) session.window.destroy();
      });
    }
    return { ok: false, reason: 'owned' };
  }
  return result;
});
ipcMain.handle('desktop:document-commit', (event, reservationId, slotId) => {
  const session = sessionForEvent(event);
  documentLeases.commit(session.sessionId, reservationId, slotId);
});
ipcMain.handle('desktop:document-cancel', (event, reservationId, slotId) => {
  const session = sessionForEvent(event);
  documentLeases.cancel(session.sessionId, reservationId, slotId);
});
ipcMain.handle('desktop:document-release', (event, slotId) => {
  const session = sessionForEvent(event);
  documentLeases.releaseSlot(session.sessionId, slotId);
});
ipcMain.handle('window:is-fullscreen', (event) => sessionForEvent(event).window.isFullScreen());
ipcMain.on('desktop:set-document-state', (event, state) => {
  try {
    applyDocumentState(sessionForEvent(event).window, { edited: state?.edited === true });
  } catch (error) {
    console.warn('[hamaeditor] document state update failed:', error);
  }
});
ipcMain.on('desktop:set-pending-review-count', (event, count) => {
  try {
    agentAttention.setPendingCount(sessionForEvent(event).window.id, count);
  } catch (error) {
    console.warn('[hamaeditor] pending review badge update failed:', error);
  }
});
ipcMain.on('desktop:agent-turn-finished', (event, payload) => {
  try {
    agentAttention.turnFinished(sessionForEvent(event).window, payload ?? {});
  } catch (error) {
    console.warn('[hamaeditor] agent turn notification failed:', error);
  }
});
ipcMain.handle('desktop:show-context-menu', (event, items) => {
  const window = sessionForEvent(event).window;
  return popupContextMenu({ Menu, window, items });
});
ipcMain.handle('desktop:show-unsaved-changes-sheet', (event, payload) => {
  const window = sessionForEvent(event).window;
  return showUnsavedChangesSheet({ dialog, window, fileName: payload?.fileName });
});
ipcMain.handle('desktop:close-response', async (event, requestId, allowClose) => {
  const session = sessionForEvent(event);
  if (session.pendingCloseRequestId !== requestId) return false;
  session.pendingCloseRequestId = null;
  return completeWindowClose({
    session,
    allowClose,
    cancelQuit: updateLifecycle.cancelQuit,
    persistBookmarks: () => persistNativeBookmarks({ rejectOnError: true }),
    onError: async (error) => {
      console.warn('[hamaeditor] document close failed:', error);
      await dialog.showMessageBox({
        title: PRODUCT_NAME,
        type: 'warning',
        message: 'HamaEditor could not close the document',
        detail: error?.message ?? String(error),
        buttons: ['OK'],
      });
    },
  });
});
ipcMain.handle('agent-hub:ensure', async (event) => {
  sessionForEvent(event);
  if (quitting) return { started: false, ready: false };
  const result = await hubOwner.ensure();
  return { started: result.started, ready: result.ready };
});

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  updateLifecycle.start();

  app.on('second-instance', (_event, argv, workingDirectory) => {
    queueLaunch(launchRequest({ argv, cwd: workingDirectory, source: 'second-instance' }));
  });

  app.on('open-file', (event, path) => {
    event.preventDefault();
    const request = launchRequest({ openFiles: [path], source: 'open-file' });
    const initial = pendingLaunches[0];
    if (!desktopReady && pendingLaunches.length === 1 && initial.source === 'initial' && initial.openFiles.length === 0) {
      pendingLaunches[0] = request;
      return;
    }
    queueLaunch(request);
  });

  app.whenReady().then(async () => {
    // 비밀 저장소·허브·북마크보다 먼저 2.0.11 프로필의 파일을 합친다. 실패해도 앱은 뜬다.
    await rebrandImport.prepare().catch((error) => {
      console.warn('[hamaeditor] 2.0.11 profile import failed:', error);
    });
    const owner = { launchId, profileId: userDataProfileId, pid: process.pid };
    await Promise.all([
      writeLaunchOwnerMetadata(runtimeDir, owner),
      writeLaunchOwnerMetadata(workDir, owner),
    ]);
    // 지난 실행의 찌꺼기 정리는 첫 창을 막지 않는다.
    const staleCleanup = Promise.all([
      bestEffortStartupCleanup(
        'stale runtime',
        removeStaleLaunchDirectories(runtimeRoot, launchId, {
          expectedProfileId: userDataProfileId,
        }),
      ),
      bestEffortStartupCleanup(
        'stale launch workspace',
        removeStaleLaunchDirectories(workRoot, launchId, {
          expectedProfileId: userDataProfileId,
        }),
      ),
      bestEffortStartupCleanup(
        'legacy runtime',
        removeLegacyLaunchDirectories(legacyRuntimeRoot, launchId),
      ),
      bestEffortStartupCleanup(
        'legacy launch workspace',
        removeLegacyLaunchDirectories(legacyWorkRoot, launchId),
      ),
      bestEffortStartupCleanup(
        '2.0.11 runtime',
        rebrandedRuntimeRoots(app.getPath('temp')).then((roots) => Promise.all(roots.map((root) => (
          removeStaleLaunchDirectories(root, launchId, { markers: REBRANDED_LAUNCH_MARKERS })
        )))),
      ),
    ]);
    if (devUrl) {
      await bestEffortStartupCleanup(
        'development browser cache',
        prepareDevelopmentCaches(
          electronSession.defaultSession,
          join(runtimeDir, 'code-cache'),
        ),
      );
    }
    secretVault = createSecretVault({
      filePath: join(app.getPath('userData'), 'secrets.json'),
      safeStorage,
    });
    // 2.0.10까지 Cloud·계정 기능이 남긴 자격 증명과 파일을 지운다. 허브의 비밀 요청보다 먼저 큐에 넣는다.
    void bestEffortStartupCleanup(
      'retired Cloud data',
      removeRetiredCloudData({ userDataDir: app.getPath('userData'), vault: secretVault }),
    );
    // 허브는 비밀 저장소가 생긴 직후 띄워 첫 창과 나란히 준비한다(허브의 비밀 요청은 이 저장소로 간다).
    // 실패는 아래에서 기다려 알린다.
    const hubStartup = hubOwner.ensure();
    hubStartup.catch(() => {});
    configureAutoUpdater();
    await loadNativeBookmarks();
    await windowFrames.load();
    installMenu();
    if (!devUrl) installStudioProtocol({ protocol, net, root: studioDist() });
    desktopReady = true;
    const launches = pendingLaunches.splice(0);
    let failedLaunches = 0;
    for (const request of launches) {
      // One unreadable file must not abort the other startup launches.
      await openLaunch(request).catch((error) => {
        failedLaunches += 1;
        showLaunchError(error);
      });
    }
    initialLaunchesOpened = true;
    if (failedLaunches > 0 && sessions.windows().length === 0) {
      resolveUniqueInstallSync();
      app.quit();
      return;
    }
    // 허브 시작 실패는 창이 뜬 뒤에도 오류 창을 띄우고 종료한다.
    await Promise.all([hubStartup, staleCleanup]);
    void finishUniqueInstallMetric();
    if (app.isPackaged && ['darwin', 'linux'].includes(process.platform)) {
      setTimeout(() => {
        void checkForAppUpdates({ manual: false });
      }, 4000);
    }
  }).catch((error) => {
    resolveUniqueInstallSync();
    // 창이 먼저 뜨므로 시작 중에 종료하면 허브 시작이 거절될 수 있다. 그때는 알리지 않는다.
    if (!quitting) showLaunchError(error);
    app.quit();
  });

  app.on('activate', () => {
    if (quitting) return;
    const windows = sessions.windows();
    if (windows.length === 0) {
      queueLaunch(launchRequest({ source: 'activate' }));
      return;
    }
    const window = windows.at(-1);
    if (window?.isMinimized()) window.restore();
    window?.focus();
    void hubOwner.ensure().catch((error) => console.warn('[hamaeditor] agent hub ensure failed:', error));
  });

  app.on('window-all-closed', () => {
    // 2.0.11 저장소를 읽는 숨은 창이 첫 Studio 창보다 먼저 닫혀도 앱을 끝내지 않는다.
    if (!initialLaunchesOpened) return;
    if (process.platform !== 'darwin') app.quit();
  });
}
