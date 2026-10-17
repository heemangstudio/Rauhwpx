//! Studio 캐럿과 본문 Enter는 같은 논리 오프셋을 사용한다.
use rhwp::model::control::Control;
use rhwp::model::provenance::FontMetricsPolicy;
use rhwp::wasm_api::HwpDocument;
use serde_json::Value;

fn floating_header_document() -> HwpDocument {
    HwpDocument::from_local_file_bytes_with_font_metrics(
        include_bytes!("../../samples/hwpx/opengov/36389312_결재문서본문_특정소방대상물 화재발생 알림(화재번호 2026-177).hwpx"),
        FontMetricsPolicy::HcrDeclared,
    ).unwrap()
}

#[test]
fn end_enter_keeps_text_before_a_floating_table_anchor_and_merge_restores_it() {
    let mut doc = floating_header_document();
    let original = doc.document().sections[0].paragraphs[0].text.clone();
    assert_eq!(original, "1. 관련 근거");
    assert!(doc.document().sections[0].paragraphs[0]
        .controls
        .iter()
        .any(|c| matches!(c, Control::Table(t) if !t.common.treat_as_char)));
    let end = doc.get_logical_length(0, 0).unwrap();
    let line: Value = serde_json::from_str(&doc.get_line_info(0, 0, end).unwrap()).unwrap();
    assert_eq!(end, 8);
    assert_eq!(line["charEnd"], end);
    doc.split_paragraph_native(0, 0, end as usize, None)
        .unwrap();
    assert_eq!(doc.document().sections[0].paragraphs[0].text, original);
    assert!(doc.document().sections[0].paragraphs[1].text.is_empty());
    assert!(doc.document().sections[0].paragraphs[0]
        .controls
        .iter()
        .any(|c| matches!(c, Control::Table(_))));
    let saved = doc.export_hwpx_native().unwrap();
    let reopened = HwpDocument::from_local_file_bytes_with_font_metrics(
        &saved,
        FontMetricsPolicy::HcrDeclared,
    )
    .unwrap();
    assert_eq!(reopened.document().sections[0].paragraphs[0].text, original);
    assert!(reopened.document().sections[0].paragraphs[1]
        .text
        .is_empty());
    doc.merge_paragraph_native(0, 1).unwrap();
    assert_eq!(doc.document().sections[0].paragraphs[0].text, original);
}

#[test]
fn middle_enter_uses_the_same_text_position_as_navigation_with_a_floating_anchor() {
    let mut doc = floating_header_document();
    doc.split_paragraph_native(0, 0, 4, None).unwrap();
    assert_eq!(doc.document().sections[0].paragraphs[0].text, "1. 관");
    assert_eq!(doc.document().sections[0].paragraphs[1].text, "련 근거");
    doc.merge_paragraph_native(0, 1).unwrap();
    assert_eq!(
        doc.document().sections[0].paragraphs[0].text,
        "1. 관련 근거"
    );
}

#[test]
fn ordinary_text_begin_middle_and_end_enter_preserve_characters_through_merge() {
    for offset in [0, 2, 4] {
        let mut doc = HwpDocument::create_empty();
        doc.create_blank_document_native().unwrap();
        doc.insert_text_native(0, 0, 0, "ABCD").unwrap();
        doc.split_paragraph_native(0, 0, offset, None).unwrap();
        assert_eq!(
            doc.document().sections[0].paragraphs[0].text,
            &"ABCD"[..offset]
        );
        assert_eq!(
            doc.document().sections[0].paragraphs[1].text,
            &"ABCD"[offset..]
        );
        doc.merge_paragraph_native(0, 1).unwrap();
        assert_eq!(doc.document().sections[0].paragraphs[0].text, "ABCD");
    }
}

#[test]
fn tac_equation_still_occupies_one_caret_slot_on_each_side_of_enter() {
    for (offset, equation_moves) in [(2, true), (3, false)] {
        let mut doc = HwpDocument::create_empty();
        doc.create_blank_document_native().unwrap();
        doc.insert_text_native(0, 0, 0, "ABCD").unwrap();
        doc.insert_equation_native(0, 0, 2, "i", 1000, 0).unwrap();
        assert_eq!(doc.get_logical_length(0, 0).unwrap(), 5);
        doc.split_paragraph_native(0, 0, offset, None).unwrap();
        assert_eq!(doc.document().sections[0].paragraphs[0].text, "AB");
        assert_eq!(doc.document().sections[0].paragraphs[1].text, "CD");
        let equations = |i: usize| {
            doc.document().sections[0].paragraphs[i]
                .controls
                .iter()
                .filter(|c| matches!(c, Control::Equation(_)))
                .count()
        };
        assert_eq!(equations(0), usize::from(!equation_moves));
        assert_eq!(equations(1), usize::from(equation_moves));
        doc.merge_paragraph_native(0, 1).unwrap();
        assert_eq!(doc.document().sections[0].paragraphs[0].text, "ABCD");
        assert_eq!(doc.get_logical_length(0, 0).unwrap(), 5);
    }
}
