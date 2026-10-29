import type {
  ChatPermissionCapability, ChatPermissionOutcome, ChatPermissionRequest, ChatPermissionRequestKind, ChatPermissionScope,
  SecretKind, SecretMeta, SiteRequestItem,
} from './types.ts';

const capabilities: readonly ChatPermissionCapability[] = ['project-edit', 'downloads', 'browser', 'local-execution', 'other-documents', 'chatgpt', 'claude'];

export const CHAT_PERMISSION_LABELS: Readonly<Record<ChatPermissionCapability, string>> = {
  'project-edit': '프로젝트 수정',
  downloads: '파일 다운로드',
  browser: '브라우저 사용',
  'local-execution': '로컬 파일 및 명령 실행',
  'other-documents': '다른 문서 읽기',
  chatgpt: 'ChatGPT에 묻기',
  claude: 'Claude에 묻기',
};

const requestKinds: readonly ChatPermissionRequestKind[] = [
  'browser-save-account', 'browser-site-access', 'browser-sign-in', 'browser-code', 'secret-save',
];
/** 옛 허브가 다시 보내는 계정·비밀 값 사용 요청. 사이트 사용 카드로 읽는다. */
const legacySiteKinds = ['browser-use-account', 'secret-use'];
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
  return Array.isArray(value) && value.every(isChatPermissionCapability) ? [...new Set(value)] : [];
}

function text(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max;
}

/** 카드에 보일 로그인·비밀 값 한 줄. 값처럼 보이는 필드는 읽지 않는다. */
function readSiteItems(value: unknown, secret: boolean): SiteRequestItem[] | null {
  if (!Array.isArray(value)) return null;
  const items: SiteRequestItem[] = [];
  for (const entry of value.slice(0, 20)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const item = entry as Record<string, unknown>;
    const name = [item['label'], item['username']].find((candidate) => text(candidate, 256)) as string | undefined;
    if (!text(item['id'], 256) || !name) continue;
    const detail = text(item['username'], 256) && item['username'] !== name ? item['username'] : undefined;
    const secretKind = item['kind'] ?? item['secretKind'];
    items.push({
      id: item['id'], label: name, ...(detail ? { detail } : {}),
      ...(secret && secretKinds.includes(secretKind as SecretKind) ? { secretKind: secretKind as SecretKind } : {}),
      ...(item['blocked'] === true || item['agentBlocked'] === true ? { blocked: true } : {}),
    });
  }
  return items;
}

export function readChatPermissionRequest(value: unknown): ChatPermissionRequest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const request = value as Record<string, unknown>;
  const rawKind = request['kind'];
  const legacy = typeof rawKind === 'string' && legacySiteKinds.includes(rawKind) ? rawKind : null;
  const kind = legacy ? 'browser-site-access'
    : requestKinds.includes(rawKind as ChatPermissionRequestKind) ? rawKind as ChatPermissionRequestKind : undefined;
  const secret = kind === 'secret-save' || legacy === 'secret-use';
  // 비밀 값 요청은 브라우저 도구로만 쓰인다. 허브가 권한 이름을 빼도 브라우저 요청으로 읽는다.
  const capability = isChatPermissionCapability(request['capability']) ? request['capability']
    : secret && request['capability'] === undefined ? 'browser' : null;
  if (!text(request['requestId'], 256) || !text(request['threadId'], 256)
    || !(request['documentId'] === null || text(request['documentId'], 256))
    || !text(request['turnId'], 256)
    || typeof request['agent'] !== 'string'
    || !['claude', 'codex', 'pi', 'hama'].includes(request['agent'])
    || !capability
    // 브라우저 카드는 사이트가 곧 이유다. 에이전트가 이유를 빼도 카드를 보인다. 일반 권한은 이유가 있어야 한다.
    || !(text(request['reason'], 1000) || kind && request['reason'] === '')
    || !text(request['createdAt'], 128)) return null;
  if (legacy === 'secret-use' && !text(request['secretId'], 256)) return null;
  const scopes = Array.isArray(request['scopes']) && request['scopes'].length > 0 && request['scopes'].length <= 2
    && request['scopes'].every(isChatPermissionScope) ? [...new Set(request['scopes'] as ChatPermissionScope[])] : null;
  const origins = Array.isArray(request['origins']) && request['origins'].length <= 20 && request['origins'].every((entry) => text(entry, 2048))
    ? request['origins'] as string[] : null;
  const origin = text(request['origin'], 2048) ? request['origin'] : legacy && origins?.[0] ? origins[0] : null;
  const siteDomain = [request['siteDomain'], request['site']].find((entry): entry is string => text(entry, 253) && !entry.includes('/'));
  const site: Partial<ChatPermissionRequest> = {};
  if (kind === 'browser-site-access') {
    // 옛 사이트 카드는 계정 하나를 accountId·accountLabel 로, 옛 비밀 값 사용 요청은 비밀 값 하나를 실었다.
    const logins = readSiteItems(request['logins'], false)
      ?? (legacy !== 'secret-use' && text(request['accountLabel'], 256)
        ? [{ id: text(request['accountId'], 256) ? request['accountId'] : 'account', label: request['accountLabel'] }] : []);
    const legacyKind = secretKinds.includes(request['secretKind'] as SecretKind) ? request['secretKind'] as SecretKind : 'other';
    const secrets = readSiteItems(request['secrets'], true)
      ?? (legacy === 'secret-use' ? [{ id: request['secretId'] as string,
        label: text(request['secretLabel'], 80) ? request['secretLabel'] : SECRET_KIND_LABELS[legacyKind], secretKind: legacyKind }] : []);
    const blocked = Array.isArray(request['blocked']) ? [...new Set(request['blocked'].filter((entry): entry is string => text(entry, 64)))].slice(0, 12) : [];
    const rawItem = request['item'] && typeof request['item'] === 'object' ? request['item'] as Record<string, unknown> : {};
    const item = text(rawItem['accountId'], 256) ? { accountId: rawItem['accountId'] } : text(rawItem['secretId'], 256) ? { secretId: rawItem['secretId'] } : null;
    if (logins.length) site.logins = logins;
    if (secrets.length) site.secrets = secrets;
    if (blocked.length) site.blocked = blocked;
    if (item) site.item = item;
  }
  return {
    requestId: request['requestId'], threadId: request['threadId'], documentId: request['documentId'],
    turnId: request['turnId'], agent: request['agent'] as ChatPermissionRequest['agent'],
    capability, reason: request['reason'] as string, createdAt: request['createdAt'],
    ...(kind ? { kind } : {}),
    ...(kind === 'secret-save' && text(request['secretId'], 256) ? { secretId: request['secretId'] } : {}),
    ...(kind === 'secret-save' && text(request['secretLabel'], 80) ? { secretLabel: request['secretLabel'] } : {}),
    ...(kind === 'secret-save' && secretKinds.includes(request['secretKind'] as SecretKind) ? { secretKind: request['secretKind'] as SecretKind } : {}),
    ...(scopes ? { scopes } : legacy ? { scopes: ['chat', 'always'] as ChatPermissionScope[] } : {}),
    ...(text(request['tabId'], 160) ? { tabId: request['tabId'] } : {}),
    ...(origin ? { origin } : {}),
    ...(origins ? { origins } : {}),
    ...(kind === 'browser-site-access' && siteDomain ? { siteDomain } : {}),
    ...(kind !== 'browser-site-access' && text(request['accountId'], 256) ? { accountId: request['accountId'] } : {}),
    ...(kind !== 'browser-site-access' && text(request['accountLabel'], 256) ? { accountLabel: request['accountLabel'] } : {}),
    ...site,
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
    origins: [...secret['origins'] as string[]], scope: secret['scope'], blocked: secret['blocked'] === true,
    createdAt: secret['createdAt'], lastUsedAt: text(secret['lastUsedAt'], 128) ? secret['lastUsedAt'] : null,
  };
}
