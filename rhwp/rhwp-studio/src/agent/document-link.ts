/**
 * 채팅에 문서를 붙이고 뗀다. 문서 없는 채팅은 문서 하나를 잇는다 — 사용자의 진입점(빈 문서 화면·문서 선택·저장
 * 안내 줄)과 에이전트 도구(open_document·create_document)가 같은 흐름을 쓴다. 붙은 채팅은 사용자의 분리 단추나
 * 에이전트의 detach_document 로 떼어 문서 없는 채팅이 된다. 채팅의 문서는 한 번에 하나다.
 * 실제 열기·옮기기는 편집기(main.ts)가 한다. 여기에는 대상·오류·도구 인자만 둔다.
 */
import { AgentToolError } from './types.ts';

/** 채팅에 이을 문서. */
export type ChatDocumentLinkTarget =
  /** 빈 새 문서. name 이 있으면 그 이름, 데스크톱 에이전트가 만들면 folder(없으면 기본 폴더)에 바로 파일을 쓴다. */
  | { kind: 'new'; name?: string; folder?: string }
  /** 최근 문서 기록의 문서. */
  | { kind: 'recent'; documentId: string }
  /** 데스크톱의 절대 경로. */
  | { kind: 'path'; path: string }
  /** 사용자가 파일 선택 창에서 고른다. */
  | { kind: 'pick' };

export interface ChatDocumentLinkRequest {
  target: ChatDocumentLinkTarget;
  /** agent 는 도구 호출 — 대화상자를 띄우지 않고, 만든 문서는 그 채팅이 만든 문서로 표시한다. */
  origin: 'user' | 'agent';
  /** 도구 호출이 속한 채팅. 사이드바가 다른 채팅을 보이고 있으면 잇지 않는다. */
  threadId?: string | null;
}

/** 에이전트의 detach_document — 그 도구 호출(허브 id)이 속한 채팅을 문서에서 뗀다. */
export interface ChatDocumentDetachRequest {
  threadId: string | null;
  /** 허브의 도구 호출 id. 허브가 이 호출을 맡았다가 새 브리지가 붙으면 답한다. */
  callId: number;
}

export interface ChatDocumentLinked {
  documentId: string;
  name: string;
}

/** 허브의 chat-document-linked 답. */
export interface ChatDocumentLinkReply {
  documentId: string;
  documentName: string | null;
  projectId: string | null;
}

export type ChatDocumentLinkCode =
  | 'THREAD_ALREADY_LINKED'
  | 'DOC_OPEN_ELSEWHERE'
  | 'NOT_FOUND'
  | 'PERMISSION_DENIED'
  | 'INVALID_ARGS'
  | 'INVALID_PATH'
  | 'INVALID_NAME'
  | 'INVALID_FOLDER'
  | 'UNREADABLE'
  | 'TOO_LARGE'
  | 'WRITE_FAILED'
  | 'DESKTOP_ONLY'
  | 'CANCELLED'
  | 'LINK_UNAVAILABLE'
  | 'LINK_FAILED'
  | 'NO_DOCUMENT'
  | 'EDITS_PENDING_REVIEW'
  | 'DETACH_UNAVAILABLE'
  | 'DETACH_FAILED';

/** 연결 실패. 도구 응답에는 code·message 그대로 싣는다. */
export class ChatDocumentLinkError extends AgentToolError {
  constructor(code: ChatDocumentLinkCode, message: string) {
    super(code, message);
    this.name = 'ChatDocumentLinkError';
  }
}

const LINK_ERROR_MESSAGES: Readonly<Record<ChatDocumentLinkCode, string>> = {
  THREAD_ALREADY_LINKED: 'This chat already has a document; open or create another document in a new chat.',
  DOC_OPEN_ELSEWHERE: 'The document is open in another tab or window. Read it with documentId instead, or ask the user to close it first.',
  NOT_FOUND: 'The document was not found. Call list_documents for current ids.',
  PERMISSION_DENIED: 'The user did not allow linking this document.',
  INVALID_ARGS: 'Pass either documentId or path.',
  INVALID_PATH: 'The path is not an openable .hwp, .hwpx or .hml file.',
  INVALID_NAME: 'The document name cannot be used as a file name.',
  INVALID_FOLDER: 'The folder does not exist or cannot be written.',
  UNREADABLE: 'The file could not be read as a document.',
  TOO_LARGE: 'The file is too large to open.',
  WRITE_FAILED: 'The new document file could not be written.',
  DESKTOP_ONLY: 'Opening by path is available in the desktop app only.',
  CANCELLED: 'Linking was cancelled.',
  LINK_UNAVAILABLE: 'The chat is not available to link a document right now.',
  LINK_FAILED: 'The document could not be linked.',
  NO_DOCUMENT: 'This chat has no document to detach.',
  EDITS_PENDING_REVIEW: 'Edits from this turn are waiting for the user\'s review, which happens when the turn ends. Detach in a later turn.',
  DETACH_UNAVAILABLE: 'The chat cannot detach right now. Try again after the current action finishes.',
  DETACH_FAILED: 'The chat could not be detached from its document.',
};

export function linkError(code: ChatDocumentLinkCode, message = LINK_ERROR_MESSAGES[code]): ChatDocumentLinkError {
  return new ChatDocumentLinkError(code, message);
}

function nonEmpty(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= max ? trimmed : null;
}

/** 확장자는 빼고 파일 이름에 쓸 수 없는 글자를 걸러 낸 문서 이름. 쓸 수 있는 이름이 없으면 null. */
export function cleanDocumentName(value: unknown): string | null {
  const raw = nonEmpty(value, 200);
  if (!raw) return null;
  // eslint-disable-next-line no-control-regex
  const base = raw.replace(/\.(hwpx|hwp|hml)$/i, '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '').trim();
  return base && !base.startsWith('.') ? base : null;
}

/** open_document·create_document 인자를 연결 대상으로 읽는다. 허브가 이미 권한과 모드를 확인했다. */
export function readDocumentLinkToolArgs(tool: string, args: unknown): ChatDocumentLinkTarget {
  const record = args && typeof args === 'object' && !Array.isArray(args) ? args as Record<string, unknown> : {};
  if (tool === 'create_document') {
    const name = cleanDocumentName(record['name']);
    if (!name) throw linkError('INVALID_NAME', 'create_document needs a name usable as a file name.');
    const folder = record['folder'] === undefined ? null : nonEmpty(record['folder'], 4096);
    if (record['folder'] !== undefined && !folder) throw linkError('INVALID_FOLDER');
    return { kind: 'new', name, ...(folder ? { folder } : {}) };
  }
  if (tool !== 'open_document') throw linkError('INVALID_ARGS', `${tool} does not link documents.`);
  const documentId = record['documentId'] === undefined ? null : nonEmpty(record['documentId'], 256);
  const path = record['path'] === undefined ? null : nonEmpty(record['path'], 4096);
  if ((documentId === null) === (path === null)) throw linkError('INVALID_ARGS');
  return documentId ? { kind: 'recent', documentId } : { kind: 'path', path: path! };
}

export const DOCUMENT_LINK_TOOLS: ReadonlySet<string> = new Set(['open_document', 'create_document']);
export const DOCUMENT_DETACH_TOOL = 'detach_document';

/** 허브가 보낸 연결 거절을 읽는다. 알 수 없는 코드는 LINK_FAILED. */
export function readLinkFailure(frame: Record<string, unknown>): ChatDocumentLinkError {
  const error = frame['error'] && typeof frame['error'] === 'object' ? frame['error'] as Record<string, unknown> : frame;
  const code = typeof error['code'] === 'string' ? error['code'] : '';
  const message = typeof error['message'] === 'string' && error['message'] ? error['message'] : undefined;
  return code === 'THREAD_ALREADY_LINKED'
    ? linkError('THREAD_ALREADY_LINKED', message)
    : linkError('LINK_FAILED', message ?? (code ? `${code}: the hub did not link the document.` : undefined));
}

/** 저장 안내 줄의 원인 — 허브가 프로젝트에 저장하려는 도구를 문서가 없어 막았다. */
export interface DocumentRequiredNotice {
  tool: string;
  reason: 'project-save';
  threadId: string | null;
}

export function readDocumentRequiredFrame(frame: Record<string, unknown>): DocumentRequiredNotice | null {
  if (frame['reason'] !== 'project-save') return null;
  const tool = nonEmpty(frame['tool'], 128) ?? '';
  return { tool, reason: 'project-save', threadId: nonEmpty(frame['threadId'], 256) };
}
