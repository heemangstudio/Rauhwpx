//! 저장 줄 없는 셀에서 함께 들어가는 TAC 표들은 높이를 더하지 않고 기준선을 공유한다.

use rhwp::document_core::DocumentCore;
use rhwp::model::control::Control;
use rhwp::model::document::{Document, Section};
use rhwp::model::paragraph::{CharShapeRef, LineSeg, Paragraph};
use rhwp::model::provenance::SourceFormat;
use rhwp::model::style::{CharShape, ParaShape};
use rhwp::model::table::{Cell, Table};
use rhwp::renderer::composer::{compose_paragraph, recompose_for_cell_width_for_source};
use rhwp::renderer::render_tree::{BoundingBox, RenderNode, RenderNodeType};
use rhwp::renderer::style_resolver::resolve_styles_with_variant;

fn inner_table(width: u32, height: u32) -> Table {
    let mut table = Table {
        row_count: 1,
        col_count: 1,
        outer_margin_left: 100,
        outer_margin_right: 100,
        outer_margin_top: 100,
        outer_margin_bottom: 100,
        cells: vec![Cell {
            width,
            height,
            row_span: 1,
            col_span: 1,
            apply_inner_margin: true,
            paragraphs: vec![Paragraph::new_empty()],
            ..Default::default()
        }],
        ..Default::default()
    };
    table.common.instance_id = width;
    table.common.treat_as_char = true;
    table.common.width = width;
    table.common.height = height;
    table.rebuild_grid();
    table
}

fn document(separator: &str, second_width: u32) -> Document {
    let host = Paragraph {
        text: separator.into(),
        char_count: separator.chars().count() as u32 + 16,
        char_offsets: (0..separator.chars().count())
            .map(|i| 8 + i as u32)
            .collect(),
        char_shapes: vec![CharShapeRef {
            start_pos: 0,
            char_shape_id: 0,
        }],
        controls: vec![
            Control::Table(Box::new(inner_table(10_000, 3_000))),
            Control::Table(Box::new(inner_table(second_width, 6_000))),
        ],
        ..Default::default()
    };
    let mut outer = Table {
        row_count: 2,
        col_count: 1,
        cells: vec![
            Cell {
                width: 30_000,
                height: 7_000,
                row_span: 1,
                col_span: 1,
                apply_inner_margin: true,
                paragraphs: vec![host],
                ..Default::default()
            },
            Cell {
                row: 1,
                width: 30_000,
                height: 1_000,
                row_span: 1,
                col_span: 1,
                apply_inner_margin: true,
                paragraphs: vec![Paragraph {
                    text: "Following row".into(),
                    char_count: 13,
                    char_shapes: vec![CharShapeRef {
                        start_pos: 0,
                        char_shape_id: 0,
                    }],
                    ..Default::default()
                }],
                ..Default::default()
            },
        ],
        ..Default::default()
    };
    outer.common.instance_id = 30_000;
    outer.common.treat_as_char = true;
    outer.common.width = 30_000;
    outer.common.height = 8_000;
    outer.rebuild_grid();
    let mut section = Section::default();
    section.section_def.page_def = rhwp::model::page::PageDef::a4_default();
    section.paragraphs.push(Paragraph {
        controls: vec![
            Control::SectionDef(Box::new(section.section_def.clone())),
            Control::ColumnDef(Default::default()),
            Control::Table(Box::new(outer)),
        ],
        ..Default::default()
    });
    let mut doc = Document::default();
    doc.provenance.format = SourceFormat::Hwpx;
    doc.is_hwpx_variant = true;
    doc.doc_info.para_shapes.push(ParaShape::default());
    doc.doc_info.char_shapes.push(CharShape {
        base_size: 1_000,
        ratios: [100; 7],
        relative_sizes: [100; 7],
        ..Default::default()
    });
    doc.sections.push(section);
    doc
}

fn collect_tables(node: &RenderNode, tables: &mut Vec<BoundingBox>) {
    if matches!(node.node_type, RenderNodeType::Table(_)) {
        tables.push(node.bbox);
    }
    for child in &node.children {
        collect_tables(child, tables);
    }
}

#[test]
fn fitting_fresh_tables_share_baseline_and_do_not_inflate_the_parent_row() {
    for page_break in [
        rhwp::model::table::TablePageBreak::None,
        rhwp::model::table::TablePageBreak::CellBreak,
    ] {
        let mut core = DocumentCore::new_empty();
        let mut doc = document(" ", 18_000);
        let Control::Table(outer) = &mut doc.sections[0].paragraphs[0].controls[2] else {
            unreachable!()
        };
        outer.page_break = page_break;
        core.set_document(doc);
        let mut tables = Vec::new();
        collect_tables(&core.build_page_render_tree(0).unwrap().root, &mut tables);
        assert_eq!(tables.len(), 3, "tables: {tables:?}");
        let (outer, first, second) = (tables[0], tables[1], tables[2]);
        assert!(
            second.x >= first.x + first.width,
            "tables must advance on one line: {tables:?}"
        );
        assert!(
            (first.y + first.height * 0.85 - second.y - second.height * 0.85).abs() < 0.5,
            "unequal tables must share the line baseline: {tables:?}"
        );
        assert!(
            outer.height < 120.0,
            "the row must contain the maximum, not sum, of table heights: {tables:?}"
        );
    }
}

#[test]
fn explicit_breaks_overwide_tables_and_authored_geometry_keep_the_existing_flow() {
    for (separator, width, authored, single) in [
        ("\n", 18_000, false, false),
        // 표의 잉크 폭만은 들어가지만 여백과 구분 공백을 더하면 넘는다.
        (" ", 19_500, false, false),
        (" ", 18_000, true, false),
        (" ", 18_000, false, true),
    ] {
        let mut doc = document(separator, width);
        let Control::Table(outer) = &mut doc.sections[0].paragraphs[0].controls[2] else {
            unreachable!()
        };
        let para = &mut outer.cells[0].paragraphs[0];
        if single {
            para.controls.pop();
            para.char_count -= 8;
        }
        if authored {
            para.line_segs = vec![LineSeg {
                line_height: 1_500,
                baseline_distance: 900,
                segment_width: 30_000,
                tag: LineSeg::TAG_SINGLE_SEGMENT_LINE,
                ..Default::default()
            }];
        }
        let original = para.clone();
        let styles = resolve_styles_with_variant(&doc.doc_info, 96.0, false);
        let mut composed = compose_paragraph(&original);
        let before = composed.clone();
        recompose_for_cell_width_for_source(
            &mut composed,
            &original,
            400.0,
            &styles,
            true,
            rhwp::model::table::CellLineWrap::Break,
            0,
            true,
            96.0,
        );
        if authored {
            assert_eq!(composed.lines[0].line_height, before.lines[0].line_height);
            assert_eq!(
                composed.lines[0].baseline_distance,
                before.lines[0].baseline_distance
            );
        } else {
            assert!(
                composed.tac_controls.is_empty(),
                "excluded tables must not be admitted to a shared line"
            );
        }
    }
}

#[test]
fn generated_single_table_line_counts_its_occupied_height_once() {
    for page_break in [
        rhwp::model::table::TablePageBreak::None,
        rhwp::model::table::TablePageBreak::CellBreak,
    ] {
        let mut doc = document(" ", 18_000);
        let Control::Table(outer) = &mut doc.sections[0].paragraphs[0].controls[2] else {
            unreachable!()
        };
        outer.page_break = page_break;
        let para = &mut outer.cells[0].paragraphs[0];
        para.controls.pop();
        para.char_count -= 8;
        let Control::Table(inner) = &mut para.controls[0] else {
            unreachable!()
        };
        inner.common.height = 6_000;
        inner.cells[0].height = 6_000;
        // 로드 시 합성한 표 줄은 바깥 여백을 포함하는 점유 상자다.
        para.line_segs = vec![LineSeg {
            line_height: 6_200,
            text_height: 6_200,
            baseline_distance: 5_270,
            segment_width: 30_000,
            tag: LineSeg::TAG_IMPLEMENTATION_PROPERTY | LineSeg::TAG_SINGLE_SEGMENT_LINE,
            ..Default::default()
        }];
        let mut core = DocumentCore::new_empty();
        core.set_document(doc);
        let mut tables = Vec::new();
        collect_tables(&core.build_page_render_tree(0).unwrap().root, &mut tables);
        assert_eq!(tables.len(), 2, "{tables:?}");
        assert!(
            tables[0].height < 120.0,
            "generated object must not be added to its line twice: {tables:?}"
        );
        assert!(
            tables[1].y + tables[1].height <= tables[0].y + tables[0].height,
            "object must remain visible: {tables:?}"
        );
    }
}

#[test]
fn fresh_table_fit_uses_the_same_dpi_as_the_allocated_cell() {
    for dpi in [96.0, 192.0] {
        let doc = document(" ", 19_500);
        let Control::Table(outer) = &doc.sections[0].paragraphs[0].controls[2] else {
            unreachable!()
        };
        let para = &outer.cells[0].paragraphs[0];
        let styles = resolve_styles_with_variant(&doc.doc_info, dpi, false);
        let mut composed = compose_paragraph(para);
        recompose_for_cell_width_for_source(
            &mut composed,
            para,
            30_000.0 * dpi / 7_200.0,
            &styles,
            true,
            rhwp::model::table::CellLineWrap::Break,
            0,
            true,
            dpi,
        );
        assert!(
            composed.tac_controls.is_empty(),
            "margins and separator exceed the actual cell at {dpi}dpi"
        );
    }
}

#[test]
fn loaded_control_only_table_spacing_uses_its_font_despite_bookmarks() {
    fn loaded(font_size: i32) -> (BoundingBox, BoundingBox) {
        let mut doc = document(" ", 18_000);
        doc.doc_info.para_shapes[0].line_spacing = 160;
        doc.doc_info.para_shapes[0].line_spacing_type =
            rhwp::model::style::LineSpacingType::Percent;
        doc.doc_info.char_shapes[0].base_size = font_size;
        let mut text_style = doc.doc_info.char_shapes[0].clone();
        text_style.base_size = 1_000;
        doc.doc_info.char_shapes.push(text_style);
        let mut table = inner_table(20_000, 9_000);
        table.cells[0].paragraphs = vec![Paragraph {
            text: "Inside".into(),
            char_count: 7,
            char_offsets: (0..6).collect(),
            char_shapes: vec![CharShapeRef {
                start_pos: 0,
                char_shape_id: 1,
            }],
            ..Default::default()
        }];
        let paragraph = &mut doc.sections[0].paragraphs[0];
        paragraph.controls.truncate(2);
        paragraph
            .controls
            .push(Control::Bookmark(Default::default()));
        paragraph.controls.push(Control::Table(Box::new(table)));
        paragraph.char_shapes = vec![CharShapeRef {
            start_pos: 0,
            char_shape_id: 0,
        }];
        doc.sections[0].paragraphs.push(Paragraph {
            text: "After".into(),
            char_count: 6,
            char_offsets: (0..5).collect(),
            char_shapes: vec![CharShapeRef {
                start_pos: 0,
                char_shape_id: 1,
            }],
            ..Default::default()
        });
        let bytes = rhwp::serializer::hwpx::serialize_hwpx(&doc).unwrap();
        let parsed = rhwp::parser::parse_document(&bytes).unwrap();
        let host = &parsed.sections[0].paragraphs[0];
        assert!(host.line_segs.is_empty());
        assert_eq!(host.controls.len(), 4);
        assert_eq!(host.char_count, 25, "bookmark has no extended record");
        let core = DocumentCore::from_bytes(&bytes).unwrap();
        assert_eq!(
            core.document().sections[0].paragraphs[0].line_segs[0].line_spacing,
            font_size * 60 / 100,
            "loaded control anchor font basis"
        );
        let tree = core.build_page_render_tree(0).unwrap();
        let mut tables = Vec::new();
        collect_tables(&tree.root, &mut tables);
        assert_eq!(tables.len(), 1);
        fn after(node: &RenderNode) -> Option<BoundingBox> {
            if let RenderNodeType::TextRun(run) = &node.node_type {
                if run.text == "After" {
                    return Some(node.bbox);
                }
            }
            node.children.iter().find_map(after)
        }
        (tables[0], after(&tree.root).expect("following paragraph"))
    }
    let (small_table, small_after) = loaded(1_000);
    let (large_table, large_after) = loaded(2_000);
    assert!((small_table.height - large_table.height).abs() < 0.01);
    assert!(
        (large_after.y - small_after.y - 8.0).abs() < 0.15,
        "160% gap must use authored 10/20pt font basis: {small_after:?} {large_after:?}"
    );
}

#[test]
fn loaded_zero_width_control_after_overwide_table_keeps_its_font_line() {
    fn loaded(table_width: u32, body_height: Option<u32>, tail_font: i32) -> DocumentCore {
        let mut doc = document(" ", 18_000);
        if let Some(height) = body_height {
            let page = &mut doc.sections[0].section_def.page_def;
            page.height = height;
            page.margin_top = 0;
            page.margin_bottom = 0;
            page.margin_header = 0;
            page.margin_footer = 0;
            let section_def = doc.sections[0].section_def.clone();
            doc.sections[0].paragraphs[0].controls[0] = Control::SectionDef(Box::new(section_def));
        }
        doc.doc_info.para_shapes[0].line_spacing = 160;
        doc.doc_info.para_shapes[0].line_spacing_type =
            rhwp::model::style::LineSpacingType::Percent;
        let mut tail_style = doc.doc_info.char_shapes[0].clone();
        tail_style.base_size = tail_font;
        doc.doc_info.char_shapes.push(tail_style);
        let mut table = inner_table(table_width, 9_000);
        table.outer_margin_left = 300;
        table.outer_margin_right = 300;
        let paragraph = &mut doc.sections[0].paragraphs[0];
        paragraph.controls.truncate(2);
        paragraph.controls.push(Control::Table(Box::new(table)));
        paragraph
            .controls
            .push(Control::PageNumberPos(Default::default()));
        paragraph
            .controls
            .push(Control::Bookmark(Default::default()));
        paragraph.char_shapes = vec![
            CharShapeRef {
                start_pos: 0,
                char_shape_id: 0,
            },
            CharShapeRef {
                start_pos: 24,
                char_shape_id: 1,
            },
        ];
        doc.sections[0].paragraphs.push(Paragraph {
            text: "After".into(),
            char_count: 6,
            char_offsets: (0..5).collect(),
            char_shapes: vec![CharShapeRef {
                start_pos: 0,
                char_shape_id: 0,
            }],
            ..Default::default()
        });
        let bytes = rhwp::serializer::hwpx::serialize_hwpx(&doc).unwrap();
        // 제어 전용 원문은 표와 쪽번호가 서로 다른 글자 모양 run을 가질 수 있다.
        // 직렬화 템플릿에 실제 HWPX run 경계를 넣고 파서의 원래 축부터 검증한다.
        use std::io::{Read, Write};
        let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
        let mut writer = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        for i in 0..archive.len() {
            let mut file = archive.by_index(i).unwrap();
            let mut data = Vec::new();
            file.read_to_end(&mut data).unwrap();
            if file.name() == "Contents/section0.xml" {
                let xml = String::from_utf8(data).unwrap();
                assert!(xml.contains("<hp:ctrl><hp:pageNum "));
                data = xml
                    .replacen(
                        "<hp:ctrl><hp:pageNum ",
                        "</hp:run><hp:run charPrIDRef=\"1\"><hp:ctrl><hp:pageNum ",
                        1,
                    )
                    .into_bytes();
            }
            let options =
                zip::write::SimpleFileOptions::default().compression_method(file.compression());
            writer.start_file(file.name(), options).unwrap();
            writer.write_all(&data).unwrap();
        }
        let bytes = writer.finish().unwrap().into_inner();
        let parsed = rhwp::parser::parse_document(&bytes).unwrap();
        let host = &parsed.sections[0].paragraphs[0];
        assert_eq!(host.char_count, 33);
        assert!(host
            .char_shapes
            .iter()
            .any(|shape| shape.start_pos == 24 && shape.char_shape_id == 1));
        DocumentCore::from_bytes(&bytes).unwrap()
    }
    // 명목 폭은 들어가지만 바깥 여백을 포함하면 쪽번호 위치 제어가 다음 줄로 간다.
    let body_width = {
        let doc = document(" ", 18_000);
        let page = &doc.sections[0].section_def.page_def;
        page.width - page.margin_left - page.margin_right
    };
    let narrow = loaded(body_width - 400, None, 1_000);
    let wide = loaded(body_width - 800, None, 1_000);
    let narrow_lines = &narrow.document().sections[0].paragraphs[0].line_segs;
    let wide_lines = &wide.document().sections[0].paragraphs[0].line_segs;
    assert_eq!(narrow_lines.len(), 2);
    assert_eq!(
        wide_lines.len(),
        1,
        "zero-width control stays on a fitting line"
    );
    assert_eq!(narrow_lines[1].text_start, 24);
    assert_eq!(narrow_lines[1].line_height, 1_000);
    assert_eq!(narrow_lines[1].baseline_distance, 850);
    assert_eq!(narrow_lines[1].line_spacing, 600);
    fn after(node: &RenderNode) -> Option<BoundingBox> {
        if let RenderNodeType::TextRun(run) = &node.node_type {
            if run.text == "After" {
                return Some(node.bbox);
            }
        }
        node.children.iter().find_map(after)
    }
    let narrow_after = after(&narrow.build_page_render_tree(0).unwrap().root).unwrap();
    let wide_after = after(&wide.build_page_render_tree(0).unwrap().root).unwrap();
    assert!(
        (narrow_after.y - wide_after.y - 1_600.0 / 75.0).abs() < 0.15,
        "control-only tail line must advance following content: {narrow_after:?} {wide_after:?}"
    );
    let narrow_short = loaded(body_width - 400, Some(12_000), 1_000);
    let wide_short = loaded(body_width - 800, Some(12_000), 1_000);
    assert_eq!(wide_short.page_count(), 1);
    assert_eq!(
        narrow_short.page_count(),
        2,
        "tail line consumes the remaining body space before the next paragraph"
    );
    assert!(after(&narrow_short.build_page_render_tree(0).unwrap().root).is_none());
    assert!(after(&narrow_short.build_page_render_tree(1).unwrap().root).is_some());

    let small_tail = loaded(body_width - 400, None, 800);
    let small_line = &small_tail.document().sections[0].paragraphs[0].line_segs[1];
    assert_eq!(
        (
            small_line.line_height,
            small_line.baseline_distance,
            small_line.line_spacing
        ),
        (800, 680, 480),
        "tail line uses its own style below the legacy 9pt fallback"
    );
    let small_wide = loaded(body_width - 800, None, 800);
    let small_after = after(&small_tail.build_page_render_tree(0).unwrap().root).unwrap();
    let small_wide_after = after(&small_wide.build_page_render_tree(0).unwrap().root).unwrap();
    assert!(
        (small_after.y - small_wide_after.y - 1_280.0 / 75.0).abs() < 0.15,
        "small control line must retain its actual rendered advance"
    );
    let small_tail_boundary = loaded(body_width - 400, Some(12_500), 800);
    assert_eq!(
        small_tail_boundary.page_count(),
        1,
        "pagination must use the tail's 8pt style, not the first table's 10pt style"
    );
    let normal_tail_boundary = loaded(body_width - 400, Some(12_500), 1_000);
    assert_eq!(
        normal_tail_boundary.page_count(),
        2,
        "same body fits the smaller control line but not the normal line"
    );
    assert!(after(&small_tail_boundary.build_page_render_tree(0).unwrap().root).is_some());
}

#[test]
fn fresh_horizontal_cell_uses_font_baseline_without_overriding_saved_or_metric_modes() {
    fn baseline(node: &RenderNode) -> Option<f64> {
        if let RenderNodeType::TextLine(line) = &node.node_type {
            if node.children.iter().any(|child| {
                matches!(&child.node_type, RenderNodeType::TextRun(run) if run.text == "Baseline")
            }) {
                return Some(line.baseline);
            }
        }
        node.children.iter().find_map(baseline)
    }
    for page_break in [
        rhwp::model::table::TablePageBreak::None,
        rhwp::model::table::TablePageBreak::CellBreak,
    ] {
        for (font_height, saved, relative_size, base_size, fixed, expected) in [
            (false, false, 100, 1500, false, 17.0),
            (true, false, 100, 1500, false, 16.0),
            (false, true, 100, 1500, false, 18.0),
            (false, false, 50, 1500, false, 17.0),
            (false, false, 100, 1050, false, 893.0 / 75.0),
            (false, false, 100, 1500, true, 16.0),
        ] {
            let mut doc = document(" ", 18_000);
            doc.doc_info.char_shapes[0].base_size = base_size;
            doc.doc_info.char_shapes[0].relative_sizes = [relative_size; 7];
            doc.doc_info.para_shapes[0].attr1 = u32::from(font_height) << 22;
            if fixed {
                doc.doc_info.para_shapes[0].line_spacing_type =
                    rhwp::model::style::LineSpacingType::Fixed;
                doc.doc_info.para_shapes[0].line_spacing = 1500;
            }
            let Control::Table(outer) = &mut doc.sections[0].paragraphs[0].controls[2] else {
                unreachable!()
            };
            outer.page_break = page_break;
            let mut para = Paragraph {
                text: "Baseline".into(),
                char_count: 9,
                char_shapes: vec![CharShapeRef {
                    start_pos: 0,
                    char_shape_id: 0,
                }],
                ..Default::default()
            };
            if saved {
                para.line_segs.push(LineSeg {
                    line_height: 1_500,
                    text_height: 1_500,
                    baseline_distance: 1_350,
                    segment_width: 30_000,
                    ..Default::default()
                });
            }
            outer.cells[0].paragraphs = vec![para];
            let mut core = DocumentCore::new_empty();
            core.set_document(doc);
            let root = core.build_page_render_tree(0).unwrap().root;
            let actual = baseline(&root).expect("visible cell line");
            assert!(
                (actual - expected).abs() < 0.01,
                "font_height={font_height} saved={saved}: {actual} vs {expected}"
            );
        }
    }
}

#[test]
fn generated_single_table_occupied_box_centers_its_ink_with_outer_margins() {
    fn first_cell(node: &RenderNode) -> Option<BoundingBox> {
        if matches!(node.node_type, RenderNodeType::TableCell(_)) {
            return Some(node.bbox);
        }
        node.children.iter().find_map(first_cell)
    }
    for page_break in [
        rhwp::model::table::TablePageBreak::None,
        rhwp::model::table::TablePageBreak::CellBreak,
    ] {
        for (margin, authored) in [(0, false), (120, false), (420, false), (120, true)] {
            let mut doc = document(" ", 18_000);
            let Control::Table(outer) = &mut doc.sections[0].paragraphs[0].controls[2] else {
                unreachable!()
            };
            outer.page_break = page_break;
            outer.cells[0].vertical_align = rhwp::model::table::VerticalAlign::Center;
            let para = &mut outer.cells[0].paragraphs[0];
            para.controls.pop();
            para.char_count -= 8;
            para.text.clear();
            para.char_offsets.clear();
            let Control::Table(inner) = &mut para.controls[0] else {
                unreachable!()
            };
            inner.common.height = 6_000;
            inner.cells[0].height = 6_000;
            inner.outer_margin_top = margin;
            inner.outer_margin_bottom = margin;
            let occupied = 6_000 + 2 * i32::from(margin);
            para.line_segs = vec![LineSeg {
                line_height: occupied,
                text_height: occupied,
                baseline_distance: occupied * 85 / 100,
                segment_width: 30_000,
                tag: if authored {
                    LineSeg::TAG_SINGLE_SEGMENT_LINE
                } else {
                    LineSeg::TAG_IMPLEMENTATION_PROPERTY | LineSeg::TAG_SINGLE_SEGMENT_LINE
                },
                ..Default::default()
            }];
            let mut core = DocumentCore::new_empty();
            core.set_document(doc);
            let root = core.build_page_render_tree(0).unwrap().root;
            let cell = first_cell(&root).unwrap();
            let mut tables = Vec::new();
            collect_tables(&root, &mut tables);
            assert_eq!(tables.len(), 2);
            let child = tables[1];
            let expected = if authored {
                // 저장 점유 상자는 여백까지 중앙 정렬하고 괘선은 위 여백 안쪽에 둔다.
                cell.y + (cell.height - occupied as f64 / 75.0) / 2.0 + f64::from(margin) / 75.0
            } else {
                cell.y + (cell.height - child.height) / 2.0
            };
            assert!((child.y - expected).abs() < 0.05,
                "margin={margin} authored={authored}: child={child:?}, cell={cell:?}, expected={expected}");
        }
    }
}

#[test]
fn loading_fresh_table_reconciles_only_coherent_saved_paragraph_positions() {
    fn geometry(lines: &[LineSeg]) -> Vec<(u32, i32, i32, i32, i32, i32, i32, i32, u32)> {
        lines
            .iter()
            .map(|line| {
                (
                    line.text_start,
                    line.vertical_pos,
                    line.line_height,
                    line.text_height,
                    line.baseline_distance,
                    line.line_spacing,
                    line.column_start,
                    line.segment_width,
                    line.tag,
                )
            })
            .collect()
    }
    fn saved_line(position: i32) -> LineSeg {
        LineSeg {
            vertical_pos: position,
            line_height: 1_000,
            text_height: 1_000,
            baseline_distance: 850,
            line_spacing: 600,
            segment_width: 30_000,
            tag: LineSeg::TAG_SINGLE_SEGMENT_LINE,
            ..Default::default()
        }
    }
    for (mismatched, page_reset, body_height) in [
        (false, false, 0),
        (true, false, 0),
        (false, true, 11_000),
        (true, true, 13_000),
    ] {
        let mut doc = document(" ", 18_000);
        if page_reset {
            let page = &mut doc.sections[0].section_def.page_def;
            page.height = body_height;
            page.margin_top = 0;
            page.margin_bottom = 0;
            page.margin_header = 0;
            page.margin_footer = 0;
            doc.sections[0].paragraphs[0].controls[0] =
                Control::SectionDef(Box::new(doc.sections[0].section_def.clone()));
        }
        doc.doc_info.char_shapes[0].base_size = 1_400;
        doc.doc_info.para_shapes[0].line_spacing = 175;
        let before = &mut doc.sections[0].paragraphs[0];
        before.controls.truncate(2);
        before.text = "Before".into();
        before.char_count = 23;
        before.char_offsets = (16..22).collect();
        before.line_segs = vec![saved_line(3_000)];
        let table = inner_table(10_000, 6_000);
        let table_para = Paragraph {
            char_count: 9,
            char_shapes: vec![CharShapeRef::default()],
            controls: vec![Control::Table(Box::new(table))],
            ..Default::default()
        };
        // 6,200HU occupied table + native 14pt/175% gap 1,052HU.
        // A current line can fit while its trailing gap crosses the body boundary.
        // Preserve a zero reset only when the next line actually cannot fit.
        let next_start = if page_reset {
            0
        } else {
            4_600 + 6_200 + 1_052 + i32::from(mismatched) * 7
        };
        let after = Paragraph {
            text: "AfterA AfterB".into(),
            char_count: 14,
            char_offsets: (0..13).collect(),
            char_shapes: vec![CharShapeRef::default()],
            line_segs: vec![saved_line(next_start), saved_line(next_start + 1_600)],
            ..Default::default()
        };
        doc.sections[0].paragraphs.extend([table_para, after]);
        let bytes = rhwp::serializer::hwpx::serialize_hwpx(&doc).unwrap();
        let parsed = rhwp::parser::parse_document(&bytes).unwrap();
        assert!(parsed.sections[0].paragraphs[1].line_segs.is_empty());
        let core = DocumentCore::from_bytes(&bytes).unwrap();
        let paragraphs = &core.document().sections[0].paragraphs;
        let table_line = &paragraphs[1].line_segs[0];
        assert_eq!(table_line.line_height, 6_200);
        assert_eq!(table_line.line_spacing, 1_052);
        if mismatched {
            assert_ne!(paragraphs[2].line_segs[0].vertical_pos, next_start);
            assert_eq!(
                paragraphs[2].line_segs[0].vertical_pos,
                table_line.vertical_pos + table_line.line_height + table_line.line_spacing
            );
        } else {
            assert_eq!(
                geometry(&paragraphs[0].line_segs),
                geometry(&parsed.sections[0].paragraphs[0].line_segs)
            );
            assert_eq!(
                geometry(&paragraphs[2].line_segs),
                geometry(&parsed.sections[0].paragraphs[2].line_segs)
            );
            assert_eq!(table_line.vertical_pos, 4_600);
        }
    }
}

#[test]
fn local_saved_rowbreak_host_is_emitted_only_with_coherent_previous_anchor() {
    use rhwp::model::shape::{TextWrap, VertRelTo};
    use rhwp::model::table::TablePageBreak;

    fn line(position: i32, height: i32, spacing: i32, start: u32) -> LineSeg {
        LineSeg {
            text_start: start,
            vertical_pos: position,
            line_height: height,
            text_height: height,
            baseline_distance: height * 85 / 100,
            line_spacing: spacing,
            segment_width: 30_000,
            tag: LineSeg::TAG_SINGLE_SEGMENT_LINE,
            ..Default::default()
        }
    }
    for (coherent, reversed, zero_height, host_after_float, anchor_in_tail_gap) in [
        (true, false, false, false, false),
        (true, false, false, false, true),
        (false, false, false, false, false),
        (true, true, false, false, false),
        (true, false, true, false, false),
        (true, false, false, true, false),
    ] {
        let mut doc = document(" ", 18_000);
        let section = &mut doc.sections[0];
        section.section_def.page_def.height = 20_000;
        section.section_def.page_def.margin_top = 0;
        section.section_def.page_def.margin_bottom = 0;
        section.section_def.page_def.margin_header = 0;
        section.section_def.page_def.margin_footer = 0;
        section.paragraphs[0].controls.truncate(2);
        section.paragraphs[0].controls[0] =
            Control::SectionDef(Box::new(section.section_def.clone()));
        section.paragraphs[0].text = "Before".into();
        section.paragraphs[0].char_count = 23;
        section.paragraphs[0].char_offsets = (16..22).collect();
        section.paragraphs[0].char_shapes = vec![CharShapeRef::default()];
        section.paragraphs[0].line_segs = vec![line(0, 10_000, 0, 0)];

        let mut table = inner_table(30_000, 24_000);
        table.common.treat_as_char = false;
        table.common.text_wrap = TextWrap::TopAndBottom;
        table.common.vert_rel_to = VertRelTo::Para;
        table.common.vertical_offset = if host_after_float {
            100
        } else if anchor_in_tail_gap {
            1_300
        } else {
            3_200
        };
        table.outer_margin_top = 0;
        table.outer_margin_bottom = 0;
        table.page_break = TablePageBreak::RowBreak;
        table.row_count = 3;
        table.cells = (0..3)
            .map(|row| Cell {
                row,
                width: 30_000,
                height: if row == 0 { 4_000 } else { 10_000 },
                row_span: 1,
                col_span: 1,
                paragraphs: vec![Paragraph::new_empty()],
                ..Default::default()
            })
            .collect();
        table.rebuild_grid();
        let start = 10_000 + if coherent { 0 } else { 7 };
        section.paragraphs.push(Paragraph {
            text: "Host text".into(),
            char_count: 18,
            char_offsets: (0..9).collect(),
            char_shapes: vec![CharShapeRef::default()],
            line_segs: vec![
                line(start, 1_000, 600, 0),
                line(
                    if reversed { start - 1 } else { start + 1_600 },
                    if zero_height { 0 } else { 1_000 },
                    600,
                    5,
                ),
            ],
            controls: vec![Control::Table(Box::new(table))],
            ..Default::default()
        });
        let mut core = DocumentCore::new_empty();
        core.set_document(doc);
        let page = core.dump_page_items(Some(0));
        let host = page
            .lines()
            .position(|item| item.contains("PartialParagraph") && item.contains("pi=1"));
        let fragment = page
            .lines()
            .position(|item| item.contains("PartialTable") && item.contains("pi=1"))
            .unwrap_or_else(|| panic!("the oversized mixed table must split: {page}"));
        if coherent && !reversed && !zero_height && !host_after_float {
            assert!(host.is_some_and(|host| host < fragment), "{page}");
            let root = core.build_page_render_tree(0).unwrap().root;
            let mut tables = Vec::new();
            collect_tables(&root, &mut tables);
            fn host_runs(node: &RenderNode, runs: &mut Vec<BoundingBox>) {
                if let RenderNodeType::TextRun(run) = &node.node_type {
                    if run.text.starts_with("Host") || run.text == "text" {
                        runs.push(node.bbox);
                    }
                }
                for child in &node.children {
                    host_runs(child, runs);
                }
            }
            let mut runs = Vec::new();
            host_runs(&root, &mut runs);
            assert_eq!(runs.len(), 2, "host must render once: {runs:?}");
            let text_bottom = runs
                .iter()
                .map(|run| run.y + run.height)
                .fold(0.0, f64::max);
            if anchor_in_tail_gap {
                let host_origin = runs.iter().map(|run| run.y).fold(f64::INFINITY, f64::min);
                let expected = host_origin + (1_600.0 + 1_300.0) / 75.0;
                assert!((tables[0].y - expected).abs() < 0.01,
                    "float anchor inside trailing gap must retain its exact origin: actual={}, expected={expected}", tables[0].y);
            }
            assert!(
                tables[0].y >= text_bottom,
                "first fragment overlaps its pre-emitted host: table={:?}, runs={runs:?}",
                tables[0]
            );
        } else {
            assert!(
                host.is_none(),
                "inconsistent saved anchor gained admission: {page}"
            );
        }
    }
}
