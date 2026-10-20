import { compareSnapshots } from '../compare/diff-engine.ts';
import type { CompareDocumentSnapshot, CompareOptions } from '../compare/types.ts';
import { VERSION_COMPARE_OPTIONS } from './snapshot.ts';
import type { CommitId, VersionCommit } from './types.ts';

/** 내용이 가장 가까운 커밋을 찾을 때 살펴보는 현재 브랜치 조상 수. */
export const IMPORT_BASE_SCAN_LIMIT = 16;
/** 이보다 덜 닮으면 기준을 고르지 않고 사용자에게 묻는다. */
export const IMPORT_BASE_MIN_SIMILARITY = 0.4;

/**
 * 외부 문서는 다른 편집기 세션에서 열린 것이라 문단 stable_id 가 이어지지 않는다. 버전 비교의 identity
 * 대신 문서 비교와 같은 정렬로 맞추고, 후보마다 시간을 짧게 둔다.
 */
const IMPORT_COMPARE_OPTIONS: CompareOptions = {
  ...VERSION_COMPARE_OPTIONS,
  strategy: 'alignment',
  performanceTuning: { maxComputeMs: 400, hardSegmentCells: 80_000 },
};

export interface ImportBaseCandidate {
  commitId: CommitId;
  /** 0..1. 1 이면 내용이 같다. */
  similarity: number;
}

export interface ImportBaseDetection {
  /** 바이트가 같은 커밋. 있으면 묻지 않고 이 커밋을 쓴다. */
  exact: CommitId | null;
  /** 미리 고를 기준. 충분히 닮은 커밋이 없으면 null 이고 사용자가 골라야 한다. */
  suggested: CommitId | null;
  confidence: 'exact' | 'close' | 'none';
  /** 닮은 순서. 같은 점수면 더 최근 커밋이 앞이다. */
  candidates: ImportBaseCandidate[];
}

type ImportCommit = Pick<VersionCommit, 'id' | 'parents' | 'ordinal' | 'blobId' | 'contentFingerprint' | 'compareSnapshotId'>;

/** head 에서 부모를 따라 최근 커밋부터 limit 개. 병합 커밋은 두 부모를 모두 따라간다. */
export function importBaseAncestry(
  head: CommitId,
  commits: ReadonlyMap<CommitId, ImportCommit>,
  limit = IMPORT_BASE_SCAN_LIMIT,
): CommitId[] {
  const seen = new Set<CommitId>();
  const frontier: ImportCommit[] = [];
  const push = (id: CommitId) => {
    const commit = commits.get(id);
    if (!commit || seen.has(id)) return;
    seen.add(id);
    frontier.push(commit);
  };
  push(head);
  const result: CommitId[] = [];
  while (frontier.length > 0 && result.length < limit) {
    frontier.sort((left, right) => right.ordinal - left.ordinal);
    const next = frontier.shift()!;
    result.push(next.id);
    for (const parent of next.parents) push(parent);
  }
  return result;
}

/** 외부 바이트(원본 그대로, 그리고 이 문서 형식으로 다시 내보낸 것)와 같은 블롭을 가진 커밋. */
export function findExactImportBase(
  hashes: readonly string[],
  commits: Iterable<ImportCommit>,
): CommitId | null {
  const wanted = new Set(hashes.map(String));
  let best: ImportCommit | null = null;
  for (const commit of commits) {
    if (!wanted.has(String(commit.blobId)) && !wanted.has(String(commit.contentFingerprint))) continue;
    if (!best || commit.ordinal > best.ordinal) best = commit;
  }
  return best?.id ?? null;
}

/** 두 스냅샷이 얼마나 닮았는지. 바뀐 항목 수를 문서 크기로 나눈 만큼 깎는다. */
export function importSimilarity(base: CompareDocumentSnapshot, incoming: CompareDocumentSnapshot): number {
  const units = Math.max(
    1,
    base.paragraphs.length + base.controls.length,
    incoming.paragraphs.length + incoming.controls.length,
  );
  const changes = compareSnapshots(base, incoming, IMPORT_COMPARE_OPTIONS).diffItems.length;
  return Math.max(0, 1 - changes / units);
}

export interface DetectImportBaseInput {
  /** 외부 파일 바이트와 다시 내보낸 바이트의 해시. */
  hashes: readonly string[];
  incoming: CompareDocumentSnapshot;
  /** 정확히 같은 블롭을 찾을 커밋들(불러온 기록 전체). */
  commits: readonly ImportCommit[];
  /** 내용으로 견줄 후보. 보통 importBaseAncestry 결과. */
  candidateIds: readonly CommitId[];
  loadSnapshot(commit: ImportCommit): Promise<CompareDocumentSnapshot | null>;
  /** 후보 사이에 메인 스레드를 쉬게 한다. */
  yieldBetween?: () => Promise<void>;
}

export async function detectImportBase(input: DetectImportBaseInput): Promise<ImportBaseDetection> {
  const byId = new Map(input.commits.map((commit) => [commit.id, commit]));
  const exact = findExactImportBase(input.hashes, input.commits);
  if (exact) {
    return { exact, suggested: exact, confidence: 'exact', candidates: [{ commitId: exact, similarity: 1 }] };
  }
  const scored: Array<ImportBaseCandidate & { ordinal: number }> = [];
  for (const id of input.candidateIds) {
    const commit = byId.get(id);
    if (!commit) continue;
    const snapshot = await input.loadSnapshot(commit);
    if (!snapshot) continue;
    scored.push({ commitId: id, similarity: importSimilarity(snapshot, input.incoming), ordinal: commit.ordinal });
    await input.yieldBetween?.();
  }
  scored.sort((left, right) => right.similarity - left.similarity || right.ordinal - left.ordinal);
  const candidates = scored.map(({ commitId, similarity }) => ({ commitId, similarity }));
  const best = candidates[0];
  const close = best !== undefined && best.similarity >= IMPORT_BASE_MIN_SIMILARITY;
  return {
    exact: null,
    suggested: close ? best.commitId : null,
    confidence: close ? 'close' : 'none',
    candidates,
  };
}
