import type { SidebarBridge } from '../../agent/bridge.ts';
import type { BrowserDownload, BrowserEvent, BrowserFrame, BrowserResult, BrowserRuntime, BrowserTab } from '../../agent/types.ts';

export interface BrowserControllerState {
  runtime: BrowserRuntime | null;
  tabs: BrowserTab[];
  activeTabId: string | null;
  frames: Map<string, BrowserFrame>;
  downloads: BrowserDownload[];
  connected: boolean;
  busy: boolean;
  error: string | null;
}

/** 뷰의 수명과 탭의 수명을 분리한다. 화면을 닫아도 런타임 탭은 닫지 않는다. */
export function createBrowserController(bridge: SidebarBridge, options: { nativePresentation?: boolean; tabFilter?: (tab: BrowserTab) => boolean } = {}) {
  const state: BrowserControllerState = {
    runtime: null, tabs: [], activeTabId: null, frames: new Map(), downloads: [],
    connected: bridge.getConnectionState() === 'connected', busy: false, error: null,
  };
  try { state.activeTabId = localStorage.getItem('rhwp.browser.active-tab'); } catch { /* 공유 화면에서는 기록이 없을 수 있다. */ }
  const rememberTab = () => { try { if (state.activeTabId) localStorage.setItem('rhwp.browser.active-tab', state.activeTabId); else localStorage.removeItem('rhwp.browser.active-tab'); } catch { /* 저장소 제한 */ } };
  const listeners = new Set<() => void>();
  let disposed = false;
  let refreshSequence = 0;
  let refreshRequest: Promise<void> | null = null;
  let selectionSequence = 0;
  let frameRequest: Promise<void> | null = null;
  const retiredRuntimeIds = new Set<string>();
  const notify = () => { if (!disposed) for (const listener of listeners) listener(); };
  function tab(): BrowserTab | null { return state.tabs.find((row) => row.tabId === state.activeTabId) ?? null; }
  function latestTab(incoming: BrowserTab): BrowserTab {
    const current = state.tabs.find((row) => row.tabId === incoming.tabId);
    if (current?.runtimeGeneration !== undefined && incoming.runtimeGeneration !== undefined && current.runtimeGeneration !== incoming.runtimeGeneration) {
      return current.runtimeGeneration > incoming.runtimeGeneration ? current : incoming;
    }
    return current && (incoming.navigationEpoch < current.navigationEpoch || incoming.controllerEpoch < current.controllerEpoch) ? current : incoming;
  }
  function accept(result: BrowserResult | BrowserEvent): void {
    if (disposed) return;
    if (result.runtime) {
      if (retiredRuntimeIds.has(result.runtime.runtimeId)) return;
      if (state.runtime?.runtimeId === result.runtime.runtimeId && state.runtime.generation > result.runtime.generation) return;
      if (state.runtime && state.runtime.runtimeId !== result.runtime.runtimeId) {
        retiredRuntimeIds.add(state.runtime.runtimeId);
        // 새 허브는 세대를 0부터 시작하므로 이전 허브의 탭 세대와 비교하지 않는다.
        state.tabs = [];
      }
      if (state.runtime && (state.runtime.runtimeId !== result.runtime.runtimeId || state.runtime.generation !== result.runtime.generation)) state.frames.clear();
      state.runtime = result.runtime;
    }
    if ('type' in result && result.type === 'owned_browser_closed' && typeof result.tabId === 'string') {
      const wasActive = state.activeTabId === result.tabId;
      state.tabs = state.tabs.filter((row) => row.tabId !== result.tabId);
      state.frames.delete(result.tabId);
      if (wasActive) {
        selectionSequence++; state.frames.clear();
        state.activeTabId = state.tabs.find(row => row.tabId === result.openerTabId)?.tabId ?? state.tabs[0]?.tabId ?? null;
        rememberTab();
      }
    }
    if (result.tabs) {
      state.tabs = result.tabs.filter(row => options.tabFilter?.(row) !== false).map(latestTab);
      for (const [id, frame] of state.frames) {
        const owner = state.tabs.find((row) => row.tabId === id);
        if (!owner || owner.navigationEpoch !== frame.navigationEpoch || owner.controllerEpoch !== frame.controllerEpoch) state.frames.delete(id);
      }
      if (!state.tabs.some((row) => row.tabId === state.activeTabId)) state.activeTabId = state.tabs[0]?.tabId ?? null;
    }
    if (result.tab && options.tabFilter?.(result.tab) !== false) {
      const index = state.tabs.findIndex((row) => row.tabId === result.tab!.tabId);
      const incoming = latestTab(result.tab);
      if (index < 0) state.tabs.push(incoming); else state.tabs[index] = incoming;
      const frame = state.frames.get(incoming.tabId);
      if (frame && (frame.navigationEpoch !== incoming.navigationEpoch || frame.controllerEpoch !== incoming.controllerEpoch)) state.frames.delete(incoming.tabId);
      if ('type' in result && result.type === 'owned_browser_popup' && result.foreground !== false
        && result.openerTabId === state.activeTabId && incoming === result.tab) {
        selectionSequence++; state.frames.clear(); state.activeTabId = incoming.tabId; rememberTab();
      }
    }
    if (result.frame) {
      const owner = state.tabs.find((row) => row.tabId === result.frame!.tabId);
      if (owner?.tabId === state.activeTabId && owner.navigationEpoch === result.frame.navigationEpoch
        && owner.controllerEpoch === result.frame.controllerEpoch) state.frames.set(owner.tabId, result.frame);
    }
    const jobs = result.downloads ?? result.jobs;
    if (Array.isArray(jobs)) state.downloads = jobs as BrowserDownload[];
    if ('job' in result && result.job) {
      const job = result.job as BrowserDownload;
      state.downloads = [job, ...state.downloads.filter((row) => row.downloadId !== job.downloadId)];
    }
    notify();
  }
  const unsubscribe = bridge.onBrowserEvent((event) => {
    const data = event.payload && typeof event.payload === 'object' ? { ...event, ...event.payload } as BrowserEvent : event;
    accept(data);
  });
  const unsubscribeConnection = bridge.onEvent((event) => {
    if (event.type !== 'connection') return;
    state.connected = bridge.getConnectionState() === 'connected';
    state.frames.clear();
    state.error = state.connected ? null : '허브 연결이 끊겼습니다. 입력 결과를 확인한 뒤 계속해 주세요.';
    notify();
    if (state.connected) void refresh();
  });
  async function request<T = BrowserResult>(action: string, args: Record<string, unknown> = {}): Promise<T> {
    const result = await bridge.requestBrowser<T>(action, args);
    if (result && typeof result === 'object') accept(result as BrowserResult);
    return result;
  }
  function refresh(): Promise<void> {
    if (disposed) return Promise.resolve();
    // 상태 이벤트가 겹쳐도 다운로드 목록을 포함한 읽기 한 번만 진행한다.
    if (refreshRequest) return refreshRequest;
    const sequence = ++refreshSequence;
    refreshRequest = (async () => {
      try {
        const result = await bridge.requestBrowser('status');
        if (disposed || sequence !== refreshSequence) return;
        state.error = null; state.connected = true; accept(result);
        await request('downloads', { action: 'list' }).catch(() => undefined);
      } catch (error) {
        if (disposed || sequence !== refreshSequence) return;
        state.error = error instanceof Error ? error.message : String(error); notify();
      }
    })().finally(() => { refreshRequest = null; });
    return refreshRequest;
  }
  async function action(name: string, args: Record<string, unknown> = {}): Promise<BrowserResult> {
    state.busy = true; state.error = null; notify();
    try { return await request(name, args); }
    catch (error) { state.error = error instanceof Error ? error.message : String(error); throw error; }
    finally { state.busy = false; notify(); }
  }
  function identity(current = tab()): Record<string, unknown> {
    return current ? { tabId: current.tabId, navigationEpoch: current.navigationEpoch, controllerEpoch: current.controllerEpoch, runtimeGeneration: current.runtimeGeneration ?? state.runtime?.generation } : {};
  }
  function frame(): BrowserFrame | null { return state.activeTabId ? state.frames.get(state.activeTabId) ?? null : null; }
  function usesNativePresentation(): boolean {
    return options.nativePresentation === true && (tab()?.runtime === 'native' || state.runtime?.kind === 'native');
  }
  async function readFrame(force = false): Promise<void> {
    if (!force && usesNativePresentation()) return;
    if (frameRequest || !tab() || !state.connected || disposed) return frameRequest ?? undefined;
    const target = identity();
    frameRequest = request('frame', target).then(() => undefined).catch((error) => {
      state.error = error instanceof Error ? error.message : String(error); notify();
    }).finally(() => { frameRequest = null; });
    return frameRequest;
  }
  return {
    state, tab, frame, identity, action, request, refresh, readFrame, usesNativePresentation, accept,
    subscribe(callback: () => void) { listeners.add(callback); return () => { listeners.delete(callback); }; },
    select(tabId: string) {
      if (!state.tabs.some((row) => row.tabId === tabId)) return;
      selectionSequence++; if (state.activeTabId !== tabId) state.frames.clear(); state.activeTabId = tabId; rememberTab(); notify(); void readFrame();
    },
    async open(url = 'https://www.google.com/') {
      const result = await action('open', { url });
      if (result.tab && options.tabFilter?.(result.tab) !== false) { selectionSequence++; state.frames.clear(); state.activeTabId = result.tab.tabId; rememberTab(); notify(); void readFrame(); }
    },
    async close(tabId: string) {
      const target = state.tabs.find((row) => row.tabId === tabId);
      if (!target) return;
      const index = state.tabs.indexOf(target); const wasActive = state.activeTabId === tabId; const selected = selectionSequence;
      const adjacent = state.tabs[index + 1]?.tabId ?? state.tabs[index - 1]?.tabId ?? null;
      await action('close', identity(target));
      state.tabs = state.tabs.filter((row) => row.tabId !== tabId); state.frames.delete(tabId);
      if (wasActive && selected === selectionSequence) state.activeTabId = state.tabs.find(row => row.tabId === adjacent)?.tabId ?? state.tabs[Math.min(index, state.tabs.length - 1)]?.tabId ?? null;
      rememberTab(); notify(); void readFrame();
    },
    dispose() { disposed = true; refreshSequence++; unsubscribe(); unsubscribeConnection(); listeners.clear(); state.frames.clear(); },
  };
}
export type BrowserController = ReturnType<typeof createBrowserController>;
