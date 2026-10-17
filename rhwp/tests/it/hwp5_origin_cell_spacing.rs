//! HWP에서 가져온 셀의 저장 줄 위치와 첫 문단 앞 간격은 HWPX 재열기 뒤에도 유지한다.
use rhwp::document_core::DocumentCore;
use rhwp::model::control::Control;
use rhwp::model::document::HWP5_ORIGIN_HWPX_MARKER_PATH;
use rhwp::model::paragraph::LineSeg;
use rhwp::model::provenance::FontMetricsPolicy;
use serde_json::{json, Value};

fn load() -> DocumentCore {
    DocumentCore::from_local_file_bytes_with_font_metrics(
        include_bytes!("../../samples/exam_eng.hwp"),
        FontMetricsPolicy::HcrDeclared,
    )
    .unwrap()
}

fn reopen(core: &DocumentCore) -> DocumentCore {
    DocumentCore::from_local_file_bytes_with_font_metrics(
        &core.export_hwpx_native().unwrap(),
        FontMetricsPolicy::HcrDeclared,
    )
    .unwrap()
}

fn cell_lines(core: &DocumentCore, parent: usize, path: Value) -> Vec<Value> {
    (0..core.page_count())
        .flat_map(|page| {
            let layout: Value =
                serde_json::from_str(&core.get_page_line_layout_native(page).unwrap()).unwrap();
            layout["lines"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|line| {
                    line["cell"]["pp"] == parent
                        && line["cell"]["path"] == path
                        && line.get("area").is_none()
                })
                .cloned()
                .collect::<Vec<_>>()
        })
        .collect()
}

fn introduction_lines(core: &DocumentCore) -> Vec<Value> {
    cell_lines(core, 0, json!([[7, 0, 0]]))
}

#[test]
fn unrelated_body_edit_preserves_authored_cell_line_pitch_after_reopen() {
    let mut core = load();
    let before = introduction_lines(&core);
    assert_eq!(before.len(), 3);
    core.insert_text_native(0, 112, 698, " ABC").unwrap();
    assert_eq!(introduction_lines(&core), before);
    assert_eq!(introduction_lines(&reopen(&core)), before);
}

#[test]
fn first_cell_before_spacing_survives_hwp5_origin_reopen() {
    let mut core = load();
    let before = cell_lines(&core, 104, json!([[2, 0, 0]]));
    assert_eq!(before.len(), 1);
    core.insert_text_native(0, 112, 698, " ABC").unwrap();
    assert_eq!(cell_lines(&core, 104, json!([[2, 0, 0]])), before);
    assert_eq!(cell_lines(&reopen(&core), 104, json!([[2, 0, 0]])), before);
}

#[test]
fn unmarked_hwpx_keeps_full_first_cell_before_spacing() {
    let mut core = reopen(&load());
    let mut model = core.document().clone();
    model
        .hwpx_aux_entries
        .retain(|(path, _)| path != HWP5_ORIGIN_HWPX_MARKER_PATH);
    core.set_document(model.clone());
    let with_spacing = cell_lines(&core, 104, json!([[2, 0, 0]]));
    assert_eq!(with_spacing.len(), 1);
    let before_hu = model.doc_info.para_shapes[29].spacing_before / 2;
    assert!(before_hu > 0);
    model.doc_info.para_shapes[29].spacing_before = 0;
    core.set_document(model);
    let without_spacing = cell_lines(&core, 104, json!([[2, 0, 0]]));
    assert_eq!(without_spacing.len(), 1);
    let delta = with_spacing[0]["y"].as_f64().unwrap() - without_spacing[0]["y"].as_f64().unwrap();
    assert!((delta - rhwp::renderer::hwpunit_to_px(before_hu, 96.0)).abs() <= 0.1);
}

#[test]
fn invalid_saved_cell_origins_fall_back_to_increasing_line_positions() {
    for implementation_record in [false, true] {
        let mut core = reopen(&load());
        let mut model = core.document().clone();
        let Control::Table(table) = &mut model.sections[0].paragraphs[0].controls[7] else {
            panic!("introductory table")
        };
        let segments = &mut table.cells[0].paragraphs[0].line_segs;
        if implementation_record {
            segments[1].tag |= LineSeg::TAG_IMPLEMENTATION_PROPERTY;
            segments[1].vertical_pos = 1;
        } else {
            segments[1].vertical_pos = segments[0].vertical_pos;
        }
        core.set_document(model);
        let lines = introduction_lines(&core);
        assert_eq!(lines.len(), 3);
        assert!(
            lines.windows(2).all(|pair| {
                pair[1]["y"].as_f64().unwrap() > pair[0]["y"].as_f64().unwrap() + 1.0
            }),
            "invalid saved origins must not collapse or reverse editable lines: {lines:?}"
        );
    }
}
