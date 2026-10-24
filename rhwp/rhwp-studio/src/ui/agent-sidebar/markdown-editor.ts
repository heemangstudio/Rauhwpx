/**
 * 서식을 보며 고치는 마크다운 편집기(contenteditable). textarea 와 비슷한 API 를 낸다.
 *
 * value 는 손대지 않았으면 넣은 문자열 그대로, 고친 뒤에는 바뀐 블록만 다시 직렬화한다
 * (markdown-model.ts). 지원하지 않는 구조는 원문 블록으로 보여 주고 그대로 저장한다.
 * 브라우저 기본 실행 취소는 직접 고친 DOM 을 따라가지 못하므로 자체 기록을 쓴다.
 */
import './markdown-editor.css';
import {
  assembleDocument,
  formatLinkDestination,
  linkHref,
  parseBlocks,
  parseInline,
  parseMarkdown,
  serializeBlocks,
  type Block,
  type BlockKind,
  type EmittedBlock,
  type Inline,
  type ListBlock,
  type ListItem,
  type OriginalBlockMeta,
} from './markdown-model.ts';
import { createIcon } from './icons.ts';
import { detectPlatformKind, formatShortcutLabel } from '../../engine/navigation-keymap.ts';

export interface MarkdownEditorOptions {
  className?: string;
  ariaLabel?: string;
  placeholder?: string;
}

export interface MarkdownEditor {
  readonly root: HTMLElement;
  value: string;
  disabled: boolean;
  readOnly: boolean;
  maxLength: number;
  placeholder: string;
  focus(): void;
  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void;
  removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void;
  destroy(): void;
}

const ZWSP = '​';
const HEADINGS = 'h1, h2, h3, h4, h5, h6';
const PARA = 'p, div:not(.ag-mde-raw)';
const TEXT_BLOCKS = `${PARA}, ${HEADINGS}`;
const BLOCK_TAGS = new Set(['P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'LI', 'BLOCKQUOTE', 'PRE', 'HR', 'TABLE']);

// ── 모델 → DOM ───────────────────────────────────────────

function renderInline(nodes: Inline[], parent: Node): void {
  for (const node of nodes) {
    switch (node.t) {
      case 'text': parent.appendChild(document.createTextNode(node.text)); break;
      case 'br': parent.appendChild(document.createElement('br')); break;
      case 'code': {
        const code = document.createElement('code');
        code.textContent = node.text;
        parent.appendChild(code);
        break;
      }
      case 'raw': {
        const span = document.createElement('span');
        span.className = 'ag-mde-raw-inline';
        span.dataset.mdRaw = '';
        span.textContent = node.text;
        parent.appendChild(span);
        break;
      }
      case 'link': {
        const a = document.createElement('a');
        const href = linkHref(node.dest);
        a.dataset.mdDest = node.dest;
        a.setAttribute('href', href);
        a.title = href;
        renderInline(node.children, a);
        parent.appendChild(a);
        break;
      }
      case 'strong':
      case 'em': {
        const el = document.createElement(node.t);
        el.dataset.mdDelim = node.delim;
        renderInline(node.children, el);
        parent.appendChild(el);
        break;
      }
    }
  }
}

/** 빈 블록에 캐럿이 설 자리 표시 br 하나를 둔다. */
function withPlaceholder<T extends HTMLElement>(el: T): T {
  const nodes = Array.from(el.childNodes);
  const empty = nodes.every((node) => node.nodeName === 'BR' || (node instanceof Text && !node.data.replaceAll(ZWSP, '')));
  if (empty && !nodes.some((node) => node instanceof Text && node.data)) el.replaceChildren(document.createElement('br'));
  return el;
}

/** 줄바꿈으로 끝나는 내용은 마지막 빈 줄이 보이도록 br 을 하나 더 둔다. */
function renderTextBlock<T extends HTMLElement>(el: T, content: Inline[]): T {
  renderInline(content, el);
  if (content.at(-1)?.t === 'br') el.appendChild(document.createElement('br'));
  return withPlaceholder(el);
}

function newParagraph(): HTMLParagraphElement {
  return withPlaceholder(document.createElement('p'));
}

function createList(ordered: boolean, marker: string, start = 1): HTMLElement {
  const list = document.createElement(ordered ? 'ol' : 'ul');
  list.dataset.mdMarker = marker;
  if (ordered && start !== 1) list.setAttribute('start', String(start));
  return list;
}

function renderList(list: ListBlock): HTMLElement {
  const el = createList(list.ordered, list.marker, list.start);
  for (const item of list.items) {
    const li = document.createElement('li');
    renderInline(item.content, li);
    if (!item.content.length || item.content.at(-1)?.t === 'br') li.appendChild(document.createElement('br'));
    for (const child of item.children) li.appendChild(renderList(child));
    el.appendChild(li);
  }
  return el;
}

function renderPlainBox(el: HTMLElement, text: string): void {
  el.textContent = text;
  if (!text || text.endsWith('\n')) el.appendChild(document.createElement('br'));
}

function renderBlock(block: Block): HTMLElement {
  switch (block.t) {
    case 'heading':
      return renderTextBlock(document.createElement(`h${Math.min(6, Math.max(1, block.level))}`), block.content);
    case 'paragraph':
      return renderTextBlock(document.createElement('p'), block.content);
    case 'list':
      return renderList(block);
    case 'quote': {
      const el = document.createElement('blockquote');
      for (const child of block.children) el.appendChild(renderBlock(child));
      if (!el.firstChild) el.appendChild(newParagraph());
      return el;
    }
    case 'code': {
      const pre = document.createElement('pre');
      pre.dataset.mdFence = block.fence;
      pre.dataset.mdInfo = block.info;
      const code = document.createElement('code');
      renderPlainBox(code, block.text);
      pre.appendChild(code);
      return pre;
    }
    case 'hr': {
      const hr = document.createElement('hr');
      hr.contentEditable = 'false';
      return hr;
    }
    case 'raw': {
      const div = document.createElement('div');
      div.className = 'ag-mde-raw';
      renderPlainBox(div, block.text);
      return div;
    }
  }
}

// ── DOM → 모델 ───────────────────────────────────────────

function isBlockNode(node: Node): boolean {
  return node instanceof HTMLElement && BLOCK_TAGS.has(node.tagName);
}

function readInline(parent: Node, out: Inline[] = []): Inline[] {
  for (const child of Array.from(parent.childNodes)) {
    if (child instanceof Text) {
      const text = child.data.replaceAll(ZWSP, '');
      if (text) out.push({ t: 'text', text });
      continue;
    }
    if (!(child instanceof HTMLElement)) continue;
    switch (child.tagName) {
      case 'BR': out.push({ t: 'br' }); break;
      case 'STRONG':
      case 'B':
        out.push({ t: 'strong', delim: child.dataset.mdDelim === '__' ? '__' : '**', children: readInline(child) });
        break;
      case 'EM':
      case 'I':
        out.push({ t: 'em', delim: child.dataset.mdDelim === '_' ? '_' : '*', children: readInline(child) });
        break;
      case 'CODE': {
        const text = (child.textContent ?? '').replaceAll(ZWSP, '');
        if (text) out.push({ t: 'code', text });
        break;
      }
      case 'A': {
        const dest = child.dataset.mdDest ?? formatLinkDestination(child.getAttribute('href') ?? '');
        out.push({ t: 'link', dest, children: readInline(child) });
        break;
      }
      case 'UL':
      case 'OL':
        break;
      default:
        if (child.dataset.mdRaw !== undefined) {
          const text = (child.textContent ?? '').replaceAll(ZWSP, '');
          if (text) out.push({ t: 'raw', text });
        } else if (isBlockNode(child)) {
          if (out.length && out.at(-1)?.t !== 'br') out.push({ t: 'br' });
          readInline(child, out);
        } else readInline(child, out);
    }
  }
  return out;
}

/** pre·원문 블록의 글자. br 은 줄바꿈, 맨 끝 br 은 자리 표시라 뺀다. */
function readPlain(el: HTMLElement): string {
  let text = '';
  let lastWasBr = false;
  const walk = (node: Node) => {
    for (const child of Array.from(node.childNodes)) {
      if (child instanceof Text) {
        text += child.data.replaceAll(ZWSP, '');
        if (child.data) lastWasBr = false;
      } else if (child instanceof HTMLElement) {
        if (child.tagName === 'BR') {
          text += '\n';
          lastWasBr = true;
        } else if (child.tagName === 'DIV' || child.tagName === 'P') {
          if (text && !text.endsWith('\n')) text += '\n';
          walk(child);
        } else walk(child);
      }
    }
  };
  walk(el);
  return lastWasBr ? text.slice(0, -1) : text;
}

function readItem(li: HTMLElement): ListItem {
  const children: ListBlock[] = [];
  for (const child of Array.from(li.children)) {
    if (child.tagName === 'UL' || child.tagName === 'OL') children.push(readList(child as HTMLElement));
  }
  return { content: readInline(li), children };
}

function readList(el: HTMLElement): ListBlock {
  const ordered = el.tagName === 'OL';
  const stored = el.dataset.mdMarker ?? '';
  const marker = ordered ? (stored === ')' ? ')' : '.') : (['-', '*', '+'].includes(stored) ? stored : '-');
  const start = ordered ? Math.max(0, parseInt(el.getAttribute('start') ?? '1', 10) || 1) : 1;
  const list: ListBlock = { t: 'list', ordered, marker, start, items: [] };
  for (const child of Array.from(el.childNodes)) {
    if (child instanceof HTMLElement && child.tagName === 'LI') list.items.push(readItem(child));
    else if (child instanceof HTMLElement && (child.tagName === 'UL' || child.tagName === 'OL')) {
      // 브라우저 들여쓰기는 목록 안에 목록을 바로 넣는다: 앞 항목의 하위 목록으로 읽는다.
      if (!list.items.length) list.items.push({ content: [], children: [] });
      list.items.at(-1)!.children.push(readList(child));
    } else if (child instanceof Text && child.data.replaceAll(ZWSP, '').trim()) {
      if (!list.items.length) list.items.push({ content: [], children: [] });
      list.items.at(-1)!.content.push({ t: 'text', text: child.data.replaceAll(ZWSP, '') });
    }
  }
  return list;
}

function readBlockElement(el: HTMLElement): Block[] {
  const tag = el.tagName;
  if (/^H[1-6]$/.test(tag)) return [{ t: 'heading', level: Number(tag[1]), content: readInline(el) }];
  switch (tag) {
    case 'UL':
    case 'OL':
      return [readList(el)];
    case 'BLOCKQUOTE':
      return [{ t: 'quote', children: readBlocksFrom(el) }];
    case 'PRE':
      return [{ t: 'code', fence: el.dataset.mdFence ?? '```', info: el.dataset.mdInfo ?? '', text: readPlain(el) }];
    case 'HR':
      return [{ t: 'hr' }];
    case 'LI':
      return [{ t: 'list', ordered: false, marker: '-', start: 1, items: [readItem(el)] }];
    case 'DIV':
      if (el.classList.contains('ag-mde-raw')) return [{ t: 'raw', text: readPlain(el) }];
      if (Array.from(el.childNodes).some(isBlockNode)) return readBlocksFrom(el);
      return [{ t: 'paragraph', content: readInline(el) }];
    default:
      return [{ t: 'paragraph', content: readInline(el) }];
  }
}

/** 컨테이너의 자식들을 블록으로. 흩어진 인라인은 문단 하나로, 흩어진 li 는 목록 하나로 묶는다. */
function readBlocksFrom(container: Node): Block[] {
  const out: Block[] = [];
  let run: Node[] = [];
  const flush = () => {
    if (!run.length) return;
    const holder = document.createElement('p');
    for (const node of run) holder.appendChild(node.cloneNode(true));
    out.push({ t: 'paragraph', content: readInline(holder) });
    run = [];
  };
  for (const child of Array.from(container.childNodes)) {
    if (isBlockNode(child)) {
      flush();
      const blocks = readBlockElement(child as HTMLElement);
      const last = out.at(-1);
      if ((child as HTMLElement).tagName === 'LI' && last?.t === 'list' && !last.ordered && blocks[0]?.t === 'list') {
        last.items.push(...blocks[0].items);
      } else out.push(...blocks);
    } else run.push(child);
  }
  flush();
  return out;
}

function topLevelMarkdown(node: Node): { markdown: string; kind: BlockKind } {
  const blocks = node instanceof HTMLElement && isBlockNode(node) ? readBlockElement(node) : readBlocksFrom(wrapRun([node]));
  return { markdown: serializeBlocks(blocks), kind: blocks[0]?.t ?? 'paragraph' };
}

function wrapRun(nodes: Node[]): HTMLElement {
  const holder = document.createElement('div');
  for (const node of nodes) holder.appendChild(node.cloneNode(true));
  return holder;
}

// ── 아이콘 ───────────────────────────────────────────────

const NS = 'http://www.w3.org/2000/svg';
const BAR_ICONS = {
  heading: 'M3.2 2.6v6.8M8.8 2.6v6.8M3.2 6h5.6',
  bold: 'M3.6 2.4h2.9a1.8 1.8 0 0 1 0 3.6H3.6zM3.6 6h3.4a1.8 1.8 0 0 1 0 3.6H3.6z',
  italic: 'M5.2 2.4h3.8M3 9.6h3.8M7.1 2.4 4.9 9.6',
  code: 'M4.4 3.4 1.9 6l2.5 2.6M7.6 3.4 10.1 6 7.6 8.6',
  bullet: 'M4.6 3h5.4M4.6 6h5.4M4.6 9h5.4M2 3h.1M2 6h.1M2 9h.1',
  ordered: 'M5 3h5M5 6h5M5 9h5M1.7 2.3l.6-.4v2.3M1.6 7.3a.65.65 0 0 1 1.25.25c0 .55-1.25.95-1.25 1.75h1.3',
  quote: 'M2.4 2.6v6.8M5 3.6h4.8M5 6h4.8M5 8.4h3',
  codeBlock: 'M1.9 2.2h8.2v7.6H1.9zM4.7 4.5 3.5 6l1.2 1.5M7.3 4.5 8.5 6 7.3 7.5',
} as const;

function barIcon(name: keyof typeof BAR_ICONS): SVGSVGElement {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', 'ag-icon');
  svg.setAttribute('viewBox', '0 0 12 12');
  svg.setAttribute('width', '12');
  svg.setAttribute('height', '12');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', BAR_ICONS[name]);
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', name === 'bold' ? '1.45' : '1.25');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  svg.appendChild(path);
  return svg;
}

// ── 편집기 ───────────────────────────────────────────────

type Command = 'heading' | 'bold' | 'italic' | 'code' | 'bullet' | 'ordered' | 'quote' | 'link' | 'codeBlock';

interface Snapshot { html: string; sel: [number[], number, number[], number] | null }

export function createMarkdownEditor(options: MarkdownEditorOptions = {}): MarkdownEditor {
  const isMac = detectPlatformKind() === 'mac';
  const root = document.createElement('div');
  root.className = options.className ? `ag-mde ${options.className}` : 'ag-mde';

  const surface = document.createElement('div');
  surface.className = 'ag-mde-surface';
  surface.contentEditable = 'true';
  surface.spellcheck = false;
  surface.setAttribute('role', 'textbox');
  surface.setAttribute('aria-multiline', 'true');
  if (options.ariaLabel) surface.setAttribute('aria-label', options.ariaLabel);

  const source = document.createElement('textarea');
  source.className = 'ag-mde-source';
  source.hidden = true;
  source.spellcheck = false;
  if (options.ariaLabel) source.setAttribute('aria-label', `${options.ariaLabel} 원문`);

  const linkBar = document.createElement('div');
  linkBar.className = 'ag-mde-linkbar';
  linkBar.hidden = true;
  const linkInput = document.createElement('input');
  linkInput.type = 'url';
  linkInput.className = 'ag-mde-link-input';
  linkInput.placeholder = 'https://';
  linkInput.setAttribute('aria-label', '링크 주소');
  linkInput.spellcheck = false;
  const linkApply = document.createElement('button');
  linkApply.type = 'button';
  linkApply.className = 'ag-mde-link-btn';
  linkApply.textContent = '적용';
  const linkRemove = document.createElement('button');
  linkRemove.type = 'button';
  linkRemove.className = 'ag-mde-link-btn';
  linkRemove.textContent = '링크 제거';
  linkBar.append(linkInput, linkApply, linkRemove);

  const bar = document.createElement('div');
  bar.className = 'ag-mde-bar';
  bar.setAttribute('role', 'toolbar');
  bar.setAttribute('aria-label', '서식');
  const buttons = new Map<Command, HTMLButtonElement>();
  const shortcut = (label: string) => formatShortcutLabel(label, isMac ? 'mac' : 'other');
  const groups: Array<Array<[Command, string, string | null, () => SVGSVGElement]>> = [
    [
      ['heading', '제목', 'Ctrl+Alt+1–3', () => barIcon('heading')],
      ['bold', '굵게', 'Ctrl+B', () => barIcon('bold')],
      ['italic', '기울임', 'Ctrl+I', () => barIcon('italic')],
      ['code', '코드', 'Ctrl+E', () => barIcon('code')],
    ],
    [
      ['bullet', '글머리 목록', 'Ctrl+Shift+8', () => barIcon('bullet')],
      ['ordered', '번호 목록', 'Ctrl+Shift+7', () => barIcon('ordered')],
      ['quote', '인용', 'Ctrl+Shift+9', () => barIcon('quote')],
    ],
    [
      ['link', '링크', 'Ctrl+K', () => createIcon('link')],
      ['codeBlock', '코드 블록', 'Ctrl+Alt+C', () => barIcon('codeBlock')],
    ],
  ];
  groups.forEach((group, index) => {
    if (index) {
      const sep = document.createElement('span');
      sep.className = 'ag-mde-sep';
      sep.setAttribute('aria-hidden', 'true');
      bar.appendChild(sep);
    }
    for (const [command, label, keys, icon] of group) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'ag-mde-btn';
      button.dataset.command = command;
      const title = keys ? `${label} (${shortcut(keys)})` : label;
      button.title = title;
      button.setAttribute('aria-label', title);
      button.setAttribute('aria-pressed', 'false');
      button.tabIndex = buttons.size === 0 ? 0 : -1;
      button.appendChild(icon());
      if (command === 'heading') {
        const level = document.createElement('span');
        level.className = 'ag-mde-level';
        level.setAttribute('aria-hidden', 'true');
        button.appendChild(level);
      }
      buttons.set(command, button);
      bar.appendChild(button);
    }
  });
  const spacer = document.createElement('span');
  spacer.className = 'ag-mde-spacer';
  const sourceToggle = document.createElement('button');
  sourceToggle.type = 'button';
  sourceToggle.className = 'ag-mde-btn ag-mde-source-toggle';
  sourceToggle.textContent = 'Md';
  sourceToggle.title = '마크다운 원문 보기';
  sourceToggle.setAttribute('aria-pressed', 'false');
  sourceToggle.tabIndex = -1;
  bar.append(spacer, sourceToggle);
  const barButtons = () => [...buttons.values(), sourceToggle];

  root.append(surface, source, linkBar, bar);

  // ── 상태 ──
  let original = '';
  let metas: OriginalBlockMeta[] = [];
  let tail = '';
  let eol: '\n' | '\r\n' = '\n';
  let gen = 0;
  let dirty = false;
  let cache: string | null = null;
  let disabled = false;
  let readOnly = false;
  let maxLength = -1;
  let placeholder = options.placeholder ?? '';
  let sourceMode = false;
  let sourceBaseline = '';
  let history: Snapshot[] = [];
  let historyIndex = 0;
  let lastKind: 'typing' | 'other' = 'other';
  let lastTypingAt = 0;
  let lastRange: Range | null = null;
  let linkRange: Range | null = null;
  let editingLink: HTMLAnchorElement | null = null;
  let internalDrag = false;
  let wasConnected = false;
  let destroyed = false;

  surface.dataset.placeholder = placeholder;
  source.placeholder = placeholder;

  const editable = () => !disabled && !readOnly && !sourceMode;

  // ── 선택 영역 도우미 ──
  function currentRange(): Range | null {
    const selection = document.getSelection();
    if (!selection?.rangeCount) return null;
    const range = selection.getRangeAt(0);
    return surface.contains(range.startContainer) && surface.contains(range.endContainer) ? range : null;
  }

  function closestIn(node: Node | null, selector: string): HTMLElement | null {
    const el = node instanceof Element ? node : node?.parentElement;
    const found = el?.closest(selector) as HTMLElement | null | undefined;
    return found && found !== surface && surface.contains(found) ? found : null;
  }

  function topBlock(node: Node | null): HTMLElement | null {
    let current = node;
    while (current && current.parentNode !== surface) current = current.parentNode;
    return current instanceof HTMLElement ? current : null;
  }

  function setCaret(node: Node, offset: number): void {
    const selection = document.getSelection();
    if (!selection) return;
    const range = document.createRange();
    range.setStart(node, Math.min(offset, node instanceof Text ? node.length : node.childNodes.length));
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  function caretToEnd(el: Node): void {
    let index = el.childNodes.length;
    if (el.lastChild?.nodeName === 'BR') index -= 1;
    const last = index > 0 ? el.childNodes[index - 1] : null;
    if (last instanceof Text) setCaret(last, last.length);
    else setCaret(el, index);
  }

  function caretToStart(el: Node): void {
    const first = el.firstChild;
    if (first instanceof Text) setCaret(first, 0);
    else setCaret(el, 0);
  }

  interface SavedSelection { an: Node; ao: number; fn: Node; fo: number }

  function saveSelection(): SavedSelection | null {
    const selection = document.getSelection();
    if (!selection?.anchorNode || !selection.focusNode || !surface.contains(selection.anchorNode)) return null;
    return { an: selection.anchorNode, ao: selection.anchorOffset, fn: selection.focusNode, fo: selection.focusOffset };
  }

  function restoreSelection(saved: SavedSelection | null, fallback?: Node, map?: Map<Node, Node>): void {
    const pick = (node: Node) => map?.get(node) ?? node;
    if (saved) {
      const an = pick(saved.an);
      const fn = pick(saved.fn);
      if (surface.contains(an) && surface.contains(fn)) {
        const clamp = (node: Node, offset: number) =>
          Math.min(offset, node instanceof Text ? node.length : node.childNodes.length);
        document.getSelection()?.setBaseAndExtent(an, clamp(an, saved.ao), fn, clamp(fn, saved.fo));
        return;
      }
    }
    if (fallback && surface.contains(fallback)) caretToEnd(fallback);
  }

  function textBefore(block: Node, range: Range): string {
    const probe = document.createRange();
    probe.selectNodeContents(block);
    probe.setEnd(range.startContainer, range.startOffset);
    return probe.toString().replaceAll(ZWSP, '');
  }

  function ownText(el: HTMLElement): string {
    let text = '';
    for (const child of Array.from(el.childNodes)) {
      if (child instanceof HTMLElement && (child.tagName === 'UL' || child.tagName === 'OL')) continue;
      text += child.textContent ?? '';
    }
    return text.replaceAll(ZWSP, '');
  }

  function isAtStart(block: HTMLElement, range: Range): boolean {
    return range.collapsed && textBefore(block, range) === '';
  }

  function isAtEnd(block: HTMLElement, range: Range): boolean {
    if (!range.collapsed) return false;
    const probe = document.createRange();
    probe.selectNodeContents(block);
    const nested = Array.from(block.children).find((child) => child.tagName === 'UL' || child.tagName === 'OL');
    if (nested) probe.setEndBefore(nested);
    probe.setStart(range.startContainer, range.startOffset);
    return probe.toString().replaceAll(ZWSP, '') === '';
  }

  function retag(el: HTMLElement, tag: string): HTMLElement {
    if (el.tagName.toLowerCase() === tag) return el;
    const saved = saveSelection();
    const next = document.createElement(tag);
    if (el.dataset.mdid) next.dataset.mdid = el.dataset.mdid;
    while (el.firstChild) next.appendChild(el.firstChild);
    withPlaceholder(next);
    el.replaceWith(next);
    restoreSelection(saved, next, new Map([[el, next]]));
    return next;
  }

  /** 시작이 같은 부모 안의 글 블록(문단·제목)들. */
  function selectedTextBlocks(range: Range): HTMLElement[] {
    const start = closestIn(range.startContainer, TEXT_BLOCKS);
    if (!start || closestIn(start, 'li, pre')) return [];
    const end = closestIn(range.endContainer, TEXT_BLOCKS);
    if (!end || end.parentElement !== start.parentElement) return [start];
    const out: HTMLElement[] = [];
    for (let node: Element | null = start; node; node = node.nextElementSibling) {
      if (node.matches(TEXT_BLOCKS)) out.push(node as HTMLElement);
      if (node === end) break;
    }
    return out;
  }

  function selectedItems(range: Range): HTMLElement[] {
    const anchor = closestIn(range.startContainer, 'li');
    if (range.collapsed || !anchor) return anchor ? [anchor] : [];
    const all = Array.from(surface.querySelectorAll('li')).filter((li) => range.intersectsNode(li));
    return all.filter((li) => !all.some((other) => other !== li && other.contains(li)));
  }

  // ── 변경 기록 ──
  function nodePath(node: Node): number[] {
    const path: number[] = [];
    let current: Node | null = node;
    while (current && current !== surface) {
      const parent: Node | null = current.parentNode;
      if (!parent) return [];
      path.unshift(Array.prototype.indexOf.call(parent.childNodes, current));
      current = parent;
    }
    return path;
  }

  function nodeAt(path: number[]): Node | null {
    let current: Node | null = surface;
    for (const index of path) current = current?.childNodes[index] ?? null;
    return current;
  }

  function snapshot(): Snapshot {
    const selection = document.getSelection();
    const sel: Snapshot['sel'] = selection?.anchorNode && selection.focusNode && surface.contains(selection.anchorNode)
      && surface.contains(selection.focusNode)
      ? [nodePath(selection.anchorNode), selection.anchorOffset, nodePath(selection.focusNode), selection.focusOffset]
      : null;
    return { html: surface.innerHTML, sel };
  }

  function record(kind: 'typing' | 'other'): void {
    const snap = snapshot();
    const now = Date.now();
    if (kind === 'typing' && lastKind === 'typing' && now - lastTypingAt < 1000 && historyIndex > 0
      && historyIndex === history.length - 1) {
      history[historyIndex] = snap;
    } else {
      history.splice(historyIndex + 1);
      history.push(snap);
      if (history.length > 300) history.shift();
      historyIndex = history.length - 1;
    }
    lastKind = kind;
    lastTypingAt = now;
  }

  function applySnapshot(snap: Snapshot): void {
    surface.innerHTML = snap.html;
    cache = null;
    if (snap.sel) {
      const an = nodeAt(snap.sel[0]);
      const fn = nodeAt(snap.sel[2]);
      if (an && fn) {
        try {
          document.getSelection()?.setBaseAndExtent(an, snap.sel[1], fn, snap.sel[3]);
        } catch {
          caretToEnd(surface.lastChild ?? surface);
        }
      }
    }
  }

  function emitInput(): void {
    root.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function stepHistory(delta: number): void {
    const next = historyIndex + delta;
    if (next < 0 || next >= history.length) return;
    historyIndex = next;
    applySnapshot(history[next]);
    dirty = true;
    lastKind = 'other';
    emitInput();
    scheduleState();
  }

  /** 직접 고친 DOM 을 기록하고 바깥에 알린다. */
  function changed(): void {
    cache = null;
    dirty = true;
    normalizeTop();
    if (exceedsMax()) {
      applySnapshot(history[historyIndex]);
      return;
    }
    record('other');
    emitInput();
    scheduleState();
  }

  function exceedsMax(): boolean {
    return maxLength >= 0 && computeValue().length > maxLength;
  }

  /** 최상위에 흩어진 글자·인라인을 문단으로 감싸고, 빈 편집기에는 빈 문단을 둔다. */
  function normalizeTop(): void {
    const children = Array.from(surface.childNodes);
    if (!children.some((node) => isBlockNode(node) || (node.textContent ?? '').replaceAll(ZWSP, ''))) {
      const p = newParagraph();
      surface.replaceChildren(p);
      setCaret(p, 0);
      return;
    }
    let run: Node[] = [];
    const saved = saveSelection();
    let wrapped = false;
    const flush = () => {
      if (!run.length) return;
      if (run.every((node) => node instanceof Text && !node.data.trim())) {
        run.forEach((node) => (node as ChildNode).remove());
      } else {
        const p = document.createElement('p');
        run[0].parentNode!.insertBefore(p, run[0]);
        for (const node of run) p.appendChild(node);
        wrapped = true;
      }
      run = [];
    };
    for (const node of children) {
      if (isBlockNode(node)) flush();
      else run.push(node);
    }
    flush();
    if (wrapped) restoreSelection(saved);
  }

  // ── 값 ──
  function load(text: string): void {
    original = text;
    const doc = parseMarkdown(text);
    gen += 1;
    tail = doc.tail;
    eol = doc.eol;
    surface.replaceChildren();
    const elements = doc.blocks.map((block, index) => {
      const el = renderBlock(block.block);
      el.dataset.mdid = `${gen}:${index}`;
      surface.appendChild(el);
      return el;
    });
    metas = doc.blocks.map((block, index) => ({
      src: block.src,
      before: block.before,
      canon: topLevelMarkdown(elements[index]).markdown,
      kind: block.block.t,
    }));
    if (!surface.firstChild) surface.appendChild(newParagraph());
    dirty = false;
    cache = text;
    history = [snapshot()];
    historyIndex = 0;
    lastKind = 'other';
    scheduleState();
  }

  function originOf(node: Node): number | null {
    if (!(node instanceof HTMLElement)) return null;
    const [g, index] = (node.dataset.mdid ?? '').split(':');
    return Number(g) === gen && index !== undefined && metas[Number(index)] ? Number(index) : null;
  }

  function computeValue(): string {
    if (!dirty) return original;
    if (cache !== null) return cache;
    const emitted: EmittedBlock[] = [];
    let run: Node[] = [];
    const flush = () => {
      if (!run.length) return;
      const { markdown, kind } = topLevelMarkdown(wrapRun(run));
      emitted.push({ markdown, kind, origin: null });
      run = [];
    };
    for (const node of Array.from(surface.childNodes)) {
      if (!isBlockNode(node)) { run.push(node); continue; }
      flush();
      const { markdown, kind } = topLevelMarkdown(node);
      emitted.push({ markdown, kind, origin: originOf(node) });
    }
    flush();
    cache = assembleDocument(emitted, metas, tail, eol);
    return cache;
  }

  // ── 목록 들여쓰기 ──
  function indentItem(li: HTMLElement): boolean {
    const prev = li.previousElementSibling as HTMLElement | null;
    const list = li.parentElement;
    if (!prev || prev.tagName !== 'LI' || !list) return false;
    const saved = saveSelection();
    let sub = prev.lastElementChild as HTMLElement | null;
    if (!sub || sub.tagName !== list.tagName) {
      sub = createList(list.tagName === 'OL', list.dataset.mdMarker ?? (list.tagName === 'OL' ? '.' : '-'));
      if (prev.lastChild?.nodeName === 'BR' && prev.childNodes.length > 1) prev.lastChild.remove();
      prev.appendChild(sub);
    }
    sub.appendChild(li);
    restoreSelection(saved, li);
    return true;
  }

  /** 한 단계 내어 쓴다. 최상위 항목은 문단이 되고 목록이 그 자리에서 나뉜다. */
  function outdentItem(li: HTMLElement): HTMLElement | null {
    const list = li.parentElement;
    if (!list) return null;
    const saved = saveSelection();
    const following: Element[] = [];
    for (let node = li.nextElementSibling; node; node = node.nextElementSibling) following.push(node);
    const parentLi = list.parentElement?.tagName === 'LI' ? list.parentElement : null;
    if (parentLi) {
      if (following.length) {
        let sub = li.lastElementChild as HTMLElement | null;
        if (!sub || sub.tagName !== list.tagName) {
          sub = createList(list.tagName === 'OL', list.dataset.mdMarker ?? '-');
          li.appendChild(sub);
        }
        for (const node of following) sub.appendChild(node);
      }
      parentLi.after(li);
      if (!list.children.length) list.remove();
      restoreSelection(saved, li);
      return li;
    }
    const p = document.createElement('p');
    const nested: HTMLElement[] = [];
    for (const child of Array.from(li.childNodes)) {
      if (child instanceof HTMLElement && (child.tagName === 'UL' || child.tagName === 'OL')) nested.push(child);
      else p.appendChild(child);
    }
    withPlaceholder(p);
    const container = list.parentNode!;
    const anchor = list.nextSibling;
    container.insertBefore(p, anchor);
    for (const sub of nested) container.insertBefore(sub, anchor);
    if (following.length) {
      const start = list.tagName === 'OL'
        ? (parseInt(list.getAttribute('start') ?? '1', 10) || 1) + Array.from(list.children).indexOf(li) + 1
        : 1;
      const rest = createList(list.tagName === 'OL', list.dataset.mdMarker ?? '-', start);
      for (const node of following) rest.appendChild(node);
      container.insertBefore(rest, anchor);
    }
    li.remove();
    if (!list.children.length) list.remove();
    restoreSelection(saved, p);
    return p;
  }

  // ── 명령 ──
  function ensureRange(): Range | null {
    let range = currentRange();
    if (!range && lastRange && surface.contains(lastRange.startContainer)) {
      surface.focus({ preventScroll: true });
      document.getSelection()?.removeAllRanges();
      document.getSelection()?.addRange(lastRange);
      range = currentRange();
    }
    return range;
  }

  function setHeading(level: number | 'cycle'): void {
    const range = ensureRange();
    if (!range) return;
    const blocks = selectedTextBlocks(range);
    if (!blocks.length) return;
    const current = /^H([1-6])$/.exec(blocks[0].tagName);
    const now = current ? Number(current[1]) : 0;
    const next = level === 'cycle' ? (now === 0 ? 1 : now === 1 ? 2 : now === 2 ? 3 : 0) : level;
    for (const block of blocks) retag(block, next ? `h${next}` : 'p');
    changed();
  }

  function toggleList(ordered: boolean): void {
    const range = ensureRange();
    if (!range) return;
    const items = selectedItems(range);
    if (items.length) {
      const list = items[0].parentElement!;
      if ((list.tagName === 'OL') === ordered) {
        for (const li of items) {
          let current: HTMLElement | null = li;
          while (current && current.isConnected && current.tagName === 'LI') current = outdentItem(current);
        }
      } else {
        const saved = saveSelection();
        const next = createList(ordered, ordered ? '.' : '-');
        if (list.dataset.mdid) next.dataset.mdid = list.dataset.mdid;
        while (list.firstChild) next.appendChild(list.firstChild);
        list.replaceWith(next);
        restoreSelection(saved);
      }
      changed();
      return;
    }
    const blocks = selectedTextBlocks(range);
    if (!blocks.length) return;
    const saved = saveSelection();
    const prev = blocks[0].previousElementSibling as HTMLElement | null;
    const tag = ordered ? 'OL' : 'UL';
    const list = prev && prev.tagName === tag ? prev : createList(ordered, ordered ? '.' : '-');
    if (list !== prev) blocks[0].before(list);
    for (const block of blocks) {
      const li = document.createElement('li');
      while (block.firstChild) li.appendChild(block.firstChild);
      withPlaceholder(li);
      list.appendChild(li);
      block.remove();
    }
    restoreSelection(saved, list.lastElementChild ?? list);
    changed();
  }

  function toggleQuote(): void {
    const range = ensureRange();
    if (!range) return;
    const saved = saveSelection();
    const quote = closestIn(range.startContainer, 'blockquote');
    if (quote) {
      while (quote.firstChild) quote.before(quote.firstChild);
      quote.remove();
      restoreSelection(saved);
      changed();
      return;
    }
    const first = topBlock(range.startContainer);
    const last = topBlock(range.endContainer) ?? first;
    if (!first || first.classList.contains('ag-mde-raw') || first.tagName === 'HR') return;
    const blocks: HTMLElement[] = [];
    for (let node: Element | null = first; node; node = node.nextElementSibling) {
      blocks.push(node as HTMLElement);
      if (node === last) break;
    }
    const wrapper = document.createElement('blockquote');
    first.before(wrapper);
    for (const block of blocks) wrapper.appendChild(block);
    restoreSelection(saved, wrapper);
    changed();
  }

  function plainOfBlock(el: HTMLElement): string {
    return splitLinesText(el).join('\n');
  }

  function splitLinesText(el: HTMLElement): string[] {
    let text = '';
    for (const node of Array.from(el.childNodes)) {
      if (node.nodeName === 'BR') text += '\n';
      else text += (node.textContent ?? '').replaceAll(ZWSP, '');
    }
    return text.replace(/\n$/, '').split('\n');
  }

  function toggleCodeBlock(): void {
    const range = ensureRange();
    if (!range) return;
    const pre = closestIn(range.startContainer, 'pre');
    if (pre) {
      const lines = readPlain(pre).split('\n');
      const paragraphs = lines.map((line) => {
        const p = document.createElement('p');
        if (line) p.textContent = line;
        return withPlaceholder(p);
      });
      pre.before(...paragraphs);
      pre.remove();
      caretToEnd(paragraphs.at(-1)!);
      changed();
      return;
    }
    const blocks = selectedTextBlocks(range);
    if (!blocks.length) return;
    const text = blocks.map(plainOfBlock).join('\n');
    const next = renderBlock({ t: 'code', fence: '```', info: '', text });
    blocks[0].replaceWith(next);
    blocks.slice(1).forEach((block) => block.remove());
    caretToEnd(next.querySelector('code') ?? next);
    changed();
  }

  function toggleInlineCode(): void {
    const range = ensureRange();
    if (!range || closestIn(range.startContainer, 'pre, .ag-mde-raw')) return;
    const code = closestIn(range.startContainer, 'code');
    if (code) {
      const saved = saveSelection();
      while (code.firstChild) code.before(code.firstChild);
      code.remove();
      restoreSelection(saved);
      changed();
      return;
    }
    const el = document.createElement('code');
    if (range.collapsed) {
      el.textContent = ZWSP;
      range.insertNode(el);
      setCaret(el.firstChild!, 1);
    } else {
      if (topBlock(range.startContainer) !== topBlock(range.endContainer)
        || closestIn(range.startContainer, 'li') !== closestIn(range.endContainer, 'li')) return;
      const text = range.toString().replaceAll(ZWSP, '');
      if (!text || text.includes('\n')) return;
      range.deleteContents();
      el.textContent = text;
      range.insertNode(el);
      if (!(el.nextSibling instanceof Text)) el.after(document.createTextNode(ZWSP));
      const selection = document.getSelection();
      const select = document.createRange();
      select.selectNodeContents(el);
      selection?.removeAllRanges();
      selection?.addRange(select);
    }
    changed();
  }

  function run(command: Command): void {
    if (!editable()) return;
    switch (command) {
      case 'heading': setHeading('cycle'); break;
      case 'bold':
      case 'italic': {
        const range = ensureRange();
        if (!range || closestIn(range.startContainer, 'pre, .ag-mde-raw')) return;
        // 제목은 이미 굵다. 브라우저 굵게 전환이 제목 안에서 태그를 겹쳐 만든다.
        if (command === 'bold' && closestIn(range.startContainer, HEADINGS)) return;
        document.execCommand(command);
        break;
      }
      case 'code': toggleInlineCode(); break;
      case 'bullet': toggleList(false); break;
      case 'ordered': toggleList(true); break;
      case 'quote': toggleQuote(); break;
      case 'link': openLinkBar(); return;
      case 'codeBlock': toggleCodeBlock(); break;
    }
    if (!sourceMode) surface.focus({ preventScroll: true });
    scheduleState();
  }

  // ── 링크 ──
  function openLinkBar(): void {
    const range = ensureRange();
    if (!range || closestIn(range.startContainer, 'pre, .ag-mde-raw, code')) return;
    linkRange = range.cloneRange();
    editingLink = closestIn(range.startContainer, 'a') as HTMLAnchorElement | null;
    linkInput.value = editingLink ? linkHref(editingLink.dataset.mdDest ?? editingLink.getAttribute('href') ?? '') : '';
    linkRemove.hidden = !editingLink;
    linkBar.hidden = false;
    linkInput.focus();
    linkInput.select();
  }

  function closeLinkBar(refocus: boolean): void {
    linkBar.hidden = true;
    if (refocus && linkRange) {
      surface.focus({ preventScroll: true });
      const selection = document.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(linkRange);
    }
  }

  function applyLink(): void {
    const url = linkInput.value.trim();
    const range = linkRange;
    const link = editingLink;
    closeLinkBar(true);
    if (!range || !editable()) return;
    if (!url) {
      if (link) unwrapLink(link);
      return;
    }
    const dest = formatLinkDestination(url);
    if (link && link.isConnected) {
      link.dataset.mdDest = dest;
      link.setAttribute('href', url);
      link.title = url;
      changed();
      return;
    }
    const a = document.createElement('a');
    a.dataset.mdDest = dest;
    a.setAttribute('href', url);
    a.title = url;
    if (range.collapsed) a.textContent = url;
    else {
      if (topBlock(range.startContainer) !== topBlock(range.endContainer)
        || closestIn(range.startContainer, 'li') !== closestIn(range.endContainer, 'li')) return;
      a.appendChild(range.extractContents());
    }
    range.insertNode(a);
    if (!(a.nextSibling instanceof Text)) a.after(document.createTextNode(ZWSP));
    const next = a.nextSibling as Text;
    setCaret(next, next.data.startsWith(ZWSP) ? 1 : 0);
    changed();
  }

  function unwrapLink(link: HTMLElement): void {
    if (!link.isConnected) return;
    const saved = saveSelection();
    while (link.firstChild) link.before(link.firstChild);
    link.remove();
    restoreSelection(saved);
    changed();
  }

  linkInput.addEventListener('keydown', (event) => {
    if (event.isComposing) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      applyLink();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closeLinkBar(true);
    }
  });
  linkApply.addEventListener('click', applyLink);
  // 바깥을 누르거나 초점이 링크 줄을 떠나면 닫는다. 줄 안의 단추로 옮길 때는 그대로 둔다.
  linkBar.addEventListener('focusout', (event) => {
    if (linkBar.hidden) return;
    const next = event.relatedTarget as Node | null;
    if (next && linkBar.contains(next)) return;
    closeLinkBar(false);
  });
  linkRemove.addEventListener('click', () => {
    const link = editingLink;
    closeLinkBar(true);
    if (link) unwrapLink(link);
  });

  // ── 입력 규칙 ──
  function removeLeading(el: HTMLElement, count: number): void {
    let left = count;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    while (left > 0) {
      const node = walker.nextNode() as Text | null;
      if (!node) break;
      const take = Math.min(left, node.length);
      node.deleteData(0, take);
      left -= take;
    }
    if (!(el.textContent ?? '').replaceAll(ZWSP, '')) {
      el.replaceChildren(document.createElement('br'));
      setCaret(el, 0);
    }
  }

  function blockRule(range: Range): boolean {
    const p = closestIn(range.startContainer, PARA);
    if (!p || closestIn(p, 'li, pre') || !(p.parentElement === surface || p.parentElement?.tagName === 'BLOCKQUOTE')) return false;
    const before = textBefore(p, range).replace(/ /g, ' ');
    const topLevel = p.parentElement === surface;
    const heading = /^(#{1,6}) $/.exec(before);
    if (heading && topLevel) {
      removeLeading(p, before.length);
      retag(p, `h${heading[1].length}`);
      return true;
    }
    const bullet = /^([-*+]) $/.exec(before);
    const ordered = /^(\d{1,9})([.)]) $/.exec(before);
    if (bullet || ordered) {
      removeLeading(p, before.length);
      const isOrdered = Boolean(ordered);
      const marker = ordered ? ordered[2] : bullet![1];
      const saved = saveSelection();
      const li = document.createElement('li');
      while (p.firstChild) li.appendChild(p.firstChild);
      withPlaceholder(li);
      const prev = p.previousElementSibling as HTMLElement | null;
      if (prev && prev.tagName === (isOrdered ? 'OL' : 'UL') && (prev.dataset.mdMarker ?? '') === marker) {
        prev.appendChild(li);
        p.remove();
      } else {
        const list = createList(isOrdered, marker, ordered ? parseInt(ordered[1], 10) : 1);
        list.appendChild(li);
        p.replaceWith(list);
      }
      restoreSelection(saved, li, new Map([[p, li]]));
      if (!currentRange()) caretToStart(li);
      return true;
    }
    if (/^> $/.test(before) && topLevel) {
      removeLeading(p, before.length);
      const saved = saveSelection();
      const quote = document.createElement('blockquote');
      p.replaceWith(quote);
      quote.appendChild(p);
      restoreSelection(saved, p);
      return true;
    }
    return false;
  }

  function inlineRule(range: Range, ch: string): boolean {
    const node = range.startContainer;
    if (!(node instanceof Text) || closestIn(node, 'code, pre, .ag-mde-raw, [data-md-raw]')) return false;
    const text = node.data.slice(0, range.startOffset);
    let m: RegExpExecArray | null = null;
    let tag = '';
    let delim = '';
    if (ch === '*') {
      m = /(^|[^*\\])\*\*([^*\s](?:[^*]*[^*\s])?)\*\*$/.exec(text);
      if (m) { tag = 'strong'; delim = '**'; } else {
        m = /(^|[^*\\])\*([^*\s](?:[^*]*[^*\s])?)\*$/.exec(text);
        if (m) { tag = 'em'; delim = '*'; }
      }
    } else if (ch === '_') {
      m = /(^|[^\p{L}\p{N}_\\])__([^_\s](?:[^_]*[^_\s])?)__$/u.exec(text);
      if (m) { tag = 'strong'; delim = '__'; } else {
        m = /(^|[^\p{L}\p{N}_\\])_([^_\s](?:[^_]*[^_\s])?)_$/u.exec(text);
        if (m) { tag = 'em'; delim = '_'; }
      }
    } else if (ch === '`') {
      m = /(^|[^`\\])`([^`]+)`$/.exec(text);
      if (m) tag = 'code';
    }
    if (!m) return false;
    const start = m.index + m[1].length;
    const after = node.splitText(range.startOffset);
    const middle = node.splitText(start);
    const el = document.createElement(tag);
    if (delim) el.dataset.mdDelim = delim;
    el.textContent = m[2];
    middle.replaceWith(el);
    after.insertData(0, ZWSP);
    setCaret(after, 1);
    return true;
  }

  function insertTextAtCaret(range: Range, text: string, box: HTMLElement): void {
    range.deleteContents();
    const node = range.startContainer;
    if (node instanceof Text) {
      const offset = range.startOffset;
      node.insertData(offset, text);
      setCaret(node, offset + text.length);
    } else {
      const textNode = document.createTextNode(text);
      range.insertNode(textNode);
      setCaret(textNode, text.length);
    }
    // 끝에 새 줄이 생기면 보이도록 자리 표시 br 을 둔다.
    const inner = box.tagName === 'PRE' ? (box.querySelector('code') ?? box) : box;
    let last: Node | null = inner.lastChild;
    while (last instanceof Text && !last.data) last = last.previousSibling;
    if (last?.nodeName !== 'BR' && readPlain(box).endsWith('\n')) inner.appendChild(document.createElement('br'));
  }

  function insertBreak(range: Range): void {
    range.deleteContents();
    const br = document.createElement('br');
    range.insertNode(br);
    let next: Node | null = br.nextSibling;
    while (next instanceof Text && !next.data.replaceAll(ZWSP, '')) next = next.nextSibling;
    if (!next || next.nodeName === 'UL' || next.nodeName === 'OL') br.after(document.createElement('br'));
    const after = br.nextSibling;
    if (after instanceof Text) setCaret(after, 0);
    else setCaret(br.parentNode!, Array.prototype.indexOf.call(br.parentNode!.childNodes, br) + 1);
  }

  function handleEnter(event: KeyboardEvent, range: Range): void {
    const box = closestIn(range.startContainer, 'pre, .ag-mde-raw');
    if (box) {
      event.preventDefault();
      const text = readPlain(box);
      if (box.tagName === 'PRE' && isAtEnd(box, range) && (text === '' || text.endsWith('\n'))) {
        // 빈 마지막 줄에서 Enter: 코드 블록을 나간다.
        const code = box.querySelector('code') ?? box;
        renderPlainBox(code as HTMLElement, text.replace(/\n$/, ''));
        const p = newParagraph();
        box.after(p);
        setCaret(p, 0);
      } else insertTextAtCaret(range, '\n', box);
      changed();
      return;
    }
    const li = closestIn(range.startContainer, 'li');
    if (li && !ownText(li).trim() && !li.querySelector('ul, ol')) {
      event.preventDefault();
      const result = outdentItem(li);
      if (result) caretToStart(result);
      changed();
      return;
    }
    if (li) return;
    const p = closestIn(range.startContainer, PARA);
    if (p?.parentElement?.tagName === 'BLOCKQUOTE' && !ownText(p).trim()) {
      event.preventDefault();
      const quote = p.parentElement;
      const following: Element[] = [];
      for (let node = p.nextElementSibling; node; node = node.nextElementSibling) following.push(node);
      quote.after(p);
      if (following.length) {
        const rest = document.createElement('blockquote');
        for (const node of following) rest.appendChild(node);
        p.after(rest);
      }
      if (!quote.children.length) quote.remove();
      setCaret(p, 0);
      changed();
      return;
    }
    if (p && p.parentElement === surface) {
      const text = ownText(p).trim();
      const fence = /^(`{3,}|~{3,})([^`]*)$/.exec(text);
      if (fence) {
        event.preventDefault();
        const pre = renderBlock({ t: 'code', fence: fence[1], info: fence[2].trim(), text: '' });
        p.replaceWith(pre);
        setCaret(pre.querySelector('code')!, 0);
        changed();
        return;
      }
      if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(text)) {
        event.preventDefault();
        const hr = renderBlock({ t: 'hr' });
        const next = newParagraph();
        p.replaceWith(hr);
        hr.after(next);
        setCaret(next, 0);
        changed();
        return;
      }
    }
    const heading = closestIn(range.startContainer, HEADINGS);
    if (heading && isAtEnd(heading, range)) {
      event.preventDefault();
      if (!ownText(heading).trim()) {
        const p2 = retag(heading, 'p');
        setCaret(p2, 0);
      } else {
        const next = newParagraph();
        heading.after(next);
        setCaret(next, 0);
      }
      changed();
    }
  }

  function handleBackspace(event: KeyboardEvent, range: Range): void {
    if (!range.collapsed) return;
    const heading = closestIn(range.startContainer, HEADINGS);
    if (heading && isAtStart(heading, range)) {
      event.preventDefault();
      retag(heading, 'p');
      changed();
      return;
    }
    const li = closestIn(range.startContainer, 'li');
    if (li && isAtStart(li, range)) {
      event.preventDefault();
      const result = outdentItem(li);
      if (result && !currentRange()) caretToStart(result);
      changed();
      return;
    }
    if (li) return;
    const pre = closestIn(range.startContainer, 'pre');
    if (pre && !readPlain(pre)) {
      event.preventDefault();
      const p = newParagraph();
      pre.replaceWith(p);
      setCaret(p, 0);
      changed();
      return;
    }
    const p = closestIn(range.startContainer, PARA);
    if (!p || !isAtStart(p, range)) return;
    const quote = p.parentElement;
    if (quote?.tagName === 'BLOCKQUOTE' && p === quote.firstElementChild) {
      event.preventDefault();
      const saved = saveSelection();
      quote.before(p);
      if (!quote.children.length) quote.remove();
      restoreSelection(saved, p);
      changed();
      return;
    }
    if (p.parentElement === surface && p.previousElementSibling?.tagName === 'HR') {
      event.preventDefault();
      p.previousElementSibling.remove();
      changed();
    }
  }

  function handleTab(event: KeyboardEvent, range: Range): void {
    const box = closestIn(range.startContainer, 'pre, .ag-mde-raw');
    if (box) {
      event.preventDefault();
      if (!event.shiftKey) {
        insertTextAtCaret(range, '  ', box);
        changed();
      }
      return;
    }
    const items = selectedItems(range);
    if (!items.length) return;
    event.preventDefault();
    let moved = false;
    if (event.shiftKey) {
      for (const li of [...items].reverse()) moved = Boolean(outdentItem(li)) || moved;
    } else for (const li of items) moved = indentItem(li) || moved;
    if (moved) changed();
  }

  // ── 붙여넣기 ──
  function insertPlainText(input: string): void {
    const text = input.replace(/\r\n?/g, '\n');
    const range = currentRange();
    if (!range || !text) return;
    const box = closestIn(range.startContainer, 'pre, .ag-mde-raw');
    if (box) {
      insertTextAtCaret(range, text, box);
      changed();
      return;
    }
    if (closestIn(range.startContainer, 'code, [data-md-raw]')) {
      insertTextAtCaret(range, text.replace(/\n+/g, ' '), closestIn(range.startContainer, 'code, [data-md-raw]')!);
      changed();
      return;
    }
    range.deleteContents();
    const block = closestIn(range.startContainer, TEXT_BLOCKS);
    const topParagraph = block && block.parentElement === surface && block.matches(PARA) ? block : null;
    if (!text.includes('\n') || !topParagraph) {
      const heading = Boolean(closestIn(range.startContainer, HEADINGS));
      const fragment = document.createDocumentFragment();
      text.replace(/\n+$/, '').split('\n').forEach((line, index) => {
        if (index) fragment.appendChild(heading ? document.createTextNode(' ') : document.createElement('br'));
        renderInline(parseInline(line), fragment);
      });
      const last = fragment.lastChild;
      range.insertNode(fragment);
      if (last) {
        const parent = last.parentNode!;
        setCaret(parent, Array.prototype.indexOf.call(parent.childNodes, last) + 1);
      }
      changed();
      return;
    }
    const blocks = parseBlocks(text);
    if (!blocks.length) return;
    const tailRange = document.createRange();
    tailRange.setStart(range.startContainer, range.startOffset);
    tailRange.setEnd(topParagraph, topParagraph.childNodes.length);
    const after = tailRange.extractContents();
    const stripBr = (el: HTMLElement) => {
      while (el.lastChild?.nodeName === 'BR') (el.lastChild as ChildNode).remove();
    };
    stripBr(topParagraph);
    let insertAfter: HTMLElement = topParagraph;
    let lastInserted: HTMLElement = topParagraph;
    const queue = [...blocks];
    const first = queue[0];
    if (first.t === 'paragraph') {
      queue.shift();
      renderInline(first.content, topParagraph);
    }
    for (const block of queue) {
      const el = renderBlock(block);
      insertAfter.after(el);
      insertAfter = el;
      lastInserted = el;
    }
    const emptyFirst = !(topParagraph.textContent ?? '').replaceAll(ZWSP, '');
    let caretParent: Node;
    let caretIndex: number;
    const afterHasText = Boolean((after.textContent ?? '').replaceAll(ZWSP, ''));
    if (lastInserted.tagName === 'P') {
      stripBr(lastInserted);
      caretParent = lastInserted;
      caretIndex = lastInserted.childNodes.length;
      if (afterHasText) lastInserted.appendChild(after);
      withPlaceholder(lastInserted);
    } else {
      const holder = lastInserted.matches('ul, ol') ? (lastInserted.querySelector('li:last-child') as HTMLElement) : lastInserted;
      caretParent = holder;
      caretIndex = holder.childNodes.length - (holder.lastChild?.nodeName === 'BR' ? 1 : 0);
      if (afterHasText) {
        const p = document.createElement('p');
        p.appendChild(after);
        withPlaceholder(p);
        lastInserted.after(p);
      }
    }
    if (emptyFirst && topParagraph !== lastInserted) topParagraph.remove();
    else withPlaceholder(topParagraph);
    setCaret(caretParent, caretIndex);
    changed();
  }

  /** 선택한 부분의 마크다운(복사·잘라내기). */
  function selectionMarkdown(range: Range): string | null {
    if (range.collapsed) return null;
    if (closestIn(range.commonAncestorContainer, 'pre, .ag-mde-raw, code')) return range.toString().replaceAll(ZWSP, '');
    const holder = document.createElement('div');
    holder.appendChild(range.cloneContents());
    return serializeBlocks(readBlocksFrom(holder));
  }

  // ── 상태 표시 ──
  let stateFrame = 0;
  function scheduleState(): void {
    if (stateFrame) return;
    stateFrame = requestAnimationFrame(() => {
      stateFrame = 0;
      updateState();
    });
  }

  function isEmpty(): boolean {
    return !(surface.textContent ?? '').replaceAll(ZWSP, '')
      && !surface.querySelector(`hr, li, pre, blockquote, .ag-mde-raw, ${HEADINGS}`);
  }

  function updateState(): void {
    root.classList.toggle('ag-mde-empty', !sourceMode && isEmpty());
    const locked = disabled || readOnly || sourceMode;
    for (const button of buttons.values()) {
      button.disabled = locked;
      if (locked) button.setAttribute('aria-pressed', 'false');
    }
    sourceToggle.disabled = disabled;
    sourceToggle.setAttribute('aria-pressed', String(sourceMode));
    sourceToggle.title = sourceMode ? '서식 보기' : '마크다운 원문 보기';
    if (locked) return;
    const range = currentRange();
    const anchor = range?.startContainer ?? null;
    const inBox = Boolean(anchor && closestIn(anchor, 'pre, .ag-mde-raw'));
    const heading = anchor ? closestIn(anchor, HEADINGS) : null;
    const li = anchor ? closestIn(anchor, 'li') : null;
    const query = (name: string) => {
      try { return Boolean(range) && document.queryCommandState(name); } catch { return false; }
    };
    const pressed: Record<Command, boolean> = {
      heading: Boolean(heading),
      bold: Boolean(anchor && closestIn(anchor, 'strong, b')) || (!heading && !inBox && query('bold')),
      italic: Boolean(anchor && closestIn(anchor, 'em, i')) || (!inBox && query('italic')),
      code: Boolean(anchor && closestIn(anchor, 'code')) && !inBox,
      bullet: li?.parentElement?.tagName === 'UL',
      ordered: li?.parentElement?.tagName === 'OL',
      quote: Boolean(anchor && closestIn(anchor, 'blockquote')),
      link: Boolean(anchor && closestIn(anchor, 'a')),
      codeBlock: Boolean(anchor && closestIn(anchor, 'pre')),
    };
    for (const [command, button] of buttons) {
      button.setAttribute('aria-pressed', String(pressed[command]));
      if (inBox && ['bold', 'italic', 'code', 'link', 'heading', 'bullet', 'ordered', 'quote'].includes(command)) {
        button.disabled = true;
      }
      if (command === 'codeBlock' && closestIn(anchor, '.ag-mde-raw')) button.disabled = true;
      if (command === 'bold' && heading) button.disabled = true;
    }
    const level = buttons.get('heading')!.querySelector('.ag-mde-level')!;
    level.textContent = heading ? heading.tagName.slice(1) : '';
  }

  function syncEditable(): void {
    surface.contentEditable = editable() ? 'true' : 'false';
    surface.setAttribute('aria-disabled', String(disabled));
    surface.setAttribute('aria-readonly', String(readOnly));
    surface.tabIndex = disabled ? -1 : 0;
    source.disabled = disabled;
    source.readOnly = readOnly;
    root.classList.toggle('ag-mde-disabled', disabled);
    root.classList.toggle('ag-mde-readonly', readOnly);
    if (!editable()) linkBar.hidden = true;
    updateState();
  }

  function toggleSource(): void {
    if (disabled) return;
    if (!sourceMode) {
      const text = computeValue();
      sourceMode = true;
      sourceBaseline = text;
      source.value = text;
      surface.hidden = true;
      source.hidden = false;
      linkBar.hidden = true;
      syncEditable();
      source.focus();
    } else {
      const text = source.value;
      sourceMode = false;
      source.hidden = true;
      surface.hidden = false;
      // 원문을 고치지 않았으면 서식 보기와 실행 취소 기록을 그대로 둔다.
      if (text !== sourceBaseline) load(text);
      syncEditable();
      surface.focus({ preventScroll: true });
    }
    root.classList.toggle('ag-mde-source-mode', sourceMode);
  }

  // ── 이벤트 ──
  function isTypingInput(type: string): boolean {
    return type === 'insertText' || type === 'insertCompositionText' || type.startsWith('deleteContent');
  }

  surface.addEventListener('beforeinput', (event) => {
    if (event.inputType === 'historyUndo' || event.inputType === 'historyRedo') {
      event.preventDefault();
      stepHistory(event.inputType === 'historyUndo' ? -1 : 1);
    }
  });

  surface.addEventListener('input', (event) => {
    const input = event as InputEvent;
    cache = null;
    dirty = true;
    if (!input.isComposing) normalizeTop();
    if (!input.isComposing && exceedsMax()) {
      applySnapshot(history[historyIndex]);
      return;
    }
    record(isTypingInput(input.inputType ?? '') ? 'typing' : 'other');
    if (input.inputType === 'insertText' && !input.isComposing && input.data) {
      const range = currentRange();
      const ch = input.data.slice(-1);
      if (range?.collapsed && ((ch === ' ' || ch === ' ') ? blockRule(range) : inlineRule(range, ch))) {
        cache = null;
        record('other');
      }
    }
    scheduleState();
  });

  surface.addEventListener('compositionend', () => {
    normalizeTop();
  });

  surface.addEventListener('keydown', (event) => {
    if (event.isComposing || event.keyCode === 229 || !editable()) return;
    const mod = isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
    const range = currentRange();
    if (mod) {
      const key = event.key.toLowerCase();
      let command: Command | null = null;
      let handled = true;
      if (!event.altKey && !event.shiftKey && key === 'b') command = 'bold';
      else if (!event.altKey && !event.shiftKey && key === 'i') command = 'italic';
      else if (!event.altKey && !event.shiftKey && key === 'e') command = 'code';
      else if (!event.altKey && !event.shiftKey && key === 'k') command = 'link';
      else if (!event.altKey && event.shiftKey && event.code === 'Digit8') command = 'bullet';
      else if (!event.altKey && event.shiftKey && event.code === 'Digit7') command = 'ordered';
      else if (!event.altKey && event.shiftKey && event.code === 'Digit9') command = 'quote';
      else if (event.altKey && !event.shiftKey && event.code === 'KeyC') command = 'codeBlock';
      else if (event.altKey && !event.shiftKey && /^Digit[0-6]$/.test(event.code)) {
        event.preventDefault();
        event.stopPropagation();
        setHeading(Number(event.code.slice(5)));
        return;
      } else if (!event.altKey && key === 'z') {
        event.preventDefault();
        event.stopPropagation();
        stepHistory(event.shiftKey ? 1 : -1);
        return;
      } else if (!event.altKey && !event.shiftKey && key === 'y' && !isMac) {
        event.preventDefault();
        event.stopPropagation();
        stepHistory(1);
        return;
      } else handled = false;
      if (handled && command) {
        event.preventDefault();
        event.stopPropagation();
        run(command);
      }
      return;
    }
    if (!range || event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === 'Enter') {
      if (event.shiftKey) {
        event.preventDefault();
        const box = closestIn(range.startContainer, 'pre, .ag-mde-raw');
        if (box) insertTextAtCaret(range, '\n', box);
        else if (!closestIn(range.startContainer, HEADINGS)) insertBreak(range);
        else return;
        changed();
        return;
      }
      handleEnter(event, range);
    } else if (event.key === 'Tab') {
      handleTab(event, range);
    } else if (event.key === 'Backspace' && !event.shiftKey) {
      handleBackspace(event, range);
    }
  });

  surface.addEventListener('paste', (event) => {
    event.preventDefault();
    if (!editable()) return;
    insertPlainText(event.clipboardData?.getData('text/plain') ?? '');
  });

  const copySelection = (event: ClipboardEvent, cut: boolean) => {
    const range = currentRange();
    if (!range) return;
    const markdown = selectionMarkdown(range);
    if (markdown === null || !event.clipboardData) return;
    event.preventDefault();
    event.clipboardData.setData('text/plain', markdown);
    if (cut && editable()) document.execCommand('delete');
  };
  surface.addEventListener('copy', (event) => copySelection(event, false));
  surface.addEventListener('cut', (event) => copySelection(event, true));

  surface.addEventListener('dragstart', () => { internalDrag = true; });
  surface.addEventListener('dragend', () => { internalDrag = false; });
  surface.addEventListener('drop', (event) => {
    if (internalDrag) return;
    event.preventDefault();
    if (!editable()) return;
    const text = event.dataTransfer?.getData('text/plain') ?? '';
    const caret = (document as Document & { caretRangeFromPoint?: (x: number, y: number) => Range | null })
      .caretRangeFromPoint?.(event.clientX, event.clientY);
    if (caret && surface.contains(caret.startContainer)) {
      const selection = document.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(caret);
    }
    insertPlainText(text);
  });

  surface.addEventListener('click', (event) => {
    if ((event.target as Element | null)?.closest?.('a')) event.preventDefault();
  });

  surface.addEventListener('focus', () => {
    try { document.execCommand('defaultParagraphSeparator', false, 'p'); } catch { /* 지원 안 함 */ }
    try { document.execCommand('styleWithCSS', false, 'false'); } catch { /* 지원 안 함 */ }
  });

  bar.addEventListener('mousedown', (event) => {
    if ((event.target as Element).closest('button')) event.preventDefault();
  });
  bar.addEventListener('click', (event) => {
    const button = (event.target as Element).closest('button');
    if (!button || button.disabled) return;
    if (button === sourceToggle) toggleSource();
    else run(button.dataset.command as Command);
  });
  bar.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' && event.key !== 'Home' && event.key !== 'End') return;
    const list = barButtons().filter((button) => !button.disabled);
    const index = list.indexOf(document.activeElement as HTMLButtonElement);
    if (index < 0) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 0
      : event.key === 'End' ? list.length - 1
        : (index + (event.key === 'ArrowRight' ? 1 : -1) + list.length) % list.length;
    for (const button of barButtons()) button.tabIndex = -1;
    list[next].tabIndex = 0;
    list[next].focus();
  });

  const onSelectionChange = () => {
    if (!root.isConnected) {
      if (wasConnected) destroy();
      return;
    }
    wasConnected = true;
    const range = currentRange();
    if (range) lastRange = range.cloneRange();
    scheduleState();
  };
  document.addEventListener('selectionchange', onSelectionChange);

  function destroy(): void {
    if (destroyed) return;
    destroyed = true;
    document.removeEventListener('selectionchange', onSelectionChange);
    if (stateFrame) cancelAnimationFrame(stateFrame);
  }

  load('');

  return {
    root,
    get value() {
      return sourceMode ? source.value : computeValue();
    },
    set value(next: string) {
      const text = String(next ?? '');
      if (sourceMode) {
        source.value = text;
        sourceBaseline = text;
      }
      load(text);
    },
    get disabled() { return disabled; },
    set disabled(next: boolean) {
      disabled = Boolean(next);
      syncEditable();
    },
    get readOnly() { return readOnly; },
    set readOnly(next: boolean) {
      readOnly = Boolean(next);
      syncEditable();
    },
    get maxLength() { return maxLength; },
    set maxLength(next: number) {
      maxLength = Number.isFinite(next) && next >= 0 ? Math.floor(next) : -1;
      if (maxLength >= 0) source.maxLength = maxLength;
      else source.removeAttribute('maxlength');
    },
    get placeholder() { return placeholder; },
    set placeholder(next: string) {
      placeholder = String(next ?? '');
      surface.dataset.placeholder = placeholder;
      source.placeholder = placeholder;
    },
    focus() {
      if (sourceMode) source.focus();
      else surface.focus();
    },
    addEventListener(type, listener) { root.addEventListener(type, listener); },
    removeEventListener(type, listener) { root.removeEventListener(type, listener); },
    destroy,
  };
}
