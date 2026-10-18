import type {
  ChatPermissionCapability, ChatPermissionOutcome, ChatPermissionRequest, ChatPermissionRequestKind, ChatPermissionScope,
  SecretKind, SecretMeta,
} from './types.ts';

const capabilities: readonly ChatPermissionCapability[] = ['project-edit', 'downloads', 'browser', 'local-execution'];

export const CHAT_PERMISSION_LABELS: Readonly<Record<ChatPermissionCapability, string>> = {
  'project-edit': '프로젝트 수정',
  downloads: '파일 다운로드',
  browser: '브라우저 사용',
  'local-execution': '로컬 파일·명령 실행',
};

const requestKinds: readonly ChatPermissionRequestKind[] = [
  'browser-save-account', 'browser-use-account', 'browser-site-access', 'browser-sign-in', 'browser-code', 'secret-save', 'secret-use',
];
const secretKinds: readonly SecretKind[] = ['api-key', 'token', 'password', 'other'];

export const SECRET_KIND_LABELS: Readonly<Record<SecretKind, string>> = {
  'api-key': 'API 키',
  token: '토큰',
  password: '비밀번호',
  other: '비밀 값',
};

export function isChatPermissionScope(value: unknown): value is ChatPermissionScope {
  return value === 'chat' || value === 'always';
}

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
  const kind = requestKinds.includes(request['kind'] as ChatPermissionRequestKind) ? request['kind'] as ChatPermissionRequestKind : undefined;
  const secret = kind === 'secret-save' || kind === 'secret-use';
  // 비밀 값 요청은 브라우저 도구로만 쓰인다. 허브가 권한 이름을 빼도 브라우저 요청으로 읽는다.
  const capability = isChatPermissionCapability(request['capability']) ? request['capability']
    : secret && request['capability'] === undefined ? 'browser' : null;
  if (!text(request['requestId'], 256) || !text(request['threadId'], 256)
    || !(request['documentId'] === null || text(request['documentId'], 256))
    || !text(request['turnId'], 256)
    || typeof request['agent'] !== 'string'
    || !['claude', 'codex', 'pi'].includes(request['agent'])
    || !capability
    || !text(request['reason'], 1000) || !text(request['createdAt'], 128)) return null;
  if (kind === 'secret-use' && !text(request['secretId'], 256)) return null;
  const scopes = Array.isArray(request['scopes']) && request['scopes'].length > 0 && request['scopes'].length <= 2
    && request['scopes'].every(isChatPermissionScope) ? [...new Set(request['scopes'] as ChatPermissionScope[])] : null;
  return {
    requestId: request['requestId'], threadId: request['threadId'], documentId: request['documentId'],
    turnId: request['turnId'], agent: request['agent'] as ChatPermissionRequest['agent'],
    capability, reason: request['reason'], createdAt: request['createdAt'],
    ...(kind ? { kind } : {}),
    ...(text(request['secretId'], 256) ? { secretId: request['secretId'] } : {}),
    ...(text(request['secretLabel'], 80) ? { secretLabel: request['secretLabel'] } : {}),
    ...(secretKinds.includes(request['secretKind'] as SecretKind) ? { secretKind: request['secretKind'] as SecretKind } : {}),
    ...(scopes ? { scopes } : {}),
    ...(text(request['tabId'], 160) ? { tabId: request['tabId'] } : {}),
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

/** 허브 스냅샷의 대기 요청 목록. 배열이 없으면(옛 허브) null 이다. */
export function readChatPermissionRequests(value: unknown): ChatPermissionRequest[] | null {
  if (!Array.isArray(value)) return null;
  const seen = new Set<string>();
  const requests: ChatPermissionRequest[] = [];
  for (const entry of value.slice(0, 32)) {
    const request = readChatPermissionRequest(entry);
    if (!request || seen.has(request.requestId)) continue;
    seen.add(request.requestId);
    requests.push(request);
  }
  return requests.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** 비밀 값 메타데이터만 받는다. 값처럼 보이는 필드는 읽지 않는다. */
export function readSecretMeta(value: unknown): SecretMeta | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const secret = value as Record<string, unknown>;
  if (!text(secret['id'], 256) || !text(secret['label'], 80) || !secretKinds.includes(secret['kind'] as SecretKind)
    || !Array.isArray(secret['origins']) || !secret['origins'].every((origin) => text(origin, 2048))
    || !isChatPermissionScope(secret['scope']) || !text(secret['createdAt'], 128)) return null;
  return {
    id: secret['id'], label: secret['label'], kind: secret['kind'] as SecretKind,
    origins: [...secret['origins'] as string[]], scope: secret['scope'], approved: secret['approved'] === true,
    createdAt: secret['createdAt'], lastUsedAt: text(secret['lastUsedAt'], 128) ? secret['lastUsedAt'] : null,
  };
}
