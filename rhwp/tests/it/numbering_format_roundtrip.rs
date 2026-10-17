//! HWP 경유 번호 형식은 저장 후에도 마커와 본문 시작 위치를 유지한다.
use rhwp::model::provenance::FontMetricsPolicy;
use rhwp::parser::hwpx::parse_hwpx;
use rhwp::serializer::hwpx::serialize_hwpx;
use rhwp::wasm_api::HwpDocument;
use serde_json::Value;

fn numbered_document() -> HwpDocument {
    let mut doc = HwpDocument::create_empty();
    doc.create_blank_document_native().unwrap();
    doc.insert_text_native(0, 0, 0, "본문").unwrap();
    let id = doc.ensure_default_numbering();
    doc.apply_para_format(
        0,
        0,
        &format!("{{\"headType\":\"Number\",\"numberingId\":{id},\"paraLevel\":0}}"),
    )
    .unwrap();
    let mut model = doc.document().clone();
    model.doc_info.font_metrics_policy = FontMetricsPolicy::HcrDeclared;
    let numbering = &mut model.doc_info.numberings[(id - 1) as usize];
    // 바이너리 HWP에는 보존할 원본 paraHead XML이 없다.
    numbering.raw_para_heads = None;
    for head in &mut numbering.heads {
        head.attr = 12;
        head.number_format = 0;
        head.width_adjust = 0;
        head.text_distance = 50;
        head.char_shape_id = u32::MAX;
    }
    numbering.level_start_numbers = [1; 7];
    numbering.level_formats = [
        "^1.", "(^2)", "제^3장", "^4<&>", "\"^5\"", "'^6'", "^7 / 끝",
    ]
    .map(str::to_string);
    doc.set_document(model);
    doc
}

#[test]
fn seven_source_templates_survive_escaping_without_creating_extra_level_templates() {
    let doc = numbered_document();
    let expected = &doc.document().doc_info.numberings[0].level_formats;
    let saved = serialize_hwpx(doc.document()).unwrap();
    let reopened = parse_hwpx(&saved).unwrap();
    assert_eq!(&reopened.doc_info.numberings[0].level_formats, expected);

    // 파서의 7수준 모델 밖에 방출되는 8~10수준도 새로운 번호를 만들면 안 된다.
    let raw = reopened.doc_info.numberings[0]
        .raw_para_heads
        .as_ref()
        .unwrap();
    let mut reader = quick_xml::Reader::from_str(raw);
    let mut extra_level = false;
    let mut extra_levels = Vec::new();
    loop {
        match reader.read_event().unwrap() {
            quick_xml::events::Event::Start(e) | quick_xml::events::Event::Empty(e)
                if e.local_name().as_ref() == b"paraHead" =>
            {
                let level = e
                    .attributes()
                    .map(Result::unwrap)
                    .find(|a| a.key.as_ref() == b"level")
                    .unwrap();
                let level: u32 = std::str::from_utf8(&level.value).unwrap().parse().unwrap();
                extra_level = level >= 8;
                if extra_level {
                    extra_levels.push(level);
                }
            }
            quick_xml::events::Event::Text(t) if extra_level => {
                assert!(t.decode().unwrap().is_empty(), "추가 수준에 형식이 복제됨");
            }
            quick_xml::events::Event::End(_) => extra_level = false,
            quick_xml::events::Event::Eof => break,
            _ => {}
        }
    }
    assert_eq!(extra_levels, [8, 9, 10]);
    let saved_again = serialize_hwpx(&reopened).unwrap();
    let reopened_again = parse_hwpx(&saved_again).unwrap();
    assert_eq!(
        &reopened_again.doc_info.numberings[0].level_formats,
        expected
    );
    assert_eq!(
        reopened_again.doc_info.numberings[0]
            .raw_para_heads
            .as_ref(),
        Some(raw)
    );
}

#[test]
fn raw_hwpx_templates_keep_numeric_references_and_original_para_head_fragment() {
    let doc = numbered_document();
    let mut model = doc.document().clone();
    let raw = r#"<hh:paraHead level="1" start="1" numFormat="DIGIT">^1. &#x3C;&#38;&#x3E;&quot;&apos;</hh:paraHead><hh:paraHead level="8" useInstWidth="0"/>"#;
    model.doc_info.numberings[0].raw_para_heads = Some(raw.into());
    let saved = serialize_hwpx(&model).unwrap();
    let reopened = parse_hwpx(&saved).unwrap();
    assert_eq!(
        reopened.doc_info.numberings[0].level_formats[0],
        "^1. <&>\"'"
    );
    assert_eq!(
        reopened.doc_info.numberings[0].raw_para_heads.as_deref(),
        Some(raw)
    );
    let saved_again = serialize_hwpx(&reopened).unwrap();
    let reopened_again = parse_hwpx(&saved_again).unwrap();
    assert_eq!(
        reopened_again.doc_info.numberings[0].level_formats[0],
        "^1. <&>\"'"
    );
    assert_eq!(
        reopened_again.doc_info.numberings[0]
            .raw_para_heads
            .as_deref(),
        Some(raw)
    );
}

fn marker(doc: &HwpDocument) -> (String, Value) {
    fn find(value: &Value) -> Option<(String, Value)> {
        let text = &value["node_type"]["TextRun"];
        if text["para_index"] == 0 && text["char_start"].is_null() && text["text"].is_string() {
            return Some((text["text"].as_str().unwrap().into(), value["bbox"].clone()));
        }
        value["children"].as_array()?.iter().find_map(find)
    }
    let tree = serde_json::to_value(doc.build_page_render_tree(0).unwrap()).unwrap();
    find(&tree["root"]).expect("번호 마커가 사라짐")
}

#[test]
fn save_reopen_keeps_rendered_marker_and_body_caret_advance() {
    let doc = numbered_document();
    let original_marker = marker(&doc);
    assert_eq!(original_marker.0, "1.");
    let original_caret: Value =
        serde_json::from_str(&doc.get_cursor_rect(0, 0, 0).unwrap()).unwrap();
    assert!(original_caret["x"].as_f64().unwrap() > original_marker.1["x"].as_f64().unwrap());
    let saved = doc.export_hwpx_native().unwrap();
    let reopened = HwpDocument::from_local_file_bytes_with_font_metrics(
        &saved,
        FontMetricsPolicy::HcrDeclared,
    )
    .unwrap();
    assert_eq!(marker(&reopened), original_marker);
    let reopened_caret: Value =
        serde_json::from_str(&reopened.get_cursor_rect(0, 0, 0).unwrap()).unwrap();
    assert_eq!(reopened_caret["x"], original_caret["x"]);
}
