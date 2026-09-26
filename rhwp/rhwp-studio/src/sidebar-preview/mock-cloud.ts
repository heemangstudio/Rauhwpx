import { createCloudController, type CloudDesktopApi } from '../cloud/desktop-cloud.ts';
import type { AgentName, AgentStreamEvent } from '../agent/types.ts';
import type { CloudSessionState, CloudLinkKind, CloudSessionScope, CloudSnapshot, CloudTransferRequest, CloudCheckpointPayload, CloudCommandRequest,
  BoatServerSnapshot, BoatServerState, BoatSetupStage, BoatSnapshot } from '../cloud/types.ts';
import { recordCloudUsage } from '../cloud/usage-history.ts';
import { createEmptyThread } from '../agent/threads.ts';
import { exportCloudTimeline } from '../cloud/timeline.ts';

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** 미리보기의 boat 계정. 실제 boat.dev 에는 닿지 않는다. */
export type BoatPreviewState =
  | 'off' | 'connected' | 'billing' | 'existing' | 'setup' | 'failed'
  | 'running' | 'stopped' | 'waking' | 'stopping' | 'missing' | 'error';

export interface BoatPreviewScenario {
  /** 다음 API 키 연결을 한 번 거절한다. */
  invalidKey: boolean;
  /** 계정을 연결하면 요금제가 없다고 답하고, 결제 페이지를 연 뒤에 풀린다. */
  billingRequired: boolean;
  /** 첫 로그인 코드는 첫 확인에서 만료된다. */
  expireFirstCode: boolean;
  /** 계정에 이미 Rauhwpx Cloud VM 이 있어 새로 만들지 않고 가져온다. */
  existingServer: boolean;
  /** 남은 설치 실패 횟수. 실패할 때마다 하나씩 줄어든다. */
  installFailures: number;
  /** 계정이 VM 의 자기 중지를 막아, 시작 후 정해진 시간에 멈춘다. */
  timerAutoStop: boolean;
  /** 예전 데스크톱처럼 다시 시도에도 첫 시도의 시작 시각을 보낸다. */
  reuseSetupClock: boolean;
}

const BOAT_SANDBOX_ID = 'bx_7k2m9q4d';

/** Local failure fixtures that exercise the production IPC adapter and sidebar. */
export function createMockCloud(options: { dashboard?: boolean } = {}) {
  let listener: ((event: unknown) => void) | null = null;
  let displayListener: ((event: unknown) => void) | null = null;
  let scope: CloudSessionScope = { threadId: '', documentId: null };
  let sessionNumber = 0;
  let recoveryGeneration = 0;
  let releaseRefresh: (() => void) | null = null;
  let refreshBlocked = false;
  let sequence = 0;
  const checkpoints = new Map<string, CloudCheckpointPayload>();
  const dashboardTimelines = new Map<string, CloudSnapshot['timeline']>();
  const editSessions = new Map<string, string>();
  const merges: Array<{ startId: string; checkpoint: CloudCheckpointPayload }> = [];
  const calls = { boat: [] as string[], commands: [] as CloudCommandRequest[], merges, downloads: 0, spawn: 0,
    spawnPayloads: [] as Array<{ providerId?: string; selectedProvider?: AgentName }>,
    teardown: 0, refresh: 0, referenceReads: 0, prepareRestart: 0, reconnect: 0, recreate: 0,
    stop: 0, display: 0, inputs: 0, transfers: [] as CloudTransferRequest[] };
  let refreshFails = false;
  let reconnectBlocked = false;
  let releaseReconnect: (() => void) | null = null;
  let spawnFailures = 0;
  let sandboxStatusRecovers = false;
  let queueAckFailures = 0;
  let queueReceiptBlocked = false;
  let releaseQueueReceipt: (() => void) | null = null;
  let restartArchiveAvailable = true;
  let rejectRestartTransfer = false;
  // boat: 지연은 실제 흐름과 비슷하게 두고, 검사는 배속으로 줄인다.
  let boatSpeed = 1;
  let boatClaims = 0;
  const boatScenario: BoatPreviewScenario = {
    invalidKey: false, billingRequired: false, expireFirstCode: false, existingServer: false, installFailures: 0,
    timerAutoStop: false, reuseSetupClock: false,
  };
  const claims = new Map<string, { email: string; polls: number; expireNow: boolean }>();
  let holdWake = false;
  let releaseWake: (() => void) | null = null;
  const boatWait = (ms: number) => wait(Math.max(40, Math.round(ms * boatSpeed)));
  const sandbox = { providerId: 'raucloud', sandboxId: 'preview-worker', displayName: 'Raucloud',
    region: 'preview', host: 'preview.invalid', createdAt: new Date().toISOString() };
  const state: CloudSnapshot = {
    revision: 0, profileEpoch: 0, available: true,
    profile: { kind: 'configured', mode: 'app-hosted', name: 'Raucloud', sandbox,
      connection: 'ready', message: null, serviceVersion: 'preview' },
    server: { mode: 'app-hosted', preferredMode: 'app-hosted', lifecycle: 'ready', message: null,
      providers: [{ providerId: 'raucloud', displayName: 'Raucloud', configured: true, missingConfig: [] }] },
    account: { signedIn: true, account: { id: 'preview', email: 'preview@example.invalid' }, quota: null,
      raucloud: { kind: 'available' }, updatedAt: new Date().toISOString() },
    session: { kind: 'idle' }, sessions: [], lease: { owner: 'local' }, timeline: null,
    queuedMessages: [], updatedAt: new Date().toISOString(),
    link: { kind: 'ready', error: null, attempt: 0, canRecreate: true },
    boat: { account: { connected: false, method: null, email: null, canStart: null, trial: null }, server: null, setup: null },
  };
  const boat = () => state.boat as BoatSnapshot;
  // Explicit preview-only observations. Production never invents usage history.
  if (options.dashboard) {
    const now = new Date();
    const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    state.profile = { kind: 'configured', mode: 'app-hosted', name: 'My Raucloud',
      sandbox: { ...sandbox, region: 'Seoul', host: 'my-workspace.raucloud.example' },
      connection: 'ready', message: null, serviceVersion: '1.1.0' };
    state.account!.account!.id = 'dashboard-preview';
    const values = [18, 32, 24, 51, 38, 62, 36];
    values.forEach((used, index) => {
      const day = new Date(today.getTime() - (6 - index) * 86_400_000);
      state.account!.updatedAt = new Date(day.getTime() + 3_600_000).toISOString();
      state.account!.quota = { usedMs: used * 60_000, remainingMs: (120 - used) * 60_000,
        dailyLimitMs: 120 * 60_000, resetAt: new Date(day.getTime() + 86_400_000).toISOString(),
        timeZone: 'UTC', debtMs: 0, graceUsedMs: 0, activeRun: null,
        coldStarts: { usedToday: 2, dailyLimit: 10, recent: 1, recentLimit: 5 } };
      recordCloudUsage(state);
    });
    const names = ['사업 제안서.hwpx', '9월 제품 기획.hwpx', '팀 회의록.hwpx', '리서치 노트.hwpx'];
    state.sessions = names.map((documentName, index) => ({ kind: 'suspended',
      sessionId: `dashboard-session-${index}`, threadId: `dashboard-chat-${index}`, documentId: `dashboard-doc-${index}`,
      documentName, version: 1, reason: '사용자가 일시 정지했습니다.', resumable: true,
      selection: { agent: index % 2 === 0 ? 'codex' : 'claude', model: index % 2 === 0 ? 'gpt-5.4' : 'claude-sonnet-4-6', effort: 'high' } }));
    state.sessions = state.sessions.map((task, index): Exclude<CloudSessionState, { kind: 'idle' }> => {
      if (index === 3) return task;
      if (index === 2) return { ...task, kind: 'completed', completedAt: now.toISOString(),
        result: { fileName: task.documentName, byteLength: 2048, sha256: 'a'.repeat(64),
          downloaded: true, availableOnThisDevice: true, expiresAt: null, conflict: 'none', preservedCopyName: null } };
      return { ...task, kind: 'running', startedAt: now.toISOString(), turn: 1, turnLimit: 100,
        elapsedMs: 42000, timeLimitMs: 3600000, currentActivity: '문서 검토 중',
        phase: index === 1 ? 'awaiting-question-answer' : 'working',
        wait: index === 1 ? { id: 'preview-question', kind: 'question', payload: { prompt: '어떤 독자를 위한 문서인가요?' } } : null };
    });
    state.sessions.forEach(task => {
      const thread = createEmptyThread({ agent: task.selection!.agent, model: task.selection!.model,
        effort: task.selection!.effort, docKey: task.documentName, documentId: task.documentId });
      thread.id = task.threadId;
      thread.executionMode = 'cloud';
      thread.cloudSessionId = task.sessionId;
      thread.messages = [{ role: 'user', text: `${task.documentName}의 내용을 검토해 주세요.` }];
      dashboardTimelines.set(task.sessionId, exportCloudTimeline(thread));
    });
    const completed = state.sessions.find((task) => task.kind === 'completed');
    if (completed) {
      const checkpoint: CloudCheckpointPayload = {
        sessionId: completed.sessionId,
        documentId: completed.documentId,
        fileName: completed.documentName,
        kind: 'turn',
        revision: 1,
        turn: 1,
        operationId: `dashboard-turn-${completed.sessionId}`,
        bytes: new Uint8Array([1, 2, 3]),
        byteLength: 3,
        sha256: 'a'.repeat(64),
      };
      checkpoints.set(completed.sessionId, checkpoint);
      state.mergeRequests = [{
        sessionId: completed.sessionId,
        documentId: completed.documentId!,
        threadId: completed.threadId,
        cloudStartId: completed.sessionId,
        operationId: checkpoint.operationId,
        revision: checkpoint.revision,
        turn: checkpoint.turn,
        kind: 'turn',
        fileName: checkpoint.fileName,
        sha256: checkpoint.sha256,
        size: checkpoint.byteLength,
        localAvailable: true,
      }];
    }
  }
  function snapshot(): CloudSnapshot {
    state.revision++;
    const selected = scope.selectedSessionId
      ? state.sessions.find((session) => session.sessionId === scope.selectedSessionId)
      : state.sessions.find((session) => session.threadId === scope.threadId && session.documentId === scope.documentId);
    return structuredClone({ ...state,
      session: selected ?? { kind: 'idle' },
      timeline: selected ? dashboardTimelines.get(selected.sessionId) ?? state.timeline : null,
    });
  }
  function publish() { listener?.({ snapshot: snapshot() }); }
  function emitAgentEvent(event: AgentStreamEvent) {
    if (state.session.kind === 'idle') return;
    listener?.({ sessionId: state.session.sessionId,
      event: { type: 'agent.event', seq: ++sequence, payload: { type: 'agent', event } } });
  }
  function setLink(kind: CloudLinkKind) {
    state.link = { kind, error: kind === 'failed' ? 'ECONNRESET from preview fixture' : null,
      attempt: kind === 'ready' ? 0 : 1, canRecreate: !boatActive() };
    publish();
  }
  function idle() {
    state.profileEpoch++;
    state.session = { kind: 'idle' };
    state.sessions = [];
    state.timeline = null;
    state.lease = { owner: 'local' };
  }
  function boatError(code: string, message: string): { name: string; message: string; code: string } {
    // 데스크톱 preload 처럼 contextBridge 를 건너온 오류 모양 객체로 거절한다.
    return { name: 'BoatError', message, code };
  }
  function connectBoatAccount(method: 'email' | 'api-key', email: string | null) {
    boat().account = { connected: true, method, email, canStart: !boatScenario.billingRequired, trial: false };
    if (boatScenario.existingServer && !boat().server) boat().server = boatServer('stopped');
  }
  function boatServer(serverState: BoatServerState): BoatServerSnapshot {
    return { sandboxId: BOAT_SANDBOX_ID, state: serverState, machine: 'default', machineLabel: '4 vCPU · 8 GB',
      region: 'EU', monthHours: 12.5, idleStopMinutes: 30,
      autoStop: boatScenario.timerAutoStop ? 'timer' : 'idle', timerHours: boatScenario.timerAutoStop ? 4 : null,
      message: serverState === 'error' ? 'boat가 VM을 다시 시작하지 못했습니다.' : null };
  }
  function useBoatProfile(serverState: BoatServerState, bumpEpoch = true) {
    // 화면 고정용 설정은 세대를 올리지 않는다. 진행 중이던 새로고침이 낡은 세대로 거절되지 않게 한다.
    if (bumpEpoch) state.profileEpoch++;
    state.profile = { kind: 'configured', mode: 'self-hosted', connection: 'ready', message: null, serviceVersion: '1.2.0',
      profile: { name: 'boat', host: '46.225.12.34', sshUser: 'user', sshPort: 22,
        auth: { kind: 'key-file', keyPath: '~/Library/Application Support/Rauhwpx/cloud/boat_ed25519' },
        transport: { kind: 'ssh-tunnel' }, boat: { sandboxId: BOAT_SANDBOX_ID, machine: 'default' } } };
    state.server.mode = 'self-hosted';
    state.server.lifecycle = 'idle';
    boat().account = { connected: true, method: 'api-key', email: null, canStart: true, trial: false };
    boat().server = boatServer(serverState);
    // 쉬는 VM 도 연결은 준비된 것으로 둔다. 보내기·열기가 데스크톱에서 VM 을 깨운다.
    state.link = { kind: serverState === 'waking' ? 'reconnecting' : 'ready', error: null, attempt: 0, canRecreate: false };
  }
  function setBoatStage(stage: BoatSetupStage, detail: string | null) {
    const setup = boat().setup;
    if (!setup) return;
    boat().setup = { ...setup, stage, detail };
    publish();
  }
  async function wakeBoat() {
    const server = boat().server;
    if (!server || server.state === 'running') return;
    boat().server = { ...server, state: 'waking' };
    state.link = { kind: 'reconnecting', error: null, attempt: 1, canRecreate: false };
    publish();
    if (holdWake) await new Promise<void>((resolve) => { releaseWake = resolve; });
    await boatWait(2_800);
    boat().server = { ...boat().server!, state: 'running' };
    state.link = { kind: 'ready', error: null, attempt: 0, canRecreate: false };
    publish();
  }
  function boatActive() {
    return state.profile.kind === 'configured' && state.profile.mode === 'self-hosted' && Boolean(state.profile.profile.boat);
  }
  const api: CloudDesktopApi = {
    async cloudBeginEdit({ sessionId }) {
      const task = state.sessions.find(entry => entry.sessionId === sessionId);
      if (!task) throw new Error('작업을 찾을 수 없습니다.');
      const editSessionId = editSessions.get(sessionId) ?? `preview-edit-${sessionId}`;
      editSessions.set(sessionId, editSessionId);
      state.session = { ...task, kind: 'suspended', version: task.version + 1,
        reason: '문서 편집 중', resumable: true };
      state.sessions = state.sessions.map(entry => entry.sessionId === sessionId ? state.session as Exclude<CloudSessionState, {kind: 'idle'}> : entry);
      publish();
      return { snapshot: snapshot(), editDraft: { sessionId, editSessionId,
        boundary: { operationId: 'preview-pause', revision: 1, writerGeneration: 1, stateVersion: state.session.version },
        fileName: task.documentName, savedAt: new Date().toISOString() } };
    },
    async cloudContinueEdit({ sessionId, editSessionId }) {
      const task = state.sessions.find(entry => entry.sessionId === sessionId);
      if (!task || editSessions.get(sessionId) !== editSessionId) throw new Error('편집 세션이 바뀌었습니다.');
      state.session = { ...task, kind: 'running', version: task.version + 1,
        startedAt: new Date().toISOString(), turn: 1, turnLimit: 100, elapsedMs: 0, timeLimitMs: 3600000,
        currentActivity: '수정한 문서에서 이어서 작업 중', phase: 'working', wait: null };
      state.sessions = state.sessions.map(entry => entry.sessionId === sessionId ? state.session as Exclude<CloudSessionState, {kind: 'idle'}> : entry);
      editSessions.delete(sessionId);
      publish();
      return snapshot();
    },
    async cloudGetState(next) {
      calls.refresh++;
      scope = next;
      if (refreshBlocked) await new Promise<void>((resolve) => { releaseRefresh = resolve; });
      if (refreshFails) throw new Error('Preview connection unavailable');
      return snapshot();
    },
    async cloudDownloadCheckpoint({ sessionId, operationId, explicit }) {
      calls.downloads++;
      // 자동 조회는 쉬는 boat VM 을 깨우지 않고 조용히 거절한다. 사용자가 누른 조회만 깨운다.
      if (boatActive() && boat().server?.state !== 'running') {
        if (!explicit) throw boatError('BOAT_SERVER_STOPPED', 'boat 서버가 정지되어 있습니다.');
        await wakeBoat();
      }
      const checkpoint = checkpoints.get(sessionId);
      if (!checkpoint || (operationId && checkpoint.operationId !== operationId)) throw new Error('완료된 턴이 없습니다.');
      return structuredClone(checkpoint);
    },
    cloudSetTransferIntent: async () => snapshot(),
    async cloudTransfer(request) {
      if (request.document.restartToken && rejectRestartTransfer) throw new Error('Preview restart transfer interrupted.');
      // 보내기는 사용자의 의도다. 쉬던 boat VM 을 먼저 깨운다.
      if (boatActive() && boat().server?.state !== 'running') await wakeBoat();
      calls.transfers.push(structuredClone(request));
      state.timeline = structuredClone(request.timeline);
      state.session = { kind: 'running', sessionId: `preview-session-${++sessionNumber}`, version: 1,
        threadId: request.threadId, documentId: request.documentId, documentName: request.documentName,
        handoffAcceptedAt: new Date().toISOString(),
        startedAt: new Date().toISOString(), turn: 0, turnLimit: 100, elapsedMs: 0, timeLimitMs: 3600000,
        currentActivity: '문서 검토 중', phase: 'waiting', wait: null,
        selection: { agent: request.timeline.thread.agent, model: request.timeline.thread.model, effort: request.timeline.thread.effort },
        configurationPending: false, configurationEditable: true };
      state.sessions = [state.session];
      scope = { threadId: request.threadId, documentId: request.documentId, selectedSessionId: state.session.sessionId };
      state.lease = { owner: 'cloud', sessionId: state.session.sessionId, threadId: request.threadId, acquiredAt: new Date().toISOString() };
      publish();
      return snapshot();
    },
    async cloudReconnectLink() {
      calls.reconnect++;
      const generation = ++recoveryGeneration;
      setLink('reconnecting');
      if (reconnectBlocked) await new Promise<void>((resolve) => { releaseReconnect = resolve; });
      await wait(300);
      if (generation !== recoveryGeneration) throw new DOMException('Cancelled', 'AbortError');
      setLink('ready');
      return snapshot();
    },
    async cloudReadReference() {
      calls.referenceReads++;
      return { bytes: new Uint8Array(42800).fill(7) };
    },
    async cloudPrepareRestartDocument({ sessionId }) {
      calls.prepareRestart++;
      if (!restartArchiveAvailable) throw new Error('최신 Cloud 문서 보관본을 확인할 수 없습니다.');
      const transfer = calls.transfers.at(-1) ?? JSON.parse(sessionStorage.getItem('preview-cloud-restart-transfer') ?? 'null');
      if (!transfer) {
        throw new Error('Cloud 복구 세션을 찾을 수 없습니다.');
      }
      sessionStorage.setItem('preview-cloud-restart-transfer', JSON.stringify(transfer));
      const bytes = new TextEncoder().encode('Archived Cloud edits after the original transfer.');
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
      return { bytes, fileName: transfer.document.fileName,
        sha256: Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join(''),
        originSha256: transfer.document.originSha256 ?? null, restartToken: `preview-restart-${sessionId}` };
    },
    async cloudRecreateLink() {
      calls.recreate++;
      recoveryGeneration++;
      setLink('recreating');
      await wait(200);
      idle();
      setLink('ready');
      return snapshot();
    },
    async cloudForceQuitAccount() {
      calls.stop++;
      recoveryGeneration++;
      idle();
      setLink('ready');
      return snapshot();
    },
    async cloudSelectServerMode({ mode }) {
      state.server.preferredMode = mode;
      return snapshot();
    },
    async cloudSpawnSandbox(payload) {
      calls.spawn++;
      calls.spawnPayloads.push(structuredClone(payload));
      state.server.lifecycle = 'provisioning';
      publish();
      await wait(300);
      if (spawnFailures > 0) {
        spawnFailures--;
        state.server.lifecycle = 'error';
        state.server.message = 'Preview sandbox allocation was interrupted.';
        state.profile = { kind: 'configured', mode: 'app-hosted', name: 'Raucloud', sandbox,
          connection: 'unknown', message: state.server.message, serviceVersion: 'preview' };
        publish();
        throw new Error(state.server.message);
      }
      state.profileEpoch++;
      state.profile = { kind: 'configured', mode: 'app-hosted', name: 'Raucloud', sandbox,
        connection: 'ready', message: null, serviceVersion: 'preview' };
      state.server.mode = 'app-hosted';
      state.server.lifecycle = 'ready';
      publish();
      return snapshot();
    },
    async cloudTeardownSandbox() {
      calls.teardown++;
      idle();
      state.profile = { kind: 'unconfigured' };
      state.server.lifecycle = 'idle';
      publish();
      return snapshot();
    },
    async cloudSandboxStatus() {
      if (sandboxStatusRecovers) {
        sandboxStatusRecovers = false;
        state.profile = { kind: 'configured', mode: 'app-hosted', name: 'Raucloud', sandbox,
          connection: 'ready', message: null, serviceVersion: 'preview' };
        state.server.mode = 'app-hosted';
        state.server.lifecycle = 'ready';
        state.server.message = null;
      }
      return snapshot();
    },
    async cloudCommand(request) {
      calls.commands.push(structuredClone(request));
      if (request.command === 'queue-message' && queueReceiptBlocked) {
        await new Promise<void>((resolve) => { releaseQueueReceipt = resolve; });
        releaseQueueReceipt = null;
      }
      if (request.command === 'queue-message' && queueAckFailures > 0) {
        queueAckFailures--;
        state.queuedMessages = [{
          id: request.messageId!,
          text: request.message!,
          queuedAt: new Date().toISOString(),
          state: 'queued',
          delivery: 'pending',
        }];
        publish();
        throw new Error('Preview queue receipt was lost.');
      }
      if (request.command === 'queue-message') {
        state.queuedMessages = [{
          id: request.messageId!,
          text: request.message!,
          queuedAt: state.queuedMessages.find((message) => message.id === request.messageId)?.queuedAt
            ?? new Date().toISOString(),
          state: 'queued',
          delivery: 'durable',
        }];
        publish();
      }
      if (request.command === 'configure') {
        const session = state.session;
        if (session.kind === 'idle' || request.sessionId !== session.sessionId
          || request.expectedVersion !== session.version || session.configurationEditable !== true) {
          throw new Error('Provider settings can only change between turns');
        }
        const payload = request.payload!;
        session.selection = { agent: payload.provider as import('../agent/types.ts').AgentName,
          model: String(payload.model), effort: String(payload.effort) };
        session.version++;
        publish();
      }
      return snapshot();
    },
    async cloudOpenDisplay({ sessionId }) {
      calls.display++;
      const connectionId = `display-${calls.display}`;
      const streamId = `stream-${sessionId}`;
      const capability = { kind: 'available', protocol: 'rauhwpx-frame-v1', inputProtocol: 'rauhwpx-input-v1',
        sessionId, streamId, width: 680, height: 840, maxFrameBytes: 524288, maxFps: 12, maxInputEventsPerSecond: 60 };
      const canvas = document.createElement('canvas');
      canvas.width = 680; canvas.height = 840;
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 680, 840);
      ctx.fillStyle = '#26323d'; ctx.font = 'bold 28px sans-serif'; ctx.fillText('사업 제안서', 64, 100);
      ctx.font = '16px sans-serif'; ctx.fillText('Cloud 문서 미리보기', 64, 142);
      ctx.fillStyle = '#dce3e8';
      for (let row = 0; row < 16; row++) ctx.fillRect(64, 208 + row * 28, row % 4 === 3 ? 360 : 552, 9);
      const jpeg = await new Promise<Blob>((resolve) => canvas.toBlob((blob) => resolve(blob!), 'image/jpeg'));
      const bytes = new Uint8Array(await jpeg.arrayBuffer());
      setTimeout(() => displayListener?.({ connectionId, event: {
        kind: 'frame', sessionId, streamId, sequence: 1, capturedAt: new Date().toISOString(), width: 680, height: 840,
        mimeType: 'image/jpeg', byteLength: bytes.length, sha256: 'a'.repeat(64),
        framePath: `/v1/sessions/${sessionId}/display/frames/${streamId}/1`, bytes,
      } }), 30);
      return { connectionId, capability };
    },
    cloudCloseDisplay: async () => ({}),
    cloudDisplayInput: async () => { calls.inputs++; return {}; },
    async cloudBoatStartEmailSignIn({ email }) {
      calls.boat.push('email-start');
      await boatWait(700);
      if (/invalid/i.test(email)) throw boatError('BOAT_AUTH_INVALID', '이 이메일로 boat에 로그인할 수 없습니다.');
      const claimId = `claim-${++boatClaims}`;
      claims.set(claimId, { email, polls: 0, expireNow: boatScenario.expireFirstCode && boatClaims === 1 });
      const code = String(100_000 + ((boatClaims * 382_571) % 900_000));
      return { claimId, verificationUri: 'https://boat.dev/activate', userCode: code,
        expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
        intervalSeconds: Math.max(1, Math.round(2 * boatSpeed)) };
    },
    async cloudBoatPollSignIn({ claimId }) {
      calls.boat.push('email-poll');
      await boatWait(250);
      const claim = claims.get(claimId);
      if (!claim) throw boatError('BOAT_AUTH_INVALID', '로그인 요청을 찾을 수 없습니다.');
      if (claim.expireNow) return { status: 'expired' };
      claim.polls += 1;
      if (claim.polls < 3) return { status: 'pending' };
      claims.delete(claimId);
      connectBoatAccount('email', claim.email);
      publish();
      return { status: 'connected', snapshot: snapshot() };
    },
    async cloudBoatConnectApiKey({ apiKey }) {
      calls.boat.push('connect-key');
      await boatWait(900);
      if (boatScenario.invalidKey || /invalid/i.test(apiKey)) {
        boatScenario.invalidKey = false;
        throw boatError('BOAT_AUTH_INVALID', 'boat가 이 API 키를 거절했습니다.');
      }
      connectBoatAccount('api-key', null);
      publish();
      return snapshot();
    },
    async cloudBoatOpenLink({ kind }) {
      calls.boat.push(`open-${kind}`);
      await boatWait(250);
      if (kind === 'checkout') {
        // 결제를 마친 것처럼 잠시 뒤 요금제가 생긴다.
        void boatWait(3_200).then(() => {
          if (!boat().account.connected) return;
          boat().account = { ...boat().account, canStart: true };
          boatScenario.billingRequired = false;
          publish();
        });
      }
      return { opened: true };
    },
    async cloudBoatSetup({ machine }) {
      calls.boat.push(`setup-${machine}`);
      const adopt = Boolean(boat().server);
      // 예전 데스크톱의 설정 기록은 1분 전에 시작한 첫 시도의 시각을 계속 쓴다.
      const startedAt = boatScenario.reuseSetupClock
        ? boat().setup?.startedAt ?? new Date(Date.now() - 60_000).toISOString()
        : new Date().toISOString();
      boat().setup = { stage: adopt ? 'starting' : 'creating', startedAt,
        detail: adopt ? '기존 Rauhwpx Cloud VM 찾음' : 'Rauhwpx Cloud VM 요청', error: null, importedProviders: [] };
      publish();
      if (!adopt) {
        await boatWait(1_600);
        boat().server = { ...boatServer('waking'), monthHours: 0 };
        setBoatStage('starting', 'VM 시작 대기');
      }
      await boatWait(1_800);
      boat().server = { ...boat().server!, state: 'running' };
      setBoatStage('installing', 'podman 설치');
      await boatWait(1_500);
      if (boatScenario.installFailures > 0) {
        boatScenario.installFailures -= 1;
        boat().setup = { ...boat().setup!, error: {
          title: 'Cloud 설치를 마치지 못했습니다',
          guidance: '네트워크를 확인한 뒤 다시 시도합니다.',
          detail: 'install.sh: apt-get install podman\nE: Unable to fetch some archives, maybe run apt-get update\nexit status 100',
        } };
        publish();
        throw boatError('BOAT_SETUP_FAILED', 'Cloud 설치를 마치지 못했습니다.');
      }
      setBoatStage('installing', 'Cloud 서비스 내려받기 · rauhwpx-cloud 1.2.0 (linux-amd64)');
      await boatWait(1_500);
      setBoatStage('installing', '서비스 등록');
      await boatWait(1_300);
      setBoatStage('pairing', '서버 ID 확인');
      await boatWait(1_200);
      setBoatStage('credentials', 'Claude · Codex 로그인 복사');
      await boatWait(1_000);
      useBoatProfile('running');
      boat().server = { ...boat().server!, monthHours: 0.1 };
      boat().setup = { ...boat().setup!, stage: 'done', detail: null, importedProviders: ['claude', 'codex'] };
      publish();
      return snapshot();
    },
    async cloudBoatWake() {
      calls.boat.push('wake');
      await wakeBoat();
      return snapshot();
    },
    async cloudBoatStop() {
      calls.boat.push('stop');
      const server = boat().server;
      if (!server) throw boatError('BOAT_UNAVAILABLE', 'boat 서버를 찾을 수 없습니다.');
      boat().server = { ...server, state: 'stopping' };
      publish();
      await boatWait(1_600);
      boat().server = { ...boat().server!, state: 'stopped' };
      publish();
      return snapshot();
    },
    async cloudBoatRefresh() {
      calls.boat.push('refresh');
      await boatWait(300);
      return snapshot();
    },
    async cloudBoatDisconnect({ deleteServer }) {
      calls.boat.push(deleteServer ? 'delete' : 'disconnect');
      await boatWait(deleteServer ? 2_000 : 700);
      idle();
      state.profile = { kind: 'unconfigured' };
      state.link = { kind: 'ready', error: null, attempt: 0, canRecreate: true };
      // 연결만 풀면 VM 은 계정에 남는다. 다음 설정이 그 VM 을 가져온다.
      boatScenario.existingServer = !deleteServer;
      boat().server = deleteServer ? null : { ...boat().server ?? boatServer('stopped'), state: 'stopped' };
      boat().setup = null;
      publish();
      return snapshot();
    },
    onCloudEvent(callback) { listener = callback; return () => { listener = null; }; },
    onCloudDisplayEvent(callback) { displayListener = callback; return () => { displayListener = null; }; },
  };
  return {
    controller: createCloudController(api), calls, setLink,
    setAccount(signedIn: boolean, email: string | null) {
      state.account = signedIn
        ? { signedIn: true, account: { id: state.account?.account?.id ?? 'preview', email: email ?? 'designer@example.test' }, quota: state.account?.quota ?? null,
            raucloud: { kind: 'available' }, updatedAt: new Date().toISOString() }
        : { signedIn: false, account: null, quota: null,
            raucloud: { kind: 'logged-out' }, updatedAt: new Date().toISOString() };
      publish();
    },
    emitAgentEvent,
    openNotification(sessionId: string, operationId?: string) {
      listener?.({ type: 'notification-open', sessionId, ...(operationId ? { operationId } : {}) });
    },
    publishTimeline(timeline: NonNullable<CloudSnapshot['timeline']>) {
      state.timeline = structuredClone(timeline);
      publish();
    },
    emitStreamError(retryable: boolean, error = 'Pair this device again') {
      if (state.session.kind === 'idle') return;
      if (!retryable) {
        state.link = { kind: 'failed', error, attempt: 1, canRecreate: true };
        publish();
      }
      listener?.({ type: 'session-stream-error', sessionId: state.session.sessionId, retryable, error });
    },
    finishReply(text: string) {
      if (!state.timeline) throw new Error('Start a Cloud conversation first');
      state.timeline.thread.messages.push({ role: 'assistant', text, agent: state.timeline.thread.agent });
      state.timeline.thread.updatedAt = Date.now();
      state.timeline.exportedAt = new Date().toISOString();
      emitAgentEvent({ type: 'text-delta', agent: state.timeline.thread.agent, text });
      emitAgentEvent({ type: 'turn-end', agent: state.timeline.thread.agent, stopReason: 'completed' });
      publish();
    },
    commitTurn() {
      const session = state.session;
      if (session.kind !== 'running') throw new Error('Start a Cloud conversation first');
      session.turn++;
      session.phase = 'waiting';
      const operationId = `preview-turn-${session.turn}`;
      state.queuedMessages = state.queuedMessages.map((message) => ({ ...message, state: 'accepted' }));
      checkpoints.set(session.sessionId, { sessionId: session.sessionId, documentId: session.documentId,
        fileName: '사업 제안서.hwpx', kind: 'turn', revision: session.turn, turn: session.turn, operationId,
        bytes: new Uint8Array([1, 2, 3]), byteLength: 3, sha256: 'a'.repeat(64) });
      state.sessions = state.sessions.map((item) => item.sessionId === session.sessionId ? session : item);
      listener?.({ sessionId: session.sessionId,
        event: { type: 'boundary.committed', payload: { kind: 'turn', operationId } } });
      publish();
    },
    setConversationPhase(phase: 'working' | 'waiting' | 'suspended') {
      const session = state.session;
      if (session.kind === 'idle') throw new Error('Start a Cloud conversation first');
      const base = { sessionId: session.sessionId, threadId: session.threadId, documentId: session.documentId,
        documentName: session.documentName, version: session.version + 1, selection: session.selection,
        handoffAcceptedAt: session.handoffAcceptedAt,
        configurationPending: false, configurationEditable: phase !== 'working' };
      const next: Exclude<CloudSessionState, { kind: 'idle' }> = phase === 'suspended'
        ? { ...base, kind: 'suspended', reason: '사용자가 일시 정지했습니다.', resumable: true }
        : { ...base, kind: 'running', phase, wait: null, currentActivity: '문서 검토',
            startedAt: new Date().toISOString(), turn: checkpoints.get(session.sessionId)?.turn ?? 0, turnLimit: 100, elapsedMs: 0, timeLimitMs: 3600000 };
      state.session = next;
      state.sessions = state.sessions.map((item) => item.sessionId === session.sessionId ? next : item);
      publish();
    },
    getScope: () => scope,
    requireReference(id: string | null) {
      const message = state.timeline?.thread.messages.find((item) => item.role === 'user');
      if (!message || !state.timeline) return;
      message.attachments = id ? [{ stageId: id, fileId: id, name: '브랜드 가이드.pdf', mimeType: 'application/pdf', size: 42800, status: 'ready' }] : [];
      state.timeline.exportedAt = new Date().toISOString();
      state.timeline.thread.updatedAt = Date.now();
      publish();
    },
    setRestartArchiveAvailable(available: boolean) { restartArchiveAvailable = available; },
    setSpawnFailures(count: number) { spawnFailures = Math.max(0, Math.floor(count)); },
    setSandboxStatusRecovery(enabled: boolean) { sandboxStatusRecovers = enabled; },
    setQueueAckFailures(count: number) { queueAckFailures = Math.max(0, Math.floor(count)); },
    blockQueueReceipt(blocked: boolean) {
      queueReceiptBlocked = blocked;
      if (!blocked) releaseQueueReceipt?.();
    },
    rejectRestartTransfer(reject: boolean) { rejectRestartTransfer = reject; },
    blockRefresh(blocked: boolean) {
      refreshBlocked = blocked;
      if (!blocked) { releaseRefresh?.(); releaseRefresh = null; }
    },
    blockReconnect(blocked: boolean) {
      reconnectBlocked = blocked;
      if (!blocked) { releaseReconnect?.(); releaseReconnect = null; }
    },
    publish,
    setBoatSpeed(speed: number) { boatSpeed = Math.max(0.05, speed); },
    /** 깨우는 중 화면을 오래 보도록 VM 시작을 붙잡는다. */
    holdBoatWake(hold: boolean) {
      holdWake = hold;
      if (!hold) { releaseWake?.(); releaseWake = null; }
    },
    setBoatScenario(next: Partial<BoatPreviewScenario>) { Object.assign(boatScenario, next); },
    /** 스크린샷과 검사용. 계정·VM·설정 상태를 한 번에 맞춘다. */
    setBoatState(kind: BoatPreviewState) {
      if (kind === 'off') {
        state.boat = { account: { connected: false, method: null, email: null, canStart: null, trial: null }, server: null, setup: null };
        if (boatActive()) state.profile = { kind: 'unconfigured' };
      } else if (kind === 'connected' || kind === 'billing' || kind === 'existing') {
        if (boatActive()) state.profile = { kind: 'unconfigured' };
        boatScenario.billingRequired = kind === 'billing';
        boatScenario.existingServer = kind === 'existing';
        state.boat = { account: { connected: false, method: null, email: null, canStart: null, trial: null }, server: null, setup: null };
        connectBoatAccount('email', 'designer@example.test');
      } else if (kind === 'setup' || kind === 'failed') {
        state.profile = { kind: 'unconfigured' };
        connectBoatAccount('api-key', null);
        boat().server = boatServer('running');
        boat().setup = { stage: 'installing', startedAt: new Date(Date.now() - 83_000).toISOString(),
          detail: 'Cloud 서비스 내려받기 · rauhwpx-cloud 1.2.0 (linux-amd64)', importedProviders: [],
          error: kind === 'failed' ? { title: 'Cloud 설치를 마치지 못했습니다', guidance: '네트워크를 확인한 뒤 다시 시도합니다.',
            detail: 'install.sh: apt-get install podman\nE: Unable to fetch some archives, maybe run apt-get update\nexit status 100' } : null };
      } else {
        useBoatProfile(kind, false);
        boat().setup = null;
      }
      state.server.mode = boatActive() ? 'self-hosted' : state.server.mode;
      publish();
    },
    setRefreshFailure(failed: boolean) { refreshFails = failed; },
    setDashboardState(kind: 'logged-out' | 'exhausted' | 'self-hosted' | 'unknown' | 'unconfigured' | 'unavailable') {
      if (kind === 'logged-out') {
        state.account = { signedIn: false, account: null, quota: null, raucloud: { kind: 'logged-out' }, updatedAt: new Date().toISOString() };
        state.profile = { kind: 'unconfigured' };
        state.sessions = [];
      } else if (kind === 'exhausted' && state.account?.quota) {
        state.account.quota.usedMs = state.account.quota.dailyLimitMs;
        state.account.quota.remainingMs = 0;
        state.account.updatedAt = new Date().toISOString();
        state.account.raucloud = { kind: 'exhausted', resetAt: state.account.quota.resetAt };
      } else if (kind === 'self-hosted') {
        state.profile = { kind: 'configured', mode: 'self-hosted', connection: 'ready', message: null, serviceVersion: '1.1.0',
          profile: { name: 'My VPS', host: 'studio.example', sshUser: 'worker', sshPort: 22, auth: { kind: 'ssh-agent' }, transport: { kind: 'ssh-tunnel' } } };
        state.server.mode = 'self-hosted';
      } else if (kind === 'unknown' && state.profile.kind === 'configured') {
        state.profile.connection = 'unknown';
      } else if (kind === 'unconfigured') {
        state.server.lifecycle = 'idle';
        state.profile = { kind: 'unconfigured' };
        state.sessions = [];
      } else if (kind === 'unavailable') {
        state.available = false;
        state.profile = { kind: 'unconfigured' };
        state.sessions = [];
        delete state.account;
      }
      publish();
    },
  };
}
