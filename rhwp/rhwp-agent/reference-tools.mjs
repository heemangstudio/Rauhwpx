import { imageDetails } from './insert-image-source.mjs';
import { referenceScopesForSession } from './reference-session.mjs';

// 삽입할 원본 상한 — 잘라내지 않고 그대로 넣을 때만 적용된다 (스튜디오 insert_image 와 같다).
const INSERT_IMAGE_MAX_BYTES = 5 * 1024 * 1024;

const REFERENCE_TOOLS = new Set([
  'search_reference_files',
  'read_reference_chunk',
  'read_reference_image',
]);
const PROJECT_ITEM_ID = /^[fnd][a-z2-7]{6}$/;

/**
 * itemId(프로젝트 항목) 또는 fileId 를 참고 자료 fileId 로 바꾼다. 항목은 세션에 묶인 프로젝트에서만 찾는다.
 * @returns {Promise<{fileId: string, itemId: string|null}>}
 */
async function resolveReferenceTarget({ itemId, fileId, session, projectStore }) {
  if (typeof itemId === 'string' && itemId) {
    if (!projectStore || !session?.projectId) {
      throw referenceError('REFERENCE_NOT_FOUND', 'This chat has no research project');
    }
    let item;
    try {
      item = await projectStore.getItem(session.projectId, itemId);
    } catch (error) {
      throw referenceError('REFERENCE_NOT_FOUND', String(error?.message ?? error));
    }
    if (item.kind !== 'file') {
      throw referenceError('REFERENCE_NOT_FOUND', `${itemId} is a ${item.kind}; read notes with project_read`);
    }
    return { fileId: item.fileId, itemId: item.id };
  }
  return { fileId, itemId: null };
}

async function itemIdForFile({ fileId, session, projectStore }) {
  if (!projectStore || !session?.projectId) return null;
  try {
    return (await projectStore.itemForFile(session.projectId, fileId))?.id ?? null;
  } catch {
    return null;
  }
}

/** Execute a hub-local reference MCP call without relaying it to Studio. */
export async function executeReferenceTool({ tool, args, store, session, projectStore = null }) {
  if (!REFERENCE_TOOLS.has(tool)) return { handled: false, result: null };
  const scopes = referenceScopesForSession(session);
  if (tool === 'search_reference_files') {
    await store.activateScopes(scopes);
    const results = store.search({ query: args.query, scopes, maxResults: args.maxResults ?? 8 });
    let itemsByFile = new Map();
    let notes = [];
    if (projectStore && session?.projectId) {
      try {
        const project = await projectStore.get(session.projectId);
        itemsByFile = new Map(project.items.filter((item) => item.kind === 'file').map((item) => [item.fileId, item.id]));
        notes = await projectStore.searchNotes(session.projectId, args.query, 3);
      } catch {}
    }
    return {
      handled: true,
      result: {
        query: args.query,
        results: results.map((hit) => (itemsByFile.has(hit.fileId) ? { itemId: itemsByFile.get(hit.fileId), ...hit } : hit)),
        ...(notes.length > 0 ? { notes } : {}),
      },
    };
  }
  const target = await resolveReferenceTarget({ itemId: args.itemId, fileId: args.fileId, session, projectStore });
  if (tool === 'read_reference_image') {
    const read = await store.readImage({ fileId: target.fileId, scopes });
    const itemId = target.itemId ?? await itemIdForFile({ fileId: read.fileId, session, projectStore });
    const size = referenceImageSize(Buffer.from(read.image.data, 'base64'));
    return {
      handled: true,
      result: {
        ...(itemId ? { itemId } : {}),
        ...read,
        ...(size ? { widthPx: size.width, heightPx: size.height } : {}),
      },
    };
  }
  const read = await store.readChunk({
    fileId: target.fileId,
    chunkId: args.chunkId,
    maxChars: args.maxChars ?? 12_000,
    scopes,
  });
  const itemId = target.itemId ?? await itemIdForFile({ fileId: read.fileId, session, projectStore });
  return { handled: true, result: itemId ? { itemId, ...read } : read };
}

function referenceError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/** PNG/JPEG/GIF/BMP 는 삽입 헤더 파서로, WebP 는 VP8/VP8L/VP8X 청크로 픽셀 크기를 읽는다. */
export function referenceImageSize(bytes) {
  const details = imageDetails(bytes);
  if (details) return { width: details.width, height: details.height };
  if (bytes.length < 30 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WEBP') {
    return null;
  }
  const chunk = bytes.toString('ascii', 12, 16);
  if (chunk === 'VP8X') {
    return { width: bytes.readUIntLE(24, 3) + 1, height: bytes.readUIntLE(27, 3) + 1 };
  }
  if (chunk === 'VP8 ') {
    return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
  }
  if (chunk === 'VP8L') {
    const bits = bytes.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  return null;
}

/**
 * 스튜디오 캔버스가 필요한 참조 이미지 호출인가 — read_reference_image 의 잘라내기/확대와
 * insert_image 의 referenceFileId 는 허브가 원본을 읽어 스튜디오로 넘긴다.
 */
export function referenceImageNeedsStudio(tool, args) {
  if (tool === 'read_reference_image') return args?.cropPx !== undefined || args?.zoom !== undefined;
  if (tool === 'insert_image') return typeof args?.referenceFileId === 'string' && args.referenceFileId.length > 0;
  return false;
}

/**
 * 참조 저장소의 이미지 바이트를 스튜디오 요청 인자로 채운다. 디스크 탐색 없이 저장소 blob 만 읽고,
 * 접근 범위는 활성 채팅·문서 스코프로 검사한다.
 */
export async function resolveReferenceImageArgs({ tool, args, store, session, projectStore = null }) {
  const scopes = referenceScopesForSession(session);
  if (tool === 'read_reference_image') {
    const target = await resolveReferenceTarget({ itemId: args.itemId, fileId: args.fileId, session, projectStore });
    const read = await store.readImage({ fileId: target.fileId, scopes });
    return {
      fileId: read.fileId,
      name: read.name,
      imageBase64: read.image.data,
      mimeType: read.image.mimeType,
      ...(args.cropPx !== undefined ? { cropPx: args.cropPx } : {}),
      ...(args.zoom !== undefined ? { zoom: args.zoom } : {}),
    };
  }
  const { referenceFileId, imagePath, imageBase64, extension, naturalWidthPx, naturalHeightPx, ...rest } = args;
  if (imagePath || imageBase64 || extension) {
    throw referenceError('INVALID_ARGS', 'pass only one of imagePath, imageBase64 or referenceFileId');
  }
  // 에이전트가 프로젝트 항목 id 를 넘겨도 받는다.
  const target = PROJECT_ITEM_ID.test(String(referenceFileId ?? '')) && projectStore && session?.projectId
    ? await resolveReferenceTarget({ itemId: referenceFileId, session, projectStore })
    : { fileId: referenceFileId };
  const read = await store.readImage({ fileId: target.fileId, scopes });
  const bytes = Buffer.from(read.image.data, 'base64');
  const details = imageDetails(bytes);
  // WebP 는 문서에 넣을 수 없어 스튜디오가 PNG 로 다시 인코딩한다 (cropPx 없이도).
  if (details && rest.cropPx === undefined && bytes.length > INSERT_IMAGE_MAX_BYTES) {
    throw referenceError('INVALID_ARGS', 'reference image is larger than 5MB; pass cropPx to insert a region');
  }
  return {
    ...rest,
    referenceFileId: read.fileId,
    imageBase64: read.image.data,
    mimeType: read.image.mimeType,
    ...(details
      ? { extension: details.extension, naturalWidthPx: details.width, naturalHeightPx: details.height }
      : {}),
  };
}
