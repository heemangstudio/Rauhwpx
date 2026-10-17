import type { ChatPermissionCapability, ChatPermissionOutcome, ChatPermissionRequest } from './types.ts';

const capabilities: readonly ChatPermissionCapability[] = ['project-edit', 'downloads', 'browser', 'local-execution', 'other-documents', 'document-link'];

/** 한 번의 요청에만 쓰는 동의 — 허락해도 채팅 전체 권한으로 남기지 않는다. */
const ONE_SHOT_CAPABILITIES: ReadonlySet<ChatPermissionCapability> = new Set(['document-link']);

export const CHAT_PERMISSION_LABELS: Readonly<Record<ChatPermissionCapability, string>> = {
  'project-edit': '프로젝트 수정',
  downloads: '파일 다운로드',
  browser: '브라우저 사용',
  'local-execution': '로컬 파일·명령 실행',
  'other-documents': '다른 문서 읽기',
  'document-link': '문서 연결',
};

export function isChatPermissionCapability(value: unknown): value is ChatPermissionCapability {
  return typeof value === 'string' && capabilities.includes(value as ChatPermissionCapability);
}

export function isOneShotChatPermission(capability: ChatPermissionCapability): boolean {
  return ONE_SHOT_CAPABILITIES.has(capability);
}

/**
 * 알 수 없는 권한이 섞인 목록은 권한으로 받아들이지 않는다. 일회성 동의(document-link)는
 * 채팅 권한이 아니므로 목록에 와도 버린다.
 */
export function readChatPermissionGrants(value: unknown): ChatPermissionCapability[] {
  return Array.isArray(value) && value.every(isChatPermissionCapability)
    ? [...new Set(value)].filter((capability) => !isOneShotChatPermission(capability)) : [];
}

function text(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max;
}

function readKind(request: Record<string, unknown>): Pick<ChatPermissionRequest, 'kind'> {
  const kind = request['kind'];
  if (request['capability'] === 'document-link') {
    return kind === 'open' || kind === 'create' ? { kind } : {};
  }
  return kind === 'browser-save-account' || kind === 'browser-use-account' ? { kind } : {};
}

export function readChatPermissionRequest(value: unknown): ChatPermissionRequest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const request = value as Record<string, unknown>;
  const documentLink = request['capability'] === 'document-link';
  // 문서 연결은 이름이 곧 이유다 — 허브가 이유를 빼도 이름으로 받는다.
  const reason = documentLink && !text(request['reason'], 1000)
    ? (text(request['documentName'], 256) ? `문서 연결 · ${request['documentName']}` : '문서 연결')
    : request['reason'];
  if (!text(request['requestId'], 256) || !text(request['threadId'], 256)
    || !(request['documentId'] === null || text(request['documentId'], 256))
    || !text(request['turnId'], 256)
    || typeof request['agent'] !== 'string'
    || !['claude', 'codex', 'pi'].includes(request['agent'])
    || !isChatPermissionCapability(request['capability'])
    || (documentLink && request['documentName'] != null && !text(request['documentName'], 256))
    || !text(reason, 1000) || !text(request['createdAt'], 128)) return null;
  return {
    requestId: request['requestId'], threadId: request['threadId'], documentId: request['documentId'],
    turnId: request['turnId'], agent: request['agent'] as ChatPermissionRequest['agent'],
    capability: request['capability'], reason, createdAt: request['createdAt'],
    ...readKind(request),
    ...(documentLink && text(request['documentName'], 256) ? { documentName: request['documentName'] } : {}),
    ...(documentLink && text(request['path'], 4096) ? { path: request['path'] } : {}),
    ...(documentLink && text(request['linkDocumentId'], 256) ? { linkDocumentId: request['linkDocumentId'] } : {}),
    ...(text(request['origin'], 2048) ? { origin: request['origin'] } : {}),
    ...(text(request['accountId'], 256) ? { accountId: request['accountId'] } : {}),
    ...(text(request['accountLabel'], 256) ? { accountLabel: request['accountLabel'] } : {}),
    ...(Array.isArray(request['origins']) && request['origins'].length <= 20 && request['origins'].every((value) => text(value, 2048)) ? { origins: request['origins'] as string[] } : {}),
  };
}

export function readChatPermissionOutcome(value: unknown): ChatPermissionOutcome | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const outcome = value as Record<string, unknown>;
  if (outcome['status'] === 'granted') return { status: 'granted' };
  if (outcome['status'] !== 'denied' && outcome['status'] !== 'expired') return null;
  if (outcome['reason'] !== undefined && !text(outcome['reason'], 1000)) return null;
  return { status: outcome['status'], ...(typeof outcome['reason'] === 'string' ? { reason: outcome['reason'] } : {}) };
}

export function chatPermissionMatchesContext(
  request: ChatPermissionRequest,
  context: { threadId: string; documentId: string | null },
): boolean {
  return request.threadId === context.threadId && request.documentId === context.documentId;
}

/**
 * 채팅 기록에 그릴 권한 요청인가. 문서 연결 요청은 문서가 없는 채팅에서 나오고 허락되면 그 채팅이
 * 곧 문서를 얻으므로, 채팅만 맞으면 연결 뒤에도 그 자리에 남는다.
 */
export function chatPermissionShownInContext(
  request: ChatPermissionRequest,
  context: { threadId: string; documentId: string | null },
): boolean {
  if (request.capability === 'document-link' && request.documentId === null) return request.threadId === context.threadId;
  return chatPermissionMatchesContext(request, context);
}
