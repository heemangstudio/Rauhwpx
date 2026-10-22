//! HWP 메모 꼬리 파싱 계약.
//!
//! 한컴은 메모 본문을 마지막 구역 끝, 마지막 level-0 문단의 level-1 자식(MEMO_LIST +
//! LIST_HEADER + 문단)으로 저장한다. 파서는 본문을 메모 필드에 붙이고, 어떤 본문
//! 문단도 빼거나 바꾸지 않아야 한다.

use rhwp::model::control::{Field, FieldType};
use rhwp::model::document::Document;
use rhwp::model::memo::for_each_section_field;

use super::common::load_doc;

pub(crate) fn memo_fields(doc: &Document) -> Vec<Field> {
    let mut out = Vec::new();
    for section in &doc.sections {
        for_each_section_field(section, &mut |field| {
            if field.field_type == FieldType::Memo {
                out.push(field.clone());
            }
        });
    }
    out
}

fn memos_with_body(doc: &Document) -> usize {
    memo_fields(doc)
        .iter()
        .filter(|f| f.memo_paragraphs.iter().any(|p| !p.text.is_empty()))
        .count()
}

#[test]
fn hancom_memo_bodies_attach_to_their_fields() {
    for (sample, expected) in [
        ("samples/basic/NewYear_s_Day.hwp", 9),
        ("samples/basic/english.hwp", 15),
        ("samples/aift.hwp", 2),
        ("samples/task2287/1342000_edu_curriculum_map.hwp", 1),
    ] {
        let doc = load_doc(sample);
        assert_eq!(memos_with_body(doc.document()), expected, "{sample}");
        assert!(doc.document().orphan_memo_lists.is_empty(), "{sample}");
    }
}

#[test]
fn memo_body_text_and_author_come_from_the_file() {
    let doc = load_doc("samples/basic/english.hwp");
    let memos = memo_fields(doc.document());
    let first = &memos[0];
    assert_eq!(first.memo_index, 1);
    assert_eq!(
        first.memo_body_text(),
        "그들은 결혼한 지 50년이 되었습니다. 존의 할아버지는 변호사였는데 지난해에 은퇴하셨죠."
    );
    let meta = first.memo_meta().expect("memo command");
    assert_eq!(meta.author, "한글과컴퓨터");
    assert_eq!(meta.number, 1);
    assert!(meta.created_at.is_some());
}

#[test]
fn revision_delete_fields_are_not_memos() {
    let doc = load_doc("samples/task2287/1342000_edu_curriculum_map.hwp");
    let mut revision_fields = 0;
    for section in &doc.document().sections {
        for_each_section_field(section, &mut |field| {
            if field.command.starts_with("$RevisionDelete") {
                revision_fields += 1;
                assert_ne!(field.field_type, FieldType::Memo);
                assert!(field.memo_paragraphs.is_empty());
            }
        });
    }
    assert_eq!(revision_fields, 3);
}

#[test]
fn memo_tail_keeps_paragraph_counts_equal_to_hwpx() {
    let hwp = load_doc("samples/aift.hwp");
    let hwpx = load_doc("samples/hwpx/aift.hwpx");
    let counts = |doc: &Document| -> Vec<usize> {
        doc.sections.iter().map(|s| s.paragraphs.len()).collect()
    };
    assert_eq!(counts(hwp.document()), counts(hwpx.document()));
}

#[test]
fn last_paragraph_with_memo_tail_parses_as_body_text() {
    // english.hwp 의 마지막 본문 문단 아래에 메모 15개가 매달려 있다.
    let doc = load_doc("samples/basic/english.hwp");
    let last = doc.document().sections[0].paragraphs.last().unwrap();
    assert_eq!(
        last.text,
        "우리말 번역 Do you know the reson why he did that? You wouldn't believe this but he said, \"There was nothing to do.\""
    );
    assert_eq!(last.controls.len(), 1, "마지막 문단의 메모 필드");
    assert!(doc.document().sections[0]
        .section_def
        .master_pages
        .iter()
        .all(|mp| !mp.is_extension));
}
