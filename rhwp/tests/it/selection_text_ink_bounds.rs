use rhwp::wasm_api::HwpDocument;
use serde_json::Value;

fn cursor_x(doc: &HwpDocument, para: u32, offset: u32) -> f64 {
    let json = doc
        .get_cursor_rect(0, para, offset)
        .unwrap_or_else(|error| panic!("cursor rect para={para} offset={offset}: {error:?}"));
    serde_json::from_str::<Value>(&json).expect("cursor rect JSON")["x"]
        .as_f64()
        .expect("cursor x")
}

fn assert_near(actual: f64, expected: f64, label: &str) {
    assert!(
        (actual - expected).abs() <= 0.2,
        "{label}: expected {expected}±0.2, got {actual}"
    );
}

#[test]
fn multiline_body_selection_stops_at_each_paragraphs_text_end() {
    let mut doc = HwpDocument::create_empty();
    doc.create_blank_document_native().expect("blank document");

    let lines = ["abcdefghij", "short", "last line"];
    doc.insert_text_native(0, 0, 0, lines[0])
        .expect("first line");
    doc.split_paragraph_native(0, 0, lines[0].len(), None)
        .expect("second paragraph");
    doc.insert_text_native(0, 1, 0, lines[1])
        .expect("second line");
    doc.split_paragraph_native(0, 1, lines[1].len(), None)
        .expect("third paragraph");
    doc.insert_text_native(0, 2, 0, lines[2])
        .expect("third line");

    let json = doc
        .get_selection_rects(0, 0, 2, 2, 4, None)
        .expect("multiline selection rects");
    let rects = serde_json::from_str::<Vec<Value>>(&json).expect("selection rect JSON");
    assert_eq!(
        rects.len(),
        3,
        "one text-bounded rect per paragraph: {json}"
    );

    let expected = [
        (
            cursor_x(&doc, 0, 2),
            cursor_x(&doc, 0, lines[0].len() as u32),
        ),
        (
            cursor_x(&doc, 1, 0),
            cursor_x(&doc, 1, lines[1].len() as u32),
        ),
        (cursor_x(&doc, 2, 0), cursor_x(&doc, 2, 4)),
    ];

    for (index, (rect, (start_x, end_x))) in rects.iter().zip(expected).enumerate() {
        let x = rect["x"].as_f64().expect("selection x");
        let width = rect["width"].as_f64().expect("selection width");
        assert_near(x, start_x.min(end_x), &format!("rect {index} x"));
        assert_near(
            width,
            (end_x - start_x).abs(),
            &format!("rect {index} width"),
        );
    }
}

fn three_paragraphs_with_spaced_middle() -> HwpDocument {
    let mut doc = HwpDocument::create_empty();
    doc.create_blank_document_native().expect("blank document");
    doc.insert_text_native(0, 0, 0, "body").expect("first");
    doc.split_paragraph_native(0, 0, 4, None).expect("second");
    doc.insert_text_native(0, 1, 0, "heading")
        .expect("second text");
    doc.split_paragraph_native(0, 1, 7, None).expect("third");
    doc.insert_text_native(0, 2, 0, "after")
        .expect("third text");
    doc.apply_para_format_native(0, 1, r#"{"spacingBefore":600,"spacingAfter":600}"#)
        .expect("paragraph spacing");
    doc
}

fn rects(json: &str) -> Vec<(f64, f64)> {
    serde_json::from_str::<Vec<Value>>(json)
        .expect("selection rect JSON")
        .iter()
        .map(|rect| {
            (
                rect["y"].as_f64().unwrap(),
                rect["height"].as_f64().unwrap(),
            )
        })
        .collect()
}

#[test]
fn open_gap_selection_rects_cover_only_each_line_across_paragraph_spacing() {
    let doc = three_paragraphs_with_spaced_middle();
    let open = rects(&doc.get_selection_rects(0, 0, 0, 2, 5, Some(false)).unwrap());
    assert_eq!(open.len(), 3, "one rect per paragraph: {open:?}");
    // 한 문단만 고른 선택은 이어 붙일 다음 줄이 없어 늘어나지 않은 줄 rect 다.
    let lens = [4, 7, 5];
    for (para, (y, height)) in open.iter().enumerate() {
        let p = para as u32;
        let single = rects(
            &doc.get_selection_rects(0, p, 0, p, lens[para], None)
                .unwrap(),
        );
        assert_near(*y, single[0].0, &format!("para {para} y"));
        assert_near(*height, single[0].1, &format!("para {para} height"));
    }
    assert!(
        open[0].0 + open[0].1 < open[1].0 - 1.0,
        "paragraph spacing stays visible: {open:?}"
    );

    // 기본 선택은 여전히 줄 사이를 메워 하나의 띠로 보인다.
    let closed = rects(&doc.get_selection_rects(0, 0, 0, 2, 5, None).unwrap());
    assert_eq!(closed.len(), 3, "{closed:?}");
    for pair in closed.windows(2) {
        assert_near(pair[0].0 + pair[0].1, pair[1].0, "closed gap");
    }
}
