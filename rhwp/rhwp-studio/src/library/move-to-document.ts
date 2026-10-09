import type { RecentDoc } from '../recent/recent-store.ts';
import { claimForExplorerGroup } from '../project-file/claim.ts';
import type { ProjectFileClaim } from '../project-file/identity.ts';
import type { ProjectOpenOutcome } from '../project-file/open.ts';

export interface LibraryDocumentTarget {
  documentId: string | null;
  fileName: string | null;
}

export interface LibraryMoveCurrent {
  documentId: string | null;
  fileName: string | null;
  hasDocument: boolean;
  /** 마지막 저장 이후 바뀐 내용이 있는지. 바뀌지 않은 문서는 다시 쓰지 않는다. */
  isDirty: boolean;
}

export type LibraryMoveResult = 'moved' | 'same' | 'cancelled' | 'failed';

export interface MoveToLibraryDocumentDeps {
  getCurrent: () => LibraryMoveCurrent;
  saveCurrent: () => Promise<'saved' | 'cancelled' | 'failed' | 'unsupported'>;
  listRecent: () => Promise<RecentDoc[]>;
  openProjectFile: (claim: ProjectFileClaim) => Promise<ProjectOpenOutcome>;
  openViaPicker: () => Promise<void>;
  toast: (message: string) => void;
  /** 현재 문서의 커밋하지 않은 변경을 버전 기록에 커밋한다. 남길 것이 없으면 조용히 끝낸다. */
  commitCurrent?: () => Promise<void>;
}

export interface MoveToLibraryDocumentOptions {
  /** 저장한 뒤 대상 문서를 열기 전에 현재 문서를 버전 기록에 커밋한다. */
  commit?: boolean;
}

export function isSameLibraryDocument(
  current: LibraryMoveCurrent,
  target: LibraryDocumentTarget,
): boolean {
  if (target.documentId && current.documentId) {
    return target.documentId === current.documentId;
  }
  if (target.fileName && current.fileName) {
    return target.fileName === current.fileName;
  }
  return false;
}

export function findLibraryRecentDoc(
  recents: RecentDoc[],
  target: LibraryDocumentTarget,
): RecentDoc | undefined {
  if (!target.documentId) return undefined;
  return recents.find((row) => row.documentId === target.documentId);
}

export function canMoveToLibraryDocument(target: LibraryDocumentTarget): boolean {
  return Boolean(target.documentId || target.fileName);
}

const MAX_SAVE_ATTEMPTS = 3;

/**
 * 현재 문서를 떠나기 전에 바뀐 내용을 저장하고, 원하면 버전 기록에 커밋한다.
 * 다른 문서로 옮기거나 열린 다른 문서 세션으로 넘어갈 때 함께 쓴다.
 */
export async function saveAndCommitBeforeLeaving(
  deps: Pick<MoveToLibraryDocumentDeps, 'getCurrent' | 'saveCurrent' | 'toast' | 'commitCurrent'>,
  options: MoveToLibraryDocumentOptions = {},
): Promise<'ok' | 'cancelled' | 'failed'> {
  const current = deps.getCurrent();
  // 바뀐 내용이 있을 때만 저장한다. 깨끗한 문서를 저장하면 원본 파일이 엔진이 다시 만든
  // 바이트로 덮어써져, 이동할 때마다 서식이 조금씩 무너진다.
  // 저장하는 동안 들어온 편집도 대상 문서를 열면 사라지므로, 깨끗해질 때까지 다시 저장한다.
  for (let attempt = 0; current.hasDocument && deps.getCurrent().isDirty; attempt += 1) {
    const saved = attempt < MAX_SAVE_ATTEMPTS ? await deps.saveCurrent() : 'failed';
    if (saved === 'cancelled') return 'cancelled';
    if (saved !== 'saved') {
      deps.toast('현재 문서를 저장하지 못해 이동하지 않았습니다.');
      return 'failed';
    }
  }

  // 작업은 저장으로 이미 지켰으므로 커밋에 실패해도 이동은 계속한다.
  if (options.commit && current.hasDocument && deps.commitCurrent) {
    try {
      await deps.commitCurrent();
    } catch {
      deps.toast('버전 기록에 커밋하지 못했습니다.');
    }
  }

  return 'ok';
}

export async function moveToLibraryDocument(
  target: LibraryDocumentTarget,
  deps: MoveToLibraryDocumentDeps,
  options: MoveToLibraryDocumentOptions = {},
): Promise<LibraryMoveResult> {
  if (!canMoveToLibraryDocument(target)) {
    deps.toast('이동할 문서를 찾을 수 없습니다.');
    return 'failed';
  }

  const current = deps.getCurrent();
  if (isSameLibraryDocument(current, target)) return 'same';

  const left = await saveAndCommitBeforeLeaving(deps, options);
  if (left !== 'ok') return left;

  if (!target.documentId) {
    deps.toast(
      `"${target.fileName ?? '선택한 문서'}"을(를) 자동으로 열 수 없습니다. 파일을 선택하세요.`,
    );
    await deps.openViaPicker();
    return 'moved';
  }

  const recents = await deps.listRecent();
  const claim = claimForExplorerGroup(
    { documentId: target.documentId, displayName: target.fileName },
    recents,
  );
  if (!claim) {
    deps.toast('이동할 문서를 찾을 수 없습니다.');
    return 'failed';
  }

  const opened = await deps.openProjectFile(claim);
  if (opened.kind === 'opened') return 'moved';
  if (opened.kind === 'cancelled') return 'cancelled';
  return 'failed';
}
