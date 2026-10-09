import assert from 'node:assert/strict';
import test from 'node:test';
import { VersionGraphStore } from '../src/versioning/store.ts';
import { fingerprintBytes, hashBytes } from '../src/versioning/hash.ts';
import { branchName, documentId, mergeDraftId, VersionError } from '../src/versioning/types.ts';

function payload(value: number) {
  const bytes = new Uint8Array([value]);
  return {
    bytes, contentFingerprint: fingerprintBytes(bytes),
    compareSnapshot: { meta: { name: 'test', sectionCount: 0, pageCount: 0 }, paragraphs: [], controls: [] },
    title: 'Initial', titleRevision: 0, titleOrigin: 'manual' as const,
    author: { kind: 'user' as const, label: 'Tester' },
  };
}

async function setup() {
  const store = new VersionGraphStore({ indexedDB: null });
  const initial = payload(1);
  const graph = await store.createRepository({ documentId: documentId('primary'), lastSavedFingerprint: initial.contentFingerprint, initial });
  const primary = await store.ensurePrimaryWorktree({ repositoryId: graph.repository.id, documentId: graph.repository.documentId,
    branch: graph.branch.name, fileName: 'primary.hwpx', sourceFormat: 'hwpx' });
  return { store, graph, primary };
}

function forkInput({ graph }: Awaited<ReturnType<typeof setup>>) {
  return { repositoryId: graph.repository.id, branch: graph.branch.name, documentId: documentId('secondary'),
    expectedRepositoryRevision: graph.repository.revision, expectedBranchRevision: graph.branch.revision,
    fileName: 'secondary.hwpx', sourceFormat: 'hwpx', forkName: branchName('draft') };
}

const code = (expected: string) => (error: unknown) => error instanceof VersionError && error.code === expected;

test('occupied workspace creation forks atomically and resolves both documents to the same graph', async () => {
  const ctx = await setup();
  await assert.rejects(ctx.store.createWorktree({ ...forkInput(ctx), forkName: undefined }), code('BRANCH_OCCUPIED'));
  assert.equal((await ctx.store.getRepository(ctx.graph.repository.id))!.revision, ctx.graph.repository.revision);
  const draft = await ctx.store.createWorktree(forkInput(ctx));
  assert.equal(draft.branch, 'draft');
  assert.notEqual(draft.branchGeneration, ctx.primary.branchGeneration);
  assert.deepEqual(draft.mergeTarget, { name: ctx.primary.branch, generation: ctx.primary.branchGeneration });
  assert.equal((await ctx.store.findRepositoryByDocumentId(draft.documentId))!.id, ctx.graph.repository.id);
  assert.equal((await ctx.store.listWorktrees(ctx.graph.repository.id)).length, 2);
  await assert.rejects(ctx.store.createWorktree(forkInput(ctx)), code('STALE_WORKSPACE'));
});

test('workspace snapshots and baselines remain independent and portable history omits working bytes', async () => {
  const ctx = await setup();
  const draft = await ctx.store.createWorktree(forkInput(ctx));
  const edited = new Uint8Array([9, 8]);
  const saved = await ctx.store.saveWorktree({ id: draft.id, expectedRevision: draft.revision, bytes: edited,
    savedFingerprint: fingerprintBytes(edited) });
  edited[0] = 0;
  assert.deepEqual((await ctx.store.getBlob(saved.blobId))!.bytes, new Uint8Array([9, 8]));
  assert.equal((await ctx.store.getWorktree(ctx.primary.id))!.savedFingerprint, ctx.primary.savedFingerprint);
  assert.equal((await ctx.store.getRepository(ctx.graph.repository.id))!.lastSavedFingerprint, ctx.primary.savedFingerprint);
  const snapshot = await ctx.store.exportRepositorySnapshot(ctx.graph.repository.id);
  assert.ok(!snapshot.blobs.some((blob) => blob.id === saved.blobId));
  assert.ok(!('worktrees' in snapshot));
  assert.equal((await ctx.store.saveWorktree({ id: saved.id, expectedRevision: saved.revision, bytes: new Uint8Array([9, 8]) })).revision, saved.revision);
  await assert.rejects(ctx.store.saveWorktree({ id: saved.id, expectedRevision: draft.revision, bytes: new Uint8Array([5]) }), code('STALE_WORKSPACE'));
  await assert.rejects(ctx.store.saveWorktree({ id: saved.id, expectedRevision: saved.revision, expectedDocumentId: ctx.primary.documentId }), code('STALE_WORKSPACE'));
});

test('checkpoint saves update only the bound workspace baseline and revision', async () => {
  const ctx = await setup();
  const draft = await ctx.store.createWorktree(forkInput(ctx));
  const repository = (await ctx.store.getRepository(ctx.graph.repository.id))!;
  const branch = (await ctx.store.getBranch(repository.id, draft.branch))!;
  const input = payload(3);
  const checkpoint = await ctx.store.createCheckpoint({ ...input, repositoryId: repository.id, branch: branch.name,
    expectedRepositoryRevision: repository.revision, expectedBranchRevision: branch.revision, expectedHead: branch.target,
    worktreeId: draft.id, expectedWorktreeRevision: draft.revision, reason: 'save', lastSavedFingerprint: input.contentFingerprint });
  const updated = (await ctx.store.getWorktree(draft.id))!;
  assert.equal(updated.baseCommitId, checkpoint.commit.id);
  assert.equal(updated.blobId, checkpoint.commit.blobId);
  assert.equal(updated.savedFingerprint, input.contentFingerprint);
  assert.equal(updated.revision, draft.revision + 1);
  assert.equal(checkpoint.repository.lastSavedFingerprint, ctx.primary.savedFingerprint);
});

test('renaming a branch updates dormant bindings and merge targets and protects occupied deletion', async () => {
  const ctx = await setup();
  const draft = await ctx.store.createWorktree(forkInput(ctx));
  let repository = (await ctx.store.getRepository(ctx.graph.repository.id))!;
  const renamed = await ctx.store.renameBranch({ repositoryId: repository.id, branch: ctx.primary.branch, name: branchName('renamed'),
    expectedRepositoryRevision: repository.revision, expectedBranchRevision: ctx.graph.branch.revision });
  assert.equal((await ctx.store.getWorktree(ctx.primary.id))!.branch, 'renamed');
  assert.equal((await ctx.store.getWorktree(draft.id))!.mergeTarget!.name, 'renamed');
  assert.equal((await ctx.store.getWorktree(draft.id))!.mergeTarget!.generation, ctx.primary.branchGeneration);
  repository = renamed.repository;
  const branch = (await ctx.store.getBranch(repository.id, draft.branch))!;
  await assert.rejects(ctx.store.deleteBranch({ repositoryId: repository.id, branch: draft.branch, currentBranch: renamed.branch.name,
    expectedRepositoryRevision: repository.revision, expectedBranchRevision: branch.revision }), code('BRANCH_OCCUPIED'));
  await assert.rejects(ctx.store.deleteWorktree({ id: ctx.primary.id, expectedRevision: (await ctx.store.getWorktree(ctx.primary.id))!.revision }), code('PRIMARY_WORKTREE'));
});

test('removing a workspace preserves its branch and committed content and rejects stale removal', async () => {
  const ctx = await setup();
  const draft = await ctx.store.createWorktree(forkInput(ctx));
  const updated = await ctx.store.saveWorktree({ id: draft.id, expectedRevision: draft.revision, bytes: new Uint8Array([7]) });
  await assert.rejects(ctx.store.deleteWorktree({ id: draft.id, expectedRevision: draft.revision }), code('STALE_WORKSPACE'));
  await ctx.store.deleteWorktree({ id: draft.id, expectedRevision: updated.revision });
  assert.equal(await ctx.store.getWorktree(draft.id), null);
  assert.ok(await ctx.store.getBranch(draft.repositoryId, draft.branch));
  assert.ok(await ctx.store.getCommit(draft.baseCommitId));
  assert.equal(await ctx.store.findRepositoryByDocumentId(draft.documentId), null);
});

test('switching a workspace enforces branch exclusivity even after a tab closes', async () => {
  const ctx = await setup();
  const draft = await ctx.store.createWorktree(forkInput(ctx));
  let repository = (await ctx.store.getRepository(ctx.graph.repository.id))!;
  await assert.rejects(ctx.store.switchWorktreeBranch({ id: draft.id, expectedRevision: draft.revision, branch: ctx.primary.branch,
    expectedRepositoryRevision: repository.revision, expectedBranchRevision: ctx.graph.branch.revision }), code('BRANCH_OCCUPIED'));
  const created = await ctx.store.createBranch({ repositoryId: repository.id, name: branchName('alternate'), target: draft.baseCommitId,
    expectedRepositoryRevision: repository.revision });
  repository = created.repository;
  const switched = await ctx.store.switchWorktreeBranch({ id: draft.id, expectedRevision: draft.revision, branch: created.branch.name,
    expectedRepositoryRevision: repository.revision, expectedBranchRevision: created.branch.revision });
  assert.equal(switched.branch, 'alternate');
  assert.deepEqual(switched.mergeTarget, draft.mergeTarget);
  assert.ok(await ctx.store.getBranch(repository.id, draft.branch));
});

test('concurrent binding creates have one winner and failed forks leave no branch', async () => {
  const ctx = await setup();
  const outcomes = await Promise.allSettled([
    ctx.store.createWorktree(forkInput(ctx)),
    ctx.store.createWorktree({ ...forkInput(ctx), documentId: documentId('other'), forkName: branchName('other') }),
  ]);
  assert.equal(outcomes.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal((await ctx.store.listWorktrees(ctx.graph.repository.id)).length, 2);
  assert.equal((await ctx.store.listRefs(ctx.graph.repository.id)).filter((ref) => ref.kind === 'branch').length, 2);
});

test('subscribers see committed worktree changes and failed writes emit nothing', async () => {
  const ctx = await setup();
  const events: string[] = [];
  const unsubscribe = ctx.store.subscribe((id) => events.push(id));
  try {
    const draft = await ctx.store.createWorktree(forkInput(ctx));
    assert.deepEqual(events, [ctx.graph.repository.id]);
    await assert.rejects(ctx.store.saveWorktree({ id: draft.id, expectedRevision: 0 }), code('STALE_WORKSPACE'));
    assert.equal(events.length, 1);
    await ctx.store.saveWorktree({ id: draft.id, expectedRevision: draft.revision, bytes: new Uint8Array([4]) });
    assert.equal(events.length, 2);
    assert.equal(hashBytes(new Uint8Array([4])), (await ctx.store.getWorktree(draft.id))!.blobId);
  } finally { unsubscribe(); }
});

test('invalid merge destination rolls back an occupied-branch fork', async () => {
  const ctx = await setup();
  await assert.rejects(ctx.store.createWorktree({ ...forkInput(ctx),
    mergeTarget: { name: branchName('missing'), generation: ctx.primary.branchGeneration } }), code('STALE_WORKSPACE'));
  assert.equal(await ctx.store.getBranch(ctx.graph.repository.id, branchName('draft')), null);
  assert.equal((await ctx.store.listWorktrees(ctx.graph.repository.id)).length, 1);
  assert.equal((await ctx.store.getRepository(ctx.graph.repository.id))!.revision, ctx.graph.repository.revision);
});

test('merging a worktree source cannot delete its occupied branch and rolls back the target head', async () => {
  const ctx = await setup();
  const draft = await ctx.store.createWorktree(forkInput(ctx));
  const repository = (await ctx.store.getRepository(ctx.graph.repository.id))!;
  const source = (await ctx.store.getBranch(repository.id, draft.branch))!;
  const checkpoint = await ctx.store.createCheckpoint({ ...payload(6), repositoryId: repository.id, branch: source.name,
    expectedRepositoryRevision: repository.revision, expectedBranchRevision: source.revision, reason: 'manual',
    worktreeId: draft.id, expectedWorktreeRevision: draft.revision });
  await assert.rejects(ctx.store.completeFastForwardMerge({ repositoryId: repository.id, branch: ctx.primary.branch,
    expectedRepositoryRevision: checkpoint.repository.revision, expectedBranchRevision: ctx.graph.branch.revision,
    expectedHead: ctx.graph.branch.target, sourceBranch: source.name, expectedSourceRevision: checkpoint.branch.revision,
    target: checkpoint.commit.id, deleteSource: true }), code('BRANCH_OCCUPIED'));
  assert.equal((await ctx.store.getBranch(repository.id, ctx.primary.branch))!.target, ctx.graph.branch.target);
  assert.equal((await ctx.store.getRepository(repository.id))!.revision, checkpoint.repository.revision);
  assert.ok(await ctx.store.getBranch(repository.id, source.name));
});

test('a detached workspace base remains a GC root after branch recovery expires', async () => {
  const ctx = await setup();
  const draft = await ctx.store.createWorktree(forkInput(ctx));
  const repository = (await ctx.store.getRepository(ctx.graph.repository.id))!;
  const source = (await ctx.store.getBranch(repository.id, draft.branch))!;
  const checkpoint = await ctx.store.createCheckpoint({ ...payload(6), repositoryId: repository.id, branch: source.name,
    expectedRepositoryRevision: repository.revision, expectedBranchRevision: source.revision, reason: 'manual',
    worktreeId: draft.id, expectedWorktreeRevision: draft.revision });
  const moved = await ctx.store.moveBranchGuarded({ repositoryId: repository.id, branch: source.name, target: ctx.graph.commit.id,
    expectedRepositoryRevision: checkpoint.repository.revision, expectedBranchRevision: checkpoint.branch.revision,
    expectedHead: checkpoint.commit.id });
  const now = Date.now;
  Date.now = () => now() + 31 * 24 * 60 * 60 * 1000;
  try {
    await ctx.store.collectGarbage(repository.id, moved.repository.revision);
    assert.ok(await ctx.store.getCommit(checkpoint.commit.id));
    assert.ok(await ctx.store.getBlob(checkpoint.commit.blobId));
    assert.equal((await ctx.store.getWorktree(draft.id))!.baseCommitId, checkpoint.commit.id);
  } finally { Date.now = now; }
});


test('active-branch portable export excludes other workspaces merge decisions and their private assets', async () => {
  const ctx = await setup();
  const draft = await ctx.store.createWorktree(forkInput(ctx));
  const assetBytes = new Uint8Array([11, 12]);
  const assetId = hashBytes(assetBytes);
  const stored = await ctx.store.putMergeDraft({ draft: {
    id: mergeDraftId('private-draft'), repositoryId: ctx.graph.repository.id,
    targetBranch: draft.branch, sourceBranch: ctx.primary.branch,
    baseCommitIds: [ctx.graph.commit.id], currentHead: draft.baseCommitId, sourceHead: ctx.graph.commit.id,
    targetBranchRevision: 1, sourceBranchRevision: ctx.graph.branch.revision,
    mode: 'diverged', analysisVersion: 1, conflicts: [], resolutions: {}, automaticResult: null,
    manualAssetBlobIds: [assetId], history: [], historyIndex: 0, createdAt: 1, updatedAt: 1,
  }, assetBlobs: [{ id: assetId, bytes: assetBytes, byteLength: assetBytes.byteLength }] });
  const primaryExport = await ctx.store.exportRepositorySnapshot(ctx.graph.repository.id, { activeBranch: ctx.primary.branch });
  assert.equal(primaryExport.mergeDrafts.length, 0);
  assert.ok(!primaryExport.blobs.some((row) => row.id === assetId));
  const draftExport = await ctx.store.exportRepositorySnapshot(ctx.graph.repository.id, { activeBranch: draft.branch });
  assert.deepEqual(draftExport.mergeDrafts.map((row) => row.id), [stored.id]);
  assert.ok(draftExport.blobs.some((row) => row.id === assetId));
  assert.ok(await ctx.store.getBlob(assetId));
});

test('binding-only changes preserve portable graph identity and allow reopening the same history', async () => {
  const ctx = await setup();
  const created = await ctx.store.createBranch({ repositoryId: ctx.graph.repository.id, name: branchName('unused'),
    target: ctx.graph.commit.id, expectedRepositoryRevision: ctx.graph.repository.revision });
  const before = await ctx.store.exportRepositorySnapshot(ctx.graph.repository.id);
  const attached = await ctx.store.createWorktree({ ...forkInput(ctx), forkName: undefined, branch: created.branch.name,
    expectedRepositoryRevision: created.repository.revision, expectedBranchRevision: created.branch.revision,
    mergeTarget: { name: ctx.primary.branch, generation: ctx.primary.branchGeneration } });
  assert.deepEqual(await ctx.store.exportRepositorySnapshot(ctx.graph.repository.id), before);
  assert.equal((await ctx.store.importRepositorySnapshot(before)).imported, false);
  await ctx.store.deleteWorktree({ id: attached.id, expectedRevision: attached.revision });
  assert.deepEqual(await ctx.store.exportRepositorySnapshot(ctx.graph.repository.id), before);
});
