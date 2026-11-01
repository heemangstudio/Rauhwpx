//! 그리기 개체 (도형) 직렬화 — Rectangle / Line / Container.
//!
//! Stage 5 (#182)에서 뼈대를 만들고, #1379 3단계에서 rect 하위 요소 보존으로 확장했다.
//!
//! 속성·자식 순서는 한컴 원본 XML 실측(tbox-v-flow-01) 기준:
//! `offset → orgSz → curSz → flip → rotationInfo → renderingInfo → lineShape →
//! fillBrush → shadow → drawText → hc:pt0~pt3 → sz → pos → outMargin → shapeComment`
//!
//! ## 범위 한정
//!
//! - rect 우선 (#1379 3단계). Arc / Polygon / Curve 등 타 도형 확대는 측정 후 별도 분류.
//! - 글상자(drawText) 문단은 본문·셀과 동일한 `render_paragraph_parts` 공유 경로로
//!   직렬화한다 (컨트롤 슬롯 + run 분할 + lineseg IR 보존).

#![allow(dead_code)]

use std::io::Write;

use quick_xml::Writer;

use crate::model::shape::{
    CommonObjAttr, DrawingObjAttr, HorzAlign, HorzRelTo, LineShape, ObjectNumberingType,
    OleDrawingAspect, OleShape, RectangleShape, ShapeComponentAttr, SizeCriterion, TextBox,
    TextFlow, TextWrap, VertAlign, VertRelTo,
};
use crate::model::style::{Fill, FillType, ImageFillMode, ShapeBorderLine, SolidFill};
use crate::model::ColorRef;

use super::context::SerializeContext;
use super::section::{render_hp_p_open, render_paragraph_parts};
use super::table::write_caption;
use super::utils::{empty_tag, end_tag, start_tag, start_tag_attrs, text};
use super::SerializeError;

// =====================================================================
// <hp:rect>
// =====================================================================

/// `<hp:rect>` 직렬화 진입점. Rectangle IR → XML.
pub fn write_rect<W: Write>(
    w: &mut Writer<W>,
    rect: &RectangleShape,
    ctx: &mut SerializeContext,
) -> Result<(), SerializeError> {
    let c = &rect.common;
    let sa = &rect.drawing.shape_attr;
    // 속성 (부모 AbstractShapeObjectType + 자신):
    // id, zOrder, numberingType, textWrap, textFlow, lock, dropcapstyle,
    // href, groupLevel, instid, ratio
    let id_str = c.instance_id.to_string();
    let z_order = c.z_order.to_string();
    let tw = text_wrap_str(c.text_wrap);
    let tf = text_flow_str(c.text_flow);
    let group_level = sa.group_level.to_string();
    // 파서는 instid 를 drawing.inst_id 에 보존한다 (0이면 instance_id 대체).
    let instid = if rect.drawing.inst_id != 0 {
        rect.drawing.inst_id
    } else {
        c.instance_id
    }
    .to_string();
    let ratio = rect.round_rate.to_string();

    start_tag_attrs(
        w,
        "hp:rect",
        &[
            ("id", &id_str),
            ("zOrder", &z_order),
            ("numberingType", numbering_type_str(c.numbering_type)),
            ("textWrap", tw),
            ("textFlow", tf),
            // [#2840] lock(개체 잠금) — 파서가 읽기 시작했으므로 IR 값을 방출한다.
            ("lock", bool01(c.locked)),
            ("dropcapstyle", "None"),
            ("href", ""),
            ("groupLevel", &group_level),
            ("instid", &instid),
            ("ratio", &ratio),
        ],
    )?;

    // 자식 순서 — 한컴 원본 실측 (tbox-v-flow-01) 기준.
    write_offset(w, sa)?;
    write_org_sz(w, sa)?;
    write_cur_sz(w, sa)?;
    write_flip(w, sa)?;
    write_rotation_info(w, sa)?;
    write_rendering_info(w, sa)?;
    write_line_shape(w, &rect.drawing.border_line)?;
    write_fill_brush(w, &rect.drawing.fill, ctx)?;
    write_shadow(w, &rect.drawing)?;

    // drawText: 글상자 내부 문단
    if let Some(ref tb) = rect.drawing.text_box {
        if !tb.paragraphs.is_empty() {
            write_draw_text(w, tb, ctx)?;
        }
    }

    // 꼭짓점 4점 (hc: 접두어)
    write_rect_pts(w, &rect.x_coords, &rect.y_coords)?;

    write_sz(w, c)?;
    write_pos(w, c)?;
    write_out_margin(w, c)?;
    // 캡션 (#1403) — OWPML AbstractShapeObjectType 순서: outMargin 과 shapeComment 사이
    if let Some(cap) = &rect.drawing.caption {
        write_caption(w, cap, ctx)?;
    }
    write_shape_comment(w, c)?;

    end_tag(w, "hp:rect")?;
    Ok(())
}

// =====================================================================
// <hp:line>
// =====================================================================

/// [Issue #1943] LinkLineType → HWPX `type` 속성 문자열 (parse_connect_line_type_attr 역).
fn link_line_type_str(t: crate::model::shape::LinkLineType) -> &'static str {
    use crate::model::shape::LinkLineType::*;
    match t {
        StraightNoArrow => "STRAIGHT_NOARROW",
        StraightOneWay => "STRAIGHT_ONEWAY",
        StraightBoth => "STRAIGHT_BOTH",
        StrokeNoArrow => "STROKE_NOARROW",
        StrokeOneWay => "STROKE_ONEWAY",
        StrokeBoth => "STROKE_BOTH",
        ArcNoArrow => "ARC_NOARROW",
        ArcOneWay => "ARC_ONEWAY",
        ArcBoth => "ARC_BOTH",
    }
}

/// `<hp:line>` / `<hp:connectLine>` 직렬화 진입점. LineShape IR → XML.
///
/// [Issue #1943] 종전 write_line 은 골격 속성(startX/Y/endX/Y attr + sz/pos/outMargin)
/// 만 방출해 (A) connector 보유 시에도 무조건 hp:line 으로 변질하고, (B) 컴포넌트
/// 블록(offset/orgSz/curSz/flip/rotationInfo/renderingInfo)·lineShape(색·굵기)·
/// fillBrush/shadow·좌표(hp:startPt/endPt 자식) 전체를 소실시켰다. 파서는 좌표를
/// startPt/endPt **자식 요소**로만 읽으므로(startX/Y attr 무시) 종전 좌표는 dead
/// 였다. write_rect 와 동형으로 전 구조를 방출한다.
pub fn write_line<W: Write>(
    w: &mut Writer<W>,
    line: &LineShape,
    ctx: &mut SerializeContext,
) -> Result<(), SerializeError> {
    let c = &line.common;
    let sa = &line.drawing.shape_attr;
    let is_connector = line.connector.is_some();
    let tag = if is_connector {
        "hp:connectLine"
    } else {
        "hp:line"
    };

    let id_str = c.instance_id.to_string();
    let z_order = c.z_order.to_string();
    let group_level = sa.group_level.to_string();
    let instid = if line.drawing.inst_id != 0 {
        line.drawing.inst_id
    } else {
        c.instance_id
    }
    .to_string();
    let srb = bool01(line.started_right_or_bottom);

    let mut attrs: Vec<(&str, &str)> = vec![
        ("id", &id_str),
        ("zOrder", &z_order),
        ("numberingType", numbering_type_str(c.numbering_type)),
        ("textWrap", text_wrap_str(c.text_wrap)),
        ("textFlow", text_flow_str(c.text_flow)),
        // [#2840] lock(개체 잠금) — IR 보존 값 방출.
        ("lock", bool01(c.locked)),
        ("dropcapstyle", "None"),
        ("href", ""),
        ("groupLevel", &group_level),
        ("instid", &instid),
    ];
    if let Some(conn) = &line.connector {
        attrs.push(("type", link_line_type_str(conn.link_type)));
    }
    attrs.push(("isReverseHV", srb));
    start_tag_attrs(w, tag, &attrs)?;

    // 컴포넌트 블록 + 지오메트리 (write_rect 동형): offset/orgSz/curSz/flip/
    // rotationInfo/renderingInfo → lineShape → fillBrush → shadow.
    write_shape_component_block(w, sa)?;
    write_line_shape(w, &line.drawing.border_line)?;
    write_fill_brush(w, &line.drawing.fill, ctx)?;
    write_shadow(w, &line.drawing)?;

    // 좌표 — hp:startPt/hp:endPt 자식 (파서가 읽는 유일 경로). connectLine 은
    // subjectIDRef/subjectIdx(연결 개체) 포함.
    let (sub_start_ref, sub_start_idx, sub_end_ref, sub_end_idx) = line
        .connector
        .as_ref()
        .map(|conn| {
            (
                conn.start_subject_id,
                conn.start_subject_index,
                conn.end_subject_id,
                conn.end_subject_index,
            )
        })
        .unwrap_or((0, 0, 0, 0));
    let (sx, sy) = (line.start.x.to_string(), line.start.y.to_string());
    let (ex, ey) = (line.end.x.to_string(), line.end.y.to_string());
    if is_connector {
        let (ssr, ssi) = (sub_start_ref.to_string(), sub_start_idx.to_string());
        let (esr, esi) = (sub_end_ref.to_string(), sub_end_idx.to_string());
        empty_tag(
            w,
            "hp:startPt",
            &[
                ("x", &sx),
                ("y", &sy),
                ("subjectIDRef", &ssr),
                ("subjectIdx", &ssi),
            ],
        )?;
        empty_tag(
            w,
            "hp:endPt",
            &[
                ("x", &ex),
                ("y", &ey),
                ("subjectIDRef", &esr),
                ("subjectIdx", &esi),
            ],
        )?;
    } else {
        // 직선의 좌표는 한컴 core 네임스페이스(hc:)다. hp: 로 쓰면 한글이 문서 열기를
        // 거부한다(선이 든 HWP 를 HWPX 로 저장한 파일 전체). connectLine 만 hp: 를 쓴다.
        empty_tag(w, "hc:startPt", &[("x", &sx), ("y", &sy)])?;
        empty_tag(w, "hc:endPt", &[("x", &ex), ("y", &ey)])?;
    }

    // connectLine 제어점 (꺾인/곡선 커넥터의 경로).
    if let Some(conn) = &line.connector {
        if !conn.control_points.is_empty() {
            start_tag(w, "hp:controlPoints")?;
            for p in &conn.control_points {
                let (px, py, pt) = (p.x.to_string(), p.y.to_string(), p.point_type.to_string());
                empty_tag(w, "hp:point", &[("x", &px), ("y", &py), ("type", &pt)])?;
            }
            end_tag(w, "hp:controlPoints")?;
        }
    }

    write_sz(w, c)?;
    write_pos(w, c)?;
    write_out_margin(w, c)?;
    // 캡션 (#1403) — OWPML AbstractShapeObjectType 순서: outMargin 뒤
    if let Some(cap) = &line.drawing.caption {
        write_caption(w, cap, ctx)?;
    }
    // [#1588] 도형 설명 — caption 뒤 (write_rect/container 와 동형).
    write_shape_comment(w, c)?;

    end_tag(w, tag)?;
    Ok(())
}

// =====================================================================
// <hp:container> — 묶음 개체 (GroupShape). Stage 5 뼈대만.
// =====================================================================

/// `<hp:container>` 뼈대 — 내부 자식 도형 루프는 dispatcher에서 처리.
///
/// 한컴 실측(hwpx-h-01) 컨테이너 직계 순서:
/// offset → orgSz → curSz → flip → rotationInfo → renderingInfo → [자식 도형들]
/// → sz → pos → outMargin → shapeComment.
/// 그룹 자신의 shape_attr(orgSz/curSz/offset/renderingInfo)이 누락되면 렌더러가
/// 그룹 스케일·자식 기준 좌표를 계산하지 못해 자식이 그룹 원점에 고유 크기로 붕괴한다.
pub fn write_container_open<W: Write>(
    w: &mut Writer<W>,
    common: &CommonObjAttr,
    sa: &ShapeComponentAttr,
) -> Result<(), SerializeError> {
    let id_str = common.instance_id.to_string();
    let z_order = common.z_order.to_string();
    let tw = text_wrap_str(common.text_wrap);
    let tf = text_flow_str(common.text_flow);

    start_tag_attrs(
        w,
        "hp:container",
        &[
            ("id", &id_str),
            ("zOrder", &z_order),
            ("numberingType", numbering_type_str(common.numbering_type)),
            ("textWrap", tw),
            ("textFlow", tf),
            // [#2840] lock(개체 잠금) — IR 보존 값 방출.
            ("lock", bool01(common.locked)),
            ("dropcapstyle", "None"),
            ("href", ""),
            ("groupLevel", "0"),
            ("instid", &id_str),
        ],
    )?;

    // 그룹 자신의 좌표계 — 자식 도형 앞에 방출 (write_rect 패턴과 동일 순서).
    write_offset(w, sa)?;
    write_org_sz(w, sa)?;
    write_cur_sz(w, sa)?;
    write_flip(w, sa)?;
    write_rotation_info(w, sa)?;
    write_rendering_info(w, sa)?;

    Ok(())
}

/// `<hp:container>` 닫기 — 자식 도형 뒤에 sz → pos → outMargin → caption(#1403) →
/// shapeComment(#1392) 순으로 방출 (한컴 실측 hwpx-h-01/aift 순서).
pub fn write_container_close<W: Write>(
    w: &mut Writer<W>,
    caption: Option<&crate::model::shape::Caption>,
    common: &CommonObjAttr,
    ctx: &mut SerializeContext,
) -> Result<(), SerializeError> {
    write_sz(w, common)?;
    write_pos(w, common)?;
    write_out_margin(w, common)?;
    if let Some(cap) = caption {
        write_caption(w, cap, ctx)?;
    }
    // 설명 (#1392) — caption 직후
    write_shape_comment(w, common)?;
    end_tag(w, "hp:container")
}

// =====================================================================
// <hp:ole> — OLE 개체 (차트 등 포함)
//
// 종전 직렬화는 OLE 를 legacy 공용 경로(sz/pos/outMargin 만)로 내보내 binaryItemIDRef·
// extent·shape_attr 를 빠뜨렸다. 그 결과 라운드트립에서 OLE 데이터 참조가 소실되어
// 렌더가 placeholder 로 강등됐다(143E: RawSvg→Placeholder). picture 패턴으로 복원한다.
// =====================================================================
pub(crate) fn write_ole<W: Write>(
    w: &mut Writer<W>,
    ole: &OleShape,
    ctx: &mut SerializeContext,
) -> Result<(), SerializeError> {
    let c = &ole.common;
    let id_str = c.instance_id.to_string();
    let z_order = c.z_order.to_string();
    let tw = text_wrap_str(c.text_wrap);
    let tf = text_flow_str(c.text_flow);
    // owned 으로 변환해 ctx 불변 borrow 를 즉시 해제(이후 write_caption 의 &mut 사용).
    let bidref = ctx
        .resolve_bin_id(ole.bin_data_id as u16)
        .unwrap_or("")
        .to_string();
    let draw_aspect = match ole.drawing_aspect {
        OleDrawingAspect::Icon => "ICON",
        OleDrawingAspect::Thumbnail => "THUMBNAIL",
        OleDrawingAspect::DocPrint => "DOCPRINT",
        OleDrawingAspect::Content => "CONTENT",
    };
    // [#2931] 개체 잠금(lock) — IR(common.locked)을 보존(종전 "0" 하드코딩 제거).
    let lock = if c.locked { "1" } else { "0" };

    start_tag_attrs(
        w,
        "hp:ole",
        &[
            ("id", &id_str),
            ("zOrder", &z_order),
            ("numberingType", numbering_type_str(c.numbering_type)),
            ("textWrap", tw),
            ("textFlow", tf),
            // [#2840] lock(개체 잠금) — IR 보존 값 방출.
            ("lock", bool01(c.locked)),
            ("dropcapstyle", "None"),
            ("href", ""),
            ("groupLevel", "0"),
            ("instid", &id_str),
            ("objectType", "UNKNOWN"),
            ("binaryItemIDRef", &bidref),
            ("hasMoniker", "0"),
            ("drawAspect", draw_aspect),
            ("eqBaseLine", "0"),
        ],
    )?;

    // shape_attr 블록 (offset/orgSz/curSz/flip/rotationInfo/renderingInfo)
    write_shape_component_block(w, &ole.drawing.shape_attr)?;
    // 개체 영역
    let ex = ole.extent_x.to_string();
    let ey = ole.extent_y.to_string();
    empty_tag(w, "hc:extent", &[("x", &ex), ("y", &ey)])?;
    write_line_shape(w, &ole.drawing.border_line)?;
    write_sz(w, c)?;
    write_pos(w, c)?;
    write_out_margin(w, c)?;
    if let Some(cap) = &ole.caption {
        write_caption(w, cap, ctx)?;
    }
    write_shape_comment(w, c)?;

    end_tag(w, "hp:ole")?;
    Ok(())
}

/// Write an HWPX-native editable chart reference.
///
/// `OleShape` is used internally as the layout bridge for parsed `<hp:chart>`
/// controls, but its synthetic 60000+N ID must never escape as BinData/OLE.
pub(crate) fn write_hwpx_chart<W: Write>(
    w: &mut Writer<W>,
    chart: &OleShape,
    chart_href: &str,
    ctx: &mut SerializeContext,
) -> Result<(), SerializeError> {
    let c = &chart.common;
    let id = c.instance_id.to_string();
    let z_order = c.z_order.to_string();
    start_tag_attrs(
        w,
        "hp:chart",
        &[
            ("id", &id),
            ("zOrder", &z_order),
            ("numberingType", numbering_type_str(c.numbering_type)),
            ("textWrap", text_wrap_str(c.text_wrap)),
            ("textFlow", text_flow_str(c.text_flow)),
            ("lock", bool01(c.locked)),
            ("dropcapstyle", "None"),
            ("chartIDRef", chart_href),
        ],
    )?;
    write_sz(w, c)?;
    write_pos(w, c)?;
    write_out_margin(w, c)?;
    if let Some(caption) = &chart.caption {
        write_caption(w, caption, ctx)?;
    }
    write_shape_comment(w, c)?;
    end_tag(w, "hp:chart")
}

// =====================================================================
// <hp:drawText> — 글상자 내부 텍스트
// =====================================================================

/// `<hp:drawText>` 직렬화 — TextBox의 paragraphs를 subList로 출력 (#1379 3단계).
///
/// - 문단은 본문·셀과 동일한 `render_paragraph_parts` 공유 경로 (컨트롤 슬롯 +
///   run 분할 + lineseg IR 보존/fallback)
/// - `textDirection` VERTICAL/VERTICALALL 구분은 `TextBox.vertical_all` 로 보존
/// - `textMargin` 은 subList **뒤** (한컴 원본 순서, footnote-tbox-01 실측),
///   네 여백 모두 0이면 원본 부재로 간주하여 미방출
pub fn write_draw_text<W: Write>(
    w: &mut Writer<W>,
    tb: &TextBox,
    ctx: &mut SerializeContext,
) -> Result<(), SerializeError> {
    let lw = tb.max_width.to_string();
    start_tag_attrs(
        w,
        "hp:drawText",
        &[("lastWidth", &lw), ("name", ""), ("editable", "0")],
    )?;

    // textDirection: list_attr bit 0~2 (1=세로쓰기), vertical_all 로 ALL 구분.
    let text_direction = if tb.list_attr & 0x07 == 1 {
        if tb.vertical_all {
            "VERTICALALL"
        } else {
            "VERTICAL"
        }
    } else {
        "HORIZONTAL"
    };
    let vert_align = match tb.vertical_align {
        crate::model::table::VerticalAlign::Center => "CENTER",
        crate::model::table::VerticalAlign::Bottom => "BOTTOM",
        crate::model::table::VerticalAlign::Top => "TOP",
    };

    start_tag_attrs(
        w,
        "hp:subList",
        &[
            ("id", ""),
            ("textDirection", text_direction),
            ("lineWrap", "BREAK"),
            ("vertAlign", vert_align),
            ("linkListIDRef", "0"),
            ("linkListNextIDRef", "0"),
            ("textWidth", "0"),
            ("textHeight", "0"),
            ("hasTextRef", "0"),
            ("hasNumRef", "0"),
        ],
    )?;

    // sub_list_depth: 글상자 경로 한정 colPr 인라인 방출 스코프 (#1379 3단계).
    ctx.sub_list_depth += 1;
    let mut vert_cursor: u32 = 0;
    for para in tb.paragraphs.iter() {
        ctx.para_shape_ids.reference(para.para_shape_id);
        let sid = ctx.reference_style(para.style_id);

        let rendered = render_paragraph_parts(para, vert_cursor, ctx);
        if rendered.is_err() {
            ctx.sub_list_depth -= 1;
        }
        let (runs, linesegs, advance) = rendered?;
        vert_cursor = advance;
        let pid = ctx.next_para_id();
        let mut p_xml = render_hp_p_open(para, pid, sid);
        p_xml.push_str(&runs);
        p_xml.push_str(&linesegs);
        p_xml.push_str("</hp:p>");
        w.get_mut()
            .write_all(p_xml.as_bytes())
            .map_err(|e| SerializeError::XmlError(e.to_string()))?;
    }
    ctx.sub_list_depth -= 1;

    end_tag(w, "hp:subList")?;

    if tb.margin_left != 0 || tb.margin_right != 0 || tb.margin_top != 0 || tb.margin_bottom != 0 {
        let ml = tb.margin_left.to_string();
        let mr = tb.margin_right.to_string();
        let mt = tb.margin_top.to_string();
        let mb = tb.margin_bottom.to_string();
        empty_tag(
            w,
            "hp:textMargin",
            &[("left", &ml), ("right", &mr), ("top", &mt), ("bottom", &mb)],
        )?;
    }

    end_tag(w, "hp:drawText")?;
    Ok(())
}

// =====================================================================
// ShapeComponentAttr 하위 요소 (offset / orgSz / curSz / flip / rotationInfo / renderingInfo)
// =====================================================================

/// AbstractShapeComponentType 의 좌표계 블록을 한컴 순서로 방출한다:
/// offset → orgSz → curSz → flip → rotationInfo → renderingInfo.
/// 누락 시 회전/뒤집힘·그룹 내 좌표가 소실되어 렌더가 어긋난다(ellipse/arc/polygon/curve 공용).
pub(crate) fn write_shape_component_block<W: Write>(
    w: &mut Writer<W>,
    sa: &ShapeComponentAttr,
) -> Result<(), SerializeError> {
    write_offset(w, sa)?;
    write_org_sz(w, sa)?;
    write_cur_sz(w, sa)?;
    write_flip(w, sa)?;
    write_rotation_info(w, sa)?;
    write_rendering_info(w, sa)?;
    Ok(())
}

fn write_offset<W: Write>(
    w: &mut Writer<W>,
    sa: &ShapeComponentAttr,
) -> Result<(), SerializeError> {
    // 한컴은 음수 HWPUNIT을 unsigned 32-bit decimal로 기록한다.
    let x = (sa.offset_x as u32).to_string();
    let y = (sa.offset_y as u32).to_string();
    empty_tag(w, "hp:offset", &[("x", &x), ("y", &y)])
}

fn write_org_sz<W: Write>(
    w: &mut Writer<W>,
    sa: &ShapeComponentAttr,
) -> Result<(), SerializeError> {
    let width = sa.original_width.to_string();
    let height = sa.original_height.to_string();
    empty_tag(w, "hp:orgSz", &[("width", &width), ("height", &height)])
}

fn write_cur_sz<W: Write>(
    w: &mut Writer<W>,
    sa: &ShapeComponentAttr,
) -> Result<(), SerializeError> {
    // [#2017] 파싱 시 orgSz로 materialize된 dimension 은 원본 `0` sentinel 로 복원.
    let width = if sa.current_width_was_zero {
        0
    } else {
        sa.current_width
    }
    .to_string();
    let height = if sa.current_height_was_zero {
        0
    } else {
        sa.current_height
    }
    .to_string();
    empty_tag(w, "hp:curSz", &[("width", &width), ("height", &height)])
}

fn write_flip<W: Write>(w: &mut Writer<W>, sa: &ShapeComponentAttr) -> Result<(), SerializeError> {
    empty_tag(
        w,
        "hp:flip",
        &[
            ("horizontal", bool01(sa.horz_flip)),
            ("vertical", bool01(sa.vert_flip)),
        ],
    )
}

fn write_rotation_info<W: Write>(
    w: &mut Writer<W>,
    sa: &ShapeComponentAttr,
) -> Result<(), SerializeError> {
    let angle = sa.rotation_angle.to_string();
    let cx = sa.rotation_center.x.to_string();
    let cy = sa.rotation_center.y.to_string();
    empty_tag(
        w,
        "hp:rotationInfo",
        &[
            ("angle", &angle),
            ("centerX", &cx),
            ("centerY", &cy),
            ("rotateimage", bool01(sa.rotate_image)),
        ],
    )
}

/// `<hp:renderingInfo>` — `raw_rendering` (cnt u16 LE + trans 6×f64 + cnt×(sca, rot))
/// 를 디코드해 행렬을 재구성한다 (`parse_rendering_info` 의 역). raw 비정합/빈 경우
/// identity 3행렬 fallback. pic 자식도 공유 (그룹 내 자식 transMatrix 보존).
pub(crate) fn write_rendering_info<W: Write>(
    w: &mut Writer<W>,
    sa: &ShapeComponentAttr,
) -> Result<(), SerializeError> {
    const IDENTITY: [f64; 6] = [1.0, 0.0, 0.0, 0.0, 1.0, 0.0];
    let (trans, pairs) =
        decode_raw_rendering(&sa.raw_rendering).unwrap_or((IDENTITY, vec![(IDENTITY, IDENTITY)]));

    start_tag(w, "hp:renderingInfo")?;
    write_matrix(w, "hc:transMatrix", &trans)?;
    for (sca, rot) in &pairs {
        write_matrix(w, "hc:scaMatrix", sca)?;
        write_matrix(w, "hc:rotMatrix", rot)?;
    }
    end_tag(w, "hp:renderingInfo")
}

type RenderMatrices = ([f64; 6], Vec<([f64; 6], [f64; 6])>);

fn decode_raw_rendering(raw: &[u8]) -> Option<RenderMatrices> {
    if raw.len() < 2 + 48 {
        return None;
    }
    let cnt = u16::from_le_bytes([raw[0], raw[1]]) as usize;
    if raw.len() < 2 + 48 + cnt * 96 {
        return None;
    }
    let read6 = |off: usize| -> [f64; 6] {
        let mut m = [0.0f64; 6];
        for (i, v) in m.iter_mut().enumerate() {
            let p = off + i * 8;
            *v = f64::from_le_bytes(raw[p..p + 8].try_into().unwrap());
        }
        m
    };
    let trans = read6(2);
    let mut pairs = Vec::with_capacity(cnt);
    for k in 0..cnt {
        let base = 2 + 48 + k * 96;
        pairs.push((read6(base), read6(base + 48)));
    }
    Some((trans, pairs))
}

/// 행렬 값 포맷: 정수는 정수 문자열, 비정수는 f32 정밀도 (파서가 f32 로 적재 —
/// 원본 "1.579917" 보존).
fn fmt_matrix_val(v: f64) -> String {
    if v.fract() == 0.0 {
        format!("{}", v as i64)
    } else {
        format!("{}", v as f32)
    }
}

fn write_matrix<W: Write>(
    w: &mut Writer<W>,
    name: &str,
    m: &[f64; 6],
) -> Result<(), SerializeError> {
    let vals: Vec<String> = m.iter().map(|v| fmt_matrix_val(*v)).collect();
    empty_tag(
        w,
        name,
        &[
            ("e1", &vals[0]),
            ("e2", &vals[1]),
            ("e3", &vals[2]),
            ("e4", &vals[3]),
            ("e5", &vals[4]),
            ("e6", &vals[5]),
        ],
    )
}

// =====================================================================
// lineShape / fillBrush / shadow
// =====================================================================

/// `<hp:lineShape>` — `parse_line_shape_attr` 의 역매핑.
/// alpha 는 파서 미적재 → "0" 고정 방출. headStyle/tailStyle 은 bit 10~21 에서 복원한다(#2956).
pub(crate) fn write_line_shape<W: Write>(
    w: &mut Writer<W>,
    bl: &ShapeBorderLine,
) -> Result<(), SerializeError> {
    let color = color_to_hex(bl.color);
    let width = bl.width.to_string();
    // style 은 attr 하위 6비트. 정본 코드(0=NONE/1=SOLID/2=DASH…)는 표 borderFill 의
    // border_line_type_from_code 및 HWP5 doc_info 와 동일. 종전에는 0 이 _ => SOLID 로
    // 떨어져 "선 없음" 도형 외곽선이 라운드트립에서 사각형 박스로 살아났다(#1531).
    let style = match bl.attr & 0x3F {
        0 => "NONE",
        1 => "SOLID",
        2 => "DASH",
        3 => "DOT",
        4 => "DASH_DOT",
        5 => "DASH_DOT_DOT",
        6 => "LONG_DASH",
        7 => "CIRCLE",
        8 => "DOUBLE_SLIM",
        9 => "SLIM_THICK",
        10 => "THICK_SLIM",
        11 => "SLIM_THICK_SLIM",
        _ => "SOLID",
    };
    let end_cap = match (bl.attr >> 6) & 0x0F {
        1 => "FLAT",
        2 => "SQUARE",
        _ => "ROUND",
    };
    let head_fill_b = bl.attr & 0x8000_0000 != 0;
    let tail_fill_b = bl.attr & 0x4000_0000 != 0;
    let headfill = bool01(head_fill_b);
    let tailfill = bool01(tail_fill_b);
    let head_style = arrow_style_str((bl.attr >> 10) & 0x3F, head_fill_b);
    let tail_style = arrow_style_str((bl.attr >> 16) & 0x3F, tail_fill_b);
    let head_sz = arrow_size_str((bl.attr >> 22) & 0x0F);
    let tail_sz = arrow_size_str((bl.attr >> 26) & 0x0F);
    let outline = match bl.outline_style {
        1 => "OUTER",
        2 => "INNER",
        _ => "NORMAL",
    };
    empty_tag(
        w,
        "hp:lineShape",
        &[
            ("color", &color),
            ("width", &width),
            ("style", style),
            ("endCap", end_cap),
            ("headStyle", head_style),
            ("tailStyle", tail_style),
            ("headfill", headfill),
            ("tailfill", tailfill),
            ("headSz", head_sz),
            ("tailSz", tail_sz),
            ("outlineStyle", outline),
            ("alpha", "0"),
        ],
    )
}

/// HWP5 화살표 모양 값(hwplib LineArrowShape, `arrow_type_from_hwp` 참조) →
/// OWPML Core `ArrowType` 역매핑. fill 은 채움 여부(bit 30/31)다.
fn arrow_style_str(v: u32, fill: bool) -> &'static str {
    match v {
        1 => "ARROW",
        2 => "SPEAR",
        3 => "CONCAVE_ARROW",
        4 if fill => "FILLED_DIAMOND",
        4 => "EMPTY_DIAMOND",
        5 if fill => "FILLED_CIRCLE",
        5 => "EMPTY_CIRCLE",
        6 if fill => "FILLED_BOX",
        6 => "EMPTY_BOX",
        _ => "NORMAL",
    }
}

/// `parse_line_shape_attr::arrow_size` 의 역매핑 (0~8).
fn arrow_size_str(v: u32) -> &'static str {
    // OWPML Core 스키마 hc:ArrowSize 정본 리터럴은 *_LARGE (Core XML schema.xml:407).
    // "*_BIG" 는 스펙에 없는 비실재 토큰 — 파서는 하위호환을 위해 관용 수용하지만
    // (src/parser/hwpx/section.rs 의 parse_line_shape_attr), 직렬화는 정본만 방출한다.
    match v {
        1 => "SMALL_MEDIUM",
        2 => "SMALL_LARGE",
        3 => "MEDIUM_SMALL",
        4 => "MEDIUM_MEDIUM",
        5 => "MEDIUM_LARGE",
        6 => "LARGE_SMALL",
        7 => "LARGE_MEDIUM",
        8 => "LARGE_LARGE",
        _ => "SMALL_SMALL",
    }
}

/// `<hc:fillBrush><hc:winBrush .../></hc:fillBrush>` 를 방출하는 단일 소유 함수.
/// FillType::Solid 경로와 보존된 빈 채우기(FillType::None + solid 존재) 경로가
/// 동일한 직렬화를 쓰도록 한 곳에 모은다(균일 규칙).
fn write_win_brush<W: Write>(
    w: &mut Writer<W>,
    solid: &SolidFill,
    alpha: u8,
) -> Result<(), SerializeError> {
    let face = color_to_hex(solid.background_color);
    let hatch = color_to_hex(solid.pattern_color);
    let alpha = fill_alpha_str(alpha);
    start_tag(w, "hc:fillBrush")?;
    if solid.pattern_type >= 1 {
        empty_tag(
            w,
            "hc:winBrush",
            &[
                ("faceColor", &face),
                ("hatchColor", &hatch),
                ("hatchStyle", hatch_style_str(solid.pattern_type)),
                ("alpha", &alpha),
            ],
        )?;
    } else {
        empty_tag(
            w,
            "hc:winBrush",
            &[
                ("faceColor", &face),
                ("hatchColor", &hatch),
                ("alpha", &alpha),
            ],
        )?;
    }
    end_tag(w, "hc:fillBrush")
}

/// `<hc:fillBrush>` — `parse_shape_fill_brush` 의 역매핑.
/// `FillType::None` 은 원본에 fillBrush 부재로 간주하되, 파서가 보존한 solid 가
/// 있으면(빈 winBrush) 복원한다.
///
/// 도형(rect/line)뿐 아니라 `header.rs` 의 borderFill 도 같은 fillBrush 구조를
/// 쓰므로 `pub(crate)` 로 공유한다.
pub(crate) fn write_fill_brush<W: Write>(
    w: &mut Writer<W>,
    fill: &Fill,
    ctx: &SerializeContext,
) -> Result<(), SerializeError> {
    match fill.fill_type {
        // FillType::None 이지만 solid 데이터가 보존돼 있으면(원본 winBrush 가
        // faceColor="none"+무늬없음 으로 빈 채우기였던 경우) winBrush 를 그대로
        // 복원한다. solid 가 없으면 원본에 fillBrush 가 없었던 것이므로 미방출.
        FillType::None => match &fill.solid {
            Some(solid) => write_win_brush(w, solid, fill.alpha),
            None => Ok(()),
        },
        FillType::Solid => {
            let solid = fill.solid.unwrap_or_default();
            write_win_brush(w, &solid, fill.alpha)
        }
        FillType::Gradient => {
            let grad = fill.gradient.clone().unwrap_or_default();
            let gtype = match grad.gradient_type {
                1 => "LINEAR".to_string(),
                2 => "RADIAL".to_string(),
                3 => "CONICAL".to_string(),
                4 => "SQUARE".to_string(),
                other => other.to_string(),
            };
            let angle = grad.angle.to_string();
            let cx = grad.center_x.to_string();
            let cy = grad.center_y.to_string();
            let step = grad.blur.to_string();
            let step_center = grad.step_center.to_string();
            let alpha = fill_alpha_str(fill.alpha);
            start_tag(w, "hc:fillBrush")?;
            start_tag_attrs(
                w,
                "hc:gradation",
                &[
                    ("type", &gtype),
                    ("angle", &angle),
                    ("centerX", &cx),
                    ("centerY", &cy),
                    ("step", &step),
                    ("stepCenter", &step_center),
                    ("alpha", &alpha),
                ],
            )?;
            for c in &grad.colors {
                let v = color_to_hex(*c);
                empty_tag(w, "hc:color", &[("value", &v)])?;
            }
            end_tag(w, "hc:gradation")?;
            end_tag(w, "hc:fillBrush")
        }
        FillType::Image => {
            let img = fill.image.clone().unwrap_or_default();
            // [#2943] parse_shape_fill_brush(section.rs)는 12종 mode 를 모두 개별
            // ImageFillMode 로 적재하는데, 종전엔 여기서 3종만 구분하고 나머지 7종
            // (TileHorzTop/Bottom, TileVertLeft/Right, CenterTop/Bottom, LeftTop)이
            // 전부 "TILE"로 붕괴해 저장 시 실제 배치가 유실됐다.
            let mode = match img.fill_mode {
                ImageFillMode::TileHorzTop => "TILE_HORZ_TOP",
                ImageFillMode::TileHorzBottom => "TILE_HORZ_BOTTOM",
                ImageFillMode::TileVertLeft => "TILE_VERT_LEFT",
                ImageFillMode::TileVertRight => "TILE_VERT_RIGHT",
                ImageFillMode::FitToSize => "FIT",
                ImageFillMode::Zoom => "ZOOM",
                ImageFillMode::Total => "TOTAL",
                ImageFillMode::Center => "CENTER",
                ImageFillMode::CenterTop => "CENTER_TOP",
                ImageFillMode::CenterBottom => "CENTER_BOTTOM",
                ImageFillMode::LeftTop => "TOP_LEFT_ALIGN",
                _ => "TILE",
            };
            start_tag(w, "hc:fillBrush")?;
            // bin_data_id 가 ctx 에 등록돼 있으면 <hc:img> 참조를 방출(셀/쪽 배경 이미지
            // 보존). 미등록(예: body shape 의 fill 파서가 bin_data_id 미캡처)이면 종전대로
            // 빈 imgBrush — 잘못된 image0 참조로 3-way 단언을 깨지 않는다.
            match ctx.resolve_bin_id(img.bin_data_id) {
                Some(manifest_id) => {
                    start_tag_attrs(w, "hc:imgBrush", &[("mode", mode)])?;
                    let bright = img.brightness.to_string();
                    let contrast = img.contrast.to_string();
                    let effect = match img.effect {
                        1 => "GRAY_SCALE",
                        2 => "BLACK_WHITE",
                        _ => "REAL_PIC",
                    };
                    empty_tag(
                        w,
                        "hc:img",
                        &[
                            ("binaryItemIDRef", manifest_id),
                            ("bright", &bright),
                            ("contrast", &contrast),
                            ("effect", effect),
                            ("alpha", "0"),
                        ],
                    )?;
                    end_tag(w, "hc:imgBrush")?;
                }
                None => {
                    empty_tag(w, "hc:imgBrush", &[("mode", mode)])?;
                }
            }
            end_tag(w, "hc:fillBrush")
        }
    }
}

/// winBrush/gradation alpha — 파서가 `f.clamp(0,1)*255` 로 적재하므로 0~1 분수로 방출.
fn fill_alpha_str(alpha: u8) -> String {
    if alpha == 0 {
        "0".to_string()
    } else {
        format!("{}", alpha as f64 / 255.0)
    }
}

/// `hatch_style` (1~6) → OWPML hatchStyle. `parse_hatch_style` 의 역매핑.
fn hatch_style_str(pattern_type: i32) -> &'static str {
    match pattern_type {
        1 => "HORIZONTAL",
        2 => "VERTICAL",
        3 => "BACK_SLASH",
        4 => "SLASH",
        5 => "CROSS",
        6 => "CROSS_DIAGONAL",
        // 계약(1~6) 밖의 값은 무늬 정보가 없다는 뜻이므로 임의의 무늬로
        // 둔갑시키지 않고 가장 무난한 HORIZONTAL 로 방출한다.
        _ => "HORIZONTAL",
    }
}

/// `<hp:shadow>` — `parse_shape_shadow_attr` 의 역매핑.
/// 전 필드 0 이면 원본에 shadow 부재로 간주하여 미방출.
/// alpha 는 정수 방출 (파서의 `>1.0` 경로와 정합 — 0/1 경계값만 비가역).
pub(crate) fn write_shadow<W: Write>(
    w: &mut Writer<W>,
    d: &DrawingObjAttr,
) -> Result<(), SerializeError> {
    if d.shadow_type == 0
        && d.shadow_color == 0
        && d.shadow_offset_x == 0
        && d.shadow_offset_y == 0
        && d.shadow_alpha == 0
    {
        return Ok(());
    }
    let ty = match d.shadow_type {
        1 => "LEFT_TOP",
        2 => "RIGHT_TOP",
        3 => "LEFT_BOTTOM",
        4 => "RIGHT_BOTTOM",
        5 => "CENTER",
        _ => "NONE",
    };
    let color = color_to_hex(d.shadow_color);
    let ox = d.shadow_offset_x.to_string();
    let oy = d.shadow_offset_y.to_string();
    let alpha = d.shadow_alpha.to_string();
    empty_tag(
        w,
        "hp:shadow",
        &[
            ("type", ty),
            ("color", &color),
            ("offsetX", &ox),
            ("offsetY", &oy),
            ("alpha", &alpha),
        ],
    )
}

// =====================================================================
// 꼭짓점 / shapeComment
// =====================================================================

fn write_rect_pts<W: Write>(
    w: &mut Writer<W>,
    x: &[i32; 4],
    y: &[i32; 4],
) -> Result<(), SerializeError> {
    for (i, name) in ["hc:pt0", "hc:pt1", "hc:pt2", "hc:pt3"].iter().enumerate() {
        let px = x[i].to_string();
        let py = y[i].to_string();
        empty_tag(w, name, &[("x", &px), ("y", &py)])?;
    }
    Ok(())
}

/// `<hp:shapeComment>` 직렬화 — 도형(rect)·그림(#1392)·수식(#1392)·묶음(#1392) 공유.
///
/// 빈 description 은 미방출 (한컴 원본도 설명 부재 시 요소 없음).
pub(super) fn write_shape_comment<W: Write>(
    w: &mut Writer<W>,
    c: &CommonObjAttr,
) -> Result<(), SerializeError> {
    if c.description.is_empty() {
        return Ok(());
    }
    start_tag(w, "hp:shapeComment")?;
    text(w, &c.description)?;
    end_tag(w, "hp:shapeComment")
}

// =====================================================================
// 공통 자식 요소 (sz / pos / outMargin)
// =====================================================================

fn write_sz<W: Write>(w: &mut Writer<W>, c: &CommonObjAttr) -> Result<(), SerializeError> {
    let width = c.width.to_string();
    let height = c.height.to_string();
    // [#2712] widthRelTo/heightRelTo/protect 는 IR 을 보존한다. 종전 "ABSOLUTE"/"0"
    // 하드코딩은 파서가 이미 읽어 둔 값(section.rs:2901/2904/2907, OLE 는 5967)을 저장 때
    // 버려, 단/쪽/문단에 맞춘 도형이 절대값으로 굳고 "크기 고정"이 풀렸다. 실제 한글 산출
    // 파일 samples/hwpx/143E433F503322BD33.hwpx 의 hp:rect·hp:ole 이 protect="1" 인데
    // 종전 방출은 이를 "0" 으로 되썼다. 이웃 write_pos 는 이미 모든 필드를 통과시키고,
    // 같은 hp:sz 를 다루는 form.rs:183-188 도 3속성 모두 보존한다. 표는 #2697/#2701 에서
    // 같은 결함을 같은 방식으로 정리했다.
    empty_tag(
        w,
        "hp:sz",
        &[
            ("width", &width),
            ("widthRelTo", size_criterion_str(c.width_criterion)),
            ("height", &height),
            ("heightRelTo", height_criterion_str(c.height_criterion)),
            ("protect", bool01(c.size_protect)),
        ],
    )
}

/// 너비 기준 → HWPX `widthRelTo`. 파서 `parse_size_criterion(_, true)` 의 정확한 역이다
/// (`parser/hwpx/section.rs:1844`, 호출부 `:2901`). 너비는 HWP5 attr bit 15-17 로 3비트라
/// 5값 전부를 담는다(`model/shape.rs:83`).
pub(super) fn size_criterion_str(c: SizeCriterion) -> &'static str {
    match c {
        SizeCriterion::Paper => "PAPER",
        SizeCriterion::Page => "PAGE",
        SizeCriterion::Column => "COLUMN",
        SizeCriterion::Para => "PARA",
        SizeCriterion::Absolute => "ABSOLUTE",
    }
}

/// 높이 기준 → HWPX `heightRelTo`. 파서는 높이를
/// `parse_size_criterion(_, allow_column_para = false)` 로 읽으므로(`section.rs:2904`)
/// 치역이 `{PAPER, PAGE, ABSOLUTE}` 3값뿐이다. 방출도 같은 3값으로 접어야 왕복이 정확한
/// 역이 된다. HWP5 측 `height_criterion_to_bits`(`common_obj_attr_writer.rs:160`)와 모델
/// 주석(`model/shape.rs:85`, bit 18-19)도 동일하게 접는다.
pub(super) fn height_criterion_str(c: SizeCriterion) -> &'static str {
    match c {
        SizeCriterion::Paper => "PAPER",
        SizeCriterion::Page => "PAGE",
        SizeCriterion::Column | SizeCriterion::Para | SizeCriterion::Absolute => "ABSOLUTE",
    }
}

fn write_pos<W: Write>(w: &mut Writer<W>, c: &CommonObjAttr) -> Result<(), SerializeError> {
    let treat = bool01(c.treat_as_char);
    let vert_offset = c.vertical_offset.to_string();
    let horz_offset = c.horizontal_offset.to_string();
    let hold = bool01(c.prevent_page_break != 0); // [#1594] IR 보존
    empty_tag(
        w,
        "hp:pos",
        &[
            ("treatAsChar", treat),
            // [#2784] affectLSpacing 은 IR(affect_line_spacing)을 보존한다. 종전 "0"
            // 하드코딩은 "줄 간격에 영향" 켜진 도형이 저장 시 1→0 으로 드롭됐다.
            ("affectLSpacing", bool01(c.affect_line_spacing)),
            ("flowWithText", bool01(c.flow_with_text)),
            ("allowOverlap", bool01(c.allow_overlap)),
            ("holdAnchorAndSO", hold),
            ("vertRelTo", vert_rel_to_str(c.vert_rel_to)),
            ("horzRelTo", horz_rel_to_str(c.horz_rel_to)),
            ("vertAlign", vert_align_str(c.vert_align)),
            ("horzAlign", horz_align_str(c.horz_align)),
            ("vertOffset", &vert_offset),
            ("horzOffset", &horz_offset),
        ],
    )
}

fn write_out_margin<W: Write>(w: &mut Writer<W>, c: &CommonObjAttr) -> Result<(), SerializeError> {
    let l = c.margin.left.to_string();
    let r = c.margin.right.to_string();
    let t = c.margin.top.to_string();
    let b = c.margin.bottom.to_string();
    empty_tag(
        w,
        "hp:outMargin",
        &[("left", &l), ("right", &r), ("top", &t), ("bottom", &b)],
    )
}

/// ColorRef (0xAABBGGRR) → "#RRGGBB" / "#AARRGGBB". 0xFFFFFFFF → "none".
/// `parse_color_str` 의 역매핑 (header.rs `color_hex` 와 동일 규칙).
pub(crate) fn color_to_hex(c: ColorRef) -> String {
    if c == 0xFFFFFFFF {
        return "none".to_string();
    }
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

pub(crate) fn numbering_type_str(n: ObjectNumberingType) -> &'static str {
    match n {
        ObjectNumberingType::Picture => "PICTURE",
        ObjectNumberingType::Table => "TABLE",
        ObjectNumberingType::Equation => "EQUATION",
        ObjectNumberingType::None => "NONE",
    }
}

/// `dropcapstyle` 방출 문자열. OWPML Core 스키마 `DropCapStyleType`
/// (None/DoubleLine/TripleLine/Margin) 그대로 왕복한다.
pub(crate) fn drop_cap_style_str(s: crate::model::shape::DropCapStyle) -> &'static str {
    use crate::model::shape::DropCapStyle;
    match s {
        DropCapStyle::None => "None",
        DropCapStyle::DoubleLine => "DoubleLine",
        DropCapStyle::TripleLine => "TripleLine",
        DropCapStyle::Margin => "Margin",
    }
}

fn bool01(b: bool) -> &'static str {
    if b {
        "1"
    } else {
        "0"
    }
}

fn text_wrap_str(w: TextWrap) -> &'static str {
    use TextWrap::*;
    match w {
        Square => "SQUARE",
        Tight => "TIGHT",
        Through => "THROUGH",
        TopAndBottom => "TOP_AND_BOTTOM",
        BehindText => "BEHIND_TEXT",
        InFrontOfText => "IN_FRONT_OF_TEXT",
    }
}

fn text_flow_str(f: TextFlow) -> &'static str {
    match f {
        TextFlow::BothSides => "BOTH_SIDES",
        TextFlow::LeftOnly => "LEFT_ONLY",
        TextFlow::RightOnly => "RIGHT_ONLY",
        TextFlow::LargestOnly => "LARGEST_ONLY",
    }
}

fn vert_rel_to_str(v: VertRelTo) -> &'static str {
    use VertRelTo::*;
    match v {
        Paper => "PAPER",
        Page => "PAGE",
        Para => "PARA",
    }
}

fn horz_rel_to_str(h: HorzRelTo) -> &'static str {
    use HorzRelTo::*;
    match h {
        Paper => "PAPER",
        Page => "PAGE",
        Column => "COLUMN",
        Para => "PARA",
    }
}

fn vert_align_str(v: VertAlign) -> &'static str {
    use VertAlign::*;
    match v {
        Top => "TOP",
        Center => "CENTER",
        Bottom => "BOTTOM",
        Inside => "INSIDE",
        Outside => "OUTSIDE",
    }
}

fn horz_align_str(h: HorzAlign) -> &'static str {
    use HorzAlign::*;
    match h {
        Left => "LEFT",
        Center => "CENTER",
        Right => "RIGHT",
        Inside => "INSIDE",
        Outside => "OUTSIDE",
    }
}

