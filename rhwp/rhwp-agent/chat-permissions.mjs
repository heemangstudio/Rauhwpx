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
