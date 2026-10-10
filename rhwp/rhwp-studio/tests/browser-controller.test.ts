import assert from 'node:assert/strict';
import test from 'node:test';
import type { SidebarBridge } from '../src/agent/bridge.ts';
import type { BrowserEvent, BrowserFrame, BrowserResult, BrowserTab, SidebarEvent } from '../src/agent/types.ts';
import { createBrowserController } from '../src/ui/agent-sidebar/browser-controller.ts';

function fixture(nativePresentation = false) {
  const listeners = new Set<(event: BrowserEvent) => void>();
  const actions: string[] = [];
  let respond: (action: string, args: Record<string, unknown>) => Promise<BrowserResult> = async () => ({});
  const bridge = {
    getConnectionState: () => 'connected',
    onBrowserEvent(handler: (event: BrowserEvent) => void) { listeners.add(handler); return () => listeners.delete(handler); },
    onEvent(_handler: (event: SidebarEvent) => void) { return () => undefined; },
    async requestBrowser(action: string, args: Record<string, unknown>) { actions.push(action); return respond(action, args); },
  } as unknown as SidebarBridge;
  return { controller: createBrowserController(bridge, { nativePresentation }), actions,
    emit(event: BrowserEvent) { for (const handler of listeners) handler(event); },
    respond(handler: typeof respond) { respond = handler; },
  };
}

test('네이티브 페이지는 실시간으로 표시하고 의견을 붙일 때만 화면을 캡처한다', async () => {
  const f = fixture(true); const owner = { ...tab(), runtime: 'native' as const };
  f.emit({ type: 'owned_browser_inventory', tabs: [owner] });
  f.controller.select(owner.tabId);
  await f.controller.readFrame();
  assert.deepEqual(f.actions, []);
  f.respond(async () => ({ frame: frame(owner) }));
  await f.controller.readFrame(true);
  assert.deepEqual(f.actions, ['frame']);
  assert.equal(f.controller.frame()?.tabId, owner.tabId);
  f.controller.dispose();
});
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

test('허브 재시작으로 세대가 낮아져도 새 타깃과 조작권을 쓰고 이전 허브 응답은 버린다', () => {
  const f = fixture(true);
  const oldTab = { ...tab(8, 6), runtime: 'native' as const, runtimeGeneration: 5, nativeTargetId: 'previous-native-target' };
  const oldRuntime = { runtimeId: 'previous-hub', generation: 5, state: 'ready', kind: 'native' as const };
  f.emit({ type: 'owned_browser_inventory', runtime: oldRuntime, tabs: [oldTab], frame: frame(oldTab) });
  const fresh = { ...tab(2, 2), runtime: 'native' as const, runtimeGeneration: 1, nativeTargetId: 'retained-native-target', controller: { owner: 'agent' as const } };
  f.emit({ type: 'owned_browser_inventory', runtime: { runtimeId: 'new-hub', generation: 1, state: 'ready', kind: 'native' }, tabs: [fresh] });
  assert.deepEqual(f.controller.tab(), fresh);
  assert.equal(f.controller.frame(), null);
  assert.equal(f.controller.identity().runtimeGeneration, 1);
  f.emit({ type: 'owned_browser_inventory', runtime: oldRuntime, tabs: [oldTab] });
  assert.deepEqual(f.controller.tab(), fresh);
  assert.equal(f.controller.state.runtime.runtimeId, 'new-hub');
  f.controller.dispose();
});


test('탭 닫기는 선택한 탭의 탐색·조작·런타임 세대를 보내고 다른 활성 탭을 유지한다', async () => {
  const f = fixture(true);
  const active = { ...tab(2, 3), runtime: 'native' as const, runtimeGeneration: 7 };
  const inactive = { ...tab(5, 6), tabId: 'inactive', runtime: 'native' as const, runtimeGeneration: 7, status: 'disconnected' as const };
  f.emit({ type: 'owned_browser_inventory', tabs: [active, inactive] });
  f.controller.select(active.tabId);
  f.respond(async (action, args) => {
    if (action !== 'close') return {};
    const target = [active, inactive].find(row => row.tabId === args.tabId)!;
    if (args.navigationEpoch !== target.navigationEpoch || args.controllerEpoch !== target.controllerEpoch || args.runtimeGeneration !== target.runtimeGeneration) throw new Error('Refresh the browser state before sending input.');
    return {};
  });
  await f.controller.close(inactive.tabId);
  assert.equal(f.controller.tab()?.tabId, active.tabId);
  assert.deepEqual(f.controller.state.tabs, [active]);
  await f.controller.close(active.tabId);
  assert.equal(f.controller.tab(), null);
  assert.deepEqual(f.controller.state.tabs, []);
  f.controller.dispose();
});

test('오래된 세대의 탭 닫기가 거절되면 목록과 활성 페이지를 유지한다', async () => {
  const f = fixture(true); const active = { ...tab(2, 3), runtime: 'native' as const, runtimeGeneration: 7 };
  const other = { ...active, tabId: 'survivor' };
  f.emit({ type: 'owned_browser_inventory', tabs: [active, other] });
  f.controller.select(active.tabId);
  f.respond(async () => { throw new Error('Refresh the browser state before sending input.'); });
  await assert.rejects(f.controller.close(active.tabId), /Refresh the browser state/);
  assert.deepEqual(f.controller.state.tabs, [active, other]); assert.equal(f.controller.tab()?.tabId, active.tabId);
  f.respond(async () => ({})); await f.controller.close(active.tabId);
  assert.equal(f.controller.tab()?.tabId, other.tabId);
  f.controller.dispose();
});


test('활성 탭을 닫으면 인접한 탭을 선택하고 마지막 탭은 앞 탭으로 돌아간다', async () => {
  const f = fixture(true); const rows = ['old', 'previous', 'selected', 'next'].map(tabId => ({ ...tab(2, 3), tabId, runtime: 'native' as const }));
  f.emit({ type: 'owned_browser_inventory', tabs: rows }); f.controller.select('selected');
  f.respond(async (_action, args) => ({ tabs: f.controller.state.tabs.filter(row => row.tabId !== args.tabId) }));
  await f.controller.close('selected'); assert.equal(f.controller.tab()?.tabId, 'next');
  await f.controller.close('next'); assert.equal(f.controller.tab()?.tabId, 'previous');
  await f.controller.close('old'); assert.equal(f.controller.tab()?.tabId, 'previous');
  await f.controller.close('previous'); assert.equal(f.controller.tab(), null);
  f.controller.dispose();
});

test('겹친 상태 읽기는 다운로드 목록까지 한 요청을 공유하고 다음 읽기는 새 상태를 받는다', async () => {
  const f = fixture(true);
  let resolveStatus!: (result: BrowserResult) => void;
  let resolveDownloads!: (result: BrowserResult) => void;
  f.respond(async (action) => new Promise((resolve) => {
    if (action === 'status') resolveStatus = resolve;
    else resolveDownloads = resolve;
  }));
  const first = f.controller.refresh();
  const burst = Array.from({ length: 20 }, () => f.controller.refresh());
  assert.deepEqual(f.actions, ['status']);
  resolveStatus({ tabs: [tab(1, 1)] });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const whileDownloading = f.controller.refresh();
  assert.deepEqual(f.actions, ['status', 'downloads']);
  resolveDownloads({ downloads: [] });
  await Promise.all([first, ...burst, whileDownloading]);
  f.respond(async (action) => action === 'status' ? { tabs: [tab(2, 2)] } : { downloads: [] });
  await f.controller.refresh();
  assert.deepEqual(f.actions, ['status', 'downloads', 'status', 'downloads']);
  assert.equal(f.controller.tab()?.navigationEpoch, 2);
  f.controller.dispose();
});

test('겹친 상태 읽기의 오래된 응답도 새 탐색과 조작권 이벤트를 되돌리지 않는다', async () => {
  const f = fixture(true); const before = tab(1, 1);
  f.emit({ type: 'owned_browser_inventory', tabs: [before] });
  let resolveStatus!: (result: BrowserResult) => void;
  f.respond(async (action) => action === 'status' ? new Promise((resolve) => { resolveStatus = resolve; }) : {});
  const first = f.controller.refresh(); const second = f.controller.refresh();
  assert.deepEqual(f.actions, ['status']);
  const current = tab(2, 3);
  f.emit({ type: 'owned_browser_tab', tab: current });
  resolveStatus({ tabs: [before] });
  await Promise.all([first, second]);
  assert.deepEqual(f.controller.tab(), current);
  assert.deepEqual(f.actions, ['status', 'downloads']);
  f.controller.dispose();
});

test('실패한 상태 읽기를 공유한 뒤 다시 시도하고 조작 실패는 호출자에게 전달한다', async () => {
  const f = fixture(true);
  let rejectStatus!: (error: Error) => void;
  f.respond(async () => new Promise((_resolve, reject) => { rejectStatus = reject; }));
  const first = f.controller.refresh(); const second = f.controller.refresh();
  assert.deepEqual(f.actions, ['status']);
  rejectStatus(new Error('허브 응답 실패'));
  await Promise.all([first, second]);
  assert.deepEqual(f.actions, ['status']);
  assert.equal(f.controller.state.error, '허브 응답 실패');
  f.respond(async (action) => { if (action === 'navigate') throw new Error('탐색 실패'); return {}; });
  await f.controller.refresh();
  assert.equal(f.controller.state.error, null);
  await assert.rejects(f.controller.action('navigate'), /탐색 실패/);
  assert.equal(f.controller.state.error, '탐색 실패');
  f.controller.dispose();
});

test('현재 페이지에서 열린 새 창은 즉시 선택하고 다른 페이지의 새 창은 선택을 바꾸지 않는다', () => {
  const f = fixture(true); const parent = tab();
  f.emit({ type: 'owned_browser_inventory', tabs: [parent] });
  f.controller.select(parent.tabId);
  const backgroundClick = { ...parent, tabId: 'background-click' };
  f.emit({ type: 'owned_browser_popup', tab: backgroundClick, openerTabId: parent.tabId, foreground: false });
  assert.equal(f.controller.tab()?.tabId, parent.tabId);
  const popup = { ...parent, tabId: 'popup', url: 'https://example.com/result' };
  f.emit({ type: 'owned_browser_popup', tab: popup, openerTabId: parent.tabId });
  assert.equal(f.controller.tab()?.tabId, popup.tabId);
  assert.deepEqual(f.controller.state.tabs.map(row => row.tabId), [parent.tabId, backgroundClick.tabId, popup.tabId]);
  const background = { ...popup, tabId: 'background-popup' };
  f.emit({ type: 'owned_browser_popup', tab: background, openerTabId: parent.tabId });
  assert.equal(f.controller.tab()?.tabId, popup.tabId);
  f.emit({ type: 'owned_browser_tab', tab: { ...parent, navigationEpoch: 2 } });
  assert.equal(f.controller.tab()?.tabId, popup.tabId);
  f.controller.dispose();
});

test('탭을 전환하면 이전 화면을 놓고 늦은 캡처를 버리지만 페이지와 조작권은 유지한다', async () => {
  const f = fixture();
  const first = tab(); const second = { ...tab(), tabId: 'second', url: 'https://example.com/second' };
  f.emit({ type: 'owned_browser_inventory', tabs: [first, second], frame: frame(first) });
  let resolve!: (result: BrowserResult) => void;
  f.respond(async () => new Promise(done => { resolve = done; }));
  const pending = f.controller.readFrame();
  f.controller.select(second.tabId);
  assert.equal(f.controller.frame(), null);
  assert.equal(f.controller.state.frames.size, 0);
  resolve({ frame: frame(first) }); await pending;
  assert.equal(f.controller.state.frames.size, 0);
  f.emit({ type: 'owned_browser_tab', tab: second, frame: frame(second) });
  assert.equal(f.controller.frame()?.tabId, second.tabId);
  assert.deepEqual(f.controller.state.tabs, [first, second]);
  assert.deepEqual(f.actions, ['frame']);
  f.controller.dispose();
});
