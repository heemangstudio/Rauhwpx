import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// 남은 소스 가드: 셸프 적용과 다른 창의 브랜치 변경 경합은 병합 창·여러 컨트롤러를 함께
// 띄워야 재현된다. 다른 데이터 손실 계약은 version-data-loss.browser.test.ts 가 실제
// 컨트롤러로 검증한다.
const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const controller = readFileSync(join(rootDir, 'src/versioning/controller.ts'), 'utf8');

function method(start: string, end: string): string {
  const from = controller.indexOf(start);
  const to = controller.indexOf(end, from + start.length);
  assert.notEqual(from, -1, `${start} must exist`);
  assert.notEqual(to, -1, `${end} must exist after ${start}`);
  return controller.slice(from, to);
}

test('shelves use HEAD divergence and protect current work before applying', () => {
  const create = method('async createShelf(', 'async applyShelf(');
  assert.match(create, /capture\.fingerprint === head\.contentFingerprint/);
  assert.doesNotMatch(create, /documentState\.isDirty\(\)/);
  assert.match(create, /deleteShelf\(/);

  const apply = method('async applyShelf(', 'async deleteShelf(');
  assert.ok(apply.indexOf('#prepareMergeWorkingTree()') < apply.indexOf('#openMergeResolver('));
  assert.match(apply, /target: existing\?\.id \?\? shelf\.baseCommitId/);
  assert.doesNotMatch(apply, /replaceContentFromBytes/);
});

test('branch switching revalidates cross-controller repository and ref advances before content replacement', () => {
  const switchBranch = method('async switchBranch(name: string)', 'async renameBranch(');
  const validation = switchBranch.indexOf('const [freshRepository, freshNext, freshPrevious]');
  const replacement = switchBranch.indexOf('#applyBranchContent(');
  assert.ok(validation > switchBranch.indexOf('getBlob(target.blobId)'));
  assert.ok(validation < replacement);
  assert.match(switchBranch, /freshRepository\.revision !== repository\.revision/);
  assert.match(switchBranch, /freshNext\.revision !== next\.revision/);
  assert.match(switchBranch, /freshNext\.target !== next\.target/);
  assert.match(switchBranch, /freshPrevious\.revision !== previous\.revision/);
  assert.match(switchBranch, /new VersionError\('STALE_WORKSPACE'/);
});
