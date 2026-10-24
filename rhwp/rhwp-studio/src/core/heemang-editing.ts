import type { Address, Affinity, CharPatch, EditOp, ParaPatch, SelectRequest } from '../../vendor/hm-wasm/hm_wasm';
import { EngineNotSupportedError } from './engine-support';

/** from은 선택의 anchor, to는 caret이다. 둘 다 엔진 wire offset을 쓴다. */
export interface TextSelection { from: Address; to: Address; fromAffinity?: Affinity; toAffinity?: Affinity }
export type CellSelection = Extract<SelectRequest, { kind: 'cells' }>;
export type EditingSelection = TextSelection | CellSelection;

export function isCellSelection(range: EditingSelection): range is CellSelection {
  return 'kind' in range && range.kind === 'cells';
}

export function copyAddress(at: Address): Address {
  return { ...at, ...(at.steps ? { steps: at.steps.map(step => ({ ...step })) } : {}) };
}

export function copySelection(range: TextSelection): TextSelection;
export function copySelection(range: CellSelection): CellSelection;
export function copySelection(range: EditingSelection): EditingSelection;
export function copySelection(range: EditingSelection): EditingSelection {
  if (isCellSelection(range)) return {
    ...range, table: { ...range.table, ...(range.table.steps ? { steps: range.table.steps.map(step => ({ ...step })) } : {}) },
    from: { ...range.from }, to: { ...range.to },
  };
  return { ...range, from: copyAddress(range.from), to: copyAddress(range.to) };
}

export function sameSelection(a: EditingSelection, b: EditingSelection): boolean {
  if (isCellSelection(a)) return isCellSelection(b)
    && sameAddress({ ...a.table, offset: 0 }, { ...b.table, offset: 0 })
    && a.table.control === b.table.control
    && a.from.row === b.from.row && a.from.column === b.from.column
    && a.to.row === b.to.row && a.to.column === b.to.column;
  return !isCellSelection(b) && sameAddress(a.from, b.from) && sameAddress(a.to, b.to)
    && (a.fromAffinity ?? 'downstream') === (b.fromAffinity ?? 'downstream')
    && (a.toAffinity ?? 'downstream') === (b.toAffinity ?? 'downstream');
}

export function sameAddress(a: Address, b: Address): boolean {
  return a.section === b.section && a.para === b.para && a.offset === b.offset
    && sameList(a, b);
}

function sameList(a: Address, b: Address): boolean {
  const aa = a.steps ?? [], bb = b.steps ?? [];
  return a.section === b.section && aa.length === bb.length
    && aa.every((s, i) => s.para === bb[i].para && s.control === bb[i].control && s.index === bb[i].index);
}

export function orderedSelection(range: TextSelection): TextSelection {
  for (const at of [range.from, range.to]) {
    const values = [at.section, at.para, at.offset, ...(at.steps ?? []).flatMap(s => [s.para, s.control, s.index])];
    if (values.some(n => !Number.isInteger(n) || n < 0 || n > 0xffffffff)) {
      throw Object.assign(new RangeError('잘못된 문서 위치입니다'), { code: 'BAD_ADDRESS' });
    }
  }
  if (!sameList(range.from, range.to)) {
    throw new EngineNotSupportedError('서로 다른 문단 목록 사이의 편집');
  }
  return range.from.para > range.to.para || (range.from.para === range.to.para && range.from.offset > range.to.offset)
    ? { ...range, from: copyAddress(range.to), to: copyAddress(range.from),
      fromAffinity: range.toAffinity, toAffinity: range.fromAffinity } : copySelection(range);
}

/** 브라우저 줄바꿈을 정규화한다. 엔진이 버리는 제어 문자는 거절한다. */
export function editingText(text: string): string {
  text = text.replace(/\r\n?/g, '\n');
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\uD800-\uDFFF]/u.test(text)) {
    throw Object.assign(new Error('입력에 지원하지 않는 제어 문자나 잘못된 Unicode가 있습니다'), { code: 'BAD_REQUEST' });
  }
  return text;
}

export function replacementOps(range: TextSelection, text: string): EditOp[] {
  const { from, to } = orderedSelection(range);
  const ops: EditOp[] = sameAddress(from, to) ? [] : [{ op: 'delete', from, to }];
  if (text) ops.push({ op: 'insertText', at: from, text });
  return ops;
}

/** JSON으로 넘기기 전에 알 수 없는 필드와 잘못된 값을 거절한다. */
export function formattingPatch(patch: CharPatch | ParaPatch, paragraph: boolean): CharPatch | ParaPatch {
  const fields = paragraph
    ? ['align', 'spaceBefore', 'spaceAfter', 'left', 'right', 'indent', 'lineSpacing']
    : ['bold', 'italic', 'underline', 'strike', 'size', 'color', 'fontFace', 'fontFaces'];
  const result: Record<string, boolean | number | string | (string | null)[]> = {};
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw Object.assign(new Error('잘못된 서식 변경입니다'), { code: 'BAD_REQUEST' });
  }
  for (const key of Reflect.ownKeys(patch)) {
    if (typeof key !== 'string' || !fields.includes(key)) throw new EngineNotSupportedError(`서식 필드 ${String(key)}`);
    const value = (patch as Record<string, unknown>)[key];
    if (value === undefined) continue;
    const faceName = (name: unknown) => typeof name === 'string' && name.trim().length > 0 && name.length <= 255;
    const valid = ['bold', 'italic', 'underline', 'strike'].includes(key) ? typeof value === 'boolean'
      : key === 'fontFace' ? faceName(value)
      // 한글·영문·한자·일어·외국어·기호·사용자 슬롯 순서, null 은 그 슬롯을 그대로 둔다.
      : key === 'fontFaces' ? Array.isArray(value) && value.length <= 7 && value.every(name => name === null || faceName(name))
      : key === 'align' ? ['justify', 'left', 'right', 'center', 'distribute', 'divide'].includes(value as string)
      : typeof value === 'number' && Number.isInteger(value) && (key === 'size' ? value > 0 && value <= 0x7fffffff
        : key === 'color' ? value >= 0 && value <= 0xffffffff
        : key === 'lineSpacing' ? value > 0 && value <= 0x7fffffff
        // 문단 거리는 native에서 한 비트 왼쪽으로 이동해 저장한다.
        : value >= -0x40000000 && value <= 0x3fffffff);
    if (!valid) throw Object.assign(new Error(`잘못된 서식 값: ${key}`), { code: 'BAD_REQUEST' });
    result[key] = value as boolean | number | string | (string | null)[];
  }
  return result;
}
