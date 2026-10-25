/**
 * HeemangEngine 서식 조회 결과를 기존 Studio 위젯이 받는 모양으로 바꾼다.
 *
 * 도구 모음·눈금자·상태 표시줄은 구 엔진의 CharProperties·ParaProperties·PageDef 를 읽는다. 여기서는
 * 엔진 응답(FormatContext·StyleInfo·PageInfo)만 받아 같은 단위(HWPUNIT, 96 DPI px)로 옮긴다.
 */
import type { CharPatch, FormatContext, PageInfo as HmPage, ParaPatch, StyleInfo } from '../../vendor/hm-wasm/hm_wasm';
import type { CharProperties, PageDef, PageInfo, ParaProperties } from './types';

/** 쪽 좌표: HU(1/7200 inch) ÷ 75 = 96 DPI px. */
const HU_PER_PX = 75;
const roundedPx = (hu: number): number => Math.round(hu / HU_PER_PX * 10) / 10;

/** COLORREF(0x00BBGGRR) → '#rrggbb' */
export function colorRefToHex(color: number): string {
  const r = color & 0xff, g = (color >> 8) & 0xff, b = (color >> 16) & 0xff;
  return `#${[r, g, b].map(v => v.toString(16).padStart(2, '0')).join('')}`;
}

/** '#rrggbb' → COLORREF. 형식이 틀리면 null. */
export function hexToColorRef(hex: string): number | null {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) return null;
  const v = parseInt(hex.slice(1), 16);
  return ((v >> 16) & 0xff) | (v & 0xff00) | ((v & 0xff) << 16);
}

export function charProperties(characters: CharPatch): CharProperties {
  const props: CharProperties = {};
  if (characters.fontFace) props.fontFamily = characters.fontFace;
  if (characters.fontFaces) props.fontFamilies = characters.fontFaces.map(name => name ?? '');
  if (characters.size !== undefined) props.fontSize = characters.size;
  if (characters.bold !== undefined) props.bold = characters.bold;
  if (characters.italic !== undefined) props.italic = characters.italic;
  if (characters.underline !== undefined) props.underline = characters.underline;
  if (characters.strike !== undefined) props.strikethrough = characters.strike;
  if (characters.spacings) props.spacings = characters.spacings.map(value => value ?? 0);
  if (characters.ratios) props.ratios = characters.ratios.map(value => value ?? 100);
  if (characters.color !== undefined) props.textColor = colorRefToHex(characters.color);
  if (characters.shadeColor !== undefined) props.shadeColor = colorRefToHex(characters.shadeColor);
  if (characters.underlineKind !== undefined) props.underlineType = { none: 'None', below: 'Bottom', above: 'Top' }[characters.underlineKind];
  if (characters.underlineShape !== undefined) props.underlineShape = characters.underlineShape;
  if (characters.underlineColor !== undefined) props.underlineColor = colorRefToHex(characters.underlineColor);
  if (characters.strikeShape !== undefined) props.strikeShape = characters.strikeShape;
  if (characters.strikeColor !== undefined) props.strikeColor = colorRefToHex(characters.strikeColor);
  if (characters.outline !== undefined) props.outlineType = characters.outline;
  if (characters.shadow !== undefined) props.shadowType = characters.shadow;
  if (characters.shadowColor !== undefined) props.shadowColor = colorRefToHex(characters.shadowColor);
  if (characters.shadowOffset) [props.shadowOffsetX, props.shadowOffsetY] = characters.shadowOffset;
  if (characters.emphasis !== undefined) props.emphasisDot = characters.emphasis;
  for (const key of ['superscript', 'subscript', 'emboss', 'engrave', 'kerning'] as const) {
    if (characters[key] !== undefined) props[key] = characters[key];
  }
  if (characters.relSizes) props.relativeSizes = characters.relSizes.map(value => value ?? 100);
  if (characters.offsets) props.charOffsets = characters.offsets.map(value => value ?? 0);
  type Line = { style: number; width: number; color: number };
  const border = characters as unknown as { borderFillId?: number; borderFill?: Partial<Record<'left' | 'right' | 'top' | 'bottom', Line>> & { fill?: { kind: string; background?: number; patternColor?: number; pattern?: number } } };
  if (border.borderFillId !== undefined) props.borderFillId = border.borderFillId;
  if (border.borderFill) {
    for (const side of ['left', 'right', 'top', 'bottom'] as const) {
      const line = border.borderFill[side];
      if (line) Object.assign(props, { [`border${side[0].toUpperCase()}${side.slice(1)}`]: { type: line.style, width: line.width, color: colorRefToHex(line.color) } });
    }
    const fill = border.borderFill.fill;
    props.fillType = fill?.kind ?? 'none';
    props.fillColor = colorRefToHex(fill?.kind === 'solid' ? fill.background ?? 0xffffff : 0xffffff);
    props.patternColor = colorRefToHex(fill?.kind === 'solid' ? fill.patternColor ?? 0 : 0);
    props.patternType = fill?.kind === 'solid' ? fill.pattern ?? 0 : 0;
  }
  return props;
}

export function paraProperties(paragraphs: ParaPatch): ParaProperties {
  const props: ParaProperties = {};
  if (paragraphs.align) props.alignment = paragraphs.align === 'divide' ? 'split' : paragraphs.align;
  // 비율 줄 간격은 %, 나머지 줄 간격과 여백·간격은 구 엔진처럼 0.1px 로 반올림한 px 다.
  // 엔진의 비율 아닌 줄 간격은 HWP 저장값(HWPUNIT 의 2배)이다.
  if (paragraphs.lineSpacing !== undefined) {
    const kind = paragraphs.lineSpacingKind ?? 'percent';
    props.lineSpacing = kind === 'percent' ? paragraphs.lineSpacing : roundedPx(paragraphs.lineSpacing / 2);
    props.lineSpacingType = { percent: 'Percent', fixed: 'Fixed', added: 'SpaceOnly', atLeast: 'Minimum' }[kind];
  }
  if (paragraphs.left !== undefined) props.marginLeft = roundedPx(paragraphs.left);
  if (paragraphs.right !== undefined) props.marginRight = roundedPx(paragraphs.right);
  if (paragraphs.indent !== undefined) props.indent = roundedPx(paragraphs.indent);
  if (paragraphs.spaceBefore !== undefined) props.spacingBefore = roundedPx(paragraphs.spaceBefore);
  if (paragraphs.spaceAfter !== undefined) props.spacingAfter = roundedPx(paragraphs.spaceAfter);
  return props;
}

/** 캐럿 위치 서식을 위젯 이벤트 세 개의 값으로 나눈다. */
export function caretFormat(context: FormatContext, styles: readonly StyleInfo[]): {
  characters: CharProperties; paragraphs: ParaProperties; style: { id: number; name: string };
} {
  const style = styles.find(s => s.id === context.styleId);
  return {
    characters: charProperties(context.characters),
    paragraphs: paraProperties(context.paragraphs),
    style: { id: context.styleId, name: style?.name ?? '' },
  };
}

/** 구 엔진 getStyleList 와 같은 모양. type 0 은 문단 스타일, 1 은 글자 스타일이다. */
export function styleList(styles: readonly StyleInfo[]): Array<{ id: number; name: string; englishName: string; type: number; nextStyleId: number; paraShapeId: number; charShapeId: number }> {
  return styles.map(s => ({
    id: s.id, name: s.name, englishName: s.englishName, type: s.kind === 'character' ? 1 : 0,
    nextStyleId: s.next, paraShapeId: s.paraShape, charShapeId: s.charShape,
  }));
}

/** 구역 첫 쪽의 용지 설정. 값은 HWPUNIT 원본이다. */
export function pageDef(page: HmPage): PageDef {
  const m = page.margins;
  return {
    width: page.width, height: page.height,
    marginLeft: m.left, marginRight: m.right, marginTop: m.top, marginBottom: m.bottom,
    marginHeader: m.header, marginFooter: m.footer, marginGutter: m.gutter,
    landscape: page.landscape,
    // hm-wasm/1 은 제본 방식을 알리지 않는다. 한쪽 제본으로 둔다.
    binding: 0,
  };
}

/** 쪽 정보. 여백과 본문·단 상자는 px 다. */
export function pageInfo(page: HmPage): PageInfo {
  const px = (value: number) => value / HU_PER_PX;
  const m = page.margins;
  return {
    pageIndex: page.index, pageNumber: page.number, sectionIndex: page.section,
    width: px(page.width), height: px(page.height),
    marginLeft: px(m.left), marginRight: px(m.right), marginTop: px(m.top), marginBottom: px(m.bottom),
    marginHeader: px(m.header), marginFooter: px(m.footer),
    headerArea: { x: px(page.header.x), y: px(page.header.y), width: px(page.header.width), height: px(page.header.height) },
    footerArea: { x: px(page.footer.x), y: px(page.footer.y), width: px(page.footer.width), height: px(page.footer.height) },
    bodyLeft: px(page.body.x), bodyRight: px(page.body.x + page.body.width),
    // 엔진은 쪽 안 모든 영역의 단을 준다. 눈금자는 가로 위치가 다른 단만 구분한다.
    columns: page.columns
      .filter((column, i, all) => all.findIndex(c => c.x === column.x && c.width === column.width) === i)
      .map(column => ({ x: px(column.x), width: px(column.width) })),
  };
}
