/**
 * 엔진 trap 복구 — 멈춘 페이지가 남기는 "다시 열 문서 목록"(manifest)과, 다시 불러온 페이지가 그
 * 목록으로 문서를 하나씩 다시 여는 순서.
 *
 * 멈춘 wasm 인스턴스는 페이지 안에서 되살릴 수 없다(모듈 전역 인스턴스 하나, 그 인스턴스에 묶인 id 들).
 * 그래서 문서마다 복구본을 남기고 목록을 sessionStorage 에 적은 뒤 페이지를 다시 불러온다. 목록은
 * 읽자마자 지운다 — 복구가 실패해도 스스로 되풀이하지 않고, 다음 복구는 사용자가 다시 눌러야 한다.
 * 다시 여는 도중에 또 멈추면 그때 열던 문서를 suspect 로 적어, 다음 복구가 자동으로 열지 않는다.
 *
 * 이 모듈은 화면·엔진을 모른다. 문서를 여는 일은 deps 로 받아 순서만 정한다.
 */
import type { AutosaveDraftSummary } from './autosave-store.ts';
import type { AutosaveRecoverySaveResult } from './autosave-manager.ts';
import type { DetachedReason } from './recovery-flow.ts';

export const TRAP_MANIFEST_KEY = 'rhwp-trap-recovery-v1';
/** 저장이 이보다 오래 걸리면 끝나지 않은 문서는 실패로 보고 다시 열기를 허용한다. */
export const TRAP_SAVE_WAIT_MS = 30_000;
/** 다시 불러오기 전에 일하는 채팅의 턴이 끝나기를 기다리는 상한. */
export const TRAP_INTERRUPT_WAIT_MS = 2_000;

export type TrapWorktreeKind = 'none' | 'primary' | 'managed';

export interface TrapManifestDraft {
  id: string;
  savedAt: number;
  /** 이번 trap 에서 남긴 복구본이면 true. false 면 그 전에 남긴 자동 저장본이다. */
  fresh: boolean;
}

export interface TrapManifestEntry {
  /** manifest 안에서만 유일하다. */
  id: string;
  /** 문서 세션의 데스크톱 점유 자리. 첫 세션(slotId 없음)이 default 다. */
  slot: 'default' | 'extra';
  /** 화면에 붙어 있던 문서 */
  attached: boolean;
  documentId: string | null;
  fileName: string;
  dirty: boolean;
  draft: TrapManifestDraft | null;
  hasFile: boolean;
  worktree: TrapWorktreeKind;
  /** 검토하지 않은 에이전트 변경 수. 다시 열면 문서 내용이 된다. */
  pendingAgentOps: number;
  /** 문서에서 보이던 채팅. 다시 연 문서의 사이드바가 이 채팅을 잇는다. */
  activeThreadId: string | null;
  /** 다시 불러오기 전에 멈춘 채팅 */
  interruptedThreadIds: string[];
  /** 다시 여는 도중 엔진이 또 멈춘 문서. 자동으로 열지 않는다. */
  suspect: boolean;
  /**
   * 읽기 전용으로 보던 문서(생성 문서 미리보기 등). 다시 연 창도 읽기 전용으로 두고, 바꿀 수 없던
   * 문서이므로 저장하지 않은 문서로 표시하지 않는다.
   */
  readOnly: boolean;
}

export interface TrapRecoveryManifest {
  v: 1;
  createdAt: number;
  /** 1, 또는 복구 도중 다시 멈췄으면 앞 복구 + 1 */
  attempt: number;
  /** 이 페이지가 이미 처리한 데스크톱 시작 파일. 다시 불러온 페이지가 다시 열지 않는다. */
  deliveredLaunchHandleIds: string[];
  /** 같은 이유로 건너뛸 데스크톱 생성 문서 */
  deliveredGeneratedDocumentIds: string[];
  entries: TrapManifestEntry[];
}

export type TrapManifestStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

// ─── manifest 읽기·쓰기 ─────────────────────────────

export function writeTrapManifest(
  storage: TrapManifestStorage | null | undefined,
  manifest: TrapRecoveryManifest,
): boolean {
  if (!storage) return false;
  try {
    storage.setItem(TRAP_MANIFEST_KEY, JSON.stringify(manifest));
    return storage.getItem(TRAP_MANIFEST_KEY) !== null;
  } catch {
    return false;
  }
}

/**
 * manifest 를 읽고 곧바로 지운다. 지우지 못하면 같은 복구가 새로고침마다 되풀이될 수 있으므로
 * 쓰지 않는다. 다른 판이나 깨진 값은 null.
 */
export function takeTrapManifest(storage: TrapManifestStorage | null | undefined): TrapRecoveryManifest | null {
  if (!storage) return null;
  let raw: string | null;
  try {
    raw = storage.getItem(TRAP_MANIFEST_KEY);
  } catch {
    return null;
  }
  if (raw === null) return null;
  try {
    storage.removeItem(TRAP_MANIFEST_KEY);
  } catch {
    return null;
  }
  try {
    return parseTrapManifest(JSON.parse(raw));
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.length > 0) : [];
}

function parseEntry(value: unknown): TrapManifestEntry | null {
  if (!isRecord(value)) return null;
  const id = stringOrNull(value.id);
  const fileName = typeof value.fileName === 'string' ? value.fileName : null;
  if (!id || fileName === null) return null;
  let draft: TrapManifestDraft | null = null;
  if (isRecord(value.draft)) {
    const draftId = stringOrNull(value.draft.id);
    if (draftId) {
      draft = { id: draftId, savedAt: finiteNumber(value.draft.savedAt, 0), fresh: value.draft.fresh === true };
    }
  }
  const worktree = value.worktree === 'primary' || value.worktree === 'managed' ? value.worktree : 'none';
  return {
    id,
    slot: value.slot === 'default' ? 'default' : 'extra',
    attached: value.attached === true,
    documentId: stringOrNull(value.documentId),
    fileName,
    dirty: value.dirty === true,
    draft,
    hasFile: value.hasFile === true,
    worktree,
    pendingAgentOps: Math.max(0, Math.floor(finiteNumber(value.pendingAgentOps, 0))),
    activeThreadId: stringOrNull(value.activeThreadId),
    interruptedThreadIds: stringList(value.interruptedThreadIds),
    suspect: value.suspect === true,
    readOnly: value.readOnly === true,
  };
}

export function parseTrapManifest(value: unknown): TrapRecoveryManifest | null {
  if (!isRecord(value) || value.v !== 1 || !Array.isArray(value.entries)) return null;
  const entries: TrapManifestEntry[] = [];
  const ids = new Set<string>();
  for (const raw of value.entries) {
    const entry = parseEntry(raw);
    if (!entry || ids.has(entry.id)) continue;
    ids.add(entry.id);
    entries.push(entry);
  }
  return {
    v: 1,
    createdAt: finiteNumber(value.createdAt, 0),
    attempt: Math.max(1, Math.floor(finiteNumber(value.attempt, 1))),
    deliveredLaunchHandleIds: stringList(value.deliveredLaunchHandleIds),
    deliveredGeneratedDocumentIds: stringList(value.deliveredGeneratedDocumentIds),
    entries,
  };
}

// ─── 멈춘 순간의 복구본 ─────────────────────────────

export type TrapSaveState =
  | { readonly state: 'saving' }
  /** 깨끗하고 파일이 있는 문서. 파일에서 다시 연다. */
  | { readonly state: 'skipped' }
  | { readonly state: 'saved'; readonly draftId: string; readonly savedAt: number }
  | {
    readonly state: 'failed';
    readonly draftId: string | null;
    readonly lastSavedAt: number | null;
    /**
     * 기다림 상한을 넘겨 아직 기록 중이던 복구본. 다시 불러오기 전에 기록을 마치면 그 행이 since
     * (엔진이 멈춘 시각)보다 새롭다 — 다시 연 페이지가 그 행을 이번 복구본으로 쓴다.
     */
    readonly unsettled?: { readonly draftId: string; readonly since: number };
  };

export function trapSaveStateOf(result: AutosaveRecoverySaveResult): TrapSaveState {
  return result.ok
    ? { state: 'saved', draftId: result.draftId, savedAt: result.savedAt }
    : { state: 'failed', draftId: result.draftId, lastSavedAt: result.lastSavedAt };
}

/**
 * 기다림 상한이 지났는데 아직 저장 중인 문서의 상태. 실패로 보되(앞서 남긴 자동 저장본을 쓴다),
 * 그 저장이 쓸 draft id 를 함께 남긴다. 처음 저장이라 앞선 자동 저장본이 없어도 다시 열 때
 * 늦게 기록된 행을 찾을 수 있다.
 */
export function settleUnfinishedTrapSave(
  save: TrapSaveState,
  current: { draftId: string | null; lastSavedAt: number | null },
  since: number,
): TrapSaveState {
  if (save.state !== 'saving') return save;
  return {
    state: 'failed',
    draftId: current.lastSavedAt !== null ? current.draftId : null,
    lastSavedAt: current.lastSavedAt,
    ...(current.draftId ? { unsettled: { draftId: current.draftId, since } } : {}),
  };
}

/** 깨끗하고 파일이 있는 문서는 파일 그대로 다시 열면 정확하다. 나머지는 복구본이 있어야 한다. */
export function needsTrapRecoveryCopy(document: { dirty: boolean; hasFile: boolean }): boolean {
  return document.dirty || !document.hasFile;
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

export function formatTrapClock(timestamp: number, withSeconds: boolean): string {
  const date = new Date(timestamp);
  const clock = `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
  return withSeconds ? `${clock}:${pad2(date.getSeconds())}` : clock;
}

/** 복구 대화상자의 문서 한 줄 상태. */
export function trapSaveStatusText(save: TrapSaveState, document: { dirty: boolean; hasFile: boolean }): string {
  switch (save.state) {
    case 'saving':
      return '복구본 저장 중…';
    case 'skipped':
      return '변경 없음 · 파일에서 다시 엽니다';
    case 'saved':
      return `복구본 저장됨 (${formatTrapClock(save.savedAt, true)})`;
    case 'failed':
      if (save.lastSavedAt !== null) {
        return `복구본을 만들지 못했습니다 · 마지막 자동 저장본(${formatTrapClock(save.lastSavedAt, false)})으로 엽니다`;
      }
      if (document.hasFile) {
        return document.dirty
          ? '복구본을 만들지 못했습니다 · 저장하지 않은 변경은 복구할 수 없습니다. 마지막으로 저장한 파일로 엽니다'
          : '복구본을 만들지 못했습니다 · 파일에서 다시 엽니다';
      }
      return '복구본을 만들지 못했습니다 · 이 문서는 다시 열 수 없습니다';
  }
}

/** 문서 세션 하나에서 manifest 항목을 만들 때 필요한 사실 */
export interface TrapEntryFacts {
  slot: 'default' | 'extra';
  attached: boolean;
  documentId: string | null;
  fileName: string;
  dirty: boolean;
  hasFile: boolean;
  worktree: TrapWorktreeKind;
  pendingAgentOps: number;
  activeThreadId: string | null;
  interruptedThreadIds: string[];
  readOnly: boolean;
  save: TrapSaveState;
}

function draftOf(save: TrapSaveState): TrapManifestDraft | null {
  if (save.state === 'saved') return { id: save.draftId, savedAt: save.savedAt, fresh: true };
  if (save.state !== 'failed') return null;
  // 끝나지 않은 저장: 멈춘 뒤에 기록된 행만 이번 복구본이다. 그 전 행은 앞선 자동 저장본이다.
  if (save.unsettled) return { id: save.unsettled.draftId, savedAt: save.unsettled.since, fresh: false };
  if (save.draftId && save.lastSavedAt !== null) {
    return { id: save.draftId, savedAt: save.lastSavedAt, fresh: false };
  }
  return null;
}

function entryFromFacts(facts: TrapEntryFacts): Omit<TrapManifestEntry, 'id'> {
  return {
    slot: facts.slot,
    attached: facts.attached,
    documentId: facts.documentId,
    fileName: facts.fileName,
    dirty: facts.dirty,
    draft: draftOf(facts.save),
    hasFile: facts.hasFile,
    worktree: facts.worktree,
    pendingAgentOps: Math.max(0, facts.pendingAgentOps),
    activeThreadId: facts.activeThreadId,
    interruptedThreadIds: [...facts.interruptedThreadIds],
    suspect: false,
    readOnly: facts.readOnly,
  };
}

// ─── 다시 여는 도중의 상태 ─────────────────────────────

/**
 * 진행 중인 복구. 페이지 메모리에만 둔다 — 여는 일과 그 일이 일으킨 trap 이 같은 페이지에서
 * 일어나므로, 다시 멈추면 이 상태로 다음 manifest 를 만든다.
 */
export interface TrapRecoveryRun<S> {
  readonly manifest: TrapRecoveryManifest;
  /** 열린 항목. 열지 못한 항목은 다음 복구로 넘어간다. */
  readonly openedIds: Set<string>;
  /** 지금 여는 항목. 이때 엔진이 멈추면 이 항목이 suspect 가 된다. */
  openingId: string | null;
  /** 항목을 연 세션 */
  readonly sessions: Map<string, S>;
  state: 'running' | 'stopped-by-trap' | 'finished';
}

export function createTrapRecoveryRun<S>(manifest: TrapRecoveryManifest): TrapRecoveryRun<S> {
  return { manifest, openedIds: new Set(), openingId: null, sessions: new Map(), state: 'running' };
}

/**
 * 복구 도중 다시 멈췄을 때 열던 항목(suspect)의 세션인가. 열기가 끝나기 전에 멈췄으면 run 에 그
 * 세션이 아직 없으므로 같은 문서 ID 로도 알아본다 — 한 창에서 한 문서는 한 세션에만 열린다.
 * 그러지 않으면 그 문서가 살아 있는 세션으로 한 번, suspect 로 한 번 목록에 두 번 들어간다.
 */
export function isOpeningTrapEntrySession<S>(
  run: TrapRecoveryRun<S> | null,
  session: S,
  documentId: string | null,
): boolean {
  if (!run || run.state === 'finished' || !run.openingId) return false;
  const opening = run.manifest.entries.find((entry) => entry.id === run.openingId);
  if (!opening) return false;
  if (run.sessions.get(opening.id) === session) return true;
  return opening.documentId !== null && documentId === opening.documentId;
}

/**
 * 다시 불러오기 직전의 manifest. 복구 도중이 아니면 살아 있는 세션들이 곧 목록이다. 복구 도중에
 * 다시 멈췄으면 세 묶음을 합친다: 이미 다시 연 세션, 아직 열지 못한 항목(그대로), 열던 항목(suspect).
 */
export function buildTrapManifest<S>(input: {
  now: number;
  live: ReadonlyArray<{ session: S; facts: TrapEntryFacts }>;
  attachedSession: S | null;
  run: TrapRecoveryRun<S> | null;
  deliveredLaunchHandleIds: readonly string[];
  deliveredGeneratedDocumentIds: readonly string[];
}): TrapRecoveryManifest {
  const run = input.run && input.run.state !== 'finished' ? input.run : null;
  const openingEntry = run?.openingId
    ? run.manifest.entries.find((entry) => entry.id === run.openingId) ?? null
    : null;
  // 복구가 끝나기 전이면 화면에 붙일 문서는 사용자가 보던 원래 문서다.
  const intendedAttached = run?.manifest.entries.find((entry) => entry.attached) ?? null;
  const intendedAttachedSession = intendedAttached && run ? run.sessions.get(intendedAttached.id) ?? null : null;

  const entries: Array<Omit<TrapManifestEntry, 'id'>> = [];
  for (const { session, facts } of input.live) {
    if (isOpeningTrapEntrySession(run, session, facts.documentId)) continue;
    const attached = run ? session === intendedAttachedSession : session === input.attachedSession;
    entries.push({ ...entryFromFacts(facts), attached });
  }
  if (run) {
    for (const entry of run.manifest.entries) {
      if (run.openedIds.has(entry.id) || entry.id === run.openingId) continue;
      const { id: _id, ...rest } = entry;
      entries.push(rest);
    }
    if (openingEntry) {
      const { id: _id, ...rest } = openingEntry;
      entries.push({ ...rest, suspect: true });
    }
  }
  return {
    v: 1,
    createdAt: input.now,
    attempt: run ? run.manifest.attempt + 1 : 1,
    deliveredLaunchHandleIds: [...new Set([
      ...(run?.manifest.deliveredLaunchHandleIds ?? []),
      ...input.deliveredLaunchHandleIds,
    ])],
    deliveredGeneratedDocumentIds: [...new Set([
      ...(run?.manifest.deliveredGeneratedDocumentIds ?? []),
      ...input.deliveredGeneratedDocumentIds,
    ])],
    entries: entries.map((entry, index) => ({ ...entry, id: `entry-${index + 1}` })),
  };
}

// ─── 항목마다 무엇으로 다시 열지 ─────────────────────────────

/** 다시 열면서 잃는 것. 잃는 것이 있는 계획에는 반드시 붙는다. */
export type TrapLoss =
  /** 이번 복구본을 만들지 못해 그 전 자동 저장본으로 연다. 그 뒤의 변경은 없다. */
  | { readonly kind: 'stale-draft'; readonly savedAt: number }
  /** 복구본이 없어 마지막으로 저장한 파일로 연다. 저장하지 않은 변경은 없다. */
  | { readonly kind: 'unsaved-changes' }
  /** 복구본도 파일도 없어 열 수 없다. */
  | { readonly kind: 'not-reopenable' }
  /** 다시 여는 도중 엔진이 또 멈춘 문서. 자동으로 열지 않는다. */
  | { readonly kind: 'suspect' }
  /** 버전 기록의 작업 공간 문서. 버전 기록에서 다시 연다. */
  | { readonly kind: 'managed-worktree' };

export type TrapEntryPlan =
  | {
    readonly action: 'restore-draft';
    readonly draft: AutosaveDraftSummary;
    /** 멈출 때 깨끗했던 문서. 원본이 그대로면 원본으로 깨끗하게 연다. */
    readonly cleanAtTrap: boolean;
    readonly loss: TrapLoss | null;
  }
  | { readonly action: 'reopen-file'; readonly loss: TrapLoss | null }
  | { readonly action: 'skip'; readonly loss: TrapLoss };

/** draftRow 는 저장소에 실제로 남아 있는 entry.draft 의 행이다. 없으면 복구본이 없는 것으로 본다. */
export function planTrapEntry(entry: TrapManifestEntry, draftRow: AutosaveDraftSummary | null): TrapEntryPlan {
  if (entry.suspect) return { action: 'skip', loss: { kind: 'suspect' } };
  if (entry.worktree === 'managed') return { action: 'skip', loss: { kind: 'managed-worktree' } };
  const draft = entry.draft && draftRow && draftRow.id === entry.draft.id && draftRow.byteLength > 0
    ? draftRow
    : null;
  if (draft && entry.dirty) {
    // 시간 초과로 실패로 본 저장이 그 뒤에 끝났으면 행이 더 새롭다.
    const fresh = entry.draft!.fresh || draft.savedAt > entry.draft!.savedAt;
    return {
      action: 'restore-draft',
      draft,
      cleanAtTrap: false,
      loss: fresh ? null : { kind: 'stale-draft', savedAt: draft.savedAt },
    };
  }
  if (!entry.dirty && entry.hasFile) return { action: 'reopen-file', loss: null };
  if (!entry.dirty && draft) return { action: 'restore-draft', draft, cleanAtTrap: true, loss: null };
  if (entry.hasFile) return { action: 'reopen-file', loss: { kind: 'unsaved-changes' } };
  return { action: 'skip', loss: { kind: 'not-reopenable' } };
}

// ─── 다시 열기 ─────────────────────────────

export type TrapOpenFailure =
  | 'blocked'
  | 'not-found'
  | 'permission-denied'
  | 'no-session'
  | 'cancelled'
  | 'error';

export type TrapOpenResult =
  | {
    readonly kind: 'opened';
    /** 원본 파일과 연결하지 못하고 연 이유 */
    readonly detached?: DetachedReason | null;
    /** 디스크가 바뀌어 병합을 열었다 */
    readonly merging?: boolean;
    readonly message?: string;
  }
  | { readonly kind: 'failed'; readonly reason: TrapOpenFailure; readonly message?: string };

export interface TrapEntryOutcome {
  readonly entry: TrapManifestEntry;
  readonly plan: TrapEntryPlan;
  readonly status: 'opened' | 'failed' | 'skipped' | 'not-attempted';
  readonly result: TrapOpenResult | null;
  /** 내려받을 수 있는 복구본 */
  readonly draftId: string | null;
}

export interface TrapRecoveryReport {
  readonly outcomes: TrapEntryOutcome[];
  /** 다시 여는 도중 엔진이 또 멈췄다 */
  readonly stoppedByTrap: boolean;
  readonly interruptedThreadIds: string[];
}

export interface TrapRecoveryDeps<S> {
  listDrafts(): Promise<AutosaveDraftSummary[]>;
  engineStopped(): boolean;
  /** 페이지의 첫 세션(기본 자리) */
  defaultSession(): S;
  /** 멈춘 채팅에 중단 표시를 남긴다. 문서를 열기 전에 불러 채팅이 표시와 함께 열리게 한다. */
  markInterrupted(threadId: string): Promise<void>;
  /** 첫 세션에 연다. */
  openInDefault(entry: TrapManifestEntry, plan: TrapEntryPlan, options: { canMerge: boolean }): Promise<TrapOpenResult>;
  /** 새 세션을 만들어 연다. 열지 못하면 세션을 정리하고 session 은 null. */
  openInBackground(
    entry: TrapManifestEntry,
    plan: TrapEntryPlan,
    options: { canMerge: boolean },
  ): Promise<{ result: TrapOpenResult; session: S | null }>;
  attach(session: S): Promise<void>;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * manifest 의 문서를 다시 연다.
 * 1. 멈춘 채팅에 중단 표시를 남긴다 (채팅이 문서와 함께 열리기 전에).
 * 2. 기본 자리 문서를 첫 세션에 연다 — 데스크톱의 기본 자리 점유가 그 문서에 남아 있다. 열 수 없으면
 *    다음 문서가 첫 세션을 쓴다.
 * 3. 나머지는 새 세션에서 연다. 화면에 붙일 문서는 마지막에 연다 (병합 화면은 그 문서만 연다).
 * 4. 보던 문서를 화면에 붙인다.
 * 문서마다 엔진이 멈췄는지 본다. 멈췄으면 거기서 그만둔다 — 이어지는 열기는 어차피 실패하고,
 * 열던 문서는 다음 복구에서 suspect 가 된다.
 */
export async function runTrapRecovery<S>(
  run: TrapRecoveryRun<S>,
  deps: TrapRecoveryDeps<S>,
): Promise<TrapRecoveryReport> {
  const manifest = run.manifest;
  const drafts = new Map<string, AutosaveDraftSummary>();
  try {
    for (const draft of await deps.listDrafts()) drafts.set(draft.id, draft);
  } catch {
    // 목록을 읽지 못하면 복구본 없이 계획한다. 파일이 있는 문서는 파일로 연다.
  }
  const planned = manifest.entries.map((entry) => {
    const row = entry.draft ? drafts.get(entry.draft.id) ?? null : null;
    return { entry, plan: planTrapEntry(entry, row), draftId: row?.id ?? null };
  });
  const outcomes = new Map<string, TrapEntryOutcome>();
  for (const { entry, plan, draftId } of planned) {
    outcomes.set(entry.id, {
      entry, plan, draftId, result: null, status: plan.action === 'skip' ? 'skipped' : 'not-attempted',
    });
  }

  const interruptedThreadIds = [...new Set(manifest.entries.flatMap((entry) => entry.interruptedThreadIds))];
  for (const threadId of interruptedThreadIds) {
    await deps.markInterrupted(threadId).catch(() => {});
  }

  const openable = planned.filter((item) => item.plan.action !== 'skip');
  const first = openable.find((item) => item.entry.slot === 'default') ?? openable[0] ?? null;
  const rest = openable.filter((item) => item !== first);
  const order = [
    ...(first ? [first] : []),
    ...rest.filter((item) => !item.entry.attached),
    ...rest.filter((item) => item.entry.attached),
  ];
  const last = order.at(-1) ?? null;

  let defaultFree = true;
  for (const item of order) {
    if (deps.engineStopped()) {
      run.state = 'stopped-by-trap';
      break;
    }
    run.openingId = item.entry.id;
    const options = { canMerge: item.entry.attached && item === last };
    let result: TrapOpenResult;
    let session: S | null = null;
    try {
      if (defaultFree) {
        result = await deps.openInDefault(item.entry, item.plan, options);
        if (result.kind === 'opened') session = deps.defaultSession();
      } else {
        ({ result, session } = await deps.openInBackground(item.entry, item.plan, options));
      }
    } catch (error) {
      result = { kind: 'failed', reason: 'error', message: errorText(error) };
      session = null;
    }
    const opened = result.kind === 'opened' && session !== null;
    outcomes.set(item.entry.id, {
      ...outcomes.get(item.entry.id)!,
      result,
      status: opened ? 'opened' : 'failed',
    });
    if (deps.engineStopped()) {
      // 이 문서를 여는 동안 멈췄다. openingId 를 남겨 다음 manifest 에서 suspect 로 적는다.
      if (opened) run.sessions.set(item.entry.id, session!);
      run.state = 'stopped-by-trap';
      break;
    }
    run.openingId = null;
    if (opened) {
      run.openedIds.add(item.entry.id);
      run.sessions.set(item.entry.id, session!);
      if (session === deps.defaultSession()) defaultFree = false;
    }
  }

  if (run.state === 'running') {
    const attachedEntry = manifest.entries.find((entry) => entry.attached) ?? null;
    const target = (attachedEntry ? run.sessions.get(attachedEntry.id) : undefined)
      ?? (first ? run.sessions.get(first.entry.id) : undefined)
      ?? run.sessions.values().next().value
      ?? deps.defaultSession();
    // 화면에 붙이면 그 문서를 다시 조판한다. 그러다 멈추면 그 문서가 다음 복구의 suspect 다.
    run.openingId = [...run.sessions].find(([, session]) => session === target)?.[0] ?? null;
    await deps.attach(target).catch(() => {});
    if (deps.engineStopped()) {
      run.state = 'stopped-by-trap';
    } else {
      run.openingId = null;
      run.state = 'finished';
    }
  }

  return {
    outcomes: manifest.entries.map((entry) => outcomes.get(entry.id)!),
    stoppedByTrap: run.state === 'stopped-by-trap',
    interruptedThreadIds,
  };
}

// ─── 결과 문구 ─────────────────────────────

const DETACHED_TEXT: Record<DetachedReason, string> = {
  'never-saved': '저장하지 않은 문서를 복구했습니다.',
  'not-found': '원본 파일을 찾지 못해 연결하지 않고 열었습니다. 저장할 때 위치를 선택하세요.',
  'permission-denied': '원본 파일에 접근할 수 없어 연결하지 않고 열었습니다. 저장할 때 위치를 선택하세요.',
  changed: '원본 파일이 바뀌어 연결하지 않고 열었습니다. 저장할 때 위치를 선택하세요.',
  format: '원본과 다른 형식으로 복구해 연결하지 않고 열었습니다. 저장할 때 위치를 선택하세요.',
};

export interface TrapOutcomeView {
  readonly text: string;
  /** 다시 연 문서이고 잃은 것도 알릴 것도 없다 */
  readonly clean: boolean;
  /** 복구본을 내려받을 수 있다 (엔진 없이) */
  readonly canDownload: boolean;
  /** 사용자가 직접 다시 열어 볼 수 있다 */
  readonly canOpen: boolean;
}

function lossText(loss: TrapLoss, fileName: string): string {
  switch (loss.kind) {
    case 'stale-draft':
      return `복구본을 만들지 못해 ${formatTrapClock(loss.savedAt, false)} 자동 저장본으로 열었습니다. 그 뒤의 변경은 복구하지 못했습니다.`;
    case 'unsaved-changes':
      return '저장하지 않은 변경을 복구하지 못했습니다. 마지막으로 저장한 상태로 열었습니다.';
    case 'not-reopenable':
      return `‘${fileName}’은(는) 다시 열 수 없습니다. 저장하지 않은 변경을 복구하지 못했습니다.`;
    case 'suspect':
      return '이 문서를 열다가 엔진이 다시 멈췄습니다.';
    case 'managed-worktree':
      return '버전 기록의 작업 공간에서 다시 여세요.';
  }
}

const FAILURE_TEXT: Record<TrapOpenFailure, string> = {
  blocked: '이 문서는 다른 창에서 열려 있습니다. 그 창에서 문서를 닫은 뒤 다시 복구하세요.',
  'not-found': '파일을 찾지 못해 다시 열지 못했습니다. 파일 > 열기로 여세요.',
  'permission-denied': '파일 접근 권한이 없어 다시 열지 못했습니다. 파일 > 열기로 여세요.',
  'no-session': '에이전트 세션을 만들 수 없어 이 문서를 열지 못했습니다.',
  cancelled: '다시 열기를 취소했습니다.',
  error: '다시 열지 못했습니다.',
};

/** 결과 대화상자의 문서 한 줄. 잃은 것이 있으면 문구에 반드시 들어간다. */
export function describeTrapOutcome(outcome: TrapEntryOutcome, stoppedByTrap: boolean): TrapOutcomeView {
  const { entry, plan, result } = outcome;
  const staged = entry.pendingAgentOps > 0
    ? ` 검토하지 않은 에이전트 변경 ${entry.pendingAgentOps}개가 문서 내용에 들어 있습니다.`
    : '';
  const keepsDraft = outcome.draftId !== null;
  if (outcome.status === 'opened' && result?.kind === 'opened') {
    const parts: string[] = [];
    if (plan.loss) parts.push(lossText(plan.loss, entry.fileName));
    // 파일 없이 열려 있던 문서는 연결 없이 다시 여는 것이 원래 상태다. 파일이 있던 문서가 파일과
    // 끊겼거나 이름(형식)이 바뀌었을 때만 알린다.
    const detachedNotable = result.detached === 'format'
      || (entry.hasFile && Boolean(result.detached) && result.detached !== 'never-saved');
    if (result.merging && result.message) parts.push(result.message);
    else if (detachedNotable && result.detached) parts.push(DETACHED_TEXT[result.detached]);
    const notable = parts.length > 0 || staged.length > 0;
    if (parts.length === 0) {
      parts.push(plan.action === 'restore-draft' && !plan.cleanAtTrap
        ? '저장하지 않은 변경까지 다시 열었습니다.'
        : '다시 열었습니다.');
    }
    return { text: `${parts.join(' ')}${staged}`, clean: !notable, canDownload: false, canOpen: false };
  }
  if (outcome.status === 'skipped' && plan.action === 'skip') {
    return {
      text: lossText(plan.loss, entry.fileName),
      clean: false,
      canDownload: keepsDraft,
      canOpen: plan.loss.kind === 'suspect' && !stoppedByTrap,
    };
  }
  if (outcome.status === 'not-attempted') {
    return {
      text: '엔진이 다시 멈춰 열지 못했습니다. 문서 복구를 다시 누르면 이어서 엽니다.',
      clean: false,
      canDownload: keepsDraft,
      canOpen: false,
    };
  }
  const failure = result?.kind === 'failed' ? result : { reason: 'error' as const, message: undefined };
  const detail = failure.reason === 'error' && failure.message ? ` (${failure.message})` : '';
  const draftNote = keepsDraft ? ' 복구본은 남아 있습니다.' : '';
  return {
    text: `${FAILURE_TEXT[failure.reason]}${detail}${draftNote}`,
    clean: false,
    canDownload: keepsDraft,
    canOpen: !stoppedByTrap && (failure.reason === 'permission-denied' || failure.reason === 'error'),
  };
}

/** 모든 문서를 잃은 것 없이 다시 열었으면 알림 한 줄로 끝낸다. 아니면 결과 대화상자를 연다. */
export function trapRecoveryNeedsReview(report: TrapRecoveryReport): boolean {
  return report.stoppedByTrap
    || report.outcomes.some((outcome) => !describeTrapOutcome(outcome, report.stoppedByTrap).clean);
}

export function trapRecoverySummary(report: TrapRecoveryReport): string {
  const opened = report.outcomes.filter((outcome) => outcome.status === 'opened').length;
  const interrupted = report.interruptedThreadIds.length > 0
    ? '\n중단된 채팅은 채팅 목록에서 이어서 진행할 수 있습니다.'
    : '';
  return `문서 ${opened}개를 다시 열었습니다.${interrupted}`;
}
