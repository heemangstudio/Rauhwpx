/**
 * 문서 홈의 목록 규칙. 최근 문서 기록과 작업 트리를 카드 목록으로 바꾸고 정렬한다.
 * 화면·저장소를 모르는 순수 함수만 둔다.
 */

export interface HomeRecentInput {
  readonly id: string;
  readonly documentId: string;
  readonly fileName: string;
  readonly sourceFormat: string;
  readonly openedAt: number;
}

export interface HomeWorktreeInput {
  readonly id: string;
  readonly documentId: string;
  readonly repositoryId: string;
  readonly branch: string;
  readonly primary: boolean;
  readonly fileName: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface HomeWorktree extends HomeWorktreeInput {
  /** 버전 그래프에서 그 가지가 쓰는 줄 색 */
  readonly color: string;
}

export interface HomeDocument {
  readonly recentId: string;
  readonly documentId: string;
  readonly fileName: string;
  readonly sourceFormat: string;
  readonly openedAt: number;
  /** 이 문서가 작업 트리 묶음의 한 칸이면 그 가지. 묶음이 없으면 null. */
  readonly branch: HomeWorktree | null;
  /** 원본 문서 아래에 묶인 사본들. 원본이 아니거나 사본이 없으면 비어 있다. */
  readonly worktrees: readonly HomeWorktree[];
}

export type HomeSort = 'recent' | 'name';

/**
 * 최근 문서를 카드로 묶는다. 같은 저장소의 작업 트리가 둘 이상이면 사본은 원본 카드 아래로
 * 들어간다. 원본이 목록에 없을 때만 사본이 제 카드로 남는다.
 */
export function groupHomeDocuments(
  recents: readonly HomeRecentInput[],
  worktrees: readonly HomeWorktreeInput[],
  colorOf: (repositoryId: string, branch: string) => string,
): HomeDocument[] {
  const byRepository = new Map<string, HomeWorktreeInput[]>();
  for (const tree of worktrees) {
    const list = byRepository.get(tree.repositoryId) ?? [];
    list.push(tree);
    byRepository.set(tree.repositoryId, list);
  }
  const grouped = new Map<string, HomeWorktree>();
  const copiesOf = new Map<string, HomeWorktree[]>();
  for (const [repositoryId, trees] of byRepository) {
    if (trees.length < 2) continue;
    const ordered = [...trees].sort((a, b) => (
      Number(b.primary) - Number(a.primary) || a.createdAt - b.createdAt || a.id.localeCompare(b.id)
    ));
    const painted = ordered.map((tree) => ({ ...tree, color: colorOf(repositoryId, tree.branch) }));
    for (const tree of painted) grouped.set(tree.documentId, tree);
    copiesOf.set(repositoryId, painted.filter((tree) => !tree.primary));
  }

  const listed = new Set(recents.map((row) => row.documentId));
  const seen = new Set<string>();
  const documents: HomeDocument[] = [];
  for (const row of recents) {
    if (seen.has(row.documentId)) continue;
    seen.add(row.documentId);
    const tree = grouped.get(row.documentId) ?? null;
    if (tree && !tree.primary) {
      const primary = byRepository.get(tree.repositoryId)?.find((entry) => entry.primary);
      if (primary && listed.has(primary.documentId)) continue;
    }
    documents.push({
      recentId: row.id,
      documentId: row.documentId,
      fileName: row.fileName,
      sourceFormat: row.sourceFormat,
      openedAt: row.openedAt,
      branch: tree,
      worktrees: tree?.primary ? copiesOf.get(tree.repositoryId) ?? [] : [],
    });
  }
  return documents;
}

const nameCollator = new Intl.Collator('ko', { numeric: true, sensitivity: 'base' });

export function sortHomeDocuments(documents: readonly HomeDocument[], sort: HomeSort): HomeDocument[] {
  const byRecent = (a: HomeDocument, b: HomeDocument) => b.openedAt - a.openedAt;
  return [...documents].sort(sort === 'name'
    ? (a, b) => nameCollator.compare(a.fileName, b.fileName) || byRecent(a, b)
    : byRecent);
}

/** 화면에 쓰는 이름. 확장자는 형식 표시가 따로 보여 준다. */
export function displayName(fileName: string): string {
  const trimmed = fileName.replace(/\.(hwpx?|hml|rhwpx)$/i, '');
  return trimmed || fileName;
}

/** 열람 날짜. 오늘은 시각, 올해는 월·일, 그 밖은 연도까지. */
export function openedLabel(openedAt: number, now = Date.now()): string {
  const opened = new Date(openedAt);
  const today = new Date(now);
  if (opened.toDateString() === today.toDateString()) {
    return `${String(opened.getHours()).padStart(2, '0')}:${String(opened.getMinutes()).padStart(2, '0')}`;
  }
  if (opened.getFullYear() === today.getFullYear()) {
    return `${opened.getMonth() + 1}월 ${opened.getDate()}일`;
  }
  return `${opened.getFullYear()}. ${opened.getMonth() + 1}. ${opened.getDate()}.`;
}
