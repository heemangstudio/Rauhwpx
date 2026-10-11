/**
 * 가지 색. 버전 그래프·작업 트리 표시·문서 홈이 모두 이 규칙 하나로 색을 정한다.
 *
 * 색은 그래프의 줄 번호가 아니라 가지에서 나온다. 기본 가지가 첫 색이고, 나머지 가지는 처음
 * 갈라져 나온 순서(그 가지만의 가장 오래된 커밋)대로 다음 색을 받는다. 그래서 활성 가지가 바뀌거나
 * 줄이 다시 쓰여도 같은 가지는 같은 색이고, 같은 곳에서 갈라진 형제 가지끼리는 색이 다르다.
 * 커밋은 첫 부모를 따라 그 커밋에 먼저 닿는 가지의 색이다. 가지가 하나뿐이면 모두 첫 색이다.
 */
import { laneColor } from '../ui/version-lanes.ts';

export interface ColorCommit {
  readonly id: string;
  readonly parentIds: readonly string[];
}

export interface ColorBranch {
  readonly name: string;
  readonly headId: string;
  readonly isDefault: boolean;
}

export interface BranchColors {
  branch(name: string): string;
  commit(id: string): string;
}

/** commits 는 새것부터(그래프 순서). 목록에 없는 커밋은 첫 색이다. */
export function branchColors(commits: readonly ColorCommit[], branches: readonly ColorBranch[]): BranchColors {
  const position = new Map(commits.map((commit, index) => [commit.id, index]));
  const byId = new Map(commits.map((commit) => [commit.id, commit]));
  const owner = new Map<string, string>();

  /** 가지 끝에서 첫 부모를 따라 아직 주인이 없는 커밋들. */
  const chain = (headId: string): string[] => {
    const ids: string[] = [];
    const seen = new Set<string>();
    let id: string | undefined = headId;
    while (id && byId.has(id) && !owner.has(id) && !seen.has(id)) {
      seen.add(id);
      ids.push(id);
      id = byId.get(id)!.parentIds[0];
    }
    return ids;
  };
  const claim = (branch: ColorBranch) => { for (const id of chain(branch.headId)) owner.set(id, branch.name); };

  const ordered: string[] = [];
  for (const branch of branches.filter((entry) => entry.isDefault)) {
    claim(branch);
    ordered.push(branch.name);
  }
  // 그 가지만의 가장 오래된 커밋이 오래된 가지일수록 먼저 갈라졌다. 자기 커밋이 없는 가지는 뒤로.
  const oldest = (branch: ColorBranch) => Math.max(-1, ...chain(branch.headId).map((id) => position.get(id) ?? -1));
  const rest = branches.filter((entry) => !entry.isDefault)
    .map((branch) => ({ branch, age: oldest(branch) }))
    .sort((a, b) => b.age - a.age || a.branch.name.localeCompare(b.branch.name));
  for (const { branch } of rest) {
    claim(branch);
    ordered.push(branch.name);
  }

  const index = new Map(ordered.map((name, order) => [name, order]));
  const colorOfBranch = (name: string | undefined) => laneColor((name !== undefined ? index.get(name) : undefined) ?? 0);
  return {
    branch: (name) => colorOfBranch(name),
    commit: (id) => colorOfBranch(owner.get(id)),
  };
}
