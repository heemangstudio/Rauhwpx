// 작업 공간 묶음 전송: 채팅 시작에 저장소·작업 공간을 싣고, 다시 붙을 때(허브 재시작 포함)와
// 작업 공간이 바뀔 때 project-bind 로 다시 묶는다. 다른 문서의 묶음은 싣지 않는다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

registerHooks({
  load(url, context, nextLoad) {
    if (/\.css$/.test(url)) return { format: 'module', source: 'export default {};', shortCircuit: true };
    return nextLoad(url, context);
  },
});

const { AgentBridgeImpl } = await import('../src/agent/bridge.ts');
const { createProjectWorktreeState } = await import('../src/agent/project-service.ts');

class FakeSocket {
  static OPEN = 1;
  static instances: FakeSocket[] = [];
  readyState = 1;
  sent: any[] = [];
  onopen: (() => void) | null = null;
  onmessage: unknown = null;
  onclose: unknown = null;
  onerror: unknown = null;
  url: string;
  constructor(url: string) {
    this.url = url;
    FakeSocket.instances.push(this);
  }
  send(data: string) { this.sent.push(JSON.parse(data)); }
  close() {}
}
(globalThis as any).WebSocket = FakeSocket;

const binding = (branch = '요약본', documentId = 'doc-variant') => ({
  documentId,
  repositoryId: 'repo-1',
  current: { id: 'wt-variant', branch, primary: false },
  worktrees: [
    { id: 'wt-main', branch: 'main', primary: true, documentId: 'doc-main' },
    { id: 'wt-variant', branch, primary: false, documentId: 'doc-variant' },
  ],
});

function bridgeFixture(overrides: Record<string, unknown> = {}) {
  const bridge = Object.create(AgentBridgeImpl.prototype) as any;
  const worktrees = createProjectWorktreeState();
  Object.assign(bridge, {
    disposed: false, url: 'ws://hub', token: 't', sessionId: 's', ws: null, connectTimer: null,
    state: 'disconnected', requestSeq: 0, pendingChatStart: null, chatStartSent: false,
    threadId: 'thread-variant', documentId: 'doc-variant', documentName: '보고서.hwpx',
    projectWorktreeBinding: null, projectBindPending: false,
    pendingInterrupt: false, pendingSetupCancels: new Map(), browserbaseOverride: null,
    selectedAgent: 'pi', selectedModel: null, selectedEffort: null, permissionProfile: 'safe', serviceTier: 'standard',
    chatHistory: [], turnSnapshots: { reset() {} },
    projects: { worktrees },
    emitConnection() {}, abortActiveToolRequests() {}, flushToolResponses() {},
    flushPendingQuestionCancellation() {}, flushPendingQuestionAnswer() {},
    ...overrides,
  });
  const open = () => {
    bridge.connect();
    const socket = FakeSocket.instances.at(-1)!;
    socket.onopen!();
    return socket;
  };
  return { bridge, worktrees, open };
}

test('reconnecting re-sends the project binding with the worktree, so project calls work before the next message', () => {
  const { bridge, worktrees, open } = bridgeFixture();
  bridge.setProjectWorktrees(binding());
  assert.equal(worktrees.get()?.current.branch, '요약본');
  const socket = open();
  assert.deepEqual(socket.sent, [{
    v: socket.sent[0].v,
    type: 'project-bind',
    threadId: 'thread-variant',
    documentId: 'doc-variant',
    documentName: '보고서.hwpx',
    repositoryId: 'repo-1',
    worktree: { id: 'wt-variant', branch: '요약본', primary: false },
    worktrees: binding().worktrees,
  }]);

  // 같은 묶음은 다시 보내지 않고, 브랜치 이름이 바뀌면 곧바로 다시 묶는다.
  bridge.setProjectWorktrees(binding());
  assert.equal(socket.sent.length, 1);
  bridge.setProjectWorktrees(binding('짧은 판'));
  assert.equal(socket.sent.at(-1).type, 'project-bind');
  assert.equal(socket.sent.at(-1).worktree.branch, '짧은 판');
});

test('chat-start carries the repository only for its own document', () => {
  const { bridge, worktrees, open } = bridgeFixture();
  const socket = open();
  socket.sent.length = 0;
  bridge.setProjectWorktrees(binding());
  bridge.startChat('pi', undefined, undefined, true, 'safe', 'question', 'thread-variant', 'doc-variant', '보고서.hwpx', []);
  const start = socket.sent.findLast((frame) => frame.type === 'chat-start');
  assert.equal(start.repositoryId, 'repo-1');
  assert.deepEqual(start.worktree, { id: 'wt-variant', branch: '요약본', primary: false });

  bridge.pendingChatStart = null;
  bridge.startChat('pi', undefined, undefined, true, 'safe', 'question', 'thread-other', 'doc-other', '다른 문서.hwpx', []);
  const other = socket.sent.findLast((frame) => frame.type === 'chat-start');
  assert.equal(other.documentId, 'doc-other');
  assert.equal('repositoryId' in other, false);
  assert.equal(worktrees.get(), null, 'the board shows no worktree labels for another document');
});
