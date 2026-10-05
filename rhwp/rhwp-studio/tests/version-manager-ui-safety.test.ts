import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const readSource = (relativePath: string) => readFileSync(
  new URL(relativePath, import.meta.url),
  'utf8',
).replace(/\r\n/g, '\n');

const source = readSource('../src/ui/agent-sidebar/version-manager.ts');
const css = readSource('../src/ui/agent-sidebar/versions.css');

test('수동 커밋은 같은 내용일 때 태그 또는 변경 없음 경로를 사용한다', () => {
  const controller = readSource('../src/versioning/controller.ts');
  assert.match(controller, /#createCheckpoint\(\{ reason: 'manual', message \}\)/);
  assert.doesNotMatch(controller, /reason: 'manual', message, allowSameContent: true/);
});

test('전체 화면 뒤 버전 페이지를 여는 지연 타이머는 완료와 해제 때 정리된다', () => {
  const sidebar = readSource('../src/ui/agent-sidebar/index.ts');
  assert.match(sidebar, /let deferredVersionsOpenTimer: number \| null = null/);
  assert.match(sidebar, /deferredVersionsOpenTimer = window\.setTimeout\(\(\) => \{\s*deferredVersionsOpenTimer = null;/);
  assert.match(sidebar, /if \(deferredVersionsOpenTimer !== null\) \{\s*window\.clearTimeout\(deferredVersionsOpenTimer\);\s*deferredVersionsOpenTimer = null;/);
});

test('컨트롤러는 저장소 기본 브랜치와 정렬된 고유 head로 그래프를 고정한다', () => {
  const controller = readSource('../src/versioning/controller.ts');
  assert.match(controller, /orderBranchHeadFrontier\(\s*branchRefs,\s*this\.#repository\?\.defaultBranch \?\? null,\s*this\.#activeBranch/);
  assert.match(controller, /\.filter\(\(id\) => loadedCommitIds\.has\(id\)\)/);
  assert.match(controller, /layoutCommitGraph\(this\.#commits, \[\], preferredHeads\)/);
  assert.match(controller, /isDefault: branch\.name === this\.#repository\?\.defaultBranch/);
  assert.doesNotMatch(controller, /isDefault: branch\.name === 'main'/);
});
