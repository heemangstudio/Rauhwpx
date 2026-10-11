import test from 'node:test';
import assert from 'node:assert/strict';

import { branchColors } from '../src/versioning/branch-colors.ts';
import { VERSION_LANE_COLORS } from '../src/ui/version-lanes.ts';

const [BLUE, SECOND, THIRD] = VERSION_LANE_COLORS;

test('가지가 하나뿐이면 모든 커밋이 첫 색이다', () => {
  const colors = branchColors(
    [{ id: 'c3', parentIds: ['c2'] }, { id: 'c2', parentIds: ['c1'] }, { id: 'c1', parentIds: [] }],
    [{ name: 'main', headId: 'c3', isDefault: true }],
  );
  assert.deepEqual(['c1', 'c2', 'c3'].map(colors.commit), [BLUE, BLUE, BLUE]);
  assert.equal(colors.branch('main'), BLUE);
});

test('같은 곳에서 갈라진 형제 가지는 서로 다른 색이고, 먼저 갈라진 가지가 앞 색이다', () => {
  // main 의 c1 에서 검토본(a1, 먼저)과 요약판(b1, 나중)이 하나씩 커밋했다. 새것부터 늘어놓는다.
  const commits = [
    { id: 'b1', parentIds: ['c1'] },
    { id: 'a1', parentIds: ['c1'] },
    { id: 'c1', parentIds: [] },
  ];
  const branches = [
    { name: '요약판', headId: 'b1', isDefault: false },
    { name: '검토본', headId: 'a1', isDefault: false },
    { name: 'main', headId: 'c1', isDefault: true },
  ];
  const colors = branchColors(commits, branches);
  assert.equal(colors.branch('main'), BLUE);
  assert.equal(colors.branch('검토본'), SECOND);
  assert.equal(colors.branch('요약판'), THIRD);
  assert.equal(colors.commit('a1'), SECOND);
  assert.equal(colors.commit('b1'), THIRD);
  assert.equal(colors.commit('c1'), BLUE, '갈라진 곳은 기본 가지의 것이다');
  // 가지를 늘어놓은 순서(활성 가지·이름)가 바뀌어도 색은 그대로다.
  const shuffled = branchColors(commits, [...branches].reverse());
  assert.deepEqual(['main', '검토본', '요약판'].map(shuffled.branch), [BLUE, SECOND, THIRD]);
});
