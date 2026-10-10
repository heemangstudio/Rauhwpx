import './workbench-browser.css';
import type { SidebarBridge } from '../../agent/bridge.ts';
import type { BrowserDownload } from '../../agent/types.ts';
import { createBrowserController } from './browser-controller.ts';
import { createBrowserPresentation, nativeBrowserApi, type BrowserPresentationMode } from './browser-presentation.ts';
import { saveBrowserCaptureDraft, type BrowserCaptureDestination, type BrowserCaptureDraft } from './browser-capture-store.ts';
import { createIcon, type SidebarIconName } from './icons.ts';

export function createWorkbenchBrowser(options: {
  bridge: SidebarBridge;
  getDestination(): BrowserCaptureDestination;
  onCapture(draft: BrowserCaptureDraft): void;
  onOpenDownload(job: BrowserDownload): void;
  onDock(): void;
  onChat(): void;
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
  const forward = button('앞으로', '→', () => navigate('forward'), navigation);
  const reload = button('새로고침', '↻', () => navigate(controller.tab()?.status === 'loading' ? 'stop' : 'reload'), navigation);
  const address = document.createElement('input'); address.className = 'ag-browser-address'; address.type = 'text'; address.inputMode = 'url'; address.autocomplete = 'off'; address.spellcheck = false;
  address.setAttribute('aria-label', '브라우저 주소'); address.placeholder = '주소 또는 검색어 입력'; navigation.append(address);
  const go = button('주소 열기', '', () => navigation.requestSubmit(), navigation); icon(go, 'browserForward');
  const newTab = button('새 브라우저 탭', '+', () => handle(controller.open()));
  const status = document.createElement('span'); status.className = 'ag-browser-status'; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const control = button('직접 조작', '직접 조작', () => {
    const tab = controller.tab(); if (!tab) return;
    handle(controller.action('control', { ...controller.identity(), owner: tab.controller.owner === 'human' ? 'agent' : 'human' }).then(() => controller.readFrame()));
  });
  const recover = button('끊긴 브라우저 탭 복구', '탭 복구', () => { handle(controller.action('recover', controller.identity()).then(() => controller.readFrame())); });
  const annotate = button('페이지·개체·영역에 의견 붙이기', '의견 붙이기', () => beginAnnotation());
  const downloadsButton = button('다운로드 목록', '받은 파일', () => { downloads.hidden = !downloads.hidden; downloadsButton.setAttribute('aria-expanded', String(!downloads.hidden)); handle(controller.request('downloads', { action: 'list' })); });
  downloadsButton.setAttribute('aria-expanded', 'false');
  const dockButton = button('작업 칸에 붙이기', '붙이기', () => { presentation.present('dock'); options.onDock(); });
  const floatButton = button('브라우저 띄우기', '띄우기', () => presentation.present('float'));
  const popoutButton = button('별도 창으로 열기', '새 창', () => {
    details.open = false;
    const tab = controller.tab(); const native = nativeBrowserApi();
    if (native && tab && (tab.runtime === 'native' || controller.state.runtime?.kind === 'native')) {
      const rect = surface.getBoundingClientRect();
      handle(native.attach({ tabId: tab.nativeTargetId ?? tab.tabId, bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, mode: 'popout', interactive: tab.controller.owner === 'human' }));
      nativePopout = true; nativeTab = null; nativeProjection = ''; presentation.hide();
    } else presentation.present('popout');
  });
  const closeView = button('브라우저 보기 닫기', '', () => presentation.hide());
  for (const [node, name] of [[back, 'browserBack'], [forward, 'browserForward'], [reload, 'refresh'], [newTab, 'insert'], [control, 'browserHand'], [recover, 'refresh'], [annotate, 'browserCapture'], [downloadsButton, 'browserDownload'], [dockButton, 'browserDock'], [floatButton, 'browserFloat'], [popoutButton, 'external'], [closeView, 'close']] as const) icon(node, name);
  const tabBar = document.createElement('div'); tabBar.className = 'ag-browser-tabbar'; tabBar.append(tabs, newTab, status);
  toolbar.prepend(navigation); element.append(tabBar, toolbar);
  const error = document.createElement('div'); error.className = 'ag-browser-error'; error.setAttribute('role', 'alert'); error.hidden = true;
  const errorMessage = document.createElement('span'); error.append(errorMessage);
  button('상태 다시 읽기', '다시 연결', () => handle(controller.refresh().then(() => controller.readFrame())), error);
  element.append(error);
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
  const surface = document.createElement('div'); surface.className = 'ag-browser-surface'; surface.tabIndex = 0; surface.setAttribute('role', 'application'); surface.setAttribute('aria-label', '브라우저 페이지. 직접 조작을 선택한 뒤 입력하세요.');
  const image = document.createElement('img'); image.className = 'ag-browser-frame'; image.alt = '브라우저 페이지'; image.draggable = false;
  const placeholder = document.createElement('div'); placeholder.className = 'ag-browser-placeholder';
  const placeholderTitle = document.createElement('strong'); placeholderTitle.textContent = '자료를 찾아보세요';
  const placeholderText = document.createElement('p'); placeholderText.textContent = '웹사이트를 읽고 받은 PDF를 문서와 보드에서 확인할 수 있습니다.';
  const emptyOpen = button('연구 브라우저 열기', '브라우저 열기', () => handle(controller.open()), placeholder);
  placeholder.prepend(placeholderTitle, placeholderText);
  const selection = document.createElement('div'); selection.className = 'ag-browser-selection'; selection.hidden = true;
  const textInput = document.createElement('textarea'); textInput.className = 'ag-browser-ime'; textInput.setAttribute('aria-label', '브라우저 페이지에 입력'); textInput.autocomplete = 'off'; textInput.spellcheck = false;
  surface.append(image, placeholder, selection, textInput); element.append(surface);
  const annotation = document.createElement('section'); annotation.className = 'ag-browser-annotation'; annotation.hidden = true; annotation.setAttribute('aria-label', '브라우저 자료 의견');
  const destination = document.createElement('strong'); const annotationHint = document.createElement('p');
  const modes = document.createElement('div'); modes.className = 'ag-browser-annotation-modes';
  const comment = document.createElement('textarea'); comment.placeholder = '이 자료에서 에이전트가 확인할 내용을 적어 주세요'; comment.setAttribute('aria-label', '자료 의견');
  const annotationStatus = document.createElement('span'); annotationStatus.setAttribute('role', 'status');
  let annotationMode: BrowserCaptureDraft['mode'] = 'page';
  let pinned: { destination: BrowserCaptureDestination; tab: NonNullable<ReturnType<typeof controller.tab>>; frame: ReturnType<typeof controller.frame> } | null = null;
  let pickedPoint: { x: number; y: number } | null = null;
  let pickedRect: { x: number; y: number; width: number; height: number } | null = null;
  const modeButtons = new Map<BrowserCaptureDraft['mode'], HTMLButtonElement>();
  for (const [mode, title] of [['page', '페이지'], ['element', '개체 선택'], ['region', '영역 선택']] as const) {
    const choice = button(title, title, () => { annotationMode = mode; pickedPoint = null; pickedRect = null; selection.hidden = true; paintAnnotation(); }, modes);
    modeButtons.set(mode, choice);
  }
  const save = button('의견과 자료를 선택한 채팅에 첨부', '채팅에 첨부', () => { void capture(); }, annotation);
  button('의견 작성 취소', '취소', () => endAnnotation(), annotation);
  annotation.prepend(destination, modes, annotationHint, comment, annotationStatus); element.append(annotation);
  const downloads = document.createElement('section'); downloads.className = 'ag-browser-downloads'; downloads.setAttribute('aria-label', '브라우저 다운로드'); downloads.hidden = true; element.append(downloads);
  const details = document.createElement('details'); details.className = 'ag-browser-details';
  const summary = document.createElement('summary'); summary.setAttribute('aria-label', '브라우저 추가 메뉴'); summary.title = '브라우저 추가 메뉴'; summary.append(createIcon('more'));
  const menu = document.createElement('div'); menu.className = 'ag-browser-menu';
  const inspector = document.createElement('dl');
  popoutButton.classList.remove('ag-browser-icon'); popoutButton.replaceChildren(createIcon('external'), document.createTextNode('별도 창으로 열기')); menu.append(popoutButton);
  button('입력창으로 돌아가기', '채팅으로 돌아가기', () => { details.open = false; options.onChat(); }, menu).prepend(createIcon('message'));
  button('런타임 상태 새로 읽기', '상태 새로 읽기', () => handle(controller.refresh()), menu).prepend(createIcon('refresh'));
  menu.append(inspector); details.append(summary, menu); toolbar.append(details);
  details.addEventListener('toggle', () => { void projectNative(); });
  element.addEventListener('pointerdown', (event) => {
    if (!details.open || details.contains(event.target as Node)) return;
    details.open = false;
    if (surface.contains(event.target as Node)) { event.preventDefault(); event.stopPropagation(); }
  }, { capture: true });
  details.addEventListener('focusout', event => {
    if (event.relatedTarget instanceof Node && !details.contains(event.relatedTarget)) details.open = false;
  });
  let visible = false; let nativeTab: string | null = null; let nativePopout = false;
  let frameTimer: ReturnType<typeof setTimeout> | null = null; let composing = false; let committedComposition: string | null = null; let disposed = false; let selectedFrameId = ''; let nativeSequence = 0;
  let pointerStart: { x: number; y: number } | null = null;
  let tabsSignature = ''; let downloadsSignature = ''; let nativeProjection = ''; let inputChain: Promise<unknown> = Promise.resolve();
  let lastInputAt = -Infinity;
  const presentation = createBrowserPresentation(element, (mode) => {
    visible = mode !== null; paint(); scheduleFrame(); void projectNative();
  }, () => { layout(); });
  function navigate(direction: string): void {
    if (!controller.tab()) return;
    handle(controller.action('navigate', { ...controller.identity(), direction }).then(() => controller.readFrame()));
  }
  navigation.addEventListener('submit', event => {
    event.preventDefault(); const entered = address.value.trim(); if (!entered) return;
    let url = entered;
    if (!/^https?:\/\//i.test(url)) url = /^[\w.-]+\.[a-z]{2,}(?:\/|$)/i.test(url) ? `https://${url}` : `https://www.google.com/search?q=${encodeURIComponent(url)}`;
    if (!controller.tab()) handle(controller.open(url));
    else handle(controller.action('navigate', { ...controller.identity(), url }).then(() => controller.readFrame()));
  });
  function paintAnnotation(): void {
    for (const [mode, choice] of modeButtons) choice.setAttribute('aria-pressed', String(mode === annotationMode));
    annotationHint.textContent = annotationMode === 'page' ? '현재 페이지를 자료로 첨부합니다.' : annotationMode === 'element' ? '페이지에서 확인할 개체를 클릭하세요.' : '페이지에서 확인할 영역을 드래그하세요.';
    surface.classList.toggle('ag-browser-picking', annotationMode !== 'page');
    save.disabled = !pinned || (annotationMode === 'element' && !pickedPoint) || (annotationMode === 'region' && !pickedRect);
  }
  function beginAnnotation(): void {
    const tab = controller.tab(); if (!tab) return;
    pinned = { destination: { ...options.getDestination() }, tab: { ...tab }, frame: controller.frame() };
    destination.textContent = `첨부할 채팅 · ${pinned.destination.label || pinned.destination.threadId}`;
    annotation.hidden = false; annotationStatus.textContent = ''; annotationMode = 'page'; comment.focus(); paintAnnotation(); void projectNative();
    handle(controller.readFrame(true).then(() => { if (pinned && pinned.tab.tabId === tab.tabId && pinned.tab.navigationEpoch === controller.tab()?.navigationEpoch) pinned.frame = controller.frame(); }));
  }
  function endAnnotation(): void { pinned = null; annotation.hidden = true; surface.classList.remove('ag-browser-picking'); selection.hidden = true; pointerStart = null; void projectNative(); surface.focus(); }
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
      options.onCapture(draft); if (pinned === context) { comment.value = ''; endAnnotation(); }
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
  function sendInput(args: Record<string, unknown>): void {
    const tab = controller.tab();
    if (!tab || tab.controller.owner !== 'human' || !controller.state.connected || pinned) return;
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
    if (controller.tab()?.controller.owner !== 'human') return;
    event.preventDefault(); surface.setPointerCapture(event.pointerId); textInput.focus({ preventScroll: true });
    sendInput({ type: 'pointer', event: 'down', ...at, button: ['left', 'middle', 'right'][event.button] ?? 'left' });
  });
  surface.addEventListener('pointermove', event => {
    const at = point(event); if (!at) return;
    if (pointerStart && pinned) {
      pickedRect = { x: Math.min(at.x, pointerStart.x), y: Math.min(at.y, pointerStart.y), width: Math.abs(at.x - pointerStart.x), height: Math.abs(at.y - pointerStart.y) };
      const frame = pinned.frame; const rect = image.getBoundingClientRect(); const host = surface.getBoundingClientRect();
      if (frame) Object.assign(selection.style, { left: `${rect.left - host.left + pickedRect.x * rect.width / frame.width}px`, top: `${rect.top - host.top + pickedRect.y * rect.height / frame.height}px`, width: `${pickedRect.width * rect.width / frame.width}px`, height: `${pickedRect.height * rect.height / frame.height}px` });
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
    if (controller.tab()?.controller.owner !== 'human' || pinned) return;
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
    if (event.defaultPrevented || composing || event.isComposing) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (details.open) { details.open = false; summary.focus(); } else if (pinned) endAnnotation(); else options.onChat(); }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'l') { event.preventDefault(); event.stopPropagation(); address.focus(); address.select(); }
  }, { capture: true });
  function paintDownloads(): void {
    const signature = JSON.stringify(controller.state.downloads); if (signature === downloadsSignature) return; downloadsSignature = signature;
    downloads.replaceChildren(); const title = document.createElement('h3'); title.textContent = '받은 파일'; downloads.append(title);
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
  async function projectNative(): Promise<void> {
    const native = nativeBrowserApi(); if (!native) return;
    const tab = controller.tab(); const sequence = ++nativeSequence;
    const target = tab?.nativeTargetId ?? tab?.tabId;
    const useNative = tab && (tab.runtime === 'native' || controller.state.runtime?.kind === 'native');
    if (nativeTab && (!visible || pinned || details.open || !useNative || nativeTab !== target)) { const previous = nativeTab; nativeTab = null; nativeProjection = ''; await native.detach({ tabId: previous }).catch(() => undefined); }
    if (disposed || sequence !== nativeSequence || !visible || pinned || details.open || !useNative || !target || nativePopout) return;
    const rect = surface.getBoundingClientRect(); if (rect.width < 1 || rect.height < 1) return;
    nativeTab = target;
    const placement = { tabId: target, bounds: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) }, mode: presentation.current() ?? 'dock', interactive: tab.controller.owner === 'human' };
    const signature = JSON.stringify(placement); if (nativeProjection === signature) return; nativeProjection = signature;
    try { await native.attach(placement); }
    catch (failure) { if (sequence === nativeSequence) { nativeTab = null; nativeProjection = ''; errorMessage.textContent = failure instanceof Error ? failure.message : String(failure); error.hidden = false; } }
  }
  let layoutFrame: number | null = null;
  const layout = () => {
    if (layoutFrame !== null || disposed) return;
    layoutFrame = requestAnimationFrame(() => { layoutFrame = null; void projectNative(); });
  };
  const resizeObserver = new ResizeObserver(layout); resizeObserver.observe(surface);
  window.addEventListener('scroll', layout, true); window.addEventListener('resize', layout);
  function scheduleFrame(): void {
    if (!visible || disposed || nativePopout || controller.usesNativePresentation() || pinned) {
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
    status.textContent = !connected ? '연결 끊김' : !tab ? '브라우저 준비' : tab.status === 'loading' ? '페이지 여는 중' : tab.controller.owner === 'human' ? '직접 조작 중' : '에이전트 조작 중';
    status.title = tab?.controller.owner === 'human' ? '직접 조작 중 · 에이전트는 페이지를 읽을 수 있습니다.' : status.textContent; status.dataset.owner = tab?.controller.owner ?? '';
    const nextTabsSignature = JSON.stringify([controller.state.tabs.map((row) => [row.tabId, row.title]), tab?.tabId]);
    if (tabsSignature !== nextTabsSignature) {
    const focusedTab = tabs.contains(document.activeElement) ? (document.activeElement as HTMLElement)?.dataset.tabId : null;
    tabsSignature = nextTabsSignature; tabs.replaceChildren();
    for (const row of controller.state.tabs) {
      const wrapper = document.createElement('div'); wrapper.className = 'ag-browser-tab';
      const select = button(row.title || row.url || '새 탭', row.title || '새 탭', () => controller.select(row.tabId), wrapper);
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
    }
    if (element.ownerDocument.activeElement !== address) address.value = tab?.url ?? '';
    for (const node of [control, annotate, reload, back, forward]) node.disabled = !tab || !connected || controller.state.busy;
    const controlLabel = tab?.controller.owner === 'human' ? '에이전트에게 넘기기' : '직접 조작';
    control.setAttribute('aria-label', controlLabel); control.title = controlLabel; control.setAttribute('aria-pressed', String(tab?.controller.owner === 'human')); icon(control, tab?.controller.owner === 'human' ? 'bot' : 'browserHand');
    const reloadLabel = tab?.status === 'loading' ? '페이지 열기 중지' : '새로고침'; reload.setAttribute('aria-label', reloadLabel); reload.title = reloadLabel; icon(reload, tab?.status === 'loading' ? 'browserStop' : 'refresh');
    newTab.disabled = !connected; emptyOpen.disabled = !connected;
    recover.hidden = !tab || !['crashed', 'disconnected', 'restorable', 'failed'].includes(tab.status); recover.disabled = !connected || controller.state.busy;
    back.disabled ||= tab?.canGoBack === false; forward.disabled ||= tab?.canGoForward === false;
    errorMessage.textContent = controller.state.error ?? ''; error.hidden = !controller.state.error;
    placeholder.hidden = Boolean(tab); image.hidden = !frame;
    if (frame && frame.frameId !== selectedFrameId) { selectedFrameId = frame.frameId; image.src = `data:${frame.mimeType};base64,${frame.data}`; image.style.aspectRatio = `${frame.width} / ${frame.height}`; }
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
    if (event.type === 'presentation-command') {
      const target = controller.state.tabs.find((row) => row.tabId === event.tabId || row.nativeTargetId && (row.nativeTargetId === event.tabId || row.nativeTargetId === event.nativeTargetId));
      if (!target) return;
      controller.select(target.tabId);
      if (event.command === 'take-control' || event.command === 'return-agent') { handle(controller.action('control', { ...controller.identity(target), owner: event.command === 'take-control' ? 'human' : 'agent' })); return; }
      nativePopout = false; presentation.present('dock'); options.onDock();
      if (event.command === 'annotate' || event.command === 'capture') beginAnnotation();
      if (event.command === 'downloads') { downloads.hidden = false; downloadsButton.setAttribute('aria-expanded', 'true'); handle(controller.request('downloads', { action: 'list' })); }
      return;
    }
    if (event.type === 'browser-popout-closed' || event.type === 'popout-closed' || nativePopout && event.type === 'presentation' && (event.mode === 'hidden' || event.mode === 'dock')) { nativePopout = false; presentation.present('dock'); options.onDock(); }
    // 배치/이동은 페이지 상태를 바꾸지 않는다. 크기 조절마다 허브를 다시 읽지 않는다.
    if (event.type !== 'presentation' && event.type !== 'bound') handle(controller.refresh());
  });
  paint();
  return { element, controller,
    mount(host: HTMLElement) { presentation.mount(host); },
    setVisible(next: boolean) {
      if (next) { if (presentation.current() !== 'float' && presentation.current() !== 'popout') presentation.present('dock'); handle(controller.refresh().then(() => controller.readFrame())); }
      else if (presentation.current() === 'dock') presentation.hide();
    },
    float() { nativePopout = false; presentation.present('float'); handle(controller.refresh().then(() => controller.readFrame())); },
    dispose() { disposed = true; if (frameTimer) clearTimeout(frameTimer); if (layoutFrame !== null) cancelAnimationFrame(layoutFrame); resizeObserver.disconnect(); window.removeEventListener('scroll', layout, true); window.removeEventListener('resize', layout); unsubscribe(); unsubscribeUpload(); unsubscribeNative?.(); controller.dispose(); if (nativeTab) handle(nativeBrowserApi()!.detach({ tabId: nativeTab })); presentation.dispose(); },
  };
}
export type WorkbenchBrowser = ReturnType<typeof createWorkbenchBrowser>;
