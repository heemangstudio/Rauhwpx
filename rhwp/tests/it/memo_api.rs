//! 메모 편집 API 계약: 삽입·목록·고치기·지우기 후 HWP/HWPX 로 저장하고 다시 열어도
//! 사용자가 본 메모 목록이 그대로여야 한다.

use rhwp::document_core::queries::memo_query::{MemoCellPathEntry, MemoNoteInfo, MemoNotePath};
use rhwp::model::control::Control;
use rhwp::wasm_api::HwpDocument;

use super::common::load_doc;

fn reload_both(doc: &HwpDocument) -> [HwpDocument; 2] {
    let hwp = doc.export_hwp_with_adapter().expect("export hwp");
    let hwpx = doc.export_hwpx_native().expect("export hwpx");
    [
        HwpDocument::from_bytes(&hwp).expect("reload hwp"),
        HwpDocument::from_bytes(&hwpx).expect("reload hwpx"),
    ]
}

/// 저장본에서 비교할 사용자 관점 값: (작성자, 본문, 앵커 글자).
fn visible(list: &[MemoNoteInfo]) -> Vec<(String, String, String)> {
    let mut out: Vec<_> = list
        .iter()
        .map(|m| (m.author.clone(), m.text.clone(), m.anchor_text.clone()))
        .collect();
    out.sort();
    out
}

fn assert_saved_list(doc: &HwpDocument, label: &str) {
    let expected = visible(&doc.memo_note_list());
    for (format, reloaded) in ["hwp", "hwpx"].iter().zip(reload_both(doc)) {
        assert_eq!(
            visible(&reloaded.memo_note_list()),
            expected,
            "{label}: {format} reload"
        );
    }
}

/// 개체 없는 본문 문단 중 글자가 `min_len` 이상인 첫 문단.
fn plain_body_paragraph(doc: &HwpDocument, min_len: usize) -> (usize, usize) {
    for (s, section) in doc.document().sections.iter().enumerate() {
        for (p, para) in section.paragraphs.iter().enumerate() {
            if para.text.chars().count() >= min_len
                && para.controls.is_empty()
                && para.field_ranges.is_empty()
            {
                return (s, p);
            }
        }
    }
    panic!("no plain body paragraph");
}

#[test]
fn insert_edit_delete_memo_survives_hwp_and_hwpx_saves() {
    // english.hwp 는 문단마다 "우리말 번역" 에 메모가 있다 — 같은 문단의 다른 범위에 단다.
    let mut doc = load_doc("samples/basic/english.hwp");
    let existing = doc.memo_note_list().len();
    let (s, p) = (0, 3);
    let path = MemoNotePath {
        section_idx: s,
        para_idx: p,
        cell_path: None,
    };
    let anchor: String = doc.document().sections[s].paragraphs[p]
        .text
        .chars()
        .skip(10)
        .take(4)
        .collect();

    // 삽입
    let id = doc
        .insert_memo_note(&path, 10, 14, "첫 줄\n둘째 줄", Some("검토자"))
        .unwrap();
    let list = doc.memo_note_list();
    assert_eq!(list.len(), existing + 1);
    let memo = list.iter().find(|m| m.field_id == id).unwrap();
    assert_eq!(memo.text, "첫 줄\n둘째 줄");
    assert_eq!(memo.para_count, 2);
    assert_eq!(memo.author, "검토자");
    assert_eq!(memo.anchor_text, anchor);
    assert!(memo.created_at.is_some());
    assert_eq!(
        doc.memo_note_at(&path, 12),
        Some(id),
        "hit-test inside the anchor"
    );
    assert_eq!(
        doc.memo_note_at(&path, 8),
        None,
        "hit-test between the two memos"
    );
    assert!(!doc.memo_note_anchor_rects(id).unwrap().is_empty());
    assert_saved_list(&doc, "after insert");

    // 고치기
    assert!(doc.set_memo_note_text(id, "고친 메모").unwrap());
    assert_eq!(
        doc.memo_note_list()
            .iter()
            .find(|m| m.field_id == id)
            .unwrap()
            .text,
        "고친 메모"
    );
    assert_saved_list(&doc, "after edit");

    // 지우기: 메모만 사라지고 앵커 글자는 남는다.
    let text_before = doc.document().sections[s].paragraphs[p].text.clone();
    doc.delete_memo_note(id).unwrap();
    assert_eq!(doc.memo_note_list().len(), existing);
    assert_eq!(doc.document().sections[s].paragraphs[p].text, text_before);
    assert_saved_list(&doc, "after delete");

    // 모두 지우기
    assert_eq!(doc.delete_all_memo_notes().unwrap(), existing);
    assert!(doc.memo_note_list().is_empty());
    assert_saved_list(&doc, "after delete all");
}

#[test]
fn insert_into_document_without_memo_shapes_adds_the_default_shape() {
    let mut doc = load_doc("samples/basic/request.hwp");
    assert!(doc.document().memo_shapes().is_empty());
    assert!(doc.memo_note_list().is_empty());
    let (s, p) = plain_body_paragraph(&doc, 3);
    let path = MemoNotePath {
        section_idx: s,
        para_idx: p,
        cell_path: None,
    };
    doc.insert_memo_note(&path, 0, 2, "새 메모", None).unwrap();
    assert_eq!(doc.document().memo_shapes().len(), 1);
    for (format, reloaded) in ["hwp", "hwpx"].iter().zip(reload_both(&doc)) {
        let list = reloaded.memo_note_list();
        assert_eq!(list.len(), 1, "{format}");
        assert_eq!(list[0].text, "새 메모", "{format}");
        assert_eq!(reloaded.document().memo_shapes().len(), 1, "{format}");
        assert_eq!(list[0].shape.fill_color, "#CBFF99", "{format}");
    }
}

#[test]
fn insert_into_table_cell() {
    let mut doc = load_doc("samples/basic/request.hwp");
    // 글자가 있는 첫 표 셀 문단
    let mut found = None;
    'outer: for (s, section) in doc.document().sections.iter().enumerate() {
        for (p, para) in section.paragraphs.iter().enumerate() {
            for (c, control) in para.controls.iter().enumerate() {
                let Control::Table(table) = control else {
                    continue;
                };
                for (ci, cell) in table.cells.iter().enumerate() {
                    for (cp, cell_para) in cell.paragraphs.iter().enumerate() {
                        if cell_para.text.chars().count() >= 2
                            && cell_para.controls.is_empty()
                            && cell_para.field_ranges.is_empty()
                        {
                            found = Some((s, p, c, ci, cp));
                            break 'outer;
                        }
                    }
                }
            }
        }
    }
    let (s, p, c, ci, cp) = found.expect("table cell with text");
    let path = MemoNotePath {
        section_idx: s,
        para_idx: p,
        cell_path: Some(vec![MemoCellPathEntry {
            control_index: c,
            cell_index: ci,
            cell_para_index: cp,
        }]),
    };
    let id = doc
        .insert_memo_note(&path, 0, 2, "셀 메모", Some("a"))
        .unwrap();
    let memo = doc
        .memo_note_list()
        .into_iter()
        .find(|m| m.field_id == id)
        .unwrap();
    let anchor = memo.anchor.expect("cell anchor");
    assert_eq!(anchor.cell_path, path.cell_path);
    assert_eq!(doc.memo_note_at(&path, 1), Some(id));
    assert!(!doc.memo_note_anchor_rects(id).unwrap().is_empty());
    for (format, reloaded) in ["hwp", "hwpx"].iter().zip(reload_both(&doc)) {
        let list = reloaded.memo_note_list();
        assert_eq!(list.len(), 1, "{format}");
        assert_eq!(list[0].text, "셀 메모", "{format}");
        assert_eq!(
            list[0].anchor.as_ref().unwrap().cell_path,
            path.cell_path,
            "{format}"
        );
    }
}

#[test]
fn unchanged_memo_text_keeps_body_formatting() {
    let mut doc = load_doc("samples/basic/english.hwp");
    let memo = doc.memo_note_list()[0].clone();
    let before = format!("{:?}", body_of(&doc, memo.field_id));
    assert!(!doc.set_memo_note_text(memo.field_id, &memo.text).unwrap());
    assert_eq!(format!("{:?}", body_of(&doc, memo.field_id)), before);
    assert!(
        doc.document().sections[0].raw_stream.is_some(),
        "no-op keeps the stored stream"
    );
}

fn body_of(doc: &HwpDocument, field_id: u32) -> Vec<rhwp::model::paragraph::Paragraph> {
    let mut out = Vec::new();
    for section in &doc.document().sections {
        rhwp::model::memo::for_each_section_field(section, &mut |f| {
            if f.field_id == field_id {
                out = f.memo_paragraphs.clone();
            }
        });
    }
    out
}

/// 메모 앵커 글자를 모두 지운 뒤 같은 자리에 새 글자를 치면, 저장본에서도 메모가 새 글자에
/// 달려 있어야 한다 (앵커가 뒤로 밀린 빈 범위가 되거나, HWPX 에서 fieldEnd 가 fieldBegin
/// 보다 먼저 쓰이면 안 된다).
fn assert_retyped_anchor_survives(label: &str, mut doc: HwpDocument, memo: MemoNoteInfo) {
    let a = memo.anchor.clone().unwrap();
    doc.delete_text_native(
        a.section_idx,
        a.para_idx,
        a.start_char_idx,
        a.end_char_idx - a.start_char_idx,
    )
    .unwrap();
    doc.insert_text_native(a.section_idx, a.para_idx, a.start_char_idx, "NEW")
        .unwrap();
    let anchor_of = |list: Vec<MemoNoteInfo>| {
        let m = list
            .into_iter()
            .find(|m| m.text == memo.text)
            .expect("retyped memo");
        let anchor = m.anchor.expect("anchor");
        (
            m.anchor_text,
            anchor.section_idx,
            anchor.para_idx,
            anchor.start_char_idx,
            anchor.end_char_idx,
        )
    };
    let want = (
        "NEW".to_string(),
        a.section_idx,
        a.para_idx,
        a.start_char_idx,
        a.start_char_idx + 3,
    );
    assert_eq!(anchor_of(doc.memo_note_list()), want, "{label}: in memory");
    for (format, reloaded) in ["hwp", "hwpx"].iter().zip(reload_both(&doc)) {
        assert_eq!(
            anchor_of(reloaded.memo_note_list()),
            want,
            "{label}: {format} reload"
        );
    }
}

#[test]
fn retyping_deleted_anchor_text_keeps_the_memo_on_the_new_text() {
    // 문단 끝 앵커 (한컴 저장본 메모)
    let doc = load_doc("samples/basic/NewYear_s_Day.hwp");
    let memo = doc.memo_note_list().remove(0);
    let a = memo.anchor.as_ref().unwrap();
    assert_eq!(
        a.end_char_idx,
        doc.document().sections[a.section_idx].paragraphs[a.para_idx]
            .text
            .chars()
            .count(),
        "fixture: anchor ends the paragraph"
    );
    assert_retyped_anchor_survives("paragraph end", doc, memo);

    // 문단 중간 앵커 (새로 단 메모)
    let mut doc = load_doc("samples/basic/request.hwp");
    let (s, p) = plain_body_paragraph(&doc, 8);
    let path = MemoNotePath {
        section_idx: s,
        para_idx: p,
        cell_path: None,
    };
    let id = doc
        .insert_memo_note(&path, 2, 5, "MID", Some("me"))
        .unwrap();
    let memo = doc
        .memo_note_list()
        .into_iter()
        .find(|m| m.field_id == id)
        .unwrap();
    assert_retyped_anchor_survives("mid paragraph", doc, memo);
}
