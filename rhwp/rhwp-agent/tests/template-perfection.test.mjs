import assert from 'node:assert/strict';
import test from 'node:test';

import {
  COPY_LAYOUT_MAX_ITERATIONS,
  COPY_LAYOUT_PHASES,
  buildCopyLayoutCompletionPrompt,
  buildCopyLayoutWorkerPrompt,
  claimCopyLayoutPublication,
  claimCopyLayoutSettlement,
  claimCopyLayoutSnapshot,
  defaultTemplateName,
  releaseCopyLayoutPublication,
  releaseCopyLayoutSnapshot,
  taskProgressForJob,
} from '../template-perfection.mjs';

const binding = {
  documentId: 'document-exact',
  digest: 'sha256-exact',
  documentName: '신청서.hwp',
  sourceFormat: 'hwp',
  dirty: true,
  sourcePath: null,
};

test('fleet progress reports one task row with a direct phase index', () => {
  assert.deepEqual(
    COPY_LAYOUT_PHASES.map(({ title }) => title),
    ['원본', '전체 검사', '정리', '생성', '비교', '검증', '게시'],
  );
  const progress = taskProgressForJob({
    jobId: 'job-1',
    agent: 'codex',
    model: 'gpt-5.6-sol',
    phase: 'previewing',
    status: 'running',
    activity: '대표 페이지 비교 중',
    usage: { totalTokens: 123, toolUses: 7 },
  });
  assert.equal(progress.type, 'task-progress');
  assert.equal(progress.taskId, 'job-1');
  assert.equal(progress.phases.length, COPY_LAYOUT_PHASES.length);
  assert.equal(progress.phaseIndex, 4);
  assert.equal(progress.members, undefined, 'a single worker must not render as its own child row');
  assert.deepEqual(progress.usage, { totalTokens: 123, toolUses: 7 });
});

test('default registration name strips format and generated collision suffixes', () => {
  assert.equal(defaultTemplateName('신청서 - Layout (3).hwpx'), '신청서');
  assert.equal(defaultTemplateName('보고서.hwp'), '보고서');
});

test('copy-layout snapshot, publication, and settlement claims are one-shot before awaits', () => {
  const candidate = { iteration: 1, outputPath: '/private/candidate.hwpx' };
  const job = {
    status: 'running',
    snapshot: null,
    snapshotPending: false,
    helperPending: 0,
    publishPending: false,
    generatedCandidates: new Map([[1, candidate]]),
    publishedArtifacts: new Map(),
  };

  assert.deepEqual(claimCopyLayoutSnapshot(job), { bound: null, claimed: true });
  assert.throws(() => claimCopyLayoutSnapshot(job), (error) => (
    error.code === 'COPY_LAYOUT_SNAPSHOT_ACTIVE'
  ));
  releaseCopyLayoutSnapshot(job);
  job.snapshot = Object.freeze({ path: '/private/snapshot.hwpx' });
  assert.deepEqual(claimCopyLayoutSnapshot(job), { bound: job.snapshot, claimed: false });

  assert.equal(claimCopyLayoutPublication(job, candidate), candidate);
  assert.throws(() => claimCopyLayoutPublication(job, candidate), (error) => (
    error.code === 'COPY_LAYOUT_ARTIFACT_ALREADY_PUBLISHED'
  ));
  releaseCopyLayoutPublication(job, candidate);
  assert.equal(job.publishPending, false);

  claimCopyLayoutSettlement(job);
  assert.equal(job.status, 'settling');
  assert.throws(() => claimCopyLayoutSettlement(job), (error) => (
    error.code === 'COPY_LAYOUT_JOB_SETTLED'
  ));
});
