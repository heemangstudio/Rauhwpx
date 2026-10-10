/**
 * 대화상자 편집 이력 시나리오 (브라우저 쪽).
 *
 * dialog-edit-history.browser.test.ts 가 Vite 로 띄운 페이지에서 이 모듈을 불러 쓴다.
 * 실제 WasmBridge·CommandHistory·InputHandler 프로토타입 위에 캐럿 그리기만 비운 편집
 * 호스트를 만들고, 대화상자는 실제 명령(CommandDispatcher)으로 연다. 사용자가 하듯
 * 대화상자 DOM 의 값을 바꾸고 확인을 누른 뒤, 실제 handleUndo/handleRedo 가 문서를
 * 정확히 되살리는지 문서 지문으로 확인한다.
 */
import { WasmBridge } from '@/core/wasm-bridge';
import { EventBus } from '@/core/event-bus';
import { CommandHistory } from '@/engine/history';
import { InputHandler } from '@/engine/input-handler';
import { CursorState } from '@/engine/cursor';
import { ImeSession } from '@/engine/ime-session';
import { TextMutationEffectAccumulator } from '@/engine/command';
import { CommandRegistry } from '@/command/registry';
import { CommandDispatcher } from '@/command/dispatcher';
import type { CommandServices, EditorContext } from '@/command/types';
import { editCommands } from '@/command/commands/edit';
import { insertCommands } from '@/command/commands/insert';
import { formatCommands } from '@/command/commands/format';
import { tableCommands } from '@/command/commands/table';
import { pageCommands } from '@/command/commands/page';
import { fileCommands } from '@/command/commands/file';

/** 편집 한 번을 재고 undo/redo 한 결과. 지문은 SHA-256 hex. */
export interface StepResult {
  before: string;
  after: string;
  undone: string;
  redone: string;
  /** 편집이 남긴 undo 항목 수 */
  entries: number;
}

type AnyHost = any;

// 엔진·이벤트 버스·서비스는 페이지 전체에서 하나다. 명령 모듈이 대화상자를 모듈 수준
// 싱글턴으로 캐시하므로 처음 받은 services 가 끝까지 쓰인다. 문서와 호스트만 매번 새로 만든다.
const wasm = new WasmBridge();
const eventBus = new EventBus();
const liveListeners = new Map<string, number>();
{
  // 구독 해제 누락을 셀 수 있게 이벤트별 살아 있는 구독 수를 센다.
  const on = eventBus.on.bind(eventBus);
  eventBus.on = (event: string, handler: (...args: unknown[]) => void) => {
    liveListeners.set(event, (liveListeners.get(event) ?? 0) + 1);
    const off = on(event, handler);
    let active = true;
    return () => {
      if (active) {
        active = false;
        liveListeners.set(event, (liveListeners.get(event) ?? 1) - 1);
      }
      off();
    };
  };
}

let host: AnyHost = null;
let formMode = false;

function context(): EditorContext {
  const pos = host?.getCursorPosition?.() ?? {};
  return {
    hasDocument: true,
    hasSelection: Boolean(host?.hasSelection?.()),
    hasCopiedFormat: false,
    inTable: pos.parentParaIndex !== undefined && !pos.isTextBox,
    inCellSelectionMode: Boolean(host?.isInCellSelectionMode?.()),
    hasMultiCellSelection: Boolean(host?.hasMultiCellSelection?.()),
    hasTableTransposeClipboard: false,
    inTableObjectSelection: Boolean(host?.isInTableObjectSelection?.()),
    inPictureObjectSelection: Boolean(host?.isInPictureObjectSelection?.()),
    canArrangeSelectedObject: false,
    canGroupSelectedObjects: false,
    canUngroupSelectedObject: false,
    inField: false,
    isEditable: true,
    editMode: formMode ? 'form' : 'normal',
    isFormMode: formMode,
    canEditFormField: false,
    canUndo: false,
    canRedo: false,
    zoom: 1,
    showControlCodes: false,
    showParagraphMarks: false,
    isDirty: false,
  };
}

const services: CommandServices = {
  wasm,
  eventBus,
  documentState: { isDirty: () => false, markDirty() {}, markClean() {} } as never,
  getContext: context,
  getInputHandler: () => host,
  getViewportManager: () => null,
  setEditMode() {},
};

const registry = new CommandRegistry();
registry.registerAll([
  ...editCommands, ...insertCommands, ...formatCommands, ...tableCommands, ...pageCommands, ...fileCommands,
]);
const dispatcher = new CommandDispatcher(registry, services, eventBus);

// 확인·입력 창은 시나리오가 정한 답을 돌려준다.
let promptAnswer: string | null = null;
window.confirm = () => true;
window.prompt = () => promptAnswer;
window.alert = () => {};

let ready: Promise<void> | null = null;
function init(): Promise<void> {
  ready ??= (async () => {
    const log = console.log;
    console.log = () => {};
    try { await wasm.initialize(); } finally { console.log = log; }
  })();
  return ready;
}

function quietly<T>(run: () => T): T {
  const log = console.log;
  console.log = () => {};
  try { return run(); } finally { console.log = log; }
}

/** 캐럿 그리기·스크롤만 비운 실제 InputHandler 호스트. 편집 라우터와 undo/redo 는 실제 코드다. */
function createHost(): AnyHost {
  const scrollContent = document.createElement('div');
  scrollContent.id = 'scroll-content';
  scrollContent.style.cssText = 'position:fixed;left:0;top:0;width:2000px;height:3000px;';
  const container = document.createElement('div');
  container.appendChild(scrollContent);
  document.body.querySelector('#test-editor')?.remove();
  container.id = 'test-editor';
  document.body.appendChild(container);

  const next = Object.create(InputHandler.prototype);
  Object.assign(next, {
    wasm,
    eventBus,
    container,
    history: new CommandHistory(),
    cursor: new CursorState(wasm),
    active: true,
    insertMode: true,
    editMode: 'normal',
    readOnly: false,
    userEditingLocked: false,
    agentTemplateLocked: false,
    imeSession: new ImeSession(),
    compositionAnchor: null,
    compositionLength: 0,
    pendingCharFormat: null,
    lastCellKey: null,
    protectedCellHitCache: null,
    cachedTableRef: null,
    cachedCellBboxes: null,
    tableBboxFetchFailures: new Set(),
    tableLocalResizeSegments: new Set(),
    rawTextMutationEffects: new TextMutationEffectAccumulator(),
    deferredPaginationPending: false,
    deferredPaginationFlushTimer: null,
    deferredPaginationRunner: { isActive: () => false, cancel() {}, start() {} },
    caretLayoutReveal: { requestFor() {} },
    textarea: { value: '', focus() {}, blur() {} },
    caret: { show() {}, hide() {}, update() {} },
    selectionRenderer: { clear() {}, render() {} },
    // 쪽 0 이 화면 왼쪽 위(0,0)에 배율 1로 놓였다고 본다.
    viewportManager: { getZoom: () => 1 },
    virtualScroll: { getPageAtPoint: () => 0, getPageOffset: () => 0, getPageLeftResolved: () => 0 },
    imagePlacementMode: false,
    imagePlacementData: null,
    imagePlacementDrag: null,
    imagePlacementOverlay: null,
    // 화면 갱신(캐럿·스크롤·선택 표시)만 비운다.
    updateCaret() {},
    scheduleDeferredPaginationFlush() {},
    renderPictureObjectSelection() {},
  });
  return next;
}

/** 새 문서를 만들고 build 로 내용을 채운 뒤, 이력이 빈 새 호스트를 붙인다. */
function freshDocument(build: () => void = () => {}): AnyHost {
  closeAllDialogs();
  formMode = false;
  quietly(() => wasm.createNewDocument());
  quietly(build);
  host = createHost();
  host.cursor.moveTo({ sectionIndex: 0, paragraphIndex: 0, charOffset: 0 });
  return host;
}

async function openDocument(bytes: Uint8Array, fileName: string): Promise<AnyHost> {
  closeAllDialogs();
  formMode = false;
  quietly(() => wasm.loadDocument(bytes, fileName));
  host = createHost();
  host.cursor.moveTo({ sectionIndex: 0, paragraphIndex: 0, charOffset: 0 });
  return host;
}

/** 사용자가 보는 쪽 전부와 저장될 HWPX 바이트를 합친 문서 지문. */
async function fingerprint(): Promise<string> {
  wasm.flushDeferredPagination();
  const encoder = new TextEncoder();
  const parts: BlobPart[] = [];
  for (let page = 0; page < wasm.pageCount; page++) parts.push(encoder.encode(wasm.renderPageSvg(page)));
  parts.push(wasm.exportHwpx() as BlobPart);
  const digest = await crypto.subtle.digest('SHA-256', await new Blob(parts).arrayBuffer());
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function undoDepth(): number {
  return (host.history as unknown as { undoStack: unknown[] }).undoStack.length;
}

interface StepHooks {
  afterUndo?: () => void;
  afterRedo?: () => void;
}

/** act 한 번을 재고, 실제 handleUndo 한 번과 handleRedo 한 번 뒤의 문서를 잰다. */
async function step(act: () => void | Promise<void>, hooks: StepHooks = {}): Promise<StepResult> {
  const before = await fingerprint();
  const depth = undoDepth();
  await act();
  const after = await fingerprint();
  const entries = undoDepth() - depth;
  host.handleUndo();
  const undone = await fingerprint();
  hooks.afterUndo?.();
  host.handleRedo();
  const redone = await fingerprint();
  hooks.afterRedo?.();
  return { before, after, undone, redone, entries };
}

/** 기록하지 않아야 하는 동작: 문서와 이력이 그대로인지 잰다. */
async function noStep(act: () => void | Promise<void>): Promise<{ before: string; after: string; entries: number }> {
  const before = await fingerprint();
  const depth = undoDepth();
  await act();
  return { before, after: await fingerprint(), entries: undoDepth() - depth };
}

// ── 대화상자 DOM 조작 ──────────────────────────────

function closeAllDialogs(): void {
  for (const close of document.querySelectorAll<HTMLButtonElement>('.dialog-close')) {
    if (close.isConnected) close.click();
  }
  for (const overlay of document.querySelectorAll('.modal-overlay')) overlay.remove();
}

/** 열려 있는 대화상자 중 selector 에 맞는 맨 위 것. */
function dialog(selector = '.dialog-wrap'): HTMLElement {
  const all = [...document.querySelectorAll<HTMLElement>(selector)].filter((el) => el.isConnected);
  const top = all[all.length - 1];
  if (!top) throw new Error(`열린 대화상자 없음: ${selector}`);
  return top;
}

function ownText(el: Element): string {
  return [...el.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent).join('').trim();
}

/** 라벨 글자로 입력 칸을 찾는다: 라벨 안의 칸, 아니면 라벨 뒤 형제 중 kind 에 맞는 첫 칸. */
function field<T extends HTMLElement = HTMLInputElement>(
  root: HTMLElement, label: string, kind = 'input, select, textarea',
): T {
  for (const el of root.querySelectorAll('label, span, div')) {
    if (ownText(el) !== label && el.textContent?.trim() !== label) continue;
    if (el.children.length > 0 && el.tagName !== 'LABEL') continue;
    const inner = el.querySelector(kind);
    if (inner) return inner as T;
    for (let sib = el.nextElementSibling; sib; sib = sib.nextElementSibling) {
      if (sib.matches(kind)) return sib as T;
      const nested = sib.querySelector(kind);
      if (nested) return nested as T;
    }
  }
  throw new Error(`칸 없음: ${label}`);
}

function setValue(el: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement, value: string): void {
  el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

function button(root: HTMLElement, textOrTitle: string): HTMLButtonElement {
  const found = [...root.querySelectorAll<HTMLButtonElement>('button')]
    .find((b) => b.textContent?.trim() === textOrTitle || b.title === textOrTitle);
  if (!found) throw new Error(`버튼 없음: ${textOrTitle}`);
  return found;
}

function confirmDialog(root: HTMLElement): void {
  const ok = root.querySelector<HTMLButtonElement>('.dialog-btn-primary');
  if (!ok) throw new Error('확인 버튼 없음');
  ok.click();
}

function run(id: string): void {
  if (!dispatcher.dispatch(id)) throw new Error(`명령 실행 안 됨: ${id}`);
}

// ── 문서 재료 ──────────────────────────────

let pngBytes: Uint8Array | null = null;
async function png(): Promise<Uint8Array> {
  if (pngBytes) return pngBytes;
  const canvas = document.createElement('canvas');
  canvas.width = 40;
  canvas.height = 30;
  const g = canvas.getContext('2d')!;
  g.fillStyle = '#3366cc';
  g.fillRect(0, 0, 40, 30);
  const blob = await new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b!), 'image/png'));
  pngBytes = new Uint8Array(await blob.arrayBuffer());
  return pngBytes;
}

function bodyPicture(bytes: Uint8Array): { paraIdx: number; controlIdx: number } {
  wasm.insertText(0, 0, 0, '그림 앞');
  const r = wasm.insertPicture(0, 0, 4, '', bytes, 3000, 2250, 40, 30, 'png', '', undefined, undefined, 'inline');
  if (!r.ok) throw new Error('본문 그림 삽입 실패');
  return { paraIdx: r.paraIdx, controlIdx: r.controlIdx };
}

function table(rows: number, cols: number): { ppi: number; ci: number } {
  const t = wasm.createTableEx({ sectionIdx: 0, paraIdx: 0, charOffset: 0, rowCount: rows, colCount: cols });
  return { ppi: t.paraIdx, ci: t.controlIdx };
}

function cellPos(ppi: number, ci: number, cellIndex: number, charOffset = 0) {
  return {
    sectionIndex: 0, paragraphIndex: 0, charOffset,
    parentParaIndex: ppi, controlIndex: ci, cellIndex, cellParaIndex: 0,
    cellPath: [{ controlIndex: ci, cellIndex, cellParaIndex: 0 }],
  };
}

function cellText(ppi: number, ci: number, cellIndex: number): string {
  return wasm.getTextInCell(0, ppi, ci, cellIndex, 0, 0, wasm.getCellParagraphLength(0, ppi, ci, cellIndex, 0));
}

// ── 시나리오 ──────────────────────────────

/** 수식 속성 대화상자: 크기를 바꾸고 확인. */
async function equationProps(entry: string): Promise<StepResult> {
  let ref = { paraIdx: 0, controlIdx: 0 };
  freshDocument(() => {
    wasm.insertText(0, 0, 0, '수식 ');
    ref = wasm.insertEquation(0, 0, 3, 'a over b', 1000, 0);
  });
  host.cursor.enterPictureObjectSelectionDirect(0, ref.paraIdx, ref.controlIdx, 'equation');
  return step(() => {
    run(entry);
    const root = dialog('.eq-props-dialog');
    setValue(field(root, '크기'), '24');
    confirmDialog(root);
  });
}

/** 찾아 바꾸기: 바꾸기 한 번과 모두 바꾸기 한 번. */
async function findReplace(): Promise<{ replace: StepResult; replaceAll: StepResult; text: string[] }> {
  freshDocument(() => wasm.insertText(0, 0, 0, '사과 배 사과 감 사과'));
  run('edit:find-replace');
  const root = dialog('.find-dialog');
  setValue(field(root, '찾을 내용:'), '사과');
  setValue(field(root, '바꿀 내용:'), '포도');
  button(root, '다음 찾기').click();
  const text = () => wasm.getTextRange(0, 0, 0, wasm.getParagraphLength(0, 0));
  const replace = await step(() => button(root, '바꾸기').click());
  const afterReplace = text();
  const replaceAll = await step(() => button(root, '모두 바꾸기').click());
  const afterAll = text();
  button(root, '×').click();
  return { replace, replaceAll, text: [afterReplace, afterAll] };
}

/**
 * 찾기 대화상자는 undo 뒤 기억한 결과를 버린다. 버리지 않으면 '이전 찾기' 가 커서가 아닌
 * 옛 결과 위치에서 거꾸로 찾는다.
 */
async function findHistoryJump(): Promise<{
  selectionAfterPrev: { start: number; end: number } | null;
  listeners: { beforeShow: number; shown: number; hidden: number };
}> {
  freshDocument(() => wasm.insertText(0, 0, 0, 'X X X'));
  const beforeShow = liveListeners.get('history-jumped') ?? 0;
  run('edit:find');
  const root = dialog('.find-dialog');
  const shown = liveListeners.get('history-jumped') ?? 0;
  setValue(field(root, '찾을 내용:'), 'X');
  for (let i = 0; i < 3; i++) button(root, '다음 찾기').click();
  // 앞쪽에 커서를 두고 편집한 뒤 되돌린다.
  host.moveCursorTo({ sectionIndex: 0, paragraphIndex: 0, charOffset: 1 });
  host.executeOperation({
    kind: 'snapshot',
    operationType: 'testEdit',
    operation: (w: WasmBridge) => {
      w.insertText(0, 0, 5, '!');
      return host.getCursorPosition();
    },
  });
  host.handleUndo();
  button(root, '이전 찾기').click();
  const sel = host.getSelection();
  button(root, '×').click();
  const hidden = liveListeners.get('history-jumped') ?? 0;
  return {
    selectionAfterPrev: sel ? { start: sel.start.charOffset, end: sel.end.charOffset } : null,
    listeners: { beforeShow, shown, hidden },
  };
}

/** 계산식 대화상자: 쉼표 옵션으로 합계를 쓰고, 틀린 식은 아무것도 기록하지 않는다. */
async function formula(): Promise<{
  commit: StepResult; written: string; undoneText: string;
  invalid: { before: string; after: string; entries: number; stillOpen: boolean };
}> {
  let t = { ppi: 0, ci: 0 };
  freshDocument(() => {
    t = table(1, 3);
    wasm.insertTextInCell(0, t.ppi, t.ci, 0, 0, 0, '1234');
    wasm.insertTextInCell(0, t.ppi, t.ci, 1, 0, 0, '5678');
  });
  host.moveCursorTo(cellPos(t.ppi, t.ci, 2));
  let undoneText = '';
  const commit = await step(() => {
    run('table:formula');
    const root = dialog();
    setValue(field(root, '계산식(E):'), '=SUM(left)');
    confirmDialog(root);
  }, { afterUndo: () => { undoneText = cellText(t.ppi, t.ci, 2); } });
  const written = cellText(t.ppi, t.ci, 2);

  host.moveCursorTo(cellPos(t.ppi, t.ci, 2));
  let stillOpen = false;
  const invalid = await noStep(() => {
    run('table:formula');
    const root = dialog();
    setValue(field(root, '계산식(E):'), '=FOO(left)');
    confirmDialog(root);
    stillOpen = root.isConnected;
  });
  closeAllDialogs();
  return { commit, written, undoneText, invalid: { ...invalid, stillOpen } };
}

type PictureTarget = 'body-picture' | 'body-shape' | 'cell-picture';

/** 그림/도형 속성 대화상자: 너비를 바꾸고 확인. */
async function pictureProps(target: PictureTarget, entry: string): Promise<StepResult> {
  const bytes = await png();
  let select = () => {};
  freshDocument(() => {
    if (target === 'body-picture') {
      const r = bodyPicture(bytes);
      select = () => host.cursor.enterPictureObjectSelectionDirect(0, r.paraIdx, r.controlIdx, 'image');
    } else if (target === 'body-shape') {
      wasm.insertText(0, 0, 0, '도형 앞');
      const r = wasm.createShapeControl({
        sectionIdx: 0, paraIdx: 0, charOffset: 4, width: 7200, height: 3600,
        horzOffset: 0, vertOffset: 0, shapeType: 'rectangle',
      });
      if (!r.ok) throw new Error('도형 만들기 실패');
      select = () => host.cursor.enterPictureObjectSelectionDirect(0, r.paraIdx, r.controlIdx, 'shape');
    } else {
      const t = table(1, 1);
      const cellPath = [{ controlIndex: t.ci, cellIndex: 0, cellParaIndex: 0 }];
      const r = wasm.insertPicture(
        0, t.ppi, 0, JSON.stringify(cellPath), bytes, 3000, 2250, 40, 30, 'png', '', undefined, undefined, 'inline',
      );
      if (!r.ok) throw new Error('셀 그림 삽입 실패');
      select = () => host.cursor.enterPictureObjectSelectionRef({
        sec: 0, ppi: t.ppi, ci: r.controlIdx, type: 'image', cellIdx: 0, cellParaIdx: 0, cellPath,
      });
    }
  });
  select();
  return step(() => {
    run(entry);
    const root = dialog('.pp-dialog');
    setValue(field(root, '너비(W)', 'input[type=number]'), '20');
    confirmDialog(root);
  });
}

/** 머리말 그림(실제 샘플)의 속성 대화상자. */
async function headerPictureProps(sample: Uint8Array): Promise<StepResult & { found: boolean }> {
  await openDocument(sample, 'hwp3-sample11.hwp');
  let found: Record<string, number> | null = null;
  // 머리말 컨트롤 안 그림의 주소를 엔진 조회로 찾는다.
  search: for (let bi = 0; bi < Math.min(wasm.getParagraphCount(0), 40); bi++) {
    for (let hi = 0; hi < 8; hi++) {
      for (let ipi = 0; ipi < 4; ipi++) {
        for (let ici = 0; ici < 8; ici++) {
          try {
            const props = wasm.getHeaderFooterPictureProperties(0, bi, hi, ipi, ici);
            if (props && typeof props.width === 'number') {
              found = { bi, hi, ipi, ici };
              break search;
            }
          } catch { /* 다음 후보 */ }
        }
      }
    }
  }
  if (!found) return { before: '', after: '', undone: '', redone: '', entries: 0, found: false };
  const f = found;
  host.cursor.enterPictureObjectSelectionRef({
    sec: 0, ppi: f.ipi, ci: f.ici, type: 'image',
    headerFooter: { kind: 'header', outerParaIdx: f.bi, outerControlIdx: f.hi },
  });
  const result = await step(() => {
    run('insert:picture-props');
    const root = dialog('.pp-dialog');
    const width = field(root, '너비(W)', 'input[type=number]');
    setValue(width, String(Math.max(5, Math.round(parseFloat(width.value || '20') / 2))));
    confirmDialog(root);
  });
  return { ...result, found: true };
}

/** 바꾼 것 없이 확인하면 아무것도 기록하지 않는다. */
async function picturePropsNoChange(): Promise<{ before: string; after: string; entries: number }> {
  const bytes = await png();
  let r = { paraIdx: 0, controlIdx: 0 };
  freshDocument(() => { r = bodyPicture(bytes); });
  host.cursor.enterPictureObjectSelectionDirect(0, r.paraIdx, r.controlIdx, 'image');
  return noStep(() => {
    run('insert:picture-props');
    confirmDialog(dialog('.pp-dialog'));
  });
}

/** 그림 넣기: 배치 모드 클릭과 파일 끌어 놓기. */
async function pictureInsert(kind: 'placement' | 'drop'): Promise<StepResult & { ok: boolean }> {
  const bytes = await png();
  freshDocument(() => wasm.insertText(0, 0, 0, '그림을 넣을 문단'));
  const rect = wasm.getCursorRect(0, 0, 2);
  const x = rect.x + 1;
  const y = rect.y + rect.height / 2;
  let ok = true;
  const result = await step(() => {
    if (kind === 'placement') {
      host.enterImagePlacementMode(bytes, 'png', 40, 30, 'place.png');
      // 마우스다운이 남기는 상태 그대로 두고 마우스업으로 마친다.
      host.imagePlacementDrag = {
        startClientX: x, startClientY: y, currentClientX: x, currentClientY: y, isDragging: false,
      };
      host.finishImagePlacement(new MouseEvent('mouseup', { clientX: x, clientY: y, button: 0 }));
    } else {
      ok = host.insertDroppedImageAtClientPoint(bytes, 'png', 40, 30, 'drop.png', x, y).ok;
    }
  });
  return { ...result, ok };
}

function styleLabel(): string {
  return dialog().querySelector('.sd-cur-style-name')?.textContent ?? '';
}

function styleNames(): string[] {
  return [...dialog().querySelectorAll('.sd-style-name')].map((el) => el.textContent ?? '');
}

/** 스타일 삭제: undo/redo 뒤 열린 대화상자의 현재 스타일 표시와 목록이 문서를 따라온다. */
async function styleDelete(): Promise<{
  step: StepResult; styleName: string; baseName: string;
  afterUndo: { label: string; listed: boolean }; afterRedo: { label: string; listed: boolean };
  listeners: { beforeShow: number; shown: number; hidden: number };
}> {
  let styleId = 0;
  freshDocument(() => {
    wasm.insertText(0, 0, 0, '스타일 문단');
    styleId = wasm.getStyleList().find((s) => s.id > 0 && s.type === 0)!.id;
    wasm.applyStyle(0, 0, styleId);
  });
  const styles = wasm.getStyleList();
  const styleName = styles.find((s) => s.id === styleId)!.name;
  const baseName = styles.find((s) => s.id === 0)!.name;
  const beforeShow = liveListeners.get('history-jumped') ?? 0;
  run('format:style-dialog');
  const shown = liveListeners.get('history-jumped') ?? 0;
  const capture = () => ({ label: styleLabel(), listed: styleNames().includes(styleName) });
  let afterUndo = { label: '', listed: false };
  let afterRedo = { label: '', listed: false };
  const result = await step(() => button(dialog(), '스타일 삭제').click(), {
    afterUndo: () => { afterUndo = capture(); },
    afterRedo: () => { afterRedo = capture(); },
  });
  button(dialog(), '취소').click();
  const hidden = liveListeners.get('history-jumped') ?? 0;
  return { step: result, styleName, baseName, afterUndo, afterRedo, listeners: { beforeShow, shown, hidden } };
}

/** 스타일 추가/편집: 이름과 글자 모양을 함께 바꾼 저장이 한 번에 되돌아간다. */
async function styleSave(mode: 'add' | 'edit'): Promise<StepResult> {
  freshDocument(() => wasm.insertText(0, 0, 0, '스타일 문단'));
  run('format:style-dialog');
  const manager = dialog();
  if (mode === 'edit') {
    const item = [...manager.querySelectorAll<HTMLElement>('.sd-style-item')][1];
    item.click();
  }
  const result = await step(() => {
    button(manager, mode === 'add' ? '스타일 추가' : '스타일 편집').click();
    const editor = dialog();
    setValue(field(editor, '스타일 이름(N):'), mode === 'add' ? '검증 스타일' : '고친 스타일');
    button(editor, '글자 모양(L)...').click();
    const charShape = dialog('.cs-dialog');
    setValue(field(charShape, '기준 크기(Z):'), '22');
    confirmDialog(charShape);
    confirmDialog(editor);
  });
  closeAllDialogs();
  return result;
}

/** 스타일을 더 만들 수 없을 때 추가는 실패하고 아무것도 기록하지 않는다. */
async function styleCreateFailure(): Promise<{ before: string; after: string; entries: number; stillOpen: boolean }> {
  freshDocument(() => {
    wasm.insertText(0, 0, 0, '스타일 문단');
    for (let i = 0; i < 300 && wasm.createStyle(JSON.stringify({ name: `채움${i}` })) >= 0; i++) { /* 상한까지 */ }
  });
  run('format:style-dialog');
  let stillOpen = false;
  const result = await noStep(() => {
    button(dialog(), '스타일 추가').click();
    const editor = dialog();
    setValue(field(editor, '스타일 이름(N):'), '넘침');
    confirmDialog(editor);
    stillOpen = editor.isConnected;
  });
  closeAllDialogs();
  return { ...result, stillOpen };
}

type TableEntry = 'cell-props-table' | 'cell-props-cell' | 'object-properties' | 'border-each' | 'border-one';

/** 표/셀 속성과 셀 테두리/배경 대화상자. */
async function tableDialog(entry: TableEntry): Promise<StepResult> {
  let t = { ppi: 0, ci: 0 };
  freshDocument(() => {
    wasm.insertText(0, 0, 0, '표 앞');
    wasm.splitParagraph(0, 0, 3);
    t = wasm.createTableEx({ sectionIdx: 0, paraIdx: 1, charOffset: 0, rowCount: 2, colCount: 2 }) as never;
    t = { ppi: (t as any).paraIdx, ci: (t as any).controlIdx };
    wasm.insertTextInCell(0, t.ppi, t.ci, 0, 0, 0, '셀');
  });
  host.moveCursorTo(cellPos(t.ppi, t.ci, 0));
  if (entry === 'cell-props-table') host.cursor.enterTableObjectSelectionDirect(0, t.ppi, t.ci);
  if (entry === 'object-properties') host.cursor.enterTableObjectSelection();
  if (entry === 'border-one') {
    host.cursor.enterCellSelectionMode();
    host.cursor.shiftSelectCell(0, 1);
  }
  const id = {
    'cell-props-table': 'table:cell-props',
    'cell-props-cell': 'table:cell-props',
    'object-properties': 'format:object-properties',
    'border-each': 'table:border-each',
    'border-one': 'table:border-one',
  }[entry];
  return step(() => {
    run(id);
    const root = dialog();
    if (entry === 'border-each' || entry === 'border-one') {
      button(root, '배경').click();
      setValue(field(root, '면색(C)'), '#ff0000');
    } else if (entry === 'cell-props-cell') {
      const header = field(root, '제목 셀');
      header.checked = !header.checked;
      header.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      const tac = field(root, '글자처럼 취급');
      tac.checked = !tac.checked;
      tac.dispatchEvent(new Event('change', { bubbles: true }));
    }
    confirmDialog(root);
  });
}

/** 책갈피 넣기·이름 바꾸기·지우기. */
async function bookmarks(): Promise<{ add: StepResult; rename: StepResult; remove: StepResult; names: string[][] }> {
  freshDocument(() => wasm.insertText(0, 0, 0, '책갈피 문단'));
  host.moveCursorTo({ sectionIndex: 0, paragraphIndex: 0, charOffset: 2 });
  const names = () => wasm.getBookmarks().map((b) => b.name);
  const seen: string[][] = [];
  const add = await step(() => {
    run('insert:bookmark');
    const root = dialog('.bm-dialog');
    setValue(root.querySelector<HTMLInputElement>('.bm-name-input')!, '표지');
    button(root, '넣기(D)').click();
  });
  seen.push(names());
  const rename = await step(() => {
    run('insert:bookmark');
    const root = dialog('.bm-dialog');
    root.querySelector<HTMLElement>('.bm-item')!.click();
    promptAnswer = '목차';
    button(root, '책갈피 이름 바꾸기').click();
  });
  seen.push(names());
  const remove = await step(() => {
    const root = dialog('.bm-dialog');
    root.querySelector<HTMLElement>('.bm-item')!.click();
    button(root, '삭제').click();
  });
  seen.push(names());
  button(dialog('.bm-dialog'), '취소').click();
  return { add, rename, remove, names: seen };
}

type LayoutEntry = 'page:setup' | 'file:page-setup' | 'page:page-border' | 'page:col-settings'
  | 'page:section-settings' | 'page:new-page-num' | 'insert:endnote-shape';

/** 쪽·구역·번호 대화상자: 값 하나를 바꾸고 확인. */
async function layoutDialog(entry: LayoutEntry): Promise<StepResult> {
  freshDocument(() => wasm.insertText(0, 0, 0, '쪽 설정 문단'));
  host.moveCursorTo({ sectionIndex: 0, paragraphIndex: 0, charOffset: 1 });
  return step(() => {
    run(entry);
    const root = dialog();
    switch (entry) {
      case 'page:setup':
      case 'file:page-setup':
        setValue(field(root, '위쪽'), '35');
        break;
      case 'page:page-border': {
        button(root, '배경').click();
        const row = field(root, '무늬 색').parentElement!;
        const radio = row.querySelector<HTMLInputElement>('input[type=radio]')!;
        radio.checked = true;
        radio.dispatchEvent(new Event('change', { bubbles: true }));
        setValue(row.querySelector<HTMLInputElement>('input[type=color]')!, '#ffeeaa');
        break;
      }
      case 'page:col-settings':
        setValue(field(root, '단 수'), '2');
        break;
      case 'page:section-settings':
        setValue(field(root, '기본 탭 간격(I):'), '30');
        break;
      case 'page:new-page-num':
        setValue(field(root, '시작 번호:'), '5');
        break;
      case 'insert:endnote-shape':
        setValue(field(root, '앞 장식 문자'), '(');
        break;
    }
    confirmDialog(root);
  });
}

/** 양식 모드에서는 편집 용지의 두 진입점이 모두 막힌다. */
async function formModePageSetup(): Promise<Record<string, { dispatched: boolean; opened: boolean }>> {
  freshDocument(() => wasm.insertText(0, 0, 0, '양식'));
  const out: Record<string, { dispatched: boolean; opened: boolean }> = {};
  for (const id of ['file:page-setup', 'page:setup']) {
    closeAllDialogs();
    formMode = true;
    const dispatched = dispatcher.dispatch(id);
    out[id] = { dispatched, opened: document.querySelectorAll('.dialog-wrap').length > 0 };
  }
  formMode = false;
  closeAllDialogs();
  return out;
}

/** 수식 넣기: 수식 편집기에서 확인하면 한 번에 들어간다. */
async function equationInsert(): Promise<StepResult & { equations: number }> {
  freshDocument(() => wasm.insertText(0, 0, 0, '수식 자리'));
  host.moveCursorTo({ sectionIndex: 0, paragraphIndex: 0, charOffset: 2 });
  const result = await step(() => {
    run('insert:equation');
    const root = dialog('.eq-dialog');
    setValue(root.querySelector<HTMLTextAreaElement>('.eq-script')!, 'a over b');
    confirmDialog(root);
  });
  const layout = wasm.getPageControlLayout(0).controls as Array<{ type: string }>;
  return { ...result, equations: layout.filter((c) => c.type === 'equation').length };
}

type SaveChoice = 'cancel' | 'discard' | 'approve' | 'approve-fails';

/**
 * 검토 대기 에이전트 편집이 있으면 저장 명령은 쓰기 전에 대기 편집 대화상자를 띄운다.
 * 사건 순서(대화상자·수락·거절·파일 선택·쓰기)를 기록해 돌려준다.
 */
async function saveGate(choice: SaveChoice): Promise<string[]> {
  freshDocument(() => wasm.insertText(0, 0, 0, '대기 편집이 있는 문서'));
  const log: string[] = [];
  const handle = {
    kind: 'file',
    name: '저장.hwpx',
    async createWritable() {
      return {
        async write(blob: Blob) { log.push(blob.size > 0 ? 'write' : 'write-empty'); },
        async close() { log.push('close'); },
        async abort() { log.push('abort'); },
      };
    },
  };
  const saved = { ...services };
  Object.assign(services, {
    documentState: { isDirty: () => true, markDirty() {}, markClean() {}, captureRevision: () => 0, markCleanIfUnchanged: () => true },
    getPendingAgentEdits: () => ({
      opCount: 2,
      approveAll: () => { log.push('approveAll'); return choice !== 'approve-fails'; },
      rejectAll: () => { log.push('rejectAll'); },
    }),
    pickSaveHandle: async () => { log.push('pick'); return handle; },
  });
  try {
    const save = registry.get('file:save')!.execute(services) as unknown as Promise<void>;
    let gate: HTMLElement | null = null;
    for (let i = 0; i < 100 && !gate; i++) {
      gate = [...document.querySelectorAll<HTMLElement>('.dialog-wrap')]
        .find((el) => el.querySelector('.dialog-title')?.textContent?.startsWith('검토 대기 변경')) ?? null;
      if (!gate) await new Promise((r) => setTimeout(r, 20));
    }
    if (gate) {
      log.push('dialog');
      const label = { cancel: '취소', discard: '모두 거절 후 저장', approve: '모두 수락 후 저장', 'approve-fails': '모두 수락 후 저장' }[choice];
      button(gate, label).click();
    }
    await save;
    return log;
  } finally {
    Object.assign(services, saved);
    delete (services as Partial<CommandServices>).getPendingAgentEdits;
    delete (services as Partial<CommandServices>).pickSaveHandle;
    closeAllDialogs();
  }
}

export const scenarios = {
  saveGate,
  init,
  equationProps,
  findReplace,
  findHistoryJump,
  formula,
  pictureProps,
  headerPictureProps,
  picturePropsNoChange,
  pictureInsert,
  styleDelete,
  styleSave,
  styleCreateFailure,
  tableDialog,
  bookmarks,
  layoutDialog,
  formModePageSetup,
  equationInsert,
};
