/**
 * 표 계산식 대화상자 (ModalDialog 패턴)
 *
 * 한컴 [표-계산식] 대화상자와 동일한 기능:
 * - 계산식 입력 (= 또는 @ 시작)
 * - 함수 목록 드롭다운
 * - 쉬운 범위 (left, right, above, below)
 * - 형식 (기본, 정수, 소수 등)
 * - 세 자리마다 쉼표 구분
 */
import { ModalDialog } from './dialog';
import { makeOption } from './dom-utils';
import { tableTarget } from '@/core/table-target';
import type { CellPathEntry } from '@/core/types';
import type { EventBus } from '@/core/event-bus';
import type { CommandServices } from '@/command/types';

interface FormulaContext {
  sec: number;
  ppi: number;
  ci: number;
  /** 중첩 표면 안쪽 셀까지의 경로. cellIndex 는 그 표 안의 셀 번호다. */
  cellPath?: CellPathEntry[];
  cellIndex: number;
}

const FUNCTIONS = [
  { name: 'SUM', desc: '합계' },
  { name: 'AVERAGE', desc: '평균' },
  { name: 'PRODUCT', desc: '곱' },
  { name: 'MIN', desc: '최소값' },
  { name: 'MAX', desc: '최대값' },
  { name: 'COUNT', desc: '개수' },
  { name: 'ABS', desc: '절대값' },
  { name: 'SQRT', desc: '제곱근' },
  { name: 'ROUND', desc: '반올림' },
  { name: 'CEILING', desc: '올림' },
  { name: 'FLOOR', desc: '내림' },
  { name: 'TRUNC', desc: '절삭' },
  { name: 'MOD', desc: '나머지' },
  { name: 'IF', desc: '조건' },
  { name: 'INT', desc: '정수' },
  { name: 'SIGN', desc: '부호' },
  { name: 'EXP', desc: 'e 거듭제곱' },
  { name: 'LOG', desc: '자연로그' },
  { name: 'LOG10', desc: '상용로그' },
  { name: 'SIN', desc: '사인' },
  { name: 'COS', desc: '코사인' },
  { name: 'TAN', desc: '탄젠트' },
];

const EASY_RANGES = [
  { value: '', label: '(선택)' },
  { value: 'left', label: '왼쪽 (left)' },
  { value: 'right', label: '오른쪽 (right)' },
  { value: 'above', label: '위쪽 (above)' },
  { value: 'below', label: '아래쪽 (below)' },
];

const FORMATS = [
  { value: 'default', label: '기본 형식' },
  { value: 'integer', label: '정수' },
  { value: 'decimal1', label: '소수 1자리' },
  { value: 'decimal2', label: '소수 2자리' },
];

export class FormulaDialog extends ModalDialog {
  private wasm: any;
  private eventBus: EventBus;
  private ctx: FormulaContext;
  private formulaInput!: HTMLInputElement;
  private funcSelect!: HTMLSelectElement;
  private formatSelect!: HTMLSelectElement;
  private commaCheck!: HTMLInputElement;
  private errorMsg!: HTMLDivElement;

  constructor(wasm: any, eventBus: EventBus, ctx: FormulaContext, private services?: CommandServices) {
    super('계산식', 420);
    this.wasm = wasm;
    this.eventBus = eventBus;
    this.ctx = ctx;
  }

  protected createBody(): HTMLElement {
    const body = document.createElement('div');
    body.className = 'formula-dialog-body';

    // 계산식 입력
    body.appendChild(this.createRow('계산식(E):', () => {
      this.formulaInput = document.createElement('input');
      this.formulaInput.type = 'text';
      this.formulaInput.className = 'formula-input';
      this.formulaInput.value = '=';
      this.formulaInput.placeholder = '=SUM(A1:A5)';
      return this.formulaInput;
    }));

    // 함수 선택
    body.appendChild(this.createRow('함수(F):', () => {
      this.funcSelect = document.createElement('select');
      this.funcSelect.className = 'formula-select';
      this.funcSelect.appendChild(makeOption('', '(선택)'));
      FUNCTIONS.forEach(f => this.funcSelect.appendChild(makeOption(f.name, `${f.name} - ${f.desc}`)));
      this.funcSelect.addEventListener('change', () => {
        const func = this.funcSelect.value;
        if (func) {
          const pos = this.formulaInput.selectionStart ?? this.formulaInput.value.length;
          const before = this.formulaInput.value.substring(0, pos);
          const after = this.formulaInput.value.substring(pos);
          this.formulaInput.value = before + func + '()' + after;
          this.formulaInput.focus();
          this.formulaInput.selectionStart = this.formulaInput.selectionEnd = pos + func.length + 1;
          this.funcSelect.value = '';
        }
      });
      return this.funcSelect;
    }));

    // 쉬운 범위
    body.appendChild(this.createRow('쉬운 범위(R):', () => {
      const sel = document.createElement('select');
      sel.className = 'formula-select';
      EASY_RANGES.forEach(r => sel.appendChild(makeOption(r.value, r.label)));
      sel.addEventListener('change', () => {
        if (sel.value) {
          const pos = this.formulaInput.selectionStart ?? this.formulaInput.value.length;
          const before = this.formulaInput.value.substring(0, pos);
          const after = this.formulaInput.value.substring(pos);
          this.formulaInput.value = before + sel.value + after;
          this.formulaInput.focus();
          sel.value = '';
        }
      });
      return sel;
    }));

    // 형식
    body.appendChild(this.createRow('형식(M):', () => {
      this.formatSelect = document.createElement('select');
      this.formatSelect.className = 'formula-select';
      FORMATS.forEach(f => this.formatSelect.appendChild(makeOption(f.value, f.label)));
      return this.formatSelect;
    }));

    // 쉼표 구분
    const commaRow = document.createElement('div');
    commaRow.className = 'formula-row';
    const commaLabel = document.createElement('label');
    this.commaCheck = document.createElement('input');
    this.commaCheck.type = 'checkbox';
    this.commaCheck.checked = true;
    commaLabel.appendChild(this.commaCheck);
    commaLabel.appendChild(document.createTextNode(' 세 자리마다 쉼표로 자리 구분(C)'));
    commaRow.appendChild(commaLabel);
    body.appendChild(commaRow);

    // 오류 메시지 영역
    this.errorMsg = document.createElement('div');
    this.errorMsg.className = 'formula-error';
    this.errorMsg.style.display = 'none';
    body.appendChild(this.errorMsg);

    return body;
  }

  private createRow(labelText: string, createControl: () => HTMLElement): HTMLElement {
    const row = document.createElement('div');
    row.className = 'formula-row';
    const label = document.createElement('label');
    label.textContent = labelText;
    row.appendChild(label);
    row.appendChild(createControl());
    return row;
  }

  show(): void {
    super.show();
    setTimeout(() => this.formulaInput?.focus(), 100);
  }

  protected onConfirm(): boolean {
    const formula = this.formulaInput.value;
    this.clearError();

    if (!formula || formula === '=' || formula === '@') {
      this.showError('계산식을 입력하세요.');
      return false;
    }

    try {
      // 셀 목록은 병합 기준 셀만 담으므로 cellIndex 를 열 수로 나누면 병합 표에서 다른 칸이 된다.
      // 엔진이 알려 주는 실제 행/열을 쓴다. 중첩 표는 셀 경로로 안쪽 표를 다룬다.
      const target = tableTarget(this.wasm, this.ctx);
      const cellInfo = target.cellInfo(this.ctx.cellIndex);
      const decimalPlaces: Record<string, number> = { integer: 0, decimal1: 1, decimal2: 2 };
      const options = {
        targetRow: cellInfo.row, targetCol: cellInfo.col, formula,
        decimalPlaces: decimalPlaces[this.formatSelect.value],
        thousandsSeparator: this.commaCheck.checked,
      };

      // 먼저 검증 (writeResult=false)
      try {
        target.evaluateFormula({ ...options, writeResult: false });
      } catch (e: any) {
        this.showError(e?.message || '계산식에 오류가 있습니다.');
        return false;
      }

      // 검증 통과 → 형식과 쉼표를 적용한 결과를 한 번에 기록한다.
      // [계산식 이관] 미기록 뮤테이션은 undo 불가에 더해 셀 문자 수 변화로 후속 undo 오프셋이
      // 오염된다(#2344 계열) → 하나의 snapshot 으로 라우팅(#2077 동형). services 미주입 시 직접 적용.
      const commit = () => { target.evaluateFormula({ ...options, writeResult: true }); };
      const ih = this.services?.getInputHandler();
      if (ih) {
        ih.executeOperation({
          kind: 'snapshot',
          operationType: 'tableFormula',
          operation: () => { commit(); return ih.getCursorPosition(); },
        });
      } else {
        commit();
        this.eventBus.emit('document-changed');
      }
      return true; // 성공 → 대화상자 닫기
    } catch (e: any) {
      this.showError('계산식 실행 실패: ' + (e.message || e));
      return false; // 실패 → 대화상자 유지
    }
  }

  private showError(msg: string): void {
    this.errorMsg.textContent = '⚠ ' + msg;
    this.errorMsg.style.display = 'block';
    this.formulaInput.classList.add('formula-input-error');
    this.formulaInput.focus();
  }

  private clearError(): void {
    this.errorMsg.style.display = 'none';
    this.errorMsg.textContent = '';
    this.formulaInput.classList.remove('formula-input-error');
  }
}
