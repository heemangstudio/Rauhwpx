import assert from 'node:assert/strict';
import test from 'node:test';
import type { SidebarBridge } from '../src/agent/bridge.ts';
import type { BrowserEvent, BrowserFrame, BrowserResult, BrowserTab, SidebarEvent } from '../src/agent/types.ts';
import { createBrowserController } from '../src/ui/agent-sidebar/browser-controller.ts';

function fixture() {
  const listeners = new Set<(event: BrowserEvent) => void>();
  const actions: string[] = [];
  let respond: (action: string) => Promise<BrowserResult> = async () => ({});
  const bridge = {
    getConnectionState: () => 'connected',
    onBrowserEvent(handler: (event: BrowserEvent) => void) { listeners.add(handler); return () => listeners.delete(handler); },
    onEvent(_handler: (event: SidebarEvent) => void) { return () => undefined; },
    async requestBrowser(action: string) { actions.push(action); return respond(action); },
  } as unknown as SidebarBridge;
  return { controller: createBrowserController(bridge), actions,
    emit(event: BrowserEvent) { for (const handler of listeners) handler(event); },
    respond(handler: typeof respond) { respond = handler; },
  };
}
function tab(navigationEpoch = 1, controllerEpoch = 1): BrowserTab {
  return { tabId: 'owned-tab', threadId: 'chat', documentId: null, projectId: 'project', url: `https://example.com/${navigationEpoch}`, title: '자료', navigationEpoch, controllerEpoch, controller: { owner: controllerEpoch === 1 ? 'agent' : 'human' }, status: 'ready' };
}
function frame(owner: BrowserTab): BrowserFrame {
  return { frameId: `${owner.navigationEpoch}:${owner.controllerEpoch}`, tabId: owner.tabId, navigationEpoch: owner.navigationEpoch, controllerEpoch: owner.controllerEpoch, mimeType: 'image/jpeg', data: 'snapshot', width: 1280, height: 800, deviceScaleFactor: 1, scrollX: 0, scrollY: 0 };
}

test('늦게 도착한 화면 응답이 새 탐색이나 사람의 조작권을 되돌리지 않는다', async () => {
  const f = fixture(); const before = tab();
  f.emit({ type: 'owned_browser_inventory', tabs: [before] });
  let resolve!: (result: BrowserResult) => void;
  f.respond(async () => new Promise((done) => { resolve = done; }));
  const pending = f.controller.readFrame();
  const current = tab(2, 2);
  f.emit({ type: 'owned_browser_tab', tab: current });
  resolve({ tab: before, frame: frame(before) }); await pending;
  assert.deepEqual(f.controller.tab(), current);
  assert.equal(f.controller.frame(), null);
  f.controller.dispose();
});

test('오래된 목록 응답과 조작권 응답을 받은 뒤에도 현재 화면 세대를 유지한다', () => {
  const f = fixture(); const current = tab(3, 4);
  f.emit({ type: 'owned_browser_inventory', tabs: [current], frame: frame(current) });
  f.emit({ type: 'owned_browser_inventory', tabs: [tab(2, 4)] });
  f.emit({ type: 'owned_browser_tab', tab: tab(3, 3), frame: frame(tab(3, 3)) });
  assert.deepEqual(f.controller.tab(), current);
  assert.equal(f.controller.frame()?.frameId, '3:4');
  f.emit({ type: 'owned_browser_tab', tab: tab(3, 5) });
  assert.equal(f.controller.frame(), null);
  f.controller.dispose();
});

test('화면을 제거해도 브라우저 탭을 닫지 않고 이전 런타임 이벤트를 무시한다', () => {
  const f = fixture(); const owner = tab();
  f.emit({ type: 'owned_browser_inventory', runtime: { runtimeId: 'runtime', generation: 2, state: 'ready', kind: 'chromium' }, tabs: [owner], frame: frame(owner) });
  f.emit({ type: 'owned_browser_runtime', runtime: { runtimeId: 'runtime', generation: 1, state: 'disconnected', kind: 'chromium' }, tabs: [] });
  assert.equal(f.controller.state.runtime?.generation, 2);
  assert.equal(f.controller.tab()?.tabId, owner.tabId);
  f.controller.dispose();
  assert.equal(f.actions.includes('close'), false);
});

test('런타임을 교체하면 새 세대의 탭을 쓰고 입력에 그 세대를 고정한다', () => {
  const f = fixture();
  f.emit({ type: 'owned_browser_inventory', tabs: [{ ...tab(8, 6), runtimeGeneration: 1 }] });
  f.emit({ type: 'owned_browser_inventory', tabs: [{ ...tab(1, 1), runtimeGeneration: 2 }] });
  assert.deepEqual(f.controller.identity(), { tabId: 'owned-tab', navigationEpoch: 1, controllerEpoch: 1, runtimeGeneration: 2 });
  f.emit({ type: 'owned_browser_tab', tab: { ...tab(9, 7), runtimeGeneration: 1 } });
  assert.equal(f.controller.tab()?.runtimeGeneration, 2);
  assert.equal(f.controller.tab()?.navigationEpoch, 1);
  f.controller.dispose();
});
