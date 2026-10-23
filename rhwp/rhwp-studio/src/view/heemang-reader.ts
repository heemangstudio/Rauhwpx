import type { Located, Motion, Rect, TextSelection, EditResult, Match, CharPatch, ParaPatch, Copied } from '../core/heemang-adapter';
import type { StudioEngine } from '../core/wasm-bridge';
import type { CanvasView } from './canvas-view';
import type { EventBus } from '../core/event-bus';
import { EngineNotSupportedError } from '../core/engine-support';
import { copySelection, isCellSelection, sameAddress, sameSelection, type CellSelection, type EditingSelection } from '../core/heemang-editing';
import { showHeemangCharacterFormat, showHeemangParagraphFormat, showHeemangFind } from '../ui/heemang-edit-dialogs';

// 네이티브 조각은 runtime Engine이 공유한다. OS의 일반 텍스트와 조각을 혼동하지 않는다.
let clipboard: (Copied & { token: string }) | null = null;
const clipboardType = 'application/x-heemang-fragment';

/** Heemang 세션의 wire 주소를 유지하는 입력·선택 경로. */
export function installHeemangReader(container: HTMLElement, engine: StudioEngine, bus: EventBus, view: CanvasView, report: (error: Error) => void, canEdit: () => boolean = () => true): void {
  let caret: Located | null = null;
  let anchor: Located | null = null;
  let cells: CellSelection | null = null;
  let rectangles: Rect[] = [];
  let dragging = false;
  let pasteAsPlainText = false;
  let preferredX: number | undefined;
  let frame = 0;
  let documentInstance = engine.documentInstance;
  const overlays = new Set<HTMLElement>();
  const active = () => engine.engineKind === 'heemang' && engine.hasLoadedDocument();
  let findDialog: ReturnType<typeof showHeemangFind> | null = null;
  let findHit: { match: Match; epoch: number; query: string; caseSensitive: boolean } | null = null;
  let composition: { selection: EditingSelection; text: string } | null = null;
  const input = document.createElement('textarea');
  input.dataset.heemangInput = 'true';
  input.dataset.rhwpEditorInput = 'true';
  input.setAttribute('aria-label', '문서 텍스트 입력');
  input.autocomplete = 'off';
  input.spellcheck = false;
  Object.assign(input.style, {
    position: 'fixed', width: '1px', height: '1px', opacity: '0',
    padding: '0', border: '0', resize: 'none', zIndex: '4', pointerEvents: 'none',
  });
  container.append(input);
  container.tabIndex = 0;
  const textSelection = (): TextSelection | null => caret ? {
    from: anchor?.position ?? caret.position, to: caret.position,
    fromAffinity: anchor?.affinity ?? caret.affinity, toAffinity: caret.affinity,
  } : null;
  const selection = (): EditingSelection | null => cells ?? textSelection();
  const writable = () => active() && !engine.readOnly && canEdit();
  function focusInput() {
    if (writable()) input.focus({ preventScroll: true });
    else container.focus({ preventScroll: true });
  }
  function cancelComposition() {
    composition = null;
    input.value = '';
    draw();
  }
  function applyEdit(action: () => EditResult | null) {
    const result = action();
    if (!result) return;
    const nextCaret = result.caret, nextAnchor = result.anchor ?? null;
    preferredX = undefined;
    input.value = '';
    // 논리 변경은 한 번만 발행하며 renderer와 dirty/revision 구독자가 함께 받는다.
    bus.emit('document-changed', result.receipt);
    bus.emit('command-state-changed');
    updateSelection(nextCaret, nextAnchor, result.selection);
    revealCaret();
  }
  function replace(text: string) {
    const range = selection();
    if (!range || !writable()) return;
    applyEdit(() => engine.viewer!.replaceText(range, text));
  }
  function revealCaret() {
    if (!caret || !active()) return;
    const zoom = view.getViewportManager().getZoom();
    const top = view.getVirtualScroll().getPageOffset(caret.caret.page) + caret.caret.y / 75 * zoom;
    const bottom = top + caret.caret.height / 75 * zoom;
    if (top < container.scrollTop) container.scrollTop = top;
    else if (bottom > container.scrollTop + container.clientHeight) container.scrollTop = bottom - container.clientHeight;
    scheduleDraw();
  }

  function draw() {
    for (const overlay of overlays) overlay.remove();
    overlays.clear();
    if (documentInstance !== engine.documentInstance) {
      documentInstance = engine.documentInstance;
      caret = anchor = null;
      cells = null;
      rectangles = [];
      dragging = false;
      composition = null;
      findDialog?.hide();
      findDialog = null;
      findHit = null;
      input.value = '';
    }
    input.disabled = !writable();
    if (!active()) return;
    const pages = container.querySelectorAll<HTMLCanvasElement>('canvas[data-heemang-page]');
    for (const canvas of pages) {
      const page = Number(canvas.dataset.heemangPage);
      const info = engine.getPageInfo(page);
      const zoom = canvas.getBoundingClientRect().width / info.width;
      const overlay = document.createElement('div');
      overlay.dataset.heemangOverlay = String(page);
      Object.assign(overlay.style, {
        position: 'absolute', pointerEvents: 'none', zIndex: '3',
        top: canvas.style.top, left: canvas.style.left, transform: canvas.style.transform,
        width: canvas.style.width, height: canvas.style.height,
      });
      const box = (x: number, y: number, width: number, height: number, color: string) => {
        const rect = document.createElement('div');
        Object.assign(rect.style, { position: 'absolute', left: `${x / 75 * zoom}px`, top: `${y / 75 * zoom}px`, width: `${width / 75 * zoom}px`, height: `${height / 75 * zoom}px`, background: color });
        overlay.append(rect);
        return rect;
      };
      for (const rect of rectangles) if (rect.page === page) box(rect.x, rect.y, rect.width, rect.height, '#3b82f640');
      if (caret?.caret.page === page) {
        const c = caret.caret;
        box(c.x, c.y, 100 / zoom, c.height, '#111').dataset.heemangCaret = 'true';
        const bounds = canvas.getBoundingClientRect();
        input.style.left = `${bounds.left + c.x / 75 * zoom}px`;
        input.style.top = `${bounds.top + c.y / 75 * zoom}px`;
        input.style.height = `${c.height / 75 * zoom}px`;
        if (composition?.text) {
          const preview = box(c.x, c.y, 0, c.height, '#fff');
          preview.dataset.heemangComposition = 'true';
          Object.assign(preview.style, { width: 'max-content', color: '#111', fontSize: `${c.height / 75 * zoom}px`, lineHeight: '1', borderBottom: '1px solid #111' });
          preview.textContent = composition.text;
        }
      }
      canvas.parentElement?.append(overlay);
      overlays.add(overlay);
    }
  }
  function scheduleDraw() {
    if (frame) return;
    frame = requestAnimationFrame(() => { frame = 0; draw(); });
  }
  function updateSelection(nextCaret = caret, nextAnchor = anchor, range?: EditingSelection) {
    if (!nextCaret) return;
    const request = range ?? {
      from: nextAnchor?.position ?? nextCaret.position, to: nextCaret.position,
      fromAffinity: nextAnchor?.affinity ?? nextCaret.affinity, toAffinity: nextCaret.affinity,
    };
    // 정규화가 실패하면 마지막 유효한 선택과 caret을 그대로 둔다.
    const selected = engine.viewer!.selectRange(request);
    caret = nextCaret;
    anchor = nextAnchor;
    cells = selected.range.kind === 'cells' ? {
      kind: 'cells', table: selected.range.table, from: selected.range.from, to: selected.range.to,
    } : null;
    rectangles = selected.rects;
    bus.emit('heemang-selection-changed');
    bus.emit('cursor-rect-updated', { pageIndex: caret.caret.page, x: caret.caret.x / 75, y: caret.caret.y / 75, height: caret.caret.height / 75 });
    draw();
  }
  function attempt(action: () => void) {
    try { action(); }
    catch (error) {
      dragging = false;
      cancelComposition();
      const message = typeof error === 'object' && error !== null && 'message' in error ? String(error.message) : String(error);
      report(error instanceof Error ? error : new Error(message));
    }
  }
  function point(ev: PointerEvent): Located | null {
    const canvas = document.elementFromPoint(ev.clientX, ev.clientY)?.closest<HTMLCanvasElement>('canvas[data-heemang-page]');
    if (!canvas || !container.contains(canvas)) return null;
    const page = Number(canvas.dataset.heemangPage);
    const bounds = canvas.getBoundingClientRect();
    const info = engine.getPageInfo(page);
    return engine.viewer!.locate({ kind: 'point', page, x: Math.round((ev.clientX - bounds.left) * info.width / bounds.width * 75), y: Math.round((ev.clientY - bounds.top) * info.height / bounds.height * 75) }) as Located | null;
  }
  container.addEventListener('pointerdown', ev => {
    if (!active() || ev.button !== 0) return;
    attempt(() => {
      const hit = point(ev);
      if (!hit) return;
      if (hit.object) {
        const object = hit.object, depth = object.steps?.length ?? 0;
        const step = hit.position.steps?.[depth];
        const insideTable = object.kind === 'table' && step && step.control === object.control
          && sameAddress({ section: hit.position.section, steps: hit.position.steps!.slice(0, depth), para: step.para, offset: 0 },
            { ...object, offset: 0 });
        if (!insideTable) throw new EngineNotSupportedError('개체 편집');
      }
      ev.preventDefault();
      ev.stopImmediatePropagation();
      cancelComposition();
      focusInput();
      const nextAnchor = ev.shiftKey && caret ? anchor ?? caret : hit;
      updateSelection(hit, nextAnchor);
      preferredX = undefined;
      dragging = true;
    });
  }, true);
  window.addEventListener('pointermove', ev => {
    if (!active() || !dragging) return;
    if (!(ev.buttons & 1)) { dragging = false; return; }
    attempt(() => {
      const hit = point(ev);
      if (!hit) return;
      updateSelection(hit);
    });
  });
  window.addEventListener('pointerup', () => { dragging = false; });
  window.addEventListener('pointercancel', () => { dragging = false; });
  window.addEventListener('blur', () => { dragging = false; });
  for (const name of ['mousedown', 'dblclick', 'contextmenu'] as const) {
    container.addEventListener(name, ev => {
      if (!active()) return;
      ev.preventDefault();
      ev.stopImmediatePropagation();
      if (name === 'dblclick' || name === 'contextmenu') report(new EngineNotSupportedError(name));
    }, true);
  }
  container.addEventListener('keydown', ev => {
    if (!active() || (ev.target !== container && ev.target !== input)) return;
    pasteAsPlainText = (ev.metaKey || ev.ctrlKey) && ev.shiftKey && ev.key.toLowerCase() === 'v';
    // 메뉴 저장 단축키는 기존 dispatcher로 전달한다.
    if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === 's') return;
    // 문서 서식/검색 단축키는 dispatcher가 동일한 wire 선택으로 처리한다.
    if ((ev.metaKey || ev.ctrlKey || ev.altKey) && !['z', 'y', 'c', 'x', 'v'].includes(ev.key.toLowerCase()) && !ev.key.startsWith('Arrow')) return;
    ev.stopImmediatePropagation();
    if (ev.key === 'Escape' && composition) {
      ev.preventDefault();
      cancelComposition();
      return;
    }
    if (composition || ev.isComposing || ev.keyCode === 229) return;
    if ((ev.metaKey || ev.ctrlKey) && ['z', 'y'].includes(ev.key.toLowerCase())) {
      ev.preventDefault();
      if (writable()) attempt(() => applyEdit(() => ev.key.toLowerCase() === 'y' || ev.shiftKey ? engine.viewer!.redoEdit() : engine.viewer!.undoEdit()));
      return;
    }
    const motions: Record<string, Motion> = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down', Home: 'lineStart', End: 'lineEnd' };
    const motion = motions[ev.key];
    if (motion && caret) {
      ev.preventDefault();
      attempt(() => {
        if (ev.altKey || ev.metaKey || ev.ctrlKey) throw new EngineNotSupportedError('단어·문서 단위 이동');
        const previous = caret!;
        if (motion === 'up' || motion === 'down') preferredX ??= previous.caret.x;
        else preferredX = undefined;
        const next = engine.viewer!.navigate({ position: previous.position, affinity: previous.affinity, motion, preferredX, page: previous.caret.page });
        if (!next) return;
        updateSelection(next, ev.shiftKey ? anchor ?? previous : null);
        revealCaret();
      });
      return;
    }
    if (['Enter', 'Backspace', 'Delete', 'Tab'].includes(ev.key)) {
      ev.preventDefault();
      const range = selection();
      if (!range || !writable()) return;
      attempt(() => {
        if (ev.key === 'Enter') applyEdit(() => engine.viewer!.split(range));
        else if (ev.key === 'Tab') replace('\t');
        else applyEdit(() => ev.key === 'Backspace' ? engine.viewer!.deleteBackward(range) : engine.viewer!.deleteForward(range));
      });
    } else if (ev.target === container && ev.key.length === 1 && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
      ev.preventDefault();
      attempt(() => replace(ev.key));
      focusInput();
    }
  }, true);
  input.addEventListener('compositionstart', () => {
    const range = selection();
    if (range && writable()) composition = { selection: structuredClone(range), text: '' };
  });
  input.addEventListener('compositionupdate', ev => {
    if (!composition) return;
    composition.text = ev.data;
    draw();
  });
  input.addEventListener('compositionend', ev => {
    const pending = composition;
    composition = null;
    input.value = '';
    if (!pending) return;
    if (ev.data && writable()) attempt(() => applyEdit(() => engine.viewer!.replaceText(pending.selection, ev.data)));
    else draw();
  });
  input.addEventListener('beforeinput', ev => {
    ev.stopImmediatePropagation();
    if (composition || ev.isComposing || ['insertCompositionText', 'insertFromComposition'].includes(ev.inputType)) return;
    ev.preventDefault();
    if (!writable()) return;
    attempt(() => {
      if (ev.inputType === 'insertText' && ev.data) replace(ev.data);
      else if (ev.inputType === 'insertParagraph' || ev.inputType === 'insertLineBreak') {
        const range = selection();
        if (range) applyEdit(() => engine.viewer!.split(range));
      } else if (ev.inputType === 'deleteContentBackward' || ev.inputType === 'deleteContentForward') {
        const range = selection();
        if (range) applyEdit(() => ev.inputType === 'deleteContentBackward' ? engine.viewer!.deleteBackward(range) : engine.viewer!.deleteForward(range));
      } else if (ev.inputType === 'historyUndo' || ev.inputType === 'historyRedo') {
        applyEdit(() => ev.inputType === 'historyUndo' ? engine.viewer!.undoEdit() : engine.viewer!.redoEdit());
      } else throw new EngineNotSupportedError(ev.inputType);
    });
  });
  input.addEventListener('input', ev => {
    ev.stopImmediatePropagation();
    if (!composition) input.value = '';
  });
  input.addEventListener('blur', cancelComposition);
  container.addEventListener('copy', ev => transferClipboard(ev, false));
  container.addEventListener('cut', ev => transferClipboard(ev, true));
  container.addEventListener('paste', ev => {
    if (!active()) return;
    ev.preventDefault();
    ev.stopImmediatePropagation();
    if (!writable() || !ev.clipboardData) return;
    const data = ev.clipboardData;
    attempt(() => {
      if (!data.types.includes('text/plain')) throw new EngineNotSupportedError('텍스트가 아닌 클립보드');
      paste(data.getData('text/plain'), data.getData('text/html'), data.getData(clipboardType), pasteAsPlainText);
    });
    pasteAsPlainText = false;
  });

  function copy(range: EditingSelection): Copied {
    const copied = engine.viewer!.copyText(range);
    if (copied.text || copied.html) clipboard = { ...copied, token: crypto.randomUUID() };
    return copied;
  }
  function transferClipboard(ev: ClipboardEvent, cut: boolean) {
    if (!active()) return;
    ev.preventDefault();
    ev.stopImmediatePropagation();
    const range = selection();
    if (!range || !ev.clipboardData || (cut && !writable())) return;
    attempt(() => {
      const copied = copy(range);
      if (!copied.text && !copied.html) return;
      ev.clipboardData!.setData('text/plain', copied.text);
      ev.clipboardData!.setData('text/html', `${copied.html}<!--heemang:${clipboard!.token}-->`);
      ev.clipboardData!.setData(clipboardType, clipboard!.token);
      if (cut) applyEdit(() => engine.viewer!.cutText(range).edit);
    });
  }
  function paste(text: string, html = '', token = '', plain = false) {
    const range = selection();
    if (!range || !writable() || (!text && !html)) return;
    const ownCopy = !!clipboard && clipboard.text === text
      && (token === clipboard.token || html.includes(`<!--heemang:${clipboard.token}-->`));
    if (html && !ownCopy && !plain) throw new EngineNotSupportedError('HTML 클립보드 가져오기');
    applyEdit(() => engine.viewer!.pasteText(range, text, !plain && ownCopy && engine.viewer!.hasInternalClipboard()));
    focusInput();
  }
  async function systemClipboard(cut: boolean) {
    const range = selection();
    if (!range || (cut && !writable())) return;
    const instance = engine.documentInstance, epoch = engine.viewer!.state().contentEpoch;
    const copied = copy(range);
    if (!copied.text && !copied.html) return;
    const token = clipboard!.token;
    await navigator.clipboard.write([new ClipboardItem({
      'text/plain': new Blob([copied.text], { type: 'text/plain' }),
      'text/html': new Blob([`${copied.html}<!--heemang:${clipboard!.token}-->`], { type: 'text/html' }),
    })]);
    if (cut) {
      ensureCurrent(instance, epoch);
      if (clipboard?.token !== token) throw new Error('클립보드를 쓰는 동안 복사 내용이 변경되었습니다');
      const current = selection();
      if (!current || !sameSelection(range, current)) throw new Error('클립보드를 쓰는 동안 선택이 변경되었습니다');
      applyEdit(() => engine.viewer!.cutText(range).edit);
    }
    focusInput();
  }
  async function systemPaste() {
    const instance = engine.documentInstance, epoch = engine.viewer!.state().contentEpoch;
    const range = selection();
    const items = await navigator.clipboard.read();
    let text = '', html = '', hasText = false;
    for (const item of items) {
      if (item.types.includes('text/plain')) { hasText = true; text = await (await item.getType('text/plain')).text(); }
      if (item.types.includes('text/html')) html = await (await item.getType('text/html')).text();
      if (text || html) break;
    }
    ensureCurrent(instance, epoch);
    if (!hasText) throw new EngineNotSupportedError('텍스트가 아닌 클립보드');
    const current = selection();
    if (!range || !current || !sameSelection(range, current)) throw new Error('클립보드를 읽는 동안 선택이 변경되었습니다');
    paste(text, html);
  }
  function ensureCurrent(instance: number, epoch: number) {
    if (!writable() || engine.documentInstance !== instance || engine.viewer!.state().contentEpoch !== epoch) throw new Error('작업 중 문서가 변경되었습니다');
  }
  function showSelection(range: TextSelection) {
    const v = engine.viewer!;
    const locate = (position: TextSelection['from'], affinity: Located['affinity'] = 'downstream'): Located => {
      const geometry = v.locate({ kind: 'caret', position, affinity });
      if (!geometry || !('page' in geometry)) throw new EngineNotSupportedError('검색 위치의 caret 조회');
      return { position, affinity, caret: geometry };
    };
    const from = locate(range.from, range.fromAffinity), to = locate(range.to, range.toAffinity);
    updateSelection(to, sameAddress(range.from, range.to) && from.affinity === to.affinity ? null : from);
    revealCaret();
  }
  function search(query: string, caseSensitive: boolean, backward: boolean): boolean {
    if (!active()) return false;
    const range = selection();
    const normalized = range ? engine.viewer!.selectRange(range).range : null;
    const ordered = normalized?.kind === 'text' ? normalized : null;
    // native from은 매치 시작을 엄격히 비교한다. 선택 시작을 써야 인접 매치를 건너뛰지 않는다.
    const found = engine.viewer!.search(query, caseSensitive, ordered?.from, backward);
    let match = backward ? found.matches.at(-1) : found.matches[0];
    if (!backward && ordered && sameAddress(ordered.from, ordered.to)) {
      match = engine.viewer!.search(query, caseSensitive).matches.find(m => sameAddress(m.from, ordered.from)) ?? match;
    }
    if (!match) { findHit = null; return false; }
    showSelection(match);
    findHit = { match, epoch: found.contentEpoch, query, caseSensitive };
    return true;
  }
  function openFind(mode: 'find' | 'replace') {
    if (findDialog) { findDialog.setMode(mode); findDialog.focus(); return; }
    findDialog = showHeemangFind({
      find: search,
      replace(query, replacement, caseSensitive) {
        const range = selection();
        const normalized = range ? engine.viewer!.selectRange(range).range : null;
        if (!normalized || normalized.kind !== 'text' || !findHit || findHit.query !== query || findHit.caseSensitive !== caseSensitive
          || findHit.epoch !== engine.viewer!.state().contentEpoch
          || !sameAddress(normalized.from, findHit.match.from) || !sameAddress(normalized.to, findHit.match.to)) {
          findHit = null;
          return search(query, caseSensitive, false);
        }
        if (!writable()) throw new EngineNotSupportedError('읽기 전용 문서 바꾸기');
        const hit = findHit;
        applyEdit(() => engine.viewer!.replaceMatch(hit.match, replacement, hit.epoch));
        findHit = null;
        search(query, caseSensitive, false);
        return true;
      },
      replaceAll(query, replacement, caseSensitive) {
        if (!writable()) throw new EngineNotSupportedError('읽기 전용 문서 바꾸기');
        const result = engine.viewer!.replaceAll(query, replacement, caseSensitive, selection() ?? undefined);
        applyEdit(() => result.edit);
        findHit = null;
        return result.count;
      },
      close() { findDialog = null; focusInput(); },
    }, mode);
  }
  function characterFormat(field?: 'bold' | 'italic' | 'underline') {
    const range = selection();
    if (!range) throw new EngineNotSupportedError('선택 없는 글자 서식');
    if (!isCellSelection(range) && sameAddress(range.from, range.to)) throw new EngineNotSupportedError('캐럿에서 다음 입력의 글자 서식');
    const saved = copySelection(range), instance = engine.documentInstance, epoch = engine.viewer!.state().contentEpoch;
    showHeemangCharacterFormat(patch => { ensureCurrent(instance, epoch); applyEdit(() => engine.viewer!.formatCharacters(saved, patch)); }, focusInput, field);
  }
  function paragraphFormat() {
    const range = selection();
    if (!range) throw new EngineNotSupportedError('선택 없는 문단 서식');
    const saved = copySelection(range), instance = engine.documentInstance, epoch = engine.viewer!.state().contentEpoch;
    showHeemangParagraphFormat(patch => { ensureCurrent(instance, epoch); applyEdit(() => engine.viewer!.formatParagraphs(saved, patch)); }, focusInput);
  }
  bus.on('format-char', value => {
    if (!writable()) return;
    attempt(() => {
      const range = selection();
      if (!range) throw new EngineNotSupportedError('선택 없는 글자 서식');
      const props = value as Record<string, unknown>;
      const patch: CharPatch = {};
      for (const [key, val] of Object.entries(props)) {
        if (key === 'fontSize') patch.size = val as number;
        else if (key === 'textColor' && typeof val === 'string' && /^#[0-9a-f]{6}$/i.test(val)) {
          const hex = val.slice(1); patch.color = parseInt(hex.slice(0, 2), 16) | parseInt(hex.slice(2, 4), 16) << 8 | parseInt(hex.slice(4, 6), 16) << 16;
        } else throw new EngineNotSupportedError(key);
      }
      applyEdit(() => engine.viewer!.formatCharacters(range, patch));
      focusInput();
    });
  });
  bus.on('heemang-command', payload => {
    if (!active()) return;
    const { id, params } = payload as { id: string; params?: Record<string, unknown> };
    if (!writable() && !['edit:copy', 'edit:find', 'edit:find-again', 'edit:select-all'].includes(id)) return;
    cancelComposition();
    attempt(() => {
      const range = selection();
      if (id === 'edit:find' || id === 'edit:find-replace') { openFind(id === 'edit:find' ? 'find' : 'replace'); return; }
      if (id === 'edit:find-again') { if (findDialog) findDialog.findNext(); else openFind('find'); return; }
      if (id === 'edit:copy' || id === 'edit:cut') { void systemClipboard(id === 'edit:cut').catch(error => attempt(() => { throw error; })); return; }
      if (id === 'edit:paste') { void systemPaste().catch(error => attempt(() => { throw error; })); return; }
      if (id === 'edit:select-all') {
        if (!caret) return;
        const from = { ...caret.position, para: 0 };
        const first = engine.viewer!.paragraphs(from.section, from.steps, 0, 1)[0];
        const count = engine.viewer!.getParagraphCount(from.section, from.steps);
        const last = engine.viewer!.paragraphs(from.section, from.steps, count - 1, 1)[0];
        if (first && last) showSelection({ from: { ...from, offset: first.caret[0] }, to: { ...from, para: count - 1, offset: last.caret[1] } });
        return;
      }
      if (id === 'format:char-shape') { characterFormat(); return; }
      if (id === 'format:para-shape') { paragraphFormat(); return; }
      if (['format:bold', 'format:italic', 'format:underline'].includes(id)) { characterFormat(id.slice(7) as 'bold' | 'italic' | 'underline'); return; }
      if (id === 'edit:delete' && range) { applyEdit(() => engine.viewer!.deleteForward(range)); return; }
      if (id.startsWith('format:align-') && range) {
        const align = id.slice(13) === 'split' ? 'divide' : id.slice(13);
        applyEdit(() => engine.viewer!.formatParagraphs(range, { align: align as ParaPatch['align'] })); focusInput(); return;
      }
      if (id === 'format:line-spacing' && range) { applyEdit(() => engine.viewer!.formatParagraphs(range, { lineSpacing: params?.value as number })); focusInput(); return; }
      if (id === 'format:text-color' && range) { bus.emit('format-char', { textColor: params?.color }); return; }
      throw new EngineNotSupportedError(id);
    });
  });
  bus.on('heemang-history-action', action => {
    if (!writable()) return;
    cancelComposition();
    attempt(() => applyEdit(() => action === 'redo' ? engine.viewer!.redoEdit() : engine.viewer!.undoEdit()));
    focusInput();
  });
  new MutationObserver(records => {
    if (records.some(r => (r.target instanceof HTMLCanvasElement) || [...r.addedNodes, ...r.removedNodes].some(n => n instanceof HTMLCanvasElement))) scheduleDraw();
  }).observe(container, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'data-heemang-page'] });
  bus.on('document-context-changed', () => {
    if (!active() || documentInstance !== engine.documentInstance) scheduleDraw();
  });
  bus.on('document-swapped', () => { caret = anchor = null; cells = null; rectangles = []; dragging = false; scheduleDraw(); });
  bus.on('zoom-level-display', scheduleDraw);
  bus.on('document-layout-refreshed', revealCaret);
  container.addEventListener('scroll', scheduleDraw, { passive: true });
}
