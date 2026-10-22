//! HWP 메모 저장 계약: 편집 후 HWP 로 저장해도 메모 본문이 모두 남고, 한컴처럼
//! 마지막 구역 끝에만 메모 꼬리를 쓰며, 메모 번호는 문서 안에서 유일해야 한다.

use rhwp::model::document::Document;
use rhwp::parser::record::Record;
use rhwp::parser::tags;
use rhwp::wasm_api::HwpDocument;

use super::common::load_doc;
use super::memo_hwp_parse::memo_fields;

const SAMPLES: [&str; 4] = [
    "samples/basic/NewYear_s_Day.hwp",
    "samples/basic/english.hwp",
    "samples/aift.hwp",
    "samples/task2287/1342000_edu_curriculum_map.hwp",
];

pub(crate) fn memo_set(doc: &Document) -> Vec<(u32, String)> {
    let mut set: Vec<(u32, String)> = memo_fields(doc)
        .iter()
        .map(|f| (f.memo_index, f.memo_body_text()))
        .collect();
    set.sort();
    set
}

/// 구역별 MEMO_LIST 레코드 수 (저장본을 다시 읽은 원본 스트림 기준).
fn memo_list_records_per_section(doc: &Document) -> Vec<usize> {
    doc.sections
        .iter()
        .map(|section| {
            let raw = section
                .raw_stream
                .as_ref()
                .expect("reloaded HWP keeps raw stream");
            Record::read_all(raw)
                .unwrap()
                .iter()
                .filter(|r| r.tag_id == tags::HWPTAG_MEMO_LIST)
                .count()
        })
        .collect()
}

fn paragraph_counts(doc: &Document) -> Vec<usize> {
    doc.sections.iter().map(|s| s.paragraphs.len()).collect()
}

fn memo_section(doc: &Document) -> usize {
    doc.sections
        .iter()
        .position(|s| {
            let mut found = false;
            rhwp::model::memo::for_each_section_field(s, &mut |f| {
                found |= f.field_type == rhwp::model::control::FieldType::Memo;
            });
            found
        })
        .expect("sample has a memo")
}

fn save_and_reload_hwp(doc: &HwpDocument) -> HwpDocument {
    let bytes = doc.export_hwp_with_adapter().expect("export hwp");
    HwpDocument::from_bytes(&bytes).expect("reload hwp")
}

fn assert_memos_survive(sample: &str, case: &str, edit: impl Fn(&mut HwpDocument)) {
    let mut doc = load_doc(sample);
    let before = memo_set(doc.document());
    let counts = paragraph_counts(doc.document());
    edit(&mut doc);
    let reloaded = save_and_reload_hwp(&doc);
    let after = reloaded.document();
    assert_eq!(
        memo_set(after),
        before,
        "{sample} ({case}): memo (index, text)"
    );
    let per_section = memo_list_records_per_section(after);
    let last = per_section.len() - 1;
    assert_eq!(
        per_section[last],
        before.len(),
        "{sample} ({case}): MEMO_LIST in last section"
    );
    assert!(
        per_section[..last].iter().all(|&n| n == 0),
        "{sample} ({case}): MEMO_LIST outside the last section: {per_section:?}"
    );
    assert_eq!(
        paragraph_counts(after),
        counts,
        "{sample} ({case}): level-0 paragraphs"
    );
    assert!(after.orphan_memo_lists.is_empty(), "{sample} ({case})");
}

#[test]
fn editing_the_memo_section_keeps_every_memo() {
    for sample in SAMPLES {
        assert_memos_survive(sample, "memo section", |doc| {
            let s = memo_section(doc.document());
            doc.insert_text_native(s, 0, 0, "X").unwrap();
        });
    }
}

#[test]
fn editing_only_the_last_section_keeps_every_memo() {
    for sample in SAMPLES {
        assert_memos_survive(sample, "last section", |doc| {
            let s = doc.document().sections.len() - 1;
            doc.insert_text_native(s, 0, 0, "X").unwrap();
        });
    }
}

#[test]
fn editing_every_section_keeps_every_memo() {
    for sample in SAMPLES {
        assert_memos_survive(sample, "every section", |doc| {
            for s in 0..doc.document().sections.len() {
                doc.insert_text_native(s, 0, 0, "X").unwrap();
            }
        });
    }
}

#[test]
fn unedited_hwp_keeps_section_streams_byte_for_byte() {
    for sample in SAMPLES {
        let doc = load_doc(sample);
        let reloaded = save_and_reload_hwp(&doc);
        for (i, (a, b)) in doc
            .document()
            .sections
            .iter()
            .zip(&reloaded.document().sections)
            .enumerate()
        {
            assert!(
                a.raw_stream == b.raw_stream,
                "{sample}: section {i} stream changed"
            );
        }
    }
}

#[test]
fn pasted_copy_of_a_memo_gets_its_own_index() {
    let mut doc = load_doc("samples/basic/english.hwp");
    let before = memo_fields(doc.document()).len();
    // 메모가 달린 첫 문단을 통째로 복사해 문서 끝에 붙인다 (같은 memo_index 를 가진 복제).
    let s = 0usize;
    let p = doc.document().sections[s]
        .paragraphs
        .iter()
        .position(|para| {
            para.controls.iter().any(|c| {
                matches!(c, rhwp::model::control::Control::Field(f)
                    if f.field_type == rhwp::model::control::FieldType::Memo)
            })
        })
        .expect("memo-anchored paragraph");
    let para = &doc.document().sections[s].paragraphs[p];
    let len = para.text.chars().count();
    doc.copy_selection_native(s, p, 0, p, len).unwrap();
    let last = doc.document().sections[s].paragraphs.len() - 1;
    let end = doc.document().sections[s].paragraphs[last]
        .text
        .chars()
        .count();
    doc.paste_internal_native(s, last, end).unwrap();
    let pasted = memo_fields(doc.document());
    assert_eq!(pasted.len(), before + 1, "paste copies the memo field");

    let reloaded = save_and_reload_hwp(&doc);
    let memos = memo_fields(reloaded.document());
    assert_eq!(memos.len(), before + 1);
    let mut indexes: Vec<u32> = memos.iter().map(|f| f.memo_index).collect();
    indexes.sort();
    indexes.dedup();
    assert_eq!(indexes.len(), memos.len(), "memo indexes are unique");
    assert!(
        memos.iter().all(|f| !f.memo_paragraphs.is_empty()),
        "every copy keeps a body"
    );
    let first_text = memos[0].memo_body_text();
    assert_eq!(
        memos
            .iter()
            .filter(|f| f.memo_body_text() == first_text)
            .count(),
        2,
        "the copy carries the same body"
    );
}

#[test]
fn removing_the_last_memo_by_a_plain_edit_drops_its_body_from_the_hwp() {
    // 메모 1개가 마지막이 아닌 구역(표 안)에 있는 문서. 메모 API 를 거치지 않고 앵커가 든
    // 문단을 지우면 메모가 0개가 되는데, 마지막 구역 원본 꼬리를 그대로 쓰면 지운 메모
    // 본문이 파일에 남는다.
    let mut doc = load_doc("samples/task2287/1342000_edu_curriculum_map.hwp");
    let memos = doc.memo_note_list();
    assert_eq!(memos.len(), 1);
    let anchor = memos[0].anchor.clone().expect("anchor");
    assert!(anchor.section_idx + 1 < doc.document().sections.len());
    doc.delete_paragraph_native(anchor.section_idx, anchor.para_idx)
        .unwrap();
    assert!(doc.memo_note_list().is_empty());

    let reloaded = save_and_reload_hwp(&doc);
    let after = reloaded.document();
    assert_eq!(
        memo_list_records_per_section(after).iter().sum::<usize>(),
        0,
        "deleted memo body left in the saved file"
    );
    assert!(after.orphan_memo_lists.is_empty());
    assert!(reloaded.memo_note_list().is_empty());
}
