import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test, { after, before } from 'node:test';
import { fileURLToPath } from 'node:url';

import { CommandDispatcher } from '../src/command/dispatcher.ts';
import { EventBus } from '../src/core/event-bus.ts';
import { deriveAgentEditingLease, planModeAllowsUserEditing } from '../src/agent/editing-lease.ts';
import { createTestModuleServer } from './support/module-server.ts';

registerHooks({
  load(url, context, next) {
    return url.endsWith('.css')
      ? { format: 'module', source: 'export default {};', shortCircuit: true }
      : next(url, context);
  },
});
const { AgentBridgeImpl } = await import('../src/agent/bridge.ts');

const rootDir = fileURLToPath(new URL('..', import.meta.url));
let vite: Awaited<ReturnType<typeof createTestModuleServer>>;
let inputHandlerProto: any;
let ImeSession: any;

before(async () => {
  vite = await createTestModuleServer(rootDir);
  inputHandlerProto = (await vite.ssrLoadModule('/src/engine/input-handler.ts')).InputHandler.prototype;
  ImeSession = (await vite.ssrLoadModule('/src/engine/ime-session.ts')).ImeSession;
});

after(async () => {
  await vite?.close();
});

test('agent editing lock blocks mutations but leaves view, copy and other-document commands available', () => {
  const executed: string[] = [];
  const definitions = new Map(['edit:copy', 'view:zoom-in', 'format:bold', 'insert:table', 'file:open', 'edit:select-all', 'edit:find'].map((id) => [
    id,
    { execute: () => executed.push(id) },
  ]));
  const dispatcher = new CommandDispatcher(
    { get: (id: string) => definitions.get(id) } as any,
    { getContext: () => ({ readOnly: false, userEditingLocked: true, isEditable: false }) } as any,
    new EventBus(),
  );

  assert.equal(dispatcher.dispatch('edit:copy'), true);
  assert.equal(dispatcher.dispatch('view:zoom-in'), true);
  assert.equal(dispatcher.dispatch('format:bold'), false);
  assert.equal(dispatcher.dispatch('insert:table'), false);
  // 다른 문서는 따로 열리므로 에이전트가 잡은 문서를 건드리지 않는다.
  assert.equal(dispatcher.dispatch('file:open'), true);
  assert.equal(dispatcher.dispatch('edit:select-all'), false);
  assert.equal(dispatcher.dispatch('edit:find'), false);
  assert.deepEqual(executed, ['edit:copy', 'view:zoom-in', 'file:open']);
});

test('the derived lease stays active while a turn or tool call runs', () => {
  assert.deepEqual(
    deriveAgentEditingLease({ turnRunning: true, activeToolRequests: 0, agent: 'claude' }),
    { active: true, agent: 'claude' },
  );
  assert.deepEqual(
    deriveAgentEditingLease({ turnRunning: false, activeToolRequests: 1, agent: 'codex' }),
    { active: true, agent: 'codex' },
  );
  assert.deepEqual(
    deriveAgentEditingLease({ turnRunning: false, activeToolRequests: 0, agent: 'pi' }),
    { active: false, agent: 'pi' },
  );
});

test('chat never takes an editing lease and agent keeps it until all tools settle', () => {
  const leases: boolean[] = [];
  const runtime = Object.assign(Object.create(AgentBridgeImpl.prototype), {
    view: {}, workflow: 'question', phase: 'questioning', editingAgent: 'codex',
    turnRunning: true, activeToolRequests: 0, pendingUserQuestionId: null,
    pendingChatPermissionRequest: null, chatPermissionGrants: [],
    editingLease: { active: false, agent: 'codex' }, documentEditingLease: { active: false, agent: 'codex' },
    editingLeaseListeners: new Set([(lease: { active: boolean }) => leases.push(lease.active)]),
    scheduleBusyCheck() {},
  });
  runtime.syncEditingLease();
  assert.equal(runtime.getEditingLease().active, false, 'ordinary chat keeps user editing available');
  runtime.chatPermissionGrants = ['document-edit'];
  runtime.syncEditingLease();
  assert.equal(runtime.getEditingLease().active, false, 'stale document grants do not unlock chat writes');
  runtime.workflow = 'direct';
  runtime.phase = 'direct';
  runtime.syncEditingLease();
  assert.equal(runtime.getEditingLease().active, true, 'agent turns hold the editing lease');
  runtime.turnRunning = false;
  runtime.activeToolRequests = 2;
  runtime.syncEditingLease();
  assert.equal(runtime.getEditingLease().active, true);
  runtime.activeToolRequests = 1;
  runtime.syncEditingLease();
  assert.equal(runtime.getEditingLease().active, true, 'one remaining tool still holds the lease');
  runtime.activeToolRequests = 0;
  runtime.syncEditingLease();
  assert.equal(runtime.getEditingLease().active, false);
  assert.deepEqual(leases, [true, false]);
});

test('plan mode leaves the document editable while a planning turn is running', () => {
  assert.equal(planModeAllowsUserEditing('plan', 'planning'), true);
  assert.equal(planModeAllowsUserEditing('plan', 'awaiting-approval'), true);
  assert.equal(planModeAllowsUserEditing('question', 'questioning'), true);
  assert.equal(planModeAllowsUserEditing('plan', 'switching'), false);
  assert.equal(planModeAllowsUserEditing('plan', 'implementing'), false);
  assert.equal(planModeAllowsUserEditing('direct', 'direct'), false);
  assert.deepEqual(
    deriveAgentEditingLease({
      turnRunning: true, activeToolRequests: 2, agent: 'claude', workflow: 'plan', phase: 'planning',
    }),
    { active: false, agent: 'claude' },
  );
  assert.deepEqual(
    deriveAgentEditingLease({
      turnRunning: true, activeToolRequests: 0, agent: 'codex', workflow: 'plan', phase: 'awaiting-approval',
    }),
    { active: false, agent: 'codex' },
  );
  assert.deepEqual(
    deriveAgentEditingLease({
      turnRunning: true, activeToolRequests: 2, agent: 'codex', workflow: 'question', phase: 'questioning',
    }),
    { active: false, agent: 'codex' },
  );
  assert.deepEqual(
    deriveAgentEditingLease({
      turnRunning: false, activeToolRequests: 0, agent: 'claude', workflow: 'plan', phase: 'switching',
    }),
    { active: true, agent: 'claude' },
  );
  assert.deepEqual(
    deriveAgentEditingLease({
      turnRunning: true, activeToolRequests: 0, agent: 'pi', workflow: 'plan', phase: 'implementing',
    }),
    { active: true, agent: 'pi' },
  );
  assert.deepEqual(
    deriveAgentEditingLease({
      turnRunning: true, activeToolRequests: 0, agent: 'pi', workflow: 'direct', phase: 'direct',
    }),
    { active: true, agent: 'pi' },
  );
  assert.deepEqual(
    deriveAgentEditingLease({
      turnRunning: true,
      activeToolRequests: 0,
      agent: 'claude',
      workflow: 'plan',
      phase: 'planning',
      waitingForUser: true,
    }),
    { active: false, agent: 'claude', waitingForUser: true },
  );
  assert.deepEqual(
    deriveAgentEditingLease({
      turnRunning: true,
      activeToolRequests: 0,
      agent: 'codex',
      workflow: 'question',
      phase: 'questioning',
      waitingForUser: true,
    }),
    { active: false, agent: 'codex', waitingForUser: true },
  );
  assert.deepEqual(
    deriveAgentEditingLease({
      turnRunning: true,
      activeToolRequests: 0,
      agent: 'claude',
      workflow: 'direct',
      phase: 'direct',
      waitingForUser: true,
    }),
    { active: true, agent: 'claude', waitingForUser: true },
  );
});

test('a tool call outside a running turn holds the lease until it settles', async () => {
  let finishTool = () => {};
  const toolDone = new Promise<void>((resolve) => { finishTool = resolve; });
  const bridge = Object.create(AgentBridgeImpl.prototype) as any;
  Object.assign(bridge, {
    activeProviderTurnId: null,
    turnRunning: false,
    editingAgent: 'claude',
    activeToolRequests: 0,
    activeToolRequestControllers: new Map(),
    inFlightWrites: new Set(),
    versionCommitInFlight: null,
    editingLease: { active: false, agent: 'claude' },
    editingLeaseListeners: new Set(),
    pendingUserQuestionId: null,
    workflow: 'direct',
    phase: 'direct',
    capabilityEpoch: null,
    permissionProfile: 'safe',
    activeAgent: 'claude',
    listeners: new Set(),
    executor: { execute: async () => { await toolDone; return { ok: true }; } },
    sendToolResponse() {},
  });

  bridge.handleToolRequest({ id: 1, tool: 'insert_text', args: {}, agent: 'claude', workflow: 'direct', turnBound: false });
  assert.equal(bridge.getEditingLease().active, true, '도구가 문서를 고치는 동안 사용자 입력을 막는다');
  finishTool();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(bridge.getEditingLease().active, false);
});

/** 건드리면 바로 실패하는 문서 서비스. 잠금 게이트가 먼저 막았는지 본다. */
function untouchable(name: string): any {
  return new Proxy({}, {
    get: (_target, key) => {
      throw new Error(`locked editor touched ${name}.${String(key)}`);
    },
  });
}

test('the user editing lock rejects user input but records agent operations', () => {
  const recorded: unknown[] = [];
  const handler: any = Object.create(inputHandlerProto);
  Object.assign(handler, {
    active: true,
    readOnly: false,
    userEditingLocked: true,
    agentTemplateLocked: false,
    cursor: { getPosition: () => ({ sectionIndex: 0, paragraphIndex: 0, charOffset: 0 }) },
    history: { recordWithoutExecute: (command: unknown) => recorded.push(command) },
    isOperationAllowedInEditMode: () => true,
    refreshAfterOperation() {},
    resetTextareaBuffer() {},
  });
  handler.executeOperation({ kind: 'record', command: { type: 'insertText', who: 'user' } });
  handler.executeOperation({ kind: 'record', command: { type: 'insertText', who: 'agent' }, meta: { origin: 'agent' } });
  assert.deepEqual(recorded.map((command: any) => command.who), ['agent']);

  Object.assign(handler, { cursor: untouchable('cursor'), wasm: untouchable('wasm'), imeSession: untouchable('imeSession') });
  let prevented = 0;
  const event = (extra: Record<string, unknown> = {}) => ({
    preventDefault: () => { prevented += 1; }, key: 'a', code: 'KeyA', ...extra,
  });
  handler.onInput({ inputType: 'insertText', data: '가', isComposing: false });
  handler.onKeyDown(event());
  handler.onCut(event());
  handler.onPaste(event({ clipboardData: untouchable('clipboardData') }));
  assert.equal(prevented, 3);
});

test('taking the lease drops in-progress composition and placements without refocusing', () => {
  const doc = ['X', '가', 'Y'];
  const calls: string[] = [];
  const imeSession = new ImeSession();
  imeSession.start();
  imeSession.update('가');
  // 선택 표시·캐럿 같은 렌더러는 아무 일도 하지 않는 객체로 채운다.
  const quiet: any = new Proxy({}, { get: () => () => false });
  const target: any = Object.create(inputHandlerProto);
  const handler: any = new Proxy(target, {
    get: (obj, key, receiver) => {
      const value = Reflect.get(obj, key, receiver);
      return value === undefined ? quiet : value;
    },
  });
  Object.assign(target, {
    userEditingLocked: false,
    isMoveDragging: false,
    isPictureMoveDragging: false,
    isPictureRotateDragging: false,
    isLineEndpointDragging: false,
    isPictureResizeDragging: false,
    isResizeDragging: false,
    cellSelectionDragState: null,
    isDragging: false,
    imeSession,
    compositionAnchor: { sectionIndex: 0, paragraphIndex: 0, charOffset: 1 },
    compositionAnchorRect: { pageIndex: 0, x: 0, y: 0, height: 12 },
    compositionLength: 1,
    replaceTextAtRaw: (pos: { charOffset: number }, count: number, text: string) => {
      doc.splice(pos.charOffset, count, ...text);
    },
    resetRawTextMutationEffects() {},
    consumeRawTextMutationBeforeCursor: () => false,
    cancelFormOverlayEdit: () => calls.push('form'),
    removeFormOverlay() {},
    cancelImagePlacement: () => calls.push('image'),
    cancelTextboxPlacement: () => calls.push('textbox'),
    cancelPolygonDrawing: () => calls.push('polygon'),
    textarea: { blur: () => calls.push('blur'), focus: () => calls.push('focus') },
    resetTextareaBuffer() {},
    clearPendingCharFormat() {},
    container: { style: {} },
    // 선택이 없는 커서. 선택 해제 경로의 나머지 질의는 모두 '없음'으로 답한다.
    cursor: new Proxy({
      getPosition: () => ({ sectionIndex: 0, paragraphIndex: 0, charOffset: 1 }),
      getSelectionOrdered: () => null,
    } as Record<string | symbol, unknown>, { get: (target, key) => target[key] ?? (() => false) }),
    selectionRenderer: { clear() {} },
    eventBus: { emit() {} },
  });

  handler.setUserEditingLocked(true);

  assert.equal(doc.join(''), 'XY', '확정하지 않은 조합 글자를 문서에 남기지 않는다');
  assert.equal(imeSession.isComposing, false);
  assert.equal(handler.compositionAnchor, null);
  assert.deepEqual(calls.filter((call) => call !== 'blur'), ['form', 'image', 'textbox', 'polygon']);
  assert.equal(calls.includes('focus'), false, '잠그면서 입력 포커스를 가져오지 않는다');
  assert.equal(handler.userEditingLocked, true);
});

// 남은 소스 가드: 사이드바 검토 버튼과 편집 표시 영역은 DOM 사이드바·index.html 이라
// 단위 테스트로 띄우지 않는다. 문서 교체 차단은 main-entry-guards.test.ts 가 지킨다.
test('pending-edit review stays disabled while an agent holds the lease', () => {
  const sidebar = readFileSync(new URL('../src/ui/agent-sidebar/index.ts', import.meta.url), 'utf8');
  assert.match(sidebar, /approve\.disabled = editingLeaseActive;[\s\S]*if \(bridge\.getEditingLease\(\)\.active\) return;[\s\S]*pendingEdits\.approve/);
  assert.match(sidebar, /reject\.disabled = editingLeaseActive;[\s\S]*if \(bridge\.getEditingLease\(\)\.active\) return;[\s\S]*pendingEdits\.reject/);
});

test('the editing status is announced politely', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /id="agent-editing-status"[^>]*role="status"[^>]*aria-live="polite"/);
});
