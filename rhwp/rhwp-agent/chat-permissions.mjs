import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

export const CHAT_PERMISSION_CAPABILITIES = Object.freeze([
  'project-edit', 'downloads', 'browser', 'local-execution', 'other-documents',
]);

/** 채팅 권한으로 남는(request_permission 으로 청할 수 있는) 권한. */
export const GRANTABLE_CHAT_PERMISSIONS = CHAT_PERMISSION_CAPABILITIES;

/** 허브만 확인하는 권한 — 공급자 실행 모드를 바꾸지 않으므로 턴 중에도 바로 부여한다. */
export const HUB_ONLY_CHAT_PERMISSIONS = Object.freeze(['other-documents']);

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
  return GRANTABLE_CHAT_PERMISSIONS.filter((capability) => Array.isArray(grants) && grants.includes(capability));
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
  const normalized = normalizeChatPermissionRequest(value);
  if (!GRANTABLE_CHAT_PERMISSIONS.includes(normalized.capability)) {
    throw Object.assign(new Error(`${normalized.capability} is asked by the app itself and cannot be requested`), { code: 'INVALID_CHAT_PERMISSION_REQUEST' });
  }
  return {
    requestId: crypto.randomUUID(),
    ...normalized,
    threadId: session.threadId,
    documentId: session.documentId,
    turnId: session.turnId,
    agent: session.agent,
    createdAt: new Date().toISOString(),
    // 카드가 보여 줄 범위 선택지. 첫 값이 기본이다.
    scopes: ['chat', 'always'],
  };
}

export function isRequestPermissionTool(tool) {
  return tool === 'request_permission' || tool === 'mcp__rhwp__request_permission';
}

export const CHAT_PERMISSION_SCOPES = Object.freeze(['chat', 'always']);

export function normalizeChatPermissionScope(value) {
  if (value === undefined || value === null) return 'chat';
  if (!CHAT_PERMISSION_SCOPES.includes(value)) {
    throw Object.assign(new Error('Choose chat or always for this permission'), { code: 'INVALID_CHAT_PERMISSION_SCOPE' });
  }
  return value;
}

/**
 * "항상" 허용한 채팅 권한. 허브 데이터 폴더의 작은 JSON(0600, 원자적 교체)에 둔다.
 * 새 채팅도 이 권한으로 시작한다. 읽을 수 없는 파일은 빈 정책으로 다루지 않고 오류를 낸다.
 */
export function createChatPermissionPolicy({ filePath }) {
  if (!filePath) throw new TypeError('Chat permission policy filePath is required.');
  let always = [];
  let queue = Promise.resolve();
  const ready = (async () => {
    let raw;
    try { raw = await fs.readFile(filePath, 'utf8'); }
    catch (error) { if (error?.code === 'ENOENT') return; throw error; }
    const parsed = JSON.parse(raw);
    if (parsed?.schema !== 1 || !Array.isArray(parsed.always)) {
      throw Object.assign(new Error('The chat permission policy cannot be read'), { code: 'CHAT_PERMISSION_POLICY_INVALID' });
    }
    always = normalizeChatPermissionGrants(parsed.always);
  })();
  async function write(next) {
    await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
    const temp = `${filePath}.${crypto.randomUUID()}.tmp`;
    try {
      const file = await fs.open(temp, 'wx', 0o600);
      try { await file.writeFile(JSON.stringify({ schema: 1, always: next })); await file.sync(); } finally { await file.close(); }
      await fs.rename(temp, filePath);
      await fs.chmod(filePath, 0o600).catch(() => {});
    } finally { await fs.rm(temp, { force: true }); }
    always = next;
  }
  function mutate(operation) {
    const task = queue.then(async () => { await ready; return operation(); });
    queue = task.catch(() => {});
    return task;
  }
  return {
    ready: () => ready,
    /** 동기 조회 — ready() 이후 값. */
    list: () => [...always],
    grant: (capability) => mutate(async () => {
      const next = normalizeChatPermissionGrants([...always, capability]);
      if (next.length !== always.length) await write(next);
      return [...always];
    }),
    revoke: (capability) => mutate(async () => {
      if (!CHAT_PERMISSION_CAPABILITIES.includes(capability)) {
        throw Object.assign(new Error('Unknown chat permission'), { code: 'INVALID_CHAT_PERMISSION_REQUEST' });
      }
      if (always.includes(capability)) await write(always.filter((entry) => entry !== capability));
      return [...always];
    }),
  };
}
