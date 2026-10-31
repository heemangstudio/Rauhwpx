import './workbench-browser.css';
import { installBrowserTabDrag } from './browser-tab-drag.ts';
import { browserAddressURL } from './browser-search.ts';
import { showContextMenu } from '../native-context-menu.ts';
import { createBrowserCaptureMotion } from './browser-capture-motion.ts';
import { createAgentCursor, viewportPointToDisplay, type AgentPointer } from './browser-agent-cursor.ts';
import type { SidebarBridge } from '../../agent/bridge.ts';
import type { BrowserDownload, BrowserTab } from '../../agent/types.ts';
import { createBrowserController } from './browser-controller.ts';
import type { ChromeSignIn } from './chrome-sign-in.ts';
import { createBrowserPresentation, nativeBrowserApi, type BrowserPresentationMode } from './browser-presentation.ts';
import { saveBrowserCaptureDraft, type BrowserCaptureDestination, type BrowserCaptureDraft } from './browser-capture-store.ts';
import { createIcon, type SidebarIconName } from './icons.ts';
import { createSiteMark, siteOrigin } from './site-mark.ts';
import { autofixReady, createRetryEscalation, onAutofixSettings } from '../autofix/autofix.ts';
import { createAutofixButton, swapSlot, type AutofixButton } from '../autofix/autofix-button.ts';
import type { WorkbenchResource } from './workbench.ts';

/** 사이트 이름은 주소로 구분하고, 다른 사이트는 페이지 제목을 사용한다. */
function browserTabTitle(tab: BrowserTab): string {
  try {
    const host = new URL(tab.url).hostname.replace(/^www\./, '');
    const sites: ReadonlyArray<[string, string]> = [['google.com', 'Google'], ['x.com', 'X'], ['twitter.com', 'X'], ['youtube.com', 'YouTube'], ['github.com', 'GitHub'], ['naver.com', 'Naver']];
    const site = sites.find(([domain]) => host === domain || host.endsWith(`.${domain}`));
    if (site) return site[1];
    const title = tab.title?.trim();
    return title && !/^https?:\/\//i.test(title) && title !== 'about:blank' ? title : host || '새 탭';
  } catch { return tab.title?.trim() || '새 탭'; }
}

export function createWorkbenchBrowser(options: {
  bridge: SidebarBridge;
  getDestination(): BrowserCaptureDestination;
  onCapture(draft: BrowserCaptureDraft): HTMLElement | void;
  onOpenDownload(job: BrowserDownload): void;
  onDock(): void;
  onChat(): void;
  onChange?(): void;
  tabFilter?(tab: BrowserTab): boolean;
  onFloatTab?(tabId: string, point?: { x: number; y: number }): void;
  onClose?(): void;
  chromeSignIn?: ChromeSignIn;
}) {
  const controller = createBrowserController(options.bridge, { nativePresentation: Boolean(nativeBrowserApi()), tabFilter: options.tabFilter });
  const element = document.createElement('section'); element.className = 'ag-browser';
  element.setAttribute('aria-label', '연구 브라우저');
  const toolbar = document.createElement('header'); toolbar.className = 'ag-browser-toolbar';
  const tabs = document.createElement('div'); tabs.className = 'ag-browser-tabs'; tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', '브라우저 탭');
  const navigation = document.createElement('form'); navigation.className = 'ag-browser-navigation';
  function button(label: string, text: string, handler: () => void, parent: HTMLElement = toolbar): HTMLButtonElement {
    const node = document.createElement('button'); node.type = 'button'; node.textContent = text; node.title = label; node.setAttribute('aria-label', label);
    node.addEventListener('click', handler); parent.append(node); return node;
  }
  function icon(node: HTMLButtonElement, name: SidebarIconName): void {
    if (node.dataset.icon === name) return;
    node.dataset.icon = name; node.classList.add('ag-browser-icon'); node.replaceChildren(createIcon(name));
  }
  const handle = (task: Promise<unknown>) => { void task.catch(() => undefined); };
  const back = button('뒤로', '←', () => navigate('back'), navigation);
  const forward = button('앞으로', '→', () => navigate('forward'), navigation); forward.classList.add('ag-browser-forward');
  const reload = button('새로고침', '↻', () => navigate(controller.tab()?.status === 'loading' ? 'stop' : 'reload'), navigation);
  const address = document.createElement('input'); address.className = 'ag-browser-address'; address.type = 'text'; address.inputMode = 'url'; address.autocomplete = 'off'; address.spellcheck = false;
  let addressDraft = false; let addressOwner = '';
  address.addEventListener('input', () => { addressDraft = true; });
  address.setAttribute('aria-label', '브라우저 주소'); address.placeholder = '주소 또는 검색어 입력'; navigation.append(address);
  const go = button('주소 열기', '', () => navigation.requestSubmit(), navigation); icon(go, 'browserForward'); go.classList.add('ag-browser-go');
  const zoom = document.createElement('div'); zoom.className = 'ag-browser-zoom'; zoom.setAttribute('role', 'group'); zoom.setAttribute('aria-label', '페이지 확대/축소'); navigation.append(zoom);
  const zoomFactors = [.25, .5, .67, .75, .9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];
  const tabZoom = new Map<string, number>(); let zoomPending = false;
  const zoomOut = button('페이지 축소', '−', () => stepZoom(-1), zoom);
  const zoomReset = button('페이지 배율 100%로 초기화', '100%', () => changeZoom(1), zoom);
  const zoomIn = button('페이지 확대', '+', () => stepZoom(1), zoom);
  function acceptZoom(tabId: string, result: unknown): void {
    const factor = result && typeof result === 'object' ? (result as { zoomFactor?: unknown }).zoomFactor : undefined;
    if (typeof factor === 'number' && Number.isFinite(factor) && factor >= .25 && factor <= 3) tabZoom.set(tabId, factor);
  }
  function stepZoom(direction: number): void {
    const current = tabZoom.get(controller.tab()?.tabId ?? '') ?? 1;
    const factor = direction > 0 ? zoomFactors.find(value => value > current + .001) : [...zoomFactors].reverse().find(value => value < current - .001);
    if (factor !== undefined) changeZoom(factor);
  }
  function changeZoom(factor: number): void {
    const native = nativeBrowserApi(); const tab = controller.tab();
    if (!native?.zoom || !tab || !controller.usesNativePresentation() || zoomPending) return;
    zoomPending = true; nativeError = null; paint();
    handle(native.zoom({ tabId: tab.tabId, factor }).then(result => acceptZoom(tab.tabId, result)).catch(() => { nativeError = '페이지 배율을 변경하지 못했습니다.'; }).finally(() => { zoomPending = false; paint(); }));
  }
  function paintZoom(): void {
    for (const tabId of tabZoom.keys()) if (!controller.state.tabs.some(tab => tab.tabId === tabId)) tabZoom.delete(tabId);
    const tab = controller.tab(); const factor = tabZoom.get(tab?.tabId ?? '') ?? 1;
    zoomReset.textContent = `${Math.round(factor * 100)}%`;
    const unavailable = !nativeBrowserApi()?.zoom || !tab || !controller.state.connected || !controller.usesNativePresentation() || zoomPending;
    zoomReset.disabled = unavailable; zoomOut.disabled = unavailable || factor <= .25; zoomIn.disabled = unavailable || factor >= 3;
  }
  const status = document.createElement('span'); status.className = 'ag-browser-status'; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const recover = button('끊긴 브라우저 탭 복구', '탭 복구', () => { handle(reconnectBrowser()); });
  let capturePending = false;
  const annotate = button('현재 화면을 캡처해 채팅에 첨부', '화면 캡처', () => { handle(capture()); });
  const captureMotion = createBrowserCaptureMotion(annotate);
  const downloadsButton = button('다운로드 목록', '받은 파일', () => showDownloads(Boolean(downloads.hidden)));
  downloadsButton.setAttribute('aria-expanded', 'false');
  const dockButton = button('작업 칸에 붙이기', '붙이기', () => { presentation.present('dock'); options.onDock(); });
  const floatButton = button('브라우저 띄우기', '띄우기', () => floatCurrentTab());
  const popoutButton = button('별도 창으로 열기', '새 창', () => {
    details.open = false;
    const tab = controller.tab(); const native = nativeBrowserApi();
    if (native && tab && (tab.runtime === 'native' || controller.state.runtime?.kind === 'native')) {
      const rect = surface.getBoundingClientRect();
      nativePopout = true;
      handle((nativePending ?? Promise.resolve()).then(() => attachNative({ tabId: tab.tabId, expectedTargetId: tab.nativeTargetId, bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, mode: 'popout', interactive: true })).then((attached) => {
        if (!attached || disposed || !visible || controller.tab()?.tabId !== tab.tabId) { nativePopout = false; return; }
        nativePopout = true; nativeTab = null; nativeProjection = ''; presentation.hide();
      }).catch(() => { nativePopout = false; nativeError = '브라우저 화면을 연결하지 못했습니다. 다시 연결해 주세요.'; paint(); }));
    } else presentation.present('popout');
  });
  for (const [node, name] of [[back, 'browserBack'], [forward, 'browserForward'], [reload, 'refresh'], [recover, 'refresh'], [annotate, 'browserCapture'], [downloadsButton, 'browserDownload'], [dockButton, 'browserDock'], [floatButton, 'browserFloat'], [popoutButton, 'external']] as const) icon(node, name);
  const tabBar = document.createElement('div'); tabBar.className = 'ag-browser-tabbar'; tabBar.append(tabs);
  // 에이전트가 조작하는 동안 하나만 남는 조작권 단추. 짧은 두 문구를 겹쳐 두어 바뀌어도 폭이 같다.
  const controlButton = document.createElement('button'); controlButton.type = 'button'; controlButton.className = 'ag-browser-control'; controlButton.hidden = true;
  for (const [state, text] of [['take', '직접 조작'], ['return', '돌려주기']] as const) { const label = document.createElement('span'); label.dataset.control = state; label.textContent = text; controlButton.append(label); }
  controlButton.addEventListener('click', () => { const tab = controller.tab(); if (tab) void setControl(tab, !holds(tab)); });
  toolbar.prepend(navigation); navigation.after(controlButton); toolbar.append(status); element.append(tabBar, toolbar);
  const error = document.createElement('div'); error.className = 'ag-browser-error'; error.setAttribute('role', 'alert'); error.hidden = true;
  const errorMessage = document.createElement('span'); error.append(errorMessage);
  const reconnectButton = button('브라우저 다시 연결', '다시 연결', () => { handle(reconnectBrowser()); }, error);
  const stalledReload = button('페이지 다시 열기', '새로고침', () => {
    const tabId = controller.tab()?.tabId; if (tabId) stalledEscalation.retried(tabId);
    handle(reloadStalled());
  }, error); stalledReload.hidden = true;
  // 다시 열어도 두 번 더 멈춘 페이지는 그 자리에 자동 수정을 둔다. 고치면 다시 연다.
  const stalledEscalation = createRetryEscalation(2, 'browser-page');
  let stalledAutofix: AutofixButton | null = null;
  const stalledAutofixButton = (): AutofixButton => stalledAutofix ??= createAutofixButton({
    request: () => {
      const tab = controller.tab();
      return { surface: 'browser-page', title: '화면을 표시하지 못했습니다.', detail: `paint-timeout ${siteOrigin(tab?.url ?? '') ?? ''}`.trim(), attempts: stalledEscalation.attempts(tab?.tabId ?? '') };
    },
    onFixed: () => { if (stalledCurrent()) handle(reloadStalled()); },
  });
  const stopAutofixSettings = onAutofixSettings(() => paint());
  element.append(error);
  const challenge = document.createElement('div'); challenge.className = 'ag-browser-challenge'; challenge.hidden = true; challenge.setAttribute('role', 'status');
  const challengeMessage = document.createElement('span'); challengeMessage.textContent = 'Google에서 트래픽 확인을 요청했습니다.'; challenge.append(challengeMessage);
  const continueChallenge = button('같은 탭에서 Google 확인 직접 완료', '직접 확인', () => {
    presentation.present('dock'); options.onDock();
    handle(controller.readFrame());
  }, challenge);
  const fallbackSearch = button('같은 검색어로 DuckDuckGo 검색', 'DuckDuckGo로 검색', () => {
    const tab = controller.tab(); const url = tab?.challenge?.fallback?.url; if (!tab || !url) return;
    handle(controller.action('navigate', { ...controller.identity(tab), url }).then(() => controller.readFrame()));
  }, challenge);
  element.append(challenge);
  // 패스키·Google 로그인은 Google Chrome에서 하고 로그인만 돌려받는다.
  const chromeBar = document.createElement('div'); chromeBar.className = 'ag-browser-challenge ag-browser-chrome-sign-in'; chromeBar.hidden = true; chromeBar.setAttribute('role', 'status');
  const chromeMessage = document.createElement('span'); chromeBar.append(chromeMessage);
  const chromeOffers = new Map<string, string>();
  const chromeStart = button('Google Chrome으로 로그인', 'Google Chrome으로 로그인', () => { const url = chromeOffers.get(controller.tab()?.tabId ?? '') ?? controller.tab()?.url; if (url) startChromeSignIn(url); }, chromeBar);
  const chromeDismiss = button('닫기', '닫기', () => { const tabId = controller.tab()?.tabId; if (tabId) void nativeBrowserApi()?.chromeSignIn?.({ dismissTabId: tabId }).catch(() => {}); }, chromeBar);
  const chromeFinish = button('Chrome 로그인 완료', '완료', () => { void options.chromeSignIn?.finish().catch(() => {}); }, chromeBar);
  const chromeCancel = button('Chrome 로그인 취소', '취소', () => { void options.chromeSignIn?.cancel().catch(() => {}); }, chromeBar);
  element.append(chromeBar);
  function startChromeSignIn(url: string): void {
    if (!options.chromeSignIn?.available()) return;
    void options.chromeSignIn.start(url).catch(() => {});
  }
  const stopChromeSignIn = options.chromeSignIn?.subscribe(() => { paint(); layout(); });
  const upload = document.createElement('div'); upload.className = 'ag-browser-upload'; upload.hidden = true;
  const uploadLabel = document.createElement('span'); uploadLabel.textContent = '페이지에서 파일을 요청했습니다.';
  const uploadFiles = document.createElement('input'); uploadFiles.type = 'file'; uploadFiles.hidden = true; uploadFiles.setAttribute('aria-label', '웹사이트에 보낼 파일');
  let uploadTarget: Record<string, unknown> | null = null;
  upload.append(uploadLabel, uploadFiles); button('웹사이트에 보낼 파일 선택', '파일 선택', () => uploadFiles.click(), upload);
  button('파일 선택 취소', '취소', () => { uploadTarget = null; upload.hidden = true; }, upload); element.append(upload);
  uploadFiles.addEventListener('change', () => {
    const target = uploadTarget; const chosen = [...uploadFiles.files ?? []]; uploadFiles.value = ''; if (!target || !chosen.length) return;
    if (chosen.length > 5 || chosen.some((file) => file.size > 20 * 1024 * 1024) || chosen.reduce((size, file) => size + file.size, 0) > 40 * 1024 * 1024) { uploadLabel.textContent = '파일은 5개, 각 20 MB, 전체 40 MB까지 보낼 수 있습니다.'; return; }
    uploadLabel.textContent = '파일을 보내고 있습니다…';
    handle(Promise.all(chosen.map(async (file) => {
      const bytes = new Uint8Array(await file.arrayBuffer()); let binary = ''; for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
      return { name: file.name, mimeType: file.type || 'application/octet-stream', data: btoa(binary) };
    })).then((files) => controller.action('upload', { ...target, files })).then(() => { uploadTarget = null; upload.hidden = true; }).catch((failure) => { uploadLabel.textContent = failure instanceof Error ? failure.message : String(failure); }));
  });
  const surface = document.createElement('div'); surface.className = 'ag-browser-surface'; surface.tabIndex = 0; surface.setAttribute('role', 'application'); surface.setAttribute('aria-label', '브라우저 페이지');
  const image = document.createElement('img'); image.className = 'ag-browser-frame'; image.alt = '브라우저 페이지'; image.draggable = false;
  const placeholder = document.createElement('div'); placeholder.className = 'ag-browser-placeholder';
  const sleepingHama = document.createElement('span'); sleepingHama.className = 'ag-browser-sleeping-hama'; sleepingHama.hidden = true; sleepingHama.setAttribute('aria-hidden', 'true');
  const sleepingSprite = document.createElement('span'); sleepingSprite.className = 'ag-browser-sleeping-sprite'; sleepingHama.append(sleepingSprite);
  for (let index = 0; index < 3; index++) { const snore = document.createElement('span'); snore.className = 'ag-browser-snore'; snore.textContent = 'z'; snore.style.setProperty('--snore-delay', `${index * 800}ms`); sleepingHama.append(snore); }
  const placeholderTitle = document.createElement('strong'); placeholderTitle.textContent = '자료를 찾아보세요';
  const placeholderText = document.createElement('p'); placeholderText.textContent = '웹사이트를 읽고 받은 PDF를 문서와 보드에서 확인할 수 있습니다.';
  const emptyOpen = button('연구 브라우저 열기', '브라우저 열기', () => handle(controller.open()), placeholder);
  const wakeButton = button('탭 깨우기', '탭 깨우기', () => wakeCurrentTab(), placeholder); wakeButton.hidden = true;
  placeholder.prepend(sleepingHama, placeholderTitle, placeholderText);
  const textInput = document.createElement('textarea'); textInput.className = 'ag-browser-ime'; textInput.setAttribute('aria-label', '브라우저 페이지에 입력'); textInput.autocomplete = 'off'; textInput.spellcheck = false;
  surface.append(image, placeholder, textInput); element.append(surface);
  const agentCursor = createAgentCursor(surface); let agentCursorTab = '';
  const downloads = document.createElement('section'); downloads.className = 'ag-browser-downloads'; downloads.setAttribute('aria-label', '브라우저 다운로드'); downloads.setAttribute('role', 'dialog'); downloadsButton.setAttribute('aria-haspopup', 'dialog'); downloads.hidden = true; element.append(downloads);
  let passwordSaveTab = ''; let passwordSaveEpoch: number | undefined;
  const savePassword = button('이 페이지에서 입력하는 로그인 저장', '비밀번호 저장', () => {
    const tab = controller.tab(); const api = nativeBrowserApi()?.passwords;
    if (!tab || !api) return;
    const enabled = passwordSaveTab !== tab.tabId;
    savePassword.disabled = true;
    void (async () => {
      // 입력을 비우고 시작한다. 사용자가 쥔 조작권은 그대로 둔다.
      await controller.action('control', controller.identity(tab));
      if (disposed || controller.tab()?.tabId !== tab.tabId) return;
      await projectNative();
      if (nativePending) await nativePending;
      if (disposed || controller.tab()?.tabId !== tab.tabId) return;
      const result = await api.armSave({ tabId: tab.tabId, enabled });
      icon(savePassword, 'shield'); delete savePassword.dataset.passwordSave;
      passwordSaveTab = result.enabled ? tab.tabId : '';
      passwordSaveEpoch = result.navigationEpoch;
      savePassword.setAttribute('aria-pressed', String(result.enabled));
      savePassword.title = result.enabled ? '아이디와 비밀번호를 입력하면 이 기기에 저장합니다' : '이 페이지에서 입력하는 로그인 저장';
    })().catch(() => { savePassword.title = '비밀번호 저장을 시작하지 못했습니다. HTTPS 로그인 페이지에서 다시 시도해 주세요.'; }).finally(() => { savePassword.disabled = false; });
  });
  savePassword.hidden = !nativeBrowserApi()?.passwords;
  icon(savePassword, 'shield'); savePassword.setAttribute('aria-pressed', 'false');
  let manualSleepingTab: string | null = null;
  async function sleepCurrentTab(): Promise<void> {
    const tabId = controller.tab()?.tabId; if (!tabId || agentPreviewTab !== null) return;
    if (manualSleepingTab === tabId) { wakeCurrentTab(); return; }
    details.open = false; manualSleepingTab = tabId; cancelNativeHealth(); nativeHealthGeneration++; nativeSequence++;
    await nativePending?.catch(() => undefined);
    if (disposed || controller.tab()?.tabId !== tabId) { manualSleepingTab = null; return; }
    try {
      let result = await controller.request<{ sleeping: boolean; reason?: string }>('sleep', { tabId });
      if (!result.sleeping && result.reason === 'protected' && window.confirm('이 탭에 입력한 내용은 사라질 수 있습니다. 탭을 잠자기로 전환할까요?')) result = await controller.request('sleep', { tabId, discard: true });
      if (!result.sleeping) { manualSleepingTab = null; if (result.reason !== 'protected') throw new Error('작업 중인 탭은 잠자기로 전환할 수 없습니다.'); }
      else { nativeTab = null; nativeProjection = ''; nativeFailedProjection = ''; }
    } catch (failure) { manualSleepingTab = null; nativeError = failure instanceof Error ? failure.message : String(failure); throw failure; }
    finally { paint(); layout(); }
  }
  function wakeCurrentTab(): void { manualSleepingTab = null; nativeHealthIdentity = ''; nativeProjection = ''; paint(); layout(); }
  const details = document.createElement('details'); details.className = 'ag-browser-details';
  const summary = document.createElement('summary'); summary.setAttribute('aria-label', '브라우저 추가 메뉴'); summary.title = '브라우저 추가 메뉴'; summary.append(createIcon('more'));
  const menu = document.createElement('div'); menu.className = 'ag-browser-menu';
  popoutButton.classList.remove('ag-browser-icon'); popoutButton.replaceChildren(createIcon('external'), document.createTextNode('별도 창으로 열기')); menu.append(popoutButton);
  button('입력창으로 돌아가기', '채팅으로 돌아가기', () => { details.open = false; options.onChat(); }, menu).prepend(createIcon('message'));
  const menuReload = button('새로고침', '새로고침', () => { details.open = false; navigate('reload'); }, menu);
  menuReload.prepend(createIcon('refresh'));
  const menuSleep = button('탭 잠자기', '탭 잠자기', () => handle(sleepCurrentTab()), menu);
  const menuChrome = button('Google Chrome으로 로그인', 'Chrome으로 로그인', () => { details.open = false; const url = controller.tab()?.url; if (url) startChromeSignIn(url); }, menu);
  menuChrome.hidden = !options.chromeSignIn;
  details.append(summary, menu); toolbar.append(details);
  let nativeMenuPending = false;
  summary.addEventListener('click', event => {
    if (!nativeBrowserApi() || typeof (window as Window & { rhwpDesktop?: { showContextMenu?: unknown } }).rhwpDesktop?.showContextMenu !== 'function') return;
    event.preventDefault();
    if (nativeMenuPending || disposed || previewLocked()) return;
    const tabId = controller.tab()?.tabId;
    if (!tabId) return;
    nativeMenuPending = true;
    const rect = summary.getBoundingClientRect();
    void showContextMenu([
      { id: 'popout', label: '별도 창으로 열기', enabled: manualSleepingTab !== tabId },
      { id: 'chat', label: '채팅으로 돌아가기' },
      { id: 'reload', label: '새로고침', enabled: manualSleepingTab !== tabId },
      { id: 'sleep', label: manualSleepingTab === tabId ? '탭 깨우기' : '탭 잠자기' },
      ...(options.chromeSignIn ? [{ id: 'chrome', label: 'Chrome으로 로그인', enabled: options.chromeSignIn.available() && !options.chromeSignIn.site() && /^https:/.test(controller.tab()?.url ?? '') }] : []),
    ], { x: rect.right, y: rect.bottom }).then(choice => {
      if (disposed || previewLocked() || controller.tab()?.tabId !== tabId) return;
      if (choice === 'popout') popoutButton.click();
      else if (choice === 'chat') options.onChat();
      else if (choice === 'reload') navigate('reload');
      else if (choice === 'sleep') handle(sleepCurrentTab());
      else if (choice === 'chrome') { const url = controller.tab()?.url; if (url) startChromeSignIn(url); }
    }).finally(() => { nativeMenuPending = false; });
  });

  details.addEventListener('toggle', () => { if (details.open) { cancelNativeHealth(); nativeHealthGeneration++; showDownloads(false, false); } layout(); });
  function dismissOutside(event: PointerEvent): void {
    const target = event.target as Node;
    let dismissed = false;
    if (details.open && !details.contains(target)) { details.open = false; dismissed = true; }
    if (!downloads.hidden && !downloads.contains(target) && !downloadsButton.contains(target)) { showDownloads(false, false); dismissed = true; }
    if (dismissed && surface.contains(target)) { event.preventDefault(); event.stopPropagation(); }
  }
  element.addEventListener('pointerdown', dismissOutside, { capture: true });
  document.addEventListener('pointerdown', dismissOutside, { capture: true });
  details.addEventListener('focusout', event => {
    if (event.relatedTarget instanceof Node && !details.contains(event.relatedTarget)) details.open = false;
  });
  let agentPreviewTab: string | null = null; let agentOpenedView = false;
  let previewCloseTimer: ReturnType<typeof setTimeout> | null = null;
  function cancelPreviewClose(): void { if (previewCloseTimer !== null) clearTimeout(previewCloseTimer); previewCloseTimer = null; }
  // 조작권 전환은 허브 응답 전에 화면부터 바꾼다. 거절되면 허브의 상태로 되돌아간다.
  let controlPending: { tabId: string; held: boolean } | null = null; let focusPage = false;
  function holds(tab: BrowserTab | null): boolean {
    if (!tab) return false;
    return controlPending?.tabId === tab.tabId ? controlPending.held : tab.controller.held === true;
  }
  /** 에이전트가 이번 턴에 조작 중이고 사용자가 보고 있는 탭을 쥐지 않았다. */
  function previewLocked(): boolean { const tab = controller.tab(); return agentPreviewTab !== null && tab !== null && !holds(tab); }
  /** 허브가 받아들이면 true. 거절은 오류로 보여 주고 false 를 돌려준다. */
  function setControl(target: BrowserTab, held: boolean): Promise<boolean> {
    if (controlPending || disposed) return Promise.resolve(false);
    if (held) { cancelPreviewClose(); agentOpenedView = false; }
    controlPending = { tabId: target.tabId, held }; focusPage = held; nativeError = null;
    paint(); void projectNative();
    if (held && !controller.usesNativePresentation() && controller.tab()?.tabId === target.tabId) textInput.focus({ preventScroll: true });
    const request = controller.request('control', { tabId: target.tabId, owner: held ? 'human' : 'agent' })
      .then(() => true, (failure) => { if (!disposed) nativeError = failure instanceof Error ? failure.message : String(failure); return false; })
      .finally(() => { controlPending = null; focusPage = false; paint(); });
    handle(request);
    return request;
  }
  function endAgentPreview(): void {
    if (disposed || !agentPreviewTab) return;
    // 입력 잠금은 바로 풀고, 에이전트가 띄운 보기는 마지막 사용 뒤 2분 동안 남긴다.
    agentPreviewTab = null;
    if (agentOpenedView && presentation.current() === 'float' && !holds(controller.tab())) {
      cancelPreviewClose();
      previewCloseTimer = setTimeout(() => {
        previewCloseTimer = null;
        if (!disposed && !agentPreviewTab && agentOpenedView && presentation.current() === 'float' && !holds(controller.tab())) presentation.hide();
        agentOpenedView = false; paint(); layout();
      }, 120_000);
    } else agentOpenedView = false;
    paint(); layout();
  }
  let visible = false; let nativeTab: string | null = null; let nativePopout = false;
  let frameTimer: ReturnType<typeof setTimeout> | null = null; let composing = false; let committedComposition: string | null = null; let disposed = false; let selectedFrameId = ''; let nativeSequence = 0;
  let reconnecting = false;
  let tabsSignature = ''; let downloadsSignature = ''; let nativeProjection = ''; let nativeFailedProjection = ''; let nativeError: string | null = null; let nativePending: Promise<boolean> | null = null; let inputChain: Promise<unknown> = Promise.resolve();
  let nativeHealthGeneration = 0; let nativeRecovering = false;
  let nativeHealthIdentity = ''; let nativeReloadedIdentity = '';
  let nativeHealthTimer: ReturnType<typeof setTimeout> | null = null;
  function cancelNativeHealth(): void { if (nativeHealthTimer) clearTimeout(nativeHealthTimer); nativeHealthTimer = null; }
  let lastInputAt = -Infinity;
  const presentation = createBrowserPresentation(element, (mode) => {
    if (mode !== 'float') { cancelPreviewClose(); agentOpenedView = false; }
    if (mode === 'float' || mode === null) { details.open = false; showDownloads(false, false); }
    visible = mode !== null; watchNativeVisibility(); paint(); scheduleFrame(); void projectNative();
  }, { onLayout: () => { layout(); }, onDock: options.onDock, onClose: options.onClose, navigation, captureButton: annotate, controlButton });
  function floatCurrentTab(point?: { x: number; y: number }): void {
    const tab = controller.tab();
    if (tab && !agentPreviewTab && options.onFloatTab) { options.onFloatTab(tab.tabId, point); return; }
    nativePopout = false; presentation.present('float'); if (point) presentation.position(point.x, point.y);
  }
  function navigate(direction: string): void {
    if (!controller.tab()) return;
    handle(controller.action('navigate', { ...controller.identity(), direction }).then(() => controller.readFrame()));
  }
  async function navigateAddress(entered: string, target = controller.tab()): Promise<void> {
    let engine = 'google';
    if (!/^https?:\/\//i.test(entered) && entered !== 'about:blank') {
      const configuration = await options.bridge.requestBrowser<{ searchEngine?: string }>('configuration.get');
      engine = configuration.searchEngine ?? 'google';
    }
    const url = browserAddressURL(entered, engine);
    if (disposed) return;
    wakeCurrentTab();
    if (!target) await controller.open(url);
    else await controller.action('navigate', { ...controller.identity(target), url });
  }
  navigation.addEventListener('submit', event => {
    event.preventDefault(); const entered = address.value.trim(); if (!entered) return;
    addressDraft = false; address.blur(); handle(navigateAddress(entered));
  });
  address.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    event.preventDefault(); event.stopPropagation(); addressDraft = false; address.value = controller.tab()?.url ?? ''; address.blur();
  });
  async function showNativeDownloads(): Promise<void> {
    await controller.request('downloads', { action: 'list' });
    const jobs = controller.state.downloads;
    const rect = downloadsButton.getBoundingClientRect(); const anchor = { x: rect.right, y: rect.bottom };
    const selected = await showContextMenu([
      ...jobs.slice(0, 40).map(job => ({ id: job.downloadId, label: `${job.filename} — ${job.state === 'downloading' ? `받는 중${job.totalBytes ? ` ${Math.min(100, Math.round(job.size / job.totalBytes * 100))}%` : ''}` : job.savedPath ? '저장됨' : job.state === 'cancelled' ? '취소됨' : job.state === 'interrupted' ? '중단됨' : '받은 파일'}, ${formatDownloadSize(job.size)}` })),
      ...(jobs.length ? [] : [{ id: 'empty', label: '받은 파일이 없습니다', enabled: false }]),
      { type: 'separator' as const }, { id: 'refresh', label: '목록 새로고침' },
    ], anchor);
    if (selected === 'refresh') { handle(showNativeDownloads()); return; }
    const job = jobs.find(item => item.downloadId === selected); if (!job || disposed) return;
    const complete = ['downloaded', 'importing', 'imported', 'import-failed'].includes(job.state);
    const choice = await showContextMenu([
      ...(job.mimeType === 'application/pdf' || /\.(hwp|hwpx|rhwp|rhwpx)$/i.test(job.filename) ? [{ id: 'open', label: '문서에서 열기', enabled: complete }] : []),
      { id: 'save', label: '다운로드 폴더에 저장', enabled: complete },
      { id: 'reveal', label: 'Finder에서 보기', enabled: complete },
      { id: 'copy-path', label: '파일 경로 복사', enabled: !!job.savedPath },
      { id: 'copy-link', label: '다운로드 링크 복사', enabled: !!job.source?.url },
      { id: 'cancel', label: '다운로드 취소', enabled: job.state === 'downloading' },
      { id: 'retry', label: '다시 시도', enabled: job.state === 'import-failed' || job.extractionStatus === 'failed' },
    ], anchor);
    if (choice === 'open') options.onOpenDownload(job);
    else if (choice === 'copy-path' && job.savedPath) await navigator.clipboard.writeText(job.savedPath);
    else if (choice === 'copy-link' && job.source?.url) await navigator.clipboard.writeText(job.source.url);
    else if (choice && ['save', 'reveal', 'cancel', 'retry'].includes(choice)) await controller.action('downloads', { action: choice, downloadId: job.downloadId });
  }
  function formatDownloadSize(bytes: number): string { return bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`; }
  function showDownloads(open: boolean, restoreFocus = true): void {
    if (open && nativeBrowserApi() && typeof (window as Window & { rhwpDesktop?: { showContextMenu?: unknown } }).rhwpDesktop?.showContextMenu === 'function') { handle(showNativeDownloads()); return; }
    if (open) { details.open = false; handle(controller.readFrame(true)); handle(controller.request('downloads', { action: 'list' })); }
    downloads.hidden = !open; downloadsButton.setAttribute('aria-expanded', String(open)); layout();
    if (restoreFocus) (open ? downloads.querySelector<HTMLButtonElement>('button') : downloadsButton)?.focus({ preventScroll: true });
  }
  function nativeOverlayOpen(): boolean { return Boolean(details.open || !downloads.hidden); }
  async function capture(): Promise<void> {
    const tab = controller.tab(); if (!tab || capturePending) return;
    const target = { ...tab }; const destination = { ...options.getDestination() };
    if (!destination.threadId) return;
    capturePending = true; nativeError = null; captureMotion.start();
    details.open = false; showDownloads(false, false); paint();
    try {
      await nativePending?.catch(() => undefined);
      if (disposed) return;
      await projectNative();
      const response = await controller.action('capture', { ...controller.identity(target), mode: 'page', destinationThreadId: destination.threadId });
      if (disposed) return;
      const evidence = response.capture as Record<string, unknown> | undefined;
      if (!evidence?.screenshot) {
        const failure = evidence?.screenshotError;
        const message = failure && typeof failure === 'object' && 'message' in failure && typeof failure.message === 'string' ? failure.message : '화면을 캡처하지 못했습니다. 다시 시도해 주세요.';
        throw new Error(message);
      }
      const draft = await saveBrowserCaptureDraft({ destination, tab: target, frame: null, mode: 'page', comment: '', evidence });
      if (!disposed) {
        const destinationElement = options.onCapture(draft);
        captureMotion.finish(destinationElement ?? null);
      }
    } catch (failure) {
      captureMotion.cancel();
      if (!disposed) nativeError = failure instanceof Error ? failure.message : String(failure);
    } finally { capturePending = false; paint(); }
  }
  function point(event: { clientX: number; clientY: number }): { x: number; y: number } | null {
    const frame = controller.frame(); if (!frame) return null;
    const rect = image.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    const x = (event.clientX - rect.left) * frame.width / rect.width;
    const y = (event.clientY - rect.top) * frame.height / rect.height;
    return x < 0 || y < 0 || x > frame.width || y > frame.height ? null : { x, y };
  }
  function sendInput(args: Record<string, unknown>): void {
    const tab = controller.tab();
    if (!tab || !controller.state.connected) return;
    const identity = controller.identity();
    lastInputAt = performance.now();
    inputChain = inputChain.catch(() => undefined).then(() => controller.request('input', { ...identity, ...args })).then(() => {
      // 입력을 마친 화면은 다음 정기 캡처를 기다리지 않고 바로 표시한다.
      if (visible && (args.type !== 'pointer' || args.event === 'up')) handle(controller.readFrame());
    });
    handle(inputChain);
  }
  surface.addEventListener('pointerdown', event => {
    const at = point(event); if (!at) return;
    event.preventDefault(); surface.setPointerCapture(event.pointerId); textInput.focus({ preventScroll: true });
    sendInput({ type: 'pointer', event: 'down', ...at, button: ['left', 'middle', 'right'][event.button] ?? 'left' });
  });
  surface.addEventListener('pointermove', event => {
    const at = point(event); if (at && event.buttons) sendInput({ type: 'pointer', event: 'move', ...at });
  });
  surface.addEventListener('pointerup', event => {
    const at = point(event);
    if (at) sendInput({ type: 'pointer', event: 'up', ...at, button: ['left', 'middle', 'right'][event.button] ?? 'left' });
    if (surface.hasPointerCapture(event.pointerId)) surface.releasePointerCapture(event.pointerId);
  });
  surface.addEventListener('pointercancel', () => sendInput({ type: 'release' }));
  surface.addEventListener('wheel', event => {
    if (!controller.tab()) return;
    event.preventDefault(); sendInput({ type: 'wheel', event: 'move', ...point(event), deltaX: event.deltaX, deltaY: event.deltaY });
  }, { passive: false });
  textInput.addEventListener('compositionstart', () => { composing = true; });
  textInput.addEventListener('compositionend', event => { composing = false; committedComposition = event.data || null; if (event.data) sendInput({ type: 'text', text: event.data }); textInput.value = ''; setTimeout(() => { committedComposition = null; }, 0); });
  textInput.addEventListener('input', (event) => {
    if (composing || (event as InputEvent).isComposing) return;
    const text = (event as InputEvent).data ?? textInput.value;
    if (committedComposition && text === committedComposition) { committedComposition = null; textInput.value = ''; return; }
    if (text) sendInput({ type: 'text', text }); textInput.value = '';
  });
  textInput.addEventListener('keydown', event => {
    if (event.defaultPrevented || composing || event.isComposing || event.key === 'Process' || event.keyCode === 229) return;
    if ((event.metaKey || event.ctrlKey) && ['c', 'v', 'x'].includes(event.key.toLowerCase())) return;
    if (event.key.length > 1 || event.metaKey || event.ctrlKey || event.altKey) {
      event.preventDefault(); sendInput({ type: 'key', event: 'press', key: [...[event.metaKey ? 'Meta' : '', event.ctrlKey ? 'Control' : '', event.altKey ? 'Alt' : '', event.shiftKey ? 'Shift' : ''].filter(Boolean), event.key].join('+') });
    }
  });
  textInput.addEventListener('paste', event => { const text = event.clipboardData?.getData('text/plain'); if (text) { event.preventDefault(); sendInput({ type: 'text', text }); } });
  textInput.addEventListener('copy', event => {
    event.preventDefault(); handle(controller.request('snapshot', controller.identity()).then((result) => {
      const snapshot = result.snapshot as { selectedText?: string } | undefined; if (snapshot?.selectedText) {
        if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(snapshot.selectedText);
        const copied = document.createElement('textarea'); copied.value = snapshot.selectedText; copied.style.position = 'fixed'; copied.style.opacity = '0'; element.ownerDocument.body.append(copied); copied.select(); element.ownerDocument.execCommand('copy'); copied.remove(); textInput.focus({ preventScroll: true });
      }
    }));
  });
  textInput.addEventListener('blur', () => { composing = false; textInput.value = ''; sendInput({ type: 'release' }); });
  element.addEventListener('keydown', event => {
    // 주소 초안 취소는 입력창의 핸들러가 처리한다.
    if (event.defaultPrevented || composing || event.isComposing || (event.key === 'Escape' && event.target === address)) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (details.open) { details.open = false; summary.focus(); } else if (!downloads.hidden) showDownloads(false); else if (presentation.current() === 'float') presentation.hide(); else options.onChat(); }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'l') { event.preventDefault(); event.stopPropagation(); if (presentation.current() === 'float') { presentation.present('dock'); options.onDock(); } address.focus(); address.select(); }
  }, { capture: true });
  function paintDownloads(): void {
    const activeCount = controller.state.downloads.filter(job => job.state === 'downloading').length;
    downloadsButton.dataset.downloading = String(activeCount > 0); downloadsButton.title = activeCount ? `받는 중 ${activeCount}개` : `받은 파일 ${controller.state.downloads.length}개`;
    const signature = JSON.stringify(controller.state.downloads); if (signature === downloadsSignature) return; downloadsSignature = signature;
    downloads.replaceChildren(); const header = document.createElement('header'); header.className = 'ag-browser-popover-header'; const title = document.createElement('strong'); title.textContent = '받은 파일'; header.append(title); const close = button('다운로드 목록 닫기', '', () => showDownloads(false), header); icon(close, 'close'); downloads.append(header);
    if (!controller.state.downloads.length) { const text = document.createElement('p'); text.textContent = '받은 파일이 없습니다.'; downloads.append(text); }
    const labels: Record<BrowserDownload['state'], string> = { downloading: '받는 중', downloaded: '열 수 있음', importing: '프로젝트에 추가 중', imported: '프로젝트에 저장됨', cancelled: '취소됨', interrupted: '연결 끊김', 'import-failed': '프로젝트 추가 실패' };
    for (const job of controller.state.downloads) {
      const row = document.createElement('article'); row.className = 'ag-browser-download'; row.dataset.downloadId = job.downloadId;
      const name = document.createElement('strong'); name.textContent = job.filename;
      const state = document.createElement('span'); state.textContent = `${labels[job.state]}, ${formatDownloadSize(job.size)}, ${job.target.projectId || '일반 받은 파일'}`;
      row.append(name, state);
      if (['downloaded', 'importing', 'imported', 'import-failed'].includes(job.state)) {
        if (nativeBrowserApi()) button('다운로드 폴더에 저장', '저장', () => handle(controller.action('downloads', { action: 'save', downloadId: job.downloadId })), row);
        if (nativeBrowserApi()) button('Finder에서 보기', 'Finder에서 보기', () => handle(controller.action('downloads', { action: 'reveal', downloadId: job.downloadId })), row);
      }
      if ((job.mimeType === 'application/pdf' || /\.(hwp|hwpx|rhwp|rhwpx)$/i.test(job.filename)) && ['downloaded', 'importing', 'imported', 'import-failed'].includes(job.state)) button('문서에서 열기', '문서에서 열기', () => options.onOpenDownload(job), row);
      if (job.state === 'downloading') button('다운로드 취소', '취소', () => handle(controller.action('downloads', { action: 'cancel', downloadId: job.downloadId })), row);
      if (job.state === 'interrupted' || job.state === 'import-failed' || job.state === 'imported' && job.extractionStatus === 'failed') button('다운로드 처리 다시 시도', '다시 시도', () => handle(controller.action('downloads', { action: 'retry', downloadId: job.downloadId })), row);
      if (job.extractionStatus && job.extractionStatus !== 'ready') { const extraction = document.createElement('p'); extraction.textContent = job.extractionStatus === 'failed' ? 'PDF를 열 수 있습니다. 글자 추출에 실패했습니다.' : 'PDF를 열 수 있습니다. 글자를 추출하고 있습니다.'; row.append(extraction); }
      if (job.extractionError) { const extractionError = document.createElement('p'); extractionError.textContent = typeof job.extractionError === 'string' ? job.extractionError : job.extractionError.message ?? '글자를 추출하지 못했습니다.'; row.append(extractionError); }
      if (job.error) { const failed = document.createElement('p'); failed.textContent = typeof job.error === 'string' ? job.error : job.error.message ?? '파일 처리를 완료하지 못했습니다.'; row.append(failed); }
      downloads.append(row);
    }
  }
  async function reconnectBrowser(): Promise<void> {
    if (reconnecting) return;
    cancelNativeHealth(); nativeHealthGeneration++; nativeHealthIdentity = ''; nativeReloadedIdentity = '';
    reconnecting = true; nativeError = null; nativeFailedProjection = ''; paint();
    try {
      await nativePending?.catch(() => undefined);
      await controller.refresh();
      const tab = controller.tab();
      nativeProjection = '';
      if (!tab) return;
      await controller.action(nativeBrowserApi() ? 'reconnect' : 'recover', { ...controller.identity(tab), restore: true });
      nativeProjection = ''; nativeFailedProjection = ''; nativeError = null;
      reconnecting = false;
      await projectNative(); await controller.readFrame();
    } finally { reconnecting = false; paint(); layout(); }
  }
  async function attachNative(placement: Parameters<NonNullable<ReturnType<typeof nativeBrowserApi>>['attach']>[0]): Promise<boolean> {
    const native = nativeBrowserApi()!;
    if (disposed || !nativeSurfaceVisible() || nativeOverlayOpen() || controller.tab()?.tabId !== placement.tabId) return false;
    try { acceptZoom(placement.tabId, await native.attach(placement)); }
    catch (failure) {
      const message = failure instanceof Error ? failure.message : String(failure);
      if (!/Native browser tab is unavailable|presentation (navigation|target) is stale/.test(message)) throw failure;
      if (disposed || !nativeSurfaceVisible() || nativeOverlayOpen() || controller.tab()?.tabId !== placement.tabId) return false;
      await controller.request('reconnect', { tabId: placement.tabId, restore: true });
      if (disposed || !nativeSurfaceVisible() || nativeOverlayOpen() || controller.tab()?.tabId !== placement.tabId) return false;
      acceptZoom(placement.tabId, await native.attach({ ...placement, expectedTargetId: controller.tab()?.nativeTargetId }));
    }
    return true;
  }
  async function checkNativeHealth(placement: Parameters<NonNullable<ReturnType<typeof nativeBrowserApi>>['attach']>[0], sequence: number, timedOut = false): Promise<void> {
    const native = nativeBrowserApi(); if (!native?.getState) return;
    const tab = controller.tab();
    const scope = JSON.stringify([placement.tabId, placement.expectedTargetId]);
    const epoch = tab?.navigationEpoch; const generation = nativeHealthGeneration;
    const presented = () => !disposed && generation === nativeHealthGeneration && nativeSurfaceVisible() && !nativeOverlayOpen() && !nativePopout
      && controller.tab()?.tabId === placement.tabId && controller.tab()?.nativeTargetId === placement.expectedTargetId;
    const current = () => presented() && controller.tab()?.navigationEpoch === epoch;
    if (!current()) return;
    const state = await native.getState({ tabId: placement.tabId, expectedTargetId: placement.expectedTargetId, checkPaint: true }) as Record<string, unknown> | undefined;
    if (!current()) return;
    const health = state?.presentationHealth;
    if (stalled?.tabId === placement.tabId && health !== 'paint-timeout') stalled = null;
    if (health !== 'paint-timeout' && health !== 'failed' && health !== 'loading') stalledEscalation.reset();
    if (health === 'loading' && !timedOut) {
      cancelNativeHealth();
      nativeHealthTimer = setTimeout(() => { nativeHealthTimer = null; if (current()) handle(checkNativeHealth(placement, sequence, true).catch(() => { if (current()) { nativeError = '브라우저 페이지를 다시 열지 못했습니다. 다시 연결해 주세요.'; paint(); } })); }, 15_000);
      return;
    }
    if (!['failed', 'paint-timeout'].includes(String(health)) && !(health === 'loading' && timedOut)) return;
    if (health === 'loading') return;
    if (health === 'paint-timeout' && state?.presentationReloadSafe !== true) {
      // 입력한 내용이나 제출 결과가 있는 페이지는 자동으로 다시 열지 않는다.
      stalled = { tabId: placement.tabId, navigationEpoch: epoch, nativeEpoch: state?.navigationEpoch as number | undefined };
      stalledEscalation.failed(placement.tabId);
      paint(); return;
    }
    if (!native.reload || nativeReloadedIdentity === scope) throw new Error('브라우저 페이지를 다시 열지 못했습니다. 다시 연결해 주세요.');
    nativeReloadedIdentity = scope; cancelNativeHealth();
    nativeRecovering = true; nativeError = null; paint();
    try {
      // 실패한 문서만 한 번 GET으로 연다. 폼 제출이나 이전 입력은 다시 보내지 않는다.
      const recovered = await native.reload({ tabId: placement.tabId, expectedTargetId: placement.expectedTargetId, navigationEpoch: state?.navigationEpoch as number | undefined, recovery: true }) as { restoreRequired?: boolean } | undefined;
      if (recovered?.restoreRequired && presented()) {
        await controller.request('reconnect', { tabId: placement.tabId, restore: true });
        nativeProjection = ''; nativeHealthIdentity = '';
        await controller.refresh();
        return;
      }
      if (!presented()) return;
      await controller.refresh();
      if (disposed || !nativeSurfaceVisible() || nativeOverlayOpen() || controller.tab()?.tabId !== placement.tabId || controller.tab()?.nativeTargetId !== placement.expectedTargetId) return;
      const generationAfterReload = nativeHealthGeneration;
      nativeHealthTimer = setTimeout(() => { nativeHealthTimer = null; if (generationAfterReload === nativeHealthGeneration) handle(checkNativeHealth(placement, nativeSequence, true).catch(() => { if (generationAfterReload === nativeHealthGeneration && controller.tab()?.tabId === placement.tabId) { nativeError = '브라우저 페이지를 다시 열지 못했습니다. 다시 연결해 주세요.'; paint(); } })); }, 15_000);
    } finally { nativeRecovering = false; paint(); layout(); }
  }
  let stalled: { tabId: string; navigationEpoch?: number; nativeEpoch?: number } | null = null;
  const stalledCurrent = () => !!stalled && stalled.tabId === controller.tab()?.tabId && stalled.navigationEpoch === controller.tab()?.navigationEpoch;
  async function reloadStalled(): Promise<void> {
    const native = nativeBrowserApi(); const tab = controller.tab(); const target = stalled;
    stalled = null; paint();
    if (!native?.reload || !tab || target?.tabId !== tab.tabId) return;
    try { await native.reload({ tabId: tab.tabId, expectedTargetId: tab.nativeTargetId, navigationEpoch: target.nativeEpoch, recovery: true }); }
    catch { nativeError = '브라우저 페이지를 다시 열지 못했습니다. 다시 연결해 주세요.'; }
    nativeHealthIdentity = ''; await controller.refresh(); paint(); layout();
  }
  // 페인트 확인이 느려도 크기·위치 갱신은 막지 않는다.
  function observeNativeHealth(placement: Parameters<NonNullable<ReturnType<typeof nativeBrowserApi>>['attach']>[0], sequence: number): void {
    const generation = nativeHealthGeneration; const epoch = controller.tab()?.navigationEpoch;
    handle(checkNativeHealth(placement, sequence).catch(() => {
      if (!disposed && generation === nativeHealthGeneration && controller.tab()?.tabId === placement.tabId && controller.tab()?.navigationEpoch === epoch && nativeSurfaceVisible() && !nativeOverlayOpen()) {
        nativeError = '브라우저 페이지를 다시 열지 못했습니다. 다시 연결해 주세요.'; paint();
      }
    }));
  }
  async function projectNative(): Promise<void> {
    const native = nativeBrowserApi(); if (!native) return;
    if (nativePending || reconnecting || nativePopout) return;
    const tab = controller.tab(); const sequence = ++nativeSequence;
    const target = tab?.tabId;
    if (tab?.tabId === manualSleepingTab) return;
    const useNative = tab && (tab.runtime === 'native' || controller.state.runtime?.kind === 'native');
    if (nativeTab && (!nativeSurfaceVisible() || nativeOverlayOpen() || !useNative || nativeTab !== target)) {
      cancelNativeHealth(); nativeHealthIdentity = ''; nativeHealthGeneration++;
      const previous = nativeTab; nativeTab = null; nativeProjection = '';
      nativePending = native.detach({ tabId: previous }).then(() => false, () => false);
      try { await nativePending; } finally { nativePending = null; layout(); }
    }
    if (disposed || sequence !== nativeSequence || !nativeSurfaceVisible() || nativeOverlayOpen() || !useNative || !target || nativePopout) return;
    const rect = surface.getBoundingClientRect(); if (rect.width < 1 || rect.height < 1) return;
    nativeTab = target;
    const placement = { tabId: target, expectedTargetId: tab.nativeTargetId, bounds: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) }, mode: presentation.current() ?? 'dock', interactive: !previewLocked() };
    const identity = () => JSON.stringify({ tabId: target, runtimeGeneration: controller.tab()?.runtimeGeneration, nativeTargetId: controller.tab()?.nativeTargetId });
    // 보기 > 확대/축소는 CSS 영역을 그대로 두고 창 DIP 배율만 바꾼다 — devicePixelRatio 로 알아채 다시 배치한다.
    const signature = () => JSON.stringify({ ...placement, expectedTargetId: controller.tab()?.nativeTargetId, identity: identity(), zoom: window.devicePixelRatio });
    const healthIdentity = () => JSON.stringify([identity(), controller.tab()?.navigationEpoch]);
    if (nativeFailedProjection === identity()) return;
    if (nativeProjection === signature()) {
      if (nativeHealthIdentity !== healthIdentity()) {
        cancelNativeHealth(); nativeHealthIdentity = healthIdentity();
        observeNativeHealth(placement, sequence);
      }
      return;
    }
    const geometryOnly = !!nativeProjection && nativeHealthIdentity === healthIdentity();
    nativeError = null;
    // 직접 조작을 막 가져왔으면 같은 배치 요청에서 페이지에 키보드 포커스를 준다.
    nativePending = attachNative(focusPage && placement.interactive ? { ...placement, focus: true } : placement);
    if (focusPage && placement.interactive) focusPage = false;
    if (!geometryOnly) paint();
    try {
      const attached = await nativePending;
      if (attached && sequence === nativeSequence && nativeSurfaceVisible() && !nativeOverlayOpen() && controller.tab()?.tabId === target && !nativePopout && nativeHealthIdentity !== healthIdentity()) {
        nativeHealthIdentity = healthIdentity();
        observeNativeHealth({ ...placement, expectedTargetId: controller.tab()?.nativeTargetId }, sequence);
      }
      if (!attached || disposed || sequence !== nativeSequence || !nativeSurfaceVisible() || nativeOverlayOpen() || controller.tab()?.tabId !== target || nativePopout) { await native.detach({ tabId: target }).catch(() => undefined); nativeTab = null; nativeProjection = ''; }
      else { nativeProjection = signature(); nativeFailedProjection = ''; nativeError = null; errorMessage.textContent = controller.state.error ?? ''; error.hidden = !controller.state.error; }
    } catch {
      if (!disposed && nativeSurfaceVisible() && !nativeOverlayOpen() && controller.tab()?.tabId === target && sequence === nativeSequence) { nativeTab = null; nativeProjection = ''; nativeFailedProjection = identity(); nativeError = '브라우저 화면을 연결하지 못했습니다. 다시 연결해 주세요.'; errorMessage.textContent = nativeError; error.hidden = false; }
    } finally { nativePending = null; if (!geometryOnly) paint(); layout(); }
  }
  let layoutFrame: number | null = null;
  const layout = () => {
    if (layoutFrame !== null || disposed) return;
    layoutFrame = requestAnimationFrame(() => {
      layoutFrame = null;
      if (nativeOverlayOpen()) {
        const host = element.getBoundingClientRect(); const bar = toolbar.getBoundingClientRect();
        element.style.setProperty('--browser-popover-top', `${bar.bottom - host.top + 6}px`);
        element.style.setProperty('--browser-popover-height', `${Math.max(80, host.bottom - bar.bottom - 14)}px`);
      }
      void projectNative();
    });
  };
  function nativeSurfaceVisible(): boolean {
    return visible && surface.isConnected && (!document.documentElement.classList.contains('document-home-open') || (agentPreviewTab !== null || previewCloseTimer !== null || holds(controller.tab())) && presentation.current() === 'float')
      && getComputedStyle(surface).visibility === 'visible' && surface.getClientRects().length > 0;
  }
  let nativeSurfaceWasVisible = false;
  // 홈은 레이아웃을 유지한 채 부모만 가리므로 크기 관찰과 별도로 표시 상태를 확인한다.
  const visibilityObserver = new MutationObserver(watchNativeVisibility);
  function watchNativeVisibility(): void {
    visibilityObserver.disconnect();
    if (disposed) return;
    const next = nativeSurfaceVisible();
    if (next !== nativeSurfaceWasVisible) {
      cancelNativeHealth(); nativeHealthGeneration++; nativeHealthIdentity = ''; nativeReloadedIdentity = '';
      nativeSurfaceWasVisible = next; ++nativeSequence; nativeProjection = ''; layout();
    }
    for (let parent: HTMLElement | null = surface; parent; parent = parent.parentElement) {
      visibilityObserver.observe(parent, { attributes: true, attributeFilter: ['class', 'style', 'hidden', 'inert'], childList: true });
    }
    scheduleFrame();
    if (!surface.isConnected) visibilityObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  }
  const resizeObserver = new ResizeObserver(layout); resizeObserver.observe(surface);
  window.addEventListener('scroll', layout, true); window.addEventListener('resize', layout);
  function scheduleFrame(): void {
    if (!visible || disposed || document.hidden || !nativeSurfaceVisible() || nativePopout || controller.usesNativePresentation()) {
      if (frameTimer) clearTimeout(frameTimer); frameTimer = null; return;
    }
    if (frameTimer) return;
    const delay = performance.now() - lastInputAt < 1500 ? 80 : controller.tab()?.status === 'loading' ? 200 : 700;
    frameTimer = setTimeout(() => {
      frameTimer = null;
      handle(controller.readFrame().finally(scheduleFrame));
    }, delay);
  }
  let reportedSidebarTab: string | null = null;
  let reportedSidebarKey = '';
  let sidebarViewQueue: Promise<unknown> = Promise.resolve();
  function reportSidebarView(): void {
    const next = !disposed && visible && presentation.current() === 'dock' ? controller.tab()?.tabId ?? null : null;
    const key = `${controller.state.runtime?.runtimeId ?? ''}:${next ?? ''}`;
    if (key === reportedSidebarKey) return;
    const previous = reportedSidebarTab; reportedSidebarTab = next; reportedSidebarKey = key;
    // 실제 선택이 바뀔 때만 알리고, 늦게 도착한 이전 보기 종료가 새 선택을 지우지 않게 한다.
    sidebarViewQueue = sidebarViewQueue.catch(() => {}).then(async () => {
      if (previous) await options.bridge.requestBrowser('view', { tabId: previous, visible: false }).catch(() => {});
      if (next) await options.bridge.requestBrowser('view', { tabId: next, visible: true });
    }).catch(() => { if (reportedSidebarKey === key) reportedSidebarKey = ''; });
  }
  function paint(): void {
    if (disposed) return;
    const tab = controller.tab(); const connected = controller.state.connected;
    const manuallySleeping = manualSleepingTab === tab?.tabId && tab !== null;
    const frame = manuallySleeping ? null : controller.frame();
    const agentControlled = previewLocked(); const held = holds(tab);
    presentation.setPreviewLock(agentControlled, agentPreviewTab !== null || previewCloseTimer !== null || held);
    element.dataset.agentControlled = String(agentControlled);
    reportSidebarView();
    // 페이지와 도구는 잠그고 조작권 단추만 남긴다.
    for (const child of element.children) if (child !== toolbar) (child as HTMLElement).inert = agentControlled;
    for (const child of toolbar.children) if (child !== controlButton) (child as HTMLElement).inert = agentControlled;
    controlButton.hidden = !tab || agentPreviewTab === null && previewCloseTimer === null && !held;
    controlButton.dataset.held = String(held); controlButton.setAttribute('aria-pressed', String(held));
    controlButton.title = held ? '에이전트에게 돌려주기' : '직접 조작'; controlButton.setAttribute('aria-label', controlButton.title);
    challenge.hidden = !tab?.challenge; continueChallenge.disabled = !connected || controller.state.busy;
    fallbackSearch.hidden = !tab?.challenge?.fallback; fallbackSearch.disabled = !connected || controller.state.busy;
    const chromeSite = options.chromeSignIn?.site() ?? null; const chromeOffer = tab ? chromeOffers.get(tab.tabId) : undefined;
    chromeBar.hidden = !options.chromeSignIn || !chromeSite && !chromeOffer;
    chromeMessage.textContent = chromeSite ? `Chrome에서 ${chromeSite}에 로그인하는 중` : chromeOffer ? new URL(chromeOffer).hostname : '';
    chromeStart.hidden = chromeDismiss.hidden = !!chromeSite; chromeFinish.hidden = chromeCancel.hidden = !chromeSite;
    chromeStart.disabled = !options.chromeSignIn?.available(); chromeStart.title = chromeStart.disabled ? options.chromeSignIn?.unavailableReason() ?? '' : 'Google Chrome으로 로그인';
    menuChrome.disabled = !options.chromeSignIn?.available() || !!chromeSite || !/^https:/.test(tab?.url ?? '');
    menuSleep.textContent = manualSleepingTab === tab?.tabId ? '탭 깨우기' : '탭 잠자기';
    status.textContent = manualSleepingTab === tab?.tabId ? '잠든 탭' : nativeRecovering ? '페이지 다시 여는 중' : reconnecting || nativePending ? '브라우저 연결 중' : !connected ? '연결 끊김' : !tab ? '브라우저 준비' : tab.challenge ? 'Google 확인 필요' : tab.status === 'sleeping' ? '잠든 탭 깨우는 중' : tab.status === 'loading' ? '페이지 여는 중' : '에이전트 브라우저';
    status.title = status.textContent; status.dataset.owner = tab?.controller.owner ?? '';
    const nextTabsSignature = JSON.stringify([controller.state.tabs.map((row) => [row.tabId, row.title, row.url, row.status, row.faviconUrl ?? '']), tab?.tabId]);
    if (tabsSignature !== nextTabsSignature) {
    const focusedTab = tabs.contains(document.activeElement) ? (document.activeElement as HTMLElement)?.dataset.tabId : null;
    tabsSignature = nextTabsSignature; tabs.replaceChildren();
    for (const row of controller.state.tabs) {
      const wrapper = document.createElement('div'); wrapper.className = 'ag-browser-tab';
      const select = button(row.title || row.url || '새 탭', browserTabTitle(row), () => { wakeCurrentTab(); controller.select(row.tabId); }, wrapper);
      const origin = siteOrigin(row.url);
      const mark = origin ? createSiteMark({ origin, faviconUrl: row.faviconUrl, request: options.bridge.requestBrowser.bind(options.bridge), className: 'ag-site-mark-small' }) : null;
      if (mark) { const label = document.createElement('span'); label.className = 'ag-browser-tab-title'; label.textContent = select.textContent; select.replaceChildren(mark, label); }
      select.setAttribute('role', 'tab'); select.setAttribute('aria-selected', String(row.tabId === tab?.tabId)); select.tabIndex = row.tabId === tab?.tabId ? 0 : -1;
      if (options.onFloatTab) installBrowserTabDrag(select, () => element.getBoundingClientRect(), point => options.onFloatTab?.(row.tabId, point));
      select.dataset.tabId = row.tabId; select.dataset.sleeping = String(row.status === 'sleeping'); if (row.status === 'sleeping') select.title += ' (잠자기)'; select.addEventListener('keydown', event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault(); const index = controller.state.tabs.indexOf(row); const length = controller.state.tabs.length;
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + length) % length;
        wakeCurrentTab(); controller.select(controller.state.tabs[next].tabId); tabs.querySelector<HTMLButtonElement>(`[data-tab-id="${CSS.escape(controller.state.tabs[next].tabId)}"]`)?.focus();
      });
      const close = button(`${row.title || '브라우저 탭'} 닫기`, '', () => handle(controller.close(row.tabId)), wrapper); icon(close, 'close'); close.classList.add('ag-browser-tab-close'); close.tabIndex = -1;
      tabs.append(wrapper);
    }
    if (focusedTab) tabs.querySelector<HTMLButtonElement>(`[data-tab-id="${CSS.escape(focusedTab)}"]`)?.focus();
    options.onChange?.();
    }
    const nextAddressOwner = JSON.stringify([controller.state.runtime?.runtimeId, tab?.tabId, tab?.runtimeGeneration, tab?.nativeTargetId]);
    // 같은 탭의 로딩·상태 갱신은 제출하지 않은 주소 초안을 덮어쓰지 않는다.
    if (addressOwner !== nextAddressOwner) { addressOwner = nextAddressOwner; addressDraft = false; address.value = tab?.url ?? ''; }
    else if (!addressDraft && element.ownerDocument.activeElement !== address) address.value = tab?.url ?? '';
    paintZoom();
    menuSleep.disabled = !tab || !connected || controller.state.busy || agentPreviewTab !== null;
    for (const node of [annotate, reload, menuReload, back, forward]) node.disabled = !tab || !connected || controller.state.busy || manuallySleeping;
    annotate.disabled ||= zoomPending;
    popoutButton.disabled = manuallySleeping;
    const reloadLabel = tab?.status === 'loading' ? '페이지 열기 중지' : '새로고침'; reload.setAttribute('aria-label', reloadLabel); reload.title = reloadLabel; icon(reload, tab?.status === 'loading' ? 'browserStop' : 'refresh');
    emptyOpen.disabled = !connected;
    recover.hidden = reconnecting || !!nativePending || !tab || !['crashed', 'disconnected', 'restorable', 'failed'].includes(tab.status); recover.disabled = !connected || controller.state.busy;
    back.disabled ||= tab?.canGoBack === false; forward.disabled ||= tab?.canGoForward === false;
    reconnectButton.disabled = nativeRecovering || reconnecting || !!nativePending; reconnectButton.textContent = reconnecting ? '연결 중…' : '다시 연결';
    const stalledPage = stalledCurrent() && !controller.state.error && !nativeError;
    errorMessage.textContent = controller.state.error ?? nativeError ?? (stalledPage ? '화면을 표시하지 못했습니다.' : ''); error.hidden = !controller.state.error && !nativeError && !stalledPage;
    reconnectButton.hidden = stalledPage; stalledReload.hidden = !stalledPage;
    if (!stalledAutofix || stalledAutofix.phase() === 'idle') {
      if (stalledPage && autofixReady() && stalledEscalation.escalated(tab?.tabId ?? '')) swapSlot(stalledReload, stalledAutofixButton().element);
      else if (stalledAutofix) swapSlot(stalledAutofix.element, stalledReload);
    }
    sleepingHama.hidden = !tab || !!frame || tab.status === 'crashed' || !!nativeProjection && !nativePending && !nativeError && tab.status === 'ready';
    wakeButton.hidden = !manuallySleeping;
    placeholder.hidden = Boolean(tab); image.hidden = !frame;
    if (agentCursor.visible() && (!frame || tab?.tabId !== agentCursorTab)) agentCursor.hide();
    if (frame && frame.frameId !== selectedFrameId) { selectedFrameId = frame.frameId; image.src = `data:${frame.mimeType};base64,${frame.data}`; image.style.aspectRatio = `${frame.width} / ${frame.height}`; }
    if (!frame && selectedFrameId) { selectedFrameId = ''; image.removeAttribute('src'); }
    if (tab && !frame) { placeholder.hidden = false; placeholderTitle.textContent = manuallySleeping ? '탭이 잠들어 있습니다' : tab.status === 'crashed' ? '브라우저가 종료되었습니다' : '로딩중...'; placeholderText.textContent = tab.status === 'crashed' ? '상태를 새로 읽고 페이지를 다시 열어 주세요.' : tab.url; emptyOpen.hidden = true; }
    else if (!tab) { placeholderTitle.textContent = '자료를 찾아보세요'; placeholderText.textContent = '웹사이트를 읽고 받은 PDF를 문서와 보드에서 확인할 수 있습니다.'; emptyOpen.hidden = false; }
    dockButton.hidden = presentation.current() === 'dock'; floatButton.hidden = presentation.current() === 'float';
    popoutButton.hidden = presentation.current() === 'popout';
    annotate.disabled ||= capturePending;
    annotate.setAttribute('aria-busy', String(capturePending));
    paintDownloads(); layout(); scheduleFrame();
  }
  const unsubscribe = controller.subscribe(paint);
  const unsubscribeUpload = options.bridge.onBrowserEvent((event) => {
    if (event.type !== 'owned_browser_file_chooser') return;
    const data = event.payload && typeof event.payload === 'object' ? event.payload as Record<string, unknown> : event;
    uploadTarget = { tabId: data.tabId, navigationEpoch: data.navigationEpoch, controllerEpoch: data.controllerEpoch };
    uploadFiles.multiple = data.multiple === true; uploadFiles.accept = typeof data.accept === 'string' ? data.accept : ''; uploadLabel.textContent = '페이지에서 파일을 요청했습니다.'; upload.hidden = false;
  });
  const unsubscribeNative = nativeBrowserApi()?.onEvent?.((event) => {
    // 사용자 입력 알림은 허브용이다. 화면은 다시 읽지 않는다.
    if (event.type === 'human-input') return;
    if (event.tabId === controller.tab()?.tabId) {
      // 이전 화면의 늦은 정리가 현재 게스트를 숨기면 캐시를 버리고 실제 배치를 복원한다.
      if (event.type === 'presentation' && event.mode === 'hidden' && nativeTab === event.tabId && manualSleepingTab !== event.tabId && nativeSurfaceVisible() && !nativeOverlayOpen()) {
        ++nativeSequence; nativeProjection = ''; nativeFailedProjection = ''; layout();
      }
    }
    if (event.type === 'password-save-mode' && event.tabId === controller.tab()?.tabId) {
      icon(savePassword, 'shield'); delete savePassword.dataset.passwordSave;
      passwordSaveTab = event.enabled === true ? String(event.tabId) : '';
      passwordSaveEpoch = typeof event.navigationEpoch === 'number' ? event.navigationEpoch : undefined;
      savePassword.setAttribute('aria-pressed', String(event.enabled === true));
      savePassword.title = event.enabled === true ? '아이디와 비밀번호를 입력하면 이 기기에 저장합니다' : '이 페이지에서 입력하는 로그인 저장';
      savePassword.setAttribute('aria-label', savePassword.title);
      return;
    }
    if (event.tabId === passwordSaveTab && typeof event.navigationEpoch === 'number' && event.navigationEpoch !== passwordSaveEpoch) {
      passwordSaveTab = ''; savePassword.setAttribute('aria-pressed', 'false'); savePassword.title = '이 페이지에서 입력하는 로그인 저장';
    }
    if (event.type === 'password-save' && event.tabId === passwordSaveTab) {
      icon(savePassword, event.state === 'saved' ? 'check' : 'shield');
      savePassword.dataset.passwordSave = String(event.state);
      savePassword.title = event.state === 'saved' ? '로그인을 이 기기에 저장했습니다' : '로그인을 저장하지 못했습니다. 다시 시도해 주세요.';
      savePassword.setAttribute('aria-label', savePassword.title);
      savePassword.animate([{ opacity: 0.4 }, { opacity: 1 }], { duration: 250 });
      return;
    }
    if (typeof event.zoomFactor === 'number') {
      const target = controller.state.tabs.find(row => row.tabId === event.tabId || row.nativeTargetId === event.tabId);
      if (target) { acceptZoom(target.tabId, event); paint(); }
    }
    if (event.reason === 'zoom') return;
    if (typeof event.tabId === 'string' && 'chromeSignIn' in event) {
      const offer = event.chromeSignIn as { siteUrl?: unknown } | null;
      const had = chromeOffers.get(event.tabId);
      if (offer && typeof offer.siteUrl === 'string') chromeOffers.set(event.tabId, offer.siteUrl); else chromeOffers.delete(event.tabId);
      if (had !== chromeOffers.get(event.tabId)) { paint(); layout(); }
    }
    if (event.type === 'presentation-command' && typeof event.command === 'string' && event.command.startsWith('chrome-sign-in')) {
      // 띄운 창의 Chrome 로그인 띠. 창은 그대로 두고 허브 요청만 보낸다.
      if (event.command === 'chrome-sign-in' && typeof event.url === 'string') startChromeSignIn(event.url);
      else if (event.command === 'chrome-sign-in-finish') void options.chromeSignIn?.finish().catch(() => {});
      else if (event.command === 'chrome-sign-in-cancel') void options.chromeSignIn?.cancel().catch(() => {});
      return;
    }
    if (event.type === 'presentation-command') {
      const target = controller.state.tabs.find((row) => row.tabId === event.tabId || row.nativeTargetId && (row.nativeTargetId === event.tabId || row.nativeTargetId === event.nativeTargetId));
      if (!target) return;
      controller.select(target.tabId);
      if (event.command === 'take-control' || event.command === 'return-agent') { void setControl(target, event.command === 'take-control'); return; }
      if (event.command === 'annotate' || event.command === 'capture') { handle(capture()); return; }
      if (event.command === 'navigate' && typeof event.url === 'string') { handle(navigateAddress(event.url, target)); return; }
      nativePopout = false; presentation.present('dock'); options.onDock();
      if (event.command === 'downloads') showDownloads(true);
      return;
    }
    if (event.type === 'browser-popout-closed' || event.type === 'popout-closed' || nativePopout && event.type === 'presentation' && (event.mode === 'hidden' || event.mode === 'dock')) { nativePopout = false; presentation.present('dock'); options.onDock(); }
    // 배치/이동은 페이지 상태를 바꾸지 않는다. 크기 조절마다 허브를 다시 읽지 않는다.
    if (event.type !== 'presentation' && event.type !== 'bound') handle(controller.refresh());
  });
  document.addEventListener('visibilitychange', scheduleFrame);
  paint();
  return { element, controller,
    descriptors(): WorkbenchResource[] { return controller.state.tabs.map(tab => ({ id: `browser:${tab.tabId}`, title: browserTabTitle(tab), dirty: false, view: 'browser', kind: 'browser', ...(tab.faviconUrl ? { faviconUrl: tab.faviconUrl } : {}) })); },
    activeTab(): string | null { return controller.tab() ? `browser:${controller.tab()!.tabId}` : null; },
    previewAgent(tab: BrowserTab) {
      if (disposed) return;
      cancelPreviewClose();
      const current = controller.tab();
      manualSleepingTab = null; agentPreviewTab = tab.tabId;
      controller.accept({ tab });
      // 사용자가 쥔 탭을 보고 있으면 다른 탭의 에이전트 작업이 화면을 빼앗지 않는다.
      if (visible && current && current.tabId !== tab.tabId && holds(current)) { paint(); return; }
      controller.select(tab.tabId);
      const next = visible && presentation.current() === 'dock' ? 'dock' : 'float';
      if (!visible) agentOpenedView = true;
      nativePopout = false; if (presentation.current() !== next) presentation.present(next);
      handle(controller.readFrame());
    },
    endAgentPreview,
    /** 에이전트의 이동·클릭을 보이는 탭 위에 그린다. 네이티브 게스트 위는 데스크톱 표시 계층이 그린다. */
    agentPointer(pointer: AgentPointer) {
      const tab = controller.tab();
      if (disposed || !visible || !tab || tab.tabId !== pointer.tabId) return;
      if (controller.usesNativePresentation() || nativePopout) {
        const native = nativeBrowserApi();
        if (native?.pointer && (nativeTab === tab.tabId || nativePopout)) {
          const durationMs = matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : pointer.durationMs;
          handle(native.pointer({ tabId: tab.tabId, expectedTargetId: tab.nativeTargetId, x: pointer.x, y: pointer.y, phase: pointer.phase, durationMs }));
        }
        return;
      }
      const frame = controller.frame();
      if (!frame || image.hidden || frame.tabId !== tab.tabId) { agentCursor.hide(); return; }
      const box = surface.getBoundingClientRect(); const rect = image.getBoundingClientRect();
      const at = viewportPointToDisplay(pointer, frame, { left: rect.left - box.left, top: rect.top - box.top, width: rect.width, height: rect.height });
      if (!at) { agentCursor.hide(); return; }
      agentCursorTab = tab.tabId; agentCursor.show(pointer, at);
    },
    suspendShared() {
      const tab = controller.tab(); const mode = presentation.current();
      if (agentPreviewTab || tab?.scope !== 'global' || !mode || mode === 'popout') return null;
      presentation.hide();
      const ready = (async () => { await nativePending?.catch(() => undefined); await projectNative(); })();
      return { tabId: tab.tabId, mode, ready };
    },
    async restoreShared(tabId: string): Promise<boolean> {
      await controller.refresh();
      const tab = controller.state.tabs.find(row => row.tabId === tabId && row.scope === 'global');
      if (disposed || !tab) return false;
      if (nativeBrowserApi()) await controller.request('reconnect', { tabId, restore: true });
      if (disposed) return false;
      controller.select(tabId); return true;
    },
    selectTab(id: string) { wakeCurrentTab(); controller.select(id.slice('browser:'.length)); },
    /** 에이전트가 넘긴 로그인·코드 입력 — 그 탭을 보여 주고 사용자가 제어권을 잡는다. */
    async takeControl(tabId: string): Promise<void> {
      await controller.refresh();
      const tab = controller.state.tabs.find(row => row.tabId === tabId);
      if (disposed || !tab) throw new Error('Browser tab unavailable');
      cancelPreviewClose(); manualSleepingTab = null;
      controller.select(tabId); agentPreviewTab = null;
      if (!holds(tab) && !await setControl(tab, true)) throw new Error(nativeError ?? 'Browser control unavailable');
    },
    closeTab(id: string) { handle(controller.close(id.slice('browser:'.length))); },
    mount(host: HTMLElement) { presentation.mount(host); watchNativeVisibility(); layout(); },
    setVisible(next: boolean) {
      if (nativePopout) return;
      // 턴이 끝난 뒤 남겨 둔 에이전트 미리보기는 사용자가 작업 칸에서 고르면 그 칸으로 옮긴다.
      if (next && previewCloseTimer !== null) { cancelPreviewClose(); agentOpenedView = false; presentation.present('dock'); }
      if (next) { if (presentation.current() !== 'float' && presentation.current() !== 'popout') presentation.present('dock'); handle(controller.refresh().then(() => controller.readFrame())); }
      else if (presentation.current() === 'dock') presentation.hide();
    },
    dock() { nativePopout = false; presentation.present('dock'); address.focus({ preventScroll: true }); },
    float(point?: { x: number; y: number }) { floatCurrentTab(point); handle(controller.refresh().then(() => controller.readFrame())); },
    async releaseTab(tabId: string): Promise<void> { await nativePending?.catch(() => undefined); if (nativeTab === tabId) { nativeTab = null; nativeProjection = ''; await nativeBrowserApi()?.detach({ tabId }); } layout(); },
    dispose() { agentCursor.dispose(); stopAutofixSettings(); stopChromeSignIn?.(); stalledAutofix?.dispose(); cancelPreviewClose(); captureMotion.cancel(); document.removeEventListener('visibilitychange', scheduleFrame); document.removeEventListener('pointerdown', dismissOutside, true); disposed = true; reportSidebarView(); cancelNativeHealth(); if (frameTimer) clearTimeout(frameTimer); if (layoutFrame !== null) cancelAnimationFrame(layoutFrame); resizeObserver.disconnect(); visibilityObserver.disconnect(); window.removeEventListener('scroll', layout, true); window.removeEventListener('resize', layout); unsubscribe(); unsubscribeUpload(); unsubscribeNative?.(); controller.dispose(); if (nativeTab) handle(nativeBrowserApi()!.detach({ tabId: nativeTab })); presentation.dispose(); },
  };
}
export type WorkbenchBrowser = ReturnType<typeof createWorkbenchBrowser>;
