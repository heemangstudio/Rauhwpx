import crypto from 'node:crypto';
import { promises as fs, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { retryLockedOperation } from './harness-update.mjs';

export const CHAT_PERMISSION_CAPABILITIES = Object.freeze([
  'project-edit', 'downloads', 'browser', 'local-execution', 'other-documents', 'chatgpt', 'claude',
]);

/** 채팅 권한으로 남는(request_permission 으로 청할 수 있는) 권한. */
export const GRANTABLE_CHAT_PERMISSIONS = CHAT_PERMISSION_CAPABILITIES;

/** 허브만 확인하는 권한 — 공급자 실행 모드를 바꾸지 않으므로 턴 중에도 바로 부여한다. */
export const HUB_ONLY_CHAT_PERMISSIONS = Object.freeze(['other-documents', 'chatgpt', 'claude']);

export function chatPermissionForCategory(category) {
  if (category === 'project-write' || category === 'project-ingest') return 'project-edit';
  if (category === 'download-write') return 'downloads';
  if (category === 'browser') return 'browser';
  if (category === 'chatgpt' || category === 'claude') return category;
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

/** Windows 에서 백신·동기화·편집기가 잠깐 쥔 파일은 rename·읽기가 EPERM/EBUSY 로 실패한다. 짧게 다시 시도한다. */
function retryLockedFile(operation, platform) {
  return retryLockedOperation(operation, { platform, relabel: false });
}

function parseChatPermissionPolicy(raw) {
  // 메모장·PowerShell 이 붙이는 UTF-8 BOM 은 내용이 아니다.
  const parsed = JSON.parse(raw.replace(/^\uFEFF/, ''));
  if (parsed?.schema !== 1 || !Array.isArray(parsed.always)) {
    throw Object.assign(new Error('The chat permission policy cannot be read'), { code: 'CHAT_PERMISSION_POLICY_INVALID' });
  }
  return normalizeChatPermissionGrants(parsed.always);
}

/**
 * "항상" 허용한 채팅 권한. 허브 데이터 폴더의 작은 JSON(0600, 원자적 교체)에 둔다.
 * 새 채팅도 이 권한으로 시작한다. 읽을 수 없는 파일은 빈 정책으로 다루지 않고 오류를 낸다.
 * 같은 사용자의 여러 허브(데스크톱·개발 서버·다른 작업 폴더)가 이 파일을 함께 쓴다 — 바꿀 때마다
 * 파일을 다시 읽어 합치고, 조회는 다른 허브가 바꾼 파일을 따라간다. 그래서 거둔 권한이 되살아나지 않는다.
 */
export function createChatPermissionPolicy({ filePath, platform = process.platform }) {
  if (!filePath) throw new TypeError('Chat permission policy filePath is required.');
  let always = [];
  let stamp = null;
  let queue = Promise.resolve();
  const stampOf = (info) => `${info.mtimeMs}:${info.size}`;
  async function readFromDisk() {
    let raw;
    let info;
    try {
      info = await retryLockedFile(() => fs.stat(filePath), platform);
      raw = await retryLockedFile(() => fs.readFile(filePath, 'utf8'), platform);
    } catch (error) {
      if (error?.code === 'ENOENT') { stamp = null; return []; }
      throw error;
    }
    const grants = parseChatPermissionPolicy(raw);
    stamp = stampOf(info);
    return grants;
  }
  /** 다른 허브가 파일을 바꿨으면 동기로 다시 읽는다. 읽지 못하면 마지막 값을 쓴다. */
  function refresh() {
    try {
      const info = statSync(filePath);
      if (stampOf(info) === stamp) return;
      always = parseChatPermissionPolicy(readFileSync(filePath, 'utf8'));
      stamp = stampOf(info);
    } catch (error) {
      if (error?.code === 'ENOENT' && stamp !== null) { always = []; stamp = null; }
    }
  }
  const ready = (async () => { always = await readFromDisk(); })();
  async function write(next) {
    await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
    const temp = `${filePath}.${crypto.randomUUID()}.tmp`;
    try {
      const file = await fs.open(temp, 'wx', 0o600);
      try { await file.writeFile(JSON.stringify({ schema: 1, always: next })); await file.sync(); } finally { await file.close(); }
      await retryLockedFile(() => fs.rename(temp, filePath), platform);
      await fs.chmod(filePath, 0o600).catch(() => {});
    } finally { await fs.rm(temp, { force: true }); }
    always = next;
    stamp = await fs.stat(filePath).then(stampOf, () => null);
  }
  function mutate(operation) {
    const task = queue.then(async () => {
      // 처음 읽기가 일시적으로 실패했어도 다시 읽는다. 파일이 여전히 깨져 있으면 여기서 오류가 난다.
      await ready.catch(() => {});
      always = await readFromDisk();
      return operation();
    });
    queue = task.catch(() => {});
    return task;
  }
  return {
    ready: () => ready,
    /** 동기 조회 — ready() 이후 값. */
    list: () => { refresh(); return [...always]; },
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
