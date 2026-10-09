import type { FileSystemFileHandleLike } from '../command/file-system-access.ts';
import {
  judgeCandidate,
  type CandidateFacts,
  type DocumentDigest,
  type IdentityVerdict,
  type ProjectFileClaim,
} from './identity.ts';

export type ProjectOpenOutcome =
  | { readonly kind: 'opened' }
  | { readonly kind: 'owned-elsewhere' }
  | { readonly kind: 'permission-denied' }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'not-this-file' }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'untraceable' };

export interface NativeProbe {
  readonly probeId: string;
  readonly fileName: string;
}

export interface ProjectFileDeps {
  ensurePermission: (handle: FileSystemFileHandleLike) => Promise<boolean>;
  readHandle: (handle: FileSystemFileHandleLike) => Promise<{ bytes: Uint8Array; name: string }>;
  digestOf: (bytes: Uint8Array) => DocumentDigest;
  loadBound: (
    bytes: Uint8Array,
    name: string,
    handle: FileSystemFileHandleLike,
    documentId: string,
  ) => Promise<void>;
  pickForProject?: (displayName: string) => Promise<FileSystemFileHandleLike | 'owned' | null>;
  forgetRecent?: (recentId: string) => Promise<void>;
  toast?: (message: string, durationMs: number) => void;
  reopenRemembered?: (documentId: string) => Promise<FileSystemFileHandleLike | 'owned' | null>;
  searchNearby?: (query: {
    documentId: string;
    basenameHint: string;
  }) => Promise<readonly NativeProbe[] | 'owned' | null>;
  readProbe?: (probeId: string) => Promise<{ bytes: Uint8Array; fileName: string }>;
  claimProbe?: (probeId: string) => Promise<FileSystemFileHandleLike | 'owned' | null>;
  locationOf?: (
    handle: FileSystemFileHandleLike,
    documentId: string,
  ) => Promise<CandidateFacts['location']>;
}

export async function openProjectFile(
  claim: ProjectFileClaim,
  deps: ProjectFileDeps,
): Promise<ProjectOpenOutcome> {
  const live = await tryLiveHandle(claim, deps);
  if (live) return live;

  const remembered = await tryRemembered(claim, deps);
  if (remembered) return remembered;

  // 기억한 위치가 없고 최근 문서 기록(내용 digest·핸들)도 없다 — 저장한 적 없는 새 문서이거나
  // 기록이 지워진 문서다. 고른 파일을 이 문서와 맞춰 볼 근거가 없으니 파일 선택 창을 띄우지 않는다.
  if (!claim.recentId && !claim.knownDigest && !claim.liveHandle) return { kind: 'untraceable' };

  const nearby = await tryNearby(claim, deps);
  if (nearby) return nearby;

  if (!deps.pickForProject) return { kind: 'not-found' };
  return pickForProject(claim, deps);
}

async function tryLiveHandle(
  claim: ProjectFileClaim,
  deps: ProjectFileDeps,
): Promise<ProjectOpenOutcome | null> {
  const handle = claim.liveHandle;
  if (!handle) return null;

  let granted = false;
  try {
    granted = await deps.ensurePermission(handle);
  } catch {
    granted = false;
  }
  if (!granted) {
    deps.toast?.(`"${claim.displayName}" 접근 권한이 거부되어 열 수 없습니다.`, 3000);
    return { kind: 'permission-denied' };
  }

  try {
    const { bytes, name } = await deps.readHandle(handle);
    const facts: CandidateFacts = {
      digest: deps.digestOf(bytes),
      entry: 'same',
      location: 'unknown',
    };
    return await bindIfConfirmed(claim, facts, bytes, name, async () => handle, deps);
  } catch (error) {
    if (handle.identityKind !== 'native-path' && claim.recentId) {
      await deps.forgetRecent?.(claim.recentId);
      deps.toast?.(`"${claim.displayName}" 파일을 찾을 수 없어 목록에서 제거했습니다.`, 3500);
    } else if (!(error instanceof DOMException && error.name === 'NotFoundError')) {
      // 닫은 문서·지난 실행의 네이티브 핸들은 NotFoundError 로 온다. 기억해 둔 위치로 다시 여는
      // 평범한 경로이므로 경고하지 않는다.
      console.warn('[project-file] 라이브 핸들 읽기 실패:', error);
    }
    return null;
  }
}

async function tryRemembered(
  claim: ProjectFileClaim,
  deps: ProjectFileDeps,
): Promise<ProjectOpenOutcome | null> {
  if (!deps.reopenRemembered) return null;
  let restored: FileSystemFileHandleLike | 'owned' | null;
  try {
    restored = await deps.reopenRemembered(claim.documentId);
  } catch (error) {
    console.warn('[project-file] native restore failed:', error);
    return null;
  }
  if (restored === 'owned') return ownedElsewhere(deps);
  if (!restored) return null;
  let opened: ProjectOpenOutcome | null = null;
  try {
    const { bytes, name } = await deps.readHandle(restored);
    const facts: CandidateFacts = {
      digest: deps.digestOf(bytes),
      entry: await entryAgainst(restored, claim.liveHandle),
      location: 'remembered',
    };
    opened = await bindIfConfirmed(claim, facts, bytes, name, async () => restored, deps);
  } catch {
    opened = null;
  }
  // 복원한 핸들은 이 창에 경로를 등록한다. 쓰지 않으면 풀어야 다른 창이 그 파일을 열 수 있다.
  if (!opened) await releaseUnusedHandle(restored);
  return opened;
}

async function tryNearby(
  claim: ProjectFileClaim,
  deps: ProjectFileDeps,
): Promise<ProjectOpenOutcome | null> {
  if (!deps.searchNearby || !deps.readProbe || !deps.claimProbe) return null;
  let nearby: readonly NativeProbe[] | 'owned' | null;
  try {
    nearby = await deps.searchNearby({
      documentId: claim.documentId,
      basenameHint: claim.displayName,
    });
  } catch (error) {
    console.warn('[project-file] nearby search failed:', error);
    return null;
  }
  if (nearby === 'owned') return ownedElsewhere(deps);
  if (!nearby) return null;

  for (const probe of nearby) {
    try {
      const { bytes, fileName } = await deps.readProbe(probe.probeId);
      const facts: CandidateFacts = {
        digest: deps.digestOf(bytes),
        entry: 'uncomparable',
        location: 'not-remembered',
      };
      const opened = await bindIfConfirmed(
        claim,
        facts,
        bytes,
        fileName,
        () => deps.claimProbe!(probe.probeId),
        deps,
      );
      if (opened) return opened;
    } catch {
      continue;
    }
  }
  return null;
}

async function pickForProject(
  claim: ProjectFileClaim,
  deps: ProjectFileDeps,
): Promise<ProjectOpenOutcome> {
  const pick = deps.pickForProject;
  if (!pick) return { kind: 'not-found' };

  let retried = false;
  for (;;) {
    const picked = await pick(claim.displayName);
    if (picked === 'owned') return ownedElsewhere(deps);
    if (!picked) return { kind: 'cancelled' };

    let bytes: Uint8Array;
    let name: string;
    try {
      ({ bytes, name } = await deps.readHandle(picked));
    } catch {
      await releaseUnusedHandle(picked);
      deps.toast?.('선택한 파일을 읽지 못했습니다.', 4000);
      return { kind: 'not-this-file' };
    }

    let verdict: IdentityVerdict;
    try {
      const facts: CandidateFacts = {
        digest: deps.digestOf(bytes),
        entry: await entryAgainst(picked, claim.liveHandle),
        location: await deps.locationOf?.(picked, claim.documentId) ?? 'unknown',
      };
      verdict = judgeCandidate(claim, facts);
      if (verdict.kind === 'confirmed') {
        await deps.loadBound(bytes, name, picked, claim.documentId);
        return { kind: 'opened' };
      }
    } catch (error) {
      await releaseUnusedHandle(picked);
      throw error;
    }
    // 이 프로젝트 문서가 아닌 파일은 열지 않는다. 고른 핸들이 경로를 붙잡지 않게 푼다.
    await releaseUnusedHandle(picked);
    if (verdict.kind === 'refuted' && !retried) {
      retried = true;
      deps.toast?.('이 파일은 이 프로젝트 문서가 아닙니다. 다시 선택하세요.', 4000);
      continue;
    }
    toastRejectedPick(verdict, deps);
    return { kind: 'not-this-file' };
  }
}

async function bindIfConfirmed(
  claim: ProjectFileClaim,
  facts: CandidateFacts,
  bytes: Uint8Array,
  name: string,
  acquire: () => Promise<FileSystemFileHandleLike | 'owned' | null>,
  deps: ProjectFileDeps,
): Promise<ProjectOpenOutcome | null> {
  if (judgeCandidate(claim, facts).kind !== 'confirmed') return null;
  const handle = await acquire();
  if (handle === 'owned') return ownedElsewhere(deps);
  if (!handle) return null;
  try {
    await deps.loadBound(bytes, name, handle, claim.documentId);
  } catch (error) {
    await releaseUnusedHandle(handle);
    throw error;
  }
  return { kind: 'opened' };
}

/**
 * 이번 호출이 새로 만든 저장 대상만 푼다. 현재 문서가 이미 쓰는 핸들은
 * releaseUnusedSaveTarget 이 건드리지 않는다.
 */
async function releaseUnusedHandle(handle: FileSystemFileHandleLike): Promise<void> {
  try {
    await handle.releaseUnusedSaveTarget?.();
  } catch {
    /* 해제 실패는 창을 닫을 때 정리된다 */
  }
}

async function entryAgainst(
  candidate: FileSystemFileHandleLike,
  live: FileSystemFileHandleLike | null,
): Promise<CandidateFacts['entry']> {
  if (live && candidate === live) return 'same';
  if (!live || typeof candidate.isSameEntry !== 'function') return 'uncomparable';
  try {
    return await candidate.isSameEntry(live) ? 'same' : 'different';
  } catch {
    return 'uncomparable';
  }
}

function toastRejectedPick(
  verdict: IdentityVerdict,
  deps: ProjectFileDeps,
): void {
  if (verdict.kind === 'refuted') {
    deps.toast?.('이 파일은 이 프로젝트 문서가 아닙니다.', 4000);
    return;
  }
  if (verdict.kind === 'inconclusive' && verdict.why === 'no-known-digest') {
    deps.toast?.('선택한 파일이 이 프로젝트 문서인지 확인할 수 없어 열지 않았습니다.', 4000);
    return;
  }
  deps.toast?.('선택한 파일의 내용이 이 프로젝트 문서와 달라 열지 않았습니다.', 4000);
}

function ownedElsewhere(deps: ProjectFileDeps): ProjectOpenOutcome {
  deps.toast?.('다른 창에서 이미 열려 있는 문서입니다.', 3000);
  return { kind: 'owned-elsewhere' };
}
