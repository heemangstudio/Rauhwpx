//! 문서 글자 수가 한컴 한글(Mac 12.30) 상태 표시줄의 "N글자"와 같은지 검사한다.
//!
//! 기댓값은 각 샘플을 한컴에서 열어 읽은 값이다. 공백·탭·묶음 빈칸·고정폭 빈칸은 세고,
//! 줄 바꿈·자동 번호·수식·바탕쪽은 세지 않으며, 필드마다 끝 표시 한 글자를 더한다.

use std::fs;
use std::path::Path;

use rhwp::document_core::DocumentCore;

fn count(sample: &str) -> usize {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("samples")
        .join(sample);
    let bytes = fs::read(&path).unwrap_or_else(|error| panic!("read {}: {error}", path.display()));
    DocumentCore::from_bytes(&bytes)
        .unwrap_or_else(|error| panic!("parse {sample}: {error}"))
        .get_document_character_count()
}

#[test]
fn footnote_and_endnote_numbers_are_not_counted() {
    assert_eq!(count("footnote-01.hwp"), 1854);
    assert_eq!(count("endnote-01.hwp"), 1831);
    assert_eq!(count("footnote-tbox-01.hwp"), 57);
}

#[test]
fn fields_tables_and_line_breaks_match_hancom() {
    assert_eq!(count("KTX.hwp"), 15894);
    assert_eq!(count("biz_plan.hwp"), 2878);
}

#[test]
fn master_pages_are_not_counted() {
    assert_eq!(count("exam_kor.hwp"), 42032);
}

#[test]
fn large_hwpx_matches_hancom() {
    assert_eq!(count("2025 행정업무운영 편람(최종).hwpx"), 242062);
}
