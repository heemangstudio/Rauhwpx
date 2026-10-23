import type { Address, Affinity, EditOp } from '../../vendor/hm-wasm/hm_wasm';
import { EngineNotSupportedError } from './engine-support';

/** from은 선택의 anchor, to는 caret이다. 둘 다 엔진 wire offset을 쓴다. */
export interface TextSelection { from: Address; to: Address; fromAffinity?: Affinity; toAffinity?: Affinity }

export function copyAddress(at: Address): Address {
  return { ...at, ...(at.steps ? { steps: at.steps.map(step => ({ ...step })) } : {}) };
}

export function copySelection(range: TextSelection): TextSelection {
  return { ...range, from: copyAddress(range.from), to: copyAddress(range.to) };
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
    ? { from: copyAddress(range.to), to: copyAddress(range.from) } : copySelection(range);
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
