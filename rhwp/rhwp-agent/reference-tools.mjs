import { imageDetails } from './insert-image-source.mjs';
import { referenceScopesForSession } from './reference-session.mjs';

// 삽입할 원본 상한 — 잘라내지 않고 그대로 넣을 때만 적용된다 (스튜디오 insert_image 와 같다).
const INSERT_IMAGE_MAX_BYTES = 5 * 1024 * 1024;

const REFERENCE_TOOLS = new Set([
  'search_reference_files',
  'read_reference_chunk',
]);
const PROJECT_ITEM_ID = /^[fndr][a-z2-7]{6}$/;
const CLIP_ID = /^r[a-z2-7]{6}$/;
const PDF_NAME = /\.pdf$/i;

async function projectItem(session, projectStore, id) {
  if (!projectStore || !session?.projectId) {
    throw referenceError('REFERENCE_NOT_FOUND', 'This chat has no research project');
  }
  try {
    return await projectStore.getItem(session.projectId, id);
  } catch (error) {
    throw referenceError('REFERENCE_NOT_FOUND', String(error?.message ?? error));
  }
}

/**
 * itemId(프로젝트 항목) 또는 fileId 를 참고 자료 fileId 로 바꾼다. 항목은 세션에 묶인 프로젝트에서만 찾는다.
 * @returns {Promise<{fileId: string, itemId: string|null}>}
 */
async function resolveReferenceTarget({ itemId, fileId, session, projectStore }) {
  if (typeof itemId === 'string' && itemId) {
    const item = await projectItem(session, projectStore, itemId);
    if (item.kind === 'clip') {
      throw referenceError('REFERENCE_NOT_FOUND', `${itemId} is a region clip; read it with read_reference_image`);
    }
    if (item.kind !== 'file') {
      throw referenceError('REFERENCE_NOT_FOUND', `${itemId} is a ${item.kind}; read notes with project_read`);
    }
    return { fileId: item.fileId, itemId: item.id };
  }
  return { fileId, itemId: null };
}

/**
 * 그림으로 읽을 원본. 영역 조각이면 그 원본 파일과 쪽·영역을, 항목이면 그 파일을, 아니면 fileId 를 쓴다.
 * itemId 로 조각 id 가 와도 조각으로 읽는다.
 * @returns {Promise<{fileId: string, item: object|null, clip: object|null}>}
 */
async function resolveVisualSource({ itemId, fileId, clipId, session, projectStore }) {
  const clipTarget = clipId ?? (typeof itemId === 'string' && CLIP_ID.test(itemId) ? itemId : null);
  if (clipTarget) {
    const clip = await projectItem(session, projectStore, clipTarget);
    if (clip.kind !== 'clip') throw referenceError('REFERENCE_NOT_FOUND', `${clipTarget} is a ${clip.kind}, not a region clip`);
    const source = await projectItem(session, projectStore, clip.sourceId);
    if (source.kind !== 'file') throw referenceError('REFERENCE_NOT_FOUND', `the source of ${clip.id} is not a file`);
    return { fileId: source.fileId, item: source, clip };
  }
  if (typeof itemId === 'string' && itemId) {
    const item = await projectItem(session, projectStore, itemId);
    if (item.kind !== 'file') throw referenceError('REFERENCE_NOT_FOUND', `${itemId} is a ${item.kind}; read notes with project_read`);
    return { fileId: item.fileId, item, clip: null };
  }
  return { fileId, item: null, clip: null };
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
 * 정규화 영역 [x,y,w,h] 를 원본 픽셀 상자로 옮긴다. 가장자리는 바깥으로 넓혀 영역을 다 담고,
 * 원본 밖으로는 나가지 않는다.
 */
export function rectToCropPx(rect, width, height) {
  const [x, y, w, h] = rect;
  const left = Math.min(width - 1, Math.max(0, Math.floor(x * width)));
  const top = Math.min(height - 1, Math.max(0, Math.floor(y * height)));
  const right = Math.min(width, Math.max(left + 1, Math.ceil((x + w) * width)));
  const bottom = Math.min(height, Math.max(top + 1, Math.ceil((y + h) * height)));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/**
 * 허브의 참조 그림 경로를 거치는 호출인가 — read_reference_image 는 모두(PDF 쪽·조각은 스튜디오가
 * 그린다), insert_image 는 참조 파일이나 영역 조각을 넣을 때.
 */
export function referenceImageCall(tool, args) {
  if (tool === 'read_reference_image') return true;
  if (tool === 'insert_image') {
    return ['referenceFileId', 'clipId'].some((key) => typeof args?.[key] === 'string' && args[key].length > 0);
  }
  return false;
}

/**
 * PDF 원본: 범위 검사를 하고 스튜디오가 HTTP 로 받아 그릴 프로젝트 항목과 쪽을 정한다.
 * 바이트는 WebSocket 으로 보내지 않는다 (스캔 PDF 는 수십 MB 다).
 */
async function pdfSourceFor({ source, page, store, scopes, session, projectStore }) {
  const blob = await store.openBlob({ fileId: source.fileId, scopes });
  const item = source.item ?? (projectStore && session?.projectId
    ? await projectStore.itemForFile(session.projectId, blob.id).catch(() => null)
    : null);
  if (!item || !session?.projectId) {
    throw referenceError('REFERENCE_NOT_FOUND', 'PDF pages are read from research-project items; add the PDF with project_import first');
  }
  const pageCount = item.pageCount ?? blob.pageCount ?? null;
  if (pageCount && page > pageCount) {
    throw referenceError('INVALID_ARGS', `page ${page} is past the last page (${pageCount})`);
  }
  return {
    projectId: session.projectId,
    itemId: item.id,
    fileId: blob.id,
    name: blob.name,
    page,
    ...(pageCount ? { pageCount } : {}),
  };
}

/**
 * read_reference_image 와 참조 원본을 쓰는 insert_image 를 준비한다. 디스크 탐색 없이 저장소만 읽고,
 * 접근 범위는 활성 채팅·문서·프로젝트 스코프로 검사한다.
 * - `{result}`: 허브가 바로 답한다 (자르지 않는 이미지 읽기).
 * - `{forward}`: 스튜디오로 넘길 인자. 이미지는 바이트(imageBase64)를, PDF 는 `pdfSource` 를 싣는다.
 */
export async function planReferenceImageCall({ tool, args, store, session, projectStore = null }) {
  const scopes = referenceScopesForSession(session);
  if (tool === 'read_reference_image') {
    const source = await resolveVisualSource({ ...args, session, projectStore });
    const clip = source.clip;
    const rect = clip?.rect ?? args.rect;
    const isPdf = source.item ? source.item.fileKind === 'pdf' : PDF_NAME.test(store.getFile?.(source.fileId)?.name ?? '');
    const echo = { ...(clip ? { clipId: clip.id } : {}) };
    if (isPdf) {
      const pdfSource = await pdfSourceFor({ source, page: clip?.page ?? args.page ?? 1, store, scopes, session, projectStore });
      return {
        forward: {
          ...echo,
          pdfSource,
          ...(rect ? { rect } : {}),
          ...(args.cropPx !== undefined ? { cropPx: args.cropPx } : {}),
          ...(args.zoom !== undefined ? { zoom: args.zoom } : {}),
        },
      };
    }
    if ((clip?.page ?? args.page ?? 1) !== 1) throw referenceError('INVALID_ARGS', 'an image has a single page');
    const read = await store.readImage({ fileId: source.fileId, scopes });
    const itemId = source.item?.id ?? await itemIdForFile({ fileId: read.fileId, session, projectStore });
    const size = referenceImageSize(Buffer.from(read.image.data, 'base64'));
    if (!rect && args.cropPx === undefined && args.zoom === undefined) {
      return {
        result: {
          ...(itemId ? { itemId } : {}),
          ...echo,
          ...read,
          ...(size ? { widthPx: size.width, heightPx: size.height } : {}),
        },
      };
    }
    if (rect && !size) throw referenceError('INVALID_ARGS', 'the image size is unknown; pass cropPx instead of rect');
    const cropPx = rect ? rectToCropPx(rect, size.width, size.height) : args.cropPx;
    return {
      forward: {
        ...(itemId ? { itemId } : {}),
        ...echo,
        fileId: read.fileId,
        name: read.name,
        imageBase64: read.image.data,
        mimeType: read.image.mimeType,
        ...(cropPx !== undefined ? { cropPx } : {}),
        ...(args.zoom !== undefined ? { zoom: args.zoom } : {}),
      },
    };
  }
  const { referenceFileId, clipId, imagePath, imageBase64, extension, naturalWidthPx, naturalHeightPx, ...rest } = args;
  if (imagePath || imageBase64 || extension || (referenceFileId && clipId)) {
    throw referenceError('INVALID_ARGS', 'pass only one of imagePath, imageBase64, referenceFileId or clipId');
  }
  let source;
  if (clipId) {
    if (rest.cropPx !== undefined) throw referenceError('INVALID_ARGS', 'a clip is already cropped; drop cropPx');
    source = await resolveVisualSource({ clipId, session, projectStore });
  } else {
    // 에이전트가 프로젝트 항목 id 를 넘겨도 받는다.
    source = PROJECT_ITEM_ID.test(String(referenceFileId ?? '')) && projectStore && session?.projectId
      ? await resolveVisualSource({ itemId: referenceFileId, session, projectStore })
      : { fileId: referenceFileId, item: null, clip: null };
  }
  if (source.clip && source.item?.fileKind === 'pdf') {
    // PDF 조각은 스튜디오가 인쇄 해상도로 그린다.
    const pdfSource = await pdfSourceFor({ source, page: source.clip.page, store, scopes, session, projectStore });
    return { forward: { ...rest, clipId: source.clip.id, pdfSource, rect: source.clip.rect } };
  }
  const read = await store.readImage({ fileId: source.fileId, scopes });
  const bytes = Buffer.from(read.image.data, 'base64');
  const details = imageDetails(bytes);
  const size = details ?? referenceImageSize(bytes);
  let cropPx = rest.cropPx;
  if (source.clip) {
    if (!size) throw referenceError('INVALID_ARGS', 'the clip source image size is unknown');
    cropPx = rectToCropPx(source.clip.rect, size.width, size.height);
  }
  // WebP 는 문서에 넣을 수 없어 스튜디오가 PNG 로 다시 인코딩한다 (cropPx 없이도).
  if (details && cropPx === undefined && bytes.length > INSERT_IMAGE_MAX_BYTES) {
    throw referenceError('INVALID_ARGS', 'reference image is larger than 5MB; pass cropPx to insert a region');
  }
  return {
    forward: {
      ...rest,
      ...(cropPx !== undefined ? { cropPx } : {}),
      ...(source.clip ? { clipId: source.clip.id } : {}),
      referenceFileId: read.fileId,
      imageBase64: read.image.data,
      mimeType: read.image.mimeType,
      ...(details
        ? { extension: details.extension, naturalWidthPx: details.width, naturalHeightPx: details.height }
        : {}),
    },
  };
}
