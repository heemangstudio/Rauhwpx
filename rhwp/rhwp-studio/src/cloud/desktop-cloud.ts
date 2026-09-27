import { cloudErrorCodeText } from './session-copy.ts';
import type { RhwpDesktopApi } from '../desktop-integration.ts';
import type { AgentName } from '../agent/types.ts';
import { browserCloudSupported, createBrowserCloudApi } from './browser-cloud.ts';
import {
  clientUnsupportedDisplay,
  parseCloudDisplayCapability,
  parseCloudDisplayEvent,
} from './display.ts';
import { parseCloudTimeline } from './timeline.ts';
import { recordCloudUsage } from './usage-history.ts';
import type {
  CloudCommandRequest,
  CloudConversationWait,
  CloudCheckpointPayload,
  CloudDocumentPayload,
  CloudDownloadResult,
  CloudConnectionState,
  CloudDisplayCapability,
  CloudDisplayConnection,
  CloudDisplayEvent,
  CloudDisplayInputEvent,
  CloudProfileDraft,
  CloudProfileState,
  CloudSandboxSummary,
  CloudServerMode,
  CloudServerState,
  CloudSessionBase,
  CloudSessionState,
  CloudSnapshot,
  CloudTransferRequest,
  CloudSessionScope,
  CloudTransferIntentRequest,
  CloudTransferReference,
  CloudTakeoverPayload,
  CloudResultAction,
  CloudResultResolution,
  AccountSnapshot,
  BoatAccountSnapshot,
  BoatLinkKind,
  BoatMachine,
  BoatServerSnapshot,
  BoatSetupProgress,
  BoatSignInChallenge,
  BoatSignInPoll,
  BoatSnapshot,
  BoatWakeStage,
  CloudHostKeyInspection,
  CloudLinkReason,
  CloudLinkState,
} from './types.ts';

const SANDBOX_LIFECYCLES = ['idle', 'provisioning', 'ready', 'error', 'tearing-down'] as const;
const BOAT_WAKE_STAGES: readonly BoatWakeStage[] = ['starting', 'service', 'connecting'];
const LINK_REASONS: readonly CloudLinkReason[] = ['network', 'pairing', 'boat-auth', 'host-key', 'server', 'session-missing'];
const CLOUD_AGENTS: readonly AgentName[] = ['claude', 'codex', 'pi'];
/** 이 중 하나라도 없는 데스크톱은 boat 설정을 끝까지 진행할 수 없다. */
const BOAT_REQUIRED_METHODS = [
  'cloudBoatStartEmailSignIn', 'cloudBoatPollSignIn', 'cloudBoatConnectApiKey', 'cloudBoatOpenLink',
  'cloudBoatSetup', 'cloudBoatWake', 'cloudBoatStop', 'cloudBoatRefresh', 'cloudBoatDisconnect',
] as const;

export interface CloudDesktopApi {
  cloudGetState?: (payload: CloudSessionScope) => Promise<unknown>;
  cloudSaveProfile?: (payload: { profile: CloudProfileDraft }) => Promise<unknown>;
  cloudTestProfile?: (payload: { profile?: CloudProfileDraft }) => Promise<unknown>;
  cloudProvision?: (payload: {
    installChannel: 'stable' | 'prerelease';
    profile?: CloudProfileDraft;
  }) => Promise<unknown>;
  cloudPair?: (payload: { code: string; profile?: CloudProfileDraft }) => Promise<unknown>;
  cloudSelectServerMode?: (payload: { mode: CloudServerMode }) => Promise<unknown>;
  cloudSpawnSandbox?: (payload: { providerId?: string; selectedProvider?: AgentName }) => Promise<unknown>;
  cloudSandboxStatus?: () => Promise<unknown>;
  cloudTeardownSandbox?: (payload: { force?: boolean }) => Promise<unknown>;
  cloudForceQuitAccount?: () => Promise<unknown>;
  /** explicit 은 사용자가 누른 다시 연결이다. 데스크톱은 이때만 쉬던 boat VM 을 깨운다. 예전 데스크톱은 인자를 무시한다. */
  cloudReconnectLink?: (payload?: { explicit?: boolean }) => Promise<unknown>;
  cloudRecreateLink?: () => Promise<unknown>;
  cloudRestartService?: () => Promise<unknown>;
  cloudInspectHostKey?: () => Promise<unknown>;
  cloudTrustHostKey?: (payload: { fingerprint: string }) => Promise<unknown>;
  cloudReimportLogins?: (payload: { provider?: AgentName }) => Promise<unknown>;
  cloudDiscardMissingSessions?: () => Promise<unknown>;
  cloudTakeoverSandbox?: () => Promise<unknown>;
  cloudTransfer?: (payload: CloudTransferRequest) => Promise<unknown>;
  cloudSetTransferIntent?: (payload: CloudTransferIntentRequest) => Promise<unknown>;
  cloudReadReference?: (payload: Pick<CloudTransferReference, 'id' | 'scope' | 'scopeId'>) => Promise<unknown>;
  cloudCommand?: (payload: CloudCommandRequest) => Promise<unknown>;
  cloudDismissSession?: (payload: { sessionId: string }) => Promise<unknown>;
  cloudCompleteTakeover?: (payload: { sessionId: string; operationId: string }) => Promise<unknown>;
  cloudDownloadResult?: (payload: { sessionId: string }) => Promise<unknown>;
  /** explicit 은 사용자가 누른 동작이다. 데스크톱은 이때만 쉬던 boat VM 을 깨운다. 예전 데스크톱은 무시한다. */
  cloudDownloadCheckpoint?: (payload: {
    sessionId: string; operationId?: string; kind?: 'turn'; explicit?: boolean;
  }) => Promise<unknown>;
  cloudPrepareRestartDocument?: (payload: { sessionId: string }) => Promise<unknown>;
  cloudPublishCheckpoint?: (payload: { sessionId: string; operationId?: string }) => Promise<unknown>;
  cloudOpenDisplay?: (payload: { sessionId: string }) => Promise<unknown>;
  cloudCloseDisplay?: (payload: { connectionId: string }) => Promise<unknown>;
  cloudDisplayInput?: (payload: { connectionId: string; event: CloudDisplayInputEvent }) => Promise<unknown>;
  cloudResolveResult?: (payload: { sessionId: string; action: CloudResultAction }) => Promise<unknown>;
  cloudBeginEdit?: (payload: { sessionId: string }) => Promise<unknown>;
  cloudContinueEdit?: (payload: {
    sessionId: string;
    editSessionId: string;
    changeSummary?: string;
  }) => Promise<unknown>;
  cloudBoatStartEmailSignIn?: (payload: { email: string }) => Promise<unknown>;
  cloudBoatPollSignIn?: (payload: { claimId: string }) => Promise<unknown>;
  cloudBoatConnectApiKey?: (payload: { apiKey: string }) => Promise<unknown>;
  cloudBoatOpenLink?: (payload: { kind: BoatLinkKind; claimId?: string }) => Promise<unknown>;
  cloudBoatSetup?: (payload: { machine: BoatMachine }) => Promise<unknown>;
  cloudBoatWake?: () => Promise<unknown>;
  cloudBoatStop?: () => Promise<unknown>;
  cloudBoatRefresh?: () => Promise<unknown>;
  cloudBoatDisconnect?: (payload: { deleteServer: boolean }) => Promise<unknown>;
  onCloudEvent?: (callback: (event: unknown) => void) => (() => void) | void;
  onCloudDisplayEvent?: (callback: (event: unknown) => void) => (() => void) | void;
}

export type CloudAwareDesktopApi = RhwpDesktopApi & CloudDesktopApi;

export interface CloudController {
  getSnapshot(): CloudSnapshot;
  refresh(scope: CloudSessionScope): Promise<CloudSnapshot>;
  saveProfile(profile: CloudProfileDraft): Promise<CloudSnapshot>;
  testProfile(profile?: CloudProfileDraft): Promise<CloudSnapshot>;
  provision(installChannel?: 'stable' | 'prerelease', profile?: CloudProfileDraft): Promise<CloudSnapshot>;
  pair(code: string, profile?: CloudProfileDraft): Promise<CloudSnapshot>;
  selectServerMode(mode: CloudServerMode): Promise<CloudSnapshot>;
  spawnSandbox(providerId?: string, selectedProvider?: AgentName): Promise<CloudSnapshot>;
  sandboxStatus(): Promise<CloudSnapshot>;
  teardownSandbox(options?: { force?: boolean }): Promise<CloudSnapshot>;
  forceQuitAccount(): Promise<CloudSnapshot>;
  /** 사용자가 누른 다시 연결만 explicit 을 넘긴다. 자동 재연결은 쉬던 boat VM 을 깨우지 않는다. */
  reconnectLink(options?: { explicit?: boolean }): Promise<CloudSnapshot>;
  recreateLink(): Promise<CloudSnapshot>;
  /** 내 서버·boat 의 Cloud 서비스를 다시 시작한다. 이 기능이 없는 데스크톱이면 false 다. */
  canRestartService(): boolean;
  /** 이 기기의 제공자 로그인을 서버로 다시 보낼 수 있는가(데스크톱만). */
  canReimportLogins(): boolean;
  restartService(): Promise<CloudSnapshot>;
  inspectHostKey(): Promise<CloudHostKeyInspection>;
  trustHostKey(fingerprint: string): Promise<CloudSnapshot>;
  /** 이 Mac 의 제공자 로그인을 서버로 다시 보낸다. provider 가 없으면 모두 보낸다. */
  reimportLogins(provider?: AgentName): Promise<CloudSnapshot>;
  discardMissingSessions(): Promise<CloudSnapshot>;
  takeoverSandbox(): Promise<CloudSnapshot>;
  transfer(request: CloudTransferRequest): Promise<CloudSnapshot>;
  setTransferIntent(request: CloudTransferIntentRequest): Promise<CloudSnapshot>;
  readReference(reference: Pick<CloudTransferReference, 'id' | 'scope' | 'scopeId'>): Promise<Uint8Array>;
  command(request: CloudCommandRequest): Promise<CloudSnapshot>;
  dismissSession(sessionId: string): Promise<CloudSnapshot>;
  completeTakeover(sessionId: string, operationId: string): Promise<CloudSnapshot>;
  downloadResult(sessionId: string): Promise<CloudDownloadResult>;
  /**
   * 사용자가 누른 병합·사본 저장·알림 열기만 explicit 을 넘긴다. 미러의 자동 조회는 넘기지 않고,
   * 쉬는 boat VM 은 `BOAT_SERVER_STOPPED` 로 조용히 거절된다.
   */
  downloadCheckpoint(
    sessionId: string,
    operationId?: string,
    kind?: 'turn',
    options?: { explicit?: boolean },
  ): Promise<CloudCheckpointPayload>;
  prepareRestartDocument(sessionId: string): Promise<CloudDocumentPayload>;
  publishCheckpoint(sessionId: string, operationId?: string): Promise<CloudCheckpointPayload>;
  openDisplay(sessionId: string, listener: (event: CloudDisplayEvent) => void): Promise<CloudDisplayConnection>;
  resolveResult(sessionId: string, action: CloudResultAction): Promise<CloudResultResolution>;
  beginEdit(sessionId: string): Promise<CloudEditDraftSession>;
  continueEdit(sessionId: string, editSessionId: string, changeSummary?: string): Promise<CloudSnapshot>;
  /** boat 설정에 필요한 메서드를 모두 가진 데스크톱인지. 없으면 boat 선택지를 숨긴다. */
  boatSupported(): boolean;
  boatStartEmailSignIn(email: string): Promise<BoatSignInChallenge>;
  boatPollSignIn(claimId: string): Promise<BoatSignInPoll>;
  boatConnectApiKey(apiKey: string): Promise<CloudSnapshot>;
  boatOpenLink(kind: BoatLinkKind, claimId?: string): Promise<boolean>;
  boatSetup(machine: BoatMachine): Promise<CloudSnapshot>;
  boatWake(): Promise<CloudSnapshot>;
  boatStop(): Promise<CloudSnapshot>;
  boatRefresh(): Promise<CloudSnapshot>;
  boatDisconnect(deleteServer: boolean): Promise<CloudSnapshot>;
  subscribe(listener: (snapshot: CloudSnapshot) => void): () => void;
  subscribeEvents(listener: (event: unknown) => void): () => void;
  dispose(): void;
}

export interface CloudEditDraftSession {
  sessionId: string;
  editSessionId: string;
  boundary: { operationId: string; revision: number; writerGeneration: number; stateVersion: number };
  fileName: string;
  savedAt: string;
}

const ISO_FALLBACK = '1970-01-01T00:00:00.000Z';

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function string(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function nonNegative(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function integer(value: unknown, fallback = 0): number {
  const parsed = nonNegative(value, fallback);
  return Number.isSafeInteger(parsed) ? parsed : fallback;
}

function strictInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function strictIso(value: unknown): string | null {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
}

function iso(value: unknown, fallback = ISO_FALLBACK): string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : fallback;
}

function parseProfileDraft(value: unknown): CloudProfileDraft | null {
  const profile = record(value);
  const auth = record(profile?.auth);
  const transport = record(profile?.transport);
  if (!profile || !auth || !transport) return null;
  const host = string(profile.host).trim();
  const sshUser = string(profile.sshUser).trim();
  const name = string(profile.name).trim();
  const sshPort = integer(profile.sshPort, 22);
  const tailscaleHttpsPort = profile.tailscaleHttpsPort === undefined
    ? 443
    : strictInteger(profile.tailscaleHttpsPort);
  if (!name || !host || !sshUser || sshPort < 1 || sshPort > 65535
    || tailscaleHttpsPort === null || tailscaleHttpsPort < 1 || tailscaleHttpsPort > 65535) return null;
  const parsedAuth = auth.kind === 'ssh-agent'
    ? { kind: 'ssh-agent' as const }
    : auth.kind === 'key-file' && string(auth.keyPath).trim()
      ? { kind: 'key-file' as const, keyPath: string(auth.keyPath).trim() }
      : null;
  const parsedTransport = transport.kind === 'tailscale'
    ? { kind: 'tailscale' as const }
    : transport.kind === 'ssh-tunnel'
      ? { kind: 'ssh-tunnel' as const }
    : transport.kind === 'https' && string(transport.endpoint).trim()
      ? { kind: 'https' as const, endpoint: string(transport.endpoint).trim() }
      : null;
  if (!parsedAuth || !parsedTransport) return null;
  const serverPublicKey = string(profile.serverPublicKey).trim();
  if (serverPublicKey && !/^ed25519:[A-Za-z0-9_-]{59}$/.test(serverPublicKey)) return null;
  const boatRaw = record(profile.boat);
  const boatSandboxId = string(boatRaw?.sandboxId).trim();
  const boat = boatRaw && boatSandboxId && boatSandboxId.length <= 64
    ? { sandboxId: boatSandboxId, machine: boatRaw.machine === 'small' ? 'small' as const : 'default' as const }
    : null;
  return {
    name, host, sshUser, sshPort, tailscaleHttpsPort, auth: parsedAuth, transport: parsedTransport,
    ...(serverPublicKey ? { serverPublicKey } : {}),
    ...(boat ? { boat } : {}),
  };
}

function parseSandboxSummary(value: unknown): CloudSandboxSummary | null {
  const sandbox = record(value);
  if (!sandbox) return null;
  const providerId = string(sandbox.providerId).trim();
  const sandboxId = string(sandbox.sandboxId).trim();
  const createdAt = strictIso(sandbox.createdAt);
  if (!providerId || !sandboxId || !createdAt) return null;
  return {
    providerId,
    sandboxId,
    displayName: string(sandbox.displayName).trim() || providerId,
    region: string(sandbox.region).trim(),
    host: string(sandbox.host).trim(),
    createdAt,
  };
}

function parseServerMode(value: unknown): CloudServerMode | null {
  return value === 'self-hosted' || value === 'app-hosted' ? value : null;
}

function parseProfile(value: unknown): CloudProfileState | null {
  const state = record(value);
  if (!state) return null;
  if (state.kind === 'unconfigured') return { kind: 'unconfigured' };
  if (state.kind !== 'configured') return null;
  const connection: CloudConnectionState | null = state.connection === 'testing' || state.connection === 'ready'
    || state.connection === 'error' || state.connection === 'unknown'
    ? state.connection
    : null;
  if (!connection
    || (state.serviceVersion !== null && typeof state.serviceVersion !== 'string')
    || (state.message !== null && typeof state.message !== 'string')) return null;
  const shared = {
    kind: 'configured' as const,
    connection,
    serviceVersion: typeof state.serviceVersion === 'string' ? state.serviceVersion : null,
    message: typeof state.message === 'string' ? state.message : null,
  };
  if (state.mode === 'app-hosted') {
    const sandbox = parseSandboxSummary(state.sandbox);
    const name = string(state.name).trim();
    return sandbox && name ? { ...shared, mode: 'app-hosted', name, sandbox } : null;
  }
  const profile = parseProfileDraft(state.profile);
  if (!profile || (state.mode !== undefined && state.mode !== 'self-hosted')) return null;
  return { ...shared, mode: 'self-hosted', profile };
}

function parseServer(value: unknown, profile: CloudProfileState): CloudServerState | null {
  const fallbackMode = profile.kind === 'configured' ? profile.mode : null;
  if (value === undefined) {
    return { mode: fallbackMode, preferredMode: null, providers: [], lifecycle: 'idle', message: null };
  }
  const server = record(value);
  if (!server || !Array.isArray(server.providers)) return null;
  const lifecycle = SANDBOX_LIFECYCLES.find((entry) => entry === server.lifecycle);
  if (!lifecycle || (server.message !== null && typeof server.message !== 'string')) return null;
  const providers = server.providers.flatMap((entry) => {
    const provider = record(entry);
    const providerId = string(provider?.providerId).trim();
    if (!provider || !providerId || typeof provider.configured !== 'boolean'
      || !Array.isArray(provider.missingConfig)) return [];
    return [{
      providerId,
      displayName: string(provider.displayName).trim() || providerId,
      configured: provider.configured,
      missingConfig: provider.missingConfig.filter((item): item is string => typeof item === 'string'),
    }];
  });
  if (providers.length !== server.providers.length) return null;
  return {
    mode: parseServerMode(server.mode) ?? fallbackMode,
    preferredMode: parseServerMode(server.preferredMode),
    providers,
    lifecycle,
    message: typeof server.message === 'string' ? server.message : null,
  };
}

function parseAccountSnapshot(value: unknown): AccountSnapshot | null {
  const raw = record(value);
  const updatedAt = strictIso(raw?.updatedAt);
  if (!raw || typeof raw.signedIn !== 'boolean' || !updatedAt) return null;
  const legacyRaucloudGate = raw.managedCloud; // raucloud-legacy: tolerate an older desktop snapshot during rollout.
  const gate = record(raw.raucloud ?? legacyRaucloudGate);
  let raucloud: AccountSnapshot['raucloud'] | null = null;
  if (gate?.kind === 'available' || gate?.kind === 'logged-out') raucloud = { kind: gate.kind };
  if (gate?.kind === 'exhausted' && strictIso(gate.resetAt)) {
    raucloud = { kind: 'exhausted', resetAt: strictIso(gate.resetAt)! };
  }
  if (gate?.kind === 'active-elsewhere' && string(gate.runId).trim()) {
    raucloud = {
      kind: 'active-elsewhere',
      runId: string(gate.runId).trim(),
      deviceName: typeof gate.deviceName === 'string' ? gate.deviceName : null,
    };
  }
  if (gate?.kind === 'unavailable' && string(gate.reason).trim()) {
    raucloud = { kind: 'unavailable', reason: string(gate.reason).trim() };
  }
  if (!raucloud) return null;
  if (!raw.signedIn) {
    return raw.account === null && raw.quota === null && raucloud.kind === 'logged-out'
      ? { signedIn: false, account: null, quota: null, raucloud, updatedAt }
      : null;
  }
  const accountRaw = raw.account === null ? null : record(raw.account);
  const account = accountRaw ? {
    id: string(accountRaw.id).trim(),
    email: string(accountRaw.email).trim(),
    displayName: typeof accountRaw.displayName === 'string' ? accountRaw.displayName : null,
  } : null;
  if (accountRaw && !account?.id) return null;
  const quotaRaw = raw.quota === null ? null : record(raw.quota);
  let quota: AccountSnapshot['quota'] = null;
  if (quotaRaw) {
    const dailyLimitMs = strictInteger(quotaRaw.dailyLimitMs);
    const usedMs = strictInteger(quotaRaw.usedMs);
    const remainingMs = strictInteger(quotaRaw.remainingMs);
    const debtMs = strictInteger(quotaRaw.debtMs);
    const graceUsedMs = strictInteger(quotaRaw.graceUsedMs);
    const resetAt = strictIso(quotaRaw.resetAt);
    const timeZone = string(quotaRaw.timeZone).trim();
    const cold = record(quotaRaw.coldStarts);
    const coldStarts = cold ? {
      usedToday: strictInteger(cold.usedToday),
      dailyLimit: strictInteger(cold.dailyLimit),
      recent: strictInteger(cold.recent),
      recentLimit: strictInteger(cold.recentLimit),
    } : null;
    const activeRaw = quotaRaw.activeRun === null ? null : record(quotaRaw.activeRun);
    const activeRun = activeRaw ? {
      runId: string(activeRaw.runId).trim(),
      deviceId: string(activeRaw.deviceId).trim(),
      deviceName: typeof activeRaw.deviceName === 'string' ? activeRaw.deviceName : null,
      startedAt: strictIso(activeRaw.startedAt),
      controllingThisDevice: activeRaw.controllingThisDevice,
    } : null;
    const graceEndsAt = quotaRaw.graceEndsAt === undefined || quotaRaw.graceEndsAt === null
      ? null
      : strictIso(quotaRaw.graceEndsAt);
    if (dailyLimitMs === null || usedMs === null || remainingMs === null || debtMs === null
      || graceUsedMs === null || !resetAt || !timeZone || !coldStarts
      || Object.values(coldStarts).some((entry) => entry === null)
      || (activeRaw && (!activeRun?.runId || !activeRun.deviceId || !activeRun.startedAt
        || typeof activeRun.controllingThisDevice !== 'boolean'))
      || (quotaRaw.graceEndsAt !== undefined && quotaRaw.graceEndsAt !== null && !graceEndsAt)) return null;
    quota = {
      dailyLimitMs, usedMs, remainingMs, debtMs, graceUsedMs, resetAt, timeZone,
      activeRun: activeRun as NonNullable<AccountSnapshot['quota']>['activeRun'],
      coldStarts: coldStarts as NonNullable<AccountSnapshot['quota']>['coldStarts'],
      graceEndsAt,
    };
  } else if (raw.quota !== null) return null;
  return { signedIn: true, account, quota, raucloud, updatedAt };
}

function parseSessionBase(state: Record<string, unknown>): CloudSessionBase | null {
  const sessionId = string(state.sessionId).trim();
  const threadId = string(state.threadId).trim();
  const documentName = string(state.documentName).trim();
  const version = strictInteger(state.version);
  const documentId = state.documentId === null
    ? null
    : typeof state.documentId === 'string' && state.documentId.trim()
      ? state.documentId
      : undefined;
  if (!sessionId || !threadId || !documentName || version === null || documentId === undefined) return null;
  const selection = record(state.selection);
  const validSelection = selection && ['claude', 'codex', 'pi'].includes(String(selection.agent))
    && typeof selection.model === 'string' && typeof selection.effort === 'string';
  return {
    ...(validSelection ? { selection: {
      agent: selection.agent as import('../agent/types.ts').AgentName,
      model: selection.model as string,
      effort: selection.effort as string,
    } } : {}),
    ...(typeof state.configurationPending === 'boolean' ? { configurationPending: state.configurationPending } : {}),
    ...(typeof state.configurationEditable === 'boolean' ? { configurationEditable: state.configurationEditable } : {}),
    ...(strictIso(state.handoffAcceptedAt) ? { handoffAcceptedAt: strictIso(state.handoffAcceptedAt)! } : {}),
    sessionId,
    version,
    threadId,
    documentId,
    documentName,
  };
}

function parseResultSummary(value: unknown) {
  const result = record(value);
  if (!result) return null;
  const fileName = string(result.fileName).trim();
  const sha256 = string(result.sha256).trim();
  const byteLength = strictInteger(result.byteLength);
  const expiresAt = result.expiresAt === null ? null : strictIso(result.expiresAt);
  if (!fileName || !sha256 || byteLength === null || expiresAt === null && result.expiresAt !== null
    || typeof result.downloaded !== 'boolean'
    || typeof result.availableOnThisDevice !== 'boolean'
    || (result.conflict !== 'none' && result.conflict !== 'external-change')
    || (result.preservedCopyName !== null && typeof result.preservedCopyName !== 'string')) return null;
  return {
    fileName,
    byteLength,
    sha256,
    downloaded: result.downloaded,
    availableOnThisDevice: result.availableOnThisDevice,
    expiresAt,
    conflict: result.conflict === 'external-change' ? 'external-change' as const : 'none' as const,
    preservedCopyName: typeof result.preservedCopyName === 'string' ? result.preservedCopyName : null,
  };
}

function parseConversationWait(value: unknown) {
  if (value === null || value === undefined) return null;
  const wait = record(value);
  const id = string(wait?.id).trim();
  const kind = wait?.kind;
  const payload = record(wait?.payload);
  if (!wait || !id || !payload
    || (kind !== 'plan-approval' && kind !== 'question'
      && kind !== 'external-side-effect' && kind !== 'destructive-external')) return undefined;
  return {
    id,
    kind: kind as CloudConversationWait['kind'],
    payload,
  };
}

function parseSession(value: unknown): CloudSessionState | null {
  const state = record(value);
  if (!state) return null;
  if (state.kind === 'idle') return { kind: 'idle' };
  const base = parseSessionBase(state);
  if (!base) return null;
  switch (state.kind) {
    case 'waiting-local-turn':
      return typeof state.message === 'string' ? { ...base, kind: state.kind, message: state.message } : null;
    case 'transferring': {
      const stage = state.stage === 'preparing' || state.stage === 'uploading'
        || state.stage === 'committing' || state.stage === 'starting' ? state.stage : null;
      const completedBytes = strictInteger(state.completedBytes);
      const totalBytes = strictInteger(state.totalBytes);
      if (!stage || completedBytes === null || totalBytes === null || typeof state.message !== 'string') return null;
      return {
        ...base,
        kind: state.kind,
        stage,
        completedBytes,
        totalBytes,
        message: state.message,
      };
    }
    case 'queued': {
      const position = strictInteger(state.position);
      return position !== null && typeof state.message === 'string'
        ? { ...base, kind: state.kind, position, message: state.message }
        : null;
    }
    case 'running': {
      const startedAt = strictIso(state.startedAt);
      const turn = strictInteger(state.turn);
      const turnLimit = strictInteger(state.turnLimit);
      const elapsedMs = strictInteger(state.elapsedMs);
      const timeLimitMs = strictInteger(state.timeLimitMs);
      const phase = state.phase === 'waiting' || state.phase === 'redirecting'
        || state.phase === 'awaiting-plan-approval'
        || state.phase === 'awaiting-question-answer'
        || state.phase === 'awaiting-external-effect-approval'
        ? state.phase
        : 'working';
      const wait = parseConversationWait(state.wait);
      if (!startedAt || turn === null || turnLimit === null || elapsedMs === null || timeLimitMs === null
        || typeof state.currentActivity !== 'string' || wait === undefined) return null;
      return {
        ...base,
        kind: state.kind,
        startedAt,
        turn,
        turnLimit,
        elapsedMs,
        timeLimitMs,
        currentActivity: state.currentActivity,
        phase,
        wait,
      };
    }
    case 'pausing':
      return typeof state.message === 'string' ? { ...base, kind: state.kind, message: state.message } : null;
    case 'suspended':
      return typeof state.reason === 'string' && typeof state.resumable === 'boolean'
        ? {
            ...base,
            kind: state.kind,
            reason: state.reason,
            code: typeof state.code === 'string' && state.code ? state.code : null,
            provider: CLOUD_AGENTS.find((agent) => agent === state.provider) ?? null,
            resumable: state.resumable,
          }
        : null;
    case 'taking-over':
      return typeof state.message === 'string' ? { ...base, kind: state.kind, message: state.message } : null;
    case 'completed': {
      const result = parseResultSummary(state.result);
      const completedAt = strictIso(state.completedAt);
      return result && completedAt ? { ...base, kind: state.kind, completedAt, result } : null;
    }
    case 'failed':
      return typeof state.code === 'string' && typeof state.message === 'string' && typeof state.retryable === 'boolean' ? {
        ...base,
        kind: state.kind,
        code: state.code,
        message: state.message,
        retryable: state.retryable,
      } : null;
    case 'cancelled': {
      const cancelledAt = strictIso(state.cancelledAt);
      return cancelledAt ? { ...base, kind: state.kind, cancelledAt } : null;
    }
    default:
      return null;
  }
}

function parseTakeover(value: unknown): CloudTakeoverPayload | null {
  const raw = record(value);
  if (!raw) return null;
  const operationId = string(raw.operationId).trim();
  const timeline = parseCloudTimeline(raw.timeline);
  if (!operationId || !timeline) return null;
  if (raw.document === null) return { operationId, document: null, timeline };
  const document = record(raw.document);
  if (!document || !(document.bytes instanceof Uint8Array)) return null;
  const fileName = string(document.fileName).trim();
  const sha256 = string(document.sha256).trim();
  const recoveryPath = string(document.recoveryPath).trim();
  const byteLength = strictInteger(document.byteLength);
  const revision = strictInteger(document.revision);
  const turn = strictInteger(document.turn);
  if (!fileName || !sha256 || !recoveryPath || byteLength === null || revision === null || turn === null
    || document.bytes.byteLength !== byteLength) return null;
  return {
    operationId,
    document: { bytes: document.bytes, fileName, sha256, byteLength, recoveryPath, revision, turn },
    timeline,
  };
}

const BOAT_SERVER_STATES = ['stopped', 'waking', 'running', 'stopping', 'missing', 'error'] as const;
/** 정지된 boat VM 에 explicit 없이 체크포인트를 물으면 데스크톱이 이 code 로 조용히 거절한다. */
export const BOAT_SERVER_STOPPED = 'BOAT_SERVER_STOPPED';
const BOAT_SETUP_STAGES = ['creating', 'starting', 'installing', 'pairing', 'credentials', 'done'] as const;
const BOAT_PROVIDERS = ['claude', 'codex', 'pi'] as const;

function optionalText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function parseBoatServer(value: unknown): BoatServerSnapshot | null {
  const server = record(value);
  const sandboxId = string(server?.sandboxId).trim();
  const state = BOAT_SERVER_STATES.find((entry) => entry === server?.state);
  if (!server || !sandboxId || !state) return null;
  const hours = typeof server.monthHours === 'number' && Number.isFinite(server.monthHours) && server.monthHours >= 0
    ? Math.round(server.monthHours * 10) / 10
    : null;
  const idle = strictInteger(server.idleStopMinutes);
  const timerHours = typeof server.timerHours === 'number' && Number.isFinite(server.timerHours)
    && server.timerHours > 0 && server.timerHours <= 720
    ? Math.round(server.timerHours * 10) / 10
    : null;
  const autoStop = server.autoStop === 'timer' ? 'timer' : 'idle';
  return {
    sandboxId,
    state,
    machine: server.machine === 'small' ? 'small' : 'default',
    machineLabel: string(server.machineLabel).trim(),
    region: 'EU',
    monthHours: hours,
    idleStopMinutes: idle !== null && idle >= 5 && idle <= 240 ? idle : 30,
    autoStop,
    timerHours: autoStop === 'timer' ? timerHours : null,
    message: optionalText(server.message),
    wakeStage: state === 'waking' && BOAT_WAKE_STAGES.includes(server.wakeStage as BoatWakeStage)
      ? server.wakeStage as BoatWakeStage
      : null,
  };
}

function parseBoatSetup(value: unknown): BoatSetupProgress | null {
  const setup = record(value);
  const stage = BOAT_SETUP_STAGES.find((entry) => entry === setup?.stage);
  const startedAt = strictIso(setup?.startedAt);
  if (!setup || !stage || !startedAt) return null;
  const error = record(setup.error);
  const imported = Array.isArray(setup.importedProviders) ? setup.importedProviders : [];
  return {
    stage,
    startedAt,
    detail: optionalText(setup.detail),
    error: error && optionalText(error.title)
      ? { title: string(error.title).trim(), guidance: string(error.guidance).trim(), detail: string(error.detail) }
      : null,
    importedProviders: BOAT_PROVIDERS.filter((provider) => imported.includes(provider)),
  };
}

/** boat 부분이 어긋나도 Cloud 전체를 버리지 않는다. 읽을 수 없는 조각만 비운다. */
export function parseBoatSnapshot(value: unknown): BoatSnapshot | null {
  const raw = record(value);
  const account = record(raw?.account);
  if (!raw || !account || typeof account.connected !== 'boolean') return null;
  const parsedAccount: BoatAccountSnapshot = {
    connected: account.connected,
    method: account.method === 'email' || account.method === 'api-key' ? account.method : null,
    email: optionalText(account.email),
    canStart: typeof account.canStart === 'boolean' ? account.canStart : null,
    trial: typeof account.trial === 'boolean' ? account.trial : null,
  };
  return {
    account: parsedAccount,
    server: parseBoatServer(raw.server),
    setup: parseBoatSetup(raw.setup),
  };
}

export function parseBoatChallenge(value: unknown): BoatSignInChallenge | null {
  const raw = record(value);
  const claimId = string(raw?.claimId).trim();
  const userCode = string(raw?.userCode).replace(/\s+/g, '');
  const expiresAt = strictIso(raw?.expiresAt);
  let verificationUri = '';
  try {
    const url = new URL(string(raw?.verificationUri));
    if (url.protocol === 'https:' && (url.hostname === 'boat.dev' || url.hostname.endsWith('.boat.dev'))) {
      verificationUri = url.href;
    }
  } catch { /* 아래에서 거절한다. */ }
  const interval = strictInteger(raw?.intervalSeconds);
  if (!raw || !claimId || !/^[A-Za-z0-9]{4,12}$/.test(userCode) || !expiresAt || !verificationUri) return null;
  return {
    claimId,
    verificationUri,
    userCode,
    expiresAt,
    intervalSeconds: interval !== null && interval >= 1 && interval <= 60 ? interval : 5,
  };
}

/**
 * preload 는 { message, code } 모양으로 거절하고, 봉투 없이 거절된 invoke 는 메시지 앞에 채널 이름이
 * 붙고 code 를 잃는다. 어느 쪽이든 사용자에게 보일 문장과 `BOAT_…` code 만 남긴다.
 */
export function normalizeBoatError(error: unknown): Error & { code?: string } {
  const shaped = error && typeof error === 'object' ? error as { message?: unknown; code?: unknown } : null;
  const message = typeof shaped?.message === 'string' ? shaped.message : String(error ?? '');
  const own = shaped?.code;
  let text = message
    .replace(/^Error invoking remote method '[^']*':\s*/, '')
    .replace(/^(?:[A-Za-z]*Error):\s*/, '')
    .trim();
  let code = typeof own === 'string' && own ? own : undefined;
  const prefixed = /^\[?(BOAT_[A-Z_]+)\]?:?\s*/.exec(text);
  if (prefixed) {
    code ??= prefixed[1];
    text = text.slice(prefixed[0].length).trim();
  }
  const normalized = new Error(text || 'boat에 연결하지 못했습니다.') as Error & { code?: string };
  if (code) normalized.code = code;
  return normalized;
}

/**
 * IPC 거절은 메시지 앞에 채널 이름과 오류 이름이 붙는다. 사용자에게는 그 뒤의 문장만 보인다.
 * 한국어가 아닌 원문(진단용 영어)은 짧은 한국어 문장으로 바꾼다.
 */
export function cloudErrorText(error: unknown, fallback = 'Cloud 요청을 처리하지 못했습니다.'): string {
  const shaped = error && typeof error === 'object' ? error as { message?: unknown } : null;
  const raw = typeof shaped?.message === 'string' ? shaped.message : String(error ?? '');
  const text = raw
    .replace(/^Error invoking remote method '[^']*':\s*/, '')
    .replace(/^(?:[A-Za-z]*Error)(?: \[[A-Za-z]+\])?:\s*/, '')
    .trim();
  if (/[가-힣]/.test(text)) return text;
  const coded = cloudErrorCodeText((error as { code?: string } | null)?.code, text);
  if (coded) return coded;
  if (text) console.warn('[cloud]', text);
  return fallback;
}

/** IPC 거절을 사용자 문장과 원래 code 를 가진 오류로 바꾼다. 취소는 그대로 둔다. */
export function normalizeCloudError(error: unknown): unknown {
  if (error instanceof DOMException && error.name === 'AbortError') return error;
  const normalized = new Error(cloudErrorText(error)) as Error & { code?: string; retryable?: boolean; detail?: string };
  const shaped = error && typeof error === 'object' ? error as { code?: unknown; retryable?: unknown; message?: unknown } : null;
  if (typeof shaped?.code === 'string' && shaped.code) normalized.code = shaped.code;
  // 원문은 화면 문장이 아니라 원인 분류와 자세히에 쓴다.
  const raw = typeof shaped?.message === 'string' ? shaped.message : '';
  const detail = raw.replace(/^Error invoking remote method '[^']*':\s*/, '').replace(/^(?:[A-Za-z]*Error)(?: \[[A-Za-z]+\])?:\s*/, '').trim();
  if (detail && detail !== normalized.message) normalized.detail = detail;
  if (shaped?.retryable === false) normalized.retryable = false;
  return normalized;
}

export function isBoatServerStopped(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as { code?: unknown }).code === BOAT_SERVER_STOPPED);
}

/**
 * 다시 물어도 같은 답이 오는 체크포인트 거절. 작업 상태가 바뀔 때까지 미러가 다시 묻지 않는다.
 * 쉬는 boat VM 은 여기에 들지 않는다. 그 거절은 VM 이 다시 켜지면 풀린다.
 */
export function isTerminalCheckpointError(error: unknown): boolean {
  if (!error || typeof error !== 'object' || isBoatServerStopped(error)) return false;
  const shaped = error as { code?: unknown; retryable?: unknown };
  return shaped.code === 'CHECKPOINT_NOT_FOUND' || shaped.code === 'SESSION_NOT_FOUND' || shaped.retryable === false;
}

/** 체크포인트 거절 중 쉬는 boat VM 만 code 를 되살린다. 나머지 오류는 그대로 둔다. */
function checkpointError(error: unknown): unknown {
  const shaped = error && typeof error === 'object' ? error as { message?: unknown; code?: unknown } : null;
  if (shaped?.code === BOAT_SERVER_STOPPED) return error;
  const message = typeof shaped?.message === 'string' ? shaped.message : '';
  return message.includes(BOAT_SERVER_STOPPED) ? normalizeBoatError(error) : error;
}

export function parseCloudSnapshot(value: unknown): CloudSnapshot | null {
  const raw = record(value);
  if (!raw) return null;
  const profile = parseProfile(raw.profile);
  const session = parseSession(raw.session);
  const leaseRaw = record(raw.lease);
  const revision = strictInteger(raw.revision);
  const profileEpoch = strictInteger(raw.profileEpoch);
  const updatedAt = strictIso(raw.updatedAt);
  if (revision === null || profileEpoch === null || typeof raw.available !== 'boolean'
    || !profile || !session || !leaseRaw || !updatedAt) return null;
  const lease = leaseRaw.owner === 'cloud' && string(leaseRaw.sessionId).trim() && strictIso(leaseRaw.acquiredAt)
    ? {
        owner: 'cloud' as const,
        sessionId: string(leaseRaw.sessionId),
        ...(string(leaseRaw.threadId).trim() ? { threadId: string(leaseRaw.threadId) } : {}),
        acquiredAt: strictIso(leaseRaw.acquiredAt)!,
      }
    : leaseRaw.owner === 'local'
      ? { owner: 'local' as const }
      : null;
  if (!lease || !Array.isArray(raw.queuedMessages)) return null;
  const sessionValues = raw.sessions === undefined
    ? (session.kind === 'idle' ? [] : [session])
    : raw.sessions;
  if (!Array.isArray(sessionValues)) return null;
  const sessions = sessionValues.map(parseSession);
  if (sessions.some((entry) => !entry || entry.kind === 'idle')) return null;
  const sessionIds = sessions.map((entry) => (entry as CloudSessionBase).sessionId);
  if (new Set(sessionIds).size !== sessionIds.length) return null;
  const queuedMessages = raw.queuedMessages.flatMap((value) => {
        const message = record(value);
        const queuedAt = strictIso(message?.queuedAt);
        if (!message || !string(message.id).trim() || !string(message.text).trim() || !queuedAt
          || (message.state !== 'queued' && message.state !== 'accepted')
          || (message.delivery !== undefined && message.delivery !== 'pending' && message.delivery !== 'durable')) return [];
        return [{
          id: string(message.id),
          text: string(message.text),
          queuedAt,
          state: message.state === 'accepted' ? 'accepted' as const : 'queued' as const,
          delivery: message.delivery === 'durable' ? 'durable' as const : 'pending' as const,
        }];
      });
  if (queuedMessages.length !== raw.queuedMessages.length) return null;
  const timeline = raw.timeline === null ? null : parseCloudTimeline(raw.timeline);
  if (raw.timeline !== null && !timeline) return null;
  const takeover = raw.takeover === undefined ? undefined : parseTakeover(raw.takeover);
  if (raw.takeover !== undefined && !takeover) return null;
  const server = parseServer(raw.server, profile);
  if (!server) return null;
  const account = raw.account === undefined ? undefined : parseAccountSnapshot(raw.account);
  if (raw.account !== undefined && !account) return null;
  const sandboxOutcome = record(raw.sandbox);
  const sandbox = sandboxOutcome
    ? { removed: sandboxOutcome.removed === true, unmanaged: sandboxOutcome.unmanaged === true }
    : undefined;
  const mergeRequests = raw.mergeRequests === undefined ? [] : raw.mergeRequests;
  if (!Array.isArray(mergeRequests)) return null;
  const parsedMergeRequests = mergeRequests.map((value) => {
    const item = record(value);
    if (!item || ['sessionId', 'documentId', 'threadId', 'cloudStartId', 'operationId', 'fileName']
      .some((key) => typeof item[key] !== 'string' || !string(item[key]).trim())
      || item.kind !== 'turn' || !/^[a-f0-9]{64}$/.test(string(item.sha256))
      || !Number.isSafeInteger(item.revision) || Number(item.revision) < 1
      || !Number.isSafeInteger(item.turn) || Number(item.turn) < 1
      || !Number.isSafeInteger(item.size) || Number(item.size) < 1
      || (item.localAvailable !== undefined && typeof item.localAvailable !== 'boolean')) return null;
    return { sessionId: string(item.sessionId), documentId: string(item.documentId),
      threadId: string(item.threadId), cloudStartId: string(item.cloudStartId),
      operationId: string(item.operationId), revision: Number(item.revision), turn: Number(item.turn),
      kind: 'turn' as const, fileName: string(item.fileName), sha256: string(item.sha256), size: Number(item.size),
      ...(typeof item.localAvailable === 'boolean' ? { localAvailable: item.localAvailable } : {}) };
  });
  if (parsedMergeRequests.some((item) => !item)) return null;
  const link = raw.link === undefined ? undefined : parseCloudLink(raw.link);
  const boat = raw.boat === undefined ? undefined : parseBoatSnapshot(raw.boat);
  return {
    revision,
    profileEpoch,
    mergeRequests: parsedMergeRequests.filter((item) => item !== null),
    available: raw.available,
    profile,
    server,
    ...(sandbox ? { sandbox } : {}),
    lease,
    session,
    sessions: sessions as Exclude<CloudSessionState, { kind: 'idle' }>[],
    queuedMessages,
    timeline,
    updatedAt,
    ...(account ? { account } : {}),
    ...(takeover ? { takeover } : {}),
    ...(link ? { link } : {}),
    ...(boat !== undefined ? { boat } : {}),
  };
}

function parseCloudLink(value: unknown): CloudLinkState | null {
  const raw = record(value);
  if (!raw) return null;
  if (raw.kind !== 'ready' && raw.kind !== 'reconnecting' && raw.kind !== 'recreating' && raw.kind !== 'failed') {
    return null;
  }
  if (raw.error !== null && raw.error !== undefined && typeof raw.error !== 'string') return null;
  if (typeof raw.canRecreate !== 'boolean') return null;
  const attempt = integer(raw.attempt);
  const reason = raw.kind === 'failed' ? LINK_REASONS.find((entry) => entry === raw.reason) ?? null : null;
  return {
    kind: raw.kind,
    error: typeof raw.error === 'string' ? raw.error : null,
    attempt,
    canRecreate: raw.canRecreate,
    ...(reason ? { reason, message: optionalText(raw.message) } : {}),
  };
}

function unavailableSnapshot(): CloudSnapshot {
  return {
    revision: 0,
    profileEpoch: 0,
    available: false,
    profile: { kind: 'unconfigured' },
    server: {
      mode: null,
      preferredMode: null,
      providers: [],
      lifecycle: 'idle',
      message: null,
    },
    lease: { owner: 'local' },
    session: { kind: 'idle' },
    sessions: [],
    queuedMessages: [],
    timeline: null,
    updatedAt: new Date().toISOString(),
  };
}

function parseDownloadResult(value: unknown): CloudDownloadResult | null {
  const result = record(value);
  if (!result) return null;
  const sessionId = string(result.sessionId).trim();
  const fileName = string(result.fileName).trim();
  const sha256 = string(result.sha256).trim();
  const recoveryPath = string(result.recoveryPath).trim();
  if (!sessionId || !fileName || !sha256 || !recoveryPath || !(result.bytes instanceof Uint8Array)) return null;
  return {
    sessionId,
    fileName,
    bytes: result.bytes,
    byteLength: integer(result.byteLength),
    sha256,
    recoveryPath,
    previewOpened: result.previewOpened === true,
    conflict: result.conflict === 'external-change' ? 'external-change' : 'none',
    preservedCopyName: typeof result.preservedCopyName === 'string' ? result.preservedCopyName : null,
    timeline: parseCloudTimeline(result.timeline),
  };
}

export function parseCloudCheckpoint(value: unknown): CloudCheckpointPayload | null {
  const result = record(value);
  if (!result || !(result.bytes instanceof Uint8Array)) return null;
  const sessionId = string(result.sessionId).trim();
  const fileName = string(result.fileName).trim();
  const sha256 = string(result.sha256).trim();
  const operationId = string(result.operationId).trim();
  const kind = result.kind === 'handoff' || result.kind === 'operation' || result.kind === 'turn'
    ? result.kind
    : null;
  const documentId = result.documentId === null
    ? null
    : typeof result.documentId === 'string'
      && result.documentId.trim()
      && result.documentId === result.documentId.trim()
      ? result.documentId
      : undefined;
  const originOnThisDevice = result.originOnThisDevice === true;
  const expectedOriginCandidate = string(result.expectedOriginSha256).trim();
  const expectedOriginSha256 = /^[a-f0-9]{64}$/.test(expectedOriginCandidate)
    ? expectedOriginCandidate
    : '';
  const byteLength = strictInteger(result.byteLength);
  const revision = strictInteger(result.revision);
  const turn = strictInteger(result.turn);
  if (!sessionId || !fileName || !sha256 || !operationId || !kind || documentId === undefined
    || byteLength === null || revision === null || turn === null
    || result.bytes.byteLength !== byteLength) return null;
  return {
    sessionId, documentId, kind, fileName, sha256, operationId, byteLength, revision, turn, bytes: result.bytes,
    ...(originOnThisDevice ? { originOnThisDevice: true } : {}),
    ...(expectedOriginSha256 ? { expectedOriginSha256 } : {}),
    ...(['written', 'unchanged', 'conflict', 'archive-only'].includes(string(result.publication)) ? {
      publication: result.publication as CloudCheckpointPayload['publication'],
      preservedCopyName: typeof result.preservedCopyName === 'string' ? result.preservedCopyName : null,
    } : {}),
  };
}

export function parseCloudResultResolution(value: unknown): CloudResultResolution | null {
  const result = record(value);
  if (!result) return null;
  const action = result.action === 'replace' || result.action === 'keep-both' || result.action === 'discard'
    ? result.action
    : null;
  const conflict = result.conflict === 'external-change'
    ? 'external-change' as const
    : result.conflict === 'none'
      ? 'none' as const
      : null;
  const snapshot = parseCloudSnapshot(result.snapshot);
  if (!action || !conflict || !snapshot) return null;
  const path = typeof result.path === 'string' && result.path.trim() ? result.path : null;
  const bytes = result.bytes instanceof Uint8Array ? result.bytes : null;
  const preservedCopyName = typeof result.preservedCopyName === 'string' && result.preservedCopyName.trim()
    ? result.preservedCopyName
    : null;
  if (action === 'discard') {
    if (path !== null || bytes !== null || conflict !== 'none') return null;
  } else if (!path || !bytes?.byteLength) {
    return null;
  }
  if (conflict === 'external-change' && action !== 'keep-both') return null;
  if (action === 'keep-both' && !preservedCopyName) return null;
  return { action, path, bytes, conflict, preservedCopyName, snapshot };
}

function unwrapSnapshot(value: unknown): CloudSnapshot | null {
  const wrapper = record(value);
  return parseCloudSnapshot(wrapper?.snapshot ?? value);
}

export function createCloudController(
  api: CloudDesktopApi | undefined = (globalThis as { rhwpDesktop?: CloudAwareDesktopApi }).rhwpDesktop,
  browser: { readReference?: (reference: Pick<CloudTransferReference, 'id' | 'scope' | 'scopeId'>) => Promise<Uint8Array> } = {},
): CloudController {
  const resolvedApi: CloudDesktopApi | undefined = api
    ?? (browserCloudSupported() ? createBrowserCloudApi(browser) : undefined);
  let snapshot = unavailableSnapshot();
  let disposed = false;
  let activeScope: CloudSessionScope = { threadId: '', documentId: null };
  const listeners = new Set<(state: CloudSnapshot) => void>();
  const eventListeners = new Set<(event: unknown) => void>();
  type ActiveDisplay = {
    connectionId: string;
    capability: CloudDisplayCapability;
    listener: (event: CloudDisplayEvent) => void;
    closePromise: Promise<void> | null;
  };
  let displayGeneration = 0;
  let activeDisplay: ActiveDisplay | null = null;
  let openingDisplays = 0;
  const pendingDisplayEvents = new Map<string, unknown[]>();
  const recoveryCalls = new Map<string, Promise<CloudSnapshot>>();

  const publish = (next: CloudSnapshot): CloudSnapshot => {
    if (next.profileEpoch < snapshot.profileEpoch) return snapshot;
    if (next.profileEpoch === snapshot.profileEpoch && next.revision < snapshot.revision) return snapshot;
    if (next.profileEpoch > snapshot.profileEpoch) {
      displayGeneration += 1;
      if (activeDisplay) void closeDisplay(activeDisplay).catch(() => {});
      pendingDisplayEvents.clear();
    }
    snapshot = next;
    if (!disposed) recordCloudUsage(snapshot);
    if (!disposed) for (const listener of listeners) listener(snapshot);
    return snapshot;
  };

  const accept = (value: unknown): CloudSnapshot => {
    const parsed = unwrapSnapshot(value);
    if (!parsed) throw new Error('Cloud 서비스가 올바르지 않은 상태를 반환했습니다.');
    if (parsed.profileEpoch < snapshot.profileEpoch) {
      throw Object.assign(new Error('Cloud 프로필이 작업 중 변경됐습니다.'), { code: 'PROFILE_CHANGED' });
    }
    return publish(parsed);
  };

  const call = async (method: keyof CloudDesktopApi, payload?: unknown): Promise<CloudSnapshot> => {
    const fn = resolvedApi?.[method];
    if (typeof fn !== 'function') throw new Error('이 앱 빌드는 Cloud 에이전트를 지원하지 않습니다.');
    let raw: unknown;
    try {
      raw = await (fn as (arg?: unknown) => Promise<unknown>)(payload);
    } catch (error) {
      throw normalizeCloudError(error);
    }
    return accept(raw);
  };

  const boatInvoke = async (method: keyof CloudDesktopApi, payload?: unknown): Promise<unknown> => {
    const fn = resolvedApi?.[method];
    if (typeof fn !== 'function') {
      throw Object.assign(new Error('이 앱 빌드는 boat 서버를 지원하지 않습니다.'), { code: 'BOAT_UNSUPPORTED' });
    }
    try {
      return await (fn as (arg?: unknown) => Promise<unknown>)(payload);
    } catch (error) {
      throw normalizeBoatError(error);
    }
  };

  const recover = (
    kind: 'reconnecting' | 'recreating',
    run: () => Promise<CloudSnapshot>,
    key: string = kind,
  ): Promise<CloudSnapshot> => {
    // 자동 재연결이 도는 중에 사용자가 누른 다시 연결은 따로 보낸다. 그래야 쉬던 VM 을 깨운다.
    const pending = recoveryCalls.get(key);
    if (pending) return pending;
    const epoch = snapshot.profileEpoch;
    publish({ ...snapshot, link: {
      kind, error: null, attempt: (snapshot.link?.attempt ?? 0) + 1,
      canRecreate: snapshot.link?.canRecreate ?? (snapshot.profile.kind === 'configured' && snapshot.profile.mode === 'app-hosted'),
    } });
    const operation = run().catch((error) => {
      if (snapshot.profileEpoch === epoch && snapshot.link?.kind === kind) {
        publish({ ...snapshot, link: { ...snapshot.link, kind: 'failed',
          error: error instanceof Error ? error.message : String(error) } });
      }
      throw error;
    }).finally(() => { recoveryCalls.delete(key); });
    recoveryCalls.set(key, operation);
    return operation;
  };

  const unsubscribeHost = resolvedApi?.onCloudEvent?.((event) => {
    if (disposed) return;
    const next = unwrapSnapshot(event);
    if (next && next.profileEpoch < snapshot.profileEpoch) return;
    if (next) publish(next);
    const envelope = record(event);
    const eventEpoch = strictInteger(envelope?.profileEpoch);
    if (eventEpoch !== null && eventEpoch !== snapshot.profileEpoch) return;
    const batched = envelope?.type === 'cloud-event-batch' && Array.isArray(envelope.events);
    const events: unknown[] = batched ? envelope.events as unknown[] : [event];
    for (const item of events) {
      if (batched && strictInteger(record(item)?.profileEpoch) !== snapshot.profileEpoch) continue;
      for (const listener of eventListeners) listener(item);
    }
  });

  const closeDisplay = (entry: ActiveDisplay): Promise<void> => {
    if (entry.closePromise) return entry.closePromise;
    if (activeDisplay === entry) activeDisplay = null;
    pendingDisplayEvents.delete(entry.connectionId);
    entry.closePromise = Promise.resolve(resolvedApi?.cloudCloseDisplay?.({
      connectionId: entry.connectionId,
    })).then(() => {});
    return entry.closePromise;
  };

  const acceptDisplayHostEvent = (value: unknown): CloudDisplayEvent | null => {
    if (disposed) return null;
    const envelope = record(value);
    if (!envelope || typeof envelope.connectionId !== 'string' || !envelope.connectionId) return null;
    const connectionId = envelope.connectionId;
    if (!activeDisplay || connectionId !== activeDisplay.connectionId) {
      if (openingDisplays > 0) {
        const queued = pendingDisplayEvents.get(connectionId) ?? [];
        queued.push(value);
        pendingDisplayEvents.set(connectionId, queued.slice(-8));
        while (pendingDisplayEvents.size > 4) {
          const oldest = pendingDisplayEvents.keys().next().value;
          if (oldest === undefined) break;
          pendingDisplayEvents.delete(oldest);
        }
      }
      return null;
    }
    const expectedStream = activeDisplay.capability.kind === 'available'
      ? activeDisplay.capability.streamId
      : undefined;
    const event = parseCloudDisplayEvent(envelope.event, {
      sessionId: activeDisplay.capability.sessionId,
      streamId: record(envelope.event)?.state === 'connected' ? undefined : expectedStream,
    });
    if (!event) return null;
    if (event.kind === 'connection' && event.state === 'connected') {
      activeDisplay.capability = event.capability;
    } else if (event.kind === 'unavailable') {
      activeDisplay.capability = event;
    }
    try { activeDisplay.listener(event); } catch { /* Display listeners are isolated. */ }
    return event;
  };

  const unsubscribeDisplayHost = resolvedApi?.onCloudDisplayEvent?.((value) => {
    acceptDisplayHostEvent(value);
  });

  return {
    getSnapshot: () => snapshot,
    refresh: (scope) => { activeScope = scope; return call('cloudGetState', scope); },
    saveProfile: (profile) => call('cloudSaveProfile', { profile }),
    testProfile: (profile) => call('cloudTestProfile', profile ? { profile } : {}),
    provision: (installChannel = 'stable', profile) => call('cloudProvision', {
      installChannel,
      ...(profile ? { profile } : {}),
    }),
    pair: (code, profile) => call('cloudPair', { code, ...(profile ? { profile } : {}) }),
    selectServerMode: (mode) => call('cloudSelectServerMode', { mode }),
    spawnSandbox: (providerId, selectedProvider) => call('cloudSpawnSandbox', {
      ...(providerId ? { providerId } : {}),
      ...(selectedProvider ? { selectedProvider } : {}),
    }),
    sandboxStatus: () => call('cloudSandboxStatus'),
    teardownSandbox: (options = {}) => call('cloudTeardownSandbox', { force: options.force === true }),
    forceQuitAccount: () => call('cloudForceQuitAccount'),
    reconnectLink: (options = {}) => {
      const explicit = options.explicit === true;
      return recover('reconnecting', async () => {
        if (typeof resolvedApi?.cloudReconnectLink === 'function') {
          return call('cloudReconnectLink', explicit ? { explicit: true } : undefined);
        }
        return call('cloudGetState', activeScope);
      }, explicit ? 'reconnecting:explicit' : 'reconnecting');
    },
    recreateLink: () => recover('recreating', async () => {
      if (typeof resolvedApi?.cloudRecreateLink === 'function') return call('cloudRecreateLink');
      if (snapshot.profile.kind === 'configured' && snapshot.profile.mode === 'app-hosted') {
        await call('cloudForceQuitAccount');
        return call('cloudSpawnSandbox');
      }
      return call('cloudGetState', activeScope);
    }),
    canRestartService: () => typeof resolvedApi?.cloudRestartService === 'function',
    canReimportLogins: () => typeof resolvedApi?.cloudReimportLogins === 'function',
    restartService: () => recover('reconnecting', () => call('cloudRestartService'), 'restart'),
    async inspectHostKey() {
      const fn = resolvedApi?.cloudInspectHostKey;
      if (typeof fn !== 'function') throw new Error('이 앱 빌드는 SSH 키 확인을 지원하지 않습니다.');
      let raw: Record<string, unknown> | null;
      try {
        raw = record(await fn());
      } catch (error) {
        throw normalizeCloudError(error);
      }
      const fingerprint = string(raw?.fingerprint);
      if (!/^SHA256:[A-Za-z0-9+/]{43}$/.test(fingerprint) || !string(raw?.host)) {
        throw new Error('서버의 SSH 키를 읽지 못했습니다.');
      }
      return { host: string(raw?.host), port: integer(raw?.port, 22), fingerprint };
    },
    trustHostKey: (fingerprint) => recover('reconnecting', () => call('cloudTrustHostKey', { fingerprint }), 'host-key'),
    reimportLogins: (provider) => call('cloudReimportLogins', provider ? { provider } : {}),
    discardMissingSessions: () => call('cloudDiscardMissingSessions'),
    takeoverSandbox: () => call('cloudTakeoverSandbox'),
    transfer: (request) => call('cloudTransfer', request),
    setTransferIntent: (request) => call('cloudSetTransferIntent', request),
    async readReference(reference) {
      const profileEpoch = snapshot.profileEpoch;
      const fn = resolvedApi?.cloudReadReference;
      if (typeof fn !== 'function') throw new Error('이 앱 빌드는 참고자료 전송을 지원하지 않습니다.');
      const raw = record(await fn(reference));
      if (profileEpoch !== snapshot.profileEpoch) {
        throw Object.assign(new Error('Cloud 프로필이 작업 중 변경됐습니다.'), { code: 'PROFILE_CHANGED' });
      }
      if (!(raw?.bytes instanceof Uint8Array)) throw new Error(`${reference.id} 참고자료를 읽지 못했습니다.`);
      return raw.bytes;
    },
    command: (request) => call('cloudCommand', request),
    dismissSession: (sessionId) => call('cloudDismissSession', { sessionId }),
    completeTakeover: (sessionId, operationId) => call('cloudCompleteTakeover', { sessionId, operationId }),
    async downloadResult(sessionId) {
      const profileEpoch = snapshot.profileEpoch;
      const fn = resolvedApi?.cloudDownloadResult;
      if (typeof fn !== 'function') throw new Error('이 앱 빌드는 Cloud 결과 다운로드를 지원하지 않습니다.');
      const result = parseDownloadResult(await fn({ sessionId }));
      if (profileEpoch !== snapshot.profileEpoch) {
        throw Object.assign(new Error('Cloud 프로필이 작업 중 변경됐습니다.'), { code: 'PROFILE_CHANGED' });
      }
      if (!result) throw new Error('다운로드한 Cloud 결과가 올바르지 않습니다.');
      return result;
    },
    async prepareRestartDocument(sessionId) {
      const profileEpoch = snapshot.profileEpoch;
      const fn = resolvedApi?.cloudPrepareRestartDocument;
      if (typeof fn !== 'function') throw new Error('최신 Cloud 문서 보관본을 복구하려면 앱을 업데이트해 주세요.');
      const result = record(await fn({ sessionId }));
      if (profileEpoch !== snapshot.profileEpoch) {
        throw Object.assign(new Error('Cloud 프로필이 작업 중 변경됐습니다.'), { code: 'PROFILE_CHANGED' });
      }
      if (!result || !(result.bytes instanceof Uint8Array) || !result.bytes.byteLength
        || !string(result.fileName) || !/^[a-f0-9]{64}$/.test(string(result.sha256))
        || !string(result.restartToken)
        || result.originSha256 !== null && !/^[a-f0-9]{64}$/.test(string(result.originSha256))) {
        throw new Error('Cloud 복구 문서 보관본을 확인할 수 없습니다.');
      }
      return { bytes: result.bytes, fileName: string(result.fileName), sha256: string(result.sha256),
        originSha256: result.originSha256 as string | null, restartToken: string(result.restartToken) };
    },
    async downloadCheckpoint(sessionId, operationId, kind, options = {}) {
      const profileEpoch = snapshot.profileEpoch;
      const fn = resolvedApi?.cloudDownloadCheckpoint;
      if (typeof fn !== 'function') throw new Error('이 앱 빌드는 Cloud 문서 미러를 지원하지 않습니다.');
      const raw = await fn({ sessionId, ...(operationId ? { operationId } : {}), ...(kind ? { kind } : {}),
        ...(options.explicit === true ? { explicit: true } : {}) })
        .catch((error: unknown) => { throw checkpointError(error); });
      const result = parseCloudCheckpoint(raw);
      if (profileEpoch !== snapshot.profileEpoch) {
        throw Object.assign(new Error('Cloud 프로필이 작업 중 변경됐습니다.'), { code: 'PROFILE_CHANGED' });
      }
      if (!result) throw new Error('다운로드한 Cloud 체크포인트가 올바르지 않습니다.');
      return result;
    },
    async publishCheckpoint(sessionId, operationId) {
      const profileEpoch = snapshot.profileEpoch;
      const fn = resolvedApi?.cloudPublishCheckpoint;
      if (typeof fn !== 'function') throw new Error('이 앱 빌드는 Cloud 원본 반영을 지원하지 않습니다.');
      const result = parseCloudCheckpoint(await fn({ sessionId, ...(operationId ? { operationId } : {}) }));
      if (profileEpoch !== snapshot.profileEpoch) {
        throw Object.assign(new Error('Cloud 프로필이 작업 중 변경됐습니다.'), { code: 'PROFILE_CHANGED' });
      }
      if (!result) throw new Error('Cloud 원본 반영 결과가 올바르지 않습니다.');
      return result;
    },
    async openDisplay(sessionId, listener) {
      const generation = ++displayGeneration;
      const profileEpoch = snapshot.profileEpoch;
      const previous = activeDisplay;
      activeDisplay = null;
      if (previous) await closeDisplay(previous);
      if (disposed || generation !== displayGeneration || profileEpoch !== snapshot.profileEpoch) {
        throw new DOMException('Cloud display connection was replaced', 'AbortError');
      }
      if (typeof resolvedApi?.cloudOpenDisplay !== 'function'
        || typeof resolvedApi?.cloudCloseDisplay !== 'function'
        || typeof resolvedApi?.cloudDisplayInput !== 'function'
        || typeof resolvedApi?.onCloudDisplayEvent !== 'function') {
        const capability = clientUnsupportedDisplay(sessionId);
        try { listener(capability); } catch { /* Display listeners are isolated. */ }
        return {
          capability,
          async sendInput() {
            throw Object.assign(new Error('Cloud display input is unavailable'), { code: 'DISPLAY_INPUT_UNAVAILABLE' });
          },
          async close() {},
        };
      }
      openingDisplays += 1;
      let opened: Record<string, unknown> | null;
      try {
        opened = record(await resolvedApi.cloudOpenDisplay({ sessionId }));
      } finally {
        openingDisplays -= 1;
      }
      const connectionId = typeof opened?.connectionId === 'string' && opened.connectionId
        ? opened.connectionId
        : null;
      const capability = parseCloudDisplayCapability(opened?.capability);
      if (!connectionId || !capability || capability.sessionId !== sessionId) {
        if (connectionId) pendingDisplayEvents.delete(connectionId);
        if (connectionId) await resolvedApi.cloudCloseDisplay({ connectionId }).catch(() => {});
        throw new Error('Cloud 디스플레이 연결 정보가 올바르지 않습니다.');
      }
      if (disposed || generation !== displayGeneration || profileEpoch !== snapshot.profileEpoch) {
        pendingDisplayEvents.delete(connectionId);
        await resolvedApi.cloudCloseDisplay({ connectionId }).catch(() => {});
        throw new DOMException('Cloud display connection was replaced', 'AbortError');
      }
      const entry: ActiveDisplay = {
        connectionId,
        capability,
        listener,
        closePromise: null,
      };
      activeDisplay = entry;
      const pending = pendingDisplayEvents.get(connectionId) ?? [];
      pendingDisplayEvents.delete(connectionId);
      const replayedUnavailable = pending
        .map((value) => acceptDisplayHostEvent(value))
        .some((event) => event?.kind === 'unavailable');
      if (capability.kind === 'unavailable' && !replayedUnavailable) {
        try { listener(capability); } catch { /* Display listeners are isolated. */ }
      }
      return {
        get capability() { return entry.capability; },
        async sendInput(event: CloudDisplayInputEvent) {
          if (disposed || generation !== displayGeneration || activeDisplay !== entry
            || profileEpoch !== snapshot.profileEpoch) {
            throw Object.assign(new Error('Cloud display connection was replaced'), { code: 'DISPLAY_STREAM_REPLACED' });
          }
          await resolvedApi.cloudDisplayInput!({ connectionId, event });
          if (disposed || generation !== displayGeneration || activeDisplay !== entry
            || profileEpoch !== snapshot.profileEpoch) {
            throw Object.assign(new Error('Cloud display connection was replaced'), { code: 'DISPLAY_STREAM_REPLACED' });
          }
        },
        close: () => closeDisplay(entry),
      };
    },
    async resolveResult(sessionId, action) {
      const profileEpoch = snapshot.profileEpoch;
      const fn = resolvedApi?.cloudResolveResult;
      if (typeof fn !== 'function') throw new Error('이 앱 빌드는 Cloud 결과 반영을 지원하지 않습니다.');
      const resolution = parseCloudResultResolution(await fn({ sessionId, action }));
      if (!resolution) throw new Error('Cloud 결과 반영 정보가 올바르지 않습니다.');
      if (profileEpoch !== snapshot.profileEpoch || resolution.snapshot.profileEpoch !== profileEpoch) {
        throw Object.assign(new Error('Cloud 프로필이 작업 중 변경됐습니다.'), { code: 'PROFILE_CHANGED' });
      }
      publish(resolution.snapshot);
      return resolution;
    },
    async beginEdit(sessionId) {
      const fn = resolvedApi?.cloudBeginEdit;
      if (typeof fn !== 'function') throw new Error('이 앱 빌드는 Cloud 초안 편집을 지원하지 않습니다.');
      const raw = record(await fn({ sessionId }));
      const next = unwrapSnapshot(raw);
      const editDraft = record(raw?.editDraft);
      const boundary = record(editDraft?.boundary);
      if (!next || typeof editDraft?.sessionId !== 'string'
        || typeof editDraft.editSessionId !== 'string'
        || typeof editDraft.fileName !== 'string'
        || typeof editDraft.savedAt !== 'string'
        || typeof boundary?.operationId !== 'string'
        || !Number.isSafeInteger(boundary.revision)
        || !Number.isSafeInteger(boundary.writerGeneration)
        || !Number.isSafeInteger(boundary.stateVersion)) {
        throw new Error('Cloud 초안 편집 정보가 올바르지 않습니다.');
      }
      publish(next);
      return {
        sessionId: editDraft.sessionId,
        editSessionId: editDraft.editSessionId,
        boundary: {
          operationId: boundary.operationId,
          revision: Number(boundary.revision),
          writerGeneration: Number(boundary.writerGeneration),
          stateVersion: Number(boundary.stateVersion),
        },
        fileName: editDraft.fileName,
        savedAt: editDraft.savedAt,
      };
    },
    continueEdit: (sessionId, editSessionId, changeSummary) => call('cloudContinueEdit', {
      sessionId,
      editSessionId,
      ...(changeSummary ? { changeSummary } : {}),
    }),
    boatSupported: () => BOAT_REQUIRED_METHODS.every((method) => typeof resolvedApi?.[method] === 'function'),
    async boatStartEmailSignIn(email) {
      const challenge = parseBoatChallenge(await boatInvoke('cloudBoatStartEmailSignIn', { email }));
      if (!challenge) throw normalizeBoatError('boat 로그인 코드를 받지 못했습니다.');
      return challenge;
    },
    async boatPollSignIn(claimId) {
      const raw = record(await boatInvoke('cloudBoatPollSignIn', { claimId }));
      if (raw?.status === 'pending' || raw?.status === 'expired') return { status: raw.status };
      if (raw?.status === 'connected') return { status: 'connected', snapshot: accept(raw.snapshot) };
      throw normalizeBoatError('boat 로그인 상태를 확인하지 못했습니다.');
    },
    boatConnectApiKey: async (apiKey) => accept(await boatInvoke('cloudBoatConnectApiKey', { apiKey })),
    async boatOpenLink(kind, claimId) {
      const raw = record(await boatInvoke('cloudBoatOpenLink', { kind, ...(claimId ? { claimId } : {}) }));
      return raw?.opened === true;
    },
    boatSetup: async (machine) => accept(await boatInvoke('cloudBoatSetup', { machine })),
    boatWake: async () => accept(await boatInvoke('cloudBoatWake')),
    boatStop: async () => accept(await boatInvoke('cloudBoatStop')),
    boatRefresh: async () => accept(await boatInvoke('cloudBoatRefresh')),
    boatDisconnect: async (deleteServer) => accept(await boatInvoke('cloudBoatDisconnect', { deleteServer })),
    subscribe(listener) {
      listeners.add(listener);
      listener(snapshot);
      return () => listeners.delete(listener);
    },
    subscribeEvents(listener) {
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      displayGeneration += 1;
      if (activeDisplay) void closeDisplay(activeDisplay).catch(() => {});
      listeners.clear();
      eventListeners.clear();
      pendingDisplayEvents.clear();
      if (typeof unsubscribeHost === 'function') unsubscribeHost();
      if (typeof unsubscribeDisplayHost === 'function') unsubscribeDisplayHost();
    },
  };
}
