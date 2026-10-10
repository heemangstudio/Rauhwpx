use super::*;
use crate::model::document::{Document, Section};
use crate::model::paragraph::{LineSeg, Paragraph};
use crate::paint::{RenderProfile, LAYER_TREE_SCHEMA};
use crate::parser::control::parse_common_obj_attr;
use serde_json::Value;

#[test]
fn font_aware_factories_preserve_input_policy_and_default_to_mac_metrics() {
    use crate::parser::limits::InputPolicy;
    let hwpx = include_bytes!(
        "../../tests/fixtures/editing_parity/mac-hancom-12.30.0/body-mixed-text/edited.hwpx"
    );
    let normal = open_with_font_metrics(hwpx, InputPolicy::Untrusted, "hcr-declared").unwrap();
    let local = open_with_font_metrics(hwpx, InputPolicy::LocalFileOnce, "hcr-declared").unwrap();
    assert_eq!(normal.get_font_metrics_policy(), "hcr-declared");
    assert_eq!(
        normal.get_page_text_layout_native(0).unwrap(),
        local.get_page_text_layout_native(0).unwrap()
    );
    for bytes in [
        include_bytes!("../../saved/blank2010.hwp").as_slice(),
        include_bytes!("../../samples/hml/formatting_table.hml").as_slice(),
    ] {
        // 기준 플랫폼은 macOS 한컴 — 모든 포맷의 기본값이 HCR 선언 메트릭이고,
        // Windows 치환 규칙은 명시 요청 시에만 적용된다.
        assert_eq!(
            HwpDocument::new(bytes).unwrap().get_font_metrics_policy(),
            "hcr-declared"
        );
        let windows =
            open_with_font_metrics(bytes, InputPolicy::Untrusted, "hancom-windows").unwrap();
        assert_eq!(windows.get_font_metrics_policy(), "hancom-windows");
    }
    assert!(open_with_font_metrics(hwpx, InputPolicy::Untrusted, "invalid").is_err());
    assert!(
        open_with_font_metrics(b"invalid document", InputPolicy::Untrusted, "hcr-declared")
            .is_err()
    );
}

#[test]
fn test_create_empty_document() {
    let doc = HwpDocument::create_empty();
    assert_eq!(doc.page_count(), 1);
}

/// [#1386] createEmpty는 구역 1개 + 빈 문단 1개를 포함해 생성 직후
/// 편집/조회/내보내기가 가능해야 한다 (구역 0개 → 모든 API 실패 회귀 방지).
#[test]
fn test_create_empty_document_is_editable() {
    let mut doc = HwpDocument::create_empty();
    assert_eq!(doc.get_section_count(), 1, "기본 구역 1개");

    // 편집: 구역 0 / 문단 0에 텍스트 삽입이 성공해야 한다
    doc.insert_text_native(0, 0, 0, "새 문서 첫 문단")
        .expect("createEmpty 문서에 insertText가 동작해야 한다 (#1386)");

    // 조회: 삽입한 텍스트가 읽혀야 한다
    let text = doc
        .get_text_range_native(0, 0, 0, 8)
        .expect("getTextRange가 동작해야 한다");
    assert!(
        text.contains("새 문서"),
        "삽입 텍스트가 조회되어야 한다: {text}"
    );

    // 내보내기: HWP/HWPX 직렬화가 모두 성공해야 한다
    let hwp = doc
        .export_hwp_with_adapter()
        .expect("createEmpty 문서 exportHwp");
    assert!(!hwp.is_empty());
    let hwpx = doc
        .export_hwpx_native()
        .expect("createEmpty 문서 exportHwpx");
    assert!(!hwpx.is_empty());

    // 재파싱: 내보낸 HWP가 다시 열리고 텍스트가 보존되어야 한다
    let reparsed =
        crate::document_core::DocumentCore::from_bytes(&hwp).expect("exportHwp 결과 재파싱");
    assert!(
        reparsed.document().sections[0]
            .paragraphs
            .iter()
            .any(|p| p.text.contains("새 문서")),
        "재파싱 문서에 삽입 텍스트가 보존되어야 한다"
    );
}

#[test]
fn test_refresh_layout_rebuilds_derived_state_without_changing_document_breaks() {
    let mut doc = HwpDocument::create_empty();
    doc.insert_text_native(0, 0, 0, "alpha beta")
        .expect("seed text");
    doc.split_paragraph_native(0, 0, 5, None)
        .expect("seed paragraphs");
    doc.apply_para_format_native(0, 1, r#"{"pageBreakBefore":true}"#)
        .expect("intentional page break");

    let before_ir: Vec<(String, u16)> = doc.document().sections[0]
        .paragraphs
        .iter()
        .map(|para| (para.text.clone(), para.para_shape_id))
        .collect();
    let before_pages = doc.page_count();
    assert!(
        before_pages >= 2,
        "the intentional break should create another page"
    );

    // 증분 경로가 어긋난 상태를 흉내 내고, IR 기반 refresh가 파생 상태만 복구하는지 본다.
    doc.composed.clear();
    doc.measured_tables.clear();
    doc.measured_sections.clear();
    doc.dirty_sections.fill(false);
    doc.dirty_paragraphs.clear();
    doc.para_column_map.clear();
    doc.pagination.clear();

    doc.refresh_layout_native();

    let after_ir: Vec<(String, u16)> = doc.document().sections[0]
        .paragraphs
        .iter()
        .map(|para| (para.text.clone(), para.para_shape_id))
        .collect();
    assert_eq!(after_ir, before_ir, "refresh must not mutate document IR");
    assert_eq!(doc.page_count(), before_pages);
    assert_eq!(doc.composed.len(), 1);
    assert_eq!(doc.composed[0].len(), 2);
    assert_eq!(doc.measured_sections.len(), 1);
    let props: Value = serde_json::from_str(
        &doc.get_para_properties_at_native(0, 1)
            .expect("paragraph properties"),
    )
    .expect("paragraph properties json");
    assert_eq!(props["pageBreakBefore"], true);
}

fn issue_1481_json_usize(json: &str, key: &str) -> usize {
    let parsed: Value = serde_json::from_str(json).expect("JSON 파싱");
    parsed[key].as_u64().expect("usize 값") as usize
}

fn issue_1481_table<'a>(doc: &'a HwpDocument, para_idx: usize) -> &'a crate::model::table::Table {
    use crate::model::control::Control;

    doc.document.sections[0].paragraphs[para_idx]
        .controls
        .iter()
        .find_map(|control| match control {
            Control::Table(table) => Some(table.as_ref()),
            _ => None,
        })
        .expect("표 컨트롤")
}

fn issue_1481_first_page_render_tree(
    doc: &HwpDocument,
) -> crate::renderer::render_tree::PageRenderTree {
    let dpi = 96.0;
    let styles = crate::renderer::style_resolver::resolve_styles(&doc.document.doc_info, dpi);
    let engine = crate::renderer::layout::LayoutEngine::new(dpi);
    let section = &doc.document.sections[0];
    let composed: Vec<_> = section
        .paragraphs
        .iter()
        .map(crate::renderer::composer::compose_paragraph)
        .collect();
    let sec_mt = doc
        .measured_tables
        .first()
        .map(|tables| tables.as_slice())
        .unwrap_or(&[]);
    let page = &doc.pagination[0].pages[0];

    engine.build_render_tree(
        page,
        &section.paragraphs,
        &section.paragraphs,
        &section.paragraphs,
        &composed,
        &styles,
        &section.section_def.footnote_shape,
        &doc.document.bin_data_content,
        None,
        sec_mt,
        Some(&section.section_def.page_border_fill),
        section.section_def.outline_numbering_id,
        &[],
    )
}

fn issue_1481_find_table_and_host_mark_y(
    node: &crate::renderer::render_tree::RenderNode,
    para_idx: usize,
    table_y: &mut Option<f64>,
    mark_y: &mut Option<f64>,
) {
    use crate::renderer::render_tree::RenderNodeType;

    match &node.node_type {
        RenderNodeType::Table(table) if table.para_index == Some(para_idx) => {
            *table_y = Some(node.bbox.y);
        }
        RenderNodeType::TextRun(run)
            if run.para_index == Some(para_idx)
                && run.cell_context.is_none()
                && run.text.is_empty()
                && run.is_para_end =>
        {
            *mark_y = Some(node.bbox.y);
        }
        _ => {}
    }

    for child in &node.children {
        issue_1481_find_table_and_host_mark_y(child, para_idx, table_y, mark_y);
    }
}

fn issue_1481_collect_outside_empty_para_marks(
    node: &crate::renderer::render_tree::RenderNode,
    marks: &mut Vec<(usize, f64)>,
) {
    use crate::renderer::render_tree::RenderNodeType;

    if let RenderNodeType::TextRun(run) = &node.node_type {
        if let Some(para_idx) = run.para_index {
            if run.cell_context.is_none() && run.text.is_empty() && run.is_para_end {
                marks.push((para_idx, node.bbox.y));
            }
        }
    }

    for child in &node.children {
        issue_1481_collect_outside_empty_para_marks(child, marks);
    }
}

fn issue_1481_collect_layer_control_mark_y(value: &Value, marks: &mut Vec<f64>) {
    match value {
        Value::Object(map) => {
            if map.get("type").and_then(Value::as_str) == Some("textControlMark")
                && map.get("isParaEnd").and_then(Value::as_bool) == Some(true)
            {
                if let Some(y) = map
                    .get("bbox")
                    .and_then(|bbox| bbox.get("y"))
                    .and_then(Value::as_f64)
                {
                    marks.push(y);
                }
            }
            for child in map.values() {
                issue_1481_collect_layer_control_mark_y(child, marks);
            }
        }
        Value::Array(items) => {
            for item in items {
                issue_1481_collect_layer_control_mark_y(item, marks);
            }
        }
        _ => {}
    }
}

fn issue_1481_layer_control_mark_y(doc: &HwpDocument) -> Vec<f64> {
    let json = doc
        .get_page_layer_tree_native(0)
        .expect("PageLayerTree JSON");
    let parsed: Value = serde_json::from_str(&json).expect("PageLayerTree JSON 파싱");
    let mut marks = Vec::new();
    issue_1481_collect_layer_control_mark_y(&parsed, &mut marks);
    marks.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    marks
}

#[test]
fn issue_1470_style_update_reflows_and_keeps_margin_unit() {
    use crate::model::style::{CharShape, ParaShape, Style};

    let mut doc = HwpDocument::create_empty();
    doc.document.doc_info.char_shapes.push(CharShape::default());
    doc.document.doc_info.para_shapes.push(ParaShape::default());
    doc.document.doc_info.styles.push(Style {
        local_name: "바탕글".to_string(),
        english_name: "Normal".to_string(),
        lang_id: 1042,
        para_shape_id: 0,
        char_shape_id: 0,
        ..Default::default()
    });
    doc.insert_text_native(0, 0, 0, "스타일 줄간격 검증")
        .expect("텍스트 입력");

    let style_id = doc.create_style(
        r#"{"name":"검증 스타일","englishName":"Issue1470","type":0,"nextStyleId":0,"baseParaShapeId":0,"baseCharShapeId":0}"#,
    );
    assert!(style_id >= 0, "스타일 생성");
    doc.apply_style_native(0, 0, style_id as usize)
        .expect("스타일 적용");

    let before_spacing = doc.document.sections[0].paragraphs[0]
        .line_segs
        .first()
        .map(|ls| ls.line_spacing)
        .unwrap_or_default();

    assert!(
        doc.update_style_shapes(
            style_id as u32,
            "{}",
            r#"{"marginLeft":3000,"lineSpacing":300,"lineSpacingType":"Percent"}"#,
        ),
        "스타일 문단 모양 수정"
    );

    let para = &doc.document.sections[0].paragraphs[0];
    let ps = &doc.document.doc_info.para_shapes[para.para_shape_id as usize];
    assert_eq!(para.style_id, style_id as u8);
    assert_eq!(
        ps.margin_left, 3000,
        "15pt raw(2x) 여백이 30pt로 중복 변환되면 안 됨"
    );
    assert_eq!(ps.line_spacing, 300);
    let after_spacing = para
        .line_segs
        .first()
        .map(|ls| ls.line_spacing)
        .unwrap_or_default();
    assert_ne!(
        after_spacing, before_spacing,
        "스타일 줄간격 변경 후 LineSeg가 즉시 재계산되어야 한다"
    );
}

#[test]
fn issue_1470_style_apply_preserves_direct_char_shape() {
    use crate::model::paragraph::CharShapeRef;
    use crate::model::style::{CharShape, ParaShape, Style};

    let mut doc = HwpDocument::create_empty();
    doc.document.doc_info.char_shapes = vec![
        CharShape {
            base_size: 1000,
            ..Default::default()
        },
        CharShape {
            base_size: 1200,
            ..Default::default()
        },
        CharShape {
            bold: true,
            ..Default::default()
        },
    ];
    doc.document.doc_info.para_shapes = vec![
        ParaShape::default(),
        ParaShape {
            margin_left: 1000,
            ..Default::default()
        },
    ];
    doc.document.doc_info.styles = vec![
        Style {
            local_name: "바탕글".to_string(),
            english_name: "Normal".to_string(),
            lang_id: 1042,
            para_shape_id: 0,
            char_shape_id: 0,
            ..Default::default()
        },
        Style {
            local_name: "새 문단 스타일".to_string(),
            english_name: "Issue1470Apply".to_string(),
            lang_id: 1042,
            para_shape_id: 1,
            char_shape_id: 1,
            ..Default::default()
        },
    ];
    doc.insert_text_native(0, 0, 0, "가나다라")
        .expect("텍스트 입력");

    let para = &mut doc.document.sections[0].paragraphs[0];
    para.style_id = 0;
    para.para_shape_id = 0;
    para.char_shapes = vec![CharShapeRef {
        start_pos: 0,
        char_shape_id: 0,
    }];
    para.apply_char_shape_range(1, 3, 2);

    doc.apply_style_native(0, 0, 1).expect("문단 스타일 적용");

    let para = &doc.document.sections[0].paragraphs[0];
    assert_eq!(para.style_id, 1);
    assert_eq!(para.para_shape_id, 1);
    let refs: Vec<(u32, u32)> = para
        .char_shapes
        .iter()
        .map(|cs| (cs.start_pos, cs.char_shape_id))
        .collect();
    assert_eq!(
        refs,
        vec![(0, 1), (1, 2), (3, 1)],
        "스타일 기본 글자 모양만 새 스타일로 바뀌고 직접 글자 모양 range는 유지되어야 한다"
    );
}

#[test]
fn issue_1470_style_update_preserves_direct_char_shape() {
    use crate::model::paragraph::CharShapeRef;
    use crate::model::style::{CharShape, ParaShape, Style};

    let mut doc = HwpDocument::create_empty();
    doc.document.doc_info.char_shapes = vec![
        CharShape {
            base_size: 1000,
            ..Default::default()
        },
        CharShape {
            base_size: 1200,
            ..Default::default()
        },
        CharShape {
            bold: true,
            ..Default::default()
        },
    ];
    doc.document.doc_info.para_shapes = vec![
        ParaShape::default(),
        ParaShape {
            margin_left: 1000,
            ..Default::default()
        },
    ];
    doc.document.doc_info.styles = vec![
        Style {
            local_name: "바탕글".to_string(),
            english_name: "Normal".to_string(),
            lang_id: 1042,
            para_shape_id: 0,
            char_shape_id: 0,
            ..Default::default()
        },
        Style {
            local_name: "편집 대상 스타일".to_string(),
            english_name: "Issue1470Update".to_string(),
            lang_id: 1042,
            para_shape_id: 1,
            char_shape_id: 1,
            ..Default::default()
        },
    ];
    doc.insert_text_native(0, 0, 0, "가나다라")
        .expect("텍스트 입력");

    let para = &mut doc.document.sections[0].paragraphs[0];
    para.style_id = 1;
    para.para_shape_id = 1;
    para.char_shapes = vec![CharShapeRef {
        start_pos: 0,
        char_shape_id: 1,
    }];
    para.apply_char_shape_range(1, 3, 2);

    assert!(
        doc.update_style_shapes(1, r#"{"fontSize":1400}"#, "{}"),
        "스타일 글자 모양 수정"
    );

    let updated_csid = doc.document.doc_info.styles[1].char_shape_id as u32;
    assert_ne!(
        updated_csid, 1,
        "스타일 CharShape가 새 ID로 갱신되어야 한다"
    );

    let para = &doc.document.sections[0].paragraphs[0];
    let refs: Vec<(u32, u32)> = para
        .char_shapes
        .iter()
        .map(|cs| (cs.start_pos, cs.char_shape_id))
        .collect();
    assert_eq!(
        refs,
        vec![(0, updated_csid), (1, 2), (3, updated_csid)],
        "스타일 편집 전파 시 직접 글자 모양 range는 유지되어야 한다"
    );
}

#[test]
fn issue_1470_character_style_does_not_replace_para_style() {
    use crate::model::paragraph::CharShapeRef;
    use crate::model::style::{CharShape, ParaShape, Style};

    let mut doc = HwpDocument::create_empty();
    doc.document.doc_info.char_shapes = vec![
        CharShape {
            base_size: 1000,
            ..Default::default()
        },
        CharShape {
            italic: true,
            ..Default::default()
        },
    ];
    doc.document.doc_info.para_shapes = vec![ParaShape::default()];
    doc.document.doc_info.styles = vec![
        Style {
            local_name: "바탕글".to_string(),
            english_name: "Normal".to_string(),
            lang_id: 1042,
            para_shape_id: 0,
            char_shape_id: 0,
            ..Default::default()
        },
        Style {
            local_name: "글자 스타일".to_string(),
            english_name: "Issue1470Char".to_string(),
            style_type: 1,
            lang_id: 1042,
            para_shape_id: 0,
            char_shape_id: 1,
            ..Default::default()
        },
    ];
    doc.insert_text_native(0, 0, 0, "글자스타일")
        .expect("텍스트 입력");

    let para = &mut doc.document.sections[0].paragraphs[0];
    para.style_id = 0;
    para.para_shape_id = 0;
    para.char_shapes = vec![CharShapeRef {
        start_pos: 0,
        char_shape_id: 0,
    }];

    doc.apply_style_native(0, 0, 1).expect("글자 스타일 적용");

    let para = &doc.document.sections[0].paragraphs[0];
    assert_eq!(
        para.style_id, 0,
        "글자 스타일은 문단 스타일 ID를 바꾸지 않는다"
    );
    assert_eq!(
        para.para_shape_id, 0,
        "글자 스타일은 문단 모양 ID를 바꾸지 않는다"
    );
    assert_eq!(
        para.char_shape_id_at(0),
        Some(1),
        "글자 스타일 CharShape는 글자 모양에 적용되어야 한다"
    );
}

#[test]
fn issue_1470_create_table_ex_applies_size_options() {
    use crate::model::control::Control;

    let mut doc = HwpDocument::create_empty();
    let col_widths = [4000, 6000];
    let row_heights = [3000, 5000];
    doc.create_table_ex_native(0, 0, 0, 2, 2, true, Some(&col_widths), Some(&row_heights))
        .expect("확장 표 생성");

    let table = doc.document.sections[0].paragraphs[0]
        .controls
        .iter()
        .find_map(|c| match c {
            Control::Table(t) => Some(t),
            _ => None,
        })
        .expect("표 컨트롤");
    assert!(
        table.common.treat_as_char,
        "상세 옵션의 글자처럼 취급이 반영되어야 한다"
    );
    assert_eq!(table.common.width, 10000);
    assert_eq!(table.common.height, 8000);
    assert_eq!(table.cells[0].width, 4000);
    assert_eq!(table.cells[1].width, 6000);
    assert_eq!(table.cells[0].height, 3000);
    assert_eq!(table.cells[2].height, 5000);
}

#[test]
fn issue_1481_create_table_keeps_first_line_mark_for_escape() {
    use crate::model::control::Control;

    let mut doc = HwpDocument::create_empty();
    let table_result = doc
        .create_table_ex_native(0, 0, 1, 3, 5, false, None, None)
        .expect("상세 대화상자 경로의 일반 표 생성");
    let table_para_idx = issue_1481_json_usize(&table_result, "paraIdx");
    let section = &doc.document.sections[0];

    assert_eq!(table_para_idx, 0, "새 문서 첫 표는 첫 줄에 만들어져야 한다");
    assert!(
        section.paragraphs.len() >= 2,
        "표 뒤 빈 문단은 유지되어야 한다"
    );
    assert!(section.paragraphs[0].text.is_empty());
    assert_eq!(section.paragraphs[0].char_count, 9);
    assert!(section.paragraphs[0].has_para_text);
    assert!(!section.paragraphs[0].line_segs.is_empty());
    assert!(matches!(
        section.paragraphs[table_para_idx].controls.first(),
        Some(Control::Table(_))
    ));
    assert!(section.paragraphs[table_para_idx + 1].text.is_empty());
    assert!(section.paragraphs[table_para_idx + 1].controls.is_empty());
    assert_eq!(section.paragraphs[table_para_idx + 1].char_count, 1);
    assert!(!section.paragraphs[table_para_idx + 1].line_segs.is_empty());

    let moved = doc
        .move_vertical(0, 0, 0, -1, 0.0, table_para_idx as u32, 0, 0, 0)
        .expect("첫 셀에서 위쪽 이동");
    let moved: Value = serde_json::from_str(&moved).expect("moveVertical JSON");
    assert_eq!(
        moved["paragraphIndex"].as_u64(),
        Some(table_para_idx as u64)
    );
    assert_eq!(moved["charOffset"].as_u64(), Some(0));
    assert!(
        moved.get("parentParaIndex").is_none(),
        "첫 셀 위쪽 이동은 같은 첫 줄의 표 밖 조판부호 위치로 나가야 한다"
    );

    let tree = issue_1481_first_page_render_tree(&doc);
    let mut table_y = None;
    let mut host_mark_y = None;
    issue_1481_find_table_and_host_mark_y(
        &tree.root,
        table_para_idx,
        &mut table_y,
        &mut host_mark_y,
    );
    let table_y = table_y.expect("표 렌더 노드 y");
    let host_mark_y = host_mark_y.expect("표 host 문단부호 y");
    assert!(
        (table_y - host_mark_y).abs() < 1.0,
        "기본 자리차지 표의 첫 조판부호는 빈 줄이 아니라 표 상단과 겹쳐야 한다: table_y={table_y}, mark_y={host_mark_y}"
    );
    doc.set_show_paragraph_marks(true);
    let layer_marks = issue_1481_layer_control_mark_y(&doc);
    let layer_marks_above_table = layer_marks
        .iter()
        .filter(|y| **y < table_y - 1.0)
        .copied()
        .collect::<Vec<_>>();
    assert!(
        layer_marks_above_table.is_empty(),
        "새 문서 빈 문단 끝에서 표를 만들 때 생성 경로가 빈 줄을 남기면 안 된다: table_y={table_y}, layer_marks_above={layer_marks_above_table:?}, all={layer_marks:?}"
    );
    doc.set_show_paragraph_marks(false);

    let mut outside_marks = Vec::new();
    issue_1481_collect_outside_empty_para_marks(&tree.root, &mut outside_marks);
    let marks_above_table = outside_marks
        .iter()
        .filter(|(_, y)| *y < table_y - 1.0)
        .copied()
        .collect::<Vec<_>>();
    assert!(
        marks_above_table.is_empty(),
        "표 생성 직후 표 위에 별도 빈 줄 조판부호가 있으면 안 된다: table_y={table_y}, marks={marks_above_table:?}, all={outside_marks:?}"
    );

    let enter_result = doc
        .split_paragraph_native(0, table_para_idx, 0, None)
        .expect("표 앞 조판부호 위치 Enter");
    let enter_para_idx = issue_1481_json_usize(&enter_result, "paraIdx");
    assert_eq!(
        enter_para_idx,
        table_para_idx + 1,
        "자리차지 표 앞 Enter는 표 아래 문단으로 커서를 보내야 한다"
    );
    let section_after_enter = &doc.document.sections[0];
    assert!(matches!(
        section_after_enter.paragraphs[table_para_idx]
            .controls
            .first(),
        Some(Control::Table(_))
    ));
    assert_eq!(
        section_after_enter.paragraphs[table_para_idx].char_count, 9,
        "Enter 후에도 표 host 문단은 빈 문단으로 분리되면 안 된다"
    );
    assert!(section_after_enter.paragraphs[enter_para_idx]
        .text
        .is_empty());
    assert!(section_after_enter.paragraphs[enter_para_idx]
        .controls
        .is_empty());
    assert_eq!(section_after_enter.paragraphs[enter_para_idx].char_count, 1);
    assert!(section_after_enter
        .paragraphs
        .get(enter_para_idx + 1)
        .map(|p| p.text.is_empty() && p.controls.is_empty())
        .unwrap_or(false));

    let tree_after_enter = issue_1481_first_page_render_tree(&doc);
    let mut table_y_after = None;
    let mut host_mark_y_after = None;
    issue_1481_find_table_and_host_mark_y(
        &tree_after_enter.root,
        table_para_idx,
        &mut table_y_after,
        &mut host_mark_y_after,
    );
    let table_y_after = table_y_after.expect("Enter 후 표 렌더 노드 y");
    let host_mark_y_after = host_mark_y_after.expect("Enter 후 표 host 문단부호 y");
    assert!(
        (table_y_after - host_mark_y_after).abs() < 1.0,
        "Enter 후에도 표 host 조판부호는 표 상단과 겹쳐야 한다: table_y={table_y_after}, mark_y={host_mark_y_after}"
    );
    let mut outside_marks_after = Vec::new();
    issue_1481_collect_outside_empty_para_marks(&tree_after_enter.root, &mut outside_marks_after);
    let marks_above_table_after = outside_marks_after
        .iter()
        .filter(|(_, y)| *y < table_y_after - 1.0)
        .copied()
        .collect::<Vec<_>>();
    assert!(
        marks_above_table_after.is_empty(),
        "Enter 후에도 표 위에 별도 빈 줄 조판부호가 있으면 안 된다: table_y={table_y_after}, marks={marks_above_table_after:?}, all={outside_marks_after:?}"
    );
}

#[test]
fn issue_1481_create_table_preserves_user_blank_line_above() {
    use crate::model::control::Control;

    let mut doc = HwpDocument::create_empty();
    doc.split_paragraph_native(0, 0, 0, None)
        .expect("사용자가 만든 빈 줄");
    let table_result = doc
        .create_table_ex_native(0, 1, 1, 3, 5, false, None, None)
        .expect("두 번째 빈 문단에 일반 표 생성");
    let table_para_idx = issue_1481_json_usize(&table_result, "paraIdx");
    let section = &doc.document.sections[0];

    assert_eq!(
        table_para_idx, 1,
        "사용자가 표 위에 만든 빈 문단은 삭제하지 않고 현재 빈 문단만 표 host로 교체해야 한다"
    );
    assert!(section.paragraphs[0].text.is_empty());
    assert!(section.paragraphs[0].controls.is_empty());
    assert_eq!(section.paragraphs[0].char_count, 1);
    assert!(matches!(
        section.paragraphs[table_para_idx].controls.first(),
        Some(Control::Table(_))
    ));
}

#[test]
fn issue_1481_create_table_empty_para_ignores_stale_offset() {
    use crate::model::control::Control;

    let mut doc = HwpDocument::create_empty();
    let table_result = doc
        .create_table_ex_native(0, 0, 2, 3, 5, false, None, None)
        .expect("빈 문단의 초과 offset에서 일반 표 생성");
    let table_para_idx = issue_1481_json_usize(&table_result, "paraIdx");
    let section = &doc.document.sections[0];

    assert_eq!(
        table_para_idx, 0,
        "빈 문단 offset이 초과되어도 표 위에 생성 경로의 빈 줄을 남기면 안 된다"
    );
    assert!(matches!(
        section.paragraphs[table_para_idx].controls.first(),
        Some(Control::Table(_))
    ));

    let tree = issue_1481_first_page_render_tree(&doc);
    let mut table_y = None;
    let mut host_mark_y = None;
    issue_1481_find_table_and_host_mark_y(
        &tree.root,
        table_para_idx,
        &mut table_y,
        &mut host_mark_y,
    );
    let table_y = table_y.expect("표 렌더 노드 y");
    let host_mark_y = host_mark_y.expect("표 host 문단부호 y");
    assert!(
        (table_y - host_mark_y).abs() < 1.0,
        "빈 문단 초과 offset에서도 첫 조판부호는 표 상단과 겹쳐야 한다: table_y={table_y}, mark_y={host_mark_y}"
    );
}

#[test]
fn issue_1481_blank_template_create_table_has_no_generated_blank_above() {
    use crate::model::control::Control;

    let mut doc = HwpDocument::create_empty();
    doc.create_blank_document_native()
        .expect("Studio 새 문서 템플릿 생성");
    let table_result = doc
        .create_table_ex_native(0, 0, 2, 3, 5, false, None, None)
        .expect("blank2010 기반 빈 문단 초과 offset에서 일반 표 생성");
    let table_para_idx = issue_1481_json_usize(&table_result, "paraIdx");
    let table_control_idx = issue_1481_json_usize(&table_result, "controlIdx");
    let section = &doc.document.sections[0];

    assert_eq!(
        table_para_idx, 0,
        "Studio 새 문서 템플릿에서도 첫 표는 첫 줄에 만들어져야 한다"
    );
    assert_eq!(
        table_control_idx, 2,
        "blank2010의 SectionDef/ColumnDef 구조 컨트롤 뒤에 표 컨트롤이 보존되어야 한다"
    );
    assert!(matches!(
        section.paragraphs[table_para_idx]
            .controls
            .get(table_control_idx),
        Some(Control::Table(_))
    ));

    let tree = issue_1481_first_page_render_tree(&doc);
    let mut table_y = None;
    let mut host_mark_y = None;
    issue_1481_find_table_and_host_mark_y(
        &tree.root,
        table_para_idx,
        &mut table_y,
        &mut host_mark_y,
    );
    let table_y = table_y.expect("표 렌더 노드 y");
    let host_mark_y = host_mark_y.expect("표 host 문단부호 y");
    assert!(
        (table_y - host_mark_y).abs() < 1.0,
        "blank2010 경로에서도 첫 조판부호는 표 상단과 겹쳐야 한다: table_y={table_y}, mark_y={host_mark_y}"
    );

    doc.set_show_paragraph_marks(true);
    let layer_marks = issue_1481_layer_control_mark_y(&doc);
    let layer_marks_above_table = layer_marks
        .iter()
        .filter(|y| **y < table_y - 1.0)
        .copied()
        .collect::<Vec<_>>();
    assert!(
        layer_marks_above_table.is_empty(),
        "blank2010 경로에서도 표 위에 생성 경로 빈 줄을 남기면 안 된다: table_y={table_y}, layer_marks_above={layer_marks_above_table:?}, all={layer_marks:?}"
    );
    doc.set_show_paragraph_marks(false);
}

#[test]
fn issue_1481_insert_column_keeps_create_table_height() {
    let mut doc = HwpDocument::create_empty();
    let table_result = doc
        .create_table_native(0, 0, 0, 3, 5)
        .expect("일반 표 생성");
    let table_para_idx = issue_1481_json_usize(&table_result, "paraIdx");

    let (original_width, original_height, original_raw_height, row_height_sum) = {
        let table = issue_1481_table(&doc, table_para_idx);
        let raw_common = parse_common_obj_attr(&table.raw_ctrl_data);
        (
            table.common.width,
            table.common.height,
            raw_common.height,
            table.get_row_heights().iter().sum::<u32>(),
        )
    };

    assert!(
        original_height > row_height_sum,
        "일반 표는 셀 저장 height 합보다 큰 외곽 height를 가진다"
    );

    doc.insert_table_column_native(0, table_para_idx, 0, 0, false)
        .expect("왼쪽 열 추가");

    let table = issue_1481_table(&doc, table_para_idx);
    let raw_common = parse_common_obj_attr(&table.raw_ctrl_data);

    assert_eq!(table.col_count, 6);
    assert!(
        table.common.width > original_width,
        "열 추가 후 표 폭은 기준 열 폭만큼 증가해야 한다"
    );
    assert_eq!(
        table.common.height, original_height,
        "열 추가는 행 수를 바꾸지 않으므로 표 외곽 height를 보존해야 한다"
    );
    assert_eq!(
        raw_common.height, original_raw_height,
        "직렬화 원본 raw height도 표 외곽 height와 함께 보존해야 한다"
    );
    assert_eq!(
        raw_common.height, table.common.height,
        "raw height와 in-memory common height는 동기화되어야 한다"
    );
}

#[test]
fn issue_1481_insert_row_keeps_create_table_display_height() {
    let mut doc = HwpDocument::create_empty();
    let table_result = doc
        .create_table_native(0, 0, 0, 3, 5)
        .expect("일반 표 생성");
    let table_para_idx = issue_1481_json_usize(&table_result, "paraIdx");

    let (original_height, original_raw_height, original_row_height_sum) = {
        let table = issue_1481_table(&doc, table_para_idx);
        let raw_common = parse_common_obj_attr(&table.raw_ctrl_data);
        (
            table.common.height,
            raw_common.height,
            table.get_row_heights().iter().sum::<u32>(),
        )
    };

    assert!(
        original_height > original_row_height_sum,
        "일반 표는 셀 저장 height 합보다 큰 외곽 height를 가진다"
    );

    doc.insert_table_row_native(0, table_para_idx, 0, 0, false)
        .expect("위쪽 줄 추가");

    let table = issue_1481_table(&doc, table_para_idx);
    let raw_common = parse_common_obj_attr(&table.raw_ctrl_data);
    let expected_height = original_height + (original_height / 3);

    assert_eq!(table.row_count, 4);
    assert_eq!(
        table.common.height, expected_height,
        "줄 추가는 한 행의 표시 높이만큼 표 외곽 height를 늘려야 한다"
    );
    assert!(
        table.common.height > original_raw_height,
        "줄 추가 후 표 높이는 기존 외곽 height보다 커야 한다"
    );
    assert_eq!(
        raw_common.height, table.common.height,
        "raw height와 in-memory common height는 동기화되어야 한다"
    );
}

#[test]
fn issue_1481_delete_row_keeps_create_table_display_height() {
    let mut doc = HwpDocument::create_empty();
    let table_result = doc
        .create_table_native(0, 0, 0, 3, 5)
        .expect("일반 표 생성");
    let table_para_idx = issue_1481_json_usize(&table_result, "paraIdx");

    let (original_height, original_row_height_sum) = {
        let table = issue_1481_table(&doc, table_para_idx);
        (
            table.common.height,
            table.get_row_heights().iter().sum::<u32>(),
        )
    };

    assert!(
        original_height > original_row_height_sum,
        "일반 표는 셀 저장 height 합보다 큰 외곽 height를 가진다"
    );

    doc.delete_table_row_native(0, table_para_idx, 0, 0)
        .expect("줄 지우기");

    let table = issue_1481_table(&doc, table_para_idx);
    let raw_common = parse_common_obj_attr(&table.raw_ctrl_data);
    let expected_height = original_height - (original_height / 3);

    assert_eq!(table.row_count, 2);
    assert_eq!(
        table.common.height, expected_height,
        "줄 삭제는 삭제 행의 표시 높이만큼 표 외곽 height를 줄여야 한다"
    );
    assert!(
        table.common.height > table.get_row_heights().iter().sum::<u32>(),
        "삭제 후에도 일반 표의 표시 height가 셀 저장 height 합으로 붕괴하면 안 된다"
    );
    assert_eq!(
        raw_common.height, table.common.height,
        "raw height와 in-memory common height는 동기화되어야 한다"
    );
}

#[test]
fn issue_1481_delete_column_keeps_create_table_height() {
    let mut doc = HwpDocument::create_empty();
    let table_result = doc
        .create_table_native(0, 0, 0, 3, 5)
        .expect("일반 표 생성");
    let table_para_idx = issue_1481_json_usize(&table_result, "paraIdx");

    let (original_width, original_height, original_raw_height, row_height_sum) = {
        let table = issue_1481_table(&doc, table_para_idx);
        let raw_common = parse_common_obj_attr(&table.raw_ctrl_data);
        (
            table.common.width,
            table.common.height,
            raw_common.height,
            table.get_row_heights().iter().sum::<u32>(),
        )
    };

    assert!(
        original_height > row_height_sum,
        "일반 표는 셀 저장 height 합보다 큰 외곽 height를 가진다"
    );

    doc.delete_table_column_native(0, table_para_idx, 0, 0)
        .expect("칸 지우기");

    let table = issue_1481_table(&doc, table_para_idx);
    let raw_common = parse_common_obj_attr(&table.raw_ctrl_data);

    assert_eq!(table.col_count, 4);
    assert!(
        table.common.width < original_width,
        "열 삭제 후 표 폭은 삭제 열 폭만큼 줄어야 한다"
    );
    assert_eq!(
        table.common.height, original_height,
        "열 삭제는 행 수를 바꾸지 않으므로 표 외곽 height를 보존해야 한다"
    );
    assert_eq!(
        raw_common.height, original_raw_height,
        "직렬화 원본 raw height도 표 외곽 height와 함께 보존해야 한다"
    );
    assert_eq!(
        raw_common.height, table.common.height,
        "raw height와 in-memory common height는 동기화되어야 한다"
    );
}

#[test]
fn issue_1481_resize_bottom_row_keeps_create_table_display_height() {
    let mut doc = HwpDocument::create_empty();
    let table_result = doc
        .create_table_native(0, 0, 0, 3, 5)
        .expect("일반 표 생성");
    let table_para_idx = issue_1481_json_usize(&table_result, "paraIdx");

    let (original_height, original_raw_height, original_row_height_sum, last_row_cells) = {
        let table = issue_1481_table(&doc, table_para_idx);
        let raw_common = parse_common_obj_attr(&table.raw_ctrl_data);
        let last_row = table.row_count - 1;
        (
            table.common.height,
            raw_common.height,
            table.get_row_heights().iter().sum::<u32>(),
            table
                .cells
                .iter()
                .enumerate()
                .filter_map(|(idx, cell)| (cell.row == last_row).then_some(idx))
                .collect::<Vec<_>>(),
        )
    };

    assert!(
        original_height > original_row_height_sum,
        "일반 표는 셀 저장 height 합보다 큰 외곽 height를 가진다"
    );
    assert_eq!(original_height, original_raw_height);
    assert_eq!(last_row_cells.len(), 5);

    let updates = last_row_cells
        .iter()
        .map(|cell_idx| format!(r#"{{"cellIdx":{},"heightDelta":300}}"#, cell_idx))
        .collect::<Vec<_>>()
        .join(",");
    doc.resize_table_cells_native(0, table_para_idx, 0, &format!("[{}]", updates))
        .expect("하단 행 resize");

    let table = issue_1481_table(&doc, table_para_idx);
    let raw_common = parse_common_obj_attr(&table.raw_ctrl_data);
    let row_height_sum = table.get_row_heights().iter().sum::<u32>();

    assert_eq!(
        table.common.height,
        original_height + 300,
        "하단선 resize는 기존 표시 height에 실제 행 높이 변화량만 반영해야 한다"
    );
    assert!(
        table.common.height > row_height_sum,
        "resize 후에도 생성 직후 표의 표시 height가 셀 저장 height 합으로 붕괴하면 안 된다"
    );
    assert_eq!(
        raw_common.height, table.common.height,
        "raw height와 in-memory common height는 동기화되어야 한다"
    );
}

fn issue_1470_count_rendered_tables(
    doc: &HwpDocument,
    para_idx: usize,
    control_idx: usize,
) -> usize {
    let layout = doc
        .get_page_control_layout_native(0)
        .expect("페이지 컨트롤 레이아웃");
    let parsed: Value = serde_json::from_str(&layout).expect("레이아웃 JSON");
    parsed["controls"]
        .as_array()
        .expect("controls 배열")
        .iter()
        .filter(|control| {
            control["type"] == "table"
                && control["paraIdx"].as_u64() == Some(para_idx as u64)
                && control["controlIdx"].as_u64() == Some(control_idx as u64)
        })
        .count()
}

fn issue_1470_table_caption_number(doc: &HwpDocument, control_idx: usize) -> Option<(u16, u16)> {
    use crate::model::control::Control;

    let table = match doc.document.sections[0].paragraphs[0]
        .controls
        .get(control_idx)?
    {
        Control::Table(t) => t,
        _ => return None,
    };
    table
        .caption
        .as_ref()?
        .paragraphs
        .first()?
        .controls
        .iter()
        .find_map(|c| match c {
            Control::AutoNumber(an) => Some((an.assigned_number, an.number)),
            _ => None,
        })
}

fn issue_1470_picture_caption_number(doc: &HwpDocument, control_idx: usize) -> Option<(u16, u16)> {
    use crate::model::control::Control;

    let picture = match doc.document.sections[0].paragraphs[0]
        .controls
        .get(control_idx)?
    {
        Control::Picture(p) => p,
        _ => return None,
    };
    picture
        .caption
        .as_ref()?
        .paragraphs
        .first()?
        .controls
        .iter()
        .find_map(|c| match c {
            Control::AutoNumber(an) => Some((an.assigned_number, an.number)),
            _ => None,
        })
}

#[test]
fn issue_1470_create_table_ex_tac_renders_once() {
    let mut doc = HwpDocument::create_empty();
    doc.insert_text_native(0, 0, 0, "본문 앞")
        .expect("본문 텍스트 입력");
    let insert_at = doc
        .get_paragraph_length_native(0, 0)
        .expect("문단 길이 조회");
    let created = doc
        .create_table_ex_native(
            0,
            0,
            insert_at,
            2,
            2,
            true,
            Some(&[4000, 6000]),
            Some(&[3000, 5000]),
        )
        .expect("TAC 표 생성");
    let created: Value = serde_json::from_str(&created).expect("생성 결과 JSON");
    let control_idx = created["controlIdx"].as_u64().expect("controlIdx") as usize;

    assert_eq!(
        issue_1470_count_rendered_tables(&doc, 0, control_idx),
        1,
        "문단 레이아웃에서 이미 그린 TAC 표를 PageItem 경로가 다시 그리면 안 된다"
    );
}

#[test]
fn issue_1470_create_table_ex_tac_caption_renders_once() {
    let mut doc = HwpDocument::create_empty();
    doc.insert_text_native(0, 0, 0, "캡션 표")
        .expect("본문 텍스트 입력");
    let insert_at = doc
        .get_paragraph_length_native(0, 0)
        .expect("문단 길이 조회");
    let created = doc
        .create_table_ex_native(0, 0, insert_at, 1, 1, true, None, None)
        .expect("TAC 표 생성");
    let created: Value = serde_json::from_str(&created).expect("생성 결과 JSON");
    let control_idx = created["controlIdx"].as_u64().expect("controlIdx") as usize;
    doc.set_table_properties_native(0, 0, control_idx, r#"{"hasCaption":true}"#)
        .expect("캡션 생성");

    assert_eq!(
        issue_1470_count_rendered_tables(&doc, 0, control_idx),
        1,
        "캡션이 있는 TAC 표도 같은 컨트롤이 한 번만 렌더되어야 한다"
    );
}

#[test]
fn issue_1470_picture_caption_can_be_removed_and_renumbers() {
    use crate::model::control::Control;

    fn minimal_png() -> Vec<u8> {
        vec![
            0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48,
            0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00,
            0x00, 0x1F, 0x15, 0xC4, 0x89, 0x00, 0x00, 0x00, 0x0A, 0x49, 0x44, 0x41, 0x54, 0x78,
            0x9C, 0x63, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0D, 0x0A, 0x00, 0x00, 0x00,
            0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
        ]
    }

    let mut doc = HwpDocument::create_empty();
    let image = minimal_png();
    let first = doc
        .insert_picture_native(
            0,
            0,
            0,
            &[],
            &image,
            5000,
            5000,
            1,
            1,
            "png",
            "first",
            None,
            None,
        )
        .expect("첫 번째 그림 삽입");
    let first_idx = issue_1481_json_usize(&first, "controlIdx");
    let second = doc
        .insert_picture_native(
            0,
            0,
            0,
            &[],
            &image,
            5000,
            5000,
            1,
            1,
            "png",
            "second",
            None,
            None,
        )
        .expect("두 번째 그림 삽입");
    let second_idx = issue_1481_json_usize(&second, "controlIdx");

    for control_idx in [first_idx, second_idx] {
        doc.set_picture_properties_native(0, 0, control_idx, r#"{"hasCaption":true}"#)
            .expect("그림 캡션 생성");
    }

    assert_eq!(
        issue_1470_picture_caption_number(&doc, first_idx),
        Some((1, 1))
    );
    assert_eq!(
        issue_1470_picture_caption_number(&doc, second_idx),
        Some((2, 2))
    );

    doc.set_picture_properties_native(0, 0, first_idx, r#"{"hasCaption":false}"#)
        .expect("그림 캡션 삭제");

    let first_picture = match &doc.document.sections[0].paragraphs[0].controls[first_idx] {
        Control::Picture(p) => p,
        other => panic!("첫 번째 컨트롤이 그림이 아님: {other:?}"),
    };
    assert!(
        first_picture.caption.is_none(),
        "hasCaption=false는 그림 캡션 슬롯을 삭제해야 한다"
    );
    assert_eq!(
        first_picture.common.attr & (1 << 29),
        0,
        "그림 캡션 attr bit도 내려야 한다"
    );
    let props: Value = serde_json::from_str(
        &doc.get_picture_properties_native(0, 0, first_idx)
            .expect("그림 속성 조회"),
    )
    .expect("그림 속성 JSON");
    assert_eq!(
        props["hasCaption"], false,
        "그림 속성창의 중앙 캡션 없음 선택은 hasCaption=false로 되돌아와야 한다"
    );
    assert_eq!(
        issue_1470_picture_caption_number(&doc, second_idx),
        Some((1, 1)),
        "앞 그림 캡션 삭제 후 뒤 그림 캡션 번호가 1로 재배정되어야 한다"
    );
}

#[test]
fn issue_1470_picture_caption_path_cursor_and_control_paste() {
    use crate::model::control::Control;

    fn minimal_png() -> Vec<u8> {
        vec![
            0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48,
            0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00,
            0x00, 0x1F, 0x15, 0xC4, 0x89, 0x00, 0x00, 0x00, 0x0A, 0x49, 0x44, 0x41, 0x54, 0x78,
            0x9C, 0x63, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0D, 0x0A, 0x00, 0x00, 0x00,
            0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
        ]
    }

    let mut doc = HwpDocument::create_empty();
    let image = minimal_png();
    let inserted = doc
        .insert_picture_native(
            0,
            0,
            0,
            &[],
            &image,
            5000,
            5000,
            1,
            1,
            "png",
            "caption-path",
            None,
            None,
        )
        .expect("그림 삽입");
    let pic_idx = issue_1481_json_usize(&inserted, "controlIdx");
    doc.set_picture_properties_native(0, 0, pic_idx, r#"{"hasCaption":true}"#)
        .expect("그림 캡션 생성");

    let path = [(pic_idx, 0usize, 0usize)];
    let path_json = format!(
        r#"[{{"controlIndex":{},"cellIndex":0,"cellParaIndex":0}}]"#,
        pic_idx
    );
    let rect = doc.get_cursor_rect_by_path_native(0, 0, &path_json, 0);
    assert!(
        rect.is_ok(),
        "그림 캡션 cellPath도 커서 좌표를 찾아야 한다: {:?}",
        rect.err()
    );

    doc.copy_control_native(0, 0, &[], pic_idx)
        .expect("그림 개체 복사");
    let pasted = doc.paste_internal_in_cell_by_path_native(0, 0, &path, 0);
    assert!(
        pasted.is_ok(),
        "그림 캡션 위치에도 내부 그림 클립보드를 붙여넣을 수 있어야 한다: {:?}",
        pasted.err()
    );
    let picture = match &doc.document.sections[0].paragraphs[0].controls[pic_idx] {
        Control::Picture(p) => p,
        other => panic!("그림 컨트롤이 아님: {other:?}"),
    };
    let caption = picture.caption.as_ref().expect("그림 캡션 존재");
    assert!(
        caption.paragraphs[0]
            .controls
            .iter()
            .any(|control| matches!(control, Control::Picture(_))),
        "그림 caption path 붙여넣기는 캡션 문단 안에 그림 컨트롤을 보존해야 한다"
    );
}

#[test]
fn issue_1470_table_caption_keeps_autonumber_and_can_be_removed() {
    use crate::model::control::Control;

    let mut doc = HwpDocument::create_empty();
    doc.create_table_ex_native(0, 0, 0, 1, 1, true, None, None)
        .expect("표 생성");

    doc.set_table_properties_native(0, 0, 0, r#"{"hasCaption":true}"#)
        .expect("캡션 생성");
    let table = match &doc.document.sections[0].paragraphs[0].controls[0] {
        Control::Table(t) => t,
        other => panic!("표가 아님: {other:?}"),
    };
    let caption = table.caption.as_ref().expect("캡션 존재");
    let cap_para = caption.paragraphs.first().expect("캡션 문단");
    assert_eq!(cap_para.text, "표  ");
    assert_eq!(cap_para.char_count, 13);
    assert_eq!(cap_para.char_offsets, vec![0, 1, 2, 11]);
    assert!(
        cap_para
            .controls
            .iter()
            .any(|c| matches!(c, Control::AutoNumber(_))),
        "표 캡션 번호는 literal 텍스트가 아니라 AutoNumber 컨트롤로 유지되어야 한다"
    );

    doc.set_table_properties_native(0, 0, 0, r#"{"hasCaption":false}"#)
        .expect("캡션 삭제");
    let table = match &doc.document.sections[0].paragraphs[0].controls[0] {
        Control::Table(t) => t,
        other => panic!("표가 아님: {other:?}"),
    };
    assert!(
        table.caption.is_none(),
        "hasCaption=false가 기존 캡션을 삭제해야 한다"
    );
    assert_eq!(table.attr & (1 << 29), 0, "캡션 attr bit도 내려야 한다");
}

#[test]
fn issue_1470_table_caption_renumbers_after_delete() {
    let mut doc = HwpDocument::create_empty();
    for _ in 0..3 {
        doc.create_table_ex_native(0, 0, 0, 1, 1, true, None, None)
            .expect("표 생성");
    }
    for control_idx in 0..3 {
        doc.set_table_properties_native(0, 0, control_idx, r#"{"hasCaption":true}"#)
            .expect("캡션 생성");
    }

    assert_eq!(issue_1470_table_caption_number(&doc, 0), Some((1, 1)));
    assert_eq!(issue_1470_table_caption_number(&doc, 1), Some((2, 2)));
    assert_eq!(issue_1470_table_caption_number(&doc, 2), Some((3, 3)));

    doc.set_table_properties_native(0, 0, 1, r#"{"hasCaption":false}"#)
        .expect("중간 캡션 삭제");
    doc.set_table_properties_native(
        0,
        0,
        2,
        r#"{"captionDirection":0,"captionVertAlign":1,"captionWidth":2400,"captionSpacing":600}"#,
    )
    .expect("뒤 캡션 속성 수정");

    assert_eq!(
        issue_1470_table_caption_number(&doc, 0),
        Some((1, 1)),
        "앞 표 캡션 번호는 1을 유지해야 한다"
    );
    assert_eq!(
        issue_1470_table_caption_number(&doc, 1),
        None,
        "삭제한 중간 표 캡션은 없어야 한다"
    );
    assert_eq!(
        issue_1470_table_caption_number(&doc, 2),
        Some((2, 2)),
        "중간 캡션 삭제 후 뒤 표 캡션의 assigned_number/number가 2로 재배정되어야 한다"
    );

    let svg = doc.render_page_svg_native(0).expect("SVG 렌더링");
    assert!(
        svg.contains(">표<") && svg.contains(">1<") && svg.contains(">2<") && !svg.contains(">3<"),
        "렌더링 결과도 중간 캡션 삭제 후 표 1, 표 2만 표시해야 한다"
    );
}

#[test]
fn issue_1470_table_caption_edit_keeps_autonumber() {
    use crate::model::control::Control;
    use crate::model::shape::{CaptionDirection, CaptionVertAlign};

    let mut doc = HwpDocument::create_empty();
    doc.create_table_ex_native(0, 0, 0, 1, 1, true, None, None)
        .expect("표 생성");
    doc.set_table_properties_native(0, 0, 0, r#"{"hasCaption":true}"#)
        .expect("캡션 생성");

    doc.set_table_properties_native(
        0,
        0,
        0,
        r#"{"captionDirection":0,"captionVertAlign":1,"captionWidth":2400,"captionSpacing":600}"#,
    )
    .expect("캡션 속성 수정");

    let table = match &doc.document.sections[0].paragraphs[0].controls[0] {
        Control::Table(t) => t,
        other => panic!("표가 아님: {other:?}"),
    };
    let caption = table.caption.as_ref().expect("캡션 존재");
    assert_eq!(caption.direction, CaptionDirection::Left);
    assert_eq!(caption.vert_align, CaptionVertAlign::Center);
    assert_eq!(caption.width, 2400);
    assert_eq!(caption.spacing, 600);

    let cap_para = caption.paragraphs.first().expect("캡션 문단");
    assert_eq!(cap_para.text, "표  ");
    assert_eq!(cap_para.char_offsets, vec![0, 1, 2, 11]);
    assert!(
        cap_para.controls.iter().any(
            |c| matches!(c, Control::AutoNumber(an) if an.assigned_number == 1 && an.number == 1)
        ),
        "캡션 속성 수정 후에도 AutoNumber 컨트롤과 번호가 유지되어야 한다"
    );
}

#[test]
fn test_empty_document_info() {
    let doc = HwpDocument::create_empty();
    let info = doc.get_document_info();
    assert!(info.contains("\"pageCount\":1"));
    assert!(info.contains("\"encrypted\":false"));
}

#[test]
fn test_render_empty_page_svg() {
    let doc = HwpDocument::create_empty();
    let svg = doc.render_page_svg_native(0);
    assert!(svg.is_ok());
    let svg = svg.unwrap();
    assert!(svg.contains("<svg"));
    assert!(svg.contains("</svg>"));
}

#[test]
fn test_render_empty_page_html() {
    let doc = HwpDocument::create_empty();
    let html = doc.render_page_html_native(0);
    assert!(html.is_ok());
    let html = html.unwrap();
    assert!(html.contains("hwp-page"));
}

#[test]
fn test_page_out_of_range() {
    let doc = HwpDocument::create_empty();
    let result = doc.render_page_svg_native(999);
    assert!(result.is_err());
    match result.unwrap_err() {
        HwpError::PageOutOfRange(n) => assert_eq!(n, 999),
        _ => panic!("Expected PageOutOfRange error"),
    }
}

#[test]
fn test_page_layer_tree_export_uses_schema_contract() {
    let doc = HwpDocument::create_empty();
    let json = doc
        .get_page_layer_tree_native(0)
        .expect("empty document layer tree should export");
    let parsed: Value = serde_json::from_str(&json).expect("PageLayerTree JSON");

    assert_eq!(
        parsed["schemaVersion"].as_u64(),
        Some(LAYER_TREE_SCHEMA.schema_version as u64)
    );
    assert_eq!(
        parsed["resourceTableVersion"].as_u64(),
        Some(LAYER_TREE_SCHEMA.resource_table_version as u64)
    );
    assert_eq!(parsed["unit"].as_str(), Some(LAYER_TREE_SCHEMA.unit));
    assert_eq!(
        parsed["coordinateSystem"].as_str(),
        Some(LAYER_TREE_SCHEMA.coordinate_system)
    );
    assert_eq!(parsed["profile"].as_str(), Some("screen"));
    assert!(parsed["buildOptions"].is_object());
    assert!(parsed["debugOptions"].is_object());
    assert!(parsed["outputOptions"].is_object());
}

#[test]
fn test_page_layer_tree_export_uses_requested_profile() {
    let doc = HwpDocument::create_empty();
    for (profile, expected) in [
        (RenderProfile::FastPreview, "fastPreview"),
        (RenderProfile::Screen, "screen"),
        (RenderProfile::Print, "print"),
        (RenderProfile::HighQuality, "highQuality"),
    ] {
        let json = doc
            .get_page_layer_tree_with_profile_native(0, profile)
            .expect("profiled layer tree should export");
        let parsed: Value = serde_json::from_str(&json).expect("PageLayerTree JSON");
        assert_eq!(parsed["profile"].as_str(), Some(expected));
    }
}

#[test]
fn test_page_layer_tree_export_preserves_output_options() {
    let mut doc = HwpDocument::create_empty();
    doc.set_show_paragraph_marks(true);
    doc.set_show_control_codes(true);
    doc.set_show_transparent_borders(true);
    doc.set_clip_enabled(false);
    doc.set_debug_overlay(true);

    let json = doc
        .get_page_layer_tree_native(0)
        .expect("layer tree should export output options");
    let parsed: Value = serde_json::from_str(&json).expect("PageLayerTree JSON");

    assert_eq!(
        parsed["buildOptions"]["showTransparentBorders"].as_bool(),
        Some(true)
    );
    assert_eq!(parsed["buildOptions"]["clipEnabled"].as_bool(), Some(false));
    assert_eq!(parsed["debugOptions"]["debugOverlay"].as_bool(), Some(true));
    assert_eq!(
        parsed["outputOptions"]["showParagraphMarks"].as_bool(),
        Some(true)
    );
    assert_eq!(
        parsed["outputOptions"]["showControlCodes"].as_bool(),
        Some(true)
    );
    assert_eq!(
        parsed["outputOptions"]["showTransparentBorders"].as_bool(),
        Some(true)
    );
    assert_eq!(
        parsed["outputOptions"]["clipEnabled"].as_bool(),
        Some(false)
    );
    assert_eq!(
        parsed["outputOptions"]["debugOverlay"].as_bool(),
        Some(true)
    );
}

#[test]
fn test_canvaskit_replay_plan_export_uses_mode_policy() {
    let doc = HwpDocument::create_empty();

    let default_json = doc
        .get_canvaskit_replay_plan_native(0, "default")
        .expect("empty document CanvasKit plan should export");
    assert!(default_json.contains("\"mode\":\"default\""));
    assert!(default_json.contains("\"hiddenCanvas2dOverlayAllowed\":false"));
    assert!(default_json.contains("\"directReplayRequired\":true"));
    assert!(default_json.contains("\"requiredFontFamilies\""));
    assert!(default_json.contains("\"requiredFontFamiliesComplete\":true"));

    let compat_json = doc
        .get_canvaskit_replay_plan_native(0, "compat")
        .expect("compat CanvasKit plan should export");
    assert!(compat_json.contains("\"mode\":\"compat\""));
    assert!(compat_json.contains("\"hiddenCanvas2dOverlayAllowed\":false"));
    assert!(compat_json.contains("\"directReplayRequired\":true"));

    let invalid = doc.get_canvaskit_replay_plan_native(0, "canvas2d");
    let error = invalid.expect_err("unsupported CanvasKit replay mode should fail");
    let message = error.to_string();
    assert!(message.contains("canvas2d"));
    assert!(message.contains("allowed modes: default, compat"));
}

#[test]
fn test_empty_document_canvaskit_preflight_api_schema() {
    let doc = HwpDocument::create_empty();

    let json = doc
        .get_canvaskit_document_preflight("default", "screen")
        .expect("empty document CanvasKit preflight should export");
    let parsed: Value = serde_json::from_str(&json).expect("CanvasKit preflight JSON");

    assert_eq!(parsed["schemaVersion"].as_u64(), Some(1));
    assert_eq!(parsed["mode"].as_str(), Some("default"));
    assert_eq!(parsed["profile"].as_str(), Some("screen"));
    assert!(matches!(
        parsed["status"].as_str(),
        Some("eligible" | "ineligible" | "incomplete")
    ));
    assert!(parsed["eligible"].is_boolean());
    assert!(parsed["complete"].is_boolean());
    assert_eq!(parsed["pageCount"].as_u64(), Some(1));
    assert!(parsed["scannedPages"].is_u64());
    assert!(parsed["scannedWorkUnits"].is_u64());
    assert_eq!(parsed["limits"]["maxPages"].as_u64(), Some(128));
    assert_eq!(parsed["limits"]["maxWorkUnits"].as_u64(), Some(50_000));
    assert_eq!(parsed["limits"]["maxBlockers"].as_u64(), Some(32));
    assert_eq!(
        parsed["limits"]["maxRequiredFontFamilies"].as_u64(),
        Some(256)
    );
    assert!(parsed["summary"]["totalItems"].is_u64());
    assert!(parsed["blockers"].is_array());
    assert!(parsed["requiredFontFamilies"].is_array());
    assert!(parsed["capabilityDigest"]
        .as_str()
        .is_some_and(|digest| digest.len() == 71 && digest.starts_with("blake3:")));
    assert!(parsed.get("root").is_none());
    assert!(parsed.get("resources").is_none());
}

#[test]
fn test_normalize_canvas_scale_rejects_invalid_page_dimensions() {
    for (width, height) in [
        (0.0, 100.0),
        (100.0, 0.0),
        (-1.0, 100.0),
        (100.0, -1.0),
        (f64::NAN, 100.0),
        (100.0, f64::NAN),
        (f64::INFINITY, 100.0),
        (100.0, f64::INFINITY),
    ] {
        assert!(
            normalize_canvas_scale(width, height, 1.0).is_err(),
            "invalid page dimensions must fail: {width} x {height}"
        );
    }
}

#[test]
fn test_normalize_canvas_scale_clamps_request_and_canvas_extent() {
    assert_eq!(normalize_canvas_scale(100.0, 100.0, 0.0), Ok(1.0));
    assert_eq!(normalize_canvas_scale(100.0, 100.0, f64::NAN), Ok(1.0));
    assert_eq!(normalize_canvas_scale(100.0, 100.0, f64::INFINITY), Ok(1.0));
    assert_eq!(normalize_canvas_scale(100.0, 100.0, 0.1), Ok(0.25));
    assert_eq!(normalize_canvas_scale(100.0, 100.0, 20.0), Ok(12.0));

    let scale = normalize_canvas_scale(20_000.0, 10_000.0, 1.0)
        .expect("large finite page should be scaled down");
    assert!((scale - (16_384.0 / 20_000.0)).abs() < f64::EPSILON);
}

#[test]
fn test_canvas_region_snaps_to_device_pixels_inside_scaled_page() {
    assert_eq!(normalize_region_scale(f64::NAN), 1.0);
    assert_eq!(normalize_region_scale(0.1), 0.25);
    assert_eq!(normalize_region_scale(15.0), 12.0);

    // 쪽 전체 canvas 가 16384px 한도로 배율을 줄이는 크기여도 영역 렌더는 요청 배율을 쓴다.
    assert_eq!(normalize_region_scale(10.0), 10.0);

    // 원점은 정수 장치 픽셀로 반올림하고, 쪽 전체 canvas 와 같이 배율 적용 쪽 크기를 버린 범위로 자른다.
    let page = (794.0, 1123.0);
    assert_eq!(
        clip_canvas_region(page.0, page.1, 6.0, (100.4, 200.6, 640.0, 480.0)),
        Ok(CanvasRegion {
            x: 100,
            y: 201,
            width: 640,
            height: 480,
        })
    );
    assert_eq!(
        clip_canvas_region(page.0, page.1, 6.0, (-50.0, 6_500.0, 5_000.0, 900.0)),
        Ok(CanvasRegion {
            x: 0,
            y: 6_500,
            width: 4_764,
            height: 238,
        })
    );

    // 한 변 16384px 한도와 빈 영역·잘못된 입력.
    let wide = clip_canvas_region(4_000.0, 100.0, 12.0, (0.0, 0.0, 48_000.0, 10.0)).unwrap();
    assert_eq!(wide.width, 16_384);
    assert!(clip_canvas_region(page.0, page.1, 2.0, (2_000.0, 0.0, 10.0, 10.0)).is_err());
    assert!(clip_canvas_region(page.0, page.1, 2.0, (0.0, 0.0, f64::NAN, 10.0)).is_err());
    assert!(clip_canvas_region(0.0, page.1, 2.0, (0.0, 0.0, 10.0, 10.0)).is_err());
}

#[test]
fn test_document_with_paragraphs() {
    use crate::model::document::SectionDef;
    use crate::model::page::PageDef;

    let mut doc = HwpDocument::create_empty();
    let mut document = Document::default();

    // A4 크기 페이지 정의 (단위: HwpUnit, 1pt = 100)
    let page_def = PageDef {
        width: 59528,  // A4 가로 (약 210mm)
        height: 84188, // A4 세로 (약 297mm)
        margin_left: 8504,
        margin_right: 8504,
        margin_top: 5669,
        margin_bottom: 4252,
        margin_header: 4252,
        margin_footer: 4252,
        ..Default::default()
    };

    document.sections.push(Section {
        section_def: SectionDef {
            page_def,
            ..Default::default()
        },
        paragraphs: vec![
            Paragraph {
                text: "첫 번째 문단".to_string(),
                line_segs: vec![LineSeg {
                    line_height: 400,
                    baseline_distance: 320,
                    ..Default::default()
                }],
                ..Default::default()
            },
            Paragraph {
                text: "두 번째 문단".to_string(),
                line_segs: vec![LineSeg {
                    line_height: 400,
                    baseline_distance: 320,
                    ..Default::default()
                }],
                ..Default::default()
            },
        ],
        raw_stream: None,
        raw_provenance: None,
    });
    doc.set_document(document);

    assert_eq!(doc.page_count(), 1);
    let svg = doc.render_page_svg_native(0).unwrap();
    // 문자별 개별 렌더링이므로 개별 문자 존재 확인
    assert!(svg.contains(">첫</text>"));
    assert!(svg.contains(">문</text>"));
    assert!(svg.contains(">단</text>"));
}

#[test]
fn test_set_dpi() {
    let mut doc = HwpDocument::create_empty();
    doc.set_dpi(72.0);
    assert!((doc.get_dpi() - 72.0).abs() < 0.01);
}

#[test]
fn test_fallback_font() {
    let mut doc = HwpDocument::create_empty();
    assert_eq!(doc.get_fallback_font(), DEFAULT_FALLBACK_FONT);
    doc.set_fallback_font("/custom/font.ttf");
    assert_eq!(doc.get_fallback_font(), "/custom/font.ttf");
}

#[test]
fn test_viewer_creation() {
    let doc = HwpDocument::create_empty();
    let viewer = HwpViewer::new(doc);
    assert_eq!(viewer.page_count(), 1);
    assert_eq!(viewer.pending_task_count(), 0);
}

#[test]
fn test_viewer_viewport_update() {
    let doc = HwpDocument::create_empty();
    let mut viewer = HwpViewer::new(doc);
    viewer.update_viewport(0.0, 0.0, 800.0, 600.0);
    let visible = viewer.visible_pages();
    assert!(!visible.is_empty());
}

#[test]
fn test_export_hwp_empty() {
    let doc = HwpDocument::create_empty();
    let bytes = doc.export_hwp_native();
    assert!(bytes.is_ok());
    let bytes = bytes.unwrap();
    // CFB 시그니처 확인
    assert!(bytes.len() > 512);
    assert_eq!(&bytes[0..4], &[0xD0, 0xCF, 0x11, 0xE0]);
}

#[test]
fn test_hwp_error_display() {
    let err = HwpError::InvalidFile("테스트".to_string());
    assert!(err.to_string().contains("테스트"));
    let err = HwpError::PageOutOfRange(5);
    assert!(err.to_string().contains("5"));
}

/// 텍스트의 UTF-16 char_offsets를 생성한다.
fn make_char_offsets(text: &str) -> Vec<u32> {
    let mut offsets = Vec::new();
    let mut pos: u32 = 0;
    for c in text.chars() {
        offsets.push(pos);
        pos += if (c as u32) > 0xFFFF { 2 } else { 1 };
    }
    offsets
}

/// 표 셀이 포함된 테스트 문서를 생성한다.
fn create_doc_with_table() -> HwpDocument {
    use crate::model::control::Control;
    use crate::model::document::SectionDef;
    use crate::model::page::PageDef;
    use crate::model::table::{Cell, Table};
    use crate::model::Padding;

    let mut doc = HwpDocument::create_empty();
    let mut document = Document::default();

    let page_def = PageDef {
        width: 59528,
        height: 84188,
        margin_left: 8504,
        margin_right: 8504,
        margin_top: 5669,
        margin_bottom: 4252,
        margin_header: 4252,
        margin_footer: 4252,
        ..Default::default()
    };

    let mut table = Table {
        row_count: 2,
        col_count: 2,
        padding: Padding {
            left: 100,
            right: 100,
            top: 100,
            bottom: 100,
        },
        cells: vec![
            Cell {
                col: 0,
                row: 0,
                col_span: 1,
                row_span: 1,
                width: 21000,
                height: 3000,
                paragraphs: vec![Paragraph {
                    text: "셀A".to_string(),
                    char_count: 2,
                    char_offsets: make_char_offsets("셀A"),
                    line_segs: vec![LineSeg {
                        line_height: 400,
                        baseline_distance: 320,
                        ..Default::default()
                    }],
                    ..Default::default()
                }],
                ..Default::default()
            },
            Cell {
                col: 1,
                row: 0,
                col_span: 1,
                row_span: 1,
                width: 21000,
                height: 3000,
                paragraphs: vec![Paragraph {
                    text: "셀B".to_string(),
                    char_count: 2,
                    char_offsets: make_char_offsets("셀B"),
                    line_segs: vec![LineSeg {
                        line_height: 400,
                        baseline_distance: 320,
                        ..Default::default()
                    }],
                    ..Default::default()
                }],
                ..Default::default()
            },
            Cell {
                col: 0,
                row: 1,
                col_span: 1,
                row_span: 1,
                width: 21000,
                height: 3000,
                paragraphs: vec![Paragraph {
                    text: "셀C".to_string(),
                    char_count: 2,
                    char_offsets: make_char_offsets("셀C"),
                    line_segs: vec![LineSeg {
                        line_height: 400,
                        baseline_distance: 320,
                        ..Default::default()
                    }],
                    ..Default::default()
                }],
                ..Default::default()
            },
            Cell {
                col: 1,
                row: 1,
                col_span: 1,
                row_span: 1,
                width: 21000,
                height: 3000,
                paragraphs: vec![Paragraph {
                    text: "셀D".to_string(),
                    char_count: 2,
                    char_offsets: make_char_offsets("셀D"),
                    line_segs: vec![LineSeg {
                        line_height: 400,
                        baseline_distance: 320,
                        ..Default::default()
                    }],
                    ..Default::default()
                }],
                ..Default::default()
            },
        ],
        ..Default::default()
    };
    table.rebuild_grid();

    let parent_para = Paragraph {
        text: String::new(),
        controls: vec![Control::Table(Box::new(table))],
        line_segs: vec![LineSeg {
            line_height: 400,
            baseline_distance: 320,
            ..Default::default()
        }],
        ..Default::default()
    };

    document.sections.push(Section {
        section_def: SectionDef {
            page_def,
            ..Default::default()
        },
        paragraphs: vec![parent_para],
        raw_stream: None,
        raw_provenance: None,
    });
    doc.set_document(document);
    doc
}

/// #2424 page-count commit 검증용: 한 쪽에 거의 차는 1열 RowBreak 표.
/// 마지막 cell의 줄 수만 늘리면 표 continuation이 한 쪽 더 필요해진다.
fn create_doc_with_page_count_boundary_table() -> HwpDocument {
    use crate::model::control::Control;
    use crate::model::document::SectionDef;
    use crate::model::page::PageDef;
    use crate::model::table::{Cell, Table, TablePageBreak};
    use crate::model::Padding;

    let mut doc = HwpDocument::create_empty();
    let mut document = Document::default();
    let page_def = PageDef {
        width: 59528,
        height: 84188,
        margin_left: 8504,
        margin_right: 8504,
        margin_top: 5669,
        margin_bottom: 4252,
        margin_header: 4252,
        margin_footer: 4252,
        ..Default::default()
    };
    let row_count = 13u16;
    let mut cells = Vec::with_capacity(row_count as usize);
    for row in 0..row_count {
        let text = if row + 1 == row_count {
            "가"
        } else {
            "고정"
        };
        cells.push(Cell {
            row,
            col: 0,
            row_span: 1,
            col_span: 1,
            // 셀 편집 reflow 는 그리드 폭으로 줄을 나눈다. 1열 표의 모든 셀 폭을 같게 둔다.
            width: 42_000,
            height: if row + 1 == row_count { 600 } else { 5_250 },
            paragraphs: vec![Paragraph {
                text: text.to_string(),
                char_count: text.chars().count() as u32,
                char_offsets: make_char_offsets(text),
                line_segs: vec![LineSeg {
                    line_height: 400,
                    baseline_distance: 320,
                    ..Default::default()
                }],
                ..Default::default()
            }],
            ..Default::default()
        });
    }
    let mut table = Table {
        row_count,
        col_count: 1,
        page_break: TablePageBreak::RowBreak,
        padding: Padding {
            left: 100,
            right: 100,
            top: 100,
            bottom: 100,
        },
        cells,
        ..Default::default()
    };
    table.rebuild_grid();
    let parent_para = Paragraph {
        controls: vec![Control::Table(Box::new(table))],
        line_segs: vec![LineSeg {
            line_height: 400,
            baseline_distance: 320,
            ..Default::default()
        }],
        ..Default::default()
    };
    document.sections.push(Section {
        section_def: SectionDef {
            page_def,
            ..Default::default()
        },
        paragraphs: vec![parent_para],
        raw_stream: None,
        raw_provenance: None,
    });
    doc.set_document(document);
    doc
}

#[test]
fn test_insert_text_in_cell() {
    let mut doc = create_doc_with_table();
    let result = doc.insert_text_in_cell_native(0, 0, 0, 0, 0, 1, "추가");
    assert!(result.is_ok());
    let json = result.unwrap();
    assert!(json.contains("\"ok\":true"));
    assert!(json.contains("\"charOffset\":3"));
    assert!(
        !json.contains("cellFlowChanged"),
        "immediate insert response schema must remain unchanged"
    );

    if let Some(Control::Table(table)) = doc.document.sections[0].paragraphs[0].controls.first() {
        assert_eq!(table.cells[0].paragraphs[0].text, "셀추가A");
    } else {
        panic!("표 컨트롤을 찾을 수 없음");
    }
}

#[test]
fn issue2424_deferred_delete_preserves_immediate_schema_and_tracks_ime_revision() {
    let mut immediate = create_doc_with_table();
    let immediate_raw = immediate
        .delete_text_in_cell_native(0, 0, 0, 0, 0, 1, 1)
        .expect("immediate cell delete");
    let immediate_result: Value =
        serde_json::from_str(&immediate_raw).expect("immediate delete json");
    assert_eq!(immediate_result["charOffset"], 1);
    assert!(
        immediate_result.get("cellFlowChanged").is_none(),
        "existing immediate response schema must remain unchanged"
    );

    let mut doc = create_doc_with_table();
    doc.insert_text_in_cell_native_deferred_pagination(0, 0, 0, 0, 0, 1, "ㅎ")
        .expect("first IME insert");
    let first_revision = doc
        .deferred_pagination_descriptor
        .as_ref()
        .expect("first IME descriptor")
        .revision;

    let delete_raw = doc
        .delete_text_in_cell_native_deferred_pagination(0, 0, 0, 0, 0, 1, 1)
        .expect("IME replacement delete");
    let delete_result: Value = serde_json::from_str(&delete_raw).expect("deferred delete json");
    assert_eq!(delete_result["charOffset"], 1);
    assert!(delete_result["cellFlowChanged"].is_boolean());
    let delete_revision = doc
        .deferred_pagination_descriptor
        .as_ref()
        .expect("delete descriptor")
        .revision;
    assert!(delete_revision > first_revision);

    doc.insert_text_in_cell_native_deferred_pagination(0, 0, 0, 0, 0, 1, "하")
        .expect("second IME insert");
    let final_descriptor = doc
        .deferred_pagination_descriptor
        .as_ref()
        .expect("latest IME descriptor");
    assert!(final_descriptor.revision > delete_revision);
    assert_eq!(
        (
            final_descriptor.section_index,
            final_descriptor.para_index,
            final_descriptor.control_index,
            final_descriptor.cell_index,
            final_descriptor.cell_para_index,
        ),
        (0, 0, 0, 0, 0)
    );
    match &doc.document.sections[0].paragraphs[0].controls[0] {
        Control::Table(table) => assert_eq!(table.cells[0].paragraphs[0].text, "셀하A"),
        other => panic!("table control expected: {other:?}"),
    }

    doc.flush_deferred_pagination().expect("IME output barrier");
    assert!(doc.deferred_pagination_descriptor.is_none());
}

#[test]
fn issue2424_page_count_is_held_until_shadow_layout_commits() {
    let mut doc = create_doc_with_page_count_boundary_table();
    let initial_page_count = doc.page_count();
    assert_eq!(initial_page_count, 1, "fixture must begin on one page");

    // 마지막 행이 세 줄이 되어야 본문 하단을 넘는다.
    let inserted = "가".repeat(96);
    let edit_raw = doc
        .insert_text_in_cell_native_deferred_pagination(0, 0, 0, 12, 0, 1, &inserted)
        .expect("deferred boundary insert");
    let edit: Value = serde_json::from_str(&edit_raw).expect("edit json");
    assert_eq!(edit["cellFlowChanged"], true, "fixture must add cell lines");
    assert_eq!(
        doc.page_count(),
        initial_page_count,
        "deferred edit must keep the public page count"
    );

    let begin = doc.core.begin_deferred_pagination(1);
    assert_eq!(begin.state, DeferredPaginationJobState::Pending);
    assert_eq!(begin.page_count, initial_page_count);

    let completed = loop {
        let step = doc.core.step_deferred_pagination(1);
        match step.state {
            DeferredPaginationJobState::Pending => {
                assert_eq!(
                    step.page_count, initial_page_count,
                    "incomplete shadow fragments must not publish a page count"
                );
            }
            DeferredPaginationJobState::Complete => break step,
            state => panic!("unexpected shadow status: {state:?}"),
        }
    };
    assert!(
        completed.page_count > initial_page_count,
        "final shadow commit must publish the added page: {completed:?}"
    );
    assert_eq!(doc.page_count(), completed.page_count);
}

#[test]
fn deferred_cell_replace_applies_ime_atomically() {
    use crate::renderer::render_tree::{RenderNode, RenderNodeType};

    fn contains_text(node: &RenderNode, needle: &str) -> bool {
        if let RenderNodeType::TextRun(run) = &node.node_type {
            if run.text.contains(needle) {
                return true;
            }
        }
        node.children
            .iter()
            .any(|child| contains_text(child, needle))
    }

    let mut doc = create_doc_with_table();
    doc.begin_batch_native().expect("begin event capture");
    doc.insert_text_in_cell_native_deferred_pagination(0, 0, 0, 0, 0, 2, "ㅎ")
        .expect("seed composition");
    doc.build_page_render_tree(0).expect("warm page tree");

    let raw = doc
        .replace_text_in_cell_native_deferred_pagination(0, 0, 0, 0, 0, 2, 1, "하")
        .expect("atomic composition replace");
    let result: Value = serde_json::from_str(&raw).expect("replace result json");

    assert_eq!(result["charOffset"].as_u64(), Some(3));
    assert_eq!(result["cellFlowChanged"].as_bool(), Some(false));
    match &doc.document.sections[0].paragraphs[0].controls[0] {
        Control::Table(table) => {
            let para = &table.cells[0].paragraphs[0];
            assert_eq!(para.text, "셀A하");
            assert_eq!(para.char_count, 3);
            assert_eq!(para.char_offsets, make_char_offsets("셀A하"));
        }
        other => panic!("table control expected: {other:?}"),
    }

    let transient_tree = doc.build_page_render_tree(0).expect("transient page tree");
    assert!(
        contains_text(&transient_tree.root, "하"),
        "warm page tree must expose the final composition before pagination"
    );
    assert_eq!(doc.event_log.len(), 2, "seed insert + atomic replace");
    assert!(matches!(
        doc.event_log.last(),
        Some(crate::model::event::DocumentEvent::CellTextChanged {
            section: 0,
            para: 0,
            ctrl: 0,
            cell: 0,
        })
    ));
}

#[test]
fn deferred_cell_replace_reports_real_flow_boundary() {
    use crate::model::shape::{Caption, CaptionDirection};

    let mut doc = create_doc_with_table();
    match &mut doc.document.sections[0].paragraphs[0].controls[0] {
        Control::Table(table) => {
            table.caption = Some(Caption {
                direction: CaptionDirection::Bottom,
                width: 2_000,
                max_width: 2_000,
                paragraphs: vec![Paragraph {
                    text: "가".to_string(),
                    char_count: 1,
                    char_offsets: make_char_offsets("가"),
                    line_segs: vec![LineSeg {
                        line_height: 400,
                        baseline_distance: 320,
                        ..Default::default()
                    }],
                    ..Default::default()
                }],
                ..Default::default()
            });
        }
        other => panic!("table control expected: {other:?}"),
    }
    doc.reflow_cell_paragraph(0, 0, 0, 65534, 0);

    let raw = doc
        .replace_text_in_cell_native_deferred_pagination(
            0,
            0,
            0,
            65534,
            0,
            0,
            1,
            "가나다라마바사아",
        )
        .expect("caption boundary replace");
    let result: Value = serde_json::from_str(&raw).expect("boundary result json");
    assert_eq!(result["cellFlowChanged"].as_bool(), Some(true));
    match &doc.document.sections[0].paragraphs[0].controls[0] {
        Control::Table(table) => assert!(
            table.caption.as_ref().expect("table caption").paragraphs[0]
                .line_segs
                .len()
                > 1,
            "replacement must cross a line-flow boundary"
        ),
        other => panic!("table control expected: {other:?}"),
    }
}

#[test]
fn deferred_cell_replace_preserves_clickhere_range_and_offsets() {
    let mut doc = create_doc_with_table();
    let mut legacy = create_doc_with_table();
    doc.insert_click_here_field_at_in_cell(0, 0, 0, 0, 0, 2, false, "안내", "메모", "이름", true)
        .expect("insert empty ClickHere");
    legacy
        .insert_click_here_field_at_in_cell(0, 0, 0, 0, 0, 2, false, "안내", "메모", "이름", true)
        .expect("insert legacy empty ClickHere");
    doc.begin_batch_native()
        .expect("begin atomic event capture");
    legacy
        .begin_batch_native()
        .expect("begin legacy event capture");
    doc.insert_text_in_cell_native_deferred_pagination(0, 0, 0, 0, 0, 2, "ㅎ")
        .expect("seed field composition");
    legacy
        .insert_text_in_cell_native_deferred_pagination(0, 0, 0, 0, 0, 2, "ㅎ")
        .expect("seed legacy field composition");
    doc.event_log.clear();
    legacy.event_log.clear();

    doc.replace_text_in_cell_native_deferred_pagination(0, 0, 0, 0, 0, 2, 1, "하")
        .expect("replace field composition");
    legacy
        .delete_text_in_cell_native(0, 0, 0, 0, 0, 2, 1)
        .expect("legacy field composition delete");
    legacy
        .insert_text_in_cell_native(0, 0, 0, 0, 0, 2, "하")
        .expect("legacy field composition insert");

    let para = match &doc.document.sections[0].paragraphs[0].controls[0] {
        Control::Table(table) => &table.cells[0].paragraphs[0],
        other => panic!("table control expected: {other:?}"),
    };
    let legacy_para = match &legacy.document.sections[0].paragraphs[0].controls[0] {
        Control::Table(table) => &table.cells[0].paragraphs[0],
        other => panic!("legacy table control expected: {other:?}"),
    };
    assert_eq!(para.text, "셀A하");
    assert_eq!(para.char_offsets, legacy_para.char_offsets);
    assert_eq!(para.field_ranges.len(), 1);
    assert_eq!(
        para.field_ranges[0].control_idx,
        legacy_para.field_ranges[0].control_idx
    );
    assert_eq!(
        para.field_ranges[0].start_char_idx,
        legacy_para.field_ranges[0].start_char_idx
    );
    assert_eq!(
        para.field_ranges[0].end_char_idx,
        legacy_para.field_ranges[0].end_char_idx
    );
    assert_eq!(para.field_ranges[0].start_char_idx, 2);
    assert_eq!(para.field_ranges[0].end_char_idx, 3);
    assert_eq!(
        doc.event_log.len(),
        1,
        "replace emits only final cell state"
    );
    assert_eq!(
        legacy.event_log.len(),
        2,
        "legacy delete+insert exposes two intermediate events"
    );
}

#[test]
fn deferred_cell_replace_rejects_invalid_input_before_mutation() {
    let mut doc = create_doc_with_table();
    let before = match &doc.document.sections[0].paragraphs[0].controls[0] {
        Control::Table(table) => table.cells[0].paragraphs[0].text.clone(),
        other => panic!("table control expected: {other:?}"),
    };

    let result = doc.replace_text_in_cell_native_deferred_pagination(
        0,
        0,
        0,
        0,
        0,
        2,
        1,
        "가나다라마바사아자",
    );

    assert!(
        result.is_err(),
        "more than eight replacement chars must fail"
    );
    match &doc.document.sections[0].paragraphs[0].controls[0] {
        Control::Table(table) => assert_eq!(table.cells[0].paragraphs[0].text, before),
        other => panic!("table control expected: {other:?}"),
    }
}

#[test]
fn issue2214_deferred_table_caption_reports_flow_change() {
    use crate::model::shape::{Caption, CaptionDirection};

    fn caption_paragraph(doc: &HwpDocument) -> &Paragraph {
        match &doc.document.sections[0].paragraphs[0].controls[0] {
            Control::Table(table) => &table.caption.as_ref().expect("table caption").paragraphs[0],
            other => panic!("table control expected: {other:?}"),
        }
    }

    fn relative_flow(paragraph: &Paragraph) -> Option<i64> {
        let first = paragraph.line_segs.first()?;
        let last = paragraph.line_segs.last()?;
        Some(
            i64::from(last.vertical_pos)
                + i64::from(last.line_height)
                + i64::from(last.line_spacing)
                - i64::from(first.vertical_pos),
        )
    }

    let mut doc = create_doc_with_table();
    match &mut doc.document.sections[0].paragraphs[0].controls[0] {
        Control::Table(table) => {
            table.caption = Some(Caption {
                direction: CaptionDirection::Bottom,
                width: 2_000,
                max_width: 2_000,
                paragraphs: vec![Paragraph {
                    text: "가".to_string(),
                    char_count: 1,
                    char_offsets: make_char_offsets("가"),
                    line_segs: vec![LineSeg {
                        line_height: 400,
                        baseline_distance: 320,
                        ..Default::default()
                    }],
                    ..Default::default()
                }],
                ..Default::default()
            });
        }
        other => panic!("table control expected: {other:?}"),
    }
    doc.reflow_cell_paragraph(0, 0, 0, 65534, 0);

    let mut saw_boundary = false;
    for inserted in 0..32 {
        let before = relative_flow(caption_paragraph(&doc));
        let raw = doc
            .insert_text_in_cell_native_deferred_pagination(0, 0, 0, 65534, 0, 1 + inserted, "가")
            .expect("deferred caption insert");
        let after = relative_flow(caption_paragraph(&doc));
        let result: Value = serde_json::from_str(&raw).expect("caption edit result json");
        let reported = result["cellFlowChanged"]
            .as_bool()
            .expect("caption flow result");
        assert_eq!(
            reported,
            before != after,
            "caption input {} flow signal",
            inserted + 1
        );
        if reported {
            saw_boundary = true;
            assert!(
                caption_paragraph(&doc).line_segs.len() > 1,
                "caption flow boundary must add a line"
            );
            break;
        }
    }
    assert!(
        saw_boundary,
        "caption deferred input must report a wrapping flow boundary"
    );
}

#[test]
fn issue2424_deferred_pagination_descriptor_tracks_latest_edit_until_flush() {
    let mut doc = create_doc_with_table();
    assert!(doc.deferred_pagination_descriptor.is_none());

    doc.insert_text_in_cell_native_deferred_pagination(0, 0, 0, 0, 0, 1, "x")
        .expect("first deferred insert");
    let first = doc
        .deferred_pagination_descriptor
        .clone()
        .expect("first target descriptor");
    assert_eq!(first.revision, 1);
    assert_eq!(
        (
            first.section_index,
            first.para_index,
            first.control_index,
            first.cell_index,
            first.cell_para_index,
        ),
        (0, 0, 0, 0, 0)
    );
    assert_eq!(first.target_first_page, Some(0));
    assert_ne!(first.table_structure_fingerprint, 0);
    assert_eq!(
        doc.deferred_pagination_target_status(&first),
        crate::document_core::DeferredPaginationTargetStatus::Current
    );

    // 앞선 입력에서 이미 flow boundary가 있었다고 가정하면 같은 target의 후속 stable
    // 입력이 descriptor의 pending boundary를 지우면 안 된다.
    doc.deferred_pagination_descriptor
        .as_mut()
        .expect("pending descriptor")
        .cell_flow_changed = true;

    doc.insert_text_in_cell_native_deferred_pagination(0, 0, 0, 0, 0, 2, "y")
        .expect("replacement deferred insert");
    let second = doc
        .deferred_pagination_descriptor
        .as_ref()
        .expect("replacement target descriptor");
    assert_eq!(second.revision, 2);
    assert!(second.cell_flow_changed);
    assert_eq!(
        second.table_structure_fingerprint, first.table_structure_fingerprint,
        "text-only edit must preserve the target table structure"
    );
    assert_eq!(
        doc.deferred_pagination_target_status(&first),
        crate::document_core::DeferredPaginationTargetStatus::Superseded,
        "a newer deferred edit must invalidate an older job revision"
    );
    let second = second.clone();
    assert_eq!(
        doc.deferred_pagination_target_status(&second),
        crate::document_core::DeferredPaginationTargetStatus::Current
    );

    let removed_paragraph = match &mut doc.document.sections[0].paragraphs[0].controls[0] {
        Control::Table(table) => table.cells[0]
            .paragraphs
            .pop()
            .expect("target cell paragraph"),
        _ => panic!("target table"),
    };
    assert_eq!(
        doc.deferred_pagination_target_status(&second),
        crate::document_core::DeferredPaginationTargetStatus::TargetMissing
    );
    match &mut doc.document.sections[0].paragraphs[0].controls[0] {
        Control::Table(table) => table.cells[0].paragraphs.push(removed_paragraph),
        _ => panic!("target table"),
    }

    match &mut doc.document.sections[0].paragraphs[0].controls[0] {
        Control::Table(table) => table.row_count = table.row_count.saturating_add(1),
        _ => panic!("target table"),
    }
    assert_eq!(
        doc.deferred_pagination_target_status(&second),
        crate::document_core::DeferredPaginationTargetStatus::StructureChanged
    );
    match &mut doc.document.sections[0].paragraphs[0].controls[0] {
        Control::Table(table) => table.row_count = table.row_count.saturating_sub(1),
        _ => panic!("target table"),
    }
    assert_eq!(
        doc.deferred_pagination_target_status(&second),
        crate::document_core::DeferredPaginationTargetStatus::Current
    );

    match &mut doc.document.sections[0].paragraphs[0].controls[0] {
        Control::Table(table) => table.cells[0].paragraphs[0]
            .controls
            .push(Control::Bookmark(Default::default())),
        _ => panic!("target table"),
    }
    assert_eq!(
        doc.deferred_pagination_target_status(&second),
        crate::document_core::DeferredPaginationTargetStatus::StructureChanged,
        "cell paragraph control structure changes must invalidate the descriptor"
    );
    match &mut doc.document.sections[0].paragraphs[0].controls[0] {
        Control::Table(table) => {
            table.cells[0].paragraphs[0].controls.pop();
        }
        _ => panic!("target table"),
    }
    assert_eq!(
        doc.deferred_pagination_target_status(&second),
        crate::document_core::DeferredPaginationTargetStatus::Current
    );

    let third_raw = doc
        .insert_text_in_cell_native_deferred_pagination(0, 0, 0, 1, 0, 0, "z")
        .expect("different target deferred insert");
    let third_result: Value = serde_json::from_str(&third_raw).expect("different target result");
    let third = doc
        .deferred_pagination_descriptor
        .as_ref()
        .expect("different target descriptor");
    assert_eq!(third.revision, 3);
    assert_eq!(third.cell_index, 1);
    assert_eq!(
        third.cell_flow_changed,
        third_result["cellFlowChanged"].as_bool().unwrap(),
        "a different target must not inherit the previous flow signal"
    );

    doc.flush_deferred_pagination().expect("full flush");
    assert!(
        doc.deferred_pagination_descriptor.is_none(),
        "successful full pagination must consume the pending descriptor"
    );
}

#[test]
fn issue2308_deferred_cell_edit_uses_path_revision_without_section_invalidation() {
    use crate::renderer::render_normalization::RenderPathEntry;

    let mut doc = create_doc_with_table();
    let section_revision_before = doc.render_normalization.section_revisions[0];

    doc.insert_text_in_cell_native_deferred_pagination(0, 0, 0, 0, 0, 1, "가")
        .expect("deferred table-cell insert");

    assert_eq!(
        doc.render_normalization.section_revisions[0], section_revision_before,
        "a structure-stable cell edit must not invalidate the section projection"
    );
    let revision = doc
        .render_normalization
        .path_revisions
        .iter()
        .find_map(|(path, revision)| match path.entries.as_slice() {
            [RenderPathEntry::TableCell {
                control_index: 0,
                cell_index: 0,
                paragraph_index: 0,
            }] => Some(*revision),
            _ => None,
        });
    assert_eq!(revision, Some(1), "the edited logical path revision");
}

#[test]
fn issue2308_immediate_edit_rederives_existing_compat_projection() {
    use crate::model::image::Picture;
    use crate::model::shape::{CommonObjAttr, HorzAlign, HorzRelTo, TextWrap};

    fn floating_picture() -> Control {
        Control::Picture(Box::new(Picture {
            common: CommonObjAttr {
                height: 50_000,
                text_wrap: TextWrap::Square,
                allow_overlap: false,
                treat_as_char: false,
                horz_rel_to: HorzRelTo::Para,
                horz_align: HorzAlign::Left,
                ..Default::default()
            },
            ..Default::default()
        }))
    }

    let mut doc = create_doc_with_table();
    let Control::Table(table) = &mut doc.document.sections[0].paragraphs[0].controls[0] else {
        panic!("table control");
    };
    table.cells[0].paragraphs[0] = Paragraph {
        controls: vec![floating_picture(), floating_picture()],
        line_segs: vec![LineSeg {
            line_height: 400,
            baseline_distance: 320,
            ..Default::default()
        }],
        ..Default::default()
    };
    let document = doc.document.clone();
    doc.set_document(document);
    assert!(
        doc.render_normalization.sections[0].is_some(),
        "the synthetic cell image stack must create a #2004 compatibility projection"
    );
    let revision_before = doc.render_normalization.section_revisions[0];

    doc.insert_text_in_cell_native(0, 0, 0, 0, 0, 0, "x")
        .expect("immediate edit in a projected cell");

    assert_ne!(
        doc.render_normalization.section_revisions[0], revision_before,
        "an existing compatibility projection must be invalidated"
    );
    assert!(
        doc.render_normalization.sections[0].is_none(),
        "visible source text removes the stack gate, so no stale projection may survive"
    );
}

#[test]
fn issue2214_invalid_shape_cell_index_does_not_mutate_text() {
    let mut doc = HwpDocument::create_empty();
    let inserted = doc
        .create_shape_control_native(
            0,
            0,
            0,
            21_600,
            7_200,
            0,
            0,
            true,
            "TopAndBottom",
            "textbox",
            false,
            false,
            &[],
        )
        .expect("create textbox shape");
    let inserted: Value = serde_json::from_str(&inserted).expect("shape result json");
    let para_idx = inserted["paraIdx"].as_u64().expect("shape paraIdx") as usize;
    let control_idx = inserted["controlIdx"].as_u64().expect("shape controlIdx") as usize;
    let before = doc
        .get_cell_paragraph_ref(0, para_idx, control_idx, 0, 0)
        .expect("textbox paragraph")
        .text
        .clone();

    let result =
        doc.insert_text_in_cell_native_deferred_pagination(0, para_idx, control_idx, 1, 0, 0, "x");

    assert!(result.is_err(), "nonzero Shape cell index must fail");
    assert_eq!(
        doc.get_cell_paragraph_ref(0, para_idx, control_idx, 0, 0)
            .expect("textbox paragraph after invalid call")
            .text,
        before,
        "invalid Shape cell index must fail before mutation"
    );
}

#[test]
fn test_delete_text_in_cell() {
    let mut doc = create_doc_with_table();
    let result = doc.delete_text_in_cell_native(0, 0, 0, 1, 0, 0, 1);
    assert!(result.is_ok());
    let json = result.unwrap();
    assert!(json.contains("\"ok\":true"));

    if let Some(Control::Table(table)) = doc.document.sections[0].paragraphs[0].controls.first() {
        assert_eq!(table.cells[1].paragraphs[0].text, "B");
    } else {
        panic!("표 컨트롤을 찾을 수 없음");
    }
}

#[test]
fn test_table_transpose_clipboard_native_api() {
    let mut doc = create_doc_with_table();
    doc.begin_batch_native().expect("begin event capture");
    assert!(!doc.has_table_transpose_clipboard_native());

    let copy = doc
        .copy_table_cells_transposed_native(0, 0, 0, 0, 0, 1, 1)
        .unwrap();
    let copy_json: Value = serde_json::from_str(&copy).unwrap();
    assert_eq!(copy_json["ok"], true);
    assert_eq!(copy_json["sourceRows"], 2);
    assert_eq!(copy_json["sourceCols"], 2);
    assert!(doc.has_table_transpose_clipboard_native());

    let paste = doc
        .paste_table_cells_transposed_native(0, 0, 0, 0, 0)
        .unwrap();
    let paste_json: Value = serde_json::from_str(&paste).unwrap();
    assert_eq!(paste_json["ok"], true);
    assert_eq!(paste_json["targetRows"], 2);
    assert_eq!(paste_json["targetCols"], 2);

    if let Some(Control::Table(table)) = doc.document.sections[0].paragraphs[0].controls.first() {
        assert_eq!(table.cells[0].paragraphs[0].text, "셀A");
        assert_eq!(table.cells[1].paragraphs[0].text, "셀C");
        assert_eq!(table.cells[2].paragraphs[0].text, "셀B");
        assert_eq!(table.cells[3].paragraphs[0].text, "셀D");
    } else {
        panic!("표 컨트롤을 찾을 수 없음");
    }
    assert!(matches!(
        doc.event_log.last(),
        Some(crate::model::event::DocumentEvent::TableCellsTransposed {
            section: 0,
            para: 0,
            ctrl: 0,
        })
    ));
}

#[test]
fn test_table_transpose_in_place_native_api() {
    let mut doc = create_doc_with_table();

    let result = doc.transpose_table_cells_in_place_native(0, 0, 0).unwrap();
    let json: Value = serde_json::from_str(&result).unwrap();
    assert_eq!(json["ok"], true);
    assert_eq!(json["sourceRows"], 2);
    assert_eq!(json["sourceCols"], 2);
    assert_eq!(json["targetRows"], 2);
    assert_eq!(json["targetCols"], 2);

    assert_eq!(doc.document.sections[0].paragraphs.len(), 1);
    if let Some(Control::Table(table)) = doc.document.sections[0].paragraphs[0].controls.first() {
        assert_eq!(table.row_count, 2);
        assert_eq!(table.col_count, 2);
        assert_eq!(table.cells[0].paragraphs[0].text, "셀A");
        assert_eq!(table.cells[1].paragraphs[0].text, "셀C");
        assert_eq!(table.cells[2].paragraphs[0].text, "셀B");
        assert_eq!(table.cells[3].paragraphs[0].text, "셀D");
    } else {
        panic!("행/열이 바뀐 기존 표 컨트롤을 찾을 수 없음");
    }
}

#[test]
fn test_table_transpose_paste_as_new_table_native_api() {
    let mut doc = create_doc_with_table();
    doc.copy_table_cells_transposed_native(0, 0, 0, 0, 0, 1, 1)
        .unwrap();

    let paste = doc
        .paste_table_cells_transposed_as_new_table_native(0, 0, 0)
        .unwrap();
    let paste_json: Value = serde_json::from_str(&paste).unwrap();
    assert_eq!(paste_json["ok"], true);
    assert_eq!(paste_json["paraIdx"], 1);
    assert_eq!(paste_json["controlIdx"], 0);
    assert_eq!(paste_json["targetRows"], 2);
    assert_eq!(paste_json["targetCols"], 2);

    if let Some(Control::Table(source_table)) =
        doc.document.sections[0].paragraphs[0].controls.first()
    {
        assert_eq!(source_table.cells[0].paragraphs[0].text, "셀A");
        assert_eq!(source_table.cells[1].paragraphs[0].text, "셀B");
        assert_eq!(source_table.cells[2].paragraphs[0].text, "셀C");
        assert_eq!(source_table.cells[3].paragraphs[0].text, "셀D");
    } else {
        panic!("원본 표 컨트롤을 찾을 수 없음");
    }

    if let Some(Control::Table(target_table)) =
        doc.document.sections[0].paragraphs[1].controls.first()
    {
        assert_eq!(target_table.row_count, 2);
        assert_eq!(target_table.col_count, 2);
        assert_eq!(target_table.cells[0].paragraphs[0].text, "셀A");
        assert_eq!(target_table.cells[1].paragraphs[0].text, "셀C");
        assert_eq!(target_table.cells[2].paragraphs[0].text, "셀B");
        assert_eq!(target_table.cells[3].paragraphs[0].text, "셀D");
    } else {
        panic!("행/열 바꿈 붙여넣기 표 컨트롤을 찾을 수 없음");
    }
}

#[test]
fn test_cell_text_edit_invalid_indices() {
    let mut doc = create_doc_with_table();

    let result = doc.insert_text_in_cell_native(0, 0, 0, 99, 0, 0, "X");
    assert!(result.is_err());

    let result = doc.insert_text_in_cell_native(0, 0, 5, 0, 0, 0, "X");
    assert!(result.is_err());

    let result = doc.insert_text_in_cell_native(99, 0, 0, 0, 0, 0, "X");
    assert!(result.is_err());
}

#[test]
fn test_cell_text_layout_contains_cell_info() {
    let doc = create_doc_with_table();
    let layout = doc.get_page_text_layout_native(0);
    assert!(layout.is_ok());
    let json = layout.unwrap();

    assert!(json.contains("\"parentParaIdx\":"));
    assert!(json.contains("\"controlIdx\":"));
    assert!(json.contains("\"cellIdx\":"));
    assert!(json.contains("\"cellParaIdx\":"));
}

#[test]
fn test_insert_and_delete_roundtrip_in_cell() {
    let mut doc = create_doc_with_table();

    let result = doc.insert_text_in_cell_native(0, 0, 0, 2, 0, 2, "테스트");
    assert!(result.is_ok());

    if let Some(Control::Table(table)) = doc.document.sections[0].paragraphs[0].controls.first() {
        assert_eq!(table.cells[2].paragraphs[0].text, "셀C테스트");
    }

    let result = doc.delete_text_in_cell_native(0, 0, 0, 2, 0, 2, 3);
    assert!(result.is_ok());

    if let Some(Control::Table(table)) = doc.document.sections[0].paragraphs[0].controls.first() {
        assert_eq!(table.cells[2].paragraphs[0].text, "셀C");
    }
}

#[test]
fn test_svg_render_with_table_after_cell_edit() {
    let mut doc = create_doc_with_table();

    doc.insert_text_in_cell_native(0, 0, 0, 3, 0, 2, "수정됨")
        .unwrap();
    // 삽입 후 셀 텍스트 확인
    if let Some(Control::Table(table)) = doc.document.sections[0].paragraphs[0].controls.first() {
        assert_eq!(table.cells[3].paragraphs[0].text, "셀D수정됨");
    }
    let svg = doc.render_page_svg_native(0);
    assert!(svg.is_ok());
    let svg = svg.unwrap();
    // 언어별 폰트 분기로 "셀", "D", "수정됨"이 별도 text run으로 분리될 수 있으므로
    // 각 부분이 SVG에 포함되는지 확인
    // 문자별 개별 렌더링이므로 개별 문자 존재 확인
    assert!(svg.contains(">수</text>"), "SVG에 '수' 없음");
    assert!(svg.contains(">정</text>"), "SVG에 '정' 없음");
    assert!(svg.contains(">됨</text>"), "SVG에 '됨' 없음");
}

#[test]
fn test_get_page_control_layout_with_table() {
    let doc = create_doc_with_table();
    let result = doc.get_page_control_layout_native(0);
    assert!(result.is_ok());
    let json = result.unwrap();

    // 표 컨트롤이 포함되어야 함
    assert!(json.contains("\"type\":\"table\""));
    assert!(json.contains("\"rowCount\":"));
    assert!(json.contains("\"colCount\":"));
    // 문서 좌표 포함
    assert!(json.contains("\"secIdx\":"));
    assert!(json.contains("\"paraIdx\":"));
    assert!(json.contains("\"controlIdx\":"));
    // 셀 정보 포함
    assert!(json.contains("\"cells\":["));
    assert!(json.contains("\"cellIdx\":"));
    assert!(json.contains("\"row\":"));
    assert!(json.contains("\"col\":"));
}

#[test]
fn test_control_layout_cell_bounding_boxes() {
    let doc = create_doc_with_table();
    let result = doc.get_page_control_layout_native(0);
    assert!(result.is_ok());
    let json = result.unwrap();

    // JSON 파싱 검증: 표 바운딩 박스가 유효한 크기를 가짐
    assert!(json.contains("\"w\":"));
    assert!(json.contains("\"h\":"));

    // 셀이 4개 (2x2 표)
    let cell_count = json.matches("\"cellIdx\":").count();
    assert_eq!(cell_count, 4, "2x2 표에는 4개의 셀이 있어야 합니다");
}

// === 표 구조 편집 테스트 ===

#[test]
fn test_insert_table_row_below() {
    let mut doc = create_doc_with_table();
    let result = doc.insert_table_row_native(0, 0, 0, 0, true);
    assert!(result.is_ok());
    let json = result.unwrap();
    assert!(json.contains("\"rowCount\":3"));
    assert!(json.contains("\"colCount\":2"));

    if let Some(Control::Table(table)) = doc.document.sections[0].paragraphs[0].controls.first() {
        assert_eq!(table.row_count, 3);
        assert_eq!(table.cells.len(), 6);
        // 원래 첫 행의 셀A는 여전히 행 0
        assert_eq!(table.cells[0].row, 0);
        assert_eq!(table.cells[0].paragraphs[0].text, "셀A");
        // 새 행은 행 1 (빈 문단)
        assert_eq!(table.cells[2].row, 1);
        assert!(table.cells[2].paragraphs[0].text.is_empty());
    } else {
        panic!("표 컨트롤을 찾을 수 없음");
    }
}

#[test]
fn test_insert_table_column_right() {
    let mut doc = create_doc_with_table();
    let result = doc.insert_table_column_native(0, 0, 0, 0, true);
    assert!(result.is_ok());
    let json = result.unwrap();
    assert!(json.contains("\"rowCount\":2"));
    assert!(json.contains("\"colCount\":3"));

    if let Some(Control::Table(table)) = doc.document.sections[0].paragraphs[0].controls.first() {
        assert_eq!(table.col_count, 3);
        assert_eq!(table.cells.len(), 6);
    } else {
        panic!("표 컨트롤을 찾을 수 없음");
    }
}

#[test]
fn test_merge_table_cells() {
    let mut doc = create_doc_with_table();
    // 첫 행의 2개 셀 병합
    let result = doc.merge_table_cells_native(0, 0, 0, 0, 0, 0, 1);
    assert!(result.is_ok());
    let json = result.unwrap();
    assert!(json.contains("\"cellCount\":3")); // 비주 셀 1개 제거

    if let Some(Control::Table(table)) = doc.document.sections[0].paragraphs[0].controls.first() {
        assert_eq!(table.cells.len(), 3); // 비주 셀 제거됨
        let merged = &table.cells[0];
        assert_eq!(merged.col_span, 2);
        assert_eq!(merged.row_span, 1);
    } else {
        panic!("표 컨트롤을 찾을 수 없음");
    }
}

/// [merge stale local-resize] 병합으로 셀 배열 인덱스가 바뀌면
/// local_resize_cell_widths의 cell 인덱스 참조가 stale 해진다.
///
/// 2×2 표에서 셀 3(row=1,col=1)에 로컬 resize 폭을 저장해 둔 뒤 (0,0)~(0,1)을 병합하면
/// Table::merge_cells()가 비주 셀 하나를 retain()으로 제거해 cells.len()이 4→3으로
/// 줄어든다. local_resize_cell_widths가 갱신되지 않으면 이제 존재하지 않는 인덱스 3을
/// 계속 가리켜, 이 값을 cells[idx]로 읽는 렌더링/직렬화 경로가 범위를 벗어나거나
/// 병합 후 엉뚱한 셀에 로컬 resize 폭을 적용하게 된다.
#[test]
fn test_merge_table_cells_clears_stale_local_resize_widths() {
    let mut doc = create_doc_with_table();
    if let Some(Control::Table(table)) = doc.document.sections[0].paragraphs[0].controls.first_mut()
    {
        // 병합 전: 셀 인덱스 3(row=1,col=1)에 로컬 resize 폭 저장.
        table.local_resize_cell_widths.push((3, 1234));
    } else {
        panic!("표 컨트롤을 찾을 수 없음");
    }

    // (0,0)~(0,1) 병합 — 비주 셀 하나 제거, cells.len() 4→3.
    doc.merge_table_cells_native(0, 0, 0, 0, 0, 0, 1).unwrap();

    if let Some(Control::Table(table)) = doc.document.sections[0].paragraphs[0].controls.first() {
        assert_eq!(
            table.cells.len(),
            3,
            "병합으로 비주 셀 하나가 제거돼야 함(전제 확인)"
        );
        assert!(
            table.local_resize_cell_widths.is_empty(),
            "병합 후 셀 인덱스가 재배치되므로 local_resize_cell_widths의 stale 참조(인덱스 3)가 \
             비워져야 한다"
        );
    } else {
        panic!("표 컨트롤을 찾을 수 없음");
    }
}

/// [delete_row stale local-resize] 행 삭제로 셀 배열 인덱스가 바뀌면
/// local_resize_cell_heights의 cell 인덱스 참조가 stale 해진다.
///
/// 3×2 표(row 0,1,2 × col 0,1)에서 셀 인덱스 2(row=1,col=0)에 로컬 resize 높이를
/// 저장해 둔 뒤 row 0을 삭제하면 Table::delete_row()가 row 0의 셀 2개를 retain()으로
/// 제거해 cells.len()이 6→4로 줄고, 남은 셀을 sort_by_key(row, col)로 재정렬한다.
/// local_resize_cell_heights가 갱신되지 않으면 이제 존재하지 않거나(범위 초과) 엉뚱한
/// 셀을 가리키는 stale 참조가 남아, 이 값을 cells[idx]로 읽는 렌더링/직렬화 경로가
/// 패닉하거나 삭제 후 남은 엉뚱한 셀에 잘못된 로컬 resize 높이를 적용하게 된다.
#[test]
fn test_delete_table_row_clears_stale_local_resize_heights() {
    let mut doc = HwpDocument::create_empty();
    let table_result = doc.create_table_native(0, 0, 0, 3, 2).expect("3x2 표 생성");
    let table_para_idx = issue_1481_json_usize(&table_result, "paraIdx");

    if let Some(Control::Table(table)) = doc.document.sections[0].paragraphs[table_para_idx]
        .controls
        .first_mut()
    {
        // 삭제 전: 셀 인덱스 2(row=1,col=0)에 로컬 resize 높이 저장.
        table.local_resize_cell_heights.push((2, 5678));
    } else {
        panic!("표 컨트롤을 찾을 수 없음");
    }

    // row 0 삭제 — 셀 2개 제거, cells.len() 6→4.
    doc.delete_table_row_native(0, table_para_idx, 0, 0)
        .expect("행 삭제");

    if let Some(Control::Table(table)) = doc.document.sections[0].paragraphs[table_para_idx]
        .controls
        .first()
    {
        assert_eq!(
            table.cells.len(),
            4,
            "행 삭제로 셀 2개가 제거돼야 함(전제 확인)"
        );
        assert!(
            table.local_resize_cell_heights.is_empty(),
            "행 삭제 후 셀 인덱스가 재배치되므로 local_resize_cell_heights의 stale 참조(인덱스 2)가 \
             비워져야 한다"
        );
    } else {
        panic!("표 컨트롤을 찾을 수 없음");
    }
}

/// [insert_row/insert_column stale local-resize] 행/열 삽입으로 셀 배열 인덱스가
/// 바뀌면 local_resize_cell_widths/heights의 cell 인덱스 참조가 stale 해진다.
///
/// Table::insert_row()/insert_column()은 새 셀을 push()한 뒤 sort_by_key(row, col)로
/// 전체 셀 배열을 재정렬한다(delete_row가 retain()+정렬로 stale을 만드는 것과 같은
/// 근본 원인). 3×2 표에서 셀 인덱스 2에 로컬 resize 값을 저장해 둔 뒤 행을 삽입하면
/// 재정렬로 인덱스 2가 더 이상 같은 셀을 가리키지 않으므로, 이 값을 cells[idx]로
/// 읽는 렌더링/직렬화 경로가 엉뚱한 셀에 잘못된 로컬 resize 값을 적용하게 된다.
/// 열 삽입도 동일 원인으로 같은 결과를 낳는다.
#[test]
fn test_insert_table_row_and_column_clear_stale_local_resize() {
    let mut doc = HwpDocument::create_empty();
    let table_result = doc.create_table_native(0, 0, 0, 3, 2).expect("3x2 표 생성");
    let table_para_idx = issue_1481_json_usize(&table_result, "paraIdx");

    if let Some(Control::Table(table)) = doc.document.sections[0].paragraphs[table_para_idx]
        .controls
        .first_mut()
    {
        table.local_resize_cell_widths.push((2, 1234));
        table.local_resize_cell_heights.push((2, 5678));
    } else {
        panic!("표 컨트롤을 찾을 수 없음");
    }

    doc.insert_table_row_native(0, table_para_idx, 0, 0, true)
        .expect("행 삽입");

    if let Some(Control::Table(table)) = doc.document.sections[0].paragraphs[table_para_idx]
        .controls
        .first()
    {
        assert!(
            table.local_resize_cell_widths.is_empty() && table.local_resize_cell_heights.is_empty(),
            "행 삽입 후 셀 인덱스가 재배치되므로 local_resize_cell_widths/heights의 \
             stale 참조(인덱스 2)가 비워져야 한다"
        );
    } else {
        panic!("표 컨트롤을 찾을 수 없음");
    }

    if let Some(Control::Table(table)) = doc.document.sections[0].paragraphs[table_para_idx]
        .controls
        .first_mut()
    {
        table.local_resize_cell_widths.push((2, 1234));
        table.local_resize_cell_heights.push((2, 5678));
    } else {
        panic!("표 컨트롤을 찾을 수 없음");
    }

    doc.insert_table_column_native(0, table_para_idx, 0, 0, true)
        .expect("열 삽입");

    if let Some(Control::Table(table)) = doc.document.sections[0].paragraphs[table_para_idx]
        .controls
        .first()
    {
        assert!(
            table.local_resize_cell_widths.is_empty() && table.local_resize_cell_heights.is_empty(),
            "열 삽입 후에도 local_resize_cell_widths/heights의 stale 참조가 비워져야 한다"
        );
    } else {
        panic!("표 컨트롤을 찾을 수 없음");
    }
}

#[test]
fn test_split_table_cell() {
    let mut doc = create_doc_with_table();
    // 먼저 병합
    doc.merge_table_cells_native(0, 0, 0, 0, 0, 0, 1).unwrap();
    if let Some(Control::Table(table)) = doc.document.sections[0].paragraphs[0].controls.first() {
        assert_eq!(table.cells.len(), 3);
    }

    // 나누기
    let result = doc.split_table_cell_native(0, 0, 0, 0, 0);
    assert!(result.is_ok());
    let json = result.unwrap();
    assert!(json.contains("\"cellCount\":4"));

    if let Some(Control::Table(table)) = doc.document.sections[0].paragraphs[0].controls.first() {
        assert_eq!(table.cells.len(), 4);
        let cell = &table.cells[0];
        assert_eq!(cell.col_span, 1);
        assert_eq!(cell.row_span, 1);
    } else {
        panic!("표 컨트롤을 찾을 수 없음");
    }
}

/// [delete_table_column/split_table_cell stale local-resize] #2832/#2843/#2853과
/// 동일한 버그 클래스의 마지막 두 인스턴스. Table::delete_column()/split_cell()이
/// cells 배열의 인덱스 배치를 바꾸므로, local_resize_cell_widths/heights가 물고 있던
/// 이전 cell_idx는 정리되지 않으면 stale 참조로 남는다.
#[test]
fn test_delete_table_column_and_split_cell_clear_stale_local_resize() {
    let mut doc = create_doc_with_table();

    if let Some(Control::Table(table)) = doc.document.sections[0].paragraphs[0].controls.first_mut()
    {
        table.local_resize_cell_widths.push((1, 1234));
        table.local_resize_cell_heights.push((1, 5678));
    } else {
        panic!("표 컨트롤을 찾을 수 없음");
    }
    doc.delete_table_column_native(0, 0, 0, 0).expect("열 삭제");
    if let Some(Control::Table(table)) = doc.document.sections[0].paragraphs[0].controls.first() {
        assert!(
            table.local_resize_cell_widths.is_empty() && table.local_resize_cell_heights.is_empty(),
            "열 삭제 후 local_resize_cell_widths/heights의 stale 참조가 비워져야 한다"
        );
    } else {
        panic!("표 컨트롤을 찾을 수 없음");
    }

    if let Some(Control::Table(table)) = doc.document.sections[0].paragraphs[0].controls.first_mut()
    {
        table.local_resize_cell_widths.push((0, 1234));
        table.local_resize_cell_heights.push((0, 5678));
    } else {
        panic!("표 컨트롤을 찾을 수 없음");
    }
    doc.merge_table_cells_native(0, 0, 0, 0, 0, 1, 0)
        .expect("병합");
    doc.split_table_cell_native(0, 0, 0, 0, 0).expect("분할");
    if let Some(Control::Table(table)) = doc.document.sections[0].paragraphs[0].controls.first() {
        assert!(
            table.local_resize_cell_widths.is_empty() && table.local_resize_cell_heights.is_empty(),
            "셀 분할 후 local_resize_cell_widths/heights의 stale 참조가 비워져야 한다"
        );
    } else {
        panic!("표 컨트롤을 찾을 수 없음");
    }
}

/// [split_table_cells_in_range stale local-resize] split_table_cell_native/
/// split_table_cell_into_native와 동일하게 split_table_cells_in_range_native도
/// Table::split_cells_in_range()가 내부적으로 split_cell_into()를 반복 호출해
/// cells 배열의 인덱스 배치를 바꾼다. 그런데 이 커맨드만 local_resize_cell_widths/
/// heights를 비우지 않아 stale 참조가 남는다.
#[test]
fn test_split_table_cells_in_range_clears_stale_local_resize() {
    let mut doc = create_doc_with_table();

    if let Some(Control::Table(table)) = doc.document.sections[0].paragraphs[0].controls.first_mut()
    {
        table.local_resize_cell_widths.push((1, 1234));
        table.local_resize_cell_heights.push((1, 5678));
    } else {
        panic!("표 컨트롤을 찾을 수 없음");
    }

    doc.split_table_cells_in_range_native(0, 0, 0, 0, 0, 1, 1, 2, 2, false)
        .expect("범위 분할");

    if let Some(Control::Table(table)) = doc.document.sections[0].paragraphs[0].controls.first() {
        assert!(
            table.local_resize_cell_widths.is_empty() && table.local_resize_cell_heights.is_empty(),
            "범위 분할 후 local_resize_cell_widths/heights의 stale 참조가 비워져야 한다"
        );
    } else {
        panic!("표 컨트롤을 찾을 수 없음");
    }
}

#[test]
fn test_merge_then_control_layout_has_col_span() {
    let mut doc = create_doc_with_table();
    // 병합 전: colSpan=1
    let layout_before = doc.get_page_control_layout_native(0).unwrap();
    assert!(
        !layout_before.contains("\"colSpan\":2"),
        "병합 전에는 colSpan:2가 없어야 합니다"
    );

    // 병합: 첫 행의 2개 셀
    doc.merge_table_cells_native(0, 0, 0, 0, 0, 0, 1).unwrap();

    // 병합 후: colSpan=2가 레이아웃에 반영되어야 함
    let layout_after = doc.get_page_control_layout_native(0).unwrap();
    assert!(
        layout_after.contains("\"colSpan\":2"),
        "병합 후 colSpan:2가 있어야 합니다. 레이아웃: {}",
        layout_after
    );
}

#[test]
fn test_insert_table_row_invalid_index() {
    let mut doc = create_doc_with_table();
    let result = doc.insert_table_row_native(0, 0, 0, 99, true);
    assert!(result.is_err());
}

#[test]
fn test_table_structure_edit_roundtrip() {
    let mut doc = create_doc_with_table();
    // 행 삽입
    doc.insert_table_row_native(0, 0, 0, 0, true).unwrap();
    // 열 삽입
    doc.insert_table_column_native(0, 0, 0, 0, true).unwrap();

    // 직렬화 → 재파싱
    let bytes = doc.export_hwp_native();
    assert!(bytes.is_ok(), "행/열 삽입 후 직렬화 실패");
    let bytes = bytes.unwrap();
    assert!(!bytes.is_empty());

    // 재파싱 가능 여부 확인
    let reparsed = crate::parser::parse_hwp(&bytes);
    assert!(reparsed.is_ok(), "재파싱 실패: {:?}", reparsed.err());
}

#[test]
fn test_merge_cells_then_render() {
    let mut doc = create_doc_with_table();
    // 전체 병합
    doc.merge_table_cells_native(0, 0, 0, 0, 0, 1, 1).unwrap();

    // SVG 렌더링 성공 확인
    let svg = doc.render_page_svg_native(0);
    assert!(svg.is_ok());
    assert!(svg.unwrap().contains("<svg"));
}

#[test]
fn test_distribution_raw_stream_preserved() {
    let path = "samples/20250130-hongbo-no.hwp";
    assert!(
        std::path::Path::new(path).exists(),
        "테스트 입력 파일 없음: {:?}",
        path
    );
    let data = std::fs::read(path).unwrap();
    let mut doc = HwpDocument::from_bytes(&data).unwrap();

    // raw_stream 확인
    let has_raw_before = doc.document().sections[0].raw_stream.is_some();
    eprintln!("raw_stream before convert: {}", has_raw_before);
    assert!(has_raw_before, "파싱 후 raw_stream 있어야 함");

    // 헤더 플래그 확인
    eprintln!("header.flags: 0x{:08X}", doc.document().header.flags);
    eprintln!(
        "header.distribution: {}",
        doc.document().header.distribution
    );

    // convert
    let result = doc.convert_to_editable_native().unwrap();
    eprintln!("convert result: {}", result);

    let has_raw_after = doc.document().sections[0].raw_stream.is_some();
    eprintln!("raw_stream after convert: {}", has_raw_after);
    assert!(has_raw_after, "convert 후에도 raw_stream 보존되어야 함");

    // export
    let bytes = doc.export_hwp_native().unwrap();
    eprintln!("export size: {} bytes", bytes.len());

    // 재파싱 검증
    let doc2 = HwpDocument::from_bytes(&bytes).unwrap();
    assert_eq!(
        doc2.document().sections[0].paragraphs.len(),
        doc.document().sections[0].paragraphs.len()
    );
    eprintln!(
        "재파싱 문단 수 일치: {}",
        doc2.document().sections[0].paragraphs.len()
    );
}

/// 배포용 문서를 변환 후, raw_stream 없이 재직렬화하는 경로 테스트 (편집 시나리오)
#[test]
fn test_distribution_reserialization_without_raw_stream() {
    let path = "samples/20250130-hongbo-no.hwp";
    assert!(
        std::path::Path::new(path).exists(),
        "테스트 입력 파일 없음: {:?}",
        path
    );
    let data = std::fs::read(path).unwrap();
    let mut doc = HwpDocument::from_bytes(&data).unwrap();

    // 변환
    doc.convert_to_editable_native().unwrap();

    // 편집 시나리오 시뮬레이션: raw_stream 제거
    let orig_para_count = doc.document().sections[0].paragraphs.len();
    doc.document.sections[0].raw_stream = None;
    eprintln!("raw_stream 제거 후 재직렬화 테스트");

    // raw_stream 보존 경로 (기준)
    let data_with_raw = {
        let mut doc2 = HwpDocument::from_bytes(&data).unwrap();
        doc2.convert_to_editable_native().unwrap();
        doc2.export_hwp_native().unwrap()
    };

    // raw_stream 없는 경로 (편집 후)
    let data_without_raw = doc.export_hwp_native().unwrap();

    eprintln!("raw_stream 보존: {} bytes", data_with_raw.len());
    eprintln!("raw_stream 없음: {} bytes", data_without_raw.len());

    // 재직렬화된 파일 파싱 가능 여부
    let doc3 = HwpDocument::from_bytes(&data_without_raw).unwrap();
    let reserialized_para_count = doc3.document().sections[0].paragraphs.len();
    eprintln!(
        "원본 문단: {}, 재직렬화 문단: {}",
        orig_para_count, reserialized_para_count
    );

    // BodyText 레코드 수 비교
    use crate::parser::record::Record;
    let mut cfb_with = crate::parser::cfb_reader::CfbReader::open(&data_with_raw).unwrap();
    let bt_with = cfb_with.read_body_text_section(0, true, false).unwrap();
    let recs_with = Record::read_all(&bt_with).unwrap();

    let mut cfb_without = crate::parser::cfb_reader::CfbReader::open(&data_without_raw).unwrap();
    let bt_without = cfb_without.read_body_text_section(0, true, false).unwrap();
    let recs_without = Record::read_all(&bt_without).unwrap();

    eprintln!(
        "raw_stream 보존 레코드: {}, 재직렬화 레코드: {}",
        recs_with.len(),
        recs_without.len()
    );

    // 재직렬화 결과 파일을 디스크에 저장
    let out_dir = std::path::Path::new("output");
    if out_dir.exists() {
        std::fs::write(out_dir.join("hongbo_with_raw.hwp"), &data_with_raw).unwrap();
        std::fs::write(out_dir.join("hongbo_without_raw.hwp"), &data_without_raw).unwrap();
        eprintln!("저장: output/hongbo_with_raw.hwp, output/hongbo_without_raw.hwp");
    }

    // 레코드 유형별 차이 분석
    use std::collections::HashMap;
    let count_tags = |recs: &[Record]| -> HashMap<u16, usize> {
        let mut map = HashMap::new();
        for r in recs {
            *map.entry(r.tag_id).or_insert(0) += 1;
        }
        map
    };
    let tags_with = count_tags(&recs_with);
    let tags_without = count_tags(&recs_without);

    let mut all_tags: Vec<u16> = tags_with
        .keys()
        .chain(tags_without.keys())
        .copied()
        .collect();
    all_tags.sort();
    all_tags.dedup();
    for tag in &all_tags {
        let c1 = tags_with.get(tag).unwrap_or(&0);
        let c2 = tags_without.get(tag).unwrap_or(&0);
        if c1 != c2 {
            eprintln!(
                "  태그 차이: {} (0x{:04X}): raw={}, reserialized={}",
                crate::parser::tags::tag_name(*tag),
                tag,
                c1,
                c2
            );
        }
    }

    // CTRL_DATA 위치 분석
    for (idx, rec) in recs_with.iter().enumerate() {
        if rec.tag_id == crate::parser::tags::HWPTAG_CTRL_DATA {
            // 부모 CTRL_HEADER 찾기
            let mut parent_info = "?".to_string();
            for prev_idx in (0..idx).rev() {
                if recs_with[prev_idx].tag_id == crate::parser::tags::HWPTAG_CTRL_HEADER
                    && recs_with[prev_idx].level < rec.level
                {
                    let data = &recs_with[prev_idx].data;
                    if data.len() >= 4 {
                        let ctrl_id = u32::from_le_bytes([data[0], data[1], data[2], data[3]]);
                        parent_info = format!(
                            "{} (0x{:08X})",
                            crate::parser::tags::ctrl_name(ctrl_id),
                            ctrl_id
                        );
                    }
                    break;
                }
            }
            eprintln!(
                "  CTRL_DATA[{}]: level={}, size={}, parent={}",
                idx,
                rec.level,
                rec.data.len(),
                parent_info
            );
        }
    }

    // 인덱스 225~245 주변 레코드 트리 덤프 (level 6 구조 분석)
    eprintln!("\n--- 레코드 트리 (225~250) ---");
    for idx in 225..250.min(recs_with.len()) {
        let rec = &recs_with[idx];
        let indent = "  ".repeat(rec.level as usize);
        let mut extra = String::new();
        if rec.tag_id == crate::parser::tags::HWPTAG_CTRL_HEADER && rec.data.len() >= 4 {
            let cid = u32::from_le_bytes(rec.data[0..4].try_into().unwrap());
            extra = format!(" ctrl={}", crate::parser::tags::ctrl_name(cid));
        }
        eprintln!(
            "  [{}] {}{}(lv={}, {}B){}",
            idx,
            indent,
            crate::parser::tags::tag_name(rec.tag_id),
            rec.level,
            rec.data.len(),
            extra
        );
    }

    // 문단 수가 같아야 함
    assert_eq!(
        reserialized_para_count, orig_para_count,
        "재직렬화 후 문단 수 불일치!"
    );
}

// =====================================================================
// 클립보드 테스트
// =====================================================================

#[test]
fn test_clipboard_copy_paste_single_paragraph() {
    let mut doc = HwpDocument::create_empty();
    let mut document = Document::default();
    let mut para = Paragraph::default();
    para.text = "Hello World 안녕하세요".to_string();
    para.char_count = para.text.chars().count() as u32 + 1;
    para.char_offsets = para
        .text
        .chars()
        .enumerate()
        .map(|(i, _)| i as u32)
        .collect();
    para.char_shapes = vec![crate::model::paragraph::CharShapeRef {
        start_pos: 0,
        char_shape_id: 0,
    }];
    para.line_segs = vec![crate::model::paragraph::LineSeg {
        text_start: 0,
        line_height: 400,
        text_height: 400,
        baseline_distance: 320,
        ..Default::default()
    }];
    para.has_para_text = true;
    document.sections.push(Section {
        paragraphs: vec![para],
        ..Default::default()
    });
    doc.set_document(document);

    // "World" 복사 (offset 6~11)
    let result = doc.copy_selection_native(0, 0, 6, 0, 11);
    assert!(result.is_ok());
    let json = result.unwrap();
    assert!(json.contains("\"ok\":true"));
    assert!(json.contains("World"));

    // 내부 클립보드 확인
    assert!(doc.has_internal_clipboard_native());
    assert_eq!(doc.get_clipboard_text_native(), "World");

    // 문단 끝에 붙여넣기
    let text_len = doc.document.sections[0].paragraphs[0].text.chars().count();
    let result = doc.paste_internal_native(0, 0, text_len);
    assert!(result.is_ok());
    let json = result.unwrap();
    assert!(json.contains("\"ok\":true"));

    // 텍스트 확인
    let text = &doc.document.sections[0].paragraphs[0].text;
    assert!(text.contains("Hello World 안녕하세요World"));
}

#[test]
fn test_clipboard_copy_paste_multi_paragraph() {
    let mut doc = HwpDocument::create_empty();
    let mut document = Document::default();

    let make_para = |text: &str| {
        let mut p = Paragraph::default();
        p.text = text.to_string();
        p.char_count = text.chars().count() as u32 + 1;
        p.char_offsets = text.chars().enumerate().map(|(i, _)| i as u32).collect();
        p.char_shapes = vec![crate::model::paragraph::CharShapeRef {
            start_pos: 0,
            char_shape_id: 0,
        }];
        p.line_segs = vec![crate::model::paragraph::LineSeg {
            text_start: 0,
            line_height: 400,
            text_height: 400,
            baseline_distance: 320,
            ..Default::default()
        }];
        p.has_para_text = true;
        p
    };

    document.sections.push(Section {
        paragraphs: vec![
            make_para("첫 번째 문단"),
            make_para("두 번째 문단"),
            make_para("세 번째 문단"),
        ],
        ..Default::default()
    });
    doc.set_document(document);

    // 첫 번째 문단 3번째 글자부터 두 번째 문단 3번째 글자까지 복사
    let result = doc.copy_selection_native(0, 0, 3, 1, 3);
    assert!(result.is_ok());

    // 클립보드에 2개 문단이 있어야 함
    assert!(doc.has_internal_clipboard_native());
    let clip = doc.clipboard.as_ref().unwrap();
    assert_eq!(clip.paragraphs.len(), 2);

    // 세 번째 문단 끝에 붙여넣기
    let text_len = doc.document.sections[0].paragraphs[2].text.chars().count();
    let result = doc.paste_internal_native(0, 2, text_len);
    assert!(result.is_ok());
    let json = result.unwrap();
    assert!(json.contains("\"ok\":true"));

    // 문단 수 증가 확인 (3 → 4: 분할 + 삽입)
    assert_eq!(doc.document.sections[0].paragraphs.len(), 4);
}

#[test]
fn p0_multisection_range_copy_format_delete_and_snapshot_restore() {
    let mut doc = HwpDocument::create_empty();
    doc.create_blank_document_native().unwrap();

    let make_para = |text: &str| {
        let mut para = Paragraph::default();
        para.text = text.to_string();
        para.char_count = text.chars().count() as u32 + 1;
        para.char_offsets = text.chars().enumerate().map(|(i, _)| i as u32).collect();
        para.char_shapes = vec![crate::model::paragraph::CharShapeRef {
            start_pos: 0,
            char_shape_id: 0,
        }];
        para.has_para_text = true;
        para
    };

    let mut document = doc.document().clone();
    let template = document.sections[0].clone();
    document.sections = vec![template.clone(), template.clone(), template];
    document.sections[0].paragraphs = vec![make_para("S0-HEAD"), make_para("S0-TAIL")];
    document.sections[1].paragraphs = vec![make_para("S1-ONLY")];
    document.sections[2].paragraphs = vec![make_para("S2-HEAD"), make_para("S2-TAIL")];
    doc.set_document(document);

    doc.copy_selection_across_sections_native(0, 0, 3, 2, 1, 2)
        .expect("cross-section copy");
    assert_eq!(
        doc.get_clipboard_text_native(),
        "HEAD\nS0-TAIL\nS1-ONLY\nS2-HEAD\nS2",
        "all section sentinels must be copied in document order"
    );

    doc.apply_char_format_across_sections_native(0, 0, 3, 2, 1, 2, r#"{"bold":true}"#)
        .expect("cross-section character formatting");
    let char_props = |doc: &HwpDocument, sec, para, offset| -> Value {
        serde_json::from_str(
            &doc.get_char_properties_at_native(sec, para, offset)
                .expect("char props"),
        )
        .expect("char props json")
    };
    assert_eq!(char_props(&doc, 0, 0, 3)["bold"], true);
    assert_eq!(char_props(&doc, 1, 0, 0)["bold"], true);
    assert_eq!(char_props(&doc, 2, 1, 1)["bold"], true);
    assert_eq!(char_props(&doc, 0, 0, 1)["bold"], false);
    assert_eq!(char_props(&doc, 2, 1, 3)["bold"], false);

    doc.apply_para_format_across_sections_native(0, 0, 2, 1, r#"{"alignment":"center"}"#)
        .expect("cross-section paragraph formatting");
    for (section_idx, section) in doc.document().sections.iter().enumerate() {
        for para_idx in 0..section.paragraphs.len() {
            let props: Value = serde_json::from_str(
                &doc.get_para_properties_at_native(section_idx, para_idx)
                    .expect("para props"),
            )
            .expect("para props json");
            assert_eq!(props["alignment"], "center");
        }
    }

    let snapshot = doc.save_snapshot_native();
    doc.delete_range_across_sections_native(0, 0, 3, 2, 1, 2)
        .expect("cross-section delete");
    let texts: Vec<Vec<&str>> = doc
        .document()
        .sections
        .iter()
        .map(|section| {
            section
                .paragraphs
                .iter()
                .map(|para| para.text.as_str())
                .collect()
        })
        .collect();
    assert_eq!(texts, vec![vec!["S0-"], vec![""], vec!["-TAIL"]]);

    doc.restore_snapshot_native(snapshot)
        .expect("cross-section delete undo snapshot");
    doc.copy_selection_across_sections_native(0, 0, 3, 2, 1, 2)
        .expect("copy after snapshot restore");
    assert_eq!(
        doc.get_clipboard_text_native(),
        "HEAD\nS0-TAIL\nS1-ONLY\nS2-HEAD\nS2"
    );
}

#[test]
fn test_clipboard_copy_control() {
    let mut doc = create_doc_with_table();

    // 표 컨트롤 복사
    let result = doc.copy_control_native(0, 0, &[], 0);
    assert!(result.is_ok());
    let json = result.unwrap();
    assert!(json.contains("[표]"));

    // 클립보드 확인
    assert!(doc.has_internal_clipboard_native());
    let clip = doc.clipboard.as_ref().unwrap();
    assert_eq!(clip.paragraphs.len(), 1);
    assert_eq!(clip.paragraphs[0].controls.len(), 1);
    assert!(matches!(&clip.paragraphs[0].controls[0], Control::Table(_)));
}

#[test]
fn test_clipboard_copy_control_cell_path_json_arg() {
    // [Task #1161] copyControl 래퍼의 cell_path_json 인자: 빈 문자열/"[]" 는 본문.
    // (에러 경로는 JsValue 를 구성하므로 native 테스트에서 호출 불가 → OK 경로만 검증.
    //  cell 경로 자체는 tests/issue_1161_copy_picture_in_cell.rs 의 native 테스트로 가드.)
    let mut doc = create_doc_with_table();

    // 빈 문자열 = 본문 → 표 복사
    let r_empty = doc.copy_control(0, 0, "", 0);
    assert!(r_empty.is_ok(), "빈 cell_path_json 본문 복사 실패");
    assert!(r_empty.unwrap().contains("[표]"));

    // "[]" 도 본문
    let r_arr = doc.copy_control(0, 0, "[]", 0);
    assert!(r_arr.is_ok(), "[] cell_path_json 본문 복사 실패");
    assert!(r_arr.unwrap().contains("[표]"));
}

#[test]
fn cell_logical_length_keeps_text_after_inline_equation_in_select_all() {
    use crate::model::control::{Control, Equation};
    use crate::model::table::{Cell, Table};
    let mut doc = create_doc_with_table();
    let mut equation = Equation {
        script: "x".into(),
        ..Default::default()
    };
    equation.common.treat_as_char = true;
    let source = Paragraph {
        text: "ABC".into(),
        char_offsets: vec![0, 9, 10],
        char_count: 12,
        controls: vec![Control::Equation(Box::new(equation))],
        ..Default::default()
    };
    let Control::Table(table) = &mut doc.document.sections[0].paragraphs[0].controls[0] else {
        panic!("table");
    };
    table.cells[0].paragraphs = vec![source.clone()];
    let flat = r#"[{"controlIndex":0,"cellIndex":0,"cellParaIndex":0}]"#;
    assert_eq!(
        doc.get_cell_paragraph_length_by_path(0, 0, flat).unwrap(),
        3
    );
    assert_eq!(doc.get_cell_logical_length_by_path(0, 0, flat).unwrap(), 4);

    let Control::Table(table) = &mut doc.document.sections[0].paragraphs[0].controls[0] else {
        unreachable!()
    };
    table.cells[0].paragraphs = vec![Paragraph {
        controls: vec![Control::Table(Box::new(Table {
            row_count: 1,
            col_count: 1,
            cells: vec![Cell {
                paragraphs: vec![source],
                ..Default::default()
            }],
            ..Default::default()
        }))],
        ..Default::default()
    }];
    let nested = r#"[{"controlIndex":0,"cellIndex":0,"cellParaIndex":0},{"controlIndex":0,"cellIndex":0,"cellParaIndex":0}]"#;
    let end = doc.get_cell_logical_length_by_path(0, 0, nested).unwrap();
    assert_eq!(end, 4);
    doc.copy_selection_in_cell_by_path(0, 0, nested, 0, 0, 0, end)
        .unwrap();
    assert_eq!(doc.get_clipboard_text(), "ABC");
}

/// [Task #1161] 떠 있는 그림(tac=false)을 반복 붙여넣으면 cascade 오프셋이 누적된다.
fn create_doc_with_floating_picture(tac: bool, voff: u32, hoff: u32) -> HwpDocument {
    use crate::model::control::Control;
    use crate::model::document::{Section, SectionDef};
    use crate::model::image::Picture;
    use crate::model::page::PageDef;
    use crate::model::shape::CommonObjAttr;

    let mut doc = HwpDocument::create_empty();
    let mut document = Document::default();
    let page_def = PageDef {
        width: 59528,
        height: 84188,
        margin_left: 8504,
        margin_right: 8504,
        margin_top: 5669,
        margin_bottom: 4252,
        margin_header: 4252,
        margin_footer: 4252,
        ..Default::default()
    };
    let pic = Control::Picture(Box::new(Picture {
        common: CommonObjAttr {
            treat_as_char: tac,
            vertical_offset: voff,
            horizontal_offset: hoff,
            width: 5000,
            height: 5000,
            ..Default::default()
        },
        ..Default::default()
    }));
    let pic_para = Paragraph {
        controls: vec![pic],
        line_segs: vec![LineSeg {
            line_height: 400,
            baseline_distance: 320,
            ..Default::default()
        }],
        ..Default::default()
    };
    document.sections.push(Section {
        section_def: SectionDef {
            page_def,
            ..Default::default()
        },
        paragraphs: vec![pic_para, Paragraph::default()],
        raw_stream: None,
        raw_provenance: None,
    });
    doc.set_document(document);
    doc
}

fn collect_picture_voffsets(doc: &HwpDocument) -> Vec<u32> {
    use crate::model::control::Control;
    let mut offs = Vec::new();
    for sec in &doc.document.sections {
        for p in &sec.paragraphs {
            for c in &p.controls {
                if let Control::Picture(pic) = c {
                    offs.push(pic.common.vertical_offset);
                }
            }
        }
    }
    offs.sort_unstable();
    offs
}

#[test]
fn test_paste_cascade_floating_picture() {
    let mut doc = create_doc_with_floating_picture(false, 1000, 1000);
    doc.copy_control_native(0, 0, &[], 0).expect("copy");
    doc.paste_control_native(0, 1, 0).expect("paste1");
    doc.paste_control_native(0, 1, 0).expect("paste2");

    // 원본 1000, 붙여넣기 1000+567, 1000+2*567 (PASTE_CASCADE_STEP_HU=567)
    let offs = collect_picture_voffsets(&doc);
    assert_eq!(
        offs,
        vec![1000, 1567, 2134],
        "cascade 오프셋 누적 불일치: {offs:?}"
    );
}

#[test]
fn test_paste_inline_picture_no_cascade() {
    // tac=true(글자처럼 취급)는 텍스트 흐름이 위치를 정하므로 cascade 미적용(오프셋 불변).
    let mut doc = create_doc_with_floating_picture(true, 1000, 1000);
    doc.copy_control_native(0, 0, &[], 0).expect("copy");
    doc.paste_control_native(0, 1, 0).expect("paste1");
    doc.paste_control_native(0, 1, 0).expect("paste2");

    let offs = collect_picture_voffsets(&doc);
    assert_eq!(
        offs,
        vec![1000, 1000, 1000],
        "inline 그림에 cascade 적용됨: {offs:?}"
    );
}

/// 섹션 0에서 첫 번째 표 컨트롤의 (para_idx, ctrl_idx)를 찾는다.
fn find_table_pos(doc: &HwpDocument) -> (usize, usize) {
    use crate::model::control::Control;
    for (pi, p) in doc.document.sections[0].paragraphs.iter().enumerate() {
        for (ci, c) in p.controls.iter().enumerate() {
            if matches!(c, Control::Table(_)) {
                return (pi, ci);
            }
        }
    }
    panic!("표 컨트롤 없음");
}

/// #1323: 표 셀 안 이미지 붙여넣기 — merge_from 컨트롤 병합으로 그림·CTRL_DATA가
/// 보존되어야 한다. 수정 전에는 에러 없이 조용히 누락되었다.
#[test]
fn test_paste_picture_into_table_cell() {
    use crate::model::control::Control;

    let mut doc = create_doc_with_floating_picture(true, 0, 0);
    // CTRL_DATA 인덱스 정렬 검증용 레코드 부여
    doc.document.sections[0].paragraphs[0].ctrl_data_records = vec![Some(vec![7, 7, 7])];
    doc.copy_control_native(0, 0, &[], 0).expect("그림 복사");

    doc.create_table_ex_native(0, 1, 0, 2, 2, true, None, None)
        .expect("표 생성");
    let (t_para, t_ctrl) = find_table_pos(&doc);

    doc.paste_internal_in_cell_native(0, t_para, t_ctrl, 0, 0, 0)
        .expect("셀에 그림 붙여넣기");

    let table = match &doc.document.sections[0].paragraphs[t_para].controls[t_ctrl] {
        Control::Table(t) => t,
        other => panic!("표가 아님: {other:?}"),
    };
    let mut found = None;
    for p in &table.cells[0].paragraphs {
        for (i, c) in p.controls.iter().enumerate() {
            if matches!(c, Control::Picture(_)) {
                found = Some((p, i));
            }
        }
    }
    let (cell_para, pic_idx) = found.expect("셀 안에 그림 컨트롤이 보존되어야 한다 (#1323)");
    assert_eq!(
        cell_para.ctrl_data_records.get(pic_idx).cloned().flatten(),
        Some(vec![7, 7, 7]),
        "CTRL_DATA가 controls 인덱스 정렬을 유지한 채 보존되어야 한다"
    );
}

/// #1323: path 기반 셀 붙여넣기(paste_internal_in_cell_by_path)도 동일하게 그림을 보존한다.
#[test]
fn test_paste_picture_into_cell_by_path() {
    use crate::model::control::Control;

    let mut doc = create_doc_with_floating_picture(true, 0, 0);
    doc.copy_control_native(0, 0, &[], 0).expect("그림 복사");

    doc.create_table_ex_native(0, 1, 0, 2, 2, true, None, None)
        .expect("표 생성");
    let (t_para, t_ctrl) = find_table_pos(&doc);

    // path = [(ctrl_idx, cell_idx, cell_para_idx)] — 셀 1의 문단 0에 붙여넣기
    doc.paste_internal_in_cell_by_path_native(0, t_para, &[(t_ctrl, 1, 0)], 0)
        .expect("path 기반 셀 붙여넣기");

    let table = match &doc.document.sections[0].paragraphs[t_para].controls[t_ctrl] {
        Control::Table(t) => t,
        other => panic!("표가 아님: {other:?}"),
    };
    let pic_count: usize = table.cells[1]
        .paragraphs
        .iter()
        .map(|p| {
            p.controls
                .iter()
                .filter(|c| matches!(c, Control::Picture(_)))
                .count()
        })
        .sum();
    assert_eq!(
        pic_count, 1,
        "path 기반 붙여넣기에서도 그림 컨트롤이 보존되어야 한다 (#1323)"
    );
}

/// #1323: 그림 캡션 안 붙여넣기(Control::Picture 분기)도 컨트롤을 보존한다.
#[test]
fn test_paste_picture_into_picture_caption() {
    use crate::model::control::Control;
    use crate::model::shape::Caption;

    let mut doc = create_doc_with_floating_picture(true, 0, 0);
    doc.copy_control_native(0, 0, &[], 0).expect("그림 복사");

    // 본문 그림에 캡션 부여
    match &mut doc.document.sections[0].paragraphs[0].controls[0] {
        Control::Picture(p) => {
            p.caption = Some(Caption {
                paragraphs: vec![Paragraph::default()],
                ..Default::default()
            });
        }
        other => panic!("그림이 아님: {other:?}"),
    }

    doc.paste_internal_in_cell_native(0, 0, 0, 0, 0, 0)
        .expect("캡션에 그림 붙여넣기");

    let caption = match &doc.document.sections[0].paragraphs[0].controls[0] {
        Control::Picture(p) => p.caption.as_ref().expect("캡션 존재"),
        other => panic!("그림이 아님: {other:?}"),
    };
    let pic_count: usize = caption
        .paragraphs
        .iter()
        .map(|p| {
            p.controls
                .iter()
                .filter(|c| matches!(c, Control::Picture(_)))
                .count()
        })
        .sum();
    assert_eq!(
        pic_count, 1,
        "캡션 안에 붙여넣은 그림 컨트롤이 보존되어야 한다 (#1323)"
    );
}

/// #1323 부수 해소: 본문 문단 시작 Backspace 병합 시 병합 대상 문단의 컨트롤이
/// 보존되어야 한다 (수정 전에는 merge_from이 controls를 드롭).
#[test]
fn test_merge_paragraph_preserves_controls() {
    use crate::model::control::Control;

    let mut doc = create_doc_with_floating_picture(true, 0, 0);
    // 문단 1에 텍스트 입력 후 문단 0(그림 문단)으로 병합
    doc.insert_text_native(0, 1, 0, "가나")
        .expect("텍스트 입력");
    doc.merge_paragraph_native(0, 1).expect("문단 병합");

    let para = &doc.document.sections[0].paragraphs[0];
    assert_eq!(para.text, "가나");
    assert_eq!(
        para.controls
            .iter()
            .filter(|c| matches!(c, Control::Picture(_)))
            .count(),
        1,
        "백스페이스 병합 시 그림 컨트롤이 보존되어야 한다 (#1323)"
    );
    assert_eq!(
        para.control_text_positions(),
        vec![0],
        "그림은 병합된 텍스트 앞 위치를 유지해야 한다"
    );
}

/// #1323 부수 해소: 셀 문단 시작 Backspace 병합(merge_paragraph_in_cell) 시
/// 병합 대상 셀 문단의 컨트롤이 보존되어야 한다.
#[test]
fn test_merge_paragraph_in_cell_preserves_controls() {
    use crate::model::control::Control;

    let mut doc = create_doc_with_floating_picture(true, 0, 0);
    doc.create_table_ex_native(0, 1, 0, 2, 2, true, None, None)
        .expect("표 생성");
    let (t_para, t_ctrl) = find_table_pos(&doc);

    // 셀 0에 그림 문단을 두 번째 문단으로 구성
    let pic_para = doc.document.sections[0].paragraphs[0].clone();
    match &mut doc.document.sections[0].paragraphs[t_para].controls[t_ctrl] {
        Control::Table(t) => t.cells[0].paragraphs.push(pic_para),
        other => panic!("표가 아님: {other:?}"),
    }

    doc.merge_paragraph_in_cell_native(0, t_para, t_ctrl, 0, 1)
        .expect("셀 문단 병합");

    let table = match &doc.document.sections[0].paragraphs[t_para].controls[t_ctrl] {
        Control::Table(t) => t,
        other => panic!("표가 아님: {other:?}"),
    };
    assert_eq!(
        table.cells[0].paragraphs.len(),
        1,
        "셀 문단이 병합되어야 한다"
    );
    assert_eq!(
        table.cells[0].paragraphs[0]
            .controls
            .iter()
            .filter(|c| matches!(c, Control::Picture(_)))
            .count(),
        1,
        "셀 백스페이스 병합 시 그림 컨트롤이 보존되어야 한다 (#1323)"
    );
}

/// #1323: 셀에 그림을 붙여넣은 문서가 HWP5 직렬화 → 재파싱 후에도 그림을 보존한다.
/// (char_count 역산·char_offsets 갭 인코딩이 직렬화 계약과 정합함을 검증)
#[test]
fn test_paste_picture_into_table_cell_hwp5_roundtrip() {
    use crate::model::control::Control;

    let mut doc = create_doc_with_floating_picture(true, 0, 0);
    doc.copy_control_native(0, 0, &[], 0).expect("그림 복사");
    doc.create_table_ex_native(0, 1, 0, 2, 2, true, None, None)
        .expect("표 생성");
    let (t_para, t_ctrl) = find_table_pos(&doc);
    doc.paste_internal_in_cell_native(0, t_para, t_ctrl, 0, 0, 0)
        .expect("셀에 그림 붙여넣기");

    let bytes = doc.export_hwp_native().expect("HWP5 직렬화");
    let doc2 = HwpDocument::from_bytes(&bytes).expect("재파싱");

    let mut found = false;
    for p in &doc2.document.sections[0].paragraphs {
        for c in &p.controls {
            if let Control::Table(t) = c {
                for cell_para in t.cells.iter().flat_map(|cl| cl.paragraphs.iter()) {
                    if cell_para
                        .controls
                        .iter()
                        .any(|cc| matches!(cc, Control::Picture(_)))
                    {
                        found = true;
                    }
                }
            }
        }
    }
    assert!(
        found,
        "HWP5 round-trip 후에도 셀 안 그림 컨트롤이 보존되어야 한다 (#1323)"
    );
}

/// #1323 시각 검증 보조: 표 셀/글상자에 붙여넣은 그림이 SVG 렌더링에 실제
/// `<image>` 요소로 나타나는지 검증한다. BinData를 실제 등록(insert_picture)하여
/// 렌더러가 data URI 이미지를 방출하는 경로를 그대로 사용한다.
#[test]
fn test_paste_picture_into_cell_and_textbox_renders_in_svg() {
    fn minimal_png() -> Vec<u8> {
        vec![
            0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48,
            0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00,
            0x00, 0x1F, 0x15, 0xC4, 0x89, 0x00, 0x00, 0x00, 0x0A, 0x49, 0x44, 0x41, 0x54, 0x78,
            0x9C, 0x63, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0D, 0x0A, 0x00, 0x00, 0x00,
            0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
        ]
    }
    fn parse_idx(res: &str, key: &str) -> usize {
        res.split(&format!("\"{}\":", key))
            .nth(1)
            .and_then(|s| s.split(|c: char| !c.is_ascii_digit()).next())
            .and_then(|s| s.parse().ok())
            .unwrap_or_else(|| panic!("missing {key} in {res}"))
    }
    fn count_images(svg: &str) -> usize {
        svg.matches("<image").count()
    }

    let mut doc = create_doc_with_floating_picture(true, 0, 0);
    // 헬퍼의 기본 그림은 BinData가 없으므로 실제 그림을 별도 삽입해 사용한다
    let res = doc
        .insert_picture_native(
            0,
            1,
            0,
            &[],
            &minimal_png(),
            5000,
            5000,
            1,
            1,
            "png",
            "",
            None,
            None,
        )
        .expect("본문 그림 삽입");
    let pic_para = parse_idx(&res, "paraIdx");
    let pic_ctrl = parse_idx(&res, "controlIdx");

    let svg_before = doc.render_page_svg_native(0).expect("기준 SVG 렌더");
    let base = count_images(&svg_before);
    assert!(base >= 1, "본문 그림이 SVG에 렌더되어야 한다: {base}");

    doc.copy_control_native(0, pic_para, &[], pic_ctrl)
        .expect("그림 복사");

    // 표 셀에 붙여넣기 → <image> 1개 증가
    // (기존 문단은 모두 그림 컨트롤을 보유하므로 표 전용 빈 문단을 추가)
    doc.document.sections[0]
        .paragraphs
        .push(Paragraph::default());
    let empty_para = doc.document.sections[0].paragraphs.len() - 1;
    doc.create_table_ex_native(0, empty_para, 0, 2, 2, true, None, None)
        .expect("표 생성");
    let (t_para, t_ctrl) = find_table_pos(&doc);
    doc.paste_internal_in_cell_native(0, t_para, t_ctrl, 0, 0, 0)
        .expect("셀에 그림 붙여넣기");

    let svg_cell = doc.render_page_svg_native(0).expect("셀 paste 후 SVG 렌더");
    assert_eq!(
        count_images(&svg_cell),
        base + 1,
        "셀에 붙여넣은 그림이 SVG에 렌더되어야 한다 (#1323)"
    );

    // 글상자에 붙여넣기 → <image> 1개 더 증가
    let tb_res = doc
        .create_shape_control_native(
            0,
            t_para,
            0,
            21600,
            7200,
            0,
            0,
            true,
            "TopAndBottom",
            "textbox",
            false,
            false,
            &[],
        )
        .expect("글상자 생성");
    let tb_para = parse_idx(&tb_res, "paraIdx");
    let tb_ctrl = parse_idx(&tb_res, "controlIdx");
    doc.paste_internal_in_cell_native(0, tb_para, tb_ctrl, 0, 0, 0)
        .expect("글상자에 그림 붙여넣기");

    let svg_tb = doc
        .render_page_svg_native(0)
        .expect("글상자 paste 후 SVG 렌더");
    assert_eq!(
        count_images(&svg_tb),
        base + 2,
        "글상자에 붙여넣은 그림이 SVG에 렌더되어야 한다 (#1323)"
    );
}

#[test]
fn test_clipboard_clear() {
    let mut doc = HwpDocument::create_empty();
    let mut document = Document::default();
    let mut para = Paragraph::default();
    para.text = "테스트".to_string();
    para.char_count = 4;
    para.char_offsets = vec![0, 1, 2];
    para.char_shapes = vec![crate::model::paragraph::CharShapeRef {
        start_pos: 0,
        char_shape_id: 0,
    }];
    para.line_segs = vec![crate::model::paragraph::LineSeg::default()];
    para.has_para_text = true;
    document.sections.push(Section {
        paragraphs: vec![para],
        ..Default::default()
    });
    doc.set_document(document);

    // 복사
    doc.copy_selection_native(0, 0, 0, 0, 3).unwrap();
    assert!(doc.has_internal_clipboard_native());

    // 초기화
    doc.clear_clipboard_native();
    assert!(!doc.has_internal_clipboard_native());
    assert_eq!(doc.get_clipboard_text_native(), "");
}

#[test]
fn test_clipboard_paste_empty() {
    let mut doc = HwpDocument::create_empty();
    let mut document = Document::default();
    let mut para = Paragraph::default();
    para.text = "테스트".to_string();
    para.char_count = 4;
    para.char_offsets = vec![0, 1, 2];
    para.char_shapes = vec![crate::model::paragraph::CharShapeRef {
        start_pos: 0,
        char_shape_id: 0,
    }];
    para.line_segs = vec![crate::model::paragraph::LineSeg::default()];
    para.has_para_text = true;
    document.sections.push(Section {
        paragraphs: vec![para],
        ..Default::default()
    });
    doc.set_document(document);

    // 클립보드 비어있는 상태에서 붙여넣기
    let result = doc.paste_internal_native(0, 0, 0);
    assert!(result.is_ok());
    let json = result.unwrap();
    assert!(json.contains("\"ok\":false"));
}

#[test]
fn test_export_selection_html_basic() {
    let mut doc = HwpDocument::create_empty();
    let mut document = Document::default();

    // CharShape 추가 (bold)
    let mut cs = crate::model::style::CharShape::default();
    cs.base_size = 1200; // 12pt
    cs.bold = true;
    document.doc_info.char_shapes.push(cs);

    // ParaShape 추가 (center align)
    let mut ps = crate::model::style::ParaShape::default();
    ps.alignment = crate::model::style::Alignment::Center;
    document.doc_info.para_shapes.push(ps);

    let mut para = Paragraph::default();
    para.text = "Hello World".to_string();
    para.char_count = 12;
    para.char_offsets = (0..11).collect();
    para.char_shapes = vec![crate::model::paragraph::CharShapeRef {
        start_pos: 0,
        char_shape_id: 0,
    }];
    para.para_shape_id = 0;
    para.line_segs = vec![crate::model::paragraph::LineSeg::default()];
    para.has_para_text = true;

    document.sections.push(Section {
        paragraphs: vec![para],
        ..Default::default()
    });
    doc.set_document(document);

    // HTML 내보내기
    let result = doc.export_selection_html_native(0, 0, 0, 0, 11);
    assert!(result.is_ok());
    let html = result.unwrap();

    // 기본 구조 확인
    assert!(html.contains("<!--StartFragment-->"));
    assert!(html.contains("<!--EndFragment-->"));
    assert!(html.contains("Hello World"));
    assert!(html.contains("<p "));
    assert!(html.contains("<span "));
    assert!(html.contains("text-align:center"));
}

#[test]
fn test_export_selection_html_partial() {
    let mut doc = HwpDocument::create_empty();
    let mut document = Document::default();

    document
        .doc_info
        .char_shapes
        .push(crate::model::style::CharShape::default());
    document
        .doc_info
        .para_shapes
        .push(crate::model::style::ParaShape::default());

    let mut para = Paragraph::default();
    para.text = "ABCDE".to_string();
    para.char_count = 6;
    para.char_offsets = (0..5).collect();
    para.char_shapes = vec![crate::model::paragraph::CharShapeRef {
        start_pos: 0,
        char_shape_id: 0,
    }];
    para.line_segs = vec![crate::model::paragraph::LineSeg::default()];
    para.has_para_text = true;

    document.sections.push(Section {
        paragraphs: vec![para],
        ..Default::default()
    });
    doc.set_document(document);

    // 부분 선택 (B, C, D)
    let result = doc.export_selection_html_native(0, 0, 1, 0, 4);
    assert!(result.is_ok());
    let html = result.unwrap();

    assert!(html.contains("BCD"));
    // "ABCDE" 전체 문자열이 포함되지 않아야 함
    assert!(!html.contains("ABCDE"));
    // 정확히 BCD만 span 안에 있는지 확인
    assert!(html.contains(">BCD<"));
}

#[test]
fn test_export_control_html_table() {
    let mut doc = create_doc_with_table();

    let result = doc.export_control_html_native(0, 0, &[], 0);
    assert!(result.is_ok());
    let html = result.unwrap();

    assert!(html.contains("<table"));
    assert!(html.contains("</table>"));
    assert!(html.contains("<td"));
    assert!(html.contains("<tr>"));
}

// === HTML 붙여넣기 테스트 ===

#[test]
fn test_paste_html_plain_text() {
    let mut doc = HwpDocument::create_empty();
    let mut document = Document::default();
    document
        .doc_info
        .char_shapes
        .push(crate::model::style::CharShape::default());
    document
        .doc_info
        .para_shapes
        .push(crate::model::style::ParaShape::default());
    let mut para = Paragraph::default();
    para.text = "가나다".to_string();
    para.char_count = para.text.encode_utf16().count() as u32;
    para.char_offsets = para
        .text
        .chars()
        .scan(0u32, |acc, c| {
            let off = *acc;
            *acc += c.len_utf16() as u32;
            Some(off)
        })
        .collect();
    para.line_segs = vec![crate::model::paragraph::LineSeg::default()];
    para.has_para_text = true;
    document.sections.push(Section {
        paragraphs: vec![para],
        ..Default::default()
    });
    doc.set_document(document);

    // 플레인 텍스트 HTML 붙여넣기
    let html = "<html><body><!--StartFragment--><p>안녕하세요</p><!--EndFragment--></body></html>";
    let result = doc.paste_html_native(0, 0, 3, html);
    assert!(result.is_ok());
    let json = result.unwrap();
    assert!(json.contains("\"ok\":true"));

    // 삽입 후 텍스트 확인
    let text = &doc.document.sections[0].paragraphs[0].text;
    assert!(text.contains("안녕하세요"));
    assert!(text.contains("가나다"));
}

#[test]
fn test_paste_html_styled_text() {
    let mut doc = HwpDocument::create_empty();
    let mut document = Document::default();
    document
        .doc_info
        .char_shapes
        .push(crate::model::style::CharShape::default());
    document
        .doc_info
        .para_shapes
        .push(crate::model::style::ParaShape::default());
    let mut para = Paragraph::default();
    para.text = "테스트".to_string();
    para.char_count = para.text.encode_utf16().count() as u32;
    para.char_offsets = para
        .text
        .chars()
        .scan(0u32, |acc, c| {
            let off = *acc;
            *acc += c.len_utf16() as u32;
            Some(off)
        })
        .collect();
    para.line_segs = vec![crate::model::paragraph::LineSeg::default()];
    para.has_para_text = true;
    document.sections.push(Section {
        paragraphs: vec![para],
        ..Default::default()
    });
    doc.set_document(document);

    // 볼드+색상 스타일 HTML
    let html = r#"<html><body><!--StartFragment-->
            <p style="text-align:center;">
                <span style="font-weight:bold;color:#ff0000;">볼드 빨강</span>
            </p>
        <!--EndFragment--></body></html>"#;

    let result = doc.paste_html_native(0, 0, 0, html);
    assert!(result.is_ok());
    let json = result.unwrap();
    assert!(json.contains("\"ok\":true"));

    // CharShape가 추가되었는지 확인 (bold + red color)
    let char_shapes_count = doc.document.doc_info.char_shapes.len();
    assert!(char_shapes_count > 1, "새 CharShape가 생성되어야 함");

    // 볼드 속성 확인
    let bold_shape = doc.document.doc_info.char_shapes.iter().find(|cs| cs.bold);
    assert!(bold_shape.is_some(), "볼드 CharShape가 존재해야 함");
}

#[test]
fn test_paste_html_multi_paragraph() {
    let mut doc = HwpDocument::create_empty();
    let mut document = Document::default();
    document
        .doc_info
        .char_shapes
        .push(crate::model::style::CharShape::default());
    document
        .doc_info
        .para_shapes
        .push(crate::model::style::ParaShape::default());
    let mut para = Paragraph::default();
    para.text = "원본".to_string();
    para.char_count = para.text.encode_utf16().count() as u32;
    para.char_offsets = para
        .text
        .chars()
        .scan(0u32, |acc, c| {
            let off = *acc;
            *acc += c.len_utf16() as u32;
            Some(off)
        })
        .collect();
    para.line_segs = vec![crate::model::paragraph::LineSeg::default()];
    para.has_para_text = true;
    document.sections.push(Section {
        paragraphs: vec![para],
        ..Default::default()
    });
    doc.set_document(document);

    // 다중 문단 HTML
    let html = r#"<html><body><!--StartFragment-->
            <p>첫째 문단</p>
            <p>둘째 문단</p>
            <p>셋째 문단</p>
        <!--EndFragment--></body></html>"#;

    let result = doc.paste_html_native(0, 0, 2, html);
    assert!(result.is_ok());
    let json = result.unwrap();
    assert!(json.contains("\"ok\":true"));

    // 문단 수 확인 (원본 1 + 삽입 3 = 최소 3)
    let para_count = doc.document.sections[0].paragraphs.len();
    assert!(
        para_count >= 3,
        "최소 3개 문단이어야 함, 실제: {}",
        para_count
    );
}

#[test]
fn test_paste_html_table_as_control() {
    let mut doc = HwpDocument::create_empty();
    let mut document = Document::default();
    document
        .doc_info
        .char_shapes
        .push(crate::model::style::CharShape::default());
    document
        .doc_info
        .para_shapes
        .push(crate::model::style::ParaShape::default());
    document
        .doc_info
        .border_fills
        .push(crate::model::style::BorderFill::default());
    let mut para = Paragraph::default();
    para.text = "".to_string();
    para.char_count = 0;
    para.line_segs = vec![crate::model::paragraph::LineSeg::default()];
    para.has_para_text = true;
    document.sections.push(Section {
        paragraphs: vec![para],
        ..Default::default()
    });
    doc.set_document(document);

    // 2×2 표 HTML
    let html = r#"<html><body><!--StartFragment-->
            <table><tr><td>셀1</td><td>셀2</td></tr><tr><td>셀3</td><td>셀4</td></tr></table>
        <!--EndFragment--></body></html>"#;

    let result = doc.paste_html_native(0, 0, 0, html);
    assert!(result.is_ok());
    let json = result.unwrap();
    assert!(json.contains("\"ok\":true"));

    // Table Control이 삽입되었는지 확인
    let paras = &doc.document.sections[0].paragraphs;
    let table_para = paras.iter().find(|p| !p.controls.is_empty());
    assert!(
        table_para.is_some(),
        "Table Control을 포함하는 문단이 있어야 함"
    );

    let table_para = table_para.unwrap();
    assert!(
        table_para.text.is_empty(),
        "컨트롤 문단의 text는 비어있어야 함"
    );
    assert_eq!(table_para.controls.len(), 1);

    if let Control::Table(ref tbl) = table_para.controls[0] {
        assert_eq!(tbl.row_count, 2, "행 수 2");
        assert_eq!(tbl.col_count, 2, "열 수 2");
        assert_eq!(tbl.cells.len(), 4, "셀 4개");

        // 셀 내용 확인
        let cell_texts: Vec<String> = tbl
            .cells
            .iter()
            .map(|c| {
                c.paragraphs
                    .iter()
                    .map(|p| p.text.clone())
                    .collect::<Vec<_>>()
                    .join("")
            })
            .collect();
        assert!(cell_texts.iter().any(|t| t.contains("셀1")), "셀1 포함");
        assert!(cell_texts.iter().any(|t| t.contains("셀2")), "셀2 포함");
        assert!(cell_texts.iter().any(|t| t.contains("셀3")), "셀3 포함");
        assert!(cell_texts.iter().any(|t| t.contains("셀4")), "셀4 포함");

        // 정상 파일 패턴과 일치하는 속성값 검증
        assert_eq!(tbl.attr, 0x082A2311, "table.attr = 0x082A2311");
        assert_eq!(
            tbl.raw_table_record_attr, 0x04000006,
            "raw_table_record_attr (DIFF-5: 셀분리금지 항상 설정)"
        );
        assert_eq!(tbl.padding.left, 510, "table padding left");
        assert_eq!(tbl.padding.right, 510, "table padding right");
        assert_eq!(tbl.padding.top, 141, "table padding top");
        assert_eq!(tbl.padding.bottom, 141, "table padding bottom");

        // 셀 속성 검증
        for cell in &tbl.cells {
            assert_eq!(
                cell.vertical_align,
                crate::model::table::VerticalAlign::Center,
                "Cell({},{}) v_align=Center",
                cell.row,
                cell.col
            );
            assert!(cell.raw_list_extra.len() >= 2, "raw_list_extra >= 2 bytes");
        }

        // table_para 속성 검증
        assert_eq!(table_para.char_count, 9, "table para char_count=9");
        assert_eq!(table_para.control_mask, 0x00000800, "control_mask=0x800");
        assert!(
            table_para.raw_header_extra.len() >= 10,
            "raw_header_extra >= 10"
        );
        let inst = u32::from_le_bytes([
            table_para.raw_header_extra[6],
            table_para.raw_header_extra[7],
            table_para.raw_header_extra[8],
            table_para.raw_header_extra[9],
        ]);
        assert_eq!(inst, 0x80000000, "table para instance_id=0x80000000");

        // DIFF-7: CTRL_HEADER instance_id (raw_ctrl_data[32..36]) 가 0이 아닌지 검증
        assert!(tbl.raw_ctrl_data.len() >= 36, "raw_ctrl_data >= 36 bytes");
        let common = parse_common_obj_attr(&tbl.raw_ctrl_data);
        assert_eq!(
            common.attr, tbl.attr,
            "HTML table raw_ctrl_data[0..4] must carry CommonObjAttr attr"
        );
        assert_eq!(
            (common.width, common.height),
            (
                tbl.get_column_widths().iter().sum(),
                tbl.get_row_heights().iter().sum()
            ),
            "HTML table raw_ctrl_data width/height offsets must match parser layout"
        );
        assert_eq!(
            (
                common.margin.left,
                common.margin.right,
                common.margin.top,
                common.margin.bottom
            ),
            (
                tbl.outer_margin_left,
                tbl.outer_margin_right,
                tbl.outer_margin_top,
                tbl.outer_margin_bottom
            ),
            "HTML table raw_ctrl_data margin offsets must match parser layout"
        );
        let ctrl_instance_id = common.instance_id;
        assert_ne!(
            ctrl_instance_id, 0,
            "DIFF-7: CTRL_HEADER instance_id != 0 (got 0x{:08X})",
            ctrl_instance_id
        );
    } else {
        panic!("첫 번째 컨트롤이 Table이어야 함");
    }
}

/// DIFF-1 검증: &nbsp; 만 있는 빈 셀이 char_count=1, has_para_text=false 인지 확인
#[test]
fn test_diff1_empty_cell_nbsp() {
    let mut doc = HwpDocument::create_empty();
    let mut document = Document::default();
    document
        .doc_info
        .char_shapes
        .push(crate::model::style::CharShape::default());
    document
        .doc_info
        .para_shapes
        .push(crate::model::style::ParaShape::default());
    document
        .doc_info
        .border_fills
        .push(crate::model::style::BorderFill::default());
    let mut para = Paragraph::default();
    para.text = "".to_string();
    para.char_count = 0;
    para.line_segs = vec![crate::model::paragraph::LineSeg::default()];
    document.sections.push(crate::model::document::Section {
        paragraphs: vec![para],
        ..Default::default()
    });
    doc.document = document;

    // &nbsp; 만 포함된 셀이 있는 2×2 표 (셀2, 셀4는 빈 셀)
    let html = r#"<table><tr><td>내용1</td><td>&nbsp;</td></tr><tr><td>내용2</td><td>&nbsp;&nbsp;&nbsp;</td></tr></table>"#;
    let mut paragraphs = Vec::new();
    doc.parse_table_html(&mut paragraphs, html);

    assert_eq!(paragraphs.len(), 1, "표 문단 1개");
    if let crate::model::control::Control::Table(ref tbl) = paragraphs[0].controls[0] {
        assert_eq!(tbl.cells.len(), 4, "4 셀");
        // 셀[0]: "내용1" → 텍스트 있음
        assert!(
            !tbl.cells[0].paragraphs[0].text.is_empty(),
            "셀[0] 텍스트 있음"
        );
        // 셀[1]: &nbsp; → 빈 셀
        let empty1 = &tbl.cells[1].paragraphs[0];
        assert_eq!(empty1.char_count, 1, "DIFF-1: &nbsp; 셀은 char_count=1");
        assert!(empty1.text.is_empty(), "DIFF-1: &nbsp; 셀은 text 비어있음");
        assert!(
            !empty1.has_para_text,
            "DIFF-1: &nbsp; 셀은 has_para_text=false"
        );
        // 셀[3]: &nbsp;&nbsp;&nbsp; → 빈 셀
        let empty2 = &tbl.cells[3].paragraphs[0];
        assert_eq!(
            empty2.char_count, 1,
            "DIFF-1: 다중 &nbsp; 셀은 char_count=1"
        );
        assert!(
            empty2.text.is_empty(),
            "DIFF-1: 다중 &nbsp; 셀은 text 비어있음"
        );
        assert!(
            !empty2.has_para_text,
            "DIFF-1: 다중 &nbsp; 셀은 has_para_text=false"
        );
    } else {
        panic!("Table 컨트롤이어야 함");
    }
}

#[test]
fn test_paste_html_table_with_colspan_rowspan() {
    let mut doc = HwpDocument::create_empty();
    let mut document = Document::default();
    document
        .doc_info
        .char_shapes
        .push(crate::model::style::CharShape::default());
    document
        .doc_info
        .para_shapes
        .push(crate::model::style::ParaShape::default());
    document
        .doc_info
        .border_fills
        .push(crate::model::style::BorderFill::default());
    let mut para = Paragraph::default();
    para.text = "".to_string();
    para.char_count = 0;
    para.line_segs = vec![crate::model::paragraph::LineSeg::default()];
    para.has_para_text = true;
    document.sections.push(Section {
        paragraphs: vec![para],
        ..Default::default()
    });
    doc.set_document(document);

    // colspan=2, rowspan=2 포함 표
    let html = r#"<html><body><!--StartFragment-->
            <table>
                <tr><td colspan="2">병합열</td><td>C</td></tr>
                <tr><td rowspan="2">병합행</td><td>B2</td><td>C2</td></tr>
                <tr><td>B3</td><td>C3</td></tr>
            </table>
        <!--EndFragment--></body></html>"#;

    let result = doc.paste_html_native(0, 0, 0, html);
    assert!(result.is_ok());

    let paras = &doc.document.sections[0].paragraphs;
    let table_para = paras.iter().find(|p| !p.controls.is_empty());
    assert!(table_para.is_some(), "Table Control 문단이 있어야 함");

    if let Control::Table(ref tbl) = table_para.unwrap().controls[0] {
        assert_eq!(tbl.row_count, 3, "행 수 3");
        assert_eq!(tbl.col_count, 3, "열 수 3");

        // colspan=2인 셀 확인
        let merged_col = tbl.cells.iter().find(|c| c.col_span == 2);
        assert!(merged_col.is_some(), "colspan=2 셀이 있어야 함");
        assert_eq!(merged_col.unwrap().row, 0);

        // rowspan=2인 셀 확인
        let merged_row = tbl.cells.iter().find(|c| c.row_span == 2);
        assert!(merged_row.is_some(), "rowspan=2 셀이 있어야 함");
        assert_eq!(merged_row.unwrap().col, 0);
        assert_eq!(merged_row.unwrap().row, 1);
    } else {
        panic!("Table Control이어야 함");
    }
}

#[test]
fn test_paste_html_table_with_css_styles() {
    let mut doc = HwpDocument::create_empty();
    let mut document = Document::default();
    document
        .doc_info
        .char_shapes
        .push(crate::model::style::CharShape::default());
    document
        .doc_info
        .para_shapes
        .push(crate::model::style::ParaShape::default());
    document
        .doc_info
        .border_fills
        .push(crate::model::style::BorderFill::default());
    let mut para = Paragraph::default();
    para.text = "".to_string();
    para.char_count = 0;
    para.line_segs = vec![crate::model::paragraph::LineSeg::default()];
    para.has_para_text = true;
    document.sections.push(Section {
        paragraphs: vec![para],
        ..Default::default()
    });
    doc.set_document(document);

    // CSS 스타일 포함 표
    let html = r#"<html><body><!--StartFragment-->
            <table style="border-collapse:collapse;">
                <tr>
                    <td style="width:38.50pt;height:21.31pt;border-top:solid #000000 0.28pt;border-bottom:solid #000000 0.28pt;border-left:solid #000000 0.28pt;border-right:solid #000000 0.28pt;padding:1.41pt 5.10pt;">데이터1</td>
                    <td style="width:50pt;height:21.31pt;background-color:#FFFF00;">데이터2</td>
                </tr>
            </table>
        <!--EndFragment--></body></html>"#;

    let result = doc.paste_html_native(0, 0, 0, html);
    assert!(result.is_ok());

    let paras = &doc.document.sections[0].paragraphs;
    let table_para = paras.iter().find(|p| !p.controls.is_empty());
    assert!(table_para.is_some());

    if let Control::Table(ref tbl) = table_para.unwrap().controls[0] {
        assert_eq!(tbl.row_count, 1);
        assert_eq!(tbl.col_count, 2);
        assert_eq!(tbl.cells.len(), 2);

        // 첫 번째 셀: width=38.50pt → 3850 HWPUNIT
        let cell0 = &tbl.cells[0];
        assert!(
            cell0.width > 3800 && cell0.width < 3900,
            "셀 폭 ~3850, 실제: {}",
            cell0.width
        );

        // 두 번째 셀: background-color → BorderFill에 등록
        let cell1 = &tbl.cells[1];
        assert!(cell1.border_fill_id > 0, "border_fill_id가 설정되어야 함");

        // 패딩 확인 (1.41pt ≈ 141, 5.10pt ≈ 510)
        assert!(
            cell0.padding.top > 130 && cell0.padding.top < 150,
            "상단 패딩 ~141, 실제: {}",
            cell0.padding.top
        );
        assert!(
            cell0.padding.left > 500 && cell0.padding.left < 520,
            "좌측 패딩 ~510, 실제: {}",
            cell0.padding.left
        );
    } else {
        panic!("Table Control이어야 함");
    }
}

#[test]
fn test_paste_html_table_with_th_header() {
    let mut doc = HwpDocument::create_empty();
    let mut document = Document::default();
    document
        .doc_info
        .char_shapes
        .push(crate::model::style::CharShape::default());
    document
        .doc_info
        .para_shapes
        .push(crate::model::style::ParaShape::default());
    document
        .doc_info
        .border_fills
        .push(crate::model::style::BorderFill::default());
    let mut para = Paragraph::default();
    para.text = "".to_string();
    para.char_count = 0;
    para.line_segs = vec![crate::model::paragraph::LineSeg::default()];
    para.has_para_text = true;
    document.sections.push(Section {
        paragraphs: vec![para],
        ..Default::default()
    });
    doc.set_document(document);

    // <th> 헤더 포함 표
    let html = r#"<html><body><!--StartFragment-->
            <table>
                <tr><th>이름</th><th>나이</th></tr>
                <tr><td>홍길동</td><td>30</td></tr>
            </table>
        <!--EndFragment--></body></html>"#;

    let result = doc.paste_html_native(0, 0, 0, html);
    assert!(result.is_ok());

    let paras = &doc.document.sections[0].paragraphs;
    let table_para = paras.iter().find(|p| !p.controls.is_empty());
    assert!(table_para.is_some());

    if let Control::Table(ref tbl) = table_para.unwrap().controls[0] {
        assert_eq!(tbl.row_count, 2);
        assert_eq!(tbl.col_count, 2);
        assert!(tbl.repeat_header, "헤더 반복 활성화");

        // 첫 행 셀이 is_header=true
        let header_cells: Vec<_> = tbl.cells.iter().filter(|c| c.is_header).collect();
        assert_eq!(header_cells.len(), 2, "헤더 셀 2개");
    } else {
        panic!("Table Control이어야 함");
    }
}

#[test]
fn test_table_utility_functions() {
    // parse_css_dimension_pt
    assert!((super::parse_css_dimension_pt("width:38.50pt", "width") - 38.5).abs() < 0.01);
    assert!((super::parse_css_dimension_pt("width:100px", "width") - 75.0).abs() < 0.01);
    assert!((super::parse_css_dimension_pt("height:1cm", "height") - 28.3465).abs() < 0.1);
    assert_eq!(super::parse_css_dimension_pt("width:auto", "width"), 0.0);

    // parse_css_padding_pt
    let p = super::parse_css_padding_pt("padding:1.41pt 5.10pt");
    assert!((p[0] - 5.10).abs() < 0.01, "left = 5.10"); // left
    assert!((p[1] - 5.10).abs() < 0.01, "right = 5.10"); // right
    assert!((p[2] - 1.41).abs() < 0.01, "top = 1.41"); // top
    assert!((p[3] - 1.41).abs() < 0.01, "bottom = 1.41"); // bottom

    // parse_css_border_shorthand
    let (w, c, s) = super::parse_css_border_shorthand("solid #000000 0.28pt");
    assert!((w - 0.28).abs() < 0.01, "border width 0.28pt");
    assert_eq!(c, 0x000000, "border color black");
    assert_eq!(s, 1, "border style solid");

    let (w2, _, s2) = super::parse_css_border_shorthand("none");
    assert_eq!(w2, 0.0);
    assert_eq!(s2, 0);

    // rgb() 내부에 공백이 있어도 색상 토큰이 쪼개지지 않아야 한다.
    let (w3, c3, s3) = super::parse_css_border_shorthand("1px solid rgb(255, 0, 0)");
    assert!((w3 - 0.75).abs() < 0.01, "border width 1px -> 0.75pt");
    assert_eq!(c3, 0x0000FF, "border color red (BGR)");
    assert_eq!(s3, 1, "border style solid");

    // css_border_width_to_hwp
    assert_eq!(super::css_border_width_to_hwp(0.28), 0); // 0.28pt ≈ 0.1mm → index 0
    assert!(super::css_border_width_to_hwp(1.0) >= 5); // 1.0pt ≈ 0.35mm → index 5+

    // parse_html_attr_u16
    assert_eq!(
        super::parse_html_attr_u16(r#"<td colspan="3">"#, "colspan"),
        Some(3)
    );
    assert_eq!(super::parse_html_attr_u16(r#"<td>"#, "colspan"), None);
}

#[test]
fn test_css_color_rgba_and_border_width_keywords() {
    // rgba() 색상: 브라우저는 반투명/알파 포함 색을 rgba(r, g, b, a)로 직렬화한다.
    assert_eq!(
        super::css_color_to_hwp_bgr("rgba(255, 0, 0, 1)"),
        Some(0x0000FF),
        "rgba() 불투명 빨강 → BGR"
    );
    assert_eq!(
        super::css_color_to_hwp_bgr("rgba(0, 128, 255, 0.5)"),
        Some(0xFF8000),
        "rgba() 반투명 색도 RGB 성분은 파싱되어야 함"
    );
    // 완전 투명(alpha=0)은 색 없음으로 처리
    assert_eq!(
        super::css_color_to_hwp_bgr("rgba(255, 0, 0, 0)"),
        None,
        "rgba() alpha=0 → 색 없음"
    );

    // border 축약형의 rgba() 색상
    let (w, c, s) = super::parse_css_border_shorthand("1px solid rgba(255, 0, 0, 1)");
    assert!((w - 0.75).abs() < 0.01, "border width 1px -> 0.75pt");
    assert_eq!(c, 0x0000FF, "border rgba() 색상 빨강 (BGR)");
    assert_eq!(s, 1, "border style solid");

    // CSS 표준 border-width 키워드: thin(1px)/medium(3px)/thick(5px)
    // 키워드를 인식하지 못하면 width 0 → 테두리 전체가 소실된다.
    let (w_thin, _, s_thin) = super::parse_css_border_shorthand("thin solid #000000");
    assert!((w_thin - 0.75).abs() < 0.01, "thin = 1px = 0.75pt");
    assert_eq!(s_thin, 1);

    let (w_med, c_med, _) = super::parse_css_border_shorthand("medium solid #ff0000");
    assert!((w_med - 2.25).abs() < 0.01, "medium = 3px = 2.25pt");
    assert_eq!(c_med, 0x0000FF);

    let (w_thick, _, _) = super::parse_css_border_shorthand("thick solid #000000");
    assert!((w_thick - 3.75).abs() < 0.01, "thick = 5px = 3.75pt");
}

#[test]
fn test_html_utility_functions() {
    // decode_html_entities
    assert_eq!(super::decode_html_entities("&amp;&lt;&gt;"), "&<>");
    assert_eq!(super::decode_html_entities("&nbsp;"), " ");

    // html_strip_tags
    assert_eq!(super::html_strip_tags("<b>bold</b>"), "bold");
    assert_eq!(super::html_strip_tags("<p>text<br/>more</p>"), "textmore");

    // html_to_plain_text
    assert_eq!(
        super::html_to_plain_text("<p>hello &amp; world</p>"),
        "hello & world"
    );

    // parse_inline_style
    assert_eq!(
        super::parse_inline_style(r#"<p style="text-align:center;font-size:12pt;">"#),
        "text-align:center;font-size:12pt;"
    );

    // parse_css_value
    assert_eq!(
        super::parse_css_value("text-align:center;font-size:12pt;", "text-align"),
        Some("center".to_string())
    );
    assert_eq!(
        super::parse_css_value("font-size:12pt;", "font-size"),
        Some("12pt".to_string())
    );

    // parse_pt_value
    assert_eq!(super::parse_pt_value("10.0pt"), Some(10.0));
    assert_eq!(super::parse_pt_value("12px"), Some(9.0)); // 12 * 0.75

    // css_color_to_hwp_bgr
    assert_eq!(super::css_color_to_hwp_bgr("#ff0000"), Some(0x0000FF)); // red → BGR
    assert_eq!(super::css_color_to_hwp_bgr("#00ff00"), Some(0x00FF00)); // green
    assert_eq!(
        super::css_color_to_hwp_bgr("rgb(255, 0, 0)"),
        Some(0x0000FF)
    );
}

/// DocInfo 라운드트립 테스트: raw_stream 제거 후 직렬화→재파싱 시 데이터 보존 검증
#[test]
fn test_docinfo_roundtrip_charshape_preservation() {
    use crate::parser::cfb_reader::CfbReader;
    use crate::parser::record::Record;
    use crate::parser::tags;

    // 먼저 모든 관련 파일의 char_shapes 수 출력
    let check_files = [
        "/app/pasts/20250130-hongbo_saved-past.hwp",
        "/app/pasts/20250130-hongbo_saved-past-002.hwp",
        "/app/pasts/20250130-hongbo_saved-past-003.hwp",
        "/app/pasts/20250130-hongbo_saved-past-004.hwp",
        "/app/pasts/20250130-hongbo_saved-past-005.hwp",
        "/app/pasts/20250130-hongbo-p2.hwp",
        "/app/pasts/20250130-hongbo-p3.hwp",
    ];
    eprintln!("\n=== ALL FILES: char_shapes count ===");
    for cf in &check_files {
        if let Ok(d) = std::fs::read(cf) {
            if let Ok(cdoc) = HwpDocument::from_bytes(&d) {
                eprintln!(
                    "  {} → char_shapes={} para_shapes={} border_fills={} styles={}",
                    cf.split('/').next_back().unwrap_or(cf),
                    cdoc.document.doc_info.char_shapes.len(),
                    cdoc.document.doc_info.para_shapes.len(),
                    cdoc.document.doc_info.border_fills.len(),
                    cdoc.document.doc_info.styles.len()
                );
            }
        }
    }

    let path = "/app/pasts/20250130-hongbo-p2.hwp";
    let data = match std::fs::read(path) {
        Ok(d) => d,
        Err(_) => {
            eprintln!("File not found: {}", path);
            return;
        }
    };

    let mut doc = HwpDocument::from_bytes(&data).unwrap();

    let orig_cs = doc.document.doc_info.char_shapes.len();
    let orig_ps = doc.document.doc_info.para_shapes.len();
    let orig_bf = doc.document.doc_info.border_fills.len();
    let orig_st = doc.document.doc_info.styles.len();

    eprintln!("=== P2 DocInfo 라운드트립 테스트 ===");
    eprintln!(
        "  Original: char_shapes={} para_shapes={} border_fills={} styles={}",
        orig_cs, orig_ps, orig_bf, orig_st
    );
    eprintln!(
        "  raw_stream present: {}",
        doc.document.doc_info.raw_stream.is_some()
    );

    // 1) raw_stream이 있는 경우 → 원본 그대로 반환
    let serialized_raw = crate::serializer::doc_info::serialize_doc_info(
        &doc.document.doc_info,
        &doc.document.doc_properties,
    );
    let raw_records = Record::read_all(&serialized_raw).unwrap();
    let raw_cs_count = raw_records
        .iter()
        .filter(|r| r.tag_id == tags::HWPTAG_CHAR_SHAPE)
        .count();
    eprintln!(
        "  With raw_stream: serialized={} bytes, CHAR_SHAPE records={}",
        serialized_raw.len(),
        raw_cs_count
    );

    // 2) raw_stream 제거 후 재직렬화
    doc.document.doc_info.raw_stream = None;
    let serialized_no_raw = crate::serializer::doc_info::serialize_doc_info(
        &doc.document.doc_info,
        &doc.document.doc_properties,
    );
    let no_raw_records = Record::read_all(&serialized_no_raw).unwrap();
    let no_raw_cs_count = no_raw_records
        .iter()
        .filter(|r| r.tag_id == tags::HWPTAG_CHAR_SHAPE)
        .count();
    eprintln!(
        "  Without raw_stream: serialized={} bytes, CHAR_SHAPE records={}",
        serialized_no_raw.len(),
        no_raw_cs_count
    );

    // 3) 재파싱
    match crate::parser::doc_info::parse_doc_info(&serialized_no_raw) {
        Ok((reparsed_di, reparsed_dp)) => {
            eprintln!(
                "  Re-parsed: char_shapes={} para_shapes={} border_fills={} styles={}",
                reparsed_di.char_shapes.len(),
                reparsed_di.para_shapes.len(),
                reparsed_di.border_fills.len(),
                reparsed_di.styles.len()
            );

            // 원본과 비교
            if reparsed_di.char_shapes.len() != orig_cs {
                eprintln!(
                    "  *** CHAR_SHAPES LOSS: {} → {} (lost {}) ***",
                    orig_cs,
                    reparsed_di.char_shapes.len(),
                    orig_cs as i64 - reparsed_di.char_shapes.len() as i64
                );
            }
            if reparsed_di.para_shapes.len() != orig_ps {
                eprintln!(
                    "  *** PARA_SHAPES DIFF: {} → {} ***",
                    orig_ps,
                    reparsed_di.para_shapes.len()
                );
            }
            if reparsed_di.border_fills.len() != orig_bf {
                eprintln!(
                    "  *** BORDER_FILLS DIFF: {} → {} ***",
                    orig_bf,
                    reparsed_di.border_fills.len()
                );
            }
            if reparsed_di.styles.len() != orig_st {
                eprintln!(
                    "  *** STYLES DIFF: {} → {} ***",
                    orig_st,
                    reparsed_di.styles.len()
                );
            }

            assert_eq!(
                reparsed_di.char_shapes.len(),
                orig_cs,
                "char_shapes 라운드트립 불일치!"
            );
        }
        Err(e) => {
            eprintln!("  *** RE-PARSE FAILED: {} ***", e);
            panic!("DocInfo re-parse failed");
        }
    }

    // 4) 레코드 수준 비교: raw_stream vs no_raw_stream
    eprintln!("\n  Record type comparison:");
    let mut raw_by_tag: std::collections::HashMap<u16, usize> = std::collections::HashMap::new();
    let mut noraw_by_tag: std::collections::HashMap<u16, usize> = std::collections::HashMap::new();
    for r in &raw_records {
        *raw_by_tag.entry(r.tag_id).or_default() += 1;
    }
    for r in &no_raw_records {
        *noraw_by_tag.entry(r.tag_id).or_default() += 1;
    }

    let mut all_tags: Vec<u16> = raw_by_tag
        .keys()
        .chain(noraw_by_tag.keys())
        .cloned()
        .collect();
    all_tags.sort();
    all_tags.dedup();
    for tag in &all_tags {
        let raw_cnt = raw_by_tag.get(tag).unwrap_or(&0);
        let noraw_cnt = noraw_by_tag.get(tag).unwrap_or(&0);
        if raw_cnt != noraw_cnt {
            eprintln!(
                "    tag={} ({}): raw={} vs rebuilt={}",
                tag,
                tags::tag_name(*tag),
                raw_cnt,
                noraw_cnt
            );
        }
    }

    // 5) ID_MAPPINGS 상세 덤프
    eprintln!("\n  === ID_MAPPINGS detail (original) ===");
    let labels = [
        "BinData",
        "KorFont",
        "EnFont",
        "CnFont",
        "JpFont",
        "OtherFont",
        "SymFont",
        "UsrFont",
        "BorderFill",
        "CharShape",
        "TabDef",
        "Numbering",
        "Bullet",
        "ParaShape",
        "Style",
        "MemoShape",
        "TrackChange",
        "TrackChangeUser",
    ];
    for r in &raw_records {
        if r.tag_id == tags::HWPTAG_ID_MAPPINGS {
            eprintln!(
                "    raw ID_MAPPINGS size={} ({} u32s)",
                r.data.len(),
                r.data.len() / 4
            );
            for i in 0..(r.data.len() / 4).min(18) {
                let off = i * 4;
                let val = u32::from_le_bytes([
                    r.data[off],
                    r.data[off + 1],
                    r.data[off + 2],
                    r.data[off + 3],
                ]);
                let name = if i < labels.len() { labels[i] } else { "???" };
                eprintln!("      [{:2}] {:16} = {}", i, name, val);
            }
        }
    }
    eprintln!("  === ID_MAPPINGS detail (rebuilt) ===");
    for r in &no_raw_records {
        if r.tag_id == tags::HWPTAG_ID_MAPPINGS {
            eprintln!(
                "    rebuilt ID_MAPPINGS size={} ({} u32s)",
                r.data.len(),
                r.data.len() / 4
            );
            for i in 0..(r.data.len() / 4).min(18) {
                let off = i * 4;
                let val = u32::from_le_bytes([
                    r.data[off],
                    r.data[off + 1],
                    r.data[off + 2],
                    r.data[off + 3],
                ]);
                let name = if i < labels.len() { labels[i] } else { "???" };
                eprintln!("      [{:2}] {:16} = {}", i, name, val);
            }
        }
    }

    // 6) 원본 DocInfo 레코드별 크기 확인 (CHAR_SHAPE)
    eprintln!("\n  Original CHAR_SHAPE record sizes:");
    let mut cs_sizes: std::collections::HashMap<usize, usize> = std::collections::HashMap::new();
    for r in &raw_records {
        if r.tag_id == tags::HWPTAG_CHAR_SHAPE {
            *cs_sizes.entry(r.data.len()).or_default() += 1;
        }
    }
    for (sz, cnt) in &cs_sizes {
        eprintln!("    size={}: {} records", sz, cnt);
    }

    eprintln!("\n  Rebuilt CHAR_SHAPE record sizes:");
    let mut cs_sizes2: std::collections::HashMap<usize, usize> = std::collections::HashMap::new();
    for r in &no_raw_records {
        if r.tag_id == tags::HWPTAG_CHAR_SHAPE {
            *cs_sizes2.entry(r.data.len()).or_default() += 1;
        }
    }
    for (sz, cnt) in &cs_sizes2 {
        eprintln!("    size={}: {} records", sz, cnt);
    }

    // 7) PARA_SHAPE, BORDER_FILL, STYLE 레코드 크기 비교
    for check_tag in &[
        tags::HWPTAG_PARA_SHAPE,
        tags::HWPTAG_BORDER_FILL,
        tags::HWPTAG_STYLE,
        tags::HWPTAG_TAB_DEF,
    ] {
        let tag_name = tags::tag_name(*check_tag);
        let mut raw_sizes: std::collections::HashMap<usize, usize> =
            std::collections::HashMap::new();
        let mut rebuilt_sizes: std::collections::HashMap<usize, usize> =
            std::collections::HashMap::new();
        for r in &raw_records {
            if r.tag_id == *check_tag {
                *raw_sizes.entry(r.data.len()).or_default() += 1;
            }
        }
        for r in &no_raw_records {
            if r.tag_id == *check_tag {
                *rebuilt_sizes.entry(r.data.len()).or_default() += 1;
            }
        }
        if raw_sizes != rebuilt_sizes {
            eprintln!("\n  {} SIZE MISMATCH:", tag_name);
            eprintln!("    Original: {:?}", raw_sizes);
            eprintln!("    Rebuilt:  {:?}", rebuilt_sizes);
        }
    }

    // 8) 전체 레코드 수 비교
    eprintln!(
        "\n  Total records: original={} vs rebuilt={}",
        raw_records.len(),
        no_raw_records.len()
    );

    eprintln!("\n=== ROUNDTRIP TEST COMPLETE ===");
}

#[test]
fn test_simple_text_insert_and_save() {
    // template/empty.hwp 로드 → 텍스트 삽입 → 저장
    let path = "template/empty.hwp";
    assert!(
        std::path::Path::new(path).exists(),
        "테스트 입력 파일 없음: {:?}",
        path
    );

    let data = std::fs::read(path).unwrap();
    let mut doc = HwpDocument::from_bytes(&data).unwrap();

    eprintln!("=== 단순 텍스트 삽입 + 저장 테스트 ===");
    eprintln!(
        "원본: {} bytes, {}페이지, {}개 구역",
        data.len(),
        doc.page_count(),
        doc.document.sections.len()
    );

    // 첫 번째 구역, 첫 번째 문단에 텍스트 삽입
    let section = &doc.document.sections[0];
    eprintln!("문단 수: {}", section.paragraphs.len());
    for (i, p) in section.paragraphs.iter().enumerate() {
        eprintln!(
            "  문단[{}]: text='{}' controls={} line_segs={}",
            i,
            p.text,
            p.controls.len(),
            p.line_segs.len()
        );
    }

    // "가나다라마바사아" 삽입
    let result = doc.insert_text_native(0, 0, 0, "가나다라마바사아");
    assert!(result.is_ok(), "텍스트 삽입 실패: {:?}", result.err());
    eprintln!("텍스트 삽입 결과: {}", result.unwrap());

    // 삽입 후 상태 확인
    let section = &doc.document.sections[0];
    eprintln!("삽입 후 문단[0]: text='{}'", section.paragraphs[0].text);

    // HWP 내보내기
    let saved = doc.export_hwp_native();
    assert!(saved.is_ok(), "HWP 내보내기 실패: {:?}", saved.err());
    let saved_data = saved.unwrap();
    eprintln!("저장된 파일: {} bytes", saved_data.len());

    // output/ 폴더에 저장
    let _ = std::fs::create_dir_all("output");
    std::fs::write("output/empty_with_text.hwp", &saved_data).unwrap();
    eprintln!("output/empty_with_text.hwp 저장 완료");

    // 저장된 파일 재파싱 검증
    let doc2 = HwpDocument::from_bytes(&saved_data);
    assert!(doc2.is_ok(), "저장된 파일 재파싱 실패: {:?}", doc2.err());
    let doc2 = doc2.unwrap();
    eprintln!("재파싱 성공: {}페이지", doc2.page_count());

    let section2 = &doc2.document.sections[0];
    eprintln!("재파싱 문단[0]: text='{}'", section2.paragraphs[0].text);
    assert!(
        section2.paragraphs[0].text.contains("가나다라마바사아"),
        "저장된 파일에 삽입한 텍스트가 없음"
    );
}

#[test]
fn test_roundtrip_no_edit() {
    // 편집 없이 raw_stream 무효화 → 재직렬화 → 저장
    // 재직렬화 자체에 문제가 있는지 분리 확인
    let path = "template/empty.hwp";
    assert!(
        std::path::Path::new(path).exists(),
        "테스트 입력 파일 없음: {:?}",
        path
    );

    let orig_data = std::fs::read(path).unwrap();
    let mut doc = HwpDocument::from_bytes(&orig_data).unwrap();

    // raw_stream 무효화 (재직렬화 유도)
    doc.document.sections[0].raw_stream = None;

    let saved = doc.export_hwp_native().unwrap();
    let _ = std::fs::create_dir_all("output");
    std::fs::write("output/empty_roundtrip.hwp", &saved).unwrap();
    eprintln!("output/empty_roundtrip.hwp 저장 ({} bytes)", saved.len());

    // 재파싱 검증
    let doc2 = HwpDocument::from_bytes(&saved);
    assert!(doc2.is_ok(), "재파싱 실패: {:?}", doc2.err());

    // 레코드별 비교
    use crate::parser::record::Record;
    let orig_doc = crate::parser::parse_hwp(&orig_data).unwrap();
    let mut orig_cfb = crate::parser::cfb_reader::CfbReader::open(&orig_data).unwrap();
    let orig_bt = orig_cfb
        .read_body_text_section(0, orig_doc.header.compressed, false)
        .unwrap();
    let orig_recs = Record::read_all(&orig_bt).unwrap();

    let saved_doc = crate::parser::parse_hwp(&saved).unwrap();
    let mut saved_cfb = crate::parser::cfb_reader::CfbReader::open(&saved).unwrap();
    let saved_bt = saved_cfb
        .read_body_text_section(0, saved_doc.header.compressed, false)
        .unwrap();
    let saved_recs = Record::read_all(&saved_bt).unwrap();

    eprintln!(
        "원본 레코드: {}, 재직렬화 레코드: {}",
        orig_recs.len(),
        saved_recs.len()
    );

    let max = orig_recs.len().max(saved_recs.len());
    for i in 0..max {
        let o = orig_recs.get(i);
        let s = saved_recs.get(i);
        match (o, s) {
            (Some(or), Some(sr)) => {
                if or.tag_id != sr.tag_id || or.level != sr.level || or.data != sr.data {
                    eprintln!(
                        "DIFF [{}]: tag={}/{} level={}/{} size={}/{}",
                        i,
                        or.tag_id,
                        sr.tag_id,
                        or.level,
                        sr.level,
                        or.data.len(),
                        sr.data.len()
                    );
                    if or.data != sr.data {
                        let show = or.data.len().min(sr.data.len()).min(36);
                        eprintln!("  ORIG: {:02x?}", &or.data[..show]);
                        eprintln!("  SAVE: {:02x?}", &sr.data[..show]);
                        // 첫 번째 다른 바이트 위치
                        for (pos, (a, b)) in or.data.iter().zip(sr.data.iter()).enumerate() {
                            if a != b {
                                eprintln!(
                                    "  First diff at byte {}: 0x{:02x} vs 0x{:02x}",
                                    pos, a, b
                                );
                                break;
                            }
                        }
                    }
                }
            }
            (Some(or), None) => eprintln!("MISSING in saved [{}]: tag={}", i, or.tag_id),
            (None, Some(sr)) => eprintln!("EXTRA in saved [{}]: tag={}", i, sr.tag_id),
            _ => {}
        }
    }
    eprintln!("비교 완료");
}

#[test]
fn test_save_text_only() {
    // 단계 2: 빈 HWP에 텍스트만 삽입 → 저장 → 바이트 비교
    use crate::parser::record::Record;
    use crate::parser::tags;

    let path = "template/empty.hwp";
    assert!(
        std::path::Path::new(path).exists(),
        "테스트 입력 파일 없음: {:?}",
        path
    );

    let orig_data = std::fs::read(path).unwrap();

    // 테스트 케이스: (파일명, 삽입 텍스트)
    let test_cases = vec![
        ("save_test_korean.hwp", "가나다라마바사아"),
        ("save_test_english.hwp", "Hello World"),
        ("save_test_mixed.hwp", "안녕 Hello 123 !@#"),
    ];

    for (filename, text) in &test_cases {
        eprintln!("\n{}", "=".repeat(60));
        eprintln!("  테스트: {} → '{}'", filename, text);
        eprintln!("{}", "=".repeat(60));

        let mut doc = HwpDocument::from_bytes(&orig_data).unwrap();

        // 텍스트 삽입 (첫 구역, 첫 문단, 캐럿 위치 0)
        let result = doc.insert_text_native(0, 0, 0, text);
        assert!(result.is_ok(), "텍스트 삽입 실패: {:?}", result.err());

        // 삽입 후 문단 상태 확인
        let para = &doc.document.sections[0].paragraphs[0];
        eprintln!(
            "  삽입 후: text='{}' char_count={}",
            para.text, para.char_count
        );
        eprintln!("  char_offsets: {:?}", &para.char_offsets);
        eprintln!(
            "  char_shapes: {:?}",
            para.char_shapes
                .iter()
                .map(|cs| (cs.start_pos, cs.char_shape_id))
                .collect::<Vec<_>>()
        );
        for (i, ls) in para.line_segs.iter().enumerate() {
            eprintln!("  LineSeg[{}]: text_start={} vpos={} lh={} th={} bd={} ls={} cs={} sw={} tag=0x{:08x}",
                    i, ls.text_start, ls.vertical_pos, ls.line_height, ls.text_height,
                    ls.baseline_distance, ls.line_spacing, ls.column_start, ls.segment_width, ls.tag);
        }

        // HWP 저장
        let saved = doc.export_hwp_native();
        assert!(saved.is_ok(), "HWP 저장 실패: {:?}", saved.err());
        let saved_data = saved.unwrap();

        // 파일 출력
        let _ = std::fs::create_dir_all("output");
        let out_path = format!("output/{}", filename);
        std::fs::write(&out_path, &saved_data).unwrap();
        eprintln!("  저장: {} ({} bytes)", out_path, saved_data.len());

        // 재파싱 검증
        let doc2 = HwpDocument::from_bytes(&saved_data);
        assert!(doc2.is_ok(), "재파싱 실패: {:?}", doc2.err());
        let doc2 = doc2.unwrap();
        let para2 = &doc2.document.sections[0].paragraphs[0];
        eprintln!(
            "  재파싱: text='{}' char_count={}",
            para2.text, para2.char_count
        );
        assert!(
            para2.text.contains(text),
            "재파싱 텍스트 불일치: expected '{}', got '{}'",
            text,
            para2.text
        );

        // 캐럿 위치 검증
        let caret = &doc2.document.doc_properties;
        eprintln!(
            "  캐럿: list_id={} para_id={} char_pos={}",
            caret.caret_list_id, caret.caret_para_id, caret.caret_char_pos
        );
        // 삽입 후 캐럿은 텍스트 마지막 글자 뒤여야 함
        let expected_caret_pos = 16u32
            + text
                .chars()
                .map(|c| if (c as u32) > 0xFFFF { 2u32 } else { 1u32 })
                .sum::<u32>();
        assert_eq!(
            caret.caret_char_pos, expected_caret_pos,
            "캐럿 위치 불일치: expected {} got {}",
            expected_caret_pos, caret.caret_char_pos
        );

        // BodyText 레코드 비교 (원본 vs 저장)
        let orig_doc = crate::parser::parse_hwp(&orig_data).unwrap();
        let mut orig_cfb = crate::parser::cfb_reader::CfbReader::open(&orig_data).unwrap();
        let orig_bt = orig_cfb
            .read_body_text_section(0, orig_doc.header.compressed, false)
            .unwrap();
        let orig_recs = Record::read_all(&orig_bt).unwrap();

        let saved_doc = crate::parser::parse_hwp(&saved_data).unwrap();
        let mut saved_cfb = crate::parser::cfb_reader::CfbReader::open(&saved_data).unwrap();
        let saved_bt = saved_cfb
            .read_body_text_section(0, saved_doc.header.compressed, false)
            .unwrap();
        let saved_recs = Record::read_all(&saved_bt).unwrap();

        eprintln!(
            "\n  --- 레코드 비교 (원본: {} / 저장: {}) ---",
            orig_recs.len(),
            saved_recs.len()
        );
        let tag_name = |id: u16| -> &str {
            match id {
                66 => "PARA_HEADER",
                67 => "PARA_TEXT",
                68 => "PARA_CHAR_SHAPE",
                69 => "PARA_LINE_SEG",
                70 => "CTRL_HEADER",
                71 => "LIST_HEADER",
                _ => "OTHER",
            }
        };

        let max = orig_recs.len().max(saved_recs.len());
        for i in 0..max {
            let o = orig_recs.get(i);
            let s = saved_recs.get(i);
            match (o, s) {
                (Some(or), Some(sr)) => {
                    let same = or.tag_id == sr.tag_id && or.level == sr.level && or.data == sr.data;
                    let status = if same { "OK  " } else { "DIFF" };
                    eprintln!(
                        "  [{}] {} tag={:3}({}) level={}/{} size={}/{}",
                        i,
                        status,
                        or.tag_id,
                        tag_name(or.tag_id),
                        or.level,
                        sr.level,
                        or.data.len(),
                        sr.data.len()
                    );
                    if !same {
                        let show = or.data.len().min(sr.data.len()).min(48);
                        let orig_hex: String = or.data[..show]
                            .iter()
                            .map(|b| format!("{:02x}", b))
                            .collect::<Vec<_>>()
                            .join(" ");
                        let save_hex: String = sr.data[..show]
                            .iter()
                            .map(|b| format!("{:02x}", b))
                            .collect::<Vec<_>>()
                            .join(" ");
                        eprintln!("         ORIG: {}", orig_hex);
                        eprintln!("         SAVE: {}", save_hex);
                    }
                }
                (Some(or), None) => eprintln!(
                    "  [{}] MISSING tag={}({})",
                    i,
                    or.tag_id,
                    tag_name(or.tag_id)
                ),
                (None, Some(sr)) => eprintln!(
                    "  [{}] EXTRA   tag={}({})",
                    i,
                    sr.tag_id,
                    tag_name(sr.tag_id)
                ),
                _ => {}
            }
        }
    }
    eprintln!("\n=== 단계 2 텍스트 저장 검증 완료 ===");
}

#[test]
fn test_save_table_1x1() {
    // 단계 3: 빈 HWP에 1×1 표 삽입 → 저장
    // 참조: output/1by1-table.hwp (HWP 프로그램으로 생성한 1x1 표)
    use crate::model::control::Control;
    use crate::model::table::{Cell, Table};
    use crate::model::Padding;
    use crate::parser::record::Record;

    let path = "template/empty.hwp";
    assert!(
        std::path::Path::new(path).exists(),
        "테스트 입력 파일 없음: {:?}",
        path
    );

    let orig_data = std::fs::read(path).unwrap();
    let mut doc = HwpDocument::from_bytes(&orig_data).unwrap();

    eprintln!("\n{}", "=".repeat(60));
    eprintln!("  단계 3: 1×1 표 삽입 → 저장 (참조파일 기반)");
    eprintln!("{}", "=".repeat(60));

    // 참조 파일의 값을 사용하여 표 생성
    // cell_width=41954, cell_height=282 (참조 파일 기준)
    let table_width: u32 = 41954; // 참조 파일과 동일
    let table_height: u32 = 1282; // 참조 파일과 동일
    let cell_width: u32 = 41954;
    let cell_height: u32 = 282;

    // 셀 내부 문단: 빈 문단 (CR만, char_count=1, MSB set)
    let cell_seg_width = 40932; // 참조: cell_width - 패딩(510+510) - 2
    let cell_para = Paragraph {
        text: String::new(),
        char_count: 1,
        char_count_msb: true, // 참조: 0x80000001
        control_mask: 0,
        para_shape_id: 0, // empty.hwp의 기존 para_shape 사용
        style_id: 0,
        char_shapes: vec![crate::model::paragraph::CharShapeRef {
            start_pos: 0,
            char_shape_id: 0, // empty.hwp의 기존 char_shape 사용
        }],
        line_segs: vec![LineSeg {
            text_start: 0,
            vertical_pos: 0,
            line_height: 1000,
            text_height: 1000,
            baseline_distance: 850,
            line_spacing: 600,
            column_start: 0,
            segment_width: cell_seg_width,
            tag: LineSeg::TAG_SINGLE_SEGMENT_LINE,
        }],
        has_para_text: false, // 빈 문단: PARA_TEXT 없음
        raw_header_extra: vec![0x01, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00],
        ..Default::default()
    };

    let cell = Cell {
        col: 0,
        row: 0,
        col_span: 1,
        row_span: 1,
        width: cell_width,
        height: cell_height,
        border_fill_id: 1,
        padding: Padding {
            left: 510,
            right: 510,
            top: 141,
            bottom: 141,
        }, // 참조값
        list_header_width_ref: 0,
        // raw_list_extra: 참조파일의 13바이트 (width + zeros)
        raw_list_extra: {
            let mut v = Vec::new();
            v.extend_from_slice(&cell_width.to_le_bytes()); // [e2,a3,00,00]
            v.extend_from_slice(&[0u8; 9]); // zeros
            v
        },
        paragraphs: vec![cell_para],
        ..Default::default()
    };

    // CommonObjAttr 바이너리 생성 (참조 파일의 raw_ctrl_data 38바이트)
    let raw_ctrl_data = {
        let mut v = Vec::new();
        v.extend_from_slice(&0u32.to_le_bytes()); // y_offset = 0
        v.extend_from_slice(&0u32.to_le_bytes()); // x_offset = 0
        v.extend_from_slice(&table_width.to_le_bytes()); // width
        v.extend_from_slice(&table_height.to_le_bytes()); // height
        v.extend_from_slice(&1u32.to_le_bytes()); // z_order = 1
        v.extend_from_slice(&283u16.to_le_bytes()); // margin_left
        v.extend_from_slice(&283u16.to_le_bytes()); // margin_right
        v.extend_from_slice(&283u16.to_le_bytes()); // margin_top
        v.extend_from_slice(&283u16.to_le_bytes()); // margin_bottom
        v.extend_from_slice(&0x7C1E9738u32.to_le_bytes()); // instance_id
        v.extend_from_slice(&0u32.to_le_bytes()); // unknown1
        v.extend_from_slice(&0u16.to_le_bytes()); // unknown2
        v
    };

    // DocInfo에 실선 테두리 BorderFill 추가 (참조: bf[0])
    use crate::model::style::{
        BorderFill, BorderLine, BorderLineType, CenterLine, DiagonalLine, Fill,
    };
    let solid_border = BorderLine {
        line_type: BorderLineType::Solid,
        width: 1,
        color: 0,
    };
    let new_bf = BorderFill {
        raw_data: None,
        attr: 0,
        borders: [solid_border, solid_border, solid_border, solid_border],
        diagonal: DiagonalLine {
            diagonal_type: 1,
            width: 0,
            color: 0,
        },
        center_line: CenterLine::None,
        fill: Fill::default(),
        three_d: false,
    };
    doc.document.doc_info.border_fills.push(new_bf);
    let table_bf_id = doc.document.doc_info.border_fills.len() as u16; // 1-based ID

    let table = Table {
        attr: 0x082A2210, // 참조: CommonObjAttr flags
        row_count: 1,
        col_count: 1,
        cell_spacing: 0,
        padding: Padding {
            left: 510,
            right: 510,
            top: 141,
            bottom: 141,
        }, // 참조값
        row_sizes: vec![1],
        border_fill_id: table_bf_id,
        cells: {
            // cell의 border_fill_id도 갱신
            let mut c = cell;
            c.border_fill_id = table_bf_id;
            vec![c]
        },
        raw_ctrl_data,
        raw_table_record_attr: 6,                 // 참조: attr=6
        raw_table_record_extra: vec![0x00, 0x00], // 참조: 2바이트
        ..Default::default()
    };
    eprintln!(
        "  DocInfo: border_fill_count={}, table_bf_id={}",
        doc.document.doc_info.border_fills.len(),
        table_bf_id
    );

    // 첫 번째 문단에 Table 컨트롤 추가
    {
        let para = &mut doc.document.sections[0].paragraphs[0];
        para.controls.push(Control::Table(Box::new(table)));
        para.ctrl_data_records.push(None);
        para.char_count += 8; // 표 제어문자 8 code units
        para.control_mask = 0x00000804; // 참조: 표가 있는 문단의 control_mask

        // 표가 있는 문단의 segment_width는 0 (참조 파일)
        if let Some(ls) = para.line_segs.first_mut() {
            ls.segment_width = 0;
        }
    }

    // 두 번째 빈 문단 추가 (HWP는 표 삽입 시 아래에 빈 문단을 자동 추가)
    let empty_para = Paragraph {
        text: String::new(),
        char_count: 1,        // CR만
        char_count_msb: true, // 참조: 0x80000001
        control_mask: 0,
        para_shape_id: 0, // empty.hwp의 기존 para_shape 사용
        style_id: 0,
        char_shapes: vec![crate::model::paragraph::CharShapeRef {
            start_pos: 0,
            char_shape_id: 0,
        }],
        line_segs: vec![LineSeg {
            text_start: 0,
            vertical_pos: 1848, // 참조: 표 아래 위치
            line_height: 1000,
            text_height: 1000,
            baseline_distance: 850,
            line_spacing: 600,
            column_start: 0,
            segment_width: 42520, // 참조: 편집 영역 전체 너비
            tag: LineSeg::TAG_SINGLE_SEGMENT_LINE,
        }],
        has_para_text: false,
        raw_header_extra: vec![0x01, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00],
        ..Default::default()
    };
    doc.document.sections[0].paragraphs.push(empty_para);

    // raw_stream 무효화 (재직렬화 유도)
    doc.document.sections[0].raw_stream = None;

    // 캐럿 위치: 두 번째 문단(표 아래 빈 줄) 시작
    doc.document.doc_properties.caret_list_id = 1; // 문단 인덱스 1
    doc.document.doc_properties.caret_para_id = 0;
    doc.document.doc_properties.caret_char_pos = 0;
    doc.document.doc_info.raw_stream = None;
    doc.document.doc_properties.raw_data = None;

    let para = &doc.document.sections[0].paragraphs[0];
    eprintln!(
        "  문단[0]: text='{}' char_count={} controls={} seg_width={}",
        para.text,
        para.char_count,
        para.controls.len(),
        para.line_segs
            .first()
            .map(|ls| ls.segment_width)
            .unwrap_or(-1)
    );
    let para1 = &doc.document.sections[0].paragraphs[1];
    eprintln!(
        "  문단[1]: text='{}' char_count={} vpos={}",
        para1.text,
        para1.char_count,
        para1
            .line_segs
            .first()
            .map(|ls| ls.vertical_pos)
            .unwrap_or(-1)
    );

    // HWP 저장
    let saved = doc.export_hwp_native();
    assert!(saved.is_ok(), "HWP 저장 실패: {:?}", saved.err());
    let saved_data = saved.unwrap();

    let _ = std::fs::create_dir_all("output");
    std::fs::write("output/save_test_table_1x1.hwp", &saved_data).unwrap();
    eprintln!(
        "  저장: output/save_test_table_1x1.hwp ({} bytes)",
        saved_data.len()
    );

    // 재파싱 검증
    let doc2 = HwpDocument::from_bytes(&saved_data);
    assert!(doc2.is_ok(), "재파싱 실패: {:?}", doc2.err());
    let doc2 = doc2.unwrap();

    // 표 컨트롤 존재 검증
    let para2 = &doc2.document.sections[0].paragraphs[0];
    eprintln!(
        "  재파싱: text='{}' char_count={} controls={}",
        para2.text,
        para2.char_count,
        para2.controls.len()
    );
    let table_found = para2
        .controls
        .iter()
        .any(|c| matches!(c, Control::Table(_)));
    assert!(table_found, "재파싱된 문서에 표 컨트롤이 없음");

    // 표 내용 검증
    if let Some(Control::Table(t)) = para2
        .controls
        .iter()
        .find(|c| matches!(c, Control::Table(_)))
    {
        eprintln!(
            "  표: {}×{} cells={}",
            t.row_count,
            t.col_count,
            t.cells.len()
        );
        for (ci, cell) in t.cells.iter().enumerate() {
            eprintln!(
                "  셀[{}]: col={} row={} w={} h={} text='{}'",
                ci,
                cell.col,
                cell.row,
                cell.width,
                cell.height,
                cell.paragraphs
                    .first()
                    .map(|p| p.text.as_str())
                    .unwrap_or("")
            );
        }
        assert_eq!(t.row_count, 1);
        assert_eq!(t.col_count, 1);
        assert_eq!(t.cells.len(), 1);
        assert_eq!(t.cells[0].paragraphs.len(), 1);
        // 빈 셀 확인 (참조 파일 기반)
        assert_eq!(t.cells[0].paragraphs[0].char_count, 1); // CR만
    }

    // 두 번째 문단 (표 아래 빈 줄) 검증
    assert!(
        doc2.document.sections[0].paragraphs.len() >= 2,
        "표 아래 빈 문단이 없음"
    );
    let para_below = &doc2.document.sections[0].paragraphs[1];
    eprintln!(
        "  문단[1]: char_count={} controls={}",
        para_below.char_count,
        para_below.controls.len()
    );

    // 저장 레코드 덤프 (참조 파일과 비교)
    let saved_doc = crate::parser::parse_hwp(&saved_data).unwrap();
    let mut saved_cfb = crate::parser::cfb_reader::CfbReader::open(&saved_data).unwrap();
    let saved_bt = saved_cfb
        .read_body_text_section(0, saved_doc.header.compressed, false)
        .unwrap();
    let saved_recs = Record::read_all(&saved_bt).unwrap();

    eprintln!("\n  --- 저장 레코드 덤프 ({} 개) ---", saved_recs.len());
    use crate::parser::tags as t;
    for (i, r) in saved_recs.iter().enumerate() {
        let tname = t::tag_name(r.tag_id);
        let mut extra = String::new();
        if r.tag_id == t::HWPTAG_CTRL_HEADER && r.data.len() >= 4 {
            let cid = u32::from_le_bytes([r.data[0], r.data[1], r.data[2], r.data[3]]);
            extra = format!(" ctrl='{}'", t::ctrl_name(cid));
        }
        eprintln!(
            "  [{:2}] tag={:3}({:22}) level={} size={}{}",
            i,
            r.tag_id,
            tname,
            r.level,
            r.data.len(),
            extra
        );
    }

    // 참조 파일과 레코드 수 비교
    eprintln!("\n  [참조 비교] 참조=21개, 저장={}개", saved_recs.len());

    eprintln!("\n=== 단계 3 표 저장 검증 완료 ===");
}

/// 타스크 41 단계 1: 기존 HWP에 프로그래밍 방식으로 2×2 표 삽입 → 저장
/// 직렬화 코드 자체의 정상 동작을 먼저 확인
#[test]
fn test_inject_table_into_existing() {
    use crate::model::control::Control;
    use crate::model::paragraph::{CharShapeRef, LineSeg, Paragraph};
    use crate::model::table::{Cell, Table};
    use crate::model::Padding;

    let path = "samples/20250130-hongbo.hwp";
    assert!(
        std::path::Path::new(path).exists(),
        "테스트 입력 파일 없음: {:?}",
        path
    );

    eprintln!("\n{}", "=".repeat(60));
    eprintln!("  타스크 41 단계 1: 기존 HWP에 2×2 표 삽입");
    eprintln!("{}", "=".repeat(60));

    let orig_data = std::fs::read(path).unwrap();

    let mut doc = HwpDocument::from_bytes(&orig_data).unwrap();

    let sec = &doc.document.sections[0];
    let orig_para_count = sec.paragraphs.len();
    eprintln!(
        "  원본: {} 문단, {} 컨트롤",
        orig_para_count,
        sec.paragraphs
            .iter()
            .map(|p| p.controls.len())
            .sum::<usize>()
    );

    // 캐럿 위치 확인
    let caret_list_id = doc.document.doc_properties.caret_list_id;
    let caret_para_id = doc.document.doc_properties.caret_para_id;
    let caret_char_pos = doc.document.doc_properties.caret_char_pos;
    eprintln!(
        "  캐럿 위치: list_id={}, para_id={}, char_pos={}",
        caret_list_id, caret_para_id, caret_char_pos
    );

    // 삽입 위치: 캐럿이 가리키는 문단
    let insert_para_idx = caret_para_id as usize;
    assert!(
        insert_para_idx < orig_para_count,
        "캐럿 para_id({})가 문단 범위({})를 초과",
        insert_para_idx,
        orig_para_count
    );
    eprintln!("  삽입 위치: 문단[{}] (캐럿 기반)", insert_para_idx);

    // 삽입 위치 근처 문단 구조 출력
    let start = if insert_para_idx > 2 {
        insert_para_idx - 2
    } else {
        0
    };
    let end = (insert_para_idx + 4).min(orig_para_count);
    for i in start..end {
        let p = &sec.paragraphs[i];
        let ctrl_types: Vec<&str> = p
            .controls
            .iter()
            .map(|c| match c {
                Control::Table(_) => "Table",
                Control::Picture(_) => "Picture",
                _ => "Other",
            })
            .collect();
        let marker = if i == insert_para_idx {
            " ← 캐럿"
        } else {
            ""
        };
        eprintln!(
            "    문단[{}]: cc={} mask=0x{:08X} text='{}' ctrls={:?}{}",
            i,
            p.char_count,
            p.control_mask,
            if p.text.len() > 30 {
                &p.text[..30]
            } else {
                &p.text
            },
            ctrl_types,
            marker
        );
    }

    // === 방법: 기존 표 문단을 복제하여 삽입 (직렬화 문제 격리) ===
    // 문단[2]의 표를 그대로 복제
    let source_para_idx = 2;
    let table_para = doc.document.sections[0].paragraphs[source_para_idx].clone();
    eprintln!(
        "  복제 원본: 문단[{}] cc={} controls={}",
        source_para_idx,
        table_para.char_count,
        table_para.controls.len()
    );
    if let Some(Control::Table(t)) = table_para.controls.first() {
        eprintln!(
            "    표: {}×{} cells={} attr=0x{:08X}",
            t.row_count,
            t.col_count,
            t.cells.len(),
            t.attr
        );
    }

    // 캐럿 위치 뒤에 표 문단 삽입
    doc.document.sections[0]
        .paragraphs
        .insert(insert_para_idx + 1, table_para);

    // 기존 콘텐츠 사이 삽입 → 빈 문단 불필요 (기존 문단이 이어짐)

    // raw_stream 무효화: 섹션만 (DocInfo raw 유지 → 손상 방지)
    doc.document.sections[0].raw_stream = None;

    eprintln!(
        "  수정: {} 문단 (원본 {} + 표 문단 1개)",
        doc.document.sections[0].paragraphs.len(),
        orig_para_count
    );

    // 저장
    let saved = doc.export_hwp_native();
    assert!(saved.is_ok(), "HWP 저장 실패: {:?}", saved.err());
    let saved_data = saved.unwrap();

    let _ = std::fs::create_dir_all("output");
    std::fs::write("output/save_test_table_inject.hwp", &saved_data).unwrap();
    eprintln!(
        "  저장: output/save_test_table_inject.hwp ({} bytes)",
        saved_data.len()
    );

    // 재파싱 검증
    let doc2 = HwpDocument::from_bytes(&saved_data);
    assert!(doc2.is_ok(), "재파싱 실패: {:?}", doc2.err());
    let doc2 = doc2.unwrap();

    // 문단 수 검증 (표 문단 = +1)
    let new_para_count = doc2.document.sections[0].paragraphs.len();
    eprintln!("  재파싱: {} 문단", new_para_count);
    assert_eq!(new_para_count, orig_para_count + 1, "문단 수 불일치");

    // 삽입된 표 검증 (캐럿 문단 다음 위치)
    let table_para_idx = insert_para_idx + 1;
    let injected = &doc2.document.sections[0].paragraphs[table_para_idx];
    let table_found = injected
        .controls
        .iter()
        .any(|c| matches!(c, Control::Table(_)));
    assert!(
        table_found,
        "삽입된 표 컨트롤이 없음 (문단[{}])",
        table_para_idx
    );

    if let Some(Control::Table(t)) = injected
        .controls
        .iter()
        .find(|c| matches!(c, Control::Table(_)))
    {
        eprintln!(
            "  복제 표: {}×{} cells={} attr=0x{:08X}",
            t.row_count,
            t.col_count,
            t.cells.len(),
            t.attr
        );
    }

    // 기존 컨트롤 보존 검증
    let orig_doc = HwpDocument::from_bytes(&orig_data).unwrap();
    let mut orig_tables = 0;
    let mut orig_pics = 0;
    for para in &orig_doc.document.sections[0].paragraphs {
        for ctrl in &para.controls {
            match ctrl {
                Control::Table(_) => orig_tables += 1,
                Control::Picture(_) => orig_pics += 1,
                _ => {}
            }
        }
    }
    let mut new_tables = 0;
    let mut new_pics = 0;
    for para in &doc2.document.sections[0].paragraphs {
        for ctrl in &para.controls {
            match ctrl {
                Control::Table(_) => new_tables += 1,
                Control::Picture(_) => new_pics += 1,
                _ => {}
            }
        }
    }
    eprintln!(
        "  컨트롤 보존: Table {}→{}, Picture {}→{}",
        orig_tables, new_tables, orig_pics, new_pics
    );
    assert_eq!(new_tables, orig_tables + 1, "표 개수 불일치");
    assert_eq!(new_pics, orig_pics, "이미지 개수 변경됨");

    eprintln!("\n=== 타스크 41 단계 1 완료 ===");

    // === 진단: 저장된 파일에서 삽입된 표 제거 후 재저장 ===
    eprintln!("\n  [진단] 표 제거 후 재저장...");
    let mut doc3 = HwpDocument::from_bytes(&saved_data).unwrap();
    let para_count_before = doc3.document.sections[0].paragraphs.len();
    // 삽입된 표 문단 제거 (index = insert_para_idx + 1 = 9)
    doc3.document.sections[0]
        .paragraphs
        .remove(insert_para_idx + 1);
    doc3.document.sections[0].raw_stream = None;
    let saved3 = doc3.export_hwp_native().unwrap();
    std::fs::write("output/save_test_table_removed.hwp", &saved3).unwrap();
    eprintln!(
        "  [진단] 표 제거: {} → {} 문단, output/save_test_table_removed.hwp ({} bytes)",
        para_count_before,
        doc3.document.sections[0].paragraphs.len(),
        saved3.len()
    );
}

/// 타스크 41 단계 3: parse_table_html()로 생성한 표를 기존 문서에 삽입 → 저장 → 검증
/// DIFF-1~8 수정 사항이 모두 반영된 통합 테스트
#[test]
fn test_parse_table_html_save() {
    use crate::model::control::Control;

    let path = "samples/20250130-hongbo.hwp";
    assert!(
        std::path::Path::new(path).exists(),
        "테스트 입력 파일 없음: {:?}",
        path
    );

    eprintln!("\n{}", "=".repeat(60));
    eprintln!("  타스크 41 단계 3: parse_table_html 표 삽입 저장 검증");
    eprintln!("{}", "=".repeat(60));

    let orig_data = std::fs::read(path).unwrap();
    let mut doc = HwpDocument::from_bytes(&orig_data).unwrap();

    let orig_para_count = doc.document.sections[0].paragraphs.len();
    let caret_para_id = doc.document.doc_properties.caret_para_id as usize;
    eprintln!(
        "  원본: {} 문단, 캐럿 위치: 문단[{}]",
        orig_para_count, caret_para_id
    );

    // HTML 표 생성 (2×2, 빈 셀 포함)
    let table_html = r#"<table style="border-collapse:collapse;">
            <tr>
                <td style="border:1px solid black; padding:5px; width:200px;">테스트 셀 A</td>
                <td style="border:1px solid black; padding:5px; width:200px;">&nbsp;</td>
            </tr>
            <tr>
                <td style="border:1px solid black; padding:5px;">&nbsp;&nbsp;</td>
                <td style="border:1px solid black; padding:5px;">테스트 셀 D</td>
            </tr>
        </table>"#;

    // parse_table_html으로 표 문단 생성
    let mut table_paragraphs = Vec::new();
    doc.parse_table_html(&mut table_paragraphs, table_html);
    assert_eq!(table_paragraphs.len(), 1, "표 문단 1개 생성");

    let table_para = &table_paragraphs[0];
    eprintln!(
        "  표 문단: cc={} msb={} cm=0x{:08X} cs={} ls={}",
        table_para.char_count,
        table_para.char_count_msb,
        table_para.control_mask,
        table_para.char_shapes.len(),
        table_para.line_segs.len()
    );

    // DIFF 검증
    if let Some(Control::Table(ref tbl)) = table_para.controls.first() {
        eprintln!(
            "  표: {}×{} cells={} attr=0x{:08X}",
            tbl.row_count,
            tbl.col_count,
            tbl.cells.len(),
            tbl.attr
        );
        eprintln!("  DIFF-5: tbl_rec_attr=0x{:08X}", tbl.raw_table_record_attr);
        assert_eq!(
            tbl.raw_table_record_attr, 0x04000006,
            "DIFF-5: 셀분리금지 항상 설정"
        );

        // DIFF-7: instance_id
        let inst = parse_common_obj_attr(&tbl.raw_ctrl_data).instance_id;
        eprintln!("  DIFF-7: instance_id=0x{:08X}", inst);
        assert_ne!(inst, 0, "DIFF-7: instance_id != 0");

        // DIFF-1: 빈 셀 검증
        for (i, cell) in tbl.cells.iter().enumerate() {
            let p = &cell.paragraphs[0];
            eprintln!(
                "  셀[{}]({},{}): cc={} text='{}' cs={} ls={} has_pt={}",
                i,
                cell.row,
                cell.col,
                p.char_count,
                if p.text.len() > 20 {
                    &p.text[..20]
                } else {
                    &p.text
                },
                p.char_shapes.len(),
                p.line_segs.len(),
                p.has_para_text
            );

            // DIFF-2: 모든 셀 문단은 char_shapes가 있어야 함
            assert!(
                !p.char_shapes.is_empty(),
                "DIFF-2: 셀[{}] char_shapes 비어있음",
                i
            );
            // DIFF-3: para_shape_id=0 (기본 본문 스타일)
            assert_eq!(p.para_shape_id, 0, "DIFF-3: 셀[{}] para_shape_id=0", i);
            // DIFF-6: line_segs의 tag
            if !p.line_segs.is_empty() {
                assert_eq!(
                    p.line_segs[0].tag,
                    LineSeg::TAG_SINGLE_SEGMENT_LINE,
                    "DIFF-6: 셀[{}] line_seg tag",
                    i
                );
                assert!(
                    p.line_segs[0].segment_width > 0,
                    "DIFF-6: 셀[{}] seg_width > 0",
                    i
                );
            }
        }

        // DIFF-1: 빈 셀 (셀[1], 셀[2]) 확인
        assert_eq!(
            tbl.cells[1].paragraphs[0].char_count, 1,
            "DIFF-1: 빈 셀[1] cc=1"
        );
        assert!(
            tbl.cells[1].paragraphs[0].text.is_empty(),
            "DIFF-1: 빈 셀[1] text empty"
        );
        assert_eq!(
            tbl.cells[2].paragraphs[0].char_count, 1,
            "DIFF-1: 빈 셀[2] cc=1"
        );
    }

    // DIFF-8: 표 컨테이너 문단 LineSeg
    assert!(
        !table_para.line_segs.is_empty(),
        "DIFF-8: 표 문단 line_segs 비어있음"
    );
    eprintln!(
        "  DIFF-8: line_seg h={} tw={} seg_w={} tag=0x{:08X}",
        table_para.line_segs[0].line_height,
        table_para.line_segs[0].text_height,
        table_para.line_segs[0].segment_width,
        table_para.line_segs[0].tag
    );
    assert!(
        table_para.line_segs[0].line_height > 0,
        "DIFF-8: line_height > 0"
    );
    assert!(
        table_para.line_segs[0].segment_width > 0,
        "DIFF-8: seg_width > 0"
    );
    assert_eq!(
        table_para.line_segs[0].tag,
        LineSeg::TAG_SINGLE_SEGMENT_LINE,
        "DIFF-8: tag=LineSeg::TAG_SINGLE_SEGMENT_LINE"
    );

    // 삽입 및 저장
    doc.document.sections[0]
        .paragraphs
        .insert(caret_para_id + 1, table_paragraphs.remove(0));
    doc.document.sections[0].raw_stream = None;

    let saved = doc.export_hwp_native();
    assert!(saved.is_ok(), "저장 실패: {:?}", saved.err());
    let saved_data = saved.unwrap();

    let _ = std::fs::create_dir_all("output");
    std::fs::write("output/save_test_parsed_table.hwp", &saved_data).unwrap();
    eprintln!(
        "  저장: output/save_test_parsed_table.hwp ({} bytes)",
        saved_data.len()
    );

    // 재파싱 검증
    let doc2 = HwpDocument::from_bytes(&saved_data);
    assert!(doc2.is_ok(), "재파싱 실패: {:?}", doc2.err());
    let doc2 = doc2.unwrap();
    let new_para_count = doc2.document.sections[0].paragraphs.len();
    eprintln!(
        "  재파싱: {} 문단 (원본 {} + 1)",
        new_para_count, orig_para_count
    );
    assert_eq!(new_para_count, orig_para_count + 1);

    // 삽입된 표 확인
    let injected = &doc2.document.sections[0].paragraphs[caret_para_id + 1];
    assert!(
        injected
            .controls
            .iter()
            .any(|c| matches!(c, Control::Table(_))),
        "삽입된 표 컨트롤 없음"
    );

    eprintln!("\n=== 타스크 41 단계 3 완료 ===");
    eprintln!("  output/save_test_parsed_table.hwp 를 HWP 프로그램에서 확인해 주세요");
}

/// 엔터 2회 후 저장 시 파일 손상 재현 진단 테스트
#[test]
fn test_diag_double_enter_save() {
    use crate::parser::cfb_reader::CfbReader;
    use crate::parser::record::Record;
    use crate::parser::tags;

    let path = "samples/20250130-hongbo.hwp";
    assert!(
        std::path::Path::new(path).exists(),
        "테스트 입력 파일 없음: {:?}",
        path
    );

    let data = std::fs::read(path).unwrap();
    let mut doc = HwpDocument::from_bytes(&data).unwrap();

    eprintln!("=== 엔터 2회 후 저장 파일 손상 진단 ===");
    let section = &doc.document.sections[0];
    eprintln!("원본 문단 수: {}", section.paragraphs.len());

    // 텍스트가 있고 컨트롤이 없는 문단 찾기
    let mut target_para = 0;
    for (i, p) in section.paragraphs.iter().enumerate() {
        eprintln!(
            "  문단[{}]: text_len={} cc={} ctrl={} has_pt={}",
            i,
            p.text.chars().count(),
            p.char_count,
            p.controls.len(),
            p.has_para_text
        );
        if p.text.chars().count() >= 10 && p.controls.is_empty() && target_para == 0 {
            target_para = i;
        }
    }
    assert!(target_para > 0, "텍스트가 있는 문단을 찾을 수 없음");
    let para = &section.paragraphs[target_para];
    let text_len = para.text.chars().count();
    eprintln!(
        "\n대상 문단[{}]: text_len={} cc={} controls={} has_para_text={}",
        target_para,
        text_len,
        para.char_count,
        para.controls.len(),
        para.has_para_text
    );
    eprintln!(
        "  text(앞40)='{}'",
        para.text.chars().take(40).collect::<String>()
    );

    let split_offset = 4; // 4번째 글자 뒤에서 분할 (사용자 시나리오)

    // === 엔터 1회 ===
    let result1 = doc.split_paragraph_native(0, target_para, split_offset, None);
    assert!(result1.is_ok(), "1차 분할 실패: {:?}", result1.err());
    eprintln!("\n--- 1차 분할 (offset={}) ---", split_offset);

    let section = &doc.document.sections[0];
    for i in target_para..=(target_para + 1).min(section.paragraphs.len() - 1) {
        let p = &section.paragraphs[i];
        eprintln!(
            "  문단[{}]: cc={} text_len={} controls={} has_para_text={} line_segs={}",
            i,
            p.char_count,
            p.text.chars().count(),
            p.controls.len(),
            p.has_para_text,
            p.line_segs.len()
        );
    }

    // 1회 분할 후 저장 테스트
    let saved1 = doc.export_hwp_native();
    assert!(saved1.is_ok(), "1차 저장 실패");
    let saved1_data = saved1.unwrap();
    let parse1 = HwpDocument::from_bytes(&saved1_data);
    eprintln!(
        "1회 분할 후 저장+재파싱: {}",
        if parse1.is_ok() { "성공" } else { "실패" }
    );

    // === 엔터 2회 (새 문단의 시작에서 다시 분할) ===
    let new_para_idx = target_para + 1;
    let result2 = doc.split_paragraph_native(0, new_para_idx, 0, None);
    assert!(result2.is_ok(), "2차 분할 실패: {:?}", result2.err());
    eprintln!("\n--- 2차 분할 (문단[{}], offset=0) ---", new_para_idx);

    let section = &doc.document.sections[0];
    eprintln!("문단 수: {}", section.paragraphs.len());
    for i in target_para..=(target_para + 2).min(section.paragraphs.len() - 1) {
        let p = &section.paragraphs[i];
        eprintln!(
            "  문단[{}]: cc={} text_len={} controls={} has_para_text={} raw_extra_len={}",
            i,
            p.char_count,
            p.text.chars().count(),
            p.controls.len(),
            p.has_para_text,
            p.raw_header_extra.len()
        );
    }

    // 2회 분할 후 저장 테스트
    let saved2 = doc.export_hwp_native();
    assert!(saved2.is_ok(), "2차 저장 실패");
    let saved2_data = saved2.unwrap();

    let _ = std::fs::create_dir_all("output");
    std::fs::write("output/diag_double_enter.hwp", &saved2_data).unwrap();
    eprintln!(
        "\noutput/diag_double_enter.hwp 저장 ({} bytes)",
        saved2_data.len()
    );

    // 재파싱 테스트
    let parse2 = HwpDocument::from_bytes(&saved2_data);
    eprintln!(
        "2회 분할 후 저장+재파싱: {}",
        if parse2.is_ok() { "성공" } else { "실패" }
    );

    // 직렬화된 Section0 레코드 분석 - 분할 영역 주변만 상세 출력
    eprintln!("\n=== Section0 직렬화 레코드 분석 (level 0만, 분할 영역) ===");
    let section_bytes = crate::serializer::body_text::serialize_section(&doc.document.sections[0]);
    let recs = Record::read_all(&section_bytes).unwrap();
    let mut top_para_idx = 0;
    for (ri, rec) in recs.iter().enumerate() {
        if rec.tag_id == tags::HWPTAG_PARA_HEADER && rec.level == 0 {
            let cc_raw = u32::from_le_bytes(rec.data[0..4].try_into().unwrap());
            let cc = cc_raw & 0x7FFFFFFF;
            let msb = cc_raw & 0x80000000 != 0;
            let ctrl_mask = u32::from_le_bytes(rec.data[4..8].try_into().unwrap());
            // 분할 영역 (target_para-1 ~ target_para+4) 표시
            if top_para_idx >= target_para.saturating_sub(1) && top_para_idx <= target_para + 4 {
                eprintln!(
                    "rec[{}] PARA_HEADER(L0): model_para={} cc={} msb={} ctrl=0x{:08X}",
                    ri, top_para_idx, cc, msb, ctrl_mask
                );
            }
            top_para_idx += 1;
        } else if rec.tag_id == tags::HWPTAG_PARA_TEXT && rec.level == 1 {
            // 바로 앞의 PARA_HEADER가 분할 영역이면 표시
            if top_para_idx > target_para.saturating_sub(1) && top_para_idx <= target_para + 5 {
                let code_units = rec.data.len() / 2;
                eprintln!(
                    "rec[{}]   PARA_TEXT(L1): {} code_units ({} bytes)",
                    ri,
                    code_units,
                    rec.data.len()
                );
            }
        } else if rec.tag_id == tags::HWPTAG_PARA_CHAR_SHAPE && rec.level == 1 {
            if top_para_idx > target_para.saturating_sub(1) && top_para_idx <= target_para + 5 {
                let entries = rec.data.len() / 8;
                eprintln!("rec[{}]   PARA_CHAR_SHAPE(L1): {} entries", ri, entries);
            }
        } else if rec.tag_id == tags::HWPTAG_PARA_LINE_SEG && rec.level == 1 {
            if top_para_idx > target_para.saturating_sub(1) && top_para_idx <= target_para + 5 {
                let entries = rec.data.len() / 36;
                eprintln!("rec[{}]   PARA_LINE_SEG(L1): {} entries", ri, entries);
            }
        }
    }
    eprintln!("총 top-level 문단: {}", top_para_idx);

    if parse2.is_err() {
        panic!("2회 분할 후 저장된 파일 재파싱 실패!");
    }
}

#[test]
fn test_textbox_render_tree_debug() {
    use crate::renderer::render_tree::{RenderNode, RenderNodeType};
    use std::path::Path;

    let path = Path::new("samples/img-start-001.hwp");
    assert!(path.exists(), "테스트 입력 파일 없음: {:?}", path);

    let data = std::fs::read(path).unwrap();
    let mut doc = HwpDocument::from_bytes(&data).unwrap();
    doc.convert_to_editable_native().unwrap();

    // 문서 구조 확인: Shape 컨트롤 찾기
    let mut shape_found = false;
    for (si, sec) in doc.document.sections.iter().enumerate() {
        for (pi, para) in sec.paragraphs.iter().enumerate() {
            for (ci, ctrl) in para.controls.iter().enumerate() {
                if let Control::Shape(shape) = ctrl {
                    let has_textbox = match shape.as_ref() {
                        crate::model::shape::ShapeObject::Rectangle(r) => {
                            r.drawing.text_box.is_some()
                        }
                        crate::model::shape::ShapeObject::Ellipse(e) => {
                            e.drawing.text_box.is_some()
                        }
                        crate::model::shape::ShapeObject::Polygon(p) => {
                            p.drawing.text_box.is_some()
                        }
                        crate::model::shape::ShapeObject::Curve(c) => c.drawing.text_box.is_some(),
                        _ => false,
                    };
                    if has_textbox {
                        let tb = get_textbox_from_shape(shape.as_ref()).unwrap();
                        let drawing = match shape.as_ref() {
                            crate::model::shape::ShapeObject::Rectangle(r) => Some(&r.drawing),
                            crate::model::shape::ShapeObject::Ellipse(e) => Some(&e.drawing),
                            crate::model::shape::ShapeObject::Polygon(p) => Some(&p.drawing),
                            crate::model::shape::ShapeObject::Curve(c) => Some(&c.drawing),
                            _ => None,
                        };
                        eprintln!(
                            "Shape 발견: sec={} para={} ctrl={} type={:?} textbox_paras={}",
                            si,
                            pi,
                            ci,
                            match shape.as_ref() {
                                crate::model::shape::ShapeObject::Rectangle(_) => "Rectangle",
                                crate::model::shape::ShapeObject::Ellipse(_) => "Ellipse",
                                crate::model::shape::ShapeObject::Polygon(_) => "Polygon",
                                crate::model::shape::ShapeObject::Curve(_) => "Curve",
                                _ => "Other",
                            },
                            tb.paragraphs.len(),
                        );
                        if let Some(d) = drawing {
                            eprintln!("  fill_type={:?}", d.fill.fill_type);
                            let sa = &d.shape_attr;
                            eprintln!(
                                "  shape_attr: orig_w={} orig_h={} cur_w={} cur_h={}",
                                sa.original_width,
                                sa.original_height,
                                sa.current_width,
                                sa.current_height
                            );
                            if let Some(ref tb) = d.text_box {
                                eprintln!(
                                    "  textbox margins: left={} right={} top={} bottom={} max_w={}",
                                    tb.margin_left,
                                    tb.margin_right,
                                    tb.margin_top,
                                    tb.margin_bottom,
                                    tb.max_width
                                );
                            }
                            if let Some(ref g) = d.fill.gradient {
                                eprintln!("  gradient: type={} angle={} cx={} cy={} blur={} colors={:?} positions={:?}",
                                        g.gradient_type, g.angle, g.center_x, g.center_y, g.blur,
                                        g.colors.iter().map(|c| format!("#{:06X}", c)).collect::<Vec<_>>(),
                                        g.positions,
                                    );
                            }
                        }
                        let common = match shape.as_ref() {
                            crate::model::shape::ShapeObject::Rectangle(r) => Some(&r.common),
                            crate::model::shape::ShapeObject::Ellipse(e) => Some(&e.common),
                            crate::model::shape::ShapeObject::Polygon(p) => Some(&p.common),
                            crate::model::shape::ShapeObject::Curve(c) => Some(&c.common),
                            _ => None,
                        };
                        if let Some(c) = common {
                            eprintln!("  common: width={} height={} treat_as_char={} horz_rel={:?} vert_rel={:?} h_off={} v_off={}",
                                    c.width, c.height, c.treat_as_char, c.horz_rel_to, c.vert_rel_to,
                                    c.horizontal_offset, c.vertical_offset);
                        }
                        for (tpi, tp) in tb.paragraphs.iter().enumerate() {
                            let text: String = tp.text.chars().take(30).collect();
                            eprintln!(
                                "  tb_para[{}]: text={:?} total_chars={}",
                                tpi,
                                text,
                                tp.text.chars().count()
                            );
                        }
                        shape_found = true;
                    }
                }
            }
        }
    }
    assert!(shape_found, "글상자가 있는 Shape 컨트롤을 찾지 못했습니다");

    // 모든 문단 내용 덤프
    eprintln!("\n=== 문단 목록 (섹션 0) ===");
    let sec = &doc.document.sections[0];
    for (pi, para) in sec.paragraphs.iter().enumerate() {
        let text: String = para.text.chars().take(60).collect();
        let ctrl_types: Vec<String> = para
            .controls
            .iter()
            .map(|c| match c {
                Control::Table(_) => "Table".to_string(),
                Control::Shape(s) => format!(
                    "Shape({:?})",
                    match s.as_ref() {
                        crate::model::shape::ShapeObject::Rectangle(_) => "Rect",
                        crate::model::shape::ShapeObject::Ellipse(_) => "Ellipse",
                        crate::model::shape::ShapeObject::Line(_) => "Line",
                        _ => "Other",
                    }
                ),
                Control::SectionDef(_) => "SectionDef".to_string(),
                Control::ColumnDef(_) => "ColumnDef".to_string(),
                _ => "Other".to_string(),
            })
            .collect();
        eprintln!(
            "  para[{}]: text_len={} line_segs={} char_shapes={} ctrls={:?} text={:?}",
            pi,
            para.text.chars().count(),
            para.line_segs.len(),
            para.char_shapes.len(),
            ctrl_types,
            text
        );
    }

    // 렌더 트리에서 TextRun의 cell context 확인
    let page_count = doc.page_count();
    eprintln!("\n페이지 수: {}", page_count);

    fn count_textruns(node: &RenderNode, body_runs: &mut Vec<String>, cell_runs: &mut Vec<String>) {
        if let RenderNodeType::TextRun(ref tr) = node.node_type {
            let (ppi, ci, cei, cpi) =
                tr.cell_context
                    .as_ref()
                    .map_or((None, None, None, None), |ctx| {
                        (
                            Some(ctx.parent_para_index),
                            Some(ctx.path[0].control_index),
                            Some(ctx.path[0].cell_index),
                            Some(ctx.path[0].cell_para_index),
                        )
                    });
            let info = format!(
                    "text={:?} sec={:?} para={:?} char_start={:?} ppi={:?} ci={:?} cei={:?} cpi={:?} bbox=({:.1},{:.1},{:.1},{:.1})",
                    tr.text.chars().take(15).collect::<String>(),
                    tr.section_index, tr.para_index, tr.char_start,
                    ppi, ci, cei, cpi,
                    node.bbox.x, node.bbox.y, node.bbox.width, node.bbox.height,
                );
            if tr.cell_context.is_some() {
                cell_runs.push(info);
            } else {
                body_runs.push(info);
            }
        }
        for child in &node.children {
            count_textruns(child, body_runs, cell_runs);
        }
    }

    for page in 0..page_count {
        let tree = doc.build_page_tree(page as u32).unwrap();
        let mut body_runs = Vec::new();
        let mut cell_runs = Vec::new();
        count_textruns(&tree.root, &mut body_runs, &mut cell_runs);
        eprintln!("\n--- 페이지 {} ---", page);
        eprintln!("본문 TextRun: {}개", body_runs.len());
        for r in &body_runs {
            eprintln!("  [body] {}", r);
        }
        eprintln!("셀/글상자 TextRun: {}개", cell_runs.len());
        for r in &cell_runs {
            eprintln!("  [cell] {}", r);
        }
    }
}

/// 타스크66: 텍스트+Table(treat_as_char) 혼합 문단의 인라인 렌더링 검증
/// treat_as_char 표는 텍스트와 같은 줄에 인라인 배치되어야 함
#[test]
fn test_task66_table_text_mixed_paragraph_rendering() {
    use crate::renderer::composer::compose_paragraph;
    use crate::renderer::render_tree::{RenderNode, RenderNodeType};

    let path = "samples/img-start-001.hwp";
    assert!(
        std::path::Path::new(path).exists(),
        "테스트 입력 파일 없음: {:?}",
        path
    );

    let data = std::fs::read(path).unwrap();
    let doc = HwpDocument::from_bytes(&data).unwrap();

    // para[1]: 텍스트와 Table 컨트롤이 공존하는 문단
    let para1 = &doc.document.sections[0].paragraphs[1];
    assert!(!para1.text.is_empty(), "para[1]에 텍스트가 있어야 함");
    let has_treat_as_char_table = para1
        .controls
        .iter()
        .any(|c| matches!(c, Control::Table(t) if t.attr & 0x01 != 0));
    assert!(
        has_treat_as_char_table,
        "para[1]에 treat_as_char Table이 있어야 함"
    );

    // compose: 2개 줄 이상
    let composed = compose_paragraph(para1);
    assert!(composed.lines.len() >= 2, "최소 2줄 이상이어야 함");
    let line1_text: String = composed.lines[1]
        .runs
        .iter()
        .map(|r| r.text.as_str())
        .collect();
    assert!(
        line1_text.contains("주관부서"),
        "두 번째 줄에 '주관부서' 텍스트가 있어야 함"
    );

    // pagination: 블록형 treat_as_char 표(2+ line_segs)는 PageItem::Table로 emit
    // truly inline(1 line_seg + 텍스트)만 FullParagraph로 처리
    assert!(
        para1.line_segs.len() >= 2,
        "para[1]은 2+ line_segs (블록형 treat_as_char)"
    );
    let mut found_block_table = false;
    let mut found_partial_para = false;
    for pr in doc.pagination.iter() {
        for page in &pr.pages {
            for col in &page.column_contents {
                for item in &col.items {
                    match item {
                        crate::renderer::pagination::PageItem::Table { para_index, .. }
                            if *para_index == 1 =>
                        {
                            found_block_table = true;
                        }
                        crate::renderer::pagination::PageItem::PartialParagraph {
                            para_index,
                            ..
                        } if *para_index == 1 => {
                            found_partial_para = true;
                        }
                        _ => {}
                    }
                }
            }
        }
    }
    assert!(
        found_block_table,
        "블록형 treat_as_char 표는 PageItem::Table로 emit되어야 함"
    );
    assert!(
        found_partial_para,
        "블록형 treat_as_char 표의 텍스트는 PartialParagraph로 emit되어야 함"
    );

    // 렌더 트리: Table과 TextRun이 모두 존재해야 함
    let tree = doc.build_page_tree(0).unwrap();
    fn find_table_and_text(node: &RenderNode, table_found: &mut bool, text_found: &mut bool) {
        match &node.node_type {
            RenderNodeType::Table(_) => {
                *table_found = true;
            }
            RenderNodeType::TextRun(ref tr) => {
                if tr.para_index == Some(1) && tr.cell_context.is_none() && !tr.text.is_empty() {
                    *text_found = true;
                }
            }
            _ => {}
        }
        for child in &node.children {
            find_table_and_text(child, table_found, text_found);
        }
    }
    let mut table_found = false;
    let mut text_found = false;
    find_table_and_text(&tree.root, &mut table_found, &mut text_found);
    assert!(table_found, "렌더 트리에 표가 있어야 함");
    assert!(text_found, "렌더 트리에 para[1] 텍스트가 있어야 함");

    // SVG: 개별 문자가 <text> 요소로 출력되는지 확인
    let svg = doc.render_page_svg_native(0).unwrap();
    assert!(svg.contains("주"), "SVG에 '주' 문자가 포함되어야 함");
    assert!(svg.contains("【"), "SVG에 '【' 문자가 포함되어야 함");
}

/// 타스크 76: hwp-multi-001.hwp 2페이지에 그룹 이미지 3장이 존재하는지 검증
#[test]
fn test_task76_multi_001_group_images() {
    use crate::renderer::render_tree::{RenderNode, RenderNodeType};

    let path = "samples/hwp-multi-001.hwp";
    assert!(
        std::path::Path::new(path).exists(),
        "테스트 입력 파일 없음: {:?}",
        path
    );

    let data = std::fs::read(path).unwrap();
    let doc = HwpDocument::from_bytes(&data).unwrap();
    assert!(doc.page_count() >= 2, "최소 2페이지 이상이어야 함");

    // 2페이지 렌더 트리에서 Image 노드 수 확인
    let tree = doc.build_page_tree(1).unwrap();
    fn count_images(node: &RenderNode) -> usize {
        let mut count = match &node.node_type {
            RenderNodeType::Image(_) => 1,
            _ => 0,
        };
        for child in &node.children {
            count += count_images(child);
        }
        count
    }
    let image_count = count_images(&tree.root);
    assert!(
        image_count >= 3,
        "hwp-multi-001.hwp 2페이지에 Image 노드가 3개 이상이어야 함 (실제: {})",
        image_count
    );
}

/// 타스크 76: hwp-3.0-HWPML.hwp 1페이지 배경 이미지가 body clip 바깥에 위치하는지 검증
#[test]
fn test_task76_background_image_outside_body_clip() {
    use crate::renderer::render_tree::{RenderNode, RenderNodeType};

    let path = "samples/hwp-3.0-HWPML.hwp";
    assert!(
        std::path::Path::new(path).exists(),
        "테스트 입력 파일 없음: {:?}",
        path
    );

    let data = std::fs::read(path).unwrap();
    let doc = HwpDocument::from_bytes(&data).unwrap();

    let tree = doc.build_page_tree(0).unwrap();

    // root의 직접 자식(Body 바깥)에 Image 노드가 있어야 함
    let root_image_count = tree
        .root
        .children
        .iter()
        .filter(|child| {
            matches!(&child.node_type, RenderNodeType::Image(_))
                || child
                    .children
                    .iter()
                    .any(|c| matches!(&c.node_type, RenderNodeType::Image(_)))
        })
        .count();
    assert!(
        root_image_count >= 1,
        "배경 이미지가 body clip 바깥(root 직접 자식)에 있어야 함 (실제: {})",
        root_image_count
    );

    // 배경 이미지 좌표 검증: (0, 0) 근처
    fn find_root_image(node: &RenderNode) -> Option<(f64, f64)> {
        if let RenderNodeType::Image(_) = &node.node_type {
            return Some((node.bbox.x, node.bbox.y));
        }
        for child in &node.children {
            if let Some(pos) = find_root_image(child) {
                return Some(pos);
            }
        }
        None
    }
    for child in &tree.root.children {
        if let Some((x, y)) = find_root_image(child) {
            assert!(
                x.abs() < 1.0 && y.abs() < 1.0,
                "배경 이미지는 (0,0) 근처여야 함 (실제: ({:.1}, {:.1}))",
                x,
                y
            );
            break;
        }
    }
}

/// 타스크 76: hwp-img-001.hwp에 독립 이미지 4장이 존재하는지 검증
#[test]
fn test_task76_img_001_four_pictures() {
    use crate::renderer::render_tree::{RenderNode, RenderNodeType};

    let path = "samples/hwp-img-001.hwp";
    assert!(
        std::path::Path::new(path).exists(),
        "테스트 입력 파일 없음: {:?}",
        path
    );

    let data = std::fs::read(path).unwrap();
    let doc = HwpDocument::from_bytes(&data).unwrap();

    let tree = doc.build_page_tree(0).unwrap();
    fn count_images(node: &RenderNode) -> usize {
        let mut count = match &node.node_type {
            RenderNodeType::Image(_) => 1,
            _ => 0,
        };
        for child in &node.children {
            count += count_images(child);
        }
        count
    }
    let image_count = count_images(&tree.root);
    assert_eq!(
        image_count, 4,
        "hwp-img-001.hwp에 Image 노드가 4개여야 함 (실제: {})",
        image_count
    );
}

#[test]
fn test_task78_rectangle_textbox_inline_images() {
    use crate::model::shape::ShapeObject;
    use crate::renderer::render_tree::{RenderNode, RenderNodeType};

    let path = "samples/20250130-hongbo.hwp";
    assert!(
        std::path::Path::new(path).exists(),
        "테스트 입력 파일 없음: {:?}",
        path
    );

    let data = std::fs::read(path).unwrap();
    let doc = HwpDocument::from_bytes(&data).unwrap();

    // para[25]의 GSO 컨트롤이 Rectangle (Group이 아닌)으로 파싱되는지 검증
    let section = &doc.document.sections[0];
    let para25 = &section.paragraphs[25];
    assert_eq!(para25.controls.len(), 1, "para[25]에 컨트롤 1개 있어야 함");

    if let Control::Shape(shape) = &para25.controls[0] {
        if let ShapeObject::Rectangle(rect) = shape.as_ref() {
            // Rectangle으로 올바르게 파싱됨
            assert!(rect.common.treat_as_char, "treat_as_char=true");
            // TextBox가 있어야 함
            assert!(
                rect.drawing.text_box.is_some(),
                "Rectangle에 TextBox가 있어야 함"
            );
            let tb = rect.drawing.text_box.as_ref().unwrap();
            assert!(!tb.paragraphs.is_empty(), "TextBox에 문단이 있어야 함");
            // TextBox 문단에 인라인 Picture 컨트롤 2개
            let pic_count: usize = tb
                .paragraphs
                .iter()
                .flat_map(|p| &p.controls)
                .filter(|c| matches!(c, Control::Picture(_)))
                .count();
            assert_eq!(pic_count, 2, "TextBox에 인라인 Picture 2개 있어야 함");
        } else {
            panic!("para[25]의 컨트롤이 Rectangle이어야 함 (Group이 아닌)");
        }
    } else {
        panic!("para[25]의 컨트롤이 Shape이어야 함");
    }

    // 페이지 2 렌더 트리에서 이미지 2개 렌더링 확인
    fn find_images(node: &RenderNode) -> Vec<u16> {
        let mut ids = Vec::new();
        if let RenderNodeType::Image(img) = &node.node_type {
            ids.push(img.bin_data_id);
        }
        for child in &node.children {
            ids.extend(find_images(child));
        }
        ids
    }

    let tree = doc.build_page_tree(1).unwrap(); // 페이지 2 (인덱스 1)
    let images = find_images(&tree.root);
    assert!(
        images.len() >= 2,
        "페이지 2에 이미지 2개 이상 렌더링되어야 함 (실제: {}개)",
        images.len()
    );
}

#[test]
fn test_hy001_textbox_inline_pictures_render_for_hwp_and_hwpx() {
    use crate::model::shape::ShapeObject;
    use crate::renderer::render_tree::{RenderNode, RenderNodeType};

    fn collect_image_positions(node: &RenderNode, out: &mut Vec<(u16, f64)>) {
        if let RenderNodeType::Image(img) = &node.node_type {
            out.push((img.bin_data_id, node.bbox.x));
        }
        for child in &node.children {
            collect_image_positions(child, out);
        }
    }

    fn assert_textbox_picture_roundtrip(path: &str) {
        assert!(
            std::path::Path::new(path).exists(),
            "테스트 입력 파일 없음: {:?}",
            path
        );

        let data = std::fs::read(path).unwrap();
        let doc = HwpDocument::from_bytes(&data).unwrap();
        let para = &doc.document.sections[0].paragraphs[27];
        let shape = para
            .controls
            .iter()
            .find_map(|ctrl| match ctrl {
                Control::Shape(shape) => Some(shape.as_ref()),
                _ => None,
            })
            .expect("hy-001 paragraph 27 should contain a shape control");

        let text_box = match shape {
            ShapeObject::Rectangle(rect) => rect.drawing.text_box.as_ref(),
            _ => None,
        }
        .expect("hy-001 shape should contain a text box");

        let textbox_picture_ids: Vec<u16> = text_box
            .paragraphs
            .iter()
            .flat_map(|p| &p.controls)
            .filter_map(|ctrl| match ctrl {
                Control::Picture(pic) => Some(pic.image_attr.bin_data_id),
                _ => None,
            })
            .collect();
        assert_eq!(
            textbox_picture_ids,
            vec![2, 3],
            "{}: text box should keep picture controls for BinData 2 and 3",
            path
        );

        let tree = doc.build_page_tree(1).unwrap();
        let mut rendered_images = Vec::new();
        collect_image_positions(&tree.root, &mut rendered_images);
        let rendered_image_ids: Vec<u16> = rendered_images.iter().map(|(id, _)| *id).collect();
        assert!(
            rendered_image_ids.contains(&2) && rendered_image_ids.contains(&3),
            "{}: page 2 render tree should contain text box images BinData 2 and 3 (actual: {:?})",
            path,
            rendered_image_ids
        );

        let image2_x = rendered_images
            .iter()
            .find_map(|(id, x)| (*id == 2).then_some(*x))
            .expect("BinData 2 should be rendered");
        let image3_x = rendered_images
            .iter()
            .find_map(|(id, x)| (*id == 3).then_some(*x))
            .expect("BinData 3 should be rendered");
        let gap = image3_x - image2_x;
        assert!(
                (525.0..=550.0).contains(&gap),
                "{}: text box TAC pictures should preserve Hancom-width space advance between controls (x2={:.1}, x3={:.1}, gap={:.1})",
                path,
                image2_x,
                image3_x,
                gap
            );
    }

    assert_textbox_picture_roundtrip("samples/hwpx/hancom-hwp/hy-001.hwp");
    assert_textbox_picture_roundtrip("samples/hwpx/hy-001.hwpx");
}

#[test]
fn test_hy002_textbox_non_tac_picture_keeps_declared_size() {
    use crate::renderer::render_tree::{RenderNode, RenderNodeType};

    fn collect_images(node: &RenderNode, out: &mut Vec<(u16, f64, f64)>) {
        if let RenderNodeType::Image(img) = &node.node_type {
            out.push((img.bin_data_id, node.bbox.width, node.bbox.height));
        }
        for child in &node.children {
            collect_images(child, out);
        }
    }

    fn assert_textbox_picture_size(path: &str) {
        assert!(
            std::path::Path::new(path).exists(),
            "테스트 입력 파일 없음: {:?}",
            path
        );

        let data = std::fs::read(path).unwrap();
        let doc = HwpDocument::from_bytes(&data).unwrap();
        let tree = doc.build_page_tree(1).unwrap();

        let mut images = Vec::new();
        collect_images(&tree.root, &mut images);
        let image2 = images
            .iter()
            .find(|(id, width, height)| *id == 2 && *width > 600.0 && *height > 50.0);

        assert!(
            image2.is_some(),
            "{}: text box non-TAC image should keep declared display size near 642x58px (actual: {:?})",
            path,
            images
        );
    }

    assert_textbox_picture_size("samples/hwpx/hancom-hwp/hy-002.hwp");
    assert_textbox_picture_size("samples/hwpx/hy-002.hwpx");
}

/// 타스크 79: 투명선 표시 기능 — show_transparent_borders=true 시 추가 Line 노드 생성 검증
#[test]
fn test_task79_transparent_border_lines() {
    use crate::model::style::BorderLineType;
    use crate::renderer::render_tree::{RenderNode, RenderNodeType};

    fn count_lines(node: &RenderNode) -> usize {
        let mut count = 0;
        if matches!(&node.node_type, RenderNodeType::Line(_)) {
            count += 1;
        }
        for child in &node.children {
            count += count_lines(child);
        }
        count
    }

    // 여러 표 포함 파일로 검증
    let files = [
        "samples/table-001.hwp",
        "samples/hwp_table_test.hwp",
        "samples/table-complex.hwp",
        "samples/hwpers_test4_complex_table.hwp",
        "samples/table-ipc.hwp",
    ];

    let mut tested = false;
    for path in &files {
        assert!(
            std::path::Path::new(path).exists(),
            "테스트 입력 파일 없음: {:?}",
            path
        );
        let data = std::fs::read(path).unwrap();
        let mut doc = HwpDocument::from_bytes(&data).unwrap();

        // 문서 내 None 테두리 존재 여부 확인
        let has_none_border = doc.document.doc_info.border_fills.iter().any(|bf| {
            bf.borders
                .iter()
                .any(|b| b.line_type == BorderLineType::None)
        });

        // 투명선 OFF
        doc.show_transparent_borders = false;
        let tree_off = doc.build_page_tree(0).unwrap();
        let lines_off = count_lines(&tree_off.root);

        // 투명선 ON
        doc.show_transparent_borders = true;
        let tree_on = doc.build_page_tree(0).unwrap();
        let lines_on = count_lines(&tree_on.root);

        // 회귀 없음: ON >= OFF
        assert!(
            lines_on >= lines_off,
            "{}: 투명선 ON({})이 OFF({}) 이상이어야 함",
            path,
            lines_on,
            lines_off
        );

        // SVG 렌더링 정상 확인
        let svg = doc.render_page_svg_native(0).unwrap();
        assert!(svg.contains("<svg"), "{}: SVG 렌더링 실패", path);

        eprintln!(
            "{}: OFF={} ON={} (+{}) has_none_border={}",
            path,
            lines_off,
            lines_on,
            lines_on - lines_off,
            has_none_border
        );
        tested = true;
    }
    assert!(tested, "테스트할 수 있는 파일이 없음");
}

#[test]
fn test_task80_cell_height_matches_hwp() {
    // 셀 높이 검증: 단일 줄/단일 문단 셀의 컨텐츠 높이 + 패딩 ≈ HWP 선언 높이
    // (마지막 줄 line_spacing이 제외되었는지 확인)
    use crate::renderer::composer::compose_paragraph;

    let path = "samples/table-001.hwp";
    assert!(
        std::path::Path::new(path).exists(),
        "테스트 입력 파일 없음: {:?}",
        path
    );
    let data = std::fs::read(path).unwrap();
    let doc = HwpDocument::from_bytes(&data).unwrap();
    let dpi = 96.0;

    let mut checked = 0;
    for sec in &doc.document.sections {
        for para in &sec.paragraphs {
            for ctrl in &para.controls {
                if let Control::Table(table) = ctrl {
                    for cell in &table.cells {
                        // 단일 행, 단일 문단, 유효한 높이만 검증
                        if cell.row_span != 1 {
                            continue;
                        }
                        if cell.paragraphs.len() != 1 {
                            continue;
                        }
                        if cell.height == 0 || cell.height >= 0x80000000 {
                            continue;
                        }

                        let comp = compose_paragraph(&cell.paragraphs[0]);
                        if comp.lines.is_empty() {
                            continue;
                        }

                        let pad_top = if cell.padding.top != 0 {
                            crate::renderer::hwpunit_to_px(cell.padding.top as i32, dpi)
                        } else {
                            crate::renderer::hwpunit_to_px(table.padding.top as i32, dpi)
                        };
                        let pad_bottom = if cell.padding.bottom != 0 {
                            crate::renderer::hwpunit_to_px(cell.padding.bottom as i32, dpi)
                        } else {
                            crate::renderer::hwpunit_to_px(table.padding.bottom as i32, dpi)
                        };

                        // 마지막 줄 line_spacing 제외
                        let lc = comp.lines.len();
                        let content: f64 = comp
                            .lines
                            .iter()
                            .enumerate()
                            .map(|(i, line)| {
                                let h = crate::renderer::hwpunit_to_px(line.line_height, dpi);
                                if i + 1 < lc {
                                    h + crate::renderer::hwpunit_to_px(line.line_spacing, dpi)
                                } else {
                                    h
                                }
                            })
                            .sum();

                        let required = content + pad_top + pad_bottom;
                        let declared = crate::renderer::hwpunit_to_px(cell.height as i32, dpi);

                        // 우리 계산값이 HWP 선언값 이하여야 함 (2px 허용)
                        assert!(required <= declared + 2.0,
                                "Cell row={} col={}: required={:.1}px > declared={:.1}px (diff={:.1}px)",
                                cell.row, cell.col, required, declared, required - declared);
                        checked += 1;
                    }
                }
            }
        }
    }
    eprintln!("task80: {}개 셀 높이 검증 통과", checked);
    assert!(checked > 0, "검증할 셀이 없음");
}

/// 타스크 81: table-004.hwp의 세로쓰기 셀 파싱 및 렌더 트리 검증
#[test]
fn test_task81_vertical_cell_text() {
    let path = "samples/table-004.hwp";
    assert!(
        std::path::Path::new(path).exists(),
        "테스트 입력 파일 없음: {:?}",
        path
    );
    let data = std::fs::read(path).unwrap();
    let doc = HwpDocument::from_bytes(&data).unwrap();

    // 1. 파서 검증: text_direction=2인 셀이 3개 존재
    let mut vertical_cells = Vec::new();
    for sec in &doc.document.sections {
        for para in &sec.paragraphs {
            for ctrl in &para.controls {
                if let crate::model::control::Control::Table(table) = ctrl {
                    for cell in &table.cells {
                        if cell.text_direction != 0 {
                            vertical_cells.push((cell.text_direction, cell.row, cell.col));
                        }
                    }
                }
            }
        }
    }
    assert_eq!(vertical_cells.len(), 3, "세로쓰기 셀이 3개여야 함");
    for (td, _r, _c) in &vertical_cells {
        assert_eq!(*td, 2, "text_direction은 2(영문세움)이어야 함");
    }

    // 2. 렌더 트리 검증: SVG 내보내기로 세로 배치 확인
    let dpi = 96.0;
    let styles = crate::renderer::style_resolver::resolve_styles(&doc.document.doc_info, dpi);
    let engine = crate::renderer::layout::LayoutEngine::new(dpi);

    // pagination → render tree
    assert!(
        !doc.pagination.is_empty(),
        "pagination 결과가 비어있으면 안 됨"
    );
    let pr = &doc.pagination[0];
    assert!(!pr.pages.is_empty(), "페이지가 비어있으면 안 됨");

    let section = &doc.document.sections[0];
    let composed: Vec<_> = section
        .paragraphs
        .iter()
        .map(crate::renderer::composer::compose_paragraph)
        .collect();
    let sec_mt = doc
        .measured_tables
        .first()
        .map(|v| v.as_slice())
        .unwrap_or(&[]);
    let tree = engine.build_render_tree(
        &pr.pages[0],
        &section.paragraphs,
        &section.paragraphs,
        &section.paragraphs,
        &composed,
        &styles,
        &section.section_def.footnote_shape,
        &doc.document.bin_data_content,
        None,
        sec_mt,
        Some(&section.section_def.page_border_fill),
        section.section_def.outline_numbering_id,
        &[],
    );

    // 렌더 트리에서 text_direction != 0인 TableCell 노드 찾기
    fn find_vertical_cells(
        node: &crate::renderer::render_tree::RenderNode,
    ) -> Vec<&crate::renderer::render_tree::RenderNode> {
        let mut result = Vec::new();
        if let crate::renderer::render_tree::RenderNodeType::TableCell(ref tc) = node.node_type {
            if tc.text_direction != 0 {
                result.push(node);
            }
        }
        for child in &node.children {
            result.extend(find_vertical_cells(child));
        }
        result
    }

    let vc_nodes = find_vertical_cells(&tree.root);
    assert!(
        vc_nodes.len() >= 3,
        "렌더 트리에 세로쓰기 셀이 3개 이상이어야 함, found: {}",
        vc_nodes.len()
    );

    // 각 세로쓰기 셀의 TextRun이 세로 방향으로 배치되었는지 확인
    for vc in &vc_nodes {
        let mut run_ys: Vec<f64> = Vec::new();
        for line_node in &vc.children {
            if let crate::renderer::render_tree::RenderNodeType::TextLine(_) = &line_node.node_type
            {
                for run_node in &line_node.children {
                    if let crate::renderer::render_tree::RenderNodeType::TextRun(ref tr) =
                        run_node.node_type
                    {
                        if !tr.text.trim().is_empty() {
                            run_ys.push(run_node.bbox.y);
                        }
                    }
                }
            }
        }
        // y좌표가 순차 증가해야 세로 배치
        assert!(
            run_ys.len() >= 2,
            "세로쓰기 셀에 TextRun이 2개 이상이어야 함"
        );
        for i in 1..run_ys.len() {
            assert!(
                run_ys[i] > run_ys[i - 1],
                "세로쓰기 글자의 y좌표가 순차 증가해야 함: y[{}]={} <= y[{}]={}",
                i,
                run_ys[i],
                i - 1,
                run_ys[i - 1]
            );
        }
    }
}

/// 표 바운딩박스 조회 테스트
#[test]
fn test_get_table_bbox() {
    use std::path::Path;

    let path = Path::new("samples/hwp_table_test.hwp");
    assert!(path.exists(), "테스트 입력 파일 없음: {:?}", path);

    let data = std::fs::read(path).unwrap();
    let doc = HwpDocument::from_bytes(&data).unwrap();

    let result = doc.get_table_bbox_native(0, 3, 0);
    assert!(result.is_ok(), "표 bbox 조회 실패: {:?}", result.err());

    let json = result.unwrap();
    assert!(json.contains("pageIndex"), "pageIndex 필드 존재 확인");
    assert!(json.contains("width"), "width 필드 존재 확인");
    assert!(json.contains("height"), "height 필드 존재 확인");
    eprintln!("표 bbox: {}", json);
}

/// #2400: page-local pointer 좌표는 같은 page 의 표 fragment bbox와 비교해야 한다.
#[test]
fn test_get_table_bbox_at_page_for_giant_multi_page_cell() {
    use std::path::Path;

    for path in [
        "rhwp-studio/public/samples/issue1949_giant_cell_nested_tables_perf.hwp",
        "samples/issue1949_giant_cell_nested_tables_perf.hwpx",
    ] {
        let data = std::fs::read(Path::new(path)).expect("#2400 권위 샘플 읽기");
        let doc = HwpDocument::from_bytes(&data).expect("#2400 권위 샘플 파싱");
        assert_eq!(doc.page_count(), 115, "{path}: page count");

        let legacy: Value = serde_json::from_str(
            &doc.get_table_bbox_native(0, 0, 2)
                .expect("legacy 첫 fragment bbox"),
        )
        .expect("legacy bbox JSON");
        let current: Value = serde_json::from_str(
            &doc.get_table_bbox_at_page_native(0, 0, 2, 113)
                .expect("page 113 fragment bbox"),
        )
        .expect("page-scoped bbox JSON");

        assert_eq!(legacy["pageIndex"].as_u64(), Some(0), "{path}: legacy page");
        assert_eq!(
            current["pageIndex"].as_u64(),
            Some(113),
            "{path}: current fragment page"
        );

        let click_y = 1057.3;
        let legacy_bottom = legacy["y"].as_f64().unwrap() + legacy["height"].as_f64().unwrap();
        let current_bottom = current["y"].as_f64().unwrap() + current["height"].as_f64().unwrap();
        assert!(
            (click_y - legacy_bottom).abs() <= 5.0,
            "{path}: 재현점은 첫 fragment 하단에 잘못 걸리는 전제"
        );
        assert!(
            (click_y - current_bottom).abs() > 5.0,
            "{path}: 현재 fragment에서는 실제 경계가 아님"
        );

        assert!(
            doc.get_table_bbox_at_page_native(0, 0, 2, 115).is_err(),
            "{path}: 범위 밖 page가 첫 fragment로 fallback하면 안 됨"
        );
    }
}

/// 표 컨트롤 삭제 테스트 (wasm_api 내부 접근)
#[test]
fn test_delete_table_control() {
    use std::path::Path;

    let path = Path::new("samples/hwp_table_test.hwp");
    assert!(path.exists(), "테스트 입력 파일 없음: {:?}", path);

    let data = std::fs::read(path).unwrap();
    let mut doc = HwpDocument::from_bytes(&data).unwrap();
    let _ = doc.convert_to_editable_native();

    // 삭제 전 컨트롤 수 확인
    let before_count = doc.document.sections[0].paragraphs[3].controls.len();
    assert!(before_count > 0, "테스트 파일에 표가 없음");

    // 삭제 전 char_count
    let before_char_count = doc.document.sections[0].paragraphs[3].char_count;
    let before_next_vpos = doc.document.sections[0]
        .paragraphs
        .get(4)
        .and_then(|p| p.line_segs.first())
        .map(|ls| ls.vertical_pos);

    // 표 bbox 조회 성공 확인
    let bbox_result = doc.get_table_bbox_native(0, 3, 0);
    assert!(bbox_result.is_ok(), "삭제 전 bbox 조회 실패");

    // 표 삭제
    let result = doc.delete_table_control_native(0, 3, 0);
    assert!(result.is_ok(), "표 삭제 실패: {:?}", result.err());

    // 삭제 후 컨트롤 수 감소 확인
    let after_count = doc.document.sections[0].paragraphs[3].controls.len();
    assert_eq!(after_count, before_count - 1, "컨트롤 수 감소 확인");

    // char_count가 8 감소했는지 확인
    let after_char_count = doc.document.sections[0].paragraphs[3].char_count;
    assert_eq!(
        after_char_count,
        before_char_count - 8,
        "char_count 8 감소 확인"
    );

    if let (Some(before), Some(after)) = (
        before_next_vpos,
        doc.document.sections[0]
            .paragraphs
            .get(4)
            .and_then(|p| p.line_segs.first())
            .map(|ls| ls.vertical_pos),
    ) {
        assert!(
            after < before,
            "표 삭제 후 다음 문단 vpos가 위로 당겨져야 함: before={}, after={}",
            before,
            after
        );
    }

    eprintln!(
        "표 삭제: 컨트롤 {}→{}, char_count {}→{}",
        before_count, after_count, before_char_count, after_char_count
    );
}

#[test]
/// B6: 표 구조 변경 후 저장 시 빈 셀 문단의 PARA_TEXT/char_count/LineSeg 검증
fn test_table_modification_empty_cell_serialization() {
    use crate::parser::record::Record;
    use std::path::Path;

    let path = Path::new("samples/hwp_table_test.hwp");
    assert!(path.exists(), "테스트 입력 파일 없음: {:?}", path);

    let data = std::fs::read(path).unwrap();

    // 행 추가 후 내보내기
    let mut doc = HwpDocument::from_bytes(&data).unwrap();
    doc.insert_table_row_native(0, 3, 0, 0, true).unwrap();
    let exported = doc.export_hwp_native().unwrap();

    // 재파싱
    let parsed = crate::parser::parse_hwp(&exported).unwrap();
    let mut cfb = crate::parser::cfb_reader::CfbReader::open(&exported).unwrap();
    let bt = cfb
        .read_body_text_section(0, parsed.header.compressed, false)
        .unwrap();
    let recs = Record::read_all(&bt).unwrap();

    // 표 범위 내 PARA_HEADER → PARA_TEXT 패턴 검사
    // cc=1인 문단(빈 셀)은 PARA_TEXT가 없어야 한다
    let mut empty_cell_count = 0;
    let mut violation_count = 0;

    for (i, rec) in recs.iter().enumerate() {
        if rec.tag_id == crate::parser::tags::HWPTAG_PARA_HEADER && rec.data.len() >= 4 {
            let cc_raw = u32::from_le_bytes(rec.data[0..4].try_into().unwrap());
            let cc = cc_raw & 0x7FFFFFFF;

            // 빈 문단 (cc == 0 또는 1)
            if cc <= 1 {
                empty_cell_count += 1;

                // 다음 레코드가 PARA_TEXT이면 안 됨
                if i + 1 < recs.len() && recs[i + 1].tag_id == crate::parser::tags::HWPTAG_PARA_TEXT
                {
                    violation_count += 1;
                    eprintln!(
                        "!! 위반: rec[{}] cc={} 다음에 PARA_TEXT({}B) 존재",
                        i,
                        cc,
                        recs[i + 1].data.len()
                    );
                }

                // cc=0이면 안 됨 (HWP 스펙: 최소 cc=1)
                if cc == 0 {
                    eprintln!("!! 위반: rec[{}] cc=0 (HWP 스펙 위반, 최소 1이어야 함)", i);
                    violation_count += 1;
                }

                // PARA_LINE_SEG가 존재해야 함 — PARA_CHAR_SHAPE 다음에
                let mut has_line_seg = false;
                for j in (i + 1)..recs.len() {
                    if recs[j].tag_id == crate::parser::tags::HWPTAG_PARA_HEADER
                        || recs[j].level <= rec.level
                    {
                        break;
                    }
                    if recs[j].tag_id == crate::parser::tags::HWPTAG_PARA_LINE_SEG {
                        has_line_seg = true;
                        break;
                    }
                }
                if !has_line_seg {
                    eprintln!("!! 위반: rec[{}] cc={} PARA_LINE_SEG 없음", i, cc);
                    violation_count += 1;
                }
            }
        }
    }

    eprintln!(
        "빈 문단 수: {}, 위반: {}",
        empty_cell_count, violation_count
    );
    assert!(
        empty_cell_count > 0,
        "빈 셀 문단이 없음 — 테스트 유효성 확인 필요"
    );
    assert_eq!(
        violation_count, 0,
        "빈 셀 문단 직렬화 위반이 {}건 발견됨",
        violation_count
    );
}

#[test]
fn test_task105_nested_table_path_api() {
    let data = std::fs::read("samples/inner-table-01.hwp").unwrap();
    let doc = HwpDocument::from_bytes(&data).unwrap();

    // 1. hitTest로 중첩 표 셀의 cellPath 확인
    let page_count = doc.page_count();
    eprintln!("페이지 수: {}", page_count);

    // 문서 구조 확인: 중첩 표 위치
    let sec = &doc.document.sections[0];
    for (pi, para) in sec.paragraphs.iter().enumerate() {
        for (ci, ctrl) in para.controls.iter().enumerate() {
            if let Control::Table(t) = ctrl {
                eprintln!(
                    "문단[{}] 컨트롤[{}]: 표 {}행x{}열 셀{}개",
                    pi,
                    ci,
                    t.row_count,
                    t.col_count,
                    t.cells.len()
                );
                for (cell_idx, cell) in t.cells.iter().enumerate() {
                    for (cp_idx, cp) in cell.paragraphs.iter().enumerate() {
                        for (cci, cctrl) in cp.controls.iter().enumerate() {
                            if let Control::Table(nt) = cctrl {
                                eprintln!(
                                    "  셀[{}] 문단[{}] 컨트롤[{}]: 중첩 표 {}행x{}열 셀{}개",
                                    cell_idx,
                                    cp_idx,
                                    cci,
                                    nt.row_count,
                                    nt.col_count,
                                    nt.cells.len()
                                );
                            }
                        }
                    }
                }
            }
        }
    }

    // 렌더 트리에서 중첩 표 TextRun 찾기
    use crate::renderer::render_tree::{RenderNode, RenderNodeType};
    fn find_nested_run(node: &RenderNode) -> Option<(usize, Vec<(usize, usize, usize)>)> {
        if let RenderNodeType::TextRun(ref tr) = node.node_type {
            if let Some(ref ctx) = tr.cell_context {
                if ctx.path.len() >= 2 {
                    let path: Vec<(usize, usize, usize)> = ctx
                        .path
                        .iter()
                        .map(|e| (e.control_index, e.cell_index, e.cell_para_index))
                        .collect();
                    return Some((ctx.parent_para_index, path));
                }
            }
        }
        for child in &node.children {
            if let Some(r) = find_nested_run(child) {
                return Some(r);
            }
        }
        None
    }

    // 모든 페이지에서 중첩 TextRun 탐색
    let mut nested = None;
    for page in 0..page_count {
        let tree = doc.build_page_tree(page as u32).unwrap();
        fn dump_runs(node: &RenderNode, page: u32) {
            if let RenderNodeType::TextRun(ref tr) = node.node_type {
                let ctx_info = tr
                    .cell_context
                    .as_ref()
                    .map(|ctx| {
                        format!(
                            "ppi={}, path_len={}, path={:?}",
                            ctx.parent_para_index,
                            ctx.path.len(),
                            ctx.path
                                .iter()
                                .map(|e| (e.control_index, e.cell_index, e.cell_para_index))
                                .collect::<Vec<_>>()
                        )
                    })
                    .unwrap_or_else(|| "None".to_string());
                eprintln!(
                    "  p{} TextRun: text={:?} ctx={}",
                    page,
                    tr.text.chars().take(10).collect::<String>(),
                    ctx_info
                );
            }
            for child in &node.children {
                dump_runs(child, page);
            }
        }
        dump_runs(&tree.root, page as u32);
        if nested.is_none() {
            nested = find_nested_run(&tree.root);
        }
    }
    assert!(nested.is_some(), "중첩 표 TextRun이 있어야 합니다");
    let (parent_para, path) = nested.unwrap();
    eprintln!("중첩 표 경로: parent_para={}, path={:?}", parent_para, path);

    // 2. resolve_table_by_path로 중첩 표 접근
    let table = doc.resolve_table_by_path(0, parent_para, &path);
    assert!(
        table.is_ok(),
        "resolve_table_by_path 실패: {:?}",
        table.err()
    );
    let table = table.unwrap();
    eprintln!(
        "중첩 표: {}행 x {}열, 셀 {}개",
        table.row_count,
        table.col_count,
        table.cells.len()
    );

    // 3. resolve_cell_by_path로 셀 접근
    let cell = doc.resolve_cell_by_path(0, parent_para, &path);
    assert!(cell.is_ok(), "resolve_cell_by_path 실패: {:?}", cell.err());

    // 4. getCellInfoByPath 경로 API
    let path_json = format!(
        "[{}]",
        path.iter()
            .map(|(ci, cei, cpi)| {
                format!(
                    "{{\"controlIndex\":{},\"cellIndex\":{},\"cellParaIndex\":{}}}",
                    ci, cei, cpi
                )
            })
            .collect::<Vec<_>>()
            .join(",")
    );
    eprintln!("path_json: {}", path_json);

    let cell_info = doc.get_cell_info_by_path_native(0, parent_para, &path_json);
    assert!(
        cell_info.is_ok(),
        "getCellInfoByPath 실패: {:?}",
        cell_info.err()
    );
    eprintln!("셀 정보: {}", cell_info.unwrap());

    // 5. getTableDimensionsByPath 경로 API
    let dims = doc.get_table_dimensions_by_path_native(0, parent_para, &path_json);
    assert!(
        dims.is_ok(),
        "getTableDimensionsByPath 실패: {:?}",
        dims.err()
    );
    eprintln!("표 차원: {}", dims.unwrap());

    // 6. getCursorRectByPath 경로 API
    let cursor = doc.get_cursor_rect_by_path_native(0, parent_para, &path_json, 0);
    assert!(
        cursor.is_ok(),
        "getCursorRectByPath 실패: {:?}",
        cursor.err()
    );
    eprintln!("커서 위치: {}", cursor.unwrap());

    // 7. getTableCellBboxesByPath 경로 API
    let bboxes = doc.get_table_cell_bboxes_by_path_native(0, parent_para, &path_json);
    assert!(
        bboxes.is_ok(),
        "getTableCellBboxesByPath 실패: {:?}",
        bboxes.err()
    );
    eprintln!("셀 bbox: {}", bboxes.unwrap());

    // 8. hitTest에서 cellPath 포함 확인
    let hit_json = doc.hit_test_native(0, 400.0, 600.0);
    if let Ok(ref json) = hit_json {
        eprintln!("hitTest 결과: {}", json);
        if json.contains("cellPath") {
            eprintln!("✓ hitTest에 cellPath 포함됨");
        } else {
            eprintln!("✗ hitTest에 cellPath 없음 — 본문 영역 클릭일 수 있음");
        }
    }
}

#[test]
fn test_task110_treatise_diag() {
    let path = "samples/basic/treatise sample.hwp";
    assert!(
        std::path::Path::new(path).exists(),
        "테스트 입력 파일 없음: {:?}",
        path
    );
    let data = std::fs::read(path).unwrap();
    let mut doc = HwpDocument::from_bytes(&data).unwrap();

    eprintln!("=== treatise sample.hwp 다단 구조 진단 ===");
    eprintln!("구역 수: {}", doc.document.sections.len());

    for (sec_idx, section) in doc.document.sections.iter().enumerate() {
        eprintln!("\n--- 구역 {} ---", sec_idx);
        eprintln!("문단 수: {}", section.paragraphs.len());

        // ColumnDef 확인
        let column_def = HwpDocument::find_initial_column_def(&section.paragraphs);
        eprintln!(
            "initial ColumnDef: count={}, same_width={}, spacing={}, widths={:?}, gaps={:?}",
            column_def.column_count,
            column_def.same_width,
            column_def.spacing,
            column_def.widths,
            column_def.gaps
        );
        // 2단 ColumnDef 검색
        if section.paragraphs.len() > 14 {
            let cd2 = HwpDocument::find_column_def_for_paragraph(&section.paragraphs, 14);
            eprintln!(
                "para[14] ColumnDef: count={}, same_width={}, spacing={}, widths={:?}, gaps={:?}",
                cd2.column_count, cd2.same_width, cd2.spacing, cd2.widths, cd2.gaps
            );
            let layout2 = crate::renderer::page_layout::PageLayoutInfo::from_page_def(
                &section.section_def.page_def,
                &cd2,
                doc.dpi,
            );
            for (i, ca) in layout2.column_areas.iter().enumerate() {
                let w_hu = crate::renderer::px_to_hwpunit(ca.width, doc.dpi);
                eprintln!(
                    "  2단 column_areas[{}]: x={:.1}px w={:.1}px ({}hu)",
                    i, ca.x, ca.width, w_hu
                );
            }
        }

        // PageLayoutInfo 확인
        let layout = crate::renderer::page_layout::PageLayoutInfo::from_page_def(
            &section.section_def.page_def,
            &column_def,
            doc.dpi,
        );
        eprintln!("column_areas 수: {}", layout.column_areas.len());
        for (i, ca) in layout.column_areas.iter().enumerate() {
            let w_hu = crate::renderer::px_to_hwpunit(ca.width, doc.dpi);
            eprintln!(
                "  column_areas[{}]: x={:.1}px w={:.1}px ({}hu)",
                i, ca.x, ca.width, w_hu
            );
        }

        // para_column_map 확인
        let map = &doc.para_column_map;
        if sec_idx < map.len() && !map[sec_idx].is_empty() {
            eprintln!("para_column_map[{}] 길이: {}", sec_idx, map[sec_idx].len());
            for (pi, &ci) in map[sec_idx].iter().enumerate() {
                let seg_w = section
                    .paragraphs
                    .get(pi)
                    .and_then(|p| p.line_segs.first())
                    .map(|ls| ls.segment_width)
                    .unwrap_or(0);
                eprintln!(
                    "  para[{}] → col_idx={}, first_line seg_w={}",
                    pi, ci, seg_w
                );
            }
        } else {
            eprintln!("para_column_map[{}] 비어있음!", sec_idx);
        }

        // 첫 10개 문단의 첫 줄 segment_width
        eprintln!("첫 10개 문단 segment_width:");
        for pi in 0..std::cmp::min(10, section.paragraphs.len()) {
            let para = &section.paragraphs[pi];
            let seg_w = para
                .line_segs
                .first()
                .map(|ls| ls.segment_width)
                .unwrap_or(0);
            let text_preview: String = para.text.chars().take(30).collect();
            eprintln!("  para[{}]: seg_w={}, text={:?}", pi, seg_w, text_preview);
        }
    }

    // 편집 시뮬레이션: 구역0, 문단1, 오프셋0에 "X" 삽입
    eprintln!("\n=== 편집 시뮬레이션: insert_text_native(0, 1, 0, \"X\") ===");
    let result = doc.insert_text_native(0, 1, 0, "X");
    eprintln!("insert_text 결과: {:?}", result);

    // 편집 후 문단1의 첫 줄 segment_width 확인
    let para1 = &doc.document.sections[0].paragraphs[1];
    eprintln!("편집 후 para[1] line_segs:");
    for (i, ls) in para1.line_segs.iter().enumerate() {
        eprintln!(
            "  line[{}]: seg_w={} text_start={} line_height={}",
            i, ls.segment_width, ls.text_start, ls.line_height
        );
    }

    // available_width 비교: 단 너비 vs 페이지 너비
    let section = &doc.document.sections[0];
    let column_def = HwpDocument::find_initial_column_def(&section.paragraphs);
    let layout = crate::renderer::page_layout::PageLayoutInfo::from_page_def(
        &section.section_def.page_def,
        &column_def,
        doc.dpi,
    );
    let layout_single = crate::renderer::page_layout::PageLayoutInfo::from_page_def(
        &section.section_def.page_def,
        &crate::model::page::ColumnDef::default(),
        doc.dpi,
    );

    let col_w_hu = if !layout.column_areas.is_empty() {
        crate::renderer::px_to_hwpunit(layout.column_areas[0].width, doc.dpi)
    } else {
        0
    };
    let page_w_hu = if !layout_single.column_areas.is_empty() {
        crate::renderer::px_to_hwpunit(layout_single.column_areas[0].width, doc.dpi)
    } else {
        0
    };

    let actual_seg_w = para1
        .line_segs
        .first()
        .map(|ls| ls.segment_width)
        .unwrap_or(0);
    eprintln!("\n=== para[1] available_width 비교 (1단 영역) ===");
    eprintln!("단 너비 (column_areas[0]): {}hu", col_w_hu);
    eprintln!("페이지 전체 너비 (단일 단): {}hu", page_w_hu);
    eprintln!("실제 seg_w: {}hu", actual_seg_w);

    let diff_col = (actual_seg_w as i64 - col_w_hu as i64).abs();
    let diff_page = (actual_seg_w as i64 - page_w_hu as i64).abs();
    if diff_col < diff_page {
        eprintln!("→ seg_w가 단 너비에 가까움 (차이: {}hu)", diff_col);
    } else {
        eprintln!("→ seg_w가 페이지 너비에 가까움 (차이: {}hu)", diff_page);
    }

    // 2단 영역 편집 시뮬레이션: para[14] (col_idx=1, 2단 영역)
    eprintln!("\n=== 2단 영역 편집: insert_text_native(0, 14, 0, \"Y\") ===");
    let col_idx_14_before = doc
        .para_column_map
        .first()
        .and_then(|m| m.get(14))
        .copied()
        .unwrap_or(0);
    eprintln!("편집 전 para[14] col_idx: {}", col_idx_14_before);

    let result2 = doc.insert_text_native(0, 14, 0, "Y");
    eprintln!("insert_text 결과: {:?}", result2);

    let para14 = &doc.document.sections[0].paragraphs[14];
    eprintln!("편집 후 para[14] line_segs:");
    for (i, ls) in para14.line_segs.iter().enumerate() {
        eprintln!(
            "  line[{}]: seg_w={} text_start={}",
            i, ls.segment_width, ls.text_start
        );
    }

    // find_column_def_for_paragraph 결과 확인
    let cd_for_14 =
        HwpDocument::find_column_def_for_paragraph(&doc.document.sections[0].paragraphs, 14);
    eprintln!(
        "para[14]에 적용되는 ColumnDef: count={}, same_width={}, widths={:?}",
        cd_for_14.column_count, cd_for_14.same_width, cd_for_14.widths
    );

    let layout14 = crate::renderer::page_layout::PageLayoutInfo::from_page_def(
        &doc.document.sections[0].section_def.page_def,
        &cd_for_14,
        doc.dpi,
    );
    eprintln!("layout14 column_areas:");
    for (i, ca) in layout14.column_areas.iter().enumerate() {
        let w_hu = crate::renderer::px_to_hwpunit(ca.width, doc.dpi);
        eprintln!(
            "  [{}]: x={:.1}px w={:.1}px ({}hu)",
            i, ca.x, ca.width, w_hu
        );
    }

    let seg_w_14 = para14
        .line_segs
        .first()
        .map(|ls| ls.segment_width)
        .unwrap_or(0);
    let orig_seg_w_14 = 22960i32; // 편집 전 원본 seg_w
    eprintln!("\n=== para[14] 결과 비교 ===");
    eprintln!("원본 seg_w: {}hu", orig_seg_w_14);
    eprintln!("편집 후 seg_w: {}hu", seg_w_14);
    eprintln!("페이지 전체 너비: {}hu", page_w_hu);
    if (seg_w_14 - orig_seg_w_14).abs() < 1000 {
        eprintln!("→ 올바름: 2단 너비로 리플로우됨");
    } else if (seg_w_14 as i64 - page_w_hu as i64).abs() < 1000 {
        eprintln!("→ 오류: 1단 전체 너비로 리플로우됨!");
    } else {
        eprintln!("→ 알수없는 너비: {}hu", seg_w_14);
    }

    // === 양쪽 정렬 진단: 원본 2단 문단의 LineSeg 데이터 ===
    eprintln!("\n=== 양쪽 정렬 진단: 2단 문단 LineSeg 분석 ===");
    // 원본 데이터 재로드 (편집 전)
    let data2 = std::fs::read(path).unwrap();
    let doc2 = HwpDocument::from_bytes(&data2).unwrap();
    let section2 = &doc2.document.sections[0];

    // 2단 영역의 모든 문단의 LineSeg column_start, segment_width 출력
    for pi in 9..std::cmp::min(20, section2.paragraphs.len()) {
        let para = &section2.paragraphs[pi];
        let text_preview: String = para.text.chars().take(40).collect();
        eprintln!("\npara[{}]: text={:?}", pi, text_preview);
        eprintln!("  line_segs 수: {}", para.line_segs.len());
        for (li, ls) in para.line_segs.iter().enumerate() {
            eprintln!(
                "  line[{}]: seg_w={} col_start={} text_start={} vpos={} line_h={} line_sp={}",
                li,
                ls.segment_width,
                ls.column_start,
                ls.text_start,
                ls.vertical_pos,
                ls.line_height,
                ls.line_spacing
            );
        }
        // 문단 정렬 확인
        let ps = doc2.styles.para_styles.get(para.para_shape_id as usize);
        if let Some(ps) = ps {
            eprintln!("  alignment: {:?}", ps.alignment);
        }
    }

    // 페이지네이션 결과 확인: 2단 문단이 어떤 단에 배치되는지
    eprintln!("\n=== 페이지네이션 결과 분석 ===");
    let paginator = crate::renderer::pagination::Paginator::new(doc2.dpi);
    let composed2: Vec<_> = section2
        .paragraphs
        .iter()
        .map(|p| crate::renderer::composer::compose_paragraph(p))
        .collect();
    // 2단 ColumnDef 찾기 (para[9]+ 영역)
    let cd_for_9 = HwpDocument::find_column_def_for_paragraph(&section2.paragraphs, 9);
    eprintln!("para[9]+ ColumnDef: count={}", cd_for_9.column_count);

    // 페이지네이션 실행 (전체 섹션)
    let (pag_result, measured_sec) = paginator.paginate(
        &section2.paragraphs,
        &composed2,
        &doc2.styles,
        &section2.section_def.page_def,
        &crate::model::page::ColumnDef::default(), // 초기 ColumnDef
        0,
    );

    // 측정 높이 진단
    eprintln!("\n=== 문단별 측정 높이 (para 0~20) ===");
    let mut zone1_sum: f64 = 0.0;
    for pi in 0..std::cmp::min(20, section2.paragraphs.len()) {
        let h = measured_sec.get_paragraph_height(pi).unwrap_or(0.0);
        let mp = measured_sec.get_measured_paragraph(pi);
        let sp_b = mp.map(|m| m.spacing_before).unwrap_or(0.0);
        let sp_a = mp.map(|m| m.spacing_after).unwrap_or(0.0);
        let lh_sum: f64 = mp.map(|m| m.line_heights.iter().sum()).unwrap_or(0.0);
        let line_ct = mp.map(|m| m.line_heights.len()).unwrap_or(0);
        eprintln!(
            "  para[{}] h={:.2}px (sp_b={:.2} + lines({})={:.2} + sp_a={:.2})",
            pi, h, sp_b, line_ct, lh_sum, sp_a
        );
        if pi < 9 {
            zone1_sum += h;
        }
    }
    eprintln!("  zone1(para 0-8) sum={:.2}px", zone1_sum);
    let layout1 = crate::renderer::page_layout::PageLayoutInfo::from_page_def(
        &section2.section_def.page_def,
        &crate::model::page::ColumnDef::default(),
        doc2.dpi,
    );
    eprintln!(
        "body_area.height={:.1}px, available_body_height={:.1}px",
        layout1.body_area.height,
        layout1.available_body_height()
    );

    for (pg_idx, page) in pag_result.pages.iter().enumerate() {
        eprintln!(
            "\n페이지 {} (단 수: {}):",
            pg_idx,
            page.column_contents.len()
        );
        for col_content in &page.column_contents {
            eprintln!(
                "  단 {} (zone_y_offset={:.1}):",
                col_content.column_index, col_content.zone_y_offset
            );
            for item in &col_content.items {
                match item {
                    crate::renderer::pagination::PageItem::FullParagraph { para_index } => {
                        eprintln!("    FullParagraph(para={})", para_index);
                    }
                    crate::renderer::pagination::PageItem::PartialParagraph {
                        para_index,
                        start_line,
                        end_line,
                    } => {
                        eprintln!(
                            "    PartialParagraph(para={}, lines={}..{})",
                            para_index, start_line, end_line
                        );
                    }
                    crate::renderer::pagination::PageItem::Table {
                        para_index,
                        control_index,
                    } => {
                        eprintln!("    Table(para={}, ctrl={})", para_index, control_index);
                    }
                    _ => {
                        eprintln!("    기타 항목");
                    }
                }
            }
        }
    }

    // 검증: 페이지 0에 1단 + 2단 존이 공존해야 함 (다단 설정 나누기)
    let page0 = &pag_result.pages[0];
    let has_zone_offset = page0
        .column_contents
        .iter()
        .any(|cc| cc.zone_y_offset > 0.0);
    assert!(
        has_zone_offset,
        "페이지 0에 zone_y_offset > 0인 ColumnContent가 있어야 함 (1단+2단 공존)"
    );
    let has_multi_col = page0.column_contents.iter().any(|cc| cc.column_index > 0);
    assert!(
        has_multi_col,
        "페이지 0에 column_index > 0인 ColumnContent가 있어야 함 (2단 렌더링)"
    );

    // === 페이지 1 높이 오버플로 진단 ===
    if pag_result.pages.len() > 1 {
        let page1 = &pag_result.pages[1];
        let avail = page1.layout.available_body_height();
        eprintln!("\n=== 페이지 1 높이 오버플로 진단 ===");
        eprintln!("available_body_height={:.2}px", avail);
        eprintln!(
            "body_area: y={:.2}, h={:.2}, bottom={:.2}",
            page1.layout.body_area.y,
            page1.layout.body_area.height,
            page1.layout.body_area.y + page1.layout.body_area.height
        );

        for col_content in &page1.column_contents {
            eprintln!(
                "\n  단 {} (zone_y_offset={:.1}):",
                col_content.column_index, col_content.zone_y_offset
            );
            let mut cumulative: f64 = 0.0;
            for item in &col_content.items {
                match item {
                    crate::renderer::pagination::PageItem::FullParagraph { para_index } => {
                        let h = measured_sec
                            .get_paragraph_height(*para_index)
                            .unwrap_or(0.0);
                        cumulative += h;
                        let mp = measured_sec.get_measured_paragraph(*para_index);
                        let sp_b = mp.map(|m| m.spacing_before).unwrap_or(0.0);
                        let sp_a = mp.map(|m| m.spacing_after).unwrap_or(0.0);
                        let lh_sum: f64 = mp.map(|m| m.line_heights.iter().sum()).unwrap_or(0.0);
                        let line_ct = mp.map(|m| m.line_heights.len()).unwrap_or(0);
                        eprintln!("    FullParagraph(para={}) h={:.2}px (sp_b={:.2} + lines({})={:.2} + sp_a={:.2}) cum={:.2}",
                                para_index, h, sp_b, line_ct, lh_sum, sp_a, cumulative);
                    }
                    crate::renderer::pagination::PageItem::PartialParagraph {
                        para_index,
                        start_line,
                        end_line,
                    } => {
                        let mp = measured_sec.get_measured_paragraph(*para_index);
                        let (part_h, sp_b, sp_a, lh_sum) = if let Some(mp) = mp {
                            let sp_b = if *start_line == 0 {
                                mp.spacing_before
                            } else {
                                0.0
                            };
                            let sp_a = if *end_line >= mp.line_heights.len() {
                                mp.spacing_after
                            } else {
                                0.0
                            };
                            let safe_s = (*start_line).min(mp.line_heights.len());
                            let safe_e = (*end_line).min(mp.line_heights.len());
                            let lh: f64 = mp.line_heights[safe_s..safe_e].iter().sum();
                            (sp_b + lh + sp_a, sp_b, sp_a, lh)
                        } else {
                            (0.0, 0.0, 0.0, 0.0)
                        };
                        cumulative += part_h;
                        eprintln!("    PartialParagraph(para={}, lines={}..{}) h={:.2}px (sp_b={:.2} + lines={:.2} + sp_a={:.2}) cum={:.2}",
                                para_index, start_line, end_line, part_h, sp_b, lh_sum, sp_a, cumulative);
                    }
                    crate::renderer::pagination::PageItem::Table {
                        para_index,
                        control_index,
                    } => {
                        let h = measured_sec
                            .get_paragraph_height(*para_index)
                            .unwrap_or(0.0);
                        cumulative += h;
                        eprintln!(
                            "    Table(para={}, ctrl={}) h={:.2}px cum={:.2}",
                            para_index, control_index, h, cumulative
                        );
                    }
                    _ => {
                        eprintln!("    기타 항목");
                    }
                }
            }
            let overflow = cumulative - avail;
            if overflow > 0.0 {
                eprintln!(
                    "  *** 오버플로: {:.2}px (누적 {:.2} > 가용 {:.2})",
                    overflow, cumulative, avail
                );
            } else {
                eprintln!(
                    "  여유: {:.2}px (누적 {:.2} <= 가용 {:.2})",
                    -overflow, cumulative, avail
                );
            }
        }
    }
}

/// 빈 문단에서 반복 Enter + getCursorRect 동작 검증
#[test]
fn test_repeated_enter_on_empty_paragraph() {
    let bytes = std::fs::read("saved/blank2010.hwp").expect("blank2010.hwp 읽기 실패");
    let mut doc = HwpDocument::from_bytes(&bytes).unwrap();
    doc.convert_to_editable_native().unwrap();
    doc.paginate();

    // 1. 텍스트 입력
    let result = doc.insert_text_native(0, 0, 0, "테스트").unwrap();
    println!("Insert: {}", result);

    // 2. 첫 번째 Enter (텍스트 끝에서)
    let result1 = doc.split_paragraph_native(0, 0, 3, None).unwrap();
    println!("Split 1 (para=0, offset=3): {}", result1);
    assert!(result1.contains("\"ok\":true"));
    assert_eq!(doc.document.sections[0].paragraphs.len(), 2);

    // getCursorRect para 1, offset 0
    let rect1 = doc.get_cursor_rect_native(0, 1, 0);
    println!("CursorRect(0,1,0): {:?}", rect1);
    assert!(
        rect1.is_ok(),
        "빈 문단(para=1) 커서 실패: {:?}",
        rect1.err()
    );

    // 3. 두 번째 Enter (빈 문단에서)
    let result2 = doc.split_paragraph_native(0, 1, 0, None).unwrap();
    println!("Split 2 (para=1, offset=0): {}", result2);
    assert!(result2.contains("\"ok\":true"));
    assert!(result2.contains("\"paraIdx\":2"));
    assert_eq!(doc.document.sections[0].paragraphs.len(), 3);

    let rect2 = doc.get_cursor_rect_native(0, 2, 0);
    println!("CursorRect(0,2,0): {:?}", rect2);
    assert!(
        rect2.is_ok(),
        "빈 문단(para=2) 커서 실패: {:?}",
        rect2.err()
    );

    // 4. 세 번째 Enter
    let result3 = doc.split_paragraph_native(0, 2, 0, None).unwrap();
    println!("Split 3 (para=2, offset=0): {}", result3);
    assert!(result3.contains("\"ok\":true"));

    let rect3 = doc.get_cursor_rect_native(0, 3, 0);
    println!("CursorRect(0,3,0): {:?}", rect3);
    assert!(
        rect3.is_ok(),
        "빈 문단(para=3) 커서 실패: {:?}",
        rect3.err()
    );

    // y좌표 순증 검증
    let parse_y = |json: &str| -> f64 {
        let y_start = json.find("\"y\":").unwrap() + 4;
        let y_end = json[y_start..]
            .find(|c: char| c == ',' || c == '}')
            .unwrap();
        json[y_start..y_start + y_end].parse::<f64>().unwrap()
    };
    let y1 = parse_y(&rect1.unwrap());
    let y2 = parse_y(&rect2.unwrap());
    let y3 = parse_y(&rect3.unwrap());
    println!("y좌표: y1={:.1}, y2={:.1}, y3={:.1}", y1, y2, y3);
    assert!(y2 > y1, "para2 y({:.1}) > para1 y({:.1})", y2, y1);
    assert!(y3 > y2, "para3 y({:.1}) > para2 y({:.1})", y3, y2);
}

/// 강제 줄바꿈(\n) 삽입 후 getCursorRect가 두 번째 줄 좌표를 반환하는지 검증
#[test]
fn test_cursor_rect_after_line_break() {
    let bytes = std::fs::read("saved/blank2010.hwp").expect("blank2010.hwp 읽기 실패");
    let mut doc = HwpDocument::from_bytes(&bytes).unwrap();
    doc.convert_to_editable_native().unwrap();
    doc.paginate();

    // "가나다라마바" 입력
    doc.insert_text_native(0, 0, 0, "가나다라마바").unwrap();

    // offset 3에 \n 삽입 → "가나다\n라마바"
    doc.insert_text_native(0, 0, 3, "\n").unwrap();

    // offset 3 → \n 이전 (첫 줄)
    let rect_before = doc.get_cursor_rect_native(0, 0, 3);
    assert!(
        rect_before.is_ok(),
        "offset 3 커서 실패: {:?}",
        rect_before.err()
    );

    // offset 4 → \n 이후 (두 번째 줄)
    let rect_after = doc.get_cursor_rect_native(0, 0, 4);
    assert!(
        rect_after.is_ok(),
        "offset 4 커서 실패: {:?}",
        rect_after.err()
    );

    let parse_y = |json: &str| -> f64 {
        let y_start = json.find("\"y\":").unwrap() + 4;
        let y_end = json[y_start..]
            .find(|c: char| c == ',' || c == '}')
            .unwrap();
        json[y_start..y_start + y_end].parse::<f64>().unwrap()
    };
    let y_before = parse_y(&rect_before.unwrap());
    let y_after = parse_y(&rect_after.unwrap());
    assert!(
        y_after > y_before,
        "줄바꿈 후 커서 y({:.1})가 줄바꿈 전 y({:.1})보다 커야 함",
        y_after,
        y_before
    );
}

/// 텍스트 끝에 \n 삽입 후 빈 두 번째 줄에서 getCursorRect 검증
#[test]
fn test_cursor_rect_after_line_break_at_end() {
    let bytes = std::fs::read("saved/blank2010.hwp").expect("blank2010.hwp 읽기 실패");
    let mut doc = HwpDocument::from_bytes(&bytes).unwrap();
    doc.convert_to_editable_native().unwrap();
    doc.paginate();

    // "가나다라" 입력 후 끝에 \n 삽입 → "가나다라\n"
    doc.insert_text_native(0, 0, 0, "가나다라").unwrap();
    doc.insert_text_native(0, 0, 4, "\n").unwrap();

    let para = &doc.document.sections[0].paragraphs[0];
    assert!(para.line_segs.len() >= 2, "line_segs가 2개 이상이어야 함");

    // composed lines 순서 검증: 첫 줄=텍스트, 둘째 줄=빈 줄
    let comp = &doc.composed[0][0];
    assert_eq!(comp.lines.len(), 2);
    assert!(
        comp.lines[0].has_line_break,
        "첫 줄에 line_break 플래그 있어야 함"
    );
    assert_eq!(comp.lines[1].runs.len(), 0, "둘째 줄은 빈 줄이어야 함");

    // offset 4 → \n 위치 (첫 줄 끝)
    let rect_at_newline = doc.get_cursor_rect_native(0, 0, 4);
    assert!(rect_at_newline.is_ok());

    // offset 5 → \n 직후, 빈 두 번째 줄
    let rect_after = doc.get_cursor_rect_native(0, 0, 5);
    assert!(
        rect_after.is_ok(),
        "빈 줄 offset 5 커서 실패: {:?}",
        rect_after.err()
    );

    let parse_y = |json: &str| -> f64 {
        let y_start = json.find("\"y\":").unwrap() + 4;
        let y_end = json[y_start..]
            .find(|c: char| c == ',' || c == '}')
            .unwrap();
        json[y_start..y_start + y_end].parse::<f64>().unwrap()
    };
    let y_newline = parse_y(&rect_at_newline.unwrap());
    let y_after = parse_y(&rect_after.unwrap());
    assert!(
        y_after > y_newline,
        "빈 줄 커서 y({:.1})가 첫 줄 y({:.1})보다 커야 함",
        y_after,
        y_newline
    );
}

// ── Event Sourcing + Batch Mode 테스트 ──

/// 편집 가능한 빈 문서 생성 헬퍼 (blank 템플릿 기반)
fn create_editable_doc() -> HwpDocument {
    let mut doc = HwpDocument::create_empty();
    doc.create_blank_document_native().unwrap();
    doc
}

#[test]
fn test_single_command_updates_document_and_retains_a_bounded_public_event_payload() {
    let mut doc = create_editable_doc();
    assert!(doc.event_log.is_empty());

    let result = doc.insert_text_native(0, 0, 0, "Hello");
    assert!(result.is_ok(), "insert_text_native failed: {:?}", result);
    assert_eq!(doc.event_log.len(), 1);
    assert!(doc.get_event_log().contains("\"type\":\"TextInserted\""));
    assert_eq!(doc.get_text_range_native(0, 0, 0, 5).unwrap(), "Hello");
}

#[test]
fn test_batch_mode_events_collected() {
    let mut doc = create_editable_doc();

    let r = doc.begin_batch_native();
    assert!(r.is_ok());
    assert!(doc.batch_mode);
    assert!(doc.event_log.is_empty());

    // Batch 중 여러 편집
    let r1 = doc.insert_text_native(0, 0, 0, "Hello");
    assert!(r1.is_ok(), "1st insert failed: {:?}", r1);
    let r2 = doc.insert_text_native(0, 0, 5, " World");
    assert!(r2.is_ok(), "2nd insert failed: {:?}", r2);

    assert_eq!(doc.event_log.len(), 2);
    assert!(doc.event_log[0]
        .to_json()
        .contains("\"type\":\"TextInserted\""));
    assert!(doc.event_log[1]
        .to_json()
        .contains("\"type\":\"TextInserted\""));
}

#[test]
fn test_end_batch_returns_events_and_clears() {
    let mut doc = create_editable_doc();

    let _ = doc.begin_batch_native();
    let r = doc.insert_text_native(0, 0, 0, "Test");
    assert!(r.is_ok(), "insert failed: {:?}", r);
    assert_eq!(doc.event_log.len(), 1);

    let result = doc.end_batch_native();
    assert!(result.is_ok());
    let json = result.unwrap();
    assert!(json.contains("\"ok\":true"));
    assert!(json.contains("\"events\":["));
    assert!(json.contains("\"type\":\"TextInserted\""));

    // end_batch 후 event_log 비워짐 + batch_mode 해제
    assert!(!doc.batch_mode);
    assert!(doc.event_log.is_empty());
}

#[test]
fn test_batch_multiple_edit_types() {
    let mut doc = create_editable_doc();

    let _ = doc.begin_batch_native();
    let r1 = doc.insert_text_native(0, 0, 0, "Hello World");
    assert!(r1.is_ok(), "insert failed: {:?}", r1);
    let r2 = doc.delete_text_native(0, 0, 5, 6);
    assert!(r2.is_ok(), "delete failed: {:?}", r2);

    assert_eq!(doc.event_log.len(), 2);
    assert!(doc.event_log[0]
        .to_json()
        .contains("\"type\":\"TextInserted\""));
    assert!(doc.event_log[1]
        .to_json()
        .contains("\"type\":\"TextDeleted\""));

    let result = doc.end_batch_native();
    assert!(result.is_ok());
    // 종료 후 paginate 실행되므로 페이지 수 유효
    assert!(doc.page_count() >= 1);
}

#[test]
fn test_serialize_event_log_format() {
    let mut doc = create_editable_doc();
    doc.begin_batch_native().unwrap();
    let r = doc.insert_text_native(0, 0, 0, "A");
    assert!(r.is_ok(), "insert failed: {:?}", r);

    let json = doc.serialize_event_log();
    assert!(json.starts_with("{\"ok\":true,\"events\":["));
    assert!(json.ends_with("]}"));
    assert!(json.contains("\"type\":\"TextInserted\""));
}

#[test]
fn test_find_next_editable_control_bookreview() {
    let data = std::fs::read("samples/basic/BookReview.hwp").expect("BookReview.hwp not found");
    let doc = HwpDocument::from_bytes(&data).unwrap();

    // Section 1, Para 0: controls 0-8 중 textbox는 ci=3,4,5,6,7,8
    // ci=3에서 앞으로 → ci=4 (textbox)
    let r = doc.find_next_editable_control_native(1, 0, 3, 1);
    println!("sec1 para0 ci=3 → next: {}", r);
    assert!(r.contains("\"type\":\"textbox\""));
    assert!(r.contains("\"ci\":4"));

    // ci=8에서 앞으로 → 같은 문단에 더 이상 없음 → 다음 문단/섹션
    let r = doc.find_next_editable_control_native(1, 0, 8, 1);
    println!("sec1 para0 ci=8 → next: {}", r);
    // section 1에 paragraph가 1개뿐이므로 다음 섹션도 없음 → none
    assert!(r.contains("\"type\":\"none\""));

    // ci=3에서 뒤로 → 같은 문단에 ci=3 이전 textbox 없음 → 이전 섹션
    let r = doc.find_next_editable_control_native(1, 0, 3, -1);
    println!("sec1 para0 ci=3 → prev: {}", r);
    // section 0의 마지막에서 편집 가능한 위치
    assert!(r.contains("\"sec\":0"));

    // Section 0에서 앞으로: section 0의 마지막 문단에서 section 1로 이동
    let sec0_paras = doc.core.document.sections[0].paragraphs.len();
    let r = doc.find_next_editable_control_native(0, sec0_paras - 1, -1, 1);
    println!("sec0 last_para body → next: {}", r);

    // ci=5에서 앞으로 → ci=6
    let r = doc.find_next_editable_control_native(1, 0, 5, 1);
    println!("sec1 para0 ci=5 → next: {}", r);
    assert!(r.contains("\"ci\":6"));

    // ci=6에서 앞으로 → ci=7
    let r = doc.find_next_editable_control_native(1, 0, 6, 1);
    println!("sec1 para0 ci=6 → next: {}", r);
    assert!(r.contains("\"ci\":7"));

    // ci=7에서 앞으로 → ci=8
    let r = doc.find_next_editable_control_native(1, 0, 7, 1);
    println!("sec1 para0 ci=7 → next: {}", r);
    assert!(r.contains("\"ci\":8"));

    // ci=8에서 뒤로 → ci=7
    let r = doc.find_next_editable_control_native(1, 0, 8, -1);
    println!("sec1 para0 ci=8 → prev: {}", r);
    assert!(r.contains("\"ci\":7"));
}

#[test]
fn test_superscript_in_new_document() {
    // 새 문서 생성 → 텍스트 입력 → 숫자 삽입 → 위첨자 적용 → 이후 글자 정상 확인
    let mut doc = HwpDocument::create_empty();
    doc.create_blank_document_native().unwrap();

    // 1. "가나다라마바사" 입력 (실제로는 한 번에 삽입)
    let _ = doc.insert_text_native(0, 0, 0, "가나다라마바사");

    let para = &doc.document.sections[0].paragraphs[0];
    eprintln!(
        "Step1: text='{}' char_offsets={:?} char_shapes={:?}",
        para.text,
        para.char_offsets,
        para.char_shapes
            .iter()
            .map(|cs| (cs.start_pos, cs.char_shape_id))
            .collect::<Vec<_>>(),
    );

    // 2. 위치 2에 "123" 삽입 → "가나123다라마바사"
    let _ = doc.insert_text_native(0, 0, 2, "123");

    let para = &doc.document.sections[0].paragraphs[0];
    eprintln!(
        "Step2: text='{}' char_offsets={:?} char_shapes={:?}",
        para.text,
        para.char_offsets,
        para.char_shapes
            .iter()
            .map(|cs| (cs.start_pos, cs.char_shape_id))
            .collect::<Vec<_>>(),
    );

    // 3. "123" (chars 2-5)에 위첨자 적용
    let result = doc.apply_char_format_native(0, 0, 2, 5, r#"{"superscript":true}"#);
    assert!(result.is_ok(), "위첨자 적용 실패: {:?}", result.err());

    let para = &doc.document.sections[0].paragraphs[0];
    eprintln!(
        "Step3: text='{}' char_offsets={:?} char_shapes={:?}",
        para.text,
        para.char_offsets,
        para.char_shapes
            .iter()
            .map(|cs| (cs.start_pos, cs.char_shape_id))
            .collect::<Vec<_>>(),
    );

    // 검증: char_shapes가 3개여야 함 (원본, 위첨자, 원본)
    assert!(
        para.char_shapes.len() >= 3,
        "char_shapes should have at least 3 segments, got {}: {:?}",
        para.char_shapes.len(),
        para.char_shapes
            .iter()
            .map(|cs| (cs.start_pos, cs.char_shape_id))
            .collect::<Vec<_>>(),
    );

    // 위첨자가 적용된 CharShape와 원본 CharShape가 다른 ID인지 확인
    let original_id = para.char_shapes[0].char_shape_id;
    let superscript_id = para.char_shapes[1].char_shape_id;
    assert_ne!(
        original_id, superscript_id,
        "위첨자 CharShape ID는 원본과 달라야 함"
    );

    // 마지막 세그먼트는 원본 ID로 복원되어야 함
    let last_id = para.char_shapes.last().unwrap().char_shape_id;
    assert_eq!(last_id, original_id, "위첨자 이후 원본 ID로 복원되어야 함");

    // 위첨자 CharShape의 superscript 필드 확인
    let sup_cs = &doc.document.doc_info.char_shapes[superscript_id as usize];
    assert!(
        sup_cs.superscript,
        "위첨자 CharShape의 superscript가 true여야 함"
    );

    // 원본 CharShape의 superscript 필드 확인
    let orig_cs = &doc.document.doc_info.char_shapes[original_id as usize];
    assert!(
        !orig_cs.superscript,
        "원본 CharShape의 superscript가 false여야 함"
    );
}

/// Task 227: 빈 문서에서 텍스트 입력 → 전체선택 → 복사 → End → 붙여넣기 시
/// 새 페이지 생성 버그 재현 및 원인 분석
#[test]
fn test_task227_blank_doc_copy_paste_bug() {
    let mut doc = HwpDocument::create_empty();
    let result = doc.create_blank_document_native();
    assert!(result.is_ok(), "빈 문서 생성 실패");

    // 1. 빈 문서의 문단 수 확인
    let para_count = doc.document.sections[0].paragraphs.len();
    eprintln!("[Task227] 빈 문서 문단 수: {}", para_count);
    for (i, p) in doc.document.sections[0].paragraphs.iter().enumerate() {
        eprintln!(
            "  문단[{}]: text={:?}, chars={}, controls={}, has_para_text={}",
            i,
            p.text,
            p.text.chars().count(),
            p.controls.len(),
            p.has_para_text
        );
    }

    // 2. 텍스트 삽입
    let result = doc.insert_text_native(0, 0, 0, "abcdefg");
    assert!(result.is_ok(), "텍스트 삽입 실패");

    let para_count_after_insert = doc.document.sections[0].paragraphs.len();
    eprintln!(
        "[Task227] 텍스트 삽입 후 문단 수: {}",
        para_count_after_insert
    );
    for (i, p) in doc.document.sections[0].paragraphs.iter().enumerate() {
        eprintln!(
            "  문단[{}]: text={:?}, chars={}, controls={}, has_para_text={}",
            i,
            p.text,
            p.text.chars().count(),
            p.controls.len(),
            p.has_para_text
        );
    }

    // 3. 전체 선택 시뮬레이션: start=(0,0,0), end=(last_para, last_char)
    let last_para = para_count_after_insert - 1;
    let last_char = doc.document.sections[0].paragraphs[last_para]
        .text
        .chars()
        .count();
    eprintln!(
        "[Task227] 전체 선택: start=(0,0), end=({},{})",
        last_para, last_char
    );

    // 4. 복사
    let result = doc.copy_selection_native(0, 0, 0, last_para, last_char);
    assert!(result.is_ok(), "복사 실패: {:?}", result.err());
    let clip_text = doc.get_clipboard_text_native();
    eprintln!("[Task227] 클립보드 텍스트: {:?}", clip_text);

    // 클립보드 문단 수 확인
    if let Some(ref clip) = doc.clipboard {
        eprintln!("[Task227] 클립보드 문단 수: {}", clip.paragraphs.len());
        for (i, p) in clip.paragraphs.iter().enumerate() {
            eprintln!(
                "  클립[{}]: text={:?}, chars={}, controls={}",
                i,
                p.text,
                p.text.chars().count(),
                p.controls.len()
            );
        }
    }

    // 5. End 키 시뮬레이션: 커서를 문단 0의 텍스트 끝으로 이동
    //    (원래 커서는 문단 0, offset 7 = "abcdefg" 끝)
    let paste_offset = doc.document.sections[0].paragraphs[0].text.chars().count();
    eprintln!("[Task227] 붙여넣기 위치: para=0, offset={}", paste_offset);

    // 6. 붙여넣기
    let result = doc.paste_internal_native(0, 0, paste_offset);
    assert!(result.is_ok(), "붙여넣기 실패: {:?}", result.err());
    let json = result.unwrap();
    eprintln!("[Task227] 붙여넣기 결과: {}", json);

    // 7. 결과 확인
    let final_para_count = doc.document.sections[0].paragraphs.len();
    eprintln!("[Task227] 붙여넣기 후 문단 수: {}", final_para_count);
    for (i, p) in doc.document.sections[0].paragraphs.iter().enumerate() {
        eprintln!(
            "  문단[{}]: text={:?}, chars={}",
            i,
            p.text,
            p.text.chars().count()
        );
    }

    let page_count = doc.page_count();
    eprintln!("[Task227] 붙여넣기 후 페이지 수: {}", page_count);

    // 기대: 1개 문단, 1 페이지
    assert_eq!(
        final_para_count, 1,
        "문단 수가 1이어야 함 (실제: {})",
        final_para_count
    );
    assert_eq!(
        page_count, 1,
        "페이지 수가 1이어야 함 (실제: {})",
        page_count
    );
}

/// Task 228: 형광펜 렌더링 - 페이지 트리에 Rectangle 노드 확인
#[test]
fn test_task228_highlight_render_tree() {
    let data = std::fs::read("samples/h-pen-01.hwp").expect("파일 읽기 실패");
    let mut doc = crate::DocumentCore::from_bytes(&data).expect("파싱 실패");
    let svg = doc.render_page_svg_native(0).expect("SVG 렌더링 실패");
    // 형광펜 사각형 색상이 SVG에 포함되어야 함
    assert!(
        svg.contains("#ad71a1"),
        "2번째 문단 형광펜 색상(#ad71a1)이 SVG에 없음"
    );
    assert!(
        svg.contains("#ffff65"),
        "3번째 문단 형광펜 색상(#ffff65)이 SVG에 없음"
    );
    eprintln!("[Task228 RenderTree] SVG에 형광펜 색상 확인됨");
}

/// Task 229: field-01.hwp 필드 컨트롤 파싱 분석
#[test]
fn test_task229_field_parsing() {
    use crate::model::control::{Control, FieldType};

    let data = std::fs::read("samples/field-01.hwp").expect("파일 읽기 실패");
    let doc = crate::parser::parse_hwp(&data).expect("파싱 실패");

    let mut field_count = 0;
    let mut unknown_count = 0;

    for (si, section) in doc.sections.iter().enumerate() {
        for (pi, para) in section.paragraphs.iter().enumerate() {
            for (ci, ctrl) in para.controls.iter().enumerate() {
                match ctrl {
                    Control::Field(f) => {
                        field_count += 1;
                        eprintln!(
                                "[Task229] 구역[{}] 문단[{}] 컨트롤[{}]: Field type={:?}, command=\"{}\", id={}, props=0x{:08X}",
                                si, pi, ci, f.field_type, f.command, f.field_id, f.properties
                            );
                    }
                    Control::Unknown(u) => {
                        let id_bytes = u.ctrl_id.to_be_bytes();
                        if id_bytes[0] == b'%' {
                            unknown_count += 1;
                            eprintln!(
                                    "[Task229] 구역[{}] 문단[{}] 컨트롤[{}]: Unknown 필드 ctrl_id=0x{:08X} ({})",
                                    si, pi, ci, u.ctrl_id,
                                    String::from_utf8_lossy(&id_bytes)
                                );
                        }
                    }
                    _ => {}
                }
            }
        }
    }

    eprintln!(
        "[Task229] 총 필드: {}, Unknown 필드: {}",
        field_count, unknown_count
    );
    assert!(field_count > 0, "필드 컨트롤이 파싱되어야 함");
    assert_eq!(
        unknown_count, 0,
        "모든 필드가 파싱되어야 함 (Unknown 없어야 함)"
    );

    // 필드 범위 추적 검증
    let mut total_field_ranges = 0;
    for (si, section) in doc.sections.iter().enumerate() {
        for (pi, para) in section.paragraphs.iter().enumerate() {
            if !para.field_ranges.is_empty() {
                eprintln!(
                    "[Task229] 구역[{}] 문단[{}] text=\"{}\" (len={})",
                    si,
                    pi,
                    para.text,
                    para.text.chars().count()
                );
            }
            for fr in &para.field_ranges {
                total_field_ranges += 1;
                let field_text: String = para
                    .text
                    .chars()
                    .skip(fr.start_char_idx)
                    .take(fr.end_char_idx - fr.start_char_idx)
                    .collect();
                let field_type = match &para.controls[fr.control_idx] {
                    Control::Field(f) => format!("{:?}", f.field_type),
                    _ => "N/A".to_string(),
                };
                eprintln!(
                        "[Task229] 구역[{}] 문단[{}] field_range: chars[{}..{}] ctrl[{}] type={} text=\"{}\"",
                        si, pi, fr.start_char_idx, fr.end_char_idx, fr.control_idx, field_type, field_text
                    );
            }
        }
    }
    eprintln!("[Task229] 총 필드 범위: {}", total_field_ranges);
    assert_eq!(
        total_field_ranges, field_count,
        "필드 수와 필드 범위 수가 일치해야 함"
    );
}

#[test]
fn test_task229_field_roundtrip() {
    use crate::model::control::{Control, FieldType};

    // 원본 파싱
    let data = std::fs::read("samples/field-01.hwp").expect("파일 읽기 실패");
    let doc1 = crate::parser::parse_hwp(&data).expect("파싱 실패");

    // 직렬화 → 재파싱
    let saved = crate::serializer::serialize_hwp(&doc1).expect("직렬화 실패");
    let doc2 = crate::parser::parse_hwp(&saved).expect("재파싱 실패");

    // 필드 컨트롤 비교
    let fields1: Vec<_> = doc1
        .sections
        .iter()
        .flat_map(|s| &s.paragraphs)
        .flat_map(|p| p.controls.iter())
        .filter_map(|c| {
            if let Control::Field(f) = c {
                Some(f)
            } else {
                None
            }
        })
        .collect();
    let fields2: Vec<_> = doc2
        .sections
        .iter()
        .flat_map(|s| &s.paragraphs)
        .flat_map(|p| p.controls.iter())
        .filter_map(|c| {
            if let Control::Field(f) = c {
                Some(f)
            } else {
                None
            }
        })
        .collect();

    assert_eq!(fields1.len(), fields2.len(), "필드 수 불일치");
    for (i, (f1, f2)) in fields1.iter().zip(fields2.iter()).enumerate() {
        assert_eq!(f1.field_type, f2.field_type, "필드[{}] 타입 불일치", i);
        assert_eq!(f1.ctrl_id, f2.ctrl_id, "필드[{}] ctrl_id 불일치", i);
    }
}

#[test]
fn test_task229_field_svg_guide_text() {
    use crate::model::control::Control;

    let data = std::fs::read("samples/field-01.hwp").expect("파일 읽기 실패");
    let doc = crate::parser::parse_hwp(&data).expect("파싱 실패");

    // 글상자(Shape) 내 ClickHere 필드 검증
    let mut shape_field_count = 0usize;
    for sec in &doc.sections {
        for para in &sec.paragraphs {
            for ctrl in &para.controls {
                if let Control::Shape(s) = ctrl {
                    if let Some(drawing) = s.drawing() {
                        if let Some(tb) = &drawing.text_box {
                            for tb_para in &tb.paragraphs {
                                shape_field_count += tb_para.field_ranges.len();
                            }
                        }
                    }
                }
            }
        }
    }
    assert!(
        shape_field_count >= 5,
        "글상자 내 필드가 5개 이상이어야 함 (실제: {})",
        shape_field_count
    );

    let mut hwp_doc = HwpDocument::from_bytes(&data).expect("HwpDocument 생성 실패");
    let svg = hwp_doc.render_page_svg_native(0).expect("SVG 렌더링 실패");

    // SVG에 안내문 텍스트가 빨간색 기울임체로 렌더링되는지 확인
    assert!(
        svg.contains("ff0000"),
        "SVG에 빨간색(#ff0000) 텍스트가 있어야 함"
    );
    assert!(svg.contains("italic"), "SVG에 기울임체 텍스트가 있어야 함");
    assert!(svg.contains(">여</text>"), "SVG에 '여' 글자가 있어야 함");
    assert!(svg.contains(">입</text>"), "SVG에 '입' 글자가 있어야 함");
}

// ─── Task 230: 필드 WASM API 테스트 ─────────────────────────

#[test]
fn test_task230_get_field_list() {
    let data = std::fs::read("samples/field-01.hwp").expect("파일 읽기 실패");
    let hwp_doc = HwpDocument::from_bytes(&data).expect("HwpDocument 생성 실패");

    let json = hwp_doc.get_field_list_json();
    eprintln!("[Task230] getFieldList: {}", json);

    // JSON 배열이어야 함
    assert!(
        json.starts_with('[') && json.ends_with(']'),
        "JSON 배열이어야 함"
    );
    // 최소 6개 필드 (본문 5 + 글상자 내 5 + 기타)
    let field_count = json.matches("\"fieldId\"").count();
    assert!(
        field_count >= 6,
        "필드가 6개 이상이어야 함 (실제: {})",
        field_count
    );
    // ClickHere 필드 포함 확인
    assert!(json.contains("\"clickhere\""), "ClickHere 필드가 있어야 함");
}

#[test]
fn test_task230_get_field_value() {
    let data = std::fs::read("samples/field-01.hwp").expect("파일 읽기 실패");
    let hwp_doc = HwpDocument::from_bytes(&data).expect("HwpDocument 생성 실패");

    // 필드 목록에서 첫 번째 필드 ID 추출
    let json = hwp_doc.get_field_list_json();
    let fields = hwp_doc.collect_all_fields();
    assert!(!fields.is_empty(), "필드가 있어야 함");

    let first_field = &fields[0];
    eprintln!(
        "[Task230] 첫 번째 필드: id={}, type={:?}, name={:?}, value='{}'",
        first_field.field.field_id,
        first_field.field.field_type,
        first_field.field.field_name(),
        first_field.value
    );

    // field_id로 조회
    let result = hwp_doc
        .get_field_value_by_id(first_field.field.field_id)
        .expect("필드 값 조회 실패");
    assert!(result.contains("\"ok\":true"), "조회 성공이어야 함");

    // 이름으로 조회
    if let Some(name) = first_field.field.field_name() {
        let result = hwp_doc
            .get_field_value_by_name(name)
            .expect("이름으로 필드 값 조회 실패");
        assert!(result.contains("\"ok\":true"), "이름 조회 성공이어야 함");
    }
}

#[test]
fn test_task230_set_field_value() {
    let data = std::fs::read("samples/field-01.hwp").expect("파일 읽기 실패");
    let mut hwp_doc = HwpDocument::from_bytes(&data).expect("HwpDocument 생성 실패");

    let fields = hwp_doc.collect_all_fields();
    // 빈 ClickHere 필드 찾기 (value가 빈 것)
    let empty_field = fields
        .iter()
        .find(|f| {
            f.field.field_type == crate::model::control::FieldType::ClickHere && f.value.is_empty()
        })
        .expect("빈 ClickHere 필드가 있어야 함");

    let field_id = empty_field.field.field_id;
    eprintln!(
        "[Task230] 빈 필드에 값 설정: id={}, name={:?}",
        field_id,
        empty_field.field.field_name()
    );

    // 값 설정
    let result = hwp_doc
        .set_field_value_by_id(field_id, "테스트 입력값")
        .expect("필드 값 설정 실패");
    eprintln!("[Task230] setFieldValue 결과: {}", result);
    assert!(result.contains("\"ok\":true"), "설정 성공이어야 함");
    assert!(result.contains("테스트 입력값"), "새 값이 포함되어야 함");

    // 값이 변경되었는지 확인
    let check = hwp_doc
        .get_field_value_by_id(field_id)
        .expect("변경 후 조회 실패");
    assert!(check.contains("테스트 입력값"), "변경된 값이 반영되어야 함");

    // SVG 렌더링에서 변경된 값이 보이는지 확인
    let svg = hwp_doc.render_page_svg_native(0).expect("SVG 렌더링 실패");
    // "테스트 입력값"의 개별 글자가 SVG에 포함되어야 함
    assert!(
        svg.contains(">테</text>") || svg.contains("테스트"),
        "SVG에 변경된 텍스트가 있어야 함"
    );
}

#[test]
fn test_task231_field_survives_text_insert() {
    let data = std::fs::read("samples/field-01.hwp").expect("파일 읽기 실패");
    let mut doc = HwpDocument::from_bytes(&data).expect("HwpDocument 생성 실패");

    // Section 0, Para 7: 빈 누름틀 필드 (start=7, end=7)
    let info_before = doc.get_field_info_at(0, 7, 7);
    eprintln!("[Before] field_info_at(0,7,7): {}", info_before);
    assert!(
        info_before.contains("\"inField\":true"),
        "삽입 전 필드가 있어야 함"
    );

    // 필드 위치(charOffset=7)에 "A" 삽입
    let result = doc
        .insert_text_native(0, 7, 7, "A")
        .expect("텍스트 삽입 실패");
    eprintln!("[After insert] result: {}", result);

    // 삽입 후 커서 위치(charOffset=8)에서 필드 확인
    let info_after = doc.get_field_info_at(0, 7, 8);
    eprintln!("[After] field_info_at(0,7,8): {}", info_after);
    assert!(
        info_after.contains("\"inField\":true"),
        "삽입 후에도 필드가 있어야 함"
    );

    // 필드 시작 위치에서도 확인
    let info_start = doc.get_field_info_at(0, 7, 7);
    eprintln!("[After] field_info_at(0,7,7): {}", info_start);
    assert!(
        info_start.contains("\"inField\":true"),
        "삽입 후 필드 시작도 감지되어야 함"
    );

    // field_ranges 직접 확인
    let para = &doc.document.sections[0].paragraphs[7];
    eprintln!("[After] field_ranges: {:?}", para.field_ranges);
    assert!(
        !para.field_ranges.is_empty(),
        "field_ranges가 비어있으면 안됨"
    );
    let fr = &para.field_ranges[0];
    assert_eq!(fr.start_char_idx, 7, "필드 시작은 7");
    assert_eq!(fr.end_char_idx, 8, "필드 끝은 8 (1글자 삽입 후)");
}

/// IME 조합 사이클 시뮬레이션: delete→insert 반복 시 필드가 사라지지 않는지 검증
#[test]
fn test_task231_field_survives_ime_cycle() {
    let data = std::fs::read("samples/field-01.hwp").expect("파일 읽기 실패");
    let mut doc = HwpDocument::from_bytes(&data).expect("HwpDocument 생성 실패");

    // Section 0, Para 7: 빈 누름틀 필드 (start=7, end=7)
    let info = doc.get_field_info_at(0, 7, 7);
    assert!(info.contains("\"inField\":true"), "초기 필드 존재 확인");

    // IME 1단계: "ㅁ" 삽입 (compositionLength=0이므로 삭제 없음)
    doc.insert_text_native(0, 7, 7, "ㅁ").expect("삽입 실패");
    let fr = &doc.document.sections[0].paragraphs[7].field_ranges[0];
    assert_eq!(
        (fr.start_char_idx, fr.end_char_idx),
        (7, 8),
        "1단계 후 필드 범위"
    );

    // IME 2단계: "ㅁ" 삭제 → "마" 삽입 (delete→insert cycle)
    doc.delete_text_native(0, 7, 7, 1).expect("삭제 실패");
    // *** 핵심: 삭제 후 필드가 비어도 field_ranges가 유지되어야 함 ***
    let para = &doc.document.sections[0].paragraphs[7];
    eprintln!("[After delete] field_ranges: {:?}", para.field_ranges);
    assert!(
        !para.field_ranges.is_empty(),
        "삭제 후에도 빈 필드 범위가 유지되어야 함"
    );
    let fr = &para.field_ranges[0];
    assert_eq!(
        (fr.start_char_idx, fr.end_char_idx),
        (7, 7),
        "삭제 후 빈 필드"
    );

    doc.insert_text_native(0, 7, 7, "마").expect("삽입 실패");
    let fr = &doc.document.sections[0].paragraphs[7].field_ranges[0];
    assert_eq!(
        (fr.start_char_idx, fr.end_char_idx),
        (7, 8),
        "2단계 후 필드 범위"
    );

    // IME 3단계: "마" 삭제 → "만" 삽입
    doc.delete_text_native(0, 7, 7, 1).expect("삭제 실패");
    assert!(
        !doc.document.sections[0].paragraphs[7]
            .field_ranges
            .is_empty(),
        "3단계 삭제 후 필드 유지"
    );
    doc.insert_text_native(0, 7, 7, "만").expect("삽입 실패");
    let fr = &doc.document.sections[0].paragraphs[7].field_ranges[0];
    assert_eq!(
        (fr.start_char_idx, fr.end_char_idx),
        (7, 8),
        "3단계 후 필드 범위"
    );

    // IME 완료 후 필드 정보 확인
    let info = doc.get_field_info_at(0, 7, 8);
    assert!(
        info.contains("\"inField\":true"),
        "IME 완료 후 필드 내 커서 확인"
    );
}

/// getClickHereProps가 유효한 JSON을 반환하는지 검증
#[test]
fn test_task231_get_click_here_props() {
    let data = std::fs::read("samples/field-01.hwp").expect("파일 읽기 실패");
    let doc = HwpDocument::from_bytes(&data).expect("HwpDocument 생성 실패");

    let result = doc.get_click_here_props(1584999796);
    eprintln!("[getClickHereProps] {}", result);
    // 유효한 JSON인지 확인
    assert!(result.contains("\"ok\":true"), "ok=true 이어야 함");
    assert!(
        result.contains("\"guide\":\""),
        "guide 필드가 따옴표로 감싸져야 함"
    );
    assert!(result.contains("여기에 입력"), "안내문이 포함되어야 함");
    // JSON 구조 검증 (따옴표 포함)
    assert!(result.starts_with("{\"ok\":true,"), "JSON 시작 구조");
}

/// updateClickHereProps 후 field_name() 매핑이 동작하는지 검증
#[test]
fn test_task231_update_click_here_props_name_mapping() {
    let data = std::fs::read("samples/field-01.hwp").expect("파일 읽기 실패");
    let mut doc = HwpDocument::from_bytes(&data).expect("HwpDocument 생성 실패");
    let field_id = 1584999796u32;

    // 초기 상태: command에 Name 키 없음, CTRL_DATA에서 "회사명" 로드
    let para = &doc.document.sections[0].paragraphs[7];
    if let crate::model::control::Control::Field(f) = &para.controls[0] {
        assert_eq!(f.field_name(), Some("회사명"), "초기: CTRL_DATA 필드 이름");
        assert_eq!(
            f.ctrl_data_name.as_deref(),
            Some("회사명"),
            "초기: ctrl_data_name"
        );
        assert_eq!(
            f.extract_wstring_value("Name:"),
            None,
            "초기: command에 Name 키 없음"
        );
    }

    // 필드 이름을 "목차1"로 설정
    let result = doc.update_click_here_props(field_id, "여기에 입력", "", "목차1", true);
    assert!(result.contains("\"ok\":true"), "업데이트 성공");

    // 업데이트 후: 이름은 ctrl_data_name에만, command에는 Name: 없음
    let para = &doc.document.sections[0].paragraphs[7];
    if let crate::model::control::Control::Field(f) = &para.controls[0] {
        eprintln!("[After update] command: {:?}", f.command);
        assert_eq!(
            f.field_name(),
            Some("목차1"),
            "업데이트 후: ctrl_data_name 우선"
        );
        assert_eq!(
            f.ctrl_data_name.as_deref(),
            Some("목차1"),
            "ctrl_data_name 설정됨"
        );
        assert_eq!(
            f.extract_wstring_value("Name:"),
            None,
            "command에 Name: 없음 (한컴 호환)"
        );
        assert_eq!(f.guide_text(), Some("여기에 입력"), "안내문 유지됨");
    }

    // getFieldValueByName으로 새 이름 조회 가능
    let val = doc.get_field_value_by_name("목차1");
    eprintln!("[ByName] 목차1: {:?}", val);
    assert!(val.is_ok(), "새 이름으로 조회 가능");

    // getClickHereProps에서 name이 비어있지 않은지 확인
    let props = doc.get_click_here_props(field_id);
    eprintln!("[Props after] {}", props);
    assert!(props.contains("\"name\":\"목차1\""), "props에 새 이름 표시");
}

/// 필드 직렬화 라운드트립: 저장 후 다시 읽으면 필드가 보존되는지 검증
#[test]
fn test_task231_field_roundtrip() {
    let data = std::fs::read("samples/field-01.hwp").expect("파일 읽기 실패");
    let doc = HwpDocument::from_bytes(&data).expect("HwpDocument 생성 실패");

    // 저장 (직렬화 → CFB 바이트)
    let saved = doc.core.export_hwp_native().expect("저장 실패");

    // 다시 읽기
    let doc2 = HwpDocument::from_bytes(&saved).expect("다시 읽기 실패");

    use crate::model::control::{Control, FieldType};
    // sec=0 para=7의 필드 확인
    let para = &doc2.document.sections[0].paragraphs[7];
    let ctrl = &para.controls[0];
    if let Control::Field(f) = ctrl {
        assert_eq!(f.field_type, FieldType::ClickHere);
        assert_eq!(f.field_id, 1584999796);
        assert!(
            f.command.contains("Direction:wstring:6:여기에 입력"),
            "command 보존: {:?}",
            f.command
        );
        assert_eq!(
            f.ctrl_data_name.as_deref(),
            Some("회사명"),
            "CTRL_DATA 필드 이름 보존"
        );
        eprintln!(
            "[roundtrip] id={} command={:?} ctrl_data_name={:?}",
            f.field_id, f.command, f.ctrl_data_name
        );
    } else {
        panic!("sec=0 para=7 ctrl=0이 Field가 아님: {:?}", ctrl);
    }
    // field_ranges 보존 확인
    let orig_para = &doc.document.sections[0].paragraphs[7];
    eprintln!("[roundtrip] orig field_ranges={:?}", orig_para.field_ranges);
    eprintln!("[roundtrip] reload field_ranges={:?}", para.field_ranges);
    assert_eq!(
        para.field_ranges.len(),
        orig_para.field_ranges.len(),
        "field_ranges 개수 보존"
    );
    for (i, (a, b)) in orig_para
        .field_ranges
        .iter()
        .zip(para.field_ranges.iter())
        .enumerate()
    {
        assert_eq!(
            a.start_char_idx, b.start_char_idx,
            "field_range[{}].start 보존",
            i
        );
        assert_eq!(
            a.end_char_idx, b.end_char_idx,
            "field_range[{}].end 보존",
            i
        );
        assert_eq!(
            a.control_idx, b.control_idx,
            "field_range[{}].ctrl_idx 보존",
            i
        );
    }
}

/// 필드 이름만 변경 후 저장 → 안내문이 보존되는지 검증
#[test]
fn test_task231_field_name_change_preserves_guide() {
    let data = std::fs::read("samples/field-01.hwp").expect("파일 읽기 실패");
    let mut doc = HwpDocument::from_bytes(&data).expect("HwpDocument 생성 실패");
    let field_id = 1584999796u32; // "이메일" 필드가 아닌 "회사명" 필드

    // 변경 전 상태
    let props_before = doc.get_click_here_props(field_id);
    eprintln!("[before] {}", props_before);

    // 필드 이름만 변경 (안내문, 메모는 그대로)
    let result = doc.update_click_here_props(field_id, "여기에 입력", "", "회사명1", true);
    eprintln!("[update] {}", result);

    // 변경 후 command 확인
    {
        use crate::model::control::{Control, FieldType};
        let para = &doc.document.sections[0].paragraphs[7];
        if let Control::Field(f) = &para.controls[0] {
            eprintln!("[after update] command={:?}", f.command);
            eprintln!("[after update] ctrl_data_name={:?}", f.ctrl_data_name);
        }
    }

    // 저장
    let saved = doc.core.export_hwp_native().expect("저장 실패");

    // 다시 읽기
    let doc2 = HwpDocument::from_bytes(&saved).expect("다시 읽기 실패");

    use crate::model::control::{Control, FieldType};
    let para = &doc2.document.sections[0].paragraphs[7];
    if let Control::Field(f) = &para.controls[0] {
        eprintln!("[reloaded] command={:?}", f.command);
        eprintln!("[reloaded] ctrl_data_name={:?}", f.ctrl_data_name);
        eprintln!("[reloaded] guide_text={:?}", f.guide_text());
        eprintln!("[reloaded] field_name={:?}", f.field_name());
        assert_eq!(f.field_id, field_id, "field_id 보존");
        assert_eq!(f.guide_text(), Some("여기에 입력"), "안내문 보존");
        assert_eq!(
            f.ctrl_data_name.as_deref(),
            Some("회사명1"),
            "변경된 필드 이름"
        );
    } else {
        panic!("필드가 아님");
    }

    // getClickHereProps로도 확인
    let props_after = doc2.get_click_here_props(field_id);
    eprintln!("[reloaded props] {}", props_after);
    assert!(
        props_after.contains("\"guide\":\"여기에 입력\""),
        "안내문 보존"
    );
    assert!(props_after.contains("\"name\":\"회사명1\""), "변경된 이름");
}

/// 13페이지 엔터 후 페이지 전파 범위 분석
#[test]
fn test_page13_enter_propagation() {
    use crate::renderer::pagination::PageItem;

    let bytes = std::fs::read("samples/kps-ai.hwp").expect("kps-ai.hwp 읽기 실패");
    let mut doc = HwpDocument::from_bytes(&bytes).unwrap();
    doc.convert_to_editable_native().unwrap();
    doc.paginate();

    let pages_before = doc.pagination[0].pages.len();

    // 분할 전: 각 페이지의 첫 번째/마지막 아이템의 para_index 기록
    let mut before_pages: Vec<(usize, usize, usize)> = Vec::new(); // (first_pi, last_pi, item_count)
    for page in &doc.pagination[0].pages {
        let items = &page.column_contents[0].items;
        let first = items.first().map(PageItem::para_index).unwrap_or(0);
        let last = items.last().map(PageItem::para_index).unwrap_or(0);
        before_pages.push((first, last, items.len()));
    }

    // page 13 (idx=12)의 pi=199 앞에서 엔터
    eprintln!("=== splitParagraph(0, 199, 0) ===");
    let result = doc.split_paragraph_native(0, 199, 0, None).unwrap();
    assert!(result.contains("\"ok\":true"));

    let pages_after = doc.pagination[0].pages.len();
    eprintln!("pages: {} → {}", pages_before, pages_after);

    // 분할 후: 각 페이지 비교
    let mut last_diff_page = 0;
    for (pidx, page) in doc.pagination[0].pages.iter().enumerate() {
        let items = &page.column_contents[0].items;
        let first = items.first().map(PageItem::para_index).unwrap_or(0);
        let last = items.last().map(PageItem::para_index).unwrap_or(0);

        let before = before_pages.get(pidx);
        let changed = before
            .map(|b| b.0 != first || b.1 != last || b.2 != items.len())
            .unwrap_or(true);

        if changed {
            last_diff_page = pidx;
            let before_str = before
                .map(|b| format!("pi={}-{} ({}items)", b.0, b.1, b.2))
                .unwrap_or_else(|| "(신규)".to_string());
            eprintln!(
                "  page {:2}: {} → pi={}-{} ({}items) ← CHANGED",
                pidx + 1,
                before_str,
                first,
                last,
                items.len()
            );
        }
    }
    eprintln!(
        "전파 범위: page 13 ~ page {} (총 {} 페이지 영향)",
        last_diff_page + 1,
        last_diff_page + 1 - 12
    );

    // 저장 후 재로드와 비교
    eprintln!("\n=== 저장 후 재로드 비교 ===");
    let exported = doc.export_hwp_native().unwrap();
    let mut doc2 = HwpDocument::from_bytes(&exported).unwrap();
    doc2.convert_to_editable_native().unwrap();
    doc2.paginate();

    let pages_reload = doc2.pagination[0].pages.len();
    eprintln!("재로드 pages: {}", pages_reload);

    let mut diff_count = 0;
    for pidx in 0..doc.pagination[0]
        .pages
        .len()
        .max(doc2.pagination[0].pages.len())
    {
        let items1 = doc.pagination[0]
            .pages
            .get(pidx)
            .map(|p| &p.column_contents[0].items);
        let items2 = doc2.pagination[0]
            .pages
            .get(pidx)
            .map(|p| &p.column_contents[0].items);

        let pi1_first = items1.and_then(|i| i.first()).map(PageItem::para_index);
        let pi2_first = items2.and_then(|i| i.first()).map(PageItem::para_index);
        let count1 = items1.map(|i| i.len()).unwrap_or(0);
        let count2 = items2.map(|i| i.len()).unwrap_or(0);

        if pi1_first != pi2_first || count1 != count2 {
            diff_count += 1;
            eprintln!(
                "  page {:2}: 편집={:?}({}items) vs 재로드={:?}({}items)",
                pidx + 1,
                pi1_first,
                count1,
                pi2_first,
                count2
            );
        }
    }
    if diff_count == 0 {
        eprintln!("  차이 없음 — 편집 결과와 재로드 결과 일치");
    } else {
        eprintln!("  {} 페이지에서 차이 발견", diff_count);
    }
}

/// 12페이지 각 문단에서 엔터 후 13페이지 표 배치 검증
#[test]
fn test_page12_enter_table_placement_scan() {
    use crate::renderer::pagination::PageItem;

    // 12페이지의 각 문단 끝에서 엔터를 입력하는 시나리오
    for split_pi in [194, 196] {
        let bytes = std::fs::read("samples/kps-ai.hwp").expect("kps-ai.hwp 읽기 실패");
        let mut doc = HwpDocument::from_bytes(&bytes).unwrap();
        doc.convert_to_editable_native().unwrap();
        doc.paginate();

        let text_len = doc.document.sections[0].paragraphs[split_pi]
            .text
            .chars()
            .count();
        let offset = text_len; // 문단 끝에서 분할

        eprintln!("\n=== split pi={} offset={} ===", split_pi, offset);

        // 분할 전 page 13 (idx=12) 확인
        let table_pi_before = 198; // 원래 pi=198의 표
        let p13_before = &doc.pagination[0].pages[12];
        let has_table_before = p13_before.column_contents[0].items.iter().any(
            |it| matches!(it, PageItem::Table { para_index, .. } if *para_index == table_pi_before),
        );
        eprintln!(
            "  before: pi={} table on page 13: {}",
            table_pi_before, has_table_before
        );

        let result = doc
            .split_paragraph_native(0, split_pi, offset, None)
            .unwrap();
        assert!(
            result.contains("\"ok\":true"),
            "split failed at pi={}: {}",
            split_pi,
            result
        );

        let pages_after = doc.pagination[0].pages.len();
        let table_pi_after = if split_pi < table_pi_before {
            table_pi_before + 1
        } else {
            table_pi_before
        };

        // 분할 후: 표가 어느 페이지에 있는지 탐색
        let mut table_page = None;
        for (pidx, page) in doc.pagination[0].pages.iter().enumerate() {
            for item in &page.column_contents[0].items {
                if matches!(item, PageItem::Table { para_index, .. } if *para_index == table_pi_after)
                {
                    table_page = Some(pidx);
                }
            }
        }
        eprintln!(
            "  after: pi={} table on page {} (total {})",
            table_pi_after,
            table_page.map(|p| p + 1).unwrap_or(0),
            pages_after
        );

        // 페이지 12-15 내용 출력
        for pidx in 11..15.min(pages_after) {
            let p = &doc.pagination[0].pages[pidx];
            eprintln!("  page {} items:", pidx + 1);
            for item in &p.column_contents[0].items {
                match item {
                    PageItem::Table {
                        para_index,
                        control_index,
                    } => {
                        let text = &doc.document.sections[0].paragraphs[*para_index].text;
                        eprintln!(
                            "    Table pi={} ci={} text='{}'",
                            para_index,
                            control_index,
                            &text[..text.len().min(30)]
                        );
                    }
                    PageItem::FullParagraph { para_index } => {
                        let text = &doc.document.sections[0].paragraphs[*para_index].text;
                        let display: String = if text.is_empty() {
                            "(빈)".to_string()
                        } else {
                            text.chars().take(40).collect()
                        };
                        eprintln!("    FullPara pi={} '{}'", para_index, display);
                    }
                    _ => eprintln!("    {:?}", item),
                }
            }
        }
    }
}

/// 12페이지 엔터 후 13페이지의 표 배치 검증
#[test]
fn test_page12_enter_table_placement() {
    use crate::renderer::pagination::PageItem;

    let bytes = std::fs::read("samples/kps-ai.hwp").expect("kps-ai.hwp 읽기 실패");
    let mut doc = HwpDocument::from_bytes(&bytes).unwrap();
    doc.convert_to_editable_native().unwrap();
    doc.paginate();

    let pages_before = doc.pagination[0].pages.len();
    eprintln!("  pages_before = {}", pages_before);

    // page 12 (idx=11) 내용 확인
    let p12 = &doc.pagination[0].pages[11];
    eprintln!("  page 12 items:");
    for item in &p12.column_contents[0].items {
        eprintln!("    {:?}", item);
    }

    // page 13 (idx=12): pi=197(text), pi=198(table), pi=199(text)
    let p13_before = &doc.pagination[0].pages[12];
    eprintln!("  page 13 items (before):");
    for item in &p13_before.column_contents[0].items {
        eprintln!("    {:?}", item);
    }
    // pi=198 표가 page 13에 있는지 확인
    let has_table_198_on_p13 = p13_before.column_contents[0].items.iter().any(|it| {
        matches!(
            it,
            PageItem::Table {
                para_index: 198,
                ..
            }
        )
    });
    assert!(
        has_table_198_on_p13,
        "수정 전: pi=198 표가 page 13에 있어야 함"
    );

    // pi=199 앞에서 엔터 (pi=199를 분할하여 빈 문단 삽입)
    let result = doc.split_paragraph_native(0, 199, 0, None).unwrap();
    assert!(result.contains("\"ok\":true"), "split failed: {}", result);

    let pages_after = doc.pagination[0].pages.len();
    eprintln!("  pages_after = {}", pages_after);

    // page 13 (idx=12): pi=198 표가 여전히 page 13에 있어야 함
    if doc.pagination[0].pages.len() > 12 {
        let p13_after = &doc.pagination[0].pages[12];
        eprintln!("  page 13 items (after):");
        for item in &p13_after.column_contents[0].items {
            eprintln!("    {:?}", item);
        }
        let has_table_198_after = p13_after.column_contents[0].items.iter().any(|it| {
            matches!(
                it,
                PageItem::Table {
                    para_index: 198,
                    ..
                }
            )
        });

        // page 14도 확인
        if doc.pagination[0].pages.len() > 13 {
            let p14_after = &doc.pagination[0].pages[13];
            eprintln!("  page 14 items (after):");
            for item in &p14_after.column_contents[0].items {
                eprintln!("    {:?}", item);
            }
        }

        assert!(
            has_table_198_after,
            "pi=198 표가 page 13에 있어야 하지만 다음 페이지로 밀려남"
        );
    }
}

/// 문단 분할 후 페이지 수가 과도하게 증가하지 않는지 검증
/// (measure_section_selective의 off-by-one 인덱싱 버그 회귀 방지)
#[test]
fn test_split_paragraph_page_count_stability() {
    let bytes = std::fs::read("samples/kps-ai.hwp").expect("kps-ai.hwp 읽기 실패");
    let mut doc = HwpDocument::from_bytes(&bytes).unwrap();
    doc.convert_to_editable_native().unwrap();
    doc.paginate();

    let pages_before = doc.pagination.iter().map(|r| r.pages.len()).sum::<usize>();
    eprintln!("  pages_before = {}", pages_before);

    // pi=199 앞에서 엔터 (offset=0으로 분할)
    let result = doc.split_paragraph_native(0, 199, 0, None).unwrap();
    assert!(result.contains("\"ok\":true"), "split failed: {}", result);

    let pages_after = doc.pagination.iter().map(|r| r.pages.len()).sum::<usize>();
    eprintln!("  pages_after = {}", pages_after);

    // 한 줄 추가이므로 페이지 수 증가는 최대 2 이내여야 함
    let delta = pages_after as i64 - pages_before as i64;
    eprintln!("  delta = {}", delta);
    assert!(
        delta <= 2,
        "문단 분할 후 페이지 수가 {}에서 {}로 {}만큼 증가 (최대 2 예상)",
        pages_before,
        pages_after,
        delta
    );
}

/// 논리적 오프셋: 인라인 TAC 표 뒤에서 텍스트 삽입 검증
#[test]
fn test_logical_offset_insert_after_inline_table() {
    let bytes = std::fs::read("saved/blank2010.hwp").expect("blank2010.hwp 읽기 실패");
    let mut doc = HwpDocument::from_bytes(&bytes).unwrap();
    doc.convert_to_editable_native().unwrap();
    doc.paginate();

    // Enter로 새 문단 생성 (기존 컨트롤이 있는 pi=0 대신 깨끗한 pi=1 사용)
    doc.insert_text_native(0, 0, 0, "test").unwrap();
    doc.split_paragraph_native(0, 0, 4, None).unwrap();

    // pi=1에 "abc" 입력
    doc.insert_text_native(0, 1, 0, "abc").unwrap();
    let para = &doc.document.sections[0].paragraphs[1];
    assert_eq!(para.text, "abc");
    eprintln!("  pi=1 controls={} (표 삽입 전)", para.controls.len());

    // offset=3 위치에 인라인 TAC 2×2 표 삽입
    let result = doc
        .create_table_ex_native(0, 1, 3, 2, 2, true, Some(&[6777, 6777]), None)
        .unwrap();
    eprintln!("  createTableEx result: {}", result);
    // logicalOffset: "abc"(3) + [표](1) = 4
    assert!(
        result.contains("\"logicalOffset\":4"),
        "logicalOffset=4 예상: {}",
        result
    );

    let para = &doc.document.sections[0].paragraphs[1];
    eprintln!(
        "  text='{}' controls={} char_offsets={:?}",
        para.text,
        para.controls.len(),
        para.char_offsets
    );

    // 논리적 길이: "abc"(3) + [표](1) = 4
    let logical_len = crate::document_core::helpers::logical_paragraph_length(para);
    eprintln!("  논리적 길이: {}", logical_len);
    assert_eq!(logical_len, 4, "논리적 길이 4 예상, 실제: {}", logical_len);

    // 논리적 offset 4에 "XYZ" 삽입 → 표 뒤에 삽입되어야 함
    let (text_off, after_ctrl) = crate::document_core::helpers::logical_to_text_offset(para, 4);
    eprintln!(
        "  logical 4 → text_off={} after_ctrl={}",
        text_off, after_ctrl
    );
    assert_eq!(text_off, 3, "text_off=3 예상 (abc 뒤)");

    doc.insert_text_native(0, 1, text_off, "XYZ").unwrap();
    let para = &doc.document.sections[0].paragraphs[1];
    assert_eq!(
        para.text, "abcXYZ",
        "표 뒤에 XYZ 삽입 예상, 실제: '{}'",
        para.text
    );
    eprintln!("  삽입 후 text='{}' ✓", para.text);

    // 논리적 길이: "abcXYZ"(6) + [표](1) = 7
    let logical_len2 = crate::document_core::helpers::logical_paragraph_length(para);
    assert_eq!(
        logical_len2, 7,
        "논리적 길이 7 예상, 실제: {}",
        logical_len2
    );

    // logical offset 변환 검증 (삽입 후: "abcXYZ" + [표at3])
    // a(0) b(1) c(2) [표](3) X(4) Y(5) Z(6)
    let (t0, _) = crate::document_core::helpers::logical_to_text_offset(para, 0);
    let (t3, _) = crate::document_core::helpers::logical_to_text_offset(para, 3);
    let (t4, _) = crate::document_core::helpers::logical_to_text_offset(para, 4);
    let (t7, _) = crate::document_core::helpers::logical_to_text_offset(para, 7);
    eprintln!("  logical→text: 0→{} 3→{} 4→{} 7→{}", t0, t3, t4, t7);
    assert_eq!(t0, 0, "logical 0 → text 0");
    assert_eq!(
        t3, 3,
        "logical 3 → text 3 (표 위치, [표] = ctrl at text pos 3)"
    );
    assert_eq!(t4, 3 + 1, "logical 4 → text 4 (X, 표 뒤 첫 텍스트)");
    assert_eq!(t7, 6, "logical 7 → text 6 (끝)");

    // ── 핵심 검증: charOffset > text_len으로 직접 삽입 ──
    // 새 문서에서 "가나다" + [표] 구조 생성, charOffset=4로 삽입
    doc.split_paragraph_native(0, 1, 6, None).unwrap(); // pi=2 생성
    doc.insert_text_native(0, 2, 0, "가나다").unwrap();
    doc.create_table_ex_native(0, 2, 3, 1, 1, true, Some(&[5000]), None)
        .unwrap();
    let para2 = &doc.document.sections[0].paragraphs[2];
    let tl = para2.text.chars().count();
    eprintln!(
        "  pi=2: text='{}' len={} controls={}",
        para2.text,
        tl,
        para2.controls.len()
    );
    // charOffset=4 (> text_len=3) → 표 뒤에 삽입
    doc.insert_text_native(0, 2, 4, "라마바").unwrap();
    let para2 = &doc.document.sections[0].paragraphs[2];
    eprintln!("  charOffset=4 삽입 후: '{}'", para2.text);
    assert_eq!(
        para2.text, "가나다라마바",
        "표 뒤에 '라마바' 삽입, 실제: '{}'",
        para2.text
    );

    eprintln!("  논리적 오프셋 테스트 통과 ✓");
}

/// createTableEx: 빈 문서에서 인라인 TAC 표를 생성하여 tac-case-001.hwp와 동일한 구조 검증
#[test]
fn test_create_inline_tac_table() {
    let bytes = std::fs::read("saved/blank2010.hwp").expect("blank2010.hwp 읽기 실패");
    let mut doc = HwpDocument::from_bytes(&bytes).unwrap();
    doc.convert_to_editable_native().unwrap();
    doc.paginate();

    // 1. pi=0에 "TC #20" 입력
    doc.insert_text_native(0, 0, 0, "TC #20").unwrap();
    // 2. Enter → pi=1 생성
    doc.split_paragraph_native(0, 0, 6, None).unwrap();
    // 3. pi=1에 "tacglkj 표 3 배치 시작" 입력
    doc.insert_text_native(0, 1, 0, "tacglkj 표 3 배치 시작")
        .unwrap();

    let text_len = doc.document.sections[0].paragraphs[1].text.chars().count();
    eprintln!(
        "  pi=1 text='{}' len={}",
        doc.document.sections[0].paragraphs[1].text, text_len
    );

    // 4. pi=1, char_offset=text_len 위치에 인라인 TAC 2×2 표 생성
    // 열 폭: 6777 HU × 2 = 13554 HU (tac-case-001.hwp과 동일)
    let result = doc
        .create_table_ex_native(0, 1, text_len, 2, 2, true, Some(&[6777, 6777]), None)
        .unwrap();
    eprintln!("  createTableEx result: {}", result);
    assert!(
        result.contains("\"ok\":true"),
        "createTableEx 실패: {}",
        result
    );

    // 5. 표 뒤에 "4 tacglkj 표 다음" 텍스트 추가
    let para = &doc.document.sections[0].paragraphs[1];
    let new_text_offset = para.text.chars().count();
    doc.insert_text_native(0, 1, new_text_offset, "4 tacglkj 표 다음")
        .unwrap();

    // 6. 검증
    let para = &doc.document.sections[0].paragraphs[1];
    eprintln!(
        "  pi=1 final text='{}' controls={}",
        para.text,
        para.controls.len()
    );

    // 표가 controls에 추가되었는지
    assert_eq!(para.controls.len(), 1, "pi=1에 표 컨트롤 1개 예상");
    if let crate::model::control::Control::Table(t) = &para.controls[0] {
        assert!(t.common.treat_as_char, "treat_as_char=true 예상");
        assert_eq!(t.row_count, 2, "행 수 2 예상");
        assert_eq!(t.col_count, 2, "열 수 2 예상");
        eprintln!(
            "  표: {}×{} tac={} width={} height={}",
            t.row_count, t.col_count, t.common.treat_as_char, t.common.width, t.common.height
        );
    } else {
        panic!("pi=1의 첫 컨트롤이 Table이 아님");
    }

    // 셀에 텍스트 입력
    doc.insert_text_in_cell_native(0, 1, 0, 0, 0, 0, "1")
        .unwrap();
    doc.insert_text_in_cell_native(0, 1, 0, 1, 0, 0, "2")
        .unwrap();
    doc.insert_text_in_cell_native(0, 1, 0, 2, 0, 0, "3 tacglkj")
        .unwrap();
    doc.insert_text_in_cell_native(0, 1, 0, 3, 0, 0, "4 tacglkj")
        .unwrap();

    // Enter → pi=2
    let pi1_len = crate::document_core::helpers::logical_paragraph_length(
        &doc.document.sections[0].paragraphs[1],
    );
    doc.split_paragraph_native(0, 1, pi1_len, None).unwrap();
    // pi=2에 텍스트
    doc.insert_text_native(0, 2, 0, "tacglkj 가나 옮").unwrap();

    // 페이지네이션
    doc.paginate();
    let page_count: usize = doc.pagination.iter().map(|r| r.pages.len()).sum();
    eprintln!("  최종 페이지 수: {}", page_count);
    assert_eq!(page_count, 1, "1페이지 문서 예상");

    // 텍스트에 표가 포함된 인라인 배치 확인
    let para = &doc.document.sections[0].paragraphs[1];
    assert!(!para.text.is_empty(), "pi=1에 텍스트가 있어야 함");
    assert_eq!(para.controls.len(), 1, "pi=1에 인라인 표 1개");

    // is_tac_table_inline 확인
    let seg_w = para.line_segs.first().map(|s| s.segment_width).unwrap_or(0);
    if let crate::model::control::Control::Table(t) = &para.controls[0] {
        let is_inline =
            crate::renderer::height_measurer::is_tac_table_inline_in_para(t, seg_w, para);
        eprintln!("  is_tac_table_inline: {} (seg_w={})", is_inline, seg_w);
        assert!(is_inline, "인라인 TAC 표로 판별되어야 함");
    }

    eprintln!("  인라인 TAC 표 생성 테스트 통과");
}

#[test]
fn test_extract_thumbnail_with_preview() {
    // PrvImage가 있는 HWP 파일 테스트
    let data = std::fs::read("samples/biz_plan.hwp").expect("biz_plan.hwp 읽기 실패");
    let result = crate::parser::extract_thumbnail_only(&data);
    if let Some(ref r) = result {
        eprintln!(
            "  biz_plan.hwp 썸네일: format={}, size={}bytes, {}x{}",
            r.format,
            r.data.len(),
            r.width,
            r.height
        );
        eprintln!(
            "  매직 바이트: {:02x?}",
            &r.data[..std::cmp::min(16, r.data.len())]
        );
    } else {
        eprintln!("  biz_plan.hwp 썸네일: None");
    }
    // PrvImage 유무와 상관없이 패닉하지 않아야 함
}

#[test]
fn test_extract_thumbnail_without_preview() {
    // 잘못된 데이터에서는 None 반환
    let result = crate::parser::extract_thumbnail_only(&[0u8; 100]);
    assert!(result.is_none(), "잘못된 데이터에서는 None이어야 함");

    // 빈 바이트에서도 패닉하지 않아야 함
    let result = crate::parser::extract_thumbnail_only(&[]);
    assert!(result.is_none(), "빈 데이터에서는 None이어야 함");
    eprintln!("  잘못된/빈 데이터 썸네일: None (정상)");
}

// ---------- #177: getValidationWarnings / reflowLinesegs WASM API ----------

#[test]
fn test_get_validation_warnings_empty_document() {
    // 빈 문서는 경고 없음.
    let doc = HwpDocument::create_empty();
    let json = doc.get_validation_warnings();
    assert!(
        json.contains(r#""count":0"#),
        "empty doc must have count:0, got: {}",
        json
    );
    assert!(json.contains(r#""warnings":[]"#));
}

#[test]
fn test_get_validation_warnings_json_shape() {
    // JSON 구조 검증 — 빈 문서라도 최소 형태를 갖춰야 함.
    let doc = HwpDocument::create_empty();
    let json = doc.get_validation_warnings();
    // 필수 키: count, summary, warnings
    assert!(json.contains(r#""count":"#));
    assert!(json.contains(r#""summary":"#));
    assert!(json.contains(r#""warnings":"#));
}

#[test]
fn test_reflow_linesegs_empty_document_returns_zero() {
    // 빈 문서에선 reflow 대상 없음 → 0 반환.
    let mut doc = HwpDocument::create_empty();
    let count = doc.reflow_linesegs();
    assert_eq!(count, 0);
}

#[test]
fn test_create_blank_document_clears_previous_hwpx_validation_warnings() {
    let bytes = std::fs::read("samples/hwpx_sample2.hwpx").expect("HWPX 샘플 읽기");
    let mut doc = HwpDocument::new(&bytes).expect("HWPX 샘플 로드");

    let before: Value = serde_json::from_str(&doc.get_validation_warnings()).expect("경고 JSON");
    assert!(
        before["count"].as_u64().unwrap_or(0) > 0,
        "재현 샘플은 HWPX validation warning이 있어야 함: {before}"
    );
    assert_eq!(doc.get_source_format(), "hwpx");

    doc.create_blank_document_native()
        .expect("새 문서 생성 성공");

    let after: Value = serde_json::from_str(&doc.get_validation_warnings()).expect("경고 JSON");
    assert_eq!(
        after["count"].as_u64(),
        Some(0),
        "새 문서는 이전 HWPX warning을 물려받으면 안 됨: {after}"
    );
    assert_eq!(doc.get_source_format(), "hwp");
}

#[test]
fn test_hml_source_format_is_reported_without_reusing_hwp_save_path() {
    let bytes = br#"<?xml version="1.0" encoding="UTF-8"?>
<HWPML Style="embed" SubVersion="9.0.1.0" Version="2.9">
  <HEAD SecCnt="1" />
  <BODY><SECTION Id="0"><P ParaShape="0" Style="0"><TEXT CharShape="0"><CHAR>HML</CHAR></TEXT></P></SECTION></BODY>
  <TAIL />
</HWPML>"#;
    let doc = HwpDocument::new(bytes).expect("HML 문서를 열어야 한다");

    assert_eq!(doc.get_source_format(), "hml");
}

#[test]
fn test_hml_save_state_is_one_canonical_dto_for_hml_non_hml_and_unknown_equation() {
    let lawful = br#"<HWPML Version="2.91"><HEAD/><BODY><SECTION><P><TEXT><CHAR>ok</CHAR></TEXT></P></SECTION></BODY><TAIL/></HWPML>"#;
    let mut doc = HwpDocument::new(lawful).expect("lawful HML");
    let state: Value = serde_json::from_str(&doc.get_hml_save_state()).expect("save state JSON");
    assert_eq!(
        state,
        serde_json::json!({
            "sourceFormat": "hml",
            "hmlSavable": true,
            "blockers": [],
        })
    );

    doc.create_blank_document_native()
        .expect("non-HML blank document");
    let state: Value = serde_json::from_str(&doc.get_hml_save_state()).expect("save state JSON");
    assert_eq!(
        state,
        serde_json::json!({
            "sourceFormat": "hwp",
            "hmlSavable": false,
            "blockers": [{
                "code": "HML_SOURCE_REQUIRED",
                "xmlPath": "/HWPML",
                "message": "HML 원본 문서만 HML로 저장할 수 있습니다",
                "preserved": false,
            }],
        })
    );

    let unknown = br#"<HWPML Version="2.91"><HEAD/><BODY><SECTION><P><TEXT><EQUATION FutureAttr="1"><SCRIPT>x</SCRIPT><FUTURE/></EQUATION></TEXT></P></SECTION></BODY><TAIL/></HWPML>"#;
    let doc = HwpDocument::new(unknown).expect("unknown equation semantics remain readable");
    let state: Value = serde_json::from_str(&doc.get_hml_save_state()).expect("save state JSON");
    assert_eq!(state["hmlSavable"], false);
    assert_eq!(state["sourceFormat"], "hml");
    assert_eq!(state["blockers"].as_array().map(Vec::len), Some(2));
    for blocker in state["blockers"].as_array().unwrap() {
        assert_eq!(blocker["code"], "HML_UNSUPPORTED_EQUATION_SEMANTICS");
        assert_eq!(blocker["preserved"], false);
    }
}

#[test]
fn test_unknown_equation_values_survive_edit_undo_redo_and_save_state() {
    let unknown = br#"<HWPML Version="2.91"><HEAD/><BODY><SECTION><P><TEXT><EQUATION><SCRIPT>x</SCRIPT><FUTURE Mode="matrix&amp;inline">secret &lt; value</FUTURE></EQUATION></TEXT></P></SECTION></BODY><TAIL/></HWPML>"#;
    let mut doc = HwpDocument::new(unknown).expect("unknown equation semantics remain readable");
    let before_snapshot = doc.save_snapshot_native();

    doc.set_equation_properties_native(0, 0, 0, None, None, r#"{"script":"x^2 + 2"}"#)
        .expect("equation edit should apply");
    let after_snapshot = doc.save_snapshot_native();

    let assert_values = |doc: &HwpDocument| {
        let state: Value =
            serde_json::from_str(&doc.get_hml_save_state()).expect("save state JSON");
        let blockers = state["blockers"].as_array().expect("blocker array");
        assert!(blockers.iter().any(|blocker| {
            blocker["xmlPath"] == "/HWPML/BODY/SECTION/P/TEXT/EQUATION/FUTURE/@Mode"
                && blocker["message"]
                    .as_str()
                    .is_some_and(|message| message.contains("Mode=matrix&inline"))
                && blocker["preserved"] == false
        }));
        assert!(blockers.iter().any(|blocker| {
            blocker["xmlPath"] == "/HWPML/BODY/SECTION/P/TEXT/EQUATION/FUTURE/#text"
                && blocker["message"]
                    .as_str()
                    .is_some_and(|message| message.contains("#text=secret < value"))
                && blocker["preserved"] == false
        }));
    };

    assert_values(&doc);
    doc.restore_snapshot_native(before_snapshot)
        .expect("undo snapshot should restore");
    assert_values(&doc);
    doc.restore_snapshot_native(after_snapshot)
        .expect("redo snapshot should restore");
    assert_values(&doc);
}

#[test]
fn test_hml_open_metadata_exposes_import_warnings() {
    let bytes = include_bytes!("../../samples/hml/formatting_table.hml");
    let doc = HwpDocument::new(bytes).expect("real HML fixture should open");
    let metadata: Value =
        serde_json::from_str(&doc.get_hml_open_metadata()).expect("HML metadata JSON");

    assert_eq!(metadata["format"], "hml");
    assert_eq!(metadata["hwpmlVersion"], "2.91");
    assert_eq!(metadata["encoding"], "utf-8");
    assert_eq!(metadata["resourceCount"], 0);
    assert_eq!(metadata["hmlSavable"], true);
    assert_eq!(metadata["saveBlockers"], serde_json::json!([]));
    assert!(metadata["warnings"].as_array().is_some_and(|items| {
        items
            .iter()
            .any(|warning| warning["xmlPath"] == "/HWPML/TAIL/SCRIPTCODE")
    }));
}

#[test]
fn test_hml_open_metadata_escapes_special_characters_as_valid_json() {
    let bytes = include_bytes!("../../samples/hml/formatting_table.hml");
    let mut doc = HwpDocument::new(bytes).expect("real HML fixture should open");
    let special = "2.91\"\\\n한글\t";
    let metadata = doc
        .core
        .hml_metadata
        .as_mut()
        .expect("HML metadata should exist");
    metadata.hwpml_version = Some(special.to_string());
    metadata.warnings[0].message = special.to_string();

    let json: Value = serde_json::from_str(&doc.get_hml_open_metadata())
        .expect("metadata must remain valid JSON");

    assert_eq!(json["hwpmlVersion"], special);
    assert_eq!(json["warnings"][0]["message"], special);
}

#[test]
fn test_export_hml_binding_preserves_edit_and_fragment() {
    let bytes = include_bytes!("../../samples/hml/formatting_table.hml");
    let mut doc = HwpDocument::new(bytes).expect("real HML fixture should open");
    let (section_index, paragraph_index) = doc
        .document()
        .sections
        .iter()
        .enumerate()
        .find_map(|(section_index, section)| {
            section
                .paragraphs
                .iter()
                .position(|paragraph| !paragraph.text.is_empty())
                .map(|paragraph_index| (section_index, paragraph_index))
        })
        .expect("fixture should contain text");
    doc.insert_text_native(section_index, paragraph_index, 0, "WASM_EDIT_")
        .expect("apply public edit");

    let exported = doc.export_hml().expect("exportHml should succeed");

    assert_eq!(
        crate::parser::detect_format(&exported),
        crate::parser::FileFormat::Hml
    );
    assert!(String::from_utf8_lossy(&exported).contains("<SCRIPTCODE"));
    let reparsed = DocumentCore::from_bytes(&exported).expect("exportHml output should reparse");
    assert!(
        reparsed.document().sections[section_index].paragraphs[paragraph_index]
            .text
            .starts_with("WASM_EDIT_")
    );
}

#[test]
fn test_export_hml_error_message_exposes_blocker_codes() {
    let fixture = std::str::from_utf8(include_bytes!("../../samples/hml/formatting_table.hml"))
        .expect("fixture is UTF-8");
    let lossy = fixture.replacen("Type=\"None\"", "Type=\"Dash\"", 1);
    let doc = HwpDocument::new(lossy.as_bytes()).expect("lossy HML should import");
    let error = doc
        .core
        .export_hml_native()
        .expect_err("lossy import must block exportHml");
    let blocker = &error.blockers()[0];

    let message = super::format_hml_export_error(&error);

    assert!(message.contains(blocker.code), "{message}");
    assert!(message.contains(&blocker.xml_path), "{message}");
    assert!(message.contains(&blocker.message), "{message}");
}

#[test]
fn test_hml_open_metadata_uses_shared_preflight_for_import_and_ir_loss() {
    let fixture = std::str::from_utf8(include_bytes!("../../samples/hml/formatting_table.hml"))
        .expect("fixture is UTF-8");
    let lossy = fixture.replacen("Type=\"None\"", "Type=\"Dash\"", 1);
    let import_loss = HwpDocument::new(lossy.as_bytes()).expect("lossy HML should import");
    let import_json: Value =
        serde_json::from_str(&import_loss.get_hml_open_metadata()).expect("metadata JSON");
    assert_eq!(import_json["hmlSavable"], false);
    assert!(import_json["saveBlockers"]
        .as_array()
        .is_some_and(|blockers| {
            blockers.iter().any(|blocker| {
                blocker["code"] == "UNSUPPORTED_ATTRIBUTE"
                    && blocker["xmlPath"]
                        == "/HWPML/HEAD/MAPPINGTABLE/BORDERFILLLIST/BORDERFILL/LEFTBORDER"
                    && blocker["message"]
                        .as_str()
                        .is_some_and(|message| !message.is_empty())
            })
        }));

    let mut edited_ir = HwpDocument::new(fixture.as_bytes()).expect("lawful HML should import");
    edited_ir.document_mut().sections[0].paragraphs[0].column_type =
        crate::model::paragraph::ColumnBreakType::Section;
    let ir_json: Value =
        serde_json::from_str(&edited_ir.get_hml_open_metadata()).expect("metadata JSON");
    assert_eq!(ir_json["hmlSavable"], false);
    assert!(ir_json["saveBlockers"].as_array().is_some_and(|blockers| {
        blockers.iter().any(|blocker| {
            blocker["code"] == "HML_UNSUPPORTED_IR"
                && blocker["xmlPath"]
                    .as_str()
                    .is_some_and(|path| !path.is_empty())
                && blocker["message"]
                    .as_str()
                    .is_some_and(|message| !message.is_empty())
        })
    }));
}

#[test]
fn test_hml_open_metadata_reports_mixed_import_and_ir_loss() {
    let fixture = std::str::from_utf8(include_bytes!("../../samples/hml/formatting_table.hml"))
        .expect("fixture is UTF-8");
    let lossy = fixture.replacen("Type=\"None\"", "Type=\"Dash\"", 1);
    let mut doc = HwpDocument::new(lossy.as_bytes()).expect("lossy HML should import");
    doc.document_mut().sections[0].paragraphs[0].column_type =
        crate::model::paragraph::ColumnBreakType::Section;

    let metadata: Value =
        serde_json::from_str(&doc.get_hml_open_metadata()).expect("metadata JSON");
    let blockers = metadata["saveBlockers"]
        .as_array()
        .expect("save blockers array");

    assert_eq!(metadata["hmlSavable"], false);
    assert!(blockers
        .iter()
        .any(|blocker| blocker["code"] == "UNSUPPORTED_ATTRIBUTE"));
    assert!(blockers
        .iter()
        .any(|blocker| blocker["code"] == "HML_UNSUPPORTED_IR"));
}

#[test]
fn test_reflow_linesegs_keeps_hwpx_sample2_page_count_for_textrun_warnings() {
    let bytes = std::fs::read("samples/hwpx_sample2.hwpx").expect("HWPX 샘플 읽기");
    let mut doc = HwpDocument::new(&bytes).expect("HWPX 샘플 로드");

    let before_page_count = doc.page_count();
    let before: Value = serde_json::from_str(&doc.get_validation_warnings()).expect("경고 JSON");
    assert_eq!(before_page_count, 29);
    assert_eq!(before["count"].as_u64(), Some(151));

    let reflowed = doc.reflow_linesegs();

    assert_eq!(
        reflowed, 0,
        "LinesegTextRunReflow 경고는 페이지 수를 바꿀 수 있어 자동 보정하지 않음"
    );
    assert_eq!(
        doc.page_count(),
        before_page_count,
        "권장 보정으로 HWPX 페이지 수가 바뀌면 안 됨"
    );
}

// ---------- #1413: insertPictureEx(options object) 동치 ----------

/// `insertPictureEx`(options JSON + image_data)가 positional `insertPicture` 와
/// 동일하게 동작해야 한다. 같은 입력으로 두 문서에 각각 삽입 → 렌더 SVG 의 이미지
/// 수와 반환 JSON 의 paraIdx/controlIdx 가 일치.
#[test]
fn task1413_insert_picture_ex_equivalent_to_positional() {
    fn png() -> Vec<u8> {
        vec![
            0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48,
            0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00,
            0x00, 0x1F, 0x15, 0xC4, 0x89, 0x00, 0x00, 0x00, 0x0A, 0x49, 0x44, 0x41, 0x54, 0x78,
            0x9C, 0x63, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0D, 0x0A, 0x00, 0x00, 0x00,
            0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
        ]
    }
    fn count_images(svg: &str) -> usize {
        svg.matches("<image").count()
    }

    // positional 경로
    let mut doc_pos = HwpDocument::create_empty();
    let res_pos = doc_pos
        .insert_picture(
            0,
            0,
            0,
            "",
            &png(),
            4000,
            3000,
            100,
            80,
            "png",
            "",
            None,
            None,
        )
        .expect("positional insertPicture");

    // *Ex 경로 — 동일 입력을 options JSON 으로
    let mut doc_ex = HwpDocument::create_empty();
    let options = r#"{"sectionIdx":0,"paraIdx":0,"charOffset":0,"cellPath":"",
        "width":4000,"height":3000,"naturalWidthPx":100,"naturalHeightPx":80,
        "extension":"png","description":""}"#;
    let res_ex = doc_ex
        .insert_picture_ex(options, &png())
        .expect("insertPictureEx");

    // 반환 JSON 동치 (paraIdx/controlIdx)
    assert_eq!(res_pos, res_ex, "*Ex 반환이 positional 과 동일해야 함");

    // 렌더 결과 동치 (이미지 수)
    let svg_pos = doc_pos.render_page_svg_native(0).expect("svg pos");
    let svg_ex = doc_ex.render_page_svg_native(0).expect("svg ex");
    assert_eq!(
        count_images(&svg_pos),
        count_images(&svg_ex),
        "*Ex 렌더 이미지 수가 positional 과 동일해야 함"
    );
    assert_eq!(count_images(&svg_ex), 1, "그림 1개 삽입");
}

/// options JSON 의 키 누락 시 positional default 와 동일 처리 (description/extension/
/// paperOffset 부재).
#[test]
fn task1413_insert_picture_ex_optional_keys_default() {
    fn png() -> Vec<u8> {
        vec![
            0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48,
            0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00,
            0x00, 0x1F, 0x15, 0xC4, 0x89, 0x00, 0x00, 0x00, 0x0A, 0x49, 0x44, 0x41, 0x54, 0x78,
            0x9C, 0x63, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0D, 0x0A, 0x00, 0x00, 0x00,
            0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
        ]
    }
    // optional 키(extension/description/paperOffset/cellPath) 생략 — 본문 inline 삽입.
    let mut doc = HwpDocument::create_empty();
    let res = doc
        .insert_picture_ex(
            r#"{"sectionIdx":0,"paraIdx":0,"width":4000,"height":3000,"naturalWidthPx":100,"naturalHeightPx":80}"#,
            &png(),
        )
        .expect("insertPictureEx with optional keys omitted");
    assert!(
        res.contains("\"ok\":true") || res.contains("paraIdx"),
        "삽입 성공: {res}"
    );
}

// ---------- #1413 2단계: 고인자(9~11) *Ex 동치 ----------

/// splitTableCellInto vs splitTableCellIntoEx 동치.
#[test]
fn task1413_split_table_cell_into_ex_equivalent() {
    let mut doc_pos = create_doc_with_table();
    let res_pos = doc_pos
        .split_table_cell_into(0, 0, 0, 0, 0, 2, 2, true, false)
        .expect("positional splitTableCellInto");

    let mut doc_ex = create_doc_with_table();
    let res_ex = doc_ex
        .split_table_cell_into_ex(
            r#"{"sectionIdx":0,"parentParaIdx":0,"controlIdx":0,"row":0,"col":0,
                "nRows":2,"mCols":2,"equalRowHeight":true,"mergeFirst":false}"#,
        )
        .expect("splitTableCellIntoEx");
    assert_eq!(res_pos, res_ex, "*Ex 가 positional 과 동일 반환");
}

/// splitTableCellsInRange vs splitTableCellsInRangeEx 동치.
#[test]
fn task1413_split_table_cells_in_range_ex_equivalent() {
    let mut doc_pos = create_doc_with_table();
    let res_pos = doc_pos
        .split_table_cells_in_range(0, 0, 0, 0, 0, 0, 0, 2, 2, true)
        .expect("positional splitTableCellsInRange");

    let mut doc_ex = create_doc_with_table();
    let res_ex = doc_ex
        .split_table_cells_in_range_ex(
            r#"{"sectionIdx":0,"parentParaIdx":0,"controlIdx":0,"startRow":0,"startCol":0,
                "endRow":0,"endCol":0,"nRows":2,"mCols":2,"equalRowHeight":true}"#,
        )
        .expect("splitTableCellsInRangeEx");
    assert_eq!(res_pos, res_ex, "*Ex 가 positional 과 동일 반환");
}

/// insertClickHereFieldInCell vs insertClickHereFieldInCellEx 동치.
#[test]
fn task1413_insert_click_here_field_in_cell_ex_equivalent() {
    let mut doc_pos = create_doc_with_table();
    let res_pos = doc_pos
        .insert_click_here_field_in_cell_api(0, 0, 0, 0, 0, 0, false, "안내", "메모", "이름", true)
        .expect("positional insertClickHereFieldInCell");

    let mut doc_ex = create_doc_with_table();
    let res_ex = doc_ex
        .insert_click_here_field_in_cell_ex(
            r#"{"sectionIdx":0,"parentParaIdx":0,"controlIdx":0,"cellIdx":0,"cellParaIdx":0,
                "charOffset":0,"isTextbox":false,"guide":"안내","memo":"메모","name":"이름","editable":true}"#,
        )
        .expect("insertClickHereFieldInCellEx");
    assert_eq!(res_pos, res_ex, "*Ex 가 positional 과 동일 반환");
}

/// moveVertical vs moveVerticalEx 동치 (본문 — parentParaIdx 생략 = MAX).
#[test]
fn task1413_move_vertical_ex_equivalent() {
    let mut doc_pos = HwpDocument::create_empty();
    doc_pos
        .insert_text_native(0, 0, 0, "첫째 줄\n둘째 줄\n셋째 줄")
        .expect("텍스트 삽입");
    let res_pos = doc_pos
        .move_vertical(0, 0, 2, 1, 10.0, u32::MAX, 0, 0, 0)
        .expect("positional moveVertical");

    let mut doc_ex = HwpDocument::create_empty();
    doc_ex
        .insert_text_native(0, 0, 0, "첫째 줄\n둘째 줄\n셋째 줄")
        .expect("텍스트 삽입");
    let res_ex = doc_ex
        .move_vertical_ex(
            r#"{"sectionIdx":0,"paraIdx":0,"charOffset":2,"delta":1,"preferredX":10.0}"#,
        )
        .expect("moveVerticalEx");
    assert_eq!(
        res_pos, res_ex,
        "*Ex 가 positional 과 동일 반환 (본문 이동)"
    );
}

// ---------- #1413 3단계: 8인자 군 *Ex 동치 ----------

#[test]
fn task1413_set_page_hide_ex_equivalent() {
    let mut doc_pos = HwpDocument::create_empty();
    let res_pos = doc_pos
        .set_page_hide(0, 0, true, false, true, false, true, false)
        .expect("positional setPageHide");
    let mut doc_ex = HwpDocument::create_empty();
    let res_ex = doc_ex
        .set_page_hide_ex(
            r#"{"sec":0,"para":0,"hideHeader":true,"hideFooter":false,"hideMaster":true,
                "hideBorder":false,"hideFill":true,"hidePageNum":false}"#,
        )
        .expect("setPageHideEx");
    assert_eq!(res_pos, res_ex);
}

#[test]
fn task1413_set_char_shape_id_in_cell_ex_equivalent() {
    // char_shape_id=0 이 유효하려면 char_shapes 가 최소 1개 등록돼 있어야 한다
    // (없으면 native 가 "범위 초과" Err → wasm JsValue 변환 패닉). 정상 입력으로 비교.
    let mut doc_pos = create_doc_with_table();
    doc_pos
        .document
        .doc_info
        .char_shapes
        .push(crate::model::style::CharShape::default());
    let res_pos = doc_pos.set_char_shape_id_in_cell(0, 0, 0, 0, 0, 0, 0, 0);
    let mut doc_ex = create_doc_with_table();
    doc_ex
        .document
        .doc_info
        .char_shapes
        .push(crate::model::style::CharShape::default());
    let res_ex = doc_ex.set_char_shape_id_in_cell_ex(
        r#"{"secIdx":0,"parentParaIdx":0,"controlIdx":0,"cellIdx":0,"cellParaIdx":0,
            "startOffset":0,"endOffset":0,"charShapeId":0}"#,
    );
    assert_eq!(format!("{res_pos:?}"), format!("{res_ex:?}"));
}

#[test]
fn task1413_get_selection_rects_in_cell_ex_equivalent() {
    let doc = create_doc_with_table();
    let res_pos = doc.get_selection_rects_in_cell(0, 0, 0, 0, 0, 0, 0, 0, None);
    let res_ex = doc.get_selection_rects_in_cell_ex(
        r#"{"sectionIdx":0,"parentParaIdx":0,"controlIdx":0,"cellIdx":0,"startCellParaIdx":0,
            "startCharOffset":0,"endCellParaIdx":0,"endCharOffset":0}"#,
    );
    assert_eq!(format!("{res_pos:?}"), format!("{res_ex:?}"));
}

#[test]
fn task1413_export_selection_in_cell_html_ex_equivalent() {
    let doc = create_doc_with_table();
    let res_pos = doc.export_selection_in_cell_html(0, 0, 0, 0, 0, 0, 0, 0);
    let res_ex = doc.export_selection_in_cell_html_ex(
        r#"{"sectionIdx":0,"parentParaIdx":0,"controlIdx":0,"cellIdx":0,"startCellParaIdx":0,
            "startCharOffset":0,"endCellParaIdx":0,"endCharOffset":0}"#,
    );
    assert_eq!(format!("{res_pos:?}"), format!("{res_ex:?}"));
}

#[test]
fn task1413_delete_range_in_cell_ex_equivalent() {
    let mut doc_pos = create_doc_with_table();
    let res_pos = doc_pos.delete_range_in_cell(0, 0, 0, 0, 0, 0, 0, 0);
    let mut doc_ex = create_doc_with_table();
    let res_ex = doc_ex.delete_range_in_cell_ex(
        r#"{"sectionIdx":0,"parentParaIdx":0,"controlIdx":0,"cellIdx":0,"startCellParaIdx":0,
            "startCharOffset":0,"endCellParaIdx":0,"endCharOffset":0}"#,
    );
    assert_eq!(format!("{res_pos:?}"), format!("{res_ex:?}"));
}

#[test]
fn task1413_copy_selection_in_cell_ex_equivalent() {
    let mut doc_pos = create_doc_with_table();
    let res_pos = doc_pos.copy_selection_in_cell(0, 0, 0, 0, 0, 0, 0, 0);
    let mut doc_ex = create_doc_with_table();
    let res_ex = doc_ex.copy_selection_in_cell_ex(
        r#"{"sectionIdx":0,"parentParaIdx":0,"controlIdx":0,"cellIdx":0,"startCellParaIdx":0,
            "startCharOffset":0,"endCellParaIdx":0,"endCharOffset":0}"#,
    );
    assert_eq!(format!("{res_pos:?}"), format!("{res_ex:?}"));
}

#[test]
fn task1413_apply_char_format_in_cell_ex_equivalent() {
    let props = r#"{"bold":true}"#;
    let mut doc_pos = create_doc_with_table();
    let res_pos = doc_pos.apply_char_format_in_cell(0, 0, 0, 0, 0, 0, 0, props);
    let mut doc_ex = create_doc_with_table();
    let res_ex = doc_ex.apply_char_format_in_cell_ex(
        r#"{"secIdx":0,"parentParaIdx":0,"controlIdx":0,"cellIdx":0,"cellParaIdx":0,
            "startOffset":0,"endOffset":0,"props":{"bold":true}}"#,
    );
    assert_eq!(format!("{res_pos:?}"), format!("{res_ex:?}"));
}

#[test]
fn task1413_insert_click_here_field_by_path_ex_equivalent() {
    // 유효 cell path(표 para 0, control 0, cell 0)로 셀 안에 삽입. positional 과 *Ex 동치.
    // (빈 path 는 native 에서 에러 → wasm JsValue 변환 패닉이라 정상 path 를 쓴다.)
    let path = r#"[{"controlIndex":0,"cellIndex":0,"cellParaIndex":0}]"#;
    let mut doc_pos = create_doc_with_table();
    let res_pos =
        doc_pos.insert_click_here_field_by_path_api(0, 0, path, 0, "안내", "메모", "이름", true);
    let mut doc_ex = create_doc_with_table();
    let res_ex = doc_ex.insert_click_here_field_by_path_ex(
        r#"{"sectionIdx":0,"parentParaIdx":0,"path":"[{\"controlIndex\":0,\"cellIndex\":0,\"cellParaIndex\":0}]","charOffset":0,"guide":"안내","memo":"메모","name":"이름","editable":true}"#,
    );
    assert_eq!(format!("{res_pos:?}"), format!("{res_ex:?}"));
}

// ---------- #1413 4단계: 7인자 군 *Ex 동치 (13개) ----------

// 표 셀(para0/control0/cell0)에 정상 동작하는 *InCell 류. 반환 동일성 비교.
#[test]
fn task1413_insert_text_in_cell_ex_equivalent() {
    let mut a = create_doc_with_table();
    let rp = a.insert_text_in_cell(0, 0, 0, 0, 0, 0, "텍스트", None);
    let mut b = create_doc_with_table();
    let re = b.insert_text_in_cell_ex(
        r#"{"sectionIdx":0,"parentParaIdx":0,"controlIdx":0,"cellIdx":0,"cellParaIdx":0,"charOffset":0,"text":"텍스트"}"#,
    );
    assert_eq!(format!("{rp:?}"), format!("{re:?}"));
}

#[test]
fn task1413_get_text_in_cell_ex_equivalent() {
    let a = create_doc_with_table();
    let rp = a.get_text_in_cell(0, 0, 0, 0, 0, 0, 1, None);
    let re = a.get_text_in_cell_ex(
        r#"{"sectionIdx":0,"parentParaIdx":0,"controlIdx":0,"cellIdx":0,"cellParaIdx":0,"charOffset":0,"count":1}"#,
    );
    assert_eq!(format!("{rp:?}"), format!("{re:?}"));
}

#[test]
fn task1413_delete_text_in_cell_ex_equivalent() {
    let mut a = create_doc_with_table();
    let rp = a.delete_text_in_cell(0, 0, 0, 0, 0, 0, 1, None);
    let mut b = create_doc_with_table();
    let re = b.delete_text_in_cell_ex(
        r#"{"sectionIdx":0,"parentParaIdx":0,"controlIdx":0,"cellIdx":0,"cellParaIdx":0,"charOffset":0,"count":1}"#,
    );
    assert_eq!(format!("{rp:?}"), format!("{re:?}"));
}

#[test]
fn task1413_paste_html_in_cell_ex_equivalent() {
    let mut a = create_doc_with_table();
    let rp = a.paste_html_in_cell(0, 0, 0, 0, 0, 0, "<p>x</p>");
    let mut b = create_doc_with_table();
    let re = b.paste_html_in_cell_ex(
        r#"{"sectionIdx":0,"parentParaIdx":0,"controlIdx":0,"cellIdx":0,"cellParaIdx":0,"charOffset":0,"html":"<p>x</p>"}"#,
    );
    assert_eq!(format!("{rp:?}"), format!("{re:?}"));
}

#[test]
fn task1413_merge_table_cells_ex_equivalent() {
    let mut a = create_doc_with_table();
    let rp = a.merge_table_cells(0, 0, 0, 0, 0, 0, 1);
    let mut b = create_doc_with_table();
    let re = b.merge_table_cells_ex(
        r#"{"sectionIdx":0,"parentParaIdx":0,"controlIdx":0,"startRow":0,"startCol":0,"endRow":0,"endCol":1}"#,
    );
    assert_eq!(format!("{rp:?}"), format!("{re:?}"));
}

#[test]
fn task1413_insert_click_here_field_ex_equivalent() {
    let mut a = HwpDocument::create_empty();
    a.insert_text_native(0, 0, 0, "abc").unwrap();
    let rp = a.insert_click_here_field_api(0, 0, 0, "안내", "메모", "이름", true);
    let mut b = HwpDocument::create_empty();
    b.insert_text_native(0, 0, 0, "abc").unwrap();
    let re = b.insert_click_here_field_ex(
        r#"{"sectionIdx":0,"paraIdx":0,"charOffset":0,"guide":"안내","memo":"메모","name":"이름","editable":true}"#,
    );
    assert_eq!(format!("{rp:?}"), format!("{re:?}"));
}

// bool/String 반환 (JsValue 변환 없음 — 패닉 무관).
#[test]
fn task1413_set_active_field_in_cell_ex_equivalent() {
    let mut a = create_doc_with_table();
    let rp = a.set_active_field_in_cell_api(0, 0, 0, 0, 0, 0, false);
    let mut b = create_doc_with_table();
    let re = b.set_active_field_in_cell_ex(
        r#"{"sectionIdx":0,"parentParaIdx":0,"controlIdx":0,"cellIdx":0,"cellParaIdx":0,"charOffset":0,"isTextbox":false}"#,
    );
    assert_eq!(rp, re);
}

#[test]
fn task1413_get_field_info_at_in_cell_ex_equivalent() {
    let a = create_doc_with_table();
    let rp = a.get_field_info_at_in_cell_api(0, 0, 0, 0, 0, 0, false);
    let re = a.get_field_info_at_in_cell_ex(
        r#"{"sectionIdx":0,"parentParaIdx":0,"controlIdx":0,"cellIdx":0,"cellParaIdx":0,"charOffset":0,"isTextbox":false}"#,
    );
    assert_eq!(rp, re);
}

#[test]
fn task1413_remove_field_at_in_cell_ex_equivalent() {
    let mut a = create_doc_with_table();
    let rp = a.remove_field_at_in_cell_api(0, 0, 0, 0, 0, 0, false);
    let mut b = create_doc_with_table();
    let re = b.remove_field_at_in_cell_ex(
        r#"{"sectionIdx":0,"parentParaIdx":0,"controlIdx":0,"cellIdx":0,"cellParaIdx":0,"charOffset":0,"isTextbox":false}"#,
    );
    assert_eq!(rp, re);
}

#[test]
fn task1413_evaluate_table_formula_ex_equivalent() {
    let mut a = create_doc_with_table();
    let rp = a.evaluate_table_formula(0, 0, 0, 0, 0, "=1+1", false);
    let mut b = create_doc_with_table();
    let re = b.evaluate_table_formula_ex(
        r#"{"sectionIdx":0,"parentParaIdx":0,"controlIdx":0,"targetRow":0,"targetCol":0,"formula":"=1+1","writeResult":false}"#,
    );
    assert_eq!(format!("{rp:?}"), format!("{re:?}"));
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Issue2214TargetCut {
    page_index: u32,
    start_row: usize,
    end_row: usize,
    is_continuation: bool,
    start_cut: Vec<usize>,
    end_cut: Vec<usize>,
    is_block_split: bool,
}

fn issue2214_target_cuts(doc: &HwpDocument) -> Vec<Issue2214TargetCut> {
    use crate::renderer::pagination::PageItem;

    let pages = doc
        .core
        .pagination
        .iter()
        .flat_map(|section| section.pages.iter())
        .collect::<Vec<_>>();
    assert_eq!(
        pages.len(),
        doc.page_count() as usize,
        "pagination page coverage"
    );
    pages
        .into_iter()
        .enumerate()
        .map(|(global_page, page)| {
            assert_eq!(page.section_index, 0, "#2214 target section");
            assert_eq!(
                page.page_index as usize, global_page,
                "#2214 global page index"
            );
            let matches = page
                .column_contents
                .iter()
                .flat_map(|column| column.items.iter())
                .filter_map(|item| match item {
                    PageItem::PartialTable {
                        para_index: 0,
                        control_index: 2,
                        start_row,
                        end_row,
                        is_continuation,
                        start_cut,
                        end_cut,
                        is_block_split,
                        ..
                    } => Some(Issue2214TargetCut {
                        page_index: page.page_index,
                        start_row: *start_row,
                        end_row: *end_row,
                        is_continuation: *is_continuation,
                        start_cut: start_cut.clone(),
                        end_cut: end_cut.clone(),
                        is_block_split: *is_block_split,
                    }),
                    _ => None,
                })
                .collect::<Vec<_>>();
            assert_eq!(
                matches.len(),
                1,
                "page {global_page}: exactly one target PartialTable fragment"
            );
            matches.into_iter().next().expect("one target fragment")
        })
        .collect()
}

fn issue2214_assert_cut_continuity(label: &str, state: &str, cuts: &[Issue2214TargetCut]) {
    assert_eq!(cuts.len(), 115, "{label} {state}: target page coverage");
    assert!(!cuts[0].is_continuation, "{label} {state}: first fragment");
    assert!(
        cuts[0].start_cut.is_empty(),
        "{label} {state}: first fragment starts at row origin"
    );
    assert!(
        cuts.last().expect("last target cut").end_cut.is_empty(),
        "{label} {state}: final fragment consumes the target table"
    );
    assert!(
        cuts.iter().all(|cut| !cut.is_block_split),
        "{label} {state}: #2214 fixture must remain a non-block split chain"
    );
    for cut in cuts {
        assert!(
            cut.start_row < cut.end_row,
            "{label} {state}: page {} row range must advance",
            cut.page_index
        );
        if cut.start_row + 1 == cut.end_row && !cut.start_cut.is_empty() && !cut.end_cut.is_empty()
        {
            assert_eq!(
                cut.start_cut.len(),
                cut.end_cut.len(),
                "{label} {state}: page {} cut arity",
                cut.page_index
            );
            assert!(
                cut.start_cut
                    .iter()
                    .zip(&cut.end_cut)
                    .all(|(start, end)| end >= start),
                "{label} {state}: page {} cut components must not rewind",
                cut.page_index
            );
            assert!(
                cut.start_cut
                    .iter()
                    .zip(&cut.end_cut)
                    .any(|(start, end)| end > start),
                "{label} {state}: page {} cut must consume at least one unit",
                cut.page_index
            );
        }
    }
    for (page, pair) in cuts.windows(2).enumerate() {
        assert!(
            pair[1].is_continuation,
            "{label} {state}: page {} must be a continuation",
            page + 1
        );
        if pair[0].end_cut.is_empty() {
            assert!(
                pair[1].start_cut.is_empty(),
                "{label} {state}: page {} row boundary must restart without a cut",
                page + 1
            );
            assert_eq!(
                pair[1].start_row,
                pair[0].end_row,
                "{label} {state}: page {} row boundary must be contiguous",
                page + 1
            );
        } else {
            assert_eq!(
                pair[0].end_cut,
                pair[1].start_cut,
                "{label} {state}: page {} end_cut must equal page {} start_cut",
                page,
                page + 1
            );
            assert_eq!(
                pair[1].start_row,
                pair[0].end_row - 1,
                "{label} {state}: page {} split row must continue",
                page + 1
            );
        }
    }
}

/// #2214 Stage 3: scoped cache coherence는 deferred pagination geometry를 유지하면서
/// warm tree/cursor만 최신 edit으로 복구하고, explicit flush에서만 cut/bounds를 갱신한다.
#[test]
fn issue2214_scoped_cache_coherence_preserves_transient_pagination() {
    use crate::renderer::render_tree::{RenderNode, RenderNodeType};

    fn target_tree_ranges(doc: &HwpDocument) -> Vec<(u32, usize, usize)> {
        fn visit(node: &RenderNode, page: u32, ranges: &mut Vec<(u32, usize, usize)>) {
            if let RenderNodeType::TextRun(run) = &node.node_type {
                if let (Some(start), Some(ctx)) = (run.char_start, run.cell_context.as_ref()) {
                    let target = ctx.parent_para_index == 0
                        && ctx.path.len() == 1
                        && ctx.path.first().is_some_and(|entry| {
                            entry.control_index == 2
                                && entry.cell_index == 2
                                && entry.cell_para_index == 5
                        });
                    if target {
                        assert!(run.char_overlap.is_none(), "target run must not overlap");
                        assert_eq!(
                            run.text.chars().count(),
                            run.text.encode_utf16().count(),
                            "fixture target run must be BMP"
                        );
                        let end = start + run.text.encode_utf16().count();
                        assert!(end > start, "target run must advance");
                        ranges.push((page, start, end));
                    }
                }
            }
            for child in &node.children {
                visit(child, page, ranges);
            }
        }

        let page = 0;
        let tree = doc
            .build_page_render_tree(page)
            .unwrap_or_else(|e| panic!("page {page} tree: {e}"));
        let mut ranges = Vec::new();
        visit(&tree.root, page, &mut ranges);
        ranges.sort_unstable_by_key(|(_, start, end)| (*start, *end));
        assert!(!ranges.is_empty(), "target paragraph ranges");
        let mut contiguous_end = 0;
        for (page, start, end) in &ranges {
            assert_eq!(
                *start, contiguous_end,
                "page {page}: target UTF-16 ranges must have no gap or overlap"
            );
            contiguous_end = *end;
        }
        ranges
    }

    for (label, relative) in [
        ("hwp", "samples/issue1949_giant_cell_nested_tables_perf.hwp"),
        (
            "hwpx",
            "samples/issue1949_giant_cell_nested_tables_perf.hwpx",
        ),
    ] {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(relative);
        let bytes = std::fs::read(path).expect("read #2214 fixture");
        let mut doc = HwpDocument::from_bytes(&bytes).expect("load #2214 fixture");

        // 실제 Studio처럼 편집 전에 페이지 트리/셀 유닛을 warm한다.
        let initial_ranges = target_tree_ranges(&doc);
        assert_eq!(
            initial_ranges.last().map(|(_, _, end)| *end),
            Some(130),
            "{label}: initial max char"
        );
        doc.get_cursor_rect_in_cell_native(0, 0, 2, 2, 5, 130)
            .expect("warm target cursor");
        let initial_cuts = issue2214_target_cuts(&doc);
        issue2214_assert_cut_continuity(label, "initial", &initial_cuts);

        // #2195 이후에도 44번째 입력은 target paragraph의 상대 flow advance를 바꾼다.
        // flush 전 pagination 조각은 그대로 두고, flush 에서만 cut/bounds 가 갱신된다.
        // render_normalized warm tree는 flush 전에도 매 mutation을 즉시 반영해야 한다.
        // [#2430] HY/한양 ASCII 실측 교정으로 숫자 advance 가 0.625→0.497em 으로
        // 좁아져 줄 채움 임계가 44→56→55 입력으로 이동 (probe 실측, hwp/hwpx 동일).
        for inserted in 0..55 {
            let raw = doc
                .insert_text_in_cell_native_deferred_pagination(0, 0, 2, 2, 5, 130 + inserted, "1")
                .expect("deferred sequential insert");
            let result: Value = serde_json::from_str(&raw).expect("edit result json");
            assert_eq!(
                result["cellFlowChanged"].as_bool(),
                Some(inserted == 54),
                "{label}: input {} flow signal",
                inserted + 1
            );
        }
        let transient_cuts = issue2214_target_cuts(&doc);
        issue2214_assert_cut_continuity(label, "transient", &transient_cuts);
        let transient_cut = transient_cuts[0].clone();
        let transient_ranges = target_tree_ranges(&doc);
        let transient_max = transient_ranges
            .last()
            .map(|(_, _, end)| *end)
            .expect("transient target end");
        let transient_rect = doc
            .get_cursor_rect_in_cell_native(0, 0, 2, 2, 5, 185)
            .expect("transient direct rect");

        doc.flush_deferred_pagination()
            .expect("explicit pagination control");
        let flushed_cuts = issue2214_target_cuts(&doc);
        issue2214_assert_cut_continuity(label, "full-flush", &flushed_cuts);
        let flushed_cut = flushed_cuts[0].clone();
        let flushed_ranges = target_tree_ranges(&doc);
        let flushed_max = flushed_ranges
            .last()
            .map(|(_, _, end)| *end)
            .expect("flushed target end");
        let flushed_rect = doc
            .get_cursor_rect_in_cell_native(0, 0, 2, 2, 5, 185)
            .expect("flushed direct rect");

        eprintln!(
            "#2214 {label}: transient max={transient_max} rect={transient_rect}; flushed max={flushed_max} rect={flushed_rect}; cuts transient={transient_cut:?} flushed={flushed_cut:?}"
        );

        assert_eq!(transient_max, 185, "{label}: scoped warm tree coherence");
        assert_eq!(flushed_max, 185, "{label}: flush oracle");
        assert_eq!(
            transient_ranges, flushed_ranges,
            "{label}: transient target UTF-16 ranges must equal flush oracle"
        );
        assert_eq!(
            initial_cuts, transient_cuts,
            "{label}: scoped eviction must not change pagination fragments"
        );
        assert_eq!(transient_cut.start_cut, Vec::<usize>::new());
        assert_eq!(
            transient_cut.end_cut,
            vec![37],
            "{label}: transient page-zero cut"
        );
        // 첫 쪽 조각은 저장 쪽 경계(vpos 리셋) 직전 줄에서 끝나므로 그 줄 간격이
        // 조각 높이에서 빠진다. 그 여유에 추가된 한 줄이 들어가 flush 후 첫 쪽이
        // 한 유닛을 더 담는다.
        assert_eq!(flushed_cut.start_cut, Vec::<usize>::new());
        assert_eq!(
            flushed_cut.end_cut,
            vec![38],
            "{label}: flushed page-zero cut"
        );
        let changed_pages = transient_cuts
            .iter()
            .zip(&flushed_cuts)
            .enumerate()
            .filter_map(|(page, (transient, flushed))| (transient != flushed).then_some(page))
            .collect::<Vec<_>>();
        eprintln!(
            "#2214 {label}: PartialTable fragments={} changed_after_flush_count={}",
            transient_cuts.len(),
            changed_pages.len(),
        );
        assert_eq!(
            transient_cuts.len(),
            flushed_cuts.len(),
            "{label}: page fingerprint count"
        );
        assert_eq!(
            changed_pages,
            (0..doc.page_count() as usize).collect::<Vec<_>>(),
            "{label}: flush must realign every fragment after the grown first page"
        );
        let transient_rect_json: Value =
            serde_json::from_str(&transient_rect).expect("transient rect json");
        let flushed_rect_json: Value =
            serde_json::from_str(&flushed_rect).expect("flushed rect json");
        for key in ["pageIndex", "x", "height", "cellOverflowed"] {
            assert_eq!(
                transient_rect_json.get(key),
                flushed_rect_json.get(key),
                "{label}: transient cursor field {key} must equal flush oracle"
            );
        }
        let transient_bounds_h = transient_rect_json["cellBounds"]["h"]
            .as_f64()
            .expect("transient bounds h");
        let flushed_bounds_h = flushed_rect_json["cellBounds"]["h"]
            .as_f64()
            .expect("flushed bounds h");
        // 잘린 셀 조각도 셀 세로 정렬(가운데)을 따르므로, flush 가 조각 높이를 바꾸면
        // 커서 y 는 그 변화의 절반 안에서만 움직일 수 있다.
        let dy = (transient_rect_json["y"].as_f64().expect("transient y")
            - flushed_rect_json["y"].as_f64().expect("flushed y"))
        .abs();
        assert!(
            dy <= (flushed_bounds_h - transient_bounds_h).abs() / 2.0 + 0.5,
            "{label}: transient cursor y moved {dy} beyond the fragment re-centering"
        );
        assert!(
            (transient_bounds_h - 947.8).abs() <= 0.2,
            "{label}: transient bounds h={transient_bounds_h}"
        );
        assert!(
            (flushed_bounds_h - 963.8).abs() <= 0.2,
            "{label}: flushed bounds h={flushed_bounds_h}"
        );
        assert_eq!(doc.page_count(), 115, "{label}: page count");
    }
}

/// #2424 Stage D: 공개 pagination을 유지한 채 한 호출당 한 fragment만 전진하고,
/// 마지막 step에서만 full-pagination oracle과 같은 cut chain을 원자적으로 commit한다.
#[test]
fn issue2424_resumable_pagination_commits_only_after_final_fragment() {
    for (label, relative) in [
        ("hwp", "samples/issue1949_giant_cell_nested_tables_perf.hwp"),
        (
            "hwpx",
            "samples/issue1949_giant_cell_nested_tables_perf.hwpx",
        ),
    ] {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(relative);
        let bytes = std::fs::read(path).expect("read #2424 fixture");
        let mut doc = HwpDocument::from_bytes(&bytes).expect("load #2424 fixture");

        for inserted in 0..55 {
            doc.insert_text_in_cell_native_deferred_pagination(0, 0, 2, 2, 5, 130 + inserted, "1")
                .expect("deferred sequential insert");
        }
        let transient_cuts = issue2214_target_cuts(&doc);
        issue2214_assert_cut_continuity(label, "resumable-transient", &transient_cuts);

        let begin: Value = serde_json::from_str(
            &doc.begin_deferred_pagination(1)
                .expect("begin resumable pagination"),
        )
        .expect("begin result json");
        assert_eq!(begin["status"], "pending", "{label}: begin status");
        assert_eq!(
            issue2214_target_cuts(&doc),
            transient_cuts,
            "{label}: begin must not publish shadow pages"
        );

        let mut step_calls = 0usize;
        let mut fragments_processed = 0usize;
        loop {
            let step: Value = serde_json::from_str(
                &doc.step_deferred_pagination(1)
                    .expect("step resumable pagination"),
            )
            .expect("step result json");
            step_calls += 1;
            fragments_processed +=
                step["fragmentsProcessed"].as_u64().expect("fragment count") as usize;
            match step["status"].as_str() {
                Some("pending") => assert_eq!(
                    issue2214_target_cuts(&doc),
                    transient_cuts,
                    "{label}: step {step_calls} published an incomplete shadow result"
                ),
                Some("complete") => break,
                other => panic!("{label}: unexpected step status {other:?}: {step}"),
            }
        }

        assert_eq!(step_calls, 115, "{label}: one macrotask per fragment");
        assert_eq!(
            fragments_processed, 115,
            "{label}: every target fragment processed exactly once"
        );
        let committed_cuts = issue2214_target_cuts(&doc);
        issue2214_assert_cut_continuity(label, "resumable-committed", &committed_cuts);
        assert_eq!(
            transient_cuts
                .iter()
                .zip(&committed_cuts)
                .filter(|(before, after)| before != after)
                .count(),
            115,
            "{label}: committed cut chain must match the full-pagination oracle"
        );
    }
}

/// #2424 리뷰 보정: line 5→4가 되는 삭제도 incomplete shadow cut을 게시하지 않고,
/// 마지막 step에서 full-pagination oracle과 같은 continuation chain으로 돌아가야 한다.
#[test]
fn issue2424_resumable_delete_commits_only_after_final_fragment() {
    for (label, relative) in [
        ("hwp", "samples/issue1949_giant_cell_nested_tables_perf.hwp"),
        (
            "hwpx",
            "samples/issue1949_giant_cell_nested_tables_perf.hwpx",
        ),
    ] {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(relative);
        let bytes = std::fs::read(path).expect("read #2424 fixture");
        let mut doc = HwpDocument::from_bytes(&bytes).expect("load #2424 fixture");
        doc.insert_text_in_cell_native_deferred_pagination(0, 0, 2, 2, 5, 130, &"1".repeat(55))
            .expect("prepare fifth cell line");
        doc.flush_deferred_pagination()
            .expect("commit expanded pagination");
        let expanded_cuts = issue2214_target_cuts(&doc);

        let delete_raw = doc
            .delete_text_in_cell_native_deferred_pagination(0, 0, 2, 2, 5, 184, 1)
            .expect("deferred line-shrinking delete");
        let delete: Value = serde_json::from_str(&delete_raw).expect("delete result");
        assert_eq!(
            delete["cellFlowChanged"], true,
            "{label}: delete must remove the fifth line"
        );
        let transient_cuts = issue2214_target_cuts(&doc);
        issue2214_assert_cut_continuity(label, "delete-transient", &transient_cuts);

        let begin: Value = serde_json::from_str(
            &doc.begin_deferred_pagination(1)
                .expect("begin delete pagination"),
        )
        .expect("begin delete json");
        assert_eq!(begin["status"], "pending", "{label}: delete begin");
        assert_eq!(
            issue2214_target_cuts(&doc),
            transient_cuts,
            "{label}: delete begin must not publish shadow pages"
        );

        let mut step_calls = 0usize;
        loop {
            let step: Value = serde_json::from_str(
                &doc.step_deferred_pagination(1)
                    .expect("step delete pagination"),
            )
            .expect("step delete json");
            step_calls += 1;
            match step["status"].as_str() {
                Some("pending") => assert_eq!(
                    issue2214_target_cuts(&doc),
                    transient_cuts,
                    "{label}: delete step {step_calls} published incomplete cuts"
                ),
                Some("complete") => break,
                other => panic!("{label}: unexpected delete step {other:?}: {step}"),
            }
        }
        assert_eq!(step_calls, 115, "{label}: delete fragment steps");
        let committed_cuts = issue2214_target_cuts(&doc);
        issue2214_assert_cut_continuity(label, "delete-committed", &committed_cuts);

        let mut oracle = HwpDocument::from_bytes(&bytes).expect("load delete oracle");
        oracle
            .insert_text_in_cell_native(0, 0, 2, 2, 5, 130, &"1".repeat(54))
            .expect("full-pagination delete oracle state");
        assert_eq!(
            committed_cuts,
            issue2214_target_cuts(&oracle),
            "{label}: resumable delete must match full pagination"
        );
        assert_ne!(
            committed_cuts, expanded_cuts,
            "{label}: deleting the boundary character must change downstream cuts"
        );
    }
}

#[test]
fn issue2424_new_edit_stales_old_job_and_sync_flush_restarts_latest_revision() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("samples/issue1949_giant_cell_nested_tables_perf.hwp");
    let bytes = std::fs::read(path).expect("read #2424 fixture");
    let mut doc = HwpDocument::from_bytes(&bytes).expect("load #2424 fixture");
    for inserted in 0..55 {
        doc.insert_text_in_cell_native_deferred_pagination(0, 0, 2, 2, 5, 130 + inserted, "1")
            .expect("deferred sequential insert");
    }

    let begin: Value = serde_json::from_str(
        &doc.begin_deferred_pagination(1)
            .expect("begin first revision"),
    )
    .expect("begin json");
    assert_eq!(begin["status"], "pending");
    let first_revision = begin["revision"].as_u64().expect("first revision");
    let first_step: Value = serde_json::from_str(
        &doc.step_deferred_pagination(1)
            .expect("step first revision"),
    )
    .expect("step json");
    assert_eq!(first_step["status"], "pending");

    doc.insert_text_in_cell_native_deferred_pagination(0, 0, 2, 2, 5, 185, "1")
        .expect("new edit supersedes first revision");
    let stale: Value = serde_json::from_str(
        &doc.step_deferred_pagination(1)
            .expect("reject stale first revision"),
    )
    .expect("stale json");
    assert_eq!(stale["status"], "stale");
    assert_eq!(stale["revision"].as_u64(), Some(first_revision));

    let replacement: Value = serde_json::from_str(
        &doc.begin_deferred_pagination(1)
            .expect("begin replacement revision"),
    )
    .expect("replacement json");
    assert_eq!(replacement["status"], "pending");
    assert!(
        replacement["revision"]
            .as_u64()
            .expect("replacement revision")
            > first_revision,
        "latest edit must own a newer job revision"
    );
    assert!(doc.cancel_deferred_pagination());
    assert!(!doc.cancel_deferred_pagination());

    let flushed: Value = serde_json::from_str(
        &doc.flush_deferred_pagination()
            .expect("sync barrier restarts latest revision"),
    )
    .expect("flush json");
    assert_eq!(flushed["status"], "complete");
    assert_eq!(flushed["pageCount"], 115);
    issue2214_assert_cut_continuity("hwp", "replacement-flushed", &issue2214_target_cuts(&doc));
}

#[test]
fn update_style_dirties_docinfo_for_hwp5_save() {
    use crate::model::style::Style;
    let mut doc = HwpDocument::create_empty();
    if doc.document.doc_info.styles.is_empty() {
        doc.document.doc_info.styles.push(Style::default());
    }
    doc.document.doc_info.styles.push(Style {
        local_name: "OLD".to_string(),
        ..Default::default()
    });
    let sid = (doc.document.doc_info.styles.len() - 1) as u32;
    // parsed 문서처럼 DocInfo 원본 스트림을 채운다(clean 상태): 무효화가 없으면 저장이 원본 반환.
    doc.document.doc_info.raw_stream = Some(vec![0xAB; 64]);
    doc.document.doc_info.raw_stream_dirty = false;

    assert!(doc.update_style(sid, r#"{"name":"NEW"}"#));

    assert!(
        doc.document.doc_info.raw_stream_dirty,
        "update_style 후 raw_stream_dirty=true 여야 이름 변경이 .hwp 저장에 반영된다"
    );
    let bytes = crate::serializer::doc_info::serialize_doc_info(
        &doc.document.doc_info,
        &doc.document.doc_properties,
    );
    assert_ne!(
        bytes,
        vec![0xAB; 64],
        "serialize_doc_info 가 여전히 원본 스트림을 반환"
    );
}

#[test]
fn delete_style_invalidates_docinfo_and_sections() {
    use crate::model::style::Style;
    let mut doc = HwpDocument::create_empty();
    if doc.document.doc_info.styles.is_empty() {
        doc.document.doc_info.styles.push(Style::default());
    }
    doc.document.doc_info.styles.push(Style::default());
    let sid = (doc.document.doc_info.styles.len() - 1) as u32;
    doc.document.sections[0].paragraphs[0].style_id = sid as u8;
    doc.document.doc_info.raw_stream = Some(vec![0xAB; 64]);
    doc.document.doc_info.raw_stream_dirty = false;
    doc.document.sections[0].raw_stream = Some(vec![0xCD; 64]);

    assert!(doc.delete_style(sid));

    assert!(
        doc.document.doc_info.raw_stream_dirty,
        "delete_style 후 DocInfo raw_stream_dirty=true 여야 한다"
    );
    assert!(
        doc.document.sections[0].raw_stream.is_none(),
        "문단 style_id 재배정이 반영되도록 섹션 raw_stream 이 무효화돼야 한다"
    );
}

/// [#2557] 스타일 이름에 역슬래시/개행/탭이 있어도 방출 JSON 이 파싱 가능해야 한다.
///
/// 종전엔 큰따옴표만 이스케이프해 깨진 JSON 이 나왔고, TS 측은 가드 없이
/// JSON.parse 하므로(wasm-bridge.ts:1957, :2025) 예외가 났다. getStyleAt 은 커서
/// 이동마다 호출되어 해당 문서에서 키 입력마다 편집기가 멈춘다.
#[test]
fn style_json_survives_backslash_and_control_chars() {
    let mut doc = HwpDocument::create_empty();
    {
        let styles = &mut doc.core.document.doc_info.styles;
        if styles.is_empty() {
            styles.push(crate::model::style::Style::default());
        }
        styles[0].local_name = "a\\b\nc\td\"e".to_string();
        styles[0].english_name = "x\\y\nz".to_string();
    }

    let list = doc.get_style_list();
    let parsed: Value = serde_json::from_str(&list)
        .expect("스타일 이름에 역슬래시/개행이 있어도 유효한 JSON 이어야 함");
    assert_eq!(
        parsed[0]["name"].as_str().unwrap(),
        "a\\b\nc\td\"e",
        "이스케이프 왕복 후 원래 이름이 복원돼야 함"
    );

    let at = doc.get_style_at(0, 0);
    serde_json::from_str::<Value>(&at)
        .expect("getStyleAt 도 유효한 JSON 이어야 함(커서 이동마다 호출됨)");
}

#[test]
fn local_body_replace_exposes_stable_edit_before_full_pagination() {
    use crate::renderer::render_tree::{RenderNode, RenderNodeType};

    fn contains_text(node: &RenderNode, needle: &str) -> bool {
        if let RenderNodeType::TextRun(run) = &node.node_type {
            if run.text.contains(needle) {
                return true;
            }
        }
        node.children
            .iter()
            .any(|child| contains_text(child, needle))
    }

    let mut doc = HwpDocument::create_empty();
    doc.insert_text_native(0, 0, 0, "나")
        .expect("seed non-empty body paragraph");
    doc.build_page_render_tree(0).expect("warm page tree");

    let raw = doc
        .replace_body_text_local_native(0, 0, 1, 0, "가")
        .expect("stable local insert");
    let result: Value = serde_json::from_str(&raw).expect("local result json");

    assert_eq!(result["charOffset"].as_u64(), Some(2));
    assert_eq!(result["documentPaginationPending"].as_bool(), Some(true));
    assert_eq!(result["flowChanged"].as_bool(), Some(false));
    assert_eq!(
        doc.get_text_range_native(0, 0, 0, 2)
            .expect("immediate text"),
        "나가"
    );

    let transient_tree = doc.build_page_render_tree(0).expect("transient page tree");
    assert!(
        contains_text(&transient_tree.root, "가"),
        "warm page tree must expose the local edit before full pagination"
    );

    let deleted_raw = doc
        .replace_body_text_local_native(0, 0, 1, 1, "")
        .expect("stable local delete");
    let deleted: Value = serde_json::from_str(&deleted_raw).expect("delete result json");
    assert_eq!(deleted["charOffset"].as_u64(), Some(1));
    assert_eq!(deleted["documentPaginationPending"].as_bool(), Some(true));
    assert_eq!(deleted["flowChanged"].as_bool(), Some(false));
    assert_eq!(
        doc.get_text_range_native(0, 0, 0, 1).expect("deleted text"),
        "나"
    );
}

#[test]
fn local_body_replace_applies_ime_replacement_as_one_final_state() {
    let mut doc = HwpDocument::create_empty();
    doc.replace_body_text_local_native(0, 0, 0, 0, "ㅎ")
        .expect("initial composition");
    let raw = doc
        .replace_body_text_local_native(0, 0, 0, 1, "하")
        .expect("composition replacement");
    let result: Value = serde_json::from_str(&raw).expect("replace result json");

    assert_eq!(result["charOffset"].as_u64(), Some(1));
    assert_eq!(
        doc.get_text_range_native(0, 0, 0, 1)
            .expect("final composition"),
        "하"
    );
}

#[test]
fn local_body_replace_paginates_immediately_at_flow_boundary() {
    let mut doc = HwpDocument::create_empty();
    let mut boundary = None;

    for offset in 0..512 {
        let raw = doc
            .replace_body_text_local_native(0, 0, offset, 0, "가")
            .expect("sequential local insert");
        let result: Value = serde_json::from_str(&raw).expect("flow result json");
        if result["flowChanged"].as_bool() == Some(true) {
            boundary = Some(result);
            break;
        }
    }

    let result = boundary.expect("a body line-flow boundary within 512 characters");
    assert_eq!(result["documentPaginationPending"].as_bool(), Some(false));
    assert_eq!(result["flowChanged"].as_bool(), Some(true));
    assert_eq!(
        doc.page_count(),
        doc.pagination
            .iter()
            .map(|section| section.pages.len())
            .sum::<usize>() as u32
    );
}

// ─── 문단 분할 의도(ParagraphSplitIntent) 계약 ──────────────────────────
// 에이전트 다줄 삽입의 `\n` 은 한 논리 삽입 안의 줄 경계다. Enter 분할처럼
// 문단 모양을 상속하되, 강제 쪽 나눔(pageBreakBefore)까지 복제하면 줄마다
// 새 쪽이 생긴다. 논리 continuation 은 경계 전용 메타만 벗겨야 한다.

/// Enter 분할: 새 문단이 강제 쪽 나눔을 그대로 상속한다 (기존 동작 유지).
#[test]
fn test_split_user_enter_inherits_page_break_before() {
    let mut doc = HwpDocument::create_empty();
    doc.insert_text_native(0, 0, 0, "머리글 이어지는 본문")
        .unwrap();
    doc.apply_para_format_native(0, 0, r#"{"pageBreakBefore":true}"#)
        .unwrap();

    doc.split_paragraph_native(0, 0, 3, None).unwrap();

    let ps_id = doc.document.sections[0].paragraphs[1].para_shape_id;
    let ps = &doc.document.doc_info.para_shapes[ps_id as usize];
    assert!(
        (ps.attr1 >> 19) & 1 == 1 || (ps.attr2 >> 8) & 1 == 1,
        "Enter 분할 새 문단은 쪽 나눔을 상속해야 한다 (attr1={:#x}, attr2={:#x})",
        ps.attr1,
        ps.attr2
    );
}

/// 논리 continuation 분할: 새 문단에서 강제 쪽 나눔만 벗기고 나머지 서식은 상속한다.
#[test]
fn test_split_logical_clears_page_break_before() {
    let mut doc = HwpDocument::create_empty();
    doc.insert_text_native(0, 0, 0, "머리글 이어지는 본문")
        .unwrap();
    doc.apply_para_format_native(
        0,
        0,
        r#"{"pageBreakBefore":true,"marginLeft":2000,"spacingBefore":600}"#,
    )
    .unwrap();
    let src_ps_id = doc.document.sections[0].paragraphs[0].para_shape_id;
    let src_ps = doc.document.doc_info.para_shapes[src_ps_id as usize].clone();

    doc.split_paragraph_logical_native(0, 0, 3).unwrap();

    let paras = &doc.document.sections[0].paragraphs;
    assert_eq!(paras[0].text, "머리글", "분할 앞 절반 텍스트");
    assert_eq!(paras[1].text, " 이어지는 본문", "분할 뒤 절반 텍스트");

    // 원본 문단의 쪽 나눔은 유지된다
    let kept = &doc.document.doc_info.para_shapes[paras[0].para_shape_id as usize];
    assert!(
        (kept.attr1 >> 19) & 1 == 1 || (kept.attr2 >> 8) & 1 == 1,
        "원본 문단의 쪽 나눔은 유지돼야 한다"
    );

    // continuation 은 두 인코딩 모두에서 쪽 나눔이 해제된다
    let cont = &doc.document.doc_info.para_shapes[paras[1].para_shape_id as usize];
    assert_eq!((cont.attr1 >> 19) & 1, 0, "attr1 bit19 해제");
    assert_eq!((cont.attr2 >> 8) & 1, 0, "attr2 bit8 해제");

    // 쪽 나눔 비트 외의 서식은 원본에서 그대로 상속된다
    assert_eq!(cont.margin_left, src_ps.margin_left, "marginLeft 상속");
    assert_eq!(
        cont.spacing_before, src_ps.spacing_before,
        "spacingBefore 상속"
    );
    assert_eq!(
        cont.attr1 & !(1 << 19),
        src_ps.attr1 & !(1 << 19),
        "attr1 은 bit19 외 동일해야 한다"
    );
    assert_eq!(
        cont.attr2 & !(1 << 8),
        src_ps.attr2 & !(1 << 8),
        "attr2 는 bit8 외 동일해야 한다"
    );

    // 경계 전용 메타도 continuation 에는 없다
    assert_eq!(
        paras[1].column_type,
        crate::model::paragraph::ColumnBreakType::None,
        "단 나눔 미상속"
    );
    assert_eq!(paras[1].raw_break_type, 0, "raw break 미상속");
}

/// 셀 내부 논리 분할도 같은 계약을 따른다.
#[test]
fn test_split_logical_in_cell_clears_page_break_before() {
    use crate::model::control::Control;

    let mut doc = HwpDocument::create_empty();
    doc.insert_text_native(0, 0, 0, "표 앞").unwrap();
    doc.create_table_ex_native(0, 0, 2, 2, 2, true, None, None)
        .unwrap();
    let ctrl_idx = doc.document.sections[0].paragraphs[0]
        .controls
        .iter()
        .position(|c| matches!(c, Control::Table(_)))
        .expect("표 컨트롤");

    doc.insert_text_in_cell_native(0, 0, ctrl_idx, 0, 0, 0, "셀머리 셀본문")
        .unwrap();
    doc.apply_para_format_in_cell_native(0, 0, ctrl_idx, 0, 0, r#"{"pageBreakBefore":true}"#)
        .unwrap();

    doc.split_paragraph_in_cell_logical_native(0, 0, ctrl_idx, 0, 0, 3)
        .unwrap();

    let Control::Table(table) = &doc.document.sections[0].paragraphs[0].controls[ctrl_idx] else {
        panic!("표 컨트롤이어야 한다");
    };
    let cell_paras = &table.cells[0].paragraphs;
    assert_eq!(cell_paras[0].text, "셀머리");
    assert_eq!(cell_paras[1].text, " 셀본문");

    let cont = &doc.document.doc_info.para_shapes[cell_paras[1].para_shape_id as usize];
    assert_eq!(
        (cont.attr1 >> 19) & 1,
        0,
        "셀 continuation attr1 bit19 해제"
    );
    assert_eq!((cont.attr2 >> 8) & 1, 0, "셀 continuation attr2 bit8 해제");
}

/// pageBreakBefore 설정/해제는 HWP(attr1 bit19)·HWPX(attr2 bit8) 인코딩에 함께 반영된다.
#[test]
fn test_page_break_before_mods_update_both_encodings() {
    let mut doc = HwpDocument::create_empty();
    doc.insert_text_native(0, 0, 0, "본문").unwrap();

    doc.apply_para_format_native(0, 0, r#"{"pageBreakBefore":true}"#)
        .unwrap();
    let ps_id = doc.document.sections[0].paragraphs[0].para_shape_id;
    let ps = &doc.document.doc_info.para_shapes[ps_id as usize];
    assert_eq!((ps.attr1 >> 19) & 1, 1, "set: attr1 bit19");
    assert_eq!((ps.attr2 >> 8) & 1, 1, "set: attr2 bit8");

    // HWPX 로 저장해도 쪽 나눔이 살아남아야 한다 (serializer 는 attr2 bit8 을 읽는다)
    let out = doc.export_hwpx_native().expect("HWPX 직렬화");
    let reparsed = HwpDocument::from_bytes(&out).expect("재파싱");
    assert_eq!(
        reparsed.page_count(),
        doc.page_count(),
        "쪽 나눔이 HWPX 저장/재열기에서 보존돼야 한다"
    );

    doc.apply_para_format_native(0, 0, r#"{"pageBreakBefore":false}"#)
        .unwrap();
    let ps_id = doc.document.sections[0].paragraphs[0].para_shape_id;
    let ps = &doc.document.doc_info.para_shapes[ps_id as usize];
    assert_eq!((ps.attr1 >> 19) & 1, 0, "clear: attr1 bit19");
    assert_eq!((ps.attr2 >> 8) & 1, 0, "clear: attr2 bit8");
}

/// [task1750] 논리 다줄 삽입은 새 암묵 쪽/단 리셋(vpos 되감김)을 만들지 않는다.
///
/// 실문서의 vpos 사다리에는 저작된 쪽 경계에서만 되감김이 있다. 삽입으로
/// 되감김 지점이 늘어나면 fresh 문단의 vpos=0 placeholder 가 저장흐름 리셋으로
/// 오인된 것이다 (쪽수 뻥튀기의 신호).
#[test]
fn test_multiline_logical_insert_keeps_vpos_rewind_signature() {
    let bytes = std::fs::read("samples/task1750/split_guard_spacing_before.hwp").unwrap();
    let mut doc = HwpDocument::from_bytes(&bytes).unwrap();
    doc.convert_to_editable_native().unwrap();

    let rewinds = |doc: &HwpDocument| -> usize {
        let paras = &doc.document.sections[0].paragraphs;
        let mut prev: Option<i32> = None;
        let mut count = 0usize;
        for p in paras {
            if let Some(seg) = p.line_segs.first() {
                if let Some(pv) = prev {
                    if seg.vertical_pos < pv {
                        count += 1;
                    }
                }
                prev = Some(seg.vertical_pos);
            }
        }
        count
    };

    let rewinds_before = rewinds(&doc);
    let pages_before = doc.page_count();

    // 문단 5 중간에 에이전트 다줄 삽입 (performInsert 순서)
    doc.insert_text_native(0, 5, 1, "첫줄").unwrap();
    doc.split_paragraph_logical_native(0, 5, 3).unwrap();
    doc.insert_text_native(0, 6, 0, "둘째줄").unwrap();
    doc.split_paragraph_logical_native(0, 6, 3).unwrap();
    doc.insert_text_native(0, 7, 0, "셋째줄").unwrap();

    let rewinds_after = rewinds(&doc);
    assert!(
        rewinds_after <= rewinds_before + 1,
        "삽입 후 vpos 되감김이 늘면 안 된다 (before={rewinds_before}, after={rewinds_after})"
    );
    let pages_after = doc.page_count();
    assert!(
        pages_after as i64 - pages_before as i64 <= 1,
        "쪽수 증가는 1 이내: {pages_before} → {pages_after}"
    );
}
