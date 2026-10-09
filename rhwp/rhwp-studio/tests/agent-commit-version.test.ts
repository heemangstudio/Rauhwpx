// commit_version 은 쓰기 도구와 섞이지 않는다: 먼저 시작한 쓰기가 끝난 문서를 커밋하고,
// 커밋하는 동안 온 쓰기는 커밋이 끝난 뒤에 돈다. 실제 컨트롤러 경로는 version-agent-commit.browser.test.ts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

// bridge.ts 는 오버레이 css 를 함께 들여온다 — node 테스트에서는 빈 모듈로 대체한다.
registerHooks({
  load(url, context, nextLoad) {
    if (/\.css$/.test(url)) return { format: 'module', source: 'export default {};', shortCircuit: true };
    return nextLoad(url, context);
  },
});

const { AgentBridgeImpl } = await import('../src/agent/bridge.ts');

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

test('commit_version waits for a running write and holds writes that arrive while it commits', async () => {
  const log: string[] = [];
  const slowWrite = deferred();
  const commitGate = deferred();
  const responses: Array<{ id: number; ok: boolean; error?: { code: string } }> = [];
  const bridge = Object.create(AgentBridgeImpl.prototype) as any;
  Object.assign(bridge, {
    activeProviderTurnId: 'turn-1', turnRunning: true,
    activeToolRequests: 0, activeToolRequestControllers: new Map(),
    inFlightWrites: new Set(), versionCommitInFlight: null,
    workflow: 'direct', phase: 'direct', permissionProfile: 'unrestricted', activeAgent: 'claude',
    listeners: new Set(),
    pendingEdits: { commitOpen: () => { log.push('commitOpen'); return true; }, setDirectApply: () => {} },
    executor: {
      execute: async (tool: string) => {
        log.push(`${tool}:start`);
        if (tool === 'insert_image') await slowWrite.promise;
        log.push(`${tool}:end`);
        return { revision: 1 };
      },
    },
    versionCommit: async () => {
      log.push('commit:start');
      await commitGate.promise;
      log.push('commit:end');
    },
    syncEditingLease: () => {},
    sendJson: () => true,
    sendToolResponse: (frame: { id: number; ok: boolean; error?: { code: string } }) => { responses.push(frame); },
  });
  const request = (id: number, tool: string, args: unknown = {}) => bridge.handleToolRequest({
    id, tool, args, agent: 'claude', providerTurnId: 'turn-1',
  });
  const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

  request(1, 'insert_image');
  request(2, 'commit_version', { message: '표 정리' });
  await settle();
  assert.ok(!log.includes('commit:start'), '진행 중인 쓰기가 끝나기 전에는 커밋하지 않는다');

  slowWrite.resolve();
  await settle();
  assert.ok(log.includes('commit:start'));
  request(3, 'insert_text');
  await settle();
  assert.ok(!log.includes('insert_text:start'), '커밋 중에 온 쓰기는 기다린다');

  commitGate.resolve();
  await settle();
  await settle();
  assert.deepEqual(log.filter((entry) => !entry.startsWith('commitOpen')), [
    'insert_image:start', 'insert_image:end', 'commit:start', 'commit:end', 'insert_text:start', 'insert_text:end',
  ]);
  assert.deepEqual(responses.map((r) => [r.id, r.ok]).sort(), [[1, true], [2, true], [3, true]]);
});

test('commit_version turns a never-saved document into SAVE_REQUIRED instead of a retryable failure', async () => {
  const responses: Array<{ ok: boolean; error?: { code: string; message: string } }> = [];
  const bridge = Object.create(AgentBridgeImpl.prototype) as any;
  const saveRequired = Object.assign(new Error('Save the document first'), { code: 'SAVE_REQUIRED' });
  Object.assign(bridge, {
    activeProviderTurnId: 'turn-1', turnRunning: true,
    activeToolRequests: 0, activeToolRequestControllers: new Map(),
    inFlightWrites: new Set(), versionCommitInFlight: null,
    workflow: 'direct', phase: 'direct', permissionProfile: 'unrestricted', activeAgent: 'claude',
    listeners: new Set(),
    pendingEdits: { commitOpen: () => false, setDirectApply: () => {} },
    // 버전 컨트롤러 큐는 VersionError 를 cause 로 감싸 던진다.
    versionCommit: async () => { throw new Error('먼저 문서를 저장하세요.', { cause: saveRequired }); },
    syncEditingLease: () => {},
    sendJson: () => true,
    sendToolResponse: (frame: { ok: boolean; error?: { code: string; message: string } }) => { responses.push(frame); },
  });
  bridge.handleToolRequest({ id: 1, tool: 'commit_version', args: { message: 'x' }, agent: 'claude', providerTurnId: 'turn-1' });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(responses[0]?.error?.code, 'SAVE_REQUIRED');
  assert.match(responses[0]!.error!.message, /Do not retry/);
});
