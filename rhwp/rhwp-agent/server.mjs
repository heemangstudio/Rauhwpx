import { launchCopyLayoutWorker } from './copy-layout-worker.mjs';
import http from 'node:http';
import crypto from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import spawn from 'cross-spawn';
import { WebSocketServer } from 'ws';
import {
  createClaudeSession,
  flushClaudeCredentialMirrors,
  prepareClaudeHome,
} from './agents/claude.mjs';
import { deleteClaudeKeychainItem } from './claude-credentials.mjs';
import {
  createCodexSession,
  flushCodexCredentialMirror,
  prepareCodexHome,
} from './agents/codex.mjs';
import { createPiSession } from './agents/pi.mjs';
import { generateChatTitle } from './agents/title.mjs';
import {
  CHECKPOINT_TITLE_OVERALL_TIMEOUT_MS,
  codexQuotaAllowsTitle,
  resolveOpenRouterTitleModel,
  generateCheckpointTitle,
  resolveCheckpointTitleCliRoute,
} from './agents/checkpoint-title.mjs';
import { SkillRegistry } from './skills.mjs';
import { WritingStyleStore, assertWritingStyleAppendCompatible } from './writing-style.mjs';
import { AgentInstructionsStore } from './agent-instructions.mjs';
import { calibrateWritingStyle } from './style-calibrator.mjs';
import { buildWritingStyleCatalog, resolveWritingStyleSelection } from './writing-style-catalog.mjs';
import { filterToolDefinitions, TOOL_DEFINITIONS } from './tools.mjs';
import { resolveRenderSavePath, writeRenderPng } from './render-save.mjs';
import { replayMissedTurnEnd } from './turn-outcome-replay.mjs';
import { createStudioFrameCoalescer } from './studio-frame-coalescer.mjs';
import {
  PlanningState,
  authorizeToolCall,
  buildApprovedPlanPrompt,
  buildPlanningDocumentSavedPrompt,
  isExplicitImplementationApproval,
  workflowError,
} from './planning-state.mjs';
import { DownloadManager, fetchPublic } from './download-manager.mjs';
import { DocumentSnapshotManager } from './document-snapshot-manager.mjs';
import { ArtifactStore, defaultGeneratedArtifactRoot } from './artifact-store.mjs';
import { BrowserbaseFleet, normalizeBrowserbaseOverride, validateBrowserbaseCredentials } from './browserbase-session.mjs';
import { createProviderHealth } from './provider-health.mjs';
import { createUsageStore } from './usage-store.mjs';
import { appendToolTelemetryRow, startToolCall, ToolTurnTelemetry } from './tool-telemetry.mjs';
import {
  TOOL_TRACE_ENABLED,
  configureToolTrace,
  sanitizeTraceFields,
  traceNow,
  writeToolTrace,
} from './tool-trace.mjs';
import { createProviderLimitsClient } from './provider-limits.mjs';
import {
  createPiManager,
  defaultPiRoot,
} from './pi-manager.mjs';
import { AuthRunRegistry } from './auth-run-registry.mjs';
import { createCliSetupManager } from './cli-setup-manager.mjs';
import { createClaudeModelCatalog } from './claude-model-catalog.mjs';
import { createCodexModelCatalog, createCodexModelResolver } from './codex-model-routing.mjs';
import { createOpenRouter } from './openrouter.mjs';
import { createIpcSecretStore } from './secret-store.mjs';
import { handlePiToolDefinitions } from './pi/tool-schema.mjs';
import { PiSubagentCapabilityRegistry } from './pi/subagent-capabilities.mjs';
import { resolveHwpExtractor } from './reference-extractor.mjs';
import { defaultReferenceRoot } from './reference-store.mjs';
import { createReferenceCatalog } from './reference-catalog.mjs';
import { createReferenceHttpHandler, isAllowedStudioOrigin } from './reference-http.mjs';
import { ProjectStore, defaultProjectsRoot, normalizeRepository, originLabels } from './project-store.mjs';
import { ProjectSettingsStore } from './project-settings.mjs';
import { createProjectHttpHandler, isProjectPath } from './project-http.mjs';
import { executeProjectTool } from './project-tools.mjs';
import { normalizeMentions, projectPromptContext } from './project-context.mjs';
import { createProjectIngest } from './project-ingest.mjs';
import { createHomeSearch } from './home-search.mjs';
import { createProjectLibrarian } from './project-librarian.mjs';
import { createFontHttpHandler, isFontPath } from './hub-fonts.mjs';
import {
  createUserQuestionInteraction,
  isAskUserQuestionTool,
  normalizeMcpUserQuestionRequest,
  normalizeProviderUserQuestionRequest,
  sameUserQuestionRequest,
  userQuestionAnswersForMcp,
  userQuestionArgsFromToolInput,
  validateUserQuestionAnswers,
} from './user-question.mjs';
import {
  createChatPermissionRequest,
  isRequestPermissionTool,
  normalizeChatPermissionGrants,
  normalizeChatPermissionRequest,
} from './chat-permissions.mjs';
import {
  activeDocumentIdentity,
  addActiveDocumentContext,
  assertMessageScope,
  attachActiveDocumentIdentity,
  liveDocumentBlock,
  normalizeDocumentSnapshot,
  normalizeStableScopeId,
  referenceScopesForSession,
  resolveSessionIdentity,
} from './reference-session.mjs';
import {
  executeReferenceTool,
  planReferenceImageCall,
  referenceImageCall,
} from './reference-tools.mjs';
import { TemplateStore } from './template-store.mjs';
import { createTemplateHttpHandler } from './template-http.mjs';
import {
  buildCopyLayoutCompletionPrompt,
  buildCopyLayoutWorkerPrompt,
  claimCopyLayoutPublication,
  claimCopyLayoutSettlement,
  claimCopyLayoutSnapshot,
  COPY_LAYOUT_MAX_ITERATIONS,
  copyLayoutPhaseIndex,
  registerCopyLayoutArtifact,
  releaseCopyLayoutPublication,
  releaseCopyLayoutSnapshot,
  taskProgressForJob,
} from './template-perfection.mjs';
import { runCopyLayoutHelper } from './copy-layout-runner.mjs';
import { z } from 'zod/v3';
import {
  PROCESS_TREE_CLEANUP_OUTCOME,
  terminateAndWaitForProcessTreeExitOutcome,
  terminateProcessTree,
} from './process-tree.mjs';
import {
  ensureCredentialRetentionRootSync,
  hasPendingCredentialCopybackSync,
  hasPendingLaunchCleanupSync,
  retainLaunchRootForProcessCleanupSync,
} from './credential-mirror.mjs';
import {
  authenticateMasterToken,
  HUB_CAPABILITY_AUDIENCES,
  HubSessionRegistry,
  mcpProviderResource,
  resolveHubIdentity,
  timingSafeTextEqual,
} from './hub-session-registry.mjs';
import {
  AUTH_CODE_MAX_BYTES,
  boundTextFields,
  textFitsByteLimit,
} from './input-bounds.mjs';

const REQUESTED_PORT = Number(process.env.RHWP_AGENT_PORT ?? 5175);
const PRODUCTION = process.env.NODE_ENV === 'production' || process.env.RHWP_AGENT_MODE === 'production';
const { token: TOKEN, development: DEVELOPMENT_AUTH, launchId: LAUNCH_ID } = resolveHubIdentity();
const PROTOCOL_VERSION = 5;
const HUB_NAME = 'rhwp-agent';
const STARTED_AT = Date.now();
// The bundle is discovery-only. Every per-window cwd, home, download, and
// temporary work path lives below RHWP_WORK_DIR.
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MCP_SCRIPT = fileURLToPath(new URL('./mcp-stdio.mjs', import.meta.url));
const BUNDLED_SKILLS = fileURLToPath(new URL('./skills', import.meta.url));
if (PRODUCTION && !process.env.RHWP_WORK_DIR) {
  throw Object.assign(new Error('RHWP_WORK_DIR is required in production'), { code: 'HUB_WORK_DIR_REQUIRED' });
}
const WORK_ROOT = path.resolve(process.env.RHWP_WORK_DIR || path.join(os.tmpdir(), `rhwp-agent-work-${process.pid}`));
const RUNTIME_ROOT = process.env.RHWP_RUNTIME_DIR
  ? path.resolve(process.env.RHWP_RUNTIME_DIR)
  : null;
const RECORDS_ROOT = path.join(WORK_ROOT, 'sessions');
// 작업 폴더는 실행마다 새로 만들고 지운다. 생성 문서는 앱 데이터 폴더에 남겨
// 허브나 앱을 다시 켜도 채팅의 문서 카드가 열리게 한다.
const GENERATED_ARTIFACTS_ROOT = defaultGeneratedArtifactRoot();
await fs.mkdir(RECORDS_ROOT, { recursive: true, mode: 0o700 });
ensureCredentialRetentionRootSync(WORK_ROOT);
const TOOL_TRACE_PATH = configureToolTrace(WORK_ROOT);
let hubPort = REQUESTED_PORT;
const STUDIO_TOOL_TIMEOUT_MS = 30_000;
const MAX_CHAT_MESSAGE_CHARS = 128_000;
const MAX_USER_MESSAGE_RECEIPTS = 128;
const PLAN_CHANGE_TEXT_LIMITS = Object.freeze({
  planId: 256,
  promptOverride: MAX_CHAT_MESSAGE_CHARS,
  feedback: MAX_CHAT_MESSAGE_CHARS,
  reason: 4_000,
});
const MAX_SEMANTIC_REQUEST_BYTES = 512 * 1024;
const MAX_PENDING_STUDIO_TOOL_CALLS = 64;
const MAX_STUDIO_QUEUED_FRAME_BYTES = 96 * 1024 * 1024;
const MAX_STUDIO_QUEUED_MESSAGES = 64;
// 스튜디오가 끊긴 뒤 다시 붙기를 기다려 주는 시간 — 브리지의 첫 재접속 백오프(250·500ms)보다
// 넉넉하되, 탭이 아주 닫힌 경우 30초 타임아웃까지 끌지 않을 만큼 짧게 잡는다.
const STUDIO_REATTACH_GRACE_MS = Number(process.env.RHWP_STUDIO_REATTACH_GRACE_MS ?? 5_000);
// 같은 페이지가 재접속하면 브리지는 끊길 때 진행 중이던 요청을 이미 중단했다 — 버퍼에 남은
// 응답이 도착할 짧은 시간만 기다린 뒤, 답이 없는 옛 호출은 타임아웃 전에 실패시킨다.
const STUDIO_REATTACH_FLUSH_MS = Number(process.env.RHWP_STUDIO_REATTACH_FLUSH_MS ?? 2_000);
// 프로바이더 이벤트와 별도 MCP 소켓의 도구 호출 순서가 뒤집힐 수 있어
// 정확한 루트 범위 티켓이 도착할 짧은 여유를 둔다.
const USER_QUESTION_SCOPE_WAIT_MS = 2_000;
const HARNESS_UPDATE_INITIAL_DELAY_MS = 8_000;
const HARNESS_UPDATE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const HARNESS_UPDATE_BUSY_RETRY_MS = 5 * 60 * 1000;
const HARNESS_UPDATE_FAILURE_RETRY_MS = 60 * 60 * 1000;
const configuredOrphanIdleShutdownMs = Number(process.env.RHWP_ORPHAN_IDLE_SHUTDOWN_MS);
const ORPHAN_IDLE_SHUTDOWN_MS = Number.isSafeInteger(configuredOrphanIdleShutdownMs)
  && configuredOrphanIdleShutdownMs >= 100
  ? configuredOrphanIdleShutdownMs
  : 15 * 60 * 1000;
const configuredOrphanHardShutdownMs = Number(process.env.RHWP_ORPHAN_HARD_SHUTDOWN_MS);
const ORPHAN_HARD_SHUTDOWN_MS = Number.isSafeInteger(configuredOrphanHardShutdownMs)
  && configuredOrphanHardShutdownMs >= 100
  ? Math.max(configuredOrphanHardShutdownMs, ORPHAN_IDLE_SHUTDOWN_MS)
  : 30 * 60 * 1000;
const toolDefinitionsByName = new Map(TOOL_DEFINITIONS.map((definition) => [definition.name, definition]));
const copyLayoutWorkerTools = new Set(
  filterToolDefinitions('copy-layout-worker').map((definition) => definition.name),
);
const MAX_COPY_LAYOUT_JOB_HISTORY = 20;
// 인자 스키마는 도구마다 한 번만 만든다 — 호출마다 z.object() 를 다시 세우면
// 툴 하나당 수십 개 필드를 매번 컴파일하게 된다. insert_image 는 passthrough,
// 나머지는 strict 이므로 도구 이름으로 캐시하면 변형도 자연히 분리된다.
const toolArgSchemas = new Map();
function toolArgSchema(tool, definition) {
  const cached = toolArgSchemas.get(tool);
  if (cached) return cached;
  const base = z.object(definition.shape);
  const schema = tool === 'insert_image' ? base.passthrough() : base.strict();
  toolArgSchemas.set(tool, schema);
  return schema;
}
const HOST_PROFILE_HOME = process.platform === 'win32' && process.env.USERPROFILE
  ? path.resolve(process.env.USERPROFILE)
  : os.homedir();
const SOURCE_CLAUDE_CONFIG = path.join(HOST_PROFILE_HOME, '.claude.json');
// 설정 상태·사용량과 같은 프로필만 본다. 선택한 CODEX_HOME 이 비어 있어도 다른 프로필로 넘어가지 않는다.
const sourceCodexHome = process.env.CODEX_HOME?.trim()
  ? path.resolve(process.env.CODEX_HOME)
  : path.join(HOST_PROFILE_HOME, '.codex');
function findSourceCodexAuthPath() {
  const authPath = path.join(sourceCodexHome, 'auth.json');
  try {
    const authStat = lstatSync(authPath);
    if (authStat.isFile() && !authStat.isSymbolicLink()) return authPath;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  return undefined;
}
let sourceCodexAuthPath = findSourceCodexAuthPath();
const writingStyleStore = await new WritingStyleStore().init();
const agentInstructionsStore = await new AgentInstructionsStore().init();
const skillRegistry = await new SkillRegistry({ bundledRoot: BUNDLED_SKILLS, writingStyleStore }).init();
const PI_ROOT = defaultPiRoot();
const openRouter = createOpenRouter({ cacheDir: PI_ROOT });
const secretStore = createIpcSecretStore();
if (process.env.RHWP_AGENT_MODE === 'production' && !secretStore.available) {
  throw Object.assign(new Error('The packaged hub requires the desktop secure-secret broker.'), {
    code: 'HUB_SECRET_BROKER_REQUIRED',
  });
}
const piManager = await createPiManager({ rootDir: PI_ROOT, openRouter, secretStore }).init();
const authRuns = new AuthRunRegistry();
let npmPrefixMutationQueue = Promise.resolve();
function mutateSharedNpmPrefix(operation) {
  const running = npmPrefixMutationQueue.then(operation, operation);
  npmPrefixMutationQueue = running.catch(() => {});
  return running;
}
const cliSetup = await createCliSetupManager({ secretStore, deleteKeychainItem: deleteClaudeKeychainItem }).init();
/**
 * Claude children get their login from CLAUDE_CODE_OAUTH_TOKEN (see
 * cliSetup.envFor), so isolated homes only receive the portable config.
 */
const sourceClaudeAuth = Object.freeze({ configPath: SOURCE_CLAUDE_CONFIG });
function claudeRuntimeEnv(isolatedHome) {
  return {
    ...cliSetup.envFor('claude'),
    HOME: process.platform === 'darwin' ? (process.env.HOME ?? os.homedir()) : isolatedHome,
    USERPROFILE: isolatedHome,
    CLAUDE_CONFIG_DIR: path.join(isolatedHome, '.claude'),
    ...(process.platform === 'darwin' ? {} : { CLAUDE_SECURESTORAGE_CONFIG_DIR: path.join(isolatedHome, '.claude') }),
  };
}
// App-managed bins are available to auxiliary CLI calls as soon as installation completes.
// 허브가 관리하는 API 키는 process.env 에 올리지 않는다 — npm lifecycle 스크립트,
// 설치 스크립트 등 무관한 자식 프로세스까지 상속받는 누수 지점이 된다.
// 키는 auxSpawnProcess 가 해당 CLI 자식에게만 env 로 얹어 준다.
process.env.PATH = [cliSetup.nodeHostDir(), cliSetup.binDir, process.env.PATH]
  .filter(Boolean)
  .join(path.delimiter);
/**
 * `--version` 실행과 Keychain 확인은 bootWork 로 미룬다. 그 전까지는 설치 여부만
 * 동기로 채운 임시 상태를 쓰고, 버전·로그인을 보는 경로는 ensureBootWork() 를 기다린다.
 */
function provisionalCliSetupStatus(agent) {
  return {
    installed: existsSync(cliSetup.binPath(agent)),
    installing: false,
    version: null,
    authenticated: false,
    authMethod: null,
    keyTail: null,
    latestVersion: null,
    updateRequired: false,
    error: null,
  };
}
const provisionalCliSetup = {
  claude: provisionalCliSetupStatus('claude'),
  codex: provisionalCliSetupStatus('codex'),
};
let cliSetupStatus = { ...provisionalCliSetup };
/** pi 상태는 동기 경로(resolveModel/startSession)에서도 필요해 캐시해 둔다. */
let piStatus = await piManager.status();
/** OpenRouter 잔액. 키가 있을 때만 채워지고 사용량 리포트에 얹힌다. */
let openRouterCredits = null;
let openRouterCreditsKey = null;

/**
 * 준비 줄 뒤로 미룬 기동 작업: Claude 자격 증명 위치(Keychain), CLI 상태(--version),
 * pi 확장/스킬 동기화(fs.cp). 한 번만 돌고 실패해도 거절하지 않는다. 세션 시작처럼
 * 결과에 기대는 경로는 이 약속을 기다린다.
 */
let bootWorkPromise = null;
function ensureBootWork() {
  bootWorkPromise ??= Promise.all([
    // 저장된 Claude 토큰이 아직 받아들여지는지 한 번 확인한다. 네트워크가 없으면 그대로 둔다.
    cliSetup.verifyAuth('claude')
      .catch((error) => log(`claude credential check failed: ${error?.message ?? error}`)),
    ...['claude', 'codex'].map((agent) => cliSetup.status(agent).then((status) => {
      if (cliSetupStatus[agent] === provisionalCliSetup[agent]) cliSetupStatus[agent] = status;
    }).catch((error) => log(`${agent} setup status failed: ${error?.message ?? error}`))),
    // 저장소가 갱신되면 확장/스킬도 따라와야 한다 — 실패해도 허브는 그대로 뜬다.
    piStatus.installed
      ? piManager.syncAssets().catch((error) => log(`pi asset sync failed: ${error?.message ?? error}`))
      : null,
  ]).then(() => {});
  return bootWorkPromise;
}
const providerHealth = createProviderHealth({
  piBin: () => (piStatus.installed ? piManager.piBin : null),
  cliBin: (agent) => (cliSetupStatus[agent]?.installed ? cliSetup.binPath(agent) : null),
  probeEnv: (agent) => {
    if (agent === 'claude') {
      const probeHome = path.join(cliSetup.rootDir, 'claude-probe');
      return claudeRuntimeEnv(probeHome);
    }
    return undefined;
  },
});
const usageStore = await createUsageStore().init();
const providerLimits = createProviderLimitsClient({
  homeDir: HOST_PROFILE_HOME,
  resetLedgerPath: path.join(usageStore.rootDir, 'codex-reset-ledger.json'),
  // Anthropic rate-limits this endpoint aggressively. A manual refresh should
  // reuse a recent successful read instead of immediately turning it into a
  // 429 after the automatic post-login refresh.
  forceCooldownMs: 5 * 60 * 1000,
  getProviderEnv: (agent) => cliSetup.envFor(agent),
  getAuthMethod: async (agent) => {
    await ensureBootWork();
    return cliSetupStatus[agent]?.authMethod;
  },
  getCodexBin: () => cliSetupStatus.codex?.installed ? cliSetup.binPath('codex') : 'codex',
});
// 참고 자료: references/ 는 옛 빌드와 같은 형식으로 두고, 프로젝트 파일은 프로젝트 폴더 안에 둔다.
const PROJECTS_ROOT = defaultProjectsRoot();
const referenceStore = await createReferenceCatalog({
  referencesRoot: defaultReferenceRoot(),
  projectsRoot: PROJECTS_ROOT,
  projectRoot: ROOT,
  logger: log,
}).init();
const templateStore = await new TemplateStore().init();
// .hwp/.hwpx/.hml 텍스트 추출은 rhwp 바이너리에 기댄다 — 없으면 첫 업로드가 아니라 기동 시점에 알린다.
const hwpExtractor = await resolveHwpExtractor(ROOT);
if (!hwpExtractor) {
  log('hwp/hwpx text extraction unavailable: build target/release/rhwp, install rhwp on PATH, or set RHWP_BIN');
}
const stagedReferenceCleanupTimer = setInterval(() => {
  void referenceStore.cleanupStaged().catch((error) => log(`staged reference cleanup failed: ${error?.message ?? error}`));
}, 15 * 60 * 1000);
stagedReferenceCleanupTimer.unref?.();
// 연구 프로젝트: 설정 → 프로젝트 값은 호출할 때마다 읽으므로 재시작 없이 적용된다.
const projectSettings = new ProjectSettingsStore({ root: PROJECTS_ROOT, logger: log });
await projectSettings.load();
const projectStore = await new ProjectStore({
  root: PROJECTS_ROOT,
  referenceStore,
  settings: () => projectSettings.get(),
  logger: log,
}).init();
// 홈 폴더 검색은 데스크톱 앱이 RHWP_HOME_ACCESS=1 로 허브를 띄웠을 때만 쓸 수 있다.
const HOME_ACCESS = process.env.RHWP_HOME_ACCESS === '1';
const homeSearch = createHomeSearch({
  home: os.homedir(),
  settings: () => projectSettings.get(),
  access: HOME_ACCESS,
});
const projectIngest = createProjectIngest({
  referenceStore,
  projectStore,
  settings: () => projectSettings.get(),
  fetchPublic,
  homeSearch,
  logger: log,
});
// 정리 도우미가 쓸 공급자 경로를 고를 때 기준이 되는, 프로젝트에 마지막으로 묶인 채팅 기록.
const projectRecords = new Map();
// project-changed 는 프로젝트마다 150ms 에 한 번으로 묶는다. 세션 표가 생기기 전 이벤트는 기다린다.
const projectChangeTimers = new Map();
let projectEventsLive = false;
const projectLibrarian = createProjectLibrarian({
  projectStore,
  referenceStore,
  settings: () => projectSettings.get(),
  routes: (projectId) => librarianRoutes(projectId),
  emit: (projectId, status) => sendToProjectStudios(projectId, { v: 1, type: 'project-librarian-status', projectId, ...status }),
  logger: log,
});
projectStore.setLibrarianStatusProvider((projectId) => projectLibrarian.status(projectId));
projectStore.onItemsAdded((projectId, itemIds) => {
  void projectLibrarian.enqueue(projectId, itemIds).catch((error) => log(`librarian enqueue failed: ${error?.message ?? error}`));
});
projectStore.onChange((projectId, details) => onProjectChanged(projectId, details));
try {
  const migrated = await projectStore.migrateDocumentReferences();
  if (migrated > 0) log(`moved ${migrated} document reference file(s) into projects`);
  const repaired = await projectStore.repairReferences();
  if (repaired > 0) log(`linked ${repaired} stored project file(s) back to their projects`);
} catch (error) {
  log(`project storage startup work failed: ${error?.message ?? error}`);
}
const projectTrashTimer = setInterval(() => {
  void projectStore.purgeExpired().catch((error) => log(`project trash purge failed: ${error?.message ?? error}`));
}, 6 * 60 * 60 * 1000);
projectTrashTimer.unref?.();
void projectStore.purgeExpired().catch((error) => log(`project trash purge failed: ${error?.message ?? error}`));
let writingStyleCalibrationOwner = null;
// If a bounded provider cleanup cannot prove tree exit, retain the backend
// object (and therefore its exact child/process-group identity) until this hub
// exits. A replacement provider must never share the same work/home paths.
const retainedUncertainBackends = new Set();
const retainedUncertainBrowserbaseSessions = new Set();
const sessions = new HubSessionRegistry({
  createRecord(sessionId) {
    const recordKey = `${crypto.createHash('sha256').update(sessionId).digest('hex')}-${crypto.randomUUID()}`;
    const recordRoot = path.join(RECORDS_ROOT, recordKey);
    const workDir = path.join(recordRoot, 'work');
    // Providers can mutate workDir. Hub-created files must live in a sibling
    // tree whose parents are outside every safe-profile writable root, or a
    // checked directory can be swapped for a symlink/junction before open().
    const hubStorageDir = path.join(recordRoot, 'hub-storage');
    const isolatedHome = path.join(recordRoot, 'home');
    const codexHome = path.join(isolatedHome, '.codex');
    mkdirSync(workDir, { recursive: true, mode: 0o700 });
    mkdirSync(hubStorageDir, { recursive: true, mode: 0o700 });
    syncSourceCodexAuth();
    prepareCodexHome(codexHome, sourceCodexAuthPath);
    prepareClaudeHome(isolatedHome, sourceClaudeAuth);
    const downloadManager = new DownloadManager({ rootDir: hubStorageDir, writableRoot: workDir });
    const documentSnapshotManager = new DocumentSnapshotManager({
      rootDir: hubStorageDir,
      writableRoot: workDir,
    });
    const copyLayoutGeneratedRoot = path.join(hubStorageDir, '.rhwp-agent', 'copy-layout-generated');
    const hubReadOnlyRoots = Object.freeze([
      downloadManager.baseDir,
      documentSnapshotManager.baseDir,
      copyLayoutGeneratedRoot,
    ]);
    return {
      sessionId,
      disposed: false,
      createdAt: Date.now(),
      lastConnectedAt: Date.now(),
      studioSocket: null,
      studioInstanceId: null,
      studioReattachTimer: null,
      studioReattachFlushTimer: null,
      mcpSockets: new Set(),
      piSubagents: new PiSubagentCapabilityRegistry(),
      studioMessageQueue: Promise.resolve(),
      agentSession: null,
      sessionDisposalPromise: null,
      referenceStagingThreadId: null,
      processCleanupUncertain: false,
      pendingReferenceMessage: null,
      userMessageReceipts: new Map(),
      settledUserMessages: new WeakSet(),
      nextCapabilityEpoch: 1,
      pendingCalls: new Map(),
      toolTelemetry: null,
      pendingUserQuestion: null,
      suppressedUserQuestionCallIds: new Set(),
      pendingUserQuestionScopes: [],
      userQuestionResponseReceipts: new Map(),
      pendingChatPermissionRequest: null,
      pendingChatPermissionScopes: [],
      suppressedChatPermissionCallIds: new Set(),
      chatPermissionResponseReceipts: new Map(),
      nextHubId: 1,
      sessionGeneration: 0,
      missedTurnEnd: null,
      styleCalibration: null,
      pendingInstructionDraft: null,
      auxiliaryProcesses: new Set(),
      auxiliaryProcessCleanups: new Map(),
      checkpointTitleControllers: new Set(),
      templateJobs: new Map(),
      activeTemplateJobId: null,
      copyLayoutStorageUncertain: false,
      pendingTemplateCompletions: [],
      pendingDocumentSaved: null,
      pendingEditReport: null,
      browserbaseSession: new BrowserbaseFleet({ log }),
      downloadManager,
      documentSnapshotManager,
      artifactStore: new ArtifactStore({
        rootDir: workDir,
        trustedReadRoots: hubReadOnlyRoots,
        persistDir: GENERATED_ARTIFACTS_ROOT,
        onPersistError: (error) => log(`generated artifact persistence failed: ${error?.message ?? error}`),
      }),
      recordRoot,
      workDir,
      hubStorageDir,
      hubReadOnlyRoots,
      copyLayoutGeneratedRoot,
      isolatedHome,
      codexHome,
    };
  },
});
projectEventsLive = true;

function hasAgentSessions() {
  return [...sessions.values()].some((record) => (
    record.agentSession !== null
    || record.processCleanupUncertain
    || [...record.templateJobs.values()].some((job) => job.status === 'running')
  ));
}

function hasConnectedSessionSockets() {
  return [...sessions.values()].some((record) => (
    record.studioSocket?.readyState === 1
    || [...record.mcpSockets].some((socket) => socket?.readyState === 1)
  ));
}

function hasOrphanActiveWork() {
  return [...sessions.values()].some((record) => (
    record.agentSession?.status === 'running'
    || record.pendingCalls.size > 0
    || record.auxiliaryProcesses.size > 0
    || [...record.templateJobs.values()].some((job) => job.status === 'running')
  ));
}

function broadcastToStudios(message) {
  for (const record of sessions.values()) sendJson(record.studioSocket, message);
}

function publishedSkillOutcome(outcome) {
  if (outcome?.ok !== true || !outcome.catalog) return outcome;
  broadcastToStudios({ v: 1, type: 'skills-catalog', catalog: outcome.catalog });
  const rest = { ...outcome };
  delete rest.catalog;
  return rest;
}

function broadcastAgentInstructions(status, changedBy) {
  for (const record of sessions.values()) {
    if (record.pendingInstructionDraft
      && record.pendingInstructionDraft.expectedRevision !== status.revision) {
      clearInstructionDraft(record, 'stale');
    }
  }
  broadcastToStudios({ v: 1, type: 'agent-instructions', status, changedBy });
}

function instructionDraftFrame(draft) {
  return {
    id: draft.id,
    content: draft.content,
    expectedRevision: draft.expectedRevision,
    reason: draft.reason,
    requestedBy: draft.requestedBy,
    createdAt: new Date(draft.createdAt).toISOString(),
    expiresAt: new Date(draft.expiresAt).toISOString(),
    confirmationToken: draft.confirmationToken,
  };
}

function clearInstructionDraft(record, outcome) {
  const draft = record.pendingInstructionDraft;
  if (!draft) return null;
  record.pendingInstructionDraft = null;
  if (draft.expiryTimer) clearTimeout(draft.expiryTimer);
  sendJson(record.studioSocket, {
    v: 1,
    type: 'agent-instructions-draft-cleared',
    draftId: draft.id,
    outcome,
  });
  return draft;
}

function currentInstructionDraft(record) {
  const draft = record.pendingInstructionDraft;
  if (!draft) return null;
  if (draft.expiresAt <= Date.now()) {
    clearInstructionDraft(record, 'expired');
    return null;
  }
  return draft;
}

function sendInstructionDraft(record, sock = record.studioSocket) {
  const draft = currentInstructionDraft(record);
  if (!draft) return false;
  return sendJson(sock, {
    v: 1,
    type: 'agent-instructions-draft',
    draft: instructionDraftFrame(draft),
  });
}

function authorizedInstructionDraft(record, msg) {
  const draft = currentInstructionDraft(record);
  if (!draft
    || typeof msg.draftId !== 'string'
    || msg.draftId !== draft.id
    || typeof msg.confirmationToken !== 'string'
    || !timingSafeTextEqual(msg.confirmationToken, draft.confirmationToken)) {
    throw workflowError(
      'INSTRUCTIONS_CONFIRMATION_INVALID',
      'The instruction proposal is missing, expired, or no longer authorized.',
    );
  }
  return draft;
}

function consumeAuthorizedInstructionDraft(record, msg) {
  const draft = authorizedInstructionDraft(record, msg);
  record.pendingInstructionDraft = null;
  if (draft.expiryTimer) clearTimeout(draft.expiryTimer);
  return draft;
}

/**
 * 허브 밖에서 `codex login`/로그아웃한 결과를 반영한다. 원본 auth.json 이 생기거나
 * 사라졌으면 이미 열린 세션의 격리 홈도 다시 연결한다.
 */
function syncSourceCodexAuth() {
  let next;
  try { next = findSourceCodexAuthPath(); } catch (error) {
    log(`codex credential lookup failed: ${error?.message ?? error}`);
    return;
  }
  if (next === sourceCodexAuthPath) return;
  sourceCodexAuthPath = next;
  try { refreshSessionCredentials('codex'); } catch (error) {
    log(`codex session credential refresh failed: ${error?.message ?? error}`);
  }
}

function refreshSessionCredentials(agent) {
  for (const record of sessions.values()) {
    if (agent === 'codex') prepareCodexHome(record.codexHome, sourceCodexAuthPath);
    if (agent === 'claude') prepareClaudeHome(record.isolatedHome, sourceClaudeAuth);
  }
}

function flushProviderCredentialHomes(homes) {
  if (!homes) return true;
  /** @type {Array<[string, () => boolean]>} */
  const flushes = [
    ['claude', () => flushClaudeCredentialMirrors(homes.isolatedHome)],
    ['codex', () => flushCodexCredentialMirror(homes.codexHome)],
  ];
  let settled = true;
  for (const [agent, flush] of flushes) {
    try {
      if (!flush()) settled = false;
    } catch (error) {
      settled = false;
      log(`${agent} credential refresh copyback failed: ${error?.message ?? error}`);
    }
  }
  return settled;
}

/** CLI 설치·인증을 cli-setup-manager 가 관리하는 에이전트들. */
const CLI_SETUP_AGENTS = ['claude', 'codex'];
const KNOWN_AGENTS = new Set([...CLI_SETUP_AGENTS, 'pi']);
const AGENT_INSTRUCTION_DRAFT_TTL_MS = 5 * 60 * 1000;

const CLAUDE_MODELS = new Set(['opus', 'fable', 'sonnet', 'haiku']);
const CODEX_LINEUPS = new Set(['astra', 'sol', 'luna', 'terra']);
const DEFAULT_MODEL = {
  claude: 'sonnet',
  codex: 'sol',
};
const resolveCodexModel = createCodexModelResolver();
const claudeModelCatalog = createClaudeModelCatalog();
const codexModelCatalog = createCodexModelCatalog();
const CLAUDE_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const CLAUDE_EFFORTS_HAIKU = new Set(['low', 'medium', 'high']);
const CODEX_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
const DEFAULT_EFFORT = { claude: 'high', codex: 'medium' };

/** 알 수 없는 에이전트가 코덱스/클로드로 조용히 넘어가지 않도록 명시 테이블로 찾는다. */
const SESSION_FACTORIES = {
  claude: createClaudeSession,
  codex: createCodexSession,
  pi: createPiSession,
};

function unknownAgentError(agent) {
  return Object.assign(new Error(`unknown agent: ${String(agent)}`), { code: 'INVALID_REQUEST' });
}

/** pi 모델은 캐시된 상태에서 찾는다. */
function piModelConfig(id) {
  return piStatus.models.find((model) => model.id === id) ?? null;
}

async function refreshPiStatus() {
  piStatus = await piManager.status();
  return piStatus;
}


function piAgentSetupStatus() {
  return {
    agent: 'pi',
    installed: piStatus.installed,
    available: piStatus.installed,
    installing: piStatus.installing,
    version: piStatus.version,
    authenticated: piStatus.keyConfigured,
    authMethod: piStatus.keyConfigured ? 'api-key' : null,
    keyTail: piStatus.keyTail,
    authenticating: false,
    setupComplete: piStatus.setupComplete,
    connected: piStatus.setupComplete,
    latestVersion: piStatus.latestVersion ?? null,
    updateRequired: piStatus.updateRequired === true,
    error: piStatus.error,
  };
}


function withAuthRunStatus(statuses, ownerSessionId = null) {
  return Object.fromEntries(Object.entries(statuses).map(([agent, status]) => {
    const auth = authRuns.status(agent, ownerSessionId);
    return [agent, {
      ...status,
      ...auth,
      authenticating: status.authenticating === true || auth.authenticating,
    }];
  }));
}

function broadcastAgentSetupStatuses(statuses) {
  for (const record of sessions.values()) {
    sendJson(record.studioSocket, {
      v: 1,
      type: 'agent-setup-status',
      statuses: withAuthRunStatus(statuses, record.sessionId),
    });
  }
}


async function agentSetupStatuses(ownerSessionId = null, refresh = false) {
  // A forced refresh follows a failed turn or a user action, so check the
  // credential with Anthropic instead of trusting what is on disk.
  if (refresh) {
    await cliSetup.verifyAuth('claude', { force: true })
      .catch((error) => log(`claude credential check failed: ${error?.message ?? error}`));
  }
  const [claudeSetup, codexSetup, health] = await Promise.all([
    cliSetup.status('claude'),
    cliSetup.status('codex'),
    providerHealth.check(refresh),
  ]);
  syncSourceCodexAuth();
  const withDetectedHarness = (status, provider) => {
    const available = provider?.available === true;
    const connected = available && status.authenticated;
    return {
      ...status,
      available,
      connected,
      version: status.version ?? provider?.version ?? null,
      setupComplete: status.setupComplete || connected,
    };
  };
  const claude = withDetectedHarness(claudeSetup, health.claude);
  const codex = withDetectedHarness(codexSetup, health.codex);
  cliSetupStatus = { claude, codex };
  return withAuthRunStatus(
    { claude, codex, pi: piAgentSetupStatus() },
    typeof ownerSessionId === 'string' ? ownerSessionId : null,
  );
}

let harnessUpdateTimer = null;
let harnessUpdateRunning = false;

function scheduleHarnessUpdates(delayMs) {
  if (harnessUpdateTimer) clearTimeout(harnessUpdateTimer);
  harnessUpdateTimer = setTimeout(() => {
    harnessUpdateTimer = null;
    void runAutomaticHarnessUpdates();
  }, delayMs);
  harnessUpdateTimer.unref?.();
}

async function runAutomaticHarnessUpdates() {
  if (harnessUpdateRunning) return;
  // idle 세션도 CLI 프로세스를 물고 있으므로 완전히 닫힌 뒤 디스크의 하네스를 교체한다.
  if (hasAgentSessions()) {
    scheduleHarnessUpdates(HARNESS_UPDATE_BUSY_RETRY_MS);
    return;
  }
  harnessUpdateRunning = true;
  await ensureBootWork();
  let nextDelay = HARNESS_UPDATE_INTERVAL_MS;
  const canActivate = () => !hasAgentSessions();
  const before = {
    claude: cliSetupStatus.claude?.version ?? null,
    codex: cliSetupStatus.codex?.version ?? null,
    pi: piStatus.version ?? null,
  };
  try {
    cliSetupStatus.claude = await cliSetup.automaticUpdate('claude', { canActivate });
    cliSetupStatus.codex = await cliSetup.automaticUpdate('codex', { canActivate });
    piStatus = await mutateSharedNpmPrefix(() => piManager.automaticUpdate({ canActivate }));
    const statuses = await agentSetupStatuses();
    if (Object.values(statuses).some((status) => status.updateRequired)) {
      nextDelay = HARNESS_UPDATE_FAILURE_RETRY_MS;
    }
    broadcastAgentSetupStatuses(statuses);
    const changed = before.claude !== statuses.claude.version
      || before.codex !== statuses.codex.version
      || before.pi !== statuses.pi.version;
    if (changed) {
      const providers = await providerHealth.check(true);
      broadcastToStudios({ v: 1, type: 'provider-status', providers });
    }
  } catch {
    const statuses = await agentSetupStatuses().catch(() => null);
    if (statuses) {
      if (Object.values(statuses).some((status) => status.updateRequired)) {
        nextDelay = HARNESS_UPDATE_FAILURE_RETRY_MS;
      }
      broadcastAgentSetupStatuses(statuses);
    }
  } finally {
    harnessUpdateRunning = false;
    scheduleHarnessUpdates(nextDelay);
  }
}

function sendAgentSetupError(record, sock, requestId, agent, error, fallback = 'AGENT_SETUP_FAILED') {
  replyToStudio(record, sock, {
    v: 1,
    type: 'agent-setup-error',
    requestId,
    agent,
    code: error?.code ?? fallback,
    message: String(error?.message ?? error),
    ...(typeof error?.detail === 'string' && error.detail ? { detail: error.detail } : {}),
  });
}

function agentAuthCancelled(message = '로그인을 취소했어요.') {
  return Object.assign(new Error(message), { code: 'AGENT_AUTH_CANCELLED' });
}

function boundedAgentAuthCode(raw) {
  if (typeof raw !== 'string') {
    throw Object.assign(
      new Error('인증 코드를 입력해 주세요.'),
      { code: 'AGENT_AUTH_CODE_INVALID' },
    );
  }
  const value = raw;
  if (!textFitsByteLimit(value, AUTH_CODE_MAX_BYTES)) {
    throw Object.assign(
      new Error('인증 코드가 허용된 길이를 넘었어요.'),
      { code: 'AGENT_AUTH_CODE_TOO_LARGE' },
    );
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw Object.assign(
      new Error('인증 코드를 입력해 주세요.'),
      { code: 'AGENT_AUTH_CODE_INVALID' },
    );
  }
  return trimmed;
}

function ownerRecordForAuthRun(run) {
  return sessions.get(run.ownerSessionId);
}

function sendAuthRunFrame(run, frame) {
  const owner = ownerRecordForAuthRun(run);
  if (!owner) return;
  sendJson(owner.studioSocket, { v: 1, authRunId: run.runId, agent: run.agent, ...frame });
}

function sendAuthRunError(run, error, fallback = 'AGENT_AUTH_FAILED') {
  const owner = ownerRecordForAuthRun(run);
  if (!owner) return;
  sendJson(owner.studioSocket, {
    v: 1,
    type: 'agent-setup-error',
    requestId: run.requestId,
    authRunId: run.runId,
    agent: run.agent,
    code: error?.code ?? fallback,
    message: String(error?.message ?? error),
    ...(typeof error?.detail === 'string' && error.detail ? { detail: error.detail } : {}),
  });
}

async function broadcastFreshAgentSetupStatuses() {
  const statuses = await agentSetupStatuses();
  broadcastAgentSetupStatuses(statuses);
  return statuses;
}

function isModelIdentifier(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 128
    && /^[a-zA-Z0-9][a-zA-Z0-9._:/\[\]-]*$/.test(value)
    && !value.split('/').some((segment) => segment === '.' || segment === '..');
}

async function modelCatalog(agent, record, { refresh = false } = {}) {
  let models;
  if (agent === 'claude') models = await claudeModelCatalog({
    bin: cliSetupStatus.claude?.installed ? cliSetup.binPath('claude') : 'claude',
    env: claudeRuntimeEnv(record.isolatedHome),
    cwd: record.workDir ?? ROOT,
  }, { refresh });
  else if (agent === 'codex') {
    const options = {
      bin: cliSetupStatus.codex?.installed ? cliSetup.binPath('codex') : 'codex',
      env: cliSetup.envFor('codex'),
      isolatedHome: record.isolatedHome,
      codexHome: record.codexHome,
      cwd: record.workDir ?? ROOT,
    };
    models = await codexModelCatalog(options, { refresh });
    // 새로고침한 목록과 sol/luna 같은 별칭이 같은 모델을 가리키게 한다.
    if (refresh) resolveCodexModel.remember(options, models);
  } else throw unknownAgentError(agent);
  record.modelCatalogs ??= {};
  record.modelCatalogs[agent] = models;
  return models;
}

function resolveModel(agent, requested, record = null) {
  if (agent === 'pi') {
    if (typeof requested === 'string' && piModelConfig(requested)) return requested;
    if (piStatus.defaultModelId && piModelConfig(piStatus.defaultModelId)) return piStatus.defaultModelId;
    return piStatus.models[0]?.id ?? null;
  }
  const envDefaults = {
    claude: process.env.RHWP_CLAUDE_MODEL,
    codex: process.env.RHWP_CODEX_MODEL,
  };
  if (typeof requested === 'string' && requested && !isModelIdentifier(requested)) {
    throw Object.assign(new Error(`Invalid model identifier: ${requested}`), { code: 'MODEL_UNAVAILABLE' });
  }
  if (agent === 'claude') {
    if (CLAUDE_MODELS.has(requested)) return requested;
    if (isModelIdentifier(requested) && requested.startsWith('claude-')) return requested;
    if (isModelIdentifier(requested)) throw Object.assign(new Error(`Unknown Claude model: ${requested}`), {
      code: 'MODEL_UNAVAILABLE',
    });
    if (CLAUDE_MODELS.has(envDefaults.claude)) return envDefaults.claude;
    if (isModelIdentifier(envDefaults.claude) && envDefaults.claude.startsWith('claude-')) return envDefaults.claude;
    return DEFAULT_MODEL.claude;
  }
  if (agent === 'codex') {
    if (isModelIdentifier(requested) && !CODEX_LINEUPS.has(requested)) return requested;
    const lineup = CODEX_LINEUPS.has(requested) ? requested
      : CODEX_LINEUPS.has(envDefaults.codex) ? envDefaults.codex : DEFAULT_MODEL.codex;
    if (!requested && isModelIdentifier(envDefaults.codex) && !CODEX_LINEUPS.has(envDefaults.codex)) {
      return envDefaults.codex;
    }
    return resolveCodexModel(lineup, {
      bin: cliSetupStatus.codex?.installed ? cliSetup.binPath('codex') : 'codex',
      env: cliSetup.envFor('codex'),
      isolatedHome: record?.isolatedHome,
      codexHome: record?.codexHome,
      cwd: record?.workDir ?? ROOT,
    });
  }
  throw unknownAgentError(agent);
}

function resolveEffort(agent, model, requested, record = null) {
  if (agent === 'pi') {
    // 추론을 지원하지 않는 모델은 effort 자체가 없다 — 붙이면 요청이 거부된다.
    const efforts = piModelConfig(model)?.efforts ?? [];
    if (efforts.length === 0) return null;
    if (typeof requested === 'string' && efforts.includes(requested)) return requested;
    const preferred = piModelConfig(model)?.defaultEffort;
    return efforts.includes(preferred) ? preferred : efforts[0];
  }
  const tables = {
    codex: CODEX_EFFORTS,
    claude: model === 'haiku' || model.startsWith('claude-haiku-')
      ? CLAUDE_EFFORTS_HAIKU : CLAUDE_EFFORTS,
  };
  const catalogEntry = record?.modelCatalogs?.[agent]?.find((entry) => entry.id === model);
  const supported = catalogEntry?.supportedEfforts;
  const allowed = Array.isArray(supported)
    ? new Set(supported.filter((effort) => tables[agent]?.has(effort)))
    : tables[agent];
  if (!allowed) throw unknownAgentError(agent);
  if (allowed.size === 0) return null;
  if (typeof requested === 'string' && allowed.has(requested)) return requested;
  const preferred = DEFAULT_EFFORT[agent];
  return allowed.has(preferred) ? preferred : [...allowed][0];
}

function resolveServiceTier(agent, requested) {
  if (agent !== 'codex') return 'standard';
  return requested === 'fast' ? 'fast' : 'standard';
}
// 새 탭·새로고침이 스튜디오 자리를 넘겨받으면 이전 페이지의 실행기와 함께 인플라이트 호출도
// 사라진다 — 30초 타임아웃까지 기다리지 말고 즉시 NO_STUDIO 로 실패시킨다.
// 단순히 소켓만 잠깐 끊긴 경우(같은 인스턴스가 곧바로 재접속)에는 호출을 살려 두고,
// 버퍼 응답이 올 시간만 준 뒤 답이 없는 것을 접는다(armStudioReattachFlush).
function failAllPendingCalls(record, message) {
  failPendingCalls(record, message);
}

/** hubIds 를 주면 그 호출만, 없으면 모든 인플라이트 호출을 NO_STUDIO 로 실패시킨다. */
function failPendingCalls(record, message, hubIds = null) {
  for (const [hubId, entry] of record.pendingCalls) {
    if (hubIds && !hubIds.has(hubId)) continue;
    clearTimeout(entry.timer);
    record.pendingCalls.delete(hubId);
    cancelStudioToolRequest(record, hubId, entry, 'studio-call-failed');
    if (entry.tool === 'materialize_document_snapshot' && entry.copyLayoutJobId) {
      const job = record.templateJobs.get(entry.copyLayoutJobId);
      releaseCopyLayoutSnapshot(job);
    }
    const error = workflowError('NO_STUDIO', message);
    if (typeof entry.sendError === 'function') entry.sendError(error);
    else {
      sendJson(entry.mcpSocket, {
        v: 1, type: 'tool-result', id: entry.clientId, ok: false,
        error: { code: error.code, message: error.message },
      });
    }
  }
}

function clearStudioReattachGrace(record) {
  if (!record.studioReattachTimer) return;
  clearTimeout(record.studioReattachTimer);
  record.studioReattachTimer = null;
}

function clearStudioReattachFlush(record) {
  if (!record.studioReattachFlushTimer) return;
  clearTimeout(record.studioReattachFlushTimer);
  record.studioReattachFlushTimer = null;
}

// 같은 인스턴스가 재접속하면 지금 남은 호출은 모두 이전 소켓으로 나간 것이고, 브리지는
// onclose 에서 이를 중단해 새로 답하지 않는다. 끊긴 사이 버퍼에 담긴 응답은 onopen 직후
// 도착하므로 잠깐 기다린 뒤 스튜디오 메시지 큐 뒤에 줄 세워, 그때까지 답이 없는 것만 접는다.
function armStudioReattachFlush(record) {
  clearStudioReattachFlush(record);
  if (record.pendingCalls.size === 0) return;
  const droppedIds = new Set(record.pendingCalls.keys());
  record.studioReattachFlushTimer = setTimeout(() => {
    record.studioReattachFlushTimer = null;
    record.studioMessageQueue = record.studioMessageQueue
      .then(() => {
        if (record.disposed) return;
        failPendingCalls(
          record,
          'Studio reconnected but dropped this in-flight tool call; the edit may still have applied — re-read with get_structure/get_text_range before retrying',
          droppedIds,
        );
      })
      .catch((error) => log(`studio reattach flush failed (session=${record.sessionId}): ${error?.message ?? error}`));
  }, STUDIO_REATTACH_FLUSH_MS);
}

// 탭이 아주 닫혔는지, 잠깐 끊겼는지는 소켓만 봐서는 알 수 없다 — 유예 시간을 주고
// 그 안에 스튜디오가 돌아오지 않으면 남은 호출을 NO_STUDIO 로 접는다.
// 유예 중 흘러 들어온 응답으로 이미 끝난 호출은 pendingCalls 에서 빠져 있어 두 번 답하지 않는다.
function armStudioReattachGrace(record) {
  clearStudioReattachGrace(record);
  if (record.pendingCalls.size === 0) return;
  record.studioReattachTimer = setTimeout(() => {
    record.studioReattachTimer = null;
    if (record.studioSocket) return;
    failAllPendingCalls(record, 'Studio disconnected while tool calls were in flight; the edit may still have applied — re-read with get_structure/get_text_range before retrying');
  }, STUDIO_REATTACH_GRACE_MS);
}

function log(msg) {
  process.stderr.write(`[rhwp-agent] ${msg}\n`);
}

function writeJson(sock, obj) {
  if (!sock || sock.readyState !== sock.OPEN) return false;
  try {
    sock.send(JSON.stringify(obj?.v === 1 ? { ...obj, v: PROTOCOL_VERSION } : obj));
    return true;
  } catch (e) {
    log(`send failed: ${e?.message ?? e}`);
    return false;
  }
}

/** 토큰마다 WS 프레임을 보내지 않도록 스트리밍 이벤트를 소켓별로 잠깐 모은다. */
const studioFrames = createStudioFrameCoalescer({ write: writeJson });

/** 모아 둔 스트리밍 프레임을 먼저 보낸 뒤 보낸다 — 프레임 순서가 그대로 유지된다. */
function sendJson(sock, obj) {
  if (sock) studioFrames.flush(sock);
  return writeJson(sock, obj);
}

/** 이미 직렬화한 프레임을 보낸다 — 크기를 먼저 재야 하는 도구 결과용. */
function sendRaw(sock, frame) {
  if (sock) studioFrames.flush(sock);
  if (!sock || sock.readyState !== sock.OPEN) return false;
  try {
    sock.send(frame);
    return true;
  } catch (e) {
    log(`send failed: ${e?.message ?? e}`);
    return false;
  }
}

function pendingUserQuestionSnapshot(record) {
  return record.pendingUserQuestion
    ? structuredClone(record.pendingUserQuestion.interaction)
    : null;
}

function pendingChatPermissionSnapshot(record) {
  const request = record.pendingChatPermissionRequest?.request;
  if (!request) return null;
  try {
    normalizeChatPermissionRequest(request);
    return structuredClone(request);
  } catch {
    return null;
  }
}

function settleChatPermissionRequest(record, outcome) {
  const pending = record.pendingChatPermissionRequest;
  if (!pending) return false;
  record.pendingChatPermissionRequest = null;
  const { requestId, threadId, documentId } = pending.request;
  sendJson(record.studioSocket, {
    v: 1, type: 'chat-permission-resolved', requestId, threadId, documentId,
    outcome,
    grants: normalizeChatPermissionGrants(record.agentSession?.chatPermissionGrants),
    capabilityEpoch: record.agentSession?.planning.capabilityEpoch,
  });
  return true;
}

function requestChatPermission(record, args, generation) {
  const activeSession = record.agentSession;
  if (!activeSession || activeSession.generation !== generation || activeSession.status !== 'running'
    || !activeSession.turnId || activeSession.providerTurnStarted !== true) {
    throw workflowError('NO_ACTIVE_TURN', 'Permission requests require the active root turn');
  }
  const normalized = normalizeChatPermissionRequest(args);
  if (activeSession.chatPermissionGrants.includes(normalized.capability)) {
    return { status: 'granted', capability: normalized.capability, scope: 'chat', grants: normalizeChatPermissionGrants(activeSession.chatPermissionGrants) };
  }
  const pending = record.pendingChatPermissionRequest;
  if (pending) {
    if (pending.request.capability !== normalized.capability || pending.request.reason !== normalized.reason) {
      throw workflowError('INTERACTION_ALREADY_PENDING', 'Another permission request is waiting for the user');
    }
    return { status: 'pending', requestId: pending.request.requestId, capability: normalized.capability, scope: 'chat' };
  }
  if (!record.studioSocket || record.studioSocket.readyState !== record.studioSocket.OPEN) {
    throw workflowError('NO_STUDIO', 'Studio must be connected to request a chat permission');
  }
  const request = createChatPermissionRequest(normalized, activeSession);
  record.pendingChatPermissionRequest = {
    request, session: activeSession, generation,
    providerCapabilityResource: activeSession.providerCapabilityResource,
    capabilityEpoch: activeSession.planning.capabilityEpoch,
  };
  if (!sendJson(record.studioSocket, { v: 1, type: 'chat-permission-requested', request: structuredClone(request) })) {
    settleChatPermissionRequest(record, { status: 'expired', reason: 'studio-disconnected' });
    throw workflowError('NO_STUDIO', 'Studio disconnected before the permission could be presented');
  }
  return { status: 'pending', requestId: request.requestId, capability: normalized.capability, scope: 'chat' };
}

async function answerChatPermission(record, sock, msg) {
  const requestId = typeof msg.requestId === 'string' ? msg.requestId : '';
  const responseId = typeof msg.responseId === 'string' ? msg.responseId : '';
  const result = (ok, error = null) => ({
    v: 1, type: 'chat-permission-response-result', requestId, responseId, ok,
    ...(error ? { code: error.code ?? 'CHAT_PERMISSION_FAILED', message: String(error.message ?? error) } : {}),
  });
  try {
    if (!requestId || !responseId || requestId.length > 256 || responseId.length > 256
      || !['grant', 'deny'].includes(msg.decision)) {
      throw workflowError('INVALID_CHAT_PERMISSION_RESPONSE', 'Provide requestId, responseId and grant or deny');
    }
    const fingerprint = JSON.stringify([requestId, msg.threadId, msg.documentId, msg.decision]);
    const receipt = record.chatPermissionResponseReceipts.get(responseId);
    if (receipt) {
      if (receipt.fingerprint !== fingerprint) throw workflowError('RESPONSE_ID_REUSED', 'responseId already belongs to another permission response');
      sendJson(sock, receipt.frame);
      return;
    }
    const pending = record.pendingChatPermissionRequest;
    const activeSession = record.agentSession;
    if (!pending || pending.request.requestId !== requestId) {
      throw workflowError('CHAT_PERMISSION_NOT_FOUND', 'This permission request is no longer pending');
    }
    normalizeChatPermissionRequest(pending.request);
    if (!activeSession || pending.session !== activeSession || pending.generation !== activeSession.generation
      || pending.providerCapabilityResource !== activeSession.providerCapabilityResource
      || pending.capabilityEpoch !== activeSession.planning.capabilityEpoch
      || pending.request.threadId !== msg.threadId || pending.request.documentId !== msg.documentId
      || activeSession.threadId !== msg.threadId || activeSession.documentId !== msg.documentId) {
      throw workflowError('REQUEST_INVALIDATED', 'The permission request no longer belongs to this chat and document');
    }
    if (msg.decision === 'grant') {
      const grants = normalizeChatPermissionGrants([...activeSession.chatPermissionGrants, pending.request.capability]);
      {
        if (activeSession.status !== 'idle') throw workflowError('AGENT_BUSY', 'Wait for the agent turn to finish before granting this chat permission');
        requireWorkflowSwitchBackend(activeSession);
        const previousGrants = [...activeSession.chatPermissionGrants];
        try {
          await activeSession.backend.setExecutionMode({ ...providerModeRequest(activeSession), chatPermissionGrants: grants });
          if (record.agentSession !== activeSession || record.pendingChatPermissionRequest !== pending) {
            throw workflowError('REQUEST_INVALIDATED', 'The chat changed while the permission was being applied');
          }
        } catch (error) {
          // 중지는 전환 대기열을 건너뛴다. 취소된 전환이 같은 공급자에 권한을 남기지 않게 되돌린다.
          if (record.agentSession === activeSession) {
            try {
              await activeSession.backend.setExecutionMode({ ...providerModeRequest(activeSession), chatPermissionGrants: previousGrants });
            } catch (rollbackError) {
              log(`chat permission rollback failed: ${rollbackError?.message ?? rollbackError}`);
              await disposeSession(record);
            }
          }
          throw error;
        }
      }
      activeSession.chatPermissionGrants.splice(0, activeSession.chatPermissionGrants.length, ...grants);
    }
    const frame = result(true);
    record.chatPermissionResponseReceipts.set(responseId, { fingerprint, frame });
    // 성공한 응답만 중복 확인에 남긴다. 바쁜 공급자·실패한 전환은 같은 요청으로 다시 시도할 수 있다.
    if (record.chatPermissionResponseReceipts.size > 32) {
      record.chatPermissionResponseReceipts.delete(record.chatPermissionResponseReceipts.keys().next().value);
    }
    sendJson(sock, frame);
    settleChatPermissionRequest(record, { status: msg.decision === 'grant' ? 'granted' : 'denied', ...(msg.decision === 'deny' ? { reason: 'user-denied' } : {}) });
  } catch (error) {
    sendJson(sock, result(false, error));
  }
}

function userQuestionOutcomeForTurnEnd(event) {
  if (event.stopReason === 'interrupted') return { status: 'cancelled', reason: 'user-stop' };
  if (event.stopReason === 'failed' || event.stopReason === 'exited' || event.errorMessage) {
    return { status: 'expired', reason: 'provider-disconnected' };
  }
  return { status: 'expired', reason: 'request-invalidated' };
}

function settleUserQuestion(record, outcome) {
  const pending = record.pendingUserQuestion;
  if (!pending) return false;
  record.pendingUserQuestion = null;
  if (pending.signal && pending.onAbort) {
    pending.signal.removeEventListener('abort', pending.onAbort);
  }
  sendJson(record.studioSocket, {
    v: 1,
    type: 'user-question-resolved',
    interactionId: pending.interaction.interactionId,
    outcome,
  });
  pending.resolve(structuredClone(outcome));
  return true;
}

function beginAgentTurn(record, activeSession) {
  settleChatPermissionRequest(record, { status: 'expired', reason: 'request-invalidated' });
  if (record.pendingUserQuestion) {
    settleUserQuestion(record, { status: 'expired', reason: 'request-invalidated' });
  }
  record.userQuestionResponseReceipts.clear();
  activeSession.turnId = crypto.randomUUID();
  // A queued provider turn is not authoritative until its backend emits the
  // matching turn-start. Process-tree cleanup from the prior turn can still
  // be in flight after Studio submits the next message; stale MCP descendants
  // must remain unable to borrow that window.
  activeSession.providerTurnStarted = false;
  activeSession.status = 'running';
  if (activeSession.planning.phase === 'implementing' && activeSession.planning.execution?.status !== 'completed') {
    activeSession.planExecutionTurnId = activeSession.turnId;
    activeSession.planExecutionTurnSucceeded = false;
  }
}

function providerTurnIsCurrent(record, binding) {
  const activeSession = record.agentSession;
  return Boolean(
    binding
    && activeSession === binding.session
    && activeSession.generation === binding.generation
    && activeSession.status === 'running'
    && activeSession.turnId === binding.turnId,
  );
}

function providerTurnIsActive(record, binding) {
  return providerTurnIsCurrent(record, binding)
    && binding.session.providerTurnStarted === true;
}

function noActiveProviderTurnError() {
  return workflowError(
    'NO_ACTIVE_TURN',
    'This provider tool call no longer belongs to an active running turn',
  );
}

function cancelStudioToolRequest(record, hubId, entry, reason) {
  sendJson(record.studioSocket, {
    v: 1,
    type: 'tool-request-cancel',
    id: hubId,
    reason,
    ...(entry?.providerTurn?.turnId
      ? { providerTurnId: entry.providerTurn.turnId }
      : {}),
  });
}

function failPendingProviderCallsForTurn(record, activeSession, turnId) {
  if (!turnId) return;
  for (const [hubId, entry] of record.pendingCalls) {
    if (entry.providerTurn?.session !== activeSession || entry.providerTurn.turnId !== turnId) continue;
    clearTimeout(entry.timer);
    record.pendingCalls.delete(hubId);
    cancelStudioToolRequest(record, hubId, entry, 'provider-turn-settled');
    entry.sendError?.(noActiveProviderTurnError());
  }
}

function retireProviderSockets(record, activeSession, {
  turnId,
  code = 4003,
  reason = 'provider turn settled',
} = {}) {
  for (const sock of record.mcpSockets) {
    if (sock.agentGeneration !== activeSession.generation
      || sock.agentLabel !== activeSession.agent
      || sock.agentRole !== activeSession.providerRole) continue;
    if (turnId !== undefined && sock.agentTurnId !== turnId) continue;
    // Invalidate synchronously. `close()` and already-buffered WebSocket
    // messages are delivered asynchronously, so transport close alone cannot
    // keep an old process generation from borrowing the next turn.
    sock.providerTurnRetired = true;
    sock.agentTurnId = null;
    queueMicrotask(() => {
      try { sock.close(code, reason); } catch {}
    });
  }
}

function retirePiSubagentRegistration(record, registration, {
  code = 4003,
  reason = 'pi subagent capability revoked',
} = {}) {
  for (const sock of record.mcpSockets) {
    if (sock.piSubagentId !== registration.childId) continue;
    // Revoke the in-memory authority before transport close. Buffered frames
    // are checked against piSubagents again in handleMcpMessage.
    sock.providerTurnRetired = true;
    sock.agentTurnId = null;
    for (const [hubId, entry] of record.pendingCalls) {
      if (entry.mcpSocket !== sock) continue;
      clearTimeout(entry.timer);
      record.pendingCalls.delete(hubId);
      cancelStudioToolRequest(record, hubId, entry, 'pi-subagent-revoked');
      entry.sendError?.(workflowError(
        'PI_SUBAGENT_REVOKED',
        'This Pi subagent capability was revoked before the tool call completed',
      ));
    }
    queueMicrotask(() => {
      try { sock.close(code, reason); } catch {}
    });
  }
}

function retirePiSubagentsForTurn(record, activeSession) {
  for (const registration of record.piSubagents.clearTurn(activeSession)) {
    retirePiSubagentRegistration(record, registration);
  }
}

function retireAllPiSubagents(record, reason = 'provider session replaced') {
  for (const registration of record.piSubagents.clear()) {
    retirePiSubagentRegistration(record, registration, { code: 4001, reason });
  }
}

function currentPiSubagentForSocket(record, sock) {
  if (!sock.piSubagentId) return null;
  const registration = record.piSubagents.get(sock.piSubagentId);
  const activeSession = record.agentSession;
  if (!registration || !record.piSubagents.isCurrent(registration, activeSession)) return null;
  if (sock.agentGeneration !== registration.providerGeneration
    || sock.agentLabel !== registration.agent
    || sock.agentRole !== registration.agentRole
    || sock.agentTurnId !== registration.parentTurnId) return null;
  return registration;
}

function settleAgentTurn(record, activeSession, event) {
  const settledTurnId = activeSession.turnId;
  const succeeded = ['completed', 'end_turn', 'success'].includes(event.stopReason) && !event.errorMessage;
  // A backend may finish synchronously inside sendUserMessage. Successful
  // dispatch still gets its receipt after that call returns.
  if (!succeeded) {
    rejectPendingUserMessages(record, 'REQUEST_INVALIDATED', 'The turn ended before accepting the message', {
      session: activeSession, turnId: settledTurnId,
    });
  }
  if (activeSession.planning.phase === 'implementing' && activeSession.planExecutionTurnId === settledTurnId) {
    activeSession.planExecutionTurnSucceeded = ['completed', 'end_turn', 'success'].includes(event.stopReason) && !event.errorMessage;
    activeSession.planning.settleExecution(event.stopReason === 'interrupted' ? 'interrupted'
      : activeSession.planExecutionTurnSucceeded ? 'awaiting-review' : 'blocked');
    sendJson(record.studioSocket, { v: 1, type: 'plan-progress', ...activeSession.planning.snapshot() });
  }
  settleUserQuestion(record, userQuestionOutcomeForTurnEnd(event));
  if (!succeeded) settleChatPermissionRequest(record, { status: 'expired', reason: event.stopReason === 'interrupted' ? 'user-stop' : 'provider-disconnected' });
  failPendingProviderCallsForTurn(record, activeSession, settledTurnId);
  retireProviderSockets(record, activeSession, { turnId: settledTurnId });
  retirePiSubagentsForTurn(record, activeSession);
  flushToolTelemetry(record, activeSession, settledTurnId, event);
  activeSession.status = 'idle';
  activeSession.turnId = null;
  activeSession.providerTurnStarted = false;
}

// 도구 텔레메트리: 턴 단위 누산기. 지난 턴에 늦게 도착한 결과는 버린다.
function toolTelemetryForTurn(record, providerTurn) {
  if (!providerTurn) return null;
  if (record.toolTelemetry?.turnId === providerTurn.turnId) return record.toolTelemetry;
  if (providerTurn.session !== record.agentSession || providerTurn.turnId !== record.agentSession?.turnId) return null;
  record.toolTelemetry = new ToolTurnTelemetry(providerTurn.turnId);
  return record.toolTelemetry;
}

function flushToolTelemetry(record, activeSession, turnId, event) {
  if (!turnId) return;
  const turn = record.toolTelemetry?.turnId === turnId ? record.toolTelemetry : new ToolTurnTelemetry(turnId);
  record.toolTelemetry = null;
  void appendToolTelemetryRow(WORK_ROOT, {
    v: 1,
    ts: new Date().toISOString(),
    agent: activeSession.agent,
    workflow: activeSession.planning.workflow,
    stopReason: event?.stopReason ?? null,
    ...turn.summary(),
  });
}

function requestUserQuestion(record, request, {
  source,
  generation,
  signal,
  mcpSocket = null,
} = {}) {
  const normalizedRequest = normalizeProviderUserQuestionRequest(request);
  const activeSession = record.agentSession;
  if (!activeSession || activeSession.generation !== generation) {
    throw workflowError('REQUEST_INVALIDATED', 'The agent session changed before the question could be presented');
  }
  if (normalizedRequest.parentTaskId) {
    throw workflowError('ROOT_INTERACTION_REQUIRED', 'Only the root conversation may ask the user questions');
  }
  if (activeSession.status !== 'running'
    || !activeSession.turnId
    || activeSession.providerTurnStarted !== true) {
    throw workflowError('NO_ACTIVE_TURN', 'User questions require an active root turn');
  }
  const current = record.pendingUserQuestion;
  if (current) {
    if (current.source === source && sameUserQuestionRequest(current.request, normalizedRequest)) {
      return current.promise;
    }
    throw workflowError('INTERACTION_ALREADY_PENDING', 'Another user question is already waiting for an answer');
  }
  if (signal?.aborted) {
    return Promise.resolve({ status: 'expired', reason: 'provider-disconnected' });
  }
  if (!record.studioSocket || record.studioSocket.readyState !== record.studioSocket.OPEN) {
    throw workflowError('NO_STUDIO', 'Studio is not connected to present the user question');
  }
  const interaction = createUserQuestionInteraction({
    request: normalizedRequest,
    agent: activeSession.agent,
    source,
    threadId: activeSession.threadId,
    turnId: activeSession.turnId,
  });
  let resolveInteraction;
  const promise = new Promise((resolve) => { resolveInteraction = resolve; });
  const onAbort = () => {
    if (record.pendingUserQuestion?.interaction.interactionId !== interaction.interactionId) return;
    settleUserQuestion(record, { status: 'expired', reason: 'provider-disconnected' });
  };
  record.pendingUserQuestion = {
    interaction,
    request: normalizedRequest,
    source,
    generation,
    mcpSocket,
    signal: signal ?? null,
    onAbort: signal ? onAbort : null,
    promise,
    resolve: resolveInteraction,
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  const delivered = sendJson(record.studioSocket, {
    v: 1,
    type: 'user-question-requested',
    interaction: structuredClone(interaction),
  });
  if (!delivered) {
    settleUserQuestion(record, { status: 'expired', reason: 'provider-disconnected' });
    throw workflowError('NO_STUDIO', 'Studio disconnected before the user question could be presented');
  }
  return promise;
}

function matchingUserQuestionScopes(record, agent, questions) {
  const expectedQuestions = JSON.stringify(questions);
  return record.pendingUserQuestionScopes
    .map((scope, index) => ({ scope, index }))
    .filter(({ scope }) => (
      scope.agent === agent
      && scope.questions
      && JSON.stringify(scope.questions) === expectedQuestions
    ));
}

async function waitForUserQuestionScopes(record, agent, questions, generation) {
  const deadline = Date.now() + USER_QUESTION_SCOPE_WAIT_MS;
  let matches = matchingUserQuestionScopes(record, agent, questions);
  while (matches.length === 0
    && record.agentSession?.generation === generation
    && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(20, deadline - Date.now())));
    matches = matchingUserQuestionScopes(record, agent, questions);
  }
  return matches;
}

async function consumeChatPermissionScope(record, agent, args, generation) {
  const expected = JSON.stringify(normalizeChatPermissionRequest(args));
  const matchingScopes = () => record.pendingChatPermissionScopes
    .map((scope, index) => ({ scope, index }))
    .filter(({ scope }) => scope.agent === agent && scope.request && JSON.stringify(scope.request) === expected);
  const deadline = Date.now() + USER_QUESTION_SCOPE_WAIT_MS;
  let matches = matchingScopes();
  while (!matches.length && record.agentSession?.generation === generation && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(20, deadline - Date.now())));
    matches = matchingScopes();
  }
  if (matches.length !== 1) throw workflowError('CALLER_SCOPE_UNKNOWN', 'The provider did not establish a unique root permission request');
  const [scope] = record.pendingChatPermissionScopes.splice(matches[0].index, 1);
  if (scope.parentTaskId) throw workflowError('ROOT_INTERACTION_REQUIRED', 'Only the root conversation may request permissions');
}

function userQuestionAnswerFrame({ interactionId, responseId, ok, code, message }) {
  return {
    v: 1,
    type: 'user-question-answer-result',
    interactionId,
    responseId,
    ok,
    ...(code ? { code } : {}),
    ...(message ? { message } : {}),
  };
}

function answerUserQuestion(record, sock, msg) {
  const interactionId = typeof msg.interactionId === 'string' ? msg.interactionId : '';
  const responseId = typeof msg.responseId === 'string' ? msg.responseId : '';
  if (!interactionId || !responseId || interactionId.length > 256 || responseId.length > 256) {
    sendJson(sock, userQuestionAnswerFrame({
      interactionId,
      responseId,
      ok: false,
      code: 'INVALID_USER_QUESTION_ANSWER',
      message: 'interactionId and responseId are required and must be at most 256 characters',
    }));
    return;
  }
  const receipt = record.userQuestionResponseReceipts.get(responseId);
  if (receipt) {
    if (receipt.interactionId === interactionId) sendJson(sock, receipt.frame);
    else sendJson(sock, userQuestionAnswerFrame({
      interactionId,
      responseId,
      ok: false,
      code: 'RESPONSE_ID_REUSED',
      message: 'responseId was already used for another interaction in this turn',
    }));
    return;
  }
  const pending = record.pendingUserQuestion;
  let frame;
  try {
    if (!pending || pending.interaction.interactionId !== interactionId) {
      throw workflowError('USER_QUESTION_NOT_FOUND', 'The question is no longer waiting for an answer');
    }
    const activeSession = record.agentSession;
    if (!activeSession
      || activeSession.generation !== pending.generation
      || activeSession.threadId !== pending.interaction.threadId
      || activeSession.turnId !== pending.interaction.turnId) {
      throw workflowError('REQUEST_INVALIDATED', 'The question no longer belongs to the active root turn');
    }
    const answers = validateUserQuestionAnswers(pending.interaction, msg.answers);
    frame = userQuestionAnswerFrame({ interactionId, responseId, ok: true });
    record.userQuestionResponseReceipts.set(responseId, { interactionId, frame });
    sendJson(sock, frame);
    settleUserQuestion(record, { status: 'answered', answers });
    return;
  } catch (error) {
    frame = userQuestionAnswerFrame({
      interactionId,
      responseId,
      ok: false,
      code: error?.code ?? 'INVALID_USER_QUESTION_ANSWER',
      message: String(error?.message ?? error),
    });
  }
  record.userQuestionResponseReceipts.set(responseId, { interactionId, frame });
  sendJson(sock, frame);
}

function broadcastTemplateCatalog(change = null) {
  const catalog = { v: 1, type: 'templates-catalog', ...templateStore.list(), ...(change ? { change } : {}) };
  for (const record of sessions.values()) {
    const activeSession = record.agentSession;
    if (change?.type === 'deleted' && activeSession?.activeTemplateId === change.template?.id) {
      activeSession.activeTemplateId = null;
      sendJson(record.studioSocket, { v: 1, type: 'chat-template-changed', template: null, reason: 'deleted' });
    }
    sendJson(record.studioSocket, catalog);
  }
}

function writingStyleCatalog(record) {
  const activeSession = record.agentSession;
  return buildWritingStyleCatalog({
    health: providerHealth.cached(),
    piStatus,
    codexModels: record.modelCatalogs?.codex,
    claudeModels: record.modelCatalogs?.claude,
    currentSelection: activeSession ? { agent: activeSession.agent, model: activeSession.model, effort: activeSession.effort } : null,
  });
}

function sendStyleProgress(record, event) {
  const calibration = record.styleCalibration;
  if (!calibration) return;
  const snapshot = {
    v: 1,
    type: 'writing-style-progress',
    requestId: calibration.requestId,
    jobId: calibration.jobId,
    startedAt: calibration.startedAt,
    agent: calibration.agent,
    model: calibration.model,
    ...event,
  };
  calibration.progress = snapshot;
  sendJson(record.studioSocket, snapshot);
}

// 비동기 응답이 도착할 때쯤 스튜디오 탭이 교체되었을 수 있다 — 현재 소켓에만 보낸다.
function replyToStudio(record, sock, obj) {
  if (sock !== record.studioSocket) return;
  sendJson(sock, obj);
}

function usageSnapshot() {
  const usage = usageStore.summary();
  usage.limits = providerLimits.snapshot();
  const currentKey = piManager.apiKey();
  const keyId = currentKey ? crypto.createHash('sha256').update(currentKey).digest('hex') : null;
  const credits = keyId && keyId === openRouterCreditsKey ? openRouterCredits : null;
  if (credits) usage.openrouter = credits;
  usage.balances = {
    openrouter: {
      status: credits ? (credits.error ? 'error' : 'ok') : 'unavailable',
      balanceUsd: credits && !credits.error ? credits.balanceUsd : null,
      totalCreditsUsd: credits && !credits.error ? credits.totalCreditsUsd : null,
      totalUsageUsd: credits && !credits.error ? credits.totalUsageUsd : null,
      updatedAt: credits && !credits.error ? credits.checkedAt : null,
      source: credits?.scope === 'key' ? 'OpenRouter 키 한도' : 'OpenRouter 크레딧',
      error: credits?.error ? 'OpenRouter 잔액을 조회하지 못했어요. 키와 조회 권한을 확인해 주세요.'
        : !credits ? (currentKey ? '잔액을 새로고침해 주세요.' : 'Pi에서 OpenRouter 계정을 연결해 주세요.') : null,
    },
  };
  return usage;
}

function emptyCreditsError(error) {
  return {
    balanceUsd: 0,
    totalCreditsUsd: 0,
    totalUsageUsd: 0,
    checkedAt: Date.now(),
    error: String(error?.message ?? error),
  };
}

/** 잔액 조회는 5분 캐시된다 — refresh 일 때만 실제로 다시 부른다. */
async function refreshOpenRouterCredits(refresh = false) {
  const key = piManager.apiKey();
  if (!key) {
    openRouterCredits = null;
    openRouterCreditsKey = null;
  } else {
    let result;
    try {
      result = await piManager.credits(refresh === true);
    } catch (error) {
      result = emptyCreditsError(error);
    }
    if (piManager.apiKey() === key) {
      openRouterCredits = result;
      openRouterCreditsKey = crypto.createHash('sha256').update(key).digest('hex');
    }
  }
}

async function usageSnapshotRefreshing(refresh = false) {
  await Promise.all([
    providerLimits.refresh(refresh === true),
    refreshOpenRouterCredits(refresh),
  ]);
  return usageSnapshot();
}

/**
 * 보조 작업(제목·스킬 초안·문체 분석)을 OpenRouter 로 돌릴지 정한다.
 * pi 를 고른 사용자거나, CLI 가 없는데 pi 설정은 끝나 있는 경우다.
 *
 * @param {string|null|undefined} requestedAgent
 * @param {'claude'|'codex'} cliAgent 이 작업이 원래 쓰는 CLI
 */
function spawnAuxiliaryProcess(record, command, args, options = {}) {
  if (record.disposed) throw new Error('Hub session was disposed');
  if (record.processCleanupUncertain) throw agentProcessCleanupUncertain();
  const child = spawn(command, args, { ...options, cwd: options.cwd ?? record.workDir });
  record.auxiliaryProcesses.add(child);
  const cleanup = () => {
    child.off?.('close', cleanup);
    void beginAuxiliaryProcessCleanupOutcome(record, child);
  };
  // ChildProcess `close` is ordered after stdout/stderr have drained. Starting
  // automatic cleanup on `exit` can beat a terminal protocol frame still in
  // those pipes, record UNAVAILABLE, and quarantine an otherwise clean
  // session. Terminal handlers start the shared cleanup while the process
  // handle is live; this close hook is the fail-closed fallback.
  child.once('close', cleanup);
  return child;
}

function beginAuxiliaryProcessCleanupOutcome(record, child) {
  const current = record.auxiliaryProcessCleanups.get(child);
  if (current) return current;
  const cleanup = terminateAndWaitForProcessTreeExitOutcome(child)
    .catch(() => PROCESS_TREE_CLEANUP_OUTCOME.FAILED)
    .then((outcome) => {
      if (outcome !== PROCESS_TREE_CLEANUP_OUTCOME.PROVEN) {
        record.processCleanupUncertain = true;
        retainUncertainProcessCleanup(record.recordRoot);
      }
      // UNAVAILABLE is not proof. Keep the child and its resolved cleanup
      // sentinel tracked so a later record disposal cannot mistake an empty
      // set for a safely drained process tree.
      if (outcome === PROCESS_TREE_CLEANUP_OUTCOME.PROVEN) {
        record.auxiliaryProcesses.delete(child);
        record.auxiliaryProcessCleanups.delete(child);
      }
      return outcome;
    });
  record.auxiliaryProcessCleanups.set(child, cleanup);
  return cleanup;
}

function beginAuxiliaryProcessCleanup(record, child) {
  return beginAuxiliaryProcessCleanupOutcome(record, child)
    .then((outcome) => outcome === PROCESS_TREE_CLEANUP_OUTCOME.PROVEN);
}

/**
 * 보조 CLI(claude/codex) 스폰 래퍼 — 해당 프로바이더의 키를 그 자식에게만 얹는다.
 * process.env 에 키가 없으므로(위 주석 참고), 인증이 필요한 보조 실행은 여기서 채운다.
 */
function auxSpawnProcess(record, command, args, options = {}) {
  const finalOptions = { ...options };
  if (command === 'claude' || command === 'codex') {
    finalOptions.env = {
      ...cliSetup.envFor(command),
      ...(options.env ?? {}),
    };
  }
  return spawnAuxiliaryProcess(record, command, args, finalOptions);
}

async function stopAuxiliaryProcesses(record) {
  const children = [...record.auxiliaryProcesses];
  const results = await Promise.all(children.map((child) => (
    beginAuxiliaryProcessCleanup(record, child)
  )));
  return results.every(Boolean);
}

function cancelCheckpointTitleJobs(record) {
  const controllers = [...record.checkpointTitleControllers];
  record.checkpointTitleControllers.clear();
  for (const controller of controllers) controller.abort();
}

function checkpointTitleDeps(record, health, signal) {
  const codex = resolveCheckpointTitleCliRoute(
    'codex', health?.codex, cliSetupStatus.codex, cliSetup.binPath('codex'),
  );
  const claude = resolveCheckpointTitleCliRoute(
    'claude', health?.claude, cliSetupStatus.claude, cliSetup.binPath('claude'),
  );
  return {
    readiness: {
      codex: {
        ready: codex.ready && codexQuotaAllowsTitle(providerLimits.snapshot().codex),
        model: 'luna',
      },
      pi: { ready: Boolean(piManager.apiKey()), model: 'openrouter' },
      claude: { ready: claude.ready, model: 'claude-haiku-4-5' },
    },
    piManager,
    openRouter,
    workDir: record.workDir,
    isolatedHome: record.isolatedHome,
    sessionId: record.sessionId,
    commands: {
      codex: codex.command,
      claude: claude.command,
    },
    providerEnvs: {
      codex: { ...cliSetup.envFor('codex'), CODEX_HOME: record.codexHome },
      claude: claudeRuntimeEnv(record.isolatedHome),
    },
    resolveCodexTitleModel: () => resolveModel('codex', 'luna', record),
    resolvePiTitleModel: () => resolveOpenRouterTitleModel(
      () => openRouter.catalog(false, piManager.apiKey()),
    ),
    spawnProcess: (command, args, options) => spawnAuxiliaryProcess(record, command, args, options),
    terminateProcess: terminateProcessTree,
    cleanupProcessOutcome: (child) => beginAuxiliaryProcessCleanupOutcome(record, child),
    signal,
  };
}

function auxDeps(record, requestedAgent, cliAgent) {
  const agent = requestedAgent === 'pi'
    || requestedAgent === 'claude' || requestedAgent === 'codex'
    ? requestedAgent
    : (record.agentSession?.agent ?? null);
  const manager = piManager;
  const router = openRouter;
  const health = providerHealth.cached();
  // 프로브 전이면 CLI 가 있다고 보고 기존 경로를 먼저 태운다.
  const cliAvailable = health ? health[cliAgent]?.available !== false : true;
  return {
    useOpenRouter: (piStatus.setupComplete && (agent === 'pi' || !cliAvailable)),
    piManager: manager,
    openRouter: router,
    workDir: record.workDir,
    cwd: record.workDir,
    isolatedHome: record.isolatedHome,
    sessionId: record.sessionId,
    spawnProcess: (command, args, options) => auxSpawnProcess(record, command, args, options),
    terminateProcess: terminateProcessTree,
    cleanupProcessOutcome: (child) => beginAuxiliaryProcessCleanupOutcome(record, child),
  };
}

function sessionInfo(record) {
  const activeSession = record.agentSession;
  return activeSession
    ? {
      agent: activeSession.agent,
      model: activeSession.model,
      effort: activeSession.effort,
      permissionProfile: activeSession.permissionProfile,
      serviceTier: activeSession.serviceTier,
      sessionId: activeSession.sessionId,
      threadId: activeSession.threadId,
      documentId: activeSession.documentId,
      documentName: activeSession.documentName,
      status: activeSession.status,
      turnId: activeSession.turnId,
      activeTemplateId: activeSession.activeTemplateId,
      pendingUserQuestion: pendingUserQuestionSnapshot(record),
      pendingChatPermissionRequest: pendingChatPermissionSnapshot(record),
      chatPermissionGrants: normalizeChatPermissionGrants(activeSession.chatPermissionGrants),
      ...activeSession.planning.snapshot(),
    }
    : null;
}

function artifactDownloadDescriptor(record, artifactId, artifact) {
  const encodePathSegment = (value) => encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  const downloadUrl = new URL(
    `/artifacts/${encodePathSegment(artifactId)}/${encodePathSegment(artifact.fileName)}`,
    `http://127.0.0.1:${hubPort}`,
  );
  downloadUrl.searchParams.set('sessionId', record.sessionId);
  downloadUrl.searchParams.set('token', sessions.issue(TOKEN, record.sessionId, {
    audience: HUB_CAPABILITY_AUDIENCES.ARTIFACT,
    resource: artifactId,
  }));
  downloadUrl.searchParams.set('templatePreview', '1');
  return {
    artifactId,
    fileName: artifact.fileName,
    mime: artifact.mime,
    size: artifact.size,
    checksum: artifact.checksum,
    downloadUrl: downloadUrl.href,
  };
}

/**
 * 대화에 남은 카드의 artifactId로 지금 허브 세션의 다운로드 주소를 새로 만든다.
 * 예전 주소는 허브 포트·세션·토큰이 바뀌면 쓸 수 없다.
 */
async function freshArtifactDescriptor(record, artifactId, threadId) {
  const id = String(artifactId ?? '');
  const metadata = await record.artifactStore.describe(id);
  if (!metadata.owner?.threadId || metadata.owner.threadId !== threadId) {
    throw workflowError('ARTIFACT_NOT_FOUND', 'Generated artifact is unavailable or expired');
  }
  return artifactDownloadDescriptor(record, id, metadata);
}

async function registerCopyLayoutTemplate(record, args) {
  const job = args.jobId ? record.templateJobs.get(args.jobId) ?? null : null;
  const outcome = await registerCopyLayoutArtifact({
    artifactStore: record.artifactStore,
    templateStore,
    threadId: record.agentSession?.threadId ?? null,
    args,
    job,
  });
  if (!outcome.alreadyRegistered) {
    if (job) job.registeredTemplateId = outcome.template.id;
    broadcastTemplateCatalog({ type: 'added', template: outcome.template });
  }
  return outcome;
}

function sendTemplateJobEvent(record, event) {
  sendJson(record.studioSocket, { v: 1, type: 'agent-event', event });
}

function workerJobForSocket(record, sock) {
  if (typeof sock.copyLayoutJobId !== 'string') return null;
  return record.templateJobs.get(sock.copyLayoutJobId) ?? null;
}

function templateCompletionResult(job) {
  return {
    jobId: job.jobId,
    outcome: job.status === 'completed' ? 'succeeded' : 'failed',
    source: job.binding,
    ...(job.result ?? {}),
  };
}

function exactJsonArray(left, right) {
  return Array.isArray(left)
    && Array.isArray(right)
    && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function copyLayoutCandidateClaims(job, published) {
  const report = published?.report;
  const evidence = report?.candidate_evidence;
  const pages = evidence?.representative_pages;
  const validRender = (entry, page) => entry
    && entry.page === page
    && Number.isSafeInteger(entry.width) && entry.width > 0 && entry.width <= 16_384
    && Number.isSafeInteger(entry.height) && entry.height > 0 && entry.height <= 16_384
    && Number.isSafeInteger(entry.bytes) && entry.bytes >= 24 && entry.bytes <= 16 * 1024 * 1024
    && typeof entry.sha256 === 'string' && /^[a-f0-9]{64}$/.test(entry.sha256);
  if (!Array.isArray(pages)
    || pages.length < 1 || pages.length > 3
    || !pages.every((page, index) => Number.isSafeInteger(page)
      && page >= 0 && (index === 0 || page > pages[index - 1]))
    || !Number.isSafeInteger(evidence?.source_page_count) || evidence.source_page_count < 1
    || !Number.isSafeInteger(evidence?.output_page_count) || evidence.output_page_count < 1
    || !Number.isSafeInteger(evidence?.output_section_count) || evidence.output_section_count < 1
    || evidence.render_compared !== true
    || evidence.safety_verified !== true
    || evidence.readability_verified !== true
    || !Array.isArray(evidence.source_renders)
    || !Array.isArray(evidence.output_renders)
    || evidence.source_renders.length !== pages.length
    || evidence.output_renders.length !== pages.length
    || !pages.every((page, index) => validRender(evidence.source_renders[index], page)
      && validRender(evidence.output_renders[index], page))) {
    throw workflowError(
      'COPY_LAYOUT_VERIFICATION_MISSING',
      'The published candidate lacks bounded helper-owned source/candidate render evidence',
    );
  }
  const quality = report?.delivery?.quality;
  const warnings = report?.delivery?.warnings;
  if (!['verified', 'best_effort'].includes(quality) || !Array.isArray(warnings)) {
    throw workflowError('COPY_LAYOUT_VERIFICATION_MISSING', 'The helper omitted its delivery result');
  }
  if (quality === 'best_effort' && job.generatedCandidates.size < COPY_LAYOUT_MAX_ITERATIONS) {
    throw workflowError(
      'COPY_LAYOUT_ITERATIONS_REQUIRED',
      `A best-effort candidate may settle only after all ${COPY_LAYOUT_MAX_ITERATIONS} bounded iterations`,
    );
  }
  const counts = {
    keptText: report?.text_decisions?.kept_count,
    removedText: report?.text_decisions?.removed_count,
    replacedText: report?.text_decisions?.replacement_count,
    resetControls: Array.isArray(report?.reset_form_controls)
      ? report.reset_form_controls.length : null,
    clearedMarks: Array.isArray(report?.cleared_border_fill_marks)
      ? report.cleared_border_fill_marks.length : null,
    keptMedia: new Set([
      ...(Array.isArray(report?.kept_layout_media) ? report.kept_layout_media : []),
      ...(Array.isArray(report?.kept_explicit_media) ? report.kept_explicit_media : []),
    ]).size,
    removedMedia: new Set([
      ...(Array.isArray(report?.removed_body_media) ? report.removed_body_media : []),
      ...(Array.isArray(report?.removed_unreferenced_media) ? report.removed_unreferenced_media : []),
    ]).size,
    iterations: job.generatedCandidates.size,
  };
  if (Object.values(counts).some((value) => !Number.isSafeInteger(value) || value < 0)) {
    throw workflowError('COPY_LAYOUT_VERIFICATION_MISSING', 'The helper omitted bounded decision counts');
  }
  return {
    quality,
    warnings,
    counts,
    preview: {
      representativePages: [...pages],
      sourcePageCount: evidence.source_page_count,
      outputPageCount: evidence.output_page_count,
      outputSectionCount: evidence.output_section_count,
      renderCompared: true,
      geometryMatch: evidence.geometry_match === true,
      safetyVerified: true,
      readabilityVerified: true,
      stoppedReason: quality === 'verified'
        ? 'verified-convergence'
        : 'bounded-no-improvement',
    },
  };
}

function drainTemplateCompletion(record) {
  const activeSession = record.agentSession;
  if (!activeSession || activeSession.status !== 'idle'
    || activeSession.pendingTransitions > 0 || record.pendingReferenceMessage) return;
  const index = record.pendingTemplateCompletions.findIndex(
    (entry) => entry.ownerThreadId === activeSession.threadId,
  );
  if (index < 0) return;
  const [entry] = record.pendingTemplateCompletions.splice(index, 1);
  beginAgentTurn(record, activeSession);
  try {
    activeSession.backend.sendUserMessage(addAgentInstructionsContext(
      buildCopyLayoutCompletionPrompt(entry.result),
    ));
  } catch (error) {
    failPendingProviderCallsForTurn(record, activeSession, activeSession.turnId);
    activeSession.status = 'idle';
    activeSession.turnId = null;
    record.userQuestionResponseReceipts.clear();
    record.pendingTemplateCompletions.splice(index, 0, entry);
    log(`copy-layout completion dispatch failed: ${error?.message ?? error}`);
  }
}

function planningDocumentSavedAllowed(activeSession) {
  const workflow = activeSession?.planning?.workflow;
  const phase = activeSession?.planning?.phase;
  return workflow === 'question'
    || (workflow === 'plan' && (phase === 'planning' || phase === 'awaiting-approval'));
}

function queuePlanningDocumentSaved(record, msg) {
  const activeSession = record.agentSession;
  if (!planningDocumentSavedAllowed(activeSession)) return;
  record.pendingDocumentSaved = {
    threadId: activeSession.threadId,
    revision: Number.isSafeInteger(msg.revision) ? msg.revision : undefined,
    fileName: typeof msg.fileName === 'string' ? msg.fileName : undefined,
  };
  drainPlanningDocumentSaved(record);
}

function drainPlanningDocumentSaved(record) {
  const activeSession = record.agentSession;
  const pending = record.pendingDocumentSaved;
  if (!pending || !activeSession || activeSession.status !== 'idle'
    || activeSession.pendingTransitions > 0 || record.pendingReferenceMessage) return;
  if (pending.threadId !== activeSession.threadId || !planningDocumentSavedAllowed(activeSession)) {
    record.pendingDocumentSaved = null;
    return;
  }
  const phase = activeSession.planning.phase;
  record.pendingDocumentSaved = null;
  const prompt = buildPlanningDocumentSavedPrompt(pending);
  activeSession.status = 'running';
  if (phase === 'awaiting-approval') {
    const planId = activeSession.planning.latestPlan?.planId;
    if (!planId) {
      activeSession.status = 'idle';
      return;
    }
    void requestImplementationPlanChanges(record, record.studioSocket, {
      planId,
      reason: 'document-saved',
      promptOverride: prompt,
    }, { sessionStatusOverride: 'idle' }).catch((error) => {
      if (record.agentSession === activeSession) {
        if (activeSession.status === 'running') activeSession.status = 'idle';
        if (!record.pendingDocumentSaved) record.pendingDocumentSaved = pending;
      }
      sendChatError(record.studioSocket, error);
    });
    return;
  }
  try {
    beginAgentTurn(record, activeSession);
    activeSession.backend.sendUserMessage(addAgentInstructionsContext(addActiveDocumentContext(
      activeSession,
      addTemplateContext(record, activeSession, prompt),
    )));
  } catch (error) {
    failPendingProviderCallsForTurn(record, activeSession, activeSession.turnId);
    activeSession.status = 'idle';
    activeSession.turnId = null;
    record.userQuestionResponseReceipts.clear();
    record.pendingDocumentSaved = pending;
    log(`planning document-saved dispatch failed: ${error?.message ?? error}`);
  }
}

function queueTemplateCompletion(record, job) {
  if (job.completionQueued) return;
  job.completionQueued = true;
  record.pendingTemplateCompletions.push({
    ownerThreadId: job.ownerThreadId,
    result: templateCompletionResult(job),
  });
  drainTemplateCompletion(record);
}

function pruneTemplateJobHistory(record) {
  if (record.templateJobs.size <= MAX_COPY_LAYOUT_JOB_HISTORY) return;
  for (const [jobId, job] of record.templateJobs) {
    if (record.templateJobs.size <= MAX_COPY_LAYOUT_JOB_HISTORY) break;
    if (job.status === 'running' || job.status === 'settling' || jobId === record.activeTemplateJobId) continue;
    record.templateJobs.delete(jobId);
  }
}

async function cleanupTemplateGeneratedRoot(record, job) {
  if (!job?.generatedRoot && !job?.snapshotRoot) return true;
  if (record.processCleanupUncertain) {
    record.copyLayoutStorageUncertain = true;
    return false;
  }
  try {
    await Promise.all([
      job.generatedRoot ? fs.rm(job.generatedRoot, { recursive: true, force: true }) : undefined,
      job.snapshotRoot ? fs.rm(job.snapshotRoot, { recursive: true, force: true }) : undefined,
    ]);
    return true;
  } catch (error) {
    record.copyLayoutStorageUncertain = true;
    log(`copy-layout private output cleanup failed: ${error?.message ?? error}`);
    return false;
  }
}

async function cleanupTemplateProviderRoots(record, job, backendCleaned) {
  const credentialsCleaned = flushProviderCredentialHomes(job.providerHomes);
  if (backendCleaned === false || !credentialsCleaned) {
    record.copyLayoutStorageUncertain = true;
    if (backendCleaned === false) {
      record.processCleanupUncertain = true;
      retainUncertainProcessCleanup(record.recordRoot);
    }
    return false;
  }
  try {
    await Promise.all([
      job.jobDir ? fs.rm(job.jobDir, { recursive: true, force: true }) : undefined,
      job.providerRoot ? fs.rm(job.providerRoot, { recursive: true, force: true }) : undefined,
    ]);
    return true;
  } catch (error) {
    record.copyLayoutStorageUncertain = true;
    log(`copy-layout provider workspace cleanup failed: ${error?.message ?? error}`);
    return false;
  }
}

function cancelPendingTemplateCalls(record, job) {
  for (const [hubId, entry] of record.pendingCalls) {
    if (entry.copyLayoutJobId !== job.jobId) continue;
    record.pendingCalls.delete(hubId);
    clearTimeout(entry.timer);
    cancelStudioToolRequest(record, hubId, entry, 'copy-layout-job-settled');
    releaseCopyLayoutSnapshot(job);
    sendJson(entry.mcpSocket, {
      v: 1,
      type: 'tool-result',
      id: entry.clientId,
      ok: false,
      error: {
        code: 'COPY_LAYOUT_JOB_SETTLED',
        message: 'The copy-layout job settled before Studio completed this tool request',
      },
    });
  }
}

function settleTemplateJobFailure(record, job, error) {
  if (!job || job.status !== 'running') return;
  const message = String(error?.message ?? error ?? 'Autonomous copy-layout worker stopped without a completion report');
  job.status = 'failed';
  cancelPendingTemplateCalls(record, job);
  job.activity = message;
  job.result = {
    summary: message,
    warnings: [message],
    counts: {
      keptText: 0, removedText: 0, replacedText: 0, resetControls: 0,
      clearedMarks: 0, keptMedia: 0, removedMedia: 0, iterations: 1,
    },
    preview: {
      representativePages: [], sourcePageCount: 1, outputPageCount: 1,
      outputSectionCount: 1, renderCompared: false, geometryMatch: false,
      safetyVerified: false, readabilityVerified: false, stoppedReason: 'hard-failure',
    },
  };
  job.inspection = null;
  job.generatedCandidates?.clear();
  job.publishedArtifacts?.clear();
  record.activeTemplateJobId = null;
  void Promise.allSettled([
    Promise.resolve(job.helperPromise),
    Promise.resolve(job.snapshotPromise),
  ]).then(() => cleanupTemplateGeneratedRoot(record, job));
  pruneTemplateJobHistory(record);
  sendTemplateJobEvent(record, {
    type: 'task-end', agent: job.agent, taskId: job.jobId,
    status: 'failed', summary: message, ...(job.usage ? { usage: job.usage } : {}),
  });
  queueTemplateCompletion(record, job);
}

function makeTemplateWorkerEventHandler(record, job) {
  return (event) => {
    if (job.status !== 'running' && event.type !== 'turn-end') return;
    if (event.type === 'session-info' && event.sessionId) job.providerSessionId = event.sessionId;
    if (event.type === 'text-delta' && event.text?.trim()) {
      job.activity = event.text.replace(/\s+/g, ' ').trim().slice(-500);
      // 근황 스냅샷은 토큰마다 바뀐다 — 같은 창 안에서는 마지막 것만 보낸다.
      studioFrames.pushProgress(record.studioSocket, {
        v: 1, type: 'agent-event', event: taskProgressForJob(job, job.activity),
      });
      return;
    }
    if (event.type === 'tool-call') {
      job.usage = { ...(job.usage ?? {}), toolUses: (job.usage?.toolUses ?? 0) + 1 };
      sendTemplateJobEvent(record, taskProgressForJob(job, job.activity, event.tool));
      return;
    }
    if (event.type === 'usage') {
      usageStore.record({ agent: job.agent, model: event.model, costUsd: event.costUsd, ...(event.usage ?? {}) });
      const totalTokens = Object.values(event.usage ?? {}).reduce((sum, value) => sum + (Number(value) || 0), 0);
      job.usage = { ...(job.usage ?? {}), totalTokens };
      sendJson(record.studioSocket, { v: 1, type: 'usage-report', usage: usageSnapshot() });
      sendTemplateJobEvent(record, taskProgressForJob(job, job.activity));
      return;
    }
    if (event.type === 'error') {
      job.lastError = event.message;
      job.activity = event.message;
      sendTemplateJobEvent(record, taskProgressForJob(job, event.message));
      return;
    }
    if (event.type === 'turn-end') {
      if (job.status === 'running') settleTemplateJobFailure(record, job, job.lastError || event.errorMessage);
      const backend = job.backend;
      job.backend = null;
      void Promise.resolve(backend?.dispose())
        .catch((error) => {
          log(`copy-layout worker dispose failed: ${error?.message ?? error}`);
          return false;
        })
        .then((cleaned) => cleanupTemplateProviderRoots(record, job, cleaned));
    }
  };
}

async function launchTemplateJob(record, job) {
  return launchCopyLayoutWorker(record, job, {
    ensureBootWork,
    prepareCodexHome,
    sourceCodexAuthPath,
    prepareClaudeHome,
    sourceClaudeAuth,
    MCP_SCRIPT,
    hubPort,
    sessions,
    TOKEN,
    HUB_CAPABILITY_AUDIENCES,
    cliSetupStatus,
    cliSetup,
    claudeRuntimeEnv,
    CLI_SETUP_AGENTS,
    makeTemplateWorkerEventHandler,
    buildCopyLayoutWorkerPrompt,
    piManager,
    piModelConfig,
    SESSION_FACTORIES,
    unknownAgentError
  });
}

function createTemplateJob(record, activeSession, binding) {
  if (record.copyLayoutStorageUncertain) {
    throw workflowError('COPY_LAYOUT_STORAGE_UNCERTAIN', 'A prior copy-layout workspace could not be cleaned; restart the hub before retrying');
  }
  if (record.activeTemplateJobId) {
    const active = record.templateJobs.get(record.activeTemplateJobId);
    if (active && active.status !== 'completed' && active.status !== 'failed') {
      throw workflowError('COPY_LAYOUT_JOB_ACTIVE', 'A copy-layout job is already running for this Studio window');
    }
  }
  if (binding.documentId !== activeSession.documentId) {
    throw workflowError('DOCUMENT_ID_MISMATCH', 'The copy-layout binding does not match this chat\'s exact documentId');
  }
  const latest = activeSession.lastDocumentInfo;
  if (!latest
    || latest.documentId !== binding.documentId
    || latest.digest !== binding.digest
    || latest.sourceFormat !== binding.sourceFormat
    || latest.dirty !== binding.dirty
    || latest.sourcePath !== binding.sourcePath) {
    throw workflowError(
      'COPY_LAYOUT_BINDING_STALE',
      'Call get_document_info immediately before delegation and pass its exact current binding',
    );
  }
  const jobId = crypto.randomUUID();
  const job = {
    jobId,
    ownerThreadId: activeSession.threadId,
    agent: activeSession.agent,
    model: activeSession.model,
    effort: activeSession.effort,
    binding: structuredClone(binding),
    status: 'running',
    phase: 'binding-source',
    activity: '정확한 원본 문서를 고정하는 중',
    capabilityEpoch: activeSession.planning.capabilityEpoch,
    workerRole: `copy-layout-worker:${jobId}:${crypto.randomBytes(18).toString('base64url')}`,
    backend: null,
    usage: { toolUses: 0 },
    completionQueued: false,
    registeredTemplateId: null,
    providerHomes: null,
    snapshot: null,
    snapshotPending: false,
    snapshotPromise: null,
    helperPending: 0,
    helperPromise: null,
    inspection: null,
    generatedCandidates: new Map(),
    publishedArtifacts: new Map(),
    publishPending: false,
    completionPromise: null,
    generatedRoot: null,
    snapshotRoot: null,
  };
  record.templateJobs.set(jobId, job);
  record.activeTemplateJobId = jobId;
  sendTemplateJobEvent(record, {
    type: 'task-start', agent: job.agent, taskId: job.jobId,
    title: '레이아웃 템플릿 자동 완성',
    taskKind: 'agent', background: true,
  });
  sendTemplateJobEvent(record, taskProgressForJob(job, job.activity));
  void launchTemplateJob(record, job).catch((error) => {
    flushProviderCredentialHomes(job.providerHomes);
    settleTemplateJobFailure(record, job, error);
  });
  return job;
}

const TRACED_PROVIDER_EVENTS = new Set(['turn-start', 'turn-end', 'tool-call', 'tool-result', 'task-start', 'task-end']);

function makeBackendEventHandler(record, generation) {
  return (evt) => {
    const activeSession = record.agentSession;
    if (!activeSession || activeSession.generation !== generation) return;
    if (TOOL_TRACE_ENABLED && TRACED_PROVIDER_EVENTS.has(evt.type)) {
      writeToolTrace({
        kind: 'provider',
        t: traceNow(),
        ev: evt.type,
        agent: evt.agent ?? activeSession.agent,
        turnId: activeSession.turnId ?? null,
        ...(evt.callId ? { callId: evt.callId } : {}),
        ...(evt.tool ? { tool: evt.tool } : {}),
        ...(evt.taskId ? { taskId: evt.taskId } : {}),
        ...(evt.parentTaskId ? { parentTaskId: evt.parentTaskId } : {}),
        ...(evt.type === 'tool-result' ? { ok: evt.ok !== false } : {}),
        ...(evt.type === 'turn-end' && evt.status ? { status: String(evt.status) } : {}),
      });
    }
    if (evt.type === 'tool-call' && isRequestPermissionTool(evt.tool)) {
      if (evt.callId) record.suppressedChatPermissionCallIds.add(evt.callId);
      let request = null;
      try { request = normalizeChatPermissionRequest(JSON.parse(evt.argsJson ?? '{}')); } catch {}
      record.pendingChatPermissionScopes.push({ agent: evt.agent, callId: evt.callId, parentTaskId: evt.parentTaskId ?? null, request });
      if (record.pendingChatPermissionScopes.length > 8) record.pendingChatPermissionScopes.splice(0, record.pendingChatPermissionScopes.length - 8);
      return;
    }
    if (evt.type === 'tool-result' && record.suppressedChatPermissionCallIds.has(evt.callId)) {
      record.suppressedChatPermissionCallIds.delete(evt.callId);
      const index = record.pendingChatPermissionScopes.findIndex((scope) => scope.callId === evt.callId);
      if (index >= 0) record.pendingChatPermissionScopes.splice(index, 1);
      return;
    }
    // The fallback question tool is a first-class blocking interaction. Keep
    // its provider bookkeeping out of the generic tool activity transcript;
    // the dedicated requested/resolved lifecycle is the only Studio surface.
    if (evt.type === 'tool-call' && isAskUserQuestionTool(evt.tool)) {
      if (evt.callId) record.suppressedUserQuestionCallIds.add(evt.callId);
      let questions = null;
      try {
        const args = userQuestionArgsFromToolInput(JSON.parse(evt.argsJson ?? '{}'));
        questions = normalizeMcpUserQuestionRequest(args, 'scope-ticket').questions;
      } catch {
        // The MCP boundary will return the detailed schema error. Keep this
        // ticket unusable so malformed or uncorrelated callers fail closed.
      }
      const duplicateScope = record.pendingUserQuestionScopes.findIndex((scope) => (
        scope.agent === evt.agent && scope.callId === evt.callId
      ));
      if (duplicateScope >= 0) record.pendingUserQuestionScopes.splice(duplicateScope, 1);
      record.pendingUserQuestionScopes.push({
        agent: evt.agent,
        callId: evt.callId,
        parentTaskId: evt.parentTaskId ?? null,
        questions,
      });
      if (record.pendingUserQuestionScopes.length > 8) {
        record.pendingUserQuestionScopes.splice(0, record.pendingUserQuestionScopes.length - 8);
      }
      return;
    }
    if (evt.type === 'tool-result' && record.suppressedUserQuestionCallIds.has(evt.callId)) {
      record.suppressedUserQuestionCallIds.delete(evt.callId);
      const scopeIndex = record.pendingUserQuestionScopes.findIndex((scope) => scope.callId === evt.callId);
      if (scopeIndex >= 0) record.pendingUserQuestionScopes.splice(scopeIndex, 1);
      return;
    }
    if (evt.type === 'session-info' && evt.sessionId) activeSession.sessionId = evt.sessionId;
    if (evt.type === 'usage') {
      usageStore.record({
        agent: activeSession.agent, model: evt.model, costUsd: evt.costUsd, ...(evt.usage ?? {}),
      });
      sendJson(record.studioSocket, { v: 1, type: 'usage-report', usage: usageSnapshot() });
      return;
    }
    const providerTurnId = activeSession.turnId;
    if (evt.type === 'turn-start') {
      // Backends emit this only after their lifecycle has released the prior
      // process tree and activated this queued turn. Accepting the Studio
      // message alone is not provider-capability proof.
      if (activeSession.status !== 'running' || !providerTurnId) return;
      activeSession.providerTurnStarted = true;
    }
    const studioEvent = providerTurnId
      ? { ...evt, turnId: providerTurnId }
      : evt;
    if (evt.type === 'turn-start') record.missedTurnEnd = null;
    if (evt.type === 'turn-end') {
      settleAgentTurn(record, activeSession, evt);
      // 서브에이전트 브라우저는 턴과 함께 끝난다 — 메인 브라우저만 다음 턴까지 산다.
      record.browserbaseSession.cleanupExtras('turn ended');
    }
    // Opt-in sends acknowledge before Studio inserts the user bubble. A
    // synchronous turn-start inside sendUserMessage must follow that receipt.
    const pendingMessage = [...record.userMessageReceipts.values()].find((receipt) => (
      receipt.message && receipt.session === activeSession && receipt.turnId === providerTurnId
    ));
    const delivered = pendingMessage
      ? (pendingMessage.events ??= [], pendingMessage.events.push(studioEvent), true)
      : sendAgentEvent(record, studioEvent);
    if (evt.type === 'turn-end' && !delivered) record.missedTurnEnd = studioEvent;
    if (evt.type === 'turn-end') {
      record.userQuestionResponseReceipts.clear();
      record.suppressedUserQuestionCallIds.clear();
      record.pendingUserQuestionScopes.length = 0;
      record.suppressedChatPermissionCallIds.clear();
      record.pendingChatPermissionScopes.length = 0;
    }
    if (evt.type === 'turn-end') drainTemplateCompletion(record);
    if (evt.type === 'turn-end') drainPlanningDocumentSaved(record);
  };
}

/** 턴 끝이 아닌 이벤트는 그대로 보내고, text-delta 만 소켓별로 모은다. */
function sendAgentEvent(record, event) {
  const frame = { v: 1, type: 'agent-event', event };
  return event.type === 'text-delta'
    ? studioFrames.pushTextDelta(record.studioSocket, frame)
    : sendJson(record.studioSocket, frame);
}

function disposeSession(record) {
  record.pendingReferenceMessage = null;
  rejectPendingUserMessages(record, 'REQUEST_INVALIDATED', 'The chat stopped before accepting the message');
  record.pendingDocumentSaved = null;
  // 채팅 중지·창 닫기·허브 종료가 겹치면 같은 공급자 종료를 기다린다.
  // agentSession 을 비웠다고 아직 살아 있는 프로세스의 작업 폴더를 지우면 안 된다.
  if (record.sessionDisposalPromise) return record.sessionDisposalPromise;
  const activeSession = record.agentSession;
  if (!activeSession) {
    retireAllPiSubagents(record);
    return Promise.resolve(record.processCleanupUncertain !== true);
  }
  const wasRunning = activeSession.status === 'running';
  const disposedTurnId = activeSession.turnId;
  const agent = activeSession.agent;
  settleUserQuestion(record, { status: 'expired', reason: 'request-invalidated' });
  settleChatPermissionRequest(record, { status: 'expired', reason: 'request-invalidated' });
  record.chatPermissionResponseReceipts.clear();
  record.suppressedChatPermissionCallIds.clear();
  record.pendingChatPermissionScopes.length = 0;
  record.userQuestionResponseReceipts.clear();
  record.suppressedUserQuestionCallIds.clear();
  record.pendingUserQuestionScopes.length = 0;
  failPendingProviderCallsForTurn(record, activeSession, activeSession.turnId);
  retireAllPiSubagents(record);
  activeSession.turnId = null;
  activeSession.providerTurnStarted = false;
  retireProviderSockets(record, activeSession, {
    code: 4001,
    reason: 'provider session replaced',
  });
  let backendExit = Promise.resolve(true);
  try {
    backendExit = Promise.resolve(activeSession.backend.dispose());
  } catch (e) {
    log(`session dispose error: ${e?.message ?? e}`);
    backendExit = Promise.resolve(false);
  }
  try { activeSession.releaseReferenceScopes?.(); } catch {}
  record.agentSession = null;
  let browserbaseExit;
  try {
    browserbaseExit = Promise.resolve(record.browserbaseSession.cleanup('session disposed'));
  } catch (error) {
    log(`Browserbase session cleanup failed: ${error?.message ?? error}`);
    browserbaseExit = Promise.resolve(false);
  }
  if (wasRunning) {
    const evt = {
      type: 'turn-end',
      agent,
      stopReason: 'interrupted',
      ...(disposedTurnId ? { turnId: disposedTurnId } : {}),
    };
    if (!sendJson(record.studioSocket, { v: 1, type: 'agent-event', event: evt })) {
      record.missedTurnEnd = evt;
    }
  }
  record.sessionDisposalPromise = Promise.allSettled([backendExit, browserbaseExit]).then(([backend, browserbase]) => {
    const backendCleaned = backend.status === 'fulfilled' && backend.value !== false;
    const browserbaseCleaned = browserbase.status === 'fulfilled' && browserbase.value !== false;
    if (backend.status === 'rejected') {
      log(`session process exit wait failed: ${backend.reason?.message ?? backend.reason}`);
    }
    if (browserbase.status === 'rejected') {
      log(`Browserbase session exit wait failed: ${browserbase.reason?.message ?? browserbase.reason}`);
    }
    if (backendCleaned && browserbaseCleaned && record.processCleanupUncertain !== true) return true;
    record.processCleanupUncertain = true;
    if (!backendCleaned) retainedUncertainBackends.add(activeSession.backend);
    if (!browserbaseCleaned) retainedUncertainBrowserbaseSessions.add(record.browserbaseSession);
    retainUncertainProcessCleanup(record.recordRoot);
    return false;
  }).finally(() => {
    record.sessionDisposalPromise = null;
  });
  return record.sessionDisposalPromise;
}

function agentProcessCleanupUncertain(cause = null) {
  const error = new Error(
    'The previous provider process tree could not be confirmed stopped. Restart the app before starting another provider.',
    cause ? { cause } : undefined,
  );
  error.code = 'AGENT_PROCESS_CLEANUP_UNCERTAIN';
  error.processCleanupUncertain = true;
  return error;
}

function resolvePermissionProfile(value) {
  return value === 'unrestricted' ? 'unrestricted' : 'safe';
}

/** 플랜 승인에 실린 권한은 엄격히 검사한다 — 오타가 조용히 safe 로 떨어지지 않게. */
function approvalPermissionProfile(value) {
  if (value === 'safe' || value === 'unrestricted') return value;
  throw workflowError('INVALID_PERMISSION_PROFILE', `Unknown permission profile: ${String(value)}`);
}

function resolveWorkflow(value) {
  if (value === undefined || value === null) return 'direct';
  if (value === 'direct' || value === 'plan' || value === 'question') return value;
  throw workflowError('INVALID_WORKFLOW', `Unknown workflow: ${String(value)}`);
}

const CHAT_HISTORY_MAX_MESSAGES = 40;
const CHAT_HISTORY_MAX_ENTRY_CHARS = 8_000;
const CHAT_HISTORY_MAX_TOTAL_CHARS = 32_000;

function normalizeChatHistory(value) {
  if (!Array.isArray(value)) return [];
  const history = [];
  let remaining = CHAT_HISTORY_MAX_TOTAL_CHARS;
  for (const entry of value.slice(-CHAT_HISTORY_MAX_MESSAGES).reverse()) {
    if (!entry || (entry.role !== 'user' && entry.role !== 'assistant')) continue;
    const text = typeof entry.text === 'string' ? entry.text.trim().slice(0, CHAT_HISTORY_MAX_ENTRY_CHARS) : '';
    if (!text || remaining <= 0) continue;
    const bounded = text.slice(-remaining);
    history.unshift({ role: entry.role, text: bounded });
    remaining -= bounded.length;
  }
  return history;
}

function addReopenedChatHistory(activeSession, prompt) {
  const history = activeSession.bootstrapHistory;
  activeSession.bootstrapHistory = [];
  if (!Array.isArray(history) || history.length === 0) return prompt;
  const block = [
    '<reopened_chat_history trust="conversation-transcript">',
    JSON.stringify(history),
    'Continue this conversation consistently. The final user request follows after this transcript.',
    '</reopened_chat_history>',
  ].join('\n');
  return `${block}\n\n${prompt}`;
}

function referenceScopes(activeSession) {
  return referenceScopesForSession(activeSession);
}

/** 연구 프로젝트 요약(언급·발췌 포함)과 메시지 첨부를 사용자 메시지 앞에 붙인다. */
async function addReferenceContext(activeSession, query, prompt, messageAttachments = [], mentions = [], { required = false } = {}) {
  try {
    const record = sessions.get(activeSession.hubSessionId ?? '') ?? null;
    const repository = record ? repositoryContext(record) : null;
    const block = await projectPromptContext({
      projectStore,
      referenceStore,
      projectId: activeSession.projectId ?? null,
      worktree: repository?.worktree ?? null,
      worktreeCount: repository?.worktrees.length ?? 0,
      worktreeBranch: (worktreeId) => (
        repository?.worktrees.find((entry) => entry.id === worktreeId)?.branch ?? projectStore.worktreeBranch(worktreeId)
      ),
      scopes: referenceScopes(activeSession),
      query,
      mentions,
      settings: projectSettings.get(),
    });
    const attached = messageAttachments.length > 0
      ? `<message_attachments trust="untrusted-data">\n${JSON.stringify(messageAttachments.map(({ id, itemId, name, mimeType, kind }) => ({
        ...(itemId ? { itemId } : {}),
        fileId: id,
        name,
        mimeType,
        kind,
      })))}\n</message_attachments>`
      : '';
    return [block, attached, prompt].filter(Boolean).join('\n\n');
  } catch (error) {
    log(`reference retrieval failed: ${error?.message ?? error}`);
    if (required) throw error;
    return prompt;
  }
}

/** MCP 등록·호출 게이트: 채팅의 프로젝트 변경 허용과 홈 폴더 검색 가능 여부. */
function projectToolGates() {
  return { chatMayEdit: projectSettings.get().agent.chatMayEdit, homeSearch: homeSearch.available };
}

function sendToProjectStudios(projectId, frame) {
  if (!projectEventsLive) return;
  for (const record of sessions.values()) {
    if (record.boundProjectId === projectId) sendJson(record.studioSocket, frame);
  }
}

async function sendProjectBound(record) {
  const projectId = record.boundProjectId;
  if (!projectId) return;
  try {
    const project = await projectStore.get(projectId);
    if (record.boundProjectId !== projectId) return;
    sendJson(record.studioSocket, { v: 1, type: 'project-bound', projectId, project });
  } catch (error) {
    log(`project-bound failed: ${error?.message ?? error}`);
  }
}

function onProjectChanged(projectId, details = {}) {
  // 합류·나가기·삭제는 문서가 가리키는 프로젝트를 바꾼다 — 묶인 세션을 다시 맞춘다.
  if (details.reason === 'deleted' || details.reason === 'merged' || details.reason === 'members') {
    setImmediate(() => {
      void reconcileProjectBindings().catch((error) => log(`project rebind failed: ${error?.message ?? error}`));
    });
  }
  if (details.reason === 'deleted' || details.reason === 'merged' || projectChangeTimers.has(projectId)) return;
  const timer = setTimeout(() => {
    projectChangeTimers.delete(projectId);
    if (!projectEventsLive) return;
    void projectStore.get(projectId)
      .then((project) => sendToProjectStudios(projectId, {
        v: 1,
        type: 'project-changed',
        projectId,
        revision: project.revision,
        project,
      }))
      .catch(() => {});
  }, 150);
  timer.unref?.();
  projectChangeTimers.set(projectId, timer);
}

/**
 * Studio 가 보낸 저장소·작업 공간을 세션에 둔다 (chat-start·project-bind). 그 문서의 것일 때만
 * 묶기·표시에 쓴다. 바뀌었으면 true.
 */
function applyRecordRepository(record, documentId, msg) {
  const repository = typeof documentId === 'string' && documentId
    ? normalizeRepository({ id: msg?.repositoryId, worktree: msg?.worktree, worktrees: msg?.worktrees })
    : null;
  const next = repository ? { documentId, repository } : null;
  const changed = JSON.stringify(record.projectRepository ?? null) !== JSON.stringify(next);
  record.projectRepository = next;
  return changed;
}

/** 묶인 문서의 저장소 정보. 버전 기록이 없는 문서면 null. */
function repositoryContext(record) {
  const binding = record.projectRepository;
  return binding && binding.documentId === record.boundDocumentId ? binding.repository : null;
}

/** 세션의 작업 공간 표시 규칙 ('current' 와 새 항목 자동 표시). */
function recordLabels(record) {
  return originLabels(repositoryContext(record));
}

/** 문서(없으면 스레드) → 프로젝트. 실패해도 채팅은 프로젝트 없이 계속된다. */
async function bindRecordProject(record, { threadId, documentId, documentName, create = true }) {
  let projectId = null;
  const binding = record.projectRepository;
  try {
    projectId = await projectStore.bindSession({
      threadId,
      documentId,
      documentName,
      repository: binding && binding.documentId === documentId ? binding.repository : null,
      create,
    });
  } catch (error) {
    log(`project binding failed: ${error?.message ?? error}`);
  }
  record.boundProjectId = projectId;
  record.boundDocumentId = documentId ?? null;
  record.boundDocumentName = documentName ?? null;
  record.boundThreadId = threadId ?? null;
  if (projectId) projectRecords.set(projectId, record);
  return projectId;
}

async function rebindRecordProject(record, { create = true } = {}) {
  const projectId = await bindRecordProject(record, {
    threadId: record.boundThreadId,
    documentId: record.boundDocumentId,
    documentName: record.agentSession?.documentName ?? record.boundDocumentName ?? null,
    create,
  });
  const activeSession = record.agentSession;
  if (activeSession && activeSession.projectId !== projectId) {
    activeSession.projectId = projectId;
    const scopes = referenceScopesForSession(activeSession);
    try { activeSession.releaseReferenceScopes?.(); } catch {}
    activeSession.releaseReferenceScopes = referenceStore.retainScopes(scopes);
    await referenceStore.activateScopes(scopes).catch((error) => log(`reference activation failed: ${error?.message ?? error}`));
  }
  await sendProjectBound(record);
  resumeLibrarianFor(projectId);
}

async function reconcileProjectBindings() {
  if (!projectEventsLive) return;
  for (const record of sessions.values()) {
    if (!record.boundProjectId) continue;
    const expected = record.boundDocumentId
      ? projectStore.projectIdForDocument(record.boundDocumentId)
      : (projectStore.hasProject(record.boundProjectId) ? record.boundProjectId : null);
    if (expected !== record.boundProjectId) await rebindRecordProject(record);
  }
}

/** 허브가 멈춘 사이 대기열에 남은 정리 항목을, 그 프로젝트에 채팅이 다시 묶일 때 이어서 돌린다. */
function resumeLibrarianFor(projectId) {
  if (!projectId) return;
  const status = projectLibrarian.status(projectId);
  if (status.queued > 0 || status.running > 0) return;
  void projectStore.itemsNeedingLibrarian(projectId)
    .then((items) => (items.length > 0 ? projectLibrarian.retry(projectId) : null))
    .catch((error) => log(`librarian resume failed: ${error?.message ?? error}`));
}

/** 정리 도우미의 공급자 경로 — 그 프로젝트에 마지막으로 묶인 채팅의 공급자를 먼저 쓴다. */
async function librarianRoutes(projectId) {
  let record = projectRecords.get(projectId);
  if (!record || record.disposed || sessions.get(record.sessionId) !== record) {
    record = [...sessions.values()].find((candidate) => candidate.boundProjectId === projectId && !candidate.disposed) ?? null;
    if (record) projectRecords.set(projectId, record);
    else projectRecords.delete(projectId);
  }
  if (!record) return { readiness: {} };
  const health = providerHealth.cached() ?? await providerHealth.check().catch(() => null);
  const { readiness, resolveCodexTitleModel, resolvePiTitleModel, signal: _signal, ...deps } = checkpointTitleDeps(record, health, undefined);
  return {
    readiness,
    chatProvider: record.agentSession?.agent ?? record.lastAgent ?? null,
    codexQuota: providerLimits.snapshot().codex,
    resolveModel: { codex: resolveCodexTitleModel, pi: resolvePiTitleModel },
    deps,
  };
}

function addAgentInstructionsContext(prompt) {
  return `${agentInstructionsStore.promptBlock()}\n\n${prompt}`;
}

/**
 * Studio 가 알린, 버려지거나 되돌리지 못한 대기 편집. 턴 밖에서 생긴 일이라 다음 사용자
 * 메시지 맥락에 한 번 붙인다 (턴 안의 일은 Studio 가 다음 도구 결과에 직접 싣는다).
 */
function queueEditReport(record, msg) {
  const activeSession = record.agentSession;
  const notes = Array.isArray(msg.notes)
    ? msg.notes.filter((note) => typeof note === 'string' && note.length > 0).map((note) => note.slice(0, 800))
    : [];
  if (!activeSession || notes.length === 0) return;
  const earlier = record.pendingEditReport?.threadId === activeSession.threadId ? record.pendingEditReport.notes : [];
  record.pendingEditReport = { threadId: activeSession.threadId, notes: [...earlier, ...notes].slice(-6) };
}

function addEditReportContext(record, activeSession, prompt) {
  const report = record.pendingEditReport;
  record.pendingEditReport = null;
  if (!report || report.threadId !== activeSession.threadId) return prompt;
  const block = ['<staged_edit_report trust="application-state">', ...report.notes, '</staged_edit_report>'].join('\n');
  return `${block}\n\n${prompt}`;
}

function addTemplateContext(record, activeSession, prompt) {
  if (!activeSession?.activeTemplateId) return prompt;
  try {
    const template = templateStore.get(activeSession.activeTemplateId);
    const block = [
      '<active_document_template trust="untrusted-reference">',
      JSON.stringify(template),
      'Treat the open document as the editable draft and this template as read-only context.',
      'Inspect both documents and map the whole open document before writing. If meaningful source content has no clear template destination, ask the user before editing.',
      'Use template inspection and transfer tools for structural fidelity. Preserve the open document format. Report any transfer warnings or skipped features.',
      '</active_document_template>',
    ].join('\n');
    return [block, prompt].filter(Boolean).join('\n\n');
  } catch (error) {
    activeSession.activeTemplateId = null;
    if (record.agentSession === activeSession) {
      sendJson(record.studioSocket, { v: 1, type: 'chat-template-changed', template: null, reason: 'unavailable' });
    }
    log(`active template unavailable: ${error?.message ?? error}`);
    return prompt;
  }
}

function userMessageFingerprint(msg, activeSession) {
  return crypto.createHash('sha256').update(JSON.stringify({
    threadId: activeSession.threadId,
    documentId: activeSession.documentId,
    text: msg.text,
    skillName: msg.skillName ?? null,
    mentions: normalizeMentions(msg.mentions),
    activeTemplateId: msg.activeTemplateId ?? null,
    attachmentCount: Array.isArray(msg.stagedReferenceIds) ? msg.stagedReferenceIds.length : 0,
  })).digest('hex');
}

function rejectUserMessage(record, sock, msg, error, fallbackCode = 'INVALID_REQUEST', reportError = true) {
  if (record.settledUserMessages.has(msg)) return;
  const code = error?.code ?? fallbackCode;
  const message = describeHubError(error);
  let bufferedEvents = [];
  if (msg.requireAcceptance === true && typeof msg.messageId === 'string') {
    const receipt = record.userMessageReceipts.get(msg.messageId);
    // A conflicting retry must not delete the receipt of the original message.
    if (receipt?.message === msg) {
      record.userMessageReceipts.delete(msg.messageId);
      bufferedEvents = receipt.events ?? [];
    }
    record.settledUserMessages.add(msg);
    sendJson(sock, { v: 1, type: 'chat-user-message-rejected', messageId: msg.messageId, code, message });
  }
  if (reportError) sendChatError(sock, error, fallbackCode);
  for (const event of bufferedEvents) sendAgentEvent(record, event);
}

function rejectPendingUserMessages(record, code, message, { session, turnId, socket } = {}) {
  for (const receipt of [...record.userMessageReceipts.values()]) {
    if (!receipt.message || (session && receipt.session !== session)
      || (turnId && receipt.turnId !== turnId) || (socket && receipt.socket !== socket)) continue;
    rejectUserMessage(record, receipt.socket, receipt.message, workflowError(code, message), code, false);
  }
}

function requireUserMessageAcceptanceCurrent(record, msg) {
  if (msg.requireAcceptance !== true) return;
  const receipt = record.userMessageReceipts.get(msg.messageId);
  if (receipt?.message !== msg || record.studioSocket !== receipt.socket
    || receipt.socket.readyState !== receipt.socket.OPEN) {
    throw workflowError('REQUEST_INVALIDATED', 'The message was cancelled before the provider accepted it');
  }
}

function acceptUserMessage(record, sock, msg) {
  if (msg.requireAcceptance !== true) return;
  const receipt = record.userMessageReceipts.get(msg.messageId);
  if (receipt?.message !== msg) return;
  record.settledUserMessages.add(msg);
  record.userMessageReceipts.set(msg.messageId, { fingerprint: receipt.fingerprint, attachments: receipt.attachments ?? [] });
  while (record.userMessageReceipts.size > MAX_USER_MESSAGE_RECEIPTS) {
    const oldestAccepted = [...record.userMessageReceipts].find(([, entry]) => !entry.message);
    if (!oldestAccepted) break;
    record.userMessageReceipts.delete(oldestAccepted[0]);
  }
  sendJson(receipt.socket ?? sock, { v: 1, type: 'chat-user-message-accepted', messageId: msg.messageId });
  for (const event of receipt.events ?? []) sendAgentEvent(record, event);
}

async function discardRepeatedMessageStages(msg, activeSession) {
  const stageIds = Array.isArray(msg.stagedReferenceIds) ? msg.stagedReferenceIds : [];
  await Promise.allSettled(stageIds.map((stageId) => referenceStore.discardStaged({
    stageId, scopeId: activeSession.threadId,
  })));
}

function dispatchUserMessage(record, sock, msg, activeSession, messageAttachments = [], discussionReady = false) {
  if (activeSession.planning.phase === 'awaiting-approval' && !discussionReady) {
    const planId = activeSession.planning.latestPlan?.planId;
    if (!planId) {
      rejectUserMessage(record, sock, msg, workflowError('PLAN_NOT_FOUND', 'The latest plan is unavailable; return to planning and present it again.'));
      return;
    }
    const hasAttachments = messageAttachments.length > 0
      || (Array.isArray(msg.stagedReferenceIds) && msg.stagedReferenceIds.length > 0);
    if (!hasAttachments && isExplicitImplementationApproval(msg.text)) {
      if (msg.requireAcceptance === true) {
        rejectUserMessage(record, sock, msg, workflowError('PLAN_APPROVAL_REQUIRED', 'Approve the plan before sending this message'));
        return;
      }
      void enqueueWorkflowTransition(record, activeSession, () => approveImplementationPlan(record, sock, { planId, documentRevision: msg.documentRevision }))
        .catch((error) => sendChatError(sock, error));
      return;
    }
    void enqueueWorkflowTransition(
      record,
      activeSession,
      async () => {
        requireWorkflowSwitchBackend(activeSession);
        await activeSession.backend.setExecutionMode(providerModeRequest(activeSession, 'awaiting-approval'));
        if (record.agentSession !== activeSession) {
          throw workflowError('REQUEST_INVALIDATED', 'The chat changed before accepting the message');
        }
        requireUserMessageAcceptanceCurrent(record, msg);
        dispatchUserMessage(record, sock, msg, activeSession, messageAttachments, true);
      },
    )
      .catch((error) => rejectUserMessage(record, sock, msg, error, 'WORKFLOW_ERROR'));
    return;
  }
  if (activeSession.planning.phase === 'switching') {
    rejectUserMessage(record, sock, msg, workflowError('WORKFLOW_SWITCHING', 'The provider is switching into implementation mode.'));
    return;
  }
  beginAgentTurn(record, activeSession);
  const providerTurn = Object.freeze({
    session: activeSession,
    generation: activeSession.generation,
    turnId: activeSession.turnId,
  });
  const receipt = record.userMessageReceipts.get(msg.messageId);
  if (receipt?.message === msg) receipt.turnId = providerTurn.turnId;
  // Studio 가 메시지에 실어 보낸 문서 읽기 — 사용자 요청 바로 앞에 둔다. 승인·수정·허브 생성 턴은 이 경로를 타지 않는다.
  // 모양이 어긋난 스냅샷은 버리고 메시지는 그대로 보낸다.
  const liveDocument = normalizeDocumentSnapshot(msg.documentSnapshot);
  void Promise.resolve()
    .then(() => requireAgentAuthenticated(activeSession.agent))
    .then(() => skillRegistry.promptContext(msg.text, typeof msg.skillName === 'string' ? msg.skillName : undefined, {
      phase: activeSession.planning.snapshot().phase,
      agent: activeSession.agent,
      requestContext: liveDocumentBlock(liveDocument),
    }))
    .then(async (prompt) => {
      // Skill context is loaded asynchronously. An interrupt can settle this
      // turn and a later message can start another turn on the same session
      // before the read completes, so session identity alone is insufficient.
      if (!providerTurnIsCurrent(record, providerTurn)) {
        rejectUserMessage(record, sock, msg, workflowError('REQUEST_INVALIDATED', 'The turn ended before accepting the message'), 'REQUEST_INVALIDATED', false);
        return;
      }
      requireUserMessageAcceptanceCurrent(record, msg);
      if (activeSession.planning.phase === 'awaiting-approval') {
        prompt = `The current plan remains open for review. Answer questions and research normally. If this message requests concrete changes to the plan, revise it directly with present_implementation_plan; do not ask the user to request a draft again. Never treat discussion as approval to edit the document.\n\nCurrent plan:\n${JSON.stringify(activeSession.planning.latestPlan.plan)}\n\n${prompt}`;
      }
      // 프로젝트 요약은 메모·발췌를 읽느라 비동기다 — 기다린 뒤 턴이 여전히 이 턴인지 다시 본다.
      prompt = msg.requireAcceptance === true
        ? await addReferenceContext(activeSession, msg.text, prompt, messageAttachments, normalizeMentions(msg.mentions), { required: true })
        : await addReferenceContext(activeSession, msg.text, prompt, messageAttachments, normalizeMentions(msg.mentions));
      if (!providerTurnIsCurrent(record, providerTurn)) {
        rejectUserMessage(record, sock, msg, workflowError('REQUEST_INVALIDATED', 'The turn ended before accepting the message'), 'REQUEST_INVALIDATED', false);
        return;
      }
      requireUserMessageAcceptanceCurrent(record, msg);
      // 스냅샷도 에이전트가 본 문서 상태다 — 읽기 도구 없이 세운 계획이 승인 때 stale 로 거절되지 않게 한다.
      if (liveDocument) activeSession.lastObservedDocumentRevision = liveDocument.revision;
      const dispatched = activeSession.backend.sendUserMessage(addAgentInstructionsContext(addReopenedChatHistory(
        activeSession,
        addActiveDocumentContext(
          activeSession,
          addTemplateContext(
            record,
            activeSession,
            addEditReportContext(record, activeSession, prompt),
          ),
        ),
      )));
      // Current providers accept synchronously; a future asynchronous backend
      // may reject its dispatch promise before acknowledging the message.
      if (dispatched?.then) await dispatched;
      acceptUserMessage(record, sock, msg);
    })
    .catch((e) => {
      // A stale rejection belongs to the settled turn. It must not idle or
      // report an error against a newer turn on this same backend session.
      if (!providerTurnIsCurrent(record, providerTurn)) {
        rejectUserMessage(record, sock, msg, e, 'AGENT_SPAWN_FAILED', false);
        return;
      }
      failPendingProviderCallsForTurn(record, activeSession, providerTurn.turnId);
      activeSession.status = 'idle';
      activeSession.turnId = null;
      record.userQuestionResponseReceipts.clear();
      rejectUserMessage(record, sock, msg, e, 'AGENT_SPAWN_FAILED');
    });
}

async function requireAgentAuthenticated(agent) {
  if (!CLI_SETUP_AGENTS.includes(agent)) return;
  // An unauthenticated CLI turn used to fail inside the provider with a bare
  // turn-end that rendered as a literal "undefined" in chat — surface the real
  // cause before the provider ever spawns. Status is re-read per message so a
  // login completed mid-session takes effect without a restart.
  const setup = await cliSetup.status(agent).catch(() => null);
  if (setup && setup.authenticated !== true) {
    throw Object.assign(
      new Error(`${agent === 'claude' ? 'Claude' : 'Codex'} 로그인이 필요합니다. 설정 탭에서 로그인한 뒤 다시 시도해 주세요.`),
      { code: 'AGENT_AUTH_REQUIRED' },
    );
  }
}

async function dispatchStagedUserMessage(record, sock, msg, activeSession) {
  const rawIds = Array.isArray(msg.stagedReferenceIds) ? msg.stagedReferenceIds : [];
  const stageIds = [...new Set(rawIds.filter((id) => typeof id === 'string' && id))];
  if (stageIds.length === 0 || stageIds.length !== rawIds.length || stageIds.length > 10) {
    throw Object.assign(new Error('Message attachments require 1-10 unique staged reference ids'), { code: 'INVALID_REFERENCE_MESSAGE' });
  }
  const pendingReferenceMessage = Object.freeze({
    messageId: msg.messageId,
    message: msg,
    owner: activeSession,
  });
  record.pendingReferenceMessage = pendingReferenceMessage;
  sendJson(sock, {
    v: 1,
    type: 'chat-reference-status',
    messageId: msg.messageId,
    attachments: stageIds.map((stageId) => ({ stageId, status: 'processing' })),
  });
  const settled = await Promise.allSettled(
    stageIds.map(async (stageId) => {
      // 첨부는 채팅의 연구 프로젝트 파일로 바로 올린다. 프로젝트가 없으면 채팅 범위에 둔다.
      const projectId = activeSession.projectId;
      const promoted = await referenceStore.promoteStaged({
        stageId,
        scopeId: activeSession.threadId,
        ...(projectId ? { to: { scope: 'project', scopeId: projectId } } : {}),
      });
      if (!projectId) return { stageId, file: promoted, item: null };
      try {
        const origin = recordLabels(record).auto;
        const item = await projectStore.addFileItem(projectId, {
          fileId: promoted.id,
          scope: 'project',
          source: { kind: 'chat-attachment', threadId: activeSession.threadId },
          addedBy: { kind: 'user', threadId: activeSession.threadId },
          ...(origin ? { origin } : {}),
        });
        return { stageId, file: { ...promoted, itemId: item.id }, item };
      } catch (error) {
        // 파일은 프로젝트에 들어갔다 — 항목은 다음 부팅의 복구가 붙인다.
        log(`attachment item creation failed: ${error?.message ?? error}`);
        return { stageId, file: promoted, item: null };
      }
    }),
  );
  const attachments = settled.map((entry, index) => entry.status === 'fulfilled'
    ? { stageId: entry.value.stageId, status: 'ready', file: entry.value.file, ...(entry.value.item ? { item: entry.value.item } : {}) }
    : {
      stageId: stageIds[index],
      status: 'error',
      error: String(entry.reason?.message ?? entry.reason ?? 'Attachment processing failed'),
    });
  sendJson(sock, { v: 1, type: 'chat-reference-status', messageId: msg.messageId, attachments });
  const receipt = record.userMessageReceipts.get(msg.messageId);
  if (receipt?.message === msg) receipt.attachments = attachments;
  const stillCurrent = record.pendingReferenceMessage === pendingReferenceMessage;
  if (stillCurrent) record.pendingReferenceMessage = null;
  const readyFiles = settled.flatMap((entry) => entry.status === 'fulfilled' ? [entry.value.file] : []);
  if (!stillCurrent || record.agentSession !== activeSession) {
    throw workflowError('REQUEST_INVALIDATED', 'The chat changed while message attachments were being prepared');
  }
  requireUserMessageAcceptanceCurrent(record, msg);
  if (msg.requireAcceptance === true && settled.some((entry) => entry.status === 'rejected')) {
    throw workflowError('REFERENCE_COMMIT_FAILED', 'Some message attachments could not be prepared; retry the complete message');
  }
  if (activeSession.status !== 'idle' || activeSession.pendingTransitions > 0) {
    throw workflowError(
      'REQUEST_INVALIDATED',
      'The agent state changed while message attachments were being prepared',
    );
  }
  dispatchUserMessage(record, sock, msg, activeSession, readyFiles);
}

function emitWorkflowState(record, extra = {}) {
  const activeSession = record.agentSession;
  if (!activeSession) return;
  sendJson(record.studioSocket, { v: 1, type: 'workflow-changed', ...activeSession.planning.snapshot(), ...extra });
}

async function startSession(
  record,
  agent,
  requestedModel,
  requestedEffort,
  requestedPermission,
  requestedWorkflow,
  requestedThreadId,
  requestedDocumentId,
  requestedDocumentName,
  requestedHistory,
  force = false,
  requestedServiceTier,
) {
  if (record.processCleanupUncertain === true) throw agentProcessCleanupUncertain();
  await ensureBootWork();
  // A reused terminal login may have been refreshed since the last status read.
  if (agent === 'claude') await cliSetup.refreshAuth('claude').catch(() => {});
  const model = await resolveModel(agent, requestedModel, record);
  const effort = resolveEffort(agent, model, requestedEffort, record);
  const permissionProfile = resolvePermissionProfile(requestedPermission);
  const serviceTier = resolveServiceTier(agent, requestedServiceTier);
  const workflow = resolveWorkflow(requestedWorkflow);
  const { threadId, documentId, documentName } = resolveSessionIdentity({
    threadId: requestedThreadId,
    documentId: requestedDocumentId,
    documentName: requestedDocumentName,
    existing: record.agentSession,
    force,
  });
  const currentSession = record.agentSession;
  if (
    !force
    && currentSession
    && currentSession.agent === agent
    && currentSession.model === model
    && currentSession.effort === effort
    && currentSession.permissionProfile === permissionProfile
    && currentSession.serviceTier === serviceTier
    && currentSession.planning.workflow === workflow
    && currentSession.threadId === threadId
    && currentSession.documentId === documentId
  ) {
    currentSession.documentName = documentName;
    return currentSession;
  }
  // A settings change must never interrupt a turn or its pending question.
  if (!force && currentSession?.status === 'running') {
    throw workflowError('AGENT_BUSY', 'Provider settings can only change between turns.');
  }
  const continuing = !force && currentSession
    && currentSession.threadId === threadId && currentSession.documentId === documentId;
  if (!await disposeSession(record)) throw agentProcessCleanupUncertain();
  // 세션은 문서의 연구 프로젝트(문서가 없으면 스레드 프로젝트)에 묶인다. 이 스레드의 옛 chat 범위
  // 자료는 이제야 문서를 알 수 있어 여기서 프로젝트로 옮긴다.
  const projectId = await bindRecordProject(record, { threadId, documentId, documentName });
  if (projectId) {
    await projectStore.migrateChatReferences(threadId, projectId)
      .catch((error) => log(`chat reference migration failed: ${error?.message ?? error}`));
  }
  record.lastAgent = agent;
  const sessionReferenceScopes = referenceScopesForSession({ threadId, documentId, projectId });
  await referenceStore.activateScopes(sessionReferenceScopes);
  const planning = new PlanningState({
    workflow,
    initialCapabilityEpoch: record.nextCapabilityEpoch++,
    allocateEpoch: () => record.nextCapabilityEpoch++,
  });
  if (continuing && currentSession.planning.workflow === workflow) {
    planning.phase = currentSession.planning.phase;
    planning.latestPlan = currentSession.planning.latestPlan;
    planning.execution = currentSession.planning.execution ? structuredClone(currentSession.planning.execution) : null;
  }
  const generation = ++record.sessionGeneration;
  const providerRole = 'chat';
  const providerCapabilityResource = mcpProviderResource({
    agent,
    role: providerRole,
    generation,
  });
  const opts = {
    rootDir: record.workDir,
    workDir: record.workDir,
    readOnlyRoots: record.hubReadOnlyRoots,
    mcpScriptPath: MCP_SCRIPT,
    hubPort,
    token: sessions.issue(TOKEN, record.sessionId, {
      audience: HUB_CAPABILITY_AUDIENCES.MCP,
      resource: providerCapabilityResource,
    }),
    sessionId: record.sessionId,
    model,
    effort,
    permissionProfile,
    chatPermissionGrants: continuing ? normalizeChatPermissionGrants(currentSession.chatPermissionGrants) : [],
    serviceTier,
    isolatedHome: record.isolatedHome,
    codexHome: record.codexHome,
    codexAuthPath: sourceCodexAuthPath,
    codexBin: cliSetupStatus.codex?.installed ? cliSetup.binPath('codex') : 'codex',
    claudeBin: cliSetupStatus.claude?.installed ? cliSetup.binPath('claude') : 'claude',
    // CLI 는 채팅 시작 뒤에도 설치·갱신될 수 있다. 실제 프로세스를 만들 때 prefix 잠금을 기다린다.
    prepareLaunch: CLI_SETUP_AGENTS.includes(agent) ? async () => {
      const launch = await cliSetup.prepareLaunch(agent);
      return {
        bin: launch.bin ?? agent,
        release: launch.release,
        providerEnv: agent === 'claude' ? claudeRuntimeEnv(record.isolatedHome) : launch.env,
      };
    } : undefined,
    providerEnv: agent === 'claude'
      ? claudeRuntimeEnv(record.isolatedHome)
      : (CLI_SETUP_AGENTS.includes(agent) ? cliSetup.envFor(agent) : {}),
    onEvent: makeBackendEventHandler(record, generation),
    requestUserInput: (request, signal) => requestUserQuestion(record, request, {
      source: 'native',
      generation,
      signal,
    }),
    agentRole: providerRole,
    workflow,
    phase: workflow === 'direct' ? 'implementing' : planning.phase,
    capabilityEpoch: planning.capabilityEpoch,
    // Chat tool profiles follow the current workflow/phase after each provider
    // restart. A fixed toolProfile would keep approved plans read-only.
    piBin: piManager.piBin,
    piRoot: piManager.rootDir,
    openRouterApiKey: agent === 'pi' ? piManager.apiKey() ?? undefined : undefined,
    reasoning: agent === 'pi' ? Boolean(piModelConfig(model)?.reasoning) : false,
    projectToolGates: () => ({ ...projectToolGates(), requestable: true }),
  };
  const createBackend = SESSION_FACTORIES[agent];
  if (!createBackend) throw unknownAgentError(agent);
  const backend = createBackend(opts);
  record.agentSession = {
    agent,
    model,
    effort,
    permissionProfile,
    chatPermissionGrants: opts.chatPermissionGrants,
    serviceTier,
    backend,
    generation,
    providerRole,
    providerCapabilityResource,
    status: 'idle',
    turnId: null,
    providerTurnStarted: false,
    sessionId: backend.getSessionId(),
    threadId,
    documentId,
    documentName,
    projectId,
    // 프롬프트 맥락이 세션의 작업 공간을 찾을 때 쓴다.
    hubSessionId: record.sessionId,
    // Legacy download/browser code uses chatId. It is now the stable Studio
    // thread identity rather than an unrelated hub-generated UUID.
    chatId: threadId,
    activeTemplateId: continuing ? currentSession.activeTemplateId : null,
    lastDocumentInfo: continuing ? currentSession.lastDocumentInfo : null,
    lastObservedDocumentRevision: continuing ? currentSession.lastObservedDocumentRevision : undefined,
    planExecutionTurnId: continuing ? currentSession.planExecutionTurnId : null,
    planExecutionTurnSucceeded: continuing ? currentSession.planExecutionTurnSucceeded : false,
    planReviewTurnId: continuing && currentSession.planning.workflow === workflow ? currentSession.planReviewTurnId : null,
    bootstrapHistory: normalizeChatHistory(requestedHistory),
    planning,
    workflowTransition: Promise.resolve(),
    pendingTransitions: 0,
    releaseReferenceScopes: referenceStore.retainScopes(sessionReferenceScopes),
  };
  try {
    if (workflow === 'plan') {
      requireWorkflowSwitchBackend(record.agentSession);
      await backend.setExecutionMode(providerModeRequest(record.agentSession, planning.phase));
    }
  } catch (error) {
    const cleaned = await disposeSession(record);
    throw cleaned ? error : agentProcessCleanupUncertain(error);
  }
  queueMicrotask(() => drainTemplateCompletion(record));
  queueMicrotask(() => drainPlanningDocumentSaved(record));
  return record.agentSession;
}

function describeHubError(error, fallback = '알 수 없는 오류가 발생했습니다.') {
  // String({code:'X'}) 는 "[object Object]", String(undefined) 는 "undefined"
  // 라서 그대로 보내면 채팅에 깨진 문구가 뜬다.
  if (typeof error?.message === 'string' && error.message) return error.message;
  if (typeof error === 'string' && error) return error;
  return fallback;
}

function sendChatError(sock, error, fallbackCode = 'WORKFLOW_ERROR') {
  sendJson(sock, {
    v: 1,
    type: 'chat-error',
    code: error?.code ?? fallbackCode,
    message: describeHubError(error),
  });
}

/** pi 요청 실패는 채팅 오류가 아니라 설정 카드에 붙는다. 키는 절대 되돌려 보내지 않는다. */
function sendPiError(record, sock, requestId, error, fallbackCode) {
  replyToStudio(record, sock, {
    v: 1,
    type: 'pi-error',
    requestId,
    code: error?.code ?? fallbackCode,
    message: describeHubError(error),
  });
}

function sendBrowserbaseError(record, sock, requestId, error) {
  replyToStudio(record, sock, {
    v: 1,
    type: 'browserbase-error',
    requestId,
    code: error?.code ?? 'BROWSERBASE_CREDENTIALS_REJECTED',
    message: String(error?.message ?? error),
  });
}

/**
 * 스튜디오가 입력한 Browserbase 자격 증명 — 앱이 도는 동안만 환경 변수를 덮고 디스크에는
 * 남기지 않는다. 키가 들어오면 Browserbase API 에 먼저 확인하고, 프로젝트 id 가 비어
 * 있으면 그 계정의 프로젝트를 골라 채운다 (환경 변수의 프로젝트 id 는 다른 계정일 수
 * 있어 섞지 않는다). 턴이 도는 중이면 떠 있는 브라우저는 두고 다음 호출부터 새 키를 쓴다.
 */
async function applyBrowserbaseOverride(record, msg) {
  const revision = record.browserbaseSession.beginCredentialChange();
  const override = normalizeBrowserbaseOverride({
    apiKey: msg.apiKey,
    projectId: msg.projectId,
    geminiApiKey: msg.geminiApiKey,
  });
  if (override?.apiKey) {
    const verified = await validateBrowserbaseCredentials({ apiKey: override.apiKey, projectId: override.projectId ?? null });
    override.projectId = verified.projectId;
  }
  return record.browserbaseSession.applyVerifiedOverride(
    override,
    { restart: record.agentSession?.status !== 'running' },
    revision,
  );
}

function providerModeRequest(activeSession, phase = activeSession.planning.workflow === 'direct' ? 'implementing' : activeSession.planning.phase) {
  return {
    workflow: activeSession.planning.workflow,
    phase,
    capabilityEpoch: activeSession.planning.capabilityEpoch,
    chatPermissionGrants: normalizeChatPermissionGrants(activeSession.chatPermissionGrants),
  };
}

function requireWorkflowSwitchBackend(activeSession) {
  if (typeof activeSession.backend.setExecutionMode !== 'function') {
    throw workflowError(
      'BACKEND_WORKFLOW_UNSUPPORTED',
      'This provider backend does not yet implement setExecutionMode(); update the provider integration before approving or revising plans.',
    );
  }
}

function enqueueWorkflowTransition(record, transitionOwner, transitionFn) {
  transitionOwner.pendingTransitions += 1;
  const transition = transitionOwner.workflowTransition.then(() => {
    if (record.agentSession !== transitionOwner) return undefined;
    return transitionFn();
  });
  const trackedTransition = transition.finally(() => {
    transitionOwner.pendingTransitions = Math.max(0, transitionOwner.pendingTransitions - 1);
    if (transitionOwner.pendingTransitions === 0) {
      queueMicrotask(() => {
        drainTemplateCompletion(record);
        drainPlanningDocumentSaved(record);
      });
    }
  });
  transitionOwner.workflowTransition = trackedTransition.catch(() => undefined);
  return trackedTransition;
}

async function setChatPermission(record, sock, msg) {
  const activeSession = record.agentSession;
  if (!activeSession) throw workflowError('AGENT_NOT_STARTED', 'Start a chat before changing permissions.');
  if (activeSession.status === 'running') {
    throw workflowError('AGENT_BUSY', 'Permissions can only change between turns.');
  }
  const profile = resolvePermissionProfile(msg.permissionProfile);
  await Promise.resolve(activeSession.backend.setPermissionProfile(profile));
  if (record.agentSession !== activeSession) return;
  activeSession.permissionProfile = profile;
  sendJson(sock, { v: 1, type: 'chat-permission-changed', permissionProfile: profile });
}

async function approveImplementationPlan(record, sock, msg) {
  const activeSession = record.agentSession;
  if (!activeSession) throw workflowError('AGENT_NOT_STARTED', 'Start a chat before approving a plan');
  requireWorkflowSwitchBackend(activeSession);
  // 승인 시 고른 실행 권한(에이전트=safe, 전체=unrestricted). 생략하면 현재 프로필을 유지한다.
  const requestedProfile = msg.permissionProfile === undefined || msg.permissionProfile === null
    ? null
    : approvalPermissionProfile(msg.permissionProfile);
  // 승인 검증이 먼저다 — 거절된 승인은 권한을 바꾸지 않는다.
  const transition = activeSession.planning.beginApproval({
    planId: String(msg.planId ?? ''),
    sessionStatus: activeSession.status,
    documentRevision: msg.documentRevision,
  });
  sendJson(sock, { v: 1, type: 'plan-approved', ...activeSession.planning.snapshot() });
  try {
    if (requestedProfile && requestedProfile !== activeSession.permissionProfile) {
      // 실행 모드 전환 전에 권한을 바꿔야 구현 턴이 고른 권한으로 시작한다.
      // 실패하면 아래 catch 가 failSwitch 로 승인 대기로 되돌린다.
      await Promise.resolve(activeSession.backend.setPermissionProfile(requestedProfile));
      if (record.agentSession !== activeSession || activeSession.planning.phase !== 'switching') return;
      activeSession.permissionProfile = requestedProfile;
      sendJson(sock, { v: 1, type: 'chat-permission-changed', permissionProfile: requestedProfile });
    }
    await activeSession.backend.setExecutionMode(providerModeRequest(activeSession, 'implementing'));
    if (record.agentSession !== activeSession || activeSession.planning.phase !== 'switching') return;
    const approvedPrompt = await addReferenceContext(
      activeSession,
      JSON.stringify(transition.approvedPlan.plan),
      buildApprovedPlanPrompt(transition.approvedPlan),
    );
    if (record.agentSession !== activeSession || activeSession.planning.phase !== 'switching') return;
    activeSession.planning.completeSwitch(transition.approvedPlan.planId);
    sendJson(sock, {
      v: 1,
      type: 'implementation-started',
      planId: transition.approvedPlan.planId,
      ...activeSession.planning.snapshot(),
    });
    beginAgentTurn(record, activeSession);
    activeSession.backend.sendUserMessage(addAgentInstructionsContext(addTemplateContext(
      record,
      activeSession,
      addEditReportContext(record, activeSession, approvedPrompt),
    )));
  } catch (error) {
    if (record.agentSession === activeSession) {
      if (activeSession.planning.phase === 'switching') {
        activeSession.planning.failSwitch(transition.approvedPlan.planId);
      } else if (activeSession.planning.phase === 'implementing') {
        activeSession.planning.settleExecution('blocked');
      }
      failPendingProviderCallsForTurn(record, activeSession, activeSession.turnId);
      activeSession.status = 'idle';
      activeSession.turnId = null;
      record.userQuestionResponseReceipts.clear();
      emitWorkflowState(record, { reason: 'provider-switch-failed' });
    }
    sendChatError(sock, error, 'BACKEND_SWITCH_FAILED');
  }
}

async function requestImplementationPlanChanges(record, sock, msg, {
  sessionStatusOverride,
} = {}) {
  const activeSession = record.agentSession;
  if (!activeSession) throw workflowError('AGENT_NOT_STARTED', 'Start a chat before requesting plan changes');
  requireWorkflowSwitchBackend(activeSession);
  const bounded = boundTextFields(msg, PLAN_CHANGE_TEXT_LIMITS, {
    maxTotalChars: 160_000,
    maxTotalBytes: MAX_SEMANTIC_REQUEST_BYTES,
    label: 'Plan-change request',
  });
  const planId = bounded.planId;
  const feedback = bounded.feedback.trim();
  const promptOverride = bounded.promptOverride.trim();
  activeSession.planning.requestChanges({
    planId,
    // Only an already-serialized internal document-saved transition may
    // override this lock. Never trust a Studio frame to claim the provider is
    // idle while its current turn is still running.
    sessionStatus: sessionStatusOverride ?? activeSession.status,
  });
  try {
    await activeSession.backend.setExecutionMode(providerModeRequest(activeSession, 'planning'));
    if (record.agentSession !== activeSession) return;
    sendJson(sock, {
      v: 1,
      type: 'plan-invalidated',
      planId,
      reason: bounded.reason || feedback || 'changes-requested',
      ...activeSession.planning.snapshot(),
    });
    if (promptOverride) {
      const referenced = await addReferenceContext(activeSession, promptOverride, promptOverride);
      if (record.agentSession !== activeSession) return;
      beginAgentTurn(record, activeSession);
      activeSession.backend.sendUserMessage(addAgentInstructionsContext(addTemplateContext(
        record,
        activeSession,
        referenced,
      )));
      return;
    }
    if (feedback) {
      const revisionPrompt = [
        'The user requested changes, so the previous implementation plan is no longer authoritative.',
        'Re-read the affected document state and revise the plan directly from this feedback. Ask a focused question only if a missing answer blocks the revision. Present a complete replacement with present_implementation_plan and a concise changeSummary. The user does not need to ask you to draft it again.',
        `Previous plan: ${JSON.stringify(activeSession.planning.latestPlan.plan)}`,
        `Feedback: ${feedback}`,
      ].join('\n\n');
      const referenced = await addReferenceContext(activeSession, feedback, revisionPrompt);
      if (record.agentSession !== activeSession) return;
      beginAgentTurn(record, activeSession);
      activeSession.backend.sendUserMessage(addAgentInstructionsContext(addTemplateContext(
        record,
        activeSession,
        referenced,
      )));
    }
  } catch (error) {
    if (record.agentSession === activeSession) {
      activeSession.planning.failRequestChanges(planId);
      failPendingProviderCallsForTurn(record, activeSession, activeSession.turnId);
      activeSession.status = 'idle';
      activeSession.turnId = null;
      record.userQuestionResponseReceipts.clear();
      emitWorkflowState(record, { reason: 'provider-switch-failed' });
    }
    sendChatError(sock, error, 'BACKEND_SWITCH_FAILED');
  }
}

async function setChatWorkflow(record, sock, msg) {
  if (msg.workflow !== 'direct' && msg.workflow !== 'plan' && msg.workflow !== 'question') {
    throw workflowError('INVALID_WORKFLOW', `Unknown workflow: ${String(msg.workflow)}`);
  }
  const activeSession = record.agentSession;
  if (!activeSession) {
    sendJson(sock, {
      v: 1,
      type: 'workflow-changed',
      workflow: msg.workflow,
      phase: msg.workflow === 'plan' ? 'planning' : msg.workflow === 'question' ? 'questioning' : 'direct',
      capabilityEpoch: null,
      latestPlan: null,
    });
    return;
  }
  if (activeSession.status !== 'idle') throw workflowError('AGENT_BUSY', 'Workflow can only change while the agent is idle');
  const restartCompletedPlan = msg.workflow === 'plan'
    && activeSession.planning.workflow === 'plan'
    && activeSession.planning.phase === 'implementing';
  if (activeSession.planning.workflow === msg.workflow && !restartCompletedPlan) {
    emitWorkflowState(record);
    return;
  }
  requireWorkflowSwitchBackend(activeSession);
  const previousPlanId = activeSession.planning.latestPlan?.planId ?? null;
  const previousPlanning = activeSession.planning;
  const nextPlanning = new PlanningState({
    workflow: msg.workflow,
    initialCapabilityEpoch: record.nextCapabilityEpoch++,
    allocateEpoch: () => record.nextCapabilityEpoch++,
  });
  const phase = msg.workflow === 'plan'
    ? 'planning'
    : msg.workflow === 'question'
      ? 'questioning'
      : 'implementing';
  // Codex setExecutionMode 는 자식 재시작을 기다리므로, 스냅샷·도구 게이트는
  // 재시작 전에 구상으로 바꿔 둔다. 실패하면 이전 상태로 되돌린다.
  activeSession.planning = nextPlanning;
  settleChatPermissionRequest(record, { status: 'expired', reason: 'workflow-changed' });
  try {
    await activeSession.backend.setExecutionMode({
      workflow: msg.workflow,
      phase,
      capabilityEpoch: nextPlanning.capabilityEpoch,
      chatPermissionGrants: normalizeChatPermissionGrants(activeSession.chatPermissionGrants),
    });
  } catch (error) {
    if (record.agentSession === activeSession) activeSession.planning = previousPlanning;
    throw error;
  }
  if (record.agentSession !== activeSession) return;
  activeSession.planReviewTurnId = null;
  if (msg.workflow === 'direct') {
    const browserbaseCleaned = await record.browserbaseSession.cleanup('workflow changed to direct')
      .catch(() => false);
    if (!browserbaseCleaned) {
      record.processCleanupUncertain = true;
      retainedUncertainBrowserbaseSessions.add(record.browserbaseSession);
      retainUncertainProcessCleanup(record.recordRoot);
      // The workflow switch itself already succeeded. Report the cleanup
      // failure separately while still publishing the authoritative new mode.
      sendChatError(sock, agentProcessCleanupUncertain(), 'AGENT_PROCESS_CLEANUP_UNCERTAIN');
    }
  }
  if (previousPlanId) {
    sendJson(sock, {
      v: 1,
      type: 'plan-invalidated',
      planId: previousPlanId,
      reason: 'workflow-changed',
      ...nextPlanning.snapshot(),
    });
  }
  emitWorkflowState(record);
}

async function handleStudioMessage(record, sock, msg) {
  switch (msg.type) {
    case 'reference-stage-bind': {
      // 첨부 초안은 이전 채팅의 provider 가 살아 있어도 만들 수 있다. 이 묶기는
      // staging HTTP 만 허용하며 provider 의 자료 읽기 범위·프로젝트를 바꾸지 않는다.
      const requestId = typeof msg.requestId === 'string' ? msg.requestId : null;
      if (!requestId) return;
      try {
        const threadId = normalizeStableScopeId(msg.threadId, 'threadId');
        record.referenceStagingThreadId = threadId;
        sendJson(sock, { v: 1, type: 'reference-stage-bound', requestId, threadId });
      } catch (error) {
        sendJson(sock, { v: 1, type: 'reference-stage-bound', requestId, threadId: null });
      }
      return;
    }
    case 'chat-start': {
      if (record.agentSession?.workflowTransition) {
        await record.agentSession.workflowTransition;
      }
      const requestId = typeof msg.requestId === 'string' ? msg.requestId : null;
      const rejectStart = (error, fallbackCode = 'INVALID_REQUEST') => sendJson(sock, {
        v: 1, type: 'chat-error', requestId, session: sessionInfo(record),
        code: error?.code ?? fallbackCode, message: describeHubError(error),
      });
      const agent = msg.agent;
      if (!KNOWN_AGENTS.has(agent)) {
        rejectStart(new Error(`unknown agent: ${String(agent)}`));
        return;
      }
      // 설정이 끝나지 않은 pi 로는 세션을 열지 않는다 — 살아 있는 세션도 건드리지 않는다.
      if (agent === 'pi' && !piStatus.setupComplete) {
        sendJson(sock, {
          v: 1, type: 'chat-error', requestId, session: sessionInfo(record), code: 'PI_NOT_CONFIGURED',
          message: 'Pi 설정을 먼저 끝내 주세요 (설치 · OpenRouter 키 · 모델 선택).',
        });
        return;
      }
      const previousRepository = record.projectRepository ?? null;
      try {
        // 버전 저장소가 있는 문서는 모든 작업 공간이 한 프로젝트를 함께 쓴다.
        const repositoryChanged = applyRecordRepository(record, msg.documentId, msg);
        const reusable = record.agentSession;
        const s = await startSession(
          record,
          agent,
          msg.model,
          msg.effort,
          msg.permissionProfile,
          msg.workflow,
          msg.threadId,
          msg.documentId,
          msg.documentName,
          msg.history,
          Boolean(msg.force),
          msg.serviceTier,
        );
        // 같은 세션을 그대로 쓰면 묶기를 건너뛴다 — 작업 공간이 바뀌었으면 여기서 다시 묶는다.
        if (repositoryChanged && s === reusable) await rebindRecordProject(record);
        sendJson(sock, {
          v: 1,
          type: 'chat-started',
          requestId,
          agent: s.agent,
          model: s.model,
          effort: s.effort,
          permissionProfile: s.permissionProfile,
          serviceTier: s.serviceTier,
          sessionId: s.sessionId,
          status: s.status,
          turnId: s.turnId,
          threadId: s.threadId,
          documentId: s.documentId,
          documentName: s.documentName,
          projectId: s.projectId ?? null,
          pendingChatPermissionRequest: pendingChatPermissionSnapshot(record),
          chatPermissionGrants: normalizeChatPermissionGrants(s.chatPermissionGrants),
          ...s.planning.snapshot(),
        });
        await sendProjectBound(record);
        resumeLibrarianFor(record.boundProjectId);
      } catch (e) {
        // 시작하지 못한 채팅의 작업 공간은 지금 세션의 표시에 쓰지 않는다.
        if (!record.agentSession || record.agentSession.documentId !== msg.documentId) record.projectRepository = previousRepository;
        rejectStart(e, 'AGENT_SPAWN_FAILED');
      }
      return;
    }
    case 'project-bind': {
      // 허브가 다시 떠 세션이 비었거나 작업 공간이 바뀌었을 때 Studio 가 보낸다. 다음 메시지를
      // 기다리지 않고 프로젝트를 다시 묶어 프로젝트 칸의 HTTP 호출이 바로 통하게 한다.
      // 이미 있는 프로젝트에만 묶는다 — 새 프로젝트는 첫 채팅이 만든다.
      const activeSession = record.agentSession;
      const identity = activeSession
        ? { threadId: activeSession.threadId, documentId: activeSession.documentId ?? null, documentName: activeSession.documentName ?? null }
        : {
          threadId: typeof msg.threadId === 'string' && msg.threadId ? msg.threadId : null,
          documentId: typeof msg.documentId === 'string' && msg.documentId ? msg.documentId : null,
          documentName: typeof msg.documentName === 'string' ? msg.documentName : null,
        };
      if (!identity.threadId && !identity.documentId) return;
      if (msg.documentId === identity.documentId) applyRecordRepository(record, identity.documentId, msg);
      const previous = record.boundProjectId ?? null;
      const projectId = await bindRecordProject(record, { ...identity, create: false });
      if (!projectId && previous && activeSession) {
        // 묶여 있던 세션은 프로젝트를 잃지 않는다.
        record.boundProjectId = previous;
        return;
      }
      if (activeSession && activeSession.projectId !== projectId && projectId) {
        activeSession.projectId = projectId;
        const scopes = referenceScopesForSession(activeSession);
        try { activeSession.releaseReferenceScopes?.(); } catch {}
        activeSession.releaseReferenceScopes = referenceStore.retainScopes(scopes);
        await referenceStore.activateScopes(scopes).catch((error) => log(`reference activation failed: ${error?.message ?? error}`));
      } else if (!activeSession && projectId) {
        await referenceStore.activateScopes(referenceScopesForSession({ ...identity, projectId }))
          .catch((error) => log(`reference activation failed: ${error?.message ?? error}`));
      }
      await sendProjectBound(record);
      resumeLibrarianFor(projectId);
      return;
    }
    case 'title-request': {
      const requestId = typeof msg.requestId === 'string' ? msg.requestId : null;
      const threadId = typeof msg.threadId === 'string' ? msg.threadId : null;
      if (!requestId || !threadId) {
        sendJson(sock, {
          v: 1, type: 'chat-error', code: 'INVALID_REQUEST',
          message: 'title-request requires requestId and threadId',
        });
        return;
      }
      const preview = typeof msg.preview === 'string' ? msg.preview : '';
      void Promise.resolve().then(async () => {
        const deps = auxDeps(record, msg.agent, 'codex');
        if (!deps.useOpenRouter) {
          deps.model = await resolveModel('codex', 'luna', record).catch(() => null);
          if (!deps.model) return null;
        }
        return generateChatTitle(preview, deps);
      })
        .then((title) => {
          sendJson(sock, {
            v: 1,
            type: 'title-result',
            requestId,
            threadId,
            title: title ?? null,
          });
        })
        .catch((e) => {
          log(`title-request failed: ${e?.message ?? e}`);
          sendJson(sock, {
            v: 1,
            type: 'title-result',
            requestId,
            threadId,
            title: null,
          });
        });
      return;
    }
    case 'checkpoint-title-request': {
      const requestId = typeof msg.requestId === 'string' ? msg.requestId : null;
      if (!requestId) return;
      const startedAt = Date.now();
      const controller = new AbortController();
      record.checkpointTitleControllers.add(controller);
      const input = {
        commitId: msg.commitId,
        titleRevision: msg.titleRevision,
        appLanguage: msg.appLanguage,
        summary: msg.summary,
      };
      const cachedHealth = providerHealth.cached();
      void (cachedHealth ? Promise.resolve(cachedHealth) : providerHealth.check())
        .then((health) => {
          const remainingMs = Math.max(
            1,
            CHECKPOINT_TITLE_OVERALL_TIMEOUT_MS - (Date.now() - startedAt),
          );
          return generateCheckpointTitle(input, {
            ...checkpointTitleDeps(record, health, controller.signal),
            overallTimeoutMs: remainingMs,
          });
        })
        .then((result) => replyToStudio(record, sock, {
          v: 1,
          type: 'checkpoint-title-result',
          requestId,
          result,
        }))
        .catch((error) => {
          log(`checkpoint-title-request failed: ${error?.message ?? error}`);
          replyToStudio(record, sock, {
            v: 1,
            type: 'checkpoint-title-result',
            requestId,
            result: null,
          });
        })
        .finally(() => record.checkpointTitleControllers.delete(controller));
      return;
    }
    case 'chat-user-message': {
      if (!record.agentSession) {
        rejectUserMessage(record, sock, msg, workflowError('AGENT_NOT_STARTED', 'No agent session; send chat-start first.'));
        return;
      }
      try {
        assertMessageScope(record.agentSession, msg);
        if (msg.requireAcceptance === true) {
          if (typeof msg.messageId !== 'string' || !msg.messageId || msg.messageId.length > 128
            || /[\u0000-\u001f\u007f]/.test(msg.messageId)
            || !Object.prototype.hasOwnProperty.call(msg, 'threadId')
            || !Object.prototype.hasOwnProperty.call(msg, 'documentId')) {
            throw workflowError('INVALID_REQUEST', 'Accepted message receipts require messageId, threadId and documentId');
          }
          if (msg.stagedReferenceIds !== undefined && (!Array.isArray(msg.stagedReferenceIds)
            || msg.stagedReferenceIds.length > 10
            || msg.stagedReferenceIds.some((id) => typeof id !== 'string' || !id)
            || new Set(msg.stagedReferenceIds).size !== msg.stagedReferenceIds.length)) {
            throw workflowError('INVALID_REFERENCE_MESSAGE', 'Message attachments require up to 10 unique staged reference ids');
          }
          const receipt = record.userMessageReceipts.get(msg.messageId);
          if (receipt) {
            if (receipt.fingerprint !== userMessageFingerprint(msg, record.agentSession)) {
              throw workflowError('MESSAGE_ID_CONFLICT', 'messageId belongs to a different message or document context');
            }
            if (!receipt.message) {
              await discardRepeatedMessageStages(msg, record.agentSession);
              if (receipt.attachments?.length) {
                sendJson(sock, {
                  v: 1, type: 'chat-reference-status', messageId: msg.messageId,
                  attachments: receipt.attachments.map((attachment, index) => ({
                    ...attachment, stageId: msg.stagedReferenceIds[index],
                  })),
                });
              }
              sendJson(sock, { v: 1, type: 'chat-user-message-accepted', messageId: msg.messageId });
            } else if (receipt.socket !== sock) {
              rejectUserMessage(record, receipt.socket, receipt.message, workflowError('REQUEST_INVALIDATED', 'Studio reconnected before accepting the message'), 'REQUEST_INVALIDATED', false);
              throw workflowError('REQUEST_INVALIDATED', 'Retry the message after reconnecting Studio');
            }
            return;
          }
        }
      } catch (error) {
        rejectUserMessage(record, sock, msg, error);
        return;
      }
      if (record.agentSession.pendingTransitions > 0) {
        rejectUserMessage(record, sock, msg, workflowError('WORKFLOW_SWITCHING', 'The provider is applying a workflow or permission change.'));
        return;
      }
      if (record.agentSession.status === 'running' || record.pendingReferenceMessage) {
        rejectUserMessage(record, sock, msg, workflowError('AGENT_BUSY', 'A turn is already in progress.'));
        return;
      }
      if (typeof msg.text !== 'string' || msg.text.length === 0) {
        rejectUserMessage(record, sock, msg, workflowError('INVALID_REQUEST', 'chat-user-message requires text'));
        return;
      }
      if (msg.text.length > MAX_CHAT_MESSAGE_CHARS) {
        rejectUserMessage(record, sock, msg, workflowError('INVALID_REQUEST', `chat message exceeds ${MAX_CHAT_MESSAGE_CHARS} characters`));
        return;
      }
      if (msg.requireAcceptance === true) {
        record.userMessageReceipts.set(msg.messageId, {
          fingerprint: userMessageFingerprint(msg, record.agentSession),
          message: msg, socket: sock, session: record.agentSession, turnId: null,
        });
      }
      if (Object.prototype.hasOwnProperty.call(msg, 'activeTemplateId')) {
        try {
          const templateId = msg.activeTemplateId == null ? null : String(msg.activeTemplateId);
          if (templateId) templateStore.get(templateId);
          record.agentSession.activeTemplateId = templateId;
        } catch (error) {
          record.agentSession.activeTemplateId = null;
          sendJson(sock, { v: 1, type: 'chat-template-changed', template: null, reason: 'unavailable' });
          log(`message template unavailable: ${error?.message ?? error}`);
          if (msg.requireAcceptance === true) {
            rejectUserMessage(record, sock, msg, error, 'TEMPLATE_NOT_FOUND');
            return;
          }
        }
      }
      if (Array.isArray(msg.stagedReferenceIds) && msg.stagedReferenceIds.length > 0) {
        if (typeof msg.messageId !== 'string' || !msg.messageId) {
          rejectUserMessage(record, sock, msg, workflowError('INVALID_REFERENCE_MESSAGE', 'Attachment messages require messageId'));
          return;
        }
        void dispatchStagedUserMessage(record, sock, msg, record.agentSession)
          .catch((error) => {
            if (record.pendingReferenceMessage?.messageId === msg.messageId) record.pendingReferenceMessage = null;
            rejectUserMessage(record, sock, msg, error, 'REFERENCE_COMMIT_FAILED');
          });
        return;
      }
      dispatchUserMessage(record, sock, msg, record.agentSession);
      return;
    }
    case 'chat-template-set': {
      const activeSession = record.agentSession;
      if (!activeSession) {
        sendJson(sock, { v: 1, type: 'chat-error', code: 'AGENT_NOT_STARTED', message: 'Start a chat before selecting a template.' });
        return;
      }
      if (activeSession.status === 'running') {
        sendJson(sock, { v: 1, type: 'chat-error', code: 'AGENT_BUSY', message: 'Templates can only change between turns.' });
        return;
      }
      try {
        const templateId = msg.templateId == null ? null : String(msg.templateId);
        const template = templateId ? templateStore.get(templateId) : null;
        activeSession.activeTemplateId = templateId;
        sendJson(sock, { v: 1, type: 'chat-template-changed', template });
      } catch (error) {
        sendChatError(sock, error, 'TEMPLATE_NOT_FOUND');
      }
      return;
    }
    case 'templates-list': {
      sendJson(sock, { v: 1, type: 'templates-catalog', ...templateStore.list() });
      return;
    }
    case 'agent-instructions-request': {
      sendJson(sock, {
        v: 1,
        type: 'agent-instructions',
        requestId: msg.requestId ?? null,
        status: agentInstructionsStore.snapshot(),
        changedBy: 'system',
      });
      sendInstructionDraft(record, sock);
      return;
    }
    case 'agent-instructions-save': {
      void agentInstructionsStore.update(msg.content, {
        expectedRevision: Number(msg.expectedRevision),
      }).then((status) => {
        sendJson(sock, {
          v: 1,
          type: 'agent-instructions',
          requestId: msg.requestId ?? null,
          status,
          changedBy: 'user',
        });
        broadcastAgentInstructions(status, 'user');
      }).catch((error) => sendJson(sock, {
        v: 1,
        type: 'agent-instructions-error',
        requestId: msg.requestId ?? null,
        code: error?.code ?? 'INSTRUCTIONS_SAVE_FAILED',
        message: String(error?.message ?? error),
        status: agentInstructionsStore.snapshot(),
      }));
      return;
    }
    case 'agent-instructions-draft-confirm': {
      let draft;
      try {
        draft = consumeAuthorizedInstructionDraft(record, msg);
        // Consume the one-use capability before the asynchronous write.
      } catch (error) {
        sendJson(sock, {
          v: 1,
          type: 'agent-instructions-error',
          requestId: msg.requestId ?? null,
          code: error?.code ?? 'INSTRUCTIONS_CONFIRMATION_INVALID',
          message: String(error?.message ?? error),
          status: agentInstructionsStore.snapshot(),
        });
        return;
      }
      void agentInstructionsStore.update(draft.content, {
        expectedRevision: draft.expectedRevision,
      }).then((status) => {
        sendJson(sock, {
          v: 1,
          type: 'agent-instructions',
          requestId: msg.requestId ?? null,
          status,
          changedBy: `agent-confirmed:${draft.requestedBy}`,
        });
        sendJson(sock, {
          v: 1,
          type: 'agent-instructions-draft-cleared',
          draftId: draft.id,
          outcome: 'confirmed',
        });
        broadcastAgentInstructions(status, `agent-confirmed:${draft.requestedBy}`);
      }).catch((error) => {
        sendJson(sock, {
          v: 1,
          type: 'agent-instructions-draft-cleared',
          draftId: draft.id,
          outcome: 'stale',
        });
        sendJson(sock, {
          v: 1,
          type: 'agent-instructions-error',
          requestId: msg.requestId ?? null,
          code: error?.code ?? 'INSTRUCTIONS_SAVE_FAILED',
          message: String(error?.message ?? error),
          status: agentInstructionsStore.snapshot(),
        });
      });
      return;
    }
    case 'agent-instructions-draft-reject': {
      let draft;
      try {
        draft = consumeAuthorizedInstructionDraft(record, msg);
      } catch (error) {
        sendJson(sock, {
          v: 1,
          type: 'agent-instructions-error',
          requestId: msg.requestId ?? null,
          code: error?.code ?? 'INSTRUCTIONS_CONFIRMATION_INVALID',
          message: String(error?.message ?? error),
          status: agentInstructionsStore.snapshot(),
        });
        return;
      }
      sendJson(sock, {
        v: 1,
        type: 'agent-instructions-draft-cleared',
        requestId: msg.requestId ?? null,
        draftId: draft.id,
        outcome: 'rejected',
      });
      return;
    }
    case 'chat-permission-set': {
      const transitionOwner = record.agentSession;
      if (!transitionOwner) {
        sendJson(sock, { v: 1, type: 'chat-error', code: 'AGENT_NOT_STARTED', message: 'Start a chat before changing permissions.' });
        return;
      }
      void enqueueWorkflowTransition(record, transitionOwner, () => setChatPermission(record, sock, msg))
        .catch((e) => sendJson(sock, {
          v: 1,
          type: 'chat-error',
          code: e?.code === 'AGENT_BUSY' ? 'AGENT_BUSY' : 'PERMISSION_CHANGE_FAILED',
          message: String(e?.message ?? e),
        }));
      return;
    }
    case 'chat-permission-response': {
      const activeSession = record.agentSession;
      if (!activeSession) {
        void answerChatPermission(record, sock, msg);
        return;
      }
      void enqueueWorkflowTransition(record, activeSession, () => answerChatPermission(record, sock, msg));
      return;
    }
    case 'chat-service-tier-set': {
      if (!record.agentSession) {
        sendJson(sock, { v: 1, type: 'chat-error', code: 'AGENT_NOT_STARTED', message: 'Start a chat before changing the service tier.' });
        return;
      }
      if (record.agentSession.status === 'running') {
        sendJson(sock, { v: 1, type: 'chat-error', code: 'AGENT_BUSY', message: 'Service tier can only change between turns.' });
        return;
      }
      const tier = resolveServiceTier(record.agentSession.agent, msg.serviceTier);
      try {
        record.agentSession.backend.setServiceTier?.(tier);
        record.agentSession.serviceTier = tier;
        sendJson(sock, { v: 1, type: 'chat-service-tier-changed', serviceTier: tier });
      } catch (e) {
        sendJson(sock, { v: 1, type: 'chat-error', code: 'SERVICE_TIER_CHANGE_FAILED', message: String(e?.message ?? e) });
      }
      return;
    }
    case 'chat-workflow-set': {
      const transitionOwner = record.agentSession;
      if (!transitionOwner) {
        try {
          await setChatWorkflow(record, sock, msg);
        } catch (error) {
          sendChatError(sock, error);
        }
        return;
      }
      const transition = enqueueWorkflowTransition(record, transitionOwner, () => setChatWorkflow(record, sock, msg));
      // studioMessageQueue 가 이 전환을 기다리지 않으면 Codex 재시작 중에
      // chat-user-message 가 바로 실행 모드 턴으로 들어가 문서를 잠근다.
      try {
        await transition;
      } catch (error) {
        sendChatError(sock, error);
      }
      return;
    }
    case 'chat-plan-approve':
    case 'implementation-plan-approve':
    case 'plan-approve': {
      const transitionOwner = record.agentSession;
      if (!transitionOwner) {
        void approveImplementationPlan(record, sock, msg).catch((error) => sendChatError(sock, error));
        return;
      }
      void enqueueWorkflowTransition(record, transitionOwner, () => approveImplementationPlan(record, sock, msg))
        .catch((error) => sendChatError(sock, error));
      return;
    }
    case 'chat-plan-request-changes':
    case 'implementation-plan-request-changes':
    case 'plan-request-changes': {
      const transitionOwner = record.agentSession;
      if (!transitionOwner) {
        void requestImplementationPlanChanges(record, sock, msg).catch((error) => sendChatError(sock, error));
        return;
      }
      void enqueueWorkflowTransition(record, transitionOwner, () => requestImplementationPlanChanges(record, sock, msg))
        .catch((error) => sendChatError(sock, error));
      return;
    }
    case 'chat-document-saved': {
      queuePlanningDocumentSaved(record, msg);
      return;
    }
    case 'chat-edit-report': {
      queueEditReport(record, msg);
      return;
    }
    case 'chat-plan-execution-result': {
      const activeSession = record.agentSession;
      try {
        const rejectsPendingReview = msg.status === 'blocked'
          && typeof msg.turnId === 'string' && msg.turnId === activeSession?.planReviewTurnId;
        if (!activeSession || activeSession.planning.phase !== 'implementing'
          || typeof msg.turnId !== 'string'
          || (!rejectsPendingReview && (msg.turnId !== activeSession.planExecutionTurnId
            || (activeSession.status !== 'idle' && activeSession.planning.execution?.status !== 'completed')))) {
          throw workflowError('STALE_PLAN_EXECUTION', 'The execution result does not match the settled plan turn');
        }
        activeSession.planning.assertLatest(msg.planId);
        if (['completed', 'awaiting-review'].includes(msg.status) && !activeSession.planExecutionTurnSucceeded) {
          throw workflowError('PLAN_EXECUTION_FAILED', 'An unsuccessful provider turn cannot complete the plan');
        }
        activeSession.planning.acknowledgeExecution(msg.status);
        activeSession.planReviewTurnId = msg.status === 'awaiting-review' ? msg.turnId : null;
        sendJson(sock, { v: 1, type: 'plan-progress', ...activeSession.planning.snapshot() });
      } catch (error) {
        sendChatError(sock, error);
      }
      return;
    }
    case 'skills-list': {
      void skillRegistry.catalog()
        .then((catalog) => sendJson(sock, { v: 1, type: 'skills-catalog', requestId: msg.requestId ?? null, catalog }))
        .catch((e) => sendJson(sock, { v: 1, type: 'skills-error', requestId: msg.requestId ?? null, code: e?.code ?? 'SKILLS_ERROR', message: String(e?.message ?? e) }));
      return;
    }
    case 'harness-list': {
      void skillRegistry.harness()
        .then((rows) => sendJson(sock, { v: 1, type: 'harness-list-result', requestId: msg.requestId ?? null, rows }))
        .catch((e) => sendJson(sock, { v: 1, type: 'skills-error', requestId: msg.requestId ?? null, code: e?.code ?? 'SKILLS_ERROR', message: String(e?.message ?? e) }));
      return;
    }
    case 'skill-commit': {
      let change;
      try {
        change = skillRegistry.parseChange(msg.change);
      } catch (error) {
        sendJson(sock, { v: 1, type: 'skills-error', requestId: msg.requestId ?? null, code: error?.code ?? 'INVALID_REQUEST', message: String(error?.message ?? error) });
        return;
      }
      void skillRegistry.commit(change)
        .then((outcome) => sendJson(sock, {
          v: 1,
          type: 'skill-commit-result',
          requestId: msg.requestId ?? null,
          outcome: publishedSkillOutcome(outcome),
        }))
        .catch((e) => sendJson(sock, { v: 1, type: 'skills-error', requestId: msg.requestId ?? null, code: e?.code ?? 'SKILLS_ERROR', message: String(e?.message ?? e) }));
      return;
    }
    case 'artifact-descriptor-request': {
      const requestId = typeof msg.requestId === 'string' ? msg.requestId : null;
      const threadId = typeof msg.threadId === 'string' ? msg.threadId : '';
      void freshArtifactDescriptor(record, msg.artifactId, threadId)
        .then((artifact) => replyToStudio(record, sock, { v: 1, type: 'artifact-descriptor', requestId, artifact }))
        .catch((error) => replyToStudio(record, sock, {
          v: 1,
          type: 'artifact-descriptor',
          requestId,
          error: {
            code: error?.code === 'ARTIFACT_NOT_FOUND' ? 'ARTIFACT_NOT_FOUND' : 'ARTIFACT_UNAVAILABLE',
            message: String(error?.message ?? error),
          },
        }));
      return;
    }
    case 'skill-editor-read': {
      void skillRegistry.readEditor(String(msg.name ?? ''))
        .then((document) => sendJson(sock, { v: 1, type: 'skill-editor-read-result', requestId: msg.requestId ?? null, document }))
        .catch((e) => sendJson(sock, { v: 1, type: 'skills-error', requestId: msg.requestId ?? null, code: e?.code ?? 'SKILLS_ERROR', message: String(e?.message ?? e) }));
      return;
    }
    case 'skill-editor-save': {
      void skillRegistry.saveEditor(String(msg.name ?? ''), String(msg.body ?? ''), String(msg.base ?? ''))
        .then((outcome) => sendJson(sock, { v: 1, type: 'skill-editor-save-result', requestId: msg.requestId ?? null, outcome: publishedSkillOutcome(outcome) }))
        .catch((e) => sendJson(sock, { v: 1, type: 'skills-error', requestId: msg.requestId ?? null, code: e?.code ?? 'SKILLS_ERROR', message: String(e?.message ?? e) }));
      return;
    }
    case 'provider-status-request': {
      const requestId = typeof msg.requestId === 'string' ? msg.requestId : null;
      void providerHealth.check(msg.refresh === true)
        .then((providers) => replyToStudio(record, sock, { v: 1, type: 'provider-status', requestId, providers }))
        .catch((e) => replyToStudio(record, sock, {
          v: 1, type: 'provider-error', requestId,
          code: 'PROVIDER_PROBE_FAILED', message: String(e?.message ?? e),
        }));
      return;
    }
    case 'agent-setup-status-request': {
      const requestId = typeof msg.requestId === 'string' ? msg.requestId : null;
      void agentSetupStatuses(record.sessionId, msg.refresh === true)
        .then((statuses) => replyToStudio(record, sock, { v: 1, type: 'agent-setup-status', requestId, statuses }))
        .catch((e) => sendAgentSetupError(record, sock, requestId, null, e));
      return;
    }
    case 'agent-setup-install': {
      const requestId = typeof msg.requestId === 'string' ? msg.requestId : null;
      const agent = msg.agent;
      if (!KNOWN_AGENTS.has(agent)) {
        sendAgentSetupError(record, sock, requestId, null, new Error('지원하지 않는 에이전트예요.'));
        return;
      }
      const progress = (entry) => replyToStudio(record, sock, {
        v: 1,
        type: 'agent-setup-progress',
        requestId,
        agent,
        state: entry.state,
        ...(entry.phase ? { phase: entry.phase } : {}),
        ...(Number.isFinite(entry.percent) ? { percent: entry.percent } : {}),
        ...(entry.detail ? { detail: entry.detail } : {}),
        ...(entry.activity === true ? { activity: true } : {}),
        ...(Number.isFinite(entry.receivedBytes) ? { receivedBytes: entry.receivedBytes } : {}),
        ...(Number.isFinite(entry.totalBytes) ? { totalBytes: entry.totalBytes } : {}),
      });
      const installing = agent === 'pi'
        ? mutateSharedNpmPrefix(() => piManager.install(progress)).then(async (status) => {
          piStatus = status;
        })
        : cliSetup.install(agent, progress).then((status) => { cliSetupStatus[agent] = status; });
      // 설치 중이라는 사실과 결과는 모든 Studio 에 알린다. 요청한 탭이 재접속해도 설치 상태를 잃지 않는다.
      void agentSetupStatuses().then(broadcastAgentSetupStatuses).catch(() => {});
      void installing
        // 새 바이너리를 감지한 뒤 상태를 만들어야 완료 프레임의 available/connected 가 맞다.
        .then(() => providerHealth.check(true))
        .then(async (providers) => {
          broadcastToStudios({ v: 1, type: 'provider-status', providers });
          const statuses = await agentSetupStatuses();
          replyToStudio(record, sock, { v: 1, type: 'agent-setup-status', requestId, statuses: withAuthRunStatus(statuses, record.sessionId) });
          broadcastAgentSetupStatuses(statuses);
        })
        .catch((e) => {
          sendAgentSetupError(record, sock, requestId, agent, e, 'AGENT_INSTALL_FAILED');
          void agentSetupStatuses().then(broadcastAgentSetupStatuses).catch(() => {});
        });
      return;
    }
    case 'agent-setup-auth': {
      const requestId = typeof msg.requestId === 'string' ? msg.requestId : null;
      const agent = msg.agent;
      const method = msg.method;
      if (!KNOWN_AGENTS.has(agent) || (method !== 'oauth' && method !== 'api-key')) {
        sendAgentSetupError(record, sock, requestId, null, new Error('로그인 요청을 확인하지 못했어요.'));
        return;
      }
      const abort = new AbortController();
      let authRun;
      let credentialsCommitted = false;
      const cancelProvider = () => {
        abort.abort();
        if (agent === 'pi') void piManager.cancelSetup();
        else if (CLI_SETUP_AGENTS.includes(agent)) void cliSetup.cancel(agent);
      };
      // 같은 세션이 다시 로그인을 시작하면 남아 있던 이전 시도를 취소하고 처음부터 시작한다.
      const previousRun = authRuns.get(agent);
      if (previousRun?.ownerSessionId === record.sessionId) {
        authRuns.cancelOwned({ agent, runId: previousRun.runId, ownerSessionId: record.sessionId, reason: 'restarted' });
      }
      try {
        authRun = authRuns.begin({
          agent,
          ownerSessionId: record.sessionId,
          requestId,
          method,
          cancel: cancelProvider,
        });
      } catch (error) {
        sendAgentSetupError(record, sock, requestId, agent, error, 'AGENT_AUTH_FAILED');
        return;
      }

      const isLiveAuthRun = () => !abort.signal.aborted && authRuns.get(agent) === authRun;
      const commitAuthRun = () => {
        if (credentialsCommitted) return;
        if (!isLiveAuthRun() || !authRuns.finish(authRun)) throw agentAuthCancelled();
        credentialsCommitted = true;
        authRun.credentialsCommitted = true;
      };
      // Pi completes in the loopback HTTP callback, outside this WS handler stack.
      // Keep only the exact originating run's cancellation and commit capabilities.
      authRun.signal = abort.signal;
      authRun.commitCredentials = commitAuthRun;

      const progress = (entry) => {
        if (!isLiveAuthRun()) return;
        if (entry.terminalData !== undefined || entry.terminalReady) {
          sendAuthRunFrame(authRun, { type: 'agent-setup-terminal',
            ...(entry.terminalData !== undefined ? { data: entry.terminalData } : {}),
            ...(entry.terminalReady ? { ready: true } : {}),
          });
          return;
        }
        const replayableUi = {
          ...(entry.authUrl ? { authUrl: entry.authUrl } : {}),
          ...(entry.userCode ? { userCode: entry.userCode } : {}),
        };
        authRuns.update(authRun, { phase: entry.state ?? entry.phase ?? 'authorizing', replayableUi });
        sendAuthRunFrame(authRun, {
          type: 'agent-setup-progress',
          state: entry.state ?? 'authorizing',
          ...(entry.phase ? { phase: entry.phase } : {}),
          ...(entry.authUrl ? { authUrl: entry.authUrl } : {}),
          ...(entry.userCode ? { userCode: entry.userCode } : {}),
          ...(Number.isFinite(entry.percent) ? { percent: entry.percent } : {}),
          ...(entry.detail ? { detail: entry.detail } : {}),
          ...(entry.activity === true ? { activity: true } : {}),
        });
      };
      const started = (details = {}) => {
        if (!isLiveAuthRun()) return;
        authRuns.update(authRun, { phase: 'authorizing', replayableUi: details });
        replyToStudio(record, sock, {
          v: 1,
          type: 'agent-setup-auth-started',
          requestId,
          authRunId: authRun.runId,
          agent,
          ...details,
        });
      };
      const finish = async (error = null) => {
        authRuns.finish(authRun);
        if (error && credentialsCommitted) {
          log(`post-auth ${agent} refresh failed: ${error?.message ?? error}`);
        } else if (error && error?.code !== 'AGENT_AUTH_CANCELLED') {
          sendAuthRunError(authRun, error);
        }
        await broadcastFreshAgentSetupStatuses().catch((statusError) => {
          log(`agent setup status refresh failed: ${statusError?.message ?? statusError}`);
        });
      };

      let run;
      if (agent === 'pi' && method === 'oauth') {
        try {
          const callbackUrl = `http://127.0.0.1:${hubPort}/oauth/openrouter/callback`;
          const authUrl = piManager.beginOAuth(callbackUrl).authUrl;
          started({ authUrl });
          progress({ state: 'authorizing', authUrl });
        } catch (error) {
          void finish(error);
        }
        return;
      }
      started();
      if (agent === 'pi') {
        run = piManager.setApiKey(msg.key, {
          signal: abort.signal,
          onCommitted: commitAuthRun,
        })
          .then((status) => { piStatus = status; });
      } else {
        run = cliSetup.authenticate(agent, method, msg.key, progress, {
          terminal: msg.terminal === true,
          signal: abort.signal,
          onCommitted: commitAuthRun,
        })
          .then(async (status) => {
            await ensureBootWork();
            cliSetupStatus[agent] = status;
            if (agent === 'codex') sourceCodexAuthPath = findSourceCodexAuthPath();
            refreshSessionCredentials(agent);
            if (agent === 'claude' || agent === 'codex') {
              providerLimits.invalidate();
              broadcastToStudios({ v: 1, type: 'usage-report', usage: usageSnapshot() });
              void providerLimits.refresh(true).then(() => {
                broadcastToStudios({ v: 1, type: 'usage-report', usage: usageSnapshot() });
              }).catch(() => log('provider usage refresh after sign-in failed'));
            }
          });
      }
      void run.then(async () => {
        if (agent === 'pi') sendAuthRunFrame(authRun, { type: 'pi-status', status: piStatus });
        const providers = await providerHealth.check(true);
        sendAuthRunFrame(authRun, { type: 'provider-status', providers });
      }).then(() => finish(), finish);
      return;
    }
    case 'agent-setup-terminal-resume':
    case 'agent-setup-terminal-input':
    case 'agent-setup-terminal-resize': {
      try {
        const run = authRuns.requireOwned({ agent: msg.agent, runId: msg.authRunId,
          ownerSessionId: record.sessionId });
        if (!CLI_SETUP_AGENTS.includes(msg.agent) || run.method !== 'oauth') throw new Error('진행 중인 CLI 로그인이 없어요.');
        if (msg.type === 'agent-setup-terminal-resume') {
          const data = cliSetup.terminalSnapshot(msg.agent);
          if (data !== null) sendAuthRunFrame(run, { type: 'agent-setup-terminal', data, ready: true, reset: true });
        } else if (msg.type === 'agent-setup-terminal-input') {
          if (typeof msg.data !== 'string' || Buffer.byteLength(msg.data) > 4096) throw new Error('입력 크기를 확인해 주세요.');
          cliSetup.terminalInput(msg.agent, msg.data);
        } else {
          if (!Number.isInteger(msg.cols) || !Number.isInteger(msg.rows)) throw new Error('터미널 크기를 확인해 주세요.');
          cliSetup.terminalResize(msg.agent, msg.cols, msg.rows);
        }
      } catch (error) {
        sendAgentSetupError(record, sock, null, msg.agent, error, 'AGENT_AUTH_FAILED');
      }
      return;
    }
    case 'agent-setup-auth-code': {
      const agent = msg.agent;
      let authRun;
      let code;
      try {
        authRun = authRuns.requireOwned({
          agent,
          runId: msg.authRunId,
          ownerSessionId: record.sessionId,
        });
        code = boundedAgentAuthCode(msg.code);
      } catch (error) {
        sendAgentSetupError(record, sock, null, agent, error, 'AGENT_AUTH_FAILED');
        return;
      }
      if (agent !== 'claude' && agent !== 'codex') {
        sendAgentSetupError(record, sock, null, agent, new Error('인증 코드 요청을 확인하지 못했어요.'));
        return;
      }
      void cliSetup.submitAuthCode(agent, code)
        .catch((e) => sendAgentSetupError(record, sock, null, agent, e, 'AGENT_AUTH_FAILED'));
      return;
    }
    case 'agent-setup-cancel': {
      const agent = msg.agent;
      try {
        authRuns.cancelOwned({
          agent,
          runId: msg.authRunId,
          ownerSessionId: record.sessionId,
        });
        void broadcastFreshAgentSetupStatuses();
      } catch (error) {
        // 이미 끝난 실행을 겨냥한 취소(재연결 뒤 늦게 도착한 취소 등)는 목적을 이미 이룬 것이다.
        if (authRuns.get(agent)?.runId !== msg.authRunId) return;
        sendAgentSetupError(record, sock, null, agent, error, 'AGENT_AUTH_FAILED');
      }
      return;
    }
    case 'agent-setup-disconnect': {
      const requestId = typeof msg.requestId === 'string' ? msg.requestId : null;
      if (msg.agent !== 'claude') {
        sendAgentSetupError(record, sock, requestId, msg.agent, new Error('Provider disconnect is not supported.'));
        return;
      }
      const run = authRuns.get('claude');
      if (run) authRuns.cancelOwned({ agent: 'claude', runId: run.runId, ownerSessionId: run.ownerSessionId, reason: 'disconnected' });
      void cliSetup.disconnect('claude')
        .then(async () => {
          providerLimits.invalidate();
          const statuses = await agentSetupStatuses(record.sessionId);
          replyToStudio(record, sock, { v: 1, type: 'agent-setup-status', requestId, statuses });
          await broadcastFreshAgentSetupStatuses();
        })
        .catch((e) => sendAgentSetupError(record, sock, requestId, 'claude', e, 'AGENT_AUTH_FAILED'));
      return;
    }
    case 'usage-request': {
      const requestId = typeof msg.requestId === 'string' ? msg.requestId : null;
      void usageSnapshotRefreshing(msg.refresh === true)
        .then((usage) => replyToStudio(record, sock, { v: 1, type: 'usage-report', requestId, usage }))
        .catch((e) => replyToStudio(record, sock, {
          v: 1, type: 'usage-error', requestId,
          code: e?.code ?? 'USAGE_FETCH_FAILED', message: String(e?.message ?? e),
        }));
      return;
    }
    case 'codex-reset-consume': {
      const requestId = typeof msg.requestId === 'string' ? msg.requestId : null;
      void providerLimits.consumeCodexReset({
        idempotencyKey: msg.idempotencyKey, accountKey: msg.accountKey,
      }).then(({ outcome }) => {
        const usage = usageSnapshot();
        replyToStudio(record, sock, { v: 1, type: 'codex-reset-result', requestId, outcome, usage });
        broadcastToStudios({ v: 1, type: 'usage-report', usage });
      }).catch((error) => replyToStudio(record, sock, {
        v: 1, type: 'codex-reset-error', requestId,
        code: error?.code ?? 'CODEX_RESET_FAILED',
        message: error?.message ?? '초기화에 실패했어요.',
      }));
      return;
    }
    case 'usage-plan-set': {
      const requestId = typeof msg.requestId === 'string' ? msg.requestId : null;
      void Promise.resolve()
        .then(() => usageStore.setPlan(msg.agent, msg.plan))
        .then(() => usageSnapshotRefreshing(false))
        .then((usage) => replyToStudio(record, sock, { v: 1, type: 'usage-report', requestId, usage }))
        .catch((e) => replyToStudio(record, sock, {
          v: 1, type: 'usage-error', requestId,
          code: e?.code ?? 'INVALID_PLAN', message: String(e?.message ?? e),
        }));
      return;
    }
    case 'browserbase-status-request': {
      const requestId = typeof msg.requestId === 'string' ? msg.requestId : null;
      replyToStudio(record, sock, { v: 1, type: 'browserbase-status', requestId, status: record.browserbaseSession.status() });
      return;
    }
    case 'browserbase-credentials-set': {
      const requestId = typeof msg.requestId === 'string' ? msg.requestId : null;
      void applyBrowserbaseOverride(record, msg)
        .then((status) => replyToStudio(record, sock, { v: 1, type: 'browserbase-status', requestId, status }))
        .catch((e) => sendBrowserbaseError(record, sock, requestId, e));
      return;
    }
    case 'browserbase-credentials-clear': {
      const requestId = typeof msg.requestId === 'string' ? msg.requestId : null;
      record.browserbaseSession.beginCredentialChange();
      void record.browserbaseSession.setOverride(null, { restart: record.agentSession?.status !== 'running' })
        .then((status) => replyToStudio(record, sock, { v: 1, type: 'browserbase-status', requestId, status }))
        .catch((e) => sendBrowserbaseError(record, sock, requestId, e));
      return;
    }
    case 'pi-status-request': {
      const requestId = typeof msg.requestId === 'string' ? msg.requestId : null;
      void refreshPiStatus()
        .then((status) => replyToStudio(record, sock, { v: 1, type: 'pi-status', requestId, status }))
        .catch((e) => sendPiError(record, sock, requestId, e, 'PI_STATUS_FAILED'));
      return;
    }
    case 'pi-install': {
      const requestId = typeof msg.requestId === 'string' ? msg.requestId : null;
      void mutateSharedNpmPrefix(() => piManager.install((progress) => replyToStudio(record, sock, {
        v: 1,
        type: 'pi-setup-progress',
        requestId,
        state: progress.state,
        ...(Number.isFinite(progress.percent) ? { percent: progress.percent } : {}),
        ...(progress.detail ? { detail: progress.detail } : {}),
        ...(Number.isFinite(progress.receivedBytes) ? { receivedBytes: progress.receivedBytes } : {}),
        ...(Number.isFinite(progress.totalBytes) ? { totalBytes: progress.totalBytes } : {}),
        ...(progress.activity === true ? { activity: true } : {}),
      })))
        .then((status) => {
          piStatus = status;
          replyToStudio(record, sock, { v: 1, type: 'pi-status', requestId, status });
          // 설치 직후 프로바이더 목록에 pi 가 나타나야 한다.
          void providerHealth.check(true)
            .then((providers) => replyToStudio(record, sock, { v: 1, type: 'provider-status', providers }))
            .catch(() => {});
        })
        .catch((e) => sendPiError(record, sock, requestId, e, 'PI_INSTALL_FAILED'));
      return;
    }
    case 'pi-set-key': {
      const requestId = typeof msg.requestId === 'string' ? msg.requestId : null;
      void piManager.setApiKey(msg.key)
        .then(async (status) => {
          piStatus = status;
          replyToStudio(record, sock, { v: 1, type: 'pi-status', requestId, status });
          await refreshOpenRouterCredits(true);
          replyToStudio(record, sock, { v: 1, type: 'usage-report', usage: usageSnapshot() });
        })
        .catch((e) => sendPiError(record, sock, requestId, e, 'OPENROUTER_KEY_INVALID'));
      return;
    }
    case 'pi-catalog-request': {
      const requestId = typeof msg.requestId === 'string' ? msg.requestId : null;
      void piManager.catalog(msg.refresh === true)
        .then((models) => replyToStudio(record, sock, { v: 1, type: 'pi-catalog', requestId, models }))
        .catch((e) => sendPiError(record, sock, requestId, e, 'OPENROUTER_UNREACHABLE'));
      return;
    }
    case 'model-catalog-request': {
      const requestId = typeof msg.requestId === 'string' ? msg.requestId : null;
      const agent = msg.agent;
      void modelCatalog(agent, record, { refresh: msg.refresh === true })
        .then((models) => replyToStudio(record, sock, {
          v: 1, type: 'model-catalog', requestId, agent, models,
        }))
        .catch((error) => replyToStudio(record, sock, {
          v: 1, type: 'model-catalog-error', requestId, agent,
          code: error?.code ?? 'MODEL_CATALOG_FAILED', message: String(error?.message ?? error),
        }));
      return;
    }
    case 'pi-set-models': {
      const requestId = typeof msg.requestId === 'string' ? msg.requestId : null;
      void piManager.setModels(Array.isArray(msg.models) ? msg.models : [])
        .then((status) => {
          piStatus = status;
          replyToStudio(record, sock, { v: 1, type: 'pi-status', requestId, status });
        })
        .catch((e) => sendPiError(record, sock, requestId, e, 'PI_MODELS_INVALID'));
      return;
    }
    case 'writing-style-status-request': {
      void writingStyleStore.status()
        .then((status) => sendJson(sock, { v: 1, type: 'writing-style-status', requestId: msg.requestId ?? null, status }))
        .catch((e) => sendJson(sock, { v: 1, type: 'writing-style-error', requestId: msg.requestId ?? null, code: 'STYLE_STATUS_FAILED', message: String(e?.message ?? e) }));
      return;
    }
    case 'writing-style-catalog-request': {
      const requestId = msg.requestId ?? null;
      const refresh = msg.refresh === true;
      void Promise.all([
        providerHealth.check(refresh),
        refresh ? refreshPiStatus() : Promise.resolve(piStatus),
      ])
        .then(() => sendJson(sock, {
          v: 1, type: 'writing-style-catalog', requestId, ...writingStyleCatalog(record),
        }))
        .catch((e) => sendJson(sock, {
          v: 1, type: 'writing-style-error', requestId,
          code: e?.code ?? 'STYLE_CATALOG_FAILED', message: String(e?.message ?? e),
        }));
      return;
    }
    case 'writing-style-calibrate': {
      const requestId = msg.requestId ?? null;
      if (record.styleCalibration || writingStyleCalibrationOwner !== null) {
        sendJson(sock, { v: 1, type: 'writing-style-error', requestId, code: 'CALIBRATION_BUSY', message: 'A writing-style calibration is already running.' });
        return;
      }
      let selection;
      try {
        selection = resolveWritingStyleSelection(
          { agent: msg.agent, model: msg.model, effort: msg.effort },
          {
            health: providerHealth.cached(),
            piStatus,
            codexModels: record.modelCatalogs?.codex,
            claudeModels: record.modelCatalogs?.claude,
            currentSelection: record.agentSession ? { agent: record.agentSession.agent, model: record.agentSession.model, effort: record.agentSession.effort } : null,
          },
        );
      } catch (e) {
        sendJson(sock, {
          v: 1, type: 'writing-style-error', requestId,
          code: e?.code ?? 'INVALID_CALIBRATION_SELECTION', message: String(e?.message ?? e),
        });
        return;
      }
      const jobId = crypto.randomUUID();
      writingStyleCalibrationOwner = record;
      record.styleCalibration = {
        requestId, jobId, startedAt: new Date().toISOString(),
        agent: selection.agent, model: selection.model, progress: null,
      };
      sendStyleProgress(record, {
        state: 'preparing', phase: 'preparing', activity: 'collecting-samples',
        detail: msg.append === true ? 'Combining saved and new writing samples' : 'Preparing writing samples',
        completed: 0, total: 1,
      });
      let calibrationSources = null;
      void Promise.resolve()
        .then(async () => {
          if (msg.append === true) {
            const current = await writingStyleStore.status();
            assertWritingStyleAppendCompatible(current, {
              language: msg.language,
              baseRevision: typeof msg.baseRevision === 'string' ? msg.baseRevision : null,
            });
          }
          calibrationSources = await writingStyleStore.calibrationSources(msg.files, { append: msg.append === true });
          if (Array.isArray(msg.files)) msg.files.length = 0;
          return calibrateWritingStyle(
            {
              language: msg.language,
              files: calibrationSources,
              agent: selection.agent,
              model: await resolveModel(selection.agent, selection.model, record),
              effort: selection.effort,
            },
            {
              useOpenRouter: selection.agent === 'pi',
              piManager,
              openRouter,
              projectRoot: ROOT,
              workDir: record.workDir,
              isolatedHome: record.isolatedHome,
              sessionId: record.sessionId,
              providerEnvs: { claude: claudeRuntimeEnv(record.isolatedHome) },
              spawnProcess: (command, args, options) => auxSpawnProcess(record, command, args, options),
              terminateProcess: terminateProcessTree,
              cleanupProcessOutcome: (child) => beginAuxiliaryProcessCleanupOutcome(record, child),
              onProgress: (event) => {
                if (record.styleCalibration?.jobId === jobId) sendStyleProgress(record, event);
              },
            },
          );
        })
        .then(async (profile) => {
          if (record.styleCalibration?.jobId === jobId) sendStyleProgress(record, {
            state: 'saving', phase: 'saving', activity: 'saving-profile',
            detail: 'Saving the profile and its source samples', completed: 0, total: 1,
          });
          const status = await writingStyleStore.save(profile, { sources: calibrationSources });
          if (record.styleCalibration?.jobId === jobId) sendStyleProgress(record, {
            state: 'saving', phase: 'saving', activity: 'saving-profile',
            detail: 'Saved the calibrated writing profile', completed: 1, total: 1,
          });
          sendJson(record.studioSocket, { v: 1, type: 'writing-style-result', requestId, jobId, status });
          sendJson(record.studioSocket, { v: 1, type: 'writing-style-status', requestId, status });
        })
        .catch((e) => sendJson(record.studioSocket, {
          v: 1,
          type: 'writing-style-error',
          requestId,
          jobId,
          code: e?.code ?? 'CALIBRATION_FAILED',
          message: String(e?.message ?? e),
        }))
        .finally(() => {
          if (record.styleCalibration?.jobId === jobId) record.styleCalibration = null;
          if (writingStyleCalibrationOwner === record) writingStyleCalibrationOwner = null;
        });
      return;
    }
    case 'writing-style-instruction-set': {
      const requestId = msg.requestId ?? null;
      void writingStyleStore.setAdditionalInstruction(msg.instruction)
        .then((status) => sendJson(record.studioSocket, {
          v: 1, type: 'writing-style-status', requestId, status,
        }))
        .catch((e) => sendJson(record.studioSocket, {
          v: 1,
          type: 'writing-style-error',
          requestId,
          code: 'STYLE_INSTRUCTION_FAILED',
          message: String(e?.message ?? e),
        }));
      return;
    }
    case 'chat-interrupt': {
      record.pendingReferenceMessage = null;
      rejectPendingUserMessages(record, 'REQUEST_INVALIDATED', 'The message was cancelled before acceptance');
      if (record.agentSession) {
        const interruptedSession = record.agentSession;
        const interruptedTurnId = interruptedSession.turnId;
        settleUserQuestion(record, { status: 'cancelled', reason: 'user-stop' });
        settleChatPermissionRequest(record, { status: 'expired', reason: 'user-stop' });
        failPendingProviderCallsForTurn(
          record,
          interruptedSession,
          interruptedTurnId,
        );
        retireProviderSockets(record, interruptedSession, { turnId: interruptedTurnId });
        try {
          interruptedSession.backend.interrupt();
        } catch (e) {
          log(`interrupt error: ${e?.message ?? e}`);
        }
        interruptedSession.status = 'idle';
        interruptedSession.turnId = null;
        interruptedSession.providerTurnStarted = false;
        if (interruptedSession.planning.phase === 'implementing' && interruptedSession.planning.execution?.status !== 'completed') {
          interruptedSession.planExecutionTurnSucceeded = false;
          interruptedSession.planning.settleExecution('interrupted');
          sendJson(sock, { v: 1, type: 'plan-progress', ...interruptedSession.planning.snapshot() });
        }
        record.userQuestionResponseReceipts.clear();
      }
      return;
    }
    case 'chat-stop': {
      settleUserQuestion(record, { status: 'cancelled', reason: 'user-stop' });
      settleChatPermissionRequest(record, { status: 'expired', reason: 'user-stop' });
      cancelCheckpointTitleJobs(record);
      if (!await disposeSession(record)) {
        sendChatError(sock, agentProcessCleanupUncertain(), 'AGENT_PROCESS_CLEANUP_UNCERTAIN');
      }
      return;
    }
    case 'user-question-answer': {
      answerUserQuestion(record, sock, msg);
      return;
    }
    case 'tool-response': {
      const entry = record.pendingCalls.get(msg.id);
      if (!entry) {
        log(`tool-response for unknown id ${msg.id}`);
        return;
      }
      record.pendingCalls.delete(msg.id);
      clearTimeout(entry.timer);
      if (entry.trace && msg.hubTrace) {
        Object.assign(entry.trace, {
          hubRespIn: msg.hubTrace.respIn,
          hubRespDeq: msg.hubTrace.respDeq,
          respBytes: msg.hubTrace.respBytes,
          studio: sanitizeTraceFields(msg.trace),
        });
      }
      const releaseSnapshotClaim = () => {
        if (entry.tool !== 'materialize_document_snapshot' || !entry.copyLayoutJobId) return;
        const job = record.templateJobs.get(entry.copyLayoutJobId);
        releaseCopyLayoutSnapshot(job);
      };
      const assertProviderTurn = () => {
        if (entry.providerTurn && !providerTurnIsActive(record, entry.providerTurn)) {
          throw noActiveProviderTurnError();
        }
      };
      let unboundMaterialization = null;
      try {
        assertProviderTurn();
        if (entry.mcpSocket.readyState !== entry.mcpSocket.OPEN) return;
        if (msg.ok) {
          try {
            let result;
            if (entry.tool === 'get_document_info') {
              result = attachActiveDocumentIdentity(msg.result, entry.documentIdentity);
            } else if (entry.tool === 'materialize_document_snapshot') {
              const snapshotJob = entry.copyLayoutJobId
                ? record.templateJobs.get(entry.copyLayoutJobId)
                : null;
              if (entry.copyLayoutJobId && (!snapshotJob || snapshotJob.status !== 'running')) {
                throw workflowError('COPY_LAYOUT_JOB_SETTLED', 'The copy-layout job settled before its snapshot was bound');
              }
              if (snapshotJob && (
                msg.result?.digest !== snapshotJob.binding.digest
                || msg.result?.sourceFormat !== snapshotJob.binding.sourceFormat
              )) {
                throw workflowError('COPY_LAYOUT_SOURCE_MISMATCH', 'Studio returned snapshot bytes for a different document revision or format');
              }
              const materialization = record.documentSnapshotManager.materialize({
                chatId: entry.chatId,
                documentIdentity: entry.documentIdentity,
                snapshot: msg.result,
              });
              if (snapshotJob) snapshotJob.snapshotPromise = materialization;
              try {
                result = await materialization;
                // Until this exact turn receives the path (or the owning
                // copy-layout job binds it), the allocation is provisional.
                // Turn settlement can happen while fsync is in flight.
                unboundMaterialization = result;
              } finally {
                if (snapshotJob?.snapshotPromise === materialization) snapshotJob.snapshotPromise = null;
              }
            } else if (entry.renderSavePath) {
              const saved = await writeRenderPng({
                workDir: record.workDir,
                target: entry.renderSavePath,
                data: msg.result?.image?.data,
              });
              result = { ...msg.result, ...saved };
            } else {
              result = msg.result;
            }
            assertProviderTurn();
            if (!entry.copyLayoutJobId && record.agentSession?.generation === entry.sessionGeneration
              && toolDefinitionsByName.get(entry.tool)?.category === 'document-read'
              && Number.isSafeInteger(result?.revision)) {
              record.agentSession.lastObservedDocumentRevision = result.revision;
            }
            if (entry.tool === 'get_document_info' && !entry.copyLayoutJobId
              && record.agentSession?.generation === entry.sessionGeneration) {
              record.agentSession.lastDocumentInfo = Object.freeze({
                documentId: result.documentId,
                digest: result.digest,
                sourceFormat: result.sourceFormat,
                dirty: result.dirty === true,
                sourcePath: result.sourcePath ?? null,
              });
            }
            if (entry.tool === 'materialize_document_snapshot' && entry.copyLayoutJobId) {
              const workerJob = record.templateJobs.get(entry.copyLayoutJobId);
              if (!workerJob || workerJob.status !== 'running') {
                throw workflowError('COPY_LAYOUT_JOB_SETTLED', 'The copy-layout job settled before its snapshot was bound');
              }
              if (result.documentId !== workerJob.binding.documentId
                || result.digest !== workerJob.binding.digest
                || result.sourceFormat !== workerJob.binding.sourceFormat) {
                throw workflowError('COPY_LAYOUT_SOURCE_MISMATCH', 'The immutable snapshot no longer matches the delegated document binding');
              }
              if (workerJob.snapshot) {
                if (workerJob.snapshot.checksum !== result.checksum
                  || workerJob.snapshot.digest !== result.digest
                  || workerJob.snapshot.path !== result.path) {
                  throw workflowError('COPY_LAYOUT_SNAPSHOT_ALREADY_BOUND', 'This job is already bound to a different immutable snapshot');
                }
              } else {
                workerJob.snapshot = Object.freeze({ ...result });
                unboundMaterialization = null;
              }
            }
            const delivered = typeof entry.sendResult === 'function'
              ? entry.sendResult(result)
              : sendJson(entry.mcpSocket, { v: 1, type: 'tool-result', id: entry.clientId, ok: true, result });
            if (delivered && !entry.copyLayoutJobId) unboundMaterialization = null;
          } catch (error) {
            if (typeof entry.sendError === 'function') entry.sendError(error, 'SNAPSHOT_WRITE_FAILED');
            else {
              sendJson(entry.mcpSocket, {
                v: 1, type: 'tool-result', id: entry.clientId, ok: false,
                error: {
                  code: error?.code ?? 'SNAPSHOT_WRITE_FAILED',
                  message: String(error?.message ?? error),
                },
              });
            }
          }
        } else {
          const error = msg.error ?? { code: 'RPC_ERROR', message: 'unknown studio error' };
          if (typeof entry.sendError === 'function') entry.sendError(error, 'RPC_ERROR');
          else {
            sendJson(entry.mcpSocket, {
              v: 1, type: 'tool-result', id: entry.clientId, ok: false,
              error,
            });
          }
        }
      } catch (error) {
        if (typeof entry.sendError === 'function') entry.sendError(error);
      } finally {
        if (unboundMaterialization) {
          try {
            await record.documentSnapshotManager.discard(unboundMaterialization);
          } catch (error) {
            log(`undelivered document snapshot cleanup failed: ${error?.message ?? error}`);
          }
        }
        releaseSnapshotClaim();
      }
      return;
    }
    default:
      log(`ignoring unknown studio message type: ${String(msg.type)}`);
  }
}

let toolTraceSeq = 0;

function handleMcpMessage(record, sock, msg, traceIn = 0, frameBytes = 0) {
  switch (msg.type) {
    case 'tool-trace': {
      // mcp-stdio 가 결과를 CLI 에 돌려준 뒤 보내는 자기 구간 타이밍. 추적이 켜진 허브만 받는다.
      if (!TOOL_TRACE_ENABLED) return;
      writeToolTrace({ kind: 'mcp', agent: sock.agentLabel ?? null, ...sanitizeTraceFields(msg.trace) });
      return;
    }
    case 'tool-call': {
      const clientId = msg.id;
      if (!Number.isSafeInteger(clientId) || clientId < 0) {
        sendJson(sock, {
          v: 1,
          type: 'protocol-error',
          code: 'INVALID_CALL_ID',
          message: 'tool-call id must be a non-negative safe integer',
        });
        try { sock.close(1002, 'invalid tool-call id'); } catch {}
        return;
      }
      const tool = String(msg.tool ?? '');
      const definition = toolDefinitionsByName.get(tool);
      const workerJob = workerJobForSocket(record, sock);
      const piSubagent = sock.piSubagentId
        ? record.piSubagents.get(sock.piSubagentId)
        : null;
      let providerTurn = null;
      let callSettled = false;
      const telemetryCall = startToolCall(tool, msg.args);
      // 추적 행 — 허브 구간(수신→스튜디오 전달→응답 수신→큐 통과→MCP 로 전송)과 스튜디오 구간.
      const trace = TOOL_TRACE_ENABLED ? {
        kind: 'hub',
        seq: ++toolTraceSeq,
        tool,
        agent: sock.agentLabel ?? null,
        clientId,
        turnId: sock.agentTurnId ?? null,
        parentTaskId: sock.parentTaskId ?? msg.parentTaskId ?? null,
        callBytes: frameBytes,
        hubIn: traceIn,
      } : null;
      const sendTraced = (frame) => {
        if (!trace) return sendJson(sock, frame);
        const delivered = sendJson(sock, { ...frame, trace: { seq: trace.seq } });
        trace.hubOut = traceNow();
        trace.ok = frame.ok === true;
        if (!frame.ok) trace.error = frame.error?.code ?? null;
        writeToolTrace(trace);
        return delivered;
      };
      const sendError = (error, fallback = 'TOOL_ERROR') => {
        if (callSettled) return false;
        const terminalQuestionOutcome = tool === 'ask_user_question'
          && (error?.code === 'USER_QUESTION_CANCELLED' || error?.code === 'USER_QUESTION_EXPIRED');
        const reported = providerTurn && !providerTurnIsActive(record, providerTurn)
          && !terminalQuestionOutcome
          ? noActiveProviderTurnError()
          : error;
        callSettled = true;
        telemetryCall.finish(toolTelemetryForTurn(record, providerTurn), {
          errorCode: reported?.code ?? fallback,
          errorMessage: String(reported?.message ?? reported),
        });
        return sendTraced({
          v: 1,
          type: 'tool-result',
          id: clientId,
          ok: false,
          error: {
            code: reported?.code ?? fallback,
            message: String(reported?.message ?? reported),
          },
        });
      };
      const sendResult = (result) => {
        if (callSettled) return false;
        if (providerTurn && (!providerTurnIsActive(record, providerTurn)
          || (sock.piSubagentId && !currentPiSubagentForSocket(record, sock)))) {
          return sendError(noActiveProviderTurnError());
        }
        const resultFrame = { v: PROTOCOL_VERSION, type: 'tool-result', id: clientId, ok: true, result };
        let frame;
        try {
          frame = JSON.stringify(trace ? { ...resultFrame, trace: { seq: trace.seq } } : resultFrame);
        } catch (error) {
          return sendError(error, 'RPC_ERROR');
        }
        // 클라이언트 maxPayload 를 넘는 프레임은 소켓을 1009 로 끊어 형제 호출까지 취소시킨다.
        const frameLimit = sock.maxResultFrameBytes;
        const frameBytes = frameLimit ? Buffer.byteLength(frame, 'utf8') : 0;
        if (frameLimit && frameBytes > frameLimit) {
          const mib = (bytes) => (bytes / (1024 * 1024)).toFixed(1);
          sendError(workflowError(
            'RESULT_TOO_LARGE',
            `${tool} completed but its result is ${mib(frameBytes)} MB, over this client's ${mib(frameLimit)} MB limit; lower scale, crop with regionMm, or read a narrower range`,
          ));
          return false;
        }
        callSettled = true;
        telemetryCall.finish(toolTelemetryForTurn(record, providerTurn), { result });
        const delivered = sendRaw(sock, frame);
        if (trace) {
          trace.hubOut = traceNow();
          trace.ok = true;
          writeToolTrace(trace);
        }
        return delivered;
      };
      if (!workerJob) {
        const activeSession = record.agentSession;
        const childIdentityCurrent = piSubagent
          && record.piSubagents.isCurrent(piSubagent, activeSession)
          && sock.agentGeneration === piSubagent.providerGeneration
          && sock.agentLabel === piSubagent.agent
          && sock.agentRole === piSubagent.agentRole;
        const rootIdentityCurrent = !sock.piSubagentId
          && activeSession
          && sock.agentGeneration === activeSession.generation
          && sock.agentLabel === activeSession.agent
          && sock.agentRole === activeSession.providerRole;
        if (!activeSession || (!childIdentityCurrent && !rootIdentityCurrent)) {
          sendError(workflowError(
            'PROVIDER_SESSION_STALE',
            'This MCP connection no longer belongs to the active provider session',
          ));
          try { sock.close(4001, 'provider session replaced'); } catch {}
          return;
        }
        if (activeSession.status !== 'running'
          || !activeSession.turnId
          || activeSession.providerTurnStarted !== true
          || sock.providerTurnRetired === true
          || sock.agentTurnId !== activeSession.turnId) {
          sendError(noActiveProviderTurnError());
          try { sock.close(4003, 'provider tool call outside active turn'); } catch {}
          return;
        }
        providerTurn = Object.freeze({
          session: activeSession,
          generation: activeSession.generation,
          turnId: activeSession.turnId,
        });
      }
      if (!definition) {
        sendError(workflowError('UNKNOWN_TOOL', `Unknown tool: ${tool}`));
        return;
      }
      if (piSubagent && !piSubagent.allowedTools.has(tool)) {
        sendError(workflowError(
          'PI_SUBAGENT_TOOL_DENIED',
          `This Pi subagent role cannot call ${tool}`,
        ));
        return;
      }
      let args;
      try {
        args = toolArgSchema(tool, definition).parse(msg.args ?? {});
        definition.validate?.(args);
        if ((tool === 'present_implementation_plan' || tool === 'update_todos' || tool === 'request_permission')
          && (workerJob || sock.piSubagentId || sock.agentRole !== 'chat' || msg.parentTaskId)) {
          throw workflowError('ROOT_INTERACTION_REQUIRED', 'Only the root conversation may manage the plan');
        }
        if (!record.agentSession && !workerJob && tool !== 'read_product_skill') {
          throw workflowError('AGENT_NOT_STARTED', 'No active chat session');
        }
        if (sock.agentRole?.startsWith('copy-layout-worker:') && !workerJob) {
          throw workflowError('COPY_LAYOUT_JOB_UNAUTHORIZED', 'This background worker is not bound to an active copy-layout job');
        }
        if (workerJob) {
          if (workerJob.status !== 'running') {
            throw workflowError('COPY_LAYOUT_JOB_SETTLED', 'This copy-layout job is already settled');
          }
          if (!copyLayoutWorkerTools.has(tool)) {
            throw workflowError('COPY_LAYOUT_TOOL_DENIED', `The autonomous copy-layout worker cannot call ${tool}`);
          }
          if (args.jobId && args.jobId !== workerJob.jobId) {
            throw workflowError('COPY_LAYOUT_JOB_MISMATCH', 'The tool call does not match this worker\'s bound job');
          }
        } else if (record.agentSession) {
          if (msg.workflow && msg.workflow !== record.agentSession.planning.workflow) {
            throw workflowError('WORKFLOW_MISMATCH', `MCP call declared ${msg.workflow} but the active workflow is ${record.agentSession.planning.workflow}`);
          }
          const gates = projectToolGates();
          authorizeToolCall({
            category: definition.category,
            tool,
            workflow: record.agentSession.planning.workflow,
            phase: record.agentSession.planning.phase,
            expectedEpoch: record.agentSession.planning.capabilityEpoch,
            receivedEpoch: msg.capabilityEpoch,
            chatMayEdit: gates.chatMayEdit,
            homeSearch: gates.homeSearch,
            chatPermissionGrants: !sock.piSubagentId && !msg.parentTaskId ? record.agentSession.chatPermissionGrants : [],
          });
        }
      } catch (error) {
        if (error?.name === 'ZodError') error.code = 'INVALID_ARGS';
        sendError(error, 'INVALID_ARGS');
        return;
      }
      if (tool === 'read_product_skill') {
        void skillRegistry.readResource(String(args.name ?? ''), String(args.resourcePath ?? 'SKILL.md'))
          .then(sendResult)
          .catch((error) => sendError(error, 'SKILLS_ERROR'));
        return;
      }
      if (tool === 'request_permission') {
        const generation = record.agentSession.generation;
        void (async () => {
          if (sock.agentLabel !== 'pi') await consumeChatPermissionScope(record, sock.agentLabel, args, generation);
          return requestChatPermission(record, args, generation);
        })().then(sendResult).catch((error) => sendError(error, 'CHAT_PERMISSION_FAILED'));
        return;
      }
      if (tool === 'commit_product_skill') {
        void skillRegistry.commit(skillRegistry.parseChange(args))
          .then((outcome) => sendResult(publishedSkillOutcome(outcome)))
          .catch((error) => sendError(error, 'SKILLS_ERROR'));
        return;
      }
      if (tool === 'list_harness_skills') {
        void skillRegistry.harness()
          .then((skills) => sendResult({ skills }))
          .catch((error) => sendError(error, 'SKILLS_ERROR'));
        return;
      }
      if (tool === 'ask_user_question') {
        if (workerJob || sock.piSubagentId || sock.agentRole !== 'chat' || msg.parentTaskId) {
          sendError(workflowError(
            'ROOT_INTERACTION_REQUIRED',
            'Only the root conversation may ask the user questions',
          ));
          return;
        }
        let request;
        try {
          request = normalizeMcpUserQuestionRequest(args, `mcp:${String(clientId)}`);
        } catch (error) {
          if (error?.name === 'ZodError') error.code = 'INVALID_ARGS';
          sendError(error, 'INVALID_ARGS');
          return;
        }
        const generation = record.agentSession.generation;
        void (async () => {
          // Pi에는 위임 에이전트 질문 경로가 없어 MCP 프로세스 자체가 루트다.
          // 다른 레거시 전송은 별도 프로바이더 스트림의 정확한 일회용 범위 티켓을
          // 기다린 뒤 소비해, 상속된 환경 변수만으로 루트를 사칭하지 못하게 한다.
          if (sock.agentLabel !== 'pi') {
            const matchingScopes = await waitForUserQuestionScopes(
              record,
              sock.agentLabel,
              request.questions,
              generation,
            );
            if (matchingScopes.length !== 1) {
              throw workflowError(
                'CALLER_SCOPE_UNKNOWN',
                'The provider did not unambiguously establish that this question came from the root conversation',
              );
            }
            const scopeIndex = matchingScopes[0].index;
            const [scope] = record.pendingUserQuestionScopes.splice(scopeIndex, 1);
            if (scope.parentTaskId) {
              throw workflowError(
                'ROOT_INTERACTION_REQUIRED',
                'Only the root conversation may ask the user questions',
              );
            }
          }
          const outcome = await requestUserQuestion(record, request, {
            source: 'mcp',
            generation,
            mcpSocket: sock,
          });
          if (outcome.status === 'answered') {
            sendResult({
              status: 'answered',
              answers: userQuestionAnswersForMcp(request, outcome.answers),
            });
            return;
          }
          const code = outcome.status === 'cancelled'
            ? 'USER_QUESTION_CANCELLED'
            : 'USER_QUESTION_EXPIRED';
          sendError(workflowError(code, `User question ${outcome.status}: ${outcome.reason}`));
        })()
          .catch((error) => sendError(error, 'USER_QUESTION_FAILED'));
        return;
      }
      if (tool === 'delegate_copy_layout') {
        try {
          const job = createTemplateJob(record, record.agentSession, args);
          sendResult({
            jobId: job.jobId,
            status: 'running',
            provider: job.agent,
            model: job.model,
            completionDelivery: 'automatic-owning-chat-turn',
            waitForCompletion: false,
            message: '백그라운드 작업을 시작했습니다. wait_agent로 기다리거나 폴링하지 말고 현재 턴을 끝내세요. 완료되면 허브가 이 채팅을 자동으로 다시 시작해 결과를 전달합니다.',
          });
        } catch (error) {
          sendError(error, 'COPY_LAYOUT_DELEGATION_FAILED');
        }
        return;
      }
      if (tool === 'update_copy_layout_job') {
        if (!workerJob) {
          sendError(workflowError('COPY_LAYOUT_JOB_UNAUTHORIZED', 'Only the bound copy-layout worker can report progress'));
          return;
        }
        workerJob.phase = args.phase;
        workerJob.activity = args.activity;
        if (args.iteration !== undefined) workerJob.iteration = args.iteration;
        sendTemplateJobEvent(record, taskProgressForJob(workerJob, args.activity, tool));
        sendResult({
          jobId: workerJob.jobId,
          phase: workerJob.phase,
          phaseIndex: copyLayoutPhaseIndex(workerJob.phase),
          iteration: workerJob.iteration ?? 0,
        });
        return;
      }
      if (tool === 'run_copy_layout_helper') {
        if (!workerJob) {
          sendError(workflowError('COPY_LAYOUT_JOB_UNAUTHORIZED', 'Only the bound copy-layout worker can run the helper'));
          return;
        }
        if (!workerJob.snapshot?.path) {
          sendError(workflowError('COPY_LAYOUT_SNAPSHOT_REQUIRED', 'Call materialize_document_snapshot before running the helper'));
          return;
        }
        if (workerJob.helperPending > 0) {
          sendError(workflowError('COPY_LAYOUT_HELPER_ACTIVE', 'Only one structured helper call may run at a time'));
          return;
        }
        if (args.action === 'inspect' && workerJob.inspection) {
          sendError(workflowError('COPY_LAYOUT_INSPECTION_COMPLETE', 'This immutable snapshot was already inspected'));
          return;
        }
        if (args.action === 'generate') {
          if (workerJob.publishedArtifacts.size > 0) {
            sendError(workflowError('COPY_LAYOUT_ARTIFACT_ALREADY_PUBLISHED', 'The final candidate is already snapshotted for completion'));
            return;
          }
          if (!workerJob.inspection) {
            sendError(workflowError('COPY_LAYOUT_INSPECTION_REQUIRED', 'Inspect the bound snapshot before generating a candidate'));
            return;
          }
          if (workerJob.generatedCandidates.has(args.iteration)
            || workerJob.generatedCandidates.size >= COPY_LAYOUT_MAX_ITERATIONS) {
            sendError(workflowError('COPY_LAYOUT_ITERATION_USED', 'Each of the three bounded candidate iterations may run only once'));
            return;
          }
        }
        const boundSnapshot = workerJob.snapshot;
        workerJob.helperPending = 1;
        const run = runCopyLayoutHelper(args, {
          sourcePath: boundSnapshot.path,
          sourceFormat: boundSnapshot.sourceFormat,
          helperPath: path.join(BUNDLED_SKILLS, 'copy-layout', 'scripts', 'copy_layout.py'),
          privateRoot: workerJob.generatedRoot,
          hwpBinary: hwpExtractor,
          spawnProcess: (command, argv, options) => spawnAuxiliaryProcess(
            record,
            command,
            argv,
            options,
          ),
          cleanupProcess: (child) => beginAuxiliaryProcessCleanup(record, child),
        }).then((result) => {
          if (workerJob.status !== 'running' || workerJob.snapshot !== boundSnapshot) {
            throw workflowError('COPY_LAYOUT_JOB_SETTLED', 'The copy-layout job changed before the helper completed');
          }
          if (args.action === 'inspect') workerJob.inspection = Object.freeze(result);
          else workerJob.generatedCandidates.set(args.iteration, Object.freeze(result));
          return result;
        }).finally(() => { workerJob.helperPending = 0; });
        workerJob.helperPromise = run;
        void run.then((result) => {
          sendTemplateJobEvent(record, taskProgressForJob(workerJob, `${args.action} helper completed`, tool));
          sendResult(result);
        }).catch((error) => {
          if (error?.processCleanupUncertain) {
            record.processCleanupUncertain = true;
            retainUncertainProcessCleanup(record.recordRoot);
          }
          sendError(error, 'COPY_LAYOUT_HELPER_FAILED');
        });
        return;
      }
      if (tool === 'complete_copy_layout_job') {
        if (!workerJob) {
          sendError(workflowError('COPY_LAYOUT_JOB_UNAUTHORIZED', 'Only the bound copy-layout worker can complete this job'));
          return;
        }
        if (workerJob.helperPending > 0) {
          sendError(workflowError('COPY_LAYOUT_HELPER_ACTIVE', 'Wait for the structured helper call to finish before completing the job'));
          return;
        }
        if (args.sourceDocumentId !== workerJob.binding.documentId || args.sourceDigest !== workerJob.binding.digest) {
          sendError(workflowError('COPY_LAYOUT_SOURCE_MISMATCH', 'Completion does not match the immutable source binding'));
          return;
        }
        const published = args.outcome === 'succeeded'
          ? workerJob.publishedArtifacts.get(args.artifactId)
          : null;
        if (args.outcome === 'succeeded' && !published) {
          sendError(workflowError('COPY_LAYOUT_ARTIFACT_UNBOUND', 'Completion must use an artifact published from this job\'s verified helper candidate'));
          return;
        }
        let storedClaims = null;
        try {
          storedClaims = published ? copyLayoutCandidateClaims(workerJob, published) : null;
        } catch (error) {
          sendError(error, 'COPY_LAYOUT_VERIFICATION_MISSING');
          return;
        }
        if (storedClaims && (
          published.report?.delivery?.ready !== true
          || published.report?.verification?.layout_structure_match !== true
          || args.quality !== storedClaims.quality
          || !exactJsonArray(args.warnings, storedClaims.warnings)
          || Object.entries(storedClaims.counts).some(([key, value]) => args.counts[key] !== value)
          || !exactJsonArray(args.preview.representativePages, storedClaims.preview.representativePages)
          || Object.entries(storedClaims.preview)
            .filter(([key]) => key !== 'representativePages')
            .some(([key, value]) => args.preview[key] !== value)
        )) {
          sendError(workflowError('COPY_LAYOUT_VERIFICATION_MISMATCH', 'Completion claims do not exactly match the stored helper render and verification evidence'));
          return;
        }
        const completionClaims = storedClaims ?? {
          quality: null,
          warnings: args.warnings,
          counts: {
            keptText: 0, removedText: 0, replacedText: 0, resetControls: 0,
            clearedMarks: 0, keptMedia: 0, removedMedia: 0,
            iterations: Math.max(1, Math.min(COPY_LAYOUT_MAX_ITERATIONS, workerJob.generatedCandidates.size || 1)),
          },
          preview: {
            representativePages: [], sourcePageCount: 1, outputPageCount: 1,
            outputSectionCount: 1, renderCompared: false, geometryMatch: false,
            safetyVerified: false, readabilityVerified: false, stoppedReason: 'hard-failure',
          },
        };
        // Claim the one-shot completion before the first await so concurrent
        // requests cannot both settle the same worker job.
        try {
          claimCopyLayoutSettlement(workerJob);
        } catch (error) {
          sendError(error, 'COPY_LAYOUT_JOB_SETTLED');
          return;
        }
        const completion = (async () => {
          let artifact = null;
          if (args.outcome === 'succeeded') {
            artifact = await record.artifactStore.annotate(args.artifactId, {
              template: {
                kind: 'copy-layout',
                jobId: workerJob.jobId,
                quality: completionClaims.quality,
                pageCount: completionClaims.preview.outputPageCount,
                sectionCount: completionClaims.preview.outputSectionCount,
                registeredTemplateId: null,
              },
            });
          }
          workerJob.status = args.outcome === 'succeeded' ? 'completed' : 'failed';
          workerJob.activity = args.summary;
          workerJob.result = {
            summary: args.summary,
            warnings: completionClaims.warnings,
            counts: completionClaims.counts,
            preview: completionClaims.preview,
            ...(artifact ? {
              quality: completionClaims.quality,
              artifact: artifactDownloadDescriptor(record, args.artifactId, artifact),
            } : {}),
          };
          workerJob.inspection = null;
          workerJob.generatedCandidates.clear();
          workerJob.publishedArtifacts.clear();
          record.activeTemplateJobId = null;
          pruneTemplateJobHistory(record);
          sendTemplateJobEvent(record, {
            type: 'task-end',
            agent: workerJob.agent,
            taskId: workerJob.jobId,
            status: workerJob.status === 'completed' ? 'completed' : 'failed',
            summary: args.summary,
            ...(workerJob.usage ? { usage: workerJob.usage } : {}),
          });
          queueTemplateCompletion(record, workerJob);
          sendResult({ jobId: workerJob.jobId, status: workerJob.status });
        })();
        workerJob.completionPromise = completion;
        void completion.catch((error) => {
          if (workerJob.status === 'settling') workerJob.status = 'running';
          settleTemplateJobFailure(record, workerJob, error);
          sendError(error, 'COPY_LAYOUT_COMPLETION_FAILED');
        });
        return;
      }
      if (tool === 'register_copy_layout_template') {
        void registerCopyLayoutTemplate(record, args)
          .then(sendResult)
          .catch((error) => sendError(error, 'TEMPLATE_REGISTER_FAILED'));
        return;
      }
      if (tool === 'read_agent_instructions') {
        sendResult(agentInstructionsStore.snapshot());
        return;
      }
      if (tool === 'update_agent_instructions') {
        try {
          const status = agentInstructionsStore.snapshot();
          const prepared = agentInstructionsStore.prepareUpdate(args.content, {
            expectedRevision: args.expectedRevision,
          });
          if (prepared.content === status.content) {
            sendResult({ ...status, changed: false, pendingConfirmation: false });
            return;
          }
          if (!record.studioSocket || record.studioSocket.readyState !== record.studioSocket.OPEN) {
            throw workflowError(
              'INSTRUCTIONS_CONFIRMATION_UNAVAILABLE',
              'Rauhwpx Studio must be connected so the user can confirm the instruction proposal.',
            );
          }
          if (record.pendingInstructionDraft) clearInstructionDraft(record, 'replaced');
          const requestedBy = sock.agentLabel ?? record.agentSession?.agent ?? 'unknown';
          const createdAt = Date.now();
          const draft = {
            id: crypto.randomUUID(),
            confirmationToken: crypto.randomUUID(),
            content: prepared.content,
            expectedRevision: prepared.expectedRevision,
            reason: typeof args.reason === 'string' ? args.reason : null,
            requestedBy,
            createdAt,
            expiresAt: createdAt + AGENT_INSTRUCTION_DRAFT_TTL_MS,
          };
          record.pendingInstructionDraft = draft;
          draft.expiryTimer = setTimeout(() => {
            if (record.pendingInstructionDraft?.id === draft.id) {
              clearInstructionDraft(record, 'expired');
            }
          }, AGENT_INSTRUCTION_DRAFT_TTL_MS);
          draft.expiryTimer.unref?.();
          if (!sendInstructionDraft(record)) {
            record.pendingInstructionDraft = null;
            throw workflowError(
              'INSTRUCTIONS_CONFIRMATION_UNAVAILABLE',
              'Rauhwpx Studio disconnected before the instruction proposal could be shown.',
            );
          }
          sendResult({
            ...status,
            changed: false,
            pendingConfirmation: true,
            draftId: draft.id,
            expiresAt: new Date(draft.expiresAt).toISOString(),
            ...(draft.reason ? { reason: draft.reason } : {}),
          });
        } catch (error) {
          sendError(error, 'INSTRUCTIONS_DRAFT_FAILED');
        }
        return;
      }
      if (definition.category === 'project-read' || definition.category === 'project-write' || definition.category === 'project-ingest') {
        const session = record.agentSession;
        if (session?.projectId) projectRecords.set(session.projectId, record);
        void executeProjectTool({
          tool,
          args,
          session: session ? { ...session, agent: sock.agentLabel ?? session.agent } : null,
          projectStore,
          ingest: projectIngest,
          homeSearch,
          allowedRoots: [record.workDir, record.downloadManager.baseDir],
          sessionKey: record.sessionId,
          labels: recordLabels(record),
        })
          .then(({ handled, result }) => {
            if (!handled) throw workflowError('UNKNOWN_TOOL', `Unknown project tool: ${tool}`);
            sendResult(result);
          })
          .catch((error) => sendError(error, 'PROJECT_TOOL_FAILED'));
        return;
      }
      const referenceImage = referenceImageCall(tool, args);
      if (definition.category === 'reference-read' && !referenceImage) {
        void executeReferenceTool({ tool, args, store: referenceStore, session: record.agentSession, projectStore })
          .then(({ handled, result }) => {
            if (!handled) throw workflowError('UNKNOWN_TOOL', `Unknown reference tool: ${tool}`);
            sendResult(result);
          })
          .catch((error) => sendError(error, 'REFERENCE_READ_FAILED'));
        return;
      }
      if (tool === 'get_active_template') {
        try {
          if (!record.agentSession?.activeTemplateId) throw workflowError('TEMPLATE_NOT_SELECTED', 'Select a template with /templates first.');
          sendResult({
            template: templateStore.get(record.agentSession.activeTemplateId),
            transferCapabilities: {
              exact: ['paragraphText', 'characterFormatting', 'paragraphFormatting', 'tables', 'embeddedPictures'],
              supported: ['pageGeometry', 'columns', 'sectionDefaults', 'pageBorders', 'headerFooterTextAndPageScope'],
              fallback: ['styles', 'numbering', 'unsupportedControls', 'shapes', 'headerFooterFormattingAndControls'],
              skipped: [],
            },
          });
        } catch (error) {
          sendError(error, 'TEMPLATE_NOT_FOUND');
        }
        return;
      }
      if (tool === 'present_implementation_plan') {
        if (!record.studioSocket || record.studioSocket.readyState !== record.studioSocket.OPEN) {
          sendError(workflowError('NO_STUDIO', 'Studio must be connected to review an implementation plan'));
          return;
        }
        try {
          const planRecord = record.agentSession.planning.present(args, record.agentSession.lastObservedDocumentRevision);
          record.agentSession.planReviewTurnId = null;
          sendJson(record.studioSocket, {
            v: 1,
            type: 'plan-ready',
            planId: planRecord.planId,
            plan: planRecord.plan,
            ...record.agentSession.planning.snapshot(),
          });
          emitWorkflowState(record, { reason: 'plan-presented' });
          const { workflow, phase, capabilityEpoch } = record.agentSession.planning.snapshot();
          sendResult({ planId: planRecord.planId, workflow, phase, capabilityEpoch });
        } catch (error) {
          sendError(error);
        }
        return;
      }
      if (tool === 'update_todos') {
        try {
          const snapshot = record.agentSession.planning.updateTodos(args);
          sendJson(record.studioSocket, { v: 1, type: 'plan-progress', ...snapshot });
          sendResult(snapshot);
        } catch (error) {
          sendError(error);
        }
        return;
      }
      if (tool === 'download_file') {
        void record.downloadManager.download({ sessionId: record.agentSession.chatId, ...args })
          .then(sendResult)
          .catch((error) => sendError(error, 'DOWNLOAD_FAILED'));
        return;
      }
      if (tool === 'publish_artifact') {
        let workerCandidate = null;
        let workerPublishClaimed = false;
        if (workerJob) {
          const requestedPath = path.resolve(String(args.filePath ?? ''));
          workerCandidate = [...workerJob.generatedCandidates.values()]
            .find((candidate) => path.resolve(candidate.outputPath) === requestedPath) ?? null;
          try {
            if (workerCandidate) {
              copyLayoutCandidateClaims(workerJob, { report: workerCandidate.report });
            }
            claimCopyLayoutPublication(workerJob, workerCandidate);
          } catch (error) {
            sendError(error, 'COPY_LAYOUT_ARTIFACT_UNBOUND');
            return;
          }
          workerPublishClaimed = true;
        }
        const artifactOwner = workerJob
          ? { threadId: workerJob.ownerThreadId, documentId: workerJob.binding?.documentId ?? null }
          : { threadId: record.agentSession?.threadId ?? null, documentId: record.agentSession?.documentId ?? null };
        void record.artifactStore.publish({ ...args, owner: artifactOwner })
          .then(async ({ artifactId, fileName, mime, size, checksum }) => {
            if (workerJob) {
              await Promise.resolve(workerJob.helperPromise);
              if (workerJob.status !== 'running'
                || workerJob.helperPending !== 0
                || workerJob.generatedCandidates.get(workerCandidate.iteration) !== workerCandidate
                || checksum !== workerCandidate.checksum) {
                throw workflowError('COPY_LAYOUT_ARTIFACT_MISMATCH', 'Published bytes no longer match the verified helper candidate');
              }
              workerJob.publishedArtifacts.set(artifactId, Object.freeze({
                checksum,
                outputPath: workerCandidate.outputPath,
                iteration: workerCandidate.iteration,
                report: workerCandidate.report,
              }));
              // ArtifactStore owns an immutable byte snapshot now. Remove all
              // private candidates immediately so sequential jobs cannot grow
              // hub storage by 3 x 64 MiB each.
              await cleanupTemplateGeneratedRoot(record, workerJob);
            }
            const encodePathSegment = (value) => encodeURIComponent(value).replace(
              /[!'()*]/g,
              (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
            );
            const downloadUrl = new URL(
              `/artifacts/${encodePathSegment(artifactId)}/${encodePathSegment(fileName)}`,
              `http://127.0.0.1:${hubPort}`,
            );
            downloadUrl.searchParams.set('sessionId', record.sessionId);
            downloadUrl.searchParams.set('token', sessions.issue(TOKEN, record.sessionId, {
              audience: HUB_CAPABILITY_AUDIENCES.ARTIFACT,
              resource: artifactId,
            }));
            sendResult({ artifactId, fileName, mime, size, checksum, downloadUrl: downloadUrl.href });
          })
          .catch((error) => {
            if (workerJob && workerPublishClaimed) {
              releaseCopyLayoutPublication(workerJob, workerCandidate);
            }
            sendError(error, 'ARTIFACT_PUBLISH_FAILED');
          });
        return;
      }
      if (definition.category === 'browser') {
        const sidecarTool = tool.replace(/^browserbase_/, '');
        const { browserId, ...sidecarArgs } = args;
        void record.browserbaseSession.call(record.agentSession.chatId, browserId, sidecarTool, sidecarArgs)
          .then(sendResult)
          .catch((error) => {
            if (error?.processCleanupUncertain) {
              record.processCleanupUncertain = true;
              retainedUncertainBrowserbaseSessions.add(record.browserbaseSession);
              retainUncertainProcessCleanup(record.recordRoot);
            }
            sendError(error, 'BROWSERBASE_TOOL_FAILED');
          });
        return;
      }
      if (workerJob && tool === 'materialize_document_snapshot') {
        if (workerJob.snapshot) {
          sendResult(workerJob.snapshot);
          return;
        }
        if (workerJob.snapshotPending) {
          sendError(workflowError(
            'COPY_LAYOUT_SNAPSHOT_ACTIVE',
            'The immutable document snapshot is already being materialized for this job',
          ));
          return;
        }
      }
      // 스튜디오 전달 — 참조 이미지 경로는 허브가 인자를 채운 뒤 비동기로 호출한다.
      const forwardToStudio = (args) => {
        if (!record.studioSocket || record.studioSocket.readyState !== record.studioSocket.OPEN) {
          sendError(workflowError('NO_STUDIO', 'Studio is not connected; open rhwp-studio in a browser'));
          return;
        }
        if (record.pendingCalls.size >= MAX_PENDING_STUDIO_TOOL_CALLS) {
          sendError(workflowError(
            'TOO_MANY_INFLIGHT_CALLS',
            `At most ${MAX_PENDING_STUDIO_TOOL_CALLS} Studio tool calls may be in flight`,
          ));
          return;
        }
        let activeTemplate = null;
        if (tool.startsWith('template_')) {
          try {
            if (!record.agentSession?.activeTemplateId) throw workflowError('TEMPLATE_NOT_SELECTED', 'Select a template with /templates first.');
            activeTemplate = templateStore.get(record.agentSession.activeTemplateId);
            if (args.templateRevision !== activeTemplate.revision) {
              throw workflowError('TEMPLATE_REVISION_MISMATCH', `Template changed from revision ${String(args.templateRevision)} to ${activeTemplate.revision}; inspect it again before continuing.`);
            }
          } catch (error) {
            sendError(error, 'TEMPLATE_NOT_FOUND');
            return;
          }
        }
        // render_page savePath 는 스튜디오 렌더 전에 경로부터 검증한다 (쓰기는 응답 때 허브가 한다).
        let renderSavePath = null;
        if (tool === 'render_page' && args.savePath !== undefined) {
          try {
            renderSavePath = resolveRenderSavePath(record.workDir, args.savePath);
          } catch (error) {
            sendError(error, 'INVALID_ARGS');
            return;
          }
        }
        const hubId = record.nextHubId++;
        if (workerJob && tool === 'materialize_document_snapshot') {
          try {
            claimCopyLayoutSnapshot(workerJob);
          } catch (error) {
            sendError(error, 'COPY_LAYOUT_SNAPSHOT_ACTIVE');
            return;
          }
        }
        // apply_edits/read_batch 는 항목 수만큼 변이+마감 리플로우를 안고 오므로 배치
        // 크기에 비례해 늘린다. 전체 문서 직렬화+base64 전송도 큰 파일에서는 길어질 수
        // 있어 별도 예산을 준다 (모두 mcp-stdio 의 180s 한도 아래로 유지).
        const batchItems = tool === 'apply_edits' ? args.edits
          : tool === 'read_batch' ? args.reads
            : null;
        const timeoutMs = batchItems !== null
          ? Math.min(STUDIO_TOOL_TIMEOUT_MS + 2_000 * (Array.isArray(batchItems) ? batchItems.length : 0), 120_000)
          : tool === 'materialize_document_snapshot'
            ? 120_000
            : STUDIO_TOOL_TIMEOUT_MS;
        const timer = setTimeout(() => {
          const pendingEntry = record.pendingCalls.get(hubId);
          record.pendingCalls.delete(hubId);
          cancelStudioToolRequest(record, hubId, pendingEntry, 'studio-timeout');
          if (workerJob && tool === 'materialize_document_snapshot') {
            releaseCopyLayoutSnapshot(workerJob);
          }
          sendError(workflowError(
            'STUDIO_TIMEOUT',
            `Studio did not answer within ${timeoutMs / 1000}s — the edit may still have applied; re-read with get_structure/get_text_range before retrying to avoid duplicates`,
          ));
        }, timeoutMs);
        record.pendingCalls.set(hubId, {
          mcpSocket: sock,
          clientId,
          sendResult,
          sendError,
          providerTurn,
          timer,
          tool,
          documentIdentity: workerJob
            ? { documentId: workerJob.binding.documentId, documentName: workerJob.binding.documentName }
            : activeDocumentIdentity(record.agentSession),
          chatId: workerJob?.jobId
            ?? record.agentSession?.chatId
            ?? record.agentSession?.threadId
            ?? record.sessionId,
          copyLayoutJobId: workerJob?.jobId ?? null,
          sessionGeneration: record.agentSession?.generation ?? null,
          renderSavePath,
          trace,
        });
        if (trace) trace.hubId = hubId;
        const forwarded = sendJson(record.studioSocket, {
          ...(trace ? { trace: 1 } : {}),
          v: 1, type: 'tool-request', id: hubId,
          // 호출을 보낸 MCP 소켓의 에이전트 라벨을 단다 — 현재 세션 기준으로 찍으면
          // 세션 교체 직후 남은 호출이 엉뚱한 에이전트로 기록될 수 있다.
          agent: sock.agentLabel ?? record.agentSession?.agent ?? 'claude',
          tool,
          args,
          ...(activeTemplate ? { template: activeTemplate } : {}),
          workflow: record.agentSession?.planning.snapshot().workflow,
          phase: record.agentSession?.planning.snapshot().phase,
          capabilityEpoch: record.agentSession?.planning.capabilityEpoch,
          chatPermissionGrants: !workerJob && !sock.piSubagentId && !msg.parentTaskId ? normalizeChatPermissionGrants(record.agentSession.chatPermissionGrants) : [],
          turnBound: !workerJob,
          ...(providerTurn ? { providerTurnId: providerTurn.turnId } : {}),
          ...(sock.parentTaskId ? { parentTaskId: sock.parentTaskId } : {}),
        });
        if (trace) trace.hubFwd = traceNow();
        if (!forwarded) {
          clearTimeout(timer);
          record.pendingCalls.delete(hubId);
          if (workerJob && tool === 'materialize_document_snapshot') {
            releaseCopyLayoutSnapshot(workerJob);
          }
          sendError(workflowError('NO_STUDIO', 'Studio disconnected before receiving the tool request'));
        }
      };
      // 참조 그림: 허브가 저장소를 읽어 바로 답하거나(자르지 않는 이미지), 인자를 채워 스튜디오로 넘긴다
      // (잘라내기·확대·삽입, PDF 쪽과 영역 조각은 스튜디오가 HTTP 로 받아 그린다).
      if (referenceImage) {
        void planReferenceImageCall({ tool, args, store: referenceStore, session: record.agentSession, projectStore })
          .then((plan) => {
            if (callSettled) return;
            if (plan.result) {
              sendResult(plan.result);
              return;
            }
            if (providerTurn && !providerTurnIsActive(record, providerTurn)) {
              sendError(noActiveProviderTurnError());
              return;
            }
            forwardToStudio(plan.forward);
          })
          .catch((error) => sendError(error, 'REFERENCE_READ_FAILED'));
        return;
      }
      forwardToStudio(args);
      return;
    }
    default:
      log(`ignoring unknown mcp message type: ${String(msg.type)}`);
  }
}

function attachSocket(record, sock, role) {
  let queuedStudioBytes = 0;
  let queuedStudioMessages = 0;
  sock.on('message', async (data, isBinary) => {
    const traceIn = TOOL_TRACE_ENABLED ? traceNow() : 0;
    if (record.disposed) {
      try { sock.close(1001, 'hub session closed'); } catch {}
      return;
    }
    if (isBinary) {
      sock.close(4400, 'binary frames not supported');
      return;
    }
    const frameBytes = Number(data?.byteLength ?? Buffer.byteLength(String(data), 'utf8'));
    let releaseStudioBudget = () => {};
    if (role === 'studio') {
      if (!Number.isSafeInteger(frameBytes) || frameBytes < 0
        || queuedStudioMessages >= MAX_STUDIO_QUEUED_MESSAGES
        || queuedStudioBytes + frameBytes > MAX_STUDIO_QUEUED_FRAME_BYTES) {
        sock.close(4408, 'studio message queue limit exceeded');
        return;
      }
      queuedStudioMessages += 1;
      queuedStudioBytes += frameBytes;
      let released = false;
      releaseStudioBudget = () => {
        if (released) return;
        released = true;
        queuedStudioMessages -= 1;
        queuedStudioBytes -= frameBytes;
      };
    }
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      releaseStudioBudget();
      sock.close(4400, 'malformed JSON');
      return;
    }
    if (msg?.v !== PROTOCOL_VERSION) {
      releaseStudioBudget();
      sendJson(sock, {
        v: 1, type: 'protocol-error', code: 'UNSUPPORTED_VERSION',
        message: `protocol version ${String(msg?.v)} is not supported`, supportedVersions: [PROTOCOL_VERSION],
      });
      sock.close(1002, 'unsupported protocol version');
      return;
    }
    try {
      if (role === 'studio') {
        // WebSocket 은 async 메시지 리스너를 동시에 실행한다. Studio 명령을 직렬화해
        // 빠른 중지/시작/열기 조작이 옛 채팅을 되살리지 못하게 한다.
        if (traceIn && msg?.type === 'tool-response' && msg.trace) {
          msg.hubTrace = { respIn: traceIn, respBytes: frameBytes };
        }
        record.studioMessageQueue = record.studioMessageQueue
          .then(() => {
            if (msg.hubTrace) msg.hubTrace.respDeq = traceNow();
            // 닫힌 소켓의 명령은 버리되 tool-response 는 처리한다 — hubId 로만 살아 있는
            // pendingCalls 를 마무리하고, 교체된 인스턴스의 호출은 이미 실패 처리돼 있다.
            // 느린 항목 뒤에 줄 서 있던 응답이 소켓 종료로 사라지면 30초 타임아웃까지 간다.
            if (record.studioSocket !== sock && msg.type !== 'tool-response') return;
            return handleStudioMessage(record, sock, msg);
          })
          .catch((error) => {
            log(`message handler error (${role}, session=${record.sessionId}): ${error?.stack ?? error}`);
          })
          .finally(releaseStudioBudget);
      } else {
        handleMcpMessage(record, sock, msg, traceIn, frameBytes);
      }
    } catch (e) {
      releaseStudioBudget();
      log(`message handler error (${role}, session=${record.sessionId}): ${e?.stack ?? e}`);
    }
  });
  sock.on('error', (err) => log(`${role} socket error (session=${record.sessionId}): ${err?.message ?? err}`));
}

function recordHealth(record) {
  return {
    sessionId: record.sessionId,
    createdAt: record.createdAt,
    lastConnectedAt: record.lastConnectedAt,
    studioConnected: !!record.studioSocket && record.studioSocket.readyState === record.studioSocket.OPEN,
    mcpClients: record.mcpSockets.size,
    session: sessionInfo(record),
    browserbase: record.browserbaseSession.status(),
  };
}

function healthzBody() {
  return {
    ok: true,
    name: HUB_NAME,
    pid: process.pid,
    launchId: LAUNCH_ID,
    port: hubPort,
    uptimeMs: Date.now() - STARTED_AT,
    protocol: PROTOCOL_VERSION,
    secretBroker: secretStore.available,
    sessions: sessions.summaries(recordHealth),
    providers: providerHealth.cached(),
  };
}

function requestToken(req, url) {
  const authorization = String(req.headers.authorization ?? '');
  if (authorization.startsWith('Bearer ')) return authorization.slice(7);
  return url.searchParams.get('token') ?? '';
}

function sendHttpJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function authenticateHttpSession(req, url, { audience, resource } = {}) {
  return sessions.authenticate({
    masterToken: TOKEN,
    token: requestToken(req, url),
    sessionId: url.searchParams.get('sessionId'),
    audience,
    ...(resource === undefined ? {} : { resource }),
    allowMaster: !PRODUCTION,
  });
}

function authenticateOwnerRequest(req, url) {
  // 소유자 엔드포인트(/shutdown, DELETE /sessions)는 마스터 토큰을 Authorization
  // 헤더로만 받는다 — URL 에 실린 토큰은 히스토리·로그·크래시 리포트에 남는다.
  const authorization = String(req.headers.authorization ?? '');
  const bearer = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
  if (!bearer || url.searchParams.get('token')) {
    const error = new Error('owner endpoints require a bearer token');
    error.code = 'UNAUTHORIZED';
    throw error;
  }
  authenticateMasterToken(TOKEN, bearer);
  if (!timingSafeTextEqual(String(req.headers['x-rhwp-launch-id'] ?? ''), LAUNCH_ID)) {
    const error = new Error('invalid hub launch id');
    error.code = 'UNAUTHORIZED';
    throw error;
  }
}

function isReferencePath(pathname) {
  return pathname === '/reference-files'
    || pathname === '/reference-staging'
    || pathname === '/reference-search'
    || pathname.startsWith('/reference-files/')
    || pathname.startsWith('/reference-staging/');
}

function isTemplatePath(pathname) {
  return pathname === '/templates' || pathname.startsWith('/templates/');
}

/** Host 헤더가 루프백(127.0.0.1/localhost/[::1])인지 — DNS rebinding 차단용. */
function isLoopbackHost(hostHeader) {
  const host = String(hostHeader ?? '').toLowerCase().replace(/:\d+$/, '').replace(/^\[/, '').replace(/\]$/, '');
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

// 브라우저 Studio가 허브 PC의 설치 글꼴을 쓰게 한다. 참고자료와 같은 세션 capability로 인증한다.
const handleFontHttp = createFontHttpHandler({
  authenticate: (req, url) => sessions.require(authenticateHttpSession(req, url, {
    audience: HUB_CAPABILITY_AUDIENCES.REFERENCE,
  })),
  log: (line) => console.warn(`[rhwp-agent] fonts: ${line}`),
});

const httpServer = http.createServer((req, res) => {
  void Promise.resolve().then(async () => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${hubPort || REQUESTED_PORT || 5175}`);
    // DNS rebinding 방어: 프로덕션(데스크톱 소유 허브)에서는 Host 가 루프백이어야 한다.
    // 브라우저는 요청에 재바인딩된 도메인을 Host 로 실어 보내므로 여기서 걸러진다.
    if (PRODUCTION && !isLoopbackHost(req.headers.host)) {
      sendHttpJson(res, 403, { status: 'forbidden' });
      return;
    }
    if (shutdownPreparationPromise
      && !(req.method === 'POST' && url.pathname === '/shutdown')) {
      sendHttpJson(res, 503, { status: 'shutting-down' });
      return;
    }
    if (req.method === 'GET' && url.pathname.startsWith('/artifacts/')) {
      const origin = typeof req.headers.origin === 'string' ? req.headers.origin : null;
      if (origin && !isAllowedStudioOrigin(origin)) {
        sendHttpJson(res, 403, { status: 'forbidden' });
        return;
      }
      const [, , encodedArtifactId] = url.pathname.split('/');
      const artifactId = decodeURIComponent(encodedArtifactId ?? '');
      const sessionId = authenticateHttpSession(req, url, {
        audience: HUB_CAPABILITY_AUDIENCES.ARTIFACT,
        resource: artifactId,
      });
      const record = sessions.require(sessionId);
      let artifact;
      try {
        artifact = await record.artifactStore.read(artifactId);
      } catch (error) {
        if (error?.code !== 'ARTIFACT_NOT_FOUND') throw error;
        sendHttpJson(res, 404, { status: 'not-found' });
        return;
      }
      const encodedName = encodeURIComponent(artifact.fileName).replaceAll('%20', ' ');
      const asciiName = artifact.fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
      res.writeHead(200, {
        'content-type': artifact.mime,
        'content-length': artifact.bytes.length,
        'content-disposition': `attachment; filename="${asciiName}"; filename*=UTF-8''${encodedName}`,
        'cache-control': 'no-store, private',
        'x-content-type-options': 'nosniff',
        ...(origin ? {
          'access-control-allow-origin': origin,
          'access-control-expose-headers': 'Content-Disposition, Content-Length',
          vary: 'Origin',
        } : {}),
      });
      res.end(artifact.bytes);
      return;
    }
    if (isFontPath(url.pathname)) {
      await handleFontHttp(req, res, url);
      return;
    }
    if (isReferencePath(url.pathname) || isTemplatePath(url.pathname)) {
      let authSessionId = null;
      if (req.method !== 'OPTIONS') {
        authSessionId = authenticateHttpSession(req, url, {
          audience: isReferencePath(url.pathname)
            ? HUB_CAPABILITY_AUDIENCES.REFERENCE
            : HUB_CAPABILITY_AUDIENCES.TEMPLATE,
        });
        sessions.require(authSessionId);
      }
      // The route handler still enforces a Bearer header. Its accepted value is
      // the capability already authenticated above, never a freshly derived
      // session-wide token.
      const presentedToken = requestToken(req, url);
      const expectedTokens = authSessionId ? [presentedToken] : [];
      const referenceRecord = authSessionId ? sessions.require(authSessionId) : null;
      const stagingPath = url.pathname === '/reference-staging' || url.pathname.startsWith('/reference-staging/');
      // 초안 첨부만 별도로 묶는다. 저장된 자료 읽기는 살아 있는 provider 세션의 범위만 쓴다.
      const allowedScopes = referenceRecord
        ? referenceScopesForSession(stagingPath && referenceRecord.referenceStagingThreadId
          ? { threadId: referenceRecord.referenceStagingThreadId }
          : referenceRecord.agentSession)
        : [];
      if (isReferencePath(url.pathname)) {
        const handleReferenceHttp = createReferenceHttpHandler({
          store: referenceStore,
          tokens: expectedTokens,
          allowedScopes,
        });
        if (await handleReferenceHttp(req, res, url)) return;
      }
      if (isTemplatePath(url.pathname)) {
        const handleTemplateHttp = createTemplateHttpHandler({
          store: templateStore,
          tokens: expectedTokens,
          onChanged: broadcastTemplateCatalog,
        });
        if (await handleTemplateHttp(req, res, url)) return;
      }
    }
    if (isProjectPath(url.pathname)) {
      // 참고 자료와 같은 REFERENCE capability 로 인증한다. 세션은 자기 프로젝트만 다룬다.
      let record = null;
      if (req.method !== 'OPTIONS') {
        record = sessions.require(authenticateHttpSession(req, url, {
          audience: HUB_CAPABILITY_AUDIENCES.REFERENCE,
        }));
      }
      const handleProjectHttp = createProjectHttpHandler({
        projectStore,
        referenceStore,
        settingsStore: projectSettings,
        librarian: projectLibrarian,
        tokens: record ? [requestToken(req, url)] : [],
        session: record ? {
          projectId: record.boundProjectId ?? null,
          documentId: record.boundDocumentId ?? null,
          documentName: record.agentSession?.documentName ?? null,
          labels: recordLabels(record),
        } : null,
        homeAccess: HOME_ACCESS,
        platform: process.platform,
        onBindingChanged: async () => {
          if (record) await rebindRecordProject(record);
          await reconcileProjectBindings();
        },
      });
      if (record?.boundProjectId) projectRecords.set(record.boundProjectId, record);
      if (await handleProjectHttp(req, res, url)) return;
    }
    if (req.method === 'GET' && url.pathname === '/oauth/openrouter/callback') {
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      const authRun = authRuns.get('pi');
      if (!code || !authRun || authRun.method !== 'oauth'
        || authRun.signal?.aborted || typeof authRun.commitCredentials !== 'function') {
        res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
        res.end('<!doctype html><meta charset="utf-8"><title>Rauhwpx</title><p>OpenRouter login did not return a code.</p>');
        return;
      }
      try {
        // The manager checks this exact run signal throughout exchange and commits.
        // commitCredentials rechecks identity and removes the run synchronously with
        // the credential write, before any slow post-auth status work begins.
        piStatus = await piManager.completeOAuth(code, state, {
          signal: authRun.signal,
          onCommitted: authRun.commitCredentials,
        });
        if (authRun.credentialsCommitted !== true) throw agentAuthCancelled();
        await broadcastFreshAgentSetupStatuses();
        sendAuthRunFrame(authRun, { type: 'pi-status', status: piStatus });
        void refreshOpenRouterCredits(true).then(() => {
          broadcastToStudios({ v: 1, type: 'usage-report', usage: usageSnapshot() });
        }).catch((refreshError) => {
          log(`post-auth pi credit refresh failed: ${refreshError?.message ?? refreshError}`);
        });
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end('<!doctype html><meta charset="utf-8"><title>Rauhwpx</title><style>body{font:16px system-ui;margin:48px;color:#202124}</style><h1>OpenRouter connected</h1><p>You can return to Rauhwpx and close this tab.</p>');
      } catch (error) {
        if (authRun.credentialsCommitted === true) {
          log(`post-auth pi status refresh failed: ${error?.message ?? error}`);
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          res.end('<!doctype html><meta charset="utf-8"><title>Rauhwpx</title><h1>OpenRouter connected</h1><p>You can return to Rauhwpx and close this tab.</p>');
          return;
        }
        if (error?.code !== 'OPENROUTER_OAUTH_INVALID') {
          sendAuthRunError(authRun, error, 'OPENROUTER_OAUTH_FAILED');
        }
        res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
        res.end('<!doctype html><meta charset="utf-8"><title>Rauhwpx</title><p>OpenRouter login could not be completed. Return to Rauhwpx and try again.</p>');
      }
      return;
    }
    if (req.method === 'POST' && url.pathname.startsWith('/sessions/')) {
      authenticateOwnerRequest(req, url);
      const sessionId = decodeURIComponent(url.pathname.slice('/sessions/'.length));
      const record = sessions.register(sessionId);
      sendHttpJson(res, 200, {
        status: 'registered',
        sessionId: record.sessionId,
        capabilities: {
          studio: sessions.issue(TOKEN, record.sessionId, {
            audience: HUB_CAPABILITY_AUDIENCES.STUDIO,
          }),
          mcp: sessions.issue(TOKEN, record.sessionId, {
            audience: HUB_CAPABILITY_AUDIENCES.MCP,
            ...(record.agentSession?.providerCapabilityResource
              ? { resource: record.agentSession.providerCapabilityResource }
              : {}),
          }),
          reference: sessions.issue(TOKEN, record.sessionId, {
            audience: HUB_CAPABILITY_AUDIENCES.REFERENCE,
          }),
          template: sessions.issue(TOKEN, record.sessionId, {
            audience: HUB_CAPABILITY_AUDIENCES.TEMPLATE,
          }),
        },
      });
      return;
    }
    if (req.method === 'DELETE' && url.pathname.startsWith('/sessions/')) {
      authenticateOwnerRequest(req, url);
      const sessionId = decodeURIComponent(url.pathname.slice('/sessions/'.length));
      const record = sessions.get(sessionId);
      if (!record) {
        sendHttpJson(res, 404, { status: 'not-found', sessionId });
        return;
      }
      sessions.delete(sessionId);
      authRuns.cancelForSession(sessionId, 'owner-session-closed');
      await disposeRecord(record, 'hub session closed');
      sendHttpJson(res, 200, { status: 'deleted', sessionId });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/shutdown') {
      authenticateOwnerRequest(req, url);
      const cleanupProven = await prepareShutdown('owner request');
      let scheduled = false;
      const finishShutdown = () => {
        if (scheduled) return;
        scheduled = true;
        setImmediate(() => {
          void shutdown('owner request').finally(() => process.exit(0));
        });
      };
      res.once('finish', finishShutdown);
      res.once('close', finishShutdown);
      sendHttpJson(res, cleanupProven ? 200 : 503, {
        status: cleanupProven ? 'prepared' : 'cleanup-unproven',
        launchId: LAUNCH_ID,
      });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/healthz') {
      const token = requestToken(req, url);
      const authenticated = !(DEVELOPMENT_AUTH && !token);
      if (authenticated) authenticateMasterToken(TOKEN, token);
      const origin = typeof req.headers.origin === 'string' ? req.headers.origin : null;
      const allowOrigin = origin && /^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d{1,5})?$/i.test(origin)
        ? origin
        : null;
      // 개발 모드 무인증 liveness 확인에도 상태를 노출하지 않는다 —
      // launchId·세션 요약·프로바이더 캐시는 인증된 응답에만 실린다.
      const body = authenticated ? healthzBody() : {
        ok: true,
        name: HUB_NAME,
        pid: process.pid,
        port: hubPort,
        uptimeMs: Date.now() - STARTED_AT,
        protocol: PROTOCOL_VERSION,
      };
      res.writeHead(200, {
        'content-type': 'application/json',
        'cache-control': 'no-store',
        ...(allowOrigin ? { 'access-control-allow-origin': allowOrigin, vary: 'Origin' } : {}),
      });
      res.end(JSON.stringify(body));
      return;
    }
    const piSubagentPath = /^\/pi\/subagents\/([^/]+)$/.exec(url.pathname);
    const piSubagentChildId = piSubagentPath
      ? decodeURIComponent(piSubagentPath[1])
      : null;
    if (req.method === 'POST' && piSubagentChildId) {
      const record = sessions.get(url.searchParams.get('sessionId'));
      const activeSession = record?.agentSession;
      if (!record || !activeSession?.providerCapabilityResource) {
        const error = new Error('active root provider identity required');
        error.code = 'UNAUTHORIZED_SESSION';
        throw error;
      }
      authenticateHttpSession(req, url, {
        audience: HUB_CAPABILITY_AUDIENCES.MCP,
        resource: activeSession.providerCapabilityResource,
      });
      const registration = record.piSubagents.register({
        activeSession,
        childId: piSubagentChildId,
        taskId: url.searchParams.get('taskId'),
        role: url.searchParams.get('role'),
        parentProfile: activeSession.planning.mcpEnvironment().RHWP_TOOL_PROFILE,
      });
      const token = sessions.issue(TOKEN, record.sessionId, {
        audience: HUB_CAPABILITY_AUDIENCES.MCP,
        resource: registration.resource,
        expiresAt: Date.now() + 4 * 60 * 60 * 1000,
      });
      sendHttpJson(res, 201, {
        childId: registration.childId,
        agentRole: registration.agentRole,
        profile: registration.profile,
        token,
      });
      return;
    }
    if (req.method === 'DELETE' && piSubagentChildId) {
      const record = sessions.get(url.searchParams.get('sessionId'));
      const registration = record?.piSubagents.get(piSubagentChildId);
      if (!record || !registration) {
        const error = new Error('active Pi subagent identity required');
        error.code = 'UNAUTHORIZED_SESSION';
        throw error;
      }
      authenticateHttpSession(req, url, {
        audience: HUB_CAPABILITY_AUDIENCES.MCP,
        resource: registration.resource,
      });
      const revoked = record.piSubagents.revoke(piSubagentChildId);
      if (revoked) retirePiSubagentRegistration(record, revoked);
      sendHttpJson(res, 200, { status: 'revoked', childId: registration.childId });
      return;
    }
    // pi extension requests a shared catalog with its signed session credential.
    if (req.method === 'GET' && url.pathname === '/pi/tool-definitions') {
      const candidateSession = sessions.get(url.searchParams.get('sessionId'));
      const requestedWorkerJobId = url.searchParams.get('workerJobId');
      const requestedSubagentId = url.searchParams.get('subagentId');
      const requestedAgentRole = url.searchParams.get('role') ?? 'chat';
      const workerJob = requestedWorkerJobId
        ? candidateSession?.templateJobs.get(requestedWorkerJobId)
        : null;
      const piSubagent = requestedSubagentId
        ? candidateSession?.piSubagents.get(requestedSubagentId)
        : null;
      let audience;
      let resource;
      let profile;
      if (requestedWorkerJobId) {
        if (
          !workerJob
          || workerJob.status !== 'running'
          || requestedAgentRole !== workerJob.workerRole
        ) {
          const error = new Error('copy-layout worker identity mismatch');
          error.code = 'UNAUTHORIZED_SESSION';
          throw error;
        }
        audience = HUB_CAPABILITY_AUDIENCES.COPY_LAYOUT_WORKER;
        resource = workerJob.jobId;
        profile = 'copy-layout-worker';
      } else if (requestedSubagentId) {
        if (
          !piSubagent
          || !candidateSession.piSubagents.isCurrent(piSubagent, candidateSession.agentSession)
          || requestedAgentRole !== piSubagent.agentRole
        ) {
          const error = new Error('Pi subagent identity mismatch');
          error.code = 'UNAUTHORIZED_SESSION';
          throw error;
        }
        audience = HUB_CAPABILITY_AUDIENCES.MCP;
        resource = piSubagent.resource;
        profile = piSubagent.catalogProfile;
      } else if (candidateSession?.agentSession?.providerCapabilityResource) {
        if (requestedAgentRole !== candidateSession.agentSession.providerRole) {
          const error = new Error('provider identity mismatch');
          error.code = 'UNAUTHORIZED_SESSION';
          throw error;
        }
        audience = HUB_CAPABILITY_AUDIENCES.MCP;
        resource = candidateSession.agentSession.providerCapabilityResource;
        profile = candidateSession.agentSession.planning.mcpEnvironment().RHWP_TOOL_PROFILE;
      } else {
        const error = new Error('no active provider session');
        error.code = 'UNAUTHORIZED_SESSION';
        throw error;
      }
      authenticateHttpSession(req, url, {
        audience,
        resource,
      });
      const authenticatedUrl = new URL(url);
      authenticatedUrl.searchParams.set('token', TOKEN);
      // Never trust a provider-supplied profile. The authenticated live
      // session/worker capability fixes the only catalog it may receive.
      authenticatedUrl.searchParams.set('profile', profile);
      const gates = projectToolGates();
      const workflow = candidateSession?.agentSession?.planning?.workflow;
      const { status, body } = handlePiToolDefinitions({
        url: authenticatedUrl,
        token: TOKEN,
        gates: {
          projectWrites: !(workflow === 'question' && gates.chatMayEdit === false),
          homeSearch: gates.homeSearch && !requestedWorkerJobId && !requestedSubagentId,
          requestable: !requestedWorkerJobId && !requestedSubagentId,
        },
      });
      sendHttpJson(res, status, body);
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  }).catch((error) => {
    const unauthorized = error?.code === 'UNAUTHORIZED' || error?.code === 'UNAUTHORIZED_SESSION';
    const invalidSession = error?.code === 'INVALID_SESSION_ID' || error instanceof URIError;
    const sessionLimitReached = error?.code === 'SESSION_LIMIT_REACHED';
    const invalidPiSubagent = [
      'INVALID_PI_SUBAGENT_ID',
      'INVALID_PI_SUBAGENT_TASK',
      'INVALID_PI_SUBAGENT_ROLE',
      'INVALID_PI_SUBAGENT_PROFILE',
    ].includes(error?.code);
    const piSubagentConflict = [
      'PI_SUBAGENT_EXISTS',
      'PI_SUBAGENT_ROOT_REQUIRED',
      'NO_ACTIVE_TURN',
    ].includes(error?.code);
    const piSubagentLimitReached = error?.code === 'PI_SUBAGENT_LIMIT_REACHED';
    if (unauthorized || invalidSession || sessionLimitReached || invalidPiSubagent
      || piSubagentConflict || piSubagentLimitReached) {
      const status = unauthorized
        ? 401
        : sessionLimitReached || piSubagentLimitReached
          ? 429
          : piSubagentConflict
            ? 409
            : 400;
      if (!res.headersSent) sendHttpJson(res, status, {
        status: 'error',
        error: {
          code: error?.code ?? 'INVALID_SESSION_ID',
          message: sessionLimitReached ? 'Too many hub sessions are registered.' : String(error.message),
        },
      });
      return;
    }
    log(`http request failed: ${error?.stack ?? error}`);
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
    if (!res.writableEnded) res.end(JSON.stringify({ status: 'error', message: 'Internal server error' }));
  });
});

// MCP provider frames stay tightly bounded. Studio additionally carries the
// 64 MiB document-snapshot payload as base64 (about 85.4 MiB on the wire), so
// it needs a separate authenticated transport budget.
const mcpWss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 });
const studioWss = new WebSocketServer({ noServer: true, maxPayload: 88 * 1024 * 1024 });
function rejectUpgrade(socket, status, message) {
  socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

httpServer.on('upgrade', (req, socket, head) => {
  if (shutdownPreparationPromise) {
    rejectUpgrade(socket, 503, 'Service Unavailable');
    return;
  }
  let url;
  try {
    url = new URL(req.url, `http://127.0.0.1:${hubPort || REQUESTED_PORT || 5175}`);
  } catch {
    rejectUpgrade(socket, 400, 'Bad Request');
    return;
  }
  const pathname = url.pathname;
  if (pathname !== '/studio' && pathname !== '/mcp') {
    rejectUpgrade(socket, 404, 'Not Found');
    return;
  }
  // Origin 검증은 개발 모드에서도 한다 — 브라우저는 교차 출처 WS 업그레이드에
  // 항상 Origin 을 실어 보내므로, 웹페이지발 드라이바이 연결을 여기서 끊는다.
  // 프로덕션은 허용된 Studio 출처를 요구하고(무-Origin 도 거부), 개발 모드는
  // 비브라우저 클라이언트(CLI, 테스트)를 위해 Origin 이 없는 연결만 통과시킨다.
  {
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : '';
    if (pathname === '/studio' && (PRODUCTION ? !isAllowedStudioOrigin(origin) : (origin && !isAllowedStudioOrigin(origin)))) {
      rejectUpgrade(socket, 403, 'Forbidden');
      return;
    }
    if (pathname === '/mcp' && origin) {
      rejectUpgrade(socket, 403, 'Forbidden');
      return;
    }
  }
  const token = url.searchParams.get('token') ?? '';
  const sessionId = url.searchParams.get('sessionId');
  const requestedAgentRole = url.searchParams.get('role') ?? 'chat';
  const requestedWorkerJobId = pathname === '/mcp'
    ? url.searchParams.get('workerJobId')
    : null;
  const requestedSubagentId = pathname === '/mcp'
    ? url.searchParams.get('subagentId')
    : null;
  const requestedAgent = pathname === '/mcp' ? url.searchParams.get('agent') : null;
  let record;
  let authenticatedWorkerJob = null;
  let authenticatedPiSubagent = null;
  let authenticatedProviderIdentity = null;
  try {
    const audience = pathname === '/studio'
      ? HUB_CAPABILITY_AUDIENCES.STUDIO
      : requestedWorkerJobId
        ? HUB_CAPABILITY_AUDIENCES.COPY_LAYOUT_WORKER
        : HUB_CAPABILITY_AUDIENCES.MCP;
    let providerCapabilityResource;
    if (pathname === '/mcp' && !requestedWorkerJobId) {
      const candidateRecord = sessions.get(sessionId);
      const activeSession = candidateRecord?.agentSession;
      if (!activeSession?.providerCapabilityResource) {
        throw new Error('active provider identity required');
      }
      if (requestedSubagentId) {
        const registration = candidateRecord.piSubagents.get(requestedSubagentId);
        if (!registration || !candidateRecord.piSubagents.isCurrent(registration, activeSession)) {
          throw new Error('active Pi subagent identity required');
        }
        providerCapabilityResource = registration.resource;
      } else {
        providerCapabilityResource = activeSession.providerCapabilityResource;
      }
    }
    const authenticatedSessionId = sessions.authenticate({
      masterToken: TOKEN,
      token,
      sessionId,
      audience,
      ...(requestedWorkerJobId
        ? { resource: requestedWorkerJobId }
        : providerCapabilityResource
          ? { resource: providerCapabilityResource }
          : {}),
      allowMaster: !PRODUCTION,
    });
    record = sessions.require(authenticatedSessionId);
    if (requestedWorkerJobId) {
      authenticatedWorkerJob = record.templateJobs.get(requestedWorkerJobId);
      if (
        !authenticatedWorkerJob
        || authenticatedWorkerJob.status !== 'running'
        || requestedAgentRole !== authenticatedWorkerJob.workerRole
      ) {
        throw new Error('copy-layout worker identity mismatch');
      }
    } else if (requestedAgentRole.startsWith('copy-layout-worker:')) {
      throw new Error('copy-layout worker capability required');
    } else if (pathname === '/mcp') {
      const activeSession = record.agentSession;
      if (requestedSubagentId) {
        const piSubagent = record.piSubagents.get(requestedSubagentId);
        if (
          !piSubagent
          || !record.piSubagents.isCurrent(piSubagent, activeSession)
          || piSubagent.resource !== providerCapabilityResource
          || requestedAgent !== piSubagent.agent
          || requestedAgentRole !== piSubagent.agentRole
        ) {
          throw new Error('Pi subagent identity mismatch');
        }
        authenticatedPiSubagent = piSubagent;
        authenticatedProviderIdentity = Object.freeze({
          agent: piSubagent.agent,
          role: piSubagent.agentRole,
          generation: piSubagent.providerGeneration,
        });
      } else {
        if (
          !activeSession
          || activeSession.providerCapabilityResource !== providerCapabilityResource
          || requestedAgent !== activeSession.agent
          || requestedAgentRole !== activeSession.providerRole
        ) {
          throw new Error('provider identity mismatch');
        }
        authenticatedProviderIdentity = Object.freeze({
          agent: activeSession.agent,
          role: activeSession.providerRole,
          generation: activeSession.generation,
        });
      }
    }
  } catch {
    rejectUpgrade(socket, 401, 'Unauthorized');
    return;
  }
  const wss = pathname === '/studio' ? studioWss : mcpWss;
  wss.handleUpgrade(req, socket, head, (ws) => {
    if (pathname === '/studio') {
      // 페이지 로드마다 새로 발급되는 인스턴스 id — 같으면 같은 페이지의 WS 끊김,
      // 다르면(또는 없으면) 새로고침·다른 탭이라 이전 호출은 답을 받을 수 없다.
      const instanceId = url.searchParams.get('instance');
      const previousInstanceId = record.studioInstanceId;
      const replacing = record.studioSocket !== null;
      record.studioInstanceId = instanceId;
      clearStudioReattachGrace(record);
      if (replacing) {
        studioFrames.flush(record.studioSocket);
        try { record.studioSocket.close(4000, 'replaced'); } catch {}
      }
      if (!instanceId || instanceId !== previousInstanceId) {
        failAllPendingCalls(record, replacing
          ? 'Studio connection was replaced by a new tab; the edit may still have applied — re-read with get_structure/get_text_range before retrying'
          : 'Studio reloaded while tool calls were in flight; the edit may still have applied — re-read with get_structure/get_text_range before retrying');
      } else {
        armStudioReattachFlush(record);
      }
      record.studioSocket = ws;
      attachSocket(record, ws, 'studio');
      // 소켓이 닫혔다고 곧바로 인플라이트 호출을 접지 않는다 — 스튜디오는 보통 250ms 안에
      // 같은 세션으로 돌아온다. 대신 유예 타이머를 걸어 돌아오지 않는 경우만 실패시킨다.
      ws.on('close', () => {
        studioFrames.discard(ws);
        if (record.studioSocket === ws) {
          record.studioSocket = null;
          record.pendingReferenceMessage = null;
          rejectPendingUserMessages(record, 'REQUEST_INVALIDATED', 'Studio disconnected before accepting the message', { socket: ws });
          armStudioReattachGrace(record);
        }
      });
      // welcome이 유휴 세션 fallback을 만들기 전에 권위 있는 최종 결과를 먼저 보낸다.
      // 전송 실패 시 다음 재연결에서 다시 시도할 수 있도록 결과를 보존한다.
      if (record.agentSession?.planning.execution) {
        // Checklist updates may have happened while Studio was disconnected.
        // Its terminal handler must see that state before settling document edits.
        sendJson(ws, { v: 1, type: 'plan-progress', ...record.agentSession.planning.snapshot() });
      }
      replayMissedTurnEnd(record, ws, sendJson);
      sendJson(ws, {
        v: 1,
        type: 'welcome',
        protocol: PROTOCOL_VERSION,
        launchId: LAUNCH_ID,
        hubSessionId: record.sessionId,
        session: sessionInfo(record),
      });
      for (const authRun of authRuns.forSession(record.sessionId)) {
        sendJson(ws, {
          v: 1,
          type: 'agent-setup-progress',
          state: 'authorizing',
          replayed: true,
          ...authRun,
        });
      }
      sendJson(ws, {
        v: 1,
        type: 'agent-instructions',
        status: agentInstructionsStore.snapshot(),
        changedBy: 'system',
      });
      sendInstructionDraft(record, ws);
      const activeSession = record.agentSession;
      if (activeSession?.planning.latestPlan && activeSession.planning.phase === 'awaiting-approval') {
        sendJson(ws, {
          v: 1,
          type: 'plan-ready',
          planId: activeSession.planning.latestPlan.planId,
          plan: structuredClone(activeSession.planning.latestPlan.plan),
          ...activeSession.planning.snapshot(),
        });
      }
      const pendingUserQuestion = pendingUserQuestionSnapshot(record);
      if (pendingUserQuestion) {
        sendJson(ws, {
          v: 1,
          type: 'user-question-requested',
          interaction: pendingUserQuestion,
          replayed: true,
        });
      }
      const pendingChatPermissionRequest = pendingChatPermissionSnapshot(record);
      if (pendingChatPermissionRequest) sendJson(ws, {
        v: 1, type: 'chat-permission-requested', request: pendingChatPermissionRequest, replayed: true,
      });
      void skillRegistry.catalog()
        .then((catalog) => sendJson(ws, { v: 1, type: 'skills-catalog', catalog }))
        .catch((e) => log(`skills catalog on connect failed: ${e?.message ?? e}`));
      void writingStyleStore.status()
        .then((status) => sendJson(ws, { v: 1, type: 'writing-style-status', status }))
        .catch((e) => sendJson(ws, {
          v: 1, type: 'writing-style-error', code: e?.code ?? 'STYLE_STATUS_FAILED', message: String(e?.message ?? e),
        }));
      const calibration = record.styleCalibration;
      if (calibration) {
        sendJson(ws, calibration.progress ?? {
          v: 1, type: 'writing-style-progress',
          requestId: calibration.requestId, jobId: calibration.jobId,
          startedAt: calibration.startedAt, agent: calibration.agent, model: calibration.model,
          state: 'preparing', phase: 'preparing', activity: 'collecting-samples',
          detail: 'Preparing writing samples', completed: 0, total: 1,
        });
      }
      for (const job of record.templateJobs.values()) {
        if (job.status === 'running') {
          sendTemplateJobEvent(record, {
            type: 'task-start', agent: job.agent, taskId: job.jobId,
            title: '레이아웃 템플릿 자동 완성',
            taskKind: 'agent', background: true,
          });
          sendTemplateJobEvent(record, taskProgressForJob(job, job.activity));
        }
      }
      const cachedProviders = providerHealth.cached();
      if (cachedProviders) sendJson(ws, { v: 1, type: 'provider-status', providers: cachedProviders });
      void providerHealth.check().then((providers) => {
        if (providers !== cachedProviders) replyToStudio(record, ws, { v: 1, type: 'provider-status', providers });
      }).catch((e) => log(`provider health on connect failed: ${e?.message ?? e}`));
      sendJson(ws, { v: 1, type: 'pi-status', status: piStatus });
      void agentSetupStatuses(record.sessionId).then((statuses) => {
        replyToStudio(record, ws, { v: 1, type: 'agent-setup-status', statuses });
      }).catch((e) => log(`agent setup status on connect failed: ${e?.message ?? e}`));
      sendJson(ws, { v: 1, type: 'writing-style-catalog', ...writingStyleCatalog(record) });
      sendJson(ws, { v: 1, type: 'templates-catalog', ...templateStore.list() });
      sendJson(ws, { v: 1, type: 'usage-report', usage: usageSnapshot() });
      if (piStatus.keyConfigured && !openRouterCredits) {
        void refreshOpenRouterCredits(false)
          .then(() => replyToStudio(record, ws, { v: 1, type: 'usage-report', usage: usageSnapshot() }));
      }
      log(`studio connected (session=${record.sessionId})`);
      return;
    }

    const agentLabel = authenticatedWorkerJob?.agent ?? authenticatedProviderIdentity.agent;
    ws.agentLabel = agentLabel;
    ws.agentRole = authenticatedWorkerJob?.workerRole ?? authenticatedProviderIdentity.role;
    ws.agentGeneration = authenticatedWorkerJob ? null : authenticatedProviderIdentity.generation;
    const activeProviderSession = authenticatedWorkerJob ? null : record.agentSession;
    const providerIdentityCurrent = authenticatedPiSubagent
      ? record.piSubagents.isCurrent(authenticatedPiSubagent, activeProviderSession)
      : activeProviderSession?.providerRole === ws.agentRole;
    const providerTurnId = activeProviderSession
      && activeProviderSession.generation === ws.agentGeneration
      && activeProviderSession.agent === ws.agentLabel
      && providerIdentityCurrent
      && activeProviderSession.status === 'running'
      && activeProviderSession.providerTurnStarted === true
      && activeProviderSession.turnId
      ? activeProviderSession.turnId
      : null;
    // A root MCP socket is born into exactly one provider turn. Never promote
    // a connection that arrived while idle/queued: it may belong to a stale
    // descendant from the process tree that just settled.
    ws.agentTurnId = authenticatedWorkerJob ? null : providerTurnId;
    ws.providerTurnRetired = authenticatedWorkerJob ? false : providerTurnId === null;
    ws.copyLayoutJobId = authenticatedWorkerJob?.jobId ?? null;
    ws.piSubagentId = authenticatedPiSubagent?.childId ?? null;
    ws.parentTaskId = authenticatedPiSubagent?.taskId ?? null;
    ws.toolProfile = authenticatedPiSubagent?.profile ?? null;
    ws.workflow = url.searchParams.get('workflow');
    ws.capabilityEpoch = url.searchParams.get('capabilityEpoch');
    // mcp-stdio 는 자신의 maxPayload 를 알린다. 알리지 않는 클라이언트(Pi 확장 등)는 제한 없음.
    const advertisedMaxPayload = Number(url.searchParams.get('maxPayload'));
    ws.maxResultFrameBytes = Number.isSafeInteger(advertisedMaxPayload) && advertisedMaxPayload > 0
      ? advertisedMaxPayload
      : null;
    record.mcpSockets.add(ws);
    attachSocket(record, ws, 'mcp');
    if (!authenticatedWorkerJob && ws.providerTurnRetired) {
      queueMicrotask(() => {
        try { ws.close(4003, 'provider tool connection outside active turn'); } catch {}
      });
    }
    ws.on('close', () => {
      record.mcpSockets.delete(ws);
      if (record.pendingUserQuestion?.mcpSocket === ws) {
        settleUserQuestion(record, { status: 'expired', reason: 'provider-disconnected' });
      }
      for (const [hubId, entry] of record.pendingCalls) {
        if (entry.mcpSocket === ws) {
          clearTimeout(entry.timer);
          record.pendingCalls.delete(hubId);
          cancelStudioToolRequest(record, hubId, entry, 'provider-disconnected');
          // 타임아웃 해제 경로도 함께 취소됐으니 스냅샷 점유를 여기서 풀어야 재시도가 막히지 않는다.
          if (entry.tool === 'materialize_document_snapshot' && entry.copyLayoutJobId) {
            releaseCopyLayoutSnapshot(record.templateJobs.get(entry.copyLayoutJobId));
          }
        }
      }
      log(`mcp client disconnected (agent=${agentLabel}, session=${record.sessionId})`);
    });
    log(`mcp client connected (agent=${agentLabel}, session=${record.sessionId})`);
  });
});

httpServer.listen(REQUESTED_PORT, '127.0.0.1', () => {
  const address = httpServer.address();
  if (!address || typeof address === 'string') throw new Error('Hub did not receive a TCP port');
  hubPort = address.port;
  process.stdout.write(`RHWP_HUB_READY ${JSON.stringify({ port: hubPort, pid: process.pid, launchId: LAUNCH_ID })}\n`);
  log(`rhwp-agent hub listening on ws://127.0.0.1:${hubPort} (protocol v${PROTOCOL_VERSION})`);
  log('claude/codex/pi can be installed and authenticated from Studio settings');
  if (TOOL_TRACE_PATH) log(`tool trace enabled: ${TOOL_TRACE_PATH}`);
  void ensureBootWork();
  scheduleHarnessUpdates(HARNESS_UPDATE_INITIAL_DELAY_MS);
});

httpServer.on('error', (err) => {
  log(`server error: ${err?.message ?? err}`);
  process.exitCode = 1;
});

let shutdownPreparationPromise = null;
let shutdownPromise = null;
let launchCleanupRetentionRequired = false;

function retainUncertainProcessCleanup(recordRoot) {
  launchCleanupRetentionRequired = true;
  try {
    retainLaunchRootForProcessCleanupSync(WORK_ROOT, { launchId: LAUNCH_ID });
  } catch (error) {
    log(`failed to persist process cleanup retention marker: ${error?.message ?? error}`);
  }
  log(`retaining session root after uncertain process cleanup: ${recordRoot}`);
}

async function disposeRecord(record, reason) {
  record.disposed = true;
  authRuns.cancelForSession(record.sessionId, reason);
  cancelCheckpointTitleJobs(record);
  if (record.pendingInstructionDraft?.expiryTimer) {
    clearTimeout(record.pendingInstructionDraft.expiryTimer);
  }
  record.pendingInstructionDraft = null;
  clearStudioReattachGrace(record);
  clearStudioReattachFlush(record);
  settleUserQuestion(record, { status: 'expired', reason: 'hub-restarted' });
  failAllPendingCalls(record, 'Hub session is shutting down');
  const backendExit = disposeSession(record);
  const templateBackendExits = [];
  for (const job of record.templateJobs.values()) {
    if (job.status === 'running') {
      job.status = 'failed';
      job.activity = reason;
    }
    const backend = job.backend;
    job.backend = null;
    if (!backend) continue;
    try {
      templateBackendExits.push(Promise.resolve(backend.dispose()).catch((error) => {
        log(`copy-layout worker exit wait failed: ${error?.message ?? error}`);
        return false;
      }));
    } catch (error) {
      log(`copy-layout worker dispose failed: ${error?.message ?? error}`);
      templateBackendExits.push(Promise.resolve(false));
    }
  }
  for (const sock of [record.studioSocket, ...record.mcpSockets]) {
    if (sock) studioFrames.flush(sock);
    try { sock?.close(1001, reason); } catch {}
  }
  record.mcpSockets.clear();
  record.studioSocket = null;
  const cleanupResults = await Promise.allSettled([
    backendExit,
    ...templateBackendExits,
    stopAuxiliaryProcesses(record),
    record.browserbaseSession.cleanup(reason),
    record.documentSnapshotManager.drain(),
  ]);
  let processCleanupSettled = record.processCleanupUncertain !== true;
  for (const result of cleanupResults) {
    if (result.status === 'rejected') {
      processCleanupSettled = false;
      log(`session cleanup failed: ${result.reason?.message ?? result.reason}`);
    } else if (result.value === false) {
      processCleanupSettled = false;
    }
  }
  if (!processCleanupSettled) {
    retainUncertainProcessCleanup(record.recordRoot);
    return false;
  }
  let credentialCopiesSettled = flushProviderCredentialHomes(record);
  for (const job of record.templateJobs.values()) {
    if (!flushProviderCredentialHomes(job.providerHomes)) credentialCopiesSettled = false;
  }
  // Another live record may own a WORK_ROOT journal. It must retain the launch
  // root at shutdown, but must not pin this already-flushed record (including
  // its hub-private downloads and snapshots).
  if (!credentialCopiesSettled || hasPendingCredentialCopybackSync(record.recordRoot)) {
    log(`retaining session root for pending credential copyback: ${record.recordRoot}`);
    return false;
  }
  await fs.rm(record.recordRoot, { recursive: true, force: true });
  return true;
}

function prepareShutdown(signal) {
  if (shutdownPreparationPromise) return shutdownPreparationPromise;
  shutdownPreparationPromise = (async () => {
    clearInterval(stagedReferenceCleanupTimer);
    clearInterval(projectTrashTimer);
    for (const timer of projectChangeTimers.values()) clearTimeout(timer);
    projectChangeTimers.clear();
    projectLibrarian.cancelAll();
    if (harnessUpdateTimer) clearTimeout(harnessUpdateTimer);
    if (ownerWatchdog) clearInterval(ownerWatchdog);
    log(`shutting down (${signal})`);
    const cleanupProven = await sessions.disposeAll(
      (record) => disposeRecord(record, 'hub shutdown'),
    );
    if (!cleanupProven) retainUncertainProcessCleanup(WORK_ROOT);
    for (const wss of [studioWss, mcpWss]) {
      for (const sock of wss.clients) {
        try { sock.close(1001, 'server shutting down'); } catch {}
      }
    }
    return cleanupProven;
  })();
  return shutdownPreparationPromise;
}

function shutdown(signal) {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    await prepareShutdown(signal);
    if (httpServer.listening) await new Promise((resolve) => httpServer.close(resolve));
    const ownedRoots = [
      process.env.RHWP_OWN_WORK_DIR === '1' ? WORK_ROOT : null,
      process.env.RHWP_OWN_RUNTIME_DIR === '1' ? RUNTIME_ROOT : null,
    ].filter(Boolean);
    await Promise.all(ownedRoots.map(async (root) => {
      if (root === WORK_ROOT
        && (launchCleanupRetentionRequired || hasPendingLaunchCleanupSync(root))) {
        log(`retaining owned work root for pending cleanup: ${root}`);
        return;
      }
      await fs.rm(root, { recursive: true, force: true });
    }));
  })();
  return shutdownPromise;
}

const ownerPid = Number(process.env.RHWP_OWNER_PID);
let ownerMissing = false;
let ownerMissingSince = null;
let orphanIdleSince = null;
function noteMissingOwner(reason = `owner process ${ownerPid} exited`) {
  if (!ownerMissing) {
    log(`${reason}; waiting for orphaned work to become idle`);
    ownerMissingSince = Date.now();
  }
  ownerMissing = true;
}
if (process.env.RHWP_OWNER_IPC === '1') {
  if (process.connected) {
    process.once('disconnect', () => noteMissingOwner('owner IPC channel closed'));
  } else {
    noteMissingOwner('required owner IPC channel was unavailable');
  }
}
const ownerWatchdog = Number.isSafeInteger(ownerPid) && ownerPid > 0
  ? setInterval(() => {
    if (!ownerMissing) {
      let alive = true;
      try {
        process.kill(ownerPid, 0);
      } catch (error) {
        if (error?.code !== 'EPERM') alive = false;
      }
      if (alive) return;
      noteMissingOwner();
    }
    if (Date.now() - ownerMissingSince >= ORPHAN_HARD_SHUTDOWN_MS) {
      void shutdown('owner exited and orphan deadline elapsed').finally(() => process.exit(0));
      return;
    }
    if (hasConnectedSessionSockets() || hasOrphanActiveWork()) {
      orphanIdleSince = null;
      return;
    }
    orphanIdleSince ??= Date.now();
    if (Date.now() - orphanIdleSince >= ORPHAN_IDLE_SHUTDOWN_MS) {
      void shutdown('owner exited and hub stayed idle').finally(() => process.exit(0));
    }
  }, 1_000)
  : null;
ownerWatchdog?.unref?.();

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => { void shutdown(signal).finally(() => process.exit(0)); });
}
