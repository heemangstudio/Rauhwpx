//! 빈 번호 문단과 후속 구역의 쪽 상속은 재조판 뒤에도 같은 의미를 유지한다.
use rhwp::model::provenance::FontMetricsPolicy;
use rhwp::model::style::{HeadType, LineSpacingType};
use rhwp::wasm_api::HwpDocument;

fn numbered_document(label_height: i32, numbered: bool) -> HwpDocument {
    let mut doc = HwpDocument::create_empty();
    doc.create_blank_document_native().unwrap();
    doc.insert_text_native(0, 0, 0, "AB").unwrap();
    let id = doc.ensure_default_numbering();
    doc.apply_para_format(
        0,
        0,
        &format!("{{\"headType\":\"Number\",\"numberingId\":{id},\"paraLevel\":0}}"),
    )
    .unwrap();
    let mut model = doc.document().clone();
    model.doc_info.font_metrics_policy = FontMetricsPolicy::HcrDeclared;
    let body_id = model.sections[0].paragraphs[0].char_shapes[0].char_shape_id as usize;
    model.doc_info.char_shapes[body_id].base_size = 1000;
    let mut label = model.doc_info.char_shapes[body_id].clone();
    label.base_size = label_height;
    label.raw_data = None;
    let label_id = model.doc_info.char_shapes.len() as u32;
    model.doc_info.char_shapes.push(label);
    let num = &mut model.doc_info.numberings[(id - 1) as usize];
    num.heads[0].char_shape_id = label_id;
    num.level_formats[0] = "^1.".into();
    num.raw_para_heads = None;
    let para_id = model.sections[0].paragraphs[0].para_shape_id as usize;
    let shape = &mut model.doc_info.para_shapes[para_id];
    shape.line_spacing_type = LineSpacingType::Percent;
    shape.line_spacing = 140;
    if !numbered {
        shape.head_type = HeadType::None;
        shape.numbering_id = 0;
    }
    doc.set_document(model);
    doc
}

fn metrics(doc: &HwpDocument, para: usize) -> (i32, i32, i32, i32) {
    let line = &doc.document().sections[0].paragraphs[para].line_segs[0];
    (
        line.line_height,
        line.text_height,
        line.baseline_distance,
        line.line_spacing,
    )
}

#[test]
fn empty_split_includes_number_label_size_and_clear_restores_body_metrics() {
    for (label, numbered, expected) in [(1800, true, 1800), (600, true, 1000), (1800, false, 1000)]
    {
        let mut doc = numbered_document(label, numbered);
        doc.split_paragraph_native(0, 0, 2, None).unwrap();
        assert!(doc.document().sections[0].paragraphs[1].text.is_empty());
        let expected_metrics = (expected, expected, expected * 85 / 100, expected * 40 / 100);
        assert_eq!(metrics(&doc, 1), expected_metrics);
        let saved = doc.export_hwpx_native().unwrap();
        let reopened = HwpDocument::from_local_file_bytes_with_font_metrics(
            &saved,
            FontMetricsPolicy::HcrDeclared,
        )
        .unwrap();
        assert_eq!(metrics(&reopened, 1), expected_metrics);
        doc.apply_para_format(0, 1, r#"{"headType":"None","numberingId":0}"#)
            .unwrap();
        assert_eq!(metrics(&doc, 1), (1000, 1000, 850, 400));
    }
}

fn section_carry_document(own_headers: bool, restart: bool) -> HwpDocument {
    use rhwp::model::control::Control;
    use rhwp::model::header_footer::{Header, HeaderFooterApply};
    use rhwp::model::page::PageDef;
    let mut doc = numbered_document(600, false);
    let mut model = doc.document().clone();
    let body = model.sections[0].paragraphs[0].clone();
    let header = |text: &str, apply_to| {
        let mut para = body.clone();
        para.text = text.into();
        para.controls.clear();
        para.line_segs.clear();
        Control::Header(Box::new(Header {
            apply_to,
            paragraphs: vec![para],
            ..Default::default()
        }))
    };
    let first = &mut model.sections[0];
    first.section_def.page_def = PageDef {
        width: 20000,
        height: 1700,
        ..Default::default()
    };
    first.paragraphs[0].controls = vec![
        header("ODD", HeaderFooterApply::Odd),
        header("EVEN", HeaderFooterApply::Even),
    ];
    let mut second = first.clone();
    second.paragraphs[0].controls.clear();
    if own_headers {
        second.paragraphs[0]
            .controls
            .push(header("OWN", HeaderFooterApply::Both));
    }
    if restart {
        second.section_def.page_num = 1;
    }
    model.sections.push(second);
    doc.set_document(model);
    doc
}

fn rendered_pages(doc: &HwpDocument) -> Vec<String> {
    (0..doc.page_count())
        .map(|page| doc.render_page_svg(page).unwrap())
        .collect()
}

fn assert_fresh_and_reopened(doc: &mut HwpDocument) {
    let expected = rendered_pages(doc);
    let mut fresh = HwpDocument::create_empty();
    fresh.set_document(doc.document().clone());
    assert_eq!(rendered_pages(&fresh), expected, "independent core");
    let reopened = HwpDocument::from_local_file_bytes_with_font_metrics(
        &doc.export_hwpx_native().unwrap(),
        FontMetricsPolicy::HcrDeclared,
    )
    .unwrap();
    assert_eq!(rendered_pages(&reopened), expected, "saved/reopened");
}

#[test]
fn changed_upstream_page_count_reselects_section_carry_and_merge_reverses_it() {
    for (own_headers, restart) in [(false, false), (true, false), (false, true)] {
        let mut doc = section_carry_document(own_headers, restart);
        let original = rendered_pages(&doc);
        assert_eq!(doc.page_count(), 2);
        // 앞 구역에 짝수 쪽이 없어도 정의된 짝수 머리말은 후속 편집에 상속된다.
        doc.insert_text_native(1, 0, 2, "C").unwrap();
        assert_fresh_and_reopened(&mut doc);
        doc.delete_text_native(1, 0, 2, 1).unwrap();
        assert_eq!(rendered_pages(&doc), original);
        doc.split_paragraph_native(0, 0, 2, None).unwrap();
        assert_eq!(doc.page_count(), 3);
        assert_fresh_and_reopened(&mut doc);
        // 같은 입력으로 flush해도 상속 선택이 바뀌지 않아야 한다.
        let stable = rendered_pages(&doc);
        doc.flush_deferred_pagination().unwrap();
        assert_eq!(rendered_pages(&doc), stable);
        doc.merge_paragraph_native(0, 1).unwrap();
        assert_eq!(rendered_pages(&doc), original);
        assert_fresh_and_reopened(&mut doc);
    }
}
