/**
 * 문서 홈이 읽는 바깥 상태: 파일이 아직 있는지, 옮겨졌는지, 첫 쪽 그림, 작업 트리 색.
 * 모두 게으르게 한다. 목록을 먼저 그린 뒤 보이는 항목만 확인하고, 디스크 전체를 훑지 않는다.
 */
import type { RecentDoc } from '../recent/recent-store.ts';
import { removeRecentDoc, updateRecentDoc } from '../recent/recent-store.ts';
import { documentSourceDigest } from '../recent/document-preflight.ts';
import {
  inspectNativeDocuments,
  readNativeProbe,
  readRememberedNativeDocument,
  relocateNativeDocument,
  searchNearbyNativeDocuments,
  type NativeDocumentPresence,
} from '../desktop-integration.ts';
import type { VersionGraphStore } from '../versioning/store.ts';
import type { BranchRef, VersionWorktree } from '../versioning/types.ts';
import { layoutCommitGraph, orderBranchHeadFrontier } from '../versioning/graph-layout.ts';
import { laneColor } from '../ui/version-lanes.ts';
import type { HomeWorktreeInput } from './home-model.ts';
import { deleteThumbnail, readThumbnail, writeThumbnail } from './thumbnail-cache.ts';
import { renderThumbnailFromBytes, THUMBNAIL_SOURCE_MAX_BYTES, ThumbnailParseError } from './thumbnail-render.ts';

/** 목록의 한 문서가 지금 디스크에 어떻게 있는지. stamp 는 미리보기를 다시 그릴지 가린다. */
export type DocumentPresence =
  | { state: 'present'; fileName: string; stamp: string; source: 'desktop' | 'handle' }
  | { state: 'missing'; source: 'desktop' | 'handle' }
  | { state: 'unavailable' | 'unknown' };

const isHandleMissing = (error: unknown) => error instanceof DOMException
  && (error.name === 'NotFoundError' || error.name === 'NotReadableError');

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
    return { presence: isHandleMissing(error) ? { state: 'missing', source: 'handle' } : { state: 'unknown' } };
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

/** 목록 전체의 상태를 한 번에 본다. 데스크톱은 경로를 stat 만 하고, 브라우저는 허락된 핸들만 연다. */
export async function inspectRecentDocuments(rows: readonly RecentDoc[]): Promise<Map<string, DocumentPresence>> {
  const native = await inspectNativeDocuments(rows.map((row) => row.documentId));
  const result = new Map<string, DocumentPresence>();
  await Promise.all(rows.map(async (row) => {
    result.set(row.id, fromNative(native?.get(row.documentId)) ?? (await inspectHandle(row)).presence);
  }));
  return result;
}

export interface HealIo {
  /** 옮겨진 파일을 찾아 새 위치를 기억시킨다. 찾았으면 새 파일 이름. */
  relocate(row: RecentDoc): Promise<string | null>;
  forget(row: RecentDoc): Promise<void>;
  rename(row: RecentDoc, fileName: string): Promise<void>;
}

export interface HealResult {
  removed: Set<string>;
  renamed: Map<string, string>;
}

/**
 * 확인 결과로 목록을 고친다. 지워진 파일은 빼고, 옮겨지거나 이름이 바뀐 파일은 새 이름으로
 * 남긴다. 닿지 않는 위치(꺼낸 디스크)와 확인할 수 없는 기록은 그대로 둔다.
 */
export async function healRecentDocuments(
  rows: readonly RecentDoc[],
  presence: ReadonlyMap<string, DocumentPresence>,
  io: HealIo,
): Promise<HealResult> {
  const result: HealResult = { removed: new Set(), renamed: new Map() };
  for (const row of rows) {
    const state = presence.get(row.id);
    if (!state) continue;
    try {
      if (state.state === 'present' && state.fileName !== row.fileName) {
        await io.rename(row, state.fileName);
        result.renamed.set(row.id, state.fileName);
      } else if (state.state === 'missing') {
        // 옮겨진 곳 찾기는 데스크톱만 할 수 있다. 하나씩 차례로 찾는다.
        const moved = state.source === 'desktop' ? await io.relocate(row) : null;
        if (moved) {
          if (moved !== row.fileName) await io.rename(row, moved);
          result.renamed.set(row.id, moved);
        } else {
          await io.forget(row);
          result.removed.add(row.id);
        }
      }
    } catch (error) {
      console.warn('[document-home] 목록 정리 실패:', error);
    }
  }
  return result;
}

export interface RelocateIo {
  search(documentId: string, basenameHint: string): Promise<readonly { probeId: string; fileName: string }[] | null>;
  read(probeId: string): Promise<Uint8Array | null>;
  digest(bytes: Uint8Array): string;
  relocate(documentId: string, probeId: string): Promise<string | null>;
}

/** 근처 폴더의 후보 중 내용이 기록과 같은 파일을 이 문서의 새 위치로 삼는다. */
export async function relocateByDigest(row: RecentDoc, io: RelocateIo): Promise<string | null> {
  if (!row.sourceDigest.startsWith('blake3:')) return null;
  const probes = await io.search(row.documentId, row.fileName);
  for (const probe of probes ?? []) {
    let bytes: Uint8Array | null;
    try {
      bytes = await io.read(probe.probeId);
    } catch {
      continue;
    }
    if (bytes && io.digest(bytes) === row.sourceDigest) return io.relocate(row.documentId, probe.probeId);
  }
  return null;
}

const nativeRelocateIo: RelocateIo = {
  search: (documentId, basenameHint) => searchNearbyNativeDocuments(documentId, { basenameHint }),
  read: async (probeId) => (await readNativeProbe(probeId))?.bytes ?? null,
  digest: documentSourceDigest,
  relocate: relocateNativeDocument,
};

export const defaultHealIo: HealIo = {
  relocate: (row) => relocateByDigest(row, nativeRelocateIo),
  forget: async (row) => {
    await removeRecentDoc(row.id);
    await deleteThumbnail(thumbnailKey(row.documentId)).catch(() => {});
  },
  rename: async (row, fileName) => { await updateRecentDoc(row.id, { fileName }); },
};

export const thumbnailKey = (documentId: string) => `document:${documentId}`;

export type ThumbnailResult = { blob: Blob | null; corrupt?: boolean };

const canRenderThumbnail = (fileName: string) => /\.(hwpx?|hml)$/i.test(fileName);

/**
 * 닫힌 문서의 첫 쪽 그림. 저장한 그림의 stamp 가 파일과 같으면 그대로 쓰고, 다르면 파일을 읽어
 * 다시 그린다. 파일에 닿을 수 없으면 마지막으로 그린 그림을 쓴다. 엔진이 읽지 못한 파일은 corrupt.
 */
export async function documentThumbnail(row: RecentDoc, presence: DocumentPresence | undefined): Promise<ThumbnailResult> {
  const key = thumbnailKey(row.documentId);
  const cached = await readThumbnail(key).catch(() => null);
  if (presence?.state !== 'present') return { blob: cached?.blob ?? null };
  if (cached?.stamp === presence.stamp) return { blob: cached.blob };
  if (!canRenderThumbnail(presence.fileName)) return { blob: cached?.blob ?? null };

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
  if (!bytes) return { blob: cached?.blob ?? null };
  try {
    const blob = await renderThumbnailFromBytes(bytes, presence.fileName);
    if (blob) await writeThumbnail(key, presence.stamp, blob).catch(() => {});
    return { blob: blob ?? cached?.blob ?? null };
  } catch (error) {
    if (error instanceof ThumbnailParseError) return { blob: null, corrupt: true };
    return { blob: cached?.blob ?? null };
  }
}

/** 열린 문서에서 바로 그린 그림을 저장한다. 파일 stamp 와 다르게 두어 닫은 뒤에는 파일로 다시 그린다. */
export async function rememberLiveThumbnail(documentId: string, blob: Blob): Promise<void> {
  await writeThumbnail(thumbnailKey(documentId), `live:${Date.now()}`, blob).catch(() => {});
}

/** 템플릿 그림. 개정 번호가 같으면 다시 받지 않는다. */
export async function templateThumbnail(
  template: { id: string; name: string; format: string; revision: number; contentHash: string },
  fetchBytes: () => Promise<Uint8Array>,
): Promise<Blob | null> {
  const key = `template:${template.id}`;
  const stamp = `${template.revision}:${template.contentHash}`;
  const cached = await readThumbnail(key).catch(() => null);
  if (cached?.stamp === stamp) return cached.blob;
  try {
    const blob = await renderThumbnailFromBytes(await fetchBytes(), `${template.name}.${template.format}`);
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
      const loaded = new Set(commits.map((commit) => commit.id));
      const primary = list.find((tree) => tree.primary)?.branch ?? null;
      const heads = orderBranchHeadFrontier(branches, repository?.defaultBranch ?? null, primary)
        .filter((head) => loaded.has(head));
      const lanes = new Map(layoutCommitGraph(commits, [], heads).map((row) => [row.commitId, row.lane]));
      colors.set(repositoryId, new Map(branches.map((branch) => [branch.name, laneColor(lanes.get(branch.target) ?? 0)])));
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
