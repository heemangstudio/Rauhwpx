import type { DirtyStateChange } from '@/core/document-dirty-state';
import type { EventBus } from '@/core/event-bus';
import {
  autosaveInstanceLockName,
  createAutosaveDraftId,
  deleteAutosaveDraft,
  releaseAutosaveSession,
  saveAutosaveDraft,
  touchAutosaveSession,
  type AutosaveDraft,
  type AutosaveLockManagerLike,
  type AutosaveOwner,
} from './autosave-store.ts';

export interface AutosaveDocumentMeta {
  fileName: string;
  sourceFormat: string;
  draftId?: string;
}

export interface AutosaveStoreLike {
  saveDraft(draft: AutosaveDraft): Promise<void>;
  deleteDraft(id: string): Promise<void>;
  touchSession?(owner: AutosaveOwner, heartbeatAt: number): Promise<void>;
  releaseSession?(sessionId: string): Promise<void>;
}

export interface AutosaveScheduleSettings {
  recoveryEnabled: boolean;
  recoveryIntervalMs: number;
  idleEnabled: boolean;
  idleDelayMs: number;
}

export type AutosaveStatus =
  | { state: 'saving'; reason: string }
  | { state: 'saved'; reason: string; byteLength: number }
  | { state: 'error'; reason: string; error: unknown };

export interface AutosaveManagerOptions {
  exportBytes: () => Uint8Array;
  debounceMs?: number;
  minSaveIntervalMs?: number;
  schedule?: Partial<AutosaveScheduleSettings>;
  now?: () => number;
  idFactory?: () => string;
  store?: AutosaveStoreLike;
  owner?: AutosaveOwner;
  heartbeatIntervalMs?: number;
  /**
   * 페이지 수명 동안 instance lock 을 잡아 draft 소유 페이지가 살아 있음을 알린다.
   * 없으면 heartbeat 만으로 판단한다.
   */
  locks?: AutosaveLockManagerLike | null;
  instanceId?: string;
  /** 저장 실패 뒤 다시 시도하기까지의 대기. 실패할 때마다 두 배로 늘린다. */
  retryDelayMs?: number;
  maxRetryDelayMs?: number;
  logger?: Pick<Console, 'debug' | 'warn'>;
  onStatus?: (status: AutosaveStatus) => void;
}

interface CurrentDocument {
  draftId: string;
  fileName: string;
  sourceFormat: string;
}

const DEFAULT_IDLE_DELAY_MS = 10_000;
const DEFAULT_RECOVERY_INTERVAL_MS = 10 * 60_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 5_000;
const DEFAULT_RETRY_DELAY_MS = 5_000;
const DEFAULT_MAX_RETRY_DELAY_MS = 5 * 60_000;
/** lock 부여가 늦어도 첫 저장을 붙잡지 않는다. 부여 전 저장본은 heartbeat 규칙을 따른다. */
const INSTANCE_LOCK_WAIT_MS = 1_000;

function reasonText(reason: unknown, fallback: string): string {
  return typeof reason === 'string' && reason.length > 0 ? reason : fallback;
}

export class AutosaveManager {
  private readonly exportBytes: () => Uint8Array;
  private readonly now: () => number;
  private readonly idFactory: () => string;
  private readonly store: AutosaveStoreLike;
  private readonly logger: Pick<Console, 'debug' | 'warn'>;
  private readonly onStatus?: (status: AutosaveStatus) => void;

  private current: CurrentDocument | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private recoveryTimer: ReturnType<typeof setTimeout> | null = null;
  private lastSavedAt = 0;
  private saving = false;
  private pendingReason: string | null = null;
  private owner: AutosaveOwner | null = null;
  private ownerHeartbeatAt = 0;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private readonly heartbeatIntervalMs: number;
  private disposed = false;
  /** discard 세대 — 진행 중이던 saveDraft가 discard 이후 완료되며 draft를 부활시키는 경합 감지용 */
  private discardGeneration = 0;
  private scheduleSettings: AutosaveScheduleSettings;
  private readonly instanceId: string;
  private instanceLockHeld = false;
  private instanceLockPending = false;
  private readonly instanceLockReady: Promise<void>;
  private releaseInstanceLock: (() => void) | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryAttempt = 0;
  private readonly retryDelayMs: number;
  private readonly maxRetryDelayMs: number;

  constructor(options: AutosaveManagerOptions) {
    this.exportBytes = options.exportBytes;
    this.scheduleSettings = normalizeSchedule({
      recoveryEnabled: true,
      recoveryIntervalMs: options.minSaveIntervalMs ?? DEFAULT_RECOVERY_INTERVAL_MS,
      idleEnabled: true,
      idleDelayMs: options.debounceMs ?? DEFAULT_IDLE_DELAY_MS,
      ...(options.schedule ?? {}),
    });
    this.now = options.now ?? (() => Date.now());
    this.idFactory = options.idFactory ?? createAutosaveDraftId;
    this.store = options.store ?? {
      saveDraft: saveAutosaveDraft,
      deleteDraft: deleteAutosaveDraft,
      touchSession: touchAutosaveSession,
      releaseSession: releaseAutosaveSession,
    };
    this.heartbeatIntervalMs = normalizeMs(
      options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS,
      DEFAULT_HEARTBEAT_INTERVAL_MS,
      0,
    );
    this.logger = options.logger ?? console;
    this.onStatus = options.onStatus;
    this.retryDelayMs = normalizeMs(options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS, DEFAULT_RETRY_DELAY_MS, 0);
    this.maxRetryDelayMs = Math.max(
      this.retryDelayMs,
      normalizeMs(options.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS, DEFAULT_MAX_RETRY_DELAY_MS, 0),
    );
    this.instanceId = options.instanceId ?? createAutosaveDraftId();
    this.instanceLockReady = this.acquireInstanceLock(options.locks ?? null);
    if (options.owner) this.setOwner(options.owner);
  }

  setOwner(owner: AutosaveOwner): void {
    if (this.disposed) return;
    if (this.owner?.sessionId === owner.sessionId && this.owner.launchId === owner.launchId) return;
    const previousSessionId = this.owner?.sessionId;
    this.stopHeartbeat();
    this.owner = { launchId: owner.launchId, sessionId: owner.sessionId, instanceId: this.instanceId };
    if (previousSessionId) void this.releaseOwner(previousSessionId);
    void this.heartbeat();
    if (this.heartbeatIntervalMs > 0) {
      this.heartbeatTimer = setInterval(() => {
        void this.heartbeat();
      }, this.heartbeatIntervalMs);
    }
  }

  connect(eventBus: EventBus): () => void {
    const offDirty = eventBus.on('document-dirty-changed', (payload) => {
      const change = payload as Partial<DirtyStateChange> | undefined;
      if (change?.dirty) {
        this.schedule(reasonText(change.reason, 'document-dirty'));
      } else {
        void this.discardCurrentDraft(reasonText(change?.reason, 'document-clean'));
      }
    });
    const offMutated = eventBus.on('document-mutated', (reason) => {
      this.schedule(reasonText(reason, 'document-mutated'));
    });
    const offChanged = eventBus.on('document-changed', (reason) => {
      this.schedule(reasonText(reason, 'document-changed'));
    });

    return () => {
      offDirty();
      offMutated();
      offChanged();
      this.dispose();
    };
  }

  async beginDocument(meta: AutosaveDocumentMeta, options: { discardPreviousDraft?: boolean } = {}): Promise<string> {
    const previousDraftId = this.current?.draftId ?? null;
    this.cancelTimers();
    this.pendingReason = null;
    this.lastSavedAt = 0;
    this.retryAttempt = 0;
    this.current = {
      draftId: meta.draftId ?? this.idFactory(),
      fileName: meta.fileName,
      sourceFormat: meta.sourceFormat,
    };

    if (options.discardPreviousDraft && previousDraftId && previousDraftId !== this.current.draftId) {
      await this.deleteDraft(previousDraftId, 'document-replaced');
    }
    return this.current.draftId;
  }

  getCurrentDraftId(): string | null {
    return this.current?.draftId ?? null;
  }

  updateSchedule(settings: Partial<AutosaveScheduleSettings>): void {
    const hadScheduledSave = Boolean(
      this.idleTimer || this.recoveryTimer || this.retryTimer || this.pendingReason,
    );
    this.scheduleSettings = normalizeSchedule({
      ...this.scheduleSettings,
      ...settings,
    });
    if (!this.current) return;
    this.cancelTimers();
    if (hadScheduledSave && (this.scheduleSettings.recoveryEnabled || this.scheduleSettings.idleEnabled)) {
      this.schedule('autosave-settings-changed');
    }
  }

  schedule(reason = 'document-mutated'): void {
    if (!this.current) return;
    const settings = this.scheduleSettings;
    if (!settings.recoveryEnabled && !settings.idleEnabled) return;

    if (settings.idleEnabled) {
      this.cancelIdleTimer();
      this.idleTimer = setTimeout(() => {
        this.idleTimer = null;
        void this.flushNow(reason);
      }, settings.idleDelayMs);
    }

    if (settings.recoveryEnabled && !this.recoveryTimer) {
      const elapsed = this.lastSavedAt > 0 ? this.now() - this.lastSavedAt : 0;
      const delay = Math.max(0, settings.recoveryIntervalMs - elapsed);
      this.recoveryTimer = setTimeout(() => {
        this.recoveryTimer = null;
        void this.flushNow('recovery-interval');
      }, delay);
    }
  }

  async flushNow(reason = 'manual'): Promise<void> {
    const current = this.current;
    if (!current) return;

    if (this.saving) {
      this.pendingReason = reason;
      return;
    }

    this.saving = true;
    this.cancelTimers();
    this.onStatus?.({ state: 'saving', reason });
    const generationAtStart = this.discardGeneration;
    try {
      await this.waitForInstanceLock();
      const bytes = this.exportBytes();
      const savedAt = this.now();
      if (this.owner) await this.heartbeat(savedAt);
      await this.store.saveDraft({
        id: current.draftId,
        fileName: current.fileName,
        sourceFormat: current.sourceFormat,
        savedAt,
        byteLength: bytes.byteLength,
        data: new Uint8Array(bytes),
        dirtyReason: reason,
        ...(this.owner ? {
          ownerLaunchId: this.owner.launchId,
          ownerSessionId: this.owner.sessionId,
          ownerHeartbeatAt: this.ownerHeartbeatAt,
          // lock 을 실제로 잡았을 때만 기록한다. 잡지 못한 페이지의 draft 는 heartbeat 규칙을 따른다.
          ...(this.instanceLockHeld ? { ownerInstanceId: this.instanceId } : {}),
        } : {}),
      });
      if (this.discardGeneration !== generationAtStart) {
        // 저장 진행 중 discard가 끼어듦 — 방금 저장으로 부활한 draft를 재삭제한다
        await this.deleteDraft(current.draftId, 'discarded-during-save');
        return;
      }
      this.lastSavedAt = savedAt;
      this.retryAttempt = 0;
      this.logger.debug?.(`[autosave] draft saved: ${current.fileName} (${bytes.byteLength} bytes)`);
      this.onStatus?.({ state: 'saved', reason, byteLength: bytes.byteLength });
    } catch (error) {
      this.logger.warn('[autosave] draft save failed:', error);
      this.onStatus?.({ state: 'error', reason, error });
      // 편집이 멈춘 문서는 다음 저장 계기가 없다. 복구본 없이 남지 않도록 다시 시도한다.
      if (this.discardGeneration === generationAtStart && this.current === current) {
        this.scheduleRetry(reason);
      }
    } finally {
      this.saving = false;
      const pending = this.pendingReason;
      this.pendingReason = null;
      if (pending && this.current) {
        this.schedule(pending);
      }
    }
  }

  async discardCurrentDraft(reason = 'discard'): Promise<void> {
    this.discardGeneration += 1;
    this.cancelTimers();
    this.pendingReason = null;
    this.lastSavedAt = 0;
    this.retryAttempt = 0;
    const draftId = this.current?.draftId;
    if (!draftId) return;
    await this.deleteDraft(draftId, reason);
  }

  async endDocument({ discardDraft = false, reason = 'document-ended' } = {}) {
    if (discardDraft) await this.discardCurrentDraft(reason);
    this.cancelTimers();
    this.pendingReason = null;
    this.lastSavedAt = 0;
    this.retryAttempt = 0;
    this.current = null;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelTimers();
    this.stopHeartbeat();
    this.pendingReason = null;
    const sessionId = this.owner?.sessionId;
    this.owner = null;
    if (sessionId) void this.releaseOwner(sessionId);
    this.releaseInstanceLock?.();
    this.releaseInstanceLock = null;
  }

  private acquireInstanceLock(locks: AutosaveLockManagerLike | null): Promise<void> {
    if (!locks) return Promise.resolve();
    this.instanceLockPending = true;
    return new Promise<void>((settle) => {
      const resolve = () => {
        this.instanceLockPending = false;
        settle();
      };
      const onGranted = () => {
        if (this.disposed) {
          resolve();
          return undefined;
        }
        this.instanceLockHeld = true;
        resolve();
        // 페이지가 사라질 때까지 풀지 않는다. 크래시·새로고침이면 브라우저가 대신 푼다.
        return new Promise<void>((release) => {
          this.releaseInstanceLock = () => {
            this.instanceLockHeld = false;
            release();
          };
        });
      };
      try {
        locks.request(autosaveInstanceLockName(this.instanceId), onGranted).catch((error: unknown) => {
          this.logger.warn('[autosave] owner lock unavailable:', error);
          resolve();
        });
      } catch (error) {
        this.logger.warn('[autosave] owner lock unavailable:', error);
        resolve();
      }
    });
  }

  private async waitForInstanceLock(): Promise<void> {
    if (!this.instanceLockPending) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      this.instanceLockReady,
      new Promise<void>((resolve) => { timer = setTimeout(resolve, INSTANCE_LOCK_WAIT_MS); }),
    ]);
    clearTimeout(timer);
  }

  private scheduleRetry(reason: string): void {
    if (this.disposed || !this.current) return;
    this.cancelRetryTimer();
    const delay = Math.min(this.maxRetryDelayMs, this.retryDelayMs * 2 ** this.retryAttempt);
    this.retryAttempt += 1;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.flushNow(reason);
    }, delay);
  }

  private cancelRetryTimer(): void {
    if (!this.retryTimer) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private async heartbeat(at = this.now()) {
    if (!this.owner) return;
    this.ownerHeartbeatAt = at;
    if (!this.store.touchSession) return;
    try {
      await this.store.touchSession(this.owner, at);
    } catch (error) {
      this.logger.warn('[autosave] session heartbeat failed:', error);
    }
  }

  private stopHeartbeat() {
    if (!this.heartbeatTimer) return;
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private async releaseOwner(sessionId: string) {
    try {
      await this.store.releaseSession?.(sessionId);
    } catch (error) {
      this.logger.warn('[autosave] session release failed:', error);
    }
  }

  private cancelIdleTimer(): void {
    if (!this.idleTimer) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private cancelRecoveryTimer(): void {
    if (!this.recoveryTimer) return;
    clearTimeout(this.recoveryTimer);
    this.recoveryTimer = null;
  }

  private cancelTimers(): void {
    this.cancelIdleTimer();
    this.cancelRecoveryTimer();
    this.cancelRetryTimer();
  }

  private async deleteDraft(id: string, reason: string): Promise<void> {
    try {
      await this.store.deleteDraft(id);
      this.logger.debug?.(`[autosave] draft deleted: ${id} (${reason})`);
    } catch (error) {
      this.logger.warn('[autosave] draft delete failed:', error);
    }
  }
}

function normalizeSchedule(settings: AutosaveScheduleSettings): AutosaveScheduleSettings {
  return {
    recoveryEnabled: settings.recoveryEnabled,
    recoveryIntervalMs: normalizeMs(settings.recoveryIntervalMs, DEFAULT_RECOVERY_INTERVAL_MS, 0),
    idleEnabled: settings.idleEnabled,
    idleDelayMs: normalizeMs(settings.idleDelayMs, DEFAULT_IDLE_DELAY_MS, 0),
  };
}

function normalizeMs(value: unknown, fallback: number, min: number): number {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.round(number));
}
