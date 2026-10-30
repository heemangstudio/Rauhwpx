/**
 * 에이전트 표 도구 가운데 다른 작업 줄기가 맡지 않은 것: 표 캡션 글, 표 계산식. 셀 영역 테두리·배경은 table-properties.ts 가 맡는다.
 */
import type { ParagraphInfo, TableAddress, TableInfo } from '../../../vendor/hm-wasm/hm_wasm';
import { extendBridge } from './api';
import type { HmApi } from './api';
import type { HmCore } from './core';
import { paraMap, toAddress } from './address';
import { tableAddressByPath } from './table-editing';

const tableAddress = (section: number, para: number, control: number): TableAddress =>
  ({ section, steps: [], para, control });

function tableInfo(core: HmCore, table: TableAddress): TableInfo {
  return core.tableInfo(table);
}

/** 문단 글에 자동 번호를 구 엔진처럼 " N" 으로 넣는다. */
function textWithNumbers(info: ParagraphInfo): string {
  const map = paraMap(info);
  let text = '', from = 0;
  for (const control of info.controls) {
    if (control.kind !== 'autoNumber' || control.number === undefined) continue;
    const cut = map.textStops.findIndex(stop => stop > control.offset);
    const end = map.textUnits[cut < 0 ? map.textLength : cut];
    text += info.text.slice(from, end) + ` ${control.number}`;
    from = end;
  }
  return text + info.text.slice(from);
}

/** 표 캡션 목록의 글. 캡션이 없으면 null. */
function captionText(core: HmCore, table: TableAddress): string | null {
  // 캡션 목록은 모든 셀 목록 다음 번호다.
  const index = tableInfo(core, table).cells.length;
  const list = { section: table.section, steps: [...(table.steps ?? []), { para: table.para, control: table.control, index }] };
  try {
    const count = core.paragraphCount(list);
    return Array.from({ length: count }, (_, p) => textWithNumbers(core.paragraph(list, p))).join('\n');
  } catch {
    return null;
  }
}

/** 표 캡션 글을 바꾼다. 캡션이 없으면 표 아래에 만든다. withNumber 면 "표 N" 번호를 앞에 둔다. */
export const setTableCaptionText: HmApi['setTableCaptionText'] = (core, sec, parent, control, text, withNumber) => {
  const table = tableAddress(sec, parent, control);
  core.transact([{ op: 'setTableCaption', table, text, withNumber }]);
  return { ok: true, captionText: captionText(core, table) ?? text };
};

/** 셀 참조·범위와 산술/집계식. JS eval 없이 길이와 중첩을 제한한다. */
function formulaValue(core: HmCore, table: TableAddress, row: number, col: number, source: string): number {
  const info = tableInfo(core, table);
  if (source.length > 1000) throw new RangeError('표 계산식이 너무 깁니다');
  // 계산식은 = 또는 @ 로 시작한다.
  const input = source.trim().replace(/^[=@]/, '').toUpperCase();
  let at = 0, depth = 0;
  const space = () => { while (/\s/.test(input[at] ?? '') && at < input.length) at++; };
  const take = (char: string) => { space(); if (input[at] === char) { at++; return true; } return false; };
  const scalar = (values: number[]) => { if (values.length !== 1) throw new Error('범위는 집계 함수 안에서 사용해야 합니다'); return values[0]; };
  const cellNumbers = (sr: number, sc: number, er: number, ec: number): number[] => {
    if (sr < 0 || sc < 0 || er < sr || ec < sc || er >= info.rows || ec >= info.columns) throw new RangeError('표 계산식 셀 범위가 잘못되었습니다');
    return info.cells.filter(c => c.row <= er && c.row + c.rowSpan > sr && c.column <= ec && c.column + c.columnSpan > sc)
      .flatMap(c => {
        const list = { section: c.list.section, steps: c.list.steps ?? [] };
        const texts = Array.from({ length: core.paragraphCount(list) }, (_, p) => core.paragraph(list, p).text);
        const text = texts.join(' ').trim().replace(/,/g, '');
        if (!text) return [];
        const value = Number(text);
        return Number.isFinite(value) ? [value] : [];
      });
  };
  const ref = (token: string): [number, number] => {
    const match = /^([A-Z]+)([1-9][0-9]*)$/.exec(token);
    if (!match) throw new Error(`잘못된 셀 참조: ${token}`);
    let column = 0;
    for (const char of match[1]) column = column * 26 + char.charCodeAt(0) - 64;
    return [Number(match[2]) - 1, column - 1];
  };
  const atom = (): number[] => {
    if (++depth > 64) throw new RangeError('표 계산식 중첩이 너무 깊습니다');
    try {
      space();
      if (take('+')) return [scalar(atom())];
      if (take('-')) return [-scalar(atom())];
      if (take('(')) { const value = expression(); if (!take(')')) throw new Error('닫는 괄호가 없습니다'); return value; }
      const numeric = /^(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:E[+-]?[0-9]+)?/.exec(input.slice(at));
      if (numeric) { at += numeric[0].length; return [Number(numeric[0])]; }
      const token = /^[A-Z]+[0-9]*/.exec(input.slice(at))?.[0];
      if (!token) throw new Error('표 계산식에 값이 필요합니다');
      at += token.length;
      if (take('(')) {
        // 인수 하나하나는 범위가 펼친 값 목록이다. 인수는 쉼표나 세미콜론으로 나눈다.
        const args: number[][] = [];
        if (!take(')')) {
          do { args.push(comparison()); } while (take(',') || take(';'));
          if (!take(')')) throw new Error('닫는 괄호가 없습니다');
        }
        const values = args.flat();
        const arg = (i: number, fallback?: number) => {
          if (args[i] === undefined) {
            if (fallback === undefined) throw new Error(`${token} 함수의 인수가 모자랍니다`);
            return fallback;
          }
          return scalar(args[i]);
        };
        const unary = (f: (x: number) => number) => {
          if (args.length !== 1) throw new Error(`${token} 함수는 인수 하나가 필요합니다`);
          return [f(arg(0))];
        };
        /** 소수 digits 자리에서 반올림(0 에서 먼 쪽)하거나 버린다. 2진 오차(2.675*100=267.4999…)는 15자리에서 정리한다. */
        const toDigits = (x: number, digits: number, f: (v: number) => number) => {
          const scale = 10 ** Math.trunc(digits);
          return f(Number((Math.abs(x) * scale).toPrecision(15))) / scale * Math.sign(x);
        };
        switch (token) {
          case 'SUM': return [values.reduce((a, b) => a + b, 0)];
          case 'AVG': case 'AVERAGE': if (!values.length) throw new Error('평균 범위가 비어 있습니다'); return [values.reduce((a, b) => a + b, 0) / values.length];
          case 'MIN': if (!values.length) throw new Error('최솟값 범위가 비어 있습니다'); return [Math.min(...values)];
          case 'MAX': if (!values.length) throw new Error('최댓값 범위가 비어 있습니다'); return [Math.max(...values)];
          case 'COUNT': return [values.length];
          case 'PRODUCT': return [values.reduce((a, b) => a * b, 1)];
          case 'ABS': return unary(Math.abs);
          case 'SQRT': return unary(Math.sqrt);
          case 'EXP': return unary(Math.exp);
          case 'LOG': return unary(Math.log);
          case 'LOG10': return unary(Math.log10);
          case 'SIN': return unary(Math.sin);
          case 'COS': return unary(Math.cos);
          case 'TAN': return unary(Math.tan);
          case 'ASIN': return unary(Math.asin);
          case 'ACOS': return unary(Math.acos);
          case 'ATAN': return unary(Math.atan);
          case 'RADIAN': return unary(x => x * Math.PI / 180);
          case 'SIGN': return unary(Math.sign);
          case 'CEILING': return unary(Math.ceil);
          case 'FLOOR': return unary(Math.floor);
          case 'INT': return unary(Math.trunc);
          case 'ROUND': return [toDigits(arg(0), arg(1, 0), Math.round)];
          case 'TRUNC': return [toDigits(arg(0), arg(1, 0), Math.trunc)];
          case 'MOD': { const divisor = arg(1); if (divisor === 0) throw new Error('0으로 나눌 수 없습니다'); return [arg(0) % divisor]; }
          case 'IF': if (args.length !== 3) throw new Error('IF 함수는 조건, 참, 거짓 세 인수가 필요합니다'); return [arg(0) !== 0 ? arg(1) : arg(2)];
          default: throw new Error(`지원하지 않는 표 함수: ${token}`);
        }
      }
      if (['ABOVE', 'BELOW', 'LEFT', 'RIGHT'].includes(token)) {
        if (token === 'ABOVE') return row > 0 ? cellNumbers(0, col, row - 1, col) : [];
        if (token === 'BELOW') return row + 1 < info.rows ? cellNumbers(row + 1, col, info.rows - 1, col) : [];
        if (token === 'LEFT') return col > 0 ? cellNumbers(row, 0, row, col - 1) : [];
        return col + 1 < info.columns ? cellNumbers(row, col + 1, row, info.columns - 1) : [];
      }
      const [sr, sc] = ref(token);
      if (take(':')) {
        space(); const end = /^[A-Z]+[1-9][0-9]*/.exec(input.slice(at))?.[0];
        if (!end) throw new Error('범위 끝 셀이 없습니다'); at += end.length;
        const [er, ec] = ref(end); return cellNumbers(sr, sc, er, ec);
      }
      const values = cellNumbers(sr, sc, sr, sc);
      return values.length ? values : [0];
    } finally { depth--; }
  };
  const product = (): number[] => {
    let value = atom();
    for (;;) {
      if (take('*')) value = [scalar(value) * scalar(atom())];
      else if (take('/')) { const divisor = scalar(atom()); if (divisor === 0) throw new Error('0으로 나눌 수 없습니다'); value = [scalar(value) / divisor]; }
      else return value;
    }
  };
  const expression = (): number[] => {
    let value = product();
    for (;;) {
      if (take('+')) value = [scalar(value) + scalar(product())];
      else if (take('-')) value = [scalar(value) - scalar(product())];
      else return value;
    }
  };
  /** 함수 인수 안의 비교식. 참은 1, 거짓은 0 이다. */
  const comparison = (): number[] => {
    const left = expression();
    space();
    const op = /^(<=|>=|<>|!=|==|<|>|=)/.exec(input.slice(at))?.[0];
    if (!op) return left;
    at += op.length;
    const a = scalar(left), b = scalar(expression());
    const result = op === '<' ? a < b : op === '<=' ? a <= b : op === '>' ? a > b : op === '>=' ? a >= b
      : op === '<>' || op === '!=' ? a !== b : a === b;
    return [result ? 1 : 0];
  };
  const value = scalar(expression()); space();
  if (at !== input.length || !Number.isFinite(value)) throw new Error('잘못된 표 계산식입니다');
  return value;
}
export const evaluateTableFormulaEx: HmApi['evaluateTableFormulaEx'] = (core, options) => {
  const table = options.pathJson
    ? tableAddressByPath(options.sectionIdx, options.parentParaIdx, options.pathJson)
    : tableAddress(options.sectionIdx, options.parentParaIdx, options.controlIdx);
  const info = tableInfo(core, table);
  const cell = info.cells.find(c => c.row <= options.targetRow && options.targetRow < c.row + c.rowSpan
    && c.column <= options.targetCol && options.targetCol < c.column + c.columnSpan);
  if (!cell) throw new RangeError('계산 결과 셀 좌표가 잘못되었습니다');
  const value = formulaValue(core, table, options.targetRow, options.targetCol, options.formula);
  const digits = options.decimalPlaces;
  if (digits !== undefined && (!Number.isInteger(digits) || digits < 0 || digits > 15)) throw new RangeError('소수 자릿수는 0..15입니다');
  let display = digits === undefined ? String(value) : value.toFixed(digits);
  if (options.thousandsSeparator) {
    const [whole, fraction] = display.split('.');
    display = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (fraction === undefined ? '' : `.${fraction}`);
  }
  display = (options.prefix ?? '') + display + (options.suffix ?? '');
  if (options.writeResult) {
    const list = { section: cell.list.section, steps: cell.list.steps ?? [] };
    const last = core.paragraphCount(list) - 1;
    const firstMap = paraMap(core.paragraph(list, 0));
    const lastMap = paraMap(core.paragraph(list, last));
    const from = toAddress(list, 0, firstMap.lead);
    core.transact([
      { op: 'delete', from, to: toAddress(list, last, lastMap.end) },
      { op: 'insertText', at: from, text: display },
    ]);
  }
  return { ok: true, value, display };
};
/** 계산식 대화상자·블록 계산·hwpctl 의 계약: 성공은 {ok, result}, 틀린 식은 {ok:false, error}. */
export const evaluateTableFormula: HmApi['evaluateTableFormula'] = (core, sectionIdx, parentParaIdx, controlIdx, targetRow, targetCol, formula, writeResult) => {
  try {
    const { value } = evaluateTableFormulaEx(core, { sectionIdx, parentParaIdx, controlIdx, targetRow, targetCol, formula, writeResult });
    return JSON.stringify({ ok: true, result: value });
  } catch (error) {
    return JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
};

extendBridge({ setTableCaptionText, evaluateTableFormula, evaluateTableFormulaEx });
