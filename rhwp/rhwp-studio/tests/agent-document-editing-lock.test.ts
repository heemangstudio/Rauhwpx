import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { registerHooks } from 'node:module';

import { CommandDispatcher } from '../src/command/dispatcher.ts';
import { EventBus } from '../src/core/event-bus.ts';
import { deriveAgentEditingLease, planModeAllowsUserEditing } from '../src/agent/editing-lease.ts';

const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const bridge = source('../src/agent/bridge.ts');
const main = source('../src/main.ts');
const input = source('../src/engine/input-handler.ts');
const textInput = source('../src/engine/input-handler-text.ts');
const keyboardInput = source('../src/engine/input-handler-keyboard.ts');
const pendingEdits = source('../src/agent/pending-edits.ts');
const sidebar = source('../src/ui/agent-sidebar/index.ts');
const toolbar = source('../src/ui/toolbar.ts');
const html = source('../index.html');
const css = source('../src/styles/editor.css');

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

test('bridge owns the lease and retains it until every in-flight tool settles', () => {
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
  assert.match(bridge, /case 'turn-start':[\s\S]*this\.editingAgent = event\.agent;[\s\S]*this\.syncEditingLease\(\)/);
  assert.match(bridge, /case 'turn-end':[\s\S]*this\.turnRunning = false;[\s\S]*this\.syncEditingLease\(\)/);
  assert.match(bridge, /const releaseEditingLease = \(\) => \{[\s\S]*this\.activeToolRequests = Math\.max\(0, this\.activeToolRequests - 1\);[\s\S]*this\.syncEditingLease\(\)/);
  assert.match(bridge, /this\.activeToolRequests \+= 1;[\s\S]*\.finally\(\(\) => \{[\s\S]*releaseEditingLease\(\)/);
  assert.match(bridge, /cancelActiveToolRequest[\s\S]*request\.controller\.abort\(\);[\s\S]*request\.releaseEditingLease\(\)/);
  assert.match(bridge, /case 'welcome':[\s\S]*this\.turnRunning = session\.status === 'running';[\s\S]*this\.syncEditingLease\(\)/);
  assert.match(bridge, /stopChat\(\): void[\s\S]*waitForAuthoritativeTurnEnd = this\.state === 'connected' && this\.turnRunning;[\s\S]*if \(!waitForAuthoritativeTurnEnd\) \{[\s\S]*this\.turnRunning = false;[\s\S]*this\.activeProviderTurnId = null;[\s\S]*this\.abortProviderToolRequests\(\);[\s\S]*\}[\s\S]*this\.syncEditingLease\(\)/);
  assert.match(bridge, /dispose\(\): void[\s\S]*this\.activeToolRequests = 0;[\s\S]*this\.syncEditingLease\(\)/);
});

registerHooks({ load(url, context, next) {
  return url.endsWith('.css') ? { format: 'module', source: 'export default {};', shortCircuit: true } : next(url, context);
} });
const { AgentBridgeImpl } = await import('../src/agent/bridge.ts');

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

test('planning saves after a user edit notify the hub mid-plan', () => {
  assert.match(bridge, /eventBus\.on\('document-changed', \(\) => this\.markUserDocumentEdit\(\)\)/);
  assert.match(bridge, /eventBus\.on\('document-mutated', \(\) => this\.markUserDocumentEdit\(\)\)/);
  assert.match(bridge, /eventBus\.on\('document-saved', \(\) => this\.notifyPlanningDocumentSaved\(\)\)/);
  assert.match(bridge, /this\.pendingChatStart = null;[\s\S]*this\.notifyPlanningDocumentSaved\(\)/);
  assert.match(bridge, /case 'chat-started':[\s\S]*this\.notifyPlanningDocumentSaved\(\)/);
  assert.match(bridge, /case 'workflow-changed':[\s\S]*this\.notifyPlanningDocumentSaved\(\)/);
  assert.match(bridge, /type: 'chat-document-saved'/);
  assert.match(bridge, /type: 'planning-document-saved'/);
  assert.match(sidebar, /case 'planning-document-saved':/);
  assert.match(sidebar, /문서를 저장했습니다/);
});

test('entering plan mode unlocks the lease immediately and holds messages until the hub finishes', () => {
  assert.match(bridge, /this\.beginWorkflowSwitch\(workflow\);[\s\S]*type: 'chat-workflow-set'/);
  assert.match(bridge, /this\.workflowSwitchPending = true;[\s\S]*this\.resetWorkflowState\(workflow\)/);
  // 연결이 끊긴 동안 보낸 메시지도 큐에 담아 재연결 뒤에 다시 보낸다.
  assert.match(bridge, /if \(this\.pendingChatStart \|\| this\.workflowSwitchPending \|\| this\.activeAgent === null[\s\S]*this\.state !== 'connected'\)/);
  assert.match(bridge, /if \(this\.workflowSwitchPending \|\| this\.pendingChatStart\) return;/);
  assert.match(bridge, /case 'workflow-changed':[\s\S]*this\.finishWorkflowSwitch\(\);[\s\S]*this\.flushQueuedMessages\(\)/);
  assert.match(bridge, /BACKEND_SWITCH_FAILED[\s\S]*INVALID_WORKFLOW[\s\S]*WORKFLOW_ERROR[\s\S]*this\.revertWorkflowSwitch\(\)/);
  assert.match(bridge, /planModeAllowsUserEditing\(msg\.workflow, msg\.phase\)[\s\S]*this\.workflow = msg\.workflow;[\s\S]*this\.phase = msg\.phase/);
});

test('user input gates remain separate from autonomous agent mutation paths', () => {
  assert.match(input, /executeOperation\(desc:[\s\S]*this\.userEditingLocked && desc\.meta\?\.origin !== 'agent'/);
  assert.match(input, /executeAppliedSnapshot[\s\S]*if \(this\.readOnly\)/);
  assert.doesNotMatch(input.match(/executeAppliedSnapshot[\s\S]*?\n  \}/)?.[0] ?? '', /userEditingLocked/);
  assert.match(pendingEdits, /meta: \{ origin: 'agent', refresh: 'full', scroll: 'preserve' \}/);
  assert.match(textInput, /onInput[\s\S]*this\.readOnly \|\| this\.userEditingLocked/);
  assert.match(keyboardInput, /onKeyDown[\s\S]*this\.readOnly \|\| this\.userEditingLocked/);
  assert.match(input, /format-char'[\s\S]*this\.readOnly \|\| this\.userEditingLocked/);
  assert.match(input, /insertDroppedImageAtClientPoint[\s\S]*this\.readOnly \|\| this\.userEditingLocked/);
  assert.match(toolbar, /querySelectorAll<HTMLButtonElement \| HTMLInputElement \| HTMLSelectElement>\('button, input, select'\)[\s\S]*control\.disabled = !enabled/);
});

test('document replacement and active pointer gestures respect the lease boundary', () => {
  assert.match(main, /canReplaceCurrentDocument[\s\S]*if \(agentEditingLease\.active\)/);
  assert.match(main, /loadFile[\s\S]*canReplaceCurrentDocument\(options\.skipUnsavedGuard\)/);
  const lockMethod = input.match(/setUserEditingLocked\(locked: boolean\): void \{[\s\S]*?\n  \}/)?.[0] ?? '';
  const finishPointer = input.match(/private finishPointerInteractions\(\): void \{[\s\S]*?\n  \}/)?.[0] ?? '';
  assert.match(lockMethod, /this\.finishPointerInteractions\(\);\s*_text\.revertCompositionPreview/);
  assert.match(finishPointer, /_mouse\.onMouseUp\.call\(this, new MouseEvent/);
  assert.match(finishPointer, /this\.cancelImagePlacement\(\)[\s\S]*this\.cancelTextboxPlacement\(\)[\s\S]*this\.cancelPolygonDrawing\(\)/);
  assert.match(finishPointer, /this\.cancelFormOverlayEdit\?\.\(\)/);
  assert.doesNotMatch(input.match(/setUserEditingLocked[\s\S]*?\n  \}/)?.[0] ?? '', /this\.textarea\.focus\(\)/);
  assert.match(main, /addEventListener\('drop'[\s\S]*if \(agentEditingLease\.active && !\(isDoc && shouldOpenInNewSession\(\)\)\)[\s\S]*에이전트가 편집을 마친 뒤 파일을 놓을 수 있습니다/);
  assert.match(sidebar, /approve\.disabled = editingLeaseActive;[\s\S]*if \(bridge\.getEditingLease\(\)\.active\) return;[\s\S]*pendingEdits\.approve/);
  assert.match(sidebar, /reject\.disabled = editingLeaseActive;[\s\S]*if \(bridge\.getEditingLease\(\)\.active\) return;[\s\S]*pendingEdits\.reject/);
  assert.match(sidebar, /onEditingLeaseChange\(\(\) => \{\s*rebuildReview\(\);\s*changesDrawer\.refreshEditingState\(\);/);
});

test('editing frame reflects the active agent and has responsive reduced-motion treatment', () => {
  assert.match(html, /id="agent-editing-frame"[\s\S]*id="agent-editing-status"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.match(main, /editorArea\?\.setAttribute\('aria-busy', lease\.active \? 'true' : 'false'\)/);
  assert.match(main, /statusLabel\.textContent = `\$\{AGENT_LABEL\[lease\.agent\]\}가 문서를 편집 중이에요`/);
  assert.match(main, /if \(lease\.waitingForUser\) statusLabel\.textContent = `\$\{AGENT_LABEL\[lease\.agent\]\}가 답변을 기다리고 있어요`/);
  for (const agent of ['claude', 'pi']) {
    assert.match(css, new RegExp(`data-editing-agent='${agent}'`));
  }
  assert.match(css, /animation:\s*agent-editing-sweep/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*#agent-editing-frame[\s\S]*animation: none/);
  assert.match(css, /@media \(max-width: 1023px\)[\s\S]*#agent-editing-status/);
});
