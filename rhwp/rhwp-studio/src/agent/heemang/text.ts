/**
 * 문단 텍스트 읽기·쓰기 — 본문, 표 셀(paraIdx·controlIdx·cellIdx), 중첩 셀 경로.
 *
 * 결과 모양은 에이전트 도구가 읽던 그대로다 (insertText 는 {ok, charOffset} JSON 문자열,
 * deleteRange 는 객체 등). 줄바꿈이 든 텍스트는 엔진 insertText 가 문단을 나누지만, 대기 편집은
 * 줄마다 넣고 split 을 따로 부르므로 여기서는 받은 그대로 넘긴다.
 */
import { HeemangAgentCore, isInlineControl, isStructuralControl, scalarLength, type CellPathEntry } from './core.ts';
import type { Step } from './wire.ts';

type Ok = { ok: true; paraIdx: number; charOffset: number };

export class HeemangTextApi extends HeemangAgentCore {
  // ─── 개수·길이·텍스트 ─────────────────────────────────────

  getParagraphCount(sec: number): number { return this.paraCount(sec); }

  getParagraphLength(sec: number, para: number): number { return this.paraLength(this.para(sec, para)); }

  getTextRange(sec: number, para: number, charOffset: number, count: number): string {
    return this.paraText(this.para(sec, para), charOffset, count);
  }

  getCellParagraphCount(sec: number, parentPara: number, controlIdx: number, cellIdx: number): number {
    return this.paraCount(sec, this.cellSteps(parentPara, controlIdx, cellIdx));
  }

  getCellParagraphCountByPath(sec: number, parentPara: number, pathJson: string): number {
    return this.paraCount(sec, this.pathSteps(parentPara, pathJson).steps);
  }

  getCellParagraphLength(sec: number, parentPara: number, controlIdx: number, cellIdx: number, cellParaIdx: number): number {
    return this.paraLength(this.para(sec, cellParaIdx, this.cellSteps(parentPara, controlIdx, cellIdx)));
  }

  getCellParagraphLengthByPath(sec: number, parentPara: number, pathJson: string): number {
    const { steps, para } = this.pathSteps(parentPara, pathJson);
    return this.paraLength(this.para(sec, para, steps));
  }

  getTextInCell(sec: number, parentPara: number, controlIdx: number, cellIdx: number, cellParaIdx: number, charOffset: number, count: number): string {
    return this.paraText(this.para(sec, cellParaIdx, this.cellSteps(parentPara, controlIdx, cellIdx)), charOffset, count);
  }

  getTextInCellByPath(sec: number, parentPara: number, pathJson: string, charOffset: number, count: number): string {
    const { steps, para } = this.pathSteps(parentPara, pathJson);
    return this.paraText(this.para(sec, para, steps), charOffset, count);
  }

  /** 문단 컨트롤마다 그 앞 텍스트 글자 수 (구조 컨트롤 포함, 컨트롤 순서대로). */
  getControlTextPositions(sec: number, para: number): number[] {
    const p = this.para(sec, para);
    return p.controls.map((c) => this.charAt(p, c.offset));
  }

  // ─── 논리 offset (인라인 개체 = 한 글자) ───────────────────

  textToLogicalOffset(sec: number, para: number, textOffset: number): number {
    return this.logicalOf(this.para(sec, para), textOffset);
  }

  logicalToTextOffset(sec: number, para: number, logicalOffset: number): number {
    return this.textOfLogical(this.para(sec, para), logicalOffset);
  }

  textToLogicalOffsetInCellByPath(sec: number, parentPara: number, pathJson: string, textOffset: number): number {
    const { steps, para } = this.pathSteps(parentPara, pathJson);
    return this.logicalOf(this.para(sec, para, steps), textOffset);
  }

  logicalToTextOffsetInCell(sec: number, parentPara: number, controlIdx: number, cellIdx: number, cellParaIdx: number, logicalOffset: number): number {
    return this.textOfLogical(this.para(sec, cellParaIdx, this.cellSteps(parentPara, controlIdx, cellIdx)), logicalOffset);
  }

  logicalToTextOffsetInCellByPath(sec: number, parentPara: number, pathJson: string, logicalOffset: number): number {
    const { steps, para } = this.pathSteps(parentPara, pathJson);
    return this.textOfLogical(this.para(sec, para, steps), logicalOffset);
  }

  getLogicalLength(sec: number, para: number): number {
    const p = this.para(sec, para);
    return scalarLength(p.text) + p.controls.filter(isInlineControl).length;
  }

  getCellLogicalLengthByPath(sec: number, parentPara: number, pathJson: string): number {
    const { steps, para } = this.pathSteps(parentPara, pathJson);
    const p = this.para(sec, para, steps);
    return scalarLength(p.text) + p.controls.filter(isInlineControl).length;
  }

  /** 문단 내용의 지문 — 텍스트와 컨트롤 배치가 같으면 같다. */
  getParagraphContentDigest(sec: number, para: number): string {
    const p = this.para(sec, para);
    const controls = p.controls.filter((c) => !isStructuralControl(c)).map((c) => `${c.kind}@${c.offset}:${c.lists}`).join(',');
    return `${p.length}|${controls}|${p.text}`;
  }

  // ─── 쓰기 ────────────────────────────────────────────────

  insertText(sec: number, para: number, charOffset: number, text: string): string {
    return this.insertIn(sec, para, charOffset, text);
  }

  insertTextInCell(sec: number, parentPara: number, controlIdx: number, cellIdx: number, cellParaIdx: number, charOffset: number, text: string): string {
    return this.insertIn(sec, cellParaIdx, charOffset, text, this.cellSteps(parentPara, controlIdx, cellIdx));
  }

  insertTextInCellByPath(sec: number, parentPara: number, pathJson: string, charOffset: number, text: string): string {
    const { steps, para } = this.pathSteps(parentPara, pathJson);
    return this.insertIn(sec, para, charOffset, text, steps);
  }

  deleteRange(sec: number, startPara: number, startOffset: number, endPara: number, endOffset: number): Ok {
    return this.deleteIn(sec, startPara, startOffset, endPara, endOffset);
  }

  deleteRangeInCell(
    sec: number, parentPara: number, controlIdx: number, cellIdx: number,
    startCellPara: number, startOffset: number, endCellPara: number, endOffset: number,
  ): Ok {
    return this.deleteIn(sec, startCellPara, startOffset, endCellPara, endOffset, this.cellSteps(parentPara, controlIdx, cellIdx));
  }

  deleteRangeInCellByPath(
    sec: number, parentPara: number, pathJson: string,
    startPara: number, startOffset: number, endPara: number, endOffset: number,
  ): string {
    const { steps } = this.pathSteps(parentPara, pathJson);
    return JSON.stringify(this.deleteIn(sec, startPara, startOffset, endPara, endOffset, steps));
  }

  /** 문단 나누기 — charOffset 은 논리 offset (인라인 개체 = 한 글자). */
  splitParagraphLogical(sec: number, para: number, charOffset: number): string {
    return this.splitIn(sec, para, charOffset);
  }

  splitParagraphInCellLogical(sec: number, parentPara: number, controlIdx: number, cellIdx: number, cellParaIdx: number, charOffset: number): string {
    return this.splitIn(sec, cellParaIdx, charOffset, this.cellSteps(parentPara, controlIdx, cellIdx));
  }

  splitParagraphInCellByPath(sec: number, parentPara: number, pathJson: string, charOffset: number): string {
    const { steps, para } = this.pathSteps(parentPara, pathJson);
    return this.splitIn(sec, para, charOffset, steps);
  }

  /** 셀 문단의 텍스트 범위 안 표 컨트롤 — 중첩 표 보호에 쓴다. */
  getTableControlsInSelection(
    sec: number, parentPara: number, containerPath: CellPathEntry[],
    startPara: number, startOffset: number, endPara: number, endOffset: number,
  ): Array<{ sec: number; ppi: number; ci: number; cellPath?: CellPathEntry[] }> {
    const { steps } = this.pathSteps(parentPara, containerPath);
    const out: Array<{ sec: number; ppi: number; ci: number; cellPath?: CellPathEntry[] }> = [];
    const paras = this.list(sec, steps);
    for (let i = startPara; i <= endPara && i < paras.length; i++) {
      const p = paras[i];
      const lo = i === startPara ? this.startWire(p, Math.min(startOffset, this.paraLength(p))) : -1;
      const hi = i === endPara ? this.insertWire(p, Math.min(endOffset, this.paraLength(p))) : Infinity;
      for (const c of p.controls) {
        if (c.kind !== 'table' || c.offset < lo || c.offset >= hi) continue;
        const cellPath = containerPath.map((e) => ({ ...e }));
        cellPath[cellPath.length - 1].cellParaIndex = i;
        out.push({ sec, ppi: parentPara, ci: c.index, cellPath });
      }
    }
    return out;
  }

  // ─── 내부 ────────────────────────────────────────────────

  private insertIn(sec: number, para: number, charOffset: number, text: string, steps?: Step[]): string {
    const at = this.insertAddress(sec, para, charOffset, steps);
    this.transact([{ op: 'insertText', at, text }], 'insertText');
    const lines = text.split('\n');
    const endPara = para + lines.length - 1;
    const charOffsetAfter = lines.length > 1 ? scalarLength(lines[lines.length - 1]) : charOffset + scalarLength(text);
    return JSON.stringify({ ok: true, paraIdx: endPara, charOffset: charOffsetAfter });
  }

  private deleteIn(sec: number, startPara: number, startOffset: number, endPara: number, endOffset: number, steps?: Step[]): Ok {
    if (endPara < startPara || (endPara === startPara && endOffset < startOffset)) {
      throw new Error('잘못된 범위: 끝이 시작보다 앞입니다');
    }
    const { from, to } = this.rangeAddresses(sec, startPara, startOffset, endPara, endOffset, steps);
    if (from.para !== to.para || from.offset !== to.offset) {
      this.transact([{ op: 'delete', from, to }], 'deleteRange');
    }
    return { ok: true, paraIdx: startPara, charOffset: startOffset };
  }

  /** logical: 인라인 개체를 한 글자로 센 위치 */
  private splitIn(sec: number, para: number, logical: number, steps?: Step[]): string {
    const at = this.address(sec, para, this.logicalWire(this.para(sec, para, steps), logical), steps);
    this.transact([{ op: 'split', at }], 'splitParagraph');
    return JSON.stringify({ ok: true, paraIdx: para + 1, charOffset: 0 });
  }
}
