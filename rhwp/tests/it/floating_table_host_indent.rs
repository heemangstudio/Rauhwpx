//! 독립 float 문단 기준과 본문/TAC 첫 줄 들여쓰기를 구분한다.
use rhwp::document_core::DocumentCore;
use rhwp::model::control::Control;
use rhwp::model::document::{Document, Section};
use rhwp::model::paragraph::{CharShapeRef, Paragraph};
use rhwp::model::provenance::FontMetricsPolicy;
use rhwp::model::shape::{HorzAlign, HorzRelTo, TextWrap, VertRelTo};
use rhwp::model::style::{CharShape, ParaShape};
use rhwp::model::table::{Cell, Table};
use rhwp::renderer::render_tree::{RenderNode, RenderNodeType};

#[test]
fn loaded_float_reference_preserves_margin_but_excludes_body_first_line_indent() {
    let inspect = |indent, margin, tac, policy, vertical| {
        let mut doc = Document::default();
        doc.doc_info.char_shapes = vec![CharShape {
            base_size: 1000,
            ..Default::default()
        }];
        doc.doc_info.para_shapes = vec![
            ParaShape::default(),
            ParaShape {
                indent,
                margin_left: margin,
                ..Default::default()
            },
        ];
        let mut section = Section::default();
        section.section_def.text_direction = vertical;
        section.section_def.page_def.width = 30000;
        section.section_def.page_def.height = 30000;
        section.section_def.page_def.margin_left = 2000;
        section.section_def.page_def.margin_right = 2000;
        section.section_def.page_def.margin_top = 1000;
        section.section_def.page_def.margin_bottom = 1000;
        let mut table = Table {
            row_count: 1,
            col_count: 1,
            cells: vec![Cell {
                width: 4000,
                height: 2000,
                row_span: 1,
                col_span: 1,
                paragraphs: vec![Paragraph {
                    text: "Cell".into(),
                    char_count: 5,
                    char_shapes: vec![CharShapeRef::default()],
                    ..Default::default()
                }],
                ..Default::default()
            }],
            ..Default::default()
        };
        table.common.width = 4000;
        table.common.height = 2000;
        table.common.treat_as_char = tac;
        table.common.flow_with_text = true;
        table.common.text_wrap = TextWrap::TopAndBottom;
        table.common.horz_rel_to = HorzRelTo::Para;
        table.common.horz_align = HorzAlign::Left;
        table.common.vert_rel_to = VertRelTo::Para;
        table.rebuild_grid();
        section.paragraphs = vec![
            Paragraph {
                char_count: 17,
                char_shapes: vec![CharShapeRef::default()],
                controls: vec![
                    Control::SectionDef(Box::new(section.section_def.clone())),
                    Control::ColumnDef(Default::default()),
                ],
                ..Default::default()
            },
            Paragraph {
                char_count: 9,
                para_shape_id: 1,
                char_shapes: vec![CharShapeRef::default()],
                controls: vec![Control::Table(Box::new(table))],
                ..Default::default()
            },
            Paragraph {
                text: "Body".into(),
                char_count: 5,
                para_shape_id: 1,
                char_shapes: vec![CharShapeRef::default()],
                ..Default::default()
            },
        ];
        doc.sections = vec![section];
        let bytes = rhwp::serializer::hwpx::serialize_hwpx(&doc).unwrap();
        let core = DocumentCore::from_bytes_with_font_metrics(&bytes, policy).unwrap();
        let tree = core.build_page_render_tree(0).unwrap();
        fn find(n: &RenderNode, text: &str) -> Option<f64> {
            if let RenderNodeType::TextRun(run) = &n.node_type {
                if run.text == text {
                    return Some(n.bbox.x);
                }
            }
            n.children.iter().find_map(|c| find(c, text))
        }
        (
            find(&tree.root, "Cell").unwrap(),
            find(&tree.root, "Body").unwrap(),
        )
    };
    let zero = inspect(0, 0, false, FontMetricsPolicy::HcrDeclared, 0);
    let indented = inspect(660, 0, false, FontMetricsPolicy::HcrDeclared, 0);
    assert!(
        (zero.0 - indented.0).abs() < 1e-6,
        "float excludes first-line indent"
    );
    assert!(
        (indented.1 - zero.1 - 330.0 / 75.0).abs() < 1e-6,
        "body retains indent"
    );
    let margin = inspect(660, 400, false, FontMetricsPolicy::HcrDeclared, 0);
    assert!(
        (margin.0 - indented.0 - 200.0 / 75.0).abs() < 1e-6,
        "float retains paragraph margin"
    );
    let tac0 = inspect(0, 0, true, FontMetricsPolicy::HcrDeclared, 0);
    let tac1 = inspect(660, 0, true, FontMetricsPolicy::HcrDeclared, 0);
    assert!(
        (tac1.0 - tac0.0 - 330.0 / 75.0).abs() < 1e-6,
        "TAC retains indent"
    );
    for (policy, vertical) in [
        (FontMetricsPolicy::HancomWindows, 0),
        (FontMetricsPolicy::HcrDeclared, 1),
    ] {
        let a = inspect(0, 0, false, policy, vertical);
        let b = inspect(660, 0, false, policy, vertical);
        assert!(
            (b.0 - a.0).abs() > 1.0,
            "unsupported context retains legacy float indent"
        );
    }
}
