import type { AutosaveDraft, AutosaveDraftSummary } from './autosave-store.ts';
import type { AutosaveRecoveryChoice } from './recovery-ui.ts';
import { recoveryFileName } from './recovery-format.ts';

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

export interface AutosaveRestoreDeps {
  readDraft: (id: string) => Promise<AutosaveDraft | null>;
  /** 저장·버리기 확인을 마친 현재 문서를 정리한다. dirty 로 남아 있으면 버리기를 고른 것이다. */
  releaseCurrentDocument: () => void;
  /** 복구본을 연다. 자동 저장은 draftId 를 그대로 이어 써서 복구본을 제자리에서 갱신한다. */
  load: (bytes: Uint8Array, fileName: string, draftId: string) => Promise<void>;
  markDirty: () => void;
  /** 복구한 내용을 지금 소유 창 이름으로 다시 기록한다. */
  flush: () => Promise<void>;
  toast: (message: string, durationMs: number) => void;
}

/**
 * 복구본을 연다. 복구본은 지우지 않는다. 같은 문서가 다시 크래시를 일으키기 쉬우므로
 * 다음 자동 저장이 같은 id 를 덮어쓸 때까지 디스크에 남아 있어야 한다. 이후 저장·버리기로
 * 문서가 clean 이 되면 자동 저장 관리자가 평소처럼 지운다.
 */
export async function restoreAutosaveDraft(
  summary: AutosaveDraftSummary,
  deps: AutosaveRestoreDeps,
): Promise<void> {
  const draft = await deps.readDraft(summary.id);
  if (!draft || draft.data.byteLength === 0) throw new Error('복구본을 찾지 못했습니다.');
  const fileName = recoveryFileName(draft.fileName);
  // 버리기를 고른 문서가 dirty 로 남아 있으면 복구본을 연 뒤 clean 으로 바뀌면서
  // 자동 저장 관리자가 방금 이어받은 복구본을 지운다. 여는 쪽보다 먼저 정리한다.
  deps.releaseCurrentDocument();
  await deps.load(draft.data, fileName, draft.id);
  deps.markDirty();
  deps.toast(`"${fileName}" 복구본을 열었습니다.\n원본 파일은 자동으로 덮어쓰지 않습니다.`, 5000);
  await deps.flush();
}
