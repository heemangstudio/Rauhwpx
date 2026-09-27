import type {
  BlobId,
  BranchRef,
  MergeResolution,
  MergeConflict,
  VersionMergeDraft,
} from './types.ts';

function unitIdentity(unit: MergeConflict): string {
  return JSON.stringify([
    unit.fingerprint, unit.kind, unit.automatic === true,
    [...(unit.dependencyIds ?? [])].sort(), unit.supportsBoth, unit.supportsManual,
  ]);
}

/** Decisions are portable only between uniquely identified units of the same analysis. */
export function carriedMergeResolutions(
  previous: VersionMergeDraft | undefined,
  analysisVersion: number,
  conflicts: readonly MergeConflict[],
): Record<string, MergeResolution> {
  if (!previous || previous.analysisVersion !== analysisVersion) return {};
  const prior = new Map<string, MergeResolution | null>();
  for (const unit of previous.conflicts) {
    const identity = unitIdentity(unit);
    prior.set(identity, prior.has(identity) ? null : previous.resolutions[unit.id] ?? null);
  }
  const counts = new Map<string, number>();
  for (const unit of conflicts) counts.set(unitIdentity(unit), (counts.get(unitIdentity(unit)) ?? 0) + 1);
  return Object.fromEntries(conflicts.flatMap((unit) => {
    const identity = unitIdentity(unit);
    const choice = prior.get(identity);
    return choice && counts.get(identity) === 1 ? [[unit.id, structuredClone(choice)]] : [];
  }));
}

function resolutionAssetIds(resolutions: Readonly<Record<string, MergeResolution>>): BlobId[] {
  const ids = new Set<BlobId>();
  for (const resolution of Object.values(resolutions)) {
    if (resolution.kind !== 'manual' || !resolution.payload || typeof resolution.payload !== 'object') continue;
    const id = (resolution.payload as Record<string, unknown>).assetBlobId;
    if (typeof id === 'string') ids.add(id as BlobId);
  }
  return [...ids];
}

/**
 * Resolver-local Undo history is meaningful only for the exact analyzed heads.
 * On recomputation, keep fingerprint-carried resolutions and only their assets;
 * obsolete history entries must not address conflicts from the previous run.
 */
export function retainedMergeDraftLocalState(
  previous: VersionMergeDraft | undefined,
  target: BranchRef,
  source: BranchRef,
  carriedResolutions: Readonly<Record<string, MergeResolution>>,
  analysisVersion = previous?.analysisVersion,
  conflicts: readonly MergeConflict[] = previous?.conflicts ?? [],
): Pick<VersionMergeDraft, 'manualAssetBlobIds' | 'history' | 'historyIndex'> {
  const headsChanged = Boolean(previous && (
    previous.analysisVersion !== analysisVersion
    || JSON.stringify(previous.conflicts.map((unit) => [unit.id, unitIdentity(unit)]))
      !== JSON.stringify(conflicts.map((unit) => [unit.id, unitIdentity(unit)]))
    || new Set(conflicts.map(unitIdentity)).size !== conflicts.length
    || previous.currentHead !== target.target
    || previous.sourceHead !== source.target
    || previous.targetBranchGeneration !== target.generation
    || previous.sourceBranchGeneration !== source.generation
  ));
  if (!previous) return { manualAssetBlobIds: [], history: [], historyIndex: 0 };
  if (!headsChanged) {
    return {
      manualAssetBlobIds: [...previous.manualAssetBlobIds],
      history: structuredClone(previous.history),
      historyIndex: previous.historyIndex,
    };
  }
  return {
    manualAssetBlobIds: resolutionAssetIds(carriedResolutions),
    history: [],
    historyIndex: 0,
  };
}
