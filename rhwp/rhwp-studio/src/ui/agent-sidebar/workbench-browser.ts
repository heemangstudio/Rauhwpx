import './workbench-browser.css';
import type { SidebarBridge } from '../../agent/bridge.ts';
import type { BrowserDownload, BrowserTab } from '../../agent/types.ts';
import { createBrowserController } from './browser-controller.ts';
import { createBrowserPresentation, nativeBrowserApi, type BrowserPresentationMode } from './browser-presentation.ts';
import { saveBrowserCaptureDraft, type BrowserCaptureDestination, type BrowserCaptureDraft } from './browser-capture-store.ts';
import { createIcon, type SidebarIconName } from './icons.ts';
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
  onCapture(draft: BrowserCaptureDraft): void;
  onOpenDownload(job: BrowserDownload): void;
  onDock(): void;
  onChat(): void;
  onChange?(): void;
}) {
  const controller = createBrowserController(options.bridge, { nativePresentation: Boolean(nativeBrowserApi()) });
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
  const zoom = document.createElement('div'); zoom.className = 'ag-browser-zoom'; zoom.setAttribute('role', 'group'); zoom.setAttribute('aria-label', '페이지 확대·축소'); navigation.append(zoom);
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
    if (!native?.zoom || !tab || !controller.usesNativePresentation() || zoomPending || pinned) return;
    zoomPending = true; nativeError = null; paint();
    handle(native.zoom({ tabId: tab.tabId, factor }).then(result => acceptZoom(tab.tabId, result)).catch(() => { nativeError = '페이지 배율을 변경하지 못했습니다.'; }).finally(() => { zoomPending = false; paint(); }));
  }
  function paintZoom(): void {
    for (const tabId of tabZoom.keys()) if (!controller.state.tabs.some(tab => tab.tabId === tabId)) tabZoom.delete(tabId);
    const tab = controller.tab(); const factor = tabZoom.get(tab?.tabId ?? '') ?? 1;
    zoomReset.textContent = `${Math.round(factor * 100)}%`;
    const unavailable = !nativeBrowserApi()?.zoom || !tab || !controller.state.connected || !controller.usesNativePresentation() || zoomPending || Boolean(pinned);
    zoomReset.disabled = unavailable; zoomOut.disabled = unavailable || factor <= .25; zoomIn.disabled = unavailable || factor >= 3;
  }
  const status = document.createElement('span'); status.className = 'ag-browser-status'; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const recover = button('끊긴 브라우저 탭 복구', '탭 복구', () => { handle(reconnectBrowser()); });
  const annotate = button('페이지·개체·영역에 의견 붙이기', '의견 붙이기', () => beginAnnotation());
  const downloadsButton = button('다운로드 목록', '받은 파일', () => showDownloads(Boolean(downloads.hidden)));
  downloadsButton.setAttribute('aria-expanded', 'false');
  const dockButton = button('작업 칸에 붙이기', '붙이기', () => { presentation.present('dock'); options.onDock(); });
  const floatButton = button('브라우저 띄우기', '띄우기', () => presentation.present('float'));
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
  toolbar.prepend(navigation); toolbar.append(status); element.append(tabBar, toolbar);
  const error = document.createElement('div'); error.className = 'ag-browser-error'; error.setAttribute('role', 'alert'); error.hidden = true;
  const errorMessage = document.createElement('span'); error.append(errorMessage);
  const reconnectButton = button('브라우저 다시 연결', '다시 연결', () => { handle(reconnectBrowser()); }, error);
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
  const placeholderTitle = document.createElement('strong'); placeholderTitle.textContent = '자료를 찾아보세요';
  const placeholderText = document.createElement('p'); placeholderText.textContent = '웹사이트를 읽고 받은 PDF를 문서와 보드에서 확인할 수 있습니다.';
  const emptyOpen = button('연구 브라우저 열기', '브라우저 열기', () => handle(controller.open()), placeholder);
  placeholder.prepend(placeholderTitle, placeholderText);
  const selection = document.createElement('div'); selection.className = 'ag-browser-selection'; selection.hidden = true;
  const textInput = document.createElement('textarea'); textInput.className = 'ag-browser-ime'; textInput.setAttribute('aria-label', '브라우저 페이지에 입력'); textInput.autocomplete = 'off'; textInput.spellcheck = false;
  surface.append(image, placeholder, selection, textInput); element.append(surface);
  const annotation = document.createElement('section'); annotation.className = 'ag-browser-annotation'; annotation.hidden = true; annotation.setAttribute('aria-label', '브라우저 자료 의견'); annotation.setAttribute('role', 'dialog'); annotate.setAttribute('aria-haspopup', 'dialog'); annotate.setAttribute('aria-expanded', 'false');
  const destination = document.createElement('strong'); const annotationHint = document.createElement('p');
  const modes = document.createElement('div'); modes.className = 'ag-browser-annotation-modes';
  const comment = document.createElement('textarea'); comment.placeholder = '이 자료에서 에이전트가 확인할 내용을 적어 주세요'; comment.setAttribute('aria-label', '자료 의견');
  const annotationStatus = document.createElement('span'); annotationStatus.setAttribute('role', 'status');
  let annotationMode: BrowserCaptureDraft['mode'] = 'page';
  type AnnotationContext = { runtimeId: string | undefined; destination: BrowserCaptureDestination; tab: NonNullable<ReturnType<typeof controller.tab>>; frame: ReturnType<typeof controller.frame> };
  let pinned: AnnotationContext | null = null;
  let annotationDraft: { context: AnnotationContext; mode: BrowserCaptureDraft['mode']; comment: string; point: typeof pickedPoint; rect: typeof pickedRect } | null = null;
  let pickedPoint: { x: number; y: number } | null = null;
  let pickedRect: { x: number; y: number; width: number; height: number } | null = null;
  const modeButtons = new Map<BrowserCaptureDraft['mode'], HTMLButtonElement>();
  for (const [mode, title] of [['page', '페이지'], ['element', '개체 선택'], ['region', '영역 선택']] as const) {
    const choice = button(title, title, () => { annotationMode = mode; pickedPoint = null; pickedRect = null; selection.hidden = true; paintAnnotation(); }, modes);
    modeButtons.set(mode, choice);
  }
  const annotationHeader = document.createElement('header'); annotationHeader.className = 'ag-browser-popover-header';
  const annotationTitle = document.createElement('strong'); annotationTitle.textContent = '채팅에 첨부'; annotationHeader.append(annotationTitle);
  const annotationClose = button('의견 작성 닫기', '', () => endAnnotation(), annotationHeader); icon(annotationClose, 'close');
  const annotationActions = document.createElement('div'); annotationActions.className = 'ag-browser-annotation-actions';
  const save = button('의견과 자료를 선택한 채팅에 첨부', '채팅에 첨부', () => { void capture(); }, annotationActions);
  annotation.append(annotationHeader, destination, modes, annotationHint, comment, annotationStatus, annotationActions); element.append(annotation);
  const downloads = document.createElement('section'); downloads.className = 'ag-browser-downloads'; downloads.setAttribute('aria-label', '브라우저 다운로드'); downloads.setAttribute('role', 'dialog'); downloadsButton.setAttribute('aria-haspopup', 'dialog'); downloads.hidden = true; element.append(downloads);
  const details = document.createElement('details'); details.className = 'ag-browser-details';
  const summary = document.createElement('summary'); summary.setAttribute('aria-label', '브라우저 추가 메뉴'); summary.title = '브라우저 추가 메뉴'; summary.append(createIcon('more'));
  const menu = document.createElement('div'); menu.className = 'ag-browser-menu';
  const inspector = document.createElement('dl');
  popoutButton.classList.remove('ag-browser-icon'); popoutButton.replaceChildren(createIcon('external'), document.createTextNode('별도 창으로 열기')); menu.append(popoutButton);
  button('입력창으로 돌아가기', '채팅으로 돌아가기', () => { details.open = false; options.onChat(); }, menu).prepend(createIcon('message'));
  button('런타임 상태 새로 읽기', '상태 새로 읽기', () => handle(controller.refresh()), menu).prepend(createIcon('refresh'));
  menu.append(inspector); details.append(summary, menu); toolbar.append(details);
  details.addEventListener('toggle', () => { if (details.open) { endAnnotation(false); showDownloads(false, false); } layout(); });
  function dismissOutside(event: PointerEvent): void {
    const target = event.target as Node;
    let dismissed = false;
    if (details.open && !details.contains(target)) { details.open = false; dismissed = true; }
    if (!downloads.hidden && !downloads.contains(target) && !downloadsButton.contains(target)) { showDownloads(false, false); dismissed = true; }
    if (pinned && !annotation.contains(target) && !annotate.contains(target)) {
      // 개체와 영역을 고를 때는 팝오버 밖의 페이지를 계속 사용할 수 있다.
      if (annotationMode !== 'page' && surface.contains(target)) return;
      endAnnotation(false); dismissed = true;
    }
    if (dismissed && surface.contains(target)) { event.preventDefault(); event.stopPropagation(); }
  }
  element.addEventListener('pointerdown', dismissOutside, { capture: true });
  document.addEventListener('pointerdown', dismissOutside, { capture: true });
  details.addEventListener('focusout', event => {
    if (event.relatedTarget instanceof Node && !details.contains(event.relatedTarget)) details.open = false;
  });
  let visible = false; let nativeTab: string | null = null; let nativePopout = false;
  let frameTimer: ReturnType<typeof setTimeout> | null = null; let composing = false; let committedComposition: string | null = null; let disposed = false; let selectedFrameId = ''; let nativeSequence = 0;
  let pointerStart: { x: number; y: number } | null = null;
  let reconnecting = false;
  let tabsSignature = ''; let downloadsSignature = ''; let nativeProjection = ''; let nativeFailedProjection = ''; let nativeError: string | null = null; let nativePending: Promise<boolean> | null = null; let inputChain: Promise<unknown> = Promise.resolve();
  let lastInputAt = -Infinity;
  const presentation = createBrowserPresentation(element, (mode) => {
    if (mode === 'float' || mode === null) { details.open = false; endAnnotation(false); showDownloads(false, false); }
    visible = mode !== null; watchNativeVisibility(); paint(); scheduleFrame(); void projectNative();
  }, () => { layout(); }, options.onDock, navigation);
  function navigate(direction: string): void {
    if (!controller.tab()) return;
    handle(controller.action('navigate', { ...controller.identity(), direction }).then(() => controller.readFrame()));
  }
  navigation.addEventListener('submit', event => {
    event.preventDefault(); const entered = address.value.trim(); if (!entered) return;
    addressDraft = false; address.blur();
    let url = entered;
    if (!/^https?:\/\//i.test(url)) url = /^[\w.-]+\.[a-z]{2,}(?:\/|$)/i.test(url) ? `https://${url}` : `https://www.google.com/search?q=${encodeURIComponent(url)}`;
    if (!controller.tab()) handle(controller.open(url));
    else handle(controller.action('navigate', { ...controller.identity(), url }).then(() => controller.readFrame()));
  });
  address.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    event.preventDefault(); event.stopPropagation(); addressDraft = false; address.value = controller.tab()?.url ?? ''; address.blur();
  });
  function paintAnnotation(): void {
    paintZoom();
    for (const [mode, choice] of modeButtons) choice.setAttribute('aria-pressed', String(mode === annotationMode));
    annotationHint.textContent = annotationMode === 'page' ? '현재 페이지를 자료로 첨부합니다.' : annotationMode === 'element' ? '페이지에서 확인할 개체를 클릭하세요.' : '페이지에서 확인할 영역을 드래그하세요.';
    surface.classList.toggle('ag-browser-picking', annotationMode !== 'page');
    paintSelection();
    save.disabled = !pinned || (annotationMode === 'element' && !pickedPoint) || (annotationMode === 'region' && !pickedRect);
  }
  function beginAnnotation(): void {
    if (zoomPending) return;
    if (pinned) { endAnnotation(); return; }
    const tab = controller.tab(); if (!tab) return;
    details.open = false; showDownloads(false, false);
    const target = { ...options.getDestination() };
    const resume = annotationDraft && annotationDraft.context.runtimeId === controller.state.runtime?.runtimeId && annotationDraft.context.tab.tabId === tab.tabId && annotationDraft.context.tab.navigationEpoch === tab.navigationEpoch && annotationDraft.context.tab.runtimeGeneration === tab.runtimeGeneration && annotationDraft.context.tab.nativeTargetId === tab.nativeTargetId && annotationDraft.context.tab.controllerEpoch === tab.controllerEpoch && annotationDraft.context.destination.threadId === target.threadId && annotationDraft.context.destination.projectId === target.projectId && annotationDraft.context.destination.documentId === target.documentId ? annotationDraft : null;
    pinned = resume?.context ?? { runtimeId: controller.state.runtime?.runtimeId, destination: target, tab: { ...tab }, frame: controller.frame() };
    annotationMode = resume?.mode ?? 'page'; comment.value = resume?.comment ?? ''; pickedPoint = resume?.point ?? null; pickedRect = resume?.rect ?? null;
    destination.textContent = pinned.destination.label || pinned.destination.threadId;
    annotation.hidden = false; annotate.setAttribute('aria-expanded', 'true'); annotationStatus.textContent = ''; comment.focus(); paintAnnotation(); layout();
    if (!resume) handle(controller.readFrame(true).then(() => { if (pinned && pinned.tab.tabId === tab.tabId && pinned.tab.navigationEpoch === controller.tab()?.navigationEpoch) { pinned.frame = controller.frame(); paint(); } }));
  }
  function endAnnotation(restoreFocus = true): void {
    if (!pinned) return;
    annotationDraft = { context: pinned, mode: annotationMode, comment: comment.value, point: pickedPoint, rect: pickedRect };
    pinned = null; annotation.hidden = true; annotate.setAttribute('aria-expanded', 'false'); surface.classList.remove('ag-browser-picking'); selection.hidden = true; pointerStart = null; layout();
    paintZoom();
    if (restoreFocus) annotate.focus({ preventScroll: true });
  }
  function showDownloads(open: boolean, restoreFocus = true): void {
    if (open) { details.open = false; endAnnotation(false); handle(controller.readFrame(true)); handle(controller.request('downloads', { action: 'list' })); }
    downloads.hidden = !open; downloadsButton.setAttribute('aria-expanded', String(open)); layout();
    if (restoreFocus) (open ? downloads.querySelector<HTMLButtonElement>('button') : downloadsButton)?.focus({ preventScroll: true });
  }
  function nativeOverlayOpen(): boolean { return Boolean(pinned || details.open || !downloads.hidden); }
  async function capture(): Promise<void> {
    const context = pinned; if (!context) return;
    const captureRequest = { mode: annotationMode, comment: comment.value, point: pickedPoint ? { ...pickedPoint } : null, rect: pickedRect ? { ...pickedRect } : null };
    save.disabled = true; annotationStatus.textContent = '자료를 저장하고 있습니다…';
    try {
      const response = await controller.action('capture', { ...controller.identity(context.tab), mode: captureRequest.mode, point: captureRequest.point, rect: captureRequest.rect,
        comment: captureRequest.comment, frameId: context.frame?.frameId, destinationThreadId: context.destination.threadId });
      const evidence = response.capture && typeof response.capture === 'object' ? response.capture as Record<string, unknown> : response;
      const screenshotError = evidence.screenshotError as { message?: string } | undefined;
      const draft = await saveBrowserCaptureDraft({ destination: context.destination, tab: context.tab, frame: context.frame,
        mode: captureRequest.mode, comment: captureRequest.comment, evidence, screenshotError: screenshotError?.message });
      options.onCapture(draft); if (pinned === context) { comment.value = ''; endAnnotation(); annotationDraft = null; }
    } catch (failure) {
      if (pinned !== context) return;
      annotationStatus.textContent = failure instanceof Error ? failure.message : String(failure);
      // 탐색이 바뀌어도 의견은 남겨 다시 캡처할 수 있다.
      paintAnnotation();
    }
  }
  function point(event: { clientX: number; clientY: number }): { x: number; y: number } | null {
    const frame = pinned?.frame ?? controller.frame(); if (!frame) return null;
    const rect = image.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    const x = (event.clientX - rect.left) * frame.width / rect.width;
    const y = (event.clientY - rect.top) * frame.height / rect.height;
    return x < 0 || y < 0 || x > frame.width || y > frame.height ? null : { x, y };
  }
  function paintSelection(): void {
    selection.hidden = !pinned || annotationMode !== 'region' || !pickedRect;
    if (selection.hidden || !pickedRect || !pinned?.frame) return;
    const frame = pinned.frame; const rect = image.getBoundingClientRect(); const host = surface.getBoundingClientRect();
    Object.assign(selection.style, { left: `${rect.left - host.left + pickedRect.x * rect.width / frame.width}px`, top: `${rect.top - host.top + pickedRect.y * rect.height / frame.height}px`, width: `${pickedRect.width * rect.width / frame.width}px`, height: `${pickedRect.height * rect.height / frame.height}px` });
  }
  function sendInput(args: Record<string, unknown>): void {
    const tab = controller.tab();
    if (!tab || !controller.state.connected || pinned) return;
    const identity = controller.identity();
    lastInputAt = performance.now();
    inputChain = inputChain.catch(() => undefined).then(() => controller.request('input', { ...identity, ...args })).then(() => {
      // 입력을 마친 화면은 다음 정기 캡처를 기다리지 않고 바로 표시한다.
      if (visible && !pinned && (args.type !== 'pointer' || args.event === 'up')) handle(controller.readFrame());
    });
    handle(inputChain);
  }
  surface.addEventListener('pointerdown', event => {
    const at = point(event); if (!at) return;
    if (pinned) {
      if (annotationMode === 'element') { pickedPoint = at; pickedRect = null; paintAnnotation(); }
      if (annotationMode === 'region') { pointerStart = at; surface.setPointerCapture(event.pointerId); selection.hidden = false; }
      event.preventDefault(); return;
    }
    event.preventDefault(); surface.setPointerCapture(event.pointerId); textInput.focus({ preventScroll: true });
    sendInput({ type: 'pointer', event: 'down', ...at, button: ['left', 'middle', 'right'][event.button] ?? 'left' });
  });
  surface.addEventListener('pointermove', event => {
    const at = point(event); if (!at) return;
    if (pointerStart && pinned) {
      pickedRect = { x: Math.min(at.x, pointerStart.x), y: Math.min(at.y, pointerStart.y), width: Math.abs(at.x - pointerStart.x), height: Math.abs(at.y - pointerStart.y) };
      paintSelection();
    }
    else if (!pinned && event.buttons) sendInput({ type: 'pointer', event: 'move', ...at });
  });
  surface.addEventListener('pointerup', event => {
    const at = point(event);
    if (pointerStart) { pointerStart = null; paintAnnotation(); }
    else if (at && !pinned) sendInput({ type: 'pointer', event: 'up', ...at, button: ['left', 'middle', 'right'][event.button] ?? 'left' });
    if (surface.hasPointerCapture(event.pointerId)) surface.releasePointerCapture(event.pointerId);
  });
  surface.addEventListener('pointercancel', () => { pointerStart = null; sendInput({ type: 'release' }); });
  surface.addEventListener('wheel', event => {
    if (!controller.tab() || pinned) return;
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
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (details.open) { details.open = false; summary.focus(); } else if (pinned) endAnnotation(); else if (!downloads.hidden) showDownloads(false); else if (presentation.current() === 'float') presentation.hide(); else options.onChat(); }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'l') { event.preventDefault(); event.stopPropagation(); if (presentation.current() === 'float') { presentation.present('dock'); options.onDock(); } address.focus(); address.select(); }
  }, { capture: true });
  function paintDownloads(): void {
    const signature = JSON.stringify(controller.state.downloads); if (signature === downloadsSignature) return; downloadsSignature = signature;
    downloads.replaceChildren(); const header = document.createElement('header'); header.className = 'ag-browser-popover-header'; const title = document.createElement('strong'); title.textContent = '받은 파일'; header.append(title); const close = button('다운로드 목록 닫기', '', () => showDownloads(false), header); icon(close, 'close'); downloads.append(header);
    if (!controller.state.downloads.length) { const text = document.createElement('p'); text.textContent = '받은 파일이 없습니다.'; downloads.append(text); }
    const labels: Record<BrowserDownload['state'], string> = { downloading: '받는 중', downloaded: '열 수 있음', importing: '프로젝트에 추가 중', imported: '프로젝트에 저장됨', cancelled: '취소됨', interrupted: '연결 끊김', 'import-failed': '프로젝트 추가 실패' };
    for (const job of controller.state.downloads) {
      const row = document.createElement('article'); row.className = 'ag-browser-download'; row.dataset.downloadId = job.downloadId;
      const name = document.createElement('strong'); name.textContent = job.filename;
      const state = document.createElement('span'); state.textContent = `${labels[job.state]} · ${(job.size / 1024).toFixed(0)} KB · ${job.target.projectId || '일반 받은 파일'}`;
      row.append(name, state);
      if (['downloaded', 'importing', 'imported', 'import-failed'].includes(job.state)) button('문서에서 열기', '문서에서 열기', () => options.onOpenDownload(job), row);
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
    const tab = controller.tab(); if (!tab) { await controller.refresh(); return; }
    reconnecting = true; nativeError = null; nativeFailedProjection = ''; paint();
    try {
      await nativePending?.catch(() => undefined);
      await controller.refresh();
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
      await controller.request('reconnect', { tabId: placement.tabId });
      if (disposed || !nativeSurfaceVisible() || nativeOverlayOpen() || controller.tab()?.tabId !== placement.tabId) return false;
      acceptZoom(placement.tabId, await native.attach({ ...placement, expectedTargetId: controller.tab()?.nativeTargetId, interactive: true }));
    }
    return true;
  }
  async function projectNative(): Promise<void> {
    const native = nativeBrowserApi(); if (!native) return;
    if (nativePending || reconnecting) return;
    const tab = controller.tab(); const sequence = ++nativeSequence;
    const target = tab?.tabId;
    const useNative = tab && (tab.runtime === 'native' || controller.state.runtime?.kind === 'native');
    if (nativeTab && (!nativeSurfaceVisible() || nativeOverlayOpen() || !useNative || nativeTab !== target)) {
      const previous = nativeTab; nativeTab = null; nativeProjection = '';
      nativePending = native.detach({ tabId: previous }).then(() => false, () => false);
      try { await nativePending; } finally { nativePending = null; layout(); }
    }
    if (disposed || sequence !== nativeSequence || !nativeSurfaceVisible() || nativeOverlayOpen() || !useNative || !target || nativePopout) return;
    const rect = surface.getBoundingClientRect(); if (rect.width < 1 || rect.height < 1) return;
    nativeTab = target;
    const placement = { tabId: target, expectedTargetId: tab.nativeTargetId, bounds: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) }, mode: presentation.current() ?? 'dock', interactive: true };
    const identity = () => JSON.stringify({ tabId: target, runtimeGeneration: controller.tab()?.runtimeGeneration, nativeTargetId: controller.tab()?.nativeTargetId });
    const signature = () => JSON.stringify({ ...placement, expectedTargetId: controller.tab()?.nativeTargetId, identity: identity() });
    if (nativeProjection === signature() || nativeFailedProjection === identity()) return;
    nativeError = null;
    nativePending = attachNative(placement);
    paint();
    try {
      const attached = await nativePending;
      if (!attached || disposed || sequence !== nativeSequence || !nativeSurfaceVisible() || nativeOverlayOpen() || controller.tab()?.tabId !== target || nativePopout) { await native.detach({ tabId: target }).catch(() => undefined); nativeTab = null; nativeProjection = ''; }
      else { nativeProjection = signature(); nativeFailedProjection = ''; nativeError = null; errorMessage.textContent = controller.state.error ?? ''; error.hidden = !controller.state.error; }
    } catch {
      if (!disposed && nativeSurfaceVisible() && controller.tab()?.tabId === target && sequence === nativeSequence) { nativeTab = null; nativeProjection = ''; nativeFailedProjection = identity(); nativeError = '브라우저 화면을 연결하지 못했습니다. 다시 연결해 주세요.'; errorMessage.textContent = nativeError; error.hidden = false; }
    } finally { nativePending = null; paint(); layout(); }
  }
  let layoutFrame: number | null = null;
  const layout = () => {
    if (layoutFrame !== null || disposed) return;
    layoutFrame = requestAnimationFrame(() => { layoutFrame = null; const host = element.getBoundingClientRect(); const bar = toolbar.getBoundingClientRect(); paintSelection(); element.style.setProperty('--browser-popover-top', `${bar.bottom - host.top + 6}px`); element.style.setProperty('--browser-popover-height', `${Math.max(80, host.bottom - bar.bottom - 14)}px`); void projectNative(); });
  };
  function nativeSurfaceVisible(): boolean {
    return visible && surface.isConnected && !document.documentElement.classList.contains('document-home-open')
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
    if (!visible || disposed || document.hidden || !nativeSurfaceVisible() || nativePopout || controller.usesNativePresentation() || pinned) {
      if (frameTimer) clearTimeout(frameTimer); frameTimer = null; return;
    }
    if (frameTimer) return;
    const delay = performance.now() - lastInputAt < 1500 ? 80 : controller.tab()?.status === 'loading' ? 200 : 700;
    frameTimer = setTimeout(() => {
      frameTimer = null;
      handle(controller.readFrame().finally(scheduleFrame));
    }, delay);
  }
  function paint(): void {
    if (disposed) return;
    const tab = controller.tab(); const frame = pinned?.frame ?? controller.frame(); const connected = controller.state.connected;
    challenge.hidden = !tab?.challenge; continueChallenge.disabled = !connected || controller.state.busy;
    fallbackSearch.hidden = !tab?.challenge?.fallback; fallbackSearch.disabled = !connected || controller.state.busy;
    status.textContent = reconnecting || nativePending ? '브라우저 연결 중' : !connected ? '연결 끊김' : !tab ? '브라우저 준비' : tab.challenge ? 'Google 확인 필요' : tab.status === 'loading' ? '페이지 여는 중' : '에이전트 브라우저';
    status.title = status.textContent; status.dataset.owner = tab?.controller.owner ?? '';
    const nextTabsSignature = JSON.stringify([controller.state.tabs.map((row) => [row.tabId, row.title, row.url]), tab?.tabId]);
    if (tabsSignature !== nextTabsSignature) {
    const focusedTab = tabs.contains(document.activeElement) ? (document.activeElement as HTMLElement)?.dataset.tabId : null;
    tabsSignature = nextTabsSignature; tabs.replaceChildren();
    for (const row of controller.state.tabs) {
      const wrapper = document.createElement('div'); wrapper.className = 'ag-browser-tab';
      const select = button(row.title || row.url || '새 탭', browserTabTitle(row), () => controller.select(row.tabId), wrapper);
      select.setAttribute('role', 'tab'); select.setAttribute('aria-selected', String(row.tabId === tab?.tabId)); select.tabIndex = row.tabId === tab?.tabId ? 0 : -1;
      select.dataset.tabId = row.tabId; select.addEventListener('keydown', event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault(); const index = controller.state.tabs.indexOf(row); const length = controller.state.tabs.length;
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + length) % length;
        controller.select(controller.state.tabs[next].tabId); tabs.querySelector<HTMLButtonElement>(`[data-tab-id="${CSS.escape(controller.state.tabs[next].tabId)}"]`)?.focus();
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
    for (const node of [annotate, reload, back, forward]) node.disabled = !tab || !connected || controller.state.busy;
    annotate.disabled ||= zoomPending;
    const reloadLabel = tab?.status === 'loading' ? '페이지 열기 중지' : '새로고침'; reload.setAttribute('aria-label', reloadLabel); reload.title = reloadLabel; icon(reload, tab?.status === 'loading' ? 'browserStop' : 'refresh');
    emptyOpen.disabled = !connected;
    recover.hidden = reconnecting || !!nativePending || !tab || !['crashed', 'disconnected', 'restorable', 'failed'].includes(tab.status); recover.disabled = !connected || controller.state.busy;
    back.disabled ||= tab?.canGoBack === false; forward.disabled ||= tab?.canGoForward === false;
    reconnectButton.disabled = reconnecting || !!nativePending; reconnectButton.textContent = reconnecting ? '연결 중…' : '다시 연결';
    errorMessage.textContent = controller.state.error ?? nativeError ?? ''; error.hidden = !controller.state.error && !nativeError;
    placeholder.hidden = Boolean(tab); image.hidden = !frame;
    if (frame && frame.frameId !== selectedFrameId) { selectedFrameId = frame.frameId; image.src = `data:${frame.mimeType};base64,${frame.data}`; image.style.aspectRatio = `${frame.width} / ${frame.height}`; }
    if (!frame && selectedFrameId) { selectedFrameId = ''; image.removeAttribute('src'); }
    if (tab && !frame) { placeholder.hidden = false; placeholderTitle.textContent = tab.status === 'crashed' ? '브라우저가 종료되었습니다' : '페이지 화면을 기다리는 중'; placeholderText.textContent = tab.status === 'crashed' ? '상태를 새로 읽고 페이지를 다시 열어 주세요.' : tab.url; emptyOpen.hidden = true; }
    else if (!tab) { placeholderTitle.textContent = '자료를 찾아보세요'; placeholderText.textContent = '웹사이트를 읽고 받은 PDF를 문서와 보드에서 확인할 수 있습니다.'; emptyOpen.hidden = false; }
    dockButton.hidden = presentation.current() === 'dock'; floatButton.hidden = presentation.current() === 'float';
    popoutButton.hidden = presentation.current() === 'popout';
    inspector.replaceChildren();
    for (const [label, value] of [['런타임', controller.state.runtime ? `${controller.state.runtime.kind} · ${controller.state.runtime.state} · 세대 ${controller.state.runtime.generation}` : '아직 시작하지 않음'], ['탭', tab?.tabId ?? '없음'], ['소유 채팅', tab?.threadId ?? '일반 브라우저'], ['프로젝트', tab?.projectId ?? '일반 받은 파일'], ['마지막 작업', tab?.lastAction ?? '없음'], ['탐색 / 조작 세대', tab ? `${tab.navigationEpoch} / ${tab.controllerEpoch}` : '없음']]) {
      const key = document.createElement('dt'); key.textContent = label; const content = document.createElement('dd'); content.textContent = value; inspector.append(key, content);
    }
    paintDownloads(); layout(); scheduleFrame();
  }
  const unsubscribe = controller.subscribe(paint);
  const unsubscribeUpload = options.bridge.onBrowserEvent((event) => {
    if (event.type !== 'owned_browser_file_chooser') return;
    const data = event.payload && typeof event.payload === 'object' ? event.payload as Record<string, unknown> : event;
    uploadTarget = { tabId: data.tabId, navigationEpoch: data.navigationEpoch, controllerEpoch: data.controllerEpoch };
    uploadFiles.multiple = data.multiple === true; uploadLabel.textContent = '페이지에서 파일을 요청했습니다.'; upload.hidden = false;
  });
  const unsubscribeNative = nativeBrowserApi()?.onEvent?.((event) => {
    if (typeof event.zoomFactor === 'number') {
      const target = controller.state.tabs.find(row => row.tabId === event.tabId || row.nativeTargetId === event.tabId);
      if (target) { acceptZoom(target.tabId, event); paint(); }
    }
    if (event.reason === 'zoom') return;
    if (event.type === 'presentation-command') {
      const target = controller.state.tabs.find((row) => row.tabId === event.tabId || row.nativeTargetId && (row.nativeTargetId === event.tabId || row.nativeTargetId === event.nativeTargetId));
      if (!target) return;
      controller.select(target.tabId);
      if (event.command === 'take-control' || event.command === 'return-agent') { handle(controller.action('control', { ...controller.identity(target), owner: event.command === 'take-control' ? 'human' : 'agent' })); return; }
      nativePopout = false; presentation.present('dock'); options.onDock();
      if (event.command === 'annotate' || event.command === 'capture') beginAnnotation();
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
    descriptors(): WorkbenchResource[] { return controller.state.tabs.map(tab => ({ id: `browser:${tab.tabId}`, title: browserTabTitle(tab), dirty: false, view: 'browser', kind: 'browser' })); },
    activeTab(): string | null { return controller.tab() ? `browser:${controller.tab()!.tabId}` : null; },
    selectTab(id: string) { controller.select(id.slice('browser:'.length)); },
    closeTab(id: string) { handle(controller.close(id.slice('browser:'.length))); },
    mount(host: HTMLElement) { presentation.mount(host); watchNativeVisibility(); layout(); },
    setVisible(next: boolean) {
      if (next) { if (presentation.current() !== 'float' && presentation.current() !== 'popout') presentation.present('dock'); handle(controller.refresh().then(() => controller.readFrame())); }
      else if (presentation.current() === 'dock') presentation.hide();
    },
    float() { nativePopout = false; presentation.present('float'); handle(controller.refresh().then(() => controller.readFrame())); },
    dispose() { document.removeEventListener('visibilitychange', scheduleFrame); document.removeEventListener('pointerdown', dismissOutside, true); disposed = true; if (frameTimer) clearTimeout(frameTimer); if (layoutFrame !== null) cancelAnimationFrame(layoutFrame); resizeObserver.disconnect(); visibilityObserver.disconnect(); window.removeEventListener('scroll', layout, true); window.removeEventListener('resize', layout); unsubscribe(); unsubscribeUpload(); unsubscribeNative?.(); controller.dispose(); if (nativeTab) handle(nativeBrowserApi()!.detach({ tabId: nativeTab })); presentation.dispose(); },
  };
}
export type WorkbenchBrowser = ReturnType<typeof createWorkbenchBrowser>;
