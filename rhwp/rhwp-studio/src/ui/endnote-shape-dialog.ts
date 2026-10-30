import { ModalDialog } from './dialog';
import type { EventBus } from '@/core/event-bus';
import type { NoteShapeSettings } from '@/core/types';
import { HWPUNIT_PER_MM } from '@/core/hwp-constants';
import type { WasmBridge } from '@/core/wasm-bridge';
import type { CommandServices } from '@/command/types';

type LineTypeChoice = {
  value: string;
  label: string;
  css: 'solid' | 'dashed' | 'dotted' | 'double';
  dash?: string;
};

type LineWidthChoice = {
  value: string;
  label: string;
  px: number;
};

const LINE_TYPE_CHOICES: LineTypeChoice[] = [
  { value: '1', label: '실선', css: 'solid' },
  { value: '2', label: '점선', css: 'dotted', dash: '1 4' },
  { value: '3', label: '파선', css: 'dashed', dash: '9 4' },
  { value: '4', label: '쇄선', css: 'dashed', dash: '9 4 2 4' },
  { value: '5', label: '이점 쇄선', css: 'dashed', dash: '9 4 2 4 2 4' },
  { value: '6', label: '긴 파선', css: 'dashed', dash: '14 5' },
  { value: '8', label: '이중선', css: 'double' },
  { value: '9', label: '얇고 굵은 이중선', css: 'double' },
  { value: '10', label: '굵고 얇은 이중선', css: 'double' },
  { value: '11', label: '삼중선', css: 'double' },
];

const LINE_WIDTH_CHOICES: LineWidthChoice[] = [
  { value: '0', label: '0.1mm', px: 1 },
  { value: '1', label: '0.12mm', px: 1.2 },
  { value: '2', label: '0.15mm', px: 1.4 },
  { value: '3', label: '0.2mm', px: 1.6 },
  { value: '4', label: '0.25mm', px: 1.8 },
  { value: '5', label: '0.3mm', px: 2 },
  { value: '6', label: '0.4mm', px: 2.4 },
  { value: '7', label: '0.5mm', px: 2.8 },
  { value: '8', label: '0.6mm', px: 3.2 },
  { value: '9', label: '0.7mm', px: 3.6 },
  { value: '10', label: '1mm', px: 4.2 },
  { value: '11', label: '1.5mm', px: 5 },
  { value: '12', label: '2mm', px: 6 },
  { value: '13', label: '3mm', px: 7.5 },
  { value: '14', label: '4mm', px: 9 },
  { value: '15', label: '5mm', px: 10.5 },
];

const COLOR_SWATCHES = [
  '#000000', '#ffffff', '#ff0000', '#ff7f00', '#ffff00', '#00b050', '#00b0f0', '#0000ff',
  '#7030a0', '#808080', '#c0c0c0', '#c00000', '#ffc000', '#92d050', '#00b050', '#00b0f0',
  '#002060', '#7030a0', '#f4cccc', '#fce5cd', '#fff2cc', '#d9ead3', '#d9eaf7', '#d9d2e9',
  '#eadcf8', '#e6e6e6', '#f9cb9c', '#ffe599', '#b6d7a8', '#76a5af', '#6fa8dc', '#8e7cc3',
];

let dialogInstanceSeq = 0;

export type NoteKind = 'footnote' | 'endnote';
const KINDS: NoteKind[] = ['footnote', 'endnote'];
const KIND_LABEL: Record<NoteKind, string> = { footnote: '각주', endnote: '미주' };

/** 한컴이 각주·미주 모양에 내놓는 번호 모양. 다른 저장값은 열 때 따로 덧붙인다. */
const NUMBER_FORMAT_CHOICES: [string, string][] = [
  ['digit', '1,2,3'],
  ['circledDigit', '①,②,③'],
  ['upperRoman', 'I,II,III'],
  ['lowerRoman', 'i,ii,iii'],
  ['upperAlpha', 'A,B,C'],
  ['lowerAlpha', 'a,b,c'],
  ['circledUpperAlpha', 'Ⓐ,Ⓑ,Ⓒ'],
  ['hangulSyllable', '가,나,다'],
  ['hangulJamo', 'ㄱ,ㄴ,ㄷ'],
  ['hangulDigit', '일,이,삼'],
  ['hanjaDigit', '一,二,三'],
  ['decagonCircle', '갑,을,병'],
  ['decagonCircleHanja', '甲,乙,丙'],
  ['symbol', '*,†,‡'],
  ['userChar', '사용자 기호'],
];
const OTHER_NUMBER_FORMATS: Record<string, string> = {
  circledLowerAlpha: 'ⓐ,ⓑ,ⓒ', circledHangulSyllable: '㉮,㉯,㉰', circledHangulJamo: '㉠,㉡,㉢', circledHanjaDigit: '㊀,㊁,㊂',
};

/** 구분선 길이 저장값: -1 은 한컴 기본 5 cm, 14692344 는 한컴 미주 기본(단 너비로 그린다). */
const LENGTH_DEFAULT = -1;
const LENGTH_COLUMN = 14692344;

function normalizeColor(value: string | undefined | null): string {
  const text = (value || '').trim();
  if (/^#[0-9a-fA-F]{6}$/.test(text)) {
    return text.toLowerCase();
  }
  return '#000000';
}

function hwpToMm(value: number): number {
  return Math.round(value / HWPUNIT_PER_MM * 10) / 10;
}

function mmToHwp(value: number, max = 300): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(Math.min(max, Math.max(0, value)) * HWPUNIT_PER_MM);
}

function sameSettings(a: NoteShapeSettings, b: NoteShapeSettings): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)].filter(key => key !== 'ok'));
  return [...keys].every(key => a[key as keyof NoteShapeSettings] === b[key as keyof NoteShapeSettings]);
}

/**
 * 각주·미주 모양 대화상자. 두 탭이 같은 컨트롤을 쓰고, 탭마다 고친 값을 따로 들고 있다가 확인 한 번에 함께 적용한다.
 * 손대지 않은 컨트롤은 저장값을 그대로 남겨, 대화상자가 모르는 값도 확인 뒤에 살아 있다.
 */
export class NoteShapeDialog extends ModalDialog {
  private readonly radioNameSuffix = ++dialogInstanceSeq;
  private stored!: Record<NoteKind, NoteShapeSettings>;
  private drafts!: Record<NoteKind, NoteShapeSettings>;
  private kind: NoteKind;
  /** 지금 탭을 채운 직후의 컨트롤 값. 확인할 때 이와 다른 컨트롤만 읽는다. */
  private shown: Record<string, string> = {};
  private tabButtons = new Map<NoteKind, HTMLButtonElement>();
  private numberFormatSelect!: HTMLSelectElement;
  private userCharInput!: HTMLInputElement;
  private prefixInput!: HTMLInputElement;
  private suffixInput!: HTMLInputElement;
  private separatorCheck!: HTMLInputElement;
  private lineTypeSelect!: HTMLSelectElement;
  private lineTypeButton!: HTMLButtonElement;
  private lineTypeMenu!: HTMLDivElement;
  private lineWidthSelect!: HTMLSelectElement;
  private lineWidthButton!: HTMLButtonElement;
  private lineWidthMenu!: HTMLDivElement;
  private lineColorInput!: HTMLInputElement;
  private lineColorButton!: HTMLButtonElement;
  private lineColorMenu!: HTMLDivElement;
  private separatorLengthModeSelect!: HTMLSelectElement;
  private separatorLengthInput!: HTMLInputElement;
  private marginTopInput!: HTMLInputElement;
  private noteSpacingInput!: HTMLInputElement;
  private noteSpacingLabel!: HTMLSpanElement;
  private marginBottomInput!: HTMLInputElement;
  private startNumberInput!: HTMLInputElement;
  private numberingRadios: HTMLInputElement[] = [];
  private numberingPageRow!: HTMLElement;
  private superscriptRadios: HTMLInputElement[] = [];
  private contentNumberLegend!: HTMLLegendElement;
  private footnotePlacement!: HTMLFieldSetElement;
  private endnotePlacement!: HTMLFieldSetElement;
  private footnotePlacementRadios: HTMLInputElement[] = [];
  private endnotePlacementRadios: HTMLInputElement[] = [];
  private beneathTextCheck!: HTMLInputElement;
  private popupDismissPointerHandler: ((event: PointerEvent) => void) | null = null;
  private popupDismissFocusHandler: ((event: FocusEvent) => void) | null = null;

  constructor(
    private wasm: WasmBridge,
    private eventBus: EventBus,
    private sectionIdx: number,
    private services?: CommandServices,
    initialKind: NoteKind = 'endnote',
  ) {
    super('각주/미주 모양', 520);
    this.kind = initialKind;
  }

  show(): void {
    this.stored = { footnote: this.wasm.getFootnoteShape(this.sectionIdx), endnote: this.wasm.getEndnoteShape(this.sectionIdx) };
    this.drafts = { footnote: { ...this.stored.footnote }, endnote: { ...this.stored.endnote } };
    super.show();
    this.attachPopupDismissHandlers();
    this.selectTab(this.kind);
  }

  hide(): void {
    this.detachPopupDismissHandlers();
    this.closePopupMenus();
    super.hide();
  }

  protected createBody(): HTMLElement {
    const body = document.createElement('div');
    body.style.cssText = 'display:flex;flex-direction:column;gap:8px;';

    const tabs = document.createElement('div');
    tabs.className = 'dialog-tabs';
    tabs.setAttribute('role', 'tablist');
    for (const kind of KINDS) {
      const tab = document.createElement('button');
      tab.type = 'button';
      tab.className = 'dialog-tab';
      tab.setAttribute('role', 'tab');
      tab.textContent = `${KIND_LABEL[kind]} 모양`;
      tab.addEventListener('click', () => this.switchTab(kind));
      this.tabButtons.set(kind, tab);
      tabs.appendChild(tab);
    }

    this.footnotePlacement = this.footnotePlacementGroup();
    this.endnotePlacement = this.endnotePlacementGroup();
    body.append(
      tabs,
      this.numberGroup(),
      this.spacingGroup(),
      this.numberingGroup(),
      this.contentNumberGroup(),
      this.footnotePlacement,
      this.endnotePlacement,
    );
    return body;
  }

  protected onConfirm(): void {
    this.drafts[this.kind] = this.collect();
    const changed = KINDS.filter(kind => !sameSettings(this.drafts[kind], this.stored[kind]));
    if (!changed.length) return;
    const drafts = this.drafts;
    const apply = () => {
      for (const kind of changed) {
        if (kind === 'footnote') this.wasm.applyFootnoteShape(this.sectionIdx, drafts.footnote);
        else this.wasm.applyEndnoteShape(this.sectionIdx, drafts.endnote);
      }
    };
    // 두 탭을 함께 고쳐도 확인 한 번이 되돌리기 한 칸이다. services 미주입 시 직접 적용 fallback.
    const ih = this.services?.getInputHandler();
    if (ih) {
      ih.executeOperation({
        kind: 'snapshot',
        operationType: 'noteShape',
        operation: () => { apply(); return ih.getCursorPosition(); },
      });
    } else {
      apply();
      this.eventBus.emit('document-changed');
    }
  }

  private switchTab(kind: NoteKind): void {
    if (kind === this.kind) return;
    this.drafts[this.kind] = this.collect();
    this.selectTab(kind);
  }

  private selectTab(kind: NoteKind): void {
    this.kind = kind;
    for (const [tabKind, tab] of this.tabButtons) {
      const active = tabKind === kind;
      tab.classList.toggle('active', active);
      tab.setAttribute('aria-selected', String(active));
    }
    const label = KIND_LABEL[kind];
    this.noteSpacingLabel.textContent = `${label} 사이`;
    this.contentNumberLegend.textContent = `${label} 내용 번호 속성`;
    this.numberingPageRow.style.display = kind === 'footnote' ? '' : 'none';
    this.footnotePlacement.style.display = kind === 'footnote' ? '' : 'none';
    this.endnotePlacement.style.display = kind === 'endnote' ? '' : 'none';
    this.populate(this.drafts[kind]);
  }

  private populate(settings: NoteShapeSettings): void {
    this.fillNumberFormats(settings.numberFormat);
    this.userCharInput.value = settings.userChar || '';
    this.prefixInput.value = settings.prefixChar || '';
    this.suffixInput.value = settings.suffixChar || '';
    this.startNumberInput.value = String(settings.startNumber ?? 1);
    this.separatorCheck.checked = settings.separatorEnabled !== false;
    this.setLineTypeValue(settings.separatorLineType ?? 1);
    this.setLineWidthValue(settings.separatorLineWidth ?? 1);
    this.setSeparatorColor(settings.separatorColor);
    this.updateLineTypePreview();
    this.updateLineWidthPreview();
    const length = settings.separatorLength;
    this.separatorLengthModeSelect.value = length === LENGTH_DEFAULT || (length === 0 && this.kind === 'footnote') ? 'default'
      : length === LENGTH_COLUMN || length === 0 ? 'column' : 'custom';
    this.separatorLengthInput.value = this.separatorLengthModeSelect.value === 'custom' ? String(hwpToMm(length)) : '50';
    this.marginTopInput.value = String(hwpToMm(settings.separatorMarginTop || 0));
    this.noteSpacingInput.value = String(hwpToMm(settings.noteSpacing || 0));
    this.marginBottomInput.value = String(hwpToMm(settings.separatorMarginBottom || 0));
    for (const radio of this.numberingRadios) radio.checked = radio.value === settings.numbering;
    for (const radio of this.superscriptRadios) radio.checked = radio.value === String(!!settings.superscript);
    for (const radio of [...this.footnotePlacementRadios, ...this.endnotePlacementRadios]) radio.checked = radio.value === settings.placement;
    this.beneathTextCheck.checked = !!settings.beneathText;
    this.updateSeparatorEnabled();
    this.updateUserCharEnabled();
    this.shown = this.controlValues();
  }

  /** 열 때 있던 저장값 하나만 목록 밖이면 그 값을 덧붙여 그대로 고를 수 있게 한다. */
  private fillNumberFormats(current: string): void {
    const choices = [...NUMBER_FORMAT_CHOICES];
    if (!choices.some(([value]) => value === current)) choices.push([current, OTHER_NUMBER_FORMATS[current] ?? `번호 모양 ${current}`]);
    this.numberFormatSelect.replaceChildren(...choices.map(([value, label]) => {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      return option;
    }));
    this.numberFormatSelect.value = current;
  }

  private checkedValue(radios: HTMLInputElement[]): string {
    return radios.find(radio => radio.checked)?.value ?? '';
  }

  private controlValues(): Record<string, string> {
    return {
      numberFormat: this.numberFormatSelect.value,
      userChar: this.userCharInput.value,
      prefixChar: this.prefixInput.value,
      suffixChar: this.suffixInput.value,
      startNumber: this.startNumberInput.value,
      separatorEnabled: String(this.separatorCheck.checked),
      separatorLineType: this.lineTypeSelect.value,
      separatorLineWidth: this.lineWidthSelect.value,
      separatorColor: normalizeColor(this.lineColorInput.value),
      separatorLength: `${this.separatorLengthModeSelect.value}:${this.separatorLengthInput.value}`,
      separatorMarginTop: this.marginTopInput.value,
      noteSpacing: this.noteSpacingInput.value,
      separatorMarginBottom: this.marginBottomInput.value,
      numbering: this.checkedValue(this.numberingRadios),
      superscript: this.checkedValue(this.superscriptRadios),
      placement: this.checkedValue(this.kind === 'footnote' ? this.footnotePlacementRadios : this.endnotePlacementRadios),
      beneathText: String(this.beneathTextCheck.checked),
    };
  }

  /** 지금 탭의 초안에 사용자가 바꾼 컨트롤만 덮어쓴다. */
  private collect(): NoteShapeSettings {
    const next = { ...this.drafts[this.kind] };
    const now = this.controlValues();
    const changed = (key: string) => now[key] !== this.shown[key];
    const mm = (input: HTMLInputElement, fallback: number) => {
      const value = parseFloat(input.value);
      return Number.isFinite(value) ? mmToHwp(value) : fallback;
    };
    if (changed('numberFormat')) next.numberFormat = now.numberFormat;
    if (changed('userChar')) next.userChar = now.userChar.slice(0, 1);
    if (changed('prefixChar')) next.prefixChar = now.prefixChar.slice(0, 1);
    if (changed('suffixChar')) next.suffixChar = now.suffixChar.slice(0, 1);
    if (changed('startNumber')) {
      const start = parseInt(now.startNumber, 10);
      if (Number.isInteger(start) && start >= 1 && start <= 0xffff) next.startNumber = start;
    }
    if (changed('separatorEnabled')) next.separatorEnabled = this.separatorCheck.checked;
    if (changed('separatorLineType')) next.separatorLineType = parseInt(now.separatorLineType, 10);
    if (changed('separatorLineWidth')) next.separatorLineWidth = parseInt(now.separatorLineWidth, 10);
    if (changed('separatorColor')) next.separatorColor = now.separatorColor;
    if (changed('separatorLength')) {
      const mode = this.separatorLengthModeSelect.value;
      next.separatorLength = mode === 'default' ? LENGTH_DEFAULT : mode === 'column' ? LENGTH_COLUMN
        : mm(this.separatorLengthInput, next.separatorLength);
    }
    if (changed('separatorMarginTop')) next.separatorMarginTop = mm(this.marginTopInput, next.separatorMarginTop);
    if (changed('noteSpacing')) next.noteSpacing = mm(this.noteSpacingInput, next.noteSpacing);
    if (changed('separatorMarginBottom')) next.separatorMarginBottom = mm(this.marginBottomInput, next.separatorMarginBottom);
    if (changed('numbering') && now.numbering) next.numbering = now.numbering;
    if (changed('superscript') && now.superscript) next.superscript = now.superscript === 'true';
    if (changed('placement') && now.placement) next.placement = now.placement;
    if (changed('beneathText')) next.beneathText = this.beneathTextCheck.checked;
    return next;
  }

  private numberGroup(): HTMLElement {
    const group = this.group('번호 서식');
    this.numberFormatSelect = document.createElement('select');
    this.numberFormatSelect.className = 'dialog-select';
    this.numberFormatSelect.addEventListener('change', () => this.updateUserCharEnabled());
    this.fillNumberFormats('digit');

    this.userCharInput = this.charInput();
    this.prefixInput = this.charInput();
    this.suffixInput = this.charInput();
    this.separatorCheck = document.createElement('input');
    this.separatorCheck.type = 'checkbox';
    this.separatorCheck.addEventListener('change', () => this.updateSeparatorEnabled());
    this.buildLineTypeControl();
    this.buildLineWidthControl();
    this.separatorLengthModeSelect = this.select([['default', '5 cm'], ['column', '단 너비'], ['custom', '사용자']]);
    this.separatorLengthModeSelect.style.width = '86px';
    this.separatorLengthModeSelect.addEventListener('change', () => this.updateSeparatorEnabled());
    this.separatorLengthInput = this.numberInput(50, 0, 300, 0.5);
    this.buildColorControl();

    group.append(
      this.row(this.label('번호 모양'), this.numberFormatSelect, this.label('사용자 기호'), this.userCharInput),
      this.row(this.label('앞 장식 문자'), this.prefixInput, this.label('뒤 장식 문자'), this.suffixInput),
      this.checkboxRow(this.separatorCheck, '구분선 넣기'),
      this.pairRow(
        '종류',
        this.linePreviewSelect(this.lineTypeSelect, this.lineTypeButton, this.lineTypeMenu),
        '길이',
        this.inlineControls(
          this.separatorLengthModeSelect,
          this.withUnit(this.separatorLengthInput, 'mm'),
        ),
      ),
      this.pairRow('굵기', this.widthPreviewSelect(), '색', this.colorPicker()),
    );
    return group;
  }

  private spacingGroup(): HTMLElement {
    const group = this.group('여백');
    this.marginTopInput = this.numberInput(0, 0, 100, 0.5);
    this.noteSpacingInput = this.numberInput(7, 0, 100, 0.5);
    this.marginBottomInput = this.numberInput(2, 0, 100, 0.5);
    this.noteSpacingLabel = this.label('미주 사이');
    group.append(
      this.row(this.label('구분선 위'), this.withUnit(this.marginTopInput, 'mm')),
      this.row(this.noteSpacingLabel, this.withUnit(this.noteSpacingInput, 'mm')),
      this.row(this.label('구분선 아래'), this.withUnit(this.marginBottomInput, 'mm')),
    );
    return group;
  }

  private numberingGroup(): HTMLElement {
    const group = this.group('번호 매기기');
    const name = `note-numbering-${this.radioNameSuffix}`;
    this.numberingRadios = ['continue', 'restartSection', 'restartPage'].map(value => this.radio(name, value));
    const [cont, section, page] = this.numberingRadios;
    this.numberingPageRow = this.radioRow(page, '쪽마다 새로 시작');
    this.startNumberInput = this.numberInput(1, 1, 65535, 1);
    group.append(
      this.radioRow(cont, '앞 구역에 이어서'),
      this.radioRow(section, '현재 구역부터 새로 시작'),
      this.numberingPageRow,
      this.row(this.label('시작 번호'), this.startNumberInput),
    );
    return group;
  }

  private contentNumberGroup(): HTMLElement {
    const group = this.group('미주 내용 번호 속성');
    this.contentNumberLegend = group.querySelector('legend')!;
    const name = `note-content-number-${this.radioNameSuffix}`;
    this.superscriptRadios = ['false', 'true'].map(value => this.radio(name, value));
    group.append(this.radioRow(this.superscriptRadios[0], '보통'), this.radioRow(this.superscriptRadios[1], '위 첨자'));
    return group;
  }

  private footnotePlacementGroup(): HTMLFieldSetElement {
    const group = this.group('각주 위치');
    const name = `footnote-placement-${this.radioNameSuffix}`;
    this.footnotePlacementRadios = ['eachColumn', 'mergedColumn', 'rightMostColumn'].map(value => this.radio(name, value));
    const [each, merged, right] = this.footnotePlacementRadios;
    this.beneathTextCheck = document.createElement('input');
    this.beneathTextCheck.type = 'checkbox';
    group.append(
      this.radioRow(each, '각 단 아래'),
      this.radioRow(merged, '다단 아래'),
      this.radioRow(right, '오른쪽 단 아래'),
      this.checkboxRow(this.beneathTextCheck, '본문 아래'),
    );
    return group;
  }

  private endnotePlacementGroup(): HTMLFieldSetElement {
    const group = this.group('미주 위치');
    const name = `endnote-placement-${this.radioNameSuffix}`;
    this.endnotePlacementRadios = ['documentEnd', 'sectionEnd'].map(value => this.radio(name, value));
    group.append(
      this.radioRow(this.endnotePlacementRadios[0], '문서의 끝'),
      this.radioRow(this.endnotePlacementRadios[1], '구역의 끝'),
    );
    return group;
  }

  private updateSeparatorEnabled(): void {
    const enabled = this.separatorCheck.checked;
    for (const el of [
      this.lineTypeSelect,
      this.lineTypeButton,
      this.lineWidthSelect,
      this.lineWidthButton,
      this.separatorLengthModeSelect,
      this.lineColorInput,
      this.lineColorButton,
    ]) {
      el.disabled = !enabled;
    }
    this.separatorLengthInput.disabled = !enabled || this.separatorLengthModeSelect.value !== 'custom';
  }

  private updateUserCharEnabled(): void {
    this.userCharInput.disabled = this.numberFormatSelect.value !== 'userChar';
  }

  private group(title: string): HTMLFieldSetElement {
    const fieldset = document.createElement('fieldset');
    fieldset.style.cssText = 'border:1px solid var(--color-border-lighter);padding:4px 10px 6px;margin:0;min-width:0;';
    const legend = document.createElement('legend');
    legend.textContent = title;
    legend.style.cssText = 'font-size:12px;color:var(--color-primary-dark);padding:0 4px;';
    fieldset.appendChild(legend);
    return fieldset;
  }

  private row(...children: HTMLElement[]): HTMLElement {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:8px;margin:3px 0;font-size:13px;flex-wrap:wrap;min-height:28px;';
    row.append(...children);
    return row;
  }

  private pairRow(
    leftLabel: string,
    leftControl: HTMLElement,
    rightLabel: string,
    rightControl: HTMLElement,
  ): HTMLElement {
    const row = document.createElement('div');
    row.style.cssText = [
      'display:grid;grid-template-columns:48px 118px 48px minmax(0,1fr);',
      'align-items:center;column-gap:10px;row-gap:6px;margin:3px 0;',
      'font-size:13px;min-height:28px;',
    ].join('');
    row.append(
      this.pairLabel(leftLabel),
      leftControl,
      this.pairLabel(rightLabel),
      rightControl,
    );
    return row;
  }

  private pairLabel(text: string): HTMLSpanElement {
    const label = document.createElement('span');
    label.textContent = text;
    label.style.cssText = 'color:var(--color-text);text-align:right;white-space:nowrap;';
    return label;
  }

  private label(text: string): HTMLSpanElement {
    const label = document.createElement('span');
    label.textContent = text;
    label.style.cssText = 'min-width:78px;color:var(--color-text);';
    return label;
  }

  private charInput(): HTMLInputElement {
    const input = document.createElement('input');
    input.type = 'text';
    input.maxLength = 1;
    input.className = 'dialog-input';
    input.style.width = '44px';
    return input;
  }

  private numberInput(value: number, min: number, max: number, step: number): HTMLInputElement {
    const input = document.createElement('input');
    input.type = 'number';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(value);
    input.className = 'dialog-input';
    input.style.width = '72px';
    return input;
  }

  private select(options: [string, string][]): HTMLSelectElement {
    const select = document.createElement('select');
    select.className = 'dialog-select';
    for (const [value, label] of options) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      select.appendChild(option);
    }
    return select;
  }

  private hiddenSelect(options: [string, string][]): HTMLSelectElement {
    const select = this.select(options);
    select.style.display = 'none';
    return select;
  }

  private linePreviewSelect(
    select: HTMLSelectElement,
    button: HTMLButtonElement,
    menu: HTMLDivElement,
  ): HTMLElement {
    const wrap = this.popupWrap();
    wrap.append(select, button, menu);
    return wrap;
  }

  private widthPreviewSelect(): HTMLElement {
    const wrap = this.popupWrap();
    wrap.append(this.lineWidthSelect, this.lineWidthButton, this.lineWidthMenu);
    return wrap;
  }

  private colorPicker(): HTMLElement {
    const wrap = this.popupWrap();
    wrap.append(this.lineColorInput, this.lineColorButton, this.lineColorMenu);
    return wrap;
  }

  private popupWrap(): HTMLElement {
    const wrap = document.createElement('span');
    wrap.dataset.endnotePopupRoot = '1';
    wrap.style.cssText = 'position:relative;display:inline-flex;align-items:center;';
    return wrap;
  }

  private inlineControls(...children: HTMLElement[]): HTMLElement {
    const wrap = document.createElement('span');
    wrap.style.cssText = 'display:inline-flex;align-items:center;gap:8px;min-width:0;';
    wrap.append(...children);
    return wrap;
  }

  private buildLineTypeControl(): void {
    this.lineTypeSelect = this.hiddenSelect(LINE_TYPE_CHOICES.map(choice => [choice.value, choice.label]));
    this.lineTypeButton = this.previewButton();
    this.lineTypeMenu = this.popupMenu(178);
    for (const choice of LINE_TYPE_CHOICES) {
      const option = this.menuOption(() => {
        this.setLineTypeValue(choice.value);
        this.updateLineTypePreview();
        this.closePopupMenus();
      });
      option.title = choice.label;
      option.append(this.linePreview(choice, 2, 'var(--color-text)'));
      this.lineTypeMenu.appendChild(option);
    }
    this.lineTypeButton.addEventListener('click', (event) => {
      event.stopPropagation();
      this.toggleMenu(this.lineTypeMenu);
    });
    this.updateLineTypePreview();
  }

  private buildLineWidthControl(): void {
    this.lineWidthSelect = this.hiddenSelect(LINE_WIDTH_CHOICES.map(choice => [choice.value, choice.label]));
    this.lineWidthButton = this.previewButton();
    this.lineWidthMenu = this.popupMenu(136);
    for (const choice of LINE_WIDTH_CHOICES) {
      const option = this.menuOption(() => {
        this.setLineWidthValue(choice.value);
        this.updateLineWidthPreview();
        this.closePopupMenus();
      });
      const label = document.createElement('span');
      label.textContent = choice.label;
      label.style.cssText = 'width:50px;color:var(--color-text);';
      option.append(label, this.widthPreview(choice));
      this.lineWidthMenu.appendChild(option);
    }
    this.lineWidthButton.addEventListener('click', (event) => {
      event.stopPropagation();
      this.toggleMenu(this.lineWidthMenu);
    });
    this.updateLineWidthPreview();
  }

  private buildColorControl(): void {
    this.lineColorInput = document.createElement('input');
    this.lineColorInput.type = 'color';
    this.lineColorInput.value = '#000000';
    this.lineColorInput.style.cssText = [
      'position:absolute;left:0;top:0;width:1px;height:1px;opacity:0;',
      'pointer-events:none;border:0;padding:0;',
    ].join('');
    this.lineColorInput.addEventListener('input', () => this.setSeparatorColor(this.lineColorInput.value));
    this.lineColorInput.addEventListener('change', () => this.setSeparatorColor(this.lineColorInput.value));

    this.lineColorButton = this.previewButton();
    this.lineColorButton.style.width = '74px';
    this.lineColorMenu = this.popupMenu(220);
    this.lineColorMenu.style.display = 'none';
    this.lineColorMenu.dataset.display = 'grid';
    this.lineColorMenu.style.gridTemplateColumns = 'repeat(8, 20px)';
    this.lineColorMenu.style.gap = '4px';
    this.lineColorMenu.style.padding = '8px';

    for (const color of COLOR_SWATCHES) {
      const swatch = document.createElement('button');
      swatch.type = 'button';
      swatch.title = color;
      swatch.dataset.color = color;
      swatch.className = 'endnote-shape-swatch';
      const chip = document.createElement('span');
      chip.style.cssText = `display:block;width:14px;height:14px;background:${color};border:1px solid var(--color-border-dark);`;
      swatch.appendChild(chip);
      swatch.addEventListener('click', (event) => {
        event.stopPropagation();
        this.setSeparatorColor(color);
        this.closePopupMenus();
      });
      this.lineColorMenu.appendChild(swatch);
    }

    const custom = document.createElement('button');
    custom.type = 'button';
    custom.textContent = '다른 색...';
    custom.className = 'endnote-shape-custom-color';
    custom.addEventListener('click', (event) => {
      event.stopPropagation();
      this.closePopupMenus();
      this.lineColorInput.click();
    });
    this.lineColorMenu.appendChild(custom);

    this.lineColorButton.addEventListener('click', (event) => {
      event.stopPropagation();
      this.toggleMenu(this.lineColorMenu);
    });
    this.updateColorPreview();
  }

  private previewButton(): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'endnote-shape-preview-button';
    const arrow = document.createElement('span');
    arrow.textContent = '▾';
    arrow.dataset.dropdownArrow = '1';
    arrow.style.cssText = 'position:absolute;right:6px;top:4px;color:var(--color-text-secondary);font-size:11px;';
    button.appendChild(arrow);
    return button;
  }

  private popupMenu(width: number): HTMLDivElement {
    const menu = document.createElement('div');
    menu.className = 'endnote-shape-popup-menu';
    menu.style.display = 'none';
    menu.style.width = `${width}px`;
    menu.addEventListener('click', event => event.stopPropagation());
    return menu;
  }

  private menuOption(onClick: () => void): HTMLButtonElement {
    const option = document.createElement('button');
    option.type = 'button';
    option.className = 'endnote-shape-popup-option';
    option.addEventListener('click', event => {
      event.stopPropagation();
      onClick();
    });
    return option;
  }

  private linePreview(choice: LineTypeChoice, widthPx: number, color: string): HTMLElement {
    const preview = document.createElement('span');
    preview.style.cssText = 'display:flex;align-items:center;width:92px;height:16px;';
    if (choice.css === 'double') {
      const inner = document.createElement('span');
      inner.style.cssText = [
        'display:block;width:82px;height:7px;border-top:2px solid currentColor;',
        'border-bottom:2px solid currentColor;color:inherit;',
      ].join('');
      preview.style.color = color;
      preview.appendChild(inner);
      return preview;
    }
    const line = document.createElement('span');
    const style = choice.css === 'dashed' || choice.css === 'dotted' ? choice.css : 'solid';
    line.style.cssText = [
      'display:block;width:82px;height:0;border-top-style:', style, ';',
      `border-top-width:${widthPx}px;border-top-color:${color};`,
    ].join('');
    preview.appendChild(line);
    return preview;
  }

  private widthPreview(choice: LineWidthChoice): HTMLElement {
    const preview = document.createElement('span');
    preview.style.cssText = 'display:flex;align-items:center;width:72px;height:16px;';
    const line = document.createElement('span');
    line.style.cssText = [
      'display:block;width:62px;height:0;border-top-style:solid;',
      `border-top-width:${choice.px}px;border-top-color:var(--color-text);`,
    ].join('');
    preview.appendChild(line);
    return preview;
  }

  private updateLineTypePreview(): void {
    const choice = LINE_TYPE_CHOICES.find(item => item.value === this.lineTypeSelect.value)
      ?? LINE_TYPE_CHOICES[0];
    this.setLineTypeValue(choice.value);
    this.replaceButtonPreview(this.lineTypeButton, this.linePreview(choice, 2, 'var(--color-text)'));
  }

  private updateLineWidthPreview(): void {
    const choice = LINE_WIDTH_CHOICES.find(item => item.value === this.lineWidthSelect.value)
      ?? LINE_WIDTH_CHOICES[0];
    this.setLineWidthValue(choice.value);
    this.replaceButtonPreview(this.lineWidthButton, this.widthPreview(choice));
  }

  private setLineTypeValue(value: string | number | undefined | null): void {
    const text = String(value ?? '');
    const choice = LINE_TYPE_CHOICES.find(item => item.value === text) ?? LINE_TYPE_CHOICES[0];
    this.lineTypeSelect.value = choice.value;
  }

  private setLineWidthValue(value: string | number | undefined | null): void {
    const text = String(value ?? '');
    const choice = LINE_WIDTH_CHOICES.find(item => item.value === text) ?? LINE_WIDTH_CHOICES[0];
    this.lineWidthSelect.value = choice.value;
  }

  private setSeparatorColor(color: string | undefined | null): void {
    this.lineColorInput.value = normalizeColor(color);
    this.updateColorPreview();
  }

  private updateColorPreview(): void {
    const color = normalizeColor(this.lineColorInput.value);
    const chip = document.createElement('span');
    chip.style.cssText = [
      `display:block;width:44px;height:16px;background:${color};`,
      'border:1px solid var(--color-border-dark);',
    ].join('');
    this.replaceButtonPreview(this.lineColorButton, chip);
    this.lineColorMenu?.querySelectorAll<HTMLButtonElement>('button[data-color]').forEach((button) => {
      const active = normalizeColor(button.dataset.color) === color;
      button.style.outline = active ? '2px solid var(--color-primary)' : 'none';
      button.style.outlineOffset = active ? '1px' : '0';
    });
  }

  private replaceButtonPreview(button: HTMLButtonElement, preview: HTMLElement): void {
    const arrow = button.querySelector('[data-dropdown-arrow="1"]');
    button.querySelectorAll('[data-preview="1"]').forEach(el => el.remove());
    preview.dataset.preview = '1';
    if (arrow) {
      button.insertBefore(preview, arrow);
    } else {
      button.appendChild(preview);
    }
  }

  private toggleMenu(menu: HTMLDivElement): void {
    const nextDisplay = menu.style.display === 'none' ? (menu.dataset.display || 'block') : 'none';
    this.closePopupMenus();
    menu.style.display = nextDisplay;
  }

  private attachPopupDismissHandlers(): void {
    if (this.popupDismissPointerHandler || this.popupDismissFocusHandler) return;
    this.popupDismissPointerHandler = (event: PointerEvent) => {
      if (this.isPopupTarget(event.target)) return;
      this.closePopupMenus();
    };
    this.popupDismissFocusHandler = (event: FocusEvent) => {
      if (this.isPopupTarget(event.target)) return;
      this.closePopupMenus();
    };
    document.addEventListener('pointerdown', this.popupDismissPointerHandler, true);
    document.addEventListener('focusin', this.popupDismissFocusHandler, true);
  }

  private detachPopupDismissHandlers(): void {
    if (this.popupDismissPointerHandler) {
      document.removeEventListener('pointerdown', this.popupDismissPointerHandler, true);
      this.popupDismissPointerHandler = null;
    }
    if (this.popupDismissFocusHandler) {
      document.removeEventListener('focusin', this.popupDismissFocusHandler, true);
      this.popupDismissFocusHandler = null;
    }
  }

  private isPopupTarget(target: EventTarget | null): boolean {
    return target instanceof HTMLElement
      && Boolean(target.closest('[data-endnote-popup-root="1"]'));
  }

  private closePopupMenus(): void {
    for (const menu of [this.lineTypeMenu, this.lineWidthMenu, this.lineColorMenu]) {
      if (menu) menu.style.display = 'none';
    }
  }

  private withUnit(input: HTMLElement, unit: string): HTMLElement {
    const wrap = document.createElement('span');
    wrap.style.cssText = 'display:inline-flex;align-items:center;gap:4px;';
    const unitEl = document.createElement('span');
    unitEl.textContent = unit;
    unitEl.style.color = 'var(--color-text-secondary)';
    wrap.append(input, unitEl);
    return wrap;
  }

  private checkboxRow(input: HTMLInputElement, labelText: string): HTMLElement {
    const label = document.createElement('label');
    label.style.cssText = 'display:flex;align-items:center;gap:6px;margin:5px 0;font-size:13px;';
    label.append(input, document.createTextNode(labelText));
    return label;
  }

  private radio(name: string, value: string): HTMLInputElement {
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = name;
    input.value = value;
    return input;
  }

  private radioRow(input: HTMLInputElement, labelText: string): HTMLElement {
    const label = document.createElement('label');
    label.style.cssText = 'display:inline-flex;align-items:center;gap:6px;margin:4px 14px 4px 0;font-size:13px;';
    label.append(input, document.createTextNode(labelText));
    return label;
  }
}
