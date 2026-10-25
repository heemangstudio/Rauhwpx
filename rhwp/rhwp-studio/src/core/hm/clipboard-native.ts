/** 엔진이 보관하는 서식 포함 조각을 기존 클립보드 경로에 연결한다. */
import type { Address, CharPatch, Copied, EditOp, TableInfo } from '../../../vendor/hm-wasm/hm_wasm';
import type { HmCore, ListAddress } from './core';
import { unsupported } from './core';
import { addressToPosition, bodyList, cellList, logicalAddress, logicalRangeToWire, paraMap, pathTarget, toAddress } from './address';
import { extendBridge } from './api';

/**
 * `dropped`: 고른 개체가 엔진 조각에 담기지 않았다. 붙여넣으면 아무것도 들어가지 않는다.
 * `source`: 복사한 문서. 엔진 조각의 표·개체는 그 문서에만 다시 붙는다. `fragmentText`: 엔진 조각 자체의 글자.
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

function copy(core: HmCore, from: Address, to: Address): Clipboard {
  const copied = JSON.parse(core.call(doc => doc.copy(JSON.stringify({ from, to })))) as Copied;
  let controls = false;
  let single = false;
  const list = { section: from.section, steps: from.steps ?? [] };
  const tables: Array<{ text: string; html: string }> = [];
  for (let para = from.para; para <= to.para; para++) {
    const info = core.paragraph(list, para);
    for (const control of info.controls) {
      if (control.offset < (para === from.para ? from.offset : 0) || control.offset + 8 > (para === to.para ? to.offset : info.length)) continue;
      if (!['table', 'object', 'equation'].includes(control.kind)) continue;
      controls = true;
      single = from.para === to.para && from.offset === control.offset && to.offset === control.offset + 8;
      if (control.kind === 'table') tables.push(tableText(core, list, para, control.index));
    }
  }
  // 엔진 조각은 표·그림·도형·수식·양식 개체를 통째로 담는다. 담지 못한 개체가 있으면 붙여넣어도 사라진다.
  const dropped = controls && !(copied.objects > 0);
  const fragmentText = copied.text;
  // 엔진 조각의 글자에는 표 안 글자가 없다. 표만 고른 경우 셀 글자를 외부 붙여넣기용으로 채운다.
  if (tables.length && !copied.text.trim()) {
    copied.text = tables.map(table => table.text).join('\n');
    copied.html = tables.map(table => table.html).join('');
  }
  const result = { ...copied, controls, single, dropped, source: core.adapter.documentInstance, fragmentText };
  clipboards.set(core.adapter.hmEngine(), result);
  return result;
}

function copyIn(core: HmCore, list: ListAddress, startPara: number, startOffset: number, endPara: number, endOffset: number): Clipboard {
  let from = logicalAddress(core, list, startPara, startOffset);
  let to = logicalAddress(core, list, endPara, endOffset);
  if (startPara === endPara) {
    const [a, b] = logicalRangeToWire(paraMap(core.paragraph(list, startPara)), startOffset, endOffset);
    from = toAddress(list, startPara, a);
    to = toAddress(list, endPara, b);
  }
  return copy(core, from, to);
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
  // 다른 문서에는 엔진 조각의 글자만 붙는다. 표만 고른 조각은 셀 글자를, 그림·도형만 고른 조각은 넣을 것이 없다.
  if (held?.objects && held.source !== core.adapter.documentInstance && !held.fragmentText.trim()) {
    if (!held.text.trim()) throw unsupported('다른 문서로 개체 붙여넣기');
    const receipt = core.mutate(doc => doc.paste(JSON.stringify({ at, text: held.text })));
    return pasteResult(core, receipt?.caret ?? at);
  }
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
  if (copy(core, from, to).dropped) throw unsupported('개체 복사');
  return JSON.stringify({ ok: true });
}

export function exportControlHtml(core: HmCore, sec: number, para: number, ci: number, cellPathJson: string): string {
  const { from, to } = controlRange(core, sec, para, ci, cellPathJson);
  return copy(core, from, to).html;
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

/** 글자·문단으로 된 외부 HTML. 지원하지 않는 개체는 입력 전에 거절한다. */
function pasteHtmlAt(core: HmCore, at: Address, html: string): string {
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  if (parsed.querySelector('table,img,svg,math,object,iframe')) throw unsupported('HTML 개체 붙여넣기');
  const ops: EditOp[] = [];
  let cursor = { ...at };
  const append = (text: string, format: CharPatch): void => {
    if (!text) return;
    ops.push({ op: 'insertText', at: { ...cursor }, text, format });
    const parts = text.split('\n');
    const wireLength = (s: string) => [...s].reduce((n, char) => n + (char === '\t' ? 8 : char.length), 0);
    cursor = parts.length > 1 ? { ...cursor, para: cursor.para + parts.length - 1, offset: wireLength(parts.at(-1)!) }
      : { ...cursor, offset: cursor.offset + wireLength(text) };
  };
  const walk = (node: Node, inherited: CharPatch): void => {
    if (node.nodeType === 3) { append(node.textContent?.replace(/\r\n?/g, '\n') ?? '', inherited); return; }
    if (!(node instanceof HTMLElement)) return;
    if (['SCRIPT', 'STYLE', 'META', 'LINK', 'HEAD'].includes(node.tagName)) return;
    if (node.style.display === 'none') return;
    if (node.tagName === 'BR') { append('\n', inherited); return; }
    const format = { ...inherited };
    if (['B', 'STRONG'].includes(node.tagName) || /bold|[6-9]00/.test(node.style.fontWeight)) format.bold = true;
    if (['I', 'EM'].includes(node.tagName) || node.style.fontStyle === 'italic') format.italic = true;
    if (node.tagName === 'U' || node.style.textDecoration.includes('underline')) format.underline = true;
    if (['S', 'STRIKE', 'DEL'].includes(node.tagName) || node.style.textDecoration.includes('line-through')) format.strike = true;
    const size = /^(\d+(?:\.\d+)?)(pt|px)$/.exec(node.style.fontSize);
    if (size) format.size = Math.round(Number(size[1]) * (size[2] === 'pt' ? 100 : 75));
    const block = /^(P|DIV|H[1-6]|LI|PRE|BLOCKQUOTE)$/.test(node.tagName);
    if (block && ops.length && cursor.offset > 0) append('\n', {});
    for (const child of node.childNodes) walk(child, format);
    if (block && node.nextSibling && cursor.offset > 0) append('\n', {});
  };
  for (const node of parsed.body.childNodes) walk(node, {});
  const receipt = core.transact(ops);
  return pasteResult(core, receipt?.caret ?? at);
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
