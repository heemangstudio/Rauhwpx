//! 가져온 표의 저장 할당은 다른 표의 편집 및 cold 재구성으로 바뀌지 않아야 한다.
use rhwp::model::provenance::FontMetricsPolicy;
use rhwp::{document_core::DocumentCore, model::control::Control};
use serde_json::Value;

const NAME_PATH: &[(usize, usize, usize)] = &[(6, 0, 3), (0, 1, 0)];

fn load() -> DocumentCore {
    let bytes = include_bytes!("../../samples/exam_science.hwp");
    DocumentCore::from_local_file_bytes_with_font_metrics(bytes, FontMetricsPolicy::HcrDeclared)
        .unwrap()
}

fn tac_geometry(core: &DocumentCore) -> Value {
    let layout: Value =
        serde_json::from_str(&core.get_page_control_layout_native(0).unwrap()).unwrap();
    Value::Array(
        layout["controls"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|c| c["paraIdx"] == 9 && (c["type"] == "table" || c["type"] == "image"))
            .map(|c| {
                let mut geometry = c.clone();
                geometry.as_object_mut().unwrap().remove("stableIndex");
                geometry
            })
            .collect(),
    )
}

fn name_table(core: &DocumentCore) -> &rhwp::model::table::Table {
    let Control::Table(outer) = &core.document().sections[0].paragraphs[0].controls[6] else {
        panic!("header table")
    };
    let Control::Table(inner) = &outer.cells[0].paragraphs[3].controls[0] else {
        panic!("name table")
    };
    inner
}

fn header_height(core: &DocumentCore) -> f64 {
    let layout: Value =
        serde_json::from_str(&core.get_page_control_layout_native(0).unwrap()).unwrap();
    layout["controls"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["paraIdx"] == 0 && c["controlIdx"] == 6 && c["type"] == "table")
        .unwrap()["h"]
        .as_f64()
        .unwrap()
}

#[test]
fn unrelated_imported_table_keeps_geometry_after_nested_edit_and_cold_rebuild() {
    let mut core = load();
    let initial = tac_geometry(&core);
    // 한컴의 같은 붙여넣기는 TAC 표와 다섯 그림의 사각형을 변경하지 않는다.
    assert!(!initial.as_array().unwrap().is_empty());
    core.insert_text_in_cell_by_path(0, 0, NAME_PATH, 0, "홍길동")
        .unwrap();
    assert_eq!(initial, tac_geometry(&core));
    let mut cold = DocumentCore::new_empty();
    cold.set_document(core.document().clone());
    assert_eq!(initial, tac_geometry(&cold));
}

#[test]
fn nested_growth_marks_stale_saved_allocation_and_survives_reparse() {
    let mut core = load();
    let initial_height = header_height(&core);
    core.insert_text_in_cell_by_path(0, 0, NAME_PATH, 0, "홍민")
        .unwrap();
    assert!(
        !name_table(&core).cells[1].dirty_flag,
        "same-height text keeps authored geometry current"
    );
    core.insert_text_in_cell_by_path(0, 0, NAME_PATH, 2, " ABCDEFGHIJKLMNOPQRSTUVWXYZ")
        .unwrap();
    assert!(
        header_height(&core) > initial_height,
        "nested content must grow past its old declaration"
    );
    assert!(name_table(&core).cells[1].dirty_flag);
    let saved = core.export_hwpx_native().unwrap();
    let reopened = DocumentCore::from_local_file_bytes_with_font_metrics(
        &saved,
        FontMetricsPolicy::HcrDeclared,
    )
    .unwrap();
    assert!(name_table(&reopened).cells[1].dirty_flag);
    assert!(
        header_height(&reopened) > initial_height,
        "saved stale allocation must not clip the wrapped content on reopen"
    );
    assert_eq!(
        name_table(&reopened).cells[1].paragraphs[0].text,
        "홍민 ABCDEFGHIJKLMNOPQRSTUVWXYZ"
    );
    let expected_positions: Vec<_> = name_table(&core).cells[1].paragraphs[0]
        .line_segs
        .iter()
        .map(|s| (s.text_start, s.vertical_pos, s.segment_width))
        .collect();
    let reopened_positions: Vec<_> = name_table(&reopened).cells[1].paragraphs[0]
        .line_segs
        .iter()
        .map(|s| (s.text_start, s.vertical_pos, s.segment_width))
        .collect();
    assert_eq!(expected_positions, reopened_positions);
    assert_eq!(
        reopened_positions.iter().map(|s| s.0).collect::<Vec<_>>(),
        vec![0, 3, 14, 24]
    );
}

#[test]
fn nested_growth_commits_current_table_sizes_and_complete_host_line() {
    let mut core = load();
    core.insert_text_in_cell_by_path(0, 0, NAME_PATH, 0, "홍길동")
        .unwrap();
    core.delete_text_in_cell_by_path(0, 0, NAME_PATH, 1, 1)
        .unwrap();
    core.insert_text_in_cell_by_path(0, 0, NAME_PATH, 1, "민")
        .unwrap();
    core.delete_text_in_cell_by_path(0, 0, NAME_PATH, 2, 1)
        .unwrap();
    core.insert_text_in_cell_by_path(0, 0, NAME_PATH, 2, " ABCDEFGHIJKLMNOPQRSTUVWXYZ")
        .unwrap();

    let assert_geometry = |core: &DocumentCore| {
        let Control::Table(outer) = &core.document().sections[0].paragraphs[0].controls[6] else {
            panic!("header table")
        };
        assert_eq!(name_table(core).common.height, 6932);
        assert_eq!(outer.common.height, 16995);
        assert!((header_height(core) - 16995.0 / 75.0).abs() < 0.01);
        assert_eq!(outer.cells[0].height, 13322);
        assert_eq!(
            (
                outer.cells[0].padding.left,
                outer.cells[0].padding.right,
                outer.cells[0].padding.top,
                outer.cells[0].padding.bottom,
            ),
            (510, 510, 141, 141),
            "inactive saved margins survive export without becoming frame padding",
        );
        assert_eq!(name_table(core).cells[1].height, 282);
        for control in &outer.cells[0].paragraphs[3].controls[1..] {
            if let Control::Table(sibling) = control {
                assert_eq!(sibling.common.height, 2732);
            }
        }
        let seg = &outer.cells[0].paragraphs[3].line_segs[0];
        assert_eq!(
            [
                seg.text_start as i32,
                seg.vertical_pos,
                seg.line_height,
                seg.text_height,
                seg.baseline_distance,
                seg.line_spacing,
                seg.column_start,
                seg.segment_width,
                seg.tag as i32
            ],
            [0, 9780, 7215, 7215, 6133, 600, 0, 66472, 393216],
        );
    };
    assert_geometry(&core);
    let saved = core.export_hwpx_native().unwrap();
    let reopened = DocumentCore::from_local_file_bytes_with_font_metrics(
        &saved,
        FontMetricsPolicy::HcrDeclared,
    )
    .unwrap();
    assert_geometry(&reopened);

    let expected_pages = core.page_count();
    let mut binary_reopened = Vec::new();
    for source in [&core, &reopened] {
        let binary = source.export_hwp_with_adapter().unwrap();
        let parsed = DocumentCore::from_local_file_bytes_with_font_metrics(
            &binary,
            FontMetricsPolicy::HcrDeclared,
        )
        .unwrap();
        assert_geometry(&parsed);
        assert_eq!(parsed.page_count(), expected_pages);
        binary_reopened.push(parsed);
    }

    // 증가한 common.height는 다음 편집의 불변 하한이 아니다. 재열기에서도
    // 원래 셀 선언과 같은 행의 다른 콘텐츠가 역편집의 최소 높이를 결정한다.
    for mut reverse in [core, reopened].into_iter().chain(binary_reopened) {
        reverse
            .delete_text_in_cell_by_path(0, 0, NAME_PATH, 2, 27)
            .unwrap();
        let Control::Table(outer) = &reverse.document().sections[0].paragraphs[0].controls[6]
        else {
            panic!("header table")
        };
        assert_eq!(name_table(&reverse).common.height, 2732);
        assert_eq!(outer.common.height, 13322);
        assert_eq!(outer.cells[0].height, 13322);
        let line = &outer.cells[0].paragraphs[3].line_segs[0];
        assert_eq!(
            (line.line_height, line.text_height, line.baseline_distance),
            (3015, 3015, 2563)
        );
    }
}

fn edit_host(core: &mut DocumentCore) -> &mut rhwp::model::paragraph::Paragraph {
    let Control::Table(outer) = &mut core.document_mut().sections[0].paragraphs[0].controls[6]
    else {
        panic!("header table")
    };
    &mut outer.cells[0].paragraphs[3]
}

#[test]
fn same_height_nested_edit_keeps_authored_table_surplus() {
    let mut core = load();
    let Control::Table(inner) = &mut edit_host(&mut core).controls[0] else {
        panic!("name table")
    };
    inner.common.height = 5000;
    core.insert_text_in_cell_by_path(0, 0, NAME_PATH, 0, "홍민")
        .unwrap();
    assert_eq!(name_table(&core).common.height, 5000);
}

#[test]
fn mixed_host_keeps_independent_equation_baseline() {
    let mut core = load();
    let host = edit_host(&mut core);
    let mut equation = rhwp::model::control::Equation::default();
    equation.common.treat_as_char = true;
    equation.common.height = 10000;
    equation.common.width = 1000;
    equation.baseline = 95;
    host.controls.push(Control::Equation(Box::new(equation)));
    host.char_count += 8;
    host.line_segs[0].line_height = 10000;
    host.line_segs[0].text_height = 10000;
    host.line_segs[0].baseline_distance = 9500;
    core.insert_text_in_cell_by_path(0, 0, NAME_PATH, 0, "홍민 ABCDEFGHIJKLMNOPQRSTUVWXYZ")
        .unwrap();
    let line = &edit_host(&mut core).line_segs[0];
    assert_eq!((line.line_height, line.baseline_distance), (10000, 9500));
}

#[test]
fn hard_break_composition_keeps_saved_table_host_ownership() {
    let mut core = load();
    let host = edit_host(&mut core);
    host.text = "a\n".into();
    host.char_offsets = vec![0, 1];
    host.char_count += 2;
    core.insert_text_in_cell_by_path(0, 0, NAME_PATH, 0, "홍민 ABCDEFGHIJKLMNOPQRSTUVWXYZ")
        .unwrap();
    let host = edit_host(&mut core);
    assert_eq!(host.line_segs.len(), 1);
    assert_eq!(host.line_segs[0].line_height, 7215);
    assert_eq!(host.text, "a\n");
}

#[test]
fn nested_row_span_growth_includes_authored_vertical_padding() {
    let mut core = load();
    let Control::Table(inner) = &mut edit_host(&mut core).controls[0] else {
        panic!("name table")
    };
    inner.row_count = 2;
    inner.row_sizes = vec![2, 1];
    inner.cells[1].row_span = 2;
    let mut lower = inner.cells[0].clone();
    lower.row = 1;
    inner.cells.push(lower);
    inner.rebuild_grid();
    core.insert_text_in_cell_by_path(0, 0, NAME_PATH, 0, "홍민 ABCDEFGHIJKLMNOPQRSTUVWXYZ")
        .unwrap();
    assert_eq!(name_table(&core).common.height, 6932);
}

#[test]
fn bordered_table_host_moves_the_next_saved_line_by_its_complete_advance() {
    use rhwp::model::paragraph::CharShapeRef;
    use rhwp::model::style::{BorderFill, BorderLineType, LineSpacingType};
    let mut core = load();
    let old_shape = edit_host(&mut core).char_shapes[0].char_shape_id;
    let para_shape = edit_host(&mut core).para_shape_id;
    let info = &mut core.document_mut().doc_info;
    let mut border = BorderFill::default();
    for side in [2, 3] {
        border.borders[side].line_type = BorderLineType::Solid;
        border.borders[side].width = 9;
    }
    info.border_fills.push(border);
    let mut shape = info.char_shapes[old_shape as usize].clone();
    shape.border_fill_id = info.border_fills.len() as u16;
    let bordered_shape = info.char_shapes.len() as u32;
    info.char_shapes.push(shape);
    info.para_shapes[para_shape as usize].line_spacing = 200;
    info.para_shapes[para_shape as usize].line_spacing_type = LineSpacingType::Percent;
    let host = edit_host(&mut core);
    host.text = "x".into();
    host.char_offsets = vec![24];
    host.char_count = 26;
    host.char_shapes = vec![
        CharShapeRef {
            start_pos: 0,
            char_shape_id: bordered_shape,
        },
        CharShapeRef {
            start_pos: 24,
            char_shape_id: old_shape,
        },
    ];
    let mut second = host.line_segs[0].clone();
    second.text_start = 24;
    second.vertical_pos += second.text_height + second.line_spacing;
    second.line_height = 1000;
    second.text_height = 1000;
    second.baseline_distance = 850;
    host.line_segs.push(second);
    core.insert_text_in_cell_by_path(0, 0, NAME_PATH, 0, "홍민 ABCDEFGHIJKLMNOPQRSTUVWXYZ")
        .unwrap();
    let lines = &edit_host(&mut core).line_segs;
    assert_ne!(lines[0].line_spacing, 600);
    assert_eq!(
        lines[1].vertical_pos - lines[0].vertical_pos,
        lines[0].text_height + lines[0].line_spacing
    );
}

#[test]
fn ambiguous_field_slots_keep_geometry_on_the_existing_remeasurement_path() {
    let mut core = load();
    let host = edit_host(&mut core);
    host.text = "x".into();
    host.char_offsets = vec![32];
    host.char_count = 34;
    host.orphan_field_ends
        .push(rhwp::model::paragraph::OrphanFieldEnd {
            char_idx: 0,
            begin_id_ref: 41,
            field_id: 42,
            begin_ctrl_id: u32::from_le_bytes(*b"%clk"),
        });
    let mut second = host.line_segs[0].clone();
    second.text_start = 32;
    second.vertical_pos += second.text_height + second.line_spacing;
    host.line_segs.push(second);
    core.insert_text_in_cell_by_path(0, 0, NAME_PATH, 0, "홍민 ABCDEFGHIJKLMNOPQRSTUVWXYZ")
        .unwrap();
    assert_eq!(name_table(&core).common.height, 2732);
    assert_eq!(edit_host(&mut core).line_segs[0].line_height, 3015);
    assert_eq!(name_table(&core).cells[1].paragraphs[0].line_segs.len(), 4);
}

fn native_margin_box_core(
    boundary: rhwp::model::paragraph::ColumnBreakType,
    boundary_origin: i32,
    style_break: bool,
) -> DocumentCore {
    use rhwp::model::{
        paragraph::{CharShapeRef, LineSeg, Paragraph},
        shape::{TextWrap, VertAlign, VertRelTo},
        style::{Alignment, CharShape, LineSpacingType, ParaShape},
        table::{Cell, Table, TablePageBreak},
    };
    let source = load();
    let mut doc = source.document().clone();
    doc.sections.truncate(1);
    doc.doc_info.char_shapes[0] = CharShape {
        base_size: 1_000,
        ratios: [100; 7],
        relative_sizes: [100; 7],
        ..Default::default()
    };
    doc.doc_info.para_shapes[0] = ParaShape {
        alignment: Alignment::Left,
        line_spacing: 160,
        line_spacing_type: LineSpacingType::Percent,
        ..Default::default()
    };
    doc.doc_info.raw_stream = None;
    doc.doc_info.raw_stream_dirty = true;
    let paragraph = |text: &str, vpos: i32| Paragraph {
        text: text.into(),
        char_count: text.chars().count() as u32 + 1,
        char_offsets: (0..text.chars().count() as u32).collect(),
        char_shapes: vec![CharShapeRef::default()],
        line_segs: vec![LineSeg {
            vertical_pos: vpos,
            line_height: 1_000,
            text_height: 1_000,
            baseline_distance: 850,
            line_spacing: 600,
            segment_width: 15_000,
            ..Default::default()
        }],
        ..Default::default()
    };
    let mut table = Table {
        row_count: 2,
        col_count: 1,
        page_break: TablePageBreak::RowBreak,
        outer_margin_top: 180,
        outer_margin_bottom: 270,
        cells: (0..2)
            .map(|row| Cell {
                row,
                row_span: 1,
                col_span: 1,
                width: 15_000,
                height: 3_000,
                paragraphs: vec![paragraph("abc", 0)],
                ..Default::default()
            })
            .collect(),
        ..Default::default()
    };
    table.common.instance_id = 17_707;
    table.common.width = 15_000;
    table.common.height = 6_000;
    table.common.text_wrap = TextWrap::TopAndBottom;
    table.common.vert_rel_to = VertRelTo::Para;
    table.common.vert_align = VertAlign::Top;
    table.common.flow_with_text = true;
    table.common.margin.top = 180;
    table.common.margin.bottom = 270;
    let mut host = paragraph("", 1_000);
    host.char_count = 9;
    host.line_segs[0].segment_width = 0;
    host.controls = vec![Control::Table(Box::new(table))];
    let mut prefix = paragraph("prefix", 0);
    prefix.line_segs[0].line_height = 600;
    prefix.line_segs[0].text_height = 600;
    prefix.line_segs[0].baseline_distance = 510;
    prefix.line_segs[0].line_spacing = 0;
    // 400HU authored gap precedes the owner. Reconnecting the full section would erase it.
    let mut reset = paragraph("frame reset", boundary_origin);
    reset.column_type = boundary;
    if style_break {
        let mut shape = doc.doc_info.para_shapes[0].clone();
        shape.attr1 |= 1 << 19;
        reset.para_shape_id = doc.doc_info.para_shapes.len() as u16;
        doc.doc_info.para_shapes.push(shape);
    }
    doc.sections[0].paragraphs = vec![
        prefix,
        host,
        paragraph("after", 7_450),
        reset,
        paragraph("next frame tail", boundary_origin + 1_600),
    ];
    doc.sections[0].raw_stream = None;
    let mut core = DocumentCore::new_empty();
    core.set_document(doc);
    core
}

fn native_margin_box_table(core: &DocumentCore) -> &rhwp::model::table::Table {
    let Control::Table(table) = &core.document().sections[0].paragraphs[1].controls[0] else {
        panic!("margin box")
    };
    table
}

fn native_margin_box_source(core: &DocumentCore) -> (u32, i32, i32, i32, i32) {
    let p = &core.document().sections[0].paragraphs;
    (
        native_margin_box_table(core).common.height,
        p[1].line_segs[0].vertical_pos,
        p[2].line_segs[0].vertical_pos,
        p[3].line_segs[0].vertical_pos,
        p[4].line_segs[0].vertical_pos,
    )
}

fn native_margin_box_paint(core: &DocumentCore) -> (f64, f64) {
    fn find(node: &rhwp::renderer::render_tree::RenderNode) -> Option<(f64, f64)> {
        use rhwp::renderer::render_tree::RenderNodeType;
        if matches!(&node.node_type, RenderNodeType::Table(table) if table.para_index == Some(1) && table.control_index == Some(0))
        {
            return Some((node.bbox.x, node.bbox.y));
        }
        node.children.iter().find_map(find)
    }
    find(&core.build_page_render_tree(0).unwrap().root).expect("margin-box paint")
}

#[test]
fn native_margin_box_public_cell_edits_keep_source_anchor_through_growth_undo_and_reopen() {
    use rhwp::model::paragraph::ColumnBreakType;
    for (boundary, origin, style_break) in [
        (ColumnBreakType::Page, 0, false),
        (ColumnBreakType::Column, 0, false),
        (ColumnBreakType::Page, 10_000, false),
        (ColumnBreakType::Column, 10_000, false),
        (ColumnBreakType::None, 10_000, true),
    ] {
        let mut core = native_margin_box_core(boundary, origin, style_break);
        let initial = native_margin_box_source(&core);
        let paint = native_margin_box_paint(&core);
        assert_eq!(initial, (6_000, 1_000, 7_450, origin, origin + 1_600));
        let following = &core.document().sections[0].paragraphs[2].line_segs[0];
        assert_eq!(
            following.vertical_pos + following.text_height + following.line_spacing,
            9_050,
            "preceding stored line ends below the positive explicit origin"
        );
        core.insert_text_in_cell_by_path(0, 1, &[(0, 1, 0)], 3, "Q")
            .unwrap();
        assert_eq!(
            native_margin_box_source(&core),
            initial,
            "same-height public edit keeps source ladder"
        );
        assert_eq!(native_margin_box_paint(&core), paint);
        let before = core.save_snapshot_native();
        let growth = " word".repeat(24);
        core.insert_text_in_cell_by_path(0, 1, &[(0, 1, 0)], 4, &growth)
            .unwrap();
        let first = native_margin_box_source(&core);
        assert!(first.0 > initial.0);
        assert_eq!(
            first.1, initial.1,
            "preceding authored gap cannot reconnect the owner anchor"
        );
        assert_eq!(first.2 - first.1, first.0 as i32 + 450);
        assert_eq!(
            (first.3, first.4),
            (initial.3, initial.4),
            "explicit frame and tail stay fixed after growth"
        );
        assert_eq!(native_margin_box_paint(&core), paint);
        let at = native_margin_box_table(&core).cells[1].paragraphs[0]
            .text
            .chars()
            .count();
        core.insert_text_in_cell_by_path(0, 1, &[(0, 1, 0)], at, &growth)
            .unwrap();
        let second = native_margin_box_source(&core);
        assert!(second.0 > first.0);
        assert_eq!(
            second.1, initial.1,
            "repeated growth preserves owner anchor"
        );
        assert_eq!(second.2 - second.1, second.0 as i32 + 450);
        assert_eq!(
            (second.3, second.4),
            (initial.3, initial.4),
            "explicit frame and tail stay fixed after repeated growth"
        );
        assert_eq!(
            native_margin_box_table(&core).cells[1].height,
            3_000,
            "source row floor stays authored"
        );
        assert_eq!(native_margin_box_paint(&core), paint);
        let after = core.save_snapshot_native();
        core.restore_snapshot_native(before).unwrap();
        assert_eq!(native_margin_box_source(&core), initial);
        core.restore_snapshot_native(after).unwrap();
        assert_eq!(native_margin_box_source(&core), second);
        for bytes in [
            core.export_hwp_native().unwrap(),
            core.export_hwpx_native().unwrap(),
        ] {
            let reopened = DocumentCore::from_local_file_bytes_with_font_metrics(
                &bytes,
                FontMetricsPolicy::HcrDeclared,
            )
            .unwrap();
            let source = native_margin_box_source(&reopened);
            assert_eq!(source.1, second.1);
            assert_eq!(
                (source.3, source.4),
                (second.3, second.4),
                "serialized following frame stays fixed"
            );
            assert_eq!(
                source.2 - source.1,
                source.0 as i32 + 450,
                "serialized current height and source ladder agree without private origin metadata"
            );
            let reopened_paint = native_margin_box_paint(&reopened);
            assert!(
                (reopened_paint.0 - paint.0).abs() < 0.05
                    && (reopened_paint.1 - paint.1).abs() < 0.05,
                "format={} boundary={boundary:?} origin={origin} before={paint:?} reopen={reopened_paint:?}",
                if bytes.starts_with(b"PK") { "HWPX" } else { "HWP" }
            );
        }
    }
}
