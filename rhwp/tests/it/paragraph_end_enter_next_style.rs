//! 본문 끝 Enter는 다음 문단 스타일의 전체 정의를 새 빈 문단에 적용한다.
use rhwp::model::control::Control;
use rhwp::model::paragraph::{ColumnBreakType, LineSeg, Paragraph};
use rhwp::model::provenance::FontMetricsPolicy;
use rhwp::wasm_api::HwpDocument;
use serde_json::{json, Value};

// Mac Hancom 12.30.0의 원본·다섯 편집 저장본에 공통인 본문 LINE_SEG.
const ENGLISH_LINES: [[i64; 9]; 12] = [
    [0, 36481, 1150, 1150, 978, 344, 1130, 30614, 1441792],
    [60, 37975, 1150, 1150, 978, 344, 1130, 30614, 393216],
    [123, 39469, 1150, 1150, 978, 344, 1130, 30614, 393216],
    [185, 40963, 1150, 1150, 978, 344, 1130, 30614, 393216],
    [246, 42457, 1150, 1150, 978, 344, 1130, 30614, 393216],
    [311, 43951, 1150, 1150, 978, 344, 1130, 30614, 393216],
    [373, 45445, 1150, 1150, 978, 344, 1130, 30614, 393216],
    [427, 46939, 1150, 1150, 978, 344, 1130, 30614, 393216],
    [489, 48433, 1150, 1150, 978, 344, 1130, 30614, 393216],
    [548, 49927, 1150, 1150, 978, 344, 1130, 30614, 393216],
    [607, 51421, 1150, 1150, 978, 344, 1130, 30614, 393216],
    [670, 52915, 1150, 1150, 978, 344, 1130, 30614, 393216],
];
const NATIVE_EMPTY_LINE: [i64; 9] = [0, 54909, 1148, 1148, 976, 576, 0, 31744, 393216];

fn rows(para: &Paragraph) -> Vec<[i64; 9]> {
    para.line_segs
        .iter()
        .map(|line: &LineSeg| {
            [
                line.text_start.into(),
                line.vertical_pos.into(),
                line.line_height.into(),
                line.text_height.into(),
                line.baseline_distance.into(),
                line.line_spacing.into(),
                line.column_start.into(),
                line.segment_width.into(),
                line.tag.into(),
            ]
        })
        .collect()
}

fn runs(para: &Paragraph) -> Vec<(u32, u32)> {
    para.char_shapes
        .iter()
        .map(|shape| (shape.start_pos, shape.char_shape_id))
        .collect()
}

fn snapshot(doc: &HwpDocument, para: usize, caret: usize) -> Value {
    let p = &doc.document().sections[0].paragraphs[para];
    json!({
        "paragraph": {"text":p.text, "style":p.style_id, "paraShape":p.para_shape_id,
            "runs":runs(p), "offsets":p.char_offsets, "charCount":p.char_count,
            "lines":rows(p)},
        "metadata":p.capture_meta(),
        "caret":serde_json::from_str::<Value>(&doc.get_cursor_rect_native(0,para,caret).unwrap()).unwrap(),
        "pageCount":doc.page_count(),
        "profile":format!("{:?}",doc.document().layout_profile()),
        "fontPolicy":format!("{:?}",doc.document().doc_info.font_metrics_policy)
    })
}

fn assert_lifecycle(doc: &HwpDocument, para: usize, caret: usize, step: &str) {
    let immediate = snapshot(doc, para, caret);
    let mut fresh = HwpDocument::create_empty();
    // 독립 core에 같은 모델을 설정한다. 원래 source-format의 cold-reset API는 아니다.
    fresh.set_document(doc.document().clone());
    let reopened = HwpDocument::from_local_file_bytes_with_font_metrics(
        &doc.export_hwpx_native().unwrap(),
        FontMetricsPolicy::HcrDeclared,
    )
    .unwrap();
    for (phase, other) in [("separate-core", fresh), ("saved-reopened", reopened)] {
        let actual = snapshot(&other, para, caret);
        for field in ["paragraph", "caret", "pageCount"] {
            assert_eq!(actual[field], immediate[field], "{step} {phase} {field}");
        }
    }
}

fn english() -> HwpDocument {
    HwpDocument::from_local_file_bytes_with_font_metrics(
        include_bytes!("../../samples/exam_eng.hwp"),
        FontMetricsPolicy::HcrDeclared,
    )
    .unwrap()
}

fn assert_english_body(doc: &HwpDocument, expected: &str) {
    let para = &doc.document().sections[0].paragraphs[112];
    assert_eq!(para.text, expected);
    assert_eq!((para.style_id, para.para_shape_id), (10, 74));
    assert_eq!(rows(para), ENGLISH_LINES);
}

fn english_before_enter() -> (HwpDocument, String, usize) {
    let mut doc = english();
    let original = doc.document().sections[0].paragraphs[112].text.clone();
    let end = doc.get_logical_length(0, 112).unwrap() as usize;
    assert_eq!(end, 698);
    doc.insert_text_native(0, 112, end, " ABC").unwrap();
    assert_english_body(&doc, &format!("{original} ABC"));
    assert_lifecycle(&doc, 112, end + 4, "01-type");
    doc.replace_body_text_local_native(0, 112, end + 1, 3, "XYZ")
        .unwrap();
    assert_english_body(&doc, &format!("{original} XYZ"));
    assert_lifecycle(&doc, 112, end + 4, "02-replace");
    doc.delete_text_native(0, 112, end, 4).unwrap();
    assert_english_body(&doc, &original);
    assert_lifecycle(&doc, 112, end, "03-delete");
    (doc, original, end)
}

#[test]
fn english_end_enter_follows_saved_native_next_style() {
    let (mut doc, original, end) = english_before_enter();
    let style = &doc.document().doc_info.styles[10];
    let next_id = style.next_style_id;
    let target = doc.document().doc_info.styles[next_id as usize].clone();
    assert_eq!(
        (next_id, target.para_shape_id, target.char_shape_id),
        (0, 2, 4)
    );
    let explicit_break = doc.document().sections[0].paragraphs[124].capture_meta();
    assert_eq!(explicit_break.column_type, ColumnBreakType::Page);
    let result: Value =
        serde_json::from_str(&doc.split_paragraph_native(0, 112, end, None).unwrap()).unwrap();
    assert_eq!(result["paraIdx"], 113);
    assert_eq!(result["charOffset"], 0);
    assert_english_body(&doc, &original);
    let empty = &doc.document().sections[0].paragraphs[113];
    assert_eq!(
        (empty.style_id, empty.para_shape_id),
        (next_id, target.para_shape_id)
    );
    assert_eq!(runs(empty), [(0, u32::from(target.char_shape_id))]);
    assert!(empty.text.is_empty() && empty.char_offsets.is_empty());
    assert_eq!(empty.char_count, 1);
    assert!(!empty.has_para_text);
    assert_eq!(empty.column_type, ColumnBreakType::None);
    assert_eq!(empty.raw_break_type, 0);
    assert!(empty.raw_header_extra.is_empty() && empty.numbering_restart.is_none());
    assert_eq!(rows(empty), [NATIVE_EMPTY_LINE]);
    let native_origins = [
        56633, 58127, 59621, 61115, 63067, 65321, 85243, 86737, 88231,
    ];
    for (para, origin) in (114..123).zip(native_origins) {
        assert_eq!(
            doc.document().sections[0].paragraphs[para].line_segs[0].vertical_pos,
            origin
        );
    }
    assert_lifecycle(&doc, 113, 0, "04-enter");
    assert_eq!(
        doc.document().sections[0].paragraphs[125].capture_meta(),
        explicit_break
    );
    let merged: Value = serde_json::from_str(&doc.merge_paragraph_native(0, 113).unwrap()).unwrap();
    assert_eq!(merged["charOffset"], end);
    assert_english_body(&doc, &original);
    assert_lifecycle(&doc, 112, end, "05-merge");
    // 병합 undo는 캡처한 문단 메타로 되돌려 next-style 정책을 다시 실행하지 않는다.
    doc.split_paragraph(
        0,
        112,
        end as u32,
        Some(merged["removedParaMeta"].to_string()),
    )
    .unwrap();
    let restored = &doc.document().sections[0].paragraphs[113];
    assert_eq!(
        (restored.style_id, restored.para_shape_id),
        (next_id, target.para_shape_id)
    );
    assert_eq!(runs(restored), [(0, u32::from(target.char_shape_id))]);
    assert_eq!(rows(restored), [NATIVE_EMPTY_LINE]);
    assert_lifecycle(&doc, 113, 0, "merge-undo");
}

fn styled_text(text: &str) -> HwpDocument {
    let mut doc = HwpDocument::create_empty();
    doc.create_blank_document_native().unwrap();
    let mut model = doc.document().clone();
    model.doc_info.font_metrics_policy = FontMetricsPolicy::HcrDeclared;
    let target = model.doc_info.styles[0].clone();
    let current_id = model.doc_info.styles.len() as u8;
    let mut current = target.clone();
    current.next_style_id = 0;
    model.doc_info.styles.push(current);
    let mut override_para = model.doc_info.para_shapes[target.para_shape_id as usize].clone();
    override_para.spacing_after = 500;
    let override_para_id = model.doc_info.para_shapes.len() as u16;
    model.doc_info.para_shapes.push(override_para);
    let mut override_char = model.doc_info.char_shapes[target.char_shape_id as usize].clone();
    override_char.base_size += 400;
    override_char.raw_data = None;
    let override_char_id = model.doc_info.char_shapes.len() as u32;
    model.doc_info.char_shapes.push(override_char);
    let mut para = Paragraph::new_empty_like(&model.sections[0].paragraphs[0]);
    para.style_id = current_id;
    para.para_shape_id = override_para_id;
    para.set_single_char_shape(override_char_id);
    model.sections[0].paragraphs[0] = para;
    doc.set_document(model);
    if !text.is_empty() {
        doc.insert_text_native(0, 0, 0, text).unwrap();
    }
    doc
}

#[test]
fn next_style_zero_replaces_direct_overrides_and_seeds_the_next_character() {
    for text in ["AB", "A😀", ""] {
        let mut doc = styled_text(text);
        let target = doc.document().doc_info.styles[0].clone();
        let end = doc.get_logical_length(0, 0).unwrap() as usize;
        doc.split_paragraph_native(0, 0, end, None).unwrap();
        let empty = &doc.document().sections[0].paragraphs[1];
        assert_eq!(
            (empty.style_id, empty.para_shape_id),
            (0, target.para_shape_id)
        );
        assert_eq!(runs(empty), [(0, u32::from(target.char_shape_id))]);
        assert_eq!(doc.document().sections[0].paragraphs[0].text, text);
        assert_lifecycle(&doc, 1, 0, "generic-end");
        doc.insert_text_native(0, 1, 0, "Z").unwrap();
        let typed = &doc.document().sections[0].paragraphs[1];
        assert_eq!(typed.text, "Z");
        assert_eq!(typed.char_offsets, [0]);
        assert_eq!(typed.char_count, 2);
        assert_eq!(runs(typed), [(0, u32::from(target.char_shape_id))]);
        assert_lifecycle(&doc, 1, 1, "generic-seed-type");
    }
}

#[test]
fn empty_merge_undo_preserves_direct_override_and_legacy_payload_inheritance() {
    let mut doc = styled_text("A😀");
    let end = doc.get_logical_length(0, 0).unwrap() as usize;
    let inherited_runs = runs(&doc.document().sections[0].paragraphs[0]);
    doc.split_paragraph_native(0, 0, end, None).unwrap();
    let mut model = doc.document().clone();
    let empty = &model.sections[0].paragraphs[1];
    let style_char = model.doc_info.styles[empty.style_id as usize].char_shape_id;
    let mut direct_shape = model.doc_info.char_shapes[style_char as usize].clone();
    direct_shape.base_size += 200;
    direct_shape.raw_data = None;
    let direct_id = model.doc_info.char_shapes.len() as u32;
    model.doc_info.char_shapes.push(direct_shape);
    model.sections[0].paragraphs[1].set_single_char_shape(direct_id);
    doc.set_document(model);
    let expected_runs = runs(&doc.document().sections[0].paragraphs[1]);
    assert_ne!(expected_runs, [(0, u32::from(style_char))]);
    assert_ne!(expected_runs, inherited_runs);
    // 일반 문단 메타 조회에는 병합 전용 복원 payload를 노출하지 않는다.
    let general_meta =
        serde_json::to_value(doc.document().sections[0].paragraphs[1].capture_meta()).unwrap();
    assert!(general_meta.get("empty_char_shapes").is_none());
    let merged: Value = serde_json::from_str(&doc.merge_paragraph_native(0, 1).unwrap()).unwrap();
    assert_eq!(
        merged["removedParaMeta"]["empty_char_shapes"],
        json!(expected_runs)
    );
    assert_eq!(
        runs(&doc.document().sections[0].paragraphs[0]),
        inherited_runs
    );

    // 이전 버전의 메타에는 선택 필드가 없다. 기존 분할 지점의 글자 모양을 잇는다.
    let mut legacy_meta = merged["removedParaMeta"].clone();
    legacy_meta
        .as_object_mut()
        .unwrap()
        .remove("empty_char_shapes");
    let mut legacy = HwpDocument::create_empty();
    legacy.set_document(doc.document().clone());
    legacy
        .split_paragraph(0, 0, end as u32, Some(legacy_meta.to_string()))
        .unwrap();
    assert_eq!(
        runs(&legacy.document().sections[0].paragraphs[1]),
        inherited_runs
    );

    doc.split_paragraph(
        0,
        0,
        end as u32,
        Some(merged["removedParaMeta"].to_string()),
    )
    .unwrap();
    assert_eq!(
        runs(&doc.document().sections[0].paragraphs[1]),
        expected_runs
    );
    assert_lifecycle(&doc, 1, 0, "direct-override-undo");
    doc.insert_text_native(0, 1, 0, "Z").unwrap();
    let typed = &doc.document().sections[0].paragraphs[1];
    assert_eq!(typed.text, "Z");
    assert_eq!(typed.char_offsets, [0]);
    assert_eq!(typed.char_count, 2);
    assert_eq!(runs(typed), expected_runs);

    // 본문이 있는 뒷 문단은 기존 merge/split의 구간 복원을 그대로 따른다.
    let merged: Value = serde_json::from_str(&doc.merge_paragraph_native(0, 1).unwrap()).unwrap();
    assert!(merged["removedParaMeta"].get("empty_char_shapes").is_none());
    let mut meta = merged["removedParaMeta"].clone();
    meta["empty_char_shapes"] = json!(inherited_runs);
    doc.split_paragraph(0, 0, end as u32, Some(meta.to_string()))
        .unwrap();
    let restored = &doc.document().sections[0].paragraphs[1];
    assert_eq!(restored.text, "Z");
    assert_eq!(runs(restored), expected_runs);
}

fn inherited_format(doc: &HwpDocument, para: usize) -> (u8, u16, u32) {
    let p = &doc.document().sections[0].paragraphs[para];
    (p.style_id, p.para_shape_id, p.char_shapes[0].char_shape_id)
}

#[test]
fn middle_out_of_range_and_invalid_catalog_enter_keep_inheritance() {
    for case in [
        "begin",
        "middle",
        "past-end",
        "missing-current",
        "missing-next",
        "self-next",
        "current-character-style",
        "next-character-style",
        "missing-para",
        "missing-char",
        "count-mismatch",
        "encoded-gap",
    ] {
        let mut doc = styled_text("AB");
        let mut model = doc.document().clone();
        let current = model.sections[0].paragraphs[0].style_id as usize;
        let offset = match case {
            "begin" => 0,
            "middle" => 1,
            "past-end" => 3,
            _ => 2,
        };
        match case {
            "missing-current" => model.sections[0].paragraphs[0].style_id = u8::MAX,
            "missing-next" => model.doc_info.styles[current].next_style_id = u8::MAX,
            "self-next" => model.doc_info.styles[current].next_style_id = current as u8,
            "current-character-style" => model.doc_info.styles[current].style_type = 1,
            "next-character-style" => model.doc_info.styles[0].style_type = 1,
            "missing-para" => model.doc_info.styles[0].para_shape_id = u16::MAX,
            "missing-char" => model.doc_info.styles[0].char_shape_id = u16::MAX,
            "count-mismatch" => model.sections[0].paragraphs[0].char_count += 1,
            "encoded-gap" => {
                model.sections[0].paragraphs[0].char_offsets[1] = 2;
                model.sections[0].paragraphs[0].char_count = 4;
            }
            _ => {}
        }
        doc.set_document(model);
        let before = inherited_format(&doc, 0);
        doc.split_paragraph_native(0, 0, offset, None).unwrap();
        assert_eq!(inherited_format(&doc, 1), before, "{case}");
        let joined = format!(
            "{}{}",
            doc.document().sections[0].paragraphs[0].text,
            doc.document().sections[0].paragraphs[1].text
        );
        assert_eq!(joined, "AB", "{case}");
    }
}

#[test]
fn control_text_and_inline_objects_keep_inherited_end_enter_format() {
    for text in ["A\tB", "A\nB", "A\u{fffc}B"] {
        let mut doc = styled_text(text);
        let before = inherited_format(&doc, 0);
        let end = doc.get_logical_length(0, 0).unwrap() as usize;
        doc.split_paragraph_native(0, 0, end, None).unwrap();
        assert_eq!(inherited_format(&doc, 1), before);
        assert_eq!(doc.document().sections[0].paragraphs[0].text, text);
    }
    let mut doc = styled_text("AB");
    doc.insert_equation_native(0, 0, 1, "i", 1000, 0).unwrap();
    let before = inherited_format(&doc, 0);
    let end = doc.get_logical_length(0, 0).unwrap() as usize;
    doc.split_paragraph_native(0, 0, end, None).unwrap();
    assert_eq!(inherited_format(&doc, 1), before);
    assert_eq!(doc.document().sections[0].paragraphs[0].text, "AB");
    assert!(doc.document().sections[0].paragraphs[0]
        .controls
        .iter()
        .any(|c| matches!(c, Control::Equation(_))));
}

#[test]
fn logical_continuation_and_metadata_restore_do_not_follow_next_style() {
    let mut logical = styled_text("AB");
    let before = inherited_format(&logical, 0);
    logical.split_paragraph_logical_native(0, 0, 2).unwrap();
    assert_eq!(inherited_format(&logical, 1), before);

    let mut restore = styled_text("AB");
    let before = inherited_format(&restore, 0);
    let mut meta = restore.document().sections[0].paragraphs[0].capture_meta();
    meta.column_type = ColumnBreakType::Page;
    meta.raw_break_type = 0x04;
    meta.raw_header_extra = vec![1, 2, 3, 4];
    restore
        .split_paragraph_native(0, 0, 2, Some(meta.clone()))
        .unwrap();
    assert_eq!(inherited_format(&restore, 1), before);
    assert_eq!(
        restore.document().sections[0].paragraphs[1].capture_meta(),
        meta
    );
}

#[test]
fn cell_end_enter_keeps_its_existing_style_inheritance() {
    let mut doc = styled_text("AB");
    let inherited = inherited_format(&doc, 0);
    let table: Value =
        serde_json::from_str(&doc.create_table_native(0, 0, 0, 1, 1).unwrap()).unwrap();
    let parent = table["paraIdx"].as_u64().unwrap() as usize;
    let control = table["controlIdx"].as_u64().unwrap() as usize;
    let mut model = doc.document().clone();
    let Control::Table(table) = &mut model.sections[0].paragraphs[parent].controls[control] else {
        panic!("table")
    };
    let cell = &mut table.cells[0].paragraphs[0];
    cell.style_id = inherited.0;
    cell.para_shape_id = inherited.1;
    cell.set_single_char_shape(inherited.2);
    doc.set_document(model);
    doc.insert_text_in_cell_native(0, parent, control, 0, 0, 0, "AB")
        .unwrap();
    doc.split_paragraph_in_cell_native(0, parent, control, 0, 0, 2, None)
        .unwrap();
    let Control::Table(table) = &doc.document().sections[0].paragraphs[parent].controls[control]
    else {
        panic!("table")
    };
    let new = &table.cells[0].paragraphs[1];
    assert_eq!(
        (
            new.style_id,
            new.para_shape_id,
            new.char_shapes[0].char_shape_id
        ),
        inherited
    );
    assert!(new.text.is_empty());
}
