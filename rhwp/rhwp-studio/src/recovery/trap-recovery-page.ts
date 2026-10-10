/**
 * 엔진 trap 복구의 페이지 쪽 — 열린 문서 세션들에서 복구본을 남기고, 문서 복구 대화상자를 띄우고,
 * 채팅을 멈춘 뒤 다시 열 문서 목록을 적고 페이지를 다시 불러온다. 다시 불러온 페이지에서 문서를
 * 여는 일은 main 이 runTrapRecovery 로 한다. 결과 보고도 여기서 한다.
 */
import type { ChatSession, DocumentSession } from '../document-session.ts';
import { getAutosaveDraft } from './autosave-store.ts';
import {
  TRAP_INTERRUPT_WAIT_MS,
  TRAP_SAVE_WAIT_MS,
  buildTrapManifest,
  describeTrapOutcome,
  isOpeningTrapEntrySession,
  needsTrapRecoveryCopy,
  settleUnfinishedTrapSave,
  trapRecoveryNeedsReview,
  trapRecoverySummary,
  trapSaveStateOf,
  trapSaveStatusText,
  writeTrapManifest,
  type TrapEntryFacts,
  type TrapEntryOutcome,
  type TrapManifestEntry,
  type TrapManifestStorage,
  type TrapRecoveryReport,
  type TrapRecoveryRun,
  type TrapSaveState,
} from './trap-recovery.ts';
import {
  downloadRecoveryDraft,
  showTrapRecoveryDialog,
  showTrapRecoveryResultDialog,
  type TrapRecoveryDialogRow,
} from './trap-recovery-ui.ts';

export interface TrapRecoveryPageHost {
  sessions(): readonly DocumentSession[];
  attached(): DocumentSession;
  /** 화면의 문서를 엔진 읽기만으로 사본 내려받기 */
  saveCopy(): void;
  /** 다시 연 뒤 또 멈췄으면 그 복구의 진행 상태 */
  run(): TrapRecoveryRun<DocumentSession> | null;
  /** 읽기 전용으로 보던 문서인가 (생성 문서 미리보기 등) */
  readOnly(session: DocumentSession): boolean;
  deliveredLaunchHandleIds(): string[];
  deliveredGeneratedDocumentIds(): string[];
  storage(): TrapManifestStorage | null;
  reload(): void;
}

function documentFacts(session: DocumentSession) {
  return { dirty: session.documentState.isDirty(), hasFile: Boolean(session.wasm.currentFileHandle) };
}

function pendingAgentOps(session: DocumentSession): number {
  return session.chats.reduce((sum, chat) => sum + chat.bridge.pendingEdits.getChangeSets()
    .reduce((count, set) => count + set.ops.length, 0), 0);
}

function workingChats(session: DocumentSession): ChatSession[] {
  return session.chats.filter((chat) => chat.bridge.isTurnRunning());
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class TrapRecoveryPage {
  private readonly saves = new Map<DocumentSession, TrapSaveState>();
  private readonly listeners = new Set<() => void>();
  private waitCapReached = false;
  private started = false;
  private dialogOpen = false;
  /** 엔진이 멈춘 시각. 이보다 늦게 기록된 복구본은 멈춘 뒤의 내용이다. */
  private trappedAt = 0;

  constructor(private readonly host: TrapRecoveryPageHost) {}

  /**
   * 엔진이 멈춘 순간. 바뀐 문서와 파일 없는 문서마다 복구본을 하나씩 남긴다. 깨끗하고 파일이 있는
   * 문서는 파일로 다시 열면 정확하므로 몇 초씩 걸리는 내보내기를 하지 않는다.
   */
  begin(): void {
    if (this.started) return;
    this.started = true;
    this.trappedAt = Date.now();
    for (const session of this.host.sessions()) this.track(session);
    setTimeout(() => {
      this.waitCapReached = true;
      this.notify();
    }, TRAP_SAVE_WAIT_MS);
  }

  private track(session: DocumentSession): void {
    if (this.saves.has(session) || !session.wasm.hasLoadedDocument()) return;
    if (!needsTrapRecoveryCopy(documentFacts(session))) {
      this.saves.set(session, { state: 'skipped' });
      return;
    }
    this.saves.set(session, { state: 'saving' });
    void session.autosave.saveForRecovery('engine-trap')
      .then(trapSaveStateOf, (): TrapSaveState => ({
        state: 'failed',
        draftId: session.autosave.getCurrentDraftId(),
        lastSavedAt: session.autosave.getLastSavedAt(),
      }))
      .then((state) => {
        this.saves.set(session, state);
        this.notify();
      });
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener();
  }

  private ready(): boolean {
    return this.waitCapReached || [...this.saves.values()].every((save) => save.state !== 'saving');
  }

  /**
   * 상한을 넘겨(또는 다시 불러오는 지금까지) 끝나지 않은 저장은 실패로 보고 그 전 자동 저장본을 쓴다.
   * 그 저장이 다시 불러오기 전에 끝나면 다시 연 페이지가 그 행을 찾도록 draft id 를 함께 남긴다.
   */
  private saveStateOf(session: DocumentSession, settled = this.waitCapReached): TrapSaveState {
    const save = this.saves.get(session) ?? { state: 'failed', draftId: null, lastSavedAt: null };
    if (!settled) return save;
    return settleUnfinishedTrapSave(save, {
      draftId: session.autosave.getCurrentDraftId(),
      lastSavedAt: session.autosave.getLastSavedAt(),
    }, this.trappedAt);
  }

  private liveSessions(): DocumentSession[] {
    const attached = this.host.attached();
    const sessions = this.host.sessions().filter((session) => session.wasm.hasLoadedDocument());
    for (const session of sessions) this.track(session);
    return [...sessions.filter((session) => session === attached), ...sessions.filter((session) => session !== attached)];
  }

  private dialogRows(): TrapRecoveryDialogRow[] {
    const attached = this.host.attached();
    const run = this.host.run();
    const rows: TrapRecoveryDialogRow[] = this.liveSessions()
      .filter((session) => !isOpeningTrapEntrySession(run, session, session.documentId))
      .map((session, index) => {
        const notes: string[] = [];
        const staged = pendingAgentOps(session);
        if (staged > 0) notes.push(`검토하지 않은 에이전트 변경 ${staged}개가 문서에 포함된 채로 열립니다`);
        if (workingChats(session).length > 0) notes.push('작업 중인 채팅은 중단됩니다');
        if (session.worktree && !session.worktree.primary) {
          notes.push('버전 기록의 작업 공간 문서는 자동으로 다시 열지 않습니다. 다시 불러온 뒤 버전 기록에서 여세요');
        }
        return {
          key: `live-${index}`,
          fileName: session.wasm.fileName,
          attached: session === attached,
          status: () => trapSaveStatusText(this.saveStateOf(session), documentFacts(session)),
          notes,
        };
      });
    if (run && run.state !== 'finished') {
      for (const entry of run.manifest.entries) {
        // 화면에 붙이다 멈춘 문서는 이미 열렸어도 suspect 로 다시 적힌다.
        if (run.openedIds.has(entry.id) && entry.id !== run.openingId) continue;
        const status = entry.suspect || entry.id === run.openingId
          ? '이 문서를 열다가 엔진이 다시 멈췄습니다 · 자동으로 열지 않습니다'
          : entry.worktree === 'managed'
            ? '버전 기록의 작업 공간 문서 · 다시 불러온 뒤 버전 기록에서 여세요'
            : !entry.draft && !entry.hasFile
              ? '복구본이 없어 다시 열 수 없습니다'
              : '아직 다시 열지 못한 문서 · 이어서 엽니다';
        rows.push({ key: `carried-${entry.id}`, fileName: entry.fileName, attached: false, status: () => status, notes: [] });
      }
    }
    return rows;
  }

  /** 토스트의 문서 복구 버튼. 대화상자를 닫으면 'closed'. */
  async openDialog(): Promise<'closed' | 'reloading'> {
    if (this.dialogOpen) return 'closed';
    this.begin();
    this.dialogOpen = true;
    try {
      return await showTrapRecoveryDialog({
        rows: this.dialogRows(),
        ready: () => this.ready(),
        subscribe: (listener) => {
          this.listeners.add(listener);
          return () => { this.listeners.delete(listener); };
        },
        saveCopy: () => this.host.saveCopy(),
        reopen: () => this.reload(),
      });
    } finally {
      this.dialogOpen = false;
    }
  }

  /**
   * 1. 일하는 채팅을 멈추고 턴이 끝나기를 잠깐 기다린다 — 다시 불러와도 남는 기본 허브 세션이
   *    쉬는 상태로 새 페이지를 맞게 한다. 도구는 이미 ENGINE_TRAPPED 로 실패하므로 금방 끝난다.
   * 2. 다시 열 문서 목록을 sessionStorage 에 적는다.
   * 3. 저장하지 않은 문서의 나가기 확인을 이번 한 번 푼다 (깨끗하게 표시하면 복구본이 지워진다).
   * 4. 다시 불러온다.
   */
  private async reload(): Promise<string | null> {
    const sessions = this.liveSessions();
    const interrupted = new Map<DocumentSession, string[]>();
    const stopping: ChatSession[] = [];
    for (const session of sessions) {
      const working = workingChats(session);
      interrupted.set(session, working
        .map((chat) => chat.sidebar.currentThreadId())
        .filter((threadId): threadId is string => Boolean(threadId)));
      for (const chat of working) {
        try { chat.bridge.interrupt(); } catch { /* 이미 끊긴 채팅 */ }
        stopping.push(chat);
      }
    }
    const deadline = Date.now() + TRAP_INTERRUPT_WAIT_MS;
    while (stopping.some((chat) => chat.bridge.isTurnRunning()) && Date.now() < deadline) await delay(50);

    const attached = this.host.attached();
    const live = sessions.map((session) => {
      const facts: TrapEntryFacts = {
        slot: session.slotId === undefined ? 'default' : 'extra',
        attached: session === attached,
        documentId: session.documentId,
        fileName: session.wasm.fileName,
        ...documentFacts(session),
        worktree: !session.worktree ? 'none' : session.worktree.primary ? 'primary' : 'managed',
        pendingAgentOps: pendingAgentOps(session),
        activeThreadId: session.activeChat?.sidebar.currentThreadId() ?? null,
        interruptedThreadIds: interrupted.get(session) ?? [],
        readOnly: this.host.readOnly(session),
        save: this.saveStateOf(session, true),
      };
      return { session, facts };
    });
    const manifest = buildTrapManifest({
      now: Date.now(),
      live,
      attachedSession: attached,
      run: this.host.run(),
      deliveredLaunchHandleIds: this.host.deliveredLaunchHandleIds(),
      deliveredGeneratedDocumentIds: this.host.deliveredGeneratedDocumentIds(),
    });
    if (!writeTrapManifest(this.host.storage(), manifest)) {
      return '이 창에서는 다시 열 문서 목록을 남길 수 없습니다. 사본 저장으로 문서를 내려받거나, 앱을 다시 열어 자동 저장본으로 복구하세요.';
    }
    for (const session of this.host.sessions()) session.documentState.permitNextUnload();
    this.host.reload();
    return null;
  }
}

// ─── 다시 연 뒤의 보고 ─────────────────────────────

export interface TrapRecoveryReportHost {
  toast(message: string): void;
  /** 결과 대화상자의 열기. 결과 문구를 돌려준다. */
  openEntry(entry: TrapManifestEntry): Promise<string>;
}

/** 모두 잃은 것 없이 다시 열었으면 알림 한 줄, 아니면 문서마다 결과를 보여 준다. */
export function presentTrapRecoveryReport(report: TrapRecoveryReport, host: TrapRecoveryReportHost): void {
  if (report.outcomes.length === 0) return;
  if (!trapRecoveryNeedsReview(report)) {
    host.toast(trapRecoverySummary(report));
    return;
  }
  const rows = report.outcomes.map((outcome: TrapEntryOutcome, index) => {
    const view = describeTrapOutcome(outcome, report.stoppedByTrap);
    const draftId = outcome.draftId;
    return {
      key: `result-${index}`,
      fileName: outcome.entry.fileName,
      text: view.text,
      ...(view.canDownload && draftId ? {
        download: async () => {
          const draft = await getAutosaveDraft(draftId);
          if (!draft) throw new Error('복구본이 남아 있지 않습니다.');
          downloadRecoveryDraft(draft);
        },
      } : {}),
      ...(view.canOpen ? { open: () => host.openEntry(outcome.entry) } : {}),
    };
  });
  const opened = report.outcomes.filter((outcome) => outcome.status === 'opened').length;
  const lead = report.stoppedByTrap
    ? '문서를 다시 여는 도중 엔진이 또 멈췄습니다. 문서 복구를 다시 누르면 남은 문서를 이어서 엽니다.'
    : `문서 ${opened}개를 다시 열었습니다. 문서마다 결과를 확인하세요.`;
  void showTrapRecoveryResultDialog(rows, report.interruptedThreadIds.length > 0
    ? `${lead}\n중단된 채팅은 채팅 목록에서 이어서 진행할 수 있습니다.`
    : lead);
}
