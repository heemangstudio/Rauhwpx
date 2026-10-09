//! Loaded cell row endpoints must remain stable when only a stale table total changes.
use rhwp::document_core::DocumentCore;
use rhwp::model::control::Control;
use rhwp::model::document::{Document, OWN_LINE_LAYOUT_HWPX_MARKER_PATH};
use rhwp::model::paragraph::{LineSeg, Paragraph};
use rhwp::model::shape::{CommonObjAttr, TextWrap};
use rhwp::model::table::{Cell, Table};
use rhwp::renderer::render_tree::{RenderNode, RenderNodeType};

fn loaded_table(
    total: u32,
    saved: bool,
    grown: bool,
    fixed: bool,
    protected: bool,
) -> DocumentCore {
    let seed = include_bytes!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/samples/hwpx/ref/ref_empty.hwpx"
    ));
    let mut core = DocumentCore::from_bytes(seed).unwrap();
    let mut doc = core.document().clone();
    let mut cells = Vec::new();
    for row in 0..3u16 {
        let mut para = Paragraph {
            text: "x".into(),
            char_count: 2,
            has_para_text: true,
            ..Paragraph::new_empty()
        };
        // One missing saved descriptor still owns a positive authored cell row height.
        if saved && row != 1 {
            let height = if grown && row == 2 { 15_000 } else { 1_000 };
            para.line_segs = vec![LineSeg {
                line_height: height,
                text_height: height,
                baseline_distance: height * 85 / 100,
                segment_width: 10_000,
                ..Default::default()
            }];
        } else {
            para.line_segs.clear();
        }
        cells.push(Cell {
            row,
            col: 0,
            row_span: 1,
            col_span: 1,
            width: 10_000,
            height: 3_000,
            paragraphs: vec![para],
            ..Default::default()
        });
    }
    let mut table = Table {
        row_count: 3,
        col_count: 1,
        cells,
        common: CommonObjAttr {
            width: 10_000,
            height: total,
            treat_as_char: true,
            flow_with_text: true,
            text_wrap: TextWrap::TopAndBottom,
            ..Default::default()
        },
        ..Default::default()
    };
    if fixed {
        table.raw_table_record_attr |= 8;
    }
    table.common.size_protect = protected;
    table.rebuild_grid();
    let mut host = Paragraph::new_empty();
    host.line_segs.clear();
    host.controls = vec![Control::Table(Box::new(table))];
    doc.sections[0].paragraphs = vec![host];
    core.set_document(doc);
    DocumentCore::from_bytes(&core.export_hwpx_native().unwrap()).unwrap()
}
fn extent(node: &RenderNode) -> Option<f64> {
    if matches!(node.node_type, RenderNodeType::Table(_)) {
        return Some(node.bbox.height);
    }
    node.children.iter().find_map(extent)
}
fn height(core: &DocumentCore) -> f64 {
    extent(&core.build_page_render_tree(0).unwrap().root).unwrap()
}
fn line_tags(document: &Document) -> Vec<u32> {
    fn collect(paragraphs: &[Paragraph], tags: &mut Vec<u32>) {
        for para in paragraphs {
            tags.extend(para.line_segs.iter().map(|seg| seg.tag));
            for control in &para.controls {
                if let Control::Table(table) = control {
                    for cell in &table.cells {
                        collect(&cell.paragraphs, tags);
                    }
                }
            }
        }
    }
    let mut tags = Vec::new();
    for section in &document.sections {
        collect(&section.paragraphs, &mut tags);
    }
    tags
}
fn own_layout_marker_count(bytes: &[u8]) -> usize {
    use std::io::Read;
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
    let mut count = 0;
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).unwrap();
        if entry.name() == OWN_LINE_LAYOUT_HWPX_MARKER_PATH {
            let mut payload = Vec::new();
            entry.read_to_end(&mut payload).unwrap();
            assert_eq!(payload, b"1");
            count += 1;
        }
    }
    count
}
#[test]
fn saved_row_endpoints_ignore_a_larger_common_height_with_a_missing_descriptor() {
    let a = loaded_table(10_000, true, false, false, false);
    let b = loaded_table(13_000, true, false, false, false);
    for core in [&a, &b] {
        assert!(!core.document().layout_profile().own_line_layout());
        let bytes = core.export_hwpx_native().unwrap();
        assert_eq!(own_layout_marker_count(&bytes), 0);
        let reopened = DocumentCore::from_bytes(&bytes).unwrap();
        assert!(!reopened.document().layout_profile().own_line_layout());
        assert!((height(core) - height(&reopened)).abs() < 0.15);
    }
    let a = height(&a);
    let b = height(&b);
    assert!((a - 120.0).abs() < 0.15, "authored rows: {a}");
    assert!(
        (a - b).abs() < 0.15,
        "stale total stretched rows: {a} -> {b}"
    );
}
#[test]
fn measured_content_growth_survives_saved_row_authority() {
    let base = height(&loaded_table(10_000, true, false, false, false));
    let grown = height(&loaded_table(10_000, true, true, false, false));
    assert!(
        grown > base + 100.0,
        "content growth was clipped: {base} -> {grown}"
    );
}
#[test]
fn fresh_rows_keep_the_existing_declared_height_contract() {
    let a = loaded_table(10_000, false, false, false, false);
    let b = loaded_table(13_000, false, false, false, false);
    for core in [&a, &b] {
        // Generated lines lose their placeholder tags after complete load composition.
        // They still have no Hancom-saved row endpoints to override the authored total.
        assert!(core.document().layout_profile().own_line_layout());
        assert!(core.document().layout_profile().native_hwpx_cell_margin());
        let before = height(core);
        let before_controls = core.get_page_control_layout_native(0).unwrap();
        let before_tags = line_tags(core.document());
        assert!(before_tags
            .iter()
            .all(|tag| tag & LineSeg::TAG_IMPLEMENTATION_PROPERTY == 0));
        let source_before = format!("{:?}", core.document());
        let mut bytes = core.export_hwpx_native().unwrap();
        assert_eq!(format!("{:?}", core.document()), source_before);
        for _ in 0..2 {
            assert_eq!(own_layout_marker_count(&bytes), 1);
            let reopened = DocumentCore::from_bytes(&bytes).unwrap();
            assert!(reopened.document().layout_profile().own_line_layout());
            assert!(reopened
                .document()
                .layout_profile()
                .native_hwpx_cell_margin());
            assert_eq!(line_tags(reopened.document()), before_tags);
            assert_eq!(
                reopened.get_page_control_layout_native(0).unwrap(),
                before_controls
            );
            let after = height(&reopened);
            assert!(
                (before - after).abs() < 0.15,
                "saving generated rows must preserve their declared table height: {before} -> {after}"
            );
            let source_before = format!("{:?}", reopened.document());
            bytes = reopened.export_hwpx_native().unwrap();
            assert_eq!(format!("{:?}", reopened.document()), source_before);
        }
    }
    let a = height(&a);
    let b = height(&b);
    assert!(b > a + 30.0, "fresh declared height changed: {a} -> {b}");
}

#[test]
fn explicit_no_adjust_tables_keep_the_declared_height_contract() {
    let a = height(&loaded_table(10_000, true, false, true, false));
    let b = height(&loaded_table(13_000, true, false, true, false));
    assert!(b > a + 30.0, "noAdjust table total changed: {a} -> {b}");
}

#[test]
fn protected_table_sizes_keep_the_declared_height_contract() {
    let a = height(&loaded_table(10_000, true, false, false, true));
    let b = height(&loaded_table(13_000, true, false, false, true));
    assert!(b > a + 30.0, "protected table total changed: {a} -> {b}");
}
