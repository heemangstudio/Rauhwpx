//! 문단 위·아래 간격의 UI 물리 px와 2x 원본 저장값 계약.
use rhwp::document_core::DocumentCore;
use serde_json::Value;

const NATIVE: &[u8] = include_bytes!(
    "../fixtures/editing_parity/mac-hancom-12.30.0/body-paragraph-spacing/edited.hwpx"
);

fn props(core: &DocumentCore, para: usize) -> Value {
    serde_json::from_str(&core.get_para_properties_at_native(0, para).unwrap()).unwrap()
}
fn raw(core: &DocumentCore, para: usize) -> (i32, i32) {
    let doc = core.document();
    let shape = &doc.doc_info.para_shapes[doc.sections[0].paragraphs[para].para_shape_id as usize];
    (shape.spacing_before, shape.spacing_after)
}
fn assert_spacing(core: &DocumentCore, para: usize, before: i32, after: i32) {
    assert_eq!(raw(core, para), (before, after));
    let p = props(core, para);
    // API는 0.1px 정밀도로 물리 간격을 보고한다.
    for (key, value) in [("spacingBefore", before), ("spacingAfter", after)] {
        let physical_px = value as f64 / 2.0 / 7200.0 * 96.0;
        let shown_px = (physical_px * 10.0).round() / 10.0;
        assert_eq!(p[key].as_f64().unwrap(), shown_px, "{key}");
    }
}

#[test]
fn xml12_native_three_and_one_half_pt_survive_unrelated_edit_and_reopen() {
    let mut core = DocumentCore::from_bytes(NATIVE).unwrap();
    let para = core.document().sections[0]
        .paragraphs
        .iter()
        .position(|p| p.para_shape_id == 20)
        .expect("XML1.2 native spacing paragraph");
    // Mac Hancom 12.30.0 build 6446, 2026-09-05 실제 대화상자 관측: 위 3pt/아래 1.5pt.
    // probes/paragraph-spacing-version-contract/legacy-paragraph-spacing-observation.json
    // 입력 SHA256: 577a973b10231db6b712d347a5210f200961bfe6faff191cecd3b5ecb13ece92.
    let assert_native_pt = |core: &DocumentCore| {
        assert_spacing(core, para, 600, 300);
        let p = props(core, para);
        assert_eq!(p["spacingBefore"].as_f64().unwrap() * 72.0 / 96.0, 3.0);
        assert_eq!(p["spacingAfter"].as_f64().unwrap() * 72.0 / 96.0, 1.5);
    };
    assert_native_pt(&core);
    core.apply_para_format_native(0, para, r#"{"alignment":"center"}"#)
        .unwrap();
    assert_native_pt(&core);
    let reopened = DocumentCore::from_bytes(&core.export_hwpx_native().unwrap()).unwrap();
    assert_native_pt(&reopened);
}

#[test]
fn dialog_five_and_three_pt_payload_preserves_raw_units_through_save_reopen() {
    let mut core = DocumentCore::from_bytes(NATIVE).unwrap();
    let para = 0;
    core.apply_para_format_native(0, para, r#"{"spacingBefore":1000,"spacingAfter":600}"#)
        .unwrap();
    assert_spacing(&core, para, 1000, 600);
    let reopened = DocumentCore::from_bytes(&core.export_hwpx_native().unwrap()).unwrap();
    assert_spacing(&reopened, para, 1000, 600);
    // raw API의 기존 500 입력을 재해석하지 않는다.
    core.apply_para_format_native(0, para, r#"{"spacingBefore":500,"spacingAfter":0}"#)
        .unwrap();
    assert_spacing(&core, para, 500, 0);
}

#[test]
fn xml14_native_cell_spacing_displays_six_and_three_pt_without_changing_source_units() {
    use rhwp::model::control::Control;
    let source = include_bytes!(
        "../fixtures/editing_parity/mac-hancom-12.30.0-xml14/cell-paragraph-spacing/edited.hwpx"
    );
    let mut core = DocumentCore::from_bytes(source).unwrap();
    let address = core.document().sections[0]
        .paragraphs
        .iter()
        .enumerate()
        .find_map(|(parent, para)| {
            para.controls.iter().enumerate().find_map(|(control, c)| {
                let Control::Table(t) = c else {
                    return None;
                };
                t.cells.iter().enumerate().find_map(|(cell, c)| {
                    c.paragraphs
                        .iter()
                        .enumerate()
                        .find(|(_, p)| p.para_shape_id == 20)
                        .map(|(p, _)| (parent, control, cell, p))
                })
            })
        })
        .expect("XML1.4 native spaced cell");
    let (parent, control, cell, para) = address;
    let assert_cell = |core: &DocumentCore| {
        let p: Value = serde_json::from_str(
            &core
                .get_cell_para_properties_at_native(0, parent, control, cell, para)
                .unwrap(),
        )
        .unwrap();
        assert_eq!(p["spacingBefore"].as_f64().unwrap(), 8.0);
        assert_eq!(p["spacingAfter"].as_f64().unwrap(), 4.0);
        let shape =
            &core.document().doc_info.para_shapes[p["paraShapeId"].as_u64().unwrap() as usize];
        assert_eq!((shape.spacing_before, shape.spacing_after), (1200, 600));
    };
    assert_cell(&core);
    core.apply_para_format_in_cell_native(
        0,
        parent,
        control,
        cell,
        para,
        r#"{"alignment":"center"}"#,
    )
    .unwrap();
    assert_cell(&core);
    let reopened = DocumentCore::from_bytes(&core.export_hwpx_native().unwrap()).unwrap();
    assert_cell(&reopened);
}
