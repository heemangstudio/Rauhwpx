import './document-region-capture.css';
import type { WasmBridge } from '../core/wasm-bridge.ts';
import type { CanvasView } from '../view/canvas-view.ts';
import type { EventBus } from '../core/event-bus.ts';
import { buildInlineElementSelection, bindInlineSelectionIdentity, type InlinePromptItem } from './inline-prompt-context.ts';
import { saveSelectionCapture, type DocumentCaptureDraft } from './agent-context-store.ts';
import { documentCaptureSize, intersectCaptureRects, planDocumentRegion, type CapturePage, type CaptureRect } from './document-region-context.ts';

interface CaptureOptions {
  wasm: WasmBridge;
  canvasView: CanvasView;
  eventBus: EventBus;
  getIdentity(): { documentId: string | null; revision: number };
  getDocumentName(): string;
  onCapture(draft: DocumentCaptureDraft): void;
}
type RegionPlan = NonNullable<ReturnType<typeof planDocumentRegion>>;

/** 문서 페이지와 겹친 영역만 PNG로 만든다. 한 번에 한 페이지 캔버스만 유지한다. */
export async function renderDocumentRegion(wasm: Pick<WasmBridge, 'renderPageToCanvas'>, plan: RegionPlan, pixelRatio = window.devicePixelRatio): Promise<File> {
  if (plan.parts.length > 10) throw new Error('캡처할 페이지가 많습니다. 영역을 줄여 주세요.');
  const size = documentCaptureSize(plan.rect, pixelRatio);
  const output = document.createElement('canvas');
  output.width = size.width; output.height = size.height;
  const context = output.getContext('2d');
  if (!context) throw new Error('캡처 이미지를 만들지 못했습니다.');
  context.fillStyle = '#ffffff'; context.fillRect(0, 0, size.width, size.height);
  try {
    for (const part of plan.parts) {
      const page = part.pageRegion;
      const cssZoom = part.rect.width / page.width;
      const sourceSize = documentCaptureSize({ x: 0, y: 0, width: page.pageWidth, height: page.pageHeight }, size.scale * cssZoom);
      const source = document.createElement('canvas');
      try {
        wasm.renderPageToCanvas(page.pageIndex, source, sourceSize.scale);
        if (!source.width || !source.height || source.width * source.height > 16_000_000 || source.width > 8192 || source.height > 8192) throw new Error('캡처할 페이지가 너무 큽니다.');
        const sx = source.width / page.pageWidth; const sy = source.height / page.pageHeight;
        context.drawImage(source, page.x * sx, page.y * sy, page.width * sx, page.height * sy,
          (part.rect.x - plan.rect.x) * size.scale, (part.rect.y - plan.rect.y) * size.scale,
          part.rect.width * size.scale, part.rect.height * size.scale);
      } finally { source.width = 0; source.height = 0; }
    }
    const blob = await new Promise<Blob | null>((resolve) => output.toBlob(resolve, 'image/png'));
    if (!blob || blob.size > 16 * 1024 * 1024) throw new Error('캡처 이미지가 너무 큽니다. 영역을 줄여 주세요.');
    return new File([blob], `document-region-${crypto.randomUUID()}.png`, { type: 'image/png' });
  } finally { output.width = 0; output.height = 0; }
}

function regionTexts(wasm: WasmBridge, plan: RegionPlan) {
  const texts: Array<{ pageIndex: number; sectionIdx: number; paraIdx: number; text: string }> = [];
  let remaining = 4000;
  for (const { pageRegion: region } of plan.parts) {
    let lines;
    try { lines = wasm.getPageLineLayout(region.pageIndex).lines; } catch { continue; }
    for (const line of lines) {
      if (remaining <= 0) return texts;
      if (line.area || line.sec === undefined || line.para === undefined || line.cs === undefined || line.ce === undefined
        || !intersectCaptureRects(region, { x: line.x, y: line.y, width: line.w, height: line.h })) continue;
      const runs = line.runs.filter(([x, width]) => x < region.x + region.width && x + width > region.x);
      if (!runs.length) continue;
      const from = Math.max(line.cs, Math.min(...runs.map((run) => run[2])));
      const to = Math.min(line.ce, Math.max(...runs.map((run) => run[3])));
      try {
        const text = line.cell
          ? wasm.getTextInCellByPath(line.sec, line.cell.pp, JSON.stringify(line.cell.path.map(([controlIdx, cellIdx, cellParaIdx]) => ({ controlIdx, cellIdx, cellParaIdx }))), from, Math.min(to - from, remaining))
          : wasm.getTextRange(line.sec, line.para, from, Math.min(to - from, remaining));
        if (text) { texts.push({ pageIndex: region.pageIndex, sectionIdx: line.sec, paraIdx: line.cell?.pp ?? line.para, text }); remaining -= text.length; }
      } catch { /* PNG와 페이지 좌표는 텍스트 추출이 어려운 요소도 보존한다. */ }
    }
  }
  return texts;
}

export function createDocumentRegionCapture(options: CaptureOptions) {
  const layer = document.createElement('div');
  layer.className = 'ag-region-capture'; layer.hidden = true;
  const hint = document.createElement('div'); hint.className = 'ag-region-hint'; hint.textContent = '문서에서 영역을 드래그하세요 · Esc 취소';
  const selection = document.createElement('div'); selection.className = 'ag-region-selection'; selection.hidden = true;
  const box = document.createElement('div'); box.className = 'ag-region-comment'; box.hidden = true;
  box.setAttribute('role', 'dialog'); box.setAttribute('aria-label', '스크린샷 메모');
  const preview = document.createElement('img'); preview.className = 'ag-region-preview'; preview.alt = '선택한 문서 영역';
  const input = document.createElement('textarea'); input.className = 'ag-region-input'; input.placeholder = '이 영역에 대한 의견을 적어 주세요'; input.maxLength = 4000; input.setAttribute('aria-label', '스크린샷 의견');
  const footer = document.createElement('div'); footer.className = 'ag-region-footer';
  const error = document.createElement('span'); error.className = 'ag-region-error'; error.setAttribute('role', 'status');
  const cancelButton = document.createElement('button'); cancelButton.type = 'button'; cancelButton.textContent = '취소';
  const saveButton = document.createElement('button'); saveButton.type = 'button'; saveButton.className = 'ag-region-save'; saveButton.textContent = '저장';
  footer.append(cancelButton, saveButton); box.append(preview, input, error, footer); layer.append(hint, selection, box); document.body.append(layer);
  let start: { x: number; y: number } | null = null;
  let viewport: CaptureRect | null = null;
  let pages: CapturePage[] = [];
  let plan: RegionPlan | null = null;
  let identity = options.getIdentity();
  let captureFile: File | null = null;
  let texts: ReturnType<typeof regionTexts> = [];
  let imageUrl: string | null = null;
  let sequence = 0;
  let saving = false;
  let previousFocus: HTMLElement | null = null;
  const unsubs: Array<() => void> = [];

  function cancel() {
    sequence++; start = null; plan = null; captureFile = null; pages = []; texts = [];
    layer.hidden = true; box.hidden = true; selection.hidden = true;
    if (imageUrl) URL.revokeObjectURL(imageUrl); imageUrl = null;
    preview.removeAttribute('src'); input.value = ''; error.textContent = '';
    if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true }); previousFocus = null;
  }
  function sameDocument() { const current = options.getIdentity(); return current.documentId === identity.documentId && current.revision === identity.revision; }
  function startCapture() {
    if (saving) return;
    cancel();
    const container = document.getElementById('scroll-container'); const content = document.getElementById('scroll-content');
    identity = options.getIdentity();
    if (!container || !content || !identity.documentId || options.wasm.pageCount === 0) return;
    const bounds = container.getBoundingClientRect(); const contentBounds = content.getBoundingClientRect();
    viewport = intersectCaptureRects({ x: bounds.left, y: bounds.top, width: container.clientWidth, height: container.clientHeight }, { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight });
    if (!viewport) return;
    const vs = options.canvasView.getVirtualScroll();
    for (let pageIndex = 0; pageIndex < options.wasm.pageCount; pageIndex++) {
      const rect = { x: contentBounds.left + vs.getPageLeftResolved(pageIndex, content.clientWidth), y: contentBounds.top + vs.getPageOffset(pageIndex), width: vs.getPageWidth(pageIndex), height: vs.getPageHeight(pageIndex) };
      if (!intersectCaptureRects(rect, viewport)) continue;
      const page = options.wasm.getPageInfo(pageIndex);
      pages.push({ pageIndex, pageWidth: page.width, pageHeight: page.height, rect });
    }
    if (!pages.length) return;
    Object.assign(layer.style, { left: `${viewport.x}px`, top: `${viewport.y}px`, width: `${viewport.width}px`, height: `${viewport.height}px` });
    previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    layer.hidden = false; hint.textContent = '문서에서 영역을 드래그하세요 · Esc 취소';
  }
  function updateSelection(end: { x: number; y: number }) {
    if (!start || !viewport) return;
    plan = planDocumentRegion(start, end, viewport, pages);
    selection.hidden = !plan;
    if (plan) Object.assign(selection.style, { left: `${plan.rect.x - viewport.x}px`, top: `${plan.rect.y - viewport.y}px`, width: `${plan.rect.width}px`, height: `${plan.rect.height}px` });
  }
  layer.addEventListener('pointerdown', (event) => {
    if (box.contains(event.target as Node) || !viewport || !box.hidden || saving || event.button !== 0) return;
    event.preventDefault(); event.stopPropagation();
    if (!pages.some((page) => event.clientX >= page.rect.x && event.clientX <= page.rect.x + page.rect.width && event.clientY >= page.rect.y && event.clientY <= page.rect.y + page.rect.height)) return;
    start = { x: event.clientX, y: event.clientY }; layer.setPointerCapture(event.pointerId); updateSelection(start);
  });
  layer.addEventListener('pointermove', (event) => { if (start) { event.preventDefault(); updateSelection({ x: event.clientX, y: event.clientY }); } });
  layer.addEventListener('pointerup', (event) => {
    if (!start || !viewport) return;
    event.preventDefault(); updateSelection({ x: event.clientX, y: event.clientY }); start = null;
    if (layer.hasPointerCapture(event.pointerId)) layer.releasePointerCapture(event.pointerId);
    if (!plan || plan.rect.width < 4 || plan.rect.height < 4) { selection.hidden = true; plan = null; return; }
    // native capturePage는 정수 CSS 좌표를 받으므로 안쪽 픽셀 경계에 맞춘다.
    plan = planDocumentRegion({ x: Math.ceil(plan.rect.x), y: Math.ceil(plan.rect.y) },
      { x: Math.floor(plan.rect.x + plan.rect.width), y: Math.floor(plan.rect.y + plan.rect.height) }, viewport, pages);
    if (!plan) return;
    const selected = plan; const seq = ++sequence;
    hint.textContent = '캡처를 만드는 중…';
    const capture = async () => {
      const nativeCapture = (globalThis as { rhwpDesktop?: { captureDocumentRegion?(rect: CaptureRect): Promise<{ bytes: Uint8Array }> } }).rhwpDesktop?.captureDocumentRegion;
      if (!nativeCapture) return renderDocumentRegion(options.wasm, selected);
      layer.style.visibility = 'hidden';
      try {
        await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
        if (seq !== sequence || !sameDocument()) throw new Error('캡처가 취소되었습니다.');
        const result = await nativeCapture(selected.rect);
        if (seq !== sequence || !sameDocument()) throw new Error('캡처가 취소되었습니다.');
        return new File([new Uint8Array(result.bytes)], `document-region-${crypto.randomUUID()}.png`, { type: 'image/png' });
      } finally { layer.style.visibility = ''; }
    };
    void capture().then((file) => {
      if (seq !== sequence || !sameDocument() || !viewport) return;
      captureFile = file; texts = regionTexts(options.wasm, selected);
      imageUrl = URL.createObjectURL(file); preview.src = imageUrl;
      box.hidden = false; hint.textContent = '메모를 저장하면 채팅 입력창에 첨부됩니다';
      box.style.left = `${Math.max(8, Math.min(selected.rect.x - viewport.x, viewport.width - 328))}px`;
      box.style.top = `${Math.max(8, Math.min(selected.rect.y - viewport.y + selected.rect.height + 8, viewport.height - 320))}px`;
      input.focus({ preventScroll: true });
    }).catch((caught) => {
      if (seq !== sequence) return;
      hint.textContent = caught instanceof Error ? caught.message : '캡처하지 못했습니다. 다시 선택해 주세요.';
    });
  });
  layer.addEventListener('pointercancel', () => { start = null; selection.hidden = true; });
  cancelButton.addEventListener('click', cancel);
  async function save() {
    if (!plan || !captureFile || saving) return;
    if (!sameDocument()) { error.textContent = '문서가 바뀌었습니다. 영역을 다시 선택해 주세요.'; return; }
    saving = true; saveButton.disabled = true; cancelButton.disabled = true; input.disabled = true;
    const seq = sequence;
    try {
      const item: InlinePromptItem = { kind: 'screenshot', captureId: '', comment: input.value.trim(), pageRegions: plan.parts.map((part) => part.pageRegion), attachmentName: captureFile.name, recordAttachmentName: 'capture-record.json', elementTexts: texts };
      const captured = bindInlineSelectionIdentity(buildInlineElementSelection([item], [captureFile]), identity);
      const draft = await saveSelectionCapture(captured, input.value.trim(), options.getDocumentName());
      if (seq === sequence && sameDocument()) { options.onCapture(draft); cancel(); }
    } catch (caught) { if (seq === sequence) error.textContent = caught instanceof Error ? caught.message : '저장하지 못했습니다.'; }
    finally { saving = false; saveButton.disabled = false; cancelButton.disabled = false; input.disabled = false; }
  }
  saveButton.addEventListener('click', () => { void save(); });
  const onKey = (event: KeyboardEvent) => {
    if (layer.hidden) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); if (!saving) cancel(); }
    else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); event.stopImmediatePropagation(); void save(); }
  };
  document.addEventListener('keydown', onKey, true);
  for (const name of ['document-loaded', 'document-closed', 'document-changed', 'zoom-changed', 'viewport-scroll', 'viewport-resize', 'page-layout-changed']) {
    unsubs.push(options.eventBus.on(name, () => { if (!layer.hidden && !saving) cancel(); }));
  }
  return { startCapture, cancel, dispose() { cancel(); document.removeEventListener('keydown', onKey, true); for (const off of unsubs) off(); layer.remove(); } };
}
