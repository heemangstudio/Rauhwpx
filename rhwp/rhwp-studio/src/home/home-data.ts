/**
 * 문서 홈이 읽는 바깥 상태: 파일이 아직 있는지, 옮겨졌는지, 첫 쪽 그림, 작업 트리 색.
 * 모두 게으르게 한다. 목록을 먼저 그린 뒤 확인하고, 디스크 전체를 훑지 않는다.
 *
 * 목록에서 빼는 일은 확실한 증거가 거듭될 때만 한다. 한 번 못 찾으면 "찾을 수 없음"으로
 * 흐리게 두고, 시간이 지나 다시 확인해도 없을 때 뺀다. 미리보기를 못 그린 것은 증거가 아니다.
 */
import type { RecentDoc } from '../recent/recent-store.ts';
import { removeRecentDoc, updateRecentDoc } from '../recent/recent-store.ts';
import {
  inspectNativeDocuments,
  readRememberedNativeDocument,
  relocateNativeDocument,
  type NativeDocumentPresence,
} from '../desktop-integration.ts';
import type { VersionGraphStore } from '../versioning/store.ts';
import type { BranchRef, VersionWorktree } from '../versioning/types.ts';
import { branchColors } from '../versioning/branch-colors.ts';
import { laneColor } from '../ui/version-lanes.ts';
import type { HomeWorktreeInput } from './home-model.ts';
import { deleteThumbnail, readThumbnail, writeThumbnail } from './thumbnail-cache.ts';
import { renderThumbnailFromBytes, THUMBNAIL_SOURCE_MAX_BYTES } from './thumbnail-render.ts';

/** 못 찾은 파일을 목록에서 빼기 전에 기다리는 시간. 저장 중 교체·잠깐 꺼낸 디스크를 넘긴다. */
export const MISSING_CONFIRM_MS = 10 * 60 * 1000;

/** 목록의 한 문서가 지금 디스크에 어떻게 있는지. stamp 는 미리보기를 다시 그릴지 가린다. */
export type DocumentPresence =
  | { state: 'present'; fileName: string; stamp: string; source: 'desktop' | 'handle' }
  | { state: 'missing'; source: 'desktop' | 'handle' }
  | { state: 'unavailable' | 'unknown' };

/** 브라우저 파일 핸들은 이미 읽기 권한이 있을 때만 확인한다. 권한 창을 띄우지 않는다. */
async function inspectHandle(row: RecentDoc): Promise<{ presence: DocumentPresence; file?: File }> {
  const handle = row.handle;
  if (!handle || handle.identityKind === 'native-path' || typeof handle.queryPermission !== 'function') {
    return { presence: { state: 'unknown' } };
  }
  try {
    if (await handle.queryPermission({ mode: 'read' }) !== 'granted') return { presence: { state: 'unknown' } };
    const file = await handle.getFile();
    return {
      presence: { state: 'present', fileName: file.name, stamp: `${file.size}:${file.lastModified}`, source: 'handle' },
      file,
    };
  } catch (error) {
    // 파일을 읽지 못하는 것(잠김·꺼낸 디스크)은 없어진 것과 다르다. NotFoundError 만 없음으로 본다.
    const missing = error instanceof DOMException && error.name === 'NotFoundError';
    return { presence: missing ? { state: 'missing', source: 'handle' } : { state: 'unknown' } };
  }
}

function fromNative(presence: NativeDocumentPresence | undefined): DocumentPresence | null {
  if (!presence) return null;
  if (presence.state === 'present') {
    return { state: 'present', fileName: presence.fileName, stamp: `${presence.size}:${presence.modifiedAt}`, source: 'desktop' };
  }
  if (presence.state === 'missing') return { state: 'missing', source: 'desktop' };
  return presence.state === 'unavailable' ? { state: 'unavailable' } : null;
}

/** 목록 전체의 상태를 본다. 데스크톱은 메인이 경로를 stat 만 하고, 브라우저는 허락된 핸들만 연다. */
export async function inspectRecentDocuments(rows: readonly RecentDoc[]): Promise<Map<string, DocumentPresence>> {
  const native = await inspectNativeDocuments(rows.map((row) => row.documentId));
  const result = new Map<string, DocumentPresence>();
  await Promise.all(rows.map(async (row) => {
    result.set(row.id, fromNative(native?.get(row.documentId)) ?? (await inspectHandle(row)).presence);
  }));
  return result;
}

export interface HealIo {
  /** 옮겨진 파일을 찾아 새 위치를 기억시킨다(데스크톱 메인이 내용으로 맞춘다). 찾았으면 새 이름. */
  relocate(row: RecentDoc): Promise<string | null>;
  forget(row: RecentDoc): Promise<void>;
  update(row: RecentDoc, patch: { fileName?: string; missingSince?: number | null }): Promise<void>;
}

export interface HealResult {
  removed: Set<string>;
  renamed: Map<string, string>;
  /** 이번에 못 찾았지만 아직 빼지 않은 기록. 화면은 흐리게 둔다. */
  stale: Set<string>;
}

const emptyHeal = (): HealResult => ({ removed: new Set(), renamed: new Map(), stale: new Set() });

/**
 * 확인 결과로 목록을 고친다. 옮겨지거나 이름이 바뀐 파일은 새 이름으로 남긴다. 없어진 파일은
 * 처음 못 찾은 시각을 남기고, {@link MISSING_CONFIRM_MS} 뒤에도 없을 때만 뺀다. 닿지 않는
 * 위치(꺼낸 디스크)와 확인할 수 없는 기록은 그대로 둔다.
 */
export async function healRecentDocuments(
  rows: readonly RecentDoc[],
  presence: ReadonlyMap<string, DocumentPresence>,
  io: HealIo,
  now = Date.now(),
): Promise<HealResult> {
  const result = emptyHeal();
  for (const row of rows) {
    const state = presence.get(row.id);
    if (!state) continue;
    try {
      if (state.state === 'present') {
        const renamed = state.fileName !== row.fileName;
        if (renamed || row.missingSince !== undefined) {
          await io.update(row, { ...(renamed ? { fileName: state.fileName } : {}), missingSince: null });
        }
        if (renamed) result.renamed.set(row.id, state.fileName);
      } else if (state.state === 'missing') {
        const moved = state.source === 'desktop' ? await io.relocate(row) : null;
        if (moved) {
          await io.update(row, { fileName: moved, missingSince: null });
          result.renamed.set(row.id, moved);
        } else if (row.missingSince !== undefined && now - row.missingSince >= MISSING_CONFIRM_MS) {
          await io.forget(row);
          result.removed.add(row.id);
        } else {
          if (row.missingSince === undefined) await io.update(row, { missingSince: now });
          result.stale.add(row.id);
        }
      }
    } catch (error) {
      console.warn('[document-home] 목록 정리 실패:', error);
    }
  }
  return result;
}

/** 열기에 두 번 실패한 기록만 목록에서 뺀다. 한 번은 잠깐의 문제일 수 있다. */
export const OPEN_FAILURES_BEFORE_FORGET = 2;

/**
 * 카드를 열지 못했을 때 할 일. 파일이 없으면 홈의 확인과 같은 규칙(처음 못 찾은 뒤 시간이 지나도
 * 없을 때만 뺀다)을 따르고, 읽지 못한 파일은 두 번 실패하면 뺀다.
 */
export function judgeOpenFailure(
  row: Pick<RecentDoc, 'missingSince'>,
  result: 'missing' | 'failed',
  failures: number,
  now = Date.now(),
): { forget: boolean; missingSince?: number } {
  if (result === 'failed') return { forget: failures >= OPEN_FAILURES_BEFORE_FORGET };
  if (row.missingSince !== undefined && now - row.missingSince >= MISSING_CONFIRM_MS) return { forget: true };
  return { forget: false, missingSince: row.missingSince ?? now };
}

export const thumbnailKey = (documentId: string) => `document:${documentId}`;

export const defaultHealIo: HealIo = {
  relocate: (row) => relocateNativeDocument(row.documentId).catch(() => null),
  forget: async (row) => {
    await removeRecentDoc(row.id);
    await deleteThumbnail(thumbnailKey(row.documentId)).catch(() => {});
  },
  update: async (row, patch) => { await updateRecentDoc(row.id, patch); },
};

let healing: Promise<unknown> = Promise.resolve();

/**
 * 확인과 정리를 한 번에 하나만 돌린다. 홈을 연달아 열어도 다음 정리는 앞 정리가 끝난 뒤에
 * 시작한다 — 두 정리가 같은 파일을 두고 엇갈려 지우는 일이 없다.
 */
export function inspectAndHeal(
  rows: readonly RecentDoc[],
  io: HealIo = defaultHealIo,
  inspect: (rows: readonly RecentDoc[]) => Promise<Map<string, DocumentPresence>> = inspectRecentDocuments,
): Promise<{ presence: Map<string, DocumentPresence>; healed: HealResult }> {
  const run = healing.then(async () => {
    const presence = await inspect(rows).catch(() => new Map<string, DocumentPresence>());
    const healed = await healRecentDocuments(rows, presence, io);
    return { presence, healed };
  });
  healing = run.catch(() => {});
  return run;
}

const canRenderThumbnail = (fileName: string) => /\.(hwpx?|hml)$/i.test(fileName);

/**
 * 닫힌 문서의 첫 쪽 그림. 저장한 그림의 stamp 가 파일과 같으면 그대로 쓰고, 다르면 파일을 읽어
 * 다시 그린다. 파일에 닿을 수 없거나 그리지 못하면 마지막으로 그린 그림(없으면 null)을 쓴다.
 */
export async function documentThumbnail(row: RecentDoc, presence: DocumentPresence | undefined): Promise<Blob | null> {
  const key = thumbnailKey(row.documentId);
  const cached = await readThumbnail(key).catch(() => null);
  if (presence?.state !== 'present') return cached?.blob ?? null;
  if (cached?.stamp === presence.stamp) return cached.blob;
  if (!canRenderThumbnail(presence.fileName)) return cached?.blob ?? null;

  let bytes: Uint8Array | null = null;
  try {
    if (presence.source === 'desktop') {
      bytes = (await readRememberedNativeDocument(row.documentId))?.bytes ?? null;
    } else {
      const { file } = await inspectHandle(row);
      if (file && file.size <= THUMBNAIL_SOURCE_MAX_BYTES) bytes = new Uint8Array(await file.arrayBuffer());
    }
  } catch {
    bytes = null;
  }
  if (!bytes) return cached?.blob ?? null;
  const blob = await renderThumbnailFromBytes(bytes).catch(() => null);
  if (blob) await writeThumbnail(key, presence.stamp, blob).catch(() => {});
  return blob ?? cached?.blob ?? null;
}

/** 열린 문서에서 바로 그린 그림을 저장한다. 파일 stamp 와 다르게 두어 닫은 뒤에는 파일로 다시 그린다. */
export async function rememberLiveThumbnail(documentId: string, blob: Blob): Promise<void> {
  await writeThumbnail(thumbnailKey(documentId), `live:${Date.now()}`, blob).catch(() => {});
}

/** 템플릿 그림. 개정 번호가 같으면 다시 받지 않는다. */
export async function templateThumbnail(
  template: { id: string; revision: number; contentHash: string; size?: number },
  fetchBytes: () => Promise<Uint8Array>,
): Promise<Blob | null> {
  const key = `template:${template.id}`;
  const stamp = `${template.revision}:${template.contentHash}`;
  const cached = await readThumbnail(key).catch(() => null);
  if (cached?.stamp === stamp) return cached.blob;
  if ((template.size ?? 0) > THUMBNAIL_SOURCE_MAX_BYTES) return cached?.blob ?? null;
  try {
    const blob = await renderThumbnailFromBytes(await fetchBytes());
    if (blob) await writeThumbnail(key, stamp, blob).catch(() => {});
    return blob ?? cached?.blob ?? null;
  } catch {
    return cached?.blob ?? null;
  }
}

export interface WorktreeData {
  trees: HomeWorktreeInput[];
  colorOf(repositoryId: string, branch: string): string;
}

/**
 * 모든 작업 트리와 가지 색. 색은 버전 그래프와 같은 규칙(가지 끝 커밋의 줄)으로 매기며,
 * 작업 트리가 둘 이상인 문서만 커밋 첫 쪽을 읽는다.
 */
export async function loadWorktreeData(store: VersionGraphStore): Promise<WorktreeData> {
  const trees: VersionWorktree[] = await store.listAllWorktrees();
  const byRepository = new Map<string, VersionWorktree[]>();
  for (const tree of trees) {
    const list = byRepository.get(tree.repositoryId) ?? [];
    list.push(tree);
    byRepository.set(tree.repositoryId, list);
  }
  const colors = new Map<string, Map<string, string>>();
  await Promise.all([...byRepository].filter(([, list]) => list.length > 1).map(async ([repositoryId, list]) => {
    try {
      const id = list[0]!.repositoryId;
      const [repository, refs, commits] = await Promise.all([
        store.getRepository(id),
        store.listRefs(id),
        store.listCommits(id, { limit: 100 }),
      ]);
      const branches = refs.filter((ref): ref is BranchRef => ref.kind === 'branch');
      // 버전 그래프와 같은 규칙으로 색을 매긴다(가지에서 나온 색, 활성 가지와 무관).
      const painted = branchColors(
        [...commits].sort((a, b) => b.ordinal - a.ordinal).map((commit) => ({ id: commit.id, parentIds: commit.parents })),
        branches.map((branch) => ({ name: branch.name, headId: branch.target, isDefault: branch.name === repository?.defaultBranch })),
      );
      colors.set(repositoryId, new Map(branches.map((branch) => [branch.name, painted.branch(branch.name)])));
    } catch (error) {
      console.warn('[document-home] 가지 색을 읽지 못했습니다:', error);
    }
  }));
  return {
    trees: trees.map((tree) => ({
      id: tree.id,
      documentId: tree.documentId,
      repositoryId: tree.repositoryId,
      branch: tree.branch,
      primary: tree.primary,
      fileName: tree.fileName,
      createdAt: tree.createdAt,
      updatedAt: tree.updatedAt,
    })),
    colorOf: (repositoryId, branch) => colors.get(repositoryId)?.get(branch) ?? laneColor(0),
  };
}
