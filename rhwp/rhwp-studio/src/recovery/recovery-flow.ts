import type { FileSystemFileHandleLike } from '../command/file-system-access.ts';
import { fileNameForFormat, saveFormatForFileName } from '../command/save-target.ts';
import type { ProjectFileLocation } from '../project-file/open.ts';
import type { AutosaveDraft, AutosaveDraftSummary } from './autosave-store.ts';
import type { AutosaveRecoveryChoice } from './recovery-ui.ts';
import { draftDataFormat, isLegacyDraft } from './recovery-format.ts';

export interface AutosaveRecoveryOfferDeps {
  listRecoverable: () => Promise<AutosaveDraftSummary[]>;
  /** 문서가 열려 있거나 편집 중이면 true. 이때는 대화상자 대신 안내만 띄운다. */
  hasOpenDocument: () => boolean;
  /** 복구할 수 있다는 안내. open 을 부르면 복구 대화상자를 연다. */
  notifyAvailable: (open: () => void) => void;
  markOffered: (ids: string[]) => Promise<void>;
  showDialog: (drafts: AutosaveDraftSummary[]) => Promise<AutosaveRecoveryChoice>;
  clearRecoverable: () => Promise<void>;
  /** 저장·버리기 확인을 거쳐 현재 문서를 바꿔도 되면 true. */
  canReplaceCurrentDocument: () => Promise<boolean>;
  restore: (draft: AutosaveDraftSummary) => Promise<void>;
  toast: (message: string, durationMs: number) => void;
  onRestoreError: (error: unknown) => void;
}

/**
 * 죽은 창이 남긴 복구본을 제안한다. 문서를 이미 열었으면(크래시 뒤 문서를 더블클릭해 다시
 * 연 경우가 대부분이다) 조용히 넘어가지 않고 안내를 띄워, 사용자가 원할 때 복구 대화상자를 연다.
 */
export async function offerAutosaveRecovery(
  deps: AutosaveRecoveryOfferDeps,
  { fromNotice = false }: { fromNotice?: boolean } = {},
): Promise<void> {
  const drafts = (await deps.listRecoverable()).filter((draft) => draft.byteLength > 0);
  if (drafts.length === 0) {
    if (fromNotice) deps.toast('복구할 자동 저장본이 없습니다.', 2200);
    return;
  }
  if (!fromNotice && deps.hasOpenDocument()) {
    deps.notifyAvailable(() => {
      void offerAutosaveRecovery(deps, { fromNotice: true }).catch(deps.onRestoreError);
    });
    return;
  }

  await deps.markOffered(drafts.map((draft) => draft.id)).catch(() => {});
  const choice = await deps.showDialog(drafts);
  if (choice.action === 'later') return;
  if (choice.action === 'delete-all') {
    await deps.clearRecoverable();
    deps.toast('복구 후보를 삭제했습니다.', 2200);
    return;
  }

  const draft = drafts.find((item) => item.id === choice.draftId);
  if (!draft) return;
  if (!await deps.canReplaceCurrentDocument()) return;
  try {
    await deps.restore(draft);
  } catch (error) {
    deps.onRestoreError(error);
  }
}

export type FoundOriginal = Extract<ProjectFileLocation, { kind: 'found' }> & {
  /** 디스크에서 읽은 바이트의 digest. draft 의 base.digest 와 비교한다. */
  readonly digest: string;
};

export type LocatedOriginal = FoundOriginal | Exclude<ProjectFileLocation, { kind: 'found' }>;

export type DetachedReason = 'never-saved' | 'not-found' | 'permission-denied' | 'changed' | 'format';

export type DraftRestorePlan =
  /** 원본과 연결되지 않은 예전 draft. HWP 로 연다. */
  | { readonly kind: 'legacy'; readonly fileName: string }
  /** 원본 파일이 그대로다. 원본으로 다시 열고 draft 를 dirty 로 얹는다. */
  | { readonly kind: 'reopen-dirty'; readonly original: FoundOriginal }
  /**
   * 엔진이 멈출 때 깨끗했던 문서이고 원본 파일이 그대로다. 원본 바이트로 깨끗하게 다시 열고
   * draft 를 지운다.
   */
  | { readonly kind: 'reopen-clean'; readonly original: FoundOriginal }
  /** 원본 파일이 바뀌었다. 디스크 내용을 외부 변경으로 기록하고 draft 를 병합한다. */
  | { readonly kind: 'merge-external'; readonly original: FoundOriginal }
  /** 원본과 연결하지 않고 같은 이름으로 연다. 저장할 때 위치를 고른다. */
  | { readonly kind: 'detached'; readonly fileName: string; readonly why: DetachedReason }
  /** 원본이 다른 창에서 열려 있다. draft 를 그대로 둔다. */
  | { readonly kind: 'blocked' };

/** draft 의 바이트 형식이 원본 파일 확장자와 다르면 원본에 연결해 덮어쓸 수 없다. */
function formatMatchesOriginal(draft: AutosaveDraftSummary): boolean {
  const target = saveFormatForFileName(draft.fileName);
  return target === null || target === draftDataFormat(draft);
}

/** 원본 파일을 찾아봐야 하는 draft 인지. 이 창이 열거나 저장한 파일 기준이 있어야 한다. */
export function shouldLocateOriginal(draft: AutosaveDraftSummary): boolean {
  return !isLegacyDraft(draft) && formatMatchesOriginal(draft) && Boolean(draft.base);
}

export function planDraftRestore(
  draft: AutosaveDraftSummary,
  located: LocatedOriginal | null,
  options: { canMerge: boolean; cleanAtTrap?: boolean },
): DraftRestorePlan {
  if (isLegacyDraft(draft)) {
    return { kind: 'legacy', fileName: fileNameForFormat(draft.fileName, 'hwp') };
  }
  if (!formatMatchesOriginal(draft)) {
    return { kind: 'detached', fileName: fileNameForFormat(draft.fileName, draftDataFormat(draft)), why: 'format' };
  }
  const base = draft.base;
  if (!base || !located) return { kind: 'detached', fileName: draft.fileName, why: 'never-saved' };
  switch (located.kind) {
    case 'owned-elsewhere':
      return { kind: 'blocked' };
    case 'missing':
      return { kind: 'detached', fileName: draft.fileName, why: 'not-found' };
    case 'permission-denied':
      return { kind: 'detached', fileName: draft.fileName, why: 'permission-denied' };
    case 'found':
      if (located.digest === base.digest) {
        return options.cleanAtTrap
          ? { kind: 'reopen-clean', original: located }
          : { kind: 'reopen-dirty', original: located };
      }
      if (base.mergeable && options.canMerge) return { kind: 'merge-external', original: located };
      return { kind: 'detached', fileName: draft.fileName, why: 'changed' };
  }
}

export const BLOCKED_RESTORE_MESSAGE =
  '이 문서는 다른 창에서 열려 있습니다. 그 창에서 문서를 닫은 뒤 다시 복구하세요.';

const DETACHED_MESSAGES: Record<DetachedReason, string> = {
  'never-saved': '저장하지 않은 문서를 복구했습니다.',
  'not-found': '원본 파일을 찾지 못해 연결하지 않고 열었습니다. 저장할 때 위치를 선택하세요.',
  'permission-denied': '원본 파일에 접근할 수 없어 연결하지 않고 열었습니다. 저장할 때 위치를 선택하세요.',
  changed: '원본 파일이 바뀌어 연결하지 않고 열었습니다. 저장할 때 위치를 선택하세요.',
  format: '원본과 다른 형식으로 복구해 연결하지 않고 열었습니다. 저장할 때 위치를 선택하세요.',
};

export interface OpenDraftTarget {
  fileName: string;
  /** 원본으로 다시 열 때만 있다. 디스크 바이트와 핸들을 문서에 연결한다. */
  original: FoundOriginal | null;
  /** null 이면 새 문서 ID 를 만든다(예전 draft). */
  documentId: string | null;
  /** true 면 draft 대신 원본 바이트를 깨끗한 문서로 연다 (original 이 있어야 한다). */
  clean?: boolean;
}

/**
 * 복구 한 건의 결과. 여러 문서를 한꺼번에 다시 여는 쪽(엔진 trap 복구)은 알림 대신 이 결과를 모아
 * 한 번에 보여 준다. message 는 알림으로 띄웠을 문구다.
 */
export type DraftRestoreOutcome =
  | {
    readonly kind: 'opened';
    readonly plan: 'reopen-dirty' | 'reopen-clean' | 'legacy' | 'detached';
    readonly detached: DetachedReason | null;
    readonly message: string;
  }
  | { readonly kind: 'merging'; readonly message: string }
  | { readonly kind: 'blocked'; readonly message: string }
  | { readonly kind: 'cancelled' };

export interface DraftRestoreOptions {
  /** 엔진이 멈출 때 깨끗했던 문서. 원본이 그대로면 원본으로 깨끗하게 연다. */
  cleanAtTrap?: boolean;
  /** 있으면 알림을 띄우지 않고 결과를 여기로 보낸다. */
  report?: (outcome: DraftRestoreOutcome) => void;
}

export type MergeExternalResult =
  | {
    kind: 'merging';
    /** 이 문서에 버전 기록이 없어 이번에 켰으면 true. */
    enabledHistory: boolean;
    /** 병합을 마치면 true, 병합하지 않고 닫으면 false 로 끝난다. */
    completion: Promise<boolean>;
  }
  /** 병합 기준을 쓸 수 없어 원본과 연결하지 않고 열었다. */
  | { kind: 'detached' }
  /** 원본이 다른 창에서 열려 있다. */
  | { kind: 'blocked' }
  /** 사용자가 문서 전환을 취소했다. draft 는 그대로 둔다. */
  | { kind: 'cancelled' };

/** opened: 열었다. blocked: 원본이 다른 창에 열려 있다. cancelled: 사용자가 문서 전환을 취소했다. */
export type OpenDraftOutcome = 'opened' | 'blocked' | 'cancelled';

export interface AutosaveRestoreDeps {
  readDraft: (id: string) => Promise<AutosaveDraft | null>;
  /** 파일 선택 창 없이 원본 파일을 찾는다. */
  locateOriginal: (draft: AutosaveDraft) => Promise<ProjectFileLocation>;
  digestOf: (bytes: Uint8Array) => string;
  /** 쓰지 않을 핸들을 푼다(데스크톱은 경로 점유를 놓는다). */
  releaseHandle: (handle: FileSystemFileHandleLike) => Promise<void>;
  /** 버전 기록으로 병합할 수 있으면 true. */
  canMerge: () => boolean;
  /** 저장·버리기 확인을 마친 현재 문서를 정리한다. dirty 로 남아 있으면 버리기를 고른 것이다. */
  releaseCurrentDocument: () => void;
  /**
   * draft 를 dirty 상태로 연다. 자동 저장은 draft id 를 그대로 이어 써서 복구본을 제자리에서
   * 갱신한다.
   */
  openDraft: (draft: AutosaveDraft, target: OpenDraftTarget) => Promise<OpenDraftOutcome>;
  /** 디스크 파일을 열고 외부 변경을 기록한 뒤 draft 병합 창을 연다. */
  mergeExternal: (draft: AutosaveDraft, original: FoundOriginal) => Promise<MergeExternalResult>;
  deleteDraft: (id: string) => Promise<void>;
  /** 복구한 내용을 지금 소유 창 이름으로 다시 기록한다. */
  flush: () => Promise<void>;
  toast: (message: string, durationMs: number) => void;
}

/**
 * 자동 저장본을 원래 문서로 다시 연다. 원본 파일이 그대로면 원본에 dirty 로 얹고, 바뀌었으면
 * 디스크 내용을 외부 변경으로 기록한 뒤 병합한다. 원본을 찾지 못하면 연결하지 않고 연다.
 * 직접 저장하기 전에는 파일에 아무것도 쓰지 않는다.
 *
 * 다시 연 draft 는 지우지 않는다. 같은 문서가 다시 크래시를 일으키기 쉬우므로 다음 자동 저장이
 * 같은 id 를 덮어쓸 때까지 남겨 두고, 저장·버리기로 문서가 clean 이 되면 자동 저장 관리자가 지운다.
 * 병합하는 draft 는 병합을 마친 뒤에만 지운다.
 */
export async function restoreAutosaveDraft(
  summary: AutosaveDraftSummary,
  deps: AutosaveRestoreDeps,
  options: DraftRestoreOptions = {},
): Promise<DraftRestoreOutcome> {
  const finish = (outcome: DraftRestoreOutcome, durationMs = 5000): DraftRestoreOutcome => {
    if (options.report) options.report(outcome);
    else if (outcome.kind !== 'cancelled') deps.toast(outcome.message, durationMs);
    return outcome;
  };
  const draft = await deps.readDraft(summary.id);
  if (!draft || draft.data.byteLength === 0) throw new Error('자동 저장본을 찾지 못했습니다.');

  let located: LocatedOriginal | null = null;
  if (shouldLocateOriginal(draft)) {
    const location = await deps.locateOriginal(draft);
    located = location.kind === 'found' ? { ...location, digest: deps.digestOf(location.bytes) } : location;
  }
  const plan = planDraftRestore(draft, located, {
    canMerge: deps.canMerge(),
    cleanAtTrap: options.cleanAtTrap,
  });
  const usesOriginal = plan.kind === 'reopen-dirty' || plan.kind === 'reopen-clean'
    || plan.kind === 'merge-external';
  if (located?.kind === 'found' && !usesOriginal) await deps.releaseHandle(located.handle);

  if (plan.kind === 'blocked') {
    return finish({ kind: 'blocked', message: BLOCKED_RESTORE_MESSAGE });
  }

  // 버리기를 고른 문서가 dirty 로 남아 있으면 복구본을 연 뒤 clean 으로 바뀌면서
  // 자동 저장 관리자가 방금 이어받은 복구본을 지운다. 여는 쪽보다 먼저 정리한다.
  deps.releaseCurrentDocument();

  if (plan.kind === 'merge-external') {
    const merged = await deps.mergeExternal(draft, plan.original);
    if (merged.kind === 'cancelled') return finish({ kind: 'cancelled' });
    if (merged.kind === 'blocked') {
      return finish({ kind: 'blocked', message: BLOCKED_RESTORE_MESSAGE });
    }
    if (merged.kind === 'detached') {
      const outcome = finish({
        kind: 'opened', plan: 'detached', detached: 'changed', message: DETACHED_MESSAGES.changed,
      });
      await deps.flush();
      return outcome;
    }
    const enabled = merged.enabledHistory ? '\n이 문서의 버전 기록을 켰습니다.' : '';
    const outcome = finish({
      kind: 'merging',
      message: `디스크에서 바뀐 내용을 "외부 변경"으로 기록했습니다. 복구한 변경을 병합하세요.${enabled}`,
    }, 6000);
    void merged.completion.then(async (done) => {
      if (done) await deps.deleteDraft(draft.id);
    }).catch(() => {});
    return outcome;
  }

  const target: OpenDraftTarget = plan.kind === 'reopen-dirty' || plan.kind === 'reopen-clean'
    ? {
      fileName: plan.original.name,
      original: plan.original,
      documentId: draft.documentId ?? null,
      ...(plan.kind === 'reopen-clean' ? { clean: true } : {}),
    }
    : plan.kind === 'detached'
      ? { fileName: plan.fileName, original: null, documentId: draft.documentId ?? null }
      : { fileName: plan.fileName, original: null, documentId: null };
  const opened = await deps.openDraft(draft, target);
  if (opened === 'cancelled') return finish({ kind: 'cancelled' });
  if (opened === 'blocked') {
    return finish({ kind: 'blocked', message: BLOCKED_RESTORE_MESSAGE });
  }
  if (plan.kind === 'reopen-clean') {
    // 깨끗하게 연 문서에는 남길 변경이 없다. 남은 draft 는 다음 시작의 복구 제안에 끼지 않게 지운다.
    await deps.deleteDraft(draft.id);
    return finish({
      kind: 'opened', plan: 'reopen-clean', detached: null, message: `"${target.fileName}"을(를) 다시 열었습니다.`,
    });
  }
  const outcome = finish({
    kind: 'opened',
    plan: plan.kind,
    detached: plan.kind === 'detached' ? plan.why : null,
    message: plan.kind === 'reopen-dirty'
      ? `"${target.fileName}"의 저장하지 않은 변경을 복구했습니다.`
      : plan.kind === 'detached'
        ? DETACHED_MESSAGES[plan.why]
        : `"${target.fileName}" 자동 저장본을 열었습니다.`,
  });
  await deps.flush();
  return outcome;
}
