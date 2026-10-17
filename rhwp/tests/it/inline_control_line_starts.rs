//! 재조판 줄의 시작은 인라인 개체 뒤 글자가 아니라 실제 스트림 앵커를 보존한다.

use rhwp::document_core::DocumentCore;
use rhwp::model::control::{Control, Equation};
use rhwp::model::document::{Document, Section};
use rhwp::model::paragraph::{CharShapeRef, LineSeg, Paragraph};
use rhwp::model::provenance::SourceFormat;
use rhwp::model::shape::CommonObjAttr;
use rhwp::model::style::{CharShape, ParaShape};
use rhwp::model::table::{Cell, Table};
use rhwp::renderer::composer::compose_paragraph;

fn core_with_equations(prefix: &str, equations: usize) -> DocumentCore {
    let suffix = "cccc dddd";
    let text = format!("{prefix}{suffix}");
    let prefix_units = prefix.encode_utf16().count() as u32;
    let mut offset = 0u32;
    let char_offsets = text
        .chars()
        .enumerate()
        .map(|(i, ch)| {
            if i == prefix.chars().count() {
                offset += equations as u32 * 8;
            }
            let start = offset;
            offset += ch.len_utf16() as u32;
            start
        })
        .collect();
    let controls = (0..equations)
        .map(|i| {
            Control::Equation(Box::new(Equation {
                common: CommonObjAttr {
                    treat_as_char: true,
                    width: if equations == 1 { 4_000 } else { 2_000 },
                    height: 5_000,
                    instance_id: 100 + i as u32,
                    ..Default::default()
                },
                script: "x".repeat(9),
                font_size: 1_200,
                baseline: 85,
                ..Default::default()
            }))
        })
        .collect();
    let paragraph = Paragraph {
        text,
        char_offsets,
        char_count: offset + 1,
        char_shapes: vec![CharShapeRef {
            start_pos: 0,
            char_shape_id: 0,
        }],
        controls,
        line_segs: vec![LineSeg {
            line_height: 1_200,
            text_height: 1_200,
            baseline_distance: 1_020,
            segment_width: 7_504,
            ..Default::default()
        }],
        has_para_text: true,
        ..Default::default()
    };
    assert_eq!(
        paragraph.char_offsets[prefix.chars().count()],
        prefix_units + equations as u32 * 8
    );
    let mut table = Table {
        row_count: 1,
        col_count: 1,
        cells: vec![Cell {
            width: 7_504,
            height: 2_000,
            row_span: 1,
            col_span: 1,
            paragraphs: vec![paragraph],
            ..Default::default()
        }],
        ..Default::default()
    };
    table.common.width = 7_504;
    table.common.height = 2_000;
    table.rebuild_grid();
    let mut document = Document::default();
    document.provenance.format = SourceFormat::Hwpx;
    document.is_hwpx_variant = true;
    document.doc_info.para_shapes.push(ParaShape::default());
    document.doc_info.char_shapes.push(CharShape {
        base_size: 1_200,
        ratios: [100; 7],
        relative_sizes: [100; 7],
        ..Default::default()
    });
    document.sections.push(Section {
        paragraphs: vec![Paragraph {
            controls: vec![Control::Table(Box::new(table))],
            ..Default::default()
        }],
        ..Default::default()
    });
    let mut core = DocumentCore::new_empty();
    core.set_document(document);
    core
}

fn cell_paragraph(core: &DocumentCore) -> &Paragraph {
    let table = core.document().sections[0]
        .paragraphs
        .iter()
        .flat_map(|paragraph| &paragraph.controls)
        .find_map(|control| match control {
            Control::Table(table) => Some(table),
            _ => None,
        })
        .expect("표가 없다");
    &table.cells[0].paragraphs[0]
}

#[test]
fn wrapped_equations_keep_their_stream_start_and_visible_owner_after_save() {
    for (prefix, equations) in [("aaaa bbbb ", 1), ("aaaa bbbb ", 2), ("aaaa 😀bb ", 1)] {
        let mut core = core_with_equations(prefix, equations);
        core.resize_table_cells_by_cell_path_native(
            0,
            0,
            &[(0, 0, 0)],
            r#"[{"cellIdx":0,"widthDelta":-4}]"#,
        )
        .expect("칸 폭 변경");
        let paragraph = cell_paragraph(&core);
        let raw_anchor = prefix.encode_utf16().count() as u32;
        let position = prefix.chars().count();
        let owner = paragraph
            .line_segs
            .iter()
            .position(|s| s.text_start == raw_anchor)
            .expect("개체가 새 줄의 실제 스트림 시작을 소유해야 한다");
        assert!(owner > 0);
        assert_eq!(paragraph.line_segs[0].text_start, 0);
        let composed = compose_paragraph(paragraph);
        assert_eq!(composed.lines[owner].char_start, position);
        assert!(paragraph.line_segs[owner].line_height >= 5_000);
        let starts: Vec<_> = paragraph.line_segs.iter().map(|s| s.text_start).collect();
        let text = paragraph.text.clone();

        let saved = core.export_hwpx_native().expect("HWPX 저장");
        let reopened = DocumentCore::from_bytes(&saved).expect("재열기");
        let paragraph = cell_paragraph(&reopened);
        assert_eq!(paragraph.text, text);
        assert_eq!(
            paragraph
                .line_segs
                .iter()
                .map(|s| s.text_start)
                .collect::<Vec<_>>(),
            starts
        );
        assert_eq!(
            compose_paragraph(paragraph).lines[owner].char_start,
            position
        );
        assert_eq!(
            paragraph.control_text_positions(),
            vec![position; equations]
        );
    }
}
