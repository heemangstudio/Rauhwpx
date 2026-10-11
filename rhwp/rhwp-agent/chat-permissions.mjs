import crypto from 'node:crypto';

export const CHAT_PERMISSION_CAPABILITIES = Object.freeze([
  'project-edit', 'downloads', 'browser', 'local-execution',
]);

export function chatPermissionForCategory(category) {
  if (category === 'project-write' || category === 'project-ingest') return 'project-edit';
  if (category === 'download-write') return 'downloads';
  if (category === 'browser') return 'browser';
  return null;
}

// 연구 가져오기는 신뢰된 다운로드 작업의 이어서 처리하기에만 쓴다. 채팅의 프로젝트 수정 권한과 분리한다.
export const DEFAULT_RESEARCH_PERMISSIONS = Object.freeze({ browse: true, downloads: true, import: true });

export function effectiveResearchPermissions(policy) {
  const value = policy && typeof policy === 'object' ? policy : DEFAULT_RESEARCH_PERMISSIONS;
  return Object.freeze({ browse: value.browse === true, downloads: value.downloads === true, import: value.import === true });
}

export function normalizeChatPermissionGrants(grants) {
  return CHAT_PERMISSION_CAPABILITIES.filter((capability) => Array.isArray(grants) && grants.includes(capability));
}

export function normalizeChatPermissionRequest(value) {
  const capability = value?.capability;
  const reason = typeof value?.reason === 'string' ? value.reason.trim() : '';
  if (!CHAT_PERMISSION_CAPABILITIES.includes(capability) || !reason || reason.length > 1_000) {
    throw Object.assign(new Error('Request a supported chat permission and explain why it is needed in up to 1000 characters'), { code: 'INVALID_CHAT_PERMISSION_REQUEST' });
  }
  return { capability, reason };
}

export function createChatPermissionRequest(value, session) {
  return {
    requestId: crypto.randomUUID(),
    ...normalizeChatPermissionRequest(value),
    threadId: session.threadId,
    documentId: session.documentId,
    turnId: session.turnId,
    agent: session.agent,
    createdAt: new Date().toISOString(),
  };
}

export function isRequestPermissionTool(tool) {
  return tool === 'request_permission' || tool === 'mcp__rhwp__request_permission';
}
