import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { rm, readFile } from 'node:fs/promises';
import { basename, dirname, extname, join, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  app,
  autoUpdater as nativeAutoUpdater,
  BrowserWindow,
  BaseWindow,
  WebContentsView,
  Menu,
  clipboard,
  dialog,
  ipcMain,
  nativeImage,
  nativeTheme,
  net,
  Notification as ElectronNotification,
  protocol,
  safeStorage,
  systemPreferences,
  webContents,
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
import { createAgentDocument, defaultAgentDocumentFolder, openAgentDocumentAtPath } from './agent-documents.mjs';
import { UnsavedDocumentRegistry } from './unsaved-documents.mjs';
import { captureDocumentRegion, installAgentContextStore } from './agent-context-store.mjs';
import { quarantineBookmarkState, readBookmarkState } from './bookmark-state.mjs';
import {
  MAX_GENERATED_DOCUMENT_BYTES,
  readGeneratedDocumentResponse,
  resolveGeneratedDocumentArtifact,
} from './generated-document-artifact.mjs';
import { launchRequest } from './launch-routing.mjs';
import {
  NativeFileHandleRegistry,
  recoverInterruptedNativeSave,
  StaleNativeHandleError,
  validateOpenedDocumentBytes,
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
  systemFontBaseUrl,
} from './studio-protocol.mjs';
import { INTERNAL_APP_NAME, PRODUCT_NAME } from './app-identity.mjs';
import { resolveProfileDirectories } from './profile-continuity.mjs';
import { createRebrandImportController } from './rebrand-import-controller.mjs';
import { createSecretVault, handleSecretRequest } from './secret-vault.mjs';
import { OwnedBrowserHost } from './browser-host.mjs';
import { BrowserAdblock, registerBrowserAdblockIpc } from './browser-adblock.mjs';
import { NativeBrowserPasswords, registerBrowserPasswordIpc } from './browser-passwords.mjs';
import { BrowserWebAuthn } from './browser-webauthn.mjs';
import { removeRetiredCloudData } from './retired-cloud-data.mjs';
import { isNewerStableVersion, selectDebAsset } from './update-policy.mjs';
import { createUpdateLifecycle, completeWindowClose } from './update-lifecycle.mjs';
import { createFakeUpdater, createUpdateController } from './update-controller.mjs';
import {
  UPDATE_RESTART_FILE_NAME,
  buildRestartManifest,
  consumeRestartManifest,
  createRestartPrepareBroker,
  restoreSliceFor,
  updateWasApplied,
} from './update-restart.mjs';
import { installAppMenu } from './app-menu.mjs';
import {
  DIAGNOSTIC_LOG_DIR,
  createDiagnosticLog,
  createLineSink,
  installProcessDiagnostics,
  teeConsole,
} from './diagnostic-log.mjs';
import { feedbackOrigin, installIssueReportHost } from './issue-report.mjs';
import { installAutofixHost } from './autofix.mjs';
import {
  AgentAttention,
  WindowFrameStore,
  applyAppUserModelId,
  clampBoundsToDisplay,
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
import { reportUniqueInstall, uniqueInstallStatePath } from './unique-install.mjs';
import { createLicenseClient, DEFAULT_LICENSE_API_BASE } from './license-client.mjs';
import { PRODUCTION_LICENSE_PUBLIC_KEYS } from './license-lease.mjs';
import { createLicenseManager, licenseStatePath, TRIAL_DURATION_MS } from './license-manager.mjs';
import { installLicenseHost } from './license-host.mjs';
import { createGiftClient } from './gift-client.mjs';
import { createGiftManager } from './gift-manager.mjs';
import { handleGiftRequest, installGiftHost, staleGiftResponse } from './gift-host.mjs';
import { createSystemFontService } from './system-fonts.mjs';
import { createFontFolderStore } from './font-folders.mjs';
import {
  nativeExtractorFileName,
  sourceStagedNativeExtractorPath,
} from './native-rhwp-path.mjs';

const { autoUpdater } = electronUpdater;
const __dirname = fileURLToPath(new URL('.', import.meta.url));
const RELEASES_URL = 'https://github.com/heemangstudio/hamaeditor-releases/releases/latest';
const RELEASES_API_URL = 'https://api.github.com/repos/heemangstudio/hamaeditor-releases/releases/latest';
const PRELOAD_PATH = join(__dirname, 'preload.cjs');
const REBRAND_EXPORT_PRELOAD_PATH = join(__dirname, 'rebrand-export-preload.cjs');
// 렌더러가 죽으면 창에 띄우는 안내 화면. 창의 프리로드를 그대로 쓴다.
const CRASH_PAGE_PATH = join(__dirname, 'crash-page.html');
const CRASH_PAGE_PATHNAME = pathToFileURL(CRASH_PAGE_PATH).pathname;
// 이보다 많이 죽은 창에는 안내 화면도 다시 띄우지 않는다(안내 화면 자체가 계속 죽는 경우).
const MAX_CRASH_PAGES = 6;
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
// macOS 에서 창을 모두 닫고 이만큼 지나면 허브를 내린다. 다음 창이 다시 띄운다.
// 개발 실행에서만 RHWP_HUB_IDLE_SUSPEND_MS 로 바꿔 시험한다.
const HUB_IDLE_SUSPEND_MS = (!app.isPackaged && Number(process.env.RHWP_HUB_IDLE_SUSPEND_MS)) || 10 * 60 * 1000;
const HUB_ACTIVITY_QUERY_TIMEOUT_MS = 5_000;
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

function isCrashPageUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== 'file:') return false;
    return process.platform === 'win32'
      ? url.pathname.toLowerCase() === CRASH_PAGE_PATHNAME.toLowerCase()
      : url.pathname === CRASH_PAGE_PATHNAME;
  } catch {
    return false;
  }
}

/** 안내 화면은 메인이 띄운 창 안에서만 IPC 를 쓸 수 있다. */
function crashPageSessionForEvent(event) {
  const senderUrl = event.senderFrame?.url || event.sender.getURL();
  if (!isCrashPageUrl(senderUrl)) throw new Error('Untrusted crash page IPC sender');
  const session = sessions.sessionForSender(event.sender);
  if (!session.crashPage) throw new Error('Window is not showing the crash page');
  return session;
}

// Electron 은 앱 이름으로 사용자 데이터 폴더와 safeStorage 키체인 항목을 정한다. 실행 내내
// 2.0.10 까지와 같은 내부 이름을 쓴다. 메뉴·대화상자에는 PRODUCT_NAME 을 직접 넘긴다.
app.setName(INTERNAL_APP_NAME);
// Windows 는 이 id 가 설치 바로가기(package.json build.appId)와 같아야 앱의 알림을 띄운다.
// 개발 실행은 실행 파일 경로를 쓴다 — 바로가기가 없고, 설치된 앱의 알림을 가로채지 않는다.
applyAppUserModelId({ app });
const profileDirectories = resolveProfileDirectories({
  packaged: app.isPackaged,
  appDataDir: app.getPath('appData'),
  env: process.env,
  developmentUserData: join(__dirname, '..', '.run', 'desktop-user-data'),
});
app.setPath('userData', profileDirectories.userData);
registerStudioScheme(protocol);
const hasSingleInstanceLock = app.requestSingleInstanceLock();
// 문제 보고에 싣는 진단 기록(userData/logs). console.warn/error 출력은 그대로 두고 함께 남긴다.
// 잠금을 쥔 인스턴스만 기록을 이어 쓴다 — 곧 끝날 두 번째 인스턴스가 같은 파일을 돌리면 안 된다.
const diagnosticLog = createDiagnosticLog({
  dir: join(app.getPath('userData'), DIAGNOSTIC_LOG_DIR),
  home: app.getPath('home'),
  secrets: [hubToken],
});
if (hasSingleInstanceLock) {
  teeConsole(diagnosticLog);
  installProcessDiagnostics(diagnosticLog);
  diagnosticLog.writeText('main', 'info', `${PRODUCT_NAME} ${app.getVersion()} started (${process.platform} ${process.arch}, Electron ${process.versions.electron}${app.isPackaged ? '' : ', development'})`);
}

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
  #suspendPromise = null;
  #startRequests = 0;
  #activityQueries = new Map();
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
    this.#startRequests += 1;
    // 창 없이 내리던 허브가 다 내려간 뒤에 새로 띄운다.
    if (this.#suspendPromise) await this.#suspendPromise;
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
        RHWP_HOME_ACCESS: '1',
        RHWP_DOCUMENTS_DIR: app.getPath('documents'),
        RHWP_RUNTIME_DIR: runtimeDir,
        RHWP_WORK_DIR: workDir,
        RHWP_AGENT_INSTRUCTIONS_DIR: join(app.getPath('userData'), 'agent-instructions'),
        RHWP_OWN_RUNTIME_DIR: '1',
        RHWP_OWN_WORK_DIR: '1',
        RHWP_SECRET_BROKER: 'ipc',
        RHWP_BROWSER_HOST: 'ipc',
        RHWP_BROWSER_DATA_DIR: join(app.getPath('userData'), 'browser'),
        // 선물 크레딧은 macOS·Windows 에서만 준다. 다른 OS 의 허브는 선물 경로를 모른다.
        ...(process.platform === 'darwin' || process.platform === 'win32' ? { RHWP_GIFT_BROKER: 'ipc' } : {}),
        ...(rhwpExecutable ? { RHWP_BIN: rhwpExecutable } : {}),
      },
    });
    if (!launch) throw new Error(`Agent hub launch command not found: ${server}`);
    launch.cwd = workDir;

    console.log(`[hamaeditor] starting owned agent hub via ${launch.via}`);
    const child = spawnHubProcess(launch, {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      onMessage: (message, source) => {
        if (message?.type === 'rhwp-browser-request') {
          if (source !== this.#child || this.#stoppingChild === source || this.#disposed || quitting) {
            if (source.connected) source.send({ type: 'rhwp-browser-response', id: message.id, ok: false,
              error: { code: 'NATIVE_BROWSER_OWNER_STALE', message: 'The desktop browser owner is stopping.' } });
            return;
          }
          void browserHost.handleRequest(message, source).then((response) => {
            if (response && source.connected) source.send(response);
          });
          return;
        }
        if (message?.type === 'rhwp-activity-response') {
          if (source === this.#child && typeof message.id === 'string') this.#activityQueries.get(message.id)?.(message.busy !== false);
          return;
        }
        if (message?.type === 'rhwp-gift-request') {
          if (source !== this.#child || this.#stoppingChild === source || this.#disposed || quitting) {
            if (source.connected) source.send(staleGiftResponse(message));
            return;
          }
          void handleGiftRequest(giftManager, message).then((response) => {
            if (response && source.connected) source.send(response);
          });
          return;
        }
        if (!secretVault) return;
        void handleSecretRequest(secretVault, message).then((response) => {
          if (response && source.connected) source.send(response);
        });
      },
      onError: (error) => {
        console.warn('[hamaeditor] agent hub spawn error:', error);
      },
      onExit: (code, signal) => {
        void browserHost.release(child).catch(() => {});
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
    // 허브 stderr 는 터미널로도 그대로 가고, 진단 기록에도 줄 단위로 남는다(조각 경계에 걸린 비밀도 가린다).
    const hubStderr = createLineSink((text) => diagnosticLog.writeText('hub', 'log', text));
    child.stderr?.on('data', (chunk) => hubStderr.write(chunk));
    child.stderr?.on('end', () => hubStderr.end());
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

  /** 허브에 도는 일(에이전트 턴, 레이아웃 작업, 다운로드, 설치)이 남았는지 묻는다. 답이 없으면 바쁘다고 본다. */
  #queryActivity(child) {
    return new Promise((resolve) => {
      const id = randomUUID();
      const finish = (busy) => {
        clearTimeout(timer);
        this.#activityQueries.delete(id);
        resolve(busy);
      };
      const timer = setTimeout(() => finish(true), HUB_ACTIVITY_QUERY_TIMEOUT_MS);
      this.#activityQueries.set(id, finish);
      try {
        child.send({ type: 'rhwp-activity-query', id }, (error) => { if (error) finish(true); });
      } catch {
        finish(true);
      }
    });
  }

  /**
   * 창이 모두 닫혀 쓰지 않는 허브를 내린다. 종료 경로는 앱을 끝낼 때와 같고, 다음 ensure() 가 다시 띄운다.
   * 그 사이에 허브를 찾은 요청이 있거나 할 일이 남았으면 그대로 둔다.
   * @returns {Promise<'suspended'|'busy'|'skipped'>}
   */
  async suspend({ stillIdle = () => true } = {}) {
    if (this.#disposed || quitting || this.#suspendPromise || this.#startPromise) return 'skipped';
    const child = this.#child;
    if (!child || !this.#context || !child.connected || this.#stoppingChild === child) return 'skipped';
    const requests = this.#startRequests;
    const busy = await this.#queryActivity(child);
    if (this.#disposed || quitting || child !== this.#child || this.#startPromise || requests !== this.#startRequests || !stillIdle()) {
      return 'skipped';
    }
    if (busy) return 'busy';
    this.clearRestart();
    console.log('[hamaeditor] no windows are open; stopping the idle agent hub');
    this.#suspendPromise = this.stopCurrent().then(
      () => 'suspended',
      (error) => {
        console.warn('[hamaeditor] idle agent hub stop failed:', error);
        return 'skipped';
      },
    ).finally(() => { this.#suspendPromise = null; });
    return this.#suspendPromise;
  }

  /** 선물 크레딧 상태가 바뀌었다고 지금 허브에 알린다. 허브가 다시 자격 증명을 묻는다. */
  notifyGiftChanged() {
    const child = this.#child;
    if (!child || this.#stoppingChild === child || this.#disposed || quitting || !child.connected) return;
    try { child.send({ type: 'rhwp-gift-changed' }); } catch { /* 끝나는 자식 */ }
  }

  teardown() {
    if (this.#stopPromise) return this.#stopPromise;
    this.#disposed = true;
    this.clearRestart();
    this.#stopPromise = (async () => {
      await this.#suspendPromise;
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

let hubSuspendTimer = null;
function cancelHubSuspend() {
  if (hubSuspendTimer) clearTimeout(hubSuspendTimer);
  hubSuspendTimer = null;
}
/** macOS 는 창을 모두 닫아도 앱이 남는다. 그동안 쓰지 않는 허브(와 앱 안 브라우저)를 내린다. */
function scheduleHubSuspend() {
  cancelHubSuspend();
  if (process.platform !== 'darwin' || quitting) return;
  hubSuspendTimer = setTimeout(() => {
    hubSuspendTimer = null;
    const stillIdle = () => !quitting && BrowserWindow.getAllWindows().length === 0;
    if (!stillIdle()) return;
    void hubOwner.suspend({ stillIdle }).then((result) => {
      if (result === 'busy' && stillIdle()) scheduleHubSuspend();
    });
  }, HUB_IDLE_SUSPEND_MS);
  hubSuspendTimer.unref?.();
}

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
const browserHost = new OwnedBrowserHost({
  BrowserWindow,
  BaseWindow,
  WebContentsView,
  electronSession,
  dataDir: join(app.getPath('userData'), 'browser'),
  getWindowForSession: (sessionId) => {
    const session = sessions.sessionById(sessionId);
    if (session) return session.window;
    return sessions.windows().find((window) => (
      sessions.sessionForSender(window.webContents).agentSessionIds.has(sessionId)
    )) ?? null;
  },
});
const browserAdblock = new BrowserAdblock({ host: browserHost, ipcMain });
new NativeBrowserPasswords({
  host: browserHost,
  dataDir: join(app.getPath('userData'), 'browser', 'password-vault'),
  safeStorage,
  Menu,
});
const browserWebAuthn = new BrowserWebAuthn({
  app, dialog, systemPreferences,
  getTabForFrame: (frame) => {
    const contents = webContents.fromFrame(frame);
    return [...browserHost.tabs.values()].find((tab) => !tab.closing && tab.view.webContents === contents);
  },
  getWindowForTab: (tab) => tab.placement?.window ?? browserHost.getWindowForSession(tab.sessionId),
  onState: (tab, extra) => browserHost.emit(tab, 'authentication', extra),
  onSignIn: (tab, extra) => browserHost.emit(tab, 'sign-in', extra),
});
browserHost.webAuthn = browserWebAuthn;
const documentLeases = new DocumentLeaseManager();
const nativeFiles = new NativeFileHandleRegistry();
const nativeBookmarkFile = join(app.getPath('userData'), 'native-document-bookmarks.json');
const logFonts = (line) => console.log(`[hamaeditor] fonts: ${line}`);
const SYSTEM_FONT_REVALIDATE_DELAY_MS = 10_000;
const fontFolders = createFontFolderStore({
  filePath: join(app.getPath('userData'), 'font-folders.json'),
  writeAtomically: writeNativeFileAtomically,
  log: logFonts,
});
const systemFonts = createSystemFontService({
  cacheDir: join(app.getPath('userData'), 'fonts'),
  log: logFonts,
  addedFolders: () => fontFolders.list(),
  // 실행마다 Program Files 를 훑고 reg.exe 를 부르지 않도록 지난 색인으로 먼저 열고,
  // 첫 문서를 여는 동안은 비켜 있다가 다시 훑는다. 달라졌으면 열린 창이 글꼴을 다시 잇는다.
  revalidateAfterMs: SYSTEM_FONT_REVALIDATE_DELAY_MS,
  // 업데이트 뒤 첫 실행은 예전 버전이 조립한 색인 대신 새로 훑는다.
  savedIndexKey: app.getVersion(),
  onIndexChanged: () => broadcastFontsChanged(),
});
const systemFontKey = randomBytes(32).toString('hex');
async function reportUniqueInstallMetric() {
  try {
    await reportUniqueInstall({
      userDataDir: app.getPath('userData'),
      packaged: app.isPackaged,
      devUrl,
      appVersion: app.getVersion(),
      os: process.platform,
      arch: process.arch,
    });
  } catch (error) {
    console.warn('[hamaeditor] unique install ping failed:', error);
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
const agentAttention = new AgentAttention({ app, Notification: ElectronNotification, nativeImage });
const unsavedDocuments = new UnsavedDocumentRegistry();

/** 저장하지 않은 새 문서 목록을 모든 창에 보낸다. 창마다 자기 문서는 local 로 받는다. */
function broadcastUnsavedDocuments() {
  for (const window of sessions.windows()) {
    try {
      const session = sessions.sessionForSender(window.webContents);
      window.webContents.send('desktop:unsaved-documents-changed', unsavedDocuments.listFor(session.sessionId));
    } catch {
      // 닫히는 중인 창은 건너뛴다.
    }
  }
}

function forgetUnsavedDocuments(sessionId) {
  if (unsavedDocuments.forget(sessionId)) broadcastUnsavedDocuments();
}

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
    // 북마크도 문서와 같은 원자적 저장을 쓴다. 저장 도중 꺼졌으면 직전 내용을 되돌린다.
    await recoverInterruptedNativeSave(nativeBookmarkFile);
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

// 자동 수정은 아래에서 설치된다. 그 전에 앱이 끝나도 정리 단계가 그대로 돌게 빈 함수로 시작한다.
let disposeAutofix = async () => {};
const updateLifecycle = createUpdateLifecycle({
  app,
  updater: autoUpdater,
  nativeUpdater: nativeAutoUpdater,
  platform: process.platform,
  cleanup: async () => {
    // 도는 자동 수정 에이전트를 멈추고 그 프로세스 트리 정리가 끝날 때까지 기다린다.
    await disposeAutofix();
    await hubOwner.teardown();
    await browserHost.dispose();
  },
  onQuitRequested: (requested) => { quitRequested = requested; browserHost.setQuitRequested(requested); },
  onTeardown: () => { quitting = true; },
});
// 개발 실행에서만 RHWP_FAKE_UPDATE=<버전> 으로 업데이트 흐름을 흉내 낸다. 설치는 하지 않고 다시 실행한다.
const fakeUpdateVersion = app.isPackaged ? null : (String(process.env.RHWP_FAKE_UPDATE ?? '').trim() || null);
const updateRestartFile = join(app.getPath('userData'), UPDATE_RESTART_FILE_NAME);
const updatePrepareBroker = createRestartPrepareBroker();
// 업데이트 재시작으로 창을 닫는 중이면 렌더러의 beforeunload 확인도 건너뛴다.
let updateRestartClosing = false;
let updates = null;

function broadcastUpdateState(state) {
  for (const window of sessions.windows()) {
    if (!window.webContents.isDestroyed()) window.webContents.send('desktop:update-state', state);
  }
}

async function checkForDebUpdates() {
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
  if (!isNewerStableVersion(release?.tag_name, app.getVersion())) return null;
  const asset = selectDebAsset(release?.assets, process.arch);
  return {
    version: String(release.tag_name).replace(/^v/i, ''),
    url: asset?.browser_download_url ?? release?.html_url ?? RELEASES_URL,
  };
}

function updateMode() {
  if (fakeUpdateVersion) return 'in-app';
  if (!app.isPackaged) return 'disabled';
  if (process.platform === 'darwin' || process.platform === 'win32') return 'in-app';
  // Debian packages stay under the system package manager and only link to the signed release.
  if (process.platform === 'linux') return process.env.APPIMAGE ? 'in-app' : 'external';
  return 'disabled';
}

function liveWindowSessions() {
  return sessions.windows().map((window) => sessions.sessionForSender(window.webContents));
}

/**
 * 모든 창이 준비하고(문서 정리·확인), 모두 응하면 확정한다(마지막 저장·닫기 확인 해제). 그 뒤에만 창 목록을
 * 남기고, 확인 없이 창을 닫고 설치로 넘긴다. 어느 단계에서 멈추면 그 뒤로는 아무것도 보내지 않는다.
 */
async function restartForUpdate(state) {
  const targets = liveWindowSessions()
    // 문서를 띄우지 못한 창은 넘길 것이 없다.
    .filter((session) => session.rendererLoaded && !session.rendererLoadFailed && !session.window.webContents.isCrashed())
    .map((session) => ({
      session,
      windowId: session.sessionId,
      isOpen: () => !session.window.isDestroyed(),
      send: (phase, requestId) => session.window.webContents.send(`desktop:update-${phase}-restart`, { requestId }),
    }));
  const handedOff = await updatePrepareBroker.handOff(targets);
  if (!handedOff.ok) throw new Error(`The windows did not hand over (${handedOff.reason}).`);
  const focused = BrowserWindow.getFocusedWindow();
  // 초점이 있던 창을 마지막에 다시 열어 맨 앞에 둔다.
  const restored = targets
    .filter(({ session }) => handedOff.slices.has(session.sessionId) && !session.window.isDestroyed())
    .sort((a, b) => Number(a.session.window === focused) - Number(b.session.window === focused));
  const manifest = buildRestartManifest({
    fromVersion: app.getVersion(),
    targetVersion: state.version,
    createdAt: Date.now(),
    fake: Boolean(fakeUpdateVersion),
    windows: restored.map(({ session }) => ({
      bounds: session.window.getNormalBounds(),
      maximized: session.window.isMaximized(),
      slice: handedOff.slices.get(session.sessionId),
      pathForHandle: (handleId) => nativeFiles.sourcePathForSender(session.sessionId, handleId),
    })),
  });
  try {
    await persistNativeBookmarks({ rejectOnError: true });
    await writeNativeFileAtomically(updateRestartFile, Buffer.from(JSON.stringify(manifest), 'utf8'));
    // 렌더러가 남긴 복구 기록(localStorage)을 설치가 프로세스를 끝내기 전에 디스크에 쓴다.
    electronSession.defaultSession.flushStorageData();
  } catch (error) {
    // 멈춘 재시작의 창 목록이 다음 실행에서 창을 다시 열지 않게 한다.
    await rm(updateRestartFile, { force: true }).catch(() => {});
    throw error;
  }
  updateRestartClosing = true;
  // 열린 닫기 확인의 답이 설치를 멈추지 않게 한다. 설치로 넘기지 못하면 되돌린다.
  const closeStates = liveWindowSessions().map((session) => [session, session.allowCloseOnce, session.pendingCloseRequestId]);
  for (const [session] of closeStates) {
    session.allowCloseOnce = true;
    session.pendingCloseRequestId = null;
  }
  if (updateLifecycle.requestInstall({ relaunchOnly: Boolean(fakeUpdateVersion) })) return true;
  updateRestartClosing = false;
  for (const [session, allowCloseOnce, pendingCloseRequestId] of closeStates) {
    session.allowCloseOnce = allowCloseOnce;
    session.pendingCloseRequestId = pendingCloseRequestId;
  }
  await rm(updateRestartFile, { force: true }).catch(() => {});
  return false;
}

function configureAutoUpdater({ restartManifest }) {
  autoUpdater.logger = console;
  updateLifecycle.configureUpdates();
  const mode = updateMode();
  const applied = restartManifest ? updateWasApplied(restartManifest, app.getVersion()) : false;
  updates = createUpdateController({
    currentVersion: app.getVersion(),
    mode,
    updater: mode !== 'in-app' ? null
      : fakeUpdateVersion ? createFakeUpdater({ version: fakeUpdateVersion, applied })
        : autoUpdater,
    checkExternal: checkForDebUpdates,
    openExternal: (url) => shell.openExternal(url),
    broadcast: broadcastUpdateState,
    restartApp: restartForUpdate,
  });
  if (restartManifest && !applied) updates.markNotApplied(restartManifest.targetVersion);
}

function installMenu() {
  appMenu = installAppMenu({
    agentEnabled: () => licenseAllowsAgent,
    checkForUpdates: () => {
      if (!app.isPackaged && !fakeUpdateVersion) {
        void shell.openExternal(RELEASES_URL);
        return;
      }
      void updates?.check({ manual: true });
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

function updateRestartFrame(entry) {
  if (!entry.bounds) return null;
  const { workArea } = screen.getDisplayMatching(entry.bounds);
  return {
    bounds: clampBoundsToDisplay(entry.bounds, workArea, { width: 900, height: 640 }),
    zoomed: entry.maximized,
  };
}

function cascadedWindowPosition() {
  const source = BrowserWindow.getFocusedWindow() ?? sessions.windows().at(-1);
  if (!source || source.isDestroyed()) return {};
  const bounds = source.getBounds();
  return { x: bounds.x + 28, y: bounds.y + 28 };
}

// 앱 테마(프리셋·밝게·어둡게)의 바탕색. 창이 내용보다 먼저 그리는 배경과 다음 새 창의 배경에 쓴다.
let lastWindowBackground = null;

async function createWindow(launch = launchRequest(), {
  generatedDocument = null,
  updateRestore = null,
  restoredDocumentIds = [],
} = {}) {
  // 허브는 창과 나란히 뜬다. 렌더러의 세션 문맥 요청(desktop:get-session-context)이
  // 허브 준비를 기다리므로 창 생성은 허브를 막지 않는다. 창 없이 내렸던 허브도 여기서 다시 뜬다.
  cancelHubSuspend();
  void hubOwner.ensure().catch(() => {});
  // 렌더러가 테마의 바탕색을 알려 주면 새 창도 그 색으로 연다(앱을 다시 켜면 시스템 색으로 시작한다).
  const backgroundColor = lastWindowBackground ?? (nativeTheme.shouldUseDarkColors ? '#141416' : '#f5f5f7');
  const isMac = process.platform === 'darwin';
  // 실행 후 첫 창만 지난 프레임을 되살리고, 이후 창은 28px 계단식으로 연다.
  // 업데이트 재시작으로 다시 여는 창은 재시작 전 자리에 연다.
  const restoredFrame = updateRestore
    ? updateRestartFrame(updateRestore)
    : sessions.windows().length === 0
      ? windowFrames.takeInitialFrame({ minWidth: 900, minHeight: 640 })
      : null;
  const window = new BrowserWindow({
    ...(restoredFrame ? restoredFrame.bounds : { ...cascadedWindowPosition(), width: 1440, height: 920 }),
    title: 'HamaEditor',
    minWidth: 900,
    minHeight: 640,
    show: false,
    backgroundColor,
    autoHideMenuBar: process.platform === 'win32',
    ...(isMac ? {
      titleBarStyle: 'hidden',
      trafficLightPosition: { x: 14, y: 12 },
    } : process.platform === 'win32' ? {
      titleBarStyle: 'hidden',
      titleBarOverlay: {
        color: '#00000000',
        symbolColor: nativeTheme.shouldUseDarkColors ? '#e6e6e6' : '#171b22',
        height: 38,
      },
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
  // 자동 저장본 복구는 앱의 첫 창만 묻는다. 다른 창에서 띄운 창(새 창에서 열기·새 윈도우)은 바로 문서를 연다.
  const offersAutosaveRecovery = sessions.windows().length === 0;
  const session = sessions.addWindow(window, { source: launch.source, openFiles: [] });
  session.offersAutosaveRecovery = offersAutosaveRecovery;
  session.generatedDocument = generatedDocument
    ? { launchDocumentId: randomUUID(), ...generatedDocument }
    : null;
  session.updateRestore = null;
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
    // 안내 화면에는 문서가 없다.
    if (session.crashPage) return;
    event.preventDefault();
    if (!session.rendererLoaded) {
      session.closeDeferred = true;
      return;
    }
    requestRendererClose();
  });
  window.on('closed', () => {
    browserHost.detachWindow(window);
    agentAttention.forget(windowId);
    releaseRendererDocuments(session.sessionId, { documentLeases, nativeFiles });
    // 창의 추가 에이전트 세션도 함께 허브에서 닫힌다.
    sessions.removeWindow(window);
    forgetUnsavedDocuments(session.sessionId);
    updates?.forgetRunningChats(session.sessionId);
    updatePrepareBroker.drop(session.sessionId);
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
    if (updateRestore) {
      session.updateRestore = await restoreSliceFor(updateRestore, {
        restoredDocumentIds,
        register: async (filePath) => {
          const result = await nativeFiles.create(session.sessionId, filePath);
          return result.ok ? { ...result.descriptor, saveTargetCreated: result.created } : null;
        },
      });
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
    console.warn('[hamaeditor] renderer process gone:', details?.reason, `exit ${details?.exitCode ?? '?'}`);
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
    forgetUnsavedDocuments(session.sessionId);
    updates?.forgetRunningChats(session.sessionId);
    // 비정상 종료면 빈 창 대신 안내 화면을 띄운다. 첫 번째는 다시 열기, 두 번째부터는 자동 수정을 권한다.
    if (details?.reason === 'clean-exit' || quitting || updateRestartClosing || window.isDestroyed()) return;
    session.crashCount = (session.crashCount ?? 0) + 1;
    if (session.crashCount > MAX_CRASH_PAGES) return;
    session.crashPage = true;
    session.crashReason = `${details?.reason ?? 'unknown'}, exit ${details?.exitCode ?? '?'}`;
    setImmediate(() => showCrashPage(window, session));
  });
  // A reloaded page knows only its window session and reopens the default
  // document itself. Background documents and their agents died with the old page.
  window.webContents.on('did-navigate', () => {
    sessions.releaseAgentSessions(window);
    documentLeases.releaseSession(session.sessionId, { keepDefaultSlot: true });
    // 다시 불러온 페이지가 자기 새 문서를 다시 알린다.
    forgetUnsavedDocuments(session.sessionId);
    updates?.forgetRunningChats(session.sessionId);
  });
  // 업데이트 재시작은 문서를 이미 넘겨받았다. 저장 안 한 문서의 beforeunload 가 닫기를 막지 않게 한다.
  window.webContents.on('will-prevent-unload', (event) => {
    if (updateRestartClosing) event.preventDefault();
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
    if (session.crashPage) {
      if (session.closeDeferred && !window.isDestroyed()) {
        session.closeDeferred = false;
        window.close();
      }
      return;
    }
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

function showCrashPage(window, session) {
  if (window.isDestroyed() || !session.crashPage) return;
  const mode = session.crashCount >= 2 || session.crashReopenFailed ? 'autofix' : 'reopen';
  void window.loadFile(CRASH_PAGE_PATH, {
    query: { mode, reason: session.crashReason ?? 'unknown', crashes: String(session.crashCount ?? 1) },
  }).catch((error) => {
    if (error?.code !== 'ERR_ABORTED') console.warn('[hamaeditor] crash page failed to load:', error);
  });
}

/** 안내 화면의 다시 열기(또는 자동 수정 뒤): 편집기를 평소처럼 다시 불러온다. 실패하면 자동 수정을 권한다. */
async function reopenAfterCrash(window, session) {
  if (window.isDestroyed() || !session.crashPage) return;
  session.crashPage = false;
  try {
    await window.loadURL(devUrl || STUDIO_URL);
  } catch (error) {
    // 다시 죽어서 안내 화면이 이미 이 불러오기를 끊었다.
    if (window.isDestroyed() || session.crashPage) return;
    console.warn('[hamaeditor] reopen after crash failed:', error?.code ?? error);
    session.crashPage = true;
    session.crashReopenFailed = true;
    showCrashPage(window, session);
  }
}

ipcMain.handle('desktop:crash-page-reopen', (event) => {
  const session = crashPageSessionForEvent(event);
  void reopenAfterCrash(session.window, session);
});

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

installAgentContextStore({
  ipcMain, sessionForEvent,
  rootDir: join(app.getPath('userData'), 'document-captures'),
  capturePageForEvent(event, rect) {
    const { window } = sessionForEvent(event);
    const bounds = window.getContentBounds();
    return captureDocumentRegion({
      webContents: window.webContents,
      bounds: { ...bounds, scaleFactor: screen.getDisplayMatching(bounds).scaleFactor },
      rect,
    });
  },
});

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

// ── 체험·라이선스 ─────────────────────────────────────────────────────────
// 출시 빌드만 막는다. 소스에서 실행하면 HAMA_LICENSE_GATE=on 일 때만 막고, 그때만
// HAMA_LICENSE_API_BASE·HAMA_LICENSE_DEV_PUBLIC_KEY(kid:base64)로 시험용 키 서버를 쓸 수 있다.
function licensePublicKeys() {
  const dev = !app.isPackaged ? String(process.env.HAMA_LICENSE_DEV_PUBLIC_KEY ?? '') : '';
  const split = dev.indexOf(':');
  if (split <= 0) return PRODUCTION_LICENSE_PUBLIC_KEYS;
  return { ...PRODUCTION_LICENSE_PUBLIC_KEYS, [dev.slice(0, split)]: dev.slice(split + 1) };
}
// 라이선스가 읽기 전용이면 앱은 문서 보기 전용이다. 메뉴의 에이전트 항목도 끈다.
let licenseAllowsAgent = true;
let appMenu = null;
function noteLicenseStatus(status) {
  licenseAllowsAgent = status?.canEdit !== false;
  appMenu?.refresh();
}
/** 소스 실행에서만 HAMA_LICENSE_DEV_TRIAL_MS 로 체험 길이를 줄여 시험한다. 출시 빌드는 늘 3일이다. */
function licenseTrialDurationMs() {
  if (app.isPackaged) return TRIAL_DURATION_MS;
  const value = Number(process.env.HAMA_LICENSE_DEV_TRIAL_MS);
  return Number.isSafeInteger(value) && value > 0 ? value : TRIAL_DURATION_MS;
}
const licenseApiBase = (!app.isPackaged && process.env.HAMA_LICENSE_API_BASE) || DEFAULT_LICENSE_API_BASE;
const isTrustedStudioEvent = (event) => {
  try {
    sessionForEvent(event);
    return true;
  } catch {
    return false;
  }
};
const studioWebContents = () => sessions.windows().map((window) => window.webContents);
// 선물 크레딧(macOS·Windows): 키 서버와 같은 주소에 라이선스 lease 로 묻는다.
const giftManager = createGiftManager({
  client: createGiftClient({ baseUrl: licenseApiBase }),
  currentLease: () => licenseManager.currentLease(),
  platform: process.platform,
  onChange: (status) => {
    giftHost.broadcast(status);
    hubOwner.notifyGiftChanged();
  },
});
const giftHost = installGiftHost({ ipcMain, manager: giftManager, isTrustedStudioEvent, studioWebContents });
const licenseManager = createLicenseManager({
  statePath: licenseStatePath(app.getPath('userData')),
  trialDurationMs: licenseTrialDurationMs(),
  client: createLicenseClient({ baseUrl: licenseApiBase }),
  publicKeys: licensePublicKeys(),
  existingInstallId: async () => {
    try {
      return JSON.parse(await readFile(uniqueInstallStatePath(app.getPath('userData')), 'utf8')).installId ?? null;
    } catch { return null; }
  },
  appVersion: app.getVersion(),
  platform: process.platform,
  enforce: app.isPackaged || process.env.HAMA_LICENSE_GATE === 'on',
  onChange: (status) => {
    noteLicenseStatus(status);
    licenseHost.broadcast(status);
    void giftManager.licenseChanged().catch((error) => console.warn('[hamaeditor] gift refresh failed:', error));
  },
});
const licenseHost = installLicenseHost({
  ipcMain,
  BrowserWindow,
  shell,
  clipboard,
  manager: licenseManager,
  isTrustedStudioEvent,
  studioWebContents,
  parentWindow: () => BrowserWindow.getFocusedWindow() ?? sessions.windows().at(-1) ?? null,
});

// ── 문제 보고 ─────────────────────────────────────────────────────────────
installIssueReportHost({
  ipcMain,
  sessionForEvent,
  diagnosticLog,
  userDataDir: app.getPath('userData'),
  appInfo: () => ({
    appVersion: app.getVersion(),
    os: process.platform,
    osVersion: process.getSystemVersion(),
    arch: process.arch,
    locale: app.getLocale(),
    electron: process.versions.electron,
    packaged: app.isPackaged,
  }),
  licenseStatus: () => licenseManager.status(),
  origin: feedbackOrigin({ packaged: app.isPackaged }),
  fetchImpl: (url, init) => net.fetch(url, init),
});
// ── 자동 수정 ─────────────────────────────────────────────────────────────
const autofix = installAutofixHost({
  ipcMain,
  // 편집기와 렌더러가 죽은 창의 안내 화면에서 부를 수 있다.
  sessionForEvent: (event) => {
    const senderUrl = event.senderFrame?.url || event.sender.getURL();
    return isCrashPageUrl(senderUrl) ? crashPageSessionForEvent(event) : sessionForEvent(event);
  },
  diagnosticLog,
  userDataDir: app.getPath('userData'),
  appInfo: () => ({
    appVersion: app.getVersion(),
    os: process.platform,
    osVersion: process.getSystemVersion(),
    arch: process.arch,
    locale: app.getLocale(),
    electron: process.versions.electron,
    packaged: app.isPackaged,
  }),
  origin: feedbackOrigin({ packaged: app.isPackaged }),
  fetchImpl: (url, init) => net.fetch(url, init),
  secretStore: () => secretVault,
  // Codex·Claude 를 둘 다 쓸 수 없을 때의 마지막 수단. 받은 선물에 잔액이 있을 때만 쓴다.
  giftCredentials: () => giftManager.credentials(),
  broadcast: (channel, value) => {
    for (const window of sessions.windows()) {
      if (!window.webContents.isDestroyed()) window.webContents.send(channel, value);
    }
  },
  paths: {
    'App install folder (read-only)': app.getAppPath(),
    'Agent hub source (read-only)': agentScript(),
    'Agent hub runtime folder': launchStorage.runtimeRoot,
    'Agent hub work folder': launchStorage.workRoot,
  },
  unpacked: unpackedPath,
});
disposeAutofix = () => autofix.dispose();
// 렌더러 오류. 렌더러가 줄이고 겹친 것을 묶어 보내지만, 메인도 창마다 1분에 120줄까지만 받는다.
const RENDERER_LOG_PER_MINUTE = 120;
const rendererLogBudget = new Map();
ipcMain.on('desktop:diagnostic-log', (event, entries) => {
  let session;
  try {
    session = sessionForEvent(event);
  } catch {
    return;
  }
  if (!Array.isArray(entries)) return;
  const now = Date.now();
  const id = event.sender.id;
  let budget = rendererLogBudget.get(id);
  if (!budget || now - budget.since > 60_000) {
    if (!budget) event.sender.once('destroyed', () => rendererLogBudget.delete(id));
    budget = { since: now, used: 0, dropped: 0 };
    rendererLogBudget.set(id, budget);
  }
  const source = `renderer:${session.window.id}`;
  for (const entry of entries.slice(0, 40)) {
    if (budget.used >= RENDERER_LOG_PER_MINUTE) {
      budget.dropped += 1;
      if (budget.dropped === 1) diagnosticLog.writeText(source, 'warn', 'renderer log budget exhausted; dropping entries for this minute');
      continue;
    }
    budget.used += 1;
    const level = entry?.level === 'warn' ? 'warn' : 'error';
    const text = typeof entry?.text === 'string' ? entry.text.slice(0, 8192) : '';
    if (text) diagnosticLog.writeText(source, level, text);
  }
});
// GPU·네트워크·유틸리티 프로세스가 비정상으로 끝나면 남긴다.
app.on('child-process-gone', (_event, details) => {
  if (details?.reason === 'clean-exit') return;
  console.warn('[hamaeditor] child process gone:', details?.type, details?.name ?? '', details?.reason, `exit ${details?.exitCode ?? '?'}`);
});
app.on('will-quit', () => diagnosticLog.flushSync());

ipcMain.handle('desktop:get-session-context', (event, agentSessionId = null) => {
  sessionForEvent(event);
  return sessions.contextForSender(event.sender, agentSessionId);
});
ipcMain.handle('desktop:agent-session-create', (event) => {
  sessionForEvent(event);
  if (quitting) throw new Error('HamaEditor is quitting');
  return { sessionId: sessions.addAgentSession(event.sender) };
});
ipcMain.handle('desktop:agent-session-release', (event, agentSessionId) => {
  sessionForEvent(event);
  return sessions.releaseAgentSession(event.sender, agentSessionId);
});
ipcMain.handle('desktop:fonts-list', (event, options = {}) => {
  sessionForEvent(event);
  assertSystemFontsEnabled();
  return systemFonts.list({ refresh: options?.refresh === true });
});
function assertSystemFontsEnabled() {
  if (process.env.RHWP_SYSTEM_FONTS === 'off') throw new Error('System font discovery is disabled');
}
/** 글꼴 폴더 목록을 바꾼 뒤 색인을 다시 만들고, 모든 창에 새 색인을 받아 문서 글꼴을 다시 잇게 한다. */
async function changeFontFolders(change) {
  const folders = await change();
  await systemFonts.list({ refresh: true });
  broadcastFontsChanged();
  return folders;
}
function broadcastFontsChanged() {
  for (const window of sessions.windows()) {
    if (!window.isDestroyed()) window.webContents.send('desktop:fonts-changed');
  }
}
ipcMain.handle('desktop:font-folders-list', (event) => {
  sessionForEvent(event);
  assertSystemFontsEnabled();
  return fontFolders.list();
});
ipcMain.handle('desktop:font-folders-add', async (event) => {
  sessionForEvent(event);
  assertSystemFontsEnabled();
  const window = BrowserWindow.fromWebContents(event.sender);
  if (!window) throw new Error('Font folder sender window is unavailable');
  const picked = await dialog.showOpenDialog(window, {
    title: 'Add font folder',
    properties: ['openDirectory'],
  });
  if (picked.canceled || !picked.filePaths[0]) return null;
  return changeFontFolders(() => fontFolders.add(picked.filePaths[0]));
});
ipcMain.handle('desktop:font-folders-remove', (event, folder) => {
  sessionForEvent(event);
  assertSystemFontsEnabled();
  if (typeof folder !== 'string' || !folder) throw new Error('Font folder path is required');
  return changeFontFolders(() => fontFolders.remove(folder));
});
ipcMain.handle('desktop:font-name-tables', (event, ids) => {
  sessionForEvent(event);
  assertSystemFontsEnabled();
  return systemFonts.nameTables(ids);
});
ipcMain.handle('desktop:fonts-base', (event) => {
  sessionForEvent(event);
  return systemFontBaseUrl(systemFontKey);
});
ipcMain.handle('desktop:get-launch-files', (event) => {
  const session = sessionForEvent(event);
  return nativeFiles.descriptorsForSession(session.sessionId);
});
ipcMain.handle('desktop:get-launch-generated-document', (event) => {
  const session = sessionForEvent(event);
  return session.generatedDocument;
});
ipcMain.handle('desktop:offers-autosave-recovery', (event) => sessionForEvent(event).offersAutosaveRecovery === true);
// 업데이트: 상태는 모든 창에 desktop:update-state 로 간다. 재시작은 창마다 문서를 넘겨받은 뒤에만 한다.
ipcMain.handle('desktop:update-get-state', (event) => {
  sessionForEvent(event);
  return updates?.state() ?? null;
});
ipcMain.handle('desktop:update-check', async (event) => {
  sessionForEvent(event);
  await updates?.check({ manual: true });
});
ipcMain.handle('desktop:update-download', async (event) => {
  sessionForEvent(event);
  await updates?.download();
});
ipcMain.handle('desktop:update-restart', (event) => {
  sessionForEvent(event);
  return updates?.restart() ?? { ok: false };
});
ipcMain.on('desktop:update-running-chats', (event, count) => {
  try {
    updates?.setRunningChats(sessionForEvent(event).sessionId, count);
  } catch (error) {
    console.warn('[hamaeditor] running chat count update failed:', error);
  }
});
for (const phase of ['prepare', 'commit']) {
  ipcMain.handle(`desktop:update-${phase}-response`, (event, requestId, slice) => (
    updatePrepareBroker.respond(sessionForEvent(event).sessionId, requestId, slice)
  ));
}
// 재시작 전 이 창의 문서와 이어 갈 채팅. 창마다 한 번만 준다.
ipcMain.handle('desktop:get-update-restore', (event) => {
  const session = sessionForEvent(event);
  const restore = session.updateRestore;
  session.updateRestore = null;
  return restore ?? null;
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
  validateOpenedDocumentBytes(artifact.fileName, bytes);
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
// 에이전트 도구(open_document·create_document). 열기 대화상자와 같은 핸들을 주되, 다른 창이 쥔
// 문서는 그 창을 앞으로 가져오지 않고 DOC_OPEN_ELSEWHERE 로 알린다.
ipcMain.handle('desktop:open-native-document-at-path', async (event, filePath) => {
  const session = sessionForEvent(event);
  const result = await openAgentDocumentAtPath(session.sessionId, filePath, { nativeFiles, documentLeases });
  if (result.ok) noteRecentDocument(session.sessionId, result.handleId);
  return result;
});
ipcMain.handle('desktop:create-named-native-document', async (event, payload = {}) => {
  const session = sessionForEvent(event);
  try {
    await licenseHost.guardSave();
  } catch (error) {
    if (error?.code === 'LICENSE_READ_ONLY') return { ok: false, code: 'LICENSE_READ_ONLY' };
    throw error;
  }
  const result = await createAgentDocument(session.sessionId, {
    name: payload?.name,
    folder: payload?.folder,
    bytes: payload?.bytes,
  }, {
    nativeFiles,
    // 허브가 확인 요청에 보여 준 기본 폴더(RHWP_DOCUMENTS_DIR/HamaEditor)와 같은 곳이다.
    defaultFolder: defaultAgentDocumentFolder(app.getPath('documents')),
    home: app.getPath('home'),
  });
  if (result.ok) noteRecentDocument(session.sessionId, result.handleId);
  return result;
});
ipcMain.handle('desktop:pick-native-save-file', async (event, options = {}) => {
  const session = sessionForEvent(event);
  // 체험이 끝났으면 저장 위치를 고르기 전에 막고 활성화 창을 띄운다.
  await licenseHost.guardSave();
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
ipcMain.handle('desktop:rename-native-file', async (event, handleId, nextName) => {
  const session = sessionForEvent(event);
  if (typeof handleId !== 'string' || !handleId) throw new Error('handleId required');
  let renamed;
  try {
    renamed = await nativeFiles.renameHandle(session.sessionId, handleId, nextName);
  } catch (error) {
    // 이미 있는 이름처럼 사용자가 고칠 수 있는 거절은 결과로 돌려준다 (오류 로그가 아니다).
    if (error?.renameRefusal) return { ok: false, reason: error.renameRefusal };
    throw error;
  }
  // 문서 점유는 경로의 소유 키로 잡혀 있다. 같은 키 형식으로 옮겨야 다음 저장이 통과한다.
  documentLeases.renamePath(session.sessionId, renamed.previousOwnershipPath, renamed.ownershipPath);
  await persistNativeBookmarks();
  try {
    app.addRecentDocument(renamed.canonicalPath);
  } catch (error) {
    console.warn('[hamaeditor] recent document update failed:', error);
  }
  return { ok: true, descriptor: renamed.descriptor };
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
  // 읽기 전용(체험 끝·해지·오프라인 7일 초과)이면 쓰지 않는다. 문서 열기와 보기는 막지 않는다.
  const written = await licenseHost.save(
    () => nativeFiles.write(session.sessionId, handleId, bytes, identity, documentLeases),
    { sender: event.sender },
  );
  noteRecentDocument(session.sessionId, handleId);
  // 저장한 내용 표시(크기·sha256)를 북마크에 남겨 옮겨진 파일을 다음 실행에도 알아본다.
  void persistNativeBookmarks().catch(() => {});
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
// 문서 홈: 기억한 위치만 살핀다. 핸들을 만들거나 경로를 점유하지 않는다.
ipcMain.handle('desktop:inspect-native-documents', async (event, documentIds) => {
  sessionForEvent(event);
  if (!Array.isArray(documentIds)) return [];
  const ids = [...new Set(documentIds.filter((id) => typeof id === 'string' && id))].slice(0, 200);
  // 닿지 않는 네트워크 위치가 libuv 작업 칸을 모두 붙잡지 않게 몇 개씩만 본다.
  const results = new Array(ids.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, ids.length) }, async () => {
    while (next < ids.length) {
      const index = next++;
      results[index] = { documentId: ids[index], ...await nativeFiles.inspectDocument(ids[index]) };
    }
  }));
  return results;
});
const relocatingDocuments = new Map();
ipcMain.handle('desktop:relocate-native-document', (event, documentId) => {
  const session = sessionForEvent(event);
  if (typeof documentId !== 'string' || !documentId) return null;
  // 같은 문서를 두 번 찾지 않는다. 겹친 요청은 처음 찾기의 결과를 함께 받는다.
  const key = `${session.sessionId}\0${documentId}`;
  const running = relocatingDocuments.get(key);
  if (running) return running;
  const search = nativeFiles.relocateDocument(session.sessionId, documentId).then(async (relocated) => {
    if (relocated) await persistNativeBookmarks();
    return relocated;
  }).finally(() => relocatingDocuments.delete(key));
  relocatingDocuments.set(key, search);
  return search;
});
ipcMain.handle('desktop:read-remembered-native-document', async (event, documentId, options) => {
  const session = sessionForEvent(event);
  // detailed: 다른 문서 읽기 — 못 읽은 이유(다른 창이 쥠·없음·잠깐 못 읽음)를 함께 돌려준다.
  const detailed = options?.detailed === true;
  if (typeof documentId !== 'string' || !documentId) return detailed ? { ok: false, reason: 'missing' } : null;
  return detailed
    ? nativeFiles.readRememberedDocumentResult(session.sessionId, documentId)
    : nativeFiles.readRememberedDocument(session.sessionId, documentId);
});
ipcMain.handle('desktop:reveal-native-document', async (event, documentId) => {
  sessionForEvent(event);
  if (typeof documentId !== 'string' || !documentId) return false;
  if ((await nativeFiles.inspectDocument(documentId)).state !== 'present') return false;
  shell.showItemInFolder(nativeFiles.bookmarkPathFor(documentId));
  return true;
});
ipcMain.on('desktop:set-unsaved-documents', (event, documents) => {
  try {
    if (unsavedDocuments.set(sessionForEvent(event).sessionId, documents)) broadcastUnsavedDocuments();
  } catch (error) {
    console.warn('[hamaeditor] unsaved document update failed:', error);
  }
});
ipcMain.handle('desktop:list-unsaved-documents', (event) => (
  unsavedDocuments.listFor(sessionForEvent(event).sessionId)
));
// 다른 창의 새 문서를 열거나 저장한다. 그 창을 앞으로 가져오고 그 창이 직접 연다·저장한다.
ipcMain.handle('desktop:unsaved-document-action', (event, documentId, action) => {
  const session = sessionForEvent(event);
  if (action !== 'open' && action !== 'save') return false;
  const owner = unsavedDocuments.ownerOf(documentId);
  if (!owner || owner === session.sessionId) return false;
  const target = sessions.sessionById(owner);
  if (!target || target.sender.isDestroyed()) return false;
  sessions.focusSession(owner);
  target.sender.send('desktop:run-unsaved-document-action', { documentId, action });
  return true;
});
const recentWindowOpens = new Map();
ipcMain.handle('desktop:open-native-document-window', async (event, documentId) => {
  const session = sessionForEvent(event);
  if (typeof documentId !== 'string' || !documentId) return false;
  // 이 창에 이미 열린 문서는 새 창으로 다시 열지 않는다.
  if (nativeFiles.ownsDocumentPath(session.sessionId, documentId)) return false;
  if ((await nativeFiles.inspectDocument(documentId)).state !== 'present') return false;
  const path = nativeFiles.bookmarkPathFor(documentId);
  // 연달아 누른 요청은 한 번만 연다.
  const now = Date.now();
  if (now - (recentWindowOpens.get(path) ?? 0) < 2000) return true;
  recentWindowOpens.set(path, now);
  for (const [openedPath, at] of recentWindowOpens) if (now - at > 10_000) recentWindowOpens.delete(openedPath);
  queueLaunch(launchRequest({ openFiles: [path], source: 'document-home' }));
  return true;
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
ipcMain.on('window:chrome-theme', (event, dark) => {
  const window = sessionForEvent(event).window;
  if (process.platform === 'win32' && typeof dark === 'boolean') {
    window.setTitleBarOverlay({ symbolColor: dark ? '#e6e6e6' : '#171b22' });
  }
});
ipcMain.on('desktop:set-document-state', (event, state) => {
  try {
    applyDocumentState(sessionForEvent(event).window, { edited: state?.edited === true });
  } catch (error) {
    console.warn('[hamaeditor] document state update failed:', error);
  }
});
ipcMain.on('desktop:set-window-background', (event, color) => {
  if (typeof color !== 'string' || !/^#[0-9a-f]{6}$/i.test(color)) return;
  try {
    sessionForEvent(event).window.setBackgroundColor(color);
    lastWindowBackground = color;
  } catch (error) {
    console.warn('[hamaeditor] window background update failed:', error);
  }
});
ipcMain.on('desktop:set-agent-attention-count', (event, count) => {
  try {
    agentAttention.setCount(sessionForEvent(event).window, count);
  } catch (error) {
    console.warn('[hamaeditor] agent attention badge update failed:', error);
  }
});
ipcMain.on('desktop:agent-attention', (event, payload) => {
  try {
    agentAttention.notify(sessionForEvent(event).window, payload ?? {});
  } catch (error) {
    console.warn('[hamaeditor] agent attention notification failed:', error);
  }
});
// 창이 초점을 얻으면 작업 표시줄 깜빡임을 멈춘다.
app.on('browser-window-focus', (_event, window) => agentAttention.focused(window));
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

function browserWindowForEvent(event) {
  const { window } = sessionForEvent(event);
  if (event.senderFrame !== event.sender.mainFrame) throw new Error('Native browser IPC requires the owning main frame');
  return window;
}
registerBrowserPasswordIpc({ ipcMain, browserHost, browserWindowForEvent });
registerBrowserAdblockIpc({ ipcMain, adblock: browserAdblock, browserWindowForEvent });
ipcMain.handle('desktop:browser-zoom', (event, payload) => browserHost.zoom(browserWindowForEvent(event), payload));
ipcMain.handle('desktop:browser-attach', (event, payload) => browserHost.attach(browserWindowForEvent(event), payload));
ipcMain.handle('desktop:browser-detach', (event, payload) => browserHost.detach(browserWindowForEvent(event), payload));
ipcMain.handle('desktop:browser-state', (event, payload) => payload?.checkPaint === true
  ? browserHost.presentationState(browserWindowForEvent(event), payload)
  : browserHost.state(browserHost.ownedTab(payload?.tabId, browserWindowForEvent(event))));
ipcMain.handle('desktop:browser-navigate', (event, payload) => browserHost.navigate(browserWindowForEvent(event), payload));
for (const command of ['back', 'forward', 'reload', 'stop']) {
  ipcMain.handle(`desktop:browser-${command}`, (event, payload) => browserHost.navigation(browserWindowForEvent(event), payload, command));
}
ipcMain.handle('desktop:browser-popout-command', (event, payload) => {
  if (event.senderFrame !== event.sender.mainFrame) throw new Error('Browser popout IPC requires its main frame');
  return browserHost.popoutCommand(event.sender, payload);
});
ipcMain.on('desktop:browser-guest-focus', (event, payload) => {
  const tab = [...browserHost.tabs.values()].find((value) => value.view.webContents === event.sender);
  if (tab && event.senderFrame === event.sender.mainFrame) {
    browserHost.emit(tab, 'sensitive-focus', { sensitive: payload?.sensitive === true });
  }
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
  systemPreferences,
  webContents,
    });
    // 2.0.10까지 Cloud·계정 기능이 남긴 자격 증명과 파일을 지운다. 허브의 비밀 요청보다 먼저 큐에 넣는다.
    void bestEffortStartupCleanup(
      'retired Cloud data',
      removeRetiredCloudData({ userDataDir: app.getPath('userData'), vault: secretVault }),
    );
    // 패스키 설정(서명 확인)은 허브·첫 창과 나란히 돈다. Chromium 은 WebAuthn 요청 때마다 설정을 읽으므로
    // 창이 먼저 떠도 되고, 앱 안 브라우저는 세션을 만들기 전에 이 설정을 기다린다.
    void browserWebAuthn.configure().catch((error) => {
      console.warn('[hamaeditor] passkey configuration failed:', error);
    });
    // 허브는 비밀 저장소가 생긴 직후 띄워 첫 창과 나란히 준비한다(허브의 비밀 요청은 이 저장소로 간다).
    // 실패는 아래에서 기다려 알린다.
    const hubStartup = hubOwner.ensure();
    hubStartup.catch(() => {});
    // 업데이트로 재시작했으면 그 전의 창을 다시 연다. 30분이 지난 기록은 버린다.
    const restartManifest = await consumeRestartManifest(updateRestartFile);
    configureAutoUpdater({ restartManifest });
    await loadNativeBookmarks();
    await windowFrames.load();
    installMenu();
    installStudioProtocol({
      protocol,
      net,
      root: devUrl ? null : studioDist(),
      systemFonts: { fonts: systemFonts, key: systemFontKey, allowOrigin: devOrigin },
    });
    // 첫 창보다 먼저 체험 시작 시각을 남긴다(로컬 파일만 읽으므로 빠르다). 서버 확인은 기다리지 않는다.
    await licenseManager.load().catch((error) => {
      console.warn('[hamaeditor] license state failed to load:', error);
    });
    await licenseManager.status().then(noteLicenseStatus, () => {});
    licenseManager.start();
    desktopReady = true;
    let failedLaunches = 0;
    const restoredDocumentIds = (restartManifest?.windows ?? [])
      .flatMap((entry) => entry.documents.map((document) => document.documentId));
    for (const entry of restartManifest?.windows ?? []) {
      await createWindow(launchRequest({ source: 'update-restart' }), {
        updateRestore: entry,
        restoredDocumentIds,
      }).catch((error) => {
        failedLaunches += 1;
        console.warn('[hamaeditor] update restart window failed to open:', error);
      });
    }
    // 다시 연 창이 기본 첫 창을 대신한다. 파일을 연 실행 요청은 그대로 연다.
    const launches = pendingLaunches.splice(0).filter((request) => (
      sessions.windows().length === 0 || request.source !== 'initial' || request.openFiles.length > 0
    ));
    for (const request of launches) {
      // One unreadable file must not abort the other startup launches.
      await openLaunch(request).catch((error) => {
        failedLaunches += 1;
        showLaunchError(error);
      });
    }
    initialLaunchesOpened = true;
    void licenseHost.showIfReadOnly().catch((error) => {
      console.warn('[hamaeditor] license status failed:', error);
    });
    if (failedLaunches > 0 && sessions.windows().length === 0) {
      app.quit();
      return;
    }
    // 허브 시작 실패는 창이 뜬 뒤에도 오류 창을 띄우고 종료한다.
    await Promise.all([hubStartup, staleCleanup]);
    void reportUniqueInstallMetric();
    // 실행 4초 뒤 확인하고, 그 뒤로 한 시간마다 확인한다.
    updates.start();
  }).catch((error) => {
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
    else scheduleHubSuspend();
  });
}
