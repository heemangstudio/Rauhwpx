// 읽기 도구의 documentId 를 허브가 스튜디오로 넘기기 전에 푼다 — 부수효과 없는 순수 함수.
// 다른 창에 열린 문서로 보내는 라우팅(DOCUMENT_OPEN_ELSEWHERE 재시도)은 이 결과의 source 를 이어 받는다.
import { workflowError } from './planning-state.mjs';
import { FOREIGN_READ_TOOL_NAMES } from './tools.mjs';
import { lookupDocumentPath, refreshDocumentPath } from './document-paths.mjs';

const FOREIGN_READ_TOOLS = new Set(FOREIGN_READ_TOOL_NAMES);
const LIVE_READ = Object.freeze({ source: null, template: false, foreign: false });

function usesSinceRevision(tool, args) {
  if (args.sinceRevision !== undefined) return true;
  if (tool !== 'read_batch' || !Array.isArray(args.reads)) return false;
  return args.reads.some((item) => item?.sinceRevision !== undefined || item?.args?.sinceRevision !== undefined);
}

/**
 * - documentId 가 없거나 이 채팅의 문서면 평소의 라이브 읽기다 (같은 id 는 인자에서 지운다).
 * - "template": 활성 서식 틀을 읽는다. 허브가 tool-request 에 template 을 붙인다.
 * - "file:<handle>": list_documents({path}) 가 이 세션에 발급한 핸들. 없으면 SOURCE_NOT_FOUND.
 *   경로 재확인은 비동기라 fileHandle 만 돌려주고, resolveFileSource 가 source 를 채운다.
 * - 그 밖의 id: 앱이 아는 다른 문서. tool-request 에 source 를 붙인다.
 * 외부 읽기는 revision 이 없으므로 sinceRevision 과 함께 쓸 수 없다.
 * @param {{ tool: string, args: Record<string, any>, liveDocumentId: string | null, documentPaths?: Map<string, any> | null }} input
 * @returns {{ args: Record<string, any>, source: { kind: 'document', documentId: string } | null, fileHandle?: string, template: boolean, foreign: boolean }}
 */
export function resolveReadSource({ tool, args, liveDocumentId, documentPaths = null }) {
  if (!FOREIGN_READ_TOOLS.has(tool) || args.documentId === undefined) return { args, ...LIVE_READ };
  const { documentId, ...liveArgs } = args;
  if (typeof documentId !== 'string' || documentId.length === 0) {
    throw workflowError('INVALID_ARGS', 'documentId must be a non-empty string');
  }
  if (documentId === liveDocumentId) return { args: liveArgs, ...LIVE_READ };
  if (usesSinceRevision(tool, args)) {
    throw workflowError('INVALID_ARGS', 'sinceRevision tracks the live document; omit it when reading another documentId');
  }
  if (documentId === 'template') return { args, source: null, template: true, foreign: true };
  if (documentId.startsWith('file:')) {
    const fileHandle = documentId.slice('file:'.length);
    if (!lookupDocumentPath(documentPaths, fileHandle)) {
      throw workflowError('SOURCE_NOT_FOUND', 'file handles come from list_documents');
    }
    return { args, source: null, fileHandle, template: false, foreign: true };
  }
  return { args, source: { kind: 'document', documentId }, template: false, foreign: true };
}

/**
 * file: 핸들의 경로를 다시 확인해 source 를 만든다. 크기·수정 시각은 세션에 갱신되어,
 * 바뀐 파일은 Studio 캐시 키(file:{handle}:{size}:{mtime})가 달라져 다시 받는다.
 * 사라진 파일은 SOURCE_NOT_FOUND, 링크·크기 등으로 읽을 수 없게 된 파일은 SOURCE_UNREADABLE.
 * @returns {Promise<{ kind: 'file', handle: string, name: string, size: number, mtimeMs: number }>}
 */
export async function resolveFileSource({ documentPaths, fileHandle, platform }) {
  try {
    return await refreshDocumentPath(documentPaths, fileHandle, platform ? { platform } : undefined);
  } catch (error) {
    throw workflowError(error?.code ?? 'SOURCE_UNREADABLE', String(error?.message ?? error));
  }
}
