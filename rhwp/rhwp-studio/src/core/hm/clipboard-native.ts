/** 엔진이 보관하는 서식 포함 조각을 기존 클립보드 경로에 연결한다. */
import type { Address, CharPatch, Copied, EditOp, TableInfo } from '../../../vendor/hm-wasm/hm_wasm';
import type { HmCore, ListAddress } from './core';
import { unsupported } from './core';
import { addressToPosition, bodyList, cellList, logicalAddress, logicalRangeToWire, paraMap, pathTarget, toAddress } from './address';
import { extendBridge } from './api';

/**
 * `dropped`: 고른 개체가 엔진 조각에 담기지 않았다. 붙여넣으면 아무것도 들어가지 않는다.
 * `source`: 복사한 문서 인스턴스. `fragmentText`: 표 안 글자를 덧붙이기 전 엔진 조각 자체의 글자.
 */
interface Clipboard extends Copied { controls: boolean; single: boolean; dropped: boolean; source: number; fragmentText: string }
const clipboards = new WeakMap<object, Clipboard>();
const clipboard = (core: HmCore): Clipboard | undefined => clipboards.get(core.adapter.hmEngine());

const escapeHtml = (text: string): string => text.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** 표의 셀 글자: 칸은 탭, 줄은 줄바꿈으로 잇는다. HTML 은 같은 모양의 표다. */
function tableText(core: HmCore, list: ListAddress, para: number, control: number): { text: string; html: string } {
  const table = core.query<TableInfo>({ kind: 'table', table: { section: list.section, steps: list.steps.length ? list.steps : undefined, para, control } });
  const rows: string[][] = Array.from({ length: table.rows }, () => []);
  for (const cell of table.cells) {
    const cellList = { section: cell.list.section, steps: cell.list.steps ?? [] };
    const text = Array.from({ length: core.paragraphCount(cellList) }, (_, index) => core.paragraph(cellList, index).text).join('\n');
    rows[cell.row][cell.column] = text;
  }
  return {
    text: rows.map(row => Array.from(row, cell => cell ?? '').join('\t')).join('\n'),
    html: `<table>${rows.map(row => `<tr>${Array.from(row, cell => `<td>${escapeHtml(cell ?? '').replace(/\n/g, '<br>')}</td>`).join('')}</tr>`).join('')}</table>`,
  };
}

export function copyRange(core: HmCore, from: Address, to: Address): Clipboard {
  const copied = JSON.parse(core.call(doc => doc.copy(JSON.stringify({ from, to })))) as Copied;
  let controls = false;
  let single = false;
  const tables: Array<{ text: string; html: string }> = [];
  for (let sec = from.section; sec <= to.section; sec++) {
    const list = { section: sec, steps: from.steps ?? [] };
    const first = sec === from.section ? from.para : 0;
    const last = sec === to.section ? to.para : core.paragraphCount(list) - 1;
    for (let para = first; para <= last; para++) {
    const info = core.paragraph(list, para);
    for (const control of info.controls) {
      if (control.offset < (sec === from.section && para === from.para ? from.offset : 0) || control.offset + 8 > (sec === to.section && para === to.para ? to.offset : info.length)) continue;
      if (!['table', 'object', 'equation'].includes(control.kind)) continue;
      controls = true;
      single = from.section === to.section && from.para === to.para && from.offset === control.offset && to.offset === control.offset + 8;
      if (control.kind === 'table') tables.push(tableText(core, list, para, control.index));
    }
  }
  }
  // 엔진 조각은 표·그림·도형·수식·양식 개체를 통째로 담는다. 담지 못한 개체가 있으면 붙여넣어도 사라진다.
  const dropped = controls && !(copied.objects > 0);
  const fragmentText = copied.text;
  // 엔진 조각의 글자에는 표 안 글자가 없다. 표만 고른 경우 셀 글자를 외부 붙여넣기용으로 채운다.
  if (tables.length && !copied.text.trim()) {
    copied.text = tables.map(table => table.text).join('\n');
    if (!copied.html.includes('<table')) copied.html = tables.map(table => table.html).join('');
  }
  const result = { ...copied, controls, single, dropped, source: core.adapter.documentInstance, fragmentText };
  clipboards.set(core.adapter.hmEngine(), result);
  return result;
}

/** 셀 블록의 원본 표 조각과 시스템 클립보드 표현을 같은 상태로 묶는다. */
export function rememberTableClipboard(core: HmCore, copied: { text: string; html: string }): void {
  clipboards.set(core.adapter.hmEngine(), { ...copied, objects: 1, controls: true, single: true,
    dropped: false, source: core.adapter.documentInstance, fragmentText: '' });
}

function copyIn(core: HmCore, list: ListAddress, startPara: number, startOffset: number, endPara: number, endOffset: number): Clipboard {
  let from = logicalAddress(core, list, startPara, startOffset);
  let to = logicalAddress(core, list, endPara, endOffset);
  if (startPara === endPara) {
    const [a, b] = logicalRangeToWire(paraMap(core.paragraph(list, startPara)), startOffset, endOffset);
    from = toAddress(list, startPara, a);
    to = toAddress(list, endPara, b);
  }
  return copyRange(core, from, to);
}

export function copySelection(core: HmCore, sec: number, startPara: number, startOffset: number, endPara: number, endOffset: number): string {
  copyIn(core, bodyList(sec), startPara, startOffset, endPara, endOffset);
  return JSON.stringify({ ok: true });
}

export function copySelectionInCell(core: HmCore, sec: number, parentPara: number, controlIdx: number, cellIdx: number, startCellPara: number, startOffset: number, endCellPara: number, endOffset: number): string {
  copyIn(core, cellList(sec, parentPara, controlIdx, cellIdx), startCellPara, startOffset, endCellPara, endOffset);
  return JSON.stringify({ ok: true });
}

export function copySelectionInCellByPath(core: HmCore, sec: number, parentPara: number, pathJson: string, startCellPara: number, startOffset: number, endCellPara: number, endOffset: number): string {
  copyIn(core, pathTarget(sec, parentPara, pathJson).list, startCellPara, startOffset, endCellPara, endOffset);
  return JSON.stringify({ ok: true });
}

export function hasInternalClipboard(core: HmCore): boolean { return clipboard(core) !== undefined; }
export function getClipboardText(core: HmCore): string { return clipboard(core)?.text ?? ''; }
export function clipboardHasControl(core: HmCore): boolean { return clipboard(core)?.controls ?? false; }
export function clipboardIsSingleControl(core: HmCore): boolean { return clipboard(core)?.single ?? false; }

function pasteResult(core: HmCore, at: Address): string {
  const position = addressToPosition(core, at);
  return JSON.stringify({ ok: true, paraIdx: at.para, cellParaIdx: at.para, charOffset: position.charOffset });
}

function paste(core: HmCore, at: Address): string {
  const held = clipboard(core);
  if (held?.dropped) throw unsupported('개체 붙여넣기');
  const receipt = core.mutate(doc => doc.paste(JSON.stringify({ at })));
  return pasteResult(core, receipt?.caret ?? at);
}

export function pasteInternal(core: HmCore, sec: number, para: number, charOffset: number): string {
  return paste(core, logicalAddress(core, bodyList(sec), para, charOffset));
}
export const pasteControl = pasteInternal;

export function pasteInternalInCell(core: HmCore, sec: number, parentPara: number, controlIdx: number, cellIdx: number, cellParaIdx: number, charOffset: number): string {
  return paste(core, logicalAddress(core, cellList(sec, parentPara, controlIdx, cellIdx), cellParaIdx, charOffset));
}

export function pasteInternalInCellByPath(core: HmCore, sec: number, parentPara: number, pathJson: string, charOffset: number): string {
  const { list, para } = pathTarget(sec, parentPara, pathJson);
  return paste(core, logicalAddress(core, list, para, charOffset));
}

function controlRange(core: HmCore, sec: number, para: number, ci: number, cellPathJson: string): { from: Address; to: Address } {
  const target = pathTarget(sec, para, cellPathJson);
  const control = core.paragraph(target.list, target.para).controls.find(item => item.index === ci);
  if (!control) throw new RangeError(`컨트롤 ${ci} 이 없습니다`);
  return { from: toAddress(target.list, target.para, control.offset), to: toAddress(target.list, target.para, control.offset + 8) };
}

export function copyControl(core: HmCore, sec: number, para: number, ci: number, cellPathJson: string): string {
  const { from, to } = controlRange(core, sec, para, ci, cellPathJson);
  // 담기지 않은 개체를 복사됐다고 하면 잘라내기가 개체를 지워 버린다.
  if (copyRange(core, from, to).dropped) throw unsupported('개체 복사');
  return JSON.stringify({ ok: true });
}

export function exportControlHtml(core: HmCore, sec: number, para: number, ci: number, cellPathJson: string): string {
  const { from, to } = controlRange(core, sec, para, ci, cellPathJson);
  return copyRange(core, from, to).html;
}

export function exportSelectionHtml(core: HmCore, sec: number, startPara: number, startOffset: number, endPara: number, endOffset: number): string {
  return copyIn(core, bodyList(sec), startPara, startOffset, endPara, endOffset).html;
}

export function exportSelectionInCellHtml(core: HmCore, sec: number, parentPara: number, controlIdx: number, cellIdx: number, startCellPara: number, startOffset: number, endCellPara: number, endOffset: number): string {
  return copyIn(core, cellList(sec, parentPara, controlIdx, cellIdx), startCellPara, startOffset, endCellPara, endOffset).html;
}

export function exportSelectionInCellByPathHtml(core: HmCore, sec: number, parentPara: number, pathJson: string, startCellPara: number, startOffset: number, endCellPara: number, endOffset: number): string {
  return copyIn(core, pathTarget(sec, parentPara, pathJson).list, startCellPara, startOffset, endCellPara, endOffset).html;
}

/** 외부 HTML 의 글자·표·data URI 그림을 한 번의 편집으로 넣는다. */
function pasteHtmlAt(core: HmCore, at: Address, html: string): string {
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  const ops: EditOp[] = [];
  let cursor = { ...at };
  const initial = core.paragraph({ section: at.section, steps: at.steps ?? [] }, at.para);
  let lead = initial.caret[0], hasTail = at.offset < initial.caret[1];
  let nextControl = core.paragraph({ section: at.section, steps: at.steps ?? [] }, at.para).controls.filter(c => c.offset < at.offset).length;
  const dimension = (node: HTMLElement, name: 'width' | 'height', fallback: number): number => {
    const raw = node.style[name] || node.getAttribute(name) || '';
    const match = /^(\d+(?:\.\d+)?)(px|pt|mm|cm|in)?$/.exec(raw);
    return match ? Math.max(1, Math.round(Number(match[1]) * ({ px: 75, pt: 100, mm: 7200 / 25.4, cm: 7200 / 2.54, in: 7200 }[match[2] || 'px'] ?? 75))) : fallback;
  };
  const cssColor = (value: string): number | undefined => {
    if (!value || value === 'transparent') return undefined;
    const context = document.createElement('canvas').getContext('2d');
    if (!context) return undefined;
    context.fillStyle = value;
    const hex = /^#([0-9a-f]{6})$/i.exec(context.fillStyle);
    if (!hex) return undefined;
    const n = Number.parseInt(hex[1], 16);
    return ((n & 255) << 16) | (n & 0xff00) | ((n >>> 16) & 255);
  };
  const length = (value: string, fallback = 0): number => {
    const match = /^(\d+(?:\.\d+)?)(px|pt|mm|cm|in)?$/.exec(value);
    return match ? Math.round(Number(match[1]) * ({ px: 75, pt: 100, mm: 7200 / 25.4, cm: 7200 / 2.54, in: 7200 }[match[2] || 'px'] ?? 75)) : fallback;
  };
  const append = (text: string, format: CharPatch): void => {
    if (!text) return;
    ops.push({ op: 'insertText', at: { ...cursor }, text, format });
    const parts = text.split('\n');
    const wireLength = (s: string) => [...s].reduce((n, char) => n + (char === '\t' ? 8 : char.length), 0);
    if (parts.length > 1) { nextControl = 0; lead = 0; }
    cursor = parts.length > 1 ? { ...cursor, para: cursor.para + parts.length - 1, offset: wireLength(parts.at(-1)!) }
      : { ...cursor, offset: cursor.offset + wireLength(text) };
  };
  const walk = (node: Node, inherited: CharPatch): void => {
    if (node.nodeType === 3) { append(node.textContent?.replace(/\r\n?/g, '\n') ?? '', inherited); return; }
    if (!(node instanceof HTMLElement)) return;
    if (['SCRIPT', 'STYLE', 'META', 'LINK', 'HEAD'].includes(node.tagName)) return;
    if (node.style.display === 'none') return;
    if (node.tagName === 'BR') { append('\n', inherited); return; }
    if (node.tagName === 'IMG') {
      const source = node.getAttribute('src') ?? '';
      const match = /^data:image\/(png|jpe?g|gif|bmp|webp|svg\+xml);base64,([\s\S]+)$/i.exec(source);
      if (!match) return;
      const bytes = [...atob(match[2].replace(/\s/g, ''))].map(c => c.charCodeAt(0));
      if (bytes.length > 32 * 1024 * 1024) throw new RangeError('붙여넣는 그림이 너무 큽니다');
      const width = dimension(node, 'width', 7200), height = dimension(node, 'height', 7200);
      ops.push({ op: 'insertPicture', at: { ...cursor }, bytes, extension: match[1].replace('jpeg', 'jpg').replace('svg+xml', 'svg'), width, height, naturalWidth: width, naturalHeight: height, inline: true, description: node.getAttribute('alt') ?? '' } as EditOp);
      cursor.offset += 8; nextControl++;
      return;
    }
    if (node.tagName === 'TABLE') {
      const rows = Array.from((node as HTMLTableElement).rows).filter(row => row.closest('table') === node);
      if (!rows.length) return;
      const occupied: boolean[][] = [];
      const cells: { element: HTMLTableCellElement; row: number; column: number; rowSpan: number; columnSpan: number }[] = [];
      let columns = 0;
      rows.forEach((row, r) => {
        occupied[r] ??= [];
        let column = 0;
        for (const element of Array.from(row.cells)) {
          while (occupied[r][column]) column++;
          const rowSpan = Math.max(1, element.rowSpan), columnSpan = Math.max(1, element.colSpan);
          for (let y = r; y < r + rowSpan; y++) {
            occupied[y] ??= [];
            for (let x = column; x < column + columnSpan; x++) occupied[y][x] = true;
          }
          cells.push({ element, row: r, column, rowSpan, columnSpan });
          column += columnSpan; columns = Math.max(columns, column);
        }
      });
      if (columns * occupied.length > 10000) throw new RangeError('붙여넣는 표가 너무 큽니다');
      if (cursor.offset > lead) append('\n', {});
      const parent = { ...cursor }, control = nextControl++, trailing = hasTail;
      const table = { section: parent.section, steps: parent.steps, para: parent.para, control };
      const width = dimension(node, 'width', 36000);
      ops.push({ op: 'createTable', at: parent, rows: occupied.length, columns, columnWidths: Array(columns).fill(Math.max(283, Math.round(width / columns))), inline: true } as EditOp);
      const afterControl = nextControl;
      for (const cell of cells) {
        cursor = { section: parent.section, steps: [...(parent.steps ?? []), { para: parent.para, control, index: cell.row * columns + cell.column }], para: 0, offset: 0 };
        nextControl = 0; lead = 0; hasTail = false;
        walk(cell.element, { ...inherited, ...(cell.element.tagName === 'TH' ? { bold: true } : {}) });
        const align = cell.element.style.verticalAlign;
        const patch: Record<string, unknown> = { header: cell.element.tagName === 'TH', ...(align && ['top', 'middle', 'bottom'].includes(align) ? { verticalAlign: align === 'middle' ? 'center' : align } : {}) };
        const style = cell.element.style, background = cssColor(style.backgroundColor || node.style.backgroundColor);
        const borderFill: Record<string, unknown> = {};
        if (background !== undefined) borderFill.fill = { kind: 'solid', background };
        const widths = [28, 33, 42, 56, 70, 84, 113, 141, 169, 198, 283, 424, 567, 850, 1134, 1417];
        for (const side of ['Left', 'Right', 'Top', 'Bottom']) {
          const rule = style.getPropertyValue(`border-${side.toLowerCase()}-style`) || node.style.borderStyle;
          if (!rule) continue;
          const width = length(style.getPropertyValue(`border-${side.toLowerCase()}-width`) || node.style.borderWidth, 75);
          const index = widths.reduce((best, value, i) => Math.abs(value - width) < Math.abs(widths[best] - width) ? i : best, 0);
          borderFill[side.toLowerCase()] = { style: ({ none: 0, hidden: 0, solid: 1, dashed: 2, dotted: 3, double: 8 } as Record<string, number>)[rule] ?? 1, width: index, color: cssColor(style.getPropertyValue(`border-${side.toLowerCase()}-color`) || node.style.borderColor) ?? 0 };
        }
        if (Object.keys(borderFill).length) patch.borderFill = borderFill;
        if (style.padding) { patch.ownPadding = true; patch.padding = ['Left', 'Right', 'Top', 'Bottom'].map(side => length(style.getPropertyValue(`padding-${side.toLowerCase()}`))); }
        ops.push({ op: 'setCellProperties', table, row: cell.row, column: cell.column, patch } as EditOp);
      }
      for (const cell of cells) if (cell.rowSpan > 1 || cell.columnSpan > 1) {
        ops.push({ op: 'mergeTableCells', table, startRow: cell.row, startColumn: cell.column, endRow: cell.row + cell.rowSpan - 1, endColumn: cell.column + cell.columnSpan - 1 } as EditOp);
      }
      cursor = { ...parent, offset: parent.offset + 8 }; nextControl = afterControl; hasTail = trailing; lead = parent.offset;
      if (trailing || node.nextSibling) append('\n', {});
      return;
    }
    const format = { ...inherited };
    const color = cssColor(node.style.color); if (color !== undefined) format.color = color;
    const shade = cssColor(node.style.backgroundColor); if (shade !== undefined && !['TD', 'TH'].includes(node.tagName)) format.shadeColor = shade;
    if (['B', 'STRONG'].includes(node.tagName) || /bold|[6-9]00/.test(node.style.fontWeight)) format.bold = true;
    if (['I', 'EM'].includes(node.tagName) || node.style.fontStyle === 'italic') format.italic = true;
    if (node.tagName === 'U' || node.style.textDecoration.includes('underline')) format.underline = true;
    if (['S', 'STRIKE', 'DEL'].includes(node.tagName) || node.style.textDecoration.includes('line-through')) format.strike = true;
    const size = /^(\d+(?:\.\d+)?)(pt|px)$/.exec(node.style.fontSize);
    if (size) format.size = Math.round(Number(size[1]) * (size[2] === 'pt' ? 100 : 75));
    const block = /^(P|DIV|H[1-6]|LI|PRE|BLOCKQUOTE)$/.test(node.tagName);
    if (block && ops.length && cursor.offset > 0) append('\n', {});
    const align = node.style.textAlign || node.getAttribute('align');
    if (align && ['left', 'center', 'right', 'justify'].includes(align)) ops.push({ op: 'formatParas', from: { ...cursor }, to: { ...cursor }, patch: { align } } as EditOp);
    for (const child of node.childNodes) walk(child, format);
    if (block && node.nextSibling && cursor.offset > 0) append('\n', {});
  };
  for (const node of parsed.body.childNodes) walk(node, {});
  core.transact(ops);
  return pasteResult(core, cursor);
}

export function pasteHtml(core: HmCore, sec: number, para: number, charOffset: number, html: string): string {
  return pasteHtmlAt(core, logicalAddress(core, bodyList(sec), para, charOffset), html);
}

export function pasteHtmlInCell(core: HmCore, sec: number, parentPara: number, controlIdx: number, cellIdx: number, cellParaIdx: number, charOffset: number, html: string): string {
  return pasteHtmlAt(core, logicalAddress(core, cellList(sec, parentPara, controlIdx, cellIdx), cellParaIdx, charOffset), html);
}

export function pasteHtmlInCellByPath(core: HmCore, sec: number, parentPara: number, pathJson: string, charOffset: number, html: string): string {
  const { list, para } = pathTarget(sec, parentPara, pathJson);
  return pasteHtmlAt(core, logicalAddress(core, list, para, charOffset), html);
}

extendBridge({ copySelection, copySelectionInCell, copySelectionInCellByPath, pasteInternal, pasteControl,
  pasteInternalInCell, pasteInternalInCellByPath, hasInternalClipboard, getClipboardText, copyControl, exportControlHtml,
  clipboardHasControl, clipboardIsSingleControl, exportSelectionHtml, exportSelectionInCellHtml, exportSelectionInCellByPathHtml,
  pasteHtml, pasteHtmlInCell, pasteHtmlInCellByPath });
