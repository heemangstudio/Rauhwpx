import type { ChatPermissionCapability, ChatPermissionOutcome, ChatPermissionRequest } from './types.ts';

const capabilities: readonly ChatPermissionCapability[] = ['document-edit', 'project-edit', 'downloads', 'browser', 'local-execution'];

export const CHAT_PERMISSION_LABELS: Readonly<Record<ChatPermissionCapability, string>> = {
  'document-edit': '문서 편집',
  'project-edit': '프로젝트 수정',
  downloads: '파일 다운로드',
  browser: '브라우저 사용',
  'local-execution': '로컬 파일·명령 실행',
};

export function isChatPermissionCapability(value: unknown): value is ChatPermissionCapability {
  return typeof value === 'string' && capabilities.includes(value as ChatPermissionCapability);
}

/** 알 수 없는 권한이 섞인 목록은 권한으로 받아들이지 않는다. */
export function readChatPermissionGrants(value: unknown): ChatPermissionCapability[] {
  return Array.isArray(value) && value.every(isChatPermissionCapability)
    ? [...new Set(value)] : [];
}

function text(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max;
}

export function readChatPermissionRequest(value: unknown): ChatPermissionRequest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const request = value as Record<string, unknown>;
  if (!text(request['requestId'], 256) || !text(request['threadId'], 256)
    || !(request['documentId'] === null || text(request['documentId'], 256))
    || !text(request['turnId'], 256)
    || typeof request['agent'] !== 'string'
    || !['claude', 'codex', 'pi'].includes(request['agent'])
    || !isChatPermissionCapability(request['capability'])
    || !text(request['reason'], 1000) || !text(request['createdAt'], 128)) return null;
  return {
    requestId: request['requestId'], threadId: request['threadId'], documentId: request['documentId'],
    turnId: request['turnId'], agent: request['agent'] as ChatPermissionRequest['agent'],
    capability: request['capability'], reason: request['reason'], createdAt: request['createdAt'],
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
