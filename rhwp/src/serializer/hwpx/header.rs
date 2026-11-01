//! Contents/header.xml — DocInfo 리소스 테이블 동적 직렬화.
//!
//! Stage 1 (#182): IR의 `doc_info` 에 담긴 리소스를 역방향으로 HWPX XML로 출력한다.
//! IR이 비어있으면 해당 섹션도 비어있게 출력한다 (IR에 없는 리소스를 자동 생성하지 않음).
//!
//! 속성·자식 순서는 한컴 OWPML 공식 구현(hancom-io/hwpx-owpml-model, Apache 2.0)의
//! `Class/Head/*.cpp` 파일 `WriteElement()`, `InitMap()` 을 기준으로 맞춘다.
//!
//! ## 범위
//!
//! - 1단계 목표: 기존 HWPX 문서를 parse→serialize 했을 때 한컴2020이 온전히 다시 연다
//! - 완전히 새 빈 문서 생성은 1단계 범위 밖 (기본값 채우기 로직 없음)

use std::io::Write;

use quick_xml::Writer;

use crate::model::document::{DocInfo, DocProperties, Document};
use crate::model::style::{
    border_width_mm_str, Alignment, BorderFill, BorderLine, BorderLineType, CenterLine, CharShape,
    DiagonalLine, FillType, Font, HeadType, LineSpacingType, Numbering, ParaShape, Style,
    SubstFont, TabDef,
};
use crate::model::ColorRef;

use super::canonical_defaults::FONTFACE_LANG_NAMES;
use super::context::SerializeContext;
use super::utils::{empty_tag, end_tag, start_tag_attrs, text, write_xml_decl, BoundedXmlBuffer};
use super::SerializeError;

/// `header.xml` 바이트 생성. Stage 1 진입점.
pub fn write_header(doc: &Document, ctx: &SerializeContext) -> Result<Vec<u8>, SerializeError> {
    write_header_limited(doc, ctx, usize::MAX)
}

pub(crate) fn write_header_limited(
    doc: &Document,
    ctx: &SerializeContext,
    max_bytes: usize,
) -> Result<Vec<u8>, SerializeError> {
    let mut w = Writer::new(BoundedXmlBuffer::new(max_bytes));
    write_xml_decl(&mut w)?;

    // <hh:head> 루트 + 전체 네임스페이스 (parser가 기대하는 접두어 모두 선언)
    // secCnt 는 실제 직렬화하는 섹션 파일 수(`doc.sections`)와 일치해야 한다 (#1557).
    // doc_properties.section_count 는 파서가 갱신하지 않아 stale(1)일 수 있어, 그대로
    // 쓰면 secCnt < 실제 섹션 수가 되어 한글이 뒤 구역을 로드하지 않고 페이지가 붕괴한다.
    let sec_cnt = doc.sections.len().max(1).to_string();
    // 원본 보존값(문서별 상이, 1.2~1.5)을 그대로 재방출한다. 한글은 HwpUnitChar 단위
    // 해석을 version.xml 의 xmlVersion 으로만 결정하므로(header-1-5-only 프로브),
    // hh:head version 은 올리지 않는다. 없을 때만 version.xml 기본값과 맞춘다.
    let hwpml_version = doc
        .doc_info
        .hwpml_version
        .as_deref()
        .unwrap_or(super::version_metadata::MIN_XML_VERSION);
    start_tag_attrs(
        &mut w,
        "hh:head",
        &[
            ("xmlns:ha", "http://www.hancom.co.kr/hwpml/2011/app"),
            ("xmlns:hp", "http://www.hancom.co.kr/hwpml/2011/paragraph"),
            ("xmlns:hp10", "http://www.hancom.co.kr/hwpml/2016/paragraph"),
            ("xmlns:hs", "http://www.hancom.co.kr/hwpml/2011/section"),
            ("xmlns:hc", "http://www.hancom.co.kr/hwpml/2011/core"),
            ("xmlns:hh", "http://www.hancom.co.kr/hwpml/2011/head"),
            ("xmlns:hhs", "http://www.hancom.co.kr/hwpml/2011/history"),
            ("xmlns:hm", "http://www.hancom.co.kr/hwpml/2011/master-page"),
            ("xmlns:dc", "http://purl.org/dc/elements/1.1/"),
            ("xmlns:opf", "http://www.idpf.org/2007/opf/"),
            ("xmlns:epub", "http://www.idpf.org/2007/ops"),
            (
                "xmlns:ooxmlchart",
                "http://www.hancom.co.kr/hwpml/2016/ooxmlchart",
            ),
            (
                "xmlns:hwpunitchar",
                "http://www.hancom.co.kr/hwpml/2016/HwpUnitChar",
            ),
            ("xmlns:hpf", "http://www.hancom.co.kr/schema/2011/hpf"),
            (
                "xmlns:config",
                "urn:oasis:names:tc:opendocument:xmlns:config:1.0",
            ),
            ("version", hwpml_version),
            ("secCnt", &sec_cnt),
        ],
    )?;

    write_begin_num(&mut w, &doc.doc_properties)?;

    // <hh:refList>: 모든 리소스 테이블을 감싸는 컨테이너
    super::utils::start_tag(&mut w, "hh:refList")?;
    write_fontfaces(&mut w, &doc.doc_info, ctx)?;
    write_border_fills(&mut w, &doc.doc_info, ctx)?;
    write_char_properties(&mut w, &doc.doc_info, ctx)?;
    write_tab_properties(&mut w, &doc.doc_info)?;
    write_numberings(&mut w, &doc.doc_info)?;
    write_bullets(&mut w, &doc.doc_info)?;
    write_para_properties(&mut w, &doc.doc_info, ctx)?;
    write_styles(&mut w, &doc.doc_info, ctx)?;
    // memoProperties(메모 모양 정의: 테두리/색상)는 refList 마지막 자식으로,
    // parse_memo_shape가 만드는 extra_records(HWPTAG_MEMO_SHAPE, hwpx→hwp5
    // 변환 전용)는 여기서 쓰이지 않는다. 원본 verbatim splice로 hwpx→hwpx
    // 라운드트립 시 memoPr 소실을 막는다(#3xxx).
    if let Some(memo_properties) = &doc.doc_info.memo_properties_xml {
        w.get_mut()
            .write_all(memo_properties.as_bytes())
            .map_err(|e| SerializeError::XmlError(format!("memoProperties splice: {e}")))?;
    }
    end_tag(&mut w, "hh:refList")?;

    // 문서 설정 tail: 원본 HWPX 가 있으면 그대로 splice(compatibleDocument/
    // docOption/trackchageConfig 무손실 보존), 없으면 하드코딩 폴백.
    match &doc.doc_info.hwpx_head_tail {
        Some(tail) => {
            w.get_mut()
                .write_all(tail.as_bytes())
                .map_err(|e| SerializeError::XmlError(format!("head tail splice: {e}")))?;
        }
        None => {
            write_compatible_document(&mut w, &doc.doc_info)?;
            write_doc_option(&mut w)?;
            write_track_change_config(&mut w)?;
        }
    }

    end_tag(&mut w, "hh:head")?;
    Ok(w.into_inner().into_inner())
}

// =====================================================================
// <hh:beginNum>
// =====================================================================
fn write_begin_num<W: Write>(
    w: &mut Writer<W>,
    props: &DocProperties,
) -> Result<(), SerializeError> {
    empty_tag(
        w,
        "hh:beginNum",
        &[
            ("page", &props.page_start_num.max(1).to_string()),
            ("footnote", &props.footnote_start_num.max(1).to_string()),
            ("endnote", &props.endnote_start_num.max(1).to_string()),
            ("pic", &props.picture_start_num.max(1).to_string()),
            ("tbl", &props.table_start_num.max(1).to_string()),
            ("equation", &props.equation_start_num.max(1).to_string()),
        ],
    )
}

// =====================================================================
// <hh:fontfaces> — 7 언어 그룹
// =====================================================================
fn write_fontfaces<W: Write>(
    w: &mut Writer<W>,
    doc_info: &DocInfo,
    ctx: &SerializeContext,
) -> Result<(), SerializeError> {
    // IR의 font_faces는 항상 7개 언어 그룹을 유지한다고 기대하나,
    // 비어있거나 크기가 다를 수 있으므로 안전하게 처리.
    let groups: Vec<&Vec<Font>> = (0..7)
        .map(|i| doc_info.font_faces.get(i).unwrap_or(&EMPTY_FONT_VEC))
        .collect();

    let item_cnt = groups.iter().filter(|g| !g.is_empty()).count();
    if item_cnt == 0 {
        return Ok(());
    }

    start_tag_attrs(
        w,
        "hh:fontfaces",
        &[(
            "itemCnt",
            &groups.iter().filter(|g| !g.is_empty()).count().to_string(),
        )],
    )?;
    for (lang_idx, fonts) in groups.iter().enumerate() {
        if fonts.is_empty() {
            continue;
        }
        let lang = FONTFACE_LANG_NAMES[lang_idx];
        start_tag_attrs(
            w,
            "hh:fontface",
            &[("lang", lang), ("fontCnt", &fonts.len().to_string())],
        )?;
        for (id, font) in fonts.iter().enumerate() {
            let id_str = id.to_string();
            let binary_item_id_ref = resolve_font_binary_item_id_ref(
                ctx,
                font.resolved_bin_data_id,
                &font.bin_item_id_ref,
                &font.name,
            )?;
            let mut font_attrs = vec![
                ("id", id_str.as_str()),
                ("face", font.name.as_str()),
                ("type", font_type_str(font.alt_type)),
                ("isEmbedded", if font.is_embedded { "1" } else { "0" }),
            ];
            if !binary_item_id_ref.is_empty() {
                font_attrs.push(("binaryItemIDRef", binary_item_id_ref.as_str()));
            }
            // substFont(대체 글꼴)·typeInfo(파나포스 10바이트)가 IR에 있으면
            // 자식으로 복원한다. 원본 순서는 substFont → typeInfo. 둘 다 없으면
            // 종전대로 self-closing.
            if font.subst_font.is_some() || font.type_info.is_some() {
                start_tag_attrs(w, "hh:font", font_attrs.as_slice())?;
                if let Some(sf) = &font.subst_font {
                    write_subst_font(w, sf, ctx)?;
                }
                if let Some(ti) = &font.type_info {
                    write_font_type_info(w, ti)?;
                }
                end_tag(w, "hh:font")?;
            } else {
                empty_tag(w, "hh:font", font_attrs.as_slice())?;
            }
        }
        end_tag(w, "hh:fontface")?;
    }
    end_tag(w, "hh:fontfaces")?;
    Ok(())
}

static EMPTY_FONT_VEC: Vec<Font> = Vec::new();

fn resolve_font_binary_item_id_ref(
    ctx: &SerializeContext,
    resolved_bin_data_id: Option<u16>,
    original_ref: &str,
    font_name: &str,
) -> Result<String, SerializeError> {
    match resolved_bin_data_id {
        Some(bin_data_id) => ctx
            .resolve_bin_id(bin_data_id)
            .map(str::to_string)
            .ok_or_else(|| {
                SerializeError::XmlError(format!(
                    "embedded font `{font_name}` references missing BinData id {bin_data_id}"
                ))
            }),
        None => Ok(original_ref.to_string()),
    }
}

fn font_type_str(alt_type: u8) -> &'static str {
    match alt_type {
        1 => "TTF",
        2 => "HFT",
        _ => "TTF", // 기본: TTF (한컴 샘플 관찰값)
    }
}

/// `parse_font_type_info` 의 역함수.
///
/// IR 의 `type_info` 10바이트 배열을 `<hh:typeInfo>` 엘리먼트로 복원한다.
/// 바이트 배치(파서와 동일): [0]=familyType, [1]=serifType(합성값, XML 미노출),
/// [2]=weight, [3]=proportion, [4]=contrast, [5]=strokeVariation,
/// [6]=armStyle, [7]=letterform, [8]=midline, [9]=xHeight.
/// `[1]` 은 파서가 글꼴 이름/유형에서 합성하므로 재파싱 시 동일하게 재생성된다 —
/// 따라서 직렬화하지 않아도 라운드트립이 정확하다.
fn write_font_type_info<W: Write>(w: &mut Writer<W>, ti: &[u8; 10]) -> Result<(), SerializeError> {
    let weight = ti[2].to_string();
    let proportion = ti[3].to_string();
    let contrast = ti[4].to_string();
    let stroke_variation = ti[5].to_string();
    let arm_style = ti[6].to_string();
    let letterform = ti[7].to_string();
    let midline = ti[8].to_string();
    let x_height = ti[9].to_string();
    empty_tag(
        w,
        "hh:typeInfo",
        &[
            ("familyType", font_family_type_str(ti[0])),
            ("weight", &weight),
            ("proportion", &proportion),
            ("contrast", &contrast),
            ("strokeVariation", &stroke_variation),
            ("armStyle", &arm_style),
            ("letterform", &letterform),
            ("midline", &midline),
            ("xHeight", &x_height),
        ],
    )
}

/// `parse_subst_font` 의 역함수. 4개 속성을 원본 순서(face·type·isEmbedded·
/// binaryItemIDRef)로 복원한다. `binaryItemIDRef` 는 비임베드 시에도 빈 문자열로
/// 항상 출력한다(한컴 원본과 동일).
fn write_subst_font<W: Write>(
    w: &mut Writer<W>,
    sf: &SubstFont,
    ctx: &SerializeContext,
) -> Result<(), SerializeError> {
    let binary_item_id_ref = resolve_font_binary_item_id_ref(
        ctx,
        sf.resolved_bin_data_id,
        &sf.bin_item_id_ref,
        &sf.face,
    )?;
    empty_tag(
        w,
        "hh:substFont",
        &[
            ("face", &sf.face),
            ("type", font_type_str(sf.font_type)),
            ("isEmbedded", if sf.is_embedded { "1" } else { "0" }),
            ("binaryItemIDRef", binary_item_id_ref.as_str()),
        ],
    )
}

/// `parser::hwpx::header::font_family_type_to_u8` 의 역함수. 0/미상은 OWPML
/// 표준값 `FCAT_UNKNOWN` 으로 복원한다.
fn font_family_type_str(v: u8) -> &'static str {
    match v {
        1 => "FCAT_MYUNGJO",
        2 => "FCAT_GOTHIC",
        3 => "FCAT_SSERIF",
        4 => "FCAT_BRUSHSCRIPT",
        5 => "FCAT_DECORATIVE",
        6 => "FCAT_NONRECTMJ",
        7 => "FCAT_NONRECTGT",
        _ => "FCAT_UNKNOWN",
    }
}

// =====================================================================
// <hh:borderFills>
// =====================================================================
fn write_border_fills<W: Write>(
    w: &mut Writer<W>,
    doc_info: &DocInfo,
    ctx: &SerializeContext,
) -> Result<(), SerializeError> {
    if doc_info.border_fills.is_empty() {
        return Ok(());
    }
    start_tag_attrs(
        w,
        "hh:borderFills",
        &[("itemCnt", &doc_info.border_fills.len().to_string())],
    )?;
    // HWPX borderFill의 id는 1부터 시작 (관찰값: ref_empty.hwpx).
    // 그러나 rhwp parser는 인덱스 기반으로 저장하므로 id는 배열 인덱스 그대로 사용.
    for (idx, bf) in doc_info.border_fills.iter().enumerate() {
        write_border_fill(w, idx as u16, bf, ctx)?;
    }
    end_tag(w, "hh:borderFills")?;
    Ok(())
}

fn write_border_fill<W: Write>(
    w: &mut Writer<W>,
    id: u16,
    bf: &BorderFill,
    ctx: &SerializeContext,
) -> Result<(), SerializeError> {
    let attr = effective_border_fill_attr(bf);
    // [#2965] 표 24 bit0=3D 효과, bit1=그림자 효과 — 파서가 attr 에 보존하는
    // 실값을 read_border_fill 이 되돌리지 않고 상수로 방출하던 결함 수정.
    let three_d = bool01(attr & 1 != 0);
    let shadow = bool01(attr & (1 << 1) != 0);

    // 속성 순서 (BorderFillType.cpp:64-68): id, threeD, shadow, centerLine, breakCellSeparateLine
    start_tag_attrs(
        w,
        "hh:borderFill",
        &[
            ("id", &(id + 1).to_string()), // HWPX 관찰: id는 1-based
            ("threeD", three_d),
            ("shadow", shadow),
            ("centerLine", center_line_type(bf)),
            ("breakCellSeparateLine", "0"),
        ],
    )?;

    // 자식 순서 (BorderFillType.cpp:51-58):
    // slash, backSlash, leftBorder, rightBorder, topBorder, bottomBorder, diagonal, fillBrush
    write_diag_line(
        w,
        "hh:slash",
        diagonal_shape_type(((attr >> 2) & 0x07) as u8),
        (attr >> 8) & 0x03,
        attr & (1 << 11) != 0,
    )?;
    write_diag_line(
        w,
        "hh:backSlash",
        diagonal_shape_type(((attr >> 5) & 0x07) as u8),
        (attr >> 10) & 0x01,
        attr & (1 << 12) != 0,
    )?;
    write_border_line(w, "hh:leftBorder", &bf.borders[0])?;
    write_border_line(w, "hh:rightBorder", &bf.borders[1])?;
    write_border_line(w, "hh:topBorder", &bf.borders[2])?;
    write_border_line(w, "hh:bottomBorder", &bf.borders[3])?;
    write_diagonal(w, &bf.diagonal)?;

    // fillBrush: 도형과 동일한 fillBrush 구조를 공유한다.
    // 종전 Stage 1 은 빈 래퍼만 출력해 winBrush(배경색)/gradation/imgBrush 를
    // 전부 잃었다. 파서가 채운 Fill 을 shape 의 검증된 역매핑으로 직렬화한다.
    super::shape::write_fill_brush(w, &bf.fill, ctx)?;

    end_tag(w, "hh:borderFill")?;
    Ok(())
}

fn write_diag_line<W: Write>(
    w: &mut Writer<W>,
    name: &str,
    type_str: &str,
    crooked: u16,
    is_counter: bool,
) -> Result<(), SerializeError> {
    let crooked = crooked.to_string();
    let is_counter = if is_counter { "1" } else { "0" };
    empty_tag(
        w,
        name,
        &[
            ("type", type_str),
            ("Crooked", crooked.as_str()),
            ("isCounter", is_counter),
        ],
    )
}

// [#2947] parser 측 parse_numbering_format_code() (표 43) 의 역매핑.
fn numbering_format_str(code: u8) -> &'static str {
    match code {
        1 => "CIRCLED_DIGIT",
        2 => "ROMAN_CAPITAL",
        3 => "ROMAN_SMALL",
        4 => "LATIN_CAPITAL",
        5 => "LATIN_SMALL",
        8 => "HANGUL_SYLLABLE",
        12 => "HANGUL_NUMBER",
        13 => "HANJA_NUMBER",
        _ => "DIGIT",
    }
}

fn diagonal_shape_type(code: u8) -> &'static str {
    match code & 0x07 {
        0 => "NONE",
        0b010 => "CENTER",
        0b011 => "CENTER_BELOW",
        0b110 => "CENTER_ABOVE",
        _ => "ALL",
    }
}

fn center_line_type(bf: &BorderFill) -> &'static str {
    effective_center_line(bf).as_hwpx()
}

fn effective_center_line(bf: &BorderFill) -> CenterLine {
    if bf.center_line != CenterLine::None {
        bf.center_line
    } else {
        CenterLine::from_hwp_attr(bf.attr)
    }
}

fn effective_border_fill_attr(bf: &BorderFill) -> u16 {
    let center_line = effective_center_line(bf);
    if center_line == CenterLine::None {
        return bf.attr;
    }

    let mut attr = bf.attr;
    attr &=
        !((0x07 << 2) | (0x07 << 5) | (0x03 << 8) | (1 << 10) | (1 << 11) | (1 << 12) | (1 << 13));
    attr | center_line.hwp_attr_bits()
}

fn write_border_line<W: Write>(
    w: &mut Writer<W>,
    name: &str,
    line: &BorderLine,
) -> Result<(), SerializeError> {
    let type_str = border_line_type_str(line.line_type);
    let width_mm = format!("{} mm", border_width_mm(line.width));
    let color = color_hex(line.color);
    empty_tag(
        w,
        name,
        &[("type", type_str), ("width", &width_mm), ("color", &color)],
    )
}

fn write_diagonal<W: Write>(w: &mut Writer<W>, d: &DiagonalLine) -> Result<(), SerializeError> {
    // diagonal_type 코드 0 = 대각선 없음 → 엘리먼트 자체를 생략한다. 한컴 원본도
    // 대각선이 없으면 <hh:diagonal> 를 쓰지 않고, 렌더러도 diagonal_type==0 을
    // 미표시로 처리한다. 종전엔 width==0 으로 NONE 을 추론해 대각선 없는 borderFill
    // 마다 <hh:diagonal type="NONE"/> 을 과다 출력했고(원본에 없던 요소 추가),
    // 그 회피책으로 파서가 width 를 max(1) 로 띄워 0.1mm 대각선을 0.12mm 로 변질시켰다.
    // 이제 선 종류는 width 가 아니라 diagonal_type 코드에서 직접 복원한다.
    if d.diagonal_type == 0 {
        return Ok(());
    }
    let type_str = border_line_type_str(border_line_type_from_code(d.diagonal_type));
    let width_mm = format!("{} mm", border_width_mm(d.width));
    let color = color_hex(d.color);
    empty_tag(
        w,
        "hh:diagonal",
        &[("type", type_str), ("width", &width_mm), ("color", &color)],
    )
}

/// `parser::hwpx::header::parse_border_line_type_code` 의 역함수. 대각선 선 종류
/// 코드(u8)를 [`BorderLineType`] 으로 되돌려 `border_line_type_str` 로 문자열화한다.
fn border_line_type_from_code(code: u8) -> BorderLineType {
    use BorderLineType::*;
    match code {
        0 => None,
        1 => Solid,
        2 => Dash,
        3 => Dot,
        4 => DashDot,
        5 => DashDotDot,
        6 => LongDash,
        7 => Circle,
        8 => Double,
        9 => ThinThickDouble,
        10 => ThickThinDouble,
        11 => ThinThickThinTriple,
        12 => Wave,
        13 => DoubleWave,
        14 => Thick3D,
        15 => Thick3DReverse,
        16 => Thin3D,
        17 => Thin3DReverse,
        _ => Solid,
    }
}

fn border_line_type_str(t: BorderLineType) -> &'static str {
    use BorderLineType::*;
    match t {
        None => "NONE",
        Solid => "SOLID",
        Dash => "DOT",
        Dot => "DASH",
        DashDot => "DASH_DOT",
        DashDotDot => "DASH_DOT_DOT",
        LongDash => "LONG_DASH",
        Circle => "CIRCLE",
        Double => "DOUBLE_SLIM",
        ThinThickDouble => "SLIM_THICK",
        ThickThinDouble => "THICK_SLIM",
        ThinThickThinTriple => "SLIM_THICK_SLIM",
        Wave => "WAVE",
        DoubleWave => "DOUBLEWAVE",
        Thick3D => "THICK3D",
        Thick3DReverse => "THICKREV3D",
        Thin3D => "3D",
        Thin3DReverse => "REV3D",
    }
}

fn border_width_mm(w: u8) -> &'static str {
    // 파서 parse_border_width 와 동일한 한컴 표준 16단계 테이블을 공유한다.
    border_width_mm_str(w)
}

fn color_hex(c: ColorRef) -> String {
    // ColorRef = u32. HWP 내부 저장: 상위 바이트가 비투명 플래그(0이면 유효 색상).
    // 0xFFFFFFFF = 투명/없음 센티넬 → "none"
    if c == 0xFFFFFFFF {
        return "none".to_string();
    }
    // HWPX는 "#RRGGBB" 또는 "#AARRGGBB".
    let a = ((c >> 24) & 0xFF) as u8;
    let r = (c & 0xFF) as u8;
    let g = ((c >> 8) & 0xFF) as u8;
    let b = ((c >> 16) & 0xFF) as u8;
    if a == 0 {
        format!("#{:02X}{:02X}{:02X}", r, g, b)
    } else {
        format!("#{:02X}{:02X}{:02X}{:02X}", a, r, g, b)
    }
}

// =====================================================================
// <hh:charProperties>
// =====================================================================
fn write_char_properties<W: Write>(
    w: &mut Writer<W>,
    doc_info: &DocInfo,
    ctx: &SerializeContext,
) -> Result<(), SerializeError> {
    let _ = ctx;
    if doc_info.char_shapes.is_empty() {
        return Ok(());
    }
    start_tag_attrs(
        w,
        "hh:charProperties",
        &[("itemCnt", &doc_info.char_shapes.len().to_string())],
    )?;
    for (idx, cs) in doc_info.char_shapes.iter().enumerate() {
        write_char_pr(w, idx as u32, cs)?;
    }
    end_tag(w, "hh:charProperties")?;
    Ok(())
}

fn write_char_pr<W: Write>(
    w: &mut Writer<W>,
    id: u32,
    cs: &CharShape,
) -> Result<(), SerializeError> {
    // 속성 순서 (CharShapeType.cpp:79-86): id, height, textColor, shadeColor,
    // useFontSpace, useKerning, symMark, borderFillIDRef
    let shade = if cs.shade_color == 0 {
        "none".to_string()
    } else {
        color_hex(cs.shade_color)
    };
    start_tag_attrs(
        w,
        "hh:charPr",
        &[
            ("id", &id.to_string()),
            ("height", &cs.base_size.to_string()),
            ("textColor", &color_hex(cs.text_color)),
            ("shadeColor", &shade),
            ("useFontSpace", bool01(cs.use_font_space)),
            ("useKerning", bool01(cs.kerning)),
            ("symMark", sym_mark_str(cs.emphasis_dot)),
            ("borderFillIDRef", &cs.border_fill_id.to_string()),
        ],
    )?;

    // 자식 순서 (CharShapeType.cpp:59-73):
    // fontRef, ratio, spacing, relSz, offset, italic, bold, underline, strikeout, outline,
    // shadow, emboss, engrave, supscript, subscript
    write_lang_attrs(w, "hh:fontRef", &cs.font_ids.map(|v| v as i32))?;
    write_lang_attrs(w, "hh:ratio", &cs.ratios.map(|v| v as i32))?;
    write_lang_attrs(w, "hh:spacing", &cs.spacings.map(|v| v as i32))?;
    write_lang_attrs(w, "hh:relSz", &cs.relative_sizes.map(|v| v as i32))?;
    write_lang_attrs(w, "hh:offset", &cs.char_offsets.map(|v| v as i32))?;
    if cs.italic {
        empty_tag(w, "hh:italic", &[])?;
    }
    if cs.bold {
        empty_tag(w, "hh:bold", &[])?;
    }
    // underline/strikeout/outline/shadow: 한컴은 비활성(NONE)이어도 항상 출력한다.
    // 모델은 파서가 NONE 일 때도 shape/color/offset 을 보존하므로(역매핑 가능),
    // 무조건 출력해 원본과 동일한 구조를 만든다.
    empty_tag(
        w,
        "hh:underline",
        &[
            ("type", underline_type_str(cs.underline_type)),
            ("shape", line_shape_str(cs.underline_shape)),
            ("color", &color_hex(cs.underline_color)),
        ],
    )?;
    // strikeout: 파서가 shape 값으로 strikethrough 여부를 결정하므로(is_real_strike_shape),
    // 비활성 raw 15의 3D는 한컴의 비활성 표기다. 정확한 원시 값은 보조 엔트리에 저장한다.
    empty_tag(
        w,
        "hh:strikeout",
        &[
            (
                "shape",
                if cs.strikethrough {
                    line_shape_str(cs.strike_shape)
                } else if cs.strike_shape == 15 {
                    "3D"
                } else {
                    "NONE"
                },
            ),
            ("color", &color_hex(cs.strike_color)),
        ],
    )?;
    empty_tag(
        w,
        "hh:outline",
        &[("type", outline_type_str(cs.outline_type))],
    )?;
    empty_tag(
        w,
        "hh:shadow",
        &[
            ("type", shadow_type_str(cs.shadow_type)),
            ("color", &color_hex(cs.shadow_color)),
            ("offsetX", &cs.shadow_offset_x.to_string()),
            ("offsetY", &cs.shadow_offset_y.to_string()),
        ],
    )?;
    if cs.emboss {
        empty_tag(w, "hh:emboss", &[])?;
    }
    if cs.engrave {
        empty_tag(w, "hh:engrave", &[])?;
    }
    if cs.superscript {
        empty_tag(w, "hh:supscript", &[])?;
    }
    if cs.subscript {
        empty_tag(w, "hh:subscript", &[])?;
    }

    end_tag(w, "hh:charPr")?;
    Ok(())
}

fn write_lang_attrs<W: Write>(
    w: &mut Writer<W>,
    name: &str,
    vals: &[i32; 7],
) -> Result<(), SerializeError> {
    let s0 = vals[0].to_string();
    let s1 = vals[1].to_string();
    let s2 = vals[2].to_string();
    let s3 = vals[3].to_string();
    let s4 = vals[4].to_string();
    let s5 = vals[5].to_string();
    let s6 = vals[6].to_string();
    empty_tag(
        w,
        name,
        &[
            ("hangul", &s0),
            ("latin", &s1),
            ("hanja", &s2),
            ("japanese", &s3),
            ("other", &s4),
            ("symbol", &s5),
            ("user", &s6),
        ],
    )
}

fn bool01(b: bool) -> &'static str {
    if b {
        "1"
    } else {
        "0"
    }
}

fn sym_mark_str(em: u8) -> &'static str {
    match em {
        0 => "NONE",
        1 => "DOT_ABOVE",
        2 => "RING_ABOVE",
        3 => "TILDE",
        4 => "CARON",
        5 => "SIDE",
        6 => "COLON",
        _ => "NONE",
    }
}

fn underline_type_str(t: crate::model::style::UnderlineType) -> &'static str {
    use crate::model::style::UnderlineType::*;
    match t {
        None => "NONE",
        Bottom => "BOTTOM",
        Top => "TOP",
    }
}

fn line_shape_str(s: u8) -> &'static str {
    match s {
        0 => "SOLID",
        1 => "DASH",
        2 => "DOT",
        3 => "DASH_DOT",
        4 => "DASH_DOT_DOT",
        5 => "LONG_DASH",
        6 => "CIRCLE",
        7 => "DOUBLE_SLIM",
        8 => "SLIM_THICK",
        9 => "THICK_SLIM",
        10 => "SLIM_THICK_SLIM",
        11 => "WAVE",
        12 => "DOUBLE_WAVE",
        _ => "SOLID",
    }
}

// [#2695] 외곽선 8종. IR outline_type 은 HWP5 attr bits 8-10(3비트)을 그대로 담으므로
// 0~7 전부를 방출해야 한다. 4~7 을 NONE 으로 떨구면 외곽선이 소멸한다.
fn outline_type_str(t: u8) -> &'static str {
    match t {
        0 => "NONE",
        1 => "SOLID",
        2 => "DASH",
        3 => "DOT",
        4 => "DASH_DOT",
        5 => "DASH_DOT_DOT",
        6 => "LONG_DASH",
        7 => "CIRCLE",
        _ => "NONE",
    }
}

// [#2695] 그림자 3종. IR shadow_type 은 HWP5 attr bits 11-12(2비트).
// 1=비연속(DROP), 2=연속(CONTINUOUS). 3은 예약값(미정의).
// [#3038] 종전엔 예약값 3이 `_ => "CONTINUOUS"`로 떨어져 그림자 없음이 그림자
// 있음으로 둔갑했다. 계약(0~2) 밖의 값은 안전한 기본값(NONE)으로 방출한다.
fn shadow_type_str(t: u8) -> &'static str {
    match t {
        0 => "NONE",
        1 => "DROP",
        2 => "CONTINUOUS",
        _ => "NONE",
    }
}

// =====================================================================
// <hh:tabProperties>
// =====================================================================
fn write_tab_properties<W: Write>(
    w: &mut Writer<W>,
    doc_info: &DocInfo,
) -> Result<(), SerializeError> {
    if doc_info.tab_defs.is_empty() {
        return Ok(());
    }
    start_tag_attrs(
        w,
        "hh:tabProperties",
        &[("itemCnt", &doc_info.tab_defs.len().to_string())],
    )?;
    for (idx, td) in doc_info.tab_defs.iter().enumerate() {
        write_tab_pr(w, idx as u16, td)?;
    }
    end_tag(w, "hh:tabProperties")?;
    Ok(())
}

fn write_tab_pr<W: Write>(w: &mut Writer<W>, id: u16, td: &TabDef) -> Result<(), SerializeError> {
    let attrs = [
        ("id", id.to_string()),
        ("autoTabLeft", bool01(td.auto_tab_left).to_string()),
        ("autoTabRight", bool01(td.auto_tab_right).to_string()),
    ];
    let attrs_ref: Vec<(&str, &str)> = attrs.iter().map(|(k, v)| (*k, v.as_str())).collect();

    if td.tabs.is_empty() {
        empty_tag(w, "hh:tabPr", &attrs_ref)?;
    } else {
        start_tag_attrs(w, "hh:tabPr", &attrs_ref)?;
        // IR 탭 위치는 2배 단위다. 홀수 위치의 네이티브 표기는 미확정이므로
        // 그런 항목이 하나라도 있으면 정의 전체의 기존 직접 표기를 유지한다.
        let hwpunitchar = td.tabs.iter().all(|tab| tab.position % 2 == 0);
        for tab in &td.tabs {
            if hwpunitchar {
                super::utils::start_tag(w, "hp:switch")?;
                start_tag_attrs(
                    w,
                    "hp:case",
                    &[(
                        "hp:required-namespace",
                        "http://www.hancom.co.kr/hwpml/2016/HwpUnitChar",
                    )],
                )?;
                empty_tag(
                    w,
                    "hh:tabItem",
                    &[
                        ("pos", &(tab.position / 2).to_string()),
                        ("type", tab_type_str(tab.tab_type)),
                        ("leader", tab_leader_str(tab.fill_type)),
                        ("unit", "HWPUNIT"),
                    ],
                )?;
                end_tag(w, "hp:case")?;
                super::utils::start_tag(w, "hp:default")?;
            }
            empty_tag(
                w,
                "hh:tabItem",
                &[
                    ("pos", &tab.position.to_string()),
                    ("type", tab_type_str(tab.tab_type)),
                    ("leader", tab_leader_str(tab.fill_type)),
                ],
            )?;
            if hwpunitchar {
                end_tag(w, "hp:default")?;
                end_tag(w, "hp:switch")?;
            }
        }
        end_tag(w, "hh:tabPr")?;
    }
    Ok(())
}

fn tab_type_str(t: u8) -> &'static str {
    match t {
        0 => "LEFT",
        1 => "RIGHT",
        2 => "CENTER",
        3 => "DECIMAL",
        _ => "LEFT",
    }
}

fn tab_leader_str(f: u8) -> &'static str {
    match f {
        0 => "NONE",
        1 => "SOLID",
        2 => "DOT",
        3 => "DASH",
        4 => "DASH_DOT",
        5 => "DASH_DOT_DOT",
        6 => "LONG_DASH",
        7 => "CIRCLE",
        8 => "DOUBLE_SLIM",
        // OWPML LineType3 스펙 리터럴(Core XML schema.xml 335~349행)로 방출한다.
        // 종전엔 THIN_THICK/THICK_THIN/TRIM 이라는 비표준 이름을 썼는데, rhwp
        // 자기 자신은 다시 읽을 수 있어도(파서가 두 이름을 모두 허용) 한/글 등
        // 스펙을 따르는 다른 구현체에는 정의되지 않은 값이라 상호운용에 문제가
        // 있었다(#2857). 파서는 하위호환을 위해 옛 이름도 계속 받는다.
        9 => "SLIM_THICK",
        10 => "THICK_SLIM",
        11 => "SLIM_THICK_SLIM",
        _ => "NONE",
    }
}

// =====================================================================
// <hh:numberings>
// =====================================================================
fn write_numberings<W: Write>(w: &mut Writer<W>, doc_info: &DocInfo) -> Result<(), SerializeError> {
    if doc_info.numberings.is_empty() {
        return Ok(());
    }
    start_tag_attrs(
        w,
        "hh:numberings",
        &[("itemCnt", &doc_info.numberings.len().to_string())],
    )?;
    for (idx, n) in doc_info.numberings.iter().enumerate() {
        write_numbering(w, idx as u16, n)?;
    }
    end_tag(w, "hh:numberings")?;
    Ok(())
}

fn write_numbering<W: Write>(
    w: &mut Writer<W>,
    id: u16,
    n: &Numbering,
) -> Result<(), SerializeError> {
    start_tag_attrs(
        w,
        "hh:numbering",
        &[
            ("id", &(id + 1).to_string()), // 관찰: 1-based
            ("start", &n.start_number.to_string()),
        ],
    )?;
    // 원본 HWPX paraHead 영역이 있으면 그대로 splice(10수준 + align/
    // useInstWidth/autoIndent/checkable/형식문자열 무손실 복원). 모델의 7수준
    // NumberingHead 로는 표현 못하는 정보를 보존한다. 없으면(HWP5 경로 등)
    // 아래 하드코딩 뼈대로 폴백.
    if let Some(raw) = &n.raw_para_heads {
        w.get_mut()
            .write_all(raw.as_bytes())
            .map_err(|e| SerializeError::XmlError(format!("numbering paraHead splice: {e}")))?;
        end_tag(w, "hh:numbering")?;
        return Ok(());
    }
    // Stage 1: 10 레벨 paraHead 뼈대 출력. 실제 값은 NumberingHead 참조해 생성.
    for level in 0..10usize {
        let idx = level.min(6);
        let h = &n.heads[idx];
        let start = n.level_start_numbers.get(idx).copied().unwrap_or(1);
        let level_s = (level + 1).to_string();
        let start_s = start.to_string();
        let wa = h.width_adjust.to_string();
        // [#2947] h.number_format 을 무시하고 "DIGIT" 로 고정 방출하면 HWP5 경유
        // 저장 시 로마자/한글/원문자 등 문단 번호 형식이 전부 아라비아 숫자로 뒤바뀐다.
        let num_format = numbering_format_str(h.number_format);
        let text_offset_s = h.text_distance.to_string();
        let char_pr_id_ref_s = h.char_shape_id.to_string();
        start_tag_attrs(
            w,
            "hh:paraHead",
            &[
                ("start", &start_s),
                ("level", &level_s),
                ("align", "LEFT"),
                ("useInstWidth", "1"),
                ("autoIndent", "1"),
                ("widthAdjust", &wa),
                ("textOffsetType", "PERCENT"),
                ("textOffset", &text_offset_s),
                ("numFormat", num_format),
                ("charPrIDRef", &char_pr_id_ref_s),
                ("checkable", "0"),
            ],
        )?;
        // HWP의 실제 7수준 형식만 보존한다. 추가 XML 수준에 7수준 형식을 복제하지 않는다.
        if let Some(format) = n.level_formats.get(level) {
            text(w, format)?;
        }
        end_tag(w, "hh:paraHead")?;
    }
    end_tag(w, "hh:numbering")?;
    Ok(())
}

// =====================================================================
// <hh:bullets> — 글머리표 정의
//
// 종전 직렬화는 bullets 를 전혀 쓰지 않아 라운드트립에서 글머리표 정의(❏/※/❍ 등)가
// 소실되고, 글머리표 문단의 마커 글리프가 렌더에서 사라졌다. 파서(parse_bullet_hwpx)는
// `char`/`useImage` 만 읽으므로 그 둘 + paraHead 뼈대를 방출하면 round-trip 무손실이다.
// =====================================================================
fn write_bullets<W: Write>(w: &mut Writer<W>, doc_info: &DocInfo) -> Result<(), SerializeError> {
    if doc_info.bullets.is_empty() {
        return Ok(());
    }
    start_tag_attrs(
        w,
        "hh:bullets",
        &[("itemCnt", &doc_info.bullets.len().to_string())],
    )?;
    for (idx, b) in doc_info.bullets.iter().enumerate() {
        write_bullet(w, idx as u16, b)?;
    }
    end_tag(w, "hh:bullets")?;
    Ok(())
}

fn write_bullet<W: Write>(
    w: &mut Writer<W>,
    id: u16,
    b: &crate::model::style::Bullet,
) -> Result<(), SerializeError> {
    let id_s = (id + 1).to_string(); // 관찰: 1-based, ParaShape.numbering_id 참조와 정합
    let char_s = b.bullet_char.to_string();
    let use_image = if b.image_bullet > 0 { "1" } else { "0" };
    // [#3028] checkedChar(체크 글머리표 문자) — 값이 있을 때만 방출한다.
    let has_checked_char = b.check_bullet_char != '\0';
    let checked_char_s = b.check_bullet_char.to_string();
    let mut attrs: Vec<(&str, &str)> = vec![("id", &id_s), ("char", &char_s)];
    if has_checked_char {
        attrs.push(("checkedChar", &checked_char_s));
    }
    attrs.push(("useImage", use_image));
    start_tag_attrs(w, "hh:bullet", &attrs)?;
    // 원본 HWPX paraHead 구간이 있으면(=이 파일에서 파싱된 bullet) 그대로 splice 해
    // align/useInstWidth/autoIndent/textOffsetType/checkable 등 Bullet 필드로 표현
    // 못하는 속성까지 무손실 복원(numbering.raw_para_heads 와 동일 패턴, #2790).
    // 없으면(HWP5 경로 등) widthAdjust/textOffset/charPrIDRef 만 필드값으로 채운
    // 뼈대로 폴백 — checkable 은 checkedChar 유무를 따른다(#3028).
    if let Some(raw) = &b.raw_para_head {
        w.get_mut()
            .write_all(raw.as_bytes())
            .map_err(|e| SerializeError::XmlError(format!("bullet paraHead splice: {e}")))?;
    } else {
        empty_tag(
            w,
            "hh:paraHead",
            &[
                ("level", "0"),
                ("align", "LEFT"),
                ("useInstWidth", "0"),
                ("autoIndent", "1"),
                ("widthAdjust", &b.width_adjust.to_string()),
                ("textOffsetType", "PERCENT"),
                ("textOffset", &b.text_distance.to_string()),
                ("numFormat", "DIGIT"),
                ("charPrIDRef", &b.char_shape_id.to_string()),
                ("checkable", if has_checked_char { "1" } else { "0" }),
            ],
        )?;
    }
    end_tag(w, "hh:bullet")?;
    Ok(())
}

// =====================================================================
// <hh:paraProperties>
// =====================================================================
fn write_para_properties<W: Write>(
    w: &mut Writer<W>,
    doc_info: &DocInfo,
    ctx: &SerializeContext,
) -> Result<(), SerializeError> {
    let _ = ctx;
    if doc_info.para_shapes.is_empty() {
        return Ok(());
    }
    start_tag_attrs(
        w,
        "hh:paraProperties",
        &[("itemCnt", &doc_info.para_shapes.len().to_string())],
    )?;
    for (idx, ps) in doc_info.para_shapes.iter().enumerate() {
        write_para_pr(w, idx as u16, ps)?;
    }
    end_tag(w, "hh:paraProperties")?;
    Ok(())
}

fn write_para_pr<W: Write>(
    w: &mut Writer<W>,
    id: u16,
    ps: &ParaShape,
) -> Result<(), SerializeError> {
    // 속성 순서 (ParaShapeType.cpp:62-68): id, tabPrIDRef, condense,
    // fontLineHeight, snapToGrid, suppressLineNumbers, checked
    //
    // condense/fontLineHeight/snapToGrid 는 attr1 비트로 보존된다(파서 역매핑):
    //   snapToGrid = bit8, condense = bits9..15, fontLineHeight = bit22.
    // 종전엔 상수("0"/"0"/"1")로 하드코딩해 condense(20 등)와 snapToGrid(0)을 잃었다.
    let condense = ((ps.attr1 >> 9) & 0x7f).to_string();
    let font_line_height = ((ps.attr1 >> 22) & 1).to_string();
    let snap_to_grid = ((ps.attr1 >> 8) & 1).to_string();
    start_tag_attrs(
        w,
        "hh:paraPr",
        &[
            ("id", &id.to_string()),
            ("tabPrIDRef", &ps.tab_def_id.to_string()),
            ("condense", &condense),
            ("fontLineHeight", &font_line_height),
            ("snapToGrid", &snap_to_grid),
            ("suppressLineNumbers", "0"),
            ("checked", "0"),
        ],
    )?;

    // 자식 순서 (한컴 원본 관찰):
    // align, heading, breakSetting, autoSpacing, switch(margin+lineSpacing), border
    //
    // 종전엔 align@vertical, breakSetting@{breakNonLatinWord, widowOrphan,
    // keepWithNext, keepLines, pageBreakBefore} 를 상수로 하드코딩해, 파서가
    // attr1/attr2 비트로 보존한 값을 직렬화에서 모두 잃었다(예: vertical=CENTER →
    // BASELINE, breakNonLatinWord=BREAK_WORD → KEEP_WORD). 이제 보존 비트에서
    // 역매핑한다. breakLatinWord 는 원문 문자열을 보존한다.
    let vertical = vertical_alignment_str((ps.attr1 >> 20) & 0x03);
    // attr1 bit7: KEEP_WORD=1, BREAK_WORD=0 (parse_para_shape_child 와 정합).
    let break_non_latin = if (ps.attr1 >> 7) & 1 == 1 {
        "KEEP_WORD"
    } else {
        "BREAK_WORD"
    };
    // HWPX 원문을 보존하고, HWP5 등 원문이 없는 입력은 영어 단위 비트로 복원한다.
    let break_latin = ps
        .break_latin_word
        .as_deref()
        .unwrap_or(match (ps.attr1 >> 5) & 0x03 {
            1 => "HYPHENATION",
            2 => "BREAK_WORD",
            _ => "KEEP_WORD",
        });
    let line_wrap = match ps.attr2 & 0x03 {
        1 => "SQUEEZE",
        2 => "KEEP",
        _ => "BREAK",
    };
    // widowOrphan 은 HWP5 와 같은 attr1 bit 16 (attr2 bit 5 는 autoSpacing eAsianNum).
    let widow_orphan = ((ps.attr1 >> 16) & 1).to_string();
    let keep_with_next = ((ps.attr2 >> 6) & 1).to_string();
    let keep_lines = ((ps.attr2 >> 7) & 1).to_string();
    let page_break_before = ((ps.attr2 >> 8) & 1).to_string();
    empty_tag(
        w,
        "hh:align",
        &[
            ("horizontal", alignment_str(ps.alignment)),
            ("vertical", vertical),
        ],
    )?;
    empty_tag(
        w,
        "hh:heading",
        &[
            ("type", head_type_str(ps.head_type)),
            ("idRef", &ps.numbering_id.to_string()),
            ("level", &ps.para_level.to_string()),
        ],
    )?;
    empty_tag(
        w,
        "hh:breakSetting",
        &[
            ("breakLatinWord", break_latin),
            ("breakNonLatinWord", break_non_latin),
            ("widowOrphan", &widow_orphan),
            ("keepWithNext", &keep_with_next),
            ("keepLines", &keep_lines),
            ("pageBreakBefore", &page_break_before),
            ("lineWrap", line_wrap),
        ],
    )?;

    empty_tag(
        w,
        "hh:autoSpacing",
        &[
            (
                "eAsianEng",
                if (ps.attr2 >> 4) & 1 != 0 { "1" } else { "0" },
            ),
            (
                "eAsianNum",
                if (ps.attr2 >> 5) & 1 != 0 { "1" } else { "0" },
            ),
        ],
    )?;

    // margin + lineSpacing 은 한컴 원본과 동일하게 <hp:switch>(case/default)로 감싼다.
    write_para_margin_switch(w, ps)?;

    let border_connect = if (ps.attr1 >> 28) & 1 != 0 { "1" } else { "0" };
    let border_ignore_margin = if (ps.attr1 >> 29) & 1 != 0 { "1" } else { "0" };

    empty_tag(
        w,
        "hh:border",
        &[
            ("borderFillIDRef", &ps.border_fill_id.to_string()),
            ("offsetLeft", &ps.border_spacing[0].to_string()),
            ("offsetRight", &ps.border_spacing[1].to_string()),
            ("offsetTop", &ps.border_spacing[2].to_string()),
            ("offsetBottom", &ps.border_spacing[3].to_string()),
            ("connect", border_connect),
            ("ignoreMargin", border_ignore_margin),
        ],
    )?;

    end_tag(w, "hh:paraPr")?;
    Ok(())
}

/// paraPr 의 margin + lineSpacing 을 한컴 원본과 동일하게 `<hp:switch>` 구조로 쓴다.
///
/// `parse_para_shape_switch` 의 정확한 역. 파서는 HwpUnitChar `case` 값을 ×2 하여
/// IR 에 적재하므로(`stored = case × 2`, `unit="CHAR"` 이면 +1), 역으로:
///   - `default` 값 = IR 저장값 (`ps.indent` 등)
///   - `case`(HwpUnitChar) 값 = 저장값 / 2 (margin), 홀수면 `unit="CHAR"`
///     lineSpacing 은 PERCENT=저장값, 그 외(Fixed/SpaceOnly/Minimum)=저장값/2
fn write_para_margin_switch<W: Write>(
    w: &mut Writer<W>,
    ps: &ParaShape,
) -> Result<(), SerializeError> {
    super::utils::start_tag(w, "hp:switch")?;

    start_tag_attrs(
        w,
        "hp:case",
        &[(
            "hp:required-namespace",
            "http://www.hancom.co.kr/hwpml/2016/HwpUnitChar",
        )],
    )?;
    write_para_margin(w, ps, true)?;
    write_para_line_spacing(w, ps, true)?;
    end_tag(w, "hp:case")?;

    super::utils::start_tag(w, "hp:default")?;
    write_para_margin(w, ps, false)?;
    write_para_line_spacing(w, ps, false)?;
    end_tag(w, "hp:default")?;

    end_tag(w, "hp:switch")?;
    Ok(())
}

/// `<hh:margin>` (자식 5개: intent/left/right/prev/next). `half=true` 면 HwpUnitChar
/// case 용으로 저장값의 절반을 쓴다.
fn write_para_margin<W: Write>(
    w: &mut Writer<W>,
    ps: &ParaShape,
    half: bool,
) -> Result<(), SerializeError> {
    super::utils::start_tag(w, "hh:margin")?;
    write_margin_child(w, "hc:intent", ps.indent, half)?;
    write_margin_child(w, "hc:left", ps.margin_left, half)?;
    write_margin_child(w, "hc:right", ps.margin_right, half)?;
    write_margin_child(w, "hc:prev", ps.spacing_before, half)?;
    write_margin_child(w, "hc:next", ps.spacing_after, half)?;
    end_tag(w, "hh:margin")?;
    Ok(())
}

/// `<hh:lineSpacing>`. HwpUnitChar case(`case=true`)에서 PERCENT 는 저장값과 동일,
/// 그 외 유형은 저장값의 절반을 쓴다(파서가 ×2 적재).
fn write_para_line_spacing<W: Write>(
    w: &mut Writer<W>,
    ps: &ParaShape,
    case: bool,
) -> Result<(), SerializeError> {
    let value = if case && !matches!(ps.line_spacing_type, LineSpacingType::Percent) {
        ps.line_spacing / 2
    } else {
        ps.line_spacing
    };
    empty_tag(
        w,
        "hh:lineSpacing",
        &[
            ("type", line_spacing_type_str(ps.line_spacing_type)),
            ("value", &value.to_string()),
            ("unit", "HWPUNIT"),
        ],
    )
}

/// margin 자식(`<hc:intent value="…" unit="HWPUNIT"/>`). 한컴 원본 속성 순서는
/// value, unit 이며 네임스페이스는 `hc:` 다.
///
/// 한컴은 홀수 저장값의 case 절반을 `unit="CHAR"` 로 표시한다. [#6875]
fn write_margin_child<W: Write>(
    w: &mut Writer<W>,
    name: &str,
    stored: i32,
    half: bool,
) -> Result<(), SerializeError> {
    if !half {
        return empty_tag(
            w,
            name,
            &[("value", &stored.to_string()), ("unit", "HWPUNIT")],
        );
    }
    let (value, unit) = hwpunitchar_case_margin(stored);
    empty_tag(w, name, &[("value", &value.to_string()), ("unit", unit)])
}

/// HwpUnitChar case 여백. 홀수 저장값은 `unit="CHAR"` 로 최하위 비트를 남긴다.
fn hwpunitchar_case_margin(stored: i32) -> (i32, &'static str) {
    if stored % 2 != 0 {
        ((stored - 1) / 2, "CHAR")
    } else {
        (stored / 2, "HWPUNIT")
    }
}

fn alignment_str(a: Alignment) -> &'static str {
    use Alignment::*;
    match a {
        Justify => "JUSTIFY",
        Left => "LEFT",
        Right => "RIGHT",
        Center => "CENTER",
        Distribute => "DISTRIBUTE",
        Split => "DISTRIBUTE_SPACE",
    }
}

/// `parse_vertical_alignment_bits` 의 역함수. attr1 bits 20..21 → OWPML 문자열.
fn vertical_alignment_str(bits: u32) -> &'static str {
    match bits {
        1 => "TOP",
        2 => "CENTER",
        3 => "BOTTOM",
        _ => "BASELINE",
    }
}

fn head_type_str(h: HeadType) -> &'static str {
    use HeadType::*;
    match h {
        None => "NONE",
        Outline => "OUTLINE",
        Number => "NUMBER",
        Bullet => "BULLET",
    }
}

fn line_spacing_type_str(t: LineSpacingType) -> &'static str {
    use LineSpacingType::*;
    match t {
        Percent => "PERCENT",
        Fixed => "FIXED",
        SpaceOnly => "BETWEEN_LINES",
        Minimum => "AT_LEAST",
    }
}

// =====================================================================
// <hh:styles>
// =====================================================================
fn write_styles<W: Write>(
    w: &mut Writer<W>,
    doc_info: &DocInfo,
    ctx: &SerializeContext,
) -> Result<(), SerializeError> {
    let _ = ctx;
    if doc_info.styles.is_empty() {
        return Ok(());
    }
    start_tag_attrs(
        w,
        "hh:styles",
        &[("itemCnt", &doc_info.styles.len().to_string())],
    )?;
    for (idx, st) in doc_info.styles.iter().enumerate() {
        write_style(w, idx as u16, st)?;
    }
    end_tag(w, "hh:styles")?;
    Ok(())
}

fn write_style<W: Write>(w: &mut Writer<W>, id: u16, st: &Style) -> Result<(), SerializeError> {
    let type_str = if st.style_type == 1 { "CHAR" } else { "PARA" };
    empty_tag(
        w,
        "hh:style",
        &[
            ("id", &id.to_string()),
            ("type", type_str),
            ("name", &st.local_name),
            ("engName", &st.english_name),
            ("paraPrIDRef", &st.para_shape_id.to_string()),
            ("charPrIDRef", &st.char_shape_id.to_string()),
            ("nextStyleIDRef", &st.next_style_id.to_string()),
            // 파서가 Style.lang_id 로 읽는 값을 그대로 되돌린다. 종전 "1042"
            // 하드코딩은 비한국어 langID(예: 1033)를 왕복마다 1042 로 바꿨다.
            ("langID", &st.lang_id.to_string()),
            ("lockForm", bool01(st.lock_form)),
        ],
    )
}

// =====================================================================
// <hh:compatibleDocument>, <hh:docOption>, <hh:trackchageConfig>
// =====================================================================
fn write_compatible_document<W: Write>(
    w: &mut Writer<W>,
    doc_info: &DocInfo,
) -> Result<(), SerializeError> {
    start_tag_attrs(
        w,
        "hh:compatibleDocument",
        &[(
            "targetProgram",
            doc_info.hwpx_target_program.as_deref().unwrap_or("HWP201X"),
        )],
    )?;
    // upstream #7478: HWP5 필드 묶음 이름은 HWPX의 자식 요소가 아니다.
    // 기본 폴백은 Hancom reference와 같은 빈 블록으로 쓰되, 포크에서 지원하는
    // 실제 호환성 설정이 있으면 그 요소와 targetProgram은 보존한다.
    if !doc_info.adjust_baseline_in_fixed_line_spacing && !doc_info.do_not_align_last_forbidden {
        empty_tag(w, "hh:layoutCompatibility", &[])?;
        end_tag(w, "hh:compatibleDocument")?;
        return Ok(());
    }
    super::utils::start_tag(w, "hh:layoutCompatibility")?;
    if doc_info.adjust_baseline_in_fixed_line_spacing {
        empty_tag(w, "hh:adjustBaselineInFixedLinespacing", &[])?;
    }
    if doc_info.do_not_align_last_forbidden {
        empty_tag(w, "hh:doNotAlignLastForbidden", &[])?;
    }
    end_tag(w, "hh:layoutCompatibility")?;
    end_tag(w, "hh:compatibleDocument")?;
    Ok(())
}

fn write_doc_option<W: Write>(w: &mut Writer<W>) -> Result<(), SerializeError> {
    super::utils::start_tag(w, "hh:docOption")?;
    empty_tag(
        w,
        "hh:linkinfo",
        &[("path", ""), ("pageInherit", "0"), ("footnoteInherit", "0")],
    )?;
    end_tag(w, "hh:docOption")?;
    Ok(())
}

fn write_track_change_config<W: Write>(w: &mut Writer<W>) -> Result<(), SerializeError> {
    empty_tag(w, "hh:trackchageConfig", &[("flags", "0")])
}

// 내부에서 쓰는 start_tag 별명
use super::utils::start_tag;

